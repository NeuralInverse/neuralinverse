/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { ModelSelection, OverridesOfModel, ProviderName, providerNames, displayInfoOfProviderName } from '../common/voidSettingsTypes.js';
import { getModelCapabilities } from '../common/modelCapabilities.js';
import { ChatEntitlementContextKeys } from '../../../services/chat/common/chatEntitlementService.js';
import {
	ILanguageModelsService,
	ILanguageModelChatProvider,
	ILanguageModelChatMetadata,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatInfoOptions,
	ILanguageModelChatRequestOptions,
	ILanguageModelChatResponse,
	IChatMessage,
	IChatResponsePart,
	ChatMessageRole,
	IUserFriendlyLanguageModel,
} from '../../chat/common/languageModels.js';
import {
	IChatAgentImplementation,
	IChatAgentResult,
	IChatAgentService,
	IChatAgentHistoryEntry,
	IChatAgentRequest,
} from '../../chat/common/participants/chatAgents.js';
import { ConfirmedReason, IChatProgress, IChatToolInvocation, ToolConfirmKind } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import { LLMChatMessage, LLMUsage, OpenAILLMChatMessage, RawToolCallObj } from '../common/sendLLMMessageTypes.js';
import { ILanguageModelToolsService, IToolData, ToolDataSource } from '../../chat/common/tools/languageModelToolsService.js';
import { ChatToolInvocation } from '../../chat/common/model/chatProgressTypes/chatToolInvocation.js';
import { waitForState } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IToolsService } from './toolsService.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { extractXMLToolsWrapper } from '../common/llmMessage/extractGrammar.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { InternalToolInfo, isABuiltinToolName } from '../common/prompt/prompts.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolName } from '../common/toolsServiceTypes.js';
import { IContextLedgerService } from './contextLedgerService.js';
import { IVoidInternalToolService } from './voidInternalToolService.js';
import { ILedgerAppendInput, ILedgerEntry } from '../common/ledgerTypes.js';
import { chatSessionResourceToId } from '../../chat/common/model/chatUri.js';
import { DEFAULT_LEDGER_POLICY, availableInputTokens, estimateTokens } from '../common/ledgerPolicy.js';
import { isContextOverflowError } from './conversationCompactor.js';
import { resolveCloseBoundary } from '../common/ledgerBoundary.js';
import { buildWorkingBrief } from '../common/workingBriefBuilder.js';
import { EpisodeSummarizer } from '../common/episodeSummarizer.js';
import { applyLoopBudget } from '../common/loopBudget.js';
import { migrateLegacyTurns } from '../common/ledgerTurns.js';
import { assembleLedgerPayload } from '../common/ledgerPayload.js';
import { contiguousCoverage } from '../common/ledgerJournalCore.js';

const NI_EXTENSION_ID = new ExtensionIdentifier('neuralInverse.void');
const NI_AGENT_ID = 'neuralInverse.default';
const MAX_TOOL_ITERATIONS = 20;

/** The vendor entry the model picker groups our BYOLLM models under. */
const NI_PROVIDER_DESCRIPTOR: IUserFriendlyLanguageModel = {
	vendor: 'neuralInverse',
	displayName: 'Neural Inverse',
	// Models come from the Void settings pane, not a contributed configuration,
	// and the provider is always available — so these three carry no value.
	configuration: undefined,
	managementCommand: undefined,
	when: undefined,
};

/** A streamed text chunk, typed at construction so callers need no assertion. */
const textPart = (value: string): IChatResponsePart => ({ type: 'text', value });

/**
 * Message of a thrown value. `catch` binds `unknown`, and providers throw a mix
 * of Error, string, and API error objects, so narrow before reading `.message`.
 */
function messageOfThrown(e: unknown): string {
	if (e instanceof Error) { return e.message; }
	if (typeof e === 'object' && e !== null) {
		const m = (e as { message?: unknown }).message;
		if (typeof m === 'string') { return m; }
	}
	return String(e);
}

/** Per-tool display metadata for the native chat pill UI. */
interface VoidToolMeta {
	displayName: string;
	icon: ThemeIcon;
	/** Present-tense label shown while executing, e.g. "Reading main.ts" */
	invocationLabel: (params: Record<string, string | undefined>) => string;
	/** Past-tense label shown after completion, e.g. "Read main.ts" */
	pastTenseLabel: (params: Record<string, string | undefined>) => string;
}

const _p = (params: Record<string, string | undefined>, key: string, fallback: string) =>
	(params[key] ?? params[key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] ?? fallback).split('/').pop() ?? fallback;

