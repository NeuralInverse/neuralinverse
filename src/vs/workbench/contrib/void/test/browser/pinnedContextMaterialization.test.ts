/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileOperationError, FileOperationResult } from '../../../../../platform/files/common/files.js';
import { PinnedContextService, pinTargetToUri } from '../../browser/pinnedContextService.js';

function fakeServices(filesOnDisk: Record<string, string>, openModels: Record<string, string> = {}) {
	const storage = new Map<string, string>();
	const storageService = {
		get: (k: string) => storage.get(k),
		store: (k: string, v: string) => { storage.set(k, v); },
		onWillSaveState: Event.None,
	};
	const fileService = {
		readFile: async (uri: URI) => {
			const content = filesOnDisk[uri.toString()];
			if (content === undefined) { throw new FileOperationError('FileNotFound', FileOperationResult.FILE_NOT_FOUND); }
			return { value: VSBuffer.fromString(content) };
		},
		resolve: async (uri: URI) => {
			if (uri.toString() === 'file:///ws/folder') {
				return { children: [{ name: 'a.ts', isDirectory: false, resource: URI.file('/ws/folder/a.ts') }, { name: 'b.ts', isDirectory: false, resource: URI.file('/ws/folder/b.ts') }] };
			}
			throw new FileOperationError('FileNotFound', FileOperationResult.FILE_NOT_FOUND);
		},
	};
	const modelService = {
		getModel: (uri: URI) => openModels[uri.toString()] !== undefined
			? { getValue: () => openModels[uri.toString()] }
			: null,
	};
	const symbolIndex = {
		getSymbolsByName: (name: string) => name === 'renderCard'
			? [{ name: 'renderCard', kind: 12, filePath: 'file:///ws/products.html', range: { startLine: 2, endLine: 3 } }]
			: [],
		getSymbolsInFile: (uri: string) => (symbolFiles.get(uri) ?? []).filter(s => s.name !== '__removed__'),
		getFileIndex: (uri: string) => symbolFiles.has(uri) ? { uri } : undefined,
	};
	// per-fixture symbol tables for identity-bound symbol pins (A2); tests can
	// mutate this map to simulate reindex/rename/delete
	const symbolFiles = new Map<string, Array<{ name: string; kind: number; filePath: string; range: { startLine: number; endLine: number } }>>();
	const instantiationService = {
		// the production helper dynamic-imports the decorator module and calls
		// accessor.get — the fake returns our symbol index regardless
		invokeFunction: (fn: (accessor: { get: () => unknown }) => unknown) => fn({ get: () => symbolIndex }),
	};
	return { storageService, fileService, modelService, instantiationService, storage, symbolFiles };
}

function makeService(filesOnDisk: Record<string, string>, openModels: Record<string, string> = {}) {
	const f = fakeServices(filesOnDisk, openModels);
	return {
		storage: f.storage,
		service: new PinnedContextService(f.storageService as never, f.fileService as never, f.modelService as never, f.instantiationService as never),
		symbolFiles: f.symbolFiles,
	};
}

