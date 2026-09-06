import { CancellationToken } from '../../../../base/common/cancellation.js'
import { Emitter, Event } from '../../../../base/common/event.js'
import { Disposable } from '../../../../base/common/lifecycle.js'
import { URI } from '../../../../base/common/uri.js'
import { isWindows } from '../../../../base/common/platform.js'
import { IFileService } from '../../../../platform/files/common/files.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js'
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js'
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js'
import { ISearchService, IFileQuery, ITextQuery, QueryType } from '../../../services/search/common/search.js'
import { IEditCodeService } from './editCodeServiceInterface.js'
import { ITerminalToolService } from './terminalToolService.js'
import { LintErrorItem, BuiltinToolCallParams, BuiltinToolResultType, BuiltinToolName, TerminalResolveReason } from '../common/toolsServiceTypes.js'
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
import { wrapNonInteractive } from '../common/commandSanitizer.js';
import { IEditorService, SIDE_GROUP } from '../../../services/editor/common/editorService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IExternalCommandExecutor } from './externalCommandExecutor.js';
import { IPowerModeService } from '../../powerMode/browser/powerModeService.js';
import { IWorkflowAgentService } from '../../neuralInverse/browser/workflowAgentService.js';
import type { INeuralInverseSubAgentService } from './neuralInverseSubAgentService.js';
import { IUserInputRequestService } from './userInputRequestService.js';
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

// Normalize a model-provided path to a forward-slash path, resolving relatives against the workspace root.
// Models receive fsPath-style absolute paths (e.g. c:\repo\src\a.ts) from glob/grep/list — a `/`-prefix
// check misclassifies those on Windows and produced joined paths like `c:\repo/c:\repo\a.ts` (ENOENT).
const normalizeToolPath = (filePath: string, workspaceDir: string): string => {
	const p = filePath.replace(/\\/g, '/')
	const root = workspaceDir.replace(/\\/g, '/')
	// Absolute: Windows drive (c:/… or /c:/…), UNC (//server/…), or a POSIX path already inside the root.
	// A plain single-slash path like /app/functions.php is a common model habit for a workspace-relative
	// file — joining it matches the old behavior and avoids file:///app/… ENOENTs on Windows.
	const isAbsolute = /^\/?[a-zA-Z]:\//.test(p) || p.startsWith('//')
		|| (p.startsWith('/') && root.startsWith('/') && p.toLowerCase().startsWith(root.toLowerCase() + '/'))
	if (isAbsolute) return p
	return `${root}/${p.replace(/^\//, '')}`
}


// We are NOT checking to make sure in workspace
// workspaceRootUri: when set, plain paths are resolved using the workspace root's scheme
// (e.g. vscode-remote:// in Coder) instead of always using file://.
const makeValidateURI = (workspaceRootUri: URI | undefined) => (uriStr: unknown): URI => {
	if (uriStr === null) throw new Error(`Invalid LLM output: uri was null.`)
	if (typeof uriStr !== 'string') throw new Error(`Invalid LLM output format: Provided uri must be a string, but it's a(n) ${typeof uriStr}. Full value: ${JSON.stringify(uriStr)}.`)

	// Already has a scheme — parse as-is
	if (uriStr.includes('://')) {
		try { return URI.parse(uriStr) } catch (e) { throw new Error(`Invalid URI format: ${uriStr}. Error: ${e}`) }
	}

	// Plain path — use workspace root scheme if available (handles vscode-remote://, ssh-remote://, etc.)
	if (workspaceRootUri && workspaceRootUri.scheme !== 'file') {
		// Reconstruct URI with the same scheme/authority but the given path.
		// URI paths always use '/', so normalize Windows-style separators first.
		return workspaceRootUri.with({ path: uriStr.replace(/\\/g, '/') })
	}
	return URI.file(uriStr)
}

const validateURI = makeValidateURI(undefined)

const makeValidateOptionalURI = (workspaceRootUri: URI | undefined) => (uriStr: unknown): URI | null => {
	if (isFalsy(uriStr)) return null
	return makeValidateURI(workspaceRootUri)(uriStr)
}

const _validateOptionalURI = (uriStr: unknown) => {
	if (isFalsy(uriStr)) return null
	return validateURI(uriStr)
}
void _validateOptionalURI;

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

export type TodoItem = { content: string; status: 'pending' | 'in_progress' | 'completed' }

export interface IToolsService {
	readonly _serviceBrand: undefined;
	validateParams: ValidateBuiltinParams;
	callTool: CallBuiltinTool;
	stringOfResult: BuiltinToolResultToString;
	/** Fires when a background terminal finishes — chatThreadService uses this to report back */
	readonly onBackgroundTerminalComplete: Event<{ threadId: string; command: string; output: string; exitCode: number }>
	// Plan Mode + TodoWrite + Worktree state (per-thread, in-memory)
	setCurrentContext(threadId: string): void;
	getThreadPlanMode(threadId: string): boolean;
	getThreadTodos(threadId: string): TodoItem[];
	getThreadWorktree(threadId: string): { path: string; branch: string; name: string } | undefined;
	// Hooks: run .neuralinverse/hooks/<name>.sh with env vars; output with [BLOCK] blocks the tool
	runHook(hookName: string, env: Record<string, string>): Promise<{ output: string; blocked: boolean }>;
	// Slash Commands: list .neuralinverse/commands/*.md files
	getSlashCommands(): Promise<{ name: string; content: string }[]>;
}

export const IToolsService = createDecorator<IToolsService>('ToolsService');

export class ToolsService extends Disposable implements IToolsService {

	readonly _serviceBrand: undefined;

	public validateParams: ValidateBuiltinParams;
	public callTool: CallBuiltinTool;
	public stringOfResult: BuiltinToolResultToString;

	private readonly _onBackgroundTerminalComplete = this._register(new Emitter<{ threadId: string; command: string; output: string; exitCode: number }>())
	readonly onBackgroundTerminalComplete = this._onBackgroundTerminalComplete.event

	private _currentThreadId: string = '';
	private _planModeByThread = new Map<string, boolean>();
	private _todosByThread = new Map<string, TodoItem[]>();
	private _worktreeByThread = new Map<string, { path: string; branch: string; name: string }>();
	private _workspaceDir: string = '/';

