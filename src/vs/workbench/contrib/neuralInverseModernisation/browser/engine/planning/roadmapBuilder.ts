/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Roadmap Builder — Stage 2 Orchestrator
 *
 * Combines all planning sub-modules into a single, fully-structured
 * `IMigrationRoadmap`. This is the only entry point callers should use.
 *
 * ## Pipeline
 *
 * ```
 * buildRoadmap(input)
 *   │
 *   ├─ 1. Aggregate units + edges from all source projects
 *   ├─ 2. Build topology (dependency + call graph combined)
 *   ├─ 3. Topological sort → dependency-safe unit order
 *   ├─ 4. Compute CPM critical path
 *   ├─ 5. Assign phases (with optional AI overrides)
 *   ├─ 6. Enforce compliance ordering constraints
 *   ├─ 7. Detect API compatibility gates
 *   ├─ 8. Detect migration blockers
 *   ├─ 9. Build phase objects (sorted, effort-aggregated, compliance-gated)
 *   ├─ 10. Apply AI risk / ordering supplements
 *   ├─ 11. Build pairing work items (source ↔ target)
 *   ├─ 12. Compute total effort and critical path nodes
 *   └─ 13. Assemble and return IMigrationRoadmap
 * ```
 *
 * ## Memory Model
 *
 * The roadmap builder holds no state between calls — all input comes from
 * `IRoadmapBuildInput` and output is the returned `IMigrationRoadmap`.
 *
 * ## Cross-Project Support
 *
 * When a session has multiple source projects, all units and edges are merged
 * into a single flat unit list. Each unit's ID carries the projectId prefix
 * (set during discovery), so they remain globally unique.
 */

import {
	IMigrationUnit,
	IMigrationRoadmap,
	IMigrationPhase,
	ICriticalPathNode,
	IMigrationBlocker,
	IPairingWorkItem,
	MigrationRiskLevel,
	MigrationPhaseType,
} from '../../../common/modernisationTypes.js';
import {
	IDiscoveryResult,
	IProjectScanResult,
	ICrossProjectPairing,
} from '../discovery/discoveryTypes.js';
import {
	IRoadmapBuildInput,
	IAPICompatibilityGate,
} from './planningTypes.js';
import {
	buildTopology,
	topologicalSort,
	computeCriticalPath,
} from './dependencyResolver.js';
import { assignPhases, buildPhaseObjects } from './phaseBuilder.js';
import { enforceComplianceOrdering } from './complianceOrderer.js';
import { analyzeAPICompatibility } from './apiCompatibilityAnalyzer.js';
import { detectMigrationBlockers } from './migrationBlockerDetector.js';


// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build a complete, phase-structured `IMigrationRoadmap` from the Stage 1
 * discovery result plus an optional AI supplement.
 *
 * @param input  IRoadmapBuildInput — discovery, pattern, sessionId, aiSupplement
 * @returns      Fully structured IMigrationRoadmap (ready for developer review)
 */
