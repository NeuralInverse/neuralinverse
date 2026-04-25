/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # C Function Call Resolver
 *
 * The firmware equivalent of the COBOL CALL resolver.
 *
 * Takes embedded C/C++ source text and injects interface comment blocks
 * immediately after every function call that can be matched against the
 * firmware knowledge base (KB). This gives the AI visibility into:
 *
 * 1. What the called function does (business/safety rules if extracted)
 * 2. Its declared parameter types and return type (from KB unit sourceText)
 * 3. Its translation status (pending / ready / translated)
 * 4. The modern interface if it has already been translated (e.g. HAL API)
 *
 * ## Strategy
 *
 * Unlike COBOL (where CALL is a keyword), C function calls are resolved by
 * matching identifiers against the KB's function-unit names. We heuristically
 * detect calls using a function-call regex and look up each unique callee
 * in the KB.
 *
 * ## Format
 *
 * ```c
 *     HAL_UART_Transmit(&huart1, buf, len, timeout);
 * // ── CALL INTERFACE: HAL_UART_Transmit ───────────────────────────────────────
 * //   Status:  READY (HAL layer translation pending)
 * //   Purpose: Transmits data over UART1 in blocking mode
 * //   Risk:    MEDIUM — blocks caller for duration of transmission
 * //   Params:  UART_HandleTypeDef *huart, const uint8_t *pData, uint16_t Size, uint32_t Timeout
 * //   Modern interface (FreeRTOS):  HAL_UART_Transmit_IT() with tx-complete callback
 * // ────────────────────────────────────────────────────────────────────────────
 * ```
 */

import { IDependencyRef, IDependencyResolutionResult } from './resolutionTypes.js';
import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';


// ─── Public API ───────────────────────────────────────────────────────────────

export interface ICFunctionCallResolveOptions {
	insertMarkers: boolean;
	maxSignatureLines: number;
}

export interface ICFunctionCallResolveResult {
	expandedSource: string;
	resolvedCalls: IDependencyResolutionResult[];
	unresolvedCalls: IDependencyResolutionResult[];
}

/**
 * Inject interface comments for all resolvable function calls in C/C++ source.
 *
 * @param sourceText  The C/C++ source text (after header inlining)
 * @param kb          The knowledge base service (to look up called functions)
 * @param options     Options
 */
export function resolveCFunctionCalls(
	sourceText: string,
	kb: IKnowledgeBaseService,
	options: ICFunctionCallResolveOptions,
): ICFunctionCallResolveResult {
	if (!options.insertMarkers) {
		return { expandedSource: sourceText, resolvedCalls: [], unresolvedCalls: [] };
	}

	const resolvedCalls: IDependencyResolutionResult[] = [];
	const unresolvedCalls: IDependencyResolutionResult[] = [];

	const callStatements = parseFunctionCalls(sourceText);
	if (callStatements.length === 0) {
		return { expandedSource: sourceText, resolvedCalls, unresolvedCalls };
	}

	// Process in reverse order to preserve offsets
	let result = sourceText;
	const sorted = [...callStatements].sort((a, b) => b.endOffset - a.endOffset);

	// Collect unique callee names to avoid re-annotating the same function
	const annotatedCallees = new Set<string>();

	for (const callStmt of sorted) {
		const funcName = callStmt.funcName;

		// Only annotate each unique callee once per file
		if (annotatedCallees.has(funcName)) { continue; }

		// Skip trivial / known intrinsics
		if (C_INTRINSICS.has(funcName)) { continue; }

		// Look up this function in the KB
		const kbUnit = findUnitByName(kb, funcName);

		const depRef: IDependencyRef = {
			rawRef:        callStmt.fullStatement,
			canonicalName: funcName,
			line:          callStmt.line,
			depType:       'c-function-call',
		};

		if (!kbUnit) {
			unresolvedCalls.push({
				ref: depRef,
				resolved: false,
				inlinedContent: '',
				failureReason: `Function ${funcName} not found in knowledge base`,
			});
			// Do not annotate unknown functions — would be too noisy
			continue;
		}

		annotatedCallees.add(funcName);

		const interfaceComment = buildInterfaceComment(kbUnit, funcName, callStmt.args, kb, options);
		result = insertAfterOffset(result, callStmt.endOffset, interfaceComment);

		resolvedCalls.push({
			ref:           depRef,
			resolved:      true,
			inlinedContent: interfaceComment,
			resolvedUnitId: kbUnit.id,
		});
	}

	return { expandedSource: result, resolvedCalls, unresolvedCalls };
}


