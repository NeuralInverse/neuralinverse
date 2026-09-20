/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
import assert from 'assert';
import { Emitter, Event } from '../../../../../../../base/common/event.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { RelevanceScorerService } from '../../../../browser/context/relevance/relevanceScorer.js';
import { HybridSearchService } from '../../../../browser/context/search/hybridSearchService.js';
import { EmbeddingService } from '../../../../browser/context/search/embeddingService.js';
import { CodeEmbeddingIngestionService } from '../../../../browser/context/search/codeEmbeddingIngestion.js';

function fakeEditorService(openUris: string[] = []) {
	return {
		onDidActiveEditorChange: Event.None,
		onDidCloseEditor: Event.None,
		activeEditor: null,
		editors: openUris.map(u => ({ resource: URI.parse(u) })),
	} as never;
}

function fakeSymbolIndex(symbolsByFile: Record<string, Array<{ name: string; kind: number; exportedAs?: string }>>) {
	const uris = Object.keys(symbolsByFile);
	return {
		_serviceBrand: undefined,
		onDidReindex: Event.None,
		onDidRemoveFiles: Event.None,
		onDidStartFullIndex: Event.None,
		onDidFinishFullIndex: Event.None,
		isReady: () => true,
		getSymbolsByName: (name: string) => uris.flatMap(u => symbolsByFile[u]!.filter(s => s.name === name).map(s => ({ name: s.name, kind: s.kind, filePath: u, range: { startLine: 1, startCol: 0, endLine: 1, endCol: 0 }, references: [], exportedAs: s.exportedAs }))),
		getSymbolsInFile: (u: string) => (symbolsByFile[u] ?? []).map(s => ({ name: s.name, kind: s.kind, filePath: u, range: { startLine: 1, startCol: 0, endLine: 1, endCol: 0 }, references: [], exportedAs: s.exportedAs })),
		getImporters: () => [] as string[],
		getImports: () => [] as string[],
		getTransitiveDependents: () => [] as string[],
		getTransitiveImports: () => [] as string[],
		getFileIndex: () => undefined,
		getStats: () => ({ totalFiles: uris.length, totalSymbols: 0, indexingInProgress: false }),
		forceReindex: async () => { },
	} as never;
}

function fakeChangeTracker() {
	return {
		getRecentlyEdited: () => [] as Array<{ uri: string }>,
		getCoEditedFiles: (_uri: string) => [] as string[],
		getEditHeat: (_uri: string) => 0,
		getEditVelocity: (_uri: string) => 0,
		getHotRegions: (_uri: string) => [] as Array<{ start: number; end: number; heat: number }>,
	} as never;
}

function fakeHybridSearch(results: Array<{ filePath: string; score: number }>) {
	return {
		_serviceBrand: undefined,
		search: async () => results.map(r => ({ filePath: r.filePath, content: '', startLine: 0, endLine: 0, score: r.score, sources: ['bm25' as const] })),
		getStatus: () => ({ bm25Files: 0, trigramEntries: 0, embeddingsAvailable: false }),
	} as never;
}

