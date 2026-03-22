/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Autonomy Service
 *
 * The DI-registered façade for Phase 12 — Agent Autonomy.
 *
 * Drives the full modernisation pipeline without requiring human input per unit:
 *   Resolve → Translate → [Auto-approve?] → Validate → Commit
 *
 * ## DI token
 *
 * ```typescript
 * import { IAutonomyService } from '.../autonomy/service.js';
 * constructor(@IAutonomyService private readonly _autonomy: IAutonomyService) {}
 * ```
 *
 * ## Typical usage
 *
 * ```typescript
 * // Start the pipeline (all stages, no auto-approve)
 * const metrics = await this._autonomy.startBatch();
 *
 * // Start with auto-approve for low/medium risk units
 * const metrics = await this._autonomy.startBatch({ autoApprove: true });
 *
 * // Preview what would be processed without running
 * const preview = this._autonomy.previewSchedule({ stages: ['resolve', 'translate'] });
 *
 * // Run a single unit immediately
 * const result = await this._autonomy.runSingleUnit('unit-abc-123');
 *
 * // Pause mid-run (can be resumed)
 * this._autonomy.pauseBatch();
 * await this._autonomy.resumeBatch();
 *
 * // Resolve an escalation (human decision)
 * await this._autonomy.resolveEscalation('unit-abc-123', 'approve', 'alice@corp.com', 'Reviewed and verified.');
 *
 * // Check current escalations
 * const pending = this._autonomy.escalatedUnits;
 * ```
 *
 * ## Batch lifecycle
 *
 *   idle → running → (pausing) → paused → running → stopping → completed | error
 *
 * ## Thread safety
 *
 * At most one batch can be active at a time. Calling `startBatch()` or
 * `resumeBatch()` while `isRunning` is true throws `AutonomyBatchAlreadyRunningError`.
 *
 * `runSingleUnit()` is always available regardless of batch state.
 */

import { Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import {
	IAutonomyOptions,
	IAutonomyBatchMetrics,
	IAutonomyProgress,
	IEscalatedUnit,
	IEscalationResolution,
	IAutonomyUnitResult,
	IAutonomyBatchRun,
	IAutonomySchedulePreview,
	IBatchStateChange,
	BatchState,
	EscalationDecision,
} from './impl/autonomyTypes.js';


// ─── DI token ─────────────────────────────────────────────────────────────────

export const IAutonomyService = createDecorator<IAutonomyService>('autonomyService');


// ─── Single-unit options ──────────────────────────────────────────────────────

export interface IRunSingleUnitOptions {
	/** Force this stage regardless of unit status. Default: inferred from status. */
	forceStage?:  import('./impl/autonomyTypes.js').AutonomyStage;
	/** Override autoApprove for this unit only. */
	autoApprove?: boolean;
	/** Override stageTimeoutMs for this unit only. */
	timeoutMs?:   number;
}


// ─── Service interface ────────────────────────────────────────────────────────

export interface IAutonomyService {
	readonly _serviceBrand: undefined;

	// ── State ─────────────────────────────────────────────────────────────────

	/** True while a batch is actively processing units. */
	readonly isRunning:     boolean;

	/** True if the batch has been paused (draining, not yet stopped). */
	readonly isPaused:      boolean;

	/** Full lifecycle state of the most recent (or current) batch. */
	readonly batchState:    BatchState;

	/** Run ID of the currently active batch, or null when idle/completed. */
	readonly currentRunId:  string | null;

	/** Metrics from the most recently completed batch (null if never run). */
	readonly lastBatchMetrics: IAutonomyBatchMetrics | null;

	/** All units currently awaiting a human decision. */
	readonly escalatedUnits: IEscalatedUnit[];

	// ── Events ────────────────────────────────────────────────────────────────

	/** Fires for unit-started, unit-completed, and batch-completed events. */
	readonly onProgress:           Event<IAutonomyProgress>;

	/** Fires each time a unit is escalated to a human. */
	readonly onUnitEscalated:      Event<IEscalatedUnit>;

	/** Fires each time a human resolves an escalation. */
	readonly onEscalationResolved: Event<IEscalationResolution>;

	/** Fires on every batch state transition (idle→running, running→paused, etc.). */
	readonly onBatchStateChanged:  Event<IBatchStateChange>;

	// ── Batch control ─────────────────────────────────────────────────────────

	/**
	 * Start the autonomy batch.
	 *
	 * Drives all eligible units through the requested pipeline stages:
	 *   pending→ready (resolve), ready→review (translate),
	 *   review→approved (policy/auto-approve), approved→validated (validate),
	 *   validated→committed (commit)
	 *
	 * High-risk and regulated-domain units always escalate regardless of autoApprove.
	 *
	 * @param options  Batch configuration (stages, concurrency, autoApprove, filters)
	 * @returns        Resolves with final metrics when all eligible units are processed
	 * @throws         `AutonomyBatchAlreadyRunningError` if a batch is already running
	 */
	startBatch(options?: IAutonomyOptions): Promise<IAutonomyBatchMetrics>;

	/**
	 * Pause a running batch.
	 *
	 * In-flight unit jobs drain to completion before the pause takes effect.
	 * The batch can be resumed from where it left off with `resumeBatch()`.
	 * Units remain at their current status — no rollback.
	 *
	 * No-op if no batch is running.
	 */
	pauseBatch(): void;

	/**
	 * Resume a previously paused batch.
	 *
	 * Restarts the scheduler, excluding units already processed in the prior run.
	 * Uses the same options as the original `startBatch()` call.
	 *
	 * @throws `AutonomyBatchAlreadyRunningError` if a batch is already running
	 * @throws `Error` if no paused batch is available
	 */
	resumeBatch(): Promise<IAutonomyBatchMetrics>;

	/**
	 * Stop (abort) the running batch.
	 *
	 * In-flight unit jobs drain gracefully before the stop takes effect.
	 * Processed unit IDs are NOT persisted — resuming is not possible after `stopBatch()`.
	 * Use `pauseBatch()` if you want to resume later.
	 *
	 * No-op if no batch is running.
	 */
	stopBatch(): void;

	// ── Single-unit API ────────────────────────────────────────────────────────

	/**
	 * Execute the next pipeline step for a single unit immediately.
	 * Bypasses the scheduler — useful for targeted retry or human-driven progression.
	 *
	 * Safe to call while a batch is running; the autonomy loop handles concurrent
	 * lock conflicts gracefully (returns 'skipped' if locked).
	 *
	 * @param unitId  KB unit ID to advance
	 * @param opts    Optional per-unit overrides
	 */
	runSingleUnit(unitId: string, opts?: IRunSingleUnitOptions): Promise<IAutonomyUnitResult>;

	// ── Escalation management ──────────────────────────────────────────────────

	/**
	 * Record a human decision for an escalated unit and apply it to the KB.
	 *
	 * Decision semantics:
	 *   - 'approve':           sets KB status to 'approved' (unit can now be validated)
	 *   - 'skip':              sets KB status to 'skipped'
	 *   - 'revert-to-pending': sets KB status back to 'pending' for a fresh attempt
	 *   - 'block':             sets KB status to 'blocked' with `reason` as blockedReason;
	 *                          `reason` is required for 'block' and 'approve'
	 *
	 * The unit is removed from the `escalatedUnits` list after this call.
	 * Fires `onEscalationResolved`.
	 *
	 * @param unitId     KB unit ID
	 * @param decision   The human's decision
	 * @param resolvedBy Identity of the person resolving (e.g. email, username)
	 * @param reason     Documented rationale (required for 'approve' and 'block')
	 */
	resolveEscalation(
		unitId:      string,
		decision:    EscalationDecision,
		resolvedBy:  string,
		reason?:     string,
	): Promise<void>;

	/**
	 * Remove all escalated units from the list without resolving them.
	 * Units remain at their current KB status (no transition applied).
	 * Use `resolveEscalation()` to properly handle individual units.
	 */
	clearEscalations(): void;

	// ── Schedule preview ───────────────────────────────────────────────────────

	/**
	 * Preview the autonomy schedule without executing any pipeline stages.
	 * Returns the ordered unit list with depth groups and aggregate counts.
	 *
	 * @param options  Options to apply to the schedule (stages, filters)
	 */
	previewSchedule(options?: IAutonomyOptions): IAutonomySchedulePreview;

	// ── History ────────────────────────────────────────────────────────────────

	/**
	 * Return the history of completed batch runs, most recent first.
	 * Persisted across IDE restarts.
	 */
	getRunHistory(): IAutonomyBatchRun[];

	/**
	 * Return the most recent batch run record, or null if never run.
	 */
	getLastRun(): IAutonomyBatchRun | null;
}


// ─── Error types ──────────────────────────────────────────────────────────────

export class AutonomyBatchAlreadyRunningError extends Error {
	constructor() {
		super('An autonomy batch is already running. Call stopBatch() or pauseBatch() first.');
		this.name = 'AutonomyBatchAlreadyRunningError';
	}
}

export class NoPausedBatchError extends Error {
	constructor() {
		super('No paused batch to resume. Call startBatch() to begin a new run.');
		this.name = 'NoPausedBatchError';
	}
}

export class MissingEscalationReasonError extends Error {
	constructor(decision: EscalationDecision) {
		super(`A documented reason is required for the '${decision}' decision.`);
		this.name = 'MissingEscalationReasonError';
	}
}
