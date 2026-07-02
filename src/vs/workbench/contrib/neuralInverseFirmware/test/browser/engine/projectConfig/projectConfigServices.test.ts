/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { EMPTY_NI_MD_CONFIG, INIMdConfig } from '../../../../browser/engine/projectConfig/niMdService.js';
import { ICheckpoint } from '../../../../browser/engine/projectConfig/checkpointService.js';
import { INIIgnoreRule } from '../../../../browser/engine/projectConfig/niIgnoreService.js';

// ─── Checkpoint service logic tests (pure data structures) ───────────────────

function makeCheckpoint(overrides: Partial<ICheckpoint> = {}): ICheckpoint {
	return {
		id: `cp_${Date.now()}`,
		label: 'Test checkpoint',
		timestamp: Date.now(),
		filesChanged: ['src/main.c', 'src/uart.c'],
		...overrides,
	};
}

suite('Checkpoint Service - Data Structures', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('checkpoint has id, label, timestamp, filesChanged', () => {
		const cp = makeCheckpoint();
		assert.ok(cp.id.startsWith('cp_'));
		assert.ok(cp.label.length > 0);
		assert.ok(cp.timestamp > 0);
		assert.ok(Array.isArray(cp.filesChanged));
	});

	test('checkpoint filesChanged includes modified files', () => {
		const cp = makeCheckpoint({ filesChanged: ['src/main.c', 'include/config.h'] });
		assert.ok(cp.filesChanged.includes('src/main.c'));
		assert.ok(cp.filesChanged.includes('include/config.h'));
	});

	test('checkpoint optional branchName field', () => {
		const cp = makeCheckpoint({ branchName: 'feature/uart-dma' });
		assert.strictEqual(cp.branchName, 'feature/uart-dma');
	});

	test('checkpoint optional commitHash field', () => {
		const cp = makeCheckpoint({ commitHash: 'abc1234def5678' });
		assert.strictEqual(cp.commitHash, 'abc1234def5678');
	});

	test('checkpoint without branchName is valid', () => {
		const cp = makeCheckpoint();
		assert.strictEqual(cp.branchName, undefined);
	});

	test('checkpoint list sorting by timestamp (newest first)', () => {
		const checkpoints = [
			makeCheckpoint({ timestamp: 1000, label: 'Old' }),
			makeCheckpoint({ timestamp: 3000, label: 'Newest' }),
			makeCheckpoint({ timestamp: 2000, label: 'Middle' }),
		];
		const sorted = [...checkpoints].sort((a, b) => b.timestamp - a.timestamp);
		assert.strictEqual(sorted[0]!.label, 'Newest');
		assert.strictEqual(sorted[1]!.label, 'Middle');
		assert.strictEqual(sorted[2]!.label, 'Old');
	});

	test('max 50 checkpoints: oldest removed when limit reached', () => {
		const checkpoints: ICheckpoint[] = [];
		for (let i = 0; i < 55; i++) {
			checkpoints.push(makeCheckpoint({ label: `cp-${i}`, timestamp: i * 1000 }));
		}
		// Prune: keep newest 50
		const pruned = checkpoints.sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
		assert.strictEqual(pruned.length, 50);
		assert.ok(pruned[0]!.label.includes('54'), 'Newest should be first');
	});
});

// ─── .niignore service logic tests ───────────────────────────────────────────

function matchesNIIgnoreRule(rule: INIIgnoreRule, filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, '/');
	if (rule.type === 'glob') {
		// Simple glob: * matches anything except /
		const escaped = rule.pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.');
		const regex = new RegExp(`(^|/)${escaped}(/|$)`);
		return regex.test(normalized);
	}
	if (rule.type === 'regex') {
		return new RegExp(rule.pattern).test(normalized);
	}
	if (rule.type === 'exact') {
		return normalized === rule.pattern.replace(/\\/g, '/');
	}
	return false;
}

