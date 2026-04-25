/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # SourceResolutionServiceImpl
 *
 * Full implementation of the Source Resolution Service (Phase 1 of the Neural Inverse
 * Modernisation Engine).
 *
 * ## Orchestration Flow
 *
 * 1. `batchResolve()` is called (typically after Discovery completes)
 * 2. All 'pending' units in the active KB are collected
 * 3. Each unit's dependency count is computed from the KB dependency graph
 *    so the scheduler can determine which units are leaf nodes
 * 4. Units are enqueued into the `ResolutionScheduler` in priority order
 * 5. The main polling loop (`_runBatchLoop`) drains the queue up to `maxConcurrency`
 *    concurrent resolutions
 * 6. Each resolution is handed to `routeResolution()` (the language dispatch function)
 * 7. On success: `kb.resolveUnitSource(unitId, resolvedSource)` is called,
 *    transitioning the unit to 'ready' status
 * 8. All results are fed into `ResolutionMetricsCollector`
 * 9. When the queue is empty, a `IBatchResolutionSummary` is built and returned
 *
 * ## File Content Caching
 *
 * Two caches are shared across ALL units in a batch:
 *
 * - `ResolutionFileCache`: Maps file URI \u2192 file content string.
 *   When CUSTMAST.cpy is referenced by 60 programs, we read it once and serve
 *   from cache for all 59 subsequent lookups.
 *
 * - `DependencyNameResolutionCache`: Maps dependency name \u2192 resolved file URI.
 *   Avoids rescanning directories to find the same copybook multiple times.
 *   Also stores negative results (null) \u2014 "CUSTMAST was looked for and not found".
 *
 * Both caches are scoped to the batch. They are reset between batch runs to prevent
 * stale data from a previous project configuration.
 *
 * ## Error Isolation
 *
 * Each unit's resolution is wrapped in a try/catch. An error on one unit
 * (corrupt source, unsupported encoding, language parser bug) does not abort the batch.
 * The unit is marked as `outcome: 'error'` and the batch continues.
 *
 * ## Search Path Construction
 *
 * For each unit, search paths are built from:
 * 1. The unit's source file directory (always first \u2014 most local)
 * 2. All unique directories found in the KB for the same project
 *    (units from the same project share search paths via the project root)
 * 3. Common "copy library" subdirectory conventions (handled inside each inliner)
 *
 * ## Progress Events
 *
 * `onDidResolveUnit` fires immediately when each unit finishes.
 * `onDidBatchProgress` fires on a debounced schedule: every 5 units OR every 2s.
 * `onDidCompleteBatch` fires once when the batch finishes.
 *
 * ## Cancellation
 *
 * `cancelBatch()` sets a flag and calls `_scheduler.cancel()`.
 * In-flight resolutions are awaited to completion; the loop exits after them.
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IKnowledgeBaseService } from '../../knowledgeBase/service.js';
import {
	ISourceResolutionService,
	IResolutionUnitCompleteEvent,
	IResolutionBatchProgressEvent,
	IResolutionBatchCompleteEvent,
} from './service.js';
import {
	IUnitResolutionResult,
	IBatchResolutionSummary,
	IResolutionOptions,
	IResolutionRequest,
} from './impl/resolutionTypes.js';
import { ResolutionFileCache, DependencyNameResolutionCache } from './impl/resolutionCache.js';
import { ResolutionScheduler } from './impl/resolutionScheduler.js';
import { ResolutionMetricsCollector, IResolutionMetricsSnapshot } from './impl/resolutionMetrics.js';
import { routeResolution } from './resolutionRouter.js';


// \u2500\u2500\u2500 Default Resolution Options \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const DEFAULT_OPTIONS: Required<IResolutionOptions> = {
	maxExpansionDepth:       20,
	maxConcurrency:          6,
	insertExpansionMarkers:  true,
	insertResolutionHeader:  true,
	maxInlineSize:           50_000,
	additionalExtensions:    [],
	riskLevels:              ['low', 'medium', 'high', 'critical'],
	skipAlreadyResolved:     true,
};


// \u2500\u2500\u2500 Progress Emit Thresholds \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** Emit batch progress after every N completed units */
const PROGRESS_EMIT_UNIT_INTERVAL = 5;
/** Emit batch progress at least every N milliseconds, even if fewer units completed */
const PROGRESS_EMIT_TIME_INTERVAL_MS = 2_000;
/** Polling interval for the batch loop when at max concurrency */
const BATCH_POLL_INTERVAL_MS = 100;


// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class SourceResolutionServiceImpl extends Disposable implements ISourceResolutionService {
	readonly _serviceBrand: undefined;

	// \u2500\u2500 Events \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	private readonly _onDidResolveUnit       = this._register(new Emitter<IResolutionUnitCompleteEvent>());
	readonly onDidResolveUnit: Event<IResolutionUnitCompleteEvent> = this._onDidResolveUnit.event;

	private readonly _onDidBatchProgress     = this._register(new Emitter<IResolutionBatchProgressEvent>());
	readonly onDidBatchProgress: Event<IResolutionBatchProgressEvent> = this._onDidBatchProgress.event;

	private readonly _onDidCompleteBatch     = this._register(new Emitter<IResolutionBatchCompleteEvent>());
	readonly onDidCompleteBatch: Event<IResolutionBatchCompleteEvent> = this._onDidCompleteBatch.event;

	// \u2500\u2500 Internal State \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	private readonly _metrics      = new ResolutionMetricsCollector();
	private _isBatchRunning        = false;
	private _activeBatchPromise?   : Promise<IBatchResolutionSummary>;
	/** The scheduler for the currently running batch (null when idle) */
	private _activeScheduler?      : ResolutionScheduler;

	// Shared across all units in a batch run \u2014 cleared between runs
	private _fileCache  = new ResolutionFileCache();
	private _nameCache  = new DependencyNameResolutionCache();

	// Progress tracking for debounced progress events
	private _lastProgressEmitMs    = 0;
	private _completedSinceLastEmit = 0;
	private _batchTotal            = 0;
	private _batchCompleted        = 0;

	constructor(
		@IKnowledgeBaseService private readonly _kb: IKnowledgeBaseService,
		@IFileService           private readonly _fileService: IFileService,
	) {
		super();
	}


	// \u2500\u2500 Status \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	get isBatchRunning(): boolean {
		return this._isBatchRunning;
	}

	get queuedCount(): number {
		return this._activeScheduler?.queueLength ?? 0;
	}

	get inFlightCount(): number {
		return this._activeScheduler?.inFlight ?? 0;
	}


	// \u2500\u2500 Single Unit \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	async resolveUnit(unitId: string, options?: Partial<IResolutionOptions>): Promise<IUnitResolutionResult> {
		const unit = this._kb.getUnit(unitId);
		if (!unit) {
			throw new Error(`[SourceResolutionService] Unit '${unitId}' not found in active KB session`);
		}

		const opts = { ...DEFAULT_OPTIONS, ...options };

		if (opts.skipAlreadyResolved && unit.resolvedSource && unit.resolvedSource.length > 0) {
			// Already resolved \u2014 return a mock result without doing any work
			return {
				unitId,
				unitName: unit.name,
				language: unit.sourceLang,
				outcome: 'resolved',
				resolvedSource: unit.resolvedSource,
				totalRefs: 0,
				resolvedRefs: 0,
				unresolvedRefs: 0,
				resolvedDeps: [],
				unresolvedDeps: [],
				cycleUnitIds: [],
				durationMs: 0,
			};
		}

		const request = this._buildRequest(unit, opts);
		const result  = await routeResolution(
			request,
			this._kb,
			this._fileService,
			this._fileCache,
			this._nameCache,
			{
				maxExpansionDepth:      opts.maxExpansionDepth,
				maxInlineSize:          opts.maxInlineSize,
				insertExpansionMarkers: opts.insertExpansionMarkers,
				insertResolutionHeader: opts.insertResolutionHeader,
			},
		);

		// Write resolved source back to KB if resolution produced something useful
		if (result.outcome === 'resolved' || result.outcome === 'partial') {
			this._kb.resolveUnitSource(unitId, result.resolvedSource);
		}

		this._onDidResolveUnit.fire({
			unitId,
			unitName: unit.name,
			language: unit.sourceLang,
			outcome: result.outcome,
			resolvedRefs: result.resolvedRefs,
			unresolvedRefs: result.unresolvedRefs,
			durationMs: result.durationMs,
		});

		return result;
	}


	// \u2500\u2500 Batch Resolve \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	async batchResolve(options?: Partial<IResolutionOptions>): Promise<IBatchResolutionSummary> {
		// Prevent concurrent batch runs
		if (this._isBatchRunning && this._activeBatchPromise) {
			return this._activeBatchPromise;
		}

		const opts = { ...DEFAULT_OPTIONS, ...options };

		this._activeBatchPromise = this._runBatch(opts);
		return this._activeBatchPromise;
	}

	cancelBatch(): void {
		this._activeScheduler?.cancel();
	}


	// \u2500\u2500 Metrics \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	getMetrics(): IResolutionMetricsSnapshot {
		return this._metrics.snapshot();
	}

	resetMetrics(): void {
		this._metrics.reset();
	}


	// \u2500\u2500 Core Batch Runner \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _runBatch(opts: Required<IResolutionOptions>): Promise<IBatchResolutionSummary> {
		const batchStart = Date.now();
		this._isBatchRunning = true;

		// Reset shared state for this batch
		this._fileCache  = new ResolutionFileCache();
		this._nameCache  = new DependencyNameResolutionCache();
		this._metrics.reset();
		this._lastProgressEmitMs     = batchStart;
		this._completedSinceLastEmit = 0;
		this._batchCompleted         = 0;

		// Create a fresh scheduler for this batch run
		const scheduler = new ResolutionScheduler(opts.maxConcurrency);
		this._activeScheduler = scheduler;

		try {
			// \u2500\u2500 Build Job Queue \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			const pendingUnits = this._collectPendingUnits(opts);

			if (pendingUnits.length === 0) {
				return this._buildSummary(batchStart, 0, 0, 0, 0, 0, 0, false);
			}

			this._batchTotal = pendingUnits.length;

			// Enqueue all units into the scheduler (leaf nodes first via sorting)
			for (const entry of pendingUnits) {
				scheduler.enqueue(entry.request, entry.unresolvedDepCount);
			}

			// \u2500\u2500 Batch Polling Loop \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			const results: IUnitResolutionResult[] = [];

			await this._runBatchLoop(scheduler, opts, results);

			// Build final summary
			const summary = this._buildSummaryFromResults(results, batchStart, scheduler.cancelled);

			this._onDidCompleteBatch.fire({ summary });
			return summary;

		} finally {
			this._isBatchRunning     = false;
			this._activeBatchPromise = undefined;
			this._activeScheduler    = undefined;
		}
	}

	/**
	 * Main poll loop. Starts new resolution tasks up to maxConcurrency,
	 * then polls until slots free up to start more.
	 *
	 * Uses a settled-set approach: each job removes itself from `inFlight` when it
	 * completes, so the loop can accurately track concurrency.
	 */
	private async _runBatchLoop(
		scheduler: ResolutionScheduler,
		opts: Required<IResolutionOptions>,
		results: IUnitResolutionResult[],
	): Promise<void> {
		const inFlight = new Set<Promise<void>>();

		while (scheduler.hasWork || inFlight.size > 0) {
			// Drain queue: start as many jobs as the scheduler allows
			let request: IResolutionRequest | undefined;
			while ((request = scheduler.next()) !== undefined) {
				const req = request; // capture for closure

				let jobPromise!: Promise<void>;
				jobPromise = this._resolveUnitJob(req, scheduler, opts, results).finally(() => {
					inFlight.delete(jobPromise);
				});
				inFlight.add(jobPromise);
			}

			if (inFlight.size === 0) {
				// Queue drained and nothing in flight \u2014 we're done
				break;
			}

			// Wait for at least one job to finish before trying to start more
			await Promise.race([...inFlight]);

			// Brief yield to let any microtasks (promise resolutions) settle
			await delay(BATCH_POLL_INTERVAL_MS);
		}
	}

	/**
	 * Resolve one unit as a self-contained async job.
	 * Releases the scheduler slot, records result, emits event.
	 */
	private async _resolveUnitJob(
		request: IResolutionRequest,
		scheduler: ResolutionScheduler,
		opts: Required<IResolutionOptions>,
		results: IUnitResolutionResult[],
	): Promise<void> {
		try {
			const result = await routeResolution(
				request,
				this._kb,
				this._fileService,
				this._fileCache,
				this._nameCache,
				{
					maxExpansionDepth:      opts.maxExpansionDepth,
					maxInlineSize:          opts.maxInlineSize,
					insertExpansionMarkers: opts.insertExpansionMarkers,
					insertResolutionHeader: opts.insertResolutionHeader,
				},
			);

			// Write resolved source to KB for usable outcomes
			if (result.outcome === 'resolved' || result.outcome === 'partial') {
				this._kb.resolveUnitSource(request.unitId, result.resolvedSource);
			}

			results.push(result);
			this._metrics.record(result);

			// Emit per-unit event
			this._onDidResolveUnit.fire({
				unitId:        request.unitId,
				unitName:      request.unitName,
				language:      request.language,
				outcome:       result.outcome,
				resolvedRefs:  result.resolvedRefs,
				unresolvedRefs: result.unresolvedRefs,
				durationMs:    result.durationMs,
			});

		} catch (err) {
			// Isolated failure \u2014 record error result without crashing the batch
			const errorResult: IUnitResolutionResult = {
				unitId:        request.unitId,
				unitName:      request.unitName,
				language:      request.language,
				outcome:       'error',
				resolvedSource: request.sourceText,
				totalRefs:     0,
				resolvedRefs:  0,
				unresolvedRefs: 0,
				resolvedDeps:  [],
				unresolvedDeps: [],
				cycleUnitIds:  [],
				durationMs:    0,
			};
			results.push(errorResult);
			this._metrics.record(errorResult);

			this._onDidResolveUnit.fire({
				unitId:        request.unitId,
				unitName:      request.unitName,
				language:      request.language,
				outcome:       'error',
				resolvedRefs:  0,
				unresolvedRefs: 0,
				durationMs:    0,
			});

		} finally {
			scheduler.complete();
			this._batchCompleted++;
			this._completedSinceLastEmit++;

			// Debounced progress emit
			const now = Date.now();
			if (
				this._completedSinceLastEmit >= PROGRESS_EMIT_UNIT_INTERVAL ||
				now - this._lastProgressEmitMs >= PROGRESS_EMIT_TIME_INTERVAL_MS
			) {
				this._emitBatchProgress(scheduler);
				this._completedSinceLastEmit = 0;
				this._lastProgressEmitMs = now;
			}
		}
	}


	// \u2500\u2500 Job Queue Builder \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Collect all units that need resolution and build their request objects.
	 *
	 * Returns entries sorted by leaf-first order (units with no pending outbound
	 * dependencies are at the front). The scheduler re-sorts internally, but
	 * pre-sorting ensures deterministic ordering for equal-priority units.
	 */
	private _collectPendingUnits(
		opts: Required<IResolutionOptions>,
	): Array<{ request: IResolutionRequest; unresolvedDepCount: number }> {

		if (!this._kb.isActive) {
			return [];
		}

		// Gather units that need resolution
		const candidates = this._kb.getAllUnits().filter(unit => {
			// Skip units already resolved (unless skipAlreadyResolved is false)
			if (opts.skipAlreadyResolved && unit.resolvedSource && unit.resolvedSource.length > 0) {
				return false;
			}

			// Filter by status \u2014 only 'pending' units need resolution
			if (unit.status !== 'pending') {
				return false;
			}

			// Filter by risk level if requested
			if (opts.riskLevels && opts.riskLevels.length > 0 && !opts.riskLevels.includes(unit.riskLevel)) {
				return false;
			}

			return true;
		});

		if (candidates.length === 0) {
			return [];
		}

		// Build search paths: collect all unique source-file directories in the KB
		const allSourceDirs = this._collectAllSourceDirs();

		// Build one entry per candidate
		return candidates.map(unit => {
			// Count how many of this unit's direct dependencies are also pending
			// (i.e., not yet resolved). Lower = closer to leaf node.
			const unresolvedDepCount = unit.dependsOn.filter(depId => {
				const dep = this._kb.getUnit(depId);
				return dep && (!dep.resolvedSource || dep.resolvedSource.length === 0);
			}).length;

			const request: IResolutionRequest = this._buildRequest(
				unit,
				opts,
				allSourceDirs,
			);

			return { request, unresolvedDepCount };
		});
	}

	/**
	 * Collect all unique source-file parent directories from the KB.
	 * These become the search paths passed to each inliner.
	 */
	private _collectAllSourceDirs(): string[] {
		const dirs = new Set<string>();
		for (const unit of this._kb.getAllUnits()) {
			if (unit.sourceFile) {
				const dir = getParentDir(unit.sourceFile);
				if (dir) {
					dirs.add(dir);
				}
			}
		}
		return [...dirs];
	}

	/**
	 * Build an `IResolutionRequest` for a single KB unit.
	 */
	private _buildRequest(
		unit: { id: string; name: string; sourceLang: string; sourceText: string; sourceFile: string; riskLevel: string; usedBy: string[] },
		opts: Required<IResolutionOptions>,
		allSourceDirs?: string[],
	): IResolutionRequest {
		const sourceFileUri = unit.sourceFile;
		const sourceDir     = getParentDir(sourceFileUri);

		// Best-effort project root: go up from source file directory until we find a
		// well-known project-root indicator. Fall back to source dir if not found.
		const projectRootUri = inferProjectRoot(sourceFileUri);

		// Search paths: source dir first, then project-wide dirs
		const searchPaths: string[] = [sourceDir];
		if (allSourceDirs) {
			for (const dir of allSourceDirs) {
				if (dir !== sourceDir) {
					searchPaths.push(dir);
				}
			}
		}

		void opts.additionalExtensions; // additionalExtensions handled inside individual inliners

		return {
			unitId:         unit.id,
			unitName:       unit.name,
			language:       unit.sourceLang,
			sourceText:     unit.sourceText,
			sourceFileUri,
			projectRootUri,
			searchPaths,
			riskLevel:      unit.riskLevel as IResolutionRequest['riskLevel'],
			dependentCount: unit.usedBy.length,
		};
	}


	// \u2500\u2500 Progress Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _emitBatchProgress(scheduler: ResolutionScheduler): void {
		const total     = this._batchTotal;
		const completed = this._batchCompleted;
		const inFlight  = scheduler.inFlight;

		const snapshot = this._metrics.snapshot();
		const percentComplete = total > 0 ? Math.round((completed / total) * 100) : 0;

		this._onDidBatchProgress.fire({
			completed,
			total,
			inFlight,
			percentComplete,
			resolutionRate: snapshot.overallResolutionRate,
		});
	}


	// \u2500\u2500 Summary Builder \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _buildSummaryFromResults(
		results: IUnitResolutionResult[],
		startMs: number,
		cancelled: boolean,
	): IBatchResolutionSummary {
		const fullyResolved      = results.filter(r => r.outcome === 'resolved').length;
		const partiallyResolved  = results.filter(r => r.outcome === 'partial').length;
		const unresolvable       = results.filter(r => r.outcome === 'unresolvable').length;
		const cyclesDetected     = results.filter(r => r.outcome === 'cycle').length;
		const failed             = results.filter(r => r.outcome === 'error').length;
		const totalProcessed     = results.length;

		const totalDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0);
		const avgDurationMs   = totalProcessed > 0 ? Math.round(totalDurationMs / totalProcessed) : 0;

		const completedAt = Date.now();

		return {
			totalUnits:       this._batchTotal,
			fullyResolved,
			partiallyResolved,
			unresolvable,
			cyclesDetected,
			failed,
			skipped:          this._batchTotal - totalProcessed,
			avgDurationMs,
			durationMs:       completedAt - startMs,
			startedAt:        startMs,
			completedAt,
			cancelled,
		};
	}

	private _buildSummary(
		startMs: number,
		total: number,
		resolved: number,
		partial: number,
		unresolvable: number,
		cycles: number,
		failed: number,
		cancelled: boolean,
	): IBatchResolutionSummary {
		const completedAt = Date.now();
		return {
			totalUnits:       total,
			fullyResolved:    resolved,
			partiallyResolved: partial,
			unresolvable,
			cyclesDetected:   cycles,
			failed,
			skipped:          0,
			avgDurationMs:    0,
			durationMs:       completedAt - startMs,
			startedAt:        startMs,
			completedAt,
			cancelled,
		};
	}
}


