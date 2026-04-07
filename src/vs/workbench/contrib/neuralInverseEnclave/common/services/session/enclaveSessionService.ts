/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # EnclaveSessionService
 *
 * Manages the cryptographic lifecycle of an IDE session within the Enclave.
 *
 * ## What Is a Session?
 * A session begins when the IDE window opens and ends when it closes. Every action,
 * every audit entry, every commit, every build happens within a session.
 *
 * ## Session Proof Structure
 * Each session produces two records, both signed by the Enclave's private key:
 *
 * **Session Start Record:**
 * ```json
 * {
 *   "sessionId": "ses_lxyz123_abc456",
 *   "startedAt": 1712345678000,
 *   "platform": { "os": "darwin", "arch": "arm64", "nodeVersion": "...", "ideVersion": "..." },
 *   "enclaveFingerprint": "ni-enc-a3f9c201",
 *   "previousSessionId": "ses_...",   // chain to previous session
 *   "signature": "base64url..."
 * }
 * ```
 *
 * **Session End Record:**
 * ```json
 * {
 *   "sessionId": "ses_lxyz123_abc456",
 *   "endedAt": 1712349278000,
 *   "durationMs": 3600000,
 *   "totalActionCount": 1547,
 *   "auditEntryCount": 243,
 *   "finalAuditHash": "sha256...",   // hash of the last audit entry hash (seals the chain)
 *   "enclaveFingerprint": "ni-enc-a3f9c201",
 *   "shutdownReason": "normal" | "crash" | "kill",
 *   "signature": "base64url..."
 * }
 * ```
 *
 * These records are stored in `.inverse/sessions/` and are the root of the trust chain.
 * Every audit entry references its sessionId. A verifier can follow:
 *   Session Start → Audit Entries → Session End → Commit Proofs → Build Proofs
 *
 * ## Storage
 * Session records are persisted in workspace storage as JSONL files under
 * `.inverse/sessions/session-{YYYY-MM-DD}.jsonl`.
 */

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { ILifecycleService } from '../../../../../services/lifecycle/common/lifecycle.js';
import { IEnclaveCryptoService } from '../crypto/enclaveCryptoService.js';
import { IEnclaveEnvironmentService, EnclaveMode } from '../environment/enclaveEnvironmentService.js';

export const IEnclaveSessionService = createDecorator<IEnclaveSessionService>('enclaveSessionService');

// ─── Public Interfaces ────────────────────────────────────────────────────────

export interface ISessionPlatformInfo {
	os: string;
	arch: string;
	nodeVersion: string;
	ideVersion: string;
}

export interface ISessionStartRecord {
	readonly type: 'session_start';
	readonly sessionId: string;
	readonly startedAt: number;
	readonly platform: ISessionPlatformInfo;
	readonly enclaveMode: EnclaveMode;
	readonly enclaveFingerprint: string;
	readonly previousSessionId: string | null;
	readonly signature: string;
	readonly publicKeyJwk: JsonWebKey;
}

export interface ISessionEndRecord {
	readonly type: 'session_end';
	readonly sessionId: string;
	readonly startedAt: number;
	readonly endedAt: number;
	readonly durationMs: number;
	readonly totalActionCount: number;
	readonly auditEntryCount: number;
	readonly finalAuditHash: string;
	readonly enclaveFingerprint: string;
	readonly shutdownReason: 'normal' | 'crash' | 'kill' | 'unknown';
	readonly signature: string;
}

export interface IEnclaveSessionService {
	readonly _serviceBrand: undefined;

	/**
	 * The current session ID — stable for the lifetime of this IDE window.
	 * Always available synchronously — generated before the crypto service is ready.
	 */
	readonly sessionId: string;

	/**
	 * The timestamp when this session started.
	 */
	readonly sessionStartedAt: number;

	/**
	 * The start record for this session (signed). Available after crypto is ready.
	 * null if not yet committed.
	 */
	readonly startRecord: ISessionStartRecord | null;

