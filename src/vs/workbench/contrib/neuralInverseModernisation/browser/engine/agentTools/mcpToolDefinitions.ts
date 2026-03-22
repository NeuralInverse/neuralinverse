/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCP-compatible tool definitions for all 67 agent tools.
 *
 * Passed directly to sendLLMMessage({ mcpTools: getAllToolDefinitions() })
 * so the LLM knows when and how to call each tool.
 */

import { IAgentToolDefinition } from './agentToolTypes.js';

export const MCP_TOOL_DEFINITIONS: IAgentToolDefinition[] = [

	// ── Unit read tools ──────────────────────────────────────────────────────

	{
		name: 'get_unit',
		description: 'Get a single knowledge unit by ID or name. Returns status, risk level, dependency counts, and translation state.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId:   { type: 'string', description: 'Unit ID (preferred)' },
				unitName: { type: 'string', description: 'Unit name (used if unitId not provided)' },
			},
		},
	},

	{
		name: 'list_units',
		description: 'List knowledge units with optional filters. Supports pagination. Use to find units by status, risk, language, domain, or file path.',
		inputSchema: {
			type: 'object',
			properties: {
				status:        { type: 'string', description: 'Filter by status: pending, ready, blocked, translated, approved, complete, error, skipped' },
				riskLevel:     { type: 'string', description: 'Filter by risk: critical, high, medium, low' },
				language:      { type: 'string', description: 'Filter by source language (e.g. cobol, java, python)' },
				domain:        { type: 'string', description: 'Filter by business domain' },
				filePath:      { type: 'string', description: 'Filter by source file path (substring match)' },
				tagId:         { type: 'string', description: 'Filter by tag ID' },
				workPackageId: { type: 'string', description: 'Filter by work package ID' },
				limit:         { type: 'number', description: 'Max results (default 50)' },
				offset:        { type: 'number', description: 'Pagination offset (default 0)' },
			},
		},
	},

	{
		name: 'get_next_unit',
		description: 'Get the highest-priority unit ready for translation. Returns null when the queue is empty. Use at the start of each translation loop iteration.',
		inputSchema: {
			type: 'object',
			properties: {
				riskLevel: { type: 'string', description: 'Prefer units at or above this risk level' },
				domain:    { type: 'string', description: 'Prefer units in this business domain' },
				language:  { type: 'string', description: 'Prefer units of this source language' },
			},
		},
	},

	{
		name: 'get_unit_context',
		description: 'Get the fully assembled translation context for a unit, including type mappings, naming decisions, business rules, glossary terms, and interface stubs. This is the primary input for any translation prompt.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId:             { type: 'string', description: 'Unit to fetch context for' },
				maxTokens:          { type: 'number', description: 'Token budget for assembled context (default 12000)' },
				includeFullContext: { type: 'boolean', description: 'Include full formatted context string (adds significant tokens)' },
			},
			required: ['unitId'],
		},
	},

	{
		name: 'get_unit_dependencies',
		description: 'Get a unit\'s dependency graph — what it calls (dependsOn) and what calls it (usedBy). Supports transitive traversal and cycle detection.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId:     { type: 'string', description: 'Unit to query' },
				direction:  { type: 'string', enum: ['dependsOn', 'usedBy', 'both'], description: 'Which edges to follow (default both)' },
				transitive: { type: 'boolean', description: 'Follow transitive edges (default false)' },
			},
			required: ['unitId'],
		},
	},

	{
		name: 'get_impact_chain',
		description: 'Get all downstream units that will be affected if this unit changes. Use before making a translation decision that might break callers.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId: { type: 'string', description: 'Unit whose impact to calculate' },
			},
			required: ['unitId'],
		},
	},

	{
		name: 'search_units',
		description: 'Full-text search across all units — matches against unit name, domain, source preview, and file path.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Search query' },
				limit: { type: 'number', description: 'Max results (default 20)' },
			},
			required: ['query'],
		},
	},

	{
		name: 'get_unit_history',
		description: 'Get the audit trail for a specific unit — all status transitions, translations recorded, decisions answered, and annotations added.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId: { type: 'string', description: 'Unit to fetch history for' },
				limit:  { type: 'number', description: 'Max audit entries (default 20)' },
			},
			required: ['unitId'],
		},
	},


	// ── Decision read tools ──────────────────────────────────────────────────

	{
		name: 'get_pending_decisions',
		description: 'List pending decisions that are waiting for a human answer. Blocking decisions must be resolved before the affected unit can be translated.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId:   { type: 'string', description: 'Filter to decisions for a specific unit' },
				priority: { type: 'string', enum: ['low', 'medium', 'high', 'blocking'], description: 'Filter by priority' },
				type:     { type: 'string', enum: ['type-mapping', 'naming', 'rule-interpretation', 'approval', 'exclusion'], description: 'Filter by decision type' },
			},
		},
	},

	{
		name: 'get_decision',
		description: 'Get a specific pending decision by ID, including the question, context, and suggested options.',
		inputSchema: {
			type: 'object',
			properties: {
				decisionId: { type: 'string', description: 'Decision ID' },
			},
			required: ['decisionId'],
		},
	},

	{
		name: 'get_decision_log',
		description: 'View the log of already-answered decisions — type mappings, naming decisions, rule interpretations, exclusions, and pattern overrides.',
		inputSchema: {
			type: 'object',
			properties: {
				type:   { type: 'string', enum: ['type-mapping', 'naming', 'rule-interpretation', 'exclusion', 'pattern-override'], description: 'Filter by type' },
				unitId: { type: 'string', description: 'Filter to decisions that apply to this unit' },
			},
		},
	},

	{
		name: 'detect_conflicts',
		description: 'Find conflicting decisions — cases where the same source type or identifier has been mapped to two different targets. Use before starting a translation batch.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
	},

	{
		name: 'get_decision_impact',
		description: 'Compute which units would be affected if a specific decision were changed or removed.',
		inputSchema: {
			type: 'object',
			properties: {
				decisionId:   { type: 'string', description: 'Decision record ID' },
				decisionType: { type: 'string', description: 'Decision type: type-mapping, naming, rule-interpretation, exclusion, pattern-override' },
			},
			required: ['decisionId', 'decisionType'],
		},
	},


	// ── Decision write tool ──────────────────────────────────────────────────

	{
		name: 'answer_decision',
		description: 'Answer a pending decision. Creates the appropriate knowledge record (type mapping, naming decision, etc.) and unblocks the unit. Answer format depends on decision type: type-mapping and naming use "Source -> Target" syntax; rule-interpretation uses free text; approval uses "approved" or "rejected"; exclusion uses "exclude" or "include".',
		inputSchema: {
			type: 'object',
			properties: {
				decisionId:  { type: 'string', description: 'Pending decision ID to answer' },
				answer:      { type: 'string', description: 'The answer (format depends on decision type)' },
				actor:       { type: 'string', description: 'Actor ID (defaults to "human")' },
				answerNotes: { type: 'string', description: 'Optional notes explaining the reasoning' },
			},
			required: ['decisionId', 'answer'],
		},
	},


	// ── Translation write tools ──────────────────────────────────────────────

	{
		name: 'record_translation',
		description: 'Record a completed AI translation for a unit. Sets the unit status based on the outcome. Always include your reasoning for key translation decisions.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId:         { type: 'string', description: 'Unit being translated' },
				translatedCode: { type: 'string', description: 'The translated code output' },
				targetFile:     { type: 'string', description: 'Target file path where the code should be written' },
				confidence:     { type: 'string', enum: ['high', 'medium', 'low', 'uncertain'], description: 'AI confidence in the translation' },
				reasoning:      { type: 'string', description: 'AI narrative reasoning about key translation decisions' },
				outcome:        { type: 'string', enum: ['translated', 'partial', 'blocked', 'error'], description: 'Translation outcome' },
				actor:          { type: 'string', description: 'Actor ID (defaults to "ai")' },
			},
			required: ['unitId', 'translatedCode', 'targetFile', 'confidence', 'reasoning', 'outcome'],
		},
	},

	{
		name: 'flag_blocked',
		description: 'Block a unit because a human decision is required before translation can proceed. Creates a pending decision that the human must answer to unblock the unit.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId:           { type: 'string', description: 'Unit to block' },
				reason:           { type: 'string', description: 'Human-readable reason why this unit is blocked' },
				decisionType:     { type: 'string', enum: ['type-mapping', 'naming', 'rule-interpretation', 'approval', 'exclusion'], description: 'Type of blocking decision' },
				decisionQuestion: { type: 'string', description: 'The specific question that must be answered to unblock' },
				decisionContext:  { type: 'string', description: 'Why the AI cannot decide alone' },
				decisionOptions:  { type: 'array', items: { type: 'string' }, description: 'Suggested answer options for the human' },
				decisionPriority: { type: 'string', enum: ['low', 'medium', 'high', 'blocking'], description: 'Priority of the blocking decision (default blocking)' },
			},
			required: ['unitId', 'reason'],
		},
	},

	{
		name: 'flag_ready',
		description: 'Unblock a unit — move it back to "ready" so it can be re-translated. Use after a blocking decision has been answered.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId: { type: 'string', description: 'Unit to unblock' },
				reason: { type: 'string', description: 'Why the unit is being moved back to ready' },
				actor:  { type: 'string', description: 'Actor performing the action (defaults to "human")' },
			},
			required: ['unitId'],
		},
	},


	// ── Annotation tools ─────────────────────────────────────────────────────

	{
		name: 'add_annotation',
		description: 'Attach a note or comment to a unit. Use to record context that should be considered in future translations, reviewer notes, or warnings.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId:  { type: 'string', description: 'Unit to annotate' },
				content: { type: 'string', description: 'Annotation text content' },
				author:  { type: 'string', description: 'Author identifier (defaults to "agent")' },
				kind:    { type: 'string', enum: ['context-injection', 'reviewer-note', 'warning', 'decision-note'], description: 'Annotation kind' },
			},
			required: ['unitId', 'content'],
		},
	},

	{
		name: 'update_annotation',
		description: 'Update the text of an existing annotation.',
		inputSchema: {
			type: 'object',
			properties: {
				annotationId: { type: 'string', description: 'Annotation ID to update' },
				content:      { type: 'string', description: 'New annotation text' },
			},
			required: ['annotationId', 'content'],
		},
	},


	// ── Decision record tools ────────────────────────────────────────────────

	{
		name: 'record_type_mapping',
		description: 'Record a type mapping decision that applies to future translations. Use when you\'ve determined the correct target type for a source language type (e.g. "PIC S9(9)V99 COMP-3" → "BigDecimal").',
		inputSchema: {
			type: 'object',
			properties: {
				sourceType: { type: 'string', description: 'Source language type' },
				targetType: { type: 'string', description: 'Target language type' },
				rationale:  { type: 'string', description: 'Rationale for this mapping' },
				scope:      { type: 'string', enum: ['global', 'domain', 'unit'], description: 'Scope of the mapping (default global)' },
				appliesTo:  { type: 'string', description: 'Domain or unit ID when scope is not global' },
			},
			required: ['sourceType', 'targetType'],
		},
	},

	{
		name: 'record_naming_decision',
		description: 'Record a naming decision (source identifier → target identifier). Use when renaming legacy identifiers to idiomatic target-language names.',
		inputSchema: {
			type: 'object',
			properties: {
				sourceName: { type: 'string', description: 'Source identifier (e.g. WS-ACCT-BAL)' },
				targetName: { type: 'string', description: 'Target identifier (e.g. accountBalance)' },
				domain:     { type: 'string', description: 'Business domain this naming applies to' },
			},
			required: ['sourceName', 'targetName'],
		},
	},

	{
		name: 'record_rule_interpretation',
		description: 'Record a rule interpretation — what a business rule or piece of legacy logic means in plain English. Use to document complex business logic so future translations handle it consistently.',
		inputSchema: {
			type: 'object',
			properties: {
				ruleId:     { type: 'string', description: 'Rule ID or descriptive slug' },
				meaning:    { type: 'string', description: 'Plain-English meaning/interpretation' },
				sourceText: { type: 'string', description: 'Source code text that triggered this interpretation' },
			},
			required: ['ruleId', 'meaning'],
		},
	},


	// ── Glossary tools ───────────────────────────────────────────────────────

	{
		name: 'get_glossary',
		description: 'Get domain glossary terms. Use to look up the meaning of legacy business terms before translating code that references them.',
		inputSchema: {
			type: 'object',
			properties: {
				domain: { type: 'string', description: 'Filter by business domain' },
				search: { type: 'string', description: 'Substring search in term or meaning' },
				limit:  { type: 'number', description: 'Max results (default 50)' },
			},
		},
	},

	{
		name: 'add_glossary_term',
		description: 'Add or update a domain glossary term. Use to document legacy business terms, acronyms, and data names discovered during translation.',
		inputSchema: {
			type: 'object',
			properties: {
				term:         { type: 'string', description: 'The term as it appears in source code (e.g. CUSTMAST)' },
				meaning:      { type: 'string', description: 'Plain-English meaning' },
				domain:       { type: 'string', description: 'Business domain' },
				examples:     { type: 'array', items: { type: 'string' }, description: 'Example usages' },
				relatedTerms: { type: 'array', items: { type: 'string' }, description: 'Related terms' },
			},
			required: ['term', 'meaning'],
		},
	},

	{
		name: 'get_business_rules',
		description: 'Get business rules extracted from units. Rules carry preservation requirements — always check these before simplifying logic during translation.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId:               { type: 'string', description: 'Filter to rules for a specific unit' },
				domain:               { type: 'string', description: 'Filter to rules for a business domain' },
				preservationRequired: { type: 'boolean', description: 'Only return rules where preservationRequired = true' },
				limit:                { type: 'number', description: 'Max results (default 50)' },
			},
		},
	},

	{
		name: 'get_domains',
		description: 'List all business domains with their unit counts. Use to understand the domain breakdown before planning a translation batch.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
	},


	// ── Workspace / progress tools ───────────────────────────────────────────

	{
		name: 'get_progress',
		description: 'Get overall translation progress including unit counts by status, percentage complete, pending decisions, and optionally velocity metrics and phase breakdown.',
		inputSchema: {
			type: 'object',
			properties: {
				includeVelocity: { type: 'boolean', description: 'Include velocity metrics (units/day, ETA)' },
				includePhases:   { type: 'boolean', description: 'Include per-phase progress breakdown' },
			},
		},
	},

	{
		name: 'get_workspace_summary',
		description: 'High-level workspace health summary. Shows total counts, pending decisions, blocked units, conflict count, drift alerts, and overall health status. Use at the start of a session to orient yourself.',
		inputSchema: {
			type: 'object',
			properties: {
				includeLanguageBreakdown: { type: 'boolean', description: 'Include breakdown by source language' },
				includeDomainBreakdown:   { type: 'boolean', description: 'Include breakdown by business domain' },
				includeRiskBreakdown:     { type: 'boolean', description: 'Include breakdown by risk level' },
			},
		},
	},

	{
		name: 'run_health_check',
		description: 'Run a full knowledge base integrity check. Detects orphaned references, stale locks, broken dependencies, decision conflicts, audit chain violations, and stale units.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
	},

	{
		name: 'check_source_drift',
		description: 'Check if source files have changed since the last scan. Returns drift alerts for files where the content hash has changed. Use before starting a translation to ensure source is current.',
		inputSchema: {
			type: 'object',
			properties: {
				filePath: { type: 'string', description: 'File path to check. If omitted, returns all tracked drift alerts.' },
			},
		},
	},

	// ── Advanced query tools ──────────────────────────────────────────────────

	{
		name: 'get_stale_units',
		description: 'Find units that have been stuck in a non-terminal status (translating, review, flagged, blocked) longer than the given threshold. Use to detect workflow bottlenecks and stalled translations.',
		inputSchema: {
			type: 'object',
			properties: {
				thresholdMs: { type: 'number', description: 'Stale threshold in milliseconds (default 86400000 = 24 hours)' },
			},
		},
	},

	{
		name: 'get_topological_order',
		description: 'Get all units ordered by dependency resolution (leaf-nodes first, dependents last). This is the correct translation order — translate in this sequence to minimise blocking.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
	},

	{
		name: 'filter_units',
		description: 'Advanced multi-criteria unit filter. More powerful than list_units — supports status arrays, risk arrays, locked state, drift state, and work-package membership.',
		inputSchema: {
			type: 'object',
			properties: {
				status:        { type: 'array', items: { type: 'string' }, description: 'Filter by multiple statuses' },
				risk:          { type: 'array', items: { type: 'string' }, description: 'Filter by multiple risk levels' },
				language:      { type: 'string', description: 'Filter by source language' },
				domain:        { type: 'string', description: 'Filter by business domain' },
				filePattern:   { type: 'string', description: 'Substring match against source file path' },
				tagId:         { type: 'string', description: 'Only units with this tag ID' },
				unlockedOnly:  { type: 'boolean', description: 'Exclude locked units' },
				driftedOnly:   { type: 'boolean', description: 'Only units whose source file has drifted' },
				workPackageId: { type: 'string', description: 'Only units in this work package' },
				limit:         { type: 'number', description: 'Max results (default 50)' },
				offset:        { type: 'number', description: 'Pagination offset (default 0)' },
			},
		},
	},

	{
		name: 'get_dependency_tree',
		description: 'Get the full recursive dependency tree for a unit. Shows the complete dependency hierarchy with translated state at each node. Use to visualise what needs to be translated before this unit can proceed.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId:   { type: 'string', description: 'Root unit for the tree' },
				maxDepth: { type: 'number', description: 'Maximum recursion depth (default 5)' },
			},
			required: ['unitId'],
		},
	},


	// ── Phase tools ──────────────────────────────────────────────────────────

	{
		name: 'get_phases',
		description: 'Get all migration phases with their progress (completed/blocked unit counts and percentage). Use to understand which phases are complete and which are in progress.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
	},

	{
		name: 'get_units_by_phase',
		description: 'Get all units belonging to a specific migration phase (e.g. foundation, schema, core-logic). Use with get_phases to understand what needs to be done in each phase.',
		inputSchema: {
			type: 'object',
			properties: {
				phaseId: { type: 'string', description: 'Phase ID from get_phases' },
				limit:   { type: 'number', description: 'Max results (default 50)' },
				offset:  { type: 'number', description: 'Pagination offset (default 0)' },
			},
			required: ['phaseId'],
		},
	},


	// ── Decision management tools ────────────────────────────────────────────

	{
		name: 'resolve_conflict',
		description: 'Resolve a decision conflict — choose the canonical decision when two decisions map the same source identifier to different targets. The winning decision is kept; the conflict is marked resolved.',
		inputSchema: {
			type: 'object',
			properties: {
				conflictId:         { type: 'string', description: 'Conflict ID from detect_conflicts' },
				winningDecisionId:  { type: 'string', description: 'ID of the decision that should be the canonical one' },
				actor:              { type: 'string', description: 'Actor performing the resolution (defaults to "human")' },
			},
			required: ['conflictId', 'winningDecisionId'],
		},
	},

	{
		name: 'remove_decision',
		description: 'Remove a specific decision record (type mapping, naming, rule interpretation, exclusion, or pattern override). Use when a decision was recorded incorrectly. This affects future translations — check get_decision_impact first.',
		inputSchema: {
			type: 'object',
			properties: {
				decisionId:   { type: 'string', description: 'Decision record ID to remove' },
				decisionType: { type: 'string', enum: ['type-mapping', 'naming', 'rule-interpretation', 'exclusion', 'pattern-override'], description: 'Type of decision to remove' },
			},
			required: ['decisionId', 'decisionType'],
		},
	},


	// ── Extended annotation tools ────────────────────────────────────────────

	{
		name: 'list_annotations',
		description: 'List all annotations attached to a unit — context notes, reviewer comments, agent notes, and warnings.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId: { type: 'string', description: 'Unit to list annotations for' },
			},
			required: ['unitId'],
		},
	},

	{
		name: 'delete_annotation',
		description: 'Delete an annotation from a unit. Use to remove outdated or incorrect notes.',
		inputSchema: {
			type: 'object',
			properties: {
				annotationId: { type: 'string', description: 'Annotation ID to delete' },
			},
			required: ['annotationId'],
		},
	},


	// ── Work package tools ───────────────────────────────────────────────────

	{
		name: 'create_work_package',
		description: 'Create a work package — an ad-hoc grouping of units for sprint planning, team assignment, or incremental delivery. A unit can belong to at most one work package.',
		inputSchema: {
			type: 'object',
			properties: {
				label:       { type: 'string', description: 'Short display name (e.g. "Sprint 3 — Billing Module")' },
				description: { type: 'string', description: 'What this work package covers' },
				unitIds:     { type: 'array', items: { type: 'string' }, description: 'Unit IDs to include initially' },
				assignedTo:  { type: 'string', description: 'Team member or agent ID responsible' },
				dueDate:     { type: 'string', description: 'Due date as ISO-8601 (e.g. "2025-04-30")' },
				createdBy:   { type: 'string', description: 'Creator identifier (defaults to "agent")' },
			},
			required: ['label', 'description'],
		},
	},

	{
		name: 'list_work_packages',
		description: 'List all work packages with their unit counts and assignment info.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
	},

	{
		name: 'get_work_package',
		description: 'Get a work package by ID, including the list of unit IDs it contains.',
		inputSchema: {
			type: 'object',
			properties: {
				workPackageId: { type: 'string', description: 'Work package ID' },
			},
			required: ['workPackageId'],
		},
	},

	{
		name: 'add_unit_to_work_package',
		description: 'Add a unit to a work package. The unit is removed from its previous work package if any.',
		inputSchema: {
			type: 'object',
			properties: {
				workPackageId: { type: 'string', description: 'Work package ID' },
				unitId:        { type: 'string', description: 'Unit to add' },
			},
			required: ['workPackageId', 'unitId'],
		},
	},

	{
		name: 'remove_unit_from_work_package',
		description: 'Remove a unit from its work package.',
		inputSchema: {
			type: 'object',
			properties: {
				workPackageId: { type: 'string', description: 'Work package ID' },
				unitId:        { type: 'string', description: 'Unit to remove' },
			},
			required: ['workPackageId', 'unitId'],
		},
	},

	{
		name: 'delete_work_package',
		description: 'Delete a work package. Units in the package are NOT deleted — they just become unassigned.',
		inputSchema: {
			type: 'object',
			properties: {
				workPackageId: { type: 'string', description: 'Work package ID to delete' },
			},
			required: ['workPackageId'],
		},
	},


	// ── Lock tools ───────────────────────────────────────────────────────────

	{
		name: 'lock_unit',
		description: 'Acquire an exclusive lock on a unit before translating it. Prevents concurrent modification by other agents. Always lock before translating in a multi-agent environment.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId:  { type: 'string', description: 'Unit to lock' },
				ownerId: { type: 'string', description: 'Your agent ID or user ID' },
				ttlMs:   { type: 'number', description: 'Lock TTL in milliseconds (default 300000 = 5 min; 0 = indefinite)' },
			},
			required: ['unitId', 'ownerId'],
		},
	},

	{
		name: 'unlock_unit',
		description: 'Release a lock on a unit after translation is complete. Always unlock after recording the translation.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId:  { type: 'string', description: 'Unit to unlock' },
				ownerId: { type: 'string', description: 'Your agent ID — must match the lock owner' },
			},
			required: ['unitId', 'ownerId'],
		},
	},

	{
		name: 'force_unlock_unit',
		description: 'Force-release a lock regardless of who holds it. Admin / recovery operation. Use when an agent has crashed and left a lock behind.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId: { type: 'string', description: 'Unit to force-unlock' },
			},
			required: ['unitId'],
		},
	},

	{
		name: 'list_locks',
		description: 'List all active locks with owner, acquisition time, TTL, and whether the lock has expired. Use to identify stale locks before starting a translation batch.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
	},


	// ── Tag tools ────────────────────────────────────────────────────────────

	{
		name: 'create_tag',
		description: 'Create a new tag for ad-hoc unit grouping and filtering. Tags are reusable labels (e.g. "sprint-1", "team-alpha", "needs-review").',
		inputSchema: {
			type: 'object',
			properties: {
				name:  { type: 'string', description: 'Tag display name (e.g. "sprint-1")' },
				color: { type: 'string', description: 'Hex color for UI display (e.g. "#e0a84e")' },
			},
			required: ['name'],
		},
	},

	{
		name: 'list_tags',
		description: 'List all tags with their unit counts.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
	},

	{
		name: 'add_tag_to_unit',
		description: 'Apply a tag to a unit.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId: { type: 'string', description: 'Unit to tag' },
				tagId:  { type: 'string', description: 'Tag ID from list_tags or create_tag' },
			},
			required: ['unitId', 'tagId'],
		},
	},

	{
		name: 'remove_tag_from_unit',
		description: 'Remove a tag from a unit.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId: { type: 'string', description: 'Unit to untag' },
				tagId:  { type: 'string', description: 'Tag ID to remove' },
			},
			required: ['unitId', 'tagId'],
		},
	},

	{
		name: 'get_tags_for_unit',
		description: 'Get all tags currently applied to a unit.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId: { type: 'string', description: 'Unit to inspect' },
			},
			required: ['unitId'],
		},
	},


	// ── Compliance tools ─────────────────────────────────────────────────────

	{
		name: 'check_compliance_gate',
		description: 'Run the compliance gate for a unit — checks all regulatory requirements (PII handling, audit trails, approval records, etc.). A unit cannot be approved until its gate passes.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId: { type: 'string', description: 'Unit to check' },
			},
			required: ['unitId'],
		},
	},

	{
		name: 'record_compliance_approval',
		description: 'Record a human compliance approval for a specific requirement on a unit (e.g. a QA sign-off, regulatory review, or data-privacy confirmation).',
		inputSchema: {
			type: 'object',
			properties: {
				unitId:        { type: 'string', description: 'Unit being approved' },
				requirementId: { type: 'string', description: 'Requirement ID from check_compliance_gate output' },
				approver:      { type: 'string', description: 'Approver identity (user ID, auditor name)' },
				evidence:      { type: 'string', description: 'Supporting evidence (document reference, ticket ID, link)' },
			},
			required: ['unitId', 'requirementId', 'approver'],
		},
	},

	{
		name: 'waive_compliance_requirement',
		description: 'Formally waive a compliance requirement for a unit with a documented reason. The waiver is recorded in the audit trail. Use when a requirement is inapplicable or has been risk-accepted by management.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId:        { type: 'string', description: 'Unit whose requirement is being waived' },
				requirementId: { type: 'string', description: 'Requirement ID from check_compliance_gate output' },
				waivedBy:      { type: 'string', description: 'Identity of the person/team waiving (user ID, manager name)' },
				reason:        { type: 'string', description: 'Documented reason for waiver (required for audit trail)' },
			},
			required: ['unitId', 'requirementId', 'waivedBy', 'reason'],
		},
	},

	{
		name: 'get_compliance_failures',
		description: 'Get all units that have a compliance gate in FAIL or PARTIAL state. Use before moving to approval stage to find outstanding compliance issues.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
	},


	// ── Checkpoint tools ─────────────────────────────────────────────────────

	{
		name: 'create_checkpoint',
		description: 'Snapshot the current knowledge base state under a named label. Use before risky bulk operations (batch translation, re-scan, import). Allows rollback via restore_checkpoint.',
		inputSchema: {
			type: 'object',
			properties: {
				label:       { type: 'string', description: 'Human-readable checkpoint name (e.g. "Before Phase 2 re-scan")' },
				triggeredBy: { type: 'string', description: 'Who triggered this (user ID, agent ID, or "auto")' },
			},
			required: ['label'],
		},
	},

	{
		name: 'list_checkpoints',
		description: 'List all available KB checkpoints (most recent first) with their labels, timestamps, and unit counts.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
	},

	{
		name: 'restore_checkpoint',
		description: 'Restore the KB to a checkpoint state. The current state is auto-snapshotted as "pre-restore" before restoring. Use to roll back a bad batch operation.',
		inputSchema: {
			type: 'object',
			properties: {
				checkpointId: { type: 'string', description: 'Checkpoint ID from list_checkpoints' },
			},
			required: ['checkpointId'],
		},
	},

	{
		name: 'delete_checkpoint',
		description: 'Delete a checkpoint to free storage.',
		inputSchema: {
			type: 'object',
			properties: {
				checkpointId: { type: 'string', description: 'Checkpoint ID to delete' },
			},
			required: ['checkpointId'],
		},
	},


	// ── Unit management tools ────────────────────────────────────────────────

	{
		name: 'split_unit',
		description: 'Split a "god unit" (overly large unit) into smaller sub-units. The parent is moved to "skipped"; the sub-units are created as new "pending" units ready for translation. Requires at least 2 sub-units.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId: { type: 'string', description: 'Parent unit ID to split' },
				subUnits: {
					type: 'array',
					description: 'Definitions for each sub-unit (min 2, max 20). Each item: { name: string, sourceText: string, riskLevel?: string, domain?: string, phaseId?: string }',
					items: { type: 'object' },
				},
				reason: { type: 'string', description: 'Reason for splitting (audit trail)' },
			},
			required: ['unitId', 'subUnits'],
		},
	},

	{
		name: 'merge_units',
		description: 'Merge several over-decomposed units into one. The source units are moved to "skipped"; the merged unit is created as "pending". Use when discovery over-decomposed a logical unit.',
		inputSchema: {
			type: 'object',
			properties: {
				unitIds:   { type: 'array', items: { type: 'string' }, description: 'IDs of units to merge (minimum 2)' },
				name:      { type: 'string', description: 'Name for the merged unit' },
				riskLevel: { type: 'string', description: 'Override risk level (defaults to max of merged units)' },
				domain:    { type: 'string', description: 'Override domain (defaults to first unit\'s domain)' },
				reason:    { type: 'string', description: 'Reason for merging (audit trail)' },
			},
			required: ['unitIds', 'name'],
		},
	},

	{
		name: 'revert_unit',
		description: 'Revert a unit back to "pending" status, clearing all translation artifacts (translated code, fingerprint comparison, equivalence result, approval records). Use when a reviewer rejects a translation.',
		inputSchema: {
			type: 'object',
			properties: {
				unitId: { type: 'string', description: 'Unit to revert' },
				reason: { type: 'string', description: 'Why the unit is being reverted (required for audit trail)' },
				actor:  { type: 'string', description: 'Who is reverting (defaults to "human")' },
			},
			required: ['unitId', 'reason'],
		},
	},


	// ── Export / Import tools ────────────────────────────────────────────────

	{
		name: 'export_decisions',
		description: 'Export the full decision log (type mappings, naming decisions, rule interpretations, exclusions, pattern overrides) as a portable JSON string. Use for handoff, backup, or cross-project reuse.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
	},

	{
		name: 'import_decisions',
		description: 'Import decisions from an export_decisions payload. Merges into the current KB, skipping duplicates. Use to seed a new project with decisions from a previous migration.',
		inputSchema: {
			type: 'object',
			properties: {
				decisionsJson: { type: 'string', description: 'JSON string from export_decisions' },
			},
			required: ['decisionsJson'],
		},
	},

	{
		name: 'export_kb',
		description: 'Export the full knowledge base as a JSON string (all units, files, decisions, glossary, annotations, checkpoints). Use for backup or handoff to another team. The output can be large.',
		inputSchema: {
			type: 'object',
			properties: {},
		},
	},


	// ── Utility tools ────────────────────────────────────────────────────────

	{
		name: 'check_excluded',
		description: 'Check if a file path or unit name matches any active exclusion rule. Use before creating a unit record to avoid adding files that should be skipped.',
		inputSchema: {
			type: 'object',
			properties: {
				filePath: { type: 'string', description: 'File path to test against exclusion rules' },
				unitName: { type: 'string', description: 'Optional unit name to also test' },
			},
			required: ['filePath'],
		},
	},

];

/** Look up a single tool definition by name */
export function getToolDefinition(name: string): IAgentToolDefinition | undefined {
	return MCP_TOOL_DEFINITIONS.find(t => t.name === name);
}
