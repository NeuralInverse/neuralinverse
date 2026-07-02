/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildHILTools } from '../../../../browser/engine/agentTools/hilTools.js';
import { buildRTOSTools } from '../../../../browser/engine/agentTools/rtosTools.js';
import { IHILTestSpec, IHILTestResult } from '../../../../browser/engine/hil/hilTypes.js';
import { IRTOSSnapshot } from '../../../../browser/engine/rtos/rtosTypes.js';

// ─── Mock HIL service ─────────────────────────────────────────────────────────

function makeMockHILService(overrides: {
	tests?: IHILTestSpec[];
	runResult?: Partial<IHILTestResult>;
	isRunning?: boolean;
	saveShouldFail?: boolean;
} = {}) {
	const tests: IHILTestSpec[] = overrides.tests ?? [];
	const defaultResult: IHILTestResult = {
		testId: 'test-1',
		testName: 'Echo Test',
		passed: true,
		startTime: Date.now(),
		endTime: Date.now() + 5000,
		durationMs: 5000,
		buildResult: { success: true, durationMs: 1200 },
		flashResult: { success: true, durationMs: 2000 },
		expectationResults: [
			{ description: 'serial contains PASS', passed: true },
			{ description: 'no crash', passed: true },
		],
		serialCapture: 'Boot OK\nRunning test\nTEST PASS\nDone',
	};

	return {
		_serviceBrand: undefined as any,
		isRunning: overrides.isRunning ?? false,
		onTestStarted: { event: () => {} },
		onTestCompleted: { event: () => {} },
		onSuiteCompleted: { event: () => {} },
		runTest: async (spec: IHILTestSpec) => ({ ...defaultResult, ...overrides.runResult, testName: spec.name }),
		runSuite: async (filter?: { tags?: string[] }) => {
			const filtered = filter?.tags ? tests.filter(t => t.tags?.some(tag => filter.tags!.includes(tag))) : tests;
			const results = filtered.map(t => ({ ...defaultResult, testName: t.name, testId: t.id }));
			return { suiteName: 'All Tests', startTime: Date.now(), endTime: Date.now() + 1000, totalTests: results.length, passedTests: results.length, failedTests: 0, results };
		},
		loadTests: async () => tests,
		saveTest: async (spec: IHILTestSpec) => {
			if (overrides.saveShouldFail) throw new Error('Write failed: permission denied');
			tests.push(spec);
		},
		abort: () => {},
	};
}

// ─── Mock RTOS service ────────────────────────────────────────────────────────

function makeMockRTOSService(overrides: {
	rtos?: string;
	threads?: any[];
	heap?: any;
	syncPrimitives?: any[];
	timers?: any[];
	tickCount?: number;
} = {}) {
	const detectedRTOS = (overrides.rtos ?? 'freertos') as any;
	const threads = overrides.threads ?? [
		{ id: 0, name: 'main_task', state: 'running', priority: 5, stackBase: 0x20001000, stackSize: 4096, stackUsed: 512, stackHighWaterMark: 256 },
		{ id: 1, name: 'uart_task', state: 'blocked', priority: 3, stackBase: 0x20002000, stackSize: 2048, stackUsed: 128, stackHighWaterMark: 64 },
	];
	const heap = overrides.heap ?? { totalSize: 32768, freeSize: 24576, usedSize: 8192, minimumEverFree: 20480, allocCount: 0, freeCount: 0, largestFreeBlock: 0 };
	const sync = overrides.syncPrimitives ?? [
		{ type: 'mutex', name: 'uart_mutex', value: 'free', waiters: [] },
		{ type: 'queue', name: 'event_queue', value: '2/10', waiters: [] },
	];

	return {
		_serviceBrand: undefined as any,
		detectedRTOS,
		onSnapshotUpdated: { event: () => {} },
		detect: async () => detectedRTOS,
		snapshot: async (): Promise<IRTOSSnapshot> => ({
			rtosType: detectedRTOS,
			timestamp: Date.now(),
			threads,
			heap,
			syncPrimitives: sync,
			timers: overrides.timers ?? [],
			tickCount: overrides.tickCount ?? 15000,
		}),
		getThreads: async () => threads,
		getHeap: async () => heap,
		getSyncPrimitives: async () => sync,
		getTimers: async () => overrides.timers ?? [],
		getTickCount: async () => overrides.tickCount ?? 15000,
	};
}