const VOID_TOOL_META: Partial<Record<BuiltinToolName, VoidToolMeta>> = {
	// --- file read ---
	read_file: {
		displayName: 'Read File', icon: ThemeIcon.fromId(Codicon.book.id),
		invocationLabel: p => `Reading \`${_p(p, 'uri', 'file')}\``,
		pastTenseLabel: p => `Read \`${_p(p, 'uri', 'file')}\``,
	},
	read: {
		displayName: 'Read File', icon: ThemeIcon.fromId(Codicon.book.id),
		invocationLabel: p => `Reading \`${_p(p, 'file_path', 'file')}\``,
		pastTenseLabel: p => `Read \`${_p(p, 'file_path', 'file')}\``,
	},
	ls_dir: {
		displayName: 'List Directory', icon: ThemeIcon.fromId(Codicon.folder.id),
		invocationLabel: p => `Listing \`${_p(p, 'uri', '.')}\``,
		pastTenseLabel: p => `Listed \`${_p(p, 'uri', '.')}\``,
	},
	get_dir_tree: {
		displayName: 'Directory Tree', icon: ThemeIcon.fromId(Codicon.folder.id),
		invocationLabel: p => `Building tree for \`${_p(p, 'uri', '.')}\``,
		pastTenseLabel: p => `Built tree for \`${_p(p, 'uri', '.')}\``,
	},
	list: {
		displayName: 'List Directory', icon: ThemeIcon.fromId(Codicon.folder.id),
		invocationLabel: p => `Listing \`${_p(p, 'dir_path', '.')}\``,
		pastTenseLabel: p => `Listed \`${_p(p, 'dir_path', '.')}\``,
	},
	// --- file write/edit ---
	write: {
		displayName: 'Write File', icon: ThemeIcon.fromId(Codicon.tools.id),
		invocationLabel: p => `Writing \`${_p(p, 'file_path', 'file')}\``,
		pastTenseLabel: p => `Wrote \`${_p(p, 'file_path', 'file')}\``,
	},
	edit: {
		displayName: 'Edit File', icon: ThemeIcon.fromId(Codicon.tools.id),
		invocationLabel: p => `Editing \`${_p(p, 'file_path', 'file')}\``,
		pastTenseLabel: p => `Edited \`${_p(p, 'file_path', 'file')}\``,
	},
	edit_file: {
		displayName: 'Edit File', icon: ThemeIcon.fromId(Codicon.tools.id),
		invocationLabel: p => `Editing \`${_p(p, 'uri', 'file')}\``,
		pastTenseLabel: p => `Edited \`${_p(p, 'uri', 'file')}\``,
	},
	rewrite_file: {
		displayName: 'Rewrite File', icon: ThemeIcon.fromId(Codicon.tools.id),
		invocationLabel: p => `Rewriting \`${_p(p, 'uri', 'file')}\``,
		pastTenseLabel: p => `Rewrote \`${_p(p, 'uri', 'file')}\``,
	},
	multi_replace_file_content: {
		displayName: 'Edit File', icon: ThemeIcon.fromId(Codicon.tools.id),
		invocationLabel: p => `Editing \`${_p(p, 'uri', 'file')}\``,
		pastTenseLabel: p => `Edited \`${_p(p, 'uri', 'file')}\``,
	},
	create_file_or_folder: {
		displayName: 'Create File', icon: ThemeIcon.fromId(Codicon.tools.id),
		invocationLabel: p => `Creating \`${_p(p, 'uri', 'path')}\``,
		pastTenseLabel: p => `Created \`${_p(p, 'uri', 'path')}\``,
	},
	delete_file_or_folder: {
		displayName: 'Delete File', icon: ThemeIcon.fromId(Codicon.tools.id),
		invocationLabel: p => `Deleting \`${_p(p, 'uri', 'path')}\``,
		pastTenseLabel: p => `Deleted \`${_p(p, 'uri', 'path')}\``,
	},
	// --- search ---
	grep: {
		displayName: 'Search Files', icon: ThemeIcon.fromId(Codicon.references.id),
		invocationLabel: p => `Searching for \`${p['pattern'] ?? ''}\``,
		pastTenseLabel: p => `Searched for \`${p['pattern'] ?? ''}\``,
	},
	glob: {
		displayName: 'Find Files', icon: ThemeIcon.fromId(Codicon.references.id),
		invocationLabel: p => `Finding \`${p['pattern'] ?? ''}\``,
		pastTenseLabel: p => `Found files matching \`${p['pattern'] ?? ''}\``,
	},
	search_for_files: {
		displayName: 'Search Files', icon: ThemeIcon.fromId(Codicon.references.id),
		invocationLabel: p => `Searching for \`${p['query'] ?? ''}\``,
		pastTenseLabel: p => `Searched for \`${p['query'] ?? ''}\``,
	},
	search_pathnames_only: {
		displayName: 'Find Files', icon: ThemeIcon.fromId(Codicon.references.id),
		invocationLabel: p => `Finding \`${p['query'] ?? ''}\``,
		pastTenseLabel: p => `Found files for \`${p['query'] ?? ''}\``,
	},
	search_in_file: {
		displayName: 'Search in File', icon: ThemeIcon.fromId(Codicon.references.id),
		invocationLabel: p => `Searching \`${_p(p, 'uri', 'file')}\``,
		pastTenseLabel: p => `Searched \`${_p(p, 'uri', 'file')}\``,
	},
	read_lint_errors: {
		displayName: 'Read Lint Errors', icon: ThemeIcon.fromId(Codicon.references.id),
		invocationLabel: p => `Reading lint errors in \`${_p(p, 'uri', 'file')}\``,
		pastTenseLabel: p => `Read lint errors in \`${_p(p, 'uri', 'file')}\``,
	},
	// --- terminal ---
	bash: {
		displayName: 'Run Command', icon: ThemeIcon.fromId(Codicon.terminal.id),
		invocationLabel: p => `Running \`${(p['command'] ?? '').slice(0, 60)}\``,
		pastTenseLabel: p => `Ran \`${(p['command'] ?? '').slice(0, 60)}\``,
	},
	run_command: {
		displayName: 'Run Command', icon: ThemeIcon.fromId(Codicon.terminal.id),
		invocationLabel: p => `Running \`${(p['command'] ?? '').slice(0, 60)}\``,
		pastTenseLabel: p => `Ran \`${(p['command'] ?? '').slice(0, 60)}\``,
	},
	run_persistent_command: {
		displayName: 'Run Command', icon: ThemeIcon.fromId(Codicon.terminal.id),
		invocationLabel: p => `Running \`${(p['command'] ?? '').slice(0, 60)}\``,
		pastTenseLabel: p => `Ran \`${(p['command'] ?? '').slice(0, 60)}\``,
	},
	open_persistent_terminal: {
		displayName: 'Open Terminal', icon: ThemeIcon.fromId(Codicon.terminal.id),
		invocationLabel: _ => 'Opening terminal',
		pastTenseLabel: _ => 'Opened terminal',
	},
	read_terminal: {
		displayName: 'Read Terminal', icon: ThemeIcon.fromId(Codicon.terminal.id),
		invocationLabel: _ => 'Reading terminal output',
		pastTenseLabel: _ => 'Read terminal output',
	},
	send_command_input: {
		displayName: 'Send Input', icon: ThemeIcon.fromId(Codicon.terminal.id),
		invocationLabel: _ => 'Sending terminal input',
		pastTenseLabel: _ => 'Sent terminal input',
	},
	kill_persistent_terminal: {
		displayName: 'Kill Terminal', icon: ThemeIcon.fromId(Codicon.terminal.id),
		invocationLabel: _ => 'Killing terminal',
		pastTenseLabel: _ => 'Killed terminal',
	},
	// --- context engine ---
	context_semantic_search: {
		displayName: 'Semantic Search', icon: ThemeIcon.fromId(Codicon.references.id),
		invocationLabel: p => `Searching for \`${p['query'] ?? ''}\``,
		pastTenseLabel: p => `Searched for \`${p['query'] ?? ''}\``,
	},
	context_search_symbols: {
		displayName: 'Search Symbols', icon: ThemeIcon.fromId(Codicon.references.id),
		invocationLabel: p => `Searching symbols for \`${p['query'] ?? ''}\``,
		pastTenseLabel: p => `Searched symbols for \`${p['query'] ?? ''}\``,
	},
	context_related_files: {
		displayName: 'Related Files', icon: ThemeIcon.fromId(Codicon.references.id),
		invocationLabel: p => `Finding related files for \`${p['file'] ?? p['query'] ?? ''}\``,
		pastTenseLabel: p => `Found related files for \`${p['file'] ?? p['query'] ?? ''}\``,
	},
	context_file_context: {
		displayName: 'File Context', icon: ThemeIcon.fromId(Codicon.book.id),
		invocationLabel: p => `Loading context for \`${_p(p, 'file', 'file')}\``,
		pastTenseLabel: p => `Loaded context for \`${_p(p, 'file', 'file')}\``,
	},
	context_import_graph: {
		displayName: 'Import Graph', icon: ThemeIcon.fromId(Codicon.references.id),
		invocationLabel: p => `Analyzing imports of \`${_p(p, 'file', 'file')}\``,
		pastTenseLabel: p => `Analyzed imports of \`${_p(p, 'file', 'file')}\``,
	},
	context_recent_edits: {
		displayName: 'Recent Edits', icon: ThemeIcon.fromId(Codicon.references.id),
		invocationLabel: _ => 'Reading recent edits',
		pastTenseLabel: _ => 'Read recent edits',
	},
	// --- agent/workflow ---
	update_agent_status: {
		displayName: 'Update Status', icon: ThemeIcon.fromId(Codicon.play.id),
		invocationLabel: p => p['task_name'] ?? 'Updating status',
		pastTenseLabel: p => p['task_name'] ?? 'Updated status',
	},
	spawn_agent: {
		displayName: 'Spawn Agent', icon: ThemeIcon.fromId(Codicon.agent.id),
		invocationLabel: p => `Spawning agent: ${(p['goal'] ?? '').slice(0, 60)}`,
		pastTenseLabel: p => `Spawned agent: ${(p['goal'] ?? '').slice(0, 60)}`,
	},
	wait_for_agent: {
		displayName: 'Wait for Agent', icon: ThemeIcon.fromId(Codicon.agent.id),
		invocationLabel: _ => 'Waiting for agent',
		pastTenseLabel: _ => 'Agent complete',
	},
	get_agent_status: {
		displayName: 'Agent Status', icon: ThemeIcon.fromId(Codicon.agent.id),
		invocationLabel: _ => 'Checking agent status',
		pastTenseLabel: _ => 'Checked agent status',
	},
	list_agents: {
		displayName: 'List Agents', icon: ThemeIcon.fromId(Codicon.agent.id),
		invocationLabel: _ => 'Listing agents',
		pastTenseLabel: _ => 'Listed agents',
	},
	ask_powermode: {
		displayName: 'Ask Power Mode', icon: ThemeIcon.fromId(Codicon.agent.id),
		invocationLabel: p => `Asking Power Mode: ${(p['question'] ?? '').slice(0, 60)}`,
		pastTenseLabel: p => `Asked Power Mode: ${(p['question'] ?? '').slice(0, 60)}`,
	},
	query_ni_agent: {
		displayName: 'Run NI Agent', icon: ThemeIcon.fromId(Codicon.agent.id),
		invocationLabel: p => `Running agent \`${p['agent_id'] ?? ''}\``,
		pastTenseLabel: p => `Ran agent \`${p['agent_id'] ?? ''}\``,
	},
	ask_user: {
		displayName: 'Ask User', icon: ThemeIcon.fromId(Codicon.info.id),
		invocationLabel: p => (p['question'] ?? 'Asking user').slice(0, 80),
		pastTenseLabel: _ => 'Asked user',
	},
	web_fetch: {
		displayName: 'Fetch URL', icon: ThemeIcon.fromId(Codicon.browser.id),
		invocationLabel: p => `Fetching \`${p['url'] ?? ''}\``,
		pastTenseLabel: p => `Fetched \`${p['url'] ?? ''}\``,
	},
	generate_document: {
		displayName: 'Generate Document', icon: ThemeIcon.fromId(Codicon.notebook.id),
		invocationLabel: p => `Generating \`${p['title'] ?? 'document'}\``,
		pastTenseLabel: p => `Generated \`${p['title'] ?? 'document'}\``,
	},
	memory_write: {
		displayName: 'Save Memory', icon: ThemeIcon.fromId(Codicon.book.id),
		invocationLabel: p => `Saving \`${p['key'] ?? 'memory'}\``,
		pastTenseLabel: p => `Saved \`${p['key'] ?? 'memory'}\``,
	},
	memory_read: {
		displayName: 'Read Memory', icon: ThemeIcon.fromId(Codicon.book.id),
		invocationLabel: p => `Reading \`${p['key'] ?? 'memory'}\``,
		pastTenseLabel: p => `Read \`${p['key'] ?? 'memory'}\``,
	},
	tasks_create: {
		displayName: 'Create Task', icon: ThemeIcon.fromId(Codicon.tasklist.id),
		invocationLabel: p => `Creating task: ${p['title'] ?? ''}`,
		pastTenseLabel: p => `Created task: ${p['title'] ?? ''}`,
	},
	tasks_list: {
		displayName: 'List Tasks', icon: ThemeIcon.fromId(Codicon.tasklist.id),
		invocationLabel: _ => 'Listing tasks',
		pastTenseLabel: _ => 'Listed tasks',
	},
	tasks_update: {
		displayName: 'Update Task', icon: ThemeIcon.fromId(Codicon.tasklist.id),
		invocationLabel: p => `Updating task ${p['task_id'] ?? ''}`,
		pastTenseLabel: p => `Updated task ${p['task_id'] ?? ''}`,
	},
	tasks_get: {
		displayName: 'Get Task', icon: ThemeIcon.fromId(Codicon.tasklist.id),
		invocationLabel: p => `Getting task ${p['task_id'] ?? ''}`,
		pastTenseLabel: p => `Got task ${p['task_id'] ?? ''}`,
	},
	plan_mode_enter: {
		displayName: 'Enter Plan Mode', icon: ThemeIcon.fromId(Codicon.play.id),
		invocationLabel: _ => 'Entering plan mode',
		pastTenseLabel: _ => 'Entered plan mode',
	},
	plan_mode_exit: {
		displayName: 'Exit Plan Mode', icon: ThemeIcon.fromId(Codicon.play.id),
		invocationLabel: _ => 'Exiting plan mode',
		pastTenseLabel: _ => 'Exited plan mode',
	},
	todo_write: {
		displayName: 'Update Todo List', icon: ThemeIcon.fromId(Codicon.tasklist.id),
		invocationLabel: _ => 'Updating todo list',
		pastTenseLabel: _ => 'Updated todo list',
	},
};

