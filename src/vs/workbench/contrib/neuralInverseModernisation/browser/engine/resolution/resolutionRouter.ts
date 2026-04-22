/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Resolution Router
 *
 * Dispatches resolution work to the correct language-specific inliner based on
 * the unit's `sourceLang`. This is the central dispatch point for Phase 1 of the
 * modernisation engine — transforming a "pending" unit with opaque external
 * dependencies into a "ready" unit with a fully self-contained `resolvedSource`.
 *
 * ## Dispatch Table
 *
 * | Language key(s)                       | Inliner                          |
 * |---------------------------------------|----------------------------------|
 * | cobol, cbl, cob                       | cobolCopybookInliner             |
 * |                                       | + cobolCallResolver              |
 * | plsql, sql, oracle                    | plsqlTypeInliner                 |
 * | java                                  | javaInterfaceInliner             |
 * | rpg, rpgle, sqlrpgle, rpg4, ile-rpg   | rpgBindingInliner                |
 * | natural, nsp, nat                     | naturalDataAreaInliner           |
 * | typescript, javascript, tsx, jsx      | genericImportInliner             |
 * | python, python3                       | genericImportInliner             |
 * | go, golang                            | genericImportInliner             |
 * | rust                                  | genericImportInliner             |
 * | csharp, c#                            | genericImportInliner             |
 * | vb, vbnet, vb.net, visualbasic        | genericImportInliner             |
 * | kotlin, scala                         | genericImportInliner             |
 * | (anything else)                       | genericImportInliner (fallback)  |
 *
 * ## Resolution Flow Per Unit
 *
 * 1. Normalise the `sourceLang` key via `canonicaliseLanguage()`
 * 2. Build `readFile` / `listDir` adapters from `IFileService`
 * 3. Build search paths: source file's directory + all unique directories discovered
 *    in the KB for the same project
 * 4. Invoke the correct inliner (some languages use two inliners in sequence)
 * 5. Build the resolution header (summary comment prepended to resolved source)
 * 6. Combine resolved content and build an `IUnitResolutionResult`
 */

import { URI } from '../../../../../../base/common/uri.js';
import { IFileService, IFileStat } from '../../../../../../platform/files/common/files.js';
import { IKnowledgeBaseService } from '../../knowledgeBase/service.js';
import { canonicaliseLanguage } from '../fingerprint/impl/languageRegistry.js';
import {
	IResolutionRequest,
	IUnitResolutionResult,
	ResolutionOutcome,
	IDependencyResolutionResult,
} from './impl/resolutionTypes.js';
import { ResolutionFileCache, DependencyNameResolutionCache } from './impl/resolutionCache.js';

import { inlineCHeaders } from './impl/cobolCopybookInliner.js';
import { resolveCFunctionCalls } from './impl/cobolCallResolver.js';
import { resolvePlsqlTypes } from './impl/plsqlTypeInliner.js';
import { resolveJavaDependencies } from './impl/javaInterfaceInliner.js';
import { resolveRpgDependencies } from './impl/rpgBindingInliner.js';
import { resolveNaturalDependencies } from './impl/naturalDataAreaInliner.js';
import { resolveGenericImports } from './impl/genericImportInliner.js';


// ─── Router Options ───────────────────────────────────────────────────────────

export interface IRoutedResolutionOptions {
	maxExpansionDepth: number;
	maxInlineSize: number;
	insertExpansionMarkers: boolean;
	insertResolutionHeader: boolean;
	/** Additional search paths beyond what's derived from unit location */
	extraSearchPaths?: string[];
}


// ─── Main Router Entry Point ──────────────────────────────────────────────────

/**
 * Route a single unit's dependency resolution to the correct language inliner.
 * Returns a fully populated `IUnitResolutionResult`.
 */
