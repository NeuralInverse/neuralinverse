/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * IKnowledgeBaseService — public interface consumed by agents, tools, and UI.
 *
 * Separated from the implementation so consumers only import the interface.
 * Implementation lives in KnowledgeBaseImpl.ts.
 */

import { Event } from '../../../../../base/common/event.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import {
	IModernisationKnowledgeBase,
	IKnowledgeUnit,
	IKnowledgeFile,
	IDecisionLog,
	IBusinessGlossary,
	IBusinessRule,
	IBusinessTerm,
	IBusinessDomain,
	IRecognisedPattern,
	ITypeMappingDecision,
	INamingDecision,
	IRuleInterpretation,
	IExclusionDecision,
	IPatternOverride,
	IProgressState,
	IPhaseProgress,
	IPendingDecision,
	IKnowledgeAuditEntry,
	IUnitInterface,
	UnitStatus,
	RiskLevel,
} from '../../common/knowledgeBaseTypes.js';
import {
	ICodeRange,
	IComplianceFingerprint,
	IFingerprintComparison,
	IApprovalRecord,
	IEquivalenceResult,
	IMigrationPhase,
} from '../../common/modernisationTypes.js';
import {
	IResolvedUnitContext,
	IKnowledgeBaseStats,
	IDependencyNode,
	IKnowledgeBaseSessionIndex,
	IUnitFilterCriteria,
	IDecisionImpactResult,
	IBudgetedUnitContext,
	IWorkPackage,
	IStaleUnitReport,
} from './types.js';
import {
	IUnitLock,
	ISourceFileVersion,
	ISourceDriftAlert,
	IDecisionConflict,
	IUnitAnnotation,
	IUnitTag,
	IComplianceGateResult,
	IKnowledgeBaseCheckpoint,
	IVelocityMetrics,
	IKBHealthReport,
} from '../../common/knowledgeBaseTypes.js';

export {
	IUnitLock, ISourceFileVersion, ISourceDriftAlert, IDecisionConflict,
	IUnitAnnotation, IUnitTag, IComplianceGateResult, IKnowledgeBaseCheckpoint,
	IVelocityMetrics, IKBHealthReport,
};

export {
	IResolvedUnitContext, IKnowledgeBaseStats, IDependencyNode,
	IKnowledgeBaseSessionIndex, IUnitFilterCriteria,
	IDecisionImpactResult, IBudgetedUnitContext, IWorkPackage, IStaleUnitReport,
};

export { IPhaseProgress };

// ─── Service decorator ────────────────────────────────────────────────────────

export const IKnowledgeBaseService = createDecorator<IKnowledgeBaseService>('knowledgeBaseService');

// ─── Interface ────────────────────────────────────────────────────────────────

export interface IKnowledgeBaseService {
	readonly _serviceBrand: undefined;

	// ── Events ─────────────────────────────────────────────────────────────

	/** Fires on any mutation (debounced 400ms) */
	readonly onDidChange: Event<void>;
	/** Fires on every unit status transition */
	readonly onDidChangeUnitStatus: Event<{ unitId: string; prev: UnitStatus; next: UnitStatus }>;
	/** Fires when a new pending decision is raised */
	readonly onDidRaisePendingDecision: Event<IPendingDecision>;
	/** Fires when a pending decision is resolved */
	readonly onDidResolvePendingDecision: Event<string>;

	// ── Lifecycle ──────────────────────────────────────────────────────────

	/**
	 * Load (or create) the knowledge base for a session.
	 * Must be called before any other method.
	 */
	init(sessionId: string): Promise<void>;
	readonly isActive: boolean;
	/** The active knowledge base. Throws if not initialised. */
	readonly kb: IModernisationKnowledgeBase;
	/** Flush to storage and clear in-memory state. */
	close(): void;
	/** Hard reset: clear storage + memory, then create fresh KB. */
	reset(sessionId: string): Promise<void>;
	/** Permanently delete a session from storage. */
	deleteSession(sessionId: string): void;
	/** List all sessions that have persisted knowledge bases. */
	listSessions(): IKnowledgeBaseSessionIndex;