/** Tools whose result is a file-list — rendered as a clickable URI list widget. */
const FILE_LIST_TOOLS = new Set<BuiltinToolName>([
	'glob', 'grep', 'search_for_files', 'search_pathnames_only',
]);

/** Tools that use the search indicator pill (no input/output body). */
const SEARCH_PILL_TOOLS = new Set<BuiltinToolName>([
	'context_semantic_search', 'context_search_symbols', 'context_related_files',
]);

/** Tools with no meaningful result to show (hidden output). */
const HIDDEN_OUTPUT_TOOLS = new Set<BuiltinToolName>(['update_agent_status', 'plan_mode_enter', 'plan_mode_exit']);

/**
 * Build the toolSpecificData payload for the chat pill UI after a void tool has executed.
 * - FILE_LIST_TOOLS → IChatToolResourcesInvocationData (clickable file list widget)
 * - SEARCH_PILL_TOOLS → IChatSearchToolInvocationData (search indicator)
 * - everything else → IChatSimpleToolInvocationData (collapsible input + output code blocks)
 */
function buildToolSpecificData(
	toolName: BuiltinToolName,
	inputSummary: string,
	resultText: string,
	isError: boolean,
) {
	if (SEARCH_PILL_TOOLS.has(toolName)) {
		return { kind: 'search' as const };
	}

	if (FILE_LIST_TOOLS.has(toolName)) {
		// Parse file paths out of the result — void returns newline-separated paths
		const uris: URI[] = [];
		for (const line of resultText.split('\n')) {
			const trimmed = line.trim();
			if (trimmed.startsWith('/') || trimmed.startsWith('file://')) {
				try { uris.push(URI.parse(trimmed.startsWith('file://') ? trimmed : `file://${trimmed}`)); } catch { /* skip */ }
			}
		}
		if (uris.length > 0) {
			return { kind: 'resources' as const, values: uris };
		}
		// Fall through to simpleToolInvocation if no URIs parsed
	}

	return {
		kind: 'simpleToolInvocation' as const,
		input: inputSummary,
		output: HIDDEN_OUTPUT_TOOLS.has(toolName) ? '' : resultText,
	};
}

/**
 * Convert a Copilot IToolData → InternalToolInfo so void's prompt system can inject
 * tool schemas (XML format) into the LLM system message via mcpTools.
 * The tool's JSON Schema `properties` become param descriptions.
 */
function copilotToolToInternalToolInfo(tool: IToolData): InternalToolInfo {
	const params: { [paramName: string]: { description: string } } = {};
	const props = tool.inputSchema?.properties;
	if (props) {
		for (const [key, val] of Object.entries(props)) {
			const schema = val as { description?: string; type?: string };
			params[key] = { description: schema.description ?? schema.type ?? key };
		}
	}
	return {
		name: tool.id,
		description: tool.modelDescription,
		params,
	};
}

/** Resolve context from request variables — string entries inline, file URIs via read_file */
async function resolveContext(
	request: IChatAgentRequest,
	toolsService: IToolsService,
): Promise<string> {
	const parts: string[] = [];
	for (const v of request.variables.variables) {
		const label = (v as { name?: string }).name ?? (v as { kind?: string }).kind ?? 'context';

		if (typeof v.value === 'string' && v.value.length > 0) {
			parts.push(`<context name="${label}">\n${v.value}\n</context>`);
			continue;
		}

		const complexVal = v.value as { value?: string } | undefined;
		if (complexVal && typeof complexVal.value === 'string' && complexVal.value.length > 0) {
			parts.push(`<context name="${label}">\n${complexVal.value}\n</context>`);
			continue;
		}

		// File URI — read via void's read_file tool
		if (v.value && typeof (v.value as { scheme?: string }).scheme === 'string') {
			try {
				const callResult = await toolsService.callTool.read_file({
					uri: v.value as import('../../../../base/common/uri.js').URI,
					startLine: null,
					endLine: null,
					pageNumber: 1,
				});
				const fileResult = await callResult.result;
				if (fileResult.fileContents) {
					parts.push(`<context name="${label}">\n${fileResult.fileContents}\n</context>`);
				}
			} catch {
				// best-effort
			}
		}
	}
	return parts.join('\n\n');
}

class VoidChatAgentImpl implements IChatAgentImplementation {

	constructor(
		private readonly _settingsService: IVoidSettingsService,
		private readonly _llmMessageService: ILLMMessageService,
		private readonly _lmToolsService: ILanguageModelToolsService,
		private readonly _toolsService: IToolsService,
		private readonly _convertService: IConvertToLLMMessageService,
		private readonly _contextLedgerService: IContextLedgerService,
		private readonly _internalToolService: IVoidInternalToolService,
	) { }

	/**
	 * Best-effort journal write for the native chat (task A7 item 3). The sidebar
	 * journals every message through chatThreadService; requests arriving here
	 * were invisible to the ledger, so this surface had no archive, no
	 * compaction and nothing for `recall_history` to find. Failures are
	 * swallowed on purpose: a ledger problem must never break a chat turn.
	 */
	private _journal(threadId: string, input: ILedgerAppendInput): Promise<ILedgerEntry | null> {
		if (!this._settingsService.state.globalSettings.contextLedgerEnabled) { return Promise.resolve(null); }
		return this._contextLedgerService.append(threadId, input).catch(() => null);
	}

	private _ledgerSummarizer: EpisodeSummarizer | undefined;
	private _getLedgerSummarizer(): EpisodeSummarizer {
		if (!this._ledgerSummarizer) { this._ledgerSummarizer = new EpisodeSummarizer(this._llmMessageService); }
		return this._ledgerSummarizer;
	}

	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		const state = this._settingsService.state;

		// Resolve model selection from picker or Chat feature default
		let modelSelection = state.modelSelectionOfFeature['Chat'];
		if (request.userSelectedModelId) {
			const match = request.userSelectedModelId.match(/^ni:([^:]+):(.+)$/);
			if (match) {
				modelSelection = { providerName: match[1] as ProviderName, modelName: match[2] };
			}
		}

		if (!modelSelection) {
			progress([{ kind: 'markdownContent', content: new MarkdownString('No model selected. Open Neural Inverse LLM Settings and select a model for Chat.') }]);
			return {};
		}

		// /compact slash command — fold the ledger's open episode into a
		// summary, freeing context budget. The native chat panel uses the
		// ledger directly; the sidebar has its own compactThread method.
		if (request.command === 'compact') {
			const ledgerThreadId = chatSessionResourceToId(request.sessionResource);
			const stats = await this._contextLedgerService.stats(ledgerThreadId);
			if (!stats || stats.entryCount === 0) {
				progress([{ kind: 'markdownContent', content: new MarkdownString('Nothing to compact — the conversation is short enough.') }]);
				return {};
			}
			progress([{ kind: 'markdownContent', content: new MarkdownString('Compacting conversation…') }]);
			try {
				const freed = await this._compactLedgerThread(ledgerThreadId, modelSelection);
				if (freed <= 0) {
					progress([{ kind: 'markdownContent', content: new MarkdownString('Nothing to compact — the conversation does not meet the compaction threshold yet.') }]);
					return {};
				}
				const freedK = freed >= 1000 ? `${(freed / 1000).toFixed(1)}k` : `${freed}`;
				progress([{ kind: 'markdownContent', content: new MarkdownString(`✅ Context compacted — ${freedK} tokens freed. The next request is built from the ledger brief + the uncovered tail.`) }]);
			} catch (e) {
				progress([{ kind: 'markdownContent', content: new MarkdownString(`Compaction failed: ${e instanceof Error ? e.message : String(e)}`) }]);
			}
			return {};
		}

		// Resolve context from attached files/pastes — prepend to first user message so the
		// system message is built entirely by void's pipeline (workspace + tool schemas via chatMode).
		const contextText = await resolveContext(request, this._toolsService);
		const userMessage = contextText.length > 0
			? `<attached_context>\n${contextText}\n</attached_context>\n\n${request.message}`
			: request.message;

