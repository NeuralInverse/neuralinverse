/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Batch Autonomy Engine
 *
 * Orchestrates the concurrent execution of the autonomy loop across all
 * eligible units, modelled after BatchTranslationEngine.
 *
 * ## Concurrency model
 *
 * Uses the `dispatchNext()` pattern (identical to BatchTranslationEngine):
 *   - A `Set<Promise<void>>` of in-flight jobs is maintained.
 *   - `dispatchNext()` fills the pool up to `maxConcurrency`.
 *   - Each job's `.finally()` removes itself from the pool and calls `dispatchNext()`.
 *   - The main loop `await Promise.race(inFlight)` until the queue is drained.
 *
 * ## Adaptive concurrency
 *
 * The engine tracks a rolling error rate over the last `ADAPTIVE_WINDOW` units.
 * If the error rate exceeds `ADAPTIVE_ERROR_THRESHOLD`, effective concurrency
 * is halved (with a floor of 1). This prevents thundering-herd failures when
 * a downstream service is degraded.
 *
 * Error rate recovers automatically as successful units are processed.
 *
 * ## Permanent blocking
 *
 * A per-unit failure counter tracks engine-level errors (not retryable errors
 * tracked by the loop itself). If a unit produces MAX_PERMANENT_BLOCK_FAILURES
 * consecutive error outcomes, it is permanently blocked in the KB.
 *
 * ## Status revert on abort
 *
 * When the batch is aborted, any unit currently marked as an in-flight status
 * (resolving / translating / validating) is reverted to its prior actionable
 * status by the loop's error handling. The engine also calls
 * `kb.releaseAllLocksFor(LOCK_OWNER)` after the drain to clean up zombie locks.
 *
 * ## Events
 *
 * Fires three event types through the `onProgress` callback:
 *   - `unit-started`    — unit entered the loop; includes index + total + stage
 *   - `unit-completed`  — unit produced a result; includes live metrics snapshot
 *   - `batch-completed` — all units processed; includes final metrics + wasAborted
 */

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { ISourceResolutionService } from '../../resolution/service.js';
import { ITranslationEngineService } from '../../translation/service.js';
import { IValidationEngineService } from '../../validation/service.js';
import { ICutoverService } from '../../cutover/service.js';
import { AutonomyScheduler } from './autonomyScheduler.js';
import { runAutonomyLoop, IAutonomyLoopDeps } from './autonomyLoop.js';
import { AutonomyMetricsCollector } from './autonomyMetrics.js';
import {
	IAutonomyOptions,
	IAutonomyBatchMetrics,
	IAutonomyProgress,
	IEscalatedUnit,
	DEFAULT_AUTONOMY_OPTIONS,
	emptyBatchMetrics,
} from './autonomyTypes.js';


// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * After this many consecutive error outcomes from the engine (not the loop's
 * own retry counter), the unit is permanently blocked to stop wasting resources.
 */
const MAX_PERMANENT_BLOCK_FAILURES = 3;

/**
 * Rolling window size for adaptive concurrency calculation.
 */
const ADAPTIVE_WINDOW = 10;

/**
 * If the error rate in the last ADAPTIVE_WINDOW units exceeds this threshold,
 * effective concurrency is halved.
 */
const ADAPTIVE_ERROR_THRESHOLD = 0.4;

const LOCK_OWNER = 'autonomy-engine';


// ─── Engine options ───────────────────────────────────────────────────────────

export interface IBatchAutonomyEngineOptions {
	readonly kb:          IKnowledgeBaseService;
	readonly resolution:  ISourceResolutionService;
	readonly translation: ITranslationEngineService;
	readonly validation:  IValidationEngineService;
	readonly cutover:     ICutoverService;
	readonly sourceRoot:  string;
	readonly targetRoot:  string;
	readonly options:     IAutonomyOptions;
	readonly runId:       string;
	/** Abort controller — call `.abort()` to stop or pause the batch. */
	readonly controller:  AbortController;
	readonly onProgress:  (event: IAutonomyProgress) => void;
	readonly onEscalated: (unit: IEscalatedUnit) => void;
	/**
	 * Set of unit IDs that have already been processed (from a prior paused run).
	 * The scheduler will exclude these units.
	 */
	readonly processedIds?: ReadonlySet<string>;
}


// ─── Engine ───────────────────────────────────────────────────────────────────

/**
 * Run the autonomy batch.
 * Returns final metrics when all units are processed or the batch is aborted.
 * Never throws.
 */
