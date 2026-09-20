/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	AgentMemoryService,
	buildMatchReasons,
	computeTermOverlap,
	fuseScores,
	fusedImportance,
	scoreCosine,
	selectEvictionCandidates,
	IAgentMemoryEntry,
	IFuseFactors,
} from '../../browser/agentMemoryService.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function makeEntry(overrides: Partial<IAgentMemoryEntry> = {}): IAgentMemoryEntry {
	return {
		id: overrides.id ?? `mem_${Math.random().toString(36).slice(2, 8)}`,
		type: 'preference',
		content: 'always use pnpm for package management',
		relevance: 0.5,
		createdAt: NOW,
		lastAccessedAt: NOW,
		accessCount: 0,
		tags: [],
		...overrides,
	};
}

function factors(overrides: Partial<IFuseFactors> = {}): IFuseFactors {
	return { cosine: null, term: 0, recency: 0, frequency: 0, relevance: 0, ...overrides };
}

const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Suite: scoreCosine
// ---------------------------------------------------------------------------

suite('agentMemoryHybrid — scoreCosine', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('identical vectors score 1', () => {
		assert.ok(Math.abs(scoreCosine([1, 0, 0], [1, 0, 0]) - 1) < EPS);
		assert.ok(Math.abs(scoreCosine([0.2, -0.4, 0.9], [0.2, -0.4, 0.9]) - 1) < EPS);
	});

	test('vectors are unit-normalized: scaling does not change the score', () => {
		assert.ok(Math.abs(scoreCosine([1, 0], [2, 0]) - 1) < EPS);
		assert.ok(Math.abs(scoreCosine([3, 4], [6, 8]) - 1) < EPS);
	});

	test('orthogonal vectors score 0', () => {
		assert.ok(Math.abs(scoreCosine([1, 0], [0, 1])) < EPS);
		assert.ok(Math.abs(scoreCosine([0.5, 0.5], [0.5, -0.5])) < EPS);
	});

	test('opposite vectors score -1 (raw), empty or mismatched vectors score 0', () => {
		assert.ok(Math.abs(scoreCosine([1, 0], [-1, 0]) + 1) < EPS);
		assert.strictEqual(scoreCosine([], []), 0);
		assert.strictEqual(scoreCosine([1, 0], [1, 0, 0]), 0);
		assert.strictEqual(scoreCosine([0, 0], [0, 0]), 0, 'zero vector has no direction');
	});
});

// ---------------------------------------------------------------------------
// Suite: fuseScores
// ---------------------------------------------------------------------------

