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
 * ## Step Ordering & Parallel Execution
 *
 * Steps are grouped into concurrency levels based on their dependsOn
 * declarations. All steps within a level have no mutual dependencies and
 * run concurrently via Promise.all. Levels execute sequentially — level N+1
 * starts only after every step in level N has completed successfully.
 *
 * Example: steps A, B (no deps), C (depends on A), D (depends on A, B)
 *   Level 0: [A, B]   — run concurrently
 *   Level 1: [C]      — runs after A finishes
 *   Level 2: [D]      — runs after both A and B finish
 *
 * ## Output Threading
 *
 * When step B declares dependsOn: ["stepA"], the finalOutput of stepA is
 * injected into stepB's execution context as prior step context. This allows
 * a planner step to produce a plan that an executor step then acts on.
 *
 * ## Failure Handling
 *
 * If any step in a level fails, the workflow is marked failed immediately.
 * Steps that have not yet run are marked 'skipped'. The error from the first
 * failing step is propagated to the IAgentRun.error field.
 */

import { ILLMMessageService } from '../../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../../../void/common/voidSettingsService.js';
import {
	IAgentDefinition, IWorkflowDefinition, IWorkflowStep, IAgentRun, IStepRun,
	AgentRunStatus, IToolExecutionContext,
} from '../../common/workflowTypes.js';
import { ToolRegistry } from '../tools/toolRegistry.js';
import { AgentExecutor, ICancellationToken, IPriorStepOutput } from '../executor/agentExecutor.js';
import { shouldRetry, computeRetryDelay } from '../executor/retryPolicy.js';
import { ToolResultCache } from '../executor/toolCache.js';
import { validateStepOutput } from '../executor/outputValidator.js';
import { ApprovalGateManager, IApprovalRequest } from './approvalGate.js';
import { BudgetTracker } from '../executor/budgetTracker.js';
import { evaluateCondition } from './conditionalEvaluator.js';
import { WorkflowComposer } from './workflowComposer.js';

export type RunUpdateCallback = (run: IAgentRun) => void;

export class WorkflowOrchestrator {

	/** Exposed so WorkflowAgentService can wire the approval API onto the service interface */
	readonly approvalGate = new ApprovalGateManager();

	/**
	 * Resolver for sub-workflow IDs. Set by WorkflowAgentService after construction
	 * so WorkflowComposer can look up workflows by ID without a circular DI dependency.
	 */
	workflowResolver: ((id: string) => IWorkflowDefinition | undefined) | undefined;

