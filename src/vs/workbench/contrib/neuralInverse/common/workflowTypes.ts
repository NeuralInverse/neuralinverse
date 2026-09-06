/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Workflow Agent Types
 *
 * Core interfaces for the multi-agent workflow engine in contrib/neuralInverse.
 *
 * ## Concepts
 *
 * - **IAgentTool**         — a single capability an agent can invoke (readFile, runCommand, etc.)
 * - **IWorkflowDefinition** — a named pipeline of ordered agent steps loaded from .inverse/workflows/
 * - **IAgentRun**           — the live/historical execution state of a workflow
 *
 * ## .inverse/ Access Rule
 *
 * Reading from .inverse/ → IFileService.readFile() directly (no unlock needed).
 * Writing to  .inverse/ → must wrap with withInverseWriteAccess() from inverseFs.ts.
 */

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';

// ─── Agent Definition ─────────────────────────────────────────────────────────

/**
 * Canonical agent definition — stored as .inverse/agents/<id>.json.
 *
 * The `model` field uses the Void provider/model pair so the executor can
 * make the LLM call on the correct provider instead of always falling back
 * to the global Chat model.
 */
export interface IAgentDefinition {
	/** Stable unique slug, e.g. "code-reviewer". Derived from name on create. */
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	/** Provider + model pair for LLM calls */
	readonly model: { providerName: string; modelName: string };
	/** Full system instructions */
	readonly systemInstructions: string;
	/**
	 * Opening questions the Agents tab asks LOCALLY in the UI (no LLM
	 * round-trip). The answers are packaged into the first message, so the
	 * model never burns a turn asking them — the agent starts working
	 * immediately with everything it needs.
	 */
	readonly intakeQuestions?: IIntakeQuestion[];
	/** Tool names from the registry this agent is allowed to call */
	readonly allowedTools: string[];
	/** Max LLM+tool loop iterations before force-stop. Default: 20 */
	readonly maxIterations?: number;
	/** Optional tags for filtering */
	readonly tags?: string[];
	/** True if provisioned from the built-in library */
	readonly isBuiltin?: boolean;
	readonly createdAt?: number;
	readonly updatedAt?: number;
}

export interface IIntakeQuestion {
	id: string;
	question: string;
	placeholder?: string;
	/** When set, the UI offers selectable chips instead of free text */
	options?: string[];
	required?: boolean;
}

// ─── Tool Interfaces ──────────────────────────────────────────────────────────

export interface IToolParameter {
	type: 'string' | 'number' | 'boolean' | 'array';
	description: string;
	required?: boolean;
	/** For array types — describes the element type */
	items?: { type: string };
	/** Optional enum of allowed values */
	enum?: string[];
}

export interface IToolResult {
	success: boolean;
	/** Human-readable output returned to the LLM */
	output: string;
	error?: string;
}

export interface IToolExecutionContext {
	/** Root URI of the workspace */
	workspaceUri: URI;
	/** For file operations */
	fileService: IFileService;
	/** Append a line to the current step's output log */
	log: (msg: string) => void;
	/** Active LLM model info — used for auto co-author trailers */
	modelInfo?: { provider: string; model: string };
}

export interface IAgentTool {
	readonly name: string;
	readonly description: string;
	/** JSON Schema-compatible parameter map — used to build LLM tool schemas */
	readonly parameters: Record<string, IToolParameter>;
	execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult>;
}

// ─── Tool Call Record ─────────────────────────────────────────────────────────

export interface IToolCallRecord {
	toolName: string;
	args: Record<string, unknown>;
	result: IToolResult;
	executedAt: number;
	durationMs: number;
}

// ─── Step Retry Config ────────────────────────────────────────────────────────

/**
 * Exponential backoff retry configuration for a workflow step.
 * When a step fails with a retryable error, the orchestrator waits
 * `baseDelayMs * backoffMultiplier^(attempt-1)` (±20% jitter) before re-running.
 */
export interface IStepRetryConfig {
	/** Maximum number of retry attempts. 0 = no retries (default). */
	maxRetries: number;
	/** Base delay in ms before the first retry. Default: 1000. */
	baseDelayMs?: number;
	/** Multiplier applied per retry (exponential). Default: 2. */
	backoffMultiplier?: number;
	/** Maximum delay cap in ms regardless of backoff. Default: 30000. */
	maxDelayMs?: number;
	/** Regex patterns (case-insensitive) that make an error non-retryable even if normally retryable. */
	nonRetryablePatterns?: string[];
}

