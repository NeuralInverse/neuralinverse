/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Autonomy Loop
 *
 * Executes one pipeline step for a single knowledge unit.
 * Called concurrently by batchAutonomyEngine.
 *
 * ## State machine
 *
 *   status='pending'   → ISourceResolutionService.resolveUnit()
 *                         KB transitions: pending → resolving → ready
 *
 *   status='ready'     → ITranslationEngineService.translateUnit()
 *                         KB transitions: ready → translating → review
 *
 *   status='review'    → autoApprovalPolicy evaluation
 *                         → if auto-approved: setUnitStatus('approved')
 *                         → if escalated: emit IEscalatedUnit, outcome='escalated'
 *
 *   status='approved'  → IValidationEngineService.validateUnit()
 *                         KB transitions: approved → validating → validated | flagged
 *
 *   status='validated' → ICutoverService.commitBatch({ eligibleStatuses: ['validated'] })
 *                         KB transitions: validated → committed
 *
 *   status='flagged'   → escalate immediately (divergence needs human override)
 *
 *   in-flight statuses → skip (resolving / translating / validating / committing)
 *   terminal statuses  → skip (committed / complete / skipped / blocked)
 *
 * ## Locking
 *
 *   The loop acquires a KB unit lock before making any service call and releases
 *   it in `finally`. If the unit is already locked, it returns 'skipped'.
 *   The review/policy step does NOT hold a lock during the LLM-free policy evaluation
 *   (lock acquired only during the status write).
 *
 * ## Retry tracking
 *
 *   Retry counts are stored as KB annotations (kind='system') with the prefix
 *   `autonomy:retry:<unitId>`. On each retryable error the counter is incremented.
 *   When counter >= maxRetriesPerUnit the unit is escalated and the annotation
 *   is updated with a full error summary.
 *
 *   Non-retryable errors (validation-divergence, missing-source) escalate immediately
 *   without incrementing the retry counter.
 *
 * ## Per-stage timeout
 *
 *   Each stage call is raced against `stageTimeoutMs` using `Promise.race()`.
 *   A timeout counts as a retryable error.
 *
 * ## Error contract
 *
 *   `runAutonomyLoop()` NEVER throws. Every error path returns an
 *   `IAutonomyUnitResult` with outcome='error' or outcome='escalated'.
 */

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { IKnowledgeUnit } from '../../../../common/knowledgeBaseTypes.js';
import { ISourceResolutionService } from '../../resolution/service.js';
import { ITranslationEngineService } from '../../translation/service.js';
import { IValidationEngineService } from '../../validation/service.js';
import { ICutoverService } from '../../cutover/service.js';
import { evaluateAutoApproval, formatAuditTrail } from './autoApprovalPolicy.js';
import {
	IAutonomyOptions,
	IAutoApprovalConfig,
	IAutonomyUnitResult,
	IEscalatedUnit,
	AutonomyStage,
	DEFAULT_AUTONOMY_OPTIONS,
	AUTONOMY_ANNOTATION_KIND,
	AUTONOMY_RETRY_PREFIX,
	AUTONOMY_LAST_STAGE_PREFIX,
	classifyError,
	isRetryableError,
	AutonomyErrorCategory,
} from './autonomyTypes.js';
import type { ICommitJobResult } from '../../cutover/impl/commitWriter.js';
import { DEFAULT_TRANSLATION_OPTIONS } from '../../translation/impl/translationTypes.js';


// ─── Constants ────────────────────────────────────────────────────────────────

const LOCK_OWNER   = 'autonomy-engine';
const LOCK_TTL_MS  = 12 * 60 * 1000; // 12 minutes — enough for all but the slowest LLM calls

/** In-flight statuses set by other engines — skip these to avoid conflicts. */
const IN_FLIGHT_STATUSES = new Set<string>([
	'resolving', 'translating', 'validating', 'committing',
]);

/** Terminal statuses — nothing to do. */
const TERMINAL_STATUSES = new Set<string>([
	'committed', 'complete', 'skipped', 'blocked',
]);


// ─── Dependencies struct ──────────────────────────────────────────────────────

export interface IAutonomyLoopDeps {
	readonly kb:             IKnowledgeBaseService;
	readonly resolution:     ISourceResolutionService;
	readonly translation:    ITranslationEngineService;
	readonly validation:     IValidationEngineService;
	readonly cutover:        ICutoverService;
	readonly sourceRoot:     string;
	readonly targetRoot:     string;
	/** Target language key for the translation engine (e.g. 'java', 'typescript'). */
	readonly targetLanguage: string;
}


