/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Resolution Metrics
 *
 * Tracks statistics about the resolution run for diagnostics and UI display.
 *
 * Answers questions like:
 *   - What percentage of units are fully resolved?
 *   - Which dependencies were not found (and how often are they referenced)?
 *   - Which language has the lowest resolution rate?
 *   - What is the median resolution time per unit?
 */

import { IUnitResolutionResult } from './resolutionTypes.js';


// \u2500\u2500\u2500 Metric Types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IResolutionLanguageStats {
	language: string;
	totalUnits: number;
	fullyResolved: number;
	partiallyResolved: number;
	unresolvable: number;
	resolutionRate: number;   // 0\u2013100
}

export interface IMissingDependency {
	canonicalName: string;
	language: string;
	/** How many different units reference this missing dependency */
	referenceCount: number;
	/** IDs of units that reference this dependency */
	referencingUnitIds: string[];
}

export interface IResolutionMetricsSnapshot {
	totalUnits: number;
	fullyResolved: number;
	partiallyResolved: number;
	unresolvable: number;
	cyclesDetected: number;
	failed: number;
	overallResolutionRate: number;   // 0\u2013100
	byLanguage: IResolutionLanguageStats[];
	/** Top 20 most-referenced missing dependencies */
	topMissingDeps: IMissingDependency[];
	avgDurationMs: number;
	totalDurationMs: number;
}


// \u2500\u2500\u2500 Collector \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * ResolutionMetricsCollector \u2014 accumulates results during a batch run.
 * Call snapshot() at any point to get the current state.
 */
export class ResolutionMetricsCollector {
	private readonly _results: IUnitResolutionResult[] = [];
	private readonly _missingDeps = new Map<string, IMissingDependency>();
	private readonly _byLanguage = new Map<string, IResolutionLanguageStats>();

	/**
	 * Record a completed unit resolution result.
	 */
	record(result: IUnitResolutionResult): void {
		this._results.push(result);
		this._updateLanguageStats(result);
		this._recordMissingDeps(result);
	}

	/**
	 * Get the current metrics snapshot.
	 */
	snapshot(): IResolutionMetricsSnapshot {
		const total = this._results.length;
		const fullyResolved = this._results.filter(r => r.outcome === 'resolved').length;
		const partiallyResolved = this._results.filter(r => r.outcome === 'partial').length;
		const unresolvable = this._results.filter(r => r.outcome === 'unresolvable').length;
		const cyclesDetected = this._results.filter(r => r.outcome === 'cycle').length;
		const failed = this._results.filter(r => r.outcome === 'error').length;

		const overallResolutionRate = total === 0
			? 0
			: Math.round(((fullyResolved + partiallyResolved) / total) * 100);

		const totalDurationMs = this._results.reduce((sum, r) => sum + r.durationMs, 0);
		const avgDurationMs = total === 0 ? 0 : Math.round(totalDurationMs / total);

		const topMissingDeps = [...this._missingDeps.values()]
			.sort((a, b) => b.referenceCount - a.referenceCount)
			.slice(0, 20);

		return {
			totalUnits: total,
			fullyResolved,
			partiallyResolved,
			unresolvable,
			cyclesDetected,
			failed,
			overallResolutionRate,
			byLanguage: [...this._byLanguage.values()],
			topMissingDeps,
			avgDurationMs,
			totalDurationMs,
		};
	}

	/**
	 * Reset all accumulated data.
	 */
	reset(): void {
		this._results.length = 0;
		this._missingDeps.clear();
		this._byLanguage.clear();
	}

	// \u2500\u2500 Private \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _updateLanguageStats(result: IUnitResolutionResult): void {
		let stats = this._byLanguage.get(result.language);
		if (!stats) {
			stats = {
				language: result.language,
				totalUnits: 0,
				fullyResolved: 0,
				partiallyResolved: 0,
				unresolvable: 0,
				resolutionRate: 0,
			};
			this._byLanguage.set(result.language, stats);
		}

		stats.totalUnits++;
		if (result.outcome === 'resolved') {
			stats.fullyResolved++;
		} else if (result.outcome === 'partial') {
			stats.partiallyResolved++;
		} else if (result.outcome === 'unresolvable') {
			stats.unresolvable++;
		}

		stats.resolutionRate = Math.round(
			((stats.fullyResolved + stats.partiallyResolved) / stats.totalUnits) * 100
		);
	}

	private _recordMissingDeps(result: IUnitResolutionResult): void {
		for (const dep of result.unresolvedDeps) {
			if (dep.isExternal) {
				continue; // External libs are expected to be missing
			}
			const key = `${result.language}:${dep.ref.canonicalName.toUpperCase()}`;
			let entry = this._missingDeps.get(key);
			if (!entry) {
				entry = {
					canonicalName: dep.ref.canonicalName,
					language: result.language,
					referenceCount: 0,
					referencingUnitIds: [],
				};
				this._missingDeps.set(key, entry);
			}
			entry.referenceCount++;
			if (!entry.referencingUnitIds.includes(result.unitId)) {
				entry.referencingUnitIds.push(result.unitId);
			}
		}
	}
}
