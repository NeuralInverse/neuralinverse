/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Decision conflict detection and impact analysis.
 *
 * A "decision conflict" arises when two type-mapping or naming decisions map
 * the same source identifier to different targets. Left unresolved they produce
 * inconsistent translations across the codebase.
 *
 * "Decision impact" answers: "if I remove or change decision X, which units need
 * to be re-translated?"
 */

import {
	IDecisionConflict,
	IDecisionLog,
	IKnowledgeUnit,
} from '../../../common/knowledgeBaseTypes.js';
import { IDecisionImpactResult } from '../types.js';
import { makeId, DONE_STATUSES } from './helpers.js';

// ─── Conflict store ───────────────────────────────────────────────────────────

export interface IConflictStore {
	conflicts: Map<string, IDecisionConflict>; // conflictId \u2192 conflict
}

export function createConflictStore(): IConflictStore {
	return { conflicts: new Map() };
}

// ─── Conflict detection ───────────────────────────────────────────────────────

/**
 * Scan the full decision log for conflicts and update the conflict store.
 * Returns all detected conflicts (including newly resolved ones if changed).
 */
export function detectDecisionConflicts(
	store: IConflictStore,
	decisions: IDecisionLog,
): IDecisionConflict[] {

	// ── Type-mapping conflicts ──────────────────────────────────────────────
	// Group by sourceType
	const typeMappingBySource = new Map<string, typeof decisions.typeMapping>();
	for (const tm of decisions.typeMapping) {
		const key = tm.sourceType.toLowerCase();
		if (!typeMappingBySource.has(key)) { typeMappingBySource.set(key, []); }
		typeMappingBySource.get(key)!.push(tm);
	}

	// ── Naming conflicts ────────────────────────────────────────────────────
	const namingBySource = new Map<string, typeof decisions.naming>();
	for (const nm of decisions.naming) {
		const key = nm.sourceName.toLowerCase();
		if (!namingBySource.has(key)) { namingBySource.set(key, []); }
		namingBySource.get(key)!.push(nm);
	}

	const newConflicts: IDecisionConflict[] = [];

	// Check type-mapping groups
	for (const [sourceKey, group] of typeMappingBySource) {
		if (group.length < 2) { continue; }
		// Find distinct targetTypes
		const targets = new Set(group.map(d => d.targetType));
		if (targets.size < 2) { continue; } // All agree — no conflict

		const conflict = _upsertConflict(store, {
			decisionType:        'type-mapping',
			sourceIdentifier:    sourceKey,
			conflictingDecisionIds: group.map(d => d.id),
			conflictingValues:   Array.from(targets),
		});
		newConflicts.push(conflict);
	}

	// Check naming groups
	for (const [sourceKey, group] of namingBySource) {
		if (group.length < 2) { continue; }
		const targets = new Set(group.map(d => d.targetName));
		if (targets.size < 2) { continue; }

		const conflict = _upsertConflict(store, {
			decisionType:        'naming',
			sourceIdentifier:    sourceKey,
			conflictingDecisionIds: group.map(d => d.id),
			conflictingValues:   Array.from(targets),
		});
		newConflicts.push(conflict);
	}

	return newConflicts;
}

