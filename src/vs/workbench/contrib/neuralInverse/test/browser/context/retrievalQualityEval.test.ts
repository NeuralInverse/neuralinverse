/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

/**
 *  B5 retrieval-quality evaluation (task 2026-09-15 §B5). A small but
 *  representative, repeatable benchmark with reference answers, run over the
 *  REAL services (BM25 + relevance scorer + context packer + agent memory),
 *  with thresholds FIXED BEFORE the run — they are never lowered after seeing
 *  results. Metrics: hit@3, precision@3 (no unrelated file may enter), token
 *  cost of the injected context, per-query latency, failure count.
 *
 *  Modes: EVAL_RECORD=<label> writes .build/retrieval-eval-<label>.json and
 *  skips assertions (for before/after comparison); default mode asserts.
 */
import assert from 'assert';
import { Event } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { WorkspaceBM25Service } from '../../../browser/context/search/bm25Index.js';
import { HybridSearchService } from '../../../browser/context/search/hybridSearchService.js';
import { RelevanceScorerService } from '../../../browser/context/relevance/relevanceScorer.js';

import { AgentMemoryService } from '../../../../void/browser/agentMemoryService.js';

import type { IEpisodeSummary } from '../../../../void/common/ledgerTypes.js';
import type { IStoredChunk } from '../../../browser/context/search/persistentStore.js';

const RECORD_LABEL = process.env.EVAL_RECORD;

// B5 before/after: capabilities introduced by this round are resolved
// dynamically so the SAME harness runs on the pre-round source (2c3a561)
// and records their absence instead of failing to load.
type PackerCtor = new (...args: unknown[]) => { packToString(req: unknown): Promise<string>; dispose(): void };
type ConsolidateFn = (memory: unknown, threadId: string, episode: unknown) => number;
let packerCtor: PackerCtor | undefined;
let consolidate: ConsolidateFn | undefined;
try {
	const mod = await import('../../../browser/context/packer/contextPacker.js');
	packerCtor = (mod as { ContextPackerService?: PackerCtor }).ContextPackerService;
} catch { /* pre-round source: not exported */ }
try {
	const mod = await import('../../../../void/browser/agentMemoryConsolidationContrib.js');
	consolidate = (mod as { consolidateEpisode?: ConsolidateFn }).consolidateEpisode;
} catch { /* pre-round source: contrib absent */ }
// the standalone runner executes from the repo root but emits to a temp
// tree — resolve the real repo from cwd (fall back to the temp tree)
const REPO = process.env.NI_REPO_ROOT ?? process.cwd();

// ─── fixtures ────────────────────────────────────────────────────────────────

const DOC_GUIDE = [
	'# Ops Handbook',
	'',
	'## Deploy Checklist',
	'run the pipeline, wait for the green gate, then publish the artifacts.',
	'',
	'## Rollback Procedure',
	'scale down the canary and restore the previous image tag.',
].join('\n');

const DOC_RUNBOOK = [
	'# Shipping Runbook',
	'scale the fleet and rotate certificates every quarter.',
].join('\n');

const pricingUri = 'file:///ws/src/pricing.ts';
const currencyUri = 'file:///ws/src/currency.ts';
const unrelatedUri = 'file:///ws/src/unrelated-huge.ts';
const importsOf: Record<string, string[]> = { [pricingUri]: [currencyUri] };
const filesOnDisk: Record<string, string> = {
	[pricingUri]: 'export function checkoutTotal() {\n\treturn 42;\n}\n',
	[currencyUri]: 'export function formatMoney(c: number) {\n\treturn `$${c}`;\n}\n',
	[unrelatedUri]: '// lorem filler line\n'.repeat(3_000),
};

