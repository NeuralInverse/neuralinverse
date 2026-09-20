/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

/**
 *  B2 live-closure regressions (2026-09-16): every test here pins a REAL
 *  failure observed on the live provider chain —
 *  - omni was gated on an API key the renderer never had (chat path treats
 *    omni as local), making a working router look like "no endpoint";
 *  - omni had no embedding-model preset, so requests carried a generic
 *    'text-embedding-3-small' that the router sent to a credit-less upstream
 *    (HTTP 429), silently producing zero vectors;
 *  - the previous provider's model leaked into the next provider's config;
 *  - a model flip during an in-flight request stamped the vector with a
 *    model that did not produce it;
 *  - re-indexing overwrote persisted vector stamps, forcing recurring
 *    re-embed traffic (and losing vectors on restart);
 *  - a model switch had no recovery path (stale vectors scored cosine 0
 *    forever) — the re-embed sweep closes that.
 */
import assert from 'assert';
import { Emitter } from '../../../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { EmbeddingService, normalizeEmbeddingEndpoint } from '../../../../browser/context/search/embeddingService.js';
import { LedgerRecallService } from '../../../../browser/context/search/ledgerRecallService.js';
import type { IStoredLedgerEntry, IStoredLedgerEpisode } from '../../../../browser/context/search/persistentStore.js';
import type { ILedgerEntry, IEpisodeBody } from '../../../../../void/common/ledgerTypes.js';

// ─── fakes ───────────────────────────────────────────────────────────────────

/** Mutable settings service: state object + change emitter. */
function makeSettings(settingsOfProvider: Record<string, unknown>) {
	const emitter = new Emitter<void>();
	const state = { settingsOfProvider: settingsOfProvider as never };
	return {
		state,
		fire: () => emitter.fire(),
		service: { state, onDidChangeState: emitter.event } as never,
	};
}

function makeEmbeddingStore() {
	return {
		putEmbeddings: async () => { },
		getEmbedding: async () => undefined,
		getAllEmbeddings: async () => [] as never[],
		getEmbeddingsByFile: async () => [] as never[],
		deleteEmbeddingsByFile: async () => { },
	};
}

function makeEntry(seq: number, content: string): ILedgerEntry {
	return { id: `le_t_${seq}`, seq, threadId: 't', role: 'user', content, ts: 1_000_000 + seq, tokens: 10 };
}

/** Fake ledger-index store with the same semantics as the IndexedDB impl. */
function makeLedgerStore() {
	const entries = new Map<string, IStoredLedgerEntry>();
	const episodes = new Map<string, IStoredLedgerEpisode>();
	return {
		entries, episodes,
		store: {
			initialize: async () => { },
			putLedgerEntries: async (list: IStoredLedgerEntry[]) => { for (const e of list) { entries.set(e.id, { ...e }); } },
			getLedgerEntry: async (id: string) => entries.get(id) !== undefined ? { ...entries.get(id)! } : undefined,
			searchLedgerEntriesByTerms: async (terms: string[], limit: number) => {
				const hits = [...entries.values()].filter(e => terms.some(t => e.terms.includes(t)));
				return hits.slice(0, limit).map(e => ({ ...e }));
			},
			putLedgerEpisodes: async (list: IStoredLedgerEpisode[]) => { for (const e of list) { episodes.set(e.id, { ...e }); } },
			getLedgerEpisode: async (id: string) => episodes.get(id) !== undefined ? { ...episodes.get(id)! } : undefined,
			searchLedgerEpisodesByTerms: async (terms: string[], limit: number) => {
				const hits = [...episodes.values()].filter(e => terms.some(t => e.terms.includes(t)));
				return hits.slice(0, limit).map(e => ({ ...e }));
			},
			getRecentEmbeddedLedgerRecords: async (limit: number) => {
				const refs = [...entries.values()].filter(e => e.embedding && e.embeddingModel)
					.map(e => ({ kind: 'entry' as const, id: e.id, threadId: e.threadId, seqRange: [e.seq, e.seq] as [number, number], ts: e.ts, snippet: e.snippet, embedding: e.embedding!, embeddingModel: e.embeddingModel! }));
				return refs.sort((a, b) => b.ts - a.ts).slice(0, limit);
			},
			// mirrors the real predicate: missing vector OR a different model
			getLedgerRecordsNeedingEmbedding: async (model: string, limit: number) => {
				const entryRefs = [...entries.values()].filter(e => !e.embedding || e.embeddingModel !== model)
					.map(e => ({ kind: 'entry' as const, id: e.id, threadId: e.threadId, seqRange: [e.seq, e.seq] as [number, number], ts: e.ts, snippet: e.snippet, embedding: e.embedding ?? [], embeddingModel: e.embeddingModel ?? '' }));
				const episodeRefs = [...episodes.values()].filter(e => !e.embedding || e.embeddingModel !== model)
					.map(e => ({ kind: 'episode' as const, id: e.id, threadId: e.threadId, seqRange: [e.fromSeq, e.toSeq] as [number, number], ts: e.ts, snippet: e.body.slice(0, 240), embedding: e.embedding ?? [], embeddingModel: e.embeddingModel ?? '' }));
				return [...entryRefs, ...episodeRefs].sort((a, b) => b.ts - a.ts).slice(0, limit);
			},
		},
	};
}

