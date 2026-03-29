/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Neural Inverse Agent Service — Autonomous agentic execution engine.
 *
 *  This service wraps the existing ChatThreadService tool-use loop with
 *  an autonomous agent layer that:
 *    1. Plans multi-step tasks
 *    2. Auto-approves safe tools based on risk tiers
 *    3. Tracks execution context (working memory)
 *    4. Self-corrects on errors
 *    5. Emits structured events for the UI
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';

import { IChatThreadService } from './chatThreadServiceInterface.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ToolName } from '../common/toolsServiceTypes.js';
import { INeuralInverseAgentConfigService } from './neuralInverseAgentConfigService.js';

import {
	AgentTask,
	AgentTaskStatus,
	AgentEvent,
	AgentAction,
	AgentContextEntry,
	AgentWorkingMemory,
	ApprovalTier,
	defaultApprovalTiers,
	getRiskLevel,
	AGENT_MAX_ITERATIONS,
	AGENT_MAX_CONSECUTIVE_ERRORS,
	AGENT_STEP_COOLDOWN_MS,
	AGENT_CONTEXT_MAX_TOKENS,
} from '../common/neuralInverseAgentTypes.js';


// ======================== Service Interface ========================

export interface INeuralInverseAgentService {
	readonly _serviceBrand: undefined;

	/** Currently active task (null when idle) */
	readonly activeTask: AgentTask | null;

	/** Working memory for the active task */
	readonly workingMemory: AgentWorkingMemory;

	/** Event fired on any agent state change */
	readonly onDidChangeAgentState: Event<AgentEvent>;

	/** Start an autonomous agent task from a user goal */
	startTask(goal: string, threadId: string): AgentTask;

	/** Pause the running agent (resumes on next approve or explicit resume) */
	pauseTask(taskId: string): void;

	/** Resume a paused task */
	resumeTask(taskId: string): void;

	/** Cancel and abort the active task */
	cancelTask(taskId: string): void;

	/** Get the approval tier for a tool (respects overrides) */
	getApprovalTier(toolName: ToolName): ApprovalTier;

	/** Check if a tool should be auto-approved in agent mode */
	shouldAutoApprove(toolName: ToolName): boolean;

	/** Record a context entry into working memory */
	recordContext(entry: Omit<AgentContextEntry, 'timestamp'>): void;

	/** Get compressed context string for LLM injection */
	getContextSummary(): string;
}

export const INeuralInverseAgentService = createDecorator<INeuralInverseAgentService>('neuralInverseAgentService');


// ======================== Service Implementation ========================

class NeuralInverseAgentService extends Disposable implements INeuralInverseAgentService {
	readonly _serviceBrand: undefined;

	private _activeTask: AgentTask | null = null;
	private _workingMemory: AgentWorkingMemory;
	private _approvalOverrides: Map<string, ApprovalTier> = new Map();
	private _consecutiveErrors = 0;
	private _isPaused = false;
	private _lastStreamIsRunning: string | undefined = undefined; // tracks previous state to detect LLM transitions

	private readonly _onDidChangeAgentState = this._register(new Emitter<AgentEvent>());
	readonly onDidChangeAgentState: Event<AgentEvent> = this._onDidChangeAgentState.event;

	get activeTask(): AgentTask | null { return this._activeTask; }

	get workingMemory(): AgentWorkingMemory { return this._workingMemory; }

	constructor(
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@INotificationService private readonly _notificationService: INotificationService,
		@INeuralInverseAgentConfigService private readonly _configService: INeuralInverseAgentConfigService,
	) {
		super();
		this._workingMemory = this._createFreshMemory();
		this._registerStreamStateListener();

		// Apply config overrides
		this._register(this._configService.onDidChangeConfig(() => this._loadConfigOverrides()));
		this._loadConfigOverrides();
	}

	// ---- Config ----

	private _loadConfigOverrides(): void {
		this._approvalOverrides.clear();
		const tiers = this._configService.config.approvalTiers;
		for (const [toolName, tier] of Object.entries(tiers)) {
			if (tier) this._approvalOverrides.set(toolName, tier as ApprovalTier);
		}
	}


	// ---- Task Lifecycle ----

