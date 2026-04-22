/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # File Walker
 *
 * Recursively walks a project directory tree and returns URIs for all files
 * whose extension is in the `SOURCE_EXTS` allow-list.
 *
 * ## Guards
 *
 * - **SKIP_DIRS**: well-known non-source directories are skipped unconditionally.
 * - **Symlink cycle guard**: tracks visited directory URIs to prevent infinite loops.
 * - **Depth limit**: `MAX_WALK_DEPTH` prevents runaway recursion on pathological trees.
 * - **File cap**: `MAX_FILES_PER_PROJECT` caps the total number of source files returned,
 *   protecting the scanner from scanning enormous repos end-to-end.
 * - **Binary detection**: `isBinary()` inspects the first 8 KB of a file's bytes
 *   and rejects it if it contains null bytes or >30 % non-printable characters.
 * - **Size guard**: files larger than `MAX_FILE_BYTES` are excluded from sub-unit
 *   decomposition but are still returned as file-level units (see `DiscoveryService`).
 */

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';


// ─── Constants ────────────────────────────────────────────────────────────────

/** Directory names to skip unconditionally during tree walk. */
export const SKIP_DIRS = new Set([
	// Version control
	'.git', '.svn', '.hg', '.bzr',
	// Package managers / build output
	'node_modules', 'bower_components', 'vendor',
	'dist', 'build', 'out', 'output', 'target',
	'bin', 'obj', '.bin',
	// Language/runtime caches
	'__pycache__', '.venv', 'venv', 'env', '.env',
	'.gradle', '.mvn', '.ivy2',
	'.idea', '.vs', '.vscode',
	// Framework output
	'.next', '.nuxt', '.output', '.angular',
	'.svelte-kit', 'storybook-static',
	// Test coverage output
	'coverage', '.nyc_output', '.coverage',
	// Other
	'.inverse', '.cache', 'tmp', 'temp', '.tmp',
	'logs', 'log',
]);

/** File extensions recognised as source code. */
export const SOURCE_EXTS = new Set([
	// ── Mainframe / Legacy ───────────────────────────────────────────────
	'cbl', 'cob', 'cpy', 'cobol',
	'rpg', 'rpgle', 'sqlrpgle', 'clp', 'clle',
	'nat', 'nsp',
	'pl1', 'pli',
	'jcl',
	'rexx', 'rex', 'cmd',
	'asm', 'macro', 'mac', 'mlc',
	// ── Database / SQL ────────────────────────────────────────────────────
	'sql', 'pls', 'pkb', 'pks', 'ddl', 'dml', 'trg', 'fnc', 'prc', 'vw',
	// ── JVM ──────────────────────────────────────────────────────────────
	'java', 'kt', 'kts', 'scala', 'groovy', 'gradle',
	// ── .NET ─────────────────────────────────────────────────────────────
	'cs', 'vb', 'fs', 'fsx',
	// ── Web ──────────────────────────────────────────────────────────────
	'ts', 'tsx', 'mts', 'cts',
	'js', 'jsx', 'mjs', 'cjs',
	// ── Python / Scripting ────────────────────────────────────────────────
	'py', 'pyw',
	'rb', 'rake',
	'pl', 'pm',
	'lua',
	// ── Systems ───────────────────────────────────────────────────────────
	'go',
	'rs',
	'c', 'h',
	'cpp', 'cc', 'cxx', 'hpp', 'hxx',
	// ── Firmware / Embedded ──────────────────────────────────────────────────
	's',                          // ARM / RISC-V assembly
	'asm51',                      // 8051 assembly
	'inc',                        // Assembly include
	'svd',                        // CMSIS SVD peripheral description
	'ld', 'scf', 'xcl',          // Linker scripts (GNU LD / ARM Scatter / IAR)
	'cmake', 'cmakelists',        // CMake build
	// ── IEC 61131-3 / PLC ────────────────────────────────────────────────────
	'st', 'il', 'fbd', 'sfc', 'pou', 'ldr', 'exp',
	// ── AUTOSAR ──────────────────────────────────────────────────────────────
	'arxml',                      // AUTOSAR SWC / ECU description
	// ── CAN / LIN / FlexRay ──────────────────────────────────────────────────
	'dbc', 'sym',                 // CAN DBC signal database / symbol file
	'ldf',                        // LIN description file
	'opf',                        // FlexRay parameter file
	// ── Telecom ──────────────────────────────────────────────────────────────
	'ttcn', 'ttcn3', 'ttcnpp',   // TTCN-3 test modules
	// ── Other Languages ───────────────────────────────────────────────────
	'php', 'swift', 'dart',
	'r', 'jl',
	'clj', 'cljs',
	'ex', 'exs',
	'erl', 'hrl',
	// ── Shell ─────────────────────────────────────────────────────────────
	'sh', 'bash', 'zsh', 'ksh',
]);

