/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Context Ledger — stable turn identity for the native chat (review R2)
 *
 * The native bridge journals every turn with `meta.turn = <0-based turn
 * index>`, which makes "is this session turn already archived?" an exact
 * marker lookup. Journals written BEFORE that marker existed carry no
 * markers, so a second matcher — greedy in-order content matching — covers
 * them; it can false-positive when a session repeats identical messages, and
 * that failure mode is deliberately the harmless one (a turn is assumed
 * archived when it is missing → nothing is duplicated into the payload).
 *
 * Re-review T3/T4 + follow-up U1–U3 + V1: coverage is PER RECORD (a turn's
 * user and assistant entries are verified separately), the contiguous
 * watermark returned by `migrateLegacyTurns` covers only COMPLETED turns
 * (never the not-yet-answered current one) and advances only over writes the
 * journal confirmed, ASSISTANT completeness is content-based — the turn's
 * marked records must concatenate to the whole response, so an archived
 * progress/tool-call emission is never mistaken for the final answer (V1) —
 * coverage discovery pages the WHOLE archive when the windowed accelerators
 * leave any record unresolved, and only v2 coverage notes are honored (the
 * premature v1 convention is ignored, not trusted).
 *
 * Pure by design — unit-tested without any service.
 */

import { ILedgerEntry } from './ledgerTypes.js';

/** True when a journaled user entry could BE this turn's request message. */
function contentMatches(entryContent: string, message: string): boolean {
	if (entryContent === message) { return true; }
	// the native bridge journals `<attached_context>…\n\n<message>` when the
	// request carries resolved context
	return message.length > 0 && entryContent.endsWith(`\n\n${message}`);
}

/**
 * The concatenated content of the turn's MARKED assistant entries, in seq
 * order — the archived RESPONSE so far (V1). A turn-level marker alone
 * cannot prove the response complete: intermediate progress and empty
 * tool-call-only emissions carry the same `meta.turn` as the final answer,
 * so completeness is decided by CONTENT COVERAGE, never by the mere
 * existence of one assistant record. `undefined` = no marked record at all.
 */
export function archivedAssistantText(entries: ILedgerEntry[], turn: number): string | undefined {
	let joined: string | undefined;
	for (const e of entries) {
		if (e.role === 'assistant' && e.meta?.turn === turn) {
			joined = (joined ?? '') + e.content;
		}
	}
	return joined;
}

/**
 * Which of `history`'s turn RECORDS are already present in the journal.
 * `history[i].message` is the raw request message of turn i and
 * `assistantText` its assistant answer (empty when the turn has none) — the
 * same index the bridge stamps into `meta.turn`.
 *
 * `coveredThrough`: turns with index <= coveredThrough are PROVEN archived
 * by a durable coverage note/watermark — no windowed scan can un-prove
 * them, so a long tool run cannot make migration re-append them.
 *
 * Returns one per-record coverage per history turn; `user: true` alone
 * means the turn is HALF archived — its assistant answer is still missing
 * and migration repairs just that record.
 */
export interface ILegacyTurnCoverage {
	user: boolean;
	assistant: boolean;
}

