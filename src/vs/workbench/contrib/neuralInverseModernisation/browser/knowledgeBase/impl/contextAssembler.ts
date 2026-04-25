/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Context Assembler
 *
 * This is the most important module for agents.
 * It assembles everything an LLM needs to translate a single unit:
 *
 *   1. Resolved source text (with all dependencies expanded inline)
 *   2. Applicable type-mapping decisions (scoped to this unit)
 *   3. Applicable naming decisions (scoped by source text presence)
 *   4. Rule interpretations for this unit
 *   5. Pattern overrides matching this unit
 *   6. Translated interfaces of all units this unit calls
 *   7. Related business rules from similar already-translated units
 *   8. Relevant glossary terms (those appearing in the source text)
 *
 * Also provides text serialisers for injecting decisions and glossary into LLM prompts.
 */

import {
	IModernisationKnowledgeBase,
	IKnowledgeUnit,
	IDecisionLog,
	IBusinessRule,
	IBusinessTerm,
	IUnitInterface,
	ITypeMappingDecision,
	INamingDecision,
	IRuleInterpretation,
	IPatternOverride,
} from '../../../common/knowledgeBaseTypes.js';
import { emptyDecisionLog, DONE_STATUSES } from './helpers.js';
import { IResolvedUnitContext } from '../types.js';
import { getUnblockedDependencies } from './dependencies.js';


// ─── Context resolution ───────────────────────────────────────────────────────

/**
 * Assemble the full context for translating a unit.
 * Called by the Translation Engine before every LLM call.
 */
export function getResolvedContext(
	unitId: string,
	kb: IModernisationKnowledgeBase,
): IResolvedUnitContext {
	const unit = kb.units.get(unitId);
	if (!unit) { throw new Error(`[ContextAssembler] Unit not found: ${unitId}`); }

	const unblockedDependencies = getUnblockedDependencies(unit, kb.units);
	return {
		unit,
		resolvedSource:             unit.resolvedSource || unit.sourceText,
		applicableTypeMappings:     getApplicableTypeMappings(unit, kb),
		applicableNamingDecisions:  getApplicableNamingDecisions(unit, kb),
		ruleInterpretations:        getRuleInterpretations(unitId, kb),
		patternOverrides:           getPatternOverrides(unit, kb),
		calledInterfaces:           getCalledInterfaces(unit, kb),
		relatedRules:               getRelatedRules(unit, kb),
		relevantGlossaryTerms:      getRelevantGlossaryTerms(unit, kb),
		readyToTranslate:           unblockedDependencies.length === 0,
		unblockedDependencies,
		contextAnnotations:         [],  // Populated by KnowledgeBaseImpl.getResolvedContext()
	};
}


// ─── Decision scoping ─────────────────────────────────────────────────────────

/**
 * Type-mapping decisions applicable to a unit:
 *   - Those with empty `appliesTo` (global scope)
 *   - Those explicitly naming this unit in `appliesTo`
 */
function getApplicableTypeMappings(
	unit: IKnowledgeUnit,
	kb: IModernisationKnowledgeBase,
): ITypeMappingDecision[] {
	return kb.decisions.typeMapping.filter(d =>
		d.appliesTo.length === 0 || d.appliesTo.includes(unit.id)
	);
}

/**
 * Naming decisions applicable to a unit:
 * Check whether the source name appears anywhere in the unit's resolved source text.
 */
function getApplicableNamingDecisions(
	unit: IKnowledgeUnit,
	kb: IModernisationKnowledgeBase,
): INamingDecision[] {
	const srcLower = (unit.resolvedSource || unit.sourceText).toLowerCase();
	return kb.decisions.naming.filter(d =>
		srcLower.includes(d.sourceName.toLowerCase())
	);
}

function getRuleInterpretations(
	unitId: string,
	kb: IModernisationKnowledgeBase,
): IRuleInterpretation[] {
	return kb.decisions.ruleInterpret.filter(d => d.unitId === unitId);
}

/**
 * Pattern overrides that match this unit's name.
 * Supports regex or exact-name matching.
 */
function getPatternOverrides(
	unit: IKnowledgeUnit,
	kb: IModernisationKnowledgeBase,
): IPatternOverride[] {
	return kb.decisions.patternOverrides.filter(d => {
		try {
			return new RegExp(d.pattern, 'i').test(unit.name);
		} catch {
			return unit.name.toLowerCase() === d.pattern.toLowerCase();
		}
	});
}

/**
 * The full scoped decision log for a unit — used by getDecisionsForUnit().
 */
export function getDecisionsForUnit(
	unitId: string,
	kb: IModernisationKnowledgeBase,
): IDecisionLog {
	const unit = kb.units.get(unitId);
	if (!unit) { return emptyDecisionLog(); }
	return {
		typeMapping:      getApplicableTypeMappings(unit, kb),
		naming:           getApplicableNamingDecisions(unit, kb),
		ruleInterpret:    getRuleInterpretations(unitId, kb),
		exclusions:       kb.decisions.exclusions,
		patternOverrides: getPatternOverrides(unit, kb),
	};
}