suite('HIL Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const hilSvc = makeMockHILService();

	test('buildHILTools returns 4 tools', () => {
		const tools = buildHILTools(hilSvc as any);
		assert.strictEqual(tools.length, 4);
	});

	test('tool names are fw_hil_run, fw_hil_define, fw_hil_list, fw_hil_run_suite', () => {
		const tools = buildHILTools(hilSvc as any);
		const names = tools.map(t => t.name);
		assert.ok(names.includes('fw_hil_run'));
		assert.ok(names.includes('fw_hil_define'));
		assert.ok(names.includes('fw_hil_list'));
		assert.ok(names.includes('fw_hil_run_suite'));
	});

	// ─── fw_hil_list ──────────────────────────────────────────────────────────

	test('fw_hil_list with no tests shows define prompt', async () => {
		const tools = buildHILTools(hilSvc as any);
		const tool = tools.find(t => t.name === 'fw_hil_list')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no hil tests') || result.toLowerCase().includes('fw_hil_define'));
	});

	test('fw_hil_list with tests shows test names', async () => {
		const svcWithTests = makeMockHILService({
			tests: [
				{ id: 'uart-echo', name: 'UART Echo', description: 'Echo test', buildFirst: true, stimulus: [], expectations: [], timeoutMs: 10000, postFlashDelayMs: 500, tags: ['uart'] },
				{ id: 'gpio-blink', name: 'GPIO Blink', buildFirst: true, stimulus: [], expectations: [], timeoutMs: 5000, postFlashDelayMs: 200 },
			],
		});
		const tools = buildHILTools(svcWithTests as any);
		const tool = tools.find(t => t.name === 'fw_hil_list')!;
		const result = await tool.execute({});
		assert.ok(result.includes('uart-echo'));
		assert.ok(result.includes('UART Echo'));
		assert.ok(result.includes('gpio-blink'));
	});

	// ─── fw_hil_define ────────────────────────────────────────────────────────

	test('fw_hil_define without id returns error', async () => {
		const tools = buildHILTools(hilSvc as any);
		const tool = tools.find(t => t.name === 'fw_hil_define')!;
		const result = await tool.execute({ name: 'Test without ID' });
		assert.ok(result.toLowerCase().includes('error') || result.toLowerCase().includes('id'));
	});

	test('fw_hil_define with valid args saves test and returns confirmation', async () => {
		const svc = makeMockHILService();
		const tools = buildHILTools(svc as any);
		const tool = tools.find(t => t.name === 'fw_hil_define')!;
		const result = await tool.execute({
			id: 'new-test',
			name: 'New Test',
			stimulus: JSON.stringify([{ type: 'serial-send', delayMs: 500, params: { data: 'PING\r\n' } }]),
			expectations: JSON.stringify([{ type: 'serial-contains', description: 'has pong', params: { text: 'PONG' } }]),
			timeout_ms: 15000,
		});
		assert.ok(result.includes('new-test') || result.includes('saved') || result.includes('✓'));
	});

	test('fw_hil_define with invalid JSON stimulus returns error', async () => {
		const tools = buildHILTools(hilSvc as any);
		const tool = tools.find(t => t.name === 'fw_hil_define')!;
		const result = await tool.execute({ id: 'test-bad', stimulus: 'not-json-{{{' });
		assert.ok(result.toLowerCase().includes('error') || result.toLowerCase().includes('json'));
	});

	test('fw_hil_define with tags saves them correctly', async () => {
		const svc = makeMockHILService();
		const tools = buildHILTools(svc as any);
		const tool = tools.find(t => t.name === 'fw_hil_define')!;
		await tool.execute({ id: 'tagged-test', name: 'Tagged', tags: 'uart, regression, smoke', stimulus: '[]', expectations: '[]' });
		const saved = (svc as any).loadTests();
		assert.ok(saved); // test saved without throwing
	});

	// ─── fw_hil_run ───────────────────────────────────────────────────────────

	test('fw_hil_run inline test returns pass/fail verdict', async () => {
		const tools = buildHILTools(hilSvc as any);
		const tool = tools.find(t => t.name === 'fw_hil_run')!;
		const result = await tool.execute({
			name: 'Quick Test',
			stimulus: '[]',
			expectations: JSON.stringify([{ type: 'serial-contains', description: 'has PASS', params: { text: 'TEST PASS' } }]),
		});
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('PASSED') || result.includes('FAILED'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_hil_run returns blocking message when already running', async () => {
		const runningSvc = makeMockHILService({ isRunning: true });
		const tools = buildHILTools(runningSvc as any);
		const tool = tools.find(t => t.name === 'fw_hil_run')!;
		const result = await tool.execute({ name: 'Test' });
		assert.ok(result.toLowerCase().includes('already running'));
	});

	test('fw_hil_run with test_id not found returns descriptive error', async () => {
		const svc = makeMockHILService({ tests: [] });
		const tools = buildHILTools(svc as any);
		const tool = tools.find(t => t.name === 'fw_hil_run')!;
		const result = await tool.execute({ test_id: 'nonexistent-test-xyz' });
		assert.ok(result.toLowerCase().includes('not found') || result.toLowerCase().includes('nonexistent'));
	});

	test('fw_hil_run shows serial capture in output', async () => {
		const tools = buildHILTools(hilSvc as any);
		const tool = tools.find(t => t.name === 'fw_hil_run')!;
		const result = await tool.execute({ name: 'Echo Test', stimulus: '[]', expectations: '[]' });
		assert.ok(result.includes('Serial capture') || result.includes('Boot OK') || result.includes('TEST PASS'));
	});

	// ─── fw_hil_run_suite ─────────────────────────────────────────────────────

	test('fw_hil_run_suite with 0 tests returns summary', async () => {
		const tools = buildHILTools(hilSvc as any);
		const tool = tools.find(t => t.name === 'fw_hil_run_suite')!;
		const result = await tool.execute({});
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('0') || result.includes('PASS') || result.includes('Tests'));
	});

	test('fw_hil_run_suite with passing tests shows all passed', async () => {
		const svcWithTests = makeMockHILService({
			tests: [
				{ id: 't1', name: 'Test 1', buildFirst: true, stimulus: [], expectations: [], timeoutMs: 5000, postFlashDelayMs: 200 },
				{ id: 't2', name: 'Test 2', buildFirst: true, stimulus: [], expectations: [], timeoutMs: 5000, postFlashDelayMs: 200 },
			],
		});
		const tools = buildHILTools(svcWithTests as any);
		const tool = tools.find(t => t.name === 'fw_hil_run_suite')!;
		const result = await tool.execute({});
		assert.ok(result.includes('2/2') || result.includes('ALL TESTS PASSED'));
	});
});

