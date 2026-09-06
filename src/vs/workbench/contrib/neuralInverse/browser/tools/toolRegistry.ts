/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { IAgentTool } from '../../common/workflowTypes.js';

/**
 * Aliases for tool names that appear in agent definitions but don't match a
 * registered tool. Most come from the Void chat tool vocabulary or plain
 * hand-editing; mapping them keeps those agents working instead of silently
 * stripping the capability.
 */
const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
	// http
	webFetch: 'httpRequest',
	web_fetch: 'httpRequest',
	fetchUrl: 'httpRequest',
	// files — there is no diff-based edit tool in this registry; writeFile covers it
	editFile: 'writeFile',
	edit_file: 'writeFile',
	rewriteFile: 'writeFile',
	rewrite_file: 'writeFile',
	write_file: 'writeFile',
	read_file: 'readFile',
	delete_file: 'deleteFile',
	// terminal
	bash: 'runCommand',
	run: 'runCommand',
	exec: 'runCommand',
	shell: 'runCommand',
	terminal: 'runCommand',
	run_script: 'runScript',
	// git
	git_status: 'gitStatus',
	git_diff: 'gitDiff',
	git_log: 'gitLog',
	// search
	grep: 'searchCode',
	search: 'searchCode',
	glob: 'listDirectory',
	list_dir: 'listDirectory',
};

/**
 * # Tool Registry
 *
 * Central registry for all IAgentTool implementations available to workflow agents.
 *
 * Tools are registered once at service startup. Each workflow step receives a
 * scoped view of the registry — only the tools listed in IWorkflowStep.allowedTools
 * are accessible during that step's execution.
 *
 * Usage:
 * ```ts
 * registry.register(new ReadFileTool())
 * registry.register(new WriteFileTool())
 *
 * // During execution — scoped to this step's allowedTools
 * const scoped = registry.scope(['readFile', 'listDirectory'])
 * const tool = scoped.get('readFile')
 * ```
 */
export class ToolRegistry {

	private readonly _tools = new Map<string, IAgentTool>();

	// ─── Registration ──────────────────────────────────────────────────────────

	register(tool: IAgentTool): void {
		if (this._tools.has(tool.name)) {
			console.warn(`[ToolRegistry] Tool "${tool.name}" already registered — overwriting`);
		}
		this._tools.set(tool.name, tool);
	}

	registerMany(tools: IAgentTool[]): void {
		for (const tool of tools) {
			this.register(tool);
		}
	}

	// ─── Lookup ────────────────────────────────────────────────────────────────

	get(name: string): IAgentTool | undefined {
		return this._tools.get(name);
	}

	getAll(): IAgentTool[] {
		return [...this._tools.values()];
	}

	has(name: string): boolean {
		return this._tools.has(name);
	}

	// ─── Scoping ───────────────────────────────────────────────────────────────

	/**
	 * Returns a scoped view that only exposes the listed tool names.
	 * Unknown names are ignored with a warning.
	 *
	 * Used to enforce IWorkflowStep.allowedTools at runtime.
	 */
	scope(allowedToolNames: string[]): ScopedToolRegistry {
		const allowed = new Map<string, IAgentTool>();
		for (const rawName of allowedToolNames) {
			// Agent definitions written against the Void chat tool vocabulary
			// (or by hand) reference names that don't exist here — without
			// aliasing, those agents silently lose the whole capability
			// (e.g. web-researcher with only "webFetch" ended up tool-less).
			const name = TOOL_NAME_ALIASES[rawName] ?? rawName;
			const tool = this._tools.get(name);
			if (tool) {
				if (!allowed.has(name)) allowed.set(name, tool);
			} else {
				console.warn(`[ToolRegistry] Scoped tool "${rawName}" not found in registry`);
			}
		}
		return new ScopedToolRegistry(allowed);
	}

	// ─── Schema Generation ────────────────────────────────────────────────────

	/**
	 * Returns the full tool schema array for injection into LLM system prompts.
	 * Format is compatible with OpenAI / Anthropic tool_use blocks.
	 */
	getSchema(toolNames?: string[]): object[] {
		const tools = toolNames
			? toolNames.map(n => this._tools.get(n)).filter((t): t is IAgentTool => !!t)
			: this.getAll();

		return tools.map(t => ({
			name: t.name,
			description: t.description,
			input_schema: {
				type: 'object',
				properties: Object.fromEntries(
					Object.entries(t.parameters).map(([key, param]) => [key, {
						type: param.type,
						description: param.description,
						...(param.enum ? { enum: param.enum } : {}),
						...(param.items ? { items: param.items } : {}),
					}])
				),
				required: Object.entries(t.parameters)
					.filter(([, p]) => p.required)
					.map(([name]) => name),
			},
		}));
	}
}

// ─── Scoped Registry ──────────────────────────────────────────────────────────

/**
 * A read-only, pre-filtered view of the ToolRegistry.
 * Only exposes tools that were explicitly allowed for a specific step.
 */
export class ScopedToolRegistry {

	constructor(private readonly _tools: Map<string, IAgentTool>) {}

	get(name: string): IAgentTool | undefined {
		return this._tools.get(name);
	}

	getAll(): IAgentTool[] {
		return [...this._tools.values()];
	}

	getSchema(): object[] {
		return [...this._tools.values()].map(t => ({
			name: t.name,
			description: t.description,
			input_schema: {
				type: 'object',
				properties: Object.fromEntries(
					Object.entries(t.parameters).map(([key, param]) => [key, {
						type: param.type,
						description: param.description,
						...(param.enum ? { enum: param.enum } : {}),
						...(param.items ? { items: param.items } : {}),
					}])
				),
				required: Object.entries(t.parameters)
					.filter(([, p]) => p.required)
					.map(([name]) => name),
			},
		}));
	}
}
