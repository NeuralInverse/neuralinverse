/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Behavioral tests for the native chat's turn matcher and migration core
 * (phase-1 review R2, re-review T3/T4): which session turn RECORDS are
 * already archived, so only the UNCOVERED ones are migrated into the ledger —
 * never duplicated, never silently dropped, and never CERTIFIED by a coverage
 * watermark the journal did not confirm.
 */

import assert from 'assert';
import { matchLedgerTurns, newestCoverageNote, migrateLegacyTurns, ILegacyMigrationIo } from '../../common/ledgerTurns.js';
import { ILedgerEntry, ILedgerEntryMeta, LedgerRole } from '../../common/ledgerTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

let _seq = 0;
function entry(role: LedgerRole, content: string, meta?: ILedgerEntryMeta): ILedgerEntry {
	_seq++;
	return {
		id: `le_t_${_seq}`,
		seq: _seq,
		threadId: 't',
		role,
		content,
		ts: _seq,
		tokens: 10,
		...(meta !== undefined ? { meta } : {}),
	};
}
function userEntry(content: string, turn?: number): ILedgerEntry { return entry('user', content, turn !== undefined ? { turn } : undefined); }

/** history turns read {user, assistant} per turn for the assertions below */
function userOnly(covered: { user: boolean; assistant: boolean }[]): boolean[] { return covered.map(c => c.user); }

suite('ledgerTurns — matchLedgerTurns', () => {
	ensureNoDisposablesAreLeakedInTestSuite();


	test('an empty journal covers nothing — every legacy turn migrates', () => {
		const covered = matchLedgerTurns([{ message: 'a' }, { message: 'b' }], []);
		assert.deepStrictEqual(userOnly(covered), [false, false]);
		assert.deepStrictEqual(covered.map(c => c.assistant), [true, true], 'no assistant text required → assistant trivially covered');
	});

	test('marker matches are exact — marked turns are covered, unmarked gaps migrate', () => {
		const entries = [
			userEntry('first', 0),
			userEntry('third', 2),
		];
		const covered = matchLedgerTurns([{ message: 'first' }, { message: 'second' }, { message: 'third' }], entries);
		assert.deepStrictEqual(userOnly(covered), [true, false, true]);
	});

	test('unmarked (pre-marker) journals match by content, in order', () => {
		const entries = [
			userEntry('what is X?'),
			userEntry('attached context\n\nwhat about Y?'),
		];
		const covered = matchLedgerTurns(
			[{ message: 'what is X?' }, { message: 'what about Y?' }, { message: 'and Z?' }],
			entries,
		);
		assert.deepStrictEqual(userOnly(covered), [true, true, false]);
	});

	test('the attached_context wrapper still matches the wrapped request', () => {
		const entries = [userEntry('<attached_context>\nfile contents here\n</attached_context>\n\nthe actual question')];
		const covered = matchLedgerTurns([{ message: 'the actual question' }], entries);
		assert.deepStrictEqual(userOnly(covered), [true]);
	});

	test('a marked entry can never satisfy a different turn via content', () => {
		// turn 1's message happens to equal turn 0's — but turn 1 is marked
		// absent, so only turn 0 is covered
		const entries = [userEntry('same text', 0)];
		const covered = matchLedgerTurns([{ message: 'same text' }, { message: 'same text' }], entries);
		assert.deepStrictEqual(userOnly(covered), [true, false]);
	});

	test('repeated identical messages consume entries in order, never one entry twice', () => {
		const entries = [userEntry('ok'), userEntry('ok')];
		const covered = matchLedgerTurns([{ message: 'ok' }, { message: 'ok' }, { message: 'ok' }], entries);
		assert.deepStrictEqual(userOnly(covered), [true, true, false]);
	});

	test('mixed markers and legacy entries: both matchers contribute coverage', () => {
		const entries = [
			userEntry('legacy turn'),      // unmarked — content match
			userEntry('new turn', 1),      // marked
		];
		const covered = matchLedgerTurns([{ message: 'legacy turn' }, { message: 'new turn' }, { message: 'missing' }], entries);
		assert.deepStrictEqual(userOnly(covered), [true, true, false]);
	});

	test('assistant coverage is per record — a journaled user without its answer is HALF covered (T3)', () => {
		// the assistant append failed after the user append succeeded: the
		// turn must report user-covered/assistant-missing so migration
		// repairs exactly the missing record instead of duplicating the user
		const entries = [userEntry('the question', 0)];
		const covered = matchLedgerTurns([{ message: 'the question', assistantText: 'the answer' }], entries);
		assert.strictEqual(covered[0].user, true);
		assert.strictEqual(covered[0].assistant, false, 'the assistant record is absent → must not be certified');
	});

	test('assistant markers and unmarked assistant content both prove the answer archived', () => {
		const entries = [
			userEntry('q0', 0),
			entry('assistant', 'a0', { turn: 0 }),
			userEntry('q1', 1),
			entry('assistant', 'a1'), // unmarked legacy journal
		];
		const covered = matchLedgerTurns(
			[{ message: 'q0', assistantText: 'a0' }, { message: 'q1', assistantText: 'a1' }],
			entries,
		);
		assert.deepStrictEqual(covered.map(c => c.assistant), [true, true]);
	});
});

