/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * In-memory index manager for fast O(1) unit lookups.
 *
 * The knowledge base stores units in a Map<id, IKnowledgeUnit>.
 * These indexes provide fast reverse-lookup by status, risk, file, language, domain, and phase.
 * They are rebuilt from the KB on load and kept in sync on every mutation.
 */

import {
	IKnowledgeUnit,
	ITypeMappingDecision,
	INamingDecision,
	UnitStatus,
	RiskLevel,
} from '../../../common/knowledgeBaseTypes.js';
import { addToIndex, removeFromIndex } from './helpers.js';


// ─── Index container ──────────────────────────────────────────────────────────

export interface IKnowledgeBaseIndexes {
	/** status → Set<unitId> */
	byStatus: Map<UnitStatus, Set<string>>;
	/** riskLevel → Set<unitId> */
	byRisk: Map<RiskLevel, Set<string>>;
	/** sourceFile → Set<unitId> */
	byFile: Map<string, Set<string>>;
	/** sourceLang → Set<unitId> */
	byLang: Map<string, Set<string>>;
	/** domainName → Set<unitId> */
	byDomain: Map<string, Set<string>>;
	/** phaseId → Set<unitId> */
	byPhase: Map<string, Set<string>>;
	/** sourceType.toLowerCase() → ITypeMappingDecision */
	typeMappingBySource: Map<string, ITypeMappingDecision>;
	/** sourceName.toLowerCase() → INamingDecision */
	namingBySource: Map<string, INamingDecision>;
}

export function createIndexes(): IKnowledgeBaseIndexes {
	return {
		byStatus:           new Map(),
		byRisk:             new Map(),
		byFile:             new Map(),
		byLang:             new Map(),
		byDomain:           new Map(),
		byPhase:            new Map(),
		typeMappingBySource: new Map(),
		namingBySource:     new Map(),
	};
}

export function clearIndexes(idx: IKnowledgeBaseIndexes): void {
	idx.byStatus.clear();
	idx.byRisk.clear();
	idx.byFile.clear();
	idx.byLang.clear();
	idx.byDomain.clear();
	idx.byPhase.clear();
	idx.typeMappingBySource.clear();
	idx.namingBySource.clear();
}


// ─── Unit indexing ────────────────────────────────────────────────────────────

export function indexUnit(unit: IKnowledgeUnit, idx: IKnowledgeBaseIndexes): void {
	addToIndex(idx.byStatus, unit.status,     unit.id);
	addToIndex(idx.byRisk,   unit.riskLevel,  unit.id);
	addToIndex(idx.byFile,   unit.sourceFile, unit.id);
	addToIndex(idx.byLang,   unit.sourceLang, unit.id);
}

export function deindexUnit(unit: IKnowledgeUnit, idx: IKnowledgeBaseIndexes): void {
	removeFromIndex(idx.byStatus, unit.status,     unit.id);
	removeFromIndex(idx.byRisk,   unit.riskLevel,  unit.id);
	removeFromIndex(idx.byFile,   unit.sourceFile, unit.id);
	removeFromIndex(idx.byLang,   unit.sourceLang, unit.id);
	// NOTE: domain and phase indexes are not removed here because units can belong to
	// multiple domains and phases — those indexes are managed explicitly.
}


// ─── Decision indexing ────────────────────────────────────────────────────────

export function indexTypeMappingDecision(d: ITypeMappingDecision, idx: IKnowledgeBaseIndexes): void {
	idx.typeMappingBySource.set(d.sourceType.toLowerCase(), d);
}

export function removeTypeMappingFromIndex(sourceType: string, idx: IKnowledgeBaseIndexes): void {
	idx.typeMappingBySource.delete(sourceType.toLowerCase());
}

export function indexNamingDecision(d: INamingDecision, idx: IKnowledgeBaseIndexes): void {
	idx.namingBySource.set(d.sourceName.toLowerCase(), d);
}

export function removeNamingFromIndex(sourceName: string, idx: IKnowledgeBaseIndexes): void {
	idx.namingBySource.delete(sourceName.toLowerCase());
}


// ─── Domain indexing ──────────────────────────────────────────────────────────

export function indexUnitForDomain(unitId: string, domain: string, idx: IKnowledgeBaseIndexes): void {
	addToIndex(idx.byDomain, domain, unitId);
}

export function indexUnitsForDomain(unitIds: string[], domain: string, idx: IKnowledgeBaseIndexes): void {
	for (const id of unitIds) { addToIndex(idx.byDomain, domain, id); }
}


// ─── Phase indexing ───────────────────────────────────────────────────────────

export function setPhaseIndex(phaseId: string, unitIds: string[], idx: IKnowledgeBaseIndexes): void {
	idx.byPhase.set(phaseId, new Set(unitIds));
}

export function clearPhaseIndexes(idx: IKnowledgeBaseIndexes): void {
	idx.byPhase.clear();
}


// ─── Rebuild from KB ──────────────────────────────────────────────────────────

export function rebuildIndexes(
	kb: import('../../../common/knowledgeBaseTypes.js').IModernisationKnowledgeBase,
	idx: IKnowledgeBaseIndexes,
): void {
	clearIndexes(idx);

	// Unit indexes
	kb.units.forEach(u => indexUnit(u, idx));

	// Decision indexes
	for (const d of kb.decisions.typeMapping) { indexTypeMappingDecision(d, idx); }
	for (const d of kb.decisions.naming)      { indexNamingDecision(d, idx); }

	// Domain indexes (from glossary)
	for (const domain of kb.glossary.domains) {
		indexUnitsForDomain(domain.unitIds, domain.name, idx);
	}

	// Phase indexes (from progress.byPhase)
	// Phase → unit mapping is rebuilt separately when setPhases() is called.
}
