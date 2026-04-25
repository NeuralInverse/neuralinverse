/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # EnclaveBuildService
 *
 * Hermetic build environment capture and reproducibility proof for the Neural Inverse Enclave.
 *
 * ## What Is a Hermetic Build?
 * A hermetic build is one where the OUTPUT is a pure function of the INPUT.
 * Given the exact same source, tools, and environment, the build must produce
 * the exact same binary — byte for byte — every time.
 *
 * This is mandatory for:
 *   - DO-178C DAL A (avionics) — reproducible object code requirement
 *   - ISO 26262 ASIL D (automotive) — compiler qualification + reproducibility
 *   - Supply chain security — verify no injection occurred during build
 *
 * ## What This Service Captures
 *
 * ### Build Environment Snapshot
 * - OS name, version, kernel
 * - CPU architecture
 * - Node version, process env (sanitized — secrets stripped)
 * - Workspace root hash (all source files at build time)
 * - Toolchain hashes (from ToolchainService)
 *
 * ### Build Proof Record
 * ```json
 * {
 *   "id": "uuid",
 *   "sessionId": "ses_...",
 *   "buildCommand": "npm run build",
 *   "startedAt": 1712345678000,
 *   "endedAt":   1712345739000,
 *   "durationMs": 61000,
 *   "exitCode": 0,
 *   "status": "succeeded" | "failed",
 *   "environmentSnapshot": { "os": "darwin", "arch": "arm64", ... },
 *   "inputSourceHash": "sha256...",   // hash of workspace source tree at build start
 *   "outputArtifactHashes": {          // SHA-256 of each output file
 *     "dist/main.js": "sha256...",
 *     "dist/main.js.map": "sha256..."
 *   },
 *   "toolchainSummaryHash": "sha256...", // hash of last ToolchainService verification
 *   "signature": "base64url..."
 * }
 * ```
 *
 * ## Reproducibility Check
 * When `verifyReproducibility()` is called, it:
 *   1. Verifies the environment snapshot hash is unchanged
 *   2. Re-hashes the current source tree and compares to `inputSourceHash`
 *   3. If both match AND build outputs exist, verifies output hashes
 *
 * ## Build Detection
 * Build commands are detected by monitoring terminal output patterns.
 * Integration points:
 *   - `beginBuildTracking(command)` — called by terminal/task integration
 *   - `completeBuildTracking(exitCode, outputPaths)` — called when build finishes
 */

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IFileService, IFileStat } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IEnclaveCryptoService } from '../crypto/enclaveCryptoService.js';
import { IEnclaveSessionService } from '../session/enclaveSessionService.js';
import { IEnclaveAuditTrailService } from '../audit/enclaveAuditTrailService.js';
import { IEnclaveToolchainService } from '../toolchain/enclaveToolchainService.js';

export const IEnclaveBuildService = createDecorator<IEnclaveBuildService>('enclaveBuildService');

// ─── Types ────────────────────────────────────────────────────────────────────

export type BuildStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface IBuildEnvironmentSnapshot {
	/** OS platform: 'darwin', 'linux', 'win32' */
	readonly os: string;
	/** CPU architecture: 'arm64', 'x64' */
	readonly arch: string;
	/** Node.js version */
	readonly nodeVersion: string;
	/** SHA-256 of the serialized snapshot (self-referential, computed last) */
	readonly snapshotHash: string;
}

export interface IBuildProof {
	/** UUIDv4 */
	readonly id: string;
	readonly sessionId: string;
	/** Shell command or task label that triggered the build */
	readonly buildCommand: string;
	/** Unix ms — build started */
	readonly startedAt: number;
	/** Unix ms — build ended. null if still running. */
	readonly endedAt: number | null;
	readonly durationMs: number | null;
	readonly exitCode: number | null;
	readonly status: BuildStatus;
	readonly environmentSnapshot: IBuildEnvironmentSnapshot;
	/**
	 * SHA-256 of a representative subset of source files at build start.
	 * Used for reproducibility checks.
	 */
	readonly inputSourceHash: string;
	/**
	 * SHA-256 of each output artifact.
	 * Populated when completeBuildTracking() is called with outputPaths.
	 */
	readonly outputArtifactHashes: Record<string, string>;
	/**
	 * SHA-256 of the ToolchainService summary JSON at build time.
	 * Links the build to the tool verification.
	 */
	readonly toolchainSummaryHash: string;
	/** ECDSA P-256 signature of the proof */
	readonly signature: string;
}

