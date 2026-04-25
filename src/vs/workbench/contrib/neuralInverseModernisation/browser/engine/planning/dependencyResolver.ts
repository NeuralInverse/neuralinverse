/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Dependency Resolver
 *
 * Provides graph algorithms over the unit dependency + call graph:
 *
 * 1. **Topology Builder** \u2014 converts IMigrationUnit.dependencies + call graph
 *    edges into a mutable adjacency-set graph (ITopologyNode per unit).
 *
 * 2. **Topological Sort** (Kahn's algorithm) \u2014 produces a dependency-safe
 *    execution order. Detects cycles and breaks them deterministically.
 *
 * 3. **Level Assignment** (BFS) \u2014 computes the dependency depth of each unit.
 *    Level 0 = no dependencies. Level N = deepest predecessor is at level N-1.
 *    Used by the phase builder to order units within a phase.
 *
 * 4. **Critical Path Method (CPM)** \u2014 forward + backward passes over the DAG
 *    to compute ES/EF/LS/LF and float (slack) for each unit. Units with zero
 *    slack are on the critical path and control the overall project duration.
 *
 * 5. **Impact Score** \u2014 counts the number of transitively downstream units for
 *    each node. High impact = many units blocked on this one.
 *
 * ## Complexity
 *
 * All algorithms are O(V + E) where V = unit count, E = edge count.
 * Cycle breaking is O(V²) worst-case but only runs when cycles exist.
 */

import { IMigrationUnit, MigrationRiskLevel } from '../../../common/modernisationTypes.js';
import { IMigrationEffortEstimate } from '../discovery/discoveryTypes.js';
import {
	ITopologyNode,
	ICycleEdge,
	ITopoResult,
	ICPMNode,
	ICPMResult,
} from './planningTypes.js';


// \u2500\u2500\u2500 Effort fallback by risk level (hours) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const RISK_EFFORT_FALLBACK: Record<MigrationRiskLevel, number> = {
	critical: 40,
	high:     16,
	medium:   8,
	low:      2,
};


// \u2500\u2500\u2500 Topology Builder \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Build the topology graph from a set of units.
 *
 * @param units       All units from the source project
 * @param extraEdges  Additional edges from call graph / explicit dependency edges
 */
export function buildTopology(
	units: IMigrationUnit[],
	extraEdges?: Array<{ fromId: string; toId: string }>,
): Map<string, ITopologyNode> {
	const nodes = new Map<string, ITopologyNode>();

	// Initialise one node per unit
	for (const u of units) {
		nodes.set(u.id, {
			unitId:      u.id,
			unitName:    u.unitName,
			level:       0,
			dependencies: new Set<string>(),
			dependents:   new Set<string>(),
			inDegree:    0,
			isCycleBreak: false,
		});
	}

	const addEdge = (fromId: string, toId: string): void => {
		if (fromId === toId) { return; }
		const from = nodes.get(fromId);
		const to   = nodes.get(toId);
		if (!from || !to) { return; }
		if (!from.dependencies.has(toId)) {
			from.dependencies.add(toId);
			to.dependents.add(fromId);
			to.inDegree++;
		}
	};

	// Edges from IMigrationUnit.dependencies (populated by discovery dep-graph)
	for (const u of units) {
		for (const dep of u.dependencies) {
			addEdge(u.id, dep);
		}
	}

	// Extra edges (call graph, explicit dep edges passed by the planner)
	for (const e of (extraEdges ?? [])) {
		addEdge(e.fromId, e.toId);
	}

	return nodes;
}


// \u2500\u2500\u2500 Topological Sort (Kahn's Algorithm) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Produce a topological ordering of units, detecting and breaking any cycles.
 *
 * Cycle-breaking strategy: when no zero-in-degree node is available, the node
 * with the highest in-degree (most dependents) among remaining nodes is chosen
 * as the cycle participant. The predecessor with the highest in-degree is
 * removed to unblock the graph. This heuristic minimises disruption to the
 * majority of the dependency tree.
 */
