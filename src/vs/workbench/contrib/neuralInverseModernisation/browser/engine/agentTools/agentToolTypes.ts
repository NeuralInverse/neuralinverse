/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Modernisation Agent Tool Types
 *
 * All input parameter types, output/result types, and the MCP tool definition schema
 * used by the 67 agent tools.
 *
 * These tools serve two audiences:
 *
 * 1. **Modernisation projects** — the AI translation agent reads units, records
 *    translations, answers blocking decisions, and tracks progress across a full
 *    COBOL/PL/SQL/RPG → Java/TypeScript/Python migration.
 *
 * 2. **Individual projects** — any codebase parsed into a knowledge base can use
 *    these tools to query discovered business rules, track architectural decisions,
 *    maintain a domain glossary, or answer questions about code structure.
 *
 * ## Tool Categories
 *
 * | Category         | Tools |
 * |------------------|-------|
 * | Unit read        | get_unit, list_units, get_next_unit, get_unit_context, search_units, get_unit_history |
 * | Dependency       | get_unit_dependencies, get_impact_chain, get_dependency_tree, get_topological_order |
 * | Advanced query   | filter_units, get_stale_units |
 * | Decision read    | get_pending_decisions, get_decision, get_decision_log, detect_conflicts, get_decision_impact |
 * | Decision write   | answer_decision, resolve_conflict, remove_decision |
 * | Translation      | record_translation, flag_blocked, flag_ready |
 * | Annotation       | add_annotation, update_annotation, list_annotations, delete_annotation |
 * | Type/naming      | record_type_mapping, record_naming_decision, record_rule_interpretation |
 * | Glossary         | get_glossary, add_glossary_term, get_business_rules, get_domains |
 * | Workspace        | get_progress, get_workspace_summary, run_health_check, check_source_drift |
 * | Phases           | get_phases, get_units_by_phase |
 * | Work packages    | create_work_package, list_work_packages, get_work_package, add_unit_to_work_package, remove_unit_from_work_package, delete_work_package |
 * | Locks            | lock_unit, unlock_unit, force_unlock_unit, list_locks |
 * | Tags             | create_tag, list_tags, add_tag_to_unit, remove_tag_from_unit, get_tags_for_unit |
 * | Compliance       | check_compliance_gate, record_compliance_approval, get_compliance_failures |
 * | Checkpoints      | create_checkpoint, list_checkpoints, restore_checkpoint, delete_checkpoint |
 * | Unit management  | split_unit, merge_units, revert_unit |
 * | Export / Import  | export_decisions, import_decisions, export_kb |
 * | Utility          | check_excluded |
 */


// ─── Tool schema types (MCP-compatible) ───────────────────────────────────────

export interface IAgentToolDefinition {
	/** Unique tool name (snake_case) */
	name: string;
	/** Description shown to the LLM so it knows when and how to use this tool */
	description: string;
	/** JSON Schema for the input object */
	inputSchema: IAgentToolInputSchema;
}

export interface IAgentToolInputSchema {
	type: 'object';
	properties: Record<string, IAgentToolProperty>;
	required?: string[];
}

export type IAgentToolPropertyType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface IAgentToolProperty {
	type: IAgentToolPropertyType;
	description: string;
	enum?: string[];
	items?: { type: IAgentToolPropertyType; enum?: string[] };
	properties?: Record<string, IAgentToolProperty>;
}

/** Wrapper returned by every typed service method */
export interface IAgentToolCallResult<T = unknown> {
	success: boolean;
	data?: T;
	error?: string;
	/** Optional human-readable summary for logging/display */
	summary?: string;
}


// ─── Tool input types ─────────────────────────────────────────────────────────

// ── Unit tools ────────────────────────────────────────────────────────────────

export interface IGetUnitInput {
	/** Unit ID (preferred) */
	unitId?: string;
	/** Unit name (used if unitId not provided) */
	unitName?: string;
}

