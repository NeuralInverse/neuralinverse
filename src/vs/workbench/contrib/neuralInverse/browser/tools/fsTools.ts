/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Filesystem Tools
 *
 * IAgentTool implementations for workspace file operations.
 *
 * ## .inverse/ Write Rule
 *
 * These tools operate on the user's project workspace, NOT on .inverse/.
 * If a writeFile call targets a path inside .inverse/, it is rejected —
 * agents must never self-modify their own definitions or config.
 *
 * Writing to .inverse/ is reserved for config services that explicitly
 * use withInverseWriteAccess() from inverseFs.ts.
 */

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { SaveSourceRegistry } from '../../../../common/editor.js';
import { IAgentTool, IToolExecutionContext, IToolResult } from '../../common/workflowTypes.js';

const WORKER_AGENT_SAVE_SOURCE = SaveSourceRegistry.registerSource('neuralInverse.workerAgent.source', 'Worker Agents');

const INVERSE_DIR = '.inverse';

function isInverseDir(workspacePath: string): boolean {
	const normalized = workspacePath.replace(/\\/g, '/').replace(/^\//, '');
	return normalized.startsWith(INVERSE_DIR + '/') || normalized === INVERSE_DIR;
}

// ─── readFile ─────────────────────────────────────────────────────────────────

export class ReadFileTool implements IAgentTool {

	readonly name = 'readFile';
	readonly description = 'Read the full text content of a file in the workspace. Returns the file content as a string.';
	readonly parameters = {
		path: {
			type: 'string' as const,
			description: 'Workspace-relative path to the file, e.g. "src/components/Button.tsx"',
			required: true,
		},
	};

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const path = args['path'] as string;
		if (!path) {
			return { success: false, output: '', error: 'path is required' };
		}

		try {
			const uri = URI.joinPath(ctx.workspaceUri, path);
			ctx.log(`readFile: ${path}`);
			const file = await ctx.fileService.readFile(uri);
			const content = file.value.toString();
			return { success: true, output: content };
		} catch (e: any) {
			return { success: false, output: '', error: `Could not read "${path}": ${e.message}` };
		}
	}
}

// ─── writeFile ────────────────────────────────────────────────────────────────

export class WriteFileTool implements IAgentTool {

	readonly name = 'writeFile';
	readonly description = 'Write or overwrite a file in the workspace with the given content. Creates the file if it does not exist. Cannot write to .inverse/ — those files are managed by the config system.';
	readonly parameters = {
		path: {
			type: 'string' as const,
			description: 'Workspace-relative path to the file, e.g. "src/components/Button.tsx"',
			required: true,
		},
		content: {
			type: 'string' as const,
			description: 'Full text content to write to the file',
			required: true,
		},
	};

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const path = args['path'] as string;
		const content = args['content'] as string;

		if (!path) return { success: false, output: '', error: 'path is required' };
		if (content === undefined) return { success: false, output: '', error: 'content is required' };

		// Enforce .inverse/ protection
		if (isInverseDir(path)) {
			return {
				success: false,
				output: '',
				error: `Writing to .inverse/ is not permitted from workflow agents. Path: "${path}"`,
			};
		}

		try {
			const uri = URI.joinPath(ctx.workspaceUri, path);
			ctx.log(`writeFile: ${path} (${content.length} chars)`);
			const buffer = VSBuffer.fromString(content);
			await ctx.fileService.writeFile(uri, buffer);
			// Record a Timeline entry so the user can see/revert Power Mode edits
			ctx.historyService?.addEntry({ resource: uri, source: WORKER_AGENT_SAVE_SOURCE }, CancellationToken.None);
			return { success: true, output: `Written: ${path}` };
		} catch (e: any) {
			return { success: false, output: '', error: `Could not write "${path}": ${e.message}` };
		}
	}
}

// ─── listDirectory ────────────────────────────────────────────────────────────

export class ListDirectoryTool implements IAgentTool {

	readonly name = 'listDirectory';
	readonly description = 'List the files and subdirectories at a given path in the workspace. Returns one entry per line.';
	readonly parameters = {
		path: {
			type: 'string' as const,
			description: 'Workspace-relative directory path, e.g. "src/components". Use "." for workspace root.',
			required: true,
		},
		recursive: {
			type: 'boolean' as const,
			description: 'If true, lists all files recursively. Defaults to false.',
			required: false,
		},
	};

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const path = (args['path'] as string) || '.';
		const recursive = Boolean(args['recursive']);

		try {
			const uri = path === '.' ? ctx.workspaceUri : URI.joinPath(ctx.workspaceUri, path);
			ctx.log(`listDirectory: ${path}${recursive ? ' (recursive)' : ''}`);

			const stat = await ctx.fileService.resolve(uri, { resolveMetadata: false });

			if (!stat.isDirectory) {
				return { success: false, output: '', error: `"${path}" is not a directory` };
			}

			const lines: string[] = [];
			this._collect(stat, '', recursive, lines);

			return { success: true, output: lines.join('\n') || '(empty directory)' };
		} catch (e: any) {
			return { success: false, output: '', error: `Could not list "${path}": ${e.message}` };
		}
	}

	private _collect(stat: any, prefix: string, recursive: boolean, out: string[]): void {
		if (!stat.children) return;
		for (const child of stat.children) {
			const entry = prefix ? `${prefix}/${child.name}` : child.name;
			out.push(child.isDirectory ? `${entry}/` : entry);
			if (recursive && child.isDirectory && child.children) {
				this._collect(child, entry, true, out);
			}
		}
	}
}

