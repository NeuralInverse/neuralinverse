/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

export const IEnclaveVaultService = createDecorator<IEnclaveVaultService>('neuralInverseEnclaveVaultService');
export interface IEnclaveVaultService {
	readonly _serviceBrand: undefined;
	readonly onDidAccessSecret: Event<string>;
	readonly onDidProvisionSecret: Event<string>;
	readonly onDidDestroySecret: Event<string>;
	readonly onDidZeroVault: Event<void>;
	getLoadedSecretIds(): string[];
	zeroVault?(): void;
}

class EnclaveVaultService extends Disposable implements IEnclaveVaultService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidAccessSecret = this._register(new Emitter<string>());
	readonly onDidAccessSecret: Event<string> = this._onDidAccessSecret.event;
	private readonly _onDidProvisionSecret = this._register(new Emitter<string>());
	readonly onDidProvisionSecret: Event<string> = this._onDidProvisionSecret.event;
	private readonly _onDidDestroySecret = this._register(new Emitter<string>());
	readonly onDidDestroySecret: Event<string> = this._onDidDestroySecret.event;
	private readonly _onDidZeroVault = this._register(new Emitter<void>());
	readonly onDidZeroVault: Event<void> = this._onDidZeroVault.event;
	getLoadedSecretIds(): string[] { return []; }
	zeroVault(): void { /* stub */ }
}

registerSingleton(IEnclaveVaultService, EnclaveVaultService, InstantiationType.Delayed);
