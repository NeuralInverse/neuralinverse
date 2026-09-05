/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Agent Executor
 *
 * Runs a single workflow step: one agent definition through a full LLM + tool loop.
 *
 * ## Independence from Void Chat
 *
 * The executor calls ILLMMessageService directly. It has no dependency on
 * IChatThreadService, chatMode settings, or the sidebar. It is a pure
 * execution unit driven by the WorkflowOrchestrator.
 *
 * ## Execution Loop
 *
 * 1. Build system prompt (agent instructions + tool schemas + prior context)
 * 2. Send user input to LLM
 * 3. Parse tool calls from response
 * 4. Execute each tool via ScopedToolRegistry
 * 5. Append tool result as next user message
 * 6. Loop until no tool calls or maxIterations reached
 * 7. Write final output to IStepRun
 */

import { ILLMMessageService } from '../../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../../../void/common/voidSettingsService.js';
import { ModelSelection } from '../../../void/common/voidSettingsTypes.js';
import { LLMChatMessage } from '../../../void/common/sendLLMMessageTypes.js';
import { getModelCapabilities } from '../../../void/common/modelCapabilities.js';
import { CompactableMessage, ConversationCompactor, capToolResultForHistory, createInactivityWatchdog, renderConversationSummaryMessage } from '../../../void/browser/conversationCompactor.js';
import { IContextLedgerService } from '../../../void/browser/contextLedgerService.js';
import { EpisodeSummarizer } from '../../../void/browser/episodeSummarizer.js';
import { ILedgerAppendInput, ILedgerEntry } from '../../../void/common/ledgerTypes.js';
import { DEFAULT_LEDGER_POLICY } from '../../../void/common/ledgerPolicy.js';
import { buildWorkingBrief } from '../../../void/common/workingBriefBuilder.js';
import { resolveCloseBoundary, noteBoundaryMissed, resetBoundaryMissTelemetry } from '../../../void/common/ledgerBoundary.js';
import { IAgentDefinition, IWorkflowStep, IStepRun, IToolCallRecord, IToolExecutionContext, IStepToolCacheConfig } from '../../common/workflowTypes.js';
import { ScopedToolRegistry } from '../tools/toolRegistry.js';
import { parseToolCalls, stripToolCallBlocks } from './toolCallParser.js';
import { IContextPackerService, ContextMode } from '../context/packer/index.js';
import { ToolResultCache } from './toolCache.js';
import { BudgetTracker } from './budgetTracker.js';

const DEFAULT_MAX_ITERATIONS = 20;

/** Retries (on top of the first attempt) when the LLM returns an empty response */
const MAX_EMPTY_RESPONSE_RETRIES = 2;

/** A provider stream that emits no chunks for this long is treated as dead and aborted. */
const LLM_STALL_MS = 180_000; // 3 minutes

/**
 * Appended to the working-brief message when the ledger path rebuilds the
 * history, so the model knows older turns were archived, not deleted.
 */
const LEDGER_BRIEF_TRAILER = '\n\n(Working memory above summarizes the earlier archived conversation — nothing was lost. The most recent messages follow.)';

export interface IPriorStepOutput {
	stepId: string;
	role: string;
	output: string;
}

export interface ICancellationToken {
	cancelled: boolean;
}

/**
 * Executes a single agent step. Stateless — all state is written into IStepRun.
 */
export class AgentExecutor {

	/** Set at the start of each execute() call from the agent definition */
	private _modelSelection: ModelSelection | undefined;

	/** Lazy — needs the constructor-injected llmService */
	private _compactorInstance: ConversationCompactor | undefined;
	private _compactor(): ConversationCompactor {
		if (!this._compactorInstance) this._compactorInstance = new ConversationCompactor(this.llmService)
		return this._compactorInstance
	}

	// ─── Context Ledger (task M5, phase 5) ───────────────────────────────
	// Flag ON: every message pushed into `history` is also journaled
	// append-only, and compaction folds the aged prefix into immutable
	// episodes + a deterministic working brief — nothing is ever dropped.
	// Flag OFF: the ConversationCompactor path stays byte-identical to today.
	private _ledgerWarned = false;

