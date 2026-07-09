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

/**
 * # Inverse Access Service
 *
 * Registers a terminal-based chmod executor so that `withInverseWriteAccess`
 * works reliably inside VS Code's sandboxed Electron renderer — where
 * `child_process` is NOT available via `require()`.
 *
 * ## How it works
 *
 * 1. This service is registered as an Eager singleton (initialises at startup).
 * 2. In the constructor it calls `registerInverseExecFn()` from `inverseFs.ts`,
 *    passing a function that sends the chmod command to a dedicated background
 *    terminal ("Neural Inverse Ops") and waits long enough for it to complete.
 * 3. All callers of `withInverseWriteAccess` (frameworkRegistry, grcConfigLoader,
 *    auditTrailService, …) automatically pick up this executor — no changes needed.
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


// ─── Service Interface ────────────────────────────────────────────────────────

export const IInverseAccessService = createDecorator<IInverseAccessService>('neuralInverseAccessService');

export interface IInverseAccessService {
	readonly _serviceBrand: undefined;
}


// ─── Implementation ───────────────────────────────────────────────────────────

/** How long (ms) to wait after sending a chmod command before proceeding.
 *  400ms was too aggressive for deeply nested dirs — bumped to 800ms. */
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

	// ─── Private ─────────────────────────────────────────────────────────

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


// ─── Helpers ─────────────────────────────────────────────────────────────────

function _sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Silence the unused-import warning — isWindows is available if subclasses need it
void isWindows;


// ─── Registration ─────────────────────────────────────────────────────────────

// Eager so the executor is ready before any service tries to write to .inverse
registerSingleton(IInverseAccessService, InverseAccessService, InstantiationType.Eager);
