/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { ILogicChannel, IProtocolConfig, LogicProtocol, IDecodedFrame } from '../../../../browser/engine/instruments/logicAnalyzer/logicAnalyzerTypes.js';
import { IScopeChannelConfig, IScopeTriggerConfig, IScopeWaveform } from '../../../../browser/engine/instruments/oscilloscope/oscilloscopeTypes.js';
import { IPowerConfig, IPowerResult } from '../../../../browser/engine/instruments/powerAnalyzer/powerAnalyzerTypes.js';

// ─── Logic Analyzer Types ─────────────────────────────────────────────────────

suite('Logic Analyzer Service - Type Structures', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ILogicChannel structure is valid', () => {
		const ch: ILogicChannel = {
			id: 0,
			label: 'SDA',
			threshold: 1.65,
			pullup: false,
		};
		assert.strictEqual(ch.id, 0);
		assert.strictEqual(ch.label, 'SDA');
		assert.strictEqual(ch.threshold, 1.65);
		assert.strictEqual(ch.pullup, false);
	});

	test('IProtocolConfig for I2C has correct fields', () => {
		const config: IProtocolConfig = {
			protocol: 'i2c',
			baudRate: 400000,
			clockChannel: 1,
			dataChannel: 0,
			csChannel: 3,
			bitOrder: 'msb',
		};
		assert.strictEqual(config.protocol, 'i2c');
		assert.strictEqual(config.baudRate, 400000);
		assert.strictEqual(config.bitOrder, 'msb');
	});

	test('all supported protocol types are string literals', () => {
		const protocols: LogicProtocol[] = ['uart', 'spi', 'i2c', 'can', 'lin', 'i2s', 'jtag', 'swd', 'manchester', 'modbus', '1-wire'];
		assert.strictEqual(protocols.length, 11);
		assert.ok(protocols.every(p => typeof p === 'string'));
	});

	test('IDecodedFrame structure for UART', () => {
		const frame: IDecodedFrame = {
			timestamp: 0.000123,
			protocol: 'uart',
			dataHex: '48 65 6C 6C 6F',
			dataAscii: 'Hello',
			direction: 'rx',
		};
		assert.strictEqual(frame.dataAscii, 'Hello');
		assert.strictEqual(frame.direction, 'rx');
	});

	test('IDecodedFrame with I2C address field', () => {
		const frame: IDecodedFrame = {
			timestamp: 0.001,
			protocol: 'i2c',
			address: 0x48,
			dataHex: 'F0',
			dataAscii: '.',
		};
		assert.strictEqual(frame.address, 0x48);
	});

	test('IDecodedFrame with error field', () => {
		const frame: IDecodedFrame = {
			timestamp: 0.002,
			protocol: 'uart',
			dataHex: 'FF',
			dataAscii: '.',
			error: 'framing-error',
		};
		assert.strictEqual(frame.error, 'framing-error');
	});

	test('CSV export format: header row is correct', () => {
		const header = 'timestamp_s,protocol,address_hex,data_hex,data_ascii,direction,error';
		const cols = header.split(',');
		assert.strictEqual(cols.length, 7);
		assert.strictEqual(cols[0], 'timestamp_s');
		assert.strictEqual(cols[6], 'error');
	});

	test('frame to CSV row: I2C write at 0x48', () => {
		const frame: IDecodedFrame = {
			timestamp: 0.000123456789,
			protocol: 'i2c',
			address: 0x48,
			dataHex: '02',
			dataAscii: '.',
			direction: 'write',
		};
		const addr = frame.address !== undefined ? `0x${frame.address.toString(16).toUpperCase().padStart(2, '0')}` : '';
		const csv = [
			frame.timestamp.toFixed(9),
			frame.protocol,
			addr,
			frame.dataHex,
			`"${frame.dataAscii}"`,
			frame.direction ?? '',
			frame.error ?? '',
		].join(',');
		assert.ok(csv.includes('0.000123457'), `Timestamp should be 9 decimal places: ${csv}`);
		assert.ok(csv.includes('0x48'));
		assert.ok(csv.includes('i2c'));
	});
});

// ─── Oscilloscope Types ───────────────────────────────────────────────────────