	constructor(
		private readonly llmService: ILLMMessageService,
		private readonly settingsService: IVoidSettingsService,
		private readonly toolRegistry: ToolRegistry,
		private readonly contextPacker?: import('../context/packer/contextPacker.js').IContextPackerService,
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
		inheritedToolCache?: ToolResultCache,
		inheritedBudgetTracker?: BudgetTracker,
	): Promise<IAgentRun> {

		run.status = 'planning';
		onUpdate(run);

		// Build concurrency levels: each level is a group of steps that can run in parallel
		let levels: IWorkflowStep[][];
		try {
			levels = this._buildConcurrencyLevels(workflow.steps);
		} catch (e: any) {
			run.status = 'failed';
			run.error = `Step ordering error: ${e.message}`;
			run.endedAt = Date.now();
			onUpdate(run);
			return run;
		}

		run.status = 'running';
		onUpdate(run);

		// Output map: stepId → finalOutput (for dependency injection into downstream steps)
		const stepOutputs = new Map<string, string>();

		// Step IDs deactivated by conditional branches at runtime
		const branchInactiveIds = new Set<string>();

		// Per-run tool result cache (shared across all steps; inherited by sub-workflows)
		const toolCache = inheritedToolCache ?? new ToolResultCache();

		// Per-run budget tracker (undefined if no budget configured; inherited by sub-workflows)
		const budgetTracker = inheritedBudgetTracker ?? (workflow.budget ? new BudgetTracker(workflow.budget) : undefined);

		// Sub-workflow composer (for cross-workflow composition)
		const composer = new WorkflowComposer(this);

		for (const level of levels) {
			if (cancellation.cancelled) {
				run.status = 'cancelled';
				this._markRemainingSkipped(run, levels.flat(), stepOutputs);
				break;
			}

			// Validate all agents in this level before launching any (skip sub-workflow steps)
			for (const step of level) {
				if (step.subWorkflow) continue; // sub-workflow steps don't need a local agent
				if (!agents.get(step.agentId) && !branchInactiveIds.has(step.id)) {
					const stepRun = run.steps.find(s => s.stepId === step.id);
					const err = `Agent definition "${step.agentId}" not found in .inverse/agents/`;
					if (stepRun) { stepRun.status = 'failed'; stepRun.error = err; }
					run.status = 'failed';
					run.error = err;
					run.endedAt = Date.now();
					this._markRemainingSkipped(run, levels.flat(), stepOutputs);
					onUpdate(run);
					return run;
				}
			}

			// Run all steps in this level concurrently
			await Promise.all(level.map(step => this._runStep(
				step, run, agents, baseCtx, input, stepOutputs, cancellation, onUpdate,
				branchInactiveIds, toolCache, budgetTracker, composer,
			)));

			// Collect outputs and check for failures before advancing to next level
			for (const step of level) {
				const stepRun = run.steps.find(s => s.stepId === step.id);
				if (!stepRun) continue;

				// branch-inactive and skipped steps don't fail the run
				if (stepRun.status === 'branch-inactive' || stepRun.status === 'skipped') {
					continue;
				}

				if (stepRun.status === 'failed') {
					run.status = 'failed';
					run.error = stepRun.error;
					run.endedAt = Date.now();
					this._markRemainingSkipped(run, levels.flat(), stepOutputs);
					onUpdate(run);
					return run;
				}

				if (stepRun.finalOutput) {
					stepOutputs.set(step.id, stepRun.finalOutput);

					// Evaluate conditional branch after step completes
					if (step.branch) {
						const { condition, thenStep, elseStep } = step.branch;
						let condResult = false;
						try {
							condResult = evaluateCondition(stepRun.finalOutput, condition);
						} catch (e: any) {
							console.warn(`[WorkflowOrchestrator] Branch condition eval failed for step "${step.id}": ${e.message}`);
						}
						const inactiveStepId = condResult ? elseStep : thenStep;
						const activeStepId = condResult ? thenStep : elseStep;
						if (inactiveStepId) {
							branchInactiveIds.add(inactiveStepId);
							const inactiveRun = run.steps.find(s => s.stepId === inactiveStepId);
							if (inactiveRun) inactiveRun.status = 'branch-inactive';
						}
						console.log(`[WorkflowOrchestrator] Branch for "${step.id}": condition=${condResult}, active="${activeStepId ?? 'none'}", inactive="${inactiveStepId ?? 'none'}"`);
					}
				}
			}

			// Propagate budget usage to run-level token tracking
			if (budgetTracker) {
				const usage = budgetTracker.getUsage();
				run.tokenUsage = usage;
			}
		}

		if (run.status !== 'cancelled') {
			// Final output = last completed step's output, skipping branch-inactive steps
			const allSteps = levels.flat();
			for (let i = allSteps.length - 1; i >= 0; i--) {
				const output = stepOutputs.get(allSteps[i].id);
				if (output !== undefined) {
					run.finalOutput = output;
					break;
				}
			}
			run.status = 'done';
		}

		run.endedAt = Date.now();
		onUpdate(run);
		return run;
	}

