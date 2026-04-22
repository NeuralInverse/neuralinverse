/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # C Header / SVD Inliner
 *
 * The firmware equivalent of the COBOL copybook inliner.
 *
 * Takes an embedded C/C++ source text and a function to read dependency files,
 * then returns a fully expanded source where every `#include` of a project-local
 * header has been replaced with the header's content — recursively.
 *
 * ## Scope
 *
 * Only **project-local** headers are inlined (those in angle-bracket includes
 * that resolve to a file within the project search paths, or all quote-style
 * includes). System headers (<stdint.h>, <stdbool.h>, <cmsis_gcc.h>, etc.) are
 * left as-is with a comment noting they are system-provided.
 *
 * Additionally, if a CMSIS SVD file is available for the project, peripheral
 * register definitions (`#define GPIOA_BASE  0x40020000UL`) extracted from the
 * SVD are injected as a synthetic header block so the AI sees named constants
 * rather than raw hex addresses.
 *
 * ## Recursive Expansion
 *
 * Headers can themselves contain `#include` statements. The inliner recursively
 * expands them up to MAX_EXPANSION_DEPTH levels deep. A cycle guard prevents
 * infinite loops from circular includes.
 *
 * ## Expansion Markers
 *
 * When insertMarkers === true (default), the inliner wraps each inlined header:
 *
 *   // ── INCLUDE bsp/uart.h EXPANDED (bsp/uart.h) ───────────────────────────
 *   ... header content ...
 *   // ── END INCLUDE bsp/uart.h ───────────────────────────────────────────────
 *
 * ## Search Path Strategy
 *
 * To resolve `"bsp/uart.h"` to a file path, the inliner tries:
 * 1. Same directory as the source file
 * 2. Provided search paths (from IResolutionRequest.searchPaths)
 * 3. Common embedded project subdirectory names: Core/Inc, Drivers, BSP, Inc, include
 *
 * File extensions tried (in order): as-written (with path), .h, .hpp, (none)
 */

import { IDependencyRef, IDependencyResolutionResult } from './resolutionTypes.js';
import { ResolutionFileCache, DependencyNameResolutionCache } from './resolutionCache.js';


// ─── Configuration ────────────────────────────────────────────────────────────

/** Common embedded project header search subdirectory names */
const HEADER_SUBDIRS = [
	'Inc', 'inc', 'include', 'Include',
	'Core/Inc', 'Core/include',
	'BSP', 'bsp',
	'Drivers',
	'Middlewares',
	'CMSIS',
	'hal',
	'common', 'shared',
];

/** System headers that should NOT be inlined */
const SYSTEM_HEADER_PREFIXES = [
	'stdint', 'stdbool', 'stddef', 'stdarg', 'stdio', 'stdlib', 'string', 'math',
	'cmsis', 'core_cm', 'arm_', 'mpu_armv', 'cache',
	'stm32', 'nxp', 'esp_', 'zephyr/', 'FreeRTOS', 'freertos/',
	'task.h', 'queue.h', 'semphr.h', 'event_groups.h', 'stream_buffer.h', 'timers.h',
	'kernel.h', 'device.h', 'drivers/', 'sys/', 'net/', 'linker/',
];

/** Marker comment style matching C/C++ conventions */
const MARKER_LINE = (text: string): string =>
	`// ── ${text} ${'─'.repeat(Math.max(0, 72 - text.length - 6))}`;


// ─── Public API ───────────────────────────────────────────────────────────────

export interface ICHeaderInlineOptions {
	insertMarkers: boolean;
	insertResolutionHeader: boolean;
	maxExpansionDepth: number;
	maxInlineSize: number;
	/** If provided, inject SVD-derived register definitions as a synthetic header */
	svdRegisterBlock?: string;
}

export interface ICHeaderInlineResult {
	expandedSource: string;
	resolvedRefs: IDependencyResolutionResult[];
	unresolvedRefs: IDependencyResolutionResult[];
	cycleRefs: IDependencyResolutionResult[];
}

/**
 * Inline all local `#include` statements in `sourceText`, reading header files
 * via `readFile`. System headers are annotated but not expanded.
 *
 * @param sourceText    The raw C/C++ source text
 * @param sourceFileUri Absolute URI of the source file (for relative path resolution)
 * @param searchPaths   Additional include directories
 * @param readFile      Async function to read a file by absolute URI
 * @param listDir       Async function to list directory entries
 * @param fileCache     Shared file content cache
 * @param nameCache     Shared name-to-path cache
 * @param options       Inliner options
 */
