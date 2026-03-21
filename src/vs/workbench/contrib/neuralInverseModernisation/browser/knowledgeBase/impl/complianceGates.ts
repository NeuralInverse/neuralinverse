/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Compliance gate verification.
 *
 * Before a unit can be moved to 'approved' in regulated domains, it must pass a
 * set of compliance requirements. Each requirement is either:
 *   - auto-checkable  (e.g. "fingerprint comparison passed", "test coverage ≥ 80%")
 *   - human-required  (e.g. "sign-off by compliance officer", "legal review")
 *
 * The gate result is cached in ext and re-evaluated on every call.
 * A unit in a regulated domain with a FAIL gate is blocked from approval.
 */

import {
	IComplianceGateResult,
	IComplianceRequirement,
	IKnowledgeUnit,
	IBusinessDomain,
} from '../../../common/knowledgeBaseTypes.js';

// ─── Gate store ───────────────────────────────────────────────────────────────

export interface IGateStore {
	/** Most recent gate result per unit */
	gateResults: Map<string, IComplianceGateResult>; // unitId → result
}

export function createGateStore(): IGateStore {
	return { gateResults: new Map() };
}

// ─── Default requirements builder ─────────────────────────────────────────────

/**
 * Build the default compliance requirements for a unit based on its domain.
 * In a real deployment this would be driven by the GRC framework configuration.
 * Here we provide sensible defaults for regulated vs. unregulated domains.
 */
function buildRequirementsFor(
	unit: IKnowledgeUnit,
	domain: IBusinessDomain | undefined,
): IComplianceRequirement[] {
	const reqs: IComplianceRequirement[] = [];

	// Every unit: fingerprint comparison must be present
	reqs.push({
		id:          'req-fingerprint',
		label:       'Compliance fingerprint comparison',
		description: 'A semantic compliance fingerprint comparison must have been recorded for this unit.',
		kind:        'auto',
		status:      unit.fingerprintComparison ? 'pass' : 'fail',
		evidence:    unit.fingerprintComparison ? `comparison.matchPercentage=${unit.fingerprintComparison.matchPercentage}` : undefined,
	});

	// Every unit: at least one approval record
	reqs.push({
		id:          'req-approval',
		label:       'Translation approved by reviewer',
		description: 'At least one approval record must exist for this unit.',
		kind:        'auto',
		status:      (unit.approvals?.length ?? 0) > 0 ? 'pass' : 'fail',
		evidence:    unit.approvals?.[0] ? `approved by ${unit.approvals[0].approvedBy}` : undefined,
	});

	if (domain?.regulated) {
		// Regulated domain: equivalence check must pass
		reqs.push({
			id:          'req-equivalence',
			label:       'Semantic equivalence verified',
			description: 'Equivalence result must be stored and must report zero failures.',
			kind:        'auto',
			status:      (unit.equivalenceResult?.failCount ?? 1) === 0 && !unit.equivalenceResult?.overridden ? 'pass' : 'fail',
			evidence:    unit.equivalenceResult ? `failCount=${unit.equivalenceResult.failCount}, overridden=${unit.equivalenceResult.overridden}` : undefined,
		});

		// Regulated domain: human sign-off required (fingerprint-change approval = compliance officer gate)
		const hasComplianceApproval = (unit.approvals ?? []).some(a => a.approvalType === 'fingerprint-change');
		reqs.push({
			id:          'req-compliance-officer',
			label:       'Compliance officer sign-off',
			description: 'A compliance officer must have approved this unit.',
			kind:        'human-required',
			status:      hasComplianceApproval ? 'pass' : 'pending',
			evidence:    hasComplianceApproval ? 'compliance-officer approval on record' : undefined,
		});
	}

	return reqs;
}

// ─── Gate evaluation ──────────────────────────────────────────────────────────

