/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Compliance Orderer
 *
 * Enforces safety and compliance ordering constraints on the migration roadmap after
 * the initial phase assignment by the phase builder.
 *
 * ## Constraints Applied
 *
 * ### 1. Safety-Regulated BSP / Register Map Before Consuming Units
 * If a register map unit (SVD / linker script) has regulated fields AND units in later
 * phases reference that register map by name, the register-map unit is promoted to the
 * 'bsp' phase and the consuming units are demoted to no earlier than the phase after 'bsp'.
 *
 * ### 2. Source-Without-Target Safety Escalation
 * If a source unit has safety-regulated data hits but no cross-project pairing exists,
 * the unit stays in the safety-critical phase AND a warning blocker is generated:
 * the engineer must manually locate or create a target equivalent.
 *
 * ### 3. Cross-Project Regulated Discrepancy
 * If the source unit's regulated data hit count significantly exceeds the target
 * unit's (based on pairing data), a safety note is added flagging the
 * potential data leakage or safety gap in the migration.
 *
 * ### 4. GRC Blocking Violation → Always Safety-Critical
 * Any unit with a blocking safety-GRC severity in the snapshot stays in the
 * safety-critical phase regardless of other signals.
 *
 * ### 5. High-Safety-Field-Count Register Map Units
 * SVD register maps with >5 safety-regulated fields or PLC programs with >3 SIL-rated
 * function blocks are flagged as requiring a dedicated safety review before migration.
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
import { toDisplaySeverity } from '../../../../neuralInverseChecks/browser/engine/types/grcTypes.js';


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

	// Phase index lookup — must match PHASE_ORDER in phaseBuilder.ts
	const phaseOrderLookup: Record<MigrationPhaseType, number> = {
		'foundation': 1, 'bsp': 2, 'schema': 3, 'core-logic': 4,
		'hal-layer': 5, 'api-layer': 6, 'integration': 7,
		'compliance': 8, 'safety-critical': 9, 'cutover': 10,
	};

	// ── Constraint 1: Safety-Regulated Register Map / BSP Promotion ───────────
	for (const [unitId, schemas] of schemaByUnit) {
		const regulatedSchemas = schemas.filter(s => s.hasRegulatedFields);
		if (regulatedSchemas.length === 0) { continue; }

		const assignment = assignments.get(unitId);
		if (!assignment) { continue; }

		// Promote register-map / BSP-bearing unit to 'bsp' phase if not already earlier
		if (phaseOrderLookup[assignment.phaseType] > phaseOrderLookup['bsp']) {
			assignments.set(unitId, {
				...assignment,
				phaseType: 'bsp',
				reasons: [...assignment.reasons, 'Contains safety-regulated register map — promoted to BSP phase'],
				aiOverride: false,
			});
		}

		// If register map has many safety-regulated fields, add a safety review note
		const totalRegFields = regulatedSchemas.reduce((sum, s) => sum + s.fields.filter(f => f.isRegulated).length, 0);
		if (totalRegFields > 5) {
			addNote(
				unitComplianceNotes, unitId,
				`Register map has ${totalRegFields} safety-regulated fields — functional safety review required before BSP migration.`,
			);
			blockers.push(makeBlocker(
				unitId, 'no-hal-equivalent', 'warning',
				'High safety-field-count register map',
				`This unit's register map contains ${totalRegFields} safety-regulated fields. ` +
				`A dedicated functional safety review is required to map all SIL-rated registers to their HAL equivalents.`,
				'Conduct a field-by-field register mapping exercise with the safety engineer before proceeding.',
				phaseOrderLookup['bsp'],
			));
		}
	}

	// ── Constraint 2: Source Safety-Regulated → No Pairing ────────────────────
	for (const [unitId, hits] of regulatedByUnit) {
		const unit = unitMap.get(unitId);
		if (!unit) { continue; }

		const pairing = pairingBySrc.get(unitId);
		const assignment = assignments.get(unitId);
		if (!assignment) { continue; }

		// Ensure unit is in safety-critical phase
		if (phaseOrderLookup[assignment.phaseType] < phaseOrderLookup['safety-critical']) {
			assignments.set(unitId, {
				...assignment,
				phaseType: 'safety-critical',
				reasons: [
					...assignment.reasons,
					`Moved to safety-critical phase: contains ${hits.length} safety-regulated hit(s)`,
				],
				aiOverride: false,
			});
		}

		if (!pairing) {
			// No target equivalent found — raise a warning blocker
			const highConfPatterns = hits.filter(h => h.confidence === 'high').map(h => h.pattern);
			addNote(
				unitComplianceNotes, unitId,
				`No target equivalent found. Contains high-confidence safety-regulated patterns: ${[...new Set(highConfPatterns)].join(', ')}.`,
			);
			blockers.push(makeBlocker(
				unitId, 'no-target-equivalent',
				unit.riskLevel === 'critical' ? 'blocking' : 'warning',
				'No target equivalent for safety-regulated unit',
				`This unit contains safety-regulated code (${hits.length} hits, patterns: ${[...new Set(hits.map(h => h.pattern))].join(', ')}) ` +
				`but no matching target-side unit was found during cross-project pairing.`,
				'Manually identify or create a target unit before migration begins. ' +
				'Ensure the target implementation complies with all applicable safety frameworks: ' +
				`${[...new Set(hits.flatMap(h => h.applicableFrameworks))].join(', ')}.`,
				phaseOrderLookup['safety-critical'],
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

	// ── Constraint 4: GRC Blocking → Always Safety-Critical ───────────────────
	for (const unit of units) {
		if (!blockingFileUris.has(unit.legacyFilePath)) { continue; }
		const assignment = assignments.get(unit.id);
		if (!assignment) { continue; }
		if (phaseOrderLookup[assignment.phaseType] < phaseOrderLookup['safety-critical']) {
			assignments.set(unit.id, {
				...assignment,
				phaseType: 'safety-critical',
				reasons: [
					...assignment.reasons,
					'Moved to safety-critical phase: has blocking safety/GRC violation',
				],
				aiOverride: false,
			});
			blockers.push(makeBlocker(
				unit.id, 'blocking-grc-violation',
				unit.riskLevel === 'critical' ? 'blocking' : 'warning',
				'Blocking Safety / GRC Violation',
				`This unit has a blocking safety or GRC violation. It cannot be migrated until the violation is resolved.`,
				'Fix the safety/GRC violation (e.g. resolve MISRA-C mandatory rule, remediate IEC 62443 finding) and re-run Stage 1 discovery before attempting Stage 3 migration.',
				phaseOrderLookup['safety-critical'],
			));
		}
	}

	// ── Constraint 5a: IEC 61850 GOOSE path — must stay in safety-critical, never compliance ──
	for (const unit of units) {
		const hits = regulatedByUnit.get(unit.id) ?? [];
		const hasGoosePath = hits.some(h =>
			/goose|xcbr|xswi|protection.relay|iec.61850/i.test(h.pattern ?? ''),
		);
		if (!hasGoosePath) { continue; }
		const assignment = assignments.get(unit.id);
		if (!assignment) { continue; }
		// Never allow a GOOSE-path unit to land in anything lower than safety-critical
		if (phaseOrderLookup[assignment.phaseType] < phaseOrderLookup['safety-critical']) {
			assignments.set(unit.id, {
				...assignment,
				phaseType: 'safety-critical',
				reasons: [
					...assignment.reasons,
					'IEC 61850 GOOSE/protection-relay path — must be in safety-critical phase',
				],
				aiOverride: false,
			});
		}
		addNote(
			unitComplianceNotes, unit.id,
			'GOOSE protection-relay path: IEC 61850 GOOSE must NOT be bridged through OPC-UA or MQTT. ' +
			'Retain native IEC 61850 GOOSE for all protection trip paths per IEC 61850-5 Class P5/P6.',
		);
	}

	// ── Constraint 5b: AUTOSAR SWCs with ara::com migration — flag E2E profiles ──
	for (const unit of units) {
		const hits = regulatedByUnit.get(unit.id) ?? [];
		const hasE2E = hits.some(h => /e2e|end.to.end|com_send|rte_write|rte_read/i.test(h.pattern ?? ''));
		if (!hasE2E) { continue; }
		const assignment = assignments.get(unit.id);
		if (!assignment) { continue; }
		// Move to hal-layer if not already there or later
		if (phaseOrderLookup[assignment.phaseType] < phaseOrderLookup['hal-layer']) {
			assignments.set(unit.id, {
				...assignment,
				phaseType: 'hal-layer',
				reasons: [
					...assignment.reasons,
					'AUTOSAR E2E-protected signal — must be migrated in HAL layer after port manifest update',
				],
				aiOverride: false,
			});
		}
		addNote(
			unitComplianceNotes, unit.id,
			'AUTOSAR E2E protection: ensure matching E2E profile (CRC + counter) is configured in the ' +
			'ara::com manifest and that AUTOSAR SWS_E2ELibrary is linked to the Adaptive SWC.',
		);
	}

	// ── Constraint 5c: TTCN-3 testcases — must migrate before integration phase ──
	for (const unit of units) {
		if (unit.legacyFingerprint?.sourceLanguage !== 'ttcn3') { continue; }
		const assignment = assignments.get(unit.id);
		if (!assignment) { continue; }
		// TTCN-3 test modules should migrate in integration phase (they test integrated stack)
		if (phaseOrderLookup[assignment.phaseType] < phaseOrderLookup['integration']) {
			assignments.set(unit.id, {
				...assignment,
				phaseType: 'integration',
				reasons: [
					...assignment.reasons,
					'TTCN-3 test module — assigned to integration phase to match 3GPP protocol test lifecycle',
				],
				aiOverride: false,
			});
		}
		addNote(
			unitComplianceNotes, unit.id,
			'TTCN-3 → PyTest/Robot Framework migration: ensure all INCONC verdicts are replaced with ' +
			'explicit skip markers and documented assumptions. 3GPP TS 36.523 requires full verdict traceability.',
		);
	}

	// ── Constraint 5d: DNP3/IEC 61850 units → safety-critical, never integration ──
	for (const unit of units) {
		const hits = regulatedByUnit.get(unit.id) ?? [];
		const hasDnp3OrGoose = hits.some(h =>
			/dnp3|goose|xcbr|xswi|iec.61850|protection.relay/i.test(h.pattern ?? '') ||
			h.applicableFrameworks.some(f => /iec-61850|nerc-cip|iec-62351/.test(f)),
		);
		if (!hasDnp3OrGoose) { continue; }
		const assignment = assignments.get(unit.id);
		if (!assignment) { continue; }
		if (phaseOrderLookup[assignment.phaseType] < phaseOrderLookup['safety-critical']) {
			assignments.set(unit.id, {
				...assignment,
				phaseType: 'safety-critical',
				reasons: [
					...assignment.reasons,
					'DNP3 / IEC 61850 GOOSE protection path — must be in safety-critical phase per IEC 62351',
				],
				aiOverride: false,
			});
		}
		addNote(
			unitComplianceNotes, unit.id,
			'IEC 61850 / DNP3 security: implement Secure Authentication v5 (SAv5) for DNP3, ' +
			'TLS 1.3 for IEC 60870-5-104, and IEC 62351-8 RBAC for OPC-UA before cutover. ' +
			'NERC CIP CIP-005-7 R2 compliance sign-off required.',
		);
	}

	// ── Constraint 5e: OPC-UA industrial units → compliance phase, security review ──
	for (const unit of units) {
		const hits = regulatedByUnit.get(unit.id) ?? [];
		const hasOpcUa = hits.some(h =>
			h.applicableFrameworks.some(f => /opc-ua|iec-62443|iec-62541/.test(f)) ||
			/opcua|opc\.ua|opc_ua|open62541/.test(unit.legacyFilePath ?? ''),
		);
		if (!hasOpcUa) { continue; }
		const assignment = assignments.get(unit.id);
		if (!assignment) { continue; }
		if (phaseOrderLookup[assignment.phaseType] < phaseOrderLookup['compliance']) {
			assignments.set(unit.id, {
				...assignment,
				phaseType: 'compliance',
				reasons: [
					...assignment.reasons,
					'OPC-UA industrial endpoint — must pass IEC 62443-3-3 SR 3.1 compliance review',
				],
				aiOverride: false,
			});
		}
		addNote(
			unitComplianceNotes, unit.id,
			'OPC-UA security compliance: configure Basic256Sha256 + SignAndEncrypt, deploy X.509 PKI, ' +
			'and implement IEC 62351-8 role-based access control (RBAC) before integration testing.',
		);
	}

	// ── Constraint 5f: SparkplugB / MQTT IIoT units → integration phase ──────────
	for (const unit of units) {
		if (
			unit.legacyFingerprint?.sourceLanguage !== 'python' &&
			unit.legacyFingerprint?.sourceLanguage !== 'javascript' &&
			unit.legacyFingerprint?.sourceLanguage !== 'typescript' &&
			unit.legacyFingerprint?.sourceLanguage !== 'java' &&
			unit.legacyFingerprint?.sourceLanguage !== 'c' &&
			unit.legacyFingerprint?.sourceLanguage !== 'cpp'
		) { continue; }
		const hits = regulatedByUnit.get(unit.id) ?? [];
		const hasSparkplug = hits.some(h => /sparkplug|mqtt/i.test(h.pattern ?? ''));
		if (!hasSparkplug) { continue; }
		const assignment = assignments.get(unit.id);
		if (!assignment) { continue; }
		if (phaseOrderLookup[assignment.phaseType] < phaseOrderLookup['integration']) {
			assignments.set(unit.id, {
				...assignment,
				phaseType: 'integration',
				reasons: [
					...assignment.reasons,
					'MQTT SparkplugB publisher — must be validated against OT Host Application in integration phase',
				],
				aiOverride: false,
			});
		}
		addNote(
			unitComplianceNotes, unit.id,
			'SparkplugB migration: ensure NBIRTH/DBIRTH publication on session establish, ' +
			'NDEATH/DDEATH will-message configuration, and metric alias mapping is validated ' +
			'against the Primary Host Application (Ignition/AWS IoT SiteWise/Azure IoT Hub) before cutover.',
		);
	}

	// ── Constraint 5g: O-RAN / 5G NF units → specific phase ordering ─────────────
	for (const unit of units) {
		const is5GNF = /\b(?:amf|smf|upf|ausf|udm|nrf|pcf|nssf|nef|gnb|cu_cp|cu_up|du_|oran)\b/i.test(unit.legacyFilePath ?? '') ||
			(unit.legacyFingerprint?.sourceLanguage === 'c' || unit.legacyFingerprint?.sourceLanguage === 'cpp');
		const hits = regulatedByUnit.get(unit.id) ?? [];
		const has5GSec = hits.some(h =>
			/3gpp|gsma|supi|suci|nas_key|rrc_key|security-key-material/.test(h.pattern ?? '') ||
			h.applicableFrameworks.some(f => /3gpp-security|gsma-nesas/.test(f)),
		);
		if (!is5GNF || !has5GSec) { continue; }
		const assignment = assignments.get(unit.id);
		if (!assignment) { continue; }
		if (phaseOrderLookup[assignment.phaseType] < phaseOrderLookup['compliance']) {
			assignments.set(unit.id, {
				...assignment,
				phaseType: 'compliance',
				reasons: [
					...assignment.reasons,
					'5G NF with 3GPP security key material — must pass GSMA NESAS security compliance review',
				],
				aiOverride: false,
			});
		}
		addNote(
			unitComplianceNotes, unit.id,
			'3GPP / GSMA NESAS compliance: externalise all kNAS/kRRC/kAMF/kSEAF keys to HSM/TEE, ' +
			'implement SUCI concealment with network public key from UDM, ' +
			'and pass GSMA NESAS SCAS security assessment before NF deployment.',
		);
	}

	// ── Constraint 5: XLarge + Critical → Add safety blocker note ─────────────
	for (const unit of units) {
		if (unit.riskLevel !== 'critical') { continue; }
		const effort = effortMap.get(unit.id);
		if (!effort || effort.effortBand !== 'xlarge') { continue; }
		const assignment = assignments.get(unit.id);
		if (!assignment) { continue; }

		blockers.push(makeBlocker(
			unit.id, 'xlarge-effort-critical', 'warning',
			'XLarge Effort + Critical Risk',
			`This unit is estimated at ${effort.estimatedHoursLow}–${effort.estimatedHoursHigh} hours and carries critical risk. ` +
			`It likely contains complex safety logic, memory-mapped I/O, or deeply nested ISR interactions.`,
			'Break this unit into smaller sub-units before migration if possible. ' +
			'Allocate a dedicated sprint and assign a senior embedded engineer with domain knowledge.',
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
	ruleReference?: string,
): IMigrationBlocker {
	return { unitId, blockerType, severity, title, description, recommendedAction, resolveByPhaseIndex, ruleReference };
}