// ─── Main entry ───────────────────────────────────────────────────────────────

/**
 * Execute one pipeline step for a single unit.
 * Returns a result; never throws.
 *
 * @param unitId      KB unit ID to advance
 * @param attemptIndex  0-based attempt index for this unit within the current run
 * @param options     Autonomy batch options
 * @param deps        Service dependencies
 * @param signal      Abort signal from the batch controller
 * @param onEscalated Callback fired when the unit needs human attention
 */
export async function runAutonomyLoop(
	unitId:       string,
	attemptIndex: number,
	options:      IAutonomyOptions,
	deps:         IAutonomyLoopDeps,
	signal:       AbortSignal,
	onEscalated:  (e: IEscalatedUnit) => void,
): Promise<IAutonomyUnitResult> {
	const startMs      = Date.now();
	const maxRetries   = options.maxRetriesPerUnit ?? DEFAULT_AUTONOMY_OPTIONS.maxRetriesPerUnit;
	const timeoutMs    = options.stageTimeoutMs    ?? DEFAULT_AUTONOMY_OPTIONS.stageTimeoutMs;
	const autoApprove  = options.autoApprove       ?? DEFAULT_AUTONOMY_OPTIONS.autoApprove;
	const stages       = options.stages            ?? DEFAULT_AUTONOMY_OPTIONS.stages;
	const approvalCfg  = options.approvalConfig;
	let   lockAcquired = false;

	try {
		// ── Abort check ──────────────────────────────────────────────────────────
		if (signal.aborted) {
			return _skip(unitId, 'unknown', startMs, attemptIndex);
		}

		// ── Load unit ────────────────────────────────────────────────────────────
		const unit = deps.kb.getUnit(unitId);
		if (!unit) {
			return _errorResult(unitId, 'unknown', startMs, attemptIndex,
				'Unit not found in KB.', 'unknown', false);
		}

		const { id, name, status } = unit;

		// ── In-flight / terminal guard ───────────────────────────────────────────
		if (TERMINAL_STATUSES.has(status))  { return _skip(id, name, startMs, attemptIndex); }
		if (IN_FLIGHT_STATUSES.has(status)) { return _skip(id, name, startMs, attemptIndex); }

		// ── Stage eligibility ───────────────────────────────────────────────────
		// Skip if the stage that handles this status is not in the requested list
		const requiredStage = _statusToStage(status);
		if (requiredStage && !stages.includes(requiredStage)) {
			return _skip(id, name, startMs, attemptIndex);
		}

		// ── Policy evaluation (review) — no lock needed for the check itself ─────
		if (status === 'review') {
			return _doReview(id, name, unit, startMs, attemptIndex, deps, autoApprove, approvalCfg, onEscalated);
		}

		// ── Flagged — escalate immediately without acquiring lock ────────────────
		if (status === 'flagged') {
			return _escalate(
				id, name, startMs, attemptIndex, null,
				unit.riskLevel ?? 'unknown',
				typeof unit.domain === 'string' ? unit.domain : undefined,
				unit.phaseId,
				'Unit is flagged — equivalence divergence requires human override before the pipeline can proceed.',
				undefined,
				onEscalated,
			);
		}

		// ── Acquire KB lock (all service-calling stages) ─────────────────────────
		const lock = deps.kb.lockUnit(id, LOCK_OWNER, LOCK_TTL_MS);
		if (!lock) {
			// Another concurrent worker holds the lock — skip gracefully
			return _skip(id, name, startMs, attemptIndex);
		}
		lockAcquired = true;

		// Re-read status after acquiring lock — it may have changed
		const freshUnit = deps.kb.getUnit(id);
		if (!freshUnit) {
			return _errorResult(id, name, startMs, attemptIndex, 'Unit disappeared after lock acquisition.', 'unknown', false);
		}
		if (freshUnit.status !== status) {
			// Status changed between our eligibility check and the lock — skip
			return _skip(id, name, startMs, attemptIndex);
		}

		// ── Dispatch ────────────────────────────────────────────────────────────
		if (status === 'pending') {
			return await _withTimeout(
				() => _doResolve(id, name, startMs, attemptIndex, maxRetries, deps, signal, onEscalated),
				timeoutMs,
				id, name, startMs, attemptIndex, 'resolve', deps.kb, maxRetries, onEscalated,
			);
		}

		if (status === 'ready') {
			return await _withTimeout(
				() => _doTranslate(id, name, startMs, attemptIndex, maxRetries, deps, signal, onEscalated),
				timeoutMs,
				id, name, startMs, attemptIndex, 'translate', deps.kb, maxRetries, onEscalated,
			);
		}

		if (status === 'approved') {
			return await _withTimeout(
				() => _doValidate(id, name, startMs, attemptIndex, maxRetries, deps, signal, onEscalated),
				timeoutMs,
				id, name, startMs, attemptIndex, 'validate', deps.kb, maxRetries, onEscalated,
			);
		}

		if (status === 'validated') {
			return await _withTimeout(
				() => _doCommit(id, name, startMs, attemptIndex, maxRetries, deps, signal, onEscalated),
				timeoutMs,
				id, name, startMs, attemptIndex, 'commit', deps.kb, maxRetries, onEscalated,
			);
		}

		// Unknown status (shouldn't reach here after guards above)
		return _skip(id, name, startMs, attemptIndex);

	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return _errorResult(unitId, 'unknown', startMs, attemptIndex, msg, 'unknown', false);

	} finally {
		if (lockAcquired) {
			deps.kb.unlockUnit(unitId, LOCK_OWNER);
		}
	}
}


