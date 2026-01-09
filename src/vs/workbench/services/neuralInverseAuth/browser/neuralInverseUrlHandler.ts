/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IURLHandler, IURLService } from '../../../../platform/url/common/url.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { INeuralInverseAuthService } from '../common/neuralInverseAuth.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';

export class NeuralInverseUrlHandler extends Disposable implements IWorkbenchContribution, IURLHandler {

	constructor(
		@IURLService urlService: IURLService,
		@INeuralInverseAuthService private readonly authService: INeuralInverseAuthService
	) {
		super();
		this._register(urlService.registerHandler(this));
	}

	async handleURL(uri: URI): Promise<boolean> {
		if (uri.path === '/neural-inverse/callback') {
			await this.authService.handleCallback(uri);
			return true;
		}
		return false;
	}
}
