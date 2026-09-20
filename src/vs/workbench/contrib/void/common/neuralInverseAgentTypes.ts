/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Neural Inverse Agent Types — Core types for the agentic execution engine.
 *--------------------------------------------------------------------------------------*/

import { BuiltinToolName, ToolName } from './toolsServiceTypes.js';

// ======================== Risk Classification ========================

export type ToolRiskLevel = 'safe' | 'moderate' | 'destructive';

/**
 * Static risk classification for built-in tools.
 * - safe: read-only operations, auto-approved always
 * - moderate: file edits, notify user but execute
 * - destructive: terminal commands, deletions, require confirmation
 */
export const toolRiskLevels: Record<BuiltinToolName, ToolRiskLevel> = {
	// safe — read-only, no side effects
	'read_file': 'safe',
	'ls_dir': 'safe',
	'get_dir_tree': 'safe',
	'search_pathnames_only': 'safe',
	'search_for_files': 'safe',
	'search_in_file': 'safe',
	'read_lint_errors': 'safe',
	'read_terminal': 'safe',
	'update_agent_status': 'safe',
	'generate_document': 'safe',

	// moderate — file mutations, reversible via checkpoint
	'edit_file': 'moderate',
	'rewrite_file': 'moderate',
	'multi_replace_file_content': 'moderate',
	'create_file_or_folder': 'moderate',

	// destructive — terminal, deletion, hard to reverse
	'delete_file_or_folder': 'destructive',
	'run_command': 'destructive',
	'run_background_command': 'destructive',
	'run_persistent_command': 'destructive',
	'open_persistent_terminal': 'destructive',
	'send_command_input': 'destructive',
	'kill_persistent_terminal': 'destructive',

	// Power Mode style tools
	'bash': 'destructive',
	'read': 'safe',
	'write': 'moderate',
	'edit': 'moderate',
	'glob': 'safe',
	'grep': 'safe',
	'list': 'safe',

	// Context Engine tools (read-only, no side effects)
	'context_search_symbols': 'safe',
	'context_related_files': 'safe',
	'context_file_context': 'safe',
	'context_import_graph': 'safe',
	'context_recent_edits': 'safe',
	'context_semantic_search': 'safe',
	'ask_powermode': 'safe',
	'query_ni_agent': 'safe',

	// Workflow tools
	'ask_user': 'safe',
	'web_fetch': 'moderate',
	'memory_read': 'safe',
	'memory_write': 'moderate',
	'tasks_create': 'moderate',
	'tasks_list': 'safe',
	'tasks_update': 'moderate',
	'tasks_get': 'safe',

	// Sub-agent orchestration
	'spawn_agent': 'moderate',
	'get_agent_status': 'safe',
	'wait_for_agent': 'safe',
	'list_agents': 'safe',
	'plan_mode_enter': 'safe',
	'plan_mode_exit': 'safe',
	'todo_write': 'safe',
};

export const getRiskLevel = (toolName: ToolName): ToolRiskLevel => {
	if (Object.prototype.hasOwnProperty.call(toolRiskLevels, toolName)) {
		return toolRiskLevels[toolName as BuiltinToolName];
	}
	return 'destructive'; // MCP/unknown tools default to destructive
};


// ======================== Agent Task ========================

export type AgentTaskStatus =
	| 'planning'
	| 'executing'
	| 'paused'
	| 'awaiting_approval'
	| 'completed'
	| 'failed'
	| 'cancelled';

export type AgentStepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'error';

export interface AgentStep {
	id: string;
	description: string;
	status: AgentStepStatus;
	toolsUsed: ToolName[];
	result?: string;
	error?: string;
	startedAt?: string;
	completedAt?: string;
}

export interface AgentAction {
	timestamp: string;
	type: 'tool_call' | 'llm_response' | 'error' | 'user_approval' | 'status_update';
	toolName?: ToolName;
	summary: string;
	durationMs?: number;
}

export interface AgentTask {
	id: string;
	goal: string;
	status: AgentTaskStatus;
	steps: AgentStep[];
	executionLog: AgentAction[];
	createdAt: string;
	updatedAt: string;
	threadId: string; // links to the chat thread driving this task
	iteration: number;
	maxIterations: number;

	// Accumulated context
	filesRead: Set<string>;
	filesModified: Set<string>;

	// Metrics
	totalToolCalls: number;
	totalLLMCalls: number;
	totalErrors: number;

	// Autonomy extensions
	subtasks: AgentSubtask[];
	scratchpad: AgentScratchpad;
	replans: ReplanRecord[];
	complexity: TaskComplexity;
}


// ======================== Approval Tiers ========================

export type ApprovalTier = 'auto' | 'notify' | 'confirm';

export interface ApprovalTierConfig {
	[toolName: string]: ApprovalTier | undefined;
}

/**
 * Default approval tier mapping.
 * Users/enterprise can override via settings.
 */
