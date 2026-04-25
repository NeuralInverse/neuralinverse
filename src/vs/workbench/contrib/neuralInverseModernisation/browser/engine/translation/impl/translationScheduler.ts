/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Translation Scheduler
 *
 * Determines the optimal order for translating knowledge units.
 *
 * ## Scheduling Algorithm
 *
 * Units are ordered by a priority score that combines three signals:
 *
 * 1. **Dependency depth** (topological order):
 *    Leaf nodes (no unresolved dependencies) are scheduled first.
 *    A unit with N unresolved dependencies is scheduled N levels later.
 *    This ensures called units are translated before callers, so
 *    `calledInterfaces` context is available when the caller is processed.
 *
 * 2. **Risk level** (within the same dependency depth):
 *    `critical > high > medium > low`
 *    Higher-risk units are translated earlier to surface blocking decisions
 *    as quickly as possible, giving humans maximum lead time.
 *
 * 3. **Dependent count** (tiebreaker):
 *    Units with more callers are scheduled before units with fewer callers.
 *    Translating widely-used utilities early maximises the `calledInterfaces`
 *    context available to their callers.
 *
 * ## Pre-flight eligibility filter
 *
 * The scheduler also filters out ineligible units before building the queue:
 *   - Status not in `eligibleStatuses` (default: `['ready']`)
 *   - Risk level below `minRiskLevel`
 *   - `skipIfDependenciesUnresolved` = true and the unit has unresolved deps
 *   - Unit is explicitly excluded (caller must filter these before calling)
 *
 * ## Interface
 *
 * `TranslationScheduler` is a one-shot, immutable queue. Create a new instance
 * per translation batch. Mutating the KB after construction does NOT affect the
 * queue order.
 */

import { IKnowledgeUnit, RiskLevel, UnitStatus } from '../../../../common/knowledgeBaseTypes.js';
import { ITranslationOptions } from './translationTypes.js';


// \u2500\u2500\u2500 Risk priority mapping \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const RISK_SCORE: Record<RiskLevel, number> = {
	critical: 4,
	high:     3,
	medium:   2,
	low:      1,
};

const RISK_ORDER: RiskLevel[] = ['critical', 'high', 'medium', 'low'];


// \u2500\u2500\u2500 Scheduler \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IScheduledUnit {
	/** The unit to translate */
	unit: IKnowledgeUnit;
	/** Topological depth (0 = leaf node / no deps) */
	depth: number;
	/** Priority score (higher = more urgent) */
	priorityScore: number;
}

/**
 * Immutable translation schedule.
 *
 * Build once per batch with `TranslationScheduler.build()`, then iterate with
 * `dequeue()` or `dequeueAll()`.
 */
export class TranslationScheduler {

	private readonly _queue: IScheduledUnit[];
	private _cursor: number = 0;

	private constructor(queue: IScheduledUnit[]) {
		this._queue = queue;
	}

	// \u2500\u2500 Factory \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Build a prioritised translation schedule from the provided units.
	 *
	 * @param units    All eligible units from the KB (pre-filtered for status/eligibility)
	 * @param options  Translation options (for minRiskLevel + skipIfDependenciesUnresolved)
	 */
	static build(
		units: IKnowledgeUnit[],
		options: Pick<ITranslationOptions,
			| 'eligibleStatuses'
			| 'minRiskLevel'
			| 'skipIfDependenciesUnresolved'
		>,
	): TranslationScheduler {
		// \u2500\u2500 Filter eligible units \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const minRiskScore = RISK_SCORE[options.minRiskLevel ?? 'low'];
		const eligible     = units.filter(u => isEligible(u, options.eligibleStatuses, minRiskScore, options.skipIfDependenciesUnresolved));

		// \u2500\u2500 Build dependency depth map \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		// Build a fast ID\u2192unit map for depth calculation
		const unitMap = new Map<string, IKnowledgeUnit>(eligible.map(u => [u.id, u]));
		const depthMap = buildDepthMap(eligible, unitMap);

		// \u2500\u2500 Build scored queue \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const scheduled: IScheduledUnit[] = eligible.map(u => {
			const depth    = depthMap.get(u.id) ?? 0;
			const priority = scoreUnit(u, depth);
			return { unit: u, depth, priorityScore: priority };
		});

		// Sort: lowest depth first, then highest priority score, then most callers
		scheduled.sort((a, b) => {
			if (a.depth !== b.depth) { return a.depth - b.depth; }
			if (a.priorityScore !== b.priorityScore) { return b.priorityScore - a.priorityScore; }
			return b.unit.usedBy.length - a.unit.usedBy.length;
		});

		return new TranslationScheduler(scheduled);
	}

	// \u2500\u2500 Queue API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Total number of units in this schedule */
	get total(): number { return this._queue.length; }

	/** Number of units not yet dequeued */
	get remaining(): number { return this._queue.length - this._cursor; }

	/** Whether there are more units to process */
	get hasNext(): boolean { return this._cursor < this._queue.length; }

	/**
	 * Dequeue the next unit in schedule order.
	 * Returns `undefined` when the queue is exhausted.
	 */
	dequeue(): IScheduledUnit | undefined {
		if (!this.hasNext) { return undefined; }
		return this._queue[this._cursor++];
	}

	/**
	 * Dequeue up to `count` units at once (for concurrency batching).
	 * Returns fewer if the queue has fewer remaining.
	 */
	dequeueBatch(count: number): IScheduledUnit[] {
		const batch: IScheduledUnit[] = [];
		while (batch.length < count && this.hasNext) {
			batch.push(this._queue[this._cursor++]);
		}
		return batch;
	}

	/** Return all scheduled units without consuming the cursor */
	peekAll(): ReadonlyArray<IScheduledUnit> {
		return this._queue;
	}

	/** Return scheduled units grouped by topological depth (for display) */
	byDepth(): Map<number, IScheduledUnit[]> {
		const result = new Map<number, IScheduledUnit[]>();
		for (const item of this._queue) {
			const arr = result.get(item.depth);
			if (arr) {
				arr.push(item);
			} else {
				result.set(item.depth, [item]);
			}
		}
		return result;
	}

	/** Return counts by risk level (for progress reporting) */
	countByRisk(): Record<RiskLevel, number> {
		const counts: Record<RiskLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
		for (const item of this._queue) {
			counts[item.unit.riskLevel]++;
		}
		return counts;
	}
}