		// Collect all Copilot in-process tools (terminal, rename, usages, editFile, confirmations,
		// browser tools, testing tools, subagent, etc.) and convert to void's InternalToolInfo.
		// These are passed as mcpTools — void's sendLLMMessage appends them to the agent tool list.
		// ni_* tools (voidToolsBridge) are excluded: void's own builtin tool execution handles them.
		// Honour the tool picker: when the user has narrowed the tool set for this request,
		// offering the model everything registered is how a disabled tool still gets called
		// (task A7 item 1). An entry missing from the map means "not chosen"; an empty/absent
		// map means the user never narrowed anything, so everything stays available.
		const userSelectedTools = request.userSelectedTools;
		const isToolAllowed = (toolId: string): boolean =>
			!userSelectedTools || Object.keys(userSelectedTools).length === 0 || userSelectedTools[toolId] === true;
		const copilotMcpTools: InternalToolInfo[] = Array.from(this._lmToolsService.getTools(undefined))
			.filter(t => !t.id.startsWith('ni_'))
			.filter(t => isToolAllowed(t.id))
			.map(copilotToolToInternalToolInfo);

		// Void internal tools (ledger recall, discovery, …) are part of the
		// sidebar's tool list for agent chatModes (chatThreadService merges
		// internalToolService.getToolInfos() the same way). The bridge must
		// offer AND execute them too, or the system message advertises tools
		// the loop can never run — exactly how recall_history went missing in
		// the owner's live test (task A8). Internal tools win name conflicts.
		const allBridgeTools: InternalToolInfo[] = (() => {
			const seen = new Set<string>();
			return [...this._internalToolService.getToolInfos(), ...copilotMcpTools]
				.filter(t => {
					if (seen.has(t.name)) { return false; }
					seen.add(t.name);
					return true;
				})
				.slice(0, 128); // API hard limit
		})();

		// Build message history as plain OpenAI-style messages.
		// Do NOT pass a systemMessage here — chatMode:'agent' in sendLLMMessage triggers void's
		// pipeline to build the full system message (workspace context + all tool schemas).
		// Passing an empty string would create an empty Anthropic system block (API error).
		// One ledger thread per chat session, so a resumed session keeps its archive.
		const ledgerThreadId = chatSessionResourceToId(request.sessionResource);
		// R2: turns that predate the journal (ledger enabled late, a failed
		// append, a cleared archive) are migrated INTO the ledger before the
		// current message is appended, so the journal stays chronological and
		// stays a superset of the session history. T3: the return value is the
		// contiguous coverage the journal CONFIRMED — the send path may claim
		// exactly that (and nothing more) in the coverage note/watermark.
		const migratedThrough = await this._migrateLegacyTurns(ledgerThreadId, history);
		// F01 lifecycle: a DUE episode closes on the normal send path too —
		// not only on /compact and context-overflow — so the brief this
		// request is assembled from reflects the policy threshold (R7)
		await this._closeLedgerEpisode(ledgerThreadId, modelSelection, {}).catch(() => 0);
		// awaited: the assembly below reads the journal, and the current message
		// must already be part of it (it enters the payload exactly once — from
		// the ledger, never duplicated from the session rebuild). meta.turn is
		// the stable turn marker the migration matcher keys on.
		const appendedEntry = await this._journal(ledgerThreadId, {
			role: 'user',
			content: userMessage,
			meta: { turn: history.length },
		});
		// U1/T3: the durable coverage note — it claims exactly the COMPLETED
		// turns the migration receipt confirmed, and NOTHING more. The current
		// turn is deliberately NOT certified here: its assistant answer does
		// not exist yet (the LLM has not run), and certifying it would make a
		// failed answer write permanently unrecoverable. The next send
		// verifies this turn (user marker + assistant marker) and advances
		// the watermark then. T4/U2: the same value is persisted as the
		// meta.json watermark, which no bounded journal window can lose and
		// which only becomes durable together with this note's flush.
		if (appendedEntry !== null && migratedThrough >= 0) {
			const noted = await this._journal(ledgerThreadId, {
				role: 'note',
				content: 'turn-coverage-v2',
				meta: { coveredThrough: migratedThrough },
			});
			if (noted !== null) {
				this._contextLedgerService.recordTurnCoverage(ledgerThreadId, migratedThrough).catch(() => { });
			}
		}

		// F01 fallback: the Copilot session rebuild — markdown-only, no tool
		// results, no compaction. Used when the ledger is off/empty or fails;
		// the ledger path replaces it entirely otherwise.
		const fallbackMessages: OpenAILLMChatMessage[] = [];
		for (const turn of history) {
			fallbackMessages.push({ role: 'user', content: turn.request.message });
			const assistantText = turn.response
				.filter(r => r.kind === 'markdownContent')
				.map(r => (r as { kind: string; content: { value: string } }).content.value)
				.join('');
			if (assistantText) { fallbackMessages.push({ role: 'assistant', content: assistantText }); }
		}
		fallbackMessages.push({ role: 'user', content: userMessage });

		// F01: the ledger payload — brief + everything the frozen episodes do
		// not cover, tool results included, budget-aware. The current request
		// travels with its JOURNAL SEQ (the append receipt) so the payload can
		// be PROVEN to carry it exactly once — wherever it sits — and a failed
		// append is repaired rather than silently sent without it (S1/S3).
		const assembled = await this._assembleNativePayload(
			ledgerThreadId,
			fallbackMessages,
			modelSelection,
			{ message: userMessage, seq: appendedEntry !== null ? (appendedEntry.seq ?? null) : null },
		);
		const llmMessages: OpenAILLMChatMessage[] = assembled.messages;
		// S1: the budget's mandatory anchor is this index — never guessed from
		// message text. Loop appends only AFTER it, so the index stays valid.
		let currentUserIdx = assembled.currentRequestIdx;

		// Build the full system message in the renderer where workspace/editor services are available.
		// chatMode:'agent' in generateSystemMessage includes: workspace folders, open files, dir tree,
		// XML tool schemas for all 40+ void builtins + copilotMcpTools injected via mcpTools param.
		// We then pass chatMode:null to sendLLMMessage (system message already constructed) and apply
		// extractXMLToolsWrapper manually so tool XML never leaks to the chat display.
		const { providerName: pn, modelName: mn } = modelSelection;
		let systemMessage = await this._convertService.generateSystemMessage('agent', undefined, undefined, pn, mn);

		// Hybrid agent memory (tasks M2/A8): the sidebar path injects these
		// instructions via prepareLLMChatMessages — which the bridge bypasses —
		// so it appends the same block itself (the workspace-rules pattern from
		// E1). Seeded with the user's message so recall works in fresh chats.
		// F09: getAIInstructionsForChat already carries the workspace rules —
		// the separate <workspace_rules> append used to inject every rule file
		// TWICE into the native system message, so it is gone.
		const aiInstructions = await this._convertService.getAIInstructionsForChat(userMessage);
		if (aiInstructions) {
			systemMessage = `${systemMessage}\n\n${aiInstructions}`;
		}

		// Append Copilot mode instructions (custom instructions from .github/copilot-instructions.md
		// or a custom Chat mode) so user-configured personas carry through to the NI backend.
		const modeInstructions = request.modeInstructions?.content;
		if (modeInstructions && modeInstructions.trim().length > 0) {
			systemMessage = `${systemMessage}\n\n<copilot_instructions>\n${modeInstructions.trim()}\n</copilot_instructions>`;
		}

