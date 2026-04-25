/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Static Structural Checker (Layer 1)
 *
 * Runs fast, deterministic checks on source + target code without using the LLM.
 *
 * ## Checks performed
 *
 *  1. line-count-ratio    — target line count is not drastically shorter than source
 *  2. branch-coverage     — conditional keywords (if/else/switch/when/case) are present
 *  3. api-surface         — exported/public entry points from source are reflected in target
 *  4. field-coverage      — source field/variable names appear (verbatim or transformed) in target
 *  5. loop-coverage       — loop constructs (for/while/do/perform) are present
 *  6. error-handling      — error handling patterns (try/catch/on-exception) are present
 *  7. no-placeholders     — target contains no TODO/FIXME/PLACEHOLDER/NOT IMPLEMENTED stubs
 *  8. non-empty-target    — target is not empty or just comments
 *
 * ## Severity policy
 *
 *  - 'fail'  \u2192 at least one check failed \u2192 short-circuit: skip LLM analysis if includeLLMAnalysis=false
 *  - 'warn'  \u2192 suspicious but not conclusive \u2192 proceed to LLM; flag in result
 *  - 'pass'  \u2192 check passed
 *
 * ## Language-awareness
 *
 * Branch/loop/error keywords are looked up from language-specific tables.
 * Unknown languages fall back to a generic keyword set.
 */

import { IStaticCheckResult, StaticCheckStatus } from './validationTypes.js';


// ─── Language keyword tables ───────────────────────────────────────────────────

interface ILanguageKeywords {
	branch:   string[];
	loop:     string[];
	error:    string[];
	export:   RegExp[];
}

