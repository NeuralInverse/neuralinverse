/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import {
	tokenize,
	buildLedgerEntryRecord,
	buildLedgerEpisodeRecord,
	scoreRecallCandidates,
	renderRecallWindow,
	RECALL_WEIGHTS_WITH_EMBEDDINGS,
	RECALL_WEIGHTS_NO_EMBEDDINGS,
	ILedgerRecallCandidate,
} from '../../../../browser/context/search/ledgerRecallService.js';
import { ILedgerEntry, IEpisodeSummary, IEpisodeBody } from '../../../../../void/common/ledgerTypes.js';

/**
 * LedgerRecallService depends on IPersistentContextStore (IndexedDB) and
 * IContextLedgerService (journal on disk).  Full instantiation requires a
 * running workbench, so this suite covers the pure, DI-independent exports:
 * the tokenizer, the record builders (snippet/term capping), the ranking
 * function in both weight modes, and the budgeted window renderer.
 *
 * The IndexedDB-backed paths (putLedgerEntries / searchLedgerEntriesByTerms /
 * the full recall()/expand() flow) are live-tested via the phase-3 live-patch
 * verification and skipped below.
 */

const NOW = 1_700_000_000_000;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeEntry(seq: number, content: string, ts: number = 1_000_000): ILedgerEntry {
	return {
		id: `le_t_${seq}`,
		seq,
		threadId: 't',
		role: 'user',
		content,
		ts,
		tokens: 10,
	};
}

function makeEpisodeBody(overrides: Partial<IEpisodeBody> = {}): IEpisodeBody {
	return {
		goal: 'deploy the pipeline',
		decisions: [{ what: 'kept vite as the bundler', why: 'fast hmr', sourceIds: [1] }],
		rejected: [{ approach: 'rewrote the bundler by hand', reason: 'too risky', sourceIds: [2] }],
		failures: [{ attempt: 'dockerized everything', error: 'boom', resolution: 'abandoned', sourceIds: [3] }],
		corrections: [],
		invariants: ['always use pnpm'],
		artifacts: { files: [], symbols: [], commands: [], configs: [] },
		state: { done: [], inProgress: [], verified: [] },
		next: [],
		openQuestions: [],
		...overrides,
	};
}

function makeEpisode(ordinal: number, body: IEpisodeBody, createdAt: number = 2_000_000): IEpisodeSummary {
	return {
		id: `ep_t_${ordinal}`,
		threadId: 't',
		ordinal,
		range: { fromSeq: ordinal * 10, toSeq: ordinal * 10 + 9 },
		createdAt,
		producedBy: 'deterministic',
		frozen: true,
		body,
	};
}

function makeCandidate(partial: Partial<ILedgerRecallCandidate> & { id: string }): ILedgerRecallCandidate {
	return {
		kind: 'entry',
		termScore: 0,
		cosine: 0,
		ts: NOW,
		pathOverlap: 0,
		why: [],
		...partial,
	};
}

// ─── tokenize ─────────────────────────────────────────────────────────────────

suite('LedgerRecall — tokenize', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('lowercases and splits on non-alphanumeric characters', () => {
		assert.deepStrictEqual(tokenize('Hello, World! Foo_Bar'), ['hello', 'world', 'foo', 'bar']);
	});

	test('keeps Persian letters as terms', () => {
		assert.deepStrictEqual(
			tokenize('همیشه از pnpm استفاده کن'),
			['همیشه', 'از', 'pnpm', 'استفاده', 'کن'],
		);
	});

	test('drops terms shorter than 2 chars', () => {
		assert.deepStrictEqual(tokenize('a b bb ccc'), ['bb', 'ccc']);
	});

	test('dedupes after lowercasing', () => {
		assert.deepStrictEqual(tokenize('Go go GO'), ['go']);
	});

	test('returns empty for separator-only text', () => {
		assert.deepStrictEqual(tokenize('!!! ??? ...'), []);
	});

	test('caps at 40 distinct terms', () => {
		const text = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
		const terms = tokenize(text);
		assert.strictEqual(terms.length, 40);
		assert.strictEqual(terms[0], 'w0');
		assert.strictEqual(terms[39], 'w39');
	});
});

