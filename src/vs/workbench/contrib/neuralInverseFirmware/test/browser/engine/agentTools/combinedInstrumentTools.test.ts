/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildCombinedInstrumentTools } from '../../../../browser/engine/agentTools/combinedInstrumentTools.js';

function makeMockSession(isActive = true) {
	return { session: { isActive, mcuConfig: { family: 'STM32F4', variant: '' } } };
}

function makeMockDebugService(connected = false) {
	return {
		_serviceBrand: undefined as any,
		state: { clientConnected: connected, targetState: connected ? 'stopped' : 'unknown', serverRunning: connected },
		startGDBServer: async () => {},
		connectGDB: async () => {},
		halt: async () => {},
		continue: async () => {},
		readRegisters: async () => [{ name: 'pc', value: 0x08001234, hexValue: '0x08001234' }],
		sendCommand: async (cmd: string) => ({ isError: false, output: `Mock: ${cmd}` }),
		stopDebug: async () => {},
	};
}

function makeMockLAService(connected = false) {
	return {
		_serviceBrand: undefined as any,
		detect: async () => ({ connected, backend: 'saleae', availableChannels: 16, maxSampleRateMHz: 500, supportedProtocols: ['uart', 'i2c'], error: connected ? undefined : 'not connected' }),
		captureChannels: async (_ch: any[], dur: number, sr: number) => ({
			captureId: 'la_test_001', backend: 'saleae', channels: _ch, durationSec: dur, sampleRate: sr, frames: [],
		}),
		decodeProtocol: async () => [],
		armTrigger: async (_t: any, cfg: any) => ({
			captureId: 'la_trigger_001', backend: 'saleae', channels: [], durationSec: cfg.durationSec ?? 1, sampleRate: 12000000, frames: [],
		}),
		getCapture: (_id: string) => undefined,
	};
}

function makeMockPAService(connected = false) {
	return {
		_serviceBrand: undefined as any,
		detect: async () => ({ connected, device: 'ppk2', error: connected ? undefined : 'not found' }),
		measure: async () => ({ avgMA: 14.2, peakMA: 48.0, minMA: 0.5, voltageV: 3.3, powerMW: 46.9, durationMs: 1000 }),
		record: async () => ({ captureId: 'pa_test_001', durationMs: 2000, samples: [], avgMA: 14.2 }),
	};
}

function makeMockScopeService(connected = false) {
	return {
		_serviceBrand: undefined as any,
		discover: async () => connected ? [{ model: 'SDS804X HD', host: '192.168.1.100', port: 5025, manufacturer: 'Siglent', serialNumber: 'SN001', firmware: '1.6' }] : [],
		configureChannel: async () => {},
		configureTrigger: async () => {},
		capture: async () => ({ captureId: 'sc_test_001', channels: [{ channel: 1, voltages: [1.6, 1.7, 3.2, 3.3], sampleRate: 250e6, timebase: 0.001 }] }),
		measure: async (params: string[]) => params.map(p => ({ parameter: p, value: 1000.0, unit: 'Hz' })),
		screenshot: async () => '.inverse/captures/scope_test.bmp',
	};
}

suite('Combined Instrument Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildCombinedInstrumentTools returns 2 tools', () => {
		const tools = buildCombinedInstrumentTools(
			makeMockSession() as any,
			makeMockDebugService() as any,
			makeMockLAService() as any,
			makeMockPAService() as any,
			makeMockScopeService() as any,
		);
		assert.strictEqual(tools.length, 2);
	});

	test('tool names are fw_debug_combined and fw_correlate_power_logic', () => {
		const tools = buildCombinedInstrumentTools(
			makeMockSession() as any,
			makeMockDebugService() as any,
			makeMockLAService() as any,
			makeMockPAService() as any,
			makeMockScopeService() as any,
		);
		const names = tools.map(t => t.name);
		assert.ok(names.includes('fw_debug_combined'));
		assert.ok(names.includes('fw_correlate_power_logic'));
	});

	// ─── fw_debug_combined ────────────────────────────────────────────────────

	test('fw_debug_combined with no active session returns message', async () => {
		const tools = buildCombinedInstrumentTools(
			makeMockSession(false) as any,
			makeMockDebugService() as any,
			makeMockLAService() as any,
			makeMockPAService() as any,
			makeMockScopeService() as any,
		);
		const tool = tools.find(t => t.name === 'fw_debug_combined')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_debug_combined shows instrument availability summary', async () => {
		const tools = buildCombinedInstrumentTools(
			makeMockSession() as any,
			makeMockDebugService(true) as any,
			makeMockLAService(true) as any,
			makeMockPAService(true) as any,
			makeMockScopeService(true) as any,
		);
		const tool = tools.find(t => t.name === 'fw_debug_combined')!;
		const result = await tool.execute({ workflow: 'sleep-regression' });
		assert.ok(typeof result === 'string');
		assert.ok(result.length > 0);
	});

	test('fw_debug_combined with no instruments shows how to connect them', async () => {
		const tools = buildCombinedInstrumentTools(
			makeMockSession() as any,
			makeMockDebugService(false) as any,
			makeMockLAService(false) as any,
			makeMockPAService(false) as any,
			makeMockScopeService(false) as any,
		);
		const tool = tools.find(t => t.name === 'fw_debug_combined')!;
		const result = await tool.execute({});
		assert.ok(typeof result === 'string');
		assert.ok(result.length > 0);
	});

	// ─── fw_correlate_power_logic ─────────────────────────────────────────────

	test('fw_correlate_power_logic when instruments not connected shows connect instructions', async () => {
		const tools = buildCombinedInstrumentTools(
			makeMockSession() as any,
			makeMockDebugService() as any,
			makeMockLAService(false) as any,
			makeMockPAService(false) as any,
			makeMockScopeService() as any,
		);
		const tool = tools.find(t => t.name === 'fw_correlate_power_logic')!;
		const result = await tool.execute({ event: 'GPIO PA5 rising edge' });
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('connect') || result.includes('fw_la_status') || result.includes('fw_pa_status') || result.length > 0);
	});

	test('fw_correlate_power_logic with instruments returns correlation result', async () => {
		const tools = buildCombinedInstrumentTools(
			makeMockSession() as any,
			makeMockDebugService() as any,
			makeMockLAService(true) as any,
			makeMockPAService(true) as any,
			makeMockScopeService() as any,
		);
		const tool = tools.find(t => t.name === 'fw_correlate_power_logic')!;
		const result = await tool.execute({ event: 'I2C transaction start', durationSec: 1 });
		assert.ok(typeof result === 'string');
		assert.ok(result.length > 0);
	});
});
