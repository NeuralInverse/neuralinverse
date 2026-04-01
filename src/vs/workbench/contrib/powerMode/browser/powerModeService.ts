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
	ISkillInfo,
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
	createTaskDeleteTool,
	createGitStatusTool,
	createGitDiffTool,
	createGitCommitTool,
	createGitLogTool,
	createGitAddTool,
	createGitBranchTool,
	createGitStashTool,
	createGitPushTool,
	createGitPullTool,
	createMemoryWriteTool,
	createMemoryReadTool,
	createMemoryListTool,
	createMemoryDeleteTool,
	createMemorySearchTool,
	createRunTestsTool,
	globalTaskStore,
	type ITask,
} from './tools/advancedTools.js';
import {
	PowerCronScheduler,
	IWorktreeInfo,
	createNotebookEditTool,
	createWebSearchTool,
	createMultiEditTool,
	createEnterPlanModeTool,
	createExitPlanModeTool,
	createEnterWorktreeTool,
	createExitWorktreeTool,
	createCronCreateTool,
	createCronListTool,
	createCronDeleteTool,
	createSendMessageTool,
} from './tools/claudeCodeTools.js';
import {
	createSpawnAgentTool,
	createGetAgentStatusTool,
	createWaitForAgentTool,
	createListAgentsTool,
} from './tools/subAgentTools.js';
import { IPowerBusService } from './powerBusService.js';
import type { IRegisteredAgent, IAgentBusMessage } from '../common/powerBusTypes.js';
import { PowerModeChangeTracker, IPowerModeChangeTracker, IChangeGroup } from './powerModeChangeTracker.js';
import { INeuralInverseCCService } from '../../neuralInverseCC/browser/neuralInverseCCService.js';
import type { PermissionRule } from '../../neuralInverseCC/common/neuralInverseCCTypes.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { buildLSPTools, createSleepTool, createTodoWriteTool, createTodoReadTool } from './tools/lspTools.js';

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
	 * Like answerQuery() but with a custom system prompt and optional model hint.
	 * Used by CC-backed sub-agent roles (cc:explore, cc:plan, cc:general, cc:verify)
	 * so each role gets the appropriate CC system prompt and model.
	 * @param question - The question / task description
	 * @param opts.systemPrompt - Override system prompt (CC agent system prompts)
	 * @param opts.allowWrite - If true, enables write/edit/bash access (cc:verify)
	 * @param opts.modelHint - 'haiku' for fast read-only agents; 'inherit' for default
	 * @param opts.maxSteps - Override default step limit
	 */
	answerQueryWithAgent(question: string, opts: {
		systemPrompt: string;
		allowWrite?: boolean;
		modelHint?: 'haiku' | 'inherit';
		maxSteps?: number;
	}): Promise<string>;

	/**
	 * Get the change tracker (for review/rollback UI)
	 */
	getChangeTracker(): IPowerModeChangeTracker;

	/**
	 * Get latest change group (for "press /review" prompt)
	 */
	getLatestChanges(): IChangeGroup | null;

	/**
	 * Get all tasks from the in-memory task store (for /tasks TUI view)
	 */
	getTasks(): import('./tools/advancedTools.js').ITask[];

	/**
	 * List memory file keys from the .powermode-memory directory (for /memory TUI view)
	 */
	listMemoryFiles(): Promise<string[]>;

	/**
	 * Replace all session messages with a single compact summary message.
	 * Called after /compact finishes streaming the summary.
	 */
	compactSession(sessionId: string, summary: string): void;

	/**
	 * Manually trigger context compaction for a session.
	 * Uses the LLM to summarise the conversation, then replaces messages.
	 * Returns 'done' | 'skipped' (nothing to compact) | 'error'.
	 */
	triggerCompact(sessionId: string): Promise<'done' | 'skipped' | 'error'>;

	// ─── CC Skills ───────────────────────────────────────────────────

	/** Get all registered CC bundled skills (for typeahead / webview) */
	getSkillsList(): ISkillInfo[];

	/**
	 * Invoke a CC skill by name and inject its prompt text as the next user message.
	 * Returns false if the skill is not found.
	 */
	invokeSkill(sessionId: string, skillName: string, args: string): Promise<boolean>;

	// ─── CC Utilities ────────────────────────────────────────────────────────

	/** Formatted session cost string from CC token tracker (e.g. "$0.0042  1,234 tokens"). */
	getFormattedSessionCost(sessionId: string): string;

	/** Context window size and auto-compact threshold for the current model. */
	getContextWindowInfo(): { threshold: number; contextWindow: number } | undefined;

	/** Estimate token count for a string (~4 chars/token for text, 2 for JSON). */
	estimateTokens(text: string): number;

	/** All permission rules stored for a session. */
	getPermissionRules(sessionId: string): PermissionRule[];

	/** Set the permission mode for a session (default / accept-edits / dont-ask / bypass). */
	setPermissionMode(sessionId: string, mode: import('../common/powerModeTypes.js').PowerPermissionMode): void;

	/** Get the current permission mode for a session. */
	getPermissionMode(sessionId: string): import('../common/powerModeTypes.js').PowerPermissionMode;

	// ─── Sub-Agents ──────────────────────────────────────────────────────────

	/** Spawn a sub-agent with the given role and goal. Returns null if sub-agent service unavailable or limit reached. */
	spawnSubAgent(role: string, goal: string, scopedFiles?: string[]): import('../../void/common/subAgentTypes.js').SubAgentTask | null;

	/** Get all sub-agents (all statuses) for the current parent session. */
	getSubAgents(): import('../../void/common/subAgentTypes.js').SubAgentTask[];

	/** Cancel a specific sub-agent by ID. */
	cancelSubAgent(subAgentId: string): void;

	/** Cancel all running sub-agents. */
	cancelAllSubAgents(): void;
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

	/** Pending tool permission requests: requestId → { resolver, toolName, sessionId, bashCmd } */
	private readonly _pendingApprovals = new Map<string, {
		resolve: (decision: ToolPermissionDecision) => void;
		sessionId: string;
		toolName: string;
		bashCmd?: string;
	}>();

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
				// spawn_agent: safe read-only roles auto-allowed; write-capable roles still 'ask'
			// The tool itself enforces the distinction via _safeSpawnRoles check.
			tools: { '*': 'allow', bash: 'allow', write: 'allow', edit: 'allow', spawn_agent: 'allow' },
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

	/** Git context captured once at session start — keyed by session directory */
	private readonly _cachedGitContext = new Map<string, string>();
	/** CLAUDE.md content captured once at session start — keyed by session directory */
	private readonly _cachedClaudeMd = new Map<string, string>();

	/** Cron scheduler for timed prompts */
	private _cronScheduler!: PowerCronScheduler;

	/** CC service — auto-compact, cost tracking, shell danger detection */
	private readonly _ccService: INeuralInverseCCService;

	/** Per-session worktree state (session directory override) */
	private readonly _sessionWorktrees = new Map<string, IWorktreeInfo>();

	/** Sessions that have already had a context-handoff compact scheduled — prevents double-firing */
	private readonly _handoffInjected = new Set<string>();

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

	/** Per-session todo lists for todo_write/todo_read */
	private readonly _sessionTodos = new Map<string, string[]>();

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
		@INeuralInverseCCService ccService: INeuralInverseCCService,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@ITextModelService private readonly textModelService: ITextModelService,
	) {
		super();
		this._llmBridge = new PowerModeLLMBridge(llmMessageService, voidSettingsService);
		this._contextBuilder = new PowerModeContextBuilder(fileService);
		this._changeTracker = this._register(new PowerModeChangeTracker(fileService));
		this._ccService = ccService;

		// Start cron scheduler — fires prompts into the active session
		this._cronScheduler = new PowerCronScheduler();
		this._cronScheduler.start((job, sessionId) => {
			const session = this._sessions.get(sessionId);
			if (session && session.status === 'idle') {
				this.sendMessage(sessionId, `[Scheduled task] ${job.prompt}`).catch(() => { /* ignore */ });
			}
		});
		this._register({ dispose: () => this._cronScheduler.stop() });

		// ── PowerBus: register Power Mode as the central agent ──────────
		this.powerBusService.register('power-mode', ['receive:all', 'send:query', 'broadcast'], 'Power Mode');

		// ── Sub-agent status → UI events (lazy: wire once sub-agent service resolves) ──
		// We defer until first access to avoid circular DI issues at startup.
		setTimeout(() => {
			const svc = this._getSubAgentService();
			if (!svc) { return; }
			this._register(svc.onDidChangeSubAgent(({ subAgentId, status }) => {
				const agent = svc.subAgents.get(subAgentId);
				if (!agent) { return; }
				this._onDidEmitUIEvent.fire({
					type: 'sub-agent-updated',
					agent: {
						id: agent.id,
						role: agent.role,
						goal: agent.goal,
						status: agent.status,
						createdAt: agent.createdAt,
						completedAt: agent.completedAt,
						result: agent.result,
						error: agent.error,
					},
				});
			}));
		}, 0);

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
					this._pendingApprovals.set(requestId, {
						resolve,
						sessionId: msg.from,
						toolName: msg.toolName ?? '',
					});
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
		this._ccService.clearPermissionSession(sessionId);
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
				// Workflow task management
				createTaskCreateTool(),
				createTaskListTool(),
				createTaskUpdateTool(),
				createTaskGetTool(),
				createTaskDeleteTool(),
				// Git tools
				createGitStatusTool(directory, this.commandExecutor),
				createGitDiffTool(directory, this.commandExecutor),
				createGitCommitTool(directory, this.commandExecutor),
				createGitLogTool(directory, this.commandExecutor),
				createGitAddTool(directory, this.commandExecutor),
				createGitBranchTool(directory, this.commandExecutor),
				createGitStashTool(directory, this.commandExecutor),
				createGitPushTool(directory, this.commandExecutor),
				createGitPullTool(directory, this.commandExecutor),
				// Memory tools
				createMemoryWriteTool(directory, this.fileService),
				createMemoryReadTool(directory, this.fileService),
				createMemoryListTool(directory, this.fileService),
				createMemoryDeleteTool(directory, this.fileService),
				createMemorySearchTool(directory, this.fileService),
				// Test execution
				createRunTestsTool(directory, this.commandExecutor, this.fileService),
				// ── Claude Code parity tools ──────────────────────────────
				// Jupyter notebooks
				createNotebookEditTool(directory, this.fileService, this._changeTracker),
				// Web search
				createWebSearchTool(),
				// Multi-replacement edits
				createMultiEditTool(directory, this.fileService, this._changeTracker),
				// Plan mode (read-only exploration + implementation planning)
				createEnterPlanModeTool((sessionId, enabled) => this._setPlanMode(sessionId, enabled)),
				createExitPlanModeTool((sessionId, enabled) => this._setPlanMode(sessionId, enabled)),
				// Git worktrees (isolated branches per session)
				createEnterWorktreeTool(
					(sessionId) => this._getSessionDirectory(sessionId),
					this.commandExecutor,
					(sessionId, info) => this._setWorktree(sessionId, info),
				),
				createExitWorktreeTool(
					(sessionId) => this._sessionWorktrees.get(sessionId),
					this.commandExecutor,
					(sessionId) => this._clearWorktree(sessionId),
				),
				// Cron scheduling
				createCronCreateTool(this._cronScheduler),
				createCronListTool(this._cronScheduler),
				createCronDeleteTool(this._cronScheduler),
				// PowerBus send_message
				createSendMessageTool(
					(to, content, type) => this.powerBusService.send('power-mode', to, (type ?? 'query') as any, content),
					() => this.powerBusService.getAgents().map(a => a.agentId),
				),
				// ── VS Code-native LSP tools ──────────────────────────────────
				// Direct language service calls — no sub-agent overhead, no extra tokens.
				// go-to-definition, find-references, hover, document symbols, call hierarchy.
				...buildLSPTools(this.languageFeaturesService, this.textModelService),
				// Sleep (for retry loops) + todo_write/todo_read (mid-task progress tracking)
				createSleepTool(),
				createTodoWriteTool(this._sessionTodos),
				createTodoReadTool(this._sessionTodos),
			]);

			// Sub-agent orchestration (lazy-resolved to avoid circular dependency)
			// CRITICAL: Use the same cached service instance for ALL tools
			try {
				const subAgentService = this._getSubAgentService();
				if (subAgentService) {
					const agentTools = [
						createSpawnAgentTool(subAgentService, this),
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

	/**
	 * Capture git context for a working directory.
	 * Cached per-directory — captured once at first message, reused for the session lifetime.
	 */
	private async _getGitContext(workingDir: string): Promise<string> {
		const cached = this._cachedGitContext.get(workingDir);
		if (cached !== undefined) { return cached; }

		try {
			const { exec } = require('child_process') as typeof import('child_process');
			const run = (cmd: string): Promise<string> => new Promise((res, rej) =>
				exec(cmd, { cwd: workingDir }, (e, out) => e ? rej(e) : res(out.trim()))
			);

			const [branch, mainBranch, status, log] = await Promise.allSettled([
				run('git rev-parse --abbrev-ref HEAD'),
				run('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null').then(s => s.replace('refs/remotes/origin/', '')).catch(() =>
					run('git branch -r').then(s => {
						const m = s.match(/origin\/HEAD\s+->\s+origin\/(\S+)/);
						return m ? m[1] : 'main';
					})
				),
				run('git status --short'),
				run('git log --oneline -n 5'),
			]);

			const branchStr = branch.status === 'fulfilled' ? branch.value : 'unknown';
			const mainStr = mainBranch.status === 'fulfilled' ? mainBranch.value : 'main';
			const statusRaw = status.status === 'fulfilled' ? status.value : '';
			const statusStr = statusRaw.length > 2000 ? statusRaw.substring(0, 2000) + '\n...(truncated)' : (statusRaw || '(clean)');
			const logStr = log.status === 'fulfilled' ? log.value : '';

			const result = [
				`Current branch: ${branchStr}`,
				`\nMain branch (you will usually use this for PRs): ${mainStr}`,
				`\nStatus:\n${statusStr}`,
				logStr ? `\nRecent commits:\n${logStr}` : null,
			].filter(Boolean).join('\n');

			this._cachedGitContext.set(workingDir, result);
			return result;
		} catch {
			return '';
		}
	}

	/**
	 * Load CLAUDE.md files from the project hierarchy.
	 * Priority (lowest → highest): managed global → user global → CWD walk upward.
	 * Cached per-directory.
	 */
	private async _loadClaudeMdFiles(workingDir: string): Promise<string> {
		const cached = this._cachedClaudeMd.get(workingDir);
		if (cached !== undefined) { return cached; }

		try {
			const fs = require('fs').promises as typeof import('fs').promises;
			const path = require('path') as typeof import('path');
			const os = require('os') as typeof import('os');

			const readSafe = async (p: string): Promise<string | null> => {
				try {
					const text = await fs.readFile(p, 'utf8');
					return text.length > 40000 ? text.substring(0, 40000) + '\n[truncated]' : text;
				} catch { return null; }
			};

			const sections: { path: string; content: string }[] = [];

			// 1. Managed global
			const managed = await readSafe('/etc/claude-code/CLAUDE.md');
			if (managed) { sections.push({ path: '/etc/claude-code/CLAUDE.md', content: managed }); }

			// 2. User global (~/.claude/CLAUDE.md)
			const userFile = path.join(os.homedir(), '.claude', 'CLAUDE.md');
			const user = await readSafe(userFile);
			if (user) { sections.push({ path: userFile, content: user }); }

			// 3. Walk upward from CWD, collecting root→cwd order
			let dir = workingDir;
			const dirs: string[] = [];
			while (true) {
				dirs.unshift(dir);
				const parent = path.dirname(dir);
				if (parent === dir) { break; }
				dir = parent;
			}

			for (const d of dirs) {
				const candidates = [
					path.join(d, 'CLAUDE.md'),
					path.join(d, '.claude', 'CLAUDE.md'),
					path.join(d, 'CLAUDE.local.md'),
				];
				// Also pick up .claude/rules/*.md
				try {
					const rulesDir = path.join(d, '.claude', 'rules');
					const entries = await fs.readdir(rulesDir);
					for (const e of entries) {
						if (e.endsWith('.md')) { candidates.push(path.join(rulesDir, e)); }
					}
				} catch { /* no rules dir */ }

				for (const p of candidates) {
					const content = await readSafe(p);
					if (content) { sections.push({ path: p, content }); }
				}
			}

			const result = sections.length === 0 ? '' : sections.map(s => `## ${s.path}\n${s.content}`).join('\n\n---\n\n');
			this._cachedClaudeMd.set(workingDir, result);
			return result;
		} catch {
			return '';
		}
	}

	/**
	 * Run the auto-compact flow: summarise the session conversation via LLM,
	 * then replace messages with the compact summary.
	 * Circuit-breaker failures are tracked in INeuralInverseCCService.
	 */
	private async _runAutoCompact(session: IPowerSession): Promise<void> {
		const sessionId = session.id;
		session.status = 'compact';
		this._onDidEmitUIEvent.fire({ type: 'compact-started', sessionId });
		this._onDidChangeSession.fire(session);

		try {
			// ── Checkpoint: persist current task state to memory before compacting ──
			// This lets the agent re-read its own progress after the context resets.
			try {
				const checkpointKey = `compact-checkpoint-${sessionId.substring(0, 8)}`;
				const recentMessages = session.messages.slice(-6)
					.filter(m => m.role === 'user' || m.role === 'assistant')
					.map(m => {
						const text = m.parts.filter((p): p is ITextPart => p.type === 'text').map(p => p.text).join(' ').substring(0, 300);
						return `${m.role === 'user' ? 'USER' : 'ASST'}: ${text}`;
					}).join('\n');
				const checkpointContent = `# Auto-compact checkpoint\nSession: ${sessionId}\nTimestamp: ${new Date().toISOString()}\nMessages before compact: ${session.messages.length}\n\nRecent context:\n${recentMessages}`;
				// Write to memory dir — best effort, non-fatal
				const memDir = `${session.directory}/.powermode-memory`;
				await this.fileService.writeFile(
					URI.file(`${memDir}/${checkpointKey}.md`),
					(await import('../../../../base/common/buffer.js')).VSBuffer.fromString(checkpointContent),
				).catch(() => { /* non-fatal */ });
			} catch { /* non-fatal — never block compact */ }

			// Build a compact prompt from existing messages
			const historyText = session.messages
				.filter(m => m.role === 'user' || m.role === 'assistant')
				.map(m => {
					const text = m.parts
						.filter((p): p is ITextPart => p.type === 'text')
						.map(p => p.text).join('\n');
					return `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${text}`;
				})
				.join('\n\n');

			const compactSystemPrompt =
				'You are a helpful assistant. Produce a concise but complete summary of the following conversation. ' +
				'Preserve: the main task, all decisions made, files modified, current state, and what remains to do. ' +
				'Output the summary only — no preamble.';

			const response = await this._llmBridge.sendToLLM({
				systemPrompt: compactSystemPrompt,
				messages: [{ role: 'user', content: `Conversation to summarise:\n\n${historyText.substring(0, 80_000)}` }],
				tools: {},
			}, this.getModelSelection());

			let summary = '';
			for await (const event of response.stream) {
				if (event.type === 'text-delta') { summary += event.text; }
				if (event.type === 'text-done') { summary = event.text || summary; }
				if (event.type === 'error') { throw event.error; }
			}

			if (!summary.trim()) { throw new Error('Empty summary'); }

			this.compactSession(sessionId, summary);
			this._ccService.recordCompactSuccess(sessionId, {
				summary,
				messageCountBefore: session.messages.length,
				messageCountAfter: 1,
			});
			this._ccService.resetSessionCost(sessionId); // Reset token counter after compact
			this._handoffInjected.delete(sessionId); // Allow handoff to fire again next cycle
		} finally {
			session.status = 'idle';
			this._onDidEmitUIEvent.fire({ type: 'compact-done', sessionId });
			this._onDidChangeSession.fire(session);
		}
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

		// ── Auto-compact pre-flight ──────────────────────────────────────────
		// Check if accumulated token usage from previous turns exceeds threshold.
		// If so, compact the session before adding the new user message.
		const _preflightModel = this.getModelSelection()?.modelName ?? '';
		if (_preflightModel) {
			const prevCost = this._ccService.getSessionCost(sessionId);
			const prevTokens = prevCost.totalInputTokens + prevCost.totalOutputTokens;
			if (this._ccService.shouldAutoCompact(sessionId, prevTokens, _preflightModel)) {
				try {
					await this._runAutoCompact(session);
				} catch {
					// Non-fatal — continue with full history
					this._ccService.recordCompactFailure(sessionId);
				}
			}
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

			// Query Checks Agent for live GRC posture, git context, and CLAUDE.md — all in parallel
			const [grcPosture, gitContext, claudeMdContent] = await Promise.all([
				this._queryGRCPosture(),
				this._getGitContext(session.directory),
				this._loadClaudeMdFiles(session.directory),
			]);

			// Build system prompt with real workspace context + GRC state + modernisation session + firmware session
			const fwCtx = this._buildFirmwareContextAndPrompt();
			const systemPrompt = buildSystemPrompt({
				workingDirectory: session.directory,
				agentId: agent.id,
				agentPrompt: agent.systemPrompt,
				isGitRepo: wsCtx.isGitRepo,
				platform: process.platform,
				shell: process.env['SHELL'] || undefined,
				customInstructions: wsCtx.customInstructions || undefined,
				grcPosture: grcPosture || undefined,
				modernisationContext: this._buildModernisationContext(),
				firmwareContext: fwCtx?.firmwareContext,
				firmwareAgentPrompt: fwCtx?.firmwareAgentPrompt,
				gitContext: gitContext || undefined,
				claudeMdContent: claudeMdContent || undefined,
			});

			// ── Cost tracking helper for this session run ────────────────────
			const modelName = this.getModelSelection()?.modelName ?? '';
			const _recordStepCost = (part: IPowerMessagePart) => {
				if (part.type === 'step-finish' && part.tokens) {
					const costs = this._ccService.getCostsForModel(modelName);
					const stepCostUSD =
						(part.tokens.input / 1_000_000) * costs.inputTokens +
						(part.tokens.output / 1_000_000) * costs.outputTokens +
						((part.tokens.cache?.read ?? 0) / 1_000_000) * costs.promptCacheReadTokens +
						((part.tokens.cache?.write ?? 0) / 1_000_000) * costs.promptCacheWriteTokens;
					(part as any).cost = stepCostUSD;
					this._ccService.recordTokenUsage({
						sessionId,
						model: modelName,
						inputTokens: part.tokens.input,
						outputTokens: part.tokens.output,
					});
					// Token warning + session cost events
					const sessionCost = this._ccService.getSessionCost(sessionId);
					const totalTokens = sessionCost.totalInputTokens + sessionCost.totalOutputTokens;
					const warn = this._ccService.calculateTokenWarningState(totalTokens, modelName);
					if (warn.isAboveWarningThreshold) {
						this._onDidEmitUIEvent.fire({
							type: 'token-warning',
							sessionId,
							percentLeft: warn.percentLeft,
							isAtBlockingLimit: warn.isAtBlockingLimit,
						});
					}
					// Context handoff: at auto-compact threshold, trigger compact automatically
					// once the current agent turn finishes (session goes idle).
					if (warn.isAboveAutoCompactThreshold && !warn.isAtBlockingLimit) {
						const currentSession = this._sessions.get(sessionId);
						if (currentSession && !this._handoffInjected.has(sessionId)) {
							this._handoffInjected.add(sessionId);
							setTimeout(() => {
								const s = this._sessions.get(sessionId);
								if (s && s.status === 'idle') {
									this._runAutoCompact(s).catch(() => {
										this._handoffInjected.delete(sessionId);
									});
								} else {
									this._handoffInjected.delete(sessionId);
								}
							}, 2000);
						}
					}
					// Always emit updated cost to the webview
					this._onDidEmitUIEvent.fire({
						type: 'session-cost',
						cost: {
							sessionId,
							totalCostUSD: sessionCost.totalCostUSD,
							totalInputTokens: sessionCost.totalInputTokens,
							totalOutputTokens: sessionCost.totalOutputTokens,
							turnCount: sessionCost.turnCount,
						},
					});
				}
			};

			// Build callbacks that bridge processor events → UI events
			const callbacks: IProcessorCallbacks = {
				onPartCreated: (part: IPowerMessagePart) => {
					_recordStepCost(part);
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
				askPermission: (toolName: string, input: Record<string, any>, dangerous?: boolean) => {
					const permMode = session.permissionMode ?? 'default';
					// bypass: allow everything without prompts
					if (permMode === 'bypass') {
						return Promise.resolve<ToolPermissionDecision>('allow');
					}
					// dont-ask: silently deny all write/edit/bash requests
					if (permMode === 'dont-ask') {
						return Promise.resolve<ToolPermissionDecision>('deny');
					}
					// accept-edits: auto-allow file edits/writes inside the working directory
					if (permMode === 'accept-edits' && !dangerous) {
						const isFileOp = toolName === 'write' || toolName === 'edit' || toolName === 'multi_edit' || toolName === 'notebook_edit';
						if (isFileOp) {
							const fp = String(input.filePath ?? input.file_path ?? '');
							const workDir = session.worktree?.path ?? session.directory;
							const inWorkdir = !fp || fp.startsWith(workDir);
							if (inWorkdir) { return Promise.resolve<ToolPermissionDecision>('allow'); }
						}
					}
					const requestId = `perm_${++this._approvalCounter}`;
					const preview = _buildToolPreview(toolName, input);
					const bashCmd = toolName === 'bash' ? String(input.command ?? '') : undefined;
					return new Promise<ToolPermissionDecision>((resolve) => {
						this._pendingApprovals.set(requestId, { resolve, sessionId, toolName, bashCmd });
						this._onDidEmitUIEvent.fire({
							type: 'permission-request',
							request: { requestId, sessionId, toolName, preview, danger: dangerous },
						});
					});
				},
				checkCommandDanger: (toolName: string, input: Record<string, any>): boolean => {
					// ── bash: check permission engine + dangerous pattern list ──────
					if (toolName === 'bash') {
						const cmd = String(input.command ?? '');
						const permResult = this._ccService.evaluatePermission(sessionId, 'bash', cmd);
						if (permResult.behavior === 'allow') { return false; }
						return this._ccService.isDangerousBashPattern(cmd);
					}
					// ── write / edit / multi_edit: flag protected file paths ────────
					if (toolName === 'write' || toolName === 'edit' || toolName === 'multi_edit') {
						const fp = String(input.filePath ?? input.file_path ?? '');
						if (fp) { return _isProtectedFilePath(fp); }
					}
					return false;
				},
			};

			// Resolve the effective working directory (worktree path if active)
			const effectiveDirectory = session.worktree?.path ?? session.directory;

			// Run the agent loop
			const result = await runAgentLoop({
				agent,
				assistantMessage: assistantMsg,
				sessionMessages: session.messages,
				toolRegistry: this._getToolRegistry(effectiveDirectory),
				callbacks,
				abort: abortController.signal,
				workingDirectory: effectiveDirectory,
				systemPrompt,
				planMode: session.planMode ?? false,
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

	// ─── Plan Mode ───────────────────────────────────────────────────────────

	private _setPlanMode(sessionId: string, enabled: boolean): void {
		const session = this._sessions.get(sessionId);
		if (!session) { return; }
		session.planMode = enabled;
		session.updatedAt = Date.now();
		this._onDidChangeSession.fire(session);
		this._onDidEmitUIEvent.fire({ type: 'session-updated', sessionId, status: session.status });
	}

	// ─── Worktree ─────────────────────────────────────────────────────────────

	private _getSessionDirectory(sessionId: string): string {
		const session = this._sessions.get(sessionId);
		return session?.worktree?.path ?? session?.directory ?? '/';
	}

	private _setWorktree(sessionId: string, info: IWorktreeInfo): void {
		const session = this._sessions.get(sessionId);
		if (!session) { return; }
		this._sessionWorktrees.set(sessionId, info);
		(session as any).worktree = info;
		session.updatedAt = Date.now();
		this._onDidChangeSession.fire(session);
	}

	private _clearWorktree(sessionId: string): void {
		const session = this._sessions.get(sessionId);
		if (!session) { return; }
		this._sessionWorktrees.delete(sessionId);
		(session as any).worktree = undefined;
		session.updatedAt = Date.now();
		this._onDidChangeSession.fire(session);
	}

	cancel(sessionId: string): void {
		const controller = this._abortControllers.get(sessionId);
		if (controller) {
			controller.abort();
			this._abortControllers.delete(sessionId);
		}
		// Deny any pending permission requests for this session
		for (const [requestId, entry] of this._pendingApprovals) {
			if (requestId.startsWith('perm_')) {
				entry.resolve('deny');
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
		const entry = this._pendingApprovals.get(requestId);
		if (entry) {
			this._pendingApprovals.delete(requestId);
			if (entry.toolName === 'bash' && entry.bashCmd) {
				if (decision === 'allow' || decision === 'allow-all') {
					// allow-all → broader prefix rule via suggestionForPrefix
					// allow     → exact command rule via suggestionForExactCommand
					const suggestions = decision === 'allow-all'
						? this._ccService.suggestionForPrefix('bash', entry.bashCmd)
						: this._ccService.suggestionForExactCommand('bash', entry.bashCmd);
					for (const s of suggestions) {
						if (s.type === 'addRules') {
							for (const r of s.rules) {
								if (r.ruleContent) {
									this._ccService.addPermissionRule(entry.sessionId, {
										toolName: 'bash',
										behavior: 'allow',
										ruleContent: r.ruleContent,
										source: 'session',
									});
								}
							}
						}
					}
					this._ccService.recordPermissionSuccess(entry.sessionId);
				} else {
					// User denied — feed into denial circuit-breaker
					this._ccService.recordPermissionDenial(entry.sessionId);
				}
			}
			entry.resolve(decision);
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
		// Clear permission rules and cost tracking so fresh session has clean state
		this._ccService.clearPermissionSession(sessionId);
		this._ccService.resetSessionCost(sessionId);
		this._onDidChangeSession.fire(session);
		this._persistSessions();
	}

	compactSession(sessionId: string, summary: string): void {
		const session = this._sessions.get(sessionId);
		if (!session) { return; }

		// Replace all messages with a single synthetic assistant context message
		const contextMsg: IPowerMessage = {
			id: `msg_${Date.now()}_${++this._idCounter}`,
			sessionId,
			role: 'assistant',
			createdAt: Date.now(),
			parts: [{
				type: 'text',
				id: `p_${++this._idCounter}`,
				text: `[Compacted context]\n\n${summary}`,
			} as IPowerMessagePart],
		};

		session.messages = [contextMsg];
		(session as any).title = 'Compacted';
		session.updatedAt = Date.now();
		this._contextBuilder.invalidate(session.directory);
		this._onDidChangeSession.fire(session);
		this._persistSessions();
	}

	async triggerCompact(sessionId: string): Promise<'done' | 'skipped' | 'error'> {
		const session = this._sessions.get(sessionId);
		if (!session || session.messages.length === 0) { return 'skipped'; }
		if (session.status === 'busy' || session.status === 'compact') { return 'skipped'; }
		try {
			await this._runAutoCompact(session);
			return 'done';
		} catch {
			return 'error';
		}
	}

	// ─── Bus ─────────────────────────────────────────────────────────────

	getAgentsOnBus(): IRegisteredAgent[] {
		return this.powerBusService.getAgents();
	}

	getBusHistory(limit = 20): IAgentBusMessage[] {
		return this.powerBusService.getHistory(limit);
	}

	// ─── Sub-Agents ──────────────────────────────────────────────────────────

	spawnSubAgent(role: string, goal: string, scopedFiles?: string[]): import('../../void/common/subAgentTypes.js').SubAgentTask | null {
		const svc = this._getSubAgentService();
		if (!svc) { return null; }
		return svc.spawn({ role: role as any, goal, scopedFiles });
	}

	getSubAgents(): import('../../void/common/subAgentTypes.js').SubAgentTask[] {
		const svc = this._getSubAgentService();
		if (!svc) { return []; }
		return Array.from(svc.subAgents.values());
	}

	cancelSubAgent(subAgentId: string): void {
		this._getSubAgentService()?.cancel(subAgentId);
	}

	cancelAllSubAgents(): void {
		this._getSubAgentService()?.cancelAll();
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
			checkCommandDanger: () => false,
		};

		const wsCtx = this._cachedWsCtx ?? { isGitRepo: true };
		const fwCtxQuery = this._buildFirmwareContextAndPrompt();
		const systemPrompt = buildSystemPrompt({
			workingDirectory: directory,
			agentId: 'build',
			isGitRepo: wsCtx.isGitRepo,
			platform: process.platform,
			shell: process.env['SHELL'] || undefined,
			customInstructions: wsCtx.customInstructions || undefined,
			modernisationContext: this._buildModernisationContext(),
			firmwareContext: fwCtxQuery?.firmwareContext,
			firmwareAgentPrompt: fwCtxQuery?.firmwareAgentPrompt,
			gitContext: this._cachedGitContext.get(directory) || undefined,
			claudeMdContent: this._cachedClaudeMd.get(directory) || undefined,
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

	async answerQueryWithAgent(question: string, opts: {
		systemPrompt: string;
		allowWrite?: boolean;
		modelHint?: 'haiku' | 'inherit';
		maxSteps?: number;
	}): Promise<string> {
		const { systemPrompt, allowWrite = false, modelHint, maxSteps } = opts;
		const workspace = this.workspaceContext.getWorkspace();
		const directory = workspace.folders[0]?.uri.fsPath ?? '/';

		const toolPermissions: Record<string, 'allow' | 'deny' | 'ask'> = allowWrite
			? { '*': 'allow', bash: 'allow', write: 'allow', edit: 'allow', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow' }
			: { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow', bash: 'allow' };

		const agent: IPowerAgent = {
			id: 'cc-agent-query',
			name: 'CC Agent Query',
			description: allowWrite ? 'CC agent with write+bash access.' : 'CC agent (read-only + bash).',
			mode: 'primary',
			maxSteps: maxSteps ?? (allowWrite ? 60 : 30),
			permissions: { tools: toolPermissions },
		};

		let _idCounter = 0;
		const nextId = () => `caq_${Date.now()}_${++_idCounter}`;

		const userMsg: IPowerMessage = {
			id: nextId(), sessionId: 'cc-agent-query', role: 'user',
			createdAt: Date.now(),
			parts: [{ type: 'text', id: nextId(), text: question }],
		};
		const assistantMsg: IPowerMessage = {
			id: nextId(), sessionId: 'cc-agent-query', role: 'assistant',
			createdAt: Date.now(), parts: [],
		};

		const abort = new AbortController();
		const timeoutMs = allowWrite ? 240_000 : 90_000;
		const timeoutId = setTimeout(() => abort.abort(), timeoutMs);

		// Resolve model: 'haiku' → pick the fastest available model; 'inherit' or undefined → default
		let modelSelection = this.getModelSelection();
		if (modelHint === 'haiku') {
			// Try to find a haiku/flash/mini model; fall back to current selection
			const models = this.getAvailableModels();
			const haiku = models.find(m =>
				m.selection.modelName.toLowerCase().includes('haiku') ||
				m.selection.modelName.toLowerCase().includes('flash') ||
				m.selection.modelName.toLowerCase().includes('mini')
			);
			if (haiku) {
				modelSelection = haiku.selection;
			}
		}

		const callbacks: IProcessorCallbacks = {
			onPartCreated: () => { /* silent */ },
			onPartUpdated: () => { /* silent */ },
			onTextDelta: () => { /* silent */ },
			sendToLLM: (req) => this._llmBridge.sendToLLM(req, modelSelection),
			askPermission: async () => 'allow' as ToolPermissionDecision,
			checkCommandDanger: () => false,
		};

		try {
			await runAgentLoop({
				agent, assistantMessage: assistantMsg,
				sessionMessages: [userMsg, assistantMsg],
				toolRegistry: this._getToolRegistry(directory),
				callbacks, abort: abort.signal,
				workingDirectory: directory,
				systemPrompt,
			});
		} catch (err) {
			console.error('[PowerMode] answerQueryWithAgent error:', err);
		}

		clearTimeout(timeoutId);

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

	getTasks(): ITask[] {
		return globalTaskStore.list();
	}

	async listMemoryFiles(): Promise<string[]> {
		const dir = this.workspaceContext.getWorkspace().folders[0]?.uri.fsPath;
		if (!dir) { return []; }
		const memoryDir = `${dir}/.powermode-memory`;
		try {
			const resolved = await this.fileService.resolve(URI.file(memoryDir));
			return (resolved.children ?? [])
				.filter(c => !c.isDirectory && c.name.endsWith('.md'))
				.map(c => c.name.replace(/\.md$/, ''))
				.sort();
		} catch {
			return [];
		}
	}

	// ─── CC Skills ───────────────────────────────────────────────────────────────

	getSkillsList(): ISkillInfo[] {
		return this._ccService.getSkills().map(s => ({
			name: s.name,
			description: s.description,
			aliases: s.aliases,
			argumentHint: s.argumentHint,
		}));
	}

	async invokeSkill(sessionId: string, skillName: string, args: string): Promise<boolean> {
		const skill = this._ccService.getSkill(skillName);
		if (!skill) { return false; }

		const session = this._sessions.get(sessionId);
		const directory = session?.directory
			?? this.workspaceContext.getWorkspace().folders[0]?.uri.fsPath
			?? '/';

		try {
			const promptText = await skill.getPromptText(args, {
				workingDirectory: directory,
				agentId: session?.agentId ?? 'build',
				sessionId,
			});
			await this.sendMessage(sessionId, promptText);
			return true;
		} catch (err) {
			console.error('[PowerMode] invokeSkill error:', err);
			return false;
		}
	}

	// ─── CC Utilities ────────────────────────────────────────────────────────

	getFormattedSessionCost(sessionId: string): string {
		return this._ccService.formatSessionCost(sessionId);
	}

	getContextWindowInfo(): { threshold: number; contextWindow: number } | undefined {
		const model = this.getModelSelection()?.modelName;
		if (!model) { return undefined; }
		return {
			threshold: this._ccService.getAutoCompactThreshold(model),
			contextWindow: this._ccService.getContextWindowForModel(model),
		};
	}

	estimateTokens(text: string): number {
		return this._ccService.estimateTokens(text);
	}

	getPermissionRules(sessionId: string): PermissionRule[] {
		return this._ccService.getPermissionRules(sessionId);
	}

	setPermissionMode(sessionId: string, mode: import('../common/powerModeTypes.js').PowerPermissionMode): void {
		const session = this._sessions.get(sessionId);
		if (!session) { return; }
		(session as any).permissionMode = mode;
		this._onDidChangeSession.fire(session);
		this._onDidEmitUIEvent.fire({ type: 'session-updated', sessionId, status: session.status });
	}

	getPermissionMode(sessionId: string): import('../common/powerModeTypes.js').PowerPermissionMode {
		return this._sessions.get(sessionId)?.permissionMode ?? 'default';
	}
}

registerSingleton(IPowerModeService, PowerModeService, InstantiationType.Eager);

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Protected file path detection (mirrors CC's filesystem.ts) ──────────────

const _PROTECTED_FILES = new Set([
	'.gitconfig', '.gitmodules', '.bashrc', '.bash_profile',
	'.zshrc', '.zprofile', '.profile', '.ripgreprc',
	'.mcp.json', '.claude.json',
]);

const _PROTECTED_DIRS = new Set([
	'.git', '.vscode', '.idea', '.claude',
]);

/**
 * Returns true when a file path targets a known dangerous system file
 * or a directory that should not be touched by AI agents without explicit
 * confirmation (e.g. .git, .vscode, shell rc files).
 */
function _isProtectedFilePath(filePath: string): boolean {
	const parts = filePath.replace(/\\/g, '/').split('/');
	const base = parts[parts.length - 1] ?? '';
	if (_PROTECTED_FILES.has(base)) { return true; }
	for (const part of parts) {
		if (_PROTECTED_DIRS.has(part)) { return true; }
	}
	return false;
}

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
