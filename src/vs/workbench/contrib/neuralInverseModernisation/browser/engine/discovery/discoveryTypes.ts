/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Discovery Types — Complete
 *
 * Every type used by the Stage 1 discovery pipeline and consumed by the
 * Stage 2 migration planner and the Modernisation Part UI.
 *
 * ## Type hierarchy
 *
 * ```
 * IDiscoveryResult
 *   ├─ sources: IProjectScanResult[]
 *   │     ├─ units: IMigrationUnit[]            (one per paragraph / class / function)
 *   │     ├─ grcSnapshot: IGRCSnapshot           (compliance violations)
 *   │     ├─ metadata: IProjectMetadata          (build system, frameworks, CI)
 *   │     ├─ dependencyEdges: IDependencyEdge[]  (import graph)
 *   │     ├─ callGraphEdges: ICallGraphEdge[]    (intra-project call graph)
 *   │     ├─ apiEndpoints: IAPIEndpoint[]        (REST/CICS/gRPC entry points)
 *   │     ├─ dataSchemas: IDataSchema[]          (tables, FDs, entities)
 *   │     ├─ techDebtItems: ITechDebtItem[]      (anti-patterns, dead code, clones)
 *   │     ├─ regulatedDataHits: IRegulatedDataHit[]  (PII/PCI patterns in source)
 *   │     ├─ externalDependencies: IExternalDependency[]  (third-party libs + CVEs)
 *   │     └─ stats: IDiscoveryStats
 *   ├─ targets: IProjectScanResult[]
 *   └─ crossProjectPairings: ICrossProjectPairing[]  (source ↔ target unit matches)
 * ```
 */

import { IMigrationUnit, MigrationRiskLevel, MigrationUnitType, ICodeRange, IComplianceFingerprint } from '../../../common/modernisationTypes.js';
import { IProjectTarget } from '../../modernisationSessionService.js';
import { ICheckResult } from '../../../../neuralInverseChecks/browser/engine/types/grcTypes.js';

export { IProjectTarget };


// ─── Progress ─────────────────────────────────────────────────────────────────

export interface IDiscoveryProgress {
	phase:
		| 'walking'
		| 'metadata'
		| 'fingerprinting'
		| 'grc-scan'
		| 'graph'
		| 'call-graph'
		| 'api-surface'
		| 'schema'
		| 'tech-debt'
		| 'pairing'
		| 'complete';
	filesScanned: number;
	totalFiles: number;
	unitsFound: number;
	currentFile: string;
	projectLabel: string;
}


// ─── GRC Snapshot ─────────────────────────────────────────────────────────────

/** Compact GRC violation record stored in the snapshot. */
export interface IGRCMiniViolation {
	ruleId: string;
	domain: string;
	severity: string;
	message: string;
	fileUri: string;
	line: number;
}

/** GRC compliance snapshot for one project, captured during discovery. */
export interface IGRCSnapshot {
	capturedAt: number;
	totalViolations: number;
	byDomain: Record<string, number>;
	blockingCount: number;
	bySeverity: Record<string, number>;
	topViolatedRules: Array<{ ruleId: string; count: number }>;
	violations: IGRCMiniViolation[];
}


// ─── Error Tracking ───────────────────────────────────────────────────────────

export interface IFileScanError {
	fileUri: string;
	reason: string;
	phase: 'walk' | 'read' | 'fingerprint' | 'grc' | 'complexity' | 'schema' | 'api';
}


// ─── Dependency Graph ─────────────────────────────────────────────────────────

/** A directed dependency edge (import/COPY/require/use) between two units. */
export interface IDependencyEdge {
	fromId: string;
	toId: string;
	importStatement: string;
	resolved: boolean;
}


// ─── Call Graph ───────────────────────────────────────────────────────────────

/** A directed call from one unit to another within the same project. */
export interface ICallGraphEdge {
	fromId: string;
	toId: string;
	/** Raw call expression (e.g. `PERFORM CALC-INTEREST`, `accountService.deposit()`) */
	callExpression: string;
	callType: 'direct' | 'dynamic' | 'virtual' | 'perform' | 'exec-cics';
	lineNumber: number;
	resolved: boolean;
}


