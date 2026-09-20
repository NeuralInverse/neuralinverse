/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ledger recall index backfill (task F02, phase-1 review R3/R6)
 *
 * Entries and episodes journaled BEFORE the evented index feed existed never
 * reach the recall search index on their own. This contribution walks every
 * known archive and indexes whatever the checkpoint says is missing:
 *
 *   - restartable: the per-thread seq cursor AND the thread-enumeration
 *     position are persisted in workspace storage, so a restart (or the next
 *     scheduled pass) resumes where the last one stopped
 *   - checkpoint honesty (R3): the cursor advances ONLY through confirmed
 *     durable index writes. A failed write leaves the cursor at the last
 *     confirmed seq and aborts the pass — the failed range is the resume
 *     point, never a permanently skipped hole
 *   - idempotent: document keys are `threadId:seq` (entry) and episode ids —
 *     re-putting an already-indexed record is a no-op
 *   - bounded + recurring (R6): one pass visits at most MAX_THREADS_PER_PASS
 *     archives in sorted order and chains the next pass itself, so archive
 *     201+ is reached on the next tick (not the next restart), and a finished
 *     sweep reschedules itself so archives created after startup join the
 *     rotation
 *   - cancellable: disposal stops the walk at the next tick boundary
 *
 * The pass logic lives in {@link runBackfillPass} — pure over injected IO, so
 * the checkpoint and pagination behavior is unit-testable without the DI
 * shell. Registered only when the contextLedgerEnabled flag is on (same gate
 * as the recall tools).
 */

import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IContextLedgerService } from './contextLedgerService.js';
import { ILedgerRecallService } from '../../neuralInverse/browser/context/search/ledgerRecallService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import { ILedgerEntry, IEpisodeSummary } from '../common/ledgerTypes.js';

const CURSOR_KEY = 'ni.ledger.recall.backfillCursor';
/** journal entries per readRange/indexing batch */
const BATCH_ENTRIES = 200;
/** idle gap between batches — indexing never competes with the user */
const BATCH_YIELD_MS = 1_000;
/** hard cap on thread archives per pass (meta.json reads are IO) */
const MAX_THREADS_PER_PASS = 200;
/** pause after a failed pass before retrying (store likely still down) */
const FAIL_RETRY_MS = 60_000;
/** a completed sweep reschedules itself so new archives join the rotation */
const RESCAN_INTERVAL_MS = 10 * 60_000;

// ─── Testable pass runner ─────────────────────────────────────────────────────

export interface IBackfillIo {
	listThreads(): Promise<string[]>;
	stats(threadId: string): Promise<{ lastSeq: number } | null>;
	listEpisodes(threadId: string): Promise<IEpisodeSummary[]>;
	readRange(threadId: string, fromSeq: number, toSeq: number): Promise<ILedgerEntry[]>;
	indexEntry(threadId: string, entry: ILedgerEntry): Promise<boolean>;
	indexEpisode(threadId: string, ep: IEpisodeSummary): Promise<boolean>;
}

export interface IBackfillCursor {
	/** last confirmed indexed seq per thread */
	threads: Record<string, number>;
	/** enumeration position — the last thread fully handled (R6 pagination) */
	enumAfter?: string;
}

export interface IBackfillPassOptions {
	io: IBackfillIo;
	cursor: IBackfillCursor;
	maxThreads: number;
	batchEntries: number;
	stopped: () => boolean;
	yieldBetweenBatches: () => Promise<void>;
}

export interface IBackfillPassResult {
	/** threads fully handled this pass */
	processed: number;
	/** a retryable index failure stopped the pass — the cursor kept the range */
	failed: boolean;
	/** the enumeration continues with the next scheduled pass (R6) */
	moreRemaining: boolean;
}

/**
 * One bounded backfill pass over the archive enumeration, in sorted order,
 * resuming after `cursor.enumAfter`. Mutates `cursor` in place; the caller
 * decides when to persist it. Never throws for a failed INDEX write — that is
 * the `failed` outcome; a failed ENUMERATION propagates to the caller.
 */
export async function runBackfillPass(o: IBackfillPassOptions): Promise<IBackfillPassResult> {
	const all = (await o.io.listThreads()).sort();
	// -1 + 1 = 0: an enumAfter that no longer exists restarts the sweep
	const startIdx = o.cursor.enumAfter ? Math.max(0, all.indexOf(o.cursor.enumAfter) + 1) : 0;
	const batch = all.slice(startIdx, startIdx + o.maxThreads);

	let failed = false;
	let processed = 0;
	for (const threadId of batch) {
		if (o.stopped()) { break; }
		const ok = await backfillThread(threadId, o);
		if (!ok) { failed = true; break; }
		o.cursor.enumAfter = threadId;
		processed++;
	}

	const moreRemaining = !failed && startIdx + batch.length < all.length;
	if (!failed && !moreRemaining) {
		// full sweep complete — the next pass starts from the top so archives
		// created after this pass started are not stuck behind the cursor
		delete o.cursor.enumAfter;
	}
	return { processed, failed, moreRemaining };
}

/**
 * Index one thread's episodes + entries. Returns false on the first index
 * write that did not reach the store (R3) — the cursor then points at the
 * last confirmed seq, which is exactly where the retry resumes.
 */
