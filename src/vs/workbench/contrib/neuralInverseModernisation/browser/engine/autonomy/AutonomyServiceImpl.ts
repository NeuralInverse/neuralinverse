/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Autonomy Service Implementation
 *
 * Production implementation of `IAutonomyService` for Phase 12 — Agent Autonomy.
 *
 * ## Lifecycle
 *
 *   idle → running → (pausing) → paused → running → stopping → completed | error
 *
 * ## Pause / Resume
 *
 *   Pause aborts the current `AbortController`, which causes the batch engine to
 *   drain in-flight jobs and return. The set of unit IDs that completed during the
 *   paused run (`_pausedProcessedIds`) is preserved and passed to `AutonomyScheduler`
 *   on resume so those units are excluded from re-processing.
 *
 * ## Stop vs Pause
 *
 *   Both call `_currentController.abort()`. The `_pauseRequested` flag distinguishes
 *   the two paths when `_startBatchInternal` awaits the engine:
 *     - `_pauseRequested = true` → transition to 'paused', preserve processedIds
 *     - `_pauseRequested = false` → transition to 'completed' (wasAborted=true), clear state
 *
 * ## Run History
 *
 *   Completed (and error) run records are persisted to `IStorageService` under
 *   `HISTORY_STORAGE_KEY` (workspace scope). At most `MAX_RUN_HISTORY` records
 *   are kept (oldest are discarded). Paused runs are NOT persisted (they are
 *   considered in-progress) — they are saved only when they eventually complete.
 *
 * ## Zombie lock cleanup
 *
 *   At the start of every `_startBatchInternal` call (both fresh and resumed),
 *   `kb.releaseAllLocksFor('autonomy-engine')` is called. This handles the case
 *   where a prior run was interrupted mid-stage (IDE crash, force-quit) leaving
 *   units locked in an in-flight status ('resolving', 'translating', 'validating').
 *   The lock release + scheduler re-evaluation restores those units to the queue.
 *
 * ## Escalation management
 *
 *   `_escalatedUnits` is the live list of units awaiting human decisions.
 *   `resolveEscalation()` applies the appropriate KB status transition and removes
 *   the unit from the list. Per-run escalation and resolution records are accumulated
 *   in `_currentRunEscalations` / `_currentRunResolutions` for persistence in the
 *   run history record.
 *
 * ## Single-unit API
 *
 *   `runSingleUnit()` is always available regardless of batch state. It creates its
 *   own single-use `AbortController` and calls `runAutonomyLoop()` directly, bypassing
 *   the scheduler. If `opts.forceStage` is set, the unit's KB status is first
 *   transitioned to the appropriate input status for that stage before the loop runs.
 */

import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IKnowledgeBaseService } from '../../knowledgeBase/service.js';
import { ISourceResolutionService } from '../resolution/service.js';
import { ITranslationEngineService } from '../translation/service.js';
import { IValidationEngineService } from '../validation/service.js';
import { ICutoverService } from '../cutover/service.js';
import { IModernisationSessionService } from '../../modernisationSessionService.js';
import {
	IAutonomyService,
	IRunSingleUnitOptions,
	AutonomyBatchAlreadyRunningError,
	NoPausedBatchError,
	MissingEscalationReasonError,
} from './service.js';
import { runBatchAutonomyEngine } from './impl/batchAutonomyEngine.js';
import { runAutonomyLoop, IAutonomyLoopDeps } from './impl/autonomyLoop.js';
import { AutonomyScheduler } from './impl/autonomyScheduler.js';
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
	AutonomyStage,
	DEFAULT_AUTONOMY_OPTIONS,
	MAX_RUN_HISTORY,
	emptyBatchMetrics,
} from './impl/autonomyTypes.js';


// ─── Constants ────────────────────────────────────────────────────────────────

/** Key under which the run history array is stored in `IStorageService`. */
const HISTORY_STORAGE_KEY = 'neuralInverse:autonomy:run-history';

/** Lock owner token — matches the constant in batchAutonomyEngine.ts. */
const LOCK_OWNER = 'autonomy-engine';

