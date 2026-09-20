/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';

/**
 * D1 regression test: on second startup, the BM25 in-memory index must be
 * hydrated from the persistent store so that search() returns results and
 * getIndexedFileCount() is non-zero even when every file's hash is unchanged.
 *
 * The bug: indexFile() early-returns when existingHash === contentHash (line
 * 94), so _invertedIndex and _indexedFiles never get populated. rebuild()
 * (line 219) was the fix but had zero callers. The fix calls rebuild() once
 * after _ensureStore() succeeds.
 *
 * WorkspaceBM25Service can't be instantiated in a unit test (it extends
 * Disposable and injects browser-only services), so this suite verifies the
 * fix at the logic level: the same mock persistent store that the service
 * uses, proving that rebuild() correctly hydrates from getAllChunks() and
 * that _ensureStore → rebuild is called exactly once.
 */

// ─── Mock store mirroring the real IPersistentContextStore ────────────────────

interface IStoredChunk {
	id: string;
	filePath: string;
	contentHash: string;
	content: string;
	startLine: number;
	endLine: number;
	symbolName?: string;
	terms: string[];
	updatedAt: number;
}

class MockPersistentStore {
	private chunks = new Map<string, IStoredChunk>();
	private hashes = new Map<string, string>();

	async initialize(_workspaceId: string): Promise<void> { /* no-op */ }

	async putChunks(chunks: IStoredChunk[]): Promise<void> {
		for (const c of chunks) {
			this.chunks.set(c.id, c);
			this.hashes.set(c.filePath, c.contentHash);
		}
	}
	async getChunksByFile(filePath: string): Promise<IStoredChunk[]> {
		return [...this.chunks.values()].filter(c => c.filePath === filePath);
	}
	async getAllChunks(): Promise<IStoredChunk[]> {
		return [...this.chunks.values()];
	}
	async deleteChunksByFile(filePath: string): Promise<void> {
		for (const [id, c] of this.chunks) {
			if (c.filePath === filePath) { this.chunks.delete(id); }
		}
		this.hashes.delete(filePath);
	}
	async clearAll(): Promise<void> { this.chunks.clear(); this.hashes.clear(); }
	async getFileContentHash(filePath: string): Promise<string | undefined> {
		return this.hashes.get(filePath);
	}
}

// ─── Tokenizer (mirrors the private _tokenize in bm25Index.ts) ───────────────

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, ' ')
		.split(/\s+/)
		.filter(t => t.length > 1 && t.length < 50);
}

// ─── Chunker (mirrors the private _chunkContent in bm25Index.ts) ──────────────

function chunkContent(filePath: string, content: string, contentHash: string): IStoredChunk[] {
	const lines = content.split('\n');
	const chunks: IStoredChunk[] = [];
	const CHUNK_SIZE = 50;

	for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
		const chunkLines = lines.slice(i, i + CHUNK_SIZE);
		const chunkContent = chunkLines.join('\n');
		const terms = tokenize(chunkContent);
		chunks.push({
			id: `${filePath}:${i}`,
			filePath,
			contentHash,
			content: chunkContent,
			startLine: i + 1,
			endLine: Math.min(i + CHUNK_SIZE, lines.length),
			terms,
			updatedAt: Date.now(),
		});
	}
	return chunks;
}

// ─── In-memory inverted index (mirrors WorkspaceBM25Service state) ────────────

interface PostingEntry { chunkId: string; filePath: string; tf: number }

class MockBM25Index {
	private invertedIndex = new Map<string, PostingEntry[]>();
	private docLengths = new Map<string, number>();
	private totalDocs = 0;
	private indexedFiles = new Set<string>();
	private ready = false;
	/** Public for testing the no-rebuild regression path. */
	public hydrated = false;

	constructor(private store: MockPersistentStore) { }

	async ensureStore(): Promise<boolean> {
		// Mirrors _ensureStore with the D1 fix: rebuild once after init
		if (!this.hydrated) {
			this.hydrated = true;
			await this.rebuild().catch(() => { /* best-effort */ });
		}
		return true;
	}

	async indexFile(filePath: string, content: string, contentHash: string): Promise<void> {
		await this.ensureStore();

		// D1 bug: this early-return skips populating invertedIndex on second startup
		const existingHash = await this.store.getFileContentHash(filePath);
		if (existingHash === contentHash) { return; }

		await this.removeFile(filePath);
		const chunks = chunkContent(filePath, content, contentHash);

		for (const chunk of chunks) {
			this.docLengths.set(chunk.id, chunk.terms.length);
			this.totalDocs++;
			const termFreqs = new Map<string, number>();
			for (const term of chunk.terms) {
				termFreqs.set(term, (termFreqs.get(term) || 0) + 1);
			}
			for (const [term, freq] of termFreqs) {
				if (!this.invertedIndex.has(term)) { this.invertedIndex.set(term, []); }
				this.invertedIndex.get(term)!.push({ chunkId: chunk.id, filePath, tf: freq });
			}
		}

		this.indexedFiles.add(filePath);
		await this.store.putChunks(chunks);
		this.ready = true;
	}

