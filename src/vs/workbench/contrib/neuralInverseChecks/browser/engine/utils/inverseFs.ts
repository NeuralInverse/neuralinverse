/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Inverse Filesystem Utilities
 *
 * The `.inverse/` directory is write-locked by the nano agent after each analysis
 * cycle (`chmod -R a-w .inverse`). Any IDE service that needs to write files there
 * must temporarily unlock it first, then re-lock after the write.
 *
 * ## Architecture
 *
 * VS Code's Electron renderer runs in sandbox mode — `child_process` is NOT directly
 * accessible via `require`. Instead, the `IInverseAccessService` (an Eager singleton)
 * registers a terminal-based executor at startup via `registerInverseExecFn()`.
 * All calls to `withInverseWriteAccess` then route through the terminal.
 *
 * Usage:
 * ```typescript
 * await withInverseWriteAccess(rootPath, async () => {
 *     await this.fileService.writeFile(uri, buffer);
 * });
 * ```
 */

import { isWindows } from '../../../../../../base/common/platform.js';

// ─── Pluggable executor ───────────────────────────────────────────────────────

/**
 * Module-level executor function.
 * Set at startup by `IInverseAccessService` using `ITerminalService`.
 * Falls back to `child_process.exec` if not registered.
 */
let _registeredExecFn: ((cmd: string) => Promise<void>) | undefined = undefined;

/**
 * Register a terminal-based command executor.
 * Called once at startup by `IInverseAccessService`.
 */
export function registerInverseExecFn(fn: (cmd: string) => Promise<void>): void {
	_registeredExecFn = fn;
}


// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Temporarily grants write access to the `.inverse` directory,
 * runs the callback, then re-locks it — even if the callback throws.
 *
 * @param inversePath - Absolute filesystem path to the `.inverse` folder
 * @param fn - Async callback that performs the write operation(s)
 */
export async function withInverseWriteAccess(inversePath: string, fn: () => Promise<void>): Promise<void> {
	await _chmodInverse(inversePath, true);
	try {
		await fn();
	} finally {
		await _chmodInverse(inversePath, false);
	}
}


// ─── Internals ────────────────────────────────────────────────────────────────

async function _chmodInverse(inversePath: string, unlock: boolean): Promise<void> {
	let cmd: string;
	if (isWindows) {
		const flag = unlock ? '-r' : '+r';
		cmd = `attrib ${flag} "${inversePath}\\*" /s`;
	} else {
		const mode = unlock ? 'u+w' : 'a-w';
		cmd = `chmod -R ${mode} "${inversePath}"`;
	}
	await _exec(cmd);
}

async function _exec(cmd: string): Promise<void> {
	// Prefer the registered terminal-based executor (set by IInverseAccessService at startup).
	// This is required in VS Code's sandboxed Electron renderer where child_process is not
	// directly accessible via require().
	if (_registeredExecFn) {
		await _registeredExecFn(cmd);
		return;
	}

	// Fallback: try child_process.exec directly (works in non-sandboxed environments).
	try {
		const nodeRequire = (globalThis as any).require as NodeRequire | undefined;
		if (!nodeRequire) {
			console.warn('[InverseFs] No exec provider registered and require is unavailable — chmod skipped');
			return;
		}
		const { exec } = nodeRequire('child_process') as typeof import('child_process');
		await new Promise<void>((resolve) => {
			exec(cmd, (err) => {
				if (err) {
					console.warn('[InverseFs] chmod command failed:', err.message);
				}
				resolve(); // best-effort: always continue
			});
		});
	} catch (e) {
		console.warn('[InverseFs] Could not run chmod:', e);
	}
}
