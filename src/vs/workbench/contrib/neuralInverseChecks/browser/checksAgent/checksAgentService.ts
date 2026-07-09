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
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IChecksSession, ChecksAgentUIEvent, IDomainSummary } from './checksAgentTypes.js';
import { ICheckResult, IGRCRule } from '../engine/types/grcTypes.js';
import { IExternalJob } from '../engine/types/externalJobTypes.js';

export type ModelOption = { id: string; label: string };
export type ModelSelection = { provider: string; model: string };

export const IChecksAgentService = createDecorator<IChecksAgentService>('checksAgentService');

export interface IChecksAgentService {
	readonly _serviceBrand: undefined;
	readonly onDidEmitUIEvent: Event<ChecksAgentUIEvent>;
	sendMessage(message: string): Promise<void>;
	cancelCurrentRun(): void;
	clearSession(): void;
	getActiveSession(): IChecksSession | undefined;
	getDomainSummary(): IDomainSummary[];
	getBlockingViolations(): ICheckResult[];
	getRuleDetails(ruleId: string): IGRCRule | undefined;
	getExternalToolStatus(): IExternalJob[];
	getModelInfo(): string;
	getAvailableModels(): ModelOption[];
	setModel(selection: ModelSelection): void;
}