/**
 * Maps each autonomy stage to the KB unit status that is the required *input*
 * for that stage. Used by `runSingleUnit()` to force a specific stage.
 *
 *   resolve   requires status 'pending'
 *   translate requires status 'ready'
 *   validate  requires status 'approved'
 *   commit    requires status 'validated'
 */
const STAGE_TO_INPUT_STATUS: Record<AutonomyStage, string> = {
	resolve:   'pending',
	translate: 'ready',
	validate:  'approved',
	commit:    'validated',
};


// ─── Implementation ───────────────────────────────────────────────────────────

export class AutonomyServiceImpl extends Disposable implements IAutonomyService {
	readonly _serviceBrand: undefined;


	// ── Events ────────────────────────────────────────────────────────────────

	private readonly _onProgress           = this._register(new Emitter<IAutonomyProgress>());
	private readonly _onUnitEscalated      = this._register(new Emitter<IEscalatedUnit>());
	private readonly _onEscalationResolved = this._register(new Emitter<IEscalationResolution>());
	private readonly _onBatchStateChanged  = this._register(new Emitter<IBatchStateChange>());

	readonly onProgress:           Event<IAutonomyProgress>       = this._onProgress.event;
	readonly onUnitEscalated:      Event<IEscalatedUnit>          = this._onUnitEscalated.event;
	readonly onEscalationResolved: Event<IEscalationResolution>   = this._onEscalationResolved.event;
	readonly onBatchStateChanged:  Event<IBatchStateChange>       = this._onBatchStateChanged.event;


	// ── Core batch state ──────────────────────────────────────────────────────

	private _batchState:        BatchState           = 'idle';
	private _currentRunId:      string | null        = null;
	private _currentController: AbortController | null = null;
	private _currentOptions:    IAutonomyOptions | null = null;
	private _lastBatchMetrics:  IAutonomyBatchMetrics | null = null;

	/**
	 * True when `pauseBatch()` was called and the controller has been aborted
	 * but the engine has not yet drained. Distinguishes pause from stop when
	 * `_startBatchInternal` resolves.
	 */
	private _pauseRequested = false;

	// ── Pause / resume state ──────────────────────────────────────────────────

	/**
	 * Options used in the batch that was paused.
	 * Re-used verbatim when `resumeBatch()` is called.
	 */
	private _pausedOptions: IAutonomyOptions | null = null;

	/**
	 * Set of unit IDs that completed (regardless of outcome) in the paused run.
	 * Passed to `AutonomyScheduler` on resume to exclude already-processed units.
	 */
	private _pausedProcessedIds: Set<string> | null = null;

	// ── In-progress tracking ──────────────────────────────────────────────────

	/**
	 * Unit IDs processed in the current (or most recently started) run.
	 * Populated by `_handleProgress` on every `unit-completed` event.
	 * Saved to `_pausedProcessedIds` when the batch is paused.
	 */
	private _currentRunProcessedIds: Set<string> = new Set();

	// ── Escalation state ──────────────────────────────────────────────────────

	/** All units currently awaiting a human decision. */
	private _escalatedUnits: IEscalatedUnit[] = [];

	/**
	 * Escalations raised during the current (or most recently started) run.
	 * Persisted in the run history record when the batch ends.
	 */
	private _currentRunEscalations: IEscalatedUnit[] = [];

	/**
	 * Human resolutions applied during the current (or most recently started) run.
	 * Persisted in the run history record when the batch ends.
	 */
	private _currentRunResolutions: IEscalationResolution[] = [];

	// ── Run history (in-memory mirror of persisted storage) ───────────────────

	/**
	 * Completed batch run records, most recent first.
	 * Loaded from `IStorageService` on construction; updated on each run completion.
	 */
	private _runHistory: IAutonomyBatchRun[] = [];


	// ── DI constructor ────────────────────────────────────────────────────────

	constructor(
		@IKnowledgeBaseService        private readonly _kb:         IKnowledgeBaseService,
		@ISourceResolutionService     private readonly _resolution:  ISourceResolutionService,
		@ITranslationEngineService    private readonly _translation: ITranslationEngineService,
		@IValidationEngineService     private readonly _validation:  IValidationEngineService,
		@ICutoverService              private readonly _cutover:     ICutoverService,
		@IModernisationSessionService private readonly _session:     IModernisationSessionService,
		@IStorageService              private readonly _storage:     IStorageService,
	) {
		super();
		this._loadRunHistory();
	}


