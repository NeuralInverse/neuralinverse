/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildOscilloscopeTools } from '../../../../browser/engine/agentTools/oscilloscopeTools.js';

function makeVoltages(count: number, min: number, max: number): number[] {
	const out: number[] = [];
	for (let i = 0; i < count; i++) {
		out.push(min + (max - min) * (0.5 + 0.5 * Math.sin(i / 10)));
	}
	return out;
}

function makeMockScopeService(overrides: {
	scopes?: any[];
	captureShouldThrow?: boolean;
	measurements?: Array<{ parameter: string; value: number; unit: string }>;
	screenshotPath?: string;
} = {}) {
	const captureId = 'scope_1234567890';
	const voltages = makeVoltages(1000, 0.0, 3.3);

	return {
		_serviceBrand: undefined as any,
		discover: async () => overrides.scopes ?? [],
		configureChannel: async (_config: any) => {},
		configureTrigger: async (_config: any) => {},
		capture: async (_timeoutSec: number) => {
			if (overrides.captureShouldThrow) { throw new Error('timeout waiting for trigger'); }
			return {
				captureId,
				channels: [{
					channel: 1,
					voltages,
					sampleRate: 250_000_000,
					timebase: 0.001,
				}],
			};
		},
		measure: async (params: string[], _channel: number) => {
			if (overrides.measurements) { return overrides.measurements; }
			return params.map(p => ({ parameter: p, value: p === 'FREQ' ? 1000.0 : p === 'PKPK' ? 3.3 : 0.5, unit: p === 'FREQ' ? 'Hz' : 'V' }));
		},
		screenshot: async (_path: string) => overrides.screenshotPath ?? '.inverse/captures/scope_test.bmp',
		railCheck: async (_channel: number, _nominalV: number, _droopV: number) => ({
			nominalV: 3.3,
			minV: 3.1,
			maxV: 3.35,
			droopPct: 6.1,
			passed: true,
		}),
		sendSCPI: async (cmd: string) => `+OK ${cmd}`,
	};
}

function makeMockSession(isActive = true) {
	return { session: { isActive, mcuConfig: { family: 'STM32F4', variant: '' } } };
}

suite('Oscilloscope Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildOscilloscopeTools returns 6 tools', () => {
		const tools = buildOscilloscopeTools(makeMockSession() as any, makeMockScopeService() as any);
		assert.strictEqual(tools.length, 6);
	});

	test('tool names include all expected scope tools', () => {
		const tools = buildOscilloscopeTools(makeMockSession() as any, makeMockScopeService() as any);
		const names = new Set(tools.map(t => t.name));
		assert.ok(names.has('fw_scope_discover'));
		assert.ok(names.has('fw_scope_capture'));
		assert.ok(names.has('fw_scope_measure'));
		assert.ok(names.has('fw_scope_screenshot'));
		assert.ok(names.has('fw_scope_rail_check'));
		assert.ok(names.has('fw_scope_scpi'));
	});

	// ─── fw_scope_discover ────────────────────────────────────────────────────

	test('fw_scope_discover with no scopes shows how to connect', async () => {
		const tools = buildOscilloscopeTools(makeMockSession() as any, makeMockScopeService({ scopes: [] }) as any);
		const tool = tools.find(t => t.name === 'fw_scope_discover')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no oscilloscope') || result.toLowerCase().includes('not found'));
		assert.ok(result.toLowerCase().includes('connect') || result.toLowerCase().includes('lan'));
	});

	test('fw_scope_discover with scope shows model and host', async () => {
		const tools = buildOscilloscopeTools(makeMockSession() as any, makeMockScopeService({
			scopes: [{ model: 'SDS804X HD', manufacturer: 'Siglent', host: '192.168.1.100', port: 5025, serialNumber: 'SDS8XXXXXXXXX', firmware: '1.6.6' }],
		}) as any);
		const tool = tools.find(t => t.name === 'fw_scope_discover')!;
		const result = await tool.execute({});
		assert.ok(result.includes('SDS804X HD') || result.includes('Siglent'));
		assert.ok(result.includes('192.168.1.100'));
	});

	// ─── fw_scope_capture ─────────────────────────────────────────────────────

	test('fw_scope_capture with no active session returns message', async () => {
		const tools = buildOscilloscopeTools(makeMockSession(false) as any, makeMockScopeService() as any);
		const tool = tools.find(t => t.name === 'fw_scope_capture')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_scope_capture returns waveform summary', async () => {
		const tools = buildOscilloscopeTools(makeMockSession() as any, makeMockScopeService() as any);
		const tool = tools.find(t => t.name === 'fw_scope_capture')!;
		const result = await tool.execute({ channel: 1, vDiv: 1.0, triggerEdge: 'POS' });
		assert.ok(result.includes('Capture') || result.includes('CH1'), `Result: ${result.slice(0, 200)}`);
		assert.ok(result.includes('Pk-Pk') || result.includes('V'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_scope_capture shows ASCII waveform', async () => {
		const tools = buildOscilloscopeTools(makeMockSession() as any, makeMockScopeService() as any);
		const tool = tools.find(t => t.name === 'fw_scope_capture')!;
		const result = await tool.execute({ channel: 1 });
		// Either ASCII art or numeric measurements should appear
		assert.ok(result.includes('V') || result.includes('Max') || result.includes('Min'));
	});

	// ─── fw_scope_measure ─────────────────────────────────────────────────────

	test('fw_scope_measure with no session returns message', async () => {
		const tools = buildOscilloscopeTools(makeMockSession(false) as any, makeMockScopeService() as any);
		const tool = tools.find(t => t.name === 'fw_scope_measure')!;
		const result = await tool.execute({ params: ['FREQ'], channel: 1 });
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_scope_measure returns measurement values', async () => {
		const tools = buildOscilloscopeTools(makeMockSession() as any, makeMockScopeService({
			measurements: [
				{ parameter: 'FREQ', value: 1000.0, unit: 'Hz' },
				{ parameter: 'PKPK', value: 3.3, unit: 'V' },
			],
		}) as any);
		const tool = tools.find(t => t.name === 'fw_scope_measure')!;
		const result = await tool.execute({ params: ['FREQ', 'PKPK'], channel: 1 });
		assert.ok(result.includes('FREQ') || result.includes('1000'));
		assert.ok(result.includes('PKPK') || result.includes('3.3'));
	});

	test('fw_scope_measure with empty measurements returns guidance', async () => {
		const tools = buildOscilloscopeTools(makeMockSession() as any, makeMockScopeService({ measurements: [] }) as any);
		const tool = tools.find(t => t.name === 'fw_scope_measure')!;
		const result = await tool.execute({ params: ['FREQ'], channel: 1 });
		assert.ok(result.toLowerCase().includes('no measurements') || result.toLowerCase().includes('capture'));
	});

	// ─── fw_scope_rail_check ─────────────────────────────────────────────────

	test('fw_scope_rail_check with no session returns message', async () => {
		const tools = buildOscilloscopeTools(makeMockSession(false) as any, makeMockScopeService() as any);
		const tool = tools.find(t => t.name === 'fw_scope_rail_check')!;
		const result = await tool.execute({ channel: 1, nominalV: 3.3 });
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_scope_rail_check shows voltage stats', async () => {
		const tools = buildOscilloscopeTools(makeMockSession() as any, makeMockScopeService() as any);
		const tool = tools.find(t => t.name === 'fw_scope_rail_check')!;
		const result = await tool.execute({ channel: 1, nominalV: 3.3, droopThreshold: 2.8 });
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('3.') || result.includes('V') || result.includes('rail'));
	});
});
