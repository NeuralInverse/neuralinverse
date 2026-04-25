/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Translation Engine Service
 *
 * The DI-registered façade for Phase 4 of the Neural Inverse Modernisation pipeline.
 * Exposes a high-level API for translating knowledge units in the KB.
 *
 * ## Lifecycle
 *
 * 1. One `ITranslationEngineService` instance is registered per workspace.
 * 2. Callers (console UI, modernisation agent) call `translateBatch()` or `translateUnit()`.
 * 3. The service builds the translation schedule, runs the batch engine, and
 *    emits real-time progress events the UI can subscribe to.
 * 4. Only one batch can be active at a time. Calling `translateBatch()` while
 *    a batch is running will reject with `BatchAlreadyRunningError`.
 * 5. Call `cancelBatch()` to abort the current run cleanly.
 *
 * ## DI Token
 *
 * ```typescript
 * import { ITranslationEngineService } from '.../translation/service.js';
 * constructor(@ITranslationEngineService private readonly _trans: ITranslationEngineService) {}
 * ```
 */

import { Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ITranslationOptions, ITranslationResult } from './impl/translationTypes.js';
import {
	ITranslationBatchProgress,
	ITranslationBatchMetrics,
	IBatchTranslationOptions,
} from './impl/batchTranslationEngine.js';


// \u2500\u2500\u2500 DI token \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const ITranslationEngineService = createDecorator<ITranslationEngineService>('translationEngineService');


// \u2500\u2500\u2500 Service interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface ITranslationEngineService {
	readonly _serviceBrand: undefined;

	// \u2500\u2500 State \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** True while a batch is actively running */
	readonly isRunning: boolean;

	/** Metrics snapshot from the most recently completed (or still-running) batch */
	readonly lastBatchMetrics: ITranslationBatchMetrics | null;

	// \u2500\u2500 Events \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Fires for every unit-started, unit-completed, and batch-completed event */
	readonly onProgress: Event<ITranslationBatchProgress>;

	// \u2500\u2500 Batch API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Translate all eligible units in the KB.
	 *
	 * Eligible means:
	 *   - `unit.status` is in `options.eligibleStatuses` (default: `['ready']`)
	 *   - `unit.riskLevel` >= `options.minRiskLevel` (default: `'low'`)
	 *   - Not excluded by an active `IExclusionDecision`
	 *
	 * Units are ordered by the `TranslationScheduler` (leaf-first, critical-first).
	 *
	 * @param batchOptions  Combined translation options + filesystem paths
	 * @returns             Promise resolving to final batch metrics
	 * @throws              `BatchAlreadyRunningError` if a batch is already running
	 */
	translateBatch(batchOptions: IBatchTranslationOptions): Promise<ITranslationBatchMetrics>;

	/**
	 * Translate a single unit by ID.
	 * Bypasses the scheduler \u2014 immediately starts translation regardless of status.
	 * Still respects the model selection and token budget from `options`.
	 *
	 * @param unitId    KB unit ID
	 * @param options   Translation options
	 * @param sourceRoot  Source project root (for target file path derivation)
	 * @param targetRoot  Target project root
	 * @returns         The completed translation result
	 */
	translateUnit(
		unitId:     string,
		options:    ITranslationOptions,
		sourceRoot: string,
		targetRoot: string,
	): Promise<ITranslationResult>;

	/**
	 * Cancel the currently running batch.
	 * In-flight LLM calls are aborted. Units mid-translation are returned to
	 * 'ready' status for future retry.
	 * Resolves immediately \u2014 the batch `run()` promise will complete shortly after.
	 */
	cancelBatch(): void;

	// \u2500\u2500 Schedule preview \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Preview the translation schedule without executing it.
	 * Returns a list of unit IDs in the order they would be translated,
	 * grouped by topological depth.
	 *
	 * Useful for the console UI "Plan" view before the user starts translation.
	 */
	previewSchedule(options: ITranslationOptions): ITranslationSchedulePreview;
}


// \u2500\u2500\u2500 Preview type \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface ITranslationSchedulePreviewEntry {
	unitId:       string;
	unitName:     string;
	sourceLang:   string;
	riskLevel:    string;
	depth:        number;
	priorityScore: number;
	dependsOn:    string[];
	usedBy:       string[];
}

export interface ITranslationSchedulePreview {
	totalUnits:   number;
	/** Units grouped by topological depth (key = depth integer as string) */
	depthGroups: Array<{
		depth:    number;
		unitCount: number;
		units:    ITranslationSchedulePreviewEntry[];
	}>;
	/** Risk level counts across all scheduled units */
	byRisk: Record<string, number>;
}


// \u2500\u2500\u2500 Error types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class BatchAlreadyRunningError extends Error {
	constructor() {
		super('A translation batch is already running. Call cancelBatch() first.');
		this.name = 'BatchAlreadyRunningError';
	}
}
