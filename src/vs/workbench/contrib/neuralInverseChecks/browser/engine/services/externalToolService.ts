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

import { Event } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ICheckResult, IGRCRule } from '../types/grcTypes.js';
import { IExternalJob } from '../types/externalJobTypes.js';

export const IExternalToolService = createDecorator<IExternalToolService>('neuralInverseExternalToolService');

export interface IExternalToolService {
	readonly _serviceBrand: undefined;
	readonly onDidJobUpdate: Event<IExternalJob>;
	getJobs(): IExternalJob[];
	runWorkspaceScans(rules: IGRCRule[]): Promise<void>;
	runFileScans(rules: IGRCRule[], fileUri: URI, content: string): void;
	registerResultSink(fn: (fileUri: URI, ruleId: string, results: ICheckResult[]) => void): void;
}
