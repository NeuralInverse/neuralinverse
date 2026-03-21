/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # COBOL Copybook Inliner
 *
 * The core of the COBOL wall problem solution.
 *
 * Takes a COBOL program's source text and a function to read dependency files,
 * then returns a fully expanded source where every COPY statement has been
 * replaced with the copybook's content — recursively.
 *
 * ## COBOL COPY Statement Variants
 *
 * 1. Basic:    `COPY CUSTMAST.`
 * 2. Library:  `COPY CUSTMAST OF CUSTLIB.`
 * 3. Replace:  `COPY CUSTMAST REPLACING ==WS-CUST-BAL== BY ==WS-ACCT-BAL==.`
 * 4. Both:     `COPY CUSTMAST OF CUSTLIB REPLACING ==OLD== BY ==NEW==.`
 * 5. Suppress: `COPY CUSTMAST SUPPRESS.` (copies without listing — we still inline)
 *
 * ## Fixed vs Free Format
 *
 * - Fixed-format COBOL: columns 1-6 = sequence, col 7 = indicator (* = comment),
 *   cols 8-11 = area A, cols 12-72 = area B. COPY statements start in area B.
 * - Free-format COBOL (IDENTIFICATION DIVISION. FREE): no column restrictions.
 *
 * The inliner handles both formats. It identifies the format from content heuristics
 * (presence of sequence numbers in cols 1-6, 6-char numeric prefix, etc.).
 *
 * ## Recursive Expansion
 *
 * Copybooks can themselves contain COPY statements. The inliner recursively expands
 * them up to MAX_EXPANSION_DEPTH levels deep. A cycle guard prevents infinite loops.
 *
 * Example cycle:
 *   COPY A → expands A → A contains COPY B → expands B → B contains COPY A → STOP
 *   The second COPY A is replaced with a comment explaining the cycle.
 *
 * ## REPLACING Clause
 *
 * REPLACING allows text substitution during copying:
 *   `COPY CUSTMAST REPLACING ==WS-OLD-NAME== BY ==WS-NEW-NAME==.`
 *
 * The inliner applies all REPLACING pairs before inserting the copybook content.
 * Pseudo-text delimiters (== ... ==) are stripped; matching is case-insensitive
 * and handles both tokens and partial-token matches (COBOL allows partial replacement).
 *
 * ## Expansion Markers
 *
 * When insertMarkers === true (default), the inliner wraps each inlined copybook
 * with visible markers:
 *
 *   *> ── COPY CUSTMAST EXPANDED (CUSTMAST.cpy) ─────────────────────────────
 *   ... copybook content ...
 *   *> ── END COPY CUSTMAST ────────────────────────────────────────────────────
 *
 * This makes the expanded source easy to navigate and clearly shows where each
 * copybook's content begins and ends.
 *
 * ## Search Path Strategy
 *
 * To resolve "CUSTMAST" to a file path, the inliner tries:
 * 1. Same directory as the source file
 * 2. Provided search paths (from IResolutionRequest.searchPaths)
 * 3. Common subdirectory names: COPYLIB, CPY, COPYBOOKS, COPY, INC, INCLUDE
 *
 * File extensions tried (in order): .cpy, .cbl, .copy, .cob, .txt, (none)
 */

import { IDependencyRef, IDependencyResolutionResult } from './resolutionTypes.js';
import { ResolutionFileCache, DependencyNameResolutionCache } from './resolutionCache.js';


// ─── Configuration ────────────────────────────────────────────────────────────


/** File extensions to try when searching for a copybook by name */
const COPYBOOK_EXTENSIONS = ['.cpy', '.cbl', '.copy', '.cob', '.txt', ''];

/** Common subdirectory names used for COBOL copybook libraries */
const COPYBOOK_SUBDIRS = ['copylib', 'cpy', 'copybooks', 'copy', 'inc', 'include', 'lib', 'common', 'shared'];

/** Marker comment style for COBOL (free-format compatible) */
const MARKER_LINE = (text: string): string => `*> ── ${text} ${'─'.repeat(Math.max(0, 72 - text.length - 6))}`;


