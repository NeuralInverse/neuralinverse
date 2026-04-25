/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * Claude Code parity tools for Power Mode.
 *
 * Ports & adapts tools from the Claude Code CLI into the VS Code extension context.
 * Each tool follows the IPowerTool interface with VS Code DI services.
 *
 * New tools (11):
 *  - notebook_edit      Edit Jupyter notebook cells (.ipynb)
 *  - web_search         Search the web (DuckDuckGo JSON API)
 *  - multi_edit         Multiple exact-string replacements in one file
 *  - enter_plan_mode    Switch session to read-only planning mode
 *  - exit_plan_mode     Exit plan mode and resume editing
 *  - enter_worktree     Create a git worktree and switch session into it
 *  - exit_worktree      Exit worktree (keep or remove)
 *  - cron_create        Schedule a recurring or one-shot prompt
 *  - cron_list          List active cron jobs
 *  - cron_delete        Delete a cron job
 *  - send_message       Send a message to a PowerBus agent
 */

import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IExternalCommandExecutor } from '../../../neuralInverseChecks/browser/engine/services/externalCommandExecutor.js';
import { IPowerTool, IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { definePowerTool } from './powerToolRegistry.js';
import { IPowerModeChangeTracker } from '../powerModeChangeTracker.js';

// \u2500\u2500\u2500 Cron Scheduler \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface ICronJob {
	id: string;
	/** Standard 5-field cron expression (minute hour dom month dow) */
	cron: string;
	/** Prompt text to send to the session when the job fires */
	prompt: string;
	recurring: boolean;
	durable: boolean;
	createdAt: number;
	nextFire?: number;
}

/**
 * In-memory cron scheduler. Created once per PowerModeService, shared across sessions.
 * Polls every 30s; fires jobs by calling the onFire callback with the job and its sessionId.
 */
export class PowerCronScheduler {
	private readonly _jobs = new Map<string, { job: ICronJob; sessionId: string }>();
	private _idCounter = 0;
	private _tickInterval: ReturnType<typeof setInterval> | undefined;
	private _onFire: ((job: ICronJob, sessionId: string) => void) | undefined;

	start(onFire: (job: ICronJob, sessionId: string) => void): void {
		this._onFire = onFire;
		this._tickInterval = setInterval(() => this._tick(), 30_000);
	}

	stop(): void {
		if (this._tickInterval !== undefined) {
			clearInterval(this._tickInterval);
			this._tickInterval = undefined;
		}
	}

	add(cron: string, prompt: string, recurring: boolean, durable: boolean, sessionId: string): ICronJob {
		const id = `cron_${++this._idCounter}`;
		const job: ICronJob = {
			id,
			cron,
			prompt,
			recurring,
			durable,
			createdAt: Date.now(),
			nextFire: _cronNextMs(cron),
		};
		this._jobs.set(id, { job, sessionId });
		return job;
	}

	remove(id: string): boolean {
		return this._jobs.delete(id);
	}

	list(sessionId?: string): ICronJob[] {
		const all = [...this._jobs.values()];
		return sessionId
			? all.filter(e => e.sessionId === sessionId).map(e => e.job)
			: all.map(e => e.job);
	}

	get(id: string): { job: ICronJob; sessionId: string } | undefined {
		return this._jobs.get(id);
	}

	private _tick(): void {
		const now = Date.now();
		for (const [id, entry] of this._jobs) {
			const { job, sessionId } = entry;
			if (job.nextFire && now >= job.nextFire) {
				this._onFire?.(job, sessionId);
				if (job.recurring) {
					job.nextFire = _cronNextMs(job.cron);
				} else {
					this._jobs.delete(id);
				}
			}
		}
	}
}

/**
 * Parse a 5-field cron expression and return the next fire time in ms.
 * Supports * , - / patterns for minute and hour fields.
 */
