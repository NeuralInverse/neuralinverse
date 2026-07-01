/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IDetectedCredential, ENV_VAR_MAP, AWS_ENV_VARS, AZURE_ENV_VARS, GCP_ENV_VARS } from './autoConnectTypes.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { URI } from '../../../../../base/common/uri.js';
import { env } from '../../../../../base/common/process.js';
import { isWindows, isMacintosh } from '../../../../../base/common/platform.js';

function getEnv(name: string): string | undefined {
	return env[name] || undefined;
}

function maskKey(key: string): string {
	if (key.length <= 8) return '***';
	return key.slice(0, 4) + '...' + key.slice(-4);
}

function findFirstEnvVar(envVars: readonly string[]): string | undefined {
	for (const v of envVars) {
		const val = getEnv(v);
		if (val && val.trim().length > 0) return val.trim();
	}
	return undefined;
}

function getHomedir(): string {
	return getEnv('HOME') || getEnv('USERPROFILE') || '';
}

function parseIniFile(content: string, section: string): Record<string, string> {
	const result: Record<string, string> = {};
	const lines = content.split('\n');
	let inSection = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith('[')) {
			inSection = trimmed === `[${section}]`;
			continue;
		}
		if (inSection && trimmed.includes('=')) {
			const eqIdx = trimmed.indexOf('=');
			const key = trimmed.slice(0, eqIdx).trim();
			const value = trimmed.slice(eqIdx + 1).trim();
			if (key && value) result[key] = value;
		}
	}
	return result;
}

async function readFileSafe(fileService: IFileService, filePath: string): Promise<string | null> {
	try {
		const content = await fileService.readFile(URI.file(filePath));
		return content.value.toString();
	} catch {
		return null;
	}
}

// --- Parse shell config files for exported env vars ---

async function readShellEnvVars(fileService: IFileService): Promise<Record<string, string>> {
	const home = getHomedir();
	if (!home) return {};

	const shellFiles = [
		`${home}/.zshrc`,
		`${home}/.zprofile`,
		`${home}/.bash_profile`,
		`${home}/.bashrc`,
		`${home}/.profile`,
	];

	const vars: Record<string, string> = {};

	for (const filePath of shellFiles) {
		const content = await readFileSafe(fileService, filePath);
		if (!content) continue;
		for (const line of content.split('\n')) {
			const match = line.match(/^\s*export\s+([A-Z0-9_]+)\s*=\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/);
			if (match) {
				const [, key, value] = match;
				if (key && value && value.trim() && !vars[key]) {
					vars[key] = value.trim();
				}
			}
		}
	}
	return vars;
}

// --- Simple env-var API key providers ---

export async function detectEnvVarCredentials(fileService: IFileService): Promise<IDetectedCredential[]> {
	const results: IDetectedCredential[] = [];

	// First check process.env (works in terminal launches)
	const shellVars = await readShellEnvVars(fileService);

	const lookup = (name: string): string | undefined => getEnv(name) || shellVars[name] || undefined;

	for (const { providerName, envVars } of ENV_VAR_MAP) {
		const key = envVars.map(v => lookup(v)).find(v => v && v.trim().length > 0);
		if (key) {
			results.push({
				providerName,
				source: 'env',
				settings: { apiKey: key },
				maskedDisplay: maskKey(key),
			});
		}
	}

	return results;
}

// --- AWS: env vars → ~/.aws/credentials ---

export async function detectAwsCredentials(fileService: IFileService): Promise<IDetectedCredential | null> {
	const envAccessKey = findFirstEnvVar(AWS_ENV_VARS.accessKeyId);
	const envSecretKey = findFirstEnvVar(AWS_ENV_VARS.secretAccessKey);

	if (envAccessKey && envSecretKey) {
		const region = findFirstEnvVar(AWS_ENV_VARS.region) || 'us-east-1';
		return {
			providerName: 'awsBedrock',
			source: 'env',
			settings: { region },
			maskedDisplay: maskKey(envAccessKey),
		};
	}

	const home = getHomedir();
	if (!home) return null;

	const credContent = await readFileSafe(fileService, `${home}/.aws/credentials`);
	if (!credContent) return null;

	const profile = parseIniFile(credContent, 'default');
	const fileAccessKey = profile['aws_access_key_id'];
	const fileSecretKey = profile['aws_secret_access_key'];

	if (!fileAccessKey || !fileSecretKey) return null;

	let region = findFirstEnvVar(AWS_ENV_VARS.region) || 'us-east-1';
	const configContent = await readFileSafe(fileService, `${home}/.aws/config`);
	if (configContent) {
		const configProfile = parseIniFile(configContent, 'default');
		if (configProfile['region']) region = configProfile['region'];
	}

	return {
		providerName: 'awsBedrock',
		source: 'config-file',
		settings: { region },
		maskedDisplay: maskKey(fileAccessKey),
	};
}

