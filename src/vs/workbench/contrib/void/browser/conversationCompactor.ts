/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Conversation Compactor
 *
 * Professional context management before a request is sent to the model,
 * modeled on opencode's auto-compaction:
 *
 * 1. Token accounting — cheap per-message estimates (chars/4 + overhead).
 * 2. Threshold check — compact only when the conversation approaches the
 *    model's context window, never for small threads.
 * 3. Safe boundary — old messages are only folded away at a `user` message
 *    boundary so assistant→tool_result pairs are never split apart.
 * 4. LLM summarization — the folded prefix is summarized into one dense,
 *    structured `user` message (`<conversation_summary>…</conversation_summary>`).
 * 5. Cached — a summary is computed once per prefix; later turns reuse it and
 *    only the newly aged-out messages get summarized on the next compaction.
 *
 * A deterministic truncation fallback guarantees a request can always be sent
 * even when the summarization call itself fails.
 *
 * This class is DI-free on purpose: both the Void chat layer
 * (ChatThreadService) and the Neural Inverse executor (AgentExecutor)
 * construct it directly with the services they already hold.
 */

import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { LLMChatMessage } from '../common/sendLLMMessageTypes.js';
import { ModelSelection } from '../common/voidSettingsTypes.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Minimal message shape the compactor operates on. */
export interface CompactableMessage {
	role: 'user' | 'assistant' | 'tool';
	content: string;
	/** tool name, for tool-role messages */
	name?: string;
}

export interface ICompactionResult {
	/** 0 when nothing was compacted; otherwise messages[0..keepFromIdx) were folded into `summary` */
	keepFromIdx: number;
	/** The summarized prefix, if a compaction happened */
	summary: string | undefined;
	/** true when the LLM produced the summary (false = deterministic fallback) */
	usedLLM: boolean;
	tokensBefore: number;
	tokensAfter: number;
}

interface ICacheEntry {
	/** number of prefix messages covered by the summary */
	coveredCount: number;
	/** fingerprint of the last covered message, to detect thread rewrites/checkpoint rewinds */
	fingerprint: string;
	summary: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;
/** flat token overhead per message (role/framing), matches other tools' estimates */
const TOKENS_PER_MESSAGE_OVERHEAD = 8;
/** never compact threads smaller than this many messages */
const MIN_MESSAGES_TO_COMPACT = 8;
/** fraction of the available window at which compaction triggers */
const COMPACT_THRESHOLD = 0.72;
/** how many recent messages always stay verbatim (lower bound) */
const MIN_TAIL_MESSAGES = 8;
/** tokens reserved for the system prompt + tool schemas (they are large) */
export const SYSTEM_RESERVE_TOKENS = 10_000;
/** overall cap on the summarization call */
const SUMMARIZE_TIMEOUT_MS = 90_000;
/** no-chunk inactivity during the summarization call */
const SUMMARIZE_STALL_MS = 45_000;

// ─── Error classification ──────────────────────────────────────────────────────

/** Provider errors that mean "the request does not fit the context window". */
export function isContextOverflowError(message: string | undefined): boolean {
	if (!message) return false;
	return /context length|context window|context_length|exceeds?\s+(the\s+)?(maximum\s+)?(context|tokens|input)|maximum.*tokens?|too many tokens|prompt is too long|input.*too long|reduce the length|input_length|MAX_TOKENS/i.test(message)
}

/** Provider errors worth retrying (transient). Anything else should fail fast. */
export function isRetryableLlmError(message: string | undefined): boolean {
	if (!message) return false;
	return /\b429\b|rate.?limit|overloaded|quota|timeout|timed out|fetch failed|network|econnreset|econnrefused|enotfound|socket hang up|\b50[0-4]\b|service unavailable|internal server|temporarily/i.test(message)
}

// ─── Watchdog ──────────────────────────────────────────────────────────────────

/**
 * A resettable inactivity timer. `reset()` is called on every streamed chunk;
 * if no chunk arrives within `timeoutMs`, `onStall` fires exactly once.
 */
export function createInactivityWatchdog(timeoutMs: number, onStall: () => void): { reset(): void; dispose(): void } {
	let timer: ReturnType<typeof setTimeout> | undefined
	let disposed = false
	const arm = () => {
		if (disposed) return
		if (timer !== undefined) clearTimeout(timer)
		timer = setTimeout(() => { if (!disposed) onStall() }, timeoutMs)
	}
	arm()
	return {
		reset: arm,
		dispose() { disposed = true; if (timer !== undefined) clearTimeout(timer) },
	}
}

// ─── Compactor ─────────────────────────────────────────────────────────────────

export class ConversationCompactor {

