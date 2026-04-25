/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Workflow Trigger Manager
 *
 * Wires automatic triggers for enabled workflow definitions.
 *
 * ## Supported Triggers
 *
 * | Trigger            | Mechanism                                                     |
 * |--------------------|---------------------------------------------------------------|
 * | file-save          | ITextFileService.onDidSave — filtered by triggerGlob          |
 * | on-commit          | IFileService watch on .git/COMMIT_EDITMSG changes             |
 * | schedule           | setInterval(scheduleIntervalMinutes)                          |
 * | terminal-command   | Runs triggerCommand in background terminal, fires on exit     |
 *
 * ## Lifecycle
 *
 * Call refresh(workflows) whenever the workflow registry changes.
 * The manager tears down and rebuilds all listeners on each refresh.
 * Debouncing ensures rapid saves or overlapping intervals don't double-fire.
 */

import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IFileService, FileChangesEvent } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import { URI } from '../../../../base/common/uri.js';
import { isWindows } from '../../../../base/common/platform.js';
import { match as globMatch } from '../../../../base/common/glob.js';
import { IWorkflowDefinition, WorkflowTrigger } from '../common/workflowTypes.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TERMINAL_CMD_INTERVAL_MINUTES = 5;
/** Minimum ms between successive firings of the same workflow (debounce) */
const TRIGGER_DEBOUNCE_MS = 2000;

// ─── Trigger Manager ──────────────────────────────────────────────────────────

export class WorkflowTriggerManager extends Disposable {

	/** workflowId \u2192 timestamp of last fire, for debouncing */
	private readonly _lastFired = new Map<string, number>();

	/** workflowId \u2192 DisposableStore holding all listeners for that workflow */
	private readonly _wired = new Map<string, DisposableStore>();

	constructor(
		private readonly textFileService: ITextFileService,
		private readonly fileService: IFileService,
		private readonly workspaceContextService: IWorkspaceContextService,
		private readonly terminalService: ITerminalService,
		/** Called when a trigger fires — WorkflowAgentService.runWorkflow() */
		private readonly onTrigger: (workflowId: string, trigger: WorkflowTrigger, context?: string) => void,
	) {
		super();
	}

	// ─── Public API ───────────────────────────────────────────────────────────

	/**
	 * Tear down all existing listeners and rebuild from the given workflow list.
	 * Call whenever the workflow registry is reloaded.
	 */
	refresh(workflows: IWorkflowDefinition[]): void {
		// Dispose all existing wires
		for (const [, store] of this._wired) {
			store.dispose();
		}
		this._wired.clear();

		const autoTriggers = workflows.filter(
			wf => wf.enabled && wf.trigger !== 'manual',
		);

		for (const wf of autoTriggers) {
			const store = new DisposableStore();
			this._wired.set(wf.id, store);
			this._wire(wf, store);
			console.log(`[WorkflowTriggerManager] Wired trigger "${wf.trigger}" for workflow: ${wf.id}`);
		}
	}

	override dispose(): void {
		for (const [, store] of this._wired) {
			store.dispose();
		}
		this._wired.clear();
		super.dispose();
	}

	// ─── Wiring ───────────────────────────────────────────────────────────────

	private _wire(wf: IWorkflowDefinition, store: DisposableStore): void {
		switch (wf.trigger) {
			case 'file-save':       this._wireFileSave(wf, store); break;
			case 'on-commit':       this._wireOnCommit(wf, store); break;
			case 'schedule':        this._wireSchedule(wf, store); break;
			case 'terminal-command': this._wireTerminalCommand(wf, store); break;
		}
	}

	// ── file-save ─────────────────────────────────────────────────────────────

	private _wireFileSave(wf: IWorkflowDefinition, store: DisposableStore): void {
		store.add(this.textFileService.files.onDidSave(e => {
			// Filter by glob if configured
			if (wf.triggerGlob) {
				const relativePath = this._toRelativePath(e.model.resource);
				if (!relativePath) return;
				if (!globMatch(wf.triggerGlob, relativePath)) return;
			}
			this._fire(wf.id, 'file-save', e.model.resource.fsPath);
		}));
	}

	// ── on-commit ─────────────────────────────────────────────────────────────

	private _wireOnCommit(wf: IWorkflowDefinition, store: DisposableStore): void {
		const gitMsgUri = this._gitCommitMsgUri();
		if (!gitMsgUri) {
			console.warn(`[WorkflowTriggerManager] No workspace root — cannot wire on-commit for: ${wf.id}`);
			return;
		}

		// .git/COMMIT_EDITMSG is rewritten after every commit
		store.add(this.fileService.onDidFilesChange((e: FileChangesEvent) => {
			if (e.contains(gitMsgUri)) {
				this._fire(wf.id, 'on-commit');
			}
		}));
	}

	// ── schedule ──────────────────────────────────────────────────────────────

	private _wireSchedule(wf: IWorkflowDefinition, store: DisposableStore): void {
		const minutes = wf.scheduleIntervalMinutes ?? 60;
		const ms = minutes * 60 * 1000;
		const id = setInterval(() => {
			this._fire(wf.id, 'schedule');
		}, ms);
		store.add(toDisposable(() => clearInterval(id)));
		console.log(`[WorkflowTriggerManager] Scheduled "${wf.id}" every ${minutes} min`);
	}