	/**
	 * Execute a single step. Mutates stepRun and fires onUpdate on the parent run.
	 * Does NOT write to stepOutputs — the caller collects outputs after Promise.all settles.
	 */
	private async _runStep(
		step: IWorkflowStep,
		run: IAgentRun,
		agents: Map<string, IAgentDefinition>,
		baseCtx: Omit<IToolExecutionContext, 'log'>,
		input: string,
		stepOutputs: Map<string, string>,
		cancellation: ICancellationToken,
		onUpdate: RunUpdateCallback,
		branchInactiveIds: Set<string>,
		toolCache: ToolResultCache,
		budgetTracker: BudgetTracker | undefined,
		composer: WorkflowComposer,
	): Promise<void> {
		const stepRun = run.steps.find(s => s.stepId === step.id);
		if (!stepRun) return;

		// ── Branch-inactive check ─────────────────────────────────────────────
		if (branchInactiveIds.has(step.id)) {
			stepRun.status = 'branch-inactive';
			onUpdate(run);
			return;
		}

		// ── Approval gate (before) ────────────────────────────────────────────
		if (step.approval?.timing === 'before') {
			const approved = await this._requestApproval(step, run, stepRun, undefined, onUpdate);
			if (!approved) return; // stepRun already set to failed/skipped
		}

		// ── Sub-workflow delegation ───────────────────────────────────────────
		if (step.subWorkflow) {
			await composer.runSubWorkflow(step, run, stepRun, agents, baseCtx, input, stepOutputs, cancellation, onUpdate, toolCache, budgetTracker, branchInactiveIds);
			onUpdate(run);
			return;
		}

		const agent = agents.get(step.agentId)!;

		const priorOutputs: IPriorStepOutput[] = (step.dependsOn ?? [])
			.map(depId => {
				const depStep = run.steps.find(s => s.stepId === depId);
				return {
					stepId: depId,
					role: depStep?.role ?? 'unknown',
					output: stepOutputs.get(depId) ?? '',
				};
			})
			.filter(p => p.output.length > 0);

		const scopedTools = this.toolRegistry.scope(step.allowedTools);
		const toolCtx: IToolExecutionContext = {
			workspaceUri: baseCtx.workspaceUri,
			fileService: baseCtx.fileService,
			modelInfo: baseCtx.modelInfo,
			log: (msg: string) => {
				stepRun.outputLog.push(`[${new Date().toISOString()}] ${msg}`);
				onUpdate(run);
			},
		};

		const stepInput = this._buildStepInput(step, input, priorOutputs, priorOutputs.length > 0);

		// ── Retry loop ────────────────────────────────────────────────────────
		const retryConfig = step.retry;
		let attempt = 0;

		while (true) {
			// Reset step state for each attempt — cast through StepRunStatus to satisfy narrowing
			(stepRun as IStepRun).status = 'pending';
			stepRun.error = undefined;
			stepRun.finalOutput = undefined;
			stepRun.toolCalls = attempt === 0 ? stepRun.toolCalls : [];
			stepRun.iterationsUsed = 0;

			const executor = new AgentExecutor(
				this.llmService, this.settingsService, scopedTools, this.contextPacker,
				toolCache, step.cacheConfig, budgetTracker,
			);

			await executor.execute(agent, step, stepRun, priorOutputs, toolCtx, stepInput, cancellation);

			// Read status after async mutation — use string comparison to bypass narrowing
			const statusAfterExecute = stepRun.status as string;

			// ── Output validation ─────────────────────────────────────────────
			if (statusAfterExecute === 'done' && step.outputSchema && stepRun.finalOutput) {
				const validation = validateStepOutput(stepRun.finalOutput, step.outputSchema);
				if (!validation.valid) {
					const validationErr = `Output validation failed: ${validation.errors.join('; ')}`;
					stepRun.status = 'failed';
					stepRun.error = validationErr;
					stepRun.endedAt = Date.now();
					toolCtx.log(`[${step.id}] output validation ✗ — ${validationErr}`);

					if (step.outputSchema.onInvalid !== 'retry') {
						break; // permanent failure
					}
					// Fall through to retry logic below
				}
			}

			// Success — exit retry loop
			if ((stepRun.status as string) === 'done') break;

			// Check if we should retry
			const error = stepRun.error ?? 'Unknown error';
			attempt++;

			if (!retryConfig || !shouldRetry(error, attempt, retryConfig)) {
				break; // permanent failure
			}

			// Record retry history
			if (!stepRun.retryHistory) stepRun.retryHistory = [];
			stepRun.retryHistory.push({ attempt, error, retriedAt: Date.now() });
			stepRun.retryCount = attempt;

			const delayMs = computeRetryDelay(attempt, retryConfig);
			toolCtx.log(`[${step.id}] retry ${attempt}/${retryConfig.maxRetries} in ${Math.round(delayMs)}ms — ${error}`);
			onUpdate(run);

			await new Promise<void>(r => setTimeout(r, delayMs));

			if (cancellation.cancelled) {
				stepRun.status = 'failed';
				stepRun.error = 'Cancelled during retry';
				break;
			}
		}

		// ── Approval gate (after) ─────────────────────────────────────────────
		if ((stepRun.status as string) === 'done' && step.approval?.timing === 'after') {
			const approved = await this._requestApproval(step, run, stepRun, stepRun.finalOutput, onUpdate);
			if (!approved) return;
		}

		onUpdate(run);
	}

