/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';

/**
 * D3 regression tests for workspace symbol index persistence and .gitignore.
 *
 * The service had two problems:
 * 1. Zero persistence — every restart rebuilt the entire index from scratch
 *    (deferred 20s after startup), making the first 20s of every session
 *    a cold-start with no symbol data.
 * 2. No .gitignore reading — it used a hardcoded IGNORED_DIRS set of 28
 *    directory names, missing project-specific excludes.
 *
 * The fix adds:
 * - IPersistentContextStore injection + _ensureStore()/_hydrate() pattern
 *   (mirrors bm25Index.ts D1 fix)
 * - .gitignore reading in _loadGitignore() + _isGitignored() pattern matcher
 *
 * WorkspaceSymbolIndexService can't be instantiated in a unit test (it
 * extends Disposable and injects browser-only services), so these tests
 * verify the logic at the same level as the D1 BM25 tests: mock store +
 * mirror of the real hydrate and gitignore matching code.
 */

// ─── Mock store mirroring IPersistentContextStore symbol methods ─────────────

interface IStoredSymbol {
	name: string;
	kind: number;
	filePath: string;
	range: { startLine: number; startCol: number; endLine: number; endCol: number };
	containerName?: string;
}

interface IStoredFileIndex {
	uri: string;
	symbols: IStoredSymbol[];
	imports: string[];
	lastIndexedAt: number;
	contentHash: number;
}

class MockSymbolStore {
	private entries = new Map<string, IStoredFileIndex>();

	async initialize(_workspaceId: string): Promise<void> { /* no-op */ }

	async putFileIndex(fi: IStoredFileIndex): Promise<void> {
		this.entries.set(fi.uri, fi);
	}

	async getAllFileIndices(): Promise<IStoredFileIndex[]> {
		return [...this.entries.values()];
	}

	async deleteFileIndexByUri(uri: string): Promise<void> {
		this.entries.delete(uri);
	}

	async getSymbolFileHashes(): Promise<Map<string, number>> {
		const hashes = new Map<string, number>();
		for (const [uri, fi] of this.entries) {
			hashes.set(uri, fi.contentHash);
		}
		return hashes;
	}

	get size(): number { return this.entries.size; }
}

// ─── FNV-1a hash (mirrors _hashContent in workspaceSymbolIndex.ts) ────────────