export function matchLedgerTurns(
	history: { message: string; assistantText?: string }[],
	entries: ILedgerEntry[],
	coveredThrough?: number,
): ILegacyTurnCoverage[] {
	const markerUsers = new Set<number>();
	for (const e of entries) {
		const turn = e.meta?.turn;
		if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 0) { continue; }
		if (e.role === 'user') { markerUsers.add(turn); }
	}

	const covered: ILegacyTurnCoverage[] = history.map(() => ({ user: false, assistant: false }));
	// greedy in-order pointers for unmarked (legacy) journals
	let userPointer = 0;
	let assistantPointer = 0;
	for (let i = 0; i < history.length; i++) {
		const assistantText = history[i].assistantText ?? '';
		if (coveredThrough !== undefined && i <= coveredThrough) {
			covered[i] = { user: true, assistant: true };
			continue;
		}
		if (markerUsers.has(i)) {
			covered[i].user = true;
		} else {
			while (userPointer < entries.length) {
				const e = entries[userPointer];
				userPointer++;
				// marked entries belong to the exact identity space — they can
				// never satisfy another turn's content match
				if (e.meta?.turn !== undefined || e.role !== 'user') { continue; }
				if (contentMatches(e.content, history[i].message)) {
					covered[i].user = true;
					break;
				}
			}
		}
		if (!assistantText) {
			covered[i].assistant = true;
		} else {
			const archived = archivedAssistantText(entries, i);
			if (archived !== undefined) {
				// V1: the turn's marked records must CONCATENATE to the whole
				// response — one archived progress/tool-call emission is not
				// proof that the final answer landed
				covered[i].assistant = archived.endsWith(assistantText);
			} else {
				while (assistantPointer < entries.length) {
					const e = entries[assistantPointer];
					assistantPointer++;
					if (e.meta?.turn !== undefined || e.role !== 'assistant') { continue; }
					if (e.content === assistantText || (assistantText.length > 0 && e.content.endsWith(`\n\n${assistantText}`))) {
						covered[i].assistant = true;
						break;
					}
				}
			}
		}
	}
	return covered;
}

/**
 * The newest durable coverage note in a window read (re-review S2/U1): the
 * highest `meta.coveredThrough` on a `turn-coverage-v2` note entry, or
 * undefined when the window holds none.
 *
 * U1 compatibility: notes written by the earlier premature convention
 * (`turn-coverage`, which certified the not-yet-answered current turn) are
 * deliberately NOT honored as completed-turn proofs. Ignoring them costs one
 * full-archive scan (see `migrateLegacyTurns`) and repairs whatever turn they
 * had prematurely certified; trusting them would make a missing assistant
 * answer permanently unrecoverable.
 */
export function newestCoverageNote(entries: ILedgerEntry[]): number | undefined {
	let through: number | undefined;
	for (const e of entries) {
		if (e.role !== 'note' || e.content !== 'turn-coverage-v2') { continue; }
		const v = e.meta?.coveredThrough;
		if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && (through === undefined || v > through)) {
			through = v;
		}
	}
	return through;
}

function mergeEntriesBySeq(a: ILedgerEntry[], b: ILedgerEntry[]): ILedgerEntry[] {
	if (a.length === 0 || b.length === 0) { return a.length > 0 ? a : b; }
	const seen = new Set(a.map(e => e.seq));
	return [...a, ...b.filter(e => !seen.has(e.seq))].sort((x, y) => x.seq - y.seq);
}

/** The ledger surface migration needs — the provider adapts the real service. */
export interface ILegacyMigrationIo {
	/** total journal entries, or null when the ledger is empty/unknown */
	statsEntryCount(): Promise<number | null>;
	/** the most recent `maxEntries` journal entries, ascending */
	readTail(maxEntries: number): Promise<ILedgerEntry[]>;
	/** entries with fromSeq <= seq <= toSeq, ascending (toSeq may be huge) */
	readRange(fromSeq: number, toSeq: number): Promise<ILedgerEntry[]>;
	/** the DURABLE coverage watermark from thread metadata, when present */
	getCoverage(): Promise<number | undefined>;
	/** journal one migration record; null = the write was refused/failed */
	append(record: { role: 'user' | 'assistant'; content: string; meta: { turn: number } }): Promise<ILedgerEntry | null>;
}

/**
 * Migrate session turns the journal never saw (re-review T3/T4, follow-up
 * U1/U3). Writes only the MISSING records of each uncovered turn, in order,
 * and stops advancing at the first write the journal did not confirm. Returns
 * the contiguous watermark over COMPLETED turns — every turn <= it has both
 * its user and its assistant record confirmed archived (-1 when none). The
 * send path may claim exactly this value (and nothing more): certifying a
 * turn whose answer does not exist yet would make a failed answer write
 * permanently unrecoverable (U1).
 *
 * Coverage discovery (U3): the durable watermark and the head/tail reads are
 * ACCELERATORS — an unobserved middle entry is never proof of absence. When
 * any required record is still unresolved after them, ONE COMPLETE READ of
 * the archive happens before the record is treated as missing.
 */
