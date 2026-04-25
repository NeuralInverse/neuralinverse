/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Language Detector
 *
 * Determines the programming language of a source file using:
 *  1. File extension lookup (primary signal — fast, deterministic)
 *  2. Shebang detection on the first line (e.g. `#!/usr/bin/env python3`)
 *  3. Content heuristics for ambiguous files (ISR patterns, IEC 61131-3 structure, etc.)
 *
 * Returns a normalised language key (e.g. `'embedded-c'`, `'iec61131'`, `'assembler'`)
 * that is used throughout the discovery pipeline for routing to the correct decomposer,
 * fingerprinter, and dependency extractor.
 */

// ─── Extension \u2192 Language map ─────────────────────────────────────────────────

export const EXT_TO_LANG: Readonly<Record<string, string>> = {
	// ── Embedded C / C++ ────────────────────────────────────────────────────
	c:       'c',            // C source — routed to embedded-c patterns when MCU heuristics found
	h:       'c',            // C header
	cpp:     'cpp',
	cc:      'cpp',
	cxx:     'cpp',
	hpp:     'cpp',
	hxx:     'cpp',
	// ── Assembly (ARM / AVR / RISC-V) ───────────────────────────────────────
	s:       'assembler',    // ARM/RISC-V assembly (.s)
	asm:     'assembler',    // Generic assembly (.asm)
	asm51:   'assembler',    // 8051 assembly
	inc:     'assembler',    // Assembly include file
	// ── Rust (embedded) ─────────────────────────────────────────────────────
	rs:      'rust',
	// ── Firmware description / toolchain files ──────────────────────────────
	svd:     'svd',          // CMSIS SVD peripheral register description
	ld:      'linker-script',// GNU LD linker script
	scf:     'linker-script',// ARM Scatter file
	xcl:     'linker-script',// IAR linker configuration
	cmake:   'cmake',        // CMake build script
	// ── IEC 61131-3 / PLC ───────────────────────────────────────────────────
	st:      'iec61131',     // Structured Text
	exp:     'iec61131',     // CoDeSys export
	il:      'iec61131',     // Instruction List
	pou:     'iec61131',     // Program Organisation Unit
	fbd:     'iec61131',     // Function Block Diagram
	sfc:     'iec61131',     // Sequential Function Chart
	ldr:     'iec61131',     // Ladder Diagram
	// ── AUTOSAR ─────────────────────────────────────────────────────────────
	arxml:   'autosar',      // AUTOSAR XML (SWC, ECUC, System Description)
	// ── Protocol / Network description ──────────────────────────────────────
	dbc:     'can-dbc',      // CAN bus database file
	sym:     'can-dbc',      // CAN symbol file
	ldf:     'lin-ldf',      // LIN network description
	opf:     'flexray',      // FlexRay parameter file
	// ── Telecom ──────────────────────────────────────────────────────────────
	ttcn:    'ttcn3',         // TTCN-3 test module
	ttcn3:   'ttcn3',
	ttcnpp:  'ttcn3',         // TTCN-3 preprocessor format
	// ── Systems / high-level languages (still supported for hybrid projects) ─
	go:      'go',
	py:      'python',
	pyw:     'python',
	ts:      'typescript',
	tsx:     'typescript',
	js:      'javascript',
	jsx:     'javascript',
	java:    'java',
	cs:      'csharp',
};


// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect the programming language of a file.
 *
 * @param ext      Lowercase file extension without the dot (e.g. `'ts'`, `'cbl'`)
 * @param content  Optional file content for shebang / heuristic detection fallback
 */
