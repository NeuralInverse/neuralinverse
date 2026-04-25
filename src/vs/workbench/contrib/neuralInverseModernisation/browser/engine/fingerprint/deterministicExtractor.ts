/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Deterministic Fingerprint Extractor — Layer 1
 *
 * Extracts regulated fields and logical invariants from legacy source code
 * using structural pattern matching. No LLM involved — fast and deterministic.
 *
 * ## What It Detects
 *
 * ### Regulated Fields
 * - Field names matching known regulated attribute patterns (account, balance, fee, tax, etc.)
 * - COMP-3 / COMPUTATIONAL-3 fields (packed decimal — always financial in mainframe systems)
 * - Signed decimal numeric fields (PIC S9...V9...) used for monetary precision
 *
 * ### Logical Invariants
 * - COMP-3 rounding invariants: packed decimal arithmetic must be replicated exactly
 * - CICS transactional invariants: CICS READ/WRITE operations imply transactional guarantees
 * - Paragraph-level invariants: regulated paragraph names imply computation that must be preserved
 *
 * ## Output
 *
 * Returns `IRegulatedField[]` and `ILogicalInvariant[]` — the Layer 1 portion of
 * an `IComplianceFingerprint`. The LLM semantic extractor (Layer 2) builds on top of this.
 */

import { IRegulatedField, ILogicalInvariant, ICodeRange } from '../../../common/modernisationTypes.js';
import {
	LEGACY_PATTERN_REGISTRY,
	ISR_DEFAULT_ATTRIBUTE,
	ISR_DEFAULT_FRAMEWORK,
} from '../../../common/legacyPatternRegistry.js';

export interface IDeterministicExtractionResult {
	regulatedFields: IRegulatedField[];
	invariants: ILogicalInvariant[];
	/** Paragraph names identified as containing regulated logic */
	regulatedParagraphs: string[];
}

/**
 * Extract regulated fields and invariants from a unit of legacy source code.
 *
 * @param source    The raw source text of the migration unit
 * @param language  Source language key (e.g. 'cobol'). Must exist in LEGACY_PATTERN_REGISTRY.
 * @param unitName  Name of the unit (paragraph/program name) — used for paragraph pattern matching
 */
export function extractDeterministicFingerprint(
	source: string,
	language: string,
	unitName: string,
): IDeterministicExtractionResult {
	const patterns = LEGACY_PATTERN_REGISTRY[language.toLowerCase()];
	if (!patterns) {
		return { regulatedFields: [], invariants: [], regulatedParagraphs: [] };
	}

	const lines = source.split('\n');
	const regulatedFields: IRegulatedField[] = [];
	const invariants: ILogicalInvariant[] = [];
	const regulatedParagraphs: string[] = [];
	const seenFields = new Set<string>();

	// --- Pass 1: line-by-line structural scan ---
	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		const line = lines[lineIdx];
		const lineNum = lineIdx + 1; // 1-based

		// Check structural patterns first (COMP-3, PIC S9V9, CICS, etc.)
		for (const structural of patterns.structuralPatterns) {
			if (!structural.linePattern.test(line)) {
				continue;
			}

			// Extract the field name from this line if possible
			const fieldName = extractFieldNameFromLine(line, language);

			if (structural.alwaysRegulated) {
				const location: ICodeRange = { startLine: lineNum, startColumn: 1, endLine: lineNum, endColumn: line.length };

				if (structural.indicates === 'packed_decimal_currency_field') {
					// COMP-3 field — always financial regardless of name
					const key = `${fieldName ?? 'COMP3_FIELD'}:packed_decimal`;
					if (!seenFields.has(key)) {
						seenFields.add(key);
						regulatedFields.push({
							fieldName: fieldName ?? extractCobolFieldNameNearby(lines, lineIdx) ?? 'UNKNOWN-REGULATED',
							regulatedAttribute: ISR_DEFAULT_ATTRIBUTE,
							framework: ISR_DEFAULT_FRAMEWORK,
							operation: inferOperationFromContext(line, language),
							location,
							isPackedDecimal: true,
						});

						// COMP-3 always implies a rounding invariant
						invariants.push({
							description: `COMP-3 packed decimal arithmetic on field "${fieldName ?? 'unknown'}" must replicate mainframe rounding exactly. Most target languages use IEEE 754 floating point which produces different rounding for the same inputs.`,
							invariantType: 'rounding_behaviour',
							testable: true,
							location,
						});
					}
				} else if (structural.indicates === 'signed_decimal_numeric_monetary') {
					const key = `${fieldName ?? 'SIGNED_DEC'}:decimal_precision`;
					if (!seenFields.has(key)) {
						seenFields.add(key);
						const precision = extractDecimalPrecision(line);
						invariants.push({
							description: `Signed numeric field "${fieldName ?? 'unknown'}" with ${precision} decimal places requires exact decimal precision preservation in the modern equivalent.`,
							invariantType: 'decimal_precision',
							testable: true,
							location,
						});
					}
				}
			}

			if (structural.indicates === 'cics_transaction_operation') {
				// CICS implies transactional guarantees
				invariants.push({
					description: `CICS operation on line ${lineNum} (${line.trim()}) implies transactional atomicity. The modern equivalent must preserve the same transaction boundary semantics.`,
					invariantType: 'transaction_atomicity',
					testable: false, // Requires CICS emulator to test
					location: { startLine: lineNum, startColumn: 1, endLine: lineNum, endColumn: line.length },
				});
			}
		}

		// Check regulated field name patterns
		for (const fieldPattern of patterns.fieldPatterns) {
			// Match against individual tokens on this line (COBOL field names are space-delimited)
			const tokens = line.split(/[\s,().]+/).filter(Boolean);
			for (const token of tokens) {
				if (!fieldPattern.namePattern.test(token)) {
					continue;
				}

				const key = `${token.toUpperCase()}:${fieldPattern.regulatedAttribute}`;
				if (seenFields.has(key)) {
					continue;
				}
				seenFields.add(key);

				const location: ICodeRange = {
					startLine: lineNum,
					startColumn: line.indexOf(token) + 1,
					endLine: lineNum,
					endColumn: line.indexOf(token) + token.length + 1,
				};

				regulatedFields.push({
					fieldName: token,
					regulatedAttribute: fieldPattern.regulatedAttribute,
					framework: fieldPattern.framework,
					operation: inferOperationFromContext(line, language),
					location,
					isPackedDecimal: /COMP-3|COMPUTATIONAL-3/i.test(line),
				});
			}
		}
	}

	// --- Pass 2: paragraph name analysis ---
	// Check the unit name itself against regulated paragraph patterns
	for (const paragraphPattern of patterns.paragraphPatterns) {
		if (paragraphPattern.test(unitName)) {
			regulatedParagraphs.push(unitName);

			// Add a semantic invariant for the paragraph
			invariants.push({
				description: `Paragraph "${unitName}" matches a regulated business logic pattern. The modern equivalent function must preserve the complete computational logic of this paragraph.`,
				invariantType: 'paragraph_logic_preservation',
				testable: true,
			});
			break;
		}
	}

	// Deduplicate fields by name+attribute
	const uniqueFields = deduplicateFields(regulatedFields);

	return {
		regulatedFields: uniqueFields,
		invariants,
		regulatedParagraphs,
	};
}


// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Infer whether a source line is reading, writing, or calculating a field.
 * COBOL-specific heuristics.
 */
function inferOperationFromContext(line: string, language: string): IRegulatedField['operation'] {
	if (language !== 'cobol') {
		return 'read';
	}

	const upper = line.toUpperCase().trim();

	if (/^(COMPUTE|ADD|SUBTRACT|MULTIPLY|DIVIDE)/.test(upper)) {
		return 'calculate';
	}
	if (/^MOVE\s/.test(upper) && /\s+TO\s+/.test(upper)) {
		return 'write';
	}
	if (/^(WRITE|REWRITE|DELETE)\s/.test(upper) || /EXEC\s+CICS\s+(WRITE|REWRITE|DELETE)/i.test(upper)) {
		return 'store';
	}
	if (/^(READ|EXEC\s+CICS\s+READ)/i.test(upper)) {
		return 'read';
	}
	if (/^(SEND|CALL|EXEC\s+CICS\s+SEND)/i.test(upper)) {
		return 'transmit';
	}
	if (/^IF\s/.test(upper) || /^EVALUATE\s/.test(upper)) {
		return 'compare';
	}

	return 'read';
}

/**
 * Extract the field name from a COBOL DATA DIVISION declaration line.
 * e.g. "       05  WS-ACCT-BAL     PIC S9(11)V99 COMP-3." \u2192 "WS-ACCT-BAL"
 */
function extractFieldNameFromLine(line: string, language: string): string | undefined {
	if (language !== 'cobol') {
		return undefined;
	}

	// COBOL data item: level-number field-name [REDEFINES...] PIC... / COMP...
	const match = line.match(/^\s*\d{2}\s+([A-Z][A-Z0-9-]+)/i);
	return match ? match[1] : undefined;
}

/**
 * When we find a COMP-3 clause, look backwards in the surrounding lines
 * to find the field name (it may be on the preceding line in COBOL).
 */
function extractCobolFieldNameNearby(lines: string[], currentIdx: number): string | undefined {
	// Search up to 3 lines back for a field declaration
	for (let i = currentIdx; i >= Math.max(0, currentIdx - 3); i--) {
		const name = extractFieldNameFromLine(lines[i], 'cobol');
		if (name) {
			return name;
		}
	}
	return undefined;
}

/**
 * Extract the number of decimal places from a PIC clause.
 * e.g. "PIC S9(11)V99" \u2192 "2 decimal places"
 */
function extractDecimalPrecision(line: string): string {
	// PIC S9(n)V9(m) or PIC S9(n)V99...
	const matchExplicit = line.match(/V9\((\d+)\)/i);
	if (matchExplicit) {
		return `${matchExplicit[1]} decimal places`;
	}
	const matchImplicit = line.match(/V(9+)/i);
	if (matchImplicit) {
		return `${matchImplicit[1].length} decimal places`;
	}
	return 'unknown decimal places';
}

/** Remove duplicate regulated fields (same name + attribute) */
function deduplicateFields(fields: IRegulatedField[]): IRegulatedField[] {
	const seen = new Set<string>();
	return fields.filter(f => {
		const key = `${f.fieldName.toUpperCase()}:${f.regulatedAttribute}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}