// ─── Record builders ──────────────────────────────────────────────────────────

suite('LedgerRecall — entry record builder (snippet/term capping)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('composite id is `${threadId}:${seq}`', () => {
		const record = buildLedgerEntryRecord('thread-1', makeEntry(7, 'hello world'));
		assert.strictEqual(record.id, 'thread-1:7');
		assert.strictEqual(record.threadId, 'thread-1');
		assert.strictEqual(record.seq, 7);
	});

	test('snippet is the first 240 chars of the content', () => {
		const record = buildLedgerEntryRecord('t', makeEntry(1, 'x'.repeat(1000)));
		assert.strictEqual(record.snippet.length, 240);
		assert.strictEqual(record.snippet, 'x'.repeat(240));
	});

	test('short content is kept verbatim as the snippet', () => {
		const record = buildLedgerEntryRecord('t', makeEntry(1, 'short content'));
		assert.strictEqual(record.snippet, 'short content');
	});

	test('terms are capped at 40', () => {
		const text = Array.from({ length: 60 }, (_, i) => `term${i}`).join(' ');
		const record = buildLedgerEntryRecord('t', makeEntry(1, text));
		assert.strictEqual(record.terms.length, 40);
	});

	test('tool name is propagated when present, absent otherwise', () => {
		const withName = buildLedgerEntryRecord('t', { ...makeEntry(1, 'out'), role: 'tool', name: 'grep' });
		assert.strictEqual(withName.name, 'grep');
		const withoutName = buildLedgerEntryRecord('t', makeEntry(2, 'hi'));
		assert.strictEqual(withoutName.name, undefined);
	});
});

suite('LedgerRecall — episode record builder', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('terms come from goal, invariants, rejected.approach and decisions.what', () => {
		const record = buildLedgerEpisodeRecord('t', makeEpisode(1, makeEpisodeBody()));
		for (const expected of ['deploy', 'pipeline', 'pnpm', 'rewrote', 'bundler', 'vite']) {
			assert.ok(record.terms.includes(expected), `missing term: ${expected}`);
		}
		// failures are not indexed as terms
		assert.ok(!record.terms.includes('dockerized'));
	});

	test('composite id and seq range map from the episode', () => {
		const record = buildLedgerEpisodeRecord('thread-2', makeEpisode(3, makeEpisodeBody()));
		assert.strictEqual(record.id, 'thread-2:3');
		assert.strictEqual(record.ordinal, 3);
		assert.strictEqual(record.fromSeq, 30);
		assert.strictEqual(record.toSeq, 39);
	});

	test('body is compact JSON capped at 4000 chars', () => {
		const giant = makeEpisodeBody({ invariants: ['always use pnpm ' + 'y'.repeat(10_000)] });
		const record = buildLedgerEpisodeRecord('t', makeEpisode(1, giant));
		assert.ok(record.body.startsWith('{'));
		assert.ok(record.body.length <= 4000);
	});

	test('uncapped body round-trips as JSON', () => {
		const record = buildLedgerEpisodeRecord('t', makeEpisode(1, makeEpisodeBody()));
		assert.strictEqual(JSON.parse(record.body).goal, 'deploy the pipeline');
	});
});

// ─── Ranking ──────────────────────────────────────────────────────────────────

