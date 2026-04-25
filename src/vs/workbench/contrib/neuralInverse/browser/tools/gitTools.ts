/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Git Tools
 *
 * IAgentTool implementations for git operations in the workspace.
 *
 * ## Injection Safety
 *
 * All git tools use child_process.execFile (not exec) with arguments passed
 * as an array \u2014 never interpolated into a shell string. This prevents
 * command injection through user-controlled arguments.
 *
 * ## Scope
 *
 * Tools operate on the workspace root only. Arguments that attempt to
 * escape the workspace via absolute paths are rejected.
 *
 * ## Tools
 *
 * Read-only:
 *   gitStatus   \u2014 working tree status (porcelain)
 *   gitDiff     \u2014 file or staged diffs
 *   gitLog      \u2014 recent commit history
 *   gitBranches \u2014 list local branches
 *
 * Write:
 *   gitAdd      \u2014 stage files
 *   gitCommit   \u2014 commit staged changes
 *   gitCreateBranch \u2014 create and switch to a new branch
 */

import { IAgentTool, IToolExecutionContext, IToolResult } from '../../common/workflowTypes.js';

// \u2500\u2500\u2500 Shared execFile helper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function gitExec(
	args: string[],
	cwd: string,
	timeoutMs = 15_000,
): Promise<GitResult> {
	const nodeRequire = (globalThis as any).require as NodeRequire | undefined;
	if (!nodeRequire) {
		throw new Error('Git tools are not available in VS Code Web.');
	}

	const { execFile } = nodeRequire('child_process') as typeof import('child_process');
	const { promisify } = nodeRequire('util') as typeof import('util');
	const execFileAsync = promisify(execFile);

	try {
		const { stdout, stderr } = await execFileAsync('git', args, {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 2 * 1024 * 1024,
		});
		return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 };
	} catch (e: any) {
		return {
			stdout: e.stdout ?? '',
			stderr: e.stderr ?? '',
			exitCode: e.code ?? 1,
		};
	}
}

/** Reject paths that escape the workspace root */
function isSafePath(p: string): boolean {
	if (!p) return false;
	if (p.startsWith('/') || p.startsWith('\\')) return false; // absolute
	if (p.includes('..')) return false;                         // traversal
	return true;
}

// \u2500\u2500\u2500 gitStatus \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class GitStatusTool implements IAgentTool {

	readonly name = 'gitStatus';
	readonly description =
		'Get the current git working tree status. Shows staged, unstaged, and untracked files. ' +
		'Returns porcelain output: each line is "<XY> <path>" where XY encodes staging/working state.';

	readonly parameters = {};

	async execute(_args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		ctx.log('gitStatus');
		const result = await gitExec(['status', '--porcelain', '-b'], ctx.workspaceUri.fsPath);

		if (result.exitCode !== 0) {
			const msg = result.stderr.trim() || 'git status failed';
			// Not a git repo is a common expected case
			if (msg.includes('not a git repository')) {
				return { success: false, output: '', error: 'Not a git repository.' };
			}
			return { success: false, output: '', error: msg };
		}

		return {
			success: true,
			output: result.stdout.trim() || 'Working tree clean \u2014 nothing to commit.',
		};
	}
}

