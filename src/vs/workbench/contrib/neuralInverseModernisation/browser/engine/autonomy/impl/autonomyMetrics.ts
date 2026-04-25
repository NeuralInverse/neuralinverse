/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Autonomy Metrics Collector
 *
 * Collects and aggregates runtime statistics about an autonomy batch run.
 * Mirrors TranslationMetricsCollector in depth and structure.
 *
 * ## What is tracked
 *
 *  - Outcome counts: advanced / escalated / errors / skipped
 *  - Per-stage completion counts and timing statistics (min / max / total / avg)
 *  - Per-domain outcome distribution
 *  - Per-risk-level outcome distribution
 *  - Error category breakdown
 *  - Throughput: units advanced per minute
 *  - ETA: estimated remaining milliseconds based on current throughput
 *  - Unit ID lists bucketed by outcome (for the console Unit Index)
 */

import { IKnowledgeUnit } from '../../../../common/knowledgeBaseTypes.js';
import {
	IAutonomyUnitResult,
	IAutonomyBatchMetrics,
	AutonomyStage,
	AutonomyErrorCategory,
	IStageTiming,
	ALL_AUTONOMY_STAGES,
} from './autonomyTypes.js';


// ─── Collector ────────────────────────────────────────────────────────────────

export class AutonomyMetricsCollector {

	private readonly _runId:       string;
	private readonly _totalUnits:  number;
	private readonly _startedAt:   number;

	// Aggregate outcome counters
	private _totalProcessed = 0;
	private _advanced       = 0;
	private _escalated      = 0;
	private _errors         = 0;
	private _skipped        = 0;

	// Stage completion + timing
	private readonly _stageCount: Record<AutonomyStage, number>   = { resolve: 0, translate: 0, validate: 0, commit: 0 };
	private readonly _stageTotalMs: Record<AutonomyStage, number> = { resolve: 0, translate: 0, validate: 0, commit: 0 };
	private readonly _stageMinMs: Record<AutonomyStage, number>   = { resolve: Infinity, translate: Infinity, validate: Infinity, commit: Infinity };
	private readonly _stageMaxMs: Record<AutonomyStage, number>   = { resolve: 0, translate: 0, validate: 0, commit: 0 };

	// Domain breakdown (domain \u2192 advanced count)
	private readonly _byDomain: Record<string, number> = {};

	// Risk breakdown (riskLevel \u2192 advanced count)
	private readonly _byRisk: Record<string, number> = {};

	// Error category counts
	private readonly _byErrorCategory: Partial<Record<AutonomyErrorCategory, number>> = {};

	// Unit ID lists
	private readonly _advancedIds:  string[] = [];
	private readonly _escalatedIds: string[] = [];
	private readonly _errorIds:     string[] = [];
	private readonly _skippedIds:   string[] = [];

	constructor(runId: string, totalUnits: number, startedAt: number) {
		this._runId      = runId;
		this._totalUnits = totalUnits;
		this._startedAt  = startedAt;
	}

	// ── Recording ─────────────────────────────────────────────────────────────

	/**
	 * Record a completed unit result.
	 * Call this after every unit, success or failure.
	 * Pass the KB unit (if available) to populate domain and risk breakdowns.
	 * NOT thread-safe — must be called serially.
	 */
	record(result: IAutonomyUnitResult, kbUnit?: IKnowledgeUnit): void {
		this._totalProcessed++;

		switch (result.outcome) {
			case 'advanced':  this._advanced++;  this._advancedIds.push(result.unitId);  break;
			case 'escalated': this._escalated++; this._escalatedIds.push(result.unitId); break;
			case 'error':     this._errors++;    this._errorIds.push(result.unitId);     break;
			case 'skipped':   this._skipped++;   this._skippedIds.push(result.unitId);   break;
		}

		// Stage timing
		if (result.outcome === 'advanced' && result.stageCompleted) {
			const s  = result.stageCompleted;
			const ms = result.durationMs;
			this._stageCount[s]++;
			this._stageTotalMs[s] += ms;
			if (ms < this._stageMinMs[s]) { this._stageMinMs[s] = ms; }
			if (ms > this._stageMaxMs[s]) { this._stageMaxMs[s] = ms; }
		}

		// Domain and risk breakdowns — count all non-skipped outcomes
		if (result.outcome !== 'skipped' && kbUnit) {
			const domain    = kbUnit.domain;
			const riskLevel = kbUnit.riskLevel;
			if (typeof domain === 'string' && domain) {
				this._byDomain[domain] = (this._byDomain[domain] ?? 0) + 1;
			}
			if (riskLevel) {
				this._byRisk[riskLevel] = (this._byRisk[riskLevel] ?? 0) + 1;
			}
		}

		// Error category
		if (result.errorCategory) {
			this._byErrorCategory[result.errorCategory] =
				(this._byErrorCategory[result.errorCategory] ?? 0) + 1;
		}
	}

	/**
	 * Build a point-in-time snapshot of all collected metrics.
	 * Safe to call at any point during the batch run.
	 */
	snapshot(): IAutonomyBatchMetrics {
		return this._buildMetrics(false);
	}

