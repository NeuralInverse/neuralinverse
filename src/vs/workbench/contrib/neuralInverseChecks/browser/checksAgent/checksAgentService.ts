/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Checks Agent Service \u2014 GRC compliance specialist AI.
 *
 * A dedicated agent that:
 * - Talks ONLY about GRC compliance, violations, frameworks, and risk.
 * - Does NOT write or edit source code.
 * - Uses native tool-calling (10 built-in GRC tools).
 * - Exposes a programmatic API so other coding agents can query GRC state directly.
 *
 * Adapted from PowerModeService. Simplified (single session per workspace,
 * no approval dialogs, GRC-only tools).
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ISearchService } from '../../../../services/search/common/search.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { ILLMMessageService } from '../../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService, ModelOption } from '../../../void/common/voidSettingsService.js';
import { ModelSelection } from '../../../void/common/voidSettingsTypes.js';
import { IGRCEngineService } from '../engine/services/grcEngineService.js';
import { IExternalToolService } from '../engine/services/externalToolService.js';
import { IContractReasonService } from '../engine/services/contractReasonService.js';
import { ICheckResult, IDomainSummary, IGRCRule } from '../engine/types/grcTypes.js';
import { IExternalJob } from '../engine/types/externalJobTypes.js';
import { IPowerBusService } from '../../../powerMode/browser/powerBusService.js';
import type { IAgentBusMessage } from '../../../powerMode/common/powerBusTypes.js';
import { buildChecksSystemPrompt } from './checksSystemPrompt.js';
import { ChecksContextBuilder } from './checksContextBuilder.js';
import {
	IChecksSession,
	IChecksMessage,
	IChecksMessagePart,
	IChecksTextPart,
	ChecksSessionStatus,
	ChecksAgentUIEvent,
} from './checksAgentTypes.js';
import { ChecksToolRegistry } from './checksToolRegistry.js';
import { buildChecksTools } from './tools/checksTools.js';
import { buildModernisationChecksTools } from './tools/modernisationChecksTools.js';
import { buildDiscoveryChecksTools } from './tools/discoveryChecksTools.js';
import { IDiscoveryService } from '../../../neuralInverseModernisation/browser/engine/discovery/discoveryService.js';
import { IModernisationSessionService } from '../../../neuralInverseModernisation/browser/modernisationSessionService.js';
import { ChecksAgentLLMBridge } from './checksAgentLLMBridge.js';
import { runChecksAgentLoop, IProcessorCallbacks } from './checksAgentProcessor.js';

// \u2500\u2500\u2500 Service Interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const IChecksAgentService = createDecorator<IChecksAgentService>('checksAgentService');

export interface IChecksAgentService {
	readonly _serviceBrand: undefined;

	/** Fires for all UI events (streamed to webview) */
	readonly onDidEmitUIEvent: Event<ChecksAgentUIEvent>;

	// \u2500\u2500\u2500 Session management \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Create or return the active session */
	createSession(): IChecksSession;

	/** Get the active session */
	getActiveSession(): IChecksSession | undefined;

	/** Send a user message and start the agent loop */
	sendMessage(sessionId: string, text: string): Promise<void>;

	/** Cancel the active run */
	cancel(sessionId: string): void;

	/** Clear all messages in a session */
	clearSession(sessionId: string): void;

	// \u2500\u2500\u2500 Programmatic API (for other coding agents) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Query current violations directly (no LLM round-trip).
	 * For use by coding agents that need GRC state programmatically.
	 */
	queryViolations(domain?: string, severity?: string, limit?: number): ICheckResult[];

	/** Get per-domain violation summary */
	getDomainSummary(): IDomainSummary[];

	/** Get violations that block commits */
	getBlockingViolations(): ICheckResult[];

	/** Get a rule definition by ID */
	getRuleDetails(ruleId: string): IGRCRule | undefined;

	/** Get external tool job states */
	getExternalToolStatus(): IExternalJob[];

	/** Get the current model info string */
	getModelInfo(): string;

	/** Get all available models the user has configured */
	getAvailableModels(): ModelOption[];

	/** Set the Checks Agent's own model selection */
	setModel(selection: ModelSelection): void;

