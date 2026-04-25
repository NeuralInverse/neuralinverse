/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IKnowledgeBaseService } from '../../knowledgeBase/service.js';
import { IModernisationAgentToolService } from './service.js';
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
	MCP_TOOL_DEFINITIONS,
	AUTONOMY_DEFAULT_TOOL_DEFINITIONS,
	AUTONOMY_SESSION_TOOL_DEFINITIONS,
	getToolDefinition as _getToolDef,
} from './mcpToolDefinitions.js';
import { formatToolResult } from './impl/toolUtils.js';
import {
	IAutonomyService,
	AutonomyBatchAlreadyRunningError,
	NoPausedBatchError,
	MissingEscalationReasonError,
} from '../autonomy/service.js';
import {
	type IAutonomyOptions,
	type EscalationDecision,
	ALL_AUTONOMY_STAGES,
} from '../autonomy/impl/autonomyTypes.js';

// \u2500\u2500 Unit tools (read, history, annotations)
import {
	getUnit,
	listUnits,
	getNextUnit,
	getUnitContext,
	getUnitDependencies,
	getImpactChain,
	searchUnits,
	getUnitHistory,
	listAnnotations,
	deleteAnnotation,
} from './impl/unitTools.js';

// \u2500\u2500 Decision tools (read, write, records, conflict management)
import {
	getPendingDecisions,
	getDecision,
	answerDecision,
	getDecisionLog,
	detectConflicts,
	getDecisionImpact,
	recordTypeMapping,
	recordNamingDecision,
	recordRuleInterpretation,
	resolveConflict,
	removeDecision,
} from './impl/decisionTools.js';

// \u2500\u2500 Glossary tools
import {
	getGlossary,
	addGlossaryTerm,
	getBusinessRules,
	getDomains,
} from './impl/glossaryTools.js';

// \u2500\u2500 Progress / workspace / annotation / translation / phase / export tools
import {
	getProgress,
	getWorkspaceSummary,
	runHealthCheck,
	checkSourceDrift,
	recordTranslation,
	flagBlocked,
	flagReady,
	addAnnotation,
	updateAnnotation,
	getPhases,
	getUnitsByPhase,
	exportDecisions,
	importDecisions,
	exportKb,
	checkExcluded,
} from './impl/progressTools.js';

// \u2500\u2500 Advanced query tools
import {
	getStaleUnits,
	getTopologicalOrder,
	filterUnits,
	getDependencyTree,
} from './impl/advancedQueryTools.js';

// \u2500\u2500 Work package tools
import {
	createWorkPackage,
	listWorkPackages,
	getWorkPackage,
	addUnitToWorkPackage,
	removeUnitFromWorkPackage,
	deleteWorkPackage,
} from './impl/workPackageTools.js';

// \u2500\u2500 Lock tools
import {
	lockUnit,
	unlockUnit,
	forceUnlockUnit,
	listLocks,
} from './impl/lockTools.js';

// \u2500\u2500 Tag tools
import {
	createTag,
	listTags,
	addTagToUnit,
	removeTagFromUnit,
	getTagsForUnit,
} from './impl/tagTools.js';

// \u2500\u2500 Compliance tools
import {
	checkComplianceGate,
	recordComplianceApproval,
	waiveComplianceRequirement,
	getComplianceFailures,
} from './impl/complianceTools.js';

// \u2500\u2500 Checkpoint tools (async)
import {
	createCheckpoint,
	listCheckpoints,
	restoreCheckpoint,
	deleteCheckpoint,
} from './impl/checkpointTools.js';

// \u2500\u2500 Unit management tools
import {
	splitUnit,
	mergeUnits,
	revertUnit,
} from './impl/unitManagementTools.js';



