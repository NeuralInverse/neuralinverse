/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

export interface IAnalysisFinding { severity: string; message: string; file?: string; line?: number; }
export interface IAnalysisProof { sourceTreeHash: string; passedGate: boolean; findings: IAnalysisFinding[]; summary: { openCritical: number; openHigh: number }; timestamp: number; }

export const IEnclaveAnalysisProofService = createDecorator<IEnclaveAnalysisProofService>('neuralInverseEnclaveAnalysisProofService');
export interface IEnclaveAnalysisProofService {
	readonly _serviceBrand: undefined;
	readonly onDidRecordProof: Event<IAnalysisProof>;
	readonly onDidUpdateDisposition: Event<void>;
	getActiveProof?(): IAnalysisProof | undefined;
}

class EnclaveAnalysisProofService extends Disposable implements IEnclaveAnalysisProofService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidRecordProof = this._register(new Emitter<IAnalysisProof>());
	readonly onDidRecordProof: Event<IAnalysisProof> = this._onDidRecordProof.event;
	private readonly _onDidUpdateDisposition = this._register(new Emitter<void>());
	readonly onDidUpdateDisposition: Event<void> = this._onDidUpdateDisposition.event;
	getActiveProof(): IAnalysisProof | undefined { return undefined; }
}

registerSingleton(IEnclaveAnalysisProofService, EnclaveAnalysisProofService, InstantiationType.Delayed);
