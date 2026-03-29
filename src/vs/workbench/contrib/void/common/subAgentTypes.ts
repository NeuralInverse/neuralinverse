/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Sub-Agent Types — Types for parallel sub-agent orchestration.
 *--------------------------------------------------------------------------------------*/

import { BuiltinToolName } from './toolsServiceTypes.js';

// ======================== Sub-Agent Roles ========================

export type SubAgentRole =
	| 'explorer'
	| 'editor'
	| 'verifier'
	| 'power-mode'
	| 'debugger'
	| 'reviewer'
	| 'tester'
	| 'documenter'
	| 'architect';

/**
 * Tool access scopes per sub-agent role.
 * - explorer: read-only tools (cannot edit files or run commands)
 * - editor: read + edit tools (scoped to specific files)
 * - verifier: read + terminal tools (run tests/lint, report results)
 * - power-mode: Delegated to the Power Mode service (full coding agent loop with bash/read/write/edit/glob/grep)
 * - debugger: bug hunting (read + grep + terminal + edit)
 * - reviewer: code review (read-only + grep, no write)
 * - tester: test writing (read + write + terminal)
 * - documenter: documentation (read + write + edit)
 * - architect: system design (read + grep + agent research)
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
	debugger: [
		// Read access
		'read_file',
		'ls_dir',
		'get_dir_tree',
		'search_pathnames_only',
		'search_for_files',
		'search_in_file',
		'read_lint_errors',
		// Edit access (for fixes)
		'edit_file',
		'rewrite_file',
		'multi_replace_file_content',
		'create_file_or_folder',
		'delete_file_or_folder',
		// Terminal access (reproduce bugs, run tests)
		'read_terminal',
		'run_command',
		'run_persistent_command',
		'open_persistent_terminal',
		'send_command_input',
		'kill_persistent_terminal',
		// Audit trail
		'memory_write',
		'memory_read',
		// Research
		'web_fetch',
		// Status reporting
		'update_agent_status',
		'generate_document',
	],
	reviewer: [
		// Read-only access (no write!)
		'read_file',
		'ls_dir',
		'get_dir_tree',
		'search_pathnames_only',
		'search_for_files',
		'search_in_file',
		'read_lint_errors',
		// Research (CVE lookups, best practices)
		'web_fetch',
		// Audit trail
		'memory_write',
		'memory_read',
		// Status reporting
		'update_agent_status',
		'generate_document',
	],
	tester: [
		// Read access
		'read_file',
		'ls_dir',
		'get_dir_tree',
		'search_pathnames_only',
		'search_for_files',
		'search_in_file',
		'read_lint_errors',
		// Write access (create test files)
		'edit_file',
		'rewrite_file',
		'multi_replace_file_content',
		'create_file_or_folder',
		'delete_file_or_folder',
		// Terminal access (run tests)
		'read_terminal',
		'run_command',
		'run_persistent_command',
		'open_persistent_terminal',
		'send_command_input',
		'kill_persistent_terminal',
		// Audit trail (log test coverage)
		'memory_write',
		'memory_read',
		// Status reporting
		'update_agent_status',
		'generate_document',
	],
	documenter: [
		// Read access
		'read_file',
		'ls_dir',
		'get_dir_tree',
		'search_pathnames_only',
		'search_for_files',
		'search_in_file',
		'read_lint_errors',
		// Write access (create/update docs)
		'edit_file',
		'rewrite_file',
		'multi_replace_file_content',
		'create_file_or_folder',
		// Research (best practices)
		'web_fetch',
		// Audit trail (track documentation changes)
		'memory_write',
		'memory_read',
		// Status reporting
		'update_agent_status',
		'generate_document',
	],
	architect: [
		// Read access
		'read_file',
		'ls_dir',
		'get_dir_tree',
		'search_pathnames_only',
		'search_for_files',
		'search_in_file',
		'read_lint_errors',
		// Research capability
		'query_ni_agent',
		'web_fetch',
		// Audit trail
		'memory_write',
		'memory_read',
		// Status reporting
		'update_agent_status',
		'generate_document',
	],
} as const;


// ======================== Sub-Agent Role Metadata ========================

export interface SubAgentRoleMetadata {
	name: string;
	description: string;
	capabilities: string[];
	useCases: string[];
	systemPrompt: string;
}

export const subAgentRoleMetadata: Record<SubAgentRole, SubAgentRoleMetadata> = {
	explorer: {
		name: 'Explorer',
		description: 'Read-only codebase explorer for research and discovery',
		capabilities: ['Search codebase', 'Read files', 'Analyze structure'],
		useCases: ['Find relevant code', 'Understand architecture', 'Locate dependencies'],
		systemPrompt: 'You are a codebase explorer. Your role is to search, read, and analyze code to help understand the project structure and locate relevant files. You cannot modify code.',
	},
	editor: {
		name: 'Editor',
		description: 'Targeted code editor for scoped modifications',
		capabilities: ['Read files', 'Edit code', 'Rewrite files', 'Multi-replace'],
		useCases: ['Fix bugs', 'Implement features', 'Refactor code'],
		systemPrompt: 'You are a code editor. Your role is to make precise, targeted modifications to code files. Focus on the specific files and changes requested.',
	},
	verifier: {
		name: 'Verifier',
		description: 'Test runner and validator',
		capabilities: ['Run tests', 'Run lint', 'Execute commands', 'Validate changes'],
		useCases: ['Verify fixes work', 'Run test suites', 'Check code quality'],
		systemPrompt: 'You are a verification agent. Your role is to run tests, lint checks, and other validation commands to ensure code quality and correctness.',
	},
	'power-mode': {
		name: 'Power Mode',
		description: 'Full coding agent with bash access',
		capabilities: ['Read/write/edit', 'Bash commands', 'Full tool access'],
		useCases: ['Complex tasks', 'Multi-step operations', 'System-level changes'],
		systemPrompt: 'You are a Power Mode agent with full coding capabilities. You can read, write, edit files and run bash commands.',
	},
	debugger: {
		name: 'Debugger',
		description: 'Specialized bug hunter and fixer',
		capabilities: ['Analyze stack traces', 'Reproduce bugs', 'Write fixes', 'Verify solutions', 'Audit trail logging'],
		useCases: ['Fix runtime errors', 'Debug test failures', 'Resolve exceptions', 'Trace issues'],
		systemPrompt: 'You are a debugging specialist. Your role is to analyze bugs, reproduce errors, identify root causes, and implement fixes. ALWAYS: 1) Use memory_write to log all changes, 2) Verify fixes with tests, 3) Generate documentation of the fix with generate_document.',
	},
	reviewer: {
		name: 'Reviewer',
		description: 'Code review and security audit',
		capabilities: ['Code review', 'Security analysis', 'Best practices', 'Performance review'],
		useCases: ['Review PRs', 'Security audit', 'Find code smells', 'Performance analysis'],
		systemPrompt: 'You are a code reviewer. Your role is to review code for security vulnerabilities, code quality, best practices, and performance issues. You are READ-ONLY. ALWAYS: 1) Use web_fetch to research CVEs and security best practices, 2) Log findings with memory_write, 3) Generate comprehensive review report with generate_document. Provide severity levels: CRITICAL, HIGH (security), MEDIUM (quality), LOW (style).',
	},
	tester: {
		name: 'Tester',
		description: 'Test writer and coverage analyzer',
		capabilities: ['Write unit tests', 'Write integration tests', 'Coverage analysis', 'Edge case testing'],
		useCases: ['Increase test coverage', 'Write missing tests', 'Test new features', 'Edge case coverage'],
		systemPrompt: 'You are a test engineer. Your role is to write comprehensive tests that catch bugs. ALWAYS: 1) Log test coverage with memory_write, 2) Run tests to verify they work, 3) Generate test report with generate_document. Write clear, maintainable tests focusing on edge cases.',
	},
	documenter: {
		name: 'Documenter',
		description: 'Technical documentation writer',
		capabilities: ['Write API docs', 'Update README', 'Code comments', 'Tutorial creation'],
		useCases: ['Document APIs', 'Update docs', 'Write guides', 'Create tutorials'],
		systemPrompt: 'You are a technical writer. Your role is to create clear, comprehensive documentation. ALWAYS: 1) Log documentation changes with memory_write, 2) Use web_fetch for best practices research, 3) Generate final documentation with generate_document. Focus on clarity and completeness.',
	},
	architect: {
		name: 'Architect',
		description: 'System designer and planner',
		capabilities: ['Architecture design', 'Dependency analysis', 'Design patterns', 'Refactoring plans'],
		useCases: ['Design systems', 'Plan refactoring', 'Analyze dependencies', 'Propose patterns'],
		systemPrompt: 'You are a software architect. Your role is to analyze system design and propose architectural improvements. You are READ-ONLY. ALWAYS: 1) Use query_ni_agent for research, 2) Use web_fetch for design pattern research, 3) Log findings with memory_write, 4) Generate architectural proposal with generate_document.',
	},
};

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
