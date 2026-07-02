/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { ToolRegistry } from '../../../../browser/tools/toolRegistry.js';
import { createWorkflowContextTools } from '../../../../browser/context/tools/adapters/workflowAgentAdapter.js';
import { CONTEXT_TOOL_NAMES } from '../../../../browser/context/tools/contextToolTypes.js';
import { IContextToolDeps } from '../../../../browser/context/tools/contextToolTypes.js';

// ─── Stub deps ────────────────────────────────────────────────────────────────

function makeDeps(): IContextToolDeps {
	return {
		symbolIndex: {
			_serviceBrand: undefined as any,
			onDidReindex: { event: () => {} } as any,
			onDidFinishFullIndex: { event: () => {} } as any,
			isReady: () => true,
			getSymbolsByName: () => [],
			getSymbolsInFile: () => [],
			getImports: () => [],
			getImporters: () => [],
			getTransitiveImports: () => [],
			getTransitiveDependents: () => [],
			getFileIndex: () => undefined,
			getStats: () => ({ totalFiles: 0, totalSymbols: 0, indexingInProgress: false }),
			forceReindex: async () => {},
		},
		relevanceScorer: {
			_serviceBrand: undefined as any,
			scoreFiles: () => [],
			scoreFilesAsync: async () => [],
			getRelevantSymbols: () => [],
			scoreFile: () => undefined,
		},
		contextPacker: {
			_serviceBrand: undefined as any,
			pack: async () => ({ sections: [], totalTokens: 0, budgetUsed: 0, budgetTotal: 0, truncated: false, filesIncluded: [], filesSkipped: [] }),
			packToString: async () => '',
			estimateTokens: (t) => Math.ceil(t.length / 3.5),
			getDefaultBudget: () => 16384,
		},
		changeTracker: {
			_serviceBrand: undefined as any,
			onDidRecordEdit: { event: () => {} } as any,
			getRecentlyEdited: () => [],
			getCoEditedFiles: () => [],
			getEditHeat: () => 0,
			getEditVelocity: () => 0,
			getHotRegions: () => [],
			isFileActive: () => false,
			reset: () => {},
		},
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('workflowAgentService — context tool registration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('all 5 context tools are registered in ToolRegistry', () => {
		const registry = new ToolRegistry();
		const contextTools = createWorkflowContextTools(makeDeps());
		registry.registerMany(contextTools);

		for (const name of CONTEXT_TOOL_NAMES) {
			assert.ok(registry.has(name), `Expected context tool "${name}" to be registered`);
		}
	});

	test('context tools are retrievable by name', () => {
		const registry = new ToolRegistry();
		registry.registerMany(createWorkflowContextTools(makeDeps()));

		for (const name of CONTEXT_TOOL_NAMES) {
			const tool = registry.get(name);
			assert.ok(tool, `Expected to get tool "${name}"`);
			assert.strictEqual(tool!.name, name);
		}
	});

	test('CONTEXT_TOOL_NAMES has exactly 5 entries', () => {
		assert.strictEqual(CONTEXT_TOOL_NAMES.length, 5);
	});

	test('CONTEXT_TOOL_NAMES contains expected tool names', () => {
		const names = [...CONTEXT_TOOL_NAMES];
		assert.ok(names.includes('searchSymbols'));
		assert.ok(names.includes('getRelatedFiles'));
		assert.ok(names.includes('getFileContext'));
		assert.ok(names.includes('getImportGraph'));
		assert.ok(names.includes('getRecentEdits'));
	});
});

suite('workflowAgentService — scoped view with context tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('scoped registry includes context tools when listed in allowedTools', () => {
		const registry = new ToolRegistry();
		registry.registerMany(createWorkflowContextTools(makeDeps()));

		const allowedTools = ['searchSymbols', 'getRelatedFiles', 'getFileContext'];
		const scoped = registry.scope(allowedTools);

		const names = scoped.getAll().map(t => t.name);
		assert.ok(names.includes('searchSymbols'));
		assert.ok(names.includes('getRelatedFiles'));
		assert.ok(names.includes('getFileContext'));
	});

	test('scoped registry excludes context tools NOT in allowedTools', () => {
		const registry = new ToolRegistry();
		registry.registerMany(createWorkflowContextTools(makeDeps()));

		const scoped = registry.scope(['searchSymbols']);
		const names = scoped.getAll().map(t => t.name);

		assert.ok(names.includes('searchSymbols'));
		assert.ok(!names.includes('getImportGraph'), 'getImportGraph should not be in scoped view');
		assert.ok(!names.includes('getRecentEdits'), 'getRecentEdits should not be in scoped view');
	});

	test('scoped registry with all context tools allows all 5', () => {
		const registry = new ToolRegistry();
		registry.registerMany(createWorkflowContextTools(makeDeps()));

		const scoped = registry.scope([...CONTEXT_TOOL_NAMES]);
		assert.strictEqual(scoped.getAll().length, 5);
	});

	test('scoped registry with empty allowedTools excludes context tools', () => {
		const registry = new ToolRegistry();
		registry.registerMany(createWorkflowContextTools(makeDeps()));

		const scoped = registry.scope([]);
		assert.strictEqual(scoped.getAll().length, 0);
	});

	test('context tools coexist with other tools in the same registry', () => {
		const registry = new ToolRegistry();

		// Register a non-context tool alongside context tools
		registry.register({
			name: 'readFile',
			description: 'Read a file',
			parameters: { path: { type: 'string', description: 'path', required: true } },
			execute: async () => ({ success: true, output: '' }),
		});
		registry.registerMany(createWorkflowContextTools(makeDeps()));

		assert.ok(registry.has('readFile'));
		for (const name of CONTEXT_TOOL_NAMES) {
			assert.ok(registry.has(name), `Expected "${name}" to be in registry alongside readFile`);
		}
		assert.ok(registry.getAll().length >= 6, 'should have at least 6 tools (5 context + readFile)');
	});

	test('getSchema includes context tools when they are in the registry', () => {
		const registry = new ToolRegistry();
		registry.registerMany(createWorkflowContextTools(makeDeps()));

		const schema = registry.getSchema() as any[];
		const schemaNames = schema.map(s => s.name);
		for (const name of CONTEXT_TOOL_NAMES) {
			assert.ok(schemaNames.includes(name), `Expected schema entry for "${name}"`);
		}
	});
});
