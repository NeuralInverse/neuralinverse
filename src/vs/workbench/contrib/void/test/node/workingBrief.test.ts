/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	normalizeKey,
	mergeEpisodeBodies,
	shrinkToBudget,
	renderWorkingMemory,
	buildWorkingBrief,
} from '../../common/workingBriefBuilder.js';
import { IEpisodeBody, IEpisodeSummary, IWorkingBrief } from '../../common/ledgerTypes.js';
import { DEFAULT_LEDGER_POLICY, estimateTokens, resolvePolicy } from '../../common/ledgerPolicy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyBody(): IEpisodeBody {
	return {
		goal: '',
		decisions: [],
		rejected: [],
		failures: [],
		corrections: [],
		invariants: [],
		artifacts: { files: [], symbols: [], commands: [], configs: [] },
		state: { done: [], inProgress: [], verified: [] },
		next: [],
		openQuestions: [],
	};
}

function makeEpisode(ordinal: number, body: Partial<IEpisodeBody>): IEpisodeSummary {
	return {
		id: `ep_t1_${ordinal}`,
		threadId: 't1',
		ordinal,
		range: { fromSeq: ordinal * 100, toSeq: ordinal * 100 + 99 },
		createdAt: 1_700_000_000_000 + ordinal,
		producedBy: 'deterministic',
		frozen: true,
		body: { ...emptyBody(), ...body },
	};
}

function richEpisodes(): IEpisodeSummary[] {
	return [
		makeEpisode(1, {
			goal: 'ship the context ledger',
			invariants: ['always use pnpm'],
			rejected: [{ approach: 'rewrite the compactor from scratch', reason: 'too risky', evidence: 'review call 2026-09-01', sourceIds: [11] }],
			decisions: [{ what: 'merge deterministically', why: 'no drift without an LLM', sourceIds: [12] }],
			failures: [{ attempt: 'indexeddb bulk write', error: 'quota exceeded', resolution: 'open', sourceIds: [13] }],
			corrections: [{ userSaid: 'keep it pure typescript', ruleDerived: 'no DI in common', sourceIds: [14] }],
			artifacts: { files: ['ledgerTypes.ts'], symbols: ['mergeEpisodeBodies'], commands: ['pnpm test'], configs: [] },
			state: { done: ['types'], inProgress: ['merge'], verified: [] },
			next: ['write the merge tests'],
			openQuestions: ['who calls the builder?'],
		}),
		makeEpisode(2, {
			goal: 'ship the context ledger, phase 2',
			decisions: [{ what: 'render an xml-ish block', why: 'stable and parseable', sourceIds: [21] }],
			artifacts: { files: ['ledgerTypes.ts', 'workingBriefBuilder.ts'], symbols: ['mergeEpisodeBodies', 'renderWorkingMemory'], commands: ['pnpm test'], configs: [] },
			state: { done: ['types', 'merge'], inProgress: ['render'], verified: ['merge'] },
			next: ['wire the assembler'],
		}),
	];
}

// ---------------------------------------------------------------------------
// Suite: normalizeKey
// ---------------------------------------------------------------------------

suite('workingBriefBuilder — normalizeKey', () => {

	test('trims, lowercases, collapses whitespace and strips trailing punctuation', () => {
		assert.strictEqual(normalizeKey('  Always   use pnpm.  '), 'always use pnpm');
		assert.strictEqual(normalizeKey('Never force-push!'), 'never force-push');
		assert.strictEqual(normalizeKey('No semicolons;'), 'no semicolons');
		assert.strictEqual(normalizeKey('same'), 'same');
	});
});

// ---------------------------------------------------------------------------
// Suite: mergeEpisodeBodies — one test per rule of task 6-3
// ---------------------------------------------------------------------------