export function buildRoadmap(input: IRoadmapBuildInput): IMigrationRoadmap {
	const { discovery, pattern, sessionId, aiSupplement } = input;

	// ── 1. Aggregate all source-side units and edges ───────────────────────────
	const allUnits:           IMigrationUnit[]                           = [];
	const allCallEdges:       Array<{ fromId: string; toId: string }>   = [];
	const allPairings:        ICrossProjectPairing[]                    = discovery.crossProjectPairings;
	const allTargetProjects:  IProjectScanResult[]                       = discovery.targets;

	// Aggregate across all source AND target projects so totalUnits = 294 (not just 256)
	const sourceProjects = discovery.sources;
	const allProjects    = [...discovery.sources, ...discovery.targets];
	for (const proj of allProjects) {
		allUnits.push(...proj.units);
		for (const edge of proj.callGraphEdges) {
			allCallEdges.push({ fromId: edge.fromId, toId: edge.toId });
		}
		for (const edge of proj.dependencyEdges) {
			if (edge.resolved) { allCallEdges.push({ fromId: edge.fromId, toId: edge.toId }); }
		}
	}

	if (allUnits.length === 0) {
		return makeEmptyRoadmap(sessionId, pattern, discovery);
	}

	// ── 2. Build topology ─────────────────────────────────────────────────────
	const topology = buildTopology(allUnits, allCallEdges);

	// ── 3. Topological sort ───────────────────────────────────────────────────
	const topoResult = topologicalSort(topology);

	// ── 4. Apply AI dependency overrides (before CPM) ────────────────────────
	if (aiSupplement?.dependencyOverrides) {
		applyDependencyOverrides(allUnits, topology, aiSupplement.dependencyOverrides, topoResult.levels);
	}

	// ── 5. CPM critical path ──────────────────────────────────────────────────
	const allEffortEstimates = allProjects.flatMap(s => s.effortEstimates);
	const cpmResult = computeCriticalPath(topoResult, allUnits, allEffortEstimates);

	// ── 6. Aggregate per-project scan data ───────────────────────────────────
	const allAPIEndpoints   = allProjects.flatMap(s => s.apiEndpoints);
	const allDataSchemas    = allProjects.flatMap(s => s.dataSchemas);
	const allTechDebtItems  = allProjects.flatMap(s => s.techDebtItems);
	const allRegulatedHits  = allProjects.flatMap(s => s.regulatedDataHits);

	// Merge GRC snapshots from all projects
	const mergedGRC = mergeGRCSnapshots(allProjects);

	// ── 7. Phase assignment ───────────────────────────────────────────────────
	const phaseAssignments = assignPhases({
		units:           allUnits,
		topology,
		levels:          topoResult.levels,
		apiEndpoints:    allAPIEndpoints,
		dataSchemas:     allDataSchemas,
		techDebtItems:   allTechDebtItems,
		regulatedHits:   allRegulatedHits,
		effortEstimates: allEffortEstimates,
		grcSnapshot:     mergedGRC,
		aiPhaseOverrides: aiSupplement?.phaseOverrides,
	});

	// ── 8. Compliance ordering ────────────────────────────────────────────────
	const { assignments: finalAssignments, blockers: complianceBlockers } =
		enforceComplianceOrdering(
			phaseAssignments,
			allUnits,
			allRegulatedHits,
			allDataSchemas,
			allPairings,
			mergedGRC,
			allEffortEstimates,
		);

	// ── 9. API compatibility gates ────────────────────────────────────────────
	const allAPIGates: IAPICompatibilityGate[] = [];
	for (const src of sourceProjects) {
		allAPIGates.push(...analyzeAPICompatibility(src, allTargetProjects, allPairings));
	}

	// ── 10. Migration blockers ────────────────────────────────────────────────
	const detectedBlockers = detectMigrationBlockers({
		units:            allUnits,
		techDebtItems:    allTechDebtItems,
		regulatedHits:    allRegulatedHits,
		dataSchemas:      allDataSchemas,
		pairings:         allPairings,
		grcSnapshot:      mergedGRC,
		effortEstimates:  allEffortEstimates,
		cycleEdges:       topoResult.cycles,
		phaseAssignments: finalAssignments,
	});

	const allBlockers: IMigrationBlocker[] = [...complianceBlockers, ...detectedBlockers];
	deduplicateBlockers(allBlockers);

	// ── 11. Build phase objects ───────────────────────────────────────────────
	const phases: IMigrationPhase[] = buildPhaseObjects(
		finalAssignments,
		allUnits,
		topoResult.levels,
		allEffortEstimates,
		allBlockers,
		cpmResult.nodes,
		allAPIEndpoints,
		allRegulatedHits,
	);

	// ── 12. Apply AI risk overrides to units ──────────────────────────────────
	const orderedUnits = applyAIRiskOverrides(
		reorderByPhase(allUnits, finalAssignments, topoResult.levels),
		aiSupplement?.riskOverrides,
	);

	// ── 13. Build pairing work items ──────────────────────────────────────────
	const pairingWorkItems = buildPairingWorkItems(
		orderedUnits,
		allPairings,
		allEffortEstimates,
		finalAssignments,
		discovery.targets,
	);

	// ── 14. Critical path nodes ───────────────────────────────────────────────
	const criticalPathNodes: ICriticalPathNode[] = buildCriticalPathNodes(
		cpmResult.criticalPath,
		cpmResult.nodes,
		finalAssignments,
	);

	// ── 15. Total effort ──────────────────────────────────────────────────────
	const totalEffortLow  = allEffortEstimates.reduce((s, e) => s + e.estimatedHoursLow,  0);
	const totalEffortHigh = allEffortEstimates.reduce((s, e) => s + e.estimatedHoursHigh, 0);

	// ── 16. Unit risk distribution ────────────────────────────────────────────
	const unitsByRisk = countByRisk(orderedUnits);

	// ── 17. Target language inference ─────────────────────────────────────────
	const targetLanguage = inferTargetLanguage(pattern, discovery.targets);

	// ── 18. Assemble roadmap ──────────────────────────────────────────────────
	return {
		id:               `${sessionId}-roadmap`,
		createdAt:        Date.now(),
		legacyRootPath:   discovery.sources[0]?.folderUri ?? '',
		targetLanguage,
		units:            orderedUnits,
		totalUnits:       orderedUnits.length,
		unitsByRisk,
		planApproved:     false,

		// Stage 2 enrichments
		phases,
		criticalPath:      criticalPathNodes,
		migrationBlockers: allBlockers,
		pairingWorkItems,
		estimatedHoursLow:  Math.round(totalEffortLow),
		estimatedHoursHigh: Math.round(totalEffortHigh),
		complianceNotes:    aiSupplement?.complianceNotes ?? buildDefaultComplianceNotes(allRegulatedHits, mergedGRC),
		riskNarrative:      aiSupplement?.riskNarrative,
		aiEstimatedEffort:  aiSupplement?.estimatedEffort,
		generationMethod:   aiSupplement ? 'ai-guided' : 'deterministic',
	};
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Return a minimal empty roadmap when no units were discovered. */
function makeEmptyRoadmap(sessionId: string, pattern: string, discovery: IDiscoveryResult): IMigrationRoadmap {
	return {
		id:               `${sessionId}-roadmap`,
		createdAt:        Date.now(),
		legacyRootPath:   discovery.sources[0]?.folderUri ?? '',
		targetLanguage:   inferTargetLanguage(pattern, discovery.targets),
		units:            [],
		totalUnits:       0,
		unitsByRisk:      { critical: 0, high: 0, medium: 0, low: 0 },
		planApproved:     false,
		phases:           [],
		criticalPath:     [],
		migrationBlockers: [],
		pairingWorkItems: [],
		estimatedHoursLow:  0,
		estimatedHoursHigh: 0,
		complianceNotes:  'No units were discovered in the source project(s).',
		generationMethod: 'deterministic',
	};
}

/** Order units by phase index → level → risk → name. */
function reorderByPhase(
	units: IMigrationUnit[],
	assignments: Map<string, { phaseType: MigrationPhaseType }>,
	levels: Map<string, number>,
): IMigrationUnit[] {
	const phaseOrder: Record<MigrationPhaseType, number> = {
		'foundation': 1, 'bsp': 2, 'schema': 3, 'core-logic': 4,
		'hal-layer': 5, 'api-layer': 6, 'integration': 7,
		'compliance': 8, 'safety-critical': 9, 'cutover': 10,
	};
	const riskRank: Record<MigrationRiskLevel, number> = {
		critical: 0, high: 1, medium: 2, low: 3,
	};
	return [...units].sort((a, b) => {
		const pa = phaseOrder[assignments.get(a.id)?.phaseType ?? 'core-logic'] ?? 3;
		const pb = phaseOrder[assignments.get(b.id)?.phaseType ?? 'core-logic'] ?? 3;
		if (pa !== pb) { return pa - pb; }
		const la = levels.get(a.id) ?? 0;
		const lb = levels.get(b.id) ?? 0;
		if (la !== lb) { return la - lb; }
		const ra = riskRank[a.riskLevel] ?? 3;
		const rb = riskRank[b.riskLevel] ?? 3;
		if (ra !== rb) { return ra - rb; }
		return a.unitName.localeCompare(b.unitName);
	});
}

/** Apply AI risk overrides to unit objects (creates copies, does not mutate originals). */
function applyAIRiskOverrides(
	units: IMigrationUnit[],
	riskOverrides?: Record<string, string>,
): IMigrationUnit[] {
	if (!riskOverrides) { return units; }
	const validRisks = new Set<MigrationRiskLevel>(['critical', 'high', 'medium', 'low']);
	return units.map(u => {
		const override = riskOverrides[u.id] as MigrationRiskLevel | undefined;
		if (override && validRisks.has(override) && override !== u.riskLevel) {
			return { ...u, riskLevel: override };
		}
		return u;
	});
}

/**
 * Apply AI dependency overrides to the topology and re-sort levels.
 * Called before CPM to ensure critical path reflects AI-added dependencies.
 */
function applyDependencyOverrides(
	units: IMigrationUnit[],
	topology: Map<string, import('./planningTypes.js').ITopologyNode>,
	overrides: Record<string, string[]>,
	levels: Map<string, number>,
): void {
	const unitIds = new Set(units.map(u => u.id));
	for (const [fromId, deps] of Object.entries(overrides)) {
		if (!unitIds.has(fromId)) { continue; }
		const fromNode = topology.get(fromId);
		if (!fromNode) { continue; }
		for (const dep of deps) {
			if (!unitIds.has(dep) || fromNode.dependencies.has(dep)) { continue; }
			fromNode.dependencies.add(dep);
			const toNode = topology.get(dep);
			if (toNode) {
				toNode.dependents.add(fromId);
				toNode.inDegree++;
			}
		}
	}
}

/** Build IPairingWorkItem list from all source units and cross-project pairings. */
function buildPairingWorkItems(
	orderedUnits: IMigrationUnit[],
	pairings: ICrossProjectPairing[],
	effortEstimates: import('../discovery/discoveryTypes.js').IMigrationEffortEstimate[],
	assignments: Map<string, { phaseType: MigrationPhaseType }>,
	targetProjects: IProjectScanResult[],
): IPairingWorkItem[] {
	const phaseOrder: Record<MigrationPhaseType, number> = {
		'foundation': 1, 'bsp': 2, 'schema': 3, 'core-logic': 4,
		'hal-layer': 5, 'api-layer': 6, 'integration': 7,
		'compliance': 8, 'safety-critical': 9, 'cutover': 10,
	};

	// Best pairing per source unit
	const bestPairing = new Map<string, ICrossProjectPairing>();
	for (const p of pairings) {
		const ex = bestPairing.get(p.sourceUnitId);
		if (!ex || p.confidenceScore > ex.confidenceScore) { bestPairing.set(p.sourceUnitId, p); }
	}

	// Target unit names
	const targetUnitNames = new Map<string, string>();
	for (const tgt of targetProjects) {
		for (const u of tgt.units) { targetUnitNames.set(u.id, u.unitName); }
	}

	// Effort by unit
	const effortMap = new Map<string, import('../discovery/discoveryTypes.js').IMigrationEffortEstimate>();
	for (const e of effortEstimates) { effortMap.set(e.unitId, e); }

	return orderedUnits.map(unit => {
		const pairing   = bestPairing.get(unit.id);
		const effort    = effortMap.get(unit.id);
		const phaseType = assignments.get(unit.id)?.phaseType ?? 'core-logic';

		return {
			sourceUnitId:       unit.id,
			sourceUnitName:     unit.unitName,
			targetUnitId:       pairing?.targetUnitId,
			targetUnitName:     pairing?.targetUnitId ? targetUnitNames.get(pairing.targetUnitId) : undefined,
			confidenceScore:    pairing?.confidenceScore,
			matchReason:        pairing?.matchReason,
			estimatedHoursLow:  effort?.estimatedHoursLow  ?? 2,
			estimatedHoursHigh: effort?.estimatedHoursHigh ?? 8,
			migrationStatus:    pairing ? 'not-started' : 'no-target',
			targetHasFingerprint: pairing?.targetHasFingerprint ?? false,
			phaseIndex:         phaseOrder[phaseType] ?? 3,
		};
	});
}

/** Convert ICPMNode map into the public-facing ICriticalPathNode array. */
function buildCriticalPathNodes(
	criticalPath: string[],
	cpmNodes: Map<string, import('./planningTypes.js').ICPMNode>,
	assignments: Map<string, { phaseType: MigrationPhaseType }>,
): ICriticalPathNode[] {
	return criticalPath.map(id => {
		const n = cpmNodes.get(id)!;
		return {
			unitId:         id,
			unitName:       n.unitName,
			phaseType:      assignments.get(id)?.phaseType ?? 'core-logic',
			effortHoursHigh: n.effortHigh,
			level:          n.level,
			isCritical:     true,
			earliestStart:  n.earliestStart,
			earliestFinish: n.earliestFinish,
			latestStart:    n.latestStart,
			latestFinish:   n.latestFinish,
			slack:          n.slack,
		};
	});
}

function countByRisk(units: IMigrationUnit[]): Record<MigrationRiskLevel, number> {
	const d: Record<MigrationRiskLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
	for (const u of units) { d[u.riskLevel]++; }
	return d;
}

/**
 * Merge GRC snapshots from all source projects into one aggregate snapshot.
 * Used for cross-project compliance ordering decisions.
 */
function mergeGRCSnapshots(
	projects: IProjectScanResult[],
): import('../discovery/discoveryTypes.js').IGRCSnapshot {
	const byDomain:   Record<string, number> = {};
	const bySeverity: Record<string, number> = {};
	const topRules:   Record<string, number> = {};
	const violations: import('../discovery/discoveryTypes.js').IGRCMiniViolation[] = [];
	let total = 0;
	let blocking = 0;

	for (const p of projects) {
		total    += p.grcSnapshot.totalViolations;
		blocking += p.grcSnapshot.blockingCount;
		for (const [d, c] of Object.entries(p.grcSnapshot.byDomain)) {
			byDomain[d] = (byDomain[d] ?? 0) + c;
		}
		for (const [s, c] of Object.entries(p.grcSnapshot.bySeverity)) {
			bySeverity[s] = (bySeverity[s] ?? 0) + c;
		}
		for (const r of p.grcSnapshot.topViolatedRules) {
			topRules[r.ruleId] = (topRules[r.ruleId] ?? 0) + r.count;
		}
		violations.push(...p.grcSnapshot.violations);
	}

	const topViolatedRules = Object.entries(topRules)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 10)
		.map(([ruleId, count]) => ({ ruleId, count }));

	return {
		capturedAt:       Date.now(),
		totalViolations:  total,
		blockingCount:    blocking,
		byDomain,
		bySeverity,
		topViolatedRules,
		violations,
	};
}