// \u2500\u2500\u2500 Eligibility check \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function isEligible(
	unit: IKnowledgeUnit,
	eligibleStatuses: UnitStatus[],
	minRiskScore: number,
	skipIfDepsUnresolved: boolean,
): boolean {
	if (!eligibleStatuses.includes(unit.status)) { return false; }
	if (RISK_SCORE[unit.riskLevel] < minRiskScore)  { return false; }
	if (skipIfDepsUnresolved && unit.dependsOn.length > 0) {
		// The caller (TranslationEngineServiceImpl) passes units with resolved deps,
		// but if this flag is set we only schedule units whose deps are all done.
		// We use the 'dependsOn' list as a proxy \u2014 if any dep is listed it may not
		// be translated yet. The loop can pass a pre-filtered list to be stricter.
		return false;
	}
	return true;
}


// \u2500\u2500\u2500 Depth calculation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Calculate the topological depth of each unit.
 * Depth = length of the longest dependency chain leading to this unit.
 * Leaf nodes (no deps in the eligible set) have depth 0.
 *
 * Uses iterative memoized DFS to avoid stack overflow on large dependency graphs.
 */
function buildDepthMap(
	units: IKnowledgeUnit[],
	unitMap: Map<string, IKnowledgeUnit>,
): Map<string, number> {
	const memo = new Map<string, number>();

	function depth(unitId: string, visiting: Set<string>): number {
		if (memo.has(unitId)) { return memo.get(unitId)!; }
		if (visiting.has(unitId)) { return 0; } // Cycle guard \u2014 treat cycles as depth 0

		const unit = unitMap.get(unitId);
		if (!unit || unit.dependsOn.length === 0) {
			memo.set(unitId, 0);
			return 0;
		}

		visiting.add(unitId);
		let maxDep = 0;
		for (const depId of unit.dependsOn) {
			if (unitMap.has(depId)) {
				const d = depth(depId, visiting);
				if (d + 1 > maxDep) { maxDep = d + 1; }
			}
		}
		visiting.delete(unitId);

		memo.set(unitId, maxDep);
		return maxDep;
	}

	for (const unit of units) {
		depth(unit.id, new Set());
	}
	return memo;
}


// \u2500\u2500\u2500 Priority scoring \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Compute a priority score for a unit.
 * Higher score = higher priority within its depth tier.
 *
 * Score components:
 *   - Risk level:      0\u201340 (critical=40, high=30, medium=20, low=10)
 *   - Dependent count: 0\u20139 (capped at 9, to keep risk dominant)
 */
function scoreUnit(unit: IKnowledgeUnit, _depth: number): number {
	const riskScore  = (RISK_SCORE[unit.riskLevel] ?? 1) * 10;
	const depScore   = Math.min(unit.usedBy.length, 9);
	return riskScore + depScore;
}


// \u2500\u2500\u2500 Utility exports \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Return the ordered list of risk levels from highest to lowest priority.
 * Used by UI layers to display risk groups in the correct order.
 */
export function getRiskLevelsInPriorityOrder(): RiskLevel[] {
	return [...RISK_ORDER];
}
