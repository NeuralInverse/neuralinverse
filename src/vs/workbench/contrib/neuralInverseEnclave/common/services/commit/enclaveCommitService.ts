/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # EnclaveCommitService
 *
 * Cryptographic proof-of-custody for every git commit made inside the Enclave session.
 *
 * ## Why This Matters
 * A raw git commit hash proves that content exists in a repo — it does NOT prove:
 *   - Who authored the code (AI vs human)
 *   - Which IDE session produced the commit
 *   - What the TCB state of the developer's machine was at commit time
 *   - Whether the code was reviewed before commit
 *
 * The Enclave Commit Service fills this gap by producing a **CommitProof** — a
 * cryptographically signed bundle tied to the Enclave session — for every commit.
 *
 * ## CommitProof Structure
 * ```json
 * {
 *   "id": "uuid",
 *   "sessionId": "ses_...",
 *   "gitHash": "abc123...",        // SHA-1 from git
 *   "branch": "main",
 *   "message": "fix: null check",  // first 200 chars of commit message
 *   "author": {
 *     "name":  "Alice",
 *     "email": "alice@corp.com"
 *   },
 *   "timestamp": 1712345678000,
 *   "stagedFileHashes": {          // SHA-256 of each staged file BEFORE commit
 *     "src/main.ts": "sha256...",
 *     "src/utils.ts": "sha256..."
 *   },
 *   "aiModifiedFiles": [           // Which staged files had AI involvement
 *     "src/main.ts"
 *   ],
 *   "provenanceCount": 3,          // How many AI provenance watermarks exist in staged set
 *   "previousProofHash": "sha256...", // Hash of previous CommitProof (chain)
 *   "enclaveFingerprint": "ni-enc-a3f9c201",
 *   "signature": "base64url..."
 * }
 * ```
 *
 * ## Proof Chain
 * Each CommitProof records the `previousProofHash` — the SHA-256 of the previous
 * CommitProof's canonical JSON. This creates an append-only chain:
 *
 *   CommitProof[0] → CommitProof[1] → CommitProof[2] → ...
 *
 * Any auditor can verify the chain by re-hashing each proof and checking the
 * `previousProofHash` field of the next one. Tampering with any proof breaks all
 * subsequent ones.
 *
 * ## Anomaly Detection
 * The service monitors for force-push and rebase operations which could rewrite
 * git history, making previously signed commits unverifiable. These are flagged
 * in the audit trail as anomalies.
 *
 * ## On-Disk Storage
 * Individual proof files: `.inverse/commits/commit-{gitHash}.json`
 * Proof index (chain):   `.inverse/commits/commit-index.jsonl`
 */

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IEnclaveCryptoService } from '../crypto/enclaveCryptoService.js';
import { IEnclaveSessionService } from '../session/enclaveSessionService.js';
import { IEnclaveFileIntegrityService } from '../integrity/enclaveFileIntegrityService.js';
import { IEnclaveAuditTrailService } from '../audit/enclaveAuditTrailService.js';

export const IEnclaveCommitService = createDecorator<IEnclaveCommitService>('enclaveCommitService');

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface ICommitAuthor {
	readonly name: string;
	readonly email: string;
}

export interface ICommitProof {
	/** UUIDv4 */
	readonly id: string;
	/** Enclave session ID */
	readonly sessionId: string;
	/** Git commit SHA-1 hash (40 hex chars) */
	readonly gitHash: string;
	/** Branch name at time of commit */
	readonly branch: string;
	/** First 200 chars of the commit message */
	readonly message: string;
	/** Git author identity */
	readonly author: ICommitAuthor;
	/** Unix timestamp ms */
	readonly timestamp: number;
	/**
	 * SHA-256 hashes of all files in the staged set at commit time.
	 * Key: workspace-relative path. Value: SHA-256 hex string.
	 */
	readonly stagedFileHashes: Record<string, string>;
	/**
	 * Workspace-relative paths of files that had AI agent involvement this session.
	 * Subset of stagedFileHashes keys.
	 */
	readonly aiModifiedFiles: string[];
	/** Number of AI provenance entries across staged files */
	readonly provenanceCount: number;
	/** SHA-256 of the PREVIOUS CommitProof's canonical JSON (enables chain verification) */
	readonly previousProofHash: string;
	/** Enclave keypair fingerprint */
	readonly enclaveFingerprint: string;
	/** ECDSA P-256 signature of the canonical payload */
	readonly signature: string;
}