suite('Retrieval chain — real services with fake IO', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('F04: a text query without an active editor still scores candidate files', async () => {
		const symbols = {
			'file:///ws/products.html': [{ name: 'renderProductCard', kind: 12, exportedAs: 'renderProductCard' }],
			'file:///ws/styles.css': [{ name: 'productGrid', kind: 12, exportedAs: 'productGrid' }],
			'file:///ws/unrelated.ts': [{ name: 'parseInvoice', kind: 12, exportedAs: 'parseInvoice' }],
		};
		const scorer = new RelevanceScorerService(
			fakeEditorService(),          // no open editors, no active editor
			fakeSymbolIndex(symbols),
			fakeChangeTracker(),
			fakeHybridSearch([{ filePath: 'file:///ws/products.html', score: 0.9 }]),
		);
		try {
			const scored = await scorer.scoreFilesAsync({ type: 'message', text: 'render product card' }, 10);
			assert.ok(scored.length > 0, 'expected candidates without an active editor, got none');
			assert.ok(scored.some(s => s.uri === 'file:///ws/products.html'), 'the file matching the query terms must be scored');
			assert.ok(!scored.some(s => s.uri === 'file:///ws/unrelated.ts'), 'unrelated files stay unscored');
		} finally { scorer.dispose(); }
	});

	test('F05: vector-only hits keep their content and line metadata through hybrid merge', async () => {
		const bm25 = {
			getIndexedFileCount: () => 0,
			search: async () => [],
		} as never;
		const trigram = { search: () => [], getEntryCount: () => 0 } as never;
		const embedding = {
			isAvailable: true,
			search: async () => [{
				id: 'c:/ws/products.html:50', filePath: 'c:/ws/products.html', similarity: 0.82,
				model: 'text-embedding-3-small', startLine: 50, endLine: 100,
				content: '<div class="product-card">…</div>',
			}],
		} as never;
		const hybrid = new HybridSearchService(bm25, trigram, embedding);
		const results = await hybrid.search('product card layout', 5);
		assert.strictEqual(results.length, 1);
		const hit = results[0];
		assert.strictEqual(hit.filePath, 'c:/ws/products.html');
		assert.strictEqual(hit.startLine, 50);
		assert.strictEqual(hit.endLine, 100);
		assert.ok(hit.content.includes('product-card'), 'vector-only hit must carry usable content');
		assert.deepStrictEqual(hit.sources, ['embedding']);
	});

	test('F06: search excludes vectors from another embedding model or legacy records', async () => {
		const store = {
			putEmbeddings: async () => { },
			getEmbedding: async () => undefined,
			getAllEmbeddings: async () => [],
			getEmbeddingsByFile: async () => [],
			deleteEmbeddingsByFile: async () => { },
		};
		const settings = {
			state: { settingsOfProvider: { ollama: { endpoint: 'http://localhost:11434' } } },
			onDidChangeState: Event.None,
		} as never;
		const service = new EmbeddingService(store as never, settings);
		try {
			assert.strictEqual(service.isAvailable, true, 'local providers do not need an API key');
			assert.strictEqual(service.model, 'nomic-embed-text');
			// the query embed needs a provider — stub it so the model-gating
			// logic under test runs deterministically without a live server
			(service as unknown as { _requestEmbedding: (c: string) => Promise<{ vector: Float32Array; model: string } | null> })._requestEmbedding = async () => ({ vector: new Float32Array([0, 0, 1]), model: 'nomic-embed-text' });
			// seed the live cache the way _loadFromStore would
			(service as unknown as { _vectors: Map<string, { filePath: string; model: string | undefined; startLine: number; endLine: number; content: string | undefined; vector: Float32Array }> })._vectors.set('a', {
				filePath: 'c:/ws/a.ts', model: 'text-embedding-3-small', startLine: 0, endLine: 10, content: 'x', vector: new Float32Array([1, 0, 0]),
			});
			(service as unknown as { _vectors: Map<string, { model: string | undefined }> })._vectors.set('legacy', {
				filePath: 'c:/ws/b.ts', model: undefined, startLine: 0, endLine: 0, content: undefined, vector: new Float32Array([0, 1, 0]),
			} as never);
			// a matching-model record should be the only searchable one
			(service as unknown as { _vectors: Map<string, { model: string | undefined }> })._vectors.set('current', {
				filePath: 'c:/ws/c.ts', model: 'nomic-embed-text', startLine: 0, endLine: 0, content: 'ok', vector: new Float32Array([0, 0, 1]),
			} as never);
			const results = await service.search('anything');
			assert.strictEqual(results.length, 1);
			assert.strictEqual(results[0].filePath, 'c:/ws/c.ts');
		} finally { service.dispose(); }
	});

	test('ingestion: only stale chunks are re-embedded; orphans and deletes are cleaned', async () => {
		const chunks = [
			{ id: 'c:/ws/a.ts:0', filePath: 'c:/ws/a.ts', contentHash: 'h1', content: 'chunk one', startLine: 0, endLine: 50 },
			{ id: 'c:/ws/a.ts:50', filePath: 'c:/ws/a.ts', contentHash: 'h2', content: 'chunk two', startLine: 50, endLine: 100 },
		];
		const embedded: string[] = [];
		const deleted: string[] = [];
		const storedEmbeddings = () => [
			{ id: 'c:/ws/a.ts:0', filePath: 'c:/ws/a.ts', contentHash: 'h1', model: 'nomic-embed-text' }, // fresh — skip
			{ id: 'c:/ws/a.ts:50', filePath: 'c:/ws/a.ts', contentHash: 'OLD', model: 'nomic-embed-text' }, // stale hash — re-embed
			{ id: 'c:/ws/a.ts:100', filePath: 'c:/ws/a.ts', contentHash: 'h3', model: 'nomic-embed-text' }, // orphan — triggers file cleanup
		];
		const store = {
			getChunksByFile: async (p: string) => p === 'c:/ws/a.ts' ? chunks : [],
			getEmbeddingsByFile: async (_p: string) => storedEmbeddings(),
			putEmbeddings: async () => { },
			deleteEmbeddingsByFile: async (p: string) => { deleted.push(p); },
			getAllEmbeddings: async () => [],
		};
		const embeddings = {
			isAvailable: true,
			model: 'nomic-embed-text',
			embedChunk: async (c: { id: string }) => { embedded.push(c.id); return true; },
			getEmbeddingsForFile: async (p: string) => store.getEmbeddingsByFile(p),
			deleteEmbeddingsForFile: async (p: string) => { deleted.push(p); },
		} as never;
		const emitter = new Emitter<string[]>();
		const symbolIndex = {
			onDidReindex: emitter.event,
			onDidRemoveFiles: Event.None,
		} as never;
		const logs: string[] = [];
		const service = new CodeEmbeddingIngestionService(store as never, embeddings, symbolIndex, { info() { }, warn: (m: string) => logs.push(m), error() { } } as never);
		try {
			await service.ingestFile('c:/ws/a.ts');
			// orphan present → whole-file cleanup runs, then both live chunks re-embed
			assert.ok(deleted.includes('c:/ws/a.ts'), 'orphaned vectors trigger file cleanup');
			assert.deepStrictEqual(embedded.sort(), ['c:/ws/a.ts:0', 'c:/ws/a.ts:50']);

			// second pass with a clean store: nothing re-embeds
			embedded.length = 0;
			deleted.length = 0;
			store.getEmbeddingsByFile = async () => chunks.map(c => ({ id: c.id, filePath: c.filePath, contentHash: c.contentHash, model: 'nomic-embed-text' }));
			await service.ingestFile('c:/ws/a.ts');
			assert.strictEqual(embedded.length, 0, 'fresh chunks are not re-embedded');
			assert.strictEqual(deleted.length, 0);

			// model switch invalidates everything
			(embeddings as unknown as { model: string }).model = 'other-model';
			await service.ingestFile('c:/ws/a.ts');
			assert.strictEqual(embedded.length, 2, 'records from another model are re-embedded');
		} finally { service.dispose(); }
	});
});
