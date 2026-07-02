/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { executeSearchSymbols } from '../../../../browser/context/tools/searchSymbolsTool.js';
import { IWorkspaceSymbolIndexService } from '../../../../browser/context/index/workspaceSymbolIndex.js';

// ─── Stub ─────────────────────────────────────────────────────────────────────

function makeSymbol(name: string, kind: number, filePath: string, line = 0, exportedAs?: string, containerName?: string) {
	return {
		name,
		kind,
		filePath,
		range: { startLine: line, startCol: 0, endLine: line, endCol: 0 },
		exportedAs,
		containerName,
		references: [],
	};
}

function makeIndex(
	symbols: ReturnType<typeof makeSymbol>[] = [],
	ready = true,
): IWorkspaceSymbolIndexService {
	return {
		_serviceBrand: undefined as any,
		onDidReindex: { event: () => {} } as any,
		onDidFinishFullIndex: { event: () => {} } as any,
		isReady: () => ready,
		getSymbolsByName: (name: string) => symbols.filter(s => s.name.toLowerCase().includes(name.toLowerCase())),
		getSymbolsInFile: () => [],
		getImporters: () => [],
		getImports: () => [],
		getTransitiveDependents: () => [],
		getTransitiveImports: () => [],
		getFileIndex: () => undefined,
		getStats: () => ({ totalFiles: 0, totalSymbols: 0, indexingInProgress: false }),
		forceReindex: async () => {},
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('executeSearchSymbols — empty / no-index guard', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('empty query string returns []', () => {
		const idx = makeIndex([makeSymbol('MyClass', 4, 'src/a.ts')]);
		const result = executeSearchSymbols({ query: '' }, idx);
		assert.deepStrictEqual(result, []);
	});

	test('whitespace-only query returns []', () => {
		const idx = makeIndex([makeSymbol('MyClass', 4, 'src/a.ts')]);
		const result = executeSearchSymbols({ query: '   ' }, idx);
		assert.deepStrictEqual(result, []);
	});

	test('returns [] when index is not ready', () => {
		const idx = makeIndex([makeSymbol('MyClass', 4, 'src/a.ts')], false);
		const result = executeSearchSymbols({ query: 'MyClass' }, idx);
		assert.deepStrictEqual(result, []);
	});
});

suite('executeSearchSymbols — basic results', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns matching symbols', () => {
		const idx = makeIndex([makeSymbol('parseToken', 11, 'src/parser.ts', 10)]);
		const result = executeSearchSymbols({ query: 'parseToken' }, idx);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].name, 'parseToken');
		assert.strictEqual(result[0].kind, 11);
		assert.strictEqual(result[0].file, 'src/parser.ts');
		assert.strictEqual(result[0].line, 10);
	});

	test('returned result includes exported/container fields', () => {
		const sym = makeSymbol('MyClass', 4, 'src/a.ts', 5, 'MyClass', 'Module');
		const result = executeSearchSymbols({ query: 'MyClass' }, makeIndex([sym]));
		assert.strictEqual(result[0].exported, 'MyClass');
		assert.strictEqual(result[0].container, 'Module');
	});

	test('exported and container are null when not set', () => {
		const sym = makeSymbol('foo', 11, 'src/b.ts');
		const result = executeSearchSymbols({ query: 'foo' }, makeIndex([sym]));
		assert.strictEqual(result[0].exported, null);
		assert.strictEqual(result[0].container, null);
	});

	test('caps results at 30', () => {
		const symbols = Array.from({ length: 50 }, (_, i) => makeSymbol(`fn${i}`, 11, `src/f${i}.ts`));
		// stub returns all when name includes empty string — make them all match
		const idx: IWorkspaceSymbolIndexService = {
			...makeIndex(symbols),
			getSymbolsByName: () => symbols,
		};
		const result = executeSearchSymbols({ query: 'fn' }, idx);
		assert.ok(result.length <= 30, `expected ≤30 results, got ${result.length}`);
	});
});