	// ── IAutonomyService — state getters ──────────────────────────────────────

	/**
	 * True while a batch is actively processing or draining (running / pausing / stopping).
	 * False when idle, paused, completed, or in error.
	 */
	get isRunning(): boolean {
		return this._batchState === 'running'
			|| this._batchState === 'pausing'
			|| this._batchState === 'stopping';
	}

	/** True if the batch has been fully paused and is waiting for `resumeBatch()`. */
	get isPaused(): boolean {
		return this._batchState === 'paused';
	}

	get batchState():       BatchState                     { return this._batchState; }
	get currentRunId():     string | null                  { return this._currentRunId; }
	get lastBatchMetrics(): IAutonomyBatchMetrics | null   { return this._lastBatchMetrics; }
	get escalatedUnits():   IEscalatedUnit[]               { return [...this._escalatedUnits]; }


	// ── IAutonomyService — batch control ─────────────────────────────────────

	/**
	 * Start the autonomy batch from scratch.
	 *
	 * If a batch is currently paused, the paused run state is discarded and a
	 * fresh run begins. This is intentional: the caller explicitly wants a new
	 * batch, not a resume. Use `resumeBatch()` to continue a paused run.
	 *
	 * @throws `AutonomyBatchAlreadyRunningError` if a batch is actively running.
	 */
	async startBatch(options: IAutonomyOptions = {}): Promise<IAutonomyBatchMetrics> {
		if (this.isRunning) {
			throw new AutonomyBatchAlreadyRunningError();
		}

		// Discard any paused run — the caller wants a completely fresh batch.
		this._clearPausedState();

		return this._startBatchInternal(options, new Set());
	}

	/**
	 * Pause a running batch.
	 *
	 * Signals the engine to stop dispatching new units and drain in-flight jobs
	 * to completion. Once drained, batch state transitions to 'paused'.
	 * The list of processed unit IDs is preserved for `resumeBatch()`.
	 *
	 * No-op if no batch is running.
	 */
	pauseBatch(): void {
		if (!this.isRunning || this._batchState === 'pausing' || this._batchState === 'stopping') {
			return;
		}
		this._pauseRequested = true;
		this._setBatchState('pausing');
		this._currentController?.abort();
	}

	/**
	 * Resume a paused batch from where it left off.
	 *
	 * Restarts the scheduler using the same options as the original `startBatch()`
	 * call, excluding all units already processed in the prior run.
	 *
	 * @throws `AutonomyBatchAlreadyRunningError` if a batch is already running.
	 * @throws `NoPausedBatchError` if no paused batch is available.
	 */
	async resumeBatch(): Promise<IAutonomyBatchMetrics> {
		if (this.isRunning) {
			throw new AutonomyBatchAlreadyRunningError();
		}
		if (!this.isPaused || !this._pausedOptions) {
			throw new NoPausedBatchError();
		}

		const options      = this._pausedOptions;
		const processedIds = this._pausedProcessedIds ?? new Set<string>();

		// Clear saved pause state before calling _startBatchInternal to prevent
		// double-resume if the caller holds a reference and calls resumeBatch() again.
		this._clearPausedState();

		return this._startBatchInternal(options, processedIds);
	}

	/**
	 * Stop (abort) a running batch.
	 *
	 * Signals the engine to stop dispatching new units and drain in-flight jobs.
	 * Processed unit IDs are NOT preserved — resuming is not possible after `stopBatch()`.
	 *
	 * No-op if no batch is running.
	 */
	stopBatch(): void {
		if (!this.isRunning || this._batchState === 'stopping' || this._batchState === 'pausing') {
			return;
		}
		this._pauseRequested = false;
		this._setBatchState('stopping');
		this._currentController?.abort();
	}


	// ── IAutonomyService — single-unit API ────────────────────────────────────

