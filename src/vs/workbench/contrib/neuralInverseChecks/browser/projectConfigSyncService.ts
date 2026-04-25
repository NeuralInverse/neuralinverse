/*---------------------------------------------------------------------------------------------
 *  Project Config Sync Service
 *
 *  Pulls the project's authoritative config (GRC frameworks + extension policy) from the web
 *  console via checks-socket every 30 seconds and writes it into .inverse/:
 *
 *    Web console  \u2192  GET /checks/v1/project-config  \u2192  ProjectConfigSyncService
 *        ↓  writes .inverse/frameworks/{id}.json  (with _niMeta embedded)
 *        ↓  writes .inverse/.config-lock          (SHA-256 hashes of managed files)
 *    FrameworkRegistry picks up changes via file watcher automatically
 *        ↑  POST /checks/v1/project-config/sync   (reports loaded state back)
 *
 *  TAMPER PROTECTION:
 *    Every poll verifies each managed file's SHA-256 against .config-lock.
 *    If a file was edited, it is silently restored from infra on the next fetch.
 *    Files NOT in the lock are local drafts — untouched by this service.
 *
 *  OFFLINE RESILIENCE:
 *    If checks-socket is unreachable, the previously written files remain on
 *    disk and the GRC engine keeps enforcing them. Lock is not cleared.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { INeuralInverseAuthService } from '../../../services/neuralInverseAuth/common/neuralInverseAuth.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { CHECKS_API_URL } from '../../void/common/neuralInverseConfig.js';
import { IFrameworkRegistry } from './engine/framework/frameworkRegistry.js';
import { withInverseWriteAccess } from './engine/utils/inverseFs.js';
import { IInverseAccessService } from './engine/services/inverseAccessService.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'project_config_sync_v1';
const CONFIG_LOCK_FILE = '.config-lock';
const FRAMEWORKS_DIR = '.inverse/frameworks';
const INVERSE_DIR = '.inverse';
const IDE_ACCESS_FILE = 'ide-access.json';

// ─── Types ───────────────────────────────────────────────────────────────────

interface SuppressedViolation {
	ruleId: string;
	filePath: string | null;
	line: number | null;
	isFalseAlarm: boolean;
}

interface ProjectConfig {
	projectId: string | null;
	configVersion: string | null;
	frameworks: Array<{
		frameworkId: string;
		name: string;
		version: string;
		definition: any;
	}>;
	extensionPolicy: {
		required: string[];
		recommended: string[];
		blocked: string[];
	};
	policyIds: string[];
	allowedActions: string[];
	suppressedViolations?: SuppressedViolation[];
}

interface ConfigLockEntry {
	frameworkId: string;
	name: string;
	version: string;
	hash: string;
	syncedAt: string;
}

interface ConfigLock {
	projectId: string;
	configVersion: string;
	lockedAt: string;
	managedFiles: Record<string, ConfigLockEntry>; // filename \u2192 entry
}

// ─── Service Interface ────────────────────────────────────────────────────────

export interface IProjectConfigSyncService {
	readonly _serviceBrand: undefined;

	/** Fires when the suppressed violations set changes (e.g. user resolved on web console) */
	readonly onDidChangeSuppressedViolations: Event<SuppressedViolation[]>;

	/**
	 * Returns the IAM policy IDs currently attached to this project (from the web console).
	 * Empty array means no project-level policies have been synced yet.
	 */
	getAttachedPolicyIds(): string[];

	/**
	 * Checks whether a given NI action (e.g. 'ni:chat:enable') is granted by the attached policies.
	 * Uses the same wildcard matching as the web console IAM engine.
	 * Returns true if no project-level policies are set (no restriction = allow all).
	 */
	isActionAllowed(action: string): boolean;

	/**
	 * Returns true if the given violation has been resolved or marked as a false alarm
	 * on the web console. Used to suppress re-reporting of known violations to the backend.
	 */
	isViolationSuppressed(ruleId: string, filePath: string, line: number): boolean;
}

export const IProjectConfigSyncService = createDecorator<IProjectConfigSyncService>('projectConfigSyncService');

// ─── Implementation ───────────────────────────────────────────────────────────

