/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Modernisation Knowledge Base \u2014 Core Types (Phase 0)
 *
 * The knowledge base is the agent's persistent working memory for the entire migration.
 * Everything the AI needs to translate a unit is here. Everything it learns is stored here.
 * Humans make decisions here once \u2014 those decisions propagate everywhere automatically.
 *
 * This is NOT a stats dashboard. It is a data platform queried and written by agents.
 *
 * ## Domain
 *
 * This KB is purpose-built for firmware and industrial modernisation:
 *   - Firmware: bare-metal C/C++ \u2192 RTOS/HAL (FreeRTOS, Zephyr, STM32 HAL, NXP SDK)
 *   - Industrial: IEC 61131-3 PLC \u2192 IPC, SCADA, OPC-UA, Modbus \u2192 MQTT/OPC-UA
 *   - Safety-critical: IEC 61508, IEC 62443, MISRA-C, AUTOSAR compliance gating
 *
 * Architecture:
 *   IModernisationKnowledgeBase
 *     \u251C\u2500\u2500 units:     Map<id, IKnowledgeUnit>     \u2014 atoms of the migration
 *     \u251C\u2500\u2500 files:     Map<path, IKnowledgeFile>   \u2014 source file registry
 *     \u251C\u2500\u2500 decisions: IDecisionLog                \u2014 type mappings, naming, interpretations
 *     \u251C\u2500\u2500 glossary:  IBusinessGlossary           \u2014 what the AI has learned about this codebase
 *     \u251C\u2500\u2500 progress:  IProgressState              \u2014 what is done, in-progress, blocked
 *     \u251C\u2500\u2500 auditLog:  IKnowledgeAuditEntry[]      \u2014 tamper-evident change trail
 *     \u2514\u2500\u2500 ext:       IKnowledgeBaseExtensions    \u2014 production features (locks, drift, etc.)
 */

import {
	ICodeRange,
	IComplianceFingerprint,
	IFingerprintComparison,
	IApprovalRecord,
	IEquivalenceResult,
} from './modernisationTypes.js';


// \u2500\u2500\u2500 Unit Type \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * The structural type of a unit \u2014 covers all source languages.
 */
export type UnitType =
	// Firmware / embedded C/C++
	| 'function'             // C/C++ function
	| 'isr'                  // Interrupt Service Routine (e.g. void UART1_IRQHandler(void))
	| 'rtos-task'            // RTOS task / thread body
	| 'hal-driver'           // HAL peripheral driver (e.g. HAL_UART_Init)
	| 'device-driver'        // Low-level device driver (SPI, I2C, CAN)
	| 'register-map'         // SVD-derived peripheral register map
	| 'linker-section'       // Linker script memory region
	| 'macro'                // C preprocessor macro or inline function
	| 'include'              // Header / include file
	// Industrial / IEC 61131-3
	| 'function-block'       // IEC 61131-3 Function Block (FB)
	| 'ladder-rung'          // Ladder Logic rung
	| 'structured-text-fn'   // Structured Text function or program unit
	| 'safety-function'      // Safety-rated function (SIL-classified)
	// OOP (C++)
	| 'class'
	| 'interface'
	| 'enum'
	// Modules / components
	| 'module'
	| 'component'
	| 'service'
	| 'subroutine'
	// Generic fallback
	| 'unknown';


// \u2500\u2500\u2500 Unit Status \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * The lifecycle state of a knowledge unit.
 * Every transition is recorded in the audit log.
 */
export type UnitStatus =
	| 'pending'       // Discovered, not yet processed
	| 'resolving'     // Dependencies being expanded inline
	| 'ready'         // Resolved \u2014 ready for AI translation
	| 'translating'   // Agent is actively working on this unit
	| 'review'        // Draft complete, awaiting human review
	| 'flagged'       // Fingerprint divergence \u2014 requires approval
	| 'approved'      // Translation approved, ready to commit
	| 'committing'    // Being written to disk (in-flight commit operation)
	| 'committed'     // Written to disk + committed to VCS
	| 'validating'    // Equivalence test running
	| 'validated'     // Equivalence test passed
	| 'complete'      // All stages done \u2014 unit migration finished
	| 'skipped'       // Deliberately excluded (out of scope)
	| 'blocked';      // Cannot proceed \u2014 human action required


