/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Resolution File Cache
 *
 * Caches the raw text content of dependency files (copybooks, package specs,
 * header files, data areas) to avoid re-reading the same file multiple times
 * during a batch resolution run.
 *
 * ## Why This Matters
 *
 * In a real COBOL project, a single copybook like `WS-COMMONS.cpy` might be
 * referenced by hundreds of programs. Without caching, a batch resolution of
 * 500 units would read WS-COMMONS hundreds of times. With caching, it's read once.
 *
 * ## Cache Scope
 *
 * The cache is scoped to a single resolution session. It does NOT persist across
 * IDE restarts (file content can change between sessions). The in-memory cache
 * is valid for the lifetime of the SourceResolutionServiceImpl instance.
 *
 * ## Key
 *
 * Cache key = normalised absolute file URI (lowercased on case-insensitive filesystems).
 * This ensures that `CUSTMAST.cpy`, `custmast.cpy`, and `CustMast.CPY` all map to
 * the same cache entry on case-insensitive filesystems.
 */


// ─── Types ────────────────────────────────────────────────────────────────────

interface ICacheEntry {
	content: string;
	sizeBytes: number;
	cachedAt: number;
	accessCount: number;
}

interface IResolutionFileCacheStats {
	hits: number;
	misses: number;
	entries: number;
	totalSizeBytes: number;
	hitRate: number;
}


// ─── Implementation ───────────────────────────────────────────────────────────

export class ResolutionFileCache {
	private readonly _entries = new Map<string, ICacheEntry>();
	private _hits = 0;
	private _misses = 0;
	private _totalSizeBytes = 0;

	/**
	 * Get cached file content by URI.
	 * Returns undefined if not cached.
	 */
	get(uri: string): string | undefined {
		const key = normaliseKey(uri);
		const entry = this._entries.get(key);
		if (!entry) {
			this._misses++;
			return undefined;
		}
		entry.accessCount++;
		this._hits++;
		return entry.content;
	}

	/**
	 * Store file content by URI.
	 */
	set(uri: string, content: string): void {
		const key = normaliseKey(uri);
		const existing = this._entries.get(key);
		if (existing) {
			this._totalSizeBytes -= existing.sizeBytes;
			existing.content = content;
			existing.sizeBytes = content.length;
			existing.cachedAt = Date.now();
			this._totalSizeBytes += existing.sizeBytes;
			return;
		}
		const entry: ICacheEntry = {
			content,
			sizeBytes: content.length,
			cachedAt: Date.now(),
			accessCount: 0,
		};
		this._entries.set(key, entry);
		this._totalSizeBytes += entry.sizeBytes;
	}

	/**
	 * Check if a URI is cached.
	 */
	has(uri: string): boolean {
		return this._entries.has(normaliseKey(uri));
	}

	/**
	 * Remove a specific URI from cache.
	 */
	invalidate(uri: string): void {
		const key = normaliseKey(uri);
		const entry = this._entries.get(key);
		if (entry) {
			this._totalSizeBytes -= entry.sizeBytes;
			this._entries.delete(key);
		}
	}

	/**
	 * Clear the entire cache.
	 */
	clear(): void {
		this._entries.clear();
		this._hits = 0;
		this._misses = 0;
		this._totalSizeBytes = 0;
	}

	/**
	 * Returns cache statistics.
	 */
	get stats(): IResolutionFileCacheStats {
		const total = this._hits + this._misses;
		return {
			hits: this._hits,
			misses: this._misses,
			entries: this._entries.size,
			totalSizeBytes: this._totalSizeBytes,
			hitRate: total === 0 ? 0 : Math.round((this._hits / total) * 100),
		};
	}

	/** Number of cached entries */
	get size(): number {
		return this._entries.size;
	}
}


// ─── Internal ─────────────────────────────────────────────────────────────────

/**
 * Normalise a URI for use as a cache key.
 * Lowercasing handles case-insensitive filesystems (Windows, macOS default).
 */
function normaliseKey(uri: string): string {
	return uri.toLowerCase().replace(/\\/g, '/');
}


// ─── Name-to-Path Resolution Cache ───────────────────────────────────────────

/**
 * A secondary cache mapping (dependencyName, searchPaths) \u2192 resolved absolute URI.
 *
 * When we successfully resolve "CUSTMAST" to "/project/copylib/CUSTMAST.cpy",
 * we cache this mapping so the next time "CUSTMAST" appears in any unit we
 * don't have to scan the search paths again.
 */
export class DependencyNameResolutionCache {
	private readonly _nameToUri = new Map<string, string | null>();
	private _hits = 0;
	private _misses = 0;

	/**
	 * Get the resolved URI for a dependency name.
	 * Returns null if the name was previously looked up but not found (negative cache).
	 * Returns undefined if this name has never been looked up.
	 */
	get(canonicalName: string): string | null | undefined {
		const key = canonicalName.toUpperCase();
		if (!this._nameToUri.has(key)) {
			this._misses++;
			return undefined;
		}
		this._hits++;
		return this._nameToUri.get(key);
	}

	/**
	 * Cache a successful resolution: name \u2192 resolved URI.
	 */
	set(canonicalName: string, resolvedUri: string): void {
		this._nameToUri.set(canonicalName.toUpperCase(), resolvedUri);
	}

	/**
	 * Cache a negative result: this name was looked up and not found.
	 * Prevents repeated filesystem searches for the same missing dependency.
	 */
	setNotFound(canonicalName: string): void {
		this._nameToUri.set(canonicalName.toUpperCase(), null);
	}

	/**
	 * Whether we have a cached result (positive or negative) for this name.
	 */
	has(canonicalName: string): boolean {
		return this._nameToUri.has(canonicalName.toUpperCase());
	}

	get hitRate(): number {
		const total = this._hits + this._misses;
		return total === 0 ? 0 : Math.round((this._hits / total) * 100);
	}

	get size(): number {
		return this._nameToUri.size;
	}

	clear(): void {
		this._nameToUri.clear();
		this._hits = 0;
		this._misses = 0;
	}
}