	/**
	 * Execute the next pipeline step for a single unit immediately.
	 *
	 * If `opts.forceStage` is provided, the unit's KB status is first transitioned
	 * to the required input status for that stage (e.g. 'pending' for 'resolve').
	 * This allows targeted retry of any specific stage regardless of the unit's
	 * current status.
	 *
	 * Safe to call while a batch is running — the loop handles concurrent lock
	 * conflicts by returning outcome='skipped'.
	 *
	 * @param unitId  KB unit ID to advance
	 * @param opts    Optional per-unit overrides
	 */
	async runSingleUnit(
		unitId: string,
		opts?:  IRunSingleUnitOptions,
	): Promise<IAutonomyUnitResult> {
		const unit = this._kb.getUnit(unitId);
		if (!unit) {
			// Return a synthetic skipped result — the unit doesn't exist.
			return {
				unitId,
				unitName:       unitId,
				stageCompleted: null,
				outcome:        'skipped',
				durationMs:     0,
				attemptIndex:   0,
				errorMsg:       `Unit '${unitId}' not found in the knowledge base.`,
			};
		}

		// ── Force stage ──────────────────────────────────────────────────────────
		// If forceStage is requested, set the unit to the correct "input" status
		// for that stage so the loop picks it up deterministically.
		if (opts?.forceStage) {
			const targetStatus = STAGE_TO_INPUT_STATUS[opts.forceStage];
			const currentStatus = unit.status;
			// Only transition if the status doesn't already match the required input.
			if (targetStatus && currentStatus !== targetStatus) {
				this._kb.setUnitStatus(
					unitId,
					targetStatus as import('../../../common/knowledgeBaseTypes.js').UnitStatus,
					`Force-stage override: setting status to '${targetStatus}' to run stage '${opts.forceStage}'.`,
					'autonomy-service',
				);
			}
		}

		// ── Build merged options ─────────────────────────────────────────────────
		// Merge: global defaults → current batch options → per-unit overrides.
		const mergedOptions: IAutonomyOptions = {
			...DEFAULT_AUTONOMY_OPTIONS,
			...(this._currentOptions ?? {}),
			...(opts?.autoApprove !== undefined ? { autoApprove: opts.autoApprove } : {}),
			...(opts?.timeoutMs   !== undefined ? { stageTimeoutMs: opts.timeoutMs } : {}),
		};

		const { sourceRoot, targetRoot } = this._getRoots();

		const loopDeps: IAutonomyLoopDeps = {
			kb:             this._kb,
			resolution:     this._resolution,
			translation:    this._translation,
			validation:     this._validation,
			cutover:        this._cutover,
			sourceRoot,
			targetRoot,
			targetLanguage: mergedOptions.targetLanguage ?? '',
		};

		const controller = new AbortController();

		const result = await runAutonomyLoop(
			unitId,
			/* attemptIndex */ 0,
			mergedOptions,
			loopDeps,
			controller.signal,
			escalated => this._handleEscalated(escalated),
		);

		// Emit a progress event so UI subscribers see single-unit executions too.
		this._onProgress.fire({
			type: 'unit-completed',
			data: {
				result,
				index:   1,
				total:   1,
				metrics: this._lastBatchMetrics ?? emptyBatchMetrics('single', Date.now()),
			},
		});

		return result;
	}


	// ── IAutonomyService — escalation management ──────────────────────────────

