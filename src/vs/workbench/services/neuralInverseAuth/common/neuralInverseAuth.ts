/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { Event } from '../../../../base/common/event.js';

export const INeuralInverseAuthService = createDecorator<INeuralInverseAuthService>('neuralInverseAuthService');

export interface INeuralInverseAuthService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeAuthStatus: Event<boolean>;

	isAuthenticated(): Promise<boolean>;
	login(): Promise<void>;
	logout(): Promise<void>;
	handleCallback(uri: URI): Promise<void>;
	getToken(): Promise<string | undefined>;
}
