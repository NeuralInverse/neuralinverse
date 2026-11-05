/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

export function createListTool(workingDirectory: string) {
	return definePowerTool(
		'list',
		`List files and directories at a given path. Shows entries with type indicators (trailing / for directories).`,
		[
			{ name: 'path', type: 'string', description: `Directory to list (default: ${workingDirectory})`, required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			let dirPath = (args.path as string) ?? workingDirectory;
			if (typeof dirPath !== 'string' || dirPath.trim().length === 0) {
				dirPath = workingDirectory;
			}
			const title = path.relative(workingDirectory, dirPath) || '.';

			const dirents = await fsPromises.readdir(dirPath, { withFileTypes: true });
			const entries = dirents
				.map(d => d.isDirectory() ? d.name + '/' : d.name)
				.sort((a, b) => {
					// Directories first
					const aDir = a.endsWith('/');
					const bDir = b.endsWith('/');
					if (aDir !== bDir) { return aDir ? -1 : 1; }
					return a.localeCompare(b);
				});

			return {
				title: `ls ${title}`,
				output: entries.join('\n') || '(empty directory)',
				metadata: { count: entries.length },
			};
		},
	);
}
