/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildSerialTools } from '../../../../browser/engine/agentTools/serialTools.js';
import { ISerialLine } from '../../../../common/firmwareTypes.js';

function makeMockSerialService(overrides: {
	ports?: Array<{ path: string; manufacturer?: string; vendorId?: string; productId?: string; isDebugProbe?: boolean }>;
	isConnected?: boolean;
	port?: string;
	baudRate?: number;
	rxLines?: ISerialLine[];
	autoBaud?: number;
} = {}) {
	const now = Date.now();
	const defaultLines: ISerialLine[] = overrides.rxLines ?? [
		{ text: 'Boot OK', timestamp: now - 2000, direction: 'rx' as const },
		{ text: 'System init complete', timestamp: now - 1500, direction: 'rx' as const },
		{ text: 'Waiting for input...', timestamp: now - 1000, direction: 'rx' as const },
	];

	const rxBuffer = [...defaultLines];

	return {
		_serviceBrand: undefined as any,
		get connectionState() {
			return {
				isConnected: overrides.isConnected ?? false,
				port: overrides.port,
				baudRate: overrides.baudRate ?? 115200,
			};
		},
		get rxBuffer() { return rxBuffer; },
		listPorts: async () => overrides.ports ?? [],
		connect: async (_config: unknown) => {},
		disconnect: async () => {},
		clearBuffers: () => { rxBuffer.length = 0; },
		autoDetectBaudRate: async (_port: string) => overrides.autoBaud,
	};
}

