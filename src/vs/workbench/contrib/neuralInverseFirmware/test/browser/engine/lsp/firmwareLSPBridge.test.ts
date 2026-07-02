/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { IPeripheralRegisterMap } from '../../../../browser/common/firmwareTypes.js';

// ─── Inline reimplementation of the LSP bridge analysis rules ─────────────────
// Tests the firmware code analysis rules by running the same patterns.

interface IFirmwareDiagnostic {
	file: string;
	line: number;
	column?: number;
	severity: 'error' | 'warning' | 'info' | 'hint';
	message: string;
	ruleId: string;
	category: string;
	fix?: string;
}

interface IAnalysisRule {
	id: string;
	category: string;
	severity: IFirmwareDiagnostic['severity'];
	pattern: RegExp;
	message: (match: RegExpExecArray) => string;
	fix?: (match: RegExpExecArray) => string;
}

const RULES: IAnalysisRule[] = [
	{
		id: 'FW001',
		category: 'volatile',
		severity: 'warning',
		pattern: /\b(?:uint32_t|uint16_t|uint8_t)\s*\*\s*(\w+)\s*=\s*\((?:uint32_t|uint16_t|uint8_t)\s*\*\)\s*(0x[0-9A-Fa-f]+)/g,
		message: (m) => `Register pointer '${m[1]}' at ${m[2]} should use volatile qualifier.`,
		fix: (m) => `volatile ${m[0]}`,
	},
	{
		id: 'FW003',
		category: 'misra',
		severity: 'warning',
		pattern: /\b(malloc|calloc|realloc|free)\s*\(/g,
		message: (m) => `Dynamic memory allocation '${m[1]}()' detected.`,
	},
	{
		id: 'FW004',
		category: 'misra',
		severity: 'info',
		pattern: /while\s*\(\s*1\s*\)|for\s*\(\s*;\s*;\s*\)/g,
		message: () => 'Infinite loop detected. Add proper WDT refresh.',
	},
	{
		id: 'FW005',
		category: 'volatile',
		severity: 'warning',
		pattern: /\*\s*\(\s*(?:uint32_t|uint16_t|uint8_t)\s*\*\s*\)\s*(0x[0-9A-Fa-f]{8})/g,
		message: (m) => `Direct memory access at ${m[1]} without volatile.`,
		fix: (m) => `*(volatile uint32_t *)${m[1]}`,
	},
	{
		id: 'FW008',
		category: 'general',
		severity: 'hint',
		pattern: /\b(printf|fprintf|sprintf)\s*\(/g,
		message: (m) => `'${m[1]}()' uses significant stack space.`,
	},
];

function analyzeFirmwareCode(content: string, filePath: string): IFirmwareDiagnostic[] {
	const diagnostics: IFirmwareDiagnostic[] = [];
	for (const rule of RULES) {
		rule.pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = rule.pattern.exec(content)) !== null) {
			const beforeMatch = content.substring(0, match.index);
			const line = beforeMatch.split('\n').length;
			const lastNewline = beforeMatch.lastIndexOf('\n');
			const column = match.index - lastNewline;
			diagnostics.push({
				file: filePath,
				line,
				column,
				severity: rule.severity,
				message: rule.message(match),
				ruleId: rule.id,
				category: rule.category,
				fix: rule.fix ? rule.fix(match) : undefined,
			});
		}
	}
	return diagnostics;
}

// ─── Register completion logic (inline) ──────────────────────────────────────

function getRegisterCompletions(registerMaps: IPeripheralRegisterMap[], prefix: string) {
	const results: Array<{ label: string; kind: string; sortPriority: number }> = [];
	const q = prefix.toUpperCase();

	for (const map of registerMaps) {
		if (map.name.toUpperCase().startsWith(q)) {
			results.push({ label: map.name, kind: 'peripheral', sortPriority: 0 });
		}
		for (const reg of map.registers) {
			const fullName = `${map.name}_${reg.name}`;
			if (reg.name.toUpperCase().startsWith(q) || fullName.toUpperCase().startsWith(q)) {
				results.push({ label: fullName, kind: 'register', sortPriority: 1 });
			}
			for (const field of reg.fields) {
				const fieldFull = `${map.name}_${reg.name}_${field.name}`;
				if (field.name.toUpperCase().startsWith(q) || fieldFull.toUpperCase().startsWith(q)) {
					results.push({ label: fieldFull, kind: 'bitfield', sortPriority: 2 });
				}
			}
		}
	}
	return results.sort((a, b) => a.sortPriority - b.sortPriority || a.label.localeCompare(b.label));
}

const USART1_MAP: IPeripheralRegisterMap = {
	name: 'USART1',
	groupName: 'USART',
	baseAddress: 0x40011000,
	description: 'USART1',
	registers: [
		{
			name: 'CR1',
			addressOffset: 0x0C,
			size: 32,
			access: 'read-write',
			resetValue: 0,
			description: 'Control register 1',
			fields: [
				{ name: 'UE', bitOffset: 13, bitWidth: 1, access: 'read-write', description: 'USART enable' },
				{ name: 'TE', bitOffset: 3, bitWidth: 1, access: 'read-write', description: 'Transmitter enable' },
			],
		},
		{
			name: 'BRR',
			addressOffset: 0x08,
			size: 32,
			access: 'read-write',
			resetValue: 0,
			description: 'Baud rate register',
			fields: [],
		},
	],
	interrupts: [{ name: 'USART1_IRQn', value: 37, description: 'USART1 interrupt' }],
};