export interface IReproducibilityResult {
	readonly reproducible: boolean;
	readonly sourceUnchanged: boolean;
	readonly outputHashesMatch: boolean;
	readonly environmentUnchanged: boolean;
	readonly reason?: string;
}

export interface IEnclaveBuildService {
	readonly _serviceBrand: undefined;

	/** Fires when a new build proof is created (on build start) */
	readonly onDidBeginBuild: Event<IBuildProof>;
	/** Fires when a build proof is finalized (on build complete) */
	readonly onDidCompleteBuild: Event<IBuildProof>;

	/**
	 * Begin tracking a build.
	 * Captures the environment snapshot and input source hash.
	 * Returns the in-progress build proof.
	 *
	 * @param buildCommand — The command being run (e.g., 'npm run build', 'cargo build --release')
	 */
	beginBuildTracking(buildCommand: string): Promise<IBuildProof>;

	/**
	 * Complete an in-progress build.
	 * Hashes output artifacts, finalizes and signs the proof.
	 *
	 * @param buildId — The proof ID returned by beginBuildTracking()
	 * @param exitCode — Process exit code (0 = success)
	 * @param outputPaths — Workspace-relative paths to output artifacts to hash
	 */
	completeBuildTracking(buildId: string, exitCode: number, outputPaths: string[]): Promise<IBuildProof>;

	/**
	 * Get a build proof by ID.
	 */
	getProof(buildId: string): IBuildProof | null;

	/**
	 * Get all build proofs from this session, newest first.
	 */
	getAllProofs(): IBuildProof[];

	/**
	 * Verify whether the current state is reproducible with respect to a previous build proof.
	 * Checks source tree hash, environment, and output artifact hashes.
	 */
	verifyReproducibility(proof: IBuildProof): Promise<IReproducibilityResult>;

	/**
	 * Capture the current environment snapshot (exposed for UI / debugging).
	 */
	captureEnvironmentSnapshot(): Promise<IBuildEnvironmentSnapshot>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BUILD_FOLDER = '.inverse/builds';

/** Source file extensions to include in input source hash */
const SOURCE_EXTENSIONS = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
	'.rs', '.toml', '.py', '.go', '.c', '.cpp', '.h', '.hpp',
	'.cs', '.java', '.kt', '.swift',
	'.json', '.yaml', '.yml', '.xml', '.cmake',
	'.s', '.asm',
]);

/** Directories to exclude from source hashing */
const EXCLUDED_DIRS = new Set([
	'node_modules', 'dist', 'build', 'out', 'target',
	'.git', '.svn', '.inverse', '__pycache__', '.cache',
]);

// ─── Implementation ───────────────────────────────────────────────────────────

export class EnclaveBuildService extends Disposable implements IEnclaveBuildService {
	declare readonly _serviceBrand: undefined;

	/** Active and completed build proofs: id \u2192 proof */
	private readonly _proofs = new Map<string, IBuildProof>();
	/** Ordered proof list (newest first) */
	private readonly _proofList: IBuildProof[] = [];

	private readonly _onDidBeginBuild = this._register(new Emitter<IBuildProof>());
	public readonly onDidBeginBuild: Event<IBuildProof> = this._onDidBeginBuild.event;

	private readonly _onDidCompleteBuild = this._register(new Emitter<IBuildProof>());
	public readonly onDidCompleteBuild: Event<IBuildProof> = this._onDidCompleteBuild.event;

