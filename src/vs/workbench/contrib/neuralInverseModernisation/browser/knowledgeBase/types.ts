/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Auxiliary types used by IKnowledgeBaseService and its implementation.
 * Separated from common/knowledgeBaseTypes.ts to keep domain types pure.
 *
 * Note: IWorkPackage and IStaleUnitReport live in common/knowledgeBaseTypes.ts
 * (they are referenced by IKnowledgeBaseExtensions which is part of the persisted KB).
 * They are re-exported here for backward-compatibility of callers that import from this file.
 */

import {
	IKnowledgeUnit,
	IBusinessRule,
	IBusinessTerm,
	ITypeMappingDecision,
	INamingDecision,
	IRuleInterpretation,
	IPatternOverride,
	IUnitInterface,
	IUnitAnnotation,
	UnitStatus,
	RiskLevel,
	IWorkPackage,
	IStaleUnitReport,
} from '../../common/knowledgeBaseTypes.js';

// Re-export so callers don't need to change their import paths
export { IWorkPackage, IStaleUnitReport };


// ─── Context assembly ─────────────────────────────────────────────────────────

/**
 * Everything an LLM agent needs to translate a single unit.
 * Returned by IKnowledgeBaseService.getResolvedContext().
 * This is the primary data structure consumed by the Translation Engine (Phase 4).
 */
export interface IResolvedUnitContext {
	unit: IKnowledgeUnit;

	/**
	 * Source text with all dependencies (copybooks, imports, includes) expanded inline.
	 * This is what the AI reads — a complete, self-contained unit.
	 */
	resolvedSource: string;

	/** Type-mapping decisions applicable to this unit */
	applicableTypeMappings: ITypeMappingDecision[];

	/** Naming decisions whose source identifiers appear in this unit */
	applicableNamingDecisions: INamingDecision[];

	/** Rule interpretations specific to this unit */
	ruleInterpretations: IRuleInterpretation[];

	/** Pattern overrides that match this unit's name */
	patternOverrides: IPatternOverride[];

	/** Translated public interfaces of units this one calls (ensures correct call signatures) */
	calledInterfaces: IUnitInterface[];

	/**
	 * Business rules extracted from similar already-translated units.
	 * Gives the AI pattern recognition for this codebase.
	 * Capped at 20 to stay within context budget.
	 */
	relatedRules: IBusinessRule[];

	/** Glossary terms that appear in this unit's source text */
	relevantGlossaryTerms: IBusinessTerm[];

	/** True if all dependencies have been translated — unit is fully unblocked */
	readyToTranslate: boolean;

	/** IDs of dependency units that have NOT yet been translated */
	unblockedDependencies: string[];

	/**
	 * Annotations of kind 'context-injection' attached to this unit.
	 * Automatically injected into the LLM prompt before translation.
	 * Populated by KnowledgeBaseImpl.getResolvedContext().
	 */
	contextAnnotations: IUnitAnnotation[];
}


// ─── Statistics ───────────────────────────────────────────────────────────────

export interface ILanguageProgress {
	language: string;
	totalUnits: number;
	completedUnits: number;
	blockedUnits: number;
	byRisk: Record<RiskLevel, number>;
}

export interface IDomainProgress {
	domain: string;
	regulated: boolean;
	totalUnits: number;
	completedUnits: number;
	blockedUnits: number;
}

/** Top-level statistics returned by IKnowledgeBaseService.getStats() */
export interface IKnowledgeBaseStats {
	totalUnits: number;
	totalFiles: number;
	byStatus: Record<UnitStatus, number>;
	byRisk: Record<RiskLevel, number>;
	byLanguage: ILanguageProgress[];
	byDomain: IDomainProgress[];
	totalDecisions: number;
	totalGlossaryTerms: number;
	totalAuditEntries: number;
	/** (complete + validated + committed) / totalUnits * 100 */
	percentComplete: number;
	percentBlocked: number;
	pendingDecisionCount: number;
	pendingDecisionsByPriority: Record<'low' | 'medium' | 'high' | 'blocking', number>;
}


// ─── Dependency graph ─────────────────────────────────────────────────────────

/** A node in the dependency tree returned by getDependencyTree() */
export interface IDependencyNode {
	unitId: string;
	depth: number;
	status: UnitStatus;
	isTranslated: boolean;
	dependsOn: IDependencyNode[];
}


// ─── Session index ────────────────────────────────────────────────────────────

/**
 * Lightweight session registry stored separately in workspace storage.
 * Lets us list all sessions without loading full knowledge bases.
 */
export interface IKnowledgeBaseSessionIndex {
	sessions: Array<{
		sessionId: string;
		createdAt: number;
		updatedAt: number;
		totalUnits: number;
	}>;
}


// ─── Filter criteria ──────────────────────────────────────────────────────────

export interface IUnitFilterCriteria {
	status?: UnitStatus[];
	risk?: RiskLevel[];
	language?: string;
	domain?: string;
	/** Substring match against source file path */
	filePattern?: string;
	/** Only units with this tag ID */
	tagId?: string;
	/** Only units that are NOT locked */
	unlockedOnly?: boolean;
	/** Only units that have drifted source */
	driftedOnly?: boolean;
	/** Only units belonging to this work package */
	workPackageId?: string;
}


// ─── Decision analysis ────────────────────────────────────────────────────────

/** Which units would be affected if a decision changes or is removed */
export interface IDecisionImpactResult {
	decisionId:         string;
	decisionType:       'type-mapping' | 'naming' | 'rule-interpretation' | 'pattern-override';
	directlyAffected:   string[];  // Unit IDs whose source text contains the source type/name
	alreadyTranslated:  string[];  // Affected units already in done statuses — need re-translation
	pendingUnits:       string[];  // Affected units not yet translated — decisions will apply
	totalAffected:      number;
}


// ─── Context budget ───────────────────────────────────────────────────────────

/**
 * Token-budget-aware context assembly result.
 * When the full context doesn't fit the budget, this prioritises the most
 * important content and reports what was truncated.
 */
export interface IBudgetedUnitContext {
	/** The full resolved context (may have some fields truncated for budget) */
	context: IResolvedUnitContext;
	/** Approximate token count of the assembled context */
	estimatedTokens: number;
	/** Maximum token budget requested */
	maxTokens: number;
	/** True if content was truncated to fit the budget */
	wasTruncated: boolean;
	/** What was dropped to fit the budget */
	truncationLog: string[];
}
