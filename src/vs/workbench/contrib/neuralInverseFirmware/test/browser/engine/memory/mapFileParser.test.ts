/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { parseMapFile, groupSectionsForChart, findMapFileCandidates } from '../../../../browser/engine/memory/mapFileParser.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const GNU_LD_MAP = `
Archive member included to satisfy reference by file (symbol)

Linker script and memory map

Memory Configuration

Name             Origin             Length             Attributes
FLASH            0x0000000008000000 0x0000000000100000 xr
RAM              0x0000000020000000 0x0000000000020000 xrw

Linker script and memory map

.text           0x0000000008000188     0x3e98
 .text          0x0000000008000188      0xdc ./build/main.o
 .text          0x0000000008000264      0xa8 ./build/usart.o

.rodata         0x0000000008003fe8      0x410

.data           0x0000000020000000      0x100

.bss            0x0000000020000100     0x4000

._user_heap_stack 0x0000000020004100      0x600
`.trim();

const GNU_LD_MAP_NO_MEM_CONFIG = `
.text           0x0000000008000188     0x3e98
.rodata         0x0000000008003fe8      0x410
.data           0x0000000020000000      0x100
.bss            0x0000000020000100     0x4000
`.trim();

const KEIL_MAP = `
    .text             0x08000188  Code  16024
    .rodata           0x08003fe8  Data  1040
    .data             0x20000000  Data  256
    .bss              0x20000100  Data  16384
`.trim();

suite('MapFileParser - GNU ld format', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseMapFile: identifies FLASH and RAM regions from Memory Configuration', () => {
		const result = parseMapFile(GNU_LD_MAP);
		const regionNames = result.regions.map(r => r.name);
		assert.ok(regionNames.includes('FLASH'), `Expected FLASH in regions: ${regionNames}`);
		assert.ok(regionNames.includes('RAM'), `Expected RAM in regions: ${regionNames}`);
	});

	test('parseMapFile: FLASH size is 1MB (0x100000)', () => {
		const result = parseMapFile(GNU_LD_MAP);
		const flash = result.regions.find(r => r.name === 'FLASH')!;
		assert.strictEqual(flash.size, 0x100000);
	});

	test('parseMapFile: RAM size is 128KB (0x20000)', () => {
		const result = parseMapFile(GNU_LD_MAP);
		const ram = result.regions.find(r => r.name === 'RAM')!;
		assert.strictEqual(ram.size, 0x20000);
	});

	test('parseMapFile: totalFlashUsed = text + rodata', () => {
		const result = parseMapFile(GNU_LD_MAP);
		assert.ok(result.totalFlashUsed > 0, 'Flash used should be > 0');
		assert.ok(result.totalFlashUsed <= 0x100000, 'Flash used should be <= flash size');
	});

	test('parseMapFile: totalRAMUsed = data + bss + heap+stack', () => {
		const result = parseMapFile(GNU_LD_MAP);
		assert.ok(result.totalRAMUsed > 0, 'RAM used should be > 0');
		assert.ok(result.totalRAMUsed <= 0x20000, 'RAM used should be <= RAM size');
	});

	test('parseMapFile: flashPercent is calculated correctly', () => {
		const result = parseMapFile(GNU_LD_MAP);
		const flash = result.regions.find(r => r.name === 'FLASH')!;
		const expectedPct = Math.round(flash.used / flash.size * 100);
		assert.strictEqual(flash.usagePercent, expectedPct);
	});

	test('parseMapFile: .text section is included in flash region sections', () => {
		const result = parseMapFile(GNU_LD_MAP);
		const flash = result.regions.find(r => r.name === 'FLASH')!;
		const textSec = flash.sections.find(s => s.name === '.text');
		assert.ok(textSec, 'Expected .text section in FLASH');
		assert.strictEqual(textSec!.size, 0x3e98);
	});

	test('parseMapFile: .bss section is in RAM', () => {
		const result = parseMapFile(GNU_LD_MAP);
		const ram = result.regions.find(r => r.name === 'RAM')!;
		const bssSec = ram.sections.find(s => s.name === '.bss');
		assert.ok(bssSec, 'Expected .bss in RAM');
	});

	test('parseMapFile: stackOverflowRisk is safe when RAM < 80%', () => {
		const result = parseMapFile(GNU_LD_MAP);
		assert.ok(['safe', 'tight', 'unknown'].includes(result.stackOverflowRisk), `Got: ${result.stackOverflowRisk}`);
	});

	test('parseMapFile: high RAM usage triggers warning', () => {
		const criticalMap = `
