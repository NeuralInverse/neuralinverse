/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Source Resolution Engine — Public Exports & DI Registration
 *
 * Import this file as a side-effect to register the SourceResolutionService in the
 * DI container:
 *
 * ```ts
 * import '...neuralInverseModernisation/browser/engine/resolution/index.js';
 * ```
 *
 * Consumers should import from this file, not from internal modules directly.
 *
 * ## What gets registered
 *
 * - `ISourceResolutionService` \u2192 `SourceResolutionServiceImpl` (Delayed singleton)
 *
 * ## What gets exported
 *
 * - `ISourceResolutionService` interface + DI token
 * - Batch / progress event payload types
 * - Resolution result types (for agents and tools that process results)
 * - Resolution summary type (for UI display)
 * - Metrics snapshot type (for diagnostics panel)
 */

// ── Public service interface ──────────────────────────────────────────────────
export { ISourceResolutionService } from './service.js';
export type {
	IResolutionUnitCompleteEvent,
	IResolutionBatchProgressEvent,
	IResolutionBatchCompleteEvent,
} from './service.js';

// ── Resolution result types ───────────────────────────────────────────────────
export type {
	IUnitResolutionResult,
	IBatchResolutionSummary,
	IResolutionOptions,
	IResolutionRequest,
	IDependencyResolutionResult,
	IDependencyRef,
	DependencyRefType,
	ResolutionOutcome,
} from './impl/resolutionTypes.js';

// ── Metrics ───────────────────────────────────────────────────────────────────
export type {
	IResolutionMetricsSnapshot,
	IResolutionLanguageStats,
	IMissingDependency,
} from './impl/resolutionMetrics.js';


// ── DI Registration (side-effect) ─────────────────────────────────────────────
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { ISourceResolutionService } from './service.js';
import { SourceResolutionServiceImpl } from './SourceResolutionServiceImpl.js';

registerSingleton(ISourceResolutionService, SourceResolutionServiceImpl, InstantiationType.Delayed);