suite('Pinned context materialization (F08) — real service, fake IO', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a URI-only file pin reads its content from disk', async () => {
		const { service } = makeService({ 'file:///ws/products.html': '<div>card</div>' });
		try {
			service.add({ type: 'file', uri: 'file:///ws/products.html', name: 'products.html' });
			const blocks = await service.materializePinnedBlocks();
			assert.strictEqual(blocks.length, 1);
			assert.ok(blocks[0].includes('products.html'));
			assert.ok(blocks[0].includes('<div>card</div>'), 'URI-only pins must carry real content');
		} finally { service.dispose(); }
	});

	test('an unsaved editor model wins over the disk content', async () => {
		const { service } = makeService(
			{ 'file:///ws/products.html': 'DISK VERSION' },
			{ 'file:///ws/products.html': 'UNSAVED EDITOR VERSION' },
		);
		try {
			service.add({ type: 'file', uri: 'file:///ws/products.html', name: 'products.html' });
			const blocks = await service.materializePinnedBlocks();
			assert.ok(blocks[0].includes('UNSAVED EDITOR VERSION'));
			assert.ok(!blocks[0].includes('DISK VERSION'));
		} finally { service.dispose(); }
	});

	test('deleted files, ranges, folders and symbols report visibly and with content', async () => {
		const { service } = makeService({
			'file:///ws/gone.ts': 'was here',
			'file:///ws/with-range.ts': 'l1\nl2\nl3\nl4\nl5',
		});
		try {
			service.add({ type: 'file', uri: 'file:///ws/deleted.ts', name: 'deleted.ts' });        // not on disk
			service.add({ type: 'range', uri: 'file:///ws/with-range.ts', name: 'with-range.ts', range: { startLine: 2, endLine: 4 } });
			service.add({ type: 'folder', uri: 'file:///ws/folder', name: 'folder' });
			service.add({ type: 'symbol', name: 'renderCard', symbol: 'renderCard' });
			const blocks = await service.materializePinnedBlocks();
			assert.strictEqual(blocks.length, 4);
			assert.match(blocks[0], /pinned file no longer exists: file:\/\/\/ws\/deleted\.ts/);
			assert.ok(blocks[1].includes('l2\nl3\nl4'), 'range pin materializes the requested lines');
			assert.ok(blocks[2].includes('a.ts') && blocks[2].includes('b.ts'), 'folder pin lists its files');
			assert.ok(blocks[3].includes('products.html'), 'symbol pin resolves through the index');
		} finally { service.dispose(); }
	});
});

// ---------------------------------------------------------------------------
// Pin target contract (pin-budget followup §2): the canonical storage form is
// `uri.toString()`; legacy raw OS paths hydrate at read time without re-pinning;
// read failures are classified instead of all reading as "no longer exists".
// ---------------------------------------------------------------------------

suite('Pin target URI contract — pinTargetToUri shape rules', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Windows drive paths become file URIs, never scheme "c:"', () => {
		const uri = pinTargetToUri('c:\\Users\\fixture-user\\Desktop\\sample-project\\public\\products.html');
		assert.ok(uri, 'drive-letter path must resolve');
		assert.strictEqual(uri.scheme, 'file');
		assert.strictEqual(uri.authority, '');
		assert.strictEqual(uri.fsPath, 'c:\\Users\\fixture-user\\Desktop\\sample-project\\public\\products.html');
	});

	test('forward-slash and bare drive forms are also Windows drives', () => {
		assert.strictEqual(pinTargetToUri('c:/Users/fixture-user/x.html')?.toString(), 'file:///c%3A/Users/fixture-user/x.html');
		assert.strictEqual(pinTargetToUri('c:')?.toString(), 'file:///c%3A');
	});

	test('UNC shares keep the host as the authority', () => {
		const uri = pinTargetToUri('\\\\server\\share\\file.txt');
		assert.ok(uri);
		assert.strictEqual(uri.scheme, 'file');
		assert.strictEqual(uri.authority, 'server');
		assert.strictEqual(uri.path, '/share/file.txt');
	});

	test('POSIX absolute paths become file URIs', () => {
		assert.strictEqual(pinTargetToUri('/home/user/file.txt')?.toString(), 'file:///home/user/file.txt');
	});

	test('URIs round-trip untouched — scheme and authority preserved', () => {
		assert.strictEqual(pinTargetToUri('file:///c%3A/Users/fixture-user/x.html')?.toString(), 'file:///c%3A/Users/fixture-user/x.html');
		assert.strictEqual(pinTargetToUri('file://server/share/f.txt')?.toString(), 'file://server/share/f.txt');
		assert.strictEqual(pinTargetToUri('untitled:Untitled-1')?.toString(), 'untitled:Untitled-1');
		assert.strictEqual(pinTargetToUri('vscode-webview://xyz/view.html')?.toString(), 'vscode-webview://xyz/view.html');
		// a URI with a fragment: `toString()` canonicalizes the fragment body,
		// and pins store `toString()` — so hydration sees the canonical form
		assert.strictEqual(pinTargetToUri('https://example.com/a#b%3Fs%3D1')?.toString(), 'https://example.com/a#b%3Fs%3D1');
	});

	test('empty or whitespace-only targets are invalid', () => {
		assert.strictEqual(pinTargetToUri(''), undefined);
		assert.strictEqual(pinTargetToUri('   '), undefined);
	});

	test('stored targets are trimmed before resolution', () => {
		assert.strictEqual(pinTargetToUri('  file:///ws/x.ts  ')?.toString(), 'file:///ws/x.ts');
	});
});

