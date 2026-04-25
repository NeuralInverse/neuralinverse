/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # NeuralInverse Modernisation — Core Types
 *
 * Central type definitions for the modernisation workflow engine.
 * These types flow through all five stages: Discovery \u2192 Planning \u2192 Migration \u2192 Validation \u2192 Cutover.
 *
 * ## Design Principles
 *
 * - **Safety-first**: Every migration unit carries its compliance fingerprint at all times.
 * - **Approval-gated**: Nothing moves to `committed` without an explicit approval record.
 * - **Audit-complete**: Every state transition is recorded with enough context to reconstruct the decision.
 *
 * ## Domain Focus
 *
 * This platform targets **firmware** and **industrial** modernisation:
 *   - Firmware: bare-metal C/C++ \u2192 RTOS (FreeRTOS / Zephyr), HAL abstraction, MISRA-C compliance
 *   - Industrial: PLC / IEC 61131-3 \u2192 IPC, SCADA modernisation, OT/IT convergence, OPC-UA migration
 *   - Safety: IEC 61508 / IEC 62443 / MISRA-C / AUTOSAR compliance gating
 */


// ─── Modernisation.inverse Project File ──────────────────────────────────────

/** Filename written to both project roots when a modernisation session is created. */
export const MODERNISATION_INVERSE_FILENAME = 'Modernisation.inverse';

/**
 * Schema for the `Modernisation.inverse` file written to the root of each project.
 *
 * This file is the source of truth for pairing two projects in a modernisation
 * session. It is NOT AI-generated — it is written by the NeuralInverse IDE when
 * the user creates a Modernisation Project, and read back to restore sessions.
 *
 * Example (legacy side):
 * ```json
 * {
 *   "neuralInverseModernisation": true,
 *   "version": "1",
 *   "role": "legacy",
 *   "projectName": "ACME-COBOL",
 *   "pairedProject": { "role": "modern", "name": "acme-ts", "uri": "file:///..." },
 *   "sessionId": "b3f8c21a",
 *   "createdAt": 1742300000000
 * }
 * ```
 */
/**
 * v2: supports N sources + M targets (1:1, 1:N, N:1, N:M topologies).
 * v1 shape is still accepted by openExistingProject for backwards compatibility.
 *
 * Example (firmware bare-metal source side):
 * ```json
 * {
 *   "neuralInverseModernisation": true,
 *   "version": "2",
 *   "role": "source",
 *   "projectLabel": "STM32-H743-BSP",
 *   "pairedProjects": [{ "role": "target", "label": "stm32-zephyr-bsp", "uri": "file:///..." }],
 *   "migrationPattern": "bare-metal-to-rtos",
 *   "sessionId": "c4d9e82b",
 *   "createdAt": 1744000000000
 * }
 * ```
 */
export interface IModernisationProjectFile {
	readonly neuralInverseModernisation: true;
	readonly version: '1' | '2';

	// ── v2 fields ────────────────────────────────────────────────────────────
	/** Whether this project is a source (legacy/input) or target (modern/output). */
	readonly role?: 'source' | 'target';
	/** User-defined label for this project (e.g. "Legacy Monolith", "PaymentService"). */
	readonly projectLabel?: string;
	/** Unique ID for this project within the session. */
	readonly projectId?: string;
	/** All projects on the OTHER side of this session. */
	readonly pairedProjects?: ReadonlyArray<{
		readonly role: 'source' | 'target';
		readonly label: string;
		readonly uri: string;
		readonly id: string;
	}>;
	/** The migration pattern chosen for this session. */
	readonly migrationPattern?: string;

	// ── v1 compat fields (read-only, not written in v2) ──────────────────────
	readonly projectName?: string;
	readonly pairedProject?: { readonly role: 'legacy' | 'modern'; readonly name: string; readonly uri: string };

	readonly sessionId: string;
	readonly createdAt: number;
}


// ─── Stage / Status ───────────────────────────────────────────────────────────

export type MigrationRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type MigrationUnitStatus =
	| 'pending'         // Not yet started
	| 'in-progress'     // Agent is translating
	| 'review'          // Translation complete, awaiting developer review
	| 'flagged'         // Fingerprint divergence detected, awaiting compliance approval
	| 'approved'        // Approved by required authority, ready to commit
	| 'committed'       // Written to disk and committed to version control
	| 'validated'       // Output equivalence test passed (Stage 4)
	| 'complete';       // All stages done for this unit

