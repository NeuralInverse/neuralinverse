/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Episode Summarizer (Context Ledger L1 — task M5, phase 1)
 *
 * Closes one journal segment into an immutable episode summary:
 *
 * 1. Boundary decision (task 6-1) — close on the token target, on idle plus
 *    minimum size, or manually; never closer to the journal end than
 *    `tailMinMessages` entries so the verbatim tail always survives.
 * 2. Episode body generation (task 6-2) — one strict-JSON LLM call over the
 *    segment transcript, a resilient parser, one retry, then a deterministic
 *    mechanical fallback that never fails (D6: degrade, never error).
 * 3. Merge guarantee (task 6-2) — when the LLM leaves `rejected`/`invariants`
 *    empty but the mechanical extraction found some, they are unioned back in:
 *    rejected paths and user rules must survive summarization.
 *
 * DI-free on purpose: the integration layer constructs it directly with the
 * LLM message service it already holds, mirroring ConversationCompactor.
 */

import { IEpisodeBody, IEpisodeSummary, ILedgerEntry, ILedgerStats } from '../common/ledgerTypes.js';
import { DEFAULT_LEDGER_POLICY, ILedgerPolicy } from '../common/ledgerPolicy.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { LLMChatMessage } from '../common/sendLLMMessageTypes.js';
import { ModelSelection } from '../common/voidSettingsTypes.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Result of a boundary check (task 6-1). `null` = nothing pending. */
export interface IEpisodeBoundaryDecision {
	close: boolean
	reason: 'tokens' | 'idle' | 'manual' | 'tail-gap' | 'min'
}

export interface ISummarizeEpisodeOpts {
	threadId: string
	ordinal: number
	entries: ILedgerEntry[]
	range: { fromSeq: number; toSeq: number }
	modelSelection: ModelSelection | null
	/** overrides for the shipped defaults; resolved by the integration layer */
	policy?: ILedgerPolicy
}

// ─── Constants ─────────────────────────────────────────────────────────────────

/** overall cap on the episode-body LLM call */
const SUMMARIZE_TIMEOUT_MS = 90_000
/** no-chunk inactivity during the episode-body LLM call */
const SUMMARIZE_STALL_MS = 45_000
/** rough chars-per-token used for the body size cap */
const CHARS_PER_TOKEN = 4
/** per-line cap for transcript rendering (matches the compactor) */
const TRANSCRIPT_LINE_MAX_CHARS = 20_000
/** mechanical extraction caps (task 6-2 fallback) */
const INVARIANT_MAX_CHARS = 200
const MECHANICAL_TEXT_CAP = 300
/** exact retry message demanded by task 6-2 */
const RETRY_PROMPT = 'Your previous reply was not valid JSON matching the schema. Reply with ONLY the JSON object.'

// ─── Watchdog ──────────────────────────────────────────────────────────────────

/**
 * A resettable inactivity timer. `reset()` is called on every streamed chunk;
 * if no chunk arrives within `timeoutMs`, `onStall` fires exactly once.
 */