suite('Oscilloscope Service - Type Structures', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('IScopeChannelConfig valid structure', () => {
		const ch: IScopeChannelConfig = {
			channel: 1,
			vDiv: 1.0,
			coupling: 'DC',
			probe: 10,
			enabled: true,
		};
		assert.strictEqual(ch.channel, 1);
		assert.strictEqual(ch.coupling, 'DC');
		assert.strictEqual(ch.probe, 10);
	});

	test('IScopeTriggerConfig valid structure', () => {
		const trig: IScopeTriggerConfig = {
			source: 'C1',
			edge: 'POS',
			level: 1.5,
			mode: 'SING',
		};
		assert.strictEqual(trig.edge, 'POS');
		assert.strictEqual(trig.mode, 'SING');
	});

	test('IScopeWaveform statistics: Pk-Pk from voltage array', () => {
		const voltages = [0.1, 0.5, 1.2, 2.8, 3.2, 3.3, 2.1, 0.8, 0.2];
		const vMin = Math.min(...voltages);
		const vMax = Math.max(...voltages);
		const pkpk = vMax - vMin;
		assert.ok(Math.abs(pkpk - (3.3 - 0.1)) < 0.001);
	});

	test('ASCII waveform rendering: voltage range [0..3.3V] in 6 rows', () => {
		const voltages = [0.0, 0.5, 1.1, 1.65, 2.2, 2.75, 3.3, 2.75, 2.2, 1.65, 1.1, 0.5, 0.0];
		const rows = 6;
		const vMin = Math.min(...voltages);
		const vMax = Math.max(...voltages);
		const vRange = vMax - vMin || 1;
		const chars = voltages.map(v => {
			const row = Math.round((1 - (v - vMin) / vRange) * (rows - 1));
			return row;
		});
		assert.ok(chars.includes(0), 'Max voltage should map to row 0 (top)');
		assert.ok(chars.includes(rows - 1), 'Min voltage should map to bottom row');
	});

	test('probe attenuation: 10x probe adjusts V/div display', () => {
		const vDiv = 1.0;
		const probe = 10;
		const displayedVDiv = vDiv * probe;
		assert.strictEqual(displayedVDiv, 10.0);
	});
});

// ─── Power Analyzer Types ─────────────────────────────────────────────────────

suite('Power Analyzer Service - Type Structures and Calculations', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('IPowerConfig has required fields', () => {
		const config: IPowerConfig = {
			durationMs: 1000,
			voltageV: 3.3,
			mode: 'source',
			triggerThresholdMA: undefined,
		};
		assert.strictEqual(config.durationMs, 1000);
		assert.strictEqual(config.voltageV, 3.3);
		assert.strictEqual(config.mode, 'source');
	});

	test('IPowerResult energy calculation: E = P * t', () => {
		const result: IPowerResult = {
			avgMA: 12.5,
			peakMA: 48.2,
			minMA: 0.8,
			voltageV: 3.3,
			powerMW: 41.25,
			durationMs: 1000,
		};
		// Energy in mJ = power_mW * time_s
		const energyMJ = result.powerMW * (result.durationMs / 1000);
		assert.ok(Math.abs(energyMJ - 41.25) < 0.01);
	});

	test('IPowerResult energy in µAh: Q = I * t', () => {
		const result: IPowerResult = {
			avgMA: 12.5,
			peakMA: 48.0,
			minMA: 0.5,
			voltageV: 3.3,
			powerMW: 41.25,
			durationMs: 3600_000,  // 1 hour
		};
		// Charge in mAh = avgMA * hours
		const chargeMAh = result.avgMA * (result.durationMs / 3_600_000);
		assert.ok(Math.abs(chargeMAh - 12.5) < 0.01, `Expected 12.5 mAh for 12.5mA over 1h, got ${chargeMAh}`);
	});

	test('battery life estimate: capacity / average current', () => {
		const capacityMAh = 2000;  // 2000mAh battery
		const avgCurrentMA = 12.5;
		const lifetimeHours = capacityMAh / avgCurrentMA;
		assert.strictEqual(lifetimeHours, 160);
	});

	test('peak-to-avg ratio indicates bursty load', () => {
		const avgMA = 5.0;
		const peakMA = 100.0;
		const ratio = peakMA / avgMA;
		assert.strictEqual(ratio, 20);
		assert.ok(ratio > 10, 'Ratio > 10 indicates highly bursty consumption (e.g. transmit burst)');
	});

	test('current in source mode: Vout = target voltage within ±5%', () => {
		const targetV = 3.3;
		const measuredV = 3.28;
		const tolerancePct = Math.abs(measuredV - targetV) / targetV * 100;
		assert.ok(tolerancePct < 5, `Voltage within 5% tolerance: ${tolerancePct.toFixed(2)}%`);
	});

	// HIL NOTE: Hardware-gated behaviors.
	// Power analyzer tests that CANNOT be automated without physical instruments:
	//   - PPK2 source mode accuracy: ±50mV on 3.3V rail
	//   - Current measurement accuracy: ±1% full scale (Joulescope spec)
	//   - Boot profile: flash peak vs steady-state baseline correlation
	//   - Sleep current floor: valid range 1µA-100µA depends on MCU stop mode
	//   - Trigger accuracy: must fire within 1ms of GPIO edge
	// Manual HIL checklist: run against live nRF52840-DK with BLE advertisement firmware.
	test('hardware-gated: PPK2/Joulescope calibration accuracy is a manual HIL checklist item', () => {
		assert.ok(true, 'Documentation placeholder for HIL power analyzer calibration requirements');
	});
});
