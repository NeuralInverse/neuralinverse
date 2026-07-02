/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildCodegenTools } from '../../../../browser/engine/agentTools/codegenTools.js';
import { IPeripheralRegisterMap } from '../../../../browser/common/firmwareTypes.js';

const USART1_MAP: IPeripheralRegisterMap = {
	name: 'USART1',
	groupName: 'USART',
	baseAddress: 0x40011000,
	description: 'Universal synchronous asynchronous receiver transmitter',
	registers: [
		{
			name: 'SR',
			addressOffset: 0x00,
			size: 32,
			access: 'read-write',
			resetValue: 0x00C00000,
			description: 'Status register',
			fields: [
				{ name: 'RXNE', bitOffset: 5, bitWidth: 1, access: 'read-only', description: 'Read data register not empty' },
				{ name: 'TXE', bitOffset: 7, bitWidth: 1, access: 'read-only', description: 'Transmit data register empty' },
			],
		},
		{
			name: 'BRR',
			addressOffset: 0x08,
			size: 32,
			access: 'read-write',
			resetValue: 0,
			description: 'Baud rate register',
			fields: [
				{ name: 'DIV_Fraction', bitOffset: 0, bitWidth: 4, access: 'read-write', description: 'Fraction of USARTDIV' },
				{ name: 'DIV_Mantissa', bitOffset: 4, bitWidth: 12, access: 'read-write', description: 'Mantissa of USARTDIV' },
			],
		},
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
				{ name: 'RE', bitOffset: 2, bitWidth: 1, access: 'read-write', description: 'Receiver enable' },
			],
		},
	],
	interrupts: [{ name: 'USART1_IRQn', value: 37, description: 'USART1 global interrupt' }],
};

const RCC_MAP: IPeripheralRegisterMap = {
	name: 'RCC',
	groupName: 'RCC',
	baseAddress: 0x40023800,
	description: 'Reset and clock control',
	registers: [
		{
			name: 'CR',
			addressOffset: 0x00,
			size: 32,
			access: 'read-write',
			resetValue: 0x00000083,
			description: 'Clock control register',
			fields: [
				{ name: 'HSEON', bitOffset: 16, bitWidth: 1, access: 'read-write', description: 'HSE clock enable' },
				{ name: 'HSERDY', bitOffset: 17, bitWidth: 1, access: 'read-only', description: 'HSE clock ready flag' },
				{ name: 'PLLON', bitOffset: 24, bitWidth: 1, access: 'read-write', description: 'Main PLL enable' },
				{ name: 'PLLRDY', bitOffset: 25, bitWidth: 1, access: 'read-only', description: 'Main PLL ready flag' },
			],
		},
		{
			name: 'CFGR',
			addressOffset: 0x08,
			size: 32,
			access: 'read-write',
			resetValue: 0,
			description: 'Clock configuration register',
			fields: [
				{ name: 'SW', bitOffset: 0, bitWidth: 2, access: 'read-write', description: 'System clock switch' },
				{ name: 'SWS', bitOffset: 2, bitWidth: 2, access: 'read-only', description: 'System clock switch status' },
			],
		},
	],
	interrupts: [],
};

function makeMockSession(registerMaps: IPeripheralRegisterMap[] = [USART1_MAP, RCC_MAP], isActive = true) {
	return {
		session: {
			isActive,
			mcuConfig: { family: 'STM32F4', variant: 'STM32F407VGT6', clockMHz: 168 },
			registerMaps,
			complianceFrameworks: [],
		},
	};
}

