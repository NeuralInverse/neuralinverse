/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { executeGetImportGraph } from '../../../../browser/context/tools/getImportGraphTool.js';
import { IWorkspaceSymbolIndexService } from '../../../../browser/context/index/workspaceSymbolIndex.js';

// ─── Stub ─────────────────────────────────────────────────────────────────────

interface IImportStubs {
	imports?: string[];
	importers?: string[];
	transitiveImports?: string[];
	transitiveDependents?: string[];
	throwImports?: boolean;
	throwImporters?: boolean;
	ready?: boolean;
}

function makeIndex(stubs: IImportStubs = {}): IWorkspaceSymbolIndexService {
	const {
		imports = [],
		importers = [],
		transitiveImports = [],
		transitiveDependents = [],
		throwImports = false,
		throwImporters = false,
		ready = true,
	} = stubs;

	return {
		_serviceBrand: undefined as any,
		onDidReindex: { event: () => {} } as any,
		onDidFinishFullIndex: { event: () => {} } as any,
		isReady: () => ready,
		getSymbolsByName: () => [],
		getSymbolsInFile: () => [],
		getImports: () => { if (throwImports) { throw new Error('imports error'); } return imports; },
		getImporters: () => { if (throwImporters) { throw new Error('importers error'); } return importers; },
		getTransitiveImports: () => { if (throwImports) { throw new Error('transitive imports error'); } return transitiveImports; },
		getTransitiveDependents: () => { if (throwImporters) { throw new Error('transitive deps error'); } return transitiveDependents; },
		getFileIndex: () => undefined,
		getStats: () => ({ totalFiles: 0, totalSymbols: 0, indexingInProgress: false }),
		forceReindex: async () => {},
	};
}

const WS = 'file:///workspace';

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('executeGetImportGraph — guard: empty file', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns empty result when file is empty string', () => {
		const result = executeGetImportGraph({ file: '' }, makeIndex(), WS);
		assert.strictEqual(result.file, '');
		assert.deepStrictEqual(result.imports, []);
		assert.deepStrictEqual(result.importers, []);
	});

	test('returns empty result when file is whitespace only', () => {
		const result = executeGetImportGraph({ file: '   ' }, makeIndex(), WS);
		assert.strictEqual(result.file, '');
		assert.deepStrictEqual(result.imports, []);
		assert.deepStrictEqual(result.importers, []);
	});
});

suite('executeGetImportGraph — index not ready', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns empty imports/importers when index is not ready', () => {
		const idx = makeIndex({ ready: false, imports: ['file:///workspace/other.ts'] });
		const result = executeGetImportGraph({ file: 'src/main.ts' }, idx, WS);
		assert.strictEqual(result.file, 'src/main.ts');
		assert.deepStrictEqual(result.imports, []);
		assert.deepStrictEqual(result.importers, []);
	});
});

suite('executeGetImportGraph — basic results', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns imports and importers for a file', () => {
		const imports = [`${WS}/src/a.ts`, `${WS}/src/b.ts`];
		const importers = [`${WS}/src/main.ts`];
		const idx = makeIndex({ imports, importers });

		const result = executeGetImportGraph({ file: 'src/service.ts' }, idx, WS);
		assert.strictEqual(result.file, 'src/service.ts');
		assert.deepStrictEqual(result.imports, imports);
		assert.deepStrictEqual(result.importers, importers);
	});

	test('returns empty arrays when file has no imports or importers', () => {
		const idx = makeIndex({ imports: [], importers: [] });
		const result = executeGetImportGraph({ file: 'src/isolated.ts' }, idx, WS);
		assert.deepStrictEqual(result.imports, []);
		assert.deepStrictEqual(result.importers, []);
	});

	test('preserves original file arg in result', () => {
		const result = executeGetImportGraph({ file: 'src/service.ts' }, makeIndex(), WS);
		assert.strictEqual(result.file, 'src/service.ts');
	});
});

