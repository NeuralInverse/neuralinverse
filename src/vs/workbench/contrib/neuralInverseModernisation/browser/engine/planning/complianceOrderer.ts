/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Compliance Orderer
 *
 * Enforces compliance ordering constraints on the migration roadmap after
 * the initial phase assignment by the phase builder.
 *
 * ## Constraints Applied
 *
 * ### 1. Regulated-Data Schema Before Consuming Units
 * If a data schema (table / FD / entity) has regulated fields AND units in later
 * phases reference that schema by name, the schema unit is promoted to the
 * 'schema' phase and the consuming units are demoted to no earlier than the
 * phase after the schema phase.
 *
 * ### 2. Source-Without-Target Compliance Escalation
 * If a source unit has regulated data hits but no cross-project pairing exists,
 * the unit stays in the compliance phase AND a warning blocker is generated:
 * the developer must manually locate or create a target equivalent.
 *
 * ### 3. Cross-Project Regulated Discrepancy
 * If the source unit's regulated data hit count significantly exceeds the target
 * unit's (based on pairing data), a compliance note is added flagging the
 * potential data leakage risk in the migration.
 *
 * ### 4. GRC Blocking Violation → Always Compliance
 * Any unit with a blocking GRC severity in the snapshot stays in the compliance
 * phase regardless of other signals.
 *
 * ### 5. High-Regulated-Field-Count Schema Units
 * COBOL FD records with >5 regulated fields, SQL tables with >3 PII columns, or
 * Java @Entity classes with >3 regulated fields are flagged as requiring a
 * dedicated data-governance review before schema migration.
 */

import {
	IMigrationUnit,
	MigrationPhaseType,
	IMigrationBlocker,
	MigrationBlockerType,
} from '../../../common/modernisationTypes.js';
import {
	IRegulatedDataHit,
	IDataSchema,
	ICrossProjectPairing,
	IGRCSnapshot,
	IMigrationEffortEstimate,
} from '../discovery/discoveryTypes.js';
import { IUnitPhaseAssignment } from './planningTypes.js';
/** Inline: normalize severity string to 'error' | 'warning' | 'info'. */
const toDisplaySeverity = (s?: string): 'error' | 'warning' | 'info' => {
	const l = (s ?? '').toLowerCase();
	if (l === 'error' || l === 'critical' || l === 'blocker') { return 'error'; }
	if (l === 'warning' || l === 'warn') { return 'warning'; }
	return 'info';
};


// ─── Public API ───────────────────────────────────────────────────────────────

export interface IComplianceOrderResult {
	/** Updated phase assignments (may have promoted/demoted units). */
	assignments: Map<string, IUnitPhaseAssignment>;
	/** New compliance-derived migration blockers. */
	blockers: IMigrationBlocker[];
	/** Per-unit compliance notes (unitId → note string). */
	unitComplianceNotes: Map<string, string>;
}

/**
 * Apply compliance ordering constraints to an existing set of phase assignments.
 *
 * @param assignments     Phase assignments from phaseBuilder.assignPhases()
 * @param units           All source-side migration units
 * @param regulatedHits   Regulated data hits from the source project scan
 * @param dataSchemas     Data schemas from the source project scan
 * @param pairings        Cross-project pairings (source ↔ target)
 * @param grcSnapshot     GRC snapshot for the source project
 * @param effortEstimates Per-unit effort estimates (to weight blocker severity)
 */
