/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # CHeaderSymbolTable
 *
 * Parses C/C++ header files to extract function return-type signatures.
 * Used by {@link CStructuralAnalyzer} to avoid flagging calls to void-returning
 * functions declared in included headers as "missing error propagation".
 *
 * ## Design
 * - Plain TypeScript class — no VS Code DI, instantiated directly by CStructuralAnalyzer.
 * - Caches per-file-basename sets of void function names and a global return-type map.
 * - Signature extraction is structural (regex over common declaration patterns) and
 *   intentionally conservative: it only collects what it is confident about.
 *
 * ## What it detects
 * Lines that look like:
 *   `void GPIO_Init(GPIO_TypeDef* GPIOx, GPIO_InitTypeDef* GPIO_Init);`
 *   `extern void HAL_Delay(uint32_t Delay);`
 *   `static inline void __enable_irq(void)`
 *   `int HAL_UART_Transmit(UART_HandleTypeDef *huart, ...);`
 *
 * It intentionally skips preprocessor directives, comments, typedefs, structs, and enums.
 */

// ─── Public types ─────────────────────────────────────────────────────────────

export interface IHeaderSignature {
	funcName: string;
	returnType: string; // e.g. "void", "int", "HAL_StatusTypeDef *"
}

// ─── CHeaderSymbolTable ───────────────────────────────────────────────────────

export class CHeaderSymbolTable {

	/**
	 * Map from header file basename (e.g. "stm32f4xx_hal_gpio.h") \u2192
	 * set of void-returning function names declared in that file.
	 */
	private readonly _voidByFile = new Map<string, Set<string>>();

	/**
	 * Global return-type map: funcName \u2192 return type string.
	 * Last-writer-wins when the same name appears in multiple headers.
	 */
	private readonly _returnTypeByName = new Map<string, string>();

	/**
	 * Macro names whose body expands to a compound-assign (|=, &=, ^=)
	 * or a read-clear-set pattern — i.e. non-atomic RMW wrappers.
	 * Discovered dynamically from project headers, not hardcoded.
	 */
	private readonly _rmwMacros = new Set<string>();

	/**
	 * Macro names whose body performs a direct write without reading first
	 * (e.g. REG_WRITE, REG_READ). These are NOT RMW.
	 */
	private readonly _directWriteMacros = new Set<string>();

