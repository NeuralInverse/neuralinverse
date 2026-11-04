/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

export interface IFirewallBlock { reason: string; timestamp: number; snippet?: string; wasBlocked: boolean; }

export const IEnclaveFirewallService = createDecorator<IEnclaveFirewallService>('neuralInverseEnclaveFirewallService');
export interface IEnclaveFirewallService {
	readonly _serviceBrand: undefined;
	readonly onDidBlockRequest: Event<IFirewallBlock>;
	getScannedCount(): number;
	getBlockedCount(): number;
	getRecentBlocks(): IFirewallBlock[];
}

class EnclaveFirewallService extends Disposable implements IEnclaveFirewallService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidBlockRequest = this._register(new Emitter<IFirewallBlock>());
	readonly onDidBlockRequest: Event<IFirewallBlock> = this._onDidBlockRequest.event;
	getScannedCount(): number { return 0; }
	getBlockedCount(): number { return 0; }
	getRecentBlocks(): IFirewallBlock[] { return []; }
}

registerSingleton(IEnclaveFirewallService, EnclaveFirewallService, InstantiationType.Delayed);
