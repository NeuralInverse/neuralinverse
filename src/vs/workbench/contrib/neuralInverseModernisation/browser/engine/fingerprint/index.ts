/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # FingerprintService \u2014 Public Exports & DI Registration
 *
 * Import this file as a side-effect to register the FingerprintService in the DI container:
 *
 * ```ts
 * import '...neuralInverseModernisation/browser/engine/fingerprint/index.js';
 * ```
 *
 * Consumers should import from this file, not from internal modules directly.
 */

// \u2500\u2500 Public interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
export { IFingerprintService } from './service.js';
export type {
	IBatchFingerprintOptions,
	IBatchFingerprintResult,
	IFingerprintSourceResult,
} from './service.js';

// \u2500\u2500 Progress event payloads \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
export type {
	IFingerprintUnitEvent,
	IFingerprintBatchProgressEvent,
	IFingerprintBatchCompleteEvent,
} from './impl/progressEmitter.js';

// \u2500\u2500 Language registry (for external consumers) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
export type { ILanguageProfile, ILanguageTerminology } from './impl/languageRegistry.js';
export {
	resolveLanguageProfile,
	canonicaliseLanguage,
	hasLayer1Support,
	getLanguageDisplayName,
} from './impl/languageRegistry.js';

// \u2500\u2500 Schema versioning (for tooling & diagnostics) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
export { FINGERPRINT_SCHEMA_VERSION, isFingerprintStale } from './impl/fingerprintVersioning.js';

// \u2500\u2500 Fingerprint utilities \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
export { hasFingerprintContent, fingerprintSummary } from './impl/fingerprintAssembler.js';
export { fnv1a32, buildCacheKey } from './impl/fingerprintCache.js';

// \u2500\u2500 DI registration (side-effect) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFingerprintService } from './service.js';
import { FingerprintServiceImpl } from './FingerprintServiceImpl.js';

// LLM semantic extractor is registered in its own file \u2014 imported here for side-effect
import './llmSemanticExtractor.js';

registerSingleton(IFingerprintService, FingerprintServiceImpl, InstantiationType.Delayed);