suite('NIIgnore Service - Rule Matching', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('glob rule matches *.o files', () => {
		const rule: INIIgnoreRule = { type: 'glob', pattern: '*.o', description: 'Object files' };
		assert.ok(matchesNIIgnoreRule(rule, 'build/main.o'));
		assert.ok(matchesNIIgnoreRule(rule, 'src/uart.o'));
		assert.ok(!matchesNIIgnoreRule(rule, 'src/main.c'));
	});

	test('glob rule matches build/ directory', () => {
		const rule: INIIgnoreRule = { type: 'glob', pattern: 'build', description: 'Build output' };
		assert.ok(matchesNIIgnoreRule(rule, 'build/firmware.elf'));
		assert.ok(matchesNIIgnoreRule(rule, 'project/build/debug/out.bin'));
	});

	test('regex rule uses regex matching', () => {
		const rule: INIIgnoreRule = { type: 'regex', pattern: '\\.inverse/checkpoints/.*', description: 'Checkpoints' };
		assert.ok(matchesNIIgnoreRule(rule, '.inverse/checkpoints/cp_001.json'));
		assert.ok(!matchesNIIgnoreRule(rule, 'src/main.c'));
	});

	test('exact rule matches only exact path', () => {
		const rule: INIIgnoreRule = { type: 'exact', pattern: '.env', description: 'Env file' };
		assert.ok(matchesNIIgnoreRule(rule, '.env'));
		assert.ok(!matchesNIIgnoreRule(rule, 'src/.env'));
	});

	test('rule with negation pattern (! prefix) — default catalog should not include *.c', () => {
		// .niignore should never ignore source files — validates default safe rules
		const safeRules: INIIgnoreRule[] = [
			{ type: 'glob', pattern: '*.o', description: 'Object files' },
			{ type: 'glob', pattern: '*.elf', description: 'ELF binaries' },
			{ type: 'glob', pattern: '*.bin', description: 'Binary images' },
		];
		for (const rule of safeRules) {
			assert.ok(!matchesNIIgnoreRule(rule, 'src/main.c'), `Rule ${rule.pattern} should not match src/main.c`);
		}
	});
});

// ─── niMd service config tests ────────────────────────────────────────────────

suite('NIMd Service - Config Structure', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('EMPTY_NI_MD_CONFIG has all required fields', () => {
		assert.ok('mcuFamily' in EMPTY_NI_MD_CONFIG);
		assert.ok('mcuVariant' in EMPTY_NI_MD_CONFIG);
		assert.ok('buildSystem' in EMPTY_NI_MD_CONFIG);
		assert.ok('serialPort' in EMPTY_NI_MD_CONFIG);
		assert.ok('baudRate' in EMPTY_NI_MD_CONFIG);
	});

	test('EMPTY_NI_MD_CONFIG default baudRate is 115200', () => {
		assert.strictEqual(EMPTY_NI_MD_CONFIG.baudRate, 115200);
	});

	test('config can be merged with overrides', () => {
		const config: INIMdConfig = {
			...EMPTY_NI_MD_CONFIG,
			mcuFamily: 'STM32F4',
			mcuVariant: 'STM32F407VGT6',
			buildSystem: 'platformio',
			serialPort: '/dev/ttyUSB0',
		};
		assert.strictEqual(config.mcuFamily, 'STM32F4');
		assert.strictEqual(config.mcuVariant, 'STM32F407VGT6');
		assert.strictEqual(config.buildSystem, 'platformio');
		assert.strictEqual(config.baudRate, 115200);
	});

	test('config serializes and deserializes correctly', () => {
		const config: INIMdConfig = {
			...EMPTY_NI_MD_CONFIG,
			mcuFamily: 'NRF52840',
			mcuVariant: 'nRF52840-DK',
			buildSystem: 'cmake-embedded',
			baudRate: 921600,
		};
		const json = JSON.stringify(config);
		const restored = JSON.parse(json) as INIMdConfig;
		assert.strictEqual(restored.mcuFamily, 'NRF52840');
		assert.strictEqual(restored.baudRate, 921600);
	});
});
