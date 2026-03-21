/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Batch Fingerprint Engine
 *
 * Executes batch fingerprint jobs across all units in the active KB session.
 *
 * ## Responsibilities
 *
 * - Build the job queue from KB state (all un-fingerprinted or stale units)
 * - Drive the FingerprintScheduler (poll, dequeue, execute, handle results)
 * - Report progress via FingerprintProgressEmitter
 * - Respect cancellation (scheduler.cancel() + cancelled flag)
 *
 * ## Execution Model
 *
 * The engine uses a poll-based loop rather than Promise.all() for two reasons:
 * 1. Concurrency limit: at most N (default 3) LLM calls in flight simultaneously
 * 2. Backoff handling: backed-off jobs must wait before being eligible
 *
 * The loop:
 * 1. Dequeue up to `maxConcurrency - inFlight` jobs from the scheduler
 * 2. Start each as a Promise (no await) — they run concurrently
 * 3. As each completes, re-check the queue for new work
 * 4. Loop until queue empty + inFlight === 0 OR cancelled
 *
 * ## Error Isolation
 *
 * A failure in one unit's extraction NEVER fails other units. Each job is isolated.
 * The batch result accumulates all failures — the caller decides what to report.
 */

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { ILLMSemanticExtractorService } from '../llmSemanticExtractor.js';
import { extractDeterministicFingerprint } from '../deterministicExtractor.js';
import { assembleFingerprint } from './fingerprintAssembler.js';
import { FingerprintCache, buildCacheKey } from './fingerprintCache.js';
import { FingerprintScheduler, IFingerprintJob, buildFingerprintJob } from './fingerprintScheduler.js';
import { FingerprintProgressEmitter, IFingerprintUnitEvent } from './progressEmitter.js';
import { applyFingerprintToKB, purgeAIRulesForUnit } from './businessRuleAdapter.js';
import { scanForStaleFingerprints } from './fingerprintVersioning.js';
import { IBatchFingerprintOptions, IBatchFingerprintResult } from '../service.js';
import { IComplianceFingerprint } from '../../../../common/modernisationTypes.js';
import { RiskLevel } from '../../../../common/knowledgeBaseTypes.js';
import { canonicaliseLanguage } from './languageRegistry.js';

/** Delay between scheduler polls when all jobs are backed off (ms) */
const POLL_INTERVAL_MS = 250;

/** HTTP 429 / quota errors that should trigger retry with backoff */
const RETRYABLE_ERROR_PATTERNS = [
	/rate.?limit/i,
	/quota/i,
	/429/,
	/too.?many.?requests/i,
	/service.?unavailable/i,
];


// ─── Engine ───────────────────────────────────────────────────────────────────

export class BatchFingerprintEngine {

	constructor(
		private readonly kb: IKnowledgeBaseService,
		private readonly llmExtractor: ILLMSemanticExtractorService,
		private readonly cache: FingerprintCache,
		private readonly scheduler: FingerprintScheduler,
		private readonly emitter: FingerprintProgressEmitter,
	) { }