function _cronNextMs(cron: string): number {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) { return Date.now() + 60_000; }

	const [minExpr, hourExpr] = parts;
	const candidate = new Date();
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);

	// Try the next 1440 minutes (one day)
	for (let i = 0; i < 1440; i++) {
		const m = candidate.getMinutes();
		const h = candidate.getHours();
		if (_matchesCronField(m, minExpr, 0, 59) && _matchesCronField(h, hourExpr, 0, 23)) {
			return candidate.getTime();
		}
		candidate.setMinutes(candidate.getMinutes() + 1);
	}
	return Date.now() + 60_000 * 60;
}

function _matchesCronField(value: number, expr: string, min: number, max: number): boolean {
	if (expr === '*') { return true; }
	if (expr.includes('/')) {
		const [base, step] = expr.split('/');
		const stepNum = parseInt(step);
		const startNum = base === '*' ? min : parseInt(base);
		if (isNaN(stepNum) || isNaN(startNum)) { return false; }
		return (value - startNum) % stepNum === 0 && value >= startNum;
	}
	if (expr.includes(',')) {
		return expr.split(',').some(p => parseInt(p) === value);
	}
	if (expr.includes('-')) {
		const [lo, hi] = expr.split('-').map(Number);
		return value >= lo && value <= hi;
	}
	return parseInt(expr) === value;
}

export function cronToHuman(cron: string): string {
	const parts = cron.trim().split(/\s+/);
	if (parts.length !== 5) { return cron; }
	const [min, hour, dom, month, dow] = parts;
	if (min === '*' && hour === '*') { return 'every minute'; }
	if (hour === '*') {
		if (min.startsWith('*/')) { return `every ${min.slice(2)} minutes`; }
		return `at minute ${min} of every hour`;
	}
	if (min === '0' && dom === '*' && month === '*' && dow === '*') {
		return `daily at ${hour.padStart(2, '0')}:00`;
	}
	if (min.startsWith('*/') && hour === '*') {
		return `every ${min.slice(2)} minutes`;
	}
	return cron;
}

// \u2500\u2500\u2500 Worktree Info \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IWorktreeInfo {
	path: string;
	branch: string;
	originalDirectory: string;
}

// \u2500\u2500\u2500 Notebook Edit \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface INotebook {
	cells: INotebookCell[];
	metadata?: Record<string, any>;
	nbformat?: number;
	nbformat_minor?: number;
}

interface INotebookCell {
	cell_type: 'code' | 'markdown' | 'raw';
	source: string | string[];
	metadata: Record<string, any>;
	outputs?: any[];
	execution_count?: number | null;
	id?: string;
}

