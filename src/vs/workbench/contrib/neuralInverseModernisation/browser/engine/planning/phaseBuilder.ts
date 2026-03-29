/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Phase Builder
 *
 * Assigns each migration unit to one of seven migration phases based on a
 * priority cascade of structural, API, data, compliance, and heuristic signals.
 *
 * ## Phase Assignment Priority (highest wins)
 *
 * | Priority | Signal                                        | Phase         |
 * |----------|-----------------------------------------------|---------------|
 * | 1        | AI override in IAISupplement.phaseOverrides   | (AI-chosen)   |
 * | 2        | Regulated data hit OR hardcoded credential    | compliance    |
 * | 3        | Blocking GRC violation on critical unit       | compliance    |
 * | 4        | Has data schema definition (table/FD/entity)  | schema        |
 * | 5        | Level 0, has dependents, not an API           | foundation    |
 * | 6        | Exposes MQ / batch / event handler endpoint   | integration   |
 * | 7        | Exposes REST / CICS / gRPC / GraphQL endpoint | api-layer     |
 * | 8        | Level ≥ 3, no dependents (top-level entry)    | cutover       |
 * | 9        | (default)                                     | core-logic    |
 *
 * ## Within-Phase Ordering
 *
 * Units within a phase are sorted:
 *  1. By dependency level (ascending) — shallower deps migrate first
 *  2. By risk level (descending) — critical units migrated before low-risk
 *  3. By unit name (lexicographic) — deterministic tiebreaker
 *
 * ## Phase Effort & Risk Aggregation
 *
 * Each IMigrationPhase carries:
 *  - `estimatedHoursLow` / `estimatedHoursHigh` — summed from effort estimates
 *  - `riskDistribution` — count per risk level
 *  - `hasComplianceGate` — true if any unit has regulated data
 *  - `hasAPICompatibilityGate` — true if any unit exposes an API endpoint
 *  - `blockerCount` — migration blockers targeting this phase
 *  - `complianceNotes` — heuristic compliance text
 */

import {
	IMigrationUnit,
	MigrationRiskLevel,
	MigrationPhaseType,
	IMigrationPhase,
	IMigrationBlocker,
} from '../../../common/modernisationTypes.js';
import {
	IAPIEndpoint,
	IRegulatedDataHit,
	IMigrationEffortEstimate,
} from '../discovery/discoveryTypes.js';
import {
	ICPMNode,
	IUnitPhaseAssignment,
	IPhaseBuilderInput,
} from './planningTypes.js';
/** Inline: normalize severity string to 'error' | 'warning' | 'info'. */
const toDisplaySeverity = (s?: string): 'error' | 'warning' | 'info' => {
	const l = (s ?? '').toLowerCase();
	if (l === 'error' || l === 'critical' || l === 'blocker') { return 'error'; }
	if (l === 'warning' || l === 'warn') { return 'warning'; }
	return 'info';
};


// ─── Phase Metadata ────────────────────────────────────────────────────────────

/** Processing order: lower number = earlier phase. */
const PHASE_ORDER: Record<MigrationPhaseType, number> = {
	'foundation':  1,
	'schema':      2,
	'core-logic':  3,
	'api-layer':   4,
	'integration': 5,
	'compliance':  6,
	'cutover':     7,
};

const PHASE_LABELS: Record<MigrationPhaseType, string> = {
	'foundation':  'Foundation & Utilities',
	'schema':      'Data Schemas & Models',
	'core-logic':  'Core Business Logic',
	'api-layer':   'API Layer & Entry Points',
	'integration': 'Integrations & Messaging',
	'compliance':  'Compliance-Critical Units',
	'cutover':     'Cutover & Orchestration',
};

