/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Workflow Agent Service
 *
 * The single DI entry point for the multi-agent workflow engine.
 *
 * Responsibilities:
 * - Owns the ToolRegistry (registers all built-in tools on startup)
 * - Owns the WorkflowConfigLoader (reads .inverse/workflows/)
 * - Exposes runWorkflow() / runAgent() / cancelRun()
 * - Maintains active run state and run history
 * - Fires onDidChangeRun for UI subscriptions
 *
 * ## Independence from Void
 *
 * This service does NOT depend on IChatThreadService or the sidebar.
 * It calls ILLMMessageService and IVoidSettingsService directly —
 * the same LLM stack but a completely separate execution path.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILLMMessageService } from '../../void/common/sendLLMMessageService.js';
import { LLMChatMessage } from '../../void/common/sendLLMMessageTypes.js';
import { IVoidSettingsService } from '../../void/common/voidSettingsService.js';
import { ConversationCompactor } from '../../void/browser/conversationCompactor.js';
import { IContextLedgerService } from '../../void/browser/contextLedgerService.js';
import { ILedgerEntry } from '../../void/common/ledgerTypes.js';
import { IAgentStoreService } from './agentStoreService.js';
import { IAgentRun, IWorkflowDefinition, WorkflowTrigger } from '../common/workflowTypes.js';
import { IApprovalRequest, IApprovalResponse } from './orchestrator/approvalGate.js';
import { ToolRegistry } from './tools/toolRegistry.js';
import { ALL_FS_TOOLS } from './tools/fsTools.js';
import { ALL_TERMINAL_TOOLS } from './tools/terminalTools.js';
import { ALL_GIT_TOOLS } from './tools/gitTools.js';
import { ALL_HTTP_TOOLS } from './tools/httpTools.js';
import { createCommunicationTools } from './tools/communicationTools.js';
import { createGRCTools } from './tools/grcTools.js';
import { createWorkflowContextTools } from './context/tools/adapters/workflowAgentAdapter.js';
import { IContextPackerService } from './context/packer/index.js';
import { IWorkspaceSymbolIndexService } from './context/index/workspaceSymbolIndex.js';
import { IRelevanceScorerService } from './context/relevance/relevanceScorer.js';
import { IChangeTrackerService } from './context/tracker/changeTracker.js';
import { IPowerBusService } from '../../powerMode/browser/powerBusService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IAccessibilitySignalService } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IStatusbarService } from '../../../services/statusbar/browser/statusbar.js';
import { IProgressService } from '../../../../platform/progress/common/progress.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { WorkflowConfigLoader } from './workflowConfigLoader.js';
import { WorkflowOrchestrator, buildAgentRun } from './orchestrator/workflowOrchestrator.js';
import { WorkflowTriggerManager } from './workflowTriggerManager.js';
import { ICancellationToken } from './executor/agentExecutor.js';

// ─── Service Interface ────────────────────────────────────────────────────────

export const IWorkflowAgentService = createDecorator<IWorkflowAgentService>('workflowAgentService');

export interface IWorkflowAgentService {
	readonly _serviceBrand: undefined;

	/** Fires whenever a run's state changes — used by the UI panel */
	readonly onDidChangeRun: Event<IAgentRun>;
	/** Fires when the workflow registry is reloaded from disk */
	readonly onDidChangeWorkflows: Event<void>;

	// ─── Workflow registry ──────────────────────────────────────────────────
	getWorkflows(): IWorkflowDefinition[];
	getWorkflow(id: string): IWorkflowDefinition | undefined;
	/** Persist a workflow definition to .inverse/workflows/<id>.json */
	saveWorkflow(def: IWorkflowDefinition): Promise<void>;
	/** Delete a workflow definition file */
	deleteWorkflow(id: string): Promise<void>;
	/** List all archived versions for a workflow */
	listWorkflowVersions(workflowId: string): Promise<Array<{ version: number; savedAt: number; workflowId: string }>>;
	/** Roll back a workflow to a specific archived version */
	rollbackWorkflow(workflowId: string, version: number): Promise<void>;