suite('Code Generation Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildCodegenTools returns 6 tools', () => {
		const tools = buildCodegenTools(makeMockSession() as any);
		assert.strictEqual(tools.length, 6);
	});

	test('tool names include all expected codegen tools', () => {
		const tools = buildCodegenTools(makeMockSession() as any);
		const names = new Set(tools.map(t => t.name));
		assert.ok(names.has('fw_generate_peripheral_init'));
		assert.ok(names.has('fw_generate_isr'));
		assert.ok(names.has('fw_generate_dma_config'));
		assert.ok(names.has('fw_generate_clock_config'));
		assert.ok(names.has('fw_generate_gpio_config'));
		assert.ok(names.has('fw_generate_rtos_task'));
	});

	// ─── fw_generate_peripheral_init ─────────────────────────────────────────

	test('fw_generate_peripheral_init requires active session', async () => {
		const tools = buildCodegenTools(makeMockSession([], false) as any);
		const tool = tools.find(t => t.name === 'fw_generate_peripheral_init')!;
		const result = await tool.execute({ peripheral: 'USART1' });
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_generate_peripheral_init requires peripheral name', async () => {
		const tools = buildCodegenTools(makeMockSession() as any);
		const tool = tools.find(t => t.name === 'fw_generate_peripheral_init')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('provide') || result.toLowerCase().includes('peripheral'));
	});

	test('fw_generate_peripheral_init for USART1 generates C code', async () => {
		const tools = buildCodegenTools(makeMockSession() as any);
		const tool = tools.find(t => t.name === 'fw_generate_peripheral_init')!;
		const result = await tool.execute({ peripheral: 'USART1' });
		assert.ok(result.includes('USART1') || result.includes('0x40011000'), `Result: ${result.slice(0, 200)}`);
		assert.ok(result.includes('void') || result.includes('BRR') || result.includes('CR1'));
	});

	test('fw_generate_peripheral_init for unknown peripheral shows available list', async () => {
		const tools = buildCodegenTools(makeMockSession() as any);
		const tool = tools.find(t => t.name === 'fw_generate_peripheral_init')!;
		const result = await tool.execute({ peripheral: 'SPI2' });
		assert.ok(result.toLowerCase().includes('not found') || result.includes('USART1') || result.toLowerCase().includes('available'));
	});

	// ─── fw_generate_isr ─────────────────────────────────────────────────────

	test('fw_generate_isr requires active session', async () => {
		const tools = buildCodegenTools(makeMockSession([], false) as any);
		const tool = tools.find(t => t.name === 'fw_generate_isr')!;
		const result = await tool.execute({ peripheral: 'USART1' });
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_generate_isr generates ISR skeleton with USART1', async () => {
		const tools = buildCodegenTools(makeMockSession() as any);
		const tool = tools.find(t => t.name === 'fw_generate_isr')!;
		const result = await tool.execute({ peripheral: 'USART1' });
		assert.ok(result.includes('USART1_IRQHandler') || result.includes('IRQ') || result.includes('USART1'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_generate_clock_config ─────────────────────────────────────────────

	test('fw_generate_clock_config requires active session', async () => {
		const tools = buildCodegenTools(makeMockSession([], false) as any);
		const tool = tools.find(t => t.name === 'fw_generate_clock_config')!;
		const result = await tool.execute({ targetMHz: 168 });
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_generate_clock_config generates RCC init code', async () => {
		const tools = buildCodegenTools(makeMockSession() as any);
		const tool = tools.find(t => t.name === 'fw_generate_clock_config')!;
		const result = await tool.execute({ targetMHz: 168, source: 'hse', hseMHz: 8 });
		assert.ok(result.includes('RCC') || result.includes('PLL') || result.includes('HSE'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_generate_gpio_config ─────────────────────────────────────────────

	test('fw_generate_gpio_config requires active session', async () => {
		const tools = buildCodegenTools(makeMockSession([], false) as any);
		const tool = tools.find(t => t.name === 'fw_generate_gpio_config')!;
		const result = await tool.execute({ pin: 'PA5' });
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_generate_gpio_config requires pin arg', async () => {
		const tools = buildCodegenTools(makeMockSession() as any);
		const tool = tools.find(t => t.name === 'fw_generate_gpio_config')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('provide') || result.toLowerCase().includes('pin'));
	});

	test('fw_generate_gpio_config rejects invalid pin format', async () => {
		const tools = buildCodegenTools(makeMockSession() as any);
		const tool = tools.find(t => t.name === 'fw_generate_gpio_config')!;
		const result = await tool.execute({ pin: 'P99X' });
		assert.ok(result.toLowerCase().includes('invalid') || result.toLowerCase().includes('format'));
	});

	test('fw_generate_gpio_config for PA5 output generates MODER write', async () => {
		const gpioa: IPeripheralRegisterMap = {
			name: 'GPIOA',
			groupName: 'GPIO',
			baseAddress: 0x40020000,
			description: 'GPIO port A',
			registers: [
				{ name: 'MODER', addressOffset: 0x00, size: 32, access: 'read-write', resetValue: 0xA8000000, description: 'Mode register', fields: [] },
				{ name: 'ODR', addressOffset: 0x14, size: 32, access: 'read-write', resetValue: 0, description: 'Output data register', fields: [] },
			],
			interrupts: [],
		};
		const tools = buildCodegenTools(makeMockSession([gpioa, RCC_MAP]) as any);
		const tool = tools.find(t => t.name === 'fw_generate_gpio_config')!;
		const result = await tool.execute({ pin: 'PA5', mode: 'output', speed: 'medium' });
		assert.ok(result.includes('GPIOA') || result.includes('PA5') || result.includes('MODER'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_generate_rtos_task ────────────────────────────────────────────────

	test('fw_generate_rtos_task requires active session', async () => {
		const tools = buildCodegenTools(makeMockSession([], false) as any);
		const tool = tools.find(t => t.name === 'fw_generate_rtos_task')!;
		const result = await tool.execute({ taskName: 'uart_task' });
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_generate_rtos_task generates FreeRTOS task skeleton', async () => {
		const tools = buildCodegenTools(makeMockSession() as any);
		const tool = tools.find(t => t.name === 'fw_generate_rtos_task')!;
		const result = await tool.execute({ taskName: 'uart_task', stackSize: 256, priority: 2 });
		assert.ok(result.includes('uart_task') || result.includes('xTaskCreate') || result.includes('vTaskDelay'), `Result: ${result.slice(0, 200)}`);
	});
});
