/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # ISourceResolutionService \u2014 Public Interface
 *
 * The Source Resolution Service solves the **COBOL wall problem** \u2014 and its equivalent
 * in every other legacy language \u2014 by expanding all external dependency references
 * inline before the AI ever sees the code.
 *
 * ## The COBOL Wall Problem (and why it matters for every language)
 *
 * When a COBOL program contains `COPY CUSTMAST`, the AI sees only the reference.
 * The 40 field definitions inside CUSTMAST are invisible. The AI cannot reason
 * about data types, business rules, or field meanings because they live in a
 * separate file.
 *
 * The same problem exists in every language:
 * - COBOL: COPY copybook / CALL 'PROGRAM'
 * - PL/SQL: v_balance accounts.balance%TYPE / pkg_billing.calc_late_fee(...)
 * - Java EE: @EJB UserSessionBean userBean
 * - RPG: /COPY QRPGLESRC/CUSTHEADR / CALL 'GLPGM'
 * - NATURAL: USING DA-CUSTOMER / CALLNAT 'VALCUST'
 * - TypeScript: import { AccountService } from './AccountService'
 *
 * ## How Resolution Works
 *
 * For COBOL (and similar flat-file inclusion languages):
 *   The entire text of the copybook is expanded inline, replacing the COPY statement.
 *   The AI sees one unified source with all fields defined.
 *
 * For languages with structured type systems (Java, TypeScript, PL/SQL packages):
 *   Interface context comments are injected \u2014 showing method signatures, purpose,
 *   risk level, and translation status \u2014 without producing invalid code.
 *
 * ## Lifecycle
 *
 * ```
 * Discovery (Phase 0)
 *     \u2514\u2500\u25BA KB unit created with status='pending', sourceText set, resolvedSource=''
 *
 * Resolution (Phase 1) \u2190 This service
 *     \u2514\u2500\u25BA batchResolve() \u2192 resolveUnit() per unit \u2192 kb.resolveUnitSource()
 *         \u2514\u2500\u25BA KB unit.resolvedSource filled, status transitions pending\u2192ready
 *
 * Fingerprinting (Phase 3)
 *     \u2514\u2500\u25BA FingerprintService reads unit.resolvedSource (the expanded source)
 *         \u2514\u2500\u25BA L1 + L2 extraction on the complete, self-contained text
 *
 * Translation (Phase 4)
 *     \u2514\u2500\u25BA Translation agent reads unit.resolvedSource via kb.getResolvedContext()
 * ```
 *
 * ## Usage
 *
 * Resolve all pending units in the active KB session:
 * ```ts
 * const summary = await resolutionService.batchResolve();
 * console.log(`Resolved ${summary.fullyResolved}/${summary.totalUnits} units`);
 * ```
 *
 * Resolve a single unit by ID:
 * ```ts
 * const result = await resolutionService.resolveUnit(unitId);
 * if (result.outcome === 'resolved' || result.outcome === 'partial') {
 *   // resolvedSource is now available in the KB
 * }
 * ```
 */

import { Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IUnitResolutionResult, IBatchResolutionSummary, IResolutionOptions } from './impl/resolutionTypes.js';
import { IResolutionMetricsSnapshot } from './impl/resolutionMetrics.js';


// \u2500\u2500\u2500 DI Decorator \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const ISourceResolutionService = createDecorator<ISourceResolutionService>('sourceResolutionService');


// \u2500\u2500\u2500 Events \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IResolutionUnitCompleteEvent {
	unitId: string;
	unitName: string;
	language: string;
	outcome: IUnitResolutionResult['outcome'];
	resolvedRefs: number;
	unresolvedRefs: number;
	durationMs: number;
}

export interface IResolutionBatchProgressEvent {
	completed: number;
	total: number;
	inFlight: number;
	percentComplete: number;
	/** Running resolution rate across completed units (0\u2013100) */
	resolutionRate: number;
}

export interface IResolutionBatchCompleteEvent {
	summary: IBatchResolutionSummary;
}


