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

// ─── spawn_agent: Start a parallel sub-agent (non-blocking) ─────────────────

export function createSpawnAgentTool(
	subAgentService: INeuralInverseSubAgentService
): IPowerTool {
	return definePowerTool(
		'spawn_agent',
		`Spawn a temporary sub-agent that runs in parallel (NON-BLOCKING).

**Agentic Pattern:**
1. Spawn agent → get agent ID immediately
2. Continue with other work (don't wait!)
3. Check status later with get_agent_status
4. Wait for result only when you need it

**Available Roles:**
- explorer:     Read-only research (read, search, list)
- editor:       Code editing (read + edit/write)
- verifier:     Testing (read + run tests/commands)
- compliance:   GRC analysis (read + all GRC tools)
- checks-agent: Delegate to Checks Agent
- power-mode:   Delegate to Power Mode

**Use Cases:**
- Parallel research: "explore authentication flow" + "explore database layer" simultaneously
- Background work: spawn verifier to run tests while you continue editing
- Divide and conquer: spawn 3 editors, each fixing different bugs

**IMPORTANT:** This returns immediately. The agent runs in the background!`,
		[
			{ name: 'role', type: 'string', description: 'Agent role: explorer, editor, verifier, compliance, checks-agent, power-mode', required: true },
			{ name: 'goal', type: 'string', description: 'Specific task for the agent to accomplish', required: true },
			{ name: 'scopedFiles', type: 'string', description: 'Optional: comma-separated file paths for editor role (limits scope)', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const role = args.role as SubAgentRole;
			const goal = args.goal as string;
			const scopedFilesStr = args.scopedFiles as string | undefined;

			const scopedFiles = scopedFilesStr
				? scopedFilesStr.split(',').map(f => f.trim()).filter(f => f.length > 0)
				: undefined;

			ctx.metadata({ title: `Spawning ${role} agent...` });

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

			const shortId = agent.id.substring(0, 8);

			return {
				title: `● Spawned ${role} agent`,
				output: `Agent ${shortId} running in background\n  └─ ${goal.substring(0, 80)}${goal.length > 80 ? '...' : ''}\n\n  Use wait_for_agent to get results`,
				metadata: { agentId: agent.id, role, goal, status: agent.status },
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
			const agentId = args.agentId as string;

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

			let output = `Agent ${shortId} [${agent.role}]\nStatus: ${statusIcon} ${agent.status} · ${elapsedStr}`;

			if (agent.status === 'running') {
				output += `\n\n${agent.goal}`;
			} else if (agent.status === 'completed' && agent.result) {
				output += `\n\n${agent.result}`;
			} else if (agent.status === 'failed' && agent.error) {
				output += `\n\n${agent.error}`;
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
	subAgentService: INeuralInverseSubAgentService
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
			const agentId = args.agentId as string;

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
						return {
							title: `✓ ${agent.role} completed · ${elapsedStr}`,
							output: `${agent.result}`,
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
