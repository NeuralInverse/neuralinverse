/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License. Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { resolveCloseBoundary, noteBoundaryMissed, boundaryMissCount, resetBoundaryMissTelemetry, MAX_BOUNDARY_WINDOW_ENTRIES } from '../../common/ledgerBoundary.js';
import { DEFAULT_LEDGER_POLICY } from '../../common/ledgerPolicy.js';
import type { ILedgerEntry, LedgerRole } from '../../common/ledgerTypes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a journal slice from a role pattern, seqs 1..roles.length. */
function journalOf(roles: LedgerRole[]): ILedgerEntry[] {
	return roles.map((role, i) => ({
		id: `le_t_${i + 1}`,
		seq: i + 1,
		threadId: 't',
		role,
		content: `${role}-${i + 1}`,
		ts: 1_000 + i + 1,
		tokens: 10,
	}));
}

/** readTail stub over a fixed journal — also records requested window sizes. */
function readTailOf(journal: ILedgerEntry[]) {
	const sizes: number[] = [];
	const readTail = async (maxEntries: number): Promise<ILedgerEntry[]> => {
		sizes.push(maxEntries);
		return journal.slice(Math.max(0, journal.length - maxEntries));
	};
	return { readTail, sizes };
}

// ---------------------------------------------------------------------------
// Suite: resolveCloseBoundary — growing window (task M6 item 1)
// ---------------------------------------------------------------------------

