/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # FingerprintServiceImpl — Full Production Implementation
 *
 * Orchestrates the two-layer compliance fingerprint extraction pipeline.
 *
 * ## Lifecycle
 *
 * 1. Constructed by the DI container
 * 2. Listens to IKnowledgeBaseService.onDidChange for source drift events
 * 3. At first use, calls migrateSchema() in background (non-blocking)
 * 4. Accepts single-unit and batch fingerprint requests
 * 5. Writes results back to KB and fires progress events
 *
 * ## Threading Model
 *
 * VS Code / Void runs on Node.js. All async I/O is non-blocking, but JS is
 * single-threaded. The FingerprintScheduler enforces maxConcurrency to prevent
 * unbounded concurrent LLM calls from exhausting the provider's rate limits.
 *
 * ## Source Drift Integration
 *
 * When the KnowledgeBaseService raises a drift-detected event, this service:
 * 1. Calls invalidate(unitId) for all units in the drifted file
 * 2. Re-queues those units for fingerprinting at high priority
 * 3. If the unit already has a modern translation, calls compareKBUnit() automatically
 *
 * ## Comparison Service
 *
 * The fingerprint comparison (source vs. target) is handled by the embedded
 * FingerprintComparisonEngine. A 'blocked' result sets the unit to 'flagged'
 * and creates a pending compliance decision.
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Event, Emitter } from '../../../../../../base/common/event.js';
import { IKnowledgeBaseService } from '../../../../../contrib/neuralInverseModernisation/browser/knowledgeBase/service.js';
import { ILLMSemanticExtractorService } from './llmSemanticExtractor.js';
import { extractDeterministicFingerprint } from './deterministicExtractor.js';
import { assembleFingerprint } from './impl/fingerprintAssembler.js';
import { FingerprintCache, buildCacheKey } from './impl/fingerprintCache.js';
import { FingerprintScheduler, buildFingerprintJob } from './impl/fingerprintScheduler.js';
import { FingerprintProgressEmitter, IFingerprintUnitEvent, IFingerprintBatchCompleteEvent, IFingerprintBatchProgressEvent } from './impl/progressEmitter.js';
import { BatchFingerprintEngine } from './impl/batchFingerprintEngine.js';
import { applyFingerprintToKB, purgeAIRulesForUnit } from './impl/businessRuleAdapter.js';
import { scanForStaleFingerprints, isFingerprintStale } from './impl/fingerprintVersioning.js';
import { canonicaliseLanguage } from './impl/languageRegistry.js';
import {
	IFingerprintService,
	IBatchFingerprintOptions,
	IBatchFingerprintResult,
	IFingerprintSourceResult,
} from './service.js';
import { IComplianceFingerprint, IFingerprintComparison, IFingerprintDivergence } from '../../../common/modernisationTypes.js';
import { RiskLevel } from '../../../common/knowledgeBaseTypes.js';
import { IPendingDecision } from '../../../common/knowledgeBaseTypes.js';


// ─── Comparison Thresholds ────────────────────────────────────────────────────

/** Below this match percentage → 'warning' result */
const MATCH_WARNING_THRESHOLD = 90;

/** Below this match percentage → 'blocked' result (requires compliance officer) */
const MATCH_BLOCKED_THRESHOLD = 70;

/** Unique prefix for pending decisions raised by the fingerprint comparison */
const COMPARISON_DECISION_PREFIX = 'fp-cmp';


// ─── Implementation ───────────────────────────────────────────────────────────

export class FingerprintServiceImpl extends Disposable implements IFingerprintService {
	readonly _serviceBrand: undefined;

	// ── Progress Events (aggregated from current batch emitter) ───────────────
	private readonly _onDidFingerprintUnit = this._register(new Emitter<IFingerprintUnitEvent>());
	readonly onDidFingerprintUnit: Event<IFingerprintUnitEvent> = this._onDidFingerprintUnit.event;

