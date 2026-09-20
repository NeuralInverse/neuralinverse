/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * SERVICE-LEVEL read-concurrency tests for ContextLedgerService.readTail
 * (phase-1 review R4). Array-only tests of selectTailNewestFirst do NOT
 * exercise the real bug: readTail reads durable segments ASYNCHRONOUSLY and
 * only then looks at the live pending array, so a flush that rotates the
 * journal mid-read used to lose the newest entry from BOTH inputs.
 *
 * The interleaving here is the review's controlled probe, replayed against
 * the real service: durable [1..10] + pending [11]; during the read of the
 * segment, the storage dependency commits 11 into a NEW segment and clears
 * the pending overlay. The repaired readTail snapshots pending BEFORE the
 * durable reads, so 11 must appear in the tail.
 */

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ContextLedgerService } from '../../browser/contextLedgerService.js';
import { registerInverseExecFn } from '../../../neuralInverseFirmware/browser/engine/utils/inverseFs.js';
import { ILedgerEntry } from '../../common/ledgerTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

// the chmod wrapper shells out — stub it so the test never touches a shell
registerInverseExecFn(async () => { /* no chmod in tests */ });

// ─── fake IFileService ────────────────────────────────────────────────────────

interface IFakeFileService {
	files: Map<string, string>;
	readCalls: string[];
	setReadHook(hook: ((uri: URI) => Promise<void>) | undefined): void;
	readFile(uri: URI): Promise<{ value: VSBuffer }>;
	writeFile(uri: URI, content: VSBuffer): Promise<void>;
	createFolder(uri: URI): Promise<void>;
	resolve(uri: URI): Promise<never>;
	del(uri: URI): Promise<void>;
}

function makeFileService(): IFakeFileService {
	const files = new Map<string, string>();
	const readCalls: string[] = [];
	let hook: ((uri: URI) => Promise<void>) | undefined;
	return {
		files,
		readCalls,
		setReadHook: h => { hook = h; },
		async readFile(uri: URI) {
			readCalls.push(uri.path);
			if (hook) { await hook(uri); }
			const text = files.get(uri.toString());
			if (text === undefined) { throw new Error(`File not found: ${uri.toString()}`); }
			return { value: VSBuffer.fromString(text) };
		},
		async writeFile(uri: URI, content: VSBuffer) { files.set(uri.toString(), content.toString()); },
		async createFolder(_uri: URI) { /* noop */ },
		async resolve(_uri: URI) { throw new Error('not found'); },
		async del(uri: URI) { files.delete(uri.toString()); },
	};
}

const WORKSPACE_URI = URI.file('Z:/ni-ledger-test');
const fakeWorkspace = {
	getWorkspace: () => ({ folders: [{ uri: WORKSPACE_URI }] }),
};

interface IInternalState {
	pending: ILedgerEntry[];
	fileCache: Map<number, ILedgerEntry[]>;
	currentFileNo: number;
	flushTimer: ReturnType<typeof setTimeout> | undefined;
	queue: unknown[];
}

