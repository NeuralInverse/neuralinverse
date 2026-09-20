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
 * The service intentionally has no dependency on PowerMode or Checks — it is a
 * pure registry. Tool implementations live in their respective modules.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { InternalToolInfo } from '../common/prompt/prompts.js';


// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Immutable request identity threaded from every production entry point into
 * internal-tool execution (task F02/F11). The caller OWNS the identity: the
 * sidebar passes its thread id, the native chat bridge passes
 * `chatSessionResourceToId(sessionResource)`, workflow surfaces pass their
 * conversation/run ids. Tools must never guess an identity from ambient
 * singletons — a native request whose identity were resolved from the active
 * sidebar thread would read another conversation's archive.
 */
export interface ILedgerRequestContext {
	/** Immutable conversation/archive identity for the calling surface. */
	readonly conversationId: string;
	/** Distinct per run of an agent/workflow; undefined on the chat surfaces. */
	readonly runId?: string;
	/** Workflow step id when the request originates from a workflow step. */
	readonly stepId?: string;
	/** Which surface produced the request — decides archive scoping rules. */
	readonly source: 'sidebar-chat' | 'native-chat' | 'workflow';
}

/** A tool that can be registered with this service. */
export interface IVoidInternalTool {
	/** Unique tool name — must match what is advertised in the system prompt. */
	readonly name: string;
	/** Human-readable description passed to the LLM. */
	readonly description: string;
	/** Parameter schema passed to the LLM. */
	readonly params: Record<string, { description: string }>;
	/**
	 * Execute the tool with the given arguments. Returns a plain-text result
	 * string. `ctx` carries the caller-owned request identity — tools that
	 * touch per-conversation state require it and must reject when it is
	 * missing instead of falling back to an ambient singleton.
	 */
	execute(args: Record<string, unknown>, ctx?: ILedgerRequestContext): Promise<string>;
}


// ─── Service interface ────────────────────────────────────────────────────────

export const IVoidInternalToolService = createDecorator<IVoidInternalToolService>('voidInternalToolService');

export interface IVoidInternalToolService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeTools: Event<void>;

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

	/** Returns a tool by name, or undefined if not found. */
	getTool(name: string): IVoidInternalTool | undefined;

	/** Returns true if a tool with this name is registered. */
	has(name: string): boolean;

	/** Execute a registered tool. Throws if the tool is not found. */
	execute(name: string, args: Record<string, unknown>, ctx?: ILedgerRequestContext): Promise<string>;
}


// ─── Implementation ───────────────────────────────────────────────────────────

class VoidInternalToolService extends Disposable implements IVoidInternalToolService {
	declare readonly _serviceBrand: undefined;

	private readonly _tools = new Map<string, IVoidInternalTool>();
	private readonly _onDidChangeTools = this._register(new Emitter<void>());
	readonly onDidChangeTools: Event<void> = this._onDidChangeTools.event;

	register(tool: IVoidInternalTool): void {
		this._tools.set(tool.name, tool);
		this._onDidChangeTools.fire();
	}

	registerMany(tools: IVoidInternalTool[]): void {
		for (const t of tools) { this._tools.set(t.name, t); }
		this._onDidChangeTools.fire();
	}

	unregister(name: string): void {
		if (this._tools.delete(name)) {
			this._onDidChangeTools.fire();
		}
	}

	unregisterMany(names: string[]): void {
		let changed = false;
		for (const n of names) {
			if (this._tools.delete(n)) { changed = true; }
		}
		if (changed) { this._onDidChangeTools.fire(); }
	}

	getToolInfos(): InternalToolInfo[] {
		const result: InternalToolInfo[] = [];
		this._tools.forEach(t => result.push({ name: t.name, description: t.description, params: t.params }));
		return result;
	}

	getTool(name: string): IVoidInternalTool | undefined {
		return this._tools.get(name);
	}

	has(name: string): boolean {
		return this._tools.has(name);
	}

	async execute(name: string, args: Record<string, unknown>, ctx?: ILedgerRequestContext): Promise<string> {
		const tool = this._tools.get(name);
		if (!tool) { throw new Error(`Internal tool "${name}" not found`); }
		return tool.execute(args, ctx);
	}
}

registerSingleton(IVoidInternalToolService, VoidInternalToolService, InstantiationType.Eager);
