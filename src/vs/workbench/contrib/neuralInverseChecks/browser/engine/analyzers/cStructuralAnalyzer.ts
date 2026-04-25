/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # C/C++ Structural Analyzer
 *
 * Handles `type: "c-structural"` rules for C, C++, and embedded-C/C++ files.
 *
 * ## Coverage
 *
 * Detects 15 classes of structural, safety, and MISRA/AUTOSAR violations:
 *
 * | detect value               | Description                                                       |
 * |----------------------------|-------------------------------------------------------------------|
 * | goto-usage                 | MISRA C Rule 15.1 — no goto                                      |
 * | recursive-call             | MISRA C Rule 17.2 — no direct recursion                          |
 * | dynamic-memory             | MISRA C Rule 21.3 — no malloc/free in safety code               |
 * | unbounded-recursion        | ISO 26262 — recursion without depth guard                        |
 * | isr-shared-state           | ISR accesses global without volatile + critical section          |
 * | isr-blocking-call          | ISR contains blocking calls                                      |
 * | misra-implicit-type        | MISRA C Rule 8.1 — implicit function declarations                |
 * | misra-no-else              | MISRA C Rule 15.7 — if-else chain without final else             |
 * | misra-switch-default       | MISRA C Rule 16.4 — switch without default                       |
 * | misra-multiple-return      | MISRA C Rule 15.5 — multiple return statements                   |
 * | autosar-layer-violation    | AUTOSAR: illegal cross-layer includes                            |
 * | unsafe-pointer-cast        | Pointer cast without justification comment                       |
 * | stack-overflow-risk        | Large local array or VLA on embedded stack                       |
 * | missing-volatile-shared    | Shared variable accessed in ISR without volatile qualifier       |
 * | missing-error-propagation  | Safety function return code not checked                          |
 *
 * ## False-positive suppression
 *
 * - Comment lines are skipped before pattern matching.
 * - Block comments are blanked (spaces) preserving line numbers.
 * - Deviation comments (`MISRA justified`, `AUTOSAR deviation`) suppress pointer-cast findings.
 * - Language guard: only fires for c / cpp / embedded-c / embedded-cpp or file extensions
 *   .c .cpp .h .hpp .cc .cxx
 */

import { ITextModel } from '../../../../../../editor/common/model.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IGRCRule, ICheckResult } from '../types/grcTypes.js';
import { IRuleAnalyzer } from '../services/grcEngineService.js';
import { INanoAgentContext } from '../../nanoAgents/projectAnalyzerService.js';
import { CHeaderSymbolTable } from './cHeaderSymbolTable.js';


// ─── Local check interface ────────────────────────────────────────────────────

interface ICStructuralCheck {
	type: 'c-structural';
	detect:
	| 'goto-usage'
	| 'recursive-call'
	| 'dynamic-memory'
	| 'unbounded-recursion'
	| 'isr-shared-state'
	| 'isr-blocking-call'
	| 'misra-implicit-type'
	| 'misra-no-else'
	| 'misra-switch-default'
	| 'misra-multiple-return'
	| 'autosar-layer-violation'
	| 'unsafe-pointer-cast'
	| 'stack-overflow-risk'
	| 'missing-volatile-shared'
	| 'missing-error-propagation'
	| 'polling-without-timeout'      // FIRM-001: while(!(REG&FLAG)) with no timeout var
	| 'timeout-without-recovery'     // FIRM-002: timeout countdown loop with no post-loop check
	| 'non-atomic-output-register'   // FIRM-003: ODR/PORT read-modify-write instead of atomic BSRR
	| 'unbounded-string-loop';       // FIRM-004: while(*p != '\0') with no length bound
}

// ─── Function body record ────────────────────────────────────────────────────

interface IFunctionBody {
	name: string;
	start: number; // 0-based line index (inclusive)
	end: number;   // 0-based line index (inclusive)
}

// ─── Global variable record ──────────────────────────────────────────────────

interface IGlobalVar {
	name: string;
	hasVolatile: boolean;
	line: number; // 0-based
}


// ─── C Structural Analyzer ────────────────────────────────────────────────────

export class CStructuralAnalyzer implements IRuleAnalyzer {

	readonly supportedTypes = ['c-structural'];
	readonly supportedLanguages = ['c', 'cpp', 'embedded-c', 'embedded-cpp'];

	// C/C++ file extensions that trigger this analyzer when languageId is generic
	private static readonly C_EXTENSIONS = new Set(['.c', '.cpp', '.h', '.hpp', '.cc', '.cxx']);

	// ── Cross-file header symbol table ────────────────────────────────────
	// Populated by grcEngineService via loadHeaders() before analysis runs.
	private readonly _headerTable = new CHeaderSymbolTable();

	/**
	 * Load parsed header files so that void-returning functions declared in
	 * included headers are known to the missing-error-propagation detector.
	 *
	 * Called by grcEngineService after collecting workspace .h/.hpp files.
	 * Safe to call multiple times — each call merges new headers into the cache.
	 */
	public loadHeaders(headers: Array<{ path: string; content: string }>): void {
		this._headerTable.buildFromWorkspaceFiles(headers);
	}


	// ─── IRuleAnalyzer: evaluate ─────────────────────────────────────────

	public evaluate(
		rule: IGRCRule,
		model: ITextModel,
		fileUri: URI,
		timestamp: number,
		_context?: INanoAgentContext
	): ICheckResult[] {
		const langId = model.getLanguageId();
		if (!this._isCFile(langId, fileUri.path)) return [];
		const lines = model.getLinesContent();
		return this._run(rule, lines, fileUri, timestamp);
	}


	// ─── IRuleAnalyzer: evaluateContent ──────────────────────────────────

	public evaluateContent(
		rule: IGRCRule,
		content: string,
		fileUri: URI,
		languageId: string,
		timestamp: number
	): ICheckResult[] {
		if (!this._isCFile(languageId, fileUri.path)) return [];
		const lines = content.split('\n');
		return this._run(rule, lines, fileUri, timestamp);
	}


	// ─── Core dispatch ────────────────────────────────────────────────────

	private _run(
		rule: IGRCRule,
		rawLines: string[],
		fileUri: URI,
		timestamp: number
	): ICheckResult[] {
		const check = rule.check as ICStructuralCheck | undefined;
		if (!check || check.type !== 'c-structural') return [];

		// Strip block comments, preserve line count
		const lines = this._stripComments(rawLines);

		switch (check.detect) {
			case 'goto-usage':               return this._checkGotoUsage(rule, lines, fileUri, timestamp);
			case 'recursive-call':           return this._checkRecursiveCall(rule, lines, fileUri, timestamp);
			case 'dynamic-memory':           return this._checkDynamicMemory(rule, lines, fileUri, timestamp);
			case 'unbounded-recursion':      return this._checkUnboundedRecursion(rule, lines, fileUri, timestamp);
			case 'isr-shared-state':         return this._checkIsrSharedState(rule, lines, fileUri, timestamp);
			case 'isr-blocking-call':        return this._checkIsrBlockingCall(rule, lines, fileUri, timestamp);
			case 'misra-implicit-type':      return this._checkMisraImplicitType(rule, lines, fileUri, timestamp);
			case 'misra-no-else':            return this._checkMisraNoElse(rule, lines, fileUri, timestamp);
			case 'misra-switch-default':     return this._checkMisraSwitchDefault(rule, lines, fileUri, timestamp);
			case 'misra-multiple-return':    return this._checkMisraMultipleReturn(rule, lines, fileUri, timestamp);
			case 'autosar-layer-violation':  return this._checkAutosarLayerViolation(rule, rawLines, fileUri, timestamp);
			case 'unsafe-pointer-cast':      return this._checkUnsafePointerCast(rule, rawLines, fileUri, timestamp);
			case 'stack-overflow-risk':      return this._checkStackOverflowRisk(rule, lines, fileUri, timestamp);
			case 'missing-volatile-shared':   return this._checkMissingVolatileShared(rule, rawLines, fileUri, timestamp);
			case 'missing-error-propagation':  return this._checkMissingErrorPropagation(rule, lines, fileUri, timestamp);
			case 'polling-without-timeout':    return this._checkPollingWithoutTimeout(rule, lines, fileUri, timestamp);
			case 'timeout-without-recovery':   return this._checkTimeoutWithoutRecovery(rule, lines, fileUri, timestamp);
			case 'non-atomic-output-register': return this._checkNonAtomicOutputRegister(rule, lines, fileUri, timestamp, this._headerTable.getRmwMacros());
			case 'unbounded-string-loop':      return this._checkUnboundedStringLoop(rule, lines, fileUri, timestamp);
			default:                           return [];
		}
	}