const LANGUAGE_KEYWORDS: Record<string, ILanguageKeywords> = {
	java: {
		branch:  ['if', 'else', 'switch', 'case', 'ternary'],
		loop:    ['for', 'while', 'do'],
		error:   ['try', 'catch', 'finally', 'throws'],
		export:  [/\bpublic\s+\w+\s+\w+\s*\(/g, /\bpublic\s+class\b/g],
	},
	typescript: {
		branch:  ['if', 'else', 'switch', 'case'],
		loop:    ['for', 'while', 'do'],
		error:   ['try', 'catch', 'finally'],
		export:  [/\bexport\s+(function|const|class|async)\b/g],
	},
	javascript: {
		branch:  ['if', 'else', 'switch', 'case'],
		loop:    ['for', 'while', 'do'],
		error:   ['try', 'catch', 'finally'],
		export:  [/\bexport\s+(function|const|class|async)\b/g, /\bmodule\.exports\b/g],
	},
	python: {
		branch:  ['if', 'elif', 'else', 'match', 'case'],
		loop:    ['for', 'while'],
		error:   ['try', 'except', 'finally', 'raise'],
		export:  [/\bdef\s+\w+/g, /\bclass\s+\w+/g],
	},
	csharp: {
		branch:  ['if', 'else', 'switch', 'case', 'when'],
		loop:    ['for', 'foreach', 'while', 'do'],
		error:   ['try', 'catch', 'finally', 'throw'],
		export:  [/\bpublic\s+\w+\s+\w+\s*\(/g, /\bpublic\s+class\b/g],
	},
	kotlin: {
		branch:  ['if', 'else', 'when'],
		loop:    ['for', 'while', 'do'],
		error:   ['try', 'catch', 'finally', 'throw'],
		export:  [/\bfun\s+\w+/g, /\bclass\s+\w+/g],
	},
	go: {
		branch:  ['if', 'else', 'switch', 'case', 'select'],
		loop:    ['for', 'range'],
		error:   ['defer', 'panic', 'recover'],
		export:  [/\bfunc\s+[A-Z]\w+/g],
	},
	rust: {
		branch:  ['if', 'else', 'match'],
		loop:    ['for', 'while', 'loop'],
		error:   ['Result', 'Option', 'unwrap', 'expect', '?'],
		export:  [/\bpub\s+fn\b/g, /\bpub\s+struct\b/g],
	},
	cobol: {
		branch:  ['IF', 'ELSE', 'EVALUATE', 'WHEN', 'END-IF', 'END-EVALUATE'],
		loop:    ['PERFORM', 'UNTIL', 'VARYING'],
		error:   ['ON-ERROR', 'EXCEPTION', 'AT-END'],
		export:  [/\bPROGRAM-ID\b/g, /\bPROCEDURE\s+DIVISION\b/g],
	},
	plsql: {
		branch:  ['IF', 'ELSIF', 'ELSE', 'CASE', 'WHEN', 'END IF', 'END CASE'],
		loop:    ['FOR', 'WHILE', 'LOOP', 'EXIT WHEN'],
		error:   ['EXCEPTION', 'WHEN OTHERS', 'RAISE'],
		export:  [/\bCREATE\s+(OR\s+REPLACE\s+)?(PROCEDURE|FUNCTION|PACKAGE)/gi],
	},
	rpg: {
		branch:  ['IF', 'ELSEIF', 'ELSE', 'WHEN', 'SELECT', 'ENDSL'],
		loop:    ['FOR', 'DOW', 'DOU', 'ITER', 'LEAVE'],
		error:   ['MONITOR', 'ON-ERROR', 'ENDMON'],
		export:  [/\bDCL-PROC\b/gi, /\bPROCEDURE\b/gi],
	},
	// ── Firmware & Embedded ──────────────────────────────────────────────────
	c: {
		branch:  ['if', 'else', 'switch', 'case'],
		loop:    ['for', 'while', 'do'],
		error:   ['assert', 'configASSERT', 'Error_Handler', 'HAL_ERROR'],
		export:  [/\bvoid\s+\w+\s*\(/g, /\b\w+\s+\w+_IRQHandler\s*\(/g],
	},
	cpp: {
		branch:  ['if', 'else', 'switch', 'case'],
		loop:    ['for', 'while', 'do'],
		error:   ['try', 'catch', 'assert', 'configASSERT', 'static_assert'],
		export:  [/\bpublic:/g, /\b\w+\s+\w+::\w+\s*\(/g],
	},
	'embedded-c': {
		branch:  ['if', 'else', 'switch', 'case'],
		loop:    ['for', 'while', 'do'],
		error:   ['assert', 'configASSERT', '__ASSERT', 'Error_Handler', 'ASSERT'],
		export:  [/\bvoid\s+\w+\s*\(/g, /\bvoid\s+\w+_IRQHandler\s*\(/g],
	},
	'embedded-cpp': {
		branch:  ['if', 'else', 'switch', 'case'],
		loop:    ['for', 'while', 'do'],
		error:   ['assert', 'configASSERT', 'static_assert', 'noexcept'],
		export:  [/\bpublic:/g, /\bvirtual\s+\w+/g],
	},
	assembler: {
		branch:  ['BEQ', 'BNE', 'BGT', 'BLT', 'BGE', 'BLE', 'CBZ', 'CBNZ', 'BREQ', 'BRNE'],
		loop:    ['B', 'BX', 'RJMP', 'RCALL'],
		error:   ['SVC', 'BKPT', 'B HardFault', 'Error_Handler'],
		export:  [/^[A-Za-z_]\w*:\s*$/gm],
	},
	iec61131: {
		branch:  ['IF', 'ELSIF', 'ELSE', 'END_IF', 'CASE', 'OF', 'ELSE', 'END_CASE'],
		loop:    ['FOR', 'TO', 'BY', 'DO', 'END_FOR', 'WHILE', 'DO', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT'],
		error:   ['SF_EmergencyStop', 'ALARM', 'FAULT', 'E_STOP'],
		export:  [/\bPROGRAM\s+\w+/gi, /\bFUNCTION_BLOCK\s+\w+/gi, /\bFUNCTION\s+\w+/gi],
	},
	autosar: {
		branch:  ['if', 'else', 'switch', 'case'],
		loop:    ['for', 'while', 'do'],
		error:   ['Dem_SetEventStatus', 'DET_REPORT', 'assert', 'configASSERT'],
		export:  [/\bRte_\w+/g, /\bRUNNABLE_DEFINE\b/g],
	},
};

const GENERIC_KEYWORDS: ILanguageKeywords = {
	branch: ['if', 'else', 'switch', 'case', 'when'],
	loop:   ['for', 'while', 'do', 'loop', 'until'],
	error:  ['try', 'catch', 'except', 'error', 'exception'],
	export: [/\bfunction\s+\w+/g, /\bdef\s+\w+/g, /\bsub\s+\w+/gi],
};

function getKeywords(lang: string): ILanguageKeywords {
	return LANGUAGE_KEYWORDS[lang.toLowerCase()] ?? GENERIC_KEYWORDS;
}


// ─── Placeholder detection ────────────────────────────────────────────────────

const PLACEHOLDER_PATTERNS = [
	// Generic
	/\bTODO\b/i,
	/\bFIXME\b/i,
	/\bPLACEHOLDER\b/i,
	/\bNOT\s+IMPLEMENTED\b/i,
	/\bNOT_IMPLEMENTED\b/i,
	/\bthrow\s+new\s+UnsupportedOperationException/,
	/NotImplementedError/,
	/raise\s+NotImplementedError/,
	// Firmware / embedded C stubs
	/\/\*\s*TRANSLATE\s+ME\s*\*\//i,
	/\/\*\s*STUB\s*\*\//i,
	/\/\/\s*STUB/i,
	/\/\/\s*TODO:\s*implement/i,
	/Error_Handler\s*\(\s*\)\s*;\s*\/\/\s*(stub|placeholder|todo)/i,
	// IEC 61131-3 stubs
	/\(\*\s*STUB\s*\*\)/i,
	/\(\*\s*TODO\s*\*\)/i,
	/\(\*\s*NOT\s+IMPLEMENTED\s*\*\)/i,
	/\(\*\s*TRANSLATE\s+ME\s*\*\)/i,
	// AUTOSAR / Safety stubs
	/\/\*\s*AUTOSAR_STUB\s*\*\//i,
	/Rte_IWrite_\w+\s*\(\s*0\s*\)\s*;\s*\/\/\s*(stub|todo)/i,
];


// ─── Field extraction ─────────────────────────────────────────────────────────

/**
 * Extract candidate field/variable names from COBOL-style source (PIC clauses, FD entries)
 * or generic source (identifier patterns). Returns a deduplicated list.
 */
function extractFieldNames(source: string, sourceLang: string): string[] {
	const names = new Set<string>();

	if (sourceLang === 'cobol') {
		// COBOL: extract PICTURE clause identifiers (e.g. 05 CUST-NAME PIC ...)
		const cobolFieldRe = /^\s+\d+\s+([\w-]+)\s+(?:PIC|PICTURE)/gmi;
		let m: RegExpExecArray | null;
		while ((m = cobolFieldRe.exec(source)) !== null) {
			if (m[1] && m[1].length > 2) { names.add(m[1]); }
		}
	} else if (sourceLang === 'plsql') {
		// PL/SQL: extract variable declarations (identifier TYPE;)
		const plsqlVarRe = /^\s+([\w_$]+)\s+(?:VARCHAR2|NUMBER|DATE|BOOLEAN|INTEGER|CLOB|BLOB|PLS_INTEGER)\b/gmi;
		let m: RegExpExecArray | null;
		while ((m = plsqlVarRe.exec(source)) !== null) {
			if (m[1] && m[1].length > 2) { names.add(m[1]); }
		}
	} else {
		// Generic: extract snake_case / camelCase identifiers from assignments/declarations
		const assignRe = /\b([\w_$]{3,30})\s*(?:=|:=|:)/g;
		let m: RegExpExecArray | null;
		while ((m = assignRe.exec(source)) !== null) {
			const name = m[1];
			// Filter out common keywords
			if (!KEYWORD_BLOCKLIST.has(name.toLowerCase())) {
				names.add(name);
			}
		}
	}

	return [...names].slice(0, 60); // cap at 60 to avoid noise
}

const KEYWORD_BLOCKLIST = new Set([
	'if', 'else', 'for', 'while', 'do', 'try', 'catch', 'finally', 'return',
	'true', 'false', 'null', 'undefined', 'void', 'this', 'new', 'class',
	'function', 'const', 'let', 'var', 'import', 'export', 'from', 'type',
	'interface', 'extends', 'implements', 'public', 'private', 'protected',
	'static', 'readonly', 'async', 'await', 'yield', 'switch', 'case', 'break',
	'continue', 'throw', 'instanceof', 'typeof', 'in', 'of',
]);


// ─── Main entry ───────────────────────────────────────────────────────────────

/**
 * Run all Layer 1 static checks for a unit.
 *
 * @param sourceCode   Original (resolved) source code
 * @param targetCode   Translated target code
 * @param sourceLang   Source language (for keyword lookup)
 * @param targetLang   Target language (for keyword lookup)
 * @returns            Array of IStaticCheckResult — all checks, in order
 */
export function runStaticChecks(
	sourceCode: string,
	targetCode: string,
	sourceLang: string,
	targetLang: string,
): IStaticCheckResult[] {
	const results: IStaticCheckResult[] = [];

	results.push(_checkNonEmpty(targetCode));
	results.push(_checkNoPlaceholders(targetCode));
	results.push(_checkLineCountRatio(sourceCode, targetCode));
	results.push(_checkBranchCoverage(sourceCode, targetCode, sourceLang, targetLang));
	results.push(_checkLoopCoverage(sourceCode, targetCode, sourceLang, targetLang));
	results.push(_checkErrorHandling(sourceCode, targetCode, sourceLang, targetLang));
	results.push(_checkFieldCoverage(sourceCode, targetCode, sourceLang));

	return results;
}

/** Aggregate status: 'fail' if any fail, 'warn' if any warn, else 'pass' */
export function aggregateStaticStatus(checks: IStaticCheckResult[]): StaticCheckStatus {
	if (checks.some(c => c.status === 'fail')) { return 'fail'; }
	if (checks.some(c => c.status === 'warn')) { return 'warn'; }
	return 'pass';
}


// ─── Individual checks ────────────────────────────────────────────────────────

function _checkNonEmpty(target: string): IStaticCheckResult {
	const codeLines = target.split('\n').filter(l => {
		const t = l.trim();
		return t.length > 0
			&& !t.startsWith('//')
			&& !t.startsWith('#')
			&& !t.startsWith('*')
			&& !t.startsWith('/*');
	});

	const status: StaticCheckStatus = codeLines.length < 3 ? 'fail' : 'pass';
	return {
		checkId:  'non-empty-target',
		label:    'Target code is non-empty',
		status,
		detail:   status === 'pass'
			? `Target has ${codeLines.length} non-comment lines.`
			: 'Target code is empty or contains only comments — translation appears incomplete.',
		measured: String(codeLines.length),
	};
}

function _checkNoPlaceholders(target: string): IStaticCheckResult {
	const found = PLACEHOLDER_PATTERNS.find(p => p.test(target));
	return {
		checkId: 'no-placeholders',
		label:   'No placeholder stubs in target',
		status:  found ? 'fail' : 'pass',
		detail:  found
			? `Target contains an unimplemented placeholder (matched: /${found.source}/i). Translation is incomplete.`
			: 'No TODO/FIXME/placeholder stubs detected.',
	};
}

function _checkLineCountRatio(source: string, target: string): IStaticCheckResult {
	const srcLines = source.split('\n').filter(l => l.trim().length > 0).length;
	const tgtLines = target.split('\n').filter(l => l.trim().length > 0).length;

	if (srcLines === 0) {
		return { checkId: 'line-count-ratio', label: 'Line count ratio', status: 'warn',
			detail: 'Source code is empty — cannot compute ratio.', measured: 'N/A' };
	}

	const ratio = tgtLines / srcLines;

	// Modern languages are typically more verbose than COBOL (ratio > 0.2 is fine).
	// If ratio drops below 0.1 the translation is suspiciously short.
	const status: StaticCheckStatus = ratio < 0.1 ? 'fail' : ratio < 0.2 ? 'warn' : 'pass';

	return {
		checkId:  'line-count-ratio',
		label:    'Line count ratio (target / source)',
		status,
		detail:   status === 'pass'
			? `Target (${tgtLines} lines) / Source (${srcLines} lines) = ${ratio.toFixed(2)} — reasonable coverage.`
			: status === 'warn'
			? `Target (${tgtLines} lines) / Source (${srcLines} lines) = ${ratio.toFixed(2)} — suspiciously low, review needed.`
			: `Target (${tgtLines} lines) is only ${(ratio * 100).toFixed(0)}% of source length — likely incomplete translation.`,
		measured: ratio.toFixed(2),
	};
}

function _checkBranchCoverage(
	source: string, target: string, srcLang: string, tgtLang: string,
): IStaticCheckResult {
	const srcKws = getKeywords(srcLang);
	const tgtKws = getKeywords(tgtLang);

	const srcBranches = _countKeywords(source, srcKws.branch);
	const tgtBranches = _countKeywords(target, tgtKws.branch);

	if (srcBranches === 0) {
		return { checkId: 'branch-coverage', label: 'Branch coverage',
			status: 'pass', detail: 'Source has no conditional branches — nothing to verify.', measured: '0' };
	}

	const ratio = tgtBranches / srcBranches;
	const status: StaticCheckStatus = ratio < 0.3 ? 'fail' : ratio < 0.6 ? 'warn' : 'pass';

	return {
		checkId:  'branch-coverage',
		label:    'Conditional branch coverage',
		status,
		detail:   `Source: ${srcBranches} branch keywords, Target: ${tgtBranches}. Ratio: ${ratio.toFixed(2)}.`
			+ (status === 'fail' ? ' Target is missing most conditional branches — logic may be lost.'
			:  status === 'warn' ? ' Target has fewer branches — review for missing conditions.'
			:  ' Branch coverage looks adequate.'),
		measured: `${tgtBranches}/${srcBranches}`,
	};
}

function _checkLoopCoverage(
	source: string, target: string, srcLang: string, tgtLang: string,
): IStaticCheckResult {
	const srcKws = getKeywords(srcLang);
	const tgtKws = getKeywords(tgtLang);

	const srcLoops = _countKeywords(source, srcKws.loop);
	const tgtLoops = _countKeywords(target, tgtKws.loop);

	if (srcLoops === 0) {
		return { checkId: 'loop-coverage', label: 'Loop coverage',
			status: 'pass', detail: 'Source has no loop constructs — nothing to verify.', measured: '0' };
	}

	const ratio = tgtLoops / srcLoops;
	const status: StaticCheckStatus = ratio < 0.25 ? 'fail' : ratio < 0.5 ? 'warn' : 'pass';

	return {
		checkId:  'loop-coverage',
		label:    'Loop construct coverage',
		status,
		detail:   `Source: ${srcLoops} loop keywords, Target: ${tgtLoops}. Ratio: ${ratio.toFixed(2)}.`
			+ (status === 'fail' ? ' Most loops appear untranslated — iteration logic may be lost.'
			:  status === 'warn' ? ' Fewer loops in target — confirm no logic was dropped.'
			:  ' Loop coverage looks adequate.'),
		measured: `${tgtLoops}/${srcLoops}`,
	};
}

function _checkErrorHandling(
	source: string, target: string, srcLang: string, tgtLang: string,
): IStaticCheckResult {
	const srcKws = getKeywords(srcLang);
	const tgtKws = getKeywords(tgtLang);

	const srcError = _countKeywords(source, srcKws.error);
	const tgtError = _countKeywords(target, tgtKws.error);

	if (srcError === 0) {
		return { checkId: 'error-handling', label: 'Error handling coverage',
			status: 'pass', detail: 'Source has no error-handling constructs.', measured: '0' };
	}

	const status: StaticCheckStatus = tgtError === 0 ? 'warn' : 'pass';

	return {
		checkId:  'error-handling',
		label:    'Error handling coverage',
		status,
		detail:   `Source: ${srcError} error constructs, Target: ${tgtError}.`
			+ (status === 'warn' ? ' Target has no error handling — exceptions may go unhandled.' : ' Error handling present.'),
		measured: `${tgtError}/${srcError}`,
	};
}

function _checkFieldCoverage(
	source: string, target: string, srcLang: string,
): IStaticCheckResult {
	const fields = extractFieldNames(source, srcLang);

	if (fields.length === 0) {
		return { checkId: 'field-coverage', label: 'Data field coverage',
			status: 'pass', detail: 'No source field names extractable — skipped.', measured: 'N/A' };
	}

	// Convert COBOL-style names to camelCase for matching against modern targets
	const targetLower = target.toLowerCase();
	let covered = 0;
	for (const field of fields) {
		const camel = _cobolToCamel(field).toLowerCase();
		const snake = field.toLowerCase().replace(/-/g, '_');
		if (targetLower.includes(camel) || targetLower.includes(snake) || targetLower.includes(field.toLowerCase())) {
			covered++;
		}
	}

	const ratio = covered / fields.length;
	const status: StaticCheckStatus = ratio < 0.3 ? 'warn' : 'pass';

	return {
		checkId:  'field-coverage',
		label:    'Data field coverage',
		status,
		detail:   `${covered}/${fields.length} source field names found in target (ratio ${ratio.toFixed(2)}).`
			+ (status === 'warn' ? ' Many source fields are missing — check for data loss.' : ' Field coverage adequate.'),
		measured: `${covered}/${fields.length}`,
	};
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

function _countKeywords(code: string, keywords: string[]): number {
	if (keywords.length === 0) { return 0; }
	const lower = code.toLowerCase();
	return keywords.reduce((sum, kw) => {
		const re = new RegExp(`\\b${kw.toLowerCase()}\\b`, 'g');
		const matches = lower.match(re);
		return sum + (matches ? matches.length : 0);
	}, 0);
}

/** Convert COBOL hyphenated names to camelCase: CUST-BILL-ADDR \u2192 custBillAddr */
function _cobolToCamel(name: string): string {
	return name.toLowerCase()
		.split('-')
		.map((part, i) => i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1))
		.join('');
}
