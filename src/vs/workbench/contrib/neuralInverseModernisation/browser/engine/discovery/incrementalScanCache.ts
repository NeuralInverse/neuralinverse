/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Incremental Scan Cache
 *
 * Persists per-file discovery results between scan sessions so that unchanged
 * files can be skipped on re-scan. This is critical for large legacy codebases
 * (mainframe COBOL repos can have thousands of programs) where a full re-scan
 * would take minutes.
 *
 * ## Cache Design
 *
 * - **Location**: `.inverse/scan-cache.json` in the project root (one file per project).
 * - **Key**: SHA-256 hash of the file's raw bytes content.
 * - **Value**: The full `IFileProcessResult` for that file, plus the file URI
 *   and a `cachedAt` timestamp.
 * - **Invalidation**: TTL-based (entries older than `CACHE_TTL_MS` are expired).
 *   Content-hash invalidates automatically (different hash = cache miss).
 * - **Size Cap**: Maximum `MAX_CACHE_ENTRIES` entries; LRU eviction when exceeded.
 *
 * ## Limitations
 *
 * - The cache does NOT invalidate when dependent files change (e.g., a COBOL
 *   copybook change that affects multiple programs). Callers should force a full
 *   rescan when build files or shared includes change.
 * - Cache file is JSON-serialised and may grow large on first run. It is
 *   excluded from `.gitignore` by convention (added by `fileWalker.ts` SKIP_DIRS).
 */

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IFileProcessResult } from './discoveryTypes.js';

// \u2500\u2500\u2500 Constants \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const CACHE_DIR        = '.inverse';
const CACHE_FILE       = 'scan-cache.json';
const CACHE_TTL_MS     = 7 * 24 * 60 * 60 * 1000;  // 7 days
const MAX_CACHE_ENTRIES = 5_000;
const CACHE_VERSION    = 2;


// \u2500\u2500\u2500 Types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface ICacheEntry {
	contentHash: string;
	fileUri: string;
	cachedAt: number;
	result: IFileProcessResult;
}

interface ICacheFile {
	version: number;
	entries: Record<string, ICacheEntry>;  // keyed by fileUri (relative path)
}


// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class IncrementalScanCache {
	private _data: ICacheFile = { version: CACHE_VERSION, entries: {} };
	private _dirty = false;
	private _loaded = false;

	constructor(
		private readonly _projectRoot: URI,
		private readonly _fileService: IFileService,
	) {}

	/** Load the cache file from disk. Call once before scanning. */
	async load(): Promise<void> {
		try {
			const cacheUri = this._cacheUri();
			const buf = await this._fileService.readFile(cacheUri);
			const raw = JSON.parse(buf.value.toString()) as ICacheFile;
			if (raw.version !== CACHE_VERSION) {
				// Version mismatch \u2014 discard and start fresh
				this._data = { version: CACHE_VERSION, entries: {} };
			} else {
				this._data = raw;
				this._pruneExpired();
			}
		} catch {
			// Cache does not exist yet or parse error \u2014 start fresh
			this._data = { version: CACHE_VERSION, entries: {} };
		}
		this._loaded = true;
	}

	/**
	 * Try to retrieve a cached `IFileProcessResult` for a file.
	 *
	 * @param fileUri     Absolute URI of the source file
	 * @param contentHash SHA-256 hex hash of the file's content
	 * @returns The cached result, or `undefined` on cache miss or hash mismatch
	 */
	get(fileUri: URI, contentHash: string): IFileProcessResult | undefined {
		if (!this._loaded) { return undefined; }
		const key = this._key(fileUri);
		const entry = this._data.entries[key];
		if (!entry) { return undefined; }
		if (entry.contentHash !== contentHash) { return undefined; }
		if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
			delete this._data.entries[key];
			this._dirty = true;
			return undefined;
		}
		return entry.result;
	}

	/**
	 * Store a `IFileProcessResult` in the cache.
	 */
	set(fileUri: URI, contentHash: string, result: IFileProcessResult): void {
		const key = this._key(fileUri);
		this._data.entries[key] = {
			contentHash,
			fileUri:  fileUri.toString(),
			cachedAt: Date.now(),
			result,
		};
		this._dirty = true;
		this._evictIfNeeded();
	}

	/** Persist the cache to disk if it has been modified. */
	async flush(): Promise<void> {
		if (!this._dirty) { return; }
		try {
			const cacheUri = this._cacheUri();
			const json = JSON.stringify(this._data, null, 2);
			const encoded = new TextEncoder().encode(json);
			await this._fileService.writeFile(cacheUri, {
				buffer: encoded,
				size:   encoded.byteLength,
				mtime:  Date.now(),
				etag:   '',
				name:   CACHE_FILE,
				// VSCode internal: cast to satisfy type, actual resource is the URI
			} as any);
			this._dirty = false;
		} catch {
			// Non-fatal \u2014 cache write failures should not interrupt scanning
		}
	}

	/** Invalidate the entire cache (e.g., after a GRC framework update). */
	invalidateAll(): void {
		this._data = { version: CACHE_VERSION, entries: {} };
		this._dirty = true;
	}

	/** Remove all entries for files in a specific subdirectory. */
	invalidateDirectory(dirPath: string): void {
		const normDir = dirPath.replace(/\\/g, '/').toLowerCase();
		for (const key of Object.keys(this._data.entries)) {
			if (key.toLowerCase().startsWith(normDir)) {
				delete this._data.entries[key];
				this._dirty = true;
			}
		}
	}

	/** Return the number of entries currently in the cache. */
	get size(): number { return Object.keys(this._data.entries).length; }


	// \u2500\u2500\u2500 Private \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _cacheUri(): URI {
		return URI.joinPath(this._projectRoot, CACHE_DIR, CACHE_FILE);
	}

	private _key(fileUri: URI): string {
		// Store relative path as key for portability (project root may move)
		const rootPath = this._projectRoot.path.replace(/\\/g, '/');
		const filePath = fileUri.path.replace(/\\/g, '/');
		return filePath.startsWith(rootPath)
			? filePath.slice(rootPath.length).replace(/^\//, '')
			: fileUri.toString();
	}

	private _pruneExpired(): void {
		const now = Date.now();
		let pruned = false;
		for (const [key, entry] of Object.entries(this._data.entries)) {
			if (now - entry.cachedAt > CACHE_TTL_MS) {
				delete this._data.entries[key];
				pruned = true;
			}
		}
		if (pruned) { this._dirty = true; }
	}

	private _evictIfNeeded(): void {
		const entries = Object.entries(this._data.entries);
		if (entries.length <= MAX_CACHE_ENTRIES) { return; }

		// LRU: sort by cachedAt ascending, remove oldest entries
		entries.sort((a, b) => a[1].cachedAt - b[1].cachedAt);
		const toEvict = entries.slice(0, entries.length - MAX_CACHE_ENTRIES);
		for (const [key] of toEvict) {
			delete this._data.entries[key];
		}
	}
}


// \u2500\u2500\u2500 Content Hashing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Compute a fast 32-bit FNV-1a hash of a string.
 *
 * This is not cryptographic but is sufficient for cache invalidation.
 * Using FNV-1a instead of SHA-256 because:
 *  - No async SubtleCrypto required
 *  - 10-50× faster for typical file sizes
 *  - Collision probability is negligible for content-change detection
 */
export function fnv1aHash(content: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < content.length; i++) {
		hash ^= content.charCodeAt(i);
		// FNV prime: 0x01000193
		hash = (hash * 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, '0');
}

/**
 * Compute a SHA-256 hash of raw bytes using the Web Crypto API.
 * Returns a lowercase hex string.
 * Use this for higher-fidelity change detection when SubtleCrypto is available.
 */
export async function sha256Hash(bytes: Uint8Array): Promise<string> {
	if (typeof crypto !== 'undefined' && crypto.subtle) {
		const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
		return Array.from(new Uint8Array(hashBuffer))
			.map(b => b.toString(16).padStart(2, '0'))
			.join('');
	}
	// Fallback: FNV-1a on the decoded string
	const text = new TextDecoder().decode(bytes);
	return fnv1aHash(text);
}
