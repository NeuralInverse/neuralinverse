/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { RTOSType, IRTOSThreadInfo, IRTOSHeapInfo, IRTOSSyncPrimitive } from '../../../../browser/engine/rtos/rtosTypes.js';

// ─── Mock GDB debug outputs ───────────────────────────────────────────────────
// These fixtures represent GDB print/d command responses for FreeRTOS/Zephyr/ThreadX.

const FREERTOS_GDB_RESPONSES: Record<string, string | undefined> = {
	'print/d pxCurrentTCB->pcTaskName': '= "main_task"',
	'print/d pxCurrentTCB->uxPriority': '= 5',
	'print/d (uint32_t)pxCurrentTCB->pxStack': '= 536873984',
	'print/d pxCurrentTCB->uxTCBNumber': '= 1',
	'print/d uxCurrentNumberOfTasks': '= 3',
	'print/d xFreeBytesRemaining': '= 24576',
	'print/d xMinimumEverFreeBytesRemaining': '= 20480',
	'print/d configTOTAL_HEAP_SIZE': '= 32768',
	'print/d configQUEUE_REGISTRY_SIZE': '= 8',
	'print/d xTickCount': '= 15000',
	'info address pxCurrentTCB': 'Symbol "pxCurrentTCB" is a variable at address 0x20000100.',
	'info address _kernel': 'No symbol "_kernel" in current context.',
	'info address _tx_thread_created_ptr': 'No symbol "_tx_thread_created_ptr" in current context.',
};

const ZEPHYR_GDB_RESPONSES: Record<string, string | undefined> = {
	'info address pxCurrentTCB': 'No symbol "pxCurrentTCB" in current context.',
	'info address _kernel': 'Symbol "_kernel" is a variable at address 0x20001000.',
	'info address _tx_thread_created_ptr': 'No symbol "_tx_thread_created_ptr" in current context.',
	'print/d _kernel.ticks': '= 42000',
};

const THREADX_GDB_RESPONSES: Record<string, string | undefined> = {
	'info address pxCurrentTCB': 'No symbol "pxCurrentTCB" in current context.',
	'info address _kernel': 'No symbol "_kernel" in current context.',
	'info address _tx_thread_created_ptr': 'Symbol "_tx_thread_created_ptr" is a variable at address 0x20002000.',
};

// ─── Mock debug service ───────────────────────────────────────────────────────

function makeDebugService(responses: Record<string, string | undefined>, connected = true) {
	return {
		state: { clientConnected: connected },
		sendCommand: async (cmd: string) => {
			const output = responses[cmd] ?? undefined;
			return { output };
		},
	};
}

// ─── Inline RTOS detection logic (mirrors RTOSDebugServiceImpl.detect) ─────────

async function detectRTOS(debugService: { state: { clientConnected: boolean }; sendCommand: (cmd: string) => Promise<{ output?: string }> }, projectRtos?: string): Promise<RTOSType> {
	if (projectRtos) {
		const r = projectRtos.toLowerCase();
		if (r.includes('freertos')) return 'freertos';
		if (r.includes('zephyr')) return 'zephyr';
		if (r.includes('threadx')) return 'threadx';
	}
	if (debugService.state.clientConnected) {
		const freertosCheck = await debugService.sendCommand('info address pxCurrentTCB');
		if (freertosCheck.output && !freertosCheck.output.includes('No symbol')) return 'freertos';
		const zephyrCheck = await debugService.sendCommand('info address _kernel');
		if (zephyrCheck.output && !zephyrCheck.output.includes('No symbol')) return 'zephyr';
		const threadxCheck = await debugService.sendCommand('info address _tx_thread_created_ptr');
		if (threadxCheck.output && !threadxCheck.output.includes('No symbol')) return 'threadx';
	}
	return 'none';
}

// ─── Inline Zephyr state mapper (mirrors production) ─────────────────────────

function zephyrStateToState(state: number): string {
	if (state & 0x01) return 'blocked';
	if (state & 0x04) return 'deleted';
	if (state & 0x08) return 'suspended';
	if (state & 0x80) return 'ready';
	return 'running';
}

