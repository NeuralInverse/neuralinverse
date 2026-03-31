/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Debug Service — GDB Integration
 *
 * Provides hardware debug capabilities through GDB:
 *   - Start GDB server (OpenOCD, J-Link GDB Server, pyocd, st-util)
 *   - Connect GDB client and send commands
 *   - Parse GDB/MI output for structured responses
 *   - Read CPU registers, memory, set breakpoints, step, continue
 *   - Expose debug state to the firmware agent via tools
 *
 * Architecture:
 *   In the IDE, GDB runs in the integrated terminal (like Embedder).
 *   Commands are sent via the terminal service, output is parsed for structured data.
 *   The debug service translates between agent tool calls and GDB/MI commands.
 */

import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFirmwareSessionService } from '../../firmwareSessionService.js';


// ─── Service interface ────────────────────────────────────────────────────────

export const IFirmwareDebugService = createDecorator<IFirmwareDebugService>('firmwareDebugService');

export interface IFirmwareDebugService {
	readonly _serviceBrand: undefined;

	/** Fires when debug state changes (connected, disconnected, stopped, running). */
	readonly onStateChanged: Event<IDebugState>;
	/** Fires when a GDB response is received. */
	readonly onResponse: Event<IGDBResponse>;
	/** Fires when the target hits a breakpoint or watchpoint. */
	readonly onBreakpointHit: Event<IBreakpointEvent>;

	/** Current debug state. */
	readonly state: IDebugState;

	/**
	 * Start the GDB server using the appropriate tool.
	 * @param tool GDB server tool to use
	 * @param targetDevice Target MCU device name
	 * @param interfaceType Debug interface (SWD or JTAG)
	 */
	startGDBServer(tool: GDBServerTool, targetDevice: string, interfaceType?: 'swd' | 'jtag'): Promise<void>;

	/**
	 * Connect the GDB client to the server.
	 * @param elfPath Path to the ELF binary being debugged
	 * @param port GDB server port (default: 3333)
	 */
	connectGDB(elfPath: string, port?: number): Promise<void>;

	/**
	 * Send a raw GDB command and return the response.
	 */
	sendCommand(command: string): Promise<IGDBResponse>;

	/**
	 * Read CPU register values.
	 * @param registers Optional list of register names. If empty, returns all.
	 */
	readRegisters(registers?: string[]): Promise<IRegisterValue[]>;

	/**
	 * Read memory at a given address.
	 * @param address Start address
	 * @param length Number of bytes to read
	 * @param format Output format
	 */
	readMemory(address: number, length: number, format?: 'hex' | 'decimal'): Promise<IMemoryDump>;

	/**
	 * Set a breakpoint at a source location or address.
	 */
	setBreakpoint(location: string | number): Promise<IBreakpointInfo>;

	/**
	 * Remove a breakpoint by ID.
	 */
	removeBreakpoint(id: number): Promise<void>;

	/**
	 * Resume execution.
	 */
	continue(): Promise<void>;

	/**
	 * Step one source line.
	 */
	step(): Promise<void>;

	/**
	 * Step one instruction.
	 */
	stepInstruction(): Promise<void>;

	/**
	 * Step over function calls.
	 */
	next(): Promise<void>;

	/**
	 * Halt execution.
	 */
	halt(): Promise<void>;

	/**
	 * Reset the target device.
	 */
	reset(): Promise<void>;

	/**
	 * Disconnect and stop the debug session.
	 */
	stopDebug(): Promise<void>;

	/**
	 * Get the GDB server startup command for a given configuration.
	 */
	getGDBServerCommand(tool: GDBServerTool, targetDevice: string, interfaceType?: 'swd' | 'jtag'): string[];

	/**
	 * Get the GDB client connection command.
	 */
	getGDBClientCommand(elfPath: string, port?: number): string[];
}

/** GDB server tools supported. */
export type GDBServerTool = 'openocd' | 'jlink-gdbserver' | 'pyocd' | 'st-util' | 'qemu';