// ─── Stage handlers ───────────────────────────────────────────────────────────

async function _doResolve(
	unitId:      string,
	unitName:    string,
	startMs:     number,
	attempt:     number,
	maxRetries:  number,
	deps:        IAutonomyLoopDeps,
	signal:      AbortSignal,
	onEscalated: (e: IEscalatedUnit) => void,
): Promise<IAutonomyUnitResult> {
	// Mark in-flight
	deps.kb.setUnitStatus(unitId, 'resolving', 'Autonomy engine: resolution in progress.', LOCK_OWNER);
	try {
		if (signal.aborted) { return _aborted(unitId, unitName, startMs, attempt); }
		await deps.resolution.resolveUnit(unitId);
		_clearRetries(unitId, deps.kb);
		_recordLastStage(unitId, 'resolve', deps.kb);
		return _advanced(unitId, unitName, 'resolve', startMs, attempt);
	} catch (err: unknown) {
		// Resolution service reverts status to 'pending' on failure
		const msg = err instanceof Error ? err.message : String(err);
		return _handleError(unitId, unitName, 'resolve', startMs, attempt, maxRetries, msg, deps.kb, onEscalated);
	}
}

async function _doTranslate(
	unitId:      string,
	unitName:    string,
	startMs:     number,
	attempt:     number,
	maxRetries:  number,
	deps:        IAutonomyLoopDeps,
	signal:      AbortSignal,
	onEscalated: (e: IEscalatedUnit) => void,
): Promise<IAutonomyUnitResult> {
	// Mark in-flight
	deps.kb.setUnitStatus(unitId, 'translating', 'Autonomy engine: translation in progress.', LOCK_OWNER);
	try {
		if (signal.aborted) { return _aborted(unitId, unitName, startMs, attempt); }
		const result = await deps.translation.translateUnit(
			unitId,
			{ ...DEFAULT_TRANSLATION_OPTIONS, targetLanguage: deps.targetLanguage },
			deps.sourceRoot,
			deps.targetRoot,
		);

		if (result.outcome === 'error') {
			// Revert to 'ready' so the translation engine doesn't leave it in limbo
			deps.kb.setUnitStatus(unitId, 'ready', 'Autonomy engine: translation error — reverted for retry.', LOCK_OWNER);
			return _handleError(
				unitId, unitName, 'translate', startMs, attempt, maxRetries,
				result.error ?? 'Translation produced an error outcome.', deps.kb, onEscalated,
			);
		}

		if (result.outcome === 'blocked') {
			// Blocking decision — escalate immediately (non-retryable)
			const unit = deps.kb.getUnit(unitId);
			return _escalate(
				unitId, unitName, startMs, attempt, 'translate',
				unit?.riskLevel ?? 'unknown',
				typeof unit?.domain === 'string' ? unit.domain : undefined,
				unit?.phaseId,
				`Translation blocked: ${result.error ?? 'pending decision requires resolution before proceeding.'}`,
				'missing-target',
				onEscalated,
			);
		}

		_clearRetries(unitId, deps.kb);
		_recordLastStage(unitId, 'translate', deps.kb);
		return _advanced(unitId, unitName, 'translate', startMs, attempt);
	} catch (err: unknown) {
		deps.kb.setUnitStatus(unitId, 'ready', 'Autonomy engine: translation threw — reverted for retry.', LOCK_OWNER);
		const msg = err instanceof Error ? err.message : String(err);
		return _handleError(unitId, unitName, 'translate', startMs, attempt, maxRetries, msg, deps.kb, onEscalated);
	}
}

