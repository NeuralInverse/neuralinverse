/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Autonomy Types
 *
 * All shared types for Phase 12 — Agent Autonomy.
 *
 * The autonomy service drives the full pipeline without human input per unit:
 *
 *   Resolve \u2192 Translate \u2192 [Auto-approve?] \u2192 Validate \u2192 Commit
 *
 * Humans retain hard control at every critical gate:
 *   - Plan approval (Stage 2 gate — enforced by the session service)
 *   - High-risk + regulated unit review (hard gates in autoApprovalPolicy)
 *   - Equivalence divergence overrides (flagged units need human override)
 *   - Final cutover approval (Phase 11 gate)
 *
 * ## Batch lifecycle
 *
 *   idle \u2192 running \u2192 (pausing) \u2192 paused \u2192 running \u2192 stopping \u2192 completed
 *                                                   |
 *                                                   \u2192 error
 *
 * ## Unit lifecycle within a run
 *
 *   pending   \u2192 [resolve]    \u2192 advanced (unit now 'ready')
 *   ready     \u2192 [translate]  \u2192 advanced (unit now 'review')
 *   review    \u2192 [policy]     \u2192 advanced (auto-approved \u2192 'approved') | escalated
 *   approved  \u2192 [validate]   \u2192 advanced (unit now 'validated' or 'flagged')
 *   validated \u2192 [commit]     \u2192 advanced (unit now 'committed')
 *   flagged   \u2192 escalated immediately (divergence needs human override)
 *   any in-flight status \u2192 skipped (another process is mid-flight)
 *   terminal status \u2192 skipped (nothing to do)
 */


// ─── Pipeline stages ──────────────────────────────────────────────────────────

/**
 * The four pipeline stages the autonomy loop can drive.
 * Each maps to one downstream service call.
 */
export type AutonomyStage = 'resolve' | 'translate' | 'validate' | 'commit';

export const ALL_AUTONOMY_STAGES: AutonomyStage[] = ['resolve', 'translate', 'validate', 'commit'];

/**
 * Maps an actionable unit status to the stage that handles it.
 * Used by the scheduler for eligibility filtering and the loop for dispatch.
 */
export const STATUS_TO_STAGE: Partial<Record<string, AutonomyStage>> = {
	pending:   'resolve',
	ready:     'translate',
	approved:  'validate',
	validated: 'commit',
	// 'review' and 'flagged' have no direct stage key — handled inline
};


// ─── Batch lifecycle ──────────────────────────────────────────────────────────

/**
 * The lifecycle state of the autonomy service's current (or most recent) batch.
 *
 *  - `idle`      — no batch is active; service is ready to start
 *  - `running`   — a batch is actively processing units
 *  - `pausing`   — stop signal sent; draining in-flight jobs before pausing
 *  - `paused`    — batch halted mid-run; can be resumed (units stay at current status)
 *  - `stopping`  — abort signal sent; draining in-flight jobs before stopping
 *  - `completed` — all units processed (or none eligible); clean finish
 *  - `error`     — the batch engine itself threw an unhandled error
 */
export type BatchState = 'idle' | 'running' | 'pausing' | 'paused' | 'stopping' | 'completed' | 'error';


// ─── Error classification ─────────────────────────────────────────────────────

/**
 * Categorical error type — allows the service to apply different retry
 * and escalation strategies per error class.
 */
export type AutonomyErrorCategory =
	| 'service-unavailable'   // Downstream service threw / timed out
	| 'unit-locked'           // Unit locked by another concurrent process
	| 'missing-source'        // No sourceText or resolvedSource available
	| 'missing-target'        // Translation produced empty targetText
	| 'parse-error'           // LLM response could not be parsed
	| 'validation-divergence' // Equivalence test found divergences
	| 'commit-error'          // Target file could not be written to disk
	| 'dependency-incomplete' // Required upstream units have not yet reached the expected status
	| 'stage-timeout'         // Stage exceeded the per-stage timeout budget
	| 'unknown';              // Catch-all for unclassified errors

