/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { deterministicEpisodeBody, EpisodeSummarizer, parseEpisodeJson } from '../../browser/episodeSummarizer.js';
import { DEFAULT_LEDGER_POLICY, resolvePolicy } from '../../common/ledgerPolicy.js';
import { ILedgerEntry, ILedgerStats, LedgerRole } from '../../common/ledgerTypes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function makeEntry(role: LedgerRole, content: string, extra?: Partial<ILedgerEntry>): ILedgerEntry {
	_seq++;
	return {
		id: `le_test_${_seq}`,
		seq: _seq,
		threadId: 'test-thread',
		role,
		content,
		ts: 1_700_000_000_000 + _seq,
		tokens: Math.ceil(content.length / 4),
		...extra,
	} satisfies ILedgerEntry;
}

function makeStats(overrides: Partial<ILedgerStats>): ILedgerStats {
	return {
		entryCount: 200,
		totalTokens: 100_000,
		unsummarizedTokens: 0,
		lastSeq: 200,
		episodeCount: 0,
		journalBytes: 0,
		lastEntryTs: 0,
		...overrides,
	} satisfies ILedgerStats;
}

/** Small numbers so thresholds are easy to sit on either side of. */
const SMALL_POLICY = resolvePolicy({
	episodeTargetTokens: 100,
	episodeMinTokens: 20,
	cacheIdleCompactMs: 1_000,
	tailMinMessages: 2,
});

// ---------------------------------------------------------------------------
// Suite: parseEpisodeJson
// ---------------------------------------------------------------------------

suite('episodeSummarizer — parseEpisodeJson', () => {

	test('clean JSON parses with all fields intact', () => {
		const text = JSON.stringify({
			goal: 'ship the ledger',
			decisions: [{ what: 'use pnpm', why: 'faster installs', alternatives: ['npm'], sourceIds: [1, 2] }],
			failures: [{ attempt: 'npm run build', error: 'missing script', resolution: 'fixed', sourceIds: [3] }],
			invariants: ['always use pnpm'],
			rejected: [{ approach: 'rewrite storage', reason: 'too risky', sourceIds: [4] }],
		});
		const body = parseEpisodeJson(text);
		assert.ok(body, 'clean JSON must parse');
		assert.strictEqual(body.goal, 'ship the ledger');
		assert.strictEqual(body.decisions.length, 1);
		assert.strictEqual(body.decisions[0]!.what, 'use pnpm');
		assert.deepStrictEqual(body.decisions[0]!.sourceIds, [1, 2]);
		assert.deepStrictEqual(body.decisions[0]!.alternatives, ['npm']);
		assert.strictEqual(body.failures[0]!.resolution, 'fixed');
		assert.deepStrictEqual(body.rejected[0]!.sourceIds, [4]);
		assert.deepStrictEqual(body.invariants, ['always use pnpm']);
	});

	test('JSON wrapped in prose is recovered by slicing first brace to last brace', () => {
		const json = '{"goal":"g","next":["a"]}';
		const body = parseEpisodeJson(`Sure, here is the summary you asked for:\n${json}\nHope that helps!`);
		assert.ok(body, 'prose-wrapped JSON must parse');
		assert.strictEqual(body.goal, 'g');
		assert.deepStrictEqual(body.next, ['a']);
	});

	test('trailing commas are tolerated', () => {
		const body = parseEpisodeJson('{"goal":"g","next":["a","b",],"invariants":["i",],}');
		assert.ok(body, 'trailing commas must be repaired');
		assert.strictEqual(body.goal, 'g');
		assert.deepStrictEqual(body.next, ['a', 'b']);
		assert.deepStrictEqual(body.invariants, ['i']);
	});

	test('unclosed brackets are repaired by appending the missing closers', () => {
		const outer = parseEpisodeJson('{"goal":"g","next":["a","b"');
		assert.ok(outer, 'unclosed outer bracket must be repaired');
		assert.deepStrictEqual(outer.next, ['a', 'b']);

		const nested = parseEpisodeJson('{"artifacts":{"files":["f.ts",');
		assert.ok(nested, 'nested unclosed brackets must be repaired');
		assert.deepStrictEqual(nested.artifacts.files, ['f.ts']);
	});

	test('wrong-typed fields are coerced or dropped', () => {
		const body = parseEpisodeJson([
			'{',
			'"goal": 42,',
			'"decisions": "nope",',
			'"invariants": ["keep", 7, null, true],',
			'"artifacts": "nope",',
			'"state": {"done": ["d"], "inProgress": "nope"},',
			'"failures": [{"attempt":"a","error":"e","resolution":"later","sourceIds":["5"]}]',
			'}',
		].join('\n'));
		assert.ok(body);
		assert.strictEqual(body.goal, '42', 'numeric goal coerced to string');
		assert.deepStrictEqual(body.decisions, [], 'non-array decisions dropped');
		assert.deepStrictEqual(body.invariants, ['keep', '7'], 'strings and finite numbers kept, null/true dropped');
		assert.deepStrictEqual(body.artifacts.files, [], 'non-object artifacts dropped');
		assert.deepStrictEqual(body.state.done, ['d']);
		assert.deepStrictEqual(body.state.inProgress, [], 'non-array state list dropped');
		assert.strictEqual(body.failures[0]!.resolution, 'open', 'invalid resolution clamped to open');
		assert.deepStrictEqual(body.failures[0]!.sourceIds, [5], 'numeric-string sourceId coerced');
	});

	test('items missing required strings are dropped', () => {
		const body = parseEpisodeJson([
			'{',
			'"rejected": [',
			'  {"approach":"a","reason":""},',
			'  {"approach":"","reason":"r"},',
			'  {"approach":"ok","reason":"because","sourceIds":[2]}',
			'],',
			'"corrections": [{"ruleDerived":"r"}]',
			'}',
		].join('\n'));
		assert.ok(body);
		assert.strictEqual(body.rejected.length, 1, 'items missing approach or reason dropped');
		assert.strictEqual(body.rejected[0]!.approach, 'ok');
		assert.deepStrictEqual(body.corrections, [], 'correction without userSaid dropped');
	});

	test('failure resolution is clamped to the fixed set, case-insensitively', () => {
		const body = parseEpisodeJson('{"failures":['
			+ '{"attempt":"a1","error":"e1","resolution":"Fixed","sourceIds":[]},'
			+ '{"attempt":"a2","error":"e2","resolution":"ABANDONED","sourceIds":[]},'
			+ '{"attempt":"a3","error":"e3","resolution":"postponed","sourceIds":[]}]}');
		assert.ok(body);
		assert.strictEqual(body.failures[0]!.resolution, 'fixed');
		assert.strictEqual(body.failures[1]!.resolution, 'abandoned');
		assert.strictEqual(body.failures[2]!.resolution, 'open');
	});

	test('unparseable input returns null, never throws', () => {
		assert.strictEqual(parseEpisodeJson(''), null);
		assert.strictEqual(parseEpisodeJson('no braces here at all'), null);
		assert.strictEqual(parseEpisodeJson('still { broken without any close'), null);
	});
});