	/**
	 * Commit the session-end record. Called on IDE shutdown.
	 * @param auditEntryCount — How many audit entries were logged this session
	 * @param finalAuditHash — The hash of the last audit entry (seals the chain)
	 */
	commitEndRecord(auditEntryCount: number, finalAuditHash: string): Promise<void>;

	/**
	 * Export the current session's start record as a JSON string for bundling.
	 */
	exportStartRecord(): string | null;
}

// ─── Storage Key ─────────────────────────────────────────────────────────────

const STORAGE_FOLDER = '.inverse/sessions';
const PREVIOUS_SESSION_KEY = 'neuralInverse.enclave.session.previousSessionId';

// ─── Implementation ───────────────────────────────────────────────────────────

export class EnclaveSessionService extends Disposable implements IEnclaveSessionService {
	declare readonly _serviceBrand: undefined;

	private readonly _sessionId: string;
	private readonly _sessionStartedAt: number;
	private _startRecord: ISessionStartRecord | null = null;
	private _actionCount: number = 0;

	constructor(
		@IEnclaveCryptoService private readonly cryptoService: IEnclaveCryptoService,
		@IEnclaveEnvironmentService private readonly enclaveEnv: IEnclaveEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
	) {
		super();

		// Session ID is always available immediately — generated synchronously
		this._sessionId = this._generateSessionId();
		this._sessionStartedAt = Date.now();

		// Commit the signed start record once the crypto service is ready
		if (this.cryptoService.isReady) {
			this._commitStartRecord().catch(err => console.error('[Enclave Session] Failed to commit start record:', err));
		} else {
			this._register(this.cryptoService.onReady(() => {
				this._commitStartRecord().catch(err => console.error('[Enclave Session] Failed to commit start record:', err));
			}));
		}

		// Hook shutdown to commit the end record
		this._register(this.lifecycleService.onBeforeShutdown(e => {
			e.veto(
				this.commitEndRecord(this._actionCount, '').then(() => false),
				'enclaveSessionService.commitEndRecord'
			);
		}));

		console.log(`[Enclave Session] Service initialized. Session ID: ${this._sessionId}`);
	}

	// ─── Public API ───────────────────────────────────────────────────────────

	public get sessionId(): string {
		return this._sessionId;
	}

	public get sessionStartedAt(): number {
		return this._sessionStartedAt;
	}

	public get startRecord(): ISessionStartRecord | null {
		return this._startRecord;
	}

	public incrementActionCount(): void {
		this._actionCount++;
	}

	public async commitEndRecord(auditEntryCount: number, finalAuditHash: string): Promise<void> {
		if (!this.cryptoService.isReady) {
			// Session ended before crypto was ready — write an unsigned record
			await this._persistRecord({
				type: 'session_end',
				sessionId: this._sessionId,
				startedAt: this._sessionStartedAt,
				endedAt: Date.now(),
				durationMs: Date.now() - this._sessionStartedAt,
				totalActionCount: this._actionCount,
				auditEntryCount,
				finalAuditHash,
				enclaveFingerprint: 'unavailable',
				shutdownReason: 'unknown',
				signature: 'crypto-unavailable',
			});
			return;
		}

		const endedAt = Date.now();
		const payload = JSON.stringify({
			sessionId: this._sessionId,
			startedAt: this._sessionStartedAt,
			endedAt,
			durationMs: endedAt - this._sessionStartedAt,
			totalActionCount: this._actionCount,
			auditEntryCount,
			finalAuditHash,
			enclaveFingerprint: this.cryptoService.enclaveFingerprint,
		});

		const signature = await this.cryptoService.sign(payload);

		const endRecord: ISessionEndRecord = {
			type: 'session_end',
			sessionId: this._sessionId,
			startedAt: this._sessionStartedAt,
			endedAt,
			durationMs: endedAt - this._sessionStartedAt,
			totalActionCount: this._actionCount,
			auditEntryCount,
			finalAuditHash,
			enclaveFingerprint: this.cryptoService.enclaveFingerprint,
			shutdownReason: 'normal',
			signature,
		};

		await this._persistRecord(endRecord);
		console.log(`[Enclave Session] Session end committed. Duration: ${Math.round(endRecord.durationMs / 1000)}s, Actions: ${this._actionCount}`);
	}

