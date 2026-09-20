/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Context Ledger — episode close-boundary resolution (task M6, item 1)
 *
 * The one shared place that decides WHERE a due episode ends. Before M6 this
 * logic existed twice (chatThreadService._closeEpisodeIfNeeded and
 * agentExecutor._compactHistoryViaLedger) with a fixed 12-entry window, and a
 * tool-heavy turn (no `user` message in the window) silently returned without
 * closing anything — the episode stayed open forever and nobody knew.
 *
 * The window now GROWS: it starts at `tailMinMessages + 4` and doubles up to
 * {@link MAX_BOUNDARY_WINDOW_ENTRIES}, so the `user` message that started a
 * 25-tool-call turn is still found. A miss is never silent — it increments the
 * `ledger.boundaryMissed` counter and warns once per thread+reason
 * (task M6: "هیچ مسیر return خاموشی نمانده").
 *
 * Boundary rules (unchanged in spirit, now enforced in one place):
 *   - the boundary is the OLDEST `user` entry strictly after `fromSeq` that
 *     keeps at least `tailMinMessages` entries verbatim after it (assistant→
 *     tool pairs are never split — the same rule as the assembler);
 *   - `toSeq = boundarySeq - 1` therefore always satisfies `toSeq >= fromSeq`.
 *
 * Pure by design except the miss telemetry (a module-level counter), so the
 * search itself is unit-testable without any service.
 */

import { ILedgerEntry } from './ledgerTypes.js';
import { ILedgerPolicy } from './ledgerPolicy.js';

/** Ceiling for the growing tail window — bounded cost per boundary search. */
export const MAX_BOUNDARY_WINDOW_ENTRIES = 200;

export interface ICloseBoundaryOutcome {
	/** `close` = an episode boundary was found; `deferred` = none, see `reason` */
	kind: 'close' | 'deferred';
	/** index into `window` of the boundary user entry (close only) */
	boundaryIdx?: number;
	/** seq of the boundary user entry — the first entry of the next tail (close only) */
	boundarySeq?: number;
	/** last seq covered by the episode = boundarySeq - 1 (close only) */
	toSeq?: number;
	/** the final window the search settled on; callers use it with `boundaryIdx` */
	window?: ILedgerEntry[];
	/** human-readable miss reason (deferred only) */
	reason?: string;
	/** true when the boundary came from the mid-turn checkpoint rule (the
	 *  covered range ends at a completed tool group inside the current turn
	 *  instead of at a user message). */
	midTurn?: boolean;
}

/** Options for the mid-turn checkpoint (virtual-1M milestone). */
export interface IResolveBoundaryOptions {
	/**
	 * Allow closing INSIDE one long tool-loop turn: the episode then covers
	 * through the last COMPLETED assistant→tool group that still leaves
	 * `tailMinMessages` verbatim entries. Without this, a single-turn task
	 * (one user message + dozens of tool calls) can never checkpoint — the
	 * observed 101k-token archive that kept growing because "no user
	 * boundary" exists.
	 */
	allowMidTurn?: boolean;
	/** minimum uncovered entries before a mid-turn checkpoint is worth an episode (default tailMinMessages * 2) */
	midTurnMinUncovered?: number;
}

/**
 * Growing-window boundary search. `readTail` is injected (the ledger service's
 * `readTail`) so this function owns exactly the window-growth policy; callers
 * own the LLM and the episode freeze.
 */
export async function resolveCloseBoundary(
	fromSeq: number,
	policy: ILedgerPolicy,
	readTail: (maxEntries: number) => Promise<ILedgerEntry[]>,
	options?: IResolveBoundaryOptions,
): Promise<ICloseBoundaryOutcome> {
	let size = policy.tailMinMessages + 4;
	let window: ILedgerEntry[] = [];
	for (; ;) {
		window = await readTail(size);
		const hit = searchWindow(window, fromSeq, policy);
		if (hit) {
			return { kind: 'close', boundaryIdx: hit.boundaryIdx, boundarySeq: hit.boundarySeq, toSeq: hit.toSeq, window };
		}
		// A short window means the journal itself is shorter than the request —
		// there is nothing older to reveal, stop instead of looping.
		if (window.length < size || size >= MAX_BOUNDARY_WINDOW_ENTRIES) {
			const miss = missReason(window, fromSeq, policy, size >= MAX_BOUNDARY_WINDOW_ENTRIES && window.length >= size);
			if (options?.allowMidTurn) {
				const midTurn = searchMidTurnWindow(window, fromSeq, policy, options.midTurnMinUncovered);
				if (midTurn) {
					return midTurn;
				}
			}
			return { kind: 'deferred', window, reason: miss };
		}
		size = Math.min(size * 2, MAX_BOUNDARY_WINDOW_ENTRIES);
	}
}

