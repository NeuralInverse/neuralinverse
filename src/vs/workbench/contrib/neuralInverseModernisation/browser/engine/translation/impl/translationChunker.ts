/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Translation Chunker
 *
 * Splits oversized source units into translatable chunks when the resolved source
 * exceeds the available token budget, even after context trimming.
 *
 * ## When chunking is needed
 *
 * The average large COBOL program is 3,000–8,000 lines (150–400 KB). Combined with
 * decisions, glossary, idiom maps, and called interfaces, the context budget of
 * 12,000 tokens (~48,000 chars) is regularly exceeded for `critical`-risk units.
 *
 * Chunking splits the source into self-contained sections, translates each
 * independently, then stitches the results into a single output file.
 *
 * ## Chunking Strategies (per source language)
 *
 * ### COBOL
 * Split at Division/Section boundaries (natural COBOL structure):
 *   1. IDENTIFICATION DIVISION (header — included in every chunk as prefix)
 *   2. ENVIRONMENT DIVISION   (included in every chunk as prefix)
 *   3. DATA DIVISION          (split at WORKING-STORAGE / FILE / LINKAGE sections)
 *   4. PROCEDURE DIVISION     (split by paragraph groups of ≤ `maxChunkChars`)
 *
 * ### PL/SQL / SQL
 * Split at procedure/function/trigger/package body boundaries.
 *
 * ### Natural (Software AG)
 * Split at SUBROUTINE/DEFINE SUBROUTINE boundaries.
 *
 * ### RPG
 * Split at /FREE block boundaries or BEGSR/ENDSR subroutine boundaries.
 *
 * ### Java / Kotlin / Scala / C#
 * Split at top-level class/method boundaries.
 *
 * ### Python
 * Split at top-level function/class definitions.
 *
 * ### Generic fallback
 * Line-count split: divide into chunks of `maxChunkLines` lines with `overlapLines`
 * of overlap so the AI has context at each boundary.
 *
 * ## Stitch Strategy
 *
 * After all chunks are translated:
 * 1. For COBOL \u2192 Java/TypeScript: the class declaration from the IDENTIFICATION chunk
 *    is used as the outer wrapper; method bodies from PROCEDURE chunks are inserted inside.
 * 2. For other languages: chunks are concatenated in order with a separator comment.
 * 3. The idiom notes and decisions from all chunks are merged and deduplicated.
 * 4. The confidence of the stitched result is the minimum confidence across all chunks.
 *
 * ## Chunk Context Injection
 *
 * Each chunk prompt receives:
 * - The full context (decisions, glossary, interfaces) — shared overhead
 * - A "chunk header" explaining its position (e.g. "CHUNK 2 of 5 — PROCEDURE DIVISION, paragraphs CALC-FEE through VALIDATE-CUSTOMER")
 * - A "preceding output stub" — the first N lines of the previous chunk's translation,
 *   so the AI can continue correctly (avoids re-declaring types/imports)
 *
 * ## Relationship to translationLoop.ts
 *
 * The chunker is invoked FROM the translation loop when `ctx.wasBudgetTrimmed` is true
 * AND the source was truncated (a `[source truncated]` marker appears in `ctx.resolvedSource`).
 * The loop then delegates to `chunkAndTranslate()` instead of the single-shot path.
 */

import { IBuiltTranslationContext } from './translationTypes.js';


// ─── Constants ────────────────────────────────────────────────────────────────

/** Default maximum characters per chunk (≈ 8,000 tokens of source) */
const DEFAULT_MAX_CHUNK_CHARS = 32_000;

/** Number of overlap lines between adjacent chunks (for boundary context) */
const OVERLAP_LINES = 20;

/** Minimum chunk size — don't create tiny trailing chunks */
const MIN_CHUNK_CHARS = 500;


// ─── Types ────────────────────────────────────────────────────────────────────

export interface ISourceChunk {
	/** 0-based chunk index */
	index: number;
	/** Total number of chunks */
	total: number;
	/** Human-readable label (e.g. "PROCEDURE DIVISION — paragraphs 1–12") */
	label: string;
	/** The source text for this chunk (may include overlap from adjacent chunks) */
	content: string;
	/** Lines from the previous chunk's translation (injected as stub context) */
	precedingOutputStub?: string;
	/** Whether this chunk contains the unit's public API (class declaration, etc.) */
	isApiChunk: boolean;
}

export interface IChunkSplitResult {
	/** Whether the source was actually chunked (false = source fits in one chunk) */
	wasChunked: boolean;
	chunks: ISourceChunk[];
}

