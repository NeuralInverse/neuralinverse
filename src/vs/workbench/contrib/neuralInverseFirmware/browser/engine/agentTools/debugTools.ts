/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Debug agent tools — Phase 1a
 *
 * Connects the agent to FirmwareDebugService: GDB server management,
 * CPU register and memory reads, breakpoints, step/continue.
 *
 * This closes the biggest gap vs Embedder: the agent can now set a
 * breakpoint, halt the target, read registers and peripheral memory,
 * walk the call stack, and suggest a fix — all in one conversation turn.
 */

import { IVoidInternalTool } from '../../../../void/browser/voidInternalToolService.js';
import { IFirmwareDebugService, GDBServerTool } from '../debug/debugService.js';
import { IFirmwareSessionService } from '../../firmwareSessionService.js';


export function buildDebugTools(
	debugService: IFirmwareDebugService,
	sessionService: IFirmwareSessionService,
): IVoidInternalTool[] {
	return [
		_fwDebugStart(debugService, sessionService),
		_fwDebugHalt(debugService),
		_fwDebugContinue(debugService),
		_fwDebugStep(debugService),
		_fwDebugStepInstruction(debugService),
		_fwDebugReadRegisters(debugService),
		_fwDebugReadMemory(debugService),
		_fwDebugSetBreakpoint(debugService),
		_fwDebugRemoveBreakpoint(debugService),
		_fwDebugBacktrace(debugService),
		_fwDebugStop(debugService),
	];
}


function _fwDebugStart(svc: IFirmwareDebugService, session: IFirmwareSessionService): IVoidInternalTool {
	return {
		name: 'fw_debug_start',
		description: 'Start a GDB debug session. Launches the GDB server (OpenOCD, J-Link, pyocd, etc.) and connects GDB to the target device. Call fw_build first to ensure a fresh ELF exists.',
		params: {
			elfPath: { description: 'Path to the ELF binary to debug. Auto-detected from build output if omitted.' },
			tool: { description: 'GDB server tool: "openocd" (default), "jlink-gdbserver", "pyocd", "st-util", "qemu"' },
			targetDevice: { description: 'Target device name for GDB server config, e.g. "stm32f4x", "nrf52840", "rp2040". Auto-detected from session MCU if omitted.' },
			interface: { description: 'Debug interface: "swd" (default) or "jtag"' },
		},
		execute: async (args: Record<string, any>) => {
			const s = session.session;
			if (!s.isActive) { return 'No active firmware session.'; }

			const tool = (args.tool as GDBServerTool | undefined) ?? 'openocd';
			const targetDevice = (args.targetDevice as string | undefined)
				?? _inferTargetDevice(s.mcuConfig?.family ?? '', s.mcuConfig?.variant ?? '');
			const iface = (args.interface as 'swd' | 'jtag' | undefined) ?? 'swd';
			const elfPath = (args.elfPath as string | undefined) ?? 'build/firmware.elf';

			try {
				await svc.startGDBServer(tool, targetDevice, iface);
				await svc.connectGDB(elfPath, svc.state.serverPort);

				const state = svc.state;
				return [
					`Debug session started.`,
					`  Tool:       ${tool}`,
					`  Target:     ${targetDevice} (${iface.toUpperCase()})`,
					`  Port:       ${state.serverPort ?? 3333}`,
					`  ELF:        ${elfPath}`,
					`  Target:     ${state.targetState}`,
					'',
					'Next steps:',
					'  fw_debug_set_breakpoint("main") — set a breakpoint',
					'  fw_debug_continue() — run to breakpoint',
					'  fw_debug_read_registers() — inspect CPU state',
				].join('\n');
			} catch (err: any) {
				return [
					`Failed to start debug session: ${err?.message ?? String(err)}`,
					'',
					'Common fixes:',
					`  - Verify ${tool} is installed and on PATH`,
					`  - Check that the debug probe is connected`,
					`  - Confirm target device name: ${targetDevice}`,
					`  - Try fw_detect_flash_tools to see what's available`,
				].join('\n');
			}
		},
	};
}


function _fwDebugHalt(svc: IFirmwareDebugService): IVoidInternalTool {
	return {
		name: 'fw_debug_halt',
		description: 'Halt the target CPU. Required before reading registers or memory. The target must be running (call fw_debug_continue first if it was already halted).',
		params: {},
		execute: async () => {
			if (!svc.state.clientConnected) { return 'GDB is not connected. Call fw_debug_start first.'; }
			await svc.halt();
			const state = svc.state;
			const loc = state.currentFunction
				? ` — halted in ${state.currentFunction}()${state.currentFile ? ` at ${state.currentFile}:${state.currentLine}` : ''}`
				: '';
			return `Target halted${loc}. Ready for register/memory reads.`;
		},
	};
}


function _fwDebugContinue(svc: IFirmwareDebugService): IVoidInternalTool {
	return {
		name: 'fw_debug_continue',
		description: 'Resume execution of the halted target. The target will run until it hits a breakpoint, fault, or is halted again with fw_debug_halt.',
		params: {},
		execute: async () => {
			if (!svc.state.clientConnected) { return 'GDB is not connected. Call fw_debug_start first.'; }
			await svc.continue();
			return 'Target running. Use fw_debug_halt to stop, or fw_serial_read to monitor output.';
		},
	};
}