suite('executeSearchSymbols — kind filter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const allKinds = [
		makeSymbol('fn1', 11, 'src/a.ts'),   // function
		makeSymbol('Cls1', 4, 'src/b.ts'),   // class
		makeSymbol('Iface', 10, 'src/c.ts'), // interface
		makeSymbol('v1', 12, 'src/d.ts'),    // variable
	];

	function makeAllIdx() {
		return { ...makeIndex(allKinds), getSymbolsByName: () => allKinds };
	}

	test('kind=function filters to kind 11', () => {
		const result = executeSearchSymbols({ query: 'x', kind: 'function' }, makeAllIdx());
		assert.ok(result.every(r => r.kind === 11));
	});

	test('kind=class filters to kind 4', () => {
		const result = executeSearchSymbols({ query: 'x', kind: 'class' }, makeAllIdx());
		assert.ok(result.every(r => r.kind === 4));
	});

	test('kind=interface filters to kind 10', () => {
		const result = executeSearchSymbols({ query: 'x', kind: 'interface' }, makeAllIdx());
		assert.ok(result.every(r => r.kind === 10));
	});

	test('unknown kind string does not filter (all pass through)', () => {
		// kind not in KIND_MAP → targetKind is undefined → no filtering applied
		const result = executeSearchSymbols({ query: 'x', kind: 'unknown_kind_xyz' }, makeAllIdx());
		assert.strictEqual(result.length, allKinds.length);
	});

	test('kind matching is case-insensitive', () => {
		const result = executeSearchSymbols({ query: 'x', kind: 'CLASS' }, makeAllIdx());
		assert.ok(result.every(r => r.kind === 4));
	});
});

suite('executeSearchSymbols — filePattern filter', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const symbols = [
		makeSymbol('ComponentA', 4, 'src/components/A.ts'),
		makeSymbol('ServiceB', 4, 'src/services/B.ts'),
		makeSymbol('UtilC', 11, 'src/utils/C.ts'),
	];

	function makePatternIdx() {
		return { ...makeIndex(symbols), getSymbolsByName: () => symbols };
	}

	test('filePattern restricts to files containing substring', () => {
		const result = executeSearchSymbols({ query: 'x', filePattern: 'components/' }, makePatternIdx());
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].name, 'ComponentA');
	});

	test('filePattern=".service.ts" filters service files', () => {
		const svcSymbols = [
			makeSymbol('AuthService', 4, 'src/auth.service.ts'),
			makeSymbol('UserModel', 4, 'src/user.model.ts'),
		];
		const idx = { ...makeIndex(svcSymbols), getSymbolsByName: () => svcSymbols };
		const result = executeSearchSymbols({ query: 'x', filePattern: '.service.ts' }, idx);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].name, 'AuthService');
	});

	test('empty filePattern string does not filter', () => {
		const result = executeSearchSymbols({ query: 'x', filePattern: '' }, makePatternIdx());
		assert.strictEqual(result.length, symbols.length);
	});

	test('whitespace filePattern does not filter', () => {
		const result = executeSearchSymbols({ query: 'x', filePattern: '   ' }, makePatternIdx());
		assert.strictEqual(result.length, symbols.length);
	});
});

suite('executeSearchSymbols — partial name match', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('getSymbolsByName is called with trimmed query', () => {
		let received = '';
		const idx: IWorkspaceSymbolIndexService = {
			...makeIndex(),
			getSymbolsByName: (name: string) => { received = name; return []; },
		};
		executeSearchSymbols({ query: '  parse  ' }, idx);
		assert.strictEqual(received, 'parse');
	});

	test('returns partial name matches supplied by the index', () => {
		// Simulates the index returning partial matches (e.g. "parse" matches "parseToken", "parseAST")
		const partials = [
			makeSymbol('parseToken', 11, 'src/a.ts'),
			makeSymbol('parseAST', 11, 'src/b.ts'),
		];
		const idx: IWorkspaceSymbolIndexService = {
			...makeIndex(partials),
			getSymbolsByName: () => partials,
		};
		const result = executeSearchSymbols({ query: 'parse' }, idx);
		assert.strictEqual(result.length, 2);
		assert.ok(result.some(r => r.name === 'parseToken'));
		assert.ok(result.some(r => r.name === 'parseAST'));
	});
});
