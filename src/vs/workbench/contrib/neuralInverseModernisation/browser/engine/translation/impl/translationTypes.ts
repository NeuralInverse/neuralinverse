/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Translation Engine \u2014 Core Types
 *
 * All shared type definitions consumed by the Phase 4 Translation Engine.
 *
 * ## The Translation Loop
 *
 * ```
 * For each eligible unit (status='ready'):
 *   1. Resolve   \u2014 verify resolved source is available (Phase 1 already did this)
 *   2. Context   \u2014 assemble all KB knowledge into IBuiltTranslationContext
 *   3. Translate \u2014 call LLM with full context prompt; parse ITranslationParseResult
 *   4. Verify    \u2014 run ITranslationVerificationResult checks
 *   5. Record    \u2014 write translated code + decisions to KB; update status
 * ```
 *
 * ## Outcome Flow
 *
 * ```
 * ready \u2500\u2500\u25BA translating \u2500\u2500\u25BA review    (translation complete, has decisions or low confidence)
 *                       \u2500\u2500\u25BA blocked   (AI raised a blocking question; human must answer first)
 *                       \u2500\u2500\u25BA ready     (transient error; will be retried)
 * review \u2500\u2500\u25BA approved   (human approves)
 * ```
 */

import { UnitStatus, IPendingDecision, RiskLevel } from '../../../../common/knowledgeBaseTypes.js';


// \u2500\u2500\u2500 Translation Outcome \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * The result classification of a single unit's translation attempt.
 */
export type TranslationOutcome =
	| 'translated'   // Complete translation with high confidence \u2014 ready for human review
	| 'partial'      // Translation complete but AI flagged sections needing human review
	| 'blocked'      // AI raised a blocking question \u2014 unit cannot proceed without human input
	| 'error'        // Unexpected failure (network, parse, LLM error)
	| 'skipped';     // Unit not eligible (wrong status, not ready, explicitly excluded)


// \u2500\u2500\u2500 Translation Confidence \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * The AI's self-reported confidence in its translation.
 * Used to gate automated approval vs. requiring human review.
 */
export type TranslationConfidence = 'high' | 'medium' | 'low' | 'uncertain';

/** Numeric score for confidence (for metrics averaging). */
export const CONFIDENCE_SCORE: Record<TranslationConfidence, number> = {
	high:      3,
	medium:    2,
	low:       1,
	uncertain: 0,
};


// \u2500\u2500\u2500 Translation Options \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Options controlling the behaviour of a translation run.
 * Can be specified per-batch or per-unit (per-unit takes precedence).
 */
export interface ITranslationOptions {
	/** Target language canonical key (e.g. 'java', 'typescript', 'python'). Required. */
	targetLanguage: string;

	/**
	 * Target framework/runtime (e.g. 'Spring Boot 3', 'Node.js + Express', 'FastAPI').
	 * Injected into the prompt to enable framework-specific idiom selection.
	 */
	targetFramework?: string;

	/**
	 * Target test framework (e.g. 'JUnit 5', 'Jest', 'pytest').
	 * Injected into the prompt when generating test stubs.
	 */
	targetTestFramework?: string;

	/**
	 * Maximum token budget per unit (source + context + output combined).
	 * Context is trimmed to fit within this budget before sending to the LLM.
	 * Default: 12000
	 */
	maxTokensPerUnit: number;

	/**
	 * Maximum retry attempts on LLM error, parse failure, or failed verification.
	 * Each retry escalates to the next temperature in `temperaturePerAttempt`.
	 * Default: 2 (3 total attempts)
	 */
	maxRetries: number;

	/**
	 * Maximum units being translated simultaneously.
	 * Keep low (2\u20134) \u2014 translation is compute-bound on the LLM side.
	 * Default: 3
	 */
	maxConcurrency: number;

	/**
	 * LLM temperature per attempt, index 0 = first attempt.
	 * Escalating temperature allows more creative solutions on retries.
	 * Default: [0.2, 0.4, 0.6]
	 */
	temperaturePerAttempt: number[];

	/** Run verification checks after translation. Default: true */
	verifyAfterTranslate: boolean;

	/** Extract IPendingDecision items from AI metadata block. Default: true */
	extractDecisions: boolean;

	/**
	 * Only translate units at or above this risk level.
	 * Useful for prioritising high-risk units first.
	 * Default: 'low' (translate all)
	 */
	minRiskLevel: RiskLevel;

	/**
	 * Unit statuses eligible for translation.
	 * Default: ['ready']
	 */
	eligibleStatuses: UnitStatus[];

