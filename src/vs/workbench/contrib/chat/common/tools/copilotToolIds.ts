/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

<<<<<<<< HEAD:extensions/open-remote-wsl/extension.webpack.config.js
//@ts-check

'use strict';

const withDefaults = require('../shared.webpack.config');

module.exports = withDefaults({
	context: __dirname,
	resolve: {
		mainFields: ['module', 'main']
	},
	entry: {
		extension: './src/extension.ts',
	}
});
========
export const enum CopilotToolId {
	ReadFile = 'copilot_readFile',
}

export const enum CopilotChatSettingId {
	Gpt55ReadFileToolEnabled = 'github.copilot.chat.gpt55ReadFileTool.enabled',
}
>>>>>>>> 1.121.0:src/vs/workbench/contrib/chat/common/tools/copilotToolIds.ts