// \u2500\u2500\u2500 gitDiff \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class GitDiffTool implements IAgentTool {

	readonly name = 'gitDiff';
	readonly description =
		'Get a git diff. Can show unstaged changes, staged changes, or diff for a specific file. ' +
		'Output is standard unified diff format.';

	readonly parameters = {
		staged: {
			type: 'boolean' as const,
			description: 'If true, show staged (cached) diff. Defaults to false (unstaged).',
			required: false,
		},
		path: {
			type: 'string' as const,
			description: 'Workspace-relative path to diff a specific file. Diffs all files if omitted.',
			required: false,
		},
		maxLines: {
			type: 'number' as const,
			description: 'Truncate output to this many lines. Defaults to 200.',
			required: false,
		},
	};

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const staged = Boolean(args['staged']);
		const path = args['path'] as string | undefined;
		const maxLines = (args['maxLines'] as number) || 200;

		if (path && !isSafePath(path)) {
			return { success: false, output: '', error: `Unsafe path: "${path}"` };
		}

		const gitArgs = ['diff'];
		if (staged) gitArgs.push('--cached');
		gitArgs.push('--stat');  // summary first
		if (path) gitArgs.push('--', path);

		ctx.log(`gitDiff${staged ? ' --cached' : ''}${path ? ` ${path}` : ''}`);

		// Get stat summary
		const stat = await gitExec(gitArgs, ctx.workspaceUri.fsPath);

		// Get actual diff
		const diffArgs = ['diff'];
		if (staged) diffArgs.push('--cached');
		if (path) diffArgs.push('--', path);

		const diff = await gitExec(diffArgs, ctx.workspaceUri.fsPath);

		if (stat.exitCode !== 0 && diff.exitCode !== 0) {
			return { success: false, output: '', error: diff.stderr.trim() || 'git diff failed' };
		}

		const fullOutput = [stat.stdout.trim(), diff.stdout.trim()].filter(Boolean).join('\n\n');

		if (!fullOutput) {
			return { success: true, output: staged ? 'No staged changes.' : 'No unstaged changes.' };
		}

		// Truncate to maxLines
		const lines = fullOutput.split('\n');
		const truncated = lines.length > maxLines;
		const output = truncated
			? lines.slice(0, maxLines).join('\n') + `\n\n... (truncated at ${maxLines} lines \u2014 ${lines.length} total)`
			: fullOutput;

		return { success: true, output };
	}
}

// \u2500\u2500\u2500 gitLog \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class GitLogTool implements IAgentTool {

	readonly name = 'gitLog';
	readonly description =
		'Show recent git commit history. Returns commit hash, author, date, and message for each commit.';

	readonly parameters = {
		limit: {
			type: 'number' as const,
			description: 'Number of commits to show. Defaults to 15.',
			required: false,
		},
		path: {
			type: 'string' as const,
			description: 'Workspace-relative path to show history for a specific file.',
			required: false,
		},
	};

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const limit = Math.min((args['limit'] as number) || 15, 50);
		const path = args['path'] as string | undefined;

		if (path && !isSafePath(path)) {
			return { success: false, output: '', error: `Unsafe path: "${path}"` };
		}

		const gitArgs = [
			'log',
			`-${limit}`,
			'--pretty=format:%h  %an  %ar  %s',
			'--no-merges',
		];
		if (path) gitArgs.push('--', path);

		ctx.log(`gitLog${path ? ` ${path}` : ''} (last ${limit})`);
		const result = await gitExec(gitArgs, ctx.workspaceUri.fsPath);

		if (result.exitCode !== 0) {
			return { success: false, output: '', error: result.stderr.trim() || 'git log failed' };
		}

		return {
			success: true,
			output: result.stdout.trim() || 'No commits found.',
		};
	}
}

// \u2500\u2500\u2500 gitBranches \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class GitBranchesTool implements IAgentTool {

	readonly name = 'gitBranches';
	readonly description =
		'List all local branches. The current branch is prefixed with "*".';

	readonly parameters = {};

	async execute(_args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		ctx.log('gitBranches');
		const result = await gitExec(['branch', '-v'], ctx.workspaceUri.fsPath);

		if (result.exitCode !== 0) {
			return { success: false, output: '', error: result.stderr.trim() || 'git branch failed' };
		}

		return {
			success: true,
			output: result.stdout.trim() || 'No branches found.',
		};
	}
}

