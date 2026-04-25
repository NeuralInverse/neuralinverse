/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Fingerprint Assembler
 *
 * Merges the results of Layer 1 (deterministic extractor) and Layer 2 (LLM semantic
 * extractor) into a single IComplianceFingerprint artifact.
 *
 * ## Merge Strategy
 *
 * Layer 1 and Layer 2 can both produce ILogicalInvariant[]. The assembler:
 * 1. Takes ALL Layer 1 invariants (always trusted \u2014 deterministic)
 * 2. Merges Layer 2 invariants that are not duplicates of Layer 1 results
 *    (deduplicated by normalised description)
 * 3. Stamps the fingerprint with the current schema version and content hash
 *
 * If Layer 2 fails or is absent:
 * - semanticRules = []
 * - complianceDomains = []
 * - llmExtractionComplete = false
 * - The fingerprint is still valid and stored \u2014 Layer 1 alone is useful
 *
 * ## Invariant Deduplication
 *
 * An invariant from Layer 2 is considered a duplicate of a Layer 1 invariant if:
 * - The normalised description strings match with > 80% token overlap, OR
 * - Both have the same invariantType AND describe the same field name
 *
 * We prefer Layer 1 invariants when there is overlap because they are deterministic
 * and more precisely located (carry ICodeRange).
 */

import { IComplianceFingerprint, ILogicalInvariant, IRegulatedField, ISemanticRule } from '../../../../common/modernisationTypes.js';
import { IDeterministicExtractionResult } from '../deterministicExtractor.js';
import { ILLMSemanticExtractionResult } from '../llmSemanticExtractor.js';
import { buildCacheKey } from './fingerprintCache.js';
import { getCurrentSchemaVersion } from './fingerprintVersioning.js';


// \u2500\u2500\u2500 Assembly Input \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IFingerprintAssemblyInput {
	unitId: string;
	sourceLanguage: string;
	sourceText: string;
	/** Result from Layer 1 deterministic extractor */
	layer1: IDeterministicExtractionResult;
	/** Result from Layer 2 LLM extractor \u2014 undefined if LLM call was skipped or failed */
	layer2: ILLMSemanticExtractionResult | undefined;
	/** Whether Layer 2 extraction completed successfully */
	llmExtractionComplete: boolean;
}


// \u2500\u2500\u2500 Assembler \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Assemble a complete IComplianceFingerprint from Layer 1 and (optionally) Layer 2 results.
 *
 * This is a pure function \u2014 it has no side effects and does not touch the KB.
 * The FingerprintServiceImpl calls this and then writes the result to KB.
 */
export function assembleFingerprint(input: IFingerprintAssemblyInput): IComplianceFingerprint {
	const { unitId, sourceLanguage, sourceText, layer1, layer2, llmExtractionComplete } = input;

	// Stamp with content hash for cache invalidation when source changes
	const contentHash = buildCacheKey(sourceText);
	const schemaVersion = getCurrentSchemaVersion();

	// Merge invariants: Layer 1 always first, then deduplicated Layer 2 additions
	const mergedInvariants = mergeInvariants(
		layer1.invariants,
		layer2?.additionalInvariants ?? [],
	);

	// Layer 1 regulated fields (always included)
	const regulatedFields: IRegulatedField[] = layer1.regulatedFields;

	// Layer 2 semantic content (empty if LLM failed)
	const semanticRules: ISemanticRule[] = layer2?.semanticRules ?? [];
	const complianceDomains: string[] = deduplicateDomains(layer2?.complianceDomains ?? []);

	return {
		unitId,
		extractedAt: Date.now(),
		sourceLanguage,
		regulatedFields,
		invariants: mergedInvariants,
		semanticRules,
		complianceDomains,
		llmExtractionComplete,
		contentHash,
		schemaVersion,
	};
}


// \u2500\u2500\u2500 Invariant Merging \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Merge Layer 1 and Layer 2 invariants, removing duplicates.
 *
 * Layer 1 invariants are always included. A Layer 2 invariant is excluded if
 * it is semantically equivalent to any existing Layer 1 invariant.
 */
