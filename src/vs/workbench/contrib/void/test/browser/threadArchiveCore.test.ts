/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for the pure thread-archive core (v2 renderer-OOM fix — Astra
 * review closure). Pins the integrity rules that make a persisted marker
 * trustworthy: content-addressed files, strict ref validation and a parse
 * gate that only ever returns an original (non-marker, role-matched) message.
 */

import assert from 'assert';
import { archiveHashOf, archiveFileNameOf, isValidArchiveRef, parseArchivedMessage, sanitizeThreadId, mergeRestoredThreadMessages } from '../../common/threadArchiveCore.js';
import { THREAD_PERSIST_STUB_MARKER } from '../../common/threadStorageBound.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('threadArchiveCore', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('archiveHashOf is deterministic and content-sensitive', () => {
		const a = archiveHashOf(JSON.stringify({ role: 'user', content: 'hello' }));
		const b = archiveHashOf(JSON.stringify({ role: 'user', content: 'hello' }));
		const c = archiveHashOf(JSON.stringify({ role: 'user', content: 'hello!' }));
		assert.strictEqual(a, b);
		assert.notStrictEqual(a, c);
		assert.strictEqual(a.length, 40, 'sha1 hex');
	});

	test('isValidArchiveRef accepts only <sha1>.json — no traversal, no junk', () => {
		assert.ok(isValidArchiveRef('0123456789abcdef0123456789abcdef01234567.json'));
		assert.ok(!isValidArchiveRef('../../secret.txt'));
		assert.ok(!isValidArchiveRef('short.json'));
		assert.ok(!isValidArchiveRef('0123456789ABCDEF0123456789abcdef01234567.json'));
		assert.ok(!isValidArchiveRef(undefined));
		assert.ok(!isValidArchiveRef(''));
	});

	test('parseArchivedMessage returns the original only for a hash-matching, non-marker body', () => {
		const original = { role: 'user', content: 'full text', displayContent: 'full text' };
		const body = JSON.stringify(original);
		const hash = archiveHashOf(body);
		const parsed = parseArchivedMessage(body, hash, 'user');
		assert.ok(parsed);
		assert.strictEqual(parsed!.content, 'full text');

		assert.strictEqual(parseArchivedMessage(body, archiveHashOf('other'), 'user'), null, 'hash mismatch must reject');
		assert.strictEqual(parseArchivedMessage(undefined, hash, 'user'), null);
		assert.strictEqual(parseArchivedMessage('not json', hash, 'user'), null);
		assert.strictEqual(parseArchivedMessage(body, hash, 'assistant'), null, 'role mismatch must reject');
		const markerBody = JSON.stringify({ role: 'user', content: THREAD_PERSIST_STUB_MARKER });
		assert.strictEqual(parseArchivedMessage(markerBody, archiveHashOf(markerBody), 'user'), null, 'a marker is never a valid archive body');
		const withRef = JSON.stringify({ role: 'user', content: 'x', voidArchivedRef: { f: 'stale.json' } });
		const parsedRef = parseArchivedMessage(withRef, archiveHashOf(withRef), 'user');
		assert.ok(parsedRef && parsedRef.voidArchivedRef === undefined, 'stale ref fields must be stripped on restore');
	});

	test('quoted markers survive archive roundtrip', () => {
		const original = { role: 'user', content: `Explain this message: ${THREAD_PERSIST_STUB_MARKER}` };
		const body = JSON.stringify(original);
		assert.deepStrictEqual(parseArchivedMessage(body, archiveHashOf(body), 'user'), original);
	});

	test('rehydration preserves appended, edited and deleted messages', () => {
		const first = { content: 'marker one' };
		const second = { content: 'marker two' };
		const third = { content: 'marker three' };
		const restored = [{ content: 'original one' }, { content: 'original two' }, { content: 'original three' }];
		const edited = { content: 'user edit' };
		const appended = { content: 'new message' };
		assert.deepStrictEqual(mergeRestoredThreadMessages([first, second, third], restored, [first, edited, appended]), [restored[0], edited, appended]);
	});

	test('sanitizeThreadId is filesystem-safe and bounded', () => {
		assert.strictEqual(sanitizeThreadId('eda9d5a3-e000-4491-bc5c-7acb73b863e6'), 'eda9d5a3-e000-4491-bc5c-7acb73b863e6');
		// dots are legal in the charset; separators are not — no traversal survives
		assert.strictEqual(sanitizeThreadId('../../evil'), '.._.._evil');
		assert.ok(!sanitizeThreadId('../../evil').includes('/') && !sanitizeThreadId('../../evil').includes('\\'));
		assert.strictEqual(sanitizeThreadId('').length > 0, true);
		assert.strictEqual(sanitizeThreadId('.'), 'thread');
		assert.strictEqual(sanitizeThreadId('..'), 'thread');
		assert.ok(sanitizeThreadId('a'.repeat(500)).length <= 80);
	});

	test('archiveFileNameOf maps hash → file', () => {
		assert.strictEqual(archiveFileNameOf('0123456789abcdef0123456789abcdef01234567'), '0123456789abcdef0123456789abcdef01234567.json');
	});
});