export function createNotebookEditTool(
	workingDirectory: string,
	fileService: IFileService,
	changeTracker?: IPowerModeChangeTracker,
): IPowerTool {
	return definePowerTool(
		'notebook_edit',
		`Edit a Jupyter notebook (.ipynb) cell. Supports replace, insert, and delete.

Rules:
- Read the notebook first with the 'read' tool before editing
- cell_id can be a 0-based numeric index or the cell's UUID
- edit_mode "insert" adds a new cell AFTER the specified cell_id
- edit_mode "delete" removes the cell (new_source is ignored)
- Editing a code cell resets its execution_count and outputs`,
		[
			{ name: 'notebookPath', type: 'string', description: 'Absolute path to the .ipynb file', required: true },
			{ name: 'cellId', type: 'string', description: 'Cell index (0-based) or cell UUID to target', required: false },
			{ name: 'newSource', type: 'string', description: 'New cell source code/markdown', required: false },
			{ name: 'cellType', type: 'string', description: '"code" or "markdown" (default: code)', required: false },
			{ name: 'editMode', type: 'string', description: '"replace" (default), "insert" (after cellId), or "delete"', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			let notebookPath = args.notebookPath as string;
			const cellId = args.cellId as string | undefined;
			const newSource = (args.newSource as string | undefined) ?? '';
			const cellType = (args.cellType as string | undefined) ?? 'code';
			const editMode = (args.editMode as string | undefined) ?? 'replace';

			if (!notebookPath.startsWith('/')) {
				notebookPath = workingDirectory + '/' + notebookPath;
			}

			const fileName = notebookPath.split('/').pop() ?? notebookPath;
			ctx.metadata({ title: `Edit notebook: ${fileName}` });

			const uri = URI.file(notebookPath);

			let changeId: string | undefined;
			if (changeTracker) {
				changeId = await changeTracker.trackChange({
					filePath: notebookPath,
					changeType: 'edit',
					sessionId: ctx.sessionId,
					agentId: ctx.agentId,
				});
			}

			try {
				const content = await fileService.readFile(uri);
				const nb = JSON.parse(content.value.toString()) as INotebook;

				if (!nb.cells || !Array.isArray(nb.cells)) {
					return { title: 'Invalid notebook', output: 'Notebook has no cells array', metadata: { error: true } };
				}

				// Resolve cell index
				let idx = -1;
				if (cellId !== undefined) {
					const num = parseInt(cellId);
					if (!isNaN(num) && num >= 0 && num < nb.cells.length) {
						idx = num;
					} else {
						idx = nb.cells.findIndex(c => c.id === cellId || c.metadata?.id === cellId);
					}
					if (idx === -1) {
						return { title: 'Cell not found', output: `No cell with id/index: ${cellId}`, metadata: { error: true } };
					}
				}

				// Source lines format
				const srcLines = newSource.split('\n').map((l, i, arr) => i < arr.length - 1 ? l + '\n' : l);

				if (editMode === 'delete') {
					if (idx === -1) { return { title: 'Error', output: 'cell_id required for delete', metadata: { error: true } }; }
					nb.cells.splice(idx, 1);
				} else if (editMode === 'insert') {
					const newCell: INotebookCell = {
						cell_type: cellType === 'markdown' ? 'markdown' : 'code',
						source: srcLines,
						metadata: {},
						outputs: cellType === 'code' ? [] : undefined,
						execution_count: cellType === 'code' ? null : undefined,
					};
					const insertAt = idx === -1 ? nb.cells.length : idx + 1;
					nb.cells.splice(insertAt, 0, newCell);
				} else {
					// replace
					if (idx === -1) { return { title: 'Error', output: 'cell_id required for replace', metadata: { error: true } }; }
					const cell = nb.cells[idx];
					cell.source = srcLines;
					if (cell.cell_type === 'code') {
						cell.execution_count = null;
						cell.outputs = [];
					}
				}

				const updated = JSON.stringify(nb, null, 1);
				await fileService.writeFile(uri, VSBuffer.fromString(updated));

				if (changeTracker && changeId) {
					await changeTracker.finalizeChange(changeId, updated);
				}

				return {
					title: `Notebook ${editMode} done`,
					output: `${editMode === 'delete' ? 'Deleted' : editMode === 'insert' ? 'Inserted' : 'Replaced'} cell in ${fileName}. Total cells: ${nb.cells.length}`,
					metadata: { cellCount: nb.cells.length, editMode },
				};
			} catch (err: any) {
				return { title: 'Notebook edit error', output: `Error: ${err.message}`, metadata: { error: true } };
			}
		},
	);
}

// \u2500\u2500\u2500 Web Search \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface IDDGResponse {
	Heading?: string;
	AbstractText?: string;
	AbstractURL?: string;
	Answer?: string;
	RelatedTopics?: Array<{ Text?: string; FirstURL?: string } | { Topics?: any[] }>;
}

