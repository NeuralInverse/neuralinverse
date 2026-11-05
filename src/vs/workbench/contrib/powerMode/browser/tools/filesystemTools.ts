/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *
 *  Filesystem management tools for Power Mode agents.
 *
 *  Provides production-grade file operations that Cursor and Antigravity offer:
 *    - create_directory — create folders (including parents)
 *    - delete_file — safely remove files
 *    - move_file — rename/move files and directories
 *    - diff_view — view uncommitted changes vs git HEAD
 *
 *  All tools validate arguments strictly and return structured errors
 *  instead of crashing the agent loop.
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IExternalCommandExecutor } from '../../../void/browser/externalCommandExecutor.js';

// ─── Browser-safe path helpers (no Node.js 'path' module) ───────────────────

const _WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;

function _isAbsolute(p: string): boolean {
	return p.startsWith('/') || _WIN_DRIVE_RE.test(p);
}

function _resolve(workingDirectory: string, filePath: string): string {
	if (_isAbsolute(filePath)) {
		return filePath;
	}
	const base = workingDirectory.replace(/\\/g, '/');
	const rel = filePath.replace(/\\/g, '/');
	return base + (base.endsWith('/') ? '' : '/') + rel;
}

function _basename(p: string): string {
	const normalized = p.replace(/\\/g, '/');
	const parts = normalized.split('/');
	return parts[parts.length - 1] || normalized;
}

function _dirname(p: string): string {
	const normalized = p.replace(/\\/g, '/');
	const lastSlash = normalized.lastIndexOf('/');
	if (lastSlash === -1) { return '.'; }
	return normalized.substring(0, lastSlash) || '/';
}

function _relative(from: string, to: string): string {
	const fromNorm = _resolve('/', from).replace(/\\/g, '/');
	const toNorm = _resolve('/', to).replace(/\\/g, '/');
	if (toNorm.startsWith(fromNorm + '/')) {
		return toNorm.substring(fromNorm.length + 1);
	}
	return toNorm;
}

function _isWithinWorkspace(filePath: string, workingDirectory: string): boolean {
	const resolved = _resolve('', filePath);
	const resolvedWorkspace = _resolve('', workingDirectory);
	return resolved === resolvedWorkspace || resolved.startsWith(resolvedWorkspace + '/') || resolved.startsWith(resolvedWorkspace + '\\');
}

// ─── Helper: shell quote ────────────────────────────────────────────────────

function _shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

// ─── create_directory ───────────────────────────────────────────────────────