// ---------------------------------------------------------------------------
// Suite: deterministicEpisodeBody
// ---------------------------------------------------------------------------

suite('episodeSummarizer — deterministicEpisodeBody', () => {

	function buildFixture(): ILedgerEntry[] {
		return [
			// seq 1 — two invariant sentences (English markers)
			makeEntry('user', 'Always use pnpm in this repo. Never force-push to main.'),
			// seq 2 — Persian invariant marker
			makeEntry('user', 'از این به بعد کامنت‌ها انگلیسی باشه.'),
			// seq 3 — plain assistant reply, no negation marker
			makeEntry('assistant', 'Understood. I will set up the build with pnpm.'),
			// seq 4 — failing tool via meta.exitCode
			makeEntry('tool', 'npm ERR! missing script: build', { name: 'terminal', meta: { exitCode: 1 } }),
			// seq 5 — files from meta.filePaths AND from a path regex hit in content; not a failure
			makeEntry('tool', 'loaded src/main.ts and src/vs/workbench/contrib/void/browser/episodeSummarizer.ts', { name: 'readFile', meta: { filePaths: ['src/main.ts'] } }),
			// seq 6 — error-like words but no exitCode/stderr marker → NOT a failure
			makeEntry('tool', 'permission denied: cannot open lock file', { name: 'terminal', meta: {} }),
			// seq 7 — error-like words + "exit code" marker in content → failure without meta.exitCode
			makeEntry('tool', 'the process failed. exit code: 1', { name: 'terminal' }),
			// seq 8 — assistant proposal the user is about to reject
			makeEntry('assistant', 'Instead of dropping the table, we could keep it and add a flag.'),
			// seq 9 — user correction: the negation marker sits in the correcting reply itself
			makeEntry('user', 'No. Keep the table and add a flag.'),
			// seq 10 — successful tool, must not become a failure
			makeEntry('tool', 'build succeeded', { name: 'terminal', meta: { exitCode: 0 } }),
		];
	}

	test('invariants: every user-command marker sentence is extracted, capped and deduped', () => {
		const body = deterministicEpisodeBody(buildFixture());
		assert.strictEqual(body.invariants.length, 3);
		assert.ok(body.invariants[0]!.startsWith('Always use pnpm'));
		assert.ok(body.invariants[1]!.startsWith('Never force-push'));
		assert.ok(body.invariants[2]!.includes('از این به بعد'));
	});

	test('invariants are capped at 200 chars', () => {
		const filler = 'x'.repeat(500);
		const body = deterministicEpisodeBody([makeEntry('user', `Always log to disk. ${filler}`)]);
		assert.strictEqual(body.invariants.length, 1);
		assert.ok(body.invariants[0]!.length <= 200);
		assert.ok(body.invariants[0]!.endsWith('…'));
	});

	test('failures: exitCode != 0 and error-like content with markers are captured, others are not', () => {
		const body = deterministicEpisodeBody(buildFixture());
		assert.strictEqual(body.failures.length, 2, 'seq 4 (exitCode=1) and seq 7 (failed + exit code marker) only');
		assert.strictEqual(body.failures[0]!.sourceIds[0], 4);
		assert.strictEqual(body.failures[0]!.resolution, 'open');
		assert.ok(body.failures[0]!.error.includes('npm ERR!'));
		assert.strictEqual(body.failures[1]!.sourceIds[0], 7);
	});

	test('artifacts.files: union of meta.filePaths and content path matches', () => {
		const body = deterministicEpisodeBody(buildFixture());
		assert.deepStrictEqual(body.artifacts.files, [
			'src/main.ts',
			'src/vs/workbench/contrib/void/browser/episodeSummarizer.ts',
		]);
		assert.deepStrictEqual(body.artifacts.symbols, []);
		assert.deepStrictEqual(body.artifacts.commands, []);
		assert.deepStrictEqual(body.artifacts.configs, []);
	});

	test('corrections: user entry right after a negation-bearing assistant entry', () => {
		const body = deterministicEpisodeBody(buildFixture());
		assert.strictEqual(body.corrections.length, 1);
		assert.strictEqual(body.corrections[0]!.userSaid, 'No. Keep the table and add a flag.');
		assert.deepStrictEqual(body.corrections[0]!.sourceIds, [9]);
	});

	test('goal from the first user entry, state.inProgress from the last user entry', () => {
		const body = deterministicEpisodeBody(buildFixture());
		assert.strictEqual(body.goal, 'Always use pnpm in this repo. Never force-push to main.');
		assert.deepStrictEqual(body.state.inProgress, ['No. Keep the table and add a flag.']);
		assert.deepStrictEqual(body.state.done, []);
		assert.deepStrictEqual(body.state.verified, []);
	});

	test('everything without a mechanical rule stays empty', () => {
		const body = deterministicEpisodeBody(buildFixture());
		assert.deepStrictEqual(body.decisions, []);
		assert.deepStrictEqual(body.rejected, []);
		assert.deepStrictEqual(body.next, []);
		assert.deepStrictEqual(body.openQuestions, []);
	});

	test('empty entry list yields a valid empty body', () => {
		const body = deterministicEpisodeBody([]);
		assert.strictEqual(body.goal, '');
		assert.deepStrictEqual(body.invariants, []);
		assert.deepStrictEqual(body.failures, []);
		assert.deepStrictEqual(body.state.inProgress, []);
	});
});

