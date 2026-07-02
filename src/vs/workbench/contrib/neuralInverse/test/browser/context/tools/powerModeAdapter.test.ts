/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildContextPowerTools } from '../../../../browser/context/tools/adapters/powerModeAdapter.js';
import { IContextToolDeps } from '../../../../browser/context/tools/contextToolTypes.js';
import { IToolContext } from '../../../../../powerMode/common/powerModeTypes.js';

// ─── Stub deps ────────────────────────────────────────────────────────────────

function makeSymbol(name: string, kind: number, filePath: string) {
	return {
		name,
		kind,
		filePath,
		range: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
		exportedAs: undefined,
		containerName: undefined,
		references: [],
	};
}

function makeDeps(overrides: Partial<IContextToolDeps> = {}): IContextToolDeps {
	return {
		symbolIndex: {
			_serviceBrand: undefined as any,
			onDidReindex: { event: () => {} } as any,
			onDidFinishFullIndex: { event: () => {} } as any,
			isReady: () => true,
			getSymbolsByName: (name: string) => [makeSymbol(name, 11, `src/${name}.ts`)],
			getSymbolsInFile: () => [],
			getImports: () => ['file:///workspace/dep.ts'],
			getImporters: () => ['file:///workspace/main.ts'],
			getTransitiveImports: () => [],
			getTransitiveDependents: () => [],
			getFileIndex: () => undefined,
			getStats: () => ({ totalFiles: 0, totalSymbols: 0, indexingInProgress: false }),
			forceReindex: async () => {},
		},
		relevanceScorer: {
			_serviceBrand: undefined as any,
			scoreFiles: () => [{ uri: 'file:///workspace/src/related.ts', score: 0.9, reasons: ['import-direct'] as any }],
			scoreFilesAsync: async () => [],
			getRelevantSymbols: () => [],
			scoreFile: () => undefined,
		},
		contextPacker: {
			_serviceBrand: undefined as any,
			pack: async () => ({ sections: [], totalTokens: 0, budgetUsed: 0, budgetTotal: 0, truncated: false, filesIncluded: [], filesSkipped: [] }),
			packToString: async () => 'packed context body',
			estimateTokens: (t) => Math.ceil(t.length / 3.5),
			getDefaultBudget: () => 16384,
		},
		changeTracker: {
			_serviceBrand: undefined as any,
			onDidRecordEdit: { event: () => {} } as any,
			getRecentlyEdited: () => [{
				uri: 'file:///workspace/src/active.ts',
				lastEditAt: Date.now() - 5000,
				editCount: 3,
				totalCharsChanged: 100,
				editVelocity: 1.2,
				coEditedWith: new Set(),
				recentLineRanges: [],
			}],
			getCoEditedFiles: () => [],
			getEditHeat: () => 0.8,
			getEditVelocity: () => 1.2,
			getHotRegions: () => [],
			isFileActive: () => true,
			reset: () => {},
		},
		...overrides,
	};
}

function makeCtx(metadataCalls: Array<{ title?: string; metadata?: Record<string, any> }> = []): IToolContext {
	return {
		sessionId: 'test-session',
		messageId: 'test-message',
		agentId: 'test-agent',
		abort: new AbortController().signal,
		metadata: (input) => metadataCalls.push(input),
	};
}

const WS = 'file:///workspace';

// ─── Factory ──────────────────────────────────────────────────────────────────

suite('buildContextPowerTools — factory', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns exactly 5 tools', () => {
		const tools = buildContextPowerTools(makeDeps(), WS);
		assert.strictEqual(tools.length, 5);
	});

	test('tool IDs match expected power mode names', () => {
		const tools = buildContextPowerTools(makeDeps(), WS);
		const ids = tools.map(t => t.id);
		assert.ok(ids.includes('context_search_symbols'));
		assert.ok(ids.includes('context_related_files'));
		assert.ok(ids.includes('context_file_context'));
		assert.ok(ids.includes('context_import_graph'));
		assert.ok(ids.includes('context_recent_edits'));
	});

	test('every tool has a description', () => {
		const tools = buildContextPowerTools(makeDeps(), WS);
		for (const tool of tools) {
			assert.ok(tool.description && tool.description.length > 0, `${tool.id} is missing description`);
		}
	});

	test('every tool has a parameters array', () => {
		const tools = buildContextPowerTools(makeDeps(), WS);
		for (const tool of tools) {
			assert.ok(Array.isArray(tool.parameters), `${tool.id} parameters should be an array`);
		}
	});
});