suite('ledgerBoundary — resolveCloseBoundary', () => {

	test('closes at the oldest user entry that leaves tailMinMessages verbatim', async () => {
		const journal = journalOf(['user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'user', 'assistant']);
		const { readTail } = readTailOf(journal);
		// fromSeq 1 (first episode, like real callers): first user strictly after
		// seq 1 is seq 4; window 14 − idx 3 = 11 ≥ tailMin 8 ✓
		const out = await resolveCloseBoundary(1, DEFAULT_LEDGER_POLICY, readTail);
		assert.strictEqual(out.kind, 'close');
		assert.strictEqual(out.boundarySeq, 4);
		assert.strictEqual(out.toSeq, 3);
		assert.strictEqual(out.window![out.boundaryIdx!].seq, 4);
	});

	test('tool-heavy turn (25 tool entries) still closes — the fixed 12-window bug', async () => {
		// the shape that actually broke the old code: the turn's tool run is at
		// the END of the journal (the close runs right after the reply), so the
		// last 12 entries contain no user message at all
		const roles: LedgerRole[] = ['user', 'assistant', 'user', 'assistant'];
		for (let i = 0; i < 25; i++) roles.push('tool');
		roles.push('assistant'); // 30 entries: seqs 1-30, turn-2 user at seq 3
		const journal = journalOf(roles);
		const { readTail, sizes } = readTailOf(journal);

		const out = await resolveCloseBoundary(2, DEFAULT_LEDGER_POLICY, readTail);
		// window(12) = seqs 19-30 → all tool/assistant; window(24) = seqs 7-30 →
		// still no user; only the third window reaches back to the seq-3 user
		assert.strictEqual(sizes[0], DEFAULT_LEDGER_POLICY.tailMinMessages + 4);
		assert.ok(sizes.length > 1, `window must grow beyond the initial 12 (sizes: ${sizes.join(',')})`);
		assert.strictEqual(out.kind, 'close', 'the turn-starting user message is found beyond the old fixed window');
		assert.strictEqual(out.boundarySeq, 3);
		assert.strictEqual(out.toSeq, 2, 'the pre-turn content becomes the episode');
		assert.strictEqual(out.window!.length - out.boundaryIdx!, 28, 'the whole tool-heavy turn stays verbatim in the tail');
	});

	test('real role mix from the audit scenario: user, assistant, tool×6, assistant, user, …', async () => {
		const roles: LedgerRole[] = [
			'user', 'assistant', 'tool', 'tool', 'tool', 'tool', 'tool', 'tool', 'assistant', // turn 1 (seqs 1-9)
			'user', 'assistant', 'tool', 'tool', 'assistant', 'user', 'assistant', 'tool', 'tool', 'user', // seqs 10-20
		];
		const journal = journalOf(roles); // 20 entries
		const { readTail } = readTailOf(journal);
		const out = await resolveCloseBoundary(1, DEFAULT_LEDGER_POLICY, readTail);
		assert.strictEqual(out.kind, 'close');
		assert.strictEqual(out.boundarySeq, 10, 'oldest user after seq 1 is seq 10; 20 − idx 9 = 11 ≥ 8');
		assert.strictEqual(out.toSeq, 9, 'episode covers the whole first turn');
	});

	test('grows no further than the journal itself (short window stops the search)', async () => {
		const journal = journalOf(['user', 'assistant', 'tool']); // 3 entries, no second user
		const { readTail, sizes } = readTailOf(journal);
		const out = await resolveCloseBoundary(1, DEFAULT_LEDGER_POLICY, readTail);
		assert.strictEqual(out.kind, 'deferred');
		assert.strictEqual(sizes.length, 1, 'short window means nothing older exists — no growth loop');
		assert.ok(out.reason);
	});

	test('deferred with reason when every new user is too recent — never a silent return', async () => {
		// one summarized user, a long assistant/tool run, then a user 3 entries from the end
		const roles: LedgerRole[] = ['user'];
		for (let i = 0; i < 20; i++) roles.push(i % 2 ? 'assistant' : 'tool');
		roles.push('user', 'assistant', 'tool'); // user at seq 22, only 2 after it
		const journal = journalOf(roles);
		const { readTail } = readTailOf(journal);
		const out = await resolveCloseBoundary(1, DEFAULT_LEDGER_POLICY, readTail);
		assert.strictEqual(out.kind, 'deferred');
		assert.ok(out.reason!.includes('fewer than'), out.reason);
	});

	test('caps the window at MAX_BOUNDARY_WINDOW_ENTRIES for an endless tool stream', async () => {
		const roles: LedgerRole[] = ['user', 'assistant'];
		for (let i = 0; i < 500; i++) roles.push('tool');
		const journal = journalOf(roles);
		const { readTail, sizes } = readTailOf(journal);
		const out = await resolveCloseBoundary(3, DEFAULT_LEDGER_POLICY, readTail);
		assert.strictEqual(out.kind, 'deferred');
		assert.strictEqual(Math.max(...sizes), MAX_BOUNDARY_WINDOW_ENTRIES);
		assert.ok(out.reason!.includes('capped'), out.reason);
	});

	test('the boundary is always a user entry, so assistant→tool pairs stay intact', async () => {
		const journal = journalOf(['user', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool']);
		const { readTail } = readTailOf(journal);
		const out = await resolveCloseBoundary(1, DEFAULT_LEDGER_POLICY, readTail);
		assert.strictEqual(out.kind, 'close');
		const boundary = out.window![out.boundaryIdx!];
		assert.strictEqual(boundary.role, 'user');
		assert.strictEqual(boundary.seq, 2);
		// everything folded before the boundary ends with seq 1 (a user), never mid-pair
		assert.strictEqual(out.toSeq, 1);
	});

	test('second close after fromSeq advances picks a NEW boundary (no empty episode)', async () => {
		const journal = journalOf(['user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'user', 'assistant']);
		const { readTail } = readTailOf(journal);
		const first = await resolveCloseBoundary(1, DEFAULT_LEDGER_POLICY, readTail);
		assert.strictEqual(first.kind, 'close');
		assert.strictEqual(first.boundarySeq, 4);
		assert.strictEqual(first.toSeq, 3);
		const second = await resolveCloseBoundary(first.toSeq! + 1, DEFAULT_LEDGER_POLICY, readTail);
		assert.strictEqual(second.kind, 'close');
		assert.strictEqual(second.boundarySeq, 7, 'the seq>fromSeq guard picks the NEXT user, never the previous boundary');
		assert.strictEqual(second.toSeq, 6);
		const third = await resolveCloseBoundary(second.toSeq! + 1, DEFAULT_LEDGER_POLICY, readTail);
		// remaining users (seq 10, 13) leave < 8 verbatim entries — deferred, not empty
		assert.strictEqual(third.kind, 'deferred');
	});

	test('empty journal defers with a reason', async () => {
		const { readTail } = readTailOf([]);
		const out = await resolveCloseBoundary(1, DEFAULT_LEDGER_POLICY, readTail);
		assert.strictEqual(out.kind, 'deferred');
		assert.ok(out.reason);
	});
});

// ---------------------------------------------------------------------------
// Suite: miss telemetry
// ---------------------------------------------------------------------------

suite('ledgerBoundary — boundaryMissed telemetry', () => {

	test('counter increments per thread; distinct reasons are counted separately', () => {
		resetBoundaryMissTelemetry('t-miss');
		const before = boundaryMissCount('t-miss');
		noteBoundaryMissed('t-miss', 'reason A');
		noteBoundaryMissed('t-miss', 'reason A'); // same reason: counted, warned once
		noteBoundaryMissed('t-miss', 'reason B');
		assert.strictEqual(boundaryMissCount('t-miss'), before + 3);
		assert.strictEqual(boundaryMissCount('t-other'), 0, 'counters are per thread');
	});
});
