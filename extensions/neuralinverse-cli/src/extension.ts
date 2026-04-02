/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * neuralinverse-cli extension — HTTP server on localhost:7734.
 *
 * Endpoints:
 *   GET  /health                  → { running: true, port }
 *   POST /session                 → { sessionId: string }   (create persistent session)
 *   POST /run { prompt, token, sessionId?, cwd? }  → chunked text stream
 *
 * The CLI script runs in two modes:
 *   neuralinverse "prompt"   — one-shot
 *   neuralinverse            — interactive session (persistent context)
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

const PORT = 7734;

// token → pending HTTP response
const _pending = new Map<string, http.ServerResponse>();

function _token(): string {
	return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function activate(context: vscode.ExtensionContext): void {

	// ── Commands called by workbench to stream back to CLI ──────────────

	context.subscriptions.push(
		vscode.commands.registerCommand('_neuralInverse.cliDelta', (token: string, delta: string) => {
			_pending.get(token)?.write(delta);
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('_neuralInverse.cliDone', (token: string) => {
			const res = _pending.get(token);
			if (res) {
				res.end();
				_pending.delete(token);
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('_neuralInverse.cliError', (token: string, message: string) => {
			const res = _pending.get(token);
			if (res) {
				res.end('\n[Error: ' + (message ?? 'unknown') + ']\n');
				_pending.delete(token);
			}
		})
	);

	// ── Install CLI to disk ─────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('_neuralInverse.installCLI', async (scriptContent: string) => {
			const installPath = '/usr/local/bin/neuralinverse';
			try {
				fs.writeFileSync(installPath, scriptContent, { encoding: 'utf8', mode: 0o755 });
				return { success: true, path: installPath };
			} catch {
				try {
					const binDir = path.join(os.homedir(), '.local', 'bin');
					fs.mkdirSync(binDir, { recursive: true });
					const fallback = path.join(binDir, 'neuralinverse');
					fs.writeFileSync(fallback, scriptContent, { encoding: 'utf8', mode: 0o755 });
					return { success: true, path: fallback };
				} catch (e2: any) {
					return { success: false, error: (e2 as Error)?.message ?? String(e2) };
				}
			}
		})
	);

	// ── HTTP server ─────────────────────────────────────────────────────
	const server = http.createServer((req, res) => {
		res.setHeader('Access-Control-Allow-Origin', '127.0.0.1');

		if (req.method === 'GET' && req.url === '/health') {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ running: true, port: PORT }));
			return;
		}

		if (req.method === 'POST' && req.url === '/session') {
			_handleCreateSession(req, res);
			return;
		}

		if (req.method === 'DELETE' && req.url === '/session') {
			_handleDeleteSession(req, res);
			return;
		}

		if (req.method === 'POST' && req.url === '/run') {
			_handleRun(req, res);
			return;
		}

		res.writeHead(404);
		res.end('Not found');
	});

	server.on('error', (err: NodeJS.ErrnoException) => {
		if (err.code === 'EADDRINUSE') {
			console.log(`[neuralinverse-cli] Port ${PORT} already in use — CLI server not started.`);
		} else {
			console.error('[neuralinverse-cli] Server error:', err.message);
		}
	});

	server.listen(PORT, '127.0.0.1', () => {
		console.log(`[neuralinverse-cli] CLI server ready on localhost:${PORT}`);
	});

	context.subscriptions.push({ dispose: () => server.close() });
}

function _readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise(resolve => {
		let body = '';
		req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
		req.on('end', () => resolve(body));
	});
}

// POST /session — create a persistent Power Mode session, return its ID
async function _handleCreateSession(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	try {
		const body = await _readBody(req);
		let cliCwd: string | undefined;
		try { cliCwd = (JSON.parse(body) as { cwd?: string }).cwd; } catch { /* ignore */ }

		const result = await vscode.commands.executeCommand<{
			sessionId: string;
			agentId: string;
			workspacePath: string | null;
			workspaceName: string | null;
			cwdMismatch: boolean;
		}>('neuralInverse.cliCreateSession', cliCwd);

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(result));
	} catch (e: any) {
		res.writeHead(503);
		res.end('Neural Inverse not available: ' + ((e as Error)?.message ?? e));
	}
}

// DELETE /session { sessionId } — clean up Power Mode session when CLI exits
async function _handleDeleteSession(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	const body = await _readBody(req);
	try {
		const { sessionId } = JSON.parse(body) as { sessionId?: string };
		if (sessionId) {
			await vscode.commands.executeCommand('neuralInverse.cliDeleteSession', sessionId);
		}
	} catch { /* ignore */ }
	res.writeHead(200);
	res.end('ok');
}

// POST /run { prompt, token?, sessionId?, cwd? }
async function _handleRun(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
	const body = await _readBody(req);

	let prompt: string;
	let sessionId: string | undefined;
	try {
		const parsed = JSON.parse(body) as { prompt?: string; sessionId?: string; cwd?: string };
		prompt = (parsed.prompt ?? '').trim();
		sessionId = parsed.sessionId;
	} catch {
		res.writeHead(400);
		res.end('Invalid JSON');
		return;
	}

	if (!prompt) {
		res.writeHead(400);
		res.end('Missing prompt');
		return;
	}

	const token = _token();
	_pending.set(token, res);

	res.writeHead(200, {
		'Content-Type': 'text/plain; charset=utf-8',
		'Transfer-Encoding': 'chunked',
		'X-Accel-Buffering': 'no',
	});

	req.on('close', () => {
		_pending.delete(token);
		vscode.commands.executeCommand('neuralInverse.cliCancel', sessionId ?? token).then(undefined, () => undefined);
	});

	vscode.commands.executeCommand('neuralInverse.cliRun', prompt, token, sessionId).then(undefined, (err: Error) => {
		const r = _pending.get(token);
		if (r) {
			r.end('\n[Error: ' + (err?.message ?? 'Neural Inverse unavailable') + ']\n');
			_pending.delete(token);
		}
	});
}

export function deactivate(): void { /* server closed via subscriptions */ }