suite('workingBriefBuilder — mergeEpisodeBodies (task 6-3 rules)', () => {

	test('rule 1 invariants — union dedupes by normalized key', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(1, { invariants: ['Always use pnpm.'] }),
			makeEpisode(2, { invariants: ['Always use pnpm.', 'never force-push'] }),
		], resolvePolicy());
		assert.deepStrictEqual(merged.invariants, ['Always use pnpm.', 'never force-push']);
	});

	test('rule 1 invariants — conflict keeps the newer text and the older one with (superseded)', () => {
		// both lines normalize to the key 'always use pnpm' but differ in raw text
		const merged = mergeEpisodeBodies([
			makeEpisode(1, { invariants: ['always use pnpm'] }),
			makeEpisode(3, { invariants: ['Always use pNpm'] }),
		], resolvePolicy());
		assert.deepStrictEqual(merged.invariants, [
			'Always use pNpm',
			'always use pnpm (superseded)',
		]);
	});

	test('rule 1 invariants — cap keeps most-recent-episode items first, then first-seen order', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(1, { invariants: ['old-a', 'old-b'] }),
			makeEpisode(2, { invariants: ['mid'] }),
			makeEpisode(3, { invariants: ['new-a', 'new-b'] }),
		], resolvePolicy({ maxInvariants: 3 }));
		// new-a/new-b (ep 3) and mid (ep 2) survive; old-a/old-b are evicted
		assert.deepStrictEqual(merged.invariants, ['mid', 'new-a', 'new-b']);
	});

	test('rule 2 rejected — reason and evidence come from the newest episode restating the approach', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(1, { rejected: [{ approach: 'MongoDB', reason: 'too slow', evidence: 'bench: 2s', sourceIds: [10, 11] }] }),
			makeEpisode(4, { rejected: [{ approach: 'mongodb', reason: 'no hosting budget', sourceIds: [400] }] }),
		], resolvePolicy());
		assert.strictEqual(merged.rejected.length, 1);
		const item = merged.rejected[0]!;
		assert.strictEqual(item.approach, 'mongodb');
		assert.strictEqual(item.reason, 'no hosting budget');
		assert.strictEqual(item.evidence, undefined);
		assert.deepStrictEqual(item.sourceIds, [10, 11, 400]);
		// first-seen ordinal rides along for the renderer's episode="N" attribute
		assert.strictEqual((item as { episode?: number }).episode, 1);
	});

	test('rule 2 rejected — cap evicts the oldest entry with no sourceIds reference in the newest 3 episodes', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(1, { rejected: [
				{ approach: 'alpha approach', reason: 'r', sourceIds: [1] },
				{ approach: 'beta approach', reason: 'r', sourceIds: [2] },
			] }),
			makeEpisode(2, {}),
			makeEpisode(3, {}),
			makeEpisode(4, {}),
			makeEpisode(5, { rejected: [{ approach: 'gamma approach', reason: 'r', sourceIds: [50] }] }),
		], resolvePolicy({ maxRejected: 2 }));
		// ep1 (alpha/beta) is outside the ep3–ep5 recency window and unprotected;
		// gamma lives in ep5 so it is protected. The oldest candidate tie is
		// broken alphabetically: alpha is evicted.
		assert.deepStrictEqual(merged.rejected.map(r => r.approach), ['beta approach', 'gamma approach']);
	});

	test('rule 3 corrections — union by ruleDerived ?? userSaid with the newest phrasing winning', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(1, { corrections: [{ userSaid: 'no tabs', ruleDerived: 'use spaces', sourceIds: [5] }] }),
			makeEpisode(2, { corrections: [{ userSaid: 'Use spaces!', sourceIds: [20] }] }),
		], resolvePolicy());
		// ep1 keys on ruleDerived 'use spaces'; ep2 (no ruleDerived) keys on the
		// same normalized userSaid → collision, newest fields win, sourceIds union
		assert.strictEqual(merged.corrections.length, 1);
		const item = merged.corrections[0]!;
		assert.strictEqual(item.userSaid, 'Use spaces!');
		assert.strictEqual(item.ruleDerived, undefined);
		assert.deepStrictEqual(item.sourceIds, [5, 20]);
	});

	test('rule 4 decisions — union by what with the newest phrasing winning', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(1, { decisions: [{ what: 'use library X', why: 'first reason', sourceIds: [1] }] }),
			makeEpisode(2, { decisions: [{ what: 'Use library X!', why: 'better reason', sourceIds: [2] }] }),
		], resolvePolicy());
		assert.strictEqual(merged.decisions.length, 1);
		const item = merged.decisions[0]!;
		assert.strictEqual(item.what, 'Use library X!');
		assert.strictEqual(item.why, 'better reason');
		assert.deepStrictEqual(item.sourceIds, [1, 2]);
	});

	test('rule 4 decisions — a decision whose what was later rejected is REMOVED (state-machine migration)', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(1, { decisions: [{ what: 'Use MongoDB', why: 'document model fits', sourceIds: [3] }] }),
			makeEpisode(2, { rejected: [{ approach: 'use mongoDB.', reason: 'hosting cost', sourceIds: [30] }] }),
		], resolvePolicy());
		assert.strictEqual(merged.decisions.length, 0);
		assert.strictEqual(merged.rejected.length, 1);
		assert.strictEqual(merged.rejected[0]!.reason, 'hosting cost');
	});

	test('rule 5 failures — fixed failures are dropped; open and abandoned ones survive', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(1, { failures: [
				{ attempt: 'webpack build', error: 'OOM', resolution: 'open', sourceIds: [1] },
				{ attempt: 'jest run', error: 'timeout', resolution: 'abandoned', sourceIds: [2] },
			] }),
			makeEpisode(3, { failures: [{ attempt: 'webpack build', error: 'OOM again', resolution: 'fixed', sourceIds: [30] }] }),
		], resolvePolicy());
		// 'webpack build' was open in ep1 and fixed in ep3 (newest wins) → dropped;
		// 'jest run' (abandoned) is the only survivor
		assert.strictEqual(merged.failures.length, 1);
		assert.strictEqual(merged.failures[0]!.attempt, 'jest run');
	});

	test('rule 6 artifacts — ranked by cross-episode frequency, then alphabetical', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(1, { artifacts: { files: ['b.txt', 'a.txt', 'a.txt'], symbols: [], commands: [], configs: [] } }),
			makeEpisode(2, { artifacts: { files: ['a.txt', 'c.txt'], symbols: [], commands: [], configs: [] } }),
			makeEpisode(3, { artifacts: { files: ['a.txt'], symbols: [], commands: [], configs: [] } }),
		], resolvePolicy());
		// a.txt seen in 3 episodes; b.txt/c.txt in 1 each → frequency, then alphabetical
		assert.deepStrictEqual(merged.artifacts.files, ['a.txt', 'b.txt', 'c.txt']);
	});

	test('rule 6 artifacts — hard caps 60/40/20/20 (files/symbols/commands/configs)', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(1, { artifacts: {
				files: Array.from({ length: 65 }, (_, i) => `f${i}.ts`),
				symbols: Array.from({ length: 45 }, (_, i) => `s${i}`),
				commands: Array.from({ length: 25 }, (_, i) => `c${i}`),
				configs: Array.from({ length: 25 }, (_, i) => `k${i}`),
			} }),
		], resolvePolicy());
		assert.strictEqual(merged.artifacts.files.length, 60);
		assert.strictEqual(merged.artifacts.symbols.length, 40);
		assert.strictEqual(merged.artifacts.commands.length, 20);
		assert.strictEqual(merged.artifacts.configs.length, 20);
	});

	test('rule 7 state and next — taken only from the LAST episode (by ordinal)', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(3, { state: { done: ['parser'], inProgress: ['ledger'], verified: ['setup'] }, next: ['wire assembler'] }),
			makeEpisode(1, { state: { done: ['setup'], inProgress: ['parser'], verified: [] }, next: ['write tests'] }),
		], resolvePolicy());
		assert.deepStrictEqual(merged.state, { done: ['parser'], inProgress: ['ledger'], verified: ['setup'] });
		assert.deepStrictEqual(merged.next, ['wire assembler']);
	});

	test('rule 8 goal — original from episode 1 joined with current from the last when they differ', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(1, { goal: 'make it fast' }),
			makeEpisode(2, {}),
			makeEpisode(3, { goal: 'make it fast and small' }),
		], resolvePolicy());
		assert.strictEqual(merged.goal, 'make it fast → make it fast and small');
	});

	test('rule 8 goal — a single text when original and current are identical', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(1, { goal: 'ship the ledger' }),
			makeEpisode(2, { goal: 'ship the ledger' }),
		], resolvePolicy());
		assert.strictEqual(merged.goal, 'ship the ledger');
	});

	test('rule 9 openQuestions — removed once a later decision or symbol answers them', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(1, { openQuestions: ['Which database?', 'How to parse config?', 'Where to deploy?'] }),
			makeEpisode(2, { decisions: [{ what: 'Which database?', why: 'settled on postgres', sourceIds: [1] }] }),
			makeEpisode(3, { artifacts: { files: [], symbols: ['How to parse config?'], commands: [], configs: [] } }),
		], resolvePolicy());
		assert.deepStrictEqual(merged.openQuestions, ['Where to deploy?']);
	});

	test('rule 9 openQuestions — capped at 10 keeping the most recently restated', () => {
		const questions = Array.from({ length: 12 }, (_, i) => `question ${i}`);
		const merged = mergeEpisodeBodies([
			makeEpisode(1, { openQuestions: questions.slice(0, 10) }),
			makeEpisode(2, { openQuestions: questions.slice(10) }),
		], resolvePolicy());
		assert.strictEqual(merged.openQuestions.length, 10);
		assert.ok(merged.openQuestions.includes('question 10'));
		assert.ok(merged.openQuestions.includes('question 11'));
		assert.ok(!merged.openQuestions.includes('question 8'));
		assert.ok(!merged.openQuestions.includes('question 9'));
	});

	test('empty episode list yields an empty body without throwing', () => {
		assert.deepStrictEqual(mergeEpisodeBodies([], resolvePolicy()), emptyBody());
	});
});