	// ── Batch mode ─────────────────────────────────────────────────────────

	/**
	 * Begin a batch operation — suspends per-mutation progress recalculation and
	 * change event firing. Call batchEnd() when done.
	 * Use when bulk-adding thousands of units (e.g. after Discovery scan).
	 */
	batchBegin(): void;
	/**
	 * End a batch operation — flushes deferred progress and fires onDidChange once.
	 * Must be paired with batchBegin().
	 */
	batchEnd(): void;

	// ── Unit CRUD ──────────────────────────────────────────────────────────

	addUnit(unit: IKnowledgeUnit): void;
	addUnits(units: IKnowledgeUnit[]): void;
	updateUnit(unitId: string, patch: Partial<IKnowledgeUnit>): void;
	updateUnits(updates: Array<{ id: string; patch: Partial<IKnowledgeUnit> }>): void;
	getUnit(unitId: string): IKnowledgeUnit | undefined;
	hasUnit(unitId: string): boolean;
	deleteUnit(unitId: string): void;
	getAllUnits(): IKnowledgeUnit[];

	// ── File registry ──────────────────────────────────────────────────────

	addFile(file: IKnowledgeFile): void;
	/** Batch-add multiple files — more efficient than calling addFile() repeatedly */
	addFiles(files: IKnowledgeFile[]): void;
	updateFile(path: string, patch: Partial<IKnowledgeFile>): void;
	/** Remove a file record from the registry (units are NOT deleted — use deleteUnit() separately) */
	deleteFile(path: string): void;
	getFile(path: string): IKnowledgeFile | undefined;
	getAllFiles(): IKnowledgeFile[];
	getUnitsForFile(filePath: string): IKnowledgeUnit[];

	// ── Unit source resolution ─────────────────────────────────────────────

	/**
	 * Set the resolved (dependency-expanded) source for a unit and transition it to 'ready'.
	 * Called by the Dependency Resolver after all copybooks/imports are expanded inline.
	 */
	resolveUnitSource(unitId: string, resolvedSource: string): void;

	/**
	 * Revert a unit back to 'pending', clearing all translation artifacts.
	 * Used when a human reviewer rejects a translation and wants a fresh attempt.
	 * Clears: targetText, targetFile, targetRange, targetInterface, fingerprintComparison,
	 *         equivalenceResult, blockedReason, pendingDecisionId.
	 */
	revertUnit(unitId: string, reason: string, actor?: string): void;

	// ── Translation recording ──────────────────────────────────────────────

	recordTranslation(unitId: string, targetCode: string, targetFile: string, targetRange?: ICodeRange): void;
	recordBusinessRule(unitId: string, rule: IBusinessRule): void;
	recordBusinessRules(unitId: string, rules: IBusinessRule[]): void;
	/** Update specific fields of an existing business rule on a unit */
	updateBusinessRule(unitId: string, ruleId: string, patch: Partial<IBusinessRule>): void;
	/** Remove a business rule from a unit by ID */
	deleteBusinessRule(unitId: string, ruleId: string): void;
	recordFingerprint(unitId: string, fingerprint: IComplianceFingerprint): void;
	recordFingerprintComparison(unitId: string, comparison: IFingerprintComparison): void;
	recordEquivalence(unitId: string, result: IEquivalenceResult): void;
	recordInterface(unitId: string, iface: IUnitInterface): void;
	addApproval(unitId: string, approval: IApprovalRecord): void;

	// ── Status transitions ─────────────────────────────────────────────────

	setUnitStatus(unitId: string, status: UnitStatus, reason?: string, actor?: string): void;
	setUnitsStatus(unitIds: string[], status: UnitStatus, actor?: string): void;
	flagBlocked(unitId: string, reason: string, pendingDecision: IPendingDecision): void;
	markResolved(unitId: string, actor?: string): void;

	// ── Decision recording ─────────────────────────────────────────────────