export async function routeResolution(
	request: IResolutionRequest,
	kb: IKnowledgeBaseService,
	fileService: IFileService,
	fileCache: ResolutionFileCache,
	nameCache: DependencyNameResolutionCache,
	options: IRoutedResolutionOptions,
): Promise<IUnitResolutionResult> {
	const startMs = Date.now();

	const readFile = buildReadFileAdapter(fileService);
	const listDir  = buildListDirAdapter(fileService);

	// Build search paths: source file's directory + project-wide copy dirs + extras
	const searchPaths = buildSearchPaths(
		request.sourceFileUri,
		request.searchPaths,
		options.extraSearchPaths ?? [],
	);

	try {
		const result = await dispatchToInliner(
			request, kb, readFile, listDir, searchPaths, fileCache, nameCache, options,
		);

		// Truncate if the resolved source exceeds the maximum inline size
		let resolvedSource = result.expandedSource;
		if (resolvedSource.length > options.maxInlineSize) {
			resolvedSource = resolvedSource.slice(0, options.maxInlineSize) +
				`\n/* [RESOLUTION] Content truncated at ${options.maxInlineSize.toLocaleString()} characters */\n`;
		}

		// Prepend resolution header summary
		if (options.insertResolutionHeader && (result.resolvedRefs.length > 0 || result.unresolvedRefs.length > 0)) {
			resolvedSource = buildResolutionHeader(
				request.unitName,
				request.language,
				result.resolvedRefs,
				result.unresolvedRefs,
			) + resolvedSource;
		}

		const outcome = determineOutcome(result.resolvedRefs, result.unresolvedRefs, result.cycleDetected);

		return {
			unitId: request.unitId,
			unitName: request.unitName,
			language: request.language,
			outcome,
			resolvedSource,
			totalRefs: result.resolvedRefs.length + result.unresolvedRefs.length,
			resolvedRefs: result.resolvedRefs.length,
			unresolvedRefs: result.unresolvedRefs.length,
			resolvedDeps: result.resolvedRefs,
			unresolvedDeps: result.unresolvedRefs,
			cycleUnitIds: result.cycleDetected ? [request.unitId] : [],
			durationMs: Date.now() - startMs,
		};

	} catch (err) {
		return {
			unitId: request.unitId,
			unitName: request.unitName,
			language: request.language,
			outcome: 'error',
			resolvedSource: request.sourceText,
			totalRefs: 0,
			resolvedRefs: 0,
			unresolvedRefs: 0,
			resolvedDeps: [],
			unresolvedDeps: [],
			cycleUnitIds: [],
			durationMs: Date.now() - startMs,
		};
	}
}


// ─── Language Dispatch ────────────────────────────────────────────────────────

interface IInlinerResult {
	expandedSource: string;
	resolvedRefs: IDependencyResolutionResult[];
	unresolvedRefs: IDependencyResolutionResult[];
	cycleDetected: boolean;
}