suite('LedgerRecall — scoreRecallCandidates weights', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('both weight sets sum to 1', () => {
		const sum = (w: typeof RECALL_WEIGHTS_WITH_EMBEDDINGS) => w.term + w.embedding + w.recency + w.pathOverlap;
		assert.ok(Math.abs(sum(RECALL_WEIGHTS_WITH_EMBEDDINGS) - 1) < 1e-10);
		assert.ok(Math.abs(sum(RECALL_WEIGHTS_NO_EMBEDDINGS) - 1) < 1e-10);
	});

	test('full weights are 0.45 / 0.25 / 0.15 / 0.15', () => {
		assert.strictEqual(RECALL_WEIGHTS_WITH_EMBEDDINGS.term, 0.45);
		assert.strictEqual(RECALL_WEIGHTS_WITH_EMBEDDINGS.embedding, 0.25);
		assert.strictEqual(RECALL_WEIGHTS_WITH_EMBEDDINGS.recency, 0.15);
		assert.strictEqual(RECALL_WEIGHTS_WITH_EMBEDDINGS.pathOverlap, 0.15);
	});

	test('degraded weights are 0.70 / 0 / 0.20 / 0.10', () => {
		assert.strictEqual(RECALL_WEIGHTS_NO_EMBEDDINGS.term, 0.70);
		assert.strictEqual(RECALL_WEIGHTS_NO_EMBEDDINGS.embedding, 0);
		assert.strictEqual(RECALL_WEIGHTS_NO_EMBEDDINGS.recency, 0.20);
		assert.strictEqual(RECALL_WEIGHTS_NO_EMBEDDINGS.pathOverlap, 0.10);
	});

	test('a perfect candidate scores 1.0 under both weight modes', () => {
		const perfect = makeCandidate({ id: 'entry:t:1', termScore: 1, cosine: 1, ts: NOW, pathOverlap: 1 });
		const full = scoreRecallCandidates([perfect], RECALL_WEIGHTS_WITH_EMBEDDINGS, NOW);
		const degraded = scoreRecallCandidates([perfect], RECALL_WEIGHTS_NO_EMBEDDINGS, NOW);
		assert.ok(Math.abs(full[0].score - 1) < 1e-10);
		assert.ok(Math.abs(degraded[0].score - 1) < 1e-10);
	});
});

suite('LedgerRecall — scoreRecallCandidates ranking', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('recency decays at 0.995^days', () => {
		const tenDaysOld = makeCandidate({ id: 'entry:t:1', ts: NOW - 10 * 86_400_000 });
		const scored = scoreRecallCandidates([tenDaysOld], RECALL_WEIGHTS_NO_EMBEDDINGS, NOW);
		const expected = 0.20 * Math.pow(0.995, 10);
		assert.ok(Math.abs(scored[0].score - expected) < 1e-9);
	});

	test('newer candidate ranks above equally-matching older one', () => {
		const old = makeCandidate({ id: 'entry:t:1', termScore: 0.5, ts: NOW - 365 * 86_400_000 });
		const recent = makeCandidate({ id: 'entry:t:2', termScore: 0.5, ts: NOW });
		const scored = scoreRecallCandidates([old, recent], RECALL_WEIGHTS_NO_EMBEDDINGS, NOW);
		assert.strictEqual(scored[0].id, 'entry:t:2');
	});

	test('term hits outweigh pure recency', () => {
		const halfMatchOld = makeCandidate({ id: 'entry:t:1', termScore: 0.5, ts: NOW - 365 * 86_400_000, why: ['deploy'] });
		const noMatchNew = makeCandidate({ id: 'entry:t:2', ts: NOW });
		const scored = scoreRecallCandidates([noMatchNew, halfMatchOld], RECALL_WEIGHTS_NO_EMBEDDINGS, NOW);
		assert.strictEqual(scored[0].id, 'entry:t:1');
	});

	test('cosine separates candidates only under the full weight set', () => {
		const low = makeCandidate({ id: 'entry:t:1', cosine: 0 });
		const high = makeCandidate({ id: 'entry:t:2', cosine: 1 });
		const full = scoreRecallCandidates([low, high], RECALL_WEIGHTS_WITH_EMBEDDINGS, NOW);
		assert.strictEqual(full[0].id, 'entry:t:2');
		// cosine 0.25 + fresh recency 0.15
		assert.ok(Math.abs(full[0].score - 0.40) < 1e-10);
		const degraded = scoreRecallCandidates([low, high], RECALL_WEIGHTS_NO_EMBEDDINGS, NOW);
		assert.ok(Math.abs(degraded[0].score - degraded[1].score) < 1e-12);
	});

	test('dedupes by id, keeping the first occurrence', () => {
		const first = makeCandidate({ id: 'entry:t:1', termScore: 1 });
		const dup = makeCandidate({ id: 'entry:t:1', termScore: 0 });
		const scored = scoreRecallCandidates([first, dup, makeCandidate({ id: 'entry:t:2' })], RECALL_WEIGHTS_NO_EMBEDDINGS, NOW);
		assert.strictEqual(scored.length, 2);
		assert.strictEqual(scored[0].id, 'entry:t:1');
		assert.ok(scored[0].score > scored[1].score);
	});
});

