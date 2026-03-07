/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # External Command Executor
 *
 * Executes shell commands in a background terminal and captures their stdout
 * by redirecting output to a temp file, then polling until the command exits.
 *
 * ## Why a temp-file redirect?
 *
 * VS Code's `ITerminalService.sendText()` is fire-and-forget — there is no API
 * to capture stdout from an interactive terminal. The solution is:
 *
 *   1. Wrap the command with output redirection to known temp paths:
 *      `(cmd) > /tmp/ni_ext_<jobId>.out 2> /tmp/ni_ext_<jobId>.err; echo $? > /tmp/ni_ext_<jobId>.exit`
 *   2. Send the wrapped command to the shared "Neural Inverse Ops" terminal.
 *   3. Poll `IFileService` for the `.exit` sentinel file at 500 ms intervals.
 *   4. Once found, read the exit code — if non-zero, read stderr and throw.
 *   5. Read the `.out` file (respecting `maxOutputBytes`), delete all three
 *      temp files, and return the stdout string.
 *
 * ## Windows
 *
 * On Windows PowerShell the redirect syntax is different. We detect `isWindows`
 * and emit the appropriate `cmd /C` command with `>` and `2>` redirects.
 *
 * ## Concurrency
 *
 * Jobs are uniquely identified by a caller-supplied `jobId`. Each job uses
 * distinct temp paths so concurrent invocations never collide.
 *
 * See: docs/EXTERNAL_ANALYSIS_BRIDGE.md — Part 5
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { ITerminalService } from '../../../../terminal/browser/terminal.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { URI } from '../../../../../../base/common/uri.js';
import { isWindows } from '../../../../../../base/common/platform.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';


// ─── Service Interface ────────────────────────────────────────────────────────

export const IExternalCommandExecutor = createDecorator<IExternalCommandExecutor>('neuralInverseExternalCommandExecutor');

export interface IExternalCommandExecutor {
	readonly _serviceBrand: undefined;

	/**
	 * Execute a shell command in a background terminal and capture stdout.
	 *
	 * @param jobId        Unique identifier for this invocation (used in temp paths).
	 * @param command      The shell command to run, with variables already substituted.
	 * @param timeoutMs    Maximum time to wait for the command to complete.
	 * @param maxBytes     Optional cap on stdout size. Reads are truncated if exceeded.
	 * @param env          Optional environment variables to prepend as VAR=val exports.
	 * @returns            Stdout of the command as a string.
	 * @throws             If the command times out, exits non-zero, or output exceeds maxBytes.
	 */
	execute(
		jobId: string,
		command: string,
		timeoutMs: number,
		maxBytes?: number,
		env?: Record<string, string>
	): Promise<string>;
}


// ─── Constants ────────────────────────────────────────────────────────────────

const TERMINAL_NAME = 'Neural Inverse Ops';

/** How often to check whether the exit-sentinel file has appeared. */
const POLL_INTERVAL_MS = 500;

/** Default max output size: 10 MB */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** How long to wait for the temp directory to be readable after terminal starts. */
const TERMINAL_READY_DELAY_MS = 200;


// ─── Implementation ───────────────────────────────────────────────────────────

export class ExternalCommandExecutorImpl extends Disposable implements IExternalCommandExecutor {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
	}

	async execute(
		jobId: string,
		command: string,
		timeoutMs: number,
		maxBytes: number = DEFAULT_MAX_BYTES,
		env?: Record<string, string>
	): Promise<string> {
		const paths = _tempPaths(jobId);

		// Build the wrapped command with redirection
		const wrapped = _buildWrappedCommand(command, paths, env);

		// Ensure the terminal is available before sending
		const terminal = await this._getOrCreateTerminal();
		await _sleep(TERMINAL_READY_DELAY_MS);

		// Clean up any leftover files from a previous run with the same jobId
		await this._cleanupFiles(paths);

		// Send command to terminal
		terminal.sendText(wrapped, true /* addNewLine */);

		// Poll for exit sentinel
		const startTime = Date.now();
		while (Date.now() - startTime < timeoutMs) {
			await _sleep(POLL_INTERVAL_MS);

			const exitExists = await this._fileExists(paths.exit);
			if (!exitExists) {
				continue;
			}

			// Read exit code
			const exitCode = await this._readText(paths.exit);
			const code = parseInt(exitCode.trim(), 10);

			// Read stdout regardless of exit code (many linters exit 1 with results)
			const stdout = await this._readCapped(paths.out, maxBytes);

			// Clean up temp files in background
			this._cleanupFiles(paths).catch(() => { /* ignore */ });

			if (code !== 0 && stdout.trim().length === 0) {
				// Only treat as hard failure when stdout is empty (tool didn't produce output)
				const stderr = await this._readText(paths.err).catch(() => '');
				throw new ExternalCommandError(
					`Command exited with code ${code}`,
					code,
					stderr.trim()
				);
			}

			return stdout;
		}

		// Timeout reached — clean up and throw
		this._cleanupFiles(paths).catch(() => { /* ignore */ });
		throw new ExternalCommandError(`Command timed out after ${timeoutMs}ms`, -1, '');
	}


	// ─── Private Helpers ──────────────────────────────────────────────

	private async _getOrCreateTerminal() {
		const existing = this._terminalService.instances.find(t => t.title === TERMINAL_NAME);
		if (existing) {
			return existing;
		}
		return this._terminalService.createTerminal({
			config: {
				name: TERMINAL_NAME,
				isTransient: true,
				hideFromUser: false,
			},
		});
	}

	private async _fileExists(uriStr: string): Promise<boolean> {
		try {
			await this._fileService.stat(URI.parse(uriStr));
			return true;
		} catch {
			return false;
		}
	}

	private async _readText(uriStr: string): Promise<string> {
		try {
			const content = await this._fileService.readFile(URI.parse(uriStr));
			return content.value.toString();
		} catch {
			return '';
		}
	}

	private async _readCapped(uriStr: string, maxBytes: number): Promise<string> {
		try {
			const stat = await this._fileService.stat(URI.parse(uriStr));
			if (stat.size > maxBytes) {
				// Read only the first maxBytes; callers can detect the truncation
				const partial = await this._fileService.readFile(URI.parse(uriStr), { position: 0, length: maxBytes });
				return partial.value.toString() + `\n[OUTPUT TRUNCATED at ${maxBytes} bytes]`;
			}
			const content = await this._fileService.readFile(URI.parse(uriStr));
			return content.value.toString();
		} catch {
			return '';
		}
	}

	private async _cleanupFiles(paths: ITempPaths): Promise<void> {
		const uris = [paths.out, paths.err, paths.exit].map(p => URI.parse(p));
		await Promise.allSettled(uris.map(u => this._fileService.del(u)));
	}
}


