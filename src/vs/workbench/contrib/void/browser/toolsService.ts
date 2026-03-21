import { CancellationToken } from '../../../../base/common/cancellation.js'
import { URI } from '../../../../base/common/uri.js'
import { IFileService } from '../../../../platform/files/common/files.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js'
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js'
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js'
import { ISearchService, IFileQuery, ITextQuery, QueryType } from '../../../services/search/common/search.js'
import { IEditCodeService } from './editCodeServiceInterface.js'
import { ITerminalToolService } from './terminalToolService.js'
import { LintErrorItem, BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName } from '../common/toolsServiceTypes.js'
import { IVoidModelService } from '../common/voidModelService.js'
import { EndOfLinePreference } from '../../../../editor/common/model.js'
import { IVoidCommandBarService } from './voidCommandBarServiceInterface.js'
import { computeDirectoryTree1Deep, IDirectoryStrService, stringifyDirectoryTree1Deep } from '../common/directoryStrService.js'
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js'
import { timeout } from '../../../../base/common/async.js'
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js'
import { MAX_CHILDREN_URIs_PAGE, MAX_FILE_CHARS_PAGE, MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_INACTIVE_TIME } from '../common/prompt/prompts.js'
import { IVoidSettingsService } from '../common/voidSettingsService.js'
import { generateUuid } from '../../../../base/common/uuid.js'

import { IPathService } from '../../../services/path/common/pathService.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IGRCEngineService } from '../../neuralInverseChecks/browser/engine/services/grcEngineService.js';
import { IChecksAgentService } from '../../neuralInverseChecks/browser/checksAgent/checksAgentService.js';
import { IExternalCommandExecutor } from '../../neuralInverseChecks/browser/engine/services/externalCommandExecutor.js';
import { IPowerModeService } from '../../powerMode/browser/powerModeService.js';
import { IWorkflowAgentService } from '../../neuralInverse/browser/workflowAgentService.js';
import {
	createTaskCreateTool,
	createTaskListTool,
	createTaskUpdateTool,
	createTaskGetTool,
} from '../../powerMode/browser/tools/advancedTools.js';


// tool use for AI
type ValidateBuiltinParams = { [T in BuiltinToolName]: (p: RawToolParamsObj) => BuiltinToolCallParams[T] }
type CallBuiltinTool = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T]) => Promise<{ result: BuiltinToolResultType[T] | Promise<BuiltinToolResultType[T]>, interruptTool?: () => void }> }
type BuiltinToolResultToString = { [T in BuiltinToolName]: (p: BuiltinToolCallParams[T], result: Awaited<BuiltinToolResultType[T]>) => string }


const isFalsy = (u: unknown) => {
	return !u || u === 'null' || u === 'undefined'
}

const validateStr = (argName: string, value: unknown) => {
	if (value === null) throw new Error(`Invalid LLM output: ${argName} was null.`)
	if (typeof value !== 'string') throw new Error(`Invalid LLM output format: ${argName} must be a string, but its type is "${typeof value}". Full value: ${JSON.stringify(value)}.`)
	return value
}


// We are NOT checking to make sure in workspace
const validateURI = (uriStr: unknown) => {
	if (uriStr === null) throw new Error(`Invalid LLM output: uri was null.`)
	if (typeof uriStr !== 'string') throw new Error(`Invalid LLM output format: Provided uri must be a string, but it's a(n) ${typeof uriStr}. Full value: ${JSON.stringify(uriStr)}.`)

	// Check if it's already a full URI with scheme (e.g., vscode-remote://, file://, etc.)
	// Look for :// pattern which indicates a scheme is present
	// Examples of supported URIs:
	// - vscode-remote://wsl+Ubuntu/home/user/file.txt (WSL)
	// - vscode-remote://ssh-remote+myserver/home/user/file.txt (SSH)
	// - file:///home/user/file.txt (local file with scheme)
	// - /home/user/file.txt (local file path, will be converted to file://)
	// - C:\Users\file.txt (Windows local path, will be converted to file://)
	if (uriStr.includes('://')) {
		try {
			const uri = URI.parse(uriStr)
			return uri
		} catch (e) {
			// If parsing fails, it's a malformed URI
			throw new Error(`Invalid URI format: ${uriStr}. Error: ${e}`)
		}
	} else {
		// No scheme present, treat as file path
		// This handles regular file paths like /home/user/file.txt or C:\Users\file.txt
		const uri = URI.file(uriStr)
		return uri
	}
}

const validateOptionalURI = (uriStr: unknown) => {
	if (isFalsy(uriStr)) return null
	return validateURI(uriStr)
}

const validateOptionalStr = (argName: string, str: unknown) => {
	if (isFalsy(str)) return null
	return validateStr(argName, str)
}


const validatePageNum = (pageNumberUnknown: unknown) => {
	if (!pageNumberUnknown) return 1
	const parsedInt = Number.parseInt(pageNumberUnknown + '')
	if (!Number.isInteger(parsedInt)) throw new Error(`Page number was not an integer: "${pageNumberUnknown}".`)
	if (parsedInt < 1) throw new Error(`Invalid LLM output format: Specified page number must be 1 or greater: "${pageNumberUnknown}".`)
	return parsedInt
}

const validateNumber = (numStr: unknown, opts: { default: number | null }) => {
	if (typeof numStr === 'number')
		return numStr
	if (isFalsy(numStr)) return opts.default

	if (typeof numStr === 'string') {
		const parsedInt = Number.parseInt(numStr + '')
		if (!Number.isInteger(parsedInt)) return opts.default
		return parsedInt
	}

	return opts.default
}

const validateProposedTerminalId = (terminalIdUnknown: unknown) => {
	if (!terminalIdUnknown) throw new Error(`A value for terminalID must be specified, but the value was "${terminalIdUnknown}"`)
	const terminalId = terminalIdUnknown + ''
	return terminalId
}

const validateBoolean = (b: unknown, opts: { default: boolean }) => {
	if (typeof b === 'string') {
		if (b === 'true') return true
		if (b === 'false') return false
	}
	if (typeof b === 'boolean') {
		return b
	}
	return opts.default
}


const checkIfIsFolder = (uriStr: string) => {
	uriStr = uriStr.trim()
	if (uriStr.endsWith('/') || uriStr.endsWith('\\')) return true
	return false
}

export interface IToolsService {
	readonly _serviceBrand: undefined;
	validateParams: ValidateBuiltinParams;
	callTool: CallBuiltinTool;
	stringOfResult: BuiltinToolResultToString;
}

export const IToolsService = createDecorator<IToolsService>('ToolsService');

