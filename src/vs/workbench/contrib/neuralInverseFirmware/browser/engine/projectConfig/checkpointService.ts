/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Checkpoint / Rewind Service (task A3: the single workspace-level content
 * checkpoint source for both the firmware path and the void builtin tools).
 *
 * Snapshots the exact bytes of each file an agent is about to touch, enabling
 * a full rewind to any previous checkpoint. Text content is stored as utf8
 * only when a decode/encode roundtrip is lossless; everything else (images,
 * binaries, invalid utf8) is stored base64 so a rewind restores the exact
 * bytes that were on disk.
 *
 * All file I/O goes through IFileService so the service works in VS Code's
 * sandboxed renderer (the previous `globalThis.require('fs')` implementation
 * could not run there at all — fw_checkpoint_create threw on every call in
 * the installed app). Git-dependent operations (changed-file discovery when
 * no files are passed, diffs, forkFrom) remain best-effort and only work
 * where node interop is available; without it they degrade to no-ops or a
 * clear error, never to a crash.
 *
 * Operations:
 *   createCheckpoint(label, files) — snapshot current state of `files`, return id
 *   listCheckpoints()              — list all checkpoints with metadata
 *   rewindTo(id)                   — restore file state to checkpoint
 *   forkFrom(id)                   — create new git branch from checkpoint state
 *
 * Storage: <workspace folder>/.inverse/checkpoints/<id>.json
 * Max 50 checkpoints; auto-prunes oldest when limit reached.
 */

import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { buildFileSnapshot, fileSnapshotToBytes, fileWasAbsent, pickPruneVictims } from './checkpointSnapshot.js';


// ─── Types ────────────────────────────────────────────────────────────────────

export interface ICheckpoint {
	id: string;
	label: string;
	timestamp: number;
	filesChanged: string[];
	branchName?: string;
	commitHash?: string;
}

export interface ICheckpointDetail extends ICheckpoint {
	diffs: Record<string, string>;   // filePath -> unified diff (best-effort, git contexts only)
	fileSnapshots: Record<string, string>;  // filePath -> utf8 text snapshot ('' = empty file when absentFiles is present)
	binaryFileSnapshots?: Record<string, string>;  // filePath -> base64 snapshot for non-utf8 content
	absentFiles?: string[];   // files that did not exist at checkpoint time (rewind deletes them)
}

export interface ICheckpointStatus {
	count: number;
	maxCheckpoints: number;
	oldestTimestamp?: number;
	newestTimestamp?: number;
}


// ─── Service interface ────────────────────────────────────────────────────────

export const ICheckpointService = createDecorator<ICheckpointService>('checkpointService');

export interface ICheckpointService {
	readonly _serviceBrand: undefined;

	readonly onCheckpointCreated: Event<ICheckpoint>;
	readonly onRewind: Event<ICheckpoint>;

	/** Resolves once checkpoints persisted on disk are loaded. */
	ready(): Promise<void>;

	/** Create a checkpoint of the current state of `filesChanged` (absolute or workspace-relative paths). Returns checkpointId. */
	createCheckpoint(label: string, filesChanged?: string[]): Promise<string>;

	/** List all checkpoints, newest first. Reflects persisted state once `ready()` resolved. */
	listCheckpoints(): ICheckpoint[];

	/** Rewind files to the state at a specific checkpoint. */
	rewindTo(checkpointId: string): Promise<void>;

	/** Create a new git branch from checkpoint state, leave working tree unchanged. Requires node interop (git). */
	forkFrom(checkpointId: string, branchName?: string): Promise<string>;

	/** Get the stored detail for a checkpoint. */
	getCheckpointDiff(checkpointId: string): ICheckpointDetail | null;

	/** Delete a specific checkpoint (memory + persisted file). */
	deleteCheckpoint(checkpointId: string): Promise<void>;

	/** Get current status. */
	getStatus(): ICheckpointStatus;
}


// ─── Implementation ───────────────────────────────────────────────────────────

const MAX_CHECKPOINTS = 50;
const CHECKPOINT_DIR = '.inverse/checkpoints';

