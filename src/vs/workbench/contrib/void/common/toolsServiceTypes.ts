import { URI } from '../../../../base/common/uri.js'
import { RawMCPToolCall } from './mcpServiceTypes.js';

import { RawToolParamsObj } from './sendLLMMessageTypes.js';



export type TerminalResolveReason = { type: 'timeout' } | { type: 'done', exitCode: number }

export type LintErrorItem = { code: string, message: string, startLineNumber: number, endLineNumber: number }

// Partial of IFileStat
export type ShallowDirectoryItem = {
	uri: URI;
	name: string;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}


export const approvalTypeOfBuiltinToolName: Partial<{ [T in BuiltinToolName]?: 'edits' | 'terminal' | 'MCP tools' }> = {
	'create_file_or_folder': 'edits',
	'delete_file_or_folder': 'edits',
	'rewrite_file': 'edits',
	'edit_file': 'edits',
	'multi_replace_file_content': 'edits',
	'run_command': 'terminal',
	'run_persistent_command': 'terminal',
	'open_persistent_terminal': 'terminal',
	'read_terminal': 'terminal',
	'send_command_input': 'terminal',
	'kill_persistent_terminal': 'terminal',
	// Power Mode style tools
	'bash': 'terminal',
	'write': 'edits',
	'edit': 'edits',
}


export type ToolApprovalType = NonNullable<(typeof approvalTypeOfBuiltinToolName)[keyof typeof approvalTypeOfBuiltinToolName]>;


export const toolApprovalTypes = new Set<ToolApprovalType>([
	...Object.values(approvalTypeOfBuiltinToolName),
	'MCP tools',
])




// PARAMS OF TOOL CALL
export type BuiltinToolCallParams = {
	// --- Power Mode style tools ---
	'bash': { command: string, description: string, timeout: number | null },
	'read': { filePath: string, offset: number | null, limit: number | null },
	'write': { filePath: string, content: string },
	'edit': { filePath: string, oldString: string, newString: string },
	'glob': { pattern: string, path: string | null },
	'grep': { pattern: string, path: string | null, include: string | null },
	'list': { dirPath: string | null },
	'ask_powermode': { question: string },
	// --- GRC compliance ---
	'grc_violations': { domain: string | null, severity: string | null, file: string | null, limit: number },
	'grc_domain_summary': {},
	'grc_blocking_violations': {},
	'grc_framework_rules': { frameworkId: string | null, domain: string | null },
	'grc_impact_chain': { file: string, maxDepth: number },
	'grc_rescan': {},
	'grc_ai_scan': { files: string | null },
	'ask_checksagent': { question: string },
	'query_ni_agent': { agentId: string, input: string },
	// --- Workflow tools ---
	'ask_user': { question: string },
	'web_fetch': { url: string, description: string },
	'memory_write': { key: string, content: string },
	'memory_read': { key: string },
	'tasks_create': { title: string, description: string | null },
	'tasks_list': {},
	'tasks_update': { taskId: string, status: string | null, title: string | null, description: string | null },
	'tasks_get': { taskId: string },
	// --- Sub-agent orchestration ---
	'spawn_agent': { role: string, goal: string, scopedFiles: string | null },
	'get_agent_status': { agentId: string },
	'wait_for_agent': { agentId: string },
	'list_agents': {},
	// ---
	'read_file': { uri: URI, startLine: number | null, endLine: number | null, pageNumber: number },
	'ls_dir': { uri: URI, pageNumber: number },
	'get_dir_tree': { uri: URI },
	'search_pathnames_only': { query: string, includePattern: string | null, pageNumber: number },
	'search_for_files': { query: string, isRegex: boolean, searchInFolder: URI | null, pageNumber: number },
	'search_in_file': { uri: URI, query: string, isRegex: boolean },
	'read_lint_errors': { uri: URI },
	// ---
	'rewrite_file': { uri: URI, newContent: string },
	'edit_file': { uri: URI, searchReplaceBlocks: string },
	'multi_replace_file_content': { uri: URI, replacementChunks: string },
	'create_file_or_folder': { uri: URI, isFolder: boolean },
	'delete_file_or_folder': { uri: URI, isRecursive: boolean, isFolder: boolean },
	// ---
	'run_command': { command: string; cwd: string | null, terminalId: string },
	'run_persistent_command': { command: string; persistentTerminalId: string },
	'open_persistent_terminal': { cwd: string | null },
	'read_terminal': { persistentTerminalId: string },
	'send_command_input': { persistentTerminalId: string, input: string },
	'kill_persistent_terminal': { persistentTerminalId: string },
	'update_agent_status': { taskName: string, taskSummary: string, taskStatus: string },
	'generate_document': { title: string, content: string },
}