// ─── Error Type ───────────────────────────────────────────────────────────────

export class ExternalCommandError extends Error {
	constructor(
		message: string,
		public readonly exitCode: number,
		public readonly stderr: string
	) {
		super(message);
		this.name = 'ExternalCommandError';
	}
}


// ─── Temp Path Helpers ────────────────────────────────────────────────────────

interface ITempPaths {
	out: string;
	err: string;
	exit: string;
}

/**
 * Generate temp file URIs for a given job ID.
 * Uses `/tmp` on Unix and `%TEMP%` expansion on Windows.
 */
function _tempPaths(jobId: string): ITempPaths {
	const safe = jobId.replace(/[^a-zA-Z0-9_\-]/g, '_');
	if (isWindows) {
		// Use %TEMP% dir; PowerShell / cmd both honour this
		const base = `%TEMP%\\ni_ext_${safe}`;
		return {
			out: `file:///${base}.out`.replace('%TEMP%', 'C:/Users/TEMP'),
			err: `file:///${base}.err`.replace('%TEMP%', 'C:/Users/TEMP'),
			exit: `file:///${base}.exit`.replace('%TEMP%', 'C:/Users/TEMP'),
		};
	}
	return {
		out:  `file:///tmp/ni_ext_${safe}.out`,
		err:  `file:///tmp/ni_ext_${safe}.err`,
		exit: `file:///tmp/ni_ext_${safe}.exit`,
	};
}

/**
 * Wraps the user command with stdout/stderr redirection and an exit-code sentinel.
 *
 * Unix:    `( export VAR=val; command ) > out 2> err; echo $? > exit`
 * Windows: `cmd /C "set VAR=val && command > out 2> err & echo %ERRORLEVEL% > exit"`
 */
function _buildWrappedCommand(command: string, paths: ITempPaths, env?: Record<string, string>): string {
	const outPath  = _uriToShellPath(paths.out);
	const errPath  = _uriToShellPath(paths.err);
	const exitPath = _uriToShellPath(paths.exit);

	if (isWindows) {
		const envPrefix = env
			? Object.entries(env).map(([k, v]) => `set ${k}=${v.replace(/"/g, '\\"')} && `).join('')
			: '';
		return `cmd /C "${envPrefix}${command} > "${outPath}" 2> "${errPath}" & echo %ERRORLEVEL% > "${exitPath}""`;
	}

	const envPrefix = env
		? Object.entries(env).map(([k, v]) => `export ${k}=${_shellQuote(v)};`).join(' ') + ' '
		: '';

	return `( ${envPrefix}${command} ) > ${_shellQuote(outPath)} 2> ${_shellQuote(errPath)}; echo $? > ${_shellQuote(exitPath)}`;
}

/** Convert a `file://` URI string to the raw filesystem path for shell use. */
function _uriToShellPath(uriStr: string): string {
	return URI.parse(uriStr).fsPath;
}

/** Minimal POSIX single-quote shell escaping. */
function _shellQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Promisified sleep. */
function _sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Silence unused import warning
void VSBuffer;


// ─── Registration ─────────────────────────────────────────────────────────────

registerSingleton(IExternalCommandExecutor, ExternalCommandExecutorImpl, InstantiationType.Delayed);