export type MigrationUnitType =
	// Firmware / embedded
	| 'function'            // C/C++ function
	| 'isr'                 // Interrupt Service Routine
	| 'rtos-task'           // RTOS task / thread
	| 'hal-driver'          // HAL peripheral driver
	| 'device-driver'       // Low-level device driver
	| 'register-map'        // Peripheral register map (SVD-derived)
	| 'peripheral'          // Peripheral grouping (SVD peripheral node)
	| 'linker-section'      // Linker script region
	// Industrial / IEC 61131-3
	| 'program'             // IEC 61131-3 PROGRAM or top-level program unit
	| 'function-block'      // IEC 61131-3 Function Block (FB)
	| 'ladder-rung'         // Ladder Logic rung
	| 'structured-text-fn'  // Structured Text function / program
	| 'safety-function'     // Safety-rated function (SIL-classified)
	// Generic (used by JVM, PL/SQL, and retained-language decomposers)
	| 'module'              // Generic module / translation unit
	| 'class'               // C++ class or Java/Kotlin class
	| 'section'             // COBOL section / PL/SQL body section (retained)
	| 'paragraph';          // COBOL paragraph (retained for hybrid projects)


// ─── Code Range ───────────────────────────────────────────────────────────────

/** Inclusive line/column range within a file. Lines and columns are 1-based. */
export interface ICodeRange {
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}


// ─── Compliance Fingerprint ───────────────────────────────────────────────────

/**
 * The compliance fingerprint — the structured regulatory intent of a unit of code.
 *
 * This is NOT a hash. It is a structured JSON artifact that represents what the code
 * does from a regulatory perspective. Two fingerprints are compared structurally to
 * determine whether regulatory meaning changed during translation.
 */
export interface IComplianceFingerprint {
	unitId: string;
	extractedAt: number;                    // Unix timestamp
	sourceLanguage: string;                 // e.g. 'cobol', 'java', 'typescript'

	/** Layer 1: deterministic structural extraction (no LLM) */
	regulatedFields: IRegulatedField[];

	/** Layer 1: logical invariants that can be verified in Stage 4 */
	invariants: ILogicalInvariant[];

	/** Layer 2: LLM-extracted business rules in plain English */
	semanticRules: ISemanticRule[];

	/** Layer 2: which compliance domains this unit touches */
	complianceDomains: string[];

	/** Whether Layer 2 (LLM) extraction has completed */
	llmExtractionComplete: boolean;

	/**
	 * FNV-1a hash of the source text this fingerprint was computed from.
	 * Used by the fingerprint cache to detect when the source has changed
	 * and a fresh extraction is required.
	 */
	contentHash?: string;

	/**
	 * Schema version of this fingerprint.
	 * Incremented when extraction logic changes (new patterns, new invariant types).
	 * Fingerprints with an older schema version are re-extracted automatically.
	 */
	schemaVersion?: number;
}

/** A field identified as regulated by the deterministic extractor */
export interface IRegulatedField {
	/** Name as it appears in source (e.g. "WS-ACCT-BAL", "accountBalance") */
	fieldName: string;
	/** Normalized semantic attribute (e.g. "account_balance") */
	regulatedAttribute: string;
	/** Which compliance framework classifies this as regulated */
	framework: string;
	/** What the unit does with this field */
	operation: 'read' | 'write' | 'calculate' | 'transmit' | 'store' | 'compare';
	/** Location in source where this field is used */
	location?: ICodeRange;
	/** COBOL-specific: whether this is a COMP-3 packed decimal field */
	isPackedDecimal?: boolean;
}

/** A logical invariant that must hold after translation */
export interface ILogicalInvariant {
	/** Plain English description of the constraint */
	description: string;
	/** e.g. "rounding_behaviour", "decimal_precision", "null_handling" */
	invariantType: string;
	/** Whether this invariant can be automatically tested in Stage 4 */
	testable: boolean;
	/** Location in source where the invariant originates */
	location?: ICodeRange;
}

/** A business rule extracted by the LLM semantic layer */
export interface ISemanticRule {
	/** Plain English: "Calculates late fee if balance exceeds threshold after grace period" */
	description: string;
	/** e.g. "fee_calculation", "interest_accrual", "transaction_settlement" */
	domain: string;
	/**
	 * Whether this rule MUST be preserved exactly in the modern translation.
	 * Critical for rules that directly touch regulated outcomes.
	 */
	preservationRequired: boolean;
	/** Which regulated fields this rule operates on */
	involvedFields: string[];
}


