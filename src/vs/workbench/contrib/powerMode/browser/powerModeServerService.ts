/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * PowerModeServerService — workbench side of the CLI bridge.
 *
 * The actual HTTP server lives in the neuralinverse-cli built-in extension
 * (extension host has full Node.js / http access; the sandboxed renderer does not).
 *
 * Commands registered here (called by the extension):
 *   neuralInverse.cliCreateSession          \u2192 creates a Power Mode session, returns its ID
 *   neuralInverse.cliRun(prompt, token, sessionId?)  \u2192 runs prompt, streams deltas back
 *   neuralInverse.cliCancel(sessionId)      \u2192 cancels a running session
 *
 * Commands called on the extension (to stream data back):
 *   _neuralInverse.cliDelta(token, delta)
 *   _neuralInverse.cliDone(token)
 *   _neuralInverse.cliError(token, message)
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IPowerModeService } from './powerModeService.js';
import { IFirmwareSessionService } from '../../neuralInverseFirmware/browser/firmwareSessionService.js';
import { IModernisationSessionService } from '../../neuralInverseModernisation/browser/modernisationSessionService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const POWER_MODE_CLI_PORT = 7734;

// ─── CLI script ───────────────────────────────────────────────────────────────
//
// Written to /usr/local/bin/neuralinverse by "Neural Inverse: Install CLI".
// Two modes:
//   neuralinverse "prompt"   — one-shot, exits when done
//   neuralinverse            — interactive session with persistent context