function _fwDebugStep(svc: IFirmwareDebugService): IVoidInternalTool {
	return {
		name: 'fw_debug_step',
		description: 'Step one source line. Steps into function calls. Target must be halted first.',
		params: {},
		execute: async () => {
			if (!svc.state.clientConnected) { return 'GDB is not connected. Call fw_debug_start first.'; }
			await svc.step();
			const state = svc.state;
			const loc = state.currentFunction
				? `${state.currentFunction}()${state.currentFile ? ` — ${state.currentFile}:${state.currentLine}` : ''}`
				: 'unknown location';
			return `Stepped to: ${loc}`;
		},
	};
}


function _fwDebugStepInstruction(svc: IFirmwareDebugService): IVoidInternalTool {
	return {
		name: 'fw_debug_step_instruction',
		description: 'Step one machine instruction (stepi). Use for register-level debugging or ISR tracing where source-line stepping is too coarse.',
		params: {},
		execute: async () => {
			if (!svc.state.clientConnected) { return 'GDB is not connected. Call fw_debug_start first.'; }
			await svc.stepInstruction();
			const state = svc.state;
			const loc = state.currentFunction
				? `${state.currentFunction}() — ${state.currentFile ?? ''}:${state.currentLine ?? '?'}`
				: 'unknown';
			return `Instruction step complete. Location: ${loc}`;
		},
	};
}


function _fwDebugReadRegisters(svc: IFirmwareDebugService): IVoidInternalTool {
	return {
		name: 'fw_debug_read_registers',
		description: 'Read CPU register values from the halted target. Returns r0–r15, sp, lr, pc, xpsr as hex values. Call fw_debug_halt first.',
		params: {
			registers: { description: 'Optional comma-separated list of specific register names to read, e.g. "r0,r1,pc,sp". Omit to read all.' },
		},
		execute: async (args: Record<string, any>) => {
			if (!svc.state.clientConnected) { return 'GDB is not connected. Call fw_debug_start first.'; }
			if (svc.state.targetState !== 'stopped') { return 'Target is running. Call fw_debug_halt first.'; }

			const filterList = args.registers
				? (args.registers as string).split(',').map(r => r.trim().toLowerCase())
				: undefined;

			const regs = await svc.readRegisters(filterList);

			if (regs.length === 0) { return 'No registers returned. Target may not be halted.'; }

			const lines = ['CPU Registers:', ''];
			// Group into rows of 4 for readability
			for (let i = 0; i < regs.length; i += 4) {
				const row = regs.slice(i, i + 4);
				lines.push('  ' + row.map(r => `${r.name.padEnd(5)} = ${r.hexValue}`).join('   '));
			}

			const state = svc.state;
			if (state.currentFunction) {
				lines.push('', `Location: ${state.currentFunction}()${state.currentFile ? ` — ${state.currentFile}:${state.currentLine}` : ''}`);
			}

			return lines.join('\n');
		},
	};
}


function _fwDebugReadMemory(svc: IFirmwareDebugService): IVoidInternalTool {
	return {
		name: 'fw_debug_read_memory',
		description: 'Read memory at an address from the halted target. Use to inspect live peripheral register values, stack frames, DMA buffers, or any memory-mapped region. Call fw_debug_halt first.',
		params: {
			address: { description: 'Start address as hex string (e.g. "0x40011000") or decimal number' },
			length: { description: 'Number of bytes to read. Default: 64. Max: 1024.' },
			format: { description: '"hex" (default) or "decimal"' },
		},
		execute: async (args: Record<string, any>) => {
			if (!svc.state.clientConnected) { return 'GDB is not connected. Call fw_debug_start first.'; }
			if (svc.state.targetState !== 'stopped') { return 'Target is running. Call fw_debug_halt first.'; }

			const addrArg = args.address as string | number;
			const address = typeof addrArg === 'string'
				? parseInt(addrArg, addrArg.startsWith('0x') || addrArg.startsWith('0X') ? 16 : 10)
				: addrArg;
			const length = Math.min(typeof args.length === 'number' ? args.length : 64, 1024);
			const format = (args.format as 'hex' | 'decimal' | undefined) ?? 'hex';

			const dump = await svc.readMemory(address, length, format);

			const lines = [
				`Memory at 0x${address.toString(16).toUpperCase().padStart(8, '0')} (${length} bytes):`,
				'',
			];

			// Format as 16 bytes per row
			const bytes = Array.from(dump.data);
			for (let i = 0; i < bytes.length; i += 16) {
				const row = bytes.slice(i, i + 16);
				const addrStr = `0x${(address + i).toString(16).toUpperCase().padStart(8, '0')}`;
				const hexStr = row.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
				const ascii = row.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
				lines.push(`  ${addrStr}  ${hexStr.padEnd(48)}  ${ascii}`);
			}

			return lines.join('\n');
		},
	};
}