// ─── API Surface ──────────────────────────────────────────────────────────────

export type APIEndpointKind =
	| 'rest-get' | 'rest-post' | 'rest-put' | 'rest-patch' | 'rest-delete'
	| 'rest-generic'
	| 'soap-operation'
	| 'grpc-method'
	| 'cics-transaction'
	| 'cics-link'
	| 'jcl-proc'
	| 'jcl-exec-pgm'
	| 'mq-listener'
	| 'batch-entry'
	| 'stored-proc-public'
	| 'event-handler'
	| 'graphql-resolver'
	| 'websocket-handler';

/** An externally accessible entry point detected in a unit. */
export interface IAPIEndpoint {
	/** ID of the `IMigrationUnit` that exposes this endpoint. */
	unitId: string;
	kind: APIEndpointKind;
	/** URL path (REST), operation name (SOAP/gRPC), or transaction code (CICS). */
	path?: string;
	httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ANY';
	operationName?: string;
	txCode?: string;
	/** Input type name (if detectable). */
	inputType?: string;
	/** Output/response type name (if detectable). */
	outputType?: string;
	lineNumber: number;
	/** Whether this endpoint is exposed over a public network vs. internal only. */
	isPublicFacing?: boolean;
}


// ─── Data Schema ──────────────────────────────────────────────────────────────

export type DataSchemaKind =
	| 'sql-table'
	| 'sql-view'
	| 'sql-procedure'
	| 'cobol-fd'
	| 'cobol-working-storage-record'
	| 'jpa-entity'
	| 'django-model'
	| 'sqlalchemy-model'
	| 'typeorm-entity'
	| 'prisma-model'
	| 'pydantic-model'
	| 'typescript-interface'
	| 'proto-message'
	| 'avro-schema'
	| 'xml-element'
	| 'json-schema-object';

/** A data structure / schema element detected in source code. */
export interface IDataSchema {
	unitId: string;
	kind: DataSchemaKind;
	name: string;
	fields: ISchemaField[];
	/** Whether any field is marked as regulated (PII/financial/health). */
	hasRegulatedFields: boolean;
	lineNumber: number;
}

export interface ISchemaField {
	name: string;
	dataType: string;
	nullable: boolean;
	isPrimaryKey: boolean;
	isForeignKey: boolean;
	maxLength?: number;
	precision?: number;
	scale?: number;
	/** Whether the field name / data type matches a regulated pattern. */
	isRegulated: boolean;
	regulatedReason?: string;
}


// ─── Technical Debt ───────────────────────────────────────────────────────────

