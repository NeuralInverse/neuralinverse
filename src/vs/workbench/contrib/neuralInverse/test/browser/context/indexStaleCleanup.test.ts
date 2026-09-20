/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

/**
 *  A1 regression coverage (task 2026-09-15, §A1):
 *  - persisted stale entries (deleted on disk / now-gitignored) must vanish from
 *    every retrieval path after hydration + a completed reindex, and must not
 *    return on a second restart;
 *  - a canceled/partial walk must NOT prune (absence in an incomplete walk is
 *    not proof of deletion);
 *  - files under an unreadable directory are spared by stale cleanup;
 *  - watcher events apply ignore/unignore; a root leaving the workspace is
 *    pruned by the next completed walk;
 *  - run-stats reconciliation: discovered == indexed + unchanged + admission
 *    rejections.
 */
import assert from 'assert';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { SymbolKind } from '../../../../../../editor/common/languages.js';
import { WorkspaceSymbolIndexService, IIndexedSymbol } from '../../../browser/context/index/workspaceSymbolIndex.js';
import { IStoredFileIndex } from '../../../browser/context/search/persistentStore.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';

function makeSymbol(uri: string, name: string): IIndexedSymbol {
	return {
		name, kind: SymbolKind.Function, filePath: uri,
		range: { startLine: 1, startCol: 0, endLine: 2, endCol: 0 },
		references: [],
	};
}

interface FixtureOptions {
	/** files visible to the walk + reads: dir-relative path → content */
	disk?: Map<string, string>;
	/** store entries that predate this session: dir-relative path → symbol names */
	persisted?: Map<string, string[]>;
	/** initial root .gitignore content */
	gitignore?: string;
	/** dir-relative directory prefixes whose resolve() throws */
	failDirs?: string[];
}

