/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Persistence layer for the Knowledge Base.
 *
 * Handles:
 *   - Loading a KB from workspace storage on init
 *   - Saving (debounced) on every mutation
 *   - Session index (lightweight registry of all sessions — no full KB load required)
 *   - Schema migration when the version is outdated
 *   - Graceful handling of corrupted storage
 */

import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IModernisationKnowledgeBase, KNOWLEDGE_BASE_VERSION } from '../../../common/knowledgeBaseTypes.js';
import { serialiseKB, deserialiseKB, newKnowledgeBase } from './helpers.js';
import { IKnowledgeBaseSessionIndex } from '../types.js';

// ─── Storage keys ─────────────────────────────────────────────────────────────

const KB_KEY_PREFIX   = 'neuralInverse.knowledgeBase.';
const INDEX_KEY       = 'neuralInverse.knowledgeBase._index';

export const SAVE_DEBOUNCE_MS = 400;
export const MAX_AUDIT_LOG    = 20_000;
export const AUDIT_LOG_TRIM   = 2_000; // entries removed when cap is exceeded


// ─── Load / Create ────────────────────────────────────────────────────────────

/**
 * Load an existing KB from storage, or create a fresh one.
 * Returns the KB and a flag indicating whether it was newly created.
 */
export function loadOrCreate(
	sessionId: string,
	storage: IStorageService,
): { kb: IModernisationKnowledgeBase; isNew: boolean } {
	const key = KB_KEY_PREFIX + sessionId;
	const raw = storage.get(key, StorageScope.WORKSPACE);
	if (raw) {
		try {
			const kb = deserialiseKB(raw);
			migrateSchema(kb);
			return { kb, isNew: false };
		} catch (err) {
			console.warn(`[KnowledgeBase] Corrupted storage for session "${sessionId}". Starting fresh.`, err);
		}
	}
	return { kb: newKnowledgeBase(sessionId), isNew: true };
}


// ─── Save ─────────────────────────────────────────────────────────────────────

export function flush(kb: IModernisationKnowledgeBase, storage: IStorageService): void {
	const key = KB_KEY_PREFIX + kb.sessionId;
	try {
		storage.store(key, serialiseKB(kb), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	} catch (err) {
		console.warn('[KnowledgeBase] Failed to persist KB to storage:', err);
	}
}

export function deleteFromStorage(sessionId: string, storage: IStorageService): void {
	storage.remove(KB_KEY_PREFIX + sessionId, StorageScope.WORKSPACE);
}


// ─── Session index ────────────────────────────────────────────────────────────

export function loadSessionIndex(storage: IStorageService): IKnowledgeBaseSessionIndex {
	try {
		const raw = storage.get(INDEX_KEY, StorageScope.WORKSPACE);
		if (raw) { return JSON.parse(raw) as IKnowledgeBaseSessionIndex; }
	} catch { /* fallthrough */ }
	return { sessions: [] };
}

export function saveSessionIndex(index: IKnowledgeBaseSessionIndex, storage: IStorageService): void {
	try {
		storage.store(INDEX_KEY, JSON.stringify(index), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	} catch { /* best effort */ }
}

export function upsertSessionInIndex(
	kb: IModernisationKnowledgeBase,
	storage: IStorageService,
): void {
	const idx = loadSessionIndex(storage);
	const existing = idx.sessions.findIndex(s => s.sessionId === kb.sessionId);
	const entry = {
		sessionId: kb.sessionId,
		createdAt: kb.createdAt,
		updatedAt: kb.updatedAt,
		totalUnits: kb.progress.totalUnits,
	};
	if (existing >= 0) { idx.sessions[existing] = entry; }
	else               { idx.sessions.push(entry); }
	saveSessionIndex(idx, storage);
}

export function removeSessionFromIndex(sessionId: string, storage: IStorageService): void {
	const idx = loadSessionIndex(storage);
	idx.sessions = idx.sessions.filter(s => s.sessionId !== sessionId);
	saveSessionIndex(idx, storage);
}


// ─── Schema migration ─────────────────────────────────────────────────────────

/**
 * Mutates the KB in place to bring it up to the current schema version.
 * Add a new case here when KNOWLEDGE_BASE_VERSION is incremented.
 */
export function migrateSchema(kb: IModernisationKnowledgeBase): void {
	if (kb.version >= KNOWLEDGE_BASE_VERSION) { return; }

	// v0 → v1: no structural changes; just ensure new optional fields exist
	if (kb.version < 1) {
		if (!kb.decisions.exclusions)     { (kb.decisions as any).exclusions = []; }
		if (!kb.decisions.patternOverrides) { (kb.decisions as any).patternOverrides = []; }
		if (!kb.glossary.patterns)        { (kb.glossary as any).patterns = []; }
	}

	kb.version = KNOWLEDGE_BASE_VERSION;
}
