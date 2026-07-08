/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { IEncryptionService } from '../../../../platform/encryption/common/encryptionService.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import { ILifecycleService, LifecyclePhase } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
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
	IUserFriendlyLanguageModel,
	ChatMessageRole,
} from '../../../../workbench/contrib/chat/common/languageModels.js';
import { ChatEntitlementContextKeys } from '../../../../workbench/services/chat/common/chatEntitlementService.js';
import { VOID_SETTINGS_STORAGE_KEY } from '../../../../workbench/contrib/void/common/storageKeys.js';
import { providerNames, displayInfoOfProviderName, ProviderName } from '../../../../workbench/contrib/void/common/voidSettingsTypes.js';
import { getModelCapabilities } from '../../../../workbench/contrib/void/common/modelCapabilities.js';
import { EventLLMMessageOnTextParams, EventLLMMessageOnFinalMessageParams, EventLLMMessageOnErrorParams } from '../../../../workbench/contrib/void/common/sendLLMMessageTypes.js';
import { IChatAgentService, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult } from '../../../../workbench/contrib/chat/common/participants/chatAgents.js';
import { IChatProgress, IChatSessionTiming } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChatAgentLocation, ChatModeKind } from '../../../../workbench/contrib/chat/common/constants.js';
import { IChatSessionsService, IChatSessionContentProvider, IChatSessionItemController, IChatSessionItem, IChatNewSessionRequest, IChatSessionItemsDelta } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILanguageModelToolsService } from '../../../../workbench/contrib/chat/common/tools/languageModelToolsService.js';
import { InternalToolInfo } from '../../../../workbench/contrib/void/common/prompt/prompts.js';
import { RawToolCallObj } from '../../../../workbench/contrib/void/common/sendLLMMessageTypes.js';

const NI_EXTENSION_ID = new ExtensionIdentifier('neuralInverse.void');
const NI_AGENT_ID = 'neuralInverse.default';

class NiSessionsModelProvider extends Disposable implements IWorkbenchContribution, ILanguageModelChatProvider {

	static readonly ID = 'sessions.contrib.niSessionsModelProvider';

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _lmRegistration = this._register(new MutableDisposable());
	private readonly _channel: IChannel;

	constructor(
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@IStorageService private readonly _storageService: IStorageService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEncryptionService private readonly _encryptionService: IEncryptionService,
		@ILifecycleService private readonly _lifecycleService: ILifecycleService,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IChatAgentService private readonly _chatAgentService: IChatAgentService,
		@IChatSessionsService private readonly _chatSessionsService: IChatSessionsService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILanguageModelToolsService private readonly _toolsService: ILanguageModelToolsService,
	) {
		super();

		this._channel = mainProcessService.getChannel('void-channel-llmMessage');
		this._registerNiAgent();
		this._registerContentProvider();

		this._configurationService.updateValue('sessions.chat.claudeAgent.enabled', false, ConfigurationTarget.USER_LOCAL);
		this._configurationService.updateValue('sessions.chat.localAgent.enabled', false, ConfigurationTarget.USER_LOCAL);

		ChatEntitlementContextKeys.hasByokModels.bindTo(this._contextKeyService).set(true);
		ChatEntitlementContextKeys.clientByokEnabled.bindTo(this._contextKeyService).set(true);
		ChatEntitlementContextKeys.Setup.completed.bindTo(this._contextKeyService).set(true);
		ChatEntitlementContextKeys.Entitlement.signedOut.bindTo(this._contextKeyService).set(false);

		this._register(this._storageService.onDidChangeValue(StorageScope.APPLICATION, VOID_SETTINGS_STORAGE_KEY, this._store)(() => {
			this._onDidChange.fire();
		}));

		try {
			this._languageModelsService.deltaLanguageModelChatProviderDescriptors(
				[{ vendor: 'neuralInverse', displayName: 'Neural Inverse' } as IUserFriendlyLanguageModel],
				[]
			);
		} catch { /* vendor already registered */ }
		try {
			this._lmRegistration.value = this._languageModelsService.registerLanguageModelProvider('neuralInverse', this);
		} catch { /* provider already registered */ }

		this._onDidChange.fire();
		this._lifecycleService.when(LifecyclePhase.Restored).then(() => {
			if (!this._store.isDisposed) { this._onDidChange.fire(); }
		});

		// Set up IPC listeners for LLM responses
		this._register((this._channel.listen('onText_sendLLMMessage') satisfies Event<EventLLMMessageOnTextParams>)(e => {
			this._llmHooks.onText[e.requestId]?.(e);
		}));
		this._register((this._channel.listen('onFinalMessage_sendLLMMessage') satisfies Event<EventLLMMessageOnFinalMessageParams>)(e => {
			this._llmHooks.onFinalMessage[e.requestId]?.(e);
			this._clearHooks(e.requestId);
		}));
		this._register((this._channel.listen('onError_sendLLMMessage') satisfies Event<EventLLMMessageOnErrorParams>)(e => {
			this._llmHooks.onError[e.requestId]?.(e);
			this._clearHooks(e.requestId);
		}));
	}

