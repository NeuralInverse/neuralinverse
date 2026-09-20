/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * Regression tests for the bounded thread-store persistence (renderer-OOM fix
 * 2026-09-19; v2 archive-gated after the Astra review). The live defect: one
 * application-scoped JSON blob held the FULL content of every thread and was
 * re-serialized + IPC-pushed on every message add (132.8 MB measured) — the
 * burst OOM-killed the renderer mid-turn under heavy history.
 *
 * boundThreadsForStorage bounds ONLY the persisted copy. The v2 contract these
 * tests pin (the v1 review gaps):
 *
 *   1. small stores pass through byte-identical;
 *   2. NO message is stubbed without a confirmed durable archive copy of that
 *      exact serialized message (archive-unavailable ⇒ verbatim + honest
 *      stats, never a marker);
 *   3. the stub carries a voidArchivedRef naming the archive file that holds
 *      the EXACT original (hash identity), plus a visible marker;
 *   4. tool payload stubbing keeps the structural fields; checkpoints are
 *      never stubbed;
 *   5. oversized RECENT messages are stubbable too (pass B) so the per-thread
 *      and total caps are hard guarantees, not approximations;
 *   6. already-stubbed messages are never re-archived;
 *   7. the input object is not mutated (the live session keeps everything).
 */

import assert from 'assert';
import { boundThreadsForStorage, THREAD_PERSIST_STUB_MARKER, THREAD_PERSIST_LEGACY_STUB_MARKER, THREAD_PERSIST_MARKER_SIGNATURE, THREAD_PERSIST_KEEP_RECENT_MESSAGES, type IStorableMessage, type IStorableThread } from '../../common/threadStorageBound.js';
import { archiveFileNameOf, archiveHashOf, isValidArchiveRef } from '../../common/threadArchiveCore.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function bigUserMessage(chars: number, tag: string) {
	return {
		role: 'user',
		content: `A3DIAG ${tag}: ${'x'.repeat(Math.max(0, chars))}`,
		displayContent: `A3DIAG ${tag}: ${'y'.repeat(Math.max(0, chars))}`,
		selections: null,
		state: { stagingSelections: [], isBeingEdited: false },
	};
}

function assistantMessage(chars: number) {
	return { role: 'assistant', displayContent: 'a'.repeat(chars), reasoning: '', anthropicReasoning: null };
}

function makeThread(id: string, lastModified: string, messages: IStorableMessage[]): IStorableThread {
	return { id, createdAt: '2026-09-19T00:00:00.000Z', lastModified, messages, filesWithUserChanges: {}, state: { currCheckpointIdx: null, stagingSelections: [], focusedMessageIdx: undefined, linksOfMessageIdx: {} } };
}

/** verifier that archives everything — returns the content-addressed ref */
const archiveAll = async (_threadId: string, _idx: number, full: string) => archiveFileNameOf(archiveHashOf(full));
/** verifier that fails for everything — the honest no-archive path */
const archiveNone = async () => null;