suite('Legacy pin hydration — raw-path pins read like new ones', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a legacy Windows fsPath file pin reads its content from disk', async () => {
		const { service } = makeService({
			'file:///c%3A/Users/fixture-user/Desktop/sample-project/public/products.html': '<div>card</div>',
		});
		try {
			service.add({ type: 'file', uri: 'c:\\Users\\fixture-user\\Desktop\\sample-project\\public\\products.html', name: 'products.html' });
			const blocks = await service.materializePinnedBlocks();
			assert.strictEqual(blocks.length, 1);
			assert.ok(blocks[0].includes('<div>card</div>'), 'legacy fsPath pin must carry real content');
		} finally { service.dispose(); }
	});

	test('a legacy Windows fsPath pin finds the open model by the resolved URI (unsaved wins)', async () => {
		const { service } = makeService(
			{ 'file:///c%3A/Users/fixture-user/Desktop/sample-project/public/products.html': 'DISK VERSION' },
			{ 'file:///c%3A/Users/fixture-user/Desktop/sample-project/public/products.html': 'UNSAVED EDITOR VERSION' },
		);
		try {
			service.add({ type: 'file', uri: 'c:\\Users\\fixture-user\\Desktop\\sample-project\\public\\products.html', name: 'products.html' });
			const blocks = await service.materializePinnedBlocks();
			assert.ok(blocks[0].includes('UNSAVED EDITOR VERSION'));
			assert.ok(!blocks[0].includes('DISK VERSION'));
		} finally { service.dispose(); }
	});

	test('a legacy UNC pin reads through the share authority', async () => {
		const { service } = makeService({ 'file://server/share/file.txt': 'unc content' });
		try {
			service.add({ type: 'file', uri: '\\\\server\\share\\file.txt', name: 'file.txt' });
			const blocks = await service.materializePinnedBlocks();
			assert.ok(blocks[0].includes('unc content'));
		} finally { service.dispose(); }
	});

	test('canonical URIs with spaces, Persian characters and % work verbatim', async () => {
		const uriStr = 'file:///c%3A/Users/fixture-user/Desktop/%D8%AA%D8%B3%DA%A9/file%20with%20space.txt';
		const { service } = makeService({ [uriStr]: 'encoded target content' });
		try {
			service.add({ type: 'file', uri: uriStr, name: 'file with space.txt' });
			const blocks = await service.materializePinnedBlocks();
			assert.ok(blocks[0].includes('encoded target content'));
		} finally { service.dispose(); }
	});

	test('a non-file URI pin reads its open model and is never rewritten to file', async () => {
		const { service } = makeService(
			{},
			{ 'untitled:Untitled-1': 'unsaved scratch content' },
		);
		try {
			service.add({ type: 'file', uri: 'untitled:Untitled-1', name: 'Untitled-1' });
			const blocks = await service.materializePinnedBlocks();
			assert.ok(blocks[0].includes('unsaved scratch content'));
		} finally { service.dispose(); }
	});

	test('a legacy POSIX folder pin lists its children', async () => {
		const { service } = makeService({});
		try {
			service.add({ type: 'folder', uri: '/ws/folder', name: 'folder' });
			const blocks = await service.materializePinnedBlocks();
			assert.ok(blocks[0].includes('a.ts') && blocks[0].includes('b.ts'));
		} finally { service.dispose(); }
	});

	test('range and symbol pins keep their scope through materialization', async () => {
		const { service } = makeService({
			'file:///ws/with-range.ts': 'l1\nl2\nl3\nl4\nl5',
			'file:///ws/products.html': 'x\nfunction renderCard() {}\ny\n',
		});
		try {
			service.add({ type: 'range', uri: 'file:///ws/with-range.ts', name: 'with-range.ts', range: { startLine: 2, endLine: 3 } });
			service.add({ type: 'symbol', name: 'renderCard', symbol: 'renderCard' });
			const blocks = await service.materializePinnedBlocks();
			assert.strictEqual(blocks.length, 2);
			assert.match(blocks[0], /lines 2-3/);
			assert.ok(blocks[0].includes('l2\nl3') && !blocks[0].includes('l4'), 'range pin keeps its exact 1-based line window');
			assert.ok(blocks[1].includes('renderCard @ file:///ws/products.html:2-3'), 'symbol pin reports the defining file and range');
		} finally { service.dispose(); }
	});
});

