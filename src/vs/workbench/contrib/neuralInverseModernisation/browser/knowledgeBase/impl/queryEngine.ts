/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Query Engine
 *
 * All read-only query operations over the knowledge base.
 * Uses the in-memory indexes for O(1) lookups where possible,
 * falls back to full scan for complex criteria.
 *
 * All functions are pure — they accept the KB and indexes as arguments.
 */

import { IKnowledgeUnit, UnitStatus, RiskLevel } from '../../../common/knowledgeBaseTypes.js';
import { IUnitFilterCriteria } from '../types.js';
import { IKnowledgeBaseIndexes } from './indexes.js';
import { resolveIds } from './helpers.js';


// ─── Index-based lookups ──────────────────────────────────────────────────────

export function getByStatus(
	status: UnitStatus,
	idx: IKnowledgeBaseIndexes,
	units: Map<string, IKnowledgeUnit>,
): IKnowledgeUnit[] {
	return resolveIds(idx.byStatus.get(status), units);
}

export function getByRisk(
	risk: RiskLevel,
	idx: IKnowledgeBaseIndexes,
	units: Map<string, IKnowledgeUnit>,
): IKnowledgeUnit[] {
	return resolveIds(idx.byRisk.get(risk), units);
}

export function getByDomain(
	domain: string,
	idx: IKnowledgeBaseIndexes,
	units: Map<string, IKnowledgeUnit>,
): IKnowledgeUnit[] {
	return resolveIds(idx.byDomain.get(domain), units);
}

export function getByLanguage(
	language: string,
	idx: IKnowledgeBaseIndexes,
	units: Map<string, IKnowledgeUnit>,
): IKnowledgeUnit[] {
	return resolveIds(idx.byLang.get(language), units);
}

export function getByFile(
	filePath: string,
	idx: IKnowledgeBaseIndexes,
	units: Map<string, IKnowledgeUnit>,
): IKnowledgeUnit[] {
	return resolveIds(idx.byFile.get(filePath), units);
}

export function getByPhase(
	phaseId: string,
	idx: IKnowledgeBaseIndexes,
	units: Map<string, IKnowledgeUnit>,
): IKnowledgeUnit[] {
	return resolveIds(idx.byPhase.get(phaseId), units);
}


// ─── Full-text search ─────────────────────────────────────────────────────────

/**
 * Full-text search across: unit name, source language, source file path,
 * unit type, and all business rule descriptions.
 *
 * Multi-term: all space-separated terms must match.
 * Case-insensitive.
 */
export function searchUnits(
	query: string,
	units: Map<string, IKnowledgeUnit>,
): IKnowledgeUnit[] {
	const q = query.toLowerCase().trim();
	if (!q) { return []; }
	const terms = q.split(/\s+/).filter(Boolean);

	const result: IKnowledgeUnit[] = [];
	units.forEach(u => {
		const haystack = [
			u.name,
			u.sourceLang,
			u.sourceFile,
			u.unitType,
			...u.businessRules.map(r => r.description),
		].join(' ').toLowerCase();

		if (terms.every(t => haystack.includes(t))) {
			result.push(u);
		}
	});

	// Sort by name for deterministic ordering
	return result.sort((a, b) => a.name.localeCompare(b.name));
}


// ─── Multi-criteria filter ────────────────────────────────────────────────────

/**
 * Filter units by multiple criteria simultaneously.
 * Uses indexes when possible, falls back to full scan for complex criteria.
 *
 * Criteria are AND-combined: all must match.
 */
export function filterUnits(
	criteria: IUnitFilterCriteria,
	units: Map<string, IKnowledgeUnit>,
	idx: IKnowledgeBaseIndexes,
): IKnowledgeUnit[] {

	// Start with the most selective criterion to minimise work
	let candidates: IKnowledgeUnit[] | null = null;

	// Status filter — use index (very selective)
	if (criteria.status?.length === 1) {
		candidates = resolveIds(idx.byStatus.get(criteria.status[0]), units);
	} else if (criteria.status && criteria.status.length > 1) {
		const union: IKnowledgeUnit[] = [];
		for (const s of criteria.status) {
			union.push(...resolveIds(idx.byStatus.get(s), units));
		}
		candidates = union;
	}

	// Domain filter — use index
	if (criteria.domain) {
		const domainIds = idx.byDomain.get(criteria.domain);
		if (!domainIds) { return []; }
		if (candidates) {
			candidates = candidates.filter(u => domainIds.has(u.id));
		} else {
			candidates = resolveIds(domainIds, units);
		}
	}

	// Risk filter — use index
	if (criteria.risk?.length) {
		const riskSets = criteria.risk.map(r => idx.byRisk.get(r));
		const combined = new Set<string>();
		for (const s of riskSets) { s?.forEach(id => combined.add(id)); }
		if (candidates) {
			candidates = candidates.filter(u => combined.has(u.id));
		} else {
			candidates = resolveIds(combined, units);
		}
	}

	// Language filter — use index
	if (criteria.language) {
		const langIds = idx.byLang.get(criteria.language);
		if (!langIds) { return []; }
		if (candidates) {
			candidates = candidates.filter(u => langIds.has(u.id));
		} else {
			candidates = resolveIds(langIds, units);
		}
	}

	// File pattern — substring match, full scan of candidates
	if (criteria.filePattern) {
		const pat = criteria.filePattern.toLowerCase();
		const base = candidates ?? Array.from(units.values());
		candidates = base.filter(u => u.sourceFile.toLowerCase().includes(pat));
	}

	// If no criteria matched yet, return everything
	return candidates ?? Array.from(units.values());
}