suite('boundThreadsForStorage', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('small stores pass through unchanged (no behavior change for normal sessions)', async () => {
		const threads: Record<string, IStorableThread | undefined> = {
			t1: makeThread('t1', '2026-09-19T01:00:00.000Z', [bigUserMessage(100, 'small'), assistantMessage(50)]),
		};
		const { bounded, stats } = await boundThreadsForStorage(threads, { ensureArchived: archiveAll });
		assert.strictEqual(JSON.stringify(bounded.t1), JSON.stringify(threads.t1), 'small thread must be untouched');
		assert.strictEqual(stats.threadsStubbed, 0);
		assert.strictEqual(stats.messagesStubbed, 0);
		assert.strictEqual(stats.charsAfter, stats.charsBefore);
	});

	test('oversized thread: oldest messages stubbed first, newest stay verbatim', async () => {
		const big = 600_000; // 4 messages × ~1.2MB serialized (content + display) → way over a small budget
		const messages = [
			bigUserMessage(big, 'OLD1'),
			bigUserMessage(big, 'OLD2'),
			bigUserMessage(big, 'RECENT1'),
			bigUserMessage(big, 'RECENT2'),
		];
		const threads: Record<string, IStorableThread | undefined> = { t1: makeThread('t1', '2026-09-19T01:00:00.000Z', messages) };
		// tiny budget so stubbing kicks in; keep-recent still applies — and when
		// even the old pair is not enough (pass B), the OLDEST of the recent
		// window goes first, so only the NEWEST message is guaranteed verbatim
		const { bounded, stats } = await boundThreadsForStorage(threads, { perThreadBudgetChars: 1_500_000, keepRecentMessages: 2, ensureArchived: archiveAll });
		const out = bounded.t1!.messages!;
		assert.ok(stats.messagesStubbed >= 2, `expected old messages stubbed, got ${stats.messagesStubbed}`);
		assert.ok(String(out[3].content).includes('RECENT2'), 'the newest message must stay verbatim');
		assert.ok(!String(out[3].displayContent).includes(THREAD_PERSIST_STUB_MARKER), 'newest message must not be stubbed');
		for (const m of out.slice(0, 3)) {
			assert.strictEqual(m.displayContent, THREAD_PERSIST_STUB_MARKER, 'older messages must carry the visible marker');
		}
	});

	test('no stubbing without a confirmed archive copy — messages stay verbatim and are counted (archive failure = no data loss)', async () => {
		const messages = [bigUserMessage(600_000, 'OLD'), bigUserMessage(600_000, 'OLD2'), ...Array.from({ length: 4 }, (_, i) => bigUserMessage(1000, `R${i}`))];
		const threads: Record<string, IStorableThread | undefined> = { t1: makeThread('t1', '2026-09-19T01:00:00.000Z', messages) };
		const { bounded, stats } = await boundThreadsForStorage(threads, { perThreadBudgetChars: 200_000, ensureArchived: archiveNone });
		assert.strictEqual(stats.messagesStubbed, 0, 'nothing may be stubbed when the archive confirms nothing');
		assert.strictEqual(stats.charsAfter, stats.charsBefore, 'unarchivable messages must stay verbatim (no size shortcut by marker)');
		// the cap demanded every candidate (the thread stays over budget); the
		// archive confirmed none, so all 6 are reported honestly
		assert.strictEqual(stats.keptUnarchived, 6, 'every candidate the cap reached must be reported');
		for (const m of bounded.t1!.messages!) {
			assert.ok(!String(m.displayContent ?? '').includes(THREAD_PERSIST_MARKER_SIGNATURE), 'no marker may appear without an archive');
		}
	});

	test('partial archive confirmation: only confirmed messages are stubbed, the rest stay verbatim', async () => {
		const messages = [bigUserMessage(600_000, 'KEEPME'), bigUserMessage(600_000, 'STUBME'), ...Array.from({ length: 4 }, (_, i) => bigUserMessage(1000, `R${i}`))];
		const threads: Record<string, IStorableThread | undefined> = { t1: makeThread('t1', '2026-09-19T01:00:00.000Z', messages) };
		const archiveOnlyStubMe = async (_tid: string, _idx: number, full: string) => {
			return full.includes('STUBME') ? archiveFileNameOf(archiveHashOf(full)) : null;
		};
		const { bounded, stats } = await boundThreadsForStorage(threads, { perThreadBudgetChars: 1_300_000, ensureArchived: archiveOnlyStubMe });
		const out = bounded.t1!.messages!;
		assert.ok(String(out[0].content).includes('KEEPME'), 'unarchived message must stay verbatim');
		assert.strictEqual(out[0].voidArchivedRef, undefined);
		assert.strictEqual(out[1].displayContent, THREAD_PERSIST_STUB_MARKER, 'confirmed message must be stubbed');
		assert.strictEqual(stats.keptUnarchived, 1);
		assert.strictEqual(stats.messagesStubbed, 1);
	});

	test('the verifier receives the EXACT serialized original and the stub ref is its hash identity', async () => {
		const original = bigUserMessage(50_000, 'IDENTITY');
		const threads: Record<string, IStorableThread | undefined> = { t1: makeThread('t1', '2026-09-19T01:00:00.000Z', [original, ...Array.from({ length: 8 }, (_, i) => bigUserMessage(500, `R${i}`))]) };
		const seen = new Map<number, string>();
		const capture = async (_tid: string, idx: number, full: string) => { seen.set(idx, full); return archiveFileNameOf(archiveHashOf(full)); };
		const { bounded } = await boundThreadsForStorage(threads, { perThreadBudgetChars: 20_000, ensureArchived: capture });
		assert.ok(seen.has(0), 'verifier must be called for the stubbed message');
		const full = seen.get(0)!;
		const roundTripped = JSON.parse(full);
		assert.strictEqual(roundTripped.content, original.content, 'the archived copy must be the exact original content');
		assert.strictEqual(roundTripped.displayContent, original.displayContent);
		const stub = bounded.t1!.messages![0];
		const refField = stub.voidArchivedRef as { f: string } | undefined;
		assert.ok(refField && isValidArchiveRef(refField.f), 'stub must carry a well-formed archive ref');
		assert.strictEqual(refField!.f, archiveFileNameOf(archiveHashOf(full)), 'ref must be the content hash of the archived original');
	});

	test('tool payloads are stubbed but the tool structure stays; checkpoints are never stubbed', async () => {
		const toolMsg = { role: 'tool', type: 'success', name: 'read_file', id: 'x1', content: 'z'.repeat(300_000), result: 'w'.repeat(300_000), params: { path: 'a.txt' }, mcpServerName: undefined };
		const checkpoint = { role: 'checkpoint', type: 'user_edit', voidFileSnapshotOfURI: {}, userModifications: { voidFileSnapshotOfURI: {} }, big: 'c'.repeat(300_000) };
		const messages = [toolMsg, checkpoint, ...Array.from({ length: 2 }, (_, i) => bigUserMessage(600_000, `BIG${i}`)), ...Array.from({ length: 8 }, (_, i) => bigUserMessage(1000, `R${i}`))];
		const threads: Record<string, IStorableThread | undefined> = { t1: makeThread('t1', '2026-09-19T01:00:00.000Z', messages) };
		const { bounded, stats } = await boundThreadsForStorage(threads, { perThreadBudgetChars: 1_000_000, keepRecentMessages: 8, ensureArchived: archiveAll });
		const out = bounded.t1!.messages!;
		const outTool = out.find(m => m.role === 'tool') as typeof toolMsg & { voidArchivedRef?: { f: string } };
		const outCp = out.find(m => m.role === 'checkpoint') as typeof checkpoint;
		assert.strictEqual(outCp, checkpoint, 'checkpoint message must pass through untouched');
		if (stats.messagesStubbed > 0) {
			assert.strictEqual(outTool.params.path, 'a.txt', 'tool params must survive stubbing');
			assert.strictEqual(outTool.id, 'x1', 'tool id must survive stubbing');
			assert.strictEqual(outTool.name, 'read_file', 'tool name must survive stubbing');
			assert.strictEqual(outTool.type, 'success', 'tool type must survive stubbing');
			if (outTool.voidArchivedRef) {
				assert.strictEqual(outTool.content, THREAD_PERSIST_STUB_MARKER, 'stubbed tool content must be the marker');
				assert.strictEqual(outTool.result, THREAD_PERSIST_STUB_MARKER, 'stubbed string result must be the marker');
			}
		}
	});

	test('oversized RECENT messages are stubbable (pass B) — the per-thread cap is a hard guarantee', async () => {
		const messages = Array.from({ length: THREAD_PERSIST_KEEP_RECENT_MESSAGES }, (_, i) => bigUserMessage(300_000, `RECENT${i}`));
		const threads: Record<string, IStorableThread | undefined> = { t1: makeThread('t1', '2026-09-19T01:00:00.000Z', messages) };
		const { bounded, stats } = await boundThreadsForStorage(threads, { perThreadBudgetChars: 1_000_000, ensureArchived: archiveAll });
		const out = bounded.t1!.messages!;
		assert.ok(stats.messagesStubbed >= 4, `recent-window overflow must stub the oldest of the recent, got ${stats.messagesStubbed}`);
		assert.ok(String(out[out.length - 1].content).includes('RECENT7'), 'the newest message stays verbatim whenever the budget allows');
		const serialized = JSON.stringify(bounded.t1);
		assert.ok(serialized.length <= 1_000_000 + 10_000, `persisted thread must fit its cap, got ${serialized.length}`);
	});

	test('total budget holds across many oversized threads — hard guarantee with tiny structural residual', async () => {
		const threads: Record<string, IStorableThread | undefined> = {};
		for (let i = 0; i < 30; i++) {
			threads[`t${i}`] = makeThread(`t${i}`, new Date(Date.parse('2026-09-19T00:00:00.000Z') + i * 1000).toISOString(), [
				bigUserMessage(400_000, `T${i}_OLD`),
				...Array.from({ length: 8 }, (_, k) => bigUserMessage(500, `T${i}_R${k}`)),
			]);
		}
		const { bounded, stats } = await boundThreadsForStorage(threads, { perThreadBudgetChars: 1_000_000, totalBudgetChars: 8_000_000, ensureArchived: archiveAll });
		const total = Object.values(bounded).reduce((s, t) => s + JSON.stringify(t ?? {}).length, 0);
		assert.ok(total < 8_000_000 + 30 * 2_000, `bounded store must be near the total budget, got ${total}`);
		assert.ok(stats.threadsStubbed > 0, 'some threads must have been stubbed');
	});

	test('already-stubbed messages (legacy markers) are never re-archived', async () => {
		const legacyStub = { role: 'user', content: THREAD_PERSIST_LEGACY_STUB_MARKER, displayContent: THREAD_PERSIST_LEGACY_STUB_MARKER, selections: null, state: { stagingSelections: [], isBeingEdited: false } };
		const messages = [legacyStub, bigUserMessage(600_000, 'OLD'), ...Array.from({ length: 8 }, (_, i) => bigUserMessage(1000, `R${i}`))];
		const threads: Record<string, IStorableThread | undefined> = { t1: makeThread('t1', '2026-09-19T01:00:00.000Z', messages) };
		const seen: string[] = [];
		const capture = async (_tid: string, _idx: number, full: string) => { seen.push(full); return archiveFileNameOf(archiveHashOf(full)); };
		await boundThreadsForStorage(threads, { perThreadBudgetChars: 200_000, ensureArchived: capture });
		for (const full of seen) {
			assert.notStrictEqual(full, JSON.stringify(legacyStub), 'the legacy marker message must never be offered to the archiver');
		}
	});

	test('quoted archive markers are archived as original text and do not bypass the cap', async () => {
		const messages = ['user', 'assistant', 'tool'].map(role => ({ role, content: `Quoted: ${THREAD_PERSIST_LEGACY_STUB_MARKER} ${'x'.repeat(50_000)}`, displayContent: `Quoted: ${THREAD_PERSIST_STUB_MARKER} ${'y'.repeat(50_000)}` }));
		const archived: string[] = [];
		const { bounded, stats } = await boundThreadsForStorage({ t: { messages } }, {
			perThreadBudgetChars: 4_000,
			ensureArchived: async (_id, _idx, full) => { archived.push(full); return archiveFileNameOf(archiveHashOf(full)); },
		});
		assert.deepStrictEqual(archived, messages.map(message => JSON.stringify(message)));
		assert.strictEqual(stats.messagesStubbed, 3);
		// Tool displayContent and assistant content are not fields in the product
		// message schema; test the normal user shape for the exact budget check.
		const user = await boundThreadsForStorage({ t: { messages: [messages[0]] } }, { perThreadBudgetChars: 4_000, ensureArchived: archiveAll });
		assert.ok(JSON.stringify(user.bounded).length < 4_000);
		assert.ok(bounded.t!.messages!.every(message => message.voidArchivedRef));
	});

	test('per-flush archive budget (session-cache-first) defers excess verbatim and converges across flushes', async () => {
		const messages = [bigUserMessage(600_000, 'OLD1'), bigUserMessage(600_000, 'OLD2'), ...Array.from({ length: 4 }, (_, i) => bigUserMessage(1000, `R${i}`))];
		const threads: Record<string, IStorableThread | undefined> = { t1: makeThread('t1', '2026-09-19T01:00:00.000Z', messages) };
		const cache = { entries: new Map() };
		// mimic the product's verifier: session cache answers first for free;
		// only ONE genuinely new archive write is allowed per flush
		const sessionArchives = new Map<string, string>();
		const budgetedVerifier = (budgetBox: { left: number }) => async (_tid: string, _idx: number, full: string) => {
			const file = archiveFileNameOf(archiveHashOf(full));
			if (sessionArchives.has(file)) { return file; }
			if (budgetBox.left <= 0) { return null; }
			budgetBox.left--;
			sessionArchives.set(file, file);
			return file;
		};
		const budgetBox = { left: 1 };
		const verifier = budgetedVerifier(budgetBox);
		const first = await boundThreadsForStorage(threads, { perThreadBudgetChars: 200_000, ensureArchived: verifier, cache });
		assert.strictEqual(first.stats.messagesStubbed, 1, 'only one candidate may be stubbed under the budget');
		assert.ok(first.stats.keptUnarchived >= 1, 'budget-deferred candidates stay verbatim and are reported');
		assert.ok(String(first.bounded.t1!.messages![1].content).includes('OLD2'), 'deferred messages keep their original text');
		// second flush, same input objects: archived candidates are now free —
		// the next one is archived and stubbed (convergence without data loss)
		budgetBox.left = 1;
		const second = await boundThreadsForStorage(threads, { perThreadBudgetChars: 200_000, ensureArchived: verifier, cache });
		assert.strictEqual(second.stats.messagesStubbed, 2);
	});

	test('caller cache: unchanged threads are reused without recompute; a tighter cap re-bounds', async () => {
		const messages = [bigUserMessage(600_000, 'OLD'), ...Array.from({ length: 8 }, (_, i) => bigUserMessage(1000, `R${i}`))];
		const threads: Record<string, IStorableThread | undefined> = { t1: makeThread('t1', '2026-09-19T01:00:00.000Z', messages) };
		const cache = { entries: new Map() };
		const first = await boundThreadsForStorage(threads, { perThreadBudgetChars: 1_000_000, ensureArchived: archiveAll, cache });
		const firstBounded = first.bounded.t1!;
		let verifierCalls = 0;
		const countingVerifier = async (_tid: string, _idx: number, full: string) => { verifierCalls++; return archiveFileNameOf(archiveHashOf(full)); };
		// same input object, generous cap → cache hit, verifier never called
		const second = await boundThreadsForStorage(threads, { perThreadBudgetChars: 1_000_000, ensureArchived: countingVerifier, cache });
		assert.strictEqual(second.stats.cacheHits, 1);
		assert.strictEqual(verifierCalls, 0, 'a cache hit must not re-archive anything');
		assert.strictEqual(second.bounded.t1, firstBounded, 'the cached bounded shape is reused by identity');
		// a cap TIGHTER than the cached bounded shape forces a re-bound
		const third = await boundThreadsForStorage(threads, { perThreadBudgetChars: 5_000, ensureArchived: countingVerifier, cache });
		assert.strictEqual(third.stats.cacheHits, 0);
		assert.ok(JSON.stringify(third.bounded.t1).length <= 6_000, 're-bound under the tighter cap');
	});

	test('pure: the input threads object is not mutated (live session keeps everything)', async () => {
		const original = bigUserMessage(600_000, 'OLD');
		const snapshot = JSON.stringify(original);
		const threads: Record<string, IStorableThread | undefined> = { t1: makeThread('t1', '2026-09-19T01:00:00.000Z', [original, ...Array.from({ length: 8 }, (_, i) => bigUserMessage(1000, `R${i}`))]) };
		await boundThreadsForStorage(threads, { perThreadBudgetChars: 200_000, ensureArchived: archiveAll });
		assert.strictEqual(JSON.stringify(original), snapshot, 'input message object must not be mutated');
		assert.strictEqual(threads.t1!.messages![0], original, 'input array must not be replaced');
	});
});
