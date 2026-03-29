/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # GRC Snapshot Builder
 *
 * Aggregates raw `ICheckResult[]` violations (emitted by `IGRCEngineService.evaluateFileContent`)
 * into a compact `IGRCSnapshot` suitable for persisting in the discovery result and
 * feeding to the migration planner prompt.
 *
 * Also provides `riskFromGRC` — the single source of truth for deriving an
 * `IMigrationUnit.riskLevel` from a set of GRC violations and the regulated-field count.
 *
 * ## Snapshot fields
 *
 * | Field              | Description                                                         |
 * |--------------------|---------------------------------------------------------------------|
 * | `totalViolations`  | Raw count of all violations across the project                      |
 * | `byDomain`         | Counts bucketed by GRC domain (e.g. `GDPR`, `SOX`, `PCI-DSS`)     |
 * | `blockingCount`    | Violations whose `blockingBehavior.blocksCommit === true`           |
 * | `bySeverity`       | Counts bucketed by severity string (error / warning / info)         |
 * | `topViolatedRules` | Top-10 most frequently triggered rule IDs                           |
 * | `violations`       | First `MAX_STORED_VIOLATIONS` violations stored in compact form      |
 */

import { ICheckResult } from './discoveryTypes.js';
import { IGRCSnapshot, IGRCMiniViolation } from './discoveryTypes.js';
import { MigrationRiskLevel } from '../../../common/modernisationTypes.js';


/** Maximum compact violations to keep in the snapshot (keeps the payload bounded). */
export const MAX_STORED_VIOLATIONS = 300;


// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build an `IGRCSnapshot` from a flat array of `ICheckResult`s.
 * Suitable for storing on `IProjectScanResult.grcSnapshot`.
 */
export function buildGRCSnapshot(violations: ICheckResult[]): IGRCSnapshot {
	const byDomain:   Record<string, number> = {};
	const bySeverity: Record<string, number> = {};
	const ruleCount:  Record<string, number> = {};
	let   blockingCount = 0;

	for (const v of violations) {
		const d = v.domain   ?? 'unknown';
		const s = v.severity ?? 'info';
		const r = v.ruleId;
		byDomain[d]   = (byDomain[d]   ?? 0) + 1;
		bySeverity[s] = (bySeverity[s] ?? 0) + 1;
		ruleCount[r]  = (ruleCount[r]  ?? 0) + 1;
		if (v.blockingBehavior?.blocksCommit) { blockingCount++; }
	}

	const topViolatedRules = Object.entries(ruleCount)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([ruleId, count]) => ({ ruleId, count }));

	const compactViolations: IGRCMiniViolation[] = violations
		.slice(0, MAX_STORED_VIOLATIONS)
		.map(v => ({
			ruleId:   v.ruleId,
			domain:   v.domain   ?? 'unknown',
			severity: v.severity ?? 'info',
			message:  v.message,
			fileUri:  v.fileUri?.toString() ?? '',
			line:     v.line ?? 0,
		}));

	return {
		capturedAt:      Date.now(),
		totalViolations: violations.length,
		byDomain,
		blockingCount,
		bySeverity,
		topViolatedRules,
		violations:      compactViolations,
	};
}

/**
 * Derive a `MigrationRiskLevel` for a single migration unit.
 *
 * Risk escalation rules (ordered, first match wins):
 *  1. **critical** — any violation with `blockingBehavior.blocksCommit === true`
 *  2. **high**     — >10 violations OR >5 regulated fields
 *  3. **medium**   — >3 violations OR >2 regulated fields
 *  4. **low**      — everything else
 *
 * @param violations        GRC violations that fall within this unit's line range
 * @param regulatedFieldCount  Number of regulated fields detected by Layer 1 fingerprint
 */
export function riskFromGRC(
	violations: ICheckResult[],
	regulatedFieldCount: number,
): MigrationRiskLevel {
	if (violations.some(v => v.blockingBehavior?.blocksCommit))  { return 'critical'; }
	if (violations.length > 10 || regulatedFieldCount > 5)        { return 'high'; }
	if (violations.length > 3  || regulatedFieldCount > 2)        { return 'medium'; }
	return 'low';
}

/**
 * Merge multiple GRC snapshots into one (used to produce a cross-project aggregate).
 * Useful for generating the compliance-baggage / migration-debt summary in the planner.
 */
export function mergeGRCSnapshots(snapshots: IGRCSnapshot[]): IGRCSnapshot {
	const byDomain:   Record<string, number> = {};
	const bySeverity: Record<string, number> = {};
	const ruleCount:  Record<string, number> = {};
	let totalViolations = 0;
	let blockingCount   = 0;
	const violations: IGRCMiniViolation[] = [];

	for (const snap of snapshots) {
		totalViolations += snap.totalViolations;
		blockingCount   += snap.blockingCount;
		for (const [d, c] of Object.entries(snap.byDomain))   { byDomain[d]   = (byDomain[d]   ?? 0) + c; }
		for (const [s, c] of Object.entries(snap.bySeverity)) { bySeverity[s] = (bySeverity[s] ?? 0) + c; }
		for (const r of snap.topViolatedRules) {
			ruleCount[r.ruleId] = (ruleCount[r.ruleId] ?? 0) + r.count;
		}
		if (violations.length < MAX_STORED_VIOLATIONS) {
			violations.push(...snap.violations.slice(0, MAX_STORED_VIOLATIONS - violations.length));
		}
	}

	const topViolatedRules = Object.entries(ruleCount)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([ruleId, count]) => ({ ruleId, count }));

	return {
		capturedAt:      Date.now(),
		totalViolations,
		byDomain,
		blockingCount,
		bySeverity,
		topViolatedRules,
		violations,
	};
}