const PHASE_DESCRIPTIONS: Record<MigrationPhaseType, string> = {
	'foundation':
		'Shared utilities, helper routines, and base types with no external dependencies. ' +
		'Migrate first to unblock all other phases.',
	'schema':
		'Data model definitions: database tables, COBOL File Descriptions, JPA entities, ORM models. ' +
		'Must be migrated before business logic to ensure data contract compatibility.',
	'core-logic':
		'Core business logic units — the bulk of the migration effort. ' +
		'All foundation and schema dependencies must be satisfied before starting this phase.',
	'api-layer':
		'Public-facing API entry points: REST endpoints, CICS transactions, gRPC services, GraphQL resolvers. ' +
		'Require backward-compatibility testing and staging validation before cutover.',
	'integration':
		'Units that interact with external systems: message queue listeners, batch schedulers, ' +
		'external service call adapters, file I/O orchestrators.',
	'compliance':
		'Units containing PII/PCI/PHI regulated data or blocking GRC violations. ' +
		'A compliance officer sign-off is mandatory before this phase can proceed.',
	'cutover':
		'Top-level entry programs and session orchestrators that tie everything together. ' +
		'Migrate last — every dependency must be fully validated and approved first.',
};

/** API endpoint kinds that classify a unit as 'integration' rather than 'api-layer'. */
const INTEGRATION_KINDS = new Set<string>([
	'mq-listener', 'batch-entry', 'event-handler',
]);

/** Risk ordering for intra-phase sort (lower index = migrated first). */
const RISK_RANK: Record<MigrationRiskLevel, number> = {
	critical: 0, high: 1, medium: 2, low: 3,
};


// ─── Phase Assignment ─────────────────────────────────────────────────────────

/**
 * Assign each unit to a migration phase using the priority cascade.
 * Returns a map of unitId → IUnitPhaseAssignment.
 */
export function assignPhases(input: IPhaseBuilderInput): Map<string, IUnitPhaseAssignment> {
	const {
		units, topology, levels,
		apiEndpoints, dataSchemas, techDebtItems, regulatedHits, effortEstimates,
		grcSnapshot, aiPhaseOverrides,
	} = input;

	// ── Pre-index lookup sets ──────────────────────────────────────────────────
	const unitApiMap = buildApiKindMap(apiEndpoints);
	const unitHasSchema       = new Set(dataSchemas.map(s => s.unitId));
	const unitHasRegulated    = new Set(regulatedHits.map(r => r.unitId));
	const unitHasCred         = new Set(
		techDebtItems.filter(t => t.category === 'hardcoded-credential').map(t => t.unitId),
	);
	const unitIsGodUnit       = new Set(
		techDebtItems.filter(t => t.category === 'god-unit').map(t => t.unitId),
	);
	const unitIsXLarge        = new Set(
		effortEstimates.filter(e => e.effortBand === 'xlarge').map(e => e.unitId),
	);
	// Derive blocking-GRC-affected unit IDs from file URIs in violations.
	// Uses toDisplaySeverity() from the Checks engine so custom framework
	// severities ('blocker', 'critical', etc.) resolve correctly.
	const blockingFileUris    = new Set(
		grcSnapshot.violations
			.filter(v => toDisplaySeverity(v.severity) === 'error')
			.map(v => v.fileUri),
	);

	const assignments = new Map<string, IUnitPhaseAssignment>();

	for (const unit of units) {
		const id      = unit.id;
		const node    = topology.get(id);
		const level   = levels.get(id) ?? 0;
		const reasons: string[] = [];
		let phase: MigrationPhaseType;

		// 1. AI override
		if (aiPhaseOverrides?.[id]) {
			phase = aiPhaseOverrides[id];
			assignments.set(id, { unitId: id, phaseType: phase, reasons: ['AI override'], aiOverride: true });
			continue;
		}

		// 2. Compliance: regulated data
		if (unitHasRegulated.has(id)) {
			phase = 'compliance';
			reasons.push('Contains regulated data (PII / PCI-DSS / PHI)');
		}
		// 2b. Compliance: hardcoded credentials
		else if (unitHasCred.has(id)) {
			phase = 'compliance';
			reasons.push('Contains hardcoded credentials — must be externalised before migration');
		}
		// 3. Compliance: blocking GRC + critical risk
		else if (blockingFileUris.has(unit.legacyFilePath) && unit.riskLevel === 'critical') {
			phase = 'compliance';
			reasons.push('Blocking GRC violation on a critical-risk unit');
		}
		// 4. Schema: data model definitions
		else if (unitHasSchema.has(id)) {
			phase = 'schema';
			reasons.push('Contains data schema definition (table / FD / entity / model)');
		}
		// 5. Foundation: level-0 root nodes with dependents (true shared utilities)
		else if (level === 0 && node && node.dependents.size >= 2 && !unitApiMap.has(id)) {
			phase = 'foundation';
			reasons.push(`Shared utility — level-0 root depended on by ${node.dependents.size} units`);
		}
		// 6. Integration: MQ / batch / event handlers
		else if (unitApiMap.has(id) && isIntegrationUnit(unitApiMap.get(id)!)) {
			phase = 'integration';
			reasons.push(`Exposes ${unitApiMap.get(id)!.join(', ')} integration endpoint`);
		}
		// 7. API layer: public-facing REST / CICS / gRPC / GraphQL
		else if (unitApiMap.has(id)) {
			phase = 'api-layer';
			reasons.push(`Exposes ${unitApiMap.get(id)!.join(', ')} public API endpoint`);
		}
		// 8. Cutover: top-level orchestrators (no callers, deep level)
		else if (node && node.dependents.size === 0 && level >= 3) {
			phase = 'cutover';
			reasons.push(`Top-level entry point at level ${level} with no downstream dependents`);
		}
		// 9. Default: core-logic
		else {
			phase = 'core-logic';
			reasons.push('Core business logic unit');
			if (level > 0) { reasons.push(`Dependency level: ${level}`); }
		}

		// Annotations
		if (unit.riskLevel === 'critical') { reasons.push('Critical risk'); }
		if (unit.riskLevel === 'high')     { reasons.push('High risk'); }
		if (unitIsGodUnit.has(id))         { reasons.push('God unit — consider splitting before migration'); }
		if (unitIsXLarge.has(id))          { reasons.push('XLarge effort — requires dedicated sprint'); }

		assignments.set(id, { unitId: id, phaseType: phase, reasons, aiOverride: false });
	}

	return assignments;
}


