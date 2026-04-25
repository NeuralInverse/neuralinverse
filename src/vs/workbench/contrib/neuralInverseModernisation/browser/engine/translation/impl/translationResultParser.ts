/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Translation Result Parser
 *
 * Extracts structured data from the LLM's raw text response.
 *
 * ## Expected Format
 *
 * ```xml
 * <translation>
 * [translated code]
 * </translation>
 * <metadata>
 * { "confidence": "...", "reasoning": "...", "decisionsRaised": [...], ... }
 * </metadata>
 * ```
 *
 * ## Fallback Handling
 *
 * The parser applies multiple fallback strategies when the model deviates from format:
 *
 * 1. **Primary**: Extract from `<translation>...</translation>` tags
 * 2. **Fallback 1**: Extract from triple-backtick code fence (```lang ... ```)
 * 3. **Fallback 2**: Extract the entire response as code (if it looks like code)
 *
 * For metadata:
 * 1. **Primary**: Extract JSON from `<metadata>...</metadata>` tags
 * 2. **Fallback**: Scan for a freestanding `{...}` JSON block
 * 3. **Default**: Return empty metadata with confidence=uncertain
 *
 * All failures are graceful \u2014 the parser never throws. A `parseSucceeded: false`
 * result tells the caller to retry.
 */

import { ITranslationParseResult, TranslationConfidence, IRaisedDecision } from './translationTypes.js';
import { IPendingDecision } from '../../../../common/knowledgeBaseTypes.js';


// \u2500\u2500\u2500 Main entry point \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Parse an LLM response into a structured `ITranslationParseResult`.
 * Never throws \u2014 all failures produce a degraded result with `parseSucceeded: false`.
 *
 * @param rawResponse  The complete text returned by the LLM
 * @returns            Structured parse result
 */
export function parseTranslationResponse(rawResponse: string): ITranslationParseResult {
	const translatedCode = extractTranslationBlock(rawResponse);
	const metadata       = extractMetadata(rawResponse);

	const parseSucceeded = translatedCode.length > 0 && metadata !== null;

	return {
		translatedCode:      translatedCode,
		confidence:          parseConfidence(metadata?.confidence),
		reasoning:           String(metadata?.reasoning ?? ''),
		decisionsRaised:     parseDecisionsRaised(metadata?.decisionsRaised),
		sectionsUnresolved:  parseStringArray(metadata?.sectionsUnresolved),
		idiomNotes:          parseStringArray(metadata?.idiomNotes),
		parseSucceeded,
		rawResponse,
	};
}


// \u2500\u2500\u2500 Translation block extraction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractTranslationBlock(text: string): string {
	// Strategy 1: <translation>...</translation> tags
	const xmlMatch = text.match(/<translation>\s*([\s\S]*?)\s*<\/translation>/i);
	if (xmlMatch && xmlMatch[1].trim().length > 0) {
		return xmlMatch[1].trim();
	}

	// Strategy 2: Triple-backtick code fence with language identifier
	const fenceWithLang = text.match(/```(?:\w+)?\n([\s\S]*?)```/);
	if (fenceWithLang && fenceWithLang[1].trim().length > 0) {
		return fenceWithLang[1].trim();
	}

	// Strategy 3: Triple-backtick without language
	const fenceGeneric = text.match(/```([\s\S]*?)```/);
	if (fenceGeneric && fenceGeneric[1].trim().length > 0) {
		return fenceGeneric[1].trim();
	}

	// Strategy 4: If the text looks like code (has common code markers),
	// strip out a trailing JSON block if present and return the rest
	const textBeforeMetadata = text.replace(/<metadata>[\s\S]*?<\/metadata>/i, '').trim();
	if (looksLikeCode(textBeforeMetadata)) {
		return textBeforeMetadata;
	}

	// Parsing failed \u2014 return empty string (will cause parseSucceeded=false)
	return '';
}