export type TechDebtCategory =
	// ── Generic ──────────────────────────────────────────────────────────────
	| 'god-unit'              // Single unit doing too much (high CC + high LOC)
	| 'dead-code'             // Paragraph/function never called within this project
	| 'code-clone'            // Near-duplicate block detected
	| 'magic-number'          // Hardcoded numeric literal with no named constant
	| 'hardcoded-credential'  // Password/key/token literal in source
	| 'hardcoded-url'         // Production URL hardcoded in source
	| 'deep-nesting'          // Nesting depth > threshold
	| 'long-parameter-list'   // Function with many parameters
	| 'missing-error-handling'// No error handling in an I/O-intensive unit
	| 'commented-out-code'    // Large blocks of commented-out code
	| 'todo-fixme'            // TODO / FIXME / HACK / XXX markers
	| 'implicit-type-coercion'// Implicit type widening / precision loss risk
	| 'unbounded-loop'        // Loop with no visible termination condition
	| 'copy-paste-cobol'      // COBOL paragraphs with identical bodies (common in mainframe)
	| 'goto-usage'            // Use of GOTO / GOBACK in non-entry context
	| 'global-state'          // Mutable global/package-level state
	| 'no-unit-tests'         // Unit has no detected test coverage
	// ── Firmware / Embedded (IEC 61508 / MISRA-C) ────────────────────────────
	| 'unsafe-pointer-arithmetic'  // Raw MMIO pointer cast — MISRA-C R11.4
	| 'isr-reentrance-risk'        // ISR accesses shared variable without critical section
	| 'misra-c-critical-violation' // MISRA-C:2012 mandatory rule violation
	| 'hardware-dependency'        // Peripheral register access with no HAL equivalent
	| 'watchdog-gap'               // Function missing watchdog refresh (IEC 61508)
	// ── Automotive (ISO 26262 / AUTOSAR) ─────────────────────────────────────
	| 'autosar-rte-dependency'     // Classic RTE call with no Adaptive ara::com mapping
	| 'e2e-protection-gap'         // E2E protection missing in target communication path
	| 'asil-decomposition-break'   // ASIL-D split without formal ASIL-B+B rationale
	| 'can-signal-scaling-mismatch'// CAN DBC signal factor/offset not preserved in CANopen OD
	// ── Telecom (3GPP / GSMA) ────────────────────────────────────────────────
	| 'security-key-material'      // 3GPP AS/NAS key arrays or SUPI/SUCI inline
	| 'protocol-state-machine-break' // Non-serialisable RRC/NAS state in migration
	| 'ttcn3-verdict-suppression'  // TTCN-3 INCONC verdict suppressed without TS reference
	// ── Energy / Critical Infrastructure (IEC 61850 / IEC 61511) ────────────
	| 'goose-protection-relay'     // IEC 61850 GOOSE trip path bridged via TCP/MQTT
	| 'dnp3-secure-auth-gap'       // DNP3 SA_CHALLENGE missing in modernised stack
	| 'sis-sil-downgrade';         // SIS/ESD SIL level would reduce after modernisation

export interface ITechDebtItem {
	unitId: string;
	category: TechDebtCategory;
	description: string;
	severity: 'info' | 'warning' | 'error';
	lineNumber?: number;
	/** Migration impact: how this debt complicates the unit's translation. */
	migrationImpact: string;
}


// ─── Regulated Data Hits ──────────────────────────────────────────────────────

export type RegulatedDataPattern =
	// ── Safety-critical firmware patterns (IEC 61508 / MISRA-C / IEC 62443) ──
	| 'peripheral-register'   // Hardcoded peripheral MMIO address in peripheral space
	| 'raw-mmio-cast'         // (volatile T*) raw-address cast violating MISRA-C Rule 11.4
	| 'isr-definition'        // Interrupt service routine / handler function definition
	| 'watchdog-refresh'      // Watchdog refresh call (IEC 61508 safety coverage)
	| 'safety-function-block' // PLCopen Safety FB call (SF_EmergencyStop etc.)
	| 'dynamic-allocation'    // malloc/free/calloc violating MISRA-C Rule 21.3
	| 'hardcoded-ip'          // Hardcoded IP address in OT/IT code (IEC 62443)
	// ── Financial / PII patterns (retained for hybrid codebases) ─────────────
	| 'ssn'             // US Social Security Number
	| 'credit-card'     // Luhn-valid 13–16 digit number
	| 'iban'            // International Bank Account Number
	| 'bic-swift'       // Bank Identifier Code
	| 'national-id'     // Generic national ID pattern
	| 'passport'        // Passport number pattern
	| 'date-of-birth'   // DOB field/value
	| 'email'           // Email address in source
	| 'phone'           // Phone number literal
	| 'ip-address'      // IP address literal (may be production infra)
	| 'private-key'     // PEM private key or key-like string
	| 'api-key'         // API key or token pattern
	| 'connection-string'; // Database / OT connection string with credentials

/** A potentially regulated data literal found directly in source code. */
export interface IRegulatedDataHit {
	unitId: string;
	fileUri: string;
	lineNumber: number;
	pattern: RegulatedDataPattern;
	/** Redacted sample of the matched text (last 4 chars visible). */
	redactedSample: string;
	confidence: 'high' | 'medium' | 'low';
	/** GDPR/HIPAA/PCI applicable frameworks based on pattern type. */
	applicableFrameworks: string[];
}


