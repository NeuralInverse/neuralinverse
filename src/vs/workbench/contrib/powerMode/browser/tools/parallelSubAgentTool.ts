/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *
 *  Parallel Sub-Agent Orchestration Tool — Spawn multiple specialized agents in parallel,
 *  wait for all to complete, then synthesize their results into a single coherent answer.
 *
 *  This is the "agent swarm" capability that goes beyond Cursor and Antigravity:
 *    • Spawn 3-5 agents simultaneously, each with a different role
 *    • Each agent works independently on its scoped task
 *    • Results are aggregated and cross-referenced
 *    • Conflicts between agent findings are surfaced for resolution
 *
 *  Example usage:
 *    "Architect the system, review security, write tests, and document the API — all in parallel"
 *
 *  Spawns: architect (design) + reviewer (security) + tester (tests) + documenter (docs)
 *  Then synthesizes: "Here's the architecture, here are the security concerns, here are the tests, here's the docs"
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult, IPowerTool } from '../../common/powerModeTypes.js';
import { INeuralInverseSubAgentService } from '../../../void/browser/neuralInverseSubAgentService.js';
import { SubAgentRole, SubAgentSpawnRequest } from '../../../void/common/subAgentTypes.js';

const MAX_PARALLEL_AGENTS = 6;

// Valid sub-agent roles for orchestration
const VALID_ROLES: SubAgentRole[] = [
	'explorer', 'editor', 'verifier', 'debugger', 'reviewer', 'tester', 'documenter', 'architect',
];

