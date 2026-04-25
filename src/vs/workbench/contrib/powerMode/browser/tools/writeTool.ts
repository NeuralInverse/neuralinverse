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
- Do NOT use this to append \u2014 it always overwrites the entire file
- For modifications to existing files, prefer the edit tool instead`,
		[
			{ name: 'filePath', type: 'string', description: 'Absolute path to the file to write', required: true },
			{ name: 'content', type: 'string', description: 'The full content to write to the file', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			let filePath = args.filePath as string;
			const content = args.content as string;

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