// ─── Step Output Schema ───────────────────────────────────────────────────────

/**
 * Optional schema that a step's final output must conform to.
 * Validated after the executor completes. If invalid and onInvalid='retry',
 * the step is marked failed so the retry policy can re-run it.
 */
export interface IStepOutputSchema {
	/** Expected output format */
	format: 'json' | 'text' | 'markdown' | 'json-schema';
	/** For format='json-schema': JSON Schema object to validate against */
	jsonSchema?: Record<string, unknown>;
	/** For format='json': top-level keys that must be present */
	requiredKeys?: string[];
	/** For format='text'|'markdown': regex the full output must match */
	pattern?: string;
	/** Maximum output length in characters. Prevents runaway generation. */
	maxLength?: number;
	/** What to do when validation fails. Default: 'fail'. */
	onInvalid?: 'retry' | 'fail';
}

// ─── Tool Cache Config ────────────────────────────────────────────────────────

/**
 * Per-step tool result caching. Results are cached within a single run only —
 * never across runs. Identical (toolName, args) pairs return the cached result
 * without re-executing the tool.
 */
export interface IStepToolCacheConfig {
	/** Enable caching for this step. Default: false. */
	enabled: boolean;
	/** Tool names to cache. If empty, all successful tool results are cached. */
	cacheableTools?: string[];
	/** TTL in ms within a run. Default: 300000 (5 min). */
	ttlMs?: number;
}

// ─── Workflow Step ────────────────────────────────────────────────────────────

/**
 * A single step in a workflow pipeline.
 *
 * Each step maps to one agent definition (.inverse/agents/<agentId>.md).
 * Steps can declare dependencies on prior steps — their output is injected
 * into this step's context automatically.
 */
export interface IWorkflowStep {
	/** Unique ID within the workflow */
	id: string;
	/** References .inverse/agents/<agentId>.md */
	agentId: string;
	/** Semantic role — used for UI display and orchestrator decisions */
	role: 'planner' | 'executor' | 'validator' | 'reviewer' | string;
	/** Step ids whose final output feeds into this step as context */
	dependsOn?: string[];
	/** Whitelist of tool names this step may call — enforced at runtime */
	allowedTools: string[];
	/** Max LLM + tool iterations before the step is force-terminated. Default: 20 */
	maxIterations?: number;
	/** Context Engine pre-injection configuration for this step */
	contextConfig?: IStepContextConfig;
	/** Retry policy for this step. If omitted, failed steps fail immediately. */
	retry?: IStepRetryConfig;
	/** Output schema validation. If omitted, any output is accepted. */
	outputSchema?: IStepOutputSchema;
	/** Tool result caching for this step. If omitted, caching is disabled. */
	cacheConfig?: IStepToolCacheConfig;
	/** If true, independent tool calls from a single LLM response run concurrently. Default: false. */
	parallelTools?: boolean;
	/** Max concurrent tool calls when parallelTools is true. Default: 5. */
	maxParallelToolCalls?: number;
	/** If set, this step invokes another workflow instead of running an agent directly. */
	subWorkflow?: ISubWorkflowConfig;
	/** If set, activates conditional routing after this step completes. */
	branch?: IStepBranchConfig;
	/** Approval gate configuration. If omitted, no approval is required. */
	approval?: IStepApprovalConfig;
}

/**
 * Controls how the Context Engine pre-injects workspace context
 * into the system prompt for a workflow step.
 */
export interface IStepContextConfig {
	/** Context packing mode — affects extraction strategy and budget defaults */
	mode: 'autocomplete' | 'chat' | 'inline-edit' | 'agent';
	/** Token budget override (uses mode default if not set) */
	budget?: number;
	/** File URIs guaranteed inclusion in context regardless of relevance score */
	priorityFiles?: string[];
	/** Include the active editor file in context */
	includeActiveFile?: boolean;
	/** Disable automatic context pre-injection (step handles its own context via tools) */
	disableAutoContext?: boolean;
}

// ─── Sub-Workflow Config ──────────────────────────────────────────────────────

