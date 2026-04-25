/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Resolution Scheduler
 *
 * Priority queue for source resolution jobs.
 *
 * ## Ordering Strategy
 *
 * Units are resolved in this order:
 *
 * 1. **Leaf nodes first** (units with no unresolved dependencies of their own).
 *    COBOL copybooks are typically leaf nodes \u2014 they have no COPY statements of
 *    their own, or only reference other copybooks. Resolving leaves first means
 *    when we get to a program that COPYs three copybooks, all three are already
 *    in the file content cache.
 *
 * 2. **Critical > High > Medium > Low** risk within the same dependency depth tier.
 *
 * 3. **More dependents first** within the same risk tier.
 *    If WS-COMMONS is COPYed by 80 programs, it gets resolved before a copybook
 *    used by only 2 programs. This maximises cache utilisation.
 *
 * ## Concurrency
 *
 * The scheduler enforces maxConcurrency (default: 6) simultaneous resolutions.
 * Resolution is I/O-bound (reading copybook files), so higher concurrency is
 * safe and beneficial here (unlike fingerprinting which is LLM-bound).
 */

import { IResolutionRequest } from './resolutionTypes.js';


// \u2500\u2500\u2500 Priority Constants \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const RISK_PRIORITY: Record<string, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};


// \u2500\u2500\u2500 Queue Entry \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface IQueueEntry {
	request: IResolutionRequest;
	/** Number of unresolved dependencies (lower = resolve sooner as leaf node) */
	unresolvedDepCount: number;
	/** Unix timestamp when this entry was enqueued */
	enqueuedAt: number;
}


// \u2500\u2500\u2500 Scheduler \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class ResolutionScheduler {
	private readonly _queue: IQueueEntry[] = [];
	private _inFlight = 0;
	private _cancelled = false;
	private readonly _maxConcurrency: number;

	constructor(maxConcurrency = 6) {
		this._maxConcurrency = maxConcurrency;
	}

	/**
	 * Add a resolution request to the queue.
	 * If a request for the same unitId already exists, ignores the new one
	 * (the existing entry may have been prioritised already).
	 */
	enqueue(request: IResolutionRequest, unresolvedDepCount = 0): void {
		if (this._queue.some(e => e.request.unitId === request.unitId)) {
			return;
		}
		this._queue.push({ request, unresolvedDepCount, enqueuedAt: Date.now() });
		this._sortQueue();
	}

	/**
	 * Batch enqueue \u2014 more efficient than calling enqueue() in a loop.
	 */
	enqueueAll(entries: Array<{ request: IResolutionRequest; unresolvedDepCount: number }>): void {
		for (const entry of entries) {
			if (!this._queue.some(e => e.request.unitId === entry.request.unitId)) {
				this._queue.push({ ...entry, enqueuedAt: Date.now() });
			}
		}
		this._sortQueue();
	}

	/**
	 * Dequeue the next request ready for processing.
	 * Returns undefined if:
	 * - Queue is empty
	 * - At maxConcurrency
	 * - Scheduler is cancelled
	 */
	next(): IResolutionRequest | undefined {
		if (this._cancelled || this._inFlight >= this._maxConcurrency || this._queue.length === 0) {
			return undefined;
		}
		const entry = this._queue.shift()!;
		this._inFlight++;
		return entry.request;
	}

	/**
	 * Signal that a resolution job completed (success or failure).
	 * Releases a concurrency slot.
	 */
	complete(): void {
		this._inFlight = Math.max(0, this._inFlight - 1);
	}

	/**
	 * Remove a unit from the queue (e.g. if the unit was deleted from KB).
	 */
	remove(unitId: string): boolean {
		const idx = this._queue.findIndex(e => e.request.unitId === unitId);
		if (idx !== -1) {
			this._queue.splice(idx, 1);
			return true;
		}
		return false;
	}

	cancel(): void {
		this._cancelled = true;
	}

	reset(): void {
		this._queue.length = 0;
		this._inFlight = 0;
		this._cancelled = false;
	}

	get queueLength(): number {
		return this._queue.length;
	}

	get inFlight(): number {
		return this._inFlight;
	}

	get cancelled(): boolean {
		return this._cancelled;
	}

	get hasWork(): boolean {
		return this._queue.length > 0 || this._inFlight > 0;
	}

	// \u2500\u2500 Sorting \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Sort order:
	 * 1. Fewer unresolved dependencies first (leaf nodes first)
	 * 2. Higher risk priority within same dep depth
	 * 3. More dependents within same risk tier
	 */
	private _sortQueue(): void {
		this._queue.sort((a, b) => {
			// Leaf nodes first (fewer outbound unresolved deps)
			const depDiff = a.unresolvedDepCount - b.unresolvedDepCount;
			if (depDiff !== 0) {
				return depDiff;
			}

			// Higher risk priority
			const riskA = RISK_PRIORITY[a.request.riskLevel] ?? 3;
			const riskB = RISK_PRIORITY[b.request.riskLevel] ?? 3;
			const riskDiff = riskA - riskB;
			if (riskDiff !== 0) {
				return riskDiff;
			}

			// More dependents first within same tier
			return b.request.dependentCount - a.request.dependentCount;
		});
	}
}