const fakeWorkspace = { getWorkspace: () => ({ folders: [{ uri: { toString: () => 'file:///ws' } }] }) };

async function flushEmbedQueue(times = 12): Promise<void> {
	for (let i = 0; i < times; i++) { await new Promise(r => setTimeout(r, 5)); }
}

// ─── provider config selection (EmbeddingService) ────────────────────────────

suite('Embedding provider config — B2 live closure regressions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('omni needs no API key (local parity), uses the router preset model, and normalizes a trailing /v1', async () => {
		const settings = makeSettings({
			omni: { endpoint: 'http://localhost:20128/v1', apiKey: '' },
		});
		const service = new EmbeddingService(makeEmbeddingStore() as never, settings.service);
		try {
			assert.strictEqual(service.isAvailable, true, 'omni is a local provider — no key required (chat path parity)');
			assert.strictEqual(service.model, 'mistral-embed', 'router preset model, not a generic OpenAI name');

			// endpoint building: a pasted OpenAI-style base (…/v1) must not double
			let capturedUrl = '';
			const realFetch = globalThis.fetch;
			globalThis.fetch = (async (url: RequestInfo | URL) => {
				capturedUrl = String(url);
				return new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] }), { status: 200 });
			}) as typeof fetch;
			try {
				const result = await service.embedText('probe');
				assert.ok(result, 'embed succeeds against the stub');
				assert.strictEqual(capturedUrl, 'http://localhost:20128/v1/embeddings', 'no /v1/v1 duplication');
				assert.strictEqual(result.model, 'mistral-embed');
			} finally {
				globalThis.fetch = realFetch;
			}
		} finally { service.dispose(); }
	});

	test('the per-provider embeddingModel setting overrides the preset', async () => {
		const settings = makeSettings({
			omni: { endpoint: 'http://localhost:20128', apiKey: '', embeddingModel: 'openrouter/mistralai/mistral-embed-2312' },
		});
		const service = new EmbeddingService(makeEmbeddingStore() as never, settings.service);
		try {
			assert.strictEqual(service.model, 'openrouter/mistralai/mistral-embed-2312');
		} finally { service.dispose(); }
	});

	test('switching providers never carries the previous provider\'s model over', async () => {
		// start with openAI configured — its model ('text-embedding-3-small')
		// used to survive into the omni-only config via a runtime fallback
		const settings = makeSettings({
			openAI: { apiKey: 'sk-live-key', endpoint: '' },
		});
		const service = new EmbeddingService(makeEmbeddingStore() as never, settings.service);
		try {
			assert.strictEqual(service.model, 'text-embedding-3-small');
			// the user switches to omni only
			settings.state.settingsOfProvider = { omni: { endpoint: 'http://localhost:20128', apiKey: '' } } as never;
			settings.fire();
			assert.strictEqual(service.isAvailable, true);
			assert.strictEqual(service.model, 'mistral-embed', 'omni preset — no leftover from openAI');
		} finally { service.dispose(); }
	});

	test('embedText returns the REQUEST\'s model — a mid-flight settings flip cannot relabel the vector', async () => {
		const settings = makeSettings({
			omni: { endpoint: 'http://localhost:20128', apiKey: '', embeddingModel: 'model-a' },
		});
		const service = new EmbeddingService(makeEmbeddingStore() as never, settings.service);
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			// the request was already built with model-a; NOW the user flips
			// the setting, then the endpoint answers
			settings.state.settingsOfProvider = { omni: { endpoint: 'http://localhost:20128', apiKey: '', embeddingModel: 'model-b' } } as never;
			settings.fire();
			await new Promise(r => setTimeout(r, 10));
			return new Response(JSON.stringify({ data: [{ embedding: [0.5, 0.5] }] }), { status: 200 });
		}) as typeof fetch;
		try {
			const result = await service.embedText('probe');
			assert.ok(result, 'request answered');
			assert.strictEqual(result.model, 'model-a', 'identity belongs to the request that produced the vector');
			assert.strictEqual(service.model, 'model-b', 'the CURRENT setting did flip');
		} finally {
			globalThis.fetch = realFetch;
			service.dispose();
		}
	});
});