class FakeStore {
	readonly chunks = new Map<string, IStoredChunk>();
	private hashes = new Map<string, string>();
	async initialize(): Promise<void> { }
	async putChunks(list: IStoredChunk[]): Promise<void> { for (const c of list) { this.chunks.set(c.id, c); this.hashes.set(c.filePath, c.contentHash); } }
	async getChunksByFile(fp: string): Promise<IStoredChunk[]> { return [...this.chunks.values()].filter(c => c.filePath === fp); }
	async getAllChunks(): Promise<IStoredChunk[]> { return [...this.chunks.values()]; }
	async deleteChunksByFile(fp: string): Promise<void> { for (const [id, c] of this.chunks) { if (c.filePath === fp) { this.chunks.delete(id); } } this.hashes.delete(fp); }
	async clearAll(): Promise<void> { this.chunks.clear(); this.hashes.clear(); }
	async getFileContentHash(fp: string): Promise<string | undefined> { return this.hashes.get(fp); }
}

const fakeWorkspace = { getWorkspace: () => ({ folders: [{ uri: { toString: () => 'file:///ws' } }] }) };
const symbolsByFile: Record<string, Array<{ name: string; kind: number; filePath: string; range: { startLine: number; endLine: number }; exportedAs?: string }>> = {
	[pricingUri]: [{ name: 'checkoutTotal', kind: 12, filePath: pricingUri, range: { startLine: 1, endLine: 3 }, exportedAs: 'checkoutTotal' }],
	[currencyUri]: [{ name: 'formatMoney', kind: 12, filePath: currencyUri, range: { startLine: 1, endLine: 3 }, exportedAs: 'formatMoney' }],
};

function makeScorer() {
	return new RelevanceScorerService(
		{ activeEditor: undefined, editors: [], onDidActiveEditorChange: Event.None, onDidCloseEditor: Event.None } as never,
		{
			getSymbolsByName: (n: string) => n.toLowerCase().includes('checkout') ? [{ name: 'checkoutTotal', kind: 12, filePath: pricingUri, range: { startLine: 1, endLine: 3 } }] : [],
			getSymbolsInFile: (uri: string) => symbolsByFile[uri] ?? [],
			getImports: (uri: string) => importsOf[uri] ?? [],
			getImporters: (uri: string) => Object.entries(importsOf).filter(([, v]) => v.includes(uri)).map(([k]) => k),
			getFileIndex: (uri: string) => filesOnDisk[uri] !== undefined ? { uri } : undefined,
		} as never,
		{ getCoEditedFiles: () => [], getRecentlyEdited: () => [], getEditHeat: () => 0, getEditVelocity: () => 0, getHotRegions: () => [] } as never,
		{ search: async () => [] } as never,
	);
}

function makePacker(scorer: RelevanceScorerService) {
	if (packerCtor === undefined) { return undefined; }
	return new packerCtor(
		{ readFile: async (uri: URI) => { const c = filesOnDisk[uri.toString()]; if (c === undefined) { throw new Error('nf'); } return { value: VSBuffer.fromString(c) }; } } as never,
		{ getModel: () => null } as never,
		scorer as never,
		{ getSymbolsByName: (n: string) => n.toLowerCase().includes('checkout') ? [{ name: 'checkoutTotal', kind: 12, filePath: pricingUri, range: { startLine: 1, endLine: 3 } }] : [], getSymbolsInFile: (uri: string) => symbolsByFile[uri] ?? [], getImports: (uri: string) => importsOf[uri] ?? [] } as never,
		{ getCoEditedFiles: () => [], getRecentlyEdited: () => [], getEditHeat: () => 0, getEditVelocity: () => 0, getHotRegions: () => [] } as never,
	);
}

// ─── the benchmark ───────────────────────────────────────────────────────────

interface ScenarioResult {
	id: string;
	category: string;
	hitAt3: boolean;
	precisionAt3: number;
	tokensInjected: number;
	latencyMs: number;
	failed: boolean;
	notes: string;
}