	recordTypeMappingDecision(decision: ITypeMappingDecision): void;
	recordNamingDecision(decision: INamingDecision): void;
	recordRuleInterpretation(interp: IRuleInterpretation): void;
	recordExclusion(exclusion: IExclusionDecision): void;
	recordPatternOverride(override: IPatternOverride): void;
	removeTypeMappingDecision(id: string): void;
	removeNamingDecision(id: string): void;
	/** Remove a rule interpretation by ID */
	removeRuleInterpretation(id: string): void;
	/** Remove a pattern override by ID */
	removePatternOverride(id: string): void;
	/** Remove an exclusion rule by ID */
	removeExclusion(id: string): void;
	getDecisions(): IDecisionLog;
	findTypeMappingDecision(sourceType: string): ITypeMappingDecision | undefined;
	findNamingDecision(sourceName: string): INamingDecision | undefined;
	/** All decisions that apply to a specific unit (scoped by appliesTo + source text matching) */
	getDecisionsForUnit(unitId: string): IDecisionLog;
	/**
	 * Check whether a file path or unit name matches any exclusion rule.
	 * Quick lookup for agents — avoids creating units for excluded scope.
	 */
	isExcluded(filePath: string, unitName?: string): boolean;

	// ── Glossary & Domains ────────────────────────────────────────────────

	recordGlossaryTerm(term: IBusinessTerm): void;
	recordGlossaryTerms(terms: IBusinessTerm[]): void;
	getGlossaryTerm(term: string): IBusinessTerm | undefined;
	recordRecognisedPattern(pattern: IRecognisedPattern): void;
	addDomain(domain: IBusinessDomain): void;
	updateDomain(name: string, patch: Partial<IBusinessDomain>): void;
	getDomain(name: string): IBusinessDomain | undefined;
	getAllDomains(): IBusinessDomain[];
	assignUnitToDomain(unitId: string, domainName: string): void;
	getGlossary(domain?: string): IBusinessGlossary;
	/** Get all business rules extracted across all units for a given domain */
	getBusinessRulesForDomain(domain: string): IBusinessRule[];

	// ── Pending decisions ──────────────────────────────────────────────────

	addPendingDecision(decision: IPendingDecision): void;
	resolvePendingDecision(decisionId: string, actor?: string): void;
	getPendingDecision(id: string): IPendingDecision | undefined;
	getPendingDecisions(priority?: IPendingDecision['priority']): IPendingDecision[];
	getPendingDecisionForUnit(unitId: string): IPendingDecision | undefined;

	// ── Phase management ───────────────────────────────────────────────────

	setPhases(phases: IMigrationPhase[]): void;
	updatePhaseProgress(phaseId: string): void;
	recalculateAllPhases(): void;
	/** Get the current progress snapshot for a specific phase */
	getPhase(phaseId: string): IPhaseProgress | undefined;
	/** Get all phase progress snapshots */
	getAllPhases(): IPhaseProgress[];

	// ── Dependency graph ───────────────────────────────────────────────────

	/**
	 * Add a directed dependency edge: fromUnitId depends on toUnitId.
	 * Keeps both sides symmetric: fromUnit.dependsOn += toUnitId AND toUnit.usedBy += fromUnitId.
	 * No-op if the edge already exists.
	 */
	addDependency(fromUnitId: string, toUnitId: string): void;
	/**
	 * Remove a directed dependency edge.
	 * Keeps both sides symmetric. No-op if the edge does not exist.
	 */
	removeDependency(fromUnitId: string, toUnitId: string): void;
	getDependencies(unitId: string): IKnowledgeUnit[];
	getTransitiveDependencies(unitId: string): IKnowledgeUnit[];
	getDependents(unitId: string): IKnowledgeUnit[];
	getImpactChain(unitId: string): IKnowledgeUnit[];
	getDependencyTree(unitId: string, maxDepth?: number): IDependencyNode;
	getTopologicalOrder(): IKnowledgeUnit[];
	getTranslatableUnits(): IKnowledgeUnit[];
	getNextUnit(options?: { riskLevel?: RiskLevel; domain?: string; language?: string }): IKnowledgeUnit | undefined;

	// ── Query ──────────────────────────────────────────────────────────────

