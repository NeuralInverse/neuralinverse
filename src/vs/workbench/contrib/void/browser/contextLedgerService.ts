/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Context Ledger Service (task M5, phase 0 — journal)
 *
 * The DI shell around the pure core (common/ledgerJournalCore.ts): it owns the
 * `.inverse/ledger/<threadId>/` tree and never blocks a caller.
 *
 *   .inverse/ledger/<threadId>/
 *     meta.json               { threadId, lastSeq, episodeCount, briefRevision, schemaVersion, migratedAt?, turnCoverage? }
 *     journal/000001.jsonl    one ILedgerEntry per line, rotated at policy size
 *     blobs/<entryId>.txt     full bodies of oversized entries
 *     episodes/ep-000001.json write-once frozen episode summaries (D1)
 *     brief.json              latest working brief (D5)
 *
 * ## Write path
 *
 * `append()` assigns seq/tokens/blob split synchronously from in-memory state
 * and resolves immediately; the encoded line (and any blob) sits in a
 * per-thread queue flushed every 300ms or 64KB, whichever comes first. All
 * final writes go through a `.tmp` file (write tmp → write final → delete
 * tmp) because IFileService has no rename-with-replace in this codebase's
 * usage.
 *
 * ## Multi-window stale-state detection (not an atomic compare-and-set)
 *
 * meta.json's `lastSeq` detects an already-completed write from another window. Every flush re-reads it; when the
 * on-disk value differs from what this window last wrote (another IDE window
 * appended to the same thread), the journal tail is re-loaded, the tracker is
 * re-aligned to the disk seq, and every still-queued entry is renumbered
 * before anything is written. Queued entries were returned to callers but
 * never hit disk, so renumbering them is the only way to keep the seq space
 * aligned with observed disk state. This is not a cross-process lock: concurrent
 * windows can both pass the check. Writes use staging files but final writes
 * are not atomic replacements; crash consistency remains a review blocker.
 *
 * ## Degradation (D6)
 *
 * No workspace, or any write failure → the thread drops to in-memory-only
 * with a single console.warn; every read keeps working from memory and
 * nothing ever throws at append callers.
 */

import { sanitizeThreadDirectory, isValidLedgerBlobRef } from '../common/ledgerPaths.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { LEDGER_SCHEMA_VERSION, ILedgerAppendInput, ILedgerEntry, ILedgerStats, IEpisodeSummary, IWorkingBrief, IContextLedgerService as ILedgerServiceContract } from '../common/ledgerTypes.js';
import { ILedgerPolicy, DEFAULT_LEDGER_POLICY, estimateTokens } from '../common/ledgerPolicy.js';
import { JournalSeq, encodeEntry, decodeEntries, shouldRotate, splitContent, computeStats, journalFileName, episodeFileName, mergeBySeq, selectTailNewestFirst } from '../common/ledgerJournalCore.js';
// .inverse/ is write-locked by the firmware layer; route every write through
// the same shared utility agentStoreService uses (chmod around the callback).
import { withInverseWriteAccess } from '../../neuralInverseFirmware/browser/engine/utils/inverseFs.js';

// ─── Service token ────────────────────────────────────────────────────────────
// The contract lives in common/ledgerTypes.ts, which is kept free of `vs/`
// imports on purpose; the DI token is therefore declared next to the shell.
// The evented index-feed contract (F02) is browser-only, so it extends the
// pure contract here instead of pulling `vs/base` into ledgerTypes.

/** Fires after an entry is durably queued — the single hook every writer feeds. */
export interface ILedgerAppendEvent { threadId: string; entry: ILedgerEntry }
/** Fires once per frozen episode (write-once). */
export interface ILedgerEpisodeEvent { threadId: string; episode: IEpisodeSummary }

export interface ILedgerIndexEvents {
	readonly onDidAppendEntry: Event<ILedgerAppendEvent>;
	readonly onDidFreezeEpisode: Event<ILedgerEpisodeEvent>;
	/** Raw thread ids of every known archive (one meta.json per thread dir). */
	listThreads(): Promise<string[]>;
}

export const IContextLedgerService = createDecorator<ILedgerServiceContract & ILedgerIndexEvents>('contextLedgerService');
// value + type must share the name so `@IContextLedgerService svc: IContextLedgerService`
// works with one import (the vs/platform convention: interface + token together)
export type IContextLedgerService = ILedgerServiceContract & ILedgerIndexEvents;

// ─── Constants ────────────────────────────────────────────────────────────────

const INVERSE_DIR = '.inverse';
const LEDGER_DIR = 'ledger';
const JOURNAL_DIR = 'journal';
const EPISODES_DIR = 'episodes';
const META_FILE = 'meta.json';
const BRIEF_FILE = 'brief.json';
/** flush cadence — time or bytes, whichever comes first (task section 7) */
const FLUSH_INTERVAL_MS = 300;
const FLUSH_BYTES = 64 * 1024;
/** filesystem-safe thread id: [a-zA-Z0-9._-] only, 80 chars max */
const JOURNAL_FILE_RE = /^(\d{6,})\.jsonl$/;