export function createWebSearchTool(): IPowerTool {
	return definePowerTool(
		'web_search',
		`Search the web for current information using DuckDuckGo.

Rules:
- Use for finding current docs, library versions, error solutions, recent news
- Results include title, URL, and a short snippet per match
- Combine with web_fetch to read the full page for a promising result
- Up to 10 results returned`,
		[
			{ name: 'query', type: 'string', description: 'Search query (min 2 characters)', required: true },
			{ name: 'maxResults', type: 'number', description: 'Max results (default: 10, max: 10)', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const query = args.query as string;
			const maxResults = Math.min((args.maxResults as number) ?? 10, 10);

			if (!query || query.trim().length < 2) {
				return { title: 'Invalid query', output: 'Query must be at least 2 characters', metadata: { error: true } };
			}

			ctx.metadata({ title: `Search: ${query}` });

			try {
				const encodedQuery = encodeURIComponent(query);
				const url = `https://api.duckduckgo.com/?q=${encodedQuery}&format=json&no_html=1&skip_disambig=1`;

				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 15_000);

				const response = await fetch(url, {
					signal: controller.signal,
					headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NeuralInverse/1.0)' },
				});
				clearTimeout(timeoutId);

				if (!response.ok) {
					return { title: `Search: ${query}`, output: `Search failed: HTTP ${response.status}`, metadata: { error: true } };
				}

				const data = await response.json() as IDDGResponse;
				const results: string[] = [];

				// Direct answer
				if (data.Answer) {
					results.push(`**Answer:** ${data.Answer}`);
				}

				// Abstract (e.g. Wikipedia summary)
				if (data.AbstractText) {
					results.push(`**${data.Heading || 'Overview'}**\n${data.AbstractText}\nSource: ${data.AbstractURL || ''}`);
				}

				// Related topics
				if (data.RelatedTopics) {
					for (const topic of data.RelatedTopics) {
						if (results.length >= maxResults) { break; }
						if ('Text' in topic && topic.Text && topic.FirstURL) {
							results.push(`\u2022 ${topic.Text.substring(0, 200)}\n  URL: ${topic.FirstURL}`);
						}
					}
				}

				if (results.length === 0) {
					// Fallback: fetch DuckDuckGo lite HTML and parse links
					try {
						const liteUrl = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}`;
						const liteResp = await fetch(liteUrl, {
							headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NeuralInverse/1.0)' },
						});
						if (liteResp.ok) {
							const html = await liteResp.text();
							const linkPattern = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
							let match;
							while ((match = linkPattern.exec(html)) !== null && results.length < maxResults) {
								const href = match[1];
								const text = match[2].trim();
								if (!href.includes('duckduckgo.com') && text.length > 5) {
									results.push(`\u2022 ${text}\n  URL: ${href}`);
								}
							}
						}
					} catch { /* ignore fallback error */ }
				}

				if (results.length === 0) {
					return {
						title: `Search: ${query}`,
						output: `No results found for "${query}". Try rephrasing or use web_fetch with a direct URL.`,
						metadata: { query, count: 0 },
					};
				}

				return {
					title: `Search: ${query} (${results.length} results)`,
					output: `Results for "${query}":\n\n${results.slice(0, maxResults).join('\n\n')}`,
					metadata: { query, count: results.length },
				};
			} catch (err: any) {
				if (err.name === 'AbortError') {
					return { title: `Search: ${query}`, output: 'Search timed out after 15s. Try web_fetch with a direct URL.', metadata: { error: true } };
				}
				return { title: `Search: ${query}`, output: `Error: ${err.message}`, metadata: { error: true } };
			}
		},
	);
}

// \u2500\u2500\u2500 Multi Edit \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function createMultiEditTool(
	workingDirectory: string,
	fileService: IFileService,
	changeTracker?: IPowerModeChangeTracker,
): IPowerTool {
	return definePowerTool(
		'multi_edit',
		`Apply multiple non-overlapping string replacements to a single file in one operation.

Rules:
- More efficient than calling 'edit' multiple times on the same file
- All old_string values must be unique in the file
- Edits are applied in order \u2014 earlier edits must not affect later matches
- Use for refactoring multiple callsites in one file at once`,
		[
			{ name: 'filePath', type: 'string', description: 'Absolute path to the file', required: true },
			{
				name: 'edits', type: 'array',
				description: 'JSON array of {old_string, new_string} edit pairs, e.g. [{"old_string":"foo","new_string":"bar"}]',
				required: true,
			},
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			let filePath = args.filePath as string;
			let edits = args.edits as Array<{ old_string: string; new_string: string }>;

			if (!filePath.startsWith('/')) {
				filePath = workingDirectory + '/' + filePath;
			}

			// Accept edits as JSON string or parsed array
			if (typeof edits === 'string') {
				try { edits = JSON.parse(edits); } catch {
					return { title: 'Invalid edits', output: 'edits must be a JSON array of {old_string, new_string}', metadata: { error: true } };
				}
			}

			if (!Array.isArray(edits) || edits.length === 0) {
				return { title: 'No edits', output: 'No edits provided', metadata: { error: true } };
			}

			const fileName = filePath.split('/').pop() ?? filePath;
			ctx.metadata({ title: `Multi-edit ${fileName} (${edits.length} edits)` });

			const uri = URI.file(filePath);
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
				let text = content.value.toString();
				const errors: string[] = [];
				let successCount = 0;

				for (let i = 0; i < edits.length; i++) {
					const edit = edits[i];
					if (!edit.old_string || edit.new_string === undefined) {
						errors.push(`Edit ${i + 1}: missing old_string or new_string`);
						continue;
					}
					const count = text.split(edit.old_string).length - 1;
					if (count === 0) {
						errors.push(`Edit ${i + 1}: old_string not found in file`);
						continue;
					}
					if (count > 1) {
						errors.push(`Edit ${i + 1}: old_string found ${count} times \u2014 must be unique`);
						continue;
					}
					text = text.replace(edit.old_string, edit.new_string);
					successCount++;
				}

				if (successCount === 0) {
					return { title: 'All edits failed', output: errors.join('\n'), metadata: { error: true } };
				}

				await fileService.writeFile(uri, VSBuffer.fromString(text));

				if (changeTracker && changeId) {
					await changeTracker.finalizeChange(changeId, text);
				}

				let output = `Applied ${successCount}/${edits.length} edits to ${fileName}`;
				if (errors.length > 0) { output += `\n\nFailed:\n${errors.join('\n')}`; }

				return { title: `Multi-edited ${fileName}`, output, metadata: { successCount, totalEdits: edits.length } };
			} catch (err: any) {
				return { title: 'Multi-edit error', output: `Error: ${err.message}`, metadata: { error: true } };
			}
		},
	);
}

// \u2500\u2500\u2500 Plan Mode \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function createEnterPlanModeTool(
	setPlanMode: (sessionId: string, enabled: boolean) => void,
): IPowerTool {
	return definePowerTool(
		'enter_plan_mode',
		`Switch the current session to read-only PLAN MODE.

In plan mode:
- write, edit, multi_edit, bash are BLOCKED
- All read tools (read, glob, grep, list, git_log, git_diff, web_search) work normally
- Use this before making sweeping changes to explore the codebase first

Best practice:
1. enter_plan_mode
2. Explore thoroughly (read, grep, glob, git_log, web_search)
3. Write out the full implementation plan as text
4. exit_plan_mode \u2014 provide the plan in the 'plan' parameter
5. Implement`,
		[],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			ctx.metadata({ title: 'Entering plan mode' });
			setPlanMode(ctx.sessionId, true);
			return {
				title: 'Plan mode ON',
				output: `Plan mode ACTIVE.\n\nWrite tools blocked: write, edit, multi_edit, bash, git_commit, git_push.\n\nExplore the codebase freely, then call exit_plan_mode with your implementation plan.`,
				metadata: { planMode: true },
			};
		},
	);
}

export function createExitPlanModeTool(
	setPlanMode: (sessionId: string, enabled: boolean) => void,
): IPowerTool {
	return definePowerTool(
		'exit_plan_mode',
		`Exit plan mode and resume full editing capabilities.

Provide your implementation plan in the 'plan' parameter. The user will see it before execution proceeds.`,
		[
			{ name: 'plan', type: 'string', description: 'Your implementation plan \u2014 what you will do and in what order', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const plan = args.plan as string;
			ctx.metadata({ title: 'Exiting plan mode' });
			setPlanMode(ctx.sessionId, false);
			return {
				title: 'Plan mode OFF',
				output: `Plan mode DEACTIVATED \u2014 write tools restored.\n\n## Implementation Plan\n\n${plan}\n\n---\nProceeding with implementation.`,
				metadata: { planMode: false },
			};
		},
	);
}