function createInactivityWatchdog(timeoutMs: number, onStall: () => void): { reset(): void; dispose(): void } {
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

// ─── Resilient JSON parsing (task 6-2) ────────────────────────────────────────

/**
 * Parse an LLM reply into an IEpisodeBody: slice from the first `{` to the
 * last `}`, repair trailing commas and unclosed brackets, then coerce every
 * field to its declared shape. Returns null when the text is unparseable.
 */
export function parseEpisodeJson(text: string): IEpisodeBody | null {
	if (!text) return null
	const first = text.indexOf('{')
	if (first < 0) return null
	const last = text.lastIndexOf('}')
	// no closer at all (truncated output): take everything to the end and let
	// the repair pass append whatever brackets are missing
	const end = last > first ? last + 1 : text.length
	let parsed: unknown
	try {
		parsed = JSON.parse(repairJsonSlice(text.slice(first, end)))
	} catch {
		return null
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
	return coerceEpisodeBody(parsed as Record<string, unknown>)
}

/**
 * Repair a sliced JSON candidate: drop trailing commas before closers (or end
 * of input) and append whatever closing brackets are missing. String-aware,
 * so commas and brackets inside string values are left untouched.
 */
function repairJsonSlice(src: string): string {
	const kept: string[] = []
	let inStr = false
	let esc = false
	for (let i = 0; i < src.length; i++) {
		const ch = src.charAt(i)
		if (inStr) {
			if (esc) esc = false
			else if (ch === '\\') esc = true
			else if (ch === '"') inStr = false
			kept.push(ch)
			continue
		}
		if (ch === '"') { inStr = true; kept.push(ch); continue }
		if (ch === ',') {
			let j = i + 1
			while (j < src.length && (src.charAt(j) === ' ' || src.charAt(j) === '\t' || src.charAt(j) === '\n' || src.charAt(j) === '\r')) j++
			const next = src.charAt(j)
			if (next === '' || next === '}' || next === ']') continue
		}
		kept.push(ch)
	}
	let s = kept.join('')
	const closers: string[] = []
	inStr = false
	esc = false
	for (const ch of s) {
		if (inStr) {
			if (esc) esc = false
			else if (ch === '\\') esc = true
			else if (ch === '"') inStr = false
			continue
		}
		if (ch === '"') { inStr = true; continue }
		if (ch === '{' || ch === '[') closers.push(ch === '{' ? '}' : ']')
		else if (ch === '}' || ch === ']') closers.pop()
	}
	if (inStr) s += '"'
	while (closers.length > 0) s += closers.pop()
	return s
}

/** Coerce arbitrary parsed JSON into the exact IEpisodeBody shape. */
function coerceEpisodeBody(raw: Record<string, unknown>): IEpisodeBody {
	return {
		goal: coerceTrimmedString(raw.goal),
		decisions: coerceItems(raw.decisions, item => {
			const what = coerceTrimmedString(item.what)
			const why = coerceTrimmedString(item.why)
			if (!what || !why) return undefined
			return { what, why, alternatives: coerceStringArray(item.alternatives), sourceIds: coerceSourceIds(item.sourceIds) }
		}),
		rejected: coerceItems(raw.rejected, item => {
			const approach = coerceTrimmedString(item.approach)
			const reason = coerceTrimmedString(item.reason)
			if (!approach || !reason) return undefined
			return { approach, reason, evidence: coerceTrimmedString(item.evidence) || undefined, sourceIds: coerceSourceIds(item.sourceIds) }
		}),
		failures: coerceItems(raw.failures, item => {
			const attempt = coerceTrimmedString(item.attempt)
			const error = coerceTrimmedString(item.error)
			if (!attempt || !error) return undefined
			const resolution = coerceTrimmedString(item.resolution).toLowerCase()
			return { attempt, error, resolution: resolution === 'fixed' || resolution === 'abandoned' ? resolution : 'open', sourceIds: coerceSourceIds(item.sourceIds) }
		}),
		corrections: coerceItems(raw.corrections, item => {
			const userSaid = coerceTrimmedString(item.userSaid)
			if (!userSaid) return undefined
			return { userSaid, ruleDerived: coerceTrimmedString(item.ruleDerived) || undefined, sourceIds: coerceSourceIds(item.sourceIds) }
		}),
		invariants: coerceStringArray(raw.invariants),
		artifacts: coerceArtifacts(raw.artifacts),
		state: coerceState(raw.state),
		next: coerceStringArray(raw.next),
		openQuestions: coerceStringArray(raw.openQuestions),
	}
}

/** Map a raw array, dropping every item the mapper rejects (missing required strings). */
function coerceItems<T>(v: unknown, map: (item: Record<string, unknown>) => T | undefined): T[] {
	if (!Array.isArray(v)) return []
	const out: T[] = []
	for (const item of v) {
		if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
		const mapped = map(item as Record<string, unknown>)
		if (mapped !== undefined) out.push(mapped)
	}
	return out
}

/** Force a string: strings and finite numbers pass through, everything else is empty. */
function coerceTrimmedString(v: unknown): string {
	if (typeof v === 'string') return v.trim()
	if (typeof v === 'number' && Number.isFinite(v)) return String(v)
	return ''
}

/** Force a list of non-empty strings out of anything. */
function coerceStringArray(v: unknown): string[] {
	if (!Array.isArray(v)) return []
	const out: string[] = []
	for (const item of v) {
		const s = coerceTrimmedString(item)
		if (s) out.push(s)
	}
	return out
}

/** seq citations — numbers preferred, numeric strings tolerated, rest dropped. */
function coerceSourceIds(v: unknown): number[] {
	if (!Array.isArray(v)) return []
	const out: number[] = []
	for (const item of v) {
		const n = typeof item === 'number' ? item : typeof item === 'string' ? Number.parseInt(item, 10) : Number.NaN
		if (Number.isFinite(n)) out.push(n)
	}
	return out
}

function coerceArtifacts(v: unknown): IEpisodeBody['artifacts'] {
	const raw = typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}
	return {
		files: coerceStringArray(raw.files),
		symbols: coerceStringArray(raw.symbols),
		commands: coerceStringArray(raw.commands),
		configs: coerceStringArray(raw.configs),
	}
}

function coerceState(v: unknown): IEpisodeBody['state'] {
	const raw = typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}
	return {
		done: coerceStringArray(raw.done),
		inProgress: coerceStringArray(raw.inProgress),
		verified: coerceStringArray(raw.verified),
	}
}