export function createCreateDirectoryTool(
	workingDirectory: string,
	fileService: IFileService
): IPowerTool {
	return definePowerTool(
		'create_directory',
		`Create a directory (folder), including all parent directories if needed.

Rules:
- Always use absolute paths
- Creates parent directories automatically (like mkdir -p)
- Fails gracefully if the directory already exists
- Cannot create directories outside the workspace`,
		[
			{ name: 'dirPath', type: 'string', description: 'Absolute path to the directory to create', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const rawDirPath = args.dirPath as string;
			if (typeof rawDirPath !== 'string' || rawDirPath.trim().length === 0) {
				return {
					title: 'Invalid directory path',
					output: 'Error: dirPath must be a non-empty string.',
					metadata: { error: true },
				};
			}

			let dirPath = _resolve(workingDirectory, rawDirPath);
			if (!_isWithinWorkspace(dirPath, workingDirectory)) {
				return {
					title: 'Access denied',
					output: `Error: Directory ${dirPath} is outside the workspace.`,
					metadata: { error: true },
				};
			}

			ctx.metadata({ title: `Create directory: ${_basename(dirPath)}` });

			try {
				const uri = URI.file(dirPath);
				await fileService.createFolder(uri);

				return {
					title: `Created directory`,
					output: `Successfully created directory: ${dirPath}`,
					metadata: { dirPath },
				};
			} catch (err: any) {
				// Already exists is not an error for this tool
				if (err?.message?.includes('already exists') || err?.message?.includes('EEXIST')) {
					return {
						title: 'Directory exists',
						output: `Directory already exists: ${dirPath}`,
						metadata: { dirPath, exists: true },
					};
				}
				return {
					title: 'Create directory failed',
					output: `Error: ${err.message}`,
					metadata: { error: true },
				};
			}
		},
	);
}

// ─── delete_file ────────────────────────────────────────────────────────────

export function createDeleteFileTool(
	workingDirectory: string,
	fileService: IFileService
): IPowerTool {
	return definePowerTool(
		'delete_file',
		`Delete a file from the filesystem. This is irreversible.

Rules:
- Always use absolute paths
- Only deletes files, not directories (use bash rm -r for directories)
- Cannot delete files outside the workspace
- Consider using git to track changes before deleting`,
		[
			{ name: 'filePath', type: 'string', description: 'Absolute path to the file to delete', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const rawFilePath = args.filePath as string;
			if (typeof rawFilePath !== 'string' || rawFilePath.trim().length === 0) {
				return {
					title: 'Invalid file path',
					output: 'Error: filePath must be a non-empty string.',
					metadata: { error: true },
				};
			}

			let filePath = _resolve(workingDirectory, rawFilePath);
			if (!_isWithinWorkspace(filePath, workingDirectory)) {
				return {
					title: 'Access denied',
					output: `Error: File ${filePath} is outside the workspace.`,
					metadata: { error: true },
				};
			}

			ctx.metadata({ title: `Delete: ${_basename(filePath)}` });

			try {
				// Check it's a file, not a directory
				const stat = await fileService.stat(URI.file(filePath));
				if (stat.isDirectory) {
					return {
						title: 'Not a file',
						output: `Error: ${filePath} is a directory. Use bash with rm -r to delete directories.`,
						metadata: { error: true },
					};
				}

				// Read content first for potential recovery info
				let contentPreview = '';
				try {
					const content = await fileService.readFile(URI.file(filePath));
					const text = content.value.toString();
					contentPreview = text.substring(0, 200) + (text.length > 200 ? '...' : '');
				} catch { /* ignore read errors */ }

				await fileService.del(URI.file(filePath));

				return {
					title: `Deleted: ${_basename(filePath)}`,
					output: `Successfully deleted file: ${filePath}\n${contentPreview ? `Last content preview:\n${contentPreview}` : ''}`,
					metadata: { filePath, deleted: true },
				};
			} catch (err: any) {
				if (err?.message?.includes('not found') || err?.message?.includes('ENOENT')) {
					return {
						title: 'File not found',
						output: `Error: File not found: ${filePath}`,
						metadata: { error: true },
					};
				}
				return {
					title: 'Delete failed',
					output: `Error: ${err.message}`,
					metadata: { error: true },
				};
			}
		},
	);
}

// ─── move_file ──────────────────────────────────────────────────────────────

export function createMoveFileTool(
	workingDirectory: string,
	fileService: IFileService
): IPowerTool {
	return definePowerTool(
		'move_file',
		`Move or rename a file or directory.

Rules:
- Always use absolute paths for both source and destination
- Creates parent directories of destination if needed
- Cannot move across filesystems
- Cannot move items outside the workspace`,
		[
			{ name: 'sourcePath', type: 'string', description: 'Absolute path to the source file or directory', required: true },
			{ name: 'destinationPath', type: 'string', description: 'Absolute path to the destination', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const rawSource = args.sourcePath as string;
			const rawDest = args.destinationPath as string;

			if (typeof rawSource !== 'string' || rawSource.trim().length === 0) {
				return {
					title: 'Invalid source path',
					output: 'Error: sourcePath must be a non-empty string.',
					metadata: { error: true },
				};
			}
			if (typeof rawDest !== 'string' || rawDest.trim().length === 0) {
				return {
					title: 'Invalid destination path',
					output: 'Error: destinationPath must be a non-empty string.',
					metadata: { error: true },
				};
			}

			let sourcePath = _resolve(workingDirectory, rawSource);
			let destPath = _resolve(workingDirectory, rawDest);

			if (!_isWithinWorkspace(sourcePath, workingDirectory)) {
				return {
					title: 'Access denied',
					output: `Error: Source ${sourcePath} is outside the workspace.`,
					metadata: { error: true },
				};
			}
			if (!_isWithinWorkspace(destPath, workingDirectory)) {
				return {
					title: 'Access denied',
					output: `Error: Destination ${destPath} is outside the workspace.`,
					metadata: { error: true },
				};
			}

			ctx.metadata({ title: `Move: ${_basename(sourcePath)} → ${_basename(destPath)}` });

			try {
				// Check source exists
				await fileService.stat(URI.file(sourcePath));

				// Create parent directories of destination
				const destDir = _dirname(destPath);
				await fileService.createFolder(URI.file(destDir)).catch(() => { /* already exists */ });

				// Move using rename (atomic on same filesystem)
				const sourceUri = URI.file(sourcePath);
				const destUri = URI.file(destPath);
				await fileService.move(sourceUri, destUri, { overwrite: false });

				return {
					title: `Moved: ${_basename(sourcePath)}`,
					output: `Successfully moved ${sourcePath} → ${destPath}`,
					metadata: { sourcePath, destPath },
				};
			} catch (err: any) {
				if (err?.message?.includes('not found') || err?.message?.includes('ENOENT')) {
					return {
						title: 'Source not found',
						output: `Error: Source not found: ${sourcePath}`,
						metadata: { error: true },
					};
				}
				if (err?.message?.includes('already exists') || err?.message?.includes('EEXIST')) {
					return {
						title: 'Destination exists',
						output: `Error: Destination already exists: ${destPath}`,
						metadata: { error: true },
					};
				}
				return {
					title: 'Move failed',
					output: `Error: ${err.message}`,
					metadata: { error: true },
				};
			}
		},
	);
}

// ─── diff_view ──────────────────────────────────────────────────────────────

export function createDiffViewTool(
	workingDirectory: string,
	commandExecutor: IExternalCommandExecutor
): IPowerTool {
	return definePowerTool(
		'diff_view',
		`View the diff between the current working tree and git HEAD, or between two commits/branches.

Rules:
- Shows unstaged changes by default
- Use --cached for staged changes
- Provide a target file to see diff for a specific file
- Output is unified diff format`,
		[
			{ name: 'target', type: 'string', description: 'Optional: specific file path or commit reference to diff', required: false },
			{ name: 'cached', type: 'boolean', description: 'Show staged changes instead of unstaged (default: false)', required: false },
			{ name: 'context_lines', type: 'number', description: 'Number of context lines around changes (default: 3)', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const target = args.target as string | undefined;
			const cached = args.cached === true;
			const contextLines = typeof args.context_lines === 'number' ? args.context_lines : 3;

			ctx.metadata({ title: 'Git diff view' });

			let command = 'git diff';
			if (cached) { command += ' --cached'; }
			command += ` -U${contextLines}`;
			if (target) {
				const absTarget = _resolve(workingDirectory, target);
				if (!_isWithinWorkspace(absTarget, workingDirectory)) {
					return {
						title: 'Access denied',
						output: `Error: Target ${absTarget} is outside the workspace.`,
						metadata: { error: true },
					};
				}
				command += ` -- ${target}`;
			}

			const fullCommand = `cd ${_shellQuote(workingDirectory)} && ${command}`;
			const jobId = `diff_view_${Date.now()}`;

			try {
				const output = await commandExecutor.execute(jobId, fullCommand, 30000, 200 * 1024);

				if (!output.trim()) {
					return {
						title: 'No changes',
						output: cached ? 'No staged changes' : 'No uncommitted changes',
						metadata: { hasChanges: false },
					};
				}

				return {
					title: 'Git diff',
					output,
					metadata: { hasChanges: true, cached, target },
				};
			} catch (err: any) {
				return {
					title: 'Diff failed',
					output: `Error: ${err.message}${err.stderr ? '\n' + err.stderr : ''}`,
					metadata: { error: true },
				};
			}
		},
	);
}
