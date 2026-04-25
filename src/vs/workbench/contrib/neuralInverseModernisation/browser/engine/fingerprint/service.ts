/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # IFingerprintService \u2014 Public Interface
 *
 * The FingerprintService orchestrates the two-layer compliance fingerprint extraction
 * pipeline and connects it to the Knowledge Base.
 *
 * ## Architecture Summary
 *
 * ```
 * Source Code
 *     \u2502
 *     \u251C\u2500\u2500\u25BA Layer 1: DeterministicExtractor   (fast, no LLM, regex + structural)
 *     \u2502       \u2514\u2500\u2500\u25BA IRegulatedField[]  +  ILogicalInvariant[]
 *     \u2502
 *     \u2514\u2500\u2500\u25BA Layer 2: LLMSemanticExtractor     (slower, LLM call, language-agnostic)
 *             \u2514\u2500\u2500\u25BA ISemanticRule[]  +  complianceDomains[]  +  ILogicalInvariant[]
 *                          \u2502
 *                          \u2514\u2500\u2500\u25BA Assembled into IComplianceFingerprint
 *                                    \u2502
 *                                    \u2514\u2500\u2500\u25BA Written to KB via businessRuleAdapter
 * ```
 *
 * ## Usage
 *
 * Single unit:
 * ```ts
 * await fingerprintService.fingerprintKBUnit(unitId);
 * ```
 *
 * Batch (all units in active KB session):
 * ```ts
 * await fingerprintService.batchFingerprintKB({ maxConcurrency: 5 });
 * fingerprintService.onDidFingerprintUnit(e => updateUI(e));
 * ```
 *
 * Comparison (fingerprint target, compare to stored source fingerprint):
 * ```ts
 * await fingerprintService.compareKBUnit(unitId);
 * ```
 */

import { Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IComplianceFingerprint } from '../../../common/modernisationTypes.js';
import {
	IFingerprintUnitEvent,
	IFingerprintBatchCompleteEvent,
	IFingerprintBatchProgressEvent,
} from './impl/progressEmitter.js';


// \u2500\u2500\u2500 Batch Options \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IBatchFingerprintOptions {
	/**
	 * Maximum number of concurrent LLM calls during batch processing.
	 * Defaults to 3. Increase with caution \u2014 too many concurrent calls can
	 * exhaust the LLM provider's rate limit and cause cascade failures.
	 */
	maxConcurrency?: number;

	/**
	 * If true, only fingerprint units that have no fingerprint at all.
	 * If false (default), also re-fingerprint units with stale schema versions.
	 */
	skipStaleVersionRefresh?: boolean;

	/**
	 * If provided, only fingerprint units belonging to this phase.
	 */
	phaseId?: string;

	/**
	 * If provided, only fingerprint units matching these risk levels.
	 * Defaults to all risk levels.
	 */
	riskLevels?: Array<'low' | 'medium' | 'high' | 'critical'>;
}


// \u2500\u2500\u2500 Batch Result \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IBatchFingerprintResult {
	/** Total units that were queued for fingerprinting */
	totalQueued: number;
	/** Units successfully fingerprinted with full Layer 1 + Layer 2 */
	succeeded: number;
	/** Units fingerprinted with Layer 1 only (LLM failed) */
	layer1Only: number;
	/** Units that failed entirely (no fingerprint stored) */
	failed: number;
	/** Units skipped (already fingerprinted with current schema version) */
	skipped: number;
	/** Whether the batch was cancelled by calling cancelBatch() */
	cancelled: boolean;
	/** Wall-clock duration of the batch in milliseconds */
	durationMs: number;
}


// \u2500\u2500\u2500 Raw Extraction Result \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * The result of a raw fingerprint extraction \u2014 returned by fingerprintSource()
 * without touching the Knowledge Base. Used for ad-hoc extractions (e.g. comparison).
 */
export interface IFingerprintSourceResult {
	fingerprint: IComplianceFingerprint;
	/** Whether Layer 2 (LLM) extraction completed successfully */
	llmExtractionComplete: boolean;
	/** Whether the result was served from cache (no extraction occurred) */
	fromCache: boolean;
}


// \u2500\u2500\u2500 Service Interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const IFingerprintService = createDecorator<IFingerprintService>('fingerprintService');

export interface IFingerprintService {
	readonly _serviceBrand: undefined;

	// \u2500\u2500 Events \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Fires when a single unit's fingerprinting completes during a batch job.
	 * Also fires for individual fingerprintKBUnit() calls.
	 */
	readonly onDidFingerprintUnit: Event<IFingerprintUnitEvent>;

