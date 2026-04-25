/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # RPG Binding Inliner
 *
 * Resolves RPG IV / ILE RPG program and procedure calls.
 *
 * ## RPG Dependency Mechanisms
 *
 * 1. `CALL 'PGMNAME'` \u2014 Dynamic program call (RPG II / RPG III style)
 *    The AI doesn't know what PGMNAME does or what parameters it takes.
 *
 * 2. `CALLP ProcedureName(params)` \u2014 Prototype-based procedure call (ILE RPG)
 *    Requires a prototype (`/COPY` or `PR`) to be visible for the AI to understand
 *    the parameter types.
 *
 * 3. `/COPY member-name` or `/INCLUDE member-name` \u2014 Source member inclusion
 *    Similar to COBOL COPY \u2014 includes source members from a library/file/member.
 *    The AI is missing those field definitions.
 *
 * 4. `EXTPGM` and `EXTPROC` keywords in prototypes \u2014 external program/procedure calls.
 *    When a prototype declares `EXTPGM('PGMNAME')`, the AI needs to know what
 *    PGMNAME implements.
 *
 * ## Strategy
 *
 * - `/COPY` and `/INCLUDE` members: expand inline (same as COBOL COPY),
 *   using the file cache. RPG members are typically found in:
 *     QRPGLESRC, QRPGSRC, QSRVSRC, QCPYSRC source files.
 *
 * - `CALL 'PGMNAME'`: inject an interface comment from KB (same strategy as COBOL CALLs).
 *
 * - `CALLP ProcedureName(...)`: resolve the prototype from KB if available.
 */

import { IDependencyRef, IDependencyResolutionResult } from './resolutionTypes.js';
import { ResolutionFileCache, DependencyNameResolutionCache } from './resolutionCache.js';
import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';


// \u2500\u2500\u2500 RPG Source Member Extensions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const RPG_MEMBER_EXTENSIONS = ['.rpgle', '.rpg', '.sqlrpgle', '.clle', '.bnd', ''];
const RPG_SOURCE_FILES = ['qrpglesrc', 'qrpgsrc', 'qsrvsrc', 'qcpysrc', 'qprotosrc', 'qlrpgsrc'];


// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IRpgInlineOptions {
	insertMarkers: boolean;
	maxExpansionDepth: number;
}

export interface IRpgInlineResult {
	expandedSource: string;
	resolvedRefs: IDependencyResolutionResult[];
	unresolvedRefs: IDependencyResolutionResult[];
}

/**
 * Resolve RPG /COPY, /INCLUDE directives and CALL statements.
 */
export async function resolveRpgDependencies(
	sourceText: string,
	sourceFileUri: string,
	searchPaths: string[],
	readFile: (uri: string) => Promise<string>,
	listDir: (dirUri: string) => Promise<string[]>,
	kb: IKnowledgeBaseService,
	fileCache: ResolutionFileCache,
	nameCache: DependencyNameResolutionCache,
	options: IRpgInlineOptions,
): Promise<IRpgInlineResult> {
	const resolvedRefs: IDependencyResolutionResult[] = [];
	const unresolvedRefs: IDependencyResolutionResult[] = [];

	let result = sourceText;

	// 1. Expand /COPY and /INCLUDE directives
	result = await expandRpgIncludes(
		result, sourceFileUri, searchPaths, readFile, listDir,
		fileCache, nameCache, options, new Set(), 0,
		resolvedRefs, unresolvedRefs,
	);

	// 2. Inject interface comments for CALL statements
	if (options.insertMarkers) {
		result = resolveRpgCalls(result, kb, resolvedRefs, unresolvedRefs);
	}

	return { expandedSource: result, resolvedRefs, unresolvedRefs };
}


// \u2500\u2500\u2500 /COPY and /INCLUDE Expansion \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

