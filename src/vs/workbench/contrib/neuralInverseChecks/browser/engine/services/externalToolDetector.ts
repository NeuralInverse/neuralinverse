/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # External Tool Detector
 *
 * Checks whether an external binary (semgrep, matlab, polyspace-bug-finder, etc.)
 * is available in PATH before attempting to run it.
 *
 * ## Design
 *
 * Static class \u2014 no DI required. Callers pass in an exec function so this
 * class is trivially testable and has no dependency on ITerminalService.
 *
 * Results are cached at module level for 60 seconds per binary name.
 * This covers the common case of a tool being installed mid-session
 * without hammering the filesystem on every scan.
 *
 * See: docs/EXTERNAL_ANALYSIS_BRIDGE.md \u2014 Part 3
 */

import { isWindows } from '../../../../../../base/common/platform.js';


// \u2500\u2500\u2500 Cache \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface ICacheEntry {
	available: boolean;
	version?: string;
	checkedAt: number;
}

/** Module-level cache shared across all callers */
const _cache = new Map<string, ICacheEntry>();

/** How long to trust a cached availability result */
const CACHE_TTL_MS = 60_000;


// \u2500\u2500\u2500 ExternalToolDetector \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class ExternalToolDetector {

	/**
	 * Check whether a binary is available in PATH.
	 *
	 * Uses `which <binary>` on Unix/macOS or `where <binary>.cmd` on Windows.
	 * Result is cached for 60 seconds.
	 *
	 * @param binaryName  e.g. 'semgrep', 'matlab', 'polyspace-bug-finder'
	 * @param execFn      Async function that runs a shell command and returns stdout.
	 *                    Provided by ExternalCommandExecutor at runtime.
	 */
	static async isAvailable(
		binaryName: string,
		execFn: (cmd: string) => Promise<string>
	): Promise<boolean> {
		const cached = _cache.get(binaryName);
		if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
			return cached.available;
		}

		const checkCmd = isWindows
			? `where "${binaryName}.exe" "${binaryName}.cmd" "${binaryName}" 2>nul`
			: `which "${binaryName}" 2>/dev/null`;

		try {
			const stdout = await execFn(checkCmd);
			const available = stdout.trim().length > 0;
			_cache.set(binaryName, { available, checkedAt: Date.now() });
			return available;
		} catch {
			// `which` exits non-zero when binary not found \u2014 execFn may throw
			_cache.set(binaryName, { available: false, checkedAt: Date.now() });
			return false;
		}
	}

	/**
	 * Get the version string for a tool.
	 *
	 * Runs the provided version command and returns the first line of stdout.
	 * Returns undefined if the command fails or binary is not found.
	 *
	 * @param binaryName      e.g. 'semgrep'
	 * @param versionCommand  e.g. 'semgrep --version'
	 * @param execFn          Same exec function as isAvailable
	 */
	static async getVersion(
		binaryName: string,
		versionCommand: string,
		execFn: (cmd: string) => Promise<string>
	): Promise<string | undefined> {
		const cached = _cache.get(binaryName);

		// Return cached version if entry is fresh
		if (cached && cached.version && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
			return cached.version;
		}

		try {
			const stdout = await execFn(versionCommand);
			const version = stdout.split('\n')[0].trim() || undefined;

			// Update cache entry with version
			const existing = _cache.get(binaryName);
			_cache.set(binaryName, {
				available: true,
				version,
				checkedAt: existing?.checkedAt ?? Date.now(),
			});

			return version;
		} catch {
			return undefined;
		}
	}

	/**
	 * Invalidate the cached result for a binary.
	 * Call this if a tool was just installed and should be re-detected.
	 */
	static invalidate(binaryName: string): void {
		_cache.delete(binaryName);
	}

	/**
	 * Clear the entire detection cache.
	 */
	static clearCache(): void {
		_cache.clear();
	}
}
