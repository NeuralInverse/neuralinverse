/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * SERVICE-LEVEL durability tests for the turn-coverage watermark (re-review
 * T4, follow-up U1/U2): the watermark over COMPLETED turns reaches meta.json
 * only from a flush that made the PROVING journal entry durable — an
 * in-flight OLDER batch must never publish a newer claim whose records are
 * still queued (a crash would then skip those turns forever). Pending claims
 * are invisible to getTurnCoverage until their flush commits.
 */

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { ContextLedgerService } from '../../browser/contextLedgerService.js';
import { registerInverseExecFn } from '../../../neuralInverseFirmware/browser/engine/utils/inverseFs.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

// the chmod wrapper shells out — stub it so the test never touches a shell
registerInverseExecFn(async () => { /* no chmod in tests */ });

interface IFakeFileService {
	files: Map<string, string>;
	setWriteHook(hook: ((uri: URI) => Promise<void>) | undefined): void;
	readFile(uri: URI): Promise<{ value: VSBuffer }>;
	writeFile(uri: URI, content: VSBuffer): Promise<void>;
	createFolder(uri: URI): Promise<void>;
	resolve(uri: URI): Promise<never>;
	del(uri: URI): Promise<void>;
}

function makeFileService(): IFakeFileService {
	const files = new Map<string, string>();
	let hook: ((uri: URI) => Promise<void>) | undefined;
	return {
		files,
		setWriteHook: h => { hook = h; },
		async readFile(uri: URI) {
			const text = files.get(uri.toString());
			if (text === undefined) { throw new Error(`File not found: ${uri.toString()}`); }
			return { value: VSBuffer.fromString(text) };
		},
		async writeFile(uri: URI, content: VSBuffer) {
			if (hook) { await hook(uri); }
			files.set(uri.toString(), content.toString());
		},
		async createFolder(_uri: URI) { /* noop */ },
		async resolve(_uri: URI) { throw new Error('not found'); },
		async del(uri: URI) { files.delete(uri.toString()); },
	};
}

const WORKSPACE_URI = URI.file('Z:/ni-ledger-coverage-test');
const fakeWorkspace = {
	getWorkspace: () => ({ folders: [{ uri: WORKSPACE_URI }] }),
};

interface ILedgerEntryLike {
	seq: number;
}

interface IInternalState {
	pending: ILedgerEntryLike[];
	queue: unknown[];
	flushTimer: ReturnType<typeof setTimeout> | undefined;
	flushInFlight: Promise<void> | undefined;
}

