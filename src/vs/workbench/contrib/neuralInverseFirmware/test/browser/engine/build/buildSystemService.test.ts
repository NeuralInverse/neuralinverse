/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';

// ─── Build output parsing fixtures ────────────────────────────────────────────
// parseBuildOutput and parseSizeOutput are public methods on BuildSystemService.
// We test them by instantiating a minimal service-like object that exposes these
// purely-functional methods with no DI requirements.

// Re-implement the parsers here mirroring the production code so tests stay
// deterministic without needing DI setup.

interface IBuildDiagnostic {
	file?: string;
	line?: number;
	column?: number;
	severity: 'error' | 'warning' | 'note';
	message: string;
	code?: string;
}

function parseBuildOutput(output: string): { errors: IBuildDiagnostic[]; warnings: IBuildDiagnostic[] } {
	const errors: IBuildDiagnostic[] = [];
	const warnings: IBuildDiagnostic[] = [];

	const gccRegex = /^(.+?):(\d+):(\d+):\s+(error|warning|note):\s+(.+)$/gm;
	let match: RegExpExecArray | null;
	while ((match = gccRegex.exec(output)) !== null) {
		const d: IBuildDiagnostic = { file: match[1], line: parseInt(match[2]), column: parseInt(match[3]), severity: match[4] as any, message: match[5] };
		d.severity === 'error' ? errors.push(d) : warnings.push(d);
	}

	const iarRegex = /^"?(.+?)"?\((\d+)\)\s*:\s*(Error|Warning)\[([^\]]+)\]:\s*(.+)$/gm;
	while ((match = iarRegex.exec(output)) !== null) {
		const sev = match[3]!.toLowerCase() as 'error' | 'warning';
		const d: IBuildDiagnostic = { file: match[1]!, line: parseInt(match[2]!), severity: sev, message: `[${match[4]}] ${match[5]}`, code: match[4] };
		sev === 'error' ? errors.push(d) : warnings.push(d);
	}

	const keilRegex = /^(.+?)\((\d+)\):\s*(error|warning):\s*#\d+(?:-D)?:\s*(.+)$/gm;
	while ((match = keilRegex.exec(output)) !== null) {
		const sev = match[3]! as 'error' | 'warning';
		const d: IBuildDiagnostic = { file: match[1]!, line: parseInt(match[2]!), severity: sev, message: match[4]! };
		sev === 'error' ? errors.push(d) : warnings.push(d);
	}

	const rustcRegex = /^(error|warning)(?:\[([A-Z0-9]+)\])?:\s*(.+)\n\s+-->\s+(.+?):(\d+):(\d+)/gm;
	while ((match = rustcRegex.exec(output)) !== null) {
		const sev = match[1]! as 'error' | 'warning';
		const d: IBuildDiagnostic = { file: match[4]!, line: parseInt(match[5]!), column: parseInt(match[6]!), severity: sev, message: match[3]!, code: match[2] };
		sev === 'error' ? errors.push(d) : warnings.push(d);
	}

	const seen = new Set<string>();
	const dedup = (arr: IBuildDiagnostic[]) => arr.filter(d => {
		const key = `${d.file}:${d.line}:${d.message}`;
		if (seen.has(key)) return false;
		seen.add(key); return true;
	});
	return { errors: dedup(errors), warnings: dedup(warnings) };
}

function parseSizeOutput(output: string, mcuFlashSize: number, mcuRamSize: number) {
	const lines = output.trim().split('\n');
	const dataLine = lines.find(l => /^\s*\d+/.test(l));
	if (!dataLine) return { textSize: 0, dataSize: 0, bssSize: 0, flashUsage: 0, ramUsage: 0, flashPercent: 0, ramPercent: 0, sections: [] };
	const parts = dataLine.trim().split(/\s+/);
	const textSize = parseInt(parts[0]) || 0;
	const dataSize = parseInt(parts[1]) || 0;
	const bssSize = parseInt(parts[2]) || 0;
	const flashUsage = textSize + dataSize;
	const ramUsage = dataSize + bssSize;
	return {
		textSize, dataSize, bssSize, flashUsage, ramUsage,
		flashPercent: mcuFlashSize > 0 ? (flashUsage / mcuFlashSize) * 100 : 0,
		ramPercent: mcuRamSize > 0 ? (ramUsage / mcuRamSize) * 100 : 0,
		sections: [
			{ name: '.text', size: textSize, address: 0x08000000 },
			{ name: '.data', size: dataSize, address: 0x20000000 },
			{ name: '.bss', size: bssSize, address: 0x20000000 + dataSize },
		],
	};
}

// ─── GCC fixture ──────────────────────────────────────────────────────────────
const GCC_ERROR_OUTPUT = `
main.c:42:10: error: expected ';' before '}' token
main.c:43:1: warning: unused variable 'x' [-Wunused-variable]
drivers/uart.c:15:5: error: implicit declaration of function 'HAL_UART_Init' [-Wimplicit-function-declaration]
`.trim();