// ---------------------------------------------------------------------------
// Suite: decideBoundary
// ---------------------------------------------------------------------------

suite('episodeSummarizer — decideBoundary', () => {

	test('token threshold: unsummarized tokens at target close with reason tokens', () => {
		const d = EpisodeSummarizer.decideBoundary(makeStats({ unsummarizedTokens: 100 }), 5, 0, SMALL_POLICY);
		assert.ok(d && d.close === true && d.reason === 'tokens');
	});

	test('below target with no idle returns null (nothing pending)', () => {
		const d = EpisodeSummarizer.decideBoundary(makeStats({ unsummarizedTokens: 99 }), 5, 0, SMALL_POLICY);
		assert.strictEqual(d, null);
	});

	test('idle plus minimum tokens closes with reason idle', () => {
		const d = EpisodeSummarizer.decideBoundary(makeStats({ unsummarizedTokens: 20 }), 5, 1_001, SMALL_POLICY);
		assert.ok(d && d.close === true && d.reason === 'idle');
	});

	test('idle below minimum tokens refuses with reason min', () => {
		const d = EpisodeSummarizer.decideBoundary(makeStats({ unsummarizedTokens: 19 }), 5, 1_001, SMALL_POLICY);
		assert.ok(d && d.close === false && d.reason === 'min');
	});

	test('idle exactly at the threshold does not trigger (strictly greater required)', () => {
		const d = EpisodeSummarizer.decideBoundary(makeStats({ unsummarizedTokens: 50 }), 5, 1_000, SMALL_POLICY);
		assert.strictEqual(d, null);
	});

	test('tail-gap refusal: trigger fires but too few entries would remain after the boundary', () => {
		const d = EpisodeSummarizer.decideBoundary(makeStats({ unsummarizedTokens: 100 }), 1, 0, SMALL_POLICY);
		assert.ok(d && d.close === false && d.reason === 'tail-gap');
	});

	test('force overrides every guard with reason manual', () => {
		const d = EpisodeSummarizer.decideBoundary(makeStats({ unsummarizedTokens: 0 }), 0, 0, SMALL_POLICY, { force: true });
		assert.ok(d && d.close === true && d.reason === 'manual');
	});

	test('default policy: 60k unsummarized tokens with a full tail closes', () => {
		const d = EpisodeSummarizer.decideBoundary(
			makeStats({ unsummarizedTokens: 60_000 }),
			DEFAULT_LEDGER_POLICY.tailMinMessages,
			0,
			DEFAULT_LEDGER_POLICY,
		);
		assert.ok(d && d.close === true && d.reason === 'tokens');
	});
});