// ---------------------------------------------------------------------------
// Suite: durable coverage notes (re-review S2)
// ---------------------------------------------------------------------------

suite('ledgerTurns — coverage notes (S2)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a coverage note proves turns archived even when their markers are OUTSIDE the tail', () => {
		// the re-review's probe: turn 0 is journaled+marked, then 70 tool
		// records push the marker out of any bounded read window — without
		// the note, migration re-appended the turn (two duplicates)
		const covered = matchLedgerTurns([{ message: 'archived request' }], [], 0);
		assert.deepStrictEqual(covered.map(c => c.user), [true], 'coveredThrough=0 proves turn 0 archived with NO entries in the window');
	});

	test('newestCoverageNote reads the highest coveredThrough from v2 note entries', () => {
		const notes: ILedgerEntry[] = [
			entry('note', 'turn-coverage-v2', { coveredThrough: 3 }),
			entry('note', 'turn-coverage-v2', { coveredThrough: 7 }),
			entry('note', 'turn-coverage-v2', { coveredThrough: 5 }),
		];
		assert.strictEqual(newestCoverageNote(notes), 7);
		assert.strictEqual(newestCoverageNote([]), undefined);
		assert.strictEqual(newestCoverageNote([userEntry('no note here')]), undefined);
		// U1 compatibility: the premature v1 convention certified the current
		// turn before its answer existed — it must not be honored as proof
		assert.strictEqual(
			newestCoverageNote([entry('note', 'turn-coverage', { coveredThrough: 9 })]),
			undefined,
			'v1 (premature-convention) notes are ignored, not trusted',
		);
	});

	test('turns NEWER than the note still need markers — the note does not over-cover', () => {
		const entries = [userEntry('turn zero', 0)];
		const covered = matchLedgerTurns(
			[{ message: 'turn zero' }, { message: 'turn one' }],
			entries,
			0,
		);
		assert.deepStrictEqual(userOnly(covered), [true, false], 'turn 1 is beyond the note and unmarked → migrates');
	});

	test('marker scan and note agree — no double coverage, no gaps', () => {
		const entries = [userEntry('turn zero', 0), userEntry('turn one', 1)];
		const covered = matchLedgerTurns(
			[{ message: 'turn zero' }, { message: 'turn one' }, { message: 'turn two' }],
			entries,
			1,
		);
		assert.deepStrictEqual(userOnly(covered), [true, true, false]);
	});
});

// ---------------------------------------------------------------------------
// Suite: the migration core (re-review T3/T4) — the exact function the
// provider runs, against a controlled ledger surface
// ---------------------------------------------------------------------------

interface IFakeIoOptions {
	entries: ILedgerEntry[];
	/** durable meta.json watermark (T4) */
	coverage?: number;
	/** hard cap the fake readTail can ever return (window simulation) */
	tailCap?: number;
	/** return null (refused write) for these append roles/turns */
	failAppend?: (record: { role: 'user' | 'assistant'; meta: { turn: number } }) => boolean;
}

function makeIo(opts: IFakeIoOptions): { io: ILegacyMigrationIo; writes: { role: string; content: string; turn: number }[] } {
	const writes: { role: string; content: string; turn: number }[] = [];
	const io: ILegacyMigrationIo = {
		statsEntryCount: async () => opts.entries.length,
		readTail: async max => opts.entries.slice(-Math.min(max, opts.tailCap ?? Number.MAX_SAFE_INTEGER)),
		readRange: async (fromSeq, toSeq) => opts.entries.filter(e => e.seq >= fromSeq && e.seq <= toSeq),
		getCoverage: async () => opts.coverage,
		append: async record => {
			if (opts.failAppend?.(record)) { return null; }
			writes.push({ role: record.role, content: record.content, turn: record.meta.turn });
			return entry(record.role, record.content, { turn: record.meta.turn });
		},
	};
	return { io, writes };
}