	/**
	 * Ask Power Mode a natural-language question via the agent bus.
	 * Power Mode's LLM processes the question using its own tools and replies.
	 * Returns Power Mode's answer, or a timeout message if no reply within 60s.
	 */
	askPowerMode(question: string): Promise<string>;

	/**
	 * Answer a natural-language compliance question using the Checks Agent's own LLM loop.
	 * Silent \u2014 no UI events, no streaming to webview.
	 * Used by Power Mode and void coding agents via the ask_checksagent tool.
	 */
	answerQuery(question: string): Promise<string>;

	/** Prefill the input with a question (called from dashboard) */
	prefill(text: string): void;
}

// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const STORAGE_KEY = 'checksAgent.session';
const MAX_PERSISTED_MESSAGES = 40;

export class ChecksAgentService extends Disposable implements IChecksAgentService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidEmitUIEvent = this._register(new Emitter<ChecksAgentUIEvent>());
	readonly onDidEmitUIEvent = this._onDidEmitUIEvent.event;

	private _session: IChecksSession | undefined;
	private readonly _abortControllers = new Map<string, AbortController>();
	private readonly _llmBridge: ChecksAgentLLMBridge;
	private readonly _toolRegistry: ChecksToolRegistry;
	private readonly _contextBuilder: ChecksContextBuilder;
	private _idCounter = 0;
	/** Checks Agent's own model selection \u2014 null means fall back to Chat */
	private _checksModelSelection: ModelSelection | null = null;
	/** Pending ask-power-mode queries: message ID \u2192 resolver */
	private readonly _pendingBusRequests = new Map<string, (result: string) => void>();
	/** Debounce state for GRC posture broadcasts \u2014 only send when values change */
	private _lastBroadcastBlocking = -1;
	private _lastBroadcastTotal = -1;
	private _broadcastDebounceTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IFileService fileService: IFileService,
		@ISearchService searchService: ISearchService,
		@ILLMMessageService llmMessageService: ILLMMessageService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IGRCEngineService private readonly grcEngine: IGRCEngineService,
		@IExternalToolService private readonly externalToolService: IExternalToolService,
		@IContractReasonService contractReasonService: IContractReasonService,
		@IPowerBusService private readonly powerBus: IPowerBusService,
		@IDiscoveryService private readonly discoveryService: IDiscoveryService,
		@IModernisationSessionService private readonly modernisationSessionService: IModernisationSessionService,
	) {
		super();
		const directory = this.workspaceContext.getWorkspace().folders[0]?.uri.fsPath ?? '/';
		this._llmBridge = new ChecksAgentLLMBridge(llmMessageService, voidSettingsService);
		this._contextBuilder = new ChecksContextBuilder(fileService);
		this._toolRegistry = new ChecksToolRegistry();
		this._toolRegistry.registerMany(
			buildChecksTools(grcEngine, externalToolService, contractReasonService, this, fileService, searchService, directory)
		);
		this._toolRegistry.registerMany(
			buildDiscoveryChecksTools(this.discoveryService)
		);
		this._toolRegistry.registerMany(
			buildModernisationChecksTools(this.discoveryService, this.modernisationSessionService)
		);
		this._restoreSession();
		this._registerOnBus();

		// Pre-warm context cache so the first user message doesn't block on filesystem I/O
		if (directory) { this._contextBuilder.build(directory).catch(() => { /* ignore */ }); }
	}

	// \u2500\u2500\u2500 Agent Bus \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _registerOnBus(): void {
		// Register as a participant that can answer compliance queries and request tools
		this.powerBus.register('checks-agent', ['send:query', 'send:tool-request', 'receive:all'], 'Checks Agent');

		// Subscribe to incoming messages
		this._register(this.powerBus.onMessage((msg: IAgentBusMessage) => {
			if (msg.to !== 'checks-agent' && msg.to !== '*') { return; }

			// Route Power Mode's response back to the waiting askPowerMode() call
			if (msg.type === 'response' && msg.from === 'power-mode' && msg.replyTo) {
				const resolve = this._pendingBusRequests.get(msg.replyTo);
				if (resolve) {
					this._pendingBusRequests.delete(msg.replyTo);
					resolve(msg.content);
				}
				return;
			}

			if (msg.type === 'query') {
				this._handleBusQuery(msg.from, msg.id, msg.content);
			}
		}));

		// Broadcast GRC posture changes \u2014 debounced + only when values actually change
		this._register(this.grcEngine.onDidCheckComplete(() => {
			if (this._broadcastDebounceTimer !== undefined) { return; } // already pending
			this._broadcastDebounceTimer = setTimeout(() => {
				this._broadcastDebounceTimer = undefined;
				try {
					const blocking = this.grcEngine.getBlockingViolations();
					const total = this.grcEngine.getAllResults().length;
					const blockingCount = blocking.length;
					if (blockingCount === this._lastBroadcastBlocking && total === this._lastBroadcastTotal) { return; }
					this._lastBroadcastBlocking = blockingCount;
					this._lastBroadcastTotal = total;

					// Broadcast to all agents (lightweight summary)
					this.powerBus.send(
						'checks-agent', '*', 'broadcast',
						JSON.stringify({ type: 'grc-posture-update', blocking: blockingCount, total }),
					);

					// If there are blocking violations, send a targeted alert to Power Mode
					// so its LLM can warn the user before the next commit attempt
					if (blockingCount > 0 && this.powerBus.isRegistered('power-mode')) {
						const topBlocking = blocking.slice(0, 3).map(r =>
							`${r.ruleId} in ${r.fileUri?.path.split('/').pop() ?? '?'}:${r.line ?? '?'} \u2014 ${r.message}`
						).join('\n');
						this.powerBus.send(
							'checks-agent', 'power-mode', 'broadcast',
							JSON.stringify({
								type: 'blocking-violations-alert',
								blockingCount,
								total,
								summary: `${blockingCount} blocking violation${blockingCount > 1 ? 's' : ''} \u2014 commit is gated`,
								topViolations: topBlocking,
							}),
						);
					}
				} catch { /* engine not ready */ }
			}, 5000); // 5s debounce \u2014 posture pings are low-priority
		}));
	}

	private _handleBusQuery(fromAgent: string, replyTo: string, content: string): void {
		// Natural-language query \u2014 route through LLM (async, reply when done)
		if (content !== 'posture-summary') {
			this.answerQuery(content).then(answer => {
				this.powerBus.send('checks-agent', fromAgent, 'response', answer, { replyTo });
			}).catch(() => {
				this.powerBus.send('checks-agent', fromAgent, 'response', 'Checks Agent could not answer the query.', { replyTo });
			});
			return;
		}

		// Fast path: posture-summary \u2014 return structured JSON without LLM round-trip
		let response: string;
		try {
			const allResults = this.grcEngine.getAllResults();
			const blocking = this.grcEngine.getBlockingViolations();
			const summary = this.grcEngine.getDomainSummary();
			const frameworks = this.grcEngine.getActiveFrameworks();
			const errors = allResults.filter(r => (r.severity ?? '').toLowerCase() === 'error').length;
			const warnings = allResults.filter(r => (r.severity ?? '').toLowerCase() === 'warning').length;

			const topBlocking = blocking.slice(0, 5).map(r => ({
				ruleId: r.ruleId,
				file: r.fileUri?.path.split('/').pop() ?? 'unknown',
				line: r.line ?? 0,
				message: r.message,
			}));

			const domainsWithIssues = summary
				.filter(d => d.errorCount + d.warningCount > 0)
				.map(d => ({ domain: d.domain, errors: d.errorCount, warnings: d.warningCount }));

			response = JSON.stringify({
				total: allResults.length,
				errors,
				warnings,
				blockingCount: blocking.length,
				commitGated: blocking.length > 0,
				frameworks: frameworks.map(f => f.name),
				domainsWithIssues,
				topBlockingViolations: topBlocking,
			});
		} catch (e: any) {
			response = JSON.stringify({ error: e.message ?? 'GRC engine not ready' });
		}

		this.powerBus.send('checks-agent', fromAgent, 'response', response, { replyTo });
	}

	// \u2500\u2500\u2500 Session management \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	createSession(): IChecksSession {
		const id = `ca_${Date.now()}_${++this._idCounter}`;
		const session: IChecksSession = {
			id,
			status: 'idle',
			messages: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this._session = session;
		this._persistSession();
		this._onDidEmitUIEvent.fire({ type: 'session-created', session });
		return session;
	}

	getActiveSession(): IChecksSession | undefined {
		return this._session;
	}

	async sendMessage(sessionId: string, text: string): Promise<void> {
		const session = this._session;
		if (!session || session.id !== sessionId) { return; }
		if (session.status === 'busy') { return; }

		// Create user message
		const userMsgId = this._nextId();
		const userMessage: IChecksMessage = {
			id: userMsgId,
			sessionId,
			role: 'user',
			createdAt: Date.now(),
			parts: [{ type: 'text', id: this._nextId(), text }],
		};
		session.messages.push(userMessage);
		session.updatedAt = Date.now();
		this._onDidEmitUIEvent.fire({ type: 'message-created', message: userMessage });

		// Create assistant message
		const assistantMsgId = this._nextId();
		const assistantMessage: IChecksMessage = {
			id: assistantMsgId,
			sessionId,
			role: 'assistant',
			createdAt: Date.now(),
			parts: [],
		};
		session.messages.push(assistantMessage);
		this._onDidEmitUIEvent.fire({ type: 'message-created', message: assistantMessage });

		// Set busy
		this._setStatus(session, 'busy');

		const abortController = new AbortController();
		this._abortControllers.set(sessionId, abortController);

		const directory = this.workspaceContext.getWorkspace().folders[0]?.uri.fsPath ?? '/';
		const wsCtx = await this._contextBuilder.build(directory);
		const systemPrompt = this._buildSystemPrompt(wsCtx);

		const callbacks: IProcessorCallbacks = {
			onPartCreated: (part: IChecksMessagePart) => {
				assistantMessage.parts.push(part);
				this._onDidEmitUIEvent.fire({
					type: 'part-updated',
					sessionId,
					messageId: assistantMsgId,
					part,
				});
			},
			onPartUpdated: (part: IChecksMessagePart) => {
				this._onDidEmitUIEvent.fire({
					type: 'part-updated',
					sessionId,
					messageId: assistantMsgId,
					part,
				});
			},
			onTextDelta: (partId: string, delta: string) => {
				this._onDidEmitUIEvent.fire({
					type: 'part-delta',
					sessionId,
					messageId: assistantMsgId,
					partId,
					delta,
				});
			},
			sendToLLM: (request) => this._llmBridge.sendToLLM(request, this._checksModelSelection),
		};

		try {
			await runChecksAgentLoop({
				assistantMessage,
				sessionMessages: session.messages,
				toolRegistry: this._toolRegistry,
				callbacks,
				abort: abortController.signal,
				systemPrompt,
			});
		} catch (e: any) {
			this._onDidEmitUIEvent.fire({ type: 'error', error: e.message });
		} finally {
			this._abortControllers.delete(sessionId);
			this._setStatus(session, 'idle');
			this._persistSession();
		}
	}

	cancel(sessionId: string): void {
		const controller = this._abortControllers.get(sessionId);
		if (controller) {
			controller.abort();
			this._abortControllers.delete(sessionId);
		}
		if (this._session?.id === sessionId) {
			this._setStatus(this._session, 'idle');
		}
	}

	clearSession(sessionId: string): void {
		if (this._session?.id === sessionId) {
			this.cancel(sessionId);
			this._session.messages = [];
			this._session.updatedAt = Date.now();
			const directory = this.workspaceContext.getWorkspace().folders[0]?.uri.fsPath;
			if (directory) { this._contextBuilder.invalidate(directory); }
			this.storageService.remove(STORAGE_KEY, StorageScope.WORKSPACE);
			this._onDidEmitUIEvent.fire({ type: 'session-cleared' as any, sessionId } as any);
		}
	}

	// \u2500\u2500\u2500 Programmatic API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	queryViolations(domain?: string, severity?: string, limit = 30): ICheckResult[] {
		let results = this.grcEngine.getAllResults();
		if (domain) { results = results.filter(r => r.domain === domain); }
		if (severity) { results = results.filter(r => (r.severity ?? '').toLowerCase() === severity.toLowerCase()); }
		return results.slice(0, limit);
	}

	getDomainSummary(): IDomainSummary[] {
		return this.grcEngine.getDomainSummary();
	}

	getBlockingViolations(): ICheckResult[] {
		return this.grcEngine.getBlockingViolations();
	}

	getRuleDetails(ruleId: string): IGRCRule | undefined {
		return this.grcEngine.getRules().find(r => r.id === ruleId);
	}

	getExternalToolStatus(): IExternalJob[] {
		return this.externalToolService.getJobs();
	}

	getModelInfo(): string {
		const sel = this._checksModelSelection
			?? this.voidSettingsService.state.modelSelectionOfFeature['Checks']
			?? this.voidSettingsService.state.modelSelectionOfFeature['Chat']
			?? null;
		if (!sel) { return 'no model'; }
		return `${sel.modelName} · ${sel.providerName}`;
	}

	getAvailableModels(): ModelOption[] {
		return this.voidSettingsService.state._modelOptions ?? [];
	}

	setModel(selection: ModelSelection): void {
		this._checksModelSelection = selection;
	}

	askPowerMode(question: string): Promise<string> {
		if (!this.powerBus.isRegistered('power-mode')) {
			return Promise.resolve('[Power Mode is not available]');
		}

		return new Promise<string>((resolve) => {
			let resolved = false;
			const finish = (result: string) => {
				if (resolved) { return; }
				resolved = true;
				clearTimeout(timer);
				resolve(result);
			};

			// 60s \u2014 Power Mode aborts at 55s and always sends a reply before this fires
			const timer = setTimeout(() => {
				for (const [id, fn] of this._pendingBusRequests) {
					if (fn === finish) { this._pendingBusRequests.delete(id); break; }
				}
				finish('[Power Mode did not respond in time]');
			}, 60_000);

			// Capture the bus-assigned ID synchronously (publish fires onMessage sync)
			let capturedId: string | undefined;
			const captureOnce = this.powerBus.onMessage((msg: IAgentBusMessage) => {
				if (!capturedId && msg.from === 'checks-agent' && msg.type === 'query') {
					capturedId = msg.id;
					this._pendingBusRequests.set(capturedId, finish);
					captureOnce.dispose();
				}
			});

			this.powerBus.send('checks-agent', 'power-mode', 'query', question);

			if (!capturedId) { captureOnce.dispose(); }
		});
	}

	async answerQuery(question: string): Promise<string> {
		let directory: string;
		let wsCtx: { isGitRepo: boolean; workingDirectory: string; customInstructions?: string } | undefined;
		let systemPrompt: string;
		try {
			directory = this.workspaceContext.getWorkspace().folders[0]?.uri.fsPath ?? '/';
			wsCtx = await this._contextBuilder.build(directory);
			systemPrompt = this._buildSystemPrompt(wsCtx);
		} catch (e: any) {
			return `[Checks Agent error: ${e.message ?? 'failed to build context'}]`;
		}

		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), 60_000); // 60s \u2014 allow multi-step tool-call rounds

		let _idCtr = 0;
		const nextId = () => `aq_${Date.now()}_${++_idCtr}`;

		const userMsg: IChecksMessage = {
			id: nextId(), sessionId: 'silent', role: 'user',
			createdAt: Date.now(),
			parts: [{ type: 'text', id: nextId(), text: question }],
		};
		const assistantMsg: IChecksMessage = {
			id: nextId(), sessionId: 'silent', role: 'assistant',
			createdAt: Date.now(), parts: [],
		};

		const callbacks: IProcessorCallbacks = {
			onPartCreated: () => { /* silent */ },
			onPartUpdated: () => { /* silent */ },
			onTextDelta: () => { /* silent */ },
			sendToLLM: (req) => this._llmBridge.sendToLLM(req, this._checksModelSelection),
		};

		try {
			await runChecksAgentLoop({
				assistantMessage: assistantMsg,
				sessionMessages: [userMsg, assistantMsg],
				toolRegistry: this._toolRegistry,
				callbacks,
				abort: abort.signal,
				systemPrompt,
			});
		} catch { /* still return whatever was collected */ }

		clearTimeout(timer);

		return assistantMsg.parts
			.filter((p): p is IChecksTextPart => p.type === 'text')
			.map(p => p.text)
			.join('')
			|| 'No answer available.';
	}

	prefill(text: string): void {
		this._onDidEmitUIEvent.fire({ type: 'prefill' as any, text } as any);
	}

	// \u2500\u2500\u2500 Private \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _nextId(): string {
		return `ca_${Date.now()}_${generateUuid().substring(0, 8)}`;
	}

	private _setStatus(session: IChecksSession, status: ChecksSessionStatus): void {
		session.status = status;
		this._onDidEmitUIEvent.fire({ type: 'session-updated', sessionId: session.id, status });
	}

	private _buildSystemPrompt(wsCtx?: { isGitRepo: boolean; workingDirectory: string; customInstructions?: string }): string {
		let posture = '';
		try {
			const allResults = this.grcEngine.getAllResults();
			const blocking = this.grcEngine.getBlockingViolations();
			const summary = this.grcEngine.getDomainSummary();
			const frameworks = this.grcEngine.getActiveFrameworks();
			const errors = allResults.filter(r => (r.severity ?? '').toLowerCase() === 'error').length;
			const warnings = allResults.filter(r => (r.severity ?? '').toLowerCase() === 'warning').length;
			const domainsWithIssues = summary
				.filter(d => d.errorCount + d.warningCount > 0)
				.map(d => `${d.domain}(${d.errorCount}e,${d.warningCount}w)`)
				.join(', ');

			posture = [
				`<grc_posture>`,
				`  Total violations: ${allResults.length} (${errors} errors, ${warnings} warnings)`,
				`  Blocking violations: ${blocking.length}`,
				`  Active frameworks: ${frameworks.map(f => f.name).join(', ') || 'none'}`,
				`  Rules loaded: ${this.grcEngine.getRules().length}`,
				`  Domains with issues: ${domainsWithIssues || 'none'}`,
				`</grc_posture>`,
			].join('\n');
		} catch {
			posture = '<grc_posture>Engine not ready yet.</grc_posture>';
		}

		const directory = wsCtx?.workingDirectory ?? this.workspaceContext.getWorkspace().folders[0]?.uri.fsPath ?? '/';

		return buildChecksSystemPrompt({
			grcPosture: posture,
			workingDirectory: directory,
			isGitRepo: wsCtx?.isGitRepo ?? false,
			customInstructions: wsCtx?.customInstructions,
			modernisationContext: this._buildModernisationContext(),
		});
	}

	private _buildModernisationContext(): string | undefined {
		const session = this.modernisationSessionService.session;
		if (!session?.isActive) { return undefined; }
		const lines: string[] = [
			`Stage: ${session.currentStage}  |  Pattern: ${session.migrationPattern ?? 'custom'}  |  Plan approved: ${session.planApproved ? 'yes' : 'no'}`,
		];
		if (session.sources.length > 0) {
			lines.push('Source (legacy) projects \u2014 use these ABSOLUTE paths:');
			for (const s of session.sources) { lines.push(`  ${s.label}: ${s.folderUri}`); }
		}
		if (session.targets.length > 0) {
			lines.push('Target (modern) projects \u2014 use these ABSOLUTE paths:');
			for (const t of session.targets) { lines.push(`  ${t.label}: ${t.folderUri}`); }
		}
		if (session.activeSourceFileUri) { lines.push(`Active source file: ${session.activeSourceFileUri}`); }
		if (session.activeTargetFileUri) { lines.push(`Active target file: ${session.activeTargetFileUri}`); }
		lines.push('Always use the absolute folder paths above \u2014 do NOT treat project labels as relative directory names.');
		return lines.join('\n');
	}

	private _restoreSession(): void {
		const stored = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
		if (!stored) { return; }
		try {
			const data = JSON.parse(stored) as IChecksSession;
			// Only restore if it has recent activity (last 24 hours)
			if (Date.now() - data.updatedAt < 24 * 60 * 60 * 1000) {
				data.status = 'idle'; // never restore as busy
				this._session = data;
			}
		} catch {
			// Ignore corrupt data
		}
	}

	private _persistSession(): void {
		if (!this._session) { return; }
		// Keep only the last N messages to avoid storage bloat
		const sessionToPersist: IChecksSession = {
			...this._session,
			messages: this._session.messages.slice(-MAX_PERSISTED_MESSAGES),
		};
		this.storageService.store(
			STORAGE_KEY,
			JSON.stringify(sessionToPersist),
			StorageScope.WORKSPACE,
			StorageTarget.USER,
		);
	}
}

registerSingleton(IChecksAgentService, ChecksAgentService, InstantiationType.Eager);
