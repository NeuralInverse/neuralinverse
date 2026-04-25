/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Firmware tools for Power Mode agents.
 *
 * Adapts IVoidInternalTool[] from IFirmwareAgentToolService into IPowerTool[]
 * so Power Mode can call fw_* tools natively (not via bash echo workarounds).
 *
 * Only included when a firmware session is active \u2014 the caller is responsible
 * for conditional inclusion based on session state.
 */

import { IFirmwareAgentToolService } from '../../../neuralInverseFirmware/browser/engine/agentTools/firmwareAgentToolService.js';
import { IPowerTool, IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { definePowerTool } from './powerToolRegistry.js';


/**
 * Build firmware Power Mode tools from the firmware agent tool service.
 * Returns an empty array when the service is unavailable or session inactive.
 */
export function buildFirmwarePowerTools(
	firmwareAgentToolService: IFirmwareAgentToolService,
): IPowerTool[] {
	return firmwareAgentToolService.getTools().map(tool =>
		definePowerTool(
			tool.name,
			tool.description,
			// Adapt IVoidInternalTool params \u2192 IPowerToolParameter[]
			Object.entries(tool.params).map(([name, param]) => ({
				name,
				type: 'string',
				description: param.description,
				required: false,
			})),
			// Adapt execute: IVoidInternalTool returns string; IPowerTool returns IToolResult
			async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
				ctx.metadata({ title: tool.name });
				const output = await tool.execute(args);
				return { title: tool.name, output, metadata: {} };
			},
		)
	);
}