function _upsertConflict(
	store: IConflictStore,
	params: {
		decisionType:           IDecisionConflict['decisionType'];
		sourceIdentifier:       string;
		conflictingDecisionIds: string[];
		conflictingValues:      string[];
	},
): IDecisionConflict {
	// Check if we already have a conflict for this source identifier + type
	for (const existing of store.conflicts.values()) {
		if (
			existing.decisionType     === params.decisionType &&
			existing.sourceIdentifier === params.sourceIdentifier &&
			!existing.resolvedAt
		) {
			// Update in place
			const updated: IDecisionConflict = {
				...existing,
				conflictingDecisionIds: params.conflictingDecisionIds,
				conflictingValues:      params.conflictingValues,
			};
			store.conflicts.set(updated.id, updated);
			return updated;
		}
	}

	const conflict: IDecisionConflict = {
		id:                     makeId('cf'),
		decisionType:           params.decisionType,
		sourceIdentifier:       params.sourceIdentifier,
		conflictingDecisionIds: params.conflictingDecisionIds,
		conflictingValues:      params.conflictingValues,
		detectedAt:             Date.now(),
		resolvedAt:             undefined,
		resolvedBy:             undefined,
		winningDecisionId:      undefined,
	};
	store.conflicts.set(conflict.id, conflict);
	return conflict;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function getDecisionConflict(
	store: IConflictStore,
	conflictId: string,
): IDecisionConflict | undefined {
	return store.conflicts.get(conflictId);
}

export function getDecisionConflicts(
	store: IConflictStore,
	unresolvedOnly = false,
): IDecisionConflict[] {
	const all = Array.from(store.conflicts.values());
	return unresolvedOnly ? all.filter(c => !c.resolvedAt) : all;
}

// ─── Resolution ───────────────────────────────────────────────────────────────

export function resolveDecisionConflict(
	store: IConflictStore,
	conflictId: string,
	winningDecisionId: string,
	actor?: string,
): void {
	const conflict = store.conflicts.get(conflictId);
	if (!conflict) { return; }
	store.conflicts.set(conflictId, {
		...conflict,
		resolvedAt:        Date.now(),
		resolvedBy:        actor,
		winningDecisionId,
	});
}

// ─── Impact analysis ──────────────────────────────────────────────────────────

/**
 * Determine which units are affected if a decision is changed or removed.
 *
 * For type-mapping: units whose resolvedSource contains the sourceType string.
 * For naming: units whose resolvedSource or unit name contains the sourceName.
 * For rule-interpretation / pattern-override: units matching the appliesTo list.
 */
export function getDecisionImpact(
	decisions:    IDecisionLog,
	units:        Map<string, IKnowledgeUnit>,
	decisionId:   string,
	decisionType: IDecisionConflict['decisionType'],
): IDecisionImpactResult {

	let sourceIdentifier = '';
	let scopedUnitIds: string[] | undefined;

	if (decisionType === 'type-mapping') {
		const d = decisions.typeMapping.find(d => d.id === decisionId);
		if (d) { sourceIdentifier = d.sourceType; }
	} else if (decisionType === 'naming') {
		const d = decisions.naming.find(d => d.id === decisionId);
		if (d) { sourceIdentifier = d.sourceName; }
	} else if (decisionType === 'rule-interpretation') {
		const d = decisions.ruleInterpret.find(d => d.id === decisionId);
		if (d) { scopedUnitIds = d.appliesTo; }
	} else if (decisionType === 'pattern-override') {
		const d = decisions.patternOverrides.find(d => d.id === decisionId);
		if (d) { scopedUnitIds = d.appliesTo; }
	}

	const directlyAffected: string[] = [];
	const alreadyTranslated: string[] = [];
	const pendingUnits: string[] = [];

	if (scopedUnitIds) {
		// Scoped: only affects explicitly listed units
		for (const id of scopedUnitIds) {
			const unit = units.get(id);
			if (!unit) { continue; }
			directlyAffected.push(id);
			if (DONE_STATUSES.has(unit.status)) {
				alreadyTranslated.push(id);
			} else {
				pendingUnits.push(id);
			}
		}
	} else if (sourceIdentifier) {
		// Text-match: scan all unit source texts
		const lower = sourceIdentifier.toLowerCase();
		for (const unit of units.values()) {
			const src = (unit.resolvedSource ?? unit.sourceText ?? '').toLowerCase();
			if (!src.includes(lower)) { continue; }
			directlyAffected.push(unit.id);
			if (DONE_STATUSES.has(unit.status)) {
				alreadyTranslated.push(unit.id);
			} else {
				pendingUnits.push(unit.id);
			}
		}
	}

	return {
		decisionId,
		decisionType,
		directlyAffected,
		alreadyTranslated,
		pendingUnits,
		totalAffected: directlyAffected.length,
	};
}

// ─── Cycle detection ──────────────────────────────────────────────────────────

/**
 * Detect all strongly-connected components (cycles) in the unit dependency graph.
 * Uses Johnson's algorithm simplified to an iterative DFS for practical codebase sizes.
 *
 * @returns Arrays of unit IDs forming cycles. Empty array = clean DAG.
 */
export function findDependencyCycles(units: Map<string, IKnowledgeUnit>): string[][] {
	const cycles: string[][] = [];
	const visited  = new Set<string>();
	const recStack = new Set<string>();
	const path: string[] = [];

	function dfs(unitId: string): void {
		if (recStack.has(unitId)) {
			// Found a cycle — extract it from the current path
			const cycleStart = path.indexOf(unitId);
			if (cycleStart !== -1) {
				cycles.push([...path.slice(cycleStart), unitId]);
			}
			return;
		}
		if (visited.has(unitId)) { return; }

		visited.add(unitId);
		recStack.add(unitId);
		path.push(unitId);

		const unit = units.get(unitId);
		if (unit) {
			for (const depId of unit.dependsOn) {
				dfs(depId);
			}
		}

		path.pop();
		recStack.delete(unitId);
	}

	for (const unitId of units.keys()) {
		dfs(unitId);
	}

	return cycles;
}