	getUnitsByStatus(status: UnitStatus): IKnowledgeUnit[];
	getUnitsByRisk(risk: RiskLevel): IKnowledgeUnit[];
	getUnitsByDomain(domain: string): IKnowledgeUnit[];
	getUnitsByLanguage(language: string): IKnowledgeUnit[];
	getUnitsByFile(filePath: string): IKnowledgeUnit[];
	getUnitsByPhase(phaseId: string): IKnowledgeUnit[];
	getBlockedUnits(): IKnowledgeUnit[];
	getReadyUnits(): IKnowledgeUnit[];
	getFlaggedUnits(): IKnowledgeUnit[];
	getApprovedUnits(): IKnowledgeUnit[];
	getCompleteUnits(): IKnowledgeUnit[];
	searchUnits(query: string): IKnowledgeUnit[];
	filterUnits(criteria: IUnitFilterCriteria): IKnowledgeUnit[];

	// ── Context assembly (for agents) ─────────────────────────────────────

	/**
	 * Assemble everything an agent needs to translate unitId.
	 * Primary method consumed by Phase 4: Translation Engine.
	 */
	getResolvedContext(unitId: string): IResolvedUnitContext;
	exportDecisionsAsContext(unitId?: string): string;
	exportGlossaryAsContext(domain?: string): string;

	// ── Progress & stats ──────────────────────────────────────────────────

	getProgress(): IProgressState;
	getStats(): IKnowledgeBaseStats;
	recomputeProgress(): void;

	// ── Audit log ─────────────────────────────────────────────────────────

	getAuditLog(options?: { unitId?: string; limit?: number; offset?: number }): IKnowledgeAuditEntry[];
	getAuditLogForUnit(unitId: string, limit?: number): IKnowledgeAuditEntry[];
	/** Verify tamper-evident audit chain integrity — for compliance auditing */
	verifyAuditLogIntegrity(): { valid: boolean; firstBrokenIndex: number | null };

	// ── Unit locking (multi-agent concurrency) ────────────────────────────

	/**
	 * Acquire an exclusive lock on a unit.
	 * @param ttlMs  How long the lock is valid (default 5 min). 0 = indefinite.
	 * @returns The lock record, or undefined if the unit is already locked by someone else.
	 */
	lockUnit(unitId: string, ownerId: string, ttlMs?: number): IUnitLock | undefined;
	unlockUnit(unitId: string, ownerId: string): boolean;
	/** Force-release a lock regardless of owner (admin / timeout recovery) */
	forceUnlockUnit(unitId: string): void;
	getLock(unitId: string): IUnitLock | undefined;
	isUnitLocked(unitId: string): boolean;
	/** Release all locks held by an owner (e.g. when an agent crashes) */
	releaseAllLocksFor(ownerId: string): void;
	/** Remove all locks whose TTL has expired */
	pruneExpiredLocks(): number;
	getAllLocks(): IUnitLock[];

	// ── Source drift detection ─────────────────────────────────────────────

	/**
	 * Record the current content hash + mtime of a source file.
	 * Call after scanning so we have a baseline for drift detection.
	 */
	recordSourceVersion(filePath: string, contentHash: string, mtime: number, size: number): void;
	getSourceVersion(filePath: string): ISourceFileVersion | undefined;
	/**
	 * Compare current disk state against the recorded baseline.
	 * If drift is detected an ISourceDriftAlert is stored and returned.
	 */
	checkSourceDrift(filePath: string, currentHash: string, currentMtime: number): ISourceDriftAlert | undefined;
	/** Run drift check for all tracked source files in batch */
	checkAllSourceDrift(currentFiles: Array<{ path: string; hash: string; mtime: number }>): ISourceDriftAlert[];
	/** Mark an alert as acknowledged (user has reviewed the drift) */
	acknowledgeDriftAlert(alertId: string, actor?: string): void;
	getDriftAlerts(unacknowledgedOnly?: boolean): ISourceDriftAlert[];
	/** Returns all units whose source file has drifted */
	getUnitsAffectedByDrift(): IKnowledgeUnit[];

	// ── Decision conflict detection ────────────────────────────────────────

