/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

export interface ISandboxViolation { type: string; wasBlocked: boolean; details?: string; timestamp: number; }

export const IEnclaveSandboxService = createDecorator<IEnclaveSandboxService>('neuralInverseEnclaveSandboxService');
export interface IEnclaveSandboxService {
	readonly _serviceBrand: undefined;
	readonly onDidSandboxViolation: Event<ISandboxViolation>;
	getRecentViolations(): ISandboxViolation[];
	/** Returns true if the command is permitted by sandbox policy (OSS: always true). */
	checkCommand(command: string): boolean;
}

class EnclaveSandboxService extends Disposable implements IEnclaveSandboxService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidSandboxViolation = this._register(new Emitter<ISandboxViolation>());
	readonly onDidSandboxViolation: Event<ISandboxViolation> = this._onDidSandboxViolation.event;
	getRecentViolations(): ISandboxViolation[] { return []; }
	checkCommand(_command: string): boolean { return true; }
}

registerSingleton(IEnclaveSandboxService, EnclaveSandboxService, InstantiationType.Delayed);