// ─── Fingerprint Comparison ───────────────────────────────────────────────────

/**
 * The result of comparing legacy and modern fingerprints.
 * This is what drives the compliance strip UI and the approval gate.
 */
export interface IFingerprintComparison {
	unitId: string;
	comparedAt: number;
	legacyFingerprint: IComplianceFingerprint;
	modernFingerprint: IComplianceFingerprint;

	/** 0–100. 100 = perfect match. Below threshold triggers a warning or block. */
	matchPercentage: number;

	divergences: IFingerprintDivergence[];

	/**
	 * - `pass`: No divergences, or only non-regulated differences.
	 * - `warning`: Differences found but none are blocking (auto-approve eligible if low risk).
	 * - `blocked`: Regulatory logic changed — requires compliance officer approval.
	 */
	overallResult: 'pass' | 'warning' | 'blocked';
}

export type DivergenceType =
	| 'field-removed'       // A regulated field present in legacy is absent in modern
	| 'field-added'         // A regulated field is introduced in modern that was not in legacy
	| 'field-operation-changed' // A field operation changed (e.g. read \u2192 write)
	| 'rule-changed'        // A semantic rule description changed significantly
	| 'rule-removed'        // A semantic rule present in legacy is absent in modern
	| 'invariant-violated'  // A logical invariant was not preserved
	| 'domain-added'        // A new compliance domain is touched in modern (not in legacy)
	| 'domain-removed';     // A compliance domain present in legacy is absent in modern

export interface IFingerprintDivergence {
	type: DivergenceType;
	description: string;
	/** Location in the legacy source */
	legacyLocation?: ICodeRange;
	/** Location in the modern source */
	modernLocation?: ICodeRange;
	severity: 'info' | 'warning' | 'blocking';
	/** If true, a compliance officer must explicitly approve this before the unit can proceed */
	requiresComplianceApproval: boolean;
}


// ─── Migration Unit ───────────────────────────────────────────────────────────

/**
 * A single atomic unit of the migration.
 * For COBOL: one paragraph, section, or program.
 * Status transitions are strictly ordered and gated by approvals.
 */
export interface IMigrationUnit {
	id: string;
	legacyFilePath: string;
	legacyRange: ICodeRange;
	unitName: string;               // e.g. "CALC-LATE-FEE", "PaymentProcessor"
	unitType: MigrationUnitType;
	riskLevel: MigrationRiskLevel;
	status: MigrationUnitStatus;

	/** Units that must be migrated before this one (dependency order) */
	dependencies: string[];
	/** Units that depend on this one */
	dependents: string[];

	/** Fingerprint of the legacy unit — established in Stage 1 */
	legacyFingerprint?: IComplianceFingerprint;

	/** Path and range of the translated modern file (Stage 3+) */
	modernFilePath?: string;
	modernRange?: ICodeRange;

	/** Fingerprint of the modern translation — built in Stage 3 */
	modernFingerprint?: IComplianceFingerprint;

	/** Latest comparison result between legacy and modern fingerprints */
	lastComparison?: IFingerprintComparison;

	/** Approval records for this unit (plan approval, translation approval, etc.) */
	approvals: IApprovalRecord[];

	/** Output equivalence test result (Stage 4) */
	equivalenceResult?: IEquivalenceResult;
}


// ─── Approval ─────────────────────────────────────────────────────────────────

export type ApprovalType =
	| 'plan'                    // Approval of the migration roadmap before Stage 3 begins
	| 'translation'             // Developer approval of a translation unit
	| 'fingerprint-change'      // Compliance officer approval of a regulatory logic change
	| 'equivalence-override';   // Override of a failed equivalence test with documented rationale

export interface IApprovalRecord {
	id: string;
	unitId: string;
	approvalType: ApprovalType;
	approvedBy: string;             // User identity
	approvedAt: number;             // Unix timestamp
	rationale: string;
	/** Snapshot of the fingerprint comparison at the time of approval */
	fingerprintDiffAtApproval?: IFingerprintComparison;
	/** For Critical units: change management ticket reference (e.g. Jira, ServiceNow) */
	changeTicketRef?: string;
}


// ─── Output Equivalence (Stage 4) ────────────────────────────────────────────

