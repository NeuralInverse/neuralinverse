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

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';

export interface IFeedbackEntry {
	readonly ruleId: string;
	readonly fileBasename: string;
	readonly codeSnippet: string;
	readonly aiConfidence: 'high' | 'medium' | 'low' | undefined;
	readonly reason: string;
	readonly dismissedAt: number;
	readonly checkSource: 'static' | 'ai' | 'breaking' | undefined;
}

export const IViolationFeedbackService = createDecorator<IViolationFeedbackService>('violationFeedbackService');

export interface IViolationFeedbackService {
	readonly _serviceBrand: undefined;
	addFeedback(entry: Omit<IFeedbackEntry, 'dismissedAt'>): void;
	getEntriesForFile(fileBasename: string): IFeedbackEntry[];
	getEntriesForRule(ruleId: string): IFeedbackEntry[];
	getAllEntries(): IFeedbackEntry[];
	removeFeedback(ruleId: string, fileBasename: string, codeSnippet: string): boolean;
	readonly entryCount: number;
}
