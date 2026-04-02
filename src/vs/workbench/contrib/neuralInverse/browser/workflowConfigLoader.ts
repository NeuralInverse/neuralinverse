/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Workflow Config Loader
 *
 * Loads IWorkflowDefinition objects from .inverse/workflows/*.json.
 *
 * ## .inverse/ Access Rule
 *
 * READ  → IFileService.readFile() directly — no unlock needed.
 * WRITE → withInverseWriteAccess() from inverseFs.ts — .inverse/ is write-locked
 *         by the nano agent after each cycle (chmod -R a-w .inverse).
 *
 * This loader only reads. It never writes to .inverse/.
 * If the UI needs to create/modify a workflow definition, it must call
 * withInverseWriteAccess() before writing.
 *
 * ## File Format
 *
 * Each file under .inverse/workflows/ is a JSON IWorkflowDefinition.
 * The filename (without .json) does NOT need to match the id field,
 * but by convention they should match.
 *
 * ## Hot Reload
 *
 * Watches .inverse/workflows/ for any change (create, modify, delete)
 * and refreshes the in-memory registry automatically. Fires onDidChange.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { IFileService, FileChangesEvent } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IWorkflowDefinition } from '../common/workflowTypes.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { isWindows } from '../../../../base/common/platform.js';
import { BUILTIN_WORKFLOWS } from './builtinLibrary.js';

const INVERSE_DIR = '.inverse';
const WORKFLOWS_DIR = 'workflows';

export class WorkflowConfigLoader extends Disposable {

	private _workflows = new Map<string, IWorkflowDefinition>();

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly _terminalName = 'Inverse Workflow Loader';

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super();
		this._initialize();
		this._registerWatcher();
	}

	// ─── Terminal write access ─────────────────────────────────────────────────

	private async _getTerminal() {
		let t = this.terminalService.instances.find(inst => inst.title === this._terminalName);
		if (!t) {
			t = await this.terminalService.createTerminal({ config: { name: this._terminalName, isTransient: true } });
		}
		return t;
	}

	private async _waitForFile(file: URI, timeoutMs = 5000): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			try { if (await this.fileService.exists(file)) return; } catch { }
			await new Promise<void>(r => setTimeout(r, 200));
		}
	}

	private async _withWriteAccess(fn: () => Promise<void>): Promise<void> {
		const inverseDirUri = this._getInverseDirUri();
		if (!inverseDirUri) throw new Error('No workspace folder open');
		const inversePath = inverseDirUri.fsPath;

		const workspaceRoot = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!workspaceRoot) throw new Error('No workspace folder open');
		const statusFile = URI.joinPath(workspaceRoot, '.inverse_workflow_loader_status');

		try { await this.fileService.del(statusFile); } catch { }

		const terminal = await this._getTerminal();
		const unlockCmd = isWindows
			? `attrib -r "${inversePath}\\*" /s && echo DONE > "${statusFile.fsPath}"`
			: `chmod -R u+w "${inversePath}" && echo "DONE" > "${statusFile.fsPath}"`;
		terminal.sendText(unlockCmd, true);
		await this._waitForFile(statusFile);
		try { await this.fileService.del(statusFile); } catch { }

		try {
			await fn();
		} finally {
			try { await this.fileService.del(statusFile); } catch { }
			const lockCmd = isWindows
				? `attrib +r "${inversePath}\\*" /s && echo DONE > "${statusFile.fsPath}"`
				: `chmod -R a-w "${inversePath}" && echo "DONE" > "${statusFile.fsPath}"`;
			terminal.sendText(lockCmd, true);
			await this._waitForFile(statusFile);
			try { await this.fileService.del(statusFile); } catch { }
		}
	}

	// ─── Init ──────────────────────────────────────────────────────────────────

	private async _initialize(): Promise<void> {
		await this._ensureWorkflowsDirExists();
		await this._reload();
		// Auto-provision built-in workflow templates if folder is empty
		if (this._workflows.size === 0) {
			await this._provisionBuiltinWorkflows();
		}
	}

	private async _provisionBuiltinWorkflows(): Promise<void> {
		for (const wf of BUILTIN_WORKFLOWS) {
			try {
				await this.saveWorkflow(wf);
			} catch (e) {
				console.warn('[WorkflowConfigLoader] Failed to provision built-in workflow', wf.id, e);
			}
		}
		if (BUILTIN_WORKFLOWS.length > 0) {
			await this._reload();
		}
	}

	/**
	 * Creates .inverse/workflows/ if it doesn't exist.
	 * Uses withInverseWriteAccess since .inverse/ is write-locked.
	 */
	private async _ensureWorkflowsDirExists(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) return;

		const rootUri = folders[0].uri;
		const inverseDirUri = URI.joinPath(rootUri, INVERSE_DIR);
		const workflowsDirUri = URI.joinPath(inverseDirUri, WORKFLOWS_DIR);

		try {
			const exists = await this.fileService.exists(workflowsDirUri);
			if (!exists) {
				await this._withWriteAccess(async () => {
					await this.fileService.createFolder(workflowsDirUri);
					console.log('[WorkflowConfigLoader] Created .inverse/workflows/');
				});
			}
		} catch (e) {
			console.warn('[WorkflowConfigLoader] Could not ensure workflows dir:', e);
		}
	}

	// ─── File Watcher ──────────────────────────────────────────────────────────

	private _registerWatcher(): void {
		this._register(this.fileService.onDidFilesChange((e: FileChangesEvent) => {
			const workflowsDir = this._getWorkflowsDirUri();
			if (!workflowsDir) return;

			if (e.affects(workflowsDir)) {
				console.log('[WorkflowConfigLoader] Workflow files changed, reloading...');
				this._reload();
			}
		}));

		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._reload();
		}));
	}

	// ─── Load ──────────────────────────────────────────────────────────────────

	private async _reload(): Promise<void> {
		this._workflows.clear();

		// Always seed built-in workflows so they are available without disk files.
		// Disk files override a built-in if they share the same ID.
		for (const wf of BUILTIN_WORKFLOWS) {
			this._workflows.set(wf.id, wf);
		}

		const dirUri = this._getWorkflowsDirUri();
		if (!dirUri) {
			this._onDidChange.fire();
			return;
		}

		try {
			// READ — no unlock needed, .inverse/ is readable
			const stat = await this.fileService.resolve(dirUri);
			if (!stat.children) {
				this._onDidChange.fire();
				return;
			}

			for (const child of stat.children) {
				if (!child.name.endsWith('.json')) continue;
				try {
					const content = await this.fileService.readFile(child.resource);
					const def = JSON.parse(content.value.toString()) as IWorkflowDefinition;
					if (!def.id || !def.steps) {
						console.warn(`[WorkflowConfigLoader] Invalid workflow file: ${child.name} — missing id or steps`);
						continue;
					}
					this._workflows.set(def.id, def);
					console.log(`[WorkflowConfigLoader] Loaded workflow: ${def.id} (${def.steps.length} steps)`);
				} catch (e) {
					console.error(`[WorkflowConfigLoader] Failed to parse ${child.name}:`, e);
				}
			}
		} catch {
			// .inverse/workflows/ may not exist yet — built-ins already seeded above
		}

		this._onDidChange.fire();
	}

	// ─── Public API ───────────────────────────────────────────────────────────

	getWorkflows(): IWorkflowDefinition[] {
		return [...this._workflows.values()];
	}

	getWorkflow(id: string): IWorkflowDefinition | undefined {
		return this._workflows.get(id);
	}

	getEnabledWorkflows(): IWorkflowDefinition[] {
		return this.getWorkflows().filter(w => w.enabled);
	}

	/**
	 * Persist a workflow definition to .inverse/workflows/<id>.json.
	 * Uses withInverseWriteAccess since .inverse/ is write-locked.
	 */
	async saveWorkflow(def: IWorkflowDefinition): Promise<void> {
		const inverseDirUri = this._getInverseDirUri();
		if (!inverseDirUri) throw new Error('No workspace folder open');

		const fileUri = URI.joinPath(inverseDirUri, WORKFLOWS_DIR, `${def.id}.json`);
		const json = JSON.stringify(def, null, 2);

		await this._withWriteAccess(async () => {
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(json));
		});

		console.log(`[WorkflowConfigLoader] Saved workflow: ${def.id}`);
	}

	/**
	 * Delete a workflow definition file.
	 * Uses withInverseWriteAccess since .inverse/ is write-locked.
	 */
	async deleteWorkflow(id: string): Promise<void> {
		const inverseDirUri = this._getInverseDirUri();
		if (!inverseDirUri) throw new Error('No workspace folder open');

		const fileUri = URI.joinPath(inverseDirUri, WORKFLOWS_DIR, `${id}.json`);
		const exists = await this.fileService.exists(fileUri);
		if (!exists) return;

		await this._withWriteAccess(async () => {
			await this.fileService.del(fileUri);
		});

		this._workflows.delete(id);
		this._onDidChange.fire();
		console.log(`[WorkflowConfigLoader] Deleted workflow: ${id}`);
	}

	// ─── Helpers ──────────────────────────────────────────────────────────────

	private _getInverseDirUri(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) return undefined;
		return URI.joinPath(folders[0].uri, INVERSE_DIR);
	}

	private _getWorkflowsDirUri(): URI | undefined {
		const inverseDirUri = this._getInverseDirUri();
		if (!inverseDirUri) return undefined;
		return URI.joinPath(inverseDirUri, WORKFLOWS_DIR);
	}
}