// --- Azure: env vars → ~/.azure/azureProfile.json ---

export async function detectAzureCredentials(fileService: IFileService): Promise<IDetectedCredential | null> {
	const apiKey = findFirstEnvVar(AZURE_ENV_VARS.apiKey);
	if (apiKey) {
		const endpoint = findFirstEnvVar(AZURE_ENV_VARS.endpoint);
		const settings: Record<string, string> = { apiKey };
		if (endpoint) {
			const match = endpoint.match(/https?:\/\/([^.]+)\.openai\.azure\.com/);
			if (match) settings.project = match[1];
		}
		return {
			providerName: 'microsoftAzure',
			source: 'env',
			settings,
			maskedDisplay: maskKey(apiKey),
		};
	}

	const home = getHomedir();
	if (!home) return null;

	const azureProfile = await readFileSafe(fileService, `${home}/.azure/azureProfile.json`);
	if (!azureProfile) return null;

	try {
		const profile = JSON.parse(azureProfile);
		const subscriptions = profile?.subscriptions;
		if (subscriptions && subscriptions.length > 0) {
			const defaultSub = subscriptions.find((s: any) => s.isDefault) || subscriptions[0];
			return {
				providerName: 'microsoftAzure',
				source: 'config-file',
				settings: {},
				maskedDisplay: `Azure CLI (${defaultSub.name || defaultSub.id || 'logged in'})`,
			};
		}
	} catch { /* malformed */ }

	return null;
}

// --- GCP: env vars → ~/.config/gcloud/application_default_credentials.json ---

export async function detectGcpCredentials(fileService: IFileService): Promise<IDetectedCredential | null> {
	const credentials = findFirstEnvVar(GCP_ENV_VARS.credentials);
	const project = findFirstEnvVar(GCP_ENV_VARS.project);

	if (credentials || project) {
		const settings: Record<string, string> = {};
		if (project) settings.project = project;
		settings.region = findFirstEnvVar(GCP_ENV_VARS.region) || 'us-west2';
		return {
			providerName: 'googleVertex',
			source: credentials ? 'config-file' : 'env',
			settings,
			maskedDisplay: project || 'ADC configured',
		};
	}

	const home = getHomedir();
	if (!home) return null;

	const adcContent = await readFileSafe(fileService, `${home}/.config/gcloud/application_default_credentials.json`);
	if (!adcContent) return null;

	try {
		const adc = JSON.parse(adcContent);
		if (adc.client_id || adc.type === 'authorized_user' || adc.type === 'service_account') {
			let detectedProject = '';
			let detectedRegion = 'us-west2';

			const propsContent = await readFileSafe(fileService, `${home}/.config/gcloud/properties`);
			if (propsContent) {
				const coreSection = parseIniFile(propsContent, 'core');
				if (coreSection['project']) detectedProject = coreSection['project'];
				const computeSection = parseIniFile(propsContent, 'compute');
				if (computeSection['region']) detectedRegion = computeSection['region'];
			}

			const settings: Record<string, string> = { region: detectedRegion };
			if (detectedProject) settings.project = detectedProject;

			return {
				providerName: 'googleVertex',
				source: 'config-file',
				settings,
				maskedDisplay: detectedProject || `gcloud ADC (${adc.type})`,
			};
		}
	} catch { /* malformed */ }

	return null;
}

// --- Git Credential Manager: github.com only ---
// GitLab and Bitbucket are intentionally excluded until their providers are added to
// defaultProviderSettings in modelCapabilities.ts and a valid ProviderName exists for each.

type ShellRunner = (jobId: string, command: string, timeoutMs: number, maxBytes: number) => Promise<string>;

const GITHUB_HOST = 'github.com';

function parseGitCredentialOutput(output: string): string | null {
	// git credential fill emits `key=value` lines; we only need `password`
	const match = output.match(/^password=(.+)$/m);
	return match ? match[1].trim() : null;
}

async function runGitCredentialFill(run: ShellRunner): Promise<string | null> {
	// `printf ... | git credential fill` is a POSIX pipe trick.
	// cmd.exe and PowerShell do not have `printf`, so we skip the shell-out on Windows.
	// The ~/.git-credentials fallback below covers Windows users who store credentials in plaintext.
	// A proper cross-platform stdin implementation would require direct child-process access,
	// which is not available through IExternalCommandExecutor today.
	if (isWindows) return null;
	try {
		const cmd = `printf 'protocol=https\\nhost=${GITHUB_HOST}\\n\\n' | git credential fill`;
		const out = await run('git-cred-github', cmd, 5000, 2048);
		return parseGitCredentialOutput(out || '');
	} catch {
		return null;
	}
}