	/**
	 * Record a human decision for an escalated unit and apply it to the KB.
	 *
	 * KB transitions applied per decision:
	 *   - 'approve'           → setUnitStatus('approved')
	 *   - 'skip'              → setUnitStatus('skipped')
	 *   - 'revert-to-pending' → revertUnit() (clears all translation artefacts)
	 *   - 'block'             → setUnitStatus('blocked')
	 *
	 * @throws `MissingEscalationReasonError` if 'approve' or 'block' are called without a reason.
	 */
	async resolveEscalation(
		unitId:     string,
		decision:   EscalationDecision,
		resolvedBy: string,
		reason?:    string,
	): Promise<void> {
		// Validate that a documented reason is provided where required.
		if ((decision === 'approve' || decision === 'block') && !reason) {
			throw new MissingEscalationReasonError(decision);
		}

		const unit = this._kb.getUnit(unitId);
		const unitName = unit?.name ?? unitId;

		// ── Apply KB status transition ────────────────────────────────────────────
		switch (decision) {
			case 'approve':
				this._kb.setUnitStatus(
					unitId, 'approved',
					reason ? `Human approval by ${resolvedBy}: ${reason}` : `Approved by ${resolvedBy}.`,
					'autonomy-service',
				);
				break;

			case 'skip':
				this._kb.setUnitStatus(
					unitId, 'skipped',
					reason ? `Skipped by ${resolvedBy}: ${reason}` : `Skipped by ${resolvedBy}.`,
					'autonomy-service',
				);
				break;

			case 'revert-to-pending':
				// revertUnit() clears targetText, targetFile, translation artefacts,
				// and transitions the unit back to 'pending' for a fresh attempt.
				this._kb.revertUnit(
					unitId,
					reason ? `Reverted by ${resolvedBy}: ${reason}` : `Reverted to pending by ${resolvedBy}.`,
					resolvedBy,
				);
				break;

			case 'block':
				this._kb.setUnitStatus(
					unitId, 'blocked',
					`Blocked by ${resolvedBy}: ${reason!}`,
					'autonomy-service',
				);
				break;
		}

		// ── Build resolution record ───────────────────────────────────────────────
		const resolution: IEscalationResolution = {
			unitId,
			unitName,
			decision,
			resolvedBy,
			resolvedAt: Date.now(),
			reason,
		};

		// ── Remove from live escalated list ───────────────────────────────────────
		this._escalatedUnits = this._escalatedUnits.filter(u => u.unitId !== unitId);

		// ── Accumulate for run history ────────────────────────────────────────────
		this._currentRunResolutions.push(resolution);

		// ── Fire event ────────────────────────────────────────────────────────────
		this._onEscalationResolved.fire(resolution);
	}

	/**
	 * Remove all escalated units from the live list without resolving them.
	 * Units remain at their current KB status — no transition is applied.
	 */
	clearEscalations(): void {
		this._escalatedUnits = [];
	}


	// ── IAutonomyService — schedule preview ───────────────────────────────────

	/**
	 * Preview the autonomy schedule without executing any pipeline stages.
	 * Returns the ordered unit list with depth groups and aggregate counts.
	 *
	 * @param options  Options to apply to the schedule (stages, filters)
	 */
	previewSchedule(options: IAutonomyOptions = {}): IAutonomySchedulePreview {
		const scheduler = AutonomyScheduler.build(
			this._kb.getAllUnits(),
			{ ...DEFAULT_AUTONOMY_OPTIONS, ...options },
			new Set(),
		);
		return scheduler.buildPreview();
	}


	// ── IAutonomyService — run history ────────────────────────────────────────

	/**
	 * Return the history of completed batch runs, most recent first.
	 * Persisted across IDE restarts.
	 */
	getRunHistory(): IAutonomyBatchRun[] {
		return [...this._runHistory];
	}

	/**
	 * Return the most recent batch run record, or null if never run.
	 */
	getLastRun(): IAutonomyBatchRun | null {
		return this._runHistory[0] ?? null;
	}


	// ── Dispose ───────────────────────────────────────────────────────────────

	override dispose(): void {
		// Abort any running batch gracefully before tearing down.
		if (this.isRunning) {
			this._pauseRequested = false;
			this._currentController?.abort();
		}
		// Release any zombie locks left behind.
		try {
			this._kb.releaseAllLocksFor(LOCK_OWNER);
		} catch {
			// KB may already be disposed — ignore.
		}
		super.dispose();
	}


	// ── Internal — batch orchestration ───────────────────────────────────────

