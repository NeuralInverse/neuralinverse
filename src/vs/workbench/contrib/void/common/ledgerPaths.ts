/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Keep persisted thread identifiers within a single child directory. */
export function sanitizeThreadDirectory(threadId: string): string {
	const safe = String(threadId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
	return !safe || safe === '.' || safe === '..' ? 'thread' : safe;
}

/** Ledger blobs must be direct children of the thread's blobs directory. */
export function isValidLedgerBlobRef(ref: unknown): ref is string {
	return typeof ref === 'string' && /^blobs\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(ref);
}