	startTask(goal: string, threadId: string): AgentTask {
		// Cancel any existing task
		if (this._activeTask && this._activeTask.status === 'executing') {
			this.cancelTask(this._activeTask.id);
		}

		const now = new Date().toISOString();
		const maxIter = this._configService.config.constraints.maxIterations ?? AGENT_MAX_ITERATIONS;
		const task: AgentTask = {
			id: generateUuid(),
			goal,
			status: 'planning',
			steps: [],
			executionLog: [],
			createdAt: now,
			updatedAt: now,
			threadId,
			iteration: 0,
			maxIterations: maxIter,
			filesRead: new Set(),
			filesModified: new Set(),
			totalToolCalls: 0,
			totalLLMCalls: 0,
			totalErrors: 0,
		};

		this._activeTask = task;
		this._workingMemory = this._createFreshMemory();
		this._consecutiveErrors = 0;
		this._isPaused = false;

		this._emitEvent('task_created', task.id);
		this._logAction(task, { type: 'status_update', summary: `Task created: ${goal}` });

		// Transition to executing — the chat thread loop drives the actual LLM calls
		this._transitionStatus(task, 'executing');

		return task;
	}

	pauseTask(taskId: string): void {
		const task = this._requireTask(taskId);
		if (task.status !== 'executing') return;

		this._isPaused = true;
		this._transitionStatus(task, 'paused');
	}

	resumeTask(taskId: string): void {
		const task = this._requireTask(taskId);
		if (task.status !== 'paused') return;

		this._isPaused = false;
		this._transitionStatus(task, 'executing');

		// Kick the chat thread to continue if it was waiting
		const streamState = this._chatThreadService.streamState[task.threadId];
		if (streamState?.isRunning === 'awaiting_user') {
			this._chatThreadService.approveLatestToolRequest(task.threadId);
		}
	}

	cancelTask(taskId: string): void {
		const task = this._requireTask(taskId);
		if (task.status === 'completed' || task.status === 'cancelled') return;

		this._transitionStatus(task, 'cancelled');
		this._chatThreadService.abortRunning(task.threadId);
		this._activeTask = null;
	}


	// ---- Approval Tiers ----

	getApprovalTier(toolName: ToolName): ApprovalTier {
		// Check user overrides first
		const override = this._approvalOverrides.get(toolName);
		if (override) return override;

		// Check settings-level auto-approve (existing Void mechanism)
		const globalAutoApprove = this._settingsService.state.globalSettings.autoApprove;
		if (toolName in defaultApprovalTiers) {
			const builtinTier = defaultApprovalTiers[toolName as keyof typeof defaultApprovalTiers];

			// If the user has globally auto-approved the category, promote to auto
			const riskLevel = getRiskLevel(toolName);
			if (riskLevel === 'moderate' && globalAutoApprove['edits']) return 'auto';
			if (riskLevel === 'destructive' && globalAutoApprove['terminal']) return 'auto';

			return builtinTier;
		}

		// MCP tools: check global MCP auto-approve
		if (globalAutoApprove['MCP tools']) return 'auto';
		return 'confirm';
	}

	shouldAutoApprove(toolName: ToolName): boolean {
		if (!this._activeTask || this._activeTask.status !== 'executing') return false;
		const tier = this.getApprovalTier(toolName);
		return tier === 'auto';
	}


	// ---- Working Memory / Context ----

	recordContext(entry: Omit<AgentContextEntry, 'timestamp'>): void {
		const fullEntry: AgentContextEntry = {
			...entry,
			timestamp: new Date().toISOString(),
		};

		this._workingMemory.entries.push(fullEntry);

		// Rough token estimate: ~4 chars per token
		this._workingMemory.estimatedTokens += Math.ceil(entry.summary.length / 4);

		// Prune low-importance entries if over budget
		this._pruneMemoryIfNeeded();
	}

