/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # FingerprintService — Public Exports & DI Registration
 *
 * Import this file as a side-effect to register the FingerprintService in the DI container:
 *
 * ```ts
 * import '...neuralInverseModernisation/browser/engine/fingerprint/index.js';
 * ```
 *
 * Consumers should import from this file, not from internal modules directly.
 */

// ── Public interface ──────────────────────────────────────────────────────────
export { IFingerprintService } from './service.js';
export type {
	IBatchFingerprintOptions,
	IBatchFingerprintResult,
	IFingerprintSourceResult,
} from './service.js';

// ── Progress event payloads ───────────────────────────────────────────────────
export type {
	IFingerprintUnitEvent,
	IFingerprintBatchProgressEvent,
	IFingerprintBatchCompleteEvent,
} from './impl/progressEmitter.js';

// ── Language registry (for external consumers) ────────────────────────────────
export type { ILanguageProfile, ILanguageTerminology } from './impl/languageRegistry.js';
export {
	resolveLanguageProfile,
	canonicaliseLanguage,
	hasLayer1Support,
	getLanguageDisplayName,
} from './impl/languageRegistry.js';

// ── Schema versioning (for tooling & diagnostics) ─────────────────────────────
export { FINGERPRINT_SCHEMA_VERSION, isFingerprintStale } from './impl/fingerprintVersioning.js';

// ── Fingerprint utilities ─────────────────────────────────────────────────────
export { hasFingerprintContent, fingerprintSummary } from './impl/fingerprintAssembler.js';
export { fnv1a32, buildCacheKey } from './impl/fingerprintCache.js';

// ── DI registration (side-effect) ─────────────────────────────────────────────
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFingerprintService } from './service.js';
import { FingerprintServiceImpl } from './FingerprintServiceImpl.js';

// LLM semantic extractor is registered in its own file — imported here for side-effect
import './llmSemanticExtractor.js';

registerSingleton(IFingerprintService, FingerprintServiceImpl, InstantiationType.Delayed);
