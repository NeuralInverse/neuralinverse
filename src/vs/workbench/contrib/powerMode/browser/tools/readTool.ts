/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { createInterface } from 'readline';

const DEFAULT_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_BYTES = 50 * 1024;

export function createReadTool(workingDirectory: string) {
	return definePowerTool(
		'read',
		`Read a file or directory from the filesystem. Returns file contents with line numbers, or directory listings.

Rules:
- Always use absolute paths
- For large files, use offset and limit to read specific sections
- Output is capped at 2000 lines and 50KB
- Binary files cannot be read`,
		[
			{ name: 'filePath', type: 'string', description: 'The absolute path to the file or directory to read', required: true },
			{ name: 'offset', type: 'number', description: 'Line number to start reading from (1-indexed)', required: false },
			{ name: 'limit', type: 'number', description: 'Maximum number of lines to read (default: 2000)', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			let filePath = (args.filePath as string) || '';
			if (!filePath.trim()) {
				return { title: 'read: missing filePath', output: 'Required argument "filePath" was not provided.', metadata: { error: true } };
			}
			const offset = (args.offset as number) ?? 1;
			const limit = (args.limit as number) ?? DEFAULT_LIMIT;

			if (!path.isAbsolute(filePath)) {
				filePath = path.resolve(workingDirectory, filePath);
			}

			const title = path.relative(workingDirectory, filePath);
			let stat: fs.Stats;

			try {
				stat = await fsPromises.stat(filePath);
			} catch {
				// Try to suggest similar files
				const dir = path.dirname(filePath);
				const base = path.basename(filePath);
				try {
					const entries = await fsPromises.readdir(dir);
					const suggestions = entries
						.filter(e => e.toLowerCase().includes(base.toLowerCase()))
						.slice(0, 3)
						.map(e => path.join(dir, e));
					if (suggestions.length > 0) {
						throw new Error(`File not found: ${filePath}\n\nDid you mean?\n${suggestions.join('\n')}`);
					}
				} catch { /* ignore */ }
				throw new Error(`File not found: ${filePath}`);
			}

			// Directory listing
			if (stat.isDirectory()) {
				const dirents = await fsPromises.readdir(filePath, { withFileTypes: true });
				const entries = dirents.map(d => d.isDirectory() ? d.name + '/' : d.name).sort();
				const start = offset - 1;
				const sliced = entries.slice(start, start + limit);
				const truncated = start + sliced.length < entries.length;

				const output = [
					`<path>${filePath}</path>`,
					`<type>directory</type>`,
					`<entries>`,
					sliced.join('\n'),
					truncated
						? `\n(Showing ${sliced.length} of ${entries.length} entries)`
						: `\n(${entries.length} entries)`,
					`</entries>`,
				].join('\n');

				return { title, output, metadata: { truncated } };
			}

			// File reading
			const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
			const rl = createInterface({ input: stream, crlfDelay: Infinity });

			const raw: string[] = [];
			let bytes = 0;
			let lines = 0;
			let truncatedByBytes = false;
			let hasMoreLines = false;
			const start = offset - 1;

			try {
				for await (const text of rl) {
					lines++;
					if (lines <= start) { continue; }
					if (raw.length >= limit) { hasMoreLines = true; continue; }

					const line = text.length > MAX_LINE_LENGTH
						? text.substring(0, MAX_LINE_LENGTH) + '... (truncated)'
						: text;
					const size = Buffer.byteLength(line, 'utf-8') + (raw.length > 0 ? 1 : 0);

					if (bytes + size > MAX_BYTES) {
						truncatedByBytes = true;
						hasMoreLines = true;
						break;
					}

					raw.push(line);
					bytes += size;
				}
			} finally {
				rl.close();
				stream.destroy();
			}

			const content = raw.map((line, i) => `${i + offset}: ${line}`);
			let output = `<path>${filePath}</path>\n<type>file</type>\n<content>\n`;
			output += content.join('\n');

			const lastLine = offset + raw.length - 1;
			const truncated = hasMoreLines || truncatedByBytes;

			if (truncatedByBytes) {
				output += `\n\n(Output capped at 50KB. Lines ${offset}-${lastLine}. Use offset=${lastLine + 1} to continue.)`;
			} else if (hasMoreLines) {
				output += `\n\n(Lines ${offset}-${lastLine} of ${lines}. Use offset=${lastLine + 1} to continue.)`;
			} else {
				output += `\n\n(End of file - ${lines} lines total)`;
			}
			output += '\n</content>';

			return { title, output, metadata: { truncated, preview: raw.slice(0, 20).join('\n') } };
		},
	);
}
