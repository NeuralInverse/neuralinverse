/*--------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

/**
 * VoidAutoUpdaterService
 *
 * Self-update for unsigned macOS / Linux / Windows builds.
 * Does NOT require Squirrel or code signing.
 *
 * Flow:
 *   1. check()        — hit Lambda, get download URL if update available
 *   2. download()     — fetch zip in background, extract to temp dir
 *   3. applyUpdate()  — write detached shell script, quit app → script swaps
 *                        app bundle and relaunches
 *
 * macOS:
 *   - Downloads .zip, extracts NeuralInverse.app
 *   - Detached bash script: rsync new Contents/ over old, xattr quarantine remove, relaunch
 *
 * Windows:
 *   - Downloads Setup .exe, runs it silently (installer handles relaunch)
 *
 * Linux:
 *   - Downloads .tar.gz, extracts, rsync in place, relaunch
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IProductService } from '../../../../platform/product/common/productService.js';

export const IVoidAutoUpdaterService = createDecorator<IVoidAutoUpdaterService>('voidAutoUpdaterService');

export type AutoUpdateState =
	| { type: 'idle' }
	| { type: 'checking' }
	| { type: 'up-to-date' }
	| { type: 'downloading'; progress: number /* 0-100 */ }
	| { type: 'ready'; version: string; downloadPath: string }
	| { type: 'error'; message: string };

export interface IVoidAutoUpdaterService {
	readonly _serviceBrand: undefined;
	readonly state: AutoUpdateState;

	/** Check Lambda for update. Returns download URL if available, null if up to date. */
	check(): Promise<{ version: string; downloadUrl: string } | null>;

	/** Download the update zip/exe to a temp dir. Resolves when ready to apply. */
	download(downloadUrl: string, version: string): Promise<void>;

	/** Apply the downloaded update — writes updater script, quits app. */
	applyUpdate(): void;
}


// ─── Platform helpers ─────────────────────────────────────────────────────────

function vsPlatform(): string {
	const p = process.platform;
	const a = process.arch;
	if (p === 'darwin') { return a === 'arm64' ? 'darwin-arm64' : 'darwin'; }
	if (p === 'win32')  { return a === 'arm64' ? 'win32-arm64' : 'win32-x64'; }
	// linux
	return a === 'arm64' ? 'linux-arm64' : 'linux-x64';
}


// ─── Implementation ───────────────────────────────────────────────────────────

export class VoidAutoUpdaterService extends Disposable implements IVoidAutoUpdaterService {
	readonly _serviceBrand: undefined;

	private _state: AutoUpdateState = { type: 'idle' };

	constructor(
		@IProductService private readonly _product: IProductService,
	) {
		super();
	}

	get state(): AutoUpdateState { return this._state; }

	// ── check ──────────────────────────────────────────────────────────────────

	async check(): Promise<{ version: string; downloadUrl: string } | null> {
		this._state = { type: 'checking' };

		const updateUrl = (this._product as any).updateUrl as string | undefined;
		const quality   = (this._product as any).quality   as string ?? 'stable';
		const version   = this._product.version;

		if (!updateUrl) {
			this._state = { type: 'error', message: 'No updateUrl configured.' };
			return null;
		}

		try {
			const platform = vsPlatform();
			const url = `${updateUrl}/api/update/${platform}/${quality}/${version}`;
			const res = await _fetch(url);

			if (res.status === 204) {
				this._state = { type: 'up-to-date' };
				return null;
			}

			if (res.status === 200 && res.body) {
				const payload = JSON.parse(res.body) as { url: string; name: string };
				this._state = { type: 'idle' };
				return { version: payload.name, downloadUrl: payload.url };
			}

			this._state = { type: 'error', message: `Update server returned ${res.status}` };
			return null;

		} catch (e: any) {
			this._state = { type: 'error', message: String(e) };
			return null;
		}
	}

	// ── download ───────────────────────────────────────────────────────────────

	async download(downloadUrl: string, version: string): Promise<void> {
		this._state = { type: 'downloading', progress: 0 };

		const tmpDir  = path.join(os.tmpdir(), `ni-update-${version}-${Date.now()}`);
		const ext     = _ext(downloadUrl);
		const zipPath = path.join(tmpDir, `NeuralInverse-${version}${ext}`);

		fs.mkdirSync(tmpDir, { recursive: true });

		// Download
		await _download(downloadUrl, zipPath, (progress) => {
			this._state = { type: 'downloading', progress };
		});

		// Extract (macOS + Linux only — Windows runs the installer directly)
		let extractedApp: string;
		if (process.platform === 'darwin') {
			extractedApp = await _extractZipMac(zipPath, tmpDir);
		} else if (process.platform === 'linux') {
			extractedApp = await _extractTarGz(zipPath, tmpDir);
		} else {
			// Windows: the downloaded file is already the installer exe
			extractedApp = zipPath;
		}

		this._state = { type: 'ready', version, downloadPath: extractedApp };
	}

	// ── applyUpdate ────────────────────────────────────────────────────────────

	applyUpdate(): void {
		const s = this._state;
		if (s.type !== 'ready') { return; }

		if (process.platform === 'darwin') {
			_applyMac(s.downloadPath);
		} else if (process.platform === 'linux') {
			_applyLinux(s.downloadPath);
		} else {
			_applyWin(s.downloadPath);
		}
	}
}


// ─── macOS apply ─────────────────────────────────────────────────────────────