export async function migrateLegacyTurns(
	io: ILegacyMigrationIo,
	history: { message: string; assistantText?: string }[],
): Promise<number> {
	let coverage = -1;
	let covered: ILegacyTurnCoverage[] | undefined;
	let entries: ILedgerEntry[] = [];
	const entryCount = await io.statsEntryCount();
	if (entryCount !== null && entryCount > 0) {
		const metaCoverage = await io.getCoverage();
		if (typeof metaCoverage === 'number' && metaCoverage > coverage) { coverage = metaCoverage; }
		const coveredOf = (pool: ILedgerEntry[]): ILegacyTurnCoverage[] =>
			matchLedgerTurns(history, pool, coverage >= 0 ? coverage : undefined);
		const resolved = (c: ILegacyTurnCoverage[]): boolean => c.every(t => t.user && t.assistant);

		// accelerator 1 — the bounded tail (also finds the newest note)
		entries = await io.readTail(Math.max(64, history.length * 4 + 8));
		const tailNote = newestCoverageNote(entries);
		if (tailNote !== undefined && tailNote > coverage) { coverage = tailNote; }
		covered = coveredOf(entries);

		// accelerator 2 — the bigger tail (crashed note / resumed journal)
		if (!resolved(covered)) {
			const grown = await io.readTail(2_048);
			if (grown.length > entries.length) {
				entries = mergeEntriesBySeq(entries, grown);
				const grownNote = newestCoverageNote(grown);
				if (grownNote !== undefined && grownNote > coverage) { coverage = grownNote; }
				covered = coveredOf(entries);
			}
		}

		// accelerator 3 — the journal HEAD (legacy turns were usually
		// journaled before newer tool activity). A head read is NOT a
		// completeness proof — the middle stays unscanned (U3).
		if (!resolved(covered)) {
			const head = await io.readRange(1, Math.max(64, history.length * 4 + 8));
			entries = mergeEntriesBySeq(head, entries);
			const headNote = newestCoverageNote(head);
			if (headNote !== undefined && headNote > coverage) { coverage = headNote; }
			covered = coveredOf(entries);
		}

		// U3 — completeness: an already-archived turn can sit BETWEEN the head
		// and tail windows (tool entries separate turns). ONE COMPLETE READ
		// of the archive (a single readRange, blobs spliced — not bounded
		// pagination; its cost on very large archives is the price of a
		// correctness guarantee) happens before any record is treated as
		// absent; only then may the repair loop write it.
		if (!resolved(covered)) {
			const full = await io.readRange(1, Number.MAX_SAFE_INTEGER);
			entries = mergeEntriesBySeq(entries, full);
			const fullNote = newestCoverageNote(full);
			if (fullNote !== undefined && fullNote > coverage) { coverage = fullNote; }
			covered = coveredOf(entries);
		}
	}
	if (!covered) {
		// empty ledger: the session history is the only source
		covered = history.map(() => ({ user: false, assistant: false }));
	}

	let confirmed = coverage;
	for (let i = 0; i < history.length; i++) {
		if (i <= confirmed) { continue; }
		if (!covered[i].user) {
			const wrote = await io.append({ role: 'user', content: history[i].message, meta: { turn: i } });
			if (!wrote) { break; }
		}
		const assistantText = history[i].assistantText ?? '';
		if (assistantText && !covered[i].assistant) {
			// V1: repair the missing response PART — append only what the
			// archive lacks, so already-archived progress/tool-call emissions
			// are not duplicated and their tool-call/result pairs stay
			// untouched (the suffix lands after them, append-only)
			const archived = archivedAssistantText(entries, i) ?? '';
			const missing = archived.length > 0 && assistantText.startsWith(archived)
				? assistantText.slice(archived.length)
				: assistantText;
			const wrote = await io.append({ role: 'assistant', content: missing, meta: { turn: i } });
			if (!wrote) { break; }
		}
		confirmed = i;
	}
	return confirmed;
}