// \u2500\u2500\u2500 Utilities \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function getParentDir(uri: string): string {
	const normalised = uri.replace(/\\/g, '/');
	const lastSlash  = normalised.lastIndexOf('/');
	return lastSlash > 0 ? normalised.slice(0, lastSlash) : normalised;
}

/**
 * Attempt to infer the project root by climbing the directory tree from the
 * source file looking for well-known root indicators.
 *
 * Indicators checked (in priority order):
 *   - package.json, pom.xml, build.gradle, Cargo.toml, go.mod (build system)
 *   - .git, .svn (VCS root)
 *   - COBOL: COPYLIB/, CBL/, SRC/ directories imply their parent is the project root
 *
 * Falls back to the immediate source file directory if nothing is found within
 * 5 levels of the tree (sync/heuristic \u2014 no async I/O performed here).
 */
function inferProjectRoot(sourceFileUri: string): string {
	// Walk up at most 5 levels looking for tell-tale project root markers
	// in the path string itself (no file I/O at this stage).
	const normalised = sourceFileUri.replace(/\\/g, '/');

	// Common patterns in the path that indicate we're inside a well-known structure
	// e.g., '.../projects/MyApp/src/cobol/programs/CUST001.cbl'
	//        \u2192 project root is likely '.../projects/MyApp'
	const ROOT_SEGMENTS = ['src', 'source', 'cobol', 'cbl', 'rpg', 'java', 'kotlin', 'python'];

	const parts = normalised.split('/');
	for (let i = parts.length - 1; i >= Math.max(1, parts.length - 5); i--) {
		const segment = parts[i].toLowerCase();
		if (ROOT_SEGMENTS.includes(segment)) {
			// The project root is one level ABOVE this segment
			return parts.slice(0, i).join('/');
		}
	}

	// Default: use the source file's immediate parent directory
	return getParentDir(sourceFileUri);
}

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