	// ── terminal-command ──────────────────────────────────────────────────────

	/**
	 * Runs `wf.triggerCommand` in a dedicated background terminal on a poll
	 * interval (scheduleIntervalMinutes, default 5 min).
	 *
	 * Exit detection uses a sentinel file written by the shell wrapper:
	 *   command && echo "0" > sentinel || echo "1" > sentinel
	 *
	 * This matches the write-access sentinel pattern used throughout .inverse/.
	 */
	private _wireTerminalCommand(wf: IWorkflowDefinition, store: DisposableStore): void {
		if (!wf.triggerCommand?.trim()) {
			console.warn(`[WorkflowTriggerManager] terminal-command trigger for "${wf.id}" has no triggerCommand`);
			return;
		}

		const intervalMinutes = wf.scheduleIntervalMinutes ?? DEFAULT_TERMINAL_CMD_INTERVAL_MINUTES;
		const intervalMs = intervalMinutes * 60 * 1000;
		const expectedExit = wf.triggerOnExit ?? 'failure';

		const runCheck = async () => {
			const workspaceRoot = this._workspaceRoot();
			if (!workspaceRoot) return;

			const sentinelUri = URI.joinPath(workspaceRoot, `.inverse_trigger_${wf.id}_exit`);
			try { await this.fileService.del(sentinelUri); } catch { }

			const terminal = await this._getOrCreateTerminal(`Inverse Trigger: ${wf.id}`);
			const cmd = wf.triggerCommand!.trim();
			const sentinelPath = sentinelUri.fsPath;

			let shellCmd: string;
			if (isWindows) {
				shellCmd = `(${cmd}) && echo 0 > "${sentinelPath}" || echo 1 > "${sentinelPath}"`;
			} else {
				shellCmd = `(${cmd}); echo $? > "${sentinelPath}"`;
			}
			terminal.sendText(shellCmd, true);

			// Poll for sentinel (max 5 min)
			const exitCodeStr = await this._waitForFileContent(sentinelUri, 300_000);
			try { await this.fileService.del(sentinelUri); } catch { }

			if (exitCodeStr === null) {
				console.warn(`[WorkflowTriggerManager] Timeout waiting for command exit: ${cmd}`);
				return;
			}

			const exitCode = parseInt(exitCodeStr.trim(), 10);
			const succeeded = exitCode === 0;

			const shouldFire =
				expectedExit === 'any' ||
				(expectedExit === 'success' && succeeded) ||
				(expectedExit === 'failure' && !succeeded);

			if (shouldFire) {
				console.log(`[WorkflowTriggerManager] terminal-command "${cmd}" exited ${exitCode} — firing "${wf.id}"`);
				this._fire(wf.id, 'terminal-command', `exit:${exitCode}`);
			}
		};

		// Initial run after a short delay, then on interval
		const initialDelay = setTimeout(() => runCheck(), 10_000);
		const id = setInterval(() => runCheck(), intervalMs);

		store.add(toDisposable(() => {
			clearTimeout(initialDelay);
			clearInterval(id);
		}));

		console.log(`[WorkflowTriggerManager] terminal-command "${wf.triggerCommand}" for "${wf.id}" — polling every ${intervalMinutes} min, fires on: ${expectedExit}`);
	}

	// ─── Helpers ──────────────────────────────────────────────────────────────

	private _fire(workflowId: string, trigger: WorkflowTrigger, context?: string): void {
		const now = Date.now();
		const last = this._lastFired.get(workflowId) ?? 0;
		if (now - last < TRIGGER_DEBOUNCE_MS) return;
		this._lastFired.set(workflowId, now);
		console.log(`[WorkflowTriggerManager] Firing workflow "${workflowId}" via ${trigger}${context ? ` (${context})` : ''}`);
		this.onTrigger(workflowId, trigger, context);
	}

	private _workspaceRoot(): URI | undefined {
		return this.workspaceContextService.getWorkspace().folders[0]?.uri;
	}

	private _toRelativePath(uri: URI): string | undefined {
		const root = this._workspaceRoot();
		if (!root) return undefined;
		const rootPath = root.fsPath.endsWith('/') ? root.fsPath : root.fsPath + '/';
		const filePath = uri.fsPath;
		return filePath.startsWith(rootPath) ? filePath.slice(rootPath.length) : undefined;
	}

	private _gitCommitMsgUri(): URI | undefined {
		const root = this._workspaceRoot();
		if (!root) return undefined;
		return URI.joinPath(root, '.git', 'COMMIT_EDITMSG');
	}

	private async _getOrCreateTerminal(name: string) {
		let t = this.terminalService.instances.find(inst => inst.title === name);
		if (!t) {
			t = await this.terminalService.createTerminal({ config: { name, isTransient: true } });
		}
		return t;
	}

	private async _waitForFileContent(uri: URI, timeoutMs: number): Promise<string | null> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			try {
				if (await this.fileService.exists(uri)) {
					const raw = await this.fileService.readFile(uri);
					return raw.value.toString();
				}
			} catch { }
			await new Promise<void>(r => setTimeout(r, 500));
		}
		return null;
	}
}
