/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { ILLMMessageService } from '../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService, ModelOption } from '../../void/common/voidSettingsService.js';
import { ModelSelection } from '../../void/common/voidSettingsTypes.js';
import { IExternalCommandExecutor } from '../../neuralInverseChecks/browser/engine/services/externalCommandExecutor.js';
import { IGRCEngineService } from '../../neuralInverseChecks/browser/engine/services/grcEngineService.js';
import { buildGRCTools } from './tools/grcTools.js';
import { buildModernisationPowerTools } from './tools/modernisationTools.js';
import { buildDiscoveryTools } from './tools/discoveryTools.js';
import { buildAutonomyPowerTools } from './tools/autonomyPowerTools.js';
import { buildKBPowerTools } from './tools/kbPowerTools.js';
import { IDiscoveryService } from '../../neuralInverseModernisation/browser/engine/discovery/discoveryService.js';
import { IMigrationPlannerService } from '../../neuralInverseModernisation/browser/engine/migrationPlannerService.js';
import { IModernisationSessionService } from '../../neuralInverseModernisation/browser/modernisationSessionService.js';
import { IModernisationAgentToolService } from '../../neuralInverseModernisation/browser/engine/agentTools/service.js';
import { IAutonomyService } from '../../neuralInverseModernisation/browser/engine/autonomy/service.js';
import { INeuralInverseSubAgentService } from '../../void/browser/neuralInverseSubAgentService.js';
import { IFirmwareSessionService } from '../../neuralInverseFirmware/browser/firmwareSessionService.js';
import { buildFirmwareContext } from '../../neuralInverseFirmware/browser/engine/hardwareContext/hardwareContextProvider.js';
import { buildFirmwareSystemPrompt } from '../../neuralInverseFirmware/browser/engine/firmwareSystemPrompt.js';
import { IFirmwareAgentToolService } from '../../neuralInverseFirmware/browser/engine/agentTools/firmwareAgentToolService.js';
import { buildFirmwarePowerTools } from './tools/firmwareTools.js';
import {
	IPowerSession,
	IPowerMessage,
	IPowerMessagePart,
	ITextPart,
	IPowerAgent,
	PowerModeUIEvent,
	ToolPermissionDecision,
	PowerSessionStatus,
} from '../common/powerModeTypes.js';
import { runAgentLoop, IProcessorCallbacks, ILLMRequest } from './session/powerModeProcessor.js';
import { PowerModeLLMBridge } from './session/powerModeLLMBridge.js';
import { PowerToolRegistry } from './tools/powerToolRegistry.js';
import { buildSystemPrompt } from './session/systemPrompt.js';
import { PowerModeContextBuilder } from './session/powerModeContextBuilder.js';
import {
	createBrowserBashTool,
	createBrowserReadTool,
	createBrowserWriteTool,
	createBrowserEditTool,
	createBrowserGlobTool,
	createBrowserGrepTool,
	createBrowserListTool,
} from './tools/browserTools.js';
import {
	createAskUserTool,
	createWebFetchTool,
	createTaskCreateTool,
	createTaskListTool,
	createTaskUpdateTool,
	createTaskGetTool,
	createGitStatusTool,
	createGitDiffTool,
	createGitCommitTool,
	createMemoryWriteTool,
	createMemoryReadTool,
	createRunTestsTool,
} from './tools/advancedTools.js';
import {
	createSpawnAgentTool,
	createGetAgentStatusTool,
	createWaitForAgentTool,
	createListAgentsTool,
} from './tools/subAgentTools.js';
import { IPowerBusService } from './powerBusService.js';
import type { IRegisteredAgent, IAgentBusMessage } from '../common/powerBusTypes.js';
import { PowerModeChangeTracker, IPowerModeChangeTracker, IChangeGroup } from './powerModeChangeTracker.js';

// ─── Service Interface ────────────────────────────────────────────────────────

export const IPowerModeService = createDecorator<IPowerModeService>('powerModeService');

export interface IPowerModeService {
	readonly _serviceBrand: undefined;

	/** All tracked sessions */
	readonly sessions: readonly IPowerSession[];

	/** The currently active session (shown in UI) */
	readonly activeSession: IPowerSession | undefined;

	/** Fires when any session state changes */
	readonly onDidChangeSession: Event<IPowerSession>;

	/** Fires for real-time part updates (streaming text, tool progress) */
	readonly onDidUpdatePart: Event<{ sessionId: string; messageId: string; part: IPowerMessagePart }>;

	/** Fires for text deltas (streaming) */
	readonly onDidEmitDelta: Event<{ sessionId: string; messageId: string; partId: string; field: string; delta: string }>;

	/** Fires for UI events (aggregated for webview) */
	readonly onDidEmitUIEvent: Event<PowerModeUIEvent>;

	// ─── Session Management ──────────────────────────────────────────────

	createSession(agentId?: string): IPowerSession;
	switchSession(sessionId: string): void;
	deleteSession(sessionId: string): void;
	getSession(sessionId: string): IPowerSession | undefined;

	// ─── Execution ──────────────────────────────────────────────────────

	/** Send a user message and start the agent loop */
	sendMessage(sessionId: string, text: string): Promise<void>;

	/** Cancel the active run in a session */
	cancel(sessionId: string): void;

	/** Resolve a pending tool permission request from the terminal */
	resolvePermission(requestId: string, decision: ToolPermissionDecision): void;

