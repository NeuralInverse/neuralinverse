/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * KnowledgeBaseImpl — Production implementation of IKnowledgeBaseService.
 *
 * Composes focused sub-modules:
 *   impl/persistence.ts       — storage load/save/migrate
 *   impl/indexes.ts           — fast in-memory lookups
 *   impl/auditLog.ts          — tamper-evident audit chain
 *   impl/progressTracker.ts   — progress counts + phase tracking + stats
 *   impl/dependencies.ts      — dependency graph traversal
 *   impl/contextAssembler.ts  — LLM context assembly
 *   impl/queryEngine.ts       — filter + search
 *   impl/locking.ts           — unit locking (multi-agent concurrency)
 *   impl/sourceDrift.ts       — source file drift detection
 *   impl/decisionAnalysis.ts  — conflict detection, impact analysis, cycle detection
 *   impl/contextBudget.ts     — token-budget-aware context assembly
 *   impl/annotations.ts       — unit annotations and tags
 *   impl/complianceGates.ts   — compliance gate verification
 *   impl/checkpoints.ts       — KB snapshots
 *   impl/velocity.ts          — migration velocity tracking
 *   impl/staleDetection.ts    — stale unit detection
 *   impl/workPackages.ts      — work package management
 *   impl/splitMerge.ts        — unit splitting and merging
 *   impl/importExport.ts      — KB export/import/mergeDecisions
 *   impl/healthCheck.ts       — data integrity checks
 */

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
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
	IPendingDecision,
	IKnowledgeAuditEntry,
	IUnitInterface,
	UnitStatus,
	RiskLevel,
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
	IWorkPackage,
	IStaleUnitReport,
	emptyExtensions,
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
	IKnowledgeBaseService,
	IResolvedUnitContext,
	IKnowledgeBaseStats,
	IDependencyNode,
	IKnowledgeBaseSessionIndex,
	IUnitFilterCriteria,
	IDecisionImpactResult,
	IBudgetedUnitContext,
} from './service.js';
import {
	createIndexes,
	clearIndexes,
	rebuildIndexes,
	indexUnit,
	deindexUnit,
	indexTypeMappingDecision,
	removeTypeMappingFromIndex,
	indexNamingDecision,
	removeNamingFromIndex,
	indexUnitForDomain,
	indexUnitsForDomain,
	setPhaseIndex,
	clearPhaseIndexes,
	IKnowledgeBaseIndexes,
} from './impl/indexes.js';
import {
	loadOrCreate,
	flush,
	deleteFromStorage,
	loadSessionIndex,
	upsertSessionInIndex,
	removeSessionFromIndex,
	SAVE_DEBOUNCE_MS,
} from './impl/persistence.js';
import {
	appendAuditEntry,
	queryAuditLog,
	verifyAuditLogIntegrity,
} from './impl/auditLog.js';
import {
	updateProgress,
	updatePhaseProgress,
	updateAllPhaseProgress,
	phasesToProgress,
	computeStats,
} from './impl/progressTracker.js';
import {
	getDependencies,
	getDependents,
	getTransitiveDependencies,
	getImpactChain,
	getDependencyTree,
	getTopologicalOrder,
	getTranslatableUnits,
	getNextUnit as _getNextUnit,
} from './impl/dependencies.js';
import {
	getResolvedContext,
	getDecisionsForUnit,
	exportDecisionsAsContext,
	exportGlossaryAsContext,
} from './impl/contextAssembler.js';
import {
	getByStatus,
	getByRisk,
	getByDomain,
	getByLanguage,
	getByFile,
	getByPhase,
	searchUnits,
	filterUnits,
} from './impl/queryEngine.js';
import {
	emptyDecisionLog,
	PRIORITY_ORDER,
	makeAuditEntry,
} from './impl/helpers.js';
import {
	createLockStore,
	lockUnit as _lockUnit,
	unlockUnit as _unlockUnit,
	forceUnlockUnit as _forceUnlockUnit,
	getLock as _getLock,
	isUnitLocked as _isUnitLocked,
	releaseAllLocksFor as _releaseAllLocksFor,
	pruneExpiredLocks as _pruneExpiredLocks,
	getAllLocks as _getAllLocks,
	ILockStore,
} from './impl/locking.js';
import {
	createDriftStore,
	recordSourceVersion as _recordSourceVersion,
	getSourceVersion as _getSourceVersion,
	checkSourceDrift as _checkSourceDrift,
	checkAllSourceDrift as _checkAllSourceDrift,
	acknowledgeDriftAlert as _acknowledgeDriftAlert,
	getDriftAlerts as _getDriftAlerts,
	getUnitsAffectedByDrift as _getUnitsAffectedByDrift,
	IDriftStore,
} from './impl/sourceDrift.js';
import {
	createConflictStore,
	detectDecisionConflicts as _detectDecisionConflicts,
	getDecisionConflict as _getDecisionConflict,
	getDecisionConflicts as _getDecisionConflicts,
	resolveDecisionConflict as _resolveDecisionConflict,
	getDecisionImpact as _getDecisionImpact,
	findDependencyCycles as _findDependencyCycles,
	IConflictStore,
} from './impl/decisionAnalysis.js';
import {
	assembleWithBudget,
	estimateTokens as _estimateTokens,
} from './impl/contextBudget.js';
import {
	createAnnotationStore,
	addAnnotation as _addAnnotation,
	updateAnnotation as _updateAnnotation,
	deleteAnnotation as _deleteAnnotation,
	getAnnotations as _getAnnotations,
	getContextAnnotations as _getContextAnnotations,
	createTag as _createTag,
	addTagToUnit as _addTagToUnit,
	removeTagFromUnit as _removeTagFromUnit,
	deleteTag as _deleteTag,
	getTag as _getTag,
	getAllTags as _getAllTags,
	getTagsForUnit as _getTagsForUnit,
	getUnitsByTag as _getUnitsByTag,
	annotationStoreToExt,
	extToAnnotationStore,
	IAnnotationStore,
} from './impl/annotations.js';
import {
	createGateStore,
	checkComplianceGate as _checkComplianceGate,
	recordComplianceApproval as _recordComplianceApproval,
	getComplianceGateFailures as _getComplianceGateFailures,
	IGateStore,
} from './impl/complianceGates.js';
import {
	createCheckpointStore,
	createCheckpoint as _createCheckpoint,
	listCheckpoints as _listCheckpoints,
	getCheckpoint as _getCheckpoint,
	restoreCheckpoint as _restoreCheckpoint,
	deleteCheckpoint as _deleteCheckpoint,
	loadCheckpointIndex,
	ICheckpointStore,
} from './impl/checkpoints.js';
import {
	createVelocityStore,
	recordVelocityDataPoint as _recordVelocityDataPoint,
	getVelocityMetrics as _getVelocityMetrics,
	IVelocityStore,
} from './impl/velocity.js';
import { getStaleUnits as _getStaleUnits } from './impl/staleDetection.js';
import {
	createWorkPackageStore,
	createWorkPackage as _createWorkPackage,
	updateWorkPackage as _updateWorkPackage,
	getWorkPackage as _getWorkPackage,
	getAllWorkPackages as _getAllWorkPackages,
	deleteWorkPackage as _deleteWorkPackage,
	addUnitToWorkPackage as _addUnitToWorkPackage,
	removeUnitFromWorkPackage as _removeUnitFromWorkPackage,
	getWorkPackageForUnit as _getWorkPackageForUnit,
	IWorkPackageStore,
} from './impl/workPackages.js';
import {
	splitUnit as _splitUnit,
	mergeUnits as _mergeUnits,
} from './impl/splitMerge.js';
import {
	exportKB as _exportKB,
	importKB as _importKB,
	mergeDecisionsFrom as _mergeDecisionsFrom,
	exportDecisions as _exportDecisions,
	importDecisions as _importDecisions,
} from './impl/importExport.js';
import { runHealthCheck as _runHealthCheck } from './impl/healthCheck.js';


