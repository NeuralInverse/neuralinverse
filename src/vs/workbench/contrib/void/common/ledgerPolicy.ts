/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Context Ledger — tunable policy (task M5, section 5)
 *
 * Every knob of the ledger lives here so behavior is reviewable in one
 * place. All values can be overridden via settings (resolved by the
 * integration layer); the defaults below are the shipped behavior.
 */

export interface ILedgerPolicy {
	/** close an episode once unsummarized tokens exceed this */
	episodeTargetTokens: number;
	/** never close an episode below this (except end-of-thread / manual compact) */
	episodeMinTokens: number;
	/** cap on a single episode body */
	episodeSummaryMaxTokens: number;
	/** cap on the merged working brief */
	briefMaxTokens: number;
	/** minimum verbatim tail messages */
	tailMinMessages: number;
	/** the tail's share of the input budget */
	tailBudgetRatio: number;
	/** cap on recalled blocks injected in one turn */
	recallMaxTokens: number;
	/** B4: cap on relevance-ranked auto-context injected in one turn */
	autoContextMaxTokens: number;
	/** target fill of the context window before acting */
	sendTargetRatio: number;
	/** content above this goes to a blob file */
	inlineMaxChars: number;
	/** journal file rotation size */
	journalRotateBytes: number;
	/** idle window in which closing an episode is "free" */
	cacheIdleCompactMs: number;
	/** merge caps — see task section 6-3 */
	maxInvariants: number;
	maxRejected: number;
	maxCorrections: number;
	maxDecisions: number;
	maxFailures: number;
}

export const DEFAULT_LEDGER_POLICY: ILedgerPolicy = {
	episodeTargetTokens: 60_000,
	episodeMinTokens: 12_000,
	episodeSummaryMaxTokens: 900,
	briefMaxTokens: 4_000,
	tailMinMessages: 8,
	tailBudgetRatio: 0.45,
	recallMaxTokens: 8_000,
	autoContextMaxTokens: 2_048,
	sendTargetRatio: 0.60,
	inlineMaxChars: 64_000,
	journalRotateBytes: 8 * 1024 * 1024,
	cacheIdleCompactMs: 3_600_000,
	maxInvariants: 40,
	maxRejected: 30,
	maxCorrections: 20,
	maxDecisions: 25,
	maxFailures: 15,
};

/** Tokens reserved for the system prompt + tool schemas (matches SYSTEM_RESERVE_TOKENS). */
export const LEDGER_SYSTEM_RESERVE_TOKENS = 10_000;

/** Cheap pre-send estimate; calibrated per-model by the usage tracker (phase 4).
 *
 *  Documented limitation (A3): an exact count needs the provider's tokenizer.
 *  This estimate is deliberately CONSERVATIVE so it bounds the send from
 *  above: ASCII keeps the chars/4 rate, while every non-ASCII char is charged
 *  as half a token (≈2 chars/token) — Persian/CJK text really runs 1.5-3
 *  chars/token on common BPE tokenizers, so chars/4 alone under-counted it by
 *  25-50% and let unicode-heavy payloads slip past the stop. */
export function estimateTokens(text: string): number {
	let nonAscii = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) > 0x7f) { nonAscii++; }
	}
	return Math.ceil((text.length - nonAscii) / 4) + Math.ceil(nonAscii / 2) + 8;
}

export function estimateTokensOf(strings: string[]): number {
	let total = 0;
	for (const s of strings) { total += estimateTokens(s); }
	return total;
}

/** Safety factor applied at the final send boundary: the estimate cannot see
 *  provider-side message framing (role tags, JSON envelopes), so the final
 *  guard charges this overhead on top of the measured sections. */
export const SEND_GUARD_MARGIN = 1.05;

/** A3 final send-boundary math (pure): given the MEASURED token estimates of
 *  the system message, message bodies and serialized tool definitions, may
 *  the request leave? Ceiling = window − output reserve (the system+tools
 *  cost is measured, not flat-reserved, at this boundary). */
export function finalSendBudget(input: {
	systemTokens: number;
	messageTokens: number;
	toolTokens: number;
	contextWindow: number;
	reservedOutputTokenSpace?: number | null;
}): { ok: boolean; total: number; ceiling: number } {
	const outputReserve = Math.max(Math.floor(input.contextWindow / 4), input.reservedOutputTokenSpace ?? 4_096);
	const ceiling = Math.max(input.contextWindow - outputReserve, 0);
	const total = Math.ceil((input.systemTokens + input.messageTokens + input.toolTokens) * SEND_GUARD_MARGIN);
	return { ok: total <= ceiling, total, ceiling };
}

/** A3 degraded-fallback decision (pure): when the ledger assembly fails and
 *  the send would fall back to the RAW thread, the raw thread must fit the
 *  effective input ceiling on its own — an over-budget raw thread must stop
 *  the send instead of shipping without any budget check. */
export function rawFallbackDecision(rawTokenEstimate: number, contextWindow: number, reservedOutputTokenSpace?: number | null): { ok: boolean; available: number } {
	const available = availableInputTokens(contextWindow, reservedOutputTokenSpace);
	return { ok: rawTokenEstimate <= available, available };
}

/** Input tokens available after output and system reservations.
 *
 *  A3 (final closure, 2026-09-17): when the caller passes the MEASURED
 *  system+tools cost (`reservedOverheadTokens`, raw sum — not
 *  margin-multiplied), it REPLACES the flat LEDGER_SYSTEM_RESERVE_TOKENS
 *  guess and the margin math mirrors `finalSendBudget` exactly:
 *  (messages + overhead) × SEND_GUARD_MARGIN ≤ window − outputReserve,
 *  i.e. messages ≤ floor(ceiling / SEND_GUARD_MARGIN) − overhead. The
 *  assembler's shed ladder then decides against the same ceiling the final
 *  send boundary enforces — a payload that fits the ladder fits the wire.
 *  Without the parameter the historical flat-reserve behavior is unchanged. */
export function availableInputTokens(contextWindow: number, reservedOutputTokenSpace?: number | null, reservedOverheadTokens?: number): number {
	const outputReserve = Math.max(Math.floor(contextWindow / 4), reservedOutputTokenSpace ?? 4_096);
	if (reservedOverheadTokens !== undefined && reservedOverheadTokens >= 0) {
		const ceiling = Math.max(contextWindow - outputReserve, 0);
		const forMessages = Math.floor(ceiling / SEND_GUARD_MARGIN) - Math.ceil(reservedOverheadTokens);
		// never negative, and never above the raw ceiling (overhead ≥ 0)
		return Math.max(Math.min(forMessages, ceiling), 0);
	}
	const remaining = contextWindow - outputReserve - LEDGER_SYSTEM_RESERVE_TOKENS;
	// F10: on a small window the old flat 4_000 floor could EXCEED the
	// capacity that is actually left, promising the assembler a budget the
	// provider would reject. The floor now never outruns the window.
	return Math.min(Math.max(remaining, 256), Math.max(contextWindow - outputReserve, 256));
}

/** Merge partial overrides onto the defaults (settings wiring passes values here). */
export function resolvePolicy(overrides?: Partial<ILedgerPolicy>): ILedgerPolicy {
	return { ...DEFAULT_LEDGER_POLICY, ...overrides };
}
