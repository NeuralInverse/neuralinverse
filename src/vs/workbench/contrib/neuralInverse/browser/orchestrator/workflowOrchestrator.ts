/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Workflow Orchestrator
 *
 * Coordinates a multi-agent workflow: resolves step execution order,
 * runs each step via AgentExecutor, and threads outputs between steps.
 *
 * ## Step Ordering
 *
 * Steps are sorted topologically based on their dependsOn declarations.
 * Steps with no dependencies may be run concurrently (future: parallel execution).
 * Currently executed sequentially for predictability.
 *
 * ## Output Threading
 *
 * When step B declares dependsOn: ["stepA"], the finalOutput of stepA is
 * injected into stepB's execution context as prior step context. This allows
 * a planner step to produce a plan that an executor step then acts on.
 *
 * ## Failure Handling
 *
 * If any step fails, the workflow is marked failed immediately. Steps that
 * have not yet run are marked 'skipped'. The error from the failing step
 * is propagated to the IAgentRun.error field.
 */

import { ILLMMessageService } from '../../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../../../void/common/voidSettingsService.js';
import { IAgentDefinition } from '../../common/workflowTypes.js';
import { INeuralInverseCCService } from '../../../neuralInverseCC/browser/neuralInverseCCService.js';
import {
	IWorkflowDefinition, IWorkflowStep, IAgentRun, IStepRun,
	AgentRunStatus, IToolExecutionContext,
} from '../../common/workflowTypes.js';
import { ToolRegistry } from '../tools/toolRegistry.js';
import { AgentExecutor, ICancellationToken, IPriorStepOutput } from '../executor/agentExecutor.js';

export type RunUpdateCallback = (run: IAgentRun) => void;

export class WorkflowOrchestrator {

	constructor(
		private readonly llmService: ILLMMessageService,
		private readonly settingsService: IVoidSettingsService,
		private readonly toolRegistry: ToolRegistry,
		private readonly ccService?: INeuralInverseCCService,
	) {}

	/**
	 * Execute a full workflow. Mutates the IAgentRun in place, calling onUpdate
	 * after each meaningful state change so the UI stays live.
	 */
	async run(
		workflow: IWorkflowDefinition,
		run: IAgentRun,
		agents: Map<string, IAgentDefinition>,
		baseCtx: Omit<IToolExecutionContext, 'log'>,
		input: string,
		cancellation: ICancellationToken,
		onUpdate: RunUpdateCallback,
	): Promise<IAgentRun> {

		run.status = 'planning';
		onUpdate(run);

		// Resolve execution order
		let orderedSteps: IWorkflowStep[];
		try {
			orderedSteps = this._topoSort(workflow.steps);
		} catch (e: any) {
			run.status = 'failed';
			run.error = `Step ordering error: ${e.message}`;
			run.endedAt = Date.now();
			onUpdate(run);
			return run;
		}

		run.status = 'running';
		onUpdate(run);

		// Output map: stepId \u2192 finalOutput (for dependency injection)
		const stepOutputs = new Map<string, string>();

		for (const step of orderedSteps) {
			if (cancellation.cancelled) {
				run.status = 'cancelled';
				this._markRemainingSkipped(run, orderedSteps, stepOutputs);
				break;
			}

			const stepRun = run.steps.find(s => s.stepId === step.id);
			if (!stepRun) continue;

			// Resolve agent definition
			const agent = agents.get(step.agentId);
			if (!agent) {
				stepRun.status = 'failed';
				stepRun.error = `Agent definition "${step.agentId}" not found in .inverse/agents/`;
				run.status = 'failed';
				run.error = stepRun.error;
				run.endedAt = Date.now();
				onUpdate(run);
				return run;
			}

			// Build prior outputs for this step
			const priorOutputs: IPriorStepOutput[] = (step.dependsOn ?? [])
				.map(depId => {
					const depStep = workflow.steps.find(s => s.id === depId);
					return {
						stepId: depId,
						role: depStep?.role ?? 'unknown',
						output: stepOutputs.get(depId) ?? '',
					};
				})
				.filter(p => p.output.length > 0);

			// Build scoped tool context with live logging
			const scopedTools = this.toolRegistry.scope(step.allowedTools);
			const toolCtx: IToolExecutionContext = {
				workspaceUri: baseCtx.workspaceUri,
				fileService: baseCtx.fileService,
				log: (msg: string) => {
					stepRun.outputLog.push(`[${new Date().toISOString()}] ${msg}`);
					onUpdate(run);
				},
			};

			const executor = new AgentExecutor(this.llmService, this.settingsService, scopedTools, this.ccService);

			// Determine input: first step gets the original user input,
			// subsequent steps get a summary request unless they have prior outputs
			const stepInput = this._buildStepInput(step, input, priorOutputs, orderedSteps.indexOf(step));

			await executor.execute(agent, step, stepRun, priorOutputs, toolCtx, stepInput, cancellation);
			onUpdate(run);

			if (stepRun.status === 'failed') {
				run.status = 'failed';
				run.error = stepRun.error;
				run.endedAt = Date.now();
				this._markRemainingSkipped(run, orderedSteps, stepOutputs);
				onUpdate(run);
				return run;
			}

			if (stepRun.finalOutput) {
				stepOutputs.set(step.id, stepRun.finalOutput);
			}
		}

		if (run.status !== 'cancelled') {
			// Final output = last completed step's output
			const lastStep = orderedSteps[orderedSteps.length - 1];
			run.finalOutput = stepOutputs.get(lastStep.id);
			run.status = 'done';
		}

		run.endedAt = Date.now();
		onUpdate(run);
		return run;
	}

