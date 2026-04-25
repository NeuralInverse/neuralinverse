/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Translation Engine \u2014 Public Exports & DI Registration
 *
 * Import this file as a side-effect to register the TranslationEngineService in the DI container:
 *
 * ```ts
 * import '...neuralInverseModernisation/browser/engine/translation/index.js';
 * ```
 *
 * All external consumers should import from this file, not from internal modules.
 */

// \u2500\u2500 Public service interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
export {
	ITranslationEngineService,
	BatchAlreadyRunningError,
} from './service.js';
export type {
	ITranslationSchedulePreview,
	ITranslationSchedulePreviewEntry,
} from './service.js';

// \u2500\u2500 Translation options & results \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
export type {
	ITranslationOptions,
	ITranslationResult,
	ITranslationVerificationResult,
	IVerificationCheck,
	TranslationOutcome,
	TranslationConfidence,
} from './impl/translationTypes.js';
export {
	DEFAULT_TRANSLATION_OPTIONS,
	CONFIDENCE_SCORE,
} from './impl/translationTypes.js';

// \u2500\u2500 Batch progress events \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
export type {
	ITranslationBatchProgress,
	ITranslationUnitStartedEvent,
	ITranslationUnitCompletedEvent,
	ITranslationBatchCompletedEvent,
	ITranslationBatchMetrics,
	ILanguagePairMetrics,
	IBatchTranslationOptions,
} from './impl/batchTranslationEngine.js';

// \u2500\u2500 Metrics helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
export {
	formatConfidenceScore,
	outcomeLabel,
} from './impl/translationMetrics.js';

// \u2500\u2500 Target file path suggestion (used by UI to preview output locations) \u2500\u2500\u2500\u2500\u2500\u2500
export { suggestTargetFilePath } from './impl/translationRecorder.js';

// \u2500\u2500 Language pair registry (used by project setup wizard) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
export {
	getLanguagePairProfile,
	getTargetFileExtension,
	listLanguagePairProfiles,
} from './impl/languagePairRegistry.js';

// \u2500\u2500 Chunker (used by UI to show oversized unit warnings) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
export type {
	ISourceChunk,
	IChunkSplitResult,
	IChunkStitchInput,
	IStitchResult,
} from './impl/translationChunker.js';
export { splitIntoChunks, stitchChunks, buildChunkContextPrefix } from './impl/translationChunker.js';

// \u2500\u2500 Schedule preview utilities \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
export { getRiskLevelsInPriorityOrder } from './impl/translationScheduler.js';


// \u2500\u2500 DI registration \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { ITranslationEngineService as _ITranslationEngineService } from './service.js';
import { TranslationEngineServiceImpl } from './TranslationEngineServiceImpl.js';

registerSingleton(_ITranslationEngineService, TranslationEngineServiceImpl, InstantiationType.Delayed);