export interface IEquivalenceResult {
	unitId: string;
	testedAt: number;
	testCaseCount: number;
	passCount: number;
	failCount: number;
	divergences: IOutputDivergence[];
	/** Path to the test evidence file included in the audit package */
	evidenceFilePath: string;
	/** Whether a developer has overridden this result with documented rationale */
	overridden: boolean;
	overrideApproval?: IApprovalRecord;
}

export type OutputDivergenceType =
	| 'value'           // Output value differs
	| 'rounding'        // Rounding behaviour differs (common with COMP-3 \u2192 floating point)
	| 'missing-record'  // A record present in legacy output is absent in modern
	| 'extra-record'    // A record present in modern output was not in legacy
	| 'checksum'        // File/batch checksum mismatch
	| 'precision';      // Decimal precision differs

export interface IOutputDivergence {
	testCaseId: string;
	inputDescription: string;
	legacyOutput: string;
	modernOutput: string;
	divergenceType: OutputDivergenceType;
}


// ─── Migration Phase (Stage 2) ────────────────────────────────────────────────

/**
 * Which structural phase a migration unit belongs to.
 * Phases execute in the order listed — dependencies are always satisfied
 * before higher phases begin.
 */
export type MigrationPhaseType =
	| 'foundation'      // Shared utilities, helper macros, base types — no external deps
	| 'bsp'             // Board Support Package layer: clocks, memory map, startup code
	| 'schema'          // Data schema / memory map setup (retained for hybrid projects)
	| 'core-logic'      // Core firmware / PLC logic — the bulk of the migration effort
	| 'hal-layer'       // HAL drivers, peripheral abstractions, RTOS integration
	| 'api-layer'       // External API surface / protocol adapters (Modbus, OPC-UA, CAN)
	| 'integration'     // External integrations: protocols (Modbus/OPC-UA/CAN), fieldbus
	| 'compliance'      // Compliance review / sign-off phase (retained for GRC pipelines)
	| 'safety-critical' // SIL-rated units, functional safety functions — sign-off required
	| 'cutover';        // System init / top-level orchestrators — migrate last

/** A grouped work package of units that can be migrated together in sequence. */
export interface IMigrationPhase {
	/** Stable ID: e.g. 'phase-1-foundation' */
	id: string;
	/** 1-based sequential index */
	index: number;
	phaseType: MigrationPhaseType;
	label: string;           // e.g. 'Phase 1: Foundation & Utilities'
	description: string;
	/** Ordered list of IMigrationUnit IDs in this phase (dependency-level order). */
	unitIds: string[];
	estimatedHoursLow: number;
	estimatedHoursHigh: number;
	riskDistribution: Record<MigrationRiskLevel, number>;
	/** If true, a safety / compliance sign-off is required before this phase can proceed. */
	hasComplianceGate: boolean;
	/** If true, HIL/SIL validation tests must pass at the end of this phase. */
	hasValidationGate: boolean;
	/** Number of migration blockers that must be resolved before this phase can start. */
	blockerCount: number;
	/** If true, any unit in this phase exposes an API endpoint requiring compatibility verification. */
	hasAPICompatibilityGate: boolean;
	/** AI or heuristic safety/compliance notes for this specific phase. */
	complianceNotes: string;
}


// ─── Critical Path Node (Stage 2) ────────────────────────────────────────────

/** A node in the CPM (Critical Path Method) schedule for the roadmap. */
export interface ICriticalPathNode {
	unitId: string;
	unitName: string;
	phaseType: MigrationPhaseType;
	/** Effort estimate upper bound (hours) used as CPM task duration. */
	effortHoursHigh: number;
	/** Dependency depth level: 0 = no deps, higher = deeper in the DAG. */
	level: number;
	/** Whether this unit is on the critical path (zero float). */
	isCritical: boolean;
	/** Earliest possible start (hours from project start) — CPM forward pass. */
	earliestStart: number;
	earliestFinish: number;
	/** Latest allowable start without delaying the project — CPM backward pass. */
	latestStart: number;
	latestFinish: number;
	/** Total float: latestStart − earliestStart. Zero = on critical path. */
	slack: number;
}


// ─── Migration Blockers (Stage 2) ────────────────────────────────────────────

