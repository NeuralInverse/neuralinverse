/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
import assert from 'assert';
import { Event } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { WorkspaceSymbolIndexService } from '../../../browser/context/index/workspaceSymbolIndex.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(r => { resolve = r; });
	return { promise, resolve };
}

function fixture(options: { beforeHashes?: () => Promise<void>; failWorkspace?: boolean; brokenFile?: string } = {}) {
	const root = URI.file('Z:/index-lifecycle');
	const files = new Map([
		['products.html', '<main>Product cards</main>'],
		['styles.css', '.product { display: grid; }'],
		['README.md', 'Product catalogue conventions'],
	]);
	if (options.brokenFile) { files.set(options.brokenFile, 'never read'); }
	const indexed: string[] = [];
	const service = new WorkspaceSymbolIndexService(
		{
			onDidFilesChange: Event.None,
			resolve: async () => ({ children: [...files.keys()].map(name => ({ name, isDirectory: false, resource: URI.joinPath(root, name) })) }),
			readFile: async (uri: URI) => {
				const name = uri.path.split('/').pop()!;
				if (name === options.brokenFile) { throw new Error('simulated read failure'); }
				const content = files.get(name);
				if (content === undefined) { throw new Error('not found'); }
				return { value: VSBuffer.fromString(content) };
			},
		} as never,
			{
				getWorkspace: () => {
					if (options.failWorkspace) { throw new Error('workspace unavailable'); }
					return { folders: [{ uri: root }] };
				},
				onDidChangeWorkspaceFolders: Event.None,
			} as never,
		{ onModelAdded: Event.None, getModel: () => null } as never,
		{} as never,
		{ info() { }, warn() { }, error() { } } as never,
		{ indexFile: async (path: string) => { indexed.push(path); }, removeFile: async () => { } } as never,
		{ addEntry() { }, removeEntriesForFile() { } } as never,
		{
			initialize: async () => { }, getAllFileIndices: async () => [],
			getSymbolFileHashes: async () => { await options.beforeHashes?.(); return new Map(); },
			putFileIndex: async () => { },
		} as never,
	);
	return { service, indexed };
}

suite('Workspace index lifecycle — real service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('completion observers see idle and HTML/CSS/docs reach the text index', async () => {
		const { service, indexed } = fixture();
		const observed: boolean[] = [];
		const listener = service.onDidFinishFullIndex(() => observed.push(service.getStats().indexingInProgress));
		try {
			await service.forceReindex();
			assert.deepStrictEqual(observed, [false]);
			assert.strictEqual(service.isReady(), true);
			assert.deepStrictEqual(indexed.map(p => p.replace(/\\/g, '/').split('/').pop()).sort(), ['README.md', 'products.html', 'styles.css']);
		} finally { listener.dispose(); service.dispose(); }
	});

	test('failure settles the busy indicator without declaring the service ready', async () => {
		const { service } = fixture({ failWorkspace: true });
		const observed: boolean[] = [];
		const listener = service.onDidFinishFullIndex(() => observed.push(service.getStats().indexingInProgress));
		try {
			await service.forceReindex();
			assert.deepStrictEqual(observed, [false]);
			assert.strictEqual(service.isReady(), false);
			assert.strictEqual(service.getStats().lastRun.failed, true);
			assert.match(service.getStats().lastRun.error ?? '', /workspace unavailable/);
		} finally { listener.dispose(); service.dispose(); }
	});

	test('run stats count discovered/indexed files and name the rejection reason', async () => {
		const { service } = fixture({ brokenFile: 'unreadable.css' });
		let started = 0;
		const startListener = service.onDidStartFullIndex(() => started++);
		try {
			await service.forceReindex();
			assert.strictEqual(started, 1);
			const run = service.getStats().lastRun;
			assert.strictEqual(run.failed, false);
			assert.strictEqual(run.discovered, 4);
			assert.strictEqual(run.indexed, 3);
			assert.strictEqual(run.rejected.unreadable, 1);
			assert.strictEqual(run.unchanged, 0);
		} finally { startListener.dispose(); service.dispose(); }
	});

	test('a cancelled older run cannot clear the replacement run busy flag', async () => {
		const entered = [deferred(), deferred()];
		const released = [deferred(), deferred()];
		let calls = 0;
		const { service } = fixture({
			beforeHashes: async () => {
				const i = calls++;
				entered[i].resolve();
				await released[i].promise;
			}
		});
		const observed: boolean[] = [];
		const listener = service.onDidFinishFullIndex(() => observed.push(service.getStats().indexingInProgress));
		try {
			const first = service.forceReindex();
			await entered[0].promise;
			const second = service.forceReindex();
			await entered[1].promise;
			released[0].resolve();
			await first;
			assert.strictEqual(service.getStats().indexingInProgress, true);
			assert.deepStrictEqual(observed, []);
			released[1].resolve();
			await second;
			assert.deepStrictEqual(observed, [false]);
		} finally { released.forEach(g => g.resolve()); listener.dispose(); service.dispose(); }
	});
});