	/**
	 * Scan all type-mapping and naming decisions for conflicts
	 * (two decisions mapping the same source identifier to different targets).
	 * Conflicts are stored and returned.
	 */
	detectDecisionConflicts(): IDecisionConflict[];
	getDecisionConflict(conflictId: string): IDecisionConflict | undefined;
	getDecisionConflicts(unresolvedOnly?: boolean): IDecisionConflict[];
	/** Mark a conflict as resolved (user chose the canonical decision) */
	resolveDecisionConflict(conflictId: string, winningDecisionId: string, actor?: string): void;
	/** Compute which units are affected by a decision change / removal */
	getDecisionImpact(decisionId: string, decisionType: IDecisionConflict['decisionType']): IDecisionImpactResult;

	// ── Token-budget-aware context assembly ───────────────────────────────

	/**
	 * Assemble context for a unit, trimming content to fit maxTokens.
	 * Priority order for truncation: relatedRules → glossaryTerms → resolvedSource (truncated last).
	 */
	getContextForBudget(unitId: string, maxTokens: number): IBudgetedUnitContext;

	// ── Annotations ───────────────────────────────────────────────────────

	/** Attach a free-text annotation to a unit (comments, reviewer notes, etc.) */
	addAnnotation(unitId: string, content: string, author: string, kind?: IUnitAnnotation['kind']): IUnitAnnotation;
	updateAnnotation(annotationId: string, content: string): void;
	deleteAnnotation(annotationId: string): void;
	getAnnotations(unitId: string): IUnitAnnotation[];
	/** Get all annotations of a specific kind across all units */
	getContextAnnotations(kind: IUnitAnnotation['kind']): IUnitAnnotation[];

	// ── Tags ──────────────────────────────────────────────────────────────

	createTag(tag: Omit<IUnitTag, 'id' | 'createdAt'>): IUnitTag;
	addTagToUnit(unitId: string, tagId: string): void;
	removeTagFromUnit(unitId: string, tagId: string): void;
	deleteTag(tagId: string): void;
	getTag(tagId: string): IUnitTag | undefined;
	getAllTags(): IUnitTag[];
	getUnitsByTag(tagId: string): IKnowledgeUnit[];
	getTagsForUnit(unitId: string): IUnitTag[];

	// ── Compliance gates ──────────────────────────────────────────────────

	/**
	 * Run all compliance requirements against a unit before approval.
	 * Records the gate result in ext and raises a pending decision if failing.
	 */
	checkComplianceGate(unitId: string): IComplianceGateResult;
	/** Manually record a compliance approval (e.g. human reviewer sign-off) */
	recordComplianceApproval(unitId: string, requirementId: string, approver: string, evidence?: string): void;
	/**
	 * Waive a specific compliance requirement for a unit.
	 * A waived requirement is formally exempted — does not block the gate.
	 * Must provide a documented reason for the audit trail.
	 */
	waiveComplianceRequirement(unitId: string, requirementId: string, waivedBy: string, reason: string): void;
	/** All units that have a compliance gate in FAIL or PARTIAL state */
	getComplianceGateFailures(): Array<{ unitId: string; result: IComplianceGateResult }>;

	// ── Checkpoints / snapshots ───────────────────────────────────────────

	/**
	 * Snapshot the current KB state under a named label.
	 * Stored in workspace storage. Used before risky bulk operations.
	 */
	createCheckpoint(label: string, triggeredBy?: string): Promise<IKnowledgeBaseCheckpoint>;
	listCheckpoints(): IKnowledgeBaseCheckpoint[];
	getCheckpoint(checkpointId: string): IKnowledgeBaseCheckpoint | undefined;
	/** Restore KB to a checkpoint state. Current state is auto-snapshotted as 'pre-restore'. */
	restoreCheckpoint(checkpointId: string): Promise<void>;
	deleteCheckpoint(checkpointId: string): void;

	// ── Velocity tracking ─────────────────────────────────────────────────

	/**
	 * Record a data point for velocity calculation (called automatically by status transitions).
	 * Can also be called manually for backfill.
	 */
	recordVelocityDataPoint(unitsCompleted: number, periodStartMs: number, periodEndMs: number): void;
	/**
	 * Get velocity metrics: units/day, rolling average, ETA for full completion.
	 * @param windowDays  How many days of history to use for rolling average (default 7).
	 */
	getVelocityMetrics(windowDays?: number): IVelocityMetrics;

