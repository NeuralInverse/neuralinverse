/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Fingerprint Comparison Service
 *
 * Compares the compliance fingerprint of a legacy unit against its modern translation.
 * This is the compliance gate that drives the approval workflow in Stage 3.
 *
 * ## Comparison Logic
 *
 * Three structural checks, in order of severity:
 *
 * 1. **Regulated Fields** — Are all regulated fields from the legacy unit present
 *    in the modern unit? Is any field's operation type different?
 *
 * 2. **Semantic Rules** — Are all semantic rules present? Has the description of
 *    a rule changed significantly (indicating the business logic changed)?
 *
 * 3. **Compliance Domains** — Have new domains been introduced, or have existing
 *    domains been removed?
 *
 * ## Result
 *
 * - `pass` (100–90% match, no blocking divergences): Translation is clean.
 * - `warning` (89–70%): Minor differences — senior developer can approve.
 * - `blocked` (<70% or any blocking divergence): Requires compliance officer approval.
 *
 * ## Why Not Semantic Similarity?
 *
 * The comparison is structural, not semantic. We compare structured fingerprint
 * artifacts (JSON objects), not free-form text. This gives deterministic, auditable
 * results. The LLM is used to BUILD the fingerprint, not to compare it.
 */

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import {
	IComplianceFingerprint,
	IFingerprintComparison,
	IFingerprintDivergence,
	DivergenceType,
	IRegulatedField,
	ISemanticRule,
	ILogicalInvariant,
} from '../../common/modernisationTypes.js';

export const IFingerprintComparisonService = createDecorator<IFingerprintComparisonService>('modernisationFingerprintComparison');

export interface IFingerprintComparisonService {
	readonly _serviceBrand: undefined;

	/**
	 * Compare legacy and modern compliance fingerprints.
	 * Returns the full comparison result including match percentage and all divergences.
	 */
	compare(
		unitId: string,
		legacy: IComplianceFingerprint,
		modern: IComplianceFingerprint,
	): IFingerprintComparison;
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

const PASS_THRESHOLD = 90;     // ≥90% \u2192 pass
const WARNING_THRESHOLD = 70;  // 70–89% \u2192 warning, <70% \u2192 blocked

class FingerprintComparisonService implements IFingerprintComparisonService {
	readonly _serviceBrand: undefined;

