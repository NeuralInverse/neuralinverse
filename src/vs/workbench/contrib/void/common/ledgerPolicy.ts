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

/** Cheap pre-send estimate; calibrated per-model by the usage tracker (phase 4). */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4) + 8;
}

export function estimateTokensOf(strings: string[]): number {
	let total = 0;
	for (const s of strings) total += estimateTokens(s);
	return total;
}

/** Input tokens available after output and system reservations. */
export function availableInputTokens(contextWindow: number, reservedOutputTokenSpace?: number | null): number {
	const outputReserve = Math.max(Math.floor(contextWindow / 4), reservedOutputTokenSpace ?? 4_096);
	return Math.max(contextWindow - outputReserve - LEDGER_SYSTEM_RESERVE_TOKENS, 4_000);
}

/** Merge partial overrides onto the defaults (settings wiring passes values here). */
export function resolvePolicy(overrides?: Partial<ILedgerPolicy>): ILedgerPolicy {
	return { ...DEFAULT_LEDGER_POLICY, ...overrides };
}
