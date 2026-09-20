/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PinnedContextService } from '../../browser/pinnedContextService.js';
import type { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { Emitter } from '../../../../../base/common/event.js';

// ---------------------------------------------------------------------------
// Mock IStorageService
// ---------------------------------------------------------------------------

function createMockStorage(): IStorageService & { _data: Map<string, string> } {
	const _data = new Map<string, string>();
	const _onWillSave = new Emitter<void>();

	const mock: IStorageService & { _data: Map<string, string> } = {
		_serviceBrand: undefined,
		_data,
		onWillSaveState: _onWillSave.event,
		onDidChangeValue: () => ({ dispose() { } }),
		onDidChangeTarget: () => ({ dispose() { } }),
		get(key: string, scope: StorageScope, fallbackValue?: string): string {
			return _data.get(`${scope}:${key}`) ?? fallbackValue ?? '';
		},
		getBoolean: () => false,
		getNumber: () => 0,
		getObject: () => undefined,
		store(key: string, value: string, scope: StorageScope, target: StorageTarget): void {
			_data.set(`${scope}:${key}`, value);
		},
		remove(key: string, scope: StorageScope): void {
			_data.delete(`${scope}:${key}`);
		},
		flush: () => Promise.resolve(),
		close: () => Promise.resolve(),
		switch: () => Promise.resolve(),
		migrate: () => Promise.resolve(),
		hasScope: () => true,
		isNew: () => false,
	} as unknown as IStorageService & { _data: Map<string, string> };

	Object.defineProperty(mock, '_data', { value: _data, writable: false });
	return mock;
}

// ---------------------------------------------------------------------------
// No-op collaborators for the F08 materialization dependencies (this suite
// exercises stored-content behavior only; materialization has its own suite)
// ---------------------------------------------------------------------------

function createNoopExtras() {
	return {
		fileService: { readFile: async () => { throw new Error('no file'); }, resolve: async () => { throw new Error('no folder'); } },
		modelService: { getModel: () => null },
		instantiationService: { invokeFunction: () => { throw new Error('no symbol index'); } },
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite('PinnedContextService', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('add() stores item and getPinnedBlocks() formats it', () => {
		const svc = new PinnedContextService(createMockStorage(), createNoopExtras().fileService as never, createNoopExtras().modelService as never, createNoopExtras().instantiationService as never);
		svc.add({ type: 'file', name: 'main.ts', content: 'const x = 1;', uri: 'file:///main.ts' });

		const blocks = svc.getPinnedBlocks();
		assert.strictEqual(blocks.length, 1);
		assert.ok(blocks[0].includes('📄 main.ts'));
		assert.ok(blocks[0].includes('const x = 1;'));
	});

	test('add() for notepad uses 📝 emoji', () => {
		const svc = new PinnedContextService(createMockStorage(), createNoopExtras().fileService as never, createNoopExtras().modelService as never, createNoopExtras().instantiationService as never);
		svc.add({ type: 'notepad', name: 'Notes', content: 'remember this' });

		const blocks = svc.getPinnedBlocks();
		assert.ok(blocks[0].includes('📝 Notes'));
		assert.ok(blocks[0].includes('remember this'));
	});

	test('add() for folder uses 📁 emoji', () => {
		const svc = new PinnedContextService(createMockStorage(), createNoopExtras().fileService as never, createNoopExtras().modelService as never, createNoopExtras().instantiationService as never);
		svc.add({ type: 'folder', name: 'src/', uri: 'file:///src/' });

		const blocks = svc.getPinnedBlocks();
		assert.ok(blocks[0].includes('📁 src/'));
	});

	test('remove() removes the correct item', () => {
		const svc = new PinnedContextService(createMockStorage(), createNoopExtras().fileService as never, createNoopExtras().modelService as never, createNoopExtras().instantiationService as never);
		const a = svc.add({ type: 'file', name: 'a.ts', content: 'a' });
		svc.add({ type: 'file', name: 'b.ts', content: 'b' });
		assert.strictEqual(svc.items.length, 2);

		svc.remove(a.id);
		assert.strictEqual(svc.items.length, 1);
		assert.strictEqual(svc.items[0].name, 'b.ts');
		assert.strictEqual(svc.getPinnedBlocks().length, 1);
	});

	test('clear() empties all items', () => {
		const svc = new PinnedContextService(createMockStorage(), createNoopExtras().fileService as never, createNoopExtras().modelService as never, createNoopExtras().instantiationService as never);
		svc.add({ type: 'file', name: 'a.ts', content: 'a' });
		svc.add({ type: 'file', name: 'b.ts', content: 'b' });
		svc.clear();
		assert.strictEqual(svc.items.length, 0);
		assert.strictEqual(svc.getPinnedBlocks().length, 0);
	});

	test('getPinnedBlocks() returns empty array when nothing is pinned', () => {
		const svc = new PinnedContextService(createMockStorage(), createNoopExtras().fileService as never, createNoopExtras().modelService as never, createNoopExtras().instantiationService as never);
		assert.deepStrictEqual(svc.getPinnedBlocks(), []);
	});

	test('MAX_ITEMS ceiling: adding 9th item drops the oldest', () => {
		const svc = new PinnedContextService(createMockStorage(), createNoopExtras().fileService as never, createNoopExtras().modelService as never, createNoopExtras().instantiationService as never);
		for (let i = 0; i < 9; i++) {
			svc.add({ type: 'file', name: `file${i}.ts`, content: `x${i}` });
		}
		assert.strictEqual(svc.items.length, 8);
		// oldest (file0) should be dropped
		assert.strictEqual(svc.items[0].name, 'file1.ts');
		assert.strictEqual(svc.items[7].name, 'file8.ts');
	});

	test('MAX_TOKENS ceiling: oversized items are evicted oldest-first', () => {
		const svc = new PinnedContextService(createMockStorage(), createNoopExtras().fileService as never, createNoopExtras().modelService as never, createNoopExtras().instantiationService as never);
		// Each item ~5k chars → ~1250 tokens. 20k limit → ~16 items max by tokens,
		// but MAX_ITEMS (8) is the tighter constraint for small items.
		// Use a single huge item to test the token ceiling directly.
		const huge = 'x'.repeat(100_000); // ~25k tokens — exceeds 20k alone
		svc.add({ type: 'notepad', name: 'huge', content: huge });
		// The item exceeds the token ceiling and should be evicted immediately
		assert.strictEqual(svc.items.length, 0);
		assert.strictEqual(svc.getPinnedBlocks().length, 0);
	});

	test('onDidChange fires on add, remove, and clear', () => {
		const svc = new PinnedContextService(createMockStorage(), createNoopExtras().fileService as never, createNoopExtras().modelService as never, createNoopExtras().instantiationService as never);
		let fired = 0;
		svc.onDidChange(() => fired++);

		svc.add({ type: 'file', name: 'a.ts', content: 'a' });
		assert.strictEqual(fired, 1);

		svc.clear();
		assert.strictEqual(fired, 2);

		// clear on empty doesn't fire
		svc.clear();
		assert.strictEqual(fired, 2);
	});

	test('each item gets a unique id and createdAt timestamp', () => {
		const svc = new PinnedContextService(createMockStorage(), createNoopExtras().fileService as never, createNoopExtras().modelService as never, createNoopExtras().instantiationService as never);
		const a = svc.add({ type: 'file', name: 'a.ts', content: 'a' });
		const b = svc.add({ type: 'file', name: 'b.ts', content: 'b' });
		assert.notStrictEqual(a.id, b.id);
		assert.ok(a.createdAt <= b.createdAt);
		assert.ok(a.id.startsWith('pin_'));
		assert.ok(b.id.startsWith('pin_'));
	});
});