// ---------------------------------------------------------------------------
// Suite: shrinkToBudget (budget order, task 6-3 tail)
// ---------------------------------------------------------------------------

suite('workingBriefBuilder — shrinkToBudget', () => {

	test('trims artifacts, failures, decisions and openQuestions in order; invariants/rejected/corrections survive', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(1, {
				invariants: ['never force-push'],
				rejected: [{ approach: 'mongodb', reason: 'cost', sourceIds: [1] }],
				corrections: [{ userSaid: 'no semicolons', sourceIds: [2] }],
				decisions: [{ what: 'd-old', why: 'y'.repeat(400), sourceIds: [3] }, { what: 'd-new', why: 'y', sourceIds: [4] }],
				failures: [{ attempt: 'f', error: 'e', resolution: 'open', sourceIds: [5] }],
				openQuestions: ['q'],
				artifacts: { files: ['a.ts'], symbols: [], commands: [], configs: [] },
			}),
		], resolvePolicy());
		// briefMaxTokens: 1 → the body can never fit → every allowed trim fires
		const shrunk = shrinkToBudget(merged, resolvePolicy({ briefMaxTokens: 1 }));
		assert.deepStrictEqual(shrunk.invariants, ['never force-push']);
		assert.strictEqual(shrunk.rejected.length, 1);
		assert.strictEqual(shrunk.corrections.length, 1);
		assert.deepStrictEqual(shrunk.artifacts, { files: [], symbols: [], commands: [], configs: [] });
		assert.strictEqual(shrunk.failures.length, 0);
		assert.strictEqual(shrunk.decisions.length, 0);
		assert.strictEqual(shrunk.openQuestions.length, 0);
	});

	test('drops the OLDEST decisions first', () => {
		const body = emptyBody();
		body.decisions = [
			{ what: 'oldest', why: 'y'.repeat(400), sourceIds: [1] },
			{ what: 'newest', why: 'y', sourceIds: [2] },
		];
		// pick a budget that the body exceeds with both decisions but fits with one
		const fitsAfterOne = estimateTokens(JSON.stringify({ ...body, decisions: [body.decisions[1]!] }));
		const fitsWithBoth = estimateTokens(JSON.stringify(body));
		const policy = resolvePolicy({ briefMaxTokens: Math.ceil(fitsAfterOne / 4) });
		assert.ok(4 * policy.briefMaxTokens >= fitsAfterOne && 4 * policy.briefMaxTokens < fitsWithBoth,
			'test setup: budget must sit between the two sizes');
		const shrunk = shrinkToBudget(body, policy);
		assert.deepStrictEqual(shrunk.decisions.map(d => d.what), ['newest']);
	});

	test('under-budget bodies pass through untouched', () => {
		const merged = mergeEpisodeBodies(richEpisodes(), resolvePolicy());
		const shrunk = shrinkToBudget(merged, resolvePolicy());
		assert.deepStrictEqual(shrunk, merged);
	});
});