// ─── Function Call Parser ─────────────────────────────────────────────────────

interface IParsedFunctionCall {
	fullStatement: string;
	funcName: string;
	args: string[];
	line: number;
	startOffset: number;
	endOffset: number;
}

/**
 * Heuristically parse function calls from C/C++ source.
 *
 * We detect calls in the form:  identifier(args...)  or  prefix->method(args...)
 * We extract the callee name (last identifier before `(`) and collapse
 * the argument list into individual tokens.
 */
function parseFunctionCalls(text: string): IParsedFunctionCall[] {
	const results: IParsedFunctionCall[] = [];

	// Match a call expression: word followed by '(' on a non-preprocessor line
	// We use a simplified heuristic — real C parsing is an AST problem
	const CALL_RE = /(?:^|[^a-zA-Z0-9_])([A-Za-z_]\w*)\s*\(([^)]*)\)\s*;/g;

	let match: RegExpExecArray | null;
	while ((match = CALL_RE.exec(text)) !== null) {
		const funcName = match[1];
		const argsRaw  = match[2];

		// Skip likely keyword-not-call patterns
		if (C_KEYWORDS.has(funcName)) { continue; }

		const args = argsRaw.split(',').map(a => a.trim()).filter(a => a.length > 0);
		const lineNum = text.substring(0, match.index).split('\n').length;

		results.push({
			fullStatement: match[0].trim(),
			funcName,
			args,
			line:        lineNum,
			startOffset: match.index,
			endOffset:   match.index + match[0].length,
		});
	}

	return results;
}

/** C keywords that look like function calls but are not */
const C_KEYWORDS = new Set([
	'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'return',
	'sizeof', 'typeof', 'alignof', 'offsetof',
]);

/** CMSIS/compiler intrinsics that don't need KB resolution */
const C_INTRINSICS = new Set([
	'__disable_irq', '__enable_irq', '__WFI', '__WFE', '__SEV', '__NOP',
	'__BKPT', '__ISB', '__DSB', '__DMB',
	'taskENTER_CRITICAL', 'taskEXIT_CRITICAL', 'portYIELD_FROM_ISR',
	'xQueueSendFromISR', 'xSemaphoreGiveFromISR',
	'vTaskDelay', 'vTaskDelayUntil', 'xTaskGetTickCount',
	'k_msleep', 'k_sem_give', 'k_msgq_put', 'irq_lock', 'irq_unlock',
	'memset', 'memcpy', 'memmove', 'strlen', 'strncpy', 'snprintf', 'printf',
]);


// ─── Interface Comment Builder ────────────────────────────────────────────────