	/** Per-thread (or per-agent) summary cache */
	private readonly _cache = new Map<string, ICacheEntry>();

	constructor(private readonly llmService: ILLMMessageService) {}

	invalidateCache(cacheKey: string) {
		this._cache.delete(cacheKey)
	}

	// ── Token accounting ─────────────────────────────────────────────────────

	static estimateTextTokens(text: string): number {
		return Math.ceil(text.length / CHARS_PER_TOKEN) + TOKENS_PER_MESSAGE_OVERHEAD
	}

	estimateTokens(messages: CompactableMessage[]): number {
		let total = 0
		for (const m of messages) total += ConversationCompactor.estimateTextTokens(m.content)
		return total
	}

	/** Tokens that fit for input, after output and system/tool reservations. */
	static availableInputTokens(contextWindow: number, reservedOutputTokenSpace: number | null | undefined): number {
		const outputReserve = Math.max(Math.floor(contextWindow / 4), reservedOutputTokenSpace ?? 4_096)
		return Math.max(contextWindow - outputReserve - SYSTEM_RESERVE_TOKENS, 4_000)
	}

	// ─── Main pipeline ───────────────────────────────────────────────────────

	/**
	 * Decide whether `messages` need compaction and, if so, produce a summary of
	 * the aged prefix. The caller is responsible for assembling the final array:
	 *   [ {role:'user', content: summaryMsg}, ...messages.slice(keepFromIdx) ]
	 *
	 * Never throws — on any failure it falls back to deterministic truncation or
	 * reports "no compaction" so the send path is never blocked.
	 */
	async compactIfNeeded(opts: {
		messages: CompactableMessage[];
		contextWindow: number;
		reservedOutputTokenSpace?: number | null;
		modelSelection: ModelSelection | null;
		cacheKey?: string;
		/** compact even when under the threshold (context-overflow recovery, manual compact) */
		force?: boolean;
	}): Promise<ICompactionResult> {
		const { messages, contextWindow, modelSelection, cacheKey, force } = opts
		const available = ConversationCompactor.availableInputTokens(contextWindow, opts.reservedOutputTokenSpace)
		const tokensBefore = this.estimateTokens(messages)

		const noCompact: ICompactionResult = { keepFromIdx: 0, summary: undefined, usedLLM: false, tokensBefore, tokensAfter: tokensBefore }

		if (messages.length < MIN_MESSAGES_TO_COMPACT && !force) return noCompact
		if (!force && tokensBefore <= Math.floor(available * COMPACT_THRESHOLD)) return noCompact

		// ── Pick a safe split point: a `user` message, keeping at least MIN_TAIL_MESSAGES verbatim ──
		let keepFromIdx = this._findSafeBoundary(messages)
		if (keepFromIdx <= 0) return noCompact

		// fold less if the tail alone is already close to the window (summarize a smaller prefix is pointless then)
		// or fold more if the tail is still over budget
		keepFromIdx = this._fitBoundaryToBudget(messages, keepFromIdx, available)

		const prefix = messages.slice(0, keepFromIdx)
		if (prefix.length === 0) return noCompact

		const cacheEntry = cacheKey ? this._lookupCache(cacheKey, messages) : undefined
		// The cached summary covers cacheEntry.coveredCount messages; only messages
		// beyond that need to be folded into a new summary.
		const alreadyCovered = cacheEntry ? Math.min(cacheEntry.coveredCount, prefix.length) : 0

		const summary = await this._summarize({
			priorSummary: alreadyCovered > 0 && cacheEntry ? cacheEntry.summary : undefined,
			messages: prefix.slice(alreadyCovered),
			modelSelection,
		}).catch(() => undefined)

		if (summary) {
			if (cacheKey) {
				this._cache.set(cacheKey, {
					coveredCount: keepFromIdx,
					fingerprint: this._fingerprint(messages[keepFromIdx - 1]),
					summary,
				})
			}
			const tokensAfter = ConversationCompactor.estimateTextTokens(summary) + this.estimateTokens(messages.slice(keepFromIdx))
			return { keepFromIdx, summary, usedLLM: true, tokensBefore, tokensAfter }
		}

		// ── Deterministic fallback: hard-truncate the prefix ──
		const truncatedPrefix = prefix.map(m => ({
			...m,
			content: m.content.length > 2_000
				? m.content.slice(0, 1_200) + `\n…[truncated ${m.content.length - 1_600} chars]…\n` + m.content.slice(-400)
				: m.content,
		}))
		const fallbackSummary = this._renderSummaryHeader() + truncatedPrefix.map(m => this._renderMessageLine(m)).join('\n')
		const tokensAfter = ConversationCompactor.estimateTextTokens(fallbackSummary) + this.estimateTokens(messages.slice(keepFromIdx))
		return { keepFromIdx, summary: fallbackSummary, usedLLM: false, tokensBefore, tokensAfter }
	}

