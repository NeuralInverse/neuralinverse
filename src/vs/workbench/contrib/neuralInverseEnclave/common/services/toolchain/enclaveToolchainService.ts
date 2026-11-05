/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

export interface IToolchainRecord { toolName: string; expectedHash: string; actualHash: string; }
export interface IToolchainVerification { records: IToolchainRecord[]; timestamp: number; }

export const IEnclaveToolchainService = createDecorator<IEnclaveToolchainService>('neuralInverseEnclaveToolchainService');
export interface IEnclaveToolchainService {
	readonly _serviceBrand: undefined;
	readonly onDidVerify: Event<IToolchainVerification>;
	readonly onDidDetectViolation: Event<IToolchainRecord>;
	getLastVerification(): IToolchainVerification | undefined;
	verifyToolchain?(): void;
}

class EnclaveToolchainService extends Disposable implements IEnclaveToolchainService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidVerify = this._register(new Emitter<IToolchainVerification>());
	readonly onDidVerify: Event<IToolchainVerification> = this._onDidVerify.event;
	private readonly _onDidDetectViolation = this._register(new Emitter<IToolchainRecord>());
	readonly onDidDetectViolation: Event<IToolchainRecord> = this._onDidDetectViolation.event;
	getLastVerification(): IToolchainVerification | undefined { return undefined; }
	verifyToolchain(): void { /* stub */ }
}

registerSingleton(IEnclaveToolchainService, EnclaveToolchainService, InstantiationType.Delayed);