	private readonly _llmHooks = {
		onText: {} as Record<string, (p: EventLLMMessageOnTextParams) => void>,
		onFinalMessage: {} as Record<string, (p: EventLLMMessageOnFinalMessageParams) => void>,
		onError: {} as Record<string, (p: EventLLMMessageOnErrorParams) => void>,
	};

	private _clearHooks(requestId: string): void {
		delete this._llmHooks.onText[requestId];
		delete this._llmHooks.onFinalMessage[requestId];
		delete this._llmHooks.onError[requestId];
	}

	private _registerNiAgent(): void {
		const agentImpl: IChatAgentImplementation = {
			invoke: async (request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, _history, token: CancellationToken): Promise<IChatAgentResult> => {
				const modelId = request.userSelectedModelId;
				if (!modelId) {
					return { errorDetails: { message: 'No model selected' } };
				}

				const messages: IChatMessage[] = [
					{ role: ChatMessageRole.User, content: [{ type: 'text', value: request.message }] }
				];

				const folder = this._workspaceContextService.getWorkspace().folders[0];
				const systemParts: string[] = [];
				if (request.modeInstructions?.content) {
					systemParts.push(request.modeInstructions.content);
				}
				if (folder) {
					systemParts.push(`The user is working in: ${folder.uri.fsPath}\nProject: ${folder.name}`);
				}
				if (systemParts.length > 0) {
					messages.unshift({ role: ChatMessageRole.System, content: [{ type: 'text', value: systemParts.join('\n\n') }] });
				}

				try {
					const response = await this._languageModelsService.sendChatRequest(modelId, NI_EXTENSION_ID, messages, {}, token);
					for await (const chunk of response.stream) {
						if (token.isCancellationRequested) { break; }
						const parts = Array.isArray(chunk) ? chunk : [chunk];
						for (const part of parts) {
							if (part.type === 'text') {
								progress([{ kind: 'markdownContent', content: { value: part.value } }]);
							}
						}
					}
					return {};
				} catch (e) {
					return { errorDetails: { message: String(e) } };
				}
			}
		};

		this._register(this._chatAgentService.registerDynamicAgent({
			id: NI_AGENT_ID,
			name: 'NeuralInverse',
			fullName: 'Neural Inverse',
			description: 'Neural Inverse AI',
			extensionId: NI_EXTENSION_ID,
			extensionVersion: '1.0.0',
			extensionPublisherId: 'neuralInverse',
			extensionDisplayName: 'Neural Inverse',
			isDefault: true,
			isDynamic: true,
			isCore: true,
			metadata: {},
			slashCommands: [],
			locations: [ChatAgentLocation.Chat],
			modes: [ChatModeKind.Ask, ChatModeKind.Edit, ChatModeKind.Agent],
			disambiguation: [],
		}, agentImpl));
	}

