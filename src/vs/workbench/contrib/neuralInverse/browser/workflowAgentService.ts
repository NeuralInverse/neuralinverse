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
import { IVoidSettingsService } from '../../void/common/voidSettingsService.js';
import { IAgentStoreService } from './agentStoreService.js';
import { IAgentRun, IWorkflowDefinition, WorkflowTrigger, IAgentTool, IToolExecutionContext } from '../common/workflowTypes.js';
import { ToolRegistry } from './tools/toolRegistry.js';
import { ALL_FS_TOOLS } from './tools/fsTools.js';
import { ALL_TERMINAL_TOOLS } from './tools/terminalTools.js';
import { ALL_GIT_TOOLS } from './tools/gitTools.js';
import { ALL_HTTP_TOOLS } from './tools/httpTools.js';
import { createCommunicationTools } from './tools/communicationTools.js';
import { createGRCTools } from './tools/grcTools.js';
import { IGRCEngineService } from '../../neuralInverseChecks/browser/engine/services/grcEngineService.js';
import { IPowerBusService } from '../../powerMode/browser/powerBusService.js';
import { INeuralInverseCCService } from '../../neuralInverseCC/browser/neuralInverseCCService.js';
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
}

// ─── Implementation ───────────────────────────────────────────────────────────

const MAX_HISTORY = 50;

export class WorkflowAgentService extends Disposable implements IWorkflowAgentService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeRun = this._register(new Emitter<IAgentRun>());
	readonly onDidChangeRun = this._onDidChangeRun.event;

	private readonly _onDidChangeWorkflows = this._register(new Emitter<void>());
	readonly onDidChangeWorkflows = this._onDidChangeWorkflows.event;

	private readonly _toolRegistry: ToolRegistry;
	private readonly _configLoader: WorkflowConfigLoader;
	private readonly _orchestrator: WorkflowOrchestrator;
	private readonly _triggerManager: WorkflowTriggerManager;

	/** runId → cancellation token for active runs */
	private readonly _activeCancellations = new Map<string, ICancellationToken>();
	/** runId → IAgentRun for active runs */
	private readonly _activeRuns = new Map<string, IAgentRun>();
	/** Completed runs in reverse-chronological order */
	private readonly _history: IAgentRun[] = [];

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
		@IGRCEngineService private readonly grcEngine: IGRCEngineService,
		@IPowerBusService private readonly powerBusService: IPowerBusService,
		@INeuralInverseCCService private readonly ccService: INeuralInverseCCService,
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
		const grcTools = createGRCTools(this.grcEngine);
		this._toolRegistry.registerMany(grcTools);

		// ── CC skill tools ───────────────────────────────────────────────────
		// Each CC skill becomes an IAgentTool so workflow agents can invoke
		// capabilities like verify, debug, simplify, stuck, batch, etc.
		const ccSkillTools: IAgentTool[] = this.ccService.getSkills()
			.filter(s => s.userInvocable !== false)
			.map(skill => ({
				name: `cc_skill_${skill.name}`,
				description: `CC Skill — ${skill.description}${skill.whenToUse ? ` Use when: ${skill.whenToUse}` : ''}`,
				parameters: {
					goal: { type: 'string' as const, description: skill.argumentHint ?? 'The goal or context for this skill', required: true },
					workspaceDir: { type: 'string' as const, description: 'Workspace directory path', required: false },
				},
				execute: async (args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<{ success: boolean; output: string; error?: string }> => {
					try {
						const goal = String(args['goal'] ?? '');
						const workspaceDir = String(args['workspaceDir'] ?? ctx.workspaceUri?.fsPath ?? '/');
						const promptText = await skill.getPromptText(goal, {
							workingDirectory: workspaceDir,
							agentId: skill.name,
							sessionId: `ni-skill-${skill.name}-${Date.now()}`,
						});
						return { success: true, output: promptText };
					} catch (e: any) {
						return { success: false, output: '', error: e.message };
					}
				},
			}));
		this._toolRegistry.registerMany(ccSkillTools);

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
			this.ccService,
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

		// Wire triggers once workflows are loaded, and re-wire on any change
		this._register(this._configLoader.onDidChange(() => {
			this._triggerManager.refresh(this._configLoader.getWorkflows());
		}));

		const totalTools = ALL_FS_TOOLS.length + ALL_TERMINAL_TOOLS.length + ALL_GIT_TOOLS.length + ALL_HTTP_TOOLS.length + commTools.length + grcTools.length + ccSkillTools.length;
		console.log('[WorkflowAgentService] Initialized with', totalTools, 'tools (including', grcTools.length, 'GRC tools,', ccSkillTools.length, 'CC skill tools)');
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

	// ─── Execution ────────────────────────────────────────────────────────────

	async runWorkflow(
		workflowId: string,
		input: string,
		trigger: WorkflowTrigger = 'manual',
	): Promise<IAgentRun> {
		const workflow = this._configLoader.getWorkflow(workflowId);
		if (!workflow) throw new Error(`Workflow "${workflowId}" not found`);
		if (!workflow.enabled) throw new Error(`Workflow "${workflowId}" is disabled`);

		// Build agent map — indexed by id, name slug, and raw name so workflow
		// steps can reference agents by any of these keys.
		const agentMap = new Map<string, IAgentDefinition>();
		for (const a of this.agentStore.getAgents()) {
			agentMap.set(a.id, a);                                        // primary: id
			agentMap.set(a.name.toLowerCase().replace(/\s+/g, '-'), a);  // slug of name
			agentMap.set(a.name, a);                                      // raw name
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

		const baseCtx = {
			workspaceUri: folder.uri,
			fileService: this.fileService,
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
		// Synthesize a single-step workflow for ad-hoc agent execution
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
		return this.runWorkflow(syntheticWorkflow.id, input, 'manual').catch(async () => {
			// Workflow not in registry — use the synthetic one directly
			const run = buildAgentRun(syntheticWorkflow, { kind: 'manual' });
			const cancellation: ICancellationToken = { cancelled: false };
			const agentMap = new Map<string, IAgentDefinition>();
			for (const a of this.agentStore.getAgents()) {
				agentMap.set(a.id, a);
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

			const baseCtx = { workspaceUri: folder.uri, fileService: this.fileService };

			try {
				await this._orchestrator.run(
					syntheticWorkflow, run, agentMap, baseCtx, input, cancellation,
					(r) => this._onDidChangeRun.fire(r),
				);
			} catch (e: any) {
				run.status = 'failed';
				run.error = e.message;
				run.endedAt = Date.now();
			}

			this._finalizeRun(run);
			return run;
		});
	}

	cancelRun(runId: string): void {
		const token = this._activeCancellations.get(runId);
		if (token) {
			token.cancelled = true;
			console.log(`[WorkflowAgentService] Cancelled run: ${runId}`);
		}
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
