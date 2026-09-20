/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure core of the thread history archive (v2 of the renderer-OOM fix —
 * Astra review closure, 2026-09-19).
 *
 * The archive is an application-scoped, file-backed durable copy of every
 * message the UI thread store replaced with a marker:
 *
 *   <userDataDir>/threadHistoryArchive/<sanitizedThreadId>/<sha1>.json
 *   <userDataDir>/threadHistoryArchive/<sanitizedThreadId>/index.json
 *
 * Files are addressed by the SHA-1 of the EXACT serialized message, so a stub
 * can point at its archive with `voidArchivedRef: { f: '<sha1>.json' }` and
 * any reader can verify integrity by re-hashing the body. `index.json`
 * (written by the recovery tooling, read-only at runtime) maps message
 * indexes to files for stubs written by v1 of the fix, which carried no ref.
 *
 * This module holds only pure string/JSON logic (no DI, no IO) so the
 * hashing, naming, validation and restore rules are unit-testable; the
 * browser service (threadArchiveService.ts) is a thin IFileService shell.
 */

import { sanitizeThreadDirectory } from './ledgerPaths.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { messageIsStubbed, type IStorableMessage } from './threadStorageBound.js';

/** Archive root directory name under the user data dir. */
export const THREAD_ARCHIVE_DIR_NAME = 'threadHistoryArchive';


/** strict shape of a `<sha1>.json` ref — blocks path traversal via refs */
const ARCHIVE_FILE_RE = /^[0-9a-f]{40}\.json$/;

/** The field a persisted stub carries to point at its durable copy. */
export interface IArchivedRef { f: string }

export function sanitizeThreadId(threadId: string): string {
	return sanitizeThreadDirectory(threadId);
}

/** SHA-1 hex of the exact serialized content — the archive identity. */
export function archiveHashOf(fullSerialized: string): string {
	const sha = new StringSHA1();
	sha.update(fullSerialized);
	return sha.digest();
}

export function archiveFileNameOf(hash: string): string {
	return `${hash}.json`;
}

/** True only for a well-formed `<sha1>.json` ref (no separators, no traversal). */
export function isValidArchiveRef(ref: string | undefined | null): ref is string {
	return typeof ref === 'string' && ARCHIVE_FILE_RE.test(ref);
}

export interface ILegacyIndexEntry { f: string; role?: string }
export interface ILegacyIndexFile { entries?: { [messageIndex: string]: ILegacyIndexEntry } }

/**
 * Parse an archived body back into a message. The body must hash to the
 * expected value, parse as an object, carry the expected role and NOT be a
 * marker itself (an archive entry is always the ORIGINAL full message).
 * Returns null for anything else — callers keep the marker honestly.
 */
export function parseArchivedMessage(body: string | undefined, expectedHash: string, expectedRole: string | undefined): IStorableMessage | null {
	if (typeof body !== 'string' || body.length === 0) { return null; }
	if (archiveHashOf(body) !== expectedHash) { return null; }
	let parsed: unknown;
	try { parsed = JSON.parse(body); } catch { return null; }
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return null; }
	const msg = parsed as IStorableMessage;
	if (!msg.role || typeof msg.role !== 'string') { return null; }
	if (expectedRole !== undefined && msg.role !== expectedRole) { return null; }
	if (msg.voidArchivedRef) { delete msg.voidArchivedRef; }
	if (messageIsStubbed(msg)) { return null; }
	return msg;
}

/** Restore unchanged messages while preserving edits and appends made during archive IO. */
export function mergeRestoredThreadMessages<T>(original: readonly T[], restored: readonly T[], current: readonly T[]): T[] {
	const replacements = new Map<T, T>();
	for (let i = 0; i < original.length; i++) {
		if (i < restored.length && original[i] !== restored[i]) {
			replacements.set(original[i], restored[i]);
		}
	}
	return current.map(message => replacements.get(message) ?? message);
}
