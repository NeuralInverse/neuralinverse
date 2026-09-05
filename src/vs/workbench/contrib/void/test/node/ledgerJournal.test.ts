/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ILedgerEntry } from '../../common/ledgerTypes.js';
import { DEFAULT_LEDGER_POLICY, ILedgerPolicy } from '../../common/ledgerPolicy.js';
import {
	encodeEntry,
	decodeEntry,
	decodeEntries,
	JournalSeq,
	shouldRotate,
	journalFileName,
	episodeFileName,
	splitContent,
	computeStats,
	renderEntryLine,
} from '../../common/ledgerJournalCore.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function makeEntry(overrides: Partial<ILedgerEntry> = {}): ILedgerEntry {
	const seq = overrides.seq ?? ++_seq;
	return {
		id: `le_t_${seq}`,
		seq,
		threadId: 't',
		role: 'user',
		content: 'hello',
		ts: 1_000 + seq,
		tokens: 10,
		...overrides,
	};
}

function policy(overrides: Partial<ILedgerPolicy>): ILedgerPolicy {
	return { ...DEFAULT_LEDGER_POLICY, ...overrides };
}

// ---------------------------------------------------------------------------
// Suite: encode / decode
// ---------------------------------------------------------------------------

suite('ledgerJournalCore — JSONL encode/decode', () => {

	test('roundtrip: encode produces one line and decode restores the entry', () => {
		const entry = makeEntry({ role: 'tool', name: 'grep', content: 'match found', meta: { exitCode: 0 } });
		const line = encodeEntry(entry);
		assert.ok(!line.includes('\n'), 'encoded entry must be a single line');
		assert.deepStrictEqual(decodeEntry(line), entry);
	});

	test('decode tolerates blank lines', () => {
		assert.strictEqual(decodeEntry(''), null);
		assert.strictEqual(decodeEntry('   \t '), null);
	});

	test('decode tolerates corrupt JSON', () => {
		assert.strictEqual(decodeEntry('not json at all'), null);
		assert.strictEqual(decodeEntry('{"id": "le_t_1", "seq": 1,'), null);
	});

	test('decode rejects well-formed JSON that is not a ledger entry', () => {
		assert.strictEqual(decodeEntry('[]'), null);
		assert.strictEqual(decodeEntry('null'), null);
		assert.strictEqual(decodeEntry('{"id":"x"}'), null, 'missing required fields');
		assert.strictEqual(
			decodeEntry('{"id":"x","seq":"5","threadId":"t","role":"user","content":"c","ts":1,"tokens":2}'),
			null,
			'seq must be a number',
		);
		assert.strictEqual(
			decodeEntry('{"id":"x","seq":5,"threadId":"t","role":"wizard","content":"c","ts":1,"tokens":2}'),
			null,
			'role must be a known ledger role',
		);
	});

	test('decodeEntries skips blank and corrupt lines but keeps valid ones', () => {
		const entry = makeEntry();
		const file = `garbage line\n\n${encodeEntry(entry)}\n   \n{"broken":\n`;
		const entries = decodeEntries(file);
		assert.strictEqual(entries.length, 1);
		assert.deepStrictEqual(entries[0], entry);
	});
});

// ---------------------------------------------------------------------------
// Suite: JournalSeq
// ---------------------------------------------------------------------------