export class ToolsService implements IToolsService {

	readonly _serviceBrand: undefined;

	public validateParams: ValidateBuiltinParams;
	public callTool: CallBuiltinTool;
	public stringOfResult: BuiltinToolResultToString;

	constructor(
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@ISearchService searchService: ISearchService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IVoidModelService voidModelService: IVoidModelService,
		@IEditCodeService editCodeService: IEditCodeService,
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
		@IVoidCommandBarService private readonly commandBarService: IVoidCommandBarService,
		@IDirectoryStrService private readonly directoryStrService: IDirectoryStrService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IPathService private readonly pathService: IPathService,
		@IEditorService private readonly editorService: IEditorService,
		@IProductService private readonly productService: IProductService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IGRCEngineService private readonly grcEngine: IGRCEngineService,
		@IChecksAgentService private readonly checksAgent: IChecksAgentService,
		@IExternalCommandExecutor private readonly commandExecutor: IExternalCommandExecutor,
		@IPowerModeService private readonly powerMode: IPowerModeService,
	) {
		const queryBuilder = instantiationService.createInstance(QueryBuilder);

		const workspaceDir = workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? '/';
		const MAX_PM_OUTPUT = 50 * 1024; // 50KB

		// Lazy-resolved to avoid circular DI (neuralInverse → void → neuralInverse)
		let _workflowAgent: IWorkflowAgentService | null | undefined;
		const getWorkflowAgent = (): IWorkflowAgentService | null => {
			if (_workflowAgent === undefined) {
				try { _workflowAgent = instantiationService.invokeFunction(a => a.get(IWorkflowAgentService)); }
				catch { _workflowAgent = null; }
			}
			return _workflowAgent;
		};

		this.validateParams = {
			// --- Power Mode style tools ---
			bash: (params: RawToolParamsObj) => {
				const command = validateStr('command', params.command)
				const description = validateStr('description', params.description)
				const timeout = validateNumber(params.timeout, { default: null })
				return { command, description, timeout }
			},
			read: (params: RawToolParamsObj) => {
				const filePath = validateStr('file_path', params.file_path)
				const offset = validateNumber(params.offset, { default: null })
				const limit = validateNumber(params.limit, { default: null })
				return { filePath, offset, limit }
			},
			write: (params: RawToolParamsObj) => {
				const filePath = validateStr('file_path', params.file_path)
				const content = validateStr('content', params.content)
				return { filePath, content }
			},
			edit: (params: RawToolParamsObj) => {
				const filePath = validateStr('file_path', params.file_path)
				const oldString = validateStr('old_string', params.old_string)
				const newString = validateStr('new_string', params.new_string)
				return { filePath, oldString, newString }
			},
			glob: (params: RawToolParamsObj) => {
				const pattern = validateStr('pattern', params.pattern)
				const path = validateOptionalStr('path', params.path)
				return { pattern, path }
			},
			grep: (params: RawToolParamsObj) => {
				const pattern = validateStr('pattern', params.pattern)
				const path = validateOptionalStr('path', params.path)
				const include = validateOptionalStr('include', params.include)
				return { pattern, path, include }
			},
			list: (params: RawToolParamsObj) => {
				const dirPath = validateOptionalStr('dir_path', params.dir_path)
				return { dirPath }
			},
			// --- GRC compliance ---
			grc_violations: (params: RawToolParamsObj) => {
				const domain = validateOptionalStr('domain', params.domain)
				const severity = validateOptionalStr('severity', params.severity)
				const file = validateOptionalStr('file', params.file)
				const limit = validateNumber(params.limit, { default: 30 }) ?? 30
				return { domain, severity, file, limit }
			},
			grc_domain_summary: (_params: RawToolParamsObj) => {
				return {}
			},
			grc_blocking_violations: (_params: RawToolParamsObj) => {
				return {}
			},
			grc_framework_rules: (params: RawToolParamsObj) => {
				const frameworkId = validateOptionalStr('framework_id', params.framework_id)
				const domain = validateOptionalStr('domain', params.domain)
				return { frameworkId, domain }
			},
			grc_rescan: (_params: RawToolParamsObj) => {
				return {}
			},
			grc_ai_scan: (params: RawToolParamsObj) => {
				const files = validateOptionalStr('files', params.files)
				return { files }
			},
			grc_impact_chain: (params: RawToolParamsObj) => {
				const file = validateStr('file', params.file)
				const maxDepth = validateNumber(params.max_depth, { default: 3 }) ?? 3
				return { file, maxDepth }
			},
			ask_checksagent: (params: RawToolParamsObj) => {
				const question = validateStr('question', params.question)
				return { question }
			},
			ask_powermode: (params: RawToolParamsObj) => {
				const question = validateStr('question', params.question)
				return { question }
			},
			query_ni_agent: (params: RawToolParamsObj) => {
				const agentId = validateStr('agent_id', params.agent_id)
				const input = isFalsy(params.input) ? '' : validateStr('input', params.input)
				return { agentId, input }
			},
			// --- Workflow tools ---
			ask_user: (params: RawToolParamsObj) => {
				const question = validateStr('question', params.question)
				return { question }
			},
			web_fetch: (params: RawToolParamsObj) => {
				const url = validateStr('url', params.url)
				const description = validateStr('description', params.description)
				return { url, description }
			},
			memory_write: (params: RawToolParamsObj) => {
				const key = validateStr('key', params.key)
				const content = validateStr('content', params.content)
				return { key, content }
			},
			memory_read: (params: RawToolParamsObj) => {
				const key = validateStr('key', params.key)
				return { key }
			},
			tasks_create: (params: RawToolParamsObj) => {
				const title = validateStr('title', params.title)
				const description = validateOptionalStr('description', params.description)
				return { title, description }
			},
			tasks_list: (_params: RawToolParamsObj) => {
				return {}
			},
			tasks_update: (params: RawToolParamsObj) => {
				const taskId = validateStr('task_id', params.task_id)
				const status = validateOptionalStr('status', params.status)
				const title = validateOptionalStr('title', params.title)
				const description = validateOptionalStr('description', params.description)
				return { taskId, status, title, description }
			},
			tasks_get: (params: RawToolParamsObj) => {
				const taskId = validateStr('task_id', params.task_id)
				return { taskId }
			},
			// ---
			read_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, start_line: startLineUnknown, end_line: endLineUnknown, page_number: pageNumberUnknown } = params
				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)

				let startLine = validateNumber(startLineUnknown, { default: null })
				let endLine = validateNumber(endLineUnknown, { default: null })

				if (startLine !== null && startLine < 1) startLine = null
				if (endLine !== null && endLine < 1) endLine = null

