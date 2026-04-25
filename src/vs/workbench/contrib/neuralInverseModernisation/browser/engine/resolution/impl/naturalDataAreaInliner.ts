/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # NATURAL Data Area Inliner
 *
 * Resolves NATURAL/ADABAS data area references and subprogram calls.
 *
 * ## NATURAL Dependency Mechanisms
 *
 * 1. `USING DA-CUSTOMER` — references a Global Data Area (GDA)
 *    All variables in the GDA are available to the program, but the AI
 *    can't see their field definitions without the GDA source.
 *
 * 2. `CALLNAT 'SUBPROGRAM' parameter-list` — calls a subprogram
 *    The AI doesn't know the interface of the subprogram.
 *
 * 3. `INCLUDE source-member` — includes a copycode member
 *    Similar to COBOL COPY — needs to be expanded inline.
 *
 * ## Strategy
 *
 * - `USING DA-*` / `USING LDA-*` / `USING PDA-*`: look up the data area in the KB
 *   and inject its field definitions as a comment block.
 *
 * - `CALLNAT 'SUBPROGRAM'`: inject interface context from KB.
 *
 * - `INCLUDE member`: expand inline from the file system.
 */

import { IDependencyRef, IDependencyResolutionResult } from './resolutionTypes.js';
import { ResolutionFileCache, DependencyNameResolutionCache } from './resolutionCache.js';
import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';


// ─── Natural Source Extensions ────────────────────────────────────────────────

const NATURAL_EXTENSIONS = ['.nsp', '.nsa', '.nsg', '.nsl', '.nsn', '.nat', ''];


// ─── Public API ───────────────────────────────────────────────────────────────

export interface INaturalInlineOptions {
	insertMarkers: boolean;
	maxExpansionDepth: number;
}

export interface INaturalInlineResult {
	expandedSource: string;
	resolvedRefs: IDependencyResolutionResult[];
	unresolvedRefs: IDependencyResolutionResult[];
}

/**
 * Resolve NATURAL data area references, INCLUDE members, and CALLNAT references.
 */
export async function resolveNaturalDependencies(
	sourceText: string,
	sourceFileUri: string,
	searchPaths: string[],
	readFile: (uri: string) => Promise<string>,
	listDir: (dirUri: string) => Promise<string[]>,
	kb: IKnowledgeBaseService,
	fileCache: ResolutionFileCache,
	nameCache: DependencyNameResolutionCache,
	options: INaturalInlineOptions,
): Promise<INaturalInlineResult> {
	const resolvedRefs: IDependencyResolutionResult[] = [];
	const unresolvedRefs: IDependencyResolutionResult[] = [];

	let result = sourceText;

	// 1. Inject data area context (USING DA-/LDA-/PDA-)
	if (options.insertMarkers) {
		result = resolveDataAreaUsing(result, kb, resolvedRefs, unresolvedRefs);
	}

	// 2. Expand INCLUDE members
	result = await expandNaturalIncludes(
		result, sourceFileUri, searchPaths, readFile, listDir,
		fileCache, nameCache, options, new Set(), 0,
		resolvedRefs, unresolvedRefs,
	);

	// 3. Inject CALLNAT context
	if (options.insertMarkers) {
		result = resolveCallnat(result, kb, resolvedRefs, unresolvedRefs);
	}

	return { expandedSource: result, resolvedRefs, unresolvedRefs };
}


// ─── USING DA Resolver ────────────────────────────────────────────────────────

