/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Behavioral tests for the recall backfill pass runner (phase-1 review R3/R6).
 *
 * R3: the checkpoint may advance ONLY through confirmed durable index writes —
 * the first cut advanced past failed writes, permanently skipping those
 * records on every restart. R6: the enumeration is paginated and chained, so
 * archive 201+ is reached on a later pass instead of never.
 */

import assert from 'assert';
import { runBackfillPass, IBackfillCursor, IBackfillIo } from '../../browser/ledgerRecallBackfillContrib.js';
import { ILedgerEntry, IEpisodeSummary } from '../../common/ledgerTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const NO_YIELD = () => Promise.resolve();
const NOT_STOPPED = () => false;

function entry(seq: number): ILedgerEntry {
	return { id: `le_t_${seq}`, seq, threadId: 't', role: 'user', content: `entry ${seq}`, ts: seq, tokens: 5 };
}

interface IFakeStore {
	/** seq → indexed successfully */
	indexed: Map<number, boolean>;
	/** fail every index write with seq > failAbove (simulates a dead store) */
	failAbove: number;
}

function makeIo(threads: Record<string, number[]>, store: IFakeStore, episodes: IEpisodeSummary[] = []): IBackfillIo & { indexedSeqs: number[] } {
	const indexedSeqs: number[] = [];
	return {
		indexedSeqs,
		listThreads: () => Promise.resolve(Object.keys(threads)),
		stats: threadId => {
			const seqs = threads[threadId];
			return seqs && seqs.length > 0 ? Promise.resolve({ lastSeq: Math.max(...seqs) }) : Promise.resolve(null);
		},
		listEpisodes: () => Promise.resolve(episodes),
		readRange: (threadId, fromSeq, toSeq) => {
			const seqs = threads[threadId] ?? [];
			return Promise.resolve(seqs.filter(s => s >= fromSeq && s <= toSeq).map(entry));
		},
		indexEntry: (_threadId, e) => {
			const ok = e.seq <= store.failAbove;
			if (ok) { indexedSeqs.push(e.seq); }
			return Promise.resolve(ok);
		},
		indexEpisode: () => Promise.resolve(true),
	};
}

suite('recallBackfill — checkpoint honesty (R3)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();


	test('a failed index write stops the pass and keeps the cursor at the last confirmed seq', async () => {
		const io = makeIo({ 'thread-a': [1, 2, 3, 4, 5] }, { indexed: new Map(), failAbove: 2 });
		const cursor: IBackfillCursor = { threads: {} };
		const result = await runBackfillPass({ io, cursor, maxThreads: 10, batchEntries: 2, stopped: NOT_STOPPED, yieldBetweenBatches: NO_YIELD });
		assert.strictEqual(result.failed, true, 'the failure must surface, not be swallowed');
		assert.strictEqual(cursor.threads['thread-a'], 2, 'the cursor advances only through CONFIRMED writes');
		assert.deepStrictEqual(io.indexedSeqs, [1, 2], 'only the confirmed prefix is indexed');
	});

	test('the retry after a failed pass resumes at the failed range — nothing is skipped', async () => {
		const store: IFakeStore = { indexed: new Map(), failAbove: 2 };
		const io = makeIo({ 'thread-a': [1, 2, 3, 4, 5] }, store);
		const cursor: IBackfillCursor = { threads: {} };
		await runBackfillPass({ io, cursor, maxThreads: 10, batchEntries: 2, stopped: NOT_STOPPED, yieldBetweenBatches: NO_YIELD });
		store.failAbove = 99; // the store recovers
		const result = await runBackfillPass({ io, cursor, maxThreads: 10, batchEntries: 2, stopped: NOT_STOPPED, yieldBetweenBatches: NO_YIELD });
		assert.strictEqual(result.failed, false);
		assert.strictEqual(cursor.threads['thread-a'], 5);
		assert.deepStrictEqual(io.indexedSeqs, [1, 2, 3, 4, 5], 'the failed range is retried, never skipped');
	});

	test('a rejected index write (thrown) is treated like a failure, not swallowed', async () => {
		const base = makeIo({ 'thread-a': [1, 2, 3] }, { indexed: new Map(), failAbove: 1 });
		const io: IBackfillIo & { indexedSeqs: number[] } = {
			...base,
			indexEntry: (_t, e) => e.seq === 2 ? Promise.reject(new Error('store down')) : base.indexEntry(_t, e),
		};
		const cursor: IBackfillCursor = { threads: {} };
		const result = await runBackfillPass({ io, cursor, maxThreads: 10, batchEntries: 3, stopped: NOT_STOPPED, yieldBetweenBatches: NO_YIELD });
		assert.strictEqual(result.failed, true);
		assert.strictEqual(cursor.threads['thread-a'], 1);
	});

	test('a fully indexed thread advances to its lastSeq and a clean pass reports no failure', async () => {
		const io = makeIo({ 'thread-a': [1, 2, 3] }, { indexed: new Map(), failAbove: 99 });
		const cursor: IBackfillCursor = { threads: {} };
		const result = await runBackfillPass({ io, cursor, maxThreads: 10, batchEntries: 2, stopped: NOT_STOPPED, yieldBetweenBatches: NO_YIELD });
		assert.strictEqual(result.failed, false);
		assert.strictEqual(cursor.threads['thread-a'], 3);
	});
});