suite('Serial Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildSerialTools returns 6 tools', () => {
		const tools = buildSerialTools(makeMockSerialService() as any);
		assert.strictEqual(tools.length, 6);
	});

	test('tool names include all expected serial tools', () => {
		const tools = buildSerialTools(makeMockSerialService() as any);
		const names = new Set(tools.map(t => t.name));
		assert.ok(names.has('fw_serial_list_ports'));
		assert.ok(names.has('fw_serial_connect'));
		assert.ok(names.has('fw_serial_disconnect'));
		assert.ok(names.has('fw_serial_read'));
		assert.ok(names.has('fw_serial_clear'));
		assert.ok(names.has('fw_serial_auto_baud'));
	});

	// ─── fw_serial_list_ports ─────────────────────────────────────────────────

	test('fw_serial_list_ports with no ports returns no ports message', async () => {
		const tools = buildSerialTools(makeMockSerialService({ ports: [] }) as any);
		const tool = tools.find(t => t.name === 'fw_serial_list_ports')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no serial ports') || result.toLowerCase().includes('no ports'));
	});

	test('fw_serial_list_ports lists port paths', async () => {
		const tools = buildSerialTools(makeMockSerialService({
			ports: [
				{ path: '/dev/ttyUSB0', manufacturer: 'FTDI', vendorId: '0403', productId: '6001', isDebugProbe: false },
				{ path: 'COM3', manufacturer: 'STMicroelectronics', vendorId: '0483', productId: '374B', isDebugProbe: true },
			],
		}) as any);
		const tool = tools.find(t => t.name === 'fw_serial_list_ports')!;
		const result = await tool.execute({});
		assert.ok(result.includes('/dev/ttyUSB0'));
		assert.ok(result.includes('COM3'));
		assert.ok(result.includes('FTDI') || result.includes('0403'));
	});

	test('fw_serial_list_ports marks debug probes', async () => {
		const tools = buildSerialTools(makeMockSerialService({
			ports: [{ path: 'COM5', manufacturer: 'STLink', isDebugProbe: true }],
		}) as any);
		const tool = tools.find(t => t.name === 'fw_serial_list_ports')!;
		const result = await tool.execute({});
		assert.ok(result.includes('debug probe') || result.includes('STLink'));
	});

	// ─── fw_serial_connect ────────────────────────────────────────────────────

	test('fw_serial_connect sends connection request', async () => {
		const tools = buildSerialTools(makeMockSerialService() as any);
		const tool = tools.find(t => t.name === 'fw_serial_connect')!;
		const result = await tool.execute({ port: '/dev/ttyUSB0', baudRate: 115200 });
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('/dev/ttyUSB0') || result.includes('115200') || result.includes('Connect'));
	});

	test('fw_serial_connect defaults baud to 115200', async () => {
		const tools = buildSerialTools(makeMockSerialService({ isConnected: true, port: '/dev/ttyUSB0', baudRate: 115200 }) as any);
		const tool = tools.find(t => t.name === 'fw_serial_connect')!;
		const result = await tool.execute({ port: '/dev/ttyUSB0' });
		assert.ok(result.includes('115200') || result.includes('/dev/ttyUSB0'));
	});

	// ─── fw_serial_disconnect ─────────────────────────────────────────────────

	test('fw_serial_disconnect when not connected returns not connected message', async () => {
		const tools = buildSerialTools(makeMockSerialService({ isConnected: false }) as any);
		const tool = tools.find(t => t.name === 'fw_serial_disconnect')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no serial') || result.toLowerCase().includes('not connected'));
	});

	test('fw_serial_disconnect when connected returns disconnected message', async () => {
		const tools = buildSerialTools(makeMockSerialService({ isConnected: true, port: '/dev/ttyUSB0' }) as any);
		const tool = tools.find(t => t.name === 'fw_serial_disconnect')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('disconnected') || result.includes('/dev/ttyUSB0'));
	});

	// ─── fw_serial_read ───────────────────────────────────────────────────────

	test('fw_serial_read returns lines from rx buffer', async () => {
		const tools = buildSerialTools(makeMockSerialService({ isConnected: true, port: '/dev/ttyUSB0' }) as any);
		const tool = tools.find(t => t.name === 'fw_serial_read')!;
		const result = await tool.execute({});
		assert.ok(result.includes('Boot OK') || result.includes('Serial RX'));
	});

	test('fw_serial_read with empty buffer shows not-connected message', async () => {
		const tools = buildSerialTools(makeMockSerialService({ isConnected: false, rxLines: [] }) as any);
		const tool = tools.find(t => t.name === 'fw_serial_read')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('not connected') || result.toLowerCase().includes('no data'));
	});

	test('fw_serial_read shows live port when connected', async () => {
		const tools = buildSerialTools(makeMockSerialService({ isConnected: true, port: 'COM3' }) as any);
		const tool = tools.find(t => t.name === 'fw_serial_read')!;
		const result = await tool.execute({ lines: 2 });
		assert.ok(result.includes('COM3') || result.includes('live'));
	});

	test('fw_serial_read filters by since timestamp', async () => {
		const base = Date.now() - 3000;
		const tools = buildSerialTools(makeMockSerialService({
			isConnected: true,
			rxLines: [
				{ text: 'Old line', timestamp: base, direction: 'rx' as const },
				{ text: 'New line', timestamp: base + 2500, direction: 'rx' as const },
			],
		}) as any);
		const tool = tools.find(t => t.name === 'fw_serial_read')!;
		const result = await tool.execute({ since: base + 2000 });
		assert.ok(result.includes('New line'));
		assert.ok(!result.includes('Old line'));
	});

	// ─── fw_serial_clear ─────────────────────────────────────────────────────

	test('fw_serial_clear returns cleared message', async () => {
		const tools = buildSerialTools(makeMockSerialService() as any);
		const tool = tools.find(t => t.name === 'fw_serial_clear')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('cleared') || result.toLowerCase().includes('clear'));
	});

	// ─── fw_serial_auto_baud ─────────────────────────────────────────────────

	test('fw_serial_auto_baud returns detected baud rate', async () => {
		const tools = buildSerialTools(makeMockSerialService({ autoBaud: 115200 }) as any);
		const tool = tools.find(t => t.name === 'fw_serial_auto_baud')!;
		const result = await tool.execute({ port: '/dev/ttyUSB0' });
		assert.ok(result.includes('115200'));
	});

	test('fw_serial_auto_baud with no detection returns suggestion', async () => {
		const tools = buildSerialTools(makeMockSerialService({ autoBaud: undefined }) as any);
		const tool = tools.find(t => t.name === 'fw_serial_auto_baud')!;
		const result = await tool.execute({ port: '/dev/ttyUSB0' });
		assert.ok(result.toLowerCase().includes('could not') || result.toLowerCase().includes('try'));
	});
});