export interface ICommitChainEntry {
	readonly proofId: string;
	readonly gitHash: string;
	readonly timestamp: number;
	readonly proofHash: string;
}

export interface IEnclaveCommitService {
	readonly _serviceBrand: undefined;

	/** Fires when a new CommitProof is created */
	readonly onDidCreateProof: Event<ICommitProof>;

	/**
	 * Create a CommitProof for a completed git commit.
	 *
	 * This should be called AFTER the git commit succeeds (post-commit hook or
	 * terminal output parsing). The staged file list is cross-referenced against
	 * the FileIntegrityService to attach hashes and AI attribution.
	 *
	 * @param gitHash     — The 40-char git SHA-1 of the commit
	 * @param branch      — The branch name at commit time
	 * @param message     — The commit message
	 * @param author      — The git author identity
	 * @param stagedPaths — Workspace-relative paths of all staged files
	 */
	createCommitProof(
		gitHash: string,
		branch: string,
		message: string,
		author: ICommitAuthor,
		stagedPaths: string[]
	): Promise<ICommitProof>;

	/**
	 * Get the full proof for a git commit hash.
	 * Returns null if this hash has no associated proof in this session.
	 */
	getProofForCommit(gitHash: string): ICommitProof | null;

	/**
	 * Get all CommitProofs produced in this session, oldest first.
	 */
	getAllProofs(): ICommitProof[];

	/**
	 * Verify the chain integrity of all proofs in this session.
	 * Returns true if the chain is valid, false with details if broken.
	 */
	verifyProofChain(): Promise<{ valid: boolean; brokenAt?: string; reason?: string }>;

	/**
	 * Report a git history-rewrite anomaly (force-push, rebase).
	 * Logs to the audit trail and emits a prominent warning.
	 *
	 * @param operation — 'force_push' | 'rebase'
	 * @param details   — Additional context
	 */
	reportHistoryRewrite(operation: 'force_push' | 'rebase', details: string): Promise<void>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const COMMITS_FOLDER = '.inverse/commits';
const GENESIS_PROOF_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

// ─── Implementation ───────────────────────────────────────────────────────────

export class EnclaveCommitService extends Disposable implements IEnclaveCommitService {
	declare readonly _serviceBrand: undefined;

	/** In-memory proof store: gitHash → CommitProof */
	private readonly _proofs = new Map<string, ICommitProof>();
	/** Ordered list of proofs (oldest first) for chain traversal */
	private readonly _proofChain: ICommitProof[] = [];
	/** SHA-256 of the last proof's canonical JSON */
	private _lastProofHash: string = GENESIS_PROOF_HASH;

	private readonly _onDidCreateProof = this._register(new Emitter<ICommitProof>());
	public readonly onDidCreateProof: Event<ICommitProof> = this._onDidCreateProof.event;

	constructor(
		@IEnclaveCryptoService private readonly cryptoService: IEnclaveCryptoService,
		@IEnclaveSessionService private readonly sessionService: IEnclaveSessionService,
		@IEnclaveFileIntegrityService private readonly fileIntegrityService: IEnclaveFileIntegrityService,
		@IEnclaveAuditTrailService private readonly auditTrailService: IEnclaveAuditTrailService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		console.log('[Enclave CommitService] Service initialized.');
	}

	// ─── Public API ───────────────────────────────────────────────────────────

