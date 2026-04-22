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
import { toDisplaySeverity } from '../../../../neuralInverseChecks/browser/engine/types/grcTypes.js';


// ─── Phase Metadata ────────────────────────────────────────────────────────────

/** Processing order: lower number = earlier phase. */
const PHASE_ORDER: Record<MigrationPhaseType, number> = {
	'foundation':      1,
	'bsp':             2,
	'schema':          3,
	'core-logic':      4,
	'hal-layer':       5,
	'api-layer':       6,
	'integration':     7,
	'compliance':      8,
	'safety-critical': 9,
	'cutover':         10,
};

const PHASE_LABELS: Record<MigrationPhaseType, string> = {
	'foundation':      'Foundation & Shared Utilities',
	'bsp':             'Board Support Package (BSP/Startup)',
	'schema':          'Data Schema & Memory Map',
	'core-logic':      'Core Firmware / PLC Logic',
	'hal-layer':       'HAL Drivers & Peripheral Abstraction',
	'api-layer':       'API Surface & Protocol Adapters',
	'integration':     'Protocol & Fieldbus Integration',
	'compliance':      'Compliance Review & Sign-off',
	'safety-critical': 'Safety-Critical Functions',
	'cutover':         'Cutover & System Init',
};

const PHASE_DESCRIPTIONS: Record<MigrationPhaseType, string> = {
	'foundation':
		'Shared utility macros, helper functions, and base type definitions with no external hardware dependencies. ' +
		'Migrate first to unblock all other phases.',
	'bsp':
		'Board Support Package: clock configuration, startup code, memory map, vector table, linker script region definitions. ' +
		'Must be migrated and validated before any peripheral driver code.',
	'schema':
		'Data schema and memory-map definitions: register layouts, struct definitions, data area types. ' +
		'Must be consistent before core logic units that read or write those layouts are translated.',
	'core-logic':
		'Core firmware logic and PLC programs — the bulk of the migration effort. ' +
		'All BSP and foundation dependencies must be satisfied before starting this phase.',
	'hal-layer':
		'HAL peripheral drivers and RTOS integration: SPI, I2C, UART, CAN, ADC, DMA, timer abstractions. ' +
		'Requires completed BSP. HIL validation recommended at the end of this phase.',
	'api-layer':
		'External API surface and protocol adapter units (Modbus server, OPC-UA client, CAN database). ' +
		'Requires completed HAL layer. Integration tests against external field devices recommended.',
	'integration':
		'External protocol and fieldbus integrations: Modbus, OPC-UA, MQTT, CAN bus, LIN, FlexRay, Ethernet. ' +
		'Units that communicate with external systems or field devices.',
	'compliance':
		'Compliance review and GRC sign-off phase. All regulated data patterns must be resolved or formally waived. ' +
		'IEC 62443 credential externalisation and MISRA-C violation remediation must be complete.',
	'safety-critical':
		'SIL-rated safety functions, watchdog logic, and IEC 61508 / IEC 62443 regulated code paths. ' +
		'A functional safety engineer sign-off is mandatory before this phase can proceed. ' +
		'HIL or SIL verification must be completed and signed off before cutover.',
	'cutover':
		'System initialisation, top-level task orchestration, and main entry points that tie everything together. ' +
		'Migrate last — every dependency must be fully validated and approved first.',
};