function hashContent(content: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < content.length; i++) {
		hash ^= content.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

// ─── In-memory symbol index state (mirrors WorkspaceSymbolIndexService) ──────

interface IFileIndex {
	uri: string;
	symbols: IStoredSymbol[];
	imports: Set<string>;
	lastIndexedAt: number;
	contentHash: number;
}

class MockSymbolIndex {
	private fileIndices = new Map<string, IFileIndex>();
	private symbolsByName = new Map<string, Set<IStoredSymbol>>();
	private reverseImportEdges = new Map<string, Set<string>>();
	private store: MockSymbolStore;
	private hydrated = false;

	constructor(store: MockSymbolStore) {
		this.store = store;
	}

	/** Mirrors _ensureStore + _hydrate from the real service. */
	async ensureStore(): Promise<boolean> {
		await this.store.initialize('test-workspace');
		if (!this.hydrated) {
			this.hydrated = true;
			await this.hydrate();
		}
		return true;
	}

	/** Mirrors _hydrate from the real service. */
	async hydrate(): Promise<void> {
		const stored = await this.store.getAllFileIndices();
		if (stored.length === 0) { return; }

		this.fileIndices.clear();
		this.symbolsByName.clear();
		this.reverseImportEdges.clear();

		for (const fi of stored) {
			const symbols = fi.symbols;
			const imports = new Set(fi.imports);

			const fileIndex: IFileIndex = {
				uri: fi.uri,
				symbols,
				imports,
				lastIndexedAt: fi.lastIndexedAt,
				contentHash: fi.contentHash,
			};
			this.fileIndices.set(fi.uri, fileIndex);

			for (const sym of symbols) {
				let set = this.symbolsByName.get(sym.name);
				if (!set) {
					set = new Set();
					this.symbolsByName.set(sym.name, set);
				}
				set.add(sym);
			}

			for (const target of imports) {
				let rev = this.reverseImportEdges.get(target);
				if (!rev) {
					rev = new Set();
					this.reverseImportEdges.set(target, rev);
				}
				rev.add(fi.uri);
			}
		}
	}

	/** Mirrors _serializeFileIndex. */
	private serialize(fi: IFileIndex): IStoredFileIndex {
		return {
			uri: fi.uri,
			symbols: fi.symbols,
			imports: Array.from(fi.imports),
			lastIndexedAt: fi.lastIndexedAt,
			contentHash: fi.contentHash,
		};
	}

	/** Mirrors the persistence part of _indexFile. */
	async indexFile(uri: string, symbols: IStoredSymbol[], imports: string[], content: string): Promise<void> {
		const hash = hashContent(content);
		const existing = this.fileIndices.get(uri);
		if (existing && existing.contentHash === hash) { return; }

		const fileIndex: IFileIndex = {
			uri,
			symbols,
			imports: new Set(imports),
			lastIndexedAt: Date.now(),
			contentHash: hash,
		};
		this.fileIndices.set(uri, fileIndex);

		for (const sym of symbols) {
			let set = this.symbolsByName.get(sym.name);
			if (!set) {
				set = new Set();
				this.symbolsByName.set(sym.name, set);
			}
			set.add(sym);
		}

		for (const target of imports) {
			let rev = this.reverseImportEdges.get(target);
			if (!rev) {
				rev = new Set();
				this.reverseImportEdges.set(target, rev);
			}
			rev.add(uri);
		}

		await this.store.putFileIndex(this.serialize(fileIndex));
	}

	/** Mirrors _removeFile including the persistent store delete. */
	async removeFile(uri: string): Promise<void> {
		const existing = this.fileIndices.get(uri);
		if (!existing) { return; }

		for (const sym of existing.symbols) {
			const set = this.symbolsByName.get(sym.name);
			if (set) {
				set.delete(sym);
				if (set.size === 0) { this.symbolsByName.delete(sym.name); }
			}
		}

		for (const target of existing.imports) {
			const rev = this.reverseImportEdges.get(target);
			if (rev) {
				rev.delete(uri);
				if (rev.size === 0) { this.reverseImportEdges.delete(target); }
			}
		}

		this.fileIndices.delete(uri);
		await this.store.deleteFileIndexByUri(uri);
	}

	getFileCount(): number { return this.fileIndices.size; }

	getSymbolCount(): number {
		let count = 0;
		for (const fi of this.fileIndices.values()) {
			count += fi.symbols.length;
		}
		return count;
	}

	getSymbolsByName(name: string): IStoredSymbol[] {
		const set = this.symbolsByName.get(name);
		return set ? Array.from(set) : [];
	}

	getImporters(uri: string): string[] {
		const set = this.reverseImportEdges.get(uri);
		return set ? Array.from(set) : [];
	}

	getFileHash(uri: string): number | undefined {
		return this.fileIndices.get(uri)?.contentHash;
	}
}

// ─── .gitignore pattern matcher (mirrors _matchGitignorePattern) ─────────────

function matchGitignorePattern(filePath: string, pattern: string): boolean {
	const normalizedPath = filePath.replace(/\\/g, '/');

	if (pattern.endsWith('/')) {
		const dir = pattern.slice(0, -1);
		const segments = normalizedPath.split('/');
		if (segments.some(s => s === dir)) { return true; }
		if (normalizedPath.includes('/' + dir + '/')) { return true; }
		return false;
	}

	if (pattern.startsWith('!')) { return false; }

	let regexStr = pattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*');

	if (!pattern.includes('/')) {
		regexStr = '(^|/)' + regexStr + '(/|$)';
	}

	const regex = new RegExp(regexStr);
	return regex.test(normalizedPath);
}

function isGitignored(filePath: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		if (matchGitignorePattern(filePath, pattern)) {
			return true;
		}
	}
	return false;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

suite('D3: Symbol Index Persistence', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('hydrate restores all files, symbols, and import edges from persistent store', async () => {
		const store = new MockSymbolStore();

		// Simulate a previous session that persisted 3 files
		const sym1: IStoredSymbol = { name: 'foo', kind: 12, filePath: '/src/a.ts', range: { startLine: 1, startCol: 0, endLine: 5, endCol: 0 } };
		const sym2: IStoredSymbol = { name: 'bar', kind: 6, filePath: '/src/b.ts', range: { startLine: 1, startCol: 0, endLine: 10, endCol: 0 } };
		const sym3: IStoredSymbol = { name: 'baz', kind: 6, filePath: '/src/c.ts', range: { startLine: 1, startCol: 0, endLine: 3, endCol: 0 } };

		await store.putFileIndex({ uri: 'file:///src/a.ts', symbols: [sym1], imports: ['file:///src/b.ts'], lastIndexedAt: 1000, contentHash: 111 });
		await store.putFileIndex({ uri: 'file:///src/b.ts', symbols: [sym2], imports: ['file:///src/c.ts'], lastIndexedAt: 2000, contentHash: 222 });
		await store.putFileIndex({ uri: 'file:///src/c.ts', symbols: [sym3], imports: [], lastIndexedAt: 3000, contentHash: 333 });

		// Simulate a fresh start: new in-memory index, same store
		const index = new MockSymbolIndex(store);
		await index.ensureStore(); // triggers _hydrate

		assert.strictEqual(index.getFileCount(), 3, 'should have 3 files after hydrate');
		assert.strictEqual(index.getSymbolCount(), 3, 'should have 3 symbols after hydrate');
		assert.strictEqual(index.getSymbolsByName('foo').length, 1, 'should find foo by name');
		assert.strictEqual(index.getSymbolsByName('bar').length, 1, 'should find bar by name');
		assert.strictEqual(index.getImporters('file:///src/b.ts').length, 1, 'a.ts imports b.ts');
		assert.strictEqual(index.getImporters('file:///src/c.ts').length, 1, 'b.ts imports c.ts');
	});

	test('hydrate runs exactly once — second ensureStore does not re-clear', async () => {
		const store = new MockSymbolStore();
		await store.putFileIndex({ uri: 'file:///x.ts', symbols: [{ name: 'alpha', kind: 12, filePath: '/x.ts', range: { startLine: 1, startCol: 0, endLine: 2, endCol: 0 } }], imports: [], lastIndexedAt: 1000, contentHash: 42 });

		const index = new MockSymbolIndex(store);
		await index.ensureStore();
		assert.strictEqual(index.getFileCount(), 1, 'first hydrate should restore 1 file');

		// Add a file in-memory after hydrate
		await index.indexFile('file:///y.ts', [{ name: 'beta', kind: 12, filePath: '/y.ts', range: { startLine: 1, startCol: 0, endLine: 2, endCol: 0 } }], [], 'content-y');

		// Second ensureStore should NOT re-hydrate (hydrated flag is set)
		await index.ensureStore();
		assert.strictEqual(index.getFileCount(), 2, 'second ensureStore should not wipe in-memory additions');
		assert.strictEqual(index.getFileHash('file:///x.ts'), 42, 'original hydrated data should survive');
	});

	test('empty store hydrate is a no-op', async () => {
		const store = new MockSymbolStore();
		const index = new MockSymbolIndex(store);
		await index.ensureStore();

		assert.strictEqual(index.getFileCount(), 0, 'empty store should result in 0 files');
		assert.strictEqual(index.getSymbolCount(), 0, 'empty store should result in 0 symbols');
	});

	test('regression: without hydrate, symbol lookup returns nothing after restart', async () => {
		const store = new MockSymbolStore();
		await store.putFileIndex({ uri: 'file:///old.ts', symbols: [{ name: 'gamma', kind: 12, filePath: '/old.ts', range: { startLine: 1, startCol: 0, endLine: 2, endCol: 0 } }], imports: [], lastIndexedAt: 1000, contentHash: 999 });

		// Simulate the OLD (buggy) behavior: create a fresh index but DON'T call hydrate
		const index = new MockSymbolIndex(store);
		// Skip ensureStore() — this is the bug: store has data but in-memory maps are empty

		assert.strictEqual(index.getFileCount(), 0, 'without hydrate, file count should be 0');
		assert.strictEqual(index.getSymbolsByName('gamma').length, 0, 'without hydrate, symbol lookup should return nothing');
	});

	test('persisted hash allows skip of unchanged file on re-index', async () => {
		const store = new MockSymbolStore();
		const content = 'export function alpha() { return 42; }';
		const hash = hashContent(content);

		// Simulate previous session persisting a file
		await store.putFileIndex({
			uri: 'file:///src/alpha.ts',
			symbols: [{ name: 'alpha', kind: 12, filePath: '/src/alpha.ts', range: { startLine: 1, startCol: 0, endLine: 1, endCol: 30 } }],
			imports: [],
			lastIndexedAt: 1000,
			contentHash: hash,
		});

		const index = new MockSymbolIndex(store);
		await index.ensureStore();

		// Now try to index the same file with the same content
		// The hash check should skip it (existing.contentHash === hash)
		const persistedHashes = await store.getSymbolFileHashes();
		const persistedHash = persistedHashes.get('file:///src/alpha.ts');
		assert.strictEqual(persistedHash, hash, 'persisted hash should match content hash');

		// In the real service, _indexFile reads the file, computes hash,
		// compares to in-memory existing hash, and early-returns if equal.
		const inMemoryHash = index.getFileHash('file:///src/alpha.ts');
		assert.strictEqual(inMemoryHash, hash, 'in-memory hash should match after hydrate');
		assert.strictEqual(inMemoryHash, persistedHash, 'in-memory hash should equal persisted hash — file can be skipped');
	});

	test('removeFile deletes from both in-memory and persistent store', async () => {
		const store = new MockSymbolStore();
		const index = new MockSymbolIndex(store);

		await index.indexFile(
			'file:///src/del.ts',
			[{ name: 'deleteme', kind: 12, filePath: '/src/del.ts', range: { startLine: 1, startCol: 0, endLine: 5, endCol: 0 } }],
			['./other'],
			'export function deleteme() {}',
		);
		assert.strictEqual(index.getFileCount(), 1, 'should have 1 file before removal');
		assert.strictEqual(store.size, 1, 'store should have 1 entry before removal');

		await index.removeFile('file:///src/del.ts');
		assert.strictEqual(index.getFileCount(), 0, 'should have 0 files after removal');
		assert.strictEqual(store.size, 0, 'store should have 0 entries after removal');
		assert.strictEqual(index.getSymbolsByName('deleteme').length, 0, 'symbol should be gone');
	});
});

