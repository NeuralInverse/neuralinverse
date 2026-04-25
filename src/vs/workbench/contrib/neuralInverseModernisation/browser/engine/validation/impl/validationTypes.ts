/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Validation Engine Types
 *
 * All input parameter types, output/result types, and constants for the
 * Phase 10 Validation Engine.
 *
 * ## Validation strategy
 *
 * The engine applies two complementary layers to assess semantic equivalence:
 *
 *   Layer 1 — Static structural checks (deterministic, no LLM)
 *     Fast heuristic analysis: line-count ratio, branch coverage,
 *     API surface matching, data-field coverage, control-flow coverage.
 *     These run first and can short-circuit if the translation is obviously broken.
 *
 *   Layer 2 — LLM semantic equivalence analysis
 *     The LLM is shown both the source and target side-by-side and asked to:
 *       a) Generate concrete test cases with representative inputs
 *       b) Determine whether target would produce equivalent outputs
 *       c) Identify any output divergences with typed classification
 *     Structured XML output is parsed into IValidationTestCase[].
 *
 * ## Outcome \u2192 KB status mapping
 *
 *   'validated'  \u2192 kb.setUnitStatus(unitId, 'validated')   \u2192 all good
 *   'partial'    \u2192 kb.setUnitStatus(unitId, 'review')      \u2192 needs human look
 *   'failed'     \u2192 kb.setUnitStatus(unitId, 'flagged')     \u2192 divergences found
 *   'error'      \u2192 kb.setUnitStatus(unitId, 'review')      \u2192 engine error, retry
 *   'skipped'    \u2192 no status change                         \u2192 locked/not eligible
 */

import { OutputDivergenceType } from '../../../../common/modernisationTypes.js';


// ─── Option types ─────────────────────────────────────────────────────────────

export interface IValidationOptions {
	/**
	 * LLM retry attempts per unit on parse failure (default 2).
	 * Each retry injects the previous failure reason to guide the model.
	 */
	maxRetries?: number;

	/**
	 * Maximum concurrent validation jobs (default 3).
	 * Validation is LLM-heavy — lower than translation to avoid token flooding.
	 */
	maxConcurrency?: number;

	/**
	 * Which unit statuses are eligible for validation (default ['approved']).
	 * Add 'committed' to re-validate already-committed units if needed.
	 */
	eligibleStatuses?: string[];

	/**
	 * Run Layer 1 static structural checks (default true).
	 * These are fast and free. Disable only for debugging.
	 */
	includeStaticChecks?: boolean;

	/**
	 * Run Layer 2 LLM semantic analysis (default true).
	 * If false, only static checks determine the outcome.
	 * Useful for bulk pre-screening before the full LLM run.
	 */
	includeLLMAnalysis?: boolean;

	/**
	 * Override the target language (auto-inferred from unit.targetFile otherwise).
	 * Used when the target language cannot be inferred from file extension.
	 */
	targetLanguage?: string;

	/**
	 * Path to the evidence output directory.
	 * A `.validation-evidence.json` file per unit is written here for audit.
	 * Defaults to `{targetRoot}/.neuralinverse/evidence/`.
	 */
	evidenceOutputDir?: string;
}

export const DEFAULT_VALIDATION_OPTIONS: Required<Omit<IValidationOptions, 'targetLanguage' | 'evidenceOutputDir'>> = {
	maxRetries:          2,
	maxConcurrency:      3,
	eligibleStatuses:    ['approved'],
	includeStaticChecks: true,
	includeLLMAnalysis:  true,
};


// ─── Static check types ───────────────────────────────────────────────────────

export type StaticCheckStatus = 'pass' | 'warn' | 'fail';

/** A single deterministic structural check result */
export interface IStaticCheckResult {
	/** Stable ID used for de-duplication and reporting (e.g. 'line-count-ratio') */
	checkId:   string;
	/** Human-readable check label */
	label:     string;
	/** Pass / Warn / Fail */
	status:    StaticCheckStatus;
	/** Explanation of what was checked and why it passed/failed */
	detail:    string;
	/** Optional measured value for display (e.g. '0.34 ratio') */
	measured?: string;
}


// ─── LLM test case types ──────────────────────────────────────────────────────

/**
 * A single semantic test case generated and assessed by the LLM.
 * Represents one scenario from the source unit's logic.
 */
export interface IValidationTestCase {
	/** Stable ID for the test case, e.g. 'tc-1' */
	id:               string;
	/** Human-readable description of the scenario / input */
	inputDescription: string;
	/** What the legacy code would produce for this input */
	expectedLegacy:   string;
	/** What the modern code would produce for this input */
	expectedModern:   string;
	/** Whether legacy and modern outputs are equivalent */
	passed:           boolean;
	/** Populated only when passed === false */
	divergenceType?:  OutputDivergenceType;
	/** LLM reasoning about why this case passes or diverges */
	explanation:      string;
}

/** Parsed output from the LLM equivalence analysis prompt */
export interface IValidationParseResult {
	parseSucceeded: boolean;
	testCases:      IValidationTestCase[];
	totalCount:     number;
	passCount:      number;
	failCount:      number;
	/** Overall confidence in the equivalence assessment */
	confidence:     ValidationConfidence;
	/** LLM narrative summary of the equivalence analysis */
	analysis:       string;
	/** Only set when parseSucceeded === false */
	parseError?:    string;
}


// ─── Result types ─────────────────────────────────────────────────────────────

export type ValidationOutcome =
	| 'validated'   // All test cases pass, static checks pass
	| 'partial'     // Some warnings or low confidence — needs human review
	| 'failed'      // Divergences found — unit should be flagged for re-translation
	| 'error'       // Engine error (LLM unreachable, parse failure, etc.)
	| 'skipped';    // Unit locked, not eligible, or no source/target available

export type ValidationConfidence = 'high' | 'medium' | 'low' | 'uncertain';

/** The complete result for a single unit's validation run */
export interface IValidationResult {
	unitId:        string;
	unitName:      string;
	outcome:       ValidationOutcome;
	/** Layer 1 deterministic check results */
	staticChecks:  IStaticCheckResult[];
	/** Layer 2 LLM-generated test cases */
	testCases:     IValidationTestCase[];
	testCaseCount: number;
	passCount:     number;
	failCount:     number;
	confidence:    ValidationConfidence;
	/** LLM narrative analysis summary */
	analysis:      string;
	durationMs:    number;
	attemptCount:  number;
	tokensUsed:    number;
	/** Only set on outcome='error' */
	error?:        string;
	/** Path where the evidence JSON was written (if evidenceOutputDir was set) */
	evidencePath?: string;
}


// ─── Batch event types ────────────────────────────────────────────────────────

export interface IValidationBatchProgress {
	type: 'unit-started' | 'unit-completed' | 'batch-completed';
	unitId?:   string;
	unitName?: string;
	result?:   IValidationResult;
	index?:    number;
	total?:    number;
	metrics?:  IValidationBatchMetrics;
}

export interface IValidationBatchMetrics {
	totalUnits:      number;
	validated:       number;
	partial:         number;
	failed:          number;
	error:           number;
	skipped:         number;
	totalTestCases:  number;
	passedTestCases: number;
	failedTestCases: number;
	totalDurationMs: number;
	avgDurationMs:   number;
}

export interface IBatchValidationOptions extends IValidationOptions {
	/** Target project root for evidence file output */
	targetRoot?: string;
}