// ─── ledger embed queue + sweep (LedgerRecallService) ────────────────────────

suite('Ledger embed queue — B2 live closure regressions', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	function makeQueueEmbeddingProvider(options: { model: () => string; gate?: Promise<void> }) {
		const calls: string[] = [];
		const emitter = new Emitter<string | undefined>();
		return {
			calls, emitter,
			provider: {
				get isAvailable() { return true; },
				get model() { return options.model(); },
				onDidChangeModel: emitter.event,
				embedText: async (text: string) => {
					const requestModel = options.model(); // captured at request time
					calls.push(text.slice(0, 40));
					if (options.gate) { await options.gate; }
					return { vector: new Float32Array([1, 0, 0]), model: requestModel };
				},
				embedToVector: async () => null,
			},
		};
	}

	function makeQueueLedger(entriesByRange: Record<string, ILedgerEntry[]>) {
		return {
			onDidAppendEntry: () => ({ dispose: () => { } }),
			onDidFreezeEpisode: () => ({ dispose: () => { } }),
			readRange: async (threadId: string, fromSeq: number, toSeq: number) =>
				(entriesByRange[`${threadId}:${fromSeq}-${toSeq}`] ?? []),
		};
	}

	test('re-indexing a current-model record preserves the stamp and makes NO new embed call', async () => {
		const model = 'model-a';
		const emb = makeQueueEmbeddingProvider({ model: () => model });
		const { store, entries } = makeLedgerStore();
		const service = new LedgerRecallService(store as never, makeQueueLedger({ 't:1-1': [makeEntry(1, 'deploy the pipeline on thursdays')] }) as never, fakeWorkspace as never, emb.provider as never);
		try {
			await service.indexEntry('t', makeEntry(1, 'deploy the pipeline on thursdays'));
			await flushEmbedQueue();
			assert.strictEqual(entries.get('t:1')?.embeddingModel, 'model-a');
			assert.strictEqual(emb.calls.length, 1, 'first index embeds once');

			// backfill-style re-index of the SAME immutable entry
			await service.indexEntry('t', makeEntry(1, 'deploy the pipeline on thursdays'));
			await flushEmbedQueue();
			assert.strictEqual(entries.get('t:1')?.embeddingModel, 'model-a', 'stamp survived the re-put');
			assert.ok(entries.get('t:1')?.embedding?.length, 'vector survived the re-put');
			assert.strictEqual(emb.calls.length, 1, 'generation guard: no recurring network traffic for current records');
		} finally { service.dispose(); }
	});

	test('a mid-flight model flip stamps the vector with the model that produced it', async () => {
		let model = 'model-a';
		let releaseGate!: () => void;
		const gate = new Promise<void>(r => { releaseGate = r; });
		const emb = makeQueueEmbeddingProvider({ model: () => model, gate });
		const { store, entries } = makeLedgerStore();
		const service = new LedgerRecallService(store as never, makeQueueLedger({ 't:1-1': [makeEntry(1, 'palette favors teal accents')] }) as never, fakeWorkspace as never, emb.provider as never);
		try {
			await service.indexEntry('t', makeEntry(1, 'palette favors teal accents'));
			await new Promise(r => setTimeout(r, 10)); // request started, parked on the gate
			model = 'model-b'; // the setting flips while the request is in flight
			releaseGate();
			await flushEmbedQueue();
			assert.strictEqual(entries.get('t:1')?.embeddingModel, 'model-a', 'stamp belongs to the producing model, not the current setting');
		} finally { service.dispose(); }
	});

	test('a model switch triggers the re-embed sweep and stale vectors recover', async () => {
		let model = 'model-a';
		const emb = makeQueueEmbeddingProvider({ model: () => model });
		const { store, entries } = makeLedgerStore();
		const ledger = makeQueueLedger({ 't:1-1': [makeEntry(1, 'we ship the release build every thursday')] });
		const service = new LedgerRecallService(store as never, ledger as never, fakeWorkspace as never, emb.provider as never);
		try {
			await service.indexEntry('t', makeEntry(1, 'we ship the release build every thursday'));
			await flushEmbedQueue();
			assert.strictEqual(entries.get('t:1')?.embeddingModel, 'model-a');

			// the model identity changes (settings switch) — the sweep must re-embed
			model = 'model-b';
			const enqueued = await service.reembedStaleVectors();
			assert.ok(enqueued >= 1, 'the stale record was re-enqueued');
			await flushEmbedQueue();
			assert.strictEqual(entries.get('t:1')?.embeddingModel, 'model-b', 'recovered with the new model');

			// the onDidChangeModel wiring drives the same sweep automatically
			entries.get('t:1')!.embeddingModel = 'model-c'; // force-stale again
			entries.get('t:1')!.embedding = [1, 0, 0];
			model = 'model-d';
			emb.emitter.fire('model-d');
			await flushEmbedQueue(20);
			assert.strictEqual(entries.get('t:1')?.embeddingModel, 'model-d', 'event-driven sweep re-embedded the stale record');
		} finally { service.dispose(); }
	});

	test('the sweep re-embeds records that never got a vector (outage recovery)', async () => {
		const model = 'model-a';
		const emb = makeQueueEmbeddingProvider({ model: () => model });
		const { store, entries } = makeLedgerStore();
		// entry indexed during an outage: stored WITHOUT any vector
		entries.set('t:7', {
			id: 't:7', threadId: 't', seq: 7, role: 'user', ts: 1_000_007, tokens: 10,
			terms: ['lighthouse', 'attic'], snippet: 'the lighthouse keeper keeps spare lamps in the attic',
		});
		const service = new LedgerRecallService(store as never, makeQueueLedger({ 't:7-7': [makeEntry(7, 'the lighthouse keeper keeps spare lamps in the attic')] }) as never, fakeWorkspace as never, emb.provider as never);
		try {
			const enqueued = await service.reembedStaleVectors();
			assert.ok(enqueued >= 1, 'the vector-less record was enqueued');
			await flushEmbedQueue();
			assert.strictEqual(entries.get('t:7')?.embeddingModel, 'model-a', 'outage gap closed with a stamped vector');
			assert.ok(emb.calls.some(c => c.includes('lighthouse')), 'entry text re-read from the journal was embedded');
		} finally { service.dispose(); }
	});

	test('episode sweep text is rebuilt from the stored body', async () => {
		const model = 'model-a';
		const emb = makeQueueEmbeddingProvider({ model: () => model });
		const { store, episodes } = makeLedgerStore();
		const body: IEpisodeBody = {
			goal: 'automate the deploy pipeline',
			decisions: [{ what: 'kept the build in CI', why: 'fast', sourceIds: [1] }],
			rejected: [], failures: [], corrections: [], invariants: ['always pnpm'],
			artifacts: { files: [], symbols: [], commands: [], configs: [] },
			state: { done: [], inProgress: [], verified: [] }, next: [], openQuestions: [],
		};
		episodes.set('t:1', {
			id: 't:1', threadId: 't', ordinal: 1, fromSeq: 10, toSeq: 19, ts: 2_000_001,
			terms: ['deploy'], body: JSON.stringify(body),
			// stamped by a DIFFERENT model — sweep must rebuild text and re-embed
			embedding: [1, 0], embeddingModel: 'old-model',
		});
		const service = new LedgerRecallService(store as never, makeQueueLedger({}) as never, fakeWorkspace as never, emb.provider as never);
		try {
			const enqueued = await service.reembedStaleVectors();
			assert.strictEqual(enqueued, 1);
			await flushEmbedQueue();
			assert.strictEqual(episodes.get('t:1')?.embeddingModel, 'model-a');
			assert.ok(emb.calls.some(c => c.includes('always pnpm')), 'invariants participate in the rebuilt text');
		} finally { service.dispose(); }
	});

	test('normalizeEmbeddingEndpoint handles all port, pathname, CSP, and provider edge cases cleanly', () => {
		// 1. Non-omni loopback with explicit port and base pathname (/api) -> port & path preserved, host kept as 127.0.0.1
		assert.strictEqual(
			normalizeEmbeddingEndpoint('http://127.0.0.1:8080/api', 'openAICompatible'),
			'http://127.0.0.1:8080/api/v1/embeddings'
		);

		// 1b. Omni loopback with explicit port and base pathname (/api) -> port & path preserved, host normalized to localhost
		assert.strictEqual(
			normalizeEmbeddingEndpoint('http://127.0.0.1:8080/api', 'omni'),
			'http://localhost:8080/api/v1/embeddings'
		);

		// 2. Trailing /v1 and trailing slash -> stripped without duplicate /v1/v1
		assert.strictEqual(
			normalizeEmbeddingEndpoint('http://localhost:20128/v1', 'omni'),
			'http://localhost:20128/v1/embeddings'
		);
		assert.strictEqual(
			normalizeEmbeddingEndpoint('http://localhost:20128/v1/', 'omni'),
			'http://localhost:20128/v1/embeddings'
		);

		// 3. Explicit port 80 preserved
		assert.strictEqual(
			normalizeEmbeddingEndpoint('http://localhost:80/api', 'openAICompatible'),
			'http://localhost:80/api/v1/embeddings'
		);

		// 4. Missing port on omni -> defaults to 20128 and alias normalized
		assert.strictEqual(
			normalizeEmbeddingEndpoint('http://127.0.0.1/api', 'omni'),
			'http://localhost:20128/api/v1/embeddings'
		);

		// 5. Missing port on non-omni local provider -> port not forced to 20128, host kept
		assert.strictEqual(
			normalizeEmbeddingEndpoint('http://127.0.0.1/api', 'ollama'),
			'http://127.0.0.1/api/v1/embeddings'
		);

		// 6. Look-alike host (127.0.0.1.example.test) -> NOT treated as loopback
		assert.strictEqual(
			normalizeEmbeddingEndpoint('http://127.0.0.1.example.test:8080/api', 'openAICompatible'),
			'http://127.0.0.1.example.test:8080/api/v1/embeddings'
		);

		// 7. HTTPS / remote endpoint -> host & protocol preserved
		assert.strictEqual(
			normalizeEmbeddingEndpoint('https://api.openai.com/v1', 'openAI'),
			'https://api.openai.com/v1/embeddings'
		);

		// 8. Invalid or empty URL -> safely returns null
		assert.strictEqual(normalizeEmbeddingEndpoint('', 'openAI'), null);
		assert.strictEqual(normalizeEmbeddingEndpoint('   ', 'openAI'), null);
	});
});