	/**
	 * Run a batch fingerprint job on the active KB.
	 *
	 * Returns when all jobs complete or the scheduler is cancelled.
	 */
	async run(options: IBatchFingerprintOptions = {}): Promise<IBatchFingerprintResult> {
		const startedAt = Date.now();

		// ── 1. Build the job queue ────────────────────────────────────────────
		const { jobs, skippedCount } = this._buildJobQueue(options);

		if (jobs.length === 0) {
			this.emitter.beginBatch(0);
			this.emitter.batchCompleted(skippedCount, false);
			return {
				totalQueued: 0,
				succeeded: 0,
				layer1Only: 0,
				failed: 0,
				skipped: skippedCount,
				cancelled: false,
				durationMs: Date.now() - startedAt,
			};
		}

		this.scheduler.reset();
		this.scheduler.enqueueAll(jobs);
		this.emitter.beginBatch(jobs.length);

		// ── 2. Execute via poll loop ──────────────────────────────────────────
		const inFlightPromises = new Set<Promise<void>>();
		let succeeded = 0;
		let layer1Only = 0;
		let failed = 0;

		const processNext = (): void => {
			while (!this.scheduler.cancelled) {
				const job = this.scheduler.next();
				if (!job) {
					break;
				}

				this.emitter.unitStarted(job.unitId);

				const p = this._executeJob(job).then(result => {
					inFlightPromises.delete(p);

					const event = buildUnitEvent(job, result);
					this.emitter.unitCompleted(event);

					if (result.success && result.llmExtractionComplete) {
						succeeded++;
					} else if (result.success) {
						layer1Only++;
					} else {
						failed++;
						if (result.shouldRetry) {
							const requeued = this.scheduler.requeueWithBackoff(job);
							if (requeued) {
								// This job is re-queued — adjust total count (it will emit again)
								// We already counted it as failed, undo that and let the retry decide
								failed--;
							}
						}
					}

					// Kick off more work now that a slot is free
					processNext();
				});

				inFlightPromises.add(p);
			}
		};

		// Initial kick
		processNext();

		// Wait for all in-flight work to drain
		while (inFlightPromises.size > 0 || (this.scheduler.hasWork && !this.scheduler.cancelled)) {
			if (inFlightPromises.size > 0) {
				await Promise.race(inFlightPromises);
			} else if (this.scheduler.queueLength > 0 && !this.scheduler.cancelled) {
				// All remaining jobs are backed off — wait for the soonest eligible
				const nextAt = this.scheduler.nextEligibleAt;
				const waitMs = nextAt > 0 ? Math.min(nextAt - Date.now(), POLL_INTERVAL_MS) : POLL_INTERVAL_MS;
				if (waitMs > 0) {
					await delay(waitMs);
				}
				processNext();
			} else {
				break;
			}
		}

		const cancelled = this.scheduler.cancelled;
		this.emitter.batchCompleted(skippedCount, cancelled);

		return {
			totalQueued: jobs.length,
			succeeded,
			layer1Only,
			failed,
			skipped: skippedCount,
			cancelled,
			durationMs: Date.now() - startedAt,
		};
	}

	// ── Job Queue Builder ─────────────────────────────────────────────────────

	private _buildJobQueue(options: IBatchFingerprintOptions): { jobs: IFingerprintJob[]; skippedCount: number } {
		const kbInstance = this.kb.kb;
		const scanResult = scanForStaleFingerprints(kbInstance);

		let skippedCount = 0;
		const jobs: IFingerprintJob[] = [];

		const addJobs = (unitIds: string[], isSchemaRefresh: boolean): void => {
			for (const unitId of unitIds) {
				const unit = kbInstance.units.get(unitId);
				if (!unit) {
					continue;
				}

				// Apply risk level filter if provided
				if (options.riskLevels && !options.riskLevels.includes(unit.riskLevel as RiskLevel)) {
					skippedCount++;
					continue;
				}

				// Apply phase filter if provided
				if (options.phaseId && unit.phaseId !== options.phaseId) {
					skippedCount++;
					continue;
				}

				jobs.push(buildFingerprintJob({
					unitId: unit.id,
					unitName: unit.name,
					language: canonicaliseLanguage(unit.sourceLang),
					riskLevel: unit.riskLevel as RiskLevel,
					dependentCount: unit.usedBy.length,
					isSchemaRefresh,
				}));
			}
		};

		// Always include unfingerprinted units
		addJobs(scanResult.unfingerprintedUnitIds, false);

		// Include stale-version units unless explicitly skipped
		if (!options.skipStaleVersionRefresh) {
			addJobs(scanResult.staleUnitIds, true);
		} else {
			skippedCount += scanResult.staleUnitIds.length;
		}

		// Already-current units are skipped
		skippedCount += scanResult.currentUnitIds.length;

		return { jobs, skippedCount };
	}