export async function inlineCHeaders(
	sourceText: string,
	sourceFileUri: string,
	searchPaths: string[],
	readFile: (uri: string) => Promise<string>,
	listDir: (dirUri: string) => Promise<string[]>,
	fileCache: ResolutionFileCache,
	nameCache: DependencyNameResolutionCache,
	options: ICHeaderInlineOptions,
): Promise<ICHeaderInlineResult> {
	const resolvedRefs: IDependencyResolutionResult[] = [];
	const unresolvedRefs: IDependencyResolutionResult[] = [];
	const cycleRefs: IDependencyResolutionResult[] = [];

	const sourceDir = getParentDir(sourceFileUri);
	const allSearchDirs = buildSearchDirs(sourceDir, searchPaths);

	// Prepend SVD register block if provided
	const preamble = options.svdRegisterBlock
		? `\n// ── SVD-DERIVED REGISTER DEFINITIONS (auto-injected) ──────────────────────\n${options.svdRegisterBlock}\n// ── END SVD BLOCK ────────────────────────────────────────────────────────────\n\n`
		: '';

	const expanded = await expandIncludes(
		sourceText,
		allSearchDirs,
		readFile,
		listDir,
		fileCache,
		nameCache,
		options,
		new Set<string>(),
		0,
		resolvedRefs,
		unresolvedRefs,
		cycleRefs,
	);

	const finalSource = options.insertResolutionHeader
		? preamble + buildResolutionHeader(resolvedRefs, unresolvedRefs, cycleRefs) + '\n' + expanded
		: preamble + expanded;

	return { expandedSource: finalSource, resolvedRefs, unresolvedRefs, cycleRefs };
}


// ─── Core Expansion Logic ─────────────────────────────────────────────────────

async function expandIncludes(
	text: string,
	searchDirs: string[],
	readFile: (uri: string) => Promise<string>,
	listDir: (dirUri: string) => Promise<string[]>,
	fileCache: ResolutionFileCache,
	nameCache: DependencyNameResolutionCache,
	options: ICHeaderInlineOptions,
	cycleGuard: Set<string>,
	depth: number,
	resolvedRefs: IDependencyResolutionResult[],
	unresolvedRefs: IDependencyResolutionResult[],
	cycleRefs: IDependencyResolutionResult[],
): Promise<string> {
	if (depth > options.maxExpansionDepth) {
		return text + '\n// [RESOLUTION] Max expansion depth reached — remaining #includes not expanded\n';
	}

	const includeRefs = parseIncludeStatements(text);
	if (includeRefs.length === 0) { return text; }

	let result = text;

	// Process in reverse order to preserve offsets
	const sortedRefs = [...includeRefs].sort((a, b) => b.startOffset - a.startOffset);

	for (const ref of sortedRefs) {
		const canonicalName = ref.headerPath;

		// Skip system headers — annotate but do not expand
		if (isSystemHeader(canonicalName)) {
			const systemComment = `// [SYSTEM HEADER] ${ref.fullStatement.trim()}  — not expanded (system-provided)\n`;
			result = replaceRange(result, ref.startOffset, ref.endOffset, systemComment);
			continue;
		}

		// Cycle detection
		if (cycleGuard.has(canonicalName)) {
			const depRef: IDependencyRef = {
				rawRef: ref.fullStatement,
				canonicalName,
				line: ref.line,
				depType: 'c-header',
			};
			cycleRefs.push({
				ref: depRef,
				resolved: false,
				inlinedContent: '',
				failureReason: `Circular include: ${canonicalName} is already being expanded`,
			});
			const cycleComment = `\n// [RESOLUTION CYCLE] #include "${canonicalName}" — circular reference detected, skipped\n`;
			result = replaceRange(result, ref.startOffset, ref.endOffset, cycleComment);
			continue;
		}

		// Try to find the header file
		const headerUri = await resolveHeaderName(canonicalName, searchDirs, listDir, nameCache);

		if (!headerUri) {
			const depRef: IDependencyRef = {
				rawRef: ref.fullStatement,
				canonicalName,
				line: ref.line,
				depType: 'c-header',
			};
			unresolvedRefs.push({
				ref: depRef,
				resolved: false,
				inlinedContent: '',
				failureReason: `Header not found: ${canonicalName} (searched ${searchDirs.length} directories)`,
			});
			const notFoundComment = `// [RESOLUTION MISSING] ${ref.fullStatement.trim()}  — header not found in project search paths\n`;
			result = replaceRange(result, ref.startOffset, ref.endOffset, notFoundComment);
			continue;
		}

		// Read header content (use cache)
		let headerContent = fileCache.get(headerUri);
		if (!headerContent) {
			try {
				headerContent = await readFile(headerUri);
				fileCache.set(headerUri, headerContent);
			} catch (err) {
				const depRef: IDependencyRef = {
					rawRef: ref.fullStatement,
					canonicalName,
					line: ref.line,
					depType: 'c-header',
				};
				unresolvedRefs.push({
					ref: depRef,
					resolved: false,
					inlinedContent: '',
					resolvedFilePath: headerUri,
					failureReason: `Failed to read header file: ${err instanceof Error ? err.message : String(err)}`,
				});
				result = replaceRange(result, ref.startOffset, ref.endOffset,
					`// [RESOLUTION ERROR] #include "${canonicalName}" — could not read file: ${headerUri}\n`
				);
				continue;
			}
		}

		// Truncate if too large
		let inlinedContent = headerContent;
		if (inlinedContent.length > options.maxInlineSize) {
			inlinedContent = inlinedContent.slice(0, options.maxInlineSize) +
				`\n// [RESOLUTION TRUNCATED] Header ${canonicalName} truncated at ${options.maxInlineSize} characters\n`;
		}

		// Recursively expand nested includes in the header
		const innerCycleGuard = new Set(cycleGuard);
		innerCycleGuard.add(canonicalName);

		inlinedContent = await expandIncludes(
			inlinedContent,
			searchDirs,
			readFile,
			listDir,
			fileCache,
			nameCache,
			options,
			innerCycleGuard,
			depth + 1,
			resolvedRefs,
			unresolvedRefs,
			cycleRefs,
		);

		// Wrap with expansion markers if requested
		const expandedBlock = options.insertMarkers
			? buildExpansionBlock(canonicalName, headerUri, inlinedContent)
			: inlinedContent;

		result = replaceRange(result, ref.startOffset, ref.endOffset, expandedBlock);

		const depRef: IDependencyRef = {
			rawRef: ref.fullStatement,
			canonicalName,
			line: ref.line,
			depType: 'c-header',
		};
		resolvedRefs.push({
			ref: depRef,
			resolved: true,
			inlinedContent: expandedBlock,
			resolvedFilePath: headerUri,
		});
	}

	return result;
}