	/**
	 * Human-readable migration pattern label injected into the prompt for context.
	 * e.g. 'COBOL batch programs \u2192 Java Spring Boot services'
	 */
	migrationPatternLabel?: string;

	/**
	 * Free-form text describing target project conventions.
	 * Injected verbatim into the system prompt as a "Project Conventions" section.
	 * e.g. package structure, naming standards, DI framework, error handling patterns.
	 */
	targetConventions?: string;

	/**
	 * Whether to skip units whose dependencies have not all been translated yet.
	 * When false, the AI is given a warning comment in the dependencies section
	 * instead of translated code.
	 * Default: false (translate anyway \u2014 AI will handle missing dep context)
	 */
	skipIfDependenciesUnresolved: boolean;
}

/** Production-safe defaults for ITranslationOptions. */
export const DEFAULT_TRANSLATION_OPTIONS: Omit<ITranslationOptions, 'targetLanguage'> = {
	maxTokensPerUnit:              12_000,
	maxRetries:                    2,
	maxConcurrency:                3,
	temperaturePerAttempt:         [0.2, 0.4, 0.6],
	verifyAfterTranslate:          true,
	extractDecisions:              true,
	minRiskLevel:                  'low',
	eligibleStatuses:              ['ready'],
	skipIfDependenciesUnresolved:  false,
};


// \u2500\u2500\u2500 Verification \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type VerificationSeverity = 'blocker' | 'warning' | 'info';

/** Result of a single verification rule applied to translated code. */
export interface IVerificationCheck {
	/** Short identifier for the check (e.g. 'non-empty', 'balanced-braces') */
	name: string;
	passed: boolean;
	severity: VerificationSeverity;
	/** Human-readable explanation when not passed */
	message?: string;
}

/** Aggregated result of all verification checks for one translation. */
export interface ITranslationVerificationResult {
	/** True only if zero blocker checks failed */
	passed: boolean;
	checks: IVerificationCheck[];
	blockerCount: number;
	warningCount: number;
}


// \u2500\u2500\u2500 Parse Result \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * A decision raised by the AI during translation.
 * These are raw (before being promoted to full IPendingDecision with IDs).
 */
export interface IRaisedDecision {
	type: IPendingDecision['type'];
	priority: IPendingDecision['priority'];
	question: string;
	context: string;
	options?: string[];
}

/**
 * The structured output extracted from a raw LLM response.
 * Produced by translationResultParser.ts.
 */
export interface ITranslationParseResult {
	/** The extracted translated code block */
	translatedCode: string;
	/** Self-reported confidence */
	confidence: TranslationConfidence;
	/** AI's reasoning / key decisions narrative */
	reasoning: string;
	/** Decisions the AI could not make alone */
	decisionsRaised: IRaisedDecision[];
	/** Names of sections the AI left incomplete (e.g. 'error handling', 'SORT logic') */
	sectionsUnresolved: string[];
	/** Idiom notes the AI recorded (for audit log) */
	idiomNotes: string[];
	/** Whether the structured parse succeeded */
	parseSucceeded: boolean;
	/** Raw LLM response text (stored for audit / retry analysis) */
	rawResponse: string;
}


// \u2500\u2500\u2500 Translation Result \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * The complete result of translating one knowledge unit.
 * Returned by translationLoop.ts and consumed by the batch engine.
 */
export interface ITranslationResult {
	unitId: string;
	unitName: string;
	sourceLang: string;
	targetLang: string;
	translatedCode: string;
	confidence: TranslationConfidence;
	/** AI's narrative reasoning about key decisions made during translation */
	reasoning: string;
	/** Fully formed IPendingDecision objects (with IDs) extracted from AI metadata */
	decisionsRaised: IPendingDecision[];
	/** Rough token usage estimate (characters / 4) */
	tokensUsed: number;
	/** How many LLM calls were made (1 = succeeded on first attempt) */
	attemptCount: number;
	durationMs: number;
	outcome: TranslationOutcome;
	verificationResult?: ITranslationVerificationResult;
	/** Error message if outcome === 'error' */
	error?: string;
}


// \u2500\u2500\u2500 Context \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * The fully assembled context package passed to translationPromptBuilder.
 * Produced by translationContextBuilder.ts from IResolvedUnitContext + options.
 */
export interface IBuiltTranslationContext {
	// \u2500\u2500 Unit identity \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	unitId: string;
	unitName: string;
	unitType: string;
	sourceLang: string;
	targetLang: string;
	riskLevel: RiskLevel;
	domain?: string;

	// \u2500\u2500 Source \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	/** Resolved (dependency-expanded) source \u2014 may be trimmed to budget */
	resolvedSource: string;