// ─── Interfaces of called units ───────────────────────────────────────────────

/**
 * For each unit that this unit calls (dependsOn), return its translated interface if available.
 * This lets the AI generate correct call signatures for already-translated dependencies.
 */
function getCalledInterfaces(
	unit: IKnowledgeUnit,
	kb: IModernisationKnowledgeBase,
): IUnitInterface[] {
	const result: IUnitInterface[] = [];
	for (const depId of unit.dependsOn) {
		const dep = kb.units.get(depId);
		if (dep?.targetInterface) { result.push(dep.targetInterface); }
	}
	return result;
}


// ─── Related business rules ───────────────────────────────────────────────────

/**
 * Business rules extracted from units that:
 *   1. Are already translated (DONE_STATUSES)
 *   2. Share at least one business domain with this unit
 *
 * Gives the AI pattern recognition: "other units in this domain did X, so this one probably does too"
 * Capped at 20 to stay within LLM context budget.
 */
function getRelatedRules(
	unit: IKnowledgeUnit,
	kb: IModernisationKnowledgeBase,
): IBusinessRule[] {
	const unitDomains = new Set(unit.businessRules.map(r => r.domain));
	if (unitDomains.size === 0) { return []; }

	const result: IBusinessRule[] = [];
	kb.units.forEach(other => {
		if (other.id === unit.id) { return; }
		if (!DONE_STATUSES.has(other.status)) { return; }
		for (const rule of other.businessRules) {
			if (unitDomains.has(rule.domain)) {
				result.push(rule);
			}
		}
	});

	// Sort by confidence desc, then cap at 20
	return result
		.sort((a, b) => b.confidence - a.confidence)
		.slice(0, 20);
}


// ─── Relevant glossary terms ──────────────────────────────────────────────────

/**
 * Glossary terms that appear in this unit's resolved source text.
 * Injected into the prompt so the AI knows what named concepts mean in this codebase.
 */
function getRelevantGlossaryTerms(
	unit: IKnowledgeUnit,
	kb: IModernisationKnowledgeBase,
): IBusinessTerm[] {
	const srcLower = (unit.resolvedSource || unit.sourceText).toLowerCase();
	return kb.glossary.terms.filter(t =>
		srcLower.includes(t.term.toLowerCase())
	);
}


// ─── Context text serialisers ─────────────────────────────────────────────────

/**
 * Serialise the decision log as a compact plain-text block for LLM injection.
 * When unitId is provided, returns only decisions applicable to that unit.
 */
export function exportDecisionsAsContext(
	kb: IModernisationKnowledgeBase,
	unitId?: string,
): string {
	const decisions = unitId
		? getDecisionsForUnit(unitId, kb)
		: kb.decisions;

	const lines: string[] = ['=== ESTABLISHED DECISIONS (apply to all translation) ==='];

	if (decisions.typeMapping.length > 0) {
		lines.push('\nTYPE MAPPINGS:');
		for (const d of decisions.typeMapping) {
			lines.push(`  ${d.sourceType} \u2192 ${d.targetType}${d.rationale ? ` — ${d.rationale}` : ''}`);
		}
	}
	if (decisions.naming.length > 0) {
		lines.push('\nNAMING CONVENTIONS:');
		for (const d of decisions.naming) {
			lines.push(`  ${d.sourceName} \u2192 ${d.targetName} [${d.domain}]`);
		}
	}
	if (decisions.ruleInterpret.length > 0) {
		lines.push('\nRULE INTERPRETATIONS:');
		for (const d of decisions.ruleInterpret) {
			lines.push(`  "${d.sourceText.slice(0, 50)}" means: ${d.meaning}`);
		}
	}
	if (decisions.patternOverrides.length > 0) {
		lines.push('\nPATTERN OVERRIDES:');
		for (const d of decisions.patternOverrides) {
			lines.push(`  ${d.pattern}: ${d.overrideType} = ${d.value}${d.rationale ? ` (${d.rationale})` : ''}`);
		}
	}

	return lines.join('\n');
}

/**
 * Serialise the glossary as a compact plain-text block for LLM injection.
 * When domain is provided, returns only terms for that domain.
 * Capped at 100 terms to stay within context budget.
 */
export function exportGlossaryAsContext(
	kb: IModernisationKnowledgeBase,
	domain?: string,
): string {
	const terms = domain
		? kb.glossary.terms.filter(t => t.domain === domain)
		: kb.glossary.terms;

	const lines: string[] = ['=== BUSINESS GLOSSARY ==='];
	for (const t of terms.slice(0, 100)) {
		lines.push(`  ${t.term}: ${t.meaning} [${t.domain}]${t.confidence < 0.8 ? ' (unconfirmed)' : ''}`);
	}
	if (terms.length > 100) {
		lines.push(`  ... and ${terms.length - 100} more terms`);
	}
	return lines.join('\n');
}