export function topologicalSort(topology: Map<string, ITopologyNode>): ITopoResult {
	// Working copy of in-degrees (do NOT mutate the topology inDegree)
	const inDeg = new Map<string, number>();
	for (const [id, n] of topology) { inDeg.set(id, n.inDegree); }

	const order:     string[]     = [];
	const cycles:    ICycleEdge[] = [];
	const remaining: Set<string>  = new Set(topology.keys());

	while (remaining.size > 0) {
		// Collect all zero-in-degree nodes
		const queue: string[] = [];
		for (const id of remaining) {
			if ((inDeg.get(id) ?? 0) === 0) { queue.push(id); }
		}

		if (queue.length === 0) {
			// \u2500\u2500 Cycle detected \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			// Pick the node with the highest current in-degree from remaining
			let breakTarget = '';
			let maxDeg = -1;
			for (const id of remaining) {
				const deg = inDeg.get(id) ?? 0;
				if (deg > maxDeg) { maxDeg = deg; breakTarget = id; }
			}

			const targetNode = topology.get(breakTarget)!;

			// Find a predecessor that is also in remaining
			let breakFrom = '';
			let breakFromDeg = -1;
			for (const pred of targetNode.dependents) {
				if (remaining.has(pred)) {
					const deg = inDeg.get(pred) ?? 0;
					if (deg > breakFromDeg) { breakFromDeg = deg; breakFrom = pred; }
				}
			}

			if (breakFrom) {
				// Remove the cycle-breaking edge
				cycles.push({ fromId: breakFrom, toId: breakTarget });
				const fromNode = topology.get(breakFrom)!;
				fromNode.dependencies.delete(breakTarget);
				targetNode.dependents.delete(breakFrom);
				targetNode.isCycleBreak = true;
				inDeg.set(breakTarget, Math.max(0, (inDeg.get(breakTarget) ?? 1) - 1));
			} else {
				// No predecessor found in remaining \u2014 force-emit the node to avoid infinite loop
				inDeg.set(breakTarget, 0);
			}
			continue;
		}

		// Sort for determinism: by unitName lexicographically
		queue.sort((a, b) =>
			(topology.get(a)?.unitName ?? '').localeCompare(topology.get(b)?.unitName ?? '')
		);

		for (const id of queue) {
			order.push(id);
			remaining.delete(id);
			const node = topology.get(id)!;
			// Reduce in-degree of all units that depend on this one
			for (const dependent of node.dependents) {
				if (remaining.has(dependent)) {
					inDeg.set(dependent, (inDeg.get(dependent) ?? 1) - 1);
				}
			}
		}
	}

	const levels = computeLevels(topology, order);
	return { order, nodes: topology, cycles, levels };
}


// \u2500\u2500\u2500 Level Assignment \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Assign a dependency depth level to each unit using the topological order.
 * Level = max(level of all dependencies) + 1.  Root nodes (no deps) = 0.
 *
 * Also writes `level` back onto each ITopologyNode for convenience.
 */
export function computeLevels(
	topology: Map<string, ITopologyNode>,
	topoOrder: string[],
): Map<string, number> {
	const levels = new Map<string, number>();

	for (const id of topoOrder) {
		const node = topology.get(id)!;
		let maxDepLevel = -1;
		for (const dep of node.dependencies) {
			maxDepLevel = Math.max(maxDepLevel, levels.get(dep) ?? 0);
		}
		const level = maxDepLevel + 1;
		levels.set(id, level);
		node.level = level;
	}

	return levels;
}


// \u2500\u2500\u2500 Critical Path Method (CPM) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Compute forward and backward passes over the DAG to determine:
 *  - Earliest Start (ES) / Earliest Finish (EF) \u2014 forward pass
 *  - Latest Start  (LS) / Latest Finish  (LF) \u2014 backward pass
 *  - Total Float (slack) = LS \u2212 ES
 *  - Critical path = units where slack \u2248 0
 *
 * Uses the effort estimate high-bound as the task duration (pessimistic estimate
 * for a conservative project schedule).
 */
