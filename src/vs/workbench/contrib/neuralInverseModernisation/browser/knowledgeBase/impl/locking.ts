/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit locking — multi-agent concurrency control.
 *
 * Locks are purely in-memory (not persisted). They are short-lived TTL leases
 * granted to agents so two agents never translate the same unit simultaneously.
 * On process restart all locks vanish, which is intentional — stale locks from a
 * crashed agent are automatically cleared on next startup.
 */

import { IUnitLock } from '../../../common/knowledgeBaseTypes.js';
import { makeId } from './helpers.js';

export const DEFAULT_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Lock store ───────────────────────────────────────────────────────────────

/** Mutable in-memory lock store injected by KnowledgeBaseImpl */
export interface ILockStore {
	locks: Map<string, IUnitLock>; // unitId \u2192 lock
}

export function createLockStore(): ILockStore {
	return { locks: new Map() };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isExpired(lock: IUnitLock): boolean {
	if (lock.ttlMs === 0) { return false; } // indefinite
	return Date.now() > lock.acquiredAt + lock.ttlMs;
}

// ─── Acquire ──────────────────────────────────────────────────────────────────

/**
 * Attempt to acquire an exclusive lock on unitId for ownerId.
 * Returns the lock record on success, or undefined if already locked by another owner.
 *
 * Re-entrant: if ownerId already holds the lock, the TTL is refreshed and the
 * existing lock is returned.
 */
export function lockUnit(
	store: ILockStore,
	unitId: string,
	ownerId: string,
	ttlMs: number = DEFAULT_LOCK_TTL_MS,
): IUnitLock | undefined {
	const existing = store.locks.get(unitId);

	if (existing) {
		if (isExpired(existing)) {
			// Expired lock — evict and proceed
			store.locks.delete(unitId);
		} else if (existing.ownerId === ownerId) {
			// Re-entrant: refresh TTL
			const refreshed: IUnitLock = { ...existing, acquiredAt: Date.now(), ttlMs };
			store.locks.set(unitId, refreshed);
			return refreshed;
		} else {
			// Locked by someone else
			return undefined;
		}
	}

	const lock: IUnitLock = {
		id:         makeId('lk'),
		unitId,
		ownerId,
		acquiredAt: Date.now(),
		ttlMs,
	};
	store.locks.set(unitId, lock);
	return lock;
}

// ─── Release ──────────────────────────────────────────────────────────────────

/**
 * Release the lock on unitId.
 * Returns true if the lock was held by ownerId and successfully released.
 * Returns false if the unit was not locked by ownerId (no-op).
 */
export function unlockUnit(store: ILockStore, unitId: string, ownerId: string): boolean {
	const existing = store.locks.get(unitId);
	if (!existing || existing.ownerId !== ownerId) { return false; }
	store.locks.delete(unitId);
	return true;
}

/**
 * Force-release a lock regardless of owner.
 * Used by admin operations, timeout recovery, or the health-check auto-repair.
 */
export function forceUnlockUnit(store: ILockStore, unitId: string): void {
	store.locks.delete(unitId);
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function getLock(store: ILockStore, unitId: string): IUnitLock | undefined {
	const lock = store.locks.get(unitId);
	if (!lock) { return undefined; }
	if (isExpired(lock)) {
		store.locks.delete(unitId);
		return undefined;
	}
	return lock;
}

export function isUnitLocked(store: ILockStore, unitId: string): boolean {
	return getLock(store, unitId) !== undefined;
}

/**
 * Release all locks held by a specific ownerId.
 * Called when an agent process ends or is forcibly terminated.
 */
export function releaseAllLocksFor(store: ILockStore, ownerId: string): void {
	for (const [unitId, lock] of store.locks) {
		if (lock.ownerId === ownerId) {
			store.locks.delete(unitId);
		}
	}
}

/**
 * Sweep expired locks.
 * @returns Number of locks pruned.
 */
export function pruneExpiredLocks(store: ILockStore): number {
	let count = 0;
	const now = Date.now();
	for (const [unitId, lock] of store.locks) {
		if (lock.ttlMs > 0 && now > lock.acquiredAt + lock.ttlMs) {
			store.locks.delete(unitId);
			count++;
		}
	}
	return count;
}

export function getAllLocks(store: ILockStore): IUnitLock[] {
	// Prune expired before returning so callers always see live locks
	pruneExpiredLocks(store);
	return Array.from(store.locks.values());
}