// ─── Deterministic fallback (task 6-2) ────────────────────────────────────────

/** User-command markers that signal a permanent rule. */
const INVARIANT_MARKER = /از این به بعد|همیشه|هرگز|always|never|do not|don't|prefer|remember to/i
/** Negation markers signaling the user is correcting the assistant's proposal. */
const CORRECTION_MARKER = /\bno\b|نه|اینجوری نه|wrong|instead|بجای/i
/** Error-like words in tool output. */
const FAILURE_WORDS = /error|failed|exception|cannot|denied/i
/** Structural markers that make error-like words trustworthy. */
const FAILURE_MARKER = /stderr|exit\s*code/i
/** A path with at least one separator and a file extension. */
const FILE_PATH_PATTERN_SOURCE = '(?:[a-zA-Z]:)?(?:[\\w@.-]+[/\\\\])+[\\w@.-]+\\.[a-zA-Z0-9]{1,8}'

/**
 * Mechanical episode extraction (task 6-2 fallback): low fidelity, but it
 * NEVER fails — provider down, quota out, garbage JSON, it still produces a
 * valid body with the user's rules and the failed attempts intact.
 */
export function deterministicEpisodeBody(entries: ILedgerEntry[]): IEpisodeBody {
	const body = emptyEpisodeBody()
	const seenInvariants = new Set<string>()
	const seenFiles = new Set<string>()
	let lastUserContent = ''

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]
		if (!entry) continue

		if (entry.role === 'user') {
			for (const sentence of splitSentences(entry.content)) {
				if (!INVARIANT_MARKER.test(sentence)) continue
				const invariant = capChars(sentence, INVARIANT_MAX_CHARS)
				const key = normalizeText(invariant)
				if (!key || seenInvariants.has(key)) continue
				seenInvariants.add(key)
				body.invariants.push(invariant)
			}
			lastUserContent = entry.content.trim()
			if (!body.goal) body.goal = capChars(entry.content.trim(), MECHANICAL_TEXT_CAP)
		}

		if (entry.role === 'tool') {
			const snippet = capChars(entry.content.trim(), MECHANICAL_TEXT_CAP)
			const exitCode = entry.meta?.exitCode
			const failed = exitCode !== undefined && exitCode !== 0
			const errorLike = FAILURE_WORDS.test(snippet) && (exitCode !== undefined || FAILURE_MARKER.test(snippet))
			if (failed || errorLike) {
				body.failures.push({
					attempt: `${entry.name ?? 'tool'} call (seq ${entry.seq})`,
					error: snippet || `exit code ${exitCode}`,
					resolution: 'open',
					sourceIds: [entry.seq],
				})
			}
		}

		// files: tool parameters first, then any path mentioned anywhere in the content
		for (const p of entry.meta?.filePaths ?? []) {
			const path = typeof p === 'string' ? p.trim() : ''
			if (path && !seenFiles.has(path)) { seenFiles.add(path); body.artifacts.files.push(path) }
		}
		collectFilePaths(entry.content, seenFiles, body.artifacts.files)

		// correction: a user reply arriving right after an assistant message,
		// where the USER's reply itself carries a negation marker ("no, not like
		// that") — the marker marks the correcting message, not the corrected one
		if (entry.role === 'user' && i > 0) {
			const prev = entries[i - 1]
			if (prev && prev.role === 'assistant' && CORRECTION_MARKER.test(entry.content)) {
				body.corrections.push({
					userSaid: capChars(entry.content.trim(), MECHANICAL_TEXT_CAP),
					sourceIds: [entry.seq],
				})
			}
		}
	}

	if (lastUserContent) body.state.inProgress.push(capChars(lastUserContent, MECHANICAL_TEXT_CAP))
	return body
}

