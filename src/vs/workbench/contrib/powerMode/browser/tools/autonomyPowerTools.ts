/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Autonomy Power Tools
 *
 * Adapts the 10 `IAutonomyTool` implementations from the Autonomy engine into
 * `IPowerTool` instances for registration in the Power Mode `PowerToolRegistry`.
 *
 * The adapter is trivial:
 *   - Parameter shapes are identical (`name / type / description / required`).
 *   - `execute(args)` is wrapped to match `execute(args, ctx): Promise<IToolResult>`.
 *   - Tool metadata title is set from the tool ID for tool-call rendering.
 *
 * ## Usage (in PowerModeService._getToolRegistry)
 *
 * ```typescript
 * ...buildAutonomyPowerTools(this._autonomy),
 * ```
 */

import { IPowerTool, IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { IAutonomyService } from '../../../neuralInverseModernisation/browser/engine/autonomy/service.js';
import { buildAutonomyTools, IAutonomyTool } from '../../../neuralInverseModernisation/browser/engine/autonomy/autonomyTools.js';


// \u2500\u2500\u2500 Adapter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _adapt(tool: IAutonomyTool): IPowerTool {
	return {
		id:          tool.id,
		description: tool.description,
		parameters:  tool.parameters,    // IAutonomyToolParam[] is structurally identical to IPowerToolParameter[]
		async execute(args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> {
			ctx.metadata({ title: tool.id });
			const output = await tool.execute(args);
			return { title: tool.id, output, metadata: {} };
		},
	};
}


// \u2500\u2500\u2500 Factory \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Build all 10 autonomy tools as `IPowerTool[]` for the Power Mode registry.
 *
 * @param autonomyService  The DI-registered `IAutonomyService` instance.
 */
export function buildAutonomyPowerTools(autonomyService: IAutonomyService): IPowerTool[] {
	return buildAutonomyTools(autonomyService).map(_adapt);
}