// \u2500\u2500\u2500 Risk Level \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';


// \u2500\u2500\u2500 Business Rules \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * A plain-English business rule extracted from a unit.
 * Extracted by the LLM (or human) during Stage 1 analysis.
 */
export interface IBusinessRule {
	id: string;
	description: string;            // "Calculates late fee if balance exceeds credit limit after grace period"
	domain: string;                 // e.g. 'fee_calculation', 'customer_management'
	preservationRequired: boolean;  // Must this rule survive unchanged in the translation?
	involvedFields: string[];       // Source field names this rule operates on
	extractedBy: 'ai' | 'human';
	confidence: number;             // 0\u20131 (1 = human-confirmed)
}


// \u2500\u2500\u2500 Unit Interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * The public interface of a translated unit \u2014 what other units call.
 * Stored after translation so subsequent units can call it correctly.
 */
export interface IUnitInterface {
	unitId: string;
	targetLanguage: string;
	/** Exported function/class/method signatures in the target language */
	signatures: string[];
	/** Plain English: what this unit does (for LLM context injection) */
	summary: string;
	/** Input/output types expressed as target-language type names */
	inputTypes: string[];
	outputTypes: string[];
}


// \u2500\u2500\u2500 Knowledge Unit \u2014 The Atom of Migration \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * A single translatable unit of the migration.
 *
 * This is the central record the platform maintains per function/class/paragraph/program.
 * Agents query it, translate it, and write results back to it.
 */
export interface IKnowledgeUnit {
	id: string;

	// \u2500\u2500 Source \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	sourceFile: string;             // Absolute path to source file
	sourceRange: ICodeRange;        // Where in the file this unit starts/ends
	sourceLang: string;             // 'cobol' | 'plsql' | 'rpg' | 'java' | 'typescript' | ...
	sourceText: string;             // Raw source text (exactly as in file)
	/**
	 * Source with all dependencies (headers, includes, copybooks) expanded inline.
	 * This is what the AI reads \u2014 a complete, self-contained unit.
	 * Populated during the 'resolving' \u2192 'ready' transition.
	 */
	resolvedSource: string;

	// \u2500\u2500 Identity \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	name: string;                   // e.g. 'HAL_UART_Init', 'vMotorControlTask', 'FB_EmergencyStop'
	unitType: UnitType;
	riskLevel: RiskLevel;
	domain?: string;                // Functional domain this unit belongs to (e.g. 'motor-control', 'safety')

	// \u2500\u2500 Relationships \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	dependsOn: string[];            // IDs of units this unit calls/imports/copies
	usedBy: string[];               // IDs of units that call/import/copy this unit
	phaseId?: string;               // IMigrationPhase.id this unit belongs to

	// \u2500\u2500 What the AI knows \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	businessRules: IBusinessRule[];
	fingerprint?: IComplianceFingerprint;

	// \u2500\u2500 Translation state \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	status: UnitStatus;
	targetFile?: string;            // Absolute path to translated output file
	targetRange?: ICodeRange;
	targetText?: string;            // Draft or committed translated code
	targetInterface?: IUnitInterface; // Public interface after translation (for callers)

	// \u2500\u2500 Verification \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	fingerprintComparison?: IFingerprintComparison;
	equivalenceResult?: IEquivalenceResult;

	// \u2500\u2500 Approvals \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	approvals: IApprovalRecord[];

	// \u2500\u2500 Blocked state \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	blockedReason?: string;         // Why is this unit blocked? (shown to human)
	pendingDecisionId?: string;     // IPendingDecision.id that must be resolved first

	// \u2500\u2500 Metadata \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	createdAt: number;              // Unix timestamp (when this unit record was created)
	updatedAt: number;              // Unix timestamp (last mutation)
}


