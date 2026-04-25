/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # EnclaveFileIntegrityService
 *
 * Cryptographic integrity tracking for every source file the IDE touches.
 *
 * ## Purpose
 * In DO-178C, IEC 62304, ISO 26262, and NIST-800-171 regulated environments,
 * auditors need to answer:
 *   - "Was this file modified between code review and compilation?"
 *   - "Did an AI agent modify this file, or was it a human?"
 *   - "What was the exact SHA-256 of this file when the build was triggered?"
 *   - "Can we prove this file was not tampered with between commit and deployment?"
 *
 * ## File Lifecycle Events Tracked
 *
 * | Event           | Trigger                                          | Author tag |
 * |-----------------|--------------------------------------------------|------------|
 * | `resolve`       | File opened/resolved in editor                   | `unknown`  |
 * | `save`          | Human-initiated Ctrl+S or auto-save              | `human`    |
 * | `agent_write`   | AI agent explicitly writes via `recordAgentWrite`| `agent`    |
 * | `external`      | File changed outside IDE (watcher)               | `external` |
 *
 * ## AI vs Human Differentiation
 * The agent pipeline MUST call `recordAgentWrite(uri, agentId, newContent)` BEFORE
 * performing its write. This method:
 *   1. Captures the pre-write hash
 *   2. Computes the post-write hash from newContent
 *   3. Inserts the URI into `_pendingAgentWriteUris` Map<uriStr, agentId>
 *   4. So when `onDidSave` fires for that URI, it is correctly tagged `author: 'agent'`
 *
 * ## Record Structure
 * ```json
 * {
 *   "id": "uuid-v4",
 *   "uri": "file:///project/src/main.ts",
 *   "sessionId": "ses_lxyz123_abc456",
 *   "eventType": "save",
 *   "author": "human",
 *   "agentId": null,
 *   "prevHash": "sha256hex...",
 *   "newHash": "sha256hex...",
 *   "sizeBytes": 4096,
 *   "sizeDelta": 42,
 *   "timestamp": 1712345678000,
 *   "signature": "base64url..."
 * }
 * ```
 *
 * ## On-Disk Persistence
 * Append-only JSONL at `.inverse/integrity/file-integrity-{YYYY-MM-DD}.jsonl`
 * Writes are debounced at 2s to avoid thrashing on rapid saves.
 * A final sync flush happens on IDE shutdown.
 */

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import {
	ITextFileService,
	IResolvedTextFileEditorModel,
	snapshotToString,
} from '../../../../../services/textfile/common/textfiles.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IEnclaveCryptoService } from '../crypto/enclaveCryptoService.js';
import { IEnclaveSessionService } from '../session/enclaveSessionService.js';

export const IEnclaveFileIntegrityService = createDecorator<IEnclaveFileIntegrityService>('enclaveFileIntegrityService');

// \u2500\u2500\u2500 Public Types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type FileIntegrityEventType = 'resolve' | 'save' | 'agent_write' | 'external';
export type FileIntegrityAuthor = 'human' | 'agent' | 'external' | 'unknown';

export interface IFileIntegrityRecord {
	/** Unique record ID (UUIDv4) */
	readonly id: string;
	/** Stringified URI of the file */
	readonly uri: string;
	/** Session ID this event belongs to */
	readonly sessionId: string;
	/** What triggered this record */
	readonly eventType: FileIntegrityEventType;
	/** Who caused this change */
	readonly author: FileIntegrityAuthor;
	/** Agent ID if author === 'agent', null otherwise */
	readonly agentId: string | null;
	/** SHA-256 of file content BEFORE this event (null for first 'resolve') */
	readonly prevHash: string | null;
	/** SHA-256 of file content AT this event */
	readonly newHash: string;
	/** File size in bytes at this event */
	readonly sizeBytes: number;
	/** Byte delta from previous event (null for first 'resolve') */
	readonly sizeDelta: number | null;
	/** Unix timestamp ms */
	readonly timestamp: number;
	/**
	 * ECDSA P-256 signature of the canonical JSON payload.
	 * 'pending' = crypto not yet ready at record creation time.
	 * 'unavailable' = no crypto support in environment.
	 */
	readonly signature: string;
}

export interface IFileIntegrityState {
	/** SHA-256 of the file content as first seen this session */
	readonly openHash: string;
	/** SHA-256 of the most recent content we have computed */
	currentHash: string;
	/** Size in bytes at last known state */
	currentSizeBytes: number;
	/** Author of the last modification */
	lastAuthor: FileIntegrityAuthor;
	/** Total human save count this session */
	humanSaveCount: number;
	/** Total agent write count this session */
	agentWriteCount: number;
	/** True if ANY agent has modified this file this session */
	hasAiModifications: boolean;
}