	// ── Stale unit detection ──────────────────────────────────────────────

	/**
	 * Find units that have been stuck in a non-terminal status longer than thresholdMs.
	 * @param thresholdMs  How long is "too long" in milliseconds (default 24 hours).
	 */
	getStaleUnits(thresholdMs?: number): IStaleUnitReport[];

	// ── Work packages ─────────────────────────────────────────────────────

	/** Create an ad-hoc grouping of units (e.g. sprint / team member assignment) */
	createWorkPackage(pkg: Omit<IWorkPackage, 'id' | 'createdAt'>): IWorkPackage;
	updateWorkPackage(id: string, patch: Partial<Omit<IWorkPackage, 'id' | 'createdAt'>>): void;
	getWorkPackage(id: string): IWorkPackage | undefined;
	getAllWorkPackages(): IWorkPackage[];
	deleteWorkPackage(id: string): void;
	addUnitToWorkPackage(pkgId: string, unitId: string): void;
	removeUnitFromWorkPackage(pkgId: string, unitId: string): void;
	/** Which work package contains a unit (if any) */
	getWorkPackageForUnit(unitId: string): IWorkPackage | undefined;
	/** All units belonging to a work package */
	getUnitsByWorkPackage(pkgId: string): IKnowledgeUnit[];

	// ── Unit splitting and merging ────────────────────────────────────────

	/**
	 * Split a "god unit" into N sub-units.
	 * Parent unit is moved to 'skipped'; sub-units are created as new pending units.
	 * @returns The IDs of the new sub-units.
	 */
	splitUnit(unitId: string, subUnits: Array<Omit<IKnowledgeUnit, 'id' | 'createdAt' | 'updatedAt'>>): string[];
	/**
	 * Merge several over-decomposed units into one.
	 * Source units are moved to 'skipped'; the merged unit is created as pending.
	 * @returns The ID of the merged unit.
	 */
	mergeUnits(unitIds: string[], merged: Omit<IKnowledgeUnit, 'id' | 'createdAt' | 'updatedAt'>): string;

	// ── Export / Import ───────────────────────────────────────────────────

	/** Full KB export as a JSON string (for backup / handoff) */
	exportKB(): string;
	/** Import a full KB export — replaces the current KB. Creates a checkpoint first. */
	importKB(json: string): Promise<void>;
	/** Merge decisions from another KB export into this one (no unit overwrite) */
	mergeDecisionsFrom(json: string): void;
	/** Export only the decision log as a portable JSON string */
	exportDecisions(): string;
	/** Import decisions from an exportDecisions() payload — merges, skipping duplicates */
	importDecisions(json: string): void;

	// ── Health check ──────────────────────────────────────────────────────

	/**
	 * Run a full KB integrity check:
	 * - Orphaned unit references in files
	 * - Stale locks (TTL expired but not pruned)
	 * - Broken audit chain (hash mismatch)
	 * - Units referencing non-existent dependencies
	 * - Decision conflicts
	 * - Stale units stuck in non-terminal statuses
	 */
	runHealthCheck(): IKBHealthReport;
	/** Most recent health check result (cached, not re-run) */
	getLastHealthCheck(): IKBHealthReport | undefined;
	/**
	 * Force a full in-memory index rebuild from the current KB state.
	 * Admin / recovery method — use after manual data repairs or import operations.
	 * Expensive on very large KBs (>50k units). Normal mutations stay indexed automatically.
	 */
	rebuildIndexes(): void;

	// ── Cycle detection ───────────────────────────────────────────────────

	/**
	 * Detect circular dependency chains in the unit graph.
	 * Returns all cycles as arrays of unit IDs forming the cycle.
	 * An empty result means the graph is a valid DAG.
	 */
	findDependencyCycles(): string[][];

	// ── Token estimation ──────────────────────────────────────────────────

	/**
	 * Rough token estimate for a string using the ~4 chars/token heuristic.
	 * Used by getContextForBudget and can be called by agents for budget planning.
	 */
	estimateTokens(text: string): number;
}