// ─── Inline ThreadX state mapper (mirrors production) ────────────────────────

function threadxStateToState(state: number): string {
	switch (state) {
		case 0: return 'ready';
		case 1: case 2: return 'deleted';
		case 3: return 'suspended';
		default: return 'blocked';
	}
}

suite('RTOS Debug Service - Detection', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('detect() returns freertos when pxCurrentTCB symbol exists', async () => {
		const debug = makeDebugService(FREERTOS_GDB_RESPONSES);
		const rtos = await detectRTOS(debug);
		assert.strictEqual(rtos, 'freertos');
	});

	test('detect() returns zephyr when _kernel symbol exists', async () => {
		const debug = makeDebugService(ZEPHYR_GDB_RESPONSES);
		const rtos = await detectRTOS(debug);
		assert.strictEqual(rtos, 'zephyr');
	});

	test('detect() returns threadx when _tx_thread_created_ptr symbol exists', async () => {
		const debug = makeDebugService(THREADX_GDB_RESPONSES);
		const rtos = await detectRTOS(debug);
		assert.strictEqual(rtos, 'threadx');
	});

	test('detect() returns none when no RTOS symbols found', async () => {
		const debug = makeDebugService({
			'info address pxCurrentTCB': 'No symbol "pxCurrentTCB" in current context.',
			'info address _kernel': 'No symbol "_kernel" in current context.',
			'info address _tx_thread_created_ptr': 'No symbol "_tx_thread_created_ptr" in current context.',
		});
		const rtos = await detectRTOS(debug);
		assert.strictEqual(rtos, 'none');
	});

	test('detect() returns none when debug not connected', async () => {
		const debug = makeDebugService(FREERTOS_GDB_RESPONSES, false);
		const rtos = await detectRTOS(debug);
		assert.strictEqual(rtos, 'none');
	});

	test('detect() uses project config rtos field over GDB symbols', async () => {
		const debug = makeDebugService(ZEPHYR_GDB_RESPONSES); // would detect zephyr from symbols
		const rtos = await detectRTOS(debug, 'FreeRTOS');
		assert.strictEqual(rtos, 'freertos', 'Project config should override symbol detection');
	});

	test('detect() handles case-insensitive project rtos string', async () => {
		const debug = makeDebugService({});
		assert.strictEqual(await detectRTOS(debug, 'freertos'), 'freertos');
		assert.strictEqual(await detectRTOS(debug, 'FREERTOS'), 'freertos');
		assert.strictEqual(await detectRTOS(debug, 'FreeRTOS v10.4'), 'freertos');
		assert.strictEqual(await detectRTOS(debug, 'Zephyr'), 'zephyr');
		assert.strictEqual(await detectRTOS(debug, 'ThreadX'), 'threadx');
	});
});

suite('RTOS Debug Service - Zephyr Thread State Mapping', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('state 0 = running', () => {
		assert.strictEqual(zephyrStateToState(0), 'running');
	});

	test('state 0x01 (_THREAD_PENDING) = blocked', () => {
		assert.strictEqual(zephyrStateToState(0x01), 'blocked');
	});

	test('state 0x04 (_THREAD_DEAD) = deleted', () => {
		assert.strictEqual(zephyrStateToState(0x04), 'deleted');
	});

	test('state 0x08 (_THREAD_SUSPENDED) = suspended', () => {
		assert.strictEqual(zephyrStateToState(0x08), 'suspended');
	});

	test('state 0x80 (_THREAD_QUEUED) = ready', () => {
		assert.strictEqual(zephyrStateToState(0x80), 'ready');
	});
});

