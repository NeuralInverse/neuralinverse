/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Context Ledger — Request Assembler (task M5, phase 2, layer L4)
 *
 * Budget-aware assembly of the outgoing request with a cache-stable prefix:
 *
 * 1. Budget split — the available input window is divided into fixed sections
 *    (brief + pinned + recalled) and the verbatim tail. The tail starts at its
 *    policy ratio share and may grow until the total reaches the send target;
 *    the hard ceiling is the whole available window.
 * 2. Safe fold boundary — messages fold only at a `user` message so
 *    assistant→tool_result pairs are never split (the same rule as
 *    conversationCompactor._findSafeBoundary), and at least `tailMinMessages`
 *    messages always stay verbatim.
 * 3. Stable ordering — brief → pinned → recalled → tail. The most volatile
 *    part of the payload sits at the end, so every byte before it stays
 *    identical between episode boundaries (D5, prompt-cache stability).
 * 4. Usage report — exact per-section token numbers for the context gauge (C2).
 *
 * Degradations, never errors:
 *   - Degenerate passthrough: when no brief exists yet (no episode has closed)
 *     but the window overflows, the assembler still folds at a safe boundary
 *     and sends only the tail — WITHOUT a brief message. Nothing is lost: the
 *     folded prefix lives in the journal and recall_history can bring it back.
 *   - When nothing fits at all (pathologically large pinned/recalled sections)
 *     the shortest safe tail is sent and the report honestly shows overflow.
 *   - Misaligned raws/compactables (a caller bug) degrade to "keep everything".
 *
 * Pure by design: no services, no clock, no randomness — the same input always
 * assembles byte-identically, which is exactly what the D5 assert relies on.
 */

import type { CompactableMessage, IContextUsageReport, IContextUsageSection, IWorkingBrief } from './ledgerTypes.js';
import { type ILedgerPolicy, availableInputTokens, estimateTokens, estimateTokensOf } from './ledgerPolicy.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Input to `assemble`. `raws` and `compactables` must be index-aligned. */
export interface IAssembleInput<T> {
	/** the raw provider-shaped messages; they pass through untouched */
	raws: T[];
	/** parallel plain-form messages, used for token estimates and boundary detection */
	compactables: CompactableMessage[];
	/** working memory (L2); null before the first episode closes */
	brief: IWorkingBrief | null;
	/** overrides brief.tokens when the caller holds a fresher count */
	briefTokens?: number;
	/** user-pinned context blocks, always sent */
	pinnedBlocks?: string[];
	/** recall-tool output injected this turn; admitted whole, up to policy.recallMaxTokens */
	recalledBlocks?: string[];
	/** B4 relevance-ranked auto-context blocks; admitted whole, up to
	 *  policy.autoContextMaxTokens, rendered with their own source tag so
	 *  injected-file origin stays visible in the payload and the gauge. */
	autoContextBlocks?: string[];
	contextWindow: number;
	reservedOutputTokenSpace?: number | null;
	policy: ILedgerPolicy;
	/**
	 * Progressive context shedding (the "never error" ladder). The send path
	 * escalates only when the assembled request still exceeds the input
	 * ceiling after forced compaction:
	 *   0 — normal assembly (all sections)
	 *   1 — drop auto-context only (regenerable)
	 *   2 — also drop recalled sections, then shrink pinned/tail minimum
	 *   3 — also drop the brief (bare conversation, minimal tail)
	 * Shed sections report 0 tokens honestly; `report.shedLevel` records the
	 * level so the gauge and logs can show that degradation happened.
	 */
	shedLevel?: 0 | 1 | 2 | 3;
	/**
	 * A3 (final closure, 2026-09-17): measured system+tools token cost
	 * (raw sum, not margin-multiplied) charged against the input ceiling —
	 * see `availableInputTokens`. When supplied, the shed ladder runs against
	 * the REAL final send budget instead of the flat system reserve, so a
	 * payload that fits here also fits `_finalSendBudgetError` at the wire.
	 * Undefined keeps the historical flat-reserve behavior.
	 */
	reservedOverheadTokens?: number;
	/**
	 * Previous request's prefix (everything up to and including the brief
	 * message content). When supplied, the report's cacheStable is false on a
	 * same-revision prefix drift — the integration then warns and counts
	 * `metricName` (D5).
	 */
	prevPrefix?: { revision: number; prefix: string } | null;
}

