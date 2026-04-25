/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Inverse Access Service
 *
 * Registers a terminal-based chmod executor so that `withInverseWriteAccess`
 * works reliably inside VS Code's sandboxed Electron renderer \u2014 where
 * `child_process` is NOT available via `require()`.
 *
 * ## How it works
 *
 * 1. This service is registered as an Eager singleton (initialises at startup).
 * 2. In the constructor it calls `registerInverseExecFn()` from `inverseFs.ts`,
 *    passing a function that sends the chmod command to a dedicated background
 *    terminal ("Neural Inverse Ops") and waits long enough for it to complete.
 * 3. All callers of `withInverseWriteAccess` (frameworkRegistry, grcConfigLoader,
 *    auditTrailService, \u2026) automatically pick up this executor \u2014 no changes needed.
 *
 * ## Terminal reuse
 *
 * The service reuses an existing "Neural Inverse Ops" terminal if one is open,
 * or creates a new transient one. This is the same approach the nano agent's
 * ProjectAnalyzer uses for its own chmod calls.
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { ITerminalService } from '../../../../terminal/browser/terminal.js';
import { registerInverseExecFn } from '../utils/inverseFs.js';
import { isWindows } from '../../../../../../base/common/platform.js';


// \u2500\u2500\u2500 Service Interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const IInverseAccessService = createDecorator<IInverseAccessService>('neuralInverseAccessService');

export interface IInverseAccessService {
	readonly _serviceBrand: undefined;
}


// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** How long (ms) to wait after sending a chmod command before proceeding.
 *  400ms was too aggressive for deeply nested dirs \u2014 bumped to 800ms. */
const CHMOD_SETTLE_MS = 800;

const TERMINAL_NAME = 'Neural Inverse Ops';

export class InverseAccessService extends Disposable implements IInverseAccessService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super();
		this._registerExecFn();
	}

	// \u2500\u2500\u2500 Private \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Installs the terminal-based executor into `inverseFs.ts`.
	 * Called once at service construction.
	 */
	private _registerExecFn(): void {
		registerInverseExecFn(async (cmd: string) => {
			try {
				const terminal = await this._getOrCreateTerminal();
				terminal.sendText(cmd, true /* addNewLine */);
				// Give the shell time to execute the command before the caller writes.
				// chmod on a local directory is typically < 10 ms; 400 ms is conservative.
				await _sleep(CHMOD_SETTLE_MS);
			} catch (e) {
				console.warn('[InverseAccessService] Failed to run cmd via terminal:', e);
			}
		});

		console.log('[InverseAccessService] Terminal-based chmod executor registered');
	}

	private async _getOrCreateTerminal() {
		// Reuse an existing Nano Agent Ops terminal if present
		const existing = this.terminalService.instances.find(t => t.title === TERMINAL_NAME);
		if (existing) {
			return existing;
		}
		return this.terminalService.createTerminal({
			config: {
				name: TERMINAL_NAME,
				isTransient: true,
				hideFromUser: true,
			},
		});
	}
}


// \u2500\u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Silence the unused-import warning \u2014 isWindows is available if subclasses need it
void isWindows;


// \u2500\u2500\u2500 Registration \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

// Eager so the executor is ready before any service tries to write to .inverse
registerSingleton(IInverseAccessService, InverseAccessService, InstantiationType.Eager);