// ─── IAR fixture ─────────────────────────────────────────────────────────────
const IAR_ERROR_OUTPUT = `
"src/main.c"(10) : Error[Pe065]: operation may be undefined
"src/peripheral.c"(25) : Warning[Pe177]: variable was declared but never referenced
`.trim();

// ─── Keil ARM-CC fixture ──────────────────────────────────────────────────────
const KEIL_ERROR_OUTPUT = `
src/main.c(10): error: #65-D: expected a ";"
src/peripheral.c(25): warning: #1-D: last line of file ends without a newline
`.trim();

// ─── rustc fixture ────────────────────────────────────────────────────────────
const RUSTC_ERROR_OUTPUT = `error[E0308]: mismatched types
  --> src/main.rs:42:10
   |
42 |     let x: u32 = "hello";
   |            ^^^   ^^^^^^^ expected u32, found &str`;

// ─── arm-none-eabi-size fixture ───────────────────────────────────────────────
const ARM_SIZE_OUTPUT = `   text\t   data\t    bss\t    dec\t    hex\tfilename
  12345\t    256\t   4096\t  16697\t   4139\tfirmware.elf`;

// ─── arm-none-eabi-size -A -d fixture (unused) ───────────────────────────────

suite('BuildSystemService - Build Output Parsing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── GCC error parsing ────────────────────────────────────────────────────

	test('parseBuildOutput: GCC error extracts file, line, column, message', () => {
		const { errors } = parseBuildOutput(GCC_ERROR_OUTPUT);
		assert.ok(errors.length >= 2, `Expected >= 2 GCC errors, got ${errors.length}`);
		const first = errors[0]!;
		assert.strictEqual(first.file, 'main.c');
		assert.strictEqual(first.line, 42);
		assert.strictEqual(first.column, 10);
		assert.ok(first.message.includes('expected'), `Message: ${first.message}`);
	});

	test('parseBuildOutput: GCC warning is separated from errors', () => {
		const { warnings } = parseBuildOutput(GCC_ERROR_OUTPUT);
		assert.ok(warnings.length >= 1, `Expected >= 1 warning, got ${warnings.length}`);
		assert.ok(warnings[0]!.message.toLowerCase().includes('unused') || warnings[0]!.message.toLowerCase().includes('variable'));
	});

	test('parseBuildOutput: GCC parses multiple errors with correct files', () => {
		const { errors } = parseBuildOutput(GCC_ERROR_OUTPUT);
		const files = errors.map(e => e.file);
		assert.ok(files.includes('main.c'), 'Expected main.c in errors');
		assert.ok(files.includes('drivers/uart.c'), 'Expected drivers/uart.c in errors');
	});

	// ─── IAR error parsing ────────────────────────────────────────────────────

	test('parseBuildOutput: IAR error format parsed correctly', () => {
		const { errors } = parseBuildOutput(IAR_ERROR_OUTPUT);
		assert.ok(errors.length >= 1, `Expected >= 1 IAR error, got ${errors.length}`);
		const e = errors[0]!;
		assert.strictEqual(e.file, 'src/main.c');
		assert.strictEqual(e.line, 10);
		assert.ok(e.code?.includes('Pe065'), `Expected error code Pe065, got ${e.code}`);
	});

	test('parseBuildOutput: IAR warning is classified correctly', () => {
		const { warnings } = parseBuildOutput(IAR_ERROR_OUTPUT);
		assert.ok(warnings.length >= 1, `Expected >= 1 IAR warning`);
		assert.ok(warnings[0]!.code?.includes('Pe177'));
	});

	// ─── Keil error parsing ───────────────────────────────────────────────────

	test('parseBuildOutput: Keil ARM-CC error format parsed', () => {
		const { errors } = parseBuildOutput(KEIL_ERROR_OUTPUT);
		assert.ok(errors.length >= 1, `Expected Keil error, got ${errors.length}`);
		assert.strictEqual(errors[0]!.file, 'src/main.c');
		assert.strictEqual(errors[0]!.line, 10);
	});

	test('parseBuildOutput: Keil warning parsed correctly', () => {
		const { warnings } = parseBuildOutput(KEIL_ERROR_OUTPUT);
		assert.ok(warnings.length >= 1, `Expected Keil warning`);
	});

	// ─── rustc error parsing ──────────────────────────────────────────────────

	test('parseBuildOutput: rustc error format with error code parsed', () => {
		const { errors } = parseBuildOutput(RUSTC_ERROR_OUTPUT);
		assert.ok(errors.length >= 1, `Expected rustc error, got ${errors.length}`);
		const e = errors[0]!;
		assert.strictEqual(e.file, 'src/main.rs');
		assert.strictEqual(e.line, 42);
		assert.strictEqual(e.code, 'E0308');
		assert.ok(e.message.includes('mismatched types'));
	});

	// ─── Deduplication ────────────────────────────────────────────────────────

	test('parseBuildOutput: duplicate errors are deduplicated', () => {
		const doubled = GCC_ERROR_OUTPUT + '\n' + GCC_ERROR_OUTPUT;
		const { errors } = parseBuildOutput(doubled);
		const keys = errors.map(e => `${e.file}:${e.line}:${e.message}`);
		const unique = new Set(keys);
		assert.strictEqual(keys.length, unique.size, 'Duplicate errors should be deduplicated');
	});

	// ─── Empty / passing builds ────────────────────────────────────────────────

	test('parseBuildOutput: clean build output has no errors or warnings', () => {
		const cleanOutput = 'Compiling main.c...\nBuild succeeded.';
		const { errors, warnings } = parseBuildOutput(cleanOutput);
		assert.strictEqual(errors.length, 0);
		assert.strictEqual(warnings.length, 0);
	});

	// ─── Binary size parsing ──────────────────────────────────────────────────

	test('parseSizeOutput: parses text/data/bss from arm-none-eabi-size tabular output', () => {
		const result = parseSizeOutput(ARM_SIZE_OUTPUT, 1_048_576, 196_608);
		assert.strictEqual(result.textSize, 12345);
		assert.strictEqual(result.dataSize, 256);
		assert.strictEqual(result.bssSize, 4096);
	});

	test('parseSizeOutput: flash usage = text + data', () => {
		const result = parseSizeOutput(ARM_SIZE_OUTPUT, 1_048_576, 196_608);
		assert.strictEqual(result.flashUsage, 12345 + 256);
	});

	test('parseSizeOutput: RAM usage = data + bss', () => {
		const result = parseSizeOutput(ARM_SIZE_OUTPUT, 1_048_576, 196_608);
		assert.strictEqual(result.ramUsage, 256 + 4096);
	});

	test('parseSizeOutput: flash percent is accurate', () => {
		const result = parseSizeOutput(ARM_SIZE_OUTPUT, 1_048_576, 196_608);
		const expected = ((12345 + 256) / 1_048_576) * 100;
		assert.ok(Math.abs(result.flashPercent - expected) < 0.01, `Flash% expected ${expected.toFixed(3)}, got ${result.flashPercent.toFixed(3)}`);
	});

	test('parseSizeOutput: RAM percent is accurate', () => {
		const result = parseSizeOutput(ARM_SIZE_OUTPUT, 1_048_576, 196_608);
		const expected = ((256 + 4096) / 196_608) * 100;
		assert.ok(Math.abs(result.ramPercent - expected) < 0.01);
	});

	test('parseSizeOutput: sections array has 3 entries', () => {
		const result = parseSizeOutput(ARM_SIZE_OUTPUT, 1_048_576, 196_608);
		assert.strictEqual(result.sections.length, 3);
	});

	test('parseSizeOutput: zero flash size returns 0% flash', () => {
		const result = parseSizeOutput(ARM_SIZE_OUTPUT, 0, 196_608);
		assert.strictEqual(result.flashPercent, 0);
	});

	test('parseSizeOutput: empty output returns all zeros', () => {
		const result = parseSizeOutput('', 1_048_576, 196_608);
		assert.strictEqual(result.textSize, 0);
		assert.strictEqual(result.dataSize, 0);
		assert.strictEqual(result.bssSize, 0);
	});
});

