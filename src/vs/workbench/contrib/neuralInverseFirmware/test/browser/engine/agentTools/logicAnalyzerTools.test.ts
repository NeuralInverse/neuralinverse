/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildLogicAnalyzerTools } from '../../../../browser/engine/agentTools/logicAnalyzerTools.js';
import { ILogicCapture, IDecodedFrame } from '../../../../browser/engine/instruments/logicAnalyzer/logicAnalyzerTypes.js';

function makeMockLAService(overrides: {
	connected?: boolean;
	backend?: string;
	channels?: number;
	maxMHz?: number;
	protocols?: string[];
	captureFrames?: IDecodedFrame[];
	captureShouldThrow?: boolean;
} = {}) {
	const captureId = 'la_1234567890';
	const defaultFrames: IDecodedFrame[] = overrides.captureFrames ?? [
		{ timestamp: 0.000123, protocol: 'i2c', address: 0x48, dataHex: '02', dataAscii: '.', direction: 'write' },
		{ timestamp: 0.000456, protocol: 'i2c', address: 0x48, dataHex: 'FF 00', dataAscii: '..', direction: 'read' },
	];

	const captureStore = new Map<string, ILogicCapture>();

	return {
		_serviceBrand: undefined as any,
		detect: async () => ({
			connected: overrides.connected ?? false,
			backend: overrides.backend ?? 'saleae',
			availableChannels: overrides.channels ?? 16,
			maxSampleRateMHz: overrides.maxMHz ?? 500,
			supportedProtocols: overrides.protocols ?? ['uart', 'i2c', 'spi', 'can'],
			error: overrides.connected ? undefined : 'Connection refused on port 10430',
		}),
		captureChannels: async (channels: any[], durationSec: number, sampleRate: number) => {
			if (overrides.captureShouldThrow) { throw new Error('device not connected'); }
			const cap: ILogicCapture = {
				captureId,
				backend: overrides.backend ?? 'saleae',
				channels,
				durationSec,
				sampleRate,
				frames: [],
			};
			captureStore.set(captureId, cap);
			return cap;
		},
		decodeProtocol: async (id: string, _config: any) => {
			const cap = captureStore.get(id);
			if (cap) { cap.frames = defaultFrames; }
			return defaultFrames;
		},
		armTrigger: async (_trigger: any, _config: any) => {
			const cap: ILogicCapture = {
				captureId,
				backend: 'saleae',
				channels: [],
				durationSec: 1,
				sampleRate: 12000000,
				frames: [],
			};
			captureStore.set(captureId, cap);
			return cap;
		},
		getCapture: (id: string) => captureStore.get(id),
	};
}

function makeMockSession(isActive = true) {
	return { session: { isActive, mcuConfig: { family: 'STM32F4', variant: 'STM32F407VGT6' } } };
}

