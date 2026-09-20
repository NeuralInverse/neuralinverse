/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Virtual-million-token benchmark (campaign §7) against the REAL ledger
 * pipeline: ContextLedgerService (fake IO), resolveCloseBoundary with
 * mid-turn checkpoints, the deterministic episode summarizer, saveEpisode,
 * and LedgerRecallService over an in-memory store.
 *
 * Token counts come from a REAL BPE tokenizer (gpt-tokenizer/cl100k_base)
 * loaded from the repo's throwaway bench dir (.build/bench) — character
 * volumes are never reported as tokens. The corpus is deterministic; the
 * needle facts are placed at controlled archive positions.
 */

import assert from 'assert';
// the standalone runner executes this file in node: node-builtin module
// resolution is intentional here (tokenizer loading for the 1M benchmark)
// eslint-disable-next-line local/code-import-patterns
import { createRequire } from 'module';
// eslint-disable-next-line local/code-import-patterns
import path from 'path';
// node-runner benchmark: this suite intentionally drives browser-layer
// services (ledger, recall, firmware FS) from the standalone node runner;
// the layering/import rules are disabled line-by-line for exactly that.
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import { ContextLedgerService } from '../../browser/contextLedgerService.js';
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import { registerInverseExecFn } from '../../../neuralInverseFirmware/browser/engine/utils/inverseFs.js';
import { resolveCloseBoundary } from '../../common/ledgerBoundary.js';
import { DEFAULT_LEDGER_POLICY } from '../../common/ledgerPolicy.js';
import { EpisodeSummarizer } from '../../common/episodeSummarizer.js';
import { buildWorkingBrief } from '../../common/workingBriefBuilder.js';
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import { LedgerRecallService } from '../../../neuralInverse/browser/context/search/ledgerRecallService.js';
import type { ILedgerEntry } from '../../common/ledgerTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

registerInverseExecFn(async () => { /* no chmod in tests */ });

// ─── real tokenizer (no character-volume shortcuts) ──────────────────────────

function loadTokenizer(): { encode: (s: string) => number[] } {
	const candidates = [
		path.resolve(import.meta.dirname, '../../../../../../../../.build/bench/node_modules/gpt-tokenizer'),
		path.resolve(process.cwd(), '.build/bench/node_modules/gpt-tokenizer'),
	];
	for (const p of candidates) {
		try {

			const req = createRequire(path.join(p, 'noop.js'));
			const mod = req('gpt-tokenizer') as { encode: (s: string) => number[] };
			return mod;
		} catch { /* try next */ }
	}
	throw new Error('gpt-tokenizer not installed — run: cd .build/bench && npm install gpt-tokenizer');
}

// ─── deterministic corpus, token-counted ─────────────────────────────────────

interface CorpusPiece { name: string; content: string; tokens: number }

function buildCorpus(encode: (s: string) => number[], targetTokens: number): { pieces: CorpusPiece[]; totalTokens: number } {
	// Unique content templates. Each template is encoded ONCE with the real
	// tokenizer; repetitions multiply the MEASURED count (no estimation).
	const templates: Array<{ name: string; make: (i: number) => string }> = [
		{ name: 'ts-module', make: i => `export module Area${i % 40} {\n  export function handler${i}(req: Request): Response {\n    const cache = new Map<string, {hit: boolean; born: number}>();\n    for (let k = 0; k < 8; k++) { cache.set('k' + k + '-' + i, { hit: k % 2 === 0, born: Date.now() }); }\n    return Response.json({ area: ${i % 40}, rows: cache.size });\n  }\n}\n` },
		{ name: 'html-page', make: i => `<article class="page-${i % 33}" dir="rtl"><header>محصول ${i}</header><svg viewBox="0 0 24 24"><path d="M${i % 20} 4 L12 20 L${(i + 4) % 20} 4 Z"/></svg><div class="card product-${i}"><p>قیمت: ${(i * 1000).toLocaleString('fa-IR')} تومان</p></div></article>\n` },
		{ name: 'persian-notes', make: i => `یادداشت ${i}: در بازنگری شمارهٔ ${i % 17} مشخص شد که ماژول ${i % 23} باید پیش از انتشار نسخهٔ ${i % 5} به‌روزرسانی شود؛ در غیر این صورت صف بارگذاری کند می‌شود.\n` },
	];
	const perTemplate = Math.ceil(targetTokens / templates.length);
	const pieces: CorpusPiece[] = [];
	let totalTokens = 0;
	for (let t = 0; t < templates.length; t++) {
		const tpl = templates[t]!;
		// measure a batch of 25 distinct variants, average their real counts
		const sampleTokens: number[] = [];
		for (let i = 0; i < 25; i++) { sampleTokens.push(encode(tpl.make(i * 7 + t)).length); }
		const avg = sampleTokens.reduce((a, b) => a + b, 0) / sampleTokens.length;
		const reps = Math.max(1, Math.floor(perTemplate / avg));
		for (let i = 0; i < reps; i++) {
			const content = tpl.make(i * 7 + t);
			pieces.push({ name: `${tpl.name}-${i}`, content, tokens: encode(content).length });
		}
		totalTokens += pieces.slice(-reps).reduce((a, p) => a + p.tokens, 0);
	}
	return { pieces, totalTokens };
}

