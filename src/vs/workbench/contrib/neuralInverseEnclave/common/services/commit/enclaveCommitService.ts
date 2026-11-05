/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

export interface ICommitProof { gitHash: string; author: { name: string; email: string }; branch?: string; timestamp: number; signature: string; }

export const IEnclaveCommitService = createDecorator<IEnclaveCommitService>('neuralInverseEnclaveCommitService');
export interface IEnclaveCommitService {
	readonly _serviceBrand: undefined;
	readonly onDidCreateProof: Event<ICommitProof>;
	getAllProofs?(): ICommitProof[];
}

class EnclaveCommitService extends Disposable implements IEnclaveCommitService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidCreateProof = this._register(new Emitter<ICommitProof>());
	readonly onDidCreateProof: Event<ICommitProof> = this._onDidCreateProof.event;
	getAllProofs(): ICommitProof[] { return []; }
}

registerSingleton(IEnclaveCommitService, EnclaveCommitService, InstantiationType.Delayed);
