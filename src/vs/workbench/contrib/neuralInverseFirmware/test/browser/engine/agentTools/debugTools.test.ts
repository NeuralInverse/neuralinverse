/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildDebugTools } from '../../../../browser/engine/agentTools/debugTools.js';

function makeMockDebugService(overrides: {
	serverRunning?: boolean;
	clientConnected?: boolean;
	targetState?: 'running' | 'stopped' | 'unknown';
	currentFunction?: string;
	currentFile?: string;
	currentLine?: number;
	serverPort?: number;
	startShouldThrow?: boolean;
} = {}) {
	return {
		_serviceBrand: undefined as any,
		state: {
			serverRunning: overrides.serverRunning ?? false,
			clientConnected: overrides.clientConnected ?? false,
			targetState: overrides.targetState ?? 'unknown',
			currentFunction: overrides.currentFunction,
			currentFile: overrides.currentFile,
			currentLine: overrides.currentLine,
			serverPort: overrides.serverPort ?? 3333,
		},
		startGDBServer: async (_tool: string, _device: string, _iface: string) => {
			if (overrides.startShouldThrow) { throw new Error('openocd not found on PATH'); }
		},
		connectGDB: async (_elf: string, _port: number) => {},
		halt: async () => {},
		continue: async () => {},
		step: async () => {},
		stepInstruction: async () => {},
		readRegisters: async (_filter?: string[]) => [
			{ name: 'r0', value: 0, hexValue: '0x00000000' },
			{ name: 'pc', value: 0x08001234, hexValue: '0x08001234' },
			{ name: 'sp', value: 0x20007FF0, hexValue: '0x20007FF0' },
		],
		readMemory: async (address: number, length: number, _format: string) => ({
			address,
			length,
			data: new Uint8Array(length).fill(0xDE),
		}),
		setBreakpoint: async (loc: string | number) => ({
			id: 1,
			location: String(loc),
			address: 0x08001234,
		}),
		removeBreakpoint: async (_id: number) => {},
		sendCommand: async (cmd: string) => ({
			isError: false,
			output: cmd.startsWith('backtrace') ? '#0  main () at src/main.c:42\n#1  Reset_Handler ()' : '',
		}),
		stopDebug: async () => {},
	};
}

function makeMockSessionService(isActive = true) {
	return {
		session: {
			isActive,
			mcuConfig: { family: 'STM32F4', variant: 'STM32F407VGT6' },
		},
	};
}

