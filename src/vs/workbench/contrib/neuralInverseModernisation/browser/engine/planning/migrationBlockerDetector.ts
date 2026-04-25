/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Migration Blocker Detector
 *
 * Surfaces issues that will actively impede migration — either outright blocking
 * issues that must be resolved before a unit can be translated, or warnings that
 * require special attention and planning.
 *
 * ## Blocker Catalogue
 *
 * | Blocker Type              | Severity | Trigger Condition                              |
 * |---------------------------|----------|------------------------------------------------|
 * | god-unit                  | blocking | CC > 20 AND LOC > 300 (tech-debt category)     |
 * | no-target-equivalent      | warning* | Critical unit with no cross-project pairing    |
 * | hardcoded-credential      | blocking | Tech-debt category 'hardcoded-credential'      |
 * | goto-usage                | warning  | Tech-debt category 'goto-usage'                |
 * | circular-dependency       | blocking | Cycle edges returned by dependencyResolver     |
 * | xlarge-effort-critical    | warning  | Effort band 'xlarge' AND risk 'critical'       |
 * | unresolved-regulated-data | warning  | Regulated data with no target equivalent       |
 * | blocking-grc-violation    | blocking | Blocking GRC violation in the GRC snapshot     |
 * | missing-schema-mapping    | warning  | Source schema has regulated fields, no pairing |
 * | unbounded-loop            | warning  | Tech-debt category 'unbounded-loop'            |
 * | deep-nesting              | warning  | Tech-debt category 'deep-nesting' severity err |
 * | implicit-type-coercion    | warning  | Tech-debt category 'implicit-type-coercion'    |
 *
 * * `no-target-equivalent` becomes `blocking` when unit risk is 'critical'.
 *
 * ## Phase Assignment
 *
 * Each blocker carries `resolveByPhaseIndex` — the phase index by which the
 * blocker must be resolved. This is used by the UI to show a blocker count per
 * phase header and to gate phase start.
 */

import {
	IMigrationUnit,
	MigrationBlockerType,
	IMigrationBlocker,
	MigrationPhaseType,
} from '../../../common/modernisationTypes.js';
import {
	ITechDebtItem,
	IRegulatedDataHit,
	IDataSchema,
	ICrossProjectPairing,
	IGRCSnapshot,
	IMigrationEffortEstimate,
} from '../discovery/discoveryTypes.js';
import { ICycleEdge, IUnitPhaseAssignment } from './planningTypes.js';
import { toDisplaySeverity } from '../../../../neuralInverseChecks/browser/engine/types/grcTypes.js';


// ─── Phase ordering lookup ─────────────────────────────────────────────────────

const PHASE_INDEX: Record<MigrationPhaseType, number> = {
	'foundation': 1, 'bsp': 2, 'schema': 3, 'core-logic': 4,
	'hal-layer': 5, 'api-layer': 6, 'integration': 7,
	'compliance': 8, 'safety-critical': 9, 'cutover': 10,
};


// ─── Public API ───────────────────────────────────────────────────────────────

export interface IBlockerDetectionInput {
	units:           IMigrationUnit[];
	techDebtItems:   ITechDebtItem[];
	regulatedHits:   IRegulatedDataHit[];
	dataSchemas:     IDataSchema[];
	pairings:        ICrossProjectPairing[];
	grcSnapshot:     IGRCSnapshot;
	effortEstimates: IMigrationEffortEstimate[];
	cycleEdges:      ICycleEdge[];
	phaseAssignments: Map<string, IUnitPhaseAssignment>;
}

/**
 * Detect all migration blockers across all source units.
 */
