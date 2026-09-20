/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bounded persistence for the UI thread store (renderer-OOM fix, 2026-09-19;
 * v2 archive-gated after the Astra review of the v1 fix).
 *
 * `void.chatThreadStorageII` is ONE application-scoped JSON blob holding the
 * message content of every thread across every workspace. It used to be
 * re-serialized and pushed through IPC on EVERY message add. Measured on the
 * review installation: 132.8 MB of JSON / 162 threads / 5562 messages —
 * parsed once at startup (~1.5 GB of renderer heap) and stringified several
 * times per chat turn. Under A3-style heavy history that burst killed the
 * renderer (`renderer process gone (reason: oom, code: -536870904)`).
 *
 * ## v2 contract (Astra review closure)
 *
 * A message's persisted copy may be replaced by a visible marker ONLY when a
 * full, verbatim copy of THAT message is first confirmed durable in the
 * application-scoped thread archive (`<userDataDir>/threadHistoryArchive/`,
 * see threadArchiveService.ts). The confirmation is per-thread and
 * per-message: `ensureArchived(threadId, index, fullSerialized)` must return
 * an archive ref for the EXACT serialized content, and the stub carries that
 * ref (`voidArchivedRef`) so the marker is never shown for data whose archive
 * does not exist. If archiving fails (disk error, no user-data dir, ...), the
 * original text stays verbatim in the store and `stats.keptUnarchived`
 * reports it honestly — nothing is silently replaced by a marker.
 *
 *   - per-thread serialized-size budget, then a total budget; oldest messages
 *     stub first; the newest `keepRecentMessages` are exempt ONLY while the
 *     thread still fits its cap — oversized recent messages are stubbed too
 *     (pass B). These are target budgets: unavailable archives and exempt
 *     structural messages can leave the persisted store above its target;
 *   - tool messages: only the big payloads (`content` and string `result`)
 *     are replaced; id/name/params/type stay structural;
 *   - checkpoint / interrupted-streaming messages are never stubbed (measured
 *     at 1.7 MB of a 98 MB store — a documented, bounded residual);
 *   - already-stubbed messages (marker present) are never re-stubbed;
 *   - the input is never mutated (pure); the live session keeps its full
 *     history and rehydration restores archived text when a thread is opened.
 *
 * The context-ledger journal (`.inverse/ledger/<threadId>/`, per-workspace)
 * remains the recall/compaction ground truth for conversational content; the
 * thread archive is the durability backstop that makes every persisted stub
 * recoverable — including threads whose workspace journal is not reachable
 * from this window (old threads, other workspaces).
 */

/** Coalescing window for thread-store writes (see _storeAllThreads). */
export const THREAD_PERSIST_DEBOUNCE_MS = 750;

/** Serialized-size budget for ONE thread's persisted JSON. */
export const THREAD_PERSIST_PER_THREAD_BUDGET_CHARS = 4_000_000;

/** Serialized-size budget for the whole persisted store. */
export const THREAD_PERSIST_TOTAL_BUDGET_CHARS = 48_000_000;

/**
 * The newest N messages of a thread stay verbatim while the thread fits its
 * cap. Over cap, the OLDEST of that recent window is stubbed first (pass B):
 * recency is a preference, never a floor that can break the budget.
 */
export const THREAD_PERSIST_KEEP_RECENT_MESSAGES = 8;

/**
 * Signature every persisted stub carries in its visible text (v1 and v2
 * markers share this prefix) — used to detect markers without relying on the
 * `voidArchivedRef` field, and by rehydration to find restore candidates.
 */
export const THREAD_PERSIST_MARKER_SIGNATURE = 'This older message is archived';

/** Visible marker written in place of a stubbed message's content (v2). */
export const THREAD_PERSIST_STUB_MARKER =
	'· ' + THREAD_PERSIST_MARKER_SIGNATURE + ' on disk by Neural Inverse — its full text is preserved and reappears when this thread is reopened. The in-IDE copy was trimmed to keep the app responsive.';

/** Exact marker emitted by the first persistence format. */
export const THREAD_PERSIST_LEGACY_STUB_MARKER =
	'· This older message is archived in the durable context ledger (.inverse/ledger). Its full text stays on disk; the in-IDE copy was trimmed to keep Neural Inverse responsive.';

/** Roles whose persisted content must never be replaced by the marker. */
const NEVER_STUB_ROLES: ReadonlySet<string> = new Set(['checkpoint', 'interrupted_streaming_tool', 'system']);

export interface IThreadPersistStats {
	threadsTotal: number;
	threadsStubbed: number;
	messagesStubbed: number;
	/** candidates kept verbatim because their archive was not confirmed this flush (unavailable or IO-budget deferred) */
	keptUnarchived: number;
	/** threads served from the caller's bounding cache (no recompute) */
	cacheHits: number;
	charsBefore: number;
	charsAfter: number;
}

/** Minimal structural shapes — keeps this module import-light and pure. */
export interface IStorableMessage {
	role: string;
	[key: string]: unknown;
}

