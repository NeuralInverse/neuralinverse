/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Workflow Composer
 *
 * Handles cross-workflow composition: a step can delegate to another workflow
 * instead of running an agent directly. The sub-workflow's finalOutput becomes
 * the step's output.
 *
 * ## Cycle Detection
 *
 * A call stack set tracks active workflow IDs. Circular references
 * (A → B → A) throw immediately with a clear error.
 *
 * ## Budget Sharing
 *
 * The parent's BudgetTracker is passed into the sub-workflow, so token
 * consumption counts against the parent's limit.
 *
 * ## Nesting Limit
 *
 * Max 5 levels deep by default to prevent accidental runaway recursion.
 */

import { IWorkflowStep, IAgentRun, IStepRun, IAgentDefinition, IToolExecutionContext, AgentRunStatus } from '../../common/workflowTypes.js';
import { ICancellationToken } from '../executor/agentExecutor.js';
import { ToolResultCache } from '../executor/toolCache.js';
import { BudgetTracker } from '../executor/budgetTracker.js';
import { evaluateExpression } from './conditionalEvaluator.js';

const MAX_NESTING_DEPTH = 5;

export class WorkflowComposer {

	/** Active workflow IDs in the current call stack (for cycle detection) */
	private readonly _callStack: string[] = [];

	constructor(
		// Circular type reference avoided via late binding — orchestrator passed at construction
		private readonly orchestrator: {
			run(workflow: import('../../common/workflowTypes.js').IWorkflowDefinition, run: IAgentRun, agents: Map<string, IAgentDefinition>, baseCtx: Omit<IToolExecutionContext, 'log'>, input: string, cancellation: ICancellationToken, onUpdate: (run: IAgentRun) => void, inheritedToolCache?: ToolResultCache, inheritedBudgetTracker?: BudgetTracker): Promise<IAgentRun>;
			readonly approvalGate: import('./approvalGate.js').ApprovalGateManager;
			workflowResolver?: (id: string) => import('../../common/workflowTypes.js').IWorkflowDefinition | undefined;
		},
	) {}

	async runSubWorkflow(
		step: IWorkflowStep,
		parentRun: IAgentRun,
		stepRun: IStepRun,
		agents: Map<string, IAgentDefinition>,
		baseCtx: Omit<IToolExecutionContext, 'log'>,
		input: string,
		stepOutputs: Map<string, string>,
		cancellation: ICancellationToken,
		onUpdate: (run: IAgentRun) => void,
		toolCache: ToolResultCache,
		budgetTracker: BudgetTracker | undefined,
		branchInactiveIds: Set<string>,
	): Promise<void> {
		const subConfig = step.subWorkflow!;

		// ── Depth check ───────────────────────────────────────────────────────
		if (this._callStack.length >= MAX_NESTING_DEPTH) {
			stepRun.status = 'failed';
			stepRun.error = `Sub-workflow nesting limit (${MAX_NESTING_DEPTH}) exceeded`;
			stepRun.endedAt = Date.now();
			return;
		}

		// ── Cycle detection ───────────────────────────────────────────────────
		if (this._callStack.includes(subConfig.workflowId)) {
			stepRun.status = 'failed';
			stepRun.error = `Circular sub-workflow reference: ${[...this._callStack, subConfig.workflowId].join(' → ')}`;
			stepRun.endedAt = Date.now();
			return;
		}

		// ── Resolve sub-workflow ──────────────────────────────────────────────
		const resolver = this.orchestrator.workflowResolver;
		const subWorkflow = resolver ? resolver(subConfig.workflowId) : undefined;
		if (!subWorkflow) {
			stepRun.status = 'failed';
			stepRun.error = `Sub-workflow "${subConfig.workflowId}" not found`;
			stepRun.endedAt = Date.now();
			return;
		}

		// ── Build input ───────────────────────────────────────────────────────
		let subInput = input;
		if (subConfig.inputMapping) {
			// Evaluate the mapping expression against upstream step outputs
			const upstreamOutput = (step.dependsOn ?? [])
				.map(id => stepOutputs.get(id))
				.filter(Boolean)
				.join('\n\n');
			if (upstreamOutput) {
				try {
					const mapped = evaluateExpression(upstreamOutput, subConfig.inputMapping);
					subInput = typeof mapped === 'string' ? mapped : JSON.stringify(mapped);
				} catch (e: any) {
					stepRun.status = 'failed';
					stepRun.error = `inputMapping expression error: ${e.message}`;
					stepRun.endedAt = Date.now();
					return;
				}
			}
		}

		// ── Run sub-workflow ──────────────────────────────────────────────────
		this._callStack.push(subConfig.workflowId);
		stepRun.status = 'running';
		stepRun.startedAt = Date.now();

		try {
			const subRun: IAgentRun = {
			id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
			workflowId: subWorkflow.id,
			workflowName: subWorkflow.name,
			status: 'queued' as AgentRunStatus,
			startedAt: Date.now(),
			steps: subWorkflow.steps.map(s => ({
				stepId: s.id,
				agentId: s.agentId,
				role: s.role,
				status: 'pending' as const,
				toolCalls: [],
				outputLog: [],
				iterationsUsed: 0,
			})),
			triggerContext: { kind: 'manual' },
		};
			await this.orchestrator.run(
				subWorkflow, subRun, agents, baseCtx, subInput, cancellation,
				(r) => onUpdate(parentRun), // fire parent run events to keep UI updated
				toolCache, budgetTracker,
			);

			if (subRun.status === 'done') {
				stepRun.status = 'done';
				stepRun.finalOutput = subRun.finalOutput;
				stepRun.endedAt = Date.now();
			} else {
				stepRun.status = 'failed';
				stepRun.error = subRun.error ?? `Sub-workflow "${subConfig.workflowId}" failed`;
				stepRun.endedAt = Date.now();
			}
		} catch (e: any) {
			stepRun.status = 'failed';
			stepRun.error = e.message;
			stepRun.endedAt = Date.now();
		} finally {
			this._callStack.pop();
		}
	}
}
