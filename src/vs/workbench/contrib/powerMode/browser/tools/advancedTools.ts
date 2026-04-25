/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * Advanced Power Mode tools.
 *
 * High-priority core workflow tools and advanced productivity tools.
 */

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IExternalCommandExecutor } from '../../../neuralInverseChecks/browser/engine/services/externalCommandExecutor.js';
import { IPowerTool, IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { definePowerTool } from './powerToolRegistry.js';

// \u2500\u2500\u2500 ask_user: Ask clarifying questions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function createAskUserTool(
	askUserCallback: (question: string, sessionId: string) => Promise<string>
): IPowerTool {
	return definePowerTool(
		'ask_user',
		`Ask the user a clarifying question and wait for their response.

Rules:
- Use this when you need user input to proceed
- Keep questions clear and specific
- Don't ask obvious questions - only when genuinely unclear
- The agent loop will pause until the user responds`,
		[
			{ name: 'question', type: 'string', description: 'The question to ask the user', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const question = args.question as string;
			ctx.metadata({ title: 'Asking user...' });

			const answer = await askUserCallback(question, ctx.sessionId);

			return {
				title: 'User response',
				output: answer,
				metadata: { question, answer },
			};
		},
	);
}

// \u2500\u2500\u2500 web_fetch: Fetch external docs/APIs \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function createWebFetchTool(): IPowerTool {
	return definePowerTool(
		'web_fetch',
		`Fetch content from a URL. Supports documentation sites, APIs, GitHub files, etc.

Rules:
- Use this to read external documentation, API schemas, GitHub files
- Returns text content (HTML is stripped to plain text)
- Timeout: 30 seconds
- Max size: 100KB`,
		[
			{ name: 'url', type: 'string', description: 'The URL to fetch', required: true },
			{ name: 'description', type: 'string', description: 'Brief description of what you are fetching', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const url = args.url as string;
			const description = args.description as string;

			ctx.metadata({ title: description });

			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 30000);

				const response = await fetch(url, {
					signal: controller.signal,
					headers: {
						'User-Agent': 'Neural-Inverse-Power-Mode/1.0',
					},
				});
				clearTimeout(timeoutId);

				if (!response.ok) {
					return {
						title: description,
						output: `HTTP ${response.status}: ${response.statusText}`,
						metadata: { url, error: true, status: response.status },
					};
				}

				const contentType = response.headers.get('content-type') || '';
				let content = await response.text();

				// Strip HTML tags if content is HTML
				if (contentType.includes('text/html')) {
					content = content
						.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
						.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
						.replace(/<[^>]+>/g, ' ')
						.replace(/\s+/g, ' ')
						.trim();
				}

				// Truncate if too large
				const MAX_SIZE = 100 * 1024;
				if (content.length > MAX_SIZE) {
					content = content.substring(0, MAX_SIZE) + '\n[Content truncated at 100KB]';
				}

				return {
					title: description,
					output: content,
					metadata: { url, contentType, size: content.length },
				};
			} catch (err: any) {
				return {
					title: description,
					output: `Error fetching URL: ${err.message}`,
					metadata: { url, error: true },
				};
			}
		},
	);
}

// \u2500\u2500\u2500 Task Management Tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface ITask {
	id: string;
	title: string;
	status: 'pending' | 'in_progress' | 'completed' | 'blocked';
	description?: string;
	createdAt: number;
	updatedAt: number;
	metadata?: Record<string, any>;
}

class TaskStore {
	private tasks = new Map<string, ITask>();
	private idCounter = 0;

	create(title: string, description?: string, metadata?: Record<string, any>): ITask {
		const id = `task_${++this.idCounter}`;
		const task: ITask = {
			id,
			title,
			description,
			status: 'pending',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			metadata,
		};
		this.tasks.set(id, task);
		return task;
	}

	update(id: string, updates: Partial<ITask>): ITask | null {
		const task = this.tasks.get(id);
		if (!task) { return null; }
		Object.assign(task, updates, { updatedAt: Date.now() });
		return task;
	}

	get(id: string): ITask | undefined {
		return this.tasks.get(id);
	}

