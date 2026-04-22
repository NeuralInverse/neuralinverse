/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Batch Translation Engine
 *
 * Orchestrates the concurrent execution of the translation loop across all
 * eligible units in a batch, subject to concurrency limits.
 *
 * ## Concurrency Model
 *
 * Uses a "pool of promises" pattern:
 *  - Maintains a `Set<Promise<void>>` of in-flight translation jobs.
 *  - When a job completes, it is removed from the set.
 *  - A new job is started as soon as the pool drops below `maxConcurrency`.
 *  - Dequeues units in scheduler priority order (leaf-first, critical-first).
 *
 * ## Status transitions
 *
 * Before dispatching a unit the engine calls `kb.setUnitStatus(unitId, 'translating')`.
 * After the loop returns it calls `recordTranslationResult()` which handles all
 * further status transitions (review, blocked, error).
 *
 * ## Per-unit failure tracking & permanent blocking
 *
 * The engine tracks how many times each unit has produced an error outcome within
 * this batch run. If a unit fails `MAX_UNIT_FAILURES_BEFORE_PERMANENT_BLOCK` times,
 * the recorder is called with `permanentlyFailed = true`, which moves the unit to
 * 'blocked' status instead of back to 'ready'. This prevents the scheduler from
 * endlessly retrying an unresolvable failure and wasting LLM budget.
 *
 * ## Progress events
 *
 * The engine emits three event types via the `ITranslationBatchProgress` callback:
 *   - `unit-started`    — a unit just entered the translation loop
 *   - `unit-completed`  — a unit produced a result (any outcome)
 *   - `batch-completed` — all units have been processed
 *
 * ## Abort
 *
 * The caller holds the `AbortController`. Calling `controller.abort()` causes:
 *  1. All in-flight `callLLM()` promises to return `null` (via AbortSignal).
 *  2. The dequeue loop to stop scheduling new jobs.
 *  3. Any already-dispatched unit to complete as 'skipped'.
 *  4. The `run()` promise to resolve after all in-flight jobs drain.
 */

import { Emitter, Event } from '../../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { ILLMMessageService } from '../../../../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../../../../../void/common/voidSettingsService.js';
import { ITranslationOptions, ITranslationResult } from './translationTypes.js';
import { TranslationScheduler } from './translationScheduler.js';
import { runTranslationLoop } from './translationLoop.js';
import { recordTranslationResult } from './translationRecorder.js';
import { TranslationMetricsCollector, ITranslationBatchMetrics } from './translationMetrics.js';

export type { ITranslationBatchMetrics, ILanguagePairMetrics } from './translationMetrics.js';


// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * After this many consecutive error outcomes for the same unit in one batch,
 * the unit is permanently blocked (status='blocked') instead of returned to 'ready'.
 * This prevents infinite retry loops on unresolvable failures.
 */
const MAX_UNIT_FAILURES_BEFORE_PERMANENT_BLOCK = 2;


// ─── Event types ──────────────────────────────────────────────────────────────

export interface ITranslationUnitStartedEvent {
	unitId:   string;
	unitName: string;
	/** 1-based index of this unit in the batch */
	index:    number;
	total:    number;
}

export interface ITranslationUnitCompletedEvent {
	result:   ITranslationResult;
	/** 1-based index of completed unit */
	index:    number;
	total:    number;
	metrics:  ITranslationBatchMetrics;
}

export interface ITranslationBatchCompletedEvent {
	metrics:    ITranslationBatchMetrics;
	/** True if aborted by the caller before all units were processed */
	wasAborted: boolean;
}

export type ITranslationBatchProgress =
	| { type: 'unit-started';    data: ITranslationUnitStartedEvent }
	| { type: 'unit-completed';  data: ITranslationUnitCompletedEvent }
	| { type: 'batch-completed'; data: ITranslationBatchCompletedEvent };


// ─── Batch options ─────────────────────────────────────────────────────────────

export interface IBatchTranslationOptions {
	options:      ITranslationOptions;
	/** Filesystem root of the source project (for target file path derivation) */
	sourceRoot:   string;
	/** Filesystem root where translated output should be written */
	targetRoot:   string;
	/** If provided, only translate these specific unit IDs (subset of eligible units) */
	unitIdFilter?: string[];
	/** Optional migration pattern ID from the session — passed to translationLoop for sector aiGuidance injection */
	migrationPatternId?: string;
}


// ─── Batch engine ─────────────────────────────────────────────────────────────

export class BatchTranslationEngine extends Disposable {

	// ── Events ────────────────────────────────────────────────────────────────

	private readonly _onProgress = this._register(new Emitter<ITranslationBatchProgress>());
	readonly onProgress: Event<ITranslationBatchProgress> = this._onProgress.event;

	constructor(
		private readonly _kb:       IKnowledgeBaseService,
		private readonly _llm:      ILLMMessageService,
		private readonly _settings: IVoidSettingsService,
	) {
		super();
	}

	// ── Run ───────────────────────────────────────────────────────────────────

