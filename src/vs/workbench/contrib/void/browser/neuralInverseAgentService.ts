/*--------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Neural Inverse Agent Service — autonomous agentic execution over the chat tool loop.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
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
	AGENT_MAX_CONSECUTIVE_ERRORS,
	AGENT_MAX_REPLANS,
	AGENT_STEP_COOLDOWN_MS,
	AGENT_CONTEXT_MAX_TOKENS,
	AGENT_ITERATION_BUDGET,
} from '../common/neuralInverseAgentTypes.js';
import { IAgentScratchpadService } from './agentScratchpadService.js';
import { IAgentTaskDecomposer } from './agentTaskDecomposer.js';
import { IAgentMemoryService } from './agentMemoryService.js';
import type { INeuralInverseSubAgentService } from './neuralInverseSubAgentService.js';


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
	/** Query-aware variant used by the production injection path (task M2) — hybrid memory recall instead of the sync summary */
	getContextSummaryAsync(): Promise<string>;
	/**
	 * Chat-path memory recall keyed by the user's message (task A8): in a plain
	 * chat no workflow agent is running, so working memory is empty and
	 * getContextSummaryAsync would never surface stored memories. Returns the
	 * wrapped `Agent Memory` block, or '' when the query is empty / nothing
	 * clears the score floor. Never throws.
	 */
	getChatMemoryContext(query: string): Promise<string>;
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
		@IAgentScratchpadService private readonly _scratchpadService: IAgentScratchpadService,
		@IAgentTaskDecomposer private readonly _taskDecomposer: IAgentTaskDecomposer,
		@IAgentMemoryService private readonly _memoryService: IAgentMemoryService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
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
			if (tier) { this._approvalOverrides.set(toolName, tier as ApprovalTier); }
		}
	}


	// ---- Task Lifecycle ----

	startTask(goal: string, threadId: string): AgentTask {
		// Cancel any existing task
		if (this._activeTask && this._activeTask.status === 'executing') {
			this.cancelTask(this._activeTask.id);
		}

		const now = new Date().toISOString();
		const estimatedComplexity = this._taskDecomposer.estimateComplexity(goal);
		const maxIter = this._configService.config.constraints.maxIterations ?? AGENT_ITERATION_BUDGET[estimatedComplexity];
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
			subtasks: [],
			scratchpad: this._scratchpadService.scratchpad,
			replans: [],
			complexity: estimatedComplexity,
		};

		this._activeTask = task;
		this._workingMemory = this._createFreshMemory();
		this._consecutiveErrors = 0;
		this._isPaused = false;
		this._scratchpadService.clear();

		this._emitEvent('task_created', task.id);
		this._logAction(task, { type: 'status_update', summary: `Task created: ${goal}` });
		this._scratchpadService.append('observation', `Goal: ${goal}`, 5);

		// Kick off async decomposition in background — updates task.subtasks when done
		this._decomposeTaskAsync(task, goal);

		// Transition directly to executing — full autonomy, no plan-approval gate
		this._transitionStatus(task, 'executing');

		return task;
	}

	pauseTask(taskId: string): void {
		const task = this._requireTask(taskId);
		if (task.status !== 'executing') { return; }

		this._isPaused = true;
		this._transitionStatus(task, 'paused');
	}

	resumeTask(taskId: string): void {
		const task = this._requireTask(taskId);
		if (task.status !== 'paused') { return; }

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
		if (task.status === 'completed' || task.status === 'cancelled') { return; }

		this._transitionStatus(task, 'cancelled');
		this._chatThreadService.abortRunning(task.threadId);
		this._activeTask = null;
	}


	// ---- Approval Tiers ----

	getApprovalTier(toolName: ToolName): ApprovalTier {
		// Check user overrides first
		const override = this._approvalOverrides.get(toolName);
		if (override) { return override; }

		// Check settings-level auto-approve (existing Void mechanism)
		const globalAutoApprove = this._settingsService.state.globalSettings.autoApprove;
		const builtinTier = defaultApprovalTiers[toolName as keyof typeof defaultApprovalTiers];
		if (builtinTier) {
			// If the user has globally auto-approved the category, promote to auto
			const riskLevel = getRiskLevel(toolName);
			if (riskLevel === 'moderate' && globalAutoApprove['edits']) { return 'auto'; }
			if (riskLevel === 'destructive' && globalAutoApprove['terminal']) { return 'auto'; }

			return builtinTier;
		}

		// MCP tools: check global MCP auto-approve
		if (globalAutoApprove['MCP tools']) { return 'auto'; }
		return 'confirm';
	}

	shouldAutoApprove(toolName: ToolName): boolean {
		if (!this._activeTask || this._activeTask.status !== 'executing') { return false; }
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
		if (this._workingMemory.entries.length === 0) { return ''; }

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

		// Task progress + subtask status
		if (this._activeTask) {
			const task = this._activeTask;
			const progress = `Task: ${task.goal}\nComplexity: ${task.complexity} | Iteration: ${task.iteration}/${task.maxIterations}\nFiles read: ${task.filesRead.size} | Files modified: ${task.filesModified.size}\nTool calls: ${task.totalToolCalls} | Errors: ${task.totalErrors} | Replans: ${task.replans.length}`;
			sections.push(`<agent_progress>\n${progress}\n</agent_progress>`);

			if (task.subtasks.length > 0) {
				const subtaskSummary = task.subtasks
					.map(st => `[${st.status}] ${st.goal}`)
					.join('\n');
				sections.push(`<subtasks>\n${subtaskSummary}\n</subtasks>`);
			}
		}

		// Scratchpad reasoning trace
		const scratchpadSummary = this._scratchpadService.getCompressedSummary();
		if (scratchpadSummary) {
			sections.push(scratchpadSummary);
		}

		// Persistent memory (cross-session learned context)
		const memorySummary = this._memoryService.getContextSummary(1500);
		if (memorySummary) {
			sections.push(`<persistent_memory>\n${memorySummary}\n</persistent_memory>`);
		}

		return sections.join('\n\n');
	}

	/**
	 * Query-aware variant for the production injection path (task M2): the
	 * persistent-memory section comes from hybrid recall (vector + lexical +
	 * recency + frequency, each line with its match reasons) driven by the
	 * active task goal and the most recent working-memory entries, instead of
	 * the sync importance-ranked summary. Falls back to that summary whenever
	 * recall yields nothing.
	 */
	async getContextSummaryAsync(): Promise<string> {
		if (this._workingMemory.entries.length === 0) { return ''; }

		const sections: string[] = [];

		if (this._workingMemory.projectMap) {
			sections.push(`<project_map>\n${this._workingMemory.projectMap}\n</project_map>`);
		}

		const recentEntries = this._workingMemory.entries
			.slice(-30)
			.map(e => `[${e.type}] ${e.summary}`)
			.join('\n');
		if (recentEntries) {
			sections.push(`<agent_context>\n${recentEntries}\n</agent_context>`);
		}

		if (this._activeTask) {
			const task = this._activeTask;
			const progress = `Task: ${task.goal}\nComplexity: ${task.complexity} | Iteration: ${task.iteration}/${task.maxIterations}\nFiles read: ${task.filesRead.size} | Files modified: ${task.filesModified.size}\nTool calls: ${task.totalToolCalls} | Errors: ${task.totalErrors} | Replans: ${task.replans.length}`;
			sections.push(`<agent_progress>\n${progress}\n</agent_progress>`);

			if (task.subtasks.length > 0) {
				const subtaskSummary = task.subtasks
					.map(st => `[${st.status}] ${st.goal}`)
					.join('\n');
				sections.push(`<subtasks>\n${subtaskSummary}\n</subtasks>`);
			}
		}

		const scratchpadSummary = this._scratchpadService.getCompressedSummary();
		if (scratchpadSummary) {
			sections.push(scratchpadSummary);
		}

		// Hybrid recall driven by what the agent is doing right now
		const queryParts = [
			this._activeTask?.goal ?? '',
			...this._workingMemory.entries.slice(-5).map(e => e.summary),
		].filter(p => p.length > 0);
		let memorySummary = '';
		try {
			memorySummary = await this._memoryService.recallForPrompt(queryParts.join(' '), 1500, 8);
		} catch { /* recall must never break the send */ }
		if (!memorySummary) {
			memorySummary = this._memoryService.getContextSummary(1500);
		}
		if (memorySummary) {
			sections.push(`<persistent_memory>\n${memorySummary}\n</persistent_memory>`);
		}

		return sections.join('\n\n');
	}

	async getChatMemoryContext(query: string): Promise<string> {
		const trimmed = query.trim();
		if (!trimmed) { return ''; }
		try {
			const block = await this._memoryService.recallForPrompt(trimmed, 1500, 8);
			return block ? `<persistent_memory>\n${block}\n</persistent_memory>` : '';
		} catch {
			return ''; // recall must never break the send
		}
	}


	// ---- Internal: Stream State Listener ----

	/**
	 * Listens to chatThreadService stream state changes to drive the agent loop.
	 * When a tool call reaches 'awaiting_user' and the tool is auto-approvable,
	 * the agent automatically approves it.
	 */
	private _registerStreamStateListener(): void {
		this._register(this._chatThreadService.onDidChangeStreamState(({ threadId }) => {
			if (!this._activeTask || this._activeTask.threadId !== threadId) { return; }
			if (this._isPaused) { return; }

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
				if (!thread) { return; }

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
						// Pre-edit context gathering: if edit tool targets a file not yet read, spawn explorer
						const editTools = new Set(['edit_file', 'rewrite_file', 'multi_replace_file_content']);
						const targetUri = lastMsg.rawParams?.['uri'] as string | undefined;
						if (editTools.has(toolName) && targetUri && !task.filesRead.has(targetUri)) {
							this._spawnPreEditExplorer(task, targetUri);
						}

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
					if (streamState?.error) {
						task.totalErrors++;
						this._consecutiveErrors++;
						const errorMsg = streamState.error.message;
						this._logAction(task, { type: 'error', summary: errorMsg });
						this._scratchpadService.append('error', errorMsg, 5);

						if (this._consecutiveErrors >= AGENT_MAX_CONSECUTIVE_ERRORS) {
							// Attempt replan before hard-failing
							const errorClass = this._classifyError(errorMsg);
							const existingReplan = task.replans.find(r => r.errorClass === errorClass);

							if (!existingReplan || existingReplan.replanCount < AGENT_MAX_REPLANS) {
								this._triggerReplan(task, errorClass, errorMsg);
							} else {
								this._transitionStatus(task, 'failed');
								this._logAction(task, { type: 'error', summary: `Replan limit reached for error class: ${errorClass}` });
							}
						}
					} else {
						// Clean completion
						this._consecutiveErrors = 0;
						this._scratchpadService.append('observation', 'Task completed successfully', 3);
						this._transitionStatus(task, 'completed');
						this._emitEvent('task_completed', task.id);
						this._persistTaskMemory(task);
					}
				}
			}
		}));
	}


	// ---- Memory Persistence ----

	private _persistTaskMemory(task: AgentTask): void {
		// Store file modification patterns
		if (task.filesModified.size > 0) {
			const files = Array.from(task.filesModified).map(f => f.split('/').pop()).join(', ');
			this._memoryService.remember('project-fact', `Modified files for "${task.goal}": ${files}`, ['task-result']);
		}
		// Store error-fix patterns for future reference
		for (const replan of task.replans) {
			if (replan.errorMessage) {
				this._memoryService.remember('error-fix', `Replan during "${task.goal}": ${replan.errorMessage}`, ['replan', 'error']);
			}
		}
		// Store tool usage pattern
		if (task.totalToolCalls > 5) {
			const toolSummary: Record<string, number> = {};
			for (const t of task.steps.flatMap(s => s.toolsUsed)) {
				toolSummary[t] = (toolSummary[t] ?? 0) + 1;
			}
			const topTools = Object.entries(toolSummary).sort((a, b) => b[1] - a[1]).slice(0, 5)
				.map(([t, c]) => `${t}(${c})`).join(', ');
			this._memoryService.remember('tool-usage', `Task "${task.goal}" used: ${topTools}`, ['tool-pattern']);
		}
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
		if (!task) { return; }

		const uri = toolMsg.rawParams?.['uri'] as string | undefined;

		// Track files
		if (uri) {
			const readTools = new Set(['read_file', 'ls_dir', 'get_dir_tree', 'search_in_file', 'read_lint_errors']);
			const editTools = new Set(['edit_file', 'rewrite_file', 'multi_replace_file_content', 'create_file_or_folder']);

			if (readTools.has(toolName)) { task.filesRead.add(uri); }
			if (editTools.has(toolName)) { task.filesModified.add(uri); }
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

	private _getSubAgentService(): INeuralInverseSubAgentService | undefined {
		try {
			const { INeuralInverseSubAgentService: id } = require('./neuralInverseSubAgentService.js');
			return this._instantiationService.invokeFunction(accessor => accessor.get(id));
		} catch { return undefined; }
	}

	private _spawnPreEditExplorer(task: AgentTask, targetUri: string): void {
		const subAgentService = this._getSubAgentService();
		if (!subAgentService) { return; }
		const goal = `Read and understand ${targetUri} — its imports, exports, main patterns — to provide context for an upcoming edit.`;
		const subAgent = subAgentService.spawn({
			role: 'explorer',
			goal,
			scopedFiles: [targetUri],
			parentContext: { id: task.id, type: 'agent-task' },
		});
		if (subAgent) {
			task.filesRead.add(targetUri);
			// Poll for result asynchronously (non-blocking — edit proceeds regardless)
			const checkResult = () => {
				const result = subAgentService.getResult(subAgent.id);
				if (result) {
					this.recordContext({
						type: 'file_read',
						summary: `Pre-edit exploration of ${targetUri}: ${result.slice(0, 500)}`,
						importance: 4,
					});
				} else if (subAgent.status !== 'completed' && subAgent.status !== 'failed') {
					setTimeout(checkResult, 1000);
				}
			};
			setTimeout(checkResult, 2000);
		}
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
		if (mem.estimatedTokens <= mem.maxTokenBudget) { return; }

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

	private _classifyError(errorMsg: string): string {
		const lower = errorMsg.toLowerCase();
		if (lower.includes('timeout')) { return 'timeout'; }
		if (lower.includes('permission') || lower.includes('eacces')) { return 'permission'; }
		if (lower.includes('not found') || lower.includes('enoent')) { return 'not_found'; }
		if (lower.includes('rate limit') || lower.includes('429')) { return 'rate_limit'; }
		if (lower.includes('parse') || lower.includes('syntax')) { return 'parse_error'; }
		return 'unknown';
	}

	private _triggerReplan(task: AgentTask, errorClass: string, errorMsg: string): void {
		const existing = task.replans.find(r => r.errorClass === errorClass);
		if (existing) {
			existing.replanCount++;
			existing.lastReplanAt = new Date().toISOString();
		} else {
			task.replans.push({
				errorClass,
				errorMessage: errorMsg,
				replanCount: 1,
				lastReplanAt: new Date().toISOString(),
				correctionStrategy: this._getCorrectionStrategy(errorClass),
			});
		}

		this._consecutiveErrors = 0;
		const strategy = this._getCorrectionStrategy(errorClass);
		this._scratchpadService.append('replan', `Replanning after ${errorClass}: ${strategy}`, 5);
		this._logAction(task, { type: 'status_update', summary: `Replanning: ${strategy}` });
	}

	private _getCorrectionStrategy(errorClass: string): string {
		const strategies: Record<string, string> = {
			timeout: 'Break the operation into smaller steps or use a shorter command',
			permission: 'Check file permissions or try an alternative approach',
			not_found: 'Verify the file/path exists before proceeding',
			rate_limit: 'Reduce request frequency and retry',
			parse_error: 'Review the output format and adjust parsing logic',
			unknown: 'Try a different approach to accomplish the goal',
		};
		return strategies[errorClass] ?? strategies.unknown;
	}

	private async _decomposeTaskAsync(task: AgentTask, goal: string): Promise<void> {
		try {
			const context = await this.getContextSummaryAsync();
			const result = await this._taskDecomposer.decompose(goal, context);
			task.subtasks = result.subtasks;
			task.complexity = result.complexity;
			// Upgrade iteration budget based on actual decomposed complexity
			task.maxIterations = Math.max(
				task.maxIterations,
				AGENT_ITERATION_BUDGET[result.complexity]
			);
			this._scratchpadService.append(
				'decision',
				`Decomposed into ${result.subtasks.length} subtasks (${result.complexity}): ${result.reasoning}`,
				4
			);
			this._emitEvent('task_updated', task.id, { subtaskCount: result.subtasks.length });
		} catch {
			// Decomposition is best-effort — agent continues even without it
		}
	}
}


registerSingleton(INeuralInverseAgentService, NeuralInverseAgentService, InstantiationType.Eager);