// \u2500\u2500\u2500 gitAdd \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class GitAddTool implements IAgentTool {

	readonly name = 'gitAdd';
	readonly description =
		'Stage files for the next commit. Pass specific paths or "." to stage all changes.';

	readonly parameters = {
		paths: {
			type: 'array' as const,
			description: 'List of workspace-relative paths to stage. Use ["."] to stage everything.',
			required: true,
			items: { type: 'string' },
		},
	};

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const paths = args['paths'] as string[];

		if (!Array.isArray(paths) || paths.length === 0) {
			return { success: false, output: '', error: 'paths array is required' };
		}

		// Validate each path
		for (const p of paths) {
			if (p !== '.' && !isSafePath(p)) {
				return { success: false, output: '', error: `Unsafe path: "${p}"` };
			}
		}

		ctx.log(`gitAdd: ${paths.join(', ')}`);
		const result = await gitExec(['add', '--', ...paths], ctx.workspaceUri.fsPath);

		if (result.exitCode !== 0) {
			return { success: false, output: '', error: result.stderr.trim() || 'git add failed' };
		}

		// Return status after staging
		const status = await gitExec(['status', '--porcelain'], ctx.workspaceUri.fsPath);
		return {
			success: true,
			output: `Staged: ${paths.join(', ')}\n\nCurrent status:\n${status.stdout.trim() || '(clean)'}`,
		};
	}
}

// \u2500\u2500\u2500 gitCommit \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class GitCommitTool implements IAgentTool {

	readonly name = 'gitCommit';
	readonly description =
		'Commit currently staged changes with a message. ' +
		'Use gitAdd first to stage the files you want to include. ' +
		'Will not push \u2014 only creates a local commit.';

	readonly parameters = {
		message: {
			type: 'string' as const,
			description: 'Commit message. Should follow conventional commits format: "type(scope): description"',
			required: true,
		},
	};

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const message = args['message'] as string;

		if (!message?.trim()) {
			return { success: false, output: '', error: 'message is required' };
		}

		// Check there is something staged
		const staged = await gitExec(['diff', '--cached', '--name-only'], ctx.workspaceUri.fsPath);
		if (!staged.stdout.trim()) {
			return { success: false, output: '', error: 'Nothing staged. Use gitAdd to stage files first.' };
		}

		ctx.log(`gitCommit: "${message}"`);

		// Use execFile with message as a safe argument \u2014 no shell injection possible
		const result = await gitExec(['commit', '-m', message], ctx.workspaceUri.fsPath);

		if (result.exitCode !== 0) {
			const err = result.stderr.trim() || result.stdout.trim() || 'git commit failed';
			return { success: false, output: '', error: err };
		}

		return {
			success: true,
			output: result.stdout.trim() || `Committed: ${message}`,
		};
	}
}

// \u2500\u2500\u2500 gitCreateBranch \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class GitCreateBranchTool implements IAgentTool {

	readonly name = 'gitCreateBranch';
	readonly description =
		'Create a new git branch and switch to it. ' +
		'Branch name must be alphanumeric with hyphens or slashes only.';

	readonly parameters = {
		name: {
			type: 'string' as const,
			description: 'Branch name, e.g. "feat/scaffold-component" or "fix/import-paths"',
			required: true,
		},
	};

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const name = args['name'] as string;

		if (!name?.trim()) {
			return { success: false, output: '', error: 'name is required' };
		}

		// Validate branch name \u2014 alphanumeric, hyphens, slashes, dots
		if (!/^[\w.\-/]+$/.test(name) || name.startsWith('-') || name.includes('..')) {
			return { success: false, output: '', error: `Invalid branch name: "${name}"` };
		}

		ctx.log(`gitCreateBranch: ${name}`);
		const result = await gitExec(['checkout', '-b', name], ctx.workspaceUri.fsPath);

		if (result.exitCode !== 0) {
			return { success: false, output: '', error: result.stderr.trim() || 'git checkout -b failed' };
		}

		return {
			success: true,
			output: result.stdout.trim() || `Switched to new branch '${name}'`,
		};
	}
}

// \u2500\u2500\u2500 Export \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const ALL_GIT_TOOLS: IAgentTool[] = [
	new GitStatusTool(),
	new GitDiffTool(),
	new GitLogTool(),
	new GitBranchesTool(),
	new GitAddTool(),
	new GitCommitTool(),
	new GitCreateBranchTool(),
];