// ─── External Dependencies ────────────────────────────────────────────────────

/** A third-party library / package dependency detected from build files or imports. */
export interface IExternalDependency {
	name: string;
	version?: string;
	/** Resolved from build file (accurate) vs. inferred from imports (heuristic). */
	source: 'build-file' | 'import-inference';
	/** Whether this is a direct dependency or transitive (best-effort). */
	isDirectDependency: boolean;
	/** Whether the dependency has known CVEs at time of scan (requires advisory DB — placeholder). */
	hasKnownVulnerabilities?: boolean;
	/** CVE IDs if known (populated from advisory DB integration). */
	cveIds?: string[];
}


// ─── Unit Complexity ──────────────────────────────────────────────────────────

/** Per-unit complexity metrics computed by the complexity analyzer. */
export interface IUnitComplexity {
	lineCount: number;
	/** Non-blank, non-comment source lines. */
	logicalLineCount: number;
	/** Estimated McCabe cyclomatic complexity (1 + decision points). */
	cyclomaticComplexity: number;
	/** Maximum brace/indent nesting depth. */
	nestingDepth: number;
	/** Number of outgoing calls/PERFORMs. */
	callCount: number;
	/** Formal parameter count of the primary function/entry point. */
	paramCount: number;
	hasExternalCalls: boolean;
	hasDatabaseOps: boolean;
	hasFileOps: boolean;
	hasUIInteraction: boolean;
}


// ─── Migration Effort Estimate ────────────────────────────────────────────────

export type MigrationEffortBand = 'trivial' | 'small' | 'medium' | 'large' | 'xlarge';

/** Heuristic migration effort estimate for a single unit. */
export interface IMigrationEffortEstimate {
	unitId: string;
	effortBand: MigrationEffortBand;
	/** Estimated developer-hours range. */
	estimatedHoursLow: number;
	estimatedHoursHigh: number;
	/** Key drivers that raised the estimate. */
	drivers: string[];
	/** Confidence in the estimate. */
	confidence: 'high' | 'medium' | 'low';
}


// ─── Cross-Project Pairing ────────────────────────────────────────────────────

export type PairingMatchReason =
	| 'exact-name'
	| 'normalized-name'
	| 'token-overlap'
	| 'file-path-structure'
	| 'complexity-match'
	| 'heuristic';

/** A proposed mapping between a source unit and a target unit. */
export interface ICrossProjectPairing {
	sourceProjectId: string;
	targetProjectId: string;
	sourceUnitId: string;
	targetUnitId: string;
	/** 0–1 score; higher = more confident. */
	confidenceScore: number;
	matchReason: PairingMatchReason;
	/** Whether the target unit already has a compliance fingerprint (Stage 3 progress). */
	targetHasFingerprint: boolean;
}


// ─── Project Metadata ─────────────────────────────────────────────────────────

export interface IProjectMetadata {
	buildSystem?: 'maven' | 'gradle' | 'npm' | 'yarn' | 'pnpm' | 'cargo' | 'go-modules' |
	              'pip' | 'poetry' | 'sbt' | 'ant' | 'msbuild' | 'cmake' | 'make' |
	              // ── Firmware / Embedded / Industrial ──────────────────────────
	              'platformio' | 'esp-idf' | 'keil-mdk' | 'iar-ewb' |
	              's32-design-studio' | 'codesys' |
	              'unknown';
	buildFileUri?: string;
	packageName?: string;
	packageVersion?: string;
	detectedFrameworks: string[];
	hasDockerfile: boolean;
	hasCI: boolean;
	hasTests: boolean;
	hasGitIgnore: boolean;
	/** Test framework names detected (JUnit, pytest, Jest, etc.). */
	testFrameworks: string[];
	/** Languages detected in the project (≥ 1% of files). */
	languages: string[];
	/** Detected Java/Kotlin target version (e.g. "17"), Node major version, Python version, etc. */
	runtimeVersion?: string;
}