	/**
	 * Core batch execution logic shared by `startBatch()` and `resumeBatch()`.
	 *
	 * Never throws in the success path — errors transition state to 'error' and
	 * re-throw for callers who care (though most callers will `.catch()` and log).
	 *
	 * @param options       Batch options for this run.
	 * @param processedIds  Unit IDs to skip (from a prior paused run).
	 */
	private async _startBatchInternal(
		options:      IAutonomyOptions,
		processedIds: ReadonlySet<string>,
	): Promise<IAutonomyBatchMetrics> {
		const runId     = _generateRunId();
		const startedAt = Date.now();

		// ── Initialise per-run state ───────────────────────────────────────────
		this._currentRunId          = runId;
		this._currentOptions        = options;
		this._currentRunProcessedIds = new Set();
		this._currentRunEscalations  = [];
		this._currentRunResolutions  = [];
		this._pauseRequested         = false;
		this._currentController      = new AbortController();

		this._setBatchState('running');

		// ── Release zombie locks from any prior interrupted run ───────────────
		// Units stuck in 'resolving' / 'translating' / 'validating' status with
		// orphaned locks will be unlocked here and picked up by the scheduler.
		try {
			this._kb.releaseAllLocksFor(LOCK_OWNER);
		} catch {
			// KB may not be initialised yet in edge cases — non-fatal.
		}

		const { sourceRoot, targetRoot } = this._getRoots();
		const mergedBatchOptions = { ...DEFAULT_AUTONOMY_OPTIONS, ...options };

		try {
			const metrics = await runBatchAutonomyEngine({
				kb:          this._kb,
				resolution:  this._resolution,
				translation: this._translation,
				validation:  this._validation,
				cutover:     this._cutover,
				sourceRoot,
				targetRoot,
				options:     mergedBatchOptions,
				runId,
				controller:  this._currentController,
				processedIds,
				onProgress:  e => this._handleProgress(e),
				onEscalated: u => this._handleEscalated(u),
			});

			this._lastBatchMetrics = metrics;

			// ── Transition state based on pause vs stop ────────────────────────
			if (this._pauseRequested) {
				// Batch was paused — preserve processedIds and options for resume.
				this._pausedOptions      = options;
				this._pausedProcessedIds = new Set(this._currentRunProcessedIds);
				this._setBatchState('paused');
				// DO NOT persist a run record for paused runs — they are incomplete.
				// The record will be written when the run eventually completes.
				// Keep _currentRunId set so callers can identify the paused run.
			} else {
				// Batch ran to completion (or was stopped via stopBatch()).
				this._persistRunRecord(runId, startedAt, 'completed', metrics);
				this._currentRunId = null;
				this._setBatchState('completed');
			}

			return metrics;

		} catch (err: unknown) {
			// The batch engine is designed to never throw, but guard defensively.
			const partialMetrics = this._lastBatchMetrics ?? emptyBatchMetrics(runId, startedAt);
			this._persistRunRecord(runId, startedAt, 'error', partialMetrics);
			this._currentRunId = null;
			this._setBatchState('error');
			throw err;

		} finally {
			this._currentController = null;
			this._currentOptions    = null;
			// Note: _currentRunId intentionally NOT cleared for paused runs.
			// It was already cleared above for completed/error runs.
		}
	}


	// ── Internal — event routing ──────────────────────────────────────────────

	/**
	 * Handle a progress event from the batch engine.
	 *
	 * Tracks completed unit IDs for pause/resume and forwards the event to
	 * all external subscribers via `onProgress`.
	 */
	private _handleProgress(event: IAutonomyProgress): void {
		if (event.type === 'unit-completed') {
			// Track unit ID for pause/resume processedIds set.
			this._currentRunProcessedIds.add(event.data.result.unitId);
		}
		this._onProgress.fire(event);
	}

	/**
	 * Handle a unit escalation raised by the autonomy loop.
	 *
	 * Adds to the live escalation list, accumulates for run history, and fires
	 * the `onUnitEscalated` event for UI and agent subscribers.
	 */
	private _handleEscalated(unit: IEscalatedUnit): void {
		// Avoid duplicate entries if the same unit is escalated multiple times
		// (e.g. escalated, resolved, then escalated again in the same run).
		const existing = this._escalatedUnits.findIndex(u => u.unitId === unit.unitId);
		if (existing !== -1) {
			this._escalatedUnits[existing] = unit; // Replace with the newer record.
		} else {
			this._escalatedUnits.push(unit);
		}
		this._currentRunEscalations.push(unit);
		this._onUnitEscalated.fire(unit);
	}


