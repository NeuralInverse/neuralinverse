/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Context Ledger — pure journal core (task M5, phase 0)
 *
 * Everything about the ledger that needs no filesystem lives here so it can be
 * unit-tested without VS Code: JSONL encode/decode, gapless sequence tracking,
 * the rotation threshold, the inline/blob split, stats, and transcript
 * rendering.
 *
 * Zero `vs/` imports on purpose — the DI shell (browser/contextLedgerService)
 * owns all disk access and calls into this module for every decision.
 */

import { ILedgerEntry, LedgerRole } from './ledgerTypes.js';
import { ILedgerPolicy } from './ledgerPolicy.js';

// ─── Entry encode/decode ──────────────────────────────────────────────────────

/** Serialize one entry as a single JSONL line (no trailing newline). */
export function encodeEntry(entry: ILedgerEntry): string {
	return JSON.stringify(entry);
}

const VALID_ROLES: readonly LedgerRole[] = ['user', 'assistant', 'tool', 'system', 'note'];

/** True when `raw` has the shape of a well-formed journal entry. */
function isValidEntry(raw: unknown): raw is ILedgerEntry {
	if (typeof raw !== 'object' || raw === null) { return false; }
	const e = raw as Record<string, unknown>;
	return typeof e.id === 'string'
		&& typeof e.seq === 'number' && Number.isInteger(e.seq) && e.seq >= 0
		&& typeof e.threadId === 'string'
		&& typeof e.role === 'string' && (VALID_ROLES as readonly string[]).includes(e.role)
		&& typeof e.content === 'string'
		&& typeof e.ts === 'number'
		&& typeof e.tokens === 'number';
}

/**
 * Tolerant decode of one JSONL line: blank or corrupt lines return null so a
 * damaged journal never takes the whole ledger down (task section 9).
 */
export function decodeEntry(line: string): ILedgerEntry | null {
	const trimmed = line.trim();
	if (!trimmed) { return null; }
	try {
		const raw: unknown = JSON.parse(trimmed);
		return isValidEntry(raw) ? raw : null;
	} catch {
		return null;
	}
}

/** Decode a whole journal file's text; blank/corrupt lines are skipped. */
export function decodeEntries(text: string): ILedgerEntry[] {
	const entries: ILedgerEntry[] = [];
	for (const line of text.split('\n')) {
		const entry = decodeEntry(line);
		if (entry) { entries.push(entry); }
	}
	return entries;
}

// ─── Sequence tracking ────────────────────────────────────────────────────────

/**
 * Gapless, ascending per-thread sequence numbers.
 *
 * One instance owns one thread's seq space: `next()` hands out 1, 2, 3… with
 * no holes, and `observe()` checks a decoded stream for gaps so corruption or
 * a lost flush is detected on read (task section 7, phase 0).
 */
export class JournalSeq {

	private _last: number;

	constructor(startSeq: number = 0) {
		this._last = startSeq;
	}

	/** The highest seq assigned or observed so far (0 = nothing yet). */
	get last(): number { return this._last; }

	/** The seq the next appended entry or observed line must carry. */
	get nextExpected(): number { return this._last + 1; }

	/** Assign the next gapless seq. */
	next(): number {
		this._last += 1;
		return this._last;
	}

	/**
	 * Feed one seq from a decoded stream. Returns false on a gap, a duplicate
	 * or a rewind; a gap still realigns `last` past the hole so only the first
	 * offending line of a tear is reported.
	 */
	observe(seq: number): boolean {
		if (seq === this.nextExpected) {
			this._last = seq;
			return true;
		}
		if (seq > this.nextExpected) {
			this._last = seq;
		}
		return false;
	}
}

// ─── Rotation & file names ────────────────────────────────────────────────────

/**
 * True once the current journal file is at/over the rotation size — the next
 * appended line must start a fresh file (task section 4: rotate at 8 MiB).
 */
export function shouldRotate(currentBytes: number, policy: ILedgerPolicy): boolean {
	return currentBytes >= policy.journalRotateBytes;
}

/** `journal/000001.jsonl` — zero-padded so lexical order === numeric order. */
export function journalFileName(fileNo: number): string {
	return `${String(fileNo).padStart(6, '0')}.jsonl`;
}

/** `episodes/ep-000001.json` — write-once frozen episode summaries. */
export function episodeFileName(ordinal: number): string {
	return `ep-${String(ordinal).padStart(6, '0')}.json`;
}

// ─── Inline/blob split ────────────────────────────────────────────────────────