// \u2500\u2500\u2500 Service Interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface ISourceResolutionService {
	readonly _serviceBrand: undefined;

	// \u2500\u2500 Events \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Fires when a single unit's resolution completes (success, partial, or failure).
	 * Fires for both individual resolveUnit() calls and units processed in a batch.
	 */
	readonly onDidResolveUnit: Event<IResolutionUnitCompleteEvent>;

	/**
	 * Fires periodically during batch processing with coarse-grained progress.
	 * Rate: fires every 5 completed units OR every 2 seconds, whichever comes first.
	 */
	readonly onDidBatchProgress: Event<IResolutionBatchProgressEvent>;

	/**
	 * Fires when a batch run finishes \u2014 either naturally or after cancel().
	 */
	readonly onDidCompleteBatch: Event<IResolutionBatchCompleteEvent>;

	// \u2500\u2500 Single Unit \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Resolve a single KB unit's dependencies by ID.
	 *
	 * Process:
	 * 1. Reads the unit's `sourceText` from the active KB session
	 * 2. Routes to the correct language inliner via resolutionRouter
	 * 3. On success (resolved or partial): calls `kb.resolveUnitSource(unitId, resolvedSource)`
	 *    which transitions the unit from 'pending' to 'ready'
	 * 4. On failure (unresolvable, cycle, error): logs the result and returns \u2014 the unit
	 *    remains in 'pending' status and can be retried later
	 *
	 * @param unitId  The ID of the KB unit to resolve
	 * @param options Optional per-call overrides (defaults taken from service configuration)
	 *
	 * @throws if the unit is not found in the active KB session
	 * @throws if no KB session is active
	 */
	resolveUnit(unitId: string, options?: Partial<IResolutionOptions>): Promise<IUnitResolutionResult>;

	/**
	 * Resolve all pending (unresolved) units in the active KB session.
	 *
	 * Resolution order (via ResolutionScheduler):
	 * 1. Leaf nodes first \u2014 units with no outbound project dependencies are processed
	 *    first so they populate the file content cache before programs that reference them
	 * 2. Higher risk within the same dependency tier (critical > high > medium > low)
	 * 3. More dependents within the same risk tier (shared libraries resolved before one-offs)
	 *
	 * Concurrency is bounded by `options.maxConcurrency` (default 6). Resolution is I/O-bound
	 * so moderate concurrency is safe and beneficial.
	 *
	 * Monitor progress via `onDidResolveUnit` and `onDidBatchProgress`.
	 * Cancel via `cancelBatch()`.
	 *
	 * @param options Optional batch options \u2014 overrides defaults
	 */
	batchResolve(options?: Partial<IResolutionOptions>): Promise<IBatchResolutionSummary>;

	/**
	 * Cancel an in-progress batch resolve.
	 * Units currently being resolved will finish; no new units will start.
	 * `onDidCompleteBatch` fires with `cancelled: true`.
	 *
	 * No-op if no batch is in progress.
	 */
	cancelBatch(): void;

	// \u2500\u2500 Metrics & Diagnostics \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Get cumulative resolution metrics across all runs since the service started
	 * (or since the last `resetMetrics()` call).
	 *
	 * Includes:
	 * - Per-language resolution rates
	 * - Top missing dependencies (most frequently referenced but not found)
	 * - Average resolution time per unit
	 * - Overall resolution rate
	 */
	getMetrics(): IResolutionMetricsSnapshot;

	/**
	 * Reset the cumulative metrics collector.
	 * Called automatically at the start of a new batch run.
	 */
	resetMetrics(): void;

	// \u2500\u2500 Status \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Whether a batch resolve is currently running.
	 */
	readonly isBatchRunning: boolean;

	/**
	 * Number of units currently waiting in the resolution queue.
	 */
	readonly queuedCount: number;

	/**
	 * Number of units currently being actively resolved (in-flight).
	 */
	readonly inFlightCount: number;
}