suite('Pin read-error taxonomy — missing ≠ denied ≠ too large ≠ unreadable', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function makeFailingService(readError: unknown, target = 'file:///ws/locked.ts') {
		const f = fakeServices({}, {});
		f.fileService.readFile = async () => { throw readError; };
		const service = new PinnedContextService(f.storageService as never, f.fileService as never, f.modelService as never, f.instantiationService as never);
		service.add({ type: 'file', uri: target, name: 'locked.ts' });
		return service;
	}

	test('FILE_NOT_FOUND still reads as "no longer exists"', async () => {
		const service = makeFailingService(new FileOperationError('FileNotFound', FileOperationResult.FILE_NOT_FOUND));
		try {
			const blocks = await service.materializePinnedBlocks();
			assert.match(blocks[0], /pinned file no longer exists: file:\/\/\/ws\/locked\.ts/);
		} finally { service.dispose(); }
	});

	test('FILE_PERMISSION_DENIED reads as "not accessible", not missing', async () => {
		const service = makeFailingService(new FileOperationError('EACCES', FileOperationResult.FILE_PERMISSION_DENIED));
		try {
			const blocks = await service.materializePinnedBlocks();
			assert.match(blocks[0], /pinned file is not accessible: file:\/\/\/ws\/locked\.ts/);
			assert.ok(!blocks[0].includes('no longer exists'));
		} finally { service.dispose(); }
	});

	test('FILE_TOO_LARGE reads as "exceeds the pin size limit"', async () => {
		const service = makeFailingService(new FileOperationError('too large', FileOperationResult.FILE_TOO_LARGE));
		try {
			const blocks = await service.materializePinnedBlocks();
			assert.match(blocks[0], /pinned file exceeds the pin size limit: file:\/\/\/ws\/locked\.ts/);
		} finally { service.dispose(); }
	});

	test('unknown errors keep their message instead of masquerading as missing', async () => {
		const service = makeFailingService(new Error('boom'));
		try {
			const blocks = await service.materializePinnedBlocks();
			assert.match(blocks[0], /pinned file could not be read \(boom\): file:\/\/\/ws\/locked\.ts/);
			assert.ok(!blocks[0].includes('no longer exists'));
		} finally { service.dispose(); }
	});

	test('an unparseable target is reported as invalid, not missing', async () => {
		const { service } = makeService({});
		try {
			// a pin whose stored uri cannot be resolved to any URI shape
			service.add({ type: 'file', uri: ' ', name: 'broken' });
			const blocks = await service.materializePinnedBlocks();
			assert.match(blocks[0], /pin target is not a valid path or URI/);
		} finally { service.dispose(); }
	});
});

// ---------------------------------------------------------------------------
// Symbol pin identity (A2): a uri-bound symbol pin resolves ONLY inside the
// pinned file; same-name symbols elsewhere never leak in. Rename/delete of the
// definition and a stale index have defined, visible outcomes.
// ---------------------------------------------------------------------------

