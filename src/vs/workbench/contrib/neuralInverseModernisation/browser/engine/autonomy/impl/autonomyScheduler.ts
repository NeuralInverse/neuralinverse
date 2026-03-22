/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Autonomy Scheduler
 *
 * Determines the order in which knowledge units are processed by the
 * autonomy engine. Mirrors the TranslationScheduler's design closely.
 *
 * ## Scheduling Algorithm
 *
 * Units are ordered by a priority score combining three signals:
 *
 *  1. **Topological depth** — leaf nodes (no unresolved deps) first.
 *     A unit at depth N has at least one dependency at depth N-1.
 *     Processing leaves first maximises the chance that dependencies
 *     reach 'validated'/'committed' before dependents need them.
 *
 *  2. **Risk level** — within the same depth tier, critical > high > medium > low.
 *     High-risk units surface escalations early, giving humans maximum lead time.
 *
 *  3. **Dependent count** — units with more callers are processed before those
 *     with fewer callers (tiebreaker within the same depth + risk tier).
 *
 * ## Stage-aware eligibility
 *
 * The scheduler only queues units whose current `status` maps to a stage
 * included in `options.stages`. Status → stage mapping:
 *
 *   pending   → resolve
 *   ready     → translate
 *   review    → (policy evaluation — always included)
 *   approved  → validate
 *   validated → commit
 *   flagged   → (escalation — always included)
 *
 * In-flight statuses (resolving, translating, validating) are excluded —
 * another process already owns those units.
 * Terminal statuses (committed, complete, skipped, blocked) are excluded —
 * there is nothing to do.
 *
 * ## Immutability
 *
 * `AutonomyScheduler` is a one-shot, immutable queue.
 * Create a fresh instance at the start of each batch.
 * Mutating the KB after construction does NOT affect the queue.
 *
 * ## API
 *
 *   const sched = AutonomyScheduler.build(kb.getAllUnits(), options);
 *   while (sched.hasNext) {
 *     const item = sched.dequeue()!;
 *     dispatch(item.unit.id);
 *   }
 */

import { IKnowledgeUnit, RiskLevel } from '../../../../common/knowledgeBaseTypes.js';
import {
	IAutonomyOptions,
	DEFAULT_AUTONOMY_OPTIONS,
	IAutonomyScheduleEntry,
	IAutonomySchedulePreview,
	AutonomyStage,
} from './autonomyTypes.js';


// ─── Constants ────────────────────────────────────────────────────────────────

const RISK_SCORE: Record<RiskLevel, number> = {
	critical: 4,
	high:     3,
	medium:   2,
	low:      1,
};

/** Unit statuses that are in-flight (owned by another process). */
const IN_FLIGHT_STATUSES = new Set<string>([
	'resolving', 'translating', 'validating', 'committing',
]);

/** Unit statuses that are terminal (no action needed). */
const TERMINAL_STATUSES = new Set<string>([
	'committed', 'complete', 'skipped', 'blocked',
]);


// ─── Scheduled unit entry ─────────────────────────────────────────────────────

export interface IScheduledAutonomyUnit {
	/** The full KB unit record */
	readonly unit:          IKnowledgeUnit;
	/** Topological depth (0 = leaf / no eligible deps) */
	readonly depth:         number;
	/** Computed priority score (higher = more urgent within same depth) */
	readonly priorityScore: number;
	/** Which stage this unit will go through next */
	readonly nextStage:     AutonomyStage | 'policy' | 'escalate';
}


// ─── Scheduler ────────────────────────────────────────────────────────────────

export class AutonomyScheduler {

	private readonly _queue:  IScheduledAutonomyUnit[];
	private _cursor:           number = 0;

	private constructor(queue: IScheduledAutonomyUnit[]) {
		this._queue = queue;
	}

	// ── Factory ───────────────────────────────────────────────────────────────

