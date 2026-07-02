/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildFirmwareContext } from '../../../../browser/engine/hardwareContext/hardwareContextProvider.js';
import { IPeripheralRegisterMap } from '../../../../browser/common/firmwareTypes.js';

const USART1_MAP: IPeripheralRegisterMap = {
	name: 'USART1',
	groupName: 'USART',
	baseAddress: 0x40011000,
	description: 'UART',
	registers: [
		{ name: 'CR1', addressOffset: 0x0C, size: 32, access: 'read-write', resetValue: 0, description: '', fields: [
			{ name: 'UE', bitOffset: 13, bitWidth: 1, access: 'read-write', description: 'USART enable' },
		]},
	],
	interrupts: [{ name: 'USART1_IRQn', value: 37, description: '' }],
};

function makeMockSessionService(overrides: {
	isActive?: boolean;
	family?: string;
	variant?: string;
	registerMaps?: IPeripheralRegisterMap[];
	activePeripheral?: string;
	rtos?: string;
	complianceFrameworks?: string[];
	errata?: any[];
} = {}) {
	return {
		session: {
			isActive: overrides.isActive ?? true,
			mcuConfig: {
				family: overrides.family ?? 'STM32F4',
				variant: overrides.variant ?? 'STM32F407VGT6',
				core: 'Cortex-M4',
				clockMHz: 168,
				manufacturer: 'STMicroelectronics',
				flashSize: 1_048_576,
				ramSize: 196608,
				fpu: 'fpv4-sp-d16',
				hasMPU: true,
				hasDSP: true,
				memoryMap: [
					{ name: 'FLASH', baseAddress: 0x08000000, size: 1_048_576, access: 'rx' },
					{ name: 'SRAM1', baseAddress: 0x20000000, size: 131072, access: 'rw' },
				],
			},
			rtos: overrides.rtos,
			boardName: undefined,
			buildSystem: 'platformio',
			complianceFrameworks: overrides.complianceFrameworks ?? [],
			registerMaps: overrides.registerMaps ?? [USART1_MAP],
			activePeripheral: overrides.activePeripheral,
			datasheets: [],
			lastSerialConfig: undefined,
			serialWasConnected: false,
		},
		getPeripheralRegisterMap: (name: string) => (overrides.registerMaps ?? [USART1_MAP]).find(m => m.name === name),
		getErrataForPeripheral: (_name: string) => overrides.errata ?? [],
		getTimingForPeripheral: (_name: string) => [],
	};
}

suite('Hardware Context Provider - buildFirmwareContext', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('returns undefined when session is not active', () => {
		const svc = makeMockSessionService({ isActive: false });
		const ctx = buildFirmwareContext(svc as any);
		assert.strictEqual(ctx, undefined);
	});

	test('returns string when session is active', () => {
		const svc = makeMockSessionService();
		const ctx = buildFirmwareContext(svc as any);
		assert.ok(typeof ctx === 'string');
		assert.ok(ctx.length > 0);
	});

	test('context includes MCU family and variant', () => {
		const svc = makeMockSessionService({ family: 'STM32F4', variant: 'STM32F407VGT6' });
		const ctx = buildFirmwareContext(svc as any)!;
		assert.ok(ctx.includes('STM32F4') || ctx.includes('STM32F407VGT6'), `Context: ${ctx.slice(0, 300)}`);
	});

	test('context includes clock speed', () => {
		const svc = makeMockSessionService();
		const ctx = buildFirmwareContext(svc as any)!;
		assert.ok(ctx.includes('168') || ctx.includes('168MHz'), `Context: ${ctx.slice(0, 300)}`);
	});

	test('context includes peripheral list when register maps are loaded', () => {
		const svc = makeMockSessionService({ registerMaps: [USART1_MAP] });
		const ctx = buildFirmwareContext(svc as any)!;
		assert.ok(ctx.includes('USART1'), `Expected USART1 in context: ${ctx.slice(0, 400)}`);
	});

	test('context includes RTOS when set', () => {
		const svc = makeMockSessionService({ rtos: 'FreeRTOS' });
		const ctx = buildFirmwareContext(svc as any)!;
		assert.ok(ctx.includes('FreeRTOS') || ctx.includes('RTOS'), `Context: ${ctx.slice(0, 400)}`);
	});

	test('context includes compliance frameworks when set', () => {
		const svc = makeMockSessionService({ complianceFrameworks: ['misra-c-2012'] });
		const ctx = buildFirmwareContext(svc as any)!;
		assert.ok(ctx.includes('misra') || ctx.includes('MISRA') || ctx.includes('Compliance'), `Context: ${ctx.slice(0, 400)}`);
	});

	test('context includes active firmware session header', () => {
		const svc = makeMockSessionService();
		const ctx = buildFirmwareContext(svc as any)!;
		assert.ok(ctx.includes('Firmware Session') || ctx.includes('MCU'), `Context: ${ctx.slice(0, 300)}`);
	});

	test('context includes memory map regions', () => {
		const svc = makeMockSessionService();
		const ctx = buildFirmwareContext(svc as any)!;
		assert.ok(ctx.includes('FLASH') || ctx.includes('SRAM') || ctx.includes('Memory'), `Context: ${ctx.slice(0, 400)}`);
	});

	test('context includes errata warning when active peripheral has errata', () => {
		const svc = makeMockSessionService({
			activePeripheral: 'USART1',
			errata: [
				{ id: 'ES_STM32F4_2.5.1', title: 'USART idle line detection issue', severity: 'medium', workaround: 'Add software timeout' },
			],
		});
		const ctx = buildFirmwareContext(svc as any)!;
		assert.ok(ctx.includes('errata') || ctx.includes('ES_STM32F4') || ctx.includes('⚠'), `Context: ${ctx.slice(0, 500)}`);
	});

	test('context with niMd service includes project config section', () => {
		const svc = makeMockSessionService();
		const niMdSvc = {
			getSystemPromptSection: () => 'Project config: STM32F4 / PlatformIO / UART at 115200\n',
		};
		const ctx = buildFirmwareContext(svc as any, niMdSvc as any)!;
		assert.ok(ctx.includes('PlatformIO') || ctx.includes('Project config'), `Context: ${ctx.slice(0, 400)}`);
	});

	test('context with peripheral catalog service includes attached peripherals', () => {
		const svc = makeMockSessionService();
		const catalogSvc = {
			getSystemPromptSection: () => 'Connected peripherals:\n  MPU-6050 (TDK) — IMU via I2C\n',
		};
		const ctx = buildFirmwareContext(svc as any, undefined, catalogSvc as any)!;
		assert.ok(ctx.includes('MPU-6050') || ctx.includes('peripherals'), `Context: ${ctx.slice(0, 500)}`);
	});
});