async function dispatchToInliner(
	request: IResolutionRequest,
	kb: IKnowledgeBaseService,
	readFile: (uri: string) => Promise<string>,
	listDir: (dirUri: string) => Promise<string[]>,
	searchPaths: string[],
	fileCache: ResolutionFileCache,
	nameCache: DependencyNameResolutionCache,
	options: IRoutedResolutionOptions,
): Promise<IInlinerResult> {

	const lang = canonicaliseLanguage(request.language);

	// ── Embedded C / C++ (firmware) ────────────────────────────────────────────
	if (lang === 'c' || lang === 'cpp' || lang === 'c++' || lang === 'embedded-c') {
		const headerResult = await inlineCHeaders(
			request.sourceText,
			request.sourceFileUri,
			searchPaths,
			readFile,
			listDir,
			fileCache,
			nameCache,
			{
				insertMarkers:         options.insertExpansionMarkers,
				insertResolutionHeader: options.insertResolutionHeader,
				maxExpansionDepth:     options.maxExpansionDepth,
				maxInlineSize:         options.maxInlineSize,
			},
		);

		// Second pass: annotate function calls with KB interface comments
		const callResult = resolveCFunctionCalls(
			headerResult.expandedSource,
			kb,
			{
				insertMarkers: options.insertExpansionMarkers,
				maxSignatureLines: 20,
			},
		);

		return {
			expandedSource: callResult.expandedSource,
			resolvedRefs: [...headerResult.resolvedRefs, ...callResult.resolvedCalls],
			unresolvedRefs: [...headerResult.unresolvedRefs, ...callResult.unresolvedCalls],
			cycleDetected: headerResult.cycleRefs.length > 0,
		};
	}

	// ── COBOL (hybrid project support) ─────────────────────────────────────────
	if (lang === 'cobol') {
		const copybookResult = await inlineCHeaders(
			request.sourceText,
			request.sourceFileUri,
			searchPaths,
			readFile,
			listDir,
			fileCache,
			nameCache,
			{
				insertMarkers:         options.insertExpansionMarkers,
				insertResolutionHeader: options.insertResolutionHeader,
				maxExpansionDepth:     options.maxExpansionDepth,
				maxInlineSize:         options.maxInlineSize,
			},
		);
		return {
			expandedSource: copybookResult.expandedSource,
			resolvedRefs: copybookResult.resolvedRefs,
			unresolvedRefs: copybookResult.unresolvedRefs,
			cycleDetected: copybookResult.cycleRefs.length > 0,
		};
	}

	// ── PL/SQL / SQL ───────────────────────────────────────────────────────────
	if (lang === 'plsql' || lang === 'sql' || lang === 'oracle-sql') {
		const result = resolvePlsqlTypes(
			request.sourceText,
			kb,
			{
				insertMarkers: options.insertExpansionMarkers,
				maxPackageSignatures: 10,
			},
		);
		return {
			expandedSource: result.expandedSource,
			resolvedRefs: result.resolvedRefs,
			unresolvedRefs: result.unresolvedRefs,
			cycleDetected: false,
		};
	}

	// ── Java ──────────────────────────────────────────────────────────────────
	if (lang === 'java') {
		const result = resolveJavaDependencies(
			request.sourceText,
			kb,
			{
				insertMarkers: options.insertExpansionMarkers,
				maxMethodsPerBean: 10,
			},
		);
		return {
			expandedSource: result.expandedSource,
			resolvedRefs: result.resolvedRefs,
			unresolvedRefs: result.unresolvedRefs,
			cycleDetected: false,
		};
	}

	// ── RPG ───────────────────────────────────────────────────────────────────
	if (lang === 'rpg' || lang === 'rpgle' || lang === 'rpg4' || lang === 'sqlrpgle' || lang === 'ile-rpg') {
		const result = await resolveRpgDependencies(
			request.sourceText,
			request.sourceFileUri,
			searchPaths,
			readFile,
			listDir,
			kb,
			fileCache,
			nameCache,
			{
				insertMarkers: options.insertExpansionMarkers,
				maxExpansionDepth: options.maxExpansionDepth,
			},
		);
		return {
			expandedSource: result.expandedSource,
			resolvedRefs: result.resolvedRefs,
			unresolvedRefs: result.unresolvedRefs,
			cycleDetected: false,
		};
	}

	// ── AUTOSAR ARXML ────────────────────────────────────────────────────────
	// ARXML files reference other ARXML elements by SHORT-NAME paths.
	// We inject KB-registered interface signatures as an XML comment block.
	if (lang === 'autosar' || lang === 'arxml') {
		const result = resolveGenericImports(
			request.sourceText,
			'autosar',
			kb,
			{
				insertMarkers: options.insertExpansionMarkers,
				maxMethodsPerImport: 15,
				includeUnresolvedComments: true,
			},
		);
		return {
			expandedSource: result.expandedSource,
			resolvedRefs: result.resolvedRefs,
			unresolvedRefs: result.unresolvedRefs,
			cycleDetected: false,
		};
	}

	// ── IEC 61131-3 (PLC ST/LD) ──────────────────────────────────────────────
	// IEC 61131-3 USES / FROM imports reference library function block definitions.
	// We inject KB-registered FB signatures as (* comment *) blocks.
	if (lang === 'iec61131' || lang === 'st' || lang === 'plc') {
		const result = resolveGenericImports(
			request.sourceText,
			'iec61131',
			kb,
			{
				insertMarkers: options.insertExpansionMarkers,
				maxMethodsPerImport: 10,
				includeUnresolvedComments: true,
			},
		);
		return {
			expandedSource: result.expandedSource,
			resolvedRefs: result.resolvedRefs,
			unresolvedRefs: result.unresolvedRefs,
			cycleDetected: false,
		};
	}

	// ── TTCN-3 (Telecom test modules) ─────────────────────────────────────────
	if (lang === 'ttcn3' || lang === 'ttcn') {
		const result = resolveGenericImports(
			request.sourceText,
			'ttcn3',
			kb,
			{
				insertMarkers: options.insertExpansionMarkers,
				maxMethodsPerImport: 12,
				includeUnresolvedComments: true,
			},
		);
		return {
			expandedSource: result.expandedSource,
			resolvedRefs: result.resolvedRefs,
			unresolvedRefs: result.unresolvedRefs,
			cycleDetected: false,
		};
	}

	// ── NATURAL / ADABAS ─────────────────────────────────────────────────────
	if (lang === 'natural' || lang === 'nsp' || lang === 'nat') {
		const result = await resolveNaturalDependencies(
			request.sourceText,
			request.sourceFileUri,
			searchPaths,
			readFile,
			listDir,
			kb,
			fileCache,
			nameCache,
			{
				insertMarkers: options.insertExpansionMarkers,
				maxExpansionDepth: options.maxExpansionDepth,
			},
		);
		return {
			expandedSource: result.expandedSource,
			resolvedRefs: result.resolvedRefs,
			unresolvedRefs: result.unresolvedRefs,
			cycleDetected: false,
		};
	}

	// ── Generic Fallback ─────────────────────────────────────────────────────
	// TypeScript, JavaScript, Python, Go, Rust, C#, VB, Kotlin, Scala, etc.
	const result = resolveGenericImports(
		request.sourceText,
		request.language,
		kb,
		{
			insertMarkers: options.insertExpansionMarkers,
			maxMethodsPerImport: 8,
			includeUnresolvedComments: false, // Keep noise low for modern languages
		},
	);
	return {
		expandedSource: result.expandedSource,
		resolvedRefs: result.resolvedRefs,
		unresolvedRefs: result.unresolvedRefs,
		cycleDetected: false,
	};
}