suite('D3: .gitignore Pattern Matching', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('directory suffix pattern (trailing /) matches path segment', () => {
		assert.strictEqual(matchGitignorePattern('/project/dist/main.js', 'dist/'), true, 'dist/ should match dist in path');
		assert.strictEqual(matchGitignorePattern('/project/src/main.js', 'dist/'), false, 'dist/ should not match src');
		assert.strictEqual(matchGitignorePattern('/project/node_modules/react/index.js', 'node_modules/'), true, 'node_modules/ should match');
	});

	test('basename glob pattern (*.ext) matches any file with that extension', () => {
		assert.strictEqual(matchGitignorePattern('/project/src/app.log', '*.log'), true, '*.log should match .log files');
		assert.strictEqual(matchGitignorePattern('/project/src/app.ts', '*.log'), false, '*.log should not match .ts files');
		assert.strictEqual(matchGitignorePattern('/project/debug.log', '*.log'), true, '*.log should match in root');
	});

	test('exact filename pattern matches any path segment', () => {
		assert.strictEqual(matchGitignorePattern('/project/secrets.txt', 'secrets.txt'), true, 'secrets.txt should match');
		assert.strictEqual(matchGitignorePattern('/project/src/secrets.txt', 'secrets.txt'), true, 'secrets.txt should match in subdirectory');
		assert.strictEqual(matchGitignorePattern('/project/src/app.ts', 'secrets.txt'), false, 'should not match different file');
	});

	test('path glob pattern matches specific path', () => {
		assert.strictEqual(matchGitignorePattern('/project/src/generated/types.ts', 'src/generated/*'), true, 'src/generated/* should match');
		assert.strictEqual(matchGitignorePattern('/project/src/app.ts', 'src/generated/*'), false, 'src/generated/* should not match other files');
	});

	test('negation pattern (!) is not supported and returns false', () => {
		assert.strictEqual(matchGitignorePattern('/project/dist/main.js', '!dist/'), false, 'negation should return false (not supported)');
	});

	test('isGitignored checks all patterns and returns true on first match', () => {
		const patterns = ['dist/', '*.log', 'secrets.txt', 'src/generated/*'];
		assert.strictEqual(isGitignored('/project/dist/main.js', patterns), true);
		assert.strictEqual(isGitignored('/project/debug.log', patterns), true);
		assert.strictEqual(isGitignored('/project/secrets.txt', patterns), true);
		assert.strictEqual(isGitignored('/project/src/generated/types.ts', patterns), true);
		assert.strictEqual(isGitignored('/project/src/app.ts', patterns), false, 'normal source file should not be ignored');
	});

	test('Windows-style backslash paths are normalized', () => {
		assert.strictEqual(matchGitignorePattern('C:\\project\\dist\\main.js', 'dist/'), true, 'backslash path should match dist/');
		assert.strictEqual(matchGitignorePattern('C:\\project\\src\\app.log', '*.log'), true, 'backslash path should match *.log');
	});

	test('empty pattern list means nothing is ignored', () => {
		assert.strictEqual(isGitignored('/project/dist/main.js', []), false);
		assert.strictEqual(isGitignored('/project/secrets.txt', []), false);
	});
});
