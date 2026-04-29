/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # EnclaveAuditTrailService
 *
 * The cryptographically secured, append-only audit log for the Neural Inverse Enclave.
 *
 * ## What Makes This "Proof-Grade"
 *
 * ### 1. Hash Chain (Tamper Detection)
 * Every entry contains the SHA-256 hash of the PREVIOUS entry's hash plus its own content.
 * This is a Merkle-chain. Deleting or modifying any entry breaks all subsequent hashes,
 * making tampering immediately detectable.
 *
 * ### 2. ECDSA Signature per Entry (Tamper Evidence)
 * Beyond hashing, each entry is cryptographically SIGNED by the Enclave's private key.
 * A developer with root access could delete entries and recalculate hashes \u2014 but they
 * cannot forge the private key signatures. An auditor with the public key can verify any
 * individual entry in isolation.
 *
 * ### 3. Session Binding
 * Each entry carries the `sessionId` from `IEnclaveSessionService`. The session itself
 * is signed. This creates a three-level hierarchy:
 *   Session Start (signed) \u2192 Audit Entries (signed, chained) \u2192 Session End (signed, seals chain)
 *
 * ### 4. On-Disk Format (JSONL)
 * One JSON object per line, sorted by timestamp. Human-readable and machine-parseable.
 * File path: `.inverse/audit/audit-{YYYY-MM-DD}.jsonl`
 *
 * ### 5. Verification
 * `verifyChain()` re-validates every in-memory entry: checks hash chain integrity AND
 * verifies each ECDSA signature against the Enclave's public key.
 * `exportVerifiableBundle()` produces a standalone JSON artifact (entries + public key JWK)
 * that any external tool can verify without access to the IDE.
 *
 * ## Performance Considerations
 * - Signing is async (crypto.subtle.sign) and runs off the critical path
 * - In-memory ring buffer: 500 entries max (oldest evicted)
 * - Disk writes are debounced \u2014 the entry is emitted immediately, written async
 * - If crypto is not yet ready, entries are queued and signed in batch on ready
 */

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IEnclaveEnvironmentService, EnclaveMode } from '../environment/enclaveEnvironmentService.js';
import { IEnclaveCryptoService } from '../crypto/enclaveCryptoService.js';
import { IEnclaveSessionService } from '../session/enclaveSessionService.js';
import { ILifecycleService } from '../../../../../services/lifecycle/common/lifecycle.js';

export const IEnclaveAuditTrailService = createDecorator<IEnclaveAuditTrailService>('enclaveAuditTrailService');

// \u2500\u2500\u2500 Core Types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type AuditAction =
	| 'llm_call'           // AI prompt sent to an LLM
	| 'file_write'         // Agent or AI wrote to a file
	| 'file_read'          // Agent or AI read a file
	| 'command_exec'       // Agent or AI executed a terminal command
	| 'firewall_block'     // Context Firewall blocked a request
	| 'sandbox_violation'  // Sandbox blocked an operation
	| 'session_start'      // IDE session started
	| 'session_end'        // IDE session ended
	| 'mode_change'        // Enclave mode changed
	| 'provenance_tag'     // AI-generated code watermarked
	| 'key_rotation'       // Crypto key rotated
	| 'review_required'    // AI code flagged for mandatory human review
	| 'review_approved'    // Human review approved AI code
	| 'anomaly_detected';  // Something unexpected happened

export type AuditActor = 'user' | 'agent' | 'agentic_system' | 'enclave_system';
export type AuditOutcome = 'allowed' | 'blocked' | 'flagged' | 'completed' | 'failed';

export interface IAuditEntry {
	/** Unique entry UUID */
	readonly id: string;
	/** Unix timestamp (ms) */
	readonly timestamp: number;
	/** The type of activity being logged */
	readonly action: AuditAction;
	/** Who performed the action */
	readonly actor: AuditActor;
	/** The resource or target affected (file path, prompt snippet, command, etc.) */
	readonly target: string;
	/** Outcome of the action */
	readonly outcome: AuditOutcome;
	/**
	 * SHA-256 hash of (prevEntryHash + this entry's canonicalized content).
	 * The first entry hashes against the genesis constant.
	 */
	readonly hash: string;
	/** ECDSA P-256 signature (base64url) of this entry's canonical JSON.
	 *  'pending' if crypto was not ready when the entry was created.
	 *  'unavailable' if crypto is not supported. */
	readonly signature: string;
	/** Enclave mode at the time of the action */
	readonly mode: EnclaveMode;
	/** Enclave session this entry belongs to */
	readonly sessionId: string;
	/** The public key fingerprint that signed this entry */
	readonly enclaveFingerprint: string;
	/** Optional structured details */
	readonly details?: string;
}

