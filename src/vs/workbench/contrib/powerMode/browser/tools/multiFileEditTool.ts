/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *
 *  Multi-File Edit Tool — Cursor Composer-style batch file editing for Power Mode agents.
 *
 *  Enables the agent to edit multiple files in a single tool call, similar to Cursor's
 *  Composer. Each edit is validated independently — if one edit fails, the others still
 *  execute and the result reports per-file success/failure.
 *
 *  Parameters:
 *    edits: Array of { filePath, old_string, new_string }
 *    description: Human-readable summary of what this batch accomplishes
 *
 *  Returns per-file results with success/failure status and error messages.
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';

const MAX_EDITS_PER_BATCH = 50;

function _resolve(workingDirectory: string, filePath: string): string {
	const _WIN_DRIVE_RE = /^[a-zA-Z]:[\\/]/;
	const isAbsolute = filePath.startsWith('/') || _WIN_DRIVE_RE.test(filePath);
	if (isAbsolute) { return filePath; }
	const base = workingDirectory.replace(/\\/g, '/');
	const rel = filePath.replace(/\\/g, '/');
	return base + (base.endsWith('/') ? '' : '/') + rel;
}

function _isWithinWorkspace(filePath: string, workingDirectory: string): boolean {
	const resolved = _resolve('', filePath);
	const resolvedWorkspace = _resolve('', workingDirectory);
	return resolved === resolvedWorkspace || resolved.startsWith(resolvedWorkspace + '/') || resolved.startsWith(resolvedWorkspace + '\\');
}