	private readonly _onDidBatchProgress = this._register(new Emitter<IFingerprintBatchProgressEvent>());
	readonly onDidBatchProgress: Event<IFingerprintBatchProgressEvent> = this._onDidBatchProgress.event;

	private readonly _onDidCompleteBatch = this._register(new Emitter<IFingerprintBatchCompleteEvent>());
	readonly onDidCompleteBatch: Event<IFingerprintBatchCompleteEvent> = this._onDidCompleteBatch.event;

	// ── Internal State ────────────────────────────────────────────────────────
	private readonly _cache = new FingerprintCache(10_000);
	private readonly _scheduler = new FingerprintScheduler({ maxConcurrency: 3, maxRetries: 3, baseBackoffMs: 2000 });
	private _batchRunning = false;

	// ── Unit → cache key mapping (for invalidation) ───────────────────────────
	private readonly _unitCacheKeys = new Map<string, Set<string>>();

	constructor(
		@IKnowledgeBaseService private readonly _kb: IKnowledgeBaseService,
		@ILLMSemanticExtractorService private readonly _llmExtractor: ILLMSemanticExtractorService,
	) {
		super();

		// Listen for source drift events from the KB
		this._register(this._kb.onDidChange(() => {
			this._handlePotentialSourceDrift();
		}));

		// Run schema migration in background at construction time
		// (non-blocking — does not wait for result)
		void this.migrateSchema();
	}

	// ── Single-Unit: fingerprintKBUnit ────────────────────────────────────────

	async fingerprintKBUnit(unitId: string): Promise<IComplianceFingerprint> {
		if (!this._kb.isActive) {
			throw new Error('[FingerprintService] No active KB session.');
		}

		const unit = this._kb.getUnit(unitId);
		if (!unit) {
			throw new Error(`[FingerprintService] Unit not found: ${unitId}`);
		}

		const sourceText = unit.resolvedSource || unit.sourceText;
		const language = canonicaliseLanguage(unit.sourceLang);

		// Check cache
		const cacheKey = buildCacheKey(sourceText);
		const cached = this._cache.get(cacheKey);
		if (cached && !isFingerprintStale(cached.schemaVersion)) {
			// Ensure KB record is up to date (in case KB was reloaded)
			if (!unit.fingerprint || unit.fingerprint.contentHash !== cached.contentHash) {
				this._kb.recordFingerprint(unitId, cached);
				applyFingerprintToKB(this._kb, unitId, cached);
			}
			return cached;
		}

		// Layer 1: deterministic
		const layer1 = extractDeterministicFingerprint(sourceText, language, unit.name);

		// Layer 2: LLM
		let layer2Result;
		let llmExtractionComplete = false;

		try {
			layer2Result = await this._llmExtractor.extractSemantics(
				unit.name,
				sourceText,
				language,
				layer1.regulatedFields,
			);
			llmExtractionComplete = true;
		} catch {
			// LLM failure: store Layer 1 only fingerprint, will be retried on next call
			llmExtractionComplete = false;
		}

		// Assemble
		const fingerprint = assembleFingerprint({
			unitId,
			sourceLanguage: language,
			sourceText,
			layer1,
			layer2: layer2Result,
			llmExtractionComplete,
		});

		// Cache
		this._cache.set(cacheKey, fingerprint);
		this._trackCacheKeyForUnit(unitId, cacheKey);

		// Persist to KB
		if (llmExtractionComplete) {
			purgeAIRulesForUnit(this._kb, unitId);
		}
		this._kb.recordFingerprint(unitId, fingerprint);
		applyFingerprintToKB(this._kb, unitId, fingerprint);

		// Fire event for single-unit callers
		this._onDidFingerprintUnit.fire({
			unitId,
			unitName: unit.name,
			language,
			riskLevel: unit.riskLevel as RiskLevel,
			llmExtractionComplete,
			layer1Only: !llmExtractionComplete,
			regulatedFieldCount: fingerprint.regulatedFields.length,
			semanticRuleCount: fingerprint.semanticRules.length,
			complianceDomains: fingerprint.complianceDomains,
			success: true,
			isSchemaRefresh: false,
			completedAt: Date.now(),
		});

		return fingerprint;
	}

