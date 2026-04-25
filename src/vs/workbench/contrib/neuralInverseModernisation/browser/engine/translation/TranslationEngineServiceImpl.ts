/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IKnowledgeBaseService } from '../../knowledgeBase/service.js';
import { ILLMMessageService } from '../../../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../../../../void/common/voidSettingsService.js';
import { IModernisationSessionService } from '../../modernisationSessionService.js';
import {
	ITranslationEngineService,
	BatchAlreadyRunningError,
	ITranslationSchedulePreview,
	ITranslationSchedulePreviewEntry,
} from './service.js';
import {
	BatchTranslationEngine,
	IBatchTranslationOptions,
	ITranslationBatchProgress,
	ITranslationBatchMetrics,
} from './impl/batchTranslationEngine.js';
import { ITranslationOptions, ITranslationResult } from './impl/translationTypes.js';
import { TranslationScheduler } from './impl/translationScheduler.js';
import { runTranslationLoop } from './impl/translationLoop.js';
import { recordTranslationResult } from './impl/translationRecorder.js';


export class TranslationEngineServiceImpl extends Disposable implements ITranslationEngineService {
	readonly _serviceBrand: undefined;

	// \u2500\u2500 Events \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private readonly _onProgress = this._register(new Emitter<ITranslationBatchProgress>());
	readonly onProgress: Event<ITranslationBatchProgress> = this._onProgress.event;

	// \u2500\u2500 State \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _isRunning                             = false;
	private _currentController: AbortController | null = null;
	private _lastBatchMetrics:  ITranslationBatchMetrics | null = null;

	get isRunning(): boolean { return this._isRunning; }
	get lastBatchMetrics(): ITranslationBatchMetrics | null { return this._lastBatchMetrics; }

	constructor(
		@IKnowledgeBaseService         private readonly _kb:       IKnowledgeBaseService,
		@ILLMMessageService            private readonly _llm:      ILLMMessageService,
		@IVoidSettingsService          private readonly _settings: IVoidSettingsService,
		@IModernisationSessionService  private readonly _session:  IModernisationSessionService,
	) {
		super();
	}

	// \u2500\u2500 Batch API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	async translateBatch(batchOptions: IBatchTranslationOptions): Promise<ITranslationBatchMetrics> {
		if (this._isRunning) {
			throw new BatchAlreadyRunningError();
		}

		this._isRunning = true;
		this._currentController = new AbortController();

		const engine = this._register(new BatchTranslationEngine(this._kb, this._llm, this._settings));

		// Forward all progress events to this service's emitter
		this._register(engine.onProgress(e => this._onProgress.fire(e)));

		// Inject active session migration pattern for sector aiGuidance
		const enrichedOptions: IBatchTranslationOptions = {
			...batchOptions,
			migrationPatternId: batchOptions.migrationPatternId ?? this._session.session?.migrationPattern ?? undefined,
		};

		try {
			const metrics = await engine.run(enrichedOptions, this._currentController);
			this._lastBatchMetrics = metrics;
			return metrics;
		} finally {
			this._isRunning = false;
			this._currentController = null;
		}
	}

	async translateUnit(
		unitId:     string,
		options:    ITranslationOptions,
		sourceRoot: string,
		targetRoot: string,
	): Promise<ITranslationResult> {
		const controller = new AbortController();
		const migrationPatternId = this._session.session?.migrationPattern ?? undefined;
		const result = await runTranslationLoop(
			unitId, options, this._kb, this._llm, this._settings, controller.signal, migrationPatternId,
		);

		if (result.outcome !== 'skipped') {
			await recordTranslationResult(result, this._kb, sourceRoot, targetRoot, this._llm, this._settings);
		}

		// Emit as a completed event so UI subscriptions see single-unit translations too
		this._onProgress.fire({
			type: 'unit-completed',
			data: {
				result,
				index:   1,
				total:   1,
				metrics: this._lastBatchMetrics ?? buildEmptyMetrics(),
			},
		});

		return result;
	}

	cancelBatch(): void {
		this._currentController?.abort();
	}

	// \u2500\u2500 Schedule preview \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	previewSchedule(options: ITranslationOptions): ITranslationSchedulePreview {
		const allUnits  = this._kb.getAllUnits();
		const scheduler = TranslationScheduler.build(allUnits, options);
		const depthMap  = scheduler.byDepth();
		const byRisk    = scheduler.countByRisk();

		const depthGroups = [...depthMap.entries()]
			.sort(([a], [b]) => a - b)
			.map(([depth, items]) => ({
				depth,
				unitCount: items.length,
				units: items.map((item): ITranslationSchedulePreviewEntry => ({
					unitId:        item.unit.id,
					unitName:      item.unit.name,
					sourceLang:    item.unit.sourceLang,
					riskLevel:     item.unit.riskLevel,
					depth:         item.depth,
					priorityScore: item.priorityScore,
					dependsOn:     [...item.unit.dependsOn],
					usedBy:        [...item.unit.usedBy],
				})),
			}));

		return {
			totalUnits:  scheduler.total,
			depthGroups,
			byRisk:      byRisk as Record<string, number>,
		};
	}
}


// \u2500\u2500\u2500 Utility \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function buildEmptyMetrics(): ITranslationBatchMetrics {
	return {
		startedAt:                  Date.now(),
		lastRecordedAt:             null,
		elapsedMs:                  0,
		totalUnits:                 0,
		attempted:                  0,
		succeeded:                  0,
		partial:                    0,
		blocked:                    0,
		failed:                     0,
		skipped:                    0,
		averageConfidence:          0,
		unitsWithDecisions:         0,
		unitsWithBlockingDecisions: 0,
		totalTokensConsumed:        0,
		totalLLMCalls:              0,
		unitsPerMinute:             0,
		byLanguagePair:             [],
		succeededUnitIds:           [],
		partialUnitIds:             [],
		blockedUnitIds:             [],
		failedUnitIds:              [],
		skippedUnitIds:             [],
	};
}