// ─── Phase Object Builder ─────────────────────────────────────────────────────

/**
 * Convert phase assignments into sorted IMigrationPhase objects.
 * Phases are ordered by PHASE_ORDER; units within each phase are sorted by
 * dependency level → risk rank → name.
 */
export function buildPhaseObjects(
	assignments:     Map<string, IUnitPhaseAssignment>,
	units:           IMigrationUnit[],
	levels:          Map<string, number>,
	effortEstimates: IMigrationEffortEstimate[],
	blockers:        IMigrationBlocker[],
	cpmNodes:        Map<string, ICPMNode>,
	apiEndpoints:    IAPIEndpoint[],
	regulatedHits:   IRegulatedDataHit[],
): IMigrationPhase[] {
	const unitMap    = new Map(units.map(u => [u.id, u]));
	const effortMap  = new Map<string, { low: number; high: number }>();
	for (const e of effortEstimates) {
		effortMap.set(e.unitId, { low: e.estimatedHoursLow, high: e.estimatedHoursHigh });
	}

	// Group unitIds by phase type
	const byPhase = new Map<MigrationPhaseType, string[]>();
	for (const [id, a] of assignments) {
		if (!byPhase.has(a.phaseType)) { byPhase.set(a.phaseType, []); }
		byPhase.get(a.phaseType)!.push(id);
	}

	const apiUnitIds      = new Set(apiEndpoints.map(e => e.unitId));
	const regulatedUnitIds = new Set(regulatedHits.map(r => r.unitId));

	const phaseTypes = (Object.keys(PHASE_ORDER) as MigrationPhaseType[])
		.sort((a, b) => PHASE_ORDER[a] - PHASE_ORDER[b]);

	const result: IMigrationPhase[] = [];
	let phaseIndex = 1;

	for (const phaseType of phaseTypes) {
		const unitIds = byPhase.get(phaseType) ?? [];
		if (unitIds.length === 0) { continue; }

		// Sort units within phase
		unitIds.sort((a, b) => {
			const levelDiff = (levels.get(a) ?? 0) - (levels.get(b) ?? 0);
			if (levelDiff !== 0) { return levelDiff; }
			const ua = unitMap.get(a);
			const ub = unitMap.get(b);
			const riskDiff = (RISK_RANK[ua?.riskLevel ?? 'low'] ?? 3) - (RISK_RANK[ub?.riskLevel ?? 'low'] ?? 3);
			if (riskDiff !== 0) { return riskDiff; }
			return (ua?.unitName ?? '').localeCompare(ub?.unitName ?? '');
		});

		// Aggregate effort and risk
		let hoursLow = 0;
		let hoursHigh = 0;
		const riskDist: Record<MigrationRiskLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
		for (const id of unitIds) {
			const e = effortMap.get(id);
			hoursLow  += e?.low  ?? 0;
			hoursHigh += e?.high ?? 0;
			const u = unitMap.get(id);
			if (u) { riskDist[u.riskLevel]++; }
		}

		const hasComplianceGate      = phaseType === 'compliance' || unitIds.some(id => regulatedUnitIds.has(id));
		const hasAPICompatibilityGate = unitIds.some(id => apiUnitIds.has(id));
		const phaseBlockerCount       = blockers.filter(b => b.resolveByPhaseIndex === phaseIndex).length;
		const complianceNotes         = buildPhaseComplianceNotes(phaseType, unitIds, regulatedUnitIds, riskDist);

		result.push({
			id:                      `phase-${phaseIndex}-${phaseType}`,
			index:                   phaseIndex,
			phaseType,
			label:                   `Phase ${phaseIndex}: ${PHASE_LABELS[phaseType]}`,
			description:             PHASE_DESCRIPTIONS[phaseType],
			unitIds,
			estimatedHoursLow:       Math.round(hoursLow),
			estimatedHoursHigh:      Math.round(hoursHigh),
			riskDistribution:        riskDist,
			hasComplianceGate,
			hasAPICompatibilityGate,
			blockerCount:            phaseBlockerCount,
			complianceNotes,
		});

		phaseIndex++;
	}

	return result;
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a map from unitId → array of endpoint kinds for that unit.
 */
function buildApiKindMap(endpoints: IAPIEndpoint[]): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const e of endpoints) {
		if (!map.has(e.unitId)) { map.set(e.unitId, []); }
		map.get(e.unitId)!.push(e.kind);
	}
	return map;
}