	public exportStartRecord(): string | null {
		if (!this._startRecord) { return null; }
		return JSON.stringify(this._startRecord, null, 2);
	}

	// ─── Private Helpers ──────────────────────────────────────────────────────

	private async _commitStartRecord(): Promise<void> {
		const platform = this._capturePlatformInfo();
		const previousSessionId = this._getPreviousSessionId();

		const payload = JSON.stringify({
			type: 'session_start',
			sessionId: this._sessionId,
			startedAt: this._sessionStartedAt,
			platform,
			enclaveMode: this.enclaveEnv.mode,
			enclaveFingerprint: this.cryptoService.enclaveFingerprint,
			previousSessionId,
		});

		const signature = await this.cryptoService.sign(payload);
		const publicKeyJwk = await this.cryptoService.exportPublicKeyJwk();

		this._startRecord = {
			type: 'session_start',
			sessionId: this._sessionId,
			startedAt: this._sessionStartedAt,
			platform,
			enclaveMode: this.enclaveEnv.mode,
			enclaveFingerprint: this.cryptoService.enclaveFingerprint,
			previousSessionId,
			signature,
			publicKeyJwk,
		};

		// Store current session ID as the previous for the next session
		this._savePreviousSessionId(this._sessionId);

		await this._persistRecord(this._startRecord);
		console.log(`[Enclave Session] Session start committed. Fingerprint: ${this.cryptoService.enclaveFingerprint}`);
	}

	private async _persistRecord(record: ISessionStartRecord | ISessionEndRecord): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return; }

		const dateStr = new Date(this._sessionStartedAt).toISOString().split('T')[0];
		const fileUri = URI.joinPath(folders[0].uri, STORAGE_FOLDER, `session-${dateStr}.jsonl`);
		const line = JSON.stringify(record) + '\n';

		try {
			let existing = '';
			try {
				const content = await this.fileService.readFile(fileUri);
				existing = content.value.toString();
			} catch { /* file doesn't exist yet */ }

			await this.fileService.writeFile(fileUri, VSBuffer.fromString(existing + line));
		} catch (err) {
			console.warn('[Enclave Session] Failed to persist record (non-fatal):', err);
		}
	}

	private _capturePlatformInfo(): ISessionPlatformInfo {
		return {
			os: (typeof process !== 'undefined' ? process.platform : navigator.platform) || 'unknown',
			arch: (typeof process !== 'undefined' ? process.arch : 'unknown') || 'unknown',
			nodeVersion: (typeof process !== 'undefined' ? process.version : 'n/a') || 'n/a',
			ideVersion: (typeof (globalThis as any).__ideVersion !== 'undefined'
				? (globalThis as any).__ideVersion
				: 'unknown'),
		};
	}

	private _getPreviousSessionId(): string | null {
		// Stored in global app storage so it persists between workspace opens
		try {
			return sessionStorage.getItem(PREVIOUS_SESSION_KEY);
		} catch { return null; }
	}

	private _savePreviousSessionId(sessionId: string): void {
		try {
			sessionStorage.setItem(PREVIOUS_SESSION_KEY, sessionId);
		} catch { /* no-op */ }
	}

	private _generateSessionId(): string {
		const ts = Date.now().toString(36);
		const rand = Math.random().toString(36).substring(2, 8);
		return `ses_${ts}_${rand}`;
	}
}

registerSingleton(IEnclaveSessionService, EnclaveSessionService, InstantiationType.Eager);
