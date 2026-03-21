/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Fingerprint Scheduler
 *
 * Priority queue + concurrency controller for LLM fingerprint extraction jobs.
 *
 * ## Priority Order
 *
 * Units are processed in this order:
 *   1. critical risk
 *   2. high risk
 *   3. medium risk
 *   4. low risk
 *
 * Within each risk tier, units with more dependents are scheduled first
 * (widest blast radius first, so the most-consumed code is fingerprinted earliest).
 *
 * ## Concurrency Control
 *
 * At most `maxConcurrency` (default: 3) LLM calls run simultaneously.
 * The deterministic Layer 1 runs inline with no concurrency limit — it's synchronous regex.
 *
 * ## Backoff on Failure
 *
 * If an LLM call fails due to rate limiting (HTTP 429 or quota error), the job is
 * re-queued at the back of its risk tier with an exponential backoff delay.
 * After maxRetries (default: 3) the job is marked as permanently failed.
 *
 * ## Cancellation
 *
 * Calling cancel() sets a flag. The scheduler will not dequeue further jobs after that.
 * In-flight jobs will complete (they cannot be aborted once the LLM call is in-flight).
 */

import { RiskLevel } from '../../../../common/knowledgeBaseTypes.js';


// ─── Job Types ────────────────────────────────────────────────────────────────

export type FingerprintJobPriority = 'critical' | 'high' | 'medium' | 'low';

export interface IFingerprintJob {
	unitId: string;
	unitName: string;
	language: string;
	riskLevel: RiskLevel;
	/** Number of units that depend on this one — used for tie-breaking within a risk tier */
	dependentCount: number;
	/** Number of times this job has been retried */
	retryCount: number;
	/** Unix timestamp of the earliest time this job may be dequeued (for backoff) */
	notBefore: number;
	/** Whether this is a re-extraction triggered by a schema version bump */
	isSchemaRefresh: boolean;
}

export interface IJobResult {
	unitId: string;
	/** true if fingerprinting completed (even if LLM failed — Layer 1 counts as success) */
	success: boolean;
	/** true if the LLM completed successfully */
	llmSuccess: boolean;
	/** Error message if success === false */
	errorMessage?: string;
	/** Whether to retry (e.g. rate limit — not a permanent failure) */
	shouldRetry: boolean;
}


// ─── Scheduler Configuration ──────────────────────────────────────────────────

export interface IFingerprintSchedulerOptions {
	/** Maximum concurrent LLM calls (default: 3) */
	maxConcurrency?: number;
	/** Maximum retry attempts per job before permanent failure (default: 3) */
	maxRetries?: number;
	/** Base backoff in milliseconds for retry (doubles each retry, default: 2000) */
	baseBackoffMs?: number;
}

const DEFAULT_OPTIONS: Required<IFingerprintSchedulerOptions> = {
	maxConcurrency: 3,
	maxRetries: 3,
	baseBackoffMs: 2000,
};

/** Maps risk level to numeric priority (lower = higher priority) */
const RISK_PRIORITY: Record<RiskLevel, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};


// ─── Scheduler ───────────────────────────────────────────────────────────────

/**
 * FingerprintScheduler — manages the ordered queue of fingerprint extraction jobs.
 *
 * The scheduler itself does NOT execute jobs — it provides the ordering and
 * concurrency contract. The BatchFingerprintEngine is the executor.
 */
export class FingerprintScheduler {
	private readonly _queue: IFingerprintJob[] = [];
	private _inFlight = 0;
	private _cancelled = false;
	private readonly _opts: Required<IFingerprintSchedulerOptions>;

	constructor(options?: IFingerprintSchedulerOptions) {
		this._opts = { ...DEFAULT_OPTIONS, ...options };
	}

	// ── Queue Management ──────────────────────────────────────────────────────

	/**
	 * Add a job to the queue.
	 * If a job for the same unitId already exists, updates it only if the new job has
	 * higher priority (lower risk level priority number).
	 */
	enqueue(job: IFingerprintJob): void {
		const existingIdx = this._queue.findIndex(j => j.unitId === job.unitId);

		if (existingIdx !== -1) {
			const existing = this._queue[existingIdx];
			const newPriority = RISK_PRIORITY[job.riskLevel];
			const existingPriority = RISK_PRIORITY[existing.riskLevel];

			if (newPriority < existingPriority) {
				// New job has higher priority — replace
				this._queue.splice(existingIdx, 1);
			} else {
				// Existing job is equal or higher priority — keep existing
				return;
			}
		}

		this._queue.push(job);
		this._sortQueue();
	}

	/**
	 * Add multiple jobs in one operation.
	 * More efficient than calling enqueue() in a loop because sorting happens once.
	 */
	enqueueAll(jobs: IFingerprintJob[]): void {
		for (const job of jobs) {
			const existingIdx = this._queue.findIndex(j => j.unitId === job.unitId);
			if (existingIdx !== -1) {
				const existing = this._queue[existingIdx];
				if (RISK_PRIORITY[job.riskLevel] < RISK_PRIORITY[existing.riskLevel]) {
					this._queue.splice(existingIdx, 1, job);
				}
				// else keep existing
			} else {
				this._queue.push(job);
			}
		}
		this._sortQueue();
	}

