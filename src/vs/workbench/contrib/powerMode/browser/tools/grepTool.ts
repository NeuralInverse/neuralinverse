/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import * as cp from 'child_process';
import * as path from 'path';

const MAX_RESULTS = 100;

export function createGrepTool(workingDirectory: string) {
	return definePowerTool(
		'grep',
		`Search file contents using regex patterns. Uses ripgrep (rg) if available, falls back to grep.

Rules:
- Supports full regex syntax
- Searches recursively from the given path
- Automatically excludes node_modules, .git, and binary files
- Results show file:line:content format
- Maximum ${MAX_RESULTS} matches returned`,
		[
			{ name: 'pattern', type: 'string', description: 'Regex pattern to search for', required: true },
			{ name: 'path', type: 'string', description: `Directory or file to search (default: ${workingDirectory})`, required: false },
			{ name: 'include', type: 'string', description: 'File glob to include (e.g. "*.ts")', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const pattern = args.pattern;
			if (typeof pattern !== 'string' || pattern.trim().length === 0) {
				return {
					title: 'Invalid pattern',
					output: 'Error: pattern must be a non-empty string.',
					metadata: { error: true },
				};
			}
			const searchPath = (args.path as string) ?? workingDirectory;
			const include = args.include as string | undefined;

			ctx.metadata({ title: `grep: ${pattern}` });

			const result = await new Promise<string>((resolve) => {
				// Try rg first, fallback to grep
				const includeFlag = include ? `--glob "${include}"` : '';
				const rgCmd = `rg --no-heading --line-number --max-count ${MAX_RESULTS} ${includeFlag} -- "${pattern.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null`;
				const grepCmd = `grep -rn --max-count=${MAX_RESULTS} ${include ? `--include="${include}"` : ''} -E "${pattern.replace(/"/g, '\\"')}" "${searchPath}" 2>/dev/null`;

				cp.exec(rgCmd, { cwd: workingDirectory, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
					if (stdout?.trim()) {
						resolve(stdout.trim());
						return;
					}
					// Fallback to grep
					cp.exec(grepCmd, { cwd: workingDirectory, timeout: 30000, maxBuffer: 1024 * 1024 }, (err2, stdout2) => {
						resolve(stdout2?.trim() || '');
					});
				});
			});

			const lines = result.split('\n').filter(Boolean);
			const matchCount = lines.length;

			if (matchCount === 0) {
				return {
					title: `grep: ${pattern}`,
					output: `No matches found for "${pattern}" in ${searchPath}`,
					metadata: { count: 0 },
				};
			}

			// Make paths relative
			const output = lines
				.map(line => {
					if (path.isAbsolute(line.split(':')[0])) {
						const colonIdx = line.indexOf(':');
						const filePart = line.substring(0, colonIdx);
						const rest = line.substring(colonIdx);
						return path.relative(workingDirectory, filePart) + rest;
					}
					return line;
				})
				.join('\n');

			return {
				title: `grep: ${pattern} (${matchCount} matches)`,
				output: `Found ${matchCount} matches for "${pattern}":\n\n${output}`,
				metadata: { count: matchCount },
			};
		},
	);
}