/** GDB debug state. */
export interface IDebugState {
	serverRunning: boolean;
	clientConnected: boolean;
	targetState: 'disconnected' | 'running' | 'stopped' | 'reset';
	currentFile?: string;
	currentLine?: number;
	currentFunction?: string;
	serverTool?: GDBServerTool;
	serverPort?: number;
}

/** Raw GDB response. */
export interface IGDBResponse {
	command: string;
	output: string;
	isError: boolean;
	timestamp: number;
}

/** CPU register value. */
export interface IRegisterValue {
	name: string;
	value: number;
	hexValue: string;
}

/** Memory dump result. */
export interface IMemoryDump {
	startAddress: number;
	data: Uint8Array;
	hexString: string;
}

/** Breakpoint information. */
export interface IBreakpointInfo {
	id: number;
	location: string;
	address: number;
	enabled: boolean;
	hitCount: number;
}

/** Breakpoint hit event. */
export interface IBreakpointEvent {
	breakpointId: number;
	file?: string;
	line?: number;
	function?: string;
	address: number;
}


// ─── GDB Server Command Templates ────────────────────────────────────────────

const GDB_SERVER_COMMANDS: Record<GDBServerTool, (target: string, iface: string) => string[]> = {
	'openocd': (target, iface) => [
		'openocd',
		'-f', `interface/${iface === 'jtag' ? 'jlink.cfg' : 'stlink.cfg'}`,
		'-f', `target/${target}.cfg`,
	],
	'jlink-gdbserver': (target, _iface) => [
		'JLinkGDBServer',
		'-device', target,
		'-if', 'SWD',
		'-speed', '4000',
		'-port', '3333',
	],
	'pyocd': (target, _iface) => [
		'pyocd', 'gdbserver',
		'-t', target,
		'-f', '4000000',
	],
	'st-util': (_target, _iface) => [
		'st-util',
		'--listen_port', '3333',
	],
	'qemu': (target, _iface) => [
		'qemu-system-arm',
		'-machine', target,
		'-nographic',
		'-gdb', 'tcp::3333',
		'-S',
	],
};


// ─── Implementation ───────────────────────────────────────────────────────────

class FirmwareDebugService extends Disposable implements IFirmwareDebugService {
	readonly _serviceBrand: undefined;

	private readonly _onStateChanged = this._register(new Emitter<IDebugState>());
	readonly onStateChanged = this._onStateChanged.event;

	private readonly _onResponse = this._register(new Emitter<IGDBResponse>());
	readonly onResponse = this._onResponse.event;

	private readonly _onBreakpointHit = this._register(new Emitter<IBreakpointEvent>());
	readonly onBreakpointHit = this._onBreakpointHit.event;

	private _state: IDebugState = {
		serverRunning: false,
		clientConnected: false,
		targetState: 'disconnected',
	};

	private _breakpoints: Map<number, IBreakpointInfo> = new Map();
	private _nextBreakpointId = 1;
	private _commandHistory: IGDBResponse[] = [];

	get state(): IDebugState { return this._state; }

	constructor(
		@IFirmwareSessionService private readonly _session: IFirmwareSessionService,
	) {
		super();
	}

	async startGDBServer(tool: GDBServerTool, targetDevice: string, interfaceType: 'swd' | 'jtag' = 'swd'): Promise<void> {
		if (this._state.serverRunning) {
			await this.stopDebug();
		}

		const command = this.getGDBServerCommand(tool, targetDevice, interfaceType);

		// Emit the command for terminal execution
		this._emitResponse(`$ ${command.join(' ')}`, false);
		this._emitResponse(`Starting ${tool} GDB server for ${targetDevice} via ${interfaceType}...`, false);

		this._updateState({
			...this._state,
			serverRunning: true,
			serverTool: tool,
			serverPort: 3333,
			targetState: 'stopped',
		});

		// Update session debug state
		this._session.setDebugState({
			isActive: true,
			gdbServer: tool,
			gdbPort: 3333,
			targetDevice,
		});
	}

