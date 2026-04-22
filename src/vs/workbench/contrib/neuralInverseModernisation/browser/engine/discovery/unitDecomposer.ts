/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Unit Decomposer
 *
 * Breaks a source file into language-appropriate `IDecomposedUnit` records.
 * Each unit maps to one `IMigrationUnit` in the discovery result.
 *
 * ## Granularity per language
 *
 * | Language              | Granularity                                              |
 * |-----------------------|----------------------------------------------------------|
 * | Embedded C / C        | Top-level function (ISR, HAL init, application logic)    |
 * | Embedded C++          | Top-level class, struct, namespace-scope function        |
 * | Assembly (ARM/AVR)    | Subroutine labels (function-level)                       |
 * | IEC 61131-3 (ST/LD)   | PROGRAM / FUNCTION_BLOCK / FUNCTION declarations         |
 * | Java / Kotlin / Scala | Top-level class, interface, object, enum, record         |
 * | C#                    | Top-level class, interface, struct, enum, record         |
 * | Python                | Top-level class, top-level function / async def          |
 * | TypeScript / JS       | Exported class, exported function, exported const arrow  |
 * | Go                    | Exported function, type struct/interface declaration     |
 * | Rust                  | pub fn, struct, enum, trait, impl block                  |
 * | Everything else       | One unit per file (module granularity)                   |
 *
 * The decomposer is purely text-based — no AST / LSP is used — so it is fast,
 * language-server-free, and works on any folder the user selects.
 */

import { IDecomposedUnit, MigrationUnitType } from './discoveryTypes.js';

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Decompose `content` into `IDecomposedUnit[]`.
 *
 * @param content  Full file text
 * @param lang     Normalised language key (from `detectLanguage`)
 * @param fileName Filename including extension (used for fallback unit naming)
 * @param lines    Pre-split lines array (avoids redundant split in the caller)
 */
export function decomposeFile(
	content: string,
	lang: string,
	fileName: string,
	lines: string[],
): IDecomposedUnit[] {
	switch (lang) {
		// ── Firmware languages ──────────────────────────────────────────
		case 'c':
		case 'embedded-c':  return decomposeEmbeddedC(lines, fileName);
		case 'cpp':
		case 'embedded-cpp':return decomposeEmbeddedCpp(lines, fileName);
		case 'assembler':   return decomposeAssembly(lines, fileName);
		case 'iec61131':    return decomposeIEC61131(lines, fileName);
		// ── Automotive ────────────────────────────────────────────────
		case 'autosar':     return decomposeAutosar(content, lines, fileName);
		case 'can-dbc':     return decomposeCanDbc(lines, fileName);
		// ── Telecom ───────────────────────────────────────────────────
		case 'ttcn3':       return decomposeTTCN3(lines, fileName);
		// ── General-purpose languages (retained for hybrid projects) ───
		case 'java':        return decomposeJVM(lines, fileName, 'java');
		case 'kotlin':      return decomposeJVM(lines, fileName, 'kotlin');
		case 'scala':       return decomposeJVM(lines, fileName, 'scala');
		case 'csharp':      return decomposeCSharp(lines, fileName);
		case 'python':      return decomposePython(lines, fileName);
		case 'typescript':
		case 'javascript':  return decomposeTypeScriptJS(lines, fileName);
		case 'go':          return decomposeGo(lines, fileName);
		case 'rust':        return decomposeRust(lines, fileName);
		default:            return [fileUnit(fileName, lines.length)];
	}
}


// ─── Embedded C ──────────────────────────────────────────────────────────────
//
// Granularity: top-level function definitions.
// We detect:
//  - ISR handlers:  void TIMER2_IRQHandler(void)
//  - HAL init:      void MX_UART1_Init(void), HAL_StatusTypeDef HAL_UART_Init(...)
//  - Task functions: void vMyTask(void *pvParams)
//  - Application:   any other top-level function with a brace body
//
// We exclude:
//  - inline function declarations (no body on same line)
//  - preprocessor blocks (#ifdef guards, struct definitions)