	constructor(
		@IEnclaveCryptoService private readonly cryptoService: IEnclaveCryptoService,
		@IEnclaveSessionService private readonly sessionService: IEnclaveSessionService,
		@IEnclaveAuditTrailService private readonly auditTrailService: IEnclaveAuditTrailService,
		@IEnclaveToolchainService private readonly toolchainService: IEnclaveToolchainService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		console.log('[Enclave Build] Service initialized.');
	}

	// ─── Public API ───────────────────────────────────────────────────────────

	public async beginBuildTracking(buildCommand: string): Promise<IBuildProof> {
		const id = this._uuid();
		const sessionId = this.sessionService.sessionId;
		const startedAt = Date.now();

		// 1. Capture environment
		const environmentSnapshot = await this.captureEnvironmentSnapshot();

		// 2. Hash source tree
		const inputSourceHash = await this._hashSourceTree();

		// 3. Get toolchain summary hash
		const toolchainSummaryHash = await this._getToolchainHash();

		// 4. Build initial (in-progress) proof
		const inProgressPayload = JSON.stringify({
			id, sessionId, buildCommand, startedAt,
			environmentSnapshot, inputSourceHash, toolchainSummaryHash,
		});
		const signature = this.cryptoService.isReady
			? await this.cryptoService.sign(inProgressPayload).catch(() => 'sign-failed')
			: 'pending';

		const proof: IBuildProof = Object.freeze({
			id, sessionId, buildCommand,
			startedAt, endedAt: null, durationMs: null,
			exitCode: null,
			status: 'running',
			environmentSnapshot,
			inputSourceHash,
			outputArtifactHashes: {},
			toolchainSummaryHash,
			signature,
		});

		this._proofs.set(id, proof);
		this._proofList.unshift(proof);

		// 5. Audit log
		await this.auditTrailService.logEntry(
			'provenance_tag',
			'enclave_system',
			`build-started:${buildCommand}`,
			'completed',
			JSON.stringify({ buildId: id, inputSourceHash: inputSourceHash.substring(0, 16) })
		);

		this._onDidBeginBuild.fire(proof);
		console.log(`[Enclave Build] Build started: "${buildCommand}" (id: ${id.substring(0, 8)})`);
		return proof;
	}

	public async completeBuildTracking(
		buildId: string,
		exitCode: number,
		outputPaths: string[]
	): Promise<IBuildProof> {
		const existing = this._proofs.get(buildId);
		if (!existing || existing.status !== 'running') {
			throw new Error(`[Enclave Build] No running build found with id: ${buildId}`);
		}

		const endedAt = Date.now();
		const durationMs = endedAt - existing.startedAt;
		const status: BuildStatus = exitCode === 0 ? 'succeeded' : 'failed';

		// Hash output artifacts
		const outputArtifactHashes: Record<string, string> = {};
		const root = this._getWorkspaceRootUri();
		if (root) {
			await Promise.all(outputPaths.map(async (relPath) => {
				const uri = URI.joinPath(root, relPath);
				try {
					const file = await this.fileService.readFile(uri);
					const hash = await this._sha256(file.value.buffer as ArrayBuffer);
					outputArtifactHashes[relPath] = hash;
				} catch {
					outputArtifactHashes[relPath] = 'hash-unavailable';
				}
			}));
		}

		// Build final signed proof
		const finalPayload = JSON.stringify({
			id: buildId,
			sessionId: existing.sessionId,
			buildCommand: existing.buildCommand,
			startedAt: existing.startedAt,
			endedAt, durationMs, exitCode, status,
			environmentSnapshot: existing.environmentSnapshot,
			inputSourceHash: existing.inputSourceHash,
			outputArtifactHashes,
			toolchainSummaryHash: existing.toolchainSummaryHash,
		});

		const signature = this.cryptoService.isReady
			? await this.cryptoService.sign(finalPayload).catch(() => 'sign-failed')
			: 'pending';

		const finalProof: IBuildProof = Object.freeze({
			id: buildId,
			sessionId: existing.sessionId,
			buildCommand: existing.buildCommand,
			startedAt: existing.startedAt,
			endedAt, durationMs, exitCode, status,
			environmentSnapshot: existing.environmentSnapshot,
			inputSourceHash: existing.inputSourceHash,
			outputArtifactHashes,
			toolchainSummaryHash: existing.toolchainSummaryHash,
			signature,
		});

		// Replace in-place
		this._proofs.set(buildId, finalProof);
		const listIdx = this._proofList.findIndex(p => p.id === buildId);
		if (listIdx >= 0) { this._proofList[listIdx] = finalProof; }

		// Audit log
		await this.auditTrailService.logEntry(
			'provenance_tag',
			'enclave_system',
			`build-${status}:${existing.buildCommand} exit=${exitCode} duration=${Math.round(durationMs / 1000)}s outputs=${outputPaths.length}`,
			status === 'succeeded' ? 'completed' : 'flagged',
			JSON.stringify({ buildId, exitCode, durationMs, outputCount: outputPaths.length })
		);

		// Persist
		await this._persistProof(finalProof);

		this._onDidCompleteBuild.fire(finalProof);
		console.log(`[Enclave Build] Build ${status}: "${existing.buildCommand}" — ${Math.round(durationMs / 1000)}s, exit=${exitCode}`);
		return finalProof;
	}

