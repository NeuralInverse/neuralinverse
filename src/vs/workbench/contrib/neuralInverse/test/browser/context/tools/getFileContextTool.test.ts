/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { executeGetFileContext } from '../../../../browser/context/tools/getFileContextTool.js';
import { IContextPackerService } from '../../../../browser/context/packer/contextPacker.js';

// ─── Stub ─────────────────────────────────────────────────────────────────────

function makePacker(output = 'packed context', throws = false): IContextPackerService {
	return {
		_serviceBrand: undefined as any,
		pack: async () => ({ sections: [], totalTokens: 0, budgetUsed: 0, budgetTotal: 0, truncated: false, filesIncluded: [], filesSkipped: [] }),
		packToString: async () => {
			if (throws) { throw new Error('packer error'); }
			return output;
		},
		estimateTokens: (text: string) => Math.ceil(text.length / 3.5),
		getDefaultBudget: () => 16384,
	};
}

const WS = 'file:///workspace';

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('executeGetFileContext — guard: empty file', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns empty string for empty file arg', async () => {
		const result = await executeGetFileContext({ file: '' }, makePacker(), WS);
		assert.strictEqual(result, '');
	});

	test('returns empty string for whitespace-only file arg', async () => {
		const result = await executeGetFileContext({ file: '   ' }, makePacker(), WS);
		assert.strictEqual(result, '');
	});
});

suite('executeGetFileContext — valid file', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns packed context string', async () => {
		const result = await executeGetFileContext({ file: 'src/auth.ts' }, makePacker('some context'), WS);
		assert.strictEqual(result, 'some context');
	});

	test('calls packToString with correct fileUri (workspace-relative path)', async () => {
		let capturedRequest: any;
		const packer: IContextPackerService = {
			...makePacker(),
			packToString: async (req) => { capturedRequest = req; return 'ctx'; },
		};
		await executeGetFileContext({ file: 'src/auth.ts' }, packer, WS);
		assert.ok(capturedRequest);
		assert.strictEqual(capturedRequest.query.uri, `${WS}/src/auth.ts`);
		assert.strictEqual(capturedRequest.mode, 'agent');
		assert.strictEqual(capturedRequest.includeActiveFile, true);
	});

	test('strips leading slash from file path before joining workspace URI', async () => {
		let capturedUri: string | undefined;
		const packer: IContextPackerService = {
			...makePacker(),
			packToString: async (req) => { capturedUri = req.query.uri; return 'ctx'; },
		};
		await executeGetFileContext({ file: '/src/auth.ts' }, packer, WS);
		assert.ok(capturedUri);
		assert.ok(!capturedUri.includes('//src'), 'should not have double slash');
	});

	test('passes full URI unchanged when file already contains "://"', async () => {
		let capturedUri: string | undefined;
		const packer: IContextPackerService = {
			...makePacker(),
			packToString: async (req) => { capturedUri = req.query.uri; return 'ctx'; },
		};
		const fileUri = 'file:///other/src/auth.ts';
		await executeGetFileContext({ file: fileUri }, packer, WS);
		assert.strictEqual(capturedUri, fileUri);
	});
});

suite('executeGetFileContext — budget clamping', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('default budget is 8192 when not provided', async () => {
		let capturedBudget: number | undefined;
		const packer: IContextPackerService = {
			...makePacker(),
			packToString: async (req) => { capturedBudget = req.budget; return 'ctx'; },
		};
		await executeGetFileContext({ file: 'src/a.ts' }, packer, WS);
		assert.strictEqual(capturedBudget, 8192);
	});

	test('budget below minimum is clamped to 256', async () => {
		let capturedBudget: number | undefined;
		const packer: IContextPackerService = {
			...makePacker(),
			packToString: async (req) => { capturedBudget = req.budget; return 'ctx'; },
		};
		await executeGetFileContext({ file: 'src/a.ts', budget: 10 }, packer, WS);
		assert.strictEqual(capturedBudget, 256);
	});

	test('budget above maximum is clamped to 65536', async () => {
		let capturedBudget: number | undefined;
		const packer: IContextPackerService = {
			...makePacker(),
			packToString: async (req) => { capturedBudget = req.budget; return 'ctx'; },
		};
		await executeGetFileContext({ file: 'src/a.ts', budget: 1_000_000 }, packer, WS);
		assert.strictEqual(capturedBudget, 65536);
	});

	test('valid budget in range passes through unchanged', async () => {
		let capturedBudget: number | undefined;
		const packer: IContextPackerService = {
			...makePacker(),
			packToString: async (req) => { capturedBudget = req.budget; return 'ctx'; },
		};
		await executeGetFileContext({ file: 'src/a.ts', budget: 4096 }, packer, WS);
		assert.strictEqual(capturedBudget, 4096);
	});

	test('exact boundary 256 is not clamped', async () => {
		let capturedBudget: number | undefined;
		const packer: IContextPackerService = {
			...makePacker(),
			packToString: async (req) => { capturedBudget = req.budget; return 'ctx'; },
		};
		await executeGetFileContext({ file: 'src/a.ts', budget: 256 }, packer, WS);
		assert.strictEqual(capturedBudget, 256);
	});

	test('exact boundary 65536 is not clamped', async () => {
		let capturedBudget: number | undefined;
		const packer: IContextPackerService = {
			...makePacker(),
			packToString: async (req) => { capturedBudget = req.budget; return 'ctx'; },
		};
		await executeGetFileContext({ file: 'src/a.ts', budget: 65536 }, packer, WS);
		assert.strictEqual(capturedBudget, 65536);
	});
});

suite('executeGetFileContext — packer failure graceful fallback', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns empty string when packer throws (non-existent file)', async () => {
		const result = await executeGetFileContext({ file: 'nonexistent.ts' }, makePacker('', true), WS);
		assert.strictEqual(result, '');
	});

	test('returns empty string when packer returns empty string', async () => {
		const result = await executeGetFileContext({ file: 'src/empty.ts' }, makePacker(''), WS);
		assert.strictEqual(result, '');
	});
});
