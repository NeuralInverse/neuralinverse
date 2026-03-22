/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Validation Scheduler
 *
 * Determines the order in which units are validated in a batch run.
 *
 * ## Ordering strategy
 *
 * Units are sorted by a composite priority score (higher = earlier):
 *
 *   1. Risk level (critical=4, high=3, medium=2, low=1)
 *      — Higher-risk units should be validated first as their failures
 *        are most dangerous to leave undetected.
 *
 *   2. Regulated domain (+2 bonus)
 *      — Units in regulated domains (PII/PCI/PHI/GDPR) must be validated
 *        before non-regulated units of the same risk level.
 *
 *   3. Dependent count bonus (min(dependentCount, 5))
 *      — Units used by many others are more likely to be blockers;
 *        validate them early so failures cascade-surface quickly.
 *
 *   4. Has existing equivalence result (−3 penalty)
 *      — Units already validated get lower priority unless they have
 *        divergences (outcome != 'validated'), in which case treat normally.
 *
 *   5. Name (alphabetic tie-break) — stable ordering for reproducibility.
 *
 * ## Eligible units
 *
 * Only units whose status is in `options.eligibleStatuses` are scheduled.
 * The default is `['approved']`. Validation runs after developer approval (Stage 3)
 * and before commit (Stage 5).
 */

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { IKnowledgeUnit } from '../../../../common/knowledgeBaseTypes.js';


// ─── Risk ordering ─────────────────────────────────────────────────────────────

const RISK_SCORE: Record<string, number> = {
	critical: 4,
	high:     3,
	medium:   2,
	low:      1,
};


// ─── Scheduler ────────────────────────────────────────────────────────────────

export class ValidationScheduler {
	private readonly _queue: IKnowledgeUnit[];

	constructor(units: IKnowledgeUnit[]) {
		this._queue = [...units].sort(ValidationScheduler._compareUnits);
	}

	/** True while there are units left to process */
	get hasNext(): boolean {
		return this._queue.length > 0;
	}

	/** Total units in the scheduler */
	get totalCount(): number {
		return this._queue.length;
	}

	/** Dequeue the next unit (highest priority first). Returns undefined when empty. */
	dequeue(): IKnowledgeUnit | undefined {
		return this._queue.shift();
	}

	/** Peek at the next unit without dequeuing */
	peek(): IKnowledgeUnit | undefined {
		return this._queue[0];
	}

	/** Return a priority-ordered snapshot of remaining unit IDs */
	getRemainingIds(): string[] {
		return this._queue.map(u => u.id);
	}

	/** Count units by risk level in the remaining queue */
	countByRisk(): Record<string, number> {
		const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
		for (const u of this._queue) {
			counts[u.riskLevel] = (counts[u.riskLevel] ?? 0) + 1;
		}
		return counts;
	}

	// ── Comparator ────────────────────────────────────────────────────────────

	private static _compareUnits(a: IKnowledgeUnit, b: IKnowledgeUnit): number {
		const scoreA = ValidationScheduler._priorityScore(a);
		const scoreB = ValidationScheduler._priorityScore(b);

		if (scoreB !== scoreA) { return scoreB - scoreA; } // higher score first

		// Tie-break: alphabetical name for stability
		return a.name.localeCompare(b.name);
	}

	private static _priorityScore(u: IKnowledgeUnit): number {
		let score = RISK_SCORE[u.riskLevel] ?? 1;

		// Regulated domain bonus
		if (u.domain) {
			// Domain object lookup would require KB reference; use name heuristic
			const domainName = (typeof u.domain === 'string' ? u.domain : '').toLowerCase();
			if (/pii|pci|phi|gdpr|hipaa|sox|regulated|compliance/.test(domainName)) {
				score += 2;
			}
		}

		// Dependent count bonus (capped at 5)
		const depCount = u.usedBy?.length ?? 0;
		score += Math.min(depCount, 5);

		// Already-validated penalty (don't re-validate unless there are divergences)
		if (u.equivalenceResult && u.equivalenceResult.failCount === 0 && u.equivalenceResult.overridden === false) {
			score -= 3;
		}

		return score;
	}
}


// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a ValidationScheduler from the KB, filtered to eligible statuses.
 *
 * @param kb               Knowledge Base service
 * @param eligibleStatuses Unit statuses eligible for validation
 * @returns                A populated ValidationScheduler
 */
export function buildValidationScheduler(
	kb:               IKnowledgeBaseService,
	eligibleStatuses: string[],
): ValidationScheduler {
	const eligibleSet = new Set(eligibleStatuses);
	const units       = kb.getAllUnits().filter(u => eligibleSet.has(u.status));
	return new ValidationScheduler(units);
}


// ─── Preview helpers ──────────────────────────────────────────────────────────

export interface IValidationScheduleEntry {
	unitId:      string;
	unitName:    string;
	riskLevel:   string;
	domain?:     string;
	status:      string;
	hasExisting: boolean;
}

/**
 * Preview the validation schedule without executing it.
 */
export function previewValidationSchedule(
	kb:               IKnowledgeBaseService,
	eligibleStatuses: string[],
): IValidationScheduleEntry[] {
	const scheduler = buildValidationScheduler(kb, eligibleStatuses);
	const results: IValidationScheduleEntry[] = [];
	let unit: IKnowledgeUnit | undefined;
	while ((unit = scheduler.dequeue()) !== undefined) {
		results.push({
			unitId:      unit.id,
			unitName:    unit.name,
			riskLevel:   unit.riskLevel,
			domain:      typeof unit.domain === 'string' ? unit.domain : undefined,
			status:      unit.status,
			hasExisting: !!unit.equivalenceResult,
		});
	}
	return results;
}