// \u2500\u2500\u2500 Knowledge File \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Metadata for a source file in the knowledge base.
 * Files contain one or more knowledge units.
 */
export interface IKnowledgeFile {
	path: string;                   // Absolute path
	language: string;
	unitIds: string[];              // IDs of IKnowledgeUnit entries in this file
	lineCount: number;
	sizeBytes: number;
	/** Whether this file has been fully decomposed into units */
	decomposed: boolean;
	discoveredAt: number;
}


// \u2500\u2500\u2500 Decision Log \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * The accumulated decisions made during the migration.
 * A decision made once applies to every subsequent unit automatically.
 * This is what makes the AI "smarter" about this codebase as migration progresses.
 */
export interface IDecisionLog {
	typeMapping: ITypeMappingDecision[];
	naming: INamingDecision[];
	ruleInterpret: IRuleInterpretation[];
	exclusions: IExclusionDecision[];
	patternOverrides: IPatternOverride[];
}

/** "PIC 9(15)V99 always maps to BigDecimal" */
export interface ITypeMappingDecision {
	id: string;
	sourceType: string;             // e.g. 'PIC 9(15)V99', 'NUMBER(15,2)'
	targetType: string;             // e.g. 'BigDecimal', 'decimal.Decimal'
	rationale: string;
	/** Unit IDs this applies to. Empty array = applies to ALL units. */
	appliesTo: string[];
	decidedBy: string;              // User identity or 'ai'
	decidedAt: number;
	confidence: number;             // 0\u20131
}

/** "WS-ACCT-BAL \u2192 accountBalance (domain: billing)" */
export interface INamingDecision {
	id: string;
	sourceName: string;             // Original name as in source
	targetName: string;             // Canonical name in target language
	domain: string;                 // Business domain this name belongs to
	decidedBy: string;
	decidedAt: number;
}

/** "This PERFORM loop is the commission calculation, not an error handler" */
export interface IRuleInterpretation {
	id: string;
	unitId: string;
	/** Unit IDs this applies to. Empty = only the named unitId. */
	appliesTo: string[];
	sourceText: string;             // The specific code snippet or pattern
	meaning: string;                // Plain English interpretation
	domain: string;
	decidedBy: string;
	decidedAt: number;
}

/** A unit or file deliberately excluded from migration scope */
export interface IExclusionDecision {
	id: string;
	pattern: string;                // Glob or unit ID
	reason: string;
	decidedBy: string;
	decidedAt: number;
}

/** "DBRT0010 is a utility \u2014 translate as a static helper, not a service" */
export interface IPatternOverride {
	id: string;
	pattern: string;                // Regex or exact name
	overrideType: 'translation-strategy' | 'risk-level' | 'unit-type' | 'domain';
	value: string;
	rationale: string;
	/** Unit IDs this applies to. Empty = pattern-matched by name. */
	appliesTo: string[];
	decidedBy: string;
	decidedAt: number;
}


// \u2500\u2500\u2500 Business Glossary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * What the AI has learned about this specific codebase.
 * Built up as units are analysed. Injected as context for subsequent translations.
 */
export interface IBusinessGlossary {
	terms: IBusinessTerm[];
	domains: IBusinessDomain[];
	patterns: IRecognisedPattern[];
}

/** A named concept extracted from the codebase */
export interface IBusinessTerm {
	term: string;                   // e.g. 'DEVICE_REG_MAP', 'vMotorSpeedPID', 'FB_SafetyDoor'
	meaning: string;                // Plain English
	domain: string;                 // e.g. 'motor-control', 'safety', 'communication'
	sourceLocs: string[];           // Unit IDs where this term appears
	extractedBy: 'ai' | 'human';
	confidence: number;             // 0\u20131
}

/** A business domain extracted from the codebase */
export interface IBusinessDomain {
	name: string;                   // e.g. 'motor-control', 'safety-io', 'fieldbus'
	description: string;
	unitIds: string[];              // Unit IDs that belong to this domain
	regulated: boolean;             // Whether this domain has safety/GRC implications
	complianceFrameworks: string[]; // 'iec-61508', 'iec-62443', 'misra-c', 'autosar', ...
}