/** Returns true if all endpoint kinds for a unit are integration-type. */
function isIntegrationUnit(kinds: string[]): boolean {
	return kinds.every(k => INTEGRATION_KINDS.has(k));
}

function buildPhaseComplianceNotes(
	phaseType: MigrationPhaseType,
	unitIds: string[],
	regulatedUnitIds: Set<string>,
	riskDist: Record<MigrationRiskLevel, number>,
): string {
	const parts: string[] = [];
	const regCount = unitIds.filter(id => regulatedUnitIds.has(id)).length;

	if (regCount > 0) {
		parts.push(
			`${regCount} unit${regCount > 1 ? 's' : ''} contain regulated data — ` +
			`compliance officer sign-off required before migration proceeds.`
		);
	}
	if (phaseType === 'compliance') {
		parts.push(
			'All units in this phase require explicit compliance approval before any Stage 3 translation begins.',
		);
	}
	if (riskDist.critical > 0) {
		parts.push(
			`${riskDist.critical} critical-risk unit${riskDist.critical > 1 ? 's' : ''} — ` +
			`document change management tickets and obtain architecture sign-off before migration.`
		);
	}
	if (phaseType === 'api-layer') {
		parts.push(
			'Public API units must pass backward-compatibility tests in a staging environment ' +
			'before any production cutover is attempted.',
		);
	}
	if (phaseType === 'cutover') {
		parts.push(
			'All prior phases must be validated and approved before cutover units are translated. ' +
			'Maintain a rollback plan with feature flags or dual-run capability.',
		);
	}
	return parts.join(' ');
}
