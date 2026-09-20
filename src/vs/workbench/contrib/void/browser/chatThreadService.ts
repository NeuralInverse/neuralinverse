/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { advanceExplorationRounds, advanceFruitlessSearchRounds, countRepeatedReads, getAgentLoopReminder } from '../common/agentLoopProgress.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';

import { URI } from '../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { availableTools, chat_userMessageContent, isABuiltinToolName } from '../common/prompt/prompts.js';
import { AnthropicReasoning, getErrorMessage, RawToolCallObj, RawToolParamsObj } from '../common/sendLLMMessageTypes.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { FeatureName, ModelSelection, ModelSelectionOptions } from '../common/voidSettingsTypes.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { approvalTypeOfBuiltinToolName, BuiltinToolCallParams, ToolCallParams, ToolName, ToolResult } from '../common/toolsServiceTypes.js';
import { IToolsService } from './toolsService.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ILanguageFeaturesService } from '../../../../editor/common/services/languageFeatures.js';
import { ChatMessage, CheckpointEntry, CodespanLocationLink, ImageAttachment, StagingSelectionItem, ToolMessage } from '../common/chatThreadServiceTypes.js';
import { Position } from '../../../../editor/common/core/position.js';
import { IMetricsService } from '../common/metricsService.js';
import { shorten } from '../../../../base/common/labels.js';
import { IUserInputRequestService } from './userInputRequestService.js';
import { IVoidModelService } from '../common/voidModelService.js';
import { findLast, findLastIdx } from '../../../../base/common/arraysFind.js';
import { IEditCodeService } from './editCodeServiceInterface.js';
import { VoidFileSnapshot } from '../common/editCodeServiceTypes.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { truncate } from '../../../../base/common/strings.js';
import { THREAD_STORAGE_KEY } from '../common/storageKeys.js';
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js';
import { timeout } from '../../../../base/common/async.js';
import { deepClone } from '../../../../base/common/objects.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDirectoryStrService } from '../common/directoryStrService.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IMCPService } from '../common/mcpService.js';
import { IVoidInternalToolService } from './voidInternalToolService.js';
import { RawMCPToolCall } from '../common/mcpServiceTypes.js';
import { INeuralInverseAgentService } from './neuralInverseAgentService.js';
import { needsOSSEnhancement } from '../common/ossModelEnhancement/ossDetection.js';
import { shouldAutoRetry, getCorrectionMessage } from '../common/ossModelEnhancement/autoRetryCorrection.js';
import { wrapToolResultForOSS } from '../common/ossModelEnhancement/progressFeedbackLoop.js';
import { workspaceFilteredThreads } from '../common/chatThreadUtils.js';
import { getModelCapabilities } from '../common/modelCapabilities.js';
import { CompactableMessage, ConversationCompactor, isContextOverflowError, isRetryableLlmError, renderConversationSummaryMessage } from './conversationCompactor.js';
import { ChatRequestGuard } from '../common/chatRequestGuard.js';
import { IContextLedgerService } from './contextLedgerService.js';
import { ILedgerAppendInput, IContextUsageReport, IContextUsageSection } from '../common/ledgerTypes.js';
import { EpisodeSummarizer } from './episodeSummarizer.js';
import { buildWorkingBrief } from '../common/workingBriefBuilder.js';
import { assemble, briefPrefixOf } from '../common/contextAssembler.js';
import { DEFAULT_LEDGER_POLICY, estimateTokens, estimateTokensOf, finalSendBudget, rawFallbackDecision } from '../common/ledgerPolicy.js';
import { boundThreadsForStorage, THREAD_PERSIST_DEBOUNCE_MS, THREAD_PERSIST_MAX_NEW_ARCHIVES_PER_FLUSH, messageIsStubbed, type IBoundCache, type IStorableMessage, type IStorableThread } from '../common/threadStorageBound.js';
import { IThreadArchiveService } from './threadArchiveService.js';
import { mergeRestoredThreadMessages } from '../common/threadArchiveCore.js';
import { resolveCloseBoundary, noteBoundaryMissed, resetBoundaryMissTelemetry } from '../common/ledgerBoundary.js';
import { IPinnedContextService } from './pinnedContextService.js';
import { niTask1Obs, niTask1ObsPush } from '../../neuralInverse/browser/context/obs/task1Obs.js';


// Tool name aliases: OSS models use alternative names for built-in tools
// NOTE: edit_file, read_file are REAL built-in tools with different schemas — do NOT alias them
const TOOL_ALIASES: Record<string, string> = {
	'run': 'bash',
	'shell': 'bash',
	'execute': 'bash',
	'terminal': 'bash',
	'exec': 'bash',
	'create_file': 'write',
	'write_file': 'write',
	'save_file': 'write',
	'open_file': 'read',
	'view_file': 'read',
	'cat': 'read',
	'modify_file': 'edit',
	'replace': 'edit',
	'search_files': 'glob',
	'find_files': 'glob',
	'search': 'grep',
	'search_code': 'grep',
	'find': 'grep',
	'list_directory': 'list',
	'ls': 'list',
	'list_files': 'list',
	'list_dir': 'list',
};

function resolveToolAlias(name: string): string {
	return TOOL_ALIASES[name] || name;
}

// K-1 agent-turn termination caps (final-closure order 2026-09-17 §3) live in
// the pure agentTurnCaps module so tests can pin them without this file's
// browser-side DI import closure. Re-exported for convenience.
export {
	CHAT_RETRIES,
	RETRY_DELAY,
	LLM_STREAM_STALL_MS,
	LLM_STREAM_TOTAL_CAP_MS,
	ABORT_LOCAL_SETTLE_MS,
	MAX_AGENT_MESSAGES_SENT,
} from '../common/agentTurnCaps.js';
import {
	CHAT_RETRIES,
	RETRY_DELAY,
	LLM_STREAM_STALL_MS,
	LLM_STREAM_TOTAL_CAP_MS,
	ABORT_LOCAL_SETTLE_MS,
	MAX_AGENT_MESSAGES_SENT,
} from '../common/agentTurnCaps.js';

/** Compact token count for the ledger assembled log line: 0 / 41 / 38.2k / 1.84M. */
function fmtTokens(n: number): string {
	if (n === 0) { return '0'; }
	if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(2)}M`; }
	if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}k`; }
	return String(n);
}

/**
 * The pre-send over-budget stop (context-budget task): thrown when even the
 * shortest safe tail cannot fit the effective input ceiling after a forced
 * compaction. It escapes `_assembleLedgerThread`'s degradation catch on
 * purpose — the send path must stop BEFORE the request leaves, with an
 * actionable message, instead of shipping a payload the provider will reject.
 */
export class LedgerOverBudgetError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LedgerOverBudgetError';
	}
}


const findStagingSelectionIndex = (currentSelections: StagingSelectionItem[] | undefined, newSelection: StagingSelectionItem): number | null => {
	if (!currentSelections) { return null; }

	for (let i = 0; i < currentSelections.length; i += 1) {
		const s = currentSelections[i];

		if (s.uri.fsPath !== newSelection.uri.fsPath) { continue; }

		if (s.type === 'File' && newSelection.type === 'File') {
			return i;
		}
		if (s.type === 'CodeSelection' && newSelection.type === 'CodeSelection') {
			if (s.uri.fsPath !== newSelection.uri.fsPath) { continue; }
			// if there's any collision return true
			const [oldStart, oldEnd] = s.range;
			const [newStart, newEnd] = newSelection.range;
			if (oldStart !== newStart || oldEnd !== newEnd) { continue; }
			return i;
		}
		if (s.type === 'Folder' && newSelection.type === 'Folder') {
			return i;
		}
		if (s.type === 'Symbol' && newSelection.type === 'Symbol') {
			if (s.symbolName === newSelection.symbolName && s.uri.fsPath === newSelection.uri.fsPath) { return i; }
		}
	}
	return null;
};


/*

Store a checkpoint of all "before" files on each x.
x's show up before user messages and LLM edit tool calls.

x     A          (edited A -> A')
(... user modified changes ...)
User message

x     A' B C     (edited A'->A'', B->B', C->C')
LLM Edit
x
LLM Edit
x
LLM Edit


INVARIANT:
A checkpoint appears before every LLM message, and before every user message (before user really means directly after LLM is done).
*/



import { IChatThreadService, ThreadsState, ThreadStreamState, ThreadType, UserMessageState, WhenMounted, ChatThreads, IsRunningType } from './chatThreadServiceInterface.js';


const defaultMessageState: UserMessageState = {
	stagingSelections: [],
	isBeingEdited: false,
};

const newThreadObject = (workspaceUri?: string) => {
	const now = new Date().toISOString();
	return {
		id: generateUuid(),
		createdAt: now,
		lastModified: now,
		workspaceUri,
		messages: [],
		state: {
			currCheckpointIdx: null,
			stagingSelections: [],
			focusedMessageIdx: undefined,
			linksOfMessageIdx: {},
		},
		filesWithUserChanges: new Set()
	} satisfies ThreadType;
};

export class ChatThreadService extends Disposable implements IChatThreadService {
	_serviceBrand: undefined;

	// this fires when the current thread changes at all (a switch of currentThread, or a message added to it, etc)
	private readonly _onDidChangeCurrentThread = new Emitter<void>();
	readonly onDidChangeCurrentThread: Event<void> = this._onDidChangeCurrentThread.event;

	private readonly _onDidChangeStreamState = new Emitter<{ threadId: string }>();
	readonly onDidChangeStreamState: Event<{ threadId: string }> = this._onDidChangeStreamState.event;

	private readonly _onDidCompact = new Emitter<{ threadId: string; tokensBefore: number; tokensAfter: number; summary: string }>();
	readonly onDidCompact: Event<{ threadId: string; tokensBefore: number; tokensAfter: number; summary: string }> = this._onDidCompact.event;

	readonly streamState: ThreadStreamState = {};
	state: ThreadsState; // allThreads is the workspace-filtered view; _allThreads is the full store
	private _allThreads: ChatThreads = {}; // unfiltered store across all workspaces

	// agent-loop start per thread (absent when idle); read by abortRunning,
	// which runs outside the loop's scope. Keyed by threadId — two threads
	// can run loops concurrently and must not overwrite each other's start.
	private readonly _activeLoopStartMsByThread = new Map<string, number>();

	// used in checkpointing
	// private readonly _userModifiedFilesToCheckInCheckpoints = new LRUCache<string, null>(50)

	// Lazy reference to avoid cyclic DI (agentService -> chatThreadService -> agentService)
	private _agentService: INeuralInverseAgentService | null | undefined;
	private _getAgentService(): INeuralInverseAgentService | null {
		if (this._agentService === undefined) {
			try {
				this._agentService = this._instantiationService.invokeFunction(a => a.get(INeuralInverseAgentService));
			} catch {
				this._agentService = null;
			}
		}
		return this._agentService ?? null;
	}

	// Pre-send context compaction (opencode-style). Lazy because it needs the
	// constructor-injected _llmMessageService.
	private _compactor: ConversationCompactor | undefined;
	private _getCompactor(): ConversationCompactor {
		if (!this._compactor) { this._compactor = new ConversationCompactor(this._llmMessageService); }
		return this._compactor;
	}

	// ── Context Ledger (task M5) ─────────────────────────────────────────────
	// The ledger path (flag contextLedgerEnabled) journals every message
	// append-only, closes immutable episodes, and sends a deterministic
	// working brief instead of a rewritten rolling summary. The compactor
	// above stays as the exact legacy path for flag=off.
	// lazy like _compactor: needs the constructor-injected _llmMessageService
	private _ledgerSummarizer: EpisodeSummarizer | undefined;
	private _getLedgerSummarizer(): EpisodeSummarizer {
		if (!this._ledgerSummarizer) { this._ledgerSummarizer = new EpisodeSummarizer(this._llmMessageService); }
		return this._ledgerSummarizer;
	}
	/** last sent prefix per thread — feeds the D5 cache-stability check */
	private readonly _ledgerPrevPrefix = new Map<string, { revision: number; prefix: string }>();
	private readonly _ledgerEpisodeCloses = new Map<string, Promise<void>>();
	/** last assembler report per thread — consumed by the context gauge (C2) */
	private readonly _ledgerUsageReports = new Map<string, IContextUsageReport>();
	/** message objects already journaled this session (migration dedupe) */
	private readonly _journaledThisSession = new Map<string, Set<ChatMessage>>();
	/** real provider usage of the last final message per thread — feeds the journal + calibration (task M6 item 4) */
	private readonly _ledgerLastUsage = new Map<string, { input: number; output: number }>();
	/** accumulated REAL usage per thread; getSessionCost prefers it over estimates */
	private readonly _ledgerSessionUsage = new Map<string, { input: number; output: number }>();
	/** per-model calibration ratio estimated/actual input tokens (task M6 item 4) */
	private readonly _ledgerCalibration = new Map<string, { ratio: number; n: number }>();
	private _ledgerWarned = false;

	/** coalesced thread-store persistence (renderer-OOM fix, 2026-09-19) */
	private _pendingStoreThreads: ChatThreads | null = null;
	private _persistStoreTimer: ReturnType<typeof setTimeout> | null = null;
	private _storeFlushInFlight: Promise<void> | null = null;
	/** Prevent concurrent archive reads; failures remain retryable on reopen. */
	private readonly _rehydratingThreads = new Set<string>();
	/** per-thread bounding memo — unchanged threads cost zero re-serialization */
	private readonly _boundCache: IBoundCache = { entries: new Map() };
	/** per-thread SERIALIZED bounded shapes — the flush joins strings instead of re-stringifying the whole store */
	private readonly _boundedStrCache = new Map<string, { inputRef: object; str: string }>();
	/** startup parse cost of the persisted store (measured, observational) */
	private _lastLoadInfo: { ms: number; chars: number } | null = null;

	override dispose(): void {
		// a pending coalesced write must not die with the timer; on the
		// shutdown path only already-verified archives may back a stub (no IO
		// at dispose) — anything else stays verbatim in this last write
		if (this._persistStoreTimer !== null) {
			clearTimeout(this._persistStoreTimer);
			this._persistStoreTimer = null;
		}
		void this._flushPendingStoreThreads(true).catch(() => undefined);
		super.dispose();
	}

	private _ledgerEnabled(): boolean {
		return this._settingsService.state.globalSettings.contextLedgerEnabled;
	}

	private _warnLedgerOnce(): void {
		if (this._ledgerWarned) { return; }
		this._ledgerWarned = true;
		console.warn('[ChatThread] context ledger degraded — falling back where needed; conversation continues unaffected');
	}