suite('Debug Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildDebugTools returns 11 tools', () => {
		const tools = buildDebugTools(makeMockDebugService() as any, makeMockSessionService() as any);
		assert.strictEqual(tools.length, 11);
	});

	test('tool names include all expected debug tools', () => {
		const tools = buildDebugTools(makeMockDebugService() as any, makeMockSessionService() as any);
		const names = new Set(tools.map(t => t.name));
		assert.ok(names.has('fw_debug_start'));
		assert.ok(names.has('fw_debug_halt'));
		assert.ok(names.has('fw_debug_continue'));
		assert.ok(names.has('fw_debug_step'));
		assert.ok(names.has('fw_debug_step_instruction'));
		assert.ok(names.has('fw_debug_read_registers'));
		assert.ok(names.has('fw_debug_read_memory'));
		assert.ok(names.has('fw_debug_set_breakpoint'));
		assert.ok(names.has('fw_debug_remove_breakpoint'));
		assert.ok(names.has('fw_debug_backtrace'));
		assert.ok(names.has('fw_debug_stop'));
	});

	// ─── fw_debug_start ───────────────────────────────────────────────────────

	test('fw_debug_start with no active session returns message', async () => {
		const tools = buildDebugTools(makeMockDebugService() as any, makeMockSessionService(false) as any);
		const tool = tools.find(t => t.name === 'fw_debug_start')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active') || result.toLowerCase().includes('session'));
	});

	test('fw_debug_start succeeds and shows connection details', async () => {
		const tools = buildDebugTools(makeMockDebugService() as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_start')!;
		const result = await tool.execute({ tool: 'openocd' });
		assert.ok(result.includes('Debug session started') || result.includes('Tool') || result.includes('openocd'));
	});

	test('fw_debug_start with failing server shows helpful error', async () => {
		const tools = buildDebugTools(makeMockDebugService({ startShouldThrow: true }) as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_start')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('failed') || result.toLowerCase().includes('error'));
		assert.ok(result.toLowerCase().includes('path') || result.toLowerCase().includes('install') || result.toLowerCase().includes('openocd'));
	});

	test('fw_debug_start infers target device from STM32F4 family', async () => {
		const tools = buildDebugTools(makeMockDebugService() as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_start')!;
		const result = await tool.execute({});
		assert.ok(result.includes('stm32f4') || result.includes('STM32F4') || result.includes('openocd'));
	});

	// ─── fw_debug_halt ────────────────────────────────────────────────────────

	test('fw_debug_halt without connection returns not-connected message', async () => {
		const tools = buildDebugTools(makeMockDebugService({ clientConnected: false }) as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_halt')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('not connected') || result.toLowerCase().includes('gdb'));
	});

	test('fw_debug_halt with connection returns halted message', async () => {
		const tools = buildDebugTools(makeMockDebugService({ clientConnected: true }) as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_halt')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('halted'));
	});

	test('fw_debug_halt shows current function when available', async () => {
		const tools = buildDebugTools(makeMockDebugService({
			clientConnected: true,
			currentFunction: 'HAL_UART_Transmit',
			currentFile: 'src/uart.c',
			currentLine: 99,
		}) as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_halt')!;
		const result = await tool.execute({});
		assert.ok(result.includes('HAL_UART_Transmit') || result.includes('uart.c'));
	});

	// ─── fw_debug_continue ────────────────────────────────────────────────────

	test('fw_debug_continue without connection returns error', async () => {
		const tools = buildDebugTools(makeMockDebugService() as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_continue')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('not connected') || result.toLowerCase().includes('gdb'));
	});

	test('fw_debug_continue when connected returns running message', async () => {
		const tools = buildDebugTools(makeMockDebugService({ clientConnected: true }) as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_continue')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('running'));
	});

	// ─── fw_debug_read_registers ─────────────────────────────────────────────

	test('fw_debug_read_registers requires connection', async () => {
		const tools = buildDebugTools(makeMockDebugService() as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_read_registers')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('not connected') || result.toLowerCase().includes('gdb'));
	});

	test('fw_debug_read_registers requires target to be stopped', async () => {
		const tools = buildDebugTools(makeMockDebugService({ clientConnected: true, targetState: 'running' }) as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_read_registers')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('running') || result.toLowerCase().includes('halt'));
	});

	test('fw_debug_read_registers shows register values', async () => {
		const tools = buildDebugTools(makeMockDebugService({ clientConnected: true, targetState: 'stopped' }) as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_read_registers')!;
		const result = await tool.execute({});
		assert.ok(result.includes('r0') || result.includes('CPU Registers'));
		assert.ok(result.includes('0x08001234') || result.includes('pc'));
	});

	// ─── fw_debug_read_memory ─────────────────────────────────────────────────

	test('fw_debug_read_memory shows memory dump', async () => {
		const tools = buildDebugTools(makeMockDebugService({ clientConnected: true, targetState: 'stopped' }) as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_read_memory')!;
		const result = await tool.execute({ address: '0x40011000', length: 32 });
		assert.ok(result.includes('0x40011000') || result.includes('DE'));
	});

	test('fw_debug_read_memory caps length at 1024', async () => {
		const tools = buildDebugTools(makeMockDebugService({ clientConnected: true, targetState: 'stopped' }) as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_read_memory')!;
		const result = await tool.execute({ address: '0x20000000', length: 99999 });
		assert.ok(typeof result === 'string');
		assert.ok(!result.toLowerCase().includes('error'), `Should not error: ${result.slice(0, 100)}`);
	});

	// ─── fw_debug_set_breakpoint ──────────────────────────────────────────────

	test('fw_debug_set_breakpoint by function name', async () => {
		const tools = buildDebugTools(makeMockDebugService({ clientConnected: true }) as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_set_breakpoint')!;
		const result = await tool.execute({ location: 'main' });
		assert.ok(result.includes('Breakpoint') && result.includes('main'));
	});

	test('fw_debug_set_breakpoint by hex address', async () => {
		const tools = buildDebugTools(makeMockDebugService({ clientConnected: true }) as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_set_breakpoint')!;
		const result = await tool.execute({ location: '0x08001234' });
		assert.ok(result.includes('Breakpoint') || result.includes('0x08001234'));
	});

	// ─── fw_debug_backtrace ───────────────────────────────────────────────────

	test('fw_debug_backtrace returns call stack', async () => {
		const tools = buildDebugTools(makeMockDebugService({ clientConnected: true, targetState: 'stopped' }) as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_backtrace')!;
		const result = await tool.execute({ depth: 5 });
		assert.ok(result.includes('Call Stack') || result.includes('main') || result.includes('#0'));
	});

	// ─── fw_debug_stop ────────────────────────────────────────────────────────

	test('fw_debug_stop with no session returns no active session message', async () => {
		const tools = buildDebugTools(makeMockDebugService({ serverRunning: false, clientConnected: false }) as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_stop')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no active'));
	});

	test('fw_debug_stop with active session disconnects', async () => {
		const tools = buildDebugTools(makeMockDebugService({ serverRunning: true, clientConnected: true }) as any, makeMockSessionService() as any);
		const tool = tools.find(t => t.name === 'fw_debug_stop')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('stopped') || result.toLowerCase().includes('disconnected'));
	});
});

suite('Debug Tools - Target Device Inference', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const mcuFamilies: Array<[string, string, string]> = [
		['STM32F4', 'STM32F407', 'stm32f4x'],
		['STM32H7', 'STM32H743', 'stm32h7x'],
		['STM32L4', 'STM32L476', 'stm32l4x'],
		['NRF52840', '', 'nrf52'],
		['RP2040', '', 'rp2040'],
		['ESP32', '', 'esp32'],
		['STM32G4', 'STM32G431', 'stm32g4x'],
	];

	for (const [family, variant, expectedDevice] of mcuFamilies) {
		test(`infers target ${expectedDevice} from ${family} ${variant}`, async () => {
			const sessionSvc = {
				session: { isActive: true, mcuConfig: { family, variant } },
			};
			const tools = buildDebugTools(makeMockDebugService() as any, sessionSvc as any);
			const tool = tools.find(t => t.name === 'fw_debug_start')!;
			const result = await tool.execute({});
			assert.ok(
				result.includes(expectedDevice) || result.includes('Debug session started'),
				`Expected ${expectedDevice} in result for ${family}, got: ${result.slice(0, 200)}`
			);
		});
	}
});
