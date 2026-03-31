/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

export function createEditTool(workingDirectory: string) {
	return definePowerTool(
		'edit',
		`Edit a file by replacing a specific string with new content. The old_string must match EXACTLY (including whitespace and indentation).

Rules:
- old_string must be unique in the file — provide enough context to be unambiguous
- For creating new files, use the write tool instead
- For multiple edits to the same file, make separate edit calls
- Preserve existing indentation style`,
		[
			{ name: 'filePath', type: 'string', description: 'Absolute path to the file to edit', required: true },
			{ name: 'old_string', type: 'string', description: 'The exact string to replace (must be unique in the file)', required: true },
			{ name: 'new_string', type: 'string', description: 'The replacement string', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			let filePath = (args.filePath as string) || '';
			const oldString = (args.old_string as string) ?? '';
			const newString = (args.new_string as string) ?? '';

			if (!filePath.trim()) {
				return { title: 'edit: missing filePath', output: 'Required argument "filePath" was not provided.', metadata: { error: true } };
			}
			if (!oldString) {
				return { title: 'edit: missing old_string', output: 'Required argument "old_string" was not provided.', metadata: { error: true } };
			}

			if (!path.isAbsolute(filePath)) {
				filePath = path.resolve(workingDirectory, filePath);
			}

			const title = path.relative(workingDirectory, filePath);

			// Read current content
			let content: string;
			try {
				content = await fsPromises.readFile(filePath, 'utf8');
			} catch {
				throw new Error(`File not found: ${filePath}`);
			}

			// Find and validate the match
			const index = content.indexOf(oldString);
			if (index === -1) {
				// Try to provide helpful error
				const lines = content.split('\n');
				const firstWords = oldString.split('\n')[0].trim().substring(0, 50);
				const candidates = lines
					.map((line, i) => ({ line: line.trim(), num: i + 1 }))
					.filter(l => l.line.includes(firstWords.substring(0, 20)))
					.slice(0, 3);

				let msg = `old_string not found in ${filePath}.`;
				if (candidates.length > 0) {
					msg += '\n\nPossible matches near:';
					for (const c of candidates) {
						msg += `\n  Line ${c.num}: ${c.line.substring(0, 80)}`;
					}
				}
				throw new Error(msg);
			}

			// Check uniqueness
			const secondIndex = content.indexOf(oldString, index + 1);
			if (secondIndex !== -1) {
				throw new Error(
					`old_string is not unique in ${filePath} (found at positions ${index} and ${secondIndex}). ` +
					`Include more surrounding context to make it unique.`
				);
			}

			// Apply edit
			const newContent = content.substring(0, index) + newString + content.substring(index + oldString.length);
			await fsPromises.writeFile(filePath, newContent, 'utf8');

			const removedLines = oldString.split('\n').length;
			const addedLines = newString.split('\n').length;

			return {
				title: `edited ${title}`,
				output: `Applied edit to ${filePath}: -${removedLines} lines, +${addedLines} lines`,
				metadata: {
					filePath,
					removedLines,
					addedLines,
				},
			};
		},
	);
}