export interface IEnclaveFileIntegrityService {
	readonly _serviceBrand: undefined;

	/** Fires whenever a file integrity record is created */
	readonly onDidRecordIntegrity: Event<IFileIntegrityRecord>;

	/**
	 * MUST be called by the AI agent pipeline BEFORE the actual file write occurs.
	 *
	 * This method:
	 *  - reads the current (pre-write) content hash
	 *  - registers the URI as a pending agent write so the next `onDidSave` is
	 *    correctly tagged `author: 'agent'`
	 *  - creates and signs a 'agent_write' integrity record
	 *
	 * @param uri \u2014 The target file being written
	 * @param agentId \u2014 Identifier of the AI agent making this write
	 * @param incomingContent \u2014 The content the agent is writing (for post-write hash)
	 * @returns The signed integrity record
	 */
	recordAgentWrite(uri: URI, agentId: string, incomingContent: string): Promise<IFileIntegrityRecord>;

	/**
	 * Get the current tracked integrity state for a file.
	 * Returns null if the file has not been seen this session.
	 */
	getFileState(uri: URI): IFileIntegrityState | null;

	/**
	 * Get all in-memory integrity records for a specific file.
	 */
	getRecordsForFile(uri: URI): IFileIntegrityRecord[];

	/**
	 * Get the list of file URI strings that have been modified by AI agents this session.
	 */
	getAiModifiedFiles(): string[];

	/** Total number of records tracked in-memory this session */
	getRecordCount(): number;

	/**
	 * Utility: compute a SHA-256 hex string of any content string.
	 * Exposed so other services (e.g. ProvisionService, CommitService) can reuse.
	 */
	computeHash(content: string): Promise<string>;
}

// \u2500\u2500\u2500 Implementation Constants \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const INTEGRITY_FOLDER = '.inverse/integrity';
const MAX_IN_MEMORY_RECORDS = 2000;
const LARGE_FILE_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10MB \u2014 use stat-fingerprint
const FLUSH_DEBOUNCE_MS = 2000;

// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class EnclaveFileIntegrityService extends Disposable implements IEnclaveFileIntegrityService {
	declare readonly _serviceBrand: undefined;

	/** In-memory ring-buffer of all records this session */
	private readonly _records: IFileIntegrityRecord[] = [];

	/** Per-file state map: uriStr \u2192 IFileIntegrityState */
	private readonly _fileStates = new Map<string, IFileIntegrityState>();

	/**
	 * Pending agent writes: uriStr \u2192 agentId
	 *
	 * Set by `recordAgentWrite()` BEFORE a write occurs.
	 * Consumed and deleted by `_onDidSave()` so the save event is tagged 'agent'.
	 */
	private readonly _pendingAgentWriteUris = new Map<string, string>();

	/** Disk-flush write buffer */
	private _pendingFlush: IFileIntegrityRecord[] = [];
	private _flushTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly _onDidRecordIntegrity = this._register(new Emitter<IFileIntegrityRecord>());
	public readonly onDidRecordIntegrity: Event<IFileIntegrityRecord> = this._onDidRecordIntegrity.event;

	constructor(
		@IEnclaveCryptoService private readonly cryptoService: IEnclaveCryptoService,
		@IEnclaveSessionService private readonly sessionService: IEnclaveSessionService,
		@IFileService private readonly fileService: IFileService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._hookTextFileEvents();
		this._hookFileWatcher();
		console.log('[Enclave FileIntegrity] Service initialized.');
	}

	// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public async recordAgentWrite(uri: URI, agentId: string, incomingContent: string): Promise<IFileIntegrityRecord> {
		const uriKey = uri.toString();
		const state = this._fileStates.get(uriKey);

		// Capture previous hash from tracked state or by reading the file right now
		const prevHash = state?.currentHash ?? await this._readFileHash(uri);
		const prevSizeBytes = state?.currentSizeBytes ?? 0;

		// Hash the content BEING written
		const newHash = await this.computeHash(incomingContent);
		const sizeBytes = new TextEncoder().encode(incomingContent).byteLength;
		const sizeDelta = prevHash !== null ? sizeBytes - prevSizeBytes : null;

		// Mark this URI so the imminent onDidSave is tagged 'agent'
		this._pendingAgentWriteUris.set(uriKey, agentId);

		const record = await this._buildAndStoreRecord({
			uri,
			uriKey,
			eventType: 'agent_write',
			author: 'agent',
			agentId,
			prevHash,
			newHash,
			sizeBytes,
			sizeDelta,
		});

		// Update state immediately (don't wait for onDidSave)
		this._mutateFileState(uriKey, {
			newHash,
			sizeBytes,
			author: 'agent',
			agentId,
			openHash: state?.openHash,
		});

		return record;
	}

	public getFileState(uri: URI): IFileIntegrityState | null {
		return this._fileStates.get(uri.toString()) ?? null;
	}

	public getRecordsForFile(uri: URI): IFileIntegrityRecord[] {
		const uriStr = uri.toString();
		return this._records.filter(r => r.uri === uriStr);
	}

	public getAiModifiedFiles(): string[] {
		const result: string[] = [];
		for (const [uriStr, state] of this._fileStates) {
			if (state.hasAiModifications) {
				result.push(uriStr);
			}
		}
		return result;
	}

	public getRecordCount(): number {
		return this._records.length;
	}

	public async computeHash(content: string): Promise<string> {
		return this._sha256(new TextEncoder().encode(content).buffer as ArrayBuffer);
	}

	// \u2500\u2500\u2500 Private: Text File Event Hooks \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookTextFileEvents(): void {

		// \u2500\u2500 onDidResolve \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		// Fires when a file model is resolved (opened for the first time in-editor).
		this._register(this.textFileService.files.onDidResolve(async e => {
			const { model } = e;
			const uri = model.resource;
			const uriKey = uri.toString();

			// Only capture the first resolve this session
			if (this._fileStates.has(uriKey)) { return; }

			const textContent = this._extractTextContent(model);
			if (textContent === null) {
				// Model not yet resolved to a text model \u2014 hash from disk instead
				const hash = await this._readFileHash(uri);
				const sizeBytes = await this._readFileSizeBytes(uri);
				if (!hash) { return; }

				await this._buildAndStoreRecord({
					uri, uriKey,
					eventType: 'resolve',
					author: 'unknown',
					agentId: null,
					prevHash: null,
					newHash: hash,
					sizeBytes,
					sizeDelta: null,
				});

				this._mutateFileState(uriKey, {
					newHash: hash,
					sizeBytes,
					author: 'unknown',
					agentId: null,
					openHash: hash,
				});
				return;
			}

			const newHash = await this.computeHash(textContent);
			const sizeBytes = new TextEncoder().encode(textContent).byteLength;

			await this._buildAndStoreRecord({
				uri, uriKey,
				eventType: 'resolve',
				author: 'unknown',
				agentId: null,
				prevHash: null,
				newHash,
				sizeBytes,
				sizeDelta: null,
			});

			this._mutateFileState(uriKey, {
				newHash,
				sizeBytes,
				author: 'unknown',
				agentId: null,
				openHash: newHash,
			});
		}));

		// \u2500\u2500 onDidSave \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		// Fires after every successful file save (human Ctrl+S, auto-save, agent).
		this._register(this.textFileService.files.onDidSave(async e => {
			const { model } = e;
			const uri = model.resource;
			const uriKey = uri.toString();

			// Determine author \u2014 was this save triggered by an agent write?
			const agentId = this._pendingAgentWriteUris.get(uriKey) ?? null;
			const author: FileIntegrityAuthor = agentId ? 'agent' : 'human';
			// Always consume the pending tag, even if we abort below
			if (agentId) {
				this._pendingAgentWriteUris.delete(uriKey);
			}

			// For agent_write events, we already recorded via recordAgentWrite().
			// The onDidSave here would be a duplicate \u2014 skip it.
			if (author === 'agent') { return; }

			const textContent = this._extractTextContent(model);
			let newHash: string;
			let sizeBytes: number;

			if (textContent !== null) {
				newHash = await this.computeHash(textContent);
				sizeBytes = new TextEncoder().encode(textContent).byteLength;
			} else {
				// Fall back to reading from disk \u2014 file was saved but model not in text state
				const diskHash = await this._readFileHash(uri);
				if (!diskHash) { return; }
				newHash = diskHash;
				sizeBytes = await this._readFileSizeBytes(uri);
			}

			const state = this._fileStates.get(uriKey);
			const prevHash = state?.currentHash ?? null;
			const sizeDelta = state ? sizeBytes - state.currentSizeBytes : null;

			// Skip if hash is identical (e.g. encoding-only save with no content change)
			if (prevHash === newHash) { return; }

			await this._buildAndStoreRecord({
				uri, uriKey,
				eventType: 'save',
				author: 'human',
				agentId: null,
				prevHash,
				newHash,
				sizeBytes,
				sizeDelta,
			});

			this._mutateFileState(uriKey, {
				newHash,
				sizeBytes,
				author: 'human',
				agentId: null,
				openHash: state?.openHash,
			});
		}));
	}

	// \u2500\u2500\u2500 Private: External File Watcher \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookFileWatcher(): void {
		// Fires when files change on disk outside the IDE (e.g. git checkout, build tool)
		this._register(this.fileService.onDidFilesChange(async e => {
			// Only process files we're already tracking
			for (const changed of e.rawUpdated) {
				// rawUpdated is an array of IFileChange \u2014 resource is the URI
				const uri = (changed as any).resource as URI | undefined;
				if (!uri?.path) { continue; }
				const uriKey = uri.toString();

				const state = this._fileStates.get(uriKey);
				if (!state) { continue; } // Not tracking this file \u2014 skip

				const newHash = await this._readFileHash(uri);
				if (!newHash || newHash === state.currentHash) { continue; }

				const sizeBytes = await this._readFileSizeBytes(uri);
				const sizeDelta = sizeBytes - state.currentSizeBytes;

				await this._buildAndStoreRecord({
					uri, uriKey,
					eventType: 'external',
					author: 'external',
					agentId: null,
					prevHash: state.currentHash,
					newHash,
					sizeBytes,
					sizeDelta,
				});

				this._mutateFileState(uriKey, {
					newHash,
					sizeBytes,
					author: 'external',
					agentId: null,
					openHash: state.openHash,
				});
			}
		}));
	}

	// \u2500\u2500\u2500 Private: Record Construction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _buildAndStoreRecord(params: {
		uri: URI;
		uriKey: string;
		eventType: FileIntegrityEventType;
		author: FileIntegrityAuthor;
		agentId: string | null;
		prevHash: string | null;
		newHash: string;
		sizeBytes: number;
		sizeDelta: number | null;
	}): Promise<IFileIntegrityRecord> {
		const id = this._uuid();
		const timestamp = Date.now();
		const sessionId = this.sessionService.sessionId;

		const canonicalPayload = JSON.stringify({
			id,
			uri: params.uriKey,
			sessionId,
			eventType: params.eventType,
			author: params.author,
			agentId: params.agentId,
			prevHash: params.prevHash,
			newHash: params.newHash,
			sizeBytes: params.sizeBytes,
			sizeDelta: params.sizeDelta,
			timestamp,
		});

		const signature = this.cryptoService.isReady
			? await this.cryptoService.sign(canonicalPayload).catch(() => 'sign-failed')
			: 'pending';

		const record: IFileIntegrityRecord = Object.freeze({
			id,
			uri: params.uriKey,
			sessionId,
			eventType: params.eventType,
			author: params.author,
			agentId: params.agentId,
			prevHash: params.prevHash,
			newHash: params.newHash,
			sizeBytes: params.sizeBytes,
			sizeDelta: params.sizeDelta,
			timestamp,
			signature,
		});

		// Ring-buffer append
		this._records.push(record);
		if (this._records.length > MAX_IN_MEMORY_RECORDS) {
			this._records.shift();
		}

		// Queue for disk flush
		this._pendingFlush.push(record);
		this._scheduleDiskFlush();

		this._onDidRecordIntegrity.fire(record);
		return record;
	}

	// \u2500\u2500\u2500 Private: State Mutation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _mutateFileState(
		uriKey: string,
		params: {
			newHash: string;
			sizeBytes: number;
			author: FileIntegrityAuthor;
			agentId: string | null;
			openHash?: string;
		}
	): void {
		const existing = this._fileStates.get(uriKey);
		const isAgent = params.author === 'agent';

		if (existing) {
			existing.currentHash = params.newHash;
			existing.currentSizeBytes = params.sizeBytes;
			existing.lastAuthor = params.author;
			if (params.author === 'human') { existing.humanSaveCount++; }
			if (isAgent) {
				existing.agentWriteCount++;
				existing.hasAiModifications = true;
			}
		} else {
			const openHash = params.openHash ?? params.newHash;
			this._fileStates.set(uriKey, {
				openHash,
				currentHash: params.newHash,
				currentSizeBytes: params.sizeBytes,
				lastAuthor: params.author,
				humanSaveCount: params.author === 'human' ? 1 : 0,
				agentWriteCount: isAgent ? 1 : 0,
				hasAiModifications: isAgent,
			});
		}
	}

	// \u2500\u2500\u2500 Private: Content Extraction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Safely extract text content from a file editor model.
	 * Returns null if the model is not yet resolved or the text model is unavailable.
	 */
	private _extractTextContent(model: ReturnType<typeof this.textFileService.files.get>): string | null {
		if (!model) { return null; }
		if (!model.isResolved()) { return null; }

		const resolved = model as IResolvedTextFileEditorModel;
		const textModel = resolved.textEditorModel;
		if (!textModel) { return null; }

		// For large files, use a snapshot (more efficient than getValue())
		const snapshot = resolved.createSnapshot();
		if (snapshot) {
			return snapshotToString(snapshot);
		}

		// Fallback: getValue() on the Monaco ITextModel
		return textModel.getValue();
	}

	// \u2500\u2500\u2500 Private: File Reading \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _readFileHash(uri: URI): Promise<string> {
		try {
			const stat = await this.fileService.stat(uri);
			if (stat.size > LARGE_FILE_THRESHOLD_BYTES) {
				// Use stat-based fingerprint for very large files to avoid UI blocking
				return `size-fingerprint:${stat.size}:${stat.mtime}`;
			}
			const file = await this.fileService.readFile(uri);
			return this._sha256(file.value.buffer as ArrayBuffer);
		} catch {
			return 'hash-unavailable';
		}
	}

	private async _readFileSizeBytes(uri: URI): Promise<number> {
		try {
			const stat = await this.fileService.stat(uri);
			return stat.size;
		} catch {
			return 0;
		}
	}

	// \u2500\u2500\u2500 Private: SHA-256 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _sha256(buffer: ArrayBuffer): Promise<string> {
		try {
			const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
			return Array.from(new Uint8Array(hashBuffer))
				.map(b => b.toString(16).padStart(2, '0'))
				.join('');
		} catch {
			// Fallback (non-SubtleCrypto environments \u2014 should not occur in Electron)
			let hash = 0;
			const view = new Uint8Array(buffer);
			for (let i = 0; i < view.length; i++) {
				hash = ((hash << 5) - hash) + view[i];
				hash = hash & hash;
			}
			return Math.abs(hash).toString(16).padStart(64, '0');
		}
	}

	// \u2500\u2500\u2500 Private: Disk Persistence \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _scheduleDiskFlush(): void {
		if (this._flushTimer) { clearTimeout(this._flushTimer); }
		this._flushTimer = setTimeout(() => {
			this._flushTimer = undefined;
			this._writeToDisk().catch(err => {
				console.error('[Enclave FileIntegrity] Disk flush error:', err);
			});
		}, FLUSH_DEBOUNCE_MS);
	}

	private async _writeToDisk(): Promise<void> {
		if (this._pendingFlush.length === 0) { return; }

		// Drain the buffer atomically
		const toWrite = this._pendingFlush.splice(0);

		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			// No workspace \u2014 re-queue for when a workspace becomes available
			this._pendingFlush.unshift(...toWrite);
			return;
		}

		const dateStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
		const fileUri = URI.joinPath(
			folders[0].uri,
			INTEGRITY_FOLDER,
			`file-integrity-${dateStr}.jsonl`
		);

		const lines = toWrite.map(r => JSON.stringify(r)).join('\n') + '\n';

		try {
			let existing = '';
			try {
				const content = await this.fileService.readFile(fileUri);
				existing = content.value.toString();
			} catch { /* file doesn't exist yet \u2014 normal on first write */ }

			await this.fileService.writeFile(fileUri, VSBuffer.fromString(existing + lines));
		} catch (err) {
			console.warn('[Enclave FileIntegrity] Write failed (will retry on next flush):', err);
			// Re-queue failed items so they are retried
			this._pendingFlush.unshift(...toWrite);
		}
	}

	// \u2500\u2500\u2500 Private: Utilities \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _uuid(): string {
		try {
			return crypto.randomUUID();
		} catch {
			// UUIDv4 fallback for environments without randomUUID
			return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
				const r = Math.random() * 16 | 0;
				const v = c === 'x' ? r : (r & 0x3 | 0x8);
				return v.toString(16);
			});
		}
	}

	public override dispose(): void {
		if (this._flushTimer) {
			clearTimeout(this._flushTimer);
			this._flushTimer = undefined;
		}
		// Best-effort synchronous flush \u2014 IDE is shutting down
		this._writeToDisk().catch(() => { /* no-op on shutdown */ });
		super.dispose();
	}
}

registerSingleton(IEnclaveFileIntegrityService, EnclaveFileIntegrityService, InstantiationType.Delayed);
