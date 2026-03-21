/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Knowledge Base checkpoints / snapshots.
 *
 * A checkpoint is a complete serialised snapshot of the KB stored under a named
 * label in workspace storage. They are created:
 *   - Manually before risky bulk operations (e.g. re-scan, bulk-delete, importKB)
 *   - Automatically before restoreCheckpoint()
 *   - Programmatically by agents before destructive phase transitions
 *
 * Checkpoints are stored in workspace storage separately from the live KB.
 * Max 20 checkpoints are retained; oldest is pruned on overflow.
 */

import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IKnowledgeBaseCheckpoint, IModernisationKnowledgeBase } from '../../../common/knowledgeBaseTypes.js';
import { makeId, serialiseKB, deserialiseKB } from './helpers.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_CHECKPOINTS = 20;
const CHECKPOINT_INDEX_KEY = 'nim.kb.checkpoints.index';

function checkpointDataKey(id: string): string {
	return `nim.kb.checkpoints.data.${id}`;
}

// ─── Checkpoint store ─────────────────────────────────────────────────────────

export interface ICheckpointStore {
	/** Ordered list of checkpoint metadata (no data) */
	index: IKnowledgeBaseCheckpoint[];
}

export function createCheckpointStore(): ICheckpointStore {
	return { index: [] };
}

// ─── Create ───────────────────────────────────────────────────────────────────

export async function createCheckpoint(
	store: ICheckpointStore,
	storageService: IStorageService,
	kb: IModernisationKnowledgeBase,
	label: string,
	triggeredBy?: string,
): Promise<IKnowledgeBaseCheckpoint> {
	const id = makeId('cp');
	const snapshot = serialiseKB(kb);

	const checkpoint: IKnowledgeBaseCheckpoint = {
		id,
		label,
		createdAt:    Date.now(),
		triggeredBy:  triggeredBy ?? 'system',
		sessionId:    kb.sessionId,
		unitCount:    kb.units.size,
		snapshotSize: snapshot.length,
	};

	// Persist snapshot data
	storageService.store(checkpointDataKey(id), snapshot, StorageScope.WORKSPACE, StorageTarget.MACHINE);

	// Update index
	store.index.push(checkpoint);

	// Prune oldest if over limit
	if (store.index.length > MAX_CHECKPOINTS) {
		const pruned = store.index.shift()!;
		storageService.remove(checkpointDataKey(pruned.id), StorageScope.WORKSPACE);
	}

	_saveIndex(store, storageService);
	return checkpoint;
}

// ─── List / Get ───────────────────────────────────────────────────────────────

export function listCheckpoints(store: ICheckpointStore): IKnowledgeBaseCheckpoint[] {
	return [...store.index].sort((a, b) => b.createdAt - a.createdAt);
}

export function getCheckpoint(
	store: ICheckpointStore,
	checkpointId: string,
): IKnowledgeBaseCheckpoint | undefined {
	return store.index.find(c => c.id === checkpointId);
}

// ─── Restore ──────────────────────────────────────────────────────────────────

/**
 * Restore the KB to a checkpoint state.
 * Returns the deserialised KB; caller is responsible for replacing the live KB.
 */
export async function restoreCheckpoint(
	store: ICheckpointStore,
	storageService: IStorageService,
	currentKB: IModernisationKnowledgeBase,
	checkpointId: string,
): Promise<IModernisationKnowledgeBase> {
	// Auto-snapshot the current state first
	await createCheckpoint(
		store,
		storageService,
		currentKB,
		`pre-restore:${checkpointId}`,
		'auto',
	);

	const raw = storageService.get(checkpointDataKey(checkpointId), StorageScope.WORKSPACE);
	if (!raw) {
		throw new Error(`Checkpoint data not found: ${checkpointId}`);
	}

	return deserialiseKB(raw);
}

// ─── Delete ───────────────────────────────────────────────────────────────────

export function deleteCheckpoint(
	store: ICheckpointStore,
	storageService: IStorageService,
	checkpointId: string,
): void {
	const idx = store.index.findIndex(c => c.id === checkpointId);
	if (idx === -1) { return; }
	store.index.splice(idx, 1);
	storageService.remove(checkpointDataKey(checkpointId), StorageScope.WORKSPACE);
	_saveIndex(store, storageService);
}

// ─── Index persistence ────────────────────────────────────────────────────────

function _saveIndex(store: ICheckpointStore, storageService: IStorageService): void {
	storageService.store(
		CHECKPOINT_INDEX_KEY,
		JSON.stringify(store.index),
		StorageScope.WORKSPACE,
		StorageTarget.MACHINE,
	);
}

export function loadCheckpointIndex(
	store: ICheckpointStore,
	storageService: IStorageService,
): void {
	const raw = storageService.get(CHECKPOINT_INDEX_KEY, StorageScope.WORKSPACE);
	if (!raw) { return; }
	try {
		store.index = JSON.parse(raw) as IKnowledgeBaseCheckpoint[];
	} catch { /* corrupt index — start fresh */ }
}
