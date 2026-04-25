/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Complexity Analyzer
 *
 * Computes per-unit complexity metrics purely from source text \u2014 no AST, no LSP.
 * Used by the migration planner to estimate migration effort, prioritise units,
 * and flag hotspot candidates.
 *
 * ## Metrics
 *
 * | Metric                | Description                                                            |
 * |-----------------------|------------------------------------------------------------------------|
 * | `lineCount`           | Raw source lines in the unit's range                                  |
 * | `logicalLineCount`    | Non-blank, non-comment source lines                                   |
 * | `cyclomaticComplexity`| 1 + number of decision-point keywords (if/else/for/while/case/catch\u2026) |
 * | `nestingDepth`        | Maximum brace/indent nesting depth seen in the unit                   |
 * | `callCount`           | Outgoing calls: COBOL PERFORM, Java/TS method calls, Python calls()   |
 * | `paramCount`          | Formal parameter count (first declaration found)                      |
 * | `hasExternalCalls`    | CICS EXEC, REST fetch/axios, CALL to external program                 |
 * | `hasDatabaseOps`      | SQL DML/DDL, EXEC SQL, JDBC, ORM calls                                |
 * | `hasFileOps`          | OPEN/CLOSE/READ/WRITE on files (COBOL, Java, Python, etc.)            |
 * | `hasUIInteraction`    | CICS SEND MAP, @Controller, React render, DISPLAY                     |
 *
 * ## Cyclomatic Complexity Estimation
 *
 * True McCabe complexity requires a full CFG. We approximate it by counting
 * decision-point keywords per language. The formula:
 *
 *   CC \u2248 1 + count(decision keywords in the unit)
 *
 * This over-counts in some cases (e.g., ternary inside a return) and under-counts
 * in others (e.g., exception handlers), but gives a useful relative ranking.
 */

import { IUnitComplexity } from './discoveryTypes.js';

// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Compute complexity metrics for a single unit's source text.
 *
 * @param content  The source text of this unit (not the whole file)
 * @param lang     Normalised language key
 */
export function analyzeComplexity(content: string, lang: string): IUnitComplexity {
	const lines = content.split('\n');
	return {
		lineCount:           lines.length,
		logicalLineCount:    countLogicalLines(lines, lang),
		cyclomaticComplexity: estimateCyclomaticComplexity(content, lang),
		nestingDepth:        measureNestingDepth(content, lang),
		callCount:           countCalls(content, lang),
		paramCount:          extractParamCount(content, lang),
		hasExternalCalls:    detectExternalCalls(content, lang),
		hasDatabaseOps:      detectDatabaseOps(content, lang),
		hasFileOps:          detectFileOps(content, lang),
		hasUIInteraction:    detectUIInteraction(content, lang),
	};
}

// \u2500\u2500\u2500 Logical Line Count \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function countLogicalLines(lines: string[], lang: string): number {
	let count = 0;
	let inBlockComment = false;

	for (const raw of lines) {
		const t = raw.trim();
		if (!t) { continue; }

		// Block comment handling (C-family + market vertical languages)
		if (lang === 'c' || lang === 'cpp' || lang === 'embedded-c' || lang === 'embedded-cpp' ||
		    lang === 'java' || lang === 'kotlin' ||
		    lang === 'csharp' || lang === 'typescript' || lang === 'javascript' ||
		    lang === 'go' || lang === 'rust' || lang === 'scala' || lang === 'swift' ||
		    lang === 'dart' || lang === 'php' || lang === 'groovy' ||
		    lang === 'ttcn3' || lang === 'autosar') {
			if (inBlockComment) {
				if (t.includes('*/')) { inBlockComment = false; }
				continue;
			}
			if (t.startsWith('/*') || t.startsWith('/**')) {
				if (!t.includes('*/')) { inBlockComment = true; }
				continue;
			}
			if (t.startsWith('//') || t.startsWith('///')) { continue; }
		}

		if (lang === 'cobol') {
			// COBOL: col 7 = '*' or '/' \u2192 comment
			if (raw.length >= 7 && (raw[6] === '*' || raw[6] === '/')) { continue; }
			const area = raw.slice(6).trim();
			if (!area) { continue; }
		}

		if (lang === 'python' || lang === 'ruby') {
			if (t.startsWith('#')) { continue; }
		}

		if (lang === 'sql' || lang === 'plsql') {
			if (t.startsWith('--') || (t.startsWith('/*') && !inBlockComment)) {
				if (t.startsWith('/*') && !t.includes('*/')) { inBlockComment = true; }
				continue;
			}
		}

		if (lang === 'haskell' || lang === 'lua') {
			if (t.startsWith('--')) { continue; }
		}

		count++;
	}
	return count;
}