function internalState(svc: ContextLedgerService, threadId: string): IInternalState {
	const states = (svc as unknown as { _states: Map<string, IInternalState> })._states;
	return states.get(threadId)!;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Append until the queue crosses FLUSH_BYTES, then wait for the flush. */
async function appendDurableSegment(svc: ContextLedgerService, threadId: string): Promise<void> {
	for (let i = 1; i <= 10; i++) {
		await svc.append(threadId, { role: 'user', content: `entry ${i}` });
	}
	// 70KB of content pushes queueBytes over the 64KB flush threshold
	await svc.append(threadId, { role: 'user', content: 'x'.repeat(70 * 1024) });
	const state = internalState(svc, threadId);
	for (let i = 0; i < 200 && state.pending.length > 0; i++) { await sleep(10); }
	assert.strictEqual(state.pending.length, 0, 'the flush must have committed the segment');
}

suite('ContextLedgerService.readTail — rotation interleaving (R4)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const threadId = 'readTail-race';

	test('an entry flushed (and rotated) DURING the segment read is not lost', async () => {
		const fake = makeFileService();
		// structural stand-ins: the service only calls the faked members
		const svc = new ContextLedgerService(
			fake as unknown as ConstructorParameters<typeof ContextLedgerService>[0],
			fakeWorkspace as unknown as ConstructorParameters<typeof ContextLedgerService>[1],
		);
		try {
			await appendDurableSegment(svc, threadId);
			// the segment holds seqs 1..11 (the 11th is the oversized entry that
			// forced the flush); the appended entry below is seq 12
			const entry12 = (await svc.append(threadId, { role: 'user', content: 'entry 12' }))!;
			const state = internalState(svc, threadId);
			assert.strictEqual(state.pending.length, 1);
			if (state.flushTimer !== undefined) { clearTimeout(state.flushTimer); state.flushTimer = undefined; }

			// force the cold read path: the segment cache is evicted
			state.fileCache.delete(1);

			let hooked = false;
			fake.setReadHook(async uri => {
				if (hooked || !uri.path.endsWith('000001.jsonl')) { return; }
				hooked = true;
				// the flush wins the race: seq 12 moves into a NEW segment and
				// the pending overlay is cleared, exactly as _doFlush would
				const journalDir = uri.with({ path: uri.path.slice(0, uri.path.lastIndexOf('/')) });
				fake.files.set(URI.joinPath(journalDir, '000002.jsonl').toString(), JSON.stringify(entry12) + '\n');
				state.fileCache.set(2, [entry12]);
				state.currentFileNo = 2;
				state.pending.length = 0;
				await sleep(0);
			});

			const tail = await svc.readTail(threadId, 20);
			assert.deepStrictEqual(
				tail.map(e => e.seq),
				[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
				'the entry rotated away mid-read must still appear in the tail',
			);
		} finally {
			fake.setReadHook(undefined);
			svc.dispose();
		}
	});

	test('a bounded tail does not walk the whole archive (maxEntries=1 reads only the newest segment)', async () => {
		const fake = makeFileService();
		// structural stand-ins: the service only calls the faked members
		const svc = new ContextLedgerService(
			fake as unknown as ConstructorParameters<typeof ContextLedgerService>[0],
			fakeWorkspace as unknown as ConstructorParameters<typeof ContextLedgerService>[1],
		);
		try {
			await appendDurableSegment(svc, threadId);
			const entry12 = (await svc.append(threadId, { role: 'user', content: 'entry 12' }))!;
			const state = internalState(svc, threadId);
			if (state.flushTimer !== undefined) { clearTimeout(state.flushTimer); state.flushTimer = undefined; }
			// both segments cold, newest cached from the "flush"
			state.fileCache.clear();
			state.fileCache.set(2, [entry12]);
			state.currentFileNo = 2;
			state.pending.length = 0;

			fake.readCalls.length = 0;
			const tail = await svc.readTail(threadId, 1);
			assert.deepStrictEqual(tail.map(e => e.seq), [12]);
			assert.ok(
				!fake.readCalls.some(p => p.endsWith('000001.jsonl')),
				'the newest-1 tail must not read the older segment',
			);
		} finally {
			svc.dispose();
		}
	});

	test('maxEntries <= 0 performs no I/O at all', async () => {
		const fake = makeFileService();
		// structural stand-ins: the service only calls the faked members
		const svc = new ContextLedgerService(
			fake as unknown as ConstructorParameters<typeof ContextLedgerService>[0],
			fakeWorkspace as unknown as ConstructorParameters<typeof ContextLedgerService>[1],
		);
		try {
			await appendDurableSegment(svc, threadId);
			const state = internalState(svc, threadId);
			state.fileCache.clear();
			fake.readCalls.length = 0;
			assert.deepStrictEqual(await svc.readTail(threadId, 0), []);
			assert.deepStrictEqual(await svc.readTail(threadId, -5), []);
			assert.strictEqual(fake.readCalls.length, 0, 'an empty tail request must not read any segment');
		} finally {
			svc.dispose();
		}
	});
});