	// ── Internal — batch state management ────────────────────────────────────

	/**
	 * Transition the batch state, firing `onBatchStateChanged` on every transition.
	 */
	private _setBatchState(next: BatchState): void {
		const prev = this._batchState;
		if (prev === next) { return; }
		this._batchState = next;
		this._onBatchStateChanged.fire({ prev, next, runId: this._currentRunId });
	}

	/**
	 * Clear all paused run state.
	 * Called when starting a fresh batch from paused state, or when stopping.
	 */
	private _clearPausedState(): void {
		this._pausedOptions      = null;
		this._pausedProcessedIds = null;
		if (this._batchState === 'paused') {
			this._currentRunId = null;
			this._setBatchState('idle');
		}
	}


	// ── Internal — run history ────────────────────────────────────────────────

	/**
	 * Persist a completed or errored batch run to storage.
	 * Prepends the record (most-recent-first) and trims to `MAX_RUN_HISTORY`.
	 *
	 * Storage failures are non-fatal — history is an audit convenience, not
	 * a correctness requirement.
	 */
	private _persistRunRecord(
		runId:     string,
		startedAt: number,
		state:     BatchState,
		metrics:   IAutonomyBatchMetrics,
	): void {
		const record: IAutonomyBatchRun = {
			runId,
			startedAt,
			completedAt: Date.now(),
			state,
			metrics,
			escalations: [...this._currentRunEscalations],
			resolutions: [...this._currentRunResolutions],
		};

		this._runHistory.unshift(record); // Most recent first.
		if (this._runHistory.length > MAX_RUN_HISTORY) {
			this._runHistory.length = MAX_RUN_HISTORY;
		}

		try {
			this._storage.store(
				HISTORY_STORAGE_KEY,
				JSON.stringify(this._runHistory),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE,
			);
		} catch {
			// Storage failure is non-fatal — silently drop.
		}
	}

	/**
	 * Load run history from storage into `_runHistory` on construction.
	 * Validates the structure defensively — corrupted storage starts fresh.
	 */
	private _loadRunHistory(): void {
		try {
			const raw = this._storage.get(HISTORY_STORAGE_KEY, StorageScope.WORKSPACE);
			if (raw) {
				const parsed: unknown = JSON.parse(raw);
				if (Array.isArray(parsed)) {
					// Validate each record has at least the minimal required fields.
					this._runHistory = (parsed as IAutonomyBatchRun[]).filter(
						r => typeof r === 'object' && r !== null
							&& typeof r.runId      === 'string'
							&& typeof r.startedAt  === 'number'
							&& r.metrics != null,
					);
					// Enforce max-history cap on whatever was loaded.
					if (this._runHistory.length > MAX_RUN_HISTORY) {
						this._runHistory.length = MAX_RUN_HISTORY;
					}
				}
			}
		} catch {
			// Corrupted or unparseable storage — start fresh.
			this._runHistory = [];
		}
	}


	// ── Internal — utility ────────────────────────────────────────────────────

	/**
	 * Derive source and target root file-system paths from the active session.
	 *
	 * Uses the first entry of `session.sources` and `session.targets`.
	 * Returns empty strings if no session is active or no roots are configured —
	 * the loop will produce 'missing-source' errors for affected units, which
	 * is the correct behaviour and will trigger escalation.
	 */
	private _getRoots(): { sourceRoot: string; targetRoot: string } {
		const session   = this._session.session;
		const sourceUri = session.sources?.[0]?.folderUri;
		const targetUri = session.targets?.[0]?.folderUri;
		return {
			sourceRoot: sourceUri ? URI.parse(sourceUri).fsPath : '',
			targetRoot: targetUri ? URI.parse(targetUri).fsPath : '',
		};
	}
}


// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Generate a unique, sortable run ID.
 * Format: `autonomy-<base36-timestamp>-<random-suffix>`
 * Example: `autonomy-lrz5k8g-x4f2m9`
 */
function _generateRunId(): string {
	const ts     = Date.now().toString(36);
	const suffix = Math.random().toString(36).slice(2, 8);
	return `autonomy-${ts}-${suffix}`;
}