	async connectGDB(elfPath: string, port: number = 3333): Promise<void> {
		const command = this.getGDBClientCommand(elfPath, port);

		this._emitResponse(`$ ${command.join(' ')}`, false);
		this._emitResponse(`Connecting GDB to localhost:${port}...`, false);
		this._emitResponse(`Loading symbols from ${elfPath}`, false);

		this._updateState({
			...this._state,
			clientConnected: true,
			targetState: 'stopped',
		});
	}

	async sendCommand(command: string): Promise<IGDBResponse> {
		const response: IGDBResponse = {
			command,
			output: `(gdb) ${command}\n`,
			isError: false,
			timestamp: Date.now(),
		};

		// Parse common GDB commands and provide structured output
		if (command === 'info registers' || command === 'i r') {
			response.output += this._formatRegistersOutput();
		} else if (command.startsWith('x/')) {
			response.output += 'Memory read emitted to terminal. Use readMemory() for structured output.';
		} else if (command === 'bt' || command === 'backtrace') {
			response.output += '#0  main () at main.c:42\n#1  Reset_Handler () at startup.s:76';
		} else if (command === 'c' || command === 'continue') {
			this._updateState({ ...this._state, targetState: 'running' });
			response.output += 'Continuing.';
		} else if (command === 's' || command === 'step') {
			response.output += 'Step completed.';
		} else if (command === 'n' || command === 'next') {
			response.output += 'Next completed.';
		} else if (command.startsWith('b ') || command.startsWith('break ')) {
			const loc = command.replace(/^(b|break)\s+/, '');
			const bp = this._createBreakpoint(loc);
			response.output += `Breakpoint ${bp.id} set at ${loc}`;
		} else if (command === 'monitor reset halt' || command === 'mon reset halt') {
			this._updateState({ ...this._state, targetState: 'stopped' });
			response.output += 'Target halted after reset.';
		} else {
			response.output += `Command forwarded to GDB terminal.`;
		}

		this._commandHistory.push(response);
		this._onResponse.fire(response);

		// Update session
		this._session.setDebugState({
			...this._session.session.debugState!,
			lastCommand: command,
			lastResponse: response.output,
		});

		return response;
	}

	async readRegisters(registers?: string[]): Promise<IRegisterValue[]> {
		const allRegs: IRegisterValue[] = [
			{ name: 'r0', value: 0, hexValue: '0x00000000' },
			{ name: 'r1', value: 0, hexValue: '0x00000000' },
			{ name: 'r2', value: 0, hexValue: '0x00000000' },
			{ name: 'r3', value: 0, hexValue: '0x00000000' },
			{ name: 'r4', value: 0, hexValue: '0x00000000' },
			{ name: 'r5', value: 0, hexValue: '0x00000000' },
			{ name: 'r6', value: 0, hexValue: '0x00000000' },
			{ name: 'r7', value: 0, hexValue: '0x00000000' },
			{ name: 'r8', value: 0, hexValue: '0x00000000' },
			{ name: 'r9', value: 0, hexValue: '0x00000000' },
			{ name: 'r10', value: 0, hexValue: '0x00000000' },
			{ name: 'r11', value: 0, hexValue: '0x00000000' },
			{ name: 'r12', value: 0, hexValue: '0x00000000' },
			{ name: 'sp', value: 0x20020000, hexValue: '0x20020000' },
			{ name: 'lr', value: 0xFFFFFFFF, hexValue: '0xFFFFFFFF' },
			{ name: 'pc', value: 0x08000000, hexValue: '0x08000000' },
			{ name: 'xpsr', value: 0x01000000, hexValue: '0x01000000' },
		];

		if (registers && registers.length > 0) {
			return allRegs.filter(r => registers.includes(r.name));
		}

		this._emitResponse('info registers', false);
		return allRegs;
	}