function resolveDataAreaUsing(
	text: string,
	kb: IKnowledgeBaseService,
	resolvedRefs: IDependencyResolutionResult[],
	unresolvedRefs: IDependencyResolutionResult[],
): string {
	const USING_RE = /\bUSING\s+([A-Z][A-Z0-9-]+)\b/gi;
	const dataAreas = new Set<string>();
	const contextLines: string[] = [];

	let match: RegExpExecArray | null;
	while ((match = USING_RE.exec(text)) !== null) {
		const areaName = match[1].toUpperCase();
		if (dataAreas.has(areaName)) {
			continue;
		}
		dataAreas.add(areaName);

		const unit = kb.getAllUnits().find(u => u.name.toUpperCase() === areaName);
		const depRef: IDependencyRef = {
			rawRef: match[0],
			canonicalName: areaName,
			line: text.substring(0, match.index).split('\n').length,
			depType: 'natural-using',
		};

		if (unit) {
			contextLines.push(`/* DATA AREA: ${areaName} | Status: ${unit.status.toUpperCase()} */`);
			if (unit.businessRules[0]) {
				contextLines.push(`/* Purpose: ${unit.businessRules[0].description} */`);
			}
			// Try to extract field definitions from the DA source
			const fields = extractNaturalDataAreaFields(unit.sourceText, 20);
			if (fields.length > 0) {
				contextLines.push(`/* Fields: ${fields.join(' | ')} */`);
			}
			resolvedRefs.push({ ref: depRef, resolved: true, inlinedContent: '', resolvedUnitId: unit.id });
		} else {
			contextLines.push(`/* DATA AREA: ${areaName} — NOT IN KNOWLEDGE BASE */`);
			unresolvedRefs.push({ ref: depRef, resolved: false, inlinedContent: '', failureReason: `Data area ${areaName} not in KB` });
		}
	}

	if (contextLines.length === 0) {
		return text;
	}

	return ['/* ── NATURAL DATA AREA CONTEXT ─────────────────────────────────────', ...contextLines, '   ─────────────────────────────────────────────────────────────── */', ''].join('\n') + text;
}

function extractNaturalDataAreaFields(sourceText: string, maxFields: number): string[] {
	const fields: string[] = [];
	// NATURAL field definition: 1 field-name (format) [INIT <value>]
	const FIELD_RE = /^\s+1\s+([A-Z][A-Z0-9-]+)\s+\(([A-Z0-9,]+)\)/gim;
	let match: RegExpExecArray | null;
	while ((match = FIELD_RE.exec(sourceText)) !== null) {
		fields.push(`${match[1]}(${match[2]})`);
		if (fields.length >= maxFields) {
			break;
		}
	}
	return fields;
}


// ─── INCLUDE Expansion ────────────────────────────────────────────────────────

