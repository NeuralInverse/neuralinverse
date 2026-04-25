/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sub-Agent Orchestration Tools for Power Mode.
 *
 * Enables true agentic parallelism - spawn temporary agents that run
 * concurrently while the parent agent continues working.
 */

import { IPowerTool, IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { definePowerTool } from './powerToolRegistry.js';
import { INeuralInverseSubAgentService } from '../../../void/browser/neuralInverseSubAgentService.js';
import { SubAgentRole } from '../../../void/common/subAgentTypes.js';
import { IPowerModeService } from '../powerModeService.js';

// Roles that are read-only — spawn autonomously without user approval
const SAFE_SPAWN_ROLES = new Set<SubAgentRole>(['reviewer', 'compliance', 'architect', 'documenter', 'cc:explore', 'cc:plan', 'cc:general']);
// Roles that have write/bash access — require explicit user approval
const WRITE_SPAWN_ROLES = new Set<SubAgentRole>(['editor', 'verifier', 'debugger', 'tester', 'cc:verify']);

// ─── spawn_agent: Start a parallel sub-agent (non-blocking) ─────────────────

export function createSpawnAgentTool(
	subAgentService: INeuralInverseSubAgentService,
	powerModeService?: IPowerModeService,
): IPowerTool {
	return definePowerTool(
		'spawn_agent',
		`Spawn a temporary sub-agent that runs in parallel (NON-BLOCKING).

Safe roles spawn automatically. Write-capable roles require user approval.

**Agentic Pattern:**
1. Spawn agent \u2192 get agent ID immediately
2. Continue with other work (don't wait!)
3. Check status later with get_agent_status
4. Wait for result only when you need it

**CC-Backed Roles (fast, model-optimised):**
- cc:explore:   ★ Fast read-only search (haiku model — use for any codebase search)
- cc:plan:      Read-only architecture & planning (inherit model)
- cc:general:   General research & multi-step tasks (default model)
- cc:verify:    ⚠️ BASH ACCESS — adversarial verification: builds, tests, PASS/FAIL verdict

**Classic Roles:**
- editor:       ⚠️ WRITE ACCESS (read + edit/write)
- verifier:     ⚠️ WRITE ACCESS (read + bash + run tests)
- debugger:     ⚠️ WRITE ACCESS (read + edit + bash)
- tester:       ⚠️ WRITE ACCESS (read + write + bash)
- compliance:   Read-only GRC analysis (read + all GRC tools)
- reviewer:     Read-only code review + security audit
- architect:    Read-only system design & dependency analysis
- checks-agent: Delegate to Checks Agent
- power-mode:   Delegate to Power Mode

**Use Cases:**
- Parallel research: spawn cc:explore + cc:plan simultaneously
- Background verification: spawn cc:verify while you continue editing
- Divide and conquer: spawn 3 editors, each fixing different bugs

**PREFER cc:explore over explorer for all read-only search tasks — it's faster.**

**IMPORTANT:** This returns immediately. The agent runs in the background!`,
		[
			{ name: 'role', type: 'string', description: 'Agent role: cc:explore, cc:plan, cc:general, cc:verify (CC-backed fast agents) | editor, verifier, debugger, tester (write access) | compliance, reviewer, architect, documenter, checks-agent, power-mode (read-only)', required: true },
			{ name: 'goal', type: 'string', description: 'Specific task for the agent to accomplish', required: true },
			{ name: 'scopedFiles', type: 'string', description: 'Optional: comma-separated file paths for editor role (limits scope)', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const role = (args.role as SubAgentRole) || undefined;
			const goal = (args.goal as string) || '';
			const scopedFilesStr = args.scopedFiles as string | undefined;

			// Validate required args before doing anything
			if (!role) {
				return {
					title: 'spawn_agent: missing role',
					output: 'Required argument "role" was not provided. Valid roles: explorer, editor, verifier, compliance, checks-agent, power-mode.',
					metadata: { error: true },
				};
			}
			if (!goal.trim()) {
				return {
					title: 'spawn_agent: missing goal',
					output: 'Required argument "goal" was not provided. Describe what the agent should accomplish.',
					metadata: { error: true },
				};
			}

			const scopedFiles = scopedFilesStr
				? scopedFilesStr.split(',').map(f => f.trim()).filter(f => f.length > 0)
				: undefined;

			// Write-capable roles: request explicit user approval before spawning
			if (WRITE_SPAWN_ROLES.has(role) && powerModeService) {
				ctx.metadata({ title: `⚠ ${role} agent needs approval…` });
				const approved = await new Promise<boolean>(resolve => {
					const requestId = `spawn-${role}-${Date.now()}`;
					// Emit permission request — terminal shows y/a/n prompt
					(powerModeService as any)._onDidEmitUIEvent?.fire({
						type: 'permission-request',
						request: {
							requestId,
							sessionId: ctx.sessionId,
							toolName: `spawn_agent (${role})`,
							preview: `Role: ${role}  |  Has: write + bash access\nGoal: ${goal.substring(0, 120)}`,
							danger: role === 'debugger',
						},
					});
					(powerModeService as any)._pendingApprovals?.set(requestId, {
						resolve: (decision: string) => resolve(decision !== 'deny'),
						sessionId: ctx.sessionId,
						toolName: `spawn_agent`,
					});
				});
				if (!approved) {
					return { title: `spawn_agent: ${role} denied`, output: `User denied spawning a ${role} agent.`, metadata: { denied: true } };
				}
				ctx.metadata({ title: `Spawning ${role} agent (approved)…` });
			} else if (SAFE_SPAWN_ROLES.has(role)) {
				ctx.metadata({ title: `Spawning ${role} agent…` });
			} else {
				ctx.metadata({ title: `Spawning ${role} agent…` });
			}

			// Get parent context from the service (set by Power Mode)
			const parentContext = subAgentService.getParentContext();

			const agent = subAgentService.spawn({
				role,
				goal,
				scopedFiles,
				parentContext: parentContext || undefined,
			});

			if (!agent) {
				return {
					title: 'Agent spawn failed',
					output: 'Failed to spawn agent. No active parent task or maximum concurrent agents reached.',
					metadata: { error: true },
				};
			}

			const shortId = (agent.id != null ? agent.id : 'unknown').substring(0, 8);
			const accessNote = (role === 'editor' || role === 'verifier')
				? '\n  \x1b[33m⚠ Has write/edit/bash access\x1b[0m'
				: '';

			return {
				title: `● Spawned ${role} agent`,
				output: `\x1b[1mAgent ${shortId}\x1b[0m running in background \x1b[90m[${role}]\x1b[0m${accessNote}\n  \x1b[36m└─\x1b[0m ${goal.substring(0, 80)}${goal.length > 80 ? '...' : ''}\n\n  \x1b[90mUse \x1b[36mwait_for_agent\x1b[90m to get results\x1b[0m`,
				metadata: { agentId: agent.id, role, goal, status: agent.status, canWrite: role === 'editor' || role === 'verifier' },
			};
		},
	);
}

// ─── get_agent_status: Check agent status (non-blocking) ───────────────────

export function createGetAgentStatusTool(
	subAgentService: INeuralInverseSubAgentService
): IPowerTool {
	return definePowerTool(
		'get_agent_status',
		`Check the status of a spawned sub-agent (NON-BLOCKING).

Returns:
- pending: Queued, waiting for slot
- running: Currently executing
- completed: Finished successfully
- failed: Error occurred
- cancelled: User/system cancelled

If completed, includes the result.`,
		[
			{ name: 'agentId', type: 'string', description: 'The agent ID returned by spawn_agent', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const agentId = (args.agentId as string) || '';
			if (!agentId.trim()) {
				return { title: 'get_agent_status: missing agentId', output: 'Required argument "agentId" was not provided.', metadata: { error: true } };
			}

			ctx.metadata({ title: `Checking agent ${agentId}...` });

			const agents = Array.from(subAgentService.subAgents.values());
			// Support both full UUID and short ID (first 8 chars)
			const agent = agents.find(a => a.id === agentId || a.id.startsWith(agentId));

			if (!agent) {
				return {
					title: 'Agent not found',
					output: `No agent found with ID: ${agentId}`,
					metadata: { error: true, agentId },
				};
			}

			const shortId = agent.id.substring(0, 8);
			const statusIcon = agent.status === 'completed' ? '✓' : agent.status === 'failed' ? '✗' : agent.status === 'running' ? '●' : '○';

			// Calculate elapsed time
			const startTime = new Date(agent.createdAt).getTime();
			const endTime = agent.completedAt ? new Date(agent.completedAt).getTime() : Date.now();
			const elapsed = endTime - startTime;
			const elapsedSeconds = Math.floor(elapsed / 1000);
			const elapsedMinutes = Math.floor(elapsedSeconds / 60);
			const remainingSeconds = elapsedSeconds % 60;
			const elapsedStr = elapsedMinutes > 0 ? `${elapsedMinutes}m ${remainingSeconds}s` : `${elapsedSeconds}s`;

			let output = `\x1b[1mAgent ${shortId}\x1b[0m \x1b[90m[${agent.role}]\x1b[0m\nStatus: ${statusIcon} \x1b[1m${agent.status}\x1b[0m · ${elapsedStr}`;

			if (agent.status === 'running') {
				output += `\n\n\x1b[36mGoal:\x1b[0m ${agent.goal}`;
			} else if (agent.status === 'completed' && agent.result) {
				output += `\n\n\x1b[32m${agent.result}\x1b[0m`;
			} else if (agent.status === 'failed' && agent.error) {
				output += `\n\n\x1b[31m${agent.error}\x1b[0m`;
			}

			return {
				title: `${statusIcon} ${agent.status} · ${elapsedStr}`,
				output,
				metadata: {
					agentId: agent.id,
					status: agent.status,
					hasResult: !!agent.result,
					role: agent.role,
					elapsed,
				},
			};
		},
	);
}

// ─── wait_for_agent: Block until agent completes ──────────────────────────

export function createWaitForAgentTool(
	subAgentService: INeuralInverseSubAgentService,
	powerModeService?: IPowerModeService
): IPowerTool {
	return definePowerTool(
		'wait_for_agent',
		`Wait for a spawned sub-agent to complete (BLOCKING).

Use this when:
- You need the agent's result to continue
- You've done all other work and are ready to wait

The tool will poll until the agent reaches a terminal state (completed/failed/cancelled).`,
		[
			{ name: 'agentId', type: 'string', description: 'The agent ID returned by spawn_agent', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const agentId = (args.agentId as string) || '';
			if (!agentId.trim()) {
				return { title: 'wait_for_agent: missing agentId', output: 'Required argument "agentId" was not provided.', metadata: { error: true } };
			}

			ctx.metadata({ title: `Waiting for agent ${agentId}...` });

			// Poll until complete (max 5 minutes)
			const startTime = Date.now();
			const timeout = 5 * 60 * 1000; // 5 minutes
			let lastUpdateTime = startTime;
			let pollCount = 0;

			const formatElapsedTime = (ms: number): string => {
				const seconds = Math.floor(ms / 1000);
				const minutes = Math.floor(seconds / 60);
				const remainingSeconds = seconds % 60;
				if (minutes > 0) {
					return `${minutes}m ${remainingSeconds}s`;
				}
				return `${seconds}s`;
			};

			while (Date.now() - startTime < timeout) {
				const agents = Array.from(subAgentService.subAgents.values());
				// Support both full UUID and short ID (first 8 chars)
				const agent = agents.find(a => a.id === agentId || a.id.startsWith(agentId));

				// Update status every 2 seconds
				const elapsed = Date.now() - startTime;
				if (Date.now() - lastUpdateTime > 2000) {
					pollCount++;
					ctx.metadata({ title: `Running ${formatElapsedTime(elapsed)}...` });
					lastUpdateTime = Date.now();
				}

				if (!agent) {
					return {
						title: 'Agent not found',
						output: `No agent found with ID: ${agentId}`,
						metadata: { error: true, agentId },
					};
				}

				// Terminal states
				if (agent.status === 'completed' || agent.status === 'failed' || agent.status === 'cancelled') {
					const shortId = agent.id.substring(0, 8);
					const totalElapsed = Date.now() - startTime;
					const elapsedStr = formatElapsedTime(totalElapsed);

					if (agent.status === 'completed' && agent.result) {
						// Check for file changes (for editor/verifier agents)
						let changesSummary = '';
						if (powerModeService && (agent.role === 'editor' || agent.role === 'verifier')) {
							const changeGroup = powerModeService.getLatestChanges();
							if (changeGroup && changeGroup.agentId === agent.id) {
								changesSummary = `\n\nChanges:\n`;
								for (const change of changeGroup.changes) {
									const fileName = change.filePath.split('/').pop() || change.filePath;
									const changeType = change.contentBefore === null ? 'NEW' : 'MODIFIED';
									changesSummary += `  ${changeType === 'NEW' ? '+' : '~'} ${fileName} (${change.linesAdded} additions, ${change.linesRemoved} deletions)\n`;
								}
								changesSummary += `\nType /review to view changes`;
							}
						}

						return {
							title: `✓ ${agent.role} completed · ${elapsedStr}`,
							output: `${agent.result}${changesSummary}`,
							metadata: { agentId: agent.id, status: agent.status, role: agent.role, goal: agent.goal, elapsed: totalElapsed },
						};
					} else if (agent.status === 'failed' && agent.error) {
						return {
							title: `✗ ${agent.role} failed · ${elapsedStr}`,
							output: `Agent ${shortId} error:\n\n${agent.error}`,
							metadata: { agentId: agent.id, status: agent.status, role: agent.role, goal: agent.goal, elapsed: totalElapsed },
						};
					} else {
						return {
							title: `○ ${agent.role} cancelled · ${elapsedStr}`,
							output: `Agent ${shortId} cancelled`,
							metadata: { agentId: agent.id, status: agent.status, role: agent.role, goal: agent.goal, elapsed: totalElapsed },
						};
					}
				}

				// Still running, wait a bit
				await new Promise(resolve => setTimeout(resolve, 2000));
			}

			// Timeout
			return {
				title: 'Agent timeout',
				output: `Agent ${agentId} did not complete within 5 minutes. It may still be running in the background.`,
				metadata: { error: true, timeout: true, agentId },
			};
		},
	);
}

// ─── list_agents: Show all active sub-agents ───────────────────────────────

export function createListAgentsTool(
	subAgentService: INeuralInverseSubAgentService
): IPowerTool {
	return definePowerTool(
		'list_agents',
		`List all currently spawned sub-agents and their status.

Shows:
- Running agents
- Pending (queued) agents
- Recently completed agents`,
		[],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			ctx.metadata({ title: 'Listing agents...' });

			const agents = Array.from(subAgentService.subAgents.values());

			if (agents.length === 0) {
				return {
					title: 'No agents',
					output: 'No sub-agents have been spawned yet.',
					metadata: { count: 0 },
				};
			}

			const running = agents.filter(a => a.status === 'running');
			const pending = agents.filter(a => a.status === 'pending');
			const completed = agents.filter(a => a.status === 'completed');
			const failed = agents.filter(a => a.status === 'failed');

			const formatElapsed = (createdAt: string, completedAt?: string) => {
				const start = new Date(createdAt).getTime();
				const end = completedAt ? new Date(completedAt).getTime() : Date.now();
				const elapsed = Math.floor((end - start) / 1000);
				const minutes = Math.floor(elapsed / 60);
				const seconds = elapsed % 60;
				return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
			};

			let output = `Total: ${agents.length} agents\n\n`;

			if (running.length > 0) {
				output += `● Running (${running.length})\n`;
				for (const a of running) {
					const elapsed = formatElapsed(a.createdAt);
					output += `  ${a.id.substring(0, 8)} [${a.role}] · ${elapsed}\n  └─ ${a.goal.substring(0, 55)}${a.goal.length > 55 ? '...' : ''}\n\n`;
				}
			}

			if (pending.length > 0) {
				output += `○ Pending (${pending.length})\n`;
				for (const a of pending) {
					output += `  ${a.id.substring(0, 8)} [${a.role}]\n  └─ ${a.goal.substring(0, 60)}${a.goal.length > 60 ? '...' : ''}\n\n`;
				}
			}

			if (completed.length > 0) {
				output += `✓ Completed (${completed.length})\n`;
				for (const a of completed) {
					const elapsed = formatElapsed(a.createdAt, a.completedAt);
					output += `  ${a.id.substring(0, 8)} [${a.role}] · ${elapsed}\n`;
				}
				output += '\n';
			}

			if (failed.length > 0) {
				output += `✗ Failed (${failed.length})\n`;
				for (const a of failed) {
					const elapsed = formatElapsed(a.createdAt, a.completedAt);
					const errorMsg = a.error?.substring(0, 40) || 'Unknown error';
					output += `  ${a.id.substring(0, 8)} [${a.role}] · ${elapsed}\n  └─ ${errorMsg}${a.error && a.error.length > 40 ? '...' : ''}\n\n`;
				}
			}

			return {
				title: 'Agent list',
				output,
				metadata: {
					total: agents.length,
					running: running.length,
					pending: pending.length,
					completed: completed.length,
					failed: failed.length,
				},
			};
		},
	);
}