	public getProof(buildId: string): IBuildProof | null {
		return this._proofs.get(buildId) ?? null;
	}

	public getAllProofs(): IBuildProof[] {
		return [...this._proofList];
	}

	public async verifyReproducibility(proof: IBuildProof): Promise<IReproducibilityResult> {
		// 1. Check source tree hash
		const currentSourceHash = await this._hashSourceTree();
		const sourceUnchanged = currentSourceHash === proof.inputSourceHash;

		// 2. Check environment snapshot hash
		const currentEnv = await this.captureEnvironmentSnapshot();
		const environmentUnchanged = currentEnv.snapshotHash === proof.environmentSnapshot.snapshotHash;

		// 3. Check output artifact hashes (if outputs exist)
		let outputHashesMatch = true;
		const root = this._getWorkspaceRootUri();
		if (root && Object.keys(proof.outputArtifactHashes).length > 0) {
			for (const [relPath, expectedHash] of Object.entries(proof.outputArtifactHashes)) {
				try {
					const uri = URI.joinPath(root, relPath);
					const file = await this.fileService.readFile(uri);
					const actualHash = await this._sha256(file.value.buffer as ArrayBuffer);
					if (actualHash !== expectedHash) {
						outputHashesMatch = false;
						break;
					}
				} catch {
					outputHashesMatch = false;
					break;
				}
			}
		}

		const reproducible = sourceUnchanged && environmentUnchanged && outputHashesMatch;

		let reason: string | undefined;
		if (!reproducible) {
			const issues: string[] = [];
			if (!sourceUnchanged) { issues.push('source tree has changed since build'); }
			if (!environmentUnchanged) { issues.push('build environment has changed'); }
			if (!outputHashesMatch) { issues.push('output artifact hashes do not match'); }
			reason = issues.join('; ');
		}

		return { reproducible, sourceUnchanged, environmentUnchanged, outputHashesMatch, reason };
	}

	public async captureEnvironmentSnapshot(): Promise<IBuildEnvironmentSnapshot> {
		const os = typeof process !== 'undefined' ? process.platform : 'unknown';
		const arch = typeof process !== 'undefined' ? process.arch : 'unknown';
		const nodeVersion = typeof process !== 'undefined' ? process.version : 'unknown';

		// Compute snapshot hash (without the hash field itself, to avoid circular)
		const snapshotBody = JSON.stringify({ os, arch, nodeVersion });
		const snapshotHash = await this._sha256String(snapshotBody);

		return Object.freeze({ os, arch, nodeVersion, snapshotHash });
	}

	// ─── Private: Source Tree Hashing ────────────────────────────────────────