export interface IChunkStitchInput {
	chunk: ISourceChunk;
	translatedContent: string;
}

export interface IStitchResult {
	stitchedCode:    string;
	idiomNotes:      string[];
	sectionsUnresolved: string[];
}


// ─── Main entry points ────────────────────────────────────────────────────────

/**
 * Split a source unit into chunks if it exceeds the token budget.
 *
 * @param ctx            The built translation context (resolved source already in ctx)
 * @param maxChunkChars  Maximum characters per chunk (default 32,000)
 * @returns              Chunk split result — wasChunked=false if source fits in one shot
 */
export function splitIntoChunks(
	ctx: IBuiltTranslationContext,
	maxChunkChars = DEFAULT_MAX_CHUNK_CHARS,
): IChunkSplitResult {
	const source = ctx.resolvedSource;

	// If the source fits in one shot, don't chunk
	if (source.length <= maxChunkChars) {
		return { wasChunked: false, chunks: [] };
	}

	const lang = ctx.sourceLang.toLowerCase();
	let chunks: ISourceChunk[];

	switch (lang) {
		case 'cobol':   chunks = splitCobol(source, maxChunkChars);   break;
		case 'plsql':
		case 'pl/sql':  chunks = splitPlSql(source, maxChunkChars);   break;
		case 'natural': chunks = splitNatural(source, maxChunkChars); break;
		case 'rpgle':
		case 'rpg':     chunks = splitRpg(source, maxChunkChars);     break;
		case 'java':
		case 'kotlin':
		case 'scala':
		case 'csharp':  chunks = splitJavaFamily(source, maxChunkChars, lang); break;
		case 'python':  chunks = splitPython(source, maxChunkChars);  break;
		default:        chunks = splitGeneric(source, maxChunkChars); break;
	}

	return { wasChunked: chunks.length > 1, chunks };
}

/**
 * Stitch translated chunk outputs back into a single coherent translation.
 *
 * @param inputs   The translated chunks in order
 * @param targetLang  The target language (affects stitch strategy)
 * @returns        Stitched output with merged metadata
 */
export function stitchChunks(inputs: IChunkStitchInput[], targetLang: string): IStitchResult {
	if (inputs.length === 0) {
		return { stitchedCode: '', idiomNotes: [], sectionsUnresolved: [] };
	}
	if (inputs.length === 1) {
		return { stitchedCode: inputs[0].translatedContent, idiomNotes: [], sectionsUnresolved: [] };
	}

	const lang = targetLang.toLowerCase();

	if (['java', 'kotlin', 'csharp', 'scala'].includes(lang)) {
		return stitchClassBased(inputs, lang);
	}
	if (lang === 'typescript' || lang === 'javascript') {
		return stitchModuleBased(inputs);
	}

	return stitchGeneric(inputs);
}

/**
 * Build the chunk-specific context prefix injected into each chunk's prompt.
 * Gives the LLM clear instructions about its position and what to produce.
 */
export function buildChunkContextPrefix(chunk: ISourceChunk, unitName: string, targetLang: string): string {
	const lines: string[] = [
		`## Chunk Translation Context`,
		``,
		`You are translating chunk **${chunk.index + 1} of ${chunk.total}** of the unit "${unitName}".`,
		`Chunk label: **${chunk.label}**`,
		``,
	];

	if (chunk.index === 0) {
		lines.push(`This is the **first chunk**. Include all necessary imports, package declarations, and class/type definitions.`);
	} else if (chunk.index === chunk.total - 1) {
		lines.push(`This is the **final chunk**. Close any open class/struct/module definitions opened in earlier chunks.`);
		lines.push(`Do NOT re-declare imports or class headers already emitted in previous chunks.`);
	} else {
		lines.push(`This is a **middle chunk**. Do NOT re-declare imports or class headers.`);
		lines.push(`Continue from where the previous chunk ended.`);
	}

	if (chunk.precedingOutputStub) {
		lines.push(
			``,
			`## Previous Chunk's Last Lines (for context continuity)`,
			``,
			`\`\`\`${targetLang}`,
			chunk.precedingOutputStub,
			`\`\`\``,
			``,
			`Continue translating immediately after the above.`,
		);
	}

	lines.push(``, `## Source Chunk to Translate`);
	return lines.join('\n');
}


// ─── Language-specific splitters ─────────────────────────────────────────────

// ── COBOL ─────────────────────────────────────────────────────────────────────

