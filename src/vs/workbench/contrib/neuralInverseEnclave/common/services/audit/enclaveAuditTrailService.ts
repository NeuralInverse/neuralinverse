/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

export interface IAuditEntry { id: string; timestamp: number; action: string; actor: string; target: string; outcome: 'allowed' | 'blocked' | 'flagged'; details?: string; hash: string; }
export interface IVerifyChainResult { valid: boolean; entriesChecked: number; brokenAt?: number; reason?: string; }
export interface IVerifiableBundle { entries: IAuditEntry[]; signature: string; }

export const IEnclaveAuditTrailService = createDecorator<IEnclaveAuditTrailService>('neuralInverseEnclaveAuditTrailService');
export interface IEnclaveAuditTrailService {
	readonly _serviceBrand: undefined;
	readonly onDidAddEntry: Event<IAuditEntry>;
	getEntryCount(): number;
	getRecentEntries(limit: number): IAuditEntry[];
	verifyChain(): Promise<IVerifyChainResult>;
	exportVerifiableBundle(): Promise<IVerifiableBundle>;
}

class EnclaveAuditTrailService extends Disposable implements IEnclaveAuditTrailService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidAddEntry = this._register(new Emitter<IAuditEntry>());
	readonly onDidAddEntry: Event<IAuditEntry> = this._onDidAddEntry.event;
	getEntryCount(): number { return 0; }
	getRecentEntries(_limit: number): IAuditEntry[] { return []; }
	async verifyChain(): Promise<IVerifyChainResult> { return { valid: true, entriesChecked: 0 }; }
	async exportVerifiableBundle(): Promise<IVerifiableBundle> { return { entries: [], signature: '' }; }
}

registerSingleton(IEnclaveAuditTrailService, EnclaveAuditTrailService, InstantiationType.Delayed);
