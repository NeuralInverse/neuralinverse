/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # External Result Cache
 *
 * Content-hash–based cache for external tool results.
 *
 * ## Problem
 *
 * External tools like Polyspace can take 20-30 minutes to run. Re-running them
 * on every keystroke or even on every save would be prohibitive. We need a
 * way to skip re-analysis when the source content hasn't changed.
 *
 * ## Solution
 *
 * For **file-scope** tools: hash the file's text content with a simple djb2-style
 * 32-bit hash. If the hash matches the stored value, return cached results.
 *
 * For **workspace-scope** tools: hash a fingerprint derived from each tracked
 * file's `{relativePath}:{mtime}` pair (sorted for stability). This avoids
 * reading file contents for the whole workspace.
 *
 * ## Persistence
 *
 * Results are persisted across IDE restarts using `IStorageService` with
 * `StorageScope.WORKSPACE`. Each entry is keyed by `ruleId:scope:targetKey`.
 *
 * ## Eviction
 *
 * Entries are evicted when:
 * - The content hash changes (re-running returns fresh results).
 * - `invalidate()` is called explicitly (e.g. after a framework reload).
 * - The entry is older than MAX_AGE_MS (7 days) regardless of hash.
 *
 * See: docs/EXTERNAL_ANALYSIS_BRIDGE.md — Part 6
 */

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { ICheckResult } from '../types/grcTypes.js';


// ─── Service Interface ────────────────────────────────────────────────────────

export const IExternalResultCache = createDecorator<IExternalResultCache>('neuralInverseExternalResultCache');

export interface IExternalResultCache {
	readonly _serviceBrand: undefined;

	/**
	 * Look up cached results for a (rule, content-hash) pair.
	 *
	 * @param cacheKey   Unique key: `${ruleId}:${scope}:${targetKey}`
	 * @param contentHash  Current hash of the content being analysed.
	 * @returns Results if cache hit, undefined if miss or stale.
	 */
	get(cacheKey: string, contentHash: number): Map<string, ICheckResult[]> | undefined;

	/**
	 * Store results in the cache.
	 *
	 * @param cacheKey    Same key used in get().
	 * @param contentHash Hash of the content that produced these results.
	 * @param results     Per-file results map to store.
	 */
	set(cacheKey: string, contentHash: number, results: Map<string, ICheckResult[]>): void;

	/**
	 * Remove a single entry from the cache (e.g. after a framework rule change).
	 */
	invalidate(cacheKey: string): void;

	/**
	 * Remove all cached entries.
	 */
	invalidateAll(): void;
}


// ─── Entry Shape ─────────────────────────────────────────────────────────────

interface ICacheEntry {
	contentHash: number;
	storedAt: number;
	/** Map serialized as array of [fileUri, results[]] pairs */
	results: Array<[string, ICheckResult[]]>;
}


// ─── Constants ────────────────────────────────────────────────────────────────

/** Entries older than this are evicted regardless of hash match. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const STORAGE_PREFIX = 'neuralInverse.extCache.';


// ─── Implementation ───────────────────────────────────────────────────────────

export class ExternalResultCacheImpl implements IExternalResultCache {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
	) { }

	get(cacheKey: string, contentHash: number): Map<string, ICheckResult[]> | undefined {
		const raw = this._storageService.get(STORAGE_PREFIX + cacheKey, StorageScope.WORKSPACE);
		if (!raw) {
			return undefined;
		}

		let entry: ICacheEntry;
		try {
			entry = JSON.parse(raw);
		} catch {
			return undefined;
		}

		// Evict stale entries
		if (Date.now() - entry.storedAt > MAX_AGE_MS) {
			this._storageService.remove(STORAGE_PREFIX + cacheKey, StorageScope.WORKSPACE);
			return undefined;
		}

		// Hash mismatch \u2192 content changed
		if (entry.contentHash !== contentHash) {
			return undefined;
		}

		// Reconstruct Map
		return new Map(entry.results);
	}

	set(cacheKey: string, contentHash: number, results: Map<string, ICheckResult[]>): void {
		const entry: ICacheEntry = {
			contentHash,
			storedAt: Date.now(),
			results: Array.from(results.entries()),
		};

		try {
			this._storageService.store(
				STORAGE_PREFIX + cacheKey,
				JSON.stringify(entry),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
		} catch (e) {
			// Storage can fail if quota exceeded; not fatal
			console.warn('[ExternalResultCache] Failed to persist cache entry:', e);
		}
	}

	invalidate(cacheKey: string): void {
		this._storageService.remove(STORAGE_PREFIX + cacheKey, StorageScope.WORKSPACE);
	}

	invalidateAll(): void {
		// Collect all keys with our prefix and remove them
		const keys = this._storageService.keys(StorageScope.WORKSPACE, StorageTarget.MACHINE);
		for (const key of keys) {
			if (key.startsWith(STORAGE_PREFIX)) {
				this._storageService.remove(key, StorageScope.WORKSPACE);
			}
		}
	}
}


// ─── Hash Utilities ───────────────────────────────────────────────────────────

/**
 * Fast djb2-style 32-bit hash for a string.
 * Good enough for cache keying; not cryptographic.
 */
export function hashString(s: string): number {
	let hash = 5381;
	for (let i = 0; i < s.length; i++) {
		hash = ((hash << 5) + hash) + s.charCodeAt(i);
		hash |= 0; // Force 32-bit integer
	}
	return hash >>> 0; // Unsigned
}

/**
 * Build a workspace fingerprint hash from a list of {path, mtime} pairs.
 *
 * @param files Sorted list of tracked files with their modification times.
 */
export function hashWorkspaceFingerprint(files: Array<{ path: string; mtime: number }>): number {
	const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	const fingerprint = sorted.map(f => `${f.path}:${f.mtime}`).join('|');
	return hashString(fingerprint);
}


// ─── Registration ─────────────────────────────────────────────────────────────

registerSingleton(IExternalResultCache, ExternalResultCacheImpl, InstantiationType.Delayed);
