/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * Thread history archive service (v2 of the renderer-OOM fix — Astra review
 * closure, 2026-09-19). See common/threadArchiveCore.ts for the on-disk
 * layout and the pure rules.
 *
 * The one hard rule (the v1 gap): a persisted message is replaced by a
 * marker ONLY AFTER a full verbatim copy of that exact message is confirmed
 * durable HERE — application-scoped, restart-proof, per-message (hash
 * verified by read-back). `ensureArchived` never throws and returns null on
 * ANY failure so the store keeps the original text and the honest stats say
 * so. It covers every thread of the global UI store regardless of which
 * workspace it belongs to and whether its per-workspace ledger journal is
 * reachable from this window.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import {
	registerSingleton,
	InstantiationType,
} from '../../../../platform/instantiation/common/extensions.js';
import {
	THREAD_ARCHIVE_DIR_NAME,
	archiveFileNameOf,
	archiveHashOf,
	isValidArchiveRef,
	parseArchivedMessage,
	sanitizeThreadId,
	type ILegacyIndexFile,
	type IArchivedRef,
} from '../common/threadArchiveCore.js';
import {
	messageIsStubbed,
	type IStorableMessage,
} from '../common/threadStorageBound.js';

export const IThreadArchiveService = createDecorator<IThreadArchiveService>(
	'threadArchiveService',
);

export interface IRestoreThreadResult {
	messages: IStorableMessage[];
	/** marker messages replaced with their archived full text */
	restored: number;
	/** marker messages whose archive could not be resolved (kept as markers) */
	unresolved: number;
}

export interface IThreadArchiveService {
	readonly _serviceBrand: undefined;
	/**
	 * Confirm a durable full copy of the EXACT serialized message. Returns
	 * the archive file ref to store on the stub, or null when the copy could
	 * not be confirmed (the caller must then keep the original text).
	 */
	ensureArchived(
		threadId: string,
		messageIndex: number,
		fullSerialized: string,
	): Promise<string | null>;
	/** Cache-only variant for shutdown paths — never performs IO. */
	ensureArchivedCached(threadId: string, fullSerialized: string): string | null;
	/** Read the full serialized message behind a stub ref (verified). */
	readArchivedMessage(threadId: string, ref: string): Promise<string | null>;
	/** fsPath of the archive root (diagnostics / tooling); undefined pre-hydration. */
	archiveRootFsPath(): string | undefined;
	/**
	 * Replace marker messages of a thread with their archived full text —
	 * used when a thread is opened (rehydration). Markers whose archive is
	 * missing or fails verification stay markers (`unresolved`).
	 */
	restoreThreadMessages(
		threadId: string,
		messages: IStorableMessage[],
	): Promise<IRestoreThreadResult>;
}