	// ─── Core helpers ─────────────────────────────────────────────────────

	// Strip block comments (slash-star ... star-slash) and line comments (//)
	// while preserving line count by replacing comment text with spaces.
	private _stripComments(lines: string[]): string[] {
		const content = lines.join('\n');
		// Remove block comments, preserving newlines
		let stripped = content.replace(/\/\*[\s\S]*?\*\//g, (match) =>
			match.replace(/[^\n]/g, ' ')
		);
		// Remove line comments (// …)
		stripped = stripped.replace(/\/\/[^\n]*/g, (match) =>
			' '.repeat(match.length)
		);
		return stripped.split('\n');
	}

	/**
	 * Scan lines for C/C++ function definitions and return their name + line range.
	 * Uses brace-depth tracking to find the closing `}`.
	 * Supports: `type name(params) {` and `type name(params)\n{`
	 */
	private _findFunctionBodies(lines: string[]): IFunctionBody[] {
		const bodies: IFunctionBody[] = [];
		// Match function definition header: optional return-type tokens then name(
		// The pattern is intentionally liberal — it just needs to capture the name.
		const FUNC_DEF_RE = /^[\w\s\*]+?\b(\w+)\s*\([^;]*\)\s*\{?\s*$/;
		// Exclude preprocessor, struct/union/enum, control-flow keywords, typedef
		const EXCLUDED_KEYWORDS = new Set([
			'if', 'else', 'for', 'while', 'do', 'switch', 'return', 'goto',
			'sizeof', 'typedef', 'struct', 'union', 'enum', 'class', 'namespace',
		]);

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
			if (!trimmed) continue;

			const m = FUNC_DEF_RE.exec(trimmed);
			if (!m) continue;
			const funcName = m[1];
			if (EXCLUDED_KEYWORDS.has(funcName)) continue;
			// Must not be inside another function's body (rough guard: previous line not deeper in braces)
			// We rely on the brace-tracking approach below for accurate body identification.

			// Find the opening brace (may be on the same line or the next)
			let braceStart = -1;
			let braceDepth = 0;
			if (trimmed.endsWith('{')) {
				braceStart = i;
				braceDepth = 1;
			} else {
				// Look ahead up to 3 lines for the opening brace
				for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
					const nextTrimmed = lines[j].trim();
					if (nextTrimmed.startsWith('{')) {
						braceStart = j;
						braceDepth = 1;
						break;
					}
					// Something else appeared — not a function def
					if (nextTrimmed && !nextTrimmed.startsWith('/')) break;
				}
			}
			if (braceStart === -1) continue;

			// Count brace depth from braceStart forward to find the closing brace
			// (reset depth to account for characters on the opening line)
			braceDepth = 0;
			let end = braceStart;
			for (let j = braceStart; j < lines.length; j++) {
				for (const ch of lines[j]) {
					if (ch === '{') braceDepth++;
					else if (ch === '}') braceDepth--;
				}
				if (braceDepth <= 0 && j >= braceStart) {
					end = j;
					break;
				}
				// Safety: bail out after 1000 lines for a single function
				if (j - braceStart > 1000) {
					end = Math.min(braceStart + 1000, lines.length - 1);
					break;
				}
			}

			bodies.push({ name: funcName, start: i, end });
		}