		// Agentic tool loop
		const loopMessages = [...llmMessages];
		const { overridesOfModel } = state;
		const { contextWindow, reservedOutputTokenSpace } = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel);
		// F10: the tool schemas reach the provider SEPARATELY from the system
		// message (sendLLMMessage serialises them into the prompt) — the
		// window accounting must measure them, not assume them away (R1)
		const toolDefTokens = estimateTokens(allBridgeTools
			.map(t => JSON.stringify({ name: t.name, description: t.description, params: t.params }))
			.join('\n'));
		const loopArchiveNote = state.globalSettings.contextLedgerEnabled
			? 'the ledger archive preserves the original, recall_history can retrieve it'
			: 'the original content is no longer part of this request';
		let iterations = 0;
		let overflowRetried = false;
		while (iterations < MAX_TOOL_ITERATIONS) {
			if (token.isCancellationRequested) { break; }
			iterations++;

			// F01/F10: the window is enforced on EVERY loop send — in-loop tool
			// results grow the payload exactly when nobody is looking. R1/S1:
			// the current request (by index) and the brief are mandatory,
			// oversized tool results are shortened in place — cumulatively
			// when the savings must be distributed (S5) — and an infeasible
			// payload STOPS the turn instead of silently sending a request
			// without the user's message.
			const budgeted = applyLoopBudget(
				loopMessages,
				availableInputTokens(contextWindow, (reservedOutputTokenSpace ?? 4_096) + estimateTokens(systemMessage) + toolDefTokens),
				loopArchiveNote,
				{ currentRequestIdx: currentUserIdx },
			);
			if (budgeted.infeasible) {
				console.warn(`[ChatThread] native loop infeasible: mandatory payload ${budgeted.infeasible.mandatoryTokens} tokens > ${budgeted.infeasible.availableTokens} available — refusing to send`);
				progress([{ kind: 'markdownContent', content: new MarkdownString('This request does not fit the selected model\u2019s context window — even after trimming history and shortening tool results. Reduce the attached context or start a new conversation.') }]);
				return {};
			}
			if (budgeted.foldedCount > 0 || budgeted.truncatedCount > 0) {
				console.warn(`[ChatThread] native loop over budget: folded ${budgeted.foldedCount} messages, shortened ${budgeted.truncatedCount} tool results`);
				loopMessages.length = 0;
				loopMessages.push(...budgeted.messages as OpenAILLMChatMessage[]);
				// T1: trimming replaced the array — the mandatory anchor must
				// follow the current request into the NEW array, or the next
				// send protects whatever message now occupies the old position
				currentUserIdx = budgeted.currentRequestIdx;
			}

			let text: string;
			let toolCalls: RawToolCallObj[] | undefined;
			let usage: LLMUsage | undefined;
			try {
				({ text, toolCalls, usage } = await this._callLLM(
					loopMessages, modelSelection, state, allBridgeTools, systemMessage, token
				));
			} catch (e) {
				// bounded recovery: a context-length rejection folds the covered
				// prefix into a frozen episode and the payload is rebuilt once —
				// the provider's own refusal drives the compaction, so this can
				// not loop forever (cancellation still honored)
				if (overflowRetried || token.isCancellationRequested || !isContextOverflowError(e instanceof Error ? e.message : String(e))) { throw e; }
				overflowRetried = true;
				console.warn('[ChatThread] native request hit the context window — compacting the ledger and retrying once');
				progress([{ kind: 'markdownContent', content: new MarkdownString('Context window exhausted — compacting the conversation and retrying…') }]);
				await this._compactLedgerThread(ledgerThreadId, modelSelection);
				// S3: the rebuilt payload re-anchors the current request by its
				// journal seq — after tool activity it legitimately sits EARLIER
				// in the window, and a last-message check would re-append it
				const rebuilt = await this._assembleNativePayload(ledgerThreadId, fallbackMessages, modelSelection, { message: userMessage, seq: appendedEntry !== null ? (appendedEntry.seq ?? null) : null });
				loopMessages.length = 0;
				loopMessages.push(...rebuilt.messages);
				// keep the loop's mandatory anchor pointing at the CURRENT
				// request in the rebuilt array (appends still happen after it)
				currentUserIdx = rebuilt.currentRequestIdx;
				continue;
			}

			if (token.isCancellationRequested) { break; }

			// Feed the native context gauge (task A7 item 4). It reads
			// `response.usage`, which the chat model sets from this progress part.
			// Reported per iteration, not once at the end: `promptTokens` is how
			// full the window is right now, and an agent turn can call the model
			// many times, so the last one is the number the user needs to see.
			// The core accumulates `completionTokens` across the turn itself.
			if (usage) {
				progress([{
					kind: 'usage',
					promptTokens: usage.input,
					completionTokens: usage.output,
					actualModelId: `ni:${modelSelection.providerName}:${modelSelection.modelName}`,
				}]);
			}

			// R7: the assistant record carries the tool calls it ISSUED (ids as
			// the model named them), so the payload rebuild can render the
			// tool-call side of each interaction, not only bare results. The
			// bridged terminal/edit tools regenerate their call ids below —
			// those results pair by name instead of id.
			const issuedCalls = (toolCalls ?? [])
				.map(c => ({ id: typeof c.id === 'string' && c.id ? c.id : generateUuid(), name: String(c.name) }))
				.filter(c => c.name);
			if (text.length > 0 || issuedCalls.length > 0) {
				if (text.length > 0) {
					progress([{ kind: 'markdownContent', content: new MarkdownString(text) }]);
				}
				this._journal(ledgerThreadId, {
					role: 'assistant',
					content: text,
					meta: {
						model: `${modelSelection.providerName}/${modelSelection.modelName}`,
						// U1: the turn marker makes this answer's presence
						// marker-exact for the next migration — a missing
						// answer is repaired instead of certified
						turn: history.length,
						...(usage ? { usage: { input: usage.input, output: usage.output } } : {}),
						...(issuedCalls.length > 0 ? { toolCalls: issuedCalls } : {}),
					},
				});
			}

			if (!toolCalls || toolCalls.length === 0) { break; }

			// Keep assistant turn in history
			loopMessages.push({ role: 'assistant', content: text || '' });

			// Execute each tool call.
			// Routing:
			//   1. Terminal void tools (bash/run_command/run_persistent_command) → run_in_terminal
			//      Gets: live terminal streaming UI, confirmation pill, auto-approve, background mode
			//   2. File-write void tools (edit_file/rewrite_file/write/edit/multi_replace) → vscode_editFile_internal
			//      Gets: inline diff preview widget, notebook support, code mapper
			//   3. web_fetch → vscode_fetchWebPage_internal
			//      Gets: trusted domain check, reader mode, image extraction, post-approval
			//   4. ask_user → vscode_askQuestions
			//      Gets: native question carousel widget with selectable answers
			//   5. todo_write → manage_todo_list
			//      Gets: Copilot todo widget (collapsible, status icons, progress tracking)
			//   6. All other Copilot-registered tools → invokeTool() (rename LSP, usages, etc.)
			//   7. Void builtins (read, grep, context_*, agents, etc.) → void harness
			for (const call of toolCalls) {
				if (token.isCancellationRequested) { break; }

				let toolCallId = call.id || generateUuid();
				let toolName = call.name as string;
				let rawParams: Record<string, string | undefined> = call.rawParams ?? {};

				// --- Terminal bridge: void shell tools → run_in_terminal ---
				if (toolName === 'bash' || toolName === 'run_command' || toolName === 'run_persistent_command') {
					const cmd = rawParams['command'] ?? '';
					rawParams = {
						command: cmd,
						explanation: rawParams['description'] ?? cmd,
						goal: rawParams['description'] ?? cmd,
						mode: 'sync',
					};
					toolName = 'run_in_terminal';
					toolCallId = generateUuid();
				}

				// --- File-write bridge: void edit tools → vscode_editFile_internal ---
				if (toolName === 'edit_file' || toolName === 'rewrite_file' || toolName === 'write'
					|| toolName === 'edit' || toolName === 'multi_replace_file_content') {
					const filePath = rawParams['uri'] ?? rawParams['file_path'] ?? '';
					const newContent = rawParams['new_content'] ?? rawParams['content']
						?? rawParams['search_replace_blocks'] ?? rawParams['replacement_chunks'] ?? rawParams['new_string'] ?? '';
					rawParams = {
						uri: filePath,
						explanation: `Editing ${filePath.split('/').pop() ?? filePath}`,
						code: newContent,
					};
					toolName = 'vscode_editFile_internal';
					toolCallId = generateUuid();
				}

				// --- Web fetch bridge: web_fetch → vscode_fetchWebPage_internal ---
				// Gets trusted domain check, reader mode, image extraction, post-approval UI.
				if (toolName === 'web_fetch') {
					const url = rawParams['url'] ?? '';
					// vscode_fetchWebPage_internal expects { urls: string[] } — passed as JSON string
					// since rawParams values are strings; invokeTool deserialises via inputSchema.
					rawParams = { urls: JSON.stringify([url]) };
					toolName = 'vscode_fetchWebPage_internal';
					toolCallId = generateUuid();
				}

				// --- Ask user bridge: ask_user → vscode_askQuestions ---
				// Gets Copilot's native question carousel widget with optional selectable answers.
				if (toolName === 'ask_user') {
					const q = rawParams['question'] ?? '';
					rawParams = {
						questions: JSON.stringify([{
							header: q.slice(0, 50),
							question: q,
						}]),
					};
					toolName = 'vscode_askQuestions';
					toolCallId = generateUuid();
				}

				// --- Todo bridge: todo_write → manage_todo_list ---
				// Gets Copilot's collapsible todo widget with status icons and progress tracking.
				if (toolName === 'todo_write') {
					try {
						const parsed = JSON.parse(rawParams['todos'] ?? '[]') as Array<{ content?: string; status?: string }>;
						const statusMap: Record<string, string> = {
							pending: 'not-started',
							in_progress: 'in-progress',
							completed: 'completed',
						};
						const todoList = parsed.map((t, i) => ({
							id: i + 1,
							title: t.content ?? '',
							status: statusMap[t.status ?? 'pending'] ?? 'not-started',
						}));
						rawParams = { todoList: JSON.stringify(todoList) };
					} catch {
						rawParams = { todoList: '[]' };
					}
					toolName = 'manage_todo_list';
					toolCallId = generateUuid();
				}

				// Resolve IToolData — Copilot registry first, then synthesise for void builtins.
				// Void tool synthetic entries carry display name + icon from VOID_TOOL_META so the
				// pill looks identical to Copilot's native tool pills.
				const copilotTool = this._lmToolsService.getTool(toolName)
					?? this._lmToolsService.getToolByName(toolName);

				const voidMeta = isABuiltinToolName(toolName) ? VOID_TOOL_META[toolName] : undefined;
				const toolData: IToolData = copilotTool ?? {
					id: toolName,
					source: ToolDataSource.Internal,
					displayName: voidMeta?.displayName ?? toolName,
					modelDescription: toolName,
					icon: voidMeta?.icon,
				};

				// Emit the pill immediately — invocationMessage drives the "running" label.
				const invocationMsg = voidMeta?.invocationLabel(rawParams as Record<string, string | undefined>) ?? toolData.displayName;
				const invocation = ChatToolInvocation.createStreaming({
					toolCallId,
					toolId: toolData.id,
					toolData,
					chatRequestId: request.requestId,
				});
				// Override the default displayName message with the param-aware label.
				invocation.invocationMessage = new MarkdownString(invocationMsg);
				progress([invocation as unknown as IChatProgress]);

				let toolResultText = '';

				if (copilotTool) {
					// invokeTool manages the Streaming → Executing → Completed state transitions internally.
					// --- Copilot harness ---
					// invokeTool handles: terminal streaming, inline diff, rename LSP, confirmations,
					// post-approval, browser, test runner, todo list, task runner, artifacts, etc.
					try {
						const result = await this._lmToolsService.invokeTool(
							{
								callId: toolCallId,
								toolId: copilotTool.id,
								parameters: rawParams,
								context: { sessionResource: request.sessionResource },
								chatRequestId: request.requestId,
								tokenBudget: undefined,
								userSelectedTools: request.userSelectedTools,
							},
							async (txt) => Math.ceil(txt.length / 4),
							token,
						);
						toolResultText = result.content
							.filter(p => p.kind === 'text')
							.map(p => (p as { kind: 'text'; value: string }).value)
							.join('\n');
						await invocation.didExecuteTool({ content: [{ kind: 'text', value: toolResultText }] });
					} catch (e) {
						toolResultText = `Tool error: ${messageOfThrown(e)}`;
						await invocation.didExecuteTool({ content: [{ kind: 'text', value: toolResultText }], toolResultError: true });
					}
				} else if (isABuiltinToolName(toolName)) {
					// --- Void harness ---
					// Tools that mutate the workspace or run commands need the same approval
					// here as they do in the sidebar (`chatThreadService` consults the very same
					// map before running one). Without this the identical tool ran unattended
					// just because the request arrived through the native chat — task A7 item 2.
					const approvalType = approvalTypeOfBuiltinToolName[toolName];
					const autoApprove = approvalType
						? this._settingsService.state.globalSettings.autoApprove[approvalType] === true
						: false;
					// `undefined` makes transitionFromStreaming park the invocation in
					// WaitingForConfirmation and render the native confirmation buttons.
					const autoConfirmed: ConfirmedReason | undefined = !approvalType
						? { type: ToolConfirmKind.ConfirmationNotNeeded }
						: autoApprove
							? { type: ToolConfirmKind.Setting, id: `void.autoApprove.${approvalType}` }
							: undefined;
					invocation.transitionFromStreaming(
						{
							invocationMessage: new MarkdownString(invocationMsg),
							confirmationMessages: approvalType && !autoApprove
								? {
									title: localize('void.toolConfirm.title', "Allow {0}?", toolData.displayName),
									message: localize('void.toolConfirm.message', "The agent wants to run \"{0}\". This can change files or run commands in your workspace.", toolData.displayName),
									allowAutoConfirm: true,
								}
								: undefined,
						},
						rawParams,
						autoConfirmed,
					);
					if (autoConfirmed === undefined) {
						// Park until the user answers. Denied/Skipped land in Cancelled; the
						// model is told the call was refused so it can pick another route.
						const settled = await waitForState(
							invocation.state,
							s => s.type === IChatToolInvocation.StateKind.Executing
								|| s.type === IChatToolInvocation.StateKind.Cancelled,
							undefined,
							token,
						);
						if (settled.type === IChatToolInvocation.StateKind.Cancelled) {
							toolResultText = `The user denied permission to run "${toolName}". Do not retry it; explain what you wanted to do, or choose a read-only alternative.`;
							await invocation.didExecuteTool({ content: [{ kind: 'text', value: toolResultText }], toolResultError: true });
							loopMessages.push({ role: 'user', content: `<tool_result name="${toolName}" id="${toolCallId}">\n${toolResultText}\n</tool_result>` });
							continue;
						}
					}
					const pastTenseMsg = voidMeta?.pastTenseLabel(rawParams);
					// Build an input summary for the collapsible pill header (key param, max 120 chars).
					const inputSummary = (
						rawParams['command'] ?? rawParams['uri'] ?? rawParams['file_path']
						?? rawParams['query'] ?? rawParams['pattern'] ?? rawParams['file']
						?? rawParams['url'] ?? rawParams['key'] ?? rawParams['agent_id']
						?? rawParams['goal'] ?? rawParams['question'] ?? ''
					).slice(0, 120);
					let isError = false;
					try {
						const typedParams = this._toolsService.validateParams[toolName](rawParams as never);
						const { result } = await this._toolsService.callTool[toolName](typedParams as never);
						const awaitedResult = await result;
						toolResultText = (this._toolsService.stringOfResult[toolName] as (p: unknown, r: unknown) => string)(typedParams, awaitedResult);
					} catch (e) {
						toolResultText = `Tool error: ${messageOfThrown(e)}`;
						isError = true;
					}
					// Attach toolSpecificData so the chat renderer picks the right sub-part widget.
					invocation.toolSpecificData = buildToolSpecificData(toolName, inputSummary, toolResultText, isError) as typeof invocation.toolSpecificData;
					await invocation.didExecuteTool({
						content: [{ kind: 'text', value: toolResultText }],
						toolResultError: isError || undefined,
						toolResultMessage: pastTenseMsg ? new MarkdownString(pastTenseMsg) : undefined,
					});
				} else if (this._internalToolService.has(toolName)) {
					// --- Void internal tools (ledger recall, KB discovery — task A8) ---
					// Registered by contributions, read-only by design, and the sidebar
					// runs them through this same service — the bridge must route them
					// too, or the model is shown a tool it can never call (the exact
					// "recall_history is not available" failure from the live test).
					// No approval flow: they never mutate the workspace.
					let internalError = false;
					try {
						// F02: the native surface owns its identity — the ledger thread
						// id of THIS session, never the active sidebar thread singleton
						toolResultText = await this._internalToolService.execute(
							toolName,
							rawParams,
							{ conversationId: ledgerThreadId, source: 'native-chat' },
						);
					} catch (e) {
						toolResultText = `Tool error: ${messageOfThrown(e)}`;
						internalError = true;
					}
					await invocation.didExecuteTool({ content: [{ kind: 'text', value: toolResultText }], toolResultError: internalError || undefined });
				} else {
					toolResultText = `Tool "${toolName}" is not available.`;
					await invocation.didExecuteTool({ content: [{ kind: 'text', value: toolResultText }], toolResultError: true });
				}

				this._journal(ledgerThreadId, {
					role: 'tool',
					content: toolResultText,
					name: toolName,
					meta: { toolCallId },
				});
				// Feed result back as a tool message
				loopMessages.push({ role: 'user', content: `<tool_result name="${toolName}" id="${toolCallId}">\n${toolResultText}\n</tool_result>` });
			}
		}

		return {};
	}

	/**
	 * Fold the journal's open episode into a frozen summary and rebuild the
	 * working brief (F01). Shared by the /compact command, the context-
	 * overflow recovery path AND the normal send path (R7): `force` skips the
	 * policy thresholds — the send path passes none and closes only a DUE
	 * episode. Returns the freed token estimate (0 on refusal).
	 */
	private async _closeLedgerEpisode(ledgerThreadId: string, modelSelection: ModelSelection | null, opts: { force?: boolean }): Promise<number> {
		const stats = await this._contextLedgerService.stats(ledgerThreadId);
		if (!stats || stats.entryCount === 0) { return 0; }
		const episodes = await this._contextLedgerService.listEpisodes(ledgerThreadId);
		const fromSeq = episodes.reduce((m, ep) => Math.max(m, ep.range.toSeq), 0) + 1;
		const tailProbe = await this._contextLedgerService.readTail(ledgerThreadId, DEFAULT_LEDGER_POLICY.tailMinMessages + 4);
		if (tailProbe.length === 0) { return 0; }
		const idleMs = stats.lastEntryTs ? Date.now() - stats.lastEntryTs : 0;
		const decision = EpisodeSummarizer.decideBoundary(stats, tailProbe.length, idleMs, DEFAULT_LEDGER_POLICY, opts);
		if (!decision || !decision.close) { return 0; }
		const boundary = await resolveCloseBoundary(fromSeq, DEFAULT_LEDGER_POLICY, n => this._contextLedgerService.readTail(ledgerThreadId, n));
		if (boundary.kind !== 'close' || !boundary.toSeq) { return 0; }
		const entries = await this._contextLedgerService.readRange(ledgerThreadId, fromSeq, boundary.toSeq);
		if (entries.length === 0) { return 0; }
		const episode = await this._getLedgerSummarizer().summarizeEpisode({
			threadId: ledgerThreadId,
			ordinal: episodes.length + 1,
			entries,
			range: { fromSeq, toSeq: boundary.toSeq },
			modelSelection,
		});
		await this._contextLedgerService.saveEpisode(episode);
		const brief = buildWorkingBrief({
			threadId: ledgerThreadId,
			previousBrief: await this._contextLedgerService.getBrief(ledgerThreadId),
			episodes: [...episodes, episode],
			lastSeq: stats.lastSeq,
			policy: DEFAULT_LEDGER_POLICY,
		});
		await this._contextLedgerService.saveBrief(brief);
		const foldedTokens = entries.reduce((s, e) => s + e.tokens, 0);
		return Math.max(0, foldedTokens - brief.tokens);
	}

	/**
	 * Manual /compact — always closes, regardless of the policy thresholds.
	 */
	private _compactLedgerThread(ledgerThreadId: string, modelSelection: ModelSelection | null): Promise<number> {
		return this._closeLedgerEpisode(ledgerThreadId, modelSelection, { force: true });
	}

	/**
	 * F01: assemble the outgoing payload FROM THE LEDGER instead of resending
	 * the Copilot session's raw history. The journal is a superset of what the
	 * session remembers (it also holds the tool results the session drops),
	 * and the working brief replaces everything the frozen episodes actually
	 * cover — so the payload stays bounded as the conversation grows, and
	 * /compact's summary finally enters the next request.
	 *
	 * Coverage boundary (owner condition): the trim starts after the
	 * CONTIGUOUS prefix the episodes the brief was built from actually cover
	 * (R2) — NOT brief.builtAtSeq, which is the build-time watermark
	 * (stats.lastSeq at build moment) and runs ahead of what the episodes
	 * really summarize, and NOT a bare max(toSeq), which would delete entries
	 * behind a gap in episode coverage. Anything uncovered stays verbatim in
	 * the payload.
	 *
	 * S1/S3: the current request is carried by its journal SEQ (the append
	 * receipt) — verified present exactly once, wherever it sits; a failed
	 * append is repaired by pushing it once. The returned currentRequestIdx
	 * is the budget's mandatory anchor (never guessed from message text).
	 *
	 * Never throws — on any failure the caller's session-history fallback is
	 * returned so a ledger problem can never break a chat turn.
	 */
	private async _assembleNativePayload(
		ledgerThreadId: string,
		fallback: OpenAILLMChatMessage[],
		modelSelection: { providerName: ProviderName; modelName: string },
		currentRequest: { message: string; seq: number | null },
	): Promise<{ messages: OpenAILLMChatMessage[]; currentRequestIdx: number }> {
		try {
			if (!this._settingsService.state.globalSettings.contextLedgerEnabled) {
				return { messages: fallback, currentRequestIdx: fallback.length - 1 };
			}
			const stats = await this._contextLedgerService.stats(ledgerThreadId);
			if (!stats || stats.entryCount === 0) {
				return { messages: fallback, currentRequestIdx: fallback.length - 1 };
			}

			const brief = await this._contextLedgerService.getBrief(ledgerThreadId);
			const episodes = await this._contextLedgerService.listEpisodes(ledgerThreadId);
			let coveredSeq = 0;
			if (brief) {
				// contiguous-prefix coverage: a gap between episodes keeps the
				// entries behind it in the payload instead of trimming them
				coveredSeq = contiguousCoverage(
					episodes
						.filter(ep => brief.builtFromEpisodes.includes(ep.ordinal))
						.map(ep => ep.range),
				);
			}

			// the retained window, verbatim from the journal — including the
			// tool results the session rebuild drops
			const entries = await this._contextLedgerService.readRange(ledgerThreadId, coveredSeq + 1, stats.lastSeq);
			if (entries.length === 0) {
				return { messages: fallback, currentRequestIdx: fallback.length - 1 };
			}

			const { overridesOfModel } = this._settingsService.state;
			const { contextWindow, reservedOutputTokenSpace } = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel);
			const result = assembleLedgerPayload({
				entries,
				brief,
				contextWindow,
				reservedOutputTokenSpace,
				policy: DEFAULT_LEDGER_POLICY,
				current: currentRequest,
			});
			if (!result) {
				return { messages: fallback, currentRequestIdx: fallback.length - 1 };
			}
			const parts = result.sections
				.filter(s => s.name !== 'reserved-output')
				.map(s => `${s.name} ${s.tokens}`)
				.join(' + ');
			console.log(`[ChatThread] native ledger assembled: ${parts} = ${result.totalTokens} / ${result.availableInputTokens} (covered_seq ${coveredSeq}, journal ${stats.totalTokens})`);
			return { messages: result.messages, currentRequestIdx: result.currentRequestIdx };
		} catch {
			// a ledger problem must never break a chat turn
			return { messages: fallback, currentRequestIdx: fallback.length - 1 };
		}
	}

	/**
	 * R2: migrate session turns the journal never saw. A nonempty ledger used
	 * to replace the session rebuild wholesale, so enabling the ledger mid-
	 * session (or one failed append) made every prior turn vanish from the
	 * payload. The uncovered RECORDS are journaled here — BEFORE the current
	 * message is appended — with `meta.turn` markers, which also gives the
	 * journal its stable turn mapping (R7). Content matching covers journals
	 * written before the marker existed; see common/ledgerTurns.ts.
	 *
	 * T3/T4 + U1–U3: returns the contiguous watermark over COMPLETED turns the
	 * journal CONFIRMED (-1 when none) — coverage discovery reads the durable
	 * meta watermark, the tail/head windows and (when a record is still
	 * unresolved) the WHOLE archive; a failed write stops the watermark so
	 * the next send retries it, and the current, not-yet-answered turn is
	 * never certified.
	 */
	private async _migrateLegacyTurns(threadId: string, history: IChatAgentHistoryEntry[]): Promise<number> {
		if (history.length === 0 || !this._settingsService.state.globalSettings.contextLedgerEnabled) { return -1; }
		try {
			return await migrateLegacyTurns(
				{
					statsEntryCount: async () => (await this._contextLedgerService.stats(threadId))?.entryCount ?? null,
					readTail: max => this._contextLedgerService.readTail(threadId, max),
					readRange: (fromSeq, toSeq) => this._contextLedgerService.readRange(threadId, fromSeq, toSeq),
					getCoverage: () => this._contextLedgerService.getTurnCoverage(threadId),
					append: record => this._journal(threadId, record),
				},
				history.map(t => ({
					message: t.request.message,
					assistantText: t.response
						.filter(r => r.kind === 'markdownContent')
						.map(r => (r as { kind: string; content: { value: string } }).content.value)
						.join(''),
				})),
			);
		} catch {
			// a ledger problem must never break a chat turn — report "nothing
			// confirmed" so the coverage claim stays honest and the next send
			// retries the missing records
			return -1;
		}
	}

	private _callLLM(
		messages: LLMChatMessage[],
		modelSelection: { providerName: ProviderName; modelName: string },
		state: IVoidSettingsService['state'],
		mcpTools: InternalToolInfo[],
		systemMessage: string,
		token: CancellationToken,
	): Promise<{ text: string; toolCalls: RawToolCallObj[] | undefined; usage: LLMUsage | undefined }> {
		return new Promise((resolve, reject) => {
			const abortRef = { current: null as (() => void) | null };
			const cancellationListener = token.onCancellationRequested(() => {
				abortRef.current?.();
				cancellationListener.dispose();
				resolve({ text: '', toolCalls: undefined, usage: undefined });
			});

			// System message is pre-built in the renderer; chatMode:null skips redundant main-process
			// system message construction. extractXMLToolsWrapper is applied manually so tool XML
			// (read_file, update_agent_status, etc.) never appears raw in the chat display.
			const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(
				() => { },
				({ fullText, toolCalls, usage }) => {
					cancellationListener.dispose();
					resolve({ text: fullText, toolCalls, usage });
				},
				'agent',
				mcpTools.length > 0 ? mcpTools : undefined,
				undefined,
			);

			const requestId = this._llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages,
				separateSystemMessage: systemMessage || undefined,
				chatMode: null,
				modelSelection,
				modelSelectionOptions: undefined,
				overridesOfModel: state.overridesOfModel as OverridesOfModel | undefined,
				mcpTools: mcpTools.length > 0 ? mcpTools : undefined,
				logging: { loggingName: 'ni-agent' },
				onText: newOnText,
				onFinalMessage: newOnFinalMessage,
				onError: ({ message, fullError }) => {
					cancellationListener.dispose();
					reject(fullError ?? new Error(message));
				},
				onAbort: () => {
					cancellationListener.dispose();
					resolve({ text: '', toolCalls: undefined, usage: undefined });
				},
			});
			if (requestId) {
				abortRef.current = () => this._llmMessageService.abort(requestId);
			}
		});
	}
}