export interface IListUnitsInput {
	/** Filter by unit status */
	status?: string;
	/** Filter by risk level */
	riskLevel?: string;
	/** Filter by source language (e.g. 'cobol', 'java') */
	language?: string;
	/** Filter by business domain */
	domain?: string;
	/** Filter by source file path (exact or partial) */
	filePath?: string;
	/** Filter by tag ID */
	tagId?: string;
	/** Filter by work package ID */
	workPackageId?: string;
	/** Max results to return (default 50) */
	limit?: number;
	/** Result offset for pagination (default 0) */
	offset?: number;
}

export interface IGetNextUnitInput {
	/** Prefer units at or above this risk level */
	riskLevel?: string;
	/** Prefer units in this business domain */
	domain?: string;
	/** Prefer units of this source language */
	language?: string;
}

export interface IGetUnitContextInput {
	unitId: string;
	/** Max tokens for assembled context (default 12000) */
	maxTokens?: number;
	/** Include the full formatted context string in the response */
	includeFullContext?: boolean;
}

export interface IGetUnitDependenciesInput {
	unitId: string;
	/** 'dependsOn' | 'usedBy' | 'both' (default 'both') */
	direction?: 'dependsOn' | 'usedBy' | 'both';
	/** Follow transitive edges (default false) */
	transitive?: boolean;
}

export interface IGetImpactChainInput {
	unitId: string;
}

export interface ISearchUnitsInput {
	/** Search query — matched against unit name, domain, source preview, file path */
	query: string;
	/** Max results (default 20) */
	limit?: number;
}

export interface IGetUnitHistoryInput {
	unitId: string;
	/** Max audit entries to return (default 20) */
	limit?: number;
}


// ── Decision tools ────────────────────────────────────────────────────────────

export interface IGetPendingDecisionsInput {
	/** Filter to a specific unit */
	unitId?: string;
	/** Filter by priority: 'low' | 'medium' | 'high' | 'blocking' */
	priority?: string;
	/** Filter by type: 'type-mapping' | 'naming' | 'rule-interpretation' | 'approval' | 'exclusion' */
	type?: string;
}

export interface IGetDecisionInput {
	decisionId: string;
}

export interface IAnswerDecisionInput {
	decisionId: string;
	/**
	 * The human's answer. Semantics depend on the decision type:
	 * - type-mapping:        "<sourceType> -> <targetType>"
	 * - naming:              "<sourceName> -> <targetName>"
	 * - rule-interpretation: free text explaining the intended meaning
	 * - approval:            "approved" | "rejected" | any confirmation text
	 * - exclusion:           "exclude" | "include"
	 */
	answer: string;
	/** Human actor ID (defaults to 'human') */
	actor?: string;
	/** Optional notes explaining the reasoning behind this answer */
	answerNotes?: string;
}

export interface IGetDecisionLogInput {
	/** Filter by decision type */
	type?: 'type-mapping' | 'naming' | 'rule-interpretation' | 'exclusion' | 'pattern-override';
	/** Filter to decisions that apply to this unit */
	unitId?: string;
}

export interface IGetDecisionImpactInput {
	decisionId: string;
	/** 'type-mapping' | 'naming' | 'rule-interpretation' | 'exclusion' | 'pattern-override' */
	decisionType: string;
}


// ── Translation/record tools ──────────────────────────────────────────────────

export interface IRecordTranslationInput {
	unitId: string;
	/** The translated code produced by the AI */
	translatedCode: string;
	/** Target file path where the code should be written */
	targetFile: string;
	/** AI's confidence: 'high' | 'medium' | 'low' | 'uncertain' */
	confidence: string;
	/** AI's narrative reasoning about key translation decisions */
	reasoning: string;
	/** Translation outcome: 'translated' | 'partial' | 'blocked' | 'error' */
	outcome: string;
	/** Actor ID (defaults to 'ai') */
	actor?: string;
}