	// \u2500\u2500 Language pair profile \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	languagePairLabel: string;
	targetFramework?: string;
	targetTestFramework?: string;
	systemPersona: string;
	idiomMapSummary: string;        // Formatted for prompt injection
	conventionNotes: string;        // Formatted bullet list
	warningPatternNotes: string;    // Formatted bullet list

	// \u2500\u2500 KB knowledge \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	typeMappingContext: string;     // Formatted type-mapping decisions
	namingContext: string;          // Formatted naming decisions
	ruleInterpretationContext: string; // Formatted rule interpretations
	patternOverrideContext: string; // Formatted pattern overrides
	calledInterfacesContext: string; // Formatted translated interfaces
	businessRulesContext: string;   // Formatted business rules
	glossaryContext: string;        // Formatted glossary terms
	annotationContext: string;      // Formatted context annotations
	migrationPatternLabel?: string; // Session-level migration pattern
	targetConventions?: string;     // Project-specific conventions

	// \u2500\u2500 Budget \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	estimatedTokens: number;
	wasBudgetTrimmed: boolean;
	trimmedSections: string[];
	/**
	 * True when the resolved source was truncated to fit the token budget.
	 * The translation loop uses this to route to chunked translation instead
	 * of single-shot translation, avoiding silent loss of source content.
	 */
	isSourceTruncated: boolean;

	// \u2500\u2500 Chunked translation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	/**
	 * Optional chunk-specific context header injected by the translation loop
	 * when chunked translation is active. Placed before the source section in
	 * the user message to inform the AI of its position in the overall unit.
	 */
	chunkHeader?: string;

	// \u2500\u2500 Tech debt & blocking context \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	/** Formatted tech debt summary for the source unit (from techDebtAnalyzer). */
	techDebtSummary?: string;
	/** Locked blocking decisions \u2014 AI must not re-raise these. */
	blockingDecisionsContext?: string;
	/** Health status of called dependency units (stable / high-debt / blocked). */
	calledUnitHealthContext?: string;

	// \u2500\u2500 Sector guidance \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	/** Verbatim aiGuidance from ISectorProfile \u2014 injected into the system prompt when sector is known. */
	sectorGuidance?: string;
}


// \u2500\u2500\u2500 Events \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** Fired when a single unit's translation completes (any outcome). */
export interface ITranslationUnitCompleteEvent {
	unitId: string;
	unitName: string;
	sourceLang: string;
	targetLang: string;
	outcome: TranslationOutcome;
	confidence: TranslationConfidence;
	decisionsRaised: number;
	tokensUsed: number;
	attemptCount: number;
	durationMs: number;
}

/** Fired periodically during a batch run with aggregate progress. */
export interface ITranslationBatchProgressEvent {
	completed: number;
	total: number;
	inFlight: number;
	percentComplete: number;
	totalTokensUsed: number;
	translatedCount: number;
	partialCount: number;
	blockedCount: number;
	errorCount: number;
}

/** Fired when a batch run finishes (complete or cancelled). */
export interface ITranslationBatchCompleteEvent {
	summary: ITranslationBatchSummary;
}


// \u2500\u2500\u2500 Batch Summary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface ITranslationBatchSummary {
	totalUnits: number;
	translated: number;
	partial: number;
	blocked: number;
	errors: number;
	skipped: number;
	totalTokensUsed: number;
	totalDurationMs: number;
	decisionsRaised: number;
	cancelled: boolean;
	byLanguagePair: ITranslationLanguagePairSummary[];
}

export interface ITranslationLanguagePairSummary {
	sourceLang: string;
	targetLang: string;
	totalUnits: number;
	translated: number;
	partial: number;
	blocked: number;
	avgTokensPerUnit: number;
	avgDurationMs: number;
}


// \u2500\u2500\u2500 Metrics \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface ITranslationMetricsSnapshot {
	totalAttempts: number;
	totalTranslated: number;
	totalPartial: number;
	totalBlocked: number;
	totalErrors: number;
	totalTokensUsed: number;
	avgDurationMs: number;
	avgTokensPerUnit: number;
	/** Weighted average confidence score (0\u20133) across translated units */
	avgConfidenceScore: number;
	byLanguagePair: ITranslationLanguagePairMetrics[];
	topBlockedUnits: Array<{ unitId: string; unitName: string; blockedReason: string }>;
	topDecisionTypes: Array<{ type: IPendingDecision['type']; count: number }>;
}

export interface ITranslationLanguagePairMetrics {
	sourceLang: string;
	targetLang: string;
	translated: number;
	partial: number;
	blocked: number;
	errors: number;
	avgTokensPerUnit: number;
	avgDurationMs: number;
	avgConfidenceScore: number;
}