/** A code pattern the AI recognised across multiple units */
export interface IRecognisedPattern {
	name: string;                   // e.g. 'end-of-day-settlement', 'input-validation'
	description: string;
	examples: string[];             // Unit IDs where this pattern appears
	targetPattern?: string;         // What this becomes in the target language
}


// \u2500\u2500\u2500 Progress State \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IProgressState {
	totalUnits: number;
	byStatus: Record<UnitStatus, number>;
	byRisk: Record<RiskLevel, number>;
	byPhase: IPhaseProgress[];
	blockedUnits: string[];         // Unit IDs waiting for human action
	pendingDecisions: IPendingDecision[];
}

export interface IPhaseProgress {
	phaseId: string;
	label: string;
	totalUnits: number;
	completedUnits: number;
	blockedUnits: number;
}

/**
 * A question the AI is asking the human.
 * The unit that raised this question is blocked until the human answers.
 */
export interface IPendingDecision {
	id: string;
	unitId: string;
	type: 'type-mapping' | 'naming' | 'rule-interpretation' | 'approval' | 'exclusion';
	question: string;               // The specific question the AI is asking
	context: string;                // Why the AI cannot decide alone (show to human)
	options?: string[];             // Suggested answers (human can pick or type their own)
	priority: 'low' | 'medium' | 'high' | 'blocking';
	raisedAt: number;
	resolvedAt?: number;
}


// \u2500\u2500\u2500 Audit Log \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type KnowledgeAuditEventType =
	| 'unit-discovered'
	| 'unit-resolved'
	| 'unit-status-changed'
	| 'translation-recorded'
	| 'fingerprint-recorded'
	| 'fingerprint-comparison-recorded'
	| 'decision-recorded'
	| 'business-rule-recorded'
	| 'glossary-term-recorded'
	| 'unit-blocked'
	| 'unit-approved'
	| 'unit-committed'
	| 'equivalence-recorded'
	| 'pending-decision-raised'
	| 'pending-decision-resolved'
	| 'unit-split'
	| 'units-merged'
	| 'checkpoint-created'
	| 'checkpoint-restored'
	| 'compliance-gate-checked'
	| 'drift-detected'
	| 'drift-acknowledged'
	| 'source-resolved'
	| 'unit-reverted'
	| 'dependency-added'
	| 'dependency-removed'
	| 'business-rule-updated'
	| 'business-rule-deleted';

export interface IKnowledgeAuditEntry {
	id: string;
	eventType: KnowledgeAuditEventType;
	unitId?: string;
	timestamp: number;
	actorId: string;                // User or 'ai' or 'system'
	summary: string;                // One-line human-readable description
	payload: Record<string, unknown>;
	/** FNV-1a hash of previous entry \u2014 tamper-evident chain */
	previousEntryHash: string;
}


// \u2500\u2500\u2500 Top-Level Knowledge Base \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * The complete persistent knowledge workspace for a modernisation session.
 *
 * One instance per modernisation session. Persists across IDE restarts.
 * Serialised to workspace storage as JSON. Indexed in memory for fast query.
 */
export interface IModernisationKnowledgeBase {
	/** Links to IModernisationSessionData.sessionId */
	sessionId: string;
	createdAt: number;
	updatedAt: number;

	/** Schema version for forward-compat migration */
	version: number;

	/** All units discovered in the source projects. Key = IKnowledgeUnit.id */
	units: Map<string, IKnowledgeUnit>;

	/** All source files registered. Key = absolute file path */
	files: Map<string, IKnowledgeFile>;

	/** Accumulated decisions \u2014 type mappings, naming, rule interpretations */
	decisions: IDecisionLog;

	/** What the AI has extracted about this codebase */
	glossary: IBusinessGlossary;

	/** Current migration progress */
	progress: IProgressState;