export function classifyError(errorMsg: string, stage: AutonomyStage): AutonomyErrorCategory {
	const lower = errorMsg.toLowerCase();
	if (lower.includes('locked') || lower.includes('lock'))                    { return 'unit-locked'; }
	if (lower.includes('no source') || lower.includes('sourcetext'))           { return 'missing-source'; }
	if (lower.includes('empty target') || lower.includes('targettext'))        { return 'missing-target'; }
	if (lower.includes('parse') || lower.includes('xml'))                      { return 'parse-error'; }
	if (stage === 'validate' && (lower.includes('failed') || lower.includes('diverge'))) { return 'validation-divergence'; }
	if (stage === 'commit'   && (lower.includes('write') || lower.includes('enoent')))   { return 'commit-error'; }
	if (lower.includes('timeout') || lower.includes('timed out'))              { return 'stage-timeout'; }
	if (lower.includes('dependency') || lower.includes('upstream'))            { return 'dependency-incomplete'; }
	if (lower.includes('unavailable') || lower.includes('network'))            { return 'service-unavailable'; }
	return 'unknown';
}

/** True if this error category is worth retrying (false = escalate immediately). */
export function isRetryableError(category: AutonomyErrorCategory): boolean {
	switch (category) {
		case 'unit-locked':           return true;  // Lock may release
		case 'service-unavailable':   return true;  // Transient
		case 'parse-error':           return true;  // LLM may produce better output on retry
		case 'stage-timeout':         return true;  // Retry with fresh attempt
		case 'missing-source':        return false; // Needs human action
		case 'missing-target':        return true;  // Retry translation
		case 'validation-divergence': return false; // Needs human override
		case 'commit-error':          return true;  // May be a transient filesystem issue
		case 'dependency-incomplete': return true;  // Upstream will eventually complete
		case 'unknown':               return true;
	}
}


// ─── Per-attempt record ───────────────────────────────────────────────────────

/** A single execution attempt on one stage for one unit within a batch run. */
export interface IAutonomyAttempt {
	readonly attemptIndex:  number;
	readonly stage:         AutonomyStage;
	readonly startedAt:     number;
	readonly completedAt:   number;
	readonly durationMs:    number;
	readonly outcome:       'advanced' | 'error' | 'skipped' | 'aborted';
	readonly errorMsg?:     string;
	readonly errorCategory?: AutonomyErrorCategory;
}


// ─── Per-unit history within a run ───────────────────────────────────────────

/** Complete run record for a single unit across all attempts in one batch run. */
export interface IAutonomyUnitHistory {
	readonly unitId:          string;
	readonly unitName:        string;
	readonly firstAttemptAt:  number;
	readonly lastAttemptAt:   number;
	readonly attempts:        IAutonomyAttempt[];
	readonly finalOutcome:    'advanced' | 'escalated' | 'error' | 'skipped';
	readonly finalStage:      AutonomyStage | null;
	readonly escalationReason?: string;
}


// ─── Per-unit result (returned from loop) ─────────────────────────────────────

export type AutonomyUnitOutcome = 'advanced' | 'escalated' | 'error' | 'skipped';

export interface IAutonomyUnitResult {
	readonly unitId:           string;
	readonly unitName:         string;
	/** Stage completed this iteration. null = nothing done (skipped / escalated). */
	readonly stageCompleted:   AutonomyStage | null;
	readonly outcome:          AutonomyUnitOutcome;
	readonly durationMs:       number;
	readonly attemptIndex:     number;
	readonly errorMsg?:        string;
	readonly errorCategory?:   AutonomyErrorCategory;
	readonly escalationReason?: string;
}


// ─── Escalation record ────────────────────────────────────────────────────────

