/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildClosedLoopTools } from '../../../../browser/engine/agentTools/closedLoopTools.js';
import { IClosedLoopResult, IClosedLoopIteration } from '../../../../browser/engine/closedLoop/closedLoopTypes.js';

function makeMockClosedLoopService(overrides: {
	isRunning?: boolean;
	currentIteration?: number;
	result?: Partial<IClosedLoopResult>;
	abortShouldThrow?: boolean;
} = {}) {
	const makeResult = (success: boolean): IClosedLoopResult => ({
		success,
		iterations: [
			{ index: 1, phase: 'build', diagnosis: success ? undefined : 'undefined reference', passCriteriaMet: [success] } as IClosedLoopIteration,
		],
		totalDurationMs: 3400,
		failureReason: success ? undefined : 'max iterations reached',
		summary: success ? 'Goal achieved.' : 'Goal not achieved.',
		...overrides.result,
	});

	return {
		_serviceBrand: undefined as any,
		get isRunning() { return overrides.isRunning ?? false; },
		get currentIteration() { return overrides.currentIteration ?? 0; },
		start: async (_config: unknown) => makeResult(true),
		abort: () => {
			if (overrides.abortShouldThrow) { throw new Error('abort failed'); }
		},
	};
}

suite('Closed-Loop Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildClosedLoopTools returns 3 tools', () => {
		const tools = buildClosedLoopTools(makeMockClosedLoopService() as any);
		assert.strictEqual(tools.length, 3);
	});

	test('tool names are fw_closed_loop, fw_closed_loop_status, fw_closed_loop_abort', () => {
		const tools = buildClosedLoopTools(makeMockClosedLoopService() as any);
		const names = tools.map(t => t.name);
		assert.ok(names.includes('fw_closed_loop'));
		assert.ok(names.includes('fw_closed_loop_status'));
		assert.ok(names.includes('fw_closed_loop_abort'));
	});

	// ─── fw_closed_loop ───────────────────────────────────────────────────────

	test('fw_closed_loop requires goal arg', async () => {
		const tools = buildClosedLoopTools(makeMockClosedLoopService() as any);
		const tool = tools.find(t => t.name === 'fw_closed_loop')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('goal') || result.toLowerCase().includes('error'));
	});

	test('fw_closed_loop returns blocked message when already running', async () => {
		const svc = makeMockClosedLoopService({ isRunning: true });
		const tools = buildClosedLoopTools(svc as any);
		const tool = tools.find(t => t.name === 'fw_closed_loop')!;
		const result = await tool.execute({ goal: 'Blink LED' });
		assert.ok(result.toLowerCase().includes('already running'));
	});

	test('fw_closed_loop success shows SUCCEEDED banner', async () => {
		const tools = buildClosedLoopTools(makeMockClosedLoopService() as any);
		const tool = tools.find(t => t.name === 'fw_closed_loop')!;
		const result = await tool.execute({ goal: 'Blink LED on PA5 at 1Hz' });
		assert.ok(result.includes('SUCCEEDED') || result.includes('✓'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_closed_loop accepts pass_criteria as JSON string', async () => {
		const tools = buildClosedLoopTools(makeMockClosedLoopService() as any);
		const tool = tools.find(t => t.name === 'fw_closed_loop')!;
		const result = await tool.execute({
			goal: 'Print Hello',
			pass_criteria: JSON.stringify([{ type: 'serial-contains', value: 'Hello', description: 'UART hello' }]),
		});
		assert.ok(typeof result === 'string');
	});

	test('fw_closed_loop accepts invalid JSON pass_criteria gracefully', async () => {
		const tools = buildClosedLoopTools(makeMockClosedLoopService() as any);
		const tool = tools.find(t => t.name === 'fw_closed_loop')!;
		const result = await tool.execute({ goal: 'Blink', pass_criteria: 'not-json-{{' });
		assert.ok(typeof result === 'string');
	});

	test('fw_closed_loop shows iteration summary', async () => {
		const tools = buildClosedLoopTools(makeMockClosedLoopService() as any);
		const tool = tools.find(t => t.name === 'fw_closed_loop')!;
		const result = await tool.execute({ goal: 'Blink LED' });
		assert.ok(result.includes('#1') || result.includes('Iteration'));
	});

	test('fw_closed_loop shows failure reason when not successful', async () => {
		const svc = makeMockClosedLoopService({
			result: {
				success: false,
				iterations: [{ index: 1, phase: 'build', diagnosis: 'undefined reference', passCriteriaMet: [false] } as IClosedLoopIteration],
				totalDurationMs: 2000,
				failureReason: 'max iterations reached',
			},
		});
		// Override start to return failure
		(svc as any).start = async () => ({
			success: false,
			iterations: [{ index: 1, phase: 'build', diagnosis: 'undefined reference', passCriteriaMet: [false] }],
			totalDurationMs: 2000,
			failureReason: 'max iterations reached',
			summary: 'Goal not achieved.',
		});
		const tools = buildClosedLoopTools(svc as any);
		const tool = tools.find(t => t.name === 'fw_closed_loop')!;
		const result = await tool.execute({ goal: 'Blink', max_iterations: 1 });
		assert.ok(result.includes('FAILED') || result.includes('✗'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_closed_loop_status ────────────────────────────────────────────────

	test('fw_closed_loop_status when not running returns not running message', async () => {
		const tools = buildClosedLoopTools(makeMockClosedLoopService({ isRunning: false }) as any);
		const tool = tools.find(t => t.name === 'fw_closed_loop_status')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no closed-loop') || result.toLowerCase().includes('not running'));
	});

	test('fw_closed_loop_status when running shows iteration count', async () => {
		const tools = buildClosedLoopTools(makeMockClosedLoopService({ isRunning: true, currentIteration: 3 }) as any);
		const tool = tools.find(t => t.name === 'fw_closed_loop_status')!;
		const result = await tool.execute({});
		assert.ok(result.includes('3') || result.includes('running'));
	});

	// ─── fw_closed_loop_abort ─────────────────────────────────────────────────

	test('fw_closed_loop_abort when not running returns no session message', async () => {
		const tools = buildClosedLoopTools(makeMockClosedLoopService({ isRunning: false }) as any);
		const tool = tools.find(t => t.name === 'fw_closed_loop_abort')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no closed-loop') || result.toLowerCase().includes('nothing'));
	});

	test('fw_closed_loop_abort when running returns abort confirmation', async () => {
		const tools = buildClosedLoopTools(makeMockClosedLoopService({ isRunning: true }) as any);
		const tool = tools.find(t => t.name === 'fw_closed_loop_abort')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('abort') || result.toLowerCase().includes('stop'));
	});
});