export function getCLIScript(executablePath: string): string { return `#!/usr/bin/env node
'use strict';

const http = require('http');
const readline = require('readline');
const { spawn } = require('child_process');

const PORT = ${POWER_MODE_CLI_PORT};
const HOST = '127.0.0.1';
const IDE_EXEC = ${JSON.stringify(executablePath)};

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const A = {
  reset:  '\\x1b[0m',
  bold:   '\\x1b[1m',
  dim:    '\\x1b[2m',
  amber:  '\\x1b[38;5;208m',
  white:  '\\x1b[97m',
  gray:   '\\x1b[90m',
  red:    '\\x1b[91m',
  green:  '\\x1b[92m',
};
const c = (code, text) => code + text + A.reset;

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: HOST, port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function stream(path, body, onChunk) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: HOST, port: PORT, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', c => errBody += c);
        res.on('end', () => reject(new Error('HTTP ' + res.statusCode + ': ' + errBody.trim())));
        return;
      }
      res.on('data', chunk => onChunk(chunk.toString()));
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.write(data);
    req.end();
    return req; // caller can abort
  });
}

function checkRunning() {
  return new Promise(resolve => {
    http.get({ hostname: HOST, port: PORT, path: '/health' }, res => {
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

async function openAndWait() {
  process.stdout.write(c(A.amber, '  Neural Inverse is not running. Starting...') + '\\n');
  try {
    spawn(IDE_EXEC, [], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    throw new Error('Could not launch Neural Inverse at: ' + IDE_EXEC);
  }
  const start = Date.now();
  const timeout = 30000;
  while (Date.now() - start < timeout) {
    await new Promise(r => setTimeout(r, 800));
    if (await checkRunning()) {
      process.stdout.write(c(A.green, '  Neural Inverse started.') + '\\n\\n');
      return;
    }
    process.stdout.write('.');
  }
  throw new Error('Neural Inverse did not start within 30s. Try opening it manually.');
}

// ── One-shot mode ─────────────────────────────────────────────────────────────
// Pure stdout — no headers, no dividers, no extra text. Suitable for scripting:
//   neuralinverse "write a react component" > component.tsx
//   neuralinverse "explain this" | pbcopy
async function runOneShot(prompt) {
  await stream('/run', { prompt, cwd: process.cwd() }, chunk => process.stdout.write(chunk));
}

// ── Interactive mode ──────────────────────────────────────────────────────────
async function runInteractive() {
  // Create a persistent session — pass cwd so server can detect workspace match
  const { body } = await post('/session', { cwd: process.cwd() });
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = {}; }
  const sessionId = parsed.sessionId;
  const agentId = parsed.agentId ?? 'default';
  const workspaceName = parsed.workspaceName ?? parsed.workspacePath ?? 'unknown';
  const cwdMismatch = parsed.cwdMismatch ?? false;
  const resumed = parsed.resumed ?? false;

  const agentLabels = { firmware: 'Firmware', modernisation: 'Modernisation', build: 'Build', plan: 'Plan' };
  const agentLabel = agentLabels[agentId] ?? 'Power Mode';

  // Header
  process.stdout.write('\\n');
  process.stdout.write(c(A.amber + A.bold, '  ⊗  Neural Inverse') + c(A.gray, '  –  ' + agentLabel) + '\\n');
  process.stdout.write(c(A.gray, '  Workspace: ') + c(A.white, workspaceName) + '\\n');
  process.stdout.write(c(A.gray, resumed ? '  ↩  Resumed open IDE session' : '  ✦  New session') + '\\n');
  if (cwdMismatch) {
    process.stdout.write(c(A.amber, '  ⚠  Terminal is outside this workspace.') + '\\n');
  }
  process.stdout.write(c(A.gray, '  /exit or Ctrl+C to quit.') + '\\n');
  process.stdout.write('\\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    prompt: c(A.amber + A.bold, '  ⊗ ') + c(A.white + A.bold, '> ') + A.reset,
  });

  rl.prompt();

  let _exiting = false;

  function exit() {
    if (_exiting) { return; }
    _exiting = true;
    process.stdout.write('\\n');
    // Best-effort cleanup — don't wait for response
    try {
      const data = JSON.stringify({ sessionId });
      const req = http.request({
        hostname: HOST, port: PORT, path: '/session', method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      });
      req.on('error', () => undefined);
      req.write(data);
      req.end();
    } catch { /* ignore */ }
    // Exit immediately — don't wait for HTTP response
    process.exit(0);
  }

  rl.on('line', async line => {
    const input = line.trim();

    if (!input) { rl.prompt(); return; }
    if (input === '/exit' || input === '/quit' || input === 'exit' || input === 'quit') {
      exit();
      return;
    }

    rl.pause();
    process.stdout.write('\\n');

    try {
      let hasOutput = false;
      await stream('/run', { prompt: input, sessionId, cwd: process.cwd() }, chunk => {
        if (!hasOutput) {
          process.stdout.write(c(A.gray, '  ─────────────────────────────────────') + '\\n');
          hasOutput = true;
        }
        process.stdout.write(chunk);
      });
      if (!hasOutput) {
        process.stdout.write(c(A.gray, '  ─────────────────────────────────────') + '\\n');
        process.stdout.write(c(A.gray, '  (no response)') + '\\n');
      }
      process.stdout.write('\\n' + c(A.gray, '  ─────────────────────────────────────') + '\\n\\n');
    } catch (err) {
      process.stdout.write(c(A.red, '  Error: ' + err.message) + '\\n\\n');
    }

    if (!_exiting) {
      rl.resume();
      rl.prompt();
    }
  });

  // readline captures Ctrl+C — must use rl.on('SIGINT'), not process.on('SIGINT')
  rl.on('SIGINT', exit);
  rl.on('close', exit);
}

// ── Entry point ───────────────────────────────────────────────────────────────
(async () => {
  const isRunning = await checkRunning();
  if (!isRunning) {
    try {
      await openAndWait();
    } catch (err) {
      console.error(c(A.red, '  ' + err.message));
      process.exit(1);
    }
  }

  const prompt = process.argv.slice(2).join(' ').trim();

  if (prompt) {
    // One-shot
    try {
      await runOneShot(prompt);
    } catch (err) {
      console.error(c(A.red, 'Error: ' + err.message));
      process.exit(1);
    }
  } else {
    // Interactive
    try {
      await runInteractive();
    } catch (err) {
      console.error(c(A.red, 'Error: ' + err.message));
      process.exit(1);
    }
  }
})();
`; }

// ─── Service interface ────────────────────────────────────────────────────────

export const IPowerModeServerService = createDecorator<IPowerModeServerService>('powerModeServerService');