async function runWindowsCredentialManagerFill(run: ShellRunner): Promise<string | null> {
	// Windows equivalent of runGitCredentialFill using cmd.exe built-ins.
	// `echo.` (echo-dot) writes an empty line, which signals end-of-input to git credential fill.
	// `&` separates commands inline without a subshell; no spaces around `&` so echo
	// output is clean (a space before `&` would be included in the echoed text).
	// Git Credential Manager reads the Windows Credential Manager store and returns
	// `password=<token>` when the credential is present — no UI prompt for stored creds.
	if (!isWindows) return null;
	try {
		const cmd = `cmd.exe /c "(echo protocol=https&echo host=${GITHUB_HOST}&echo.) | git credential fill"`;
		const out = await run('win-credman-github', cmd, 6000, 2048);
		const token = parseGitCredentialOutput(out || '');
		console.log('[autoConnect] runWindowsCredentialManagerFill: token found:', !!token, 'length:', token?.length ?? 0);
		return token;
	} catch (err) {
		console.log('[autoConnect] runWindowsCredentialManagerFill: failed:', String(err));
		return null;
	}
}

async function readGitCredentialsFileForGitHub(fileService: IFileService): Promise<string | null> {
	const home = getHomedir();
	if (!home) return null;
	const content = await readFileSafe(fileService, `${home}/.git-credentials`);
	if (!content) return null;
	// Format per git-credential-store(1): https://user:token@github.com
	const re = /https?:\/\/[^:]+:([^@]+)@github\.com/m;
	const match = content.match(re);
	return match ? match[1].trim() : null;
}

async function readMacOsKeychainForGitHub(run: ShellRunner): Promise<string | null> {
	if (!isMacintosh) return null;
	try {
		const out = await run('keychain-github', `security find-internet-password -s ${GITHUB_HOST} -w`, 4000, 512);
		const token = out.trim();
		const found = token.length >= 4;
		console.log('[autoConnect] readMacOsKeychainForGitHub: token found:', found, 'length:', found ? token.length : 0);
		return found ? token : null;
	} catch (err) {
		console.log('[autoConnect] readMacOsKeychainForGitHub: failed:', String(err));
		return null;
	}
}

export async function detectGitCredentialManagerCredentials(
	fileService: IFileService,
	run?: ShellRunner,
	githubAlreadyDetected?: boolean,
): Promise<IDetectedCredential | null> {
	// Honour higher-priority detectors: GITHUB_TOKEN / GH_TOKEN env vars and gh CLI
	if (githubAlreadyDetected) return null;

	let token: string | null = null;
	let source: 'git-credential' | 'config-file' = 'git-credential';

	// Strategy 1: git credential fill (POSIX/macOS/Linux only; skipped on Windows)
	if (run) {
		token = await runGitCredentialFill(run);
	}

	// Strategy 2: ~/.git-credentials plaintext file (works on all platforms)
	if (!token) {
		token = await readGitCredentialsFileForGitHub(fileService);
		if (token) source = 'config-file';
	}

	// Strategy 3: Windows Credential Manager via cmd.exe + git credential fill.
	// Covers GitHub CLI (and Git Credential Manager) tokens stored in the Windows
	// Credential vault (git:https://github.com entries), which are invisible to the
	// POSIX pipe trick in Strategy 1 because Git Bash runs in a different PATH context.
	if (!token && run) {
		token = await runWindowsCredentialManagerFill(run);
	}

	// Strategy 4: macOS Keychain via `security find-internet-password`.
	// Runs last because git-credential-fill (Strategy 1) already covers the Keychain
	// on macOS when git is configured to use the osxkeychain helper — this catches
	// credentials stored directly by GitHub CLI or other tools that bypass git.
	if (!token && run) {
		token = await readMacOsKeychainForGitHub(run);
	}

	if (!token || token.length < 4) return null;

	return {
		providerName: 'githubModels',
		source,
		settings: { apiKey: token },
		maskedDisplay: `Git (${GITHUB_HOST}) ${maskKey(token)}`,
	};
}

// --- GitHub CLI: ~/.config/gh/hosts.yml or external token ---

function getGhHostsYmlPaths(): string[] {
	const paths: string[] = [];
	const home = getHomedir();
	// POSIX / macOS / Linux
	if (home) paths.push(`${home}/.config/gh/hosts.yml`);
	// Windows: gh stores config under %APPDATA%\GitHub CLI\hosts.yml
	const appData = getEnv('APPDATA');
	if (appData) paths.push(`${appData}\\GitHub CLI\\hosts.yml`);
	return paths;
}

