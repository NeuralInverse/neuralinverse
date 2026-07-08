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
import { ProviderName, providerNames, displayInfoOfProviderName } from '../common/voidSettingsTypes.js';
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
import { IChatProgress } from '../../chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../../chat/common/constants.js';
import { LLMChatMessage, OpenAILLMChatMessage, RawToolCallObj } from '../common/sendLLMMessageTypes.js';
import { OverridesOfModel } from '../common/voidSettingsTypes.js';
import { ILanguageModelToolsService, IToolData, ToolDataSource } from '../../chat/common/tools/languageModelToolsService.js';
import { ChatToolInvocation } from '../../chat/common/model/chatProgressTypes/chatToolInvocation.js';
import { ToolConfirmKind } from '../../chat/common/chatService/chatService.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IToolsService } from './toolsService.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { extractXMLToolsWrapper } from '../common/llmMessage/extractGrammar.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { InternalToolInfo, isABuiltinToolName } from '../common/prompt/prompts.js';
import { BuiltinToolName } from '../common/toolsServiceTypes.js';

const NI_EXTENSION_ID = new ExtensionIdentifier('neuralInverse.void');
const NI_AGENT_ID = 'neuralInverse.default';
const MAX_TOOL_ITERATIONS = 20;

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
	) { }

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
		const copilotMcpTools: InternalToolInfo[] = Array.from(this._lmToolsService.getTools(undefined))
			.filter(t => !t.id.startsWith('ni_'))
			.map(copilotToolToInternalToolInfo);

		// Build message history as plain OpenAI-style messages.
		// Do NOT pass a systemMessage here — chatMode:'agent' in sendLLMMessage triggers void's
		// pipeline to build the full system message (workspace context + all tool schemas).
		// Passing an empty string would create an empty Anthropic system block (API error).
		const llmMessages: OpenAILLMChatMessage[] = [];
		for (const turn of history) {
			llmMessages.push({ role: 'user', content: turn.request.message });
			const assistantText = turn.response
				.filter(r => r.kind === 'markdownContent')
				.map(r => (r as { kind: string; content: { value: string } }).content.value)
				.join('');
			if (assistantText) { llmMessages.push({ role: 'assistant', content: assistantText }); }
		}
		llmMessages.push({ role: 'user', content: userMessage });

		// Build the full system message in the renderer where workspace/editor services are available.
		// chatMode:'agent' in generateSystemMessage includes: workspace folders, open files, dir tree,
		// XML tool schemas for all 40+ void builtins + copilotMcpTools injected via mcpTools param.
		// We then pass chatMode:null to sendLLMMessage (system message already constructed) and apply
		// extractXMLToolsWrapper manually so tool XML never leaks to the chat display.
		const { providerName: pn, modelName: mn } = modelSelection;
		let systemMessage = await this._convertService.generateSystemMessage('agent', undefined, undefined, pn, mn);

		// Append Copilot mode instructions (custom instructions from .github/copilot-instructions.md
		// or a custom Chat mode) so user-configured personas carry through to the NI backend.
		const modeInstructions = request.modeInstructions?.content;
		if (modeInstructions && modeInstructions.trim().length > 0) {
			systemMessage = `${systemMessage}\n\n<copilot_instructions>\n${modeInstructions.trim()}\n</copilot_instructions>`;
		}

		// Agentic tool loop
		const loopMessages = [...llmMessages];
		let iterations = 0;
		while (iterations < MAX_TOOL_ITERATIONS) {
			if (token.isCancellationRequested) { break; }
			iterations++;

			const { text, toolCalls } = await this._callLLM(
				loopMessages, modelSelection, state, copilotMcpTools, systemMessage, token
			);

			if (token.isCancellationRequested) { break; }

			if (text.length > 0) {
				progress([{ kind: 'markdownContent', content: new MarkdownString(text) }]);
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
								userSelectedTools: undefined,
							},
							async (txt) => Math.ceil(txt.length / 4),
							token,
						);
						toolResultText = result.content
							.filter(p => p.kind === 'text')
							.map(p => (p as { kind: 'text'; value: string }).value)
							.join('\n');
						await invocation.didExecuteTool({ content: [{ kind: 'text', value: toolResultText }] });
					} catch (e: any) {
						toolResultText = `Tool error: ${e?.message ?? String(e)}`;
						await invocation.didExecuteTool({ content: [{ kind: 'text', value: toolResultText }], toolResultError: true });
					}
				} else if (isABuiltinToolName(toolName)) {
					// --- Void harness ---
					// Transition Streaming → Executing so the spinner shows the "running" state.
					invocation.transitionFromStreaming(
						{ invocationMessage: new MarkdownString(invocationMsg) },
						rawParams,
						{ type: ToolConfirmKind.ConfirmationNotNeeded },
					);
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
					} catch (e: any) {
						toolResultText = `Tool error: ${e?.message ?? String(e)}`;
						isError = true;
					}
					// Attach toolSpecificData so the chat renderer picks the right sub-part widget.
					invocation.toolSpecificData = buildToolSpecificData(toolName, inputSummary, toolResultText, isError) as typeof invocation.toolSpecificData;
					await invocation.didExecuteTool({
						content: [{ kind: 'text', value: toolResultText }],
						toolResultError: isError || undefined,
						toolResultMessage: pastTenseMsg ? new MarkdownString(pastTenseMsg) : undefined,
					});
				} else {
					toolResultText = `Tool "${toolName}" is not available.`;
					await invocation.didExecuteTool({ content: [{ kind: 'text', value: toolResultText }], toolResultError: true });
				}

				// Feed result back as a tool message
				loopMessages.push({ role: 'user', content: `<tool_result name="${toolName}" id="${toolCallId}">\n${toolResultText}\n</tool_result>` });
			}
		}

		return {};
	}

	private _callLLM(
		messages: LLMChatMessage[],
		modelSelection: { providerName: ProviderName; modelName: string },
		state: IVoidSettingsService['state'],
		mcpTools: InternalToolInfo[],
		systemMessage: string,
		token: CancellationToken,
	): Promise<{ text: string; toolCalls: RawToolCallObj[] | undefined }> {
		return new Promise((resolve, reject) => {
			const abortRef = { current: null as (() => void) | null };
			const cancellationListener = token.onCancellationRequested(() => {
				abortRef.current?.();
				cancellationListener.dispose();
				resolve({ text: '', toolCalls: undefined });
			});

			// System message is pre-built in the renderer; chatMode:null skips redundant main-process
			// system message construction. extractXMLToolsWrapper is applied manually so tool XML
			// (read_file, update_agent_status, etc.) never appears raw in the chat display.
			const { newOnText, newOnFinalMessage } = extractXMLToolsWrapper(
				() => { },
				({ fullText, toolCalls }) => {
					cancellationListener.dispose();
					resolve({ text: fullText, toolCalls });
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
					resolve({ text: '', toolCalls: undefined });
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
			[{ vendor: 'neuralInverse', displayName: 'Neural Inverse' } as IUserFriendlyLanguageModel],
			[]
		);
		this._lmRegistration.value = this._languageModelsService.registerLanguageModelProvider('neuralInverse', this);

		// Register default chat agent once — it stays for the session
		if (!this._agentRegistered) {
			this._agentRegistered = true;
			const agentImpl = new VoidChatAgentImpl(this._settingsService, this._llmMessageService, this._lmToolsService, this._toolsService, this._convertService);
			const ds = new DisposableStore();

			ds.add(this._chatAgentService.registerAgent(NI_AGENT_ID, {
				id: NI_AGENT_ID,
				name: 'NeuralInverse',
				fullName: 'Neural Inverse',
				description: 'Neural Inverse AI — powered by your configured LLM providers',
				extensionId: NI_EXTENSION_ID,
				extensionVersion: '1.0.0',
				extensionPublisherId: 'neuralInverse',
				extensionDisplayName: 'Neural Inverse',
				isDefault: true,
				isDynamic: true,
				metadata: {},
				slashCommands: [],
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
						yield { type: 'text', value: queue[idx++] } as IChatResponsePart;
					}
					if (done) {
						// Drain any final chunks added before done flag
						while (idx < queue.length) {
							yield { type: 'text', value: queue[idx++] } as IChatResponsePart;
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
