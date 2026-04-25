/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Auto-Approval Policy
 *
 * Determines whether a unit in 'review' status can be auto-approved or must
 * be escalated to a human reviewer.
 *
 * ## Gate categories
 *
 * ### Hard gates \u2014 always escalate, not configurable
 *
 *   1. riskLevel === 'critical' or 'high'
 *   2. Domain matches any regulated pattern (PII/PCI/PHI/GDPR/HIPAA/SOX/payment/medical/\u2026)
 *   3. fingerprintComparison.overallResult === 'blocked'
 *      (regulatory logic changed \u2014 compliance officer must approve)
 *   4. Unit has an unresolved pending decision
 *   5. A compliance gate check exists and is in 'fail' or 'partial' state
 *      (only if `checkComplianceGate: true` \u2014 default true)
 *   6. Not all `dependsOn` units are in a terminal-or-approved state
 *      (only if `checkDependencyCompletion: true` \u2014 default true)
 *
 * ### Soft gates \u2014 configurable, checked only when `autoApprove: true`
 *
 *   7. fingerprintComparison.overallResult === 'warning'
 *      (configurable via `escalateOnFingerprintWarning`)
 *   8. Any `rule-removed` divergence in fingerprintComparison
 *      (configurable via `escalateOnRuleRemoved`)
 *
 * ### When `autoApprove: false` (default)
 *
 *   All review-stage units are escalated regardless of check results.
 *   The agent NEVER self-approves when the option is off.
 *
 * ## Audit trail
 *
 * Every call returns a full `IAutoApprovalAuditEntry[]` describing every gate
 * that was evaluated and its result. This is stored in the KB as an annotation
 * for traceability.
 */

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { IKnowledgeUnit } from '../../../../common/knowledgeBaseTypes.js';
import {
	IAutoApprovalConfig,
	DEFAULT_AUTO_APPROVAL_CONFIG,
} from './autonomyTypes.js';


// \u2500\u2500\u2500 Hard-coded regulated patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const ALWAYS_REGULATED_PATTERNS: RegExp[] = [
	/\bpii\b/i,
	/\bpci\b/i,
	/\bphi\b/i,
	/\bgdpr\b/i,
	/\bhipaa\b/i,
	/\bsox\b/i,
	/\bpayment/i,
	/\bfinancial/i,
	/\bmedical/i,
	/\bhealth/i,
	/personal.?data/i,
	/\bidentity/i,
	/\bbiometric/i,
	/\bsensitive/i,
];

function _isRegulatedDomain(domain: string | undefined, additionalPatterns: string[]): boolean {
	if (!domain) { return false; }
	if (ALWAYS_REGULATED_PATTERNS.some(re => re.test(domain))) { return true; }
	if (additionalPatterns.some(p => domain.toLowerCase().includes(p.toLowerCase()))) { return true; }
	return false;
}

/** The set of statuses considered terminal-or-approved for dependency checks. */
const DEPENDENCY_COMPLETE_STATUSES = new Set<string>([
	'approved', 'validated', 'committed', 'complete', 'skipped',
]);


// \u2500\u2500\u2500 Audit trail \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IAutoApprovalAuditEntry {
	readonly gate:       string;    // e.g. 'hard:risk-level', 'soft:fingerprint-warning'
	readonly triggered:  boolean;   // true = this gate caused escalation
	readonly message:    string;    // human-readable explanation
}

export type AutoApprovalDecision = 'approved' | 'escalate';

export interface IAutoApprovalResult {
	readonly decision:    AutoApprovalDecision;
	readonly reason:      string;
	readonly auditTrail:  IAutoApprovalAuditEntry[];
}


// \u2500\u2500\u2500 Main policy function \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Evaluate whether a unit can be auto-approved.
 * Never throws. Returns a full audit trail regardless of decision.
 *
 * @param unit         The unit in 'review' status
 * @param kb           KB service (for pending decision + compliance gate + dependency lookup)
 * @param autoApprove  Whether autoApprove is enabled in the batch options
 * @param config       Optional policy configuration overrides
 */