function _applyMac(newAppPath: string): void {
	// newAppPath is the extracted NeuralInverse.app bundle
	const installPath = '/Applications/NeuralInverse.app';
	const scriptPath  = path.join(os.tmpdir(), 'ni-updater.sh');

	const script = [
		'#!/bin/bash',
		'set -e',
		'sleep 2',
		// Sync new app contents over existing (preserves app directory inode)
		`rsync -a --delete "${newAppPath}/" "${installPath}/"`,
		// Remove quarantine
		`xattr -rd com.apple.quarantine "${installPath}" 2>/dev/null || true`,
		// Relaunch
		`open -a NeuralInverse`,
		// Cleanup
		`rm -rf "${path.dirname(newAppPath)}" "${scriptPath}"`,
	].join('\n');

	fs.writeFileSync(scriptPath, script, { mode: 0o755 });

	const { spawn } = require('child_process') as typeof import('child_process');
	const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' });
	child.unref();

	const { app } = require('electron') as typeof import('electron');
	app.quit();
}


// ─── Linux apply ─────────────────────────────────────────────────────────────

function _applyLinux(newAppDir: string): void {
	// newAppDir is the extracted app directory
	const installPath = _linuxInstallPath();
	const scriptPath  = path.join(os.tmpdir(), 'ni-updater.sh');

	const script = [
		'#!/bin/bash',
		'set -e',
		'sleep 2',
		`rsync -a --delete "${newAppDir}/" "${installPath}/"`,
		`chmod +x "${installPath}/neuralinverse"`,
		`"${installPath}/neuralinverse" &`,
		`rm -rf "${newAppDir}" "${scriptPath}"`,
	].join('\n');

	fs.writeFileSync(scriptPath, script, { mode: 0o755 });

	const { spawn } = require('child_process') as typeof import('child_process');
	const child = spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' });
	child.unref();

	const { app } = require('electron') as typeof import('electron');
	app.quit();
}

function _linuxInstallPath(): string {
	// Try to resolve from the running executable
	const exe = process.execPath; // e.g. /opt/NeuralInverse/neuralinverse
	return path.dirname(exe);
}


// ─── Windows apply ────────────────────────────────────────────────────────────

function _applyWin(installerPath: string): void {
	// Run the setup .exe silently — it handles restart
	const { spawn } = require('child_process') as typeof import('child_process');
	const child = spawn(installerPath, ['/silent', '/mergetasks=!runcode'], {
		detached: true,
		stdio: 'ignore',
	});
	child.unref();

	const { app } = require('electron') as typeof import('electron');
	app.quit();
}


// ─── Extraction helpers ───────────────────────────────────────────────────────

async function _extractZipMac(zipPath: string, destDir: string): Promise<string> {
	const extractDir = path.join(destDir, 'extracted');
	fs.mkdirSync(extractDir, { recursive: true });

	await _exec(`ditto -x -k "${zipPath}" "${extractDir}"`);

	// Find NeuralInverse.app
	const found = _findDir(extractDir, 'NeuralInverse.app');
	if (!found) { throw new Error('NeuralInverse.app not found in archive'); }
	return found;
}

async function _extractTarGz(tarPath: string, destDir: string): Promise<string> {
	const extractDir = path.join(destDir, 'extracted');
	fs.mkdirSync(extractDir, { recursive: true });
	await _exec(`tar -xzf "${tarPath}" -C "${extractDir}"`);

	// Find app dir (first subdirectory)
	const entries = fs.readdirSync(extractDir);
	for (const e of entries) {
		const p = path.join(extractDir, e);
		if (fs.statSync(p).isDirectory()) { return p; }
	}
	throw new Error('Could not find extracted app directory');
}

function _findDir(root: string, name: string): string | undefined {
	for (const entry of fs.readdirSync(root)) {
		const p = path.join(root, entry);
		if (entry === name && fs.statSync(p).isDirectory()) { return p; }
		if (fs.statSync(p).isDirectory()) {
			const found = _findDir(p, name);
			if (found) { return found; }
		}
	}
	return undefined;
}

function _exec(cmd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const { exec } = require('child_process') as typeof import('child_process');
		exec(cmd, (err) => err ? reject(err) : resolve());
	});
}


// ─── Download helper ──────────────────────────────────────────────────────────

function _download(url: string, dest: string, onProgress: (pct: number) => void): Promise<void> {
	return new Promise((resolve, reject) => {
		const file   = fs.createWriteStream(dest);
		const client = url.startsWith('https') ? https : http;

		client.get(url, (res) => {
			if (res.statusCode === 301 || res.statusCode === 302) {
				file.close();
				fs.unlinkSync(dest);
				_download(res.headers.location!, dest, onProgress).then(resolve).catch(reject);
				return;
			}
			if (res.statusCode !== 200) {
				reject(new Error(`Download failed: HTTP ${res.statusCode}`));
				return;
			}

			const total = parseInt(res.headers['content-length'] ?? '0', 10);
			let received = 0;

			res.on('data', (chunk: Buffer) => {
				received += chunk.length;
				if (total > 0) { onProgress(Math.floor((received / total) * 100)); }
			});

			res.pipe(file);
			file.on('finish', () => file.close(() => resolve()));
			file.on('error', reject);
		}).on('error', reject);
	});
}


// ─── Simple fetch (no node-fetch dep) ────────────────────────────────────────

function _fetch(url: string): Promise<{ status: number; body: string | null }> {
	return new Promise((resolve, reject) => {
		const client = url.startsWith('https') ? https : http;
		client.get(url, (res) => {
			let data = '';
			res.on('data', (c: string) => { data += c; });
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data || null }));
		}).on('error', reject);
	});
}

function _ext(url: string): string {
	if (url.endsWith('.tar.gz')) { return '.tar.gz'; }
	if (url.endsWith('.exe'))   { return '.exe'; }
	return '.zip';
}
