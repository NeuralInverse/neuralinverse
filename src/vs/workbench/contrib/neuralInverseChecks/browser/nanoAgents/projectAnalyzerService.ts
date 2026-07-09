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

import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';

export interface INanoAgentContext {
	fileUri: URI;
	symbols: string[];
	references: string[];
	metrics: Record<string, number>;
	analyzed: boolean;
}

export interface IDashboardState {
	totalFiles: number;
	analyzedFiles: number;
	isAnalyzing: boolean;
}

export const IProjectAnalyzerService = createDecorator<IProjectAnalyzerService>('projectAnalyzerService');

export interface IProjectAnalyzerService {
	readonly _serviceBrand: undefined;
	getContextForFile(fileUri: URI): INanoAgentContext;
	getDashboardState(): IDashboardState;
	analyzeFile(fileUri: URI): Promise<void>;
	analyzeWorkspace(): Promise<void>;
	loadAuditData(fileUri: URI): Promise<unknown[]>;
	readonly onDidAnalysisComplete: Event<URI>;
}