	/**
	 * Fire an approval gate and wait for user response.
	 * Returns true if approved, false if rejected (stepRun already mutated).
	 */
	private async _requestApproval(
		step: IWorkflowStep,
		run: IAgentRun,
		stepRun: IStepRun,
		stepOutput: string | undefined,
		onUpdate: RunUpdateCallback,
	): Promise<boolean> {
		const approval = step.approval!;
		const requestedAt = Date.now();

		stepRun.status = 'awaiting-approval';
		stepRun.approvalRequest = { prompt: approval.prompt, requestedAt, stepOutput };
		run.status = 'awaiting-approval';
		onUpdate(run);

		const request: IApprovalRequest = {
			runId: run.id,
			stepId: step.id,
			prompt: approval.prompt,
			stepOutput,
			requestedAt,
			autoApproveAt: approval.autoApproveAfterSeconds
				? requestedAt + approval.autoApproveAfterSeconds * 1000
				: undefined,
		};

		const response = await this.approvalGate.requestApproval(request);

		stepRun.approvalResponse = {
			decision: response.decision,
			feedback: response.feedback,
			respondedAt: Date.now(),
		};
		run.status = 'running';

		if (response.decision === 'reject') {
			const onReject = approval.onReject ?? 'fail';
			if (onReject === 'skip') {
				stepRun.status = 'skipped';
			} else {
				stepRun.status = 'failed';
				stepRun.error = `Rejected by user${response.feedback ? `: ${response.feedback}` : ''}`;
				stepRun.endedAt = Date.now();
			}
			onUpdate(run);
			return false;
		}

		stepRun.status = 'pending'; // will be reset to 'running' by executor
		return true;
	}

	// ─── Concurrency Level Builder ───────────────────────────────────────────

	/**
	 * Groups steps into levels using Kahn's algorithm (BFS topological sort).
	 * Steps within the same level have no mutual dependencies and can run in parallel.
	 * Throws if a cycle is detected or a dependsOn reference is undefined.
	 */
	private _buildConcurrencyLevels(steps: IWorkflowStep[]): IWorkflowStep[][] {
		const stepMap = new Map(steps.map(s => [s.id, s]));

		// Validate all dependsOn references
		for (const step of steps) {
			for (const dep of step.dependsOn ?? []) {
				if (!stepMap.has(dep)) {
					throw new Error(`Step "${step.id}" depends on "${dep}" which is not defined`);
				}
			}
		}

		// Build in-degree map and reverse adjacency (dep → steps that depend on it)
		const inDegree = new Map<string, number>(steps.map(s => [s.id, s.dependsOn?.length ?? 0]));
		const dependents = new Map<string, string[]>(steps.map(s => [s.id, []]));
		for (const step of steps) {
			for (const dep of step.dependsOn ?? []) {
				dependents.get(dep)!.push(step.id);
			}
		}

		const levels: IWorkflowStep[][] = [];
		// Seed queue with all steps that have no dependencies
		let frontier = steps.filter(s => (s.dependsOn?.length ?? 0) === 0);

		while (frontier.length > 0) {
			levels.push(frontier);
			const next: IWorkflowStep[] = [];
			for (const step of frontier) {
				for (const dependentId of dependents.get(step.id) ?? []) {
					const remaining = inDegree.get(dependentId)! - 1;
					inDegree.set(dependentId, remaining);
					if (remaining === 0) {
						next.push(stepMap.get(dependentId)!);
					}
				}
			}
			frontier = next;
		}

		// If any step still has unresolved in-degree, there is a cycle
		const processed = levels.flat().length;
		if (processed !== steps.length) {
			const cycleIds = steps.filter(s => inDegree.get(s.id)! > 0).map(s => s.id);
			throw new Error(`Cycle detected among steps: ${cycleIds.join(', ')}`);
		}

		return levels;
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	private _buildStepInput(
		step: IWorkflowStep,
		originalInput: string,
		priorOutputs: IPriorStepOutput[],
		hasPriorOutputs: boolean,
	): string {
		if (!hasPriorOutputs || priorOutputs.length === 0) {
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