/** Maximum files to return per project. Protects against huge repos. */
export const MAX_FILES_PER_PROJECT = 1000;

/** Maximum directory recursion depth. */
export const MAX_WALK_DEPTH = 30;

/** Maximum file size (bytes) to attempt full processing on. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

/** Maximum file size to attempt sub-unit decomposition on. */
export const MAX_DECOMPOSE_BYTES = 512 * 1024; // 512 KB

/** Number of bytes to read for binary detection. */
const BINARY_SAMPLE_BYTES = 8192;

/** Non-printable ratio threshold above which a file is considered binary. */
const BINARY_RATIO_THRESHOLD = 0.30;


// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Recursively walk `root`, returning source-code file URIs.
 *
 * @param root        The directory to start from
 * @param fileService VS Code file service
 * @param onProgress  Optional callback fired for each directory entered
 */
export async function walkFiles(
	root: URI,
	fileService: IFileService,
	onProgress?: (dir: string) => void,
): Promise<URI[]> {
	const results: URI[] = [];
	const visitedDirs = new Set<string>();
	await walkRecursive(root, 0, visitedDirs, results, fileService, onProgress);
	return results;
}

/**
 * Detect whether a byte array represents binary (non-text) content.
 * Inspects a leading sample only (up to `BINARY_SAMPLE_BYTES` bytes).
 */
export function isBinary(bytes: Uint8Array): boolean {
	const limit = Math.min(bytes.length, BINARY_SAMPLE_BYTES);
	let nonPrintable = 0;
	for (let i = 0; i < limit; i++) {
		const b = bytes[i];
		if (b === 0) { return true; }                         // null byte → binary
		if (b < 9 || (b > 13 && b < 32)) { nonPrintable++; } // non-ASCII control chars
	}
	return limit > 0 && nonPrintable / limit > BINARY_RATIO_THRESHOLD;
}

/**
 * Strip the UTF-8 BOM (U+FEFF) if present at the start of the string.
 */
export function stripBOM(content: string): string {
	return content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
}


// ─── Internal ─────────────────────────────────────────────────────────────────

async function walkRecursive(
	dir: URI,
	depth: number,
	visitedDirs: Set<string>,
	results: URI[],
	fileService: IFileService,
	onProgress?: (dir: string) => void,
): Promise<void> {
	if (depth > MAX_WALK_DEPTH)              { return; }
	if (results.length >= MAX_FILES_PER_PROJECT) { return; }

	const key = dir.toString();
	if (visitedDirs.has(key)) { return; }  // symlink cycle guard
	visitedDirs.add(key);

	onProgress?.(dir.path);

	let entries;
	try {
		entries = await fileService.resolve(dir, { resolveMetadata: false });
	} catch {
		return;
	}
	if (!entries.children) { return; }

	// Process directories first (breadth ordering improves progress feel)
	const dirs:  typeof entries.children = [];
	const files: typeof entries.children = [];

	for (const child of entries.children) {
		if (child.isDirectory) { dirs.push(child); }
		else if (!child.isDirectory) { files.push(child); }
	}

	// Accept matching files
	for (const file of files) {
		if (results.length >= MAX_FILES_PER_PROJECT) { return; }
		const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
		if (SOURCE_EXTS.has(ext)) {
			results.push(file.resource);
		}
	}

	// Recurse into subdirectories (skip known non-source dirs)
	for (const subdir of dirs) {
		if (results.length >= MAX_FILES_PER_PROJECT) { return; }
		if (SKIP_DIRS.has(subdir.name.toLowerCase())) { continue; }
		await walkRecursive(subdir.resource, depth + 1, visitedDirs, results, fileService, onProgress);
	}
}