/** API endpoint kinds that classify a unit as 'integration' rather than 'hal-layer'. */
const INTEGRATION_KINDS = new Set<string>([
	'fieldbus-listener', 'protocol-handler', 'can-listener', 'modbus-client', 'opcua-client',
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

		// 2. Safety-critical: safety-rated function or safety-regulated data
		if (unitHasRegulated.has(id)) {
			phase = 'safety-critical';
			reasons.push('Contains safety-regulated data or SIL-rated signal');
		}
		// 2b. Safety-critical: hardcoded credential (IEC 62443 cybersecurity risk)
		else if (unitHasCred.has(id)) {
			phase = 'safety-critical';
			reasons.push('Contains hardcoded credential — IEC 62443 security risk; must be externalised before migration');
		}
		// 3. Safety-critical: blocking GRC + critical risk
		else if (blockingFileUris.has(unit.legacyFilePath) && unit.riskLevel === 'critical') {
			phase = 'safety-critical';
			reasons.push('Blocking safety/GRC violation on a critical-risk unit');
		}
		// 4. BSP: data-model-equivalent (SVD register maps, linker sections)
		else if (unitHasSchema.has(id)) {
			phase = 'bsp';
			reasons.push('Contains register map or BSP definition (SVD / linker script)');
		}
		// 5. Foundation: level-0 root nodes with dependents (true shared utilities)
		else if (level === 0 && node && node.dependents.size >= 2 && !unitApiMap.has(id)) {
			phase = 'foundation';
			reasons.push(`Shared utility — level-0 root depended on by ${node.dependents.size} units`);
		}
		// 6. HAL layer: peripheral drivers and RTOS integration
		else if (unitApiMap.has(id) && isIntegrationUnit(unitApiMap.get(id)!)) {
			phase = 'integration';
			reasons.push(`Implements ${unitApiMap.get(id)!.join(', ')} fieldbus/protocol integration`);
		}
		// 7. HAL-layer: peripheral driver API
		else if (unitApiMap.has(id)) {
			phase = 'hal-layer';
			reasons.push(`Exposes ${unitApiMap.get(id)!.join(', ')} HAL/peripheral API`);
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

		// ── Language-specific phase overrides (market verticals) ─────────────────
		// AUTOSAR ARXML manifest units → BSP (manifest must be regenerated before any SWC migration)
		if (unit.legacyFingerprint?.sourceLanguage === 'autosar' && phase === 'core-logic') {
			phase = 'bsp';
			reasons.push('AUTOSAR manifest (ARXML) — assigned to BSP phase; must be regenerated before SWC translation');
		}
		// CMSIS SVD register-description units → BSP
		if (unit.legacyFingerprint?.sourceLanguage === 'svd' && phase === 'core-logic') {
			phase = 'bsp';
			reasons.push('CMSIS SVD peripheral description — assigned to BSP phase');
		}
		// Linker scripts → BSP
		if (unit.legacyFingerprint?.sourceLanguage === 'linker-script' && phase === 'core-logic') {
			phase = 'bsp';
			reasons.push('Linker script — memory layout must be established in BSP phase');
		}
		// CAN DBC → integration (CAN database is integration layer)
		if (unit.legacyFingerprint?.sourceLanguage === 'can-dbc' && phase === 'core-logic') {
			phase = 'integration';
			reasons.push('CAN DBC message database — assigned to integration phase');
		}
		// TTCN-3 test modules → integration (they test the integrated protocol stack)
		if (unit.legacyFingerprint?.sourceLanguage === 'ttcn3' && phase === 'core-logic') {
			phase = 'integration';
			reasons.push('TTCN-3 test module — assigned to integration phase (tests integrated protocol stack)');
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

		const hasComplianceGate      = phaseType === 'safety-critical' || unitIds.some(id => regulatedUnitIds.has(id));
		const hasValidationGate      = phaseType === 'hal-layer' || phaseType === 'safety-critical';
		const hasAPICompatibilityGate = unitIds.some(id => apiUnitIds.has(id));
		const phaseBlockerCount      = blockers.filter(b => b.resolveByPhaseIndex === phaseIndex).length;
		const complianceNotes        = buildPhaseComplianceNotes(phaseType, unitIds, regulatedUnitIds, riskDist);

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
			hasValidationGate,
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
			`${regCount} unit${regCount > 1 ? 's' : ''} contain safety-regulated signals or SIL-rated code — ` +
			`functional safety engineer sign-off required before migration proceeds.`
		);
	}
	if (phaseType === 'safety-critical') {
		parts.push(
			'All units in this phase require explicit IEC 61508 / IEC 62443 safety approval before any Stage 3 translation begins. ' +
			'HIL or SIL verification evidence must be attached to each unit before approval.',
		);
	}
	if (riskDist.critical > 0) {
		parts.push(
			`${riskDist.critical} critical-risk unit${riskDist.critical > 1 ? 's' : ''} — ` +
			`document change management tickets and obtain architecture sign-off before migration.`
		);
	}
	if (phaseType === 'hal-layer') {
		parts.push(
			'HAL/peripheral units must pass HIL integration tests on target hardware ' +
			'before any cutover is attempted.',
		);
	}
	if (phaseType === 'cutover') {
		parts.push(
			'All prior phases must be validated and approved before cutover units are translated. ' +
			'Maintain a rollback capability (e.g. dual-boot BSP or fallback firmware image).',
		);
	}
	return parts.join(' ');
}