	// ─── Boundary selection ──────────────────────────────────────────────────

	/**
	 * Index of the first message to keep verbatim. Must be a `user` message so
	 * no assistant→tool_result pair is ever split, and must keep at least
	 * MIN_TAIL_MESSAGES messages. Returns -1 when no safe boundary exists.
	 */
	private _findSafeBoundary(messages: CompactableMessage[]): number {
		const minKeep = Math.min(MIN_TAIL_MESSAGES, Math.max(1, Math.floor(messages.length / 2)))
		for (let i = Math.max(1, messages.length - Math.max(MIN_TAIL_MESSAGES, minKeep) - 4); i < messages.length - 2; i++) {
			if (messages[i].role === 'user' && i >= 1 && messages.length - i >= minKeep) return i
		}
		// second pass, further back (fold more) when the tail is fat
		for (let i = 1; i < messages.length - minKeep; i++) {
			if (messages[i].role === 'user') return i
		}
		return -1
	}

	/** Grow/shrink the kept tail so summary + tail plausibly fit the window. */
	private _fitBoundaryToBudget(messages: CompactableMessage[], keepFromIdx: number, available: number): number {
		let idx = keepFromIdx
		let tailTokens = this.estimateTokens(messages.slice(idx))
		const summaryBudget = 3_000 // summary is capped near this anyway
		// If the tail alone overflows, fold more (move boundary earlier) while a safe split exists.
		while (tailTokens + summaryBudget > available && idx > 1) {
			let next = -1
			for (let i = idx - 1; i >= 1; i--) {
				if (messages[i].role === 'user') { next = i; break }
			}
			if (next <= 0) break
			idx = next
			tailTokens = this.estimateTokens(messages.slice(idx))
		}
		return idx
	}

	// ─── Summarization LLM call ───────────────────────────────────────────────

	private async _summarize(opts: {
		priorSummary: string | undefined;
		messages: CompactableMessage[];
		modelSelection: ModelSelection | null;
	}): Promise<string> {
		const { priorSummary, messages, modelSelection } = opts
		if (messages.length === 0) return priorSummary ?? ''
		if (!modelSelection) return Promise.reject(new Error('No model selected for summarization'))

		const transcript = messages.map(m => this._renderMessageLine(m)).join('\n')

		const systemPrompt = [
			'You are a precise conversation summarizer for a coding assistant.',
			'Your summary will REPLACE the older messages as the only memory of them, so the assistant must be able to continue working from it without loss.',
			'Write a dense, factual summary in structured markdown with exactly these sections:',
			'## Objective — what the user wants to achieve (their words, condensed).',
			'## Requirements & Constraints — explicit rules, style preferences, limits the user stated.',
			'## Key Decisions — decisions made so far and why.',
			'## Files & Artifacts — every file path, symbol, branch, command, API or config value that was read, created or modified, with its important values.',
			'## Tool Activity — tool/terminal results that affect the state of work (errors and how they were resolved, installs, builds, git operations).',
			'## Current State — what is done, what is in progress, what is verified.',
			'## Next Steps — the immediate actions the assistant was about to take.',
			'Rules: never invent facts; never drop identifiers (paths, error messages, names); prefer bullet lists; no pleasantries; no commentary about summarizing.',
		].join('\n')

		const userPrompt = [
			priorSummary ? `<previous_summary>\n${priorSummary}\n</previous_summary>\n` : '',
			'Transcript to summarize (oldest first):\n',
			transcript,
		].join('\n')

		// Providers disagree on where a system prompt may live: Anthropic/Bedrock
		// take it as a separate parameter, Gemini needs `parts` messages, and the
		// OpenAI-compatible impl only honors a `system` role inside `messages`.
		const providerName = modelSelection.providerName
		let requestMessages: LLMChatMessage[]
		let separateSystemMessage: string | undefined
		if (providerName === 'gemini') {
			requestMessages = [{ role: 'user', parts: [{ text: userPrompt }] }]
			separateSystemMessage = systemPrompt
		}
		else if (providerName === 'anthropic' || providerName === 'awsBedrock') {
			requestMessages = [{ role: 'user', content: userPrompt }]
			separateSystemMessage = systemPrompt
		}
		else {
			requestMessages = [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userPrompt },
			]
			separateSystemMessage = undefined
		}

