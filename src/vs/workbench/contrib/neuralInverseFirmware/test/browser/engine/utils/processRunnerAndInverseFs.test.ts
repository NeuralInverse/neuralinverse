/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { isProcessAvailable, IProcessResult } from '../../../../browser/engine/utils/processRunner.js';
import { registerInverseExecFn } from '../../../../browser/engine/utils/inverseFs.js';

// ─── processRunner ────────────────────────────────────────────────────────────

suite('Process Runner - isProcessAvailable', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('isProcessAvailable returns a boolean', () => {
		const result = isProcessAvailable();
		assert.strictEqual(typeof result, 'boolean');
	});

	// isProcessAvailable wraps child_process availability — returns true in
	// Electron Node.js context and false in pure browser context.
	// We don't assert the value since it depends on runtime environment.
	test('isProcessAvailable does not throw', () => {
		assert.doesNotThrow(() => isProcessAvailable());
	});
});

suite('Process Runner - IProcessResult interface', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('IProcessResult structure has all required fields', () => {
		const result: IProcessResult = {
			exitCode: 0,
			stdout: 'Build succeeded\n',
			stderr: '',
			durationMs: 1234,
			timedOut: false,
		};
		assert.strictEqual(result.exitCode, 0);
		assert.ok(result.stdout.includes('Build'));
		assert.strictEqual(result.timedOut, false);
	});

	test('IProcessResult with non-zero exit code represents failure', () => {
		const result: IProcessResult = {
			exitCode: 1,
			stdout: '',
			stderr: 'error: expected ";"',
			durationMs: 500,
			timedOut: false,
		};
		assert.ok(result.exitCode !== 0);
		assert.ok(result.stderr.includes('error'));
	});

	test('IProcessResult with timedOut=true means process was killed', () => {
		const result: IProcessResult = {
			exitCode: 1,
			stdout: 'partial output...',
			stderr: '',
			durationMs: 60_000,
			signal: 'SIGTERM',
			timedOut: true,
		};
		assert.ok(result.timedOut);
		assert.strictEqual(result.signal, 'SIGTERM');
	});

	test('exitCode 127 indicates command not found', () => {
		const result: IProcessResult = {
			exitCode: 127,
			stdout: '',
			stderr: 'arm-none-eabi-gcc: command not found',
			durationMs: 50,
			timedOut: false,
		};
		assert.strictEqual(result.exitCode, 127);
	});

	test('durationMs is non-negative', () => {
		const result: IProcessResult = {
			exitCode: 0,
			stdout: '',
			stderr: '',
			durationMs: 2345,
			timedOut: false,
		};
		assert.ok(result.durationMs >= 0);
	});
});

// ─── inverseFs ────────────────────────────────────────────────────────────────

suite('InverseFs - registerInverseExecFn', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registerInverseExecFn does not throw', () => {
		assert.doesNotThrow(() => {
			registerInverseExecFn(async (cmd: string) => {
				// no-op test executor
				void cmd;
			});
		});
	});

	test('registered executor is invoked when withInverseWriteAccess is called', async () => {
		const executed: string[] = [];
		registerInverseExecFn(async (cmd: string) => {
			executed.push(cmd);
		});

		// Import withInverseWriteAccess dynamically to use the registered fn
		const { withInverseWriteAccess } = await import('../../../../browser/engine/utils/inverseFs.js');

		let callbackRan = false;
		await withInverseWriteAccess('/tmp/.inverse', async () => {
			callbackRan = true;
		});

		assert.ok(callbackRan, 'Callback should have run');
		assert.ok(executed.length >= 2, `Expected at least 2 chmod calls (unlock + re-lock), got ${executed.length}`);
	});

	test('chmod commands reference the provided path', async () => {
		const executed: string[] = [];
		registerInverseExecFn(async (cmd: string) => {
			executed.push(cmd);
		});

		const { withInverseWriteAccess } = await import('../../../../browser/engine/utils/inverseFs.js');
		await withInverseWriteAccess('/workspace/.inverse', async () => {});

		assert.ok(
			executed.some(cmd => cmd.includes('.inverse')),
			`Expected .inverse path in chmod commands: ${executed.join(', ')}`
		);
	});

	test('withInverseWriteAccess re-locks even when callback throws', async () => {
		const executed: string[] = [];
		registerInverseExecFn(async (cmd: string) => {
			executed.push(cmd);
		});

		const { withInverseWriteAccess } = await import('../../../../browser/engine/utils/inverseFs.js');

		let threw = false;
		try {
			await withInverseWriteAccess('/tmp/.inverse', async () => {
				throw new Error('write failed: disk full');
			});
		} catch {
			threw = true;
		}

		assert.ok(threw, 'Expected the callback error to propagate');
		// Re-lock (a-w) chmod must still have run in the finally block
		const hasRelock = executed.some(cmd => cmd.includes('a-w') || cmd.includes('+r'));
		assert.ok(hasRelock, `Expected re-lock chmod in finally block: ${executed.join(', ')}`);
	});
});
