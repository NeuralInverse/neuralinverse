/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import {
	IDecisionLog,
	IPendingDecision,
	IBusinessTerm,
	IBusinessRule,
	IBusinessDomain,
	IKnowledgeAuditEntry,
	IUnitAnnotation,
	IStaleUnitReport,
} from '../../../common/knowledgeBaseTypes.js';
import {
	IDecisionConflict,
	IDecisionImpactResult,
	ISourceDriftAlert,
	IKBHealthReport,
	IUnitTag,
	IComplianceGateResult,
	IKnowledgeBaseCheckpoint,
} from '../../knowledgeBase/service.js';
import {
	IAgentToolDefinition,
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
	// Decision write
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
	IPhaseDetailResult,
	// Autonomy
	IAutonomyStartBatchInput,
	IAutonomyPreviewScheduleInput,
	IAutonomyRunSingleUnitInput,
	IAutonomyResolveEscalationInput,
	IAutonomyGetEscalationsInput,
	IAutonomyGetRunHistoryInput,
} from './agentToolTypes.js';

export const IModernisationAgentToolService =
	createDecorator<IModernisationAgentToolService>('modernisationAgentToolService');

/**
 * # Modernisation Agent Tool Service
 *
 * Exposes all 67 agent tools as:
 *  1. Typed TypeScript methods (for programmatic use by the translation engine, UI, etc.)
 *  2. `executeTool(name, input)` \u2014 generic dispatch for LLM tool-calling agents
 *  3. `getAllToolDefinitions()` \u2014 MCP-compatible schema for LLM context injection
 *
 * The service is a thin orchestration layer over `IKnowledgeBaseService`.
 * All state is persisted in the KB. The tools are stateless.
 *
 * ## Works for any project
 *
 * While designed for modernisation workflows, every tool works against ANY
 * knowledge base \u2014 including standalone projects that have been scanned and parsed
 * without a migration target. A developer working on a complex Node.js, Python,
 * or Java codebase can use `get_business_rules`, `get_glossary`, `answer_decision`,
 * `get_progress`, `filter_units`, `create_tag`, `create_work_package`, and all
 * other tools just as usefully as a COBOL migration project.
 */
export interface IModernisationAgentToolService {
	readonly _serviceBrand: undefined;

	// \u2500\u2500 Tool registry \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** All MCP-compatible tool definitions \u2014 pass directly to sendLLMMessage mcpTools */
	getAllToolDefinitions(): IAgentToolDefinition[];

	/**
	 * Context-aware tool definitions for the current session state.
	 *
	 * - When `sessionActive` is true (modernisation session open): returns all
	 *   KB tools + all 10 autonomy tools (batch control + read/query).
	 * - When `sessionActive` is false: returns all KB tools + the 6 read-only
	 *   autonomy tools (status, preview, escalations, resolve, run-single, history).
	 *
	 * Use this for the LLM context injection so the model only sees tools it can
	 * meaningfully use. Pass `getAllToolDefinitions()` only for full tool access.
	 */
	getContextualToolDefinitions(sessionActive: boolean): IAgentToolDefinition[];

	/** Look up a single tool definition by name */
	getToolDefinition(name: string): IAgentToolDefinition | undefined;

	/**
	 * Execute a tool by name with a raw (untyped) input object.
	 * Returns a JSON string formatted for LLM consumption.
	 * Used by the LLM tool-calling agent loop.
	 */
	executeTool(name: string, input: unknown): Promise<string>;

	// \u2500\u2500 Unit read tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Get a single unit by ID or name */
	getUnit(input: IGetUnitInput): IAgentToolCallResult<IUnitSummary>;

	/** List units with optional filters */
	listUnits(input?: IListUnitsInput): IAgentToolCallResult<IUnitSummary[]>;

	/** Get the highest-priority unit eligible for translation */
	getNextUnit(input?: IGetNextUnitInput): IAgentToolCallResult<IUnitSummary | null>;

	/** Get the fully assembled translation context for a unit */
	getUnitContext(input: IGetUnitContextInput): IAgentToolCallResult<IUnitContextResult>;

	/** Get a unit's dependency graph */
	getUnitDependencies(input: IGetUnitDependenciesInput): IAgentToolCallResult<IDependencyResult>;

	/** Get all units that will be affected if this unit changes */
	getImpactChain(input: IGetImpactChainInput): IAgentToolCallResult<IUnitSummary[]>;