class CheckpointServiceImpl extends Disposable implements ICheckpointService {
	readonly _serviceBrand: undefined;

	private readonly _onCheckpointCreated = this._register(new Emitter<ICheckpoint>());
	readonly onCheckpointCreated: Event<ICheckpoint> = this._onCheckpointCreated.event;

	private readonly _onRewind = this._register(new Emitter<ICheckpoint>());
	readonly onRewind: Event<ICheckpoint> = this._onRewind.event;

	private _checkpoints: Map<string, ICheckpointDetail> = new Map();
	private readonly _loaded: Promise<void>;

	constructor(
		@IWorkspaceContextService private readonly _workspaceCtx: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
		this._loaded = this._loadFromDisk();
	}

	async ready(): Promise<void> {
		await this._loaded;
	}

	async createCheckpoint(label: string, filesChanged?: string[]): Promise<string> {
		await this._loaded;
		const id = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

		// Absolute or already-relative stored paths; the git fallback below only
		// resolves anything where node interop exists (tests, non-sandboxed hosts).
		let changed = (filesChanged ?? []).map(f => this._toStoredPath(f));
		if (changed.length === 0) {
			changed = await this._getGitChangedFiles();
		}

		const diffs: Record<string, string> = {};
		const snapshots: Record<string, string> = {};
		const binarySnapshots: Record<string, string> = {};
		const absentFiles: string[] = [];

		for (const storedPath of changed) {
			const uri = this._storedPathToURI(storedPath);
			if (!uri) { continue; }
			try {
				const { value } = await this._fileService.readFile(uri);
				const snapshot = buildFileSnapshot(value.buffer);
				if (snapshot.kind === 'text') {
					snapshots[storedPath] = snapshot.text;
				} else {
					binarySnapshots[storedPath] = snapshot.base64;
				}
			} catch {
				// Unreadable or nonexistent — rewind must delete it.
				absentFiles.push(storedPath);
			}
			diffs[storedPath] = await this._getGitDiff(storedPath);
		}

		const detail: ICheckpointDetail = {
			id,
			label,
			timestamp: Date.now(),
			filesChanged: changed,
			diffs,
			fileSnapshots: snapshots,
			...(Object.keys(binarySnapshots).length > 0 ? { binaryFileSnapshots: binarySnapshots } : {}),
			absentFiles,
		};

		this._checkpoints.set(id, detail);
		await this._pruneOldCheckpoints();
		await this._saveToDisk(detail);
		this._onCheckpointCreated.fire({ id, label, timestamp: detail.timestamp, filesChanged: changed });

		return id;
	}

	listCheckpoints(): ICheckpoint[] {
		return Array.from(this._checkpoints.values())
			.sort((a, b) => b.timestamp - a.timestamp)
			.map(({ id, label, timestamp, filesChanged, branchName, commitHash }) =>
				({ id, label, timestamp, filesChanged, branchName, commitHash }),
			);
	}

	async rewindTo(checkpointId: string): Promise<void> {
		await this._loaded;
		const detail = this._checkpoints.get(checkpointId);
		if (!detail) {
			throw new Error(`Checkpoint ${checkpointId} not found. Use fw_checkpoint_list to see available checkpoints.`);
		}

		await this._restoreSnapshotFiles(detail);
		this._onRewind.fire({ id: checkpointId, label: detail.label, timestamp: detail.timestamp, filesChanged: detail.filesChanged });
	}