class VoidModelProvider extends Disposable implements IWorkbenchContribution, ILanguageModelChatProvider {

	static readonly ID = 'workbench.contrib.voidModelProvider';

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _lmRegistration = this._register(new MutableDisposable());
	private readonly _agentRegistration = this._register(new MutableDisposable<DisposableStore>());
	private _agentRegistered = false;

	constructor(
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@IChatAgentService private readonly _chatAgentService: IChatAgentService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@ILanguageModelToolsService private readonly _lmToolsService: ILanguageModelToolsService,
		@IToolsService private readonly _toolsService: IToolsService,
		@IConvertToLLMMessageService private readonly _convertService: IConvertToLLMMessageService,
		@IContextLedgerService private readonly _contextLedgerService: IContextLedgerService,
		@IVoidInternalToolService private readonly _internalToolService: IVoidInternalToolService,
	) {
		super();

		// Mark setup as completed and user as signed-in so the Copilot sign-in UI never shows.
		// Keep hidden=false so title-bar actions gated on Setup.hidden.negate() remain visible
		// (e.g. "Open in Agents Window"). SetupAgent will register but our NI agent wins as
		// isDefault:true and registers first in BlockRestore phase.
		ChatEntitlementContextKeys.hasByokModels.bindTo(this._contextKeyService).set(true);
		ChatEntitlementContextKeys.clientByokEnabled.bindTo(this._contextKeyService).set(true);
		ChatEntitlementContextKeys.Setup.completed.bindTo(this._contextKeyService).set(true);
		// signedOut=false hides the "Sign In" title-bar button (its `when` requires signedOut=true)
		ChatEntitlementContextKeys.Entitlement.signedOut.bindTo(this._contextKeyService).set(false);

		this._settingsService.waitForInitState.then(() => {
			this._registerAll();
			// onDidChange is sufficient — the LM service calls provideLanguageModelChatInfo and refreshes the cache
			this._register(this._settingsService.onDidChangeState(() => this._onDidChange.fire()));
		});
	}