	/**
	 * Remove a specific unit from the queue (e.g. if the unit was deleted).
	 */
	dequeueUnit(unitId: string): boolean {
		const idx = this._queue.findIndex(j => j.unitId === unitId);
		if (idx !== -1) {
			this._queue.splice(idx, 1);
			return true;
		}
		return false;
	}

	/**
	 * Dequeue the next job that is ready to execute.
	 *
	 * Returns undefined if:
	 * - The queue is empty
	 * - The scheduler is cancelled
	 * - All remaining jobs' notBefore is in the future (backed-off jobs)
	 * - We are at maxConcurrency
	 */
	next(): IFingerprintJob | undefined {
		if (this._cancelled) {
			return undefined;
		}

		if (this._inFlight >= this._opts.maxConcurrency) {
			return undefined;
		}

		const now = Date.now();
		for (let i = 0; i < this._queue.length; i++) {
			const job = this._queue[i];
			if (job.notBefore <= now) {
				this._queue.splice(i, 1);
				this._inFlight++;
				return job;
			}
		}

		return undefined;
	}

	/**
	 * Must be called when a job completes (success or failure) to release a concurrency slot.
	 *
	 * @param result  The result of the job
	 * @returns       The re-queued job if it was retried, undefined otherwise
	 */
	complete(result: IJobResult): IFingerprintJob | undefined {
		this._inFlight = Math.max(0, this._inFlight - 1);

		if (!result.success && result.shouldRetry) {
			// Find the original job metadata to carry forward retryCount
			// (It was removed from queue by next(), so we reconstruct minimal metadata)
			// The caller must pass back the original job if retry metadata is needed.
			return undefined; // Caller uses requeueWithBackoff() instead
		}

		return undefined;
	}

	/**
	 * Re-queue a failed job with exponential backoff.
	 * Called by the BatchFingerprintEngine when a job fails with a retryable error.
	 *
	 * Returns false if the job has exceeded maxRetries and should be marked as permanently failed.
	 */
	requeueWithBackoff(job: IFingerprintJob): boolean {
		const nextRetry = job.retryCount + 1;
		if (nextRetry > this._opts.maxRetries) {
			return false;
		}

		const backoffMs = this._opts.baseBackoffMs * Math.pow(2, job.retryCount);
		this.enqueue({
			...job,
			retryCount: nextRetry,
			notBefore: Date.now() + backoffMs,
		});

		return true;
	}

	// ── Status ────────────────────────────────────────────────────────────────

	/** Number of jobs waiting in the queue */
	get queueLength(): number {
		return this._queue.length;
	}

	/** Number of jobs currently being processed */
	get inFlight(): number {
		return this._inFlight;
	}

	/** Whether the scheduler has been cancelled */
	get cancelled(): boolean {
		return this._cancelled;
	}

	/** Whether the scheduler has more work to do (queue or in-flight) */
	get hasWork(): boolean {
		return this._queue.length > 0 || this._inFlight > 0;
	}

	/**
	 * Returns the next time (Unix ms) when a backed-off job will become eligible.
	 * Returns 0 if no jobs are backed off.
	 * Useful for the executor to know how long to wait before polling again.
	 */
	get nextEligibleAt(): number {
		const now = Date.now();
		let earliest = 0;
		for (const job of this._queue) {
			if (job.notBefore > now) {
				if (earliest === 0 || job.notBefore < earliest) {
					earliest = job.notBefore;
				}
			}
		}
		return earliest;
	}

	// ── Cancellation ──────────────────────────────────────────────────────────

	/**
	 * Cancel the scheduler. No more jobs will be dequeued.
	 * In-flight jobs will complete naturally.
	 */
	cancel(): void {
		this._cancelled = true;
	}

	/**
	 * Reset the scheduler to a clean state (e.g. for a new batch after the previous was cancelled).
	 */
	reset(): void {
		this._queue.length = 0;
		this._inFlight = 0;
		this._cancelled = false;
	}

	// ── Internal ──────────────────────────────────────────────────────────────

	/**
	 * Sort the queue by:
	 *   1. Risk level priority (critical < high < medium < low)
	 *   2. Dependent count descending (more dependents = higher priority within tier)
	 *   3. notBefore ascending (backed-off jobs go to the back)
	 */
	private _sortQueue(): void {
		this._queue.sort((a, b) => {
			const priorityDiff = RISK_PRIORITY[a.riskLevel] - RISK_PRIORITY[b.riskLevel];
			if (priorityDiff !== 0) {
				return priorityDiff;
			}

			// Within same risk tier: more dependents first
			const dependentDiff = b.dependentCount - a.dependentCount;
			if (dependentDiff !== 0) {
				return dependentDiff;
			}

			// Tie-break: jobs not in backoff first
			return a.notBefore - b.notBefore;
		});
	}
}


// ─── Job Builder ─────────────────────────────────────────────────────────────

/**
 * Build a fingerprint job from a KB unit record.
 * Provides clean separation between the KB model and the scheduler model.
 */
export function buildFingerprintJob(params: {
	unitId: string;
	unitName: string;
	language: string;
	riskLevel: RiskLevel;
	dependentCount: number;
	isSchemaRefresh?: boolean;
}): IFingerprintJob {
	return {
		unitId: params.unitId,
		unitName: params.unitName,
		language: params.language,
		riskLevel: params.riskLevel,
		dependentCount: params.dependentCount,
		retryCount: 0,
		notBefore: 0,
		isSchemaRefresh: params.isSchemaRefresh ?? false,
	};
}
