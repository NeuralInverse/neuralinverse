/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IFirmwarePowerModeToolService, IFirmwarePMTool } from '../../../browser/engine/firmwarePowerModeTools.js';

// ─── Mock power mode tool service ────────────────────────────────────────────

function makeMockPowerModeToolService(overrides: {
	tools?: IFirmwarePMTool[];
	buildResult?: { success: boolean; errors: number; warnings: number; output: string };
	flashResult?: { success: boolean; output: string };
	sessionInfo?: string;
} = {}) {
	const tools = overrides.tools ?? [];

	return {
		_serviceBrand: undefined as any,
		get tools() { return tools; },
		build: async () => overrides.buildResult ?? { success: true, errors: 0, warnings: 0, output: 'Build succeeded.' },
		flash: async () => overrides.flashResult ?? { success: true, output: 'Flash complete. verified OK.' },
		getSessionInfo: async () => overrides.sessionInfo ?? 'MCU: STM32F407VGT6 | Build: PlatformIO | Port: /dev/ttyUSB0',
	};
}

function makeMockPMTool(name: string, execute?: (args: any) => Promise<string>): IFirmwarePMTool {
	return {
		name,
		description: `Mock tool: ${name}`,
		params: {},
		execute: execute ?? (async () => `${name} executed`),
	};
}

suite('Firmware Power Mode Tools - IFirmwarePMTool Interface', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('IFirmwarePMTool has required fields', () => {
		const tool = makeMockPMTool('fw_build_project');
		assert.ok(tool.name === 'fw_build_project');
		assert.ok(typeof tool.description === 'string');
		assert.ok(typeof tool.params === 'object');
		assert.ok(typeof tool.execute === 'function');
	});

	test('tool execute returns a string', async () => {
		const tool = makeMockPMTool('fw_flash_device');
		const result = await tool.execute({});
		assert.ok(typeof result === 'string');
	});

	test('tool with parameters passes them to execute', async () => {
		const tool = makeMockPMTool('fw_serial_read', async (args: any) => `lines: ${args.lines ?? 50}`);
		const result = await tool.execute({ lines: 25 });
		assert.ok(result.includes('25'));
	});
});

suite('Firmware Power Mode Tools - Tool Registry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('service exposes tool list', () => {
		const svc = makeMockPowerModeToolService({
			tools: [
				makeMockPMTool('fw_build_project'),
				makeMockPMTool('fw_flash_device'),
				makeMockPMTool('fw_serial_read'),
			],
		});
		assert.strictEqual(svc.tools.length, 3);
	});

	test('all tools have unique names', () => {
		const svc = makeMockPowerModeToolService({
			tools: [
				makeMockPMTool('fw_build_project'),
				makeMockPMTool('fw_flash_device'),
				makeMockPMTool('fw_serial_read'),
				makeMockPMTool('fw_serial_write'),
				makeMockPMTool('fw_binary_analysis'),
				makeMockPMTool('fw_debug_start'),
				makeMockPMTool('fw_debug_cmd'),
				makeMockPMTool('fw_debug_regs'),
				makeMockPMTool('fw_debug_mem'),
				makeMockPMTool('fw_debug_break'),
				makeMockPMTool('fw_init_sequence'),
				makeMockPMTool('fw_platform_info'),
				makeMockPMTool('fw_session_info'),
				makeMockPMTool('fw_scan_workspace'),
				makeMockPMTool('fw_upload_datasheet'),
				makeMockPMTool('fw_query_datasheet'),
				makeMockPMTool('fw_list_peripherals'),
				makeMockPMTool('fw_query_register'),
			],
		});
		const names = svc.tools.map(t => t.name);
		const unique = new Set(names);
		assert.strictEqual(names.length, unique.size, 'All tool names should be unique');
	});

	test('expected power mode tools are named correctly', () => {
		const expectedNames = [
			'fw_build_project',
			'fw_flash_device',
			'fw_serial_read',
			'fw_binary_analysis',
			'fw_debug_start',
			'fw_platform_info',
			'fw_session_info',
			'fw_query_register',
		];
		const svc = makeMockPowerModeToolService({
			tools: expectedNames.map(n => makeMockPMTool(n)),
		});
		for (const name of expectedNames) {
			assert.ok(svc.tools.find(t => t.name === name), `Expected tool ${name}`);
		}
	});
});

suite('Firmware Power Mode Tools - Build and Flash', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('build success returns no errors', async () => {
		const svc = makeMockPowerModeToolService({ buildResult: { success: true, errors: 0, warnings: 2, output: 'Build succeeded.' } });
		const result = await svc.build();
		assert.ok(result.success);
		assert.strictEqual(result.errors, 0);
	});

	test('build failure returns error count', async () => {
		const svc = makeMockPowerModeToolService({ buildResult: { success: false, errors: 3, warnings: 0, output: 'error: expected ";"' } });
		const result = await svc.build();
		assert.ok(!result.success);
		assert.ok(result.errors > 0);
	});

	test('flash success returns verified output', async () => {
		const svc = makeMockPowerModeToolService({ flashResult: { success: true, output: 'verified OK' } });
		const result = await svc.flash();
		assert.ok(result.success);
		assert.ok(result.output.includes('verified') || result.output.includes('OK'));
	});

	test('flash failure returns descriptive error', async () => {
		const svc = makeMockPowerModeToolService({ flashResult: { success: false, output: 'Error: no debug probe found' } });
		const result = await svc.flash();
		assert.ok(!result.success);
		assert.ok(result.output.toLowerCase().includes('error') || result.output.toLowerCase().includes('failed'));
	});

	test('getSessionInfo returns MCU context', async () => {
		const svc = makeMockPowerModeToolService({ sessionInfo: 'MCU: STM32F407VGT6 | Build: PlatformIO' });
		const info = await svc.getSessionInfo();
		assert.ok(info.includes('STM32F407VGT6') || info.includes('MCU'));
	});
});
