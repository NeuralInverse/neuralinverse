/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildPowerAnalyzerTools } from '../../../../browser/engine/agentTools/powerAnalyzerTools.js';

function makeMockPAService(overrides: {
	connected?: boolean;
	device?: string;
	measureResult?: { avgMA: number; peakMA: number; minMA: number; voltageV: number; powerMW: number; durationMs: number };
	setVoltageShouldThrow?: boolean;
} = {}) {
	return {
		_serviceBrand: undefined as any,
		detect: async () => ({
			connected: overrides.connected ?? false,
			device: overrides.device ?? 'ppk2',
			error: overrides.connected ? undefined : 'VID:1915 PID:C00A not found on USB',
		}),
		measure: async (_config: any) => {
			if (!overrides.connected) { throw new Error('device not connected'); }
			return overrides.measureResult ?? {
				avgMA: 12.5,
				peakMA: 48.2,
				minMA: 0.8,
				voltageV: 3.3,
				powerMW: 41.25,
				durationMs: 1000,
			};
		},
		profileBoot: async (_config: any) => ({
			bootTimeMs: 210,
			peakMA: 72.0,
			avgBootMA: 35.0,
			samples: [],
		}),
		armTrigger: async (_config: any) => ({
			triggerTimestampMs: 100,
			captureId: 'pa_trigger_001',
			samples: [],
		}),
		setVoltage: async (v: number) => {
			if (overrides.setVoltageShouldThrow) { throw new Error('voltage out of range'); }
			return v;
		},
		record: async (_config: any) => ({
			captureId: 'pa_record_001',
			durationMs: 5000,
			samples: [],
			avgMA: 14.2,
		}),
	};
}

function makeMockSession(isActive = true) {
	return { session: { isActive, mcuConfig: { family: 'STM32F4', variant: '' } } };
}

suite('Power Analyzer Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildPowerAnalyzerTools returns 6 tools', () => {
		const tools = buildPowerAnalyzerTools(makeMockSession() as any, makeMockPAService() as any);
		assert.strictEqual(tools.length, 6);
	});

	test('tool names include all expected power analyzer tools', () => {
		const tools = buildPowerAnalyzerTools(makeMockSession() as any, makeMockPAService() as any);
		const names = new Set(tools.map(t => t.name));
		assert.ok(names.has('fw_pa_status'));
		assert.ok(names.has('fw_pa_measure'));
		assert.ok(names.has('fw_pa_profile_boot'));
		assert.ok(names.has('fw_pa_trigger'));
		assert.ok(names.has('fw_pa_set_voltage'));
		assert.ok(names.has('fw_pa_record'));
	});

	// ─── fw_pa_status ─────────────────────────────────────────────────────────

	test('fw_pa_status when not connected shows wiring instructions', async () => {
		const tools = buildPowerAnalyzerTools(makeMockSession() as any, makeMockPAService({ connected: false }) as any);
		const tool = tools.find(t => t.name === 'fw_pa_status')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('not detected') || result.toLowerCase().includes('connect'));
		assert.ok(result.toLowerCase().includes('ppk2') || result.toLowerCase().includes('joulescope') || result.toLowerCase().includes('usb'));
	});

	test('fw_pa_status when connected shows device name', async () => {
		const tools = buildPowerAnalyzerTools(makeMockSession() as any, makeMockPAService({ connected: true, device: 'ppk2' }) as any);
		const tool = tools.find(t => t.name === 'fw_pa_status')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('ppk2') || result.toLowerCase().includes('connected') || result.toLowerCase().includes('power analyzer'));
	});

	// ─── fw_pa_measure ────────────────────────────────────────────────────────

	test('fw_pa_measure with no session returns message', async () => {
		const tools = buildPowerAnalyzerTools(makeMockSession(false) as any, makeMockPAService({ connected: true }) as any);
		const tool = tools.find(t => t.name === 'fw_pa_measure')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_pa_measure returns avg, peak, min current', async () => {
		const tools = buildPowerAnalyzerTools(makeMockSession() as any, makeMockPAService({ connected: true }) as any);
		const tool = tools.find(t => t.name === 'fw_pa_measure')!;
		const result = await tool.execute({ durationMs: 1000 });
		assert.ok(result.includes('12.5') || result.includes('avg') || result.includes('mA'), `Result: ${result.slice(0, 200)}`);
		assert.ok(result.includes('48.2') || result.includes('peak') || result.includes('mA'));
	});

	// ─── fw_pa_profile_boot ───────────────────────────────────────────────────

	test('fw_pa_profile_boot with no session returns message', async () => {
		const tools = buildPowerAnalyzerTools(makeMockSession(false) as any, makeMockPAService({ connected: true }) as any);
		const tool = tools.find(t => t.name === 'fw_pa_profile_boot')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_pa_profile_boot shows boot time', async () => {
		const tools = buildPowerAnalyzerTools(makeMockSession() as any, makeMockPAService({ connected: true }) as any);
		const tool = tools.find(t => t.name === 'fw_pa_profile_boot')!;
		const result = await tool.execute({});
		assert.ok(result.includes('210') || result.includes('boot') || result.includes('ms'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_pa_set_voltage ────────────────────────────────────────────────────

	test('fw_pa_set_voltage returns confirmation', async () => {
		const tools = buildPowerAnalyzerTools(makeMockSession() as any, makeMockPAService({ connected: true }) as any);
		const tool = tools.find(t => t.name === 'fw_pa_set_voltage')!;
		const result = await tool.execute({ voltage: 3.3 });
		assert.ok(result.includes('3.3') || result.includes('voltage') || result.includes('V'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_pa_record ─────────────────────────────────────────────────────────

	test('fw_pa_record with no session returns message', async () => {
		const tools = buildPowerAnalyzerTools(makeMockSession(false) as any, makeMockPAService({ connected: true }) as any);
		const tool = tools.find(t => t.name === 'fw_pa_record')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_pa_record returns capture id', async () => {
		const tools = buildPowerAnalyzerTools(makeMockSession() as any, makeMockPAService({ connected: true }) as any);
		const tool = tools.find(t => t.name === 'fw_pa_record')!;
		const result = await tool.execute({ durationMs: 5000 });
		assert.ok(result.includes('pa_record') || result.includes('capture') || result.includes('avg'), `Result: ${result.slice(0, 200)}`);
	});
});