export async function runBatchAutonomyEngine(
	engineOpts: IBatchAutonomyEngineOptions,
): Promise<IAutonomyBatchMetrics> {
	const {
		kb, resolution, translation, validation, cutover,
		sourceRoot, targetRoot,
		options, runId, controller,
		onProgress, onEscalated,
		processedIds = new Set(),
	} = engineOpts;

	const targetLanguage = options.targetLanguage ?? '';

	const signal         = controller.signal;
	const maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_AUTONOMY_OPTIONS.maxConcurrency);
	const startedAt      = Date.now();

	// ── Build schedule ────────────────────────────────────────────────────────
	const scheduler  = AutonomyScheduler.build(kb.getAllUnits(), options, processedIds);
	const totalUnits = scheduler.total;

	if (totalUnits === 0) {
		const metrics = emptyBatchMetrics(runId, startedAt);
		onProgress({ type: 'batch-completed', data: { metrics, wasAborted: false } });
		return metrics;
	}

	const collector = new AutonomyMetricsCollector(runId, totalUnits, startedAt);

	const loopDeps: IAutonomyLoopDeps = {
		kb, resolution, translation, validation, cutover,
		sourceRoot, targetRoot, targetLanguage,
	};

	// ── Per-unit engine-level failure tracking ────────────────────────────────
	// Separate from the loop's own retry annotation — tracks consecutive engine
	// errors to detect permanently-stuck units.
	const engineFailureCount = new Map<string, number>();

	// ── Adaptive concurrency state ────────────────────────────────────────────
	// Rolling window of recent outcomes (true = error, false = success/skip)
	const recentOutcomes: boolean[] = [];
	let effectiveConcurrency = maxConcurrency;

	function _updateAdaptiveConcurrency(isError: boolean): void {
		recentOutcomes.push(isError);
		if (recentOutcomes.length > ADAPTIVE_WINDOW) { recentOutcomes.shift(); }
		if (recentOutcomes.length >= ADAPTIVE_WINDOW) {
			const errorRate = recentOutcomes.filter(Boolean).length / recentOutcomes.length;
			if (errorRate >= ADAPTIVE_ERROR_THRESHOLD) {
				const reduced = Math.max(1, Math.floor(effectiveConcurrency / 2));
				if (reduced < effectiveConcurrency) {
					effectiveConcurrency = reduced;
				}
			} else {
				// Recover: allow one extra concurrency slot per clean window
				effectiveConcurrency = Math.min(maxConcurrency, effectiveConcurrency + 1);
			}
		}
	}

	// ── Pool-of-promises dispatch ─────────────────────────────────────────────
	const inFlight     = new Set<Promise<void>>();
	let   dispatchedIdx = 0;

	const dispatchNext = (): void => {
		while (!signal.aborted && inFlight.size < effectiveConcurrency && scheduler.hasNext) {
			const item = scheduler.dequeue();
			if (!item) { break; }

			const { unit } = item;
			const jobIndex  = ++dispatchedIdx;
			const stage     = item.nextStage === 'policy' ? null : (item.nextStage === 'escalate' ? null : item.nextStage);

			onProgress({
				type: 'unit-started',
				data: { unitId: unit.id, unitName: unit.name, stage, index: jobIndex, total: totalUnits },
			});

			const attemptIndex = engineFailureCount.get(unit.id) ?? 0;

			const job: Promise<void> = runAutonomyLoop(
				unit.id,
				attemptIndex,
				options,
				loopDeps,
				signal,
				onEscalated,
			).then(result => {
				const isEngineError = result.outcome === 'error';
				_updateAdaptiveConcurrency(isEngineError);

				// Permanent block if this unit keeps erroring at the engine level
				if (isEngineError) {
					const prev = engineFailureCount.get(unit.id) ?? 0;
					const next = prev + 1;
					engineFailureCount.set(unit.id, next);

					if (next >= MAX_PERMANENT_BLOCK_FAILURES) {
						kb.setUnitStatus(
							unit.id, 'blocked',
							`Autonomy engine: permanently blocked after ${next} consecutive engine errors. Last: ${result.errorMsg ?? ''}`,
							LOCK_OWNER,
						);
					}
				} else if (result.outcome !== 'skipped') {
					// Reset engine failure counter on any non-error, non-skip outcome
					engineFailureCount.delete(unit.id);
				}

				collector.record(result);

				onProgress({
					type: 'unit-completed',
					data: { result, index: jobIndex, total: totalUnits, metrics: collector.snapshot() },
				});
			}).catch((err: unknown) => {
				// runAutonomyLoop should never reject, but guard anyway
				const errMsg     = err instanceof Error ? err.message : String(err);
				const prev       = engineFailureCount.get(unit.id) ?? 0;
				const next       = prev + 1;
				engineFailureCount.set(unit.id, next);
				_updateAdaptiveConcurrency(true);

				const syntheticResult = {
					unitId: unit.id, unitName: unit.name,
					stageCompleted: null as null,
					outcome: 'error' as const,
					durationMs: 0, attemptIndex,
					errorMsg: `Unexpected engine exception: ${errMsg}`,
					errorCategory: 'unknown' as const,
				};

				if (next >= MAX_PERMANENT_BLOCK_FAILURES) {
					kb.setUnitStatus(unit.id, 'blocked',
						`Autonomy engine permanently blocked: ${errMsg}`, LOCK_OWNER);
				}

				collector.record(syntheticResult);
				onProgress({
					type: 'unit-completed',
					data: { result: syntheticResult, index: jobIndex, total: totalUnits, metrics: collector.snapshot() },
				});
			}).finally(() => {
				inFlight.delete(job);
				if (!signal.aborted) { dispatchNext(); }
			});

			inFlight.add(job);
		}
	};

	// ── Kick off initial pool ─────────────────────────────────────────────────
	dispatchNext();

	// ── Wait for pool to drain ────────────────────────────────────────────────
	while (inFlight.size > 0) {
		await Promise.race(inFlight);
	}

	// ── Cleanup zombie locks ──────────────────────────────────────────────────
	kb.releaseAllLocksFor(LOCK_OWNER);

	const finalMetrics = collector.finalize(signal.aborted);
	onProgress({ type: 'batch-completed', data: { metrics: finalMetrics, wasAborted: signal.aborted } });
	return finalMetrics;
}
