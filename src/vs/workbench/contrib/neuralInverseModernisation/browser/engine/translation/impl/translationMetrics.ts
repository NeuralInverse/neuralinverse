/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Translation Metrics Collector
 *
 * Collects and aggregates runtime statistics about a translation batch.
 * Used by the console UI to render progress bars, timing estimates, and
 * language-pair-level quality summaries.
 *
 * ## What is tracked
 *
 * ### Per-run totals
 *   - Units attempted / succeeded / failed / blocked / skipped
 *   - Total tokens consumed (estimated from context builder)
 *   - Total wall-clock duration (ms)
 *   - Total LLM call count (across all retries)
 *
 * ### Per-language-pair stats
 *   - Success/error/blocked counts
 *   - Average confidence score (0–3 scale, aggregated from `CONFIDENCE_SCORE`)
 *   - Average tokens per unit
 *   - Average duration per unit (ms)
 *
 * ### Per-unit record
 *   - Stored for every unit that was attempted; kept for the lifetime of the batch
 *   - Used to feed into the console Unit Index view
 *
 * ## Thread safety
 *
 * `TranslationMetricsCollector` is NOT thread-safe. The batch engine must
 * call `record()` sequentially (after each unit completes), not from concurrent
 * promise callbacks without serialisation.
 */

import { ITranslationResult, TranslationOutcome, TranslationConfidence, CONFIDENCE_SCORE } from './translationTypes.js';


// ─── Metric types ─────────────────────────────────────────────────────────────

/** Stats for a single source\u2192target language pair */
export interface ILanguagePairMetrics {
	sourceLang: string;
	targetLang: string;
	/** Language pair label (e.g. 'COBOL \u2192 Java') */
	label: string;
	attempted:   number;
	succeeded:   number;
	partial:     number;
	blocked:     number;
	failed:      number;
	skipped:     number;
	/** Sum of CONFIDENCE_SCORE values for succeeded/partial units */
	confidenceSum: number;
	/** Total tokens consumed across all units in this pair */
	totalTokens: number;
	/** Total wall-clock ms across all units in this pair */
	totalDurationMs: number;
	/** Total LLM call count (retries included) */
	totalAttempts: number;
}

/** Top-level snapshot of the entire batch run */
export interface ITranslationBatchMetrics {
	/** Timestamp when the batch was started */
	startedAt: number;
	/** Timestamp of the last recorded result (or null if nothing recorded yet) */
	lastRecordedAt: number | null;
	/** Total wall-clock elapsed ms since startedAt */
	elapsedMs: number;

	// Counts
	totalUnits:     number;
	attempted:      number;
	succeeded:      number;
	partial:        number;
	blocked:        number;
	failed:         number;
	skipped:        number;

	// Quality
	/** Average confidence across succeeded+partial units (0.0–3.0 scale) */
	averageConfidence: number;
	/** Number of units with at least one decision raised */
	unitsWithDecisions: number;
	/** Number of units with at least one blocking decision */
	unitsWithBlockingDecisions: number;

	// Resource usage
	totalTokensConsumed: number;
	totalLLMCalls:       number;

	// Throughput
	/** Succeeded + partial units per minute (0 if < 10 s elapsed) */
	unitsPerMinute: number;

	// Per-language-pair breakdown
	byLanguagePair: ILanguagePairMetrics[];

	/** Ordered list of unit IDs by outcome (for console Unit Index) */
	succeededUnitIds: string[];
	partialUnitIds:   string[];
	blockedUnitIds:   string[];
	failedUnitIds:    string[];
	skippedUnitIds:   string[];
}


// ─── Collector ────────────────────────────────────────────────────────────────

export class TranslationMetricsCollector {

	private readonly _startedAt: number;
	private _lastRecordedAt: number | null = null;

	// Aggregate counters
	private _totalUnits    = 0;
	private _attempted     = 0;
	private _succeeded     = 0;
	private _partial       = 0;
	private _blocked       = 0;
	private _failed        = 0;
	private _skipped       = 0;

	// Quality
	private _confidenceSum       = 0;
	private _confidenceCount     = 0;
	private _unitsWithDecisions  = 0;
	private _unitsWithBlocking   = 0;

