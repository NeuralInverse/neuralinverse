/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Knowledge Base health check.
 *
 * Runs a comprehensive integrity sweep of the in-memory KB and returns a
 * structured health report. Designed to be cheap enough to run on every save
 * (debounced) and as a user-triggered diagnostic command.
 *
 * Checks performed:
 *   1.  Orphaned unit references    — files that reference unit IDs not in the units map
 *   2.  Broken dependency edges     — units with dependsOn / usedBy IDs that don't exist
 *   3.  Stale locks                 — locks whose TTL has expired
 *   4.  Broken audit chain          — hash mismatches in the audit log
 *   5.  Decision conflicts          — unresolved conflicts
 *   6.  Stale units                 — units stuck in non-terminal states
 *   7.  Orphaned pending decisions  — pendingDecision IDs referenced by units but missing
 *   8.  Missing resolvedSource      — units past 'resolving' with empty resolvedSource
 *   9.  Missing fingerprint         — high/critical units approved without a fingerprint
 *   10. Progress drift              — progress counters that don't match actual unit states
 */

import {
	IModernisationKnowledgeBase,
	IKBHealthReport,
	IKBHealthIssue,
	HealthIssueType,
} from '../../../common/knowledgeBaseTypes.js';
import { verifyAuditLogIntegrity } from './auditLog.js';
import { pruneExpiredLocks, ILockStore } from './locking.js';
import { getDecisionConflicts, IConflictStore } from './decisionAnalysis.js';
import { getStaleUnits } from './staleDetection.js';
import { makeId } from './helpers.js';

