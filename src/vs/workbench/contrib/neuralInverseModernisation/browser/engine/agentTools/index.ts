/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Agent Tools \u2014 Phase 5
 *
 * 67 MCP-compatible tools over IKnowledgeBaseService.
 * Works for modernisation projects AND standalone projects.
 *
 * Usage:
 *   import { IModernisationAgentToolService } from './agentTools/index.js';
 *   // inject @IModernisationAgentToolService in any DI consumer
 *
 * LLM tool-calling:
 *   const tools = agentToolService.getAllToolDefinitions();
 *   sendLLMMessage({ mcpTools: tools, ... });
 *   // on tool_call: agentToolService.executeTool(name, input)
 */

import { InstantiationType, registerSingleton } from '../../../../../../platform/instantiation/common/extensions.js';
import { IModernisationAgentToolService } from './service.js';
import { ModernisationAgentToolServiceImpl } from './ModernisationAgentToolServiceImpl.js';

registerSingleton(
	IModernisationAgentToolService,
	ModernisationAgentToolServiceImpl,
	InstantiationType.Delayed,
);

// \u2500\u2500 Public re-exports \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export { IModernisationAgentToolService } from './service.js';

export type {
	IAgentToolDefinition,
	IAgentToolInputSchema,
	IAgentToolProperty,
	IAgentToolCallResult,
	// Unit read
	IGetUnitInput,
	IListUnitsInput,
	IGetNextUnitInput,
	IGetUnitContextInput,
	IGetUnitDependenciesInput,
	IGetImpactChainInput,
	ISearchUnitsInput,
	IGetUnitHistoryInput,
	// Decision read
	IGetPendingDecisionsInput,
	IGetDecisionInput,
	IAnswerDecisionInput,
	IGetDecisionLogInput,
	IGetDecisionImpactInput,
	IResolveConflictInput,
	IRemoveDecisionInput,
	// Translation
	IRecordTranslationInput,
	IFlagBlockedInput,
	IFlagReadyInput,
	// Annotations
	IAddAnnotationInput,
	IUpdateAnnotationInput,
	IListAnnotationsInput,
	IDeleteAnnotationInput,
	// Decision records
	IRecordTypeMappingInput,
	IRecordNamingDecisionInput,
	IRecordRuleInterpretationInput,
	// Glossary
	IGetGlossaryInput,
	IAddGlossaryTermInput,
	IGetBusinessRulesInput,
	// Progress / workspace
	IGetProgressInput,
	IGetWorkspaceSummaryInput,
	ICheckSourceDriftInput,
	// Phases
	IGetUnitsByPhaseInput,
	IPhaseDetailResult,
	// Work packages
	ICreateWorkPackageInput,
	IGetWorkPackageInput,
	IAddUnitToWorkPackageInput,
	IRemoveUnitFromWorkPackageInput,
	IDeleteWorkPackageInput,
	IWorkPackageSummary,
	// Locks
	ILockUnitInput,
	IUnlockUnitInput,
	IForceUnlockUnitInput,
	ILockResult,
	// Tags
	ICreateTagInput,
	IAddTagToUnitInput,
	IRemoveTagFromUnitInput,
	IGetTagsForUnitInput,
	// Compliance
	ICheckComplianceGateInput,
	IRecordComplianceApprovalInput,
	IWaiveComplianceRequirementInput,
	IComplianceFailureSummary,
	// Checkpoints
	ICreateCheckpointInput,
	IRestoreCheckpointInput,
	IDeleteCheckpointInput,
	// Unit management
	ISplitUnitInput,
	ISplitUnitResult,
	ISubUnitDescriptor,
	IMergeUnitsInput,
	IMergeUnitsResult,
	IRevertUnitInput,
	// Advanced queries
	IGetStaleUnitsInput,
	IFilterUnitsInput,
	IGetDependencyTreeInput,
	IDependencyTreeNode,
	// Export / Import
	IImportDecisionsInput,
	IExportDecisionsResult,
	IExportKbResult,
	// Utility
	ICheckExcludedInput,
	ICheckExcludedResult,
	// Shared output types
	IUnitSummary,
	IUnitContextResult,
	IDependencyResult,
	IProgressResult,
	IWorkspaceSummaryResult,
	IAnswerDecisionResult,
	IRecordTranslationResult,
	IFlagBlockedResult,
	IVelocityResult,
	IPhaseResult,
} from './agentToolTypes.js';

export { MCP_TOOL_DEFINITIONS } from './mcpToolDefinitions.js';