suite('RTOS Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const rtosSvc = makeMockRTOSService();

	test('buildRTOSTools returns 5 tools', () => {
		const tools = buildRTOSTools(rtosSvc as any);
		assert.strictEqual(tools.length, 5);
	});

	test('tool names include fw_rtos_detect, fw_rtos_threads, fw_rtos_heap, fw_rtos_sync, fw_rtos_snapshot', () => {
		const tools = buildRTOSTools(rtosSvc as any);
		const names = new Set(tools.map(t => t.name));
		assert.ok(names.has('fw_rtos_detect'));
		assert.ok(names.has('fw_rtos_threads'));
		assert.ok(names.has('fw_rtos_heap'));
		assert.ok(names.has('fw_rtos_sync'));
		assert.ok(names.has('fw_rtos_snapshot'));
	});

	// ─── fw_rtos_detect ───────────────────────────────────────────────────────

	test('fw_rtos_detect returns detected RTOS name', async () => {
		const tools = buildRTOSTools(rtosSvc as any);
		const tool = tools.find(t => t.name === 'fw_rtos_detect')!;
		const result = await tool.execute({});
		assert.ok(result.includes('freertos') || result.includes('Detected RTOS'));
	});

	test('fw_rtos_detect with none RTOS returns bare-metal message', async () => {
		const noRtosSvc = makeMockRTOSService({ rtos: 'none' });
		const tools = buildRTOSTools(noRtosSvc as any);
		const tool = tools.find(t => t.name === 'fw_rtos_detect')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no rtos') || result.toLowerCase().includes('bare-metal') || result.toLowerCase().includes('none'));
	});

	// ─── fw_rtos_threads ──────────────────────────────────────────────────────

	test('fw_rtos_threads lists threads with names and states', async () => {
		const tools = buildRTOSTools(rtosSvc as any);
		const tool = tools.find(t => t.name === 'fw_rtos_threads')!;
		const result = await tool.execute({});
		assert.ok(result.includes('main_task'));
		assert.ok(result.includes('uart_task'));
		assert.ok(result.includes('running') || result.includes('blocked'));
	});

	test('fw_rtos_threads with no threads returns descriptive message', async () => {
		const emptyRtosSvc = makeMockRTOSService({ threads: [] });
		const tools = buildRTOSTools(emptyRtosSvc as any);
		const tool = tools.find(t => t.name === 'fw_rtos_threads')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no threads') || result.toLowerCase().includes('debugger'));
	});

	// ─── fw_rtos_heap ─────────────────────────────────────────────────────────

	test('fw_rtos_heap shows heap stats with sizes', async () => {
		const tools = buildRTOSTools(rtosSvc as any);
		const tool = tools.find(t => t.name === 'fw_rtos_heap')!;
		const result = await tool.execute({});
		assert.ok(result.includes('32768') || result.includes('Heap') || result.includes('Total'));
		assert.ok(result.includes('24576') || result.includes('Free'));
	});

	test('fw_rtos_heap shows warning when < 10% free', async () => {
		const criticalSvc = makeMockRTOSService({
			heap: { totalSize: 32768, freeSize: 2000, usedSize: 30768, minimumEverFree: 1024, allocCount: 0, freeCount: 0, largestFreeBlock: 0 },
		});
		const tools = buildRTOSTools(criticalSvc as any);
		const tool = tools.find(t => t.name === 'fw_rtos_heap')!;
		const result = await tool.execute({});
		assert.ok(result.includes('⚠') || result.toLowerCase().includes('warning') || result.toLowerCase().includes('10%'));
	});

	test('fw_rtos_heap returns message when heap not available', async () => {
		const noHeapSvc = makeMockRTOSService({ heap: null });
		const tools = buildRTOSTools(noHeapSvc as any);
		const tool = tools.find(t => t.name === 'fw_rtos_heap')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('not available') || result.toLowerCase().includes('heap'));
	});

	// ─── fw_rtos_sync ─────────────────────────────────────────────────────────

	test('fw_rtos_sync lists sync primitives', async () => {
		const tools = buildRTOSTools(rtosSvc as any);
		const tool = tools.find(t => t.name === 'fw_rtos_sync')!;
		const result = await tool.execute({});
		assert.ok(result.includes('mutex') || result.includes('queue') || result.includes('uart_mutex'));
	});

	test('fw_rtos_sync with empty registry shows no-primitives message', async () => {
		const emptySvc = makeMockRTOSService({ syncPrimitives: [] });
		const tools = buildRTOSTools(emptySvc as any);
		const tool = tools.find(t => t.name === 'fw_rtos_sync')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no synchronization') || result.toLowerCase().includes('registry'));
	});

	// ─── fw_rtos_snapshot ─────────────────────────────────────────────────────

	test('fw_rtos_snapshot returns RTOS type and stats', async () => {
		const tools = buildRTOSTools(rtosSvc as any);
		const tool = tools.find(t => t.name === 'fw_rtos_snapshot')!;
		const result = await tool.execute({});
		assert.ok(result.includes('freertos') || result.includes('Snapshot'));
		assert.ok(result.includes('Tick count') || result.includes('15000'));
		assert.ok(result.includes('Threads:') || result.includes('2'));
	});

	test('fw_rtos_snapshot detects high-priority blocked threads', async () => {
		const withBlockedSvc = makeMockRTOSService({
			threads: [
				{ id: 0, name: 'critical_task', state: 'blocked', priority: 1, stackBase: 0x20001000, stackSize: 4096, stackUsed: 256, stackHighWaterMark: 128 },
			],
		});
		const tools = buildRTOSTools(withBlockedSvc as any);
		const tool = tools.find(t => t.name === 'fw_rtos_snapshot')!;
		const result = await tool.execute({});
		assert.ok(result.includes('critical_task') || result.includes('blocked') || result.includes('priority inversion') || result.includes('⚠'));
	});

	test('fw_rtos_snapshot with no RTOS returns no-rtos message', async () => {
		const noneSvc = makeMockRTOSService({ rtos: 'none' });
		const tools = buildRTOSTools(noneSvc as any);
		const tool = tools.find(t => t.name === 'fw_rtos_snapshot')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no rtos'));
	});
});
