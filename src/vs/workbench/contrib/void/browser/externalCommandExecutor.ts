/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ITerminalToolService } from './terminalToolService.js';

export interface IExternalCommandExecutor {
	readonly _serviceBrand: undefined;
	execute(jobId: string, command: string, timeoutMs: number, maxOutputBytes: number): Promise<string>;
}

export const IExternalCommandExecutor = createDecorator<IExternalCommandExecutor>('externalCommandExecutor');

class TerminalBackedCommandExecutor implements IExternalCommandExecutor {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ITerminalToolService private readonly terminalToolService: ITerminalToolService,
	) {}

	async execute(jobId: string, command: string, timeoutMs: number, maxOutputBytes: number): Promise<string> {
		const { resPromise } = await this.terminalToolService.runCommand(command, {
			type: 'temporary',
			cwd: null,
			terminalId: jobId,
		});
		const { result } = await resPromise;
		const out = result ?? '';
		return out.length > maxOutputBytes ? out.substring(0, maxOutputBytes) + '\n[truncated]' : out;
	}
}

registerSingleton(IExternalCommandExecutor, TerminalBackedCommandExecutor, InstantiationType.Delayed);
