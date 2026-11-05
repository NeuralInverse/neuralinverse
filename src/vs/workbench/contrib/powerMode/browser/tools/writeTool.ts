/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

export function createWriteTool(workingDirectory: string) {
	return definePowerTool(
		'write',
		`Write content to a file. Creates the file (and parent directories) if they don't exist. Overwrites existing content.

Rules:
- Always use absolute paths
- Will create parent directories automatically
- Do NOT use this to append — it always overwrites the entire file
- For modifications to existing files, prefer the edit tool instead`,
		[
			{ name: 'filePath', type: 'string', description: 'Absolute path to the file to write', required: true },
			{ name: 'content', type: 'string', description: 'The full content to write to the file', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const rawFilePath = args.filePath;
			const content = args.content;
			if (typeof rawFilePath !== 'string' || rawFilePath.trim().length === 0) {
				return {
					title: 'Invalid file path',
					output: 'Error: filePath must be a non-empty string.',
					metadata: { error: true },
				};
			}
			if (typeof content !== 'string') {
				return {
					title: 'Invalid content',
					output: 'Error: content must be a string.',
					metadata: { error: true },
				};
			}
			let filePath = rawFilePath;

			if (!path.isAbsolute(filePath)) {
				filePath = path.resolve(workingDirectory, filePath);
			}

			const title = path.relative(workingDirectory, filePath);

			// Create parent directories
			await fsPromises.mkdir(path.dirname(filePath), { recursive: true });

			// Write file
			await fsPromises.writeFile(filePath, content, 'utf8');

			const lines = content.split('\n').length;
			const bytes = Buffer.byteLength(content, 'utf-8');

			return {
				title: `wrote ${title}`,
				output: `Successfully wrote ${lines} lines (${bytes} bytes) to ${filePath}`,
				metadata: {
					filePath,
					lines,
					bytes,
				},
			};
		},
	);
}