// ─── Public API ───────────────────────────────────────────────────────────────

export interface ICobolInlineOptions {
	insertMarkers: boolean;
	insertResolutionHeader: boolean;
	maxExpansionDepth: number;
	maxInlineSize: number;
}

export interface ICobolInlineResult {
	expandedSource: string;
	resolvedRefs: IDependencyResolutionResult[];
	unresolvedRefs: IDependencyResolutionResult[];
	cycleRefs: IDependencyResolutionResult[];
}

/**
 * Inline all COPY statements in `sourceText`, reading copybook files via `readFile`.
 *
 * @param sourceText    The raw COBOL source text
 * @param sourceFileUri Absolute URI of the source file (used for relative path resolution)
 * @param searchPaths   Additional directories to search for copybooks
 * @param readFile      Async function to read a file by absolute URI
 * @param fileCache     Shared file content cache (avoids re-reading files)
 * @param nameCache     Shared name-to-path cache (avoids re-scanning directories)
 * @param options       Inliner options
 */
export async function inlineCobolCopybooks(
	sourceText: string,
	sourceFileUri: string,
	searchPaths: string[],
	readFile: (uri: string) => Promise<string>,
	listDir: (dirUri: string) => Promise<string[]>,
	fileCache: ResolutionFileCache,
	nameCache: DependencyNameResolutionCache,
	options: ICobolInlineOptions,
): Promise<ICobolInlineResult> {
	const resolvedRefs: IDependencyResolutionResult[] = [];
	const unresolvedRefs: IDependencyResolutionResult[] = [];
	const cycleRefs: IDependencyResolutionResult[] = [];

	const sourceDir = getParentDir(sourceFileUri);
	const allSearchDirs = buildSearchDirs(sourceDir, searchPaths);

	const expanded = await expandCopyStatements(
		sourceText,
		allSearchDirs,
		readFile,
		listDir,
		fileCache,
		nameCache,
		options,
		new Set<string>(),  // cycle guard: currently expanding these names
		0,
		resolvedRefs,
		unresolvedRefs,
		cycleRefs,
	);

	const finalSource = options.insertResolutionHeader
		? buildResolutionHeader(resolvedRefs, unresolvedRefs, cycleRefs) + '\n' + expanded
		: expanded;

	return { expandedSource: finalSource, resolvedRefs, unresolvedRefs, cycleRefs };
}


// ─── Core Expansion Logic ─────────────────────────────────────────────────────

