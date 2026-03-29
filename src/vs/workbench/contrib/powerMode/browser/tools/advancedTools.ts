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
import { IExternalCommandExecutor } from '../../../void/browser/externalCommandExecutor.js';
import { IPowerTool, IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { definePowerTool } from './powerToolRegistry.js';

// ─── ask_user: Ask clarifying questions ─────────────────────────────────────

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

// ─── web_fetch: Fetch external docs/APIs ────────────────────────────────────

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

// ─── Task Management Tools ──────────────────────────────────────────────────

interface ITask {
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

const globalTaskStore = new TaskStore();

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
				const status = t.status === 'in_progress' ? '⟳' : t.status === 'completed' ? '✓' : t.status === 'blocked' ? '✗' : '·';
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

// ─── Git Tools ──────────────────────────────────────────────────────────────

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

// ─── Memory Tools ───────────────────────────────────────────────────────────

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

// ─── Run Tests Tool ─────────────────────────────────────────────────────────

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

// ─── Helpers ────────────────────────────────────────────────────────────────

function _shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