// ---------------------------------------------------------------------------
// Suite: renderWorkingMemory (task 6-4)
// ---------------------------------------------------------------------------

suite('workingBriefBuilder — renderWorkingMemory', () => {

	test('emits child tags in the stable task 6-4 order with header and recall hint', () => {
		const merged = mergeEpisodeBodies(richEpisodes(), resolvePolicy());
		const text = renderWorkingMemory({ revision: 12, builtFromEpisodes: [1, 2], builtAtSeq: 4193, merged });
		assert.ok(text.startsWith('<working_memory revision="12" episodes="1-2" covers_seq="1-4193">'));
		const order = [
			'<goal ', '<invariants', '<rejected_approaches', '<open_failures',
			'<user_corrections', '<decisions', '<artifacts ', '<state ', '<next', '<recall_hint',
		];
		let prevIdx = -1;
		for (const tag of order) {
			const idx = text.indexOf(tag);
			assert.ok(idx > prevIdx, `tag ${tag} must appear after the previous section`);
			prevIdx = idx;
		}
		assert.ok(text.endsWith('</working_memory>'));
		assert.ok(text.includes('<recall_hint>Use the recall_history tool to see the exact older conversation when you need details.</recall_hint>'));
	});

	test('rejected items carry approach/reason attributes and the first-seen episode ordinal', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(1, { rejected: [{ approach: 'mongodb', reason: 'hosting cost', sourceIds: [7] }] }),
		], resolvePolicy());
		const text = renderWorkingMemory({ revision: 1, builtFromEpisodes: [1], builtAtSeq: 99, merged });
		assert.ok(text.includes('<item approach="mongodb" reason="hosting cost" episode="1"/>'));
	});

	test('goal renders original/current attributes when they differ, a single current attribute otherwise', () => {
		const differing = mergeEpisodeBodies([
			makeEpisode(1, { goal: 'make it fast' }),
			makeEpisode(2, { goal: 'make it fast and small' }),
		], resolvePolicy());
		const differingText = renderWorkingMemory({ revision: 1, builtFromEpisodes: [1, 2], builtAtSeq: 50, merged: differing });
		assert.ok(differingText.includes('<goal original="make it fast" current="make it fast and small"/>'));

		const equal = mergeEpisodeBodies([
			makeEpisode(1, { goal: 'ship it' }),
			makeEpisode(2, { goal: 'ship it' }),
		], resolvePolicy());
		const equalText = renderWorkingMemory({ revision: 1, builtFromEpisodes: [1, 2], builtAtSeq: 50, merged: equal });
		assert.ok(equalText.includes('<goal current="ship it"/>'));
	});

	test('escapes &, <, > and quotes in attributes and text content', () => {
		const merged = mergeEpisodeBodies([
			makeEpisode(1, {
				goal: 'handle "a & b" < c > d',
				invariants: ['never write a < b & "c"'],
				rejected: [{ approach: 'x < y', reason: 'cost & risk', sourceIds: [1] }],
			}),
		], resolvePolicy());
		const text = renderWorkingMemory({ revision: 1, builtFromEpisodes: [1], builtAtSeq: 99, merged });
		assert.ok(text.includes('current="handle &quot;a &amp; b&quot; &lt; c &gt; d"'));
		assert.ok(text.includes('<item>never write a &lt; b &amp; "c"</item>'));
		assert.ok(text.includes('approach="x &lt; y"'));
		assert.ok(text.includes('reason="cost &amp; risk"'));
	});
});