/**
 * When set on a step, the step delegates to another workflow instead of
 * running an agent. The sub-workflow's finalOutput becomes this step's output.
 */
export interface ISubWorkflowConfig {
	/** ID of the workflow to invoke */
	workflowId: string;
	/** Optional expression to transform upstream step output before passing as input.
	 *  Uses the same expression language as IStepBranchConfig.condition.
	 *  If omitted, the upstream output is passed through unchanged. */
	inputMapping?: string;
}

// ─── Branch Config ────────────────────────────────────────────────────────────

/**
 * Conditional routing after a step completes. The step's finalOutput is
 * evaluated against `condition`. The inactive branch's steps are marked
 * 'branch-inactive' and skipped — the DAG topology is unchanged.
 *
 * Expression language (no eval):
 *   $.key             — access JSON property
 *   $.key === "value" — equality
 *   $.score > 0.8     — numeric comparison (===, !==, >, <, >=, <=)
 *   contains($.text, "LGTM")   — substring check
 *   length($.items) > 0        — array length
 *   startsWith($.msg, "PASS")  — prefix check
 *   endsWith($.msg, "OK")      — suffix check
 *   expr && expr / expr || expr — boolean combinators
 */
export interface IStepBranchConfig {
	/** Expression evaluated against the step's finalOutput (parsed as JSON) */
	condition: string;
	/** Step ID to run if condition is true */
	thenStep: string;
	/** Step ID to run if condition is false. If omitted, the else branch is skipped. */
	elseStep?: string;
}

// ─── Approval Config ──────────────────────────────────────────────────────────

/**
 * Human-in-the-loop approval gate for a step.
 * The orchestrator pauses and fires onDidRequestApproval. The UI responds via
 * IWorkflowAgentService.respondToApproval(). Auto-approve fires after timeout.
 */
export interface IStepApprovalConfig {
	/** When to pause: before the step runs, or after (output preview shown to user). */
	timing: 'before' | 'after';
	/** Message displayed to the user in the approval prompt. */
	prompt: string;
	/** Auto-approve after this many seconds with no response. 0 = wait forever. Default: 0. */
	autoApproveAfterSeconds?: number;
	/** What to do if the user rejects. Default: 'fail'. */
	onReject?: 'fail' | 'skip' | 'retry';
}

// ─── Trigger Guard Config ─────────────────────────────────────────────────────

/**
 * Pre-flight guard evaluated before an automatic trigger fires.
 * ALL guards must pass (AND semantics). If any fails, the trigger is suppressed.
 */
export interface ITriggerGuardConfig {
	type: 'glob-match' | 'command-exit' | 'file-exists' | 'expression';
	/** For 'glob-match': the triggering file path must match this glob */
	glob?: string;
	/** For 'command-exit': shell command that must exit 0 */
	command?: string;
	/** For 'command-exit': timeout in ms. Default: 30000. */
	commandTimeoutMs?: number;
	/** For 'file-exists': workspace-relative path that must exist */
	filePath?: string;
	/** For 'expression': evaluated against trigger context */
	expression?: string;
	/** If true, negate the result — guard passes when the condition fails. */
	negate?: boolean;
}

// ─── Budget Config ────────────────────────────────────────────────────────────

/**
 * Token and cost budget for an entire workflow run.
 * When the budget is exceeded, the current step is aborted.
 */
export interface IWorkflowBudgetConfig {
	/** Max total tokens (input + output) for the entire run. */
	maxTokensPerRun?: number;
	/** Max tokens for any single step. */
	maxTokensPerStep?: number;
	/** Max estimated cost in USD for the entire run. */
	maxCostUsd?: number;
	/** What to do when exceeded. Default: 'fail'. */
	onExceeded?: 'fail' | 'warn';
}

// ─── Workflow Definition ──────────────────────────────────────────────────────

export type WorkflowTrigger =
	| 'manual'
	| 'file-save'
	| 'schedule'
	| 'on-commit'
	| 'terminal-command';

/**
 * A workflow definition loaded from .inverse/workflows/<id>.json.
 *
 * Workflows are the unit of work — they compose multiple agents into a
 * coordinated pipeline that replaces an internal dev tool.
 */
export interface IWorkflowDefinition {
	/** Stable identifier, e.g. "scaffold-component" */
	id: string;
	name: string;
	description: string;
	trigger: WorkflowTrigger;

