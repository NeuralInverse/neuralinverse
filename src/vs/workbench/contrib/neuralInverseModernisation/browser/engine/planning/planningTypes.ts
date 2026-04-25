/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Planning Types \u2014 Stage 2 Internal
 *
 * Internal types used exclusively by the planning pipeline modules.
 * Public-facing types (IMigrationPhase, ICriticalPathNode, IMigrationBlocker,
 * IPairingWorkItem) live in `common/modernisationTypes.ts` so the UI layer can
 * import them from a single source.
 *
 * ## Module layout
 *
 * ```
 *  engine/planning/
 *    planningTypes.ts          \u2190 this file (shared internal types)
 *    dependencyResolver.ts     \u2190 topological sort, CPM critical path, cycle detection
 *    phaseBuilder.ts           \u2190 assigns each unit to a MigrationPhaseType
 *    complianceOrderer.ts      \u2190 enforces compliance ordering constraints
 *    apiCompatibilityAnalyzer.ts \u2190 detects API backward-compat gates
 *    migrationBlockerDetector.ts \u2190 surfaces migration-blocking issues
 *    roadmapBuilder.ts         \u2190 orchestrates all of the above \u2192 IMigrationRoadmap
 * ```
 */

import { MigrationPhaseType, MigrationRiskLevel } from '../../../common/modernisationTypes.js';
import { IDiscoveryResult } from '../discovery/discoveryTypes.js';
import { APIEndpointKind } from '../discovery/discoveryTypes.js';


// \u2500\u2500\u2500 Roadmap Build Input \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IRoadmapBuildInput {
	/** Full Stage 1 discovery result (both sides). */
	discovery: IDiscoveryResult;
	/** The migration pattern ID or free-form string (e.g. 'cobol-to-typescript'). */
	pattern: string;
	/** Session ID \u2014 used as roadmap ID prefix. */
	sessionId: string;
	/** Optional AI supplement from the LLM call. Applied on top of the deterministic plan. */
	aiSupplement?: IAISupplement;
}


// \u2500\u2500\u2500 AI Supplement \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Structured data extracted from the LLM's roadmap response.
 * Each field is optional \u2014 missing fields fall back to deterministic values.
 */
export interface IAISupplement {
	/** Per-unit phase type overrides: unitId \u2192 MigrationPhaseType */
	phaseOverrides?: Record<string, MigrationPhaseType>;
	/** Per-unit risk level overrides: unitId \u2192 MigrationRiskLevel */
	riskOverrides?: Record<string, MigrationRiskLevel>;
	/** AI-preferred unit ordering within each phase: phase \u2192 ordered unitIds */
	phaseUnitOrdering?: Record<MigrationPhaseType, string[]>;
	/** AI-generated compliance narrative for the whole roadmap. */
	complianceNotes?: string;
	/** AI-generated risk narrative. */
	riskNarrative?: string;
	/** AI overall effort assessment. */
	estimatedEffort?: 'low' | 'medium' | 'high';
	/** AI-identified additional dependencies: unitId \u2192 dependencies[] */
	dependencyOverrides?: Record<string, string[]>;
	/** AI-identified blockers: unitId \u2192 description */
	additionalBlockers?: Array<{ unitId: string; description: string; severity: 'warning' | 'blocking' }>;
}


// \u2500\u2500\u2500 Phase Assignment \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** The result of assigning a single unit to a phase. */
export interface IUnitPhaseAssignment {
	unitId: string;
	phaseType: MigrationPhaseType;
	/** Human-readable reasons why this unit was assigned to this phase. */
	reasons: string[];
	/** Whether the assignment was provided by an AI override. */
	aiOverride: boolean;
}


// \u2500\u2500\u2500 Topology Node \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * A node in the dependency/call topology graph.
 * Built by dependencyResolver.buildTopology() from IMigrationUnit.dependencies
 * and call graph edges.
 */
export interface ITopologyNode {
	unitId: string;
	unitName: string;
	/** Dependency depth level (0 = no deps, higher = deeper in DAG). */
	level: number;
	/** Unit IDs this unit depends on (must be migrated before this). */
	dependencies: Set<string>;
	/** Unit IDs that depend on this unit (this must be migrated before them). */
	dependents: Set<string>;
	/** In-degree count (number of units that depend on this one). */
	inDegree: number;
	/** Whether this node had an incoming edge removed to break a cycle. */
	isCycleBreak: boolean;
}


// \u2500\u2500\u2500 Topological Sort Result \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface ICycleEdge {
	fromId: string;
	toId: string;
}

export interface ITopoResult {
	/** Unit IDs in dependency-safe topological order. */
	order: string[];
	/** The full topology map with levels populated. */
	nodes: Map<string, ITopologyNode>;
	/** Cycle-breaking edges that were removed to produce a valid DAG. */
	cycles: ICycleEdge[];
	/** unitId \u2192 dependency depth level (0 = root). */
	levels: Map<string, number>;
}


// \u2500\u2500\u2500 CPM Node \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * A unit's CPM (Critical Path Method) timing data.
 * Produced by dependencyResolver.computeCriticalPath().
 */
export interface ICPMNode {
	unitId: string;
	unitName: string;
	effortHigh: number;
	level: number;
	isCritical: boolean;
	earliestStart: number;
	earliestFinish: number;
	latestStart: number;
	latestFinish: number;
	slack: number;
}

export interface ICPMResult {
	nodes: Map<string, ICPMNode>;
	criticalPath: string[];
	projectDuration: number;
}


// \u2500\u2500\u2500 API Compatibility Gate \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Risk assessment for a public API entry point that must be preserved
 * (or carefully adapted) during migration.
 *
 * Lives here (browser-layer) rather than modernisationTypes (common-layer)
 * because it references APIEndpointKind from discoveryTypes (browser-layer).
 */
export interface IAPICompatibilityGate {
	/** Source-side unit ID that exposes this API. */
	unitId: string;
	endpointKind: APIEndpointKind;
	path?: string;
	httpMethod?: string;
	operationName?: string;
	txCode?: string;
	/** Corresponding target unit ID from cross-project pairing (if found). */
	targetUnitId?: string;
	/** Whether a target-side equivalent was found via cross-project pairing. */
	hasTargetEquivalent: boolean;
	/** Compatibility risk level. */
	compatibilityRisk: 'low' | 'medium' | 'high';
	/** Whether the API signature appears to have changed between source and target. */
	signatureChanged: boolean;
	/** Human-readable compatibility notes for the developer. */
	notes: string;
}


// \u2500\u2500\u2500 Impact Scores \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** How many units transitively depend on a given unit (downstream impact). */
export type IImpactScoreMap = Map<string, number>;


// \u2500\u2500\u2500 Phase Builder Input \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

import {
	IAPIEndpoint,
	IDataSchema,
	ITechDebtItem,
	IRegulatedDataHit,
	IMigrationEffortEstimate,
	IGRCSnapshot,
} from '../discovery/discoveryTypes.js';

export interface IPhaseBuilderInput {
	units: import('../../../common/modernisationTypes.js').IMigrationUnit[];
	topology: Map<string, ITopologyNode>;
	levels: Map<string, number>;
	apiEndpoints:    IAPIEndpoint[];
	dataSchemas:     IDataSchema[];
	techDebtItems:   ITechDebtItem[];
	regulatedHits:   IRegulatedDataHit[];
	effortEstimates: IMigrationEffortEstimate[];
	grcSnapshot:     IGRCSnapshot;
	/** Optional AI phase overrides: unitId \u2192 MigrationPhaseType */
	aiPhaseOverrides?: Record<string, MigrationPhaseType>;
}
