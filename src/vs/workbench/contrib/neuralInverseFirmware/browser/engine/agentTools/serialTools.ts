/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Serial agent tools \u2014 Phase 1b
 *
 * Connects the agent to the SerialMonitorService ring buffers and port
 * enumeration API. fw_serial_read is the key tool: lets the agent read
 * actual firmware output (logs, panics, asserts) from the RX ring buffer
 * without the user copy-pasting anything.
 */

import { IVoidInternalTool } from '../../../../void/browser/voidInternalToolService.js';
import { ISerialMonitorService } from '../serial/serialMonitorService.js';
import { ISerialPortConfig } from '../../../common/firmwareTypes.js';


export function buildSerialTools(serialMonitorService: ISerialMonitorService): IVoidInternalTool[] {
	return [
		_fwSerialListPorts(serialMonitorService),
		_fwSerialConnect(serialMonitorService),
		_fwSerialDisconnect(serialMonitorService),
		_fwSerialRead(serialMonitorService),
		_fwSerialClear(serialMonitorService),
		_fwSerialAutoBaud(serialMonitorService),
	];
}


function _fwSerialListPorts(svc: ISerialMonitorService): IVoidInternalTool {
	return {
		name: 'fw_serial_list_ports',
		description: 'List all available serial ports on this system. Identifies debug probes (ST-Link, J-Link, CMSIS-DAP) vs generic UART bridges (FTDI, CP210x, CH340). Use this before fw_serial_connect to find the right port.',
		params: {},
		execute: async () => {
			const ports = await svc.listPorts();
			if (ports.length === 0) {
				return 'No serial ports found. Ensure the device is connected and drivers are installed.';
			}
			const lines = [`Found ${ports.length} port(s):`, ''];
			for (const p of ports) {
				const probe = p.isDebugProbe ? ' [debug probe]' : '';
				const vendor = p.manufacturer ? ` \u2014 ${p.manufacturer}` : '';
				const ids = (p.vendorId && p.productId) ? ` (VID:${p.vendorId} PID:${p.productId})` : '';
				lines.push(`  ${p.path}${vendor}${ids}${probe}`);
			}
			return lines.join('\n');
		},
	};
}


function _fwSerialConnect(svc: ISerialMonitorService): IVoidInternalTool {
	return {
		name: 'fw_serial_connect',
		description: 'Connect to a serial port. Use fw_serial_list_ports first to find the port path.',
		params: {
			port: { description: 'Serial port path, e.g. "/dev/ttyUSB0", "/dev/cu.usbmodem1101", "COM3"' },
			baudRate: { description: 'Baud rate, e.g. 115200, 9600, 230400. Default: 115200' },
			dataBits: { description: 'Data bits: 7 or 8. Default: 8' },
			stopBits: { description: 'Stop bits: 1 or 2. Default: 1' },
			parity: { description: 'Parity: "none", "even", "odd". Default: "none"' },
		},
		execute: async (args: Record<string, any>) => {
			const config: ISerialPortConfig = {
				port: args.port as string,
				baudRate: typeof args.baudRate === 'number' ? args.baudRate : 115200,
				dataBits: typeof args.dataBits === 'number' ? args.dataBits as 7 | 8 : 8,
				stopBits: typeof args.stopBits === 'number' ? args.stopBits as 1 | 2 : 1,
				parity: (args.parity as 'none' | 'even' | 'odd') ?? 'none',
				flowControl: 'none',
			};
			await svc.connect(config);
			const state = svc.connectionState;
			return state.isConnected
				? `Connected to ${config.port} at ${config.baudRate} baud.`
				: `Connection attempt sent to ${config.port}. Check serial tab if port does not appear.`;
		},
	};
}


function _fwSerialDisconnect(svc: ISerialMonitorService): IVoidInternalTool {
	return {
		name: 'fw_serial_disconnect',
		description: 'Disconnect from the current serial port.',
		params: {},
		execute: async () => {
			const state = svc.connectionState;
			if (!state.isConnected) {
				return 'No serial port is currently connected.';
			}
			const port = state.port ?? 'unknown';
			await svc.disconnect();
			return `Disconnected from ${port}.`;
		},
	};
}


function _fwSerialRead(svc: ISerialMonitorService): IVoidInternalTool {
	return {
		name: 'fw_serial_read',
		description: 'Read received data from the serial RX buffer. Returns the most recent lines from firmware running on the target device. Use this to read log output, panic messages, assert failures, and debug prints without the user having to copy-paste terminal output.',
		params: {
			lines: { description: 'Number of most-recent lines to return. Default: 50, max: 200.' },
			since: { description: 'Optional: only return lines with timestamp >= this value (ms since epoch). Use the timestamp from the last fw_serial_read call to get only new lines.' },
		},
		execute: async (args: Record<string, any>) => {
			const state = svc.connectionState;
			const limit = Math.min(typeof args.lines === 'number' ? args.lines : 50, 200);
			const since = typeof args.since === 'number' ? args.since : 0;

			let buf = svc.rxBuffer;
			if (since > 0) {
				buf = buf.filter(l => l.timestamp >= since);
			}

			const slice = buf.slice(-limit);

			if (slice.length === 0) {
				const connected = state.isConnected
					? `Connected to ${state.port} at ${state.baudRate} baud \u2014 no data received yet.`
					: 'Not connected. Use fw_serial_connect first.';
				return connected;
			}

			const header = `Serial RX \u2014 ${slice.length} line(s) (${state.isConnected ? `live: ${state.port}` : 'disconnected'}):`;
			const body = slice.map(l => {
				const ts = new Date(l.timestamp).toISOString().slice(11, 23);
				return `[${ts}] ${l.text}`;
			}).join('\n');

			return `${header}\n\n${body}`;
		},
	};
}


function _fwSerialClear(svc: ISerialMonitorService): IVoidInternalTool {
	return {
		name: 'fw_serial_clear',
		description: 'Clear the serial RX and TX ring buffers. Use before a test run to get clean output.',
		params: {},
		execute: async () => {
			svc.clearBuffers();
			return 'Serial RX/TX buffers cleared.';
		},
	};
}


function _fwSerialAutoBaud(svc: ISerialMonitorService): IVoidInternalTool {
	return {
		name: 'fw_serial_auto_baud',
		description: 'Auto-detect the baud rate of a serial port by analyzing received data. Tests common baud rates and returns the most likely one based on data readability heuristics.',
		params: {
			port: { description: 'Serial port path to test, e.g. "/dev/ttyUSB0"' },
		},
		execute: async (args: Record<string, any>) => {
			const port = args.port as string;
			const detected = await svc.autoDetectBaudRate(port);
			if (detected !== undefined) {
				return `Detected baud rate: ${detected} for ${port}\n\nUse fw_serial_connect with baudRate: ${detected} to connect.`;
			}
			return `Could not auto-detect baud rate on ${port}. Try common rates: 9600, 115200, 230400, 460800, 921600.`;
		},
	};
}