	/**
	 * Translate all eligible units in the KB.
	 *
	 * @param batchOptions  Options for this run
	 * @param controller    Abort controller — call `.abort()` to stop the batch
	 * @returns             Final batch metrics when all units are done (or aborted)
	 */
	async run(
		batchOptions: IBatchTranslationOptions,
		controller: AbortController,
	): Promise<ITranslationBatchMetrics> {
		const { options, sourceRoot, targetRoot, unitIdFilter, migrationPatternId } = batchOptions;
		const signal = controller.signal;

		// ── Collect eligible units ────────────────────────────────────────────
		const allUnits = this._kb.getAllUnits();
		const filteredUnits = unitIdFilter && unitIdFilter.length > 0
			? allUnits.filter(u => unitIdFilter.includes(u.id))
			: allUnits;

		// Build the priority-ordered schedule
		const scheduler = TranslationScheduler.build(filteredUnits, options);
		const metrics   = new TranslationMetricsCollector(scheduler.total);

		if (scheduler.total === 0) {
			const finalMetrics = metrics.snapshot();
			this._onProgress.fire({ type: 'batch-completed', data: { metrics: finalMetrics, wasAborted: false } });
			return finalMetrics;
		}

		// ── Per-unit failure counter ──────────────────────────────────────────
		// Tracks how many error outcomes a unit has accumulated in this batch run.
		// When a unit reaches MAX_UNIT_FAILURES_BEFORE_PERMANENT_BLOCK, it is
		// permanently blocked instead of returned to 'ready'.
		const failureCount = new Map<string, number>();

		// ── Concurrency pool ──────────────────────────────────────────────────
		const maxConcurrency = Math.max(1, options.maxConcurrency ?? 3);
		const inFlight       = new Set<Promise<void>>();
		let dispatchedCount  = 0;
		const total          = scheduler.total;

		const dispatchNext = (): void => {
			while (!signal.aborted && inFlight.size < maxConcurrency && scheduler.hasNext) {
				const item = scheduler.dequeue();
				if (!item) { break; }

				const { unit } = item;
				const jobIndex = ++dispatchedCount;

				// Mark unit as translating in the KB
				this._kb.setUnitStatus(unit.id, 'translating', undefined, 'translation-engine');

				// Emit started event
				this._onProgress.fire({
					type: 'unit-started',
					data: { unitId: unit.id, unitName: unit.name, index: jobIndex, total },
				});

				const job = runTranslationLoop(unit.id, options, this._kb, this._llm, this._settings, signal, migrationPatternId)
					.then(async result => {
						if (result.outcome !== 'skipped') {
							// Determine if this error is the final straw for this unit
							let permanentlyFailed = false;
							if (result.outcome === 'error') {
								const prev = failureCount.get(unit.id) ?? 0;
								const next  = prev + 1;
								failureCount.set(unit.id, next);
								permanentlyFailed = next >= MAX_UNIT_FAILURES_BEFORE_PERMANENT_BLOCK;
							}

							// Write result to KB (async — awaited for interface extraction)
							await recordTranslationResult(
								result, this._kb, sourceRoot, targetRoot,
								this._llm, this._settings, permanentlyFailed,
							);
						} else {
							// Skipped (abort or lock collision) — revert to 'ready'
							this._kb.setUnitStatus(unit.id, 'ready', undefined, 'translation-engine');
						}

						// Record metrics
						metrics.record(result);

						this._onProgress.fire({
							type: 'unit-completed',
							data: { result, index: jobIndex, total, metrics: metrics.snapshot() },
						});
					})
					.catch(async (err: unknown) => {
						// Defensive: runTranslationLoop should never throw, but guard anyway
						const errMsg = err instanceof Error ? err.message : String(err);
						const prev   = failureCount.get(unit.id) ?? 0;
						const next   = prev + 1;
						failureCount.set(unit.id, next);
						const permanentlyFailed = next >= MAX_UNIT_FAILURES_BEFORE_PERMANENT_BLOCK;

						const errorResult: ITranslationResult = {
							unitId:          unit.id,
							unitName:        unit.name,
							sourceLang:      unit.sourceLang,
							targetLang:      options.targetLanguage,
							translatedCode:  '',
							confidence:      'uncertain',
							reasoning:       '',
							decisionsRaised: [],
							tokensUsed:      0,
							attemptCount:    0,
							durationMs:      0,
							outcome:         'error',
							error:           `Unexpected engine error: ${errMsg}`,
						};

						await recordTranslationResult(
							errorResult, this._kb, sourceRoot, targetRoot,
							this._llm, this._settings, permanentlyFailed,
						);

						metrics.record(errorResult);
						this._onProgress.fire({
							type: 'unit-completed',
							data: { result: errorResult, index: jobIndex, total, metrics: metrics.snapshot() },
						});
					})
					.finally(() => {
						inFlight.delete(job);
						if (!signal.aborted) { dispatchNext(); }
					});

				inFlight.add(job);
			}
		};

		// ── Kick off initial batch ────────────────────────────────────────────
		dispatchNext();

		// ── Wait for all in-flight jobs to complete ───────────────────────────
		while (inFlight.size > 0) {
			await Promise.race(inFlight);
		}

		const finalMetrics = metrics.snapshot();
		this._onProgress.fire({
			type: 'batch-completed',
			data: { metrics: finalMetrics, wasAborted: signal.aborted },
		});

		return finalMetrics;
	}
}
