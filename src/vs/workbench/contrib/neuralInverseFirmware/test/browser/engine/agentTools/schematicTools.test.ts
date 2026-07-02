/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildSchematicTools } from '../../../../browser/engine/agentTools/schematicTools.js';

function makeMockSchematicService(overrides: {
	pinData?: any[];
	conflicts?: any[];
	exportShouldThrow?: boolean;
} = {}) {
	return {
		_serviceBrand: undefined as any,
		getPinout: async () => overrides.pinData ?? [
			{ pin: 'PA9', function: 'USART1_TX', af: 7, state: 'assigned', peripheral: 'USART1' },
			{ pin: 'PA10', function: 'USART1_RX', af: 7, state: 'assigned', peripheral: 'USART1' },
			{ pin: 'PB6', function: 'I2C1_SCL', af: 4, state: 'assigned', peripheral: 'I2C1' },
			{ pin: 'PA5', function: 'GPIO_OUT', af: 0, state: 'gpio', peripheral: undefined },
		],
		checkConflicts: async () => overrides.conflicts ?? [],
		exportToKiCad: async (_path: string) => {
			if (overrides.exportShouldThrow) { throw new Error('write failed'); }
			return '.inverse/schematic/pinout.kicad_sch';
		},
	};
}

function makeMockSession(isActive = true, variant = 'STM32F407VGT6') {
	return {
		session: {
			isActive,
			mcuConfig: { family: 'STM32F4', variant },
		},
	};
}

suite('Schematic Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildSchematicTools returns 3 tools', () => {
		const tools = buildSchematicTools(makeMockSession() as any, makeMockSchematicService() as any);
		assert.strictEqual(tools.length, 3);
	});

	test('tool names are fw_pinout_show, fw_pinout_check, fw_pinout_export', () => {
		const tools = buildSchematicTools(makeMockSession() as any, makeMockSchematicService() as any);
		const names = tools.map(t => t.name);
		assert.ok(names.includes('fw_pinout_show'));
		assert.ok(names.includes('fw_pinout_check'));
		assert.ok(names.includes('fw_pinout_export'));
	});

	// ─── fw_pinout_show ───────────────────────────────────────────────────────

	test('fw_pinout_show with no active session returns message', async () => {
		const tools = buildSchematicTools(makeMockSession(false) as any, makeMockSchematicService() as any);
		const tool = tools.find(t => t.name === 'fw_pinout_show')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_pinout_show lists assigned pins', async () => {
		const tools = buildSchematicTools(makeMockSession() as any, makeMockSchematicService() as any);
		const tool = tools.find(t => t.name === 'fw_pinout_show')!;
		const result = await tool.execute({});
		assert.ok(result.includes('PA9') || result.includes('USART1'), `Result: ${result.slice(0, 200)}`);
		assert.ok(result.includes('PB6') || result.includes('I2C1'));
	});

	test('fw_pinout_show filter by peripheral', async () => {
		const tools = buildSchematicTools(makeMockSession() as any, makeMockSchematicService() as any);
		const tool = tools.find(t => t.name === 'fw_pinout_show')!;
		const result = await tool.execute({ peripheral: 'USART1' });
		assert.ok(result.includes('PA9') || result.includes('USART1'));
	});

	// ─── fw_pinout_check ──────────────────────────────────────────────────────

	test('fw_pinout_check with no session returns message', async () => {
		const tools = buildSchematicTools(makeMockSession(false) as any, makeMockSchematicService() as any);
		const tool = tools.find(t => t.name === 'fw_pinout_check')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_pinout_check with no conflicts shows all-clear message', async () => {
		const tools = buildSchematicTools(makeMockSession() as any, makeMockSchematicService({ conflicts: [] }) as any);
		const tool = tools.find(t => t.name === 'fw_pinout_check')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no conflict') || result.toLowerCase().includes('✓') || result.toLowerCase().includes('ok'));
	});

	test('fw_pinout_check with conflicts shows them', async () => {
		const tools = buildSchematicTools(makeMockSession() as any, makeMockSchematicService({
			conflicts: [
				{ pin: 'PA9', conflict: 'Both USART1_TX and TIM1_CH2 assigned to AF7', severity: 'error' },
			],
		}) as any);
		const tool = tools.find(t => t.name === 'fw_pinout_check')!;
		const result = await tool.execute({});
		assert.ok(result.includes('PA9') || result.includes('conflict') || result.includes('USART1'));
	});

	// ─── fw_pinout_export ─────────────────────────────────────────────────────

	test('fw_pinout_export with no session returns message', async () => {
		const tools = buildSchematicTools(makeMockSession(false) as any, makeMockSchematicService() as any);
		const tool = tools.find(t => t.name === 'fw_pinout_export')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_pinout_export returns file path', async () => {
		const tools = buildSchematicTools(makeMockSession() as any, makeMockSchematicService() as any);
		const tool = tools.find(t => t.name === 'fw_pinout_export')!;
		const result = await tool.execute({});
		assert.ok(result.includes('.kicad_sch') || result.includes('export') || result.includes('.inverse'), `Result: ${result.slice(0, 200)}`);
	});
});