	// ── Single Job Execution ──────────────────────────────────────────────────

	private async _executeJob(job: IFingerprintJob): Promise<IJobExecutionResult> {
		try {
			const unit = this.kb.getUnit(job.unitId);
			if (!unit) {
				return { success: false, llmExtractionComplete: false, shouldRetry: false, errorMessage: `Unit not found: ${job.unitId}` };
			}

			// Use resolvedSource if available (dependency-expanded), otherwise raw sourceText
			const sourceText = unit.resolvedSource || unit.sourceText;
			const language = canonicaliseLanguage(unit.sourceLang);

			// Check cache first
			const cacheKey = buildCacheKey(sourceText);
			const cached = this.cache.get(cacheKey);
			if (cached) {
				this.kb.recordFingerprint(job.unitId, cached);
				applyFingerprintToKB(this.kb, job.unitId, cached);
				return { success: true, llmExtractionComplete: cached.llmExtractionComplete, shouldRetry: false, fromCache: true };
			}

			// Layer 1: Deterministic extraction (synchronous, no LLM)
			const layer1 = extractDeterministicFingerprint(sourceText, language, unit.name);

			// Layer 2: LLM semantic extraction
			let layer2Result;
			let llmExtractionComplete = false;

			try {
				layer2Result = await this.llmExtractor.extractSemantics(
					unit.name,
					sourceText,
					language,
					layer1.regulatedFields,
				);
				llmExtractionComplete = true;
			} catch (llmError) {
				// LLM failure is non-fatal — store Layer 1 only fingerprint
				layer2Result = undefined;
				llmExtractionComplete = false;
			}

			// Assemble fingerprint
			const fingerprint = assembleFingerprint({
				unitId: job.unitId,
				sourceLanguage: language,
				sourceText,
				layer1,
				layer2: layer2Result,
				llmExtractionComplete,
			});

			// Cache the result
			this.cache.set(cacheKey, fingerprint);

			// Write to KB
			// If re-extracting (schema refresh), purge old AI rules first
			if (job.isSchemaRefresh) {
				purgeAIRulesForUnit(this.kb, job.unitId);
			}
			this.kb.recordFingerprint(job.unitId, fingerprint);
			applyFingerprintToKB(this.kb, job.unitId, fingerprint);

			return { success: true, llmExtractionComplete, shouldRetry: false, fingerprint };

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const shouldRetry = RETRYABLE_ERROR_PATTERNS.some(p => p.test(errorMessage));
			return { success: false, llmExtractionComplete: false, shouldRetry, errorMessage };
		}
	}
}


// ─── Internal Result Type ─────────────────────────────────────────────────────

interface IJobExecutionResult {
	success: boolean;
	llmExtractionComplete: boolean;
	shouldRetry: boolean;
	errorMessage?: string;
	fingerprint?: IComplianceFingerprint;
	fromCache?: boolean;
}


// ─── Event Builder ────────────────────────────────────────────────────────────

function buildUnitEvent(job: IFingerprintJob, result: IJobExecutionResult): IFingerprintUnitEvent {
	return {
		unitId: job.unitId,
		unitName: job.unitName,
		language: job.language,
		riskLevel: job.riskLevel,
		llmExtractionComplete: result.llmExtractionComplete,
		layer1Only: result.success && !result.llmExtractionComplete,
		regulatedFieldCount: result.fingerprint?.regulatedFields.length ?? 0,
		semanticRuleCount: result.fingerprint?.semanticRules.length ?? 0,
		complianceDomains: result.fingerprint?.complianceDomains ?? [],
		success: result.success,
		errorMessage: result.errorMessage,
		isSchemaRefresh: job.isSchemaRefresh,
		completedAt: Date.now(),
	};
}


// ─── Utility ─────────────────────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