async function expandNaturalIncludes(
	text: string,
	sourceFileUri: string,
	searchPaths: string[],
	readFile: (uri: string) => Promise<string>,
	listDir: (dirUri: string) => Promise<string[]>,
	fileCache: ResolutionFileCache,
	nameCache: DependencyNameResolutionCache,
	options: INaturalInlineOptions,
	cycleGuard: Set<string>,
	depth: number,
	resolvedRefs: IDependencyResolutionResult[],
	unresolvedRefs: IDependencyResolutionResult[],
): Promise<string> {
	if (depth > options.maxExpansionDepth) {
		return text;
	}

	const INCLUDE_RE = /\bINCLUDE\s+([A-Z0-9$#@*-]+)/gi;
	const matches: Array<{ name: string; index: number; len: number }> = [];

	let match: RegExpExecArray | null;
	while ((match = INCLUDE_RE.exec(text)) !== null) {
		matches.push({ name: match[1].toUpperCase(), index: match.index, len: match[0].length });
	}

	let result = text;
	const sorted = [...matches].sort((a, b) => b.index - a.index);

	for (const m of sorted) {
		if (cycleGuard.has(m.name)) {
			continue;
		}

		const sourceDir = getParentDir(sourceFileUri);
		const memberUri = await resolveNaturalMember(m.name, sourceDir, searchPaths, listDir, nameCache);

		const depRef: IDependencyRef = {
			rawRef: `INCLUDE ${m.name}`,
			canonicalName: m.name,
			line: text.substring(0, m.index).split('\n').length,
			depType: 'cobol-copy',
		};

		if (!memberUri) {
			unresolvedRefs.push({ ref: depRef, resolved: false, inlinedContent: '', failureReason: `NATURAL member ${m.name} not found` });
			continue;
		}

		let memberContent = fileCache.get(memberUri);
		if (!memberContent) {
			try {
				memberContent = await readFile(memberUri);
				fileCache.set(memberUri, memberContent);
			} catch {
				unresolvedRefs.push({ ref: depRef, resolved: false, inlinedContent: '', failureReason: `Cannot read ${memberUri}` });
				continue;
			}
		}

		const guard = new Set(cycleGuard);
		guard.add(m.name);
		memberContent = await expandNaturalIncludes(
			memberContent, memberUri, searchPaths, readFile, listDir,
			fileCache, nameCache, options, guard, depth + 1,
			resolvedRefs, unresolvedRefs,
		);

		const block = options.insertMarkers
			? `/* INCLUDE ${m.name} EXPANDED */\n${memberContent}\n/* END INCLUDE ${m.name} */\n`
			: memberContent;

		result = result.slice(0, m.index) + block + result.slice(m.index + m.len);
		resolvedRefs.push({ ref: depRef, resolved: true, inlinedContent: block, resolvedFilePath: memberUri });
	}

	return result;
}

async function resolveNaturalMember(
	name: string,
	sourceDir: string,
	searchPaths: string[],
	listDir: (uri: string) => Promise<string[]>,
	nameCache: DependencyNameResolutionCache,
): Promise<string | undefined> {
	const cacheKey = `NAT:${name}`;
	const cached = nameCache.get(cacheKey);
	if (cached !== undefined) {
		return cached ?? undefined;
	}

	const dirs = [sourceDir, ...searchPaths];
	for (const dir of dirs) {
		for (const ext of NATURAL_EXTENSIONS) {
			try {
				const entries = await listDir(dir);
				const found = entries.find(e => e.toUpperCase() === (name + ext).toUpperCase());
				if (found) {
					const uri = `${dir.replace(/\\/g, '/').replace(/\/$/, '')}/${found}`;
					nameCache.set(cacheKey, uri);
					return uri;
				}
			} catch { /* not found */ }
		}
	}

	nameCache.setNotFound(cacheKey);
	return undefined;
}


// ─── CALLNAT Resolver ────────────────────────────────────────────────────────

function resolveCallnat(
	text: string,
	kb: IKnowledgeBaseService,
	resolvedRefs: IDependencyResolutionResult[],
	unresolvedRefs: IDependencyResolutionResult[],
): string {
	const CALLNAT_RE = /\bCALLNAT\s+['"]([A-Z0-9$#@-]+)['"]/gi;
	const seen = new Set<string>();
	const contextLines: string[] = [];

	let match: RegExpExecArray | null;
	while ((match = CALLNAT_RE.exec(text)) !== null) {
		const subpgm = match[1].toUpperCase();
		if (seen.has(subpgm)) {
			continue;
		}
		seen.add(subpgm);

		const unit = kb.getAllUnits().find(u => u.name.toUpperCase() === subpgm);
		const depRef: IDependencyRef = {
			rawRef: match[0],
			canonicalName: subpgm,
			line: text.substring(0, match.index).split('\n').length,
			depType: 'natural-call',
		};

		if (unit) {
			contextLines.push(`/* CALLNAT ${subpgm} \u2192 KB Status: ${unit.status.toUpperCase()} */`);
			if (unit.businessRules[0]) {
				contextLines.push(`/* Purpose: ${unit.businessRules[0].description} */`);
			}
			resolvedRefs.push({ ref: depRef, resolved: true, inlinedContent: '', resolvedUnitId: unit.id });
		} else {
			contextLines.push(`/* CALLNAT ${subpgm} \u2192 NOT IN KNOWLEDGE BASE */`);
			unresolvedRefs.push({ ref: depRef, resolved: false, inlinedContent: '', failureReason: `${subpgm} not in KB` });
		}
	}

	if (contextLines.length === 0) {
		return text;
	}

	return ['/* ── CALLNAT REFERENCE CONTEXT ───────────────────────────────────', ...contextLines, '   ─────────────────────────────────────────────────────────────── */', ''].join('\n') + text;
}


// ─── Utilities ────────────────────────────────────────────────────────────────

function getParentDir(uri: string): string {
	const normalised = uri.replace(/\\/g, '/');
	const lastSlash = normalised.lastIndexOf('/');
	return lastSlash > 0 ? normalised.slice(0, lastSlash) : normalised;
}