/**
 * Mid-turn checkpoint search (virtual-1M): fold the current turn's EARLY
 * completed tool groups into an episode while the turn is still running.
 * Safety rules, per the campaign's 1M milestone:
 *   - the covered range ends at a `tool` entry (a completed result) — never
 *     between an assistant's tool calls and their results;
 *   - every tool call issued by a covered assistant entry has its result
 *     inside the covered range (pair integrity, checked by call id);
 *   - `tailMinMessages` entries stay verbatim after the boundary, so the
 *     current goal/progress/outstanding work remain readable in the tail;
 *   - the current request itself may be covered — every assembly path
 *     re-injects the current request independently of episode coverage
 *     (ledgerPayload re-appends it; the budget marks it mandatory).
 * Returns null when there is not enough completed material yet.
 */
export function searchMidTurnWindow(
	window: ILedgerEntry[],
	fromSeq: number,
	policy: ILedgerPolicy,
	minUncovered?: number,
): ICloseBoundaryOutcome | null {
	const uncovered = window.filter(e => e.seq > fromSeq);
	const minEntries = minUncovered ?? policy.tailMinMessages * 2;
	if (uncovered.length < minEntries) {
		return null;
	}
	const maxBoundaryIdx = window.length - policy.tailMinMessages - 1;
	for (let i = maxBoundaryIdx; i >= 0; i--) {
		const e = window[i];
		if (e.seq <= fromSeq || e.role !== 'tool') { continue; }
		if (!toolPairsCompleteThrough(window, i)) { continue; }
		return {
			kind: 'close',
			boundaryIdx: i,
			boundarySeq: e.seq,
			toSeq: e.seq, // the tool result itself is covered; the tail starts after it
			window,
			midTurn: true,
		};
	}
	return null;
}

/** True when every tool call issued inside `window[0..i]` has its result
 *  inside `window[0..i]` as well (matched by meta.toolCallId). */
function toolPairsCompleteThrough(window: ILedgerEntry[], i: number): boolean {
	const results = new Set<string>();
	for (let j = 0; j <= i; j++) {
		const e = window[j];
		if (e.role === 'tool' && e.meta?.toolCallId) { results.add(e.meta.toolCallId); }
	}
	for (let j = 0; j <= i; j++) {
		const e = window[j];
		const calls = e.meta?.toolCalls;
		if (!calls || calls.length === 0) { continue; }
		for (const c of calls) {
			if (!results.has(c.id)) { return false; }
		}
	}
	return true;
}

/** Oldest eligible user entry in `window`, or null. Pure. */
function searchWindow(window: ILedgerEntry[], fromSeq: number, policy: ILedgerPolicy): { boundaryIdx: number; boundarySeq: number; toSeq: number } | null {
	for (let i = 0; i < window.length; i++) {
		const e = window[i];
		if (e.role !== 'user' || e.seq <= fromSeq) continue;
		// boundary starts the verbatim tail: it plus everything after it must
		// satisfy tailMinMessages (mirrors contextAssembler.findFoldBoundary)
		if (window.length - i < policy.tailMinMessages) break; // later users leave even less
		return { boundaryIdx: i, boundarySeq: e.seq, toSeq: e.seq - 1 };
	}
	return null;
}

function missReason(window: ILedgerEntry[], fromSeq: number, policy: ILedgerPolicy, hitCap: boolean): string {
	const hasNewUser = window.some(e => e.role === 'user' && e.seq > fromSeq);
	const cap = hitCap ? ` (search capped at ${MAX_BOUNDARY_WINDOW_ENTRIES} entries)` : '';
	if (!hasNewUser) {
		return `no user boundary after seq ${fromSeq} in the last ${window.length} journal entries — a single turn with no new user message cannot be summarized yet${cap}`;
	}
	return `every user boundary after seq ${fromSeq} would leave fewer than ${policy.tailMinMessages} verbatim entries — deferring until the conversation grows${cap}`;
}

// ─── Miss telemetry (ledger.boundaryMissed, task M6) ──────────────────────────

const missCounts = new Map<string, number>();
const missWarnedReasons = new Map<string, Set<string>>();

/** Times `resolveCloseBoundary` (or a caller) deferred a due close for a thread. */
export function boundaryMissCount(threadId: string): number {
	return missCounts.get(threadId) ?? 0;
}

/**
 * Increment the miss counter and warn — once per thread per distinct reason,
 * so a stuck boundary is visible in the console without spamming every send.
 * A later successful close resets the warned reasons so a NEW miss speaks up.
 */
export function noteBoundaryMissed(threadId: string, reason: string): void {
	missCounts.set(threadId, (missCounts.get(threadId) ?? 0) + 1);
	let warned = missWarnedReasons.get(threadId);
	if (!warned) {
		warned = new Set();
		missWarnedReasons.set(threadId, warned);
	}
	if (warned.has(reason)) return;
	warned.add(reason);
	console.warn(`[ContextLedger] boundaryMissed (${boundaryMissCount(threadId)}): ${reason}`);
}

/** Reset a thread's warned reasons after a successful close (see above). Test hook. */
export function resetBoundaryMissTelemetry(threadId: string): void {
	missWarnedReasons.delete(threadId);
}
