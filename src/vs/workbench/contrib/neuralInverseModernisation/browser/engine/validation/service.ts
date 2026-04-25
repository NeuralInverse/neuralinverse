/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Validation Engine Service
 *
 * The DI-registered façade for Phase 10 of the Neural Inverse Modernisation pipeline.
 * Exposes a high-level API for validating translated knowledge units via equivalence testing.
 *
 * ## Lifecycle
 *
 * 1. One `IValidationEngineService` instance is registered per workspace.
 * 2. Callers invoke `validateBatch()` to run full equivalence testing across all approved units,
 *    or `validateUnit()` to validate a single unit on demand.
 * 3. The service emits real-time progress events via `onProgress`.
 * 4. Only one batch can be active at a time \u2014 `BatchAlreadyRunningError` is thrown if violated.
 * 5. Call `cancelBatch()` to abort cleanly.
 *
 * ## DI Token
 *
 * ```typescript
 * import { IValidationEngineService } from '.../validation/service.js';
 * constructor(@IValidationEngineService private readonly _val: IValidationEngineService) {}
 * ```
 *
 * ## Typical usage
 *
 * ```typescript
 * // Run batch validation on all approved units
 * const metrics = await this._val.validateBatch({ eligibleStatuses: ['approved'] });
 *
 * // Validate a single unit (bypasses scheduler)
 * const result = await this._val.validateUnit('unit-abc-123', { includeLLMAnalysis: true });
 *
 * // Preview schedule without running
 * const schedule = this._val.previewSchedule({ eligibleStatuses: ['approved'] });
 * ```
 */

import { Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import {
	IValidationOptions,
	IValidationResult,
	IValidationBatchMetrics,
	IValidationBatchProgress,
	IBatchValidationOptions,
} from './impl/validationTypes.js';
import { IValidationScheduleEntry } from './impl/validationScheduler.js';


// \u2500\u2500\u2500 DI token \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const IValidationEngineService = createDecorator<IValidationEngineService>('validationEngineService');


// \u2500\u2500\u2500 Service interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IValidationEngineService {
	readonly _serviceBrand: undefined;

	// \u2500\u2500 State \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** True while a batch is actively running */
	readonly isRunning: boolean;

	/** Metrics snapshot from the most recently completed (or still-running) batch */
	readonly lastBatchMetrics: IValidationBatchMetrics | null;

	// \u2500\u2500 Events \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Fires for every unit-started, unit-completed, and batch-completed event */
	readonly onProgress: Event<IValidationBatchProgress>;

	// \u2500\u2500 Batch API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Validate all eligible units in the KB.
	 *
	 * Eligible means:
	 *   - `unit.status` is in `options.eligibleStatuses` (default: `['approved']`)
	 *
	 * Units are ordered by the `ValidationScheduler` (critical-first, regulated-first).
	 *
	 * @param options  Validation options + optional filesystem paths
	 * @returns        Promise resolving to final batch metrics
	 * @throws         `ValidationBatchAlreadyRunningError` if a batch is already running
	 */
	validateBatch(options?: IBatchValidationOptions): Promise<IValidationBatchMetrics>;

	/**
	 * Validate a single unit by ID.
	 * Bypasses the scheduler \u2014 immediately starts validation.
	 *
	 * @param unitId   KB unit ID
	 * @param options  Validation options
	 * @returns        The completed validation result
	 */
	validateUnit(unitId: string, options?: IValidationOptions): Promise<IValidationResult>;

	/**
	 * Cancel the currently running batch.
	 * In-flight LLM calls are aborted. Units mid-validation are returned to
	 * their previous status for future retry.
	 */
	cancelBatch(): void;

	// \u2500\u2500 Schedule preview \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Preview the validation schedule without executing it.
	 * Returns the ordered list of units that would be validated.
	 */
	previewSchedule(options?: IValidationOptions): IValidationScheduleEntry[];

	// \u2500\u2500 Override API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Record an equivalence override for a failed unit.
	 * Allows a developer to accept a known divergence with documented rationale.
	 * Transitions unit back to 'validated' status.
	 *
	 * @param unitId          KB unit ID
	 * @param approver        Identity of the approver
	 * @param rationale       Documented reason for accepting the divergence
	 * @param changeTicketRef Optional change management ticket (Jira, ServiceNow, etc.)
	 */
	recordOverride(
		unitId:          string,
		approver:        string,
		rationale:       string,
		changeTicketRef?: string,
	): void;
}


// \u2500\u2500\u2500 Error type \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class ValidationBatchAlreadyRunningError extends Error {
	constructor() {
		super('A validation batch is already running. Call cancelBatch() first.');
		this.name = 'ValidationBatchAlreadyRunningError';
	}
}