export interface IStorableThread {
	lastModified?: string;
	messages?: IStorableMessage[];
	[key: string]: unknown;
}

export interface IBoundThreadsResult {
	bounded: { [id: string]: IStorableThread | undefined };
	stats: IThreadPersistStats;
}

/**
 * Per-thread bounding memo OWNED BY THE CALLER (the flush path). Keyed by
 * input object identity — a thread whose object did not change since the
 * last flush is reused verbatim (no re-stringify, no re-bounding, no
 * archive IO), so a steady-state store write costs O(dirty thread), not
 * O(whole history). Cached entries are only reused when the cached result
 * still satisfies the current cap; a tighter cap re-bounds from the cached
 * INPUT.
 */
export interface IBoundThreadCacheEntry {
	inputRef: IStorableThread;
	/** the bounded persisted shape last produced for inputRef */
	bounded: IStorableThread;
	/** serialized size of `bounded` */
	boundedLen: number;
	/** serialized size of the full inputRef (pre-bounding) */
	fullLen: number;
}
export interface IBoundCache { entries: Map<string, IBoundThreadCacheEntry> }

/**
 * Per-message archive confirmation. Given the thread id, the message's index
 * and its EXACT full serialized content, returns the archive ref to store on
 * the stub, or null when no durable copy could be confirmed (the message
 * then stays verbatim). Implementations must only return a ref for a copy
 * that survives an application restart.
 */
export type EnsureArchived = (threadId: string, messageIndex: number, fullSerialized: string) => Promise<string | null>;

/**
 * Maximum NEW archive confirmations/writes performed in ONE bounding pass.
 * Enforced by the caller's verifier wrapper (threadArchiveService's session
 * cache answers first for already-archived messages, so repeat flushes
 * converge); anything beyond the budget stays verbatim this flush and is
 * archived by a later one — bounding every flush stays bounded no matter
 * how much backlog exists.
 */
export const THREAD_PERSIST_MAX_NEW_ARCHIVES_PER_FLUSH = 32;

export interface IBoundOptions {
	perThreadBudgetChars?: number;
	totalBudgetChars?: number;
	keepRecentMessages?: number;
	ensureArchived?: EnsureArchived;
	cache?: IBoundCache;
}

/** A message whose persisted copy is already an archive marker. */
export function messageIsStubbed(m: IStorableMessage | undefined | null): boolean {
	if (!m) { return false; }
	if (m.voidArchivedRef) { return true; }
	const disp = typeof m.displayContent === 'string' ? m.displayContent : '';
	const content = typeof m.content === 'string' ? m.content : '';
	const isMarker = (text: string) => text === THREAD_PERSIST_STUB_MARKER || text === THREAD_PERSIST_LEGACY_STUB_MARKER;
	return isMarker(disp) || isMarker(content);
}

function messageIsStubCandidate(m: IStorableMessage): boolean {
	if (NEVER_STUB_ROLES.has(String(m.role))) { return false; }
	if (messageIsStubbed(m)) { return false; }
	return true;
}

/** Archive ref stored on a stub so the marker points at a real file. */
interface IArchivedRefField { f: string }

function makeStub(m: IStorableMessage, archiveRef: string): IStorableMessage {
	const refField: IArchivedRefField = { f: archiveRef };
	if (m.role === 'tool') {
		// keep the tool structure (id/name/params/type) — replace only payloads
		const stub: IStorableMessage = { ...m, content: THREAD_PERSIST_STUB_MARKER, voidArchivedRef: refField };
		if (typeof stub.result === 'string') { stub.result = THREAD_PERSIST_STUB_MARKER; }
		return stub;
	}
	if (m.role === 'assistant') {
		return { ...m, displayContent: THREAD_PERSIST_STUB_MARKER, reasoning: '', anthropicReasoning: null, voidArchivedRef: refField };
	}
	// user messages: the marker stays visible in the bubble and reads honestly
	// if it ever reaches the model after a reload
	return { ...m, content: THREAD_PERSIST_STUB_MARKER, displayContent: THREAD_PERSIST_STUB_MARKER, selections: null, voidArchivedRef: refField };
}

/**
 * Bound the threads object that is about to be persisted. Pure with respect
 * to the INPUT (never mutated) and ASYNC: every stub is gated on
 * `ensureArchived` confirming a durable full copy of that exact message
 * first. Without a verifier nothing is ever stubbed.
 *
 * Cost control (Astra gap 2): with a caller-owned `cache`, an unchanged
 * thread is reused without any re-serialization; new archive confirmations
 * are capped per flush (`maxNewArchives`, the rest are DEFERRED to later
 * flushes) and the loop yields to the event loop between threads that did
 * verification work — so no single flush can starve the renderer, no matter
 * how much bounding backlog exists.
 */
