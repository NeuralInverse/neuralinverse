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
import { ICheckResult } from '../types/grcTypes.js';

export interface ContractReasonResult {
	fileUri: URI;
	additionalViolations: ICheckResult[];
}

export interface IScanFileEntry {
	fileUri: URI;
	scannedAt: number;
	riskScore: number;
}

export interface IScanTrackerState {
	totalFiles: number;
	scannedCount: number;
	scanningCount: number;
	pendingCount: number;
}

export const IContractReasonService = createDecorator<IContractReasonService>('contractReasonService');

export interface IContractReasonService {
	readonly _serviceBrand: undefined;
	readonly isAvailable: boolean;
	readonly isEnabled: boolean;
	setEnabled(enabled: boolean): void;
	readonly onDidEnabledChange: Event<boolean>;
	analyzeFile(fileUri: URI, content: string): Promise<ContractReasonResult>;
	readonly onDidContractReasonResultsReady: Event<ContractReasonResult>;
	getScanTrackerState(): IScanTrackerState;
	readonly onDidScanTrackerUpdate: Event<IScanTrackerState>;
	scanTrackerBeginScan(fileUris: URI[], riskScores?: Map<string, number>): void;
	scanTrackerEndScan(): void;
	scanTrackerReset(): void;
	scanTrackerSetPeriodicState(active: boolean, intervalMs?: number): void;
}