// ---------------------------------------------------------------------------
// Suite: buildWorkingBrief (orchestration + determinism)
// ---------------------------------------------------------------------------

suite('workingBriefBuilder — buildWorkingBrief', () => {

	test('bumps the revision, records episode ordinals and estimates tokens from the rendered text', () => {
		const previous: IWorkingBrief = {
			threadId: 't1', revision: 7, builtFromEpisodes: [1], builtAtSeq: 100,
			tokens: 10, text: 'stale', merged: emptyBody(),
		};
		const brief = buildWorkingBrief({
			threadId: 't1', previousBrief: previous, episodes: richEpisodes(),
			lastSeq: 250, policy: resolvePolicy(),
		});
		assert.strictEqual(brief.threadId, 't1');
		assert.strictEqual(brief.revision, 8);
		assert.deepStrictEqual(brief.builtFromEpisodes, [1, 2]);
		assert.strictEqual(brief.builtAtSeq, 250);
		assert.strictEqual(brief.tokens, estimateTokens(brief.text));
		assert.ok(brief.text.startsWith('<working_memory revision="8" episodes="1-2" covers_seq="1-250">'));
	});

	test('first build starts at revision 1', () => {
		const brief = buildWorkingBrief({
			threadId: 't1', previousBrief: null, episodes: richEpisodes(),
			lastSeq: 250, policy: resolvePolicy(),
		});
		assert.strictEqual(brief.revision, 1);
	});

	test('determinism — building twice from the same episodes yields a byte-identical text', () => {
		const a = buildWorkingBrief({ threadId: 't1', previousBrief: null, episodes: richEpisodes(), lastSeq: 250, policy: resolvePolicy() });
		const b = buildWorkingBrief({ threadId: 't1', previousBrief: null, episodes: richEpisodes(), lastSeq: 250, policy: resolvePolicy() });
		assert.strictEqual(a.text, b.text);
	});

	test('determinism — input episode order does not affect the rendered text', () => {
		const a = buildWorkingBrief({ threadId: 't1', previousBrief: null, episodes: richEpisodes(), lastSeq: 250, policy: resolvePolicy() });
		const reversed = buildWorkingBrief({
			threadId: 't1', previousBrief: null, episodes: [...richEpisodes()].reverse(),
			lastSeq: 250, policy: resolvePolicy(),
		});
		assert.strictEqual(a.text, reversed.text);
	});

	test('default policy caps match the task 6-3 numbers', () => {
		assert.strictEqual(DEFAULT_LEDGER_POLICY.maxInvariants, 40);
		assert.strictEqual(DEFAULT_LEDGER_POLICY.maxRejected, 30);
		assert.strictEqual(DEFAULT_LEDGER_POLICY.maxCorrections, 20);
		assert.strictEqual(DEFAULT_LEDGER_POLICY.maxDecisions, 25);
		assert.strictEqual(DEFAULT_LEDGER_POLICY.maxFailures, 15);
	});
});