suite('Symbol pin identity — same-name isolation and lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const fileA = 'file:///ws/pricing.ts';
	const fileB = 'file:///ws/shipping.ts';
	const contentA = 'export function computeTotal() {\n\treturn "MARKER-PRICING-91";\n}\n';
	const contentB = 'export function computeTotal() {\n\treturn "MARKER-SHIPPING-44";\n}\n';

	function makeSymbolService() {
		const made = makeService({ [fileA]: contentA, [fileB]: contentB });
		made.symbolFiles.set(fileA, [{ name: 'computeTotal', kind: 12, filePath: fileA, range: { startLine: 1, endLine: 3 } }]);
		made.symbolFiles.set(fileB, [{ name: 'computeTotal', kind: 12, filePath: fileB, range: { startLine: 1, endLine: 3 } }]);
		return made;
	}

	test('a uri-bound pin carries ONLY the selected file\'s same-name symbol', async () => {
		const { service } = makeSymbolService();
		try {
			service.add({ type: 'symbol', uri: fileA, symbol: 'computeTotal', name: 'computeTotal', range: { startLine: 1, endLine: 3 } });
			const blocks = await service.materializePinnedBlocks();
			assert.strictEqual(blocks.length, 1);
			assert.ok(blocks[0].includes('MARKER-PRICING-91'), 'the pinned file\'s definition must be present');
			assert.ok(!blocks[0].includes('MARKER-SHIPPING-44'), 'the same-name symbol in another file must NOT leak in');
			assert.ok(blocks[0].includes(`${fileA}:1-3`));
		} finally { service.dispose(); }
	});

	test('renaming/removing the definition reports a re-pin hint instead of guessing by name', async () => {
		const { service, symbolFiles } = makeSymbolService();
		try {
			// the definition disappears from file A (renamed/deleted); file B
			// still defines the same name — it must NOT be used as a substitute
			symbolFiles.set(fileA, []);
			service.add({ type: 'symbol', uri: fileA, symbol: 'computeTotal', name: 'computeTotal' });
			const blocks = await service.materializePinnedBlocks();
			assert.match(blocks[0], /no longer defined in .*pricing\.ts.*Re-pin/);
			assert.ok(!blocks[0].includes('MARKER-SHIPPING-44'), 'the other file\'s symbol must not substitute');
		} finally { service.dispose(); }
	});

	test('an edit that moved the body re-resolves to the FRESH index range', async () => {
		const { service, symbolFiles } = makeSymbolService();
		try {
			// pin-time range 1-3; the reindexed definition now sits at 3-5 with
			// a new header line — the current index range wins
			symbolFiles.set(fileA, [{ name: 'computeTotal', kind: 12, filePath: fileA, range: { startLine: 2, endLine: 4 } }]);
			service.add({ type: 'symbol', uri: fileA, symbol: 'computeTotal', name: 'computeTotal', range: { startLine: 1, endLine: 3 } });
			const blocks = await service.materializePinnedBlocks();
			assert.ok(blocks[0].includes(`${fileA}:2-4`), 'materialization must use the fresh index range');
		} finally { service.dispose(); }
	});

	test('an unindexed file falls back to the pin-time range, visibly annotated', async () => {
		const { service, symbolFiles } = makeSymbolService();
		try {
			// the index never saw the file (getFileIndex undefined) but the
			// pin recorded its range — fallback must carry that exact window
			symbolFiles.delete(fileA);
			service.add({ type: 'symbol', uri: fileA, symbol: 'computeTotal', name: 'computeTotal', range: { startLine: 2, endLine: 3 } });
			const blocks = await service.materializePinnedBlocks();
			assert.match(blocks[0], /pinned range 2-3; file not in the workspace index/);
			assert.ok(blocks[0].includes('return "MARKER-PRICING-91";'), 'fallback reads the pin-time line window');
		} finally { service.dispose(); }
	});

	test('a deleted pinned symbol file reports the missing-file outcome', async () => {
		const made = makeService({ [fileB]: contentB });
		made.symbolFiles.set(fileA, [{ name: 'computeTotal', kind: 12, filePath: fileA, range: { startLine: 1, endLine: 3 } }]);
		try {
			// file A is on disk in this fixture? no — makeService got only fileB
			made.service.add({ type: 'symbol', uri: fileA, symbol: 'computeTotal', name: 'computeTotal' });
			const blocks = await made.service.materializePinnedBlocks();
			assert.ok(
				blocks[0].includes('no longer exists') || blocks[0].includes('no longer defined'),
				`expected a visible missing outcome, got: ${blocks[0]}`
			);
		} finally { made.service.dispose(); }
	});
});