	getContextSummary(): string {
		if (this._workingMemory.entries.length === 0) return '';

		const sections: string[] = [];

		// Project map (if available)
		if (this._workingMemory.projectMap) {
			sections.push(`<project_map>\n${this._workingMemory.projectMap}\n</project_map>`);
		}

		// Recent context entries (newest first, capped)
		const recentEntries = this._workingMemory.entries
			.slice(-30) // last 30 entries
			.map(e => `[${e.type}] ${e.summary}`)
			.join('\n');

		if (recentEntries) {
			sections.push(`<agent_context>\n${recentEntries}\n</agent_context>`);
		}

		// Task progress
		if (this._activeTask) {
			const task = this._activeTask;
			const progress = `Task: ${task.goal}\nIteration: ${task.iteration}/${task.maxIterations}\nFiles read: ${task.filesRead.size} | Files modified: ${task.filesModified.size}\nTool calls: ${task.totalToolCalls} | Errors: ${task.totalErrors}`;
			sections.push(`<agent_progress>\n${progress}\n</agent_progress>`);
		}

		return sections.join('\n\n');
	}


	// ---- Internal: Stream State Listener ----

	/**
	 * Listens to chatThreadService stream state changes to drive the agent loop.
	 * When a tool call reaches 'awaiting_user' and the tool is auto-approvable,
	 * the agent automatically approves it.
	 */
	private _registerStreamStateListener(): void {
		this._register(this._chatThreadService.onDidChangeStreamState(({ threadId }) => {
			if (!this._activeTask || this._activeTask.threadId !== threadId) return;
			if (this._isPaused) return;

			const task = this._activeTask;
			const streamState = this._chatThreadService.streamState[threadId];
			const prevIsRunning = this._lastStreamIsRunning;
			this._lastStreamIsRunning = streamState?.isRunning;

			// Track iterations — only count ONCE per LLM call by detecting the transition into 'LLM'
			// (onText fires _setStreamState on every token, so we must not increment per-token)
			if (streamState?.isRunning === 'LLM' && prevIsRunning !== 'LLM') {
				task.totalLLMCalls++;
				task.iteration++;
				task.updatedAt = new Date().toISOString();

				// Guard: max iterations
				if (task.iteration >= task.maxIterations) {
					this._transitionStatus(task, 'failed');
					this._logAction(task, { type: 'error', summary: `Hit max iterations (${task.maxIterations})` });
					this._chatThreadService.abortRunning(threadId);
					return;
				}
			}

			// Auto-approve safe/notify tools
			if (streamState?.isRunning === 'awaiting_user') {
				const thread = this._chatThreadService.state.allThreads[threadId];
				if (!thread) return;

				const lastMsg = thread.messages[thread.messages.length - 1];
				if (lastMsg?.role === 'tool' && lastMsg.type === 'tool_request') {
					const toolName = lastMsg.name;

					// Block terminal commands that violate .neuralinverseagent constraints
					if ((toolName === 'run_command' || toolName === 'run_persistent_command') && lastMsg.rawParams?.['command']) {
						const cmd = String(lastMsg.rawParams['command']);
						if (!this._configService.isCommandAllowed(cmd)) {
							this._chatThreadService.rejectLatestToolRequest(threadId);
							this._logAction(task, { type: 'error', summary: `Blocked command by .neuralinverseagent policy: ${cmd}` });
							return;
						}

					}

					const tier = this.getApprovalTier(toolName);

					if (tier === 'auto') {
						// Auto-approve immediately
						task.totalToolCalls++;
						this._consecutiveErrors = 0;
						this._trackToolContext(toolName, lastMsg);
						this._emitEvent('tool_auto_approved', task.id, { toolName });

						// Use setTimeout to avoid re-entrant state updates
						setTimeout(() => {
							this._chatThreadService.approveLatestToolRequest(threadId);
						}, AGENT_STEP_COOLDOWN_MS);

					} else if (tier === 'notify') {
						// Auto-approve but notify user
						task.totalToolCalls++;
						this._consecutiveErrors = 0;
						this._trackToolContext(toolName, lastMsg);
						this._notificationService.notify({
							severity: Severity.Info,
							message: `NI Agent: ${toolName} executed`,
							source: 'NeuralInverse Agent',
						});
						this._emitEvent('tool_notify', task.id, { toolName });

						setTimeout(() => {
							this._chatThreadService.approveLatestToolRequest(threadId);
						}, AGENT_STEP_COOLDOWN_MS);

					} else {
						// confirm tier — wait for user
						this._transitionStatus(task, 'awaiting_approval');
						this._emitEvent('tool_awaiting_confirm', task.id, { toolName });
					}
				}
			}

			// Detect when the stream finishes (undefined = idle/done)
			if (streamState?.isRunning === undefined) {
				if (task.status === 'executing' || task.status === 'awaiting_approval') {
					// Check for errors
					if (streamState?.error) {
						task.totalErrors++;
						this._consecutiveErrors++;
						this._logAction(task, { type: 'error', summary: streamState.error.message });

						if (this._consecutiveErrors >= AGENT_MAX_CONSECUTIVE_ERRORS) {
							this._transitionStatus(task, 'failed');
							this._logAction(task, { type: 'error', summary: `Too many consecutive errors (${AGENT_MAX_CONSECUTIVE_ERRORS})` });
							return;
						}
					} else {
						// Clean completion
						this._consecutiveErrors = 0;
						this._transitionStatus(task, 'completed');
						this._emitEvent('task_completed', task.id);
					}
				}
			}
		}));
	}


