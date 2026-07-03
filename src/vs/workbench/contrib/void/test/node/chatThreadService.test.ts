/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ChatThreads, ThreadType } from '../../browser/chatThreadServiceInterface.js';
import { workspaceFilteredThreads } from '../../common/chatThreadUtils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function makeThread(overrides: Partial<ThreadType> & { id: string }): ThreadType {
	_seq++;
	return {
		createdAt: `2026-07-0${_seq}T00:00:00.000Z`,
		lastModified: `2026-07-0${_seq}T00:00:00.000Z`,
		messages: [],
		state: {
			currCheckpointIdx: null,
			stagingSelections: [],
			focusedMessageIdx: undefined,
			linksOfMessageIdx: {},
		},
		filesWithUserChanges: new Set(),
		...overrides,
	} satisfies ThreadType;
}

const WS_A = 'file:///c%3A/Users/asus/Desktop/workspace-a';
const WS_B = 'file:///c%3A/Users/asus/Desktop/workspace-b';

// ---------------------------------------------------------------------------
// Suite: _workspaceFilteredThreads
// ---------------------------------------------------------------------------

suite('chatThreadService — workspaceFilteredThreads', () => {

	// ---- Acceptance Criterion 1: thread stamped with WS-A appears in WS-A ----

	test('AC1: thread created in workspace-a is visible when workspace-a is open', () => {
		const threads: ChatThreads = {
			'a1': makeThread({ id: 'a1', workspaceUri: WS_A }),
		};
		const result = workspaceFilteredThreads(threads, WS_A);
		assert.ok('a1' in result, 'thread a1 must be visible in workspace-a');
	});

	// ---- Acceptance Criterion 2: WS-A thread is hidden in WS-B ----

	test('AC2: thread created in workspace-a is NOT visible when workspace-b is open', () => {
		const threads: ChatThreads = {
			'a1': makeThread({ id: 'a1', workspaceUri: WS_A }),
		};
		const result = workspaceFilteredThreads(threads, WS_B);
		assert.ok(!('a1' in result), 'thread a1 must NOT be visible in workspace-b');
	});

	// ---- Acceptance Criterion 3: switching workspace updates the visible set ----

	test('AC3: switching from workspace-b to workspace-a shows only workspace-a threads', () => {
		const threads: ChatThreads = {
			'a1': makeThread({ id: 'a1', workspaceUri: WS_A }),
			'b1': makeThread({ id: 'b1', workspaceUri: WS_B }),
		};
		const inB = workspaceFilteredThreads(threads, WS_B);
		assert.ok(!('a1' in inB), 'a1 not visible in WS-B');
		assert.ok('b1' in inB, 'b1 visible in WS-B');

		const inA = workspaceFilteredThreads(threads, WS_A);
		assert.ok('a1' in inA, 'a1 visible in WS-A after switch');
		assert.ok(!('b1' in inA), 'b1 not visible in WS-A after switch');
	});

	// ---- Acceptance Criterion 4: no workspace open shows only global threads ----

	test('AC4: no workspace open — only threads without workspaceUri are visible', () => {
		const threads: ChatThreads = {
			'global': makeThread({ id: 'global', workspaceUri: undefined }),
			'a1': makeThread({ id: 'a1', workspaceUri: WS_A }),
		};
		const result = workspaceFilteredThreads(threads, undefined);
		assert.ok('global' in result, 'global thread visible with no workspace');
		assert.ok(!('a1' in result), 'workspace-scoped thread hidden with no workspace');
	});

	// ---- Acceptance Criterion 5: legacy threads (no workspaceUri) shown everywhere ----

	test('AC5: legacy thread without workspaceUri visible in workspace-a', () => {
		const threads: ChatThreads = {
			'legacy': makeThread({ id: 'legacy', workspaceUri: undefined }),
		};
		const result = workspaceFilteredThreads(threads, WS_A);
		assert.ok('legacy' in result, 'legacy thread must be visible in workspace-a');
	});

	test('AC5: legacy thread without workspaceUri visible in workspace-b', () => {
		const threads: ChatThreads = {
			'legacy': makeThread({ id: 'legacy', workspaceUri: undefined }),
		};
		const result = workspaceFilteredThreads(threads, WS_B);
		assert.ok('legacy' in result, 'legacy thread must be visible in workspace-b');
	});

	test('AC5: legacy thread without workspaceUri visible with no workspace open', () => {
		const threads: ChatThreads = {
			'legacy': makeThread({ id: 'legacy', workspaceUri: undefined }),
		};
		const result = workspaceFilteredThreads(threads, undefined);
		assert.ok('legacy' in result, 'legacy thread must be visible with no workspace open');
	});

	// ---- Mixed store: workspace threads + legacy threads ----

	test('mixed store: workspace-a sees own threads AND legacy threads', () => {
		const threads: ChatThreads = {
			'a1':     makeThread({ id: 'a1',     workspaceUri: WS_A }),
			'b1':     makeThread({ id: 'b1',     workspaceUri: WS_B }),
			'legacy': makeThread({ id: 'legacy', workspaceUri: undefined }),
		};
		const result = workspaceFilteredThreads(threads, WS_A);
		assert.ok('a1'     in result, 'a1 visible in WS-A');
		assert.ok('legacy' in result, 'legacy visible in WS-A');
		assert.ok(!('b1'   in result), 'b1 NOT visible in WS-A');
		assert.strictEqual(Object.keys(result).length, 2);
	});

	test('mixed store: workspace-b sees own threads AND legacy threads', () => {
		const threads: ChatThreads = {
			'a1':     makeThread({ id: 'a1',     workspaceUri: WS_A }),
			'b1':     makeThread({ id: 'b1',     workspaceUri: WS_B }),
			'legacy': makeThread({ id: 'legacy', workspaceUri: undefined }),
		};
		const result = workspaceFilteredThreads(threads, WS_B);
		assert.ok('b1'     in result, 'b1 visible in WS-B');
		assert.ok('legacy' in result, 'legacy visible in WS-B');
		assert.ok(!('a1'   in result), 'a1 NOT visible in WS-B');
		assert.strictEqual(Object.keys(result).length, 2);
	});

	// ---- Edge cases ----

	test('empty thread store returns empty result for any workspace', () => {
		const result = workspaceFilteredThreads({}, WS_A);
		assert.strictEqual(Object.keys(result).length, 0);
	});

	test('empty thread store returns empty result with no workspace', () => {
		const result = workspaceFilteredThreads({}, undefined);
		assert.strictEqual(Object.keys(result).length, 0);
	});

	test('undefined thread slot (sparse map) is skipped without error', () => {
		const threads: ChatThreads = {
			'a1':        makeThread({ id: 'a1', workspaceUri: WS_A }),
			'undefined': undefined,
		};
		const result = workspaceFilteredThreads(threads, WS_A);
		assert.ok('a1' in result);
		assert.ok(!('undefined' in result));
	});

	test('new workspace with no matching threads shows only legacy threads', () => {
		const threads: ChatThreads = {
			'a1':     makeThread({ id: 'a1',     workspaceUri: WS_A }),
			'legacy': makeThread({ id: 'legacy', workspaceUri: undefined }),
		};
		const WS_C = 'file:///c%3A/Users/asus/Desktop/workspace-c';
		const result = workspaceFilteredThreads(threads, WS_C);
		assert.ok(!('a1'     in result), 'a1 not visible in new workspace-c');
		assert.ok('legacy'   in result, 'legacy still visible in workspace-c');
		assert.strictEqual(Object.keys(result).length, 1);
	});

	test('URI comparison is exact — different case URIs are NOT considered equal', () => {
		const UPPER_WS = 'file:///C:/Users/asus/Desktop/workspace-a'; // uppercase C
		const threads: ChatThreads = {
			'a1': makeThread({ id: 'a1', workspaceUri: WS_A }), // lowercase c%3A
		};
		// Different URI casing means they don't match
		const result = workspaceFilteredThreads(threads, UPPER_WS);
		assert.ok(!('a1' in result), 'URI comparison is exact — case mismatch means no match');
	});

	test('storage integrity: threads from other workspaces survive after adding to an unrelated thread', () => {
		// This test models the _allThreads spread-then-filter pattern:
		// modifying one thread must not lose another workspace's threads from the full store.
		const allThreads: ChatThreads = {
			'a1': makeThread({ id: 'a1', workspaceUri: WS_A, messages: [] }),
			'b1': makeThread({ id: 'b1', workspaceUri: WS_B, messages: [{ role: 'user', content: 'hello', displayContent: 'hello', selections: [], state: { stagingSelections: [], isBeingEdited: false } }] }),
		};

		// Simulate adding a message to a1 (spreads from allThreads, not filtered view)
		const newAllThreads: ChatThreads = {
			...allThreads,
			'a1': { ...allThreads['a1']!, messages: [{ role: 'user', content: 'hi', displayContent: 'hi', selections: [], state: { stagingSelections: [], isBeingEdited: false } }] },
		};

		// b1 must still be in the full store
		assert.ok('b1' in newAllThreads, 'b1 preserved in full store after modifying a1');

		// Filtered for WS-A: only a1 + any legacies (none here)
		const visibleInA = workspaceFilteredThreads(newAllThreads, WS_A);
		assert.ok('a1' in visibleInA);
		assert.ok(!('b1' in visibleInA));

		// Filtered for WS-B: b1 with its original message intact
		const visibleInB = workspaceFilteredThreads(newAllThreads, WS_B);
		assert.ok('b1' in visibleInB);
		assert.strictEqual((visibleInB['b1']!.messages[0] as any).content, 'hello', 'b1 message preserved');
	});
});