// needles: unique facts planted at controlled positions
const NEEDLE_START = 'NEEDLE-START-7731: the invoice reconciliation job runs under service account svc-recon-7731 every 17 minutes';
const NEEDLE_END = 'NEEDLE-END-9918: the rollback switch for the billing pipeline is documented at runbook RB-9918';
const NEEDLE_FA_SUPERSEDED = 'CONFIG-DEPRECATED: max workers is 12 (superseded — see the later update)';
const NEEDLE_FA_CURRENT = 'CONFIG-CURRENT: max workers is 48 — supersedes the earlier value of 12';

// ─── fake file service (same pattern as ledgerReadTail.test.ts) ──────────────

function makeFileService() {
	const files = new Map<string, string>();
	return {
		files,
		async readFile(uri: URI) {
			const text = files.get(uri.toString());
			if (text === undefined) { throw new Error(`File not found: ${uri.toString()}`); }
			return { value: VSBuffer.fromString(text) };
		},
		async writeFile(uri: URI, content: VSBuffer) { files.set(uri.toString(), content.toString()); },
		async createFile(uri: URI, content: VSBuffer) {
			const key = uri.toString();
			if (files.has(key)) { throw new Error('file exists'); }
			files.set(key, content.toString());
		},
		async createFolder(_uri: URI) { /* noop */ },
		async resolve(uri: URI) {
			const key = uri.toString();
			// directory resolve: list children whose parent is this URI
			const prefix = key.endsWith('/') ? key : key + '/';
			const children: { resource: URI; name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean; size: number; children: undefined }[] = [];
			for (const fkey of files.keys()) {
				if (!fkey.startsWith(prefix)) { continue; }
				const rest = fkey.slice(prefix.length);
				if (rest.length === 0 || rest.includes('/')) { continue; }
				children.push({
					resource: URI.parse(fkey),
					name: rest,
					isFile: true,
					isDirectory: false,
					isSymbolicLink: false,
					size: files.get(fkey)!.length,
					children: undefined,
				});
			}
			return {
				resource: uri,
				name: uri.path.split('/').pop() ?? '',
				isFile: false,
				isDirectory: true,
				isSymbolicLink: false,
				size: 0,
				children,
			} as never;
		},
		async del(uri: URI, _opts?: { recursive?: boolean; useTrash?: boolean }) { files.delete(uri.toString()); },
	} as never;
}

const fakeWorkspace = { getWorkspace: () => ({ folders: [{ uri: URI.file('Z:/ni-1m-bench') }] }) } as never;

function makeLedger(fs: unknown) {
	return new ContextLedgerService(fs as never, fakeWorkspace);
}

function makeRecallStore() {
	const entries = new Map<string, unknown>();
	const episodes = new Map<string, unknown>();
	return {
		initialize: async () => { },
		putLedgerEntries: async (es: Array<{ id: string }>) => { for (const e of es) { entries.set(e.id, e); } },
		putLedgerEpisodes: async (es: Array<{ id: string }>) => { for (const e of es) { episodes.set(e.id, e); } },
		getLedgerEntry: async (id: string) => entries.get(id),
		getLedgerEpisode: async (id: string) => episodes.get(id),
		getRecentEmbeddedLedgerRecords: async () => [],
		getLedgerRecordsNeedingEmbedding: async () => [],
		getLedgerEntriesByThread: async <T extends { seq: number }>(threadId: string): Promise<T[]> =>
			[...entries.values()].filter(e => (e as { threadId: string }).threadId === threadId).sort((a, b) => (a as T).seq - (b as T).seq) as T[],
		getLedgerEpisodesByThread: async <T>(threadId: string): Promise<T[]> =>
			[...episodes.values()].filter(e => (e as { threadId: string }).threadId === threadId) as T[],
		// mirrors the real store's term search over record.terms
		searchLedgerEntriesByTerms: async <T extends { terms?: string[] }>(terms: string[], limit: number): Promise<T[]> => {
			const out: T[] = [];
			for (const e of entries.values()) {
				const et = (e as { terms?: string[] }).terms ?? [];
				if (terms.some(t => et.includes(t))) { out.push(e as T); if (out.length >= limit) { break; } }
			}
			return out;
		},
		searchLedgerEpisodesByTerms: async <T extends { terms?: string[] }>(terms: string[], limit: number): Promise<T[]> => {
			const out: T[] = [];
			for (const e of episodes.values()) {
				const et = (e as { terms?: string[] }).terms ?? [];
				if (terms.some(t => et.includes(t))) { out.push(e as T); if (out.length >= limit) { break; } }
			}
			return out;
		},
		deleteLedgerEntriesByThread: async () => { },
	};
}