async function expandRpgIncludes(
	text: string,
	sourceFileUri: string,
	searchPaths: string[],
	readFile: (uri: string) => Promise<string>,
	listDir: (dirUri: string) => Promise<string[]>,
	fileCache: ResolutionFileCache,
	nameCache: DependencyNameResolutionCache,
	options: IRpgInlineOptions,
	cycleGuard: Set<string>,
	depth: number,
	resolvedRefs: IDependencyResolutionResult[],
	unresolvedRefs: IDependencyResolutionResult[],
): Promise<string> {
	if (depth > options.maxExpansionDepth) {
		return text + '\n// [RESOLUTION] Max expansion depth reached\n';
	}

	const INCLUDE_RE = /^\s*\/(?:COPY|INCLUDE)\s+(?:([A-Z0-9$#@*-]+)\/([A-Z0-9$#@*-]+)\/)?([A-Z0-9$#@*-]+)\s*$/gim;
	const matches: Array<{ fullMatch: string; memberName: string; libName?: string; fileName?: string; index: number }> = [];

	let match: RegExpExecArray | null;
	while ((match = INCLUDE_RE.exec(text)) !== null) {
		matches.push({
			fullMatch: match[0],
			libName: match[1],
			fileName: match[2],
			memberName: match[3],
			index: match.index,
		});
	}

	if (matches.length === 0) {
		return text;
	}

	let result = text;
	const sorted = [...matches].sort((a, b) => b.index - a.index);

	for (const m of sorted) {
		const memberName = m.memberName.toUpperCase();

		if (cycleGuard.has(memberName)) {
			result = result.replace(m.fullMatch, `// [RESOLUTION CYCLE] /COPY ${memberName} \u2014 circular reference\n`);
			continue;
		}

		const sourceDir = getParentDir(sourceFileUri);
		const memberUri = await resolveRpgMember(
			memberName, sourceDir, searchPaths,
			listDir, nameCache, m.fileName, m.libName,
		);

		const depRef: IDependencyRef = {
			rawRef: m.fullMatch.trim(),
			canonicalName: memberName,
			line: text.substring(0, m.index).split('\n').length,
			depType: 'cobol-copy', // reuse type for include-style deps
		};

		if (!memberUri) {
			unresolvedRefs.push({ ref: depRef, resolved: false, inlinedContent: '', failureReason: `RPG member ${memberName} not found` });
			result = result.replace(m.fullMatch, `// [RESOLUTION MISSING] /COPY ${memberName} \u2014 member not found\n`);
			continue;
		}

		let memberContent = fileCache.get(memberUri);
		if (!memberContent) {
			try {
				memberContent = await readFile(memberUri);
				fileCache.set(memberUri, memberContent);
			} catch (err) {
				unresolvedRefs.push({ ref: depRef, resolved: false, inlinedContent: '', failureReason: `Cannot read ${memberUri}` });
				result = result.replace(m.fullMatch, `// [RESOLUTION ERROR] /COPY ${memberName} \u2014 read error\n`);
				continue;
			}
		}

		// Recursively expand nested includes
		const innerGuard = new Set(cycleGuard);
		innerGuard.add(memberName);
		memberContent = await expandRpgIncludes(
			memberContent, memberUri, searchPaths, readFile, listDir,
			fileCache, nameCache, options, innerGuard, depth + 1,
			resolvedRefs, unresolvedRefs,
		);

		const expandedBlock = options.insertMarkers
			? `\n// \u2500\u2500 /COPY ${memberName} EXPANDED \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n${memberContent}\n// \u2500\u2500 END /COPY ${memberName} \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`
			: memberContent;

		result = result.replace(m.fullMatch, expandedBlock);
		resolvedRefs.push({ ref: depRef, resolved: true, inlinedContent: expandedBlock, resolvedFilePath: memberUri });
	}

	return result;
}

async function resolveRpgMember(
	memberName: string,
	sourceDir: string,
	searchPaths: string[],
	listDir: (uri: string) => Promise<string[]>,
	nameCache: DependencyNameResolutionCache,
	_fileName?: string,
	_libName?: string,
): Promise<string | undefined> {
	const cached = nameCache.get(`RPG:${memberName}`);
	if (cached !== undefined) {
		return cached ?? undefined;
	}

	const dirs = [sourceDir, ...searchPaths];
	for (const srcFile of RPG_SOURCE_FILES) {
		for (const dir of dirs) {
			const srcFileDir = `${dir.replace(/\\/g, '/').replace(/\/$/, '')}/${srcFile}`;
			for (const ext of RPG_MEMBER_EXTENSIONS) {
				try {
					const entries = await listDir(srcFileDir);
					const found = entries.find(e => e.toUpperCase() === (memberName + ext).toUpperCase());
					if (found) {
						const uri = `${srcFileDir}/${found}`;
						nameCache.set(`RPG:${memberName}`, uri);
						return uri;
					}
				} catch { /* dir doesn't exist */ }
			}
		}
	}

	nameCache.setNotFound(`RPG:${memberName}`);
	return undefined;
}


// \u2500\u2500\u2500 CALL Resolution \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function resolveRpgCalls(
	text: string,
	kb: IKnowledgeBaseService,
	resolvedRefs: IDependencyResolutionResult[],
	unresolvedRefs: IDependencyResolutionResult[],
): string {
	// Match: CALL 'PGMNAME'
	const CALL_RE = /\bCALL\s+['"]([A-Z0-9$#@-]+)['"]/gi;
	const seen = new Set<string>();
	const contextLines: string[] = [];

	let match: RegExpExecArray | null;
	while ((match = CALL_RE.exec(text)) !== null) {
		const pgmName = match[1].toUpperCase();
		if (seen.has(pgmName)) {
			continue;
		}
		seen.add(pgmName);

		const unit = kb.getAllUnits().find(u => u.name.toUpperCase() === pgmName);
		const depRef: IDependencyRef = {
			rawRef: match[0],
			canonicalName: pgmName,
			line: text.substring(0, match.index).split('\n').length,
			depType: 'rpg-call',
		};

		if (unit) {
			contextLines.push(`// CALL ${pgmName} \u2192 [KB] Status: ${unit.status.toUpperCase()} | Risk: ${unit.riskLevel.toUpperCase()}`);
			if (unit.businessRules[0]) {
				contextLines.push(`//   Purpose: ${unit.businessRules[0].description}`);
			}
			resolvedRefs.push({ ref: depRef, resolved: true, inlinedContent: '', resolvedUnitId: unit.id });
		} else {
			contextLines.push(`// CALL ${pgmName} \u2192 [NOT IN KB]`);
			unresolvedRefs.push({ ref: depRef, resolved: false, inlinedContent: '', failureReason: `${pgmName} not in knowledge base` });
		}
	}

	if (contextLines.length === 0) {
		return text;
	}

	const header = ['// \u2500\u2500 RPG CALL REFERENCE CONTEXT \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500', ...contextLines, '// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500', ''].join('\n');
	return header + text;
}


// \u2500\u2500\u2500 Utilities \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function getParentDir(uri: string): string {
	const normalised = uri.replace(/\\/g, '/');
	const lastSlash = normalised.lastIndexOf('/');
	return lastSlash > 0 ? normalised.slice(0, lastSlash) : normalised;
}
