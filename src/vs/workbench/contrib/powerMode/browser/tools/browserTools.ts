/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

/**
 * Browser-safe Power Mode tools.
 *
 * Uses VS Code DI services (IFileService, ISearchService, IExternalCommandExecutor)
 * instead of Node.js built-in modules. Safe for the browser/renderer layer.
 */

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ISearchService, IFileQuery, ITextQuery, QueryType } from '../../../../services/search/common/search.js';
import { IExternalCommandExecutor } from '../../../void/browser/externalCommandExecutor.js';
import { IPowerTool, IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { definePowerTool } from './powerToolRegistry.js';
import { IPowerModeChangeTracker } from '../powerModeChangeTracker.js';

const MAX_OUTPUT = 50 * 1024; // 50KB
const MAX_LINES = 2000;
const MAX_LINE_LENGTH = 2000;

// ─── Bash Tool ───────────────────────────────────────────────────────────────

export function createBrowserBashTool(
	workingDirectory: string,
	commandExecutor: IExternalCommandExecutor
): IPowerTool {
	return definePowerTool(
		'bash',
		`Execute a bash command in the working directory (${workingDirectory}).

Rules:
- Always provide a clear description of what the command does
- For long-running commands, set an appropriate timeout
- Commands run in a background terminal with output capture
- Output is capped at 50KB`,
		[
			{ name: 'command', type: 'string', description: 'The bash command to execute', required: true },
			{ name: 'description', type: 'string', description: 'Brief description of what this command does', required: true },
			{ name: 'timeout', type: 'number', description: 'Optional timeout in milliseconds (default: 120000)', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const command = args.command as string;
			const description = args.description as string;
			const timeout = (args.timeout as number) ?? 120000;

			ctx.metadata({ title: description });

			const fullCommand = `cd ${_shellQuote(workingDirectory)} && ${command}`;
			const jobId = `pm_${ctx.sessionId}_${Date.now()}`;

			try {
				const output = await commandExecutor.execute(jobId, fullCommand, timeout, MAX_OUTPUT);
				return {
					title: description,
					output: output.length > MAX_OUTPUT
						? output.substring(0, MAX_OUTPUT) + '\n[Output truncated at 50KB]'
						: output,
					metadata: { exit: 0, description },
				};
			} catch (err: any) {
				return {
					title: description,
					output: `Error: ${err.message}${err.stderr ? '\n' + err.stderr : ''}`,
					metadata: { exit: err.exitCode ?? 1, description },
				};
			}
		},
	);
}

// ─── Read Tool ───────────────────────────────────────────────────────────────

export function createBrowserReadTool(
	workingDirectory: string,
	fileService: IFileService
): IPowerTool {
	return definePowerTool(
		'read',
		`Read a file from the filesystem. Returns file contents with line numbers.

Rules:
- Always use absolute paths
- For large files, use offset and limit to read specific sections
- Output is capped at ${MAX_LINES} lines and 50KB`,
		[
			{ name: 'filePath', type: 'string', description: 'The absolute path to the file to read', required: true },
			{ name: 'offset', type: 'number', description: 'Line number to start reading from (1-indexed)', required: false },
			{ name: 'limit', type: 'number', description: `Maximum number of lines to read (default: ${MAX_LINES})`, required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			let filePath = args.filePath as string;
			const offset = (args.offset as number) ?? 1;
			const limit = (args.limit as number) ?? MAX_LINES;

			if (!filePath.startsWith('/')) {
				filePath = workingDirectory + '/' + filePath;
			}

			ctx.metadata({ title: filePath.split('/').pop() ?? filePath });

			const uri = URI.file(filePath);

			// Check if it's a directory
			try {
				const stat = await fileService.stat(uri);
				if (stat.isDirectory) {
					const resolved = await fileService.resolve(uri);
					const entries = (resolved.children ?? [])
						.map(c => `${c.isDirectory ? 'd' : '-'} ${c.name}`)
						.sort()
						.join('\n');
					return {
						title: filePath,
						output: entries || '(empty directory)',
						metadata: { type: 'directory' },
					};
				}
			} catch {
				return {
					title: filePath,
					output: `Error: File not found: ${filePath}`,
					metadata: { error: true },
				};
			}

			// Read file
			try {
				const content = await fileService.readFile(uri);
				const text = content.value.toString();
				const allLines = text.split('\n');
				const startIdx = Math.max(0, offset - 1);
				const selectedLines = allLines.slice(startIdx, startIdx + limit);

				const numbered = selectedLines.map((line, i) => {
					const num = String(startIdx + i + 1).padStart(6, ' ');
					const truncated = line.length > MAX_LINE_LENGTH
						? line.substring(0, MAX_LINE_LENGTH) + '...'
						: line;
					return `${num}\t${truncated}`;
				}).join('\n');

				let output = numbered;
				if (output.length > MAX_OUTPUT) {
					output = output.substring(0, MAX_OUTPUT) + '\n[Output truncated]';
				}

				return {
					title: filePath.split('/').pop() ?? filePath,
					output,
					metadata: { lines: allLines.length },
				};
			} catch (err: any) {
				return {
					title: filePath,
					output: `Error reading file: ${err.message}`,
					metadata: { error: true },
				};
			}
		},
	);
}

// ─── Write Tool ──────────────────────────────────────────────────────────────

export function createBrowserWriteTool(
	workingDirectory: string,
	fileService: IFileService,
	changeTracker?: IPowerModeChangeTracker
): IPowerTool {
	return definePowerTool(
		'write',
		`Write content to a file. Creates the file if it doesn't exist, overwrites if it does.

Rules:
- Always use absolute paths
- Use this for creating new files or full rewrites
- For targeted edits, use the edit tool instead`,
		[
			{ name: 'filePath', type: 'string', description: 'Absolute path to the file to write', required: true },
			{ name: 'content', type: 'string', description: 'The content to write to the file', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			let filePath = args.filePath as string;
			const content = args.content as string;

			if (!filePath.startsWith('/')) {
				filePath = workingDirectory + '/' + filePath;
			}

			const fileName = filePath.split('/').pop() ?? filePath;
			ctx.metadata({ title: `Write ${fileName}` });

			// Track change before writing
			let changeId: string | undefined;
			if (changeTracker) {
				changeId = await changeTracker.trackChange({
					filePath,
					changeType: 'write',
					sessionId: ctx.sessionId,
					agentId: ctx.agentId,
				});
			}

			const uri = URI.file(filePath);
			const buffer = VSBuffer.fromString(content);

			try {
				await fileService.writeFile(uri, buffer);

				// Finalize change tracking
				if (changeTracker && changeId) {
					await changeTracker.finalizeChange(changeId, content);
				}

				const lineCount = content.split('\n').length;
				return {
					title: `Wrote ${fileName}`,
					output: `Successfully wrote ${lineCount} lines to ${filePath}`,
					metadata: { lines: lineCount },
				};
			} catch (err: any) {
				return {
					title: `Write ${fileName}`,
					output: `Error writing file: ${err.message}`,
					metadata: { error: true },
				};
			}
		},
	);
}

// ─── Edit Tool ───────────────────────────────────────────────────────────────

export function createBrowserEditTool(
	workingDirectory: string,
	fileService: IFileService,
	changeTracker?: IPowerModeChangeTracker
): IPowerTool {
	return definePowerTool(
		'edit',
		`Edit a file by replacing a specific string with new content.

Rules:
- old_string must match EXACTLY (including whitespace and indentation)
- old_string must be unique in the file
- For creating new files, use the write tool instead`,
		[
			{ name: 'filePath', type: 'string', description: 'Absolute path to the file to edit', required: true },
			{ name: 'old_string', type: 'string', description: 'The exact string to replace (must be unique)', required: true },
			{ name: 'new_string', type: 'string', description: 'The replacement string', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			let filePath = args.filePath as string;
			const oldString = args.old_string as string;
			const newString = args.new_string as string;

			if (!filePath.startsWith('/')) {
				filePath = workingDirectory + '/' + filePath;
			}

			const fileName = filePath.split('/').pop() ?? filePath;
			ctx.metadata({ title: `Edit ${fileName}` });

			const uri = URI.file(filePath);

			// Track change before editing
			let changeId: string | undefined;
			if (changeTracker) {
				changeId = await changeTracker.trackChange({
					filePath,
					changeType: 'edit',
					sessionId: ctx.sessionId,
					agentId: ctx.agentId,
				});
			}

			try {
				const content = await fileService.readFile(uri);
				const text = content.value.toString();

				const count = text.split(oldString).length - 1;
				if (count === 0) {
					return {
						title: `Edit ${fileName}`,
						output: `Error: old_string not found in ${filePath}`,
						metadata: { error: true },
					};
				}
				if (count > 1) {
					return {
						title: `Edit ${fileName}`,
						output: `Error: old_string found ${count} times — must be unique. Add more context.`,
						metadata: { error: true },
					};
				}

				const newText = text.replace(oldString, newString);
				await fileService.writeFile(uri, VSBuffer.fromString(newText));

				// Finalize change tracking
				if (changeTracker && changeId) {
					await changeTracker.finalizeChange(changeId, newText);
				}

				return {
					title: `Edited ${fileName}`,
					output: `Successfully edited ${filePath}`,
					metadata: {},
				};
			} catch (err: any) {
				return {
					title: `Edit ${fileName}`,
					output: `Error: ${err.message}`,
					metadata: { error: true },
				};
			}
		},
	);
}

// ─── List Tool ───────────────────────────────────────────────────────────────

export function createBrowserListTool(
	workingDirectory: string,
	fileService: IFileService
): IPowerTool {
	return definePowerTool(
		'list',
		`List contents of a directory.

Rules:
- Use absolute paths
- Returns file names with type indicators (d for directory, - for file)`,
		[
			{ name: 'dirPath', type: 'string', description: `Directory path to list (default: ${workingDirectory})`, required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			let dirPath = (args.dirPath as string) ?? workingDirectory;
			if (!dirPath.startsWith('/')) {
				dirPath = workingDirectory + '/' + dirPath;
			}

			ctx.metadata({ title: dirPath.split('/').pop() ?? dirPath });

			const uri = URI.file(dirPath);

			try {
				const resolved = await fileService.resolve(uri);
				const entries = (resolved.children ?? [])
					.map(c => `${c.isDirectory ? 'd' : '-'} ${c.name}`)
					.sort()
					.join('\n');

				return {
					title: dirPath,
					output: entries || '(empty directory)',
					metadata: { count: resolved.children?.length ?? 0 },
				};
			} catch (err: any) {
				return {
					title: dirPath,
					output: `Error listing directory: ${err.message}`,
					metadata: { error: true },
				};
			}
		},
	);
}

// ─── Glob Tool ───────────────────────────────────────────────────────────────

export function createBrowserGlobTool(
	workingDirectory: string,
	searchService: ISearchService
): IPowerTool {
	return definePowerTool(
		'glob',
		`Find files by glob pattern. Uses VS Code's search service.

Rules:
- Patterns use standard glob syntax: *.ts, src/**/*.tsx, etc.
- Results are limited to 100 matches`,
		[
			{ name: 'pattern', type: 'string', description: 'Glob pattern to match files', required: true },
			{ name: 'path', type: 'string', description: `Directory to search in (default: ${workingDirectory})`, required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const pattern = args.pattern as string;
			const searchPath = (args.path as string) ?? workingDirectory;

			ctx.metadata({ title: pattern });

			const folderUri = URI.file(searchPath);

			try {
				const query: IFileQuery = {
					type: QueryType.File,
					folderQueries: [{ folder: folderUri }],
					filePattern: pattern,
					maxResults: 100,
				};

				const results = await searchService.fileSearch(query);
				const files = results.results.map(r => r.resource.fsPath).join('\n');

				return {
					title: pattern,
					output: files || 'No matches found.',
					metadata: { count: results.results.length },
				};
			} catch (err: any) {
				return {
					title: pattern,
					output: `Error searching: ${err.message}`,
					metadata: { error: true },
				};
			}
		},
	);
}

// ─── Grep Tool ───────────────────────────────────────────────────────────────

export function createBrowserGrepTool(
	workingDirectory: string,
	searchService: ISearchService
): IPowerTool {
	return definePowerTool(
		'grep',
		`Search file contents for a pattern. Uses VS Code's text search.

Rules:
- Supports regex patterns
- Automatically excludes node_modules and .git
- Results show file paths with matching lines`,
		[
			{ name: 'pattern', type: 'string', description: 'Search pattern (regex supported)', required: true },
			{ name: 'path', type: 'string', description: `Directory to search in (default: ${workingDirectory})`, required: false },
			{ name: 'include', type: 'string', description: 'File pattern to include (e.g. *.ts)', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const pattern = args.pattern as string;
			const searchPath = (args.path as string) ?? workingDirectory;
			const include = args.include as string | undefined;

			ctx.metadata({ title: pattern });

			const folderUri = URI.file(searchPath);

			try {
				const query: ITextQuery = {
					type: QueryType.Text,
					contentPattern: {
						pattern,
						isRegExp: true,
						isCaseSensitive: false,
					},
					folderQueries: [{ folder: folderUri }],
					includePattern: include ? { [include]: true } : undefined,
					excludePattern: { '**/node_modules': true, '**/.git': true },
					maxResults: 200,
				};

				const matches: string[] = [];
				const results = await searchService.textSearch(query, undefined, (item) => {
					if ('resource' in item) {
						const fileMatch = item as { resource: { fsPath: string }; results?: Array<{ rangeLocations?: Array<{ source: { startLineNumber: number } }>; previewText?: string }> };
						const file = fileMatch.resource.fsPath;
						if (fileMatch.results) {
							for (const result of fileMatch.results) {
								if (result.rangeLocations && result.rangeLocations.length > 0) {
									const line = result.rangeLocations[0].source.startLineNumber;
									const preview = result.previewText ?? '';
									matches.push(`${file}:${line}: ${preview.trim()}`);
								}
							}
						}
					}
				});

				const output = matches.length > 0
					? matches.join('\n')
					: 'No matches found.';

				return {
					title: pattern,
					output: output.length > MAX_OUTPUT
						? output.substring(0, MAX_OUTPUT) + '\n[Output truncated]'
						: output,
					metadata: { count: results.results.length },
				};
			} catch (err: any) {
				return {
					title: pattern,
					output: `Error searching: ${err.message}`,
					metadata: { error: true },
				};
			}
		},
	);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function _shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