	/** Map a stored ChatMessage to a journal append; null for non-conversational roles. */
	private _toLedgerInput(m: ChatMessage): ILedgerAppendInput | null {
		if (m.role === 'checkpoint') { return null; }
		if (m.role === 'interrupted_streaming_tool') { return null; }
		if (m.role === 'assistant') {
			const content = (m.displayContent || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
			if (!content) { return null; }
			return { role: 'assistant', content };
		}
		if (m.role === 'tool') { return { role: 'tool', content: m.content ?? '', name: m.name }; }
		if (m.role === 'user') { return { role: 'user', content: m.content ?? '' }; }
		return null;
	}

	/**
	 * Consecutive auto-retries per thread for OSS models that answer with prose
	 * where a tool call was expected. Previously stashed on `this` under a
	 * per-thread string key through an `any` cast, which hid it from the type
	 * system and leaked one property per thread for the life of the service.
	 */
	private readonly _ossRetryCountByThread = new Map<string, number>();

	private _journalMessage(threadId: string, m: ChatMessage): void {
		const input = this._toLedgerInput(m);
		if (!input) { return; }
		// Migration dedupe only (M6 item 5): the set exists solely while a
		// legacy thread's migration is still pending and is deleted once it
		// settles — it is never re-created, so it cannot pin every message
		// of the session in memory anymore.
		this._journaledThisSession.get(threadId)?.add(m);
		// Real provider usage of the reply this assistant message came from
		// (M6 item 4); consumed exactly once, right here.
		if (m.role === 'assistant') {
			const usage = this._ledgerLastUsage.get(threadId);
			if (usage) {
				this._ledgerLastUsage.delete(threadId);
				input.meta = { ...input.meta, usage: { ...usage } };
			}
		}
		this._contextLedgerService.append(threadId, input)
			.catch(() => this._warnLedgerOnce());
		// recall indexing no longer happens here: the ledger's onDidAppendEntry
		// event is the single feed for every writer (F02) — direct calls here
		// would double-index native/executor entries could never get.
	}

	/** Record real provider usage: last-usage side channel + session totals + per-model calibration (M6 item 4). */
	private _recordLedgerUsage(threadId: string, modelSelection: ModelSelection | null, usage: { input: number; output: number }): void {
		this._ledgerLastUsage.set(threadId, usage);
		const acc = this._ledgerSessionUsage.get(threadId) ?? { input: 0, output: 0 };
		acc.input += usage.input;
		acc.output += usage.output;
		this._ledgerSessionUsage.set(threadId, acc);
		const report = this._ledgerUsageReports.get(threadId);
		if (modelSelection && report && report.totalTokens > 0 && usage.input > 0) {
			const key = `${modelSelection.providerName}/${modelSelection.modelName}`;
			const sample = report.totalTokens / usage.input; // estimate / actual
			const prev = this._ledgerCalibration.get(key);
			this._ledgerCalibration.set(key, { ratio: (prev ? (prev.ratio * prev.n + sample) / (prev.n + 1) : sample), n: prev ? prev.n + 1 : 1 });
		}
	}

	/**
	 * Context Ledger send path (task M5 phase 2/4). Copy-only migration of
	 * legacy threads on first send, then budget-aware assembly
	 * (brief → tail). Never throws — falls back to the raw messages.
	 */

	/**
	 * Task1 B2-L4: fill assembler's recalledBlocks from LedgerRecallService
	 * via window.__niTask1Obs (observe-only binder). Never fabricates scores.
	 */
	private async _materializeLedgerRecall(threadId: string, rawMessages: ChatMessage[]): Promise<string[]> {
		try {
			const lastUser = [...rawMessages].reverse().find(m => m.role === 'user') as { displayContent?: string; content?: string } | undefined;
			const query = (lastUser?.displayContent || lastUser?.content || '').toString().trim();
			if (query.length < 8) { return []; }
			const obs = niTask1Obs();
			if (typeof obs.recall !== 'function') { return []; }
			const out = await obs.recall(query, { threadScope: 'all', limit: 3, currentThreadId: threadId }) as {
				ok?: boolean;
				results?: Array<{ kind?: string; threadId?: string; seqRange?: [number, number]; snippet?: string; score?: number; why?: string[]; id?: string }>;
			};
			const list = Array.isArray(out?.results) ? out.results : [];
			const blocks: string[] = [];
			for (const r of list.slice(0, 3)) {
				const snip = (r.snippet || '').toString().slice(0, 800);
				if (!snip) { continue; }
				const why = Array.isArray(r.why) ? r.why.join(',') : '';
				const seq = Array.isArray(r.seqRange) ? `${r.seqRange[0]}-${r.seqRange[1]}` : '';
				blocks.push(`[ledger_recall kind=${r.kind ?? '?'} thread=${r.threadId ?? ''} seq=${seq} score=${r.score ?? '?'} why=${why}]\n${snip}`);
			}
			return blocks;
		} catch {
			return [];
		}
	}

	private async _assembleLedgerThread(threadId: string, rawMessages: ChatMessage[], modelSelection: ModelSelection | null, force: boolean, overheadTokens?: number): Promise<ChatMessage[]> {
		if (!modelSelection || rawMessages.length === 0) { return rawMessages; }
		try {
			// copy-only migration: a legacy thread with stored history but an
			// empty journal gets its messages appended once. THREAD_STORAGE_KEY
			// is never touched — flag-off must reproduce today's exact behavior.
			const stats = await this._contextLedgerService.stats(threadId);
			if (!stats || stats.entryCount === 0) {
				const journaled = this._journaledThisSession.get(threadId);
				try {
					for (const m of rawMessages) {
						if (journaled?.has(m)) { continue; }
						const input = this._toLedgerInput(m);
						if (input) { await this._contextLedgerService.append(threadId, input); }
					}
				} finally {
					// M6 item 5: migration settled — the dedupe set has no further
					// job (the journal is non-empty now, or there was nothing to
					// journal) and must not hold message references for the rest
					// of the session.
					this._journaledThisSession.delete(threadId);
				}
			}

			// overflow recovery / manual compact: close an episode right now
			// (awaited — the retry depends on the folded prefix)
			// Await normal episode checkpoints before assembling as well: a
			// background close may not have finished when the next send begins.
			await this._closeEpisodeIfNeeded(threadId, modelSelection, force);

			const brief = await this._contextLedgerService.getBrief(threadId);
			const { compactables, raws } = this._toCompactables(rawMessages);
			const { overridesOfModel } = this._settingsService.state;
			const { contextWindow, reservedOutputTokenSpace } = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel);
			const pinnedBlocks = await this._pinnedContextService.materializePinnedBlocks();
			const autoContextBlocks = await this._materializeAutoContext(rawMessages);
			// Task1 B2-L4: previously recalledBlocks was never passed (empty recalled section).
			const recalledBlocks = await this._materializeLedgerRecall(threadId, rawMessages);
			const assembleAt = (shedLevel: 0 | 1 | 2 | 3) => assemble<ChatMessage>({
				raws,
				compactables,
				brief,
				pinnedBlocks,
				recalledBlocks,
				autoContextBlocks,
				contextWindow,
				reservedOutputTokenSpace,
				policy: DEFAULT_LEDGER_POLICY,
				prevPrefix: this._ledgerPrevPrefix.get(threadId) ?? null,
				shedLevel,
				// A3 (final closure): charge the MEASURED system+tools cost
				// against the input ceiling so this ladder decides against the
				// same budget `_finalSendBudgetError` enforces at the wire.
				// undefined (regular sends) keeps the flat system reserve.
				reservedOverheadTokens: overheadTokens,
			});
			let usedShedLevel: 0 | 1 | 2 | 3 = 0;
			let assembled = assembleAt(0);
			// "Never error" ladder: when even the shortest safe tail does not
			// fit, shed optional context progressively instead of stopping the
			// send — auto first (regenerable), then recalled, then pins, then the
			// brief. The first level that fits wins; if none fits, level 3's
			// minimal payload stays so the forced-compaction retry outside has
			// the best chance. Only a current request that alone exceeds the
			// window can still end in the honest stop.
			if (assembled.report.totalTokens > assembled.report.availableInputTokens) {
				for (const level of [1, 2, 3] as const) {
					assembled = assembleAt(level);
					usedShedLevel = level;
					if (assembled.report.totalTokens <= assembled.report.availableInputTokens) { break; }
				}
			}
			if (!assembled.report.cacheStable) {
				// D5 violation: same brief revision but a different prefix — the
				// provider prompt cache would be burned on every request
				console.warn('[ChatThread] ledger cache break: prefix changed without a brief revision bump');
			}
			if (brief !== null) { this._ledgerPrevPrefix.set(threadId, { revision: brief.revision, prefix: briefPrefixOf(brief) }); }
			this._ledgerUsageReports.set(threadId, assembled.report);

			// Task1 A3 obs — measured values only (never invent token counts for the runner)
			try {
				const sections = assembled.report.sections ?? [];
				const sectionMap = Object.fromEntries(sections.map(s => [s.name, s.tokens]));
				niTask1Obs()._setLastPayload({
					t: Date.now(),
					availableInputTokens: assembled.report.availableInputTokens,
					reservedOverheadTokens: overheadTokens,
					systemTokens: sectionMap['system'],
					toolTokens: sectionMap['tools'],
					messageTokens: assembled.report.totalTokens,
					shedLevel: usedShedLevel,
					compacted: force,
					fit: assembled.report.totalTokens <= assembled.report.availableInputTokens,
					contextWindow,
					raw: { sections: sectionMap, recalledBlocks: recalledBlocks.length, recalledPreview: recalledBlocks.map(b => String(b).slice(0, 280)), cacheStable: assembled.report.cacheStable },
				});
				niTask1ObsPush({
					kind: 'payload.assemble',
					tags: { threadId, force, recalled: recalledBlocks.length, shedLevel: usedShedLevel },
					data: {
						availableInputTokens: assembled.report.availableInputTokens,
						totalTokens: assembled.report.totalTokens,
						sections: sectionMap,
						recalledBlocks: recalledBlocks.length,
					},
				});
			} catch { /* observational only */ }

			// One honest line per send (M6 item 3): exact section sizes, the
			// revision, and total journal tokens so "payload is constant" is
			// measurable, not asserted. The printed sections always sum to
			// totalTokens (reserved-output is informational and excluded).
			const parts = assembled.report.sections
				.filter(s => s.name !== 'reserved-output')
				.map(s => `${s.name} ${fmtTokens(s.tokens)}`)
				.join(' + ');
			console.log(`[ChatThread] ledger assembled: ${parts} = ${fmtTokens(assembled.report.totalTokens)} / ${fmtTokens(assembled.report.availableInputTokens)} (rev ${brief?.revision ?? 0}, journal ${fmtTokens(stats?.totalTokens ?? 0)})`);

			// the assembled head (brief/pinned/recalled synthetics) maps to plain
			// user ChatMessages; the verbatim tail passes through untouched
			const tailLen = raws.length - assembled.keepFromIdx;
			const headMsgs = assembled.messages.slice(0, assembled.messages.length - tailLen);
			const head: ChatMessage[] = headMsgs.map(m => ({
				role: 'user' as const,
				content: (m as { content: string }).content,
				displayContent: '',
				selections: null,
				state: defaultMessageState,
			}));
			if (assembled.report.totalTokens > assembled.report.availableInputTokens) {
				// Pre-send over-budget handling: the assembler already folded to
				// the shortest safe tail and the request STILL cannot fit the
				// effective input ceiling. Before declaring it unsendable, run
				// the same forced-compaction recovery the provider-side overflow
				// path performs — moved ahead of the network roundtrip. A request
				// that fits after compaction must still send.
				if (!force) {
					const retry = await this._assembleLedgerThread(threadId, rawMessages, modelSelection, true, overheadTokens);
					const retryReport = this._ledgerUsageReports.get(threadId);
					if (!retryReport || retryReport.totalTokens <= retryReport.availableInputTokens) {
						return retry;
					}
					throw this._overBudgetError(retryReport);
				}
				throw this._overBudgetError(assembled.report);
			}
			return [...head, ...raws.slice(assembled.keepFromIdx)];
		} catch (err) {
			if (err instanceof LedgerOverBudgetError) { throw err; }
			this._warnLedgerOnce();
			// Degradation must not bypass the budget (A3): the raw fallback is
			// only allowed when the raw thread itself fits the effective input
			// ceiling. An over-budget raw thread stops the send with the same
			// actionable error the ledger path produces — never ships silently.
			try {
				const { contextWindow, reservedOutputTokenSpace } = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, this._settingsService.state.overridesOfModel);
				const { compactables } = this._toCompactables(rawMessages);
				const rawTokens = estimateTokensOf(compactables.map(c => c.content));
				const decision = rawFallbackDecision(rawTokens, contextWindow, reservedOutputTokenSpace);
				if (!decision.ok) {
					throw this._overBudgetError({
						totalTokens: rawTokens,
						availableInputTokens: decision.available,
						contextWindow,
						sections: [
							{ name: 'brief', tokens: 0 },
							{ name: 'pinned', tokens: 0 },
							{ name: 'recalled', tokens: 0 },
							{ name: 'notice', tokens: 0 },
							{ name: 'tail', tokens: rawTokens },
							{ name: 'reserved-output', tokens: contextWindow - decision.available },
						],
						cacheStable: true,
					});
				}
			} catch (guardErr) {
				if (guardErr instanceof LedgerOverBudgetError) { throw guardErr; }
				// the guard itself failed (no model caps?) — keep the historical
				// never-block-the-send behavior for this edge
			}
			return rawMessages;
		}
	}

	/**
	 * B4 auto-context (2026-09-15): relevance-ranked workspace files packed
	 * under their own token budget and injected as an origin-tagged block.
	 * Uses the project map (import graph + recency + name/semantic matches)
	 * via the shared relevance scorer — NOT the active editor — so the right
	 * file is found even with no editor open. Best-effort: any failure simply
	 * omits the block; the assembler caps it at policy.autoContextMaxTokens.
	 */
	private async _materializeAutoContext(rawMessages: ChatMessage[]): Promise<string[]> {
		try {
			if (!this._settingsService.state.globalSettings.autoContextEnabled) { return []; }
			// the query is the newest user message text
			let queryText = '';
			for (let i = rawMessages.length - 1; i >= 0; i--) {
				const m = rawMessages[i] as { role: string; message?: unknown };
				if (m.role === 'user') {
					const content = (m as { message?: { content?: unknown } }).message?.content;
					queryText = typeof content === 'string' ? content : '';
					break;
				}
			}
			if (queryText.trim().length === 0) { return []; }

			const { IRelevanceScorerService, IContextPackerService } = await import('../../neuralInverse/browser/context/contextModule.js');
			const scorer = this._instantiationService.invokeFunction(a => a.get(IRelevanceScorerService));
			const packer = this._instantiationService.invokeFunction(a => a.get(IContextPackerService));
			const scored = await scorer.scoreFilesAsync({ type: 'message', text: queryText }, 6);
			if (scored.length === 0) { return []; }
			const packed = await packer.packToString({
				query: { type: 'message', text: queryText },
				budget: DEFAULT_LEDGER_POLICY.autoContextMaxTokens,
				mode: 'chat',
			});
			if (packed.trim().length === 0) { return []; }
			return [packed];
		} catch {
			return []; // auto-context is best-effort — never block the send
		}
	}

	/**
	 * Final send-boundary budget check (A3): the last renderer-side checkpoint
	 * before the request leaves. The ledger path reserves a FLAT 10k for the
	 * system prompt + tool schemas; here the ACTUAL payload is measured —
	 * system message, every message, and the tool definitions as serialized —
	 * against window − output reserve. Catches: system+tools > 10k (many MCP
	 * tools), the legacy non-ledger path, unicode-heavy content the flat
	 * reserve never saw, and incompatible small-window configs.
	 * Returns an over-budget Error, or undefined when the send may proceed.
	 */
	private _finalSendBudgetError(params: {
		systemMessage: string | undefined;
		messages: unknown[];
		tools: unknown[];
		modelSelection: ModelSelection | null;
	}): Error | undefined {
		if (!params.modelSelection) { return undefined; }
		try {
			const { contextWindow, reservedOutputTokenSpace } = getModelCapabilities(
				params.modelSelection.providerName, params.modelSelection.modelName, this._settingsService.state.overridesOfModel);
			// Provider message shapes vary (string | parts[]); count the text
			// actually serialized — string content directly, part arrays per
			// text part. Images are tokenized provider-side and are an explicit
			// documented limitation of this estimate.
			const messageTokens = params.messages.reduce<number>((sum, m) => {
				const c = (m as { content?: unknown }).content;
				if (typeof c === 'string') { return sum + estimateTokens(c); }
				if (Array.isArray(c)) {
					for (const part of c) {
						const text = (part as { text?: unknown }).text;
						if (typeof text === 'string') { sum += estimateTokens(text); }
					}
				}
				return sum;
			}, 0);
			const toolTokens = params.tools.length > 0 ? estimateTokens(JSON.stringify(params.tools)) : 0;
			const systemTokens = params.systemMessage !== undefined ? estimateTokens(params.systemMessage) : 0;
			const budget = finalSendBudget({ systemTokens, messageTokens, toolTokens, contextWindow, reservedOutputTokenSpace });
			if (budget.ok) { return undefined; }
			return new LedgerOverBudgetError(localize(
				'ledger.finalOverBudget',
				"The request does not fit the model's context window as prepared: about {0} tokens (system {1}, messages {2}, tool definitions {3}) but only {4} are available for input. Disable some tools or reduce the pinned/selected context.",
				fmtTokens(budget.total), fmtTokens(systemTokens), fmtTokens(messageTokens), fmtTokens(toolTokens), fmtTokens(budget.ceiling),
			));
		} catch {
			return undefined; // caps unavailable — never block on the guard itself
		}
	}

	/** The actionable stop message for an unsendable request (over-budget stop). */
	private _overBudgetError(report: IContextUsageReport): LedgerOverBudgetError {
		const sectionTokens = (name: IContextUsageSection['name']): number =>
			report.sections.find(s => s.name === name)?.tokens ?? 0;
		return new LedgerOverBudgetError(localize(
			'ledger.overBudget',
			"The current turn still exceeds the model's context window after automatic context reduction: about {0} tokens, with {1} available for input (brief {2}, pinned {3}, current turn and recent history {4}). Use /compact to summarize earlier turns in this conversation. If the current message or its attachments alone exceed the budget, reduce or split them before retrying.",
			fmtTokens(report.totalTokens), fmtTokens(report.availableInputTokens),
			fmtTokens(sectionTokens('brief')), fmtTokens(sectionTokens('pinned')), fmtTokens(sectionTokens('tail')),
		));
	}

	/**
	 * Close an episode when the boundary policy says so (tokens / idle /
	 * force) and rebuild the working brief from all frozen episodes.
	 * Background-safe: callers may fire-and-forget; failures warn once.
	 * The boundary search itself is shared with the executor (M6 item 1):
	 * common/ledgerBoundary.resolveCloseBoundary.
	 */
	private async _closeEpisodeIfNeeded(threadId: string, modelSelection: ModelSelection | null, force: boolean): Promise<void> {
		// Serialize background and pre-send checkpoints so they cannot freeze
		// the same episode twice or overwrite a newer working brief.
		const previous = this._ledgerEpisodeCloses.get(threadId) ?? Promise.resolve();
		const pending = previous.then(() => this._performEpisodeClose(threadId, modelSelection, force));
		this._ledgerEpisodeCloses.set(threadId, pending);
		try {
			await pending;
		} finally {
			if (this._ledgerEpisodeCloses.get(threadId) === pending) {
				this._ledgerEpisodeCloses.delete(threadId);
			}
		}
	}

	private async _performEpisodeClose(threadId: string, modelSelection: ModelSelection | null, force: boolean): Promise<void> {
		if (!modelSelection) { return; }
		try {
			const stats = await this._contextLedgerService.stats(threadId);
			if (!stats || stats.entryCount === 0) { return; }
			const episodes = await this._contextLedgerService.listEpisodes(threadId);
			const idleMs = stats.lastEntryTs ? Date.now() - stats.lastEntryTs : 0;
			// the smallest tail window answers decideBoundary's tail-size check;
			// resolveCloseBoundary grows the window itself when a boundary is due
			const tailProbe = await this._contextLedgerService.readTail(threadId, DEFAULT_LEDGER_POLICY.tailMinMessages + 4);
			if (tailProbe.length === 0) { return; }
			const decision = EpisodeSummarizer.decideBoundary(stats, tailProbe.length, idleMs, DEFAULT_LEDGER_POLICY, { force });
			if (!decision || !decision.close) { return; }
			const fromSeq = episodes.reduce((m, ep) => Math.max(m, ep.range.toSeq), 0) + 1;
			// shared growing-window boundary search — a tool-heavy turn no longer
			// silently skips the close (M6 item 1); mid-turn checkpoints fold the
			// turn's early completed tool groups instead of waiting for a new
			// user message (virtual-1M milestone: the 100k-token single-turn case)
			const boundary = await resolveCloseBoundary(fromSeq, DEFAULT_LEDGER_POLICY, n => this._contextLedgerService.readTail(threadId, n), { allowMidTurn: true });
			if (boundary.kind !== 'close') {
				noteBoundaryMissed(threadId, boundary.reason ?? 'no safe episode boundary');
				return;
			}
			const toSeq = boundary.toSeq!;
			const entries = await this._contextLedgerService.readRange(threadId, fromSeq, toSeq);
			if (entries.length === 0) {
				noteBoundaryMissed(threadId, `boundary seq ${boundary.boundarySeq} selected an empty episode range ${fromSeq}-${toSeq}`);
				return;
			}
			const episode = await this._getLedgerSummarizer().summarizeEpisode({
				threadId,
				ordinal: episodes.length + 1,
				entries,
				range: { fromSeq, toSeq },
				modelSelection,
			});
			await this._contextLedgerService.saveEpisode(episode);
			// the frozen episode enters the recall index via the ledger's
			// onDidFreezeEpisode event (F02 single feed) — no direct call here
			const brief = buildWorkingBrief({
				threadId,
				previousBrief: await this._contextLedgerService.getBrief(threadId),
				episodes: [...episodes, episode],
				lastSeq: stats.lastSeq,
				policy: DEFAULT_LEDGER_POLICY,
			});
			await this._contextLedgerService.saveBrief(brief);
			// adopt the new revision cleanly on the next send; a successful
			// close also re-arms the boundary-miss warning (M6 item 1)
			this._ledgerPrevPrefix.delete(threadId);
			resetBoundaryMissTelemetry(threadId);
			console.log(`[ChatThread] ledger episode ${episode.ordinal} frozen (${decision.reason}): seq ${fromSeq}-${toSeq}, brief revision ${brief.revision} (~${brief.tokens} tokens)`);
			const foldedTokens = entries.reduce((sum, e) => sum + e.tokens, 0);
			this._onDidCompact.fire({ threadId, tokensBefore: foldedTokens, tokensAfter: brief.tokens, summary: episode.body.goal });
		} catch {
			this._warnLedgerOnce();
		}
	}

	/** Last assembler usage report for the context gauge (task C2). */
	getLedgerUsageReport(threadId: string): IContextUsageReport | undefined {
		return this._ledgerUsageReports.get(threadId);
	}

	/** REAL provider usage of the last completed reply in a thread (A3): the
	 *  gauge shows this next to the assembler ESTIMATE so drift between the
	 *  two is visible instead of the estimate posing as a measurement. */
	getLedgerLastUsage(threadId: string): { input: number; output: number } | undefined {
		return this._ledgerLastUsage.get(threadId);
	}

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@ILogService private readonly _logService: ILogService,
		@IVoidModelService private readonly _voidModelService: IVoidModelService,
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IToolsService private readonly _toolsService: IToolsService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@ILanguageFeaturesService private readonly _languageFeaturesService: ILanguageFeaturesService,
		@IMetricsService private readonly _metricsService: IMetricsService,
		@IEditCodeService private readonly _editCodeService: IEditCodeService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessagesService: IConvertToLLMMessageService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IDirectoryStrService private readonly _directoryStringService: IDirectoryStrService,
		@IFileService private readonly _fileService: IFileService,
		@IMCPService private readonly _mcpService: IMCPService,
		@IVoidInternalToolService private readonly _internalToolService: IVoidInternalToolService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IUserInputRequestService private readonly _userInputRequestService: IUserInputRequestService,
		@IContextLedgerService private readonly _contextLedgerService: IContextLedgerService,
		@IPinnedContextService private readonly _pinnedContextService: IPinnedContextService,
		@IThreadArchiveService private readonly _threadArchiveService: IThreadArchiveService,
	) {
		super();
		this.state = { allThreads: {}, currentThreadId: null as unknown as string }; // default state

		const readThreads = this._readAllThreads() || {};

		try {
			niTask1ObsPush({ kind: 'store.load', tags: {}, data: { ms: this._lastLoadInfo?.ms ?? 0, chars: this._lastLoadInfo?.chars ?? 0, threads: Object.keys(readThreads).length } });
		} catch { /* observational only */ }

		this._allThreads = readThreads;
		this.state = {
			allThreads: this._workspaceFilteredThreads(readThreads),
			currentThreadId: null as unknown as string, // gets set in startNewThread()
		};

		// always be in a thread
		this.openNewThread();

		// When a background terminal finishes, inject result as system-level context and trigger agent response
		this._register(this._toolsService.onBackgroundTerminalComplete(({ threadId, command, output, exitCode }) => {
			const targetThreadId = threadId || this.state.currentThreadId;
			if (!targetThreadId || !this._allThreads[targetThreadId]) { return; }
			const trimmed = output.trim().slice(-2000);
			const statusLine = exitCode === 0 ? 'completed successfully (exit 0)' : `failed (exit code ${exitCode})`;
			// Content for LLM: explicit instruction not to re-run
			const content = `[SYSTEM: Background terminal finished] Command: ${command}\nStatus: ${statusLine}\nOutput:\n${trimmed || '(no output)'}\n\nAcknowledge this result to the user in one sentence. Do NOT re-run the command.`;
			// Display for user: compact notification style
			const displayContent = `⬛ \`${command}\` ${statusLine}`;
			this._addMessageToThread(targetThreadId, { role: 'user', content, displayContent, selections: null, state: defaultMessageState });
			// Trigger agent to respond — wait for idle if currently running
			const triggerAgent = () => {
				if (this.streamState[targetThreadId]?.isRunning) {
					const l = this.onDidChangeStreamState(({ threadId: t }) => {
						if (t !== targetThreadId) { return; }
						if (!this.streamState[targetThreadId]?.isRunning) {
							l.dispose();
							this._runChatAgent({ threadId: targetThreadId, ...this._currentModelSelectionProps() });
						}
					});
				} else {
					this._runChatAgent({ threadId: targetThreadId, ...this._currentModelSelectionProps() });
				}
			};
			triggerAgent();
		}));


		// keep track of user-modified files
		// const disposablesOfModelId: { [modelId: string]: IDisposable[] } = {}
		// this._register(
		// 	this._modelService.onModelAdded(e => {
		// 		if (!(e.id in disposablesOfModelId)) disposablesOfModelId[e.id] = []
		// 		disposablesOfModelId[e.id].push(
		// 			e.onDidChangeContent(() => { this._userModifiedFilesToCheckInCheckpoints.set(e.uri.fsPath, null) })
		// 		)
		// 	})
		// )
		// this._register(this._modelService.onModelRemoved(e => {
		// 	if (!(e.id in disposablesOfModelId)) return
		// 	disposablesOfModelId[e.id].forEach(d => d.dispose())
		// }))

	}

	async focusCurrentChat() {
		const threadId = this.state.currentThreadId;
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }
		const s = await thread.state.mountedInfo?.whenMounted;
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.focus();
		}
	}
	async blurCurrentChat() {
		const threadId = this.state.currentThreadId;
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }
		const s = await thread.state.mountedInfo?.whenMounted;
		if (!this.isCurrentlyFocusingMessage()) {
			s?.textAreaRef.current?.blur();
		}
	}

	/**
	 * Session cost: REAL provider usage when the ledger recorded it (M6 item
	 * 4), otherwise the chars/4 estimate — calibrated by the per-model
	 * estimated/actual ratio once one real sample exists. Priced by the
	 * model's published rates.
	 */
	getSessionCost(threadId: string): { totalCost: number; inputTokens: number; outputTokens: number; formattedCost: string } {
		const { modelSelection } = this._currentModelSelectionProps();
		if (!modelSelection) { return { totalCost: 0, inputTokens: 0, outputTokens: 0, formattedCost: '$0.0000' }; }
		let cost = { input: 0, output: 0 };
		try {
			const { overridesOfModel } = this._settingsService.state;
			cost = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel).cost;
		} catch { /* unknown model — zero rates */ }
		const thread = this._allThreads[threadId];
		const real = this._ledgerSessionUsage.get(threadId);
		const calibration = this._ledgerCalibration.get(`${modelSelection.providerName}/${modelSelection.modelName}`);
		const report = this._ledgerUsageReports.get(threadId);
		// chat messages are a role union; only conversational roles have text
		const estimateOf = (m: ChatMessage): number => this.estimateTokens(
			m.role === 'assistant' ? (m.displayContent ?? '')
				: m.role === 'user' || m.role === 'tool' ? (m.content ?? '')
					: ''
		);
		const estimateSum = (thread?.messages ?? []).reduce((s, m) => s + estimateOf(m), 0);
		const inputTokens = real
			? real.input
			: calibration && calibration.n > 0 && calibration.ratio > 0
				? Math.round((report?.totalTokens ?? estimateSum) / calibration.ratio)
				: report
					? report.totalTokens
					: estimateSum;
		const outputTokens = real
			? real.output
			: (thread?.messages ?? []).reduce((s, m) => s + (m.role === 'assistant' ? this.estimateTokens(m.displayContent ?? '') : 0), 0);
		const totalCost = (inputTokens / 1e6) * cost.input + (outputTokens / 1e6) * cost.output;
		return { totalCost, inputTokens, outputTokens, formattedCost: `$${totalCost.toFixed(4)}` };
	}

	estimateTokens(text: string): number {
		return Math.ceil(text.length / 4);
	}

	/**
	 * Manual compaction (opencode-style): summarize the aged prefix of a thread
	 * and REWRITE the stored thread, replacing the old messages with a single
	 * summary message. The UI history shrinks accordingly.
	 */
	async compactThread(threadId: string): Promise<{ summary: string; messageCountBefore: number; messageCountAfter: number } | null> {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return null; }

		const { modelSelection } = this._currentModelSelectionProps();
		const rawMessages = thread.messages;
		const messageCountBefore = rawMessages.length;

		const { compactables, raws } = this._toCompactables(rawMessages);
		if (compactables.length === 0 || !modelSelection) { return null; }

		const { overridesOfModel } = this._settingsService.state;
		const { contextWindow, reservedOutputTokenSpace } = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel);

		let result;
		try {
			result = await this._getCompactor().compactIfNeeded({
				messages: compactables,
				contextWindow,
				reservedOutputTokenSpace,
				modelSelection,
				cacheKey: threadId,
				force: true,
			});
		} catch {
			return null;
		}
		if (!result.summary || result.keepFromIdx <= 0) { return null; }

		const summaryMessage: ChatMessage = {
			role: 'user',
			content: renderConversationSummaryMessage(result.summary),
			displayContent: '📦 Conversation compacted — earlier messages were summarized to free up context.',
			selections: null,
			state: defaultMessageState,
		};
		this._replaceThreadMessages(threadId, [summaryMessage, ...raws.slice(result.keepFromIdx)]);
		this._onDidCompact.fire({ threadId, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter, summary: result.summary });
		return { summary: result.summary, messageCountBefore, messageCountAfter: 1 + (raws.length - result.keepFromIdx) };
	}

	/**
	 * Pre-send context management: when the thread's estimated tokens approach
	 * the model's context window, fold its aged prefix into one LLM-summarized
	 * user message. The stored thread (and the UI) are untouched — only the
	 * outgoing request is compacted.
	 */
	private async _maybeCompactThreadForSend(threadId: string, rawMessages: ChatMessage[], modelSelection: ModelSelection | null, force: boolean): Promise<ChatMessage[]> {
		if (!modelSelection || rawMessages.length === 0) { return rawMessages; }

		const { compactables, raws } = this._toCompactables(rawMessages);
		if (compactables.length === 0) { return rawMessages; }

		const { overridesOfModel } = this._settingsService.state;
		const { contextWindow, reservedOutputTokenSpace } = getModelCapabilities(modelSelection.providerName, modelSelection.modelName, overridesOfModel);

		let result;
		try {
			result = await this._getCompactor().compactIfNeeded({
				messages: compactables,
				contextWindow,
				reservedOutputTokenSpace,
				modelSelection,
				cacheKey: threadId,
				force,
			});
		} catch {
			return rawMessages; // compaction is best-effort; never block the send
		}

		if (!result.summary || result.keepFromIdx <= 0) { return rawMessages; }
		console.log(`[ChatThread] Compacted context for send: ~${result.tokensBefore} → ~${result.tokensAfter} est. tokens (llm summary: ${result.usedLLM})`);
		this._onDidCompact.fire({ threadId, tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter, summary: result.summary });

		const summaryMessage: ChatMessage = {
			role: 'user',
			content: renderConversationSummaryMessage(result.summary),
			displayContent: '',
			selections: null,
			state: defaultMessageState,
		};
		return [summaryMessage, ...raws.slice(result.keepFromIdx)];
	}

	/** Convert stored ChatMessages to the compactor's minimal shape, keeping a parallel array of the originals. */
	private _toCompactables(rawMessages: ChatMessage[]): { compactables: CompactableMessage[]; raws: ChatMessage[] } {
		const compactables: CompactableMessage[] = [];
		const raws: ChatMessage[] = [];
		for (const m of rawMessages) {
			if (m.role === 'checkpoint') { continue; }
			if (m.role === 'interrupted_streaming_tool') { continue; }
			if (m.role === 'assistant') {
				compactables.push({ role: 'assistant', content: (m.displayContent || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim() });
				raws.push(m);
			}
			else if (m.role === 'tool') {
				compactables.push({ role: 'tool', content: m.content ?? '', name: m.name });
				raws.push(m);
			}
			else if (m.role === 'user') {
				compactables.push({ role: 'user', content: m.content ?? '' });
				raws.push(m);
			}
		}
		return { compactables, raws };
	}

	private _replaceThreadMessages(threadId: string, messages: ChatMessage[]) {
		const oldThread = this._allThreads[threadId];
		if (!oldThread) { return; } // should never happen
		const newThreads = {
			...this._allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages,
			},
		};
		this._storeAllThreads(newThreads);
		this._setState({ allThreads: newThreads });
	}


	dangerousSetState = (newState: ThreadsState) => {
		this._allThreads = newState.allThreads;
		this.state = { ...newState, allThreads: this._workspaceFilteredThreads(newState.allThreads) };
		this._onDidChangeCurrentThread.fire();
	};
	resetState = () => {
		this._allThreads = {};
		this.state = { allThreads: {}, currentThreadId: null as unknown as string }; // see constructor
		this.openNewThread();
		this._onDidChangeCurrentThread.fire();
	};

	// !!! this is important for properly restoring URIs from storage
	// should probably re-use code from void/src/vs/base/common/marshalling.ts instead. but this is simple enough
	private _convertThreadDataFromStorage(threadsStr: string): ChatThreads {
		return JSON.parse(threadsStr, (key, value) => {
			if (value && typeof value === 'object' && value.$mid === 1) { // $mid is the MarshalledId. $mid === 1 means it is a URI
				return URI.from(value); // TODO URI.revive instead of this?
			}
			return value;
		});
	}

	private _readAllThreads(): ChatThreads | null {
		const threadsStr = this._storageService.get(THREAD_STORAGE_KEY, StorageScope.APPLICATION);
		if (!threadsStr) {
			return null;
		}
		const t0 = Date.now();
		const threads = this._convertThreadDataFromStorage(threadsStr);
		this._lastLoadInfo = { ms: Date.now() - t0, chars: threadsStr.length };

		return threads;
	}

	/**
	 * Persist the thread store, COALESCED and BOUNDED (renderer-OOM fix,
	 * 2026-09-19; v2 archive-gated after the Astra review). The store was
	 * previously re-serialized IN FULL and pushed through IPC on every message
	 * add — measured at 132.8 MB of JSON on the review installation, several
	 * times per chat turn, on top of the ~1.5 GB the parsed store already
	 * holds; under heavy history that burst killed the renderer
	 * (`reason: oom, code: -536870904`, see main.log). Now:
	 *   - writes within THREAD_PERSIST_DEBOUNCE_MS coalesce into the LAST
	 *     state (the journal, flushed on its own 300 ms cadence, remains the
	 *     durable ground truth between stores);
	 *   - the persisted copy is bounded by boundThreadsForStorage and NO
	 *     message is ever replaced by a marker before a full verbatim copy of
	 *     that exact message is confirmed durable in the application-scoped
	 *     thread archive (per-thread, per-message, hash-verified read-back) —
	 *     markers always point at a real archive file, and anything whose
	 *     archive cannot be confirmed stays verbatim and is reported;
	 *   - when a thread is opened, archived messages are rehydrated from that
	 *     archive, so the full conversation survives restarts.
	 */
	private _storeAllThreads(threads: ChatThreads) {
		this._pendingStoreThreads = threads;
		if (this._persistStoreTimer !== null) { return; }
		this._persistStoreTimer = setTimeout(() => {
			this._persistStoreTimer = null;
			this._flushPendingStoreThreads();
		}, THREAD_PERSIST_DEBOUNCE_MS);
	}

	/**
	 * Single-flight flush: a coalesced write whose archive confirmations are
	 * still in progress never overlaps the next one; the newest pending state
	 * wins the following flush. `cacheOnly` (shutdown path) stubs nothing
	 * that was not already verified this session.
	 */
	private _flushPendingStoreThreads(cacheOnly = false): Promise<void> {
		const pending = this._pendingStoreThreads;
		if (!pending) { return this._storeFlushInFlight ?? Promise.resolve(); }
		this._pendingStoreThreads = null;
		const prev = (this._storeFlushInFlight ?? Promise.resolve()).catch(() => undefined);
		const run = prev.then(() => this._doFlushPendingStore(pending, cacheOnly));
		this._storeFlushInFlight = run;
		return run;
	}

	private async _doFlushPendingStore(pending: ChatThreads, cacheOnly: boolean): Promise<void> {
		const t0 = Date.now();
		// per-flush verifier with an IO budget: already-archived messages are
		// answered from the session cache for free; only genuinely NEW archive
		// writes consume the budget — a big bounding backlog converges over
		// subsequent flushes instead of stalling one flush
		let newArchiveBudget = THREAD_PERSIST_MAX_NEW_ARCHIVES_PER_FLUSH;
		const ensureArchived = async (threadId: string, idx: number, full: string) => {
			const cached = this._threadArchiveService.ensureArchivedCached(threadId, full);
			if (cached) { return cached; }
			if (cacheOnly || newArchiveBudget <= 0) { return null; }
			newArchiveBudget--;
			return this._threadArchiveService.ensureArchived(threadId, idx, full);
		};
		try {
			const { bounded, stats } = await boundThreadsForStorage(pending as Record<string, IStorableThread | undefined>, { ensureArchived, cache: this._boundCache });
			const unarchivedNote = stats.keptUnarchived > 0
				? `; ${stats.keptUnarchived} kept verbatim (archive not confirmed this flush — unavailable or budget-deferred)`
				: '';
			if (stats.messagesStubbed > 0) {
				this._logService.info(`[ChatThread] persisted store bounded: stubbed ${stats.messagesStubbed} message(s) across ${stats.threadsStubbed} thread(s), ${Math.round(stats.charsBefore / 1e6)}MB → ${Math.round(stats.charsAfter / 1e6)}MB, ${stats.cacheHits} thread(s) from cache${unarchivedNote}`);
			}
			if (stats.keptUnarchived > 0) {
				this._logService.warn(`[ChatThread] ${stats.keptUnarchived} message(s) were kept VERBATIM this flush (no confirmed archive) — nothing was replaced without a durable copy`);
			}
			// assemble the persisted JSON from per-thread serialized shapes: an
			// unchanged thread contributes its cached string, so a steady-state
			// write stringifies only the thread(s) that actually changed
			const parts: string[] = [];
			for (const id of Object.keys(bounded)) {
				const b = bounded[id];
				if (!b) { continue; }
				let str: string | undefined;
				const hit = this._boundedStrCache.get(id);
				if (hit && hit.inputRef === b) { str = hit.str; }
				else {
					str = JSON.stringify(b);
					this._boundedStrCache.set(id, { inputRef: b, str });
				}
				parts.push(`${JSON.stringify(id)}:${str}`);
			}
			const serializedThreads = '{' + parts.join(',') + '}';
			this._storageService.store(
				THREAD_STORAGE_KEY,
				serializedThreads,
				StorageScope.APPLICATION,
				StorageTarget.USER
			);
			try {
				niTask1ObsPush({ kind: 'store.flush', tags: {}, data: { ms: Date.now() - t0, chars: serializedThreads.length, threads: stats.threadsTotal, stubbed: stats.messagesStubbed, keptUnarchived: stats.keptUnarchived, cacheHits: stats.cacheHits } });
			} catch { /* observational only */ }
		} catch (e) {
			// a bounding bug must never cost data: persist unbounded and say so
			this._logService.warn(`[ChatThread] store bounding failed (${getErrorMessage(e)}) — persisting this flush unbounded`);
			this._storageService.store(
				THREAD_STORAGE_KEY,
				JSON.stringify(pending),
				StorageScope.APPLICATION,
				StorageTarget.USER
			);
		}
	}


	private _workspaceFilteredThreads(allThreads: ChatThreads): ChatThreads {
		return workspaceFilteredThreads(allThreads, this._currentWorkspaceUri());
	}

	// this should be the only place this.state = ... appears besides constructor
	private _setState(state: Partial<ThreadsState>, doNotRefreshMountInfo?: boolean) {
		// When allThreads is being updated, keep _allThreads (full store) in sync
		// and expose only the workspace-filtered view through this.state
		if (state.allThreads !== undefined) {
			this._allThreads = state.allThreads;
			state = { ...state, allThreads: this._workspaceFilteredThreads(state.allThreads) };
		}

		const newState = {
			...this.state,
			...state
		};

		this.state = newState;

		this._onDidChangeCurrentThread.fire();


		// if we just switched to a thread, update its current stream state if it's not streaming to possibly streaming
		const threadId = newState.currentThreadId;
		const streamState = this.streamState[threadId];
		if (streamState?.isRunning === undefined && !streamState?.error) {

			// set streamState
			const messages = newState.allThreads[threadId]?.messages;
			const lastMessage = messages && messages[messages.length - 1];
			// if awaiting user but stream state doesn't indicate it (happens if restart Void)
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'tool_request') { this._setStreamState(threadId, { isRunning: 'awaiting_user', }); }

			// if running now but stream state doesn't indicate it (happens if restart Void), cancel that last tool
			if (lastMessage && lastMessage.role === 'tool' && lastMessage.type === 'running_now') {

				this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', content: lastMessage.content, id: lastMessage.id, rawParams: lastMessage.rawParams, result: null, name: lastMessage.name, params: lastMessage.params, mcpServerName: lastMessage.mcpServerName });
			}

		}


		// if we did not just set the state to true, set mount info
		if (doNotRefreshMountInfo) { return; }

		let whenMountedResolver: (w: WhenMounted) => void;
		const whenMountedPromise = new Promise<WhenMounted>((res) => whenMountedResolver = res);

		this._setThreadState(threadId, {
			mountedInfo: {
				whenMounted: whenMountedPromise,
				mountedIsResolvedRef: { current: false },
				_whenMountedResolver: (w: WhenMounted) => {
					whenMountedResolver(w);
					const mountInfo = this.state.allThreads[threadId]?.state.mountedInfo;
					if (mountInfo) { mountInfo.mountedIsResolvedRef.current = true; }
				},
			}
		}, true); // do not trigger an update



	}


	private _setStreamState(threadId: string, state: ThreadStreamState[string]) {
		this.streamState[threadId] = state;
		this._onDidChangeStreamState.fire({ threadId });
	}


	// ---------- streaming ----------



	private _currentModelSelectionProps = () => {
		// these settings should not change throughout the loop (eg anthropic breaks if you change its thinking mode and it's using tools)
		const featureName: FeatureName = 'Chat';
		const modelSelection = this._settingsService.state.modelSelectionOfFeature[featureName];
		const modelSelectionOptions = modelSelection ? this._settingsService.state.optionsOfModelSelection[featureName][modelSelection.providerName]?.[modelSelection.modelName] : undefined;
		return { modelSelection, modelSelectionOptions };
	};



	private _swapOutLatestStreamingToolWithResult = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const messages = this.state.allThreads[threadId]?.messages;
		if (!messages) { return false; }
		const lastMsg = messages[messages.length - 1];
		if (!lastMsg) { return false; }

		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			this._editMessageInThread(threadId, messages.length - 1, tool);
			return true;
		}
		return false;
	};
	private _updateLatestTool = (threadId: string, tool: ChatMessage & { role: 'tool' }) => {
		const swapped = this._swapOutLatestStreamingToolWithResult(threadId, tool);
		if (swapped) {
			// The swap is an in-place edit, so it bypasses the journal hook in
			// `_addMessageToThread`. Append the finished call here — this is the
			// entry that carries the tool's actual output.
			if (this._ledgerEnabled() && tool.type !== 'running_now') {
				this._journalMessage(threadId, tool);
			}
			return;
		}
		this._addMessageToThread(threadId, tool);
	};

	approveLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; } // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1];
		if (!(lastMsg.role === 'tool' && lastMsg.type === 'tool_request')) { return; } // should never happen

		const callThisToolFirst: ToolMessage<ToolName> = lastMsg;

		this._wrapRunAgentToNotify(
			this._runChatAgent({ callThisToolFirst, threadId, ...this._currentModelSelectionProps() })
			, threadId
		);
	}
	rejectLatestToolRequest(threadId: string) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; } // should never happen

		const lastMsg = thread.messages[thread.messages.length - 1];

		let params: ToolCallParams<ToolName>;
		if (lastMsg.role === 'tool' && lastMsg.type !== 'invalid_params') {
			params = lastMsg.params;
		}
		else { return; }

		const { name, id, rawParams, mcpServerName } = lastMsg;

		const errorMessage = this.toolErrMsgs.rejected;
		this._updateLatestTool(threadId, { role: 'tool', type: 'rejected', params: params, name: name, content: errorMessage, result: null, id, rawParams, mcpServerName });
		this._setStreamState(threadId, undefined);
	}

	private _computeMCPServerOfToolName = (toolName: string) => {
		return this._mcpService.getMCPTools()?.find(t => t.name === toolName)?.mcpServerName;
	};

	async abortRunning(threadId: string) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; } // should never happen

		// add assistant message
		if (this.streamState[threadId]?.isRunning === 'LLM') {
			const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId].llmInfo;
			this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null, durationMs: Date.now() - (this._activeLoopStartMsByThread.get(threadId) ?? Date.now()) });
			if (toolCallSoFar && toolCallSoFar.name && toolCallSoFar.name !== 'tool_call') { this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) }); }
		}
		// add tool that's running
		else if (this.streamState[threadId]?.isRunning === 'tool') {
			const { toolName, toolParams, id, content: content_, rawParams, mcpServerName } = this.streamState[threadId].toolInfo;
			const content = content_ || this.toolErrMsgs.interrupted;
			this._updateLatestTool(threadId, { role: 'tool', name: toolName, params: toolParams, id, content, rawParams, type: 'rejected', result: null, mcpServerName });
		}
		// reject the tool for the user if relevant
		else if (this.streamState[threadId]?.isRunning === 'awaiting_user') {
			this.rejectLatestToolRequest(threadId);
		}
		else if (this.streamState[threadId]?.isRunning === 'idle') {
			// do nothing
		}

		this._addUserCheckpoint({ threadId });

		// interrupt any effects. K-1: the state's `interrupt` is a PROMISE that
		// resolves to the cancel function — a tool that has not yielded its
		// interruptor yet (or a provider abort that hangs) must never wedge
		// Stop. Settle locally within ABORT_LOCAL_SETTLE_MS regardless; the
		// loop's own guards drop whatever the interrupted phase leaves behind.
		{
			const interruptState = this.streamState[threadId];
			if (interruptState?.interrupt !== undefined) {
				let settleTimer: ReturnType<typeof setTimeout> | undefined;
				try {
					const interruptor = await Promise.race([
						Promise.resolve(interruptState.interrupt),
						new Promise<'__settle-timeout'>(resolve => { settleTimer = setTimeout(() => resolve('__settle-timeout'), ABORT_LOCAL_SETTLE_MS); }),
					]);
					if (typeof interruptor === 'function') { interruptor(); }
					else if (interruptor === '__settle-timeout') {
						this._logService.warn(`[AgentRequest] ${threadId} stop: interruptor unavailable after ${ABORT_LOCAL_SETTLE_MS}ms — settling locally`);
					}
				} catch (error) {
					this._logService.warn('[AgentRequest] stop: interrupt hook failed', error);
				} finally {
					if (settleTimer !== undefined) { clearTimeout(settleTimer); }
				}
			}
		}

		// cancel any pending ask_user input requests for this thread
		for (const [id] of this._userInputRequestService.pendingRequests) {
			this._userInputRequestService.cancel(id);
		}


		// Task1 K-1 obs
		try {
			const settledAt = Date.now();
			niTask1ObsPush({ kind: 'turn.cancel', tags: { threadId }, data: { settledAt } });
			niTask1ObsPush({ kind: 'turn.settle', tags: { threadId }, data: { settledAt } });
		} catch { /* observational only */ }

		this._setStreamState(threadId, undefined);
	}



	private readonly toolErrMsgs = {
		rejected: 'Tool call was rejected by the user.',
		interrupted: 'Tool call was interrupted by the user.',
		errWhenStringifying: (error: unknown) => `Tool call succeeded, but there was an error stringifying the output.\n${getErrorMessage(error)}`
	};


	// private readonly _currentlyRunningToolInterruptor: { [threadId: string]: (() => void) | undefined } = {}


	// returns true when the tool call is waiting for user approval
	private _runToolCall = async (
		threadId: string,
		toolName: ToolName,
		toolId: string,
		mcpServerName: string | undefined,
		opts: { preapproved: true; unvalidatedToolParams: RawToolParamsObj; validatedParams: ToolCallParams<ToolName> } | { preapproved: false; unvalidatedToolParams: RawToolParamsObj },
	): Promise<{ awaitingUserApproval?: boolean; interrupted?: boolean }> => {

		// compute these below
		let toolParams: ToolCallParams<ToolName>;
		let toolResult: ToolResult<ToolName>;
		let toolResultStr: string;

		// Keep toolsService aware of which thread is active (needed for plan mode, todos, worktree)
		this._toolsService.setCurrentContext(threadId);

		// Check if it's a built-in tool
		const isBuiltInTool = isABuiltinToolName(toolName);
		if (!isBuiltInTool && !this._internalToolService.has(toolName) && !this._mcpService.getMCPTools()?.some(tool => tool.name === toolName)) {
			const errorMessage = /malformed/i.test(toolName)
				? localize('agent.malformedTool', "Your previous tool call was malformed. Use a valid tool name and arguments.")
				: localize('agent.unavailableTool', "Tool \"{0}\" is not available in this session. Use one of the tools supplied with the request.", toolName);
			this._addMessageToThread(threadId, { role: 'tool', type: 'tool_error', params: opts.unvalidatedToolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName });
			this._logService.warn(`[AgentTool] ${toolName} rejected: unavailable tool`);
			return {};
		}


		if (!opts.preapproved) { // skip this if pre-approved
			// 1. validate tool params
			try {
				if (isBuiltInTool) {
					const params = this._toolsService.validateParams[toolName](opts.unvalidatedToolParams);
					toolParams = params;
				}
				else {
					toolParams = opts.unvalidatedToolParams;
				}
			}
			catch (error) {
				const errorMessage = getErrorMessage(error);
				this._addMessageToThread(threadId, { role: 'tool', type: 'invalid_params', rawParams: opts.unvalidatedToolParams, result: null, name: toolName, content: errorMessage, id: toolId, mcpServerName });
				return {};
			}
			// once validated, add checkpoint for edit
			if (toolName === 'edit_file') { this._addToolEditCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['edit_file']).uri }); }
			if (toolName === 'rewrite_file') { this._addToolEditCheckpoint({ threadId, uri: (toolParams as BuiltinToolCallParams['rewrite_file']).uri }); }

			// 2. if tool requires approval, break from the loop, awaiting approval

			const approvalType = isBuiltInTool ? approvalTypeOfBuiltinToolName[toolName] : 'MCP tools';
			if (approvalType) {
				const autoApprove = this._settingsService.state.globalSettings.autoApprove[approvalType];
				// add a tool_request because we use it for UI if a tool is loading (this should be improved in the future)
				this._addMessageToThread(threadId, { role: 'tool', type: 'tool_request', content: '(Awaiting user permission...)', result: null, name: toolName, params: toolParams, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName });
				if (!autoApprove) {
					return { awaitingUserApproval: true };
				}
			}
		}
		else {
			toolParams = opts.validatedParams;
		}






		// 3. call the tool
		// this._setStreamState(threadId, { isRunning: 'tool' }, 'merge')
		const runningTool = { role: 'tool', type: 'running_now', name: toolName, params: toolParams, content: '(value not received yet...)', result: null, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName } as const;
		this._updateLatestTool(threadId, runningTool);


		let interrupted = false;
		let settleInterrupted: () => void = () => { };
		/** resolves the moment the interruptor below runs (K-1) */
		const interruptedSignal = new Promise<void>(res => { settleInterrupted = res; });
		let interruptToolRef: (() => void) | undefined;
		let resolveInterruptor: (r: () => void) => void = () => { };
		const interruptorPromise = new Promise<() => void>(res => { resolveInterruptor = res; });
		// K-1 (2026-09-17): resolve the interruptor IMMEDIATELY with an
		// upgradable cancel — Stop must never wait for the tool machinery to
		// yield its own interrupt hook (a tool that hangs before yielding used
		// to wedge abortRunning forever, which also swallowed the next user
		// message, because the send path awaits abortRunning first). The real
		// interruptTool attaches when (if) the call returns one.
		resolveInterruptor(() => {
			interrupted = true;
			settleInterrupted();
			try { interruptToolRef?.(); } catch { /* tool cancel is best-effort */ }
		});
		// Sentinel + racer: every await below bails out when Stop interrupts
		// the call, so a hung tool can no longer hold the agent loop hostage;
		// whatever the tool settles to afterwards is dropped — it can neither
		// revive the run nor corrupt the next message. The sentinel is checked
		// through a type predicate: `===` does not narrow object unions.
		const INTERRUPTED = { k1Interrupted: true } as const;
		const isInterrupted = (v: unknown): v is typeof INTERRUPTED =>
			typeof v === 'object' && v !== null && (v as { k1Interrupted?: unknown }).k1Interrupted === true;
		const interruptible = <T>(p: Promise<T>): Promise<T | typeof INTERRUPTED> => {
			p.catch(() => { }); // a late loser rejection must not surface as unhandled after the run returned
			return Promise.race([p, interruptedSignal.then(() => INTERRUPTED)]);
		};
		const markToolInterrupted = () => {
			this._updateLatestTool(threadId, { role: 'tool', name: toolName, params: toolParams, id: toolId, content: this.toolErrMsgs.interrupted, rawParams: opts.unvalidatedToolParams, type: 'rejected', result: null, mcpServerName });
		};
		// Tool calls used to be invisible in session logs — every "why did the
		// agent hang" investigation started with zero evidence. One line per call.
		const toolStartedAt = Date.now();
		try {

			// set stream state
			this._setStreamState(threadId, { isRunning: 'tool', interrupt: interruptorPromise, toolInfo: { toolName, toolParams, id: toolId, content: 'interrupted...', rawParams: opts.unvalidatedToolParams, mcpServerName } });

			if (isBuiltInTool) {
				// For ask_user: register toolId so UI input box can respond using toolMessage.id
				if (toolName === 'ask_user') { this._userInputRequestService.setNextToolCallId(toolId); }
				const call = await interruptible(Promise.resolve(this._toolsService.callTool[toolName](toolParams as never)));
				if (isInterrupted(call)) { markToolInterrupted(); return { interrupted: true }; }
				const { result, interruptTool } = call;
				interruptToolRef = interruptTool;
				if (interrupted) { markToolInterrupted(); return { interrupted: true }; }
				const raced = await interruptible(Promise.resolve(result));
				if (isInterrupted(raced)) { markToolInterrupted(); return { interrupted: true }; }
				toolResult = raced;
			}
			else if (this._internalToolService.has(toolName)) {
				// F02: the caller owns the identity — the sidebar thread id, never
				// an ambient lookup, so concurrent conversations can't cross wires
				const resultStr = await interruptible(Promise.resolve(this._internalToolService.execute(
					toolName,
					toolParams as Record<string, unknown>,
					{ conversationId: threadId, source: 'sidebar-chat' },
				)));
				if (isInterrupted(resultStr)) { markToolInterrupted(); return { interrupted: true }; }
				toolResult = resultStr as typeof toolResult;
				toolResultStr = resultStr || '(Tool returned no data — the knowledge base may not be initialized yet)';
			}
			else {
				const mcpTools = this._mcpService.getMCPTools();
				const mcpTool = mcpTools?.find(t => t.name === toolName);
				if (!mcpTool) {
					// Unknown tool name (a renamed/disabled MCP tool, or an upstream
					// "malformed_tool_call" placeholder some gateways emit when the
					// model's function call failed to parse). Erroring here surfaced
					// "MCP tool … not found" to the user mid-run; the agent-loop
					// contract instead returns the failure TO THE MODEL as the tool
					// result, so the next turn retries with a valid call.
					const isMalformed = /malformed/i.test(toolName);
					const hint = isMalformed
						? 'Your previous tool call was malformed (bad name or unparseable arguments). Re-emit it as a proper tool call.'
						: `Tool "${toolName}" is not available in this session (it may have been renamed, disabled, or hallucinated).`;
					const available = (mcpTools ?? []).slice(0, 40).map(t => t.name).join(', ');
					const guidance = `${hint}${available ? `\nAvailable MCP tools: ${available}` : ''}`;
					// Availability may change after approval. Keep this a failure so
					// the no-progress guard bounds repeated unavailable calls.
					throw new Error(guidance);
				}
				else {
					const mcpResult = await interruptible(Promise.resolve(this._mcpService.callMCPTool({
						serverName: mcpTool.mcpServerName ?? 'unknown_mcp_server',
						toolName: toolName,
						params: toolParams
					})));
					if (isInterrupted(mcpResult)) { markToolInterrupted(); return { interrupted: true }; }
					toolResult = mcpResult.result;
				}
			}

			if (interrupted) { return { interrupted: true }; } // the tool result is added where we interrupt, not here
		}
		catch (error) {
			resolveInterruptor(() => { }); // resolve for the sake of it
			if (interrupted) { return { interrupted: true }; } // the tool result is added where we interrupt, not here

			const errorMessage = getErrorMessage(error);
			this._logService.warn(`[AgentTool] ${toolName} FAILED after ${Date.now() - toolStartedAt}ms: ${errorMessage.slice(0, 300)}`);
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName });
			return {};
		}

		// 4. stringify the result to give to the LLM
		try {
			if (isBuiltInTool) {
				toolResultStr = (this._toolsService.stringOfResult[toolName] as (p: unknown, r: unknown) => string)(toolParams, toolResult);
			}
			// For internal tools the result is already a string (set during execution)
			else if (this._internalToolService.has(toolName)) {
				toolResultStr = (toolResult as unknown as string) || '(Tool returned no data — the knowledge base may not be initialized yet)';
			}
			// For MCP tools, handle the result based on its type
			else {
				toolResultStr = this._mcpService.stringifyResult(toolResult as RawMCPToolCall);
			}
		} catch (error) {
			const errorMessage = this.toolErrMsgs.errWhenStringifying(error);
			this._logService.warn(`[AgentTool] ${toolName} stringification FAILED after ${Date.now() - toolStartedAt}ms: ${errorMessage.slice(0, 300)}`);
			this._updateLatestTool(threadId, { role: 'tool', type: 'tool_error', params: toolParams, result: errorMessage, name: toolName, content: errorMessage, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName });
			return {};
		}

		// 5. add to history and keep going
		// If tool result is empty, null, undefined, or whitespace-only, inject fallback message so LLM can continue
		let finalToolResultStr = (toolResultStr !== null && toolResultStr !== undefined && toolResultStr.trim())
			? toolResultStr
			: '(Tool completed successfully but returned no output)';

		// Layer 6: Progress feedback for OSS models
		const _modelSel = this._settingsService.state.modelSelectionOfFeature['Chat'];
		if (_modelSel && needsOSSEnhancement(_modelSel.providerName, _modelSel.modelName)) {
			finalToolResultStr = wrapToolResultForOSS(toolName, true, finalToolResultStr, 0);
		}

		this._logService.info(`[AgentTool] ${toolName} ok: ${Date.now() - toolStartedAt}ms, ${finalToolResultStr.length} chars`);
		this._updateLatestTool(threadId, { role: 'tool', type: 'success', params: toolParams, result: toolResult, name: toolName, content: finalToolResultStr, id: toolId, rawParams: opts.unvalidatedToolParams, mcpServerName });
		return {};
	};




	private async _runChatAgent({
		threadId,
		modelSelection,
		modelSelectionOptions,
		callThisToolFirst,
	}: {
		threadId: string;
		modelSelection: ModelSelection | null;
		modelSelectionOptions: ModelSelectionOptions | undefined;

		callThisToolFirst?: ToolMessage<ToolName> & { type: 'tool_request' };
	}) {


		let interruptedWhenIdle = false;
		let cancelPreparation: (() => void) | undefined;
		const idleInterruptor = Promise.resolve(() => { interruptedWhenIdle = true; cancelPreparation?.(); });
		// _runToolCall does not need setStreamState({idle}) before it, but it needs it after it. (handles its own setStreamState)

		// above just defines helpers, below starts the actual function
		const { chatMode } = this._settingsService.state.globalSettings; // should not change as we loop even if user changes it, so it goes here
		const { overridesOfModel } = this._settingsService.state;

		let nMessagesSent = 0;
		let shouldSendAnotherMessage = true;
		let isRunningWhenEnd: IsRunningType = undefined;
		const _loopStartMs = Date.now();
		this._activeLoopStartMsByThread.set(threadId, _loopStartMs);
		const MAX_MESSAGES_SENT = MAX_AGENT_MESSAGES_SENT; // hard cap to prevent infinite loops
		let explorationRounds = 0;
		let _readRangeCounts = new Map<string, number>(); // run-wide read file#range counter (repetition signal)
		let _repeatedReads = 0;
		let _fruitlessSearchRounds = 0;
		let _lastToolSig = ''; // for consecutive duplicate tool detection
		let _consecutiveDuplicateTools = 0;
		let _failedBashCommands: string[] = []; // track failed bash commands to detect retry loops
		let _consecutiveNoProgressRounds = 0; // track rounds where all tool calls fail (no forward progress)
		let _sameToolNameAttempts: Record<string, number> = {}; // track repeated calls to same tool name
		let _didOverflowRecovery = false; // one context-overflow compaction per agent run
		// the user message that started this run — the OSS auto-retry layer must
		// not "correct" a text answer when the user asked a QUESTION (it used to
		// resume the finished task right after answering)
		const _runUserMessage = findLast(this._allThreads[threadId]?.messages ?? [], m => m.role === 'user')?.content ?? null;
		let _toolsExecutedThisRun = false;

		// before enter loop, call tool
		if (callThisToolFirst) {
			const { interrupted } = await this._runToolCall(threadId, callThisToolFirst.name, callThisToolFirst.id, callThisToolFirst.mcpServerName, { preapproved: true, unvalidatedToolParams: callThisToolFirst.rawParams, validatedParams: callThisToolFirst.params });
			if (interrupted) {
				this._setStreamState(threadId, undefined);
				this._addUserCheckpoint({ threadId });

			}
		}
		this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' });  // just decorative, for clarity


		// tool use loop
		while (shouldSendAnotherMessage) {
			// false by default each iteration
			shouldSendAnotherMessage = false;
			isRunningWhenEnd = undefined;
			nMessagesSent += 1;

			// Hard cap: prevent runaway loops
			if (nMessagesSent > MAX_MESSAGES_SENT) {
				this._activeLoopStartMsByThread.delete(threadId);
				this._setStreamState(threadId, { isRunning: undefined, error: { message: localize('agent.requestLimit', "Agent paused after {0} model requests. Your conversation is preserved. Send a follow-up to continue from the current work.", MAX_MESSAGES_SENT), fullError: null } });
				return;
			}

			this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor });

			// Builds the outgoing request. Pre-send context management: the
			// Context Ledger path (task M5) assembles brief + verbatim tail when
			// the flag is on; otherwise the legacy opencode-style compactor
			// folds the aged prefix into one summarized user message.
			// A3 (final closure): `overheadTokens` is the measured system+tools
			// cost the final send boundary will charge; passing it through makes
			// the ledger shed ladder run against the REAL wire budget.
			const buildMessages = async (forceCompaction: boolean, overheadTokens?: number) => {
				type PreparedMessages = Awaited<ReturnType<IConvertToLLMMessageService['prepareLLMChatMessages']>>;
				const preparation = new ChatRequestGuard<PreparedMessages>(LLM_STREAM_STALL_MS);
				cancelPreparation = () => preparation.cancel();
				let phase = 'ledger';
				const prepare = async () => {
					const chatMessagesRaw = this.state.allThreads[threadId]?.messages ?? [];
					const chatMessages = this._ledgerEnabled()
						? await this._assembleLedgerThread(threadId, chatMessagesRaw, modelSelection, forceCompaction, overheadTokens)
						: await this._maybeCompactThreadForSend(threadId, chatMessagesRaw, modelSelection, forceCompaction);
					if (preparation.isSettled) { throw new Error('Request preparation already stopped'); }
					phase = 'context';
					return await this._convertToLLMMessagesService.prepareLLMChatMessages({
						chatMessages,
						modelSelection,
						chatMode,
						agentLoopReminder: getAgentLoopReminder(nMessagesSent - 1, MAX_MESSAGES_SENT, { explorationRounds, repeatedReads: _repeatedReads, fruitlessSearchRounds: _fruitlessSearchRounds }),
					});
				};
				try {
					void prepare().then(value => preparation.complete(value), error => preparation.fail(error instanceof Error ? error : new Error(getErrorMessage(error))));
					const result = await preparation.result;
					this._logService.info(`[AgentRequest] ${threadId} request=${nMessagesSent} phase=prepare:${phase} result=${result.type} ${JSON.stringify(preparation.diagnostics)}`);
					if (result.type === 'completed') { return result.value; }
					if (result.type === 'failed') { throw result.error; }
					throw new Error(localize('agent.preparationStopped', "Preparing the model request stopped before it could finish. Your conversation is preserved. Send a follow-up to try again."));
				} finally {
					cancelPreparation = undefined;
					preparation.dispose();
				}
			};
			const stopPreparation = (error: Error) => {
				this._activeLoopStartMsByThread.delete(threadId);
				this._setStreamState(threadId, interruptedWhenIdle ? undefined : { isRunning: undefined, error: { message: getErrorMessage(error), fullError: error } });
				this._addUserCheckpoint({ threadId });
			};
			let preparedMessages: Awaited<ReturnType<typeof buildMessages>>;
			try { preparedMessages = await buildMessages(false); }
			catch (error) {
				stopPreparation(error instanceof Error ? error : new Error(getErrorMessage(error)));
				return;
			}
			let { messages, separateSystemMessage } = preparedMessages;

			if (interruptedWhenIdle) {
				this._setStreamState(threadId, undefined);
				return;
			}

			let shouldRetryLLM = true;
			let nAttempts = 0;
			while (shouldRetryLLM) {
				shouldRetryLLM = false;
				nAttempts += 1;

				type ResTypes =
					| { type: 'llmDone'; toolCalls?: RawToolCallObj[]; info: { fullText: string; fullReasoning: string; anthropicReasoning: AnthropicReasoning[] | null } }
					| { type: 'llmError'; error?: { message: string; fullError: Error | null } }
					| { type: 'llmAborted' };

				// Build the complete tool list for this request:
				// MCP service tools + internal KB tools, deduplicated by name and capped at 128.
				// sendLLMMessageService now uses caller-provided tools as-is (no auto-merge).
				// mutable on purpose: the send-guard may drop the MCP definitions
				// as its last degradation before stopping a request
				let internalMcpTools = (() => {
					const mcpBase = this._mcpService.getMCPTools() ?? [];
					const internal = (chatMode === 'agent' || chatMode === 'copilot' || chatMode === 'validate' || chatMode === 'power')
						? this._internalToolService.getToolInfos()
						: [];

					// Build a set of internal tool "base names" by stripping common verb prefixes.
					// e.g. get_progress → progress, list_units → units, run_health_check → health_check
					// This lets us detect and remove MCP tools that are just short-named shadows of
					// internal KB tools (e.g. an MCP server exposing "progress" instead of "get_progress").
					// External MCP tools that run out-of-process cannot access the renderer KB.
					const VERB_PREFIX = /^(get|list|run|check|create|add|record|remove|delete|resolve|detect|search|export|import|lock|unlock|force_unlock|flag|update|answer|split|merge|revert|waive|restore)_/;
					const internalExactNames = new Set(internal.map(t => t.name));
					const internalBaseNames = new Set(internal.map(t => t.name.replace(VERB_PREFIX, '')));

					// Strip MCP tools whose name is an internal tool's exact name or base name.
					const filteredMcp = mcpBase.filter(t =>
						!internalExactNames.has(t.name) && !internalBaseNames.has(t.name)
					);

					// Internal tools first (win on any remaining name conflict), then filtered MCP.
					const seen = new Set<string>();
					const merged = [...internal, ...filteredMcp].filter(t => {
						if (seen.has(t.name)) { return false; }
						seen.add(t.name);
						return true;
					});
					return merged.slice(0, 128); // API hard limit
				})();

				let llmCancelToken: string | null = null;
				let llmStalled = false;
				const request = new ChatRequestGuard<ResTypes>(LLM_STREAM_STALL_MS, LLM_STREAM_TOTAL_CAP_MS);
				const cancelRequest = () => {
					// Settle locally first: missing or throwing abort hooks cannot
					// leave the loop waiting for an IPC/provider acknowledgement.
					request.cancel();
					try { if (llmCancelToken) { this._llmMessageService.abort(llmCancelToken); } }
					catch (error) { this._logService.warn('[AgentRequest] provider abort failed', error); }
				};

				// Final send-boundary budget check (A3) — after the tool list is
				// built, before the request leaves. The recovery ladder, in order
				// (final closure, 2026-09-17):
				//   (1) overhead-aware shed rebuild — the assembler's never-error
				//       ladder re-run with the MEASURED system+tools cost charged
				//       to the input ceiling, so the shed levels are tried against
				//       the REAL final budget. Previously the ladder only saw the
				//       assembler's own flat-reserve budget: a payload could fit
				//       THERE, fail here, and stop without ever shedding.
				//   (2) one forced-compaction rebuild with the same overhead-aware
				//       budget (close an episode now, then shed).
				//   (3) dropping the MCP/internal tool definitions (builtin tools
				//       of the chat mode remain).
				// Only a payload that still does not fit afterwards stops the send
				// with the actionable error instead of shipping over-window. The
				// exact payload is re-measured after every rebuild.
				{
					// measure the tool set the provider impl will ACTUALLY serialize:
					// chatMode decides the builtin tools (e.g. agent mode injects
					// every builtin), merged with the caller's MCP/internal list —
					// the same `availableTools` merge sendLLMMessage.impl applies.
					let serializedTools = availableTools(chatMode, internalMcpTools, undefined) ?? [];
					const measure = () => this._finalSendBudgetError({ systemMessage: separateSystemMessage, messages, tools: serializedTools, modelSelection });
					/** raw measured system+tools cost (margin math lives in
					 *  availableInputTokens/finalSendBudget) — the A3 overhead. */
					const measuredOverheadTokens = (): number => {
						const toolTokens = serializedTools.length > 0 ? estimateTokens(JSON.stringify(serializedTools)) : 0;
						const systemTokens = separateSystemMessage !== undefined ? estimateTokens(separateSystemMessage) : 0;
						return systemTokens + toolTokens;
					};
					let overBudget = measure();
					// (1) overhead-aware shed rebuild — the A3 gap fix
					if (overBudget !== undefined) {
						const overhead = measuredOverheadTokens();
						try {
							const rebuilt = await buildMessages(false, overhead);
							messages = rebuilt.messages;
							separateSystemMessage = rebuilt.separateSystemMessage;
							overBudget = measure();
							if (overBudget === undefined) {
								this._logService.info(`[AgentRequest] ${threadId} request=${nMessagesSent} phase=send-guard result=shed-rebuild (charged ${fmtTokens(overhead)} tokens of measured system+tools overhead to the assembly budget; the shed ladder fit the REAL ceiling)`);
							}
						} catch { /* fall through to the next rung */ }
					}
					// (2) forced compaction with the overhead-aware budget
					if (overBudget !== undefined && !_didOverflowRecovery) {
						_didOverflowRecovery = true;
						try {
							const rebuilt = await buildMessages(true, measuredOverheadTokens());
							messages = rebuilt.messages;
							separateSystemMessage = rebuilt.separateSystemMessage;
							overBudget = measure();
						} catch (rebuildErr) {
							overBudget = rebuildErr instanceof Error ? rebuildErr : overBudget;
						}
					}
					// (3) Last degradation before any stop: send without the MCP tool
					// definitions (the mode's builtin tools stay functional). This
					// trades optional capabilities for a working request instead of
					// an error banner, and is logged loudly.
					if (overBudget !== undefined && internalMcpTools.length > 0) {
						const builtinOnly = availableTools(chatMode, [], undefined) ?? [];
						if (this._finalSendBudgetError({ systemMessage: separateSystemMessage, messages, tools: builtinOnly, modelSelection }) === undefined) {
							this._logService.warn(`[AgentRequest] ${threadId} request=${nMessagesSent} phase=send-guard result=degraded (dropped ${internalMcpTools.length} MCP tool definitions to fit the window)`);
							internalMcpTools = [];
							serializedTools = builtinOnly;
							overBudget = undefined;
						}
					}
					if (overBudget !== undefined) {
						this._logService.warn(`[AgentRequest] ${threadId} request=${nMessagesSent} phase=send-guard result=stopped (${overBudget.message})`);
						stopPreparation(overBudget);
						return;
					}
				}

				let llmRes: ResTypes;
				// K-1: snapshot of the guard's diagnostics, assigned inside the try
				// below and read by the stalled branch outside it (the getters stay
				// readable after dispose) — distinguishes the total-cap bounded
				// stop from the no-progress stall stop.
				let requestDiagnostics: { elapsedMs: number } | undefined;
				try {
					this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: '', reasoningSoFar: '', toolCallSoFar: null }, interrupt: Promise.resolve(cancelRequest) });
					this._logService.info(`[AgentRequest] ${threadId} request=${nMessagesSent} attempt=${nAttempts} phase=dispatch result=started`);
					llmCancelToken = this._llmMessageService.sendLLMMessage({
						messagesType: 'chatMessages',
						chatMode,
						messages: messages,
						modelSelection,
						modelSelectionOptions,
						overridesOfModel,
						mcpTools: internalMcpTools,
						logging: { loggingName: `Chat - ${chatMode}`, loggingExtras: { threadId, nMessagesSent, chatMode } },
						separateSystemMessage: separateSystemMessage,
						onText: snapshot => {
							if (!request.progress(snapshot)) { return; }
							const { fullText, fullReasoning, toolCalls } = snapshot;
							this._setStreamState(threadId, { isRunning: 'LLM', llmInfo: { displayContentSoFar: fullText, reasoningSoFar: fullReasoning, toolCallSoFar: toolCalls?.[toolCalls.length - 1] ?? null }, interrupt: Promise.resolve(cancelRequest) });
						},
						onFinalMessage: async ({ fullText, fullReasoning, toolCalls, anthropicReasoning, usage }) => {
							// real provider usage (M6 item 4) — journaled with the reply
							if (request.complete({ type: 'llmDone', toolCalls, info: { fullText, fullReasoning, anthropicReasoning } }) && usage) {
								this._recordLedgerUsage(threadId, modelSelection, usage);
							}
						},
						onError: async (error) => {
							request.complete({ type: 'llmError', error });
						},
						onAbort: () => {
							// stop the loop to free up promise, but don't modify state (already handled by whatever stopped it)
							request.cancel();
						},
					});

					// mark as streaming
					if (!llmCancelToken) {
						// Returning (not `break`) is important: the fall-through
						// `_setStreamState({ isRunning: isRunningWhenEnd })` at the end of the
						// loop would otherwise overwrite this error and hide it from the user.
						this._setStreamState(threadId, { isRunning: undefined, error: { message: 'There was an unexpected error when sending your chat message.', fullError: null } });
						this._addUserCheckpoint({ threadId });
						return;
					}

					const result = await request.result;
					requestDiagnostics = { ...request.diagnostics };
					this._logService.info(`[AgentRequest] ${threadId} request=${nMessagesSent} attempt=${nAttempts} phase=stream result=${result.type} ${JSON.stringify(request.diagnostics)}`);
					if (result.type === 'completed') { llmRes = result.value; }
					else if (result.type === 'failed') { llmRes = { type: 'llmError', error: { message: result.error.message, fullError: result.error } }; }
					else {
						llmStalled = result.type === 'stalled';
						cancelRequest();
						llmRes = { type: 'llmAborted' };
					}
				} catch (error) {
					const fullError = error instanceof Error ? error : new Error(getErrorMessage(error));
					llmRes = { type: 'llmError', error: { message: fullError.message, fullError } };
				} finally {
					request.dispose();
				}

				// if something else started running in the meantime
				if (this.streamState[threadId]?.isRunning !== 'LLM') {
					// console.log('Chat thread interrupted by a newer chat thread', this.streamState[threadId]?.isRunning)
					return;
				}
				const recordIncompleteReply = () => {
					const { displayContentSoFar, reasoningSoFar, toolCallSoFar } = this.streamState[threadId]?.llmInfo ?? { displayContentSoFar: '', reasoningSoFar: '', toolCallSoFar: null };
					this._addMessageToThread(threadId, { role: 'assistant', displayContent: displayContentSoFar, reasoning: reasoningSoFar, anthropicReasoning: null, durationMs: Date.now() - _loopStartMs });
					if (toolCallSoFar && toolCallSoFar.name && toolCallSoFar.name !== 'tool_call') { this._addMessageToThread(threadId, { role: 'interrupted_streaming_tool', name: toolCallSoFar.name, mcpServerName: this._computeMCPServerOfToolName(toolCallSoFar.name) }); }
				};

				// llm res aborted
				if (llmRes.type === 'llmAborted') {
					this._metricsService.capture('Agent Loop Done (Aborted)', { nMessagesSent, chatMode, duration_ms: Date.now() - _loopStartMs });
					this._activeLoopStartMsByThread.delete(threadId);
					if (llmStalled) { recordIncompleteReply(); }
					this._setStreamState(threadId, undefined);
					if (llmStalled) {
						// K-1: distinguish the two bounded stops — no-progress stall vs
						// the non-resettable total cap (a stream that kept producing
						// fresh text but never finished).
						const hitTotalCap = (requestDiagnostics?.elapsedMs ?? 0) >= LLM_STREAM_TOTAL_CAP_MS - 1_000;
						this._setStreamState(threadId, {
							isRunning: undefined, error: {
								message: hitTotalCap
									? localize('agent.streamTotalCap', "The model request ran for {0} minutes without finishing and hit the hard request ceiling. The request was stopped and your conversation is preserved. Send a follow-up to continue, or switch models/endpoints.", Math.round(LLM_STREAM_TOTAL_CAP_MS / 60_000))
									: localize('agent.streamStalled', "The model made no progress for {0} minutes. The request was stopped and your conversation is preserved. Send a follow-up to continue, or switch models/endpoints.", Math.round(LLM_STREAM_STALL_MS / 60_000)), fullError: null
							}
						});
						this._addUserCheckpoint({ threadId });
					}
					return;
				}
				// llm res error
				else if (llmRes.type === 'llmError') {
					const errorMessage = llmRes.error?.message ?? '';

					// Context-window overflow: instead of blindly resending the same
					// oversized payload, compact the thread once and retry immediately.
					if (isContextOverflowError(errorMessage) && !_didOverflowRecovery) {
						_didOverflowRecovery = true;
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor });
						try {
							// A3: the provider rejected the REAL payload — compact with
							// the same measured system+tools overhead the final guard
							// charges, so the rebuild targets the wire budget.
							const overflowTools = availableTools(chatMode, internalMcpTools, undefined) ?? [];
							const overflowOverhead = (overflowTools.length > 0 ? estimateTokens(JSON.stringify(overflowTools)) : 0)
								+ (separateSystemMessage !== undefined ? estimateTokens(separateSystemMessage) : 0);
							({ messages, separateSystemMessage } = await buildMessages(true, overflowOverhead));
						} catch (error) {
							stopPreparation(error instanceof Error ? error : new Error(getErrorMessage(error)));
							return;
						}
						if (interruptedWhenIdle) {
							this._setStreamState(threadId, undefined);
							return;
						}
						shouldRetryLLM = true;
						continue;
					}

					// error, should retry — only transient errors are worth retrying;
					// auth/validation failures fail fast instead of burning 3 × 2.5s
					if (nAttempts < CHAT_RETRIES && isRetryableLlmError(errorMessage)) {
						shouldRetryLLM = true;
						this._setStreamState(threadId, { isRunning: 'idle', interrupt: idleInterruptor });
						await timeout(RETRY_DELAY);
						if (interruptedWhenIdle) {
							this._setStreamState(threadId, undefined);
							return;
						}
						else { continue; } // retry
					}
					// error, non-retryable or too many attempts
					else {
						const { error } = llmRes;
						recordIncompleteReply();
						this._activeLoopStartMsByThread.delete(threadId);

						this._setStreamState(threadId, { isRunning: undefined, error });
						this._addUserCheckpoint({ threadId });
						return;
					}
				}

				// llm res success
				const { toolCalls, info } = llmRes;

				this._addMessageToThread(threadId, { role: 'assistant', displayContent: info.fullText, reasoning: info.fullReasoning, anthropicReasoning: info.anthropicReasoning, durationMs: Date.now() - _loopStartMs });

				// Context Ledger (task M5): after each completed reply, check in
				// the background whether an episode should close (token target /
				// idle). Non-blocking — the current request already went out and
				// a closed episode only affects the NEXT send.
				if (this._ledgerEnabled()) { void this._closeEpisodeIfNeeded(threadId, modelSelection, false); }

				this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }); // just decorative for clarity


				// call tools if there are any
				if (toolCalls && toolCalls.length > 0) {
					const mcpTools = this._mcpService.getMCPTools();
					_toolsExecutedThisRun = true;

					let anyInterrupted = false;
					let anyAwaitingUserApproval = false;

					// Detect consecutive duplicate tool calls (loop guard)
					const toolSig = toolCalls.map(t => `${t.name}:${JSON.stringify(t.rawParams)}`).join('|');
					if (toolSig === _lastToolSig) {
						_consecutiveDuplicateTools++;
						if (_consecutiveDuplicateTools >= 2) {
							this._setStreamState(threadId, { isRunning: undefined, error: { message: `Agent stopped: detected repeated tool call loop (same tool called ${_consecutiveDuplicateTools + 1} times with identical parameters). The command may require interactive input that cannot be provided in this environment.`, fullError: null } });
							return;
						}
					} else {
						_consecutiveDuplicateTools = 0;
						_lastToolSig = toolSig;
					}

					// Broader loop guard: detect similar bash commands (same base command, different flags)
					if (toolCalls.length === 1 && toolCalls[0].name === 'bash') {
						const cmd = (toolCalls[0].rawParams?.['command'] || '').toString().split(/\s+/).slice(0, 4).join(' ');
						if (cmd) {
							_failedBashCommands.push(cmd);
							const recentSame = _failedBashCommands.filter(c => c === cmd).length;
							if (recentSame >= 4) {
								this._setStreamState(threadId, { isRunning: undefined, error: { message: `Agent stopped: the same command pattern has been attempted ${recentSame} times. It may require interactive terminal input or have a persistent error.`, fullError: null } });
								return;
							}
						}
					} else {
						_failedBashCommands = [];
					}

					// execute all tools sequentially or concurrently (sequentially is safer for things like git and file edits)
					for (const toolCall of toolCalls) {
						// Skip unresolved 'tool_call' placeholders from XML proxy parsing
						if (!toolCall.name || toolCall.name === 'tool_call') { continue; }


						// CRITICAL FIX: Detect concatenated tool names (LLM error like "update_agent_statusgrc_blocking_violations")
						const toolNameLower = toolCall.name.toLowerCase();
						const suspiciousPatterns = [
							/grc.*status|status.*grc/,
							/agent.*grc|grc.*agent/,
							/(update|get|set)_\w+grc/,
						];
						if (suspiciousPatterns.some(pattern => pattern.test(toolNameLower))) {
							console.error(`[ChatThread] Rejecting malformed tool: "${toolCall.name}"`);
							const errorMsg = `Invalid tool name "${toolCall.name}". Use separate tool calls.`;
							this._addMessageToThread(threadId, {
								role: 'tool',
								type: 'tool_error',
								params: toolCall.rawParams,
								result: errorMsg,
								name: toolCall.name,
								content: errorMsg,
								id: toolCall.id,
								rawParams: toolCall.rawParams,
								mcpServerName: undefined
							});
							continue;
						}
						// Normalize tool name aliases (OSS models use alternative names)
						const resolvedToolName = resolveToolAlias(toolCall.name);
						if (resolvedToolName !== toolCall.name) {
							toolCall.name = resolvedToolName;
						}

						// Internal tools take priority over MCP tools with the same name.
						// Don't pass mcpServerName for internal tools so they don't display as "MCP".
						const isInternal = this._internalToolService.has(toolCall.name);
						const mcpTool = isInternal ? undefined : mcpTools?.find(t => t.name === toolCall.name);
						const { awaitingUserApproval, interrupted } = await this._runToolCall(threadId, toolCall.name, toolCall.id, mcpTool?.mcpServerName, { preapproved: false, unvalidatedToolParams: toolCall.rawParams });

						if (interrupted) {
							anyInterrupted = true;
							break;
						}
						if (awaitingUserApproval) {
							anyAwaitingUserApproval = true;
							break; // If one needs approval, stop executing subsequent tools and wait.
						}
					}

					if (anyInterrupted) {
						this._setStreamState(threadId, undefined);
						return;
					}

					// No-progress guard: if all tool calls in this round failed, increment counter
					const msgs = this.state.allThreads[threadId]?.messages ?? [];
					const lastToolMsgs = msgs.slice(-toolCalls.length).filter(m => m.role === 'tool');
					explorationRounds = advanceExplorationRounds(explorationRounds, lastToolMsgs.map(m => ({ name: m.name, success: m.type === 'success' })));
					// Repetition signals for the checkpoint reminder (guidance only —
					// the hard loop guards below still own stopping decisions).
					const readsThisRound = toolCalls
						.filter(tc => tc.name === 'read' || tc.name === 'read_file')
						.map(tc => ({
							file: String(tc.rawParams?.['file_path'] ?? tc.rawParams?.['filePath'] ?? tc.rawParams?.['path'] ?? tc.rawParams?.['file'] ?? tc.rawParams?.['uri'] ?? ''),
							range: `${tc.rawParams?.['offset'] ?? ''}-${tc.rawParams?.['limit'] ?? ''}`,
						}))
						.filter(r => r.file !== '');
					const readState = countRepeatedReads(_readRangeCounts, readsThisRound);
					_readRangeCounts = readState.counts;
					_repeatedReads = readState.totalRepeats;
					_fruitlessSearchRounds = advanceFruitlessSearchRounds(_fruitlessSearchRounds, lastToolMsgs.map(m => ({
						name: m.name,
						success: m.type === 'success',
						emptyResult: /no matches found|no results|no symbols found/i.test(m.content ?? m.result ?? ''),
					})));
					const allFailed = lastToolMsgs.length > 0 && lastToolMsgs.every(m => m.type === 'tool_error' || m.type === 'invalid_params');
					if (allFailed) {
						_consecutiveNoProgressRounds++;
						// Track which tools keep failing
						for (const tc of toolCalls) {
							_sameToolNameAttempts[tc.name] = (_sameToolNameAttempts[tc.name] || 0) + 1;
						}
						const maxFailedAttempts = Math.max(...Object.values(_sameToolNameAttempts));
						if (maxFailedAttempts >= 4) {
							const stuckTool = Object.entries(_sameToolNameAttempts).find(([_, v]) => v >= 4)?.[0] ?? 'unknown';
							this._setStreamState(threadId, { isRunning: undefined, error: { message: `Agent stopped: tool "${stuckTool}" failed ${maxFailedAttempts} consecutive times. The operation may not be possible in this context.`, fullError: null } });
							return;
						}
						if (_consecutiveNoProgressRounds >= 3) {
							this._setStreamState(threadId, { isRunning: undefined, error: { message: `Agent stopped: ${_consecutiveNoProgressRounds} consecutive rounds of failed tool calls with no forward progress.`, fullError: null } });
							return;
						}
					} else {
						_consecutiveNoProgressRounds = 0;
						_sameToolNameAttempts = {};
					}

					if (anyAwaitingUserApproval) { isRunningWhenEnd = 'awaiting_user'; }
					else { shouldSendAnotherMessage = true; }

					this._setStreamState(threadId, { isRunning: 'idle', interrupt: 'not_needed' }); // just decorative, for clarity
				}
				// Layer 3: Auto-retry for OSS models that output text instead of tool calls
				else if (info.fullText && modelSelection && needsOSSEnhancement(modelSelection.providerName, modelSelection.modelName)) {
					const retryCount = this._ossRetryCountByThread.get(threadId) ?? 0;
					if (shouldAutoRetry(info.fullText, 0, chatMode, retryCount, { userMessage: _runUserMessage, toolsExecutedThisRun: _toolsExecutedThisRun })) {
						this._ossRetryCountByThread.set(threadId, retryCount + 1);
						const correction = getCorrectionMessage(retryCount, info.fullText);
						this._addMessageToThread(threadId, { role: 'user', content: correction, displayContent: '', selections: null, state: defaultMessageState });
						shouldSendAnotherMessage = true;
					} else {
						this._ossRetryCountByThread.delete(threadId);
					}
				}

			} // end while (attempts)
		} // end while (send message)

		// if awaiting user approval, keep isRunning true, else end isRunning
		this._setStreamState(threadId, { isRunning: isRunningWhenEnd });

		// add checkpoint before the next user message
		if (!isRunningWhenEnd) { this._addUserCheckpoint({ threadId }); }

		// capture number of messages sent
		this._metricsService.capture('Agent Loop Done', { nMessagesSent, chatMode, duration_ms: Date.now() - _loopStartMs });
		this._activeLoopStartMsByThread.delete(threadId);
	}


	private _addCheckpoint(threadId: string, checkpoint: CheckpointEntry) {
		this._addMessageToThread(threadId, checkpoint);
		// // update latest checkpoint idx to the one we just added
		// const newThread = this.state.allThreads[threadId]
		// if (!newThread) return // should never happen
		// const currCheckpointIdx = newThread.messages.length - 1
		// this._setThreadState(threadId, { currCheckpointIdx: currCheckpointIdx })
	}



	private _editMessageInThread(threadId: string, messageIdx: number, newMessage: ChatMessage,) {
		const oldThread = this._allThreads[threadId];
		if (!oldThread) { return; } // should never happen
		// update state and store it
		const newThreads = {
			...this._allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages.slice(0, messageIdx),
					newMessage,
					...oldThread.messages.slice(messageIdx + 1, Infinity),
				],
			}
		};
		this._storeAllThreads(newThreads);
		this._setState({ allThreads: newThreads }); // the current thread just changed (it had a message added to it)
	}


	private _getCheckpointInfo = (checkpointMessage: ChatMessage & { role: 'checkpoint' }, fsPath: string, opts: { includeUserModifiedChanges: boolean }) => {
		const voidFileSnapshot = checkpointMessage.voidFileSnapshotOfURI ? checkpointMessage.voidFileSnapshotOfURI[fsPath] ?? null : null;
		if (!opts.includeUserModifiedChanges) { return { voidFileSnapshot, }; }

		const userModifiedVoidFileSnapshot = checkpointMessage.userModifications.voidFileSnapshotOfURI[fsPath] ?? null;
		return { voidFileSnapshot: userModifiedVoidFileSnapshot ?? voidFileSnapshot, };
	};

	private _computeNewCheckpointInfo({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }

		const lastCheckpointIdx = findLastIdx(thread.messages, (m) => m.role === 'checkpoint') ?? -1;
		if (lastCheckpointIdx === -1) { return; }

		const voidFileSnapshotOfURI: { [fsPath: string]: VoidFileSnapshot | undefined } = {};

		// add a change for all the URIs in the checkpoint history
		const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: 0, hiIdx: lastCheckpointIdx, }) ?? {};
		for (const fsPath in lastIdxOfURI ?? {}) {
			const { model } = this._voidModelService.getModelFromFsPath(fsPath);
			if (!model) { continue; }
			const checkpoint2 = thread.messages[lastIdxOfURI[fsPath]] || null;
			if (!checkpoint2) { continue; }
			if (checkpoint2.role !== 'checkpoint') { continue; }
			const res = this._getCheckpointInfo(checkpoint2, fsPath, { includeUserModifiedChanges: false });
			if (!res) { continue; }
			const { voidFileSnapshot: oldVoidFileSnapshot } = res;

			// if there was any change to the str or diffAreaSnapshot, update. rough approximation of equality, oldDiffAreasSnapshot === diffAreasSnapshot is not perfect
			const voidFileSnapshot = this._editCodeService.getVoidFileSnapshot(URI.file(fsPath));
			if (oldVoidFileSnapshot === voidFileSnapshot) { continue; }
			voidFileSnapshotOfURI[fsPath] = voidFileSnapshot;
		}

		// // add a change for all user-edited files (that aren't in the history)
		// for (const fsPath of this._userModifiedFilesToCheckInCheckpoints.keys()) {
		// 	if (fsPath in lastIdxOfURI) continue // if already visisted, don't visit again
		// 	const { model } = this._voidModelService.getModelFromFsPath(fsPath)
		// 	if (!model) continue
		// 	currStrOfFsPath[fsPath] = model.getValue(EndOfLinePreference.LF)
		// }

		return { voidFileSnapshotOfURI };
	}


	private _addUserCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {};
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'user_edit',
			voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {},
			userModifications: { voidFileSnapshotOfURI: {}, },
		});
	}
	// call this right after LLM edits a file
	private _addToolEditCheckpoint({ threadId, uri, }: { threadId: string; uri: URI }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }
		const { model } = this._voidModelService.getModel(uri);
		if (!model) { return; } // should never happen
		const diffAreasSnapshot = this._editCodeService.getVoidFileSnapshot(uri);
		this._addCheckpoint(threadId, {
			role: 'checkpoint',
			type: 'tool_edit',
			voidFileSnapshotOfURI: { [uri.fsPath]: diffAreasSnapshot },
			userModifications: { voidFileSnapshotOfURI: {} },
		});
	}


	private _getCheckpointBeforeMessage = ({ threadId, messageIdx }: { threadId: string; messageIdx: number }): [CheckpointEntry, number] | undefined => {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return undefined; }
		for (let i = messageIdx; i >= 0; i--) {
			const message = thread.messages[i];
			if (message.role === 'checkpoint') {
				return [message, i];
			}
		}
		return undefined;
	};

	private _getCheckpointsBetween({ threadId, loIdx, hiIdx }: { threadId: string; loIdx: number; hiIdx: number }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return { lastIdxOfURI: {} }; } // should never happen
		const lastIdxOfURI: { [fsPath: string]: number } = {};
		for (let i = loIdx; i <= hiIdx; i += 1) {
			const message = thread.messages[i];
			if (message?.role !== 'checkpoint') { continue; }
			for (const fsPath in message.voidFileSnapshotOfURI) { // do not include userModified.beforeStrOfURI here, jumping should not include those changes
				lastIdxOfURI[fsPath] = i;
			}
		}
		return { lastIdxOfURI };
	}

	private _readCurrentCheckpoint(threadId: string): [CheckpointEntry, number] | undefined {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }

		const { currCheckpointIdx } = thread.state;
		if (currCheckpointIdx === null) { return; }

		const checkpoint = thread.messages[currCheckpointIdx];
		if (!checkpoint) { return; }
		if (checkpoint.role !== 'checkpoint') { return; }
		return [checkpoint, currCheckpointIdx];
	}
	private _addUserModificationsToCurrCheckpoint({ threadId }: { threadId: string }) {
		const { voidFileSnapshotOfURI } = this._computeNewCheckpointInfo({ threadId }) ?? {};
		const res = this._readCurrentCheckpoint(threadId);
		if (!res) { return; }
		const [checkpoint, checkpointIdx] = res;
		this._editMessageInThread(threadId, checkpointIdx, {
			...checkpoint,
			userModifications: { voidFileSnapshotOfURI: voidFileSnapshotOfURI ?? {}, },
		});
	}


	private _makeUsStandOnCheckpoint({ threadId }: { threadId: string }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }
		if (thread.state.currCheckpointIdx === null) {
			const lastMsg = thread.messages[thread.messages.length - 1];
			if (lastMsg?.role !== 'checkpoint') { this._addUserCheckpoint({ threadId }); }
			this._setThreadState(threadId, { currCheckpointIdx: thread.messages.length - 1 });
		}
	}

	jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified }: { threadId: string; messageIdx: number; jumpToUserModified: boolean }) {

		// if null, add a new temp checkpoint so user can jump forward again
		this._makeUsStandOnCheckpoint({ threadId });

		const thread = this.state.allThreads[threadId];
		if (!thread) { return; }
		if (this.streamState[threadId]?.isRunning) { return; }

		const c = this._getCheckpointBeforeMessage({ threadId, messageIdx });
		if (c === undefined) { return; } // should never happen

		const fromIdx = thread.state.currCheckpointIdx;
		if (fromIdx === null) { return; } // should never happen

		const [_, toIdx] = c;
		if (toIdx === fromIdx) { return; }

		// console.log(`going from ${fromIdx} to ${toIdx}`)

		// update the user's checkpoint
		this._addUserModificationsToCurrCheckpoint({ threadId });

		/*
if undoing

A,B,C are all files.
x means a checkpoint where the file changed.

A B C D E F G H I
	|  x x x x x   x           <-- you can't always go up to find the "before" version; sometimes you need to go down
	|  | | | | |   | x
--x-|-|-|-x---x-|-----     <-- to
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-------     <-- from
		|  x

We need to revert anything that happened between to+1 and from.
**We do this by finding the last x from 0...`to` for each file and applying those contents.**
We only need to do it for files that were edited since `to`, ie files between to+1...from.
*/
		if (toIdx < fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: toIdx + 1, hiIdx: fromIdx });

			const idxes = function* () {
				for (let k = toIdx; k >= 0; k -= 1) { // first go up
					yield k;
				}
				for (let k = toIdx + 1; k < thread.messages.length; k += 1) { // then go down
					yield k;
				}
			};

			for (const fsPath in lastIdxOfURI) {
				// find the first instance of this file starting at toIdx (go up to latest file; if there is none, go down)
				for (const k of idxes()) {
					const message = thread.messages[k];
					if (message.role !== 'checkpoint') { continue; }
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified });
					if (!res) { continue; }
					const { voidFileSnapshot } = res;
					if (!voidFileSnapshot) { continue; }
					this._editCodeService.restoreVoidFileSnapshot(URI.file(fsPath), voidFileSnapshot);
					break;
				}
			}
		}

		/*
if redoing

A B C D E F G H I J
	|  x x x x x   x     x
	|  | | | | |   | x x x
--x-|-|-|-x---x-|-|---     <-- from
	| | | | x   x
	| | x x |
	| |   | |
----x-|---x-x-----|---     <-- to
		|  x           x


We need to apply latest change for anything that happened between from+1 and to.
We only need to do it for files that were edited since `from`, ie files between from+1...to.
*/
		if (toIdx > fromIdx) {
			const { lastIdxOfURI } = this._getCheckpointsBetween({ threadId, loIdx: fromIdx + 1, hiIdx: toIdx });
			for (const fsPath in lastIdxOfURI) {
				// apply lowest down content for each uri
				for (let k = toIdx; k >= fromIdx + 1; k -= 1) {
					const message = thread.messages[k];
					if (message.role !== 'checkpoint') { continue; }
					const res = this._getCheckpointInfo(message, fsPath, { includeUserModifiedChanges: jumpToUserModified });
					if (!res) { continue; }
					const { voidFileSnapshot } = res;
					if (!voidFileSnapshot) { continue; }
					this._editCodeService.restoreVoidFileSnapshot(URI.file(fsPath), voidFileSnapshot);
					break;
				}
			}
		}

		this._setThreadState(threadId, { currCheckpointIdx: toIdx });
	}


	private _wrapRunAgentToNotify(p: Promise<void>, threadId: string) {
		const notify = ({ error }: { error: string | null }) => {
			const thread = this.state.allThreads[threadId];
			if (!thread) { return; }
			const userMsg = findLast(thread.messages, m => m.role === 'user');
			if (!userMsg) { return; }
			if (userMsg.role !== 'user') { return; }
			const messageContent = truncate(userMsg.displayContent, 50, '...');

			this._notificationService.notify({
				severity: error ? Severity.Warning : Severity.Info,
				message: error ? `Agent error: ${error}` : `Agent finished — "${messageContent}"`,
				source: 'Neural Inverse Agent',
				sticky: false,
				actions: {
					primary: [{
						id: 'void.goToChat',
						enabled: true,
						label: `Jump to Chat`,
						tooltip: '',
						class: undefined,
						run: () => {
							this.switchToThread(threadId);
							// scroll to bottom
							this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
								m.scrollToBottom();
							});
						}
					}]
				},
			});
		};

		p.then(() => {
			notify({ error: this.streamState[threadId]?.error?.message ?? null });
		}).catch((e) => {
			notify({ error: getErrorMessage(e) });
			throw e;
		});
	}

	dismissStreamError(threadId: string): void {
		this._setStreamState(threadId, undefined);
	}


	private async _addUserMessageAndStreamResponse({ userMessage, _chatSelections, images, threadId }: { userMessage: string; _chatSelections?: StagingSelectionItem[]; images?: ImageAttachment[]; threadId: string }) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return; } // should never happen

		// interrupt existing stream
		if (this.streamState[threadId]?.isRunning) {
			await this.abortRunning(threadId);
		}

		// add dummy before this message to keep checkpoint before user message idea consistent
		if (thread.messages.length === 0) {
			this._addUserCheckpoint({ threadId });
		}


		// add user's message to chat history
		const instructions = userMessage;
		const currSelns: StagingSelectionItem[] = _chatSelections ?? thread.state.stagingSelections;

		const userMessageContent = await chat_userMessageContent(instructions, currSelns, { directoryStrService: this._directoryStringService, fileService: this._fileService }); // user message + names of files (NOT content)
		const userHistoryElt: ChatMessage = { role: 'user', content: userMessageContent, displayContent: instructions, selections: currSelns, images, state: defaultMessageState };
		this._addMessageToThread(threadId, userHistoryElt);

		this._setThreadState(threadId, { currCheckpointIdx: null }); // no longer at a checkpoint because started streaming

		// If in agent mode, start the NI agent task tracker before running the chat loop
		const { chatMode } = this._settingsService.state.globalSettings;
		if (chatMode === 'agent') {
			this._getAgentService()?.startTask(instructions, threadId);
		}

		this._wrapRunAgentToNotify(
			this._runChatAgent({ threadId, ...this._currentModelSelectionProps(), }),
			threadId,
		);

		// scroll to bottom
		this.state.allThreads[threadId]?.state.mountedInfo?.whenMounted.then(m => {
			m.scrollToBottom();
		});
	}


	async addUserMessageAndStreamResponse({ userMessage, _chatSelections, images, threadId }: { userMessage: string; _chatSelections?: StagingSelectionItem[]; images?: ImageAttachment[]; threadId: string }) {
		const thread = this._allThreads[threadId];
		if (!thread) { return; }

		// if there's a current checkpoint, delete all messages after it
		if (thread.state.currCheckpointIdx !== null) {
			const checkpointIdx = thread.state.currCheckpointIdx;
			const newMessages = thread.messages.slice(0, checkpointIdx + 1);

			// Update the thread with truncated messages
			const newThreads = {
				...this._allThreads,
				[threadId]: {
					...thread,
					lastModified: new Date().toISOString(),
					messages: newMessages,
				}
			};
			this._storeAllThreads(newThreads);
			this._setState({ allThreads: newThreads });
		}

		// Now call the original method to add the user message and stream the response
		await this._addUserMessageAndStreamResponse({ userMessage, _chatSelections, images, threadId });

	}

	editUserMessageAndStreamResponse: IChatThreadService['editUserMessageAndStreamResponse'] = async ({ userMessage, messageIdx, threadId }) => {

		const thread = this._allThreads[threadId];
		if (!thread) { return; } // should never happen

		if (thread.messages?.[messageIdx]?.role !== 'user') {
			throw new Error(`Error: editing a message with role !=='user'`);
		}

		// get prev and curr selections before clearing the message
		const currSelns = thread.messages[messageIdx].state.stagingSelections || []; // staging selections for the edited message

		// clear messages up to the index
		const slicedMessages = thread.messages.slice(0, messageIdx);
		this._setState({
			allThreads: {
				...this._allThreads,
				[thread.id]: {
					...thread,
					messages: slicedMessages
				}
			}
		});

		// re-add the message and stream it
		this._addUserMessageAndStreamResponse({ userMessage, _chatSelections: currSelns, threadId });
	};

	// ---------- the rest ----------

	private _getAllSeenFileURIs(threadId: string) {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return []; }

		const fsPathsSet = new Set<string>();
		const uris: URI[] = [];
		const addURI = (uri: URI) => {
			if (!fsPathsSet.has(uri.fsPath)) { uris.push(uri); }
			fsPathsSet.add(uri.fsPath);
			uris.push(uri);
		};

		for (const m of thread.messages) {
			// URIs of user selections
			if (m.role === 'user') {
				for (const sel of m.selections ?? []) {
					addURI(sel.uri);
				}
			}
			// URIs of files that have been read
			else if (m.role === 'tool' && m.type === 'success' && m.name === 'read_file') {
				const params = m.params as BuiltinToolCallParams['read_file'];
				addURI(params.uri);
			}
		}
		return uris;
	}



	getRelativeStr = (uri: URI) => {
		const isInside = this._workspaceContextService.isInsideWorkspace(uri);
		if (isInside) {
			const f = this._workspaceContextService.getWorkspace().folders.find(f => uri.fsPath.startsWith(f.uri.fsPath));
			if (f) { return uri.fsPath.replace(f.uri.fsPath, ''); }
			else { return undefined; }
		}
		else {
			return undefined;
		}
	};


	// gets the location of codespan link so the user can click on it
	generateCodespanLink: IChatThreadService['generateCodespanLink'] = async ({ codespanStr: _codespanStr, threadId }) => {

		// process codespan to understand what we are searching for
		// TODO account for more complicated patterns eg `ITextEditorService.openEditor()`
		const functionOrMethodPattern = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/; // `fUnCt10n_name`
		const functionParensPattern = /^([^\s(]+)\([^)]*\)$/; // `functionName( args )`

		let target = _codespanStr; // the string to search for
		let codespanType: 'file-or-folder' | 'function-or-class';
		if (target.includes('.') || target.includes('/')) {

			codespanType = 'file-or-folder';
			target = _codespanStr;

		} else if (functionOrMethodPattern.test(target)) {

			codespanType = 'function-or-class';
			target = _codespanStr;

		} else if (functionParensPattern.test(target)) {
			const match = target.match(functionParensPattern);
			if (match && match[1]) {

				codespanType = 'function-or-class';
				target = match[1];

			}
			else { return null; }
		}
		else {
			return null;
		}

		// get history of all AI and user added files in conversation + store in reverse order (MRU)
		const prevUris = this._getAllSeenFileURIs(threadId).reverse();

		if (codespanType === 'file-or-folder') {
			const doesUriMatchTarget = (uri: URI) => uri.path.includes(target);

			// check if any prevFiles are the `target`
			for (const [idx, uri] of prevUris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// shorten it

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath);
					const shortenedUriStrs = shorten(prevUriStrs);
					let displayText = shortenedUriStrs[idx];
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2);
					}

					return { uri, displayText };
				}
			}

			// else search codebase for `target`
			let uris: URI[] = [];
			try {
				const { result } = await this._toolsService.callTool['search_pathnames_only']({ query: target, includePattern: null, pageNumber: 0 });
				const { uris: uris_ } = await result;
				uris = uris_;
			} catch (e) {
				return null;
			}

			for (const [idx, uri] of uris.entries()) {
				if (doesUriMatchTarget(uri)) {

					// TODO make this logic more general
					const prevUriStrs = prevUris.map(uri => uri.fsPath);
					const shortenedUriStrs = shorten(prevUriStrs);
					let displayText = shortenedUriStrs[idx];
					const ellipsisIdx = displayText.lastIndexOf('…/');
					if (ellipsisIdx >= 0) {
						displayText = displayText.slice(ellipsisIdx + 2);
					}


					return { uri, displayText };
				}
			}

		}


		if (codespanType === 'function-or-class') {


			// check all prevUris for the target
			for (const uri of prevUris) {

				const modelRef = await this._voidModelService.getModelSafe(uri);
				const { model } = modelRef;
				if (!model) { continue; }

				const matches = model.findMatches(
					target,
					false, // searchOnlyEditableRange
					false, // isRegex
					true,  // matchCase
					null, //' ',   // wordSeparators
					true   // captureMatches
				);

				const firstThree = matches.slice(0, 3);

				// take first 3 occurences, attempt to goto definition on them
				for (const match of firstThree) {
					const position = new Position(match.range.startLineNumber, match.range.startColumn);
					const definitionProviders = this._languageFeaturesService.definitionProvider.ordered(model);

					for (const provider of definitionProviders) {

						const _definitions = await provider.provideDefinition(model, position, CancellationToken.None);

						if (!_definitions) { continue; }

						const definitions = Array.isArray(_definitions) ? _definitions : [_definitions];

						for (const definition of definitions) {

							return {
								uri: definition.uri,
								selection: {
									startLineNumber: definition.range.startLineNumber,
									startColumn: definition.range.startColumn,
									endLineNumber: definition.range.endLineNumber,
									endColumn: definition.range.endColumn,
								},
								displayText: _codespanStr,
							};

							// const defModelRef = await this._textModelService.createModelReference(definition.uri);
							// const defModel = defModelRef.object.textEditorModel;

							// try {
							// 	const symbolProviders = this._languageFeaturesService.documentSymbolProvider.ordered(defModel);

							// 	for (const symbolProvider of symbolProviders) {
							// 		const symbols = await symbolProvider.provideDocumentSymbols(
							// 			defModel,
							// 			CancellationToken.None
							// 		);

							// 		if (symbols) {
							// 			const symbol = symbols.find(s => {
							// 				const symbolRange = s.range;
							// 				return symbolRange.startLineNumber <= definition.range.startLineNumber &&
							// 					symbolRange.endLineNumber >= definition.range.endLineNumber &&
							// 					(symbolRange.startLineNumber !== definition.range.startLineNumber || symbolRange.startColumn <= definition.range.startColumn) &&
							// 					(symbolRange.endLineNumber !== definition.range.endLineNumber || symbolRange.endColumn >= definition.range.endColumn);
							// 			});

							// 			// if we got to a class/function get the full range and return
							// 			if (symbol?.kind === SymbolKind.Function || symbol?.kind === SymbolKind.Method || symbol?.kind === SymbolKind.Class) {
							// 				return {
							// 					uri: definition.uri,
							// 					selection: {
							// 						startLineNumber: definition.range.startLineNumber,
							// 						startColumn: definition.range.startColumn,
							// 						endLineNumber: definition.range.endLineNumber,
							// 						endColumn: definition.range.endColumn,
							// 					}
							// 				};
							// 			}
							// 		}
							// 	}
							// } finally {
							// 	defModelRef.dispose();
							// }
						}
					}
				}
			}

			// unlike above do not search codebase (doesnt make sense)

		}

		return null;

	};

	getCodespanLink({ codespanStr, messageIdx, threadId }: { codespanStr: string; messageIdx: number; threadId: string }): CodespanLocationLink | undefined {
		const thread = this.state.allThreads[threadId];
		if (!thread) { return undefined; }

		const links = thread.state.linksOfMessageIdx?.[messageIdx];
		if (!links) { return undefined; }

		const link = links[codespanStr];

		return link;
	}

	async addCodespanLink({ newLinkText, newLinkLocation, messageIdx, threadId }: { newLinkText: string; newLinkLocation: CodespanLocationLink; messageIdx: number; threadId: string }) {
		const thread = this._allThreads[threadId];
		if (!thread) { return; }

		this._setState({

			allThreads: {
				...this._allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						linksOfMessageIdx: {
							...thread.state.linksOfMessageIdx,
							[messageIdx]: {
								...thread.state.linksOfMessageIdx?.[messageIdx],
								[newLinkText]: newLinkLocation
							}
						}
					}

				}
			}
		});
	}


	getCurrentThread(): ThreadType {
		const state = this.state;
		const thread = state.allThreads[state.currentThreadId];
		if (!thread) { throw new Error(`Current thread should never be undefined`); }
		return thread;
	}

	getCurrentFocusedMessageIdx() {
		const thread = this.getCurrentThread();

		// get the focusedMessageIdx
		const focusedMessageIdx = thread.state.focusedMessageIdx;
		if (focusedMessageIdx === undefined) { return; }

		// check that the message is actually being edited
		const focusedMessage = thread.messages[focusedMessageIdx];
		if (focusedMessage.role !== 'user') { return; }
		if (!focusedMessage.state) { return; }

		return focusedMessageIdx;
	}

	isCurrentlyFocusingMessage() {
		return this.getCurrentFocusedMessageIdx() !== undefined;
	}

	switchToThread(threadId: string) {
		this._setState({ currentThreadId: threadId });
		void this._rehydrateArchivedMessages(threadId);
	}

	/**
	 * Rehydration (v2 archive contract): when a thread is opened, every
	 * persisted marker whose durable archive verifies is replaced by its full
	 * original text — the conversation is whole again after a restart, while
	 * the PERSISTED copy stays bounded (the next flush re-stubs with a
	 * confirmed archive). One concurrent pass per thread; restored content
	 * is never re-journaled (the ledger holds its own copy).
	 */
	private async _rehydrateArchivedMessages(threadId: string): Promise<void> {
		if (this._rehydratingThreads.has(threadId)) { return; }
		const thread = this._allThreads[threadId];
		if (!thread || !thread.messages.some(m => messageIsStubbed(m as IStorableMessage))) { return; }
		this._rehydratingThreads.add(threadId);
		try {
			const res = await this._threadArchiveService.restoreThreadMessages(threadId, thread.messages as unknown as IStorableMessage[]);
			if (res.restored === 0) {
				if (res.unresolved > 0) {
					this._logService.warn(`[ChatThread] ${res.unresolved} archived message(s) of thread ${threadId} could not be restored (archive missing or failed verification) — shown as markers`);
				}
				return;
			}
			// Preserve concurrent edits/appends, restoring only unchanged message objects.
			const cur = this._allThreads[threadId];
			if (!cur) { return; }
			const messages = mergeRestoredThreadMessages(thread.messages, res.messages as unknown as ChatMessage[], cur.messages);
			const updatedThread = { ...cur, messages };
			const newThreads: ChatThreads = { ...this._allThreads, [threadId]: updatedThread };
			this._setState({ allThreads: newThreads });
			this._logService.info(`[ChatThread] restored ${res.restored} archived message(s) from the thread archive${res.unresolved > 0 ? `; ${res.unresolved} stayed as markers` : ''}`);
			try {
				niTask1ObsPush({ kind: 'store.rehydrate', tags: { threadId }, data: { restored: res.restored, unresolved: res.unresolved } });
			} catch { /* observational only */ }
		} catch (e) {
			this._logService.warn(`[ChatThread] archive rehydration failed: ${getErrorMessage(e)}`);
		} finally {
			this._rehydratingThreads.delete(threadId);
		}
	}


	private _currentWorkspaceUri(): string | undefined {
		return this._workspaceContextService.getWorkspace().folders[0]?.uri.toString();
	}

	openNewThread() {
		// if a thread with 0 messages already exists in the current workspace, switch to it
		for (const threadId in this._allThreads) {
			const t = this._allThreads[threadId];
			if (!t || t.messages.length !== 0) { continue; }
			// only reuse an empty thread that belongs to the current workspace
			const currentUri = this._currentWorkspaceUri();
			if (t.workspaceUri === currentUri) {
				this.switchToThread(threadId);
				return;
			}
		}
		// otherwise, start a new thread
		const newThread = newThreadObject(this._currentWorkspaceUri());

		// update state
		const newThreads: ChatThreads = {
			...this._allThreads,
			[newThread.id]: newThread
		};
		this._storeAllThreads(newThreads);
		this._setState({ allThreads: newThreads, currentThreadId: newThread.id });
	}

	createBackgroundThread(): string {
		const newThread = newThreadObject(this._currentWorkspaceUri());
		const newThreads: ChatThreads = {
			...this._allThreads,
			[newThread.id]: newThread
		};
		this._storeAllThreads(newThreads);
		this._setState({ allThreads: newThreads });
		return newThread.id;
	}

	addBackgroundMessage(threadId: string, message: ChatMessage): void {
		const thread = this._allThreads[threadId];
		if (!thread) { return; }
		const updatedThread = { ...thread, messages: [...thread.messages, message] };
		const newThreads = { ...this._allThreads, [threadId]: updatedThread };
		this._storeAllThreads(newThreads);
		this._setState({ allThreads: newThreads });
	}


	deleteThread(threadId: string): void {
		// delete from the full store
		const newThreads = { ...this._allThreads };
		delete newThreads[threadId];

		// store the updated threads
		this._storeAllThreads(newThreads);
		this._setState({ ...this.state, allThreads: newThreads });
	}

	duplicateThread(threadId: string) {
		const threadToDuplicate = this._allThreads[threadId];
		if (!threadToDuplicate) { return; }
		const newThread = {
			...deepClone(threadToDuplicate),
			id: generateUuid(),
		};
		const newThreads = {
			...this._allThreads,
			[newThread.id]: newThread,
		};
		this._storeAllThreads(newThreads);
		this._setState({ allThreads: newThreads });
	}


	private _addMessageToThread(threadId: string, message: ChatMessage) {
		const oldThread = this._allThreads[threadId];
		if (!oldThread) { return; } // should never happen
		// update state and store it
		const newThreads = {
			...this._allThreads,
			[oldThread.id]: {
				...oldThread,
				lastModified: new Date().toISOString(),
				messages: [
					...oldThread.messages,
					message
				],
			}
		};
		this._storeAllThreads(newThreads);
		this._setState({ allThreads: newThreads }); // the current thread just changed (it had a message added to it)

		// Context Ledger (task M5): mirror the message into the append-only
		// journal. Fire-and-forget — the ledger degrades gracefully and must
		// never block the UI write path.
		//
		// A tool message is added first as `running_now`, whose content is the
		// placeholder "(value not received yet...)", and the real result arrives
		// later as an in-place edit — which never reaches the journal, because the
		// journal is append-only and edits do not pass through here. Journaling the
		// placeholder therefore recorded that a tool ran but never what it returned,
		// which is the half recall and compaction actually need. Skip it here and
		// let `_updateLatestTool` append the completed call instead.
		if (this._ledgerEnabled() && !(message.role === 'tool' && message.type === 'running_now')) {
			this._journalMessage(threadId, message);
		}
	}

	// sets the currently selected message (must be undefined if no message is selected)
	setCurrentlyFocusedMessageIdx(messageIdx: number | undefined) {

		const threadId = this.state.currentThreadId;
		const thread = this._allThreads[threadId];
		if (!thread) { return; }

		this._setState({
			allThreads: {
				...this._allThreads,
				[threadId]: {
					...thread,
					state: {
						...thread.state,
						focusedMessageIdx: messageIdx,
					}
				}
			}
		});

		// // when change focused message idx, jump - do not jump back when click edit, too confusing.
		// if (messageIdx !== undefined)
		// 	this.jumpToCheckpointBeforeMessageIdx({ threadId, messageIdx, jumpToUserModified: true })
	}


	addNewStagingSelection(newSelection: StagingSelectionItem): void {

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx();

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = [];
		let setSelections = (s: StagingSelectionItem[]) => { };

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections;
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s });
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections;
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s });
		}

		// if matches with existing selection, overwrite (since text may change)
		const idx = findStagingSelectionIndex(selections, newSelection);
		if (idx !== null && idx !== -1) {
			setSelections([
				...selections!.slice(0, idx),
				newSelection,
				...selections!.slice(idx + 1, Infinity)
			]);
		}
		// if no match, add it
		else {
			setSelections([...(selections ?? []), newSelection]);
		}
	}


	// Pops the staging selections from the current thread's state
	popStagingSelections(numPops: number): void {

		numPops = numPops ?? 1;

		const focusedMessageIdx = this.getCurrentFocusedMessageIdx();

		// set the selections to the proper value
		let selections: StagingSelectionItem[] = [];
		let setSelections = (s: StagingSelectionItem[]) => { };

		if (focusedMessageIdx === undefined) {
			selections = this.getCurrentThreadState().stagingSelections;
			setSelections = (s: StagingSelectionItem[]) => this.setCurrentThreadState({ stagingSelections: s });
		} else {
			selections = this.getCurrentMessageState(focusedMessageIdx).stagingSelections;
			setSelections = (s) => this.setCurrentMessageState(focusedMessageIdx, { stagingSelections: s });
		}

		setSelections([
			...selections.slice(0, selections.length - numPops)
		]);

	}

	// set message.state
	private _setCurrentMessageState(state: Partial<UserMessageState>, messageIdx: number): void {

		const threadId = this.state.currentThreadId;
		const thread = this._allThreads[threadId];
		if (!thread) { return; }

		this._setState({
			allThreads: {
				...this._allThreads,
				[threadId]: {
					...thread,
					messages: thread.messages.map((m, i) =>
						i === messageIdx && m.role === 'user' ? {
							...m,
							state: {
								...m.state,
								...state
							},
						} : m
					)
				}
			}
		});

	}

	// set thread.state
	private _setThreadState(threadId: string, state: Partial<ThreadType['state']>, doNotRefreshMountInfo?: boolean): void {
		const thread = this._allThreads[threadId];
		if (!thread) { return; }

		this._setState({
			allThreads: {
				...this._allThreads,
				[thread.id]: {
					...thread,
					state: {
						...thread.state,
						...state
					}
				}
			}
		}, doNotRefreshMountInfo);

	}


	// closeCurrentStagingSelectionsInThread = () => {
	// 	const currThread = this.getCurrentThreadState()

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currThread.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newThread = currThread
	// 	newThread.stagingSelections = closedStagingSelections

	// 	this.setCurrentThreadState(newThread)

	// }

	// closeCurrentStagingSelectionsInMessage: IChatThreadService['closeCurrentStagingSelectionsInMessage'] = ({ messageIdx }) => {
	// 	const currMessage = this.getCurrentMessageState(messageIdx)

	// 	// close all stagingSelections
	// 	const closedStagingSelections = currMessage.stagingSelections.map(s => ({ ...s, state: { ...s.state, isOpened: false } }))

	// 	const newMessage = currMessage
	// 	newMessage.stagingSelections = closedStagingSelections

	// 	this.setCurrentMessageState(messageIdx, newMessage)

	// }



	getCurrentThreadState = () => {
		const currentThread = this.getCurrentThread();
		return currentThread.state;
	};
	setCurrentThreadState = (newState: Partial<ThreadType['state']>) => {
		this._setThreadState(this.state.currentThreadId, newState);
	};

	// gets `staging` and `setStaging` of the currently focused element, given the index of the currently selected message (or undefined if no message is selected)

	getCurrentMessageState(messageIdx: number): UserMessageState {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx];
		if (!currMessage || currMessage.role !== 'user') { return defaultMessageState; }
		return currMessage.state;
	}
	setCurrentMessageState(messageIdx: number, newState: Partial<UserMessageState>) {
		const currMessage = this.getCurrentThread()?.messages?.[messageIdx];
		if (!currMessage || currMessage.role !== 'user') { return; }
		this._setCurrentMessageState(newState, messageIdx);
	}



}

registerSingleton(IChatThreadService, ChatThreadService, InstantiationType.Eager);