interface ILedgerThreadMeta {
	threadId: string;
	lastSeq: number;
	episodeCount: number;
	briefRevision: number;
	schemaVersion: number;
	migratedAt?: number;
	/**
	 * Turn-coverage watermark (re-review T4, follow-up U2): `{through}` —
	 * every COMPLETED history turn with index <= `through` is durably
	 * archived. Object form on purpose: the earlier bare-number convention
	 * (commit 0cb5596) could certify a not-yet-answered current turn, so it
	 * is ignored on hydration and re-derived by a full scan. Written only
	 * from COMMITTED values — the flush that made the proving journal entry
	 * durable promotes the pending claim first (U2: an in-flight older batch
	 * must never publish a newer watermark whose records are still queued).
	 */
	turnCoverage?: { through: number };
}

interface IPendingWrite {
	entry: ILedgerEntry;
	/** encoded JSONL line including its newline */
	line: string;
	/** full body when the entry carries a blobRef */
	blobContent: string | undefined;
}

interface ILedgerThreadState {
	/** raw threadId exactly as callers passed it (kept verbatim in entries) */
	threadId: string;
	/** sanitized id used for every path and entry id */
	fsId: string;
	/** gapless seq tracker, initialized from meta.json/journal on first touch */
	seq: JournalSeq;
	/** entries appended this session and not yet durable */
	pending: ILedgerEntry[];
	/** blob bodies not yet durable, by blobRef */
	pendingBlobs: Map<string, string>;
	/** encoded writes waiting for the next flush */
	queue: IPendingWrite[];
	queueBytes: number;
	flushTimer: ReturnType<typeof setTimeout> | undefined;
	flushInFlight: Promise<void> | undefined;
	/** last journal file number on disk (0 = none yet) */
	currentFileNo: number;
	/** text of the current journal file; new lines are appended to it */
	journalText: string;
	journalBytes: number;
	/** byte size of every known journal file, by file number */
	fileBytes: Map<number, number>;
	/** parsed entries per journal file, loaded on demand; reset on rotation/realign */
	fileCache: Map<number, ILedgerEntry[]>;
	/** what this window believes meta.lastSeq on disk is (CAS anchor) */
	metaLastSeq: number;
	metaMigratedAt: number | undefined;
	/**
	 * DURABLE coverage watermark — only what a completed flush has published
	 * (meta.json `{through}` mirror). Hydration trusts this value blindly, so
	 * it must never outrun the journal bytes on disk (U2).
	 */
	committedTurnCoverage: number | undefined;
	/**
	 * Claimed-but-not-durable watermark (U2): promoted to committedTurnCoverage
	 * only by the flush whose batch makes `pendingCoverageProof` durable. If
	 * the process dies first, neither the claim nor its records survive.
	 */
	pendingTurnCoverage: number | undefined;
	/**
	 * The queued journal entry (the coverage note) whose durability PROVES
	 * pendingTurnCoverage — object identity survives realign renumbering.
	 */
	pendingCoverageProof: ILedgerEntry | undefined;
	episodeCount: number;
	briefRevision: number;
	/** episode cache (undefined = not loaded) */
	episodes: IEpisodeSummary[] | undefined;
	/** brief cache (undefined = not loaded, null = none on disk) */
	brief: IWorkingBrief | null | undefined;
	lastEntryTs: number;
	degraded: boolean;
	warned: boolean;
	init: Promise<void>;
}

// ─── Implementation ───────────────────────────────────────────────────────────
// exported for direct unit/integration testing (registerSingleton wires it in DI)

export class ContextLedgerService extends Disposable implements ILedgerServiceContract, ILedgerIndexEvents {

	declare readonly _serviceBrand: undefined;

	// settings overrides land with the phase-2 flag wiring; the shipped
	// behavior is the default policy for now
	private readonly _policy: ILedgerPolicy = DEFAULT_LEDGER_POLICY;

	private readonly _states = new Map<string, ILedgerThreadState>();

	private readonly _onDidAppendEntry = this._register(new Emitter<ILedgerAppendEvent>());
	readonly onDidAppendEntry = this._onDidAppendEntry.event;
	private readonly _onDidFreezeEpisode = this._register(new Emitter<ILedgerEpisodeEvent>());
	readonly onDidFreezeEpisode = this._onDidFreezeEpisode.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	// ─── Paths ────────────────────────────────────────────────────────────────