suite('ledgerTurns — migrateLegacyTurns (T3/T4)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('T3: a refused user write stops the watermark — nothing is certified, the retry repairs it', async () => {
		const history = [
			{ message: 'q0', assistantText: 'a0' },
			{ message: 'q1', assistantText: 'a1' },
		];
		// both writes for turn 0 refused (the re-review's probe)
		const failing = makeIo({ entries: [], failAppend: r => r.meta.turn === 0 });
		assert.strictEqual(await migrateLegacyTurns(failing.io, history), -1, 'nothing was confirmed');
		assert.deepStrictEqual(failing.writes, [], 'no certified records were produced');

		// writes recover — the next send must retry the missing turns
		const recovered = makeIo({ entries: [] });
		assert.strictEqual(await migrateLegacyTurns(recovered.io, history), 1);
		assert.deepStrictEqual(recovered.writes.map(w => `${w.role}:${w.turn}`), ['user:0', 'assistant:0', 'user:1', 'assistant:1']);
	});

	test('T3: an assistant write failing after a successful user write retries ONLY the assistant', async () => {
		const history = [{ message: 'q0', assistantText: 'a0' }];
		// previous send: user landed (marked), assistant append refused → the
		// honest watermark stayed at -1, so this send must repair the answer
		const entries = [userEntry('q0', 0)];
		const io = makeIo({ entries });
		assert.strictEqual(await migrateLegacyTurns(io.io, history), 0);
		assert.deepStrictEqual(io.writes.map(w => w.role), ['assistant'], 'the user record must NOT be duplicated');
		assert.strictEqual(io.writes[0].turn, 0);
	});

	test('T3: a mid-run failure keeps later turns migrating next send (contiguity, not batch failure)', async () => {
		const history = [
			{ message: 'q0', assistantText: 'a0' },
			{ message: 'q1', assistantText: 'a1' },
		];
		const io = makeIo({ entries: [], failAppend: r => r.role === 'assistant' && r.meta.turn === 0 });
		assert.strictEqual(await migrateLegacyTurns(io.io, history), -1, 'turn 0 is incomplete → watermark cannot pass it');
		// q0's user write already landed; the retry repairs a0 then migrates q1
		const retryEntries = [userEntry('q0', 0)];
		const retry = makeIo({ entries: retryEntries });
		assert.strictEqual(await migrateLegacyTurns(retry.io, history), 1);
		assert.deepStrictEqual(retry.writes.map(w => `${w.role}:${w.turn}`), ['assistant:0', 'user:1', 'assistant:1']);
	});

	test('T4: the meta watermark proves coverage when the note is outside every tail window', async () => {
		// the re-review's fixture: turn 0 journaled + coverage note, then
		// 2,050 tool entries push BOTH out of the 2,048 tail read
		const fixture: ILedgerEntry[] = [
			userEntry('archived request', 0),
			entry('assistant', 'archived answer', { turn: 0 }),
			entry('note', 'turn-coverage-v2', { coveredThrough: 0 }),
		];
		for (let i = 0; i < 2_050; i++) { fixture.push(entry('tool', `tool payload ${i}`)); }
		const history = [{ message: 'archived request', assistantText: 'archived answer' }];

		const viaMeta = makeIo({ entries: fixture, coverage: 0, tailCap: 2_048 });
		assert.strictEqual(await migrateLegacyTurns(viaMeta.io, history), 0);
		assert.deepStrictEqual(viaMeta.writes, [], 'the meta watermark must keep migration idempotent');

		// legacy archive without a meta watermark: the journal HEAD read
		// finds the note/markers (append-only archive → early turns live at the front)
		const viaHead = makeIo({ entries: fixture, tailCap: 2_048 });
		assert.strictEqual(await migrateLegacyTurns(viaHead.io, history), 0);
		assert.deepStrictEqual(viaHead.writes, [], 'the head read must keep migration idempotent without any watermark');
	});

	test('a fully covered history writes nothing and confirms through the last turn', async () => {
		const entries = [userEntry('q0', 0), entry('assistant', 'a0', { turn: 0 }), userEntry('q1', 1), entry('assistant', 'a1', { turn: 1 })];
		const history = [{ message: 'q0', assistantText: 'a0' }, { message: 'q1', assistantText: 'a1' }];
		const io = makeIo({ entries });
		assert.strictEqual(await migrateLegacyTurns(io.io, history), 1);
		assert.deepStrictEqual(io.writes, []);
	});
});

