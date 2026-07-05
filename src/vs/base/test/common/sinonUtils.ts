/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

<<<<<<<< HEAD:extensions/open-remote-ssh/extension-browser.webpack.config.js
//@ts-check

'use strict';

const withBrowserDefaults = require('../shared.webpack.config').browser;

module.exports = withBrowserDefaults({
	context: __dirname,
	entry: {
		extension: './src/extension.ts'
	}
});
========
import * as sinon from 'sinon';

export function asSinonMethodStub<T extends (...args: never[]) => unknown>(method: T): sinon.SinonStubbedMember<T> {
	return method as unknown as sinon.SinonStubbedMember<T>;
}
>>>>>>>> 1.113.0:src/vs/base/test/common/sinonUtils.ts