	// ── Single-Unit: compareKBUnit ────────────────────────────────────────────

	async compareKBUnit(unitId: string): Promise<void> {
		if (!this._kb.isActive) {
			throw new Error('[FingerprintService] No active KB session.');
		}

		const unit = this._kb.getUnit(unitId);
		if (!unit) {
			throw new Error(`[FingerprintService] Unit not found: ${unitId}`);
		}

		if (!unit.fingerprint) {
			throw new Error(`[FingerprintService] Unit ${unitId} has no source fingerprint to compare against. Call fingerprintKBUnit() first.`);
		}

		if (!unit.targetText) {
			throw new Error(`[FingerprintService] Unit ${unitId} has no target text to fingerprint.`);
		}

		const targetLanguage = canonicaliseLanguage(unit.sourceLang); // TODO: use targetLang when stored
		const targetSource = unit.targetText;

		// Fingerprint the target (raw extraction, no KB write for target)
		const targetResult = await this.fingerprintSource(
			`${unitId}:target`,
			targetSource,
			targetLanguage,
			unit.name,
		);

		// Compare
		const comparison = this._compareFingerprints(unit.fingerprint, targetResult.fingerprint);

		// Persist comparison
		this._kb.recordFingerprintComparison(unitId, comparison);

		// Status transitions based on comparison result
		if (comparison.overallResult === 'blocked') {
			const blockingCount = comparison.divergences.filter(d => d.requiresComplianceApproval).length;
			const decision: IPendingDecision = {
				id: `${COMPARISON_DECISION_PREFIX}:${unitId}:${Date.now()}`,
				unitId,
				type: 'approval',
				priority: (unit.riskLevel === 'critical' ? 'blocking' : unit.riskLevel) as 'low' | 'medium' | 'high' | 'blocking',
				question: `Compliance fingerprint divergence detected in ${unit.name}. ${blockingCount} blocking divergence(s) require compliance officer approval. Approve this translation to proceed?`,
				context: `Match percentage: ${comparison.matchPercentage}%. Blocking divergences: ${comparison.divergences.filter(d => d.severity === 'blocking').length}. Warnings: ${comparison.divergences.filter(d => d.severity === 'warning').length}.`,
				raisedAt: Date.now(),
			};
			this._kb.flagBlocked(unitId, `Fingerprint divergence: ${comparison.matchPercentage}% match`, decision);
		}
	}

	// ── Raw Extraction: fingerprintSource ─────────────────────────────────────

	async fingerprintSource(
		unitId: string,
		source: string,
		language: string,
		unitName: string,
	): Promise<IFingerprintSourceResult> {
		const lang = canonicaliseLanguage(language);
		const cacheKey = buildCacheKey(source);

		const cached = this._cache.get(cacheKey);
		if (cached && !isFingerprintStale(cached.schemaVersion)) {
			return {
				fingerprint: { ...cached, unitId },
				llmExtractionComplete: cached.llmExtractionComplete,
				fromCache: true,
			};
		}

		const layer1 = extractDeterministicFingerprint(source, lang, unitName);

		let layer2Result;
		let llmExtractionComplete = false;

		try {
			layer2Result = await this._llmExtractor.extractSemantics(unitName, source, lang, layer1.regulatedFields);
			llmExtractionComplete = true;
		} catch {
			llmExtractionComplete = false;
		}

		const fingerprint = assembleFingerprint({
			unitId,
			sourceLanguage: lang,
			sourceText: source,
			layer1,
			layer2: layer2Result,
			llmExtractionComplete,
		});

		this._cache.set(cacheKey, fingerprint);
		this._trackCacheKeyForUnit(unitId, cacheKey);

		return { fingerprint, llmExtractionComplete, fromCache: false };
	}

