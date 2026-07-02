/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { executeGetRelatedFiles } from '../../../../browser/context/tools/getRelatedFilesTool.js';
import { IRelevanceScorerService, IScoredItem, IRelevanceQuery } from '../../../../browser/context/relevance/relevanceScorer.js';

// ─── Stub ─────────────────────────────────────────────────────────────────────

function makeScorer(items: IScoredItem[] = [], throws = false): IRelevanceScorerService {
	return {
		_serviceBrand: undefined as any,
		scoreFiles: (_query: IRelevanceQuery, _max?: number): IScoredItem[] => {
			if (throws) { throw new Error('scorer error'); }
			return items;
		},
		scoreFilesAsync: async () => items,
		getRelevantSymbols: () => [],
		scoreFile: () => undefined,
	};
}

function makeScoredItem(uri: string, score = 0.8, reasons: string[] = ['import-direct']): IScoredItem {
	return { uri, score, reasons: reasons as any };
}

const WS = 'file:///workspace';

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('executeGetRelatedFiles — guard: neither file nor query', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns [] when neither file nor query provided', () => {
		const scorer = makeScorer([makeScoredItem(`${WS}/src/a.ts`)]);
		const result = executeGetRelatedFiles({}, scorer, WS);
		assert.deepStrictEqual(result, []);
	});
});

suite('executeGetRelatedFiles — file mode', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('passes correct file URI to scorer when file is workspace-relative', () => {
		let capturedQuery: IRelevanceQuery | undefined;
		const scorer: IRelevanceScorerService = {
			...makeScorer(),
			scoreFiles: (q: IRelevanceQuery) => { capturedQuery = q; return []; },
		};
		executeGetRelatedFiles({ file: 'src/auth.ts' }, scorer, WS);
		assert.ok(capturedQuery);
		assert.strictEqual(capturedQuery.uri, `${WS}/src/auth.ts`);
		assert.strictEqual(capturedQuery.type, 'file');
	});

	test('strips leading slash from file path before joining workspace URI', () => {
		let capturedQuery: IRelevanceQuery | undefined;
		const scorer: IRelevanceScorerService = {
			...makeScorer(),
			scoreFiles: (q: IRelevanceQuery) => { capturedQuery = q; return []; },
		};
		executeGetRelatedFiles({ file: '/src/auth.ts' }, scorer, WS);
		assert.ok(capturedQuery);
		assert.ok(!capturedQuery.uri!.includes('//src'), 'should not have double slash');
		assert.ok(capturedQuery.uri!.endsWith('/src/auth.ts'));
	});

	test('passes full URI unchanged when file already contains "://"', () => {
		let capturedQuery: IRelevanceQuery | undefined;
		const scorer: IRelevanceScorerService = {
			...makeScorer(),
			scoreFiles: (q: IRelevanceQuery) => { capturedQuery = q; return []; },
		};
		const fileUri = 'file:///other-workspace/src/auth.ts';
		executeGetRelatedFiles({ file: fileUri }, scorer, WS);
		assert.ok(capturedQuery);
		assert.strictEqual(capturedQuery.uri, fileUri);
	});

	test('returns mapped result with uri, score, reasons', () => {
		const items = [makeScoredItem(`${WS}/src/auth.ts`, 0.9, ['import-direct', 'co-edit-recent'])];
		const result = executeGetRelatedFiles({ file: 'src/main.ts' }, makeScorer(items), WS);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].uri, `${WS}/src/auth.ts`);
		assert.strictEqual(result[0].score, 0.9);
		assert.deepStrictEqual(result[0].reasons, ['import-direct', 'co-edit-recent']);
	});
});

suite('executeGetRelatedFiles — query mode', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('passes correct query type and text to scorer', () => {
		let capturedQuery: IRelevanceQuery | undefined;
		const scorer: IRelevanceScorerService = {
			...makeScorer(),
			scoreFiles: (q: IRelevanceQuery) => { capturedQuery = q; return []; },
		};
		executeGetRelatedFiles({ query: 'authentication middleware' }, scorer, WS);
		assert.ok(capturedQuery);
		assert.strictEqual(capturedQuery.type, 'message');
		assert.strictEqual(capturedQuery.text, 'authentication middleware');
	});

	test('trims whitespace from query text', () => {
		let capturedText: string | undefined;
		const scorer: IRelevanceScorerService = {
			...makeScorer(),
			scoreFiles: (q: IRelevanceQuery) => { capturedText = q.text; return []; },
		};
		executeGetRelatedFiles({ query: '  auth  ' }, scorer, WS);
		assert.strictEqual(capturedText, 'auth');
	});
});

suite('executeGetRelatedFiles — maxResults clamping', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('default maxResults is 15', () => {
		let receivedMax: number | undefined;
		const scorer: IRelevanceScorerService = {
			...makeScorer(),
			scoreFiles: (_q, max) => { receivedMax = max; return []; },
		};
		executeGetRelatedFiles({ query: 'test' }, scorer, WS);
		assert.strictEqual(receivedMax, 15);
	});

	test('maxResults is clamped to minimum 1', () => {
		let receivedMax: number | undefined;
		const scorer: IRelevanceScorerService = {
			...makeScorer(),
			scoreFiles: (_q, max) => { receivedMax = max; return []; },
		};
		executeGetRelatedFiles({ query: 'test', maxResults: -5 }, scorer, WS);
		assert.strictEqual(receivedMax, 1);
	});

	test('maxResults is clamped to maximum 60', () => {
		let receivedMax: number | undefined;
		const scorer: IRelevanceScorerService = {
			...makeScorer(),
			scoreFiles: (_q, max) => { receivedMax = max; return []; },
		};
		executeGetRelatedFiles({ query: 'test', maxResults: 9999 }, scorer, WS);
		assert.strictEqual(receivedMax, 60);
	});

	test('valid maxResults in range passes through unchanged', () => {
		let receivedMax: number | undefined;
		const scorer: IRelevanceScorerService = {
			...makeScorer(),
			scoreFiles: (_q, max) => { receivedMax = max; return []; },
		};
		executeGetRelatedFiles({ query: 'test', maxResults: 25 }, scorer, WS);
		assert.strictEqual(receivedMax, 25);
	});
});

suite('executeGetRelatedFiles — scorer error resilience', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns [] when scorer throws', () => {
		const result = executeGetRelatedFiles({ query: 'test' }, makeScorer([], true), WS);
		assert.deepStrictEqual(result, []);
	});
});