const C_FUNC_RE = /^(?:[\/\w_*\s]+?)\b(\w+)\s*\(([^;{]*)\)\s*(?:__attribute__\s*\(\([^)]+\)\)\s*)?\{?\s*$/;
const C_INCLUDE_RE = /^\s*#\s*include\s*["<]([^">.]+(?:\.h)?)[">/]/;
const C_ISR_RE = /\bvoid\s+\w+_IRQHandler\s*\(/;
const C_RTOS_TASK_RE = /\bvoid\s+v[A-Z]\w+\s*\(\s*void\s*\*\s*\w*\s*\)/;
const C_HAL_RE = /\b(?:HAL_|BSP_|MX_)\w+/;

function decomposeEmbeddedC(lines: string[], fileName: string): IDecomposedUnit[] {
	const baseName = fileName.replace(/\.[^.]+$/, '');
	const fileImports: string[] = [];
	const units: IDecomposedUnit[] = [];

	for (const line of lines) {
		const m = C_INCLUDE_RE.exec(line);
		if (m) { fileImports.push(m[1]); }
	}

	let currentName: string | null = null;
	let currentStart = 1;
	let currentType: MigrationUnitType = 'function';
	let braceDepth = 0;

	const flush = (endLine: number) => {
		if (!currentName || endLine < currentStart) { return; }
		units.push({
			name: currentName,
			type: currentType,
			range: { startLine: currentStart, startColumn: 1, endLine, endColumn: 1 },
			rawImports: fileImports,
		});
		currentName = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1;
		const raw = lines[i];
		// Strip line comments for brace counting
		const stripped = raw.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');

		for (const ch of stripped) {
			if (ch === '{') { braceDepth++; }
			if (ch === '}') {
				braceDepth--;
				if (currentName && braceDepth === 0) {
					flush(lineNum);
				}
			}
		}

		// Detect top-level function start (braceDepth 0 → entering body)
		if (braceDepth === 0 && !currentName) {
			const fm = C_FUNC_RE.exec(raw);
			if (fm && fm[1] && !C_RESERVED.has(fm[1])) {
				currentName = `${baseName}$${fm[1]}`;
				currentStart = lineNum;
				// Classify unit type
				if (C_ISR_RE.test(raw)) {
					currentType = 'isr';
				} else if (C_RTOS_TASK_RE.test(raw)) {
					currentType = 'rtos-task';
				} else if (C_HAL_RE.test(raw)) {
					currentType = 'hal-driver';
				} else {
					currentType = 'function';
				}
			}
		}
	}
	flush(lines.length);

	return units.length > 0 ? units : [fileUnit(fileName, lines.length)];
}

/** C keywords / attributes that look like function names but aren't */
const C_RESERVED = new Set([
	'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'return', 'break',
	'continue', 'goto', 'typedef', 'struct', 'enum', 'union', 'sizeof',
	'static', 'extern', 'volatile', 'const', 'register', 'inline',
	'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t',
]);


// ─── Embedded C++ ─────────────────────────────────────────────────────────────

const CPP_CLASS_RE = /^(?:(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+(\w+))/;
const CPP_FUNC_RE  = /^(?:static\s+|inline\s+|virtual\s+|constexpr\s+|explicit\s+)?(?:[\w:*&<>]+\s+)+([\w:~]+)\s*\(/;

function decomposeEmbeddedCpp(lines: string[], fileName: string): IDecomposedUnit[] {
	const baseName  = fileName.replace(/\.[^.]+$/, '');
	const fileImports: string[] = [];
	const units: IDecomposedUnit[] = [];

	for (const line of lines) {
		const m = /^\s*#\s*include\s*["<]([^">.]+[^>"]*)[">/]/.exec(line);
		if (m) { fileImports.push(m[1]); }
	}

	let currentName: string | null = null;
	let currentStart = 1;
	let currentType: MigrationUnitType = 'class';
	let braceDepth = 0;
	let unitEntryDepth = -1;

	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1;
		const stripped = lines[i].replace(/\/\/.*$/, '');

		for (const ch of stripped) {
			if (ch === '{') { braceDepth++; }
			if (ch === '}') {
				braceDepth--;
				if (currentName && braceDepth === unitEntryDepth - 1) {
					units.push({ name: currentName, type: currentType, range: { startLine: currentStart, startColumn: 1, endLine: lineNum, endColumn: 1 }, rawImports: fileImports });
					currentName = null; unitEntryDepth = -1;
				}
			}
		}

		if (braceDepth <= 1 && !currentName) {
			const cm = CPP_CLASS_RE.exec(lines[i]);
			if (cm) { currentName = `${baseName}$${cm[1]}`; currentStart = lineNum; currentType = 'class'; unitEntryDepth = braceDepth + 1; continue; }
			const fm = CPP_FUNC_RE.exec(lines[i]);
			if (fm && !C_RESERVED.has(fm[1])) { currentName = `${baseName}$${fm[1]}`; currentStart = lineNum; currentType = 'function'; unitEntryDepth = braceDepth + 1; }
		}
	}
	if (currentName) {
		units.push({ name: currentName, type: currentType, range: { startLine: currentStart, startColumn: 1, endLine: lines.length, endColumn: 1 }, rawImports: fileImports });
	}
	return units.length > 0 ? units : [fileUnit(fileName, lines.length)];
}


// ─── Assembly (ARM / AVR) ─────────────────────────────────────────────────────
//
// Granularity: subroutine labels (word followed by colon at column 0, ARM @function)
// We collect #include and .include directives as rawImports.

const ASM_LABEL_RE = /^([A-Za-z_]\w*):\s*(?:\/\/.*)?$/;
const ASM_ISR_RE   = /\b(\w+_IRQHandler|\w+_Handler|Reset_Handler|HardFault_Handler)\b/;
const ASM_INC_RE   = /^\s*(?:#include|.include)\s+["<]?([\w./]+)[">/]?/i;

function decomposeAssembly(lines: string[], fileName: string): IDecomposedUnit[] {
	const baseName = fileName.replace(/\.[^.]+$/, '');
	const fileImports: string[] = [];
	const units: IDecomposedUnit[] = [];

	for (const line of lines) {
		const m = ASM_INC_RE.exec(line);
		if (m) { fileImports.push(m[1]); }
	}

	let currentName: string | null = null;
	let currentStart = 1;
	let currentType: MigrationUnitType = 'function';

	const flush = (endLine: number) => {
		if (!currentName) { return; }
		units.push({ name: currentName, type: currentType, range: { startLine: currentStart, startColumn: 1, endLine, endColumn: 1 }, rawImports: fileImports });
		currentName = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1;
		const m = ASM_LABEL_RE.exec(lines[i]);
		if (m) {
			flush(lineNum - 1);
			currentName  = `${baseName}$${m[1]}`;
			currentStart = lineNum;
			currentType  = ASM_ISR_RE.test(m[1]) ? 'isr' : 'function';
		}
	}
	flush(lines.length);
	return units.length > 0 ? units : [fileUnit(fileName, lines.length)];
}


// ─── IEC 61131-3 (Structured Text / Ladder) ───────────────────────────────────
//
// Granularity: PROGRAM, FUNCTION_BLOCK, FUNCTION declarations
// We scan for the header keywords and match their END_ counterpart.

const IEC_BLOCK_START_RE = /^\s*(PROGRAM|FUNCTION_BLOCK|FUNCTION)\s+(\w+)/i;
const IEC_BLOCK_END_RE   = /^\s*(END_PROGRAM|END_FUNCTION_BLOCK|END_FUNCTION)\b/i;
const IEC_IMPORT_RE      = /^\s*(?:USES|FROM)\s+([\w.]+)/i;

function decomposeIEC61131(lines: string[], fileName: string): IDecomposedUnit[] {
	const baseName = fileName.replace(/\.[^.]+$/, '');
	const fileImports: string[] = [];
	const units: IDecomposedUnit[] = [];

	for (const line of lines) {
		const m = IEC_IMPORT_RE.exec(line);
		if (m) { fileImports.push(m[1]); }
	}

	let currentName: string | null = null;
	let currentStart = 1;
	let currentType: MigrationUnitType = 'function';

	const flush = (endLine: number) => {
		if (!currentName) { return; }
		units.push({ name: currentName, type: currentType, range: { startLine: currentStart, startColumn: 1, endLine, endColumn: 1 }, rawImports: fileImports });
		currentName = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1;
		const startM = IEC_BLOCK_START_RE.exec(lines[i]);
		if (startM) {
			flush(lineNum - 1);
			const kw = startM[1].toUpperCase();
			currentName  = `${baseName}$${startM[2]}`;
			currentStart = lineNum;
			currentType  = kw === 'PROGRAM' ? 'program' : kw === 'FUNCTION_BLOCK' ? 'function-block' : 'function';
			continue;
		}
		if (IEC_BLOCK_END_RE.test(lines[i])) {
			flush(lineNum);
		}
	}
	flush(lines.length);
	return units.length > 0 ? units : [fileUnit(fileName, lines.length)];
}



// ─── JVM Languages (Java / Kotlin / Scala) ────────────────────────────────────

const JVM_CLASS_RE: Record<string, RegExp> = {
	java:   /(?:^|[\s{])(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record|@interface)\s+(\w+)/,
	kotlin: /(?:^|[\s{])(?:(?:abstract|open|sealed|data|inner|inline|value|external|enum|annotation|fun)\s+)*(?:class|interface|object)\s+(\w+)/,
	scala:  /(?:^|[\s{])(?:(?:abstract|sealed|final|case|implicit|lazy|override)\s+)*(?:class|object|trait)\s+(\w+)/,
};
const JVM_IMPORT_RE: Record<string, RegExp> = {
	java:   /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/,
	kotlin: /^\s*import\s+([\w.]+(?:\.\*)?)/,
	scala:  /^\s*import\s+([\w.]+(?:\.(?:_|\{[^}]+\}))?)/,
};

function decomposeJVM(lines: string[], fileName: string, lang: 'java' | 'kotlin' | 'scala'): IDecomposedUnit[] {
	const CLASS_RE  = JVM_CLASS_RE[lang];
	const IMPORT_RE = JVM_IMPORT_RE[lang];
	const baseName  = fileName.replace(/\.[^.]+$/, '');

	const fileImports: string[] = [];
	const units: IDecomposedUnit[] = [];

	for (const line of lines) {
		const m = IMPORT_RE.exec(line);
		if (m) { fileImports.push(m[1]); }
	}

	let currentName: string | null = null;
	let currentStart = 1;
	let braceDepth = 0;
	let unitEntryDepth = -1;

	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1;
		// Strip line comments and string literals for brace counting
		const stripped = lines[i]
			.replace(/\/\/.*$/, '')
			.replace(/"(?:[^"\\]|\\.)*"/g, '""')
			.replace(/'(?:[^'\\]|\\.)*'/g, "''");

		for (const ch of stripped) {
			if (ch === '{') { braceDepth++; }
			if (ch === '}') {
				braceDepth--;
				// End of a top-level type declaration
				if (currentName && braceDepth === unitEntryDepth - 1) {
					units.push({
						name:       currentName,
						type:       'class',
						range:      { startLine: currentStart, startColumn: 1, endLine: lineNum, endColumn: 1 },
						rawImports: fileImports,
					});
					currentName      = null;
					unitEntryDepth   = -1;
				}
			}
		}

		// Detect a new top-level type at brace depth 0 (or 1 if inside a package block for Scala)
		if (braceDepth <= 1) {
			const m = CLASS_RE.exec(lines[i]);
			if (m && !currentName) {
				currentName      = m[1];
				currentStart     = lineNum;
				unitEntryDepth   = braceDepth + 1;
			}
		}
	}

	// Handle file ending without closing brace (truncated / bad source)
	if (currentName) {
		units.push({
			name:       currentName,
			type:       'class',
			range:      { startLine: currentStart, startColumn: 1, endLine: lines.length, endColumn: 1 },
			rawImports: fileImports,
		});
	}

	if (units.length === 0) {
		return [{ name: baseName, type: 'class', range: { startLine: 1, startColumn: 1, endLine: lines.length, endColumn: 1 }, rawImports: fileImports }];
	}
	return units;
}


// ─── C# ───────────────────────────────────────────────────────────────────────

function decomposeCSharp(lines: string[], fileName: string): IDecomposedUnit[] {
	const CLASS_RE  = /(?:^|[\s{])(?:(?:public|private|protected|internal|abstract|sealed|static|partial|override|new)\s+)*(?:class|interface|struct|enum|record)\s+(\w+)/;
	const USING_RE  = /^\s*using\s+([\w.]+)\s*;/;
	const baseName  = fileName.replace(/\.[^.]+$/, '');

	const fileImports: string[] = [];
	const units: IDecomposedUnit[] = [];

	for (const line of lines) {
		const u = USING_RE.exec(line);
		if (u) { fileImports.push(u[1]); }
	}

	let currentName: string | null = null;
	let currentStart = 1;
	let braceDepth = 0;
	let unitEntryDepth = -1;

	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1;
		const stripped = lines[i].replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');

		for (const ch of stripped) {
			if (ch === '{') { braceDepth++; }
			if (ch === '}') {
				braceDepth--;
				if (currentName && braceDepth === unitEntryDepth - 1) {
					units.push({ name: currentName, type: 'class', range: { startLine: currentStart, startColumn: 1, endLine: lineNum, endColumn: 1 }, rawImports: fileImports });
					currentName    = null;
					unitEntryDepth = -1;
				}
			}
		}

		if (braceDepth <= 1 && !currentName) {
			const m = CLASS_RE.exec(lines[i]);
			if (m) {
				currentName    = m[1];
				currentStart   = lineNum;
				unitEntryDepth = braceDepth + 1;
			}
		}
	}
	if (currentName) {
		units.push({ name: currentName, type: 'class', range: { startLine: currentStart, startColumn: 1, endLine: lines.length, endColumn: 1 }, rawImports: fileImports });
	}
	if (units.length === 0) {
		return [{ name: baseName, type: 'class', range: { startLine: 1, startColumn: 1, endLine: lines.length, endColumn: 1 }, rawImports: fileImports }];
	}
	return units;
}


// ─── Python ───────────────────────────────────────────────────────────────────

function decomposePython(lines: string[], fileName: string): IDecomposedUnit[] {
	const CLASS_RE   = /^class\s+(\w+)/;
	const FUNC_RE    = /^(?:async\s+)?def\s+(\w+)/;
	const IMPORT_RE1 = /^\s*import\s+([\w.]+)/;
	const IMPORT_RE2 = /^\s*from\s+([\w.]+)\s+import/;
	const baseName   = fileName.replace(/\.[^.]+$/, '');

	const fileImports: string[] = [];
	const units: IDecomposedUnit[] = [];

	for (const line of lines) {
		const m1 = IMPORT_RE1.exec(line);
		const m2 = IMPORT_RE2.exec(line);
		if (m1) { fileImports.push(m1[1]); }
		else if (m2) { fileImports.push(m2[1]); }
	}

	let currentName: string | null = null;
	let currentStart = 1;
	let currentType: MigrationUnitType = 'class';

	const flush = (endLine: number) => {
		if (!currentName) { return; }
		units.push({ name: currentName, type: currentType, range: { startLine: currentStart, startColumn: 1, endLine: endLine, endColumn: 1 }, rawImports: fileImports });
		currentName = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1;
		const line    = lines[i];
		// Top-level declarations have no leading whitespace
		if (/^\S/.test(line)) {
			const cm = CLASS_RE.exec(line);
			if (cm) { flush(lineNum - 1); currentName = cm[1]; currentStart = lineNum; currentType = 'class'; continue; }
			const fm = FUNC_RE.exec(line);
			if (fm) { flush(lineNum - 1); currentName = fm[1]; currentStart = lineNum; currentType = 'function'; continue; }
			// Non-declaration top-level line (e.g. assignment, call) — flush ongoing unit
			if (currentName && !/^(#|'''|"""|@)/.test(line)) { flush(lineNum - 1); }
		}
	}
	flush(lines.length);

	if (units.length === 0) {
		return [{ name: baseName, type: 'module', range: { startLine: 1, startColumn: 1, endLine: lines.length, endColumn: 1 }, rawImports: fileImports }];
	}
	return units;
}


// ─── TypeScript / JavaScript ──────────────────────────────────────────────────

function decomposeTypeScriptJS(lines: string[], fileName: string): IDecomposedUnit[] {
	// Patterns for declarations worth making into units
	const CLASS_RE  = /^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)/;
	const FUNC_RE   = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s+(\w+)/;
	const ARROW_RE  = /^(?:export\s+)?const\s+(\w+)\s*(?::\s*[\w<>[\],\s|&]+)?\s*=\s*(?:async\s+)?\(/;
	const INTERFACE_RE = /^(?:export\s+)?interface\s+(\w+)/;
	const ENUM_RE      = /^(?:export\s+)?(?:const\s+)?enum\s+(\w+)/;
	const IMPORT_FROM_RE = /(?:^|\s)import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/;
	const REQUIRE_RE     = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/;
	const baseName = fileName.replace(/\.[^.]+$/, '');

	const fileImports: string[] = [];
	const units: IDecomposedUnit[] = [];

	for (const line of lines) {
		const fm = IMPORT_FROM_RE.exec(line);
		if (fm) { fileImports.push(fm[1]); }
		const rm = REQUIRE_RE.exec(line);
		if (rm) { fileImports.push(rm[1]); }
	}

	let currentName: string | null = null;
	let currentStart = 1;
	let currentType: MigrationUnitType = 'class';
	let braceDepth = 0;
	let unitEntryDepth = -1;

	const flush = (endLine: number) => {
		if (!currentName) { return; }
		units.push({ name: currentName, type: currentType, range: { startLine: currentStart, startColumn: 1, endLine: endLine, endColumn: 1 }, rawImports: fileImports });
		currentName    = null;
		unitEntryDepth = -1;
	};

	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1;
		const stripped = lines[i]
			.replace(/\/\/.*$/, '')
			.replace(/`[^`]*`/g, '``')
			.replace(/"(?:[^"\\]|\\.)*"/g, '""')
			.replace(/'(?:[^'\\]|\\.)*'/g, "''");

		for (const ch of stripped) {
			if (ch === '{') { braceDepth++; }
			if (ch === '}') {
				braceDepth--;
				if (currentName && braceDepth === unitEntryDepth - 1) {
					flush(lineNum);
				}
			}
		}

		if (braceDepth <= 1) {
			const cm = CLASS_RE.exec(lines[i]);
			if (cm && !currentName) { currentName = cm[1]; currentStart = lineNum; currentType = 'class'; unitEntryDepth = braceDepth + 1; continue; }
			const im = INTERFACE_RE.exec(lines[i]);
			if (im && !currentName) { currentName = im[1]; currentStart = lineNum; currentType = 'class'; unitEntryDepth = braceDepth + 1; continue; }
			const em = ENUM_RE.exec(lines[i]);
			if (em && !currentName) { currentName = em[1]; currentStart = lineNum; currentType = 'class'; unitEntryDepth = braceDepth + 1; continue; }
			const fm = FUNC_RE.exec(lines[i]);
			if (fm && !currentName) { currentName = fm[1]; currentStart = lineNum; currentType = 'function'; unitEntryDepth = braceDepth + 1; continue; }
			const am = ARROW_RE.exec(lines[i]);
			if (am && !currentName) { currentName = am[1]; currentStart = lineNum; currentType = 'function'; unitEntryDepth = braceDepth + 1; continue; }
		}
	}
	flush(lines.length);

	if (units.length === 0) {
		return [{ name: baseName, type: 'module', range: { startLine: 1, startColumn: 1, endLine: lines.length, endColumn: 1 }, rawImports: fileImports }];
	}
	return units;
}


// ─── Go ───────────────────────────────────────────────────────────────────────

function decomposeGo(lines: string[], fileName: string): IDecomposedUnit[] {
	const FUNC_RE   = /^func(?:\s+\([^)]+\))?\s+(\w+)\s*\(/;
	const TYPE_RE   = /^type\s+(\w+)\s+(?:struct|interface)/;
	const IMP1_RE   = /^\s+"([\w./]+)"/;        // inside import block
	const IMP2_RE   = /^import\s+"([\w./]+)"/;  // single-line import
	const baseName  = fileName.replace(/\.[^.]+$/, '');

	const fileImports: string[] = [];
	const units: IDecomposedUnit[] = [];
	let inImportBlock = false;

	for (const line of lines) {
		if (/^import\s+\(/.test(line))                  { inImportBlock = true; continue; }
		if (inImportBlock && /^\)/.test(line.trim()))   { inImportBlock = false; continue; }
		if (inImportBlock) {
			const m = IMP1_RE.exec(line);
			if (m) { fileImports.push(m[1]); }
		} else {
			const m = IMP2_RE.exec(line);
			if (m) { fileImports.push(m[1]); }
		}
	}

	let currentName: string | null = null;
	let currentStart = 1;
	let currentType: MigrationUnitType = 'function';
	let braceDepth = 0;

	const flush = (endLine: number) => {
		if (!currentName) { return; }
		units.push({ name: currentName, type: currentType, range: { startLine: currentStart, startColumn: 1, endLine: endLine, endColumn: 1 }, rawImports: fileImports });
		currentName = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1;
		const stripped = lines[i].replace(/\/\/.*$/, '');
		let prevDepth = braceDepth;
		for (const ch of stripped) {
			if (ch === '{') { braceDepth++; }
			if (ch === '}') { braceDepth--; }
		}
		if (prevDepth > 0 && braceDepth === 0 && currentName) {
			flush(lineNum);
		}
		if (braceDepth === 0) {
			const fm = FUNC_RE.exec(lines[i]);
			if (fm) { flush(lineNum - 1); currentName = fm[1]; currentStart = lineNum; currentType = 'function'; continue; }
			const tm = TYPE_RE.exec(lines[i]);
			if (tm) { flush(lineNum - 1); currentName = tm[1]; currentStart = lineNum; currentType = 'class'; continue; }
		}
	}
	flush(lines.length);

	if (units.length === 0) {
		return [{ name: baseName, type: 'module', range: { startLine: 1, startColumn: 1, endLine: lines.length, endColumn: 1 }, rawImports: fileImports }];
	}
	return units;
}


// ─── Rust ─────────────────────────────────────────────────────────────────────

function decomposeRust(lines: string[], fileName: string): IDecomposedUnit[] {
	const FN_RE    = /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/;
	const TYPE_RE  = /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:struct|enum|trait|type)\s+(\w+)/;
	const IMPL_RE  = /^(?:pub\s+)?impl\s+(?:<[^>]+>\s+)?(?:\w+\s+for\s+)?(\w+)/;
	const USE_RE   = /^\s*use\s+([\w:]+)/;
	const baseName = fileName.replace(/\.[^.]+$/, '');

	const fileImports: string[] = [];
	const units: IDecomposedUnit[] = [];

	for (const line of lines) {
		const u = USE_RE.exec(line);
		if (u) { fileImports.push(u[1]); }
	}

	let currentName: string | null = null;
	let currentStart = 1;
	let currentType: MigrationUnitType = 'function';
	let braceDepth = 0;

	const flush = (endLine: number) => {
		if (!currentName) { return; }
		units.push({ name: currentName, type: currentType, range: { startLine: currentStart, startColumn: 1, endLine: endLine, endColumn: 1 }, rawImports: fileImports });
		currentName = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1;
		const stripped = lines[i].replace(/\/\/.*$/, '');
		const prevDepth = braceDepth;
		for (const ch of stripped) {
			if (ch === '{') { braceDepth++; }
			if (ch === '}') { braceDepth--; }
		}
		if (prevDepth > 0 && braceDepth === 0 && currentName) {
			flush(lineNum);
		}
		if (braceDepth === 0) {
			const fm = FN_RE.exec(lines[i]);
			if (fm) { flush(lineNum - 1); currentName = fm[1]; currentStart = lineNum; currentType = 'function'; continue; }
			const tm = TYPE_RE.exec(lines[i]);
			if (tm) { flush(lineNum - 1); currentName = tm[1]; currentStart = lineNum; currentType = 'class'; continue; }
			const im = IMPL_RE.exec(lines[i]);
			if (im) { flush(lineNum - 1); currentName = `impl_${im[1]}`; currentStart = lineNum; currentType = 'class'; continue; }
		}
	}
	flush(lines.length);

	if (units.length === 0) {
		return [{ name: baseName, type: 'module', range: { startLine: 1, startColumn: 1, endLine: lines.length, endColumn: 1 }, rawImports: fileImports }];
	}
	return units;
}





// ─── AUTOSAR ARXML ───────────────────────────────────────────────────────────
//
// Granularity: SWC (SOFTWARE-COMPONENT-PROTOTYPE), RUNNABLE-ENTITY, PORT-INTERFACE
// We parse the XML textually (no full XML parser) by matching ARXML short-name patterns.

const ARXML_SWC_RE     = /SHORT-NAME>(\w+)<\/SHORT-NAME>/;
const ARXML_RUNNABLE_RE = /<RUNNABLE-ENTITY>[\s\S]*?<SHORT-NAME>(\w+)<\/SHORT-NAME>/g;
const ARXML_PORT_IF_RE  = /<(?:SENDER-RECEIVER|CLIENT-SERVER|NV-DATA)-INTERFACE>[\s\S]*?<SHORT-NAME>(\w+)<\/SHORT-NAME>/g;

function decomposeAutosar(content: string, lines: string[], fileName: string): IDecomposedUnit[] {
	const baseName = fileName.replace(/\.[^.]+$/, '');
	const units: IDecomposedUnit[] = [];

	// Extract top-level SWC short name from filename (ARXML has one SWC per file typically)
	const swcName = baseName;

	// Extract runnable entities
	let m: RegExpExecArray | null;
	ARXML_RUNNABLE_RE.lastIndex = 0;
	while ((m = ARXML_RUNNABLE_RE.exec(content)) !== null) {
		units.push({
			name: `${swcName}$${m[1]}`,
			type: 'function',
			range: { startLine: 1, startColumn: 1, endLine: lines.length, endColumn: 1 },
			rawImports: [],
		});
	}

	// Extract port interfaces (each is a unit for translation/fingerprint purposes)
	ARXML_PORT_IF_RE.lastIndex = 0;
	while ((m = ARXML_PORT_IF_RE.exec(content)) !== null) {
		units.push({
			name: `${swcName}$IF_${m[1]}`,
			type: 'module',
			range: { startLine: 1, startColumn: 1, endLine: lines.length, endColumn: 1 },
			rawImports: [],
		});
	}

	// If no structured units found, extract short-name from first match
	if (units.length === 0) {
		const nm = ARXML_SWC_RE.exec(content);
		const name = nm ? nm[1] : baseName;
		return [{ name, type: 'module', range: { startLine: 1, startColumn: 1, endLine: lines.length, endColumn: 1 }, rawImports: [] }];
	}

	return units;
}


// ─── CAN DBC ─────────────────────────────────────────────────────────────────
//
// Granularity: each BO_ (message) block is one unit; SG_ signals are its children.
// We decompose at message level so each message gets its own fingerprint and translation.

const DBC_MSG_RE = /^BO_\s+(\d+)\s+(\w+)\s*:/;
const DBC_SIG_RE = /^\s+SG_\s+(\w+)\s*:/;

function decomposeCanDbc(lines: string[], fileName: string): IDecomposedUnit[] {
	const baseName = fileName.replace(/\.[^.]+$/, '');
	const units: IDecomposedUnit[] = [];

	let currentName: string | null = null;
	let currentStart = 1;
	const currentSignals: string[] = [];

	const flush = (endLine: number) => {
		if (!currentName) { return; }
		units.push({
			name: currentName,
			type: 'module',
			range: { startLine: currentStart, startColumn: 1, endLine: endLine, endColumn: 1 },
			rawImports: [...currentSignals],
		});
		currentName = null;
		currentSignals.length = 0;
	};

	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1;
		const msgM = DBC_MSG_RE.exec(lines[i]);
		if (msgM) {
			flush(lineNum - 1);
			currentName  = `${baseName}$${msgM[2]}_${msgM[1]}`;
			currentStart = lineNum;
			continue;
		}
		const sigM = DBC_SIG_RE.exec(lines[i]);
		if (sigM && currentName) {
			currentSignals.push(sigM[1]);
		}
		// Blank line or new BO_ ends a message block
		if (/^\s*$/.test(lines[i]) && currentName) {
			flush(lineNum - 1);
		}
	}
	flush(lines.length);

	return units.length > 0 ? units : [fileUnit(fileName, lines.length)];
}


// ─── TTCN-3 ──────────────────────────────────────────────────────────────────
//
// Granularity: testcase, altstep, function declarations within a module.

const TTCN3_TESTCASE_RE = /^\s*testcase\s+(\w+)\s*\(/;
const TTCN3_ALTSTEP_RE  = /^\s*altstep\s+(\w+)\s*\(/;
const TTCN3_FUNCTION_RE = /^\s*function\s+(\w+)\s*\(/;
const TTCN3_MODULE_RE   = /^\s*module\s+(\w+)\s*\{/;

function decomposeTTCN3(lines: string[], fileName: string): IDecomposedUnit[] {
	const baseName = fileName.replace(/\.[^.]+$/, '');
	const units: IDecomposedUnit[] = [];

	let currentName: string | null = null;
	let currentStart = 1;
	let currentType: MigrationUnitType = 'function';
	let braceDepth = 0;

	const flush = (endLine: number) => {
		if (!currentName) { return; }
		units.push({ name: currentName, type: currentType, range: { startLine: currentStart, startColumn: 1, endLine: endLine, endColumn: 1 }, rawImports: [] });
		currentName = null;
	};

	for (let i = 0; i < lines.length; i++) {
		const lineNum = i + 1;
		const stripped = lines[i].replace(/\/\/.*$/, '');

		for (const ch of stripped) {
			if (ch === '{') { braceDepth++; }
			if (ch === '}') {
				braceDepth--;
				if (currentName && braceDepth === 0) { flush(lineNum); }
			}
		}

		if (braceDepth === 0 && !currentName) {
			const tc = TTCN3_TESTCASE_RE.exec(lines[i]);
			if (tc)  { currentName = `${baseName}$${tc[1]}`;  currentStart = lineNum; currentType = 'function'; continue; }
			const as = TTCN3_ALTSTEP_RE.exec(lines[i]);
			if (as)  { currentName = `${baseName}$${as[1]}`;  currentStart = lineNum; currentType = 'function'; continue; }
			const fn = TTCN3_FUNCTION_RE.exec(lines[i]);
			if (fn)  { currentName = `${baseName}$${fn[1]}`;  currentStart = lineNum; currentType = 'function'; continue; }
			const mod = TTCN3_MODULE_RE.exec(lines[i]);
			if (mod) { currentName = `${baseName}$${mod[1]}`; currentStart = lineNum; currentType = 'module'; continue; }
		}
	}
	flush(lines.length);

	return units.length > 0 ? units : [fileUnit(fileName, lines.length)];
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Represent the whole file as a single module-level unit. */
export function fileUnit(fileName: string, lineCount: number): IDecomposedUnit {
	const name = fileName.replace(/\.[^.]+$/, '');
	return {
		name,
		type:       'module',
		range:      { startLine: 1, startColumn: 1, endLine: lineCount, endColumn: 1 },
		rawImports: [],
	};
}
