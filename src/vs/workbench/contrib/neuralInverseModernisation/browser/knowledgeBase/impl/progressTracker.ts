/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Progress Tracker
 *
 * Computes and maintains the IProgressState stored inside the knowledge base.
 * Also generates IKnowledgeBaseStats for UI consumption.
 *
 * All functions are pure computations over the KB \u2014 no side effects.
 */

import {
	IModernisationKnowledgeBase,
	IKnowledgeUnit,
	IProgressState,
	IPhaseProgress,
	UnitStatus,
	RiskLevel,
} from '../../../common/knowledgeBaseTypes.js';
import { IMigrationPhase } from '../../../common/modernisationTypes.js';
import { IKnowledgeBaseStats, ILanguageProgress, IDomainProgress } from '../types.js';
import { IKnowledgeBaseIndexes } from './indexes.js';
import {
	ALL_STATUSES,
	ALL_RISKS,
	COMPLETE_STATUSES,
	resolveIds,
} from './helpers.js';


// \u2500\u2500\u2500 Progress update \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Recompute all progress counters from scratch.
 * Called after any mutation that changes unit count or status.
 */
export function updateProgress(kb: IModernisationKnowledgeBase): void {
	const p = kb.progress;

	// Reset counters
	for (const s of ALL_STATUSES) { p.byStatus[s] = 0; }
	for (const r of ALL_RISKS)    { p.byRisk[r]   = 0; }
	p.blockedUnits = [];
	p.totalUnits   = 0;

	kb.units.forEach(u => {
		p.totalUnits++;
		p.byStatus[u.status] = (p.byStatus[u.status] ?? 0) + 1;
		p.byRisk[u.riskLevel] = (p.byRisk[u.riskLevel] ?? 0) + 1;
		if (u.status === 'blocked') { p.blockedUnits.push(u.id); }
	});
}


// \u2500\u2500\u2500 Phase progress \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Recompute progress for a single phase.
 * Phase unit IDs come from the byPhase index.
 */
export function updatePhaseProgress(
	phaseId: string,
	progress: IProgressState,
	phaseIndex: Map<string, Set<string>>,
	units: Map<string, IKnowledgeUnit>,
): void {
	const pp = progress.byPhase.find(p => p.phaseId === phaseId);
	if (!pp) { return; }
	const unitIds = phaseIndex.get(phaseId);
	if (!unitIds) { return; }

	let completed = 0, blocked = 0;
	unitIds.forEach(id => {
		const u = units.get(id);
		if (!u) { return; }
		if (COMPLETE_STATUSES.has(u.status)) { completed++; }
		if (u.status === 'blocked')           { blocked++; }
	});
	pp.completedUnits = completed;
	pp.blockedUnits   = blocked;
}

/** Recompute progress for all phases at once */
export function updateAllPhaseProgress(
	progress: IProgressState,
	phaseIndex: Map<string, Set<string>>,
	units: Map<string, IKnowledgeUnit>,
): void {
	for (const pp of progress.byPhase) {
		updatePhaseProgress(pp.phaseId, progress, phaseIndex, units);
	}
}

/**
 * Convert IMigrationPhase[] from the roadmap into IPhaseProgress[] for the KB.
 * Returns the new byPhase array and the updated phase index.
 */
export function phasesToProgress(phases: IMigrationPhase[]): IPhaseProgress[] {
	return phases.map(p => ({
		phaseId:        p.id,
		label:          p.label,
		totalUnits:     p.unitIds.length,
		completedUnits: 0,
		blockedUnits:   0,
	}));
}


// \u2500\u2500\u2500 Statistics \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function computeStats(
	kb: IModernisationKnowledgeBase,
	idx: IKnowledgeBaseIndexes,
): IKnowledgeBaseStats {
	const p = kb.progress;
	const totalUnits = p.totalUnits;

	const completeCount =
		(p.byStatus['complete']   ?? 0) +
		(p.byStatus['validated']  ?? 0) +
		(p.byStatus['committed']  ?? 0);
	const blockedCount = p.byStatus['blocked'] ?? 0;

	// Language breakdown
	const byLanguage: ILanguageProgress[] = [];
	idx.byLang.forEach((ids, lang) => {
		const units = resolveIds(ids, kb.units);
		const byRisk = Object.fromEntries(ALL_RISKS.map(r => [r, 0])) as Record<RiskLevel, number>;
		let completed = 0, blocked = 0;
		for (const u of units) {
			byRisk[u.riskLevel]++;
			if (COMPLETE_STATUSES.has(u.status)) { completed++; }
			if (u.status === 'blocked') { blocked++; }
		}
		byLanguage.push({ language: lang, totalUnits: units.length, completedUnits: completed, blockedUnits: blocked, byRisk });
	});
	byLanguage.sort((a, b) => b.totalUnits - a.totalUnits);

	// Domain breakdown
	const byDomain: IDomainProgress[] = [];
	idx.byDomain.forEach((ids, domain) => {
		const units = resolveIds(ids, kb.units);
		const domainDef = kb.glossary.domains.find(d => d.name === domain);
		let completed = 0, blocked = 0;
		for (const u of units) {
			if (COMPLETE_STATUSES.has(u.status)) { completed++; }
			if (u.status === 'blocked') { blocked++; }
		}
		byDomain.push({
			domain,
			regulated:      domainDef?.regulated ?? false,
			totalUnits:     units.length,
			completedUnits: completed,
			blockedUnits:   blocked,
		});
	});
	byDomain.sort((a, b) => b.totalUnits - a.totalUnits);

	// Pending decisions by priority
	const pendingByPriority: Record<'low' | 'medium' | 'high' | 'blocking', number> = {
		low: 0, medium: 0, high: 0, blocking: 0,
	};
	for (const d of p.pendingDecisions) { pendingByPriority[d.priority]++; }

	const totalDecisions =
		kb.decisions.typeMapping.length +
		kb.decisions.naming.length +
		kb.decisions.ruleInterpret.length +
		kb.decisions.patternOverrides.length +
		kb.decisions.exclusions.length;

	return {
		totalUnits,
		totalFiles:          kb.files.size,
		byStatus:            { ...p.byStatus } as Record<UnitStatus, number>,
		byRisk:              { ...p.byRisk }   as Record<RiskLevel, number>,
		byLanguage,
		byDomain,
		totalDecisions,
		totalGlossaryTerms:  kb.glossary.terms.length,
		totalAuditEntries:   kb.auditLog.length,
		percentComplete:     totalUnits > 0 ? (completeCount / totalUnits) * 100 : 0,
		percentBlocked:      totalUnits > 0 ? (blockedCount  / totalUnits) * 100 : 0,
		pendingDecisionCount:       p.pendingDecisions.length,
		pendingDecisionsByPriority: pendingByPriority,
	};
}