function fallbackBlobId(): string {
	return `blob_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Oversized bodies never go inline: the journal keeps a 70% head + 20% tail
 * window with a marker pointing at the blob, and the full text is written as
 * `blobs/<id>` beside the journal (task section 4). Content at or under
 * `inlineMaxChars` stays inline with no blobRef.
 */
export function splitContent(content: string, policy: ILedgerPolicy, blobId?: string): { inline: string; blobRef: string | undefined } {
	if (content.length <= policy.inlineMaxChars) {
		return { inline: content, blobRef: undefined };
	}
	const head = Math.floor(policy.inlineMaxChars * 0.7);
	const tail = Math.floor(policy.inlineMaxChars * 0.2);
	const blobRef = `blobs/${blobId ?? fallbackBlobId()}`;
	const inline = content.slice(0, head)
		+ `\n…[blob ${blobRef}: ${content.length} chars total]…\n`
		// slice from the end by length, NOT slice(-tail): tail === 0 would
		// otherwise splice the whole content back in
		+ content.slice(content.length - tail);
	return { inline, blobRef };
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface IJournalStats {
	entryCount: number;
	totalTokens: number;
	unsummarizedTokens: number;
	lastSeq: number;
	episodeCount: number;
}

/** Pure fold over journal entries + closed-episode ranges (task section 5). */
export function computeStats(entries: ILedgerEntry[], episodes: { fromSeq: number; toSeq: number }[]): IJournalStats {
	let entryCount = 0;
	let totalTokens = 0;
	let lastSeq = 0;
	for (const e of entries) {
		entryCount++;
		totalTokens += e.tokens;
		if (e.seq > lastSeq) { lastSeq = e.seq; }
	}
	let maxToSeq = 0;
	for (const ep of episodes) {
		if (ep.toSeq > maxToSeq) { maxToSeq = ep.toSeq; }
	}
	// unsummarized = everything after the last closed episode's end
	let unsummarizedTokens = 0;
	for (const e of entries) {
		if (e.seq > maxToSeq) { unsummarizedTokens += e.tokens; }
	}
	return { entryCount, totalTokens, unsummarizedTokens, lastSeq, episodeCount: episodes.length };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

const RENDER_LINE_MAX_CHARS = 20_000;

/**
 * Render one entry as a transcript line, `[[USER]]\n…` / `[[TOOL(name)]]\n…`,
 * with the same 20k-char bounding as ConversationCompactor._renderMessageLine
 * so one giant tool output can't dominate a summarized window.
 */
export function renderEntryLine(e: ILedgerEntry): string {
	const tag = e.role === 'tool' ? `TOOL(${e.name ?? 'unknown'})` : e.role.toUpperCase();
	const content = e.content.length > RENDER_LINE_MAX_CHARS
		? e.content.slice(0, 10_000) + `\n…[${e.content.length - 14_000} chars omitted]…\n` + e.content.slice(-4_000)
		: e.content;
	return `[[${tag}]]\n${content}`;
}

// ─── Read consistency (task F03) ─────────────────────────────────────────────

/**
 * Newest-N tail selection over the union of the durable store and the pending
 * overlay.
 *
 * Read contract: returns the newest `maxEntries` UNIQUE entries (deduped by
 * seq) in ascending order, or fewer when the journal is shorter. During a
 * flush an entry can exist in BOTH stores until the pending overlay is
 * trimmed — the seq dedupe makes either copy count once. `durableNewestFirst`
 * carries one array per journal file, newest file first, each ascending; an
 * empty or negative `maxEntries` yields an empty tail.
 */
export function selectTailNewestFirst(durableNewestFirst: ILedgerEntry[][], pending: ILedgerEntry[], maxEntries: number): ILedgerEntry[] {
	if (maxEntries <= 0) { return []; }
	const bySeq = new Map<number, ILedgerEntry>();
	const consider = (e: ILedgerEntry): void => {
		if (!bySeq.has(e.seq)) { bySeq.set(e.seq, e); }
	};
	// pending entries are the newest by construction (seq is monotonic) —
	// newest first, capped, so a large pending burst never over-collects
	for (let i = pending.length - 1; i >= 0 && bySeq.size < maxEntries; i--) {
		consider(pending[i]);
	}
	for (const fileEntries of durableNewestFirst) {
		for (let i = fileEntries.length - 1; i >= 0 && bySeq.size < maxEntries; i--) {
			consider(fileEntries[i]);
		}
	}
	return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Union of durable and pending entries deduped by seq, ascending. Used by
 * range reads and stats where both stores are walked in full and a flush can
 * momentarily hold the same entry twice.
 */
export function mergeBySeq(durable: ILedgerEntry[], pending: ILedgerEntry[]): ILedgerEntry[] {
	const seen = new Set<number>();
	const out: ILedgerEntry[] = [];
	for (const e of durable) {
		if (!seen.has(e.seq)) { seen.add(e.seq); out.push(e); }
	}
	for (const e of pending) {
		if (!seen.has(e.seq)) { seen.add(e.seq); out.push(e); }
	}
	out.sort((a, b) => a.seq - b.seq);
	return out;
}

/**
 * Highest X such that the seq prefix [1..X] is FULLY covered by the union of
 * `ranges` (phase-1 review R2). The brief's trim boundary used to be
 * `max(range.toSeq)` alone — with a gap in episode coverage (a failed or
 * partial close) that silently deleted the uncovered entries from the
 * payload. Gaps are never trimmed: an uncovered seq stays verbatim.
 */
export function contiguousCoverage(ranges: { fromSeq: number; toSeq: number }[]): number {
	const sorted = [...ranges].sort((a, b) => a.fromSeq - b.fromSeq);
	let covered = 0;
	for (const r of sorted) {
		// a range that does not attach to the covered prefix ends the walk —
		// everything beyond it is unreachable from seq 1
		if (r.fromSeq > covered + 1) { break; }
		covered = Math.max(covered, r.toSeq);
	}
	return covered;
}