suite('executeGetImportGraph — depth clamping', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('depth defaults to 1 (calls getImports, not getTransitiveImports)', () => {
		let calledTransitive = false;
		let calledDirect = false;
		const idx: IWorkspaceSymbolIndexService = {
			...makeIndex(),
			getImports: () => { calledDirect = true; return []; },
			getTransitiveImports: () => { calledTransitive = true; return []; },
			getImporters: () => { return []; },
			getTransitiveDependents: () => { return []; },
		};
		executeGetImportGraph({ file: 'src/a.ts' }, idx, WS);
		assert.ok(calledDirect, 'should call getImports (depth=1)');
		assert.ok(!calledTransitive, 'should NOT call getTransitiveImports (depth=1)');
	});

	test('depth=2 calls getTransitiveImports instead of getImports', () => {
		let calledTransitive = false;
		let calledDirect = false;
		const idx: IWorkspaceSymbolIndexService = {
			...makeIndex({ transitiveImports: [`${WS}/deep.ts`], transitiveDependents: [] }),
			getImports: () => { calledDirect = true; return []; },
			getTransitiveImports: () => { calledTransitive = true; return [`${WS}/deep.ts`]; },
			getImporters: () => [],
			getTransitiveDependents: () => [],
		};
		const result = executeGetImportGraph({ file: 'src/a.ts', depth: 2 }, idx, WS);
		assert.ok(calledTransitive, 'should call getTransitiveImports (depth=2)');
		assert.ok(!calledDirect, 'should NOT call getImports (depth=2)');
		assert.ok(result.imports.includes(`${WS}/deep.ts`));
	});

	test('depth below 1 is clamped to 1', () => {
		let calledDirect = false;
		const idx: IWorkspaceSymbolIndexService = {
			...makeIndex(),
			getImports: () => { calledDirect = true; return []; },
			getTransitiveImports: () => [],
			getImporters: () => [],
			getTransitiveDependents: () => [],
		};
		executeGetImportGraph({ file: 'src/a.ts', depth: -5 }, idx, WS);
		assert.ok(calledDirect, 'depth < 1 should be clamped to 1');
	});

	test('depth above 3 is clamped to 3', () => {
		let receivedDepth: number | undefined;
		const idx: IWorkspaceSymbolIndexService = {
			...makeIndex(),
			getImports: () => [],
			getTransitiveImports: (_, depth) => { receivedDepth = depth; return []; },
			getImporters: () => [],
			getTransitiveDependents: () => [],
		};
		executeGetImportGraph({ file: 'src/a.ts', depth: 99 }, idx, WS);
		// depth > 1 → transitive path; depth clamped to 3
		assert.strictEqual(receivedDepth, 3);
	});
});

suite('executeGetImportGraph — URI normalization', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('strips leading slash from file path before calling index', () => {
		let receivedUri: string | undefined;
		const idx: IWorkspaceSymbolIndexService = {
			...makeIndex(),
			getImports: (uri) => { receivedUri = uri; return []; },
			getImporters: () => [],
		};
		executeGetImportGraph({ file: '/src/auth.ts' }, idx, WS);
		assert.ok(receivedUri);
		assert.ok(!receivedUri.includes('//src'), 'should not have double slash');
		assert.ok(receivedUri.endsWith('/src/auth.ts'));
	});

	test('passes full URI unchanged when file already contains "://"', () => {
		let receivedUri: string | undefined;
		const idx: IWorkspaceSymbolIndexService = {
			...makeIndex(),
			getImports: (uri) => { receivedUri = uri; return []; },
			getImporters: () => [],
		};
		const fileUri = 'file:///other/src/auth.ts';
		executeGetImportGraph({ file: fileUri }, idx, WS);
		assert.strictEqual(receivedUri, fileUri);
	});
});

suite('executeGetImportGraph — error resilience', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns [] imports when getImports throws', () => {
		const idx = makeIndex({ throwImports: true, importers: [`${WS}/main.ts`] });
		const result = executeGetImportGraph({ file: 'src/a.ts' }, idx, WS);
		assert.deepStrictEqual(result.imports, []);
		assert.deepStrictEqual(result.importers, [`${WS}/main.ts`]);
	});

	test('returns [] importers when getImporters throws', () => {
		const idx = makeIndex({ imports: [`${WS}/dep.ts`], throwImporters: true });
		const result = executeGetImportGraph({ file: 'src/a.ts' }, idx, WS);
		assert.deepStrictEqual(result.imports, [`${WS}/dep.ts`]);
		assert.deepStrictEqual(result.importers, []);
	});

	test('returns [] for both when both methods throw', () => {
		const idx = makeIndex({ throwImports: true, throwImporters: true });
		const result = executeGetImportGraph({ file: 'src/a.ts' }, idx, WS);
		assert.deepStrictEqual(result.imports, []);
		assert.deepStrictEqual(result.importers, []);
	});
});
