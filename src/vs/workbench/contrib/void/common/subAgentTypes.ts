/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Sub-Agent Types \u2014 Types for parallel sub-agent orchestration.
 *--------------------------------------------------------------------------------------*/

import { BuiltinToolName } from './toolsServiceTypes.js';

// ======================== Sub-Agent Roles ========================

export type SubAgentRole =
	| 'editor'
	| 'verifier'
	| 'compliance'
	| 'checks-agent'
	| 'power-mode'
	| 'debugger'
	| 'reviewer'
	| 'tester'
	| 'documenter'
	| 'architect'
	// CC-backed agents \u2014 fast, model-optimised roles powered by Power Mode's answerQueryWithAgent()
	| 'cc:explore'   // read-only fast search (haiku model)
	| 'cc:plan'      // architecture & planning (inherit model, read-only)
	| 'cc:general'   // general research & multi-step tasks (default model)
	| 'cc:verify';   // adversarial verification with bash (inherit model)

/**
 * Tool access scopes per sub-agent role.
 * - editor: read + edit tools (scoped to specific files)
 * - verifier: read + terminal tools (run tests/lint, report results)
 * - compliance: GRC tools + scan triggers + read-only code access + ask_checksagent
 * - checks-agent: Delegated to the Checks Agent service (full GRC agent loop with its own tools)
 * - power-mode: Delegated to the Power Mode service (full coding agent loop with bash/read/write/edit/glob/grep)
 * - debugger: bug hunting (read + grep + terminal + edit)
 * - reviewer: code review (read-only + grep, no write)
 * - tester: test writing (read + write + terminal)
 * - documenter: documentation (read + write + edit)
 * - architect: system design (read + grep + agent research)
 * - cc:explore/cc:plan/cc:general/cc:verify: CC-backed agents via answerQueryWithAgent() \u2014 tool scope enforced by Power Mode internally
 */
