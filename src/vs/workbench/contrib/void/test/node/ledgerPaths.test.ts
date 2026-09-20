/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isValidLedgerBlobRef, sanitizeThreadDirectory } from '../../common/ledgerPaths.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Ledger storage paths', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('thread identifiers cannot resolve to a parent or current directory', () => {
		assert.deepStrictEqual(['', '.', '..', '../other', 'thread-123'].map(sanitizeThreadDirectory),
			['thread', 'thread', 'thread', '.._other', 'thread-123']);
	});

	test('only direct blob children are accepted', () => {
		const refs = ['blobs/entry-1.txt', 'blobs/123_abc', '../secret', 'blobs/..',
			'blobs/../secret', '/blobs/entry', 'blobs/nested/entry', 'blobs/file:stream',
			'blobs/%2e%2e', 'blobs/file\\name', '', undefined, null];
		assert.deepStrictEqual(refs.map(isValidLedgerBlobRef),
			[true, true, false, false, false, false, false, false, false, false, false, false, false]);
	});
});