// ─── Implementation ───────────────────────────────────────────────────────────

export class KnowledgeBaseImpl extends Disposable implements IKnowledgeBaseService {
	declare readonly _serviceBrand: undefined;

	// ── Events ─────────────────────────────────────────────────────────────
	private readonly _onDidChange                 = this._register(new Emitter<void>());
	private readonly _onDidChangeUnitStatus       = this._register(new Emitter<{ unitId: string; prev: UnitStatus; next: UnitStatus }>());
	private readonly _onDidRaisePendingDecision   = this._register(new Emitter<IPendingDecision>());
	private readonly _onDidResolvePendingDecision = this._register(new Emitter<string>());

	readonly onDidChange                 = this._onDidChange.event;
	readonly onDidChangeUnitStatus       = this._onDidChangeUnitStatus.event;
	readonly onDidRaisePendingDecision   = this._onDidRaisePendingDecision.event;
	readonly onDidResolvePendingDecision = this._onDidResolvePendingDecision.event;

	// ── Core state ─────────────────────────────────────────────────────────
	private _kb: IModernisationKnowledgeBase | undefined;
	private _idx: IKnowledgeBaseIndexes = createIndexes();
	private _saveTimer: ReturnType<typeof setTimeout> | undefined;
	/** When true, all dirty/progress updates are deferred until batch ends */
	private _batchMode = false;

	// ── Production feature stores (in-memory, rebuilt from ext on init) ────
	private _lockStore:        ILockStore        = createLockStore();
	private _driftStore:       IDriftStore       = createDriftStore();
	private _conflictStore:    IConflictStore    = createConflictStore();
	private _annotationStore:  IAnnotationStore  = createAnnotationStore();
	private _gateStore:        IGateStore        = createGateStore();
	private _checkpointStore:  ICheckpointStore  = createCheckpointStore();
	private _velocityStore:    IVelocityStore    = createVelocityStore();
	private _wpStore:          IWorkPackageStore = createWorkPackageStore();
	private _lastHealthCheck:  IKBHealthReport | undefined;

