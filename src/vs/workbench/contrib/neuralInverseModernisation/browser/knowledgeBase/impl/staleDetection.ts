/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stale unit detection.
 *
 * A unit is "stale" if it has been in a non-terminal, non-idle status for longer
 * than a threshold (default 24 hours). This catches:
 *   - Agents that started translating but never finished ('translating' \u2192 stuck)
 *   - Units under review that were never approved ('review' \u2192 stuck)
 *   - Units flagged for a decision that was never resolved ('flagged' \u2192 stuck)
 *   - Units blocked on a dependency decision for too long ('blocked' \u2192 long-blocked)
 */

import { IKnowledgeUnit, IStaleUnitReport } from '../../../common/knowledgeBaseTypes.js';

const DEFAULT_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

type StaleReason = IStaleUnitReport['staleReason'];

interface IStaleThresholds {
	translating: number;
	review:      number;
	flagged:     number;
	blocked:     number;
}

export function getStaleUnits(
	units: Map<string, IKnowledgeUnit>,
	thresholdMs = DEFAULT_THRESHOLD_MS,
): IStaleUnitReport[] {
	const now = Date.now();
	const thresholds: IStaleThresholds = {
		translating: thresholdMs,
		review:      thresholdMs * 2,
		flagged:     thresholdMs,
		blocked:     thresholdMs * 3,
	};

	const reports: IStaleUnitReport[] = [];

	for (const unit of units.values()) {
		const reason = _getStaleReason(unit, thresholds, now);
		if (!reason) { continue; }

		const stuckSinceMs = now - unit.updatedAt;
		reports.push({
			unitId:         unit.id,
			status:         unit.status,
			staleReason:    reason,
			stuckSinceMs,
			lastModifiedAt: unit.updatedAt,
		});
	}

	// Sort by stuckSinceMs descending (most stale first)
	return reports.sort((a, b) => b.stuckSinceMs - a.stuckSinceMs);
}

function _getStaleReason(
	unit: IKnowledgeUnit,
	thresholds: IStaleThresholds,
	now: number,
): StaleReason | null {
	const stuckMs = now - unit.updatedAt;

	switch (unit.status) {
		case 'translating':
			return stuckMs > thresholds.translating ? 'stuck-translating' : null;
		case 'review':
			return stuckMs > thresholds.review ? 'stuck-review' : null;
		case 'flagged':
			return stuckMs > thresholds.flagged ? 'stuck-flagged' : null;
		case 'blocked':
			return stuckMs > thresholds.blocked ? 'long-blocked' : null;
		default:
			return null;
	}
}