// ─── context_search_symbols via IPowerTool ────────────────────────────────────

suite('powerModeAdapter — context_search_symbols', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function getTool(deps = makeDeps()) {
		return buildContextPowerTools(deps, WS).find(t => t.id === 'context_search_symbols')!;
	}

	test('returns error output when query is missing', async () => {
		const result = await getTool().execute({}, makeCtx());
		assert.ok(result.output.toLowerCase().includes('error') || result.output.toLowerCase().includes('required'));
		assert.strictEqual(result.metadata.error, true);
	});

	test('returns results when query matches symbols', async () => {
		const result = await getTool().execute({ query: 'parseToken' }, makeCtx());
		assert.ok(result.output.includes('parseToken'));
		assert.ok(typeof result.metadata.count === 'number');
		assert.ok(result.metadata.count > 0);
	});

	test('returns "no symbols found" when index returns empty', async () => {
		const deps = makeDeps({
			symbolIndex: { ...makeDeps().symbolIndex, getSymbolsByName: () => [] },
		});
		const result = await getTool(deps).execute({ query: 'xyz' }, makeCtx());
		assert.ok(result.output.includes('No symbols found'));
		assert.strictEqual(result.metadata.count, 0);
	});

	test('calls ctx.metadata() with a title during search', async () => {
		const calls: any[] = [];
		await getTool().execute({ query: 'fn' }, makeCtx(calls));
		assert.ok(calls.length > 0);
		assert.ok(calls.some(c => c.title && c.title.includes('fn')));
	});

	test('result includes kind label in output (e.g. "function")', async () => {
		const result = await getTool().execute({ query: 'parseToken' }, makeCtx());
		assert.ok(result.output.includes('function') || result.output.includes('kind:'));
	});
});

// ─── context_related_files via IPowerTool ─────────────────────────────────────

suite('powerModeAdapter — context_related_files', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function getTool(deps = makeDeps()) {
		return buildContextPowerTools(deps, WS).find(t => t.id === 'context_related_files')!;
	}

	test('returns error output when neither file nor query provided', async () => {
		const result = await getTool().execute({}, makeCtx());
		assert.ok(result.output.toLowerCase().includes('error') || result.output.toLowerCase().includes('required'));
		assert.strictEqual(result.metadata.error, true);
	});

	test('returns related files on success', async () => {
		const result = await getTool().execute({ file: 'src/auth.ts' }, makeCtx());
		assert.ok(result.output.includes('%') || result.output.includes('related'));
		assert.ok(typeof result.metadata.count === 'number');
	});

	test('returns "no related files" when scorer returns empty', async () => {
		const deps = makeDeps({ relevanceScorer: { ...makeDeps().relevanceScorer, scoreFiles: () => [] } });
		const result = await getTool(deps).execute({ file: 'src/auth.ts' }, makeCtx());
		assert.ok(result.output.toLowerCase().includes('no related'));
		assert.strictEqual(result.metadata.count, 0);
	});

	test('calls ctx.metadata() with a title', async () => {
		const calls: any[] = [];
		await getTool().execute({ file: 'src/auth.ts' }, makeCtx(calls));
		assert.ok(calls.some(c => c.title));
	});

	test('strips workspace prefix from output', async () => {
		const result = await getTool().execute({ file: 'src/auth.ts' }, makeCtx());
		assert.ok(!result.output.includes('file:///workspace/'), 'full URI should not appear in output');
	});
});

// ─── context_file_context via IPowerTool ──────────────────────────────────────