export function createParallelSubAgentTool(
	subAgentService: INeuralInverseSubAgentService,
): IPowerTool {
	return definePowerTool(
		'parallel_sub_agent',
		`Spawn multiple specialized sub-agents in parallel, wait for all to complete,
then synthesize their results into a single coherent answer.

This is the "agent swarm" capability. Instead of one agent doing everything,
you dispatch a team of specialists simultaneously:

• architect  — system design and planning
• reviewer   — security audit and code quality review
• tester     — test writing and coverage
• debugger   — bug hunting and fixing
• documenter — documentation creation
• explorer   — codebase research and discovery
• editor     — targeted code modifications
• verifier   — test execution and validation

Parameters:
- tasks: Array of { role, goal, name?, scopedFiles? }
  - role: One of architect, reviewer, tester, debugger, documenter, explorer, editor, verifier
  - goal: Specific task for this agent
  - name: Optional friendly name for routing (e.g. "security-reviewer")
  - scopedFiles: Optional file paths to scope editor agents
- maxConcurrent: Maximum agents running at once (default: 4, max: 6)
- synthesizeResults: If true, cross-reference results and surface conflicts (default: true)

Returns:
- agentResults: Array of { role, name, status, result, error }
- synthesis: Combined analysis of all agent results
- conflicts: Any conflicting findings between agents
- summary: Human-readable summary of the entire swarm operation

Example:
  parallel_sub_agent({
    tasks: [
      { role: 'architect', goal: 'Design the database schema for the school management system', name: 'db-architect' },
      { role: 'reviewer', goal: 'Review the auth code for security vulnerabilities', name: 'security-reviewer' },
      { role: 'tester', goal: 'Write tests for the login flow', name: 'test-writer' },
    ],
    maxConcurrent: 3,
    synthesizeResults: true
  })`,
		[
			{
				name: 'tasks',
				type: 'array',
				description: 'Array of sub-agent tasks to run in parallel',
				required: true,
			},
			{
				name: 'maxConcurrent',
				type: 'number',
				description: 'Maximum agents running at once (default: 4, max: 6)',
				required: false,
			},
			{
				name: 'synthesizeResults',
				type: 'boolean',
				description: 'Cross-reference results and surface conflicts (default: true)',
				required: false,
			},
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const tasksParam = args.tasks;
			const maxConcurrent = Math.min(Math.max((args.maxConcurrent as number) ?? 4, 1), MAX_PARALLEL_AGENTS);
			const synthesizeResults = args.synthesizeResults !== false;

			if (!Array.isArray(tasksParam)) {
				return {
					title: 'Invalid tasks parameter',
					output: 'Error: tasks must be an array of { role, goal, ... } objects.',
					metadata: { error: true },
				};
			}
			if (tasksParam.length === 0) {
				return {
					title: 'No tasks provided',
					output: 'Error: tasks array must contain at least one task.',
					metadata: { error: true },
				};
			}
			if (tasksParam.length > MAX_PARALLEL_AGENTS) {
				return {
					title: 'Too many tasks',
					output: `Error: Maximum ${MAX_PARALLEL_AGENTS} parallel tasks. Split into multiple calls.`,
					metadata: { error: true },
				};
			}

			// Validate each task
			const validatedTasks: Array<{
				role: SubAgentRole;
				goal: string;
				name?: string;
				scopedFiles?: string[];
			}> = [];

			for (const task of tasksParam) {
				if (typeof task.role !== 'string' || !VALID_ROLES.includes(task.role as SubAgentRole)) {
					return {
						title: 'Invalid role',
						output: `Error: Invalid role '${task.role}'. Must be one of: ${VALID_ROLES.join(', ')}.`,
						metadata: { error: true },
					};
				}
				if (typeof task.goal !== 'string' || task.goal.trim().length === 0) {
					return {
						title: 'Invalid goal',
						output: `Error: Task with role '${task.role}' has an empty goal.`,
						metadata: { error: true },
					};
				}
				validatedTasks.push({
					role: task.role as SubAgentRole,
					goal: task.goal.trim(),
					name: task.name,
					scopedFiles: Array.isArray(task.scopedFiles) ? task.scopedFiles : undefined,
				});
			}

			ctx.metadata({ title: `Parallel sub-agent swarm: ${validatedTasks.length} agents` });

			const agentResults: Array<{
				role: string;
				name?: string;
				id: string;
				status: 'completed' | 'failed' | 'cancelled' | 'running' | 'pending';
				result?: string;
				error?: string;
			}> = [];

			let completedCount = 0;
			let failedCount = 0;

			// Spawn all agents (respecting maxConcurrent via the service's internal queue)
			for (const task of validatedTasks) {
				const spawnRequest: SubAgentSpawnRequest = {
					role: task.role,
					goal: task.goal,
					name: task.name,
					scopedFiles: task.scopedFiles,
				};

				ctx.metadata({ title: `Spawning ${task.role} agent: ${task.name ?? task.goal.substring(0, 30)}` });

				const agent = subAgentService.spawn(spawnRequest);

				if (!agent) {
					agentResults.push({
						role: task.role,
						name: task.name,
						id: 'spawn-failed',
						status: 'failed',
						error: 'Failed to spawn agent — maximum concurrent agents reached or no parent context.',
					});
					failedCount++;
					continue;
				}

				agentResults.push({
					role: task.role,
					name: task.name,
					id: agent.id,
					status: agent.status,
					result: agent.result,
					error: agent.error,
				});

				if (agent.status === 'completed') {
					completedCount++;
				} else if (agent.status === 'failed') {
					failedCount++;
				}
			}

			// Wait for all running agents to complete (poll with timeout)
			const maxWaitMs = 300000; // 5 minutes
			const pollIntervalMs = 2000;
			const startTime = Date.now();

			while (Date.now() - startTime < maxWaitMs) {
				const allDone = agentResults.every(r => r.status !== 'running');
				if (allDone) break;

				// Refresh statuses
				for (const result of agentResults) {
					if (result.status === 'running' || result.status === 'pending') {
						const agent = Array.from(subAgentService.subAgents.values()).find(a => a.id === result.id);
						if (agent) {
							result.status = agent.status as 'completed' | 'failed' | 'cancelled';
							result.result = agent.result;
							result.error = agent.error;
							if (agent.status === 'completed') completedCount++;
							if (agent.status === 'failed') failedCount++;
						}
					}
				}

				await new Promise(r => setTimeout(r, pollIntervalMs));
			}

			// Mark any still-running as timed out
			for (const result of agentResults) {
				if (result.status === 'running' || result.status === 'pending') {
					result.status = 'failed';
					result.error = 'Timed out waiting for agent completion';
					failedCount++;
				}
			}

			// Synthesize results
			let synthesis = '';
			let conflicts: string[] = [];

			if (synthesizeResults && agentResults.length > 0) {
				const successfulResults = agentResults.filter(r => r.status === 'completed' && r.result);
				const failedResults = agentResults.filter(r => r.status !== 'completed');

				synthesis = _synthesizeResults(validatedTasks, successfulResults, failedResults);
				conflicts = _detectConflicts(successfulResults);
			}

			// Build output
			const lines: string[] = [];
			lines.push(`Parallel Sub-Agent Swarm Complete`);
			lines.push(`==================================`);
			lines.push(`Total agents: ${validatedTasks.length}`);
			lines.push(`Completed: ${completedCount}`);
			lines.push(`Failed: ${failedCount}`);
			lines.push('');

			for (const r of agentResults) {
				const icon = r.status === 'completed' ? '✓' : '✗';
				lines.push(`${icon} ${r.role}${(r.name ? ` (${r.name})` : '')}`);
				if (r.status === 'completed' && r.result) {
					lines.push(`   Result: ${r.result.substring(0, 200)}${r.result.length > 200 ? '...' : ''}`);
				}
				if (r.error) {
					lines.push(`   Error: ${r.error}`);
				}
			}

			if (synthesis) {
				lines.push('');
				lines.push('Synthesis:');
				lines.push('==========');
				lines.push(synthesis);
			}

			if (conflicts.length > 0) {
				lines.push('');
				lines.push('Conflicts Detected:');
				lines.push('==================');
				for (const c of conflicts) {
					lines.push(`  ⚠ ${c}`);
				}
			}

			return {
				title: `Parallel Sub-Agent Swarm: ${completedCount}/${validatedTasks.length} completed`,
				output: lines.join('\n'),
				metadata: {
					totalTasks: validatedTasks.length,
					completedCount,
					failedCount,
					agentResults,
					synthesis,
					conflicts,
					allCompleted: failedCount === 0,
				},
			};
		},
	);
}