export class ModernisationAgentToolServiceImpl
	extends Disposable
	implements IModernisationAgentToolService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IKnowledgeBaseService private readonly _kb: IKnowledgeBaseService,
		@IAutonomyService       private readonly _autonomy: IAutonomyService,
	) {
		super();
	}


	// \u2500\u2500 Tool registry \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	getAllToolDefinitions(): IAgentToolDefinition[] {
		return [...MCP_TOOL_DEFINITIONS, ...AUTONOMY_DEFAULT_TOOL_DEFINITIONS, ...AUTONOMY_SESSION_TOOL_DEFINITIONS];
	}

	getContextualToolDefinitions(sessionActive: boolean): IAgentToolDefinition[] {
		const autonomy = sessionActive
			? [...AUTONOMY_DEFAULT_TOOL_DEFINITIONS, ...AUTONOMY_SESSION_TOOL_DEFINITIONS]
			: AUTONOMY_DEFAULT_TOOL_DEFINITIONS;
		return [...MCP_TOOL_DEFINITIONS, ...autonomy];
	}

	getToolDefinition(name: string): IAgentToolDefinition | undefined {
		return _getToolDef(name);
	}

	async executeTool(name: string, input: unknown): Promise<string> {
		// LLM provides untyped JSON; individual tool functions validate required fields at runtime
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const inp = (input ?? {}) as any;
		let result: IAgentToolCallResult<unknown>;

		switch (name) {
			// \u2500\u2500 Unit read
			case 'get_unit':                result = this.getUnit(inp as IGetUnitInput); break;
			case 'list_units':              result = this.listUnits(inp as IListUnitsInput); break;
			case 'get_next_unit':           result = this.getNextUnit(inp as IGetNextUnitInput); break;
			case 'get_unit_context':        result = this.getUnitContext(inp as IGetUnitContextInput); break;
			case 'get_unit_dependencies':   result = this.getUnitDependencies(inp as IGetUnitDependenciesInput); break;
			case 'get_impact_chain':        result = this.getImpactChain(inp as IGetImpactChainInput); break;
			case 'search_units':            result = this.searchUnits(inp as ISearchUnitsInput); break;
			case 'get_unit_history':        result = this.getUnitHistory(inp as IGetUnitHistoryInput); break;

			// \u2500\u2500 Decision read
			case 'get_pending_decisions':   result = this.getPendingDecisions(inp as IGetPendingDecisionsInput); break;
			case 'get_decision':            result = this.getDecision(inp as IGetDecisionInput); break;
			case 'get_decision_log':        result = this.getDecisionLog(inp as IGetDecisionLogInput); break;
			case 'detect_conflicts':        result = this.detectConflicts(); break;
			case 'get_decision_impact':     result = this.getDecisionImpact(inp as IGetDecisionImpactInput); break;

			// \u2500\u2500 Decision write
			case 'answer_decision':         result = this.answerDecision(inp as IAnswerDecisionInput); break;

			// \u2500\u2500 Translation write
			case 'record_translation':      result = this.recordTranslation(inp as IRecordTranslationInput); break;
			case 'flag_blocked':            result = this.flagBlocked(inp as IFlagBlockedInput); break;
			case 'flag_ready':              result = this.flagReady(inp as IFlagReadyInput); break;

			// \u2500\u2500 Annotation
			case 'add_annotation':          result = this.addAnnotation(inp as IAddAnnotationInput); break;
			case 'update_annotation':       result = this.updateAnnotation(inp as IUpdateAnnotationInput); break;

			// \u2500\u2500 Decision record
			case 'record_type_mapping':         result = this.recordTypeMapping(inp as IRecordTypeMappingInput); break;
			case 'record_naming_decision':      result = this.recordNamingDecision(inp as IRecordNamingDecisionInput); break;
			case 'record_rule_interpretation':  result = this.recordRuleInterpretation(inp as IRecordRuleInterpretationInput); break;

			// \u2500\u2500 Glossary
			case 'get_glossary':            result = this.getGlossary(inp as IGetGlossaryInput); break;
			case 'add_glossary_term':       result = this.addGlossaryTerm(inp as IAddGlossaryTermInput); break;
			case 'get_business_rules':      result = this.getBusinessRules(inp as IGetBusinessRulesInput); break;
			case 'get_domains':             result = this.getDomains(); break;

			// \u2500\u2500 Workspace / progress
			case 'get_progress':            result = this.getProgress(inp as IGetProgressInput); break;
			case 'get_workspace_summary':   result = this.getWorkspaceSummary(inp as IGetWorkspaceSummaryInput); break;
			case 'run_health_check':        result = this.runHealthCheck(); break;
			case 'check_source_drift':      result = this.checkSourceDrift(inp as ICheckSourceDriftInput); break;

			// \u2500\u2500 Phases
			case 'get_phases':              result = this.getPhases(); break;
			case 'get_units_by_phase':      result = this.getUnitsByPhase(inp as IGetUnitsByPhaseInput); break;

			// \u2500\u2500 Advanced queries
			case 'get_stale_units':         result = this.getStaleUnits(inp as IGetStaleUnitsInput); break;
			case 'get_topological_order':   result = this.getTopologicalOrder(); break;
			case 'filter_units':            result = this.filterUnits(inp as IFilterUnitsInput); break;
			case 'get_dependency_tree':     result = this.getDependencyTree(inp as IGetDependencyTreeInput); break;

			// \u2500\u2500 Decision management
			case 'resolve_conflict':        result = this.resolveConflict(inp as IResolveConflictInput); break;
			case 'remove_decision':         result = this.removeDecision(inp as IRemoveDecisionInput); break;

			// \u2500\u2500 Extended annotations
			case 'list_annotations':        result = this.listAnnotations(inp as IListAnnotationsInput); break;
			case 'delete_annotation':       result = this.deleteAnnotation(inp as IDeleteAnnotationInput); break;

			// \u2500\u2500 Work packages
			case 'create_work_package':         result = this.createWorkPackage(inp as ICreateWorkPackageInput); break;
			case 'list_work_packages':           result = this.listWorkPackages(); break;
			case 'get_work_package':             result = this.getWorkPackage(inp as IGetWorkPackageInput); break;
			case 'add_unit_to_work_package':     result = this.addUnitToWorkPackage(inp as IAddUnitToWorkPackageInput); break;
			case 'remove_unit_from_work_package': result = this.removeUnitFromWorkPackage(inp as IRemoveUnitFromWorkPackageInput); break;
			case 'delete_work_package':          result = this.deleteWorkPackage(inp as IDeleteWorkPackageInput); break;

			// \u2500\u2500 Locks
			case 'lock_unit':               result = this.lockUnit(inp as ILockUnitInput); break;
			case 'unlock_unit':             result = this.unlockUnit(inp as IUnlockUnitInput); break;
			case 'force_unlock_unit':       result = this.forceUnlockUnit(inp as IForceUnlockUnitInput); break;
			case 'list_locks':              result = this.listLocks(); break;

			// \u2500\u2500 Tags
			case 'create_tag':              result = this.createTag(inp as ICreateTagInput); break;
			case 'list_tags':               result = this.listTags(); break;
			case 'add_tag_to_unit':         result = this.addTagToUnit(inp as IAddTagToUnitInput); break;
			case 'remove_tag_from_unit':    result = this.removeTagFromUnit(inp as IRemoveTagFromUnitInput); break;
			case 'get_tags_for_unit':       result = this.getTagsForUnit(inp as IGetTagsForUnitInput); break;

			// \u2500\u2500 Compliance
			case 'check_compliance_gate':       result = this.checkComplianceGate(inp as ICheckComplianceGateInput); break;
			case 'record_compliance_approval':  result = this.recordComplianceApproval(inp as IRecordComplianceApprovalInput); break;
			case 'waive_compliance_requirement': result = this.waiveComplianceRequirement(inp as IWaiveComplianceRequirementInput); break;
			case 'get_compliance_failures':     result = this.getComplianceFailures(); break;

			// \u2500\u2500 Checkpoints (async)
			case 'create_checkpoint':       result = await this.createCheckpoint(inp as ICreateCheckpointInput); break;
			case 'list_checkpoints':        result = this.listCheckpoints(); break;
			case 'restore_checkpoint':      result = await this.restoreCheckpoint(inp as IRestoreCheckpointInput); break;
			case 'delete_checkpoint':       result = this.deleteCheckpoint(inp as IDeleteCheckpointInput); break;

			// \u2500\u2500 Unit management
			case 'split_unit':              result = this.splitUnit(inp as ISplitUnitInput); break;
			case 'merge_units':             result = this.mergeUnits(inp as IMergeUnitsInput); break;
			case 'revert_unit':             result = this.revertUnit(inp as IRevertUnitInput); break;

			// \u2500\u2500 Export / Import
			case 'export_decisions':        result = this.exportDecisions(); break;
			case 'import_decisions':        result = this.importDecisions(inp as IImportDecisionsInput); break;
			case 'export_kb':               result = this.exportKb(); break;

			// \u2500\u2500 Utility
			case 'check_excluded':          result = this.checkExcluded(inp as ICheckExcludedInput); break;

			// \u2500\u2500 Autonomy tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			case 'autonomy_get_batch_status':    result = this.autonomyGetBatchStatus(); break;
			case 'autonomy_preview_schedule':    result = this.autonomyPreviewSchedule(inp as IAutonomyPreviewScheduleInput); break;
			case 'autonomy_get_escalations':     result = this.autonomyGetEscalations(inp as IAutonomyGetEscalationsInput); break;
			case 'autonomy_resolve_escalation':  result = await this.autonomyResolveEscalation(inp as IAutonomyResolveEscalationInput); break;
			case 'autonomy_run_single_unit':     result = await this.autonomyRunSingleUnit(inp as IAutonomyRunSingleUnitInput); break;
			case 'autonomy_get_run_history':     result = this.autonomyGetRunHistory(inp as IAutonomyGetRunHistoryInput); break;
			case 'autonomy_start_batch':         result = await this.autonomyStartBatch(inp as IAutonomyStartBatchInput); break;
			case 'autonomy_pause_batch':         result = this.autonomyPauseBatch(); break;
			case 'autonomy_resume_batch':        result = await this.autonomyResumeBatch(); break;
			case 'autonomy_stop_batch':          result = this.autonomyStopBatch(); break;

			default:
				return JSON.stringify({ success: false, error: `Unknown tool: "${name}"` });
		}

		return formatToolResult(result);
	}


	// \u2500\u2500 Unit read tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	getUnit(input: IGetUnitInput): IAgentToolCallResult<IUnitSummary> {
		return getUnit(input, this._kb);
	}

	listUnits(input?: IListUnitsInput): IAgentToolCallResult<IUnitSummary[]> {
		return listUnits(input, this._kb);
	}

	getNextUnit(input?: IGetNextUnitInput): IAgentToolCallResult<IUnitSummary | null> {
		return getNextUnit(input, this._kb);
	}

	getUnitContext(input: IGetUnitContextInput): IAgentToolCallResult<IUnitContextResult> {
		return getUnitContext(input, this._kb);
	}

	getUnitDependencies(input: IGetUnitDependenciesInput): IAgentToolCallResult<IDependencyResult> {
		return getUnitDependencies(input, this._kb);
	}

	getImpactChain(input: IGetImpactChainInput): IAgentToolCallResult<IUnitSummary[]> {
		return getImpactChain(input, this._kb);
	}

	searchUnits(input: ISearchUnitsInput): IAgentToolCallResult<IUnitSummary[]> {
		return searchUnits(input, this._kb);
	}

	getUnitHistory(input: IGetUnitHistoryInput): IAgentToolCallResult<IKnowledgeAuditEntry[]> {
		return getUnitHistory(input, this._kb);
	}


	// \u2500\u2500 Decision read tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	getPendingDecisions(input?: IGetPendingDecisionsInput): IAgentToolCallResult<IPendingDecision[]> {
		return getPendingDecisions(input, this._kb);
	}

	getDecision(input: IGetDecisionInput): IAgentToolCallResult<IPendingDecision | null> {
		return getDecision(input, this._kb);
	}

	getDecisionLog(input?: IGetDecisionLogInput): IAgentToolCallResult<IDecisionLog> {
		return getDecisionLog(input, this._kb);
	}

	detectConflicts(): IAgentToolCallResult<IDecisionConflict[]> {
		return detectConflicts(this._kb);
	}

	getDecisionImpact(input: IGetDecisionImpactInput): IAgentToolCallResult<IDecisionImpactResult> {
		return getDecisionImpact(input, this._kb);
	}


	// \u2500\u2500 Decision write tool \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	answerDecision(input: IAnswerDecisionInput): IAgentToolCallResult<IAnswerDecisionResult> {
		return answerDecision(input, this._kb);
	}


	// \u2500\u2500 Translation write tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	recordTranslation(input: IRecordTranslationInput): IAgentToolCallResult<IRecordTranslationResult> {
		return recordTranslation(input, this._kb);
	}

	flagBlocked(input: IFlagBlockedInput): IAgentToolCallResult<IFlagBlockedResult> {
		return flagBlocked(input, this._kb);
	}

	flagReady(input: IFlagReadyInput): IAgentToolCallResult<{ unitId: string; newStatus: string }> {
		return flagReady(input, this._kb);
	}


	// \u2500\u2500 Annotation tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	addAnnotation(input: IAddAnnotationInput): IAgentToolCallResult<IUnitAnnotation> {
		return addAnnotation(input, this._kb);
	}

	updateAnnotation(input: IUpdateAnnotationInput): IAgentToolCallResult<{ updated: boolean }> {
		return updateAnnotation(input, this._kb);
	}


	// \u2500\u2500 Decision record tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	recordTypeMapping(input: IRecordTypeMappingInput): IAgentToolCallResult<{ id: string }> {
		return recordTypeMapping(input, this._kb);
	}

	recordNamingDecision(input: IRecordNamingDecisionInput): IAgentToolCallResult<{ id: string }> {
		return recordNamingDecision(input, this._kb);
	}

	recordRuleInterpretation(input: IRecordRuleInterpretationInput): IAgentToolCallResult<{ id: string }> {
		return recordRuleInterpretation(input, this._kb);
	}


	// \u2500\u2500 Glossary tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	getGlossary(input?: IGetGlossaryInput): IAgentToolCallResult<IBusinessTerm[]> {
		return getGlossary(input, this._kb);
	}

	addGlossaryTerm(input: IAddGlossaryTermInput): IAgentToolCallResult<IBusinessTerm> {
		return addGlossaryTerm(input, this._kb);
	}

	getBusinessRules(input?: IGetBusinessRulesInput): IAgentToolCallResult<IBusinessRule[]> {
		return getBusinessRules(input, this._kb);
	}

	getDomains(): IAgentToolCallResult<IBusinessDomain[]> {
		return getDomains(this._kb);
	}


	// \u2500\u2500 Workspace / progress tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	getProgress(input?: IGetProgressInput): IAgentToolCallResult<IProgressResult> {
		return getProgress(input, this._kb);
	}

	getWorkspaceSummary(input?: IGetWorkspaceSummaryInput): IAgentToolCallResult<IWorkspaceSummaryResult> {
		return getWorkspaceSummary(input, this._kb);
	}

	runHealthCheck(): IAgentToolCallResult<IKBHealthReport> {
		return runHealthCheck(this._kb);
	}

	checkSourceDrift(input?: ICheckSourceDriftInput): IAgentToolCallResult<ISourceDriftAlert[]> {
		return checkSourceDrift(input, this._kb);
	}


	// \u2500\u2500 Phase tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	getPhases(): IAgentToolCallResult<IPhaseDetailResult[]> {
		return getPhases(this._kb);
	}

	getUnitsByPhase(input: IGetUnitsByPhaseInput): IAgentToolCallResult<IUnitSummary[]> {
		return getUnitsByPhase(input, this._kb);
	}


	// \u2500\u2500 Advanced query tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	getStaleUnits(input?: IGetStaleUnitsInput): IAgentToolCallResult<IStaleUnitReport[]> {
		return getStaleUnits(input, this._kb);
	}

	getTopologicalOrder(): IAgentToolCallResult<IUnitSummary[]> {
		return getTopologicalOrder(this._kb);
	}

	filterUnits(input?: IFilterUnitsInput): IAgentToolCallResult<IUnitSummary[]> {
		return filterUnits(input, this._kb);
	}

	getDependencyTree(input: IGetDependencyTreeInput): IAgentToolCallResult<IDependencyTreeNode> {
		return getDependencyTree(input, this._kb);
	}


	// \u2500\u2500 Decision management tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	resolveConflict(input: IResolveConflictInput): IAgentToolCallResult<{ conflictId: string; resolved: boolean }> {
		return resolveConflict(input, this._kb);
	}

	removeDecision(input: IRemoveDecisionInput): IAgentToolCallResult<{ removed: boolean }> {
		return removeDecision(input, this._kb);
	}


	// \u2500\u2500 Extended annotation tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	listAnnotations(input: IListAnnotationsInput): IAgentToolCallResult<IUnitAnnotation[]> {
		return listAnnotations(input, this._kb);
	}

	deleteAnnotation(input: IDeleteAnnotationInput): IAgentToolCallResult<{ deleted: boolean }> {
		return deleteAnnotation(input, this._kb);
	}


	// \u2500\u2500 Work package tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	createWorkPackage(input: ICreateWorkPackageInput): IAgentToolCallResult<IWorkPackageSummary> {
		return createWorkPackage(input, this._kb);
	}

	listWorkPackages(): IAgentToolCallResult<IWorkPackageSummary[]> {
		return listWorkPackages(this._kb);
	}

	getWorkPackage(input: IGetWorkPackageInput): IAgentToolCallResult<IWorkPackageSummary & { unitIds: string[] }> {
		return getWorkPackage(input, this._kb);
	}

	addUnitToWorkPackage(input: IAddUnitToWorkPackageInput): IAgentToolCallResult<{ workPackageId: string; unitId: string }> {
		return addUnitToWorkPackage(input, this._kb);
	}

	removeUnitFromWorkPackage(input: IRemoveUnitFromWorkPackageInput): IAgentToolCallResult<{ workPackageId: string; unitId: string }> {
		return removeUnitFromWorkPackage(input, this._kb);
	}

	deleteWorkPackage(input: IDeleteWorkPackageInput): IAgentToolCallResult<{ deleted: boolean }> {
		return deleteWorkPackage(input, this._kb);
	}


	// \u2500\u2500 Lock tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	lockUnit(input: ILockUnitInput): IAgentToolCallResult<ILockResult | null> {
		return lockUnit(input, this._kb);
	}

	unlockUnit(input: IUnlockUnitInput): IAgentToolCallResult<{ released: boolean }> {
		return unlockUnit(input, this._kb);
	}

	forceUnlockUnit(input: IForceUnlockUnitInput): IAgentToolCallResult<{ released: boolean }> {
		return forceUnlockUnit(input, this._kb);
	}

	listLocks(): IAgentToolCallResult<Array<ILockResult & { unitName: string; isExpired: boolean }>> {
		return listLocks(this._kb);
	}


	// \u2500\u2500 Tag tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	createTag(input: ICreateTagInput): IAgentToolCallResult<IUnitTag> {
		return createTag(input, this._kb);
	}

	listTags(): IAgentToolCallResult<Array<IUnitTag & { unitCount: number }>> {
		return listTags(this._kb);
	}

	addTagToUnit(input: IAddTagToUnitInput): IAgentToolCallResult<{ unitId: string; tagId: string }> {
		return addTagToUnit(input, this._kb);
	}

	removeTagFromUnit(input: IRemoveTagFromUnitInput): IAgentToolCallResult<{ unitId: string; tagId: string }> {
		return removeTagFromUnit(input, this._kb);
	}

	getTagsForUnit(input: IGetTagsForUnitInput): IAgentToolCallResult<IUnitTag[]> {
		return getTagsForUnit(input, this._kb);
	}


	// \u2500\u2500 Compliance tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	checkComplianceGate(input: ICheckComplianceGateInput): IAgentToolCallResult<IComplianceGateResult> {
		return checkComplianceGate(input, this._kb);
	}

	recordComplianceApproval(input: IRecordComplianceApprovalInput): IAgentToolCallResult<{ unitId: string; requirementId: string; approver: string }> {
		return recordComplianceApproval(input, this._kb);
	}

	waiveComplianceRequirement(input: IWaiveComplianceRequirementInput): IAgentToolCallResult<{ unitId: string; requirementId: string; waivedBy: string }> {
		return waiveComplianceRequirement(input, this._kb);
	}

	getComplianceFailures(): IAgentToolCallResult<IComplianceFailureSummary[]> {
		return getComplianceFailures(this._kb);
	}


	// \u2500\u2500 Checkpoint tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	createCheckpoint(input: ICreateCheckpointInput): Promise<IAgentToolCallResult<IKnowledgeBaseCheckpoint>> {
		return createCheckpoint(input, this._kb);
	}

	listCheckpoints(): IAgentToolCallResult<IKnowledgeBaseCheckpoint[]> {
		return listCheckpoints(this._kb);
	}

	restoreCheckpoint(input: IRestoreCheckpointInput): Promise<IAgentToolCallResult<{ restored: boolean; checkpointId: string }>> {
		return restoreCheckpoint(input, this._kb);
	}

	deleteCheckpoint(input: IDeleteCheckpointInput): IAgentToolCallResult<{ deleted: boolean }> {
		return deleteCheckpoint(input, this._kb);
	}


	// \u2500\u2500 Unit management tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	splitUnit(input: ISplitUnitInput): IAgentToolCallResult<ISplitUnitResult> {
		return splitUnit(input, this._kb);
	}

	mergeUnits(input: IMergeUnitsInput): IAgentToolCallResult<IMergeUnitsResult> {
		return mergeUnits(input, this._kb);
	}

	revertUnit(input: IRevertUnitInput): IAgentToolCallResult<{ unitId: string; newStatus: string }> {
		return revertUnit(input, this._kb);
	}


	// \u2500\u2500 Export / Import tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	exportDecisions(): IAgentToolCallResult<IExportDecisionsResult> {
		return exportDecisions(this._kb);
	}

	importDecisions(input: IImportDecisionsInput): IAgentToolCallResult<{ imported: boolean }> {
		return importDecisions(input, this._kb);
	}

	exportKb(): IAgentToolCallResult<IExportKbResult> {
		return exportKb(this._kb);
	}


	// \u2500\u2500 Utility tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	checkExcluded(input: ICheckExcludedInput): IAgentToolCallResult<ICheckExcludedResult> {
		return checkExcluded(input, this._kb);
	}


	// \u2500\u2500 Autonomy tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	autonomyGetBatchStatus(): IAgentToolCallResult<Record<string, unknown>> {
		const m = this._autonomy.lastBatchMetrics;
		return {
			success: true,
			data: {
				batchState:       this._autonomy.batchState,
				isRunning:        this._autonomy.isRunning,
				isPaused:         this._autonomy.isPaused,
				currentRunId:     this._autonomy.currentRunId,
				escalatedCount:   this._autonomy.escalatedUnits.length,
				lastMetrics: m ? {
					runId:          m.runId,
					totalProcessed: m.totalProcessed,
					advanced:       m.advanced,
					escalated:      m.escalated,
					errors:         m.errors,
					skipped:        m.skipped,
					durationMs:     m.durationMs,
					unitsPerMinute: m.unitsPerMinute,
					wasAborted:     m.wasAborted,
					byStage:        m.byStage,
				} : null,
			},
			summary: `Batch state: ${this._autonomy.batchState}. Escalations pending: ${this._autonomy.escalatedUnits.length}.`,
		};
	}

	autonomyPreviewSchedule(input?: IAutonomyPreviewScheduleInput): IAgentToolCallResult<Record<string, unknown>> {
		const options: IAutonomyOptions = {};
		if (input?.stages) {
			const parsed = input.stages.split(',').map(s => s.trim()).filter(s => ALL_AUTONOMY_STAGES.includes(s as never));
			if (parsed.length) { options.stages = parsed as typeof ALL_AUTONOMY_STAGES; }
		}
		if (input?.maxConcurrency !== undefined) { options.maxConcurrency = Math.max(1, Math.min(10, input.maxConcurrency)); }
		if (input?.autoApprove    !== undefined) { options.autoApprove    = input.autoApprove; }

		const preview = this._autonomy.previewSchedule(options);
		return {
			success: true,
			data: {
				totalUnits: preview.totalUnits,
				byStage:    preview.byStage,
				depthGroups: preview.depthGroups.slice(0, 15).map(g => ({
					depth:     g.depth,
					unitCount: g.unitCount,
					units:     g.units.slice(0, 4).map(u => ({ unitId: u.unitId, name: u.unitName, status: u.status, riskLevel: u.riskLevel })),
					hasMore:   g.units.length > 4,
				})),
				hasMoreGroups: preview.depthGroups.length > 15,
			},
			summary: `${preview.totalUnits} units eligible across stages: ${JSON.stringify(preview.byStage)}.`,
		};
	}

	autonomyGetEscalations(input?: IAutonomyGetEscalationsInput): IAgentToolCallResult<Record<string, unknown>> {
		const limit = Math.min(100, Math.max(1, input?.limit ?? 20));
		const all   = this._autonomy.escalatedUnits;
		const now   = Date.now();
		return {
			success: true,
			data: {
				total: all.length,
				items: all.slice(0, limit).map(e => ({
					unitId:    e.unitId,
					unitName:  e.unitName,
					riskLevel: e.riskLevel,
					domain:    e.domain,
					stage:     e.stage,
					reason:    e.reason,
					ageSec:    Math.round((now - e.escalatedAt) / 1000),
				})),
				hasMore: all.length > limit,
			},
			summary: `${all.length} unit(s) awaiting review.`,
		};
	}

	async autonomyResolveEscalation(input: IAutonomyResolveEscalationInput): Promise<IAgentToolCallResult<Record<string, unknown>>> {
		if (!input?.unitId)     { return { success: false, error: 'unitId is required.' }; }
		if (!input?.decision)   { return { success: false, error: 'decision is required (approve | skip | revert-to-pending | block).' }; }
		if (!input?.resolvedBy) { return { success: false, error: 'resolvedBy is required.' }; }

		const validDecisions: EscalationDecision[] = ['approve', 'skip', 'revert-to-pending', 'block'];
		if (!validDecisions.includes(input.decision as EscalationDecision)) {
			return { success: false, error: `Invalid decision "${input.decision}". Must be: ${validDecisions.join(', ')}.` };
		}
		if (!this._autonomy.escalatedUnits.some(e => e.unitId === input.unitId)) {
			return { success: false, error: `Unit "${input.unitId}" is not in the escalation queue.` };
		}
		try {
			await this._autonomy.resolveEscalation(input.unitId, input.decision as EscalationDecision, input.resolvedBy, input.reason);
			return {
				success: true,
				data: { unitId: input.unitId, decision: input.decision, resolvedBy: input.resolvedBy, remainingEscalations: this._autonomy.escalatedUnits.length },
				summary: `Unit "${input.unitId}" resolved as "${input.decision}" by ${input.resolvedBy}.`,
			};
		} catch (e) {
			if (e instanceof MissingEscalationReasonError) {
				return { success: false, error: `A reason is required for the "${input.decision}" decision.` };
			}
			return { success: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	async autonomyRunSingleUnit(input: IAutonomyRunSingleUnitInput): Promise<IAgentToolCallResult<Record<string, unknown>>> {
		if (!input?.unitId) { return { success: false, error: 'unitId is required.' }; }
		try {
			const result = await this._autonomy.runSingleUnit(input.unitId, {
				forceStage:  input.forceStage && ALL_AUTONOMY_STAGES.includes(input.forceStage as never) ? input.forceStage as typeof ALL_AUTONOMY_STAGES[number] : undefined,
				autoApprove: input.autoApprove,
				timeoutMs:   input.timeoutMs !== undefined ? Math.max(5000, input.timeoutMs) : undefined,
			});
			return {
				success: result.outcome !== 'error',
				data: { unitId: result.unitId, unitName: result.unitName, outcome: result.outcome, stageCompleted: result.stageCompleted, durationMs: result.durationMs, errorMsg: result.errorMsg ?? null },
				summary: `Unit "${result.unitName}": ${result.outcome}${result.stageCompleted ? ` (${result.stageCompleted})` : ''}.`,
				...(result.outcome === 'error' ? { error: result.errorMsg ?? 'Unknown error' } : {}),
			};
		} catch (e) {
			return { success: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	autonomyGetRunHistory(input?: IAutonomyGetRunHistoryInput): IAgentToolCallResult<Record<string, unknown>> {
		const limit   = Math.min(20, Math.max(1, input?.limit ?? 10));
		const history = this._autonomy.getRunHistory().slice(0, limit);
		const now     = Date.now();
		return {
			success: true,
			data: {
				total: this._autonomy.getRunHistory().length,
				runs: history.map(r => ({
					runId:          r.runId,
					state:          r.state,
					startedAt:      new Date(r.startedAt).toISOString(),
					ageSec:         Math.round((now - r.startedAt) / 1000),
					totalProcessed: r.metrics.totalProcessed,
					advanced:       r.metrics.advanced,
					escalated:      r.metrics.escalated,
					errors:         r.metrics.errors,
					durationMs:     r.metrics.durationMs,
					wasAborted:     r.metrics.wasAborted,
					byStage:        r.metrics.byStage,
					escalations:    r.escalations.length,
				})),
			},
			summary: `${history.length} run(s) returned (of ${this._autonomy.getRunHistory().length} total).`,
		};
	}

	async autonomyStartBatch(input?: IAutonomyStartBatchInput): Promise<IAgentToolCallResult<Record<string, unknown>>> {
		const options: IAutonomyOptions = {};
		if (input?.stages) {
			const parsed = input.stages.split(',').map(s => s.trim()).filter(s => ALL_AUTONOMY_STAGES.includes(s as never));
			if (parsed.length) { options.stages = parsed as typeof ALL_AUTONOMY_STAGES; }
		}
		if (input?.maxConcurrency   !== undefined) { options.maxConcurrency   = Math.max(1, Math.min(10, input.maxConcurrency)); }
		if (input?.autoApprove      !== undefined) { options.autoApprove      = input.autoApprove; }
		if (input?.stageTimeoutMs   !== undefined) { options.stageTimeoutMs   = Math.max(5000, input.stageTimeoutMs); }
		if (input?.maxRetriesPerUnit !== undefined) { options.maxRetriesPerUnit = Math.max(0, Math.min(5, input.maxRetriesPerUnit)); }
		if (input?.targetLanguage)                 { options.targetLanguage   = input.targetLanguage; }

		try {
			const metrics = await this._autonomy.startBatch(options);
			return {
				success: true,
				data: { runId: metrics.runId, totalProcessed: metrics.totalProcessed, advanced: metrics.advanced, escalated: metrics.escalated, errors: metrics.errors, skipped: metrics.skipped, durationMs: metrics.durationMs, wasAborted: metrics.wasAborted, byStage: metrics.byStage },
				summary: `Batch ${metrics.runId} completed. Advanced: ${metrics.advanced}, Escalated: ${metrics.escalated}, Errors: ${metrics.errors}.`,
			};
		} catch (e) {
			if (e instanceof AutonomyBatchAlreadyRunningError) {
				return { success: false, error: `Batch already running (runId: ${this._autonomy.currentRunId}). Pause or stop it first.` };
			}
			return { success: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	autonomyPauseBatch(): IAgentToolCallResult<Record<string, unknown>> {
		if (!this._autonomy.isRunning) {
			return { success: false, error: `No batch is running. Current state: ${this._autonomy.batchState}.` };
		}
		this._autonomy.pauseBatch();
		return { success: true, data: { batchState: this._autonomy.batchState }, summary: 'Pause signal sent \u2014 in-flight jobs are draining.' };
	}

	async autonomyResumeBatch(): Promise<IAgentToolCallResult<Record<string, unknown>>> {
		if (!this._autonomy.isPaused) {
			return { success: false, error: `No paused batch to resume. Current state: ${this._autonomy.batchState}.` };
		}
		try {
			const metrics = await this._autonomy.resumeBatch();
			return {
				success: true,
				data: { runId: metrics.runId, totalProcessed: metrics.totalProcessed, advanced: metrics.advanced, escalated: metrics.escalated, errors: metrics.errors, durationMs: metrics.durationMs, wasAborted: metrics.wasAborted },
				summary: `Resumed batch ${metrics.runId} completed. Advanced: ${metrics.advanced}, Escalated: ${metrics.escalated}.`,
			};
		} catch (e) {
			if (e instanceof AutonomyBatchAlreadyRunningError) {
				return { success: false, error: `Batch already running (runId: ${this._autonomy.currentRunId}).` };
			}
			if (e instanceof NoPausedBatchError) {
				return { success: false, error: 'No paused batch available.' };
			}
			return { success: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	autonomyStopBatch(): IAgentToolCallResult<Record<string, unknown>> {
		if (!this._autonomy.isRunning && this._autonomy.batchState !== 'pausing' && this._autonomy.batchState !== 'stopping') {
			return { success: false, error: `No active batch to stop. Current state: ${this._autonomy.batchState}.` };
		}
		this._autonomy.stopBatch();
		return { success: true, data: { batchState: this._autonomy.batchState }, summary: 'Stop signal sent \u2014 in-flight jobs are draining.' };
	}
}
