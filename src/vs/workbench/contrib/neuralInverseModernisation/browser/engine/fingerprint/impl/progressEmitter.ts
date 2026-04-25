/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Fingerprint Progress Emitter
 *
 * Provides structured event emission for batch fingerprint operations.
 * Consumers (UI, NeuralInverseChecks GRC engine) subscribe to these events
 * to show progress, update compliance status, and trigger dependent evaluations.
 *
 * ## Event Types
 *
 * - `onDidFingerprintUnit`: Fires each time a single unit is fingerprinted (success or fail).
 *   Carries enough context to update the UI without a full KB reload.
 *
 * - `onDidCompleteBatch`: Fires when the entire batch finishes or is cancelled.
 *   Carries aggregate statistics.
 *
 * - `onDidBatchProgress`: Fires periodically with cumulative progress.
 *   Safe to use for a progress bar (fires at most once per completed unit).
 */

import { Emitter, Event } from '../../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { RiskLevel } from '../../../../common/knowledgeBaseTypes.js';


// \u2500\u2500\u2500 Event Payloads \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Fired when a single unit's fingerprinting completes (whether success or failure).
 */
export interface IFingerprintUnitEvent {
	unitId: string;
	unitName: string;
	/** The language of the unit that was fingerprinted */
	language: string;
	/** Risk level of the unit \u2014 determines priority in the scheduler */
	riskLevel: RiskLevel;
	/** Whether the full two-layer extraction (including LLM) completed */
	llmExtractionComplete: boolean;
	/** Whether this was a Layer 1 only result (LLM call failed or was skipped) */
	layer1Only: boolean;
	/** Number of regulated fields found */
	regulatedFieldCount: number;
	/** Number of semantic rules extracted */
	semanticRuleCount: number;
	/** Compliance domains assigned */
	complianceDomains: string[];
	/** Whether the extraction succeeded at all */
	success: boolean;
	/** Error message if success === false */
	errorMessage?: string;
	/** Whether this was a re-extraction (schema version bump triggered it) */
	isSchemaRefresh: boolean;
	/** Unix timestamp of when this unit's extraction completed */
	completedAt: number;
}

/**
 * Periodic progress event during batch fingerprinting.
 */
export interface IFingerprintBatchProgressEvent {
	/** Number of units completed so far (success + failure) */
	completed: number;
	/** Total units in the batch */
	total: number;
	/** Number of units currently being processed (in-flight LLM calls) */
	inFlight: number;
	/** Number that succeeded with full Layer 1 + Layer 2 */
	succeeded: number;
	/** Number that resulted in Layer 1 only (LLM failed) */
	layer1Only: number;
	/** Number that failed entirely */
	failed: number;
	/** Estimated completion percentage 0\u2013100 */
	progressPercent: number;
	/** The unit currently being processed (for UI status messages) */
	currentUnitId?: string;
	/** Unix timestamp of this progress snapshot */
	snapshotAt: number;
}

/**
 * Fired when an entire batch job finishes or is cancelled.
 */
export interface IFingerprintBatchCompleteEvent {
	/** Whether the batch was cancelled before completion */
	cancelled: boolean;
	/** Total units that were in the batch */
	totalUnits: number;
	/** Units successfully fingerprinted with full Layer 1 + Layer 2 */
	succeeded: number;
	/** Units fingerprinted with Layer 1 only (LLM failed) */
	layer1Only: number;
	/** Units that failed entirely */
	failed: number;
	/** Units skipped (e.g. already fingerprinted with current schema version) */
	skipped: number;
	/** How long the batch took in milliseconds */
	durationMs: number;
	/** Unix timestamp when the batch started */
	startedAt: number;
	/** Unix timestamp when the batch completed */
	completedAt: number;
}


// \u2500\u2500\u2500 Emitter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * FingerprintProgressEmitter \u2014 manages event emission for batch fingerprint jobs.
 *
 * One emitter instance is created per batch job and passed to the
 * BatchFingerprintEngine. The FingerprintServiceImpl exposes the events
 * as public readonly properties.
 */
export class FingerprintProgressEmitter extends Disposable {

	// \u2500\u2500 Unit completed \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	private readonly _onDidFingerprintUnit = this._register(new Emitter<IFingerprintUnitEvent>());
	readonly onDidFingerprintUnit: Event<IFingerprintUnitEvent> = this._onDidFingerprintUnit.event;

	// \u2500\u2500 Periodic progress \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	private readonly _onDidBatchProgress = this._register(new Emitter<IFingerprintBatchProgressEvent>());
	readonly onDidBatchProgress: Event<IFingerprintBatchProgressEvent> = this._onDidBatchProgress.event;

	// \u2500\u2500 Batch complete \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	private readonly _onDidCompleteBatch = this._register(new Emitter<IFingerprintBatchCompleteEvent>());
	readonly onDidCompleteBatch: Event<IFingerprintBatchCompleteEvent> = this._onDidCompleteBatch.event;

	// \u2500\u2500 Counters for in-flight tracking \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	private _inFlight = 0;
	private _completed = 0;
	private _succeeded = 0;
	private _layer1Only = 0;
	private _failed = 0;
	private _total = 0;
	private _startedAt = 0;

	/**
	 * Call once before starting a batch to reset counters and record start time.
	 */
	beginBatch(total: number): void {
		this._total = total;
		this._completed = 0;
		this._succeeded = 0;
		this._layer1Only = 0;
		this._failed = 0;
		this._inFlight = 0;
		this._startedAt = Date.now();
	}

	/**
	 * Call when a unit enters extraction (LLM call starts).
	 */
	unitStarted(unitId: string): void {
		this._inFlight++;
		this._emitProgress(unitId);
	}

	/**
	 * Call when a unit's extraction completes.
	 */
	unitCompleted(event: IFingerprintUnitEvent): void {
		this._inFlight = Math.max(0, this._inFlight - 1);
		this._completed++;

		if (event.success && event.llmExtractionComplete) {
			this._succeeded++;
		} else if (event.success && event.layer1Only) {
			this._layer1Only++;
		} else {
			this._failed++;
		}

		this._onDidFingerprintUnit.fire(event);
		this._emitProgress(undefined);
	}

	/**
	 * Call when the batch finishes (naturally or via cancellation).
	 */
	batchCompleted(skipped: number, cancelled: boolean): void {
		const completedAt = Date.now();
		this._onDidCompleteBatch.fire({
			cancelled,
			totalUnits: this._total,
			succeeded: this._succeeded,
			layer1Only: this._layer1Only,
			failed: this._failed,
			skipped,
			durationMs: completedAt - this._startedAt,
			startedAt: this._startedAt,
			completedAt,
		});
	}

	private _emitProgress(currentUnitId: string | undefined): void {
		const progressPercent = this._total > 0
			? Math.round((this._completed / this._total) * 100)
			: 0;

		this._onDidBatchProgress.fire({
			completed: this._completed,
			total: this._total,
			inFlight: this._inFlight,
			succeeded: this._succeeded,
			layer1Only: this._layer1Only,
			failed: this._failed,
			progressPercent,
			currentUnitId,
			snapshotAt: Date.now(),
		});
	}
}
