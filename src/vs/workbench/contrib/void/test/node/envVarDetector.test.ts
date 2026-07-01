/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import {
	detectEnvVarCredentials,
	detectGitCredentialManagerCredentials,
} from '../../browser/autoConnect/envVarDetector.js';
import { IFileService, IFileContent } from '../../../../../platform/files/common/files.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';

// ---------------------------------------------------------------------------
// Minimal IFileService stub — only readFile is exercised by envVarDetector
// ---------------------------------------------------------------------------

type FileMap = Map<string, string>;

// Normalize a path for use as a map key: forward slashes, lowercase drive letter on Windows.
function normPath(p: string): string {
	return p.replace(/\\/g, '/').replace(/^[A-Z]:/, c => c.toLowerCase());
}

function makeFileService(files: FileMap): IFileService {
	// Re-key the map with normalized paths so URI.file().fsPath comparisons always match.
	const normalized = new Map<string, string>();
	for (const [k, v] of files) { normalized.set(normPath(k), v); }

	return {
		readFile: async (resource: URI): Promise<IFileContent> => {
			const content = normalized.get(normPath(resource.fsPath));
			if (content === undefined) {
				throw new Error(`ENOENT: ${resource.fsPath}`);
			}
			return {
				resource,
				value: VSBuffer.fromString(content),
				etag: '',
				mtime: 0,
				ctime: 0,
				size: content.length,
				readonly: false,
				locked: false,
				name: '',
			} as unknown as IFileContent;
		},
	} as unknown as IFileService;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ShellRunner that returns a canned response for a given jobId prefix. */
type ShellRunner = (jobId: string, cmd: string, timeout: number, maxBytes: number) => Promise<string>;

function makeRunner(responses: Record<string, string>): ShellRunner {
	return async (jobId: string) => {
		for (const [prefix, value] of Object.entries(responses)) {
			if (jobId.startsWith(prefix)) return value;
		}
		throw new Error(`no mock for jobId: ${jobId}`);
	};
}

function emptyRunner(): ShellRunner {
	return async () => { throw new Error('shell runner should not be called'); };
}

// ---------------------------------------------------------------------------
// Tests: parseGitCredentialOutput (via detectGitCredentialManagerCredentials)
// We test it indirectly because the function is not exported.
// ---------------------------------------------------------------------------

suite('envVarDetector — detectGitCredentialManagerCredentials', () => {
	const emptyFs = makeFileService(new Map());

	test('returns null when githubAlreadyDetected=true', async () => {
		const result = await detectGitCredentialManagerCredentials(emptyFs, emptyRunner(), true);
		assert.strictEqual(result, null);
	});

	test('returns null when no sources find a token', async () => {
		// runner throws (simulates git not installed), no .git-credentials, not macOS
		const result = await detectGitCredentialManagerCredentials(emptyFs, undefined, false);
		assert.strictEqual(result, null);
	});

	test('reads token from git credential fill output (POSIX)', async () => {
		// On Windows the shell-out is skipped; skip this assertion there too
		if (process.platform === 'win32') { return; }

		const runner = makeRunner({
			'git-cred-github': 'protocol=https\nhost=github.com\nusername=alice\npassword=ghp_ABC123xyz\n',
		});
		const result = await detectGitCredentialManagerCredentials(emptyFs, runner, false);
		assert.ok(result, 'expected a credential');
		assert.strictEqual(result.providerName, 'githubModels');
		assert.strictEqual(result.source, 'git-credential');
		assert.strictEqual(result.settings.apiKey, 'ghp_ABC123xyz');
		assert.ok(!result.maskedDisplay.includes('ghp_ABC123xyz'), 'full token must not appear in maskedDisplay');
		assert.ok(result.maskedDisplay.includes('github.com'), 'maskedDisplay should mention the host');
	});

	test('falls back to ~/.git-credentials when runner returns empty', async () => {
		const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
		if (!home) { return; } // no homedir in this environment

		const credPath = `${home}/.git-credentials`.replace(/\\/g, '/');
		const fs = makeFileService(new Map([
			[credPath, 'https://alice:ghp_filetoken99@github.com\n'],
		]));

		// Runner returns empty (no output from git credential fill)
		const runner = makeRunner({ 'git-cred-github': '' });
		const result = await detectGitCredentialManagerCredentials(fs, runner, false);
		assert.ok(result, 'expected credential from .git-credentials');
		assert.strictEqual(result.source, 'config-file');
		assert.strictEqual(result.settings.apiKey, 'ghp_filetoken99');
		assert.ok(!result.maskedDisplay.includes('ghp_filetoken99'));
	});

	test('falls back to ~/.git-credentials when no runner provided', async () => {
		const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
		if (!home) { return; }

		const credPath = `${home}/.git-credentials`.replace(/\\/g, '/');
		const fs = makeFileService(new Map([
			[credPath, 'https://bob:ghp_norunner44@github.com\n'],
		]));

		const result = await detectGitCredentialManagerCredentials(fs, undefined, false);
		assert.ok(result);
		assert.strictEqual(result.source, 'config-file');
		assert.strictEqual(result.settings.apiKey, 'ghp_norunner44');
	});

	test('.git-credentials: ignores non-github entries', async () => {
		const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
		if (!home) { return; }

		const credPath = `${home}/.git-credentials`.replace(/\\/g, '/');
		const fs = makeFileService(new Map([
			[credPath, 'https://alice:glpat_gitlab_token@gitlab.com\nhttps://alice:bb_token@bitbucket.org\n'],
		]));

		const result = await detectGitCredentialManagerCredentials(fs, undefined, false);
		assert.strictEqual(result, null, 'gitlab/bitbucket entries must not be matched for githubModels');
	});

	test('token shorter than 4 chars is rejected', async () => {
		const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
		if (!home) { return; }

		const credPath = `${home}/.git-credentials`.replace(/\\/g, '/');
		const fs = makeFileService(new Map([
			[credPath, 'https://alice:abc@github.com\n'],
		]));

		const result = await detectGitCredentialManagerCredentials(fs, undefined, false);
		assert.strictEqual(result, null);
	});

	test('maskedDisplay never contains full token', async () => {
		if (process.platform === 'win32') { return; }

		const longToken = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
		const runner = makeRunner({
			'git-cred-github': `username=alice\npassword=${longToken}\n`,
		});
		const result = await detectGitCredentialManagerCredentials(emptyFs, runner, false);
		assert.ok(result);
		assert.ok(!result.maskedDisplay.includes(longToken), 'full token must not appear in maskedDisplay');
	});
});

// ---------------------------------------------------------------------------
// Tests: detectEnvVarCredentials — GitHub token env vars
// ---------------------------------------------------------------------------

suite('envVarDetector — detectEnvVarCredentials (GITHUB_TOKEN)', () => {
	// We manipulate process.env directly; restore after each test.
	let savedGithubToken: string | undefined;
	let savedGhToken: string | undefined;

	setup(() => {
		savedGithubToken = process.env['GITHUB_TOKEN'];
		savedGhToken = process.env['GH_TOKEN'];
		delete process.env['GITHUB_TOKEN'];
		delete process.env['GH_TOKEN'];
	});

	teardown(() => {
		if (savedGithubToken !== undefined) { process.env['GITHUB_TOKEN'] = savedGithubToken; }
		else { delete process.env['GITHUB_TOKEN']; }
		if (savedGhToken !== undefined) { process.env['GH_TOKEN'] = savedGhToken; }
		else { delete process.env['GH_TOKEN']; }
	});

	const emptyFs = makeFileService(new Map());

	test('detects GITHUB_TOKEN from process.env', async () => {
		process.env['GITHUB_TOKEN'] = 'ghp_envtest1234';
		const results = await detectEnvVarCredentials(emptyFs);
		const gh = results.find(r => r.providerName === 'githubModels');
		assert.ok(gh, 'expected githubModels credential');
		assert.strictEqual(gh.source, 'env');
		assert.strictEqual(gh.settings.apiKey, 'ghp_envtest1234');
		assert.ok(!gh.maskedDisplay.includes('ghp_envtest1234'));
	});

	test('detects GH_TOKEN from process.env', async () => {
		process.env['GH_TOKEN'] = 'ghp_ghtoken5678';
		const results = await detectEnvVarCredentials(emptyFs);
		const gh = results.find(r => r.providerName === 'githubModels');
		assert.ok(gh);
		assert.strictEqual(gh.settings.apiKey, 'ghp_ghtoken5678');
	});

	test('returns no github credential when neither env var is set', async () => {
		const results = await detectEnvVarCredentials(emptyFs);
		const gh = results.find(r => r.providerName === 'githubModels');
		assert.strictEqual(gh, undefined);
	});
});
