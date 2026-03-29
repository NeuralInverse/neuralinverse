/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { IPowerTool } from '../../common/powerModeTypes.js';

/** GRC tools — not available in community edition */
export function buildGRCTools(
	_grcEngine: unknown,
	_queryChecksAgent: (question: string) => Promise<string>,
): IPowerTool[] {
	return [];
}