	// ── Regex for function signature extraction ────────────────────────────
	//
	// Matches declarations / definitions that start with an optional storage class
	// followed by a return type and then a function name + opening parenthesis.
	//
	// Groups:
	//   [1] return type (may include a trailing *)
	//   [2] function name
	//
	// The pattern is anchored at the start of a trimmed line so it does not fire
	// inside struct/union bodies or macro expansions that appear mid-line.
	//
	// Examples matched:
	//   void HAL_Init(void)
	//   extern void HAL_Delay(uint32_t);
	//   static inline uint32_t HAL_GetTick(void)
	//   HAL_StatusTypeDef HAL_SPI_Transmit(...)
	//   uint8_t * USBD_FS_DeviceDescriptor(...)
	//
	private static readonly SIG_RE =
		/^(?:extern\s+|static\s+|inline\s+|__weak\s+|__attribute__\s*\(\([^)]*\)\)\s*)*([A-Za-z_]\w*(?:\s*\*)?)\s+([A-Za-z_]\w*)\s*\(/gm;

	// Lines to skip entirely before running the signature regex
	private static readonly SKIP_RE =
		/^\s*(?:#|\/\/|\/\*|typedef\b|struct\b|enum\b|union\b|class\b|namespace\b|using\b)/;

	// ── Public API ──────────────────────────────────────────────────────────

	/**
	 * Parse a batch of header files and populate the internal caches.
	 *
	 * Safe to call multiple times — new files are merged into the existing cache.
	 * If the same basename is seen again, its void-function set is replaced.
	 *
	 * @param headers Array of {path, content} pairs for .h / .hpp files.
	 */
	public buildFromWorkspaceFiles(headers: Array<{ path: string; content: string }>): void {
		for (const { path, content } of headers) {
			const basename = this._basename(path);
			const sigs = CHeaderSymbolTable.extractSignatures(content);

			const voidSet = new Set<string>();
			for (const sig of sigs) {
				// Normalise: strip pointer whitespace for comparison ("void *" \u2192 "void *")
				const normType = sig.returnType.replace(/\s*\*\s*/g, ' *').trim();
				this._returnTypeByName.set(sig.funcName, normType);
				if (normType === 'void') {
					voidSet.add(sig.funcName);
				}
			}
			this._voidByFile.set(basename, voidSet);

			// Discover RMW macros from #define bodies
			CHeaderSymbolTable.extractRmwMacros(content, this._rmwMacros, this._directWriteMacros);
		}
	}

	/**
	 * Returns the union of all void-returning function names across every parsed header.
	 *
	 * Used by CStructuralAnalyzer to extend its per-file void-function set so that
	 * calls to void functions declared in included headers are not flagged as
	 * "missing error propagation".
	 */
	public getAllVoidFunctions(): Set<string> {
		const union = new Set<string>();
		for (const voidSet of this._voidByFile.values()) {
			for (const name of voidSet) {
				union.add(name);
			}
		}
		return union;
	}

	/**
	 * Returns void-returning functions declared in the specific header identified
	 * by the given basename.  Returns an empty set when the file has not been parsed.
	 *
	 * @param fileBasename e.g. "stm32f4xx_hal_gpio.h"
	 */
	public getVoidFunctions(fileBasename: string): Set<string> {
		return this._voidByFile.get(fileBasename) ?? new Set();
	}

	/**
	 * Global return-type lookup.  Returns the return type string for the given
	 * function name if it was found in any parsed header, or `undefined` otherwise.
	 *
	 * @param funcName e.g. "HAL_SPI_Transmit"
	 */
	public getReturnType(funcName: string): string | undefined {
		return this._returnTypeByName.get(funcName);
	}

	/**
	 * Returns macro names that expand to non-atomic read-modify-write operations.
	 * Discovered from project headers — adapts to any codebase automatically.
	 */
	public getRmwMacros(): ReadonlySet<string> {
		return this._rmwMacros;
	}

	// ── Static helpers ──────────────────────────────────────────────────────

	/**
	 * Scan `#define` macros in a header and classify them as RMW or direct-write.
	 *
	 * RMW patterns (compound-assign on dereferenced pointer or do{}-wrapped):
	 *   `#define SET(r,m) (*(r) |= (m))`
	 *   `#define MOD(r,c,s) do { *(r) = ((*(r) & ~(c)) | (s)); } while(0)`
	 *
	 * Direct-write (NOT RMW):
	 *   `#define WRITE(r,v) (*(r) = (v))`
	 *   `#define READ(r) (*(r))`
	 */
	public static extractRmwMacros(
		content: string,
		rmwOut: Set<string>,
		directOut: Set<string>
	): void {
		// Match function-like #define macros, capturing name and body
		// Handles multi-line macros via line-continuation (\)
		const lines = content.split('\n');
		for (let i = 0; i < lines.length; i++) {
			let line = lines[i];
			// Gather continuation lines
			while (line.endsWith('\\') && i + 1 < lines.length) {
				line = line.slice(0, -1) + ' ' + lines[++i].trim();
			}
			const m = /^\s*#\s*define\s+([A-Za-z_]\w*)\s*\([^)]*\)\s+(.+)$/.exec(line);
			if (!m) continue;

			const macroName = m[1];
			const body = m[2].trim();

			// Skip non-pointer macros (no dereference = not a register accessor)
			if (!/\*/.test(body)) continue;

			// Classify: does the body contain compound-assign (|= &= ^=)?
			if (/\|=|&=|\^=/.test(body)) {
				rmwOut.add(macroName);
				continue;
			}
			// Classify: does the body read then mask-set in one expression?
			// Pattern: *(r) = ((*(r) & ~(c)) | (s))  or  *(r) = (*(r) | (s))
			if (/\*[^=]*=\s*\(\s*\(\s*\*[^&]*&/.test(body) || /\*[^=]*=\s*\(\s*\*[^|]*\|/.test(body)) {
				rmwOut.add(macroName);
				continue;
			}
			// Direct write: *(r) = (v) — single assignment, no read-back
			if (/^\(\s*\*\s*\w[^=]*=\s*\(/.test(body) || /do\s*\{\s*\*\s*\w[^=]*=/.test(body)) {
				directOut.add(macroName);
			}
		}
	}

	/**
	 * Extract function signatures from the raw text of a single header file.
	 *
	 * Static so it can be unit-tested without constructing a full symbol table.
	 */
	public static extractSignatures(content: string): IHeaderSignature[] {
		const results: IHeaderSignature[] = [];

		// Work line-by-line so we can apply the skip filter cheaply.
		// We then re-join non-skipped lines and apply the SIG_RE globally so that
		// multi-line declarations (return type on one line, name on the next) are
		// handled without over-complicating the regex.
		const filteredLines: string[] = [];
		for (const line of content.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) {
				filteredLines.push('');
				continue;
			}
			if (CHeaderSymbolTable.SKIP_RE.test(trimmed)) {
				// Replace with blank line to preserve relative offsets (not strictly required
				// since we aren't tracking line numbers, but keeps the join valid).
				filteredLines.push('');
			} else {
				filteredLines.push(line);
			}
		}

		const filtered = filteredLines.join('\n');

		// Reset lastIndex before each use (the regex has the 'g' flag)
		CHeaderSymbolTable.SIG_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = CHeaderSymbolTable.SIG_RE.exec(filtered)) !== null) {
			const returnType = m[1].replace(/\s+/g, ' ').trim();
			const funcName   = m[2].trim();
			// Skip if the "function name" is actually a keyword that the regex could pick up
			if (KEYWORD_SET.has(funcName)) continue;
			// Skip empty / single-char names that are likely false matches
			if (funcName.length < 2) continue;
			results.push({ funcName, returnType });
		}

		return results;
	}

	// ── Private helpers ──────────────────────────────────────────────────────

	private _basename(path: string): string {
		// Works for both POSIX ('/') and Windows ('\\') paths
		const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
		return idx >= 0 ? path.slice(idx + 1) : path;
	}
}

// ─── Keyword guard set ────────────────────────────────────────────────────────
// C/C++ keywords and common macro names that the signature regex might
// accidentally match as "function names".

const KEYWORD_SET = new Set([
	'if', 'else', 'for', 'while', 'do', 'switch', 'return', 'goto',
	'sizeof', 'typeof', 'alignof', 'alignas', 'noexcept',
	'typedef', 'struct', 'union', 'enum', 'class', 'namespace',
	'template', 'typename', 'operator', 'new', 'delete',
	'virtual', 'override', 'final', 'explicit', 'constexpr', 'consteval',
	'static_assert', 'decltype', 'auto',
	// Common macros that expand to function-like forms
	'SECTION', 'ATTRIBUTE', 'PACKED', 'ALIGNED', 'DEPRECATED',
	'WEAK', 'NAKED', 'NORETURN', 'PRINTF',
]);