	/** Full-text search across all units */
	searchUnits(input: ISearchUnitsInput): IAgentToolCallResult<IUnitSummary[]>;

	/** Audit trail for a specific unit */
	getUnitHistory(input: IGetUnitHistoryInput): IAgentToolCallResult<IKnowledgeAuditEntry[]>;

	// \u2500\u2500 Decision read tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** List pending (unanswered) decisions */
	getPendingDecisions(input?: IGetPendingDecisionsInput): IAgentToolCallResult<IPendingDecision[]>;

	/** Get a specific pending decision */
	getDecision(input: IGetDecisionInput): IAgentToolCallResult<IPendingDecision | null>;

	/** View the full decision log (answered decisions) */
	getDecisionLog(input?: IGetDecisionLogInput): IAgentToolCallResult<IDecisionLog>;

	/** Find conflicting decisions (same source mapped to different targets) */
	detectConflicts(): IAgentToolCallResult<IDecisionConflict[]>;

	/** Compute which units would be affected by changing a decision */
	getDecisionImpact(input: IGetDecisionImpactInput): IAgentToolCallResult<IDecisionImpactResult>;

	// \u2500\u2500 Decision write tool \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Answer a pending decision, creating the appropriate decision record
	 * (type mapping, naming, rule interpretation, etc.) and unblocking the unit.
	 */
	answerDecision(input: IAnswerDecisionInput): IAgentToolCallResult<IAnswerDecisionResult>;

	// \u2500\u2500 Translation write tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Record a completed AI translation for a unit */
	recordTranslation(input: IRecordTranslationInput): IAgentToolCallResult<IRecordTranslationResult>;

	/** Block a unit \u2014 creates a pending decision the human must answer */
	flagBlocked(input: IFlagBlockedInput): IAgentToolCallResult<IFlagBlockedResult>;

	/** Unblock a unit \u2014 move it back to 'ready' for (re-)translation */
	flagReady(input: IFlagReadyInput): IAgentToolCallResult<{ unitId: string; newStatus: string }>;

	// \u2500\u2500 Annotation tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Attach a note or comment to a unit */
	addAnnotation(input: IAddAnnotationInput): IAgentToolCallResult<IUnitAnnotation>;

	/** Update an existing annotation's text */
	updateAnnotation(input: IUpdateAnnotationInput): IAgentToolCallResult<{ updated: boolean }>;

	// \u2500\u2500 Decision record tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Record a type mapping decision that applies to future translations */
	recordTypeMapping(input: IRecordTypeMappingInput): IAgentToolCallResult<{ id: string }>;

	/** Record a naming decision (source identifier \u2192 target identifier) */
	recordNamingDecision(input: IRecordNamingDecisionInput): IAgentToolCallResult<{ id: string }>;

	/** Record a rule interpretation (what a business rule means in context) */
	recordRuleInterpretation(input: IRecordRuleInterpretationInput): IAgentToolCallResult<{ id: string }>;

	// \u2500\u2500 Glossary tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Get glossary terms (optionally filtered by domain or search query) */
	getGlossary(input?: IGetGlossaryInput): IAgentToolCallResult<IBusinessTerm[]>;

	/** Add or update a domain glossary term */
	addGlossaryTerm(input: IAddGlossaryTermInput): IAgentToolCallResult<IBusinessTerm>;

	/** Get business rules for a unit or domain */
	getBusinessRules(input?: IGetBusinessRulesInput): IAgentToolCallResult<IBusinessRule[]>;

	/** List all business domains with their unit counts */
	getDomains(): IAgentToolCallResult<IBusinessDomain[]>;

	// \u2500\u2500 Workspace/progress tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Get overall translation progress with velocity and ETA */
	getProgress(input?: IGetProgressInput): IAgentToolCallResult<IProgressResult>;

	/** High-level workspace health summary */
	getWorkspaceSummary(input?: IGetWorkspaceSummaryInput): IAgentToolCallResult<IWorkspaceSummaryResult>;

	/** Run a full KB integrity check */
	runHealthCheck(): IAgentToolCallResult<IKBHealthReport>;

	/** Check if source files have changed since the last scan */
	checkSourceDrift(input?: ICheckSourceDriftInput): IAgentToolCallResult<ISourceDriftAlert[]>;

	// \u2500\u2500 Phase tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** List all migration phases with progress counts */
	getPhases(): IAgentToolCallResult<IPhaseDetailResult[]>;