function _doReview(
	unitId:      string,
	unitName:    string,
	unit:        IKnowledgeUnit,
	startMs:     number,
	attempt:     number,
	deps:        IAutonomyLoopDeps,
	autoApprove: boolean,
	approvalCfg: IAutoApprovalConfig | undefined,
	onEscalated: (e: IEscalatedUnit) => void,
): IAutonomyUnitResult {
	const policy = evaluateAutoApproval(unit, deps.kb, autoApprove, approvalCfg);

	// Record audit trail as annotation
	const auditText = formatAuditTrail(policy.auditTrail);
	deps.kb.addAnnotation(
		unitId,
		`autonomy:policy:${Date.now()}\n${auditText}`,
		LOCK_OWNER,
		AUTONOMY_ANNOTATION_KIND,
	);

	if (policy.decision === 'approved') {
		deps.kb.setUnitStatus(unitId, 'approved', 'Autonomy engine: auto-approved via policy.', LOCK_OWNER);
		_clearRetries(unitId, deps.kb);
		_recordLastStage(unitId, 'translate', deps.kb); // review is the tail of translate
		return _advanced(unitId, unitName, 'translate', startMs, attempt);
	}

	// Escalate — do NOT change unit status (stays in 'review' for human to act on)
	const domain = typeof unit.domain === 'string' ? unit.domain : undefined;
	return _escalate(
		unitId, unitName, startMs, attempt, null,
		unit.riskLevel ?? 'unknown', domain, unit.phaseId,
		policy.reason, undefined, onEscalated,
	);
}

async function _doValidate(
	unitId:      string,
	unitName:    string,
	startMs:     number,
	attempt:     number,
	maxRetries:  number,
	deps:        IAutonomyLoopDeps,
	signal:      AbortSignal,
	onEscalated: (e: IEscalatedUnit) => void,
): Promise<IAutonomyUnitResult> {
	// Mark in-flight
	deps.kb.setUnitStatus(unitId, 'validating', 'Autonomy engine: validation in progress.', LOCK_OWNER);
	try {
		if (signal.aborted) { return _aborted(unitId, unitName, startMs, attempt); }
		const result = await deps.validation.validateUnit(unitId);

		if (result.outcome === 'error') {
			deps.kb.setUnitStatus(unitId, 'approved', 'Autonomy engine: validation error — reverted for retry.', LOCK_OWNER);
			return _handleError(
				unitId, unitName, 'validate', startMs, attempt, maxRetries,
				result.error ?? 'Validation engine error.', deps.kb, onEscalated,
			);
		}

		if (result.outcome === 'failed' || result.outcome === 'partial') {
			// Divergences found — escalate immediately (non-retryable without human override)
			const unit = deps.kb.getUnit(unitId);
			return _escalate(
				unitId, unitName, startMs, attempt, 'validate',
				unit?.riskLevel ?? 'unknown',
				typeof unit?.domain === 'string' ? unit.domain : undefined,
				unit?.phaseId,
				`Validation ${result.outcome}: ${result.failCount} test case(s) failed. ${result.analysis?.slice(0, 200) ?? ''}`.trim(),
				'validation-divergence',
				onEscalated,
			);
		}

		// 'validated' or 'skipped'
		_clearRetries(unitId, deps.kb);
		_recordLastStage(unitId, 'validate', deps.kb);
		return _advanced(unitId, unitName, 'validate', startMs, attempt);
	} catch (err: unknown) {
		deps.kb.setUnitStatus(unitId, 'approved', 'Autonomy engine: validation threw — reverted for retry.', LOCK_OWNER);
		const msg = err instanceof Error ? err.message : String(err);
		return _handleError(unitId, unitName, 'validate', startMs, attempt, maxRetries, msg, deps.kb, onEscalated);
	}
}