export type MigrationBlockerType =
	// Generic
	| 'god-unit'                     // Unit is too large/complex to translate as-is \u2192 split first
	| 'no-target-equivalent'         // Critical unit with no cross-project pairing
	| 'hardcoded-credential'         // Security risk: credentials or keys must be externalised
	| 'circular-dependency'          // Cyclic dependency — requires refactoring before migration
	| 'xlarge-effort-critical'       // xlarge effort + critical risk — needs dedicated sprint
	| 'blocking-grc-violation'       // Safety/GRC blocking violation on a critical unit
	| 'unbounded-loop'               // Potential infinite loop — needs explicit termination
	| 'deep-nesting'                 // Nesting >7 — structural refactoring recommended
	| 'implicit-type-coercion'       // Precision/type risk between source and target language
	// Firmware-specific
	| 'unsafe-pointer-arithmetic'    // Raw pointer cast to peripheral address — must use HAL API
	| 'isr-reentrance-risk'          // ISR accesses shared data without critical section
	| 'misra-c-critical-violation'   // MISRA-C:2012 mandatory rule violation blocking translation
	| 'hardware-dependency'          // Logic tightly coupled to a specific MCU register — no HAL equivalent
	| 'no-hal-equivalent'            // Peripheral operation with no existing HAL mapping
	| 'watchdog-gap'                 // Long-running function missing watchdog refresh
	| 'timing-constraint'            // Hard real-time deadline that may be violated after migration
	// Industrial-specific
	| 'plc-vendor-extension'         // Vendor-specific PLC instruction with no IEC 61131-3 equivalent
	| 'safety-integrity-level'       // SIL-rated function requiring formal verification
	// Automotive-specific
	| 'autosar-rte-dependency'       // Classic RTE Rte_Read/Write with no Adaptive ara::com mapping
	| 'e2e-protection-gap'           // End-to-end protection profile missing in target stack
	| 'asil-decomposition-break'     // ASIL-D unit split without documented ASIL-B+B decomposition
	| 'can-signal-scaling-mismatch'  // CAN DBC signal factor/offset not preserved in CANopen OD mapping
	// Telecom-specific
	| 'security-key-material'        // Cryptographic key material hard-coded or inline (3GPP AS/NAS keys)
	| 'protocol-state-machine-break' // Non-serialisable protocol state (e.g. RRC state, NAS EMM) in migration
	| 'ttcn3-verdict-suppression'    // TTCN-3 verdict.inconc suppressed without test coverage note
	// Energy / OT-specific
	| 'goose-protection-relay'       // IEC 61850 GOOSE trip path bridged via OPC-UA (prohibited)
	| 'dnp3-secure-auth-gap'         // DNP3 Secure Auth v5 SA_CHALLENGE missing in modernised stack
	| 'sis-sil-downgrade'            // SIS/ESD SIL level would be reduced after modernisation
	// Telecom extended
	| 'oran-fronthaul-timing'        // O-RAN eCPRI fronthaul timing class requirement not met
	| 'gsma-nesas-scas'              // GSMA NESAS SCAS security assessment not on record for 5G NF
	| 'gtp-up-cp-mixing'             // GTP-U user-plane traffic mixed with GTP-C control-plane (prohibited)
	// Industrial / fieldbus extended
	| 'sparkplug-birth-missing'      // MQTT Sparkplug B NBIRTH/DBIRTH payload missing in modernised publisher
	| 'opcua-security-none'          // OPC-UA session configured with SecurityMode=None in production context
	| 'tsn-gptp-missing'             // TSN deployment missing IEEE 802.1AS gPTP synchronisation verification
	| 'sil-fb-diagnostic-gap'        // SIL-rated function block missing diagnostic coverage calculation (IEC 62061)
	| 'profinet-station-hardcoded'   // Profinet station name or IP address hard-coded (must use DCP/LLDP)
	| 'ethercat-timing-violation'    // EtherCAT IRT jitter exceeds 1 µs budget on target hardware
	| 'canopen-sdo-timeout'          // CANopen SDO timeout not handled — node may stall on bus error
	// Automotive extended
	| 'iso21434-tara-missing'        // ISO 21434 / UN R155 TARA not conducted for in-vehicle software
	| 'aspice-process-gap'           // A-SPICE Level 2 process evidence missing for OEM supplier approval
	// Avionics / railway
	| 'do178c-independence-missing'  // DO-178C / EN 50128 IV&V or MC/DC coverage evidence absent
	// Critical infrastructure extended
	| 'nerc-cip-supply-chain'        // NERC CIP-013-2 supply chain risk management plan not on record
	| 'iec62351-comms-security'      // IEC 62351 power system communications security profile not verified
	// Legacy / hybrid project blockers
	| 'goto-usage'                   // GOTO statements requiring control-flow refactoring before migration
	| 'missing-schema-mapping';      // Regulated-field schema has no target-side equivalent