	// Resource
	private _totalTokens   = 0;
	private _totalLLMCalls = 0;

	// Bucketed unit IDs (for the console Unit Index)
	private readonly _succeededIds: string[] = [];
	private readonly _partialIds:   string[] = [];
	private readonly _blockedIds:   string[] = [];
	private readonly _failedIds:    string[] = [];
	private readonly _skippedIds:   string[] = [];

	// Per-language-pair accumulators
	private readonly _pairs = new Map<string, ILanguagePairMetrics>();

	constructor(totalUnits: number) {
		this._startedAt = Date.now();
		this._totalUnits = totalUnits;
	}

	// ── Recording ─────────────────────────────────────────────────────────────

	/**
	 * Record one unit's completed result.
	 * Must be called after each unit finishes (success, error, blocked, or skip).
	 */
	record(result: ITranslationResult): void {
		this._lastRecordedAt = Date.now();
		this._attempted++;

		// Outcome bucketing
		switch (result.outcome) {
			case 'translated': this._succeeded++;     this._succeededIds.push(result.unitId); break;
			case 'partial':    this._partial++;       this._partialIds.push(result.unitId);   break;
			case 'blocked':    this._blocked++;       this._blockedIds.push(result.unitId);   break;
			case 'error':      this._failed++;        this._failedIds.push(result.unitId);    break;
			case 'skipped':    this._skipped++;       this._skippedIds.push(result.unitId);   break;
		}

		// Quality accumulators
		if (result.outcome === 'translated' || result.outcome === 'partial') {
			const score = CONFIDENCE_SCORE[result.confidence] ?? 0;
			this._confidenceSum += score;
			this._confidenceCount++;
		}
		if (result.decisionsRaised.length > 0) {
			this._unitsWithDecisions++;
		}
		if (result.decisionsRaised.some(d => d.priority === 'blocking')) {
			this._unitsWithBlocking++;
		}

		// Resource accumulators
		this._totalTokens   += result.tokensUsed;
		this._totalLLMCalls += result.attemptCount;

		// Per-language-pair
		this._recordPair(result);
	}

	/**
	 * Record a unit that was determined to be ineligible before any LLM call.
	 * Increments the skipped counter without touching quality/resource metrics.
	 */
	recordSkipped(unitId: string, sourceLang: string, targetLang: string): void {
		this._lastRecordedAt = Date.now();
		this._skipped++;
		this._skippedIds.push(unitId);
		this._touchPair(sourceLang, targetLang);
		const pair = this._getPair(sourceLang, targetLang);
		pair.skipped++;
	}

	// ── Snapshot ──────────────────────────────────────────────────────────────

	/**
	 * Return a point-in-time snapshot of all collected metrics.
	 * Safe to call at any point during or after the batch.
	 */
	snapshot(): ITranslationBatchMetrics {
		const now      = Date.now();
		const elapsed  = now - this._startedAt;
		const doneCount = this._succeeded + this._partial;
		const upm       = elapsed > 10_000 ? (doneCount / elapsed) * 60_000 : 0;

		return {
			startedAt:     this._startedAt,
			lastRecordedAt: this._lastRecordedAt,
			elapsedMs:     elapsed,

			totalUnits:    this._totalUnits,
			attempted:     this._attempted,
			succeeded:     this._succeeded,
			partial:       this._partial,
			blocked:       this._blocked,
			failed:        this._failed,
			skipped:       this._skipped,

			averageConfidence:          this._confidenceCount > 0 ? this._confidenceSum / this._confidenceCount : 0,
			unitsWithDecisions:         this._unitsWithDecisions,
			unitsWithBlockingDecisions: this._unitsWithBlocking,

			totalTokensConsumed: this._totalTokens,
			totalLLMCalls:       this._totalLLMCalls,
			unitsPerMinute:      Math.round(upm * 10) / 10,

			byLanguagePair:   [...this._pairs.values()],
			succeededUnitIds: [...this._succeededIds],
			partialUnitIds:   [...this._partialIds],
			blockedUnitIds:   [...this._blockedIds],
			failedUnitIds:    [...this._failedIds],
			skippedUnitIds:   [...this._skippedIds],
		};
	}