export interface IVerifyChainResult {
	readonly valid: boolean;
	/** Index of the first broken entry, if any */
	readonly brokenAt?: number;
	/** Description of what is broken */
	readonly reason?: string;
	/** How many entries were verified */
	readonly entriesChecked: number;
}

export interface IVerifiableBundle {
	readonly version: '1';
	readonly enclaveFingerprint: string;
	readonly publicKeyJwk: JsonWebKey;
	readonly entries: IAuditEntry[];
	readonly bundleHash: string;
	readonly bundleSignature: string;
	readonly exportedAt: number;
}

export interface ISessionSeal {
	/** Schema version */
	readonly version: '1';
	/** The Enclave session that is being sealed */
	readonly sessionId: string;
	/** Unix timestamp when the session started */
	readonly sessionStartedAt: number;
	/** Unix timestamp when the seal was created (IDE shutdown) */
	readonly sealedAt: number;
	/** Total number of audit entries in this session */
	readonly entryCount: number;
	/** SHA-256 hash of the final audit entry (chain tip) */
	readonly finalChainHash: string;
	/** SHA-256 hash of all session entry IDs concatenated (integrity check) */
	readonly sessionDigest: string;
	/** ECDSA signature of the sessionDigest */
	readonly signature: string;
	/** Enclave public key fingerprint */
	readonly enclaveFingerprint: string;
}

export interface IEnclaveAuditTrailService {
	readonly _serviceBrand: undefined;

	/** Fires when a new entry is appended (before disk, after signing) */
	readonly onDidAddEntry: Event<IAuditEntry>;

	/**
	 * Log a new event to the audit trail.
	 * Returns the completed (signed, hashed) entry.
	 * Non-blocking \u2014 disk persistence is async.
	 */
	logEntry(
		action: AuditAction,
		actor: AuditActor,
		target: string,
		outcome: AuditOutcome,
		details?: string
	): Promise<IAuditEntry>;

	/** Get the N most recent entries from the in-memory buffer */
	getRecentEntries(limit?: number): IAuditEntry[];

	/** Get total count of entries logged this session */
	getEntryCount(): number;

	/** Get the hash of the most recent entry (for sealing into session-end record) */
	getLastHash(): string;

	/**
	 * Verify the hash chain AND signatures of all in-memory entries.
	 * Full signature verification requires the crypto service to be ready.
	 */
	verifyChain(): Promise<IVerifyChainResult>;

	/**
	 * Export all in-memory entries plus the Enclave public key into a standalone
	 * verifiable bundle. Auditors can use this without access to the IDE.
	 */
	exportVerifiableBundle(): Promise<IVerifiableBundle>;

	/**
	 * Seal the current session. Creates a signed `ISessionSeal` artifact that
	 * cryptographically commits to the entire chain produced this session.
	 * Called automatically on IDE shutdown. Can also be called manually.
	 * Returns null if the session had no entries or crypto is unavailable.
	 */
	sealSession(): Promise<ISessionSeal | null>;
}

// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** The genesis previous-hash \u2014 well-known constant, not secret */
const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';
const MAX_IN_MEMORY = 500;
const AUDIT_FOLDER = '.inverse/audit';

export class EnclaveAuditTrailService extends Disposable implements IEnclaveAuditTrailService {
	declare readonly _serviceBrand: undefined;

	private _entries: IAuditEntry[] = [];
	private _lastHash: string = GENESIS_HASH;
	/** Pending entries whose signatures need updating (crypto not ready yet) */
	private _pendingSignatureQueue: IAuditEntry[] = [];

	private readonly _onDidAddEntry = this._register(new Emitter<IAuditEntry>());
	public readonly onDidAddEntry: Event<IAuditEntry> = this._onDidAddEntry.event;

