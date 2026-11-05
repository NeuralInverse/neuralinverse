/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

export interface IAuditEntry {
	id: string;
	timestamp: number;
	ruleId: string;
	filePath: string;
	message: string;
	severity: string;
	domain: string;
}

export const IAuditTrailService = createDecorator<IAuditTrailService>('neuralInverseAuditTrailService');
export interface IAuditTrailService {
	readonly _serviceBrand: undefined;
	getEntries(date?: string): Promise<IAuditEntry[]>;
	getAvailableDates(): Promise<string[]>;
	logEntry(entry: Omit<IAuditEntry, 'id' | 'timestamp'>): Promise<void>;
}

class AuditTrailService extends Disposable implements IAuditTrailService {
	declare readonly _serviceBrand: undefined;

	async getEntries(_date?: string): Promise<IAuditEntry[]> { return []; }
	async getAvailableDates(): Promise<string[]> { return []; }
	async logEntry(_entry: Omit<IAuditEntry, 'id' | 'timestamp'>): Promise<void> { /* stub */ }
}

registerSingleton(IAuditTrailService, AuditTrailService, InstantiationType.Delayed);