function emptyEpisodeBody(): IEpisodeBody {
	return {
		goal: '',
		decisions: [],
		rejected: [],
		failures: [],
		corrections: [],
		invariants: [],
		artifacts: { files: [], symbols: [], commands: [], configs: [] },
		state: { done: [], inProgress: [], verified: [] },
		next: [],
		openQuestions: [],
	}
}

/** Split on newlines, then on sentence-ending punctuation (Persian ؟ included). */
function splitSentences(text: string): string[] {
	const out: string[] = []
	for (const line of text.split(/\n+/)) {
		for (const sentence of line.split(/(?<=[.!?؟])\s+/)) {
			const s = sentence.trim()
			if (s) out.push(s)
		}
	}
	return out
}

function collectFilePaths(content: string, seen: Set<string>, out: string[]): void {
	const pattern = new RegExp(FILE_PATH_PATTERN_SOURCE, 'g')
	let match: RegExpExecArray | null
	while ((match = pattern.exec(content)) !== null) {
		const path = match[0]
		if (!seen.has(path)) { seen.add(path); out.push(path) }
	}
}

/** Merge/dedupe key: trim, lowercase, collapse whitespace, drop trailing punctuation. */
function normalizeText(s: string): string {
	return s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?؟,;:]+$/, '')
}

/** Head-keeping clamp with an explicit marker — only for prose, never identifiers. */
function capChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text
	return text.slice(0, maxChars - 1).trimEnd() + '…'
}

// ─── Merge + size cap (task 6-2) ──────────────────────────────────────────────

/**
 * Merge guarantee: when the LLM produced empty `rejected`/`invariants` but the
 * mechanical extraction found some, union them in — appended after the LLM
 * items, deduped by normalized text. Union, never replacement.
 */
function mergeMechanicalInto(body: IEpisodeBody, mechanical: IEpisodeBody): void {
	if (body.invariants.length === 0 && mechanical.invariants.length > 0) {
		const seen = new Set(body.invariants.map(normalizeText))
		for (const invariant of mechanical.invariants) {
			const key = normalizeText(invariant)
			if (!seen.has(key)) { seen.add(key); body.invariants.push(invariant) }
		}
	}
	if (body.rejected.length === 0 && mechanical.rejected.length > 0) {
		const seen = new Set(body.rejected.map(r => normalizeText(r.approach)))
		for (const rejected of mechanical.rejected) {
			const key = normalizeText(rejected.approach)
			if (!seen.has(key)) { seen.add(key); body.rejected.push(rejected) }
		}
	}
}

/**
 * Deterministic size cap for the frozen body: the JSON stays under
 * `episodeSummaryMaxTokens * 4` chars. `invariants` and `rejected` items are
 * never truncated — when the budget is tight the oldest extras of any list are
 * dropped whole instead, in the sacrifice order of task 6-3 (artifacts first,
 * invariants/rejected dead last).
 */
function capEpisodeBody(body: IEpisodeBody, episodeSummaryMaxTokens: number): IEpisodeBody {
	const maxChars = episodeSummaryMaxTokens * CHARS_PER_TOKEN
	const size = () => JSON.stringify(body).length
	if (size() <= maxChars) return body

	// 1) clamp free-text prose (artifacts stay verbatim — identifiers must never be mangled)
	clampBodyScalars(body, 400)
	if (size() <= maxChars) return body
	clampBodyScalars(body, 160)
	if (size() <= maxChars) return body

	// 2) drop oldest extras, most expendable lists first
	const dropLists: unknown[][] = [
		body.artifacts.files, body.artifacts.symbols, body.artifacts.commands, body.artifacts.configs,
		body.openQuestions, body.next,
		body.state.done, body.state.inProgress, body.state.verified,
		body.failures, body.corrections, body.decisions,
		body.invariants, body.rejected,
	]
	for (const list of dropLists) {
		while (list.length > 0 && size() > maxChars) list.shift()
		if (size() <= maxChars) break
	}
	return body
}

