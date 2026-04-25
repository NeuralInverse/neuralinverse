/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VoidInternalToolService
 *
 * A local tool registry that lets first-party services register callable tools
 * for the Void agent (and copilot / validate modes) without requiring an external
 * MCP server. Internal tools are:
 *
 *   - Advertised to the LLM via the system-message tool-list (alongside MCP tools).
 *   - Executed locally (no network round-trip, no MCP server needed).
 *   - Registered at startup by workbench contributions (e.g. the Modernisation module).
 *
 * The service intentionally has no dependency on PowerMode or Checks \u2014 it is a
 * pure registry. Tool implementations live in their respective modules.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { InternalToolInfo } from '../common/prompt/prompts.js';


// \u2500\u2500\u2500 Public types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** A tool that can be registered with this service. */
export interface IVoidInternalTool {
	/** Unique tool name \u2014 must match what is advertised in the system prompt. */
	readonly name: string;
	/** Human-readable description passed to the LLM. */
	readonly description: string;
	/** Parameter schema passed to the LLM. */
	readonly params: Record<string, { description: string }>;
	/** Execute the tool with the given arguments. Returns a plain-text result string. */
	execute(args: Record<string, any>): Promise<string>;
}


// \u2500\u2500\u2500 Service interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const IVoidInternalToolService = createDecorator<IVoidInternalToolService>('voidInternalToolService');

export interface IVoidInternalToolService {
	readonly _serviceBrand: undefined;

	/** Register a tool. Safe to call multiple times with the same name (last wins). */
	register(tool: IVoidInternalTool): void;

	/** Register multiple tools at once. */
	registerMany(tools: IVoidInternalTool[]): void;

	/** Unregister a tool by name. No-op if the tool is not registered. */
	unregister(name: string): void;

	/** Unregister multiple tools by name. */
	unregisterMany(names: string[]): void;

	/** Returns InternalToolInfo[] for all registered tools, for LLM advertising. */
	getToolInfos(): InternalToolInfo[];

	/** Returns true if a tool with this name is registered. */
	has(name: string): boolean;

	/** Execute a registered tool. Throws if the tool is not found. */
	execute(name: string, args: Record<string, any>): Promise<string>;
}


// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

class VoidInternalToolService extends Disposable implements IVoidInternalToolService {
	declare readonly _serviceBrand: undefined;

	private readonly _tools = new Map<string, IVoidInternalTool>();

	register(tool: IVoidInternalTool): void {
		this._tools.set(tool.name, tool);
	}

	registerMany(tools: IVoidInternalTool[]): void {
		for (const t of tools) { this.register(t); }
	}

	unregister(name: string): void {
		this._tools.delete(name);
	}

	unregisterMany(names: string[]): void {
		for (const n of names) { this._tools.delete(n); }
	}

	getToolInfos(): InternalToolInfo[] {
		const result: InternalToolInfo[] = [];
		this._tools.forEach(t => result.push({ name: t.name, description: t.description, params: t.params }));
		return result;
	}

	has(name: string): boolean {
		return this._tools.has(name);
	}

	async execute(name: string, args: Record<string, any>): Promise<string> {
		const tool = this._tools.get(name);
		if (!tool) { throw new Error(`Internal tool "${name}" not found`); }
		return tool.execute(args);
	}
}

registerSingleton(IVoidInternalToolService, VoidInternalToolService, InstantiationType.Eager);
