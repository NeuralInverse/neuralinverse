/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Cutover Engine — Public Exports & DI Registration
 *
 * Import this file as a side-effect to register the CutoverService in the DI container:
 *
 * ```ts
 * import '...neuralInverseModernisation/browser/engine/cutover/index.js';
 * ```
 *
 * All external consumers should import from this file, not from internal modules.
 */

// ── Public service interface ──────────────────────────────────────────────────
export {
	ICutoverService,
	CommitBatchAlreadyRunningError,
	CutoverNotReadyError,
} from './service.js';
export type {
	ICommitProgress,
} from './service.js';

// ── Audit bundle ──────────────────────────────────────────────────────────────
export type {
	IAuditBundle,
	IAuditBundleOptions,
	IAuditBundleMeta,
	IAuditBundleUnitSummary,
	IAuditBundleDecisionSummary,
	IAuditBundleIntegrity,
} from './impl/auditExporter.js';

// ── Commit batch ──────────────────────────────────────────────────────────────
export type {
	ICommitBatchOptions,
	ICommitBatchResult,
	ICommitJobResult,
} from './impl/commitWriter.js';
export { DEFAULT_COMMIT_OPTIONS } from './impl/commitWriter.js';

// ── Cutover gate ──────────────────────────────────────────────────────────────
export type {
	ICutoverReadinessReport,
	ICutoverReadinessCheck,
	CutoverCheckSeverity,
} from './impl/cutoverGate.js';

// ── Metrics ───────────────────────────────────────────────────────────────────
export type { ICutoverMetrics } from './impl/cutoverMetrics.js';


// ── DI registration ───────────────────────────────────────────────────────────
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { ICutoverService as _ICutoverService } from './service.js';
import { CutoverServiceImpl } from './CutoverServiceImpl.js';

registerSingleton(_ICutoverService, CutoverServiceImpl, InstantiationType.Delayed);
