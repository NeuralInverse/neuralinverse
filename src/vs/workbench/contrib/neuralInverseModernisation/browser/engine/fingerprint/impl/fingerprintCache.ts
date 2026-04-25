/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Fingerprint Cache
 *
 * In-memory LRU cache for compliance fingerprints. Avoids redundant LLM calls
 * when the same source text is fingerprinted multiple times within a session.
 *
 * ## Cache Key
 *
 * key = FNV-1a(sourceText) + ':' + schemaVersion
 *
 * This means:
 *   - Source text changes \u2192 cache miss \u2192 re-extract
 *   - Schema version bumps \u2192 cache miss \u2192 re-extract
 *   - Neither changes \u2192 cache hit \u2192 instant return
 *
 * ## Persistence
 *
 * The cache is IN-MEMORY ONLY. It does not persist across IDE restarts.
 * The Knowledge Base (IKnowledgeBaseService) is the persistent store.
 * This cache is purely a runtime optimisation to avoid duplicate LLM calls
 * during a session (e.g. comparing the same unit twice).
 *
 * ## Capacity
 *
 * Default capacity: 10,000 entries. LRU eviction when full.
 */

import { IComplianceFingerprint } from '../../../../common/modernisationTypes.js';
import { FINGERPRINT_SCHEMA_VERSION } from './fingerprintVersioning.js';


// \u2500\u2500\u2500 FNV-1a Hash \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * FNV-1a 32-bit hash.
 *
 * Used for cache keying: fast, low collision probability for typical source text
 * lengths. NOT cryptographic \u2014 do not use for security purposes.
 *
 * Returns an 8-character lowercase hex string.
 */
export function fnv1a32(text: string): string {
	// FNV offset basis and prime for 32-bit
	let hash = 0x811c9dc5;
	const FNV_PRIME = 0x01000193;

	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		// Multiply modulo 2^32
		hash = (Math.imul(hash, FNV_PRIME)) >>> 0;
	}

	return hash.toString(16).padStart(8, '0');
}

/**
 * Build a cache key from source text and schema version.
 */
export function buildCacheKey(sourceText: string, schemaVersion: number = FINGERPRINT_SCHEMA_VERSION): string {
	return `${fnv1a32(sourceText)}:${schemaVersion}`;
}


// \u2500\u2500\u2500 LRU Cache Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * A single cache entry with access metadata for LRU eviction.
 */
interface ICacheEntry {
	fingerprint: IComplianceFingerprint;
	/** Unix timestamp of most recent access */
	lastAccessed: number;
	/** Number of times this entry has been served from cache */
	hitCount: number;
}

/**
 * In-memory LRU fingerprint cache.
 *
 * Thread-safety: JavaScript is single-threaded; no locking needed.
 */
export class FingerprintCache {
	private readonly _entries = new Map<string, ICacheEntry>();
	private readonly _capacity: number;

	/** Total cache hits since instantiation */
	private _hitCount = 0;
	/** Total cache misses since instantiation */
	private _missCount = 0;
	/** Total entries evicted since instantiation */
	private _evictionCount = 0;

	constructor(capacity = 10_000) {
		this._capacity = capacity;
	}

	// \u2500\u2500 Read \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Get a fingerprint by cache key.
	 * Returns undefined if not in cache (cache miss).
	 * Updates the entry's lastAccessed timestamp on hit.
	 */
	get(key: string): IComplianceFingerprint | undefined {
		const entry = this._entries.get(key);
		if (!entry) {
			this._missCount++;
			return undefined;
		}
		entry.lastAccessed = Date.now();
		entry.hitCount++;
		this._hitCount++;
		return entry.fingerprint;
	}

	/**
	 * Get a fingerprint by source text (computes cache key internally).
	 */
	getBySource(sourceText: string): IComplianceFingerprint | undefined {
		const key = buildCacheKey(sourceText);
		return this.get(key);
	}

	// \u2500\u2500 Write \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Store a fingerprint by cache key.
	 * If the cache is at capacity, evicts the least recently used entry first.
	 */
	set(key: string, fingerprint: IComplianceFingerprint): void {
		// Update in place if already exists
		const existing = this._entries.get(key);
		if (existing) {
			existing.fingerprint = fingerprint;
			existing.lastAccessed = Date.now();
			return;
		}

		// Evict LRU entry if at capacity
		if (this._entries.size >= this._capacity) {
			this._evictLRU();
		}

		this._entries.set(key, {
			fingerprint,
			lastAccessed: Date.now(),
			hitCount: 0,
		});
	}

	/**
	 * Store a fingerprint by source text (computes cache key internally).
	 * Returns the computed cache key for the caller to store.
	 */
	setBySource(sourceText: string, fingerprint: IComplianceFingerprint): string {
		const key = buildCacheKey(sourceText);
		this.set(key, fingerprint);
		return key;
	}

	// \u2500\u2500 Invalidation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Remove a specific cache entry by key.
	 * Returns true if the entry existed and was removed.
	 */
	delete(key: string): boolean {
		return this._entries.delete(key);
	}

	/**
	 * Remove all cache entries whose fingerprint has the given unitId.
	 * Called when a unit is invalidated (e.g. after source drift).
	 * Returns the number of entries removed.
	 */
	invalidateUnit(unitId: string): number {
		let removed = 0;
		for (const [key, entry] of this._entries) {
			if (entry.fingerprint.unitId === unitId) {
				this._entries.delete(key);
				removed++;
			}
		}
		return removed;
	}

	/**
	 * Remove all entries whose fingerprint has a schemaVersion below the given threshold.
	 * Used at startup to purge fingerprints produced by an older extraction schema.
	 * Returns the number of entries removed.
	 */
	invalidateStaleVersions(currentVersion: number): number {
		let removed = 0;
		for (const [key, entry] of this._entries) {
			const v = entry.fingerprint.schemaVersion;
			if (v === undefined || v < currentVersion) {
				this._entries.delete(key);
				removed++;
			}
		}
		return removed;
	}

	/**
	 * Clear the entire cache.
	 */
	clear(): void {
		this._entries.clear();
	}

	// \u2500\u2500 Statistics \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Number of entries currently in the cache */
	get size(): number {
		return this._entries.size;
	}

	/** Maximum capacity of the cache */
	get capacity(): number {
		return this._capacity;
	}

	/** Total hit count since instantiation */
	get hitCount(): number {
		return this._hitCount;
	}

	/** Total miss count since instantiation */
	get missCount(): number {
		return this._missCount;
	}

	/** Total eviction count since instantiation */
	get evictionCount(): number {
		return this._evictionCount;
	}

	/**
	 * Cache hit rate as a percentage 0\u2013100. Returns 0 if no accesses yet.
	 */
	get hitRate(): number {
		const total = this._hitCount + this._missCount;
		if (total === 0) {
			return 0;
		}
		return Math.round((this._hitCount / total) * 100);
	}

	// \u2500\u2500 LRU Eviction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _evictLRU(): void {
		let oldestKey: string | undefined;
		let oldestTime = Infinity;

		for (const [key, entry] of this._entries) {
			if (entry.lastAccessed < oldestTime) {
				oldestTime = entry.lastAccessed;
				oldestKey = key;
			}
		}

		if (oldestKey) {
			this._entries.delete(oldestKey);
			this._evictionCount++;
		}
	}
}