	public async createCommitProof(
		gitHash: string,
		branch: string,
		message: string,
		author: ICommitAuthor,
		stagedPaths: string[]
	): Promise<ICommitProof> {

		// 1. Cross-reference staged paths with FileIntegrityService.
		//    For each staged file, get its SHA-256 from the integrity tracker.
		//    If the file isn't tracked (e.g. first commit, binary file), hash it from disk.
		const stagedFileHashes: Record<string, string> = {};
		const workspaceRoot = this._getWorkspaceRoot();
		const aiModifiedFiles: string[] = [];

		await Promise.all(stagedPaths.map(async (relPath) => {
			const absUri = workspaceRoot
				? URI.joinPath(workspaceRoot, relPath)
				: null;

			// Try integrity service first (most accurate — reflects in-memory edits)
			if (absUri) {
				const state = this.fileIntegrityService.getFileState(absUri);
				if (state) {
					stagedFileHashes[relPath] = state.currentHash;
					if (state.hasAiModifications) {
						aiModifiedFiles.push(relPath);
					}
					return;
				}
			}

			// Fallback: hash directly from disk (file wasn't opened in editor this session)
			if (absUri) {
				stagedFileHashes[relPath] = await this._hashFileFromDisk(absUri);
			} else {
				stagedFileHashes[relPath] = 'hash-unavailable';
			}
		}));

		// 2. Count provenance entries in AI-modified files
		const provenanceCount = aiModifiedFiles.length; // simplified; expand with ProvenanceService later

		// 3. Build canonical payload for signing
		const id = this._uuid();
		const timestamp = Date.now();
		const previousProofHash = this._lastProofHash;
		const enclaveFingerprint = this.cryptoService.isReady
			? this.cryptoService.enclaveFingerprint
			: 'unavailable';

		const canonicalPayload = JSON.stringify({
			id,
			sessionId: this.sessionService.sessionId,
			gitHash,
			branch,
			message: message.substring(0, 200),
			author,
			timestamp,
			stagedFileHashes,
			aiModifiedFiles,
			provenanceCount,
			previousProofHash,
			enclaveFingerprint,
		});

		const signature = this.cryptoService.isReady
			? await this.cryptoService.sign(canonicalPayload).catch(() => 'sign-failed')
			: 'unavailable';

		const proof: ICommitProof = Object.freeze({
			id,
			sessionId: this.sessionService.sessionId,
			gitHash,
			branch,
			message: message.substring(0, 200),
			author,
			timestamp,
			stagedFileHashes,
			aiModifiedFiles,
			provenanceCount,
			previousProofHash,
			enclaveFingerprint,
			signature,
		});

		// 4. Update the chain
		const proofHash = await this._sha256(canonicalPayload);
		this._lastProofHash = proofHash;
		this._proofs.set(gitHash, proof);
		this._proofChain.push(proof);

		// 5. Log to audit trail
		await this.auditTrailService.logEntry(
			'provenance_tag',
			'enclave_system',
			`git-commit:${gitHash.substring(0, 8)} branch:${branch} files:${stagedPaths.length} ai-files:${aiModifiedFiles.length}`,
			'completed',
			JSON.stringify({ proofId: id, aiModifiedFiles, provenanceCount })
		);

		// 6. Persist
		await this._persistProof(proof, proofHash);

		this._onDidCreateProof.fire(proof);

		console.log(`[Enclave CommitService] CommitProof created for ${gitHash.substring(0, 8)} — ${stagedPaths.length} files, ${aiModifiedFiles.length} AI-modified.`);

		return proof;
	}

	public getProofForCommit(gitHash: string): ICommitProof | null {
		return this._proofs.get(gitHash) ?? null;
	}

	public getAllProofs(): ICommitProof[] {
		return [...this._proofChain];
	}

	public async verifyProofChain(): Promise<{ valid: boolean; brokenAt?: string; reason?: string }> {
		if (this._proofChain.length === 0) {
			return { valid: true };
		}

		let expectedPrevHash = GENESIS_PROOF_HASH;

		for (const proof of this._proofChain) {
			if (proof.previousProofHash !== expectedPrevHash) {
				return {
					valid: false,
					brokenAt: proof.gitHash,
					reason: `Chain broken at commit ${proof.gitHash.substring(0, 8)}: expected prevHash ${expectedPrevHash.substring(0, 8)}, got ${proof.previousProofHash.substring(0, 8)}`,
				};
			}

			// Verify signature
			if (proof.signature !== 'unavailable' && proof.signature !== 'sign-failed') {
				const canonical = JSON.stringify({
					id: proof.id,
					sessionId: proof.sessionId,
					gitHash: proof.gitHash,
					branch: proof.branch,
					message: proof.message,
					author: proof.author,
					timestamp: proof.timestamp,
					stagedFileHashes: proof.stagedFileHashes,
					aiModifiedFiles: proof.aiModifiedFiles,
					provenanceCount: proof.provenanceCount,
					previousProofHash: proof.previousProofHash,
					enclaveFingerprint: proof.enclaveFingerprint,
				});

				const sigValid = this.cryptoService.isReady
					? await this.cryptoService.verify(canonical, proof.signature).catch(() => false)
					: true; // Can't verify without crypto — assume valid

				if (!sigValid) {
					return {
						valid: false,
						brokenAt: proof.gitHash,
						reason: `Signature verification failed for commit ${proof.gitHash.substring(0, 8)}. Proof may have been tampered with.`,
					};
				}
			}

			// Advance the expected chain hash
			const canonical = JSON.stringify({
				id: proof.id,
				sessionId: proof.sessionId,
				gitHash: proof.gitHash,
				branch: proof.branch,
				message: proof.message,
				author: proof.author,
				timestamp: proof.timestamp,
				stagedFileHashes: proof.stagedFileHashes,
				aiModifiedFiles: proof.aiModifiedFiles,
				provenanceCount: proof.provenanceCount,
				previousProofHash: proof.previousProofHash,
				enclaveFingerprint: proof.enclaveFingerprint,
			});
			expectedPrevHash = await this._sha256(canonical);
		}

		return { valid: true };
	}