	/**
	 * Build a prioritised autonomy schedule from the provided units.
	 *
	 * @param units    All units from the KB (filtered by the caller if needed)
	 * @param options  Autonomy options (stages, filters)
	 * @param excludeIds  Optional set of unitIds to exclude (e.g. already-processed)
	 */
	static build(
		units:      IKnowledgeUnit[],
		options:    IAutonomyOptions,
		excludeIds: ReadonlySet<string> = new Set(),
	): AutonomyScheduler {
		const stages      = options.stages      ?? DEFAULT_AUTONOMY_OPTIONS.stages;
		const domainFilter = options.domainFilter ?? DEFAULT_AUTONOMY_OPTIONS.domainFilter;
		const excludeDom  = options.excludeDomains ?? DEFAULT_AUTONOMY_OPTIONS.excludeDomains;
		const phaseFilter = options.phaseFilter   ?? DEFAULT_AUTONOMY_OPTIONS.phaseFilter;
		const unitFilter  = options.unitIdFilter  ? new Set(options.unitIdFilter) : null;

		// Build the set of eligible statuses for the requested stages
		const eligibleStatuses = _buildEligibleStatuses(stages);

		// Filter units
		const eligible: IKnowledgeUnit[] = [];
		for (const unit of units) {
			if (excludeIds.has(unit.id))                          { continue; }
			if (unitFilter && !unitFilter.has(unit.id))           { continue; }
			if (!eligibleStatuses.has(unit.status))               { continue; }
			if (IN_FLIGHT_STATUSES.has(unit.status))              { continue; }
			if (TERMINAL_STATUSES.has(unit.status))               { continue; }

			// Domain filter
			const domain = typeof unit.domain === 'string' ? unit.domain : undefined;
			if (domainFilter.length > 0) {
				const inFilter = domain ? domainFilter.some(d => d.toLowerCase() === domain.toLowerCase()) : false;
				if (excludeDom ? inFilter : !inFilter)            { continue; }
			}

			// Phase filter
			if (phaseFilter.length > 0) {
				if (!unit.phaseId || !phaseFilter.includes(unit.phaseId)) { continue; }
			}

			eligible.push(unit);
		}

		if (eligible.length === 0) {
			return new AutonomyScheduler([]);
		}

		// Build topological depth map (same algorithm as TranslationScheduler)
		const unitMap  = new Map<string, IKnowledgeUnit>(eligible.map(u => [u.id, u]));
		const depthMap = _buildDepthMap(eligible, unitMap);

		// Score and sort
		const scheduled: IScheduledAutonomyUnit[] = eligible.map(unit => {
			const depth         = depthMap.get(unit.id) ?? 0;
			const priorityScore = _scoreUnit(unit, depth);
			const nextStage     = _nextStage(unit.status, stages);
			return { unit, depth, priorityScore, nextStage };
		});

		// Sort: lowest depth first, then highest priority score, then most callers
		scheduled.sort((a, b) => {
			if (a.depth !== b.depth) { return a.depth - b.depth; }
			if (a.priorityScore !== b.priorityScore) { return b.priorityScore - a.priorityScore; }
			return b.unit.usedBy.length - a.unit.usedBy.length;
		});

		return new AutonomyScheduler(scheduled);
	}

	// ── Queue API ─────────────────────────────────────────────────────────────

	/** Total units in this schedule. */
	get total(): number { return this._queue.length; }

	/** Units not yet dequeued. */
	get remaining(): number { return this._queue.length - this._cursor; }

	/** True while there are units left to dequeue. */
	get hasNext(): boolean { return this._cursor < this._queue.length; }

	/**
	 * Dequeue the next unit in priority order.
	 * Returns `undefined` when exhausted.
	 */
	dequeue(): IScheduledAutonomyUnit | undefined {
		if (!this.hasNext) { return undefined; }
		return this._queue[this._cursor++];
	}

	/**
	 * Peek at all scheduled units without consuming the cursor.
	 * Used by `previewSchedule()`.
	 */
	peekAll(): ReadonlyArray<IScheduledAutonomyUnit> {
		return this._queue;
	}

	/** Return scheduled units grouped by topological depth (for wave display). */
	byDepth(): Map<number, IScheduledAutonomyUnit[]> {
		const result = new Map<number, IScheduledAutonomyUnit[]>();
		for (const item of this._queue) {
			const arr = result.get(item.depth);
			if (arr) { arr.push(item); }
			else      { result.set(item.depth, [item]); }
		}
		return result;
	}

	/** Count units per risk level. */
	countByRisk(): Partial<Record<RiskLevel, number>> {
		const counts: Partial<Record<RiskLevel, number>> = {};
		for (const item of this._queue) {
			const r = item.unit.riskLevel;
			counts[r] = (counts[r] ?? 0) + 1;
		}
		return counts;
	}

	/** Count units per domain. */
	countByDomain(): Record<string, number> {
		const counts: Record<string, number> = {};
		for (const item of this._queue) {
			const d = typeof item.unit.domain === 'string' ? item.unit.domain : '(unknown)';
			counts[d] = (counts[d] ?? 0) + 1;
		}
		return counts;
	}

	/** Count units per stage. */
	countByStage(): Partial<Record<AutonomyStage | 'policy' | 'escalate', number>> {
		const counts: Partial<Record<AutonomyStage | 'policy' | 'escalate', number>> = {};
		for (const item of this._queue) {
			const s = item.nextStage;
			counts[s] = (counts[s] ?? 0) + 1;
		}
		return counts;
	}

	// ── Preview ───────────────────────────────────────────────────────────────