	constructor(@IStorageService private readonly _storage: IStorageService) {
		super();
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────

	async init(sessionId: string): Promise<void> {
		const { kb, isNew } = loadOrCreate(sessionId, this._storage);
		this._kb = kb;
		rebuildIndexes(kb, this._idx);
		this._restoreExtStores(kb);
		loadCheckpointIndex(this._checkpointStore, this._storage);
		if (isNew) {
			this._scheduleSave();
			upsertSessionInIndex(kb, this._storage);
		}
	}

	get isActive(): boolean { return !!this._kb; }

	get kb(): IModernisationKnowledgeBase {
		if (!this._kb) { throw new Error('[KnowledgeBase] Not initialised — call init() first'); }
		return this._kb;
	}

	close(): void {
		if (!this._kb) { return; }
		this._syncExtStores();
		this._flushNow();
		clearIndexes(this._idx);
		this._kb = undefined;
	}

	async reset(sessionId: string): Promise<void> {
		deleteFromStorage(sessionId, this._storage);
		removeSessionFromIndex(sessionId, this._storage);
		this._resetStores();
		await this.init(sessionId);
	}

	deleteSession(sessionId: string): void {
		deleteFromStorage(sessionId, this._storage);
		removeSessionFromIndex(sessionId, this._storage);
		if (this._kb?.sessionId === sessionId) {
			clearIndexes(this._idx);
			this._resetStores();
			this._kb = undefined;
		}
	}

	listSessions(): IKnowledgeBaseSessionIndex {
		return loadSessionIndex(this._storage);
	}

	// ── Batch mode ─────────────────────────────────────────────────────────

	batchBegin(): void {
		this._batchMode = true;
	}

	batchEnd(): void {
		if (!this._batchMode) { return; }
		this._batchMode = false;
		updateProgress(this.kb);
		updateAllPhaseProgress(this.kb.progress, this._idx.byPhase, this.kb.units);
		this.kb.updatedAt = Date.now();
		this._onDidChange.fire();
		this._scheduleSave();
	}

	// ── Unit CRUD ──────────────────────────────────────────────────────────

	addUnit(unit: IKnowledgeUnit): void {
		this.kb.units.set(unit.id, unit);
		indexUnit(unit, this._idx);
		this._dirtyProgress();
		this._auditEntry('unit-discovered', `Discovered: ${unit.name} (${unit.unitType}, ${unit.sourceLang})`,
			{ unitId: unit.id, unitType: unit.unitType, lang: unit.sourceLang, risk: unit.riskLevel }, unit.id);
		this._markDirty();
	}

	addUnits(units: IKnowledgeUnit[]): void {
		if (units.length === 0) { return; }
		this._batch(() => {
			for (const u of units) {
				this.kb.units.set(u.id, u);
				indexUnit(u, this._idx);
			}
		});
		this._auditEntry('unit-discovered', `Batch import: ${units.length} units`, { count: units.length });
		this._markDirty();
	}

	updateUnit(unitId: string, patch: Partial<IKnowledgeUnit>): void {
		const unit = this.kb.units.get(unitId);
		if (!unit) { return; }
		deindexUnit(unit, this._idx);
		Object.assign(unit, patch, { updatedAt: Date.now() });
		indexUnit(unit, this._idx);
		if (!this._batchMode) {
			this._dirtyProgress();
			this._markDirty();
		}
	}

	updateUnits(updates: Array<{ id: string; patch: Partial<IKnowledgeUnit> }>): void {
		if (updates.length === 0) { return; }
		this._batch(() => {
			for (const { id, patch } of updates) { this.updateUnit(id, patch); }
		});
		this._markDirty();
	}

	getUnit(unitId: string): IKnowledgeUnit | undefined {
		return this.kb.units.get(unitId);
	}

	hasUnit(unitId: string): boolean {
		return this.kb.units.has(unitId);
	}

	deleteUnit(unitId: string): void {
		const unit = this.kb.units.get(unitId);
		if (!unit) { return; }
		deindexUnit(unit, this._idx);
		this.kb.units.delete(unitId);
		this._dirtyProgress();
		this._markDirty();
	}

	getAllUnits(): IKnowledgeUnit[] {
		return Array.from(this.kb.units.values());
	}

	// ── File registry ──────────────────────────────────────────────────────

	addFile(file: IKnowledgeFile): void {
		this.kb.files.set(file.path, file);
		this._markDirty();
	}

	updateFile(path: string, patch: Partial<IKnowledgeFile>): void {
		const f = this.kb.files.get(path);
		if (!f) { return; }
		Object.assign(f, patch);
		this._markDirty();
	}

	getFile(path: string): IKnowledgeFile | undefined {
		return this.kb.files.get(path);
	}

	getAllFiles(): IKnowledgeFile[] {
		return Array.from(this.kb.files.values());
	}

	getUnitsForFile(filePath: string): IKnowledgeUnit[] {
		return getByFile(filePath, this._idx, this.kb.units);
	}

	// ── Translation recording ──────────────────────────────────────────────

	recordTranslation(unitId: string, targetCode: string, targetFile: string, targetRange?: ICodeRange): void {
		this.updateUnit(unitId, { targetText: targetCode, targetFile, ...(targetRange ? { targetRange } : {}) });
		this._auditEntry('translation-recorded', `Translation: ${unitId} → ${targetFile}`,
			{ unitId, targetFile, codeLength: targetCode.length }, unitId);
	}

	recordBusinessRule(unitId: string, rule: IBusinessRule): void {
		const unit = this.getUnit(unitId);
		if (!unit) { return; }
		const i = unit.businessRules.findIndex(r => r.id === rule.id);
		if (i >= 0) { unit.businessRules[i] = rule; }
		else        { unit.businessRules = [...unit.businessRules, rule]; }
		unit.updatedAt = Date.now();
		if (rule.domain) { indexUnitForDomain(unitId, rule.domain, this._idx); }
		this._auditEntry('business-rule-recorded', `Rule: "${rule.description.slice(0, 70)}"`,
			{ unitId, ruleId: rule.id, domain: rule.domain }, unitId);
		this._markDirty();
	}

	recordBusinessRules(unitId: string, rules: IBusinessRule[]): void {
		this._batch(() => {
			for (const r of rules) { this.recordBusinessRule(unitId, r); }
		});
		this._markDirty();
	}

	recordFingerprint(unitId: string, fingerprint: IComplianceFingerprint): void {
		this.updateUnit(unitId, { fingerprint });
		this._auditEntry('fingerprint-recorded', `Fingerprint: ${unitId}`,
			{ unitId, domains: fingerprint.complianceDomains }, unitId);
	}

	recordFingerprintComparison(unitId: string, comparison: IFingerprintComparison): void {
		this.updateUnit(unitId, { fingerprintComparison: comparison });
		this._auditEntry('fingerprint-comparison-recorded',
			`Fingerprint comparison: ${comparison.overallResult} (${comparison.matchPercentage.toFixed(1)}%)`,
			{ unitId, result: comparison.overallResult, matchPct: comparison.matchPercentage }, unitId);
	}

	recordEquivalence(unitId: string, result: IEquivalenceResult): void {
		this.updateUnit(unitId, { equivalenceResult: result });
		this._auditEntry('equivalence-recorded',
			`Equivalence: ${result.passCount}/${result.testCaseCount} passed`,
			{ unitId, pass: result.passCount, total: result.testCaseCount }, unitId);
	}

	recordInterface(unitId: string, iface: IUnitInterface): void {
		this.updateUnit(unitId, { targetInterface: iface });
	}

	addApproval(unitId: string, approval: IApprovalRecord): void {
		const unit = this.getUnit(unitId);
		if (!unit) { return; }
		unit.approvals = [...unit.approvals, approval];
		unit.updatedAt = Date.now();
		this._auditEntry('unit-approved', `Approved by ${approval.approvedBy} (${approval.approvalType})`,
			{ unitId, approvalType: approval.approvalType }, unitId, approval.approvedBy);
		this._markDirty();
	}

	// ── Status transitions ─────────────────────────────────────────────────

	setUnitStatus(unitId: string, status: UnitStatus, reason?: string, actor = 'system'): void {
		const unit = this.getUnit(unitId);
		if (!unit) { return; }
		const prev = unit.status;
		if (prev === status) { return; }
		deindexUnit(unit, this._idx);
		unit.status    = status;
		unit.updatedAt = Date.now();
		if (reason) { unit.blockedReason = reason; }
		else if (status !== 'blocked') { unit.blockedReason = undefined; }
		indexUnit(unit, this._idx);
		this._onDidChangeUnitStatus.fire({ unitId, prev, next: status });
		this._auditEntry('unit-status-changed',
			`${unit.name}: ${prev} → ${status}${reason ? ` (${reason})` : ''}`,
			{ unitId, prev, next: status, reason }, unitId, actor);
		if (!this._batchMode) {
			this._dirtyProgress();
			this._markDirty();
		}
	}

	setUnitsStatus(unitIds: string[], status: UnitStatus, actor = 'system'): void {
		this._batch(() => {
			for (const id of unitIds) { this.setUnitStatus(id, status, undefined, actor); }
		});
		this._markDirty();
	}

	flagBlocked(unitId: string, reason: string, pendingDecision: IPendingDecision): void {
		const unit = this.getUnit(unitId);
		if (!unit) { return; }
		const prev = unit.status;
		deindexUnit(unit, this._idx);
		unit.status           = 'blocked';
		unit.blockedReason    = reason;
		unit.pendingDecisionId = pendingDecision.id;
		unit.updatedAt        = Date.now();
		indexUnit(unit, this._idx);
		this.addPendingDecision(pendingDecision);
		this._onDidChangeUnitStatus.fire({ unitId, prev, next: 'blocked' });
		this._auditEntry('unit-blocked', `Blocked: ${unit.name} — ${reason}`,
			{ unitId, reason, decisionId: pendingDecision.id }, unitId);
		this._dirtyProgress();
		this._markDirty();
	}

	markResolved(unitId: string, actor = 'system'): void {
		this.setUnitStatus(unitId, 'ready', undefined, actor);
	}

	// ── Decision recording ─────────────────────────────────────────────────

	recordTypeMappingDecision(decision: ITypeMappingDecision): void {
		const i = this.kb.decisions.typeMapping.findIndex(d => d.id === decision.id);
		if (i >= 0) { this.kb.decisions.typeMapping[i] = decision; }
		else        { this.kb.decisions.typeMapping.push(decision); }
		indexTypeMappingDecision(decision, this._idx);
		// Auto-detect conflicts on every decision change
		const conflicts = _detectDecisionConflicts(this._conflictStore, this.kb.decisions);
		if (conflicts.length > 0) { this.kb.ext.decisionConflicts = _getDecisionConflicts(this._conflictStore); }
		this._auditEntry('decision-recorded', `Type mapping: ${decision.sourceType} → ${decision.targetType}`,
			{ id: decision.id, type: 'type-mapping', source: decision.sourceType, target: decision.targetType },
			undefined, decision.decidedBy);
		this._markDirty();
	}

	recordNamingDecision(decision: INamingDecision): void {
		const i = this.kb.decisions.naming.findIndex(d => d.id === decision.id);
		if (i >= 0) { this.kb.decisions.naming[i] = decision; }
		else        { this.kb.decisions.naming.push(decision); }
		indexNamingDecision(decision, this._idx);
		// Auto-detect conflicts on every decision change
		const conflicts = _detectDecisionConflicts(this._conflictStore, this.kb.decisions);
		if (conflicts.length > 0) { this.kb.ext.decisionConflicts = _getDecisionConflicts(this._conflictStore); }
		this._auditEntry('decision-recorded', `Naming: ${decision.sourceName} → ${decision.targetName} [${decision.domain}]`,
			{ id: decision.id, type: 'naming', source: decision.sourceName, target: decision.targetName },
			undefined, decision.decidedBy);
		this._markDirty();
	}

	recordRuleInterpretation(interp: IRuleInterpretation): void {
		const i = this.kb.decisions.ruleInterpret.findIndex(d => d.id === interp.id);
		if (i >= 0) { this.kb.decisions.ruleInterpret[i] = interp; }
		else        { this.kb.decisions.ruleInterpret.push(interp); }
		this._auditEntry('decision-recorded', `Rule interpretation: ${interp.meaning.slice(0, 70)}`,
			{ id: interp.id, type: 'rule-interpretation', unitId: interp.unitId }, interp.unitId, interp.decidedBy);
		this._markDirty();
	}

	recordExclusion(exclusion: IExclusionDecision): void {
		this.kb.decisions.exclusions.push(exclusion);
		this._markDirty();
	}

	recordPatternOverride(override: IPatternOverride): void {
		const i = this.kb.decisions.patternOverrides.findIndex(d => d.id === override.id);
		if (i >= 0) { this.kb.decisions.patternOverrides[i] = override; }
		else        { this.kb.decisions.patternOverrides.push(override); }
		this._markDirty();
	}

	removeTypeMappingDecision(id: string): void {
		const i = this.kb.decisions.typeMapping.findIndex(d => d.id === id);
		if (i < 0) { return; }
		const [removed] = this.kb.decisions.typeMapping.splice(i, 1);
		removeTypeMappingFromIndex(removed.sourceType, this._idx);
		this._markDirty();
	}

	removeNamingDecision(id: string): void {
		const i = this.kb.decisions.naming.findIndex(d => d.id === id);
		if (i < 0) { return; }
		const [removed] = this.kb.decisions.naming.splice(i, 1);
		removeNamingFromIndex(removed.sourceName, this._idx);
		this._markDirty();
	}

	getDecisions(): IDecisionLog { return this.kb.decisions; }

	findTypeMappingDecision(sourceType: string): ITypeMappingDecision | undefined {
		return this._idx.typeMappingBySource.get(sourceType.toLowerCase());
	}

	findNamingDecision(sourceName: string): INamingDecision | undefined {
		return this._idx.namingBySource.get(sourceName.toLowerCase());
	}

	getDecisionsForUnit(unitId: string): IDecisionLog {
		return getDecisionsForUnit(unitId, this.kb);
	}

	// ── Glossary & Domains ────────────────────────────────────────────────

	recordGlossaryTerm(term: IBusinessTerm): void {
		const i = this.kb.glossary.terms.findIndex(t => t.term.toLowerCase() === term.term.toLowerCase());
		if (i >= 0) { this.kb.glossary.terms[i] = term; }
		else        { this.kb.glossary.terms.push(term); }
		this._auditEntry('glossary-term-recorded', `Glossary: "${term.term}" — "${term.meaning.slice(0, 60)}"`,
			{ term: term.term, domain: term.domain, source: term.extractedBy });
		this._markDirty();
	}

	recordGlossaryTerms(terms: IBusinessTerm[]): void {
		this._batch(() => {
			for (const t of terms) { this.recordGlossaryTerm(t); }
		});
		this._markDirty();
	}

	getGlossaryTerm(term: string): IBusinessTerm | undefined {
		return this.kb.glossary.terms.find(t => t.term.toLowerCase() === term.toLowerCase());
	}

	recordRecognisedPattern(pattern: IRecognisedPattern): void {
		const i = this.kb.glossary.patterns.findIndex(p => p.name === pattern.name);
		if (i >= 0) { this.kb.glossary.patterns[i] = pattern; }
		else        { this.kb.glossary.patterns.push(pattern); }
		this._markDirty();
	}

	addDomain(domain: IBusinessDomain): void {
		const i = this.kb.glossary.domains.findIndex(d => d.name === domain.name);
		if (i >= 0) { this.kb.glossary.domains[i] = domain; }
		else        { this.kb.glossary.domains.push(domain); }
		indexUnitsForDomain(domain.unitIds, domain.name, this._idx);
		this._markDirty();
	}

	updateDomain(name: string, patch: Partial<IBusinessDomain>): void {
		const d = this.kb.glossary.domains.find(d => d.name === name);
		if (!d) { return; }
		Object.assign(d, patch);
		this._markDirty();
	}

	getDomain(name: string): IBusinessDomain | undefined {
		return this.kb.glossary.domains.find(d => d.name === name);
	}

	getAllDomains(): IBusinessDomain[] { return this.kb.glossary.domains; }

	assignUnitToDomain(unitId: string, domainName: string): void {
		let domain = this.getDomain(domainName);
		if (!domain) {
			domain = { name: domainName, description: '', unitIds: [], regulated: false, complianceFrameworks: [] };
			this.kb.glossary.domains.push(domain);
		}
		if (!domain.unitIds.includes(unitId)) { domain.unitIds.push(unitId); }
		indexUnitForDomain(unitId, domainName, this._idx);
		this._markDirty();
	}

	getGlossary(domain?: string): IBusinessGlossary {
		if (!domain) { return this.kb.glossary; }
		return {
			terms:   this.kb.glossary.terms.filter(t => t.domain === domain),
			domains: this.kb.glossary.domains.filter(d => d.name === domain),
			patterns: this.kb.glossary.patterns,
		};
	}

	// ── Pending decisions ──────────────────────────────────────────────────

	addPendingDecision(decision: IPendingDecision): void {
		if (this.kb.progress.pendingDecisions.some(d => d.id === decision.id)) { return; }
		this.kb.progress.pendingDecisions.push(decision);
		this._onDidRaisePendingDecision.fire(decision);
		this._auditEntry('pending-decision-raised',
			`Decision [${decision.priority}]: ${decision.question.slice(0, 80)}`,
			{ id: decision.id, type: decision.type, priority: decision.priority }, decision.unitId);
		this._markDirty();
	}

	resolvePendingDecision(decisionId: string, actor = 'system'): void {
		const i = this.kb.progress.pendingDecisions.findIndex(d => d.id === decisionId);
		if (i < 0) { return; }
		const [resolved] = this.kb.progress.pendingDecisions.splice(i, 1);
		// Unblock units that were waiting for this decision
		this.kb.units.forEach(unit => {
			if (unit.pendingDecisionId === decisionId && unit.status === 'blocked') {
				deindexUnit(unit, this._idx);
				unit.pendingDecisionId = undefined;
				unit.blockedReason     = undefined;
				unit.status            = 'ready';
				unit.updatedAt         = Date.now();
				indexUnit(unit, this._idx);
				this._onDidChangeUnitStatus.fire({ unitId: unit.id, prev: 'blocked', next: 'ready' });
			}
		});
		this._onDidResolvePendingDecision.fire(decisionId);
		this._auditEntry('pending-decision-resolved', `Decision resolved: ${resolved.question.slice(0, 70)}`,
			{ id: decisionId, type: resolved.type, unitId: resolved.unitId }, resolved.unitId, actor);
		this._dirtyProgress();
		this._markDirty();
	}

	getPendingDecision(id: string): IPendingDecision | undefined {
		return this.kb.progress.pendingDecisions.find(d => d.id === id);
	}

	getPendingDecisions(priority?: IPendingDecision['priority']): IPendingDecision[] {
		const list = priority
			? this.kb.progress.pendingDecisions.filter(d => d.priority === priority)
			: [...this.kb.progress.pendingDecisions];
		return list.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
	}

	getPendingDecisionForUnit(unitId: string): IPendingDecision | undefined {
		const unit = this.getUnit(unitId);
		if (!unit?.pendingDecisionId) { return undefined; }
		return this.getPendingDecision(unit.pendingDecisionId);
	}

	// ── Phase management ───────────────────────────────────────────────────

	setPhases(phases: IMigrationPhase[]): void {
		this.kb.progress.byPhase = phasesToProgress(phases);
		clearPhaseIndexes(this._idx);
		for (const p of phases) { setPhaseIndex(p.id, p.unitIds, this._idx); }
		updateAllPhaseProgress(this.kb.progress, this._idx.byPhase, this.kb.units);
		this._markDirty();
	}

	updatePhaseProgress(phaseId: string): void {
		updatePhaseProgress(phaseId, this.kb.progress, this._idx.byPhase, this.kb.units);
	}

	recalculateAllPhases(): void {
		updateAllPhaseProgress(this.kb.progress, this._idx.byPhase, this.kb.units);
	}

	// ── Dependency graph ───────────────────────────────────────────────────

	getDependencies(unitId: string): IKnowledgeUnit[] { return getDependencies(unitId, this.kb.units); }
	getTransitiveDependencies(unitId: string): IKnowledgeUnit[] { return getTransitiveDependencies(unitId, this.kb.units); }
	getDependents(unitId: string): IKnowledgeUnit[] { return getDependents(unitId, this.kb.units); }
	getImpactChain(unitId: string): IKnowledgeUnit[] { return getImpactChain(unitId, this.kb.units); }

	getDependencyTree(unitId: string, maxDepth = 10): IDependencyNode {
		return getDependencyTree(unitId, this.kb.units, maxDepth);
	}

	getTopologicalOrder(): IKnowledgeUnit[] { return getTopologicalOrder(this.kb.units); }
	getTranslatableUnits(): IKnowledgeUnit[] { return getTranslatableUnits(this.kb.units); }

	getNextUnit(options?: { riskLevel?: RiskLevel; domain?: string; language?: string }): IKnowledgeUnit | undefined {
		return _getNextUnit(this.kb.units, this._idx.byDomain, options);
	}

	// ── Query ──────────────────────────────────────────────────────────────

	getUnitsByStatus(status: UnitStatus): IKnowledgeUnit[] { return getByStatus(status, this._idx, this.kb.units); }
	getUnitsByRisk(risk: RiskLevel): IKnowledgeUnit[]       { return getByRisk(risk, this._idx, this.kb.units); }
	getUnitsByDomain(domain: string): IKnowledgeUnit[]      { return getByDomain(domain, this._idx, this.kb.units); }
	getUnitsByLanguage(language: string): IKnowledgeUnit[]  { return getByLanguage(language, this._idx, this.kb.units); }
	getUnitsByFile(filePath: string): IKnowledgeUnit[]      { return getByFile(filePath, this._idx, this.kb.units); }
	getUnitsByPhase(phaseId: string): IKnowledgeUnit[]      { return getByPhase(phaseId, this._idx, this.kb.units); }
	getBlockedUnits(): IKnowledgeUnit[]  { return getByStatus('blocked', this._idx, this.kb.units); }
	getReadyUnits(): IKnowledgeUnit[]    { return getByStatus('ready',   this._idx, this.kb.units); }
	getFlaggedUnits(): IKnowledgeUnit[]  { return getByStatus('flagged', this._idx, this.kb.units); }
	getApprovedUnits(): IKnowledgeUnit[] { return getByStatus('approved',this._idx, this.kb.units); }
	getCompleteUnits(): IKnowledgeUnit[] { return getByStatus('complete',this._idx, this.kb.units); }

	searchUnits(query: string): IKnowledgeUnit[] { return searchUnits(query, this.kb.units); }

	filterUnits(criteria: IUnitFilterCriteria): IKnowledgeUnit[] {
		let results = filterUnits(criteria, this.kb.units, this._idx);

		// Tag filter — not handled by base queryEngine (uses annotation store)
		if (criteria.tagId) {
			const taggedIds = new Set(_getUnitsByTag(this._annotationStore, criteria.tagId));
			results = results.filter(u => taggedIds.has(u.id));
		}

		// Locked filter
		if (criteria.unlockedOnly) {
			results = results.filter(u => !_isUnitLocked(this._lockStore, u.id));
		}

		// Drift filter
		if (criteria.driftedOnly) {
			const driftedPaths = new Set(_getUnitsAffectedByDrift(this._driftStore, this.kb.units).map(u => u.id));
			results = results.filter(u => driftedPaths.has(u.id));
		}

		// Work package filter
		if (criteria.workPackageId) {
			const pkg = _getWorkPackage(this._wpStore, criteria.workPackageId);
			if (!pkg) { return []; }
			const pkgUnitIds = new Set(pkg.unitIds);
			results = results.filter(u => pkgUnitIds.has(u.id));
		}

		return results;
	}

	// ── Context assembly ───────────────────────────────────────────────────

	getResolvedContext(unitId: string): IResolvedUnitContext {
		const ctx = getResolvedContext(unitId, this.kb);
		// Inject 'context-injection' annotations — agents rely on these for domain-specific
		// instructions (e.g. "always use BigDecimal for currency in this codebase")
		const contextAnnotations = _getAnnotations(this._annotationStore, unitId)
			.filter(a => a.kind === 'context-injection');
		return { ...ctx, contextAnnotations };
	}

	exportDecisionsAsContext(unitId?: string): string {
		return exportDecisionsAsContext(this.kb, unitId);
	}

	exportGlossaryAsContext(domain?: string): string {
		return exportGlossaryAsContext(this.kb, domain);
	}

	// ── Progress & stats ──────────────────────────────────────────────────

	getProgress(): IProgressState { return this.kb.progress; }

	getStats(): IKnowledgeBaseStats {
		return computeStats(this.kb, this._idx);
	}

	recomputeProgress(): void {
		updateProgress(this.kb);
		updateAllPhaseProgress(this.kb.progress, this._idx.byPhase, this.kb.units);
	}

	// ── Audit log ─────────────────────────────────────────────────────────

	getAuditLog(options?: { unitId?: string; limit?: number; offset?: number }): IKnowledgeAuditEntry[] {
		return queryAuditLog(this.kb.auditLog, options);
	}

	getAuditLogForUnit(unitId: string, limit = 50): IKnowledgeAuditEntry[] {
		return queryAuditLog(this.kb.auditLog, { unitId, limit });
	}

	verifyAuditLogIntegrity(): { valid: boolean; firstBrokenIndex: number | null } {
		return verifyAuditLogIntegrity(this.kb.auditLog);
	}

	// ── Unit locking ───────────────────────────────────────────────────────

	lockUnit(unitId: string, ownerId: string, ttlMs?: number): IUnitLock | undefined {
		return _lockUnit(this._lockStore, unitId, ownerId, ttlMs);
	}

	unlockUnit(unitId: string, ownerId: string): boolean {
		return _unlockUnit(this._lockStore, unitId, ownerId);
	}

	forceUnlockUnit(unitId: string): void {
		_forceUnlockUnit(this._lockStore, unitId);
	}

	getLock(unitId: string): IUnitLock | undefined {
		return _getLock(this._lockStore, unitId);
	}

	isUnitLocked(unitId: string): boolean {
		return _isUnitLocked(this._lockStore, unitId);
	}

	releaseAllLocksFor(ownerId: string): void {
		_releaseAllLocksFor(this._lockStore, ownerId);
	}

	pruneExpiredLocks(): number {
		return _pruneExpiredLocks(this._lockStore);
	}

	getAllLocks(): IUnitLock[] {
		return _getAllLocks(this._lockStore);
	}

	// ── Source drift ───────────────────────────────────────────────────────

	recordSourceVersion(filePath: string, contentHash: string, mtime: number, size: number): void {
		_recordSourceVersion(this._driftStore, filePath, contentHash, mtime, size);
		this.kb.ext.sourceVersions[filePath] = this._driftStore.sourceVersions.get(filePath)!;
		this._markDirty();
	}

	getSourceVersion(filePath: string): ISourceFileVersion | undefined {
		return _getSourceVersion(this._driftStore, filePath);
	}

	checkSourceDrift(filePath: string, currentHash: string, currentMtime: number): ISourceDriftAlert | undefined {
		const alert = _checkSourceDrift(this._driftStore, filePath, currentHash, currentMtime);
		if (alert) {
			this.kb.ext.driftAlerts[alert.id] = alert;
			this._auditEntry('drift-detected', `Source drift: ${filePath}`,
				{ filePath, baselineHash: alert.baselineHash, currentHash });
			this._markDirty();
		}
		return alert;
	}

	checkAllSourceDrift(currentFiles: Array<{ path: string; hash: string; mtime: number }>): ISourceDriftAlert[] {
		const alerts = _checkAllSourceDrift(this._driftStore, currentFiles);
		for (const alert of alerts) {
			this.kb.ext.driftAlerts[alert.id] = alert;
		}
		if (alerts.length > 0) { this._markDirty(); }
		return alerts;
	}

	acknowledgeDriftAlert(alertId: string, actor?: string): void {
		_acknowledgeDriftAlert(this._driftStore, alertId, actor);
		const updated = this._driftStore.driftAlerts.get(alertId);
		if (updated) {
			this.kb.ext.driftAlerts[alertId] = updated;
			this._auditEntry('drift-acknowledged', `Drift acknowledged: ${updated.filePath}`,
				{ alertId, filePath: updated.filePath }, undefined, actor);
			this._markDirty();
		}
	}

	getDriftAlerts(unacknowledgedOnly = false): ISourceDriftAlert[] {
		return _getDriftAlerts(this._driftStore, unacknowledgedOnly);
	}

	getUnitsAffectedByDrift(): IKnowledgeUnit[] {
		return _getUnitsAffectedByDrift(this._driftStore, this.kb.units);
	}

	// ── Decision conflicts ─────────────────────────────────────────────────

	detectDecisionConflicts(): IDecisionConflict[] {
		const conflicts = _detectDecisionConflicts(this._conflictStore, this.kb.decisions);
		this.kb.ext.decisionConflicts = _getDecisionConflicts(this._conflictStore);
		this._markDirty();
		return conflicts;
	}

	getDecisionConflict(conflictId: string): IDecisionConflict | undefined {
		return _getDecisionConflict(this._conflictStore, conflictId);
	}

	getDecisionConflicts(unresolvedOnly = false): IDecisionConflict[] {
		return _getDecisionConflicts(this._conflictStore, unresolvedOnly);
	}

	resolveDecisionConflict(conflictId: string, winningDecisionId: string, actor?: string): void {
		_resolveDecisionConflict(this._conflictStore, conflictId, winningDecisionId, actor);
		this.kb.ext.decisionConflicts = _getDecisionConflicts(this._conflictStore);
		this._markDirty();
	}

	getDecisionImpact(decisionId: string, decisionType: IDecisionConflict['decisionType']): IDecisionImpactResult {
		return _getDecisionImpact(this.kb.decisions, this.kb.units, decisionId, decisionType);
	}

	// ── Token-budget context ───────────────────────────────────────────────

	getContextForBudget(unitId: string, maxTokens: number): IBudgetedUnitContext {
		const base = getResolvedContext(unitId, this.kb);
		return assembleWithBudget(base, maxTokens);
	}

	// ── Annotations ───────────────────────────────────────────────────────

	addAnnotation(unitId: string, content: string, author: string, kind?: IUnitAnnotation['kind']): IUnitAnnotation {
		const ann = _addAnnotation(this._annotationStore, unitId, content, author, kind);
		this._syncAnnotationExt();
		this._markDirty();
		return ann;
	}

	updateAnnotation(annotationId: string, content: string): void {
		_updateAnnotation(this._annotationStore, annotationId, content);
		this._syncAnnotationExt();
		this._markDirty();
	}

	deleteAnnotation(annotationId: string): void {
		_deleteAnnotation(this._annotationStore, annotationId);
		this._syncAnnotationExt();
		this._markDirty();
	}

	getAnnotations(unitId: string): IUnitAnnotation[] {
		return _getAnnotations(this._annotationStore, unitId);
	}

	getContextAnnotations(kind: IUnitAnnotation['kind']): IUnitAnnotation[] {
		return _getContextAnnotations(this._annotationStore, kind);
	}

	// ── Tags ──────────────────────────────────────────────────────────────

	createTag(tag: Omit<IUnitTag, 'id' | 'createdAt'>): IUnitTag {
		const newTag = _createTag(this._annotationStore, tag);
		this._syncAnnotationExt();
		this._markDirty();
		return newTag;
	}

	addTagToUnit(unitId: string, tagId: string): void {
		_addTagToUnit(this._annotationStore, unitId, tagId);
		this._syncAnnotationExt();
		this._markDirty();
	}

	removeTagFromUnit(unitId: string, tagId: string): void {
		_removeTagFromUnit(this._annotationStore, unitId, tagId);
		this._syncAnnotationExt();
		this._markDirty();
	}

	deleteTag(tagId: string): void {
		_deleteTag(this._annotationStore, tagId);
		this._syncAnnotationExt();
		this._markDirty();
	}

	getTag(tagId: string): IUnitTag | undefined {
		return _getTag(this._annotationStore, tagId);
	}

	getAllTags(): IUnitTag[] {
		return _getAllTags(this._annotationStore);
	}

	getUnitsByTag(tagId: string): IKnowledgeUnit[] {
		const ids = _getUnitsByTag(this._annotationStore, tagId);
		return ids.map(id => this.kb.units.get(id)).filter((u): u is IKnowledgeUnit => !!u);
	}

	getTagsForUnit(unitId: string): IUnitTag[] {
		return _getTagsForUnit(this._annotationStore, unitId);
	}

	// ── Compliance gates ──────────────────────────────────────────────────

	checkComplianceGate(unitId: string): IComplianceGateResult {
		const unit = this.kb.units.get(unitId);
		if (!unit) { throw new Error(`checkComplianceGate: unit not found: ${unitId}`); }
		const domain = unit.domain ? this.getDomain(unit.domain) : undefined;
		const result = _checkComplianceGate(this._gateStore, unit, domain);
		this.kb.ext.gateResults[unitId] = result;
		this._auditEntry('compliance-gate-checked',
			`Compliance gate: ${unitId} — ${result.overallStatus}`,
			{ unitId, status: result.overallStatus, failedCount: result.failedCount }, unitId);
		this._markDirty();
		return result;
	}

	recordComplianceApproval(unitId: string, requirementId: string, approver: string, evidence?: string): void {
		_recordComplianceApproval(this._gateStore, unitId, requirementId, approver, evidence);
		const result = this._gateStore.gateResults.get(unitId);
		if (result) {
			this.kb.ext.gateResults[unitId] = result;
			this._markDirty();
		}
	}

	getComplianceGateFailures(): Array<{ unitId: string; result: IComplianceGateResult }> {
		return _getComplianceGateFailures(this._gateStore);
	}

	// ── Checkpoints ───────────────────────────────────────────────────────

	async createCheckpoint(label: string, triggeredBy?: string): Promise<IKnowledgeBaseCheckpoint> {
		this._syncExtStores(); // Ensure ext is up-to-date before snapshot
		const cp = await _createCheckpoint(this._checkpointStore, this._storage, this.kb, label, triggeredBy);
		this._auditEntry('checkpoint-created', `Checkpoint: "${label}"`,
			{ checkpointId: cp.id, unitCount: cp.unitCount });
		this._markDirty();
		return cp;
	}

	listCheckpoints(): IKnowledgeBaseCheckpoint[] {
		return _listCheckpoints(this._checkpointStore);
	}

	getCheckpoint(checkpointId: string): IKnowledgeBaseCheckpoint | undefined {
		return _getCheckpoint(this._checkpointStore, checkpointId);
	}

	async restoreCheckpoint(checkpointId: string): Promise<void> {
		this._syncExtStores();
		const restored = await _restoreCheckpoint(
			this._checkpointStore, this._storage, this.kb, checkpointId,
		);
		this._kb = restored;
		rebuildIndexes(restored, this._idx);
		this._resetStores();
		this._restoreExtStores(restored);
		this._auditEntry('checkpoint-restored', `Restored checkpoint: ${checkpointId}`,
			{ checkpointId });
		this._markDirty();
	}

	deleteCheckpoint(checkpointId: string): void {
		_deleteCheckpoint(this._checkpointStore, this._storage, checkpointId);
	}

	// ── Velocity ──────────────────────────────────────────────────────────

	recordVelocityDataPoint(unitsCompleted: number, periodStartMs: number, periodEndMs: number): void {
		_recordVelocityDataPoint(this._velocityStore, unitsCompleted, periodStartMs, periodEndMs);
		this.kb.ext.velocityDataPoints = [...this._velocityStore.dataPoints];
		this._markDirty();
	}

	getVelocityMetrics(windowDays?: number): IVelocityMetrics {
		const stats = computeStats(this.kb, this._idx);
		return _getVelocityMetrics(
			this._velocityStore,
			stats.totalUnits,
			stats.byStatus.complete + stats.byStatus.validated + stats.byStatus.committed,
			windowDays,
		);
	}

	// ── Stale units ───────────────────────────────────────────────────────

	getStaleUnits(thresholdMs?: number): IStaleUnitReport[] {
		return _getStaleUnits(this.kb.units, thresholdMs);
	}

	// ── Work packages ─────────────────────────────────────────────────────

	createWorkPackage(pkg: Omit<IWorkPackage, 'id' | 'createdAt'>): IWorkPackage {
		const newPkg = _createWorkPackage(this._wpStore, pkg);
		this.kb.ext.workPackages = _getAllWorkPackages(this._wpStore);
		this._markDirty();
		return newPkg;
	}

	updateWorkPackage(id: string, patch: Partial<Omit<IWorkPackage, 'id' | 'createdAt'>>): void {
		_updateWorkPackage(this._wpStore, id, patch);
		this.kb.ext.workPackages = _getAllWorkPackages(this._wpStore);
		this._markDirty();
	}

	getWorkPackage(id: string): IWorkPackage | undefined {
		return _getWorkPackage(this._wpStore, id);
	}

	getAllWorkPackages(): IWorkPackage[] {
		return _getAllWorkPackages(this._wpStore);
	}

	deleteWorkPackage(id: string): void {
		_deleteWorkPackage(this._wpStore, id);
		this.kb.ext.workPackages = _getAllWorkPackages(this._wpStore);
		this._markDirty();
	}

	addUnitToWorkPackage(pkgId: string, unitId: string): void {
		_addUnitToWorkPackage(this._wpStore, pkgId, unitId);
		this.kb.ext.workPackages = _getAllWorkPackages(this._wpStore);
		this._markDirty();
	}

	removeUnitFromWorkPackage(pkgId: string, unitId: string): void {
		_removeUnitFromWorkPackage(this._wpStore, pkgId, unitId);
		this.kb.ext.workPackages = _getAllWorkPackages(this._wpStore);
		this._markDirty();
	}

	getWorkPackageForUnit(unitId: string): IWorkPackage | undefined {
		return _getWorkPackageForUnit(this._wpStore, unitId);
	}

	getUnitsByWorkPackage(pkgId: string): IKnowledgeUnit[] {
		const pkg = _getWorkPackage(this._wpStore, pkgId);
		if (!pkg) { return []; }
		return pkg.unitIds.map(id => this.kb.units.get(id)).filter((u): u is IKnowledgeUnit => !!u);
	}

	// ── Split / Merge ──────────────────────────────────────────────────────

	splitUnit(unitId: string, subUnits: Array<Omit<IKnowledgeUnit, 'id' | 'createdAt' | 'updatedAt'>>): string[] {
		// Capture the parent's current state BEFORE _splitUnit mutates it to 'skipped'
		const parentBefore = this.kb.units.get(unitId);
		if (!parentBefore) { throw new Error(`splitUnit: unit not found: ${unitId}`); }
		const parentBeforeSnapshot = { ...parentBefore };

		const ids = _splitUnit(this.kb, unitId, subUnits);

		// Re-index: remove the old index entry using the PRE-mutation state,
		// then add the new 'skipped' entry
		const parent = this.kb.units.get(unitId)!;
		deindexUnit(parentBeforeSnapshot, this._idx);
		indexUnit(parent, this._idx);
		for (const id of ids) {
			const sub = this.kb.units.get(id)!;
			indexUnit(sub, this._idx);
		}
		this._dirtyProgress();
		this._markDirty();
		return ids;
	}

	mergeUnits(unitIds: string[], merged: Omit<IKnowledgeUnit, 'id' | 'createdAt' | 'updatedAt'>): string {
		const mergedId = _mergeUnits(this.kb, unitIds, merged);
		// Re-index all affected units
		for (const id of unitIds) {
			const u = this.kb.units.get(id)!;
			deindexUnit(u, this._idx);
			indexUnit(u, this._idx);
		}
		const mergedUnit = this.kb.units.get(mergedId)!;
		indexUnit(mergedUnit, this._idx);
		this._dirtyProgress();
		this._markDirty();
		return mergedId;
	}

	// ── Export / Import ────────────────────────────────────────────────────

	exportKB(): string {
		this._syncExtStores();
		return _exportKB(this.kb);
	}

	async importKB(json: string): Promise<void> {
		// Auto-checkpoint before import
		await this.createCheckpoint('pre-import', 'auto');
		const imported = _importKB(json);
		this._kb = imported;
		rebuildIndexes(imported, this._idx);
		this._resetStores();
		this._restoreExtStores(imported);
		this._markDirty();
	}

	mergeDecisionsFrom(json: string): void {
		_mergeDecisionsFrom(this.kb, json);
		// Re-index decisions
		for (const d of this.kb.decisions.typeMapping) { indexTypeMappingDecision(d, this._idx); }
		for (const d of this.kb.decisions.naming)      { indexNamingDecision(d, this._idx); }
		this._markDirty();
	}

	exportDecisions(): string {
		return _exportDecisions(this.kb);
	}

	importDecisions(json: string): void {
		_importDecisions(this.kb, json);
		for (const d of this.kb.decisions.typeMapping) { indexTypeMappingDecision(d, this._idx); }
		for (const d of this.kb.decisions.naming)      { indexNamingDecision(d, this._idx); }
		this._markDirty();
	}

	// ── Health check ──────────────────────────────────────────────────────

	runHealthCheck(): IKBHealthReport {
		const report = _runHealthCheck(this.kb, this._lockStore, this._conflictStore);
		this._lastHealthCheck = report;
		this.kb.ext.lastHealthCheck = report;
		this._markDirty();
		return report;
	}

	getLastHealthCheck(): IKBHealthReport | undefined {
		return this._lastHealthCheck ?? this.kb.ext.lastHealthCheck;
	}

	// ── Cycle detection ───────────────────────────────────────────────────

	findDependencyCycles(): string[][] {
		return _findDependencyCycles(this.kb.units);
	}

	// ── Token estimation ──────────────────────────────────────────────────

	estimateTokens(text: string): number {
		return _estimateTokens(text);
	}

	// ── Internal helpers ───────────────────────────────────────────────────

	private _auditEntry(
		type: Parameters<typeof makeAuditEntry>[0],
		summary: string,
		payload: Record<string, unknown>,
		unitId?: string,
		actor  = 'system',
	): void {
		const entry = makeAuditEntry(type, summary, payload, unitId, actor);
		appendAuditEntry(this.kb.auditLog, entry);
	}

	private _dirtyProgress(): void {
		if (this._batchMode) { return; }
		updateProgress(this.kb);
		updateAllPhaseProgress(this.kb.progress, this._idx.byPhase, this.kb.units);
	}

	private _markDirty(): void {
		if (this._batchMode) { return; }
		this.kb.updatedAt = Date.now();
		this._onDidChange.fire();
		this._scheduleSave();
	}

	private _scheduleSave(): void {
		if (this._saveTimer !== undefined) { clearTimeout(this._saveTimer); }
		this._saveTimer = setTimeout(() => {
			this._flushNow();
			this._saveTimer = undefined;
		}, SAVE_DEBOUNCE_MS);
	}

	private _flushNow(): void {
		if (!this._kb) { return; }
		this._syncExtStores();
		flush(this._kb, this._storage);
		upsertSessionInIndex(this._kb, this._storage);
	}

	/** Sync in-memory stores → kb.ext for serialisation */
	private _syncExtStores(): void {
		if (!this._kb) { return; }
		const ext = this._kb.ext;

		// Source drift
		ext.sourceVersions = Object.fromEntries(this._driftStore.sourceVersions);
		ext.driftAlerts    = Object.fromEntries(this._driftStore.driftAlerts);

		// Decision conflicts
		ext.decisionConflicts = _getDecisionConflicts(this._conflictStore);

		// Annotations + tags
		const annExt = annotationStoreToExt(this._annotationStore);
		ext.annotations = annExt.annotations;
		ext.tags        = annExt.tags;
		ext.unitTags    = annExt.unitTags as Record<string, string[]>;

		// Gates
		ext.gateResults = Object.fromEntries(this._gateStore.gateResults);

		// Work packages
		ext.workPackages = _getAllWorkPackages(this._wpStore);

		// Velocity
		ext.velocityDataPoints = [...this._velocityStore.dataPoints];

		// Health check
		if (this._lastHealthCheck) {
			ext.lastHealthCheck = this._lastHealthCheck;
		}
	}

	/** Restore in-memory stores from kb.ext after load */
	private _restoreExtStores(kb: IModernisationKnowledgeBase): void {
		const ext = kb.ext ?? emptyExtensions();

		// Source drift
		this._driftStore.sourceVersions = new Map(Object.entries(ext.sourceVersions ?? {}));
		this._driftStore.driftAlerts    = new Map(Object.entries(ext.driftAlerts ?? {}));

		// Decision conflicts
		this._conflictStore.conflicts = new Map(
			(ext.decisionConflicts ?? []).map(c => [c.id, c]),
		);

		// Annotations + tags
		this._annotationStore = extToAnnotationStore({
			annotations: ext.annotations ?? [],
			tags:        ext.tags ?? [],
			unitTags:    ext.unitTags ?? {},
		});

		// Gates
		this._gateStore.gateResults = new Map(Object.entries(ext.gateResults ?? {}));

		// Work packages
		this._wpStore = createWorkPackageStore();
		for (const pkg of (ext.workPackages ?? [])) {
			this._wpStore.packages.set(pkg.id, pkg);
			for (const unitId of pkg.unitIds) {
				this._wpStore.unitIndex.set(unitId, pkg.id);
			}
		}

		// Velocity
		this._velocityStore.dataPoints = [...(ext.velocityDataPoints ?? [])];

		// Health check
		this._lastHealthCheck = ext.lastHealthCheck;
	}

	private _resetStores(): void {
		this._lockStore       = createLockStore();
		this._driftStore      = createDriftStore();
		this._conflictStore   = createConflictStore();
		this._annotationStore = createAnnotationStore();
		this._gateStore       = createGateStore();
		this._velocityStore   = createVelocityStore();
		this._wpStore         = createWorkPackageStore();
		this._lastHealthCheck = undefined;
	}

	private _syncAnnotationExt(): void {
		if (!this._kb) { return; }
		const annExt = annotationStoreToExt(this._annotationStore);
		this._kb.ext.annotations = annExt.annotations;
		this._kb.ext.tags        = annExt.tags;
		this._kb.ext.unitTags    = annExt.unitTags as Record<string, string[]>;
	}

	/** Run fn in batch mode — progress and dirty updates are deferred until fn returns */
	private _batch(fn: () => void): void {
		this._batchMode = true;
		try { fn(); }
		finally {
			this._batchMode = false;
			updateProgress(this.kb);
			updateAllPhaseProgress(this.kb.progress, this._idx.byPhase, this.kb.units);
		}
	}
}
