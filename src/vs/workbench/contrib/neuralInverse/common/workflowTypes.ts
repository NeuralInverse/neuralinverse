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
 * Reading from .inverse/ \u2192 IFileService.readFile() directly (no unlock needed).
 * Writing to  .inverse/ \u2192 must wrap with withInverseWriteAccess() from inverseFs.ts.
 */

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkingCopyHistoryService } from '../../../services/workingCopy/common/workingCopyHistory.js';

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
	/** For recording Timeline entries when the agent writes files */
	historyService?: IWorkingCopyHistoryService;
	/** Append a line to the current step's output log */
	log: (msg: string) => void;
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
	 * - 'success'  \u2192 fire when exit code === 0
	 * - 'failure'  \u2192 fire when exit code !== 0  (default — use agents to fix it)
	 * - 'any'      \u2192 fire regardless of exit code
	 */
	triggerOnExit?: 'success' | 'failure' | 'any';

	/** Ordered steps. Steps with no dependsOn may run in parallel */
	steps: IWorkflowStep[];
	/** What internal tool this workflow replaces, e.g. "Makefile:scaffold" */
	replaces?: string;
	/** Whether this workflow is currently enabled */
	enabled: boolean;
}

// ─── Execution State ──────────────────────────────────────────────────────────

export type AgentRunStatus =
	| 'queued'
	| 'planning'
	| 'running'
	| 'awaiting-tool'
	| 'done'
	| 'failed'
	| 'cancelled';

export type StepRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

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
}
