/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildSimulationTools } from '../../../../browser/engine/agentTools/simulationTools.js';

function makeMockSession(family: string, variant: string, isActive = true) {
	return {
		session: {
			isActive,
			mcuConfig: { family, variant },
		},
	};
}

suite('Simulation Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildSimulationTools returns 2 tools', () => {
		const tools = buildSimulationTools(makeMockSession('STM32F4', 'STM32F407VGT6') as any);
		assert.strictEqual(tools.length, 2);
	});

	test('tool names are fw_qemu_availability and fw_renode_board_check', () => {
		const tools = buildSimulationTools(makeMockSession('STM32F4', '') as any);
		const names = tools.map(t => t.name);
		assert.ok(names.includes('fw_qemu_availability'));
		assert.ok(names.includes('fw_renode_board_check'));
	});

	// ─── fw_qemu_availability ─────────────────────────────────────────────────

	test('fw_qemu_availability with no session returns no session message', async () => {
		const tools = buildSimulationTools(makeMockSession('', '', false) as any);
		const tool = tools.find(t => t.name === 'fw_qemu_availability')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_qemu_availability STM32F4 returns machine and launch command', async () => {
		const tools = buildSimulationTools(makeMockSession('STM32F4', 'STM32F407VGT6') as any);
		const tool = tools.find(t => t.name === 'fw_qemu_availability')!;
		const result = await tool.execute({});
		assert.ok(result.includes('netduinoplus2') || result.includes('STM32F4'), `Result: ${result.slice(0, 200)}`);
		assert.ok(result.includes('qemu-system-arm') || result.includes('launch'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_qemu_availability STM32F103 returns stm32-p103 machine', async () => {
		const tools = buildSimulationTools(makeMockSession('STM32F103', 'STM32F103RBT6') as any);
		const tool = tools.find(t => t.name === 'fw_qemu_availability')!;
		const result = await tool.execute({});
		assert.ok(result.includes('stm32-p103') || result.includes('STM32F103'));
	});

	test('fw_qemu_availability shows peripheral simulation gaps', async () => {
		const tools = buildSimulationTools(makeMockSession('STM32F4', 'STM32F407VGT6') as any);
		const tool = tools.find(t => t.name === 'fw_qemu_availability')!;
		const result = await tool.execute({});
		assert.ok(result.includes('ADC') || result.includes('gaps') || result.includes('not simulated'));
	});

	test('fw_qemu_availability with unsupported MCU suggests Renode', async () => {
		const tools = buildSimulationTools(makeMockSession('STM32F7', 'STM32F746ZGT6') as any);
		const tool = tools.find(t => t.name === 'fw_qemu_availability')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('renode') || result.toLowerCase().includes('no qemu'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_qemu_availability AVR returns arduino-uno machine', async () => {
		const tools = buildSimulationTools(makeMockSession('ATMEGA328P', 'ATMEGA328P') as any);
		const tool = tools.find(t => t.name === 'fw_qemu_availability')!;
		const result = await tool.execute({});
		assert.ok(result.includes('arduino-uno') || result.includes('ATmega'));
	});

	// ─── fw_renode_board_check ────────────────────────────────────────────────

	test('fw_renode_board_check with no session returns no session message', async () => {
		const tools = buildSimulationTools(makeMockSession('', '', false) as any);
		const tool = tools.find(t => t.name === 'fw_renode_board_check')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_renode_board_check STM32F4 returns platform script and launch command', async () => {
		const tools = buildSimulationTools(makeMockSession('STM32F4', '') as any);
		const tool = tools.find(t => t.name === 'fw_renode_board_check')!;
		const result = await tool.execute({});
		assert.ok(result.includes('stm32f4discovery') || result.includes('.resc'), `Result: ${result.slice(0, 200)}`);
		assert.ok(result.includes('renode'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_renode_board_check STM32F4 lists simulated peripherals', async () => {
		const tools = buildSimulationTools(makeMockSession('STM32F4', '') as any);
		const tool = tools.find(t => t.name === 'fw_renode_board_check')!;
		const result = await tool.execute({});
		assert.ok(result.includes('USART') || result.includes('SPI') || result.includes('GPIO'));
	});

	test('fw_renode_board_check nRF52840 returns nrf52840 script', async () => {
		const tools = buildSimulationTools(makeMockSession('NRF52840', '') as any);
		const tool = tools.find(t => t.name === 'fw_renode_board_check')!;
		const result = await tool.execute({});
		assert.ok(result.includes('nrf52840') || result.includes('nRF52840'));
	});

	test('fw_renode_board_check RP2040 returns rpi-pico script', async () => {
		const tools = buildSimulationTools(makeMockSession('RP2040', '') as any);
		const tool = tools.find(t => t.name === 'fw_renode_board_check')!;
		const result = await tool.execute({});
		assert.ok(result.includes('rpi-pico') || result.includes('RP2040'));
	});

	test('fw_renode_board_check unsupported MCU returns list of supported boards', async () => {
		const tools = buildSimulationTools(makeMockSession('PIC32', 'PIC32MX') as any);
		const tool = tools.find(t => t.name === 'fw_renode_board_check')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no renode') || result.toLowerCase().includes('not found'));
		assert.ok(result.includes('STM32') || result.includes('coverage'));
	});
});