function splitCobol(source: string, maxChunkChars: number): ISourceChunk[] {
	// COBOL has 4 standard divisions; we split the PROCEDURE DIVISION into
	// paragraph-grouped chunks, prepending IDENTIFICATION + DATA preamble to each.

	const DIVISION_RE = /^\s*(IDENTIFICATION|ENVIRONMENT|DATA|PROCEDURE)\s+DIVISION\s*\./im;

	// Find division boundaries
	const divisionStarts: { name: string; offset: number }[] = [];
	let match: RegExpExecArray | null;
	const re = new RegExp(DIVISION_RE.source, 'gim');
	while ((match = re.exec(source)) !== null) {
		divisionStarts.push({ name: match[1].toUpperCase(), offset: match.index });
	}

	// If no divisions found, fall back to generic splitting
	if (divisionStarts.length < 2) {
		return splitGeneric(source, maxChunkChars);
	}

	// Extract preamble (IDENTIFICATION + ENVIRONMENT + DATA divisions)
	const procedureIdx = divisionStarts.findIndex(d => d.name === 'PROCEDURE');
	const preamble = procedureIdx > 0
		? source.slice(0, divisionStarts[procedureIdx].offset)
		: '';
	const procedureBody = procedureIdx >= 0
		? source.slice(divisionStarts[procedureIdx].offset)
		: source;

	// Split procedure body by paragraph groups
	const rawChunks = splitByParagraphs(procedureBody, maxChunkChars - preamble.length);

	return rawChunks.map((content, i) => ({
		index:    i,
		total:    rawChunks.length,
		label:    i === 0 ? `PROCEDURE DIVISION — paragraphs 1–N` : `PROCEDURE DIVISION continuation — chunk ${i + 1}`,
		content:  i === 0 ? preamble + content : preamble + content,
		isApiChunk: i === 0,
	}));
}

/**
 * Split a COBOL PROCEDURE DIVISION body at paragraph boundaries,
 * grouping paragraphs until each group approaches maxChunkChars.
 */
function splitByParagraphs(procedureBody: string, maxChunkChars: number): string[] {
	// COBOL paragraphs begin at column 8 with a word followed by a period on its own line
	const PARAGRAPH_RE = /^[A-Z][A-Z0-9-]*\s*\.\s*$/m;
	const lines = procedureBody.split('\n');
	const chunks: string[] = [];
	let current: string[] = [];
	let currentLen = 0;

	const flush = (): void => {
		if (current.length > 0 && current.join('\n').trim().length >= MIN_CHUNK_CHARS) {
			chunks.push(current.join('\n'));
		}
		current = [];
		currentLen = 0;
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const isParaHeader = PARAGRAPH_RE.test(line.trim()) && !line.trim().startsWith('*');

		if (isParaHeader && currentLen > 0 && currentLen + line.length > maxChunkChars) {
			// Add overlap: include the last OVERLAP_LINES from the current chunk into the next
			const overlapStart = Math.max(0, current.length - OVERLAP_LINES);
			const overlap = current.slice(overlapStart);
			flush();
			current = overlap;
			currentLen = overlap.join('\n').length;
		}

		current.push(line);
		currentLen += line.length + 1;
	}
	flush();

	return chunks.length > 0 ? chunks : [procedureBody];
}


// ── PL/SQL ────────────────────────────────────────────────────────────────────

function splitPlSql(source: string, maxChunkChars: number): ISourceChunk[] {
	// Split at CREATE OR REPLACE PROCEDURE/FUNCTION/TRIGGER/PACKAGE BODY boundaries
	const OBJECT_RE = /^\s*(?:CREATE\s+OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION|TRIGGER|PACKAGE\s+BODY)\s+\w+/gim;
	const boundaries = findBoundaries(source, OBJECT_RE);

	if (boundaries.length <= 1) { return splitGeneric(source, maxChunkChars); }

	return boundariesToChunks(source, boundaries, maxChunkChars, 'PL/SQL object');
}


// ── Natural ───────────────────────────────────────────────────────────────────

function splitNatural(source: string, maxChunkChars: number): ISourceChunk[] {
	// Split at DEFINE SUBROUTINE / END-SUBROUTINE boundaries
	const SUB_RE = /^\s*DEFINE\s+SUBROUTINE\s+\w+/gim;
	const boundaries = findBoundaries(source, SUB_RE);

	if (boundaries.length <= 1) { return splitGeneric(source, maxChunkChars); }

	return boundariesToChunks(source, boundaries, maxChunkChars, 'subroutine');
}


// ── RPG ───────────────────────────────────────────────────────────────────────

