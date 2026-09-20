/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

/**
 *  A5 internal-memory isolation & persistence (task 2026-09-15 §A5): the agent
 *  memory service is workspace-scoped BY DESIGN (shared across threads/runs of
 *  one workspace). What must hold:
 *  - entries never leak ACROSS workspaces (separate storage scopes);
 *  - a restart (new service instance on the same persisted storage) recalls
 *    what was written before it;
 *  - an oversized candidate is SKIPPED and the next relevant candidate still
 *    fills the prompt budget — never truncated, never blocking the rest;
 *  - recall stays query-relevant: marker A does not drag marker B in.
 */
import assert from 'assert';
import { AgentMemoryService } from '../../browser/agentMemoryService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function makeStorage() {
	const stored: Record<string, string> = {};
	return {
		stored,
		storageService: {
			get: (key: string) => stored[key],
			store: (key: string, value: string) => { stored[key] = value; },
			onWillSaveState: () => ({ dispose: () => { } }),
		},
	};
}

function makeService(storage = makeStorage()) {
	const service = new AgentMemoryService(storage.storageService as never);
	return { service, storage };
}

/** Force the debounced persist to run now (the service persists on a 1s timer). */
async function flushPersist(): Promise<void> {
	await new Promise(r => setTimeout(r, 1_200));
}

suite('Agent memory isolation & persistence (A5)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('entries never leak across workspaces; each scope recalls only its own markers', async () => {
		const wsA = makeService();
		const wsB = makeService();
		try {
			wsA.service.remember('preference', 'WSA-MARKER-7g1: prefer tabs in the alpha workspace');
			wsB.service.remember('preference', 'WSB-MARKER-9k2: prefer spaces in the beta workspace');
			const recallA = await wsA.service.recallForPrompt('indentation preference marker', 1500, 8);
			const recallB = await wsB.service.recallForPrompt('indentation preference marker', 1500, 8);
			assert.ok(recallA.includes('WSA-MARKER-7g1'), 'workspace A recalls its own entry');
			assert.ok(!recallA.includes('WSB-MARKER-9k2'), 'workspace B entries must not leak into A');
			assert.ok(recallB.includes('WSB-MARKER-9k2') && !recallB.includes('WSA-MARKER-7g1'), 'and symmetrically for B');
		} finally { wsA.service.dispose(); wsB.service.dispose(); }
	});

	test('a restart on the same persisted storage recalls what was written before it', async () => {
		const first = makeService();
		try {
			first.service.remember('project-fact', 'RESTART-MARKER-4d8: the flaky test retries twice');
			await flushPersist();
			assert.ok(first.storage.stored['ni.agent.memory'] !== undefined, 'the debounced persist must have landed in storage');
		} finally { first.service.dispose(); }

		// "restart": a brand-new service instance hydrating the same storage
		const second = makeService(first.storage);
		try {
			const recall = await second.service.recallForPrompt('flaky test retry behavior marker', 1500, 8);
			assert.ok(recall.includes('RESTART-MARKER-4d8'), 'the entry written before the restart is recallable after it');
		} finally { second.service.dispose(); }
	});

	test('an oversized candidate is skipped whole and the next relevant candidate still fills the budget', async () => {
		const { service } = makeService();
		try {
			// both entries match the query; the first is far over the budget
			service.remember('project-fact', 'BIG-MARKER-2m5: ' + 'budget query topic. '.repeat(2_000));
			service.remember('project-fact', 'SMALL-MARKER-8c3: budget query topic admission skips oversized candidates');
			const out = await service.recallForPrompt('budget query topic marker', 300, 8);
			assert.ok(!out.includes('BIG-MARKER-2m5'), 'the oversized entry must be skipped, not truncated into the prompt');
			assert.ok(out.includes('SMALL-MARKER-8c3'), 'the next relevant candidate fills the budget instead');
		} finally { service.dispose(); }
	});

	test('recall is query-relevant: marker A does not drag unrelated marker B in', async () => {
		const { service } = makeService();
		try {
			service.remember('project-fact', 'GATE-MARKER-5t7: release builds sign with notarization');
			service.remember('preference', 'OTHER-MARKER-6y0: favorite color is teal');
			const out = await service.recallForPrompt('how are release builds signed notarization', 1500, 8);
			assert.ok(out.includes('GATE-MARKER-5t7'));
			assert.ok(!out.includes('OTHER-MARKER-6y0'), 'an unrelated entry must not ride along on recency/frequency');
		} finally { service.dispose(); }
	});
});