// ---------------------------------------------------------------------------
// Suite: follow-up U1/U3 — premature certification, mid-archive turns, and
// the v1-note compatibility rule
// ---------------------------------------------------------------------------

suite('ledgerTurns — migrateLegacyTurns (U1/U3)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('U1: the normal-send sequence never certifies the not-yet-answered turn', async () => {
		// the follow-up probe: send 1 with empty history appends q0 (turn 0)
		// and — because migration confirmed nothing — writes NO coverage note;
		// the assistant write then fails. Send 2 must repair the answer.
		// (The premature convention journaled coveredThrough=0 right after q0
		// and made the missing answer permanently unrecoverable.)
		const send1 = makeIo({ entries: [] });
		assert.strictEqual(await migrateLegacyTurns(send1.io, []), -1, 'empty history confirms nothing');
		const afterSend1: ILedgerEntry[] = [
			userEntry('q0', 0), // the provider's current-turn append — marker only
			// no note (migratedThrough was -1), and the assistant write failed
		];

		const send2 = makeIo({ entries: afterSend1 });
		const confirmed = await migrateLegacyTurns(send2.io, [{ message: 'q0', assistantText: 'a0' }]);
		assert.strictEqual(confirmed, 0, 'after the repair the turn is complete');
		assert.deepStrictEqual(send2.writes.map(w => `${w.role}:${w.turn}`), ['assistant:0'],
			'the failed answer is repaired; the user record is NOT duplicated');
	});

	test('U3: a turn in the MIDDLE of the archive is never re-appended', async () => {
		// the follow-up probe: marked q0/a0, 100 tools, marked q1/a1, then
		// 2,050 tools — q1/a1 fall into NEITHER the 2,048 tail NOR the head
		// window. Head/tail are accelerators; before declaring a record
		// absent, migration pages the WHOLE archive.
		const fixture: ILedgerEntry[] = [
			userEntry('q0', 0),
			entry('assistant', 'a0', { turn: 0 }),
		];
		for (let i = 0; i < 100; i++) { fixture.push(entry('tool', `early tool ${i}`)); }
		fixture.push(userEntry('q1', 1));
		fixture.push(entry('assistant', 'a1', { turn: 1 }));
		for (let i = 0; i < 2_050; i++) { fixture.push(entry('tool', `late tool ${i}`)); }
		const history = [
			{ message: 'q0', assistantText: 'a0' },
			{ message: 'q1', assistantText: 'a1' },
		];

		const io = makeIo({ entries: fixture, tailCap: 2_048 });
		assert.strictEqual(await migrateLegacyTurns(io.io, history), 1);
		assert.deepStrictEqual(io.writes, [], 'mid-archive turns must be found by the completeness scan, not re-journaled');
	});

	test('U3 (partial archive): a mid-archive turn with a genuinely missing answer is repaired, not skipped', async () => {
		// watermark 0 covers turn 0; turn 1's user sits mid-archive and its
		// assistant never landed — the full scan must prove the absence and
		// the repair must write ONLY the missing record
		const fixture: ILedgerEntry[] = [
			userEntry('q0', 0),
			entry('assistant', 'a0', { turn: 0 }),
			entry('note', 'turn-coverage-v2', { coveredThrough: 0 }),
		];
		for (let i = 0; i < 50; i++) { fixture.push(entry('tool', `tool ${i}`)); }
		fixture.push(userEntry('q1', 1));
		for (let i = 0; i < 2_050; i++) { fixture.push(entry('tool', `late tool ${i}`)); }
		const history = [
			{ message: 'q0', assistantText: 'a0' },
			{ message: 'q1', assistantText: 'a1' },
		];

		const io = makeIo({ entries: fixture, coverage: 0, tailCap: 2_048 });
		assert.strictEqual(await migrateLegacyTurns(io.io, history), 1);
		assert.deepStrictEqual(io.writes.map(w => `${w.role}:${w.turn}`), ['assistant:1'],
			'the absent answer is repaired exactly once; the mid-archive user record is not duplicated');
	});

	test('U1 compatibility: a premature v1 note is ignored — the certified-but-missing answer is repaired', async () => {
		// an archive written by the premature convention: a v1 note claims
		// turn 1 is covered while its answer was never journaled. Trusting
		// the note would skip the repair; ignoring it costs one full scan.
		const fixture: ILedgerEntry[] = [
			userEntry('q0', 0),
			entry('assistant', 'a0', { turn: 0 }),
			entry('note', 'turn-coverage', { coveredThrough: 1 }), // v1 — premature
			userEntry('q1', 1),
			// a1 never landed
		];
		const history = [
			{ message: 'q0', assistantText: 'a0' },
			{ message: 'q1', assistantText: 'a1' },
		];
		const io = makeIo({ entries: fixture });
		assert.strictEqual(await migrateLegacyTurns(io.io, history), 1);
		assert.deepStrictEqual(io.writes.map(w => `${w.role}:${w.turn}`), ['assistant:1'],
			'the v1 claim must not make the missing answer unrecoverable');
	});
});