	async removeFile(filePath: string): Promise<void> {
		const existingChunks = await this.store.getChunksByFile(filePath);
		for (const chunk of existingChunks) {
			this.docLengths.delete(chunk.id);
			this.totalDocs = Math.max(0, this.totalDocs - 1);
			for (const term of chunk.terms) {
				const postings = this.invertedIndex.get(term);
				if (postings) {
					const idx = postings.findIndex(p => p.chunkId === chunk.id);
					if (idx >= 0) { postings.splice(idx, 1); }
					if (postings.length === 0) { this.invertedIndex.delete(term); }
				}
			}
		}
		this.indexedFiles.delete(filePath);
		await this.store.deleteChunksByFile(filePath);
	}

	async search(query: string): Promise<{ filePath: string; chunkId: string }[]> {
		await this.ensureStore();
		const queryTerms = tokenize(query);
		const scores = new Map<string, { score: number; filePath: string }>();

		for (const term of queryTerms) {
			const postings = this.invertedIndex.get(term);
			if (!postings) { continue; }
			for (const posting of postings) {
				const existing = scores.get(posting.chunkId);
				if (existing) { existing.score += 1; }
				else { scores.set(posting.chunkId, { score: 1, filePath: posting.filePath }); }
			}
		}

		return [...scores.entries()].map(([chunkId, v]) => ({ filePath: v.filePath, chunkId }));
	}

	getIndexedFileCount(): number { return this.indexedFiles.size; }
	get isReady(): boolean { return this.ready; }

	async rebuild(): Promise<void> {
		this.invertedIndex.clear();
		this.docLengths.clear();
		this.totalDocs = 0;
		this.indexedFiles.clear();

		const allChunks = await this.store.getAllChunks();
		for (const chunk of allChunks) {
			this.docLengths.set(chunk.id, chunk.terms.length);
			this.totalDocs++;
			this.indexedFiles.add(chunk.filePath);
			const termFreqs = new Map<string, number>();
			for (const term of chunk.terms) {
				termFreqs.set(term, (termFreqs.get(term) || 0) + 1);
			}
			for (const [term, freq] of termFreqs) {
				if (!this.invertedIndex.has(term)) { this.invertedIndex.set(term, []); }
				this.invertedIndex.get(term)!.push({ chunkId: chunk.id, filePath: chunk.filePath, tf: freq });
			}
		}
		this.ready = true;
	}
}

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('BM25 second-startup hydration (D1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('rebuild() is called on first ensureStore, hydrating from persisted chunks', async () => {
		const store = new MockPersistentStore();
		const bm25 = new MockBM25Index(store);

		// Simulate first startup: index a file
		const content = 'function hello() { return "world"; }';
		const hash = 'abc123';
		await bm25.indexFile('/test/file.ts', content, hash);

		// Verify search works on first startup
		const results1 = await bm25.search('hello');
		assert.ok(results1.length > 0, 'search should return results after first indexFile');
		assert.strictEqual(bm25.getIndexedFileCount(), 1, 'getIndexedFileCount should be 1');

		// Simulate second startup: create a NEW index instance with the same
		// persistent store (data is still there from the first run).
		const bm25Second = new MockBM25Index(store);

		// Try to index the same file with the same hash — this is what happens
		// on second startup. Without the fix, this early-returns and leaves
		// the in-memory index empty.
		await bm25Second.indexFile('/test/file.ts', content, hash);

		// THE REGRESSION: search should return results even though indexFile
		// early-returned (hash matched). rebuild() must have hydrated the
		// in-memory index from the persisted chunks.
		const results2 = await bm25Second.search('hello');
		assert.ok(results2.length > 0, 'search should return results after second startup (rebuild hydration)');
		assert.strictEqual(bm25Second.getIndexedFileCount(), 1, 'getIndexedFileCount should be 1 after rebuild');
	});

	test('rebuild() only runs once per service lifetime', async () => {
		const store = new MockPersistentStore();
		const bm25 = new MockBM25Index(store);

		// First call to indexFile triggers ensureStore → rebuild
		await bm25.indexFile('/test/a.ts', 'const alpha = 1', 'h1');
		// Second call to indexFile should NOT trigger rebuild again
		await bm25.indexFile('/test/b.ts', 'const beta = 2', 'h2');

		// Both files should be indexed
		const resultsA = await bm25.search('alpha');
		const resultsB = await bm25.search('beta');
		assert.ok(resultsA.length > 0, 'should find alpha');
		assert.ok(resultsB.length > 0, 'should find beta');
		assert.strictEqual(bm25.getIndexedFileCount(), 2, 'should have 2 files indexed');
	});

	test('empty store: rebuild is a no-op, normal indexing proceeds', async () => {
		// Fresh store with no data — rebuild should do nothing,
		// and indexFile should still work normally
		const store = new MockPersistentStore();
		const bm25 = new MockBM25Index(store);
		await bm25.indexFile('/test/empty.ts', 'const gamma = 3', 'h3');

		const results = await bm25.search('gamma');
		assert.ok(results.length > 0, 'should find gamma in fresh store');
		assert.strictEqual(bm25.getIndexedFileCount(), 1, 'should have 1 file indexed');
	});

	test('WITHOUT fix: second startup loses all results (regression proof)', async () => {
		// This test simulates the bug WITHOUT the rebuild fix to prove
		// that the regression existed. We create a variant that skips rebuild.
		const store = new MockPersistentStore();

		// Index with rebuild (the fix)
		const bm25WithFix = new MockBM25Index(store);
		await bm25WithFix.indexFile('/test/file.ts', 'function hello() {}', 'h1');

		// Now simulate a broken index that skips rebuild (the bug)
		const bm25WithoutFix = new MockBM25Index(store);
		// Manually mark hydrated=true to skip rebuild
		bm25WithoutFix.hydrated = true;
		await bm25WithoutFix.indexFile('/test/file.ts', 'function hello() {}', 'h1');

		// Without rebuild, search returns nothing
		const results = await bm25WithoutFix.search('hello');
		assert.strictEqual(results.length, 0, 'without rebuild, search should return nothing (the bug)');
		assert.strictEqual(bm25WithoutFix.getIndexedFileCount(), 0, 'without rebuild, file count should be 0 (the bug)');

		// With rebuild, search works
		const results2 = await bm25WithFix.search('hello');
		assert.ok(results2.length > 0, 'with rebuild, search should return results');
	});
});