Memory Configuration
Name   Origin             Length   Attributes
FLASH  0x0000000008000000 0x100000 xr
RAM    0x0000000020000000 0x0005000 xrw

.text  0x0000000008000000 0x001000
.data  0x0000000020000000 0x000100
.bss   0x0000000020000100 0x004800
`;
		const result = parseMapFile(criticalMap);
		assert.ok(result.warnings.some(w => w.toLowerCase().includes('ram') || w.toLowerCase().includes('stack')));
	});

	test('parseMapFile: fallback to MCU flash/RAM when no Memory Configuration', () => {
		const result = parseMapFile(GNU_LD_MAP_NO_MEM_CONFIG, 1_048_576, 131072);
		assert.strictEqual(result.totalFlashAvailable, 1_048_576);
		assert.strictEqual(result.totalRAMAvailable, 131072);
	});

	test('parseMapFile: empty map returns zeros', () => {
		const result = parseMapFile('');
		assert.strictEqual(result.totalFlashUsed, 0);
		assert.strictEqual(result.totalRAMUsed, 0);
	});
});

suite('MapFileParser - groupSectionsForChart', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('groups .text, .rodata, .data, .bss correctly', () => {
		const sections = [
			{ name: '.text', size: 16000, address: 0x08000000 },
			{ name: '.rodata', size: 4000, address: 0x08004000 },
			{ name: '.data', size: 256, address: 0x20000000 },
			{ name: '.bss', size: 8192, address: 0x20000100 },
		];
		const groups = groupSectionsForChart(sections);
		const names = groups.map(g => g.label);
		assert.ok(names.includes('.text'), `.text expected in groups: ${names}`);
		assert.ok(names.includes('.rodata'));
		assert.ok(names.includes('.data'));
		assert.ok(names.includes('.bss'));
	});

	test('sums sizes for duplicate categories', () => {
		const sections = [
			{ name: '.text', size: 10000, address: 0x08000000 },
			{ name: '.init', size: 500, address: 0x08003000 },   // also .text category
			{ name: '.bss', size: 4096, address: 0x20000000 },
		];
		const groups = groupSectionsForChart(sections);
		const textGroup = groups.find(g => g.label === '.text')!;
		assert.strictEqual(textGroup.size, 10500);
	});

	test('categorizes unknown sections as "other"', () => {
		const sections = [
			{ name: '.note.gnu.build-id', size: 36, address: 0x08000000 },
		];
		const groups = groupSectionsForChart(sections);
		const other = groups.find(g => g.label === 'other');
		assert.ok(other, 'Unknown section should map to "other"');
		assert.strictEqual(other!.size, 36);
	});

	test('filters out zero-size sections', () => {
		const sections = [
			{ name: '.text', size: 0, address: 0x08000000 },
		];
		const groups = groupSectionsForChart(sections);
		assert.strictEqual(groups.length, 0);
	});
});

suite('MapFileParser - findMapFileCandidates', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns only .map files', () => {
		const files = ['build/firmware.map', 'src/main.c', 'build/firmware.elf', 'other.map'];
		const candidates = findMapFileCandidates(files);
		assert.ok(candidates.every(f => f.endsWith('.map')));
	});

	test('prefers build/ directory files', () => {
		const files = ['firmware.map', 'build/output/firmware.map'];
		const candidates = findMapFileCandidates(files);
		assert.strictEqual(candidates[0], 'build/output/firmware.map');
	});

	test('returns empty array when no .map files', () => {
		const files = ['src/main.c', 'CMakeLists.txt', 'README.md'];
		const candidates = findMapFileCandidates(files);
		assert.deepStrictEqual(candidates, []);
	});

	test('Debug/ and Release/ directory files are preferred', () => {
		const files = ['firmware.map', 'Debug/firmware.map'];
		const candidates = findMapFileCandidates(files);
		assert.strictEqual(candidates[0], 'Debug/firmware.map');
	});
});