// ─── Include Statement Parser ─────────────────────────────────────────────────

interface IParsedIncludeStatement {
	fullStatement: string;
	headerPath: string;          // The path as written in the #include
	isSystemInclude: boolean;    // true if angle-bracket style
	line: number;
	startOffset: number;
	endOffset: number;
}

function parseIncludeStatements(text: string): IParsedIncludeStatement[] {
	const results: IParsedIncludeStatement[] = [];

	// Match: #include "path/to/file.h"  or  #include <file.h>
	// Handles optional spaces between # and include
	const INCLUDE_RE = /^[ \t]*#[ \t]*include[ \t]+([<"])([^>"]+)[>"][ \t]*(?:\/\/[^\n]*)?\n?/gm;

	let match: RegExpExecArray | null;
	while ((match = INCLUDE_RE.exec(text)) !== null) {
		const openDelim  = match[1];
		const headerPath = match[2];
		const isSystem   = openDelim === '<';

		const lineNum = text.substring(0, match.index).split('\n').length;

		results.push({
			fullStatement:   match[0],
			headerPath,
			isSystemInclude: isSystem,
			line:            lineNum,
			startOffset:     match.index,
			endOffset:       match.index + match[0].length,
		});
	}

	return results;
}


// ─── System Header Detection ──────────────────────────────────────────────────

function isSystemHeader(headerPath: string): boolean {
	const lower = headerPath.toLowerCase();
	return SYSTEM_HEADER_PREFIXES.some(prefix => lower.startsWith(prefix.toLowerCase()));
}


// ─── File Search ──────────────────────────────────────────────────────────────