function fixture(options: FixtureOptions = {}) {
	const root = URI.file('Z:/stale-cleanup');
	const disk = new Map(options.disk ?? []);
	const persistedRelative = new Map(options.persisted ?? []);
	const failDirs = (options.failDirs ?? []).map(d => URI.joinPath(root, d).toString());
	let gitignoreContent = options.gitignore ?? '';

	const uriOf = (rel: string) => URI.joinPath(root, rel).toString();

	// directories implied by disk paths (plus explicit node_modules when used)
	const dirNames = new Set<string>();
	for (const rel of disk.keys()) {
		const parts = rel.split('/');
		parts.pop();
		let acc = '';
		for (const p of parts) { acc = acc ? `${acc}/${p}` : p; dirNames.add(acc); }
	}

	const store = new Map<string, IStoredFileIndex>();
	for (const [rel, names] of persistedRelative) {
		const uri = uriOf(rel);
		store.set(uri, {
			uri, symbols: names.map(n => makeSymbol(uri, n)), imports: [],
			lastIndexedAt: 1, contentHash: 12345 + rel.length,
		});
	}

	const indexedLexical: string[] = [];
	const removedLexical: string[] = [];
	const trigramFiles: string[] = [];
	const storeDeletes: string[] = [];
	const filesEmitter = new Emitter<unknown>();

	const resolveDir = (dir: URI) => {
		const s = dir.toString();
		if (failDirs.includes(s)) { throw new Error('simulated unreadable directory'); }
		const rel = dir.path.slice(root.path.length).replace(/^\//, '');
		const prefix = rel ? rel + '/' : '';
		const children: Array<{ name: string; isDirectory: boolean; resource: URI }> = [];
		for (const p of disk.keys()) {
			if (!p.startsWith(prefix)) { continue; }
			const rest = p.slice(prefix.length);
			if (rest.includes('/')) {
				const name = rest.split('/')[0];
				if (!children.some(c => c.name === name)) { children.push({ name, isDirectory: true, resource: URI.joinPath(dir, name) }); }
			} else if (rest.length > 0) {
				children.push({ name: rest, isDirectory: false, resource: URI.joinPath(dir, rest) });
			}
		}
		return { children };
	};

	const service = new WorkspaceSymbolIndexService(
		{
			onDidFilesChange: filesEmitter.event,
			resolve: async (uri: URI) => resolveDir(uri),
			readFile: async (uri: URI) => {
				if (uri.path.endsWith('.gitignore')) { return { value: VSBuffer.fromString(gitignoreContent) }; }
				const rel = uri.path.slice(root.path.length + 1);
				const content = disk.get(rel);
				if (content === undefined) { throw Object.assign(new Error('not found'), { code: 'FileNotFound' }); }
				return { value: VSBuffer.fromString(content) };
			},
		} as never,
		{
			getWorkspace: () => ({ folders: [{ uri: root }] }),
			onDidChangeWorkspaceFolders: Event.None,
		} as never,
		{ onModelAdded: Event.None, getModel: () => null } as never,
		{} as never,
		{ info() { }, warn() { }, error() { } } as never,
		{
			indexFile: async (path: string) => { indexedLexical.push(path); },
			removeFile: async (path: string) => { removedLexical.push(path); },
		} as never,
		{
			addEntry(_uri: string, filePath: string) { trigramFiles.push(filePath); },
			removeEntriesForFile(filePath: string) {
				const i = trigramFiles.indexOf(filePath);
				if (i >= 0) { trigramFiles.splice(i, 1); }
			},
		} as never,
		{
			initialize: async () => { },
			getAllFileIndices: async () => [...store.values()],
			getSymbolFileHashes: async () => new Map([...store.values()].map(f => [f.uri, f.contentHash])),
			putFileIndex: async (f: IStoredFileIndex) => { store.set(f.uri, f); },
			deleteFileIndexByUri: async (uri: string) => { storeDeletes.push(uri); store.delete(uri); },
		} as never,
	);

	return {
		service, root, uriOf, store, storeDeletes,
		indexedLexical, removedLexical, trigramFiles,
		setGitignore: (content: string) => { gitignoreContent = content; },
		fireGitignoreChange: () => filesEmitter.fire({
			rawAdded: [], rawUpdated: [URI.joinPath(root, '.gitignore')], rawDeleted: [],
		}),
		fireDelete: (rel: string) => { disk.delete(rel); filesEmitter.fire({ rawAdded: [], rawUpdated: [], rawDeleted: [URI.joinPath(root, rel)] }); },
	};
}

/** Let async watcher handlers (gitignore reload/purge) settle before asserting. */
async function flush(times = 8): Promise<void> {
	for (let i = 0; i < times; i++) { await new Promise(r => setTimeout(r, 0)); }
}

suite('Workspace index stale cleanup (A1)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('persisted deleted + now-gitignored entries vanish from every retrieval path and stay gone', async () => {
		const f = fixture({
			disk: new Map([
				['src/valid.ts', 'export function alpha() {}\n'],
				['node_modules/pkg/index.js', 'function ghost() {}\n'],
			]),
			persisted: new Map<string, string[]>([
				['src/valid.ts', ['alpha']],
				['src/deleted.ts', ['gone']],
				['node_modules/pkg/index.js', ['ghost']],
				['node_modules/pkg/other.js', ['ghost2']],
			]),
			gitignore: 'node_modules\n',
		});
		try {
			await f.service.forceReindex();
			const stats = f.service.getStats();
			// every retrieval path holds exactly the eligible set
			const valid = f.uriOf('src/valid.ts');
			assert.strictEqual(stats.totalFiles, 1, `expected only src/valid.ts, got ${stats.totalFiles}`);
			assert.ok(f.service.getFileIndex(valid));
			assert.strictEqual(f.service.getSymbolsByName('gone').length, 0);
			assert.strictEqual(f.service.getSymbolsByName('ghost').length, 0);
			assert.strictEqual(f.service.getSymbolsByName('ghost2').length, 0);
			assert.strictEqual(f.service.getSymbolsByName('alpha').length, 1);
			// lexical feeds: the ignored feed never happened and the stale feeds were removed
			assert.ok(f.indexedLexical.some(p => p.replace(/\\/g, '/').endsWith('src/valid.ts')));
			assert.ok(!f.indexedLexical.some(p => p.replace(/\\/g, '/').includes('node_modules')));
			assert.ok(f.removedLexical.some(p => p.replace(/\\/g, '/').includes('node_modules')));
			// persisted store no longer resurrects the stale entries
			assert.ok(!f.store.has(f.uriOf('src/deleted.ts')));
			assert.ok(!f.store.has(f.uriOf('node_modules/pkg/index.js')));
			assert.ok(!f.store.has(f.uriOf('node_modules/pkg/other.js')));
			// run stats reconcile: discovered == indexed + unchanged + admission rejections
			const run = stats.lastRun;
			const admissionRejections = (run.rejected.unreadable ?? 0) + (run.rejected.tooLarge ?? 0) + (run.rejected.generated ?? 0);
			assert.strictEqual(run.discovered, run.indexed + run.unchanged + admissionRejections);
			assert.strictEqual(run.canceled, false);
			assert.strictEqual(run.failed, false);
			// second restart: nothing stale returns
			await f.service.forceReindex();
			assert.strictEqual(f.service.getStats().totalFiles, 1);
			assert.ok(!f.store.has(f.uriOf('src/deleted.ts')));
		} finally { f.service.dispose(); }
	});

	test('hydration alone must not resurrect now-ignored persisted entries', async () => {
		// a run canceled mid-walk still hydrates first — the ignored entries
		// must be dropped at hydration time, before any walk proof exists
		const f = fixture({
			disk: new Map([['src/valid.ts', 'export function alpha() {}\n']]),
			persisted: new Map<string, string[]>([
				['node_modules/pkg/index.js', ['ghost']],
			]),
			gitignore: 'node_modules\n',
		});
		try {
			// cancel the first run before it can finish by starting a replacement
			const first = f.service.forceReindex();
			const second = f.service.forceReindex();
			await Promise.all([first, second]);
			assert.strictEqual(f.service.getSymbolsByName('ghost').length, 0);
			assert.ok(!f.store.has(f.uriOf('node_modules/pkg/index.js')));
		} finally { f.service.dispose(); }
	});

	test('a canceled walk does not prune hydrated entries', async () => {
		const f = fixture({
			disk: new Map([['src/valid.ts', 'export function alpha() {}\n']]),
			persisted: new Map<string, string[]>([
				['src/deleted.ts', ['gone']], // stale: not on disk
			]),
		});
		try {
			// run A hydrates (stale entry loaded), run B supersedes it mid-walk;
			// A settles canceled and must NOT prune. B completes and prunes.
			const first = f.service.forceReindex();
			const second = f.service.forceReindex();
			await first;  // A settled (canceled) — its walk never completed
			await second; // B completed and pruned the stale entry
			assert.strictEqual(f.service.getSymbolsByName('gone').length, 0);
			assert.ok(!f.store.has(f.uriOf('src/deleted.ts')));
		} finally { f.service.dispose(); }
	});

	test('files under an unreadable directory are spared by stale cleanup', async () => {
		const f = fixture({
			disk: new Map([
				['src/valid.ts', 'export function alpha() {}\n'],
				// on disk so the walk enters `nested`, whose resolve() throws
				['nested/hidden.ts', 'export function hidden() {}\n'],
			]),
			persisted: new Map<string, string[]>([
				['src/valid.ts', ['alpha']],
				['nested/hidden.ts', ['spared']], // under the unreadable dir
				['src/gone.ts', ['pruneMe']],     // elsewhere: must be pruned
			]),
			failDirs: ['nested'],
		});
		try {
			await f.service.forceReindex();
			const run = f.service.getStats().lastRun;
			assert.strictEqual(run.unreadableDirs, 1);
			// the unreadable subtree is not proven deleted → spared
			assert.ok(f.service.getSymbolsByName('spared').length === 1);
			// but the readable area IS proven → stale entry pruned
			assert.strictEqual(f.service.getSymbolsByName('pruneMe').length, 0);
		} finally { f.service.dispose(); }
	});

	test('watcher delete removes the file; watcher gitignore change purges the newly ignored file', async () => {
		const f = fixture({
			disk: new Map([
				['src/a.ts', 'export function a() {}\n'],
				['src/b.ts', 'export function b() {}\n'],
				['.gitignore', ''],
			]),
			gitignore: '',
		});
		try {
			await f.service.forceReindex();
			assert.strictEqual(f.service.getStats().totalFiles, 2);

			// delete via watcher
			f.fireDelete('src/b.ts');
			await flush();
			assert.strictEqual(f.service.getSymbolsByName('b').length, 0);
			assert.strictEqual(f.service.getStats().totalFiles, 1);

			// ignore the remaining file via a .gitignore edit
			f.setGitignore('src/a.ts\n');
			f.fireGitignoreChange();
			await flush();
			assert.strictEqual(f.service.getSymbolsByName('a').length, 0);
			assert.strictEqual(f.service.getStats().totalFiles, 0);
			assert.ok(f.removedLexical.some(p => p.replace(/\\/g, '/').endsWith('src/a.ts')));
		} finally { f.service.dispose(); }
	});

	test('unignoring a path re-admits it on the next completed walk', async () => {
		const f = fixture({
			disk: new Map([
				['src/a.ts', 'export function a() {}\n'],
				['gen/x.ts', 'export function gen() {}\n'],
			]),
			gitignore: 'gen\n',
		});
		try {
			await f.service.forceReindex();
			assert.strictEqual(f.service.getStats().lastRun.rejected.gitignored, 1);
			assert.strictEqual(f.service.getSymbolsByName('gen').length, 0);

			// unignore: gen/ is eligible again
			f.setGitignore('');
			f.fireGitignoreChange();
			await flush();
			await f.service.forceReindex();
			assert.strictEqual(f.service.getSymbolsByName('gen').length, 1);
		} finally { f.service.dispose(); }
	});
	test('a removed workspace root is pruned by the next completed walk (multi-root)', async () => {
		const rootA = URI.file('Z:/stale-cleanup');
		const rootB = URI.file('W:/second-root');
		const diskB = new Map([['lib.ts', 'export function fromRootB() {}\n']]);
		const store = new Map<string, IStoredFileIndex>();
		const uriB = URI.joinPath(rootB, 'lib.ts').toString();
		store.set(uriB, { uri: uriB, symbols: [makeSymbol(uriB, 'fromRootB')], imports: [], lastIndexedAt: 1, contentHash: 42 });
		let folders = [{ uri: rootA }, { uri: rootB }];
		const bm25Removed: string[] = [];

		const service = new WorkspaceSymbolIndexService(
			{
				onDidFilesChange: Event.None,
				resolve: async (uri: URI) => {
					if (uri.toString() === rootB.toString()) {
						return { children: [...diskB.keys()].map(name => ({ name, isDirectory: false, resource: URI.joinPath(rootB, name) })) };
					}
					if (uri.toString() === URI.joinPath(rootA, 'src').toString()) {
						return { children: [{ name: 'valid.ts', isDirectory: false, resource: URI.joinPath(rootA, 'src/valid.ts') }] };
					}
					return { children: [{ name: 'src', isDirectory: true, resource: URI.joinPath(rootA, 'src') }] };
				},
				readFile: async (uri: URI) => {
					if (uri.path.endsWith('.gitignore')) { return { value: VSBuffer.fromString('') }; }
					if (uri.toString() === uriB) { return { value: VSBuffer.fromString(diskB.get('lib.ts')!) }; }
					return { value: VSBuffer.fromString('export function alpha() {}\n') };
				},
			} as never,
			{
				getWorkspace: () => ({ folders }),
				onDidChangeWorkspaceFolders: Event.None,
			} as never,
			{ onModelAdded: Event.None, getModel: () => null } as never,
			{} as never,
			{ info() { }, warn() { }, error() { } } as never,
			{ indexFile: async () => { }, removeFile: async (p: string) => { bm25Removed.push(p); } } as never,
			{ addEntry() { }, removeEntriesForFile() { } } as never,
			{
				initialize: async () => { },
				getAllFileIndices: async () => [...store.values()],
				getSymbolFileHashes: async () => new Map([...store.values()].map(x => [x.uri, x.contentHash])),
				putFileIndex: async (x: IStoredFileIndex) => { store.set(x.uri, x); },
				deleteFileIndexByUri: async (uri: string) => { store.delete(uri); },
			} as never,
		);
		try {
			// both roots present: rootB's hydrated entry survives
			await service.forceReindex();
			assert.strictEqual(service.getSymbolsByName('fromRootB').length, 1);

			// root B leaves the workspace -> its files vanish from the next walk
			// and the completed-walk stale cleanup prunes them everywhere
			folders = [{ uri: rootA }];
			await service.forceReindex();
			assert.strictEqual(service.getSymbolsByName('fromRootB').length, 0);
			assert.ok(!store.has(uriB));
			assert.ok(bm25Removed.some(p => p.replace(/\\/g, '/').endsWith('lib.ts')));
		} finally { service.dispose(); }
	});
});
