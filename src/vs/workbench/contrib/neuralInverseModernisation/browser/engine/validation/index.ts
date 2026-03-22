/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Validation Engine — Public Exports & DI Registration
 *
 * Import this file as a side-effect to register the ValidationEngineService in the DI container:
 *
 * ```ts
 * import '...neuralInverseModernisation/browser/engine/validation/index.js';
 * ```
 *
 * All external consumers should import from this file, not from internal modules.
 */

// ── Public service interface ──────────────────────────────────────────────────
export {
	IValidationEngineService,
	ValidationBatchAlreadyRunningError,
} from './service.js';

// ── Validation options & results ──────────────────────────────────────────────
export type {
	IValidationOptions,
	IValidationResult,
	IValidationBatchMetrics,
	IValidationBatchProgress,
	IBatchValidationOptions,
	IStaticCheckResult,
	IValidationTestCase,
	ValidationOutcome,
	ValidationConfidence,
	StaticCheckStatus,
} from './impl/validationTypes.js';
export { DEFAULT_VALIDATION_OPTIONS } from './impl/validationTypes.js';

// ── Schedule preview ──────────────────────────────────────────────────────────
export type { IValidationScheduleEntry } from './impl/validationScheduler.js';
export { previewValidationSchedule } from './impl/validationScheduler.js';

// ── Metrics helpers ───────────────────────────────────────────────────────────
export { outcomeLabel, confidenceLabel, formatBatchMetricsSummary } from './impl/validationMetrics.js';

// ── Override recording (used by unitEditorView approve flow) ──────────────────
export { recordEquivalenceOverride, deriveEvidencePath } from './impl/validationRecorder.js';


// ── DI registration ───────────────────────────────────────────────────────────
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IValidationEngineService as _IValidationEngineService } from './service.js';
import { ValidationEngineServiceImpl } from './ValidationEngineServiceImpl.js';

registerSingleton(_IValidationEngineService, ValidationEngineServiceImpl, InstantiationType.Delayed);
