/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # COBOL CALL Resolver
 *
 * Resolves `CALL 'PROGRAM-NAME' USING ...` statements in COBOL programs.
 *
 * When a COBOL program calls an external program, the AI needs to know:
 * 1. What LINKAGE SECTION parameters that program expects
 * 2. What it returns / how it modifies the data
 * 3. Whether it's already been translated (and what interface the modern version has)
 *
 * ## Strategy
 *
 * Unlike copybooks (which are text-expanded inline), CALL targets are programs.
 * We cannot inline an entire COBOL program into the calling program — it would be
 * enormous and confusing. Instead, we inject an **interface comment block** immediately
 * after each CALL statement, summarising:
 *
 * a) If the called program IS in the KB:
 *    - Its purpose (business rules if extracted)
 *    - Its LINKAGE SECTION fields (from the KB unit's sourceText if we can parse them)
 *    - Its translation status (pending/ready/translated)
 *    - The modern interface (if already translated)
 *
 * b) If the called program is NOT in the KB:
 *    - A comment noting it could not be resolved
 *    - Any type hints from the USING clause if we can infer them
 *
 * ## Format
 *
 * ```cobol
 *     CALL 'DBRT0010' USING WS-CUST-ID WS-RESULT-REC.
 * *> ── CALL INTERFACE: DBRT0010 ──────────────────────────────────────────────
 * *>   Status:  READY (awaiting translation)
 * *>   Purpose: Validates customer ID against master file, sets WS-RESULT-REC
 * *>   LINKAGE: WS-CUST-ID (IN) PIC X(10) — Customer ID
 * *>             WS-RESULT-REC (OUT) 05 WS-STATUS PIC X, 05 WS-CUST-NAME PIC X(40)
 * *>   Modern:  Not yet translated — call will need updating after translation
 * *> ────────────────────────────────────────────────────────────────────────────
 * ```
 */

import { IDependencyRef, IDependencyResolutionResult } from './resolutionTypes.js';
import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';


// ─── Public API ───────────────────────────────────────────────────────────────

export interface ICobolCallResolveOptions {
	insertMarkers: boolean;
	maxLinkageSectionLines: number;
}

export interface ICobolCallResolveResult {
	expandedSource: string;
	resolvedCalls: IDependencyResolutionResult[];
	unresolvedCalls: IDependencyResolutionResult[];
}

/**
 * Inject interface comments for all CALL statements in COBOL source.
 *
 * @param sourceText  The COBOL source text (after copybook expansion)
 * @param kb          The knowledge base service (to look up called programs)
 * @param options     Options
 */
export function resolveCobolCalls(
	sourceText: string,
	kb: IKnowledgeBaseService,
	options: ICobolCallResolveOptions,
): ICobolCallResolveResult {
	if (!options.insertMarkers) {
		return { expandedSource: sourceText, resolvedCalls: [], unresolvedCalls: [] };
	}

	const resolvedCalls: IDependencyResolutionResult[] = [];
	const unresolvedCalls: IDependencyResolutionResult[] = [];

	const callStatements = parseCallStatements(sourceText);
	if (callStatements.length === 0) {
		return { expandedSource: sourceText, resolvedCalls, unresolvedCalls };
	}

	// Process in reverse order to preserve offsets
	let result = sourceText;
	const sorted = [...callStatements].sort((a, b) => b.endOffset - a.endOffset);

	for (const callStmt of sorted) {
		const programName = callStmt.programName.toUpperCase();

		// Look up this program in the KB
		const kbUnit = findUnitByName(kb, programName);

		const depRef: IDependencyRef = {
			rawRef: callStmt.fullStatement,
			canonicalName: programName,
			line: callStmt.line,
			depType: 'cobol-call',
		};

		if (!kbUnit) {
			// Not in KB — add a "not found" comment
			if (options.insertMarkers) {
				const comment = buildNotFoundComment(programName, callStmt.usingParams);
				result = insertAfterOffset(result, callStmt.endOffset, comment);
			}
			unresolvedCalls.push({
				ref: depRef,
				resolved: false,
				inlinedContent: '',
				failureReason: `Program ${programName} not found in knowledge base`,
			});
			continue;
		}

		// Build interface comment from KB unit
		const interfaceComment = buildInterfaceComment(kbUnit, programName, callStmt.usingParams, kb, options);
		result = insertAfterOffset(result, callStmt.endOffset, interfaceComment);

		resolvedCalls.push({
			ref: depRef,
			resolved: true,
			inlinedContent: interfaceComment,
			resolvedUnitId: kbUnit.id,
		});
	}

	return { expandedSource: result, resolvedCalls, unresolvedCalls };
}