async function _doCommit(
	unitId:      string,
	unitName:    string,
	startMs:     number,
	attempt:     number,
	maxRetries:  number,
	deps:        IAutonomyLoopDeps,
	signal:      AbortSignal,
	onEscalated: (e: IEscalatedUnit) => void,
): Promise<IAutonomyUnitResult> {
	try {
		if (signal.aborted) { return _aborted(unitId, unitName, startMs, attempt); }

		// Commit the entire set of validated units (commitBatch has no per-unit filter).
		// If this unit is in 'validated', it will be picked up.
		const batchResult = await deps.cutover.commitBatch({
			eligibleStatuses: ['validated'],
			skipExisting:     false,
		});

		// Verify this specific unit was committed successfully
		const unitJob = batchResult.jobs.find((j: ICommitJobResult) => j.unitId === unitId);
		if (unitJob && !unitJob.ok) {
			return _handleError(
				unitId, unitName, 'commit', startMs, attempt, maxRetries,
				unitJob.errorMsg ?? 'Commit write failed.', deps.kb, onEscalated,
			);
		}

		// If unit wasn't in the batch results at all, it may have been committed
		// by a concurrent worker — treat as success
		_clearRetries(unitId, deps.kb);
		_recordLastStage(unitId, 'commit', deps.kb);
		return _advanced(unitId, unitName, 'commit', startMs, attempt);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return _handleError(unitId, unitName, 'commit', startMs, attempt, maxRetries, msg, deps.kb, onEscalated);
	}
}


// ─── Stage timeout wrapper ────────────────────────────────────────────────────

async function _withTimeout(
	fn:          () => Promise<IAutonomyUnitResult>,
	timeoutMs:   number,
	unitId:      string,
	unitName:    string,
	startMs:     number,
	attempt:     number,
	stage:       AutonomyStage,
	kb:          IKnowledgeBaseService,
	maxRetries:  number,
	onEscalated: (e: IEscalatedUnit) => void,
): Promise<IAutonomyUnitResult> {
	let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

	const timeoutPromise = new Promise<IAutonomyUnitResult>((resolve) => {
		timeoutHandle = setTimeout(() => {
			resolve(_handleError(
				unitId, unitName, stage, startMs, attempt, maxRetries,
				`Stage '${stage}' timed out after ${Math.round(timeoutMs / 1000)}s.`,
				kb, onEscalated,
			));
		}, timeoutMs);
	});

	try {
		const result = await Promise.race([fn(), timeoutPromise]);
		return result;
	} finally {
		if (timeoutHandle !== null) { clearTimeout(timeoutHandle); }
	}
}


// ─── Retry management ─────────────────────────────────────────────────────────

function _getRetryCount(unitId: string, kb: IKnowledgeBaseService): number {
	const key  = AUTONOMY_RETRY_PREFIX + unitId;
	const anns = kb.getAnnotations(unitId);
	const ann  = anns.find(a => a.content.startsWith(key + ':'));
	if (!ann) { return 0; }
	const rest  = ann.content.slice(key.length + 1); // after "autonomy:retry:<unitId>:"
	const count = parseInt(rest.split(':')[0] ?? '0', 10);
	return Number.isNaN(count) ? 0 : count;
}

function _incrementRetries(unitId: string, kb: IKnowledgeBaseService, errorMsg: string): number {
	const key      = AUTONOMY_RETRY_PREFIX + unitId;
	const anns     = kb.getAnnotations(unitId);
	const existing = anns.find(a => a.content.startsWith(key + ':'));
	const current  = existing ? _getRetryCount(unitId, kb) : 0;
	const next     = current + 1;
	const content  = `${key}:${next}:${errorMsg.slice(0, 200)}`;

	if (existing) {
		kb.updateAnnotation(existing.id, content);
	} else {
		kb.addAnnotation(unitId, content, LOCK_OWNER, AUTONOMY_ANNOTATION_KIND);
	}
	return next;
}

function _clearRetries(unitId: string, kb: IKnowledgeBaseService): void {
	const key  = AUTONOMY_RETRY_PREFIX + unitId;
	const anns = kb.getAnnotations(unitId);
	for (const ann of anns) {
		if (ann.content.startsWith(key + ':')) {
			kb.deleteAnnotation(ann.id);
		}
	}
}

function _recordLastStage(unitId: string, stage: AutonomyStage, kb: IKnowledgeBaseService): void {
	const key  = AUTONOMY_LAST_STAGE_PREFIX + unitId;
	const anns = kb.getAnnotations(unitId);
	const existing = anns.find(a => a.content.startsWith(key + ':'));
	const content  = `${key}:${stage}`;
	if (existing) {
		kb.updateAnnotation(existing.id, content);
	} else {
		kb.addAnnotation(unitId, content, LOCK_OWNER, AUTONOMY_ANNOTATION_KIND);
	}
}

