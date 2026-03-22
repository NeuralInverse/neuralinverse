/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Validation Recorder
 *
 * Converts an IValidationResult into an IEquivalenceResult and writes it to
 * the Knowledge Base. Also handles unit status transitions:
 *
 *   outcome='validated'  → kb.setUnitStatus(unitId, 'validated')
 *   outcome='partial'    → kb.setUnitStatus(unitId, 'review')   — needs human look
 *   outcome='failed'     → kb.setUnitStatus(unitId, 'flagged')  — divergences found
 *   outcome='error'      → kb.setUnitStatus(unitId, 'review')   — retry later
 *   outcome='skipped'    → no change
 *
 * The evidence file path is always written to IEquivalenceResult.evidenceFilePath
 * even if the actual file write is not performed (the path is derived from the unit ID).
 */

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { IEquivalenceResult, IOutputDivergence } from '../../../../common/modernisationTypes.js';
import { IValidationResult } from './validationTypes.js';


// ─── Evidence path derivation ──────────────────────────────────────────────────

/**
 * Derive the evidence file path for a unit.
 * Format: {evidenceDir}/{unitId}.validation-evidence.json
 */
export function deriveEvidencePath(unitId: string, evidenceDir?: string): string {
	const dir = evidenceDir ?? '.neuralinverse/evidence';
	// Sanitise unitId for filesystem safety
	const safeId = unitId.replace(/[^a-zA-Z0-9_-]/g, '_');
	return `${dir}/${safeId}.validation-evidence.json`;
}


// ─── Main recorder ─────────────────────────────────────────────────────────────

/**
 * Convert a validation result to an IEquivalenceResult and persist to KB.
 * Also transitions the unit's status based on the outcome.
 *
 * @param result        Completed IValidationResult from the loop
 * @param kb            Knowledge Base service
 * @param evidenceDir   Optional override for the evidence directory path
 */
export function recordValidationResult(
	result:       IValidationResult,
	kb:           IKnowledgeBaseService,
	evidenceDir?: string,
): void {
	if (result.outcome === 'skipped') {
		// No state change for skipped units
		return;
	}

	const evidencePath = result.evidencePath ?? deriveEvidencePath(result.unitId, evidenceDir);

	// Build IOutputDivergence[] from failed test cases
	const divergences: IOutputDivergence[] = result.testCases
		.filter(tc => !tc.passed)
		.map(tc => ({
			testCaseId:        tc.id,
			inputDescription:  tc.inputDescription,
			legacyOutput:      tc.expectedLegacy,
			modernOutput:      tc.expectedModern,
			divergenceType:    tc.divergenceType ?? 'value',
		}));

	const equivalenceResult: IEquivalenceResult = {
		unitId:        result.unitId,
		testedAt:      Date.now(),
		testCaseCount: result.testCaseCount,
		passCount:     result.passCount,
		failCount:     result.failCount,
		divergences,
		evidenceFilePath: evidencePath,
		overridden:    false,
	};

	// Write equivalence result to KB
	kb.recordEquivalence(result.unitId, equivalenceResult);

	// Status transition
	_transitionStatus(result, kb);
}

/**
 * Record an override approval for a failed equivalence result.
 * Used when a developer accepts the divergence with documented rationale.
 */
export function recordEquivalenceOverride(
	unitId:    string,
	approver:  string,
	rationale: string,
	changeTicketRef: string | undefined,
	kb:        IKnowledgeBaseService,
): void {
	const unit = kb.getUnit(unitId);
	if (!unit || !unit.equivalenceResult) { return; }

	const overrideApproval = {
		id:            `approval-equiv-override-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		unitId,
		approvalType:  'equivalence-override' as const,
		approvedBy:    approver,
		approvedAt:    Date.now(),
		rationale,
		changeTicketRef,
	};

	kb.recordEquivalence(unitId, {
		...unit.equivalenceResult,
		overridden:      true,
		overrideApproval,
	});

	// Move back to 'validated' status so the unit can proceed to commit
	kb.setUnitStatus(unitId, 'validated',
		`Equivalence override approved by ${approver}. Rationale: ${rationale}`,
		approver,
	);
}


// ─── Status transition ────────────────────────────────────────────────────────

function _transitionStatus(result: IValidationResult, kb: IKnowledgeBaseService): void {
	const { unitId, outcome, failCount, testCaseCount, analysis } = result;

	switch (outcome) {
		case 'validated':
			kb.setUnitStatus(unitId, 'validated',
				`Equivalence validated: ${result.passCount}/${testCaseCount} test cases passed.`,
				'validation-engine',
			);
			break;

		case 'partial':
			kb.setUnitStatus(unitId, 'review',
				`Partial equivalence: ${result.passCount}/${testCaseCount} passed. Confidence: ${result.confidence}. Needs human review.`,
				'validation-engine',
			);
			break;

		case 'failed':
			kb.setUnitStatus(unitId, 'flagged',
				`Equivalence check failed: ${failCount}/${testCaseCount} test cases diverge. Analysis: ${analysis.slice(0, 200)}`,
				'validation-engine',
			);
			break;

		case 'error':
			kb.setUnitStatus(unitId, 'review',
				`Validation engine error: ${result.error ?? 'unknown error'}. Unit returned to review for manual inspection or retry.`,
				'validation-engine',
			);
			break;

		default:
			// 'skipped' is handled in the caller
			break;
	}
}
