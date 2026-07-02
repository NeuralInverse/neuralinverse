/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { executeGetRecentEdits } from '../../../../browser/context/tools/getRecentEditsTool.js';
import { IChangeTrackerService, IFileEditProfile } from '../../../../browser/context/tracker/changeTracker.js';

// ─── Stub ─────────────────────────────────────────────────────────────────────

function makeProfile(uri: string, editCount = 3, editVelocity = 1.0, lastEditAt = Date.now()): IFileEditProfile {
	return {
		uri,
		lastEditAt,
		editCount,
		totalCharsChanged: 200,
		editVelocity,
		coEditedWith: new Set(),
		recentLineRanges: [],
	};
}

function makeTracker(
	profiles: IFileEditProfile[] = [],
	heatMap: Map<string, number> = new Map(),
	throwOnGet = false,
	throwOnHeat = false,
): IChangeTrackerService {
	return {
		_serviceBrand: undefined as any,
		onDidRecordEdit: { event: () => {} } as any,
		getRecentlyEdited: (_withinMs?: number): IFileEditProfile[] => {
			if (throwOnGet) { throw new Error('tracker error'); }
			return profiles;
		},
		getCoEditedFiles: () => [],
		getEditHeat: (uri: string): number => {
			if (throwOnHeat) { throw new Error('heat error'); }
			return heatMap.get(uri) ?? 0;
		},
		getEditVelocity: () => 0,
		getHotRegions: () => [],
		isFileActive: () => false,
		reset: () => {},
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

suite('executeGetRecentEdits — no edits', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns [] when no recently edited files', () => {
		const tracker = makeTracker([]);
		const result = executeGetRecentEdits({}, tracker);
		assert.deepStrictEqual(result, []);
	});
});

suite('executeGetRecentEdits — basic results', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('maps profile fields to result correctly', () => {
		const now = Date.now();
		const profile = makeProfile('file:///workspace/src/auth.ts', 5, 2.5, now - 10000);
		const heat = new Map([['file:///workspace/src/auth.ts', 0.75]]);
		const tracker = makeTracker([profile], heat);

		const result = executeGetRecentEdits({}, tracker);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].uri, 'file:///workspace/src/auth.ts');
		assert.strictEqual(result[0].editCount, 5);
		assert.strictEqual(result[0].velocity, 2.5);
		assert.strictEqual(result[0].lastEditAt, profile.lastEditAt);
		assert.strictEqual(result[0].heat, 0.75);
	});

	test('caps results at 25 files', () => {
		const profiles = Array.from({ length: 50 }, (_, i) => makeProfile(`file:///ws/src/f${i}.ts`));
		const tracker = makeTracker(profiles);
		const result = executeGetRecentEdits({}, tracker);
		assert.ok(result.length <= 25, `expected ≤25 results, got ${result.length}`);
	});

	test('returns results in order supplied by tracker (no resorting)', () => {
		const p1 = makeProfile('file:///ws/a.ts', 1, 0.5, Date.now() - 5000);
		const p2 = makeProfile('file:///ws/b.ts', 10, 3.0, Date.now() - 1000);
		const tracker = makeTracker([p1, p2]);
		const result = executeGetRecentEdits({}, tracker);
		assert.strictEqual(result[0].uri, 'file:///ws/a.ts');
		assert.strictEqual(result[1].uri, 'file:///ws/b.ts');
	});
});

suite('executeGetRecentEdits — withinMinutes clamping', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('default withinMinutes is 30 (1_800_000ms)', () => {
		let receivedMs: number | undefined;
		const tracker: IChangeTrackerService = {
			...makeTracker(),
			getRecentlyEdited: (ms) => { receivedMs = ms; return []; },
		};
		executeGetRecentEdits({}, tracker);
		assert.strictEqual(receivedMs, 30 * 60 * 1000);
	});

	test('withinMinutes below 1 is clamped to 1 minute', () => {
		let receivedMs: number | undefined;
		const tracker: IChangeTrackerService = {
			...makeTracker(),
			getRecentlyEdited: (ms) => { receivedMs = ms; return []; },
		};
		// 0.5 is a sub-1 value that is truthy, so it passes the `|| 30` default and hits Math.max(..., 1)
		executeGetRecentEdits({ withinMinutes: 0.5 }, tracker);
		assert.strictEqual(receivedMs, 1 * 60 * 1000);
	});

	test('negative withinMinutes is clamped to 1 minute', () => {
		let receivedMs: number | undefined;
		const tracker: IChangeTrackerService = {
			...makeTracker(),
			getRecentlyEdited: (ms) => { receivedMs = ms; return []; },
		};
		executeGetRecentEdits({ withinMinutes: -100 }, tracker);
		assert.strictEqual(receivedMs, 1 * 60 * 1000);
	});

	test('withinMinutes above 1440 is clamped to 24 hours', () => {
		let receivedMs: number | undefined;
		const tracker: IChangeTrackerService = {
			...makeTracker(),
			getRecentlyEdited: (ms) => { receivedMs = ms; return []; },
		};
		executeGetRecentEdits({ withinMinutes: 9999 }, tracker);
		assert.strictEqual(receivedMs, 1440 * 60 * 1000);
	});

	test('valid withinMinutes in range passes through correctly', () => {
		let receivedMs: number | undefined;
		const tracker: IChangeTrackerService = {
			...makeTracker(),
			getRecentlyEdited: (ms) => { receivedMs = ms; return []; },
		};
		executeGetRecentEdits({ withinMinutes: 60 }, tracker);
		assert.strictEqual(receivedMs, 60 * 60 * 1000);
	});
});

suite('executeGetRecentEdits — stale entry handling', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('heat defaults to 0 when getEditHeat throws (stale entry)', () => {
		const profile = makeProfile('file:///ws/stale.ts');
		const tracker = makeTracker([profile], new Map(), false, true);
		const result = executeGetRecentEdits({}, tracker);
		assert.strictEqual(result.length, 1);
		assert.strictEqual(result[0].heat, 0);
	});

	test('heat = 0 for file not in heat map', () => {
		const profile = makeProfile('file:///ws/new.ts');
		const tracker = makeTracker([profile], new Map()); // empty heat map
		const result = executeGetRecentEdits({}, tracker);
		assert.strictEqual(result[0].heat, 0);
	});
});

suite('executeGetRecentEdits — tracker error resilience', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns [] when getRecentlyEdited throws', () => {
		const tracker = makeTracker([], new Map(), true);
		const result = executeGetRecentEdits({}, tracker);
		assert.deepStrictEqual(result, []);
	});
});