function internalState(svc: ContextLedgerService, threadId: string): IInternalState {
	const states = (svc as unknown as { _states: Map<string, IInternalState> })._states;
	return states.get(threadId)!;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function makeService(fake: IFakeFileService): ContextLedgerService {
	// structural stand-ins: the service only calls the faked members
	return new ContextLedgerService(
		fake as unknown as ConstructorParameters<typeof ContextLedgerService>[0],
		fakeWorkspace as unknown as ConstructorParameters<typeof ContextLedgerService>[1],
	);
}

function metaPath(threadId: string): string {
	return URI.joinPath(WORKSPACE_URI, '.inverse/ledger', threadId, 'meta.json').toString();
}

function readMeta(fake: IFakeFileService, threadId: string): { turnCoverage?: { through: number } } | undefined {
	const text = fake.files.get(metaPath(threadId));
	return text === undefined ? undefined : JSON.parse(text) as { turnCoverage?: { through: number } };
}

/** Journal the provider's exact coverage sequence for `through`. */
async function journalCoverageSequence(svc: ContextLedgerService, threadId: string, through: number): Promise<void> {
	const noted = await svc.append(threadId, { role: 'note', content: 'turn-coverage-v2', meta: { coveredThrough: through } });
	assert.ok(noted, 'the coverage note must enqueue');
	await svc.recordTurnCoverage(threadId, through);
}

/** Flush whatever is queued (byte threshold) and wait for it to commit. */
async function flushAndWait(svc: ContextLedgerService, threadId: string): Promise<void> {
	await svc.append(threadId, { role: 'user', content: 'x'.repeat(70 * 1024) });
	const state = internalState(svc, threadId);
	for (let i = 0; i < 200 && (state.pending.length > 0 || state.queue.length > 0 || state.flushInFlight !== undefined); i++) {
		await sleep(10);
		// flushInFlight resolves but stays set — poll until the queue is empty
		// and no timer is armed; the trailing append above is what forces it
		if (state.queue.length === 0 && state.pending.length === 0) { break; }
	}
	assert.strictEqual(state.queue.length, 0, 'the flush must have committed everything');
}

suite('ContextLedgerService — turn-coverage watermark (T4/U2)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const threadId = 'coverage-watermark';

	test('U2: an in-flight OLDER batch never publishes a NEWER queued watermark', async () => {
		const fake = makeFileService();
		const svc = makeService(fake);
		try {
			// start an older, unrelated flush and PAUSE its journal write —
			// while it is in flight, the provider's coverage sequence queues
			const gate = (() => {
				let release: () => void = () => { };
				const opened = new Promise<void>(r => { release = r; });
				let paused = false;
				return {
					opened: () => opened,
					release: () => release(),
					pauseOnce: () => {
						if (paused) { return Promise.resolve(); }
						paused = true;
						return opened;
					},
				};
			})();
			fake.setWriteHook(async uri => {
				if (uri.path.endsWith('.jsonl')) { await gate.pauseOnce(); }
			});

			await svc.append(threadId, { role: 'user', content: 'older unrelated record' });
			// 70KB crosses the byte threshold → _doFlush starts → journal write paused
			await svc.append(threadId, { role: 'user', content: 'o'.repeat(70 * 1024) });
			await sleep(20); // let the flush reach the paused journal write

			// the newer batch: the proving records queue BEHIND the older flush
			await svc.append(threadId, { role: 'user', content: 'q0', meta: { turn: 0 } });
			await svc.append(threadId, { role: 'assistant', content: 'a0', meta: { turn: 0 } });
			await journalCoverageSequence(svc, threadId, 0);

			// kill the queued batch's own timer so ONLY the older flush runs
			const state = internalState(svc, threadId);
			if (state.flushTimer !== undefined) { clearTimeout(state.flushTimer); state.flushTimer = undefined; }

			// release the older flush and let it finish (journal + meta)
			gate.release();
			for (let i = 0; i < 200 && readMeta(fake, threadId) === undefined; i++) { await sleep(10); }
			fake.setWriteHook(undefined);

			// the disk snapshot at the boundary (U2's probe): the older batch
			// committed, but its meta must NOT carry the queued watermark
			const meta = readMeta(fake, threadId);
			assert.ok(meta, 'the older flush wrote its meta');
			assert.strictEqual(meta!.turnCoverage, undefined,
				'an in-flight older batch must never publish a newer, still-queued watermark');

			// restart on the same bytes: the crash boundary — the queued
			// records are lost, and the durable claim must not exist to skip
			// them, so migration can repair from session history
			const restarted = makeService(fake);
			try {
				assert.strictEqual(await restarted.getTurnCoverage(threadId), undefined,
					'the claim must not survive on disk without its records');
				const tail = await restarted.readTail(threadId, 50);
				assert.ok(!tail.some(e => e.content === 'q0'), 'fixture sanity: the queued q0 was lost at the boundary');
			} finally {
				restarted.dispose();
			}

			// recovery: after writes recover, the same coverage sequence
			// flushes and the watermark becomes durable WITH its records
			await journalCoverageSequence(svc, threadId, 0);
			await flushAndWait(svc, threadId);
			assert.strictEqual(readMeta(fake, threadId)?.turnCoverage?.through, 0,
				'the retried sequence publishes the watermark together with its records');
		} finally {
			svc.dispose();
		}
	});

	test('the recorded watermark publishes with its proving flush and survives a restart', async () => {
		const fake = makeFileService();
		const svc = makeService(fake);
		try {
			assert.strictEqual(await svc.getTurnCoverage(threadId), undefined, 'a fresh thread has no watermark');

			// pending state is readable-but-not-durable: before the flush the
			// durable lookup must stay undefined (U2's distinction)
			await journalCoverageSequence(svc, threadId, 3);
			assert.strictEqual(await svc.getTurnCoverage(threadId), undefined,
				'a queued claim is not durable coverage yet');

			await flushAndWait(svc, threadId);
			assert.strictEqual(readMeta(fake, threadId)?.turnCoverage?.through, 3,
				'the watermark rides the same meta write as its proving note');

			const restarted = makeService(fake);
			try {
				assert.strictEqual(await restarted.getTurnCoverage(threadId), 3, 'the watermark is durable across a restart');
			} finally {
				restarted.dispose();
			}
		} finally {
			svc.dispose();
		}
	});

	test('the watermark is monotonic — a stale value can never lower it', async () => {
		const fake = makeFileService();
		const svc = makeService(fake);
		try {
			await svc.append(threadId, { role: 'user', content: 'turn 0', meta: { turn: 0 } });
			await journalCoverageSequence(svc, threadId, 5);
			await journalCoverageSequence(svc, threadId, 2);
			await flushAndWait(svc, threadId);
			assert.strictEqual(await svc.getTurnCoverage(threadId), 5, 'recording an older coverage must not regress the watermark');
			assert.strictEqual(await svc.getTurnCoverage('unknown-thread'), undefined);
		} finally {
			svc.dispose();
		}
	});
});