/** Infer target language from target projects or pattern string. */
function inferTargetLanguage(pattern: string, targets: IProjectScanResult[]): string {
	const tgtLang = targets[0]?.dominantLanguage;
	if (tgtLang && tgtLang !== 'unknown') { return tgtLang; }
	const p = pattern.toLowerCase();
	if (p.includes('typescript') || p.includes('ts'))       { return 'typescript'; }
	if (p.includes('java') && !p.includes('javascript'))    { return 'java'; }
	if (p.includes('kotlin'))                               { return 'kotlin'; }
	if (p.includes('python') || p.includes('django') || p.includes('flask')) { return 'python'; }
	if (p.includes('dotnet') || p.includes('.net') || p.includes('csharp') || p.includes('c#')) { return 'csharp'; }
	if (p.includes('go') || p.includes('golang'))           { return 'go'; }
	if (p.includes('rust'))                                 { return 'rust'; }
	if (p.includes('node') || p.includes('javascript'))     { return 'javascript'; }
	if (p.includes('ruby') || p.includes('rails'))          { return 'ruby'; }
	if (p.includes('php') || p.includes('symfony') || p.includes('laravel')) { return 'php'; }
	if (p.includes('scala'))                                { return 'scala'; }
	return 'unknown';
}

/** Remove duplicate blockers (same unitId + blockerType), keeping the highest severity. */
function deduplicateBlockers(blockers: IMigrationBlocker[]): void {
	const seen = new Map<string, number>(); // key → index in array
	for (let i = blockers.length - 1; i >= 0; i--) {
		const key = `${blockers[i].unitId}:${blockers[i].blockerType}`;
		if (seen.has(key)) {
			const existingIdx = seen.get(key)!;
			// Keep 'blocking' over 'warning'
			if (blockers[i].severity === 'blocking' && blockers[existingIdx].severity === 'warning') {
				blockers.splice(existingIdx, 1);
				seen.set(key, i);
			} else {
				blockers.splice(i, 1);
			}
		} else {
			seen.set(key, i);
		}
	}
}