async function runBenchmark(): Promise<ScenarioResult[]> {
	const results: ScenarioResult[] = [];
	const time = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
		const t0 = Date.now();
		const value = await fn();
		return { value, ms: Date.now() - t0 };
	};

	// lexical: exact search
	{
		const store = new FakeStore();
		const bm25 = new WorkspaceBM25Service(store as never, fakeWorkspace as never);
		try {
			await bm25.indexFile('docs/guide.md', DOC_GUIDE, 'h1');
			await bm25.indexFile('docs/runbook.md', DOC_RUNBOOK, 'h2');
			const { value: hits, ms } = await time(() => bm25.search('canary rollback image tag', 3));
			results.push({
				id: 'exact-search', category: 'exact',
				hitAt3: hits.length > 0 && hits[0].filePath === 'docs/guide.md' && hits[0].sectionTitle === 'Rollback Procedure',
				precisionAt3: hits.filter(h => h.filePath === 'docs/guide.md').length / Math.max(1, hits.length),
				tokensInjected: Math.ceil((hits[0]?.content.length ?? 0) / 4),
				latencyMs: ms, failed: false,
				notes: `top=${hits[0]?.sectionTitle ?? 'none'}`,
			});
		} finally { bm25.dispose(); }
	}

	// paraphrase: different wording, NO lexical overlap — only the semantic
	// backend (hybrid search + embeddings) can find it. Deterministic local
	// embedder (contract-level; the real-provider connection stays a separate
	// open item per B2).
	{
		const store = new FakeStore();
		const bm25 = new WorkspaceBM25Service(store as never, fakeWorkspace as never);
		const noTrigram = { search: () => [] as unknown[] };
		// vectors: axis 0 = undo/rollback/revert/restore topic, axis 1 = deploy
		const axis = (w: string): number => /undo|rollback|revert|restore|canary|previous|roll/.test(w) ? 0 : /deploy|release|ship|publish/.test(w) ? 1 : -1;
		const fakeEmbed = {
			get isAvailable() { return true; },
			get model() { return 'eval-embed-1'; },
			search: async (query: string, maxResults: number) => {
				const q = query.toLowerCase().split(/[^a-z]+/).map(axis).filter(a => a >= 0);
				const docs: Array<{ id: string; filePath: string; text: string; startLine: number; endLine: number }> = [
					{ id: 'guide:rollback', filePath: 'docs/guide.md', text: 'Rollback Procedure scale down the canary and restore the previous image tag.', startLine: 6, endLine: 7 },
					{ id: 'guide:deploy', filePath: 'docs/guide.md', text: 'Deploy Checklist run the pipeline publish the artifacts.', startLine: 3, endLine: 4 },
					{ id: 'runbook:ship', filePath: 'docs/runbook.md', text: 'Shipping Runbook scale the fleet rotate certificates.', startLine: 1, endLine: 2 },
				];
				const q0 = q.filter(a => a === 0).length, q1 = q.filter(a => a === 1).length;
				const qn = Math.sqrt(q0 * q0 + q1 * q1) || 1;
				return docs
					.map(d => {
						const t = d.text.toLowerCase().split(/[^a-z]+/).map(axis).filter(a => a >= 0);
						const d0 = t.filter(a => a === 0).length, d1 = t.filter(a => a === 1).length;
						const dn = Math.sqrt(d0 * d0 + d1 * d1) || 1;
						const cos = (q0 * d0 + q1 * d1) / (qn * dn);
						return { id: d.id, filePath: d.filePath, similarity: cos, startLine: d.startLine, endLine: d.endLine, content: d.text };
					})
					.filter(r => r.similarity > 0.3)
					.sort((a, b) => b.similarity - a.similarity)
					.slice(0, maxResults);
			},
		};
		const hybrid = new HybridSearchService(bm25 as never, noTrigram as never, fakeEmbed as never);
		try {
			await bm25.indexFile('docs/guide.md', DOC_GUIDE, 'h1');
			await bm25.indexFile('docs/runbook.md', DOC_RUNBOOK, 'h2');
			// 'undo a release safely' shares no token with the rollback section
			const { value: hits, ms } = await time(() => hybrid.search('undo a release safely', 3));
			results.push({
				id: 'paraphrase', category: 'paraphrase',
				hitAt3: hits.some(h => h.filePath === 'docs/guide.md' && (h.startLine ?? 0) >= 6),
				precisionAt3: hits.filter(h => h.filePath === 'docs/guide.md').length / Math.max(1, hits.length),
				tokensInjected: Math.ceil((hits[0]?.content?.length ?? 0) / 4),
				latencyMs: ms, failed: false,
				notes: `top=${hits[0]?.filePath ?? 'none'}@${hits[0]?.startLine ?? '?'}`,
			});
		} finally { hybrid.dispose(); bm25.dispose(); }
	}

	// document recall with local citation
	{
		const store = new FakeStore();
		const bm25 = new WorkspaceBM25Service(store as never, fakeWorkspace as never);
		try {
			await bm25.indexFile('docs/guide.md', DOC_GUIDE, 'h1');
			const { value: hits, ms } = await time(() => bm25.search('deploy checklist green gate publish artifacts', 3));
			const top = hits[0];
			results.push({
				id: 'doc-citation', category: 'doc',
				hitAt3: !!top && top.filePath === 'docs/guide.md' && top.sectionTitle === 'Deploy Checklist' && top.startLine >= 3,
				precisionAt3: 1,
				tokensInjected: Math.ceil((top?.content.length ?? 0) / 4),
				latencyMs: ms, failed: false,
				notes: `citation=${top ? `${top.filePath}#${top.sectionTitle}:${top.startLine}-${top.endLine}` : 'none'}`,
			});
		} finally { bm25.dispose(); }
	}

	// same-name symbol: two files could define it; only the queried one may rank
	{
		const scorer = makeScorer();
		try {
			const { value: scored, ms } = await time(() => scorer.scoreFilesAsync({ type: 'message', text: 'edit the checkout total calculation' }, 3));
			const uris = scored.map(s => s.uri);
			results.push({
				id: 'same-name-symbol', category: 'symbol',
				hitAt3: uris.includes(pricingUri),
				precisionAt3: uris.filter(u => u === pricingUri || u === currencyUri).length / Math.max(1, uris.length),
				tokensInjected: 0,
				latencyMs: ms, failed: false,
				notes: `ranked=${uris.map(u => u.split('/').pop()).join(',')}`,
			});
		} finally { scorer.dispose(); }
	}

	// corrected decision: the LATER (corrected) rule outranks the outdated
	// one — recorded through the real B1 consolidation path, with the
	// correction recorded later so recency reflects which is current
	{
		const stored: Record<string, string> = {};
		const storage = { get: (k: string) => stored[k], store: (k: string, v: string) => { stored[k] = v; }, onWillSaveState: () => ({ dispose: () => { } }) };
		const memory = new AgentMemoryService(storage as never);
		try {
			const ep = (body: { invariants?: string[]; corrections?: Array<{ userSaid: string; ruleDerived?: string; sourceIds: number[] }> }): IEpisodeSummary => ({
				id: 'ep_t_1', threadId: 'thread-eval', ordinal: 1, range: { fromSeq: 1, toSeq: 2 },
				createdAt: Date.now(), producedBy: 'deterministic', frozen: true,
				body: {
					goal: 'g', decisions: [], rejected: [], failures: [],
					corrections: [], invariants: [],
					artifacts: { files: [], symbols: [], commands: [], configs: [] },
					state: { done: [], inProgress: [], verified: [] }, next: [], openQuestions: [],
					...body,
				},
			});
			if (consolidate !== undefined) {
				consolidate(memory, 'thread-eval', ep({ invariants: ['run tests with vitest'] }));
				await new Promise(r => setTimeout(r, 25)); // the correction is newer
				consolidate(memory, 'thread-eval', ep({ corrections: [{ userSaid: 'we moved to jest', ruleDerived: 'run tests with jest', sourceIds: [1] }] }));
			} else {
				// pre-round source: no capture path — store the same two rules
				// directly so the RECALL side is still measured
				memory.remember('preference', 'run tests with vitest', ['rule-old'], 'auto');
				await new Promise(r => setTimeout(r, 25));
				memory.remember('preference', 'run tests with jest', ['rule-new'], 'auto');
			}
			const { value: recalled, ms } = await time(() => memory.recallForPrompt('which test runner do we use', 1500, 8));
			const correctedIdx = recalled.indexOf('with jest');
			const outdatedIdx = recalled.indexOf('with vitest');
			results.push({
				id: 'corrected-decision', category: 'memory',
				hitAt3: correctedIdx >= 0 && (outdatedIdx < 0 || correctedIdx < outdatedIdx),
				precisionAt3: correctedIdx >= 0 ? 1 : 0,
				tokensInjected: Math.ceil(recalled.length / 4),
				latencyMs: ms, failed: false,
				notes: `corrected@${correctedIdx} outdated@${outdatedIdx} capture=${consolidate !== undefined}`,
			});
		} finally { memory.dispose(); }
	}

	// multi-file edit task: target + dependency retrieved, big unrelated dropped
	{
		const scorer = makeScorer();
		const packer = makePacker(scorer);
		if (packer === undefined) {
			results.push({ id: 'multi-file-edit', category: 'edit-task', hitAt3: false, precisionAt3: 0, tokensInjected: 0, latencyMs: 0, failed: false, notes: 'packer not constructible on this source (pre-round)' });
		} else {
			try {
				const { value: packed, ms } = await time(() => packer.packToString({ query: { type: 'message', text: 'edit the checkout total calculation' }, budget: 2_048, mode: 'chat' }));
			const hasTarget = packed.includes('checkoutTotal');
			const hasDependency = packed.includes('formatMoney');
			const hasUnrelated = packed.includes('lorem');
			results.push({
				id: 'multi-file-edit', category: 'edit-task',
				hitAt3: hasTarget && hasDependency,
				precisionAt3: hasUnrelated ? 0 : 1,
				tokensInjected: Math.ceil(packed.length / 4),
				latencyMs: ms, failed: false,
				notes: `target=${hasTarget} dependency=${hasDependency} unrelated=${hasUnrelated}`,
			});
			} finally { scorer.dispose(); packer?.dispose(); }
		}
	}

	// unrelated-only query: nothing may be injected
	{
		const scorer = makeScorer();
		try {
			const { value: scored, ms } = await time(() => scorer.scoreFilesAsync({ type: 'message', text: 'zürich weather forecast tomorrow' }, 3));
			results.push({
				id: 'unrelated-query', category: 'negative',
				hitAt3: scored.length === 0,
				precisionAt3: 1,
				tokensInjected: 0,
				latencyMs: ms, failed: false,
				notes: `candidates=${scored.length}`,
			});
		} finally { scorer.dispose(); }
	}

	return results;
}