	/**
	 * Build a rich schedule preview without consuming the cursor.
	 * Used by `IAutonomyService.previewSchedule()`.
	 */
	buildPreview(): IAutonomySchedulePreview {
		const byStage: Record<AutonomyStage, number>  = { resolve: 0, translate: 0, validate: 0, commit: 0 };
		const byRisk:  Record<string, number>          = {};
		const byDomain: Record<string, number>         = {};
		const depthMap = new Map<number, IScheduledAutonomyUnit[]>();

		for (const item of this._queue) {
			// Stage counts (policy and escalate don't map 1:1 to a stage)
			if (item.nextStage === 'policy')  { byStage['translate']++; } // review→approve is part of translate flow
			else if (item.nextStage !== 'escalate') { byStage[item.nextStage]++; }

			// Risk
			const r = item.unit.riskLevel;
			byRisk[r] = (byRisk[r] ?? 0) + 1;

			// Domain
			const d = typeof item.unit.domain === 'string' ? item.unit.domain : '(unknown)';
			byDomain[d] = (byDomain[d] ?? 0) + 1;

			// Depth groups
			const arr = depthMap.get(item.depth);
			if (arr) { arr.push(item); }
			else      { depthMap.set(item.depth, [item]); }
		}

		const depthGroups = [...depthMap.entries()]
			.sort(([a], [b]) => a - b)
			.map(([depth, items]) => ({
				depth,
				unitCount: items.length,
				units:     items.map((i): IAutonomyScheduleEntry => ({
					unitId:        i.unit.id,
					unitName:      i.unit.name,
					status:        i.unit.status,
					riskLevel:     i.unit.riskLevel,
					domain:        typeof i.unit.domain === 'string' ? i.unit.domain : undefined,
					phaseId:       i.unit.phaseId,
					depthInGraph:  i.depth,
					priorityScore: i.priorityScore,
					dependsOn:     [...i.unit.dependsOn],
					usedBy:        [...i.unit.usedBy],
				})),
			}));

		return { totalUnits: this.total, byStage, byRisk, byDomain, depthGroups };
	}
}


// ─── Eligibility helpers ──────────────────────────────────────────────────────

function _buildEligibleStatuses(stages: AutonomyStage[]): Set<string> {
	const set = new Set<string>();
	// review and flagged are always included (policy evaluation + escalation)
	set.add('review');
	set.add('flagged');
	if (stages.includes('resolve'))   { set.add('pending'); }
	if (stages.includes('translate')) { set.add('ready'); }
	if (stages.includes('validate'))  { set.add('approved'); }
	if (stages.includes('commit'))    { set.add('validated'); }
	return set;
}

function _nextStage(
	status: string,
	stages: AutonomyStage[],
): AutonomyStage | 'policy' | 'escalate' {
	switch (status) {
		case 'pending':   return stages.includes('resolve')   ? 'resolve'   : 'escalate';
		case 'ready':     return stages.includes('translate') ? 'translate' : 'escalate';
		case 'review':    return 'policy';
		case 'approved':  return stages.includes('validate')  ? 'validate'  : 'escalate';
		case 'validated': return stages.includes('commit')    ? 'commit'    : 'escalate';
		case 'flagged':   return 'escalate';
		default:          return 'escalate';
	}
}


// ─── Topological depth calculation ───────────────────────────────────────────

/**
 * Calculate the topological depth of each unit.
 * Depth = length of the longest dependency chain to this unit.
 * Leaf nodes (no deps in the eligible set) have depth 0.
 * Uses iterative memoised DFS; cycle-safe.
 */
function _buildDepthMap(
	units:   IKnowledgeUnit[],
	unitMap: Map<string, IKnowledgeUnit>,
): Map<string, number> {
	const memo = new Map<string, number>();

	function depth(unitId: string, visiting: Set<string>): number {
		if (memo.has(unitId))    { return memo.get(unitId)!; }
		if (visiting.has(unitId)){ return 0; } // Cycle guard

		const unit = unitMap.get(unitId);
		if (!unit || unit.dependsOn.length === 0) {
			memo.set(unitId, 0);
			return 0;
		}

		visiting.add(unitId);
		let maxDep = 0;
		for (const depId of unit.dependsOn) {
			if (unitMap.has(depId)) {
				const d = depth(depId, visiting) + 1;
				if (d > maxDep) { maxDep = d; }
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


// ─── Priority scoring ─────────────────────────────────────────────────────────

/**
 * Score components:
 *   Risk level:      0–40 (critical=40, high=30, medium=20, low=10)
 *   Dependent count: 0–9  (capped — risk dominates)
 */
function _scoreUnit(unit: IKnowledgeUnit, _depth: number): number {
	const riskScore = (RISK_SCORE[unit.riskLevel] ?? 1) * 10;
	const depScore  = Math.min(unit.usedBy.length, 9);
	return riskScore + depScore;
}