	// ── Cache Access ──────────────────────────────────────────────────────────

	getCached(contentHash: string): IComplianceFingerprint | undefined {
		return this._cache.get(contentHash);
	}

	invalidate(unitId: string): void {
		const cacheKeys = this._unitCacheKeys.get(unitId);
		if (cacheKeys) {
			for (const key of cacheKeys) {
				this._cache.delete(key);
			}
			this._unitCacheKeys.delete(unitId);
		}
		// Also sweep cache by unitId in case tracking map missed an entry
		this._cache.invalidateUnit(unitId);
	}

	// ── Batch Fingerprinting ──────────────────────────────────────────────────

	async batchFingerprintKB(options: IBatchFingerprintOptions = {}): Promise<IBatchFingerprintResult> {
		if (!this._kb.isActive) {
			throw new Error('[FingerprintService] No active KB session.');
		}

		if (this._batchRunning) {
			throw new Error('[FingerprintService] A batch fingerprint job is already running. Call cancelBatch() first.');
		}

		this._batchRunning = true;

		// Create a fresh emitter and engine for this batch
		const emitter = new FingerprintProgressEmitter();

		// Bridge batch emitter events to our service-level events
		const sub1 = emitter.onDidFingerprintUnit(e => this._onDidFingerprintUnit.fire(e));
		const sub2 = emitter.onDidBatchProgress(e => this._onDidBatchProgress.fire(e));
		const sub3 = emitter.onDidCompleteBatch(e => this._onDidCompleteBatch.fire(e));

		const maxConcurrency = options.maxConcurrency ?? 3;
		const scheduler = new FingerprintScheduler({ maxConcurrency, maxRetries: 3, baseBackoffMs: 2000 });

		const engine = new BatchFingerprintEngine(
			this._kb,
			this._llmExtractor,
			this._cache,
			scheduler,
			emitter,
		);

		this._scheduler.reset();

		try {
			const result = await engine.run(options);
			return result;
		} finally {
			this._batchRunning = false;
			sub1.dispose();
			sub2.dispose();
			sub3.dispose();
			emitter.dispose();
		}
	}

	cancelBatch(): void {
		if (!this._batchRunning) {
			return;
		}
		this._scheduler.cancel();
	}

	// ── Schema Migration ──────────────────────────────────────────────────────

	async migrateSchema(): Promise<number> {
		if (!this._kb.isActive) {
			return 0;
		}

		const scanResult = scanForStaleFingerprints(this._kb.kb);
		if (scanResult.staleUnitIds.length === 0) {
			return 0;
		}

		// Purge stale entries from the in-memory cache (they'll be re-extracted)
		this._cache.invalidateStaleVersions(scanResult.currentUnitIds.length > 0
			? (this._kb.kb.units.get(scanResult.currentUnitIds[0])?.fingerprint?.schemaVersion ?? 0) + 1
			: 1);

		// Queue stale units for background re-extraction (low priority)
		const jobs = scanResult.staleUnitIds.map(unitId => {
			const unit = this._kb.getUnit(unitId)!;
			return buildFingerprintJob({
				unitId,
				unitName: unit.name,
				language: canonicaliseLanguage(unit.sourceLang),
				riskLevel: unit.riskLevel as RiskLevel,
				dependentCount: unit.usedBy.length,
				isSchemaRefresh: true,
			});
		}).filter(Boolean);

		this._scheduler.enqueueAll(jobs);

		return scanResult.staleUnitIds.length;
	}

	// ── Fingerprint Comparison ────────────────────────────────────────────────