	/** Full audit trail of every change */
	auditLog: IKnowledgeAuditEntry[];

	/** Production extension data (locking, drift, conflicts, annotations, etc.) */
	ext: IKnowledgeBaseExtensions;
}

/** The current schema version \u2014 increment when breaking changes are made */
export const KNOWLEDGE_BASE_VERSION = 1;

/**
 * Serialisable form of IModernisationKnowledgeBase.
 * Maps become plain objects for JSON serialisation.
 */
export interface IModernisationKnowledgeBaseJSON
	extends Omit<IModernisationKnowledgeBase, 'units' | 'files'> {
	units: Record<string, IKnowledgeUnit>;
	files: Record<string, IKnowledgeFile>;
}


// \u2500\u2500\u2500 Unit Locking \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * A lock held on a unit by an agent or user for exclusive modification.
 * Prevents concurrent modification by other agents.
 * TTL = 0 means indefinite (manual release required).
 */
export interface IUnitLock {
	id:          string;   // Unique lock record ID
	unitId:      string;
	ownerId:     string;   // Agent ID or user ID holding the lock
	acquiredAt:  number;   // Unix timestamp when lock was acquired
	ttlMs:       number;   // How long the lock is valid (0 = indefinite)
}


// \u2500\u2500\u2500 Source Drift \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Tracks the content hash + mtime of a source file at scan time.
 * Used to detect when source files change after scanning (source drift).
 * Drift invalidates the resolvedSource and fingerprint of affected units.
 */
export interface ISourceFileVersion {
	filePath:    string;
	contentHash: string;   // FNV-1a hash of file content at scan time
	mtime:       number;   // File modification timestamp at scan time
	size:        number;   // File size in bytes at scan time
	recordedAt:  number;   // Unix timestamp when this version was recorded
}

/**
 * Alert raised when a source file has changed since it was scanned.
 * Units from this file need re-scanning and re-translation.
 */
export interface ISourceDriftAlert {
	id:              string;
	filePath:        string;
	baselineHash:    string;    // Content hash at scan time
	currentHash:     string;    // Current content hash
	baselineMtime:   number;    // Mtime at scan time
	currentMtime:    number;    // Current mtime
	detectedAt:      number;    // Unix timestamp
	acknowledgedAt?: number;    // Set when a human acknowledges the drift
	acknowledgedBy?: string;    // User who acknowledged
}


// \u2500\u2500\u2500 Decision Conflicts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * A conflict between two or more decisions that map the same source concept differently.
 * Must be resolved before the affected units can proceed.
 */
export interface IDecisionConflict {
	id:                     string;
	decisionType:           'type-mapping' | 'naming' | 'rule-interpretation' | 'pattern-override';
	sourceIdentifier:       string;              // The source type/name that conflicts
	conflictingDecisionIds: string[];            // All decision IDs in conflict
	conflictingValues:      string[];            // The distinct target values they map to
	detectedAt:             number;
	resolvedAt?:            number;
	resolvedBy?:            string;
	winningDecisionId?:     string;              // Which decision won the resolution
}


// \u2500\u2500\u2500 Unit Annotations \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type AnnotationKind =
	| 'review-note'          // Human reviewer note for the next person who looks at this unit
	| 'agent-note'           // Note left by an AI agent (e.g. "tricky loop logic at line 42")
	| 'blocker'              // Notes something that is blocking completion
	| 'context-injection'    // This content will be injected into LLM context before translating
	| 'compliance-note';     // Compliance/regulatory observation

/**
 * A free-text annotation attached to a unit.
 * Context-injection annotations are automatically injected into LLM context before translation.
 */
export interface IUnitAnnotation {
	id:        string;
	unitId:    string;
	content:   string;             // Free-form text (markdown supported)
	author:    string;             // User identity or 'ai' / 'system'
	kind:      AnnotationKind;
	createdAt: number;
	updatedAt: number;
}