async function resolveHeaderName(
	headerPath: string,
	searchDirs: string[],
	listDir: (dirUri: string) => Promise<string[]>,
	nameCache: DependencyNameResolutionCache,
): Promise<string | undefined> {
	const cached = nameCache.get(headerPath);
	if (cached !== undefined) { return cached ?? undefined; }

	// The headerPath may contain subdirectory components (e.g. "bsp/uart.h")
	const fileName = headerPath.split('/').pop() ?? headerPath;
	const subPath  = headerPath; // full relative path as written

	for (const dir of searchDirs) {
		// Try the full relative path first
		const candidateUri = joinUri(dir, subPath);
		try {
			const entries = await listDir(dir);
			const found = entries.find(e =>
				e.toLowerCase() === fileName.toLowerCase() ||
				e.toLowerCase() === subPath.toLowerCase()
			);
			if (found) {
				const resolvedUri = joinUri(dir, found);
				nameCache.set(headerPath, resolvedUri);
				return resolvedUri;
			}
		} catch {
			// Directory doesn't exist — try next
		}
		void candidateUri;
	}

	nameCache.setNotFound(headerPath);
	return undefined;
}

function buildSearchDirs(sourceDir: string, additionalPaths: string[]): string[] {
	const dirs: string[] = [sourceDir];

	for (const p of additionalPaths) {
		if (!dirs.includes(p)) { dirs.push(p); }
	}

	for (const subdir of HEADER_SUBDIRS) {
		const candidate = joinUri(sourceDir, subdir);
		if (!dirs.includes(candidate)) { dirs.push(candidate); }
		const parentDir = getParentDir(sourceDir);
		const parentCandidate = joinUri(parentDir, subdir);
		if (!dirs.includes(parentCandidate)) { dirs.push(parentCandidate); }
	}

	return dirs;
}


// ─── Expansion Markers ────────────────────────────────────────────────────────

function buildExpansionBlock(headerPath: string, filePath: string, content: string): string {
	const fileName = filePath.split('/').pop() ?? filePath;
	const header = MARKER_LINE(`INCLUDE ${headerPath} EXPANDED (${fileName})`);
	const footer = MARKER_LINE(`END INCLUDE ${headerPath}`);
	return `\n${header}\n${content}\n${footer}\n`;
}

function buildResolutionHeader(
	resolved: IDependencyResolutionResult[],
	unresolved: IDependencyResolutionResult[],
	cycles: IDependencyResolutionResult[],
): string {
	const lines: string[] = [
		'// ══════════════════════════════════════════════════════════════════════════',
		'// NEURAL INVERSE — HEADER DEPENDENCY RESOLUTION REPORT',
		`// Resolved:   ${resolved.length} header(s)`,
		`// Unresolved: ${unresolved.length} header(s)${unresolved.length > 0 ? ' — marked with [RESOLUTION MISSING]' : ''}`,
		`// Cycles:     ${cycles.length} circular reference(s)${cycles.length > 0 ? ' — marked with [RESOLUTION CYCLE]' : ''}`,
		'// ══════════════════════════════════════════════════════════════════════════',
		'',
	];

	if (unresolved.length > 0) {
		lines.push('// UNRESOLVED HEADERS:');
		for (const u of unresolved) {
			lines.push(`//   ${u.ref.canonicalName} — ${u.failureReason ?? 'not found'}`);
		}
		lines.push('');
	}

	return lines.join('\n');
}


// ─── String Utilities ─────────────────────────────────────────────────────────

function replaceRange(text: string, start: number, end: number, replacement: string): string {
	return text.slice(0, start) + replacement + text.slice(end);
}

function getParentDir(uri: string): string {
	const normalised = uri.replace(/\\/g, '/');
	const lastSlash = normalised.lastIndexOf('/');
	return lastSlash > 0 ? normalised.slice(0, lastSlash) : normalised;
}

function joinUri(base: string, name: string): string {
	const normalised = base.replace(/\\/g, '/').replace(/\/$/, '');
	return `${normalised}/${name}`;
}


// ─── Dependency Reference Extractor (for metrics) ─────────────────────────────

/**
 * Extract all #include dependency references from C/C++ source for metrics purposes.
 * This is a lighter version of inlineCHeaders — it only extracts refs, does not expand them.
 */
export function extractCHeaderDependencyRefs(sourceText: string): IDependencyRef[] {
	const refs: IDependencyRef[] = [];
	const parsed = parseIncludeStatements(sourceText);

	for (const inc of parsed) {
		refs.push({
			rawRef:        inc.fullStatement,
			canonicalName: inc.headerPath,
			line:          inc.line,
			depType:       'c-header',
		});
	}

	return refs;
}