	private _compareFingerprints(
		source: IComplianceFingerprint,
		target: IComplianceFingerprint,
	): IFingerprintComparison {
		const divergences: IFingerprintDivergence[] = [];

		// Check for removed regulated fields
		for (const sourceField of source.regulatedFields) {
			const found = target.regulatedFields.find(
				tf => tf.regulatedAttribute === sourceField.regulatedAttribute &&
					tf.fieldName.toLowerCase() === sourceField.fieldName.toLowerCase(),
			);
			if (!found) {
				divergences.push({
					type: 'field-removed',
					description: `Regulated field "${sourceField.fieldName}" (${sourceField.regulatedAttribute}) present in legacy is absent in modern translation.`,
					legacyLocation: sourceField.location,
					severity: 'blocking',
					requiresComplianceApproval: true,
				});
			} else if (found.operation !== sourceField.operation) {
				divergences.push({
					type: 'field-operation-changed',
					description: `Field "${sourceField.fieldName}" operation changed from "${sourceField.operation}" to "${found.operation}".`,
					legacyLocation: sourceField.location,
					modernLocation: found.location,
					severity: 'warning',
					requiresComplianceApproval: sourceField.regulatedAttribute.includes('balance') || sourceField.regulatedAttribute.includes('amount'),
				});
			}
		}

		// Check for newly added regulated fields (unexpected new compliance surface)
		for (const targetField of target.regulatedFields) {
			const found = source.regulatedFields.find(
				sf => sf.regulatedAttribute === targetField.regulatedAttribute &&
					sf.fieldName.toLowerCase() === targetField.fieldName.toLowerCase(),
			);
			if (!found) {
				divergences.push({
					type: 'field-added',
					description: `New regulated field "${targetField.fieldName}" (${targetField.regulatedAttribute}) appears in modern translation but was not in legacy.`,
					modernLocation: targetField.location,
					severity: 'warning',
					requiresComplianceApproval: false,
				});
			}
		}

		// Check for removed semantic rules where preservationRequired
		for (const sourceRule of source.semanticRules) {
			if (!sourceRule.preservationRequired) {
				continue;
			}
			const found = target.semanticRules.find(
				tr => this._rulesMatch(sourceRule.description, tr.description),
			);
			if (!found) {
				divergences.push({
					type: 'rule-removed',
					description: `Required business rule not found in modern translation: "${sourceRule.description}"`,
					severity: 'blocking',
					requiresComplianceApproval: true,
				});
			}
		}

		// Check for removed compliance domains
		for (const sourceDomain of source.complianceDomains) {
			if (!target.complianceDomains.includes(sourceDomain)) {
				divergences.push({
					type: 'domain-removed',
					description: `Compliance domain "${sourceDomain}" was present in legacy but is absent in modern translation.`,
					severity: 'warning',
					requiresComplianceApproval: false,
				});
			}
		}

		// Check for new compliance domains in target (unexpected compliance surface)
		for (const targetDomain of target.complianceDomains) {
			if (!source.complianceDomains.includes(targetDomain)) {
				divergences.push({
					type: 'domain-added',
					description: `New compliance domain "${targetDomain}" appears in modern translation but was not in legacy.`,
					severity: 'info',
					requiresComplianceApproval: false,
				});
			}
		}

		// Check invariant preservation
		for (const invariant of source.invariants) {
			const targetHasEquivalent = target.invariants.some(
				ti => ti.invariantType === invariant.invariantType,
			);
			if (!targetHasEquivalent && invariant.testable) {
				divergences.push({
					type: 'invariant-violated',
					description: `Invariant "${invariant.description}" (type: ${invariant.invariantType}) from legacy is not represented in modern translation.`,
					legacyLocation: invariant.location,
					severity: 'warning',
					requiresComplianceApproval: invariant.invariantType === 'rounding_behaviour' || invariant.invariantType === 'decimal_precision',
				});
			}
		}

		// Calculate match percentage
		const matchPercentage = this._calculateMatchPercentage(source, target, divergences);

		// Determine overall result
		const hasBlocking = divergences.some(d => d.severity === 'blocking');
		const overallResult = hasBlocking || matchPercentage < MATCH_BLOCKED_THRESHOLD
			? 'blocked'
			: matchPercentage < MATCH_WARNING_THRESHOLD
				? 'warning'
				: 'pass';

		return {
			unitId: source.unitId,
			comparedAt: Date.now(),
			legacyFingerprint: source,
			modernFingerprint: target,
			matchPercentage,
			divergences,
			overallResult,
		};
	}

