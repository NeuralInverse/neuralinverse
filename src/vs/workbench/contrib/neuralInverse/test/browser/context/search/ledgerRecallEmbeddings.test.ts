/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

/**
 *  B2 contract tests: semantic archive recall with a DETERMINISTIC local
 *  embedding provider (no live service — per the task, real-provider status
 *  stays separately open). Covers:
 *  - a distant fact with DIFFERENT wording is recalled through cosine even
 *    with zero lexical overlap, and no unrelated false positive rides along;
 *  - provenance returns to the original entry (threadId + seq range);
 *  - a provider switch (model identity change) invalidates stale vectors —
 *    cosine drops to 0 until re-embedded, and lexical recall never breaks;
 *  - no provider → exact pre-B2 degraded behavior;
 *  - vectors persist in the store and survive a "restart" (new service on
 *    the same store).
 */
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { LedgerRecallService } from '../../../../browser/context/search/ledgerRecallService.js';
import type { IStoredLedgerEntry, IStoredLedgerEpisode } from '../../../../browser/context/search/persistentStore.js';
import type { ILedgerEntry, IEpisodeSummary, IEpisodeBody } from '../../../../../void/common/ledgerTypes.js';

// ─── deterministic embedding provider ───────────────────────────────────────

/** Bag-of-words 3-dim vector: [deploy-ish, style-ish, random-ish]. Words map
 *  to fixed axes so "phrases with different wording" land near each other
 *  while unrelated text does not. */
const AXIS: Record<string, number> = {
	ship: 0, deploy: 0, release: 0, pipeline: 0, build: 0, publish: 0, rollout: 0,
	colors: 1, theme: 1, palette: 1, design: 1, styling: 1, contrast: 1,
};

function fakeVector(text: string): Float32Array {
	const v = new Float32Array(3);
	for (const word of text.toLowerCase().split(/[^a-z]+/)) {
		const axis = AXIS[word];
		if (axis !== undefined) { v[axis] += 1; }
	}
	const norm = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2) || 1;
	for (let i = 0; i < 3; i++) { v[i] /= norm; }
	return v;
}

function makeEmbeddingProvider(options: { model: string; fail?: boolean }) {
	const calls: string[] = [];
	return {
		calls,
		provider: {
			get isAvailable() { return !options.fail; },
			get model() { return options.model; },
			embedToVector: async (text: string) => {
				calls.push(text.slice(0, 40));
				return fakeVector(text);
			},
			// identity-bearing variant used by the embed queue (B2 live
			// closure): same fake vector plus the producing model identity
			embedText: async (text: string) => {
				calls.push(text.slice(0, 40));
				return { vector: fakeVector(text), model: options.model };
			},
		},
	};
}

// ─── fake store + ledger + workspace ────────────────────────────────────────

function makeStore() {
	const entries = new Map<string, IStoredLedgerEntry>();
	const episodes = new Map<string, IStoredLedgerEpisode>();
	return {
		entries, episodes,
		store: {
			initialize: async () => { },
			getRecentEmbeddedLedgerRecords: async (limit: number) => {
				const refs = [...entries.values()].map(e => e.embedding && e.embeddingModel
					? { kind: 'entry' as const, id: e.id, threadId: e.threadId, seqRange: [e.seq, e.seq] as [number, number], ts: e.ts, snippet: e.snippet, embedding: e.embedding, embeddingModel: e.embeddingModel }
					: undefined).filter((x): x is NonNullable<typeof x> => x !== undefined);
				const epRefs = [...episodes.values()].map(e => e.embedding && e.embeddingModel
					? { kind: 'episode' as const, id: e.id, threadId: e.threadId, seqRange: [e.fromSeq, e.toSeq] as [number, number], ts: e.ts, snippet: e.body.slice(0, 240), embedding: e.embedding, embeddingModel: e.embeddingModel }
					: undefined).filter((x): x is NonNullable<typeof x> => x !== undefined);
				return [...refs, ...epRefs].sort((a, b) => b.ts - a.ts).slice(0, limit);
			},
			putLedgerEntries: async (list: IStoredLedgerEntry[]) => { for (const e of list) { entries.set(e.id, { ...e }); } },
			getLedgerEntry: async (id: string) => entries.get(id) !== undefined ? { ...entries.get(id)! } : undefined,
			searchLedgerEntriesByTerms: async (terms: string[], limit: number) => {
				// term match like the real multiEntry index: ANY term overlap
				const hits = [...entries.values()].filter(e => terms.some(t => e.terms.includes(t)));
				return hits.slice(0, limit).map(e => ({ ...e }));
			},
			putLedgerEpisodes: async (list: IStoredLedgerEpisode[]) => { for (const e of list) { episodes.set(e.id, { ...e }); } },
			getLedgerEpisode: async (id: string) => episodes.get(id) !== undefined ? { ...episodes.get(id)! } : undefined,
			searchLedgerEpisodesByTerms: async (terms: string[], limit: number) => {
				const hits = [...episodes.values()].filter(e => terms.some(t => e.terms.includes(t)));
				return hits.slice(0, limit).map(e => ({ ...e }));
			},
		},
	};
}