	private readonly _committedSessions: IChatSessionItem[] = [];

	private _registerContentProvider(): void {
		const provider: IChatSessionContentProvider = {
			async provideChatSessionContent(sessionResource: URI) {
				return {
					sessionResource,
					history: [],
					dispose() { },
					onWillDispose: Event.None,
				};
			}
		};
		this._register(this._chatSessionsService.registerChatSessionContentProvider('copilotcli', provider));

		const onDidChangeItems = this._register(new Emitter<IChatSessionItemsDelta>());
		const committedSessions = this._committedSessions;
		const controller: IChatSessionItemController = {
			onDidChangeChatSessionItems: onDidChangeItems.event,
			get items(): readonly IChatSessionItem[] { return committedSessions; },
			async refresh() { /* nothing to fetch */ },
			newChatSessionItem: async (request: IChatNewSessionRequest): Promise<IChatSessionItem | undefined> => {
				const committedResource = URI.from({ scheme: 'copilotcli', path: `/session-${generateUuid()}` });
				const now = Date.now();
				const timing: IChatSessionTiming = { created: now, lastRequestStarted: now, lastRequestEnded: undefined };
				const folder = this._workspaceContextService.getWorkspace().folders[0];
				const workingDirectoryPath = folder?.uri.fsPath;
				const item: IChatSessionItem = { resource: committedResource, label: request.prompt?.substring(0, 100) || 'New Session', timing, metadata: workingDirectoryPath ? { workingDirectoryPath } : undefined };
				committedSessions.push(item);
				if (request.untitledResource) {
					setTimeout(() => {
						onDidChangeItems.fire({ addedOrUpdated: [item] });
						this._chatSessionsService.fireSessionCommitted(request.untitledResource!, committedResource);
					}, 0);
				}
				return item;
			},
		};
		this._register(this._chatSessionsService.registerChatSessionItemController('copilotcli', controller));
	}

	private _getToolsForModel(): InternalToolInfo[] {
		const tools: InternalToolInfo[] = [];
		for (const tool of this._toolsService.getTools(undefined)) {
			const params: Record<string, { description: string }> = {};
			if (tool.inputSchema && typeof tool.inputSchema === 'object' && 'properties' in tool.inputSchema) {
				const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties;
				if (props) {
					for (const [key, val] of Object.entries(props)) {
						params[key] = { description: val.description ?? '' };
					}
				}
			}
			tools.push({ name: tool.id, description: tool.modelDescription, params });
		}
		return tools;
	}

	private async _invokeTool(toolCall: RawToolCallObj, token: CancellationToken): Promise<string> {
		const tool = this._toolsService.getTool(toolCall.name);
		if (!tool) {
			return `Error: Tool "${toolCall.name}" not found`;
		}
		try {
			const result = await this._toolsService.invokeTool({
				callId: toolCall.id,
				toolId: toolCall.name,
				parameters: toolCall.rawParams as Record<string, unknown>,
				context: undefined,
			}, () => Promise.resolve(0), token);
			const textParts = (result.content ?? [])
				.filter((c): c is { kind: 'text'; value: string } => c.kind === 'text')
				.map(c => c.value);
			return textParts.join('\n') || '(no output)';
		} catch (e) {
			return `Error executing tool: ${String(e)}`;
		}
	}

	private async _getDecryptedSettings(): Promise<{ settingsOfProvider: Record<string, unknown>; overridesOfModel: unknown } | undefined> {
		const encrypted = this._storageService.get(VOID_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION);
		if (!encrypted) { return undefined; }
		try {
			const decrypted = await this._encryptionService.decrypt(encrypted);
			return JSON.parse(decrypted);
		} catch {
			return undefined;
		}
	}