export function detectLanguage(ext: string, content?: string): string {
	// Primary: extension lookup
	const byExt = EXT_TO_LANG[ext];
	if (byExt) { return byExt; }

	// Secondary: shebang / first-line analysis
	if (content) {
		const firstLine = content.trimStart().slice(0, 120);

		if (/^#!.*\bpython/.test(firstLine))           { return 'python'; }
		if (/^#!.*\bruby/.test(firstLine))              { return 'ruby'; }
		if (/^#!.*\bnode/.test(firstLine))              { return 'javascript'; }
		if (/^#!.*\bperl/.test(firstLine))              { return 'perl'; }
		if (/^#!.*\b(bash|sh|zsh|ksh)/.test(firstLine)) { return 'shell'; }

		// CMSIS SVD heuristic (XML with <peripheral> root element)
		const sample = content.slice(0, 500);
		if (/<device\s|<peripherals>|<peripheral>/.test(sample)) {
			return 'svd';
		}

		// AUTOSAR ARXML heuristic
		if (/xmlns.*autosar|AUTOSAR/i.test(sample)) {
			return 'autosar';
		}

		// TTCN-3 heuristic
		if (/\bmodule\s+\w+\s*\{|\btestcase\s+\w+\s*\(|\baltstep\s+\w+/.test(sample)) {
			return 'ttcn3';
		}

		// IEC 61131-3 Structured Text heuristic
		if (/\bFUNCTION_BLOCK\b|\bPROGRAM\b|\bVAR_INPUT\b|\bVAR_OUTPUT\b/.test(sample)) {
			return 'iec61131';
		}

		// Embedded C heuristic: MCU-specific includes or ISR declarations
		if (
			/#include\s+["<](stm32|nxp|avr|sam|pic|esp|nordic|nrf|gigadevice|gd32|kinetis|imxrt|s32k)/i.test(sample) ||
			/\bvolatile\s+uint(8|16|32)_t\s*\*/.test(sample) ||
			/\bvoid\s+\w+_IRQHandler\s*\(\s*void\s*\)/.test(sample) ||
			/#include\s+["<](freertos|FreeRTOS|zephyr\/kernel|cmsis_os)/i.test(sample)
		) {
			return 'c';
		}

		// GNU LD linker script heuristic
		if (/MEMORY\s*\{|SECTIONS\s*\{|PROVIDE\s*\(/.test(sample)) {
			return 'linker-script';
		}
	}

	return 'unknown';
}

/**
 * Whether the given language key maps to a safety-critical / embedded legacy language.
 * Used by the risk scorer and planner prompt builder.
 */
export function isFirmwareLanguage(lang: string): boolean {
	return [
		// Firmware & embedded
		'c', 'cpp', 'rust', 'assembler', 'svd', 'linker-script',
		// Industrial / PLC
		'iec61131',
		// Automotive
		'autosar', 'can-dbc', 'lin-ldf', 'flexray',
		// Telecom
		'ttcn3',
		// Energy / OT
		'energy', 'iiot-ot',
	].includes(lang);
}

/** @deprecated Use isFirmwareLanguage instead. Retained for backwards compat. */
export function isLegacyLanguage(lang: string): boolean {
	return isFirmwareLanguage(lang);
}

/**
 * The primary compliance framework most associated with a language for risk scoring.
 */
export function getPrimaryComplianceFramework(lang: string): string {
	const map: Record<string, string> = {
		'c':            'misra-c',
		'cpp':          'misra-c',
		'assembler':    'iec-61508',
		'iec61131':     'iec-61508',
		'autosar':      'iso-26262',
		'can-dbc':      'iso-26262',
		'lin-ldf':      'iso-26262',
		'flexray':      'iso-26262',
		'ttcn3':        'iec-62443',
		'svd':          'iec-61508',
		'energy':       'iec-61508',
		'iiot-ot':      'iec-62443',
	};
	return map[lang] ?? 'iec-61508';
}

/**
 * Whether the given language key supports sub-file unit decomposition.
 * For unsupported languages the decomposer falls back to one unit per file.
 */
export function supportsDecomposition(lang: string): boolean {
	return [
		'c', 'cpp', 'rust',          // Embedded systems
		'assembler',                  // ARM/AVR assembly (subroutine-level)
		'iec61131',                   // PLC structured text / ladder
		'autosar',                    // AUTOSAR SWC decomposition
		'can-dbc',                    // CAN DBC message-level decomposition
		'ttcn3',                      // TTCN-3 test module decomposition
		'java', 'kotlin', 'scala', 'csharp', 'python',
		'typescript', 'javascript', 'go',
	].includes(lang);
}