suite('agentMemoryHybrid — fuseScores weights', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('hybrid mode: 0.5·cosine + 0.2·term + 0.2·recency + 0.1·frequency', () => {
		assert.ok(Math.abs(fuseScores(factors({ cosine: 1, term: 1, recency: 1, frequency: 1 }), 'hybrid') - 1) < EPS);
		assert.ok(Math.abs(fuseScores(factors({ cosine: 0.8, term: 0.5, recency: 0.25, frequency: 0 }), 'hybrid')
			- (0.5 * 0.8 + 0.2 * 0.5 + 0.2 * 0.25)) < EPS);
		assert.ok(Math.abs(fuseScores(factors({ cosine: 1 }), 'hybrid') - 0.5) < EPS, 'cosine alone contributes 0.5');
	});

	test('lexical-promoted mode redistributes the vector weight to term match', () => {
		assert.ok(Math.abs(fuseScores(factors({ term: 1, recency: 1, frequency: 1 }), 'lexical-promoted') - 1) < EPS);
		assert.ok(Math.abs(fuseScores(factors({ term: 1 }), 'lexical-promoted') - 0.7) < EPS, 'promoted term weight is 0.7');
		assert.ok(Math.abs(fuseScores(factors({ recency: 1 }), 'lexical-promoted') - 0.2) < EPS);
		assert.ok(Math.abs(fuseScores(factors({ frequency: 1 }), 'lexical-promoted') - 0.1) < EPS);
	});

	test('lexical mode reproduces the original scoring weights exactly', () => {
		assert.ok(Math.abs(fuseScores(factors({ term: 1 }), 'lexical') - 0.5) < EPS);
		assert.ok(Math.abs(fuseScores(factors({ recency: 1 }), 'lexical') - 0.25) < EPS);
		assert.ok(Math.abs(fuseScores(factors({ frequency: 1 }), 'lexical') - 0.15) < EPS);
		assert.ok(Math.abs(fuseScores(factors({ relevance: 1 }), 'lexical') - 0.1) < EPS);
	});

	test('missing cosine is treated as 0, so promoted entries still compete', () => {
		const f = factors({ cosine: null, term: 0.6, recency: 0.5, frequency: 0.2 });
		const hybridWithZeroCosine = fuseScores({ ...f, cosine: 0 }, 'hybrid');
		const promoted = fuseScores(f, 'lexical-promoted');
		assert.ok(promoted >= hybridWithZeroCosine, 'term promotion must not lose to a zero-cosine hybrid score');
		assert.ok(Math.abs(promoted - (0.7 * 0.6 + 0.2 * 0.5 + 0.1 * 0.2)) < EPS);
	});

	test('factors are clamped to 0..1 before weighting', () => {
		const over = fuseScores(factors({ cosine: 5, term: 5, recency: 5, frequency: 5, relevance: 5 }), 'hybrid');
		assert.ok(Math.abs(over - 1) < EPS);
		const negative = fuseScores(factors({ cosine: -3, term: -1, recency: -1, frequency: -1 }), 'hybrid');
		assert.strictEqual(negative, 0);
	});
});

// ---------------------------------------------------------------------------
// Suite: computeTermOverlap
// ---------------------------------------------------------------------------

suite('agentMemoryHybrid — computeTermOverlap', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('score is the matched fraction of query terms', () => {
		const entryTerms = new Set(['always', 'use', 'pnpm', 'package', 'management']);
		const { score, matched } = computeTermOverlap(['pnpm', 'docker'], entryTerms);
		assert.strictEqual(score, 0.5);
		assert.deepStrictEqual(matched, ['pnpm']);
	});

	test('all terms matched scores 1; empty query scores 0', () => {
		const entryTerms = new Set(['pnpm', 'docker']);
		assert.strictEqual(computeTermOverlap(['pnpm', 'docker'], entryTerms).score, 1);
		assert.strictEqual(computeTermOverlap([], entryTerms).score, 0);
		assert.deepStrictEqual(computeTermOverlap([], entryTerms).matched, []);
	});

	test('no shared terms scores 0 with empty match list', () => {
		const { score, matched } = computeTermOverlap(['yarn', 'webpack'], new Set(['pnpm']));
		assert.strictEqual(score, 0);
		assert.deepStrictEqual(matched, []);
	});
});

// ---------------------------------------------------------------------------
// Suite: buildMatchReasons
// ---------------------------------------------------------------------------

suite('agentMemoryHybrid — buildMatchReasons', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('formats vector similarity to two decimals', () => {
		assert.deepStrictEqual(
			buildMatchReasons(0.823, ['pnpm'], 1, 0),
			['vector:0.82', 'term:pnpm', 'recent'],
		);
	});

	test('omits the vector reason when cosine is null or trivial', () => {
		assert.ok(!buildMatchReasons(null, ['pnpm'], 1, 0).some(r => r.startsWith('vector:')));
		assert.ok(!buildMatchReasons(0.05, ['pnpm'], 1, 0).some(r => r.startsWith('vector:')));
		assert.ok(buildMatchReasons(0.06, [], 100, 0).includes('vector:0.06'));
	});

	test('term reason dedupes and caps at three terms', () => {
		assert.strictEqual(
			buildMatchReasons(null, ['pnpm', 'pnpm'], 100, 0)[0],
			'term:pnpm',
		);
		assert.strictEqual(
			buildMatchReasons(null, ['pnpm', 'docker', 'yarn', 'git'], 100, 0)[0],
			'term:pnpm,docker,yarn',
		);
	});

	test('recent applies within 7 days, frequent at 3+ accesses', () => {
		assert.ok(buildMatchReasons(null, [], 7, 0).includes('recent'));
		assert.ok(!buildMatchReasons(null, [], 7.1, 0).includes('recent'));
		assert.ok(buildMatchReasons(null, [], 100, 3).includes('frequent'));
		assert.ok(!buildMatchReasons(null, [], 100, 2).includes('frequent'));
	});

	test('reasons come back empty when nothing matched non-trivially', () => {
		assert.deepStrictEqual(buildMatchReasons(null, [], 100, 0), []);
	});
});