suite('powerModeAdapter — context_file_context', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function getTool(deps = makeDeps()) {
		return buildContextPowerTools(deps, WS).find(t => t.id === 'context_file_context')!;
	}

	test('returns error output when file is missing', async () => {
		const result = await getTool().execute({}, makeCtx());
		assert.ok(result.output.toLowerCase().includes('error') || result.output.toLowerCase().includes('required'));
		assert.strictEqual(result.metadata.error, true);
	});

	test('returns packed context on success', async () => {
		const result = await getTool().execute({ file: 'src/auth.ts' }, makeCtx());
		assert.ok(result.output.includes('packed'));
		assert.ok(typeof result.metadata.tokens === 'number');
	});

	test('returns empty context message when packer returns empty string', async () => {
		const deps = makeDeps({ contextPacker: { ...makeDeps().contextPacker, packToString: async () => '' } });
		const result = await getTool(deps).execute({ file: 'src/empty.ts' }, makeCtx());
		assert.ok(result.output.includes('No context') || result.metadata.empty === true);
	});

	test('budget is capped at 32768 in power mode adapter', async () => {
		let capturedBudget: number | undefined;
		const deps = makeDeps({
			contextPacker: {
				...makeDeps().contextPacker,
				packToString: async (req: any) => { capturedBudget = req.budget; return 'ctx'; },
			},
		});
		await getTool(deps).execute({ file: 'src/a.ts', budget: 999999 }, makeCtx());
		assert.ok(capturedBudget !== undefined);
		assert.ok(capturedBudget! <= 32768, `power mode budget should be capped at 32768, got ${capturedBudget}`);
	});

	test('metadata contains budget field', async () => {
		const result = await getTool().execute({ file: 'src/a.ts', budget: 4096 }, makeCtx());
		assert.ok(typeof result.metadata.budget === 'number');
	});

	test('calls ctx.metadata() with title during packing', async () => {
		const calls: any[] = [];
		await getTool().execute({ file: 'src/a.ts' }, makeCtx(calls));
		assert.ok(calls.some(c => c.title && c.title.includes('a.ts')));
	});
});

// ─── context_import_graph via IPowerTool ──────────────────────────────────────

suite('powerModeAdapter — context_import_graph', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function getTool(deps = makeDeps()) {
		return buildContextPowerTools(deps, WS).find(t => t.id === 'context_import_graph')!;
	}

	test('returns error output when file is missing', async () => {
		const result = await getTool().execute({}, makeCtx());
		assert.ok(result.output.toLowerCase().includes('error') || result.output.toLowerCase().includes('required'));
		assert.strictEqual(result.metadata.error, true);
	});

	test('returns import graph output on success', async () => {
		const result = await getTool().execute({ file: 'src/service.ts' }, makeCtx());
		assert.ok(result.output.includes('Imports') || result.output.includes('->'));
	});

	test('metadata contains imports and importers counts', async () => {
		const result = await getTool().execute({ file: 'src/service.ts' }, makeCtx());
		assert.ok(typeof result.metadata.imports === 'number');
		assert.ok(typeof result.metadata.importers === 'number');
	});

	test('title includes file name and import counts', async () => {
		const result = await getTool().execute({ file: 'src/service.ts' }, makeCtx());
		assert.ok(result.title.includes('service.ts') || result.title.includes('import'));
	});

	test('calls ctx.metadata() with title', async () => {
		const calls: any[] = [];
		await getTool().execute({ file: 'src/a.ts' }, makeCtx(calls));
		assert.ok(calls.some(c => c.title));
	});
});

// ─── context_recent_edits via IPowerTool ──────────────────────────────────────

suite('powerModeAdapter — context_recent_edits', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function getTool(deps = makeDeps()) {
		return buildContextPowerTools(deps, WS).find(t => t.id === 'context_recent_edits')!;
	}

	test('returns recent edits when available', async () => {
		const result = await getTool().execute({}, makeCtx());
		assert.ok(result.output.includes('heat') || result.output.includes('edits'));
		assert.ok(typeof result.metadata.count === 'number');
		assert.ok(result.metadata.count > 0);
	});

	test('returns "no recent edits" message when tracker returns empty', async () => {
		const deps = makeDeps({ changeTracker: { ...makeDeps().changeTracker, getRecentlyEdited: () => [] } });
		const result = await getTool(deps).execute({}, makeCtx());
		assert.ok(result.output.toLowerCase().includes('no recent'));
		assert.strictEqual(result.metadata.count, 0);
	});

	test('calls ctx.metadata() with title', async () => {
		const calls: any[] = [];
		await getTool().execute({}, makeCtx(calls));
		assert.ok(calls.some(c => c.title));
	});

	test('within_minutes (snake_case) parameter name used by power mode', async () => {
		let receivedMs: number | undefined;
		const deps = makeDeps({
			changeTracker: {
				...makeDeps().changeTracker,
				getRecentlyEdited: (ms) => { receivedMs = ms; return []; },
			},
		});
		await getTool(deps).execute({ within_minutes: 15 }, makeCtx());
		assert.strictEqual(receivedMs, 15 * 60 * 1000);
	});
});