suite('Logic Analyzer Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildLogicAnalyzerTools returns 5 tools', () => {
		const tools = buildLogicAnalyzerTools(makeMockSession() as any, makeMockLAService() as any);
		assert.strictEqual(tools.length, 5);
	});

	test('tool names are fw_la_status, fw_la_capture, fw_la_decode, fw_la_trigger, fw_la_export', () => {
		const tools = buildLogicAnalyzerTools(makeMockSession() as any, makeMockLAService() as any);
		const names = new Set(tools.map(t => t.name));
		assert.ok(names.has('fw_la_status'));
		assert.ok(names.has('fw_la_capture'));
		assert.ok(names.has('fw_la_decode'));
		assert.ok(names.has('fw_la_trigger'));
		assert.ok(names.has('fw_la_export'));
	});

	// ─── fw_la_status ─────────────────────────────────────────────────────────

	test('fw_la_status when not connected shows connection instructions', async () => {
		const tools = buildLogicAnalyzerTools(makeMockSession() as any, makeMockLAService({ connected: false }) as any);
		const tool = tools.find(t => t.name === 'fw_la_status')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('not detected') || result.toLowerCase().includes('connect'));
	});

	test('fw_la_status when connected shows backend and channels', async () => {
		const tools = buildLogicAnalyzerTools(makeMockSession() as any, makeMockLAService({
			connected: true, backend: 'saleae', channels: 16, maxMHz: 500,
			protocols: ['uart', 'i2c', 'spi', 'can', 'lin'],
		}) as any);
		const tool = tools.find(t => t.name === 'fw_la_status')!;
		const result = await tool.execute({});
		assert.ok(result.includes('SALEAE') || result.includes('saleae') || result.includes('connected'));
		assert.ok(result.includes('16') || result.includes('Channels'));
		assert.ok(result.includes('uart') || result.includes('i2c'));
	});

	// ─── fw_la_capture ────────────────────────────────────────────────────────

	test('fw_la_capture with no active session returns message', async () => {
		const tools = buildLogicAnalyzerTools(makeMockSession(false) as any, makeMockLAService() as any);
		const tool = tools.find(t => t.name === 'fw_la_capture')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_la_capture returns captureId', async () => {
		const tools = buildLogicAnalyzerTools(makeMockSession() as any, makeMockLAService() as any);
		const tool = tools.find(t => t.name === 'fw_la_capture')!;
		const result = await tool.execute({ durationSec: 1, sampleRate: 12000000 });
		assert.ok(result.includes('la_') || result.includes('Capture'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_la_capture with explicit channels uses them', async () => {
		const tools = buildLogicAnalyzerTools(makeMockSession() as any, makeMockLAService() as any);
		const tool = tools.find(t => t.name === 'fw_la_capture')!;
		const result = await tool.execute({
			channels: [{ id: 0, label: 'SDA', threshold: 1.65, pullup: false }],
			durationSec: 2,
		});
		assert.ok(result.includes('SDA') || result.includes('la_'));
	});

	test('fw_la_capture shows sample rate in MHz', async () => {
		const tools = buildLogicAnalyzerTools(makeMockSession() as any, makeMockLAService() as any);
		const tool = tools.find(t => t.name === 'fw_la_capture')!;
		const result = await tool.execute({ sampleRate: 12000000 });
		assert.ok(result.includes('12') || result.includes('MHz'));
	});

	// ─── fw_la_decode ─────────────────────────────────────────────────────────

	test('fw_la_decode without captureId returns error', async () => {
		const tools = buildLogicAnalyzerTools(makeMockSession() as any, makeMockLAService() as any);
		const tool = tools.find(t => t.name === 'fw_la_decode')!;
		const result = await tool.execute({ protocol: 'i2c' });
		assert.ok(result.toLowerCase().includes('provide') || result.toLowerCase().includes('captureid'));
	});

	test('fw_la_decode with valid captureId returns decoded frames', async () => {
		const la = makeMockLAService();
		const tools = buildLogicAnalyzerTools(makeMockSession() as any, la as any);
		// First capture to register captureId
		const capTool = tools.find(t => t.name === 'fw_la_capture')!;
		await capTool.execute({ durationSec: 1 });

		const decodeTool = tools.find(t => t.name === 'fw_la_decode')!;
		const result = await decodeTool.execute({ captureId: 'la_1234567890', protocol: 'i2c' });
		assert.ok(result.includes('I2C') || result.includes('frames') || result.includes('0x48'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_la_decode with no frames shows no activity message', async () => {
		const la = makeMockLAService({ captureFrames: [] });
		const tools = buildLogicAnalyzerTools(makeMockSession() as any, la as any);
		const capTool = tools.find(t => t.name === 'fw_la_capture')!;
		await capTool.execute({ durationSec: 1 });

		const decodeTool = tools.find(t => t.name === 'fw_la_decode')!;
		const result = await decodeTool.execute({ captureId: 'la_1234567890', protocol: 'uart' });
		assert.ok(result.toLowerCase().includes('no') && result.toLowerCase().includes('frames'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_la_trigger ────────────────────────────────────────────────────────

	test('fw_la_trigger with no active session returns message', async () => {
		const tools = buildLogicAnalyzerTools(makeMockSession(false) as any, makeMockLAService() as any);
		const tool = tools.find(t => t.name === 'fw_la_trigger')!;
		const result = await tool.execute({ channel: 0 });
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_la_trigger returns captureId after trigger fires', async () => {
		const tools = buildLogicAnalyzerTools(makeMockSession() as any, makeMockLAService() as any);
		const tool = tools.find(t => t.name === 'fw_la_trigger')!;
		const result = await tool.execute({ channel: 0, edge: 'rising', durationSec: 1 });
		assert.ok(result.includes('la_') || result.includes('Trigger'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_la_export ─────────────────────────────────────────────────────────

	test('fw_la_export with missing captureId returns error', async () => {
		const tools = buildLogicAnalyzerTools(makeMockSession() as any, makeMockLAService() as any);
		const tool = tools.find(t => t.name === 'fw_la_export')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('provide') || result.toLowerCase().includes('captureid'));
	});

	test('fw_la_export with unknown captureId returns not found message', async () => {
		const tools = buildLogicAnalyzerTools(makeMockSession() as any, makeMockLAService() as any);
		const tool = tools.find(t => t.name === 'fw_la_export')!;
		const result = await tool.execute({ captureId: 'la_nonexistent' });
		assert.ok(result.toLowerCase().includes('not found') || result.toLowerCase().includes('re-run'));
	});

	test('fw_la_export with no decoded frames prompts decode first', async () => {
		const la = makeMockLAService();
		const tools = buildLogicAnalyzerTools(makeMockSession() as any, la as any);
		// Capture but don't decode
		const capTool = tools.find(t => t.name === 'fw_la_capture')!;
		await capTool.execute({ durationSec: 1 });

		const exportTool = tools.find(t => t.name === 'fw_la_export')!;
		const result = await exportTool.execute({ captureId: 'la_1234567890' });
		assert.ok(result.toLowerCase().includes('no decoded frames') || result.toLowerCase().includes('fw_la_decode'));
	});
});