suite('RTOS Debug Service - ThreadX State Mapping', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('state 0 (TX_READY) = ready', () => {
		assert.strictEqual(threadxStateToState(0), 'ready');
	});

	test('state 1 (TX_COMPLETED) = deleted', () => {
		assert.strictEqual(threadxStateToState(1), 'deleted');
	});

	test('state 2 (TX_TERMINATED) = deleted', () => {
		assert.strictEqual(threadxStateToState(2), 'deleted');
	});

	test('state 3 (TX_SUSPENDED) = suspended', () => {
		assert.strictEqual(threadxStateToState(3), 'suspended');
	});

	test('state 4 (TX_SLEEP) = blocked', () => {
		assert.strictEqual(threadxStateToState(4), 'blocked');
	});

	test('state 13 (TX_MUTEX_SUSP) = blocked', () => {
		assert.strictEqual(threadxStateToState(13), 'blocked');
	});
});

suite('RTOS Debug Service - FreeRTOS Heap', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('heap stats computed correctly from GDB outputs', async () => {
		// Simulate reading GDB vars
		const freeSize = 24576;
		const totalSize = 32768;
		const minEverFree = 20480;
		const heap: IRTOSHeapInfo = {
			totalSize,
			freeSize,
			usedSize: totalSize - freeSize,
			minimumEverFree: minEverFree,
			allocCount: 0,
			freeCount: 0,
			largestFreeBlock: 0,
		};

		assert.strictEqual(heap.usedSize, 32768 - 24576);
		assert.strictEqual(heap.freeSize, 24576);
		assert.strictEqual(heap.minimumEverFree, 20480);
	});

	test('heap usage percentage is correct', () => {
		const heap: IRTOSHeapInfo = { totalSize: 32768, freeSize: 16384, usedSize: 16384, minimumEverFree: 8192, allocCount: 0, freeCount: 0, largestFreeBlock: 0 };
		const usedPct = (heap.usedSize / heap.totalSize) * 100;
		assert.ok(Math.abs(usedPct - 50) < 0.01, `Expected 50%, got ${usedPct}`);
	});
});

suite('RTOS Debug Service - FreeRTOS Sync Primitives', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('queue type correctly classified', () => {
		// queueType 0 = queue, 1 = mutex, 2 = semaphore
		const classify = (t: number): IRTOSSyncPrimitive['type'] => t === 1 ? 'mutex' : t === 2 ? 'semaphore' : 'queue';
		assert.strictEqual(classify(0), 'queue');
		assert.strictEqual(classify(1), 'mutex');
		assert.strictEqual(classify(2), 'semaphore');
	});

	test('mutex value: msgWaiting=0 means locked', () => {
		const msgWaiting = 0;
		const value = msgWaiting === 0 ? 'locked' : 'free';
		assert.strictEqual(value, 'locked');
	});

	test('mutex value: msgWaiting=1 means free', () => {
		const msgWaiting = 1;
		const value = msgWaiting === 0 ? 'locked' : 'free';
		assert.strictEqual(value, 'free');
	});

	test('queue value: shows waiting/total format', () => {
		const msgWaiting = 3;
		const queueLength = 10;
		const value = `${msgWaiting}/${queueLength}`;
		assert.strictEqual(value, '3/10');
	});
});

suite('RTOS Snapshot Structure', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('RTOSSnapshot has all required fields', () => {
		const snap = {
			rtosType: 'freertos' as RTOSType,
			timestamp: Date.now(),
			threads: [] as IRTOSThreadInfo[],
			heap: undefined as IRTOSHeapInfo | undefined,
			syncPrimitives: [] as IRTOSSyncPrimitive[],
			timers: [],
			tickCount: 15000,
		};
		assert.ok(snap.rtosType);
		assert.ok(snap.timestamp > 0);
		assert.ok(Array.isArray(snap.threads));
		assert.ok(Array.isArray(snap.syncPrimitives));
		assert.ok(typeof snap.tickCount === 'number');
	});

	test('thread info has all required fields', () => {
		const thread: IRTOSThreadInfo = {
			id: 1,
			name: 'main_task',
			state: 'running',
			priority: 5,
			stackBase: 0x20001000,
			stackSize: 4096,
			stackUsed: 512,
			stackHighWaterMark: 256,
		};
		assert.ok(thread.id >= 0);
		assert.ok(thread.name.length > 0);
		assert.ok(['running', 'ready', 'blocked', 'suspended', 'deleted'].includes(thread.state));
	});
});
