/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildRTTTools } from '../../../../browser/engine/agentTools/rttTools.js';
import { IRTTStatus, IRTTFrame } from '../../../../browser/engine/serial/rttService.js';
import { IITMStatus, IITMFrame } from '../../../../browser/engine/serial/itmService.js';

function makeMockRTTService(overrides: {
	status?: Partial<IRTTStatus>;
	frames?: IRTTFrame[];
	startShouldThrow?: boolean;
} = {}) {
	const now = Date.now();
	const defaultFrames: IRTTFrame[] = overrides.frames ?? [
		{ channel: 0, data: 'Boot OK\n', timestamp: now - 1000, rawBytes: new Uint8Array([66, 111, 111, 116]) },
		{ channel: 0, data: '[INFO] RTOS started\n', timestamp: now - 500, rawBytes: new Uint8Array([73, 78, 70, 79]) },
	];

	return {
		_serviceBrand: undefined as any,
		status: {
			connected: false,
			...overrides.status,
		} as IRTTStatus,
		start: async (_device: string, _iface: string, _speed: number) => {
			if (overrides.startShouldThrow) { throw new Error('J-Link not found'); }
			return {
				connected: true,
				targetDevice: 'STM32F407VGT6',
				interface: 'swd',
				speedKHz: 4000,
				channels: [
					{ index: 0, name: 'Terminal', direction: 'up', bufferSize: 1024 },
				],
			} as IRTTStatus;
		},
		stop: async () => {},
		read: async (_channel: number, _limit: number, _since: number) => defaultFrames,
		write: async (_channel: number, _data: string) => {},
	};
}

function makeMockITMService(overrides: {
	status?: Partial<IITMStatus>;
	frames?: IITMFrame[];
	startShouldThrow?: boolean;
	swoProfileResult?: any;
} = {}) {
	const now = Date.now();
	const defaultFrames: IITMFrame[] = overrides.frames ?? [
		{ port: 0, data: 'Tick: 1000\n', rawValue: 0, timestamp: now - 1000, type: 'stimulus' as const },
		{ port: 0, data: 'Tick: 2000\n', rawValue: 0, timestamp: now - 500, type: 'stimulus' as const },
	];

	return {
		_serviceBrand: undefined as any,
		status: {
			active: false,
			framesReceived: 0,
			overflowCount: 0,
			...overrides.status,
		} as IITMStatus,
		start: async (_device: string, _coreFreqHz: number, _swoPrescaler: number) => {
			if (overrides.startShouldThrow) { throw new Error('SWO not enabled'); }
			return {
				active: true,
				framesReceived: 0,
				overflowCount: 0,
			} as IITMStatus;
		},
		stop: async () => {},
		read: async (_stimulus: number, _limit: number, _since: number) => defaultFrames,
		swoProfile: async (_durationMs: number) => overrides.swoProfileResult ?? {
			topFunctions: [
				{ name: 'HAL_UART_Transmit', pcSamples: 1234, pct: 42.1 },
				{ name: 'main', pcSamples: 500, pct: 17.0 },
			],
			totalSamples: 2934,
		},
	};
}

