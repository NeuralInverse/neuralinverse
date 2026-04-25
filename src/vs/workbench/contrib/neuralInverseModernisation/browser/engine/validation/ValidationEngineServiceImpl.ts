/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IKnowledgeBaseService } from '../../knowledgeBase/service.js';
import { ILLMMessageService } from '../../../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../../../../void/common/voidSettingsService.js';
import {
	IValidationEngineService,
	ValidationBatchAlreadyRunningError,
} from './service.js';
import {
	IValidationOptions,
	IValidationResult,
	IValidationBatchMetrics,
	IValidationBatchProgress,
	IBatchValidationOptions,
	DEFAULT_VALIDATION_OPTIONS,
} from './impl/validationTypes.js';
import { runBatchValidation } from './impl/batchValidationEngine.js';
import { runValidationLoop } from './impl/validationLoop.js';
import { recordValidationResult, recordEquivalenceOverride } from './impl/validationRecorder.js';
import {
	previewValidationSchedule,
	IValidationScheduleEntry,
} from './impl/validationScheduler.js';


export class ValidationEngineServiceImpl extends Disposable implements IValidationEngineService {
	readonly _serviceBrand: undefined;

	// \u2500\u2500 Events \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private readonly _onProgress = this._register(new Emitter<IValidationBatchProgress>());
	readonly onProgress: Event<IValidationBatchProgress> = this._onProgress.event;

	// \u2500\u2500 State \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _isRunning                              = false;
	private _currentController: AbortController | null = null;
	private _lastBatchMetrics: IValidationBatchMetrics | null = null;

	get isRunning(): boolean { return this._isRunning; }
	get lastBatchMetrics(): IValidationBatchMetrics | null { return this._lastBatchMetrics; }

	constructor(
		@IKnowledgeBaseService  private readonly _kb:       IKnowledgeBaseService,
		@ILLMMessageService     private readonly _llm:      ILLMMessageService,
		@IVoidSettingsService   private readonly _settings: IVoidSettingsService,
	) {
		super();
	}

	// \u2500\u2500 Batch API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	async validateBatch(options: IBatchValidationOptions = {}): Promise<IValidationBatchMetrics> {
		if (this._isRunning) {
			throw new ValidationBatchAlreadyRunningError();
		}

		this._isRunning       = true;
		this._currentController = new AbortController();
		const controller = this._currentController;

		try {
			const metrics = await runBatchValidation(
				options,
				this._kb,
				this._llm,
				this._settings,
				controller,
				(event) => this._onProgress.fire(event),
			);
			this._lastBatchMetrics = metrics;
			return metrics;
		} finally {
			this._isRunning         = false;
			this._currentController = null;
		}
	}

	async validateUnit(unitId: string, options: IValidationOptions = {}): Promise<IValidationResult> {
		const controller = new AbortController();
		const result = await runValidationLoop(
			unitId, options, this._kb, this._llm, this._settings, controller.signal,
		);

		if (result.outcome !== 'skipped') {
			const batchOpts = options as IBatchValidationOptions;
			recordValidationResult(result, this._kb, batchOpts.evidenceOutputDir);
		}

		// Emit a unit-completed progress event for single-unit validation too
		this._onProgress.fire({
			type:     'unit-completed',
			unitId:   result.unitId,
			unitName: result.unitName,
			result,
		});

		return result;
	}

	cancelBatch(): void {
		if (this._currentController) {
			this._currentController.abort();
		}
	}

	// \u2500\u2500 Schedule preview \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	previewSchedule(options: IValidationOptions = {}): IValidationScheduleEntry[] {
		const eligibleStatuses = options.eligibleStatuses ?? DEFAULT_VALIDATION_OPTIONS.eligibleStatuses;
		return previewValidationSchedule(this._kb, eligibleStatuses);
	}

	// \u2500\u2500 Override API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	recordOverride(
		unitId:          string,
		approver:        string,
		rationale:       string,
		changeTicketRef?: string,
	): void {
		recordEquivalenceOverride(unitId, approver, rationale, changeTicketRef, this._kb);
	}
}
