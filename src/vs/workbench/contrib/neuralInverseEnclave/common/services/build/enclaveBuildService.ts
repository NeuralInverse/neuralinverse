/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

export interface IBuildProof { buildCommand: string; inputSourceHash: string; status: 'succeeded' | 'failed' | 'in_progress'; startedAt: number; durationMs: number | null; }

export const IEnclaveBuildService = createDecorator<IEnclaveBuildService>('neuralInverseEnclaveBuildService');
export interface IEnclaveBuildService {
	readonly _serviceBrand: undefined;
	readonly onDidBeginBuild: Event<void>;
	readonly onDidCompleteBuild: Event<IBuildProof>;
	getAllProofs?(): IBuildProof[];
	beginBuildTracking?(trigger: string): void;
}

class EnclaveBuildService extends Disposable implements IEnclaveBuildService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidBeginBuild = this._register(new Emitter<void>());
	readonly onDidBeginBuild: Event<void> = this._onDidBeginBuild.event;
	private readonly _onDidCompleteBuild = this._register(new Emitter<IBuildProof>());
	readonly onDidCompleteBuild: Event<IBuildProof> = this._onDidCompleteBuild.event;
	getAllProofs(): IBuildProof[] { return []; }
	beginBuildTracking(_trigger: string): void { /* stub */ }
}

registerSingleton(IEnclaveBuildService, EnclaveBuildService, InstantiationType.Delayed);
