/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *
 *  Licensed under the Business Source License 1.1 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at https://mariadb.com/bsl11
 *
 *  Change Date: 2029-07-14
 *  Change License: GNU Affero General Public License v3.0
 *
 *  Use of this software in production requires a commercial license from Neural Inverse Inc.
 *  Contact (code): github@neuralinverse.com | Contact (sales): sales@neuralinverse.com
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IFVSession, IFVPreset } from './formalVerificationTypes.js';

export const IFormalVerificationService = createDecorator<IFormalVerificationService>('neuralInverseFormalVerificationService');

export interface IFormalVerificationService {
	readonly _serviceBrand: undefined;
	readonly onDidSessionUpdate: Event<IFVSession>;
	getSessions(): IFVSession[];
	getPresets(): IFVPreset[];
	createSession(toolKind: string, targetUri: string): Promise<IFVSession>;
	runSession(sessionId: string): Promise<void>;
	stopSession(sessionId: string): Promise<void>;
	deleteSession(sessionId: string): Promise<void>;
}
