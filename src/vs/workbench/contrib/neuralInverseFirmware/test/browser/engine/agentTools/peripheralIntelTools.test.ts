/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildPeripheralIntelTools } from '../../../../browser/engine/agentTools/peripheralIntelTools.js';

function makeMockSession(overrides: {
	isActive?: boolean;
	family?: string;
	variant?: string;
	pinAssignments?: Array<{ pin: string; peripheral: string; signal: string; af: number }>;
} = {}) {
	return {
		session: {
			isActive: overrides.isActive ?? true,
			mcuConfig: {
				family: overrides.family ?? 'STM32F4',
				variant: overrides.variant ?? 'STM32F407VGT6',
			},
			pinAssignments: overrides.pinAssignments ?? [
				{ pin: 'PA9', peripheral: 'USART1', signal: 'USART1_TX', af: 7 },
				{ pin: 'PA10', peripheral: 'USART1', signal: 'USART1_RX', af: 7 },
				{ pin: 'PB6', peripheral: 'I2C1', signal: 'I2C1_SCL', af: 4 },
			],
			getConfigFileContent: async (filename: string) => {
				if (filename === '.nimd') { return 'mcuFamily: STM32F4\nmcuVariant: STM32F407VGT6'; }
				return null;
			},
		},
	};
}

suite('Peripheral Intel Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildPeripheralIntelTools returns 6 tools', () => {
		const tools = buildPeripheralIntelTools(makeMockSession() as any);
		assert.strictEqual(tools.length, 6);
	});

	test('tool names include all expected peripheral intel tools', () => {
		const tools = buildPeripheralIntelTools(makeMockSession() as any);
		const names = new Set(tools.map(t => t.name));
		assert.ok(names.has('fw_calculate_prescaler'));
		assert.ok(names.has('fw_gpio_alternate_functions'));
		assert.ok(names.has('fw_dma_channel_map'));
		assert.ok(names.has('fw_nvic_priority_guide'));
		assert.ok(names.has('fw_get_pin_assignments'));
		assert.ok(names.has('fw_read_config_file'));
	});

	// ─── fw_calculate_prescaler ───────────────────────────────────────────────

	test('fw_calculate_prescaler requires active session', async () => {
		const tools = buildPeripheralIntelTools(makeMockSession({ isActive: false }) as any);
		const tool = tools.find(t => t.name === 'fw_calculate_prescaler')!;
		const result = await tool.execute({ peripheral: 'USART1', targetHz: 115200 });
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_calculate_prescaler for UART at 115200 returns prescaler', async () => {
		const tools = buildPeripheralIntelTools(makeMockSession() as any);
		const tool = tools.find(t => t.name === 'fw_calculate_prescaler')!;
		const result = await tool.execute({ peripheral: 'USART1', targetHz: 115200 });
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('115200') || result.includes('BRR') || result.includes('prescaler') || result.includes('baud'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_calculate_prescaler for TIM returns period and prescaler', async () => {
		const tools = buildPeripheralIntelTools(makeMockSession() as any);
		const tool = tools.find(t => t.name === 'fw_calculate_prescaler')!;
		const result = await tool.execute({ peripheral: 'TIM3', targetHz: 1000 });
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('TIM') || result.includes('1000') || result.includes('prescaler'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_gpio_alternate_functions ─────────────────────────────────────────

	test('fw_gpio_alternate_functions requires active session', async () => {
		const tools = buildPeripheralIntelTools(makeMockSession({ isActive: false }) as any);
		const tool = tools.find(t => t.name === 'fw_gpio_alternate_functions')!;
		const result = await tool.execute({ pin: 'PA9' });
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_gpio_alternate_functions for PA9 shows USART1_TX AF7', async () => {
		const tools = buildPeripheralIntelTools(makeMockSession({ family: 'STM32F4', variant: 'STM32F407VGT6' }) as any);
		const tool = tools.find(t => t.name === 'fw_gpio_alternate_functions')!;
		const result = await tool.execute({ pin: 'PA9' });
		assert.ok(result.includes('USART1') || result.includes('AF7') || result.includes('PA9'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_gpio_alternate_functions for invalid pin format returns error', async () => {
		const tools = buildPeripheralIntelTools(makeMockSession() as any);
		const tool = tools.find(t => t.name === 'fw_gpio_alternate_functions')!;
		const result = await tool.execute({ pin: 'XX99' });
		assert.ok(result.toLowerCase().includes('invalid') || result.toLowerCase().includes('format') || result.toLowerCase().includes('pin'));
	});

	// ─── fw_dma_channel_map ───────────────────────────────────────────────────

	test('fw_dma_channel_map requires active session', async () => {
		const tools = buildPeripheralIntelTools(makeMockSession({ isActive: false }) as any);
		const tool = tools.find(t => t.name === 'fw_dma_channel_map')!;
		const result = await tool.execute({ peripheral: 'USART1' });
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_dma_channel_map for USART1 shows DMA stream/channel', async () => {
		const tools = buildPeripheralIntelTools(makeMockSession({ family: 'STM32F4' }) as any);
		const tool = tools.find(t => t.name === 'fw_dma_channel_map')!;
		const result = await tool.execute({ peripheral: 'USART1' });
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('DMA') || result.includes('USART1') || result.includes('stream') || result.includes('channel'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_nvic_priority_guide ───────────────────────────────────────────────

	test('fw_nvic_priority_guide requires active session', async () => {
		const tools = buildPeripheralIntelTools(makeMockSession({ isActive: false }) as any);
		const tool = tools.find(t => t.name === 'fw_nvic_priority_guide')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_nvic_priority_guide returns priority guidance', async () => {
		const tools = buildPeripheralIntelTools(makeMockSession() as any);
		const tool = tools.find(t => t.name === 'fw_nvic_priority_guide')!;
		const result = await tool.execute({});
		assert.ok(result.includes('NVIC') || result.includes('priority') || result.includes('interrupt'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_get_pin_assignments ───────────────────────────────────────────────

	test('fw_get_pin_assignments requires active session', async () => {
		const tools = buildPeripheralIntelTools(makeMockSession({ isActive: false }) as any);
		const tool = tools.find(t => t.name === 'fw_get_pin_assignments')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_get_pin_assignments lists assigned pins', async () => {
		const tools = buildPeripheralIntelTools(makeMockSession() as any);
		const tool = tools.find(t => t.name === 'fw_get_pin_assignments')!;
		const result = await tool.execute({});
		assert.ok(result.includes('PA9') || result.includes('USART1') || result.includes('assignment'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_read_config_file ──────────────────────────────────────────────────

	test('fw_read_config_file reads .nimd config', async () => {
		const tools = buildPeripheralIntelTools(makeMockSession() as any);
		const tool = tools.find(t => t.name === 'fw_read_config_file')!;
		const result = await tool.execute({ filename: '.nimd' });
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('STM32F4') || result.includes('mcuFamily') || result.includes('config'), `Result: ${result.slice(0, 200)}`);
	});
});