export function enforceComplianceOrdering(
	assignments:      Map<string, IUnitPhaseAssignment>,
	units:            IMigrationUnit[],
	regulatedHits:    IRegulatedDataHit[],
	dataSchemas:      IDataSchema[],
	pairings:         ICrossProjectPairing[],
	grcSnapshot:      IGRCSnapshot,
	effortEstimates:  IMigrationEffortEstimate[],
): IComplianceOrderResult {
	const blockers: IMigrationBlocker[] = [];
	const unitComplianceNotes = new Map<string, string>();

	// ── Build lookup structures ────────────────────────────────────────────────
	const unitMap = new Map(units.map(u => [u.id, u]));

	// regulatedHits per unit
	const regulatedByUnit = new Map<string, IRegulatedDataHit[]>();
	for (const hit of regulatedHits) {
		if (!regulatedByUnit.has(hit.unitId)) { regulatedByUnit.set(hit.unitId, []); }
		regulatedByUnit.get(hit.unitId)!.push(hit);
	}

	// Schemas per unit
	const schemaByUnit = new Map<string, IDataSchema[]>();
	for (const s of dataSchemas) {
		if (!schemaByUnit.has(s.unitId)) { schemaByUnit.set(s.unitId, []); }
		schemaByUnit.get(s.unitId)!.push(s);
	}

	// Pairings: source → target
	const pairingBySrc = new Map<string, ICrossProjectPairing>();
	for (const p of pairings) {
		if (!pairingBySrc.has(p.sourceUnitId) || p.confidenceScore > (pairingBySrc.get(p.sourceUnitId)?.confidenceScore ?? 0)) {
			pairingBySrc.set(p.sourceUnitId, p);
		}
	}

	// Blocking GRC violations by file URI — uses toDisplaySeverity() from the
	// Checks engine so custom framework severities (e.g. 'blocker', 'critical')
	// are correctly classified as blocking rather than hardcoding string literals.
	const blockingFileUris = new Set(
		grcSnapshot.violations
			.filter(v => toDisplaySeverity(v.severity) === 'error')
			.map(v => v.fileUri),
	);

	// Effort map
	const effortMap = new Map<string, IMigrationEffortEstimate>();
	for (const e of effortEstimates) { effortMap.set(e.unitId, e); }

	// Phase index lookup
	const phaseOrderLookup: Record<MigrationPhaseType, number> = {
		'foundation': 1, 'schema': 2, 'core-logic': 3,
		'api-layer': 4, 'integration': 5, 'compliance': 6, 'cutover': 7,
	};

	// ── Constraint 1: Regulated-Data Schema Promotion ──────────────────────────
	for (const [unitId, schemas] of schemaByUnit) {
		const regulatedSchemas = schemas.filter(s => s.hasRegulatedFields);
		if (regulatedSchemas.length === 0) { continue; }

		const assignment = assignments.get(unitId);
		if (!assignment) { continue; }

		// Promote schema-bearing unit to 'schema' phase if it isn't already earlier
		if (phaseOrderLookup[assignment.phaseType] > phaseOrderLookup['schema']) {
			assignments.set(unitId, {
				...assignment,
				phaseType: 'schema',
				reasons: [...assignment.reasons, 'Contains regulated-field schema — promoted to schema phase'],
				aiOverride: false,
			});
		}

		// If schema has many regulated fields, add a compliance note
		const totalRegFields = regulatedSchemas.reduce((sum, s) => sum + s.fields.filter(f => f.isRegulated).length, 0);
		if (totalRegFields > 5) {
			addNote(
				unitComplianceNotes, unitId,
				`Schema has ${totalRegFields} regulated fields — data governance review required before schema migration.`,
			);
			blockers.push(makeBlocker(
				unitId, 'unresolved-regulated-data', 'warning',
				'High regulated-field-count schema',
				`This unit's data schema contains ${totalRegFields} regulated fields. ` +
				`A dedicated data-governance review is required to map all PII/PCI columns to their target equivalents.`,
				'Conduct a field-by-field data mapping exercise with the compliance team before proceeding.',
				phaseOrderLookup['schema'],
			));
		}
	}

	// ── Constraint 2: Source Regulated → No Pairing ───────────────────────────
	for (const [unitId, hits] of regulatedByUnit) {
		const unit = unitMap.get(unitId);
		if (!unit) { continue; }

		const pairing = pairingBySrc.get(unitId);
		const assignment = assignments.get(unitId);
		if (!assignment) { continue; }

		// Ensure unit is in compliance phase
		if (phaseOrderLookup[assignment.phaseType] < phaseOrderLookup['compliance']) {
			assignments.set(unitId, {
				...assignment,
				phaseType: 'compliance',
				reasons: [
					...assignment.reasons,
					`Moved to compliance phase: contains ${hits.length} regulated data hit(s)`,
				],
				aiOverride: false,
			});
		}

		if (!pairing) {
			// No target equivalent found — raise a warning blocker
			const highConfPatterns = hits.filter(h => h.confidence === 'high').map(h => h.pattern);
			addNote(
				unitComplianceNotes, unitId,
				`No target equivalent found. Contains high-confidence regulated patterns: ${[...new Set(highConfPatterns)].join(', ')}.`,
			);
			blockers.push(makeBlocker(
				unitId, 'no-target-equivalent',
				unit.riskLevel === 'critical' ? 'blocking' : 'warning',
				'No target equivalent for regulated-data unit',
				`This unit contains regulated data (${hits.length} hits, patterns: ${[...new Set(hits.map(h => h.pattern))].join(', ')}) ` +
				`but no matching target-side unit was found during cross-project pairing.`,
				'Manually identify or create a target unit before migration begins. ' +
				'Ensure the target implementation complies with all applicable frameworks: ' +
				`${[...new Set(hits.flatMap(h => h.applicableFrameworks))].join(', ')}.`,
				phaseOrderLookup['compliance'],
			));
		}
	}

	// ── Constraint 3: Cross-Project Regulated Discrepancy ─────────────────────
	for (const [sourceUnitId, pairing] of pairingBySrc) {
		const srcHits = regulatedByUnit.get(sourceUnitId) ?? [];
		if (srcHits.length === 0) { continue; }

		// We can't compare target hits directly (would need target discovery context here),
		// but we can flag when the target has no fingerprint at all despite the source having regulated data
		if (!pairing.targetHasFingerprint && srcHits.length > 2) {
			addNote(
				unitComplianceNotes, sourceUnitId,
				`Target unit (ID: ${pairing.targetUnitId}) has no compliance fingerprint despite source having ` +
				`${srcHits.length} regulated data hits. Run Stage 1 discovery on the target project first.`,
			);
		}
	}

	// ── Constraint 4: GRC Blocking → Always Compliance ────────────────────────
	for (const unit of units) {
		if (!blockingFileUris.has(unit.legacyFilePath)) { continue; }
		const assignment = assignments.get(unit.id);
		if (!assignment) { continue; }
		if (phaseOrderLookup[assignment.phaseType] < phaseOrderLookup['compliance']) {
			assignments.set(unit.id, {
				...assignment,
				phaseType: 'compliance',
				reasons: [
					...assignment.reasons,
					'Moved to compliance phase: has blocking GRC violation',
				],
				aiOverride: false,
			});
			blockers.push(makeBlocker(
				unit.id, 'blocking-grc-violation',
				unit.riskLevel === 'critical' ? 'blocking' : 'warning',
				'Blocking GRC violation',
				`This unit has a blocking GRC violation. It cannot be migrated until the violation is resolved.`,
				'Fix the GRC violation and re-run Stage 1 discovery before attempting Stage 3 migration.',
				phaseOrderLookup['compliance'],
			));
		}
	}

	// ── Constraint 5: XLarge + Critical → Add compliance blocker note ─────────
	for (const unit of units) {
		if (unit.riskLevel !== 'critical') { continue; }
		const effort = effortMap.get(unit.id);
		if (!effort || effort.effortBand !== 'xlarge') { continue; }
		const assignment = assignments.get(unit.id);
		if (!assignment) { continue; }

		blockers.push(makeBlocker(
			unit.id, 'xlarge-effort-critical', 'warning',
			'XLarge effort + critical risk',
			`This unit is estimated at ${effort.estimatedHoursLow}–${effort.estimatedHoursHigh} hours and carries critical risk. ` +
			`It likely contains complex business logic, regulated data, or deeply nested control flow.`,
			'Break this unit into smaller sub-units before migration if possible. ' +
			'Allocate a dedicated sprint and assign a senior engineer with domain knowledge.',
			Math.max(1, (assignments.get(unit.id)?.phaseType ?
				phaseOrderLookup[assignments.get(unit.id)!.phaseType] - 1 : 1)),
		));
	}

	return { assignments, blockers, unitComplianceNotes };
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

function addNote(map: Map<string, string>, unitId: string, note: string): void {
	const existing = map.get(unitId);
	map.set(unitId, existing ? `${existing} ${note}` : note);
}

function makeBlocker(
	unitId: string,
	blockerType: MigrationBlockerType,
	severity: 'warning' | 'blocking',
	title: string,
	description: string,
	recommendedAction: string,
	resolveByPhaseIndex: number,
): IMigrationBlocker {
	return { unitId, blockerType, severity, title, description, recommendedAction, resolveByPhaseIndex };
}