// \u2500\u2500\u2500 Cyclomatic Complexity \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Decision keywords per language whose presence in source adds 1 to CC.
 * Each pattern is a whole-word regex or keyword list.
 */
const CC_PATTERNS: Record<string, RegExp> = {
	java:           /\b(if|else\s+if|for|while|do|switch|case|catch|&&|\|\||\?(?!:))\b/g,
	kotlin:         /\b(if|else\s+if|for|while|when|catch|&&|\|\||\?(?!:))\b/g,
	scala:          /\b(if|else\s+if|for|while|match|case|catch|&&|\|\||\?)\b/g,
	csharp:         /\b(if|else\s+if|for|foreach|while|do|switch|case|catch|&&|\|\||\?(?!:))\b/g,
	typescript:     /\b(if|else\s+if|for|while|do|switch|case|catch|&&|\|\||\?(?!:))\b/g,
	javascript:     /\b(if|else\s+if|for|while|do|switch|case|catch|&&|\|\||\?(?!:))\b/g,
	python:         /\b(if|elif|for|while|except|and|or)\b/g,
	go:             /\b(if|else\s+if|for|switch|case|select|&&|\|\|)\b/g,
	rust:           /\b(if|else\s+if|for|while|loop|match|&&|\|\|)\b/g,
	ruby:           /\b(if|elsif|unless|while|until|for|rescue|and|or|\|\|)\b/g,
	php:            /\b(if|elseif|for|foreach|while|do|switch|case|catch|&&|\|\|)\b/g,
	swift:          /\b(if|else\s+if|guard|for|while|repeat|switch|case|catch|&&|\|\|)\b/g,
	dart:           /\b(if|else\s+if|for|while|do|switch|case|catch|&&|\|\|)\b/g,
	groovy:         /\b(if|else\s+if|for|while|do|switch|case|catch|&&|\|\|)\b/g,
	cobol:          /\b(IF|ELSE|EVALUATE|WHEN|UNTIL|VARYING|PERFORM\s+UNTIL)\b/g,
	plsql:          /\b(IF|ELSIF|ELSE|LOOP|WHILE|FOR|CASE|WHEN|EXCEPTION|WHEN\s+OTHERS)\b/g,
	pl1:            /\b(IF|THEN|ELSE|DO|WHILE|UNTIL|SELECT|WHEN|ON|SIGNAL)\b/g,
	rpg:            /\b(IF|ELSEIF|SELECT|WHEN|OTHER|DOW|DOU|FOR)\b/gi,
	// \u2500\u2500 Market vertical languages \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	c:              /\b(if|else\s+if|for|while|do|switch|case|&&|\|\|)\b/g,
	cpp:            /\b(if|else\s+if|for|while|do|switch|case|catch|&&|\|\|)\b/g,
	'embedded-c':   /\b(if|else\s+if|for|while|do|switch|case|&&|\|\|)\b/g,
	'embedded-cpp': /\b(if|else\s+if|for|while|do|switch|case|catch|&&|\|\|)\b/g,
	iec61131:       /\b(IF|ELSIF|ELSE|END_IF|CASE|OF|END_CASE|FOR|TO|BY|END_FOR|WHILE|REPEAT|UNTIL|END_WHILE|END_REPEAT|AND_THEN|OR_ELSE)\b/g,
	ttcn3:          /\b(if|else|for|while|alt|interleave|select|case|&&|\|\|)\b/g,
};