suite('Firmware LSP Bridge - Code Analysis', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── FW001: volatile ─────────────────────────────────────────────────────

	test('FW001: detects non-volatile register pointer cast', () => {
		const code = `uint32_t *uart_sr = (uint32_t *)0x40011000;`;
		const diags = analyzeFirmwareCode(code, 'src/main.c');
		const fw001 = diags.filter(d => d.ruleId === 'FW001');
		assert.ok(fw001.length >= 1, `Expected FW001 diagnostic, got: ${JSON.stringify(diags)}`);
		assert.ok(fw001[0]!.message.includes('volatile'));
	});

	test('FW001: does not fire on volatile pointer (no false positive)', () => {
		const code = `volatile uint32_t *uart_sr = (volatile uint32_t *)0x40011000;`;
		const diags = analyzeFirmwareCode(code, 'src/main.c').filter(d => d.ruleId === 'FW001');
		assert.strictEqual(diags.length, 0);
	});

	// ─── FW003: dynamic memory ────────────────────────────────────────────────

	test('FW003: detects malloc call', () => {
		const code = `void *buf = malloc(256);`;
		const diags = analyzeFirmwareCode(code, 'src/main.c');
		const fw003 = diags.filter(d => d.ruleId === 'FW003');
		assert.ok(fw003.length >= 1);
		assert.ok(fw003[0]!.message.includes('malloc'));
	});

	test('FW003: detects calloc and free', () => {
		const code = `void *buf = calloc(4, 64);\nfree(buf);`;
		const diags = analyzeFirmwareCode(code, 'src/main.c').filter(d => d.ruleId === 'FW003');
		assert.ok(diags.length >= 2);
	});

	// ─── FW004: infinite loop ─────────────────────────────────────────────────

	test('FW004: detects while(1) loop', () => {
		const code = `while (1) { blink(); }`;
		const diags = analyzeFirmwareCode(code, 'src/main.c');
		const fw004 = diags.filter(d => d.ruleId === 'FW004');
		assert.ok(fw004.length >= 1);
		assert.ok(fw004[0]!.severity === 'info');
	});

	test('FW004: detects for(;;) loop', () => {
		const code = `for (;;) { process(); }`;
		const diags = analyzeFirmwareCode(code, 'src/main.c').filter(d => d.ruleId === 'FW004');
		assert.ok(diags.length >= 1);
	});

	// ─── FW005: direct memory access ─────────────────────────────────────────

	test('FW005: detects direct non-volatile register read', () => {
		const code = `uint32_t val = *(uint32_t *)0x40011000;`;
		const diags = analyzeFirmwareCode(code, 'src/main.c').filter(d => d.ruleId === 'FW005');
		assert.ok(diags.length >= 1);
		assert.ok(diags[0]!.fix?.includes('volatile'));
	});

	// ─── FW008: printf ────────────────────────────────────────────────────────

	test('FW008: detects printf in firmware code', () => {
		const code = `printf("value: %d\\n", x);`;
		const diags = analyzeFirmwareCode(code, 'src/main.c').filter(d => d.ruleId === 'FW008');
		assert.ok(diags.length >= 1);
		assert.strictEqual(diags[0]!.severity, 'hint');
	});

	// ─── Line number accuracy ─────────────────────────────────────────────────

	test('diagnostics report correct 1-indexed line number', () => {
		const code = `#include <stm32f4xx.h>\n\nvoid init() {\n  uint32_t *r = (uint32_t *)0x40011000;\n}`;
		const diags = analyzeFirmwareCode(code, 'src/main.c').filter(d => d.ruleId === 'FW001');
		assert.ok(diags.length >= 1);
		assert.strictEqual(diags[0]!.line, 4);
	});

	// ─── Clean code ───────────────────────────────────────────────────────────

	test('clean C code produces no diagnostics', () => {
		const code = `void blink(void) {\n  volatile uint32_t *odr = (volatile uint32_t *)0x40020014;\n  *odr ^= (1U << 5);\n}`;
		const diags = analyzeFirmwareCode(code, 'src/clean.c');
		assert.strictEqual(diags.length, 0, `Unexpected diagnostics: ${JSON.stringify(diags)}`);
	});
});

suite('Firmware LSP Bridge - Register Completions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('prefix "USART" returns peripheral completion for USART1', () => {
		const completions = getRegisterCompletions([USART1_MAP], 'USART');
		const peripheral = completions.find(c => c.label === 'USART1' && c.kind === 'peripheral');
		assert.ok(peripheral, 'Expected USART1 peripheral completion');
	});

	test('prefix "USART1_CR" returns register completion', () => {
		const completions = getRegisterCompletions([USART1_MAP], 'USART1_CR');
		const reg = completions.find(c => c.label === 'USART1_CR1' && c.kind === 'register');
		assert.ok(reg, 'Expected USART1_CR1 register completion');
	});

	test('prefix "USART1_CR1_UE" returns bitfield completion', () => {
		const completions = getRegisterCompletions([USART1_MAP], 'USART1_CR1_UE');
		const field = completions.find(c => c.label === 'USART1_CR1_UE' && c.kind === 'bitfield');
		assert.ok(field, 'Expected USART1_CR1_UE bitfield completion');
	});

	test('unmatched prefix returns empty array', () => {
		const completions = getRegisterCompletions([USART1_MAP], 'SPI3_CR');
		assert.strictEqual(completions.length, 0);
	});

	test('completions are sorted by priority (peripheral < register < bitfield)', () => {
		const completions = getRegisterCompletions([USART1_MAP], 'USART');
		const kinds = completions.map(c => c.kind);
		const firstNonPeripheral = kinds.findIndex(k => k !== 'peripheral');
		const firstBitfield = kinds.findIndex(k => k === 'bitfield');
		if (firstNonPeripheral >= 0 && firstBitfield >= 0) {
			assert.ok(firstNonPeripheral <= firstBitfield, 'Peripherals should come before bitfields');
		}
	});
});