	async provideLanguageModelChatInfo(_options: ILanguageModelChatInfoOptions, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const encrypted = this._storageService.get(VOID_SETTINGS_STORAGE_KEY, StorageScope.APPLICATION);
		if (!encrypted) { return []; }

		let parsed: { settingsOfProvider?: Record<string, { models?: Array<{ modelName: string; isHidden?: boolean }> }>; overridesOfModel?: unknown };
		try {
			const decrypted = await this._encryptionService.decrypt(encrypted);
			parsed = JSON.parse(decrypted);
		} catch {
			return [];
		}

		const result: ILanguageModelChatMetadataAndIdentifier[] = [];
		const overridesOfModel = parsed.overridesOfModel ?? {};

		for (const providerName of providerNames) {
			const providerSettings = parsed.settingsOfProvider?.[providerName];
			if (!providerSettings) { continue; }
			const enabledModels = (providerSettings.models ?? []).filter(m => !m.isHidden);
			if (enabledModels.length === 0) { continue; }
			const providerTitle = displayInfoOfProviderName(providerName as ProviderName).title;
			for (const modelInfo of enabledModels) {
				const caps = getModelCapabilities(providerName as ProviderName, modelInfo.modelName, overridesOfModel as never);
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
					targetChatSessionType: 'copilotcli',
					capabilities: { toolCalling: true, vision: true, agentMode: true },
				};
				result.push({ metadata, identifier });
			}
		}

