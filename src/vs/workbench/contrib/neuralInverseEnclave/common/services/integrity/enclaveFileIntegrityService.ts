/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

export const IEnclaveFileIntegrityService = createDecorator<IEnclaveFileIntegrityService>('neuralInverseEnclaveFileIntegrityService');
export interface IEnclaveFileIntegrityService {
	readonly _serviceBrand: undefined;
	readonly onDidRecordIntegrity: Event<void>;
	getRecordCount(): number;
	getAiModifiedFiles(): string[];
}

class EnclaveFileIntegrityService extends Disposable implements IEnclaveFileIntegrityService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidRecordIntegrity = this._register(new Emitter<void>());
	readonly onDidRecordIntegrity: Event<void> = this._onDidRecordIntegrity.event;
	getRecordCount(): number { return 0; }
	getAiModifiedFiles(): string[] { return []; }
}

registerSingleton(IEnclaveFileIntegrityService, EnclaveFileIntegrityService, InstantiationType.Delayed);
