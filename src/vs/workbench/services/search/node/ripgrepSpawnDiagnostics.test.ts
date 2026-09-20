/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from '../../../../base/common/path.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { diagnoseRipgrepSpawnError, ripgrepSpawnPreflightProblem } from './ripgrepSearchUtils.js';

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'rg-spawn-diag-'));
}

const sink = { appendLine(_msg: string): void { /* captured; not asserted */ } };

suite('Ripgrep spawn diagnostics', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('preflight passes when the executable and cwd both exist', () => {
		const dir = tempDir();
		try {
			const exe = path.join(dir, 'rg.exe');
			fs.writeFileSync(exe, 'stub');
			assert.strictEqual(ripgrepSpawnPreflightProblem(exe, dir, sink), undefined);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
	test('preflight names a missing executable with an actionable message', () => {
		const dir = tempDir();
		try {
			const missing = path.join(dir, 'absent-rg.exe');
			const message = ripgrepSpawnPreflightProblem(missing, dir, sink);
			assert.match(message ?? '', /ripgrep executable not found/);
			assert.ok(message!.includes(missing));
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
	test('preflight names a missing working directory', () => {
		const dir = tempDir();
		try {
			const exe = path.join(dir, 'rg.exe');
			fs.writeFileSync(exe, 'stub');
			const missingCwd = path.join(dir, 'no-such-workspace');
			const message = ripgrepSpawnPreflightProblem(exe, missingCwd, sink);
			assert.match(message ?? '', /working directory does not exist/);
			assert.ok(message!.includes(missingCwd));
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
	test('an ENOENT with both paths present is reported as a transient blocker, and a missing exe is named precisely', () => {
		const dir = tempDir();
		try {
			const exe = path.join(dir, 'rg.exe');
			fs.writeFileSync(exe, 'stub');
			const enoent = Object.assign(new Error(`spawn ${exe} ENOENT`), { code: 'ENOENT' });
			const transient = diagnoseRipgrepSpawnError(exe, dir, enoent);
			assert.match(transient, /transient blocker/);

			fs.rmSync(exe);
			const missingExe = diagnoseRipgrepSpawnError(exe, dir, enoent);
			assert.match(missingExe, /ripgrep executable not found/);

			fs.writeFileSync(exe, 'stub');
			const missingCwd = diagnoseRipgrepSpawnError(exe, path.join(dir, 'gone'), enoent);
			assert.match(missingCwd, /working directory does not exist/);

			const other = diagnoseRipgrepSpawnError(exe, dir, Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
			assert.strictEqual(other, 'spawn EACCES');
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
});