suite('ledgerJournalCore — JournalSeq', () => {

	test('next() assigns gapless ascending seqs starting at 1', () => {
		const seq = new JournalSeq();
		assert.strictEqual(seq.next(), 1);
		assert.strictEqual(seq.next(), 2);
		assert.strictEqual(seq.next(), 3);
		assert.strictEqual(seq.last, 3);
		assert.strictEqual(seq.nextExpected, 4);
	});

	test('observe() accepts a continuous stream', () => {
		const seq = new JournalSeq();
		assert.strictEqual(seq.observe(1), true);
		assert.strictEqual(seq.observe(2), true);
		assert.strictEqual(seq.observe(3), true);
		assert.strictEqual(seq.nextExpected, 4);
	});

	test('observe() returns false on a gap and realigns past it', () => {
		const seq = new JournalSeq();
		assert.strictEqual(seq.observe(1), true);
		assert.strictEqual(seq.observe(4), false, 'gap 2..3 must be detected');
		assert.strictEqual(seq.observe(5), true, 'realigned: 5 follows the adopted 4');
		assert.strictEqual(seq.last, 5);
	});

	test('observe() returns false on duplicates and rewinds without moving', () => {
		const seq = new JournalSeq();
		seq.observe(1);
		seq.observe(2);
		assert.strictEqual(seq.observe(2), false, 'duplicate');
		assert.strictEqual(seq.observe(1), false, 'rewind');
		assert.strictEqual(seq.nextExpected, 3, 'tracker must not move backwards');
	});
});

// ---------------------------------------------------------------------------
// Suite: rotation & file names
// ---------------------------------------------------------------------------

suite('ledgerJournalCore — rotation', () => {

	test('rotates at or above journalRotateBytes, not below', () => {
		const p = policy({ journalRotateBytes: 1_000 });
		assert.strictEqual(shouldRotate(0, p), false);
		assert.strictEqual(shouldRotate(999, p), false);
		assert.strictEqual(shouldRotate(1_000, p), true);
		assert.strictEqual(shouldRotate(2_500, p), true);
	});

	test('journal and episode file names are zero-padded', () => {
		assert.strictEqual(journalFileName(1), '000001.jsonl');
		assert.strictEqual(journalFileName(42), '000042.jsonl');
		assert.strictEqual(episodeFileName(1), 'ep-000001.json');
		assert.strictEqual(episodeFileName(123), 'ep-000123.json');
	});
});

// ---------------------------------------------------------------------------
// Suite: inline/blob split
// ---------------------------------------------------------------------------

suite('ledgerJournalCore — splitContent', () => {

	test('content at exactly inlineMaxChars stays inline with no blobRef', () => {
		const p = policy({ inlineMaxChars: 100 });
		const content = 'a'.repeat(100);
		const split = splitContent(content, p);
		assert.strictEqual(split.blobRef, undefined);
		assert.strictEqual(split.inline, content);
	});

	test('content below inlineMaxChars stays inline with no blobRef', () => {
		const p = policy({ inlineMaxChars: 100 });
		const split = splitContent('short', p);
		assert.strictEqual(split.blobRef, undefined);
		assert.strictEqual(split.inline, 'short');
	});

	test('content far above inlineMaxChars keeps a 70% head + 20% tail window', () => {
		const p = policy({ inlineMaxChars: 100 });
		const body = 'A'.repeat(350) + 'B'.repeat(300) + 'C'.repeat(350);
		const split = splitContent(body, p);
		assert.ok(split.blobRef, 'oversized content must produce a blobRef');
		assert.ok(split.blobRef.startsWith('blobs/'), `blobRef format is blobs/<id>, got ${split.blobRef}`);
		assert.ok(split.inline.startsWith(body.slice(0, 70)), 'inline must keep the 70% head');
		assert.ok(split.inline.endsWith(body.slice(body.length - 20)), 'inline must keep the 20% tail');
		assert.ok(split.inline.includes(': 1000 chars total]'), 'marker must carry the real total length');
		assert.ok(split.inline.length < body.length, 'inline window must be smaller than the body');
	});

	test('custom blobId is used verbatim in the blobRef', () => {
		const p = policy({ inlineMaxChars: 10 });
		const split = splitContent('x'.repeat(50), p, 'le_t_9.txt');
		assert.strictEqual(split.blobRef, 'blobs/le_t_9.txt');
		assert.ok(split.inline.includes('blobs/le_t_9.txt'));
	});
});

// ---------------------------------------------------------------------------
// Suite: computeStats
// ---------------------------------------------------------------------------

