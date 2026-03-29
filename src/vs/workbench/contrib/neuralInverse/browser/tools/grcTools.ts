/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { IAgentTool } from '../../common/workflowTypes.js';

/** GRC tools — not available in community edition */
export function createGRCTools(_grcEngine: unknown): IAgentTool[] {
	return [];
}

export const GRC_TOOL_NAMES: readonly string[] = [];
export type GRCToolName = string;