// ─── CALL Statement Parser ────────────────────────────────────────────────────

interface IParsedCallStatement {
	fullStatement: string;
	programName: string;
	usingParams: string[];
	line: number;
	startOffset: number;
	endOffset: number;
}

function parseCallStatements(text: string): IParsedCallStatement[] {
	const results: IParsedCallStatement[] = [];

	// CALL 'NAME' [USING param1 param2 ...] .
	// CALL identifier [USING param1 param2 ...] .
	const CALL_RE = /\bCALL\s+['"]([A-Z0-9$#@-]+)['"]\s*(?:USING\s+((?:[A-Z0-9$#@\-\s]+?)(?=\.\s|$)))?\s*\./gi;

	let match: RegExpExecArray | null;
	while ((match = CALL_RE.exec(text)) !== null) {
		const fullStatement = match[0];
		const programName = match[1].toUpperCase();
		const usingClause = match[2] ?? '';

		// Parse USING parameters (space or comma separated identifiers)
		const usingParams = usingClause
			.split(/[\s,]+/)
			.map(p => p.trim().toUpperCase())
			.filter(p => p.length > 0 && !/^(BY|REFERENCE|CONTENT|VALUE|ADDRESS|OF)$/i.test(p));

		const lineNum = text.substring(0, match.index).split('\n').length;

		results.push({
			fullStatement,
			programName,
			usingParams,
			line: lineNum,
			startOffset: match.index,
			endOffset: match.index + fullStatement.length,
		});
	}

	return results;
}


// ─── Interface Comment Builder ────────────────────────────────────────────────

function buildInterfaceComment(
	unit: ReturnType<IKnowledgeBaseService['getUnit']>,
	programName: string,
	usingParams: string[],
	kb: IKnowledgeBaseService,
	options: ICobolCallResolveOptions,
): string {
	if (!unit) {
		return '';
	}

	const lines: string[] = [
		``,
		`*> ── CALL INTERFACE: ${programName} ${'─'.repeat(Math.max(0, 66 - programName.length))}`,
		`*>   Status:  ${unit.status.toUpperCase()}`,
	];

	// Business rules summary
	if (unit.businessRules.length > 0) {
		const topRule = unit.businessRules[0];
		lines.push(`*>   Purpose: ${topRule.description}`);
	}

	// Risk level
	lines.push(`*>   Risk:    ${unit.riskLevel.toUpperCase()}`);

	// USING parameter context (match with known field names from KB decisions if possible)
	if (usingParams.length > 0) {
		const decisions = kb.getDecisionsForUnit(unit.id);
		lines.push(`*>   USING:   ${usingParams.map(p => {
			const naming = decisions.naming.find(d => d.sourceName.toUpperCase() === p);
			return naming ? `${p} → ${naming.targetName} (${naming.domain})` : p;
		}).join(', ')}`);
	}

	// Linkage section fields from source (heuristic parse)
	const linkageFields = extractLinkageSectionFields(unit.sourceText, options.maxLinkageSectionLines);
	if (linkageFields.length > 0) {
		lines.push(`*>   LINKAGE:`);
		for (const field of linkageFields) {
			lines.push(`*>     ${field}`);
		}
	}

	// Modern interface if translated
	if (unit.targetInterface) {
		lines.push(`*>   Modern interface (${unit.targetInterface.targetLanguage}):`);
		for (const sig of unit.targetInterface.signatures.slice(0, 3)) {
			lines.push(`*>     ${sig}`);
		}
		if (unit.targetInterface.signatures.length > 3) {
			lines.push(`*>     ... (${unit.targetInterface.signatures.length - 3} more signatures)`);
		}
	} else {
		lines.push(`*>   Modern: Not yet translated — CALL will need updating after this program is translated`);
	}

	lines.push(`*> ${'─'.repeat(76)}`);
	lines.push('');

	return lines.join('\n');
}

function buildNotFoundComment(programName: string, usingParams: string[]): string {
	const lines = [
		``,
		`*> ── CALL INTERFACE: ${programName} [NOT IN KNOWLEDGE BASE] ${'─'.repeat(Math.max(0, 48 - programName.length))}`,
		`*>   This program was not found in the knowledge base.`,
		`*>   It may be an external library, middleware, or a program not yet scanned.`,
	];

	if (usingParams.length > 0) {
		lines.push(`*>   USING params: ${usingParams.join(', ')}`);
	}

	lines.push(`*> ${'─'.repeat(76)}`);
	lines.push('');

	return lines.join('\n');
}

/**
 * Heuristic parser for LINKAGE SECTION field declarations.
 * Extracts the first N data items defined in the LINKAGE SECTION.
 */
function extractLinkageSectionFields(sourceText: string, maxLines: number): string[] {
	const fields: string[] = [];
	const lines = sourceText.split('\n');

	let inLinkageSection = false;
	let lineCount = 0;

	for (const line of lines) {
		const trimmed = line.trim().toUpperCase();

		if (/^LINKAGE\s+SECTION/.test(trimmed)) {
			inLinkageSection = true;
			continue;
		}

		if (inLinkageSection) {
			// End of linkage section
			if (/^(PROCEDURE\s+DIVISION|DATA\s+DIVISION|WORKING-STORAGE|LOCAL-STORAGE|FILE\s+SECTION)/.test(trimmed)) {
				break;
			}

			// Parse data item declarations: level number, name, PIC clause
			const fieldMatch = trimmed.match(/^(\d{2})\s+([A-Z0-9$#@-]+)\s+(.*)/);
			if (fieldMatch) {
				const level = fieldMatch[1];
				const name = fieldMatch[2];
				const rest = fieldMatch[3].trim();

				// Format: "01 WS-CUST-REC | 05 WS-ID PIC X(10) | ..."
				const picMatch = rest.match(/PIC\s+(\S+)/i);
				if (picMatch) {
					fields.push(`${level} ${name} PIC ${picMatch[1]}`);
				} else if (level === '01' || level === '77') {
					fields.push(`${level} ${name}`);
				}

				lineCount++;
				if (lineCount >= maxLines) {
					fields.push(`... (truncated at ${maxLines} fields)`);
					break;
				}
			}
		}
	}

	return fields;
}


// ─── KB Lookup ────────────────────────────────────────────────────────────────

/**
 * Find a KB unit by program name (case-insensitive).
 * A COBOL program `CALL 'DBRT0010'` maps to a unit with name 'DBRT0010'.
 */
function findUnitByName(kb: IKnowledgeBaseService, programName: string): ReturnType<IKnowledgeBaseService['getUnit']> {
	const upperName = programName.toUpperCase();
	const allUnits = kb.getAllUnits();
	return allUnits.find(u => u.name.toUpperCase() === upperName) ?? undefined;
}


// ─── String Utilities ─────────────────────────────────────────────────────────

function insertAfterOffset(text: string, offset: number, insertion: string): string {
	return text.slice(0, offset) + insertion + text.slice(offset);
}