	/**
	 * Fires periodically during batch processing with progress statistics.
	 */
	readonly onDidBatchProgress: Event<IFingerprintBatchProgressEvent>;

	/**
	 * Fires when a batch job finishes (naturally or via cancellation).
	 */
	readonly onDidCompleteBatch: Event<IFingerprintBatchCompleteEvent>;

	// \u2500\u2500 Single-Unit Methods \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Full pipeline for a single KB unit:
	 * 1. Reads unit source from KB
	 * 2. Runs Layer 1 (deterministic extraction)
	 * 3. Runs Layer 2 (LLM semantic extraction)
	 * 4. Assembles IComplianceFingerprint
	 * 5. Writes fingerprint to KB unit record
	 * 6. Writes business rules to KB via businessRuleAdapter
	 * 7. Assigns unit to compliance domains in KB
	 *
	 * If the unit already has a current fingerprint (same content hash + schema version),
	 * returns the cached fingerprint without re-extracting.
	 *
	 * @throws Error if the unit is not found in the active KB session
	 */
	fingerprintKBUnit(unitId: string): Promise<IComplianceFingerprint>;

	/**
	 * Fingerprint the unit's current TARGET text and compare it to the stored
	 * SOURCE fingerprint. Writes the comparison result to the KB.
	 *
	 * - If comparison result is 'blocked', the unit is set to 'flagged' status
	 *   and a pending decision is created for compliance officer review.
	 * - If result is 'warning', the developer can approve and proceed.
	 * - If result is 'pass', the unit can advance normally.
	 *
	 * @throws Error if the unit is not found or has no source fingerprint to compare against
	 * @throws Error if the unit has no target text
	 */
	compareKBUnit(unitId: string): Promise<void>;

	/**
	 * Raw extraction \u2014 returns a fingerprint for arbitrary source text without
	 * touching the Knowledge Base. Useful for comparison (fingerprintTarget) or
	 * ad-hoc analysis outside the normal workflow.
	 *
	 * Results are cached by (contentHash + schemaVersion) \u2014 repeated calls with
	 * the same source text return instantly from cache.
	 *
	 * @param unitId    Logical unit ID (used for cache keying and fingerprint.unitId)
	 * @param source    Raw source text to fingerprint
	 * @param language  Source language key (e.g. 'cobol', 'java')
	 * @param unitName  Name of the unit (used for paragraph pattern matching)
	 */
	fingerprintSource(
		unitId: string,
		source: string,
		language: string,
		unitName: string,
	): Promise<IFingerprintSourceResult>;

	/**
	 * Read a fingerprint from the in-memory cache by its content hash.
	 * Returns undefined if not cached (requires a fresh extraction).
	 *
	 * Use this to check the cache before calling fingerprintSource().
	 */
	getCached(contentHash: string): IComplianceFingerprint | undefined;

	/**
	 * Remove a unit's cached fingerprint.
	 * The next call to fingerprintKBUnit() or fingerprintSource() will
	 * perform a fresh extraction.
	 *
	 * Called automatically when source drift is detected for a file.
	 */
	invalidate(unitId: string): void;

	// \u2500\u2500 Batch Methods \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Fingerprint all un-fingerprinted (or stale) units in the active KB session.
	 *
	 * Processing order:
	 *   1. critical risk units
	 *   2. high risk units
	 *   3. medium risk units
	 *   4. low risk units
	 *
	 * Within each risk tier, units with more dependents are processed first
	 * (widest blast radius first, so the most-used code is fingerprinted earliest).
	 *
	 * Returns when the batch completes or is cancelled via cancelBatch().
	 * Progress is emitted via onDidFingerprintUnit and onDidBatchProgress events.
	 */
	batchFingerprintKB(options?: IBatchFingerprintOptions): Promise<IBatchFingerprintResult>;

	/**
	 * Cancel an in-progress batch fingerprint job.
	 * The current in-flight extractions will complete but no new ones will start.
	 * onDidCompleteBatch fires with cancelled === true.
	 *
	 * No-op if no batch is in progress.
	 */
	cancelBatch(): void;

	// \u2500\u2500 Schema Migration \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Scan the KB for fingerprints with an older schema version and schedule
	 * them for re-extraction at low priority.
	 *
	 * Called automatically at service startup \u2014 does NOT block startup.
	 * Re-fingerprinting runs as background work via the scheduler.
	 *
	 * Returns the number of units queued for re-extraction.
	 */
	migrateSchema(): Promise<number>;
}
