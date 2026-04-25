/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent tool \u2014 Power Mode implementation of the CC CLI `Agent` tool.
 *
 * Matches the CC batch.ts skill's expected interface exactly:
 *   Agent({ prompt, subagent_type, isolation: "worktree", run_in_background: true })
 *
 * When isolation === "worktree":
 *   - Creates a git worktree under <workingDirectory>/.worktrees/batch-<id>
 *   - Prepends the worktree path + branch name into the agent's prompt
 *   - Cleans up the worktree on completion (if agent requests removal)
 *
 * When run_in_background === true:
 *   - Returns immediately with { agentId, worktree: { branch, path } }
 *   - Progress tracked via get_agent_status / wait_for_agent
 */

import { IPowerTool, IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { INeuralInverseSubAgentService } from '../../../void/browser/neuralInverseSubAgentService.js';
import { SubAgentRole } from '../../../void/common/subAgentTypes.js';
import { IExternalCommandExecutor } from '../../../neuralInverseChecks/browser/engine/services/externalCommandExecutor.js';
import { definePowerTool } from './powerToolRegistry.js';

// \u2500\u2500\u2500 subagent_type \u2192 SubAgentRole map (CC CLI names \u2192 Power Mode roles) \u2500\u2500\u2500\u2500\u2500\u2500\u2500

const SUBAGENT_TYPE_MAP: Record<string, SubAgentRole> = {
	'general-purpose': 'cc:general',
	'general':          'cc:general',
	'Explore':          'cc:explore',
	'explore':          'cc:explore',
	'Plan':             'cc:plan',
	'plan':             'cc:plan',
	'verify':           'cc:verify',
	'Verify':           'cc:verify',
};

function _shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

// \u2500\u2500\u2500 createAgentTool \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Creates the `Agent` tool for Power Mode.
 *
 * This is the bridge that makes CC's `/batch` skill work inside the IDE:
 * batch.ts instructs the AI to call Agent({ isolation: "worktree", run_in_background: true })
 * for each parallel worker \u2014 this tool fulfills that contract.
 */
export function createAgentTool(
	subAgentService: INeuralInverseSubAgentService,
	workingDirectory: string,
	commandExecutor: IExternalCommandExecutor,
): IPowerTool {
	return definePowerTool(
		'Agent',
		`Spawn a sub-agent to handle a complex task autonomously.

**Isolation modes:**
- \`isolation: "worktree"\` \u2014 creates a fresh git worktree (isolated branch) for the agent. Use this for all /batch workers so they can commit and open PRs without conflicting.

**Background mode:**
- \`run_in_background: true\` \u2014 returns immediately with an agentId. The agent runs concurrently. Track with get_agent_status / wait_for_agent.
- \`run_in_background: false\` (default) \u2014 blocks until the agent completes.

**Agent types:**
- \`general-purpose\` \u2014 full write+bash access (default)
- \`Explore\`         \u2014 read-only fast search (haiku model)
- \`Plan\`            \u2014 read-only architecture planning

**Used by /batch for parallel orchestration.** Each batch worker runs in its own isolated worktree, commits changes, and opens a PR.`,
		[
			{
				name: 'prompt',
				type: 'string',
				description: 'Complete, self-contained task description. Include all context the agent needs \u2014 it cannot ask follow-up questions.',
				required: true,
			},
			{
				name: 'subagent_type',
				type: 'string',
				description: 'Agent type: "general-purpose" (default, write+bash), "Explore" (read-only fast), "Plan" (read-only planning)',
				required: false,
			},
			{
				name: 'isolation',
				type: 'string',
				description: 'Set to "worktree" to run the agent in an isolated git branch. Required for /batch workers.',
				required: false,
			},
			{
				name: 'run_in_background',
				type: 'string',
				description: 'Set to "true" to return immediately without waiting. Agent runs concurrently.',
				required: false,
			},
			{
				name: 'description',
				type: 'string',
				description: 'Short (3-5 word) summary of what this agent does. Shown in status displays.',
				required: false,
			},
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const prompt         = (args.prompt as string) ?? '';
			const subagentType   = (args.subagent_type as string) ?? 'general-purpose';
			const isolation      = (args.isolation as string | undefined);
			const runInBg        = String(args.run_in_background).toLowerCase() === 'true';
			const description    = (args.description as string | undefined);

			if (!prompt.trim()) {
				return {
					title: 'Agent: missing prompt',
					output: 'Required argument "prompt" was not provided.',
					metadata: { error: true },
				};
			}

			// \u2500\u2500 gh availability check \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			// batch.ts workers run `gh pr create`; warn once if gh is absent so
			// the AI can note it in results rather than silently failing.
			let ghAvailable = true;
			try {
				const ghCheck = await commandExecutor.execute(
					`agent_gh_check_${Date.now()}`,
					`command -v gh 2>/dev/null && gh auth status 2>/dev/null; echo "gh_exit:$?"`,
					5_000,
					512,
				);
				if (!ghCheck.includes('gh.io') && !ghCheck.includes('Logged in') && !ghCheck.includes('/gh')) {
					ghAvailable = false;
				}
			} catch {
				ghAvailable = false;
			}

			// \u2500\u2500 Create git worktree if isolation requested \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			let agentPrompt  = prompt;
			let worktreePath: string | undefined;
			let worktreeBranch: string | undefined;

			if (isolation === 'worktree') {
				const branchSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
				const branchName   = `batch-worker-${branchSuffix}`;
				const wtPath       = `${workingDirectory}/.worktrees/${branchName}`;

				ctx.metadata({ title: `Creating worktree: ${branchName}` });

				const cmd = [
					`cd ${_shellQuote(workingDirectory)}`,
					`mkdir -p .worktrees`,
					`git worktree add ${_shellQuote(wtPath)} -b ${_shellQuote(branchName)} 2>&1`,
				].join(' && ');

				try {
					const output = await commandExecutor.execute(`wt_create_${branchSuffix}`, cmd, 30_000, 4 * 1024);
					if (output.toLowerCase().includes('fatal:') || output.toLowerCase().includes('error:')) {
						return {
							title: 'Agent: worktree creation failed',
							output: `Failed to create git worktree:\n${output.trim()}`,
							metadata: { error: true },
						};
					}
					worktreePath   = wtPath;
					worktreeBranch = branchName;
				} catch (err: any) {
					return {
						title: 'Agent: worktree error',
						output: `git worktree add failed: ${err.message ?? String(err)}`,
						metadata: { error: true },
					};
				}

				// Inject working-directory context into the prompt so the agent
				// knows where to operate and which branch to commit/push from.
				const ghNote = ghAvailable
					? `gh is available. After committing, run: gh pr create --title "<title>" --base main --head ${branchName}`
					: `NOTE: gh CLI not authenticated. After committing and pushing, create the PR manually. End your report with: PR: none \u2014 gh not available`;

				agentPrompt = [
					`WORKING DIRECTORY: ${wtPath}`,
					`GIT BRANCH: ${branchName}`,
					``,
					`You are running in an isolated git worktree. All file reads/writes/edits`,
					`must target files under ${wtPath}. When you commit, use branch "${branchName}".`,
					``,
					ghNote,
					``,
					`---`,
					``,
					prompt,
				].join('\n');
			} else if (!ghAvailable) {
				// Even without worktree isolation, note gh status for batch workers
				agentPrompt = prompt + `\n\nNOTE: gh CLI not authenticated \u2014 if you need to create a PR, note it in your final message as: PR: none \u2014 gh not available`;
			}

			// \u2500\u2500 Map subagent_type \u2192 SubAgentRole \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			const role: SubAgentRole = SUBAGENT_TYPE_MAP[subagentType] ?? 'cc:general';

			ctx.metadata({ title: `Spawning ${description ?? role} agent\u2026` });

			// \u2500\u2500 Spawn the sub-agent \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			const parentContext = subAgentService.getParentContext();
			const task = subAgentService.spawn({
				role,
				goal: agentPrompt,
				parentContext: parentContext || undefined,
				...(worktreePath ? { scopedFiles: [worktreePath] } : {}),
			});

			if (!task) {
				// Clean up orphaned worktree on spawn failure
				if (worktreePath && worktreeBranch) {
					const cleanCmd = [
						`cd ${_shellQuote(workingDirectory)}`,
						`git worktree remove --force ${_shellQuote(worktreePath)} 2>/dev/null`,
						`git branch -D ${_shellQuote(worktreeBranch)} 2>/dev/null`,
					].join(' && ');
					commandExecutor.execute(`wt_cleanup_${Date.now()}`, cleanCmd, 10_000, 512).catch(() => { /* best-effort */ });
				}
				return {
					title: 'Agent: spawn failed',
					output: 'Could not spawn agent \u2014 maximum concurrent agents reached or no active parent context.',
					metadata: { error: true },
				};
			}

			const shortId = task.id.substring(0, 8);

			// \u2500\u2500 Background mode: return immediately \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			if (runInBg) {
				return {
					title: `\u25CF Agent ${shortId} started`,
					output: [
						`Agent \x1b[1m${shortId}\x1b[0m running in background  \x1b[90m[${role}]\x1b[0m`,
						...(worktreeBranch ? [
							`  \x1b[36m\u251C\u2500 Worktree:\x1b[0m ${worktreePath}`,
							`  \x1b[36m\u2514\u2500 Branch:  \x1b[0m ${worktreeBranch}`,
						] : []),
						``,
						`\x1b[90mTrack with \x1b[36mget_agent_status("${task.id}")\x1b[90m or \x1b[36mwait_for_agent("${task.id}")\x1b[0m`,
					].join('\n'),
					metadata: {
						agentId: task.id,
						role,
						status: 'started',
						...(worktreeBranch ? { worktree: { branch: worktreeBranch, path: worktreePath } } : {}),
					},
				};
			}

			// \u2500\u2500 Foreground mode: poll until done (max 30 min) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			const MAX_WAIT_MS    = 30 * 60 * 1000;
			const POLL_MS        = 3_000;
			const startTime      = Date.now();

			ctx.metadata({ title: `Waiting for agent ${shortId}\u2026` });

			while (Date.now() - startTime < MAX_WAIT_MS) {
				await new Promise<void>(r => setTimeout(r, POLL_MS));
				const current = subAgentService.subAgents.get(task.id);
				if (!current) { break; }

				if (current.status === 'completed') {
					return {
						title: `\u2713 Agent ${shortId} completed`,
						output: current.result ?? `Agent ${shortId} completed (no result text).`,
						metadata: {
							agentId: task.id,
							role,
							status: 'completed',
							...(worktreeBranch ? { worktree: { branch: worktreeBranch, path: worktreePath } } : {}),
						},
					};
				}

				if (current.status === 'failed' || current.status === 'cancelled') {
					return {
						title: `\u2717 Agent ${shortId} ${current.status}`,
						output: current.error ?? `Agent ${shortId} ${current.status}.`,
						metadata: {
							agentId: task.id,
							role,
							status: current.status,
							...(worktreeBranch ? { worktree: { branch: worktreeBranch, path: worktreePath } } : {}),
						},
					};
				}
			}

			return {
				title: `\u23F1 Agent ${shortId} timed out`,
				output: `Agent ${shortId} did not complete within 30 minutes. Check get_agent_status("${task.id}") to monitor.`,
				metadata: {
					agentId: task.id,
					role,
					status: 'timeout',
					...(worktreeBranch ? { worktree: { branch: worktreeBranch, path: worktreePath } } : {}),
				},
			};
		},
	);
}