export function checkComplianceGate(
	store: IGateStore,
	unit: IKnowledgeUnit,
	domain: IBusinessDomain | undefined,
): IComplianceGateResult {
	const requirements = buildRequirementsFor(unit, domain);

	const failed   = requirements.filter(r => r.status === 'fail');
	const pending  = requirements.filter(r => r.status === 'pending');
	const passed   = requirements.filter(r => r.status === 'pass');
	const waived   = requirements.filter(r => r.status === 'waived');

	let overallStatus: IComplianceGateResult['overallStatus'];
	if (failed.length > 0) {
		overallStatus = 'fail';
	} else if (pending.length > 0) {
		overallStatus = 'partial';
	} else {
		overallStatus = 'pass';
	}

	const result: IComplianceGateResult = {
		unitId:        unit.id,
		overallStatus,
		requirements,
		evaluatedAt:   Date.now(),
		failedCount:   failed.length,
		passedCount:   passed.length,
		pendingCount:  pending.length,
		waivedCount:   waived.length,
		blockerReasons: failed.map(r => r.label),
	};

	store.gateResults.set(unit.id, result);
	return result;
}

// ─── Manual approval recording ────────────────────────────────────────────────

/**
 * Record a human compliance approval for a specific requirement.
 * Updates the stored gate result.
 */
export function recordComplianceApproval(
	store: IGateStore,
	unitId: string,
	requirementId: string,
	approver: string,
	evidence?: string,
): void {
	const result = store.gateResults.get(unitId);
	if (!result) { return; }

	const updatedReqs = result.requirements.map(req => {
		if (req.id !== requirementId) { return req; }
		return {
			...req,
			status:  'pass' as const,
			evidence: evidence ?? `approved by ${approver} at ${new Date().toISOString()}`,
		};
	});

	// Recompute overall
	const failed  = updatedReqs.filter(r => r.status === 'fail');
	const pending = updatedReqs.filter(r => r.status === 'pending');
	const passed  = updatedReqs.filter(r => r.status === 'pass');
	const waived  = updatedReqs.filter(r => r.status === 'waived');

	const overallStatus: IComplianceGateResult['overallStatus'] =
		failed.length > 0 ? 'fail' :
		pending.length > 0 ? 'partial' :
		'pass';

	store.gateResults.set(unitId, {
		...result,
		requirements:   updatedReqs,
		overallStatus,
		failedCount:    failed.length,
		passedCount:    passed.length,
		pendingCount:   pending.length,
		waivedCount:    waived.length,
		blockerReasons: failed.map(r => r.label),
		evaluatedAt:    Date.now(),
	});
}

// ─── Waiver ───────────────────────────────────────────────────────────────────

/**
 * Waive a specific compliance requirement for a unit.
 * A waived requirement does not count as failed — the gate can still pass.
 * Use for requirements that are known to be inapplicable or formally exempted.
 */
export function waiveComplianceRequirement(
	store: IGateStore,
	unitId: string,
	requirementId: string,
	waivedBy: string,
	reason: string,
): void {
	const result = store.gateResults.get(unitId);
	if (!result) { return; }

	const updatedReqs = result.requirements.map(req => {
		if (req.id !== requirementId) { return req; }
		return {
			...req,
			status:   'waived' as const,
			evidence: `waived by ${waivedBy}: ${reason}`,
		};
	});

	// Recompute overall — waived requirements do not count as failed
	const failed  = updatedReqs.filter(r => r.status === 'fail');
	const pending = updatedReqs.filter(r => r.status === 'pending');
	const passed  = updatedReqs.filter(r => r.status === 'pass');
	const waived  = updatedReqs.filter(r => r.status === 'waived');

	const overallStatus: IComplianceGateResult['overallStatus'] =
		failed.length  > 0 ? 'fail'    :
		pending.length > 0 ? 'partial' :
		'pass';

	store.gateResults.set(unitId, {
		...result,
		requirements:   updatedReqs,
		overallStatus,
		failedCount:    failed.length,
		passedCount:    passed.length,
		pendingCount:   pending.length,
		waivedCount:    waived.length,
		blockerReasons: failed.map(r => r.label),
		evaluatedAt:    Date.now(),
	});
}


// ─── Queries ──────────────────────────────────────────────────────────────────

export function getComplianceGateFailures(
	store: IGateStore,
): Array<{ unitId: string; result: IComplianceGateResult }> {
	const result: Array<{ unitId: string; result: IComplianceGateResult }> = [];
	for (const gateResult of store.gateResults.values()) {
		if (gateResult.overallStatus === 'fail' || gateResult.overallStatus === 'partial') {
			result.push({ unitId: gateResult.unitId, result: gateResult });
		}
	}
	return result;
}