	constructor(
		private readonly llmService: ILLMMessageService,
		private readonly settingsService: IVoidSettingsService,
		private readonly scopedTools: ScopedToolRegistry,
		private readonly contextPacker?: IContextPackerService,
		private readonly toolCache?: ToolResultCache,
		private readonly cacheConfig?: IStepToolCacheConfig,
		private readonly budgetTracker?: BudgetTracker,
		// Optional + decorated on purpose: the executor is `new`ed positionally
		// by WorkflowOrchestrator (and tests), so a required param would break
		// those call sites; created through the instantiation service the
		// decorator injects it. Without a ledger service the ledger path stays
		// off and the legacy compactor keeps running, exactly as before.
		@IContextLedgerService private readonly contextLedgerService?: IContextLedgerService,
	) {}

	/** Flag ON and a ledger service is wired in; otherwise the legacy compactor owns the path. */
	private _ledgerEnabled(): boolean {
		return !!this.contextLedgerService && this.settingsService.state.globalSettings.contextLedgerEnabled;
	}

	private _warnLedgerOnce(): void {
		if (this._ledgerWarned) return;
		this._ledgerWarned = true;
		console.warn('[AgentExecutor] context ledger degraded — using legacy compaction; the step continues unaffected');
	}

	/** Fire-and-forget journal append; a ledger failure warns once and never blocks the loop. */
	private _journal(threadId: string, input: ILedgerAppendInput): void {
		const ledger = this.contextLedgerService;
		if (!ledger) return;
		ledger.append(threadId, input).catch(() => this._warnLedgerOnce());
	}

