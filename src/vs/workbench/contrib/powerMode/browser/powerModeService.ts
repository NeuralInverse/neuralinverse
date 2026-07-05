/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ILLMMessageService } from '../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService, ModelOption } from '../../void/common/voidSettingsService.js';
import { ModelSelection } from '../../void/common/voidSettingsTypes.js';
import { IExternalCommandExecutor } from '../../void/browser/externalCommandExecutor.js';
import { buildModernisationPowerTools } from './tools/modernisationTools.js';
import { buildDiscoveryTools } from './tools/discoveryTools.js';
import { buildContextPowerTools } from '../../neuralInverse/browser/context/tools/adapters/powerModeAdapter.js';
import { IContextPackerService } from '../../neuralInverse/browser/context/packer/index.js';
import { IWorkspaceSymbolIndexService } from '../../neuralInverse/browser/context/index/workspaceSymbolIndex.js';
import { IRelevanceScorerService } from '../../neuralInverse/browser/context/relevance/relevanceScorer.js';
import { IChangeTrackerService } from '../../neuralInverse/browser/context/tracker/changeTracker.js';
import { buildAutonomyPowerTools } from './tools/autonomyPowerTools.js';
import { buildKBPowerTools } from './tools/kbPowerTools.js';
import { IDiscoveryService } from '../../neuralInverseModernisation/browser/engine/discovery/discoveryService.js';
import { IMigrationPlannerService } from '../../neuralInverseModernisation/browser/engine/migrationPlannerService.js';
import { IModernisationSessionService } from '../../neuralInverseModernisation/browser/modernisationSessionService.js';
import { IModernisationAgentToolService } from '../../neuralInverseModernisation/browser/engine/agentTools/service.js';
import { IAutonomyService } from '../../neuralInverseModernisation/browser/engine/autonomy/service.js';
import { INeuralInverseSubAgentService } from '../../void/browser/neuralInverseSubAgentService.js';
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
	createSleepTool,
	createNotifyUserTool,
	createTodoWriteTool,
	createTodoReadTool,
	createEnterWorktreeTool,
	createExitWorktreeTool,
} from './tools/advancedTools.js';
import {
	createWebSearchTool,
	createEnhancedWebFetchTool,
} from './tools/webTools.js';
import {
	createSpawnAgentTool,
	createGetAgentStatusTool,
	createWaitForAgentTool,
	createListAgentsTool,
} from './tools/subAgentTools.js';
import {
	createEnterPlanModeTool,
	createExitPlanModeTool,
} from './tools/planModeTools.js';
import { createNotebookEditTool } from './tools/notebookEditTool.js';
import { createLSPTool } from './tools/lspTool.js';
import { AgentRegistry } from './agentRegistry.js';
import type { SubAgentSpawnRequest } from '../../void/common/subAgentTypes.js';
import { createForkAgentTool, createSendMessageTool } from './tools/subAgentTools.js';
import { IPowerBusService } from './powerBusService.js';
import type { IRegisteredAgent, IAgentBusMessage } from '../common/powerBusTypes.js';
import { PowerModeChangeTracker, IPowerModeChangeTracker, IChangeGroup } from './powerModeChangeTracker.js';
import { CompactionService } from './session/compaction/compactionService.js';
import { ISummarizationLLM } from './session/compaction/conversationSummarizer.js';
import { IShadowValidationService } from '../../void/browser/shadowValidationService.js';

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
	 * Run a full agent loop for a sub-agent spawned from neuralInverseSubAgentService.
	 * Uses runAgentLoop with role-scoped tools, own message history, and agent memory.
	 * Returns the agent's final text output.
	 */
	runSubAgentLoop(agentId: string, request: import('../../void/common/subAgentTypes.js').SubAgentSpawnRequest, systemPromptPrefix: string, abort: AbortSignal): Promise<string>;

	/**
	 * Fork the current active session — child inherits parent's conversation context.
	 * Returns the new agent's ID.
	 */
	forkAgent(directive: string, name: string | undefined, parentMessages: IPowerMessage[]): string;

	/** Access the in-process agent registry (for send_message routing). */
	getAgentRegistry(): import('./agentRegistry.js').AgentRegistry;

	/** Get messages of the currently active session (for fork_agent context inheritance). */
	getActiveSessionMessages(): IPowerMessage[];

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

	/** Session compaction service */
	private readonly _compactionService: CompactionService;

	/** Tool registries per working directory */
	private readonly _toolRegistries = new Map<string, PowerToolRegistry>();

	/** In-process agent registry for fork/sub-agent routing via send_message */
	private readonly _agentRegistry = new AgentRegistry();

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
		@IDiscoveryService private readonly discoveryService: IDiscoveryService,
		@IMigrationPlannerService private readonly migrationPlannerService: IMigrationPlannerService,
		@IModernisationSessionService private readonly modernisationSessionService: IModernisationSessionService,
		@IModernisationAgentToolService private readonly agentToolService: IModernisationAgentToolService,
		@IAutonomyService private readonly autonomyService: IAutonomyService,
		@IContextPackerService private readonly contextPackerService: IContextPackerService,
		@IWorkspaceSymbolIndexService private readonly symbolIndexService: IWorkspaceSymbolIndexService,
		@IRelevanceScorerService private readonly relevanceScorerService: IRelevanceScorerService,
		@IChangeTrackerService private readonly changeTrackerService: IChangeTrackerService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IShadowValidationService private readonly shadowValidationService: IShadowValidationService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
	) {
		super();
		this._llmBridge = new PowerModeLLMBridge(llmMessageService, voidSettingsService);
		this._contextBuilder = new PowerModeContextBuilder(fileService);
		this._changeTracker = this._register(new PowerModeChangeTracker(fileService));
		this._compactionService = this._register(new CompactionService());

		// ── PowerBus: register Power Mode as the central agent ──────────
		this.powerBusService.register('power-mode', ['receive:all', 'send:query', 'broadcast'], 'Power Mode');

		// Handle incoming bus messages addressed to power-mode
		this._register(this.powerBusService.onMessage(msg => {
			if (msg.to !== 'power-mode' && msg.to !== '*') { return; }

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
		if (directory) { this._contextBuilder.build(directory).catch(() => { /* ignore */ }); }
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
				createBrowserBashTool(directory, this.commandExecutor, () => this.getModelInfo()),
				createBrowserReadTool(directory, this.fileService),
				createBrowserWriteTool(directory, this.fileService, this._changeTracker, this.shadowValidationService),
				createBrowserEditTool(directory, this.fileService, this._changeTracker, this.shadowValidationService),
				createBrowserListTool(directory, this.fileService),
				createBrowserGlobTool(directory, this.searchService),
				createBrowserGrepTool(directory, this.searchService),
				// Standalone discovery tools (key findings on any codebase)
				...buildDiscoveryTools(this.discoveryService),
				// Modernisation tools (migration workflow context)
				...buildModernisationPowerTools(this.discoveryService, this.migrationPlannerService, this.modernisationSessionService),
				// 67 KB tools (unit read/write, decisions, glossary, phases, compliance, etc.)
				...buildKBPowerTools(this.agentToolService),
				// Autonomy pipeline tools (batch control + single-unit + escalations)
				...buildAutonomyPowerTools(this.autonomyService),
				// Context Engine tools (symbol search, relevance, import graph, edit tracking)
				...buildContextPowerTools(
					{
						contextPacker: this.contextPackerService,
						symbolIndex: this.symbolIndexService,
						relevanceScorer: this.relevanceScorerService,
						changeTracker: this.changeTrackerService,
					},
					URI.file(directory).toString(),
				),
				// High-priority workflow tools
				createAskUserTool((question, sessionId) => this._askUser(question, sessionId)),
				createWebFetchTool(),
				// Web tools
				createWebSearchTool(),
				createEnhancedWebFetchTool(),
				// Workflow task management (renamed to avoid confusion with 'list')
				createTaskCreateTool(),   // tasks_create
				createTaskListTool(),     // tasks_list
				createTaskUpdateTool(),   // tasks_update
				createTaskGetTool(),      // tasks_get
				// Git tools
				createGitStatusTool(directory, this.commandExecutor),
				createGitDiffTool(directory, this.commandExecutor),
				createGitCommitTool(directory, this.commandExecutor, () => this.getModelInfo()),
				// Memory tools
				createMemoryWriteTool(directory, this.fileService),
				createMemoryReadTool(directory, this.fileService),
				// Test execution
				createRunTestsTool(directory, this.commandExecutor, this.fileService),
				// Plan mode transition tools
				createEnterPlanModeTool(),
				createExitPlanModeTool(),
				// Session utilities
				createSleepTool(),
				createNotifyUserTool((message, sessionId) => this._notifyUser(message, sessionId)),
				createTodoWriteTool(),
				createTodoReadTool(),
				// Worktree isolation
				createEnterWorktreeTool(directory, this.commandExecutor),
				createExitWorktreeTool(directory, this.commandExecutor),
				// Notebook editing (.ipynb Jupyter files)
				createNotebookEditTool(directory, this.fileService),
				// LSP: go to definition, find references, hover, document symbols
				createLSPTool(this.modelService, this.languageFeaturesService, this.fileService),
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

			// Fork and inter-agent messaging tools
			registry.register(createForkAgentTool(this));
			registry.register(createSendMessageTool(this));

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
			lines.push('Source (legacy) projects -- use these ABSOLUTE paths:');
			for (const s of session.sources) { lines.push(`  ${s.label}: ${s.folderUri}`); }
		}
		if (session.targets.length > 0) {
			lines.push('Target (modern) projects -- use these ABSOLUTE paths:');
			for (const t of session.targets) { lines.push(`  ${t.label}: ${t.folderUri}`); }
		}
		if (session.activeSourceFileUri) { lines.push(`Active source file: ${session.activeSourceFileUri}`); }
		if (session.activeTargetFileUri) { lines.push(`Active target file: ${session.activeTargetFileUri}`); }
		lines.push('Always use the absolute folder paths above -- do NOT treat project labels as relative directory names.');
		return lines.join('\n');
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

			// Build system prompt with workspace context + modernisation session
			const systemPrompt = buildSystemPrompt({
				workingDirectory: session.directory,
				agentId: agent.id,
				agentPrompt: agent.systemPrompt,
				isGitRepo: wsCtx.isGitRepo,
				customInstructions: wsCtx.customInstructions || undefined,
				modernisationContext: this._buildModernisationContext(),
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

			// Run the agent loop with compaction support
			const result = await runAgentLoop({
				agent,
				assistantMessage: assistantMsg,
				sessionMessages: session.messages,
				toolRegistry: this._getToolRegistry(session.directory),
				callbacks,
				abort: abortController.signal,
				workingDirectory: session.directory,
				systemPrompt,
				compactionService: this._compactionService,
				summarizationLLM: this._buildSummarizationLLM(),
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

	private _notifyUser(message: string, sessionId: string): void {
		this._onDidEmitUIEvent.fire({
			type: 'user-notification',
			sessionId,
			message,
		} as any);
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

	private _buildSummarizationLLM(): ISummarizationLLM | undefined {
		const modelSelection = this.getModelSelection();
		if (!modelSelection) { return undefined; }

		const llmBridge = this._llmBridge;
		return {
			summarize: (prompt: string, maxOutputTokens: number): Promise<string> => {
				return new Promise((resolve, reject) => {
					const request = {
						systemPrompt: 'You are a conversation summarizer. Produce structured summaries in the XML format requested.',
						messages: [{ role: 'user' as const, content: prompt }],
						tools: {},
					};
					llmBridge.sendToLLM(request, modelSelection).then(async response => {
						let text = '';
						for await (const event of response.stream) {
							if (event.type === 'text-delta') { text += event.text; }
							else if (event.type === 'text-done') { text = event.text; }
							else if (event.type === 'error') { reject(event.error); return; }
						}
						resolve(text);
					}).catch(reject);
				});
			},
		};
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

		const wsCtx = { isGitRepo: true };
		const systemPrompt = buildSystemPrompt({
			workingDirectory: directory,
			agentId: 'build',
			isGitRepo: wsCtx.isGitRepo,
			modernisationContext: this._buildModernisationContext(),
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

	// ─── Agent Registry & Sub-Agent Execution ────────────────────────────────

	getAgentRegistry(): AgentRegistry {
		return this._agentRegistry;
	}

	getActiveSessionMessages(): IPowerMessage[] {
		const session = this.activeSession;
		return session ? [...session.messages] : [];
	}

	async runSubAgentLoop(
		agentId: string,
		request: SubAgentSpawnRequest,
		systemPromptPrefix: string,
		abort: AbortSignal,
	): Promise<string> {
		const workspace = this.workspaceContext.getWorkspace();
		const directory = workspace.folders[0]?.uri.fsPath ?? '/';

		// Role-scoped tool permissions
		const toolPermissions = this._buildRolePermissions(request.role);

		const powerAgent: IPowerAgent = {
			id: `sub-${agentId.substring(0, 8)}`,
			name: `Sub-agent [${request.role}]`,
			description: request.goal,
			mode: 'primary',
			maxSteps: 50,
			permissions: { tools: toolPermissions },
		};

		// Load per-role agent memory — three scopes (reference: agentMemory.ts)
		// - user scope:    ~/.claude/agent-memory/<role>/MEMORY.md   (cross-project learnings)
		// - project scope: <cwd>/.claude/agent-memory/<role>/MEMORY.md  (project-specific, VCS)
		// - local scope:   <cwd>/.claude/agent-memory-local/<role>/MEMORY.md  (machine-local, not VCS)
		// Path sanitization: replace colons with dashes (invalid on Windows, used in plugin-namespaced roles)
		const sanitizedRole = request.role.replace(/:/g, '-');
		const homeDir = (typeof process !== 'undefined' && process.env?.HOME) ? process.env.HOME : '';
		const memoryBlocks: string[] = [];
		const memoryScopes: Array<{ path: string; scope: 'user' | 'project' | 'local' }> = [
			...(homeDir ? [{ path: `${homeDir}/.claude/agent-memory/${sanitizedRole}/MEMORY.md`, scope: 'user' as const }] : []),
			{ path: `${directory}/.claude/agent-memory/${sanitizedRole}/MEMORY.md`, scope: 'project' as const },
			{ path: `${directory}/.claude/agent-memory-local/${sanitizedRole}/MEMORY.md`, scope: 'local' as const },
		];
		const scopeNotes: Record<'user' | 'project' | 'local', string> = {
			user: 'Since this memory is user-scope, keep learnings general since they apply across all projects.',
			project: 'Since this memory is project-scope and shared with your team via version control, tailor your memories to this project.',
			local: 'Since this memory is local-scope (not checked into version control), tailor your memories to this project and machine.',
		};
		// Ensure memory directories exist (fire-and-forget — agent won't write until after first LLM round)
		for (const { path, scope } of memoryScopes) {
			if (scope === 'user' && !homeDir) { continue; }
			const dirUri = URI.file(path.replace(/\/MEMORY\.md$/, ''));
			void this.fileService.createFolder(dirUri).catch(() => { /* already exists or non-fatal */ });
		}
		for (const { path, scope } of memoryScopes) {
			try {
				const memFile = await this.fileService.readFile(URI.file(path));
				const memContent = memFile.value.toString().trim();
				if (memContent) {
					memoryBlocks.push(`<agent_memory scope="${scope}">\n${scopeNotes[scope]}\n\n${memContent}\n</agent_memory>`);
				}
			} catch {
				// No memory file at this scope — normal for first run
			}
		}
		const memoryBlock = memoryBlocks.length > 0 ? '\n\n' + memoryBlocks.join('\n\n') : '';

		const systemPrompt = buildSystemPrompt({
			workingDirectory: directory,
			agentId: 'build',
			isGitRepo: true,
			agentPrompt: systemPromptPrefix + memoryBlock,
		});

		let idCounter = 0;
		const nextId = () => `sa_${Date.now()}_${++idCounter}`;
		const sessionId = `sub-${agentId}`;

		const userMsg: IPowerMessage = {
			id: nextId(), sessionId, role: 'user', createdAt: Date.now(),
			parts: [{ type: 'text', id: nextId(), text: request.goal }],
		};
		const assistantMsg: IPowerMessage = {
			id: nextId(), sessionId, role: 'assistant', createdAt: Date.now(), parts: [],
		};

		// Register in the agent registry for send_message routing
		const registryEntry = this._agentRegistry.get(agentId);
		if (registryEntry) {
			registryEntry.conversationHistory = [userMsg, assistantMsg];
		}

		// Transcript path: .claude/agents/<agentId>/transcript.jsonl (reference: sessionStorage.ts)
		const transcriptPath = URI.file(`${directory}/.claude/agents/${agentId}/transcript.jsonl`);
		const appendToTranscript = async (msg: IPowerMessage) => {
			try {
				let existing = '';
				try { existing = (await this.fileService.readFile(transcriptPath)).value.toString(); } catch { /* first write */ }
				const appended = existing + JSON.stringify(msg) + '\n';
				await this.fileService.writeFile(transcriptPath, VSBuffer.fromString(appended));
			} catch { /* non-fatal -- resume is best-effort */ }
		};

		const callbacks: IProcessorCallbacks = {
			onPartCreated: (part) => {
				if (part.type === 'step-finish') {
					void appendToTranscript(assistantMsg);
				}
			},
			onPartUpdated: () => { },
			onTextDelta: () => { },
			sendToLLM: (req) => this._llmBridge.sendToLLM(req, this.getModelSelection()),
			askPermission: async () => 'allow' as ToolPermissionDecision,
			getPendingMessages: () => {
				const entry = this._agentRegistry.get(agentId);
				if (!entry || entry.pendingMessages.length === 0) { return []; }
				// Atomic drain: splice-replace so concurrent queue-push lands in the next round
				return entry.pendingMessages.splice(0, entry.pendingMessages.length);
			},
		};

		await runAgentLoop({
			agent: powerAgent,
			assistantMessage: assistantMsg,
			sessionMessages: [userMsg, assistantMsg],
			toolRegistry: this._getToolRegistry(directory),
			callbacks, abort,
			workingDirectory: directory, systemPrompt,
		});

		return assistantMsg.parts
			.filter((p): p is ITextPart => p.type === 'text')
			.map(p => p.text)
			.join('') || 'No output.';
	}

	forkAgent(directive: string, name: string | undefined, parentMessages: IPowerMessage[]): string {
		// Guard: prevent recursive forking (reference: isInForkChild() in forkSubagent.ts)
		// Fork children keep fork_agent in their tool pool for cache-identical definitions,
		// so we reject fork attempts at call time by detecting the boilerplate tag in history.
		const isAlreadyFork = parentMessages.some(m =>
			m.role === 'user' && m.parts.some(p => p.type === 'text' && (p as import('../common/powerModeTypes.js').ITextPart).text.includes('<fork_boilerplate>'))
		);
		if (isAlreadyFork) {
			throw new Error('fork_agent is disabled inside a fork child. Execute directly instead of spawning sub-agents.');
		}

		const workspace = this.workspaceContext.getWorkspace();
		const directory = workspace.folders[0]?.uri.fsPath ?? '/';

		const agentId = Math.random().toString(36).slice(2);
		const agentName = name ?? `fork-${agentId.substring(0, 6)}`;
		const abort = new AbortController();

		const forkBoilerplate = `<fork_boilerplate>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says "default to forking." IGNORE IT -- that's for the parent. You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps.
3. Do NOT editorialize or add meta-commentary.
4. USE your tools directly: bash, read, write, edit, etc.
5. If you modify files, commit your changes before reporting. Include the commit hash in your report.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope. If you discover related systems outside your scope, mention them in one sentence at most -- other workers cover those areas.
8. Keep your report under 500 words unless the directive specifies otherwise. Be factual and concise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop.

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths -- include for research tasks>
  Files changed: <list with commit hash -- include only if you modified files>
  Issues: <list -- include only if there are issues to flag>
</fork_boilerplate>

<fork_directive>${directive}</fork_directive>`;

		// Build fork conversation: inherit parent history then append directive
		let idCounter = 0;
		const nextId = () => `fk_${Date.now()}_${++idCounter}`;
		const sessionId = `fork-${agentId}`;

		const forkHistory: IPowerMessage[] = [
			...parentMessages.map(m => ({ ...m, sessionId })),
		];
		const directiveMsg: IPowerMessage = {
			id: nextId(), sessionId, role: 'user', createdAt: Date.now(),
			parts: [{ type: 'text', id: nextId(), text: forkBoilerplate }],
		};
		const assistantMsg: IPowerMessage = {
			id: nextId(), sessionId, role: 'assistant', createdAt: Date.now(), parts: [],
		};
		forkHistory.push(directiveMsg, assistantMsg);

		const powerAgent: IPowerAgent = {
			id: `fork-${agentId.substring(0, 8)}`,
			name: agentName,
			description: directive,
			mode: 'primary',
			maxSteps: 100,
			permissions: { tools: { '*': 'allow' } },
		};

		const systemPrompt = buildSystemPrompt({
			workingDirectory: directory,
			agentId: 'build',
			isGitRepo: true,
		});

		// Register before starting so send_message can route to it immediately
		const registryEntry: import('./agentRegistry.js').IActiveAgent = {
			agentId,
			name: agentName,
			role: 'fork',
			goal: directive,
			status: 'running',
			abort,
			pendingMessages: [],
			startedAt: Date.now(),
			conversationHistory: forkHistory,
		};
		this._agentRegistry.register(registryEntry);

		const callbacks: IProcessorCallbacks = {
			onPartCreated: () => { },
			onPartUpdated: () => { },
			onTextDelta: () => { },
			sendToLLM: (req) => this._llmBridge.sendToLLM(req, this.getModelSelection()),
			askPermission: async () => 'allow' as ToolPermissionDecision,
			getPendingMessages: () => {
				const entry = this._agentRegistry.get(agentId);
				if (!entry || entry.pendingMessages.length === 0) { return []; }
				// Atomic drain: splice-replace so concurrent queue-push lands in the next round
				return entry.pendingMessages.splice(0, entry.pendingMessages.length);
			},
		};

		// Transcript path: .claude/agents/<agentId>/transcript.jsonl  (reference: sessionStorage.ts)
		const forkTranscriptPath = URI.file(`${directory}/.claude/agents/${agentId}/transcript.jsonl`);
		const appendForkTranscript = async (msg: IPowerMessage) => {
			try {
				let existing = '';
				try { existing = (await this.fileService.readFile(forkTranscriptPath)).value.toString(); } catch { /* first write */ }
				await this.fileService.writeFile(forkTranscriptPath, VSBuffer.fromString(existing + JSON.stringify(msg) + '\n'));
			} catch { /* non-fatal */ }
		};

		// Also write metadata file so resumeAgent can reconstruct agent type
		const forkMetaPath = URI.file(`${directory}/.claude/agents/${agentId}/metadata.json`);
		void this.fileService.writeFile(forkMetaPath, VSBuffer.fromString(JSON.stringify({
			agentType: 'fork',
			description: directive.substring(0, 100),
			name: agentName,
		}))).catch(() => { /* non-fatal */ });

		// Fire-and-forget — result stored in registry
		runAgentLoop({
			agent: powerAgent,
			assistantMessage: assistantMsg,
			sessionMessages: forkHistory,
			toolRegistry: this._getToolRegistry(directory),
			callbacks: {
				...callbacks,
				onPartCreated: (part) => {
					if (part.type === 'step-finish') {
						void appendForkTranscript(assistantMsg);
					}
				},
			},
			abort: abort.signal,
			workingDirectory: directory, systemPrompt,
		}).then(() => {
			const result = assistantMsg.parts
				.filter((p): p is ITextPart => p.type === 'text')
				.map(p => p.text)
				.join('') || 'No output.';
			const entry = this._agentRegistry.get(agentId);
			if (entry && entry.status === 'running') {
				entry.status = 'completed';
				entry.result = result;
				entry.completedAt = Date.now();
			}
		}).catch(err => {
			const entry = this._agentRegistry.get(agentId);
			if (entry && entry.status === 'running') {
				entry.status = 'failed';
				entry.error = String(err?.message ?? err);
				entry.completedAt = Date.now();
			}
		});

		return agentId;
	}

	private _buildRolePermissions(role: string): Record<string, 'allow' | 'deny' | 'ask'> {
		switch (role) {
			case 'explorer':
			case 'reviewer':
			case 'architect':
				return { read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', web_fetch: 'allow', web_search: 'allow', memory_write: 'allow', memory_read: 'allow', lsp: 'allow', '*': 'deny' };
			case 'editor':
			case 'debugger':
			case 'tester':
			case 'documenter':
				return { read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', write: 'allow', edit: 'allow', bash: 'allow', memory_write: 'allow', memory_read: 'allow', '*': 'deny' };
			case 'verifier':
				return { read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', bash: 'allow', run_tests: 'allow', memory_write: 'allow', memory_read: 'allow', '*': 'deny' };
			case 'power-mode':
			default:
				return { '*': 'allow' };
		}
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