function _handleError(
	unitId:      string,
	unitName:    string,
	stage:       AutonomyStage,
	startMs:     number,
	attempt:     number,
	maxRetries:  number,
	errorMsg:    string,
	kb:          IKnowledgeBaseService,
	onEscalated: (e: IEscalatedUnit) => void,
): IAutonomyUnitResult {
	const category   = classifyError(errorMsg, stage);
	const retryable  = isRetryableError(category);

	if (!retryable) {
		// Non-retryable — escalate immediately
		const unit   = kb.getUnit(unitId);
		const domain = unit && typeof unit.domain === 'string' ? unit.domain : undefined;
		return _escalate(
			unitId, unitName, startMs, attempt, stage,
			unit?.riskLevel ?? 'unknown', domain, unit?.phaseId,
			`Non-retryable error at '${stage}' [${category}]: ${errorMsg}`,
			category,
			onEscalated,
		);
	}

	const retryCount = _incrementRetries(unitId, kb, errorMsg);

	if (retryCount >= maxRetries) {
		// Retries exhausted — escalate
		const unit   = kb.getUnit(unitId);
		const domain = unit && typeof unit.domain === 'string' ? unit.domain : undefined;
		return _escalate(
			unitId, unitName, startMs, attempt, stage,
			unit?.riskLevel ?? 'unknown', domain, unit?.phaseId,
			`${maxRetries} retries exhausted at '${stage}' [${category}]. Last error: ${errorMsg.slice(0, 300)}`,
			category,
			onEscalated,
		);
	}

	// Retryable and under limit — return error outcome; unit stays in current status for retry
	return _errorResult(unitId, unitName, startMs, attempt,
		`[${category}] attempt ${retryCount}/${maxRetries} at '${stage}': ${errorMsg}`,
		category, true);
}


// ─── Status → stage mapping ───────────────────────────────────────────────────

function _statusToStage(status: string): AutonomyStage | null {
	switch (status) {
		case 'pending':   return 'resolve';
		case 'ready':     return 'translate';
		case 'approved':  return 'validate';
		case 'validated': return 'commit';
		default:          return null;
	}
}


// ─── Result factories ─────────────────────────────────────────────────────────

function _advanced(
	unitId:   string,
	unitName: string,
	stage:    AutonomyStage,
	startMs:  number,
	attempt:  number,
): IAutonomyUnitResult {
	return {
		unitId, unitName,
		stageCompleted: stage,
		outcome:        'advanced',
		durationMs:     Date.now() - startMs,
		attemptIndex:   attempt,
	};
}

function _skip(
	unitId:   string,
	unitName: string,
	startMs:  number,
	attempt:  number,
): IAutonomyUnitResult {
	return {
		unitId, unitName,
		stageCompleted: null,
		outcome:        'skipped',
		durationMs:     Date.now() - startMs,
		attemptIndex:   attempt,
	};
}

function _aborted(
	unitId:   string,
	unitName: string,
	startMs:  number,
	attempt:  number,
): IAutonomyUnitResult {
	return {
		unitId, unitName,
		stageCompleted: null,
		outcome:        'skipped',
		durationMs:     Date.now() - startMs,
		attemptIndex:   attempt,
		errorMsg:       'Aborted by batch controller.',
	};
}

function _errorResult(
	unitId:    string,
	unitName:  string,
	startMs:   number,
	attempt:   number,
	errorMsg:  string,
	category:  AutonomyErrorCategory,
	retryable: boolean,
): IAutonomyUnitResult {
	return {
		unitId, unitName,
		stageCompleted:  null,
		outcome:         'error',
		durationMs:      Date.now() - startMs,
		attemptIndex:    attempt,
		errorMsg:        retryable ? `[retryable] ${errorMsg}` : errorMsg,
		errorCategory:   category,
	};
}

function _escalate(
	unitId:       string,
	unitName:     string,
	startMs:      number,
	attempt:      number,
	stage:        AutonomyStage | null,
	riskLevel:    string,
	domain:       string | undefined,
	phaseId:      string | undefined,
	reason:       string,
	category:     AutonomyErrorCategory | undefined,
	onEscalated:  (e: IEscalatedUnit) => void,
): IAutonomyUnitResult {
	const escaped: IEscalatedUnit = {
		unitId, unitName, riskLevel, domain, phaseId,
		reason, stage, errorCategory: category,
		escalatedAt: Date.now(),
	};
	onEscalated(escaped);
	return {
		unitId, unitName,
		stageCompleted:   null,
		outcome:          'escalated',
		durationMs:       Date.now() - startMs,
		attemptIndex:     attempt,
		escalationReason: reason,
		errorCategory:    category,
	};
}