	// ── file-save trigger ────────────────────────────────────────────────────
	/** Glob for file-save triggers, e.g. "src/**\/*.ts" */
	triggerGlob?: string;

	// ── schedule trigger ─────────────────────────────────────────────────────
	/** For schedule triggers — minutes between runs */
	scheduleIntervalMinutes?: number;

	// ── terminal-command trigger ─────────────────────────────────────────────
	/**
	 * Shell command to run on a recurring interval (uses scheduleIntervalMinutes
	 * for the polling frequency, default 5 minutes).
	 * Example: "npm run check", "tsc --noEmit", "pytest --tb=no -q"
	 */
	triggerCommand?: string;
	/**
	 * When to fire the workflow based on the command's exit code.
	 * - 'success'  → fire when exit code === 0
	 * - 'failure'  → fire when exit code !== 0  (default — use agents to fix it)
	 * - 'any'      → fire regardless of exit code
	 */
	triggerOnExit?: 'success' | 'failure' | 'any';

	/** Ordered steps. Steps with no dependsOn may run in parallel */
	steps: IWorkflowStep[];
	/** What internal tool this workflow replaces, e.g. "Makefile:scaffold" */
	replaces?: string;
	/** Whether this workflow is currently enabled */
	enabled: boolean;
	/** Pre-flight guards — ALL must pass for the trigger to fire. Ignored for 'manual' trigger. */
	triggerGuards?: ITriggerGuardConfig[];
	/** Token and cost budget for this workflow. No limit if omitted. */
	budget?: IWorkflowBudgetConfig;
	/** Monotonically incrementing version counter. Auto-incremented on save. */
	version?: number;
	/** Schema version for forward-compatibility checks. */
	schemaVersion?: number;
}

// ─── Execution State ──────────────────────────────────────────────────────────

export type AgentRunStatus =
	| 'queued'
	| 'planning'
	| 'running'
	| 'awaiting-tool'
	| 'awaiting-approval'
	| 'done'
	| 'failed'
	| 'cancelled';

export type StepRunStatus =
	| 'pending'
	| 'running'
	| 'done'
	| 'failed'
	| 'skipped'
	| 'branch-inactive'  // DAG path not taken via conditional branch
	| 'awaiting-approval'; // Paused waiting for human approval

/**
 * Live state of a single step within a running workflow.
 */
export interface IStepRun {
	stepId: string;
	agentId: string;
	role: string;
	status: StepRunStatus;
	startedAt?: number;
	endedAt?: number;
	/** Every tool call made by this step in order */
	toolCalls: IToolCallRecord[];
	/** Streaming output lines for live UI display */
	outputLog: string[];
	/** Final consolidated output passed to dependent steps */
	finalOutput?: string;
	error?: string;
	iterationsUsed: number;
	/** How many times this step has been retried (0 = no retries yet) */
	retryCount?: number;
	/** History of each retry attempt for debugging */
	retryHistory?: Array<{ attempt: number; error: string; retriedAt: number }>;
	/** Set when an approval gate is active ('before' timing) */
	approvalRequest?: {
		prompt: string;
		requestedAt: number;
		/** Present for 'after' timing — shows the step output to the approver */
		stepOutput?: string;
	};
	/** Set when the approver responds */
	approvalResponse?: {
		decision: 'approve' | 'reject';
		feedback?: string;
		respondedAt: number;
	};
	/** Token usage for this step (set when budget tracking is enabled) */
	tokenUsage?: {
		inputTokens: number;
		outputTokens: number;
	};
}

/**
 * Complete execution record for one workflow run.
 * Persisted after completion for the run history panel.
 */
export interface IAgentRun {
	/** Unique run ID — nanoid */
	id: string;
	workflowId: string;
	workflowName: string;
	status: AgentRunStatus;
	startedAt: number;
	endedAt?: number;
	steps: IStepRun[];
	/** Aggregated final output from the last completed step */
	finalOutput?: string;
	error?: string;
	triggerContext?: {
		kind: WorkflowTrigger;
		/** URI string of the file that triggered this run, if applicable */
		fileUri?: string;
	};
	/** Cumulative token usage for the entire run (set when budget tracking is enabled) */
	tokenUsage?: {
		inputTokens: number;
		outputTokens: number;
		estimatedCostUsd: number;
	};
}