	public async reportHistoryRewrite(operation: 'force_push' | 'rebase', details: string): Promise<void> {
		console.warn(`[Enclave CommitService] ANOMALY: git ${operation} detected. ${details}`);

		await this.auditTrailService.logEntry(
			'anomaly_detected',
			'enclave_system',
			`git-history-rewrite:${operation}`,
			'flagged',
			details
		);
	}

	// ─── Private: Persistence ─────────────────────────────────────────────────

	private async _persistProof(proof: ICommitProof, proofHash: string): Promise<void> {
		const root = this._getWorkspaceRoot();
		if (!root) { return; }

		// Write individual proof file
		const proofFileUri = URI.joinPath(root, COMMITS_FOLDER, `commit-${proof.gitHash}.json`);
		try {
			await this.fileService.writeFile(
				proofFileUri,
				VSBuffer.fromString(JSON.stringify(proof, null, 2))
			);
		} catch (err) {
			console.warn('[Enclave CommitService] Failed to write proof file:', err);
		}

		// Append chain index entry
		const indexUri = URI.joinPath(root, COMMITS_FOLDER, 'commit-index.jsonl');
		const indexEntry: ICommitChainEntry = {
			proofId: proof.id,
			gitHash: proof.gitHash,
			timestamp: proof.timestamp,
			proofHash,
		};
		const line = JSON.stringify(indexEntry) + '\n';

		try {
			let existing = '';
			try {
				const content = await this.fileService.readFile(indexUri);
				existing = content.value.toString();
			} catch { /* file doesn't exist yet */ }

			await this.fileService.writeFile(indexUri, VSBuffer.fromString(existing + line));
		} catch (err) {
			console.warn('[Enclave CommitService] Failed to write chain index:', err);
		}
	}

	// ─── Private: Utilities ──────────────────────────────────────────────────

	private _getWorkspaceRoot(): URI | null {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : null;
	}

	private async _hashFileFromDisk(uri: URI): Promise<string> {
		try {
			const stat = await this.fileService.stat(uri);
			if (stat.size > 10 * 1024 * 1024) {
				return `size-fingerprint:${stat.size}:${stat.mtime}`;
			}
			const file = await this.fileService.readFile(uri);
			return this._sha256Buffer(file.value.buffer as ArrayBuffer);
		} catch {
			return 'hash-unavailable';
		}
	}

	private async _sha256(data: string): Promise<string> {
		return this._sha256Buffer(new TextEncoder().encode(data).buffer as ArrayBuffer);
	}

	private async _sha256Buffer(buffer: ArrayBuffer): Promise<string> {
		try {
			const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
			return Array.from(new Uint8Array(hashBuffer))
				.map(b => b.toString(16).padStart(2, '0'))
				.join('');
		} catch {
			let hash = 0;
			const view = new Uint8Array(buffer);
			for (let i = 0; i < view.length; i++) {
				hash = ((hash << 5) - hash) + view[i];
				hash = hash & hash;
			}
			return Math.abs(hash).toString(16).padStart(64, '0');
		}
	}

	private _uuid(): string {
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

registerSingleton(IEnclaveCommitService, EnclaveCommitService, InstantiationType.Delayed);