// \u2500\u2500\u2500 Unit Tags \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * A custom label applied to units for ad-hoc grouping and filtering.
 * Unit \u2194 tag membership is managed by the annotation store (unitTags index).
 */
export interface IUnitTag {
	id:        string;    // Unique tag ID
	name:      string;    // Display name, e.g. 'sprint-1', 'team-A', 'priority-fix'
	color?:    string;    // Hex color for UI display, e.g. '#e0a84e'
	createdAt: number;
}


// \u2500\u2500\u2500 Compliance Gates \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Result of a compliance gate check for a unit.
 * Certain units (regulated domains, high/critical risk) cannot be approved
 * without passing all compliance requirements.
 */
export type ComplianceGateStatus = 'pass' | 'partial' | 'fail';

export interface IComplianceGateResult {
	unitId:          string;
	overallStatus:   ComplianceGateStatus;
	requirements:    IComplianceRequirement[];
	evaluatedAt:     number;
	failedCount:     number;
	passedCount:     number;
	pendingCount:    number;
	waivedCount:     number;
	/** Human-readable reasons why the gate is failing */
	blockerReasons:  string[];
}

export interface IComplianceRequirement {
	id:           string;
	label:        string;           // Short display name
	description:  string;           // What is required and why
	kind:         'auto' | 'human-required';  // Can be machine-checked or requires a human
	status:       'pass' | 'fail' | 'pending' | 'waived';
	evidence?:    string;           // What satisfied (or failed to satisfy) this requirement
}


// \u2500\u2500\u2500 Checkpoints \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Lightweight metadata for a KB checkpoint.
 * The actual snapshot data is stored separately in workspace storage.
 * (See impl/checkpoints.ts for storage layout.)
 */
export interface IKnowledgeBaseCheckpoint {
	id:           string;
	label:        string;           // Human-readable name, e.g. 'Before Phase 2 re-scan'
	createdAt:    number;
	triggeredBy:  string;           // User identity, agent ID, or 'auto'
	sessionId:    string;           // KB session this checkpoint belongs to
	unitCount:    number;           // Number of units at checkpoint time
	snapshotSize: number;           // Serialised KB size in bytes
}


// \u2500\u2500\u2500 Velocity \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * A single velocity data point \u2014 how many units were completed in a time window.
 */
export interface IVelocityDataPoint {
	recordedAt:     number;   // Unix timestamp (end of measurement window)
	periodStartMs:  number;   // Start of measurement window
	periodEndMs:    number;   // End of measurement window
	unitsCompleted: number;   // Units that entered a DONE status in this window
	unitsPerDay:    number;   // Derived: unitsCompleted / (window duration in days)
}

export interface IVelocityMetrics {
	/** Weighted rolling average (units/day) over windowDays */
	unitsPerDayRolling:  number;
	/** All-time average (units/day) since first data point */
	unitsPerDayAllTime:  number;
	/** Number of days used for the rolling average window */
	windowDays:          number;
	/** How many data points are in the store */
	dataPointCount:      number;
	totalUnits:          number;
	completedUnits:      number;
	remainingUnits:      number;
	/** Estimated Unix timestamp of project completion (undefined if no velocity yet) */
	estimatedEtaMs?:     number;
	/** Estimated days to completion (undefined if no velocity yet) */
	estimatedEtaDays?:   number;
	/** Trend compared to the prior window */
	trend:               'accelerating' | 'decelerating' | 'stable';
	lastUpdatedAt:       number;
}


// \u2500\u2500\u2500 KB Health \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type HealthIssueType =
	| 'orphaned-unit-ref'         // File references a unitId that doesn't exist in the units map
	| 'broken-dep-edge'           // Unit dependsOn/usedBy references a non-existent unit
	| 'stale-lock'                // A unit lock has expired or is very old
	| 'stale-unit'                // Unit stuck in non-terminal status too long
	| 'missing-resolved-source'   // Unit.resolvedSource is empty (dependency resolution pending)
	| 'orphaned-pending-decision' // Unit references a pendingDecisionId not in progress.pendingDecisions
	| 'decision-conflict'         // Unresolved decision conflicts detected
	| 'source-drift'              // Source file changed after unit was scanned
	| 'broken-audit-chain'        // Audit log hash chain integrity check failed
	| 'progress-drift'            // Progress counters don't match actual unit states
	| 'missing-fingerprint'       // High/critical unit has no compliance fingerprint
	| 'approved-without-gate';    // Unit is 'approved' but compliance gate not checked