		return new Promise<string>((resolve, reject) => {
			let settled = false
			const watchdog = createInactivityWatchdog(SUMMARIZE_STALL_MS, () => {
				if (settled) return
				settled = true
				reject(new Error('Summarization stream stalled'))
			})
			const overall = setTimeout(() => {
				if (settled) return
				settled = true
				watchdog.dispose()
				reject(new Error('Summarization timed out'))
			}, SUMMARIZE_TIMEOUT_MS)

			const finish = (fn: () => void) => {
				if (settled) return
				settled = true
				clearTimeout(overall)
				watchdog.dispose()
				fn()
			}

			this.llmService.sendLLMMessage({
				messagesType: 'chatMessages',
				// Pure text summarization — no tools, no chat-mode extras.
				chatMode: null,
				allowedToolNames: [],
				messages: requestMessages,
				modelSelection,
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				separateSystemMessage,
				logging: { loggingName: 'ConversationCompactor' },
				onText: () => { watchdog.reset() },
				onFinalMessage: (p) => finish(() => {
					const text = (p.fullText || '').trim()
					if (!text) reject(new Error('Summarization returned empty output'))
					else resolve(text)
				}),
				onError: (p) => finish(() => reject(new Error(p.message || p.fullError?.message || 'Summarization failed'))),
				onAbort: () => finish(() => reject(new Error('Summarization aborted'))),
			})
		})
	}

	// ─── Rendering & cache helpers ────────────────────────────────────────────

	private _renderMessageLine(m: CompactableMessage): string {
		const tag = m.role === 'tool' ? `TOOL(${m.name ?? 'unknown'})` : m.role.toUpperCase()
		// Bound each line so a single huge tool output can't dominate the transcript.
		const content = m.content.length > 20_000
			? m.content.slice(0, 10_000) + `\n…[${m.content.length - 14_000} chars omitted]…\n` + m.content.slice(-4_000)
			: m.content
		return `[[${tag}]]\n${content}`
	}

	private _renderSummaryHeader(): string {
		return `(Deterministic compaction — the LLM summarizer was unavailable. Older messages were truncated, not summarized.)\n\n`
	}

	private _fingerprint(m: CompactableMessage | undefined): string {
		if (!m) return ''
		return `${m.role}:${m.content.length}:${m.content.slice(-64)}`
	}

	private _lookupCache(cacheKey: string, messages: CompactableMessage[]): ICacheEntry | undefined {
		const entry = this._cache.get(cacheKey)
		if (!entry) return undefined
		// Thread was rewound/rewritten (checkpoint restore) → summary no longer aligned.
		if (entry.coveredCount > messages.length) { this._cache.delete(cacheKey); return undefined }
		if (this._fingerprint(messages[entry.coveredCount - 1]) !== entry.fingerprint) {
			this._cache.delete(cacheKey)
			return undefined
		}
		return entry
	}
}

// ─── Executor-side helpers ─────────────────────────────────────────────────────

/**
 * Deterministic size cap for a single tool result before it is appended to a
 * plain-text history (the AgentExecutor feedback path). Keeps the head and the
 * tail, which is where the actionable information lives.
 */
export function capToolResultForHistory(result: string, maxChars = 24_000): string {
	if (result.length <= maxChars) return result
	const head = Math.floor(maxChars * 0.7)
	const tail = Math.floor(maxChars * 0.2)
	return result.slice(0, head) + `\n…[output truncated: ${result.length} chars total]…\n` + result.slice(-tail)
}

/** Wrap a summary into the canonical user message that represents folded history. */
export function renderConversationSummaryMessage(summary: string): string {
	return `<conversation_summary>\n${summary}\n</conversation_summary>\n\n(Earlier conversation was summarized above to free context. Continue assisting the user; the most recent messages follow.)`
}