function splitRpg(source: string, maxChunkChars: number): ISourceChunk[] {
	// Split at /FREE blocks or BEGSR subroutine starts
	const BEGSR_RE = /^\s*(?:BEGSR|\/FREE)/gim;
	const boundaries = findBoundaries(source, BEGSR_RE);

	if (boundaries.length <= 1) { return splitGeneric(source, maxChunkChars); }

	return boundariesToChunks(source, boundaries, maxChunkChars, 'subroutine');
}


// ── Java family (Java, Kotlin, Scala, C#) ────────────────────────────────────

function splitJavaFamily(source: string, maxChunkChars: number, lang: string): ISourceChunk[] {
	// Split at top-level class/method declarations (non-indented)
	let METHOD_RE: RegExp;
	switch (lang) {
		case 'kotlin':
			METHOD_RE = /^(?:(?:private|protected|public|internal|override|open|suspend|data|sealed|abstract|companion)\s+)*(?:class|interface|object|fun)\s+\w+/gm;
			break;
		case 'scala':
			METHOD_RE = /^(?:(?:private|protected|override)\s+)*(?:class|trait|object|def)\s+\w+/gm;
			break;
		case 'csharp':
			METHOD_RE = /^(?:(?:private|protected|public|internal|static|abstract|virtual|override|sealed|partial)\s+)*(?:class|interface|record|struct|enum|[A-Z]\w+)\s+\w+/gm;
			break;
		default: // Java
			METHOD_RE = /^(?:(?:private|protected|public|static|final|abstract|synchronized)\s+)*(?:class|interface|enum|[A-Za-z]\w*)\s+\w+/gm;
	}

	const boundaries = findBoundaries(source, METHOD_RE);
	if (boundaries.length <= 1) { return splitGeneric(source, maxChunkChars); }

	return boundariesToChunks(source, boundaries, maxChunkChars, 'class/method');
}


// ── Python ────────────────────────────────────────────────────────────────────

function splitPython(source: string, maxChunkChars: number): ISourceChunk[] {
	// Split at top-level class/function definitions (column 0)
	const DEF_RE = /^(?:class|def|async\s+def)\s+\w+/gm;
	const boundaries = findBoundaries(source, DEF_RE);

	if (boundaries.length <= 1) { return splitGeneric(source, maxChunkChars); }

	return boundariesToChunks(source, boundaries, maxChunkChars, 'class/function');
}


// ── Generic line-count split ──────────────────────────────────────────────────

function splitGeneric(source: string, maxChunkChars: number): ISourceChunk[] {
	if (source.length <= maxChunkChars) {
		return [{
			index: 0, total: 1,
			label: 'Full source',
			content: source,
			isApiChunk: true,
		}];
	}

	const chunks: string[] = [];
	let start = 0;

	while (start < source.length) {
		let end = start + maxChunkChars;
		if (end >= source.length) {
			chunks.push(source.slice(start));
			break;
		}
		// Break at a newline boundary to avoid splitting mid-line
		const newline = source.lastIndexOf('\n', end);
		if (newline > start) { end = newline; }

		// Overlap: include last OVERLAP_LINES of the current chunk in the next
		const chunk       = source.slice(start, end);
		const overlapStart = Math.max(0, end - overlapCharCount(source, end, OVERLAP_LINES));
		chunks.push(chunk);
		start = overlapStart;
	}

	return chunks.map((c, i) => ({
		index:    i,
		total:    chunks.length,
		label:    `Part ${i + 1} of ${chunks.length}`,
		content:  c,
		isApiChunk: i === 0,
	}));
}


// ─── Stitchers ────────────────────────────────────────────────────────────────

function stitchClassBased(inputs: IChunkStitchInput[], lang: string): IStitchResult {
	// Strategy: find the class declaration in the API chunk, extract its opening brace,
	// merge all method bodies from subsequent chunks inside it, then close.
	const parts: string[] = [];

	for (const input of inputs) {
		const content = input.translatedContent.trim();
		if (input.chunk.index === 0) {
			// First chunk: include as-is but strip the closing brace if present
			// (we'll re-add it after appending the remaining chunks)
			const lastBrace = content.lastIndexOf('}');
			parts.push(lastBrace > 0 ? content.slice(0, lastBrace).trimEnd() : content);
		} else if (input.chunk.index === input.chunk.total - 1) {
			// Last chunk: append and ensure we have a closing brace
			parts.push('', `    // ─── [Chunk ${input.chunk.index + 1}/${input.chunk.total}: ${input.chunk.label}] ───`, content);
		} else {
			// Middle chunk: strip outer class wrapper if present
			const stripped = stripOuterClassWrapper(content, lang);
			parts.push('', `    // ─── [Chunk ${input.chunk.index + 1}/${input.chunk.total}: ${input.chunk.label}] ───`, stripped);
		}
	}

	// Ensure we end with a closing brace for the class
	const joined = parts.join('\n');
	const openCount  = (joined.match(/\{/g) ?? []).length;
	const closeCount = (joined.match(/\}/g) ?? []).length;
	const stitchedCode = openCount > closeCount
		? joined + '\n' + '}'.repeat(openCount - closeCount)
		: joined;

	return { stitchedCode, idiomNotes: [], sectionsUnresolved: [] };
}