	/**
	 * A string summary suitable for console output or logging.
	 * Format: "Translated 42/100 (3 blocked, 2 failed) | 12.5k tokens | 2.1 units/min"
	 */
	summaryLine(): string {
		const s = this.snapshot();
		const done = s.succeeded + s.partial;
		const parts: string[] = [
			`Translated ${done}/${s.totalUnits}`,
		];
		if (s.blocked > 0) { parts.push(`${s.blocked} blocked`); }
		if (s.failed  > 0) { parts.push(`${s.failed} failed`);   }
		if (s.skipped > 0) { parts.push(`${s.skipped} skipped`); }
		const summary = parts.join(', ');
		const tokens  = s.totalTokensConsumed > 999
			? `${(s.totalTokensConsumed / 1000).toFixed(1)}k tokens`
			: `${s.totalTokensConsumed} tokens`;
		const upm = s.unitsPerMinute > 0 ? ` | ${s.unitsPerMinute} units/min` : '';
		return `${summary} | ${tokens}${upm}`;
	}


	// ── Private helpers ───────────────────────────────────────────────────────

	private _recordPair(result: ITranslationResult): void {
		this._touchPair(result.sourceLang, result.targetLang);
		const pair = this._getPair(result.sourceLang, result.targetLang);

		pair.attempted++;
		pair.totalTokens    += result.tokensUsed;
		pair.totalDurationMs += result.durationMs;
		pair.totalAttempts  += result.attemptCount;

		switch (result.outcome) {
			case 'translated': pair.succeeded++; break;
			case 'partial':    pair.partial++;   break;
			case 'blocked':    pair.blocked++;   break;
			case 'error':      pair.failed++;    break;
			case 'skipped':    pair.skipped++;   break;
		}

		if (result.outcome === 'translated' || result.outcome === 'partial') {
			const score = CONFIDENCE_SCORE[result.confidence] ?? 0;
			pair.confidenceSum += score;
		}
	}

	private _touchPair(sourceLang: string, targetLang: string): void {
		const key = pairKey(sourceLang, targetLang);
		if (!this._pairs.has(key)) {
			this._pairs.set(key, {
				sourceLang,
				targetLang,
				label:           `${sourceLang.toUpperCase()} \u2192 ${targetLang.toUpperCase()}`,
				attempted:       0,
				succeeded:       0,
				partial:         0,
				blocked:         0,
				failed:          0,
				skipped:         0,
				confidenceSum:   0,
				totalTokens:     0,
				totalDurationMs: 0,
				totalAttempts:   0,
			});
		}
	}

	private _getPair(sourceLang: string, targetLang: string): ILanguagePairMetrics {
		return this._pairs.get(pairKey(sourceLang, targetLang))!;
	}
}


// ─── Utility ──────────────────────────────────────────────────────────────────

function pairKey(source: string, target: string): string {
	return `${source.toLowerCase()}\u2192${target.toLowerCase()}`;
}

/**
 * Format a confidence score (0.0–3.0) as a human-readable label with percentage.
 * Used in console UI and reporting.
 */
export function formatConfidenceScore(score: number): string {
	const pct = Math.round((score / 3) * 100);
	if (score >= 2.5) { return `High (${pct}%)`; }
	if (score >= 1.5) { return `Medium (${pct}%)`; }
	if (score >= 0.5) { return `Low (${pct}%)`; }
	return `Uncertain (${pct}%)`;
}

/**
 * Convert a `TranslationConfidence` string to the 0–3 numeric score.
 */
export function confidenceToScore(confidence: TranslationConfidence): number {
	return CONFIDENCE_SCORE[confidence] ?? 0;
}

/**
 * Return a human-readable outcome label for display.
 */
export function outcomeLabel(outcome: TranslationOutcome): string {
	switch (outcome) {
		case 'translated': return 'Translated';
		case 'partial':    return 'Partial';
		case 'blocked':    return 'Blocked';
		case 'error':      return 'Error';
		case 'skipped':    return 'Skipped';
	}
}