export function detectMigrationBlockers(
	input: IBlockerDetectionInput,
): IMigrationBlocker[] {
	const {
		units, techDebtItems, regulatedHits, dataSchemas, pairings,
		grcSnapshot, effortEstimates, cycleEdges, phaseAssignments,
	} = input;

	const blockers: IMigrationBlocker[] = [];
	const seen = new Set<string>(); // deduplicate by `unitId:blockerType`

	const add = (b: IMigrationBlocker) => {
		const key = `${b.unitId}:${b.blockerType}`;
		if (!seen.has(key)) { seen.add(key); blockers.push(b); }
	};

	const unitMap    = new Map(units.map(u => [u.id, u]));
	const effortMap  = new Map<string, IMigrationEffortEstimate>();
	for (const e of effortEstimates) { effortMap.set(e.unitId, e); }

	// Best pairing per source unit
	const bestPairing = new Map<string, ICrossProjectPairing>();
	for (const p of pairings) {
		const existing = bestPairing.get(p.sourceUnitId);
		if (!existing || p.confidenceScore > existing.confidenceScore) {
			bestPairing.set(p.sourceUnitId, p);
		}
	}

	// Regulated hits per unit
	const regulatedByUnit = new Map<string, number>();
	for (const r of regulatedHits) {
		regulatedByUnit.set(r.unitId, (regulatedByUnit.get(r.unitId) ?? 0) + 1);
	}

	// Data schemas with regulated fields, per unit
	const regulatedSchemaUnits = new Set(
		dataSchemas.filter(s => s.hasRegulatedFields).map(s => s.unitId),
	);

	// Blocking GRC by file URI — uses toDisplaySeverity() from the Checks engine
	// so custom framework severities ('blocker', 'critical', etc.) are handled correctly.
	const blockingFiles = new Set(
		grcSnapshot.violations
			.filter(v => toDisplaySeverity(v.severity) === 'error')
			.map(v => v.fileUri),
	);

	// ── 1. God units ──────────────────────────────────────────────────────────
	const godUnitIds = new Set(
		techDebtItems.filter(t => t.category === 'god-unit').map(t => t.unitId),
	);
	for (const id of godUnitIds) {
		const unit = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'core-logic';
		add(makeBlocker(
			id, 'god-unit', 'blocking',
			'God unit — must be decomposed before migration',
			`This unit has extremely high cyclomatic complexity and line count. ` +
			`Attempting to translate it as a single unit will produce unmaintainable code in the target language.`,
			'Decompose the unit into smaller, single-responsibility sub-units (≤ 200 LOC, CC ≤ 10). ' +
			'For COBOL programs: extract paragraphs into separate subprograms or Java service methods. ' +
			'For Java/Python classes: apply the Single Responsibility Principle.',
			Math.max(1, PHASE_INDEX[phase] - 1),
		));
	}

	// ── 2. No target equivalent for critical / high-risk units ────────────────
	for (const unit of units) {
		if (unit.riskLevel !== 'critical' && unit.riskLevel !== 'high') { continue; }
		const pairing = bestPairing.get(unit.id);
		if (!pairing) {
			const phase   = phaseAssignments.get(unit.id)?.phaseType ?? 'core-logic';
			const severity = unit.riskLevel === 'critical' ? 'blocking' : 'warning';
			add(makeBlocker(
				unit.id, 'no-target-equivalent', severity,
				`No target equivalent for ${unit.riskLevel}-risk unit`,
				`Unit "${unit.unitName}" has ${unit.riskLevel} risk but no target-side counterpart was ` +
				`found during cross-project pairing. Without a target unit, the translation has no destination.`,
				'Manually create a skeleton target unit and re-run discovery, or review the target project ' +
				'to confirm whether a matching class/function already exists under a different name.',
				PHASE_INDEX[phase],
			));
		} else if (pairing.confidenceScore < 0.40) {
			const phase = phaseAssignments.get(unit.id)?.phaseType ?? 'core-logic';
			add(makeBlocker(
				unit.id, 'no-target-equivalent', 'warning',
				`Low-confidence pairing for ${unit.riskLevel}-risk unit`,
				`Unit "${unit.unitName}" was paired with target unit "${pairing.targetUnitId}" with only ` +
				`${Math.round(pairing.confidenceScore * 100)}% confidence. ` +
				`The pairing may be incorrect — verify manually before starting migration.`,
				'Review the pairing in the cross-project pairing view and confirm or correct it.',
				PHASE_INDEX[phase],
			));
		}
	}

	// ── 3. Hardcoded credentials ──────────────────────────────────────────────
	const credUnitIds = new Set(
		techDebtItems.filter(t => t.category === 'hardcoded-credential').map(t => t.unitId),
	);
	for (const id of credUnitIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'core-logic';
		add(makeBlocker(
			id, 'hardcoded-credential', 'blocking',
			'Hardcoded credentials detected',
			`This unit contains hardcoded passwords, API keys, or connection strings. ` +
			`Translating these directly into the target codebase would embed credentials in version control.`,
			'Move all credentials to environment variables or a secrets manager (Vault, AWS Secrets Manager, etc.) ' +
			'BEFORE the migration begins. Treat this as a prerequisite security remediation.',
			Math.max(1, PHASE_INDEX[phase] - 1),
		));
	}

	// ── 4. GOTO usage ─────────────────────────────────────────────────────────
	const gotoUnitIds = new Set(
		techDebtItems.filter(t => t.category === 'goto-usage').map(t => t.unitId),
	);
	for (const id of gotoUnitIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'core-logic';
		add(makeBlocker(
			id, 'goto-usage', 'warning',
			'GOTO usage — restructuring required',
			`This unit uses GOTO statements. Structured languages (Java, Python, TypeScript, Go, C#) ` +
			`do not support GOTO, so the control flow must be refactored before the unit can be translated.`,
			'Refactor all GOTO paths into structured loops, conditionals, or early returns. ' +
			'For COBOL: convert GOTO paragraphs to PERFORM loops with EXIT conditions. ' +
			'Use control-flow analysis to identify all GOTO targets and reachability.',
			PHASE_INDEX[phase],
		));
	}

	// ── 5. Circular dependencies ──────────────────────────────────────────────
	for (const cycle of cycleEdges) {
		const unit  = unitMap.get(cycle.fromId);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(cycle.fromId)?.phaseType ?? 'core-logic';
		add(makeBlocker(
			cycle.fromId, 'circular-dependency', 'blocking',
			`Circular dependency: "${unit.unitName}" ↔ "${unitMap.get(cycle.toId)?.unitName ?? cycle.toId}"`,
			`A cyclic dependency was detected between "${unit.unitName}" and ` +
			`"${unitMap.get(cycle.toId)?.unitName ?? cycle.toId}". ` +
			`This prevents clean topological ordering and will cause compilation errors in strongly-typed target languages.`,
			'Break the cycle by extracting shared state or shared behaviour into a third unit that both can depend on. ' +
			'Apply the Dependency Inversion Principle: depend on abstractions, not concretions.',
			Math.max(1, PHASE_INDEX[phase] - 1),
		));
	}

	// ── 6. Unbounded loops ─────────────────────────────────────────────────────
	const unboundedIds = new Set(
		techDebtItems
			.filter(t => t.category === 'unbounded-loop' && t.severity === 'error')
			.map(t => t.unitId),
	);
	for (const id of unboundedIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'core-logic';
		add(makeBlocker(
			id, 'unbounded-loop', 'warning',
			'Unbounded loop — potential infinite loop risk',
			`This unit contains a loop with no detectable termination condition. ` +
			`In the source language this may be intentional (e.g. a daemon loop), but must be ` +
			`explicitly handled in the target language to avoid CPU spinning or thread starvation.`,
			'Add an explicit termination condition (timeout, cancellation token, maximum iteration count) ' +
			'and document the expected lifetime of the loop in comments.',
			PHASE_INDEX[phase],
		));
	}

	// ── 7. Deep nesting ────────────────────────────────────────────────────────
	const deepNestIds = new Set(
		techDebtItems
			.filter(t => t.category === 'deep-nesting' && t.severity === 'error')
			.map(t => t.unitId),
	);
	for (const id of deepNestIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'core-logic';
		add(makeBlocker(
			id, 'deep-nesting', 'warning',
			'Extreme nesting depth — structural refactoring recommended',
			`This unit has nesting depth > 7. Such code is extremely difficult to translate reliably ` +
			`and will produce unreadable code in the target language.`,
			'Apply "extract method" refactoring to reduce nesting to ≤ 4 levels before translating. ' +
			'Replace nested conditionals with guard clauses (early returns). ' +
			'Consider breaking deeply nested blocks into helper functions.',
			PHASE_INDEX[phase],
		));
	}

	// ── 8. Implicit type coercion ──────────────────────────────────────────────
	const coercionIds = new Set(
		techDebtItems
			.filter(t => t.category === 'implicit-type-coercion')
			.map(t => t.unitId),
	);
	for (const id of coercionIds) {
		const unit = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'core-logic';
		add(makeBlocker(
			id, 'implicit-type-coercion', 'warning',
			'Implicit type coercion — precision risk',
			`This unit uses implicit type coercion (e.g. == vs ===, Python integer division, ` +
			`COBOL COMP-3 to floating-point). ` +
			`The target language may handle these differently, causing precision or type errors.`,
			'Audit all arithmetic operations and equality comparisons. ' +
			'Use explicit type conversions in the target language. ' +
			'For financial calculations: prefer fixed-point arithmetic or BigDecimal.',
			PHASE_INDEX[phase],
		));
	}

	// ── 9a. AUTOSAR RTE dependencies without Adaptive ara::com mapping ────────────
	const autosarRteIds = new Set(
		techDebtItems.filter(t => t.category === 'autosar-rte-dependency').map(t => t.unitId),
	);
	for (const id of autosarRteIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'hal-layer';
		add(makeBlocker(
			id, 'autosar-rte-dependency', 'blocking',
			'AUTOSAR Classic RTE port has no Adaptive ara::com mapping',
			`This AUTOSAR Classic SWC uses Rte_Read / Rte_Write / Rte_Call on a port interface that has ` +
			`no documented mapping to an AUTOSAR Adaptive ara::com service interface. ` +
			`Translating without this mapping will silently break inter-SWC communication.`,
			'Define a matching ara::com service interface (ServiceInterface ARXML) for each Classic port. ' +
			'Use the AUTOSAR Adaptive manifest toolchain (Vector DaVinci / EB tresos) to generate ' +
			'ara::com proxies/skeletons. Validate round-trip data types before migration.',
			Math.max(1, PHASE_INDEX[phase] - 1),
			'AUTOSAR AP R22-11 SWS_CM',
		));
	}

	// ── 9b. End-to-end protection gaps ────────────────────────────────────────────
	const e2eGapIds = new Set(
		techDebtItems.filter(t => t.category === 'e2e-protection-gap').map(t => t.unitId),
	);
	for (const id of e2eGapIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'safety-critical';
		add(makeBlocker(
			id, 'e2e-protection-gap', 'blocking',
			'End-to-end protection profile missing in target communication path',
			`This unit sends or receives data protected by an AUTOSAR E2E profile (CRC + counter). ` +
			`The target-side communication path has no equivalent E2E configuration, ` +
			`creating a safety gap for ASIL-rated signals.`,
			'Configure the matching E2E profile in the target ComM / ara::com manifest. ' +
			'Ensure the E2E wrapper library (AUTOSAR SWS_E2ELibrary) is linked to the target SWC. ' +
			'Update the SystemDescription ARXML with the E2E profile assignment before cutover.',
			Math.max(1, PHASE_INDEX[phase] - 1),
			'ISO 26262-6 §7.4.8 / AUTOSAR SWS_E2ELibrary',
		));
	}

	// ── 9c. ASIL decomposition breaks ─────────────────────────────────────────────
	const asilDecompIds = new Set(
		techDebtItems.filter(t => t.category === 'asil-decomposition-break').map(t => t.unitId),
	);
	for (const id of asilDecompIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'safety-critical';
		add(makeBlocker(
			id, 'asil-decomposition-break', 'blocking',
			'ASIL-D unit decomposed without formal ASIL-B+B dual-channel documentation',
			`This unit is rated ASIL-D and appears to be split across two targets, ` +
			`but no ASIL decomposition rationale (Safety Manual or Safety Case addendum) has been detected. ` +
			`Without it, the decomposition is not auditable to ISO 26262.`,
			'Document the ASIL decomposition in the Safety Manual: each ASIL-B channel must have ' +
			'independent failure modes, independent toolchains, and independent test coverage. ' +
			'Engage your functional safety assessor before cutover.',
			Math.max(1, PHASE_INDEX[phase] - 1),
			'ISO 26262-6 §6.4.5 ASIL decomposition',
		));
	}

	// ── 9d. Telecom security key material ─────────────────────────────────────────
	const keyMaterialIds = new Set(
		techDebtItems.filter(t => t.category === 'security-key-material').map(t => t.unitId),
	);
	for (const id of keyMaterialIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'compliance';
		add(makeBlocker(
			id, 'security-key-material', 'blocking',
			'Cryptographic key material detected inline (3GPP AS/NAS/RRC keys)',
			`This unit contains hardcoded or inline cryptographic key material ` +
			`(AS keys, NAS integrity keys, ciphering keys, SUPI/SUCI derivation material). ` +
			`These must NEVER appear in source code or configuration files per 3GPP TS 33.501.`,
			'Remove all key material from source immediately. ' +
			'Use an HSM, TEE, or GSMA SAS-accredited key provisioning system. ' +
			'Implement SUCI concealment using the network public key from the UDM. ' +
			'This is a blocking prerequisite before the unit can be translated.',
			Math.max(1, PHASE_INDEX[phase] - 1),
			'3GPP TS 33.501 §6.2 Key Hierarchy',
		));
	}

	// ── 9e. IEC 61850 GOOSE protection relay bridged via OPC-UA ──────────────────
	const gooseRelayIds = new Set(
		techDebtItems.filter(t => t.category === 'goose-protection-relay').map(t => t.unitId),
	);
	for (const id of gooseRelayIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'safety-critical';
		add(makeBlocker(
			id, 'goose-protection-relay', 'blocking',
			'IEC 61850 GOOSE protection trip path must NOT be routed via OPC-UA',
			`This unit publishes or subscribes to an IEC 61850 GOOSE message on a protection relay trip path. ` +
			`The migration target appears to bridge this path through OPC-UA, which cannot guarantee ` +
			`the < 4 ms latency required by IEC 61850-5 for Class P5/P6 protection applications.`,
			'Keep the IEC 61850 GOOSE/GSSE path native using IEC 61850 Edition 2 GOOSE. ' +
			'OPC-UA may only be used for monitoring/HMI data, never for protection trip commands. ' +
			'Review IEC 61850-90-4 network engineering guidelines for performance class assignments. ' +
			'Obtain approval from your grid protection engineer before cutover.',
			Math.max(1, PHASE_INDEX[phase] - 1),
			'IEC 61850-5 Performance Class P5/P6',
		));
	}

	// ── 9f. SIS/ESD SIL downgrade ─────────────────────────────────────────────────
	const sisSilIds = new Set(
		techDebtItems.filter(t => t.category === 'sis-sil-downgrade').map(t => t.unitId),
	);
	for (const id of sisSilIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'safety-critical';
		add(makeBlocker(
			id, 'sis-sil-downgrade', 'blocking',
			'SIS/ESD SIL level reduction detected after modernisation',
			`This Safety Instrumented System (SIS) or Emergency Shutdown (ESD) function ` +
			`was rated SIL 2 or higher in the source. ` +
			`The modernised target implementation has characteristics (diagnostic coverage, ` +
			`architectural constraints) that would reduce the achievable SIL level.`,
			'Perform a SIL verification calculation (IEC 61511-1 §11) for the modernised target. ' +
			'Ensure diagnostic coverage ≥ DC Medium (60–90%) and hardware fault tolerance matches the original. ' +
			'A HAZOP/LOPA re-evaluation may be required. ' +
			'Do not cutover until the SIL verification report is signed off by the SIS engineer.',
			Math.max(1, PHASE_INDEX[phase] - 1),
			'IEC 61511-1 §11 SIL Verification',
		));
	}

	// ── 9g. DNP3 Secure Auth gap ──────────────────────────────────────────────────
	const dnp3SecAuthIds = new Set(
		techDebtItems.filter(t => t.category === 'dnp3-secure-auth-gap').map(t => t.unitId),
	);
	for (const id of dnp3SecAuthIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'compliance';
		add(makeBlocker(
			id, 'dnp3-secure-auth-gap', 'blocking',
			'DNP3 communication without Secure Authentication v5 (SAv5)',
			`This unit uses DNP3 without DNP3 SAv5 (HMAC-SHA-256 challenges). ` +
			`NERC CIP CIP-005-7 R2 and IEC 62351-5 require DNP3 SAv5 for any BES Cyber System link. ` +
			`Unprotected DNP3 is vulnerable to replay and spoofing attacks in OT/SCADA networks.`,
			'Implement DNP3 SAv5 in the migration target: configure challenge/reply HMAC-SHA-256, ' +
			'external key management (Update Key Change procedure), and anti-replay window. ' +
			'Alternatively, replace DNP3 with IEC 60870-5-104 over TLS 1.3.',
			Math.max(1, PHASE_INDEX[phase] - 1),
			'NERC CIP CIP-005-7 R2 / IEC 62351-5',
		));
	}

	// ── 9h. EtherCAT timing violation ─────────────────────────────────────────────
	const etherCATIds = new Set(
		techDebtItems.filter(t => t.category === 'isr-reentrance-risk' && t.description?.includes('EtherCAT')).map(t => t.unitId),
	);
	for (const id of etherCATIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'hal-layer';
		add(makeBlocker(
			id, 'can-signal-scaling-mismatch', 'blocking',
			'EtherCAT master loop uses OS sleep — deterministic cycle time violated',
			`The EtherCAT master cycle loop contains OS sleep/delay calls that prevent deterministic ` +
			`process data exchange. EtherCAT requires jitter < 1 µs for IRT (Isochronous Real-Time) mode ` +
			`and < 100 µs for RT mode. OS sleeps introduce unbounded latency.`,
			'Migrate to a Linux PREEMPT_RT real-time thread (SCHED_FIFO, priority 99) or a dedicated RTOS task. ' +
			'Replace all sleep() calls with cycle-synchronised ecrt_master_receive() + ecrt_domain_process() + ' +
			'ecrt_master_send() inside a timer-driven or event-driven loop.',
			Math.max(1, PHASE_INDEX[phase] - 1),
			'IEC 61784-2 Annex B / EtherCAT Technology Group ETG.1020',
		));
	}

	// ── 9i. MQTT SparkplugB BIRTH certificate missing ─────────────────────────────
	const spbIds = new Set(
		techDebtItems.filter(t => t.category === 'missing-error-handling' && t.description?.includes('SparkplugB')).map(t => t.unitId),
	);
	for (const id of spbIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'integration';
		add(makeBlocker(
			id, 'protocol-state-machine-break', 'blocking',
			'MQTT SparkplugB publisher missing NBIRTH/DBIRTH — Host Application cannot initialise metric dictionary',
			`This unit publishes SparkplugB NDATA/DDATA metrics without a preceding NBIRTH/DBIRTH. ` +
			`SparkplugB v3.0 §4.2 requires every Node and Device to publish a BIRTH certificate immediately ` +
			`after establishing the MQTT session. Without it the Primary Host Application rejects data.`,
			'Add NBIRTH publication on session connect and DBIRTH before first DDATA. ' +
			'Implement NDEATH/DDEATH will-message for graceful disconnection. ' +
			'Re-sequence the migration target to: CONNECT \u2192 NBIRTH \u2192 DBIRTH \u2192 NDATA/DDATA.',
			Math.max(1, PHASE_INDEX[phase] - 1),
			'Eclipse SparkplugB v3.0 §4.2 / MQTT 5.0',
		));
	}

	// ── 9j. OPC-UA SecurityPolicy.None ────────────────────────────────────────────
	const opcuaNoneIds = new Set(
		techDebtItems.filter(t => t.category === 'hardcoded-credential' && t.description?.includes('OPC-UA')).map(t => t.unitId),
	);
	for (const id of opcuaNoneIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'compliance';
		add(makeBlocker(
			id, 'security-key-material', 'blocking',
			'OPC-UA endpoint using SecurityPolicy.None — IEC 62443-3-3 / IEC 62541-6 violation',
			`This unit establishes an OPC-UA connection with SecurityPolicy.None or no security mode configured. ` +
			`In industrial networks this means all process data and commands travel in plaintext, ` +
			`violating IEC 62443-3-3 SR 3.1 (communication integrity) and IEC 62541-6 §6.7.`,
			'Configure Basic256Sha256 security policy with SignAndEncrypt mode and X.509 certificate-based authentication. ' +
			'Deploy an OPC-UA PKI infrastructure (issuer CA, client + server certificates). ' +
			'SecurityPolicy.None is only permissible for the discovery endpoint (port 4840/4843) per IEC 62541-6.',
			Math.max(1, PHASE_INDEX[phase] - 1),
			'IEC 62443-3-3 SR 3.1 / IEC 62541-6 §6.7',
		));
	}

	// ── 9k. GTP-U / Control-Plane mixing ──────────────────────────────────────────
	const gtpCpIds = new Set(
		techDebtItems.filter(t => t.category === 'protocol-state-machine-break' && t.description?.includes('GTP-U')).map(t => t.unitId),
	);
	for (const id of gtpCpIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'core-logic';
		add(makeBlocker(
			id, 'protocol-state-machine-break', 'blocking',
			'GTP-U User Plane processing mixed with NAS/RRC Control Plane — 5GC CU-UP/CU-CP split blocked',
			`This unit mixes GTP-U tunnelling / PFCP session management with NAS/RRC Control Plane signalling. ` +
			`This prevents the O-RAN CU-UP / CU-CP functional split required by 3GPP TS 38.401 §6.1.3 ` +
			`and blocks cloud-native NF deployment as separate microservices.`,
			'Decompose into: (1) CU-CP unit handling NAS/RRC/F1-AP signalling, ' +
			'(2) CU-UP unit handling GTP-U / SDAP / PDCP / PFCP. ' +
			'The split must be clean before translating to containerised NFs.',
			Math.max(1, PHASE_INDEX[phase] - 1),
			'3GPP TS 38.401 §6.1.3 CU-UP/CU-CP functional split',
		));
	}

	// ── 9l. O-RAN fronthaul latency violation ─────────────────────────────────────
	const fhLatencyIds = new Set(
		techDebtItems.filter(t => t.category === 'goose-protection-relay' && t.description?.includes('eCPRI')).map(t => t.unitId),
	);
	for (const id of fhLatencyIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'safety-critical';
		add(makeBlocker(
			id, 'goose-protection-relay', 'blocking',
			'O-RAN fronthaul IQ/eCPRI path routed via HTTP/REST — timing constraint violated',
			`This unit routes O-RAN U-Plane (IQ data / eCPRI) through HTTP or REST endpoints. ` +
			`O-RAN Option 7-2x requires one-way fronthaul latency ≤ 100 µs (IEC/IEEE 60802, Class B). ` +
			`HTTP/REST cannot meet this constraint — typical latency is milliseconds.`,
			'Separate U-Plane (eCPRI IQ data) from M-Plane (NETCONF/YANG management). ' +
			'Implement U-Plane using DPDK + AF_XDP or kernel bypass for sub-100 µs latency. ' +
			'Use IEEE 802.1AS-2020 (gPTP) for time synchronisation. ' +
			'Re-architect before translating the fronthaul processing units.',
			Math.max(1, PHASE_INDEX[phase] - 1),
			'O-RAN.WG4.CUS.0-v12.00 / IEC/IEEE 60802',
		));
	}

	// ── 9m. TSN gate schedule without gPTP ────────────────────────────────────────
	const tsnIds = new Set(
		techDebtItems.filter(t => t.category === 'hardware-dependency' && t.description?.includes('TSN')).map(t => t.unitId),
	);
	for (const id of tsnIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'integration';
		add(makeBlocker(
			id, 'e2e-protection-gap', 'blocking',
			'IEEE 802.1Qbv gate schedule configured without gPTP time synchronisation',
			`This unit configures a TSN Qbv gate schedule (TAPRIO) but has no IEEE 802.1AS (gPTP) ` +
			`time synchronisation setup. Without global time synchronisation, all talkers and listeners ` +
			`operate on unsynchronised clocks and the scheduled traffic windows become meaningless.`,
			'Initialise gPTP (linuxptp / ptpd2 in gPTP mode) on all TSN-capable interfaces before ' +
			'configuring TAPRIO qdiscs. Ensure grandmaster clock quality (PRTC Class A per ITU-T G.8272.1). ' +
			'Add gPTP initialisation as a prerequisite task in the migration roadmap.',
			Math.max(1, PHASE_INDEX[phase] - 1),
			'IEEE 802.1AS-2020 / IEC/IEEE 60802 TSN Profile for Industrial Automation',
		));
	}

	// ── 9n. SIL-rated FB without diagnostic output ────────────────────────────────
	const silFbIds = new Set(
		techDebtItems.filter(t => t.category === 'misra-c-critical-violation' && t.description?.includes('PLCopen Safety FB')).map(t => t.unitId),
	);
	for (const id of silFbIds) {
		const unit  = unitMap.get(id);
		if (!unit) { continue; }
		const phase = phaseAssignments.get(id)?.phaseType ?? 'safety-critical';
		add(makeBlocker(
			id, 'sis-sil-downgrade', 'blocking',
			'PLCopen Safety Function Block without diagnostic output monitoring — IEC 62061 §6.7.6',
			`This unit calls a PLCopen Safety FB (SF_EmergencyStop, SF_SafelyLimitedSpeed, etc.) but does not ` +
			`monitor the DiagCode / FaultState / ErrorID output. Unhandled diagnostic codes mean faults go ` +
			`undetected, reducing the effective SIL level of the safety function.`,
			'Wire all Safety FB diagnostic outputs (DiagCode, FaultState, ErrorID) to a safety-rated fault handler. ' +
			'Log fault codes to the safety PLC event journal. ' +
			'Validate with a safety PLC test harness that all fault scenarios (E-stop wire break, limit violation) ' +
			'trigger the correct diagnostic response before cutover.',
			Math.max(1, PHASE_INDEX[phase] - 1),
			'IEC 62061 §6.7.6 / PLCopen Safety Part 1 §5.2',
		));
	}

	// ── 9. Missing schema mapping for regulated schemas ────────────────────────
	for (const unitId of regulatedSchemaUnits) {
		const unit    = unitMap.get(unitId);
		if (!unit) { continue; }
		const pairing = bestPairing.get(unitId);
		if (!pairing) {
			const phase = phaseAssignments.get(unitId)?.phaseType ?? 'schema';
			add(makeBlocker(
				unitId, 'missing-schema-mapping', 'warning',
				'Regulated schema with no target mapping',
				`This unit contains a regulated-field data schema (table / FD / entity) but no ` +
				`target-side equivalent was found during cross-project pairing.`,
				'Create the target data schema (migration script, ORM entity, etc.) and ensure ' +
				'all regulated field names and types are correctly mapped. ' +
				'Document the field mapping for compliance purposes.',
				PHASE_INDEX[phase],
			));
		}
	}

	// ── 10. Blocking GRC violations (not already handled by compliance orderer) ─
	for (const unit of units) {
		if (!blockingFiles.has(unit.legacyFilePath)) { continue; }
		const phase = phaseAssignments.get(unit.id)?.phaseType ?? 'compliance';
		const key = `${unit.id}:blocking-grc-violation`;
		if (!seen.has(key)) {
			add(makeBlocker(
				unit.id, 'blocking-grc-violation',
				unit.riskLevel === 'critical' ? 'blocking' : 'warning',
				'Blocking GRC violation',
				`This unit's source file has one or more blocking-severity GRC violations. ` +
				`Migration cannot proceed until these violations are resolved or formally waived.`,
				'Fix the GRC violation(s) in the source code, re-run the GRC engine to clear them, ' +
				'then re-run Stage 1 discovery before resuming migration.',
				PHASE_INDEX[phase],
			));
		}
	}

	return blockers;
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

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
