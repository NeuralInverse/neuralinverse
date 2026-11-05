/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IGRCEngineService } from '../../engine/services/grcEngineService.js';
import { ProjectAnalyzer } from '../projectAnalyzer.js';

/**
 * NanoAgentService — AI-powered code analysis nano agents.
 * OSS stub: no AI calls, returns empty results.
 */
export class NanoAgentService extends Disposable {
	constructor(
		private readonly _projectAnalyzer: ProjectAnalyzer,
		private readonly _grcEngine: IGRCEngineService,
	) {
		super();
		void this._projectAnalyzer;
		void this._grcEngine;
	}
}
