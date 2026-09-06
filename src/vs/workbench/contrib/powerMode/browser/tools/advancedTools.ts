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
import { generateUuid } from '../../../../../base/common/uuid.js';

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
	commandExecutor: IExternalCommandExecutor,
	getModelInfo?: () => { provider: string; model: string } | undefined
): IPowerTool {
	return definePowerTool(
		'git_commit',
		`Commit staged changes with a message.

Rules:
- Changes must already be staged (use bash tool with 'git add' first)
- Message should follow conventional commit format
- This will create a commit but NOT push it
- Co-authored-by trailers are appended AUTOMATICALLY by the IDE — do NOT add them yourself`,
		[
			{ name: 'message', type: 'string', description: 'Commit message (trailers are auto-appended)', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			let message = args.message as string;

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

			// Auto-append co-authored-by trailers based on the active model
			message = _appendCoAuthorTrailers(message, getModelInfo?.());

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

function _appendCoAuthorTrailers(message: string, modelInfo?: { provider: string; model: string }): string {
	// Don't double-append if the message already has trailers
	if (message.includes('Co-authored-by:')) {
		return message;
	}

	const platform = 'Co-authored-by: neuralinverse-dev <noreply@neuralinverse.com>';
	let llmTrailer: string;

	const provider = (modelInfo?.provider ?? '').toLowerCase();
	const model = (modelInfo?.model ?? '').toLowerCase();

	if (provider.includes('openai') || model.includes('gpt') || model.includes('chatgpt') || model.includes('o1') || model.includes('o3') || model.includes('o4')) {
		llmTrailer = 'Co-authored-by: ChatGPT <noreply@openai.com>';
	} else if (provider.includes('google') || model.includes('gemini') || model.includes('gemma')) {
		llmTrailer = 'Co-authored-by: Gemini <noreply@google.com>';
	} else if (provider.includes('deepseek') || model.includes('deepseek')) {
		llmTrailer = 'Co-authored-by: DeepSeek <noreply@deepseek.com>';
	} else if (provider.includes('mistral') || model.includes('mistral') || model.includes('codestral')) {
		llmTrailer = 'Co-authored-by: Mistral <noreply@mistral.ai>';
	} else if (provider.includes('meta') || model.includes('llama')) {
		llmTrailer = 'Co-authored-by: Meta AI <noreply@meta.com>';
	} else {
		// Default to Claude (Anthropic) for anthropic/claude/unknown
		llmTrailer = 'Co-authored-by: Claude <noreply@anthropic.com>';
	}

	return `${message}\n\n${platform}\n${llmTrailer}`;
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
			const timeout = (args.timeout as number) ?? 3600000;

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

// ─── sleep: Wait without holding a shell process ────────────────────────────

export function createSleepTool(
	onSleep?: (ms: number) => void
): IPowerTool {
	return definePowerTool(
		'sleep',
		`Wait for a specified duration without holding a shell process.

Rules:
- Use when waiting for a background process, rate limit cooldown, or user-requested pause
- Prefer this over bash(sleep ...) — no shell process consumed
- Can run concurrently with other tools
- Max sleep: 60 seconds per call`,
		[
			{ name: 'duration', type: 'number', description: 'Duration to sleep in milliseconds (max 60000)', required: true },
			{ name: 'reason', type: 'string', description: 'Brief reason for sleeping', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const rawMs = args.duration as number;
			const reason = (args.reason as string | undefined) || '';
			const ms = Math.min(Math.max(0, rawMs), 60_000);

			ctx.metadata({ title: reason ? `Sleeping ${ms}ms: ${reason}` : `Sleeping ${ms}ms` });

			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, ms);
				ctx.abort.addEventListener('abort', () => {
					clearTimeout(timer);
					reject(new Error('Aborted'));
				});
			});

			return {
				title: 'Slept',
				output: `Slept for ${ms}ms${reason ? ` (${reason})` : ''}.`,
				metadata: { duration: ms },
			};
		},
	);
}

// ─── notify_user: Send a message to the user mid-session ────────────────────

export function createNotifyUserTool(
	notifyCallback: (message: string, sessionId: string) => void
): IPowerTool {
	return definePowerTool(
		'notify_user',
		`Send a message or status update to the user without ending the agent loop.

Use this to:
- Report progress on a long-running task
- Surface a finding that needs the user's attention
- Ask for confirmation before a risky operation
- Signal task completion while continuing work`,
		[
			{ name: 'message', type: 'string', description: 'The message to send to the user (markdown supported)', required: true },
			{ name: 'status', type: 'string', description: 'Status type: "info", "warning", "success", "error" (default: "info")', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const message = args.message as string;
			const status = (args.status as string | undefined) || 'info';

			ctx.metadata({ title: `Notifying user` });
			notifyCallback(message, ctx.sessionId);

			return {
				title: 'User notified',
				output: `Message sent to user: ${message}`,
				metadata: { status, message },
			};
		},
	);
}

// ─── todo_write: Manage a persistent task checklist ─────────────────────────

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface ITodoItem {
	id: string;
	content: string;
	status: TodoStatus;
	priority: 'high' | 'medium' | 'low';
}

const _todoStore = new Map<string, ITodoItem[]>();

export function createTodoWriteTool(): IPowerTool {
	return definePowerTool(
		'todo_write',
		`Manage a persistent task checklist for the current session.

Use this to track multi-step work:
- Break complex tasks into trackable subtasks
- Mark items in_progress before starting them
- Mark items completed when done
- Add new items as you discover more work

The checklist persists across tool calls in this session.`,
		[
			{
				name: 'todos',
				type: 'string',
				description: 'JSON array of todo items: [{ id, content, status, priority }]. status: pending|in_progress|completed|cancelled. priority: high|medium|low.',
				required: true,
			},
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			let todos: ITodoItem[];
			try {
				todos = JSON.parse(args.todos as string);
				if (!Array.isArray(todos)) { throw new Error('todos must be an array'); }
			} catch (e: any) {
				return { title: 'Invalid todos', output: `Error: ${e.message}`, metadata: { error: true } };
			}

			const sessionKey = ctx.sessionId;
			const old = _todoStore.get(sessionKey) ?? [];
			_todoStore.set(sessionKey, todos);

			const summary = todos.map(t => {
				const icon = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : t.status === 'cancelled' ? '[-]' : '[ ]';
				const pri = t.priority === 'high' ? '!' : t.priority === 'low' ? 'v' : ' ';
				return `${icon} ${pri} ${t.content}`;
			}).join('\n');

			const added = todos.filter(t => !old.find(o => o.id === t.id)).length;
			const changed = todos.filter(t => {
				const o = old.find(o => o.id === t.id);
				return o && o.status !== t.status;
			}).length;

			return {
				title: `Todo list updated (${todos.length} items)`,
				output: summary || '(empty)',
				metadata: { total: todos.length, added, changed },
			};
		},
	);
}

export function createTodoReadTool(): IPowerTool {
	return definePowerTool(
		'todo_read',
		`Read the current task checklist for this session.`,
		[],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const todos = _todoStore.get(ctx.sessionId) ?? [];

			if (todos.length === 0) {
				return { title: 'No todos', output: 'No tasks in checklist.', metadata: { total: 0 } };
			}

			const summary = todos.map(t => {
				const icon = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : t.status === 'cancelled' ? '[-]' : '[ ]';
				const pri = t.priority === 'high' ? '!' : t.priority === 'low' ? 'v' : ' ';
				return `${icon} ${pri} ${t.content}  [${t.id}]`;
			}).join('\n');

			const pending = todos.filter(t => t.status === 'pending').length;
			const inProgress = todos.filter(t => t.status === 'in_progress').length;
			const completed = todos.filter(t => t.status === 'completed').length;

			return {
				title: `Todo list (${todos.length} items: ${inProgress} active, ${pending} pending, ${completed} done)`,
				output: summary,
				metadata: { total: todos.length, pending, inProgress, completed },
			};
		},
	);
}

// ─── worktree: Isolated git worktree for risky/experimental changes ──────────

const _activeWorktrees = new Map<string, { path: string; branch: string; sessionId: string }>();

export function createEnterWorktreeTool(
	workspaceRoot: string,
	commandExecutor: IExternalCommandExecutor
): IPowerTool {
	return definePowerTool(
		'enter_worktree',
		`Create an isolated git worktree and switch into it for this session.

Use this when you want to:
- Make experimental changes without touching the main working tree
- Work on a new feature branch in isolation
- Test a risky refactor that you may want to discard

After entering a worktree:
- All file reads/writes operate relative to the worktree path
- Use exit_worktree to return and optionally discard the branch
- The worktree branch is created from current HEAD`,
		[
			{ name: 'name', type: 'string', description: 'Optional branch/worktree name (alphanumeric, hyphens, dots; max 64 chars). Auto-generated if omitted.', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			if (_activeWorktrees.has(ctx.sessionId)) {
				const existing = _activeWorktrees.get(ctx.sessionId)!;
				return {
					title: 'Already in worktree',
					output: `Already in worktree at ${existing.path} on branch ${existing.branch}. Use exit_worktree first.`,
					metadata: { worktreePath: existing.path, worktreeBranch: existing.branch },
				};
			}

			const rawName = (args.name as string | undefined)?.replace(/[^a-zA-Z0-9._-]/g, '-').substring(0, 64);
			const id = generateUuid().slice(0, 8);
			const branch = rawName ? `pm/wt/${rawName}` : `pm/wt/${id}`;
			const worktreePath = `/tmp/ni-pm-wt-${id}`;

			ctx.metadata({ title: `Creating worktree: ${branch}` });

			try {
				const result = await _execInDir(commandExecutor, 'git', ['worktree', 'add', worktreePath, '-b', branch], workspaceRoot);
				if (result.exitCode !== 0) {
					throw new Error(result.stderr || result.stdout || 'git worktree add failed');
				}

				_activeWorktrees.set(ctx.sessionId, { path: worktreePath, branch, sessionId: ctx.sessionId });

				return {
					title: `Worktree created`,
					output: `Entered isolated worktree.\nPath: ${worktreePath}\nBranch: ${branch}\n\nAll changes in this session are isolated. Use exit_worktree when done.`,
					metadata: { worktreePath, worktreeBranch: branch },
				};
			} catch (e: any) {
				return { title: 'Worktree failed', output: `Error: ${e.message}`, metadata: { error: true } };
			}
		},
	);
}

export function createExitWorktreeTool(
	workspaceRoot: string,
	commandExecutor: IExternalCommandExecutor
): IPowerTool {
	return definePowerTool(
		'exit_worktree',
		`Exit the current isolated worktree and return to the main working tree.

Options:
- keep: Leave the branch for manual review/merge
- discard: Remove the worktree and delete the branch (discards all changes)`,
		[
			{ name: 'action', type: 'string', description: '"keep" (default) or "discard"', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const wt = _activeWorktrees.get(ctx.sessionId);
			if (!wt) {
				return { title: 'Not in worktree', output: 'No active worktree for this session.', metadata: {} };
			}

			const action = (args.action as string | undefined) || 'keep';
			ctx.metadata({ title: `Exiting worktree (${action})` });

			_activeWorktrees.delete(ctx.sessionId);

			try {
				// Always remove the worktree directory
				await _execInDir(commandExecutor, 'git', ['worktree', 'remove', wt.path, '--force'], workspaceRoot);

				if (action === 'discard') {
					await _execInDir(commandExecutor, 'git', ['branch', '-D', wt.branch], workspaceRoot);
					return {
						title: 'Worktree discarded',
						output: `Exited and discarded worktree.\nBranch ${wt.branch} deleted. All changes removed.`,
						metadata: { worktreePath: wt.path, discarded: true },
					};
				}

				return {
					title: 'Worktree kept',
					output: `Exited worktree. Branch ${wt.branch} is preserved.\nYou can merge it with: git merge ${wt.branch}`,
					metadata: { worktreePath: wt.path, worktreeBranch: wt.branch, discarded: false },
				};
			} catch (e: any) {
				return { title: 'Exit worktree failed', output: `Error: ${e.message}`, metadata: { error: true } };
			}
		},
	);
}

async function _execInDir(
	commandExecutor: IExternalCommandExecutor,
	cmd: string,
	args: string[],
	cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const nodeRequire = (globalThis as any).require as NodeRequire | undefined;
	if (!nodeRequire) { throw new Error('Node.js integration required'); }
	const { execFile } = nodeRequire('child_process') as typeof import('child_process');
	const { promisify } = nodeRequire('util') as typeof import('util');
	const execFileAsync = promisify(execFile);
	try {
		const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, timeout: 30_000 });
		return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 };
	} catch (e: any) {
		return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.code ?? 1 };
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function _shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