	setCurrentContext(threadId: string): void { this._currentThreadId = threadId; }
	getThreadPlanMode(threadId: string): boolean { return this._planModeByThread.get(threadId) ?? false; }
	getThreadTodos(threadId: string): TodoItem[] { return this._todosByThread.get(threadId) ?? []; }
	getThreadWorktree(threadId: string) { return this._worktreeByThread.get(threadId); }

	async runHook(hookName: string, env: Record<string, string>): Promise<{ output: string; blocked: boolean }> {
		try {
			const hookPath = `${this._workspaceDir}/.neuralinverse/hooks/${hookName}.sh`;
			const envPrefix = Object.entries(env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
			const cmd = `test -f ${JSON.stringify(hookPath)} && ${envPrefix} bash ${JSON.stringify(hookPath)} 2>&1 || true`;
			const output = await this.commandExecutor.execute(`hook-${hookName}-${Date.now()}`, cmd, 15_000, 64 * 1024);
			const trimmed = output.trim();
			return { output: trimmed, blocked: trimmed.includes('[BLOCK]') };
		} catch { return { output: '', blocked: false }; }
	}

	getSlashCommands: () => Promise<{ name: string; content: string }[]> = async () => [];

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
		@IExternalCommandExecutor private readonly commandExecutor: IExternalCommandExecutor,
		@IPowerModeService private readonly powerMode: IPowerModeService,
		@IUserInputRequestService private readonly userInputRequestService: IUserInputRequestService,
	) {
		super()
		const queryBuilder = instantiationService.createInstance(QueryBuilder);

		const workspaceRootUri = workspaceContextService.getWorkspace().folders[0]?.uri;
		const workspaceDir = workspaceRootUri?.fsPath ?? '/';
		this._workspaceDir = workspaceDir;

		// Workspace-aware URI validators — use the workspace root scheme (e.g. vscode-remote://)
		// so plain paths like /home/coder/file.ts resolve correctly in serve-web mode.
		const validateURIws = makeValidateURI(workspaceRootUri);
		const validateOptionalURIws = makeValidateOptionalURI(workspaceRootUri);

		// Wire up getSlashCommands to use fileService closure
		this.getSlashCommands = async () => {
			try {
				const dir = workspaceRootUri
					? URI.joinPath(workspaceRootUri, '.neuralinverse/commands')
					: URI.file(`${workspaceDir}/.neuralinverse/commands`);
				const entries = await fileService.resolve(dir);
				if (!entries.children) return [];
				const results: { name: string; content: string }[] = [];
				for (const entry of entries.children) {
					if (entry.isFile && entry.name.endsWith('.md')) {
						const content = await fileService.readFile(entry.resource);
						results.push({ name: entry.name.replace(/\.md$/, ''), content: content.value.toString() });
					}
				}
				return results;
			} catch { return []; }
		};
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

		// Lazy-resolved to avoid circular DI (void → neuralInverse sub-agent)
		let _subAgentService: INeuralInverseSubAgentService | null | undefined;
		const getSubAgentService = (): INeuralInverseSubAgentService | null => {
			if (_subAgentService === undefined) {
				try {
					const INeuralInverseSubAgentServiceId = createDecorator<INeuralInverseSubAgentService>('neuralInverseSubAgentService');
					_subAgentService = instantiationService.invokeFunction(a => a.get(INeuralInverseSubAgentServiceId));
				}
				catch { _subAgentService = null; }
			}
			return _subAgentService;
		};

		// Context Engine service accessors (lazy-resolved)
		const _getSymbolIndex = async () => {
			const { IWorkspaceSymbolIndexService } = await import('../../neuralInverse/browser/context/index/workspaceSymbolIndex.js');
			return instantiationService.invokeFunction(a => a.get(IWorkspaceSymbolIndexService));
		};
		const _getRelevanceScorer = async () => {
			const { IRelevanceScorerService } = await import('../../neuralInverse/browser/context/relevance/relevanceScorer.js');
			return instantiationService.invokeFunction(a => a.get(IRelevanceScorerService));
		};
		const _getContextPacker = async () => {
			const { IContextPackerService } = await import('../../neuralInverse/browser/context/packer/contextPacker.js');
			return instantiationService.invokeFunction(a => a.get(IContextPackerService));
		};
		const _getChangeTracker = async () => {
			const { IChangeTrackerService } = await import('../../neuralInverse/browser/context/tracker/changeTracker.js');
			return instantiationService.invokeFunction(a => a.get(IChangeTrackerService));
		};
		const _getHybridSearch = async () => {
			const { IHybridSearchService } = await import('../../neuralInverse/browser/context/search/hybridSearchService.js');
			return instantiationService.invokeFunction(a => a.get(IHybridSearchService));
		};
		const _getWorkspaceUri = (): string => {
			const folders = workspaceContextService.getWorkspace().folders;
			return folders.length > 0 ? folders[0].uri.toString() : '';
		};

		this.validateParams = {
			// --- Power Mode style tools ---
			bash: (params: RawToolParamsObj) => {
				const command = validateStr('command', params.command ?? params.cmd ?? params.run ?? params.shell ?? params.script)
				const description = (typeof params.description === 'string') ? params.description : (typeof params.desc === 'string' ? params.desc : '')
				const timeout = validateNumber(params.timeout, { default: null })
				return { command, description, timeout }
			},
			read: (params: RawToolParamsObj) => {
				const filePath = validateStr('file_path', params.file_path ?? params.filePath ?? params.path ?? params.file)
				const offset = validateNumber(params.offset, { default: null })
				const limit = validateNumber(params.limit, { default: null })
				return { filePath, offset, limit }
			},
			write: (params: RawToolParamsObj) => {
				const filePath = validateStr('file_path', params.file_path ?? params.filePath ?? params.path ?? params.file ?? params.filename)
				const content = validateStr('content', params.content ?? params.text ?? params.code ?? params.body)
				return { filePath, content }
			},
			edit: (params: RawToolParamsObj) => {
				const filePath = validateStr('file_path', params.file_path ?? params.filePath ?? params.path ?? params.file)
				const oldString = validateStr('old_string', params.old_string ?? params.oldString ?? params.old ?? params.search ?? params.find ?? params.original)
				const newString = validateStr('new_string', params.new_string ?? params.newString ?? params.new ?? params.replace ?? params.replacement)
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
			// (GRC compliance tools removed - Enterprise Edition only)
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
			spawn_agent: (params: RawToolParamsObj) => {
				const role = validateStr('role', params.role)
				const goal = validateStr('goal', params.goal)
				const scopedFiles = validateOptionalStr('scoped_files', params.scoped_files)
				return { role, goal, scopedFiles }
			},
			get_agent_status: (params: RawToolParamsObj) => {
				const agentId = validateStr('agent_id', params.agent_id)
				return { agentId }
			},
			wait_for_agent: (params: RawToolParamsObj) => {
				const agentId = validateStr('agent_id', params.agent_id)
				return { agentId }
			},
			list_agents: (params: RawToolParamsObj) => {
				return {}
			},
			// --- Context Engine ---
			context_search_symbols: (params: RawToolParamsObj) => {
				const query = validateStr('query', params.query)
				const kind = validateOptionalStr('kind', params.kind)
				const filePattern = validateOptionalStr('file_pattern', params.file_pattern)
				return { query, kind, filePattern }
			},
			context_related_files: (params: RawToolParamsObj) => {
				const file = validateOptionalStr('file', params.file)
				const query = validateOptionalStr('query', params.query)
				const maxResults = validateNumber(params.max_results, { default: null })
				return { file, query, maxResults }
			},
			context_file_context: (params: RawToolParamsObj) => {
				const file = validateStr('file', params.file)
				const budget = validateNumber(params.budget, { default: null })
				return { file, budget }
			},
			context_import_graph: (params: RawToolParamsObj) => {
				const file = validateStr('file', params.file)
				const depth = validateNumber(params.depth, { default: null })
				return { file, depth }
			},
			context_recent_edits: (params: RawToolParamsObj) => {
				const withinMinutes = validateNumber(params.within_minutes, { default: null })
				return { withinMinutes }
			},
			context_semantic_search: (params: RawToolParamsObj) => {
				const query = validateStr('query', params.query)
				const maxResults = validateNumber(params.max_results, { default: null })
				const filePattern = validateOptionalStr('file_pattern', params.file_pattern)
				return { query, maxResults, filePattern }
			},
			// ---
			read_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, start_line: startLineUnknown, end_line: endLineUnknown, page_number: pageNumberUnknown } = params
				const uri = validateURIws(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)

				let startLine = validateNumber(startLineUnknown, { default: null })
				let endLine = validateNumber(endLineUnknown, { default: null })

				if (startLine !== null && startLine < 1) startLine = null
				if (endLine !== null && endLine < 1) endLine = null

				return { uri, startLine, endLine, pageNumber }
			},
			ls_dir: (params: RawToolParamsObj) => {
				const { uri: uriStr, page_number: pageNumberUnknown } = params

				const uri = validateURIws(uriStr)
				const pageNumber = validatePageNum(pageNumberUnknown)
				return { uri, pageNumber }
			},
			get_dir_tree: (params: RawToolParamsObj) => {
				const { uri: uriStr, } = params
				const uri = validateURIws(uriStr)
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
				const searchInFolder = validateOptionalURIws(searchInFolderUnknown)
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
				const uri = validateURIws(uriStr);
				const query = validateStr('query', queryUnknown);
				const isRegex = validateBoolean(isRegexUnknown, { default: false });
				return { uri, query, isRegex };
			},

			read_lint_errors: (params: RawToolParamsObj) => {
				const {
					uri: uriUnknown,
				} = params
				const uri = validateURIws(uriUnknown)
				return { uri }
			},

			// ---

			create_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown } = params
				const uri = validateURIws(uriUnknown)
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isFolder }
			},

			delete_file_or_folder: (params: RawToolParamsObj) => {
				const { uri: uriUnknown, is_recursive: isRecursiveUnknown } = params
				const uri = validateURIws(uriUnknown)
				const isRecursive = validateBoolean(isRecursiveUnknown, { default: false })
				const uriStr = validateStr('uri', uriUnknown)
				const isFolder = checkIfIsFolder(uriStr)
				return { uri, isRecursive, isFolder }
			},

			rewrite_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, new_content: newContentUnknown } = params
				const uri = validateURIws(uriStr)
				const newContent = validateStr('newContent', newContentUnknown)
				return { uri, newContent }
			},

			edit_file: (params: RawToolParamsObj) => {
				const { uri: uriStr, search_replace_blocks: searchReplaceBlocksUnknown } = params
				const uri = validateURIws(uriStr)
				const searchReplaceBlocks = validateStr('searchReplaceBlocks', searchReplaceBlocksUnknown)
				return { uri, searchReplaceBlocks }
			},
			multi_replace_file_content: (params: RawToolParamsObj) => {
				const { uri: uriStr, replacement_chunks: replacementChunksUnknown } = params
				const uri = validateURIws(uriStr)
				const replacementChunks = validateStr('replacement_chunks', replacementChunksUnknown)
				return { uri, replacementChunks }
			},

			// ---

			run_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, cwd: cwdUnknown, timeout: timeoutUnknown, bg_after: bgAfterUnknown } = params
				const command = validateStr('command', commandUnknown)
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				const timeout = (typeof timeoutUnknown === 'number' && timeoutUnknown > 0) ? timeoutUnknown : null
				const bgAfter = (typeof bgAfterUnknown === 'number' && bgAfterUnknown > 0) ? bgAfterUnknown : null
				const terminalId = generateUuid()
				return { command, cwd, terminalId, timeout, bgAfter }
			},
			run_background_command: (params: RawToolParamsObj) => {
				const { command: commandUnknown, cwd: cwdUnknown } = params
				const command = validateStr('command', commandUnknown)
				const cwd = validateOptionalStr('cwd', cwdUnknown)
				return { command, cwd }
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

			plan_mode_enter: (_params: RawToolParamsObj) => ({}),
			plan_mode_exit: (_params: RawToolParamsObj) => ({}),
			todo_write: (params: RawToolParamsObj) => ({ todos: typeof params['todos'] === 'string' ? params['todos'] : JSON.stringify(params['todos'] ?? '[]') }),

		}


		this.callTool = {
			// --- Power Mode style tools ---
			bash: async ({ command, description, timeout }) => {
				const jobId = `void_bash_${Date.now()}`
				// On Windows the agent terminal is PowerShell, where `&&` chains and the
				// `env VAR=…` prefix are parser errors — the whole wrapped command died
				// before the user's command ever ran (the tool returned only the echo
				// line). The temporary terminal is already created with the workspace
				// cwd, so on Windows run the raw command with no wrapper at all.
				const fullCommand = isWindows
					? command
					: `cd ${JSON.stringify(workspaceDir)} && ${wrapNonInteractive(command)}`
				const { resultPromise, interrupt: interruptTool } = this.commandExecutor.executeWithInterrupt(jobId, fullCommand, timeout ?? 3_600_000, MAX_PM_OUTPUT)
				const result = resultPromise.then(output => {
					const truncated = output.length > MAX_PM_OUTPUT ? output.substring(0, MAX_PM_OUTPUT) + '\n[Output truncated at 50KB]' : output
					return { result: truncated }
				}).catch((err: any) => {
					return { result: `Error: ${err.message}${err.stderr ? '\n' + err.stderr : ''}` }
				})
				return { result, interruptTool }
			},
			read: async ({ filePath, offset, limit: readLimit }) => {
				const normalizedPath = normalizeToolPath(filePath, workspaceDir)
				const uri = validateURIws(normalizedPath)
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
				const normalizedPath = normalizeToolPath(filePath, workspaceDir)
				const uri = validateURIws(normalizedPath)
				try {
					// If path has no file extension, model is trying to create a directory
					const basename = normalizedPath.split('/').pop() || '';
					if (!basename.includes('.') && (!content || content.trim() === '')) {
						await fileService.createFolder(uri);
						return { result: { result: `Created directory: ${normalizedPath}` } }
					}
					// Auto-create parent directories (like mkdir -p)
					const parentUri = URI.file(normalizedPath.substring(0, normalizedPath.lastIndexOf('/')))
					try { await fileService.createFolder(parentUri); } catch { /* already exists */ }
					await fileService.writeFile(uri, VSBuffer.fromString(content))
					return { result: { result: `Successfully wrote ${content.split('\n').length} lines to ${normalizedPath}` } }
				} catch (err: any) {
					return { result: { result: `Error writing file: ${err.message}` } }
				}
			},
			edit: async ({ filePath, oldString, newString }) => {
				const normalizedPath = normalizeToolPath(filePath, workspaceDir)
				const uri = validateURIws(normalizedPath)
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
				const folderUri = validateURIws(normalizeToolPath(searchPath ?? workspaceDir, workspaceDir))
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
				const folderUri = validateURIws(normalizeToolPath(searchPath ?? workspaceDir, workspaceDir))
				try {
					// Per-file cap: without it, a handful of files with dozens of
					// matches each ate the whole result budget and the model saw
					// "a few files" instead of the full picture across the repo.
					const MAX_GREP_RESULTS = 1000
					const MAX_MATCHES_PER_FILE = 15
					const matchesPerFile = new Map<string, number>()
					const query: ITextQuery = {
						type: QueryType.Text,
						contentPattern: { pattern, isRegExp: true, isCaseSensitive: false },
						folderQueries: [{ folder: folderUri }],
						includePattern: include ? { [include]: true } : undefined,
						excludePattern: { '**/node_modules': true, '**/.git': true },
						maxResults: MAX_GREP_RESULTS,
					}
					const matches: string[] = []
					await searchService.textSearch(query, undefined, (item) => {
						if ('resource' in item) {
							const fm = item as { resource: { fsPath: string }; results?: Array<{ rangeLocations?: Array<{ source: { startLineNumber: number } }>; previewText?: string }> }
							const file = fm.resource.fsPath
							for (const res of fm.results ?? []) {
								const soFar = matchesPerFile.get(file) ?? 0
								if (soFar >= MAX_MATCHES_PER_FILE) continue
								matchesPerFile.set(file, soFar + 1)
								const line = res.rangeLocations?.[0]?.source.startLineNumber ?? 0
								matches.push(`${file}:${line}: ${(res.previewText ?? '').trim()}`)
							}
						}
					})
					const output = matches.join('\n') || 'No matches found.'
					if (matches.length >= MAX_GREP_RESULTS) {
						return { result: { result: output + `\n[Result limit reached (${MAX_GREP_RESULTS} matches, max ${MAX_MATCHES_PER_FILE}/file). Narrow the pattern or search per subdirectory.]` } }
					}
					return { result: { result: output.length > MAX_PM_OUTPUT ? output.substring(0, MAX_PM_OUTPUT) + '\n[Output truncated]' : output } }
				} catch (err: any) {
					return { result: { result: `Error: ${err.message}` } }
				}
			},
			list: async ({ dirPath }) => {
				const uri = validateURIws(normalizeToolPath(dirPath ?? workspaceDir, workspaceDir))
				try {
					const resolved = await fileService.resolve(uri)
					const entries = (resolved.children ?? []).map(c => `${c.isDirectory ? 'd' : '-'} ${c.name}`).sort().join('\n')
					return { result: { result: entries || '(empty directory)' } }
				} catch (err: any) {
					return { result: { result: `Error: ${err.message}` } }
				}
			},
			// (GRC compliance tool implementations removed - Enterprise Edition only)
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
				let requestId: string | null = null
				const resultPromise: Promise<{ result: string }> = new Promise((resolve, reject) => {
					this.userInputRequestService.request(question).then(answer => {
						resolve({ result: answer })
					}).catch(() => {
						reject(new Error('ask_user cancelled'))
					})
					const pending = [...this.userInputRequestService.pendingRequests.values()]
					if (pending.length > 0) requestId = pending[pending.length - 1].id
				})
				const interruptTool = () => {
					if (requestId) this.userInputRequestService.cancel(requestId)
				}
				return { result: resultPromise, interruptTool }
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
					const dirUri = validateURIws(memoryDir);
					await fileService.createFolder(dirUri).catch(() => { /* already exists */ });

					// Write memory
					const fileUri = validateURIws(memoryFile);
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
					const fileUri = validateURIws(memoryFile);
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
			spawn_agent: async ({ role, goal, scopedFiles }) => {
				const subAgentService = getSubAgentService();
				if (!subAgentService) {
					throw new Error('Sub-agent service unavailable. This feature requires the Neural Inverse sub-agent service.');
				}

				// Parse scoped files if provided
				const scopedFilesArray = scopedFiles
					? scopedFiles.split(',').map(f => f.trim()).filter(f => f.length > 0)
					: undefined;

				// Let sub-agent service determine parent context from active agent task
				// This will show the agent activity inline in the UI with tool calls
				const agent = subAgentService.spawn({
					role: role as any, // SubAgentRole
					goal,
					scopedFiles: scopedFilesArray,
					// Don't pass parentContext - let it use the active agent task
				});

				if (!agent) {
					throw new Error('Failed to spawn agent. Maximum concurrent agents reached or service unavailable.');
				}

				const shortId = agent.id.substring(0, 8);
				const hasWriteAccess = (role === 'editor' || role === 'verifier');
				const accessNote = hasWriteAccess
					? '\n⚠ Has write/edit/bash access'
					: '';

				return {
					result: {
						result: `Agent ${shortId} spawned and running in background${accessNote}\nGoal: ${goal}\n\nUse wait_for_agent with agent_id="${shortId}" to get results.`,
						// Structured metadata for UI components
						agentId: agent.id,
						shortId,
						role,
						goal,
						hasWriteAccess,
						status: agent.status,
					},
				};
			},
			get_agent_status: async ({ agentId }) => {
				const subAgentService = getSubAgentService();
				if (!subAgentService) {
					throw new Error('Sub-agent service unavailable.');
				}

				const agents = Array.from(subAgentService.subAgents.values());
				// Support both full UUID and short ID (first 8 chars)
				const agent = agents.find(a => a.id === agentId || a.id.startsWith(agentId));

				if (!agent) {
					throw new Error(`No agent found with ID: ${agentId}`);
				}

				const shortId = agent.id.substring(0, 8);
				const statusIcon = agent.status === 'completed' ? '✓' : agent.status === 'failed' ? '✗' : agent.status === 'running' ? '●' : '○';

				// Calculate elapsed time
				const startTime = new Date(agent.createdAt).getTime();
				const endTime = agent.completedAt ? new Date(agent.completedAt).getTime() : Date.now();
				const elapsed = endTime - startTime;
				const elapsedSeconds = Math.floor(elapsed / 1000);
				const elapsedMinutes = Math.floor(elapsedSeconds / 60);
				const remainingSeconds = elapsedSeconds % 60;
				const elapsedStr = elapsedMinutes > 0 ? `${elapsedMinutes}m ${remainingSeconds}s` : `${elapsedSeconds}s`;

				let result = `Agent ${shortId} [${agent.role}]\nStatus: ${statusIcon} ${agent.status} · ${elapsedStr}`;

				if (agent.status === 'running') {
					result += `\n\nGoal: ${agent.goal}`;
				} else if (agent.status === 'completed' && agent.result) {
					result += `\n\nResult:\n${agent.result}`;
				} else if (agent.status === 'failed' && agent.error) {
					result += `\n\nError:\n${agent.error}`;
				}

				return { result: { result } };
			},
			wait_for_agent: async ({ agentId }) => {
				const subAgentService = getSubAgentService();
				if (!subAgentService) {
					throw new Error('Sub-agent service unavailable.');
				}

				// Poll until complete (max 5 minutes)
				const startTime = Date.now();
				const timeout = 5 * 60 * 1000; // 5 minutes

				while (Date.now() - startTime < timeout) {
					const agents = Array.from(subAgentService.subAgents.values());
					const agent = agents.find(a => a.id === agentId || a.id.startsWith(agentId));

					if (!agent) {
						throw new Error(`No agent found with ID: ${agentId}`);
					}

					// Terminal states
					if (agent.status === 'completed' || agent.status === 'failed' || agent.status === 'cancelled') {
						const shortId = agent.id.substring(0, 8);
						const totalElapsed = Date.now() - startTime;
						const elapsedSeconds = Math.floor(totalElapsed / 1000);
						const elapsedMinutes = Math.floor(elapsedSeconds / 60);
						const remainingSeconds = elapsedSeconds % 60;
						const elapsedStr = elapsedMinutes > 0 ? `${elapsedMinutes}m ${remainingSeconds}s` : `${elapsedSeconds}s`;

						if (agent.status === 'completed' && agent.result) {
							return {
								result: {
									result: `✓ Agent ${shortId} completed in ${elapsedStr}\n\nResult:\n${agent.result}`,
									// Metadata for UI components
									agentId: agent.id,
									role: agent.role,
									goal: agent.goal,
									duration: elapsedStr,
								},
							};
						} else if (agent.status === 'failed' && agent.error) {
							throw new Error(`Agent ${shortId} failed: ${agent.error}`);
						} else {
							throw new Error(`Agent ${shortId} was cancelled`);
						}
					}

					// Still running, wait 2 seconds before checking again
					await new Promise(resolve => setTimeout(resolve, 2000));
				}

				// Timeout
				throw new Error(`Agent ${agentId} did not complete within 5 minutes`);
			},
			list_agents: async () => {
				const subAgentService = getSubAgentService();
				if (!subAgentService) {
					throw new Error('Sub-agent service unavailable.');
				}

				const agents = Array.from(subAgentService.subAgents.values());

				if (agents.length === 0) {
					return { result: { result: 'No sub-agents have been spawned yet.' } };
				}

				const running = agents.filter(a => a.status === 'running');
				const pending = agents.filter(a => a.status === 'pending');
				const completed = agents.filter(a => a.status === 'completed');
				const failed = agents.filter(a => a.status === 'failed');

				const formatElapsed = (createdAt: string, completedAt?: string) => {
					const start = new Date(createdAt).getTime();
					const end = completedAt ? new Date(completedAt).getTime() : Date.now();
					const elapsed = Math.floor((end - start) / 1000);
					const minutes = Math.floor(elapsed / 60);
					const seconds = elapsed % 60;
					return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
				};

				let output = `Total: ${agents.length} agents\n\n`;

				if (running.length > 0) {
					output += `● Running (${running.length})\n`;
					for (const a of running) {
						const elapsed = formatElapsed(a.createdAt);
						output += `  ${a.id.substring(0, 8)} [${a.role}] · ${elapsed}\n  └─ ${a.goal.substring(0, 55)}${a.goal.length > 55 ? '...' : ''}\n\n`;
					}
				}

				if (pending.length > 0) {
					output += `○ Pending (${pending.length})\n`;
					for (const a of pending) {
						output += `  ${a.id.substring(0, 8)} [${a.role}]\n  └─ ${a.goal.substring(0, 60)}${a.goal.length > 60 ? '...' : ''}\n\n`;
					}
				}

				if (completed.length > 0) {
					output += `✓ Completed (${completed.length})\n`;
					for (const a of completed) {
						const elapsed = formatElapsed(a.createdAt, a.completedAt);
						output += `  ${a.id.substring(0, 8)} [${a.role}] · ${elapsed}\n`;
					}
					output += '\n';
				}

				if (failed.length > 0) {
					output += `✗ Failed (${failed.length})\n`;
					for (const a of failed) {
						const elapsed = formatElapsed(a.createdAt, a.completedAt);
						const errorMsg = a.error?.substring(0, 40) || 'Unknown error';
						output += `  ${a.id.substring(0, 8)} [${a.role}] · ${elapsed}\n  └─ ${errorMsg}${a.error && a.error.length > 40 ? '...' : ''}\n\n`;
					}
				}

				return { result: { result: output } };
			},
			// --- Context Engine ---
			context_search_symbols: async ({ query, kind, filePattern }) => {
				const { executeSearchSymbols } = await import('../../neuralInverse/browser/context/tools/searchSymbolsTool.js')
				const symbolIndex = await _getSymbolIndex()
				const results = executeSearchSymbols({ query, kind: kind ?? undefined, filePattern: filePattern ?? undefined }, symbolIndex)
				if (results.length === 0) {
					return { result: { result: `No symbols found matching "${query}"` } }
				}
				const output = results.map(r => `${r.name} (kind:${r.kind}) ${r.file}:${r.line}${r.exported ? ` [export: ${r.exported}]` : ''}`).join('\n')
				return { result: { result: `Found ${results.length} symbol(s):\n${output}` } }
			},
			context_related_files: async ({ file, query, maxResults }) => {
				const { executeGetRelatedFiles } = await import('../../neuralInverse/browser/context/tools/getRelatedFilesTool.js')
				const relevanceScorer = await _getRelevanceScorer()
				const wsUri = _getWorkspaceUri()
				const results = executeGetRelatedFiles(
					{ file: file ?? undefined, query: query ?? undefined, maxResults: maxResults ?? undefined },
					relevanceScorer, wsUri,
				)
				if (results.length === 0) {
					return { result: { result: 'No related files found.' } }
				}
				const output = results.map(r => {
					const path = r.uri.replace(wsUri + '/', '')
					return `${(r.score * 100).toFixed(0)}% ${path} [${r.reasons.join(', ')}]`
				}).join('\n')
				return { result: { result: `Related files:\n${output}` } }
			},
			context_file_context: async ({ file, budget }) => {
				const { executeGetFileContext } = await import('../../neuralInverse/browser/context/tools/getFileContextTool.js')
				const contextPacker = await _getContextPacker()
				const wsUri = _getWorkspaceUri()
				const packed = await executeGetFileContext({ file, budget: budget ?? undefined }, contextPacker, wsUri)
				return { result: { result: packed || `No context available for "${file}"` } }
			},
			context_import_graph: async ({ file, depth }) => {
				const { executeGetImportGraph } = await import('../../neuralInverse/browser/context/tools/getImportGraphTool.js')
				const symbolIndex = await _getSymbolIndex()
				const wsUri = _getWorkspaceUri()
				const result = executeGetImportGraph({ file, depth: depth ?? undefined }, symbolIndex, wsUri)
				const wsPrefix = wsUri + '/'
				const shorten = (uri: string) => uri.startsWith(wsPrefix) ? uri.slice(wsPrefix.length) : uri
				const parts: string[] = []
				parts.push(`Imports (${result.imports.length}):`)
				for (const imp of result.imports.slice(0, 50)) { parts.push(`  -> ${shorten(imp)}`) }
				if (result.imports.length > 50) parts.push(`  ... and ${result.imports.length - 50} more`)
				parts.push(`\nImported by (${result.importers.length}):`)
				for (const imp of result.importers.slice(0, 50)) { parts.push(`  <- ${shorten(imp)}`) }
				if (result.importers.length > 50) parts.push(`  ... and ${result.importers.length - 50} more`)
				return { result: { result: parts.join('\n') } }
			},
			context_recent_edits: async ({ withinMinutes }) => {
				const { executeGetRecentEdits } = await import('../../neuralInverse/browser/context/tools/getRecentEditsTool.js')
				const changeTracker = await _getChangeTracker()
				const results = executeGetRecentEdits({ withinMinutes: withinMinutes ?? undefined }, changeTracker)
				if (results.length === 0) {
					return { result: { result: 'No recent edits detected.' } }
				}
				const output = results.map(r => {
					const path = r.uri.split('/').slice(-3).join('/')
					const ago = Math.round((Date.now() - r.lastEditAt) / 1000)
					return `${path} | heat: ${(r.heat * 100).toFixed(0)}% | ${r.velocity.toFixed(1)} edits/min | ${ago}s ago`
				}).join('\n')
				return { result: { result: `Recently edited (${results.length}):\n${output}` } }
			},
			context_semantic_search: async ({ query, maxResults, filePattern }) => {
				const hybridSearch = await _getHybridSearch()
				const limit = maxResults ?? 15
				const results = await hybridSearch.search(query, limit)
				if (results.length === 0) {
					const status = hybridSearch.getStatus()
					return { result: { result: `No results for "${query}". Index has ${status.bm25Files} files indexed.` } }
				}
				const filtered = filePattern
					? results.filter(r => r.filePath.includes(filePattern))
					: results
				const output = filtered.map(r => {
					const shortPath = r.filePath.split('/').slice(-3).join('/')
					const scoreStr = (r.score * 100).toFixed(0)
					const sources = r.sources.join('+')
					const symbol = r.symbolName ? ` [${r.symbolName}]` : ''
					const snippet = r.content.split('\n').slice(0, 5).join('\n').trim()
					return `## ${shortPath}${symbol} (score: ${scoreStr}%, via: ${sources})\nLines ${r.startLine}-${r.endLine}:\n\`\`\`\n${snippet}\n\`\`\``
				}).join('\n\n')
				return { result: { result: `Found ${filtered.length} results for "${query}":\n\n${output}` } }
			},
			// ---
			read_file: async ({ uri, startLine, endLine, pageNumber }) => {
				let contents: string
				let totalNumLines: number
				// The text-model service only tracks files inside the opened
				// workspace. Absolute paths OUTSIDE it (git worktrees are the
				// common case — task protocols run agents in worktrees) used to
				// fail with "No contents; File does not exist." even though the
				// file was on disk. Fall back to a raw read for those.
				try { await voidModelService.initializeModel(uri) } catch { /* out-of-workspace — raw fallback below */ }
				const { model } = await voidModelService.getModelSafe(uri)
				if (model === null) {
					if (uri.scheme !== 'file') { throw new Error(`No contents; File does not exist.`) }
					let raw: string
					try {
						raw = (await fileService.readFile(uri)).value.toString()
					} catch (e: any) {
						throw new Error(`No contents; File does not exist. (${e?.message ?? e})`)
					}
					const lines = raw.split('\n')
					const startLineNumber = startLine === null ? 1 : startLine
					const endLineNumber = endLine === null ? lines.length : endLine
					contents = lines.slice(startLineNumber - 1, endLineNumber).join('\n')
					totalNumLines = lines.length
				}
				else if (startLine === null && endLine === null) {
					contents = model.getValue(EndOfLinePreference.LF)
					totalNumLines = model.getLineCount()
				}
				else {
					const startLineNumber = startLine === null ? 1 : startLine
					const endLineNumber = endLine === null ? model.getLineCount() : endLine
					contents = model.getValueInRange({ startLineNumber, startColumn: 1, endLineNumber, endColumn: Number.MAX_SAFE_INTEGER }, EndOfLinePreference.LF)
					totalNumLines = model.getLineCount()
				}

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
				if (!Array.isArray(chunks) || chunks.length === 0) {
					throw new Error(`replacement_chunks must be a non-empty JSON array. Each chunk needs {StartLine, EndLine, TargetContent, ReplacementContent}. Received: ${String(replacementChunks).slice(0, 200)}`)
				}
				// An empty TargetContent matches at position 0 of the search region (edits the wrong line),
				// and a missing ReplacementContent splices the literal "undefined" into the file.
				for (let ci = 0; ci < chunks.length; ci++) {
					const c = chunks[ci]
					if (typeof c?.TargetContent !== 'string' || typeof c?.ReplacementContent !== 'string') {
						throw new Error(`replacement_chunks[${ci}] must have string fields TargetContent and ReplacementContent (use "" to delete text). Received: ${JSON.stringify(chunks[ci])?.slice(0, 200)}`)
					}
					if (c.TargetContent === '') {
						throw new Error(`replacement_chunks[${ci}].TargetContent is empty — an empty search string is ambiguous. Provide the exact text to replace.`)
					}
				}

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
			run_command: async ({ command: rawCommand, cwd, terminalId, timeout, bgAfter }) => {
				const command = this._injectCoAuthorIfGitCommit(rawCommand);
				const commitGateMsg = this._checkCommitGate(command);
				if (commitGateMsg) {
					return { result: Promise.resolve({ resolveReason: { type: 'done' as const, exitCode: 1 }, result: commitGateMsg }) }
				}
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'temporary', cwd, terminalId, inactivityTimeoutSec: timeout ?? undefined })

				// Build a shared result promise that can be resolved early by bg_after timer OR user "Move to BG" click
				const result = new Promise<{ result: string, resolveReason: TerminalResolveReason }>(async (resolve, reject) => {
					// User-triggered "Move to BG" button
					const threadIdAtPromotion = this._currentThreadId
					const fireWhenDone = (bgTerminalId: string) => {
						resPromise.then(r => {
							this._onBackgroundTerminalComplete.fire({
								threadId: threadIdAtPromotion,
								command,
								output: r.result,
								exitCode: (r.resolveReason as any).exitCode ?? 0,
							})
						}).catch(() => {
							this._onBackgroundTerminalComplete.fire({
								threadId: threadIdAtPromotion,
								command,
								output: `Terminal ${bgTerminalId} was closed before completing.`,
								exitCode: 1,
							})
						})
					}

					const promoteListener = this.terminalToolService.onPromoteToBackground(async ({ terminalId: firedId }) => {
						if (firedId !== terminalId) return
						promoteListener.dispose()
						try {
							const bgTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd })
							fireWhenDone(bgTerminalId)
							resolve({
								resolveReason: { type: 'done' as const, exitCode: 0 },
								result: `Command moved to background. The result will be reported back to you automatically when it finishes.`,
							})
						} catch {
							resolve({
								resolveReason: { type: 'done' as const, exitCode: 0 },
								result: `Command moved to background. The result will be reported back to you automatically when it finishes.`,
							})
						}
					})

					if (!bgAfter) {
						try {
							const r = await resPromise
							resolve(r)
						} catch (err) {
							// A throw inside an async Promise executor does NOT reject the
							// outer promise — without this, a failed command left the tool
							// call pending forever and hung the whole agent loop.
							reject(err)
						} finally {
							promoteListener.dispose()
						}
						return
					}

					// bg_after: watch for N seconds, then promote to background if still running
					const bgAfterMs = bgAfter * 1000
					try {
						const winner = await Promise.race([
							resPromise.then(r => ({ kind: 'done' as const, r })),
							new Promise<{ kind: 'timeout' }>(res => setTimeout(() => res({ kind: 'timeout' }), bgAfterMs)),
						])
						promoteListener.dispose()

						if (winner.kind === 'done') {
							resolve(winner.r)
							return
						}
					} catch (err) {
						promoteListener.dispose()
						reject(err)
						return
					}

					// Still running after bgAfter seconds — promote to background persistent terminal
					try {
						const bgTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd })
						fireWhenDone(bgTerminalId)
						resolve({
							resolveReason: { type: 'done' as const, exitCode: 0 },
							result: `Command still running after ${bgAfter}s, moved to background. The result will be reported back to you automatically when it finishes.`,
						})
					} catch {
						resolve({
							resolveReason: { type: 'done' as const, exitCode: 0 },
							result: `Command still running after ${bgAfter}s, moved to background. The result will be reported back to you automatically when it finishes.`,
						})
					}
				})

				return { result, interruptTool: interrupt }
			},
			run_background_command: async ({ command: rawCommand, cwd }) => {
				const command = this._injectCoAuthorIfGitCommit(rawCommand);
				const commitGateMsg = this._checkCommitGate(command);
				if (commitGateMsg) {
					return { result: Promise.resolve({ resolveReason: { type: 'done' as const, exitCode: 1 }, result: commitGateMsg }) }
				}
				const persistentTerminalId = await this.terminalToolService.createPersistentTerminal({ cwd })
				const { resPromise } = await this.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId })
				const threadId = this._currentThreadId
				resPromise.then(r => {
					// Only a REAL completion is reported as finished — a quiet-timeout
					// resolve just means the command is running silently; the agent can
					// poll it with read_terminal.
					if (r.resolveReason.type === 'done') {
						this._onBackgroundTerminalComplete.fire({ threadId, command, output: r.result, exitCode: r.resolveReason.exitCode ?? 0 })
					}
				}).catch(() => {
					this._onBackgroundTerminalComplete.fire({ threadId, command, output: `Terminal was closed before completing.`, exitCode: 1 })
				})
				return { result: Promise.resolve({ resolveReason: { type: 'done' as const, exitCode: 0 }, result: `Command started in background terminal ${persistentTerminalId}. It can never time out. When it finishes you will receive a [SYSTEM: Background terminal finished] message with its output — do NOT re-run it. Use read_terminal with terminal_id=${persistentTerminalId} to check progress in the meantime.` }) }
			},
			run_persistent_command: async ({ command: rawCommand, persistentTerminalId }) => {
				const command = this._injectCoAuthorIfGitCommit(rawCommand);
				const commitGateMsg = this._checkCommitGate(command);
				if (commitGateMsg) {
					return { result: Promise.resolve({ resolveReason: { type: 'done' as const, exitCode: 1 }, result: commitGateMsg }) }
				}
				const { resPromise, interrupt } = await this.terminalToolService.runCommand(command, { type: 'persistent', persistentTerminalId })
				const threadId = this._currentThreadId
				resPromise.then(r => {
					this._onBackgroundTerminalComplete.fire({
						threadId,
						command,
						output: r.result,
						exitCode: (r.resolveReason as any).exitCode ?? 0,
					})
				}).catch(() => {
					this._onBackgroundTerminalComplete.fire({ threadId, command, output: 'Terminal was closed before completing.', exitCode: 1 })
				})
				// Return immediately so the agent loop continues
				const immediateResult = Promise.resolve({ resolveReason: { type: 'done' as const, exitCode: 0 }, result: `Command started in background. The result will be reported back automatically when it finishes.` })
				return { result: immediateResult, interruptTool: interrupt }
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

			plan_mode_enter: async () => {
				this._planModeByThread.set(this._currentThreadId, true);
				return { result: { result: 'Plan mode activated. You are now in read-only exploration mode. File writes and edits are blocked until you call plan_mode_exit. Think through the full implementation before making any changes.' } };
			},

			plan_mode_exit: async () => {
				this._planModeByThread.set(this._currentThreadId, false);
				return { result: { result: 'Plan mode deactivated. You may now make file edits and execute commands.' } };
			},

			todo_write: async ({ todos }) => {
				try {
					const parsed: TodoItem[] = JSON.parse(todos);
					const allDone = parsed.length > 0 && parsed.every(t => t.status === 'completed');
					this._todosByThread.set(this._currentThreadId, allDone ? [] : parsed);
					const pending = parsed.filter(t => t.status === 'pending').length;
					const inProgress = parsed.filter(t => t.status === 'in_progress').length;
					const done = parsed.filter(t => t.status === 'completed').length;
					return { result: { result: `Todo list updated: ${inProgress} in progress, ${pending} pending, ${done} completed.` } };
				} catch {
					return { result: { result: 'Failed to parse todos JSON.' } };
				}
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
			// (GRC compliance stringOfResult removed - Enterprise Edition only)
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
			spawn_agent: (_params, result) => result.result,
			get_agent_status: (_params, result) => result.result,
			wait_for_agent: (_params, result) => result.result,
			list_agents: (_params, result) => result.result,
			// --- Context Engine ---
			context_search_symbols: (_params, result) => result.result,
			context_related_files: (_params, result) => result.result,
			context_file_context: (_params, result) => result.result,
			context_import_graph: (_params, result) => result.result,
			context_recent_edits: (_params, result) => result.result,
			context_semantic_search: (_params, result) => result.result,
			// ---
			read_file: (params, result) => {
				// An empty page means the model paged past the end of the file
				// (read_file serves whole pages; the OSS wrapper used to cut
				// them mid-file, which made models page forward into nothing).
				// Say it explicitly instead of an empty code fence.
				if (result.fileContents === '' && (params.pageNumber ?? 1) > 1) {
					return `${params.uri.fsPath}\n(no more content — page ${params.pageNumber} is beyond the end of this ${result.totalNumLines}-line file)`
				}
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

			run_background_command: (_params, result) => {
				return result.result;
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
			plan_mode_enter: (_params, result) => result.result,
			plan_mode_exit: (_params, result) => result.result,
			todo_write: (_params, result) => result.result,
		}



	}


	private _getFileGRCViolations(_uri: URI): string {
		// GRC not available in community edition
		return '';
	}

	private _checkCommitGate(_command: string): string | null {
		// GRC commit gate not available in community edition
		return null;
	}

	private _injectCoAuthorIfGitCommit(command: string): string {
		if (command.includes('Co-authored-by:')) { return command; }
		const pattern = /(git\s+commit\s+(?:[^-]*\s+)?-m\s+)(["'])([\s\S]*?)\2/;
		const match = command.match(pattern);
		if (!match) { return command; }

		const platform = 'Co-authored-by: neuralinverse-dev <noreply@neuralinverse.com>';
		const sel = this.voidSettingsService.state.modelSelectionOfFeature['Chat'];
		const provider = (sel?.providerName ?? '').toLowerCase();
		const model = (sel?.modelName ?? '').toLowerCase();
		let llmTrailer: string;
		if (provider.includes('openai') || model.includes('gpt') || model.includes('chatgpt') || model.includes('o1') || model.includes('o3') || model.includes('o4')) {
			llmTrailer = 'Co-authored-by: ChatGPT <noreply@openai.com>';
		} else if (provider.includes('google') || model.includes('gemini') || model.includes('gemma')) {
			llmTrailer = 'Co-authored-by: Gemini <noreply@google.com>';
		} else if (provider.includes('deepseek') || model.includes('deepseek')) {
			llmTrailer = 'Co-authored-by: DeepSeek <noreply@deepseek.com>';
		} else if (provider.includes('mistral') || model.includes('mistral') || model.includes('codestral')) {
			llmTrailer = 'Co-authored-by: Mistral <noreply@mistral.ai>';
		} else if (provider.includes('meta') || model.includes('llama')) {
			llmTrailer = 'Co-authored-by: Meta AI <noreply@meta.com>';
		} else {
			llmTrailer = 'Co-authored-by: Claude <noreply@anthropic.com>';
		}

		const trailers = `\n\n${platform}\n${llmTrailer}`;
		const newMsg = match[3] + trailers;
		return command.replace(pattern, `$1$2${newMsg}$2`);
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