export function evaluateAutoApproval(
	unit:        IKnowledgeUnit,
	kb:          IKnowledgeBaseService,
	autoApprove: boolean,
	config?:     IAutoApprovalConfig,
): IAutoApprovalResult {
	const cfg  = { ...DEFAULT_AUTO_APPROVAL_CONFIG, ...config };
	const trail: IAutoApprovalAuditEntry[] = [];

	// Helper: record a gate and optionally return 'escalate'
	function gate(
		name:      string,
		triggered: boolean,
		message:   string,
	): IAutoApprovalResult | null {
		trail.push({ gate: name, triggered, message });
		if (triggered) {
			return { decision: 'escalate', reason: message, auditTrail: trail };
		}
		return null;
	}

	// \u2500\u2500 Hard gate 1: risk level \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{
		const isHighRisk = unit.riskLevel === 'critical' || unit.riskLevel === 'high';
		const result = gate(
			'hard:risk-level',
			isHighRisk,
			isHighRisk
				? `Unit has ${unit.riskLevel} risk level \u2014 always requires human sign-off.`
				: `Risk level '${unit.riskLevel}' passes the risk gate.`,
		);
		if (result) { return result; }
	}

	// \u2500\u2500 Hard gate 2: regulated domain \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{
		const domain    = typeof unit.domain === 'string' ? unit.domain : undefined;
		const regulated = _isRegulatedDomain(domain, cfg.additionalRegulatedPatterns);
		const result = gate(
			'hard:regulated-domain',
			regulated,
			regulated
				? `Unit belongs to regulated domain '${domain ?? '(none)'}' \u2014 requires compliance officer approval.`
				: `Domain '${domain ?? '(none)'}' is not in the regulated domain list.`,
		);
		if (result) { return result; }
	}

	// \u2500\u2500 Hard gate 3: fingerprint blocked \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{
		const isBlocked = unit.fingerprintComparison?.overallResult === 'blocked';
		const result = gate(
			'hard:fingerprint-blocked',
			isBlocked,
			isBlocked
				? 'Compliance fingerprint comparison is blocked \u2014 regulatory logic changed; compliance officer approval required.'
				: 'Fingerprint comparison is not blocked.',
		);
		if (result) { return result; }
	}

	// \u2500\u2500 Hard gate 4: unresolved pending decision \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{
		const pending = kb.getPendingDecisionForUnit(unit.id);
		const hasPending = !!pending;
		const result = gate(
			'hard:pending-decision',
			hasPending,
			hasPending
				? `Unit has unresolved pending decision '${pending!.id}': ${pending!.question ?? '(no description)'}.`
				: 'No unresolved pending decisions.',
		);
		if (result) { return result; }
	}

	// \u2500\u2500 Hard gate 5: compliance gate (if enabled) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (cfg.checkComplianceGate) {
		try {
			const gateResult = kb.checkComplianceGate(unit.id);
			const isFailing  = gateResult.overallStatus === 'fail' || gateResult.overallStatus === 'partial';
			const result = gate(
				'hard:compliance-gate',
				isFailing,
				isFailing
					? `Compliance gate is in '${gateResult.overallStatus}' state \u2014 ${gateResult.failedCount} requirement(s) failing.`
					: `Compliance gate passed (${gateResult.passedCount} requirements met).`,
			);
			if (result) { return result; }
		} catch {
			// checkComplianceGate may throw if no compliance requirements are registered.
			// In that case, treat as passed \u2014 no compliance gate to fail.
			trail.push({
				gate:      'hard:compliance-gate',
				triggered: false,
				message:   'Compliance gate check skipped (no compliance requirements registered for this unit).',
			});
		}
	}

	// \u2500\u2500 Hard gate 6: dependency completion (if enabled) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (cfg.checkDependencyCompletion && unit.dependsOn.length > 0) {
		const incompleteDeps: string[] = [];
		for (const depId of unit.dependsOn) {
			const dep = kb.getUnit(depId);
			if (dep && !DEPENDENCY_COMPLETE_STATUSES.has(dep.status)) {
				incompleteDeps.push(`${dep.name} (${dep.status})`);
			}
		}
		const hasIncompleteDeps = incompleteDeps.length > 0;
		const result = gate(
			'hard:dependency-completion',
			hasIncompleteDeps,
			hasIncompleteDeps
				? `${incompleteDeps.length} dependency unit(s) have not yet reached a complete state: ${incompleteDeps.slice(0, 3).join(', ')}${incompleteDeps.length > 3 ? '\u2026' : ''}.`
				: `All ${unit.dependsOn.length} dependency unit(s) are complete.`,
		);
		if (result) { return result; }
	}

	// \u2500\u2500 autoApprove: false \u2192 always escalate (not a gate failure, a policy choice) \u2500\u2500
	if (!autoApprove) {
		trail.push({
			gate:      'policy:auto-approve-disabled',
			triggered: true,
			message:   'autoApprove is disabled \u2014 all review-stage units require human approval regardless of gate results.',
		});
		return {
			decision:   'escalate',
			reason:     'autoApprove is disabled \u2014 manual approval required.',
			auditTrail: trail,
		};
	}

	// \u2500\u2500 Soft gate 7: fingerprint warning (configurable) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (cfg.escalateOnFingerprintWarning) {
		const isWarning = unit.fingerprintComparison?.overallResult === 'warning';
		const result = gate(
			'soft:fingerprint-warning',
			isWarning,
			isWarning
				? 'Compliance fingerprint comparison has warnings \u2014 human review recommended before approving.'
				: 'Fingerprint comparison has no warnings.',
		);
		if (result) { return result; }
	}

	// \u2500\u2500 Soft gate 8: rule-removed divergences (configurable) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (cfg.escalateOnRuleRemoved) {
		const divergences   = unit.fingerprintComparison?.divergences ?? [];
		const ruleRemoved   = divergences.filter(d => d.type === 'rule-removed');
		const hasRuleRemoved = ruleRemoved.length > 0;
		const result = gate(
			'soft:rule-removed',
			hasRuleRemoved,
			hasRuleRemoved
				? `${ruleRemoved.length} semantic rule(s) were removed from the modern implementation \u2014 requires human review.`
				: 'No semantic rules were removed.',
		);
		if (result) { return result; }
	}

	// \u2500\u2500 All checks passed \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	trail.push({
		gate:      'policy:all-gates-passed',
		triggered: false,
		message:   `All ${trail.length} gate(s) passed \u2014 unit auto-approved.`,
	});

	return {
		decision:   'approved',
		reason:     'All auto-approval checks passed.',
		auditTrail: trail,
	};
}


// \u2500\u2500\u2500 Audit trail formatter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Format an auto-approval audit trail as a compact human-readable string.
 * Suitable for storing in a KB annotation for traceability.
 */
export function formatAuditTrail(trail: IAutoApprovalAuditEntry[]): string {
	const lines = trail.map(e =>
		`[${e.triggered ? 'TRIGGERED' : 'pass'   }] ${e.gate}: ${e.message}`,
	);
	return lines.join('\n');
}