function makeEntry(seq: number, content: string): ILedgerEntry {
	return { id: `le_t_${seq}`, seq, threadId: 't', role: 'user', content, ts: 1_000_000 + seq, tokens: 10 };
}

function makeEpisode(ordinal: number, body: IEpisodeBody): IEpisodeSummary {
	return {
		id: `ep_t_${ordinal}`, threadId: 't', ordinal,
		range: { fromSeq: ordinal * 10, toSeq: ordinal * 10 + 9 },
		createdAt: 2_000_000 + ordinal, producedBy: 'deterministic', frozen: true, body,
	};
}

const fakeLedger = { onDidAppendEntry: () => ({ dispose: () => { } }), onDidFreezeEpisode: () => ({ dispose: () => { } }) };
const fakeWorkspace = { getWorkspace: () => ({ folders: [{ uri: { toString: () => 'file:///ws' } }] }) };

async function flushEmbedQueue(times = 12): Promise<void> {
	for (let i = 0; i < times; i++) { await new Promise(r => setTimeout(r, 5)); }
}

suite('Ledger semantic recall — B2 contract (deterministic provider)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a differently-worded distant fact is recalled via cosine; unrelated entries do not ride along', async () => {
		const emb = makeEmbeddingProvider({ model: 'fixture-embed-1' });
		const { store, entries } = makeStore();
		const service = new LedgerRecallService(store as never, fakeLedger as never, fakeWorkspace as never, emb.provider as never);
		try {
			// the archive recorded the deploy-pipeline fact with wording that
			// shares NO query term with the question about "release rollout"
			await service.indexEntry('t', makeEntry(1, 'we ship our pipeline each thursday once builds finish'));
			await service.indexEntry('t', makeEntry(2, 'palette favors teal accents everywhere'));
			await flushEmbedQueue();
			assert.ok(entries.get('t:1')?.embedding, 'entry 1 got a vector');
			assert.ok(entries.get('t:2')?.embedding, 'entry 2 got a vector');

			const results = await service.recall({ query: 'rollout release publishing cadence', threadScope: 'current', currentThreadId: 't' });
			assert.ok(results.length > 0, 'semantic recall must find the deploy fact with zero lexical overlap');
			const top = results[0];
			// provenance returns to the original entry
			assert.strictEqual(top.kind, 'entry');
			assert.strictEqual(top.threadId, 't');
			assert.deepStrictEqual(top.seqRange, [1, 1]);
			assert.ok(!results.some(r => r.snippet.includes('teal')), 'the styling entry must not ride along as a false positive');
		} finally { service.dispose(); }
	});

	test('episodes are embedded and recalled semantically with their seq range', async () => {
		const emb = makeEmbeddingProvider({ model: 'fixture-embed-1' });
		const { store } = makeStore();
		const service = new LedgerRecallService(store as never, fakeLedger as never, fakeWorkspace as never, emb.provider as never);
		try {
			const body: IEpisodeBody = {
				goal: 'automate the deploy pipeline',
				decisions: [{ what: 'kept the build in CI', why: 'fast', sourceIds: [1] }],
				rejected: [], failures: [], corrections: [], invariants: [],
				artifacts: { files: [], symbols: [], commands: [], configs: [] },
				state: { done: [], inProgress: [], verified: [] }, next: [], openQuestions: [],
			};
			await service.indexEpisode('t', makeEpisode(1, body));
			await flushEmbedQueue();
			const results = await service.recall({ query: 'release rollout publishing', threadScope: 'current', currentThreadId: 't' });
			const ep = results.find(r => r.kind === 'episode');
			assert.ok(ep, 'the deploy episode is recalled through its goal vector');
			assert.deepStrictEqual(ep!.seqRange, [10, 19], 'provenance returns the episode seq range');
		} finally { service.dispose(); }
	});

	test('a model switch invalidates stale vectors — cosine drops to 0, lexical recall still works', async () => {
		const emb = makeEmbeddingProvider({ model: 'fixture-embed-1' });
		const { store } = makeStore();
		const service = new LedgerRecallService(store as never, fakeLedger as never, fakeWorkspace as never, emb.provider as never);
		try {
			await service.indexEntry('t', makeEntry(1, 'deploy the pipeline build on thursdays'));
			await flushEmbedQueue();

			// lexical query still recalls after the provider switches models
			const before = await service.recall({ query: 'pipeline deploy', threadScope: 'current', currentThreadId: 't' });
			assert.ok(before.length > 0 && before[0].seqRange[0] === 1);

			// switch: the service now sees a different model identity
			const switched = makeEmbeddingProvider({ model: 'fixture-embed-2' });
			const service2 = new LedgerRecallService(store as never, fakeLedger as never, fakeWorkspace as never, switched.provider as never);
			try {
				const semanticOnly = await service2.recall({ query: 'release rollout', threadScope: 'current', currentThreadId: 't' });
				// stale-model vectors score cosine 0 — a semantic-only query must
				// NOT match anymore until re-embedding happens
				assert.ok(!semanticOnly.some(r => r.seqRange[0] === 1), 'stale-model vectors must not rank');
				// lexical still fine
				const lexical = await service2.recall({ query: 'pipeline deploy', threadScope: 'current', currentThreadId: 't' });
				assert.ok(lexical.length > 0 && lexical[0].seqRange[0] === 1, 'lexical recall survives the model switch');
			} finally { service2.dispose(); }
		} finally { service.dispose(); }
	});

	test('no provider → the exact pre-B2 degraded behavior (lexical only, no crash)', async () => {
		const emb = makeEmbeddingProvider({ model: 'fixture-embed-1', fail: true });
		const { store } = makeStore();
		const service = new LedgerRecallService(store as never, fakeLedger as never, fakeWorkspace as never, emb.provider as never);
		try {
			await service.indexEntry('t', makeEntry(1, 'deploy the pipeline on thursdays'));
			await flushEmbedQueue();
			const results = await service.recall({ query: 'deploy pipeline', threadScope: 'current', currentThreadId: 't' });
			assert.ok(results.length === 1, 'lexical recall works without a provider');
			assert.ok(results[0].score > 0);
		} finally { service.dispose(); }
	});

	test('vectors persist in the store and a restarted service keeps semantic recall', async () => {
		const emb = makeEmbeddingProvider({ model: 'fixture-embed-1' });
		const { store, entries } = makeStore();
		const first = new LedgerRecallService(store as never, fakeLedger as never, fakeWorkspace as never, emb.provider as never);
		try {
			await first.indexEntry('t', makeEntry(1, 'we ship the release build every thursday'));
			await flushEmbedQueue();
			assert.ok(entries.get('t:1')?.embeddingModel === 'fixture-embed-1', 'vector stamped with model identity in the store');
		} finally { first.dispose(); }

		// restart: a NEW service instance over the same store
		const second = new LedgerRecallService(store as never, fakeLedger as never, fakeWorkspace as never, emb.provider as never);
		try {
			const results = await second.recall({ query: 'rollout publishing', threadScope: 'current', currentThreadId: 't' });
			assert.ok(results.length > 0 && results[0].seqRange[0] === 1, 'semantic recall works after restart from persisted vectors');
		} finally { second.dispose(); }
	});
});

