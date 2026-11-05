/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

export interface ITestSuiteInfo { name: string; version: string; }
export interface ITestResult { name: string; passed: boolean; durationMs?: number; }
export interface ITestProof { sourceTreeHash: string; passedGate: boolean; summary: { total: number; passed: number; passRate: number; mcDcCoverage?: number }; timestamp: number; }

export const IEnclaveTestProofService = createDecorator<IEnclaveTestProofService>('neuralInverseEnclaveTestProofService');
export interface IEnclaveTestProofService {
	readonly _serviceBrand: undefined;
	readonly onDidRecordProof: Event<ITestProof>;
	readonly onDidFailGate: Event<ITestProof>;
	getActiveProof?(): ITestProof | undefined;
	recordTestRun?(suite: ITestSuiteInfo, type: string, results: ITestResult[]): void;
}

class EnclaveTestProofService extends Disposable implements IEnclaveTestProofService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidRecordProof = this._register(new Emitter<ITestProof>());
	readonly onDidRecordProof: Event<ITestProof> = this._onDidRecordProof.event;
	private readonly _onDidFailGate = this._register(new Emitter<ITestProof>());
	readonly onDidFailGate: Event<ITestProof> = this._onDidFailGate.event;
	getActiveProof(): ITestProof | undefined { return undefined; }
	recordTestRun(_suite: ITestSuiteInfo, _type: string, _results: ITestResult[]): void { /* stub */ }
}

registerSingleton(IEnclaveTestProofService, EnclaveTestProofService, InstantiationType.Delayed);