	// ─── Topological Sort ────────────────────────────────────────────────────

	private _topoSort(steps: IWorkflowStep[]): IWorkflowStep[] {
		const stepMap = new Map(steps.map(s => [s.id, s]));
		const visited = new Set<string>();
		const inStack = new Set<string>(); // cycle detection
		const result: IWorkflowStep[] = [];

		const visit = (id: string) => {
			if (visited.has(id)) return;
			if (inStack.has(id)) throw new Error(`Cycle detected in workflow steps: "${id}"`);

			inStack.add(id);
			const step = stepMap.get(id);
			if (!step) throw new Error(`Step "${id}" referenced in dependsOn but not defined`);

			for (const dep of step.dependsOn ?? []) {
				visit(dep);
			}

			inStack.delete(id);
			visited.add(id);
			result.push(step);
		};

		for (const step of steps) {
			visit(step.id);
		}

		return result;
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	private _buildStepInput(
		step: IWorkflowStep,
		originalInput: string,
		priorOutputs: IPriorStepOutput[],
		stepIndex: number,
	): string {
		if (stepIndex === 0 || priorOutputs.length === 0) {
			return originalInput;
		}
		// For downstream steps, inject the original goal so context is maintained
		return `Original goal: ${originalInput}\n\nYour task as ${step.role}: complete your assigned role based on the context from prior steps provided in the system prompt.`;
	}

	private _markRemainingSkipped(
		run: IAgentRun,
		orderedSteps: IWorkflowStep[],
		completedIds: Map<string, string>,
	): void {
		for (const step of orderedSteps) {
			if (completedIds.has(step.id)) continue;
			const stepRun = run.steps.find(s => s.stepId === step.id);
			if (stepRun && stepRun.status === 'pending') {
				stepRun.status = 'skipped';
			}
		}
	}
}

// ─── Factory helpers ──────────────────────────────────────────────────────────

/** Build the initial IStepRun stubs for all steps in a workflow */
export function buildInitialStepRuns(workflow: IWorkflowDefinition): IStepRun[] {
	return workflow.steps.map(step => ({
		stepId: step.id,
		agentId: step.agentId,
		role: step.role,
		status: 'pending' as const,
		toolCalls: [],
		outputLog: [],
		iterationsUsed: 0,
	}));
}

/** Build a fresh IAgentRun for a workflow */
export function buildAgentRun(
	workflow: IWorkflowDefinition,
	trigger: IAgentRun['triggerContext'],
): IAgentRun {
	return {
		id: _nanoid(),
		workflowId: workflow.id,
		workflowName: workflow.name,
		status: 'queued' as AgentRunStatus,
		startedAt: Date.now(),
		steps: buildInitialStepRuns(workflow),
		triggerContext: trigger,
	};
}

function _nanoid(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