		return bodies;
	}

	/**
	 * Return true if the function name suggests it is an ISR.
	 */
	private _isInISR(funcName: string): boolean {
		if (!funcName) return false;
		return (
			funcName.endsWith('_IRQHandler') ||
			funcName.endsWith('_Handler') ||
			funcName.includes('ISR_') ||
			funcName.includes('_isr') ||
			funcName.toLowerCase().startsWith('isr_') ||
			funcName.startsWith('IRQ_') ||
			/^__interrupt/.test(funcName) ||
			funcName.startsWith('EXTI') ||
			funcName.startsWith('TIM') && funcName.endsWith('Handler') ||
			funcName.startsWith('DMA') && funcName.endsWith('Handler') ||
			funcName.startsWith('USART') && funcName.endsWith('Handler') ||
			funcName.startsWith('SPI') && funcName.endsWith('Handler') ||
			funcName.startsWith('I2C') && funcName.endsWith('Handler')
		);
	}

	/** Collect file-scope (non-indented) global variable declarations. */
	private _findGlobalVars(rawLines: string[]): IGlobalVar[] {
		const globals: IGlobalVar[] = [];
		// Match file-scope variable declarations: optionally static/extern/volatile, then type, then name
		// Must start at column 0 (no leading whitespace)
		const GLOBAL_VAR_RE = /^(?:(?:static|extern)\s+)?(?:(volatile)\s+)?(?:\w+\s+)+(\w+)\s*(?:=\s*[^;]+)?;/;
		const EXCLUDED = new Set(['return', 'if', 'else', 'for', 'while', 'do', 'switch', 'typedef', 'struct', 'union', 'enum', 'class']);

		for (let i = 0; i < rawLines.length; i++) {
			const line = rawLines[i];
			// Must start at column 0
			if (line.length === 0 || (line[0] === ' ' || line[0] === '\t')) continue;
			const trimmed = line.trim();
			if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
			const m = GLOBAL_VAR_RE.exec(trimmed);
			if (!m) continue;
			const varName = m[2];
			if (!varName || EXCLUDED.has(varName)) continue;

			// Skip linker-script exported symbols. These are extern uint32_t declarations
			// whose names start with '_' (e.g. _sidata, _sdata, _edata, _sbss, _ebss,
			// _estack, __bss_start__, __data_start). They are linker-resolved addresses
			// used once in Reset_Handler for memory initialisation — never ISR-shared
			// runtime state — so volatile is both unnecessary and misleading here.
			if (varName.startsWith('_') || varName.startsWith('__')) continue;

			globals.push({
				name: varName,
				hasVolatile: !!m[1],
				line: i,
			});
		}
		return globals;
	}


	// ─── Detector: goto-usage ─────────────────────────────────────────────

	private _checkGotoUsage(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const GOTO_RE = /\bgoto\s+\w+/;

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || this._isCommentOnly(trimmed)) continue;
			if (GOTO_RE.test(trimmed)) {
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`MISRA C Rule 15.1: goto statement violates structured programming — remove goto and restructure with loops or flags`
				));
			}
		}
		return results;
	}


	// ─── Detector: recursive-call ─────────────────────────────────────────

	private _checkRecursiveCall(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const bodies = this._findFunctionBodies(lines);

		for (const body of bodies) {
			// Pattern: funcName( as a call site within the function body
			const callRe = new RegExp(`\\b${this._escapeRegex(body.name)}\\s*\\(`);
			for (let i = body.start + 1; i <= body.end; i++) {
				const trimmed = lines[i]?.trim() ?? '';
				if (!trimmed || this._isCommentOnly(trimmed)) continue;
				if (callRe.test(trimmed)) {
					results.push(this._makeResult(
						rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
						`MISRA C Rule 17.2: Recursive call to '${body.name}' — recursion is prohibited in safety code`
					));
					break; // One finding per function is sufficient
				}
			}
		}
		return results;
	}


	// ─── Detector: dynamic-memory ─────────────────────────────────────────

	private _checkDynamicMemory(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const DYN_MEM_RE = /\b(malloc|calloc|realloc|free|alloca)\s*\(|\bnew\s+|\bdelete(\[\])?\s+|\boperator\s+new\b/;

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || this._isCommentOnly(trimmed)) continue;
			const m = DYN_MEM_RE.exec(trimmed);
			if (m) {
				const call = m[1] ?? (m[0].trim().split(/\s+/)[0]);
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`MISRA C Rule 21.3: Dynamic memory allocation ('${call}') prohibited in safety-critical code — use static allocation`
				));
			}
		}
		return results;
	}


	// ─── Detector: unbounded-recursion ────────────────────────────────────

	private _checkUnboundedRecursion(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const bodies = this._findFunctionBodies(lines);
		// Depth-guard identifiers that indicate bounded recursion
		const DEPTH_GUARD_RE = /\b(depth|level|count|limit|max_depth|MAX_DEPTH|recursion_level|iter)\b/i;

		for (const body of bodies) {
			const callRe = new RegExp(`\\b${this._escapeRegex(body.name)}\\s*\\(`);
			let hasRecursion = false;
			let hasDepthGuard = false;
			let recursionLine = -1;

			for (let i = body.start + 1; i <= body.end; i++) {
				const trimmed = lines[i]?.trim() ?? '';
				if (!trimmed || this._isCommentOnly(trimmed)) continue;
				if (callRe.test(trimmed)) {
					hasRecursion = true;
					if (recursionLine === -1) recursionLine = i;
					// Check the condition controlling this recursive call
					// Look back up to 5 lines for an enclosing if/while with a depth guard
					for (let k = Math.max(body.start, i - 5); k <= i; k++) {
						if (DEPTH_GUARD_RE.test(lines[k] ?? '')) {
							hasDepthGuard = true;
							break;
						}
					}
				}
			}

			if (hasRecursion && !hasDepthGuard && recursionLine >= 0) {
				const snippet = lines[recursionLine]?.trim() ?? '';
				results.push(this._makeResult(
					rule, fileUri, recursionLine + 1, 1, recursionLine + 1, snippet.length + 1, snippet, timestamp,
					`ISO 26262: Unbounded recursion in '${body.name}' — no depth limit guard found (depth/level/count/limit). Add a maximum recursion depth check`
				));
			}
		}
		return results;
	}


	// ─── Detector: isr-shared-state ───────────────────────────────────────

	private _checkIsrSharedState(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const globals = this._findGlobalVars(lines);
		const nonVolatileGlobals = globals.filter(g => !g.hasVolatile).map(g => g.name);
		if (nonVolatileGlobals.length === 0) return results;

		const bodies = this._findFunctionBodies(lines);
		const isrBodies = bodies.filter(b => this._isInISR(b.name));

		// Critical section indicators
		const CRITICAL_SECTION_RE = /(__disable_irq|taskENTER_CRITICAL|portDISABLE_INTERRUPTS|cli\s*\(\s*\)|noInterrupts\s*\(\s*\)|NVIC_DisableIRQ|__set_PRIMASK|DISABLE_INTERRUPTS)/;

		for (const isr of isrBodies) {
			// Check if this ISR has a critical section wrapping its accesses
			const isrContent = lines.slice(isr.start, isr.end + 1).join('\n');
			const hasCriticalSection = CRITICAL_SECTION_RE.test(isrContent);
			if (hasCriticalSection) continue;

			for (let i = isr.start + 1; i <= isr.end; i++) {
				const trimmed = lines[i]?.trim() ?? '';
				if (!trimmed || this._isCommentOnly(trimmed)) continue;

				for (const varName of nonVolatileGlobals) {
					// Detect write access (assignment or increment) to global from ISR
					const writeRe = new RegExp(`\\b${this._escapeRegex(varName)}\\s*(=|\\+\\+|--|\\+=|-=|\\*=|/=)`);
					if (writeRe.test(trimmed)) {
						results.push(this._makeResult(
							rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
							`ISR '${isr.name}' accesses shared variable '${varName}' without volatile qualifier or critical section — data race between ISR and main loop`
						));
						break; // One finding per variable per ISR line
					}
				}
			}
		}
		return results;
	}


	// ─── Detector: isr-blocking-call ──────────────────────────────────────

	private _checkIsrBlockingCall(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const bodies = this._findFunctionBodies(lines);
		const isrBodies = bodies.filter(b => this._isInISR(b.name));

		const BLOCKING_CALLS = [
			'printf', 'fprintf', 'sprintf', 'snprintf', 'puts', 'putchar',
			'sleep', 'usleep', 'delay', 'HAL_Delay', 'vTaskDelay', 'osDelay',
			'osMutexAcquire', 'pthread_mutex_lock', 'xSemaphoreTake',
			'UART_Transmit', 'HAL_UART_Transmit', 'HAL_SPI_Transmit',
			'fopen', 'fclose', 'fread', 'fwrite',
			'malloc', 'calloc', 'realloc', 'free',
			'recv', 'send', 'recvfrom', 'sendto',
			'read', 'write',
		];
		const BLOCKING_RE = new RegExp(
			`\\b(${BLOCKING_CALLS.map(c => this._escapeRegex(c)).join('|')})\\s*\\(`
		);

		for (const isr of isrBodies) {
			for (let i = isr.start + 1; i <= isr.end; i++) {
				const trimmed = lines[i]?.trim() ?? '';
				if (!trimmed || this._isCommentOnly(trimmed)) continue;
				const m = BLOCKING_RE.exec(trimmed);
				if (m) {
					results.push(this._makeResult(
						rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
						`Blocking call '${m[1]}' inside ISR '${isr.name}' — causes interrupt latency and deadlock risk. Move to a task or use deferred processing`
					));
				}
			}
		}
		return results;
	}


	// ─── Detector: misra-implicit-type ────────────────────────────────────

	private _checkMisraImplicitType(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		// Detect function definitions that start with an identifier (not a known type keyword)
		// without an explicit return type — classic C89 implicit-int pattern
		const EXPLICIT_TYPES = /^(void|int|char|short|long|float|double|unsigned|signed|bool|uint8_t|uint16_t|uint32_t|uint64_t|int8_t|int16_t|int32_t|int64_t|size_t|ptrdiff_t|intptr_t|uintptr_t|auto|static|extern|const|inline|register|volatile|struct|union|enum|class|typedef|__interrupt)\b/;
		// Implicit int function: starts with identifier, has params, then { on this or next line
		const IMPLICIT_INT_RE = /^([a-z_]\w*)\s*\([^;{}]*\)\s*\{?\s*$/;
		const CTRL_FLOW = new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'return', 'goto', 'case', 'break', 'continue', 'default']);

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || this._isCommentOnly(trimmed)) continue;
			if (trimmed.startsWith('#')) continue;

			const m = IMPLICIT_INT_RE.exec(trimmed);
			if (!m) continue;
			const name = m[1];
			if (CTRL_FLOW.has(name)) continue;
			if (EXPLICIT_TYPES.test(trimmed)) continue;

			// Confirm there is an opening brace on this or next non-empty line
			let hasBrace = trimmed.includes('{');
			if (!hasBrace) {
				for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
					const nt = lines[j].trim();
					if (nt.startsWith('{')) { hasBrace = true; break; }
					if (nt && !nt.startsWith('//')) break;
				}
			}
			if (!hasBrace) continue;

			results.push(this._makeResult(
				rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
				`MISRA C Rule 8.1: Implicit function declaration for '${name}' — all functions must have an explicit return type`
			));
		}
		return results;
	}


	// ─── Detector: misra-no-else ──────────────────────────────────────────

	private _checkMisraNoElse(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		// Find 'else if' chains and verify they close with a plain 'else'
		// Strategy: scan forward from each 'else if' to see if the chain ends with 'else {'
		const ELSE_IF_RE = /\}\s*else\s+if\s*\(/;
		const PLAIN_ELSE_RE = /\}\s*else\s*\{/;
		const ANY_ELSE_IF_RE = /\belse\s+if\b/;

		const visited = new Set<number>();

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || this._isCommentOnly(trimmed)) continue;
			// Find lines that contain 'else if' — start of a chain segment
			if (!ANY_ELSE_IF_RE.test(trimmed)) continue;
			if (visited.has(i)) continue;

			// Scan forward from this 'else if' to find where the chain ends
			let hasPlainElse = false;
			let depth = 0;

			// Count braces on the 'else if' line
			for (const ch of trimmed) {
				if (ch === '{') depth++;
				else if (ch === '}') depth--;
			}

			for (let j = i + 1; j < Math.min(lines.length, i + 200); j++) {
				const jt = lines[j].trim();
				if (!jt) continue;
				visited.add(j);

				for (const ch of jt) {
					if (ch === '{') depth++;
					else if (ch === '}') depth--;
				}

				if (ANY_ELSE_IF_RE.test(jt)) {
					continue;
				}

				if (PLAIN_ELSE_RE.test(jt) || /^\s*else\s*$/.test(jt)) {
					hasPlainElse = true;
					break;
				}

				// Chain ended: we've left the if-else block
				if (!ANY_ELSE_IF_RE.test(jt) && !ELSE_IF_RE.test(jt)) {
					// If depth returned to 0 or went negative — chain is over
					if (depth <= 0) {
						break;
					}
				}
			}

			if (!hasPlainElse) {
				// Flag the first 'else if' line
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`MISRA C Rule 15.7: if-else chain must end with a final else clause — add a terminating 'else { }' branch`
				));
			}
		}
		return results;
	}


	// ─── Detector: misra-switch-default ───────────────────────────────────

	private _checkMisraSwitchDefault(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const SWITCH_RE = /\bswitch\s*\(/;
		const DEFAULT_RE = /\bdefault\s*:/;

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || this._isCommentOnly(trimmed)) continue;
			if (!SWITCH_RE.test(trimmed)) continue;

			// Find the switch body
			let braceDepth = 0;
			let bodyStart = i;
			let hasDefault = false;

			// Find the opening brace
			for (let j = i; j < Math.min(lines.length, i + 5); j++) {
				if (lines[j].includes('{')) { bodyStart = j; break; }
			}

			for (let j = bodyStart; j < Math.min(lines.length, i + 300); j++) {
				const jLine = lines[j];
				for (const ch of jLine) {
					if (ch === '{') braceDepth++;
					else if (ch === '}') braceDepth--;
				}
				if (DEFAULT_RE.test(jLine)) hasDefault = true;
				if (braceDepth === 0 && j > bodyStart) break;
			}

			if (!hasDefault) {
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`MISRA C Rule 16.4: switch statement missing default clause — add a default: branch to handle unexpected values`
				));
			}
		}
		return results;
	}


	// ─── Detector: misra-multiple-return ──────────────────────────────────

	private _checkMisraMultipleReturn(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const bodies = this._findFunctionBodies(lines);
		const RETURN_RE = /\breturn\b/;

		for (const body of bodies) {
			const bodyLineCount = body.end - body.start;
			if (bodyLineCount < 5) continue; // Skip trivial functions

			const returnLines: number[] = [];
			for (let i = body.start + 1; i <= body.end; i++) {
				const trimmed = lines[i]?.trim() ?? '';
				if (!trimmed || this._isCommentOnly(trimmed)) continue;
				if (RETURN_RE.test(trimmed)) returnLines.push(i);
			}

			if (returnLines.length > 1) {
				// Flag every return after the first one
				for (let k = 1; k < returnLines.length; k++) {
					const lineIdx = returnLines[k];
					const snippet = lines[lineIdx]?.trim() ?? '';
					results.push(this._makeResult(
						rule, fileUri, lineIdx + 1, 1, lineIdx + 1, snippet.length + 1, snippet, timestamp,
						`MISRA C Rule 15.5: Function '${body.name}' has multiple return points — refactor to a single return at the end`
					));
				}
			}
		}
		return results;
	}


	// ─── Detector: autosar-layer-violation ────────────────────────────────

	// Use rawLines (with comments) for include-directive analysis
	private _checkAutosarLayerViolation(
		rule: IGRCRule, rawLines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const filePath = fileUri.path.toLowerCase();

		// Determine which AUTOSAR layer this file belongs to
		const isBspOrMcal = /\/(bsp|mcal|hal|drivers?)\//i.test(filePath);
		const isApplication = /\/(application|app|applayer)\//i.test(filePath);

		if (!isBspOrMcal && !isApplication) return results; // Not in a recognised AUTOSAR layer

		const INCLUDE_RE = /^#\s*include\s+["<]([^">]+)[">]/;

		for (let i = 0; i < rawLines.length; i++) {
			const trimmed = rawLines[i].trim();
			if (!INCLUDE_RE.test(trimmed)) continue;
			const m = INCLUDE_RE.exec(trimmed);
			if (!m) continue;
			const includePath = m[1].toLowerCase();

			if (isBspOrMcal) {
				// BSP/MCAL should NOT include Application or Services headers directly
				const illegalTargets = ['application/', 'app/', 'applayer/', 'services/', 'swc/'];
				const target = illegalTargets.find(t => includePath.includes(t));
				if (target) {
					const layer = filePath.includes('/mcal/') ? 'MCAL' : filePath.includes('/hal/') ? 'HAL' : 'BSP';
					results.push(this._makeResult(
						rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
						`AUTOSAR: Cross-layer include from '${layer}' \u2192 '${target.replace('/', '')}' violates layered architecture — BSP/MCAL must not depend on application layers`
					));
				}
			} else if (isApplication) {
				// Application should NOT include MCAL or BSP headers directly (should go through RTE)
				const illegalTargets = ['mcal/', 'bsp/', 'drivers/', 'hal/'];
				const target = illegalTargets.find(t => includePath.includes(t));
				if (target) {
					results.push(this._makeResult(
						rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
						`AUTOSAR: Cross-layer include from 'Application' \u2192 '${target.replace('/', '')}' violates layered architecture — application code must access hardware only through the RTE`
					));
				}
			}
		}
		return results;
	}


	// ─── Detector: unsafe-pointer-cast ────────────────────────────────────

	// Use rawLines so we can check for deviation comments on the same line
	private _checkUnsafePointerCast(
		rule: IGRCRule, rawLines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		// C-style pointer casts to typed integer pointers (strict-aliasing risk)
		const C_PTR_CAST_RE = /\(\s*(uint8_t|uint16_t|uint32_t|uint64_t|int8_t|int16_t|int32_t|char|unsigned char|signed char)\s*\*\s*\)/;
		// void* cast — only flag when NOT used as a null-pointer constant.
		const VOID_PTR_CAST_RE = /\(\s*void\s*\*\s*\)/;
		const NULL_PTR_IDIOM_RE = /\(\s*void\s*\*\s*\)\s*(?:0|NULL)\b/;
		// C++ reinterpret_cast — always flag
		const REINTERPRET_RE = /\breinterpret_cast\s*</;
		// Deviation / justification comment on same line
		const DEVIATION_RE = /MISRA\s+justified|AUTOSAR\s+deviation|deviation\s+justified|MISRA_DEVIATION|Safety_Justified/i;
		// memcpy/memset/memmove with a cast is the MISRA-compliant type-punning pattern — suppress
		const MEMCPY_TYPE_PUN_RE = /\b(?:memcpy|memset|memmove)\s*\(/;

		// Strip block comments first so doxygen /** @param (uint8_t *) */ lines are not flagged
		const strippedLines = this._stripComments(rawLines);

		for (let i = 0; i < rawLines.length; i++) {
			const line = rawLines[i];
			const trimmed = strippedLines[i].trim();
			if (!trimmed || this._isCommentOnly(trimmed)) continue;
			// Skip if there is an explicit justification comment on this line
			if (DEVIATION_RE.test(line)) continue;
			// memcpy with a cast = compliant type-punning, not a violation
			if (MEMCPY_TYPE_PUN_RE.test(trimmed)) continue;

			if (C_PTR_CAST_RE.test(trimmed)) {
				const m = C_PTR_CAST_RE.exec(trimmed)!;
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`Unsafe pointer cast to '${m[1]}*' — may violate strict aliasing rules (MISRA C Rule 11.3). Add /* MISRA justified: <rationale> */ if intentional`
				));
			} else if (VOID_PTR_CAST_RE.test(trimmed) && !NULL_PTR_IDIOM_RE.test(trimmed)) {
				// (void *)0 / (void *)NULL is the MISRA C:2012 Rule 11.9 null pointer
				// constant — do NOT flag it. Only flag genuine void* casts elsewhere.
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`Unsafe void* pointer cast — loss of type information; use proper typed pointers or document justification (MISRA C Rule 11.5)`
				));
			} else if (REINTERPRET_RE.test(trimmed)) {
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`reinterpret_cast detected — violates AUTOSAR C++ Rule A5-2-4: do not use reinterpret_cast in safety-critical code`
				));
			}
		}
		return results;
	}


	// ─── Detector: stack-overflow-risk ────────────────────────────────────

	private _checkStackOverflowRisk(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		// Large fixed-size local array: type name[SIZE] where SIZE > 1024
		const FIXED_ARRAY_RE = /\b(?:char|uint8_t|uint16_t|uint32_t|uint64_t|int8_t|int16_t|int32_t|int|short|long|float|double)\s+\w+\s*\[\s*(\d+)\s*\]/;
		// Variable-length array: type name[expr] where expr is not a numeric literal
		const VLA_RE = /\b(?:char|uint8_t|uint16_t|uint32_t|int|short|long)\s+\w+\s*\[(?!\s*\d+\s*\])([^\]]+)\]/;
		// Must be inside a function body (preceded by some indentation)
		const INSIDE_FUNC_RE = /^(\s+)/; // Has leading whitespace

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();
			if (!trimmed || this._isCommentOnly(trimmed)) continue;
			// Only flag local variables (indented), not file-scope declarations
			if (!INSIDE_FUNC_RE.test(line)) continue;

			const fixedMatch = FIXED_ARRAY_RE.exec(trimmed);
			if (fixedMatch) {
				const size = parseInt(fixedMatch[1], 10);
				if (size > 1024) {
					results.push(this._makeResult(
						rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
						`Large stack allocation (${size} bytes) risks stack overflow in embedded context — use static or heap allocation with explicit size limits`
					));
					continue;
				}
			}

			// VLA detection
			if (VLA_RE.test(trimmed) && !trimmed.includes('sizeof')) {
				const vlaMatch = VLA_RE.exec(trimmed)!;
				const sizeExpr = vlaMatch[1].trim();
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`Variable-length array with dynamic size '${sizeExpr}' — VLAs prohibited in safety-critical code (MISRA C Rule 18.8). Use fixed-size static buffers`
				));
			}
		}
		return results;
	}


	// ─── Detector: missing-volatile-shared ────────────────────────────────

	// Use rawLines to check original volatile declarations
	private _checkMissingVolatileShared(
		rule: IGRCRule, rawLines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const globals = this._findGlobalVars(rawLines);
		const nonVolatileGlobals = globals.filter(g => !g.hasVolatile);
		if (nonVolatileGlobals.length === 0) return results;

		// Strip comments for body analysis
		const lines = this._stripComments(rawLines);
		const bodies = this._findFunctionBodies(lines);
		const isrBodies = bodies.filter(b => this._isInISR(b.name));
		if (isrBodies.length === 0) return results;

		const reportedVars = new Set<string>();

		for (const isr of isrBodies) {
			for (let i = isr.start + 1; i <= isr.end; i++) {
				const trimmed = lines[i]?.trim() ?? '';
				if (!trimmed || this._isCommentOnly(trimmed)) continue;

				for (const g of nonVolatileGlobals) {
					if (reportedVars.has(g.name)) continue;
					const accessRe = new RegExp(`\\b${this._escapeRegex(g.name)}\\b`);
					if (accessRe.test(trimmed)) {
						reportedVars.add(g.name);
						// Report on the declaration line
						const declLine = rawLines[g.line]?.trim() ?? '';
						results.push(this._makeResult(
							rule, fileUri, g.line + 1, 1, g.line + 1, declLine.length + 1, declLine, timestamp,
							`Shared variable '${g.name}' lacks volatile qualifier — accessed in ISR '${isr.name}' without volatile, risking compiler optimisation stripping reads/writes`
						));
					}
				}
			}
		}
		return results;
	}


	// ─── Detector: missing-error-propagation ──────────────────────────────

	private _checkMissingErrorPropagation(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Safety-relevant function name patterns (case-sensitive prefixes/substrings)
		const SAFETY_FUNC_RE = /\b(\w*(?:init|Init|enable|Enable|configure|Configure|HAL_|hal_|safety_|Safety_|check_|validate|verify|Verify|SPI_|I2C_|UART_|CAN_|GPIO_|RCC_|DMA_|ADC_|TIM_|FLASH_|PWR_|RTC_|USB_)[A-Za-z_]\w*)\s*\(/;
		// Patterns indicating the return value IS used
		const USED_RE = /(?:=|\bif\s*\(|\bwhile\s*\(|\breturn\b|&&|\|\||\?|result|status|err|ret\s*[=!])/;

		// ── Pass 1: collect void-returning function names from this file ──────
		// A function whose return type is void CAN NEVER have a "missing return
		// value check" — the concept doesn't apply. We scan declarations and
		// definitions in this file, then skip any call to a void function.
		//
		// Patterns matched:
		//   void GPIO_Init(...)            — definition or prototype in same file
		//   static void foo(...)           — static definition
		//   extern void bar(...)           — external prototype
		//   void Foo_Handler(void) __attribute__((weak, alias(...))); — weak alias
		//
		// We also collect IRQ/Handler names because they always return void.
		const VOID_DECL_RE = /^(?:static\s+|extern\s+|inline\s+)*void\s+(\w+)\s*\(/;
		const voidFunctions = new Set<string>();
		for (const line of lines) {
			const t = line.trim();
			if (!t || this._isCommentOnly(t) || t.startsWith('#')) continue;
			const vm = VOID_DECL_RE.exec(t);
			if (vm) voidFunctions.add(vm[1]);
		}

		// ── Extend with cross-file void functions from parsed headers ─────────
		// The header symbol table is populated by loadHeaders() which is called
		// by grcEngineService after collecting workspace .h/.hpp files.
		for (const name of this._headerTable.getAllVoidFunctions()) {
			voidFunctions.add(name);
		}

		// ── Pass 2: line-by-line call-site analysis ────────────────────────────
		// Any line that is:
		//   (a) a function declaration or definition header \u2192 skip
		//   (b) a call to a void function \u2192 skip (can't check void return)
		//   (c) a call to a safety-named function used as a bare statement \u2192 flag

		// Full function declaration/definition line (with or without __attribute__)
		// Matches:  void Foo(...)  /  static int Bar(...)  /  uint32_t Baz(...) {
		const FUNC_DECL_LINE_RE = /^(?:(?:static|extern|inline|const|volatile)\s+)*(?:void|int|uint\w*|int\w*|bool|char|float|double|size_t)\s+\w+\s*\(/;

		// __attribute__((weak, alias(...))); lines are always declarations, never calls
		const WEAK_ALIAS_RE = /__attribute__\s*\(\s*\(\s*(?:weak|alias)/;

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed || this._isCommentOnly(trimmed)) continue;
			if (trimmed.startsWith('#')) continue;

			// Skip any function declaration or definition header
			if (FUNC_DECL_LINE_RE.test(trimmed)) continue;
			// Skip weak alias attribute lines (IRQ stubs in startup code)
			if (WEAK_ALIAS_RE.test(trimmed)) continue;

			const m = SAFETY_FUNC_RE.exec(trimmed);
			if (!m) continue;
			const funcName = m[1];

			// Skip calls to void functions — you cannot check the return of void
			if (voidFunctions.has(funcName)) continue;
			// Skip if the function name itself looks like a handler (always void)
			if (/(?:_IRQHandler|_Handler|_ISR)$/.test(funcName)) continue;

			// Flag bare call (return value discarded) only if function could return a value
			const isBareCall = /^[\w_]*\s*\([^;]*\)\s*;$/.test(trimmed) || trimmed.endsWith(');');
			if (isBareCall && !USED_RE.test(trimmed)) {
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`Return value of safety function '${funcName}' not checked — missing error propagation. Assign to a status variable or guard with if(...) per ISO 26262 functional safety`
				));
			}
		}
		return results;
	}


	// ─── Detector: polling-without-timeout ────────────────────────────────
	//
	// A polling loop is: while (!(expr)) or while ((expr) == 0)
	// with no timeout variable visible in the enclosing function scope.
	//
	// Works for any MCU, any register name — detection is fully structural.
	// The look-behind is bounded to the current function body so that a
	// timeout variable in an earlier function does not suppress a finding
	// in a later one (the original bug that caused missed findings).
	private _checkPollingWithoutTimeout(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Canonical polling loop forms:
		//   while (!(REG & FLAG))
		//   while ((REG & FLAG) == 0U)
		//   while ((REG & FLAG) == 0)
		const POLL_LOOP_RE = /^\s*while\s*\(\s*(?:!\s*\(|(?:\(.*\))\s*==\s*0U?\s*(?:\))?)/;

		// A timeout guard is any of:
		//   - decrement in the condition: while (... && counter--)
		//   - a variable named *timeout/retry/count/tick/deadline/limit/attempt*
		//   - any var-- or --var pattern (countdown)
		const TIMEOUT_COND_RE = /&&[^)]*(?:--|>\s*0)|(?:--|>\s*0)[^)]*&&/;
		const TIMEOUT_VAR_RE  = /\b\w*(?:timeout|retry|retries|count|tick|deadline|limit|guard|attempt)\w*\b/i;
		const DECREMENT_RE    = /\b\w+--\s*[;)>]|--\s*\w+/;

		// Find enclosing function body boundaries for the line at index i.
		// Returns [bodyStart, bodyEnd] (0-based), or [-1, -1] if not inside a function.
		const findEnclosingBody = (lineIdx: number): [number, number] => {
			const bodies = this._findFunctionBodies(lines);
			for (const b of bodies) {
				if (lineIdx >= b.start && lineIdx <= b.end) return [b.start, b.end];
			}
			return [-1, -1];
		};

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!POLL_LOOP_RE.test(trimmed)) continue;
			if (this._isCommentOnly(trimmed)) continue;

			// Timeout in the while condition itself?
			if (TIMEOUT_COND_RE.test(trimmed) || TIMEOUT_VAR_RE.test(trimmed)) continue;

			// Find the function body that contains this loop
			const [bodyStart, bodyEnd] = findEnclosingBody(i);

			// Scan window: from function body start (or 10 lines back) to loop + 8 lines
			const scanStart = bodyStart >= 0 ? bodyStart : Math.max(0, i - 10);
			const scanEnd   = Math.min(bodyEnd >= 0 ? bodyEnd : lines.length - 1, i + 8);
			const window    = lines.slice(scanStart, scanEnd + 1).join('\n');

			if (!TIMEOUT_VAR_RE.test(window) && !DECREMENT_RE.test(window)) {
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					'Hardware polling loop with no timeout guard — CPU blocks forever if the peripheral is unresponsive or its clock is not enabled. Add a timeout counter with post-loop error handling'
				));
			}
		}
		return results;
	}


	// ─── Detector: timeout-without-recovery ───────────────────────────────
	//
	// A timeout loop has a countdown variable that prevents infinite spinning.
	// After the loop exits there MUST be a recovery check — if (counter == 0)
	// or equivalent — to handle the case where the peripheral never responded.
	//
	// Detects the timeout variable in THREE places (not just the condition):
	//   Form 1 — condition: while ((cond) && (timeout > 0U)) { ... }
	//   Form 2 — decrement in body: while (cond) { ... timeout--; }
	//   Form 3 — decrement in condition: while (cond && t--) { ... }
	//
	// Recovery is detected as any of:
	//   if (varname == 0)  /  if (!varname)  /  if (varname <= 0)
	//   assert(varname)    /  error_flag = (varname == 0)
	// within 6 lines after the closing brace.
	private _checkTimeoutWithoutRecovery(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Timeout variable name extraction from the while condition
		// Matches any word that is a timeout-style name or is used in a countdown
		const TIMEOUT_NAME_IN_COND_RE  = /\bwhile\s*\([^)]*\b(\w*(?:timeout|retry|retries|count|limit|guard|tick|attempt)\w*)\b/i;
		const DECREMENT_IN_COND_RE     = /\bwhile\s*\([^)]*(?:--(\w+)|\b(\w+)--)/;

		// Timeout variable decremented inside the loop body
		// Matches: timeout--;  --timeout;  timeout -= 1;
		const BODY_DECREMENT_RE = /\b(\w+)\s*(?:--|(?:-=\s*1\s*;))|--\s*(\w+)/;
		const TIMEOUT_NAME_RE   = /\w*(?:timeout|retry|retries|count|limit|guard|tick|attempt)\w*/i;

		// Recovery check: if (var == 0) / if (!var) / if (var <= 0) / assert / error assignment
		const recoveryPresent = (varName: string, afterLines: string[]): boolean => {
			const escaped = this._escapeRegex(varName);
			const patterns = [
				new RegExp(`\\bif\\s*\\([^)]*\\b${escaped}\\b[^)]*(?:==|<=)\\s*0`),
				new RegExp(`\\bif\\s*\\(\\s*!\\s*${escaped}\\s*\\)`),
				new RegExp(`\\bif\\s*\\(\\s*${escaped}\\s*==\\s*0`),
				new RegExp(`\\b${escaped}\\s*==\\s*0.*[=?]`),   // ternary or assignment using check
				new RegExp(`\\bassert\\s*\\([^)]*${escaped}`),
			];
			return afterLines.slice(0, 6).some(l => patterns.some(p => p.test(l)));
		};

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (!trimmed.startsWith('while')) continue;
			if (this._isCommentOnly(trimmed)) continue;

			// Step 1: try to extract timeout variable name from the condition
			let varName: string | undefined;
			const m1 = TIMEOUT_NAME_IN_COND_RE.exec(trimmed);
			if (m1) varName = m1[1];
			if (!varName) {
				const m2 = DECREMENT_IN_COND_RE.exec(trimmed);
				if (m2) varName = m2[1] ?? m2[2];
			}

			// Step 2: find the loop body (closing brace)
			let depth = 0;
			let closeIdx = i;
			for (let j = i; j < Math.min(lines.length, i + 50); j++) {
				for (const ch of lines[j]) {
					if (ch === '{') depth++;
					else if (ch === '}') {
						depth--;
						if (depth === 0) { closeIdx = j; break; }
					}
				}
				if (depth === 0 && j > i) break;
			}

			// Step 3: if variable not found in condition, scan the body for a decrement
			if (!varName) {
				const body = lines.slice(i, closeIdx + 1).join('\n');
				const bm = BODY_DECREMENT_RE.exec(body);
				if (bm) {
					const candidate = bm[1] ?? bm[2];
					if (candidate && TIMEOUT_NAME_RE.test(candidate)) varName = candidate;
				}
			}
			if (!varName) continue;

			// Step 4: check for recovery in the 6 lines after the closing brace
			const afterLines = lines.slice(closeIdx + 1, closeIdx + 7);
			if (!recoveryPresent(varName, afterLines)) {
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					`Timeout loop on '${varName}' has no recovery check after exit — if the condition never occurred the system continues in a degraded state. Add: if (${varName} == 0U) { /* handle timeout error */ }`
				));
			}
		}
		return results;
	}


	// ─── Detector: non-atomic-output-register ─────────────────────────────
	//
	// A read-modify-write (RMW) on a memory-mapped register is non-atomic.
	// Any ISR that touches the same register between the read and write
	// causes a lost-update data corruption.
	//
	// Detection strategy is STRUCTURAL, not register-name-specific:
	//
	//   Pattern A — Single-line compound assign on a pointer dereference:
	//     *ptr |= mask;   *pREG &= ~flag;   *any_ptr ^= val;
	//     These are ALWAYS an RMW because the CPU must read the value,
	//     modify it, then write it back — three separate bus transactions.
	//
	//   Pattern B — Convention-based ALL_CAPS_UNDERSCORE compound assign:
	//     PERIPHERAL_REGISTER |= bit;
	//     In embedded C, ALL_CAPS identifiers with underscores are
	//     overwhelmingly memory-mapped peripheral register macros.
	//     Local variables use camelCase or snake_case — not ALL_CAPS.
	//
	//   Pattern C — Multi-step read \u2192 modify \u2192 write sequence:
	//     temp = *ptr;      (or via REG_READ / similar read macro)
	//     temp ^= mask;
	//     *ptr = temp;      (or via REG_WRITE / similar write macro)
	//     Detected by tracking the variable assigned from a pointer read
	//     and checking whether it is then compound-assigned within 6 lines.
	//
	// Suppressed when atomic guards appear on the same or adjacent lines:
	//   __disable_irq / __enable_irq pairing
	//   ATOMIC_BLOCK / taskENTER_CRITICAL / portDISABLE_INTERRUPTS
	//   Any write via BSRR / BRR / SET_BITS / CLEAR_BITS (already atomic)
	private _checkNonAtomicOutputRegister(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number,
		rmwMacros: ReadonlySet<string> = new Set()
	): ICheckResult[] {
		const results: ICheckResult[] = [];
		const reported = new Set<number>();

		// If header scan hasn't run yet, discover RMW macros inline from
		// any #define lines in the current file (covers single-file projects
		// or headers included via #include in the same translation unit).
		let effectiveRmwMacros = rmwMacros;
		if (rmwMacros.size === 0) {
			const inlineMacros = new Set<string>();
			const inlineDirect = new Set<string>();
			CHeaderSymbolTable.extractRmwMacros(lines.join('\n'), inlineMacros, inlineDirect);
			if (inlineMacros.size > 0) {
				effectiveRmwMacros = inlineMacros;
			}
		}

		// Compound-assign operators that imply read-before-write
		const COMPOUND_ASSIGN_RE = /(?:\|=|&=|\^=)/;

		// Pattern A: pointer dereference compound assign — *anything |= value
		const PTR_DEREF_RMW_RE = /^\s*\*\s*\w[\w.->[\]]*\s*(?:\|=|&=|\^=)/;

		// Pattern B: ALL_CAPS_UNDERSCORE identifier compound assign
		// Heuristic: identifiers that are ALL_CAPS, contain at least one _,
		// and have a minimum length to exclude short loop variables like I, N.
		// This matches register-style names universally: RCC_AHBENR, GPIOA_MODER,
		// USART1_CR1, TCCR0B, P1OUT (TI MSP430), TRISA (PIC), CTRL_REG (generic).
		const PERIPH_CAPS_RMW_RE = /\b([A-Z][A-Z0-9]{1,}[_][A-Z0-9_]{2,})\s*(?:\|=|&=|\^=)/;

		// Atomic guard: any of these on the same line or within 2 lines means
		// the developer has protected the RMW — don't flag it.
		const ATOMIC_GUARD_RE = /\b(?:__disable_irq|__enable_irq|taskENTER_CRITICAL|taskEXIT_CRITICAL|portDISABLE_INTERRUPTS|portENABLE_INTERRUPTS|ATOMIC_BLOCK|noInterrupts|interrupts|cli\s*\(|sei\s*\(|BSRR|BRR|ATOMIC_SET_BITS|ATOMIC_CLEAR_BITS|ATOMIC_SET|ATOMIC_CLEAR)\b/i;

		const isAtomicContext = (lineIdx: number): boolean => {
			const start = Math.max(0, lineIdx - 2);
			const end   = Math.min(lines.length - 1, lineIdx + 2);
			for (let k = start; k <= end; k++) {
				if (ATOMIC_GUARD_RE.test(lines[k])) return true;
			}
			return false;
		};

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (this._isCommentOnly(trimmed)) continue;
			if (!COMPOUND_ASSIGN_RE.test(trimmed)) {
				// Still check Pattern C trigger (read into temp)
			} else if (!reported.has(i)) {
				// ── Pattern A ──────────────────────────────────────────────────
				if (PTR_DEREF_RMW_RE.test(trimmed) && !isAtomicContext(i)) {
					results.push(this._makeResult(
						rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
						`Pointer dereference with compound-assign is a non-atomic read-modify-write — concurrent ISR access to the same register corrupts the result. Guard with disable/enable IRQ or use an atomic set/clear mechanism`
					));
					reported.add(i);
					continue;
				}

				// ── Pattern B ──────────────────────────────────────────────────
				const mb = PERIPH_CAPS_RMW_RE.exec(trimmed);
				if (mb && !isAtomicContext(i)) {
					results.push(this._makeResult(
						rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
						`'${mb[1]}' modified via compound-assign — non-atomic read-modify-write on a peripheral register. Concurrent ISR access to the same register corrupts the result`
					));
					reported.add(i);
					continue;
				}
			}

			// ── Pattern D: inline RMW — CAPS_REG = (CAPS_REG & ~mask) | val ──
			// Common embedded idiom: direct register = (register & clear) | set
			// The `=` hides the read-modify-write from compound-assign detection.
			const INLINE_RMW_RE = /\b([A-Z][A-Z0-9]{1,}[_][A-Z0-9_]{2,})\s*=\s*\(\s*\1\s*&/;
			if (!reported.has(i) && !COMPOUND_ASSIGN_RE.test(trimmed)) {
				const md = INLINE_RMW_RE.exec(trimmed);
				if (md && !isAtomicContext(i)) {
					results.push(this._makeResult(
						rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
						`'${md[1]}' modified via inline read-modify-write (REG = (REG & ~mask) | val) — non-atomic; concurrent ISR access to the same register corrupts the result`
					));
					reported.add(i);
				}
			}

			// ── Pattern E: macro-wrapped RMW (discovered from project headers) ──
			// The header scanner found macros whose #define body expands to |=, &=, ^=
			// or read-clear-set. Flag calls to those macros as non-atomic RMW.
			if (!reported.has(i) && effectiveRmwMacros.size > 0) {
				const macroCallMatch = /\b([A-Za-z_]\w*)\s*\(/.exec(trimmed);
				if (macroCallMatch && effectiveRmwMacros.has(macroCallMatch[1]) && !isAtomicContext(i)) {
					results.push(this._makeResult(
						rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
						`'${macroCallMatch[1]}' expands to a non-atomic read-modify-write — discovered from project headers. Guard with __disable_irq/__enable_irq or use atomic BSRR/BRR writes`
					));
					reported.add(i);
				}
			}

			// ── Pattern C: multi-step read \u2192 modify sequence ───────────────
			// Trigger: variable assigned from a pointer dereference or read macro
			//   temp = *pREG;   val = REG_READ(...);   v = *ptr;
			const READ_TRIGGER_RE = /^\s*(\w+)\s*=\s*(?:\*\s*\w[\w.->[\]]*|REG_READ\s*\(|MMIO_READ\s*\(|READ_REG\s*\()/;
			const rt = READ_TRIGGER_RE.exec(lines[i]);
			if (rt && !reported.has(i) && !isAtomicContext(i)) {
				const varName = rt[1];
				// Within next 6 lines: compound-assign on this variable = multi-step RMW
				for (let j = i + 1; j < Math.min(lines.length, i + 7); j++) {
					const ahead = lines[j].trim();
					if (this._isCommentOnly(ahead)) continue;
					if (new RegExp(`^\\s*\\b${this._escapeRegex(varName)}\\b\\s*(?:\\|=|&=|\\^=)`).test(lines[j])) {
						if (!isAtomicContext(i)) {
							results.push(this._makeResult(
								rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
								`Register read into '${varName}' then modified — multi-step non-atomic read-modify-write. Use atomic set/clear instead of read-modify-write sequence`
							));
							reported.add(i);
						}
						break;
					}
					// Stop if we hit an unrelated statement that ends the RMW window
					if (/^(?:if|for|while|return|}\s*$)/.test(ahead)) break;
				}
			}
		}
		return results;
	}


	// ─── Detector: unbounded-string-loop ──────────────────────────────────
	//
	// Walking a char pointer until '\0' with no explicit length bound is
	// safe only if the string is guaranteed null-terminated. In embedded C
	// a corrupted pointer, misaligned DMA buffer, or packed struct member
	// can point to memory with no '\0' — causing reads into peripheral space.
	//
	// Flags: while (*ptr != '\0') / while (*ptr) with no length variable
	// in the surrounding 10 lines. Skips standard-library equivalents.
	private _checkUnboundedStringLoop(
		rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number
	): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Canonical null-terminator traversal patterns
		const NULL_TERM_LOOP_RE = /\bwhile\s*\(\s*\*\w+\s*(?:!=\s*(?:'\\0'|0U?|'\0'))?\s*\)/;
		const NULL_TERM_LOOP2_RE = /\bwhile\s*\(\s*\*\w+\s*!=\s*'\\0'\s*\)/;

		// A length bound is present if ANY of the following appear within 10 lines:
		//   - a variable named len/length/size/max/count/limit decremented or compared
		//   - strlen / strnlen / sizeof call in the same function
		//   - a second condition in the while itself (&&)
		const BOUND_RE = /\b(?:len|length|size|max|count|limit|bound|remaining|n)\b.*(?:--|>|<|>=|<=)|\bstrn?len\b|\bsizeof\b/i;
		const DOUBLE_COND_RE = /\bwhile\s*\([^)]*&&[^)]*\)/;

		for (let i = 0; i < lines.length; i++) {
			const trimmed = lines[i].trim();
			if (this._isCommentOnly(trimmed)) continue;
			if (!NULL_TERM_LOOP_RE.test(trimmed) && !NULL_TERM_LOOP2_RE.test(trimmed)) continue;

			// Skip if the while itself has a second (length) condition
			if (DOUBLE_COND_RE.test(trimmed)) continue;

			// Check 10-line window around the loop for any length bound
			const wStart = Math.max(0, i - 5);
			const wEnd   = Math.min(lines.length - 1, i + 5);
			const window = lines.slice(wStart, wEnd + 1).join('\n');

			if (!BOUND_RE.test(window)) {
				results.push(this._makeResult(
					rule, fileUri, i + 1, 1, i + 1, trimmed.length + 1, trimmed, timestamp,
					'String traversal loop with no maximum length guard — unbounded read if string is not null-terminated. Add a length parameter or use strnlen()/strlcpy()'
				));
			}
		}
		return results;
	}


	// ─── Result factory ───────────────────────────────────────────────────

	private _makeResult(
		rule: IGRCRule,
		fileUri: URI,
		line: number,
		column: number,
		endLine: number,
		endColumn: number,
		snippet: string,
		timestamp: number,
		detail: string
	): ICheckResult {
		// Append the framework rule's description when it provides additional context
		// beyond the one-line message that is already embedded in `detail`.
		const description = rule.description;
		const baseMessage = `[${rule.id}] ${detail}`;
		const message = (description && description !== rule.message && !detail.includes(description))
			? `${baseMessage}. ${description}`
			: baseMessage;
		return {
			ruleId:           rule.id,
			domain:           rule.domain,
			severity:         rule.severity,
			message:          message,
			fileUri,
			line,
			column,
			endLine,
			endColumn,
			codeSnippet:      snippet.substring(0, 120),
			fix:              rule.fix,
			timestamp,
			frameworkId:      rule.frameworkId,
			references:       rule.references,
			blockingBehavior: rule.blockingBehavior,
			checkSource:      'static',
		};
	}


	// ─── Utility helpers ──────────────────────────────────────────────────

	/** Return true when this file is a C/C++ source based on languageId or extension. */
	private _isCFile(languageId: string, filePath: string): boolean {
		if (this.supportedLanguages.includes(languageId)) return true;
		const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
		return CStructuralAnalyzer.C_EXTENSIONS.has(ext);
	}

	/** True when a trimmed line is blank or a comment token. */
	private _isCommentOnly(trimmed: string): boolean {
		return (
			trimmed.length === 0 ||
			trimmed.startsWith('//') ||
			trimmed.startsWith('/*') ||
			trimmed.startsWith('*') ||
			trimmed.startsWith('#')
		);
	}

	private _escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
}