export async function detectGitHubCliCredentials(fileService: IFileService, externalToken?: string): Promise<IDetectedCredential | null> {
	const home = getHomedir();

	// Strategy 1: token provided externally (from `gh auth token` shell-out)
	if (externalToken && externalToken.trim().length >= 4) {
		let user = '';
		// Try all known hosts.yml locations to find the logged-in user display name
		for (const hostsPath of getGhHostsYmlPaths()) {
			const hostsContent = await readFileSafe(fileService, hostsPath);
			if (hostsContent) {
				const userMatch = hostsContent.match(/user:\s*(.+)/);
				if (userMatch) { user = userMatch[1].trim(); break; }
			}
		}
		console.log('[autoConnect] detectGitHubCliCredentials: external token hit, user:', user || '(unknown)', 'token length:', externalToken.trim().length);
		return {
			providerName: 'githubModels',
			source: 'cli-auth',
			settings: { apiKey: externalToken.trim() },
			maskedDisplay: user ? `gh cli (${user})` : maskKey(externalToken.trim()),
		};
	}

	// Strategy 2: token stored in hosts.yml directly (older gh versions / non-keychain)
	// Check all known paths (POSIX and Windows APPDATA).
	const hostsPaths = getGhHostsYmlPaths();
	if (!home && hostsPaths.length === 0) return null;

	let content: string | null = null;
	for (const hostsPath of hostsPaths) {
		content = await readFileSafe(fileService, hostsPath);
		if (content) break;
	}
	if (!content) {
		console.log('[autoConnect] detectGitHubCliCredentials: no hosts.yml found at', hostsPaths.join(', '));
		return null;
	}

	const tokenMatch = content.match(/oauth_token:\s*(.+)/);
	if (!tokenMatch) {
		console.log('[autoConnect] detectGitHubCliCredentials: hosts.yml found but no oauth_token key (likely keychain storage)');
		return null;
	}

	const token = tokenMatch[1].trim();
	if (!token || token.length < 4) return null;

	let user = '';
	const userMatch = content.match(/user:\s*(.+)/);
	if (userMatch) user = userMatch[1].trim();

	console.log('[autoConnect] detectGitHubCliCredentials: oauth_token from hosts.yml, user:', user || '(unknown)', 'token length:', token.length);
	return {
		providerName: 'githubModels',
		source: 'cli-auth',
		settings: { apiKey: token },
		maskedDisplay: user ? `gh cli (${user})` : maskKey(token),
	};
}

// --- Aggregate ---

export async function detectAllCredentials(fileService: IFileService, ghCliToken?: string, run?: ShellRunner): Promise<IDetectedCredential[]> {
	console.log('[autoConnect] detectAllCredentials: ghCliToken present:', !!ghCliToken, 'length:', ghCliToken?.length ?? 0);
	const results: IDetectedCredential[] = [];

	const envVarResults = await detectEnvVarCredentials(fileService);
	console.log('[autoConnect] detectAllCredentials: envVar results:', envVarResults.map(r => `${r.providerName}/${r.source}`).join(', ') || '(none)');
	results.push(...envVarResults);

	const githubFromEnv = envVarResults.some(r => r.providerName === 'githubModels');

	const [aws, azure, gcp, ghCli, gcm] = await Promise.all([
		detectAwsCredentials(fileService),
		detectAzureCredentials(fileService),
		detectGcpCredentials(fileService),
		detectGitHubCliCredentials(fileService, ghCliToken),
		// Pass githubFromEnv so GCM doesn't run when GITHUB_TOKEN / GH_TOKEN already found
		detectGitCredentialManagerCredentials(fileService, run, githubFromEnv),
	]);

	console.log('[autoConnect] detectAllCredentials: aws:', !!aws, 'azure:', !!azure, 'gcp:', !!gcp, 'ghCli:', !!ghCli, 'gcm:', !!gcm);

	if (aws) results.push(aws);
	if (azure) results.push(azure);
	if (gcp) results.push(gcp);

	// Only add GitHub CLI credential if env-var detection didn't already find githubModels
	if (ghCli && !results.some(r => r.providerName === 'githubModels')) {
		results.push(ghCli);
	}

	// Only add GCM credential if neither env-var nor gh-cli already covered githubModels
	if (gcm && !results.some(r => r.providerName === 'githubModels')) {
		results.push(gcm);
	}

	console.log('[autoConnect] detectAllCredentials: final results:', results.map(r => `${r.providerName}/${r.source}`).join(', ') || '(none)');
	return results;
}