/** Clamp free-text scalars in place — invariants, rejected and artifacts are exempt. */
function clampBodyScalars(body: IEpisodeBody, maxChars: number): void {
	body.goal = capChars(body.goal, maxChars)
	for (const d of body.decisions) {
		d.what = capChars(d.what, maxChars)
		d.why = capChars(d.why, maxChars)
		if (d.alternatives) d.alternatives = d.alternatives.map(a => capChars(a, maxChars))
	}
	for (const f of body.failures) {
		f.attempt = capChars(f.attempt, maxChars)
		f.error = capChars(f.error, maxChars)
	}
	for (const c of body.corrections) {
		c.userSaid = capChars(c.userSaid, maxChars)
		if (c.ruleDerived) c.ruleDerived = capChars(c.ruleDerived, maxChars)
	}
	clampStringList(body.next, maxChars)
	clampStringList(body.openQuestions, maxChars)
	clampStringList(body.state.done, maxChars)
	clampStringList(body.state.inProgress, maxChars)
	clampStringList(body.state.verified, maxChars)
}

function clampStringList(list: string[], maxChars: number): void {
	for (let i = 0; i < list.length; i++) {
		const s = list[i]
		if (s !== undefined) list[i] = capChars(s, maxChars)
	}
}

// ─── Episode summarizer ────────────────────────────────────────────────────────

export class EpisodeSummarizer {

	private readonly llmService: ILLMMessageService

	constructor(llmService: ILLMMessageService) {
		this.llmService = llmService
	}

	// ── Boundary decision (task 6-1) ─────────────────────────────────────────

	/**
	 * Pure decision — no journal access, no clock reads. `tailEntryCount` is
	 * the number of entries that would stay verbatim after the boundary; the
	 * close is refused when fewer than `tailMinMessages` would remain, unless
	 * forced (manual /compact, end-of-thread recovery).
	 */
	static decideBoundary(
		stats: ILedgerStats,
		tailEntryCount: number,
		idleMs: number,
		policy: ILedgerPolicy,
		opts?: { force?: boolean },
	): IEpisodeBoundaryDecision | null {
		if (opts?.force) return { close: true, reason: 'manual' }
		const tailOk = tailEntryCount >= policy.tailMinMessages
		if (stats.unsummarizedTokens >= policy.episodeTargetTokens) {
			return tailOk ? { close: true, reason: 'tokens' } : { close: false, reason: 'tail-gap' }
		}
		if (idleMs > policy.cacheIdleCompactMs) {
			if (stats.unsummarizedTokens < policy.episodeMinTokens) return { close: false, reason: 'min' }
			return tailOk ? { close: true, reason: 'idle' } : { close: false, reason: 'tail-gap' }
		}
		return null
	}

	// ── Episode generation (task 6-2) ────────────────────────────────────────

	/**
	 * Build the frozen summary for one episode. Never throws: no model, an LLM
	 * failure, or invalid JSON after one retry all degrade to the deterministic
	 * mechanical body (D6).
	 */
	async summarizeEpisode(opts: ISummarizeEpisodeOpts): Promise<IEpisodeSummary> {
		const { threadId, ordinal, entries, range, modelSelection } = opts
		const policy = opts.policy ?? DEFAULT_LEDGER_POLICY

		const mechanical = deterministicEpisodeBody(entries)
		let body: IEpisodeBody | null = null

		if (modelSelection && entries.length > 0) {
			const transcript = entries.map(e => this._renderEntryLine(e)).join('\n')
			for (let attempt = 0; attempt < 2 && !body; attempt++) {
				const text = await this._callEpisodeLLM(transcript, range, modelSelection, attempt > 0).catch(() => undefined)
				if (!text) continue
				body = parseEpisodeJson(text)
			}
		}

		const usedLLM = body !== null
		if (!body) body = mechanical
		else mergeMechanicalInto(body, mechanical)

		return {
			id: `ep_${threadId}_${ordinal}`,
			threadId,
			ordinal,
			range,
			createdAt: Date.now(),
			producedBy: usedLLM ? 'llm' : 'deterministic',
			model: usedLLM && modelSelection ? modelSelection.modelName : undefined,
			frozen: true,
			body: capEpisodeBody(body, policy.episodeSummaryMaxTokens),
		}
	}

