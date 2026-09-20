/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

/**
 *  B3 docs index acceptance (task 2026-09-15 §B3): real WorkspaceBM25Service
 *  over a fake store. Text documents (Markdown/HTML) must be searchable with
 *  section-level citation (path + sectionTitle + line range); section titles
 *  participate in matching; edits/deletes refresh results; a restart on the
 *  same store keeps working; code files carry no section title.
 */
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { WorkspaceBM25Service } from '../../../../browser/context/search/bm25Index.js';
import type { IStoredChunk } from '../../../../browser/context/search/persistentStore.js';

class FakeStore {
	readonly chunks = new Map<string, IStoredChunk>();
	private hashes = new Map<string, string>();

	async initialize(): Promise<void> { /* no-op */ }
	async putChunks(list: IStoredChunk[]): Promise<void> {
		for (const c of list) { this.chunks.set(c.id, c); this.hashes.set(c.filePath, c.contentHash); }
	}
	async getChunksByFile(filePath: string): Promise<IStoredChunk[]> { return [...this.chunks.values()].filter(c => c.filePath === filePath); }
	async getAllChunks(): Promise<IStoredChunk[]> { return [...this.chunks.values()]; }
	async deleteChunksByFile(filePath: string): Promise<void> {
		for (const [id, c] of this.chunks) { if (c.filePath === filePath) { this.chunks.delete(id); } }
		this.hashes.delete(filePath);
	}
	async clearAll(): Promise<void> { this.chunks.clear(); this.hashes.clear(); }
	async getFileContentHash(filePath: string): Promise<string | undefined> { return this.hashes.get(filePath); }
}

const fakeWorkspace = { getWorkspace: () => ({ folders: [{ uri: { toString: () => 'file:///ws' } }] }) };

const GUIDE = [
	'# Release Guide',
	'',
	'## Deploy Checklist',           // section the query asks about
	'run the pipeline, wait for green, then publish the artifacts.',
	'',
	'## Rollback Procedure',
	'scale down the canary and restore the previous image tag.',
].join('\n');

suite('Docs index — B3 section recall with citation (real BM25 service)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a closed document answers with the right section, title and line range', async () => {
		const store = new FakeStore();
		const service = new WorkspaceBM25Service(store as never, fakeWorkspace as never);
		try {
			await service.indexFile('docs/release-guide.md', GUIDE, 'h1');
			const hits = await service.search('deploy checklist pipeline publish', 5);
			assert.ok(hits.length > 0, 'the document section is found without opening the file');
			const top = hits[0];
			assert.strictEqual(top.filePath, 'docs/release-guide.md');
			assert.strictEqual(top.sectionTitle, 'Deploy Checklist', 'the citation names the section');
			assert.ok(top.startLine <= 4 && top.endLine >= 4, `the citation covers the section body (${top.startLine}-${top.endLine})`);
		} finally { service.dispose(); }
	});

	test('the section title participates in matching — a topic query hits without body-word overlap', async () => {
		const store = new FakeStore();
		const service = new WorkspaceBM25Service(store as never, fakeWorkspace as never);
		try {
			// body wording shares NO token with the query; only the heading does
			const doc = '# Shipping Runbook\nscale the fleet and rotate certificates.\n'.repeat(3);
			await service.indexFile('docs/runbook.md', doc, 'h1');
			const hits = await service.search('shipping runbook', 5);
			assert.ok(hits.length > 0, 'the heading alone must make the section findable');
			assert.strictEqual(hits[0].sectionTitle, 'Shipping Runbook');
		} finally { service.dispose(); }
	});

	test('HTML documents get section titles from <hN> tags', async () => {
		const store = new FakeStore();
		const service = new WorkspaceBM25Service(store as never, fakeWorkspace as never);
		try {
			const html = '<h1>Home</h1>\n<p>welcome</p>\n<h2>Pricing FAQ</h2>\n<p>all plans include support.</p>\n';
			await service.indexFile('docs/faq.html', html, 'h1');
			const hits = await service.search('pricing faq support', 5);
			assert.ok(hits.length > 0);
			assert.strictEqual(hits[0].sectionTitle, 'Pricing FAQ');
		} finally { service.dispose(); }
	});

	test('code files carry no section title (unchanged behavior)', async () => {
		const store = new FakeStore();
		const service = new WorkspaceBM25Service(store as never, fakeWorkspace as never);
		try {
			await service.indexFile('src/pricing.ts', '// section: helpers\nexport function checkoutTotal() {}\n', 'h1');
			const hits = await service.search('checkoutTotal', 5);
			assert.ok(hits.length > 0);
			assert.strictEqual(hits[0].sectionTitle, undefined);
		} finally { service.dispose(); }
	});

	test('editing a document refreshes results; deleting removes them; a restart keeps the fresh state', async () => {
		const store = new FakeStore();
		const service = new WorkspaceBM25Service(store as never, fakeWorkspace as never);
		try {
			await service.indexFile('docs/guide.md', '# Old Title\nlegacy content about the widget socket\n', 'h1');
			let hits = await service.search('widget socket', 5);
			assert.ok(hits.length > 0 && hits[0].sectionTitle === 'Old Title');

			// edit: the section is renamed and content replaced
			await service.indexFile('docs/guide.md', '# New Title\nfresh content about the gadget port\n', 'h2');
			hits = await service.search('widget socket', 5);
			assert.ok(!hits.some(h => h.content.includes('legacy content')), 'stale content is gone after reindex');
			hits = await service.search('gadget port', 5);
			assert.ok(hits.length > 0 && hits[0].sectionTitle === 'New Title', 'fresh content answers with the new section');

			// delete
			await service.removeFile('docs/guide.md');
			hits = await service.search('gadget port', 5);
			assert.strictEqual(hits.length, 0, 'deleted document no longer answers');
		} finally { service.dispose(); }

		// restart: a NEW service over the same persisted store
		const service2 = new WorkspaceBM25Service(store as never, fakeWorkspace as never);
		try {
			const hits = await service2.search('gadget port', 5);
			assert.strictEqual(hits.length, 0, 'restart must not resurrect the deleted document');
		} finally { service2.dispose(); }
	});
});