function _fwDebugSetBreakpoint(svc: IFirmwareDebugService): IVoidInternalTool {
	return {
		name: 'fw_debug_set_breakpoint',
		description: 'Set a breakpoint by source location or function name. Use fw_debug_continue after setting to run to the breakpoint.',
		params: {
			location: { description: 'Breakpoint location: function name (e.g. "HAL_UART_Transmit"), file:line (e.g. "main.c:42"), or hex address (e.g. "0x08001234")' },
		},
		execute: async (args: Record<string, any>) => {
			if (!svc.state.clientConnected) { return 'GDB is not connected. Call fw_debug_start first.'; }

			const location = args.location as string;
			// If it looks like an address, parse to number
			const loc: string | number = (location.startsWith('0x') || location.startsWith('0X'))
				? parseInt(location, 16)
				: location;

			const bp = await svc.setBreakpoint(loc);
			return `Breakpoint ${bp.id} set at ${bp.location} (address: 0x${bp.address.toString(16).toUpperCase().padStart(8, '0')})`;
		},
	};
}


function _fwDebugRemoveBreakpoint(svc: IFirmwareDebugService): IVoidInternalTool {
	return {
		name: 'fw_debug_remove_breakpoint',
		description: 'Remove a breakpoint by its ID. Use the ID returned by fw_debug_set_breakpoint.',
		params: {
			id: { description: 'Breakpoint ID to remove (number returned by fw_debug_set_breakpoint)' },
		},
		execute: async (args: Record<string, any>) => {
			if (!svc.state.clientConnected) { return 'GDB is not connected.'; }
			const id = typeof args.id === 'number' ? args.id : parseInt(String(args.id), 10);
			await svc.removeBreakpoint(id);
			return `Breakpoint ${id} removed.`;
		},
	};
}


function _fwDebugBacktrace(svc: IFirmwareDebugService): IVoidInternalTool {
	return {
		name: 'fw_debug_backtrace',
		description: 'Get the call stack (backtrace) of the halted target. Shows function names, file paths, and line numbers. Essential for diagnosing crashes, HardFaults, and unexpected halts.',
		params: {
			depth: { description: 'Maximum stack frames to return. Default: 20.' },
		},
		execute: async (args: Record<string, any>) => {
			if (!svc.state.clientConnected) { return 'GDB is not connected. Call fw_debug_start first.'; }
			if (svc.state.targetState !== 'stopped') { return 'Target is running. Call fw_debug_halt first.'; }

			const depth = typeof args.depth === 'number' ? args.depth : 20;
			const response = await svc.sendCommand(`backtrace ${depth}`);

			if (response.isError) {
				return `Backtrace failed: ${response.output}`;
			}

			return `Call Stack:\n\n${response.output}`;
		},
	};
}


function _fwDebugStop(svc: IFirmwareDebugService): IVoidInternalTool {
	return {
		name: 'fw_debug_stop',
		description: 'Stop the GDB debug session. Disconnects GDB and stops the GDB server process.',
		params: {},
		execute: async () => {
			if (!svc.state.serverRunning && !svc.state.clientConnected) {
				return 'No active debug session.';
			}
			await svc.stopDebug();
			return 'Debug session stopped. GDB server and client disconnected.';
		},
	};
}


// ─── Helper ───────────────────────────────────────────────────────────────────

function _inferTargetDevice(family: string, variant: string): string {
	const f = family.toUpperCase();
	const v = variant.toUpperCase();

	if (f.startsWith('STM32F0')) { return 'stm32f0x'; }
	if (f.startsWith('STM32F1')) { return 'stm32f1x'; }
	if (f.startsWith('STM32F2')) { return 'stm32f2x'; }
	if (f.startsWith('STM32F3')) { return 'stm32f3x'; }
	if (f.startsWith('STM32F4') || f.startsWith('STM32F40') || f.startsWith('STM32F41')) { return 'stm32f4x'; }
	if (f.startsWith('STM32F7')) { return 'stm32f7x'; }
	if (f.startsWith('STM32G0')) { return 'stm32g0x'; }
	if (f.startsWith('STM32G4')) { return 'stm32g4x'; }
	if (f.startsWith('STM32H7') || f.startsWith('STM32H74') || f.startsWith('STM32H75')) { return 'stm32h7x'; }
	if (f.startsWith('STM32L0')) { return 'stm32l0x'; }
	if (f.startsWith('STM32L4')) { return 'stm32l4x'; }
	if (f.startsWith('STM32L5')) { return 'stm32l5x'; }
	if (f.startsWith('STM32U5')) { return 'stm32u5x'; }
	if (f.startsWith('STM32WB')) { return 'stm32wbx'; }
	if (f.startsWith('NRF52') || v.includes('NRF52')) { return 'nrf52'; }
	if (f.startsWith('NRF53') || v.includes('NRF53')) { return 'nrf5340.cpu.app'; }
	if (f.startsWith('RP2040') || v.includes('RP2040')) { return 'rp2040'; }
	if (f.startsWith('RP2350') || v.includes('RP2350')) { return 'rp2350'; }
	if (f.startsWith('ESP32')) { return 'esp32'; }

	// Generic Cortex-M fallback
	return 'cortex_m';
}