	// ── LLM call (mirrors ConversationCompactor._summarize) ──────────────────

	private async _callEpisodeLLM(transcript: string, range: { fromSeq: number; toSeq: number }, modelSelection: ModelSelection, isRetry: boolean): Promise<string> {
		const systemPrompt = this._episodeSystemPrompt()
		const userPrompt = [
			`Episode transcript (journal seq ${range.fromSeq}-${range.toSeq}, oldest first). Cite each line header's seq number as its sourceId.`,
			transcript,
			isRetry ? RETRY_PROMPT : '',
		].filter(s => s !== '').join('\n')

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
				reject(new Error('Episode summarization stream stalled'))
			})
			const overall = setTimeout(() => {
				if (settled) return
				settled = true
				watchdog.dispose()
				reject(new Error('Episode summarization timed out'))
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
				// Pure JSON generation — no tools, no chat-mode extras.
				chatMode: null,
				allowedToolNames: [],
				messages: requestMessages,
				modelSelection,
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				separateSystemMessage,
				logging: { loggingName: 'EpisodeSummarizer' },
				onText: () => { watchdog.reset() },
				onFinalMessage: (p) => finish(() => {
					const text = (p.fullText || '').trim()
					if (!text) reject(new Error('Episode summarization returned empty output'))
					else resolve(text)
				}),
				onError: (p) => finish(() => reject(new Error(p.message || p.fullError?.message || 'Episode summarization failed'))),
				onAbort: () => finish(() => reject(new Error('Episode summarization aborted'))),
			})
		})
	}

	private _episodeSystemPrompt(): string {
		return [
			'You are an engineering historian for a coding assistant. You close one episode of a long conversation into a permanent, structured record that will REPLACE the episode as the only memory of it.',
			'Reply with STRICT JSON ONLY — no markdown fences, no commentary — with EXACTLY these fields:',
			'{',
			'  "goal": string,',
			'  "decisions": [{ "what": string, "why": string, "alternatives"?: string[], "sourceIds": number[] }],',
			'  "rejected": [{ "approach": string, "reason": string, "evidence"?: string, "sourceIds": number[] }],',
			'  "failures": [{ "attempt": string, "error": string, "resolution": "fixed" | "abandoned" | "open", "sourceIds": number[] }],',
			'  "corrections": [{ "userSaid": string, "ruleDerived"?: string, "sourceIds": number[] }],',
			'  "invariants": string[],',
			'  "artifacts": { "files": string[], "symbols": string[], "commands": string[], "configs": string[] },',
			'  "state": { "done": string[], "inProgress": string[], "verified": string[] },',
			'  "next": string[],',
			'  "openQuestions": string[]',
			'}',
			'Rules (absolute):',
			'- Every claim MUST cite its evidence as sourceIds: the seq numbers of the transcript line headers it came from.',
			'- Never guess. If the transcript does not support a field, use an empty array or an empty string.',
			'- ANY approach the user rejected or that failed MUST appear in rejected/failures, even if it seems minor.',
			'- Never abbreviate identifiers: file paths, error messages and names go in verbatim.',
			'- Empty arrays when nothing applies; no extra fields.',
		].join('\n')
	}

	// ── Rendering ────────────────────────────────────────────────────────────

	/** One transcript block per entry; the seq in the header is what sourceIds cite. */
	private _renderEntryLine(e: ILedgerEntry): string {
		const tag = e.role === 'tool' ? `TOOL(${e.name ?? 'unknown'})` : e.role.toUpperCase()
		// Bound each line so a single huge tool output can't dominate the transcript.
		const content = e.content.length > TRANSCRIPT_LINE_MAX_CHARS
			? e.content.slice(0, 10_000) + `\n…[${e.content.length - 14_000} chars omitted]…\n` + e.content.slice(-4_000)
			: e.content
		return `[[${tag} seq=${e.seq}]]\n${content}`
	}
}