export async function boundThreadsForStorage(
	threads: { [id: string]: IStorableThread | undefined },
	opts?: IBoundOptions,
): Promise<IBoundThreadsResult> {
	const perThreadBudget = opts?.perThreadBudgetChars ?? THREAD_PERSIST_PER_THREAD_BUDGET_CHARS;
	const totalBudget = opts?.totalBudgetChars ?? THREAD_PERSIST_TOTAL_BUDGET_CHARS;
	const keepRecent = Math.max(0, opts?.keepRecentMessages ?? THREAD_PERSIST_KEEP_RECENT_MESSAGES);
	const ensureArchived = opts?.ensureArchived;
	const cache = opts?.cache;

	const ids = Object.keys(threads).filter(id => threads[id]);
	// newest threads first — recency wins the budget
	ids.sort((a, b) => String(threads[b]?.lastModified ?? '').localeCompare(String(threads[a]?.lastModified ?? '')));

	const stats: IThreadPersistStats = { threadsTotal: ids.length, threadsStubbed: 0, messagesStubbed: 0, keptUnarchived: 0, cacheHits: 0, charsBefore: 0, charsAfter: 0 };
	const bounded: { [id: string]: IStorableThread | undefined } = {};
	// keep contiguous synchronous work bounded (~4MB of serialization between
	// event-loop yields) so even a cold bounding pass over a huge backlog
	// never starves the renderer for seconds at a time
	let syncWorkSinceYield = 0;
	const yieldIfNeeded = async () => {
		if (syncWorkSinceYield < 4_000_000) { return; }
		syncWorkSinceYield = 0;
		await new Promise<void>(r => setTimeout(r, 0));
	};

	let remaining = totalBudget;
	for (const id of ids) {
		const thread = threads[id]!;

		// cache hit: same input object AND the cached bounded shape still fits
		// this flush's cap — reuse without any serialization work
		const cached = cache?.entries.get(id);
		if (cached && cached.inputRef === thread) {
			const capForCache = Math.min(perThreadBudget, Math.max(remaining, 0));
			if (cached.boundedLen <= capForCache) {
				bounded[id] = cached.bounded;
				remaining -= cached.boundedLen;
				stats.charsBefore += cached.fullLen;
				stats.charsAfter += cached.boundedLen;
				stats.cacheHits++;
				continue;
			}
		}

		const messages = Array.isArray(thread.messages) ? thread.messages : [];
		const lens = messages.map(m => JSON.stringify(m ?? {}).length);
		const baseLen = JSON.stringify({ ...thread, messages: [] }).length;
		const fullLen = baseLen + lens.reduce((a, b) => a + b, 0);
		stats.charsBefore += fullLen;
		syncWorkSinceYield += fullLen;
		await yieldIfNeeded();

		const cap = Math.min(perThreadBudget, Math.max(remaining, 0));
		if (fullLen <= cap) {
			bounded[id] = thread;
			remaining -= fullLen;
			stats.charsAfter += fullLen;
			if (cache) { cache.entries.set(id, { inputRef: thread, bounded: thread, boundedLen: fullLen, fullLen }); }
			continue;
		}

		// stub the OLDEST stubbable messages until the thread fits its cap.
		// Pass A spares the newest `keepRecent`; pass B (only when the thread
		// is still over cap) admits them, oldest of the recent first — the
		// newest messages stay verbatim whenever the budget allows it.
		const passA: number[] = [];
		const passB: number[] = [];
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			if (!m || !messageIsStubCandidate(m)) { continue; }
			if (i < messages.length - keepRecent) { passA.push(i); }
			else { passB.push(i); }
		}

		// confirm archive copies up-front (parallel), apply in order — a null
		// (unarchived) candidate is skipped and the message stays verbatim.
		// The CALLER's verifier owns any per-flush IO budget (cached
		// confirmations are free), so repeat flushes converge without being
		// starved by the same first candidate.
		const refs = new Map<number, string | null>();
		if (ensureArchived && (passA.length > 0 || passB.length > 0)) {
			const unique = [...new Set([...passA, ...passB])];
			await Promise.all(unique.map(async i => {
				const full = JSON.stringify(messages[i]);
				refs.set(i, await ensureArchived(id, i, full));
			}));
			// give the renderer main thread air after verification work
			await new Promise<void>(r => setTimeout(r, 0));
		}

		const newMessages = messages.slice();
		let len = fullLen;
		let stubbedThisThread = 0;
		for (const i of [...passA, ...passB]) {
			if (len <= cap) { break; }
			const ref = refs.get(i);
			if (!ref) { stats.keptUnarchived++; continue; }
			const stub = makeStub(messages[i]!, ref);
			const stubLen = JSON.stringify(stub).length;
			len += stubLen - lens[i];
			newMessages[i] = stub;
			stubbedThisThread++;
		}
		stats.messagesStubbed += stubbedThisThread;
		if (stubbedThisThread > 0) { stats.threadsStubbed++; }
		const boundedThread = stubbedThisThread > 0 ? { ...thread, messages: newMessages } : thread;
		bounded[id] = boundedThread;
		remaining -= len;
		stats.charsAfter += len;
		if (cache) { cache.entries.set(id, { inputRef: thread, bounded: boundedThread, boundedLen: len, fullLen }); }
	}

	return { bounded, stats };
}