suite('RTT/ITM Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildRTTTools returns 6 tools', () => {
		const tools = buildRTTTools({} as any, makeMockRTTService() as any, makeMockITMService() as any);
		assert.strictEqual(tools.length, 6);
	});

	test('tool names include all expected RTT/ITM tools', () => {
		const tools = buildRTTTools({} as any, makeMockRTTService() as any, makeMockITMService() as any);
		const names = new Set(tools.map(t => t.name));
		assert.ok(names.has('fw_rtt_start'));
		assert.ok(names.has('fw_rtt_read'));
		assert.ok(names.has('fw_rtt_write'));
		assert.ok(names.has('fw_itm_start'));
		assert.ok(names.has('fw_itm_read'));
		assert.ok(names.has('fw_swo_profile'));
	});

	// ─── fw_rtt_start ─────────────────────────────────────────────────────────

	test('fw_rtt_start succeeds and shows channels', async () => {
		const tools = buildRTTTools({} as any, makeMockRTTService() as any, makeMockITMService() as any);
		const tool = tools.find(t => t.name === 'fw_rtt_start')!;
		const result = await tool.execute({ targetDevice: 'STM32F407VGT6' });
		assert.ok(result.includes('RTT') || result.includes('connected') || result.includes('Terminal'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_rtt_start with failing J-Link shows helpful error', async () => {
		const tools = buildRTTTools({} as any, makeMockRTTService({ startShouldThrow: true }) as any, makeMockITMService() as any);
		const tool = tools.find(t => t.name === 'fw_rtt_start')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('failed') || result.toLowerCase().includes('j-link') || result.toLowerCase().includes('error'));
	});

	test('fw_rtt_start when already connected returns already running message', async () => {
		const tools = buildRTTTools({} as any, makeMockRTTService({ status: { connected: true } }) as any, makeMockITMService() as any);
		const tool = tools.find(t => t.name === 'fw_rtt_start')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('already') || result.toLowerCase().includes('connected') || result.toLowerCase().includes('running'));
	});

	// ─── fw_rtt_read ──────────────────────────────────────────────────────────

	test('fw_rtt_read when not connected returns not connected message', async () => {
		const tools = buildRTTTools({} as any, makeMockRTTService({ status: { connected: false } }) as any, makeMockITMService() as any);
		const tool = tools.find(t => t.name === 'fw_rtt_read')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('not connected') || result.toLowerCase().includes('fw_rtt_start'));
	});

	test('fw_rtt_read when connected returns RTT output', async () => {
		const tools = buildRTTTools({} as any, makeMockRTTService({ status: { connected: true } }) as any, makeMockITMService() as any);
		const tool = tools.find(t => t.name === 'fw_rtt_read')!;
		const result = await tool.execute({ channel: 0, lines: 10 });
		assert.ok(result.includes('Boot OK') || result.includes('RTOS') || result.includes('RTT'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_rtt_write ─────────────────────────────────────────────────────────

	test('fw_rtt_write when not connected returns error', async () => {
		const tools = buildRTTTools({} as any, makeMockRTTService({ status: { connected: false } }) as any, makeMockITMService() as any);
		const tool = tools.find(t => t.name === 'fw_rtt_write')!;
		const result = await tool.execute({ data: 'test\n' });
		assert.ok(result.toLowerCase().includes('not connected') || result.toLowerCase().includes('fw_rtt_start'));
	});

	test('fw_rtt_write when connected confirms write', async () => {
		const tools = buildRTTTools({} as any, makeMockRTTService({ status: { connected: true } }) as any, makeMockITMService() as any);
		const tool = tools.find(t => t.name === 'fw_rtt_write')!;
		const result = await tool.execute({ data: 'CMD: reset\n', channel: 0 });
		assert.ok(result.toLowerCase().includes('sent') || result.toLowerCase().includes('written') || result.includes('CMD'));
	});

	// ─── fw_itm_start ─────────────────────────────────────────────────────────

	test('fw_itm_start succeeds and shows SWO config', async () => {
		const tools = buildRTTTools({} as any, makeMockRTTService() as any, makeMockITMService() as any);
		const tool = tools.find(t => t.name === 'fw_itm_start')!;
		const result = await tool.execute({ targetDevice: 'STM32F407VGT6', coreFreqHz: 168000000 });
		assert.ok(result.includes('ITM') || result.includes('SWO') || result.includes('connected'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_itm_start with error shows helpful message', async () => {
		const tools = buildRTTTools({} as any, makeMockRTTService() as any, makeMockITMService({ startShouldThrow: true }) as any);
		const tool = tools.find(t => t.name === 'fw_itm_start')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('failed') || result.toLowerCase().includes('swo') || result.toLowerCase().includes('error'));
	});

	// ─── fw_itm_read ──────────────────────────────────────────────────────────

	test('fw_itm_read when not connected returns not connected message', async () => {
		const tools = buildRTTTools({} as any, makeMockRTTService() as any, makeMockITMService({ status: { active: false } }) as any);
		const tool = tools.find(t => t.name === 'fw_itm_read')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('not connected') || result.toLowerCase().includes('fw_itm_start'));
	});

	test('fw_itm_read when connected returns ITM frames', async () => {
		const tools = buildRTTTools({} as any, makeMockRTTService() as any, makeMockITMService({ status: { active: true } }) as any);
		const tool = tools.find(t => t.name === 'fw_itm_read')!;
		const result = await tool.execute({ stimulus: 0, lines: 10 });
		assert.ok(result.includes('Tick') || result.includes('ITM') || result.includes('1000'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_swo_profile ───────────────────────────────────────────────────────

	test('fw_swo_profile when not connected returns not connected message', async () => {
		const tools = buildRTTTools({} as any, makeMockRTTService() as any, makeMockITMService({ status: { active: false } }) as any);
		const tool = tools.find(t => t.name === 'fw_swo_profile')!;
		const result = await tool.execute({ durationMs: 1000 });
		assert.ok(result.toLowerCase().includes('not connected') || result.toLowerCase().includes('fw_itm_start'));
	});

	test('fw_swo_profile when connected returns top functions with percentages', async () => {
		const tools = buildRTTTools({} as any, makeMockRTTService() as any, makeMockITMService({ status: { active: true } }) as any);
		const tool = tools.find(t => t.name === 'fw_swo_profile')!;
		const result = await tool.execute({ durationMs: 2000 });
		assert.ok(result.includes('HAL_UART_Transmit') || result.includes('42'), `Result: ${result.slice(0, 200)}`);
		assert.ok(result.includes('%') || result.includes('profile'));
	});
});