	/** Resolve a pending ask_user question */
	resolveQuestion(questionId: string, answer: string): void;

	// ─── Agents ─────────────────────────────────────────────────────────

	getAgents(): IPowerAgent[];

	// ─── Model ───────────────────────────────────────────────────────────

	/** Get current Power Mode model (own selection or falls back to Chat) */
	getModelInfo(): { provider: string; model: string } | undefined;

	/** Get full ModelSelection for use with the LLM bridge */
	getModelSelection(): ModelSelection | null;

	/** Get all available models the user has configured */
	getAvailableModels(): ModelOption[];

	/** Set Power Mode's own model selection */
	setModel(selection: ModelSelection): void;

	/** Clear all messages in a session */
	clearSession(sessionId: string): void;

	// ─── Bus ─────────────────────────────────────────────────────────────

	/** All agents currently registered on the PowerBus */
	getAgentsOnBus(): IRegisteredAgent[];

	/** Recent PowerBus message history */
	getBusHistory(limit?: number): IAgentBusMessage[];

	/**
	 * Answer a natural-language question using Power Mode's own LLM + tools.
	 * Silent — no UI events, no streaming to webview.
	 * Used directly by the void coding agent via the ask_powermode tool.
	 * @param question - The question to answer
	 * @param allowWrite - If true, allows write/edit/bash tools (for editor/verifier sub-agents). Default: false (read-only)
	 */
	answerQuery(question: string, allowWrite?: boolean): Promise<string>;

	/**
	 * Get the change tracker (for review/rollback UI)
	 */
	getChangeTracker(): IPowerModeChangeTracker;

	/**
	 * Get latest change group (for "press /review" prompt)
	 */
	getLatestChanges(): IChangeGroup | null;
}

// ─── Implementation ───────────────────────────────────────────────────────────

const STORAGE_KEY = 'powerMode.sessions';
const MAX_PERSISTED_MESSAGES = 40;