// RESULT OF TOOL CALL
export type BuiltinToolResultType = {
	// --- Power Mode style tools ---
	'bash': { result: string },
	'read': { result: string },
	'write': { result: string },
	'edit': { result: string },
	'glob': { result: string },
	'grep': { result: string },
	'list': { result: string },
	'ask_powermode': { result: string },
	// --- GRC compliance ---
	'grc_violations': { result: string },
	'grc_domain_summary': { result: string },
	'grc_blocking_violations': { result: string },
	'grc_framework_rules': { result: string },
	'grc_impact_chain': { result: string },
	'grc_rescan': { result: string },
	'grc_ai_scan': { result: string },
	'ask_checksagent': { result: string },
	'query_ni_agent': { result: string },
	// --- Workflow tools ---
	'ask_user': { result: string },
	'web_fetch': { result: string },
	'memory_write': { result: string },
	'memory_read': { result: string },
	'tasks_create': { result: string },
	'tasks_list': { result: string },
	'tasks_update': { result: string },
	'tasks_get': { result: string },
	// --- Sub-agent orchestration ---
	'spawn_agent': { result: string },
	'get_agent_status': { result: string },
	'wait_for_agent': { result: string },
	'list_agents': { result: string },
	// ---
	'read_file': { fileContents: string, totalFileLen: number, totalNumLines: number, hasNextPage: boolean },
	'ls_dir': { children: ShallowDirectoryItem[] | null, hasNextPage: boolean, hasPrevPage: boolean, itemsRemaining: number },
	'get_dir_tree': { str: string, },
	'search_pathnames_only': { uris: URI[], hasNextPage: boolean },
	'search_for_files': { uris: URI[], hasNextPage: boolean },
	'search_in_file': { lines: number[]; },
	'read_lint_errors': { lintErrors: LintErrorItem[] | null },
	// ---
	'rewrite_file': Promise<{ lintErrors: LintErrorItem[] | null }>,
	'edit_file': Promise<{ lintErrors: LintErrorItem[] | null }>,
	'multi_replace_file_content': Promise<{ lintErrors: LintErrorItem[] | null }>,
	'create_file_or_folder': {},
	'delete_file_or_folder': {},
	// ---
	'run_command': { result: string; resolveReason: TerminalResolveReason; },
	'run_persistent_command': { result: string; resolveReason: TerminalResolveReason; },
	'open_persistent_terminal': { persistentTerminalId: string },
	'read_terminal': { result: string },
	'send_command_input': { result: string },
	'kill_persistent_terminal': {},
	'update_agent_status': { result: string },
	'generate_document': { result: string, fileUri?: import('../../../../base/common/uri.js').UriComponents },
}


export type ToolCallParams<T extends BuiltinToolName | (string & {})> = T extends BuiltinToolName ? BuiltinToolCallParams[T] : RawToolParamsObj
export type ToolResult<T extends BuiltinToolName | (string & {})> = T extends BuiltinToolName ? BuiltinToolResultType[T] : RawMCPToolCall

export type BuiltinToolName = keyof BuiltinToolResultType


export type SnakeCase<S extends string> =
	// exact acronym URI
	S extends 'URI' ? 'uri'
	// suffix URI: e.g. 'rootURI' -> snakeCase('root') + '_uri'
	: S extends `${infer Prefix}URI` ? `${SnakeCase<Prefix>}_uri`
	// default: for each char, prefix '_' on uppercase letters
	: S extends `${infer C}${infer Rest}`
	? `${C extends Lowercase<C> ? C : `_${Lowercase<C>}`}${SnakeCase<Rest>}`
	: S;

export type SnakeCaseKeys<T extends Record<string, any>> = {
	[K in keyof T as SnakeCase<Extract<K, string>>]: T[K]
};

type BuiltinToolParamNameOfTool<T extends BuiltinToolName> = keyof SnakeCaseKeys<BuiltinToolCallParams[T]>
export type BuiltinToolParamName = { [T in BuiltinToolName]: BuiltinToolParamNameOfTool<T> }[BuiltinToolName]


export type ToolName = BuiltinToolName | (string & {})
export type ToolParamName<T extends ToolName> = T extends BuiltinToolName ? BuiltinToolParamNameOfTool<T> : string