	/**
	 * Run the agent loop for one step.
	 * Mutates stepRun in place with live output, tool calls, and final result.
	 */
	async execute(
		agent: IAgentDefinition,
		step: IWorkflowStep,
		stepRun: IStepRun,
		priorOutputs: IPriorStepOutput[],
		ctx: IToolExecutionContext,
		input: string,
		cancellation: ICancellationToken,
		priorConversation: LLMChatMessage[] = [],
	): Promise<void> {
		// Resolve model selection: prefer agent's own model, fall back to global Chat model.
		// agent.model stores providerName as plain string (JSON), so cast to ModelSelection.
		this._modelSelection = agent.model
			? (agent.model as unknown as ModelSelection)
			: (this.settingsService.state.modelSelectionOfFeature['Chat'] ?? undefined);

		stepRun.status = 'running';
		stepRun.startedAt = Date.now();
		stepRun.iterationsUsed = 0;

		const maxIterations = step.maxIterations ?? DEFAULT_MAX_ITERATIONS;
		const history: LLMChatMessage[] = [];

		// Context Ledger conversation key (task M5 phase 5): the executor runs
		// exactly one agent and is re-created per step attempt, so the durable
		// conversation is keyed by the agent, not by run/step — journal,
		// episodes and brief persist across every run of this agent. Concurrent
		// runs of the same agent therefore share one archive; the Agents-tab
		// conversation memory is keyed per conversationId in
		// WorkflowAgentService instead.
		const ledgerThreadId = 'exec:' + agent.id;

		// ── System prompt (with optional context pre-injection) ─────────────
		const toolSchemas = this.scopedTools.getSchema();
		const contextConfig = step.contextConfig;
		let workspaceContext = '';

		if (this.contextPacker && (!contextConfig || !contextConfig.disableAutoContext)) {
			try {
				const mode = (contextConfig?.mode ?? 'agent') as ContextMode;
				const budget = contextConfig?.budget ?? this.contextPacker.getDefaultBudget(mode);
				workspaceContext = await this.contextPacker.packToString({
					mode,
					query: { type: 'message', text: input },
					budget,
					includeActiveFile: contextConfig?.includeActiveFile ?? true,
					priorityFiles: contextConfig?.priorityFiles,
				});
			} catch {
				// Context packing is best-effort; don't fail the step
			}
		}

		const systemPrompt = this._buildSystemPrompt(agent, toolSchemas, priorOutputs, workspaceContext);
		history.push({ role: 'system', content: systemPrompt });
		// Journal the system prompt once per run (role 'system').
		if (this._ledgerEnabled()) {
			this._journal(ledgerThreadId, { role: 'system', content: systemPrompt });
		}

		// ── Prior conversation (multi-turn agent chat) ────────────────────────
		// Ad-hoc agent runs from the Agents tab pass the ongoing conversation so
		// follow-up messages keep their context. Workflow runs pass [] (steps get
		// context via priorOutputs instead).
		history.push(...priorConversation);
		if (this._ledgerEnabled()) {
			for (const m of priorConversation) {
				const role = (m as { role: string }).role;
				this._journal(ledgerThreadId, {
					role: role === 'assistant' ? 'assistant' : role === 'system' ? 'system' : 'user',
					content: _extractMessageText(m),
				});
			}
		}

		// ── Initial user message ───────────────────────────────────────────────
		history.push({ role: 'user', content: input });
		if (this._ledgerEnabled()) {
			this._journal(ledgerThreadId, { role: 'user', content: input });
		}

		// ── Budget tracker: begin step ────────────────────────────────────────
		if (this.budgetTracker) {
			this.budgetTracker.beginStep(agent.model?.modelName);
		}

		// ── LLM + tool loop ────────────────────────────────────────────────────
		while (stepRun.iterationsUsed < maxIterations) {
			if (cancellation.cancelled) {
				stepRun.status = 'failed';
				stepRun.error = 'Cancelled';
				break;
			}

			stepRun.iterationsUsed++;
			ctx.log(`[${step.id}] iteration ${stepRun.iterationsUsed}/${maxIterations}`);

			// Estimate input tokens for budget tracking.
			// LLMChatMessage is a union (Anthropic/OpenAI/Gemini); extract text safely.
			const inputText = history.map(m => _extractMessageText(m)).join('');

			// Pre-send context management: fold the aged part of the running
			// conversation into a summarized message when it approaches the
			// model's context window (tool outputs grow the history fast).
			await this._compactHistoryIfNeeded(history, ctx, step, agent);

			let responseText: string | null = null;
			try {
				// An empty response is usually transient (proxy hiccup, dropped
				// stream) — retry instead of finishing the step with no output,
				// which the UI renders as a bare "(done)".
				for (let attempt = 0; attempt <= MAX_EMPTY_RESPONSE_RETRIES; attempt++) {
					const t = await this._callLLM(history);
					if (t && t.trim()) { responseText = t; break; }
					ctx.log(`[${step.id}] empty LLM response (attempt ${attempt + 1}/${MAX_EMPTY_RESPONSE_RETRIES + 1})`);
				}
			} catch (e: any) {
				stepRun.status = 'failed';
				stepRun.error = `LLM error: ${e.message}`;
				stepRun.endedAt = Date.now();
				return;
			}
			if (responseText === null) {
				stepRun.status = 'failed';
				stepRun.error = `LLM returned an empty response after ${MAX_EMPTY_RESPONSE_RETRIES + 1} attempts`;
				stepRun.endedAt = Date.now();
				return;
			}

			// ── Budget check ──────────────────────────────────────────────────
			if (this.budgetTracker) {
				const budgetResult = this.budgetTracker.recordUsage(inputText, responseText);
				const stepUsage = this.budgetTracker.getStepUsage();
				stepRun.tokenUsage = { inputTokens: stepUsage.inputTokens, outputTokens: stepUsage.outputTokens };

				if (!budgetResult.withinBudget) {
					ctx.log(`[${step.id}] budget exceeded — ${budgetResult.reason}`);
					// onExceeded='warn' logs and continues; 'fail' (default) aborts the step
					if (this.budgetTracker.onExceeded !== 'warn') {
						stepRun.status = 'failed';
						stepRun.error = `Budget exceeded: ${budgetResult.reason}`;
						stepRun.endedAt = Date.now();
						return;
					}
				}
			}

			history.push({ role: 'assistant', content: responseText });
			if (this._ledgerEnabled()) {
				this._journal(ledgerThreadId, { role: 'assistant', content: responseText });
			}
			stepRun.outputLog.push(responseText);

			// ── Parse tool calls ─────────────────────────────────────────────
			const toolCalls = parseToolCalls(responseText);

			if (toolCalls.length === 0) {
				// No tool calls — agent is done
				stepRun.finalOutput = stripToolCallBlocks(responseText) || responseText;
				stepRun.status = 'done';
				stepRun.endedAt = Date.now();
				return;
			}

			// ── Execute tool calls ───────────────────────────────────────────
			const useParallel = step.parallelTools === true && toolCalls.length > 1;
			const toolResultParts: string[] = new Array(toolCalls.length).fill('');

			if (useParallel) {
				// Parallel execution with concurrency cap
				const maxConcurrent = step.maxParallelToolCalls ?? 5;
				await this._executeToolsParallel(toolCalls, toolResultParts, stepRun, step, ctx, cancellation, maxConcurrent);
			} else {
				// Sequential execution (default)
				for (let i = 0; i < toolCalls.length; i++) {
					if (cancellation.cancelled) break;
					toolResultParts[i] = await this._executeSingleTool(toolCalls[i], stepRun, step, ctx);
				}
			}

			// Feed results back as user message for next iteration.
			// Each result is capped so one huge tool output (file dump, build log)
			// can't crowd out everything else in later iterations.
			history.push({ role: 'user', content: toolResultParts.map(p => capToolResultForHistory(p)).join('\n\n') });
			if (this._ledgerEnabled()) {
				// Journal each tool result as its own 'tool' entry. The ledger
				// stores the full uncapped output — capToolResultForHistory bounds
				// only the send path; archiving must never lose bytes. exitCode is
				// best-effort from the run records just written (success → 0,
				// failure → 1; skipped when the record is missing or cancelled).
				const records = stepRun.toolCalls.slice(-toolCalls.length);
				for (let i = 0; i < toolCalls.length; i++) {
					const part = toolResultParts[i];
					if (!part) continue; // cancelled before this call ran
					const record = records[i];
					this._journal(ledgerThreadId, {
						role: 'tool',
						name: toolCalls[i].tool,
						content: part,
						meta: record && record.toolName === toolCalls[i].tool
							? { exitCode: record.result.success ? 0 : 1 }
							: undefined,
					});
				}
			}
		}

		// Max iterations hit
		if (stepRun.status === 'running') {
			stepRun.status = 'failed';
			stepRun.error = `Reached max iterations (${maxIterations}) without completing`;
			stepRun.endedAt = Date.now();
		}
	}