// ─── searchCode ───────────────────────────────────────────────────────────────

export class SearchCodeTool implements IAgentTool {

	readonly name = 'searchCode';
	readonly description = 'Search for a text pattern across files in the workspace. Returns matching file paths and the matching lines with line numbers. Searches recursively from the given directory.';
	readonly parameters = {
		pattern: {
			type: 'string' as const,
			description: 'Text or regex pattern to search for, e.g. "useState" or "import.*React"',
			required: true,
		},
		directory: {
			type: 'string' as const,
			description: 'Workspace-relative directory to search in. Defaults to workspace root "."',
			required: false,
		},
		fileGlob: {
			type: 'string' as const,
			description: 'File extension filter, e.g. ".ts" or ".tsx". Searches all files if omitted.',
			required: false,
		},
		maxResults: {
			type: 'number' as const,
			description: 'Maximum number of matching lines to return. Defaults to 50.',
			required: false,
		},
	};

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const pattern = args['pattern'] as string;
		const directory = (args['directory'] as string) || '.';
		const fileGlob = args['fileGlob'] as string | undefined;
		const maxResults = (args['maxResults'] as number) || 50;

		if (!pattern) return { success: false, output: '', error: 'pattern is required' };

		let regex: RegExp;
		try {
			regex = new RegExp(pattern, 'i');
		} catch {
			// Treat as literal string
			regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
		}

		try {
			const rootUri = directory === '.' ? ctx.workspaceUri : URI.joinPath(ctx.workspaceUri, directory);
			ctx.log(`searchCode: "${pattern}" in ${directory}`);

			const matches: string[] = [];
			await this._searchDir(rootUri, regex, fileGlob, ctx, matches, maxResults);

			if (matches.length === 0) {
				return { success: true, output: 'No matches found.' };
			}

			const truncated = matches.length >= maxResults;
			const output = matches.join('\n') + (truncated ? `\n\n(results truncated at ${maxResults})` : '');
			return { success: true, output };
		} catch (e: any) {
			return { success: false, output: '', error: `Search failed: ${e.message}` };
		}
	}

	private async _searchDir(
		uri: URI,
		regex: RegExp,
		fileGlob: string | undefined,
		ctx: IToolExecutionContext,
		matches: string[],
		maxResults: number,
	): Promise<void> {
		if (matches.length >= maxResults) return;

		let stat: any;
		try {
			stat = await ctx.fileService.resolve(uri, { resolveMetadata: false });
		} catch {
			return;
		}

		if (stat.isDirectory && stat.children) {
			for (const child of stat.children) {
				if (matches.length >= maxResults) break;
				// Skip .inverse/, node_modules, dist, .git
				if (['node_modules', '.git', 'dist', 'out', '.inverse'].includes(child.name)) continue;
				await this._searchDir(child.resource, regex, fileGlob, ctx, matches, maxResults);
			}
		} else if (!stat.isDirectory) {
			if (fileGlob && !stat.name.endsWith(fileGlob)) return;
			try {
				const content = (await ctx.fileService.readFile(uri)).value.toString();
				const lines = content.split('\n');
				const relativePath = uri.path;
				for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
					if (regex.test(lines[i])) {
						matches.push(`${relativePath}:${i + 1}: ${lines[i].trim()}`);
					}
				}
			} catch {
				// Skip unreadable files
			}
		}
	}
}

// ─── deleteFile ───────────────────────────────────────────────────────────────

export class DeleteFileTool implements IAgentTool {

	readonly name = 'deleteFile';
	readonly description = 'Delete a file from the workspace. Cannot delete files inside .inverse/.';
	readonly parameters = {
		path: {
			type: 'string' as const,
			description: 'Workspace-relative path of the file to delete',
			required: true,
		},
	};

	async execute(args: Record<string, unknown>, ctx: IToolExecutionContext): Promise<IToolResult> {
		const path = args['path'] as string;
		if (!path) return { success: false, output: '', error: 'path is required' };

		if (isInverseDir(path)) {
			return { success: false, output: '', error: `Deleting files from .inverse/ is not permitted. Path: "${path}"` };
		}

		try {
			const uri = URI.joinPath(ctx.workspaceUri, path);
			ctx.log(`deleteFile: ${path}`);
			await ctx.fileService.del(uri);
			return { success: true, output: `Deleted: ${path}` };
		} catch (e: any) {
			return { success: false, output: '', error: `Could not delete "${path}": ${e.message}` };
		}
	}
}

// ─── Export all fs tools ──────────────────────────────────────────────────────

export const ALL_FS_TOOLS: IAgentTool[] = [
	new ReadFileTool(),
	new WriteFileTool(),
	new ListDirectoryTool(),
	new SearchCodeTool(),
	new DeleteFileTool(),
];