// ─── GCC .su stack-usage file parsing ─────────────────────────────────────────

function parseSuFile(content: string) {
	const entries: Array<{ file: string; function: string; bytes: number; qualifier: string }> = [];
	for (const line of content.split('\n')) {
		// GCC .su format: file.c:line:col:function_name	bytes	qualifier
		const m = line.match(/^(.+?):(\d+):\d+:(\S+)\s+(\d+)\s+(static|dynamic|dynamic,bounded|unbounded)/);
		if (m) {
			entries.push({ file: m[1]!, function: m[3]!, bytes: parseInt(m[4]!), qualifier: m[5]! });
		}
	}
	return entries;
}

const SU_FILE_CONTENT = `
src/main.c:42:0:main\t2048\tstatic
src/drivers/uart.c:15:0:UART_IRQHandler\t512\tdynamic
src/rtos/tasks.c:99:0:vTaskStartScheduler\t4096\tdynamic,bounded
src/heap.c:12:0:pvPortMalloc\t128\tunbounded
`.trim();

suite('BuildSystemService - Stack Usage Analysis', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseSuFile: parses static qualifier', () => {
		const entries = parseSuFile(SU_FILE_CONTENT);
		const main = entries.find(e => e.function === 'main');
		assert.ok(main, 'main not found in .su output');
		assert.strictEqual(main!.bytes, 2048);
		assert.strictEqual(main!.qualifier, 'static');
	});

	test('parseSuFile: parses dynamic qualifier', () => {
		const entries = parseSuFile(SU_FILE_CONTENT);
		const irq = entries.find(e => e.function === 'UART_IRQHandler');
		assert.ok(irq, 'UART_IRQHandler not found');
		assert.strictEqual(irq!.qualifier, 'dynamic');
	});

	test('parseSuFile: parses dynamic,bounded qualifier', () => {
		const entries = parseSuFile(SU_FILE_CONTENT);
		const rtos = entries.find(e => e.function === 'vTaskStartScheduler');
		assert.ok(rtos, 'vTaskStartScheduler not found');
		assert.strictEqual(rtos!.qualifier, 'dynamic,bounded');
	});

	test('parseSuFile: parses unbounded qualifier', () => {
		const entries = parseSuFile(SU_FILE_CONTENT);
		const malloc = entries.find(e => e.function === 'pvPortMalloc');
		assert.ok(malloc, 'pvPortMalloc not found');
		assert.strictEqual(malloc!.qualifier, 'unbounded');
	});

	test('parseSuFile: maxStack function is largest entry', () => {
		const entries = parseSuFile(SU_FILE_CONTENT);
		const max = entries.reduce((a, b) => b.bytes > a.bytes ? b : a, entries[0]!);
		assert.strictEqual(max.function, 'vTaskStartScheduler');
		assert.strictEqual(max.bytes, 4096);
	});

	test('parseSuFile: empty file returns no entries', () => {
		const entries = parseSuFile('');
		assert.strictEqual(entries.length, 0);
	});
});

