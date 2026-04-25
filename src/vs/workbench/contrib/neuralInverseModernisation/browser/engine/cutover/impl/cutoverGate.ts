/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Cutover Gate
 *
 * Pre-flight readiness check before the final cutover approval.
 *
 * ## Checks performed
 *
 * | # | Check                           | Severity |
 * |---|----------------------------------|----------|
 * | 1 | No units in active-work statuses | blocking |
 * | 2 | No units in 'flagged' status      | blocking |
 * | 3 | All non-skipped units terminal    | blocking |
 * | 4 | No unresolved pending decisions   | blocking |
 * | 5 | Audit log chain intact            | warning  |
 * | 6 | No unacknowledged source drift    | warning  |
 * | 7 | No unresolved decision conflicts  | warning  |
 * | 8 | All committed units have targetFile| info    |
 *
 * The gate `isReady` flag is true only when all *blocking* checks pass.
 */

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';


// \u2500\u2500\u2500 Types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type CutoverCheckSeverity = 'blocking' | 'warning' | 'info';

export interface ICutoverReadinessCheck {
	id:        string;
	label:     string;
	severity:  CutoverCheckSeverity;
	passed:    boolean;
	detail:    string;
}

export interface ICutoverReadinessReport {
	/** True only when ALL blocking checks pass */
	isReady:    boolean;
	checks:     ICutoverReadinessCheck[];
	checkedAt:  number;
	/** Counts */
	blocking:   number;
	warnings:   number;
	infos:      number;
	passedAll:  number;
	totalChecks: number;
}


// \u2500\u2500\u2500 Constants \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const ACTIVE_STATUSES  = new Set(['resolving', 'translating', 'validating']);
const TERMINAL_STATUSES = new Set(['validated', 'committed', 'complete', 'skipped', 'blocked']);


// \u2500\u2500\u2500 Gate evaluator \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function checkCutoverReadiness(kb: IKnowledgeBaseService): ICutoverReadinessReport {
	const checks: ICutoverReadinessCheck[] = [];

	if (!kb.isActive) {
		return {
			isReady:    false,
			checks:     [{ id: 'kb-inactive', label: 'Knowledge Base active', severity: 'blocking', passed: false, detail: 'KB is not initialised.' }],
			checkedAt:  Date.now(),
			blocking:   1, warnings: 0, infos: 0, passedAll: 0, totalChecks: 1,
		};
	}

	const allUnits = kb.getAllUnits();

	// \u2500\u2500 Check 1: No active-work units \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const activeUnits = allUnits.filter(u => ACTIVE_STATUSES.has(u.status));
	checks.push({
		id:       'no-active-work',
		label:    'No units in active-work statuses',
		severity: 'blocking',
		passed:   activeUnits.length === 0,
		detail:   activeUnits.length === 0
			? 'All units have exited active-work statuses.'
			: `${activeUnits.length} unit(s) still in progress: ${activeUnits.slice(0, 5).map(u => u.name).join(', ')}${activeUnits.length > 5 ? '\u2026' : ''}.`,
	});

	// \u2500\u2500 Check 2: No flagged units \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const flaggedUnits = allUnits.filter(u => u.status === 'flagged');
	checks.push({
		id:       'no-flagged-units',
		label:    'No units with unresolved divergences',
		severity: 'blocking',
		passed:   flaggedUnits.length === 0,
		detail:   flaggedUnits.length === 0
			? 'No units are flagged for divergences.'
			: `${flaggedUnits.length} unit(s) flagged: ${flaggedUnits.slice(0, 5).map(u => u.name).join(', ')}${flaggedUnits.length > 5 ? '\u2026' : ''}. Override or revalidate before cutover.`,
	});

	// \u2500\u2500 Check 3: All non-skipped/non-blocked units in terminal status \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const nonTerminalNonSkipped = allUnits.filter(u =>
		u.status !== 'skipped' && u.status !== 'blocked' && !TERMINAL_STATUSES.has(u.status),
	);
	checks.push({
		id:       'all-units-terminal',
		label:    'All units have reached a terminal status',
		severity: 'blocking',
		passed:   nonTerminalNonSkipped.length === 0,
		detail:   nonTerminalNonSkipped.length === 0
			? 'All units are in a terminal state.'
			: `${nonTerminalNonSkipped.length} unit(s) not yet complete: ${nonTerminalNonSkipped.slice(0, 5).map(u => `${u.name} (${u.status})`).join(', ')}${nonTerminalNonSkipped.length > 5 ? '\u2026' : ''}.`,
	});

	// \u2500\u2500 Check 4: No unresolved pending decisions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const pendingDecisions = kb.getPendingDecisions();
	checks.push({
		id:       'no-pending-decisions',
		label:    'No unresolved pending decisions',
		severity: 'blocking',
		passed:   pendingDecisions.length === 0,
		detail:   pendingDecisions.length === 0
			? 'No open pending decisions.'
			: `${pendingDecisions.length} pending decision(s) must be resolved before cutover.`,
	});

	// \u2500\u2500 Check 5: Audit log chain integrity \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const chainResult = kb.verifyAuditLogIntegrity();
	checks.push({
		id:       'audit-chain-intact',
		label:    'Audit log chain intact',
		severity: 'warning',
		passed:   chainResult.valid,
		detail:   chainResult.valid
			? 'Audit log hash chain is valid.'
			: `Audit chain broken at entry index ${chainResult.firstBrokenIndex ?? '?'}. Export may contain a tamper warning.`,
	});

	// \u2500\u2500 Check 6: No unacknowledged source drift \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const driftAlerts = kb.getDriftAlerts(/* unacknowledgedOnly */ true);
	checks.push({
		id:       'no-source-drift',
		label:    'No unacknowledged source file drift',
		severity: 'warning',
		passed:   driftAlerts.length === 0,
		detail:   driftAlerts.length === 0
			? 'No source files have drifted since scanning.'
			: `${driftAlerts.length} source file(s) have changed since scanning. Acknowledge or re-scan before cutover.`,
	});

	// \u2500\u2500 Check 7: No unresolved decision conflicts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const conflicts = kb.getDecisionConflicts(/* unresolvedOnly */ true);
	checks.push({
		id:       'no-decision-conflicts',
		label:    'No unresolved decision conflicts',
		severity: 'warning',
		passed:   conflicts.length === 0,
		detail:   conflicts.length === 0
			? 'No decision conflicts detected.'
			: `${conflicts.length} unresolved decision conflict(s). Resolve them to ensure consistent translations.`,
	});

	// \u2500\u2500 Check 8: All committed units have a targetFile \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const committedWithoutFile = allUnits.filter(
		u => u.status === 'committed' && !u.targetFile,
	);
	checks.push({
		id:       'committed-have-target-file',
		label:    'All committed units have a target file path',
		severity: 'info',
		passed:   committedWithoutFile.length === 0,
		detail:   committedWithoutFile.length === 0
			? 'All committed units have a target file path recorded.'
			: `${committedWithoutFile.length} committed unit(s) have no targetFile path in the KB.`,
	});

	// \u2500\u2500 Aggregate \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const blockingFailed = checks.filter(c => c.severity === 'blocking' && !c.passed).length;
	const warnings       = checks.filter(c => c.severity === 'warning'  && !c.passed).length;
	const infos          = checks.filter(c => c.severity === 'info'     && !c.passed).length;
	const passedAll      = checks.filter(c => c.passed).length;

	return {
		isReady:    blockingFailed === 0,
		checks,
		checkedAt:  Date.now(),
		blocking:   blockingFailed,
		warnings,
		infos,
		passedAll,
		totalChecks: checks.length,
	};
}
