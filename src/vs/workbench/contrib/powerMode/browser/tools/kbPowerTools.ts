/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * KB Power Tools
 *
 * Adapts the 67 Knowledge Base agent tool definitions from `IModernisationAgentToolService`
 * into `IPowerTool[]` for registration in the Power Mode `PowerToolRegistry`.
 *
 * These tools give Power Mode agents full access to the KB layer:
 *   - Unit read/write (get_unit, list_units, record_translation, flag_ready \u2026)
 *   - Decision management (answer_decision, record_type_mapping \u2026)
 *   - Glossary, business rules, phases, work packages
 *   - Compliance gates, checkpoints, tags, health checks
 *   - All advanced queries (filter_units, get_stale_units, topological_order \u2026)
 *
 * Autonomy tools (autonomy_*) are intentionally excluded here \u2014 they are
 * registered separately via `buildAutonomyPowerTools()` which binds directly
 * to `IAutonomyService` for richer session-reactive behaviour.
 *
 * ## Adapter
 *
 *   `IAgentToolDefinition.inputSchema.properties` \u2192 `IPowerToolParameter[]`
 *   `agentTools.executeTool(name, args)` \u2192 `tool.execute(args, ctx)`
 *
 * The result from `executeTool` is already a formatted string (JSON) so it is
 * returned directly as `IToolResult.output`.
 */

import { IPowerTool, IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { IModernisationAgentToolService } from '../../../neuralInverseModernisation/browser/engine/agentTools/service.js';
import { IAgentToolDefinition } from '../../../neuralInverseModernisation/browser/engine/agentTools/agentToolTypes.js';


// \u2500\u2500\u2500 Adapter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _adapt(def: IAgentToolDefinition, agentTools: IModernisationAgentToolService): IPowerTool {
	// Build IPowerToolParameter[] from the JSON-schema properties map.
	const props    = (def.inputSchema?.properties ?? {}) as Record<string, { description?: string; type?: string }>;
	const required = (def.inputSchema?.required ?? []) as string[];

	const parameters = Object.entries(props).map(([name, schema]) => ({
		name,
		type:        schema.type ?? 'string',
		description: schema.description ?? name,
		required:    required.includes(name),
	}));

	return {
		id:          def.name,
		description: def.description,
		parameters,
		async execute(args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> {
			ctx.metadata({ title: def.name });
			const output = await agentTools.executeTool(def.name, args);
			return { title: def.name, output, metadata: {} };
		},
	};
}


// \u2500\u2500\u2500 Factory \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Build all 67 KB tools as `IPowerTool[]` for the Power Mode registry.
 *
 * Autonomy tools (autonomy_*) are excluded \u2014 they are registered separately
 * by `buildAutonomyPowerTools()` which has richer session-reactive behaviour.
 *
 * @param agentTools  The DI-registered `IModernisationAgentToolService` instance.
 */
export function buildKBPowerTools(agentTools: IModernisationAgentToolService): IPowerTool[] {
	return agentTools
		.getContextualToolDefinitions(false)          // 67 KB tools + 6 default autonomy defs
		.filter(d => !d.name.startsWith('autonomy_')) // exclude \u2014 registered via buildAutonomyPowerTools
		.map(def => _adapt(def, agentTools));
}