	private _registerAll(): void {
		// Register language model vendor + provider for the model picker
		this._languageModelsService.deltaLanguageModelChatProviderDescriptors(
			[NI_PROVIDER_DESCRIPTOR],
			[]
		);
		this._lmRegistration.value = this._languageModelsService.registerLanguageModelProvider('neuralInverse', this);

		// Register default chat agent once — it stays for the session
		if (!this._agentRegistered) {
			this._agentRegistered = true;
			const agentImpl = new VoidChatAgentImpl(this._settingsService, this._llmMessageService, this._lmToolsService, this._toolsService, this._convertService, this._contextLedgerService, this._internalToolService);
			const ds = new DisposableStore();

			ds.add(this._chatAgentService.registerAgent(NI_AGENT_ID, {
				id: NI_AGENT_ID,
				name: 'Neural Inverse',
				fullName: 'Neural Inverse',
				description: 'Neural Inverse AI — powered by your configured LLM providers',
				extensionId: NI_EXTENSION_ID,
				extensionVersion: '1.0.0',
				extensionPublisherId: 'neuralInverse',
				extensionDisplayName: 'Neural Inverse',
				isDefault: true,
				isDynamic: true,
				metadata: {},
				slashCommands: [
					{ name: 'compact', description: 'Summarize earlier conversation to free up context window' },
				],
				locations: [ChatAgentLocation.Chat, ChatAgentLocation.Terminal, ChatAgentLocation.Notebook, ChatAgentLocation.EditorInline],
				modes: [ChatModeKind.Ask, ChatModeKind.Edit, ChatModeKind.Agent],
				disambiguation: [],
			}));
			ds.add(this._chatAgentService.registerAgentImplementation(NI_AGENT_ID, agentImpl));
			this._agentRegistration.value = ds;
		}

		// Single fire — concurrent calls cause "already registered, skipping" in LM service cache
		this._onDidChange.fire();
	}