/** A unit that needs a human decision before the pipeline can proceed. */
export interface IEscalatedUnit {
	readonly unitId:      string;
	readonly unitName:    string;
	readonly riskLevel:   string;
	readonly domain?:     string;
	readonly phaseId?:    string;
	/** Human-readable explanation of why the unit was escalated. */
	readonly reason:      string;
	/** Which stage triggered the escalation. */
	readonly stage:       AutonomyStage | null;
	/** Error category if escalation was due to error exhaustion. */
	readonly errorCategory?: AutonomyErrorCategory;
	readonly escalatedAt: number;
}


// ─── Escalation resolution ────────────────────────────────────────────────────

export type EscalationDecision =
	| 'approve'           // Manually approve \u2192 sets KB status to 'approved'
	| 'skip'              // Mark as 'skipped' — excluded from future runs
	| 'revert-to-pending' // Reset to 'pending' for a complete fresh attempt from the start
	| 'block';            // Mark as 'blocked' with reason — requires a documented rationale

export interface IEscalationResolution {
	readonly unitId:      string;
	readonly unitName:    string;
	readonly decision:    EscalationDecision;
	readonly resolvedBy:  string;
	readonly resolvedAt:  number;
	readonly reason?:     string;
}


// ─── Auto-approval configuration ─────────────────────────────────────────────

/**
 * Configuration for the auto-approval policy.
 * Passed to `evaluateAutoApproval()` to customise thresholds.
 *
 * Hard gates (risk=critical/high, regulated domain, blocked fingerprint,
 * pending decision) are NOT configurable — they always escalate.
 */
export interface IAutoApprovalConfig {
	/**
	 * Additional domain patterns to treat as regulated.
	 * Each string is used as a case-insensitive literal substring check.
	 * Default regulated patterns (PII/PCI/PHI/GDPR/HIPAA/SOX) always apply.
	 */
	additionalRegulatedPatterns?: string[];

	/**
	 * When true, escalate if fingerprint comparison overallResult is 'warning'
	 * (configurable gate 5). Default: true.
	 */
	escalateOnFingerprintWarning?: boolean;

	/**
	 * When true, escalate if any `rule-removed` divergence is found
	 * (configurable gate 6). Default: true.
	 */
	escalateOnRuleRemoved?: boolean;

	/**
	 * When true, check whether all `dependsOn` units are in a terminal
	 * or approved state before auto-approving. Default: true.
	 */
	checkDependencyCompletion?: boolean;

	/**
	 * When true, block auto-approval if a compliance gate check fails.
	 * Default: true.
	 */
	checkComplianceGate?: boolean;
}

export const DEFAULT_AUTO_APPROVAL_CONFIG: Required<IAutoApprovalConfig> = {
	additionalRegulatedPatterns: [],
	escalateOnFingerprintWarning: true,
	escalateOnRuleRemoved:        true,
	checkDependencyCompletion:    true,
	checkComplianceGate:          true,
};


// ─── Batch options ────────────────────────────────────────────────────────────

export interface IAutonomyOptions {
	/**
	 * Which pipeline stages to run.
	 * Default: all four — ['resolve', 'translate', 'validate', 'commit'].
	 */
	stages?:            AutonomyStage[];

	/**
	 * Maximum number of units processed concurrently.
	 * Adaptive concurrency is applied on top — if error rate spikes,
	 * effective concurrency is temporarily halved.
	 * Default: 3.
	 */
	maxConcurrency?:    number;

	/**
	 * Number of retryable errors per unit before escalating.
	 * Non-retryable errors (e.g. validation-divergence) escalate immediately.
	 * Default: 3.
	 */
	maxRetriesPerUnit?: number;

	/**
	 * Per-stage timeout in milliseconds.
	 * If a stage call takes longer than this, the unit is retried or escalated.
	 * Default: 5 minutes.
	 */
	stageTimeoutMs?:    number;