function stitchModuleBased(inputs: IChunkStitchInput[]): IStitchResult {
	// TypeScript/JS: deduplicate imports, then concatenate exports
	const importLines  = new Set<string>();
	const exportBlocks: string[] = [];

	for (const input of inputs) {
		const content = input.translatedContent.trim();
		const lines   = content.split('\n');
		const exports: string[] = [];

		for (const line of lines) {
			if (/^\s*import\s/.test(line)) {
				importLines.add(line.trim());
			} else {
				exports.push(line);
			}
		}
		if (exports.length > 0) {
			exportBlocks.push(
				`// ─── [Chunk ${input.chunk.index + 1}/${input.chunk.total}: ${input.chunk.label}] ───`,
				...exports,
			);
		}
	}

	const stitchedCode = [
		[...importLines].join('\n'),
		'',
		exportBlocks.join('\n'),
	].filter(Boolean).join('\n');

	return { stitchedCode, idiomNotes: [], sectionsUnresolved: [] };
}

function stitchGeneric(inputs: IChunkStitchInput[]): IStitchResult {
	const parts = inputs.map(input =>
		`// ─── [Chunk ${input.chunk.index + 1}/${input.chunk.total}: ${input.chunk.label}] ───\n${input.translatedContent.trim()}`
	);
	return { stitchedCode: parts.join('\n\n'), idiomNotes: [], sectionsUnresolved: [] };
}


// ─── Utilities ────────────────────────────────────────────────────────────────

function findBoundaries(source: string, re: RegExp): number[] {
	const boundaries: number[] = [];
	let m: RegExpExecArray | null;
	const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
	while ((m = r.exec(source)) !== null) {
		boundaries.push(m.index);
	}
	return boundaries;
}

function boundariesToChunks(
	source: string,
	boundaries: number[],
	maxChunkChars: number,
	label: string,
): ISourceChunk[] {
	const sections: string[] = [];
	for (let i = 0; i < boundaries.length; i++) {
		const start = boundaries[i];
		const end   = i + 1 < boundaries.length ? boundaries[i + 1] : source.length;
		sections.push(source.slice(start, end));
	}

	// Group sections into chunks that fit within maxChunkChars
	const chunks: string[] = [];
	let current = '';

	for (const section of sections) {
		if (current.length + section.length > maxChunkChars && current.length >= MIN_CHUNK_CHARS) {
			chunks.push(current);
			current = section;
		} else {
			current += section;
		}
	}
	if (current.length >= MIN_CHUNK_CHARS) { chunks.push(current); }
	if (chunks.length === 0) { chunks.push(source); }

	return chunks.map((c, i) => ({
		index:    i,
		total:    chunks.length,
		label:    `${label} ${i + 1} of ${chunks.length}`,
		content:  c,
		isApiChunk: i === 0,
	}));
}

function stripOuterClassWrapper(code: string, _lang: string): string {
	// Remove the outermost class/interface declaration to avoid re-declaring it
	// in middle chunks. Only strip if the code starts with a class declaration.
	const classStart = code.search(/^(?:public\s+)?(?:class|interface|record)\s+/m);
	if (classStart < 0) { return code; }

	const braceIdx = code.indexOf('{', classStart);
	if (braceIdx < 0) { return code; }

	// Find the matching closing brace
	let depth = 0;
	let lastClose = -1;
	for (let i = braceIdx; i < code.length; i++) {
		if (code[i] === '{') { depth++; }
		if (code[i] === '}') {
			depth--;
			if (depth === 0) { lastClose = i; break; }
		}
	}

	if (lastClose < 0) { return code; }

	// Return the inner content
	return code.slice(braceIdx + 1, lastClose).trim();
}

/** Calculate the character offset of `lineCount` lines backwards from `offset` */
function overlapCharCount(source: string, end: number, lineCount: number): number {
	let count = 0;
	let lines = 0;
	for (let i = end - 1; i >= 0 && lines < lineCount; i--) {
		count++;
		if (source[i] === '\n') { lines++; }
	}
	return count;
}