// ─── Synthesis Logic ─────────────────────────────────────────────────────

function _synthesizeResults(
	tasks: Array<{ role: SubAgentRole; goal: string; name?: string }>,
	successful: Array<{ role: string; name?: string; result: string }>,
	failed: Array<{ role: string; name?: string; error: string }>,
): string {
	const lines: string[] = [];

	// Group results by role
	for (const task of tasks) {
		const result = successful.find(r => r.role === task.role && (!task.name || r.name === task.name));
		if (result) {
			lines.push(`## ${task.role.toUpperCase()}${(task.name ? ` — ${task.name}` : '')}`);
			lines.push(`Goal: ${task.goal}`);
			lines.push(`Result: ${result.result}`);
			lines.push('');
		}
	}

	if (failed.length > 0) {
		lines.push('## Failed Agents');
		lines.forEach(() => {}); // spacer
		for (const f of failed) {
			lines.push(`### ${f.role}${(f.name ? ` — ${f.name}` : '')}`);
			lines.push(`Error: ${f.error}`);
			lines.push('');
		}
	}

	// Overall assessment
	lines.push('## Overall Assessment');
	lines.push(`Successfully completed ${successful.length} of ${tasks.length} parallel agent tasks.`);
	if (failed.length > 0) {
		lines.push(`${failed.length} agent(s) failed — review their errors above.`);
	}

	return lines.join('\n');
}

function _detectConflicts(successful: Array<{ role: string; result: string }>): string[] {
	const conflicts: string[] = [];

	// Simple heuristic: look for contradictory statements
	const securityResults = successful.filter(r => r.role === 'reviewer' || r.role === 'architect');
	const testerResults = successful.filter(r => r.role === 'tester');

	// If reviewer says "secure" but tester found issues, that's a conflict
	const hasSecurityConcerns = securityResults.some(r =>
		/r.security|vulnerability|CRITICAL|HIGH/i.test(r.result)
	);
	const hasTestFailures = testerResults.some(r =>
		/r.failed|error|fail/i.test(r.result)
	);

	if (hasSecurityConcerns && hasTestFailures) {
		conflicts.push('Security reviewer found concerns AND tester found failures — prioritize fixing security issues first.');
	}

	// Check for contradictory architectural decisions
	const archResults = successful.filter(r => r.role === 'architect');
	if (archResults.length > 1) {
		// Multiple architect agents might have different suggestions
		const suggestions = archResults.map(r => r.result.substring(0, 100));
		const uniqueSuggestions = new Set(suggestions);
		if (uniqueSuggestions.size > 1) {
			conflicts.push('Multiple architects proposed different designs — review and reconcile before implementing.');
		}
	}

	return conflicts;
}
