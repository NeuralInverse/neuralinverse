/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *
 *  Licensed under the Business Source License 1.1 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at https://mariadb.com/bsl11
 *
 *  Change Date: 2029-07-14
 *  Change License: GNU Affero General Public License v3.0
 *
 *  Use of this software in production requires a commercial license from Neural Inverse Inc.
 *  Contact (code): github@neuralinverse.com | Contact (sales): sales@neuralinverse.com
 *--------------------------------------------------------------------------------------------*/

/**
 * Checks Tool Registry
 *
 * Holds all GRC tools available to the Checks Agent.
 * Adapted from PowerToolRegistry — simplified (no permission tiers, all tools are safe).
 */

import { IChecksTool } from './checksAgentTypes.js';
import { InternalToolInfo } from '../../../void/common/prompt/prompts.js';

export class ChecksToolRegistry {

	private readonly _tools = new Map<string, IChecksTool>();

	register(tool: IChecksTool): void {
		this._tools.set(tool.id, tool);
	}

	registerMany(tools: IChecksTool[]): void {
		for (const tool of tools) {
			this.register(tool);
		}
	}

	get(id: string): IChecksTool | undefined {
		return this._tools.get(id);
	}

	getAll(): IChecksTool[] {
		return [...this._tools.values()];
	}

	getToolNames(): string[] {
		return [...this._tools.keys()];
	}

	/**
	 * Build InternalToolInfo[] for the LLM bridge (mcpTools format).
	 */
	buildToolInfos(): InternalToolInfo[] {
		return this.getAll().map(tool => {
			const params: Record<string, { description: string }> = {};
			for (const p of tool.parameters) {
				params[p.name] = { description: p.description };
			}
			return {
				name: tool.id,
				description: tool.description,
				params,
			};
		});
	}

	/**
	 * Build JSON schema for LLM tool declaration.
	 */
	buildToolSchemas(): Record<string, { description: string; parameters: Record<string, any> }> {
		const schemas: Record<string, { description: string; parameters: Record<string, any> }> = {};
		for (const tool of this.getAll()) {
			const properties: Record<string, any> = {};
			const required: string[] = [];
			for (const p of tool.parameters) {
				properties[p.name] = { type: p.type, description: p.description };
				if (p.required) { required.push(p.name); }
			}
			schemas[tool.id] = {
				description: tool.description,
				parameters: { type: 'object', properties, required },
			};
		}
		return schemas;
	}
}

/**
 * Helper to define a GRC tool.
 */
export function defineChecksTool(
	id: string,
	description: string,
	parameters: IChecksTool['parameters'],
	execute: (args: Record<string, any>) => Promise<string>,
): IChecksTool {
	return { id, description, parameters, execute };
}
