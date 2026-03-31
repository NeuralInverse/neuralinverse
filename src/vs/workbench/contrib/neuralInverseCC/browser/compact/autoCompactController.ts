/*---------------------------------------------------------------------------------------------
 *  Ported from Claude Code (MIT License - Copyright (c) Anthropic)
 *  Source: src/services/compact/autoCompact.ts
 *  Adapted for Neural Inverse IDE — stripped bun:bundle/analytics/SessionMemory deps
 *--------------------------------------------------------------------------------------------*/

import type { AutoCompactState, CompactionResult } from '../../common/neuralInverseCCTypes.js';

// ─── Constants (from CC) ──────────────────────────────────────────────────────

/** Reserve this many tokens for output during compaction (CC: p99.99 was 17,387 tokens) */
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
/** Buffer before auto-compact threshold (CC: 13K) */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
/** Warning threshold buffer (CC: 20K) */
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;
/** Manual compact buffer (CC: 3K) */
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;
/** Circuit breaker: stop retrying after this many consecutive failures */
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

// ─── Model context windows (from CC — updated for Claude 4.x) ────────────────

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
	'claude-opus-4-6': 200_000,
	'claude-opus-4-5': 200_000,
	'claude-opus-4-1': 200_000,
	'claude-opus-4': 200_000,
	'claude-sonnet-4-6': 200_000,
	'claude-sonnet-4-5': 200_000,
	'claude-sonnet-4': 200_000,
	'claude-3-7-sonnet': 200_000,
	'claude-3-5-sonnet': 200_000,
	'claude-haiku-4-5': 200_000,
	'claude-3-5-haiku': 200_000,
};

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

export function getContextWindowForModel(model: string): number {
	const lower = model.toLowerCase();
	for (const [key, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
		if (lower.includes(key)) { return size; }
	}
	return DEFAULT_CONTEXT_WINDOW;
}

export function getMaxOutputTokensForModel(model: string): number {
	return DEFAULT_MAX_OUTPUT_TOKENS;
}

// ─── Core functions (ported from CC) ─────────────────────────────────────────

export function getEffectiveContextWindowSize(model: string): number {
	const reservedTokensForSummary = Math.min(
		getMaxOutputTokensForModel(model),
		MAX_OUTPUT_TOKENS_FOR_SUMMARY
	);
	return getContextWindowForModel(model) - reservedTokensForSummary;
}

export function getAutoCompactThreshold(model: string): number {
	return getEffectiveContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS;
}

export function calculateTokenWarningState(tokenUsage: number, model: string): {
	percentLeft: number;
	isAboveWarningThreshold: boolean;
	isAboveErrorThreshold: boolean;
	isAboveAutoCompactThreshold: boolean;
	isAtBlockingLimit: boolean;
} {
	const autoCompactThreshold = getAutoCompactThreshold(model);
	const threshold = autoCompactThreshold;
	const percentLeft = Math.max(0, Math.round(((threshold - tokenUsage) / threshold) * 100));
	const warningThreshold = threshold - WARNING_THRESHOLD_BUFFER_TOKENS;

	return {
		percentLeft,
		isAboveWarningThreshold: tokenUsage >= warningThreshold,
		isAboveErrorThreshold: tokenUsage >= warningThreshold,
		isAboveAutoCompactThreshold: tokenUsage >= autoCompactThreshold,
		isAtBlockingLimit: tokenUsage >= (getEffectiveContextWindowSize(model) - MANUAL_COMPACT_BUFFER_TOKENS),
	};
}

// ─── AutoCompactController ────────────────────────────────────────────────────

export class AutoCompactController {
	private readonly _states = new Map<string, AutoCompactState>();

	getState(sessionId: string): AutoCompactState {
		return this._states.get(sessionId) ?? {
			compacted: false,
			turnCounter: 0,
			turnId: '',
			consecutiveFailures: 0,
		};
	}

	setState(sessionId: string, state: AutoCompactState): void {
		this._states.set(sessionId, state);
	}

	clearSession(sessionId: string): void {
		this._states.delete(sessionId);
	}

	/**
	 * Check whether auto-compact should fire for a session given the current token count.
	 * Returns true if threshold exceeded and circuit breaker hasn't tripped.
	 */
	shouldAutoCompact(sessionId: string, tokenCount: number, model: string): boolean {
		const state = this.getState(sessionId);

		// Circuit breaker
		if ((state.consecutiveFailures ?? 0) >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
			return false;
		}

		const { isAboveAutoCompactThreshold } = calculateTokenWarningState(tokenCount, model);
		return isAboveAutoCompactThreshold;
	}

	recordSuccess(sessionId: string, result: CompactionResult): void {
		const state = this.getState(sessionId);
		this._states.set(sessionId, {
			...state,
			compacted: true,
			turnCounter: state.turnCounter + 1,
			turnId: `turn_${Date.now()}`,
			consecutiveFailures: 0,
		});
	}

	recordFailure(sessionId: string): number {
		const state = this.getState(sessionId);
		const nextFailures = (state.consecutiveFailures ?? 0) + 1;
		this._states.set(sessionId, { ...state, consecutiveFailures: nextFailures });
		return nextFailures;
	}
}