	async provideLanguageModelChatInfo(_options: ILanguageModelChatInfoOptions, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const state = this._settingsService.state;
		const result: ILanguageModelChatMetadataAndIdentifier[] = [];

		for (const providerName of providerNames) {
			const providerSettings = state.settingsOfProvider[providerName];
			const enabledModels = providerSettings.models.filter(m => !m.isHidden);
			if (enabledModels.length === 0) {
				continue;
			}
			const providerTitle = displayInfoOfProviderName(providerName).title;
			for (const modelInfo of enabledModels) {
				const caps = getModelCapabilities(providerName, modelInfo.modelName, state.overridesOfModel);
				const identifier = `ni:${providerName}:${modelInfo.modelName}`;

				const metadata: ILanguageModelChatMetadata = {
					extension: NI_EXTENSION_ID,
					name: modelInfo.modelName,
					id: identifier,
					vendor: 'neuralInverse',
					version: '1.0.0',
					family: modelInfo.modelName,
					detail: providerTitle,
					isBYOK: true,
					maxInputTokens: caps.contextWindow,
					maxOutputTokens: caps.reservedOutputTokenSpace ?? 4096,
					isDefaultForLocation: {},
					isUserSelectable: true,
					targetChatSessionType: 'agent-host-copilotcli',
					capabilities: {
						toolCalling: true,
						vision: true,
						agentMode: true,
					},
				};

				result.push({ metadata, identifier });
			}
		}

		return result;
	}

	async sendChatRequest(modelId: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, _options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		const parsed = this._parseModelId(modelId);
		if (!parsed) {
			throw new Error(`VoidModelProvider: unrecognised model ID "${modelId}"`);
		}

		const { providerName, modelName } = parsed;
		const llmMessages = this._convertMessages(messages);
		const state = this._settingsService.state;

		// Queue for real streaming — chunks arrive via onText, consumer reads via async iterator
		const queue: string[] = [];
		let done = false;
		let error: Error | undefined;
		let notify: (() => void) | undefined;

		const enqueue = (chunk: string) => {
			queue.push(chunk);
			notify?.();
		};
		let finish = (err?: Error) => {
			done = true;
			error = err;
			notify?.();
		};

		let lastText = '';
		const requestId = this._llmMessageService.sendLLMMessage({
			messagesType: 'chatMessages',
			messages: llmMessages,
			separateSystemMessage: undefined,
			chatMode: null,
			modelSelection: { providerName, modelName },
			modelSelectionOptions: undefined,
			overridesOfModel: state.overridesOfModel,
			logging: { loggingName: 'copilot-lm' },
			onText: ({ fullText }) => {
				const delta = fullText.slice(lastText.length);
				lastText = fullText;
				if (delta) {
					enqueue(delta);
				}
			},
			onFinalMessage: ({ fullText }) => {
				const delta = fullText.slice(lastText.length);
				if (delta) {
					enqueue(delta);
				}
				finish();
			},
			onError: ({ message }) => finish(new Error(message)),
			onAbort: () => finish(),
		});

		if (token.isCancellationRequested && requestId) {
			this._llmMessageService.abort(requestId);
		} else if (requestId) {
			const listener = token.onCancellationRequested(() => {
				this._llmMessageService.abort(requestId);
				listener.dispose();
			});
		}

		const asyncIterable: AsyncIterable<IChatResponsePart | IChatResponsePart[]> = {
			[Symbol.asyncIterator]: async function* () {
				let idx = 0;
				while (true) {
					// Drain all queued chunks
					while (idx < queue.length) {
						yield textPart(queue[idx++]);
					}
					if (done) {
						// Drain any final chunks added before done flag
						while (idx < queue.length) {
							yield textPart(queue[idx++]);
						}
						if (error) {
							throw error;
						}
						return;
					}
					// Wait for next chunk or completion
					await new Promise<void>(res => { notify = res; });
					notify = undefined;
				}
			}
		};

		const resultPromise = new Promise<void>((res, rej) => {
			const origFinish = finish;
			const wrappedFinish = (err?: Error) => {
				origFinish(err);
				if (err) { rej(err); } else { res(); }
			};
			// Patch into the same slots so onFinalMessage/onError/onAbort resolve the result promise
			finish = wrappedFinish;
		});

		return { stream: asyncIterable, result: resultPromise };
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		const text = typeof message === 'string'
			? message
			: message.content.filter(p => p.type === 'text').map(p => (p as { type: 'text'; value: string }).value).join('');
		return Math.ceil(text.length / 4);
	}

	private _parseModelId(modelId: string): { providerName: ProviderName; modelName: string } | undefined {
		const match = modelId.match(/^ni:([^:]+):(.+)$/);
		if (!match) {
			return undefined;
		}
		return { providerName: match[1] as ProviderName, modelName: match[2] };
	}

	private _convertMessages(messages: IChatMessage[]): LLMChatMessage[] {
		const result: OpenAILLMChatMessage[] = [];
		for (const msg of messages) {
			const content = msg.content
				.filter(p => p.type === 'text')
				.map(p => (p as { type: 'text'; value: string }).value)
				.join('\n');

			if (msg.role === ChatMessageRole.System) {
				result.push({ role: 'system', content });
			} else if (msg.role === ChatMessageRole.User) {
				result.push({ role: 'user', content });
			} else if (msg.role === ChatMessageRole.Assistant) {
				result.push({ role: 'assistant', content });
			}
		}
		return result;
	}
}

// BlockRestore — same phase as ChatSetupContribution, but registered first so
// context keys (hidden=true) are set before SetupAgent tries to register.
registerWorkbenchContribution2(VoidModelProvider.ID, VoidModelProvider, WorkbenchPhase.BlockRestore);