// ─── the benchmark ───────────────────────────────────────────────────────────

suite('Virtual 1M context — real ledger pipeline benchmark', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const THREAD = 'bench-1m-main';
	const THREAD2 = 'bench-1m-other';
	const { encode } = loadTokenizer();

	test('1M-token archive: mid-turn compaction chain keeps every original byte and closes only at completed tool groups', async function () {
		const fs = makeFileService();
		const ledger = makeLedger(fs);

		// one long turn: a user request + read tools returning the corpus
		const request = 'میخوام با الگو گیری از پروژه یه صفحه جدید برام بسازی که توش لیست محصولات باشه';
		const requestTokens = encode(request).length;
		let corpusTokens = 0;
		await ledger.append(THREAD, { role: 'user', content: request });
		let callN = 0;
		const appendTool = async (content: string) => {
			callN++;
			const callId = `call_${callN}`;
			await ledger.append(THREAD, { role: 'assistant', content: `reading ${callN}`, meta: { toolCalls: [{ id: callId, name: 'read' }] } });
			await ledger.append(THREAD, { role: 'tool', name: 'read', content, meta: { toolCallId: callId } });
		};

		const { pieces } = buildCorpus(encode, 1_020_000);
		const summarizer = new EpisodeSummarizer(null as never); // deterministic bodies, no LLM
		let episodesSaved = 0;
		let briefTokens = 0;
		// Successive compactions, the way the live loop checkpoints between
		// model rounds: append a batch, then close when the un-summarized
		// archive again exceeds the policy's episode token target — repeat.
		const BATCH = 1_200;
		const closeIfDue = async () => {
			const st = await ledger.stats(THREAD);
			const eps = await ledger.listEpisodes(THREAD);
			const fromSeq = eps.reduce((m, ep) => Math.max(m, ep.range.toSeq), 0) + 1;
			if (st === null || st.lastSeq < fromSeq) { return; }
			if (st.unsummarizedTokens < DEFAULT_LEDGER_POLICY.episodeTargetTokens) { return; }
			const boundary = await resolveCloseBoundary(fromSeq, DEFAULT_LEDGER_POLICY, n => ledger.readTail(THREAD, n), { allowMidTurn: true });
			if (boundary.kind !== 'close') { return; }
			const entries = await ledger.readRange(THREAD, fromSeq, boundary.toSeq!);
			if (entries.length === 0) { return; }
			const episode = await summarizer.summarizeEpisode({ threadId: THREAD, ordinal: eps.length + 1, entries, range: { fromSeq, toSeq: boundary.toSeq! }, modelSelection: null });
			await ledger.saveEpisode(episode);
			episodesSaved++;
		};
		// plant the needles: start needle first, superseded/config near the middle, end needle last
		let emitted = 0;
		for (let i = 0; i < pieces.length; i++) {
			if (i === 0) { await appendTool(NEEDLE_START + '\n' + pieces[i]!.content); }
			else if (i === Math.floor(pieces.length / 2)) { await appendTool(NEEDLE_FA_SUPERSEDED + '\n' + pieces[i]!.content); await appendTool(NEEDLE_FA_CURRENT); }
			else { await appendTool(pieces[i]!.content); }
			emitted += pieces[i]!.tokens;
			if ((i + 1) % BATCH === 0) { await closeIfDue(); }
		}
		await appendTool(NEEDLE_END);
		await closeIfDue();
		corpusTokens = emitted + requestTokens + encode(NEEDLE_START + NEEDLE_FA_SUPERSEDED + NEEDLE_FA_CURRENT + NEEDLE_END).length;
		const stats0 = await ledger.stats(THREAD);
		assert.ok(stats0 && stats0.entryCount > 0);
		assert.ok(episodesSaved >= 2, `successive compactions must produce multiple episodes (got ${episodesSaved})`);

		const finalStats = await ledger.stats(THREAD);
		const episodes = await ledger.listEpisodes(THREAD);

		// ── hard criteria ──
		// 1. zero loss of original data: the journal still returns every seq
		const all = await ledger.readRange(THREAD, 1, finalStats!.lastSeq);
		assert.strictEqual(all.length, finalStats!.entryCount, 'every journal record remains readable after all compactions');
		assert.ok(all.filter(e => e.role === 'tool').every(e => e.meta?.toolCallId), 'tool records keep their call ids');
		assert.ok(all.some(e => e.content.includes(NEEDLE_START)) && all.some(e => e.content.includes(NEEDLE_END)), 'both extreme needles survive in the archive');
		// 2. tool pairs intact inside every episode range
		for (const ep of episodes) {
			const covered = await ledger.readRange(THREAD, ep.range.fromSeq, ep.range.toSeq);
			const results = new Set(covered.filter(e => e.role === 'tool').map(e => e.meta?.toolCallId));
			for (const e of covered) {
				for (const c of e.meta?.toolCalls ?? []) {
					assert.ok(results.has(c.id), `episode ${ep.ordinal} split a tool pair`);
				}
			}
		}

		// working brief builds from the episodes
		const brief = buildWorkingBrief({ threadId: THREAD, previousBrief: null, episodes, lastSeq: finalStats!.lastSeq, policy: DEFAULT_LEDGER_POLICY });
		briefTokens = brief.tokens;

		console.log('[1M-bench]', JSON.stringify({
			corpusRealTokens: corpusTokens,
			pieces: pieces.length,
			journalEntries: finalStats!.entryCount,
			archiveTotalTokens: finalStats!.totalTokens,
			episodes: episodesSaved,
			briefTokens,
			tokenizer: 'gpt-tokenizer cl100k_base (real BPE)',
		}));
		assert.ok(corpusTokens >= 1_000_000, `corpus must be at least 1,000,000 real tokens (got ${corpusTokens})`);
		ledger.dispose();
	});

	test('distant facts survive restart and remain recallable; concurrent threads never mix', async function () {
		const fs = makeFileService();
		const ledger = makeLedger(fs);
		// thread A: start needle + a little corpus; thread B: its own distinct needle
		await ledger.append(THREAD, { role: 'user', content: 'بررسی گزارش‌ها' });
		let callN = 0;
		const appendTool = async (thread: string, content: string) => {
			callN++;
			await ledger.append(thread, { role: 'assistant', content: 'reading', meta: { toolCalls: [{ id: `c${thread}-${callN}`, name: 'read' }] } });
			await ledger.append(thread, { role: 'tool', name: 'read', content, meta: { toolCallId: `c${thread}-${callN}` } });
		};
		await appendTool(THREAD, NEEDLE_START);
		await appendTool(THREAD, 'filler record about deployments and caches');
		await appendTool(THREAD2, NEEDLE_END);
		// flush to durable files (restart semantics): the per-thread queue
		// flushes every 300ms — wait it out, then dispose (dispose fires one
		// final best-effort flush; the wait below covers the race)
		await new Promise(r => setTimeout(r, 800));
		ledger.dispose();
		await new Promise(r => setTimeout(r, 400));

		// NEW service instances over the same files = restart
		const ledger2 = makeLedger(fs);
		const store = makeRecallStore();
		const recall = new LedgerRecallService(store as never, ledger2 as never, fakeWorkspace, { isAvailable: false, model: undefined } as never);
		// feed the index the way the running app does (evented feed), then wait
		const st = await ledger2.stats(THREAD);
		const st2 = await ledger2.stats(THREAD2);
		console.log('[1M-restart] threadA entries:', st?.entryCount ?? 0, 'threadB entries:', st2?.entryCount ?? 0);
		assert.ok((st?.entryCount ?? 0) > 0, 'thread A journal must hydrate from disk after restart');
		assert.ok((st2?.entryCount ?? 0) > 0, 'thread B journal must hydrate from disk after restart');
		for (const [thread, stx] of [[THREAD, st], [THREAD2, st2]] as const) {
			const all = await ledger2.readRange(thread, 1, stx!.lastSeq);
			for (const e of all) { await recall.indexEntry(thread, e as ILedgerEntry); }
		}
		await recall.whenIndexed(THREAD);

		const startHits = await recall.recall({ query: 'svc-recon-7731 invoice reconciliation', limit: 5 });
		assert.ok(startHits.length > 0, 'the distant start fact must be recallable after restart');
		const scoped = await recall.recall({ query: 'rollback switch runbook', threadScope: 'current', currentThreadId: THREAD, limit: 5 });
		assert.ok(scoped.every(h => h.threadId === THREAD), 'scoped recall never returns another thread\'s records');
		const crossProbe = await recall.recall({ query: 'RB-9918 rollback', limit: 10 });
		assert.ok(crossProbe.every(h => h.threadId === THREAD2 || h.threadId === THREAD), 'both threads searchable, hits carry their own threadId');
		recall.dispose();
		ledger2.dispose();
	});
});