		return result;
	}

	async sendChatRequest(modelId: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, _options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		const parts = modelId.split(':');
		const providerName = parts[1] as ProviderName;
		const modelName = parts.slice(2).join(':');

		const settings = await this._getDecryptedSettings();
		if (!settings) {
			throw new Error('Neural Inverse settings not available');
		}

		const llmMessages: Array<{ role: string; content: string; tool_calls?: { type: 'function'; id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }> = [];
		let systemMessage: string | undefined;

		for (const msg of messages) {
			const textParts = msg.content
				.filter(p => p.type === 'text')
				.map(p => (p as { type: 'text'; value: string }).value);
			const text = textParts.join('\n');
			if (!text) { continue; }
			if (msg.role === ChatMessageRole.System) {
				systemMessage = text;
			} else if (msg.role === ChatMessageRole.User) {
				llmMessages.push({ role: 'user', content: text });
			} else {
				llmMessages.push({ role: 'assistant', content: text });
			}
		}

		const mcpTools = this._getToolsForModel();
		const textEmitter = new Emitter<string>();
		let globalText = '';

		const resultPromise = this._runToolLoop(providerName, modelName, llmMessages, systemMessage, mcpTools, settings, token, (delta) => {
			globalText += delta;
			textEmitter.fire(globalText);
		}).finally(() => textEmitter.dispose());

		const stream: AsyncIterable<IChatResponsePart> = {
			[Symbol.asyncIterator]: () => {
				let done = false;
				let lastEmitted = '';
				const pending: IChatResponsePart[] = [];
				let waiter: ((v: IteratorResult<IChatResponsePart>) => void) | undefined;

				const push = (part: IChatResponsePart) => {
					if (waiter) { const w = waiter; waiter = undefined; w({ value: part, done: false }); }
					else { pending.push(part); }
				};

				const listener = textEmitter.event((fullText) => {
					const delta = fullText.slice(lastEmitted.length);
					lastEmitted = fullText;
					if (delta) { push({ type: 'text', value: delta }); }
				});

				resultPromise.then(() => {
					done = true; listener.dispose();
					if (waiter) { const w = waiter; waiter = undefined; w({ value: undefined as never, done: true }); }
				}).catch(() => {
					done = true; listener.dispose();
					if (waiter) { const w = waiter; waiter = undefined; w({ value: undefined as never, done: true }); }
				});

				return {
					next(): Promise<IteratorResult<IChatResponsePart>> {
						if (pending.length > 0) { return Promise.resolve({ value: pending.shift()!, done: false }); }
						if (done) { return Promise.resolve({ value: undefined as never, done: true }); }
						return new Promise(resolve => { waiter = resolve; });
					}
				};
			}
		};

		return { stream, result: resultPromise };
	}

	private async _runToolLoop(
		providerName: ProviderName,
		modelName: string,
		llmMessages: Array<{ role: string; content: string; tool_calls?: { type: 'function'; id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }>,
		systemMessage: string | undefined,
		mcpTools: InternalToolInfo[],
		settings: { settingsOfProvider: Record<string, unknown>; overridesOfModel: unknown },
		token: CancellationToken,
		onText: (delta: string) => void,
	): Promise<void> {
		const MAX_ITERATIONS = 15;
		for (let i = 0; i < MAX_ITERATIONS; i++) {
			if (token.isCancellationRequested) { return; }

			const { text, toolCalls } = await this._singleLLMCall(providerName, modelName, llmMessages, systemMessage, mcpTools, settings, token, onText);

			if (!toolCalls || toolCalls.length === 0 || toolCalls.every(tc => !tc.isDone)) {
				return;
			}

			// Add assistant message with tool calls to history
			llmMessages.push({
				role: 'assistant',
				content: text,
				tool_calls: toolCalls.filter(tc => tc.isDone).map(tc => ({
					type: 'function' as const,
					id: tc.id,
					function: { name: tc.name, arguments: JSON.stringify(tc.rawParams) }
				})),
			});

			// Execute tools and add results
			for (const tc of toolCalls.filter(tc => tc.isDone)) {
				if (token.isCancellationRequested) { return; }
				const result = await this._invokeTool(tc, token);
				llmMessages.push({ role: 'tool', content: result, tool_call_id: tc.id });
			}
		}
	}

	private _singleLLMCall(
		providerName: ProviderName,
		modelName: string,
		llmMessages: Array<{ role: string; content: string; tool_calls?: unknown; tool_call_id?: string }>,
		systemMessage: string | undefined,
		mcpTools: InternalToolInfo[],
		settings: { settingsOfProvider: Record<string, unknown>; overridesOfModel: unknown },
		token: CancellationToken,
		onText: (delta: string) => void,
	): Promise<{ text: string; toolCalls: RawToolCallObj[] | undefined }> {
		const requestId = generateUuid();

		return new Promise<{ text: string; toolCalls: RawToolCallObj[] | undefined }>((resolve, reject) => {
			let lastText = '';
			let cancelListener: { dispose(): void } | undefined;

			this._llmHooks.onText[requestId] = (e) => {
				const delta = e.fullText.slice(lastText.length);
				lastText = e.fullText;
				if (delta) { onText(delta); }
			};

			this._llmHooks.onFinalMessage[requestId] = (e) => {
				const delta = e.fullText.slice(lastText.length);
				if (delta) { onText(delta); }
				cancelListener?.dispose();
				resolve({ text: e.fullText, toolCalls: e.toolCalls });
			};

			this._llmHooks.onError[requestId] = (e) => {
				cancelListener?.dispose();
				reject(new Error(e.message));
			};

			cancelListener = token.onCancellationRequested(() => {
				this._channel.call('abort', { requestId });
				this._clearHooks(requestId);
				cancelListener?.dispose();
				resolve({ text: lastText, toolCalls: undefined });
			});

			this._channel.call('sendLLMMessage', {
				requestId,
				messagesType: 'chatMessages',
				messages: llmMessages,
				separateSystemMessage: systemMessage,
				chatMode: null,
				logging: { loggingName: 'sessions-chat' },
				modelSelection: { providerName, modelName },
				modelSelectionOptions: undefined,
				overridesOfModel: settings.overridesOfModel,
				settingsOfProvider: settings.settingsOfProvider,
				mcpTools: mcpTools.length > 0 ? mcpTools : undefined,
			});
		});
	}

	async provideTokenCount(_modelId: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		const text = typeof message === 'string'
			? message
			: message.content.filter(p => p.type === 'text').map(p => (p as { type: 'text'; value: string }).value).join('');
		return Math.ceil(text.length / 4);
	}
}

registerWorkbenchContribution2(NiSessionsModelProvider.ID, NiSessionsModelProvider, WorkbenchPhase.BlockRestore);
