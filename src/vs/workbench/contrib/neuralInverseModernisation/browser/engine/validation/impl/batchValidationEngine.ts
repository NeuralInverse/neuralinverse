/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Batch Validation Engine
 *
 * Orchestrates the concurrent execution of the validation loop across all
 * eligible units, subject to concurrency limits.
 *
 * ## Concurrency model
 *
 * Same pool-of-promises pattern as the Batch Translation Engine:
 *  - Maintains a `Set<Promise<void>>` of in-flight jobs.
 *  - Dequeues units in scheduler priority order (critical-first, regulated-first).
 *  - A new job starts as soon as the pool drops below `maxConcurrency`.
 *
 * ## Status transitions
 *
 * Before dispatching a unit: kb.setUnitStatus(unitId, 'validating').
 * After completion: recordValidationResult() handles all further transitions.
 *
 * ## Permanent blocking on repeated errors
 *
 * If a unit produces an 'error' outcome `MAX_UNIT_ERRORS_BEFORE_BLOCK` times,
 * it is moved to 'blocked' status to prevent infinite retry loops.
 *
 * ## Progress events
 *
 * Three event types emitted via onProgress callback:
 *   - unit-started    \u2014 unit just entered the validation loop
 *   - unit-completed  \u2014 unit produced a result (any outcome)
 *   - batch-completed \u2014 all units processed
 *
 * ## Abort
 *
 * The caller holds the AbortController. Calling controller.abort() causes:
 *   1. In-flight LLM calls to return null (AbortSignal propagation).
 *   2. Dequeue loop to stop scheduling new jobs.
 *   3. In-flight units to complete as 'skipped'.
 *   4. run() promise to resolve after drain.
 */

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { ILLMMessageService } from '../../../../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../../../../../void/common/voidSettingsService.js';
import {
	IValidationOptions,
	IValidationResult,
	IValidationBatchMetrics,
	IValidationBatchProgress,
	DEFAULT_VALIDATION_OPTIONS,
} from './validationTypes.js';
import { ValidationScheduler, buildValidationScheduler } from './validationScheduler.js';
import { runValidationLoop } from './validationLoop.js';
import { recordValidationResult } from './validationRecorder.js';
import { ValidationMetricsCollector } from './validationMetrics.js';


// \u2500\u2500\u2500 Constants \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** After this many consecutive error outcomes, permanently block the unit */
const MAX_UNIT_ERRORS_BEFORE_BLOCK = 2;


// \u2500\u2500\u2500 Batch engine \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class BatchValidationEngine {

	private readonly _onProgress: (event: IValidationBatchProgress) => void;
	private readonly _metrics = new ValidationMetricsCollector();

	/** Tracks consecutive error counts per unit within this batch */
	private readonly _unitErrorCounts = new Map<string, number>();

	constructor(onProgress: (event: IValidationBatchProgress) => void) {
		this._onProgress = onProgress;
	}

	/**
	 * Run the full batch validation.
	 *
	 * @param scheduler  Pre-built ValidationScheduler with units to process
	 * @param options    Validation run options
	 * @param kb         Knowledge Base service
	 * @param llm        LLM message service
	 * @param settings   Void settings service
	 * @param controller AbortController for cancellation
	 * @returns          Final batch metrics
	 */
	async run(
		scheduler:  ValidationScheduler,
		options:    IValidationOptions,
		kb:         IKnowledgeBaseService,
		llm:        ILLMMessageService,
		settings:   IVoidSettingsService,
		controller: AbortController,
	): Promise<IValidationBatchMetrics> {
		const signal       = controller.signal;
		const maxConcurrency = options.maxConcurrency ?? DEFAULT_VALIDATION_OPTIONS.maxConcurrency;
		const total          = scheduler.totalCount;
		const inFlight       = new Set<Promise<void>>();
		let   unitIndex      = 0;

		while (scheduler.hasNext && !signal.aborted) {
			// Wait for a slot to free up
			if (inFlight.size >= maxConcurrency) {
				await Promise.race(inFlight);
			}

			if (signal.aborted) { break; }

			const unit = scheduler.dequeue();
			if (!unit) { break; }

			const currentIndex = ++unitIndex;
			this._onProgress({
				type:     'unit-started',
				unitId:   unit.id,
				unitName: unit.name,
				index:    currentIndex,
				total,
			});

			const job = this._runUnit(unit.id, unit.name, options, kb, llm, settings, signal)
				.then(result => {
					this._metrics.record(result);
					this._onProgress({
						type:     'unit-completed',
						unitId:   result.unitId,
						unitName: result.unitName,
						result,
						index:    currentIndex,
						total,
						metrics:  this._metrics.snapshot(),
					});
					inFlight.delete(job);
				});

			inFlight.add(job);
		}

		// Drain remaining in-flight jobs
		if (inFlight.size > 0) {
			await Promise.allSettled(inFlight);
		}

		const finalMetrics = this._metrics.snapshot();
		this._onProgress({ type: 'batch-completed', metrics: finalMetrics });
		return finalMetrics;
	}


	// \u2500\u2500 Per-unit runner \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _runUnit(
		unitId:   string,
		unitName: string,
		options:  IValidationOptions,
		kb:       IKnowledgeBaseService,
		llm:      ILLMMessageService,
		settings: IVoidSettingsService,
		signal:   AbortSignal,
	): Promise<IValidationResult> {
		const result = await runValidationLoop(unitId, options, kb, llm, settings, signal);

		// Track consecutive error counts
		if (result.outcome === 'error') {
			const prev = this._unitErrorCounts.get(unitId) ?? 0;
			const next = prev + 1;
			this._unitErrorCounts.set(unitId, next);

			if (next >= MAX_UNIT_ERRORS_BEFORE_BLOCK) {
				// Permanently block rather than letting it loop endlessly
				kb.setUnitStatus(unitId, 'blocked',
					`Validation engine failed ${next} consecutive times: ${result.error ?? 'unknown error'}. Permanently blocked to prevent retry loop.`,
					'validation-engine',
				);
				// Don't call recordValidationResult \u2014 status is now 'blocked'
				return result;
			}
		} else {
			// Reset error counter on non-error outcome
			this._unitErrorCounts.delete(unitId);
		}

		// Record the result to KB (sets status, writes equivalence result)
		recordValidationResult(result, kb, options.evidenceOutputDir);

		return result;
	}
}


// \u2500\u2500\u2500 Factory helper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Build the scheduler and immediately run the batch.
 * Convenience function used by ValidationEngineServiceImpl.
 */
export async function runBatchValidation(
	options:    IValidationOptions,
	kb:         IKnowledgeBaseService,
	llm:        ILLMMessageService,
	settings:   IVoidSettingsService,
	controller: AbortController,
	onProgress: (event: IValidationBatchProgress) => void,
): Promise<IValidationBatchMetrics> {
	const eligibleStatuses = options.eligibleStatuses ?? DEFAULT_VALIDATION_OPTIONS.eligibleStatuses;
	const scheduler        = buildValidationScheduler(kb, eligibleStatuses);
	const engine           = new BatchValidationEngine(onProgress);
	return engine.run(scheduler, options, kb, llm, settings, controller);
}
