/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { withPlanModeGuard } from '../../browser/toolsService.js';

// ---------------------------------------------------------------------------
// Harness: a tiny fake callTool map whose impls record whether they ran.
// The real ToolsService wires the same guard around its full callTool map;
// these tests prove the containment logic itself (task A5, step 1).
// ---------------------------------------------------------------------------

interface RanRecord { ran: boolean }

const makeFakeTools = (record: RanRecord) => ({
	write: async (_params: never) => {
		record.ran = true;
		return { result: { result: 'wrote file' } };
	},
	bash: async (_params: never) => {
		record.ran = true;
		return { result: { result: 'ran command' } };
	},
	spawn_agent: async (_params: never) => {
		record.ran = true;
		return { result: { result: 'agent spawned' } };
	},
	read_file: async (_params: never) => {
		record.ran = true;
		return { result: { fileContents: 'contents' } };
	},
	plan_mode_exit: async (_params: never) => {
		record.ran = true;
		return { result: { result: 'Plan mode deactivated.' } };
	},
});

// ---------------------------------------------------------------------------
// Suite: withPlanModeGuard — the plan-mode containment boundary
// ---------------------------------------------------------------------------

suite('toolsService — withPlanModeGuard (plan-mode containment)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('plan mode OFF: writing tools execute normally', async () => {
		const record: RanRecord = { ran: false };
		const tools = withPlanModeGuard(makeFakeTools(record), () => false);
		const { result } = await tools.write(undefined as never);
		assert.strictEqual((await result).result, 'wrote file');
		assert.ok(record.ran, 'write impl must run when plan mode is off');
	});

	test('plan mode ON: file-writing tool is REJECTED and never runs (the reported trap)', async () => {
		const record: RanRecord = { ran: false };
		const tools = withPlanModeGuard(makeFakeTools(record), () => true);
		await assert.rejects(
			tools.write(undefined as never),
			/Plan mode is active.*"write" was blocked without running/s,
		);
		assert.ok(!record.ran, 'write impl must NOT run while plan mode is on');
	});

	test('plan mode ON: terminal tool (bash) is REJECTED and never runs', async () => {
		const record: RanRecord = { ran: false };
		const tools = withPlanModeGuard(makeFakeTools(record), () => true);
		await assert.rejects(
			tools.bash(undefined as never),
			/Plan mode is active.*"bash" was blocked without running/s,
		);
		assert.ok(!record.ran, 'bash impl must NOT run while plan mode is on');
	});

	test('plan mode ON: agent-spawning tool (spawn_agent) is REJECTED (no containment bypass)', async () => {
		const record: RanRecord = { ran: false };
		const tools = withPlanModeGuard(makeFakeTools(record), () => true);
		await assert.rejects(
			tools.spawn_agent(undefined as never),
			/Plan mode is active/s,
		);
		assert.ok(!record.ran, 'spawn_agent impl must NOT run while plan mode is on');
	});

	test('plan mode ON: read-only tools (read_file) still execute', async () => {
		const record: RanRecord = { ran: false };
		const tools = withPlanModeGuard(makeFakeTools(record), () => true);
		const { result } = await tools.read_file(undefined as never);
		const awaited = await result as { fileContents: string };
		assert.strictEqual(awaited.fileContents, 'contents');
		assert.ok(record.ran, 'read_file impl must run while plan mode is on');
	});

	test('plan mode ON: plan_mode_exit is never blocked (the escape hatch)', async () => {
		const record: RanRecord = { ran: false };
		const tools = withPlanModeGuard(makeFakeTools(record), () => true);
		const { result } = await tools.plan_mode_exit(undefined as never);
		assert.strictEqual((await result).result, 'Plan mode deactivated.');
		assert.ok(record.ran, 'plan_mode_exit impl must run while plan mode is on');
	});

	test('round trip: write blocked in plan mode, then allowed after the flag flips off (post plan_mode_exit)', async () => {
		const record: RanRecord = { ran: false };
		let planMode = true;
		const tools = withPlanModeGuard(makeFakeTools(record), () => planMode);
		await assert.rejects(tools.write(undefined as never), /Plan mode is active/);
		assert.ok(!record.ran, 'write must be blocked while plan mode is on');
		// plan_mode_exit flipped the per-thread flag — same as the real service
		planMode = false;
		const { result } = await tools.write(undefined as never);
		assert.strictEqual((await result).result, 'wrote file');
		assert.ok(record.ran, 'write must run again once plan mode is off');
	});

	test('guard preserves the tool map shape (wraps every entry, drops none)', () => {
		const tools = withPlanModeGuard(makeFakeTools({ ran: false }), () => true);
		assert.deepStrictEqual(
			Object.keys(tools).sort(),
			['bash', 'plan_mode_exit', 'read_file', 'spawn_agent', 'write'],
		);
	});
});