export interface IKBHealthIssue {
	id:        string;            // Unique issue record ID
	type:      HealthIssueType;
	severity:  'info' | 'warning' | 'error';
	message:   string;
	unitId?:   string;            // If the issue is specific to a unit
	filePath?: string;            // If the issue is specific to a file
}

export interface IKBHealthReport {
	generatedAt:   number;
	isHealthy:     boolean;       // True if no error or warning issues
	issues:        IKBHealthIssue[];
	summary: {
		errorCount:   number;
		warningCount: number;
		infoCount:    number;
		totalIssues:  number;
	};
}


// \u2500\u2500\u2500 Work Package \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * An ad-hoc collection of units assigned to a team member or sprint.
 * Independent of phases \u2014 pure organisational grouping.
 * A unit can belong to at most one work package at a time.
 */
export interface IWorkPackage {
	id:           string;
	label:        string;
	description:  string;
	unitIds:      string[];
	assignedTo?:  string;   // User ID
	dueDate?:     number;   // Unix timestamp
	createdAt:    number;
	createdBy:    string;
	completedAt?: number;
}


// \u2500\u2500\u2500 Stale Unit Report \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IStaleUnitReport {
	unitId:         string;
	status:         UnitStatus;
	staleReason:    'stuck-translating' | 'stuck-review' | 'stuck-flagged' | 'long-blocked';
	stuckSinceMs:   number;   // How long in the stale state (milliseconds)
	lastModifiedAt: number;
}


// \u2500\u2500\u2500 Extended Knowledge Base \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Production extension data stored alongside the core KB.
 * Uses only JSON-serializable types (no Maps/Sets \u2014 those exist in impl-layer stores).
 *
 * Lifecycle: loaded from KB ext on init \u2192 each impl module builds its in-memory
 * store from these values \u2192 on save, stores are serialised back here.
 */
export interface IKnowledgeBaseExtensions {
	// \u2500\u2500 Source drift \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	/** Baseline file versions (filePath \u2192 ISourceFileVersion) */
	sourceVersions:   Record<string, ISourceFileVersion>;
	/** Active drift alerts (alertId \u2192 ISourceDriftAlert) */
	driftAlerts:      Record<string, ISourceDriftAlert>;

	// \u2500\u2500 Decision conflicts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	/** All detected decision conflicts */
	decisionConflicts: IDecisionConflict[];

	// \u2500\u2500 Annotations & tags \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	/** All unit annotations */
	annotations:      IUnitAnnotation[];
	/** All defined tags */
	tags:             IUnitTag[];
	/** Unit \u2194 tag membership (unitId \u2192 tagId[]) */
	unitTags:         Record<string, string[]>;

	// \u2500\u2500 Compliance gates \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	/** Most recent gate result per unit (unitId \u2192 result) */
	gateResults:      Record<string, IComplianceGateResult>;

	// \u2500\u2500 Work packages \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	/** All work packages */
	workPackages:     IWorkPackage[];

	// \u2500\u2500 Velocity \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	velocityDataPoints: IVelocityDataPoint[];

	// \u2500\u2500 Health check \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	lastHealthCheck?: IKBHealthReport;
}

/** Create a fresh empty IKnowledgeBaseExtensions */
export function emptyExtensions(): IKnowledgeBaseExtensions {
	return {
		sourceVersions:    {},
		driftAlerts:       {},
		decisionConflicts: [],
		annotations:       [],
		tags:              [],
		unitTags:          {},
		gateResults:       {},
		workPackages:      [],
		velocityDataPoints:[],
		lastHealthCheck:   undefined,
	};
}