async function expandCopyStatements(
	text: string,
	searchDirs: string[],
	readFile: (uri: string) => Promise<string>,
	listDir: (dirUri: string) => Promise<string[]>,
	fileCache: ResolutionFileCache,
	nameCache: DependencyNameResolutionCache,
	options: ICobolInlineOptions,
	cycleGuard: Set<string>,
	depth: number,
	resolvedRefs: IDependencyResolutionResult[],
	unresolvedRefs: IDependencyResolutionResult[],
	cycleRefs: IDependencyResolutionResult[],
): Promise<string> {
	if (depth > options.maxExpansionDepth) {
		return text + '\n*> [RESOLUTION] Max expansion depth reached — remaining COPY statements not expanded\n';
	}

	// Parse all COPY statements in this text
	const copyRefs = parseCopyStatements(text);
	if (copyRefs.length === 0) {
		return text;
	}

	let result = text;

	// Process each COPY statement, expanding from last to first to preserve offsets
	// We process in reverse so that character offsets remain valid as we replace
	const sortedRefs = [...copyRefs].sort((a, b) => b.startOffset - a.startOffset);

	for (const ref of sortedRefs) {
		const canonicalName = ref.copyName.toUpperCase();

		// Cycle detection
		if (cycleGuard.has(canonicalName)) {
			const depRef: IDependencyRef = {
				rawRef: ref.fullStatement,
				canonicalName,
				line: ref.line,
				depType: 'cobol-copy',
				replacingPairs: ref.replacingPairs,
			};
			cycleRefs.push({
				ref: depRef,
				resolved: false,
				inlinedContent: '',
				failureReason: `Circular dependency: ${canonicalName} is already being expanded`,
			});
			const cycleComment = `\n*> [RESOLUTION CYCLE] COPY ${canonicalName} — circular reference detected, skipped\n`;
			result = replaceRange(result, ref.startOffset, ref.endOffset, cycleComment);
			continue;
		}

		// Try to find and read the copybook
		const copybookUri = await resolveCopybookName(canonicalName, searchDirs, listDir, nameCache);

		if (!copybookUri) {
			const depRef: IDependencyRef = {
				rawRef: ref.fullStatement,
				canonicalName,
				line: ref.line,
				depType: 'cobol-copy',
				replacingPairs: ref.replacingPairs,
			};
			unresolvedRefs.push({
				ref: depRef,
				resolved: false,
				inlinedContent: '',
				failureReason: `Copybook not found: ${canonicalName} (searched ${searchDirs.length} directories)`,
			});
			// Leave the COPY statement in place but add a comment explaining it couldn't be resolved
			const notFoundComment = `*> [RESOLUTION MISSING] ${ref.fullStatement.trim()}  — copybook not found\n`;
			result = replaceRange(result, ref.startOffset, ref.endOffset, notFoundComment);
			continue;
		}

		// Read copybook content (use cache to avoid re-reading)
		let copybookContent = fileCache.get(copybookUri);
		if (!copybookContent) {
			try {
				copybookContent = await readFile(copybookUri);
				fileCache.set(copybookUri, copybookContent);
			} catch (err) {
				const depRef: IDependencyRef = {
					rawRef: ref.fullStatement,
					canonicalName,
					line: ref.line,
					depType: 'cobol-copy',
				};
				unresolvedRefs.push({
					ref: depRef,
					resolved: false,
					inlinedContent: '',
					resolvedFilePath: copybookUri,
					failureReason: `Failed to read copybook file: ${err instanceof Error ? err.message : String(err)}`,
				});
				result = replaceRange(result, ref.startOffset, ref.endOffset,
					`*> [RESOLUTION ERROR] COPY ${canonicalName} — could not read file: ${copybookUri}\n`
				);
				continue;
			}
		}

		// Apply REPLACING clause if present
		let inlinedContent = ref.replacingPairs && ref.replacingPairs.length > 0
			? applyReplacing(copybookContent, ref.replacingPairs)
			: copybookContent;

		// Truncate if too large
		if (inlinedContent.length > options.maxInlineSize) {
			inlinedContent = inlinedContent.slice(0, options.maxInlineSize) +
				`\n*> [RESOLUTION TRUNCATED] Copybook ${canonicalName} truncated at ${options.maxInlineSize} characters\n`;
		}

		// Recursively expand nested COPY statements in the copybook
		const innerCycleGuard = new Set(cycleGuard);
		innerCycleGuard.add(canonicalName);

		inlinedContent = await expandCopyStatements(
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
			? buildExpansionBlock(canonicalName, copybookUri, inlinedContent)
			: inlinedContent;

		// Replace the COPY statement with the expanded content
		result = replaceRange(result, ref.startOffset, ref.endOffset, expandedBlock);

		const depRef: IDependencyRef = {
			rawRef: ref.fullStatement,
			canonicalName,
			line: ref.line,
			depType: 'cobol-copy',
			replacingPairs: ref.replacingPairs,
		};
		resolvedRefs.push({
			ref: depRef,
			resolved: true,
			inlinedContent: expandedBlock,
			resolvedFilePath: copybookUri,
		});
	}

	return result;
}


// ─── COPY Statement Parser ────────────────────────────────────────────────────

interface IParsedCopyStatement {
	fullStatement: string;       // The full COPY ... . text
	copyName: string;            // The copybook name
	libraryName?: string;        // Optional OF library-name
	replacingPairs: Array<{ from: string; to: string }>;
	isSuppressed: boolean;
	line: number;
	startOffset: number;         // Character offset in the text where COPY starts
	endOffset: number;           // Character offset of the character AFTER the trailing period
}

/**
 * Parse all COPY statements from COBOL source text.
 *
 * Handles:
 * - Multi-line COPY statements (COBOL allows line continuation)
 * - Both fixed-format and free-format COBOL
 * - REPLACING with multiple ==old== BY ==new== pairs
 * - Comments (lines with * in col 7 for fixed format, or *> for free format)
 */
function parseCopyStatements(text: string): IParsedCopyStatement[] {
	const results: IParsedCopyStatement[] = [];

	// We use a regex that handles the common cases.
	// The tricky part is that COPY statements can span multiple lines in fixed-format.
	// Strategy: join continuation lines, then parse.
	const normalized = normalizeForParsing(text);

	// Regex for COPY statement:
	// COPY <name> [OF <lib>] [REPLACING ==old== BY ==new== [==old2== BY ==new2==]...] [SUPPRESS] .
	const COPY_RE = /\bCOPY\s+([A-Z0-9$#@-]+)(?:\s+OF\s+([A-Z0-9$#@-]+))?(\s+REPLACING\s+.+?)?\s*(?:SUPPRESS\s*)?\./gi;

	let match: RegExpExecArray | null;
	while ((match = COPY_RE.exec(normalized.joinedText)) !== null) {
		const fullStatement = match[0];
		const copyName = match[1];
		const libraryName = match[2];
		const replacingClause = match[3];

		const replacingPairs = replacingClause
			? parseReplacingClause(replacingClause)
			: [];

		const isSuppressed = /\bSUPPRESS\b/i.test(fullStatement);

		// Map back to original text offsets
		const originalOffset = normalized.offsetMap.get(match.index) ?? match.index;
		const originalEnd = normalized.offsetMap.get(match.index + fullStatement.length) ?? (originalOffset + fullStatement.length);

		// Calculate line number from the original text
		const lineNum = text.substring(0, originalOffset).split('\n').length;

		results.push({
			fullStatement,
			copyName: copyName.toUpperCase(),
			libraryName: libraryName?.toUpperCase(),
			replacingPairs,
			isSuppressed,
			line: lineNum,
			startOffset: originalOffset,
			endOffset: originalEnd,
		});
	}

	return results;
}

/**
 * Normalise a COBOL source for parsing:
 * 1. Strip fixed-format sequence numbers (cols 1-6)
 * 2. Skip comment lines (col 7 = '*' or 'D' in fixed format, or *> prefix)
 * 3. Join continuation lines (col 7 = '-')
 *
 * Returns the normalised text AND an offset map to translate positions back.
 */
function normalizeForParsing(text: string): { joinedText: string; offsetMap: Map<number, number> } {
	const lines = text.split('\n');
	const isFreeFormat = detectFreeFormat(lines);

	const outputChars: string[] = [];
	const offsetMap = new Map<number, number>();

	let originalOffset = 0;
	let normalizedOffset = 0;

	for (const line of lines) {
		const lineLen = line.length + 1; // +1 for the \n we stripped

		if (isFreeFormat) {
			// Free format: skip comment lines starting with *>
			const trimmed = line.trim();
			if (trimmed.startsWith('*>') || trimmed.startsWith('*')) {
				originalOffset += lineLen;
				continue;
			}
			// Map: normalizedOffset → originalOffset
			offsetMap.set(normalizedOffset, originalOffset);
			const content = line + '\n';
			outputChars.push(content);
			normalizedOffset += content.length;
		} else {
			// Fixed format: sequence nums in cols 1-6, indicator in col 7
			if (line.length < 7) {
				originalOffset += lineLen;
				continue;
			}
			const indicator = line[6];
			if (indicator === '*' || indicator === '/' || indicator === 'D' || indicator === 'd') {
				// Comment or debug line
				originalOffset += lineLen;
				continue;
			}
			if (indicator === '-') {
				// Continuation line — strip leading whitespace and prepend to previous output
				const content = line.slice(7).trimStart() + ' ';
				offsetMap.set(normalizedOffset, originalOffset + 7);
				outputChars.push(content);
				normalizedOffset += content.length;
			} else {
				// Normal line — strip sequence numbers (cols 1-6) and indicator (col 7)
				const content = line.slice(7) + '\n';
				offsetMap.set(normalizedOffset, originalOffset + 7);
				outputChars.push(content);
				normalizedOffset += content.length;
			}
		}

		originalOffset += lineLen;
	}

	return { joinedText: outputChars.join(''), offsetMap };
}

/**
 * Detect whether COBOL source is in free format or fixed format.
 * Heuristic: if the first 5 lines have 6-char numeric sequence numbers, it's fixed.
 */
function detectFreeFormat(lines: string[]): boolean {
	const sampleLines = lines.slice(0, 10).filter(l => l.length >= 7);
	if (sampleLines.length === 0) {
		return true;
	}
	const fixedCount = sampleLines.filter(l => /^\d{6}/.test(l)).length;
	return fixedCount < sampleLines.length / 2;
}


// ─── REPLACING Clause Parser ──────────────────────────────────────────────────

/**
 * Parse the REPLACING clause into substitution pairs.
 *
 * Input:  " REPLACING ==WS-OLD-BAL== BY ==WS-NEW-BAL== ==OLD-RATE== BY ==NEW-RATE=="
 * Output: [{ from: "WS-OLD-BAL", to: "WS-NEW-BAL" }, { from: "OLD-RATE", to: "NEW-RATE" }]
 */
function parseReplacingClause(replacingClause: string): Array<{ from: string; to: string }> {
	const pairs: Array<{ from: string; to: string }> = [];

	// Match ==text== BY ==text== patterns
	const pairRe = /==([^=]*)==\s+BY\s+==([^=]*)==/gi;
	let match: RegExpExecArray | null;

	while ((match = pairRe.exec(replacingClause)) !== null) {
		pairs.push({
			from: match[1].trim(),
			to: match[2].trim(),
		});
	}

	return pairs;
}

/**
 * Apply REPLACING substitutions to copybook content.
 * COBOL REPLACING is token-based and case-insensitive.
 */
function applyReplacing(content: string, pairs: Array<{ from: string; to: string }>): string {
	let result = content;
	for (const { from, to } of pairs) {
		if (!from) {
			continue;
		}
		// Word-boundary replacement, case-insensitive
		const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		try {
			result = result.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), to);
		} catch {
			// Invalid regex from special characters — skip this pair
		}
	}
	return result;
}


// ─── File Search ──────────────────────────────────────────────────────────────

/**
 * Search for a copybook file by canonical name in the given search directories.
 *
 * Returns the absolute URI of the found file, or undefined if not found.
 * Uses the name-to-path cache to avoid repeated directory scans.
 */
async function resolveCopybookName(
	canonicalName: string,
	searchDirs: string[],
	listDir: (dirUri: string) => Promise<string[]>,
	nameCache: DependencyNameResolutionCache,
): Promise<string | undefined> {
	// Check cache first
	const cached = nameCache.get(canonicalName);
	if (cached !== undefined) {
		return cached ?? undefined;
	}

	// Try each search directory + each extension
	for (const dir of searchDirs) {
		for (const ext of COPYBOOK_EXTENSIONS) {
			const candidateUri = joinUri(dir, canonicalName + ext);
			try {
				// List directory and check case-insensitively
				const entries = await listDir(dir);
				const found = entries.find(e => e.toUpperCase() === (canonicalName + ext).toUpperCase());
				if (found) {
					const resolvedUri = joinUri(dir, found);
					nameCache.set(canonicalName, resolvedUri);
					return resolvedUri;
				}
			} catch {
				// Directory doesn't exist or can't be read — try next
			}
			void candidateUri; // suppress unused warning
		}
	}

	// Not found — cache negative result
	nameCache.setNotFound(canonicalName);
	return undefined;
}

/**
 * Build the full list of directories to search for copybooks.
 */
function buildSearchDirs(sourceDir: string, additionalPaths: string[]): string[] {
	const dirs: string[] = [sourceDir];

	// Add provided search paths
	for (const p of additionalPaths) {
		if (!dirs.includes(p)) {
			dirs.push(p);
		}
	}

	// Add common copybook subdirectory names relative to the source directory
	for (const subdir of COPYBOOK_SUBDIRS) {
		const candidate = joinUri(sourceDir, subdir);
		if (!dirs.includes(candidate)) {
			dirs.push(candidate);
		}
		// Also try one level up (common in large COBOL projects)
		const parentDir = getParentDir(sourceDir);
		const parentCandidate = joinUri(parentDir, subdir);
		if (!dirs.includes(parentCandidate)) {
			dirs.push(parentCandidate);
		}
	}

	return dirs;
}


// ─── Expansion Markers ────────────────────────────────────────────────────────

function buildExpansionBlock(copyName: string, filePath: string, content: string): string {
	const fileName = filePath.split('/').pop() ?? filePath;
	const header = MARKER_LINE(`COPY ${copyName} EXPANDED (${fileName})`);
	const footer = MARKER_LINE(`END COPY ${copyName}`);
	return `\n${header}\n${content}\n${footer}\n`;
}

function buildResolutionHeader(
	resolved: IDependencyResolutionResult[],
	unresolved: IDependencyResolutionResult[],
	cycles: IDependencyResolutionResult[],
): string {
	const lines: string[] = [
		'*> ══════════════════════════════════════════════════════════════════',
		'*> NEURAL INVERSE — DEPENDENCY RESOLUTION REPORT',
		`*> Resolved:   ${resolved.length} copybook(s)`,
		`*> Unresolved: ${unresolved.length} copybook(s)${unresolved.length > 0 ? ' — marked with [RESOLUTION MISSING]' : ''}`,
		`*> Cycles:     ${cycles.length} circular reference(s)${cycles.length > 0 ? ' — marked with [RESOLUTION CYCLE]' : ''}`,
		'*> ══════════════════════════════════════════════════════════════════',
		'',
	];

	if (unresolved.length > 0) {
		lines.push('*> UNRESOLVED DEPENDENCIES:');
		for (const u of unresolved) {
			lines.push(`*>   ${u.ref.canonicalName} — ${u.failureReason ?? 'not found'}`);
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


// ─── COBOL Reference Extractor (for metrics) ──────────────────────────────────

/**
 * Extract all dependency references from a COBOL source for metrics purposes.
 * This is a lighter version of inlineCobolCopybooks — it only extracts refs,
 * does not expand them.
 */
export function extractCobolDependencyRefs(sourceText: string): IDependencyRef[] {
	const refs: IDependencyRef[] = [];
	const normalized = normalizeForParsing(sourceText);

	// COPY references
	const COPY_RE = /\bCOPY\s+([A-Z0-9$#@-]+)(?:\s+OF\s+([A-Z0-9$#@-]+))?(\s+REPLACING\s+.+?)?\s*(?:SUPPRESS\s*)?/gi;
	let match: RegExpExecArray | null;
	while ((match = COPY_RE.exec(normalized.joinedText)) !== null) {
		refs.push({
			rawRef: match[0],
			canonicalName: match[1].toUpperCase(),
			line: sourceText.substring(0, normalized.offsetMap.get(match.index) ?? match.index).split('\n').length,
			depType: 'cobol-copy',
			replacingPairs: match[3] ? parseReplacingClause(match[3]) : [],
		});
	}

	// CALL references
	const CALL_RE = /\bCALL\s+['"]([A-Z0-9$#@-]+)['"]/gi;
	while ((match = CALL_RE.exec(normalized.joinedText)) !== null) {
		refs.push({
			rawRef: match[0],
			canonicalName: match[1].toUpperCase(),
			line: sourceText.substring(0, normalized.offsetMap.get(match.index) ?? match.index).split('\n').length,
			depType: 'cobol-call',
		});
	}

	return refs;
}