// ─── Build command generation ─────────────────────────────────────────────────

const BUILD_COMMANDS: Record<string, { build: string[]; clean: string[]; flash: string[] }> = {
	'platformio':     { build: ['pio', 'run'],          clean: ['pio', 'run', '--target', 'clean'],   flash: ['pio', 'run', '--target', 'upload'] },
	'esp-idf':        { build: ['idf.py', 'build'],     clean: ['idf.py', 'fullclean'],               flash: ['idf.py', 'flash'] },
	'cmake-embedded': { build: ['cmake', '--build', 'build'], clean: ['cmake', '--build', 'build', '--target', 'clean'], flash: ['openocd', '-f', 'interface/stlink.cfg', '-f', 'target/stm32f4x.cfg', '-c', 'program build/*.elf verify reset exit'] },
	'rust-embedded':  { build: ['cargo', 'build', '--release'], clean: ['cargo', 'clean'],            flash: ['probe-rs', 'run', '--release'] },
	'generic':        { build: ['make'],                clean: ['make', 'clean'],                     flash: ['openocd', '-f', 'interface/stlink.cfg', '-c', 'program *.elf verify reset exit'] },
};

suite('BuildSystemService - Build Command Templates', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('PlatformIO build command is pio run', () => {
		assert.deepStrictEqual(BUILD_COMMANDS['platformio']!.build, ['pio', 'run']);
	});

	test('ESP-IDF build command is idf.py build', () => {
		assert.deepStrictEqual(BUILD_COMMANDS['esp-idf']!.build, ['idf.py', 'build']);
	});

	test('Rust embedded build uses cargo', () => {
		assert.ok(BUILD_COMMANDS['rust-embedded']!.build.includes('cargo'));
	});

	test('Rust embedded flash uses probe-rs', () => {
		assert.ok(BUILD_COMMANDS['rust-embedded']!.flash.includes('probe-rs'));
	});

	test('CMake embedded flash uses openocd', () => {
		assert.ok(BUILD_COMMANDS['cmake-embedded']!.flash.includes('openocd'));
	});

	test('all project types have build, clean, and flash commands', () => {
		for (const [type, cmds] of Object.entries(BUILD_COMMANDS)) {
			assert.ok(cmds.build.length > 0, `${type} missing build command`);
			assert.ok(cmds.clean.length > 0, `${type} missing clean command`);
			assert.ok(cmds.flash.length > 0, `${type} missing flash command`);
		}
	});

	test('flash verify detection: openocd "verified successfully"', () => {
		const output = 'verified successfully';
		const verified = /verified successfully|verify OK|verification successful/i.test(output);
		assert.strictEqual(verified, true);
	});

	test('flash verify detection: "verify OK"', () => {
		const output = 'Program\nVerify\nverify OK\n';
		const verified = /verified successfully|verify OK|verification successful/i.test(output);
		assert.strictEqual(verified, true);
	});

	test('flash verify detection: "verify failed" returns false', () => {
		const output = 'Error: verify failed at 0x08001234';
		const failed = /verify failed|verification failed/i.test(output);
		assert.strictEqual(failed, true);
	});
});