export function runHealthCheck(
	kb: IModernisationKnowledgeBase,
	lockStore: ILockStore,
	conflictStore: IConflictStore,
): IKBHealthReport {
	const issues: IKBHealthIssue[] = [];
	const now = Date.now();

	// ── 1. Orphaned file references ────────────────────────────────────────
	for (const [filePath, file] of kb.files) {
		for (const unitId of (file.unitIds ?? [])) {
			if (!kb.units.has(unitId)) {
				issues.push(_issue(
					'orphaned-unit-ref',
					'warning',
					`File "${filePath}" references unit "${unitId}" which does not exist`,
					undefined,
					filePath,
				));
			}
		}
	}

	// ── 2. Broken dependency edges ──────────────────────────────────────────
	for (const unit of kb.units.values()) {
		for (const depId of (unit.dependsOn ?? [])) {
			if (!kb.units.has(depId)) {
				issues.push(_issue(
					'broken-dep-edge',
					'warning',
					`Unit "${unit.id}" dependsOn "${depId}" which does not exist`,
					unit.id,
				));
			}
		}
		for (const usedById of (unit.usedBy ?? [])) {
			if (!kb.units.has(usedById)) {
				issues.push(_issue(
					'broken-dep-edge',
					'warning',
					`Unit "${unit.id}" usedBy "${usedById}" which does not exist`,
					unit.id,
				));
			}
		}
	}

	// ── 3. Stale locks ─────────────────────────────────────────────────────
	const staleLockCount = pruneExpiredLocks(lockStore);
	if (staleLockCount > 0) {
		issues.push(_issue(
			'stale-lock',
			'info',
			`Pruned ${staleLockCount} expired lock(s)`,
		));
	}
	// Report currently held locks that are very old (>2× default TTL = 10min)
	for (const lock of lockStore.locks.values()) {
		if (lock.ttlMs > 0 && now - lock.acquiredAt > lock.ttlMs * 2) {
			issues.push(_issue(
				'stale-lock',
				'warning',
				`Lock on unit "${lock.unitId}" held by "${lock.ownerId}" for ${Math.round((now - lock.acquiredAt) / 60000)}min`,
				lock.unitId,
			));
		}
	}

	// ── 4. Broken audit chain ──────────────────────────────────────────────
	const auditIntegrity = verifyAuditLogIntegrity(kb.auditLog);
	if (!auditIntegrity.valid) {
		issues.push(_issue(
			'broken-audit-chain',
			'error',
			`Audit log hash chain broken at entry index ${auditIntegrity.firstBrokenIndex}`,
		));
	}

	// ── 5. Decision conflicts ──────────────────────────────────────────────
	const unresolvedConflicts = getDecisionConflicts(conflictStore, true);
	if (unresolvedConflicts.length > 0) {
		issues.push(_issue(
			'decision-conflict',
			'warning',
			`${unresolvedConflicts.length} unresolved decision conflict(s)`,
		));
	}

	// ── 6. Stale units ────────────────────────────────────────────────────
	const staleUnits = getStaleUnits(kb.units);
	if (staleUnits.length > 0) {
		issues.push(_issue(
			'stale-unit',
			'warning',
			`${staleUnits.length} unit(s) stuck in non-terminal status (longest: ${Math.round(staleUnits[0].stuckSinceMs / 3600000)}h)`,
			staleUnits[0].unitId,
		));
	}

	// ── 7. Orphaned pending decisions ──────────────────────────────────────
	for (const unit of kb.units.values()) {
		if (!unit.pendingDecisionId) { continue; }
		const exists = kb.progress.pendingDecisions.some(
			(pd: { id: string }) => pd.id === unit.pendingDecisionId,
		);
		if (!exists) {
			issues.push(_issue(
				'orphaned-pending-decision',
				'warning',
				`Unit "${unit.id}" references pending decision "${unit.pendingDecisionId}" which is not in the pending decisions list`,
				unit.id,
			));
		}
	}

	// ── 8. Missing resolvedSource ──────────────────────────────────────────
	// Units past the 'resolving' stage should have a non-empty resolvedSource
	const NEEDS_RESOLVED: Set<string> = new Set(['ready', 'translating', 'review', 'flagged', 'approved', 'committed', 'validating', 'validated', 'complete']);
	for (const unit of kb.units.values()) {
		if (NEEDS_RESOLVED.has(unit.status) && !unit.resolvedSource) {
			issues.push(_issue(
				'missing-resolved-source',
				'warning',
				`Unit "${unit.id}" (${unit.name}) is in status "${unit.status}" but has no resolvedSource`,
				unit.id,
			));
		}
	}

	// ── 9. Missing fingerprint on high/critical units ──────────────────────
	const FINGERPRINT_STATUSES: Set<string> = new Set(['approved', 'committed', 'validating', 'validated', 'complete']);
	for (const unit of kb.units.values()) {
		if (
			(unit.riskLevel === 'high' || unit.riskLevel === 'critical') &&
			FINGERPRINT_STATUSES.has(unit.status) &&
			!unit.fingerprint
		) {
			issues.push(_issue(
				'missing-fingerprint',
				'warning',
				`High/critical unit "${unit.id}" (${unit.name}) reached "${unit.status}" without a compliance fingerprint`,
				unit.id,
			));
		}
	}

	// ── 10. Progress counter drift ─────────────────────────────────────────
	const actualCounts: Record<string, number> = {};
	for (const unit of kb.units.values()) {
		actualCounts[unit.status] = (actualCounts[unit.status] ?? 0) + 1;
	}
	const progressCounts = kb.progress.byStatus;
	for (const [status, actualCount] of Object.entries(actualCounts)) {
		const recorded = (progressCounts as Record<string, number>)[status] ?? 0;
		if (recorded !== actualCount) {
			issues.push(_issue(
				'progress-drift',
				'info',
				`Progress counter for status "${status}": recorded=${recorded}, actual=${actualCount}`,
			));
		}
	}

	// ── Summary ────────────────────────────────────────────────────────────
	const errorCount   = issues.filter(i => i.severity === 'error').length;
	const warningCount = issues.filter(i => i.severity === 'warning').length;
	const infoCount    = issues.filter(i => i.severity === 'info').length;

	return {
		generatedAt:   now,
		isHealthy:     errorCount === 0 && warningCount === 0,
		issues,
		summary: {
			errorCount,
			warningCount,
			infoCount,
			totalIssues: issues.length,
		},
	};
}

function _issue(
	type: HealthIssueType,
	severity: IKBHealthIssue['severity'],
	message: string,
	unitId?: string,
	filePath?: string,
): IKBHealthIssue {
	return { id: makeId('hi'), type, severity, message, unitId, filePath };
}
