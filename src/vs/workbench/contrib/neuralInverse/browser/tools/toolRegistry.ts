/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { IAgentTool } from '../../common/workflowTypes.js';

/**
 * # Tool Registry
 *
 * Central registry for all IAgentTool implementations available to workflow agents.
 *
 * Tools are registered once at service startup. Each workflow step receives a
 * scoped view of the registry \u2014 only the tools listed in IWorkflowStep.allowedTools
 * are accessible during that step's execution.
 *
 * Usage:
 * ```ts
 * registry.register(new ReadFileTool())
 * registry.register(new WriteFileTool())
 *
 * // During execution \u2014 scoped to this step's allowedTools
 * const scoped = registry.scope(['readFile', 'listDirectory'])
 * const tool = scoped.get('readFile')
 * ```
 */
export class ToolRegistry {

	private readonly _tools = new Map<string, IAgentTool>();

	// \u2500\u2500\u2500 Registration \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	register(tool: IAgentTool): void {
		if (this._tools.has(tool.name)) {
			console.warn(`[ToolRegistry] Tool "${tool.name}" already registered \u2014 overwriting`);
		}
		this._tools.set(tool.name, tool);
	}

	registerMany(tools: IAgentTool[]): void {
		for (const tool of tools) {
			this.register(tool);
		}
	}

	// \u2500\u2500\u2500 Lookup \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	get(name: string): IAgentTool | undefined {
		return this._tools.get(name);
	}

	getAll(): IAgentTool[] {
		return [...this._tools.values()];
	}

	has(name: string): boolean {
		return this._tools.has(name);
	}

	// \u2500\u2500\u2500 Scoping \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Returns a scoped view that only exposes the listed tool names.
	 * Unknown names are silently ignored.
	 *
	 * Used to enforce IWorkflowStep.allowedTools at runtime.
	 */
	scope(allowedToolNames: string[]): ScopedToolRegistry {
		const allowed = new Map<string, IAgentTool>();
		for (const name of allowedToolNames) {
			const tool = this._tools.get(name);
			if (tool) {
				allowed.set(name, tool);
			} else {
				console.warn(`[ToolRegistry] Scoped tool "${name}" not found in registry`);
			}
		}
		return new ScopedToolRegistry(allowed);
	}

	// \u2500\u2500\u2500 Schema Generation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

// \u2500\u2500\u2500 Scoped Registry \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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