				return { uri, startLine, endLine, pageNumber }
			},
			ls_dir: (params: RawToolParamsObj) => {
				const { uri: uriStr, page_number: pageNumberUnknown } = params

				const uri = validateURI(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { uri, pageNumber }
			},
			get_dir_tree: (params: RawToolParamsObj) => {
				const { uri: uriStr, } = params
				const uri = validateURI(uriStr)
				return { uri }
			},
			search_pathnames_only: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: includeUnknown,
					page_number: pageNumberUnknown
				} = params

				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const includePattern = validateOptionalStr('include_pattern', includeUnknown)

				return { query: queryStr, includePattern, pageNumber }

			},
			search_for_files: (params: RawToolParamsObj) => {
				const {
					query: queryUnknown,
					search_in_folder: searchInFolderUnknown,
					is_regex: isRegexUnknown,
					page_number: pageNumberUnknown
				} = params
				const queryStr = validateStr('query', queryUnknown)
				const pageNumber = validatePageNum(pageNumberUnknown)
				const searchInFolder = validateOptionalURI(searchInFolderUnknown)
				const isRegex = validateBoolean(isRegexUnknown, { default: false })
				return {
					query: queryStr,
					isRegex,
					searchInFolder,
					pageNumber
				}
			},
			search_in_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, query: queryUnknown, is_regex: isRegexUnknown } = params;
				const uri = validateURI(uriStr);
				const query = validateStr('query', queryUnknown);
				const isRegex = validateBoolean(isRegexUnknown, { default: false });
				return { uri, query, isRegex };
			},

			read_lint_errors: (params: RawToolParamsObj) => {
				const {
					uri: uriUnknown,
				} = params
				const uri = validateURI(uriUnknown)
				return { uri }
			},

			// ---

			create_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params
				const uri = validateURI(uriUnknown)
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isFolder }
			},

			delete_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, is_recursive: isRecursiveUnknown } = params
				const uri = validateURI(uriUnknown)
				const isRecursive = validateBoolean(isRecursiveUnknown, { default: false })
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isRecursive, isFolder }
			},

			rewrite_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, new_content: newContentUnknown } = params
				const uri = validateURI(uriStr)
				const newContent = validateStr('newContent', newContentUnknown)
				return { uri, newContent }
			},

			edit_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, search_replace_blocks: searchReplaceBlocksUnknown } = params
				const uri = validateURI(uriStr)
				const searchReplaceBlocks = validateStr('searchReplaceBlocks', searchReplaceBlocksUnknown)
				return { uri, searchReplaceBlocks }
			},
			multi_replace_file_content: (params: RawToolParamsObj) => {
				const { uri: uriStr, replacement_chunks: replacementChunksUnknown } = params
				const uri = validateURI(uriStr)
				const replacementChunks = validateStr('replacement_chunks', replacementChunksUnknown)
				return { uri, replacementChunks }
			},

			// ---

			run_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, cwd: cwdUnknown } = params
				const command = validateStr('command', commandUnknown)
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const terminalId = generateUuid()
				return { command, cwd, terminalId }
			},
			run_persistent_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, persistent_terminal_id: persistentTerminalIdUnknown } = params;
				const command = validateStr('command', commandUnknown);
				const persistentTerminalId = validateProposedTerminalId(persistentTerminalIdUnknown)
				return { command, persistentTerminalId };
			},
			open_persistent_terminal: (params: RawToolParamsObj) => {
				const { cwd: cwdUnknown } = params;
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				// No parameters needed; will open a new background terminal
				return { cwd };
			},

			read_terminal: (params: RawToolParamsObj) => {
				const { persistent_terminal_id: terminalIdUnknown } = params;
				const persistentTerminalId = validateProposedTerminalId(terminalIdUnknown);
				return { persistentTerminalId };
			},

			send_command_input: (params: RawToolParamsObj) => {
				const { persistent_terminal_id: terminalIdUnknown, input: inputUnknown } = params;
				const persistentTerminalId = validateProposedTerminalId(terminalIdUnknown);
				const input = validateStr('input', inputUnknown);
				return { persistentTerminalId, input };
			},

			kill_persistent_terminal: (params: RawToolParamsObj) => {
				const { persistent_terminal_id: terminalIdUnknown } = params;
				const persistentTerminalId = validateProposedTerminalId(terminalIdUnknown);
				return { persistentTerminalId };
			},

			update_agent_status: (params: RawToolParamsObj) => {
				const { task_name: taskNameUnknown, task_summary: taskSummaryUnknown, task_status: taskStatusUnknown } = params;
				const taskName = typeof taskNameUnknown === 'string' ? taskNameUnknown : 'Agent Update';
				const taskSummary = typeof taskSummaryUnknown === 'string' ? taskSummaryUnknown : (Object.values(params).join(' ') || 'Progress update.');
				const taskStatus = typeof taskStatusUnknown === 'string' ? taskStatusUnknown : 'Working...';
				return { taskName, taskSummary, taskStatus };
			},

			generate_document: (params: RawToolParamsObj) => {
				const { title: titleUnknown, content: contentUnknown, ...otherParams } = params;
				const title = typeof titleUnknown === 'string' ? titleUnknown : 'Generated_Document';

				let content = '';
				if (typeof contentUnknown === 'string' && contentUnknown.trim() !== '') {
					content = contentUnknown;
				} else if (Object.keys(otherParams).length > 0) {
					// The LLM hallucinated a JSON object shape with different keys
					content = Object.entries(params)
						.filter(([k, v]) => k !== 'title')
						.map(([k, v]) => `## ${k}\n${v}`)
						.join('\n\n');
				} else {
					content = 'No content provided.';
				}

				return { title, content };
			},

		}


		this.callTool = {
			// --- Power Mode style tools ---
			bash: async ({ command, description, timeout }) => {
				const jobId = `void_bash_${Date.now()}`
				const fullCommand = `cd ${JSON.stringify(workspaceDir)} && ${command}`
				try {
					const output = await this.commandExecutor.execute(jobId, fullCommand, timeout ?? 120000, MAX_PM_OUTPUT)
					const truncated = output.length > MAX_PM_OUTPUT ? output.substring(0, MAX_PM_OUTPUT) + '\n[Output truncated at 50KB]' : output
					return { result: { result: truncated } }
				} catch (err: any) {
					return { result: { result: `Error: ${err.message}${err.stderr ? '\n' + err.stderr : ''}` } }
				}
			},
			read: async ({ filePath, offset, limit: readLimit }) => {
				const normalizedPath = filePath.startsWith('/') ? filePath : `${workspaceDir}/${filePath}`
				const uri = URI.file(normalizedPath)
				try {
					const stat = await fileService.stat(uri)
					if (stat.isDirectory) {
						const resolved = await fileService.resolve(uri)
						const entries = (resolved.children ?? []).map(c => `${c.isDirectory ? 'd' : '-'} ${c.name}`).sort().join('\n')
						return { result: { result: entries || '(empty directory)' } }
					}
					const content = await fileService.readFile(uri)
					const text = content.value.toString()
					const allLines = text.split('\n')
					const startIdx = Math.max(0, (offset ?? 1) - 1)
					const maxLines = readLimit ?? 2000
					const selectedLines = allLines.slice(startIdx, startIdx + maxLines)
					const numbered = selectedLines.map((line, i) => {
						const num = String(startIdx + i + 1).padStart(6, ' ')
						return `${num}\t${line.length > 2000 ? line.substring(0, 2000) + '...' : line}`
					}).join('\n')
					const out = numbered.length > MAX_PM_OUTPUT ? numbered.substring(0, MAX_PM_OUTPUT) + '\n[Output truncated]' : numbered
					return { result: { result: out } }
				} catch (err: any) {
					return { result: { result: `Error: ${err.message}` } }
				}
			},
			write: async ({ filePath, content }) => {
				const normalizedPath = filePath.startsWith('/') ? filePath : `${workspaceDir}/${filePath}`
				const uri = URI.file(normalizedPath)
				try {
					await fileService.writeFile(uri, VSBuffer.fromString(content))
					return { result: { result: `Successfully wrote ${content.split('\n').length} lines to ${normalizedPath}` } }
				} catch (err: any) {
					return { result: { result: `Error writing file: ${err.message}` } }
				}
			},
			edit: async ({ filePath, oldString, newString }) => {
				const normalizedPath = filePath.startsWith('/') ? filePath : `${workspaceDir}/${filePath}`
				const uri = URI.file(normalizedPath)
				try {
					const content = await fileService.readFile(uri)
					const text = content.value.toString()
					const count = text.split(oldString).length - 1
					if (count === 0) {
						return { result: { result: `Error: old_string not found in ${normalizedPath}` } }
					}
					if (count > 1) {
						return { result: { result: `Error: old_string found ${count} times in ${normalizedPath} — must be unique. Add more context.` } }
					}
					const newText = text.replace(oldString, newString)
					await fileService.writeFile(uri, VSBuffer.fromString(newText))
					return { result: { result: `Successfully edited ${normalizedPath}` } }
				} catch (err: any) {
					return { result: { result: `Error: ${err.message}` } }
				}
			},
			glob: async ({ pattern, path: searchPath }) => {
				const folderUri = URI.file(searchPath ?? workspaceDir)
				try {
					const query: IFileQuery = {
						type: QueryType.File,
						folderQueries: [{ folder: folderUri }],
						filePattern: pattern,
						maxResults: 100,
					}
					const results = await searchService.fileSearch(query)
					const files = results.results.map(r => r.resource.fsPath).join('\n')
					return { result: { result: files || 'No matches found.' } }
				} catch (err: any) {
					return { result: { result: `Error: ${err.message}` } }
				}
			},
			grep: async ({ pattern, path: searchPath, include }) => {
				const folderUri = URI.file(searchPath ?? workspaceDir)
				try {
					const query: ITextQuery = {
						type: QueryType.Text,
						contentPattern: { pattern, isRegExp: true, isCaseSensitive: false },
						folderQueries: [{ folder: folderUri }],
						includePattern: include ? { [include]: true } : undefined,
						excludePattern: { '**/node_modules': true, '**/.git': true },
						maxResults: 200,
					}
					const matches: string[] = []
					await searchService.textSearch(query, undefined, (item) => {
						if ('resource' in item) {
							const fm = item as { resource: { fsPath: string }; results?: Array<{ rangeLocations?: Array<{ source: { startLineNumber: number } }>; previewText?: string }> }
							const file = fm.resource.fsPath
							for (const res of fm.results ?? []) {
								const line = res.rangeLocations?.[0]?.source.startLineNumber ?? 0
								matches.push(`${file}:${line}: ${(res.previewText ?? '').trim()}`)
							}
						}
					})
					const output = matches.join('\n') || 'No matches found.'
					return { result: { result: output.length > MAX_PM_OUTPUT ? output.substring(0, MAX_PM_OUTPUT) + '\n[Output truncated]' : output } }
				} catch (err: any) {
					return { result: { result: `Error: ${err.message}` } }
				}
			},
			list: async ({ dirPath }) => {
				const uri = URI.file(dirPath ?? workspaceDir)
				try {
					const resolved = await fileService.resolve(uri)
					const entries = (resolved.children ?? []).map(c => `${c.isDirectory ? 'd' : '-'} ${c.name}`).sort().join('\n')
					return { result: { result: entries || '(empty directory)' } }
				} catch (err: any) {
					return { result: { result: `Error: ${err.message}` } }
				}
			},
			// --- GRC compliance ---
			grc_violations: async ({ domain, severity, file, limit }) => {
				let results = grcEngine.getAllResults()
				if (domain) { results = results.filter(r => r.domain === domain) }
				if (severity) { results = results.filter(r => (r.severity ?? '').toLowerCase() === severity.toLowerCase()) }
				if (file) { results = results.filter(r => r.fileUri?.path.includes(file)) }
				results = results.slice(0, limit)

				if (results.length === 0) {
					return { result: { result: 'No violations found matching the specified filters.' } }
				}
				const lines = results.map(r => {
					const loc = r.fileUri ? `${r.fileUri.path.split('/').slice(-2).join('/')}:${r.line ?? '?'}` : 'unknown'
					return `[${(r.severity ?? 'info').toUpperCase()}] ${r.ruleId} — ${r.message}\n  File: ${loc}\n  Domain: ${r.domain ?? 'general'}`
				})
				return { result: { result: `${results.length} violation(s):\n\n${lines.join('\n\n')}` } }
			},
			grc_domain_summary: async (_params) => {
				const summary = grcEngine.getDomainSummary()
				if (summary.length === 0) {
					return { result: { result: 'No domains with violations. Compliance posture is clean.' } }
				}
				const total = summary.reduce((acc, d) => acc + d.errorCount + d.warningCount, 0)
				const lines = summary.map(d => `  ${d.domain.padEnd(20)} errors: ${d.errorCount}, warnings: ${d.warningCount}`)
				return { result: { result: `Domain summary (${total} total violations):\n\n${lines.join('\n')}` } }
			},
			grc_blocking_violations: async (_params) => {
				const blocking = grcEngine.getBlockingViolations()
				if (blocking.length === 0) {
					return { result: { result: 'No blocking violations. Commits are not gated.' } }
				}
				const lines = blocking.map(r => {
					const loc = r.fileUri ? `${r.fileUri.path.split('/').slice(-2).join('/')}:${r.line ?? '?'}` : 'unknown'
					return `[BLOCKING] ${r.ruleId} — ${r.message}\n  File: ${loc}\n  Domain: ${r.domain ?? 'general'}`
				})
				return { result: { result: `COMMIT IS GATED — ${blocking.length} blocking violation(s):\n\n${lines.join('\n\n')}` } }
			},
			grc_framework_rules: async ({ frameworkId, domain }) => {
				const frameworks = grcEngine.getActiveFrameworks()
				let rules = grcEngine.getRules()
				if (frameworkId) { rules = rules.filter(r => r.frameworkId === frameworkId) }
				if (domain) { rules = rules.filter(r => r.domain === domain) }

				const frameworkList = frameworks.map(f => `  ${f.id}: ${f.name} (v${f.version})`).join('\n')
				if (rules.length === 0) {
					return { result: { result: `Active frameworks:\n${frameworkList}\n\nNo rules found for the specified filters.` } }
				}
				const ruleLines = rules.slice(0, 50).map(r =>
					`  [${r.domain ?? 'general'}] ${r.id}: ${r.message}${r.blockingBehavior?.blocksCommit ? ' (BLOCKING)' : ''}`
				)
				const header = frameworks.length > 0 ? `Active frameworks:\n${frameworkList}\n\n` : ''
				return { result: { result: `${header}Rules (${rules.length} total, showing up to 50):\n\n${ruleLines.join('\n')}` } }
			},
			grc_rescan: async (_params) => {
				try {
					await this.grcEngine.scanWorkspace();
					const allResults = this.grcEngine.getAllResults();
					const blocking = this.grcEngine.getBlockingViolations();
					return { result: { result: `Workspace rescan complete. ${allResults.length} total violation(s), ${blocking.length} blocking.${blocking.length > 0 ? ' COMMIT IS GATED.' : ' Commits are clear.'}` } }
				} catch (err: any) {
					return { result: { result: `GRC rescan failed: ${err.message}` } }
				}
			},
			grc_ai_scan: async ({ files }) => {
				try {
					await this.grcEngine.scanWorkspaceWithAI();
					const allResults = this.grcEngine.getAllResults();
					const blocking = this.grcEngine.getBlockingViolations();
					const scopeNote = files ? ` (scoped to: ${files})` : '';
					return { result: { result: `AI compliance scan complete${scopeNote}. ${allResults.length} total violation(s), ${blocking.length} blocking.${blocking.length > 0 ? ' COMMIT IS GATED.' : ' Commits are clear.'}` } }
				} catch (err: any) {
					return { result: { result: `AI scan failed: ${err.message}` } }
				}
			},
			grc_impact_chain: async ({ file, maxDepth }) => {
				const fileUri = file.includes('://') ? URI.parse(file) : URI.file(file)
				const impact = grcEngine.getImpactChain(fileUri, maxDepth)
				if (!impact) {
					return { result: { result: `No impact chain found for: ${file}\nThis file may not be tracked in the import graph yet.` } }
				}
				type ImpactNode = NonNullable<typeof impact>
				const renderTree = (node: ImpactNode, indent = 0): string => {
					const prefix = '  '.repeat(indent)
					const label = node.fileUri.split('/').slice(-2).join('/')
					let out = `${prefix}${label}`
					if (node.dependents.length > 0) {
						out += ` (imported by ${node.dependents.length} file${node.dependents.length !== 1 ? 's' : ''})`
						for (const dep of node.dependents) { out += '\n' + renderTree(dep, indent + 1) }
					}
					return out
				}
				const countDescendants = (node: ImpactNode): number => {
					let count = node.dependents.length
					for (const dep of node.dependents) { count += countDescendants(dep) }
					return count
				}
				const total = countDescendants(impact)
				return { result: { result: `Impact chain for ${file.split('/').slice(-2).join('/')} (${total} dependent file(s) affected):\n\n${renderTree(impact)}` } }
			},
			ask_checksagent: async ({ question }) => {
				try {
					const answer = await this.checksAgent.answerQuery(question)
					return { result: { result: answer } }
				} catch (e: any) {
					return { result: { result: `[Checks Agent connection error: ${e.message ?? 'unknown'}]` } }
				}
			},
			ask_powermode: async ({ question }) => {
				try {
					const answer = await this.powerMode.answerQuery(question)
					return { result: { result: answer } }
				} catch (e: any) {
					return { result: { result: `[Power Mode connection error: ${e.message ?? 'unknown'}]` } }
				}
			},
			query_ni_agent: async ({ agentId, input }) => {
				const wf = getWorkflowAgent();
				if (!wf) {
					return { result: { result: '[query_ni_agent] WorkflowAgentService not available.' } };
				}
				// Discovery mode — list available agents + workflows
				if (agentId === 'list') {
					const workflows = wf.getWorkflows().map(w => `workflow:${w.id} — ${w.name}: ${w.description}`).join('\n');
					const runHistory = wf.getRunHistory(5).map(r => `[${r.status}] ${r.workflowName}`).join(', ') || 'none';
					return { result: { result: `Available workflows:\n${workflows || '(none defined in .inverse/workflows/)'}\n\nRecent runs: ${runHistory}` } };
				}
				try {
					const run = await wf.runAgent(agentId, input);
					const output = run.finalOutput ?? run.steps.slice(-1)[0]?.finalOutput ?? `Run completed with status: ${run.status}`;
					if (run.status === 'failed') {
						return { result: { result: `[Agent "${agentId}" failed] ${run.error ?? output}` } };
					}
					return { result: { result: output } };
				} catch (e: any) {
					return { result: { result: `[query_ni_agent error: ${e.message ?? 'unknown'}]` } };
				}
			},
			// --- Workflow tools ---
			ask_user: async ({ question }) => {
				// ask_user in main chat should behave like a regular chat message
				// Rather than pausing, we return a prompt asking the user to respond
				return { result: { result: `[ask_user] ${question}\n\nPlease respond to continue.` } };
			},
			web_fetch: async ({ url, description }) => {
				try {
					const controller = new AbortController();
					const timeoutId = setTimeout(() => controller.abort(), 30000);

					const response = await fetch(url, {
						signal: controller.signal,
						headers: { 'User-Agent': 'Neural-Inverse-Void-Chat/1.0' },
					});
					clearTimeout(timeoutId);

					if (!response.ok) {
						return { result: { result: `HTTP ${response.status}: ${response.statusText}` } };
					}

					const contentType = response.headers.get('content-type') || '';
					let content = await response.text();

					// Strip HTML tags
					if (contentType.includes('text/html')) {
						content = content
							.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
							.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
							.replace(/<[^>]+>/g, ' ')
							.replace(/\s+/g, ' ')
							.trim();
					}

					// Truncate if too large
					const MAX_SIZE = 100 * 1024;
					if (content.length > MAX_SIZE) {
						content = content.substring(0, MAX_SIZE) + '\n[Content truncated at 100KB]';
					}

					return { result: { result: content } };
				} catch (err: any) {
					return { result: { result: `Error fetching URL: ${err.message}` } };
				}
			},
			memory_write: async ({ key, content }) => {
				const memoryDir = `${workspaceDir}/.void-memory`;
				const memoryFile = `${memoryDir}/${key}.md`;

				try {
					// Ensure directory exists
					const dirUri = URI.file(memoryDir);
					await fileService.createFolder(dirUri).catch(() => { /* already exists */ });

					// Write memory
					const fileUri = URI.file(memoryFile);
					const buffer = VSBuffer.fromString(content);
					await fileService.writeFile(fileUri, buffer);

					return { result: { result: `Memory saved: ${key}` } };
				} catch (err: any) {
					return { result: { result: `Error saving memory: ${err.message}` } };
				}
			},
			memory_read: async ({ key }) => {
				const memoryFile = `${workspaceDir}/.void-memory/${key}.md`;

				try {
					const fileUri = URI.file(memoryFile);
					const content = await fileService.readFile(fileUri);
					const text = content.value.toString();
					return { result: { result: text } };
				} catch (err: any) {
					return { result: { result: `No memory found for key: ${key}` } };
				}
			},
			tasks_create: async ({ title, description }) => {
				// Use the shared task store from advancedTools
				const tool = createTaskCreateTool();
				const result = await tool.execute({ title, description: description || undefined }, {} as any);
				return { result: { result: result.output } };
			},
			tasks_list: async (_params) => {
				const tool = createTaskListTool();
				const result = await tool.execute({}, {} as any);
				return { result: { result: result.output } };
			},
			tasks_update: async ({ taskId, status, title, description }) => {
				const tool = createTaskUpdateTool();
				const args: Record<string, any> = { taskId };
				if (status) args.status = status;
				if (title) args.title = title;
				if (description) args.description = description;
				const result = await tool.execute(args, {} as any);
				return { result: { result: result.output } };
			},
			tasks_get: async ({ taskId }) => {
				const tool = createTaskGetTool();
				const result = await tool.execute({ taskId }, {} as any);
				return { result: { result: result.output } };
			},
			// ---
			read_file: async ({ uri, startLine, endLine, pageNumber }) => {
				await voidModelService.initializeModel(uri)
				const { model } = await voidModelService.getModelSafe(uri)
				if (model === null) { throw new Error(`No contents; File does not exist.`) }

				let contents: string
				if (startLine === null && endLine === null) {
					contents = model.getValue(EndOfLinePreference.LF)
				}
				else {
					const startLineNumber = startLine === null ? 1 : startLine
					const endLineNumber = endLine === null ? model.getLineCount() : endLine
					contents = model.getValueInRange({ startLineNumber, startColumn: 1, endLineNumber, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
				}

				const totalNumLines = model.getLineCount()

				const fromIdx = MAX_FILE_CHARS_PAGE * (pageNumber - 1)
				const toIdx = MAX_FILE_CHARS_PAGE * pageNumber - 1
				const fileContents = contents.slice(fromIdx, toIdx + 1) // paginate
				const hasNextPage = (contents.length - 1) - toIdx >= 1
				const totalFileLen = contents.length
				return { result: { fileContents, totalFileLen, hasNextPage, totalNumLines } }
			},

			ls_dir: async ({ uri, pageNumber }) => {
				const dirResult = await computeDirectoryTree1Deep(fileService, uri, pageNumber)
				return { result: dirResult }
			},

			get_dir_tree: async ({ uri }) => {
				const str = await this.directoryStrService.getDirectoryStrTool(uri)
				return { result: { str } }
			},

			search_pathnames_only: async ({ query: queryStr, includePattern, pageNumber }) => {

				const query = queryBuilder.file(workspaceContextService.getWorkspace().folders.map(f => f.uri), {
					filePattern: queryStr,
					includePattern: includePattern ?? undefined,
					sortByScore: true, // makes results 10x better
				})
				const data = await searchService.fileSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { uris, hasNextPage } }
			},

			search_for_files: async ({ query: queryStr, isRegex, searchInFolder, pageNumber }) => {
				const searchFolders = searchInFolder === null ?
					workspaceContextService.getWorkspace().folders.map(f => f.uri)
					: [searchInFolder]

				const query = queryBuilder.text({
					pattern: queryStr,
					isRegExp: isRegex,
				}, searchFolders)

				const data = await searchService.textSearch(query, CancellationToken.None)

				const fromIdx = MAX_CHILDREN_URIs_PAGE * (pageNumber - 1)
				const toIdx = MAX_CHILDREN_URIs_PAGE * pageNumber - 1
				const uris = data.results
					.slice(fromIdx, toIdx + 1) // paginate
					.map(({ resource, results }) => resource)

				const hasNextPage = (data.results.length - 1) - toIdx >= 1
				return { result: { queryStr, uris, hasNextPage } }
			},
			search_in_file: async ({ uri, query, isRegex }) => {
				await voidModelService.initializeModel(uri);
				const { model } = await voidModelService.getModelSafe(uri);
				if (model === null) { throw new Error(`No contents; File does not exist.`); }
				const contents = model.getValue(EndOfLinePreference.LF);
				const contentOfLine = contents.split('\n');
				const totalLines = contentOfLine.length;
				const regex = isRegex ? new RegExp(query) : null;
				const lines: number[] = []
				for (let i = 0; i < totalLines; i++) {
					const line = contentOfLine[i];
					if ((isRegex && regex!.test(line)) || (!isRegex && line.includes(query))) {
						const matchLine = i + 1;
						lines.push(matchLine);
					}
				}
				return { result: { lines } };
			},

			read_lint_errors: async ({ uri }) => {
				await timeout(1000)
				const { lintErrors } = this._getLintErrors(uri)
				return { result: { lintErrors } }
			},

			// ---

			create_file_or_folder: async ({ uri, isFolder }) => {
				if (isFolder)
					await fileService.createFolder(uri)
				else {
					await fileService.createFile(uri)
				}
				return { result: {} }
			},

			delete_file_or_folder: async ({ uri, isRecursive }) => {
				await fileService.del(uri, { recursive: isRecursive })
				return { result: {} }
			},

			rewrite_file: async ({ uri, newContent }) => {
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				editCodeService.instantlyRewriteFile({ uri, newContent })
				// at end, get lint errors
				const lintErrorsPromise = Promise.resolve().then(async () => {
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors }
				})
				return { result: lintErrorsPromise }
			},

			edit_file: async ({ uri, searchReplaceBlocks }) => {
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)
				editCodeService.instantlyApplySearchReplaceBlocks({ uri, searchReplaceBlocks })

				// at end, get lint errors
				const lintErrorsPromise = Promise.resolve().then(async () => {
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors }
				})

				return { result: lintErrorsPromise }
			},

			multi_replace_file_content: async ({ uri, replacementChunks }) => {
				await voidModelService.initializeModel(uri)
				if (this.commandBarService.getStreamState(uri) === 'streaming') {
					throw new Error(`Another LLM is currently making changes to this file. Please stop streaming for now and ask the user to resume later.`)
				}
				await editCodeService.callBeforeApplyOrEdit(uri)

				let chunks: { StartLine: number, EndLine: number, TargetContent: string, ReplacementContent: string }[] = []
				try { chunks = JSON.parse(replacementChunks) } catch (e) { throw new Error(`Invalid JSON for replacement_chunks.`) }

				editCodeService.instantlyApplyReplacementChunks({ uri, replacementChunks: chunks })

				// at end, get lint errors
				const lintErrorsPromise = Promise.resolve().then(async () => {
					await timeout(2000)
					const { lintErrors } = this._getLintErrors(uri)
					return { lintErrors }
				})

				return { result: lintErrorsPromise }
			},
			// ---
			run_command: async ({ command, cwd, terminalId }) => {
				const commitGateMsg = this._checkCommitGate(command);
				if (commitGateMsg) {
					return { result: Promise.resolve({ resolveReason: { type: 'done' as const, exitCode: 1 }, result: commitGateMsg }) }
				}
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			run_persistent_command: async ({ command, persistentTerminalId }) => {
				const commitGateMsg = this._checkCommitGate(command);
				if (commitGateMsg) {
					return { result: Promise.resolve({ resolveReason: { type: 'done' as const, exitCode: 1 }, result: commitGateMsg }) }
				}
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId })
				return { result: resPromise, interruptTool: interrupt }
			},
			open_persistent_terminal: async ({ cwd }) => {
				const persistentTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd })
				return { result: { persistentTerminalId } }
			},

			read_terminal: async ({ persistentTerminalId }) => {
				const output = await this.terminalToolService.readPersistentTerminalTypeout(persistentTerminalId)
				return { result: { result: output } }
			},

			send_command_input: async ({ persistentTerminalId, input }) => {
				await this.terminalToolService.sendInputToPersistentTerminal(persistentTerminalId, input)
				// wait a short moment to capture immediate output? The LLM can just read_terminal if it wants.
				return { result: { result: `Input successfully evaluated. Recommend running read_terminal to see the effect.` } }
			},

			kill_persistent_terminal: async ({ persistentTerminalId }) => {
				// Close the background terminal by sending exit
				await this.terminalToolService.killPersistentTerminal(persistentTerminalId)
				return { result: {} }
			},
			update_agent_status: async ({ taskName, taskSummary, taskStatus }) => {
				// update_task simply serves as a marker in the tool history
				// to be rendered by the UI component loop.
				return { result: { result: "Task updated." } }
			},

			generate_document: async ({ title, content }) => {
				const folderName = this.productService.dataFolderName || '.neural-inverse';

				// Identify the active project to create a subfolder within the global artifacts directory
				const workspaceFolders = workspaceContextService.getWorkspace().folders;
				const projectName = workspaceFolders.length > 0 ? workspaceFolders[0].name : 'unknown_project';

				// Use the global roaming data folder
				const baseDir = this.environmentService.userRoamingDataHome
					? URI.joinPath(this.environmentService.userRoamingDataHome, '..', '..')
					: await this.pathService.userHome();

				const artifactsDir = URI.joinPath(baseDir, folderName, 'artifacts', projectName);

				// Ensure folder exists
				try {
					await fileService.createFolder(artifactsDir);
				} catch (e) {
					// Likely exists already
				}

				const fileUri = URI.joinPath(artifactsDir, `${title}.md`);
				const buffer = VSBuffer.fromString(content);
				await fileService.writeFile(fileUri, buffer);

				// Open artifact natively in VS Code side editor
				try {
					await this.editorService.openEditor({
						resource: fileUri,
						options: { pinned: true, preserveFocus: true }
					}, SIDE_GROUP);
				} catch (e) {
					console.error('Error opening artifact in editor:', e);
				}

				return { result: { result: `Artifact created and opened natively at ${fileUri.fsPath}`, fileUri } };
			},
		}


		const nextPageStr = (hasNextPage: boolean) => hasNextPage ? '\n\n(more on next page...)' : ''

		const stringifyLintErrors = (lintErrors: LintErrorItem[]) => {
			return lintErrors
				.map((e, i) => `Error ${i + 1}:\nLines Affected: ${e.startLineNumber}-${e.endLineNumber}\nError message:${e.message}`)
				.join('\n\n')
				.substring(0, MAX_FILE_CHARS_PAGE)
		}

		// given to the LLM after the call for successful tool calls
		this.stringOfResult = {
			// --- Power Mode style tools ---
			bash: (_params, result) => result.result,
			read: (_params, result) => result.result,
			write: (_params, result) => result.result,
			edit: (_params, result) => result.result,
			glob: (_params, result) => result.result,
			grep: (_params, result) => result.result,
			list: (_params, result) => result.result,
			// --- GRC compliance ---
			grc_violations: (_params, result) => result.result,
			grc_domain_summary: (_params, result) => result.result,
			grc_blocking_violations: (_params, result) => result.result,
			grc_framework_rules: (_params, result) => result.result,
			grc_impact_chain: (_params, result) => result.result,
			grc_rescan: (_params, result) => result.result,
			grc_ai_scan: (_params, result) => result.result,
			ask_checksagent: (_params, result) => result.result,
			ask_powermode: (_params, result) => result.result,
			query_ni_agent: (_params, result) => result.result,
			// --- Workflow tools ---
			ask_user: (_params, result) => result.result,
			web_fetch: (_params, result) => result.result,
			memory_write: (_params, result) => result.result,
			memory_read: (_params, result) => result.result,
			tasks_create: (_params, result) => result.result,
			tasks_list: (_params, result) => result.result,
			tasks_update: (_params, result) => result.result,
			tasks_get: (_params, result) => result.result,
			// ---
			read_file: (params, result) => {
				return `${params.uri.fsPath}\n\`\`\`\n${result.fileContents}\n\`\`\`${nextPageStr(result.hasNextPage)}${result.hasNextPage ? `\nMore info because truncated: this file has ${result.totalNumLines} lines, or ${result.totalFileLen} characters.` : ''}`
			},
			ls_dir: (params, result) => {
				const dirTreeStr = stringifyDirectoryTree1Deep(params, result)
				return dirTreeStr // + nextPageStr(result.hasNextPage) // already handles num results remaining
			},
			get_dir_tree: (params, result) => {
				return result.str
			},
			search_pathnames_only: (params, result) => {
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_for_files: (params, result) => {
				return result.uris.map(uri => uri.fsPath).join('\n') + nextPageStr(result.hasNextPage)
			},
			search_in_file: (params, result) => {
				const { model } = voidModelService.getModel(params.uri)
				if (!model) return '<Error getting string of result>'
				const lines = result.lines.map(n => {
					const lineContent = model.getValueInRange({ startLineNumber: n, startColumn: 1, endLineNumber: n, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
					return `Line ${n}:\n\`\`\`\n${lineContent}\n\`\`\``
				}).join('\n\n');
				return lines;
			},
			read_lint_errors: (params, result) => {
				return result.lintErrors ?
					stringifyLintErrors(result.lintErrors)
					: 'No lint errors found.'
			},
			// ---
			create_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully created.`
			},
			delete_file_or_folder: (params, result) => {
				return `URI ${params.uri.fsPath} successfully deleted.`
			},
			edit_file: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')
				const grcString = this._getFileGRCViolations(params.uri);

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}${grcString}`
			},
			multi_replace_file_content: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')
				const grcString = this._getFileGRCViolations(params.uri);

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}${grcString}`
			},
			rewrite_file: (params, result) => {
				const lintErrsString = (
					this.voidSettingsService.state.globalSettings.includeToolLintErrors ?
						(result.lintErrors ? ` Lint errors found after change:\n${stringifyLintErrors(result.lintErrors)}.\nIf this is related to a change made while calling this tool, you might want to fix the error.`
							: ` No lint errors found.`)
						: '')
				const grcString = this._getFileGRCViolations(params.uri);

				return `Change successfully made to ${params.uri.fsPath}.${lintErrsString}${grcString}`
			},
			run_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// normal command
				if (resolveReason.type === 'timeout') {
					return `${result_}\nTerminal command ran, but was automatically killed by Void after ${MAX_TERMINAL_INACTIVE_TIME}s of inactivity and did not finish successfully. To try with more time, open a persistent terminal and run the command there.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			run_persistent_command: (params, result) => {
				const { resolveReason, result: result_, } = result
				const { persistentTerminalId } = params
				// success
				if (resolveReason.type === 'done') {
					return `${result_}\n(exit code ${resolveReason.exitCode})`
				}
				// bg command
				if (resolveReason.type === 'timeout') {
					return `${result_}\nTerminal command is running in terminal ${persistentTerminalId}. The given outputs are the results after ${MAX_TERMINAL_BG_COMMAND_TIME} seconds.`
				}
				throw new Error(`Unexpected internal error: Terminal command did not resolve with a valid reason.`)
			},

			open_persistent_terminal: (_params, result) => {
				const { persistentTerminalId } = result;
				return `Successfully created persistent terminal. persistentTerminalId="${persistentTerminalId}"`;
			},
			read_terminal: (_params, result) => {
				return result.result;
			},
			send_command_input: (_params, result) => {
				return result.result;
			},
			kill_persistent_terminal: (params, _result) => {
				return `Successfully closed terminal "${params.persistentTerminalId}".`;
			},
			update_agent_status: (params, result) => {
				return result.result;
			},
			generate_document: (params, result) => {
				return result.result;
			},
		}



	}


	private _getFileGRCViolations(uri: URI): string {
		try {
			const allResults = this.grcEngine.getAllResults();
			const fileViolations = allResults.filter(r =>
				r.fileUri && r.fileUri.path === uri.path &&
				((r.severity ?? '').toLowerCase() === 'error' || r.blockingBehavior?.blocksCommit)
			);
			if (fileViolations.length === 0) return '';
			const lines = fileViolations.map(r => {
				const sev = r.blockingBehavior?.blocksCommit ? 'BLOCKING' : (r.severity ?? 'error').toUpperCase();
				return `[${sev}] ${r.ruleId} — ${r.message} (line ${r.line ?? '?'})`;
			});
			return `\n GRC violations in this file:\n${lines.join('\n')}\nFix blocking violations before committing.`;
		} catch {
			return '';
		}
	}

	private _checkCommitGate(command: string): string | null {
		if (!/\bgit\s+commit\b/.test(command)) return null;
		try {
			const blocking = this.grcEngine.getBlockingViolations();
			if (blocking.length === 0) return null;
			const lines = blocking.slice(0, 10).map(r => {
				const loc = r.fileUri ? `${r.fileUri.path.split('/').slice(-2).join('/')}:${r.line ?? '?'}` : 'unknown';
				return `  - [BLOCKING] ${r.ruleId} in ${loc} — ${r.message}`;
			});
			return `COMMIT BLOCKED — ${blocking.length} blocking GRC violation(s) must be resolved first:\n${lines.join('\n')}\n\nFix these violations before committing. Use \`grc_blocking_violations\` for full details.`;
		} catch {
			return null;
		}
	}

	private _getLintErrors(uri: URI): { lintErrors: LintErrorItem[] | null } {
		const lintErrors = this.markerService
			.read({ resource: uri })
			.filter(l => l.severity === MarkerSeverity.Error || l.severity === MarkerSeverity.Warning)
			.slice(0, 100)
			.map(l => ({
				code: typeof l.code === 'string' ? l.code : l.code?.value || '',
				message: (l.severity === MarkerSeverity.Error ? '(error) ' : '(warning) ') + l.message,
				startLineNumber: l.startLineNumber,
				endLineNumber: l.endLineNumber,
			} satisfies LintErrorItem))

		if (!lintErrors.length) return { lintErrors: null }
		return { lintErrors, }
	}


}

registerSingleton(IToolsService, ToolsService, InstantiationType.Eager);
