/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

export interface ISBOMSnapshot { componentCount: number; missingIntegrityCount: number; generatedAt: number; }

export const IEnclaveSBOMService = createDecorator<IEnclaveSBOMService>('neuralInverseEnclaveSBOMService');
export interface IEnclaveSBOMService {
	readonly _serviceBrand: undefined;
	readonly onDidGenerateSBOM: Event<ISBOMSnapshot>;
	getLastSBOM(): ISBOMSnapshot | undefined;
	generateSBOM?(): void;
}

class EnclaveSBOMService extends Disposable implements IEnclaveSBOMService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidGenerateSBOM = this._register(new Emitter<ISBOMSnapshot>());
	readonly onDidGenerateSBOM: Event<ISBOMSnapshot> = this._onDidGenerateSBOM.event;
	getLastSBOM(): ISBOMSnapshot | undefined { return undefined; }
	generateSBOM(): void { /* stub */ }
}

registerSingleton(IEnclaveSBOMService, EnclaveSBOMService, InstantiationType.Delayed);
