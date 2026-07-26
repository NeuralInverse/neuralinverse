/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { URI } from '../../../../base/common/uri.js';
import {
	IBackgroundTask,
	IBackgroundTaskRequest,
	BackgroundTaskStatus,
	MAX_CONCURRENT_BACKGROUND_AGENTS,
} from '../common/backgroundAgentTypes.js';
import { IWorkflowAgentService } from './workflowAgentService.js';
import { IExternalCommandExecutor } from '../../../contrib/void/browser/externalCommandExecutor.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';

// ─── Service Interface ────────────────────────────────────────────────────────

export const IBackgroundAgentService = createDecorator<IBackgroundAgentService>('backgroundAgentService');

export interface IBackgroundAgentService {
	readonly _serviceBrand: undefined;
	readonly tasks: ReadonlyMap<string, IBackgroundTask>;
	readonly onDidChangeTask: Event<IBackgroundTask>;
	readonly runningCount: number;

	spawn(request: IBackgroundTaskRequest): IBackgroundTask;
	cancel(taskId: string): void;
	getTaskDiff(taskId: string): Promise<string>;
	removeTask(taskId: string): void;
}

// ─── Implementation ──────────────────────────────────────────────────────────

class BackgroundAgentService extends Disposable implements IBackgroundAgentService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeTask = this._register(new Emitter<IBackgroundTask>());
	readonly onDidChangeTask = this._onDidChangeTask.event;

	private readonly _tasks = new Map<string, IBackgroundTask>();
	private readonly _cancellations = new Map<string, { cancelled: boolean }>();
	private readonly _queue: string[] = [];
	private _running = 0;

	get tasks(): ReadonlyMap<string, IBackgroundTask> { return this._tasks; }
	get runningCount() { return this._running; }

	constructor(
		@IWorkspaceContextService private readonly _workspaceContext: IWorkspaceContextService,
		@IWorkflowAgentService private readonly _workflowAgentService: IWorkflowAgentService,
		@IExternalCommandExecutor private readonly _executor: IExternalCommandExecutor,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
	) {
		super();
	}

	spawn(request: IBackgroundTaskRequest): IBackgroundTask {
		const id = generateUuid().slice(0, 8);
		const branchName = request.branchName || `ni/bg/${id}`;
		const baseBranch = request.baseBranch || 'HEAD';
		const worktreePath = URI.joinPath(this._environmentService.tmpDir, `ni-bg-${id}`).fsPath;

		const task: IBackgroundTask = {
			id,
			request,
			status: 'queued',
			branchName,
			baseBranch,
			worktreePath,
			progress: [],
			commits: [],
		};

		this._tasks.set(id, task);
		this._queue.push(id);
		this._onDidChangeTask.fire(task);
		this._drain();
		return task;
	}

	cancel(taskId: string): void {
		const task = this._tasks.get(taskId);
		if (!task) return;

		const token = this._cancellations.get(taskId);
		if (token) { token.cancelled = true; }

		const queueIdx = this._queue.indexOf(taskId);
		if (queueIdx >= 0) { this._queue.splice(queueIdx, 1); }

		if (task.status !== 'completed' && task.status !== 'failed') {
			this._setStatus(task, 'cancelled');
			this._cleanup(task);
		}
	}

	async getTaskDiff(taskId: string): Promise<string> {
		const task = this._tasks.get(taskId);
		if (!task) return '';
		const folder = this._getWorkspaceRoot();
		if (!folder) return '';
		const result = await this._gitExec(['diff', `${task.baseBranch}...${task.branchName}`], folder);
		return result.stdout;
	}

	removeTask(taskId: string): void {
		const task = this._tasks.get(taskId);
		if (!task) return;
		if (task.status === 'running' || task.status === 'branching' || task.status === 'committing') {
			this.cancel(taskId);
		}
		this._tasks.delete(taskId);
		this._cancellations.delete(taskId);
		this._onDidChangeTask.fire(task);
	}

	// ─── Internal ────────────────────────────────────────────────────────────

	private _drain(): void {
		while (this._running < MAX_CONCURRENT_BACKGROUND_AGENTS && this._queue.length > 0) {
			const taskId = this._queue.shift()!;
			const task = this._tasks.get(taskId);
			if (!task || task.status === 'cancelled') continue;
			this._running++;
			this._executeTask(task).finally(() => {
				this._running--;
				this._drain();
			});
		}
	}

	private async _executeTask(task: IBackgroundTask): Promise<void> {
		const cancellation = { cancelled: false };
		this._cancellations.set(task.id, cancellation);

		const folder = this._getWorkspaceRoot();
		if (!folder) {
			task.error = 'No workspace folder open';
			this._setStatus(task, 'failed');
			return;
		}

		try {
			// 1. Create worktree + branch
			this._setStatus(task, 'branching');
			task.startedAt = Date.now();

			const baseBranch = task.baseBranch === 'HEAD' ? await this._getCurrentBranch(folder) : task.baseBranch;
			task.baseBranch = baseBranch;

			const worktreeResult = await this._gitExec(
				['worktree', 'add', task.worktreePath, '-b', task.branchName],
				folder
			);
			if (worktreeResult.exitCode !== 0) {
				throw new Error(`git worktree add failed: ${worktreeResult.stderr}`);
			}
			task.progress.push(`Created worktree at ${task.worktreePath}`);
			task.progress.push(`Branch: ${task.branchName} (base: ${baseBranch})`);
			this._onDidChangeTask.fire(task);

			if (cancellation.cancelled) { this._setStatus(task, 'cancelled'); return; }

			// 2. Run agent — uses the workflow orchestrator for LLM-driven tool execution.
			// The agent reads/writes files in the worktree and commits its changes.
			this._setStatus(task, 'running');
			task.progress.push('Agent started — executing task...');
			this._onDidChangeTask.fire(task);

			await this._runAgentLoop(task, cancellation);

			if (cancellation.cancelled) { this._setStatus(task, 'cancelled'); return; }

			// 3. Final commit if uncommitted changes exist
			this._setStatus(task, 'committing');
			const statusResult = await this._gitExec(['status', '--porcelain'], task.worktreePath);
			if (statusResult.stdout.trim()) {
				await this._gitExec(['add', '-A'], task.worktreePath);
				await this._gitExec(['commit', '-m', 'chore: final uncommitted changes'], task.worktreePath);
			}

			// 4. Capture commits
			const logResult = await this._gitExec(
				['log', `${task.baseBranch}..${task.branchName}`, '--oneline'],
				task.worktreePath
			);
			task.commits = logResult.stdout.trim().split('\n').filter(Boolean);
			task.progress.push(`Completed with ${task.commits.length} commit(s)`);

			// 5. Optional PR
			if (task.request.createPR) {
				const pushResult = await this._gitExec(['push', '-u', 'origin', task.branchName], folder);
				if (pushResult.exitCode !== 0) {
					task.progress.push(`Push failed: ${pushResult.stderr}`);
				} else {
					const prResult = await this._shellExec(
						`gh pr create --title ${JSON.stringify(task.request.title)} --body ${JSON.stringify(`Background agent task: ${task.request.description}`)} --head ${task.branchName}`,
						folder
					);
					task.progress.push(prResult.exitCode === 0 ? `PR created: ${prResult.stdout.trim()}` : `PR failed: ${prResult.stderr}`);
				}
			}

			task.completedAt = Date.now();
			this._setStatus(task, 'completed');

		} catch (e: any) {
			task.error = e.message;
			task.completedAt = Date.now();
			this._setStatus(task, 'failed');
		} finally {
			this._cleanup(task);
		}
	}

	private async _runAgentLoop(task: IBackgroundTask, cancellation: { cancelled: boolean }): Promise<void> {
		await this._workflowAgentService.runQuickAgent(
			task.request.description,
			task.worktreePath,
			(line: string) => {
				task.progress.push(line);
				this._onDidChangeTask.fire(task);
				if (cancellation.cancelled) {
					const err = new Error('cancelled');
					(err as any).cancelled = true;
					throw err;
				}
			},
			cancellation,
		);
	}

	private async _cleanup(task: IBackgroundTask): Promise<void> {
		const folder = this._getWorkspaceRoot();
		if (!folder) return;
		try {
			await this._gitExec(['worktree', 'remove', task.worktreePath, '--force'], folder);
		} catch {
			// Best effort
		}
	}

	private _setStatus(task: IBackgroundTask, status: BackgroundTaskStatus): void {
		task.status = status;
		this._onDidChangeTask.fire(task);
	}

	private _getWorkspaceRoot(): string | undefined {
		const folders = this._workspaceContext.getWorkspace().folders;
		return folders[0]?.uri.fsPath;
	}

	private async _getCurrentBranch(cwd: string): Promise<string> {
		const result = await this._gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
		return result.stdout.trim() || 'main';
	}

	// ─── Shell execution via IExternalCommandExecutor ─────────────────────────
	// Uses the terminal-backed executor — the correct pattern for browser/ code
	// in this sandboxed Electron environment (no globalThis.require available).

	private async _gitExec(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const command = `git ${args.map(a => /\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a).join(' ')}`;
		return this._shellExec(command, cwd);
	}

	private async _shellExec(command: string, cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		// Use cmd /c on Windows so exit code is captured as a decimal integer.
		// PowerShell's $? is a boolean (True/False) so we cannot use it reliably.
		const sentinel = `__NI_EXIT__`;
		const cdCmd = `cd /d "${cwd.replace(/"/g, '\\"')}"`;
		const wrapped = `cmd /c "${cdCmd} && (${command}) & echo ${sentinel}:%ERRORLEVEL%"`;

		try {
			const jobId = `ni-bg-${generateUuid().slice(0, 6)}`;
			const raw = await this._executor.execute(jobId, wrapped, 60_000, 4 * 1024 * 1024);

			const sentinelIdx = raw.lastIndexOf(`${sentinel}:`);
			if (sentinelIdx === -1) {
				// No sentinel — return full output as stderr so the caller sees the real error
				return { stdout: '', stderr: raw.trim(), exitCode: 1 };
			}

			// Everything before the sentinel is the command's combined stdout+stderr
			const output = raw.slice(0, sentinelIdx).trimEnd();
			const exitCodeStr = raw.slice(sentinelIdx + sentinel.length + 1).trim();
			const exitCode = parseInt(exitCodeStr, 10);
			// Route output to stderr when the command failed so error messages reach task.error
			return exitCode === 0
				? { stdout: output, stderr: '', exitCode: 0 }
				: { stdout: '', stderr: output, exitCode: isNaN(exitCode) ? 1 : exitCode };
		} catch (e: any) {
			return { stdout: '', stderr: e.message ?? String(e), exitCode: 1 };
		}
	}
}

registerSingleton(IBackgroundAgentService, BackgroundAgentService, InstantiationType.Delayed);