// \u2500\u2500\u2500 Worktree \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function createEnterWorktreeTool(
	getDirectory: (sessionId: string) => string,
	commandExecutor: IExternalCommandExecutor,
	setWorktree: (sessionId: string, info: IWorktreeInfo) => void,
): IPowerTool {
	return definePowerTool(
		'enter_worktree',
		`Create a git worktree and switch this session into it.

A worktree is an isolated checkout of the repo on a new branch. Use it to:
- Safely experiment with large refactors without touching the main branch
- Run two features in parallel across different sessions
- Test risky changes in isolation before merging

All file operations (read, write, edit, bash) will apply to the worktree path.
Exit with exit_worktree when done.`,
		[
			{ name: 'name', type: 'string', description: 'Branch and worktree name (letters, digits, hyphens, dots). Defaults to "wt-<timestamp>"', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const rawName = (args.name as string | undefined) ?? `wt-${Date.now()}`;
			const name = rawName.replace(/[^a-zA-Z0-9._-]/g, '-');
			const directory = getDirectory(ctx.sessionId);

			ctx.metadata({ title: `Creating worktree: ${name}` });

			const worktreePath = `${directory}/.worktrees/${name}`;
			const jobId = `wt_enter_${Date.now()}`;

			try {
				const cmd = [
					`cd ${_shellQuote(directory)}`,
					`mkdir -p .worktrees`,
					`git worktree add ${_shellQuote(worktreePath)} -b ${_shellQuote(name)} 2>&1`,
				].join(' && ');

				const output = await commandExecutor.execute(jobId, cmd, 30_000, 10 * 1024);

				if (output.toLowerCase().includes('fatal:') || output.toLowerCase().includes('error:')) {
					return { title: 'Worktree failed', output: output.trim(), metadata: { error: true } };
				}

				setWorktree(ctx.sessionId, {
					path: worktreePath,
					branch: name,
					originalDirectory: directory,
				});

				return {
					title: `Worktree: ${name}`,
					output: [
						`Worktree created. Session switched to isolated branch.`,
						``,
						`  Path:     ${worktreePath}`,
						`  Branch:   ${name}`,
						`  Original: ${directory}`,
						``,
						`All file operations now apply to the worktree.`,
						`Use exit_worktree when done.`,
					].join('\n'),
					metadata: { worktreePath, branch: name, originalDirectory: directory },
				};
			} catch (err: any) {
				return { title: 'Worktree error', output: `Error: ${err.message}`, metadata: { error: true } };
			}
		},
	);
}

export function createExitWorktreeTool(
	getWorktree: (sessionId: string) => IWorktreeInfo | undefined,
	commandExecutor: IExternalCommandExecutor,
	clearWorktree: (sessionId: string) => void,
): IPowerTool {
	return definePowerTool(
		'exit_worktree',
		`Exit the current git worktree and return the session to the original directory.

action:
- "keep"   \u2014 Leave the worktree and branch intact. You can merge it manually later.
- "remove" \u2014 Delete the worktree directory and branch. Requires discard_changes:true if uncommitted work exists.`,
		[
			{ name: 'action', type: 'string', description: '"keep" or "remove"', required: true },
			{ name: 'discardChanges', type: 'boolean', description: 'Set true to confirm discarding uncommitted changes (only needed for action="remove")', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const action = args.action as 'keep' | 'remove';
			const discardChanges = (args.discardChanges as boolean | undefined) ?? false;

			const worktree = getWorktree(ctx.sessionId);
			if (!worktree) {
				return { title: 'Not in a worktree', output: 'Session is not in a worktree. Use enter_worktree first.', metadata: { error: true } };
			}

			ctx.metadata({ title: `Exit worktree (${action})` });

			if (action === 'remove') {
				// Check for uncommitted changes
				const checkJobId = `wt_check_${Date.now()}`;
				const checkCmd = `cd ${_shellQuote(worktree.path)} && git status --porcelain 2>/dev/null | wc -l`;
				let changeCount = 0;
				try {
					const checkOut = await commandExecutor.execute(checkJobId, checkCmd, 5000, 1024);
					changeCount = parseInt(checkOut.trim()) || 0;
				} catch { /* ignore */ }

				if (changeCount > 0 && !discardChanges) {
					return {
						title: 'Uncommitted changes',
						output: `Worktree has ${changeCount} uncommitted change(s).\nSet discardChanges: true to confirm removal, or use action: "keep".`,
						metadata: { hasChanges: true, changeCount },
					};
				}

				const removeJobId = `wt_remove_${Date.now()}`;
				const removeCmd = [
					`cd ${_shellQuote(worktree.originalDirectory)}`,
					`git worktree remove ${_shellQuote(worktree.path)} ${discardChanges ? '--force' : ''} 2>&1`,
					`git branch -D ${_shellQuote(worktree.branch)} 2>/dev/null || true`,
				].join(' && ');

				try {
					await commandExecutor.execute(removeJobId, removeCmd, 15_000, 10 * 1024);
				} catch (err: any) {
					return { title: 'Remove failed', output: `Error removing worktree: ${err.message}`, metadata: { error: true } };
				}
			}

			clearWorktree(ctx.sessionId);

			return {
				title: `Worktree ${action === 'keep' ? 'exited' : 'removed'}`,
				output: [
					`Session returned to: ${worktree.originalDirectory}`,
					``,
					action === 'keep'
						? `Worktree preserved at ${worktree.path} on branch ${worktree.branch}.`
						: `Worktree and branch "${worktree.branch}" removed.`,
				].join('\n'),
				metadata: { worktreePath: worktree.path, branch: worktree.branch, action },
			};
		},
	);
}

// \u2500\u2500\u2500 Cron Tools \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function createCronCreateTool(scheduler: PowerCronScheduler): IPowerTool {
	return definePowerTool(
		'cron_create',
		`Schedule a recurring or one-shot prompt to be sent to this session automatically.

The prompt fires as a user message at the scheduled time, triggering the agent loop.

cron expression (5 fields):  minute hour day-of-month month day-of-week
Examples:
  "*/5 * * * *"   \u2192 every 5 minutes
  "0 9 * * *"     \u2192 daily at 09:00
  "0 */2 * * *"   \u2192 every 2 hours
  "0 9 * * 1"     \u2192 every Monday at 09:00`,
		[
			{ name: 'cron', type: 'string', description: '5-field cron expression', required: true },
			{ name: 'prompt', type: 'string', description: 'Prompt to send when the job fires', required: true },
			{ name: 'recurring', type: 'boolean', description: 'Repeat on schedule (default: true). Set false for one-shot.', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const cron = args.cron as string;
			const prompt = args.prompt as string;
			const recurring = (args.recurring as boolean | undefined) ?? true;

			ctx.metadata({ title: 'Scheduling task...' });

			const parts = cron.trim().split(/\s+/);
			if (parts.length !== 5) {
				return { title: 'Invalid cron', output: 'Cron expression must have exactly 5 fields: minute hour dom month dow', metadata: { error: true } };
			}

			const job = scheduler.add(cron, prompt, recurring, false, ctx.sessionId);
			const humanSchedule = cronToHuman(cron);
			const nextStr = job.nextFire ? new Date(job.nextFire).toLocaleString() : 'unknown';

			return {
				title: `Scheduled: ${job.id}`,
				output: [
					`Cron job created.`,
					``,
					`  ID:       ${job.id}`,
					`  Schedule: ${humanSchedule}  (${cron})`,
					`  Type:     ${recurring ? 'recurring' : 'one-shot'}`,
					`  Next:     ${nextStr}`,
					`  Prompt:   "${prompt.substring(0, 100)}${prompt.length > 100 ? '...' : ''}"`,
				].join('\n'),
				metadata: { jobId: job.id, cron, recurring, nextFire: job.nextFire },
			};
		},
	);
}

export function createCronListTool(scheduler: PowerCronScheduler): IPowerTool {
	return definePowerTool(
		'cron_list',
		`List all active cron jobs scheduled for this session.`,
		[],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			ctx.metadata({ title: 'Listing cron jobs' });

			const jobs = scheduler.list(ctx.sessionId);
			if (jobs.length === 0) {
				return { title: 'No cron jobs', output: 'No cron jobs are scheduled. Use cron_create to schedule one.', metadata: { count: 0 } };
			}

			const lines = jobs.map(j => {
				const human = cronToHuman(j.cron);
				const nextStr = j.nextFire ? new Date(j.nextFire).toLocaleString() : '-';
				return [
					`${j.id}  ${human.padEnd(22)}  [${j.recurring ? 'recurring' : 'one-shot'}]  next: ${nextStr}`,
					`  \u2514\u2500 "${j.prompt.substring(0, 70)}${j.prompt.length > 70 ? '...' : ''}"`,
				].join('\n');
			});

			return {
				title: `${jobs.length} cron job${jobs.length !== 1 ? 's' : ''}`,
				output: lines.join('\n\n'),
				metadata: { count: jobs.length },
			};
		},
	);
}

export function createCronDeleteTool(scheduler: PowerCronScheduler): IPowerTool {
	return definePowerTool(
		'cron_delete',
		`Delete (cancel) a scheduled cron job by ID.`,
		[
			{ name: 'jobId', type: 'string', description: 'The cron job ID returned by cron_create', required: true },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const jobId = args.jobId as string;
			ctx.metadata({ title: `Cancel cron ${jobId}` });

			const entry = scheduler.get(jobId);
			if (!entry) {
				return { title: 'Job not found', output: `No cron job found with ID: ${jobId}`, metadata: { error: true } };
			}

			scheduler.remove(jobId);

			return {
				title: `Deleted: ${jobId}`,
				output: `Cron job ${jobId} cancelled.\n\nWas: ${cronToHuman(entry.job.cron)} \u2014 "${entry.job.prompt.substring(0, 60)}"`,
				metadata: { jobId, cron: entry.job.cron },
			};
		},
	);
}

// \u2500\u2500\u2500 Send Message \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function createSendMessageTool(
	sendBusMessage: (to: string, content: string, type: string) => void,
	getBusAgents: () => string[],
): IPowerTool {
	return definePowerTool(
		'send_message',
		`Send a message to another agent on the PowerBus.

Use "*" to broadcast to all registered agents.

Available agents are discoverable via list_agents or cron_list.

Use cases:
- Ask Checks Agent about a compliance issue: to="checks-agent"
- Notify Modernisation Agent of a state change
- Broadcast a progress update to all agents`,
		[
			{ name: 'to', type: 'string', description: 'Target agent name or "*" for broadcast', required: true },
			{ name: 'content', type: 'string', description: 'Message content', required: true },
			{ name: 'type', type: 'string', description: '"query" (default, expects reply) or "broadcast" (no reply expected)', required: false },
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const to = args.to as string;
			const content = args.content as string;
			const msgType = (args.type as string | undefined) ?? 'query';

			ctx.metadata({ title: `\u2192 ${to}` });

			if (to !== '*') {
				const agents = getBusAgents();
				if (!agents.includes(to)) {
					return {
						title: 'Agent not found',
						output: `Agent "${to}" is not registered on the PowerBus.\n\nAvailable: ${agents.join(', ') || '(none)'}`,
						metadata: { error: true, availableAgents: agents },
					};
				}
			}

			sendBusMessage(to, content, msgType);

			return {
				title: `Sent \u2192 ${to}`,
				output: `Message dispatched to "${to}".\n\nContent: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`,
				metadata: { to, type: msgType },
			};
		},
	);
}

// \u2500\u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _shellQuote(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}