	/** List units belonging to a specific phase */
	getUnitsByPhase(input: IGetUnitsByPhaseInput): IAgentToolCallResult<IUnitSummary[]>;

	// \u2500\u2500 Advanced query tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Find units stuck in a non-terminal status longer than thresholdMs */
	getStaleUnits(input?: IGetStaleUnitsInput): IAgentToolCallResult<IStaleUnitReport[]>;

	/** All units ordered leaf-first (correct translation order) */
	getTopologicalOrder(): IAgentToolCallResult<IUnitSummary[]>;

	/** Advanced multi-criteria filter \u2014 superset of list_units */
	filterUnits(input?: IFilterUnitsInput): IAgentToolCallResult<IUnitSummary[]>;

	/** Recursive dependency tree for a unit */
	getDependencyTree(input: IGetDependencyTreeInput): IAgentToolCallResult<IDependencyTreeNode>;

	// \u2500\u2500 Decision management \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Resolve a decision conflict by choosing the canonical decision */
	resolveConflict(input: IResolveConflictInput): IAgentToolCallResult<{ conflictId: string; resolved: boolean }>;

	/** Remove a specific decision record by ID and type */
	removeDecision(input: IRemoveDecisionInput): IAgentToolCallResult<{ removed: boolean }>;

	// \u2500\u2500 Extended annotation tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** List all annotations on a unit */
	listAnnotations(input: IListAnnotationsInput): IAgentToolCallResult<IUnitAnnotation[]>;

	/** Delete an annotation by ID */
	deleteAnnotation(input: IDeleteAnnotationInput): IAgentToolCallResult<{ deleted: boolean }>;

	// \u2500\u2500 Work package tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Create an ad-hoc work package for sprint / team assignment */
	createWorkPackage(input: ICreateWorkPackageInput): IAgentToolCallResult<IWorkPackageSummary>;

	/** List all work packages */
	listWorkPackages(): IAgentToolCallResult<IWorkPackageSummary[]>;

	/** Get a specific work package by ID */
	getWorkPackage(input: IGetWorkPackageInput): IAgentToolCallResult<IWorkPackageSummary & { unitIds: string[] }>;

	/** Add a unit to a work package */
	addUnitToWorkPackage(input: IAddUnitToWorkPackageInput): IAgentToolCallResult<{ workPackageId: string; unitId: string }>;

	/** Remove a unit from a work package */
	removeUnitFromWorkPackage(input: IRemoveUnitFromWorkPackageInput): IAgentToolCallResult<{ workPackageId: string; unitId: string }>;

	/** Delete a work package (units are not affected) */
	deleteWorkPackage(input: IDeleteWorkPackageInput): IAgentToolCallResult<{ deleted: boolean }>;

	// \u2500\u2500 Lock tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Acquire an exclusive lock on a unit before translating */
	lockUnit(input: ILockUnitInput): IAgentToolCallResult<ILockResult | null>;

	/** Release a lock after translation is complete */
	unlockUnit(input: IUnlockUnitInput): IAgentToolCallResult<{ released: boolean }>;

	/** Force-release a lock regardless of owner */
	forceUnlockUnit(input: IForceUnlockUnitInput): IAgentToolCallResult<{ released: boolean }>;

	/** List all active locks */
	listLocks(): IAgentToolCallResult<Array<ILockResult & { unitName: string; isExpired: boolean }>>;

	// \u2500\u2500 Tag tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Create a new tag */
	createTag(input: ICreateTagInput): IAgentToolCallResult<IUnitTag>;

	/** List all tags with unit counts */
	listTags(): IAgentToolCallResult<Array<IUnitTag & { unitCount: number }>>;

	/** Apply a tag to a unit */
	addTagToUnit(input: IAddTagToUnitInput): IAgentToolCallResult<{ unitId: string; tagId: string }>;

	/** Remove a tag from a unit */
	removeTagFromUnit(input: IRemoveTagFromUnitInput): IAgentToolCallResult<{ unitId: string; tagId: string }>;

	/** Get all tags currently applied to a unit */
	getTagsForUnit(input: IGetTagsForUnitInput): IAgentToolCallResult<IUnitTag[]>;

	// \u2500\u2500 Compliance tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Run the compliance gate check for a unit */
	checkComplianceGate(input: ICheckComplianceGateInput): IAgentToolCallResult<IComplianceGateResult>;

