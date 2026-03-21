/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Resolution Types
 *
 * Shared types for the Source Resolution Engine.
 *
 * The resolution engine is responsible for taking a KB unit in 'pending' status
 * and producing a `resolvedSource` — the unit's source text with all external
 * dependencies (copybooks, package specs, import interfaces) expanded inline.
 *
 * This is the solution to the COBOL wall problem: the AI sees a `COPY CUSTMAST`
 * reference and knows nothing about the 40 fields inside it. After resolution,
 * the AI's context contains the complete, self-contained unit with every
 * dependency expanded — no external files needed.
 *
 * The same pattern applies to every language:
 *   COBOL:    COPY CUSTMAST  →  fields expanded inline
 *   PL/SQL:   v_bal v_acct.balance%TYPE  →  NUMBER(15,2) with source annotation
 *   Java EE:  @EJB UserBean bean  →  interface stub injected as comment
 *   RPG:      CALL 'GLPGM'  →  known interface from KB injected
 *   NATURAL:  USING DA-CUSTOMER  →  data area fields expanded inline
 */


// ─── Resolution Status ────────────────────────────────────────────────────────

export type ResolutionOutcome =
	| 'resolved'        // All dependencies found and expanded
	| 'partial'         // Some dependencies resolved, some not found (still usable)
	| 'unresolvable'    // No dependencies could be resolved (source unchanged)
	| 'cycle'           // Circular dependency detected — expansion stopped safely
	| 'error';          // Unexpected error during resolution


// ─── Dependency Reference ─────────────────────────────────────────────────────

/**
 * A single dependency reference found in a unit's source.
 * e.g. "COPY CUSTMAST" in COBOL, "import com.example.Foo" in Java.
 */
export interface IDependencyRef {
	/** Raw text of the dependency reference as it appears in source */
	rawRef: string;
	/** Canonical name of the dependency (normalised, upper-cased for COBOL) */
	canonicalName: string;
	/** Line number where this reference appears (1-based) */
	line: number;
	/** Type of dependency */
	depType: DependencyRefType;
	/** For COBOL COPY REPLACING: the substitution pairs */
	replacingPairs?: Array<{ from: string; to: string }>;
}

export type DependencyRefType =
	| 'cobol-copy'       // COPY copybook-name
	| 'cobol-call'       // CALL 'program-name'
	| 'plsql-type-ref'   // v_x table.column%TYPE or pkg.type_name
	| 'plsql-package'    // pkg_name.procedure_name
	| 'java-import'      // import com.example.Foo
	| 'java-ejb'         // @EJB, @Autowired, @Inject
	| 'rpg-call'         // CALL 'PGMNAME' or CALLP procedure
	| 'rpg-binding'      // Binding directory entry
	| 'natural-using'    // USING DA-name
	| 'natural-call'     // CALLNAT subprogram-name
	| 'generic-import';  // Any other import/include/use


// ─── Per-Dependency Resolution Result ────────────────────────────────────────

/**
 * The resolution result for a single dependency reference.
 */
export interface IDependencyResolutionResult {
	ref: IDependencyRef;
	/** Whether this specific dependency was found and resolved */
	resolved: boolean;
	/** The expanded inline content (empty if not resolved) */
	inlinedContent: string;
	/** The file path where the dependency was found */
	resolvedFilePath?: string;
	/** The KB unit ID for this dependency (if it exists in the KB) */
	resolvedUnitId?: string;
	/** Why resolution failed (if resolved === false) */
	failureReason?: string;
	/** Whether this is a known external library (not expected to be in the project) */
	isExternal?: boolean;
}


// ─── Unit Resolution Result ───────────────────────────────────────────────────

/**
 * The full resolution result for a single KB unit.
 */