export class ThreadArchiveService
	extends Disposable
	implements IThreadArchiveService {
	declare readonly _serviceBrand: undefined;

	/** messageIndex → {f, role}, from index.json (v1-stub rehydration) */
	private readonly _legacyIndexes = new Map<
		string,
		NonNullable<ILegacyIndexFile['entries']>
	>();
	private readonly _verified = new Set<string>();
	private readonly _inFlight = new Map<string, Promise<string | null>>();
	private _root: URI | undefined;
	private _rootLogged = false;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		@IEnvironmentService
		private readonly _environmentService: IEnvironmentService,
	) {
		super();
	}

	private _rootUri(): URI | undefined {
		if (this._root) {
			return this._root;
		}
		// userRoamingDataHome is <userDataPath>/User on native; the archive is
		// a sibling of it so it survives per-workspace churn the same way the
		// global storage does
		const roaming = this._environmentService.userRoamingDataHome;
		if (!roaming) {
			return undefined;
		}
		this._root = URI.joinPath(
			URI.joinPath(roaming, '..'),
			THREAD_ARCHIVE_DIR_NAME,
		);
		return this._root;
	}

	private _threadDir(threadId: string): URI | undefined {
		const root = this._rootUri();
		if (!root) {
			return undefined;
		}
		return URI.joinPath(root, sanitizeThreadId(threadId));
	}

	private _keyOf(threadId: string, file: string): string {
		return `${sanitizeThreadId(threadId)}/${file}`;
	}

	private async _readIfExists(uri: URI): Promise<string | undefined> {
		try {
			const res = await this._fileService.readFile(uri);
			return res.value.toString();
		} catch {
			return undefined;
		}
	}

	async ensureArchived(
		threadId: string,
		_messageIndex: number,
		fullSerialized: string,
	): Promise<string | null> {
		const file = archiveFileNameOf(archiveHashOf(fullSerialized));
		const key = this._keyOf(threadId, file);
		if (this._verified.has(key)) {
			return file;
		}
		const inFlight = this._inFlight.get(key);
		if (inFlight) {
			return inFlight;
		}
		const p = this._doEnsureArchived(threadId, file, fullSerialized).finally(
			() => this._inFlight.delete(key),
		);
		this._inFlight.set(key, p);
		return p;
	}

	private async _doEnsureArchived(
		threadId: string,
		file: string,
		fullSerialized: string,
	): Promise<string | null> {
		const threadDir = this._threadDir(threadId);
		if (!threadDir) {
			// no user-data dir — cannot archive; caller keeps the original text
			return null;
		}
		const uri = URI.joinPath(threadDir, file);
		try {
			await this._fileService.createFolder(threadDir);
			// already durable and identical? (write-once content-addressed)
			const existing = await this._readIfExists(uri);
			if (existing !== undefined) {
				if (archiveHashOf(existing) === archiveHashOf(fullSerialized)) {
					this._verified.add(this._keyOf(threadId, file));
					return file;
				}
				// same name ⇒ same hash, so this cannot happen unless the file
				// was corrupted; rewrite below repairs it
				this._logService.warn(
					`[ThreadArchive] hash mismatch on existing archive ${file} — rewriting`,
				);
			}
			await this._fileService.writeFile(
				uri,
				VSBuffer.fromString(fullSerialized),
			);
			// read-back verification: the copy must survive on disk with the
			// exact bytes before any marker may reference it
			const back = await this._readIfExists(uri);
			if (
				back === undefined ||
				archiveHashOf(back) !== archiveHashOf(fullSerialized)
			) {
				this._logService.warn(
					`[ThreadArchive] read-back verification failed for ${file} — message kept verbatim in the store`,
				);
				return null;
			}
			this._verified.add(this._keyOf(threadId, file));
			if (!this._rootLogged) {
				this._rootLogged = true;
				this._logService.info(
					`[ThreadArchive] durable archive at ${this._rootUri()!.fsPath}`,
				);
			}
			return file;
		} catch (e) {
			this._logService.warn(
				`[ThreadArchive] archive write failed (${e}) — message kept verbatim in the store`,
			);
			return null;
		}
	}

	ensureArchivedCached(
		threadId: string,
		fullSerialized: string,
	): string | null {
		const file = archiveFileNameOf(archiveHashOf(fullSerialized));
		return this._verified.has(this._keyOf(threadId, file)) ? file : null;
	}

	async readArchivedMessage(
		threadId: string,
		ref: string,
	): Promise<string | null> {
		if (!isValidArchiveRef(ref)) {
			return null;
		}
		const threadDir = this._threadDir(threadId);
		if (!threadDir) {
			return null;
		}
		const body = await this._readIfExists(URI.joinPath(threadDir, ref));
		if (body === undefined) {
			return null;
		}
		// integrity: the ref names the sha of its own content
		if (archiveHashOf(body) !== ref.slice(0, ref.length - '.json'.length)) {
			return null;
		}
		return body;
	}

	/** index.json map for a thread — lazily loaded, absent file = empty. */
	private async _legacyIndex(
		threadId: string,
	): Promise<NonNullable<ILegacyIndexFile['entries']>> {
		const cached = this._legacyIndexes.get(sanitizeThreadId(threadId));
		if (cached) {
			return cached;
		}
		const threadDir = this._threadDir(threadId);
		let entries: NonNullable<ILegacyIndexFile['entries']> = {};
		if (threadDir) {
			const text = await this._readIfExists(
				URI.joinPath(threadDir, 'index.json'),
			);
			if (text) {
				try {
					const parsed = JSON.parse(text) as ILegacyIndexFile;
					if (parsed && typeof parsed === 'object' && parsed.entries) {
						entries = parsed.entries;
					}
				} catch {
					/* malformed index — treat as empty */
				}
			}
		}
		this._legacyIndexes.set(sanitizeThreadId(threadId), entries);
		return entries;
	}

	private async _resolveMarkerBody(
		threadId: string,
		m: IStorableMessage,
		index: number,
	): Promise<{ body: string; hash: string } | null> {
		const refField = m.voidArchivedRef as IArchivedRef | undefined;
		if (
			refField &&
			typeof refField.f === 'string' &&
			isValidArchiveRef(refField.f)
		) {
			const body = await this.readArchivedMessage(threadId, refField.f);
			if (body !== null) {
				return { body, hash: refField.f.slice(0, -'.json'.length) };
			}
		}
		// v1 stubs carry no ref — resolve through the recovery index
		const entries = await this._legacyIndex(threadId);
		const entry = entries[String(index)];
		if (entry && isValidArchiveRef(entry.f)) {
			const body = await this.readArchivedMessage(threadId, entry.f);
			if (body !== null) {
				return { body, hash: entry.f.slice(0, -'.json'.length) };
			}
		}
		return null;
	}

	async restoreThreadMessages(
		threadId: string,
		messages: IStorableMessage[],
	): Promise<IRestoreThreadResult> {
		const out: IStorableMessage[] = [];
		let restored = 0;
		let unresolved = 0;
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			if (!m || !messageIsStubbed(m)) {
				out.push(m);
				continue;
			}
			const resolved = await this._resolveMarkerBody(threadId, m, i);
			const msg = resolved
				? parseArchivedMessage(resolved.body, resolved.hash, String(m.role))
				: null;
			if (msg) {
				out.push(this._reviveMarshalled(msg) as IStorableMessage);
				restored++;
			} else {
				out.push(m);
				unresolved++;
			}
		}
		return { messages: out, restored, unresolved };
	}

	/**
	 * The archived body serializes LIVE message objects, so marshalled URIs
	 * (`{$mid: 1, ...}`) come back as plain objects — revive them exactly like
	 * the store loader does, or restored selections/snapshots would carry
	 * dead shapes.
	 */
	private _reviveMarshalled(value: unknown): unknown {
		if (Array.isArray(value)) {
			return value.map((v) => this._reviveMarshalled(v));
		}
		if (value && typeof value === 'object') {
			const rec = value as Record<string, unknown>;
			if (rec['$mid'] === 1) {
				return URI.from(value as { scheme: string;[key: string]: unknown });
			}
			const out: Record<string, unknown> = {};
			for (const k of Object.keys(rec)) {
				out[k] = this._reviveMarshalled(rec[k]);
			}
			return out;
		}
		return value;
	}

	archiveRootFsPath(): string | undefined {
		return this._rootUri()?.fsPath;
	}
}

registerSingleton(
	IThreadArchiveService,
	ThreadArchiveService,
	InstantiationType.Delayed,
);