	/** Record a human compliance approval for a specific requirement */
	recordComplianceApproval(input: IRecordComplianceApprovalInput): IAgentToolCallResult<{ unitId: string; requirementId: string; approver: string }>;

	/** Formally waive a compliance requirement with documented reason */
	waiveComplianceRequirement(input: IWaiveComplianceRequirementInput): IAgentToolCallResult<{ unitId: string; requirementId: string; waivedBy: string }>;

	/** Get all units that have failing or partial compliance gates */
	getComplianceFailures(): IAgentToolCallResult<IComplianceFailureSummary[]>;

	// \u2500\u2500 Checkpoint tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Snapshot the current KB state under a named label */
	createCheckpoint(input: ICreateCheckpointInput): Promise<IAgentToolCallResult<IKnowledgeBaseCheckpoint>>;

	/** List all available checkpoints */
	listCheckpoints(): IAgentToolCallResult<IKnowledgeBaseCheckpoint[]>;

	/** Restore the KB to a checkpoint state */
	restoreCheckpoint(input: IRestoreCheckpointInput): Promise<IAgentToolCallResult<{ restored: boolean; checkpointId: string }>>;

	/** Delete a checkpoint */
	deleteCheckpoint(input: IDeleteCheckpointInput): IAgentToolCallResult<{ deleted: boolean }>;

	// \u2500\u2500 Unit management tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Split a god unit into smaller sub-units */
	splitUnit(input: ISplitUnitInput): IAgentToolCallResult<ISplitUnitResult>;

	/** Merge over-decomposed units into one */
	mergeUnits(input: IMergeUnitsInput): IAgentToolCallResult<IMergeUnitsResult>;

	/** Revert a unit back to pending, clearing all translation artifacts */
	revertUnit(input: IRevertUnitInput): IAgentToolCallResult<{ unitId: string; newStatus: string }>;

	// \u2500\u2500 Export / Import tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Export the decision log as a portable JSON string */
	exportDecisions(): IAgentToolCallResult<IExportDecisionsResult>;

	/** Import decisions from an exportDecisions() payload */
	importDecisions(input: IImportDecisionsInput): IAgentToolCallResult<{ imported: boolean }>;

	/** Export the full knowledge base as JSON */
	exportKb(): IAgentToolCallResult<IExportKbResult>;

	// \u2500\u2500 Utility tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Check if a file path or unit name matches any exclusion rule */
	checkExcluded(input: ICheckExcludedInput): IAgentToolCallResult<ICheckExcludedResult>;

	// \u2500\u2500 Autonomy tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// Available for any project (default): status, preview, escalations, resolve, run-single, history
	// Session-active only: start, pause, resume, stop

	/** Get current batch state, live metrics, and escalation count */
	autonomyGetBatchStatus(): IAgentToolCallResult<Record<string, unknown>>;

	/** Preview the autonomy schedule without running any stages */
	autonomyPreviewSchedule(input?: IAutonomyPreviewScheduleInput): IAgentToolCallResult<Record<string, unknown>>;

	/** List units awaiting human review */
	autonomyGetEscalations(input?: IAutonomyGetEscalationsInput): IAgentToolCallResult<Record<string, unknown>>;

	/** Record a human decision for an escalated unit */
	autonomyResolveEscalation(input: IAutonomyResolveEscalationInput): Promise<IAgentToolCallResult<Record<string, unknown>>>;

	/** Execute the next pipeline step for a single unit */
	autonomyRunSingleUnit(input: IAutonomyRunSingleUnitInput): Promise<IAgentToolCallResult<Record<string, unknown>>>;

	/** Return the history of completed batch runs */
	autonomyGetRunHistory(input?: IAutonomyGetRunHistoryInput): IAgentToolCallResult<Record<string, unknown>>;

	/** Start the autonomy pipeline batch (requires active session) */
	autonomyStartBatch(input?: IAutonomyStartBatchInput): Promise<IAgentToolCallResult<Record<string, unknown>>>;

	/** Pause the running batch (requires active session) */
	autonomyPauseBatch(): IAgentToolCallResult<Record<string, unknown>>;

	/** Resume a paused batch (requires active session) */
	autonomyResumeBatch(): Promise<IAgentToolCallResult<Record<string, unknown>>>;

	/** Stop the running batch (requires active session) */
	autonomyStopBatch(): IAgentToolCallResult<Record<string, unknown>>;
}