// ─── Statistics ───────────────────────────────────────────────────────────────

export interface IDiscoveryStats {
	totalFilesWalked: number;
	totalFilesScanned: number;
	totalFilesSkipped: number;
	totalUnitsExtracted: number;
	languageDistribution: Record<string, number>;
	riskDistribution: Record<MigrationRiskLevel, number>;
	effortDistribution: Record<MigrationEffortBand, number>;
	avgFileLines: number;
	avgUnitComplexity: number;
	largestFileLines: number;
	largestFileUri: string;
	mostComplexUnitId: string;
	mostComplexUnitCC: number;
	criticalUnitCount: number;
	deadCodeUnitCount: number;
	techDebtItemCount: number;
	regulatedDataHitCount: number;
	externalDependencyCount: number;
	scanErrors: IFileScanError[];
	elapsedMs: number;
}


// ─── Project Scan Result ──────────────────────────────────────────────────────

/** Complete discovery result for a single source or target project. */
export interface IProjectScanResult {
	projectId: string;
	projectLabel: string;
	folderUri: string;
	dominantLanguage: string;
	secondaryLanguage?: string;
	fileCount: number;

	/** All migration units (file-level or sub-file for supported languages). */
	units: IMigrationUnit[];

	/** GRC compliance snapshot. */
	grcSnapshot: IGRCSnapshot;

	/** Build/framework/CI metadata. */
	metadata: IProjectMetadata;

	/** Import/COPY/require dependency graph edges. */
	dependencyEdges: IDependencyEdge[];

	/** Intra-project call graph edges. */
	callGraphEdges: ICallGraphEdge[];

	/** External API entry points detected in this project. */
	apiEndpoints: IAPIEndpoint[];

	/** Data schema elements (tables, FDs, entities, models). */
	dataSchemas: IDataSchema[];

	/** Technical debt items detected. */
	techDebtItems: ITechDebtItem[];

	/** Regulated data literals (PII/PCI/PHI) found directly in source. */
	regulatedDataHits: IRegulatedDataHit[];

	/** Per-unit migration effort estimates. */
	effortEstimates: IMigrationEffortEstimate[];

	/** Third-party library inventory. */
	externalDependencies: IExternalDependency[];

	/** Aggregate statistics. */
	stats: IDiscoveryStats;
}


/** Full discovery result: all sources and targets, plus cross-project pairings. */
export interface IDiscoveryResult {
	discoveredAt: number;
	sources: IProjectScanResult[];
	targets: IProjectScanResult[];
	/** Proposed source ↔ target unit matchings across all project pairs. */
	crossProjectPairings: ICrossProjectPairing[];
	totalElapsedMs: number;
}


// ─── Internal Pipeline Types ──────────────────────────────────────────────────

/** A language-specific sub-unit extracted from a file. */
export interface IDecomposedUnit {
	name: string;
	type: MigrationUnitType;
	range: ICodeRange;
	rawImports: string[];
	/** Raw call expressions found within this unit (for call graph building). */
	rawCalls?: string[];
}

/** Result of processing one file through the full pipeline. */
export interface IFileProcessResult {
	units: IMigrationUnit[];
	grcViolations: ICheckResult[];
	lang: string;
	lineCount: number;
	dependencyEdges: Array<{ fromUnitId: string; rawImport: string }>;
	callEdges:       Array<{ fromUnitId: string; callExpression: string }>;
	apiEndpoints:    IAPIEndpoint[];
	dataSchemas:     IDataSchema[];
	techDebtItems:   ITechDebtItem[];
	regulatedDataHits: IRegulatedDataHit[];
	effortEstimates: IMigrationEffortEstimate[];
	error?: IFileScanError;
}


// ─── Re-exports ───────────────────────────────────────────────────────────────

export { IMigrationUnit, IComplianceFingerprint, MigrationRiskLevel, MigrationUnitType, ICodeRange, ICheckResult };