async function backfillThread(threadId: string, o: IBackfillPassOptions): Promise<boolean> {
	const stats = await o.io.stats(threadId);
	if (!stats || stats.lastSeq === 0) { return true; }
	// episodes are write-once documents — refresh them wholesale
	// (idempotent) instead of tracking a second cursor
	const episodes = await o.io.listEpisodes(threadId);
	for (const ep of episodes) {
		const ok = await o.io.indexEpisode(threadId, ep).catch(() => false);
		if (!ok) { return false; }
	}
	const threads = o.cursor.threads ?? (o.cursor.threads = {});
	let from = (threads[threadId] ?? 0) + 1;
	while (from <= stats.lastSeq) {
		if (o.stopped()) { return true; }
		const to = Math.min(from + o.batchEntries - 1, stats.lastSeq);
		const entries = await o.io.readRange(threadId, from, to);
		let lastConfirmed = from - 1;
		for (const entry of entries) {
			const ok = await o.io.indexEntry(threadId, entry).catch(() => false);
			if (!ok) {
				// R3: advance only through CONFIRMED durable writes
				threads[threadId] = lastConfirmed;
				return false;
			}
			lastConfirmed = entry.seq;
		}
		threads[threadId] = to;
		from = to + 1;
		await o.yieldBetweenBatches();
	}
	return true;
}

// ─── Contribution shell ───────────────────────────────────────────────────────

class LedgerRecallBackfillContribution extends Disposable {

	private _running = false;
	private _stopped = false;
	private _timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IContextLedgerService private readonly _ledger: IContextLedgerService,
		@ILedgerRecallService private readonly _recall: ILedgerRecallService,
		@IStorageService private readonly _storageService: IStorageService,
		@IVoidSettingsService settingsService: IVoidSettingsService,
	) {
		super();

		const ledgerOn = (): boolean => {
			try {
				return settingsService.state.globalSettings.contextLedgerEnabled;
			} catch {
				return false;
			}
		};
		if (!ledgerOn()) { return; }

		// let the workbench settle first — indexing is strictly background
		const handle = setTimeout(() => { void this._run(); }, 30_000);
		this._register(toDisposable(() => {
			this._stopped = true;
			clearTimeout(handle);
			this._clearTimer();
		}));
	}

	override dispose(): void {
		this._stopped = true;
		this._clearTimer();
		super.dispose();
	}

	private _clearTimer(): void {
		if (this._timer !== undefined) {
			clearTimeout(this._timer);
			this._timer = undefined;
		}
	}

	private _schedulePass(delayMs: number): void {
		if (this._stopped) { return; }
		this._clearTimer();
		this._timer = setTimeout(() => { void this._run(); }, delayMs);
	}

	private _readCursor(): IBackfillCursor {
		try {
			const raw = this._storageService.get(CURSOR_KEY, StorageScope.WORKSPACE);
			const parsed = raw ? JSON.parse(raw) as Partial<IBackfillCursor> : {};
			return { threads: parsed.threads ?? {}, enumAfter: parsed.enumAfter };
		} catch {
			return { threads: {} };
		}
	}

	private _writeCursor(cursor: IBackfillCursor): void {
		try {
			this._storageService.store(CURSOR_KEY, JSON.stringify(cursor), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		} catch {
			// a lost cursor only costs re-indexing (idempotent), never data
		}
	}

	private _yield(): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, BATCH_YIELD_MS));
	}

	private _io(): IBackfillIo {
		return {
			listThreads: () => this._ledger.listThreads(),
			stats: threadId => this._ledger.stats(threadId),
			listEpisodes: threadId => this._ledger.listEpisodes(threadId),
			readRange: (threadId, fromSeq, toSeq) => this._ledger.readRange(threadId, fromSeq, toSeq),
			indexEntry: (threadId, entry) => this._recall.indexEntry(threadId, entry),
			indexEpisode: (threadId, ep) => this._recall.indexEpisode(threadId, ep),
		};
	}

	private async _run(): Promise<void> {
		if (this._running || this._stopped) { return; }
		this._running = true;
		let outcome: IBackfillPassResult;
		try {
			const cursor = this._readCursor();
			outcome = await runBackfillPass({
				io: this._io(),
				cursor,
				maxThreads: MAX_THREADS_PER_PASS,
				batchEntries: BATCH_ENTRIES,
				stopped: () => this._stopped,
				yieldBetweenBatches: () => this._yield(),
			});
			this._writeCursor(cursor);
		} catch {
			// enumeration failure — the cursor is untouched, the next pass retries
			outcome = { processed: 0, failed: true, moreRemaining: false };
		} finally {
			this._running = false;
		}
		if (this._stopped) { return; }
		// B2 live closure: a completed pass is also the recurring trigger for
		// the stale/missing-vector re-embed sweep — entries that failed to
		// embed while the endpoint was down recover here, bounded per pass.
		if (!outcome.failed) {
			void this._recall.reembedStaleVectors().catch(() => { /* best-effort */ });
		}
		// R6: bounded passes chain themselves — the archive tail is reached on
		// the next tick, not the next restart
		if (outcome.failed) {
			this._schedulePass(FAIL_RETRY_MS);
		} else if (outcome.moreRemaining) {
			this._schedulePass(BATCH_YIELD_MS);
		} else {
			this._schedulePass(RESCAN_INTERVAL_MS);
		}
	}
}

registerWorkbenchContribution2('ledgerRecallBackfillContrib', LedgerRecallBackfillContribution, WorkbenchPhase.Eventually);

export { LedgerRecallBackfillContribution };
