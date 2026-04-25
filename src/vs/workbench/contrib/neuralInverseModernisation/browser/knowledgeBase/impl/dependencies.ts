/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Dependency Engine
 *
 * Provides dependency graph traversal for the knowledge base:
 *   - Direct and transitive dependency lookup
 *   - Impact chain (which units break if this one changes)
 *   - Dependency tree (nested structure for UI)
 *   - Topological sort (dependency-first order for translation scheduling)
 *   - Translatable unit filter (units whose deps are all done)
 *   - Next unit selection (dependency-ordered + risk-ordered)
 *
 * All functions are pure \u2014 they take the KB's unit map as input.
 * No side effects, no DI.
 */

import { IKnowledgeUnit, UnitStatus, RiskLevel } from '../../../common/knowledgeBaseTypes.js';
import { IDependencyNode } from '../types.js';
import { DONE_STATUSES, RISK_ORDER } from './helpers.js';


// \u2500\u2500\u2500 Direct relationships \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function getDependencies(
	unitId: string,
	units: Map<string, IKnowledgeUnit>,
): IKnowledgeUnit[] {
	const unit = units.get(unitId);
	if (!unit) { return []; }
	return unit.dependsOn
		.map(id => units.get(id))
		.filter((u): u is IKnowledgeUnit => !!u);
}

export function getDependents(
	unitId: string,
	units: Map<string, IKnowledgeUnit>,
): IKnowledgeUnit[] {
	const unit = units.get(unitId);
	if (!unit) { return []; }
	return unit.usedBy
		.map(id => units.get(id))
		.filter((u): u is IKnowledgeUnit => !!u);
}


// \u2500\u2500\u2500 Transitive traversal \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Get all transitive dependencies of a unit (all ancestors in the dependency DAG).
 * Cycle-safe via visited set. Depth-first.
 */
export function getTransitiveDependencies(
	unitId: string,
	units: Map<string, IKnowledgeUnit>,
): IKnowledgeUnit[] {
	const visited = new Set<string>();
	const result: IKnowledgeUnit[] = [];

	const walk = (id: string) => {
		if (visited.has(id)) { return; }
		visited.add(id);
		const unit = units.get(id);
		if (!unit) { return; }
		for (const depId of unit.dependsOn) {
			walk(depId);
			const dep = units.get(depId);
			if (dep) { result.push(dep); }
		}
	};

	walk(unitId);
	return result;
}

/**
 * Get all units that would be affected if unitId changes (transitive reverse deps).
 * Cycle-safe. Breadth-first.
 */
export function getImpactChain(
	unitId: string,
	units: Map<string, IKnowledgeUnit>,
): IKnowledgeUnit[] {
	const visited = new Set<string>();
	const result: IKnowledgeUnit[] = [];

	const walk = (id: string) => {
		if (visited.has(id)) { return; }
		visited.add(id);
		const unit = units.get(id);
		if (!unit) { return; }
		for (const dependentId of unit.usedBy) {
			const dep = units.get(dependentId);
			if (dep && !visited.has(dependentId)) { result.push(dep); }
			walk(dependentId);
		}
	};

	walk(unitId);
	return result;
}


// \u2500\u2500\u2500 Dependency tree \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Build a nested dependency tree for a unit.
 * maxDepth prevents unbounded recursion on deep or cyclic graphs.
 */
export function getDependencyTree(
	unitId: string,
	units: Map<string, IKnowledgeUnit>,
	maxDepth = 10,
): IDependencyNode {
	const build = (id: string, depth: number, visited: Set<string>): IDependencyNode => {
		const unit = units.get(id);
		const status: UnitStatus = unit?.status ?? 'pending';
		const isTranslated = unit ? DONE_STATUSES.has(unit.status) : false;

		if (depth >= maxDepth || visited.has(id)) {
			return { unitId: id, depth, status, isTranslated, dependsOn: [] };
		}

		const next = new Set(visited);
		next.add(id);
		const children = (unit?.dependsOn ?? []).map(depId => build(depId, depth + 1, next));
		return { unitId: id, depth, status, isTranslated, dependsOn: children };
	};

	return build(unitId, 0, new Set());
}


// \u2500\u2500\u2500 Topological sort \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Return all units in topological order (dependency-first).
 * Units that must be translated before others come first.
 * Cycle-safe: units in a cycle are included after their non-cyclic ancestors.
 */
export function getTopologicalOrder(units: Map<string, IKnowledgeUnit>): IKnowledgeUnit[] {
	const visited = new Set<string>();
	const result: IKnowledgeUnit[] = [];

	const visit = (id: string) => {
		if (visited.has(id)) { return; }
		visited.add(id);
		const unit = units.get(id);
		if (!unit) { return; }
		for (const depId of unit.dependsOn) { visit(depId); }
		result.push(unit);
	};

	units.forEach(u => visit(u.id));
	return result;
}


// \u2500\u2500\u2500 Translatable units \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Units that are in 'ready' status AND all their dependencies are done.
 * These are the units an agent can start translating right now.
 */
export function getTranslatableUnits(units: Map<string, IKnowledgeUnit>): IKnowledgeUnit[] {
	const result: IKnowledgeUnit[] = [];
	units.forEach(unit => {
		if (unit.status !== 'ready') { return; }
		const allDepsDone = unit.dependsOn.every(depId => {
			const dep = units.get(depId);
			return !dep || DONE_STATUSES.has(dep.status);
		});
		if (allDepsDone) { result.push(unit); }
	});
	return result;
}

/**
 * Get unresolved dependency IDs: dependencies that have NOT yet been translated.
 * A unit with unblockedDependencies.length > 0 cannot be translated yet.
 */
export function getUnblockedDependencies(
	unit: IKnowledgeUnit,
	units: Map<string, IKnowledgeUnit>,
): string[] {
	return unit.dependsOn.filter(depId => {
		const dep = units.get(depId);
		return dep && !DONE_STATUSES.has(dep.status);
	});
}


// \u2500\u2500\u2500 Next unit selection \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Pick the best unit for an agent to work on next:
 *   1. Must be in 'ready' state with all deps done
 *   2. Filtered by optional riskLevel / domain / language
 *   3. Ordered by risk (critical first)
 */
export function getNextUnit(
	units: Map<string, IKnowledgeUnit>,
	domainIndex: Map<string, Set<string>>,
	options?: { riskLevel?: RiskLevel; domain?: string; language?: string },
): IKnowledgeUnit | undefined {
	return getTranslatableUnits(units)
		.filter(u => {
			if (options?.riskLevel && u.riskLevel !== options.riskLevel) { return false; }
			if (options?.language  && u.sourceLang !== options.language)  { return false; }
			if (options?.domain) {
				const inDomainIndex = domainIndex.get(options.domain)?.has(u.id) ?? false;
				const inBusinessRules = u.businessRules.some(r => r.domain === options.domain);
				if (!inDomainIndex && !inBusinessRules) { return false; }
			}
			return true;
		})
		.sort((a, b) => RISK_ORDER[a.riskLevel] - RISK_ORDER[b.riskLevel])[0];
}
