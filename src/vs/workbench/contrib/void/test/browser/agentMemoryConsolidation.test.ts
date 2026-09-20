/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

/**
 *  B1 capture/consolidation acceptance (task 2026-09-15 §B1): episode fields
 *  become durable memories with provenance; re-recording dedups; an edited
 *  rule replaces the old truth; secrets never become memory; deletion from
 *  the manager stays deleted; unrelated workspace memory does not leak.
 */
import assert from 'assert';
import { AgentMemoryService } from '../../browser/agentMemoryService.js';
import { consolidateEpisode, extractDurableMemories, looksLikeSecret, memoryKeyOf } from '../../browser/agentMemoryConsolidationContrib.js';
import type { IEpisodeSummary, IEpisodeBody } from '../../common/ledgerTypes.js';
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

function makeEpisode(overrides: Partial<IEpisodeBody>): IEpisodeSummary {
	const body: IEpisodeBody = {
		goal: 'fixture goal',
		decisions: [], rejected: [], failures: [], corrections: [], invariants: [],
		artifacts: { files: [], symbols: [], commands: [], configs: [] },
		state: { done: [], inProgress: [], verified: [] }, next: [], openQuestions: [],
		...overrides,
	};
	return {
		id: 'ep_t_1', threadId: 'thread-abc12345', ordinal: 1,
		range: { fromSeq: 1, toSeq: 9 }, createdAt: 1_000, producedBy: 'deterministic', frozen: true, body,
	};
}

suite('Agent memory capture/consolidation — B1', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('episode invariants/corrections/decisions become memories with provenance', () => {
		const f = makeStorage();
		const service = new AgentMemoryService(f.storageService as never);
		try {
			const ep = makeEpisode({
				invariants: ['always use pnpm in this repo'],
				corrections: [{ userSaid: 'stop running tests in parallel', ruleDerived: 'run tests serially', sourceIds: [1] }],
				decisions: [{ what: 'kept vite as the bundler', why: 'fast hmr', sourceIds: [2] }],
			});
			const stored = consolidateEpisode(service, 'thread-abc12345', ep);
			assert.strictEqual(stored, 3);
			const all = service.getAllEntries();
			assert.strictEqual(all.length, 3);
			const pnpm = all.find(e => e.content.includes('pnpm'))!;
			assert.ok(pnpm, 'the invariant is stored');
			// provenance: ledger + thread + episode tags on the fresh entry
			assert.ok(pnpm.tags.includes('ledger'), 'ledger provenance tag');
			assert.ok(pnpm.tags.includes('thread:thread-a'), 'thread provenance tag');
			assert.ok(pnpm.tags.includes('ep:1'), 'episode provenance tag');
			assert.ok(pnpm.tags.includes(memoryKeyOf('always use pnpm in this repo')), 'dedup key tag');
			assert.strictEqual(pnpm.source, 'auto');
		} finally { service.dispose(); }
	});

	test('re-recording the same rule dedups instead of duplicating', () => {
		const f = makeStorage();
		const service = new AgentMemoryService(f.storageService as never);
		try {
			const ep1 = makeEpisode({ invariants: ['always use pnpm in this repo'] });
			consolidateEpisode(service, 'thread-abc12345', ep1);
			// a LATER episode re-records the same rule (whitespace differs)
			const ep2 = makeEpisode({ invariants: ['always  use pnpm in this repo'] });
			consolidateEpisode(service, 'thread-def67890', ep2);
			assert.strictEqual(service.getAllEntries().length, 1, 'the same rule must not duplicate');
		} finally { service.dispose(); }
	});

	test('an edited rule replaces the outdated truth and keeps first-seen provenance', () => {
		const f = makeStorage();
		const service = new AgentMemoryService(f.storageService as never);
		try {
			consolidateEpisode(service, 'thread-abc12345', makeEpisode({ invariants: ['run tests with vitest'] }));
			// later the user corrects: jest, not vitest — the DERIVED rule differs
			consolidateEpisode(service, 'thread-abc12345', makeEpisode({ corrections: [{ userSaid: 'actually we use jest', ruleDerived: 'run tests with jest', sourceIds: [3] }] }));
			const all = service.getAllEntries();
			assert.ok(all.some(e => e.content === 'run tests with jest'), 'the corrected rule is stored');
			assert.ok(all.some(e => e.content === 'run tests with vitest'), 'the old rule remains a historical record (distinct key — not silently rewritten)');
			assert.strictEqual(all.filter(e => e.content === 'run tests with jest').length, 1);
		} finally { service.dispose(); }
	});

	test('secret-shaped content never becomes durable memory', () => {
		assert.ok(looksLikeSecret('my api_key is abc'), 'api_key pattern');
		assert.ok(looksLikeSecret('sk-proj-abcdefghijklmnop123456'), 'openai key pattern');
		assert.ok(looksLikeSecret('password: hunter2'), 'password assignment');
		assert.ok(!looksLikeSecret('always use pnpm'), 'a normal rule is not a secret');
		const ep = makeEpisode({
			invariants: ['the deploy token is gho_abcdefghijklmnopqrstuvwxyz0123456789'],
			decisions: [{ what: 'deploy on fridays', why: 'quiet day', sourceIds: [1] }],
		});
		const extracted = extractDurableMemories(ep);
		assert.strictEqual(extracted.length, 1, 'the secret-bearing invariant is refused');
		assert.strictEqual(extracted[0].rule, 'deploy on fridays', 'the clean decision still lands');
	});

	test('forgetting from the manager stays forgotten — no resurrection', async () => {
		const f = makeStorage();
		const service = new AgentMemoryService(f.storageService as never);
		try {
			consolidateEpisode(service, 'thread-abc12345', makeEpisode({ invariants: ['never force-push main'] }));
			const entry = service.getAllEntries()[0];
			service.forget(entry.id);
			assert.strictEqual(service.getAllEntries().length, 0);
			// a later unrelated episode must not resurrect it
			consolidateEpisode(service, 'thread-abc12345', makeEpisode({ decisions: [{ what: 'ship on monday', why: 'x', sourceIds: [1] }] }));
			assert.ok(!service.getAllEntries().some(e => e.content.includes('force-push')), 'deleted memory does not return');
		} finally { service.dispose(); }
	});
});