	private _ledgerRootUri(): URI | undefined {
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) { return undefined; }
		return URI.joinPath(root, INVERSE_DIR, LEDGER_DIR);
	}

	/** fsPath of `.inverse` itself — what withInverseWriteAccess unlocks (recursive). */
	private _inverseDirFsPath(): string | undefined {
		const root = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!root) { return undefined; }
		return URI.joinPath(root, INVERSE_DIR).fsPath;
	}

	private _threadDirUri(root: URI, state: ILedgerThreadState): URI {
		return URI.joinPath(root, state.fsId);
	}

	private _blobUri(threadDir: URI, blobRef: string): URI {
		if (!isValidLedgerBlobRef(blobRef)) { throw new Error('Invalid ledger blob reference'); }
		return URI.joinPath(threadDir, ...blobRef.split('/'));
	}

	private _sanitizeThreadId(threadId: string): string {
		return sanitizeThreadDirectory(threadId);
	}

	// ─── State lifecycle ──────────────────────────────────────────────────────

	private _ensureState(threadId: string): Promise<ILedgerThreadState> {
		let state = this._states.get(threadId);
		if (!state) { state = this._createState(threadId); }
		// _initState never rejects — failures degrade inside
		return state.init.then(() => state);
	}

	private _createState(threadId: string): ILedgerThreadState {
		const state: ILedgerThreadState = {
			threadId,
			fsId: this._sanitizeThreadId(threadId),
			seq: new JournalSeq(0),
			pending: [],
			pendingBlobs: new Map(),
			queue: [],
			queueBytes: 0,
			flushTimer: undefined,
			flushInFlight: undefined,
			currentFileNo: 0,
			journalText: '',
			journalBytes: 0,
			fileBytes: new Map(),
			fileCache: new Map(),
			metaLastSeq: 0,
			metaMigratedAt: undefined,
			committedTurnCoverage: undefined,
			pendingTurnCoverage: undefined,
			pendingCoverageProof: undefined,
			episodeCount: 0,
			briefRevision: 0,
			episodes: undefined,
			brief: undefined,
			lastEntryTs: 0,
			degraded: false,
			warned: false,
			init: Promise.resolve(),
		};
		this._states.set(threadId, state);
		state.init = this._initState(state);
		return state;
	}

	/** One-time disk discovery for a thread; any failure degrades to memory. */
	private async _initState(state: ILedgerThreadState): Promise<void> {
		try {
			const root = this._ledgerRootUri();
			if (!root) {
				this._degrade(state);
				return;
			}
			const threadDir = this._threadDirUri(root, state);
			// meta.json — the seq anchor for the multi-window CAS
			const meta = await this._readJsonFile<ILedgerThreadMeta>(URI.joinPath(threadDir, META_FILE));
			if (meta) {
				state.seq = new JournalSeq(meta.lastSeq ?? 0);
				state.metaLastSeq = meta.lastSeq ?? 0;
				state.episodeCount = meta.episodeCount ?? 0;
				state.briefRevision = meta.briefRevision ?? 0;
				state.metaMigratedAt = meta.migratedAt;
				// object form only — the earlier bare-number watermark could
				// certify a not-yet-answered turn (U1); ignoring it costs a
				// full rescan, trusting it could lose an answer forever
				const tc = meta.turnCoverage;
				if (tc && typeof tc === 'object' && Number.isInteger(tc.through) && tc.through >= 0) {
					state.committedTurnCoverage = tc.through;
				}
			}
			// journal discovery: the highest NNNNNN.jsonl is the live file
			const journalDir = URI.joinPath(threadDir, JOURNAL_DIR);
			await this._loadJournalFiles(state, journalDir);
		} catch {
			this._degrade(state);
		}
	}

	/** Discover journal files, load the live one and surface seq gaps. */
	private async _loadJournalFiles(state: ILedgerThreadState, journalDir: URI): Promise<void> {
		let maxNo = 0;
		for (const child of await this._tryResolveChildren(journalDir)) {
			const m = JOURNAL_FILE_RE.exec(child.name);
			if (!m) { continue; }
			const no = parseInt(m[1], 10);
			state.fileBytes.set(no, child.size);
			if (no > maxNo) { maxNo = no; }
		}
		if (maxNo === 0) { return; }
		state.currentFileNo = maxNo;
		const text = await this._readTextFile(URI.joinPath(journalDir, journalFileName(maxNo))) ?? '';
		state.journalText = text;
		state.journalBytes = VSBuffer.fromString(text).byteLength;
		const entries = decodeEntries(text);
		state.fileCache.set(maxNo, entries);
		// continuity check within the file: a tear from a crash should be
		// visible, not silent (checker starts one below the first line's seq)
		const checker = new JournalSeq(entries.length > 0 ? entries[0].seq - 1 : 0);
		for (const e of entries) {
			if (!checker.observe(e.seq)) {
				console.warn(`[ContextLedger] journal gap detected at seq ${e.seq} in ${state.fsId}/${journalFileName(maxNo)}`);
			}
		}
		const last = entries[entries.length - 1];
		if (last) {
			state.lastEntryTs = last.ts;
			// crash-before-meta leaves meta.lastSeq behind the journal — adopt
			// the journal's truth so the tracker never hands out a used seq
			if (last.seq > state.seq.last) { state.seq = new JournalSeq(last.seq); }
		}
	}

	private _degrade(state: ILedgerThreadState): void {
		if (!state.warned) {
			state.warned = true;
			console.warn('[ContextLedger] disk unavailable, using in-memory fallback');
		}
		state.degraded = true;
		state.queue.length = 0;
		state.queueBytes = 0;
		if (state.flushTimer !== undefined) {
			clearTimeout(state.flushTimer);
			state.flushTimer = undefined;
		}
	}

	// ─── File helpers ─────────────────────────────────────────────────────────

	private async _readTextFile(uri: URI): Promise<string | undefined> {
		try {
			const content = await this.fileService.readFile(uri);
			return content.value.toString();
		} catch {
			return undefined;
		}
	}

	private async _readJsonFile<T>(uri: URI): Promise<T | undefined> {
		const text = await this._readTextFile(uri);
		if (text === undefined) { return undefined; }
		try {
			return JSON.parse(text) as T;
		} catch {
			return undefined;
		}
	}

	private async _tryResolveChildren(uri: URI): Promise<{ name: string; size: number }[]> {
		try {
			const stat = await this.fileService.resolve(uri);
			return (stat.children ?? []).map(c => ({ name: c.name, size: c.size ?? 0 }));
		} catch {
			return [];
		}
	}

	private async _ensureFolder(uri: URI): Promise<void> {
		try {
			await this.fileService.createFolder(uri);
		} catch { /* already exists */ }
	}

	/**
	 * Stage a copy before writing the final file. This is not an atomic rename:
	 * a crash during the final write may leave a partial file. Keep this explicit
	 * until provider-aware atomic replacement and recovery are implemented.
	 */
	private async _writeFileWithStaging(uri: URI, content: string): Promise<void> {
		const tmp = uri.with({ path: uri.path + '.tmp' });
		await this.fileService.writeFile(tmp, VSBuffer.fromString(content));
		await this.fileService.writeFile(uri, VSBuffer.fromString(content));
		try {
			await this.fileService.del(tmp, { recursive: false });
		} catch { /* best-effort cleanup */ }
	}

	private _metaOf(state: ILedgerThreadState): ILedgerThreadMeta {
		const meta: ILedgerThreadMeta = {
			threadId: state.threadId,
			lastSeq: state.seq.last,
			episodeCount: state.episodeCount,
			briefRevision: state.briefRevision,
			schemaVersion: LEDGER_SCHEMA_VERSION,
		};
		if (state.metaMigratedAt !== undefined) { meta.migratedAt = state.metaMigratedAt; }
		// committed ONLY — a pending claim must never reach meta.json ahead of
		// the journal bytes that prove it (U2)
		if (state.committedTurnCoverage !== undefined) { meta.turnCoverage = { through: state.committedTurnCoverage }; }
		return meta;
	}

	// ─── Write queue & flush ──────────────────────────────────────────────────

	private _enqueueWrite(state: ILedgerThreadState, item: IPendingWrite): void {
		if (state.degraded) { return; }
		state.queue.push(item);
		state.queueBytes += item.line.length + (item.blobContent ? item.blobContent.length : 0);
		if (state.queueBytes >= FLUSH_BYTES) {
			// byte threshold hit — flush now rather than waiting out the timer
			this._flushSoon(state);
		} else if (state.flushTimer === undefined) {
			state.flushTimer = setTimeout(() => {
				state.flushTimer = undefined;
				this._flushSoon(state);
			}, FLUSH_INTERVAL_MS);
		}
	}

	/** Single-flight flush: never two concurrent writers on one thread. */
	private _flushSoon(state: ILedgerThreadState): void {
		if (state.flushTimer !== undefined) {
			clearTimeout(state.flushTimer);
			state.flushTimer = undefined;
		}
		const prev = state.flushInFlight ?? Promise.resolve();
		state.flushInFlight = prev.then(() => this._doFlush(state));
	}

	private async _doFlush(state: ILedgerThreadState): Promise<void> {
		const items = state.queue.splice(0, state.queue.length);
		state.queueBytes = 0;
		if (items.length === 0 || state.degraded) { return; }
		const root = this._ledgerRootUri();
		if (!root) {
			this._degrade(state);
			return;
		}
		try {
			const threadDir = this._threadDirUri(root, state);
			const journalDir = URI.joinPath(threadDir, JOURNAL_DIR);
			const inversePath = this._inverseDirFsPath();
			if (!inversePath) { this._degrade(state); return; }
			// the whole flush (journal + blobs + meta) shares one chmod window
			await withInverseWriteAccess(inversePath, async () => {

				// ── multi-window compare-and-set on meta.lastSeq (see header) ──
				const diskMeta = await this._readJsonFile<ILedgerThreadMeta>(URI.joinPath(threadDir, META_FILE));
				if ((diskMeta?.lastSeq ?? 0) !== state.metaLastSeq) {
					await this._realignFromDisk(state, root, diskMeta, items);
				}

				// ── journal append with rotation ──
				await this._ensureFolder(journalDir);
				if (state.currentFileNo === 0 || shouldRotate(state.journalBytes, this._policy)) {
					// a fresh file gets a fresh entry cache; the sealed file's
					// cache stays valid (append-only, never rewritten)
					state.currentFileNo += 1;
					state.journalText = '';
					state.journalBytes = 0;
					state.fileCache.set(state.currentFileNo, []);
				}
				let cache = state.fileCache.get(state.currentFileNo);
				if (!cache) {
					cache = decodeEntries(state.journalText);
					state.fileCache.set(state.currentFileNo, cache);
				}
				// rotation is checked once per flush: an unusually large batch may
				// overshoot one file rather than rotate mid-batch — acceptable and
				// self-correcting on the next flush
				let text = state.journalText;
				let bytes = state.journalBytes;
				for (const item of items) {
					text += item.line;
					bytes += VSBuffer.fromString(item.line).byteLength;
					cache.push(item.entry);
				}
				await this._writeFileWithStaging(URI.joinPath(journalDir, journalFileName(state.currentFileNo)), text);
				state.journalText = text;
				state.journalBytes = bytes;
				state.fileBytes.set(state.currentFileNo, bytes);

				// ── blobs (full bodies of oversized entries) ──
				for (const item of items) {
					if (!item.blobContent) { continue; }
					const ref = item.entry.blobRef;
					if (!isValidLedgerBlobRef(ref)) { continue; }
					await this._writeFileWithStaging(this._blobUri(threadDir, ref), item.blobContent);
				}

				// ── coverage promotion (U2) ──
				// This batch's journal bytes are durable NOW. A pending
				// coverage claim may be published only if the entry that proves
				// it (the coverage note) is in THIS batch or was already made
				// durable by an earlier flush — an in-flight OLDER batch must
				// never publish a newer watermark whose records are still
				// queued behind it.
				if (state.pendingTurnCoverage !== undefined) {
					const proof = state.pendingCoverageProof;
					const proofDurable = proof === undefined
						|| !state.pending.includes(proof)
						|| items.some(it => it.entry === proof);
					if (proofDurable) {
						state.committedTurnCoverage = Math.max(state.committedTurnCoverage ?? -1, state.pendingTurnCoverage);
						state.pendingTurnCoverage = undefined;
						state.pendingCoverageProof = undefined;
					}
				}

				// ── meta last: the CAS anchor commits only after the data ──
				state.metaLastSeq = state.seq.last;
				await this._writeFileWithStaging(URI.joinPath(threadDir, META_FILE), JSON.stringify(this._metaOf(state), null, 2));

				// durable now — drop the entries from the pending overlay
				for (const item of items) {
					const idx = state.pending.indexOf(item.entry);
					if (idx >= 0) { state.pending.splice(idx, 1); }
					const ref = item.entry.blobRef;
					if (ref !== undefined) { state.pendingBlobs.delete(ref); }
				}
			});
		} catch {
			this._degrade(state);
		}
	}

	/**
	 * Another window appended to this thread (meta.lastSeq moved). Re-discover
	 * the journal, re-align the tracker to the disk seq and renumber every
	 * entry that is not durable yet — the in-flight `items` plus anything that
	 * queued behind them. Those entries were returned to callers but never
	 * written, so renumbering them is the only way to keep the seq space
	 * gapless; callers hold the same (mutated) objects, which is the honest
	 * outcome: the entries' durable identity is what they become here.
	 */
	private async _realignFromDisk(state: ILedgerThreadState, root: URI, diskMeta: ILedgerThreadMeta | undefined, items: IPendingWrite[]): Promise<void> {
		state.fileCache.clear();
		state.currentFileNo = 0;
		state.journalText = '';
		state.journalBytes = 0;
		await this._loadJournalFiles(state, URI.joinPath(this._threadDirUri(root, state), JOURNAL_DIR));
		if (diskMeta) {
			state.episodeCount = Math.max(state.episodeCount, diskMeta.episodeCount ?? 0);
			state.briefRevision = Math.max(state.briefRevision, diskMeta.briefRevision ?? 0);
			state.metaMigratedAt = diskMeta.migratedAt ?? state.metaMigratedAt;
			const tc = diskMeta.turnCoverage;
			if (tc && typeof tc === 'object' && Number.isInteger(tc.through) && tc.through >= 0) {
				state.committedTurnCoverage = Math.max(state.committedTurnCoverage ?? -1, tc.through);
			}
		}
		state.metaLastSeq = diskMeta?.lastSeq ?? 0;
		// _loadJournalFiles may have adopted a journal seq ahead of a stale
		// meta (crash-before-meta) — the tracker already reflects the truth
		const renumber = (item: IPendingWrite): void => {
			const seq = state.seq.next();
			item.entry.seq = seq;
			item.entry.id = `le_${state.fsId}_${seq}`;
			const ref = item.entry.blobRef;
			if (ref !== undefined) {
				const full = state.pendingBlobs.get(ref) ?? item.blobContent ?? '';
				state.pendingBlobs.delete(ref);
				const resplit = splitContent(full, this._policy, `le_${state.fsId}_${seq}.txt`);
				item.entry.content = resplit.inline;
				item.entry.blobRef = resplit.blobRef;
				item.blobContent = resplit.blobRef ? full : undefined;
				if (resplit.blobRef) { state.pendingBlobs.set(resplit.blobRef, full); }
			}
			item.line = encodeEntry(item.entry) + '\n';
		};
		for (const item of items) { renumber(item); }
		for (const item of state.queue) { renumber(item); }
	}

	// ─── Reads ────────────────────────────────────────────────────────────────

	private async _loadFileEntries(state: ILedgerThreadState, fileNo: number): Promise<ILedgerEntry[]> {
		const cached = state.fileCache.get(fileNo);
		if (cached) { return cached; }
		const root = this._ledgerRootUri();
		if (!root) { return []; }
		const uri = URI.joinPath(root, state.fsId, JOURNAL_DIR, journalFileName(fileNo));
		const text = await this._readTextFile(uri);
		const entries = text === undefined ? [] : decodeEntries(text);
		state.fileCache.set(fileNo, entries);
		return entries;
	}

	/** Splice full blob bodies back in; pending bodies win over disk. */
	private async _spliceBlobs(state: ILedgerThreadState, entries: ILedgerEntry[]): Promise<ILedgerEntry[]> {
		const out: ILedgerEntry[] = [];
		const root = this._ledgerRootUri();
		for (const e of entries) {
			const ref = e.blobRef;
			if (ref === undefined) {
				out.push(e);
				continue;
			}
			const pendingBody = state.pendingBlobs.get(ref);
			if (pendingBody !== undefined) {
				out.push({ ...e, content: pendingBody, blobRef: undefined });
				continue;
			}
			let body: string | undefined = undefined;
			if (root && !state.degraded) {
				body = await this._readTextFile(this._blobUri(this._threadDirUri(root, state), ref));
			}
			if (body !== undefined) {
				out.push({ ...e, content: body, blobRef: undefined });
			} else {
				// blob missing on disk → keep the inline head/tail window
				out.push(e);
			}
		}
		return out;
	}

	// ─── IContextLedgerService ────────────────────────────────────────────────

	async append(threadId: string, input: ILedgerAppendInput): Promise<ILedgerEntry | null> {
		const state = await this._ensureState(threadId);
		// everything below is in-memory — append still assigns after degradation
		const seq = state.seq.next();
		const id = `le_${state.fsId}_${seq}`;
		const split = splitContent(input.content, this._policy, `${id}.txt`);
		const entry: ILedgerEntry = {
			id,
			seq,
			threadId,
			role: input.role,
			name: input.name,
			content: split.inline,
			blobRef: split.blobRef,
			ts: Date.now(),
			// tokens are measured on the FULL body at write time, not the window
			tokens: estimateTokens(input.content),
			meta: input.meta ? { ...input.meta } : undefined,
		};
		state.pending.push(entry);
		if (split.blobRef) { state.pendingBlobs.set(split.blobRef, input.content); }
		state.lastEntryTs = entry.ts;
		this._enqueueWrite(state, { entry, line: encodeEntry(entry) + '\n', blobContent: split.blobRef ? input.content : undefined });
		// F02 index feed: ONE event for every writer (sidebar, native bridge,
		// executor, workflow) so the recall index can never drift from the
		// journal again
		this._onDidAppendEntry.fire({ threadId, entry });
		return entry;
	}

	async readRange(threadId: string, fromSeq: number, toSeq: number): Promise<ILedgerEntry[]> {
		const state = await this._ensureState(threadId);
		// snapshot boundary (F03 review R4): take the pending overlay in the
		// same synchronous step as the segment count. A flush running during
		// the durable reads below moves entries into a NEWER segment this loop
		// will never visit — the snapshot still holds them, and mergeBySeq
		// dedupes the copies that land in both stores.
		const pendingSnapshot = state.pending.filter(e => e.seq >= fromSeq && e.seq <= toSeq);
		const fileNoAtSnapshot = state.currentFileNo;
		const durable: ILedgerEntry[] = [];
		if (!state.degraded) {
			for (let no = 1; no <= fileNoAtSnapshot; no++) {
				for (const e of await this._loadFileEntries(state, no)) {
					if (e.seq >= fromSeq && e.seq <= toSeq) { durable.push(e); }
				}
			}
		}
		// a flush can momentarily hold an entry in both stores — mergeBySeq
		// counts each seq once (F03 read-consistency contract)
		return this._spliceBlobs(state, mergeBySeq(durable, pendingSnapshot));
	}

	async readTail(threadId: string, maxEntries: number): Promise<ILedgerEntry[]> {
		if (maxEntries <= 0) { return []; }
		const state = await this._ensureState(threadId);
		// snapshot boundary (F03 review R4) — see readRange: the pending
		// overlay and the live segment number are captured atomically, so an
		// entry flushed (and rotated) mid-read is still accounted for
		const pendingSnapshot = state.pending.slice();
		const fileNoAtSnapshot = state.currentFileNo;
		// newest journal file backwards; each file's entries ascend, so the
		// arrays arrive newest-first for selectTailNewestFirst. Bounded I/O:
		// stop once the union of the snapshot and the segments read so far
		// cannot change the newest-N answer — older files hold only older seqs.
		const seen = new Set<number>();
		for (const e of pendingSnapshot) { seen.add(e.seq); }
		const durableNewestFirst: ILedgerEntry[][] = [];
		if (!state.degraded) {
			for (let no = fileNoAtSnapshot; no >= 1 && seen.size < maxEntries; no--) {
				const fileEntries = await this._loadFileEntries(state, no);
				durableNewestFirst.push(fileEntries);
				for (const e of fileEntries) { seen.add(e.seq); }
			}
		}
		// F03: newest N unique entries ascending — pending first (newest),
		// deduped by seq against the durable store during a flush window
		return this._spliceBlobs(state, selectTailNewestFirst(durableNewestFirst, pendingSnapshot, maxEntries));
	}

	async stats(threadId: string): Promise<ILedgerStats | null> {
		const state = await this._ensureState(threadId);
		// snapshot boundary (F03 review R4) — see readRange
		const pendingSnapshot = state.pending.slice();
		const fileNoAtSnapshot = state.currentFileNo;
		const durable: ILedgerEntry[] = [];
		if (!state.degraded) {
			for (let no = 1; no <= fileNoAtSnapshot; no++) {
				durable.push(...await this._loadFileEntries(state, no));
			}
		}
		// F03: dedupe the flush window so an entry landing in both stores is
		// not double-counted in entryCount/totalTokens
		const entries = mergeBySeq(durable, pendingSnapshot);
		const episodes = await this.listEpisodes(threadId);
		const core = computeStats(entries, episodes.map(ep => ep.range));
		if (core.entryCount === 0) { return null; }
		let journalBytes = 0;
		for (const size of state.fileBytes.values()) { journalBytes += size; }
		return {
			entryCount: core.entryCount,
			totalTokens: core.totalTokens,
			unsummarizedTokens: core.unsummarizedTokens,
			lastSeq: core.lastSeq,
			episodeCount: core.episodeCount,
			journalBytes,
			lastEntryTs: state.lastEntryTs,
		};
	}

	/**
	 * The DURABLE contiguous coverage watermark — only what a completed flush
	 * has published to meta.json. Callers that hydrate this value after a
	 * restart and skip re-archiving on it (migration) need exactly the claim
	 * the disk can prove; a still-queued claim is deliberately invisible here
	 * (U2: readable pending state and durable coverage stay distinct).
	 */
	async getTurnCoverage(threadId: string): Promise<number | undefined> {
		const state = await this._ensureState(threadId);
		return state.committedTurnCoverage;
	}

	/**
	 * Record a migration-confirmed watermark (monotonic, pending). The claim
	 * becomes durable metadata only when the flush that makes the proving
	 * journal entry (the coverage note the caller appends in the same breath)
	 * durable promotes it — never before, so a crash can lose the claim and
	 * its records TOGETHER but never the records alone (U2).
	 */
	async recordTurnCoverage(threadId: string, coveredThrough: number): Promise<void> {
		if (!Number.isInteger(coveredThrough) || coveredThrough < 0) { return; }
		const state = await this._ensureState(threadId);
		if (coveredThrough > (state.pendingTurnCoverage ?? -1)) {
			state.pendingTurnCoverage = coveredThrough;
			// the newest not-yet-durable entry is the coverage note; object
			// identity survives realign renumbering, and its presence in a
			// flush batch is the promotion proof
			state.pendingCoverageProof = state.pending[state.pending.length - 1];
		}
	}

	async listEpisodes(threadId: string): Promise<IEpisodeSummary[]> {
		const state = await this._ensureState(threadId);
		if (state.episodes) { return state.episodes; }
		const episodes: IEpisodeSummary[] = [];
		if (!state.degraded) {
			const root = this._ledgerRootUri();
			if (root) {
				const dir = URI.joinPath(this._threadDirUri(root, state), EPISODES_DIR);
				for (const child of await this._tryResolveChildren(dir)) {
					if (!child.name.endsWith('.json')) { continue; }
					const ep = await this._readJsonFile<IEpisodeSummary>(URI.joinPath(dir, child.name));
					if (ep && ep.id && typeof ep.ordinal === 'number' && ep.range) { episodes.push(ep); }
				}
			}
		}
		episodes.sort((a, b) => a.ordinal - b.ordinal);
		state.episodes = episodes;
		return episodes;
	}

	async saveEpisode(episode: IEpisodeSummary): Promise<void> {
		const state = await this._ensureState(episode.threadId);
		const list = await this.listEpisodes(episode.threadId);
		if (list.some(ep => ep.ordinal === episode.ordinal)) {
			throw new Error(`[ContextLedger] episode already frozen: ${episode.id}`);
		}
		const root = this._ledgerRootUri();
		if (state.degraded || !root) {
			// in-memory write-once still enforced; nothing hits disk
			list.push(episode);
			list.sort((a, b) => a.ordinal - b.ordinal);
			state.episodeCount = Math.max(state.episodeCount, list.length);
			this._onDidFreezeEpisode.fire({ threadId: episode.threadId, episode });
			return;
		}
		const dir = URI.joinPath(this._threadDirUri(root, state), EPISODES_DIR);
		const inversePath = this._inverseDirFsPath();
		if (!inversePath) { this._degrade(state); return; }
		// createFile(overwrite:false) is the write-once gate: it also fails if
		// another window froze this ordinal concurrently — that error must
		// propagate (the caller treats it as "already frozen"), not degrade
		await withInverseWriteAccess(inversePath, async () => {
			await this._ensureFolder(dir);
			await this.fileService.createFile(
				URI.joinPath(dir, episodeFileName(episode.ordinal)),
				VSBuffer.fromString(JSON.stringify(episode, null, 2)),
				{ overwrite: false },
			);
		});
		list.push(episode);
		list.sort((a, b) => a.ordinal - b.ordinal);
		state.episodeCount = Math.max(state.episodeCount, list.length);
		this._onDidFreezeEpisode.fire({ threadId: episode.threadId, episode });
		// keep the CAS anchor's episodeCount current. The anchor write must NOT
		// clobber concurrent writers: re-read disk meta inside the window and
		// take the max of disk vs memory. Writing state.seq.last blindly (which
		// includes still-queued entries, or is STALE when another window
		// appended durably) desyncs metaLastSeq — the next flush then
		// "realigns", renumbers pending entries, and can rewrite the live
		// journal from a stale buffer, deleting the other window's entries
		// (review finding P1, 2026-09-05).
		try {
			await withInverseWriteAccess(inversePath, async () => {
				const diskMeta = await this._readJsonFile<ILedgerThreadMeta>(URI.joinPath(this._threadDirUri(root, state), META_FILE));
				const lastSeq = Math.max(state.seq.last, diskMeta?.lastSeq ?? 0);
				const episodeCount = Math.max(state.episodeCount, diskMeta?.episodeCount ?? 0);
				const briefRevision = Math.max(state.briefRevision, diskMeta?.briefRevision ?? 0);
				const meta: ILedgerThreadMeta = {
					threadId: state.threadId,
					lastSeq,
					episodeCount,
					briefRevision,
					schemaVersion: LEDGER_SCHEMA_VERSION,
				};
				if (diskMeta?.migratedAt !== undefined) { meta.migratedAt = diskMeta.migratedAt; }
				else if (state.metaMigratedAt !== undefined) { meta.migratedAt = state.metaMigratedAt; }
				// U2: only the DURABLE watermark may appear here — this write
				// happens outside the flush order, so an in-memory (possibly
				// still-queued) claim must not ride it to disk ahead of its
				// records. The next flush persists the promoted value anyway.
				if (diskMeta?.turnCoverage !== undefined) { meta.turnCoverage = diskMeta.turnCoverage; }
				await this._writeFileWithStaging(URI.joinPath(this._threadDirUri(root, state), META_FILE), JSON.stringify(meta, null, 2));
				// the tracker's CAS belief must stay at OUR seq (not the merged
				// disk value): if disk was AHEAD (another window appended), the
				// next flush must still see a mismatch and realign the tracker —
				// aligning here would let the stale tracker hand out duplicate
				// seqs. When disk was NOT ahead, this equals what we just wrote.
				state.metaLastSeq = state.seq.last;
			});
		} catch {
			this._degrade(state);
		}
	}

	async getBrief(threadId: string): Promise<IWorkingBrief | null> {
		const state = await this._ensureState(threadId);
		if (state.brief !== undefined) { return state.brief; }
		let brief: IWorkingBrief | null = null;
		if (!state.degraded) {
			const root = this._ledgerRootUri();
			if (root) {
				const loaded = await this._readJsonFile<IWorkingBrief>(URI.joinPath(this._threadDirUri(root, state), BRIEF_FILE));
				if (loaded && loaded.threadId === threadId) { brief = loaded; }
			}
		}
		state.brief = brief;
		return brief;
	}

	async saveBrief(brief: IWorkingBrief): Promise<void> {
		const state = await this._ensureState(brief.threadId);
		state.brief = brief;
		state.briefRevision = Math.max(state.briefRevision, brief.revision);
		const root = this._ledgerRootUri();
		if (state.degraded || !root) { return; }
		const inversePath = this._inverseDirFsPath();
		if (!inversePath) { return; }
		try {
			await withInverseWriteAccess(inversePath, async () => {
				await this._writeFileWithStaging(URI.joinPath(this._threadDirUri(root, state), BRIEF_FILE), JSON.stringify(brief, null, 2));
			});
		} catch {
			this._degrade(state);
		}
	}

	invalidateCaches(threadId: string): void {
		const state = this._states.get(threadId);
		if (!state) { return; }
		// seq tracker, pending overlay and the live journal buffer stay — they
		// are write-path state; only the read caches are dropped
		state.fileCache.clear();
		state.episodes = undefined;
		state.brief = undefined;
	}

	async listThreads(): Promise<string[]> {
		// enumerate thread dirs under the ledger root; the raw threadId comes
		// from each dir's meta.json (dir names are sanitized fs ids, not raw ids)
		const root = this._ledgerRootUri();
		if (!root) { return []; }
		const children = await this._tryResolveChildren(root);
		const threadIds: string[] = [];
		for (const child of children) {
			const meta = await this._readJsonFile<ILedgerThreadMeta>(URI.joinPath(root, child.name, META_FILE));
			if (meta?.threadId) { threadIds.push(meta.threadId); }
		}
		return threadIds;
	}

	override dispose(): void {
		// Best-effort drain: entries returned to callers as journaled receipts
		// sit in a ≤300ms/64KB queue — dropping them on quit silently loses
		// journal data (review finding, 2026-09-05). We cannot await in
		// dispose, so fire the flush; whatever loses the race is repaired by
		// the crash-recovery path on next open.
		for (const state of this._states.values()) {
			if (state.flushTimer !== undefined) { clearTimeout(state.flushTimer); }
			if (state.queue.length > 0 && !state.degraded) {
				void Promise.resolve(this._flushSoon(state)).catch(() => undefined);
			}
		}
		this._states.clear();
		super.dispose();
	}
}

registerSingleton(IContextLedgerService, ContextLedgerService, InstantiationType.Delayed);