// ---------------------------------------------------------------------------
// Suite: eviction
// ---------------------------------------------------------------------------

suite('agentMemoryHybrid — fused importance & eviction', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('fusedImportance decays relevance with recency and rewards access', () => {
		const fresh = fusedImportance(makeEntry({ relevance: 0.5, lastAccessedAt: NOW }), NOW);
		const stale = fusedImportance(makeEntry({ relevance: 0.5, lastAccessedAt: NOW - 365 * 86_400_000 }), NOW);
		assert.ok(fresh > stale, 'same relevance must rank fresher entries higher');

		const rare = fusedImportance(makeEntry({ accessCount: 0, lastAccessedAt: NOW }), NOW);
		const often = fusedImportance(makeEntry({ accessCount: 10, lastAccessedAt: NOW }), NOW);
		assert.ok(often > rare, 'access count must raise importance');
	});

	test('selects the lowest-importance entries until under capacity', () => {
		const low = makeEntry({ id: 'low', relevance: 0.1, lastAccessedAt: NOW - 30 * 86_400_000 });
		const mid = makeEntry({ id: 'mid', relevance: 0.5, lastAccessedAt: NOW });
		const high = makeEntry({ id: 'high', relevance: 1, accessCount: 10, lastAccessedAt: NOW });
		const victims = selectEvictionCandidates([mid, high, low], 2, NOW);
		assert.deepStrictEqual(victims.map(v => v.id), ['low']);
	});

	test('pinned entries are never evicted, even when they rank lowest', () => {
		const pinned = makeEntry({ id: 'pinned', pinned: true, relevance: 0, lastAccessedAt: NOW - 365 * 86_400_000 });
		const a = makeEntry({ id: 'a', relevance: 0.9 });
		const b = makeEntry({ id: 'b', relevance: 0.8 });
		const victims = selectEvictionCandidates([pinned, a, b], 2, NOW);
		assert.ok(victims.every(v => v.id !== 'pinned'), 'pinned entry must survive');
		assert.deepStrictEqual(victims.map(v => v.id), ['b'], 'eviction falls through to the lowest unpinned entry');
	});

	test('under capacity nothing is selected; entries array is not mutated', () => {
		const a = makeEntry({ id: 'a' });
		const b = makeEntry({ id: 'b' });
		const input = [a, b];
		assert.deepStrictEqual(selectEvictionCandidates(input, 5, NOW), []);
		assert.deepStrictEqual(input, [a, b]);
	});
});

// ---------------------------------------------------------------------------
// Suite: recallForPrompt / backfillEmbeddings — the M2 injection-path wiring
// ---------------------------------------------------------------------------