suite('Ledger recall — B2-L5 stop-word admission discrimination (2026-09-18 live leak)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// The live leak shape (measured 2026-09-18, runs 71P9KT/723JXX): a fresh
	// KNOWLEDGE_FACT record admitted an unrelated marine-biology query on the
	// shared generic terms ["in","the"] with cosine 0.66 < MIN_SEMANTIC_COSINE
	// 0.72 — any single term match used to bypass the semantic gate. The
	// deterministic provider below assigns BOTH texts zero vectors (no axis
	// words), so admission is exercised purely through the lexical gate.
	const factText = 'KNOWLEDGE_FACT_ALPHA_T1: The primary log archive is located at vault-backup-storage-region-7 in sector 4B.';
	const marineQuery = 'Unrelated query about marine biology and coral reef ecosystems in the Pacific ocean.';
	const archiveQuery = 'where is the primary log archive located';

	test('negative: an unrelated query sharing only stop-words must NOT recall the fresh fact (embeddings on)', async () => {
		const emb = makeEmbeddingProvider({ model: 'fixture-embed-1' });
		const { store } = makeStore();
		const service = new LedgerRecallService(store as never, fakeLedger as never, fakeWorkspace as never, emb.provider as never);
		try {
			await service.indexEntry('t', makeEntry(1, factText));
			await flushEmbedQueue();
			const results = await service.recall({ query: marineQuery, threadScope: 'current', currentThreadId: 't' });
			assert.strictEqual(results.length, 0, 'stop-word-only overlap must not admit the unrelated record');
			assert.ok(!results.some(r => r.snippet.includes('KNOWLEDGE_FACT')), 'no fixture leak through recall');
		} finally { service.dispose(); }
	});

	test('positive: the related query still recalls the same fact through its content terms (embeddings on)', async () => {
		const emb = makeEmbeddingProvider({ model: 'fixture-embed-1' });
		const { store } = makeStore();
		const service = new LedgerRecallService(store as never, fakeLedger as never, fakeWorkspace as never, emb.provider as never);
		try {
			await service.indexEntry('t', makeEntry(1, factText));
			await flushEmbedQueue();
			const results = await service.recall({ query: archiveQuery, threadScope: 'current', currentThreadId: 't' });
			assert.ok(results.length > 0, 'content-term overlap must keep the related fact recallable');
			assert.strictEqual(results[0].seqRange[0], 1, 'provenance returns to the fact entry');
		} finally { service.dispose(); }
	});

	test('negative: stop-word-only query in lexical-only mode (no provider) recalls nothing', async () => {
		const emb = makeEmbeddingProvider({ model: 'fixture-embed-1', fail: true });
		const { store } = makeStore();
		const service = new LedgerRecallService(store as never, fakeLedger as never, fakeWorkspace as never, emb.provider as never);
		try {
			await service.indexEntry('t', makeEntry(1, factText));
			await flushEmbedQueue();
			const results = await service.recall({ query: 'in the of at to', threadScope: 'current', currentThreadId: 't' });
			assert.strictEqual(results.length, 0, 'degraded lexical mode still refuses stop-word-only admission');
		} finally { service.dispose(); }
	});

	test('positive: single content term stays recallable in lexical-only mode (no provider)', async () => {
		const emb = makeEmbeddingProvider({ model: 'fixture-embed-1', fail: true });
		const { store } = makeStore();
		const service = new LedgerRecallService(store as never, fakeLedger as never, fakeWorkspace as never, emb.provider as never);
		try {
			await service.indexEntry('t', makeEntry(1, factText));
			await flushEmbedQueue();
			const results = await service.recall({ query: 'archive', threadScope: 'current', currentThreadId: 't' });
			assert.ok(results.length === 1 && results[0].seqRange[0] === 1, 'precise single content-term lookup still works');
		} finally { service.dispose(); }
	});
});