	/**
	 * Finalise the metrics after the batch completes.
	 * Sets completedAt and wasAborted.
	 */
	finalize(wasAborted: boolean): IAutonomyBatchMetrics {
		return this._buildMetrics(wasAborted);
	}

	// ── Summary ────────────────────────────────────────────────────────────────

	/**
	 * Human-readable summary line for logging.
	 * e.g. "Advanced 42/100 — 3 escalated, 1 error, 12 skipped | 2.1 units/min"
	 */
	summaryLine(): string {
		const s     = this.snapshot();
		const parts = [`Advanced ${s.advanced}/${s.totalProcessed}`];
		if (s.escalated > 0) { parts.push(`${s.escalated} escalated`); }
		if (s.errors    > 0) { parts.push(`${s.errors} error(s)`);     }
		if (s.skipped   > 0) { parts.push(`${s.skipped} skipped`);     }
		const summary = parts.join(' — ');
		const upm = s.unitsPerMinute > 0 ? ` | ${s.unitsPerMinute} units/min` : '';
		const eta = s.estimatedRemainingMs != null
			? ` | ETA ${_formatDuration(s.estimatedRemainingMs)}`
			: '';
		return `${summary}${upm}${eta}`;
	}


	// ── Private ───────────────────────────────────────────────────────────────

	private _buildMetrics(wasAborted: boolean): IAutonomyBatchMetrics {
		const now       = Date.now();
		const elapsed   = now - this._startedAt;

		// Throughput
		const upm = elapsed > 10_000 && this._advanced > 0
			? Math.round(((this._advanced / elapsed) * 60_000) * 10) / 10
			: 0;

		// ETA
		let eta: number | null = null;
		if (upm > 0) {
			const remaining = this._totalUnits - this._totalProcessed;
			if (remaining > 0) {
				eta = Math.round((remaining / upm) * 60_000);
			}
		}

		// Stage timing structs
		const stageTiming: Record<AutonomyStage, IStageTiming> = {} as never;
		for (const stage of ALL_AUTONOMY_STAGES) {
			const count   = this._stageCount[stage];
			const totalMs = this._stageTotalMs[stage];
			stageTiming[stage] = {
				count,
				totalMs,
				minMs: count > 0 ? this._stageMinMs[stage] : 0,
				maxMs: this._stageMaxMs[stage],
				avgMs: count > 0 ? Math.round(totalMs / count) : 0,
			};
		}

		return {
			runId:          this._runId,
			startedAt:      this._startedAt,
			completedAt:    now,
			durationMs:     elapsed,
			wasAborted,
			totalProcessed: this._totalProcessed,
			advanced:       this._advanced,
			escalated:      this._escalated,
			errors:         this._errors,
			skipped:        this._skipped,
			byStage:        { ...this._stageCount },
			stageTiming,
			byErrorCategory: { ...this._byErrorCategory },
			unitsPerMinute:  upm,
			estimatedRemainingMs: eta,
			byDomain:        { ...this._byDomain },
			byRisk:          { ...this._byRisk },
			advancedUnitIds:  [...this._advancedIds],
			escalatedUnitIds: [...this._escalatedIds],
			errorUnitIds:     [...this._errorIds],
			skippedUnitIds:   [...this._skippedIds],
		};
	}
}


// ─── Utility ──────────────────────────────────────────────────────────────────

function _formatDuration(ms: number): string {
	const secs  = Math.round(ms / 1000);
	const mins  = Math.floor(secs / 60);
	const hours = Math.floor(mins / 60);
	if (hours > 0) { return `${hours}h ${mins % 60}m`; }
	if (mins  > 0) { return `${mins}m ${secs % 60}s`; }
	return `${secs}s`;
}

/**
 * Format a stage timing record as a human-readable string.
 * e.g. "resolve: 18 units, avg 4.2s, min 1.1s, max 32s"
 */
export function formatStageTiming(stage: AutonomyStage, timing: IStageTiming): string {
	if (timing.count === 0) { return `${stage}: no completions`; }
	const avg = (timing.avgMs / 1000).toFixed(1);
	const min = (timing.minMs / 1000).toFixed(1);
	const max = (timing.maxMs / 1000).toFixed(1);
	return `${stage}: ${timing.count} unit(s), avg ${avg}s, min ${min}s, max ${max}s`;
}

/**
 * Return a descriptive label for an error category.
 */
export function errorCategoryLabel(category: AutonomyErrorCategory): string {
	switch (category) {
		case 'service-unavailable':   return 'Service Unavailable';
		case 'unit-locked':           return 'Lock Conflict';
		case 'missing-source':        return 'Missing Source Code';
		case 'missing-target':        return 'Missing Translation';
		case 'parse-error':           return 'LLM Parse Error';
		case 'validation-divergence': return 'Equivalence Divergence';
		case 'commit-error':          return 'File Write Error';
		case 'dependency-incomplete': return 'Incomplete Dependencies';
		case 'stage-timeout':         return 'Stage Timeout';
		case 'unknown':               return 'Unknown Error';
	}
}