export function createMultiFileEditTool(
	workingDirectory: string,
	fileService: IFileService
): IPowerTool {
	return definePowerTool(
		'multi_file_edit',
		`Edit multiple files in a single batch — similar to Cursor's Composer.

Use this when you need to change several files for one feature (e.g. adding a new
API endpoint requires touching the route, controller, model, and test files).

Each edit is validated independently. If one edit fails (file not found,
old_string not unique, etc.), the other edits still execute and the result
reports per-file success/failure.

Parameters:
- edits: Array of objects, each with:
  - filePath: Absolute path to the file to edit
  - old_string: The exact string to replace (must be unique in the file)
  - new_string: The replacement string
- description: Brief description of what this batch accomplishes (5-10 words)

Returns:
- A summary of all edits with per-file success/failure status
- Each file's result includes: success, title, output, error (if failed)`,

		[
			{
				name: 'edits',
				type: 'array',
				description: 'Array of file edits to perform',
				required: true,
			},
			{
				name: 'description',
				type: 'string',
				description: 'Brief description of what this batch accomplishes',
				required: true,
			},
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const editsParam = args.edits;
			const description = args.description;

			if (!Array.isArray(editsParam)) {
				return {
					title: 'Invalid edits parameter',
					output: 'Error: edits must be an array of { filePath, old_string, new_string } objects.',
					metadata: { error: true },
				};
			}
			if (editsParam.length === 0) {
				return {
					title: 'No edits provided',
					output: 'Error: edits array must contain at least one edit.',
					metadata: { error: true },
				};
			}
			if (editsParam.length > MAX_EDITS_PER_BATCH) {
				return {
					title: 'Too many edits',
					output: `Error: Maximum ${MAX_EDITS_PER_BATCH} edits per batch. Split into multiple calls.`,
					metadata: { error: true },
				};
			}
			if (typeof description !== 'string' || description.trim().length === 0) {
				return {
					title: 'Invalid description',
					output: 'Error: description must be a non-empty string.',
					metadata: { error: true },
				};
			}

			ctx.metadata({ title: `Multi-file edit: ${description}` });

			const results: Array<{
				filePath: string;
				success: boolean;
				title: string;
				output: string;
				error?: string;
				removedLines?: number;
				addedLines?: number;
			}> = [];

			let totalSuccess = 0;
			let totalFailed = 0;
			let totalLinesRemoved = 0;
			let totalLinesAdded = 0;

			for (const edit of editsParam) {
				const filePath = edit.filePath;
				const oldString = edit.old_string;
				const newString = edit.new_string;

				// Validate individual edit
				if (typeof filePath !== 'string' || filePath.trim().length === 0) {
					results.push({
						filePath: String(filePath ?? ''),
						success: false,
						title: 'Invalid file path',
						output: 'Error: filePath must be a non-empty string.',
						error: 'invalid_file_path',
					});
					totalFailed++;
					continue;
				}
				if (typeof oldString !== 'string') {
					results.push({
						filePath,
						success: false,
						title: 'Invalid old_string',
						output: 'Error: old_string must be a string.',
						error: 'invalid_old_string',
					});
					totalFailed++;
					continue;
				}
				if (typeof newString !== 'string') {
					results.push({
						filePath,
						success: false,
						title: 'Invalid new_string',
						output: 'Error: new_string must be a string.',
						error: 'invalid_new_string',
					});
					totalFailed++;
					continue;
				}

				let resolvedPath = _resolve(workingDirectory, filePath);
				if (!_isWithinWorkspace(resolvedPath, workingDirectory)) {
					results.push({
						filePath,
						success: false,
						title: 'Access denied',
						output: `Error: ${resolvedPath} is outside the workspace.`,
						error: 'access_denied',
					});
					totalFailed++;
					continue;
				}

				ctx.metadata({ title: `Editing ${_basename(resolvedPath)}` });

				try {
					// Read current content
					let content: string;
					try {
						const fileContent = await fileService.readFile(URI.file(resolvedPath));
						content = fileContent.value.toString();
					} catch {
						results.push({
							filePath: resolvedPath,
							success: false,
							title: 'File not found',
							output: `Error: File not found: ${resolvedPath}`,
							error: 'file_not_found',
						});
						totalFailed++;
						continue;
					}

					// Find and validate the match
					const index = content.indexOf(oldString);
					if (index === -1) {
						results.push({
							filePath: resolvedPath,
							success: false,
							title: 'old_string not found',
							output: `Error: old_string not found in ${resolvedPath}.`,
							error: 'old_string_not_found',
						});
						totalFailed++;
						continue;
					}

					// Check uniqueness
					const secondIndex = content.indexOf(oldString, index + 1);
					if (secondIndex !== -1) {
						results.push({
							filePath: resolvedPath,
							success: false,
							title: 'old_string not unique',
							output: `Error: old_string found ${content.split(oldString).length - 1} times in ${resolvedPath}. Include more context.`,
							error: 'old_string_not_unique',
						});
						totalFailed++;
						continue;
					}

					// Apply edit
					const newContent = content.substring(0, index) + newString + content.substring(index + oldString.length);
					await fileService.writeFile(URI.file(resolvedPath), VSBuffer.fromString(newContent));

					const removedLines = oldString.split('\n').length;
					const addedLines = newString.split('\n').length;
					totalLinesRemoved += removedLines;
					totalLinesAdded += addedLines;
					totalSuccess++;

					results.push({
						filePath: resolvedPath,
						success: true,
						title: `Edited ${_basename(resolvedPath)}`,
						output: `Applied edit: -${removedLines} lines, +${addedLines} lines`,
						removedLines,
						addedLines,
					});
				} catch (err: any) {
					results.push({
						filePath: resolvedPath,
						success: false,
						title: 'Edit failed',
						output: `Error: ${err.message}`,
						error: err.message,
					});
					totalFailed++;
				}
			}

			// Build summary output
			const lines: string[] = [];
			lines.push(`Multi-file edit complete: ${description}`);
			lines.push(`============================================`);
			lines.push(`Total edits: ${editsParam.length}`);
			lines.push(`Successful: ${totalSuccess}`);
			lines.push(`Failed: ${totalFailed}`);
			lines.push(`Net lines: +${totalLinesAdded} / -${totalLinesRemoved}`);
			lines.push('');

			for (const r of results) {
				const icon = r.success ? '✓' : '✗';
				lines.push(`${icon} ${_basename(r.filePath)}`);
				lines.push(`   ${r.output}`);
				if (r.error) {
					lines.push(`   Error: ${r.error}`);
				}
			}

			return {
				title: `Multi-file edit: ${totalSuccess} succeeded, ${totalFailed} failed`,
				output: lines.join('\n'),
				metadata: {
					description,
					totalEdits: editsParam.length,
					totalSuccess,
					totalFailed,
					totalLinesRemoved,
					totalLinesAdded,
					results,
					allSucceeded: totalFailed === 0,
				},
			};
		},
	);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function _basename(p: string): string {
	const normalized = p.replace(/\\/g, '/');
	const parts = normalized.split('/');
	return parts[parts.length - 1] || normalized;
}
