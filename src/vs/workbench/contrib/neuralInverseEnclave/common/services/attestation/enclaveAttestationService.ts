/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

export const IEnclaveAttestationService = createDecorator<IEnclaveAttestationService>('neuralInverseEnclaveAttestationService');
export interface IEnclaveAttestationService {
	readonly _serviceBrand: undefined;
	readonly onDidGenerateQuote: Event<void>;
	readonly onDidVerifyQuote: Event<boolean>;
}

class EnclaveAttestationService extends Disposable implements IEnclaveAttestationService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidGenerateQuote = this._register(new Emitter<void>());
	readonly onDidGenerateQuote: Event<void> = this._onDidGenerateQuote.event;
	private readonly _onDidVerifyQuote = this._register(new Emitter<boolean>());
	readonly onDidVerifyQuote: Event<boolean> = this._onDidVerifyQuote.event;
}

registerSingleton(IEnclaveAttestationService, EnclaveAttestationService, InstantiationType.Delayed);