// ─── Outcome Calculation ─────────────────────────────────────────────────────

function determineOutcome(
	resolvedRefs: IDependencyResolutionResult[],
	unresolvedRefs: IDependencyResolutionResult[],
	cycleDetected: boolean,
): ResolutionOutcome {
	if (cycleDetected) {
		return 'cycle';
	}

	const totalProject = [...resolvedRefs, ...unresolvedRefs].filter(r => !r.isExternal);
	const resolvedProject = resolvedRefs.filter(r => !r.isExternal);

	if (totalProject.length === 0) {
		// No project-internal deps at all — trivially resolved
		return 'resolved';
	}

	if (resolvedProject.length === totalProject.length) {
		return 'resolved';
	}

	if (resolvedProject.length === 0) {
		return 'unresolvable';
	}

	return 'partial';
}


// ─── Resolution Header ────────────────────────────────────────────────────────

function buildResolutionHeader(
	unitName: string,
	language: string,
	resolvedRefs: IDependencyResolutionResult[],
	unresolvedRefs: IDependencyResolutionResult[],
): string {
	const lang = language.toLowerCase();
	const isLegacy = ['cobol', 'plsql', 'rpg', 'natural', 'natural/z'].some(l => lang.includes(l));

	const commentLine = isLegacy ? '*>' : '//';

	const projectResolved = resolvedRefs.filter(r => !r.isExternal);
	const projectUnresolved = unresolvedRefs.filter(r => !r.isExternal);
	const externalCount = unresolvedRefs.filter(r => r.isExternal).length;

	const lines: string[] = [
		`${commentLine} ── NEURAL INVERSE — SOURCE RESOLUTION SUMMARY ────────────────────────────`,
		`${commentLine}   Unit:       ${unitName}`,
		`${commentLine}   Resolved:   ${projectResolved.length} internal dependencies expanded`,
	];

	if (projectUnresolved.length > 0) {
		lines.push(`${commentLine}   Missing:    ${projectUnresolved.length} internal dependencies not found`);
		const top5 = projectUnresolved.slice(0, 5).map(r => r.ref.canonicalName);
		lines.push(`${commentLine}               ${top5.join(', ')}${projectUnresolved.length > 5 ? ' …' : ''}`);
	}

	if (externalCount > 0) {
		lines.push(`${commentLine}   External:   ${externalCount} external library references (not expanded)`);
	}

	lines.push(`${commentLine} ─────────────────────────────────────────────────────────────────────────────`);
	lines.push('');

	return lines.join('\n');
}


// ─── Search Path Builder ─────────────────────────────────────────────────────

/**
 * Build the ordered search path list for dependency resolution.
 *
 * Priority order:
 * 1. The directory containing the source file (most local — highest priority)
 * 2. Explicitly provided search paths (from project configuration)
 * 3. Extra search paths (from resolution options)
 */
function buildSearchPaths(
	sourceFileUri: string,
	providedSearchPaths: string[],
	extraSearchPaths: string[],
): string[] {
	const seen = new Set<string>();
	const paths: string[] = [];

	const add = (p: string) => {
		const norm = p.replace(/\\/g, '/').replace(/\/$/, '');
		if (norm && !seen.has(norm)) {
			seen.add(norm);
			paths.push(norm);
		}
	};

	// 1. Source file's directory (highest priority)
	const sourceDir = getParentDir(sourceFileUri);
	add(sourceDir);

	// 2. Provided project search paths
	for (const p of providedSearchPaths) {
		add(p);
	}

	// 3. Extra search paths from options
	for (const p of extraSearchPaths) {
		add(p);
	}

	return paths;
}


// ─── File System Adapters ─────────────────────────────────────────────────────

/**
 * Build a `readFile` function that reads from the VS Code file system.
 */
function buildReadFileAdapter(
	fileService: IFileService,
): (uri: string) => Promise<string> {
	return async (uri: string): Promise<string> => {
		const content = await fileService.readFile(URI.parse(uri));
		return content.value.toString();
	};
}

/**
 * Build a `listDir` function that lists directory entry names from the VS Code file system.
 * Returns only the file/folder names (not full paths).
 */
function buildListDirAdapter(
	fileService: IFileService,
): (dirUri: string) => Promise<string[]> {
	return async (dirUri: string): Promise<string[]> => {
		try {
			const stat = await fileService.resolve(URI.parse(dirUri));
			return (stat.children ?? [] as IFileStat[]).map((c: IFileStat) => c.name);
		} catch {
			return [];
		}
	};
}


// ─── Utility ─────────────────────────────────────────────────────────────────

function getParentDir(uri: string): string {
	const normalised = uri.replace(/\\/g, '/');
	const lastSlash = normalised.lastIndexOf('/');
	return lastSlash > 0 ? normalised.slice(0, lastSlash) : normalised;
}