	/**
	 * When true: low/medium-risk units that pass all configurable auto-approval
	 * checks are transitioned to 'approved' automatically.
	 * Hard gates (high/critical risk, regulated domains) always escalate.
	 * When false (default): all review-stage units are escalated to a human.
	 */
	autoApprove?:       boolean;

	/**
	 * Auto-approval policy configuration.
	 * Only meaningful when autoApprove=true.
	 */
	approvalConfig?:    IAutoApprovalConfig;

	/**
	 * Only process units belonging to these domain names.
	 * Empty array or undefined = all domains.
	 */
	domainFilter?:      string[];

	/**
	 * When true, domainFilter becomes an exclusion list instead of an inclusion list.
	 * Default: false.
	 */
	excludeDomains?:    boolean;

	/**
	 * Only process units assigned to these phaseIds.
	 * Empty array or undefined = all phases.
	 */
	phaseFilter?:       string[];

	/**
	 * If provided, only process these specific unit IDs.
	 * Takes precedence over all other filters.
	 */
	unitIdFilter?:      string[];

	/**
	 * Target language key passed to the translation engine (e.g. 'java', 'typescript', 'python').
	 * Required by the translation loop for result labelling and idiom selection.
	 * Defaults to '' (empty string) if not provided — the AI will infer from context.
	 */
	targetLanguage?:    string;
}

export const DEFAULT_AUTONOMY_OPTIONS: Required<Omit<IAutonomyOptions, 'unitIdFilter' | 'approvalConfig' | 'targetLanguage'>> = {
	stages:            ALL_AUTONOMY_STAGES,
	maxConcurrency:    3,
	maxRetriesPerUnit: 3,
	stageTimeoutMs:    5 * 60 * 1000, // 5 minutes
	autoApprove:       false,
	domainFilter:      [],
	excludeDomains:    false,
	phaseFilter:       [],
};


// ─── Schedule preview ─────────────────────────────────────────────────────────

export interface IAutonomyScheduleEntry {
	unitId:        string;
	unitName:      string;
	status:        string;
	riskLevel:     string;
	domain?:       string;
	phaseId?:      string;
	depthInGraph:  number;
	priorityScore: number;
	dependsOn:     string[];
	usedBy:        string[];
}

export interface IAutonomySchedulePreview {
	totalUnits:     number;
	byStage:        Record<AutonomyStage, number>;
	byRisk:         Record<string, number>;
	byDomain:       Record<string, number>;
	depthGroups:    Array<{ depth: number; unitCount: number; units: IAutonomyScheduleEntry[] }>;
}


// ─── Batch metrics ────────────────────────────────────────────────────────────

/** Per-stage timing statistics (collected across all units in a run). */
export interface IStageTiming {
	/** Number of units that completed this stage in this run. */
	count:   number;
	/** Total wall-clock milliseconds across all completions. */
	totalMs: number;
	minMs:   number;
	maxMs:   number;
	/** Average duration; 0 if count === 0. */
	avgMs:   number;
}

export interface IAutonomyBatchMetrics {
	readonly runId:          string;
	readonly startedAt:      number;
	readonly completedAt:    number;
	readonly durationMs:     number;
	readonly wasAborted:     boolean;

	// Unit outcome counts
	readonly totalProcessed: number;
	readonly advanced:       number;
	readonly escalated:      number;
	readonly errors:         number;
	readonly skipped:        number;

	// Stage-level completions
	readonly byStage:        Record<AutonomyStage, number>;

	// Stage timing statistics
	readonly stageTiming:    Record<AutonomyStage, IStageTiming>;

	// Error breakdown
	readonly byErrorCategory: Partial<Record<AutonomyErrorCategory, number>>;

	// Throughput
	/** Units advanced per minute (0 if < 10s elapsed). */
	readonly unitsPerMinute: number;

	// ETA
	/** Estimated ms remaining to process all remaining units; null if not calculable. */
	readonly estimatedRemainingMs: number | null;

	// Domain and risk breakdowns
	readonly byDomain: Record<string, number>;
	readonly byRisk:   Record<string, number>;