// ─── Window rendering (expand core) ───────────────────────────────────────────

suite('LedgerRecall — renderRecallWindow', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('empty range renders as empty, untruncated text', () => {
		assert.deepStrictEqual(renderRecallWindow([], 100), { text: '', truncated: false });
	});

	test('under-budget window is rendered verbatim', () => {
		const entries = [makeEntry(1, 'first'), makeEntry(2, 'second'), makeEntry(3, 'third')];
		const { text, truncated } = renderRecallWindow(entries, 100);
		assert.strictEqual(truncated, false);
		assert.ok(text.includes('[[USER]]'));
		assert.ok(text.includes('first'));
		assert.ok(text.includes('third'));
		assert.ok(!text.includes('truncated'));
	});

	test('overflow is middle-truncated with a seq-window marker', () => {
		const entries = Array.from({ length: 20 }, (_, i) =>
			makeEntry(i + 1, `entry-payload-${i + 1}-` + 'x'.repeat(80)));
		const { text, truncated } = renderRecallWindow(entries, 200); // 200 tokens = 800 chars
		assert.strictEqual(truncated, true);
		const m = /recall window truncated between seq (\d+) and (\d+)/.exec(text);
		assert.ok(m, 'expected truncation marker');
		const fromSeq = parseInt(m[1], 10);
		const toSeq = parseInt(m[2], 10);
		assert.ok(fromSeq > 1 && toSeq < 20, `dropped window (${fromSeq}..${toSeq}) must be interior`);
		assert.ok(fromSeq <= toSeq);
		// both ends survive, the dropped middle does not
		assert.ok(text.includes('entry-payload-1-'));
		assert.ok(text.includes('entry-payload-20-'));
		assert.ok(!text.includes('entry-payload-10-'));
		// budget is honored (chars, not tokens)
		assert.ok(text.length <= 200 * 4, `rendered ${text.length} chars for a 800-char budget`);
	});

	test('single giant entry is middle-truncated by characters', () => {
		const entries = [makeEntry(1, 'z'.repeat(50_000))];
		const { text, truncated } = renderRecallWindow(entries, 100); // 400 chars
		assert.strictEqual(truncated, true);
		assert.ok(text.startsWith('[[USER]]'));
		assert.ok(text.includes('recall window truncated between seq 1 and 1'));
		assert.ok(text.includes('zzz'));
		assert.ok(text.length <= 100 * 4, `rendered ${text.length} chars for a 400-char budget`);
	});
});

// ─── IndexedDB-backed paths (live-tested) ─────────────────────────────────────

// recall() over the persistent store, expand() over the journal, and the
// putLedgerEntries / searchLedgerEntriesByTerms / searchLedgerEpisodesByTerms
// store methods need IndexedDB and the on-disk ledger — neither exists in the
// unit-test runner. They are verified live (task M5 phase 3 live-patch).

suite('LedgerRecall — IndexedDB paths (live-tested)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test.skip('recall ranks entries + episodes from the persistent store', () => { /* live-tested */ });
	test.skip('expand reads verbatim ranges from the journal', () => { /* live-tested */ });
});