function estimateCyclomaticComplexity(content: string, lang: string): number {
	const pattern = CC_PATTERNS[lang] ?? CC_PATTERNS['typescript'];
	const stripped = stripStringsAndComments(content, lang);
	const matches  = stripped.match(pattern);
	return 1 + (matches?.length ?? 0);
}

// \u2500\u2500\u2500 Nesting Depth \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Measure maximum nesting depth using:
 * - Brace-based languages: `{` / `}`
 * - Indent-based (Python): leading whitespace per logical line
 * - COBOL: section/paragraph structure is flat; count PERFORMs as proxy
 */
function measureNestingDepth(content: string, lang: string): number {
	if (lang === 'python') { return measurePythonNesting(content); }
	if (lang === 'cobol')  { return measureCobolNesting(content); }
	if (lang === 'iec61131') { return measureIEC61131Nesting(content); }
	if (lang === 'ttcn3')    { return measureTTCN3Nesting(content); }

	// Brace-based (C, C++, embedded-c, embedded-cpp, Java, Rust, Go, etc.)
	const stripped = stripStringsAndComments(content, lang);
	let depth = 0;
	let max   = 0;
	for (const ch of stripped) {
		if (ch === '{') { depth++; if (depth > max) { max = depth; } }
		if (ch === '}') { depth = Math.max(0, depth - 1); }
	}
	return max;
}

function measurePythonNesting(content: string): number {
	let max = 0;
	for (const line of content.split('\n')) {
		if (!line.trim() || line.trim().startsWith('#')) { continue; }
		const indent = line.match(/^(\s+)/)?.[1].length ?? 0;
		const depth  = Math.floor(indent / 4); // assume 4-space indent
		if (depth > max) { max = depth; }
	}
	return max;
}

function measureCobolNesting(content: string): number {
	// COBOL is mostly flat; count IF/EVALUATE nesting as a proxy
	let depth = 0;
	let max   = 0;
	for (const line of content.split('\n')) {
		const t = line.slice(6).trim().toUpperCase();
		if (/^IF\b/.test(t) || /^EVALUATE\b/.test(t)) { depth++; if (depth > max) { max = depth; } }
		if (/^END-IF\b/.test(t) || /^END-EVALUATE\b/.test(t)) { depth = Math.max(0, depth - 1); }
	}
	return max;
}

function measureIEC61131Nesting(content: string): number {
	// IEC 61131-3 Structured Text: count IF/CASE/FOR/WHILE/REPEAT blocks
	let depth = 0;
	let max   = 0;
	for (const line of content.split('\n')) {
		const t = line.trim().toUpperCase();
		// Block openers
		if (/^IF\b/.test(t) || /^CASE\b/.test(t) || /^FOR\b/.test(t) ||
		    /^WHILE\b/.test(t) || /^REPEAT\b/.test(t)) {
			depth++; if (depth > max) { max = depth; }
		}
		// Block closers
		if (/^END_IF\b/.test(t) || /^END_CASE\b/.test(t) || /^END_FOR\b/.test(t) ||
		    /^END_WHILE\b/.test(t) || /^UNTIL\b/.test(t)) {
			depth = Math.max(0, depth - 1);
		}
	}
	return max;
}

function measureTTCN3Nesting(content: string): number {
	// TTCN-3: count { } brace depth (same as C but with alt/interleave keywords)
	const stripped = content.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '');
	let depth = 0;
	let max   = 0;
	for (const ch of stripped) {
		if (ch === '{') { depth++; if (depth > max) { max = depth; } }
		if (ch === '}') { depth = Math.max(0, depth - 1); }
	}
	return max;
}

