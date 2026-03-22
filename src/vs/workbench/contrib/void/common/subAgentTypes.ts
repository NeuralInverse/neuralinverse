/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Sub-Agent Types — Types for parallel sub-agent orchestration.
 *--------------------------------------------------------------------------------------*/

import { BuiltinToolName } from './toolsServiceTypes.js';

// ======================== Sub-Agent Roles ========================

export type SubAgentRole = 'explorer' | 'editor' | 'verifier' | 'compliance' | 'checks-agent' | 'power-mode';

/**
 * Tool access scopes per sub-agent role.
 * - explorer: read-only tools (cannot edit files or run commands)
 * - editor: read + edit tools (scoped to specific files)
 * - verifier: read + terminal tools (run tests/lint, report results)
 * - compliance: GRC tools + scan triggers + read-only code access + ask_checksagent
 * - checks-agent: Delegated to the Checks Agent service (full GRC agent loop with its own tools)
 * - power-mode: Delegated to the Power Mode service (full coding agent loop with bash/read/write/edit/glob/grep)
 */
export const toolScopeOfRole: Record<SubAgentRole, readonly BuiltinToolName[]> = {
	explorer: [
		'read_file',
		'ls_dir',
		'get_dir_tree',
		'search_pathnames_only',
		'search_for_files',
		'search_in_file',
		'read_lint_errors',
		'update_agent_status',
		'generate_document',
	],
	editor: [
		'read_file',
		'ls_dir',
		'get_dir_tree',
		'search_pathnames_only',
		'search_for_files',
		'search_in_file',
		'read_lint_errors',
		'edit_file',
		'rewrite_file',
		'multi_replace_file_content',
		'create_file_or_folder',
		'update_agent_status',
		'generate_document',
	],
	verifier: [
		'read_file',
		'ls_dir',
		'get_dir_tree',
		'search_pathnames_only',
		'search_for_files',
		'search_in_file',
		'read_lint_errors',
		'read_terminal',
		'run_command',
		'run_persistent_command',
		'open_persistent_terminal',
		'send_command_input',
		'kill_persistent_terminal',
		'query_ni_agent',
		'update_agent_status',
		'generate_document',
	],
	compliance: [
		// Read-only code access
		'read_file',
		'ls_dir',
		'get_dir_tree',
		'search_pathnames_only',
		'search_for_files',
		'search_in_file',
		'read_lint_errors',
		// All GRC tools
		'grc_violations',
		'grc_domain_summary',
		'grc_blocking_violations',
		'grc_framework_rules',
		'grc_impact_chain',
		'grc_rescan',
		'grc_ai_scan',
		// Checks Agent reasoning
		'ask_checksagent',
		// Status reporting
		'update_agent_status',
		'generate_document',
	],
	// Delegated roles — these spawn via their respective service's answerQuery() / sendMessage()
	// Tool scope is the bridge tool only; the service runs its own internal tool loop
	'checks-agent': [
		'ask_checksagent',
		'grc_violations',
		'grc_domain_summary',
		'grc_blocking_violations',
		'grc_framework_rules',
		'grc_impact_chain',
		'grc_rescan',
		'grc_ai_scan',
		'update_agent_status',
	],
	'power-mode': [
		'ask_powermode',
		'query_ni_agent',
		'read_file',
		'ls_dir',
		'get_dir_tree',
		'search_pathnames_only',
		'search_for_files',
		'search_in_file',
		'run_command',
		'run_persistent_command',
		'update_agent_status',
	],
} as const;


// ======================== Sub-Agent Instance ========================

export type SubAgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface SubAgentTask {
	id: string;
	parentTaskId: string;
	role: SubAgentRole;
	goal: string;
	status: SubAgentStatus;
	threadId: string; // dedicated chat thread for this sub-agent
	result?: string;
	error?: string;
	createdAt: string;
	completedAt?: string;

	/** Files this sub-agent is scoped to (editor role) */
	scopedFiles?: string[];
}


// ======================== Sub-Agent Orchestration ========================

export const MAX_CONCURRENT_SUB_AGENTS = 5;

/**
 * Parent context for sub-agents - can be either:
 * - Agent mode task (from INeuralInverseAgentService)
 * - Power Mode session (from IPowerModeService)
 */
export interface SubAgentParentContext {
	id: string;
	type: 'agent-task' | 'power-session';
}

export interface SubAgentSpawnRequest {
	role: SubAgentRole;
	goal: string;
	/** Optional: scope editor sub-agents to specific files */
	scopedFiles?: string[];
	/** Optional: explicit parent context (for Power Mode integration) */
	parentContext?: SubAgentParentContext;
}