	compare(
		unitId: string,
		legacy: IComplianceFingerprint,
		modern: IComplianceFingerprint,
	): IFingerprintComparison {
		const divergences: IFingerprintDivergence[] = [];

		// 1. Compare regulated fields
		divergences.push(...compareRegulatedFields(legacy, modern));

		// 2. Compare semantic rules
		divergences.push(...compareSemanticRules(legacy, modern));

		// 3. Compare compliance domains
		divergences.push(...compareComplianceDomains(legacy, modern));

		// 4. Compare invariants
		divergences.push(...compareInvariants(legacy, modern));

		// Calculate match score
		const matchPercentage = calculateMatchPercentage(legacy, divergences);

		// Determine overall result
		const hasBlocking = divergences.some(d => d.severity === 'blocking');
		let overallResult: IFingerprintComparison['overallResult'];

		if (hasBlocking || matchPercentage < WARNING_THRESHOLD) {
			overallResult = 'blocked';
		} else if (matchPercentage < PASS_THRESHOLD || divergences.length > 0) {
			overallResult = 'warning';
		} else {
			overallResult = 'pass';
		}

		return {
			unitId,
			comparedAt: Date.now(),
			legacyFingerprint: legacy,
			modernFingerprint: modern,
			matchPercentage,
			divergences,
			overallResult,
		};
	}
}


// ─── Field Comparison ─────────────────────────────────────────────────────────

function compareRegulatedFields(
	legacy: IComplianceFingerprint,
	modern: IComplianceFingerprint,
): IFingerprintDivergence[] {
	const divergences: IFingerprintDivergence[] = [];

	const modernFieldMap = new Map(
		modern.regulatedFields.map((f: IRegulatedField) => [normaliseFieldKey(f.fieldName, f.regulatedAttribute), f])
	);

	for (const legacyField of legacy.regulatedFields) {
		const key = normaliseFieldKey(legacyField.fieldName, legacyField.regulatedAttribute);
		const modernField = modernFieldMap.get(key);

		if (!modernField) {
			// Field present in legacy, absent in modern — blocking if it was a write/calculate/store
			const isWriteSide = ['write', 'calculate', 'store'].includes(legacyField.operation);
			divergences.push({
				type: 'field-removed' as DivergenceType,
				description: `Regulated field "${legacyField.fieldName}" (${legacyField.regulatedAttribute}) is present in the legacy unit but not found in the modern translation. This field belongs to framework "${legacyField.framework}".`,
				legacyLocation: legacyField.location,
				severity: isWriteSide ? 'blocking' : 'warning',
				requiresComplianceApproval: isWriteSide,
			});
		} else if (legacyField.operation !== modernField.operation) {
			// Operation type changed (e.g. read \u2192 write is significant)
			const isEscalation = isOperationEscalation(legacyField.operation, modernField.operation);
			divergences.push({
				type: 'field-operation-changed' as DivergenceType,
				description: `Field "${legacyField.fieldName}" operation changed from "${legacyField.operation}" (legacy) to "${modernField.operation}" (modern). ${isEscalation ? 'This is an escalation (more invasive operation) and requires review.' : ''}`,
				legacyLocation: legacyField.location,
				modernLocation: modernField.location,
				severity: isEscalation ? 'blocking' : 'warning',
				requiresComplianceApproval: isEscalation,
			});
		}
	}

	// Fields added in modern that were not in legacy — flag but don't block
	const legacyFieldKeys = new Set(
		legacy.regulatedFields.map((f: IRegulatedField) => normaliseFieldKey(f.fieldName, f.regulatedAttribute))
	);
	for (const modernField of modern.regulatedFields) {
		const key = normaliseFieldKey(modernField.fieldName, modernField.regulatedAttribute);
		if (!legacyFieldKeys.has(key)) {
			divergences.push({
				type: 'field-added' as DivergenceType,
				description: `Regulated field "${modernField.fieldName}" (${modernField.regulatedAttribute}) appears in the modern translation but was not present in the legacy unit. This may indicate new functionality was introduced.`,
				modernLocation: modernField.location,
				severity: 'warning',
				requiresComplianceApproval: false,
			});
		}
	}

	return divergences;
}


// ─── Semantic Rule Comparison ─────────────────────────────────────────────────

function compareSemanticRules(
	legacy: IComplianceFingerprint,
	modern: IComplianceFingerprint,
): IFingerprintDivergence[] {
	const divergences: IFingerprintDivergence[] = [];

	if (legacy.semanticRules.length === 0 && modern.semanticRules.length === 0) {
		return divergences;
	}

	for (const legacyRule of legacy.semanticRules) {
		if (!legacyRule.preservationRequired) {
			continue;
		}

		// Check if a rule with the same domain exists in modern
		const modernMatchingRule = modern.semanticRules.find((r: ISemanticRule) => r.domain === legacyRule.domain);

		if (!modernMatchingRule) {
			divergences.push({
				type: 'rule-removed' as DivergenceType,
				description: `Compliance-required semantic rule "${legacyRule.domain}" is present in the legacy unit but absent in the modern translation. Legacy rule: "${legacyRule.description}"`,
				severity: 'blocking',
				requiresComplianceApproval: true,
			});
		} else {
			// Rule exists — check if description changed significantly (simple length + word heuristic)
			const similarity = descriptionSimilarity(legacyRule.description, modernMatchingRule.description);
			if (similarity < 0.6) {
				divergences.push({
					type: 'rule-changed' as DivergenceType,
					description: `Semantic rule "${legacyRule.domain}" description changed significantly.\nLegacy: "${legacyRule.description}"\nModern: "${modernMatchingRule.description}"\nSimilarity: ${Math.round(similarity * 100)}%`,
					severity: 'warning',
					requiresComplianceApproval: legacyRule.preservationRequired,
				});
			}
		}
	}

	// Rules added in modern — informational
	for (const modernRule of modern.semanticRules) {
		const legacyMatchingRule = legacy.semanticRules.find((r: ISemanticRule) => r.domain === modernRule.domain);
		if (!legacyMatchingRule && modernRule.preservationRequired) {
			divergences.push({
				type: 'rule-changed' as DivergenceType,
				description: `New compliance-required semantic rule "${modernRule.domain}" appears in the modern translation but was not in the legacy unit: "${modernRule.description}". This may indicate new business logic was introduced.`,
				severity: 'warning',
				requiresComplianceApproval: true,
			});
		}
	}

	return divergences;
}


// ─── Domain Comparison ────────────────────────────────────────────────────────

function compareComplianceDomains(
	legacy: IComplianceFingerprint,
	modern: IComplianceFingerprint,
): IFingerprintDivergence[] {
	const divergences: IFingerprintDivergence[] = [];

	const legacyDomains = new Set(legacy.complianceDomains);
	const modernDomains = new Set(modern.complianceDomains);

	for (const domain of legacyDomains) {
		if (!modernDomains.has(domain)) {
			divergences.push({
				type: 'domain-removed' as DivergenceType,
				description: `Compliance domain "${domain}" was present in the legacy unit but is absent in the modern translation. The modern code may have dropped this area of regulatory concern.`,
				severity: 'blocking',
				requiresComplianceApproval: true,
			});
		}
	}

	for (const domain of modernDomains) {
		if (!legacyDomains.has(domain)) {
			divergences.push({
				type: 'domain-added' as DivergenceType,
				description: `Compliance domain "${domain}" appears in the modern translation but was not in the legacy unit. New regulatory exposure may have been introduced.`,
				severity: 'warning',
				requiresComplianceApproval: false,
			});
		}
	}

	return divergences;
}


// ─── Invariant Comparison ─────────────────────────────────────────────────────

function compareInvariants(
	legacy: IComplianceFingerprint,
	modern: IComplianceFingerprint,
): IFingerprintDivergence[] {
	const divergences: IFingerprintDivergence[] = [];

	// Check that all legacy invariants are accounted for in modern
	// We check by invariantType — if a type is present in legacy, modern must have it too
	const modernInvariantTypes = new Set(modern.invariants.map((i: ILogicalInvariant) => i.invariantType));

	for (const legacyInvariant of legacy.invariants) {
		if (!modernInvariantTypes.has(legacyInvariant.invariantType)) {
			divergences.push({
				type: 'invariant-violated' as DivergenceType,
				description: `Invariant "${legacyInvariant.invariantType}" from legacy unit is not present in the modern fingerprint. Legacy requirement: "${legacyInvariant.description}"`,
				legacyLocation: legacyInvariant.location,
				severity: legacyInvariant.testable ? 'warning' : 'blocking',
				requiresComplianceApproval: !legacyInvariant.testable,
			});
		}
	}

	return divergences;
}


// ─── Match Score ──────────────────────────────────────────────────────────────

function calculateMatchPercentage(
	legacy: IComplianceFingerprint,
	divergences: IFingerprintDivergence[],
): number {
	// Total checkpoints = regulated fields + required semantic rules + domains + invariants
	const totalFields = legacy.regulatedFields.length;
	const totalRules = legacy.semanticRules.filter((r: ISemanticRule) => r.preservationRequired).length;
	const totalDomains = legacy.complianceDomains.length;
	const totalInvariants = legacy.invariants.length;

	const totalCheckpoints = totalFields + totalRules + totalDomains + totalInvariants;
	if (totalCheckpoints === 0) {
		return 100; // No regulated content — trivially passes
	}

	// Count blocking and warning divergences
	const blockingCount = divergences.filter(d => d.severity === 'blocking').length;
	const warningCount = divergences.filter(d => d.severity === 'warning').length;

	// Blocking divergences cost 2x the weight of warnings
	const penaltyPoints = (blockingCount * 2) + warningCount;
	const maxPenalty = totalCheckpoints * 2; // Worst case: all blocking

	const score = Math.max(0, 100 - Math.round((penaltyPoints / maxPenalty) * 100));
	return score;
}


// ─── Utilities ────────────────────────────────────────────────────────────────

function normaliseFieldKey(fieldName: string, attribute: string): string {
	return `${fieldName.toUpperCase()}:${attribute.toLowerCase()}`;
}

/** Whether the operation type represents an escalation (more invasive than before) */
function isOperationEscalation(legacyOp: string, modernOp: string): boolean {
	const operationRank: Record<string, number> = {
		'read': 1, 'compare': 1,
		'calculate': 2,
		'write': 3,
		'store': 3,
		'transmit': 4,
	};
	return (operationRank[modernOp] ?? 0) > (operationRank[legacyOp] ?? 0);
}

/**
 * Very simple word-overlap similarity (Jaccard) for semantic rule descriptions.
 * Not NLP — just a quick heuristic to catch major rewrites.
 */
function descriptionSimilarity(a: string, b: string): number {
	const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 3));
	const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 3));

	if (wordsA.size === 0 && wordsB.size === 0) {
		return 1;
	}

	let intersection = 0;
	for (const word of wordsA) {
		if (wordsB.has(word)) {
			intersection++;
		}
	}

	const union = wordsA.size + wordsB.size - intersection;
	return union === 0 ? 1 : intersection / union;
}


registerSingleton(IFingerprintComparisonService, FingerprintComparisonService, InstantiationType.Delayed);