export interface IFlagBlockedInput {
	unitId: string;
	/** Human-readable reason why this unit is blocked */
	reason: string;
	/** Type of blocking decision: 'type-mapping' | 'naming' | 'rule-interpretation' | 'approval' | 'exclusion' */
	decisionType?: string;
	/** The specific question that must be answered to unblock */
	decisionQuestion?: string;
	/** Why the AI cannot decide alone */
	decisionContext?: string;
	/** Suggested answer options for the human */
	decisionOptions?: string[];
	/** Priority of the blocking decision (default 'blocking') */
	decisionPriority?: string;
}

export interface IFlagReadyInput {
	unitId: string;
	/** Why the unit is being moved back to ready (for audit log) */
	reason?: string;
	/** Actor performing the action (defaults to 'human') */
	actor?: string;
}


// ── Annotation tools ──────────────────────────────────────────────────────────

export interface IAddAnnotationInput {
	unitId: string;
	/** Annotation text content */
	content: string;
	/** Author identifier (defaults to 'agent') */
	author?: string;
	/** Annotation kind: 'context-injection' | 'reviewer-note' | 'warning' | 'decision-note' */
	kind?: string;
}

export interface IUpdateAnnotationInput {
	annotationId: string;
	content: string;
}


// ── Decision recording tools ──────────────────────────────────────────────────

export interface IRecordTypeMappingInput {
	/** Source language type (e.g. 'PIC S9(9)V99 COMP-3') */
	sourceType: string;
	/** Target language type (e.g. 'BigDecimal') */
	targetType: string;
	/** Rationale for this mapping */
	rationale?: string;
	/** Scope: 'global' (all units) | 'domain' | 'unit' */
	scope?: string;
	/** Domain or unit ID this mapping applies to (when scope is not global) */
	appliesTo?: string;
}

export interface IRecordNamingDecisionInput {
	/** Source identifier (e.g. 'WS-ACCT-BAL') */
	sourceName: string;
	/** Target identifier (e.g. 'accountBalance') */
	targetName: string;
	/** Business domain this naming applies to */
	domain?: string;
}

export interface IRecordRuleInterpretationInput {
	/** ID of the rule (business rule ID or a descriptive slug) */
	ruleId: string;
	/** Plain-English meaning/interpretation */
	meaning: string;
	/** Source text from the code that triggered this interpretation */
	sourceText?: string;
}


// ── Glossary tools ────────────────────────────────────────────────────────────

export interface IGetGlossaryInput {
	/** Filter by domain */
	domain?: string;
	/** Substring search in term or meaning */
	search?: string;
	/** Max results (default 50) */
	limit?: number;
}

export interface IAddGlossaryTermInput {
	/** The term as it appears in the source code (e.g. 'CUSTMAST', 'CALC-LATE-FEE') */
	term: string;
	/** Plain-English meaning */
	meaning: string;
	/** Business domain */
	domain?: string;
	/** Example usages */
	examples?: string[];
	/** Related terms */
	relatedTerms?: string[];
}

export interface IGetBusinessRulesInput {
	/** Filter to a specific unit */
	unitId?: string;
	/** Filter to a business domain */
	domain?: string;
	/** If true, only return rules where preservationRequired = true */
	preservationRequired?: boolean;
	/** Max results (default 50) */
	limit?: number;
}


// ── Workspace/progress tools ──────────────────────────────────────────────────

export interface IGetProgressInput {
	/** Include velocity metrics (units/day, ETA) */
	includeVelocity?: boolean;
	/** Include per-phase progress breakdown */
	includePhases?: boolean;
}

export interface IGetWorkspaceSummaryInput {
	/** Include breakdown by source language */
	includeLanguageBreakdown?: boolean;
	/** Include breakdown by business domain */
	includeDomainBreakdown?: boolean;
	/** Include breakdown by risk level */
	includeRiskBreakdown?: boolean;
}

export interface ICheckSourceDriftInput {
	/** File path to check. If omitted, check all tracked source files. */
	filePath?: string;
}


// ─── Tool output types ────────────────────────────────────────────────────────