	// ---- Internal Helpers ----

	private _requireTask(taskId: string): AgentTask {
		if (!this._activeTask || this._activeTask.id !== taskId) {
			throw new Error(`No active agent task with id ${taskId}`);
		}
		return this._activeTask;
	}

	private _transitionStatus(task: AgentTask, newStatus: AgentTaskStatus): void {
		task.status = newStatus;
		task.updatedAt = new Date().toISOString();
		this._emitEvent('task_updated', task.id, { status: newStatus });
	}

	private _emitEvent(type: AgentEvent['type'], taskId: string, data?: Record<string, unknown>): void {
		this._onDidChangeAgentState.fire({
			type,
			taskId,
			timestamp: new Date().toISOString(),
			data,
		});
	}

	private _logAction(task: AgentTask, action: Omit<AgentAction, 'timestamp'>): void {
		task.executionLog.push({
			...action,
			timestamp: new Date().toISOString(),
		});
	}

	private _trackToolContext(toolName: ToolName, toolMsg: { rawParams?: Record<string, unknown> }): void {
		const task = this._activeTask;
		if (!task) return;

		const uri = toolMsg.rawParams?.['uri'] as string | undefined;

		// Track files
		if (uri) {
			const readTools = new Set(['read_file', 'ls_dir', 'get_dir_tree', 'search_in_file', 'read_lint_errors']);
			const editTools = new Set(['edit_file', 'rewrite_file', 'multi_replace_file_content', 'create_file_or_folder']);

			if (readTools.has(toolName)) task.filesRead.add(uri);
			if (editTools.has(toolName)) task.filesModified.add(uri);
		}

		// Record into working memory
		this.recordContext({
			type: toolName.startsWith('read_') || toolName.startsWith('search_') || toolName.startsWith('ls_') || toolName === 'get_dir_tree'
				? 'file_read'
				: toolName.startsWith('run_') || toolName === 'send_command_input'
					? 'terminal_output'
					: 'file_edit',
			summary: `${toolName}${uri ? ` on ${uri}` : ''}`,
			importance: getRiskLevel(toolName) === 'safe' ? 1 : getRiskLevel(toolName) === 'moderate' ? 3 : 5,
		});
	}

	private _createFreshMemory(): AgentWorkingMemory {
		const budget = this._configService?.config?.memory?.maxTokenBudget ?? AGENT_CONTEXT_MAX_TOKENS;
		return {
			entries: [],
			estimatedTokens: 0,
			maxTokenBudget: budget,
		};
	}

	private _pruneMemoryIfNeeded(): void {
		const mem = this._workingMemory;
		if (mem.estimatedTokens <= mem.maxTokenBudget) return;

		// Sort by importance (ascending), prune lowest-importance first
		const sorted = [...mem.entries].sort((a, b) => a.importance - b.importance);
		while (mem.estimatedTokens > mem.maxTokenBudget * 0.8 && sorted.length > 0) {
			const removed = sorted.shift()!;
			const idx = mem.entries.indexOf(removed);
			if (idx !== -1) {
				mem.entries.splice(idx, 1);
				mem.estimatedTokens -= Math.ceil(removed.summary.length / 4);
			}
		}
	}
}


registerSingleton(INeuralInverseAgentService, NeuralInverseAgentService, InstantiationType.Eager);
