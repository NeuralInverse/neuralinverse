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

import { ICheckResult } from '../../../../neuralInverseChecks/browser/engine/types/grcTypes.js';
import { IGRCSnapshot, IGRCMiniViolation } from './discoveryTypes.js';
import { MigrationRiskLevel } from '../../../common/modernisationTypes.js';


/** Maximum compact violations to keep in the snapshot (keeps the payload bounded). */
export const MAX_STORED_VIOLATIONS = 300;

/**
 * GRC domains that belong to safety-critical regulated market verticals.
 * A single blocking violation in these domains always escalates to `critical`.
 */
export const SAFETY_CRITICAL_DOMAINS = new Set([
	// Functional safety
	'iec-61508', 'iec-62061', 'iec-61511',
	// Automotive
	'iso-26262', 'autosar', 'misra-c', 'misra-c++',
	// Industrial / OT
	'iec-62443', 'nerc-cip',
	// Telecom security
	'3gpp-security', 'gsma-nesas',
	// Embedded correctness
	'certc', 'cert-c++',
	// Automotive cybersecurity
	'iso-21434',
]);

/**
 * GRC rule-ID prefixes that always force `critical` risk regardless of blocking flag.
 * Covers SIL/ASIL integrity violations and memory-safety hazards in safety-critical code.
 */
const ALWAYS_CRITICAL_RULE_PREFIXES = [
	'sil-',          // IEC 61508 Safety Integrity Level
	'asil-',         // ISO 26262 Automotive Safety Integrity Level
	'misra-c-',      // MISRA C mandatory rules
	'isr-',          // ISR (Interrupt Service Routine) safety
	'watchdog-',     // Watchdog coverage gaps
	'e2e-',          // End-to-end protection gaps
	'certc-',        // CERT C mandatory
	'iec62443-',     // IEC 62443 mandatory security controls
	'iso21434-',     // ISO 21434 cybersecurity mandatory
];


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
		byDomain[v.domain]     = (byDomain[v.domain]     ?? 0) + 1;
		bySeverity[v.severity] = (bySeverity[v.severity] ?? 0) + 1;
		ruleCount[v.ruleId]    = (ruleCount[v.ruleId]    ?? 0) + 1;
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
			domain:   v.domain,
			severity: v.severity,
			message:  v.message,
			fileUri:  v.fileUri.toString(),
			line:     v.line,
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
 *  1. **critical** — any blocking violation, OR any violation in a safety-critical domain,
 *                    OR any violation whose ruleId starts with an always-critical prefix
 *  2. **high**     — >10 violations OR >5 regulated fields OR any violation in a safety domain
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
	// Safety-critical domain or blocking violation \u2192 always critical
	if (violations.some(v =>
		v.blockingBehavior?.blocksCommit ||
		SAFETY_CRITICAL_DOMAINS.has(v.domain?.toLowerCase?.() ?? '') ||
		ALWAYS_CRITICAL_RULE_PREFIXES.some(p => (v.ruleId ?? '').toLowerCase().startsWith(p))
	)) { return 'critical'; }

	// Any violation in a safety-adjacent domain \u2192 high (even without blocking flag)
	const hasSafetyDomain = violations.some(v => SAFETY_CRITICAL_DOMAINS.has(v.domain?.toLowerCase?.() ?? ''));
	if (violations.length > 10 || regulatedFieldCount > 5 || hasSafetyDomain) { return 'high'; }
	if (violations.length > 3  || regulatedFieldCount > 2)                     { return 'medium'; }
	return 'low';
}

/**
 * Return a compliance framework score (0–100) for a snapshot.
 * Score = 100 – penalty. Used by the planner to show compliance debt at a glance.
 *
 * Penalty schedule:
 *  - Each blocking violation in a safety-critical domain: –20
 *  - Each blocking violation in any other domain: –10
 *  - Each non-blocking error in safety domain: –5
 *  - Each non-blocking warning: –1
 * Score is clamped to [0, 100].
 */
export function complianceScoreFromSnapshot(snapshot: IGRCSnapshot): number {
	let penalty = 0;
	for (const v of snapshot.violations) {
		const isSafety  = SAFETY_CRITICAL_DOMAINS.has((v.domain ?? '').toLowerCase());
		if (v.severity === 'error' && isSafety)   { penalty += 20; }
		else if (v.severity === 'error')           { penalty += 10; }
		else if (v.severity === 'warning' && isSafety) { penalty += 5; }
		else if (v.severity === 'warning')         { penalty += 1; }
	}
	return Math.max(0, 100 - penalty);
}

/**
 * Return the primary compliance framework for a project based on the most-violated domain.
 * Falls back to `'iec-61508'` (the general functional-safety standard) when ambiguous.
 */
export function primaryFrameworkFromSnapshot(snapshot: IGRCSnapshot): string {
	const domains = Object.entries(snapshot.byDomain).sort((a, b) => b[1] - a[1]);
	return domains[0]?.[0] ?? 'iec-61508';
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