export function computeCriticalPath(
	topoResult: ITopoResult,
	units: IMigrationUnit[],
	effortEstimates: IMigrationEffortEstimate[],
): ICPMResult {
	const unitMap   = new Map(units.map(u => [u.id, u]));
	const effortMap = new Map<string, number>();
	for (const e of effortEstimates) {
		effortMap.set(e.unitId, e.estimatedHoursHigh);
	}

	const { order, nodes, levels } = topoResult;
	const cpmNodes = new Map<string, ICPMNode>();

	// \u2500\u2500 Initialise \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	for (const id of order) {
		const u      = unitMap.get(id);
		const effort = effortMap.get(id) ?? RISK_EFFORT_FALLBACK[u?.riskLevel ?? 'low'];
		cpmNodes.set(id, {
			unitId:         id,
			unitName:       u?.unitName ?? id,
			effortHigh:     effort,
			level:          levels.get(id) ?? 0,
			isCritical:     false,
			earliestStart:  0,
			earliestFinish: effort,
			latestStart:    0,
			latestFinish:   effort,
			slack:          0,
		});
	}

	// \u2500\u2500 Forward Pass: ES(n) = max(EF(all predecessors)) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	for (const id of order) {
		const node     = cpmNodes.get(id)!;
		const topoNode = nodes.get(id)!;
		let maxPredEF  = 0;
		for (const dep of topoNode.dependencies) {
			const depCpm = cpmNodes.get(dep);
			if (depCpm) { maxPredEF = Math.max(maxPredEF, depCpm.earliestFinish); }
		}
		node.earliestStart  = maxPredEF;
		node.earliestFinish = maxPredEF + node.effortHigh;
	}

	// Project duration = max EF across all nodes
	let projectDuration = 0;
	for (const n of cpmNodes.values()) {
		projectDuration = Math.max(projectDuration, n.earliestFinish);
	}

	// \u2500\u2500 Backward Pass: LF(n) = min(LS(all successors)) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const reverseOrder = [...order].reverse();
	for (const id of reverseOrder) {
		const node     = cpmNodes.get(id)!;
		const topoNode = nodes.get(id)!;
		let minSuccLS  = projectDuration;
		for (const succ of topoNode.dependents) {
			const succCpm = cpmNodes.get(succ);
			if (succCpm) { minSuccLS = Math.min(minSuccLS, succCpm.latestStart); }
		}
		node.latestFinish = minSuccLS;
		node.latestStart  = minSuccLS - node.effortHigh;
		node.slack        = node.latestStart - node.earliestStart;
	}

	// \u2500\u2500 Identify Critical Path (slack \u2248 0) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const criticalPath: string[] = [];
	for (const [id, node] of cpmNodes) {
		if (Math.abs(node.slack) < 0.001) {
			node.isCritical = true;
			criticalPath.push(id);
		}
	}

	return { nodes: cpmNodes, criticalPath, projectDuration };
}


// \u2500\u2500\u2500 Impact Score \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Compute the transitive downstream impact count for each unit.
 * Impact = number of units that transitively depend on this unit.
 * High impact units should be prioritised and validated thoroughly.
 */
export function computeImpactScores(
	topology: Map<string, ITopologyNode>,
): Map<string, number> {
	const scores = new Map<string, number>();

	const countDownstream = (id: string, visited: Set<string>): number => {
		if (visited.has(id)) { return 0; }
		visited.add(id);
		const node = topology.get(id);
		if (!node) { return 0; }
		let count = 0;
		for (const dep of node.dependents) {
			count += 1 + countDownstream(dep, visited);
		}
		return count;
	};

	for (const id of topology.keys()) {
		scores.set(id, countDownstream(id, new Set()));
	}

	return scores;
}