export interface IPowerModeServerService {
	readonly _serviceBrand: undefined;
	readonly port: number;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class PowerModeServerServiceImpl extends Disposable implements IPowerModeServerService {

	declare readonly _serviceBrand: undefined;
	readonly port = POWER_MODE_CLI_PORT;

	constructor(
		@IPowerModeService private readonly _powerModeService: IPowerModeService,
		@ICommandService private readonly _commandService: ICommandService,
		@IFirmwareSessionService private readonly _firmwareSessionService: IFirmwareSessionService,
		@IModernisationSessionService private readonly _modernisationSessionService: IModernisationSessionService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._registerCommands();
	}

	private _registerCommands(): void {

		// ── Create a persistent session ───────────────────────────────────
		//
		// Detect the active context in the IDE and use the matching agentId so
		// the CLI gets the same system prompt + tools as the open session:
		//   firmware.inverse open  \u2192 agentId 'firmware'  (STM32, MISRA, peripherals etc.)
		//   modernisation open     \u2192 agentId 'modernisation'
		//   active Power Mode tab  \u2192 inherit its agentId
		//   otherwise              \u2192 default Power Mode agent
		this._register(
			CommandsRegistry.registerCommand('neuralInverse.cliCreateSession', (_accessor, cliCwd?: string) => {
				// Reuse the currently active IDE session if it's idle — so the CLI
				// picks up the exact conversation already open in Power Mode.
				// If it's busy or doesn't exist, create a fresh one.
				const existingSession = this._powerModeService.activeSession;
				const session = (existingSession && existingSession.status === 'idle')
					? existingSession
					: this._powerModeService.createSession(this._detectActiveAgent());

				// Workspace info
				const folders = this._workspaceContextService.getWorkspace().folders;
				const workspacePath = folders[0]?.uri.fsPath ?? null;
				const workspaceName = folders[0]?.name ?? null;
				const cwdMismatch = !!(cliCwd && workspacePath && !cliCwd.startsWith(workspacePath));

				return {
					sessionId: session.id,
					agentId: session.agentId,
					workspaceName,
					workspacePath,
					cwdMismatch,
					resumed: !!(existingSession && existingSession.status === 'idle'),
				};
			})
		);

		// ── Run a prompt (one-shot or within a persistent session) ─────────
		this._register(
			CommandsRegistry.registerCommand('neuralInverse.cliRun', async (_accessor, prompt: string, token: string, sessionId?: string) => {
				if (!prompt || !token) { return; }

				// Reuse existing session if provided and still alive
				let session = sessionId ? this._powerModeService.getSession(sessionId) : undefined;

				// If no valid session, create a fresh one
				if (!session) {
					session = this._powerModeService.createSession();
				}

				// Don't pile on a busy session — silently wait is unsafe; signal the error
				if (session.status === 'busy') {
					this._commandService.executeCommand('_neuralInverse.cliError', token, 'Session is busy. Wait for the current response to finish.').catch(() => undefined);
					return;
				}

				const sid = session.id;

				const deltaDisposable = this._powerModeService.onDidEmitDelta(({ sessionId: s, field, delta }) => {
					if (s !== sid || field !== 'text') { return; }
					this._commandService.executeCommand('_neuralInverse.cliDelta', token, delta).catch(() => undefined);
				});

				const sessionDisposable = this._powerModeService.onDidChangeSession(s => {
					if (s.id !== sid) { return; }
					if (s.status === 'idle' || s.status === 'error') {
						deltaDisposable.dispose();
						sessionDisposable.dispose();
						this._commandService.executeCommand('_neuralInverse.cliDone', token).catch(() => undefined);
					}
				});

				await this._powerModeService.sendMessage(sid, prompt);
			})
		);

		// ── Cancel ────────────────────────────────────────────────────────
		this._register(
			CommandsRegistry.registerCommand('neuralInverse.cliCancel', (_accessor, sessionId: string) => {
				this._powerModeService.cancel(sessionId);
			})
		);

		// ── Delete session when CLI exits ─────────────────────────────────
		this._register(
			CommandsRegistry.registerCommand('neuralInverse.cliDeleteSession', (_accessor, sessionId: string) => {
				this._powerModeService.cancel(sessionId);
				this._powerModeService.deleteSession(sessionId);
			})
		);
	}

	/**
	 * Detect which agent context is currently active in the IDE.
	 * Priority: firmware > modernisation > active Power Mode tab > default
	 */
	private _detectActiveAgent(): string | undefined {
		// 1. Firmware session open (firmware.inverse loaded)
		if (this._firmwareSessionService.session?.isActive) {
			return 'firmware';
		}
		// 2. Modernisation session active
		if (this._modernisationSessionService.session?.isActive) {
			return 'modernisation';
		}
		// 3. Inherit from whatever agent the user has open in Power Mode
		const active = this._powerModeService.activeSession;
		if (active?.agentId) {
			return active.agentId;
		}
		// 4. Default — standard Power Mode agent
		return undefined;
	}
}

// ─── Registration ─────────────────────────────────────────────────────────────

registerSingleton(IPowerModeServerService, PowerModeServerServiceImpl, InstantiationType.Eager);