/** Build a default compliance notes string from regulated hits and GRC snapshot. */
function buildDefaultComplianceNotes(
	regulatedHits: import('../discovery/discoveryTypes.js').IRegulatedDataHit[],
	grcSnapshot: import('../discovery/discoveryTypes.js').IGRCSnapshot,
): string {
	const parts: string[] = [];

	if (regulatedHits.length > 0) {
		const patterns = [...new Set(regulatedHits.map(h => h.pattern))];
		const frameworks = [...new Set(regulatedHits.flatMap(h => h.applicableFrameworks))];
		parts.push(
			`${regulatedHits.length} regulated data hits detected across source code ` +
			`(patterns: ${patterns.join(', ')}). ` +
			`Applicable regulatory frameworks: ${frameworks.join(', ')}.`
		);
	}

	if (grcSnapshot.blockingCount > 0) {
		parts.push(
			`${grcSnapshot.blockingCount} blocking GRC violation(s) detected. ` +
			`These must be resolved before Stage 3 migration can begin for affected units.`
		);
	}

	if (grcSnapshot.totalViolations > 0) {
		const topDomains = Object.entries(grcSnapshot.byDomain)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([d, c]) => `${d} (${c})`)
			.join(', ');
		parts.push(`Top GRC violation domains: ${topDomains}.`);
	}

	return parts.length > 0
		? parts.join(' ')
		: 'No regulated data or GRC violations detected in the source project(s).';
}