export interface IUnitResolutionResult {
	unitId: string;
	unitName: string;
	language: string;
	outcome: ResolutionOutcome;
	/** The resolved source text with all dependencies expanded inline */
	resolvedSource: string;
	/** How many dependency references were found */
	totalRefs: number;
	/** How many were successfully resolved */
	resolvedRefs: number;
	/** How many could not be found */
	unresolvedRefs: number;
	/** Dependencies that were resolved */
	resolvedDeps: IDependencyResolutionResult[];
	/** Dependencies that could not be resolved */
	unresolvedDeps: IDependencyResolutionResult[];
	/** Unit IDs of circular dependencies detected and stopped */
	cycleUnitIds: string[];
	/** Wall-clock time for this resolution in milliseconds */
	durationMs: number;
}


// ─── Resolution Request ───────────────────────────────────────────────────────

/**
 * A request to resolve a single KB unit's dependencies.
 * Queued by the SourceResolutionServiceImpl.
 */
export interface IResolutionRequest {
	unitId: string;
	unitName: string;
	language: string;
	sourceText: string;
	/** Absolute URI to the source file that contains this unit */
	sourceFileUri: string;
	/** Project root URI — used for relative path resolution */
	projectRootUri: string;
	/** Known copybook/include search paths for this project */
	searchPaths: string[];
	/** The risk level of the unit — used to prioritise resolution */
	riskLevel: 'low' | 'medium' | 'high' | 'critical';
	/** Number of units that depend on this one — used for tie-breaking */
	dependentCount: number;
}


// ─── Search Path Hint ─────────────────────────────────────────────────────────

/**
 * A candidate directory to search when resolving a dependency by name.
 * e.g. for COBOL: the project root, the `COPYLIB/` subdirectory, the `CPY/` subdirectory.
 */
export interface ISearchPathHint {
	/** Absolute URI of the directory to search */
	dirUri: string;
	/** How confident we are that this is the right search root */
	priority: number;
}


// ─── Batch Resolution Summary ─────────────────────────────────────────────────

/**
 * Summary of a full batch resolution run.
 */
export interface IBatchResolutionSummary {
	totalUnits: number;
	fullyResolved: number;
	partiallyResolved: number;
	unresolvable: number;
	cyclesDetected: number;
	failed: number;
	skipped: number;
	/** Average resolution time per unit in milliseconds */
	avgDurationMs: number;
	durationMs: number;
	startedAt: number;
	completedAt: number;
	cancelled: boolean;
}


// ─── Resolution Options ───────────────────────────────────────────────────────

export interface IResolutionOptions {
	/**
	 * Maximum depth for recursive dependency expansion.
	 * Prevents stack overflow on deeply nested copybook chains.
	 * Default: 20
	 */
	maxExpansionDepth?: number;

	/**
	 * Maximum number of units to resolve concurrently.
	 * Resolution is I/O-bound (file reads). Default: 6.
	 */
	maxConcurrency?: number;

	/**
	 * If true, insert inline markers showing where each dependency was expanded.
	 * e.g. for COBOL: "* ── COPY CUSTMAST EXPANDED ─────────────────────────────"
	 * Makes the expanded source easier for humans (and LLMs) to read.
	 * Default: true
	 */
	insertExpansionMarkers?: boolean;

	/**
	 * If true, include a summary header at the top of the resolved source
	 * listing all dependencies that were/were not resolved.
	 * Default: true
	 */
	insertResolutionHeader?: boolean;

	/**
	 * Maximum size of a single inlined dependency in characters.
	 * Very large copybooks/headers are truncated to this limit to prevent
	 * context window overflow. A marker is inserted where truncation occurs.
	 * Default: 50,000 characters
	 */
	maxInlineSize?: number;

	/**
	 * Additional file extensions to try when searching for a dependency by name.
	 * Language-specific defaults are already built in (e.g. .cpy for COBOL).
	 */
	additionalExtensions?: string[];

	/**
	 * Only resolve units matching these risk levels.
	 * Defaults to all risk levels.
	 */
	riskLevels?: Array<'low' | 'medium' | 'high' | 'critical'>;

	/**
	 * If true, skip units that already have a non-empty resolvedSource.
	 * Default: true (do not re-resolve already resolved units).
	 */
	skipAlreadyResolved?: boolean;
}