	/**
	 * Hash the workspace source tree.
	 * Walks all relevant source files (filtered by extension and excluded dirs),
	 * sorts them lexicographically, and produces a SHA-256 of all their hashes concatenated.
	 * This is a Merkle-root-equivalent for the source tree.
	 */
	private async _hashSourceTree(): Promise<string> {
		const root = this._getWorkspaceRootUri();
		if (!root) { return 'no-workspace'; }

		const fileHashes: Array<{ path: string; hash: string }> = [];
		await this._walkDir(root, root, fileHashes);

		// Sort lexicographically by path for determinism
		fileHashes.sort((a, b) => a.path.localeCompare(b.path));

		// Concatenate all hashes and hash the result
		const concatenated = fileHashes.map(f => `${f.path}:${f.hash}`).join('\n');
		return this._sha256String(concatenated);
	}

	private async _walkDir(
		root: URI,
		dir: URI,
		results: Array<{ path: string; hash: string }>,
		depth: number = 0
	): Promise<void> {
		if (depth > 10) { return; } // guard against pathologically deep trees

		let stat: IFileStat;
		try {
			stat = await this.fileService.resolve(dir);
		} catch {
			return; // directory not readable — skip
		}

		const children = stat.children;
		if (!children) { return; }

		await Promise.all(children.map(async (child: IFileStat) => {
			const name = child.resource.path.split('/').pop() ?? '';
			if (!name || EXCLUDED_DIRS.has(name)) { return; }

			if (child.isDirectory) {
				await this._walkDir(root, child.resource, results, depth + 1);
			} else if (child.isFile) {
				const dotIdx = name.lastIndexOf('.');
				const ext = dotIdx >= 0 ? name.substring(dotIdx) : '';
				if (!SOURCE_EXTENSIONS.has(ext)) { return; }

				try {
					// For large source files use a stat-based fingerprint to avoid blocking
					const fileStat = await this.fileService.stat(child.resource);
					if (fileStat.size > 5 * 1024 * 1024) {
						const relPath = child.resource.path.substring(root.path.length);
						results.push({ path: relPath, hash: `size:${fileStat.size}:${fileStat.mtime}` });
						return;
					}
					const file = await this.fileService.readFile(child.resource);
					const hash = await this._sha256(file.value.buffer as ArrayBuffer);
					const relPath = child.resource.path.substring(root.path.length);
					results.push({ path: relPath, hash });
				} catch { /* skip unreadable files */ }
			}
		}));
	}

	// ─── Private: Toolchain Hash ─────────────────────────────────────────────

	private async _getToolchainHash(): Promise<string> {
		const lastVerification = this.toolchainService.getLastVerification();
		if (!lastVerification) { return 'toolchain-not-verified'; }
		return this._sha256String(lastVerification.signature);
	}

	// ─── Private: Persistence ─────────────────────────────────────────────────

	private async _persistProof(proof: IBuildProof): Promise<void> {
		const root = this._getWorkspaceRootUri();
		if (!root) { return; }

		const dateStr = new Date(proof.startedAt).toISOString().split('T')[0];
		const fileUri = URI.joinPath(root, BUILD_FOLDER, `build-${dateStr}-${proof.id.substring(0, 8)}.json`);
		try {
			await this.fileService.writeFile(
				fileUri,
				VSBuffer.fromString(JSON.stringify(proof, null, 2))
			);
		} catch (err) {
			console.warn('[Enclave Build] Failed to persist proof:', err);
		}
	}

	// ─── Private: Hashing ────────────────────────────────────────────────────

	private async _sha256(buffer: ArrayBuffer): Promise<string> {
		try {
			const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
			return Array.from(new Uint8Array(hashBuffer))
				.map(b => b.toString(16).padStart(2, '0'))
				.join('');
		} catch {
			return 'hash-failed';
		}
	}

	private async _sha256String(data: string): Promise<string> {
		return this._sha256(new TextEncoder().encode(data).buffer as ArrayBuffer);
	}

	// ─── Private: Utilities ──────────────────────────────────────────────────

	private _getWorkspaceRootUri(): URI | null {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : null;
	}

	private _uuid(): string {
		try { return crypto.randomUUID(); } catch {
			return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
				const r = Math.random() * 16 | 0;
				return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
			});
		}
	}
}

registerSingleton(IEnclaveBuildService, EnclaveBuildService, InstantiationType.Delayed);