suite('ledgerJournalCore — computeStats', () => {

	test('sums tokens, counts entries and finds lastSeq', () => {
		const entries = [
			makeEntry({ seq: 1, tokens: 10 }),
			makeEntry({ seq: 2, tokens: 20 }),
			makeEntry({ seq: 3, tokens: 30 }),
		];
		const stats = computeStats(entries, []);
		assert.deepStrictEqual(stats, {
			entryCount: 3,
			totalTokens: 60,
			unsummarizedTokens: 60,
			lastSeq: 3,
			episodeCount: 0,
		});
	});

	test('unsummarized tokens cover entries after the last episode range', () => {
		const entries = [];
		for (let seq = 1; seq <= 5; seq++) entries.push(makeEntry({ seq, tokens: 10 }));
		const stats = computeStats(entries, [{ fromSeq: 1, toSeq: 3 }]);
		assert.strictEqual(stats.entryCount, 5);
		assert.strictEqual(stats.totalTokens, 50);
		assert.strictEqual(stats.unsummarizedTokens, 20, 'only seq 4 and 5 are unsummarized');
		assert.strictEqual(stats.lastSeq, 5);
		assert.strictEqual(stats.episodeCount, 1);
	});

	test('multiple episodes: the highest toSeq defines the unsummarized cut', () => {
		const entries = [];
		for (let seq = 1; seq <= 8; seq++) entries.push(makeEntry({ seq, tokens: 5 }));
		const stats = computeStats(entries, [
			{ fromSeq: 1, toSeq: 3 },
			{ fromSeq: 4, toSeq: 6 },
		]);
		assert.strictEqual(stats.episodeCount, 2);
		assert.strictEqual(stats.unsummarizedTokens, 10, 'seq 7 and 8 at 5 tokens each');
	});

	test('empty journal yields zeros', () => {
		assert.deepStrictEqual(computeStats([], []), {
			entryCount: 0,
			totalTokens: 0,
			unsummarizedTokens: 0,
			lastSeq: 0,
			episodeCount: 0,
		});
	});
});

// ---------------------------------------------------------------------------
// Suite: renderEntryLine
// ---------------------------------------------------------------------------

suite('ledgerJournalCore — renderEntryLine', () => {

	test('renders roles as tagged transcript lines', () => {
		assert.strictEqual(renderEntryLine(makeEntry({ role: 'user', content: 'hi' })), '[[USER]]\nhi');
		assert.strictEqual(renderEntryLine(makeEntry({ role: 'assistant', content: 'ok' })), '[[ASSISTANT]]\nok');
		assert.strictEqual(renderEntryLine(makeEntry({ role: 'tool', name: 'grep', content: 'match' })), '[[TOOL(grep)]]\nmatch');
	});

	test('tool entries without a name render as TOOL(unknown)', () => {
		assert.strictEqual(renderEntryLine(makeEntry({ role: 'tool', content: 'x' })), '[[TOOL(unknown)]]\nx');
	});

	test('bounds oversized content to a 20k-char window', () => {
		const head = 'H'.repeat(10_000);
		const middle = 'M'.repeat(30_000);
		const tail = 'T'.repeat(10_000);
		const entry = makeEntry({ role: 'assistant', content: head + middle + tail });
		const line = renderEntryLine(entry);
		assert.ok(line.startsWith('[[ASSISTANT]]\n' + head), 'first 10k chars are kept verbatim');
		assert.ok(line.endsWith((head + middle + tail).slice(-4_000)), 'last 4k chars are kept verbatim');
		assert.ok(line.includes('chars omitted]'), 'omission marker must be present');
		assert.ok(line.length < 21_000, `bounded line must stay near 20k, got ${line.length}`);
	});

	test('content under the bound is rendered verbatim', () => {
		const content = 'c'.repeat(20_000);
		const line = renderEntryLine(makeEntry({ role: 'system', content }));
		assert.strictEqual(line, `[[SYSTEM]]\n${content}`);
	});
});