	// ─── Tool Execution ───────────────────────────────────────────────────────

	private async _executeSingleTool(
		call: import('./toolCallParser.js').IParsedToolCall,
		stepRun: IStepRun,
		step: IWorkflowStep,
		ctx: IToolExecutionContext,
	): Promise<string> {
		const tool = this.scopedTools.get(call.tool);
		const callStart = Date.now();

		if (!tool) {
			const record: IToolCallRecord = {
				toolName: call.tool,
				args: call.args,
				result: { success: false, output: '', error: `Tool "${call.tool}" is not available in this step` },
				executedAt: callStart,
				durationMs: 0,
			};
			stepRun.toolCalls.push(record);
			ctx.log(`[${step.id}] tool "${call.tool}" — not available`);
			return `Tool "${call.tool}" error: not available`;
		}

		// ── Cache check ───────────────────────────────────────────────────────
		if (this.toolCache && this.cacheConfig?.enabled) {
			const cacheableTools = this.cacheConfig.cacheableTools;
			const isCacheable = !cacheableTools || cacheableTools.length === 0 || cacheableTools.includes(call.tool);
			if (isCacheable) {
				const cacheKey = this.toolCache.key(call.tool, call.args);
				const cached = this.toolCache.get(cacheKey, this.cacheConfig.ttlMs);
				if (cached) {
					const record: IToolCallRecord = {
						toolName: call.tool,
						args: call.args,
						result: cached,
						executedAt: callStart,
						durationMs: 0,
					};
					stepRun.toolCalls.push(record);
					ctx.log(`[${step.id}] tool "${call.tool}" ✓ (cached)`);
					return `Tool "${call.tool}" result:\n${cached.output}`;
				}
			}
		}

		ctx.log(`[${step.id}] calling tool: ${call.tool}(${JSON.stringify(call.args)})`);
		const result = await tool.execute(call.args, ctx);
		const durationMs = Date.now() - callStart;

		const record: IToolCallRecord = {
			toolName: call.tool,
			args: call.args,
			result,
			executedAt: callStart,
			durationMs,
		};
		stepRun.toolCalls.push(record);

		// Cache successful results
		if (this.toolCache && this.cacheConfig?.enabled && result.success) {
			const cacheKey = this.toolCache.key(call.tool, call.args);
			this.toolCache.set(cacheKey, result);
		}

		if (result.success) {
			ctx.log(`[${step.id}] tool "${call.tool}" ✓ (${durationMs}ms)`);
			return `Tool "${call.tool}" result:\n${result.output}`;
		} else {
			ctx.log(`[${step.id}] tool "${call.tool}" ✗ — ${result.error}`);
			return `Tool "${call.tool}" error: ${result.error}`;
		}
	}