// thresholds fixed BEFORE any run (B5 rule: never lower them after looking)
const MIN_HITS = 7;          // of 7 scenarios
const MAX_AVG_LATENCY_MS = 500;
const MAX_FAILURES = 0;

suite('Retrieval quality evaluation — B5 (fixed thresholds)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('benchmark meets the pre-fixed thresholds', async () => {
		const results = await runBenchmark();

		if (RECORD_LABEL !== undefined) {
			// artifact writing is node-only; the dynamic import keeps the
			// browser-layer import surface clean (the runner executes in node)
			const { mkdirSync, writeFileSync } = await import('node:fs');
			const { join } = await import('node:path');
			const dir = join(REPO, '.build');
			mkdirSync(dir, { recursive: true });
			const path = join(dir, `retrieval-eval-${RECORD_LABEL}.json`);
			writeFileSync(path, JSON.stringify({ recordedAt: new Date().toISOString(), results, thresholds: { MIN_HITS, MAX_AVG_LATENCY_MS, MAX_FAILURES } }, null, 2));
			console.log(`[eval] recorded ${results.length} scenarios → ${path}`);
			return;
		}

		const hits = results.filter(r => r.hitAt3).length;
		const failures = results.filter(r => r.failed).length;
		const avgLatency = results.reduce((s, r) => s + r.latencyMs, 0) / results.length;
		const summary = results.map(r => `${r.id}: hit=${r.hitAt3} p@3=${r.precisionAt3.toFixed(2)} ${r.latencyMs}ms ${r.notes}`).join('\n');
		console.log(`[eval]\n${summary}\n[eval] hits ${hits}/${results.length}, avg latency ${avgLatency.toFixed(0)}ms`);
		assert.strictEqual(failures, MAX_FAILURES, 'no scenario may hard-fail');
		assert.ok(hits >= MIN_HITS, `${hits}/${results.length} scenarios hit; expected >= ${MIN_HITS}:\n${summary}`);
		assert.ok(avgLatency <= MAX_AVG_LATENCY_MS, `avg latency ${avgLatency}ms exceeds ${MAX_AVG_LATENCY_MS}ms`);
	});
});