	// ─── Execution ──────────────────────────────────────────────────────────
	/** Run a full multi-agent workflow by ID */
	runWorkflow(workflowId: string, input: string, trigger?: WorkflowTrigger): Promise<IAgentRun>;
	/** Run a single agent ad-hoc (creates a single-step synthetic workflow) */
	runAgent(agentId: string, input: string): Promise<IAgentRun>;
	/** Cancel an active run */
	cancelRun(runId: string): void;

	// ─── State ──────────────────────────────────────────────────────────────
	getActiveRuns(): IAgentRun[];
	getRunHistory(limit?: number): IAgentRun[];
	getRun(runId: string): IAgentRun | undefined;

	// ─── Approval gates ─────────────────────────────────────────────────────
	/** Fires when a step pauses for human approval */
	readonly onDidRequestApproval: Event<IApprovalRequest>;
	/** Resolve a pending approval request */
	respondToApproval(runId: string, stepId: string, response: IApprovalResponse): void;
}

// ─── Implementation ───────────────────────────────────────────────────────────

const MAX_HISTORY = 50;

export class WorkflowAgentService extends Disposable implements IWorkflowAgentService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeRun = this._register(new Emitter<IAgentRun>());
	readonly onDidChangeRun = this._onDidChangeRun.event;

	private readonly _onDidChangeWorkflows = this._register(new Emitter<void>());
	readonly onDidChangeWorkflows = this._onDidChangeWorkflows.event;

	// Proxied from orchestrator.approvalGate
	get onDidRequestApproval() {
		return this._orchestrator.approvalGate.onDidRequestApproval;
	}

	private readonly _toolRegistry: ToolRegistry;
	private readonly _configLoader: WorkflowConfigLoader;
	private readonly _orchestrator: WorkflowOrchestrator;
	private readonly _triggerManager: WorkflowTriggerManager;

	/** runId → cancellation token for active runs */
	private readonly _activeCancellations = new Map<string, ICancellationToken>();

	/**
	 * agentId → active conversationId for ad-hoc (Agents tab) chat runs
	 * (task M5 phase 5). The pointer survives until clearAgentConversation()
	 * drops it, so memory is keyed per conversation instead of per
	 * agent-lifetime — the documented concurrent-runs context-mixing fix.
	 */
	private readonly _conversationByAgent = new Map<string, string>();
	/**
	 * Flag-OFF conversation store, keyed by conversationId. Flag-ON
	 * conversations live in the Context Ledger journal instead and never
	 * pass through this map.
	 */
	private readonly _agentConversations = new Map<string, LLMChatMessage[]>();
	/** runId → IAgentRun for active runs */
	private readonly _activeRuns = new Map<string, IAgentRun>();
	/** Completed runs in reverse-chronological order */
	private readonly _history: IAgentRun[] = [];
	private _ledgerWarned = false;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILLMMessageService private readonly llmService: ILLMMessageService,
		@IVoidSettingsService private readonly settingsService: IVoidSettingsService,
		@IAgentStoreService private readonly agentStore: IAgentStoreService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INotificationService private readonly notificationService: INotificationService,
		@IAccessibilitySignalService private readonly signalService: IAccessibilitySignalService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IProgressService private readonly progressService: IProgressService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IPowerBusService private readonly powerBusService: IPowerBusService,
		@IContextPackerService private readonly contextPackerService: IContextPackerService,
		@IWorkspaceSymbolIndexService private readonly symbolIndexService: IWorkspaceSymbolIndexService,
		@IRelevanceScorerService private readonly relevanceScorerService: IRelevanceScorerService,
		@IChangeTrackerService private readonly changeTrackerService: IChangeTrackerService,
		@IContextLedgerService private readonly contextLedgerService: IContextLedgerService,
	) {
		super();

		// ── Tool registry ────────────────────────────────────────────────────
		this._toolRegistry = new ToolRegistry();
		this._toolRegistry.registerMany(ALL_FS_TOOLS);
		this._toolRegistry.registerMany(ALL_TERMINAL_TOOLS);
		this._toolRegistry.registerMany(ALL_GIT_TOOLS);
		this._toolRegistry.registerMany(ALL_HTTP_TOOLS);
		const commTools = createCommunicationTools(
			this.notificationService,
			this.signalService,
			this.statusbarService,
			this.progressService,
			this.clipboardService,
			this.openerService,
		);
		this._toolRegistry.registerMany(commTools);

		// ── GRC tools ────────────────────────────────────────────────────────
		const grcTools = createGRCTools(null);
		this._toolRegistry.registerMany(grcTools);

		// ── Context Engine tools ─────────────────────────────────────────────
		const contextTools = createWorkflowContextTools({
			contextPacker: this.contextPackerService,
			symbolIndex: this.symbolIndexService,
			relevanceScorer: this.relevanceScorerService,
			changeTracker: this.changeTrackerService,
		});
		this._toolRegistry.registerMany(contextTools);

		// ── Register on PowerBus ─────────────────────────────────────────────
		this.powerBusService.register('ni-agent-runner', ['send:query', 'receive:tool-result', 'broadcast'], 'NI Agent Runner');

		// ── Workflow config loader ───────────────────────────────────────────
		this._configLoader = this._register(
			this.instantiationService.createInstance(WorkflowConfigLoader)
		);
		this._register(this._configLoader.onDidChange(() => {
			this._onDidChangeWorkflows.fire();
		}));

		// ── Orchestrator ─────────────────────────────────────────────────────
		this._orchestrator = new WorkflowOrchestrator(
			this.llmService,
			this.settingsService,
			this._toolRegistry,
			this.contextPackerService,
			this.contextLedgerService,
		);

		// ── Trigger Manager ───────────────────────────────────────────────────
		this._triggerManager = this._register(new WorkflowTriggerManager(
			this.textFileService,
			this.fileService,
			this.workspaceContextService,
			this.terminalService,
			(workflowId, trigger, context) => {
				// Skip if workflow is already actively running
				const alreadyRunning = [...this._activeRuns.values()].some(r => r.workflowId === workflowId);
				if (alreadyRunning) {
					console.log(`[WorkflowAgentService] Skipping auto-trigger for "${workflowId}" — already running`);
					return;
				}
				const input = context ? `Triggered by: ${trigger} (${context})` : `Triggered by: ${trigger}`;
				this.runWorkflow(workflowId, input, trigger).catch(err => {
					console.error(`[WorkflowAgentService] Auto-trigger run failed for "${workflowId}":`, err);
				});
			},
		));

		// Wire sub-workflow resolver so WorkflowComposer can look up workflows by ID
		this._orchestrator.workflowResolver = (id: string) => this._configLoader.getWorkflow(id);

		// Wire triggers once workflows are loaded, and re-wire on any change
		this._register(this._configLoader.onDidChange(() => {
			this._triggerManager.refresh(this._configLoader.getWorkflows());
		}));

		const totalTools = ALL_FS_TOOLS.length + ALL_TERMINAL_TOOLS.length + ALL_GIT_TOOLS.length + ALL_HTTP_TOOLS.length + commTools.length + grcTools.length + contextTools.length;
		console.log('[WorkflowAgentService] Initialized with', totalTools, 'tools (including', grcTools.length, 'GRC,', contextTools.length, 'context)');
	}

	// ─── Workflow Registry ────────────────────────────────────────────────────

	getWorkflows(): IWorkflowDefinition[] {
		return this._configLoader.getWorkflows();
	}

	getWorkflow(id: string): IWorkflowDefinition | undefined {
		return this._configLoader.getWorkflow(id);
	}

	async saveWorkflow(def: IWorkflowDefinition): Promise<void> {
		await this._configLoader.saveWorkflow(def);
	}

	async deleteWorkflow(id: string): Promise<void> {
		await this._configLoader.deleteWorkflow(id);
	}

	async listWorkflowVersions(workflowId: string) {
		return this._configLoader.listWorkflowVersions(workflowId);
	}

	async rollbackWorkflow(workflowId: string, version: number): Promise<void> {
		await this._configLoader.rollbackWorkflow(workflowId, version);
	}

	// ─── Execution ────────────────────────────────────────────────────────────

	async runWorkflow(
		workflowId: string,
		input: string,
		trigger: WorkflowTrigger = 'manual',
	): Promise<IAgentRun> {
		const workflow = this._configLoader.getWorkflow(workflowId);
		if (!workflow) throw new Error(`Workflow "${workflowId}" not found`);
		if (!workflow.enabled) throw new Error(`Workflow "${workflowId}" is disabled`);

		// Build agent map from AgentRegistryService
		// Workflow steps reference agents by `id`; keep name aliases for
		// definitions written before ids were stable.
		const agentMap = new Map(this.agentStore.getAgents().map(a => [a.id, a]));
		for (const a of this.agentStore.getAgents()) {
			agentMap.set(a.name.toLowerCase().replace(/\s+/g, '-'), a);
			agentMap.set(a.name, a);
		}

		const run = buildAgentRun(workflow, { kind: trigger });
		const cancellation: ICancellationToken = { cancelled: false };

		this._activeRuns.set(run.id, run);
		this._activeCancellations.set(run.id, cancellation);
		this._onDidChangeRun.fire(run);

		const folder = this.workspaceContextService.getWorkspace().folders[0];
		if (!folder) {
			run.status = 'failed';
			run.error = 'No workspace folder open';
			run.endedAt = Date.now();
			this._finalizeRun(run);
			return run;
		}

		const modelSel = this.settingsService.state.modelSelectionOfFeature['Chat'];
		const baseCtx = {
			workspaceUri: folder.uri,
			fileService: this.fileService,
			modelInfo: modelSel ? { provider: modelSel.providerName, model: modelSel.modelName } : undefined,
		};

		try {
			await this._orchestrator.run(
				workflow,
				run,
				agentMap,
				baseCtx,
				input,
				cancellation,
				(updatedRun) => this._onDidChangeRun.fire(updatedRun),
			);
		} catch (e: any) {
			run.status = 'failed';
			run.error = e.message;
			run.endedAt = Date.now();
		}

		this._finalizeRun(run);
		return run;
	}

	async runAgent(agentId: string, input: string): Promise<IAgentRun> {
		// Synthesize a single-step workflow for ad-hoc agent execution.
		// The synthetic id is never in the config registry, so run directly —
		// the old code first tried runWorkflow() which always rejected.
		const syntheticWorkflow: IWorkflowDefinition = {
			id: `adhoc-${agentId}`,
			name: `Ad-hoc: ${agentId}`,
			description: `Direct run of agent ${agentId}`,
			trigger: 'manual',
			enabled: true,
			steps: [{
				id: 'main',
				agentId,
				role: 'executor',
				allowedTools: [...ALL_FS_TOOLS, ...ALL_TERMINAL_TOOLS, ...ALL_GIT_TOOLS, ...ALL_HTTP_TOOLS].map(t => t.name),
			}],
		};
		const run = buildAgentRun(syntheticWorkflow, { kind: 'manual' });
		const cancellation: ICancellationToken = { cancelled: false };
		const agentMap = new Map(this.agentStore.getAgents().map(a => [a.id, a]));
		for (const a of this.agentStore.getAgents()) {
			agentMap.set(a.name.toLowerCase().replace(/\s+/g, '-'), a);
			agentMap.set(a.name, a);
		}
		const folder = this.workspaceContextService.getWorkspace().folders[0];

		this._activeRuns.set(run.id, run);
		this._activeCancellations.set(run.id, cancellation);
		this._onDidChangeRun.fire(run);

		if (!folder) {
			run.status = 'failed';
			run.error = 'No workspace folder open';
			run.endedAt = Date.now();
			this._finalizeRun(run);
			return run;
		}

		const agentModelSel = this.settingsService.state.modelSelectionOfFeature['Chat'];
		const baseCtx = { workspaceUri: folder.uri, fileService: this.fileService, modelInfo: agentModelSel ? { provider: agentModelSel.providerName, model: agentModelSel.modelName } : undefined };

		// Context Ledger flag (task M5 phase 5): ON → prior conversation comes
		// from the ledger journal keyed by conversationId; OFF → the in-RAM
		// store, exactly as before.
		const ledgerOn = this.settingsService.state.globalSettings.contextLedgerEnabled;
		const conversationId = this._getOrCreateConversationId(agentId);
		const priorConversation = ledgerOn
			? await this._loadConversationFromLedger(conversationId)
			: this._getAgentConversation(conversationId);

		try {
			await this._orchestrator.run(
				syntheticWorkflow, run, agentMap, baseCtx, input, cancellation,
				(r) => this._onDidChangeRun.fire(r),
				priorConversation,
			);
		} catch (e: any) {
			run.status = 'failed';
			run.error = e.message;
			run.endedAt = Date.now();
		}

		// Append this turn to the agent's conversation so follow-up messages
		// from the Agents tab keep their context. Only successful turns are
		// recorded — a failed run produced no assistant reply worth keeping.
		if (run.status === 'done' && run.finalOutput) {
			if (ledgerOn) {
				// Flag ON: journal the turn to the ledger, fire-and-forget with a
				// single warn on failure. The ledger path never truncates —
				// long conversations compress via episodes/brief, not the
				// splice/shift caps of the legacy branch below.
				this.contextLedgerService.append(conversationId, { role: 'user', content: input })
					.catch(() => this._warnLedgerOnce());
				this.contextLedgerService.append(conversationId, { role: 'assistant', content: run.finalOutput })
					.catch(() => this._warnLedgerOnce());
			} else {
				this._appendAgentConversation(conversationId, input, run.finalOutput);
			}
		}

		this._finalizeRun(run);
		return run;
	}

	/**
	 * Reset the conversation memory of an agent (ad-hoc chat runs only).
	 * The Agents tab can call this when the user starts a fresh chat.
	 */
	clearAgentConversation(agentId: string): void {
		// Delete the RAM conversation AND the agent→conversation pointer so the
		// next run starts a fresh conversationId. Ledger archives are never
		// deleted — memory is keyed per conversation instead of per
		// agent-lifetime, which closes the documented concurrent-runs
		// context-mixing bug (parallel chats of one agent no longer share a
		// single rolling history).
		const conversationId = this._conversationByAgent.get(agentId);
		if (conversationId !== undefined) {
			this._agentConversations.delete(conversationId);
		}
		this._conversationByAgent.delete(agentId);
	}

	cancelRun(runId: string): void {
		const token = this._activeCancellations.get(runId);
		if (token) {
			token.cancelled = true;
			console.log(`[WorkflowAgentService] Cancelled run: ${runId}`);
		}
	}

	respondToApproval(runId: string, stepId: string, response: IApprovalResponse): void {
		this._orchestrator.approvalGate.respond(runId, stepId, response);
	}

	// ─── State ────────────────────────────────────────────────────────────────

	getActiveRuns(): IAgentRun[] {
		return [...this._activeRuns.values()];
	}

	getRunHistory(limit = 20): IAgentRun[] {
		return this._history.slice(0, limit);
	}

	getRun(runId: string): IAgentRun | undefined {
		return this._activeRuns.get(runId) ?? this._history.find(r => r.id === runId);
	}

	// ─── Internal ─────────────────────────────────────────────────────────────

	/** Max user/assistant turns kept per agent conversation — bounds token growth in the legacy store and caps the ledger readTail (task M5 phase 5) */
	private static readonly MAX_CONVERSATION_MESSAGES = 24;
	/** Max estimated tokens kept per agent conversation — the real bound (legacy store) */
	private static readonly MAX_CONVERSATION_TOKENS = 32_000;
	/** A single stored turn is capped so one giant output can't dominate memory (legacy store) */
	private static readonly MAX_STORED_TURN_CHARS = 16_000;

	/** Get (or create on first run) the active conversationId of an agent. */
	private _getOrCreateConversationId(agentId: string): string {
		let conversationId = this._conversationByAgent.get(agentId);
		if (conversationId === undefined) {
			conversationId = `wf-${agentId}-${Date.now().toString(36)}`;
			this._conversationByAgent.set(agentId, conversationId);
		}
		return conversationId;
	}

	/**
	 * Flag-ON prior conversation for runAgent (task M5 phase 5): the ledger
	 * tail capped at MAX_CONVERSATION_MESSAGES entries, with the working brief
	 * prepended as one user message when one exists — long conversations keep
	 * continuing compressed within MAX_CONVERSATION_TOKENS instead of being
	 * truncated. Never throws: a ledger problem degrades to an empty prior
	 * (the run starts fresh).
	 */
	private async _loadConversationFromLedger(conversationId: string): Promise<LLMChatMessage[]> {
		try {
			const entries = await this.contextLedgerService.readTail(conversationId, WorkflowAgentService.MAX_CONVERSATION_MESSAGES);
			const messages: LLMChatMessage[] = [];
			const brief = await this.contextLedgerService.getBrief(conversationId);
			if (brief !== null) {
				messages.push({ role: 'user', content: brief.text });
			}
			for (const entry of entries) {
				const mapped = this._ledgerEntryToChatMessage(entry);
				if (mapped) messages.push(mapped);
			}
			return messages;
		} catch {
			this._warnLedgerOnce();
			return [];
		}
	}

	/** user/assistant pass through; tool results become user-formatted text; system/note are internal bookkeeping. */
	private _ledgerEntryToChatMessage(entry: ILedgerEntry): LLMChatMessage | null {
		if (entry.role === 'user') return { role: 'user', content: entry.content };
		if (entry.role === 'assistant') return { role: 'assistant', content: entry.content };
		if (entry.role === 'tool') return { role: 'user', content: `Tool "${entry.name ?? 'unknown'}" result:\n${entry.content}` };
		return null;
	}

	private _warnLedgerOnce(): void {
		if (this._ledgerWarned) return;
		this._ledgerWarned = true;
		console.warn('[WorkflowAgentService] context ledger degraded — agent conversation memory may reset; runs continue unaffected');
	}

	private _getAgentConversation(conversationId: string): LLMChatMessage[] {
		return [...(this._agentConversations.get(conversationId) ?? [])];
	}

	private _appendAgentConversation(conversationId: string, userText: string, assistantText: string): void {
		// Legacy (flag-OFF) branch only — the ledger path above never truncates.
		const cap = (t: string) => t.length > WorkflowAgentService.MAX_STORED_TURN_CHARS
			? t.slice(0, WorkflowAgentService.MAX_STORED_TURN_CHARS) + '\n…[truncated]'
			: t;
		const conv = this._agentConversations.get(conversationId) ?? [];
		conv.push({ role: 'user', content: cap(userText) });
		conv.push({ role: 'assistant', content: cap(assistantText) });
		// Keep the most recent turns; old context ages out
		if (conv.length > WorkflowAgentService.MAX_CONVERSATION_MESSAGES) {
			conv.splice(0, conv.length - WorkflowAgentService.MAX_CONVERSATION_MESSAGES);
		}
		// Token cap — a few huge turns can exceed the message cap's intent
		const tokensOf = (m: LLMChatMessage) => ConversationCompactor.estimateTextTokens(
			(() => { const c = (m as { content?: unknown }).content; return typeof c === 'string' ? c : JSON.stringify(c ?? ''); })()
		);
		let totalTokens = conv.reduce((s, m) => s + tokensOf(m), 0);
		while (conv.length > 2 && totalTokens > WorkflowAgentService.MAX_CONVERSATION_TOKENS) {
			totalTokens -= tokensOf(conv.shift()!);
		}
		this._agentConversations.set(conversationId, conv);
	}

	private _finalizeRun(run: IAgentRun): void {
		this._activeRuns.delete(run.id);
		this._activeCancellations.delete(run.id);

		// Prepend to history, cap at MAX_HISTORY
		this._history.unshift(run);
		if (this._history.length > MAX_HISTORY) {
			this._history.length = MAX_HISTORY;
		}

		this._onDidChangeRun.fire(run);
		console.log(`[WorkflowAgentService] Run ${run.id} finalized — status: ${run.status}`);
	}
}

registerSingleton(IWorkflowAgentService, WorkflowAgentService, InstantiationType.Delayed);
