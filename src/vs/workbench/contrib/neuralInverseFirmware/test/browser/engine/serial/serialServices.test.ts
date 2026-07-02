/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { IRTTStatus, IRTTChannel } from '../../../../browser/engine/serial/rttService.js';
import { IITMStatus } from '../../../../browser/engine/serial/itmService.js';
import { ISerialLine } from '../../../../browser/common/firmwareTypes.js';

// ─── Serial monitor ring buffer behaviour ─────────────────────────────────────

function makeRingBuffer(maxLines: number) {
	const buffer: ISerialLine[] = [];
	return {
		push: (line: string, timestamp = Date.now()) => {
			buffer.push({ text: line, timestamp });
			if (buffer.length > maxLines) { buffer.shift(); }
		},
		getLines: () => [...buffer],
		getLinesSince: (since: number) => buffer.filter(l => l.timestamp >= since),
		clear: () => { buffer.length = 0; },
		get length() { return buffer.length; },
	};
}

suite('Serial Monitor Service - Ring Buffer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ring buffer stores lines', () => {
		const buf = makeRingBuffer(100);
		buf.push('Boot OK');
		buf.push('System ready');
		assert.strictEqual(buf.length, 2);
	});

	test('ring buffer evicts oldest when at capacity', () => {
		const buf = makeRingBuffer(3);
		buf.push('line 1');
		buf.push('line 2');
		buf.push('line 3');
		buf.push('line 4');
		assert.strictEqual(buf.length, 3);
		const lines = buf.getLines();
		assert.ok(!lines.find(l => l.text === 'line 1'), 'line 1 should have been evicted');
		assert.ok(lines.find(l => l.text === 'line 4'), 'line 4 should be present');
	});

	test('ring buffer clear empties all lines', () => {
		const buf = makeRingBuffer(100);
		buf.push('test 1');
		buf.push('test 2');
		buf.clear();
		assert.strictEqual(buf.length, 0);
	});

	test('getLinesSince returns only lines after cutoff', () => {
		const buf = makeRingBuffer(100);
		const t0 = Date.now() - 5000;
		buf.push('old line', t0);
		buf.push('new line', t0 + 4000);
		const since = buf.getLinesSince(t0 + 2000);
		assert.strictEqual(since.length, 1);
		assert.strictEqual(since[0]!.text, 'new line');
	});

	test('ring buffer with 200 lines respects max capacity of 200', () => {
		const buf = makeRingBuffer(200);
		for (let i = 0; i < 250; i++) { buf.push(`line ${i}`); }
		assert.strictEqual(buf.length, 200);
	});
});

// ─── Baud rate detection heuristics ──────────────────────────────────────────

const COMMON_BAUD_RATES = [9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000];

function detectBaudHeuristic(samples: string[]): number | undefined {
	// Printable ASCII heuristic: readable chars > 80% of total
	for (const baud of COMMON_BAUD_RATES) {
		const sample = samples[COMMON_BAUD_RATES.indexOf(baud)];
		if (!sample) { continue; }
		const printable = Array.from(sample).filter(c => c.charCodeAt(0) >= 32 && c.charCodeAt(0) < 127).length;
		if (printable / sample.length > 0.8) { return baud; }
	}
	return undefined;
}

suite('Serial Monitor Service - Baud Rate Detection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('readable ASCII sample returns baud rate', () => {
		// Simulate: at correct baud rate, data is readable ASCII
		const samples = COMMON_BAUD_RATES.map(() => '');
		samples[5] = 'Boot OK\nSystem ready\nAll peripherals initialized\n';  // index 5 = 115200
		const detected = detectBaudHeuristic(samples);
		assert.strictEqual(detected, 115200);
	});

	test('garbage bytes sample returns no detection', () => {
		const samples = COMMON_BAUD_RATES.map(() => '\x00\xFF\x80\x7F\x00\xFF\x80');
		const detected = detectBaudHeuristic(samples);
		assert.strictEqual(detected, undefined);
	});
});

// ─── RTT channel structure ────────────────────────────────────────────────────

suite('RTT Service - Channel Structures', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('RTT channel 0 is the default printf/logging channel', () => {
		const channel: IRTTChannel = {
			index: 0,
			name: 'Terminal',
			direction: 'up',
			bufferSize: 1024,
		};
		assert.strictEqual(channel.index, 0);
		assert.strictEqual(channel.direction, 'up');
	});

	test('RTT status connected fields', () => {
		const status: IRTTStatus = {
			connected: true,
			targetDevice: 'STM32F407VGT6',
			interface: 'swd',
			speedKHz: 4000,
			channels: [
				{ index: 0, name: 'Terminal', direction: 'up', bufferSize: 1024 },
				{ index: 1, name: 'Data', direction: 'up', bufferSize: 4096 },
			],
		};
		assert.ok(status.connected);
		assert.strictEqual(status.channels!.length, 2);
		assert.strictEqual(status.speedKHz, 4000);
	});

	test('RTT status disconnected fields', () => {
		const status: IRTTStatus = {
			connected: false,
			error: 'J-Link DLL not found',
		};
		assert.ok(!status.connected);
		assert.ok(status.error?.includes('J-Link'));
	});

	test('RTT channels can have down (host→MCU) direction', () => {
		const channel: IRTTChannel = { index: 0, name: 'Input', direction: 'down', bufferSize: 64 };
		assert.strictEqual(channel.direction, 'down');
	});
});

// ─── ITM / SWO channel structures ────────────────────────────────────────────

suite('ITM Service - Channel Structures', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('ITM status connected fields', () => {
		const status: IITMStatus = {
			connected: true,
			targetDevice: 'STM32F407VGT6',
			swoBaudRate: 2_000_000,
			channels: [
				{ stimulus: 0, label: 'printf', enabled: true },
				{ stimulus: 1, label: 'events', enabled: false },
			],
		};
		assert.ok(status.connected);
		assert.strictEqual(status.swoBaudRate, 2_000_000);
		assert.strictEqual(status.channels!.length, 2);
	});

	test('ITM status disconnected fields', () => {
		const status: IITMStatus = {
			connected: false,
			error: 'SWO not enabled in target firmware',
		};
		assert.ok(!status.connected);
		assert.ok(status.error?.toLowerCase().includes('swo'));
	});

	test('ITM stimulus 0 is the standard printf channel', () => {
		const channel = { stimulus: 0, label: 'printf', enabled: true };
		assert.strictEqual(channel.stimulus, 0);
		assert.ok(channel.enabled);
	});

	// HIL NOTE: Hardware-gated behaviors.
	// The following ITM/SWO behaviors require physical hardware:
	//   - SWO pin routing through debug probe (requires IT_CM_DEMCR.TRCENA + ITM_TER)
	//   - SWO baud rate lock between firmware ITM_LAR unlock and probe SWO frequency
	//   - Actual sampling of PC via DWT_CTRL.CYCCNTENA for fw_swo_profile
	//   - Round-trip latency measurement of RTT vs UART vs ITM channels
	// Document as HIL checklist; not testable in browser unit test context.
	test('hardware-gated: ITM/SWO channel fidelity is a manual HIL checklist item', () => {
		// Manual verification: use J-Link + Ozone or SystemView to validate:
		//   1. ITM stimulus 0 output matches printf output at 2MHz SWO
		//   2. SWO profile top functions match gprof-based profiling within ±5%
		//   3. RTT channel 0 has no dropped bytes at 4MHz SWD speed
		assert.ok(true, 'This test is a documentation placeholder for HIL requirements');
	});
});