	// Unit ID lists for the console unit index
	readonly advancedUnitIds:  string[];
	readonly escalatedUnitIds: string[];
	readonly errorUnitIds:     string[];
	readonly skippedUnitIds:   string[];
}

/** Build an empty metrics object for a new batch run. */
export function emptyBatchMetrics(runId: string, startedAt: number): IAutonomyBatchMetrics {
	const stageZero: IStageTiming = { count: 0, totalMs: 0, minMs: 0, maxMs: 0, avgMs: 0 };
	return {
		runId,
		startedAt,
		completedAt:          startedAt,
		durationMs:           0,
		wasAborted:           false,
		totalProcessed:       0,
		advanced:             0,
		escalated:            0,
		errors:               0,
		skipped:              0,
		byStage:              { resolve: 0, translate: 0, validate: 0, commit: 0 },
		stageTiming:          {
			resolve:   { ...stageZero },
			translate: { ...stageZero },
			validate:  { ...stageZero },
			commit:    { ...stageZero },
		},
		byErrorCategory:      {},
		unitsPerMinute:       0,
		estimatedRemainingMs: null,
		byDomain:             {},
		byRisk:               {},
		advancedUnitIds:      [],
		escalatedUnitIds:     [],
		errorUnitIds:         [],
		skippedUnitIds:       [],
	};
}


// ─── Progress events ──────────────────────────────────────────────────────────

export interface IAutonomyUnitStartedEvent {
	readonly unitId:   string;
	readonly unitName: string;
	readonly stage:    AutonomyStage | null;
	readonly index:    number;
	readonly total:    number;
}

export interface IAutonomyUnitCompletedEvent {
	readonly result:   IAutonomyUnitResult;
	readonly index:    number;
	readonly total:    number;
	readonly metrics:  IAutonomyBatchMetrics;
}

export interface IAutonomyBatchCompletedEvent {
	readonly metrics:    IAutonomyBatchMetrics;
	readonly wasAborted: boolean;
}

export type IAutonomyProgress =
	| { type: 'unit-started';    data: IAutonomyUnitStartedEvent }
	| { type: 'unit-completed';  data: IAutonomyUnitCompletedEvent }
	| { type: 'batch-completed'; data: IAutonomyBatchCompletedEvent };


// ─── Batch state change event ─────────────────────────────────────────────────

export interface IBatchStateChange {
	readonly prev:  BatchState;
	readonly next:  BatchState;
	readonly runId: string | null;
}


// ─── Persisted batch run record ───────────────────────────────────────────────

/**
 * A summary of a completed (or interrupted) batch run.
 * Stored in `IStorageService` so run history survives IDE restarts.
 * At most `MAX_RUN_HISTORY` runs are retained.
 */
export interface IAutonomyBatchRun {
	readonly runId:       string;
	readonly startedAt:   number;
	readonly completedAt: number;
	readonly state:       BatchState;
	readonly metrics:     IAutonomyBatchMetrics;
	/** Escalations raised during this run. */
	readonly escalations: IEscalatedUnit[];
	/** Human decisions made during this run. */
	readonly resolutions: IEscalationResolution[];
}

export const MAX_RUN_HISTORY = 20;


// ─── KB annotation constants ──────────────────────────────────────────────────

/** Annotation kind used for all autonomy-managed annotations. */
export const AUTONOMY_ANNOTATION_KIND = 'agent-note' as const;

/**
 * Annotation content prefix for per-unit retry tracking.
 * Full content: `autonomy:retry:<unitId>:<count>:<errorMsg>`
 */
export const AUTONOMY_RETRY_PREFIX = 'autonomy:retry:';

/**
 * Annotation content prefix for recording the last stage attempted.
 * Full content: `autonomy:last-stage:<unitId>:<stage>`
 */
export const AUTONOMY_LAST_STAGE_PREFIX = 'autonomy:last-stage:';
