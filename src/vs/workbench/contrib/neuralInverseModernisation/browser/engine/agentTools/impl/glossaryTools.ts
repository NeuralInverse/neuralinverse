/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import {
	IBusinessTerm,
	IBusinessRule,
	IBusinessDomain,
} from '../../../../common/knowledgeBaseTypes.js';
import { generateId } from './toolUtils.js';
import {
	IAgentToolCallResult,
	IGetGlossaryInput,
	IAddGlossaryTermInput,
	IGetBusinessRulesInput,
} from '../agentToolTypes.js';


// ─── Tool implementations ─────────────────────────────────────────────────────

export function getGlossary(
	input: IGetGlossaryInput | undefined,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IBusinessTerm[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const glossary = kb.getGlossary(input?.domain);
	let terms = glossary.terms;

	if (input?.search) {
		const q = input.search.toLowerCase();
		terms = terms.filter(t =>
			t.term.toLowerCase().includes(q) ||
			t.meaning.toLowerCase().includes(q),
		);
	}

	const limit = input?.limit ?? 50;
	const paged = terms.slice(0, limit);

	return {
		success: true,
		data: paged,
		summary: `${paged.length} of ${terms.length} glossary terms` +
			(input?.domain ? ` in domain "${input.domain}"` : ''),
	};
}


export function addGlossaryTerm(
	input: IAddGlossaryTermInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IBusinessTerm> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	// Append examples/relatedTerms as extra context in meaning if provided
	let meaning = input.meaning;
	if (input.examples?.length)     { meaning += ` Examples: ${input.examples.join('; ')}.`; }
	if (input.relatedTerms?.length) { meaning += ` Related: ${input.relatedTerms.join(', ')}.`; }

	const term: IBusinessTerm = {
		term:         input.term,
		meaning,
		domain:       input.domain ?? '',
		sourceLocs:   [],
		extractedBy:  'human',
		confidence:   1,
	};

	kb.recordGlossaryTerm(term);

	return {
		success: true,
		data: term,
		summary: `Glossary term "${input.term}" recorded` +
			(input.domain ? ` in domain "${input.domain}"` : ''),
	};
}


export function getBusinessRules(
	input: IGetBusinessRulesInput | undefined,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IBusinessRule[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	let rules: IBusinessRule[] = [];

	if (input?.unitId) {
		const unit = kb.getUnit(input.unitId);
		if (!unit) {
			return { success: false, error: `Unit not found: ${input.unitId}` };
		}
		rules = unit.businessRules;
	} else if (input?.domain) {
		rules = kb.getBusinessRulesForDomain(input.domain);
	} else {
		// All rules across all units
		rules = kb.getAllUnits().flatMap(u => u.businessRules);
	}

	if (input?.preservationRequired) {
		rules = rules.filter(r => r.preservationRequired);
	}

	const limit   = input?.limit ?? 50;
	const paged   = rules.slice(0, limit);

	return {
		success: true,
		data: paged,
		summary: `${paged.length} of ${rules.length} business rule(s)` +
			(input?.preservationRequired ? ' (preservation-required only)' : ''),
	};
}


export function getDomains(
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IBusinessDomain[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const domains = kb.getAllDomains();

	// Enrich each domain with a unit count
	const enriched = domains.map(d => ({
		...d,
		_unitCount: kb.getUnitsByDomain(d.name).length,
	}));

	return {
		success: true,
		data: enriched,
		summary: `${domains.length} business domain(s)`,
	};
}


// ─── Decision record tools (shared with agentToolTypes) ───────────────────────

export { generateId };