// ---------------------------------------------------------------------------
// Suite: follow-up V1 — a progress/tool-call emission is not proof the final
// answer is archived; assistant completeness is CONTENT-based
// ---------------------------------------------------------------------------

suite('ledgerTurns — migrateLegacyTurns (V1)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('V1: an archived PROGRESS message does not certify the missing final answer', async () => {
		// the follow-up's exact fixture: the tool loop journaled the progress
		// message + its tool result; the final answer write failed. The
		// session history holds the completed response. The marker on the
		// progress record used to prove the turn's assistant side complete.
		const finalAnswer = '\nThe final finding is ANSWER-ONLY-IN-SESSION.';
		const fullResponse = `Checking the files.${finalAnswer}`;
		const fixture: ILedgerEntry[] = [
			userEntry('q0', 0),
			entry('assistant', 'Checking the files.', { turn: 0 }),
			entry('tool', 'read_file output', { toolCallId: 'call-1' }),
		];
		const history = [{ message: 'q0', assistantText: fullResponse }];

		const io = makeIo({ entries: fixture });
		assert.strictEqual(await migrateLegacyTurns(io.io, history), 0, 'the turn completes only after the repair');
		assert.strictEqual(io.writes.length, 1, 'exactly one repair record');
		assert.strictEqual(io.writes[0].role, 'assistant');
		assert.strictEqual(io.writes[0].turn, 0);
		assert.strictEqual(io.writes[0].content, finalAnswer,
			'the repair appends ONLY the missing part — the archived progress is not duplicated');

		// idempotent: with the suffix archived, the join equals the response
		// and the next send writes nothing
		const repaired: ILedgerEntry[] = [...fixture, entry('assistant', finalAnswer, { turn: 0 })];
		const again = makeIo({ entries: repaired });
		assert.strictEqual(await migrateLegacyTurns(again.io, history), 0);
		assert.deepStrictEqual(again.writes, [], 'the completed response must now prove coverage by content');
	});

	test('V1: an EMPTY tool-call-only assistant record does not certify the answer', async () => {
		// the loop journals `content: ''` when an emission only issues tool
		// calls — the join is empty, so a missing final answer still repairs
		const fixture: ILedgerEntry[] = [
			userEntry('q0', 0),
			entry('assistant', '', { turn: 0 }),
			entry('tool', 'read_file output', { toolCallId: 'call-1' }),
		];
		const history = [{ message: 'q0', assistantText: 'The final answer is here.' }];
		const io = makeIo({ entries: fixture });
		assert.strictEqual(await migrateLegacyTurns(io.io, history), 0);
		assert.deepStrictEqual(io.writes.map(w => w.content), ['The final answer is here.'],
			'nothing was archived of the response — the full answer is repaired once');
	});

	test('V1: a multi-part response whose parts ALL landed is complete — no writes', async () => {
		// every loop emission is journaled as its own record; the join of the
		// parts equals the session history's joined response
		const fixture: ILedgerEntry[] = [
			userEntry('q0', 0),
			entry('assistant', 'Checking the files.', { turn: 0 }),
			entry('tool', 'read_file output', { toolCallId: 'call-1' }),
			entry('assistant', '\nThe final finding is ANSWER.', { turn: 0 }),
		];
		const history = [{ message: 'q0', assistantText: 'Checking the files.\nThe final finding is ANSWER.' }];
		const io = makeIo({ entries: fixture });
		assert.strictEqual(await migrateLegacyTurns(io.io, history), 0);
		assert.deepStrictEqual(io.writes, [], 'the concatenated parts prove the response complete');
	});

	test('V1: matchLedgerTurns decides assistant coverage from the join, not the marker', () => {
		const entries = [
			userEntry('q0', 0),
			entry('assistant', 'progress only', { turn: 0 }),
		];
		const covered = matchLedgerTurns([{ message: 'q0', assistantText: 'progress only plus the answer' }], entries);
		assert.strictEqual(covered[0].user, true);
		assert.strictEqual(covered[0].assistant, false, 'a progress record alone must not cover the response');
	});
});