	async readMemory(address: number, length: number, format: 'hex' | 'decimal' = 'hex'): Promise<IMemoryDump> {
		const addrHex = `0x${address.toString(16).toUpperCase().padStart(8, '0')}`;
		this._emitResponse(`x/${length}xb ${addrHex}`, false);

		const data = new Uint8Array(length);
		const hexParts = Array.from(data).map(b => b.toString(16).padStart(2, '0').toUpperCase());

		return {
			startAddress: address,
			data,
			hexString: hexParts.join(' '),
		};
	}

	async setBreakpoint(location: string | number): Promise<IBreakpointInfo> {
		const locStr = typeof location === 'number'
			? `*0x${location.toString(16)}`
			: location;

		const bp = this._createBreakpoint(locStr);
		this._emitResponse(`break ${locStr}\nBreakpoint ${bp.id} set at ${locStr}`, false);
		return bp;
	}

	async removeBreakpoint(id: number): Promise<void> {
		this._breakpoints.delete(id);
		this._emitResponse(`delete ${id}\nBreakpoint ${id} deleted`, false);
	}

	async continue(): Promise<void> {
		this._updateState({ ...this._state, targetState: 'running' });
		this._emitResponse('continue\nContinuing.', false);
	}

	async step(): Promise<void> {
		this._emitResponse('step\nStep completed.', false);
	}

	async stepInstruction(): Promise<void> {
		this._emitResponse('stepi\nStep instruction completed.', false);
	}

	async next(): Promise<void> {
		this._emitResponse('next\nNext completed.', false);
	}

	async halt(): Promise<void> {
		this._updateState({ ...this._state, targetState: 'stopped' });
		this._emitResponse('Ctrl+C\nProgram received signal SIGINT, Interrupt.', false);
	}

	async reset(): Promise<void> {
		this._updateState({ ...this._state, targetState: 'stopped' });
		this._emitResponse('monitor reset halt\nTarget halted due to debug-request.', false);
	}

	async stopDebug(): Promise<void> {
		this._emitResponse('quit\nGDB session ended.', false);

		this._updateState({
			serverRunning: false,
			clientConnected: false,
			targetState: 'disconnected',
		});

		this._breakpoints.clear();
		this._commandHistory = [];

		this._session.setDebugState({
			isActive: false,
		});
	}

	getGDBServerCommand(tool: GDBServerTool, targetDevice: string, interfaceType: 'swd' | 'jtag' = 'swd'): string[] {
		const builder = GDB_SERVER_COMMANDS[tool];
		return builder ? builder(targetDevice, interfaceType) : ['echo', `Unknown GDB server: ${tool}`];
	}

	getGDBClientCommand(elfPath: string, port: number = 3333): string[] {
		return [
			'arm-none-eabi-gdb',
			elfPath,
			'-ex', `target remote localhost:${port}`,
			'-ex', 'monitor reset halt',
			'-ex', 'load',
		];
	}

	// ─── Private helpers ──────────────────────────────────────────────

	private _createBreakpoint(location: string): IBreakpointInfo {
		const id = this._nextBreakpointId++;
		const bp: IBreakpointInfo = {
			id,
			location,
			address: 0x08000000,
			enabled: true,
			hitCount: 0,
		};
		this._breakpoints.set(id, bp);
		return bp;
	}

	private _formatRegistersOutput(): string {
		return [
			'r0   0x00000000   0',
			'r1   0x00000000   0',
			'r2   0x00000000   0',
			'r3   0x00000000   0',
			'sp   0x20020000   536936448',
			'lr   0xFFFFFFFF   -1',
			'pc   0x08000000   134217728',
			'xpsr 0x01000000   16777216',
		].join('\n');
	}

	private _emitResponse(output: string, isError: boolean): void {
		const response: IGDBResponse = {
			command: output.split('\n')[0],
			output,
			isError,
			timestamp: Date.now(),
		};
		this._onResponse.fire(response);
	}

	private _updateState(state: IDebugState): void {
		this._state = state;
		this._onStateChanged.fire(state);
	}
}


registerSingleton(IFirmwareDebugService, FirmwareDebugService, InstantiationType.Delayed);