export const defaultApprovalTiers: Record<BuiltinToolName, ApprovalTier> = {
	// auto — execute immediately
	'read_file': 'auto',
	'ls_dir': 'auto',
	'get_dir_tree': 'auto',
	'search_pathnames_only': 'auto',
	'search_for_files': 'auto',
	'search_in_file': 'auto',
	'read_lint_errors': 'auto',
	'read_terminal': 'auto',
	'update_agent_status': 'auto',
	'generate_document': 'auto',

	// notify — execute + show notification
	'edit_file': 'notify',
	'rewrite_file': 'notify',
	'multi_replace_file_content': 'notify',
	'create_file_or_folder': 'notify',

	// confirm — require explicit approval
	'delete_file_or_folder': 'confirm',
	'run_command': 'confirm',
	'run_background_command': 'confirm',
	'run_persistent_command': 'confirm',
	'open_persistent_terminal': 'confirm',
	'send_command_input': 'confirm',
	'kill_persistent_terminal': 'confirm',

	// Power Mode style tools
	'bash': 'confirm',
	'read': 'auto',
	'write': 'notify',
	'edit': 'notify',
	'glob': 'auto',
	'grep': 'auto',
	'list': 'auto',

	// Context Engine tools
	'context_search_symbols': 'auto',
	'context_related_files': 'auto',
	'context_file_context': 'auto',
	'context_import_graph': 'auto',
	'context_recent_edits': 'auto',
	'context_semantic_search': 'auto',
	'ask_powermode': 'auto',
	'query_ni_agent': 'auto',

	// Workflow tools
	'ask_user': 'auto',
	'web_fetch': 'auto',
	'memory_read': 'auto',
	'memory_write': 'notify',
	'tasks_create': 'notify',
	'tasks_list': 'auto',
	'tasks_update': 'notify',
	'tasks_get': 'auto',
	'spawn_agent': 'auto',
	'get_agent_status': 'auto',
	'wait_for_agent': 'auto',
	'list_agents': 'auto',
	'plan_mode_enter': 'auto',
	'plan_mode_exit': 'auto',
	'todo_write': 'auto',
};


// ======================== Agent Loop Configuration ========================

export const AGENT_MAX_ITERATIONS = 50;
export const AGENT_MAX_CONSECUTIVE_ERRORS = 3; // triggers replan instead of hard fail
export const AGENT_MAX_REPLANS = 3; // hard-fail after this many replans on same error class
export const AGENT_IDLE_TIMEOUT_MS = 300_000; // 5 minutes
export const AGENT_STEP_COOLDOWN_MS = 200; // small delay between steps for UI breathing room

// Adaptive iteration budgets based on task complexity
export const AGENT_ITERATION_BUDGET = {
	simple: 15,
	medium: 30,
	complex: 50,
} as const;

export type TaskComplexity = keyof typeof AGENT_ITERATION_BUDGET;


// ======================== Agent Events ========================

export type AgentEventType =
	| 'task_created'
	| 'task_updated'
	| 'step_started'
	| 'step_completed'
	| 'step_error'
	| 'tool_auto_approved'
	| 'tool_notify'
	| 'tool_awaiting_confirm'
	| 'task_completed'
	| 'task_failed'
	| 'task_paused'
	| 'task_cancelled'
	| 'grc_violation_detected';

export interface AgentEvent {
	type: AgentEventType;
	taskId: string;
	timestamp: string;
	data?: Record<string, unknown>;
}


// ======================== Agent Context (Working Memory) ========================

export interface AgentContextEntry {
	type: 'file_read' | 'file_edit' | 'terminal_output' | 'search_result' | 'error' | 'user_feedback' | 'observation';
	summary: string;
	timestamp: string;
	/** Weight for context budget (higher = keep longer) */
	importance: number;
}

export interface AgentWorkingMemory {
	entries: AgentContextEntry[];
	projectMap?: string; // lightweight project structure summary
	/** Token budget tracking */
	estimatedTokens: number;
	maxTokenBudget: number;
}

export const AGENT_CONTEXT_MAX_TOKENS = 32_000;


// ======================== Scratchpad (Reasoning Trace) ========================

export type ScratchpadEntryType = 'observation' | 'hypothesis' | 'decision' | 'error' | 'replan';

export interface ScratchpadEntry {
	type: ScratchpadEntryType;
	content: string;
	timestamp: string;
	/** Higher importance entries survive pruning longer */
	importance: number;
}

export interface AgentScratchpad {
	entries: ScratchpadEntry[];
	estimatedTokens: number;
	maxTokenBudget: number;
}

export const SCRATCHPAD_MAX_TOKENS = 8_000;


// ======================== Subtask Decomposition ========================

export type SubtaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export interface AgentSubtask {
	id: string;
	goal: string;
	status: SubtaskStatus;
	complexity: TaskComplexity;
	dependencies: string[]; // IDs of subtasks that must complete first
	iterationBudget: number;
	iterationsUsed: number;
	result?: string;
	error?: string;
}


// ======================== Replan State ========================

export interface ReplanRecord {
	errorClass: string;
	errorMessage: string;
	replanCount: number;
	lastReplanAt: string;
	correctionStrategy: string;
}