function buildInterfaceComment(
	unit: ReturnType<IKnowledgeBaseService['getUnit']>,
	funcName: string,
	args: string[],
	kb: IKnowledgeBaseService,
	options: ICFunctionCallResolveOptions,
): string {
	if (!unit) { return ''; }

	const lines: string[] = [
		``,
		`// ── CALL INTERFACE: ${funcName} ${'─'.repeat(Math.max(0, 66 - funcName.length))}`,
		`//   Status:  ${unit.status.toUpperCase()}`,
	];

	// Business/safety rules summary
	if (unit.businessRules.length > 0) {
		const topRule = unit.businessRules[0];
		lines.push(`//   Purpose: ${topRule.description}`);
	}

	// Risk level
	lines.push(`//   Risk:    ${unit.riskLevel.toUpperCase()}`);

	// Arguments annotation (match with KB naming decisions if possible)
	if (args.length > 0) {
		const decisions = kb.getDecisionsForUnit(unit.id);
		lines.push(`//   Args:    ${args.map(a => {
			const naming = decisions.naming.find(d => d.sourceName === a || d.sourceName.toLowerCase() === a.toLowerCase());
			return naming ? `${a} \u2192 ${naming.targetName} (${naming.domain})` : a;
		}).join(', ')}`);
	}

	// Parameter types from source (heuristic parse of function signature)
	const params = extractFunctionSignature(unit.sourceText, funcName, options.maxSignatureLines);
	if (params.length > 0) {
		lines.push(`//   Params:  ${params.join(', ')}`);
	}

	// Modern / translated interface
	if (unit.targetInterface) {
		lines.push(`//   Modern interface (${unit.targetInterface.targetLanguage}):`);
		for (const sig of unit.targetInterface.signatures.slice(0, 3)) {
			lines.push(`//     ${sig}`);
		}
		if (unit.targetInterface.signatures.length > 3) {
			lines.push(`//     ... (${unit.targetInterface.signatures.length - 3} more signatures)`);
		}
	} else {
		lines.push(`//   Modern: Not yet translated — call will need updating after this unit is translated`);
	}

	lines.push(`// ${'─'.repeat(76)}`);
	lines.push('');

	return lines.join('\n');
}

function buildNotFoundComment(funcName: string): string {
	return [
		``,
		`// ── CALL INTERFACE: ${funcName} [NOT IN KNOWLEDGE BASE] ${'─'.repeat(Math.max(0, 46 - funcName.length))}`,
		`//   This function was not found in the knowledge base.`,
		`//   It may be a system library, vendor driver, or a unit not yet scanned.`,
		`// ${'─'.repeat(76)}`,
		'',
	].join('\n');
}

void buildNotFoundComment; // exported for potential diagnostics use


// ─── Signature Extractor ──────────────────────────────────────────────────────

/**
 * Heuristically extract the parameter list from the function's source definition.
 * Looks for:   returnType funcName(param1, param2, ...)
 */
function extractFunctionSignature(
	sourceText: string,
	funcName: string,
	maxLines: number,
): string[] {
	if (!sourceText) { return []; }

	const lines = sourceText.split('\n');
	const escaped = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const SIG_RE = new RegExp(`(?:^|\\s)${escaped}\\s*\\(([^)]{0,300})\\)`, 'm');

	// Search first maxLines lines for the function signature
	for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
		const m = SIG_RE.exec(lines.slice(0, i + 1).join('\n'));
		if (m && m[1]) {
			return m[1]
				.split(',')
				.map(p => p.trim())
				.filter(p => p.length > 0 && p !== 'void');
		}
	}

	return [];
}


// ─── KB Lookup ────────────────────────────────────────────────────────────────

/**
 * Find a KB unit by function name (exact or case-insensitive match).
 */
function findUnitByName(kb: IKnowledgeBaseService, funcName: string): ReturnType<IKnowledgeBaseService['getUnit']> {
	const allUnits = kb.getAllUnits();
	return allUnits.find(u =>
		u.name === funcName || u.name.toLowerCase() === funcName.toLowerCase()
	) ?? undefined;
}


// ─── String Utilities ─────────────────────────────────────────────────────────

function insertAfterOffset(text: string, offset: number, insertion: string): string {
	return text.slice(0, offset) + insertion + text.slice(offset);
}


// ─── Dependency Reference Extractor (for metrics) ─────────────────────────────

/**
 * Extract all function-call dependency references from C/C++ source for metrics.
 * Lighter version of resolveCFunctionCalls — extracts refs without annotating.
 */
export function extractCFunctionCallRefs(sourceText: string): IDependencyRef[] {
	const calls = parseFunctionCalls(sourceText);
	const seen = new Set<string>();
	const refs: IDependencyRef[] = [];

	for (const call of calls) {
		if (seen.has(call.funcName) || C_INTRINSICS.has(call.funcName) || C_KEYWORDS.has(call.funcName)) { continue; }
		seen.add(call.funcName);
		refs.push({
			rawRef:        call.fullStatement,
			canonicalName: call.funcName,
			line:          call.line,
			depType:       'c-function-call',
		});
	}

	return refs;
}