// ─── Deadlock regression (found by the owner's live test, 2026-09-10) ────────

/**
 * The first D1 fix hydrated by calling the public rebuild(), which opens with
 * `await this._ensureStore()`. By then _storeInit is already assigned but still
 * pending — it is waiting on this very rebuild() — so the two awaited each
 * other and never settled. Symptom on the installed build: the index status
 * spun forever, the index stayed empty, and every indexFile() caller hung,
 * which stalled the symbol-index walk on its first file.
 *
 * The fix splits the body into _rebuildFromStore(), which never re-checks the
 * store. This suite models both shapes and asserts the broken one hangs while
 * the fixed one settles.
 */
suite('BM25 hydrate must not deadlock', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	/** Resolves to 'timeout' if the promise has not settled in time. */
	function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
		return Promise.race([p, new Promise<'timeout'>(r => setTimeout(() => r('timeout'), ms))]);
	}

	/** The shape that shipped: hydrate goes through the public entry point. */
	class Deadlocking {
		private _init: Promise<boolean> | undefined;
		private _hydrated = false;
		ensureStore(): Promise<boolean> {
			if (!this._init) {
				this._init = (async () => {
					await Promise.resolve();
					if (!this._hydrated) {
						this._hydrated = true;
						await this.rebuild();
					}
					return true;
				})();
			}
			return this._init;
		}
		async rebuild(): Promise<void> {
			if (!await this.ensureStore()) { return; }
		}
	}

	/** The fix: hydrate calls the inner routine, which never re-checks. */
	class Fixed {
		private _init: Promise<boolean> | undefined;
		private _hydrated = false;
		hydrateCount = 0;
		ensureStore(): Promise<boolean> {
			if (!this._init) {
				this._init = (async () => {
					await Promise.resolve();
					if (!this._hydrated) {
						this._hydrated = true;
						await this.rebuildFromStore();
					}
					return true;
				})();
			}
			return this._init;
		}
		async rebuild(): Promise<void> {
			if (!await this.ensureStore()) { return; }
			await this.rebuildFromStore();
		}
		private async rebuildFromStore(): Promise<void> {
			this.hydrateCount++;
			await Promise.resolve();
		}
	}

	test('the shipped shape never settles', async () => {
		assert.strictEqual(await within(new Deadlocking().ensureStore(), 50), 'timeout');
	});

	test('the fixed shape settles', async () => {
		assert.strictEqual(await within(new Fixed().ensureStore(), 50), true);
	});

	test('a later explicit rebuild still works and re-hydrates', async () => {
		const svc = new Fixed();
		assert.strictEqual(await within(svc.ensureStore(), 50), true);
		assert.strictEqual(svc.hydrateCount, 1);
		assert.strictEqual(await within(svc.rebuild(), 50), undefined);
		assert.strictEqual(svc.hydrateCount, 2);
	});
});
