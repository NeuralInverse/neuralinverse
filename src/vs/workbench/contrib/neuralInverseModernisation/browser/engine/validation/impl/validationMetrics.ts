/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Validation Metrics Collector
 *
 * Tracks and aggregates metrics across all units in a batch validation run.
 * Updated incrementally as each unit completes — safe to read at any point.
 */

import { IValidationResult, IValidationBatchMetrics } from './validationTypes.js';


// ─── Collector ─────────────────────────────────────────────────────────────────

export class ValidationMetricsCollector {

	private _totalUnits  = 0;
	private _validated   = 0;
	private _partial     = 0;
	private _failed      = 0;
	private _error       = 0;
	private _skipped     = 0;

	private _totalTestCases  = 0;
	private _passedTestCases = 0;
	private _failedTestCases = 0;

	private _totalDurationMs = 0;
	private _batchStartMs    = Date.now();

	// ── Mutation ──────────────────────────────────────────────────────────────

	record(result: IValidationResult): void {
		this._totalUnits++;
		this._totalDurationMs += result.durationMs;

		switch (result.outcome) {
			case 'validated': this._validated++;   break;
			case 'partial':   this._partial++;     break;
			case 'failed':    this._failed++;      break;
			case 'error':     this._error++;       break;
			case 'skipped':   this._skipped++;     break;
		}

		this._totalTestCases  += result.testCaseCount;
		this._passedTestCases += result.passCount;
		this._failedTestCases += result.failCount;
	}

	// ── Snapshot ──────────────────────────────────────────────────────────────

	snapshot(): IValidationBatchMetrics {
		return {
			totalUnits:      this._totalUnits,
			validated:       this._validated,
			partial:         this._partial,
			failed:          this._failed,
			error:           this._error,
			skipped:         this._skipped,
			totalTestCases:  this._totalTestCases,
			passedTestCases: this._passedTestCases,
			failedTestCases: this._failedTestCases,
			totalDurationMs: Date.now() - this._batchStartMs,
			avgDurationMs:   this._totalUnits > 0
				? Math.round(this._totalDurationMs / this._totalUnits)
				: 0,
		};
	}

	// ── Derived stats ─────────────────────────────────────────────────────────

	/** Pass rate across all test cases (0–1) */
	get testCasePassRate(): number {
		if (this._totalTestCases === 0) { return 1; }
		return this._passedTestCases / this._totalTestCases;
	}

	/** Fraction of processed units that fully validated (0–1) */
	get unitValidationRate(): number {
		const processed = this._totalUnits - this._skipped;
		if (processed === 0) { return 1; }
		return this._validated / processed;
	}

	/** Whether any units have divergences (outcome='failed') */
	get hasDivergences(): boolean {
		return this._failed > 0;
	}

	/** Whether any units need human review (partial or error) */
	get hasReviewNeeded(): boolean {
		return this._partial > 0 || this._error > 0;
	}
}


// ─── Formatting utilities ─────────────────────────────────────────────────────

/** Format an outcome label for display */
export function outcomeLabel(outcome: IValidationResult['outcome']): string {
	switch (outcome) {
		case 'validated': return 'Validated';
		case 'partial':   return 'Partial';
		case 'failed':    return 'Failed';
		case 'error':     return 'Error';
		case 'skipped':   return 'Skipped';
		default:          return String(outcome);
	}
}

/** Format confidence for display */
export function confidenceLabel(confidence: IValidationResult['confidence']): string {
	switch (confidence) {
		case 'high':      return 'High';
		case 'medium':    return 'Medium';
		case 'low':       return 'Low';
		case 'uncertain': return 'Uncertain';
		default:          return String(confidence);
	}
}

/** Format a batch metrics summary as a single-line string for logging */
export function formatBatchMetricsSummary(m: IValidationBatchMetrics): string {
	const passRate = m.totalTestCases > 0
		? `${Math.round((m.passedTestCases / m.totalTestCases) * 100)}%`
		: 'N/A';

	return [
		`units=${m.totalUnits}`,
		`validated=${m.validated}`,
		`partial=${m.partial}`,
		`failed=${m.failed}`,
		`error=${m.error}`,
		`skipped=${m.skipped}`,
		`testCases=${m.totalTestCases}`,
		`testPassRate=${passRate}`,
		`avgDuration=${m.avgDurationMs}ms`,
	].join(' ');
}