/** The working-brief message; always the first assembled message (D5 anchor). */
export interface ILedgerBriefMessage {
	__ledgerBrief: true;
	role: 'user';
	content: string;
}

/** A pinned/recalled context block rendered as a plain user message. */
export interface ILedgerBlockMessage {
	role: 'user';
	content: string;
}

export type IAssembledMessage<T> = T | ILedgerBriefMessage | ILedgerBlockMessage;

export interface IAssembledRequest<T> {
	/** the messages to send: [brief? pinned? recalled? …verbatim tail] */
	messages: IAssembledMessage<T>[];
	/** index into the original raws where the verbatim tail starts; 0 = nothing folded */
	keepFromIdx: number;
	report: IContextUsageReport;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

/** Fixed trailer of the brief message (exact text; asserted byte-for-byte by tests). */
export const BRIEF_TAIL_NOTE = '\n\n(Earlier conversation is preserved in the ledger; the most recent messages follow. Use recall_history for exact older content.)';

/**
 * The exact prefix a request carries up to and including the brief message
 * (D5 stability anchor). Callers that cache the previous request's prefix
 * MUST build it with this helper — comparing `brief.text` alone (without the
 * trailer) reported a false cache break on every send (task F10).
 */
export function briefPrefixOf(brief: IWorkingBrief): string {
	return brief.text + BRIEF_TAIL_NOTE;
}

/**
 * Head message injected when messages are folded WITHOUT a brief (no episode
 * has closed yet) — task M6 item 2. Until this existed the model received a
 * conversation that started mid-way with no hint that anything was missing.
 * `count` is the number of folded raw messages (journal seqs are not visible
 * at this layer; the count is the honest equivalent).
 */
const ledgerNotice = (count: number): string =>
	`<ledger_notice covers_messages="1-${count}">\nOlder messages are preserved in the ledger but are not summarized yet.\nUse recall_history to retrieve any of them.\n</ledger_notice>`;

/** Metric counter the send-path integration increments on a D5 cache break. */
export const metricName = 'ledger.cacheBreak';

// ─── Assembly ───────────────────────────────────────────────────────────────────

export function assemble<T>(input: IAssembleInput<T>): IAssembledRequest<T> {
	const { raws, compactables, contextWindow } = input;
	const shedLevel = input.shedLevel ?? 0;
	// "Never error" ladder: each level sheds more optional context instead of
	// surfacing an over-budget stop. The shed sections still appear in the
	// report (with 0 tokens) so degradation is observable, never silent.
	const brief = shedLevel >= 3 ? null : input.brief;
	const pinnedBlocks = shedLevel >= 2 ? [] : (input.pinnedBlocks ?? []);
	const recalledBlocks = shedLevel >= 2 ? [] : (input.recalledBlocks ?? []);
	const autoContextBlocks = shedLevel >= 1 ? [] : (input.autoContextBlocks ?? []);
	// Under pressure the tail minimum shrinks too: 2 messages keep the last
	// assistant→user pair; level 3 keeps only the current user request.
	const policy: ILedgerPolicy = shedLevel >= 3
		? { ...input.policy, tailMinMessages: 1 }
		: shedLevel >= 2
			? { ...input.policy, tailMinMessages: Math.min(2, input.policy.tailMinMessages) }
			: input.policy;
	const available = availableInputTokens(contextWindow, input.reservedOutputTokenSpace, input.reservedOverheadTokens);

	// ── Section budgets ──
	const briefSectionTokens = brief !== null ? (input.briefTokens ?? brief.tokens) : 0;
	const pinnedSectionTokens = estimateTokensOf(pinnedBlocks);

	// Recalled blocks are admitted whole, in order, until the cap; the first
	// block that would overflow ends admission — blocks are never truncated.
	const recalledKept: string[] = [];
	let recalledSectionTokens = 0;
	for (const block of recalledBlocks) {
		const blockTokens = estimateTokens(block);
		if (recalledSectionTokens + blockTokens > policy.recallMaxTokens) { break; }
		recalledKept.push(block);
		recalledSectionTokens += blockTokens;
	}

	// B4: auto-context blocks are admitted whole until their own cap, before
	// the tail budget is computed (same whole-block rule as recalled).
	const autoKept: string[] = [];
	let autoSectionTokens = 0;
	for (const block of autoContextBlocks) {
		const blockTokens = estimateTokens(block);
		if (autoSectionTokens + blockTokens > policy.autoContextMaxTokens) { break; }
		autoKept.push(block);
		autoSectionTokens += blockTokens;
	}

	// ── Tail budget: the ratio share floors the send-target remainder; the total is hard-ceiled at `available` ──
	const targetTail = Math.floor(available * policy.sendTargetRatio) - briefSectionTokens - pinnedSectionTokens - recalledSectionTokens - autoSectionTokens;
	const ceilingTail = Math.max(0, available - briefSectionTokens - pinnedSectionTokens - recalledSectionTokens - autoSectionTokens);
	const tailBudget = Math.min(Math.max(Math.floor(available * policy.tailBudgetRatio), targetTail), ceilingTail);

	// ── Verbatim tail ──
	const suffix = suffixTokenSums(compactables);
	let keepFromIdx = findFoldBoundary(raws, compactables, suffix, tailBudget, policy);
	// The no-brief notice (below) is a real payload section: once folding is
	// inevitable, re-fit the tail with its (strict upper-bound) cost reserved so
	// `totalTokens <= available` still holds. `raws.length` bounds every possible
	// keepFromIdx, so its digit count bounds the notice length from above.
	if (brief === null && keepFromIdx > 0) {
		const reserved = estimateTokens(ledgerNotice(raws.length));
		const refit = findFoldBoundary(raws, compactables, suffix, Math.max(0, tailBudget - reserved), policy);
		if (refit > keepFromIdx) { keepFromIdx = refit; }
	}
	const tailSectionTokens = suffix[keepFromIdx];

	// ── Compose: brief → pinned → recalled → tail (D5 ordering) ──
	const head: IAssembledMessage<T>[] = [];
	if (brief !== null) {
		head.push({ __ledgerBrief: true, role: 'user', content: brief.text + BRIEF_TAIL_NOTE });
	}
	if (pinnedBlocks.length > 0) {
		head.push({ role: 'user', content: pinnedBlocks.map(b => `<pinned_context>\n${b}\n</pinned_context>`).join('\n\n') });
	}
	if (autoKept.length > 0) {
		head.push({ role: 'user', content: autoKept.map(b => `<auto_context source="relevance">\n${b}\n</auto_context>`).join('\n\n') });
	}
	if (recalledKept.length > 0) {
		head.push({ role: 'user', content: recalledKept.map(b => `<recalled_context source="recall_history">\n${b}\n</recalled_context>`).join('\n\n') });
	}
	// Degenerate passthrough must not be silent (M6 item 2): folding without a
	// brief still needs a marker telling the model older content exists.
	const notice = brief === null && keepFromIdx > 0 ? ledgerNotice(keepFromIdx) : null;
	if (notice !== null) {
		head.push({ role: 'user', content: notice });
	}
	// Degenerate passthrough: nothing injected and nothing folded → raws are
	// returned as-is (zero-copy); callers must treat the array as read-only.
	const messages: IAssembledMessage<T>[] = head.length === 0 && keepFromIdx === 0
		? raws
		: [...head, ...raws.slice(keepFromIdx)];

	// ── Usage report ──
	// The system prompt is not ours to report; `reserved-output` lumps the
	// output reserve and the system reserve together (contextWindow − available).
	// totalTokens covers only what this request actually sends.
	const noticeSectionTokens = notice !== null ? estimateTokens(notice) : 0;
	// A3: the old 'reserved-output' section lumped the output reserve and the
	// flat system+tools reserve together. Report them separately so the gauge
	// can show what each reservation actually is.
	const outputReserveTokens = Math.max(Math.floor(contextWindow / 4), input.reservedOutputTokenSpace ?? 4_096);
	const reservedAll = Math.max(0, contextWindow - available);
	const sections: IContextUsageSection[] = [
		{ name: 'brief', tokens: briefSectionTokens },
		{ name: 'pinned', tokens: pinnedSectionTokens },
		{ name: 'auto', tokens: autoSectionTokens },
		{ name: 'recalled', tokens: recalledSectionTokens },
		{ name: 'notice', tokens: noticeSectionTokens },
		{ name: 'tail', tokens: tailSectionTokens },
		{ name: 'reserved-output', tokens: Math.min(outputReserveTokens, reservedAll) },
		{ name: 'reserved-system', tokens: Math.max(0, reservedAll - outputReserveTokens) },
	];
	// D5: the compared prefix is everything up to and including the brief
	// message content (the caller may additionally prepend the system prompt
	// when it builds both strings itself and calls checkPrefixStability directly).
	const prefix = brief !== null ? brief.text + BRIEF_TAIL_NOTE : '';
	const report: IContextUsageReport = {
		totalTokens: briefSectionTokens + pinnedSectionTokens + autoSectionTokens + recalledSectionTokens + noticeSectionTokens + tailSectionTokens,
		contextWindow,
		availableInputTokens: available,
		sections,
		shedLevel,
		cacheStable: checkPrefixStability(
			input.prevPrefix ?? null,
			{ revision: brief !== null ? brief.revision : 0, prefix },
		),
	};

	return { messages, keepFromIdx, report };
}

// ─── Boundary selection ─────────────────────────────────────────────────────────

/**
 * suffixTokenSums[i] = estimated tokens of compactables[i..]; computed once so
 * every boundary candidate is an O(1) check.
 */
function suffixTokenSums(compactables: CompactableMessage[]): number[] {
	const suffix = new Array<number>(compactables.length + 1).fill(0);
	for (let i = compactables.length - 1; i >= 0; i--) {
		suffix[i] = suffix[i + 1] + estimateTokens(compactables[i].content);
	}
	return suffix;
}

/**
 * The OLDEST index whose verbatim tail fits `tailBudget`. A fold index must be
 * a `user` message (assistant→tool pairs are never split — the same rule as
 * conversationCompactor._findSafeBoundary) and must leave at least
 * `tailMinMessages` messages verbatim. When nothing fits, the latest safe
 * boundary wins (shortest tail, honest overflow); with no safe boundary at all
 * everything is kept (index 0) — folding must never block the send path.
 */
function findFoldBoundary<T>(raws: T[], compactables: CompactableMessage[], suffix: number[], tailBudget: number, policy: ILedgerPolicy): number {
	if (raws.length === 0 || raws.length !== compactables.length) { return 0; }
	const isSafeBoundary = (i: number): boolean =>
		i >= 1 && compactables[i].role === 'user' && raws.length - i >= policy.tailMinMessages;
	for (let i = 0; i < raws.length; i++) {
		if ((i === 0 || isSafeBoundary(i)) && suffix[i] <= tailBudget) { return i; }
	}
	const lastCandidate = Math.min(raws.length - 1, raws.length - policy.tailMinMessages);
	for (let i = lastCandidate; i >= 1; i--) {
		if (compactables[i].role === 'user') { return i; }
	}
	return 0;
}

// ─── Prompt-cache stability (D5) ────────────────────────────────────────────────

/**
 * Pure prefix-stability check across two consecutive requests. The prefix is
 * everything up to and including the brief message content — the caller builds
 * the strings, this function only compares:
 *
 *   - prev == null                        → stable (first request)
 *   - same revision, identical bytes      → stable
 *   - same revision, different bytes      → violation (false)
 *   - prev.revision < next.revision       → stable (episode boundary moved it)
 */
export function checkPrefixStability(
	prev: { revision: number; prefix: string } | null,
	next: { revision: number; prefix: string },
): boolean {
	if (prev === null) { return true; }
	if (prev.revision === next.revision) { return prev.prefix === next.prefix; }
	return prev.revision < next.revision;
}
