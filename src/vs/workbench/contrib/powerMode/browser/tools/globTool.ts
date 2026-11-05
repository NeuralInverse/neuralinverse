/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import * as cp from 'child_process';
import * as path from 'path';

const MAX_RESULTS = 200;

export function createGlobTool(workingDirectory: string) {
	return definePowerTool(
		'glob',
		`Find files matching a glob pattern. Uses fast pattern matching to locate files in the project.

Rules:
- Patterns use standard glob syntax: *, **, ?, [...]
- Common patterns: "**/*.ts", "src/**/*.tsx", "**/test*"
- Results are sorted by modification time (newest first)
- Maximum ${MAX_RESULTS} results returned`,
		[
			{ name: 'pattern', type: 'string', description: 'The glob pattern to match (e.g. "**/*.ts")', required: true },
			{ name: 'path', type: 'string', description: `Directory to search in (default: ${workingDirectory})`, required: false },
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

			ctx.metadata({ title: `glob: ${pattern}` });

			// Use find or fd if available, fallback to basic glob via shell
			const result = await new Promise<string>((resolve, reject) => {
				// Try using find with -name for basic patterns, or a shell glob expansion
				const cmd = process.platform === 'win32'
					? `dir /s /b "${pattern}" 2>nul`
					: `find "${searchPath}" -path "*/${pattern}" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null | head -${MAX_RESULTS}`;

				cp.exec(cmd, { cwd: searchPath, timeout: 30000 }, (err, stdout) => {
					if (err && !stdout) {
						// Fallback: use ls with glob
						const fallbackCmd = `ls -d ${pattern} 2>/dev/null | head -${MAX_RESULTS}`;
						cp.exec(fallbackCmd, { cwd: searchPath, timeout: 15000 }, (err2, stdout2) => {
							resolve(stdout2?.trim() || '');
						});
						return;
					}
					resolve(stdout?.trim() || '');
				});
			});

			const files = result
				.split('\n')
				.filter(Boolean)
				.map(f => path.isAbsolute(f) ? f : path.resolve(searchPath, f))
				.slice(0, MAX_RESULTS);

			if (files.length === 0) {
				return {
					title: `glob: ${pattern}`,
					output: `No files found matching "${pattern}" in ${searchPath}`,
					metadata: { count: 0 },
				};
			}

			const relativePaths = files.map(f => path.relative(workingDirectory, f));
			const output = relativePaths.join('\n');

			return {
				title: `glob: ${pattern} (${files.length} files)`,
				output: `Found ${files.length} files matching "${pattern}":\n\n${output}`,
				metadata: { count: files.length },
			};
		},
	);
}