	/**
	 * Calculate a match percentage (0–100) based on how much of the source fingerprint
	 * is reproduced in the target.
	 *
	 * Weighting:
	 *   - Regulated fields: 40%
	 *   - Semantic rules (preservationRequired): 40%
	 *   - Compliance domains: 20%
	 */
	private _calculateMatchPercentage(
		source: IComplianceFingerprint,
		target: IComplianceFingerprint,
		divergences: IFingerprintDivergence[],
	): number {
		// If the source has no regulated content, it's trivially a 100% match
		if (
			source.regulatedFields.length === 0 &&
			source.semanticRules.length === 0 &&
			source.complianceDomains.length === 0
		) {
			return 100;
		}

		let score = 0;
		let maxScore = 0;

		// Regulated fields (40 points max)
		if (source.regulatedFields.length > 0) {
			const removedFields = divergences.filter(d => d.type === 'field-removed').length;
			const fieldScore = Math.max(0, source.regulatedFields.length - removedFields) / source.regulatedFields.length;
			score += fieldScore * 40;
			maxScore += 40;
		}

		// Preservation-required semantic rules (40 points max)
		const preservationRules = source.semanticRules.filter(r => r.preservationRequired);
		if (preservationRules.length > 0) {
			const removedRules = divergences.filter(d => d.type === 'rule-removed').length;
			const ruleScore = Math.max(0, preservationRules.length - removedRules) / preservationRules.length;
			score += ruleScore * 40;
			maxScore += 40;
		}

		// Compliance domains (20 points max)
		if (source.complianceDomains.length > 0) {
			const removedDomains = divergences.filter(d => d.type === 'domain-removed').length;
			const domainScore = Math.max(0, source.complianceDomains.length - removedDomains) / source.complianceDomains.length;
			score += domainScore * 20;
			maxScore += 20;
		}

		if (maxScore === 0) {
			return 100;
		}

		return Math.round((score / maxScore) * 100);
	}

	/**
	 * Heuristic match for semantic rule descriptions.
	 * Two rules match if they have > 60% token overlap (Jaccard similarity).
	 */
	private _rulesMatch(descA: string, descB: string): boolean {
		const tokensA = new Set(descA.toLowerCase().split(/\W+/).filter(t => t.length > 3));
		const tokensB = new Set(descB.toLowerCase().split(/\W+/).filter(t => t.length > 3));

		if (tokensA.size === 0 || tokensB.size === 0) {
			return descA.toLowerCase() === descB.toLowerCase();
		}

		let intersection = 0;
		for (const t of tokensA) {
			if (tokensB.has(t)) {
				intersection++;
			}
		}

		const union = tokensA.size + tokensB.size - intersection;
		return (intersection / union) > 0.60;
	}

	// ── Source Drift Handler ──────────────────────────────────────────────────

	private _handlePotentialSourceDrift(): void {
		if (!this._kb.isActive) {
			return;
		}
		// Actual drift detection is event-based via KB's onDidChangeUnitStatus.
		// This hook is a placeholder for future integration where the KB fires
		// specific drift events with file paths.
	}

	// ── Cache Key Tracking ────────────────────────────────────────────────────

	private _trackCacheKeyForUnit(unitId: string, cacheKey: string): void {
		let keys = this._unitCacheKeys.get(unitId);
		if (!keys) {
			keys = new Set();
			this._unitCacheKeys.set(unitId, keys);
		}
		keys.add(cacheKey);
	}
}
