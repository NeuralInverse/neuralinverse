/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildFileSnapshot, fileSnapshotToBytes, fileWasAbsent, pickPruneVictims } from '../../../../browser/engine/projectConfig/checkpointSnapshot.js';

const textBytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const bytesOf = (b: Uint8Array): string => Array.from(b, x => x.toString(16).padStart(2, '0')).join(' ');

// ---------------------------------------------------------------------------
// Suite: buildFileSnapshot / fileSnapshotToBytes — the binary-safety contract
// ---------------------------------------------------------------------------

suite('checkpointSnapshot — content classification', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('utf8 text roundtrips through the text branch', () => {
		const original = textBytes('hello checkpoint\nsecond line');
		const snapshot = buildFileSnapshot(original);
		assert.strictEqual(snapshot.kind, 'text');
		if (snapshot.kind === 'text') {
			assert.strictEqual(snapshot.text, 'hello checkpoint\nsecond line');
		}
		assert.deepStrictEqual(bytesOf(fileSnapshotToBytes(snapshot).buffer), bytesOf(original));
	});

	test('multibyte utf8 (emoji, RTL) stays text and restores exactly', () => {
		const original = textBytes('تسک چک‌پوینت 🎯 — naïve café');
		const snapshot = buildFileSnapshot(original);
		assert.strictEqual(snapshot.kind, 'text');
		assert.deepStrictEqual(bytesOf(fileSnapshotToBytes(snapshot).buffer), bytesOf(original));
	});

	test('binary bytes never go through the text branch', () => {
		// 0xFF and friends are invalid utf8 — a lossy text snapshot would
		// corrupt executables/images on rewind.
		const original = new Uint8Array([0x00, 0xFF, 0xFE, 0x89, 0x50, 0x4B, 0x03, 0x04, 0x00, 0xFF]);
		const snapshot = buildFileSnapshot(original);
		assert.strictEqual(snapshot.kind, 'binary');
		assert.deepStrictEqual(bytesOf(fileSnapshotToBytes(snapshot).buffer), bytesOf(original));
	});

	test('empty file is a text snapshot of "" — absence is tracked separately', () => {
		const snapshot = buildFileSnapshot(new Uint8Array(0));
		assert.strictEqual(snapshot.kind, 'text');
		if (snapshot.kind === 'text') {
			assert.strictEqual(snapshot.text, '');
		}
		assert.deepStrictEqual(fileSnapshotToBytes(snapshot).buffer.length, 0);
	});
});

// ---------------------------------------------------------------------------
// Suite: fileWasAbsent — new vs legacy record semantics
// ---------------------------------------------------------------------------

suite('checkpointSnapshot — absent-file semantics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('records with absentFiles trust the list (empty file ≠ absent)', () => {
		const detail = { fileSnapshots: { 'a.txt': '', 'b.txt': 'content' }, absentFiles: ['c/new-file.ts'] };
		assert.strictEqual(fileWasAbsent('c/new-file.ts', detail), true);
		assert.strictEqual(fileWasAbsent('a.txt', detail), false);
		assert.strictEqual(fileWasAbsent('b.txt', detail), false);
	});

	test('legacy records without absentFiles read "" as absent (old format)', () => {
		const detail = { fileSnapshots: { 'created.ts': '', 'edited.ts': 'before' } };
		assert.strictEqual(fileWasAbsent('created.ts', detail), true);
		assert.strictEqual(fileWasAbsent('edited.ts', detail), false);
	});
});

// ---------------------------------------------------------------------------
// Suite: pickPruneVictims — the 50-checkpoint cap
// ---------------------------------------------------------------------------

suite('checkpointSnapshot — pruning', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const make = (id: string, timestamp: number) => ({ id, timestamp });

	test('under the cap nothing is a victim', () => {
		const items = [make('a', 3), make('b', 1), make('c', 2)];
		assert.deepStrictEqual(pickPruneVictims(items, 50), []);
	});

	test('over the cap only the oldest are victims', () => {
		const items = Array.from({ length: 55 }, (_, i) => make(`cp${i}`, 1000 + i));
		const victims = pickPruneVictims(items, 50);
		assert.deepStrictEqual(victims.map(v => v.id), ['cp0', 'cp1', 'cp2', 'cp3', 'cp4']);
	});

	test('at exactly the cap nothing is a victim', () => {
		const items = Array.from({ length: 50 }, (_, i) => make(`cp${i}`, i));
		assert.deepStrictEqual(pickPruneVictims(items, 50), []);
	});
});