function mergeInvariants(
	layer1Invariants: ILogicalInvariant[],
	layer2Invariants: ILogicalInvariant[],
): ILogicalInvariant[] {
	if (layer2Invariants.length === 0) {
		return layer1Invariants;
	}

	const merged = [...layer1Invariants];

	for (const l2 of layer2Invariants) {
		if (!isDuplicateInvariant(l2, layer1Invariants)) {
			merged.push(l2);
		}
	}

	return merged;
}

/**
 * Returns true if `candidate` is semantically equivalent to any invariant in `existing`.
 *
 * Equivalence criteria (either is sufficient):
 * 1. Same invariantType AND significant token overlap in description (> 60% of tokens match)
 * 2. Both descriptions share the same field name AND same invariantType
 */
function isDuplicateInvariant(
	candidate: ILogicalInvariant,
	existing: ILogicalInvariant[],
): boolean {
	for (const e of existing) {
		if (e.invariantType !== candidate.invariantType) {
			continue;
		}

		// Check description token overlap
		const overlapRatio = tokenOverlapRatio(
			normaliseDescription(candidate.description),
			normaliseDescription(e.description),
		);

		if (overlapRatio > 0.60) {
			return true;
		}
	}
	return false;
}

/**
 * Compute the Jaccard similarity between two normalised description strings.
 * Returns 0.0 to 1.0.
 */
function tokenOverlapRatio(descA: string, descB: string): number {
	const tokensA = new Set(descA.split(/\s+/).filter(t => t.length > 2));
	const tokensB = new Set(descB.split(/\s+/).filter(t => t.length > 2));

	if (tokensA.size === 0 || tokensB.size === 0) {
		return 0;
	}

	let intersectionSize = 0;
	for (const token of tokensA) {
		if (tokensB.has(token)) {
			intersectionSize++;
		}
	}

	const unionSize = tokensA.size + tokensB.size - intersectionSize;
	return intersectionSize / unionSize;
}

/**
 * Normalise a description string for comparison:
 * lowercase, strip punctuation, normalise whitespace.
 */
function normaliseDescription(desc: string): string {
	return desc
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}


// \u2500\u2500\u2500 Domain Deduplication \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Remove duplicate compliance domain strings (case-insensitive).
 * Returns the domains in their original case, deduplicated.
 */
function deduplicateDomains(domains: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const domain of domains) {
		const normalised = domain.toLowerCase().trim();
		if (!seen.has(normalised)) {
			seen.add(normalised);
			result.push(domain.trim());
		}
	}
	return result;
}


// \u2500\u2500\u2500 Utility \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Returns true if the fingerprint has any regulated content (Layer 1 or Layer 2).
 * A fingerprint with no regulated content is not meaningless \u2014 it is a valid signal
 * that this unit has no compliance significance.
 */
export function hasFingerprintContent(fp: IComplianceFingerprint): boolean {
	return (
		fp.regulatedFields.length > 0 ||
		fp.invariants.length > 0 ||
		fp.semanticRules.length > 0 ||
		fp.complianceDomains.length > 0
	);
}

/**
 * Returns a short human-readable summary of a fingerprint for logging and UI.
 * e.g. "3 regulated fields, 2 rules, domains: [fee_calculation, settlement]"
 */
export function fingerprintSummary(fp: IComplianceFingerprint): string {
	const parts: string[] = [];
	if (fp.regulatedFields.length > 0) {
		parts.push(`${fp.regulatedFields.length} regulated field${fp.regulatedFields.length !== 1 ? 's' : ''}`);
	}
	if (fp.semanticRules.length > 0) {
		parts.push(`${fp.semanticRules.length} semantic rule${fp.semanticRules.length !== 1 ? 's' : ''}`);
	}
	if (fp.invariants.length > 0) {
		parts.push(`${fp.invariants.length} invariant${fp.invariants.length !== 1 ? 's' : ''}`);
	}
	if (fp.complianceDomains.length > 0) {
		parts.push(`domains: [${fp.complianceDomains.join(', ')}]`);
	}
	if (parts.length === 0) {
		return 'no regulated content detected';
	}
	return parts.join(', ');
}