	list(): ITask[] {
		return [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	delete(id: string): boolean {
		return this.tasks.delete(id);
	}
}

export const globalTaskStore = new TaskStore();

export function createTaskCreateTool(): IPowerTool {
	return definePowerTool(
		'tasks_create',
		`Create a trackable TASK for multi-step workflows (NOT for creating files/directories).

WARNING: Only use for COMPLEX, MULTI-SESSION work. Do NOT use for simple operations.

Good use cases:
- Large migrations spanning 10+ files that take multiple sessions
- Multi-day refactoring projects
- Complex feature implementations with many steps
- When user explicitly asks for task tracking

DO NOT use for:
- Simple bug fixes (just fix it)
- Single-file edits
- Quick operations that complete in one message
- Normal development work

Tasks persist across messages and can be updated.`,
		[
			{ name: 'title', type: 'string', description: 'Short task title', required: true },
			{ name: 'description', type: 'string', description: 'Optional detailed description', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const title = args.title as string;
			const description = args.description as string | undefined;

			const task = globalTaskStore.create(title, description);

			return {
				title: `Task created: ${task.id}`,
				output: `Created task: ${task.title}\nID: ${task.id}\nStatus: ${task.status}`,
				metadata: { taskId: task.id },
			};
		},
	);
}

export function createTaskListTool(): IPowerTool {
	return definePowerTool(
		'tasks_list',
		`List all TASKS (workflow tracking). NOT for listing files/directories - use 'list' for that.

Shows all tasks created with task_create, including their ID, title, and status.`,
		[],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const tasks = globalTaskStore.list();

			if (tasks.length === 0) {
				return {
					title: 'No tasks',
					output: 'No tasks have been created yet. Use task_create to create one.',
					metadata: { count: 0 },
				};
			}

			const lines = tasks.map(t => {
				const status = t.status === 'in_progress' ? '\u27F3' : t.status === 'completed' ? '\u2713' : t.status === 'blocked' ? '\u2717' : '·';
				return `${status} ${t.id} - ${t.title} [${t.status}]`;
			});

			return {
				title: `${tasks.length} tasks`,
				output: lines.join('\n'),
				metadata: { count: tasks.length },
			};
		},
	);
}

export function createTaskUpdateTool(): IPowerTool {
	return definePowerTool(
		'tasks_update',
		`Update a TASK's status or details (for workflow tracking, not filesystem).`,
		[
			{ name: 'taskId', type: 'string', description: 'The task ID to update', required: true },
			{ name: 'status', type: 'string', description: 'New status: pending, in_progress, completed, blocked', required: false },
			{ name: 'title', type: 'string', description: 'Updated title', required: false },
			{ name: 'description', type: 'string', description: 'Updated description', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const taskId = args.taskId as string;
			const updates: Partial<ITask> = {};

			if (args.status) { updates.status = args.status as any; }
			if (args.title) { updates.title = args.title as string; }
			if (args.description) { updates.description = args.description as string; }

			const task = globalTaskStore.update(taskId, updates);

			if (!task) {
				return {
					title: 'Task not found',
					output: `No task found with ID: ${taskId}`,
					metadata: { error: true },
				};
			}

			return {
				title: `Updated ${taskId}`,
				output: `Task: ${task.title}\nStatus: ${task.status}`,
				metadata: { taskId: task.id },
			};
		},
	);
}

export function createTaskGetTool(): IPowerTool {
	return definePowerTool(
		'tasks_get',
		`Get details of a specific TASK by ID (for workflow tracking).`,
		[
			{ name: 'taskId', type: 'string', description: 'The task ID', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const taskId = args.taskId as string;
			const task = globalTaskStore.get(taskId);

			if (!task) {
				return {
					title: 'Task not found',
					output: `No task found with ID: ${taskId}`,
					metadata: { error: true },
				};
			}

			const details = [
				`ID: ${task.id}`,
				`Title: ${task.title}`,
				`Status: ${task.status}`,
				task.description ? `Description: ${task.description}` : null,
				`Created: ${new Date(task.createdAt).toLocaleString()}`,
				`Updated: ${new Date(task.updatedAt).toLocaleString()}`,
			].filter(Boolean).join('\n');

			return {
				title: task.title,
				output: details,
				metadata: { taskId: task.id },
			};
		},
	);
}

// \u2500\u2500\u2500 Git Tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function createGitStatusTool(
	workingDirectory: string,
	commandExecutor: IExternalCommandExecutor
): IPowerTool {
	return definePowerTool(
		'git_status',
		`Get the current Git repository status. Shows uncommitted changes, current branch, etc.`,
		[],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			ctx.metadata({ title: 'Git status' });

			const commands = [
				'git rev-parse --is-inside-work-tree 2>/dev/null',
				'git rev-parse --abbrev-ref HEAD',
				'git status --short',
				'git log -1 --oneline',
			];

			const fullCommand = `cd ${_shellQuote(workingDirectory)} && ${commands.join(' && echo "---" && ')}`;
			const jobId = `git_status_${Date.now()}`;

			try {
				const output = await commandExecutor.execute(jobId, fullCommand, 10000, 50 * 1024);
				const [isRepo, branch, status, lastCommit] = output.split('---').map(s => s.trim());

				if (isRepo !== 'true') {
					return {
						title: 'Not a Git repository',
						output: 'Current directory is not inside a Git repository',
						metadata: { isRepo: false },
					};
				}

				const result = [
					`Branch: ${branch}`,
					`Last commit: ${lastCommit}`,
					status ? `\nChanges:\n${status}` : '\nNo changes',
				].join('\n');

				return {
					title: 'Git status',
					output: result,
					metadata: { branch, hasChanges: !!status },
				};
			} catch (err: any) {
				return {
					title: 'Git status error',
					output: `Error: ${err.message}`,
					metadata: { error: true },
				};
			}
		},
	);
}

export function createGitDiffTool(
	workingDirectory: string,
	commandExecutor: IExternalCommandExecutor
): IPowerTool {
	return definePowerTool(
		'git_diff',
		`Show Git diff for uncommitted changes or between commits.`,
		[
			{ name: 'target', type: 'string', description: 'Optional: file path or commit reference (default: staged changes)', required: false },
			{ name: 'cached', type: 'boolean', description: 'Show staged changes (default: true)', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const target = args.target as string | undefined;
			const cached = args.cached !== false;

			ctx.metadata({ title: 'Git diff' });

			let command = 'git diff';
			if (cached) { command += ' --cached'; }
			if (target) { command += ` ${target}`; }

			const fullCommand = `cd ${_shellQuote(workingDirectory)} && ${command}`;
			const jobId = `git_diff_${Date.now()}`;

			try {
				const output = await commandExecutor.execute(jobId, fullCommand, 10000, 100 * 1024);

				if (!output.trim()) {
					return {
						title: 'No changes',
						output: cached ? 'No staged changes' : 'No uncommitted changes',
						metadata: { hasChanges: false },
					};
				}

				return {
					title: 'Git diff',
					output: output,
					metadata: { hasChanges: true, cached },
				};
			} catch (err: any) {
				return {
					title: 'Git diff error',
					output: `Error: ${err.message}`,
					metadata: { error: true },
				};
			}
		},
	);
}

export function createGitCommitTool(
	workingDirectory: string,
	commandExecutor: IExternalCommandExecutor
): IPowerTool {
	return definePowerTool(
		'git_commit',
		`Commit staged changes with a message.

Rules:
- Changes must already be staged (use bash tool with 'git add' first)
- Message should follow conventional commit format
- This will create a commit but NOT push it`,
		[
			{ name: 'message', type: 'string', description: 'Commit message', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const message = args.message as string;

			ctx.metadata({ title: 'Committing...' });

			// Check for staged changes first
			const checkCommand = `cd ${_shellQuote(workingDirectory)} && git diff --cached --quiet && echo "no_changes" || echo "has_changes"`;
			const checkJobId = `git_check_${Date.now()}`;

			try {
				const checkOutput = await commandExecutor.execute(checkJobId, checkCommand, 5000, 1024);
				if (checkOutput.trim() === 'no_changes') {
					return {
						title: 'No staged changes',
						output: 'Nothing to commit (no staged changes). Use git add first.',
						metadata: { committed: false },
					};
				}
			} catch {
				// Continue anyway - the commit will fail with a clear error if there's nothing staged
			}

			// Commit
			const commitCommand = `cd ${_shellQuote(workingDirectory)} && git commit -m ${_shellQuote(message)}`;
			const commitJobId = `git_commit_${Date.now()}`;

			try {
				const output = await commandExecutor.execute(commitJobId, commitCommand, 10000, 10 * 1024);
				return {
					title: 'Committed',
					output: output,
					metadata: { committed: true, message },
				};
			} catch (err: any) {
				return {
					title: 'Commit failed',
					output: `Error: ${err.message}${err.stderr ? '\n' + err.stderr : ''}`,
					metadata: { committed: false, error: true },
				};
			}
		},
	);
}

// \u2500\u2500\u2500 Memory Tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function createMemoryWriteTool(
	workingDirectory: string,
	fileService: IFileService
): IPowerTool {
	return definePowerTool(
		'memory_write',
		`Write a persistent memory note. Memories persist across sessions.

Use this to remember:
- User preferences and project conventions
- Important architectural decisions
- Recurring patterns or issues in the codebase`,
		[
			{ name: 'key', type: 'string', description: 'Memory key (e.g., "user_preferences", "architecture_notes")', required: true },
			{ name: 'content', type: 'string', description: 'The content to remember', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const key = args.key as string;
			const content = args.content as string;

			const memoryDir = `${workingDirectory}/.powermode-memory`;
			const memoryFile = `${memoryDir}/${key}.md`;

			ctx.metadata({ title: `Remember: ${key}` });

			try {
				// Ensure directory exists
				const dirUri = URI.file(memoryDir);
				await fileService.createFolder(dirUri).catch(() => { /* already exists */ });

				// Write memory
				const fileUri = URI.file(memoryFile);
				const buffer = VSBuffer.fromString(content);
				await fileService.writeFile(fileUri, buffer);

				return {
					title: `Remembered: ${key}`,
					output: `Memory saved to ${memoryFile}`,
					metadata: { key, file: memoryFile },
				};
			} catch (err: any) {
				return {
					title: 'Memory write error',
					output: `Error: ${err.message}`,
					metadata: { error: true },
				};
			}
		},
	);
}

export function createMemoryReadTool(
	workingDirectory: string,
	fileService: IFileService
): IPowerTool {
	return definePowerTool(
		'memory_read',
		`Read a persistent memory note by key.`,
		[
			{ name: 'key', type: 'string', description: 'Memory key to retrieve', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const key = args.key as string;
			const memoryFile = `${workingDirectory}/.powermode-memory/${key}.md`;

			ctx.metadata({ title: `Recall: ${key}` });

			try {
				const fileUri = URI.file(memoryFile);
				const content = await fileService.readFile(fileUri);
				const text = content.value.toString();

				return {
					title: `Memory: ${key}`,
					output: text,
					metadata: { key },
				};
			} catch (err: any) {
				return {
					title: 'Memory not found',
					output: `No memory found for key: ${key}`,
					metadata: { key, error: true },
				};
			}
		},
	);
}

// \u2500\u2500\u2500 Run Tests Tool \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function createRunTestsTool(
	workingDirectory: string,
	commandExecutor: IExternalCommandExecutor,
	fileService: IFileService
): IPowerTool {
	return definePowerTool(
		'run_tests',
		`Run tests with auto-detected test framework.

Automatically detects: npm/yarn test, pytest, cargo test, go test, etc.`,
		[
			{ name: 'pattern', type: 'string', description: 'Optional: test file pattern or specific test name', required: false },
			{ name: 'timeout', type: 'number', description: 'Timeout in milliseconds (default: 120000)', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const pattern = args.pattern as string | undefined;
			const timeout = (args.timeout as number) ?? 120000;

			ctx.metadata({ title: 'Running tests...' });

			// Auto-detect test framework
			let testCommand: string | null = null;

			try {
				// Check for package.json (Node.js)
				const pkgUri = URI.file(`${workingDirectory}/package.json`);
				const pkgContent = await fileService.readFile(pkgUri);
				const pkg = JSON.parse(pkgContent.value.toString());
				if (pkg.scripts?.test) {
					testCommand = pkg.scripts.test;
					if (pattern) { testCommand += ` ${pattern}`; }
				}
			} catch { /* not a Node.js project */ }

			// Check for other frameworks
			if (!testCommand) {
				const checks = [
					{ file: 'pytest.ini', command: 'pytest' },
					{ file: 'Cargo.toml', command: 'cargo test' },
					{ file: 'go.mod', command: 'go test ./...' },
					{ file: 'pyproject.toml', command: 'pytest' },
				];

				for (const check of checks) {
					try {
						await fileService.stat(URI.file(`${workingDirectory}/${check.file}`));
						testCommand = check.command;
						if (pattern) { testCommand += ` ${pattern}`; }
						break;
					} catch { /* file doesn't exist */ }
				}
			}

			if (!testCommand) {
				return {
					title: 'No test framework detected',
					output: 'Could not detect test framework. Check for package.json, pytest.ini, Cargo.toml, or go.mod',
					metadata: { error: true },
				};
			}

			// Run tests
			const fullCommand = `cd ${_shellQuote(workingDirectory)} && ${testCommand}`;
			const jobId = `tests_${Date.now()}`;

			try {
				const output = await commandExecutor.execute(jobId, fullCommand, timeout, 200 * 1024);

				// Parse for pass/fail counts (basic heuristics)
				const passed = (output.match(/\b\d+\s+passed/i)?.[0] || '').match(/\d+/)?.[0];
				const failed = (output.match(/\b\d+\s+failed/i)?.[0] || '').match(/\d+/)?.[0];

				return {
					title: failed && parseInt(failed) > 0 ? 'Tests failed' : 'Tests passed',
					output: output,
					metadata: { passed, failed, command: testCommand },
				};
			} catch (err: any) {
				return {
					title: 'Tests failed',
					output: `Error: ${err.message}${err.stderr ? '\n' + err.stderr : ''}`,
					metadata: { error: true, command: testCommand },
				};
			}
		},
	);
}

// \u2500\u2500\u2500 tasks_delete \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function createTaskDeleteTool(): IPowerTool {
	return definePowerTool(
		'tasks_delete',
		`Delete a TASK permanently. Only use when a task is no longer relevant.`,
		[
			{ name: 'taskId', type: 'string', description: 'The task ID to delete', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const taskId = args.taskId as string;
			const task = globalTaskStore.get(taskId);

			if (!task) {
				return { title: 'Task not found', output: `No task found with ID: ${taskId}`, metadata: { error: true } };
			}

			const title = task.title;
			globalTaskStore.delete(taskId);

			return {
				title: `Deleted task`,
				output: `Task deleted: ${title} (${taskId})`,
				metadata: { taskId },
			};
		},
	);
}

// \u2500\u2500\u2500 Memory List / Delete / Search \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function createMemoryListTool(
	workingDirectory: string,
	fileService: IFileService
): IPowerTool {
	return definePowerTool(
		'memory_list',
		`List all persistent memory entries. Shows all saved memory keys.`,
		[],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const memoryDir = `${workingDirectory}/.powermode-memory`;
			ctx.metadata({ title: 'Listing memories' });

			try {
				const dirUri = URI.file(memoryDir);
				const resolved = await fileService.resolve(dirUri);
				const entries = (resolved.children ?? [])
					.filter(c => !c.isDirectory && c.name.endsWith('.md'))
					.map(c => c.name.replace(/\.md$/, ''))
					.sort();

				if (entries.length === 0) {
					return { title: 'No memories', output: 'No memory entries found. Use memory_write to save one.', metadata: { count: 0 } };
				}

				return {
					title: `${entries.length} memories`,
					output: entries.map(k => `\u2022 ${k}`).join('\n'),
					metadata: { count: entries.length },
				};
			} catch {
				return { title: 'No memories', output: 'Memory directory does not exist yet. Use memory_write to create a memory.', metadata: { count: 0 } };
			}
		},
	);
}

export function createMemoryDeleteTool(
	workingDirectory: string,
	fileService: IFileService
): IPowerTool {
	return definePowerTool(
		'memory_delete',
		`Delete a persistent memory entry by key.`,
		[
			{ name: 'key', type: 'string', description: 'Memory key to delete', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const key = args.key as string;
			const memoryFile = `${workingDirectory}/.powermode-memory/${key}.md`;
			ctx.metadata({ title: `Forget: ${key}` });

			try {
				const fileUri = URI.file(memoryFile);
				await fileService.del(fileUri);
				return { title: `Deleted: ${key}`, output: `Memory "${key}" deleted.`, metadata: { key } };
			} catch (err: any) {
				return { title: 'Delete error', output: `Error: ${err.message}`, metadata: { error: true } };
			}
		},
	);
}

export function createMemorySearchTool(
	workingDirectory: string,
	fileService: IFileService
): IPowerTool {
	return definePowerTool(
		'memory_search',
		`Search memory entries for a keyword. Returns entries whose key or content contains the query.`,
		[
			{ name: 'query', type: 'string', description: 'Search keyword or phrase', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const query = (args.query as string).toLowerCase();
			const memoryDir = `${workingDirectory}/.powermode-memory`;
			ctx.metadata({ title: `Search memories: ${query}` });

			try {
				const dirUri = URI.file(memoryDir);
				const resolved = await fileService.resolve(dirUri);
				const entries = (resolved.children ?? []).filter(c => !c.isDirectory && c.name.endsWith('.md'));

				const matches: string[] = [];
				for (const entry of entries) {
					const key = entry.name.replace(/\.md$/, '');
					if (key.toLowerCase().includes(query)) {
						matches.push(`[key match] ${key}`);
						continue;
					}
					try {
						const content = await fileService.readFile(entry.resource);
						const text = content.value.toString();
						if (text.toLowerCase().includes(query)) {
							const preview = text.substring(0, 120).replace(/\n/g, ' ');
							matches.push(`[content] ${key}: ${preview}...`);
						}
					} catch { /* skip unreadable */ }
				}

				if (matches.length === 0) {
					return { title: 'No matches', output: `No memory entries match "${query}".`, metadata: { count: 0 } };
				}

				return {
					title: `${matches.length} match${matches.length !== 1 ? 'es' : ''}`,
					output: matches.join('\n'),
					metadata: { count: matches.length, query },
				};
			} catch {
				return { title: 'No memories', output: 'No memory directory found.', metadata: { count: 0 } };
			}
		},
	);
}

// \u2500\u2500\u2500 Extended Git Tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function createGitLogTool(
	workingDirectory: string,
	commandExecutor: IExternalCommandExecutor
): IPowerTool {
	return definePowerTool(
		'git_log',
		`Show the git commit log.

Returns recent commits with hash, author, date, and message.`,
		[
			{ name: 'count', type: 'number', description: 'Number of commits to show (default: 20)', required: false },
			{ name: 'file', type: 'string', description: 'Optional: show log for a specific file', required: false },
			{ name: 'oneline', type: 'boolean', description: 'Compact one-line format (default: true)', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const count = (args.count as number) ?? 20;
			const file = args.file as string | undefined;
			const oneline = (args.oneline as boolean | undefined) ?? true;

			ctx.metadata({ title: 'Git log' });

			const format = oneline ? '--oneline' : '--pretty=format:"%h  %an  %ad  %s" --date=short';
			const fileArg = file ? ` -- ${_shellQuote(file)}` : '';
			const cmd = `cd ${_shellQuote(workingDirectory)} && git log -${count} ${format}${fileArg}`;
			const jobId = `git_log_${Date.now()}`;

			try {
				const output = await commandExecutor.execute(jobId, cmd, 10_000, 50 * 1024);
				return { title: 'Git log', output: output.trim() || 'No commits found.', metadata: { count } };
			} catch (err: any) {
				return { title: 'Git log error', output: `Error: ${err.message}`, metadata: { error: true } };
			}
		},
	);
}

export function createGitAddTool(
	workingDirectory: string,
	commandExecutor: IExternalCommandExecutor
): IPowerTool {
	return definePowerTool(
		'git_add',
		`Stage files for the next git commit.

Use "." to stage all changes, or specify file paths.`,
		[
			{ name: 'path', type: 'string', description: 'File path or "." to stage all changes', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const path = args.path as string;
			ctx.metadata({ title: `Stage: ${path}` });

			const cmd = `cd ${_shellQuote(workingDirectory)} && git add ${path === '.' ? '.' : _shellQuote(path)} 2>&1`;
			const jobId = `git_add_${Date.now()}`;

			try {
				const output = await commandExecutor.execute(jobId, cmd, 10_000, 10 * 1024);
				return {
					title: `Staged: ${path}`,
					output: output.trim() || `Staged: ${path}`,
					metadata: { path },
				};
			} catch (err: any) {
				return { title: 'Git add error', output: `Error: ${err.message}`, metadata: { error: true } };
			}
		},
	);
}

export function createGitBranchTool(
	workingDirectory: string,
	commandExecutor: IExternalCommandExecutor
): IPowerTool {
	return definePowerTool(
		'git_branch',
		`Manage git branches: list, create, switch, or delete.

action:
- "list"    \u2192 list all branches (default)
- "create"  \u2192 create a new branch (requires name)
- "switch"  \u2192 switch to existing branch (requires name)
- "delete"  \u2192 delete a branch (requires name)`,
		[
			{ name: 'action', type: 'string', description: '"list" (default), "create", "switch", or "delete"', required: false },
			{ name: 'name', type: 'string', description: 'Branch name (required for create/switch/delete)', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const action = (args.action as string | undefined) ?? 'list';
			const name = args.name as string | undefined;

			ctx.metadata({ title: `Branch: ${action}` });

			let cmd: string;
			switch (action) {
				case 'create':
					if (!name) { return { title: 'Error', output: 'name required for create', metadata: { error: true } }; }
					cmd = `cd ${_shellQuote(workingDirectory)} && git checkout -b ${_shellQuote(name)} 2>&1`;
					break;
				case 'switch':
					if (!name) { return { title: 'Error', output: 'name required for switch', metadata: { error: true } }; }
					cmd = `cd ${_shellQuote(workingDirectory)} && git checkout ${_shellQuote(name)} 2>&1`;
					break;
				case 'delete':
					if (!name) { return { title: 'Error', output: 'name required for delete', metadata: { error: true } }; }
					cmd = `cd ${_shellQuote(workingDirectory)} && git branch -d ${_shellQuote(name)} 2>&1`;
					break;
				default:
					cmd = `cd ${_shellQuote(workingDirectory)} && git branch -a 2>&1`;
			}

			const jobId = `git_branch_${Date.now()}`;
			try {
				const output = await commandExecutor.execute(jobId, cmd, 10_000, 20 * 1024);
				return { title: `Branch ${action}`, output: output.trim(), metadata: { action, name } };
			} catch (err: any) {
				return { title: 'Git branch error', output: `Error: ${err.message}`, metadata: { error: true } };
			}
		},
	);
}

export function createGitStashTool(
	workingDirectory: string,
	commandExecutor: IExternalCommandExecutor
): IPowerTool {
	return definePowerTool(
		'git_stash',
		`Manage git stash: save, pop, list, or drop.

action:
- "save"  \u2192 stash current changes (with optional message)
- "pop"   \u2192 apply and remove most recent stash
- "list"  \u2192 list all stashes
- "drop"  \u2192 drop a specific stash (requires index)`,
		[
			{ name: 'action', type: 'string', description: '"save", "pop", "list", or "drop"', required: true },
			{ name: 'message', type: 'string', description: 'Optional stash message (for save)', required: false },
			{ name: 'index', type: 'number', description: 'Stash index to drop (for drop, default: 0)', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const action = args.action as string;
			const message = args.message as string | undefined;
			const index = (args.index as number) ?? 0;

			ctx.metadata({ title: `Stash: ${action}` });

			let cmd: string;
			switch (action) {
				case 'save':
					cmd = `cd ${_shellQuote(workingDirectory)} && git stash push${message ? ` -m ${_shellQuote(message)}` : ''} 2>&1`;
					break;
				case 'pop':
					cmd = `cd ${_shellQuote(workingDirectory)} && git stash pop 2>&1`;
					break;
				case 'list':
					cmd = `cd ${_shellQuote(workingDirectory)} && git stash list 2>&1`;
					break;
				case 'drop':
					cmd = `cd ${_shellQuote(workingDirectory)} && git stash drop stash@{${index}} 2>&1`;
					break;
				default:
					return { title: 'Error', output: `Unknown action: ${action}. Use save, pop, list, or drop.`, metadata: { error: true } };
			}

			const jobId = `git_stash_${Date.now()}`;
			try {
				const output = await commandExecutor.execute(jobId, cmd, 10_000, 20 * 1024);
				return { title: `Stash ${action}`, output: output.trim() || `Stash ${action} completed.`, metadata: { action } };
			} catch (err: any) {
				return { title: 'Git stash error', output: `Error: ${err.message}`, metadata: { error: true } };
			}
		},
	);
}

export function createGitPushTool(
	workingDirectory: string,
	commandExecutor: IExternalCommandExecutor
): IPowerTool {
	return definePowerTool(
		'git_push',
		`Push committed changes to the remote repository.

Requires staged and committed changes. Does NOT force-push.`,
		[
			{ name: 'remote', type: 'string', description: 'Remote name (default: origin)', required: false },
			{ name: 'branch', type: 'string', description: 'Branch to push (default: current branch)', required: false },
			{ name: 'setUpstream', type: 'boolean', description: 'Set upstream tracking (-u flag, default: false)', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const remote = (args.remote as string | undefined) ?? 'origin';
			const branch = args.branch as string | undefined;
			const setUpstream = (args.setUpstream as boolean | undefined) ?? false;

			ctx.metadata({ title: `Push to ${remote}` });

			const upstreamFlag = setUpstream ? '-u ' : '';
			const branchArg = branch ? ` ${_shellQuote(branch)}` : '';
			const cmd = `cd ${_shellQuote(workingDirectory)} && git push ${upstreamFlag}${_shellQuote(remote)}${branchArg} 2>&1`;
			const jobId = `git_push_${Date.now()}`;

			try {
				const output = await commandExecutor.execute(jobId, cmd, 60_000, 20 * 1024);
				return { title: 'Pushed', output: output.trim(), metadata: { remote, branch } };
			} catch (err: any) {
				return { title: 'Push failed', output: `Error: ${err.message}`, metadata: { error: true } };
			}
		},
	);
}

export function createGitPullTool(
	workingDirectory: string,
	commandExecutor: IExternalCommandExecutor
): IPowerTool {
	return definePowerTool(
		'git_pull',
		`Pull changes from the remote repository.`,
		[
			{ name: 'remote', type: 'string', description: 'Remote name (default: origin)', required: false },
			{ name: 'branch', type: 'string', description: 'Branch to pull (default: current branch)', required: false },
			{ name: 'rebase', type: 'boolean', description: 'Rebase instead of merge (default: false)', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const remote = (args.remote as string | undefined) ?? 'origin';
			const branch = args.branch as string | undefined;
			const rebase = (args.rebase as boolean | undefined) ?? false;

			ctx.metadata({ title: `Pull from ${remote}` });

			const rebaseFlag = rebase ? '--rebase ' : '';
			const branchArg = branch ? ` ${_shellQuote(branch)}` : '';
			const cmd = `cd ${_shellQuote(workingDirectory)} && git pull ${rebaseFlag}${_shellQuote(remote)}${branchArg} 2>&1`;
			const jobId = `git_pull_${Date.now()}`;

			try {
				const output = await commandExecutor.execute(jobId, cmd, 60_000, 20 * 1024);
				return { title: 'Pulled', output: output.trim(), metadata: { remote, branch } };
			} catch (err: any) {
				return { title: 'Pull failed', output: `Error: ${err.message}`, metadata: { error: true } };
			}
		},
	);
}

// \u2500\u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