export interface IMigrationBlocker {
	unitId: string;
	blockerType: MigrationBlockerType;
	severity: 'warning' | 'blocking';
	title: string;
	description: string;
	recommendedAction: string;
	/** This blocker must be resolved before the phase at this index can start. */
	resolveByPhaseIndex: number;
	/** IEC/MISRA rule reference (if applicable), e.g. 'MISRA-C:2012 Rule 11.4' */
	ruleReference?: string;
}


// ─── Pairing Work Items (Stage 2) ────────────────────────────────────────────

/** Links a source unit to its target-side counterpart for the developer's work queue. */
export interface IPairingWorkItem {
	sourceUnitId: string;
	sourceUnitName: string;
	targetUnitId?: string;
	targetUnitName?: string;
	/** 0–1 pairing confidence score from cross-project pairer. */
	confidenceScore?: number;
	/** How the pairing was determined (e.g. 'exact-name', 'token-overlap'). */
	matchReason?: string;
	estimatedHoursLow: number;
	estimatedHoursHigh: number;
	migrationStatus: 'not-started' | 'in-progress' | 'completed' | 'no-target';
	/** Whether the target unit already has a compliance fingerprint from Stage 1. */
	targetHasFingerprint: boolean;
	/** Index of the phase this work item belongs to. */
	phaseIndex: number;
}


// ─── Migration Roadmap (Stage 2) ─────────────────────────────────────────────

export interface IMigrationRoadmap {
	id: string;
	createdAt: number;
	legacyRootPath: string;
	targetLanguage: string;             // e.g. 'typescript', 'java', 'python'
	units: IMigrationUnit[];
	totalUnits: number;
	unitsByRisk: Record<MigrationRiskLevel, number>;
	planApproved: boolean;
	planApprovalRecord?: IApprovalRecord;

	// ── Stage 2 enrichments ─────────────────────────────────────────────────

	/** Ordered migration phases grouping units by structural role. */
	phases?: IMigrationPhase[];

	/** CPM-derived critical path nodes (zero-slack units that control project duration). */
	criticalPath?: ICriticalPathNode[];

	/** Migration blockers that must be resolved before or during the roadmap. */
	migrationBlockers?: IMigrationBlocker[];

	/** Source↔target pairing work items for the developer's task queue. */
	pairingWorkItems?: IPairingWorkItem[];

	/** Total estimated effort range across all units. */
	estimatedHoursLow?: number;
	estimatedHoursHigh?: number;

	/** AI-generated compliance narrative covering regulated data and GRC constraints. */
	complianceNotes?: string;

	/** AI-generated risk narrative covering the highest-risk migration concerns. */
	riskNarrative?: string;

	/** AI overall effort assessment for the whole project. */
	aiEstimatedEffort?: 'low' | 'medium' | 'high';

	/** Whether this roadmap was generated with AI guidance or deterministic fallback. */
	generationMethod?: 'ai-guided' | 'deterministic';
}


// ─── Audit Events ─────────────────────────────────────────────────────────────

export type ModernisationAuditEventType =
	| 'discovery-complete'
	| 'roadmap-generated'
	| 'plan-approved'
	| 'translation-started'
	| 'fingerprint-divergence'
	| 'approval-granted'
	| 'unit-committed'
	| 'equivalence-pass'
	| 'equivalence-fail'
	| 'cutover-approved'
	| 'production-divergence'
	| 'rollback-triggered';

export interface IModernisationAuditEvent {
	id: string;
	eventType: ModernisationAuditEventType;
	unitId?: string;
	timestamp: number;
	actorId?: string;
	payload: Record<string, unknown>;
	/** Hash of previous event — forms the tamper-evident chain */
	previousEventHash: string;
}


// ─── Shared Context (Two-Window Model) ───────────────────────────────────────

/**
 * The shared context that all platform services see simultaneously.
 * Both editor panes (legacy + modern) read from and write to this context.
 * NeuralInverseChecks, Agents, Enclave, and Void all subscribe to it.
 */
export interface IModernisationSessionContext {
	sessionId: string;
	roadmapId: string;
	currentUnitId: string | null;
	currentUnit: IMigrationUnit | null;
	currentComparison: IFingerprintComparison | null;
	/** Whether the modern pane is in draft (pending approval) or committed state */
	modernPaneState: 'draft' | 'approved' | 'committed';
}