// \u2500\u2500\u2500 Call Count \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const CALL_PATTERNS: Record<string, RegExp> = {
	cobol:          /\bPERFORM\b/gi,
	java:           /\.\s*\w+\s*\(/g,
	kotlin:         /\.\s*\w+\s*\(/g,
	scala:          /\.\s*\w+\s*\(/g,
	csharp:         /\.\s*\w+\s*\(/g,
	typescript:     /\.\s*\w+\s*\(/g,
	javascript:     /\.\s*\w+\s*\(/g,
	python:         /\b\w+\s*\(/g,
	go:             /\b\w+\s*\(/g,
	rust:           /\b\w+\s*\(/g,
	ruby:           /\b\w+\s*[({]/g,
	php:            /\b\w+\s*\(/g,
	swift:          /\b\w+\s*\(/g,
	dart:           /\b\w+\s*\(/g,
	plsql:          /\b\w+\s*\(/g,
	// Market vertical languages
	c:              /\b\w+\s*\(/g,
	cpp:            /\b\w+\s*\(/g,
	'embedded-c':   /\b\w+\s*\(/g,
	'embedded-cpp': /\b\w+\s*\(/g,
	iec61131:       /\b\w+\s*\(/g,    // Function block calls
	ttcn3:          /\b\w+\s*\(/g,
};

function countCalls(content: string, lang: string): number {
	const pattern = CALL_PATTERNS[lang];
	if (!pattern) { return 0; }
	const stripped = stripStringsAndComments(content, lang);
	return (stripped.match(pattern) ?? []).length;
}

// \u2500\u2500\u2500 Parameter Count \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractParamCount(content: string, lang: string): number {
	let m: RegExpExecArray | null = null;

	if (lang === 'cobol') {
		// USING clause in PROCEDURE DIVISION
		m = /PROCEDURE\s+DIVISION\s+USING\s+([^.]+)\./i.exec(content);
		if (m) {
			return m[1].trim().split(/\s+/).filter(Boolean).length;
		}
		return 0;
	}

	if (lang === 'python') {
		m = /^(?:async\s+)?def\s+\w+\s*\(([^)]*)\)/m.exec(content);
	} else if (lang === 'go') {
		m = /^func\s+(?:\([^)]+\)\s+)?\w+\s*\(([^)]*)\)/m.exec(content);
	} else if (lang === 'rust') {
		m = /^(?:pub\s+)?(?:async\s+)?fn\s+\w+\s*(?:<[^>]+>)?\s*\(([^)]*)\)/m.exec(content);
	} else {
		// C-family: fn(a: T, b: T, c: T)
		m = /(?:function|def|fn|fun|func|sub|procedure)\s+\w+\s*\(([^)]*)\)/im.exec(content);
	}

	if (!m || !m[1].trim()) { return 0; }
	return m[1].split(',').filter(p => p.trim()).length;
}

// \u2500\u2500\u2500 Boolean Detectors \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function detectExternalCalls(content: string, lang: string): boolean {
	const upper = content.toUpperCase();
	if (lang === 'cobol') {
		return /\bEXEC\s+CICS\b/.test(upper) ||
		       /\bCALL\s+['"][^'"]+['"]/.test(content);
	}
	// REST/HTTP calls
	if (/\bfetch\s*\(|\baxios\b|\bhttp\.get\b|\bhttps\.get\b|\bHttpClient\b|\bRestTemplate\b|\bWebClient\b|\brequests\.get\b|\brequests\.post\b/.test(content)) { return true; }
	// RPC
	if (/\bgrpc\b|\bXMLRPC\b|\bSOAP\b/i.test(content)) { return true; }
	// Firmware / embedded external calls
	if (['c', 'cpp', 'embedded-c', 'embedded-cpp'].includes(lang)) {
		// AUTOSAR RTE external calls (cross-SWC)
		if (/\bRte_Call\b|\bRte_Send\b|\bRte_IWrite\b|\bRte_IRead\b/.test(content)) { return true; }
		// CAN / LIN / SPI / I2C bus transactions
		if (/\b(?:HAL_SPI_Transmit|HAL_I2C_Master_Transmit|CAN_Transmit|FlexCAN_Init|UART_Transmit)\b/i.test(content)) { return true; }
		// MQTT / OPC-UA protocol calls
		if (/\bMQTT_Publish\b|\bUA_Client_connect\b|\bua_client\b/i.test(content)) { return true; }
	}
	if (lang === 'iec61131') {
		// IEC 61131-3: calls to external function blocks (FB_xxx patterns, CODESYS online change)
		if (/\bCALLNAT\b|\bCALL\s+\w+/i.test(content)) { return true; }
	}
	if (lang === 'ttcn3') {
		// TTCN-3: port send/receive operations
		if (/\b\w+\.send\s*\(|\b\w+\.receive\s*\(|\b\w+\.call\s*\(/i.test(content)) { return true; }
	}
	return false;
}

function detectDatabaseOps(content: string, lang: string): boolean {
	const upper = content.toUpperCase();
	if (/\bEXEC\s+SQL\b|\bSELECT\b.*\bFROM\b|\bINSERT\s+INTO\b|\bUPDATE\b.*\bSET\b|\bDELETE\s+FROM\b/.test(upper)) { return true; }
	if (/\bEXEC\s+CICS\s+(READ|WRITE|REWRITE|DELETE)\b/i.test(upper)) { return true; }
	// ORM patterns
	if (/\bEntityManager\b|\brepository\.\w+\(|\bSession\b\s*\.\s*\w+\(|\bdbContext\.\b|\borm\.\b|\bknex\b|\bsequelize\b|\bprisma\.\b|\btypeorm\b/i.test(content)) { return true; }
	return false;
}

function detectFileOps(content: string, lang: string): boolean {
	const upper = content.toUpperCase();
	if (lang === 'cobol') {
		return /\b(OPEN|CLOSE|READ|WRITE|REWRITE|DELETE)\s+\w/.test(upper);
	}
	return /\bopen\s*\(|\bfopen\s*\(|\bFile\.\b|\bFileStream\b|\bBufferedReader\b|\bBufferedWriter\b|\bfs\.readFile\b|\bfs\.writeFile\b|\bio\.open\b|\bopen\(.*['"rwa]/i.test(content);
}

function detectUIInteraction(content: string, lang: string): boolean {
	const upper = content.toUpperCase();
	if (/\bEXEC\s+CICS\s+SEND\b/i.test(upper)) { return true; }
	if (/\bDISPLAY\b/.test(upper) && lang === 'cobol') { return true; }
	// Web frameworks
	if (/@Controller|@RestController|@GetMapping|@PostMapping|@RequestMapping|\.render\s*\(|\.json\s*\(|res\.send\s*\(|return\s+(<[A-Z]|\bjsx\b|\bTemplate)/i.test(content)) { return true; }
	// Qt, WinForms, JavaFX
	if (/\bQWidget\b|\bForm\b.*\bDesigner\b|\bScene\b.*\bFXML\b/i.test(content)) { return true; }
	return false;
}

// \u2500\u2500\u2500 String / Comment Stripper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Very lightweight string + line-comment stripper used before regex scanning.
 * Not a full parser \u2014 good enough for keyword counting.
 */
function stripStringsAndComments(content: string, lang: string): string {
	// Remove single-line string literals
	let s = content.replace(/"(?:[^"\\]|\\.)*"/g, '""');
	s = s.replace(/'(?:[^'\\]|\\.)*'/g, "''");
	// Remove template literals (JS/TS)
	if (lang === 'typescript' || lang === 'javascript') {
		s = s.replace(/`(?:[^`\\]|\\.)*`/g, '``');
	}
	// Remove line comments
	if (lang === 'cobol') {
		s = s.split('\n').map(l => l.length >= 7 && (l[6] === '*' || l[6] === '/') ? '' : l).join('\n');
	} else if (lang === 'python' || lang === 'ruby' || lang === 'shell') {
		s = s.replace(/#.*$/gm, '');
	} else if (lang === 'sql' || lang === 'plsql') {
		s = s.replace(/--.*$/gm, '');
	} else if (lang === 'iec61131') {
		// IEC 61131-3 Structured Text: (* ... *) block comments and // line comments
		s = s.replace(/\(\*[\s\S]*?\*\)/g, ' ');
		s = s.replace(/\/\/.*$/gm, '');
	} else if (lang === 'assembler') {
		// Most assemblers: ; line comments
		s = s.replace(/;.*$/gm, '');
	} else {
		s = s.replace(/\/\/.*$/gm, '');
		// Block comments
		s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
	}
	return s;
}