export class PowerModeService extends Disposable implements IPowerModeService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSession = this._register(new Emitter<IPowerSession>());
	readonly onDidChangeSession = this._onDidChangeSession.event;

	private readonly _onDidUpdatePart = this._register(new Emitter<{ sessionId: string; messageId: string; part: IPowerMessagePart }>());
	readonly onDidUpdatePart = this._onDidUpdatePart.event;

	private readonly _onDidEmitDelta = this._register(new Emitter<{ sessionId: string; messageId: string; partId: string; field: string; delta: string }>());
	readonly onDidEmitDelta = this._onDidEmitDelta.event;

	private readonly _onDidEmitUIEvent = this._register(new Emitter<PowerModeUIEvent>());
	readonly onDidEmitUIEvent = this._onDidEmitUIEvent.event;

	private readonly _sessions = new Map<string, IPowerSession>();
	private _activeSessionId: string | undefined;

	/** Active abort controllers per session */
	private readonly _abortControllers = new Map<string, AbortController>();

	/** Pending tool permission requests: requestId → resolver */
	private readonly _pendingApprovals = new Map<string, (decision: ToolPermissionDecision) => void>();

	private _approvalCounter = 0;

	/** Pending ask_user questions: questionId → resolver */
	private readonly _pendingQuestions = new Map<string, (answer: string) => void>();

	private _questionCounter = 0;

	/** LLM bridge for processor */
	private readonly _llmBridge: PowerModeLLMBridge;

	/** Change tracker (for review/rollback) */
	private readonly _changeTracker: PowerModeChangeTracker;

	/** Tool registries per working directory */
	private readonly _toolRegistries = new Map<string, PowerToolRegistry>();

	/** Workspace context builder (reads AGENTS.md, package.json, etc.) */
	private readonly _contextBuilder: PowerModeContextBuilder;

	/** Built-in agent definitions */
	private readonly _agents: IPowerAgent[] = [
		{
			id: 'build',
			name: 'Build',
			description: 'The default agent. Full access to tools for building and editing code.',
			mode: 'primary',
			maxSteps: 200,
			permissions: {
				tools: { '*': 'allow', bash: 'allow', write: 'allow', edit: 'allow', spawn_agent: 'ask' },
			},
		},
		{
			id: 'plan',
			name: 'Plan',
			description: 'Read-only agent for planning. Cannot modify files.',
			mode: 'primary',
			maxSteps: 50,
			permissions: {
				tools: { '*': 'allow', write: 'deny', edit: 'deny', bash: 'ask' },
			},
		},
	];

	private _idCounter = 0;

	/** Power Mode's own model selection — null means fall back to Chat selection */
	private _powerModeModelSelection: ModelSelection | null = null;

	/** Last GRC posture received from Checks Agent — injected into every task's system prompt */
	private _lastKnownGRCPosture: string | null = null;
	/** Pending GRC posture queries: original message ID → resolver */
	private readonly _pendingGRCQueries = new Map<string, (result: string) => void>();
	/** Pending ask_checksagent queries: original message ID → resolver (separate from posture cache) */
	private readonly _pendingChecksAgentQueries = new Map<string, (result: string) => void>();
	/** Last successfully built workspace context — reused for Checks Agent queries to avoid I/O delay */
	private _cachedWsCtx: { isGitRepo: boolean; customInstructions?: string } | null = null;

	/** Cached sub-agent service instance (resolved once, reused by all tools) */
	private _subAgentServiceCache: INeuralInverseSubAgentService | null | undefined;
	private _getSubAgentService(): INeuralInverseSubAgentService | null {
		if (this._subAgentServiceCache === undefined) {
			try {
				this._subAgentServiceCache = this.instantiationService.invokeFunction(a => a.get(INeuralInverseSubAgentService));
			} catch (err) {
				console.error('[PowerMode] Failed to resolve sub-agent service:', err);
				this._subAgentServiceCache = null;
			}
		}
		return this._subAgentServiceCache;
	}

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@ISearchService private readonly searchService: ISearchService,
		@IExternalCommandExecutor private readonly commandExecutor: IExternalCommandExecutor,
		@ILLMMessageService llmMessageService: ILLMMessageService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IPowerBusService private readonly powerBusService: IPowerBusService,
		@IGRCEngineService private readonly grcEngine: IGRCEngineService,
		@IDiscoveryService private readonly discoveryService: IDiscoveryService,
		@IMigrationPlannerService private readonly migrationPlannerService: IMigrationPlannerService,
		@IModernisationSessionService private readonly modernisationSessionService: IModernisationSessionService,
		@IModernisationAgentToolService private readonly agentToolService: IModernisationAgentToolService,
		@IFirmwareSessionService private readonly firmwareSessionService: IFirmwareSessionService,
		@IFirmwareAgentToolService private readonly firmwareAgentToolService: IFirmwareAgentToolService,
		@IAutonomyService private readonly autonomyService: IAutonomyService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._llmBridge = new PowerModeLLMBridge(llmMessageService, voidSettingsService);
		this._contextBuilder = new PowerModeContextBuilder(fileService);
		this._changeTracker = this._register(new PowerModeChangeTracker(fileService));

		// ── PowerBus: register Power Mode as the central agent ──────────
		this.powerBusService.register('power-mode', ['receive:all', 'send:query', 'broadcast'], 'Power Mode');

		// Handle incoming bus messages addressed to power-mode
		this._register(this.powerBusService.onMessage(msg => {
			if (msg.to !== 'power-mode' && msg.to !== '*') { return; }

			// Capture GRC posture query responses
			if (msg.from === 'checks-agent' && msg.type === 'response' && msg.replyTo) {
				// Route ask_checksagent answers (separate from posture cache)
				const pendingChecks = this._pendingChecksAgentQueries.get(msg.replyTo);
				if (pendingChecks) {
					this._pendingChecksAgentQueries.delete(msg.replyTo);
					pendingChecks(msg.content);
					return;
				}
				const pending = this._pendingGRCQueries.get(msg.replyTo);
				if (pending) {
					this._pendingGRCQueries.delete(msg.replyTo);
					this._lastKnownGRCPosture = msg.content;
					pending(msg.content);
					return;
				}
			}

			// Cache GRC state from broadcasts
			if (msg.from === 'checks-agent' && msg.type === 'broadcast') {
				try {
					const data = JSON.parse(msg.content);
					if (data.type === 'grc-posture-update' || data.type === 'blocking-violations-alert') {
						this._lastKnownGRCPosture = msg.content;
					}
				} catch { /* not JSON */ }
			}

			// Checks Agent is asking Power Mode a question — run the agent and reply
			if (msg.from === 'checks-agent' && msg.type === 'query' && msg.to === 'power-mode') {
				this._answerChecksQuery(msg.id, msg.content);
				return;
			}

			// Forward to terminal UI
			if (msg.to === 'power-mode') {
				this._onDidEmitUIEvent.fire({
					type: 'bus-message',
					from: msg.from,
					to: msg.to,
					messageType: msg.type,
					content: msg.content,
				});
			}
		}));

		// Handle tool requests arriving from other agents on the bus
		this._register(this.powerBusService.onToolRequest(async (msg) => {
			if (!msg.toolName || !msg.toolArgs || !msg.toolDirectory) { return; }

			// Read-only tools execute without prompting the user
			const readOnlyTools = new Set(['read', 'glob', 'grep', 'list']);
			const needsApproval = !readOnlyTools.has(msg.toolName);

			if (needsApproval) {
				const requestId = `perm_${++this._approvalCounter}`;
				const preview = _buildToolPreview(msg.toolName, msg.toolArgs);

				const decision = await new Promise<ToolPermissionDecision>((resolve) => {
					this._pendingApprovals.set(requestId, resolve);
					this._onDidEmitUIEvent.fire({
						type: 'permission-request',
						request: {
							requestId,
							sessionId: msg.from,
							toolName: `[${msg.from}] ${msg.toolName}`,
							preview,
						},
					});
				});

				if (decision === 'deny') {
					this.powerBusService.resolveToolRequest(msg.id, 'Tool execution denied by user.', true);
					return;
				}
			}

			// Execute via the tool registry for the requested directory
			try {
				const registry = this._getToolRegistry(msg.toolDirectory);
				const tool = registry.get(msg.toolName);
				if (!tool) {
					this.powerBusService.resolveToolRequest(msg.id, `Tool '${msg.toolName}' not found.`, true);
					return;
				}
				const result = await tool.execute(msg.toolArgs, {
					sessionId: msg.from,
					messageId: msg.id,
					agentId: msg.from,
					abort: new AbortController().signal,
					metadata: () => { /* no-op for bus-requested tools */ },
				});
				this.powerBusService.resolveToolRequest(msg.id, result.output);
			} catch (err: any) {
				this.powerBusService.resolveToolRequest(msg.id, String(err?.message ?? err), true);
			}
		}));

		this._restoreSessions();

		// Pre-warm context cache so the first user message doesn't block on filesystem I/O
		const directory = this.workspaceContext.getWorkspace().folders[0]?.uri.fsPath;
		if (directory) { this._contextBuilder.build(directory).then(ctx => { this._cachedWsCtx = ctx; }).catch(() => { /* ignore */ }); }
	}

	// ─── Getters ─────────────────────────────────────────────────────────────

	get sessions(): readonly IPowerSession[] {
		return [...this._sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	get activeSession(): IPowerSession | undefined {
		return this._activeSessionId ? this._sessions.get(this._activeSessionId) : undefined;
	}

	// ─── Session Management ──────────────────────────────────────────────────

	createSession(agentId: string = 'build'): IPowerSession {
		const id = `ps_${Date.now()}_${++this._idCounter}`;
		const workspace = this.workspaceContext.getWorkspace();
		const directory = workspace.folders[0]?.uri.fsPath ?? '/';

		const session: IPowerSession = {
			id,
			title: 'New session',
			agentId,
			directory,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			status: 'idle',
			messages: [],
		};

		this._sessions.set(id, session);
		this._activeSessionId = id;
		this._persistSessions();

		// Set parent context for sub-agents
		const subAgentService = this._getSubAgentService();
		if (subAgentService) {
			subAgentService.setParentContext({ id, type: 'power-session' });
		}

		this._onDidChangeSession.fire(session);
		this._onDidEmitUIEvent.fire({ type: 'session-created', session });
		return session;
	}

	switchSession(sessionId: string): void {
		if (!this._sessions.has(sessionId)) { return; }
		this._activeSessionId = sessionId;
		const session = this._sessions.get(sessionId)!;

		// Set parent context for sub-agents
		const subAgentService = this._getSubAgentService();
		if (subAgentService) {
			subAgentService.setParentContext({ id: sessionId, type: 'power-session' });
		}

		this._onDidChangeSession.fire(session);
	}

	deleteSession(sessionId: string): void {
		this.cancel(sessionId);
		this._sessions.delete(sessionId);
		if (this._activeSessionId === sessionId) {
			this._activeSessionId = this.sessions[0]?.id;
			// Update parent context for remaining session or clear if none
			const subAgentService = this._getSubAgentService();
			if (subAgentService) {
				if (this._activeSessionId) {
					subAgentService.setParentContext({ id: this._activeSessionId, type: 'power-session' });
				} else {
					subAgentService.setParentContext(null);
				}
			}
		}
		this._persistSessions();
	}

	getSession(sessionId: string): IPowerSession | undefined {
		return this._sessions.get(sessionId);
	}

	// ─── Tool Registry ───────────────────────────────────────────────────────

	private _getToolRegistry(directory: string): PowerToolRegistry {
		let registry = this._toolRegistries.get(directory);
		if (!registry) {
			registry = new PowerToolRegistry();
			registry.registerMany([
				// Core filesystem tools
				createBrowserBashTool(directory, this.commandExecutor),
				createBrowserReadTool(directory, this.fileService),
				createBrowserWriteTool(directory, this.fileService, this._changeTracker),
				createBrowserEditTool(directory, this.fileService, this._changeTracker),
				createBrowserListTool(directory, this.fileService),
				createBrowserGlobTool(directory, this.searchService),
				createBrowserGrepTool(directory, this.searchService),
				// GRC compliance tools
				...buildGRCTools(this.grcEngine, (q) => this._queryChecksAgent(q)),
				// Standalone discovery tools (key findings on any codebase)
				...buildDiscoveryTools(this.discoveryService),
				// Modernisation tools (migration workflow context)
				...buildModernisationPowerTools(this.discoveryService, this.migrationPlannerService, this.modernisationSessionService),
				// Firmware tools — fw_* tools available when a firmware session is active
				...buildFirmwarePowerTools(this.firmwareAgentToolService),
				// 67 KB tools (unit read/write, decisions, glossary, phases, compliance, etc.)
				...buildKBPowerTools(this.agentToolService),
				// Autonomy pipeline tools (batch control + single-unit + escalations)
				...buildAutonomyPowerTools(this.autonomyService),
				// High-priority workflow tools
				createAskUserTool((question, sessionId) => this._askUser(question, sessionId)),
				createWebFetchTool(),
				// Workflow task management (renamed to avoid confusion with 'list')
				createTaskCreateTool(),   // tasks_create
				createTaskListTool(),     // tasks_list
				createTaskUpdateTool(),   // tasks_update
				createTaskGetTool(),      // tasks_get
				// Git tools
				createGitStatusTool(directory, this.commandExecutor),
				createGitDiffTool(directory, this.commandExecutor),
				createGitCommitTool(directory, this.commandExecutor),
				// Memory tools
				createMemoryWriteTool(directory, this.fileService),
				createMemoryReadTool(directory, this.fileService),
				// Test execution
				createRunTestsTool(directory, this.commandExecutor, this.fileService),
			]);

			// Sub-agent orchestration (lazy-resolved to avoid circular dependency)
			// CRITICAL: Use the same cached service instance for ALL tools
			try {
				const subAgentService = this._getSubAgentService();
				if (subAgentService) {
					const agentTools = [
						createSpawnAgentTool(subAgentService),
						createGetAgentStatusTool(subAgentService),
						createWaitForAgentTool(subAgentService, this),
						createListAgentsTool(subAgentService),
					];
					registry.registerMany(agentTools);
				}
			} catch (err) {
				console.error('[PowerMode] Failed to register sub-agent tools:', err);
			}

			this._toolRegistries.set(directory, registry);
		}
		return registry;
	}

	// ─── GRC Integration ─────────────────────────────────────────────────────

	/**
	 * Query Checks Agent for current GRC posture via the bus.
	 * Returns a JSON string with violations summary, or the last cached posture
	 * if Checks Agent is not registered or doesn't respond within 2s.
	 */
	/**
	 * Build a compact modernisation session context string for injection into
	 * the system prompt.  Returns undefined when no session is active so the
	 * prompt stays clean for regular coding tasks.
	 */
	private _buildModernisationContext(): string | undefined {
		const session = this.modernisationSessionService.session;
		if (!session?.isActive) { return undefined; }
		const lines: string[] = [
			`Stage: ${session.currentStage}  |  Pattern: ${session.migrationPattern ?? 'custom'}  |  Plan approved: ${session.planApproved ? 'yes' : 'no'}`,
		];
		if (session.sources.length > 0) {
			lines.push('Source (legacy) projects — use these ABSOLUTE paths:');
			for (const s of session.sources) { lines.push(`  ${s.label}: ${s.folderUri}`); }
		}
		if (session.targets.length > 0) {
			lines.push('Target (modern) projects — use these ABSOLUTE paths:');
			for (const t of session.targets) { lines.push(`  ${t.label}: ${t.folderUri}`); }
		}
		if (session.activeSourceFileUri) { lines.push(`Active source file: ${session.activeSourceFileUri}`); }
		if (session.activeTargetFileUri) { lines.push(`Active target file: ${session.activeTargetFileUri}`); }
		lines.push('Always use the absolute folder paths above — do NOT treat project labels as relative directory names.');
		return lines.join('\n');
	}

	/**
	 * Build firmware context + agent prompt for Power Mode system prompt injection.
	 * Returns undefined when no firmware session is active.
	 */
	private _buildFirmwareContextAndPrompt(): { firmwareContext?: string; firmwareAgentPrompt?: string } | undefined {
		const session = this.firmwareSessionService.session;
		if (!session?.isActive) { return undefined; }
		return {
			firmwareContext: buildFirmwareContext(this.firmwareSessionService),
			firmwareAgentPrompt: buildFirmwareSystemPrompt(session),
		};
	}

	private _queryGRCPosture(): Promise<string> {
		if (!this.powerBusService.isRegistered('checks-agent')) {
			return Promise.resolve(this._lastKnownGRCPosture ?? '');
		}

		return new Promise<string>((resolve) => {
			const finish = (result: string) => {
				clearTimeout(timer);
				captureOnce.dispose();
				resolve(result);
			};

			// 2s timeout — fast enough to not delay user-visible latency
			const timer = setTimeout(() => finish(this._lastKnownGRCPosture ?? ''), 2000);

			// Capture the bus-assigned ID of our outgoing query synchronously
			// (publish() fires onMessage synchronously before returning)
			let capturedId: string | undefined;
			const captureOnce = this.powerBusService.onMessage((msg: IAgentBusMessage) => {
				if (!capturedId && msg.from === 'power-mode' && msg.type === 'query') {
					capturedId = msg.id;
					this._pendingGRCQueries.set(capturedId, finish);
					captureOnce.dispose();
				}
			});

			this.powerBusService.send('power-mode', 'checks-agent', 'query', 'posture-summary');

			if (!capturedId) { captureOnce.dispose(); }
		});
	}

	/**
	 * Ask the Checks Agent a natural-language compliance question via the PowerBus.
	 * Used by the ask_checksagent tool in the GRC tool registry.
	 * Kept separate from _pendingGRCQueries so LLM answers don't pollute the posture cache.
	 */
	private _queryChecksAgent(question: string): Promise<string> {
		if (!this.powerBusService.isRegistered('checks-agent')) {
			return Promise.resolve('[Checks Agent is not available]');
		}

		return new Promise<string>((resolve) => {
			let resolved = false;
			const finish = (result: string) => {
				if (resolved) { return; }
				resolved = true;
				clearTimeout(timer);
				captureOnce.dispose();
				resolve(result);
			};

			// 35s — Checks Agent times out at 30s and always sends a reply before this fires
			const timer = setTimeout(() => {
				for (const [id, fn] of this._pendingChecksAgentQueries) {
					if (fn === finish) { this._pendingChecksAgentQueries.delete(id); break; }
				}
				finish('[Checks Agent did not respond in time]');
			}, 35_000);

			// Capture the bus-assigned ID synchronously (publish fires onMessage sync)
			let capturedId: string | undefined;
			const captureOnce = this.powerBusService.onMessage((msg: IAgentBusMessage) => {
				if (!capturedId && msg.from === 'power-mode' && msg.type === 'query') {
					capturedId = msg.id;
					this._pendingChecksAgentQueries.set(capturedId, finish);
					captureOnce.dispose();
				}
			});

			this.powerBusService.send('power-mode', 'checks-agent', 'query', question);

			if (!capturedId) { captureOnce.dispose(); }
		});
	}

	// ─── Execution ───────────────────────────────────────────────────────────

	async sendMessage(sessionId: string, text: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (!session) { return; }
		if (session.status === 'busy') { return; }

		// Create user message
		const userMsg: IPowerMessage = {
			id: `msg_${Date.now()}_${++this._idCounter}`,
			sessionId,
			role: 'user',
			createdAt: Date.now(),
			parts: [{ type: 'text', id: `p_${++this._idCounter}`, text }],
		};

		// Auto-title session from first user message
		if (session.messages.length === 0 && session.title === 'New session') {
			(session as any).title = text.length > 60 ? text.substring(0, 60) + '…' : text;
			this._onDidChangeSession.fire(session);
		}

		session.messages.push(userMsg);
		session.status = 'busy';
		session.updatedAt = Date.now();

		this._onDidEmitUIEvent.fire({ type: 'message-created', message: userMsg });
		this._onDidEmitUIEvent.fire({ type: 'session-updated', sessionId, status: 'busy' });
		this._onDidChangeSession.fire(session);

		// Create abort controller for this run
		const abortController = new AbortController();
		this._abortControllers.set(sessionId, abortController);

		try {
			// Create assistant message
			const assistantMsg: IPowerMessage = {
				id: `msg_${Date.now()}_${++this._idCounter}`,
				sessionId,
				role: 'assistant',
				createdAt: Date.now(),
				agentId: session.agentId,
				parts: [],
			};
			session.messages.push(assistantMsg);
			this._onDidEmitUIEvent.fire({ type: 'message-created', message: assistantMsg });

			// Resolve agent
			const agent = this._agents.find(a => a.id === session.agentId) ?? this._agents[0];

			// Build workspace context (AGENTS.md, package.json, git detection)
			const wsCtx = await this._contextBuilder.build(session.directory);
			this._cachedWsCtx = wsCtx;

			// Query Checks Agent for live GRC posture — runs in parallel with context build
			const grcPosture = await this._queryGRCPosture();

			// Build system prompt with real workspace context + GRC state + modernisation session + firmware session
			const fwCtx = this._buildFirmwareContextAndPrompt();
			const systemPrompt = buildSystemPrompt({
				workingDirectory: session.directory,
				agentId: agent.id,
				agentPrompt: agent.systemPrompt,
				isGitRepo: wsCtx.isGitRepo,
				customInstructions: wsCtx.customInstructions || undefined,
				grcPosture: grcPosture || undefined,
				modernisationContext: this._buildModernisationContext(),
				firmwareContext: fwCtx?.firmwareContext,
				firmwareAgentPrompt: fwCtx?.firmwareAgentPrompt,
			});

			// Build callbacks that bridge processor events → UI events
			const callbacks: IProcessorCallbacks = {
				onPartCreated: (part: IPowerMessagePart) => {
					this._onDidEmitUIEvent.fire({
						type: 'part-updated',
						sessionId,
						messageId: assistantMsg.id,
						part,
					});
				},
				onPartUpdated: (part: IPowerMessagePart) => {
					this._onDidEmitUIEvent.fire({
						type: 'part-updated',
						sessionId,
						messageId: assistantMsg.id,
						part,
					});
				},
				onTextDelta: (partId: string, delta: string) => {
					this._onDidEmitUIEvent.fire({
						type: 'part-delta',
						sessionId,
						messageId: assistantMsg.id,
						partId,
						field: 'text',
						delta,
					});
				},
				sendToLLM: (request: ILLMRequest) => {
					return this._llmBridge.sendToLLM(request, this.getModelSelection());
				},
				askPermission: (toolName: string, input: Record<string, any>) => {
					const requestId = `perm_${++this._approvalCounter}`;
					const preview = _buildToolPreview(toolName, input);
					return new Promise<ToolPermissionDecision>((resolve) => {
						this._pendingApprovals.set(requestId, resolve);
						this._onDidEmitUIEvent.fire({
							type: 'permission-request',
							request: { requestId, sessionId, toolName, preview },
						});
					});
				},
			};

			// Run the agent loop (tools registered separately — currently empty registry)
			const result = await runAgentLoop({
				agent,
				assistantMessage: assistantMsg,
				sessionMessages: session.messages,
				toolRegistry: this._getToolRegistry(session.directory),
				callbacks,
				abort: abortController.signal,
				workingDirectory: session.directory,
				systemPrompt,
			});

			session.status = result === 'error' ? 'error' : 'idle';
		} catch (err: any) {
			session.status = 'error';
			this._onDidEmitUIEvent.fire({ type: 'error', error: String(err?.message ?? err) });
		} finally {
			this._abortControllers.delete(sessionId);
			session.updatedAt = Date.now();
			this._onDidEmitUIEvent.fire({ type: 'session-updated', sessionId, status: session.status });
			this._onDidChangeSession.fire(session);
			this._persistSessions();
		}
	}

	cancel(sessionId: string): void {
		const controller = this._abortControllers.get(sessionId);
		if (controller) {
			controller.abort();
			this._abortControllers.delete(sessionId);
		}
		// Deny any pending permission requests for this session
		for (const [requestId, resolve] of this._pendingApprovals) {
			if (requestId.startsWith('perm_')) {
				resolve('deny');
				this._pendingApprovals.delete(requestId);
			}
		}
		// Cancel any pending questions for this session
		for (const [questionId, resolve] of this._pendingQuestions) {
			if (questionId.startsWith('question_')) {
				resolve('[Cancelled by user]');
				this._pendingQuestions.delete(questionId);
			}
		}
		const session = this._sessions.get(sessionId);
		if (session && session.status === 'busy') {
			session.status = 'idle';
			session.updatedAt = Date.now();
			this._onDidChangeSession.fire(session);
			this._onDidEmitUIEvent.fire({ type: 'session-updated', sessionId, status: 'idle' });
		}
	}

	resolvePermission(requestId: string, decision: ToolPermissionDecision): void {
		const resolve = this._pendingApprovals.get(requestId);
		if (resolve) {
			this._pendingApprovals.delete(requestId);
			resolve(decision);
		}
	}

	resolveQuestion(questionId: string, answer: string): void {
		const resolve = this._pendingQuestions.get(questionId);
		if (resolve) {
			this._pendingQuestions.delete(questionId);
			resolve(answer);
		}
	}

	private _askUser(question: string, sessionId: string): Promise<string> {
		const questionId = `question_${++this._questionCounter}`;

		return new Promise<string>((resolve) => {
			this._pendingQuestions.set(questionId, resolve);

			// Fire UI event for terminal to show question prompt
			this._onDidEmitUIEvent.fire({
				type: 'user-question',
				questionId,
				sessionId,
				question,
			} as any);

			// Timeout after 5 minutes
			setTimeout(() => {
				const pending = this._pendingQuestions.get(questionId);
				if (pending) {
					this._pendingQuestions.delete(questionId);
					pending('[User did not respond within 5 minutes]');
				}
			}, 300000);
		});
	}

	// ─── Agents ──────────────────────────────────────────────────────────────

	getAgents(): IPowerAgent[] {
		return [...this._agents];
	}

	// ─── Info ─────────────────────────────────────────────────────────────────

	getModelSelection(): ModelSelection | null {
		// Use Power Mode's own selection if set, else fall back to Chat
		return this._powerModeModelSelection ?? this.voidSettingsService.state.modelSelectionOfFeature['Chat'];
	}

	getModelInfo(): { provider: string; model: string } | undefined {
		const sel = this.getModelSelection();
		if (!sel) { return undefined; }
		return { provider: sel.providerName, model: sel.modelName };
	}

	getAvailableModels(): ModelOption[] {
		return this.voidSettingsService.state._modelOptions;
	}

	setModel(selection: ModelSelection): void {
		this._powerModeModelSelection = selection;
	}

	clearSession(sessionId: string): void {
		const session = this._sessions.get(sessionId);
		if (!session) { return; }
		this.cancel(sessionId);
		session.messages = [];
		(session as any).title = 'New session';
		session.updatedAt = Date.now();
		this._contextBuilder.invalidate(session.directory);
		this._onDidChangeSession.fire(session);
		this._persistSessions();
	}

	// ─── Bus ─────────────────────────────────────────────────────────────

	getAgentsOnBus(): IRegisteredAgent[] {
		return this.powerBusService.getAgents();
	}

	getBusHistory(limit = 20): IAgentBusMessage[] {
		return this.powerBusService.getHistory(limit);
	}

	// ─── Persistence ─────────────────────────────────────────────────────────

	private _persistSessions(): void {
		const data = [...this._sessions.values()].map(s => ({
			id: s.id,
			title: s.title,
			agentId: s.agentId,
			directory: s.directory,
			createdAt: s.createdAt,
			updatedAt: s.updatedAt,
			status: s.status,
			// Keep only the last N messages to avoid storage bloat
			messages: s.messages.slice(-MAX_PERSISTED_MESSAGES),
		}));
		this.storageService.store(STORAGE_KEY, JSON.stringify(data), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	// ─── Bus: answer Checks Agent queries ────────────────────────────────────

	/**
	 * Checks Agent sent us a natural-language question via the bus.
	 * Delegates to answerQuery(), then replies on the bus.
	 */
	private async _answerChecksQuery(replyToId: string, question: string): Promise<void> {
		const answer = await this.answerQuery(`[bus] checks-agent → you: ${question}`);
		this.powerBusService.send('power-mode', 'checks-agent', 'response', answer, { replyTo: replyToId });
	}

	/**
	 * Answer a natural-language question using Power Mode's own LLM + tools.
	 * Silent — no UI events. Used directly by void coding agent (ask_powermode tool)
	 * and by the Checks Agent via the PowerBus (_answerChecksQuery).
	 *
	 * @param question - The question to answer
	 * @param allowWrite - If true, allows write/edit/bash tools (for editor/verifier sub-agents). Default: false (read-only)
	 */
	async answerQuery(question: string, allowWrite: boolean = false): Promise<string> {
		const workspace = this.workspaceContext.getWorkspace();
		const directory = workspace.folders[0]?.uri.fsPath ?? '/';

		// Default: read-only. If allowWrite=true, enable write/edit/bash for sub-agents
		const toolPermissions: Record<string, 'allow' | 'deny' | 'ask'> = allowWrite
			? { '*': 'allow', bash: 'allow', write: 'allow', edit: 'allow', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' }
			: { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', grc_violations: 'allow', grc_domain_summary: 'allow', grc_blocking_violations: 'allow', grc_framework_rules: 'allow', grc_impact_chain: 'allow' };

		const agent: IPowerAgent = {
			id: 'subagent-query',
			name: 'Subagent Query',
			description: allowWrite ? 'Sub-agent with write access (editor/verifier).' : 'Answers questions using read-only tools.',
			mode: 'primary',
			maxSteps: allowWrite ? 50 : 20,
			permissions: {
				tools: toolPermissions,
			},
		};

		let _idCounter = 0;
		const nextId = () => `aq_${Date.now()}_${++_idCounter}`;

		const userMsg: IPowerMessage = {
			id: nextId(), sessionId: 'subagent-query', role: 'user',
			createdAt: Date.now(),
			parts: [{ type: 'text', id: nextId(), text: question }],
		};
		const assistantMsg: IPowerMessage = {
			id: nextId(), sessionId: 'subagent-query', role: 'assistant',
			createdAt: Date.now(), parts: [],
		};

		const abort = new AbortController();
		// Longer timeout for write operations (3 minutes)
		const timeoutMs = allowWrite ? 180_000 : 55_000;
		const timeoutId = setTimeout(() => abort.abort(), timeoutMs);

		const callbacks: IProcessorCallbacks = {
			onPartCreated: () => { /* silent */ },
			onPartUpdated: () => { /* silent */ },
			onTextDelta: () => { /* silent */ },
			sendToLLM: (req) => this._llmBridge.sendToLLM(req, this.getModelSelection()),
			askPermission: async () => 'allow' as ToolPermissionDecision,
		};

		const wsCtx = this._cachedWsCtx ?? { isGitRepo: true };
		const fwCtxQuery = this._buildFirmwareContextAndPrompt();
		const systemPrompt = buildSystemPrompt({
			workingDirectory: directory,
			agentId: 'build',
			isGitRepo: wsCtx.isGitRepo,
			customInstructions: wsCtx.customInstructions || undefined,
			modernisationContext: this._buildModernisationContext(),
			firmwareContext: fwCtxQuery?.firmwareContext,
			firmwareAgentPrompt: fwCtxQuery?.firmwareAgentPrompt,
		});

		console.log('[PowerMode] answerQuery starting:', {
			allowWrite,
			toolCount: this._getToolRegistry(directory).forAgent(agent.permissions).length,
			maxSteps: agent.maxSteps,
			timeout: timeoutMs,
		});

		try {
			await runAgentLoop({
				agent, assistantMessage: assistantMsg,
				sessionMessages: [userMsg, assistantMsg],
				toolRegistry: this._getToolRegistry(directory),
				callbacks, abort: abort.signal,
				workingDirectory: directory, systemPrompt,
			});
		} catch (err) {
			// Log error but still return whatever was collected
			console.error('[PowerMode] answerQuery error:', err);
		}

		clearTimeout(timeoutId);

		// Log what was collected
		const toolCalls = assistantMsg.parts.filter(p => p.type === 'tool');
		console.log('[PowerMode] answerQuery completed:', {
			partCount: assistantMsg.parts.length,
			toolCallCount: toolCalls.length,
			textLength: assistantMsg.parts.filter((p): p is ITextPart => p.type === 'text').reduce((acc, p) => acc + p.text.length, 0),
		});

		return assistantMsg.parts
			.filter((p): p is ITextPart => p.type === 'text')
			.map(p => p.text)
			.join('')
			|| 'No answer available.';
	}

	private _restoreSessions(): void {
		const raw = this.storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) { return; }
		try {
			const entries = JSON.parse(raw) as Array<{
				id: string;
				title: string;
				agentId: string;
				directory: string;
				createdAt: number;
				updatedAt: number;
				status: PowerSessionStatus;
				messages: IPowerMessage[];
			}>;
			for (const entry of entries) {
				// Only restore if it has recent activity (last 24 hours)
				if (Date.now() - entry.updatedAt < 24 * 60 * 60 * 1000) {
					this._sessions.set(entry.id, {
						...entry,
						status: 'idle', // never restore as busy
						messages: entry.messages || [], // restore messages or empty array if missing
					});
				}
			}
			if (entries.length > 0) {
				this._activeSessionId = entries[0].id;
			}
		} catch { /* ignore corrupt data */ }
	}

	// ─── Change Tracking & Review ────────────────────────────────────────────

	getChangeTracker(): IPowerModeChangeTracker {
		return this._changeTracker;
	}

	getLatestChanges(): IChangeGroup | null {
		return this._changeTracker.getLatestChangeGroup();
	}
}

registerSingleton(IPowerModeService, PowerModeService, InstantiationType.Eager);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a short human-readable preview of a tool call for the approval prompt */
function _buildToolPreview(toolName: string, input: Record<string, any>): string {
	switch (toolName) {
		case 'bash':
			return String(input.command ?? '').substring(0, 200);
		case 'write':
			return `${input.filePath ?? ''}  (${String(input.content ?? '').split('\n').length} lines)`;
		case 'edit':
			return `${input.filePath ?? ''}`;
		case 'spawn_agent': {
			const role = input.role ?? 'unknown';
			const goal = String(input.goal ?? '').substring(0, 100);
			const hasWriteAccess = role === 'editor' || role === 'verifier';
			const accessLabel = hasWriteAccess ? ' [⚠️ WRITE ACCESS]' : ' [read-only]';
			return `${role}${accessLabel}: ${goal}`;
		}
		default:
			return JSON.stringify(input).substring(0, 200);
	}
}