export const toolScopeOfRole: Record<SubAgentRole, readonly BuiltinToolName[]> = {
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
		// Sub-agent delegation: editor can spawn read-only explorers for research
		'spawn_agent',
		'get_agent_status',
		'wait_for_agent',
		'list_agents',
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
		// Sub-agent delegation: verifier can spawn explorers/compliance checkers
		'spawn_agent',
		'get_agent_status',
		'wait_for_agent',
		'list_agents',
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
	// Delegated roles \u2014 these spawn via their respective service's answerQuery() / sendMessage()
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
		// GRC Integration (regulated software compliance)
		'grc_violations',
		'grc_blocking_violations',
		'grc_impact_chain',
		'grc_rescan',
		// Audit trail
		'memory_write',
		'memory_read',
		// Research
		'web_fetch',
		// Sub-agent delegation: debugger can spawn explorers/compliance checkers
		'spawn_agent',
		'get_agent_status',
		'wait_for_agent',
		'list_agents',
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
		// GRC Tools (CRITICAL for regulated software review)
		'grc_violations',
		'grc_domain_summary',
		'grc_blocking_violations',
		'grc_framework_rules',
		'grc_impact_chain',
		'ask_checksagent',
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
		// GRC Integration (verify tests cover compliance rules)
		'grc_violations',
		'grc_framework_rules',
		'grc_rescan',
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
		// GRC Tools (document compliance requirements)
		'grc_framework_rules',
		'grc_domain_summary',
		'grc_violations',
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
		// GRC Tools (architectural impact analysis)
		'grc_impact_chain',
		'grc_domain_summary',
		'grc_framework_rules',
		// Audit trail
		'memory_write',
		'memory_read',
		// Status reporting
		'update_agent_status',
		'generate_document',
	],
	// CC-backed agents: tool scope is enforced by Power Mode's answerQueryWithAgent() internally.
	// These arrays are intentionally minimal \u2014 the actual permissions live in the service.
	'cc:explore': [
		'read_file',
		'ls_dir',
		'get_dir_tree',
		'search_pathnames_only',
		'search_for_files',
		'search_in_file',
		'update_agent_status',
	],
	'cc:plan': [
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
	'cc:general': [
		'read_file',
		'ls_dir',
		'get_dir_tree',
		'search_pathnames_only',
		'search_for_files',
		'search_in_file',
		'read_lint_errors',
		'query_ni_agent',
		'web_fetch',
		'update_agent_status',
		'generate_document',
	],
	'cc:verify': [
		'read_file',
		'ls_dir',
		'get_dir_tree',
		'search_pathnames_only',
		'search_for_files',
		'search_in_file',
		'read_lint_errors',
		'run_command',
		'run_persistent_command',
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
	compliance: {
		name: 'Compliance',
		description: 'GRC compliance checker',
		capabilities: ['Check violations', 'Scan frameworks', 'Analyze compliance', 'Query Checks Agent'],
		useCases: ['Compliance verification', 'GRC scanning', 'Policy enforcement'],
		systemPrompt: 'You are a compliance agent. Your role is to check GRC violations, analyze compliance with frameworks, and ensure regulatory requirements are met.',
	},
	'checks-agent': {
		name: 'Checks Agent',
		description: 'Full GRC agent with reasoning',
		capabilities: ['Full GRC toolset', 'AI reasoning', 'Compliance analysis'],
		useCases: ['Deep compliance analysis', 'Violation explanation', 'Framework guidance'],
		systemPrompt: 'You are the Checks Agent. You have full access to GRC tools and can perform deep compliance analysis with AI reasoning.',
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
		description: 'Specialized bug hunter and fixer with compliance verification',
		capabilities: ['Analyze stack traces', 'Reproduce bugs', 'Write fixes', 'Verify solutions', 'GRC compliance checks', 'Audit trail logging'],
		useCases: ['Fix runtime errors', 'Debug test failures', 'Resolve exceptions', 'Trace issues', 'Ensure fixes meet compliance'],
		systemPrompt: 'You are a debugging specialist for regulated software. Your role is to analyze bugs, reproduce errors, identify root causes, and implement compliant fixes. ALWAYS: 1) Run grc_rescan after fixes, 2) Check grc_blocking_violations before reporting success, 3) Use memory_write to log all changes, 4) Verify fixes with tests. Generate documentation of the fix with generate_document.',
	},
	reviewer: {
		name: 'Reviewer',
		description: 'Code review, security audit, and GRC compliance checker',
		capabilities: ['Code review', 'Security analysis', 'Best practices', 'Performance review', 'GRC compliance verification', 'Regulatory audit'],
		useCases: ['Review PRs', 'Security audit', 'Find code smells', 'Performance analysis', 'Compliance verification', 'Regulatory checks'],
		systemPrompt: 'You are a code reviewer for regulated and critical software. Your role is to review code for security vulnerabilities, code quality, best practices, performance issues, AND GRC compliance. You are READ-ONLY. ALWAYS: 1) Check grc_violations and grc_blocking_violations, 2) Use ask_checksagent for complex compliance questions, 3) Review grc_impact_chain for cross-file effects, 4) Use web_fetch to research CVEs and security best practices, 5) Log findings with memory_write, 6) Generate comprehensive review report with generate_document. Provide severity levels: CRITICAL (blocking violations), HIGH (security), MEDIUM (quality), LOW (style).',
	},
	tester: {
		name: 'Tester',
		description: 'Test writer, coverage analyzer, and compliance test validator',
		capabilities: ['Write unit tests', 'Write integration tests', 'Coverage analysis', 'Edge case testing', 'Compliance test validation', 'Regulatory requirement testing'],
		useCases: ['Increase test coverage', 'Write missing tests', 'Test new features', 'Edge case coverage', 'Verify compliance rules are tested', 'Validate regulatory requirements'],
		systemPrompt: 'You are a test engineer for regulated software. Your role is to write comprehensive tests that catch bugs AND verify compliance. ALWAYS: 1) Check grc_framework_rules to identify what must be tested, 2) Verify tests cover compliance rules with grc_violations, 3) Run grc_rescan after adding tests, 4) Log test coverage with memory_write, 5) Run tests to verify they work, 6) Generate test report with generate_document. Write clear, maintainable tests. Focus on regulatory requirements and edge cases.',
	},
	documenter: {
		name: 'Documenter',
		description: 'Technical documentation and compliance documentation writer',
		capabilities: ['Write API docs', 'Update README', 'Code comments', 'Tutorial creation', 'Compliance documentation', 'Regulatory requirement docs'],
		useCases: ['Document APIs', 'Update docs', 'Write guides', 'Create tutorials', 'Document compliance requirements', 'Regulatory documentation'],
		systemPrompt: 'You are a technical writer for regulated software. Your role is to create clear, comprehensive documentation that includes compliance information. ALWAYS: 1) Use grc_framework_rules to understand what must be documented, 2) Document compliance requirements with grc_domain_summary, 3) Include regulatory context in documentation, 4) Log documentation changes with memory_write, 5) Use web_fetch for best practices research, 6) Generate final documentation with generate_document. Focus on clarity, completeness, and regulatory traceability.',
	},
	architect: {
		name: 'Architect',
		description: 'System designer and planner with compliance impact analysis',
		capabilities: ['Architecture design', 'Dependency analysis', 'Design patterns', 'Refactoring plans', 'Compliance impact analysis', 'Cross-domain assessment'],
		useCases: ['Design systems', 'Plan refactoring', 'Analyze dependencies', 'Propose patterns', 'Assess compliance impact', 'Cross-file dependency analysis'],
		systemPrompt: 'You are a software architect for regulated systems. Your role is to analyze system design, propose architectural improvements, and assess compliance impact. You are READ-ONLY. ALWAYS: 1) Use grc_impact_chain to analyze cross-file dependencies and compliance effects, 2) Review grc_domain_summary for compliance domains affected, 3) Check grc_framework_rules for architectural constraints, 4) Use query_ni_agent for research, 5) Use web_fetch for design pattern research, 6) Log findings with memory_write, 7) Generate architectural proposal with generate_document. Think holistically about the system AND its regulatory requirements.',
	},
	// \u2500\u2500 CC-backed agent roles \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	'cc:explore': {
		name: 'CC Explore',
		description: 'Fast read-only codebase search agent (haiku model for speed)',
		capabilities: ['Glob patterns', 'Regex search', 'File reading', 'Parallel queries'],
		useCases: ['Find files by pattern', 'Search for keywords', 'Understand code paths', 'Locate dependencies'],
		systemPrompt: '', // injected by answerQueryWithAgent() via CC explore system prompt
	},
	'cc:plan': {
		name: 'CC Plan',
		description: 'Software architect agent for designing implementation plans (read-only)',
		capabilities: ['Architecture design', 'Codebase exploration', 'Step-by-step plans', 'Critical file identification'],
		useCases: ['Plan a feature', 'Design a refactor', 'Identify critical files', 'Assess architectural trade-offs'],
		systemPrompt: '', // injected by answerQueryWithAgent() via CC plan system prompt
	},
	'cc:general': {
		name: 'CC General',
		description: 'General-purpose research agent for complex multi-step tasks',
		capabilities: ['Deep research', 'Multi-step tasks', 'Code search', 'Analysis'],
		useCases: ['Research complex questions', 'Explore unfamiliar code areas', 'Multi-file analysis'],
		systemPrompt: '', // injected by answerQueryWithAgent() via CC general-purpose system prompt
	},
	'cc:verify': {
		name: 'CC Verify',
		description: 'Adversarial verification agent \u2014 runs builds, tests, and tries to break things',
		capabilities: ['Build verification', 'Test execution', 'Adversarial probing', 'Regression checks'],
		useCases: ['Verify a fix works', 'Run test suite after changes', 'Find edge-case failures', 'Confirm PASS/FAIL verdict'],
		systemPrompt: '', // injected by answerQueryWithAgent() via CC verification system prompt
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