class ProjectConfigSyncService extends Disposable implements IProjectConfigSyncService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSuppressedViolations = this._register(new Emitter<SuppressedViolation[]>());
	readonly onDidChangeSuppressedViolations: Event<SuppressedViolation[]> = this._onDidChangeSuppressedViolations.event;

	private _lastConfigVersion: string | null = null;
	private _attachedPolicyIds: string[] = [];
	private _allowedActions: string[] = [];
	/** Set of "ruleId:filePath:line" keys for suppressed violations */
	private _suppressedKeys = new Set<string>();
	private _suppressedViolations: SuppressedViolation[] = [];

	constructor(
		@INeuralInverseAuthService private readonly _authService: INeuralInverseAuthService,
		@INativeHostService private readonly _nativeHostService: INativeHostService,
		@IStorageService private readonly _storageService: IStorageService,
		@IWorkspaceContextService private readonly _workspaceCtx: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@IFrameworkRegistry private readonly _frameworkRegistry: IFrameworkRegistry,
		@IInverseAccessService private readonly _inverseAccessService: IInverseAccessService,
	) {
		super();

		void this._inverseAccessService; // ensures InverseAccessService is instantiated before any .inverse write

		// Restore last config version, policy IDs, and allowed actions
		const stored = this._storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
		if (stored) {
			try {
				const parsed = JSON.parse(stored);
				this._lastConfigVersion = parsed.configVersion ?? null;
				this._attachedPolicyIds = parsed.policyIds ?? [];
				this._allowedActions = parsed.allowedActions ?? [];
			} catch { /* */ }
		}

		// First sync after workspace settles
		setTimeout(() => this._sync(), 3_000);

		// Poll every 30s — same cadence as enterprise policy
		const timer = setInterval(() => this._sync(), 30_000);
		this._register({ dispose: () => clearInterval(timer) });

		this._register(this._authService.onDidChangeAuthStatus(isAuth => {
			if (isAuth) this._sync();
		}));
	}

	// ─── Public API ───────────────────────────────────────────────────────────

	public getAttachedPolicyIds(): string[] {
		return this._attachedPolicyIds;
	}

	public isActionAllowed(action: string): boolean {
		// No project-level policies synced yet \u2192 no restriction, allow all
		if (this._allowedActions.length === 0) return true;
		return this._allowedActions.some(pattern => _actionMatches(pattern, action));
	}

	public isViolationSuppressed(ruleId: string, filePath: string, line: number): boolean {
		return this._suppressedKeys.has(`${ruleId}:${filePath}:${line}`);
	}

	// ─── Workspace Helpers ────────────────────────────────────────────────────

	private _getWorkspaceRoot(): URI | null {
		const folders = this._workspaceCtx.getWorkspace().folders;
		return folders.length ? folders[0].uri : null;
	}

	private async _getWorkspaceHeaders(): Promise<Record<string, string> | null> {
		const root = this._getWorkspaceRoot();
		if (!root) return null;

		const headers: Record<string, string> = {};
		headers['x-ni-workspace-path'] = root.fsPath;

		try {
			const gitConfig = await this._fileService.readFile(URI.joinPath(root, '.git', 'config'));
			const match = gitConfig.value.toString().match(/\[remote\s+"origin"\][^\[]*\burl\s*=\s*([^\r\n]+)/);
			if (match) headers['x-ni-repo-url'] = match[1].trim();
		} catch { /* no git */ }

		return headers;
	}

	// ─── SHA-256 Hash ────────────────────────────────────────────────────────

	private async _sha256(content: string): Promise<string> {
		const data = new TextEncoder().encode(content);
		const buf = await globalThis.crypto.subtle.digest('SHA-256', data);
		return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
	}

	// ─── Config Lock ─────────────────────────────────────────────────────────

	private async _readLock(root: URI): Promise<ConfigLock | null> {
		try {
			const lockUri = URI.joinPath(root, INVERSE_DIR, CONFIG_LOCK_FILE);
			const content = await this._fileService.readFile(lockUri);
			return JSON.parse(content.value.toString()) as ConfigLock;
		} catch {
			return null;
		}
	}

	private async _writeLock(root: URI, lock: ConfigLock): Promise<void> {
		const lockUri = URI.joinPath(root, INVERSE_DIR, CONFIG_LOCK_FILE);
		const inversePath = URI.joinPath(root, INVERSE_DIR).fsPath;
		await withInverseWriteAccess(inversePath, async () => {
			await this._fileService.writeFile(lockUri, VSBuffer.fromString(JSON.stringify(lock, null, 2)));
		});
	}

	/**
	 * Verifies that all managed files still match their locked hashes.
	 * Returns the filenames of any tampered files.
	 */
	private async _detectTampering(root: URI, lock: ConfigLock): Promise<string[]> {
		const tampered: string[] = [];
		for (const [filename, entry] of Object.entries(lock.managedFiles)) {
			try {
				const fileUri = URI.joinPath(root, FRAMEWORKS_DIR, filename);
				const content = await this._fileService.readFile(fileUri);
				const currentHash = await this._sha256(content.value.toString());
				if (currentHash !== entry.hash) {
					console.warn(`[ProjectConfigSync] Tampered file detected: ${filename} (expected ${entry.hash.slice(0, 8)}… got ${currentHash.slice(0, 8)}…)`);
					tampered.push(filename);
				}
			} catch {
				// File deleted — also counts as tampered
				tampered.push(filename);
			}
		}
		return tampered;
	}

	// ─── Core Sync ───────────────────────────────────────────────────────────

	private async _sync(): Promise<void> {
		try {
			const token = await this._authService.getToken();
			if (!token) return;

			const wsHeaders = await this._getWorkspaceHeaders();
			if (!wsHeaders) return;

			const root = this._getWorkspaceRoot()!;

			// ── 1. Check for tampering even if configVersion is unchanged ──────
			const existingLock = await this._readLock(root);
			const tampered = existingLock ? await this._detectTampering(root, existingLock) : [];

			// ── 2. Skip server fetch only if version matches AND nothing tampered ──
			if (tampered.length === 0 && this._lastConfigVersion && existingLock?.configVersion === this._lastConfigVersion) {
				return;
			}

			// ── 3. Fetch authoritative config from checks-socket ──────────────
			const response = await this._nativeHostService.request(
				`${CHECKS_API_URL}/project-config`,
				{ type: 'GET', headers: { 'Authorization': `Bearer ${token}`, ...wsHeaders } }
			);

			if (response.statusCode === 401 || response.statusCode === 403) return;
			if (response.statusCode >= 400) {
				console.warn(`[ProjectConfigSync] Fetch returned ${response.statusCode}`);
				return;
			}

			const config: ProjectConfig = JSON.parse(response.body);
			if (!config.projectId || !config.frameworks.length) return;

			// ── 4. Write framework files with _niMeta + update lock ───────────
			const newLock: ConfigLock = {
				projectId: config.projectId,
				configVersion: config.configVersion ?? new Date().toISOString(),
				lockedAt: new Date().toISOString(),
				managedFiles: existingLock?.managedFiles ?? {},
			};

			let anyWritten = false;
			const inversePath = URI.joinPath(root, INVERSE_DIR).fsPath;
			const frameworksUri = URI.joinPath(root, FRAMEWORKS_DIR);

			await withInverseWriteAccess(inversePath, async () => {
				// Ensure frameworks dir exists
				if (!(await this._fileService.exists(frameworksUri))) {
					await this._fileService.createFolder(frameworksUri);
				}

				for (const fw of config.frameworks) {
					const filename = `${fw.frameworkId}.json`;
					const fileUri = URI.joinPath(root, FRAMEWORKS_DIR, filename);
					const lockEntry = existingLock?.managedFiles[filename];

					// Build the file content: original definition + _niMeta at top level
					const fileContent = JSON.stringify({
						_niMeta: {
							source: 'infra',
							syncedAt: new Date().toISOString(),
							configVersion: config.configVersion,
							projectId: config.projectId,
						},
						...fw.definition,
					}, null, 2);

					const hash = await this._sha256(fileContent);

					// Skip if already on disk at the correct hash (no tamper, no version change)
					if (lockEntry && lockEntry.hash === hash && tampered.indexOf(filename) === -1) {
						newLock.managedFiles[filename] = lockEntry;
						continue;
					}

					await this._fileService.writeFile(fileUri, VSBuffer.fromString(fileContent));
					anyWritten = true;

					newLock.managedFiles[filename] = {
						frameworkId: fw.frameworkId,
						name: fw.name,
						version: fw.version,
						hash,
						syncedAt: new Date().toISOString(),
					};

					console.log(`[ProjectConfigSync] ${tampered.includes(filename) ? 'Restored tampered' : 'Wrote'} framework: ${fw.name} v${fw.version}`);
				}
			});

			// ── 5. Write updated lock ─────────────────────────────────────────
			await this._writeLock(root, newLock);

			// ── 6. Tell FrameworkRegistry to reload if files changed ──────────
			if (anyWritten) {
				await this._frameworkRegistry.reload();
			}

			// ── 7. Persist applied version + policies + suppressed violations ──
			const policyIds = config.policyIds ?? [];
			const allowedActions = config.allowedActions ?? [];
			this._lastConfigVersion = config.configVersion;
			this._attachedPolicyIds = policyIds;
			this._allowedActions = allowedActions;

			// Rebuild suppressed key set from server response and fire event for new suppressions
			const incoming = config.suppressedViolations ?? [];
			const prevKeys = new Set(this._suppressedViolations.map(sv => `${sv.ruleId}:${sv.filePath ?? ''}:${sv.line ?? 0}`));
			const newlySuppressed = incoming.filter(sv => !prevKeys.has(`${sv.ruleId}:${sv.filePath ?? ''}:${sv.line ?? 0}`));
			this._suppressedKeys.clear();
			this._suppressedViolations = incoming;
			for (const sv of incoming) {
				this._suppressedKeys.add(`${sv.ruleId}:${sv.filePath ?? ''}:${sv.line ?? 0}`);
			}
			if (newlySuppressed.length > 0) {
				this._onDidChangeSuppressedViolations.fire(newlySuppressed);
			}
			this._storageService.store(
				STORAGE_KEY,
				JSON.stringify({ configVersion: config.configVersion, projectId: config.projectId, policyIds, allowedActions }),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);

			// ── 7b. Write ide-access.json so IDE features can read policy offline ──
			const ideAccessUri = URI.joinPath(root, INVERSE_DIR, IDE_ACCESS_FILE);
			await withInverseWriteAccess(URI.joinPath(root, INVERSE_DIR).fsPath, async () => {
				await this._fileService.writeFile(ideAccessUri, VSBuffer.fromString(JSON.stringify({
					projectId: config.projectId,
					syncedAt: new Date().toISOString(),
					policyIds,
					allowedActions,
				}, null, 2)));
			});

			// ── 8. Report sync state back to web console ──────────────────────
			await this._reportSyncState(token, config.projectId, newLock);

		} catch (err) {
			console.warn('[ProjectConfigSync] Sync error (keeping existing config):', err);
		}
	}

	// ─── Report Sync State ────────────────────────────────────────────────────

	private async _reportSyncState(token: string, projectId: string, lock: ConfigLock): Promise<void> {
		try {
			const loadedFrameworks = this._frameworkRegistry.getActiveFrameworks().map(f => ({
				frameworkId: f.definition.framework.id,
				name: f.definition.framework.name,
				version: f.definition.framework.version,
				ruleCount: f.rules.length,
				managed: !!lock.managedFiles[`${f.definition.framework.id}.json`],
			}));

			await this._nativeHostService.request(
				`${CHECKS_API_URL}/project-config/sync`,
				{
					type: 'POST',
					headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
					data: JSON.stringify({
						projectId,
						loadedFrameworks,
						managedFrameworkIds: Object.keys(lock.managedFiles).map(f => f.replace('.json', '')),
						syncedAt: lock.lockedAt,
					}),
				}
			);
		} catch { /* non-critical */ }
	}
}

registerSingleton(IProjectConfigSyncService, ProjectConfigSyncService, InstantiationType.Eager);

// ─── Action matching helper (mirrors web/src/lib/iam.ts actionMatches) ────────

function _actionMatches(pattern: string, action: string): boolean {
	if (pattern === action) return true;
	if (pattern === 'ni:*') return true;
	if (pattern.endsWith(':*')) {
		const prefix = pattern.slice(0, -2);
		return action.startsWith(prefix + ':') || action === prefix;
	}
	return false;
}