	async forkFrom(checkpointId: string, branchName?: string): Promise<string> {
		await this._loaded;
		const detail = this._checkpoints.get(checkpointId);
		if (!detail) {
			throw new Error(`Checkpoint ${checkpointId} not found.`);
		}
		const cwd = this._workspaceFsPath();
		if (!cwd || !this._nodeRequire()) {
			throw new Error('forkFrom requires a git repository and node interop; it is unavailable in the sandboxed renderer.');
		}

		const branch = branchName ?? `ni-fork-${checkpointId.replace('cp_', '').substring(0, 8)}`;

		// Create new git branch from current HEAD
		await this._runGit(['checkout', '-b', branch], cwd);

		// Apply checkpoint file snapshots to the new branch
		await this._restoreSnapshotFiles(detail);

		// Stage and commit the restored files on the new branch
		if (detail.filesChanged.length > 0) {
			try {
				await this._runGit(['add', '-A'], cwd);
				await this._runGit(['commit', '-m', `[Neural Inverse] Checkpoint fork: ${detail.label}`], cwd);
			} catch {
				// Working tree may already match — commit failure is acceptable
			}
		}

		// Return to original branch
		await this._runGit(['checkout', '-'], cwd);

		// Update checkpoint with branch name
		detail.branchName = branch;
		this._checkpoints.set(checkpointId, detail);
		await this._saveToDisk(detail);

		return branch;
	}

	getCheckpointDiff(checkpointId: string): ICheckpointDetail | null {
		return this._checkpoints.get(checkpointId) ?? null;
	}

	async deleteCheckpoint(checkpointId: string): Promise<void> {
		this._checkpoints.delete(checkpointId);
		const dirUri = this._checkpointDirURI();
		if (!dirUri) { return; }
		try {
			await this._fileService.del(URI.joinPath(dirUri, `${checkpointId}.json`));
		} catch { /* not persisted or already gone */ }
	}

	getStatus(): ICheckpointStatus {
		const checkpoints = Array.from(this._checkpoints.values());
		return {
			count: checkpoints.length,
			maxCheckpoints: MAX_CHECKPOINTS,
			oldestTimestamp: checkpoints.length > 0 ? Math.min(...checkpoints.map(c => c.timestamp)) : undefined,
			newestTimestamp: checkpoints.length > 0 ? Math.max(...checkpoints.map(c => c.timestamp)) : undefined,
		};
	}

	// ─── Snapshot restore ─────────────────────────────────────────────────────

	private async _restoreSnapshotFiles(detail: ICheckpointDetail): Promise<void> {
		const storedPaths = new Set([
			...Object.keys(detail.fileSnapshots),
			...Object.keys(detail.binaryFileSnapshots ?? {}),
		]);

		for (const storedPath of storedPaths) {
			const uri = this._storedPathToURI(storedPath);
			if (!uri) { continue; }
			if (fileWasAbsent(storedPath, detail)) {
				try {
					await this._fileService.del(uri);
				} catch { /* already absent */ }
				continue;
			}
			const snapshot = detail.binaryFileSnapshots?.[storedPath] !== undefined
				? { kind: 'binary', base64: detail.binaryFileSnapshots[storedPath] } as const
				: { kind: 'text', text: detail.fileSnapshots[storedPath] ?? '' } as const;
			try {
				await this._fileService.writeFile(uri, fileSnapshotToBytes(snapshot));
			} catch (e) {
				throw new Error(`Failed to restore ${storedPath}: ${(e as Error).message}`);
			}
		}
	}

	// ─── Storage ──────────────────────────────────────────────────────────────

	private async _loadFromDisk(): Promise<void> {
		const dirUri = this._checkpointDirURI();
		if (!dirUri) { return; }

		try {
			const stat = await this._fileService.resolve(dirUri);
			for (const child of stat.children ?? []) {
				if (!child.name.endsWith('.json')) { continue; }
				try {
					const { value } = await this._fileService.readFile(child.resource);
					const detail = JSON.parse(value.toString()) as ICheckpointDetail;
					this._checkpoints.set(detail.id, detail);
				} catch { /* skip corrupt files */ }
			}
		} catch { /* directory not readable or missing — start empty */ }
	}

	private async _saveToDisk(detail: ICheckpointDetail): Promise<void> {
		const dirUri = this._checkpointDirURI();
		if (!dirUri) { return; }

		try {
			await this._fileService.writeFile(
				URI.joinPath(dirUri, `${detail.id}.json`),
				VSBuffer.fromString(JSON.stringify(detail, null, 2)),
			);
		} catch (e) {
			// Disk write failed — checkpoint is in-memory only. Log warning.
			console.warn(`[CheckpointService] Failed to persist checkpoint ${detail.id} to disk: ${(e as Error).message}. Checkpoint survives only until process restart.`);
		}
	}