suite('agentMemoryService — recallForPrompt + backfill (M2)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const makeService = () => {
		const stored: Record<string, string> = {};
		const storage = {
			get: (key: string) => stored[key],
			store: (key: string, value: string) => { stored[key] = value; },
			onWillSaveState: () => ({ dispose: () => { } }),
		};
		const service = new AgentMemoryService(storage as never);
		return { service, stored };
	};

	test('recallForPrompt returns query-relevant memories with match reasons', async () => {
		const { service } = makeService();
		service.remember('preference', 'always use pnpm for package management');
		service.remember('project-fact', 'the deploy pipeline runs on fridays');
		const out = await service.recallForPrompt('package manager', 1500, 8);
		assert.ok(out.includes('pnpm'), 'the pnpm memory must be recalled');
		assert.ok(out.includes('(matched:'), 'each line carries its match reasons');
		// F12 admission gate: a lexically/semantically unrelated entry is not
		// recalled at all — recency/frequency only ORDER related candidates,
		// they can no longer admit an unrelated memory by themselves.
		assert.ok(!out.includes('fridays'), 'an unrelated-but-fresh memory must not be admitted');
	});

	test('recallForPrompt with an empty query returns an empty string', async () => {
		const { service } = makeService();
		service.remember('preference', 'something');
		assert.strictEqual(await service.recallForPrompt('   '), '');
	});

	test('recallForPrompt respects the token budget', async () => {
		const { service } = makeService();
		service.remember('preference', 'pnpm ' + 'x'.repeat(4000));
		const out = await service.recallForPrompt('pnpm', 10, 8);
		assert.strictEqual(out, '', 'a single over-budget line does not fit');
	});

	test('backfillEmbeddings is a no-op without a provider, embeds everything with one', async () => {
		const { service, stored } = makeService();
		service.remember('preference', 'alpha');
		service.remember('preference', 'beta');
		assert.strictEqual(await service.backfillEmbeddings(), 0);
		assert.ok(!stored['ni.agent.memory'], 'nothing persisted without a provider');

		service.setEmbeddingProvider(async () => [0.1, 0.2, 0.3]);
		assert.strictEqual(await service.backfillEmbeddings(1), 2);
		service.dispose(); // flush the debounced persist
		const persisted = JSON.parse(stored['ni.agent.memory']) as Array<{ content: string; embedding?: number[] }>;
		assert.strictEqual(persisted.filter(e => Array.isArray(e.embedding)).length, 2, 'both entries got vectors');
	});
});

suite('agentMemoryService — tool upsert by key (M7)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const makeService = () => {
		const stored: Record<string, string> = {};
		const storage = {
			get: (key: string) => stored[key],
			store: (key: string, value: string) => { stored[key] = value; },
			onWillSaveState: () => ({ dispose: () => { } }),
		};
		const service = new AgentMemoryService(storage as never);
		return { service, stored };
	};

	test('upsertByKey stores a manual entry findable via findByTag', () => {
		const { service } = makeService();
		service.upsertByKey('package_manager', 'always use pnpm, never npm');
		const entry = service.findByTag('package_manager');
		assert.ok(entry, 'the entry is retrievable by its key tag');
		assert.strictEqual(entry!.content, 'always use pnpm, never npm');
		assert.strictEqual(entry!.source, 'manual');
		assert.strictEqual(entry!.type, 'preference', 'type defaults to preference');
	});

	test('upsertByKey with the same key replaces instead of duplicating', () => {
		const { service } = makeService();
		service.upsertByKey('package_manager', 'always use npm');
		service.upsertByKey('package_manager', 'always use pnpm, never npm');
		assert.strictEqual(service.count, 1, 'one entry after two same-key writes');
		assert.strictEqual(service.findByTag('package_manager')!.content, 'always use pnpm, never npm');
	});

	test('upsertByKey with different keys keeps separate entries', () => {
		const { service } = makeService();
		service.upsertByKey('package_manager', 'always use pnpm');
		service.upsertByKey('deploy_day', 'deploys run on fridays', 'project-fact');
		assert.strictEqual(service.count, 2);
		assert.strictEqual(service.findByTag('deploy_day')!.type, 'project-fact');
	});

	test('findByTag returns undefined for an unknown key', () => {
		const { service } = makeService();
		service.upsertByKey('package_manager', 'always use pnpm');
		assert.strictEqual(service.findByTag('nope'), undefined);
	});

	test('upsertByKey entries flow into recallForPrompt (owner test 2 shape)', async () => {
		const { service } = makeService();
		service.upsertByKey('escapezoom-html_package_manager', 'In this project always use pnpm, never npm.');
		const out = await service.recallForPrompt('do not change the package manager of this project', 1500, 8);
		assert.ok(out.includes('Agent Memory (1 entries):'), 'the injected block is present');
		assert.ok(out.includes('pnpm'), 'the stored preference is recalled');
	});
});