/** Compact unit representation returned by most list/query tools */
export interface IUnitSummary {
	id: string;
	name: string;
	unitType: string;
	sourceLang: string;
	status: string;
	riskLevel: string;
	domain?: string;
	sourceFile: string;
	dependsOnCount: number;
	usedByCount: number;
	businessRuleCount: number;
	pendingDecisionId?: string;
	blockedReason?: string;
	hasTranslation: boolean;
	hasInterface: boolean;
	hasFingerprint: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface IUnitContextResult {
	unitId: string;
	unitName: string;
	sourceLang: string;
	targetLang?: string;
	resolvedSourcePreview: string;
	resolvedSourceLength: number;
	estimatedTokens: number;
	calledInterfaceCount: number;
	typeMappingDecisionCount: number;
	namingDecisionCount: number;
	ruleInterpretationCount: number;
	businessRuleCount: number;
	glossaryTermCount: number;
	annotationCount: number;
	/** Full assembled context string — only present when includeFullContext=true */
	fullContext?: string;
}

export interface IDependencyResult {
	unitId: string;
	unitName: string;
	dependsOn: IUnitSummary[];
	usedBy: IUnitSummary[];
	transitiveDependsOnCount: number;
	transitiveUsedByCount: number;
	hasCycle: boolean;
}

export interface IProgressResult {
	totalUnits: number;
	byStatus: Record<string, number>;
	byRisk: Record<string, number>;
	percentComplete: number;
	pendingDecisionCount: number;
	blockedUnitCount: number;
	velocity?: IVelocityResult;
	phases?: IPhaseResult[];
}

export interface IVelocityResult {
	unitsPerDay: number;
	rollingAvgUnitsPerDay: number;
	estimatedDaysToComplete: number | null;
	estimatedCompletionDate: string | null;
}

export interface IPhaseResult {
	phaseId: string;
	label: string;
	totalUnits: number;
	completedUnits: number;
	blockedUnits: number;
	percentComplete: number;
}

export interface IWorkspaceSummaryResult {
	totalUnits: number;
	totalFiles: number;
	totalDecisions: number;
	totalGlossaryTerms: number;
	totalBusinessRules: number;
	totalAnnotations: number;
	pendingDecisionCount: number;
	blockedUnitCount: number;
	conflictCount: number;
	driftAlertCount: number;
	languageBreakdown?: Array<{ language: string; count: number }>;
	domainBreakdown?: Array<{ domain: string; count: number }>;
	riskBreakdown?: Array<{ risk: string; count: number }>;
	healthStatus: 'healthy' | 'warnings' | 'critical';
	healthIssues: string[];
}

export interface IAnswerDecisionResult {
	decisionId: string;
	decisionType: string;
	resolved: boolean;
	/** Whether a new decision record (type mapping, naming, etc.) was created */
	recordCreated: boolean;
	/** ID of the new decision record, if any */
	recordId?: string;
	unitUnblocked: boolean;
}

export interface IRecordTranslationResult {
	unitId: string;
	newStatus: string;
	targetFile: string;
	confidence: string;
	outcome: string;
}

export interface IFlagBlockedResult {
	unitId: string;
	newStatus: string;
	decisionId: string;
}


// ─── Work package tool types ──────────────────────────────────────────────────

export interface ICreateWorkPackageInput {
	/** Short display name for the work package (e.g. 'Sprint 3 – Billing') */
	label: string;
	/** Longer description of what this work package covers */
	description: string;
	/** Unit IDs to include in the package upfront (can add more later) */
	unitIds?: string[];
	/** Team member or agent ID responsible for this package */
	assignedTo?: string;
	/** Due date as ISO-8601 date string (e.g. '2025-04-30') or Unix ms timestamp */
	dueDate?: string | number;
	/** Creator identifier (defaults to 'agent') */
	createdBy?: string;
}

export interface IGetWorkPackageInput {
	workPackageId: string;
}

export interface IAddUnitToWorkPackageInput {
	workPackageId: string;
	unitId: string;
}

export interface IRemoveUnitFromWorkPackageInput {
	workPackageId: string;
	unitId: string;
}

export interface IDeleteWorkPackageInput {
	workPackageId: string;
}

export interface IWorkPackageSummary {
	id: string;
	label: string;
	description: string;
	unitCount: number;
	assignedTo?: string;
	dueDate?: number;
	completedAt?: number;
	createdAt: number;
	createdBy: string;
}


// ─── Lock tool types ──────────────────────────────────────────────────────────

export interface ILockUnitInput {
	unitId: string;
	/** Owner identifier (e.g. agent ID, user ID, thread ID) */
	ownerId: string;
	/** Lock TTL in milliseconds (default 300000 = 5 min; 0 = indefinite) */
	ttlMs?: number;
}

export interface IUnlockUnitInput {
	unitId: string;
	/** Must match the ownerId used to acquire the lock */
	ownerId: string;
}

export interface IForceUnlockUnitInput {
	unitId: string;
}

export interface ILockResult {
	unitId: string;
	lockId: string;
	ownerId: string;
	acquiredAt: number;
	ttlMs: number;
	expiresAt: number | null;
}


// ─── Tag tool types ───────────────────────────────────────────────────────────

export interface ICreateTagInput {
	/** Short display name (e.g. 'sprint-1', 'team-alpha', 'priority-fix') */
	name: string;
	/** Hex color for UI display (e.g. '#e0a84e') */
	color?: string;
}

export interface IAddTagToUnitInput {
	unitId: string;
	tagId: string;
}

export interface IRemoveTagFromUnitInput {
	unitId: string;
	tagId: string;
}

export interface IGetTagsForUnitInput {
	unitId: string;
}


// ─── Compliance tool types ────────────────────────────────────────────────────

export interface ICheckComplianceGateInput {
	unitId: string;
}

export interface IRecordComplianceApprovalInput {
	unitId: string;
	/** Requirement ID as returned by check_compliance_gate */
	requirementId: string;
	/** Approver identity (user ID, auditor name, etc.) */
	approver: string;
	/** Supporting evidence (document reference, note, link) */
	evidence?: string;
}

export interface IWaiveComplianceRequirementInput {
	unitId: string;
	requirementId: string;
	waivedBy: string;
	reason: string;
}

export interface IComplianceFailureSummary {
	unitId: string;
	unitName: string;
	overallStatus: string;
	failedCount: number;
	passedCount: number;
	pendingCount: number;
	waivedCount: number;
	blockerReasons: string[];
	evaluatedAt: number;
}


// ─── Checkpoint tool types ────────────────────────────────────────────────────

export interface ICreateCheckpointInput {
	/** Human-readable label (e.g. 'Before Phase 2 re-scan') */
	label: string;
	/** Who triggered this checkpoint (user ID, agent ID, or 'auto') */
	triggeredBy?: string;
}

export interface IRestoreCheckpointInput {
	checkpointId: string;
}

export interface IDeleteCheckpointInput {
	checkpointId: string;
}


// ─── Unit management tool types ───────────────────────────────────────────────

export interface ISubUnitDescriptor {
	/** Name for the new sub-unit */
	name: string;
	/** Source code slice that belongs to this sub-unit */
	sourceText: string;
	/** Override risk level (inherits from parent if omitted) */
	riskLevel?: string;
	/** Override domain (inherits from parent if omitted) */
	domain?: string;
	/** Override phase ID (inherits from parent if omitted) */
	phaseId?: string;
}

export interface ISplitUnitInput {
	/** Parent unit ID to split */
	unitId: string;
	/** Sub-unit descriptors — minimum 2, maximum 20 */
	subUnits: ISubUnitDescriptor[];
	/** Reason for splitting (written to audit log) */
	reason?: string;
}

export interface ISplitUnitResult {
	parentUnitId: string;
	newUnitIds: string[];
	subUnitCount: number;
}

export interface IMergeUnitsInput {
	/** IDs of units to merge (minimum 2) */
	unitIds: string[];
	/** Name for the merged unit */
	name: string;
	/** Override risk level (defaults to max of merged units) */
	riskLevel?: string;
	/** Override domain */
	domain?: string;
	/** Reason for merging (written to audit log) */
	reason?: string;
}

export interface IMergeUnitsResult {
	mergedUnitId: string;
	sourceUnitIds: string[];
}

export interface IRevertUnitInput {
	unitId: string;
	/** Reason for reverting (e.g. 'Reviewer rejected translation') */
	reason: string;
	/** Actor performing the revert (defaults to 'human') */
	actor?: string;
}


// ─── Advanced query tool types ────────────────────────────────────────────────

export interface IGetStaleUnitsInput {
	/**
	 * How long a unit must be stuck before it's considered stale (milliseconds).
	 * Default: 86400000 (24 hours)
	 */
	thresholdMs?: number;
}

export interface IFilterUnitsInput {
	/** Filter by one or more statuses */
	status?: string[];
	/** Filter by one or more risk levels */
	risk?: string[];
	/** Filter by source language */
	language?: string;
	/** Filter by business domain */
	domain?: string;
	/** Substring match against source file path */
	filePattern?: string;
	/** Only units with this tag ID */
	tagId?: string;
	/** Only units that are NOT locked */
	unlockedOnly?: boolean;
	/** Only units whose source file has drifted */
	driftedOnly?: boolean;
	/** Only units in this work package */
	workPackageId?: string;
	/** Max results (default 50) */
	limit?: number;
	/** Pagination offset (default 0) */
	offset?: number;
}

export interface IGetDependencyTreeInput {
	unitId: string;
	/** Maximum recursion depth (default 5) */
	maxDepth?: number;
}

export interface IDependencyTreeNode {
	unitId: string;
	unitName: string;
	status: string;
	isTranslated: boolean;
	depth: number;
	dependsOn: IDependencyTreeNode[];
}


// ─── Decision management tool types ──────────────────────────────────────────

export interface IResolveConflictInput {
	conflictId: string;
	/** ID of the decision that should be canonical going forward */
	winningDecisionId: string;
	/** Actor performing the resolution (defaults to 'human') */
	actor?: string;
}

export interface IRemoveDecisionInput {
	decisionId: string;
	/** 'type-mapping' | 'naming' | 'rule-interpretation' | 'exclusion' | 'pattern-override' */
	decisionType: string;
}


// ─── Extended annotation tool types ──────────────────────────────────────────

export interface IListAnnotationsInput {
	unitId: string;
}

export interface IDeleteAnnotationInput {
	annotationId: string;
}


// ─── Phase tool types ─────────────────────────────────────────────────────────

export interface IGetUnitsByPhaseInput {
	phaseId: string;
	/** Max results (default 50) */
	limit?: number;
	/** Pagination offset (default 0) */
	offset?: number;
}

export interface IPhaseDetailResult {
	phaseId: string;
	label: string;
	totalUnits: number;
	completedUnits: number;
	blockedUnits: number;
	percentComplete: number;
}


// ─── Export/Import tool types ─────────────────────────────────────────────────

export interface IImportDecisionsInput {
	/** JSON string produced by export_decisions */
	decisionsJson: string;
}

export interface IExportDecisionsResult {
	json: string;
	typeMappingCount: number;
	namingCount: number;
	ruleInterpretationCount: number;
	exclusionCount: number;
	patternOverrideCount: number;
}

export interface IExportKbResult {
	json: string;
	totalUnits: number;
	totalFiles: number;
	sizeBytes: number;
}


// ─── Utility tool types ───────────────────────────────────────────────────────

export interface ICheckExcludedInput {
	/** File path to test against exclusion rules */
	filePath: string;
	/** Optional unit name to also test */
	unitName?: string;
}

export interface ICheckExcludedResult {
	filePath: string;
	unitName?: string;
	isExcluded: boolean;
}