	private async _pruneOldCheckpoints(): Promise<void> {
		for (const victim of pickPruneVictims(Array.from(this._checkpoints.values()), MAX_CHECKPOINTS)) {
			await this.deleteCheckpoint(victim.id);
		}
	}

	// ─── Path anchoring ───────────────────────────────────────────────────────

	private _workspaceFolderUri(): URI | undefined {
		const folders = this._workspaceCtx.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : undefined;
	}

	private _workspaceFsPath(): string | undefined {
		return this._workspaceFolderUri()?.fsPath;
	}

	private _checkpointDirURI(): URI | undefined {
		const folder = this._workspaceFolderUri();
		return folder ? URI.joinPath(folder, CHECKPOINT_DIR) : undefined;
	}

	/** Store paths relative to the first workspace folder when inside it, otherwise as absolute '/'-separated paths. */
	private _toStoredPath(fsPath: string): string {
		const folder = this._workspaceFolderUri();
		const p = fsPath.replace(/\\/g, '/');
		const root = folder?.fsPath.replace(/\\/g, '/');
		if (root) {
			const rootLower = root.toLowerCase();
			const pLower = p.toLowerCase();
			if (pLower === rootLower) { return '.'; }
			if (pLower.startsWith(rootLower + '/')) {
				return p.slice(root.length).replace(/^\//, '');
			}
		}
		return p;
	}

	/** Resolve a stored path back to a URI: absolute paths as-is, relative paths anchored at the first workspace folder. */
	private _storedPathToURI(stored: string): URI | undefined {
		// Absolute: Windows drive (c:/… or /c:/…), UNC (//server/…), or POSIX root.
		if (/^\/?[a-zA-Z]:\//.test(stored) || stored.startsWith('//') || stored.startsWith('/')) {
			return URI.file(stored);
		}
		const folder = this._workspaceFolderUri();
		if (!folder) { return undefined; }
		return URI.joinPath(folder, stored);
	}

	// ─── Git helpers (node interop only — best-effort everywhere else) ────────

	private async _getGitChangedFiles(): Promise<string[]> {
		const cwd = this._workspaceFsPath();
		if (!cwd || !this._nodeRequire()) { return []; }
		try {
			const output = await this._runGit(['diff', '--name-only', 'HEAD'], cwd);
			const staged = await this._runGit(['diff', '--cached', '--name-only'], cwd);
			const untracked = await this._runGit(['ls-files', '--others', '--exclude-standard'], cwd);
			return [...new Set([
				...output.split('\n'),
				...staged.split('\n'),
				...untracked.split('\n'),
			].filter(Boolean))];
		} catch {
			return [];
		}
	}

	private async _getGitDiff(storedPath: string): Promise<string> {
		const cwd = this._workspaceFsPath();
		if (!cwd || !this._nodeRequire()) { return ''; }
		try {
			return await this._runGit(['diff', 'HEAD', '--', storedPath], cwd);
		} catch {
			return '';
		}
	}

	private _runGit(args: string[], cwd: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const cpModule = this._nodeRequire()
				? this._nodeRequire()!('child_process') as typeof import('child_process')
				: null;

			if (!cpModule) { resolve(''); return; }

			const proc = cpModule.spawn('git', args, { cwd, timeout: 10000 });
			let out = '';
			let err = '';

			proc.stdout?.on('data', (d: unknown) => { out += String(d); });
			proc.stderr?.on('data', (d: unknown) => { err += String(d); });

			proc.on('close', (code: number) => {
				if (code !== 0) { reject(new Error(err.trim() || `git ${args[0]} failed`)); }
				else { resolve(out.trim()); }
			});

			proc.on('error', (e: Error) => reject(e));
		});
	}

	private _nodeRequire(): NodeRequire | null {
		const req = (globalThis as Record<string, unknown>)['require'];
		return typeof req === 'function' ? (req as NodeRequire) : null;
	}
}


registerSingleton(ICheckpointService, CheckpointServiceImpl, InstantiationType.Delayed);
