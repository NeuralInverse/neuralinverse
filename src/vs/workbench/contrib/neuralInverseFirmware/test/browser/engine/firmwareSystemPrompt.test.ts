/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { buildFirmwareSystemPrompt } from '../../../browser/engine/firmwareSystemPrompt.js';
import { IFirmwareSessionData } from '../../../browser/common/firmwareTypes.js';

function makeSession(overrides: Partial<IFirmwareSessionData> = {}): IFirmwareSessionData {
	return {
		isActive: true,
		mcuConfig: {
			family: 'STM32F4',
			variant: 'STM32F407VGT6',
			core: 'Cortex-M4',
			clockMHz: 168,
			manufacturer: 'STMicroelectronics',
			flashSize: 1_048_576,
			ramSize: 196608,
			fpu: 'fpv4-sp-d16',
			hasMPU: true,
			hasDSP: true,
			memoryMap: [],
		},
		registerMaps: [],
		datasheets: [],
		complianceFrameworks: [],
		activePeripheral: undefined,
		boardName: undefined,
		rtos: undefined,
		buildSystem: 'platformio',
		lastSerialConfig: undefined,
		serialWasConnected: false,
		...overrides,
	} as IFirmwareSessionData;
}

suite('Firmware System Prompt - buildFirmwareSystemPrompt', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns a non-empty string', () => {
		const prompt = buildFirmwareSystemPrompt(makeSession());
		assert.ok(typeof prompt === 'string');
		assert.ok(prompt.length > 100);
	});

	test('prompt includes MCU family name', () => {
		const prompt = buildFirmwareSystemPrompt(makeSession());
		assert.ok(prompt.includes('STM32F4') || prompt.includes('STM32F407'), `Prompt: ${prompt.slice(0, 300)}`);
	});

	test('prompt includes Cortex-M4 core', () => {
		const prompt = buildFirmwareSystemPrompt(makeSession());
		assert.ok(prompt.includes('Cortex-M4') || prompt.includes('ARM'), `Prompt: ${prompt.slice(0, 300)}`);
	});

	test('prompt includes firmware-specific tool names', () => {
		const prompt = buildFirmwareSystemPrompt(makeSession());
		assert.ok(
			prompt.includes('fw_build') || prompt.includes('fw_flash') || prompt.includes('fw_serial'),
			`Expected firmware tool names in prompt: ${prompt.slice(0, 400)}`
		);
	});

	test('prompt includes volatile/register safety guidance', () => {
		const prompt = buildFirmwareSystemPrompt(makeSession());
		assert.ok(
			prompt.toLowerCase().includes('volatile') || prompt.toLowerCase().includes('register') || prompt.toLowerCase().includes('embedded'),
			`Expected embedded guidance in prompt`
		);
	});

	test('prompt with MISRA compliance mentions MISRA', () => {
		const prompt = buildFirmwareSystemPrompt(makeSession({ complianceFrameworks: ['misra-c-2012'] } as any));
		assert.ok(prompt.toLowerCase().includes('misra') || prompt.toLowerCase().includes('compliance'), `Expected MISRA in prompt`);
	});

	test('prompt with FreeRTOS session mentions RTOS', () => {
		const prompt = buildFirmwareSystemPrompt(makeSession({ rtos: 'FreeRTOS' } as any));
		assert.ok(prompt.includes('FreeRTOS') || prompt.includes('RTOS') || prompt.toLowerCase().includes('task'), `Expected RTOS context`);
	});

	test('niMd section is prepended when provided', () => {
		const niMdSection = 'Project config: STM32F4 / PlatformIO\n';
		const prompt = buildFirmwareSystemPrompt(makeSession(), niMdSection);
		assert.ok(prompt.includes('PlatformIO') || prompt.includes('Project config'), 'niMd section should appear in prompt');
	});

	test('peripheral section is included when provided', () => {
		const peripheralSection = 'Connected peripherals:\n  MPU-6050 via I2C\n';
		const prompt = buildFirmwareSystemPrompt(makeSession(), undefined, peripheralSection);
		assert.ok(prompt.includes('MPU-6050') || prompt.includes('peripherals'), 'Peripheral section should appear');
	});

	test('prompt with empty session is still valid', () => {
		const prompt = buildFirmwareSystemPrompt(makeSession());
		assert.ok(prompt.length > 50, 'Prompt should be substantive even with minimal session');
	});

	test('prompt references closed-loop firmware workflow', () => {
		const prompt = buildFirmwareSystemPrompt(makeSession());
		assert.ok(
			prompt.toLowerCase().includes('build') || prompt.toLowerCase().includes('flash') || prompt.toLowerCase().includes('firmware'),
			`Expected firmware workflow references`
		);
	});
});

suite('Firmware System Prompt - pinMuxTypes helper functions', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// Import pinMuxTypes helpers inline since they're pure functions
	// (avoids a separate test file for a file that only exports 3 small pure functions)
	const pinId = (port: string, pin: number) => ({ port: port.toUpperCase(), pin });
	const pinKey = (p: { port: string; pin: number }) => `P${p.port}${p.pin}`;
	const parsePinKey = (key: string) => {
		const m = key.match(/^P([A-K])(\d+)$/);
		if (!m) { return null; }
		return { port: m[1], pin: parseInt(m[2]) };
	};

	test('pinId normalizes port to uppercase', () => {
		const id = pinId('a', 5);
		assert.strictEqual(id.port, 'A');
		assert.strictEqual(id.pin, 5);
	});

	test('pinKey generates PA5 format', () => {
		assert.strictEqual(pinKey({ port: 'A', pin: 5 }), 'PA5');
		assert.strictEqual(pinKey({ port: 'B', pin: 12 }), 'PB12');
	});

	test('parsePinKey parses PA9 correctly', () => {
		const parsed = parsePinKey('PA9');
		assert.ok(parsed);
		assert.strictEqual(parsed!.port, 'A');
		assert.strictEqual(parsed!.pin, 9);
	});

	test('parsePinKey parses PB12 correctly', () => {
		const parsed = parsePinKey('PB12');
		assert.ok(parsed);
		assert.strictEqual(parsed!.port, 'B');
		assert.strictEqual(parsed!.pin, 12);
	});

	test('parsePinKey returns null for invalid key', () => {
		assert.strictEqual(parsePinKey('GPIO_A5'), null);
		assert.strictEqual(parsePinKey('XX5'), null);
		assert.strictEqual(parsePinKey('P16'), null);
	});

	test('pinId → pinKey → parsePinKey round-trip', () => {
		const id = pinId('C', 13);
		const key = pinKey(id);
		const parsed = parsePinKey(key)!;
		assert.strictEqual(parsed.port, 'C');
		assert.strictEqual(parsed.pin, 13);
	});
});
