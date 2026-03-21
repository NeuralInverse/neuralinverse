/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Business Rule Adapter
 *
 * Bridges the fingerprint engine and the Knowledge Base.
 *
 * After Layer 2 extraction produces ISemanticRule[], this adapter:
 * 1. Converts ISemanticRule[] → IBusinessRule[] (KB format)
 * 2. Calls kb.recordBusinessRules(unitId, rules)
 * 3. Calls kb.assignUnitToDomain(unitId, domain) for each compliance domain
 * 4. Updates the glossary if new domain terms are identified
 *
 * Without this adapter, the fingerprint lives only on the unit record but the KB's
 * domain index, business rule queries, and getBusinessRulesForDomain() return empty.
 *
 * ## ID Generation
 *
 * Business rule IDs are deterministically generated from (unitId + ruleIndex + domain + descriptionHash).
 * This means re-running extraction on the same unit produces the same IDs — no orphan rules accumulate.
 *
 * ## Confidence Assignment
 *
 * Rules extracted by the LLM get confidence = 0.85 by default (high confidence, but not human-confirmed).
 * preservationRequired rules get confidence = 0.95 (the LLM is explicitly saying this matters).
 * Human-confirmed rules (if a human has reviewed the unit's fingerprint) get confidence = 1.0.
 */

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { IBusinessRule, IBusinessTerm, IBusinessDomain } from '../../../../common/knowledgeBaseTypes.js';
import { IComplianceFingerprint, ISemanticRule } from '../../../../common/modernisationTypes.js';
import { fnv1a32 } from './fingerprintCache.js';


// ─── Confidence Constants ─────────────────────────────────────────────────────

const CONFIDENCE_AI_DEFAULT = 0.85;
const CONFIDENCE_AI_PRESERVATION_REQUIRED = 0.95;


// ─── Business Rule Adapter ────────────────────────────────────────────────────

/**
 * Write a fingerprint's semantic content to the Knowledge Base.
 *
 * Idempotent: calling this multiple times for the same unit with the same fingerprint
 * produces the same KB state (IDs are deterministic, duplicate rules are overwritten).
 *
 * @param kb          The active knowledge base service
 * @param unitId      The unit to write rules for
 * @param fingerprint The assembled fingerprint (Layer 1 + Layer 2)
 */
export function applyFingerprintToKB(
	kb: IKnowledgeBaseService,
	unitId: string,
	fingerprint: IComplianceFingerprint,
): void {
	if (!fingerprint.llmExtractionComplete) {
		// Layer 2 did not complete — no semantic rules to write.
		// The fingerprint record itself is still written by the caller.
		return;
	}

	// 1. Convert semantic rules → business rules
	const businessRules = convertSemanticRules(unitId, fingerprint.semanticRules);

	// 2. Persist to KB (replaces any previous rules from an earlier extraction)
	if (businessRules.length > 0) {
		kb.recordBusinessRules(unitId, businessRules);
	}

	// 3. Assign unit to each compliance domain
	for (const domain of fingerprint.complianceDomains) {
		ensureDomainExists(kb, domain);
		kb.assignUnitToDomain(unitId, domain);
	}

	// 4. Update glossary with any domain terms extracted by the LLM
	updateGlossaryFromRules(kb, fingerprint.semanticRules, fingerprint.complianceDomains);
}


// ─── Semantic Rule → Business Rule Conversion ─────────────────────────────────

/**
 * Convert ISemanticRule[] (fingerprint format) to IBusinessRule[] (KB format).
 *
 * IDs are deterministic: re-running extraction on identical content produces identical IDs.
 */
function convertSemanticRules(unitId: string, semanticRules: ISemanticRule[]): IBusinessRule[] {
	return semanticRules.map((rule, index) => {
		const id = buildBusinessRuleId(unitId, index, rule);
		const confidence = rule.preservationRequired
			? CONFIDENCE_AI_PRESERVATION_REQUIRED
			: CONFIDENCE_AI_DEFAULT;

		return {
			id,
			description: rule.description,
			domain: rule.domain,
			preservationRequired: rule.preservationRequired,
			involvedFields: rule.involvedFields,
			extractedBy: 'ai' as const,
			confidence,
		} satisfies IBusinessRule;
	});
}

/**
 * Build a deterministic ID for a business rule.
 *
 * Format: `br:{unitId}:{ruleIndex}:{descriptionHash}`
 *
 * The description hash ensures that if the LLM produces a different description
 * for a rule (even with the same index), it gets a different ID — preventing
 * a stale description from being associated with a new rule ID.
 */
function buildBusinessRuleId(unitId: string, index: number, rule: ISemanticRule): string {
	const descHash = fnv1a32(rule.description + rule.domain);
	return `br:${unitId}:${index}:${descHash}`;
}


// ─── Domain Management ────────────────────────────────────────────────────────

/**
 * Ensure a business domain exists in the KB.
 * Creates it if it doesn't exist yet; no-op if it already exists.
 */
function ensureDomainExists(kb: IKnowledgeBaseService, domainName: string): void {
	const existing = kb.getDomain(domainName);
	if (existing) {
		return;
	}

	const domain: IBusinessDomain = {
		name: domainName,
		description: buildDomainDescription(domainName),
		unitIds: [],
		regulated: isRegulatedDomain(domainName),
		complianceFrameworks: frameworksForDomain(domainName),
	};

	kb.addDomain(domain);
}

/**
 * Build a human-readable description for an auto-created compliance domain.
 * Maps well-known domain names to descriptions; generic fallback for unknowns.
 */
function buildDomainDescription(domainName: string): string {
	const KNOWN_DOMAINS: Record<string, string> = {
		fee_calculation: 'Calculation of fees, charges, and penalties applied to accounts.',
		interest_accrual: 'Accrual of interest on balances over time.',
		transaction_settlement: 'Settlement and clearing of financial transactions.',
		tax_computation: 'Calculation and application of taxes, VAT, GST, and withholding.',
		identity_verification: 'Verification and validation of customer identity.',
		audit_logging: 'Recording of audit trails for regulatory compliance.',
		payment_processing: 'Processing of payments, transfers, and disbursements.',
		usage_billing: 'Billing based on usage metrics (telecom, utility, SaaS).',
		data_validation: 'Validation of input data for correctness and completeness.',
		authorisation: 'Authorization and permission checking for financial operations.',
		reconciliation: 'Reconciliation of accounts, balances, and transaction records.',
		end_of_day_processing: 'End-of-day batch processing, settlement, and reporting.',
	};

	return KNOWN_DOMAINS[domainName] ?? `Business domain: ${domainName}`;
}

/** Domains that have direct GRC / regulatory implications */
const REGULATED_DOMAINS = new Set([
	'fee_calculation', 'interest_accrual', 'transaction_settlement',
	'tax_computation', 'payment_processing', 'audit_logging',
	'identity_verification', 'reconciliation',
]);

function isRegulatedDomain(domainName: string): boolean {
	return REGULATED_DOMAINS.has(domainName);
}

const DOMAIN_FRAMEWORKS: Record<string, string[]> = {
	fee_calculation: ['financial-core', 'sox'],
	interest_accrual: ['financial-core'],
	transaction_settlement: ['financial-core', 'sox'],
	tax_computation: ['tax-compliance'],
	identity_verification: ['gdpr-pii', 'pci-dss'],
	audit_logging: ['sox'],
	payment_processing: ['financial-core', 'pci-dss'],
	usage_billing: ['telecom-billing', 'financial-core'],
	data_validation: ['financial-core'],
	authorisation: ['financial-core', 'pci-dss'],
	reconciliation: ['financial-core', 'sox'],
	end_of_day_processing: ['financial-core', 'sox'],
};

function frameworksForDomain(domainName: string): string[] {
	return DOMAIN_FRAMEWORKS[domainName] ?? [];
}


// ─── Glossary Updates ─────────────────────────────────────────────────────────

/**
 * Update the KB glossary with domain terms inferred from the fingerprint.
 *
 * When the LLM identifies a compliance domain and associated business rules,
 * we record a glossary term for the domain if one doesn't exist. This enriches
 * the glossary for future AI translation context.
 */
function updateGlossaryFromRules(
	kb: IKnowledgeBaseService,
	semanticRules: ISemanticRule[],
	complianceDomains: string[],
): void {
	// Extract unique field names mentioned in semantic rules
	const mentionedFields = new Set<string>();
	for (const rule of semanticRules) {
		for (const field of rule.involvedFields) {
			if (field && field.trim()) {
				mentionedFields.add(field.trim());
			}
		}
	}

	// For each compliance domain, ensure a glossary term exists
	for (const domain of complianceDomains) {
		const existing = kb.getGlossaryTerm(domain);
		if (existing) {
			continue;
		}

		const glossaryTerm: IBusinessTerm = {
			term: domain,
			meaning: buildDomainDescription(domain),
			domain,
			sourceLocs: [],
			extractedBy: 'ai',
			confidence: 0.8,
		};

		kb.recordGlossaryTerm(glossaryTerm);
	}
}


// ─── KB State Helpers ─────────────────────────────────────────────────────────

/**
 * Remove all business rules extracted by the AI for a given unit.
 * Called before re-extraction to prevent duplicate rules from accumulating.
 * Human-confirmed rules (extractedBy === 'human') are preserved.
 */
export function purgeAIRulesForUnit(kb: IKnowledgeBaseService, unitId: string): void {
	const unit = kb.getUnit(unitId);
	if (!unit) {
		return;
	}

	for (const rule of unit.businessRules) {
		if (rule.extractedBy === 'ai') {
			kb.deleteBusinessRule(unitId, rule.id);
		}
	}
}