	private async _executeToolsParallel(
		calls: import('./toolCallParser.js').IParsedToolCall[],
		results: string[],
		stepRun: IStepRun,
		step: IWorkflowStep,
		ctx: IToolExecutionContext,
		cancellation: ICancellationToken,
		maxConcurrent: number,
	): Promise<void> {
		// Pool-of-promises: dispatch up to maxConcurrent, race for completion
		const pending = new Set<Promise<void>>();
		let idx = 0;

		const dispatch = (i: number) => {
			const p = this._executeSingleTool(calls[i], stepRun, step, ctx)
				.then(r => { results[i] = r; })
				.catch(e => { results[i] = `Tool "${calls[i].tool}" error: ${e.message}`; })
				.finally(() => pending.delete(p));
			pending.add(p);
		};

		while (idx < calls.length || pending.size > 0) {
			if (cancellation.cancelled) break;

			while (pending.size < maxConcurrent && idx < calls.length) {
				dispatch(idx++);
			}

			if (pending.size > 0) await Promise.race(pending);
		}
	}

	// ─── LLM Call ─────────────────────────────────────────────────────────────

	private _callLLM(messages: LLMChatMessage[], _ctx?: IToolExecutionContext): Promise<string> {
		return new Promise((resolve, reject) => {
			const modelSelection = this._modelSelection ?? this.settingsService.state.modelSelectionOfFeature['Chat'];
			if (!modelSelection) {
				reject(new Error('No model selected. Configure a model in Void settings or set one on the agent.'));
				return;
			}

			// Providers disagree on where the system prompt may live. The executor
			// keeps it as messages[0]; move it where the provider expects it:
			// - anthropic/bedrock/gemini: separate `system`/`systemInstruction` param
			//   (a system role inside `messages` is rejected by the API)
			// - gemini: messages must use `parts` instead of `content`
			// - openai-compatible: native system role inside `messages` works
			const providerName = modelSelection.providerName;
			let requestMessages = messages;
			let separateSystemMessage: string | undefined;
			const first = messages[0] as { role?: string; content?: unknown } | undefined;
			if (first && first.role === 'system' && typeof first.content === 'string') {
				if (providerName === 'anthropic' || providerName === 'awsBedrock' || providerName === 'gemini') {
					separateSystemMessage = first.content;
					requestMessages = messages.slice(1);
				}
			}
			if (providerName === 'gemini') {
				requestMessages = requestMessages.map((m): LLMChatMessage => {
					const role = (m as { role: string }).role;
					return { role: role === 'assistant' ? 'model' as const : 'user' as const, parts: [{ text: _extractMessageText(m) }] } as LLMChatMessage;
				});
			}

			let stalled = false;
			let cancelToken: string | null = null;
			// Abort streams that stop emitting chunks entirely, so a dead
			// connection can't hang the step forever.
			const watchdog = createInactivityWatchdog(LLM_STALL_MS, () => {
				stalled = true;
				if (cancelToken) this.llmService.abort(cancelToken);
			});

			cancelToken = this.llmService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: requestMessages,
				modelSelection,
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				separateSystemMessage,
				// The executor manages its own tool protocol (JSON blocks +
				// ScopedToolRegistry) and advertises it in the system prompt.
				// chatMode 'agent' made the Void layer inject a second,
				// unrelated tool catalog (filtered builtins + all MCP tools),
				// so models saw contradictory tool lists and called tools that
				// exist in neither world coherently. null = no layer tools.
				chatMode: null,
				onText: () => { watchdog.reset(); },
				onFinalMessage: (p) => { watchdog.dispose(); resolve(p.fullText); },
				onError: (p) => { watchdog.dispose(); reject(new Error(p.message || p.fullError?.message || 'LLM error')); },
				onAbort: () => {
					watchdog.dispose();
					reject(new Error(stalled
						? `LLM stream stalled — no data received for over ${Math.round(LLM_STALL_MS / 60_000)} minutes`
						: 'LLM call aborted'));
				},
				logging: { loggingName: 'WorkflowAgent' },
				allowedToolNames: [],
			});

			// sendLLMMessage already invoked onError synchronously when returning null
			if (!cancelToken) watchdog.dispose();
		});
	}

	// ─── History Compaction ───────────────────────────────────────────────────

	/**
	 * Fold the aged part of the running history (everything after the system
	 * message) into one summarized user message when it approaches the model's
	 * context window. Mutates `history` in place. Best-effort: on any failure
	 * the history is left untouched.
	 */
	private async _compactHistoryIfNeeded(history: LLMChatMessage[], ctx: IToolExecutionContext, step: IWorkflowStep, agent: IAgentDefinition): Promise<void> {
		// Flag ON: the ledger flow below owns compaction (including the
		// decided-nothing case) and the legacy compactor is never reached.
		// Only a ledger PROBLEM falls back to it — a ledger failure must
		// never fail a step.
		if (this._ledgerEnabled()) {
			try {
				await this._compactHistoryViaLedger(history, ctx, step, agent);
				return;
			} catch {
				this._warnLedgerOnce();
				// fall through to the legacy compactor
			}
		}

		const modelSelection = this._modelSelection;
		if (!modelSelection || history.length < 8) return;

		let contextWindow: number | undefined;
		try {
			const { overridesOfModel } = this.settingsService.state;
			contextWindow = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel).contextWindow;
		} catch {
			return;
		}
		if (!contextWindow) return;

		// history[0] is the system prompt — never compact it.
		const systemMessage = history[0];
		const compactables: CompactableMessage[] = [];
		for (let i = 1; i < history.length; i++) {
			const m = history[i];
			const role = (m as { role: string }).role;
			compactables.push({ role: role === 'assistant' ? 'assistant' : 'user', content: _extractMessageText(m) });
		}

		let result;
		try {
			result = await this._compactor().compactIfNeeded({
				messages: compactables,
				contextWindow,
				modelSelection,
			});
		} catch {
			return;
		}
		if (!result.summary || result.keepFromIdx <= 0) return;

		ctx.log(`[${step.id}] compacting conversation: ~${result.tokensBefore} → ~${result.tokensAfter} est. tokens (llm summary: ${result.usedLLM})`);
		const kept = history.slice(1 + result.keepFromIdx);
		history.length = 0;
		// NOT journaled: this is the legacy (flag-off) or fallback rebuild —
		// every kept message was already journaled at its original push site,
		// and re-journaling the summary would duplicate journal content.
		history.push(systemMessage, { role: 'user', content: renderConversationSummaryMessage(result.summary) }, ...kept);
	}

	/**
	 * Context Ledger compaction (task M5 phase 5). Closes an episode once the
	 * unsummarized journal crosses the policy target, freezes it, rebuilds the
	 * deterministic working brief, then rebuilds the LOCAL `history` for
	 * sending as [system, brief, verbatim tail]. The ledger keeps every entry,
	 * so nothing is lost. Best-effort inside: callers wrap it so any failure
	 * falls back to the legacy compactor. The boundary search is shared with
	 * the chat path (M6 item 1): common/ledgerBoundary.resolveCloseBoundary.
	 */
	private async _compactHistoryViaLedger(history: LLMChatMessage[], ctx: IToolExecutionContext, step: IWorkflowStep, agent: IAgentDefinition): Promise<void> {
		const ledger = this.contextLedgerService;
		const modelSelection = this._modelSelection;
		if (!ledger || !modelSelection) return;
		const threadId = 'exec:' + agent.id;

		// 1. journal stats drive the boundary decision, not the local array —
		//    the journal accumulates across every run of this agent.
		const stats = await ledger.stats(threadId);
		if (!stats || stats.entryCount === 0) return;
		const episodes = await ledger.listEpisodes(threadId);
		// the smallest tail window answers decideBoundary's tail-size check;
		// resolveCloseBoundary grows the window itself when a boundary is due
		const tailProbe = await ledger.readTail(threadId, DEFAULT_LEDGER_POLICY.tailMinMessages + 4);
		if (tailProbe.length === 0) return;
		// 2. no idle signal in the executor (it compacts mid-run, never idle);
		// there is no force/overflow signal to honor today either — a future
		// context-overflow recovery would pass { force: true } here.
		const decision = EpisodeSummarizer.decideBoundary(stats, tailProbe.length, 0, DEFAULT_LEDGER_POLICY);
		if (!decision || !decision.close) return;

		const fromSeq = episodes.reduce((m, ep) => Math.max(m, ep.range.toSeq), 0) + 1;
		// shared growing-window boundary search — a tool-heavy turn no longer
		// silently skips the close (M6 item 1)
		const boundary = await resolveCloseBoundary(fromSeq, DEFAULT_LEDGER_POLICY, n => ledger.readTail(threadId, n));
		if (boundary.kind !== 'close' || !boundary.window) {
			const reason = boundary.kind === 'deferred' ? boundary.reason : 'no boundary window';
			noteBoundaryMissed(threadId, reason ?? 'no safe episode boundary');
			ctx.log(`[${step.id}] ledger boundary missed: ${reason ?? 'no safe episode boundary'}`);
			return;
		}
		const toSeq = boundary.toSeq!;
		// 3. freeze the episode and rebuild the brief from all episodes
		const entries = await ledger.readRange(threadId, fromSeq, toSeq);
		if (entries.length === 0) {
			noteBoundaryMissed(threadId, `boundary seq ${boundary.boundarySeq} selected an empty episode range ${fromSeq}-${toSeq}`);
			return;
		}
		const episode = await new EpisodeSummarizer(this.llmService).summarizeEpisode({
			threadId,
			ordinal: episodes.length + 1,
			entries,
			range: { fromSeq, toSeq },
			modelSelection,
		});
		await ledger.saveEpisode(episode);
		const brief = buildWorkingBrief({
			threadId,
			previousBrief: await ledger.getBrief(threadId),
			episodes: await ledger.listEpisodes(threadId),
			lastSeq: stats.lastSeq,
			policy: DEFAULT_LEDGER_POLICY,
		});
		await ledger.saveBrief(brief);
		resetBoundaryMissTelemetry(threadId);

		ctx.log(`[${step.id}] ledger episode ${episode.ordinal} frozen (${decision.reason}): seq ${fromSeq}-${toSeq}, brief revision ${brief.revision} (~${brief.tokens} tokens)`);

		// 4. rebuild the LOCAL history for sending. The ledger keeps
		// everything — these pushes are NOT journaled: the brief summarizes
		// frozen episodes and the tail is read straight from the journal, so
		// every entry already lives there.
		const systemMessage = history[0];
		history.length = 0;
		history.push(
			systemMessage,
			{ role: 'user', content: brief.text + LEDGER_BRIEF_TRAILER },
			...boundary.window.slice(boundary.boundaryIdx!)
				.map(_ledgerEntryToChatMessage)
				.filter((m): m is LLMChatMessage => m !== undefined),
		);
	}

	// ─── System Prompt ────────────────────────────────────────────────────────

	private _buildSystemPrompt(
		agent: IAgentDefinition,
		toolSchemas: object[],
		priorOutputs: IPriorStepOutput[],
		workspaceContext?: string,
	): string {
		const parts: string[] = [];

		// Agent's own instructions
		parts.push(agent.systemInstructions.trim());

		// Pre-packed workspace context (from Context Engine)
		if (workspaceContext && workspaceContext.length > 0) {
			parts.push(`\n## Workspace Context\n\nThe following code context was automatically assembled based on relevance to your task. Use it to inform your work without needing to read these files manually.\n\n${workspaceContext}`);
		}

		// Tool usage instructions + schemas
		if (toolSchemas.length > 0) {
			parts.push(`\n## Tools\n\nYou have access to the following tools. To call a tool, emit a JSON code block:\n\n\`\`\`json\n{ "tool": "tool_name", "args": { "arg1": "value1" } }\`\`\`\n\nFor multiple calls in one turn:\n\n\`\`\`json\n[{ "tool": "...", "args": {...} }, { "tool": "...", "args": {...} }]\n\`\`\`\n\nWhen you have all the information you need and are done working, respond with a plain text summary — no JSON block.\n\n### Available Tools\n\n${JSON.stringify(toolSchemas, null, 2)}`);
		} else {
			parts.push('\n## Instructions\n\nRespond with a plain text answer. No tools are available for this step.');
		}

		// Prior step outputs injected as context
		if (priorOutputs.length > 0) {
			const ctx = priorOutputs
				.map(p => `### Output from step "${p.stepId}" (${p.role})\n\n${p.output}`)
				.join('\n\n');
			parts.push(`\n## Context from Prior Steps\n\n${ctx}`);
		}

		return parts.join('\n');
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract plain text from any LLMChatMessage variant for token estimation.
 * Anthropic/OpenAI messages have a `content` field; Gemini has `parts`.
 */
function _extractMessageText(msg: import('../../../void/common/sendLLMMessageTypes.js').LLMChatMessage): string {
	// Gemini messages use `parts` instead of `content`
	if ('parts' in msg) {
		return msg.parts
			.map(p => ('text' in p ? p.text : ''))
			.join('');
	}
	// Anthropic / OpenAI messages have `content`
	if ('content' in msg) {
		const content = (msg as { content: unknown }).content;
		if (typeof content === 'string') return content;
		if (Array.isArray(content)) {
			return content.map(c => {
				if (typeof c === 'object' && c !== null && 'text' in c) return (c as { text: string }).text;
				return '';
			}).join('');
		}
	}
	return '';
}

/**
 * Map one ledger tail entry back to an LLMChatMessage for sending. Tool
 * entries become user-formatted text (the executor protocol feeds tool
 * results back as user messages); their content already carries the
 * `Tool "…" result:` header from the push site and is re-capped here like
 * any other tool output on the send path. system/note entries map to
 * undefined — the system prompt is always history[0], never mid-array.
 */
function _ledgerEntryToChatMessage(entry: ILedgerEntry): LLMChatMessage | undefined {
	if (entry.role === 'assistant') return { role: 'assistant', content: entry.content };
	if (entry.role === 'user') return { role: 'user', content: entry.content };
	if (entry.role === 'tool') return { role: 'user', content: capToolResultForHistory(entry.content) };
	return undefined;
}