function looksLikeCode(text: string): boolean {
	if (text.length < 20) { return false; }
	// Contains common code patterns: braces, semicolons, keywords
	const codeIndicators = /[{}();]|\bclass\b|\bfunction\b|\bpublic\b|\bprivate\b|\bdef\b|\bSECTION\b|\bDIVISION\b/;
	return codeIndicators.test(text);
}


// \u2500\u2500\u2500 Metadata extraction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface IRawMetadata {
	confidence?: unknown;
	reasoning?: unknown;
	decisionsRaised?: unknown;
	sectionsUnresolved?: unknown;
	idiomNotes?: unknown;
}

function extractMetadata(text: string): IRawMetadata | null {
	// Strategy 1: <metadata>...</metadata> tags
	const xmlMatch = text.match(/<metadata>\s*([\s\S]*?)\s*<\/metadata>/i);
	if (xmlMatch) {
		return parseJson(xmlMatch[1]);
	}

	// Strategy 2: Find a standalone JSON object after the code block
	// Look for the last `{` that starts a valid JSON block
	const jsonCandidates = [...text.matchAll(/(\{[\s\S]*?\})\s*$/g)];
	for (const candidate of jsonCandidates.reverse()) {
		const parsed = parseJson(candidate[1]);
		if (parsed !== null) { return parsed; }
	}

	return null;
}

function parseJson(text: string): IRawMetadata | null {
	// Strip markdown code fences if model wrapped the JSON
	const cleaned = text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();
	try {
		const obj = JSON.parse(cleaned);
		if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
			return obj as IRawMetadata;
		}
		return null;
	} catch {
		// Attempt recovery: fix common LLM JSON mistakes
		return parseJsonLenient(cleaned);
	}
}

/**
 * Lenient JSON parser that fixes common LLM output mistakes:
 * - Trailing commas before `}`/`]`
 * - Single quotes instead of double quotes
 * - Unquoted keys
 */
function parseJsonLenient(text: string): IRawMetadata | null {
	try {
		// Fix trailing commas
		let fixed = text.replace(/,\s*([}\]])/g, '$1');
		// Fix single-quoted strings
		fixed = fixed.replace(/'/g, '"');
		const obj = JSON.parse(fixed);
		if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
			return obj as IRawMetadata;
		}
		return null;
	} catch {
		return null;
	}
}


// \u2500\u2500\u2500 Field parsers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function parseConfidence(raw: unknown): TranslationConfidence {
	const VALID: TranslationConfidence[] = ['high', 'medium', 'low', 'uncertain'];
	const str = String(raw ?? '').toLowerCase().trim();
	return VALID.includes(str as TranslationConfidence) ? (str as TranslationConfidence) : 'uncertain';
}

function parseDecisionsRaised(raw: unknown): IRaisedDecision[] {
	if (!Array.isArray(raw)) { return []; }

	const VALID_TYPES: Array<IPendingDecision['type']> = [
		'type-mapping', 'naming', 'rule-interpretation', 'approval', 'exclusion',
	];
	const VALID_PRIORITIES: Array<IPendingDecision['priority']> = [
		'low', 'medium', 'high', 'blocking',
	];

	const results: IRaisedDecision[] = [];
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) { continue; }
		const r = item as Record<string, unknown>;

		const type = VALID_TYPES.includes(r['type'] as IPendingDecision['type'])
			? (r['type'] as IPendingDecision['type'])
			: 'rule-interpretation';

		const priority = VALID_PRIORITIES.includes(r['priority'] as IPendingDecision['priority'])
			? (r['priority'] as IPendingDecision['priority'])
			: 'medium';

		const question = String(r['question'] ?? '').trim();
		const context  = String(r['context']  ?? '').trim();

		if (!question || !context) { continue; } // Skip malformed decisions

		const options = Array.isArray(r['options'])
			? r['options'].map(String).filter(s => s.trim().length > 0)
			: undefined;

		results.push({ type, priority, question, context, options });
	}
	return results;
}

function parseStringArray(raw: unknown): string[] {
	if (!Array.isArray(raw)) { return []; }
	return raw.map(String).filter(s => s.trim().length > 0);
}