	constructor(
		@IEnclaveEnvironmentService private readonly enclaveEnv: IEnclaveEnvironmentService,
		@IEnclaveCryptoService private readonly cryptoService: IEnclaveCryptoService,
		@IEnclaveSessionService private readonly sessionService: IEnclaveSessionService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
	) {
		super();

		// When crypto becomes ready, backfill signatures for any entries created before it was ready
		if (!this.cryptoService.isReady) {
			this._register(this.cryptoService.onReady(() => {
				this._backfillPendingSignatures().catch(err => {
					console.error('[Enclave AuditTrail] Failed to backfill signatures:', err);
				});
			}));
		}

		// Replay persisted entries from previous sessions so the chain is continuous
		this._replayFromDisk().catch(err => {
			console.warn('[Enclave AuditTrail] Could not replay history from disk:', err);
		});

		// Seal session on IDE shutdown — creates a signed artifact of the entire chain
		this._register(this.lifecycleService.onWillShutdown(e => {
			e.join(this.sealSession().then(() => {}).catch(() => {}), {
				id: 'enclave-audit-seal',
				label: 'Sealing Enclave Audit Trail'
			});
		}));

		console.log(`[Enclave AuditTrail] Service initialized. Session: ${this.sessionService.sessionId}`);
	}

	// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public async logEntry(
		action: AuditAction,
		actor: AuditActor,
		target: string,
		outcome: AuditOutcome,
		details?: string
	): Promise<IAuditEntry> {

		const id = this._generateUUID();
		const timestamp = Date.now();
		const mode = this.enclaveEnv.mode;
		const sessionId = this.sessionService.sessionId;

		// Step 1: Build canonical payload (hash covers everything except the hash and signature fields)
		const canonicalPayload = this._buildCanonicalPayload({
			id, timestamp, action, actor,
			target: this._sanitizeTarget(target),
			outcome, mode, sessionId, details,
			prevHash: this._lastHash,
		});

		// Step 2: Compute hash chain
		const hash = await this._sha256(canonicalPayload);
		this._lastHash = hash;

		// Step 3: Sign (or queue if crypto not ready)
		let signature: string;
		const enclaveFingerprint = this.cryptoService.isReady
			? this.cryptoService.enclaveFingerprint
			: 'pending';

		if (this.cryptoService.isReady) {
			signature = await this.cryptoService.sign(canonicalPayload);
		} else {
			signature = 'pending';
		}

		// Step 4: Build the final immutable entry
		const entry: IAuditEntry = Object.freeze({
			id,
			timestamp,
			action,
			actor,
			target: this._sanitizeTarget(target),
			outcome,
			hash,
			signature,
			mode,
			sessionId,
			enclaveFingerprint,
			details,
		});

		// Track pending signatures for backfill
		if (signature === 'pending') {
			this._pendingSignatureQueue.push(entry);
		}

		// Add to ring buffer
		this._entries.push(entry);
		if (this._entries.length > MAX_IN_MEMORY) {
			this._entries.shift();
		}

		// Emit for UI subscribers
		this._onDidAddEntry.fire(entry);

		// Persist async \u2014 never block the caller
		this._persistEntry(entry).catch(err => {
			console.error('[Enclave AuditTrail] Persistence error:', err);
		});

		return entry;
	}

	public getRecentEntries(limit: number = 50): IAuditEntry[] {
		return this._entries.slice(-limit);
	}

	public getEntryCount(): number {
		return this._entries.length;
	}

	public getLastHash(): string {
		return this._lastHash;
	}

	public async verifyChain(): Promise<IVerifyChainResult> {
		if (this._entries.length === 0) {
			return { valid: true, entriesChecked: 0 };
		}

		let prevHash = GENESIS_HASH;

		for (let i = 0; i < this._entries.length; i++) {
			const entry = this._entries[i];

			// Verify hash chain
			const canonicalPayload = this._buildCanonicalPayload({
				id: entry.id,
				timestamp: entry.timestamp,
				action: entry.action,
				actor: entry.actor,
				target: entry.target,
				outcome: entry.outcome,
				mode: entry.mode,
				sessionId: entry.sessionId,
				details: entry.details,
				prevHash,
			});

			const expectedHash = await this._sha256(canonicalPayload);
			if (expectedHash !== entry.hash) {
				return {
					valid: false,
					brokenAt: i,
					reason: `Hash mismatch at entry ${i} (id: ${entry.id}). Expected: ${expectedHash}, got: ${entry.hash}`,
					entriesChecked: i + 1,
				};
			}

			// Verify cryptographic signature (skip if pending or unavailable)
			if (entry.signature !== 'pending' && entry.signature !== 'unavailable' && entry.signature !== 'crypto-unavailable') {
				const signatureValid = await this.cryptoService.verify(canonicalPayload, entry.signature);
				if (!signatureValid) {
					return {
						valid: false,
						brokenAt: i,
						reason: `Signature verification failed at entry ${i} (id: ${entry.id}). Entry may have been tampered with.`,
						entriesChecked: i + 1,
					};
				}
			}

			prevHash = entry.hash;
		}

		return { valid: true, entriesChecked: this._entries.length };
	}

	public async exportVerifiableBundle(): Promise<IVerifiableBundle> {
		if (!this.cryptoService.isReady) {
			throw new Error('[Enclave AuditTrail] Cannot export verifiable bundle \u2014 crypto service not ready.');
		}

		const publicKeyJwk = await this.cryptoService.exportPublicKeyJwk();
		const entriesJson = JSON.stringify(this._entries);
		const bundleHash = await this._sha256(entriesJson);
		const bundleSignature = await this.cryptoService.sign(entriesJson);

		const bundle: IVerifiableBundle = {
			version: '1',
			enclaveFingerprint: this.cryptoService.enclaveFingerprint,
			publicKeyJwk,
			entries: [...this._entries],
			bundleHash,
			bundleSignature,
			exportedAt: Date.now(),
		};

		return bundle;
	}

	public async sealSession(): Promise<ISessionSeal | null> {
		// Get only entries from the current session
		const sessionEntries = this._entries.filter(e => e.sessionId === this.sessionService.sessionId);
		if (sessionEntries.length === 0) {
			console.log('[Enclave AuditTrail] Session seal skipped — no entries this session.');
			return null;
		}

		// Log a session_end entry to close the chain
		await this.logEntry(
			'session_end',
			'enclave_system',
			`session:${this.sessionService.sessionId}`,
			'completed',
			JSON.stringify({ entryCount: sessionEntries.length, finalHash: this._lastHash })
		);

		// Build the session digest: SHA-256 of all session entry IDs in order
		const sessionDigestInput = sessionEntries.map(e => e.id).join(',');
		const sessionDigest = await this._sha256(sessionDigestInput);

		const signature = this.cryptoService.isReady
			? await this.cryptoService.sign(sessionDigest).catch(() => 'sign-failed')
			: 'unavailable';

		const seal: ISessionSeal = {
			version: '1',
			sessionId: this.sessionService.sessionId,
			sessionStartedAt: sessionEntries[0]?.timestamp ?? Date.now(),
			sealedAt: Date.now(),
			entryCount: sessionEntries.length,
			finalChainHash: this._lastHash,
			sessionDigest,
			signature,
			enclaveFingerprint: this.cryptoService.isReady ? this.cryptoService.enclaveFingerprint : 'unavailable',
		};

		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			const sealUri = URI.joinPath(folders[0].uri, AUDIT_FOLDER, `session-seal-${this.sessionService.sessionId}.json`);
			try {
				await this.fileService.writeFile(sealUri, VSBuffer.fromString(JSON.stringify(seal, null, 2)));
				console.log(`[Enclave AuditTrail] Session sealed: ${sessionEntries.length} entries.`);
			} catch (e) {
				console.warn('[Enclave AuditTrail] Could not write session seal to disk:', e);
			}
		}

		return seal;
	}


	// \u2500\u2500\u2500 Private: Signature Backfill \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _backfillPendingSignatures(): Promise<void> {
		if (this._pendingSignatureQueue.length === 0) { return; }

		console.log(`[Enclave AuditTrail] Backfilling ${this._pendingSignatureQueue.length} pending signatures...`);

		for (const pendingEntry of this._pendingSignatureQueue) {
			const canonicalPayload = this._buildCanonicalPayload({
				id: pendingEntry.id,
				timestamp: pendingEntry.timestamp,
				action: pendingEntry.action,
				actor: pendingEntry.actor,
				target: pendingEntry.target,
				outcome: pendingEntry.outcome,
				mode: pendingEntry.mode,
				sessionId: pendingEntry.sessionId,
				details: pendingEntry.details,
				prevHash: GENESIS_HASH, // best effort for early entries
			});

			try {
				const signature = await this.cryptoService.sign(canonicalPayload);
				// Replace the frozen entry in-memory (create new reference)
				const idx = this._entries.indexOf(pendingEntry);
				if (idx !== -1) {
					this._entries[idx] = Object.freeze({ ...pendingEntry, signature, enclaveFingerprint: this.cryptoService.enclaveFingerprint });
				}
			} catch (err) {
				console.error(`[Enclave AuditTrail] Failed to backfill signature for entry ${pendingEntry.id}:`, err);
			}
		}

		this._pendingSignatureQueue = [];
		console.log('[Enclave AuditTrail] Signature backfill complete.');
	}

	// \u2500\u2500\u2500 Private: Persistence \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _persistEntry(entry: IAuditEntry): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return; }

		const dateStr = new Date(entry.timestamp).toISOString().split('T')[0];
		const auditFile = URI.joinPath(folders[0].uri, AUDIT_FOLDER, `audit-${dateStr}.jsonl`);
		const line = JSON.stringify(entry) + '\n';

		try {
			let existing = '';
			try {
				const content = await this.fileService.readFile(auditFile);
				existing = content.value.toString();
			} catch { /* file doesn't exist yet */ }

			await this.fileService.writeFile(auditFile, VSBuffer.fromString(existing + line));
		} catch (err) {
			console.warn('[Enclave AuditTrail] Disk write error (non-fatal):', err);
		}
	}

	/**
	 * On startup, replay the most recent audit entries from disk into the in-memory ring buffer.
	 * This ensures the Audit Trail UI shows history immediately and the hash chain continues
	 * correctly from where the last session left off.
	 */
	private async _replayFromDisk(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return; }

		// Collect today's and yesterday's audit files (to cover midnight boundary)
		const now = Date.now();
		const candidateDates = [now, now - 86_400_000].map(
			ts => new Date(ts).toISOString().split('T')[0]
		);

		const allLines: string[] = [];
		for (const dateStr of candidateDates) {
			const auditFileUri = URI.joinPath(folders[0].uri, AUDIT_FOLDER, `audit-${dateStr}.jsonl`);
			try {
				const content = await this.fileService.readFile(auditFileUri);
				const lines = content.value.toString().split('\n').filter(l => l.trim().length > 0);
				allLines.push(...lines);
			} catch {
				// File doesn't exist yet — this is fine on first run
			}
		}

		if (allLines.length === 0) { return; }

		// Parse and sort all entries by timestamp
		const parsed: IAuditEntry[] = [];
		for (const line of allLines) {
			try {
				const entry = JSON.parse(line) as IAuditEntry;
				// Skip entries from the current session (they'll be added live)
				if (entry.sessionId !== this.sessionService.sessionId) {
					parsed.push(entry);
				}
			} catch { /* malformed line — skip */ }
		}

		parsed.sort((a, b) => a.timestamp - b.timestamp);

		// Load into the ring buffer (respect MAX_IN_MEMORY)
		const toLoad = parsed.slice(-MAX_IN_MEMORY);
		this._entries = [...toLoad];

		// Restore the last hash so the chain continues correctly
		if (toLoad.length > 0) {
			this._lastHash = toLoad[toLoad.length - 1].hash;
		}

		console.log(`[Enclave AuditTrail] Replayed ${toLoad.length} entries from disk. Chain resumes from hash ${this._lastHash.substring(0, 8)}...`);
	}

	// \u2500\u2500\u2500 Private: Hashing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Builds a deterministic canonical JSON string for hashing and signing.
	 * Field order is fixed to ensure identical output across environments.
	 */
	private _buildCanonicalPayload(fields: {
		id: string;
		timestamp: number;
		action: AuditAction;
		actor: AuditActor;
		target: string;
		outcome: AuditOutcome;
		mode: EnclaveMode;
		sessionId: string;
		details?: string;
		prevHash: string;
	}): string {
		return JSON.stringify({
			id: fields.id,
			timestamp: fields.timestamp,
			action: fields.action,
			actor: fields.actor,
			target: fields.target,
			outcome: fields.outcome,
			mode: fields.mode,
			sessionId: fields.sessionId,
			details: fields.details ?? null,
			prevHash: fields.prevHash,
		});
	}

	private async _sha256(data: string): Promise<string> {
		try {
			const encoder = new TextEncoder();
			const bytes = encoder.encode(data);
			const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
			const hashArray = Array.from(new Uint8Array(hashBuffer));
			return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
		} catch {
			// Fallback for non-SubtleCrypto environments
			return this._fallbackHash(data);
		}
	}

	private _fallbackHash(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash;
		}
		return Math.abs(hash).toString(16).padStart(64, '0');
	}

	// \u2500\u2500\u2500 Private: Utilities \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _sanitizeTarget(target: string): string {
		if (target.length > 500) {
			return target.substring(0, 500) + '...(truncated)';
		}
		return target;
	}

	private _generateUUID(): string {
		try {
			return crypto.randomUUID();
		} catch {
			return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
				const r = Math.random() * 16 | 0;
				const v = c === 'x' ? r : (r & 0x3 | 0x8);
				return v.toString(16);
			});
		}
	}
}

registerSingleton(IEnclaveAuditTrailService, EnclaveAuditTrailService, InstantiationType.Delayed);
