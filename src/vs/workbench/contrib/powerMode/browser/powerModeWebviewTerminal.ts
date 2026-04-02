/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * PowerModeWebviewTerminal — real xterm.js terminal inside a VS Code webview.
 *
 * Webviews run in an isolated <iframe> context, bypassing VS Code's
 * "must create elements in main window" restriction, so xterm.js works correctly.
 *
 * Two opening modes:
 *   - openPowerModeFloating()  — floating window (no tab bar), uses IAuxiliaryWindowService
 *   - openPowerModeInTab()     — editor tab in the active group
 *
 * Both return a WebviewTerminal that PowerModeTerminalHost uses as its transport.
 */

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IWebviewService, IWebview, IWebviewElement } from '../../webview/browser/webview.js';
import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { asWebviewUri } from '../../webview/common/webview.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { getWindow } from '../../../../base/browser/dom.js';

// ─── Transport interface (shared with DomTerminal / XTermAdapter) ────────────

export interface ITerminalTransport {
	cols: number;
	rows: number;
	write(data: string): void;
	onData(callback: (data: string) => void): { dispose(): void };
	resize(cols: number, rows: number): void;
	focus(): void;
	dispose(): void;
	readonly isRealTerminal: boolean;
}

// ─── WebviewTerminal — wraps any IWebview (element or overlay) ───────────────

export class WebviewTerminal extends Disposable implements ITerminalTransport {

	cols = 120;
	rows = 40;
	readonly isRealTerminal = true;

	private readonly _dataListeners: Array<(data: string) => void> = [];
	private readonly _listeners = this._register(new DisposableStore());

	constructor(private readonly _webview: IWebview) {
		super();

		this._listeners.add(
			_webview.onMessage((e: { message: any }) => {
				const msg = e.message;
				if (!msg) { return; }
				if (msg.type === 'data') {
					for (const cb of this._dataListeners) { cb(msg.data as string); }
				}
				if (msg.type === 'size') {
					this.cols = (msg.cols as number) || this.cols;
					this.rows = (msg.rows as number) || this.rows;
				}
			})
		);
	}

	write(data: string): void {
		this._webview.postMessage({ type: 'write', data });
	}

	onData(callback: (data: string) => void): { dispose(): void } {
		this._dataListeners.push(callback);
		return {
			dispose: () => {
				const idx = this._dataListeners.indexOf(callback);
				if (idx >= 0) { this._dataListeners.splice(idx, 1); }
			},
		};
	}

	resize(cols: number, rows: number): void {
		this.cols = cols;
		this.rows = rows;
		this._webview.postMessage({ type: 'resize', cols, rows });
	}

	focus(): void {
		this._webview.postMessage({ type: 'focus' });
	}

