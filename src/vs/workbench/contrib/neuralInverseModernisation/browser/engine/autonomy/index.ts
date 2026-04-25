/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 12 \u2014 Agent Autonomy
 *
 * Entry point for DI registration and public re-exports.
 * Import this module as a side-effect in neuralInverseModernisation.contribution.ts.
 *
 * ## What is exported
 *
 * All types and tokens that downstream consumers (Void agentic layer, Power Mode,
 * Sub-agents) need to interact with the Autonomy Service.
 *
 *   - `IAutonomyService`       \u2014 DI token + interface
 *   - All option / result types needed to call the service
 *   - All event payload types needed to subscribe to service events
 *   - Error classes for structured error handling
 *   - `AutonomyStage`, `BatchState`, `EscalationDecision` for type-safe dispatch
 *   - `IAutoApprovalConfig` / `DEFAULT_AUTO_APPROVAL_CONFIG` for policy customisation
 *   - `IAutonomyBatchRun` / `IAutonomySchedulePreview` for history + preview UIs
 *   - `formatStageTiming`, `errorCategoryLabel` utilities for reporting UIs
 */

import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IAutonomyService } from './service.js';
import { AutonomyServiceImpl } from './AutonomyServiceImpl.js';


// \u2500\u2500\u2500 DI registration \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

registerSingleton(IAutonomyService, AutonomyServiceImpl, InstantiationType.Delayed);


// \u2500\u2500\u2500 Service token + interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export {
	IAutonomyService,
	AutonomyBatchAlreadyRunningError,
	NoPausedBatchError,
	MissingEscalationReasonError,
} from './service.js';

export type { IRunSingleUnitOptions } from './service.js';


// \u2500\u2500\u2500 Core types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type {
	// Pipeline stage identifier
	AutonomyStage,

	// Batch lifecycle
	BatchState,

	// Error classification
	AutonomyErrorCategory,

	// Per-unit result (returned from runSingleUnit / runAutonomyLoop)
	IAutonomyUnitResult,
	AutonomyUnitOutcome,

	// Per-attempt and per-unit history (for debugging / audit)
	IAutonomyAttempt,
	IAutonomyUnitHistory,

	// Escalation
	IEscalatedUnit,
	IEscalationResolution,
	EscalationDecision,

	// Auto-approval policy
	IAutoApprovalConfig,

	// Batch options and defaults
	IAutonomyOptions,

	// Batch metrics (returned from startBatch / resumeBatch)
	IAutonomyBatchMetrics,
	IStageTiming,

	// Progress event union + individual event types
	IAutonomyProgress,
	IAutonomyUnitStartedEvent,
	IAutonomyUnitCompletedEvent,
	IAutonomyBatchCompletedEvent,

	// Batch state change event
	IBatchStateChange,

	// Persisted run history
	IAutonomyBatchRun,

	// Schedule preview (from previewSchedule())
	IAutonomySchedulePreview,
	IAutonomyScheduleEntry,
} from './impl/autonomyTypes.js';

export {
	// Runtime values needed by consumers
	ALL_AUTONOMY_STAGES,
	DEFAULT_AUTONOMY_OPTIONS,
	DEFAULT_AUTO_APPROVAL_CONFIG,
	MAX_RUN_HISTORY,
	emptyBatchMetrics,
	classifyError,
	isRetryableError,
	AUTONOMY_ANNOTATION_KIND,
	AUTONOMY_RETRY_PREFIX,
	AUTONOMY_LAST_STAGE_PREFIX,
} from './impl/autonomyTypes.js';


// \u2500\u2500\u2500 Metrics utilities \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export {
	formatStageTiming,
	errorCategoryLabel,
} from './impl/autonomyMetrics.js';


// \u2500\u2500\u2500 Auto-approval audit trail \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type {
	IAutoApprovalAuditEntry,
	IAutoApprovalResult,
	AutoApprovalDecision,
} from './impl/autoApprovalPolicy.js';

export {
	formatAuditTrail,
} from './impl/autoApprovalPolicy.js';


// \u2500\u2500\u2500 Schedule preview (raw scheduler access for advanced consumers) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type { IScheduledAutonomyUnit } from './impl/autonomyScheduler.js';


// \u2500\u2500\u2500 Autonomy Tools (Power Mode / Sub-agent tool-calling) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type {
	IAutonomyTool,
	IAutonomyToolParam,
} from './autonomyTools.js';

export { buildAutonomyTools } from './autonomyTools.js';