suite('recallBackfill — paginated enumeration (R6)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();


	function makeManyThreadIo(count: number): IBackfillIo & { indexedSeqs: number[] } {
		const threads: Record<string, number[]> = {};
		for (let i = 1; i <= count; i++) {
			threads[`thread-${String(i).padStart(3, '0')}`] = [i]; // one entry each
		}
		return makeIo(threads, { indexed: new Map(), failAbove: 999_999 });
	}

	test('one pass visits at most maxThreads archives and reports moreRemaining', async () => {
		const io = makeManyThreadIo(250);
		const cursor: IBackfillCursor = { threads: {} };
		const result = await runBackfillPass({ io, cursor, maxThreads: 200, batchEntries: 200, stopped: NOT_STOPPED, yieldBetweenBatches: NO_YIELD });
		assert.strictEqual(result.processed, 200);
		assert.strictEqual(result.moreRemaining, true, 'archive 201+ must be scheduled, not skipped forever');
		assert.strictEqual(cursor.enumAfter, 'thread-200');
	});

	test('the chained next pass resumes AFTER the last handled archive', async () => {
		const io = makeManyThreadIo(250);
		const cursor: IBackfillCursor = { threads: {} };
		const first = await runBackfillPass({ io, cursor, maxThreads: 200, batchEntries: 200, stopped: NOT_STOPPED, yieldBetweenBatches: NO_YIELD });
		assert.strictEqual(first.moreRemaining, true);
		const second = await runBackfillPass({ io, cursor, maxThreads: 200, batchEntries: 200, stopped: NOT_STOPPED, yieldBetweenBatches: NO_YIELD });
		assert.strictEqual(second.processed, 50);
		assert.strictEqual(second.moreRemaining, false, 'the sweep completes');
		assert.strictEqual(cursor.enumAfter, undefined, 'a finished sweep resets so new archives join the rotation');
		assert.strictEqual(io.indexedSeqs.length, 250, 'every archive was indexed exactly once across the passes');
	});

	test('an enumeration cursor whose thread vanished restarts the sweep from the top', async () => {
		const io = makeManyThreadIo(3);
		const cursor: IBackfillCursor = { threads: {}, enumAfter: 'thread-999' };
		const result = await runBackfillPass({ io, cursor, maxThreads: 2, batchEntries: 10, stopped: NOT_STOPPED, yieldBetweenBatches: NO_YIELD });
		assert.strictEqual(result.processed, 2, 'the sweep restarts instead of skipping everything');
	});

	test('a stopped pass keeps its position for the next pass', async () => {
		const io = makeManyThreadIo(10);
		const cursor: IBackfillCursor = { threads: {} };
		let calls = 0;
		const result = await runBackfillPass({
			io,
			cursor,
			maxThreads: 2,
			batchEntries: 10,
			stopped: () => ++calls > 2,
			yieldBetweenBatches: NO_YIELD,
		});
		assert.ok(result.processed < 10, 'the pass must stop early');
		assert.ok(cursor.enumAfter !== undefined, 'the position is kept for the resume');
		assert.strictEqual(cursor.enumAfter, `thread-${String(result.processed).padStart(3, '0')}`);
	});
});
