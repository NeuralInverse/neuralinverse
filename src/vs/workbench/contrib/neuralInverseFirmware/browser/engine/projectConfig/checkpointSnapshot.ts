/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure helpers for checkpoint content snapshots (task A3).
 *
 * Kept free of workbench services so the snapshot format — text vs base64,
 * absent-file semantics, pruning — is unit-testable in the standalone runner.
 * The service (`checkpointService.ts`) owns all I/O; these functions only
 * transform bytes.
 */

import { VSBuffer, encodeBase64, decodeBase64 } from '../../../../../../base/common/buffer.js';

/** A stored snapshot for one file inside a checkpoint detail. */
export type StoredFileSnapshot =
	| { kind: 'text'; text: string }        // utf8-roundtrippable content
	| { kind: 'binary'; base64: string }    // anything the utf8 roundtrip mangles
	;

/**
 * Classify file bytes for storage. Content is stored as utf8 text only when
 * decoding and re-encoding yields the identical bytes — everything else
 * (images, executables, utf8 with invalid sequences) goes to base64 so a
 * rewind restores the exact bytes that were on disk.
 */
export function buildFileSnapshot(bytes: Uint8Array): StoredFileSnapshot {
	const text = VSBuffer.wrap(bytes).toString();
	if (bytesEqual(bytes, VSBuffer.fromString(text).buffer)) {
		return { kind: 'text', text };
	}
	return { kind: 'binary', base64: encodeBase64(VSBuffer.wrap(bytes)) };
}

/** Decode a stored snapshot back to the bytes to write on rewind. */
export function fileSnapshotToBytes(snapshot: StoredFileSnapshot): VSBuffer {
	switch (snapshot.kind) {
		case 'text': return VSBuffer.fromString(snapshot.text);
		case 'binary': return decodeBase64(snapshot.base64);
	}
}

/**
 * Whether a file was absent (did not exist) at checkpoint time, so a rewind
 * must delete it instead of writing content.
 *
 * New checkpoints always carry `absentFiles` (possibly empty), where `''` in
 * `fileSnapshots` legitimately means an existing empty file. Legacy records
 * predate that field and used `''` to mean "did not exist" — keep honoring
 * that reading for them.
 */
export function fileWasAbsent(path: string, detail: { absentFiles?: string[]; fileSnapshots: Record<string, string> }): boolean {
	if (detail.absentFiles) {
		return detail.absentFiles.includes(path);
	}
	return detail.fileSnapshots[path] === '';
}

/** The oldest entries to drop when a checkpoint list exceeds `max`. */
export function pickPruneVictims<T extends { id: string; timestamp: number }>(checkpoints: readonly T[], max: number): T[] {
	if (checkpoints.length <= max) {
		return [];
	}
	const byAge = [...checkpoints].sort((a, b) => a.timestamp - b.timestamp);
	return byAge.slice(0, checkpoints.length - max);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}