	override dispose(): void {
		this._listeners.dispose();
		super.dispose();
	}
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

export function buildPowerModeWebviewHtml(nonce: string, xtermJsUri: string, xtermCssUri: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline' ${xtermCssUri}; font-src *;">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; background: #1e1e1e; overflow: hidden; }
    #terminal { width: 100%; height: 100%; }
    .xterm-viewport::-webkit-scrollbar { width: 6px; }
    .xterm-viewport::-webkit-scrollbar-thumb { background: #555; border-radius: 3px; }
  </style>
  <link rel="stylesheet" href="${xtermCssUri}">
</head>
<body>
  <div id="terminal"></div>
  <script nonce="${nonce}" src="${xtermJsUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const term = new Terminal({
      cols: 120, rows: 40, scrollback: 10000,
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, "Courier New", monospace',
      fontSize: 13, lineHeight: 1.2,
      theme: {
        background:'#1e1e1e', foreground:'#cccccc', cursor:'#cccccc',
        selectionBackground:'rgba(255,255,255,0.3)',
        black:'#000000', red:'#cd3131', green:'#0dbc79', yellow:'#e5e510',
        blue:'#2472c8', magenta:'#bc3fbc', cyan:'#11a8cd', white:'#e5e5e5',
        brightBlack:'#666666', brightRed:'#f14c4c', brightGreen:'#23d18b',
        brightYellow:'#f5f543', brightBlue:'#3b8eea', brightMagenta:'#d670d6',
        brightCyan:'#29b8db', brightWhite:'#e5e5e5',
      },
      cursorBlink: true, cursorStyle: 'block', convertEol: true, allowProposedApi: true,
    });
    const container = document.getElementById('terminal');
    term.open(container);
    term.focus();
    term.onData(function(data) { vscode.postMessage({ type: 'data', data: data }); });
    window.addEventListener('message', function(e) {
      const msg = e.data;
      if (!msg) return;
      if (msg.type === 'write') { term.write(msg.data); }
      if (msg.type === 'resize') { try { term.resize(msg.cols, msg.rows); } catch {} }
      if (msg.type === 'focus') { term.focus(); }
    });
    function fit() {
      const w = container.clientWidth, h = container.clientHeight;
      if (w <= 0 || h <= 0) return;
      const cols = Math.max(40, Math.floor(w / 7.6));
      const rows = Math.max(10, Math.floor(h / 18));
      try { term.resize(cols, rows); vscode.postMessage({ type: 'size', cols, rows }); } catch {}
    }
    new ResizeObserver(function() { fit(); }).observe(container);
    fit();
  </script>
</body>
</html>`;
}

// ─── Shared URI helper ────────────────────────────────────────────────────────

function _xtermUris(appRoot: string): { dirUri: URI; jsUri: string; cssUri: string } {
	const dir = `${appRoot}/node_modules/@xterm/xterm`;
	return {
		dirUri:  URI.file(dir),
		jsUri:   asWebviewUri(URI.file(`${dir}/lib/xterm.js`)).toString(true),
		cssUri:  asWebviewUri(URI.file(`${dir}/css/xterm.css`)).toString(true),
	};
}

function _generateNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let r = '';
	for (let i = 0; i < 32; i++) { r += chars[Math.floor(Math.random() * chars.length)]; }
	return r;
}

// ─── Mode 1: Floating window (no tab bar) ─────────────────────────────────────
//
// Opens a native aux window via IAuxiliaryWindowService, then mounts a
// IWebviewElement inside it. The webview iframe hosts xterm.js.
// No VS Code tab bar — feels like a dedicated terminal window.

export interface IOpenFloatingResult {
	terminal: WebviewTerminal;
	webviewElement: IWebviewElement;
	dispose(): void;
}

export async function openPowerModeFloating(
	auxiliaryWindowService: IAuxiliaryWindowService,
	webviewService: IWebviewService,
	environmentService: IEnvironmentService,
): Promise<IOpenFloatingResult> {

	const { dirUri, jsUri, cssUri } = _xtermUris(environmentService.appRoot);

	const win = await auxiliaryWindowService.open({
		type: 'powerModeTerminal',
		nativeTitlebar: true,
		bounds: { width: 900, height: 680 },
	});

	// Full-screen container inside the aux window
	const container = document.createElement('div');
	container.style.cssText = 'position:absolute;inset:0;overflow:hidden;';
	win.container.appendChild(container);

	// Apply initial dimensions
	const applySize = (w: number, h: number) => {
		container.style.width = w + 'px';
		container.style.height = h + 'px';
	};
	setTimeout(() => applySize(win.window.innerWidth, win.window.innerHeight), 0);
	win.onDidLayout(d => applySize(d.width, d.height));

	const webviewEl = webviewService.createWebviewElement({
		providedViewType: 'powerModeTerminal',
		title: 'Power Mode',
		options: { enableFindWidget: false, retainContextWhenHidden: true },
		contentOptions: { allowScripts: true, localResourceRoots: [dirUri] },
		extension: undefined,
	});

	const nonce = _generateNonce();
	webviewEl.setHtml(buildPowerModeWebviewHtml(nonce, jsUri, cssUri));
	webviewEl.mountTo(container, getWindow(container));

	const terminal = new WebviewTerminal(webviewEl);

	return {
		terminal,
		webviewElement: webviewEl,
		dispose: () => { terminal.dispose(); webviewEl.dispose(); },
	};
}

// ─── Mode 2: Editor tab (normal window) ──────────────────────────────────────
//
// Opens Power Mode as a WebviewInput editor tab in a new floating editor group
// (its own window with VS Code tab bar), or in the active group.

export interface IOpenTabResult {
	terminal: WebviewTerminal;
	webviewInput: WebviewInput;
}

export async function openPowerModeInTab(
	webviewWorkbenchService: IWebviewWorkbenchService,
	environmentService: IEnvironmentService,
	editorGroupsService: IEditorGroupsService,
	floatingWindow: boolean,
): Promise<IOpenTabResult> {

	const { dirUri, jsUri, cssUri } = _xtermUris(environmentService.appRoot);

	const group = floatingWindow
		? (await editorGroupsService.createAuxiliaryEditorPart({ bounds: { width: 900, height: 680 } })).activeGroup
		: undefined; // undefined = active group in main window

	const webviewInput = webviewWorkbenchService.openWebview(
		{
			providedViewType: 'powerModeTerminal',
			title: 'Power Mode',
			options: { enableFindWidget: false, retainContextWhenHidden: true },
			contentOptions: { allowScripts: true, localResourceRoots: [dirUri] },
			extension: undefined,
		},
		'powerModeTerminal',
		'Power Mode',
		{ group, preserveFocus: false },
	);

	const nonce = _generateNonce();
	webviewInput.webview.setHtml(buildPowerModeWebviewHtml(nonce, jsUri, cssUri));

	const terminal = new WebviewTerminal(webviewInput.webview);

	return { terminal, webviewInput };
}
