/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

export const IEnclaveSessionService = createDecorator<IEnclaveSessionService>('neuralInverseEnclaveSessionService');
export interface IEnclaveSessionService {
	readonly _serviceBrand: undefined;
	readonly sessionId: string;
}

class EnclaveSessionService extends Disposable implements IEnclaveSessionService {
	declare readonly _serviceBrand: undefined;
	readonly sessionId: string = `oss-${Date.now().toString(36)}`;
}

registerSingleton(IEnclaveSessionService, EnclaveSessionService, InstantiationType.Delayed);
