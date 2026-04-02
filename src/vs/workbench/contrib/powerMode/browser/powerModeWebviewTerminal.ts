/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * PowerModeWebviewTerminal — real xterm.js terminal inside a VS Code webview.
 *
 * Two opening modes:
 *   - openPowerModeFloating()  — floating aux editor window (no extra tab bar)
 *   - openPowerModeInTab()     — editor tab in the active/floating group
 *
 * Both return a WebviewTerminal that PowerModeTerminalHost uses as its transport.
 * The sidebar (session history + modified files) is driven by setSidebarSections().
 */

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IWebview } from '../../webview/browser/webview.js';
import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { WebviewInput } from '../../webviewPanel/browser/webviewEditorInput.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IFileService } from '../../../../platform/files/common/files.js';

// ─── Active terminal tracker (used by the EditorTitle toggle command) ────────

let _activeTerminal: WebviewTerminal | undefined;

export function getActivePowerModeTerminal(): WebviewTerminal | undefined {
	return _activeTerminal;
}

function _setActiveTerminal(t: WebviewTerminal | undefined): void {
	_activeTerminal = t;
}

// ─── Transport interface ──────────────────────────────────────────────────────

export interface ITerminalTransport {
	cols: number;
	rows: number;
	write(data: string): void;
	onData(callback: (data: string) => void): { dispose(): void };
	/** Fires once when the terminal is ready to render (after first fit + clear). */
	onReady?: (callback: () => void) => { dispose(): void };
	resize(cols: number, rows: number): void;
	focus(): void;
	dispose(): void;
	readonly isRealTerminal: boolean;
	tryUpgrade(): Promise<void>;
}

// ─── Sidebar types ────────────────────────────────────────────────────────────

export interface IPMSidebarItem {
	label: string;
	description?: string;
	meta?: string;
	onClick?: () => void;
	/** If set, a × delete button appears on hover and calls this. */
	onDelete?: () => void;
}

export interface IPMSidebarSection {
	title: string;
	items: IPMSidebarItem[];
	collapsed?: boolean;
	/** CSS max-height for the section body, e.g. '280px'. Enables internal scroll. */
	maxHeight?: string;
}

// ─── WebviewTerminal — wraps an IWebview ─────────────────────────────────────

export class WebviewTerminal extends Disposable implements ITerminalTransport {

	cols = 120;
	rows = 40;
	readonly isRealTerminal = true;

	private readonly _dataListeners: Array<(data: string) => void> = [];
	private readonly _readyListeners: Array<() => void> = [];
	private _isReady = false;
	private readonly _listeners = this._register(new DisposableStore());
	private _sidebarSections: IPMSidebarSection[] = [];
	private _pendingSidebarPayload: object[] | undefined;
	private readonly _revertListeners: Array<(changeId: string) => void> = [];

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
				if (msg.type === 'ready') {
					this._isReady = true;
					for (const cb of this._readyListeners) { cb(); }
					this._readyListeners.length = 0;
					if (this._pendingSidebarPayload) {
						this._webview.postMessage({ type: 'setSidebarSections', sections: this._pendingSidebarPayload });
						this._pendingSidebarPayload = undefined;
					}
				}
				if (msg.type === 'sessionClick') {
					const section = this._sidebarSections[msg.sectionIndex as number];
					const item = section?.items[msg.itemIndex as number];
					item?.onClick?.();
				}
				if (msg.type === 'deleteClick') {
					const section = this._sidebarSections[msg.sectionIndex as number];
					const item = section?.items[msg.itemIndex as number];
					item?.onDelete?.();
				}
				if (msg.type === 'revertChange') {
					for (const cb of this._revertListeners) { cb(msg.changeId as string); }
				}
				if (msg.type === 'requestSidebarSections') {
					const payload = this._pendingSidebarPayload
						?? (this._sidebarSections.length > 0 ? this._sidebarSections.map(s => ({
							title: s.title, collapsed: s.collapsed, maxHeight: s.maxHeight,
							items: s.items.map(i => ({ label: i.label, description: i.description, meta: i.meta, deletable: !!i.onDelete })),
						})) : null);
					if (payload) {
						this._webview.postMessage({ type: 'setSidebarSections', sections: payload });
						this._pendingSidebarPayload = undefined;
					}
				}
			})
		);
	}

	toggleSidebar(): void {
		this._webview.postMessage({ type: 'toggleSidebar' });
	}

	setSidebarSections(sections: IPMSidebarSection[]): void {
		this._sidebarSections = sections;
		const payload = sections.map(s => ({
			title: s.title, collapsed: s.collapsed, maxHeight: s.maxHeight,
			items: s.items.map(item => ({
				label: item.label, description: item.description, meta: item.meta, deletable: !!item.onDelete,
			})),
		}));
		if (this._isReady) {
			this._webview.postMessage({ type: 'setSidebarSections', sections: payload });
		} else {
			this._pendingSidebarPayload = payload;
		}
	}

	onReady(callback: () => void): { dispose(): void } {
		if (this._isReady) { callback(); return { dispose: () => { } }; }
		this._readyListeners.push(callback);
		return {
			dispose: () => {
				const idx = this._readyListeners.indexOf(callback);
				if (idx >= 0) { this._readyListeners.splice(idx, 1); }
			},
		};
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

	async tryUpgrade(): Promise<void> { /* already the real terminal */ }

	showFileDiff(data: { changeId: string; filePath: string; contentBefore: string | null; contentAfter: string; changeType: string }): void {
		this._webview.postMessage({ type: 'showFileDiff', ...data });
	}

	onRevertChange(callback: (changeId: string) => void): { dispose(): void } {
		this._revertListeners.push(callback);
		return {
			dispose: () => {
				const i = this._revertListeners.indexOf(callback);
				if (i >= 0) { this._revertListeners.splice(i, 1); }
			},
		};
	}

	override dispose(): void {
		this._listeners.dispose();
		super.dispose();
	}
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

export function buildPowerModeWebviewHtml(xtermJs: string, xtermCss: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src *;">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; }

    #root { display: flex; width: 100%; height: 100%; position: relative; }

    /* ── Sidebar ── */
    #sidebar {
      width: 0; overflow: hidden; flex-shrink: 0;
      transition: width 0.15s ease;
      background: var(--vscode-sideBar-background, #252526);
      display: flex; flex-direction: column;
    }
    #sidebar.open { width: 260px; }
    #sidebar-title {
      width: 260px; flex-shrink: 0; height: 35px;
      display: flex; align-items: center; padding: 0 12px 0 20px;
      color: var(--vscode-sideBarTitle-foreground, #bdbdbd);
      font-size: 11px; font-weight: 700; letter-spacing: 0.1em;
      text-transform: uppercase;
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      user-select: none;
    }
    #sidebar-body {
      width: 260px; flex: 1; overflow-y: auto; overflow-x: hidden;
      user-select: none;
    }
    #sidebar-body::-webkit-scrollbar { width: 6px; }
    #sidebar-body::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background, #555); border-radius: 3px;
    }

    .pm-section-header {
      display: flex; align-items: center; height: 22px; padding: 0 8px;
      cursor: pointer;
      color: var(--vscode-sideBarSectionHeader-foreground, #bbbbbb);
      font-size: 11px; font-weight: 700; letter-spacing: 0.1em;
      text-transform: uppercase;
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      border-top: 1px solid var(--vscode-sideBarSectionHeader-border, rgba(128,128,128,0.35));
      background: var(--vscode-sideBarSectionHeader-background, transparent);
    }
    .pm-section-header:hover {
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.04));
    }
    .pm-chevron {
      flex-shrink: 0; margin-right: 4px; font-size: 14px; line-height: 1;
      transition: transform 0.1s; display: inline-block; transform: rotate(0deg);
    }
    .pm-chevron.open { transform: rotate(90deg); }

    .pm-item {
      display: flex; align-items: center;
      min-height: 22px; padding: 3px 6px 3px 28px; cursor: pointer;
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      position: relative;
    }
    .pm-item:hover { background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.07)); }
    .pm-item-content { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
    .pm-item-label {
      color: var(--vscode-foreground, #cccccc); font-size: 13px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .pm-item-desc {
      color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 11px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .pm-item-meta { color: var(--vscode-disabledForeground, #5a5a5a); font-size: 10px; }
    .pm-item-delete {
      flex-shrink: 0; width: 18px; height: 18px;
      display: none; align-items: center; justify-content: center;
      color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 14px; line-height: 1;
      border-radius: 3px; cursor: pointer;
    }
    .pm-item:hover .pm-item-delete { display: flex; }
    .pm-item-delete:hover { color: var(--vscode-errorForeground, #f44747); background: rgba(255,255,255,0.08); }

    /* ── Diff Overlay ── */
    #diff-overlay {
      display: none; position: absolute; inset: 0; z-index: 500;
      background: #1e1e1e; flex-direction: column;
      font-family: 'Cascadia Code', Consolas, 'Courier New', monospace;
    }
    #diff-overlay.visible { display: flex; }
    #diff-header {
      display: flex; align-items: center; height: 38px; padding: 0 12px; gap: 8px;
      background: #252526; border-bottom: 1px solid rgba(255,255,255,0.1); flex-shrink: 0;
    }
    #diff-filename { color: #cccccc; font-size: 13px; font-weight: 600; }
    #diff-badge {
      padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: 700;
      letter-spacing: 0.05em; text-transform: uppercase;
      background: rgba(255,255,255,0.1); color: #9d9d9d;
    }
    #diff-stats { color: #9d9d9d; font-size: 11px; }
    #diff-revert-btn {
      background: rgba(244,71,71,0.15); border: 1px solid rgba(244,71,71,0.4);
      color: #f44747; font-size: 12px; padding: 4px 10px; border-radius: 3px;
      cursor: pointer; font-family: inherit;
    }
    #diff-revert-btn:hover { background: rgba(244,71,71,0.28); }
    #diff-close-btn {
      background: none; border: none; color: #9d9d9d; font-size: 20px; line-height: 1;
      cursor: pointer; width: 28px; height: 28px; display: flex; align-items: center;
      justify-content: center; border-radius: 3px;
    }
    #diff-close-btn:hover { background: rgba(255,255,255,0.1); color: #cccccc; }
    #diff-body { flex: 1; overflow-y: auto; overflow-x: auto; font-size: 12px; line-height: 1.5; }
    #diff-body::-webkit-scrollbar { width: 6px; height: 6px; }
    #diff-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 3px; }
    #diff-unavail { color: #9d9d9d; padding: 24px; font-size: 13px; }
    .diff-tbl { width: 100%; border-collapse: collapse; }
    .diff-ln {
      width: 38px; min-width: 38px; text-align: right; padding: 0 6px;
      color: rgba(255,255,255,0.22); font-size: 11px; user-select: none;
      border-right: 1px solid rgba(255,255,255,0.07); background: rgba(0,0,0,0.18);
    }
    .diff-sign { width: 16px; min-width: 16px; text-align: center; font-weight: 700; user-select: none; }
    .diff-code { padding: 0 10px; white-space: pre; color: #cccccc; width: 100%; }
    .diff-rm { background: rgba(255,0,0,0.11); }
    .diff-rm .diff-sign { color: #f44747; }
    .diff-rm .diff-code { color: #ffb3b3; }
    .diff-rm .diff-ln { background: rgba(255,0,0,0.09); }
    .diff-add { background: rgba(0,200,80,0.09); }
    .diff-add .diff-sign { color: #23d18b; }
    .diff-add .diff-code { color: #b3ffd9; }
    .diff-add .diff-ln { background: rgba(0,200,80,0.07); }
    .diff-eq .diff-sign { color: transparent; }
    .diff-hunk { background: rgba(0,120,212,0.1); color: rgba(100,180,255,0.7); font-size: 11px; padding: 2px 10px; }

    /* ── Terminal ── */
    #terminal { flex: 1; min-width: 0; overflow: hidden; background: #1e1e1e; }
    .xterm-viewport::-webkit-scrollbar { width: 6px; }
    .xterm-viewport::-webkit-scrollbar-track { background: transparent; }
    .xterm-viewport::-webkit-scrollbar-thumb { background: transparent; border-radius: 3px; transition: background 0.2s; }
    #terminal:hover .xterm-viewport::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); }
  </style>
  <style>${xtermCss}</style>
</head>
<body>
  <div id="root">
    <div id="sidebar" class="open">
      <div id="sidebar-title">Sessions</div>
      <div id="sidebar-body"></div>
    </div>
    <div id="terminal"></div>
    <div id="diff-overlay">
      <div id="diff-header">
        <span id="diff-filename"></span>
        <span id="diff-badge"></span>
        <span id="diff-stats"></span>
        <div style="flex:1"></div>
        <button id="diff-revert-btn">\u21a9 Revert</button>
        <button id="diff-close-btn">\u00d7</button>
      </div>
      <div id="diff-body"></div>
    </div>
  </div>
  <script>${xtermJs}</script>
  <script>
    window.onerror = function(msg, src, line) {
      var el = document.getElementById('terminal');
      if (el) {
        el.style.cssText = 'background:#3a0000;color:#ff6666;font-family:monospace;font-size:13px;padding:12px;white-space:pre-wrap;';
        el.textContent = 'Error: ' + msg + '\\n' + (src||'') + ':' + line;
      }
    };

    var term, vscode;
    try {
      term = new Terminal({
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
      term.open(document.getElementById('terminal'));
      term.focus();
    } catch(e) {
      var el = document.getElementById('terminal');
      if (el) { el.style.cssText = 'background:#3a0000;color:#ff6666;font-family:monospace;padding:12px;'; el.textContent = 'xterm error: ' + e.message; }
    }

    try { vscode = acquireVsCodeApi(); } catch(e) { /* outside VS Code */ }

    // ── Sidebar ──────────────────────────────────────────────────────────────
    var sidebar = document.getElementById('sidebar');
    var sidebarBody = document.getElementById('sidebar-body');

    function toggleSidebar() { sidebar.classList.toggle('open'); fit(); }

    function renderSections(sections) {
      while (sidebarBody.firstChild) { sidebarBody.removeChild(sidebarBody.firstChild); }
      for (var si = 0; si < sections.length; si++) {
        (function(section, sectionIdx) {
          var collapsed = !!section.collapsed;
          var wrap = document.createElement('div');
          var hdr = document.createElement('div'); hdr.className = 'pm-section-header';
          var chv = document.createElement('span'); chv.className = 'pm-chevron' + (collapsed ? '' : ' open'); chv.textContent = '\u203a';
          var ttl = document.createElement('span'); ttl.textContent = section.title; ttl.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
          hdr.appendChild(chv); hdr.appendChild(ttl);
          var body = document.createElement('div'); body.style.display = collapsed ? 'none' : '';
          if (section.maxHeight) { body.style.maxHeight = section.maxHeight; body.style.overflowY = 'auto'; }
          hdr.addEventListener('click', function() {
            collapsed = !collapsed; body.style.display = collapsed ? 'none' : '';
            chv.className = 'pm-chevron' + (collapsed ? '' : ' open');
          });
          for (var ii = 0; ii < section.items.length; ii++) {
            (function(item, itemIdx) {
              var row = document.createElement('div'); row.className = 'pm-item';
              var content = document.createElement('div'); content.className = 'pm-item-content';
              var lbl = document.createElement('div'); lbl.className = 'pm-item-label'; lbl.textContent = item.label;
              content.appendChild(lbl);
              if (item.description) { var desc = document.createElement('div'); desc.className = 'pm-item-desc'; desc.textContent = item.description; content.appendChild(desc); }
              if (item.meta) { var meta = document.createElement('div'); meta.className = 'pm-item-meta'; meta.textContent = item.meta; content.appendChild(meta); }
              row.appendChild(content);
              if (item.deletable) {
                var del = document.createElement('div'); del.className = 'pm-item-delete'; del.textContent = '\u00d7'; del.title = 'Delete session';
                del.addEventListener('click', function(e) { e.stopPropagation(); if (vscode) { vscode.postMessage({ type: 'deleteClick', sectionIndex: sectionIdx, itemIndex: itemIdx }); } });
                row.appendChild(del);
              }
              row.addEventListener('click', function() { if (vscode) { vscode.postMessage({ type: 'sessionClick', sectionIndex: sectionIdx, itemIndex: itemIdx }); } });
              body.appendChild(row);
            })(section.items[ii], ii);
          }
          wrap.appendChild(hdr); wrap.appendChild(body);
          sidebarBody.appendChild(wrap);
        })(sections[si], si);
      }
    }

    if (term) { term.onData(function(data) { if (vscode) { vscode.postMessage({ type: 'data', data: data }); } }); }
    var container = document.getElementById('terminal');
    var _ready = false, _buf = [];
    function flushBuf() { _ready = true; for (var i = 0; i < _buf.length; i++) { term.write(_buf[i]); } _buf = []; }

    // ── Message handler ───────────────────────────────────────────────────────
    window.addEventListener('message', function(e) {
      var msg = e.data; if (!msg) return;
      if (msg.type === 'write') { if (term) { if (_ready) { term.write(msg.data); } else { _buf.push(msg.data); } } }
      if (msg.type === 'resize') { if (term) { try { term.resize(msg.cols, msg.rows); } catch(ex) {} } }
      if (msg.type === 'focus') { if (term) { term.focus(); } }
      if (msg.type === 'toggleSidebar') { toggleSidebar(); }
      if (msg.type === 'setSidebarSections') { renderSections(msg.sections); }
      if (msg.type === 'showFileDiff') { showDiff(msg); }
    });

    // ── Fit ───────────────────────────────────────────────────────────────────
    var _firstFit = true;
    function fit() {
      if (!term || !container) return;
      var w = container.clientWidth, h = container.clientHeight;
      if (w <= 0 || h <= 0) return;
      var cols = Math.max(40, Math.floor(w / 7.6));
      var rows = Math.max(10, Math.floor(h / 18));
      try {
        term.resize(cols, rows);
        if (vscode) { vscode.postMessage({ type: 'size', cols: cols, rows: rows }); }
        if (_firstFit) { _firstFit = false; term.reset(); flushBuf(); if (vscode) { vscode.postMessage({ type: 'ready' }); vscode.postMessage({ type: 'requestSidebarSections' }); } }
      } catch(ex) {}
    }
    new ResizeObserver(function() { fit(); }).observe(container);
    setTimeout(fit, 50); setTimeout(fit, 200); setTimeout(fit, 500); setTimeout(fit, 1000);

    // ── Diff Overlay ──────────────────────────────────────────────────────────
    var diffOverlay = document.getElementById('diff-overlay');
    var diffBody = document.getElementById('diff-body');
    var diffFilename = document.getElementById('diff-filename');
    var diffBadge = document.getElementById('diff-badge');
    var diffStats = document.getElementById('diff-stats');
    var diffRevertBtn = document.getElementById('diff-revert-btn');
    var diffCloseBtn = document.getElementById('diff-close-btn');
    var _curChangeId = null;

    if (diffCloseBtn) { diffCloseBtn.addEventListener('click', function() { if (diffOverlay) { diffOverlay.classList.remove('visible'); } _curChangeId = null; if (term) { term.focus(); } }); }
    if (diffRevertBtn) {
      diffRevertBtn.addEventListener('click', function() {
        if (_curChangeId && vscode) { vscode.postMessage({ type: 'revertChange', changeId: _curChangeId }); if (diffOverlay) { diffOverlay.classList.remove('visible'); } _curChangeId = null; }
      });
    }

    function computeDiff(before, after) {
      var a = before != null ? before.split('\\n') : [];
      var b = after != null ? after.split('\\n') : [];
      if (!a.length) { return b.map(function(l) { return { t: 'add', l: l }; }); }
      if (!b.length) { return a.map(function(l) { return { t: 'rm', l: l }; }); }
      if (a.length > 600 || b.length > 600) { return a.map(function(l){ return {t:'rm',l:l}; }).concat(b.map(function(l){ return {t:'add',l:l}; })); }
      var m = a.length, n = b.length;
      var dp = []; for (var i=0;i<=m;i++){ dp[i]=new Uint32Array(n+1); }
      for (var i=1;i<=m;i++) for (var j=1;j<=n;j++) dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1]+1 : Math.max(dp[i-1][j],dp[i][j-1]);
      var diff=[], ii=m, jj=n;
      while (ii>0||jj>0) {
        if (ii>0&&jj>0&&a[ii-1]===b[jj-1]) { diff.unshift({t:'eq',l:a[ii-1]}); ii--;jj--; }
        else if (jj>0&&(ii===0||dp[ii][jj-1]>=dp[ii-1][jj])) { diff.unshift({t:'add',l:b[jj-1]}); jj--; }
        else { diff.unshift({t:'rm',l:a[ii-1]}); ii--; }
      }
      return diff;
    }

    function _clearEl(el) { while (el.firstChild) { el.removeChild(el.firstChild); } }
    function _makeTd(cls, txt) { var td = document.createElement('td'); if (cls) { td.className = cls; } td.textContent = txt != null ? String(txt) : ''; return td; }

    function showDiff(data) {
      if (!diffOverlay || !diffBody || !diffFilename || !diffBadge || !diffStats) { return; }
      _curChangeId = data.changeId;
      diffFilename.textContent = (data.filePath||'').split('/').pop();
      diffBadge.textContent = data.changeType || 'edit';
      if (diffRevertBtn) { diffRevertBtn.style.display = data.changeId && data.changeId.indexOf('msg-') !== 0 ? '' : 'none'; }
      _clearEl(diffBody);
      if (!data.contentAfter && data.contentBefore === null) {
        var unavail = document.createElement('div'); unavail.id = 'diff-unavail';
        unavail.textContent = 'File content not available \u2014 this change was made in a previous session.';
        diffBody.appendChild(unavail); diffStats.textContent = ''; diffOverlay.classList.add('visible'); return;
      }
      var diff = computeDiff(data.contentBefore, data.contentAfter);
      var added=0, removed=0;
      for (var i=0;i<diff.length;i++) { if(diff[i].t==='add') added++; else if(diff[i].t==='rm') removed++; }
      diffStats.textContent = '+'+added+' \u2212'+removed;
      var CTX = 3, show = new Set();
      for (var i=0;i<diff.length;i++) if(diff[i].t!=='eq') for(var k=Math.max(0,i-CTX);k<=Math.min(diff.length-1,i+CTX);k++) show.add(k);
      var tbl = document.createElement('table'); tbl.className = 'diff-tbl';
      var tbody = document.createElement('tbody');
      if (!diff.length) {
        var tr = document.createElement('tr'); var td = document.createElement('td');
        td.colSpan = 4; td.style.cssText = 'color:#9d9d9d;padding:24px'; td.textContent = 'No changes detected';
        tr.appendChild(td); tbody.appendChild(tr);
      } else {
        var al=0, bl=0, prev=-1;
        for (var i=0;i<diff.length;i++) {
          var d=diff[i];
          if(d.t==='eq'){al++;bl++;} else if(d.t==='rm'){al++;} else {bl++;}
          if(!show.has(i)){prev=i;continue;}
          if(prev>=0&&i>prev+1) {
            var hunkTr = document.createElement('tr'); var hunkTd = document.createElement('td');
            hunkTd.colSpan = 4; hunkTd.className = 'diff-hunk';
            hunkTd.textContent = '@@ \u2026 '+(i-prev-1)+' unchanged lines \u2026 @@';
            hunkTr.appendChild(hunkTd); tbody.appendChild(hunkTr);
          }
          prev=i;
          var cls=d.t==='rm'?'diff-rm':d.t==='add'?'diff-add':'diff-eq';
          var sign=d.t==='rm'?'\u2212':d.t==='add'?'+':' ';
          var lA=d.t!=='add'?al:'', lB=d.t!=='rm'?bl:'';
          var tr = document.createElement('tr'); tr.className = cls;
          tr.appendChild(_makeTd('diff-ln', lA)); tr.appendChild(_makeTd('diff-ln', lB));
          tr.appendChild(_makeTd('diff-sign', sign)); tr.appendChild(_makeTd('diff-code', d.l));
          tbody.appendChild(tr);
        }
      }
      tbl.appendChild(tbody); diffBody.appendChild(tbl); diffBody.scrollTop=0; diffOverlay.classList.add('visible');
    }
  </script>
</body>
</html>`;
}

// ─── Xterm inline loader ──────────────────────────────────────────────────────

async function _readXtermInline(fileService: IFileService, appRoot: string): Promise<{ xtermJs: string; xtermCss: string }> {
	// appRoot is typically the 'out/' dir; xterm lives in the repo root's node_modules.
	// Try appRoot itself first, then strip the trailing path segment (dev case).
	const stripped = appRoot.replace(/[/\\][^/\\]+$/, '');
	for (const base of [appRoot, stripped, appRoot + '/..']) {
		const dir = `${base}/node_modules/@xterm/xterm`;
		try {
			const [jsFile, cssFile] = await Promise.all([
				fileService.readFile(URI.file(`${dir}/lib/xterm.js`)),
				fileService.readFile(URI.file(`${dir}/css/xterm.css`)),
			]);
			return { xtermJs: jsFile.value.toString(), xtermCss: cssFile.value.toString() };
		} catch { /* try next base */ }
	}
	throw new Error(`xterm.js not found; appRoot=${appRoot}`);
}

// ─── Open results ─────────────────────────────────────────────────────────────

export interface IOpenFloatingResult {
	terminal: WebviewTerminal;
	webviewInput: WebviewInput;
	setSidebarSections(sections: IPMSidebarSection[]): void;
	dispose(): void;
}

export interface IOpenTabResult {
	terminal: WebviewTerminal;
	webviewInput: WebviewInput;
	disposeShell(): void;
}

// ─── Mode 1: Floating window ──────────────────────────────────────────────────

export async function openPowerModeFloating(
	webviewWorkbenchService: IWebviewWorkbenchService,
	environmentService: INativeEnvironmentService,
	editorGroupsService: IEditorGroupsService,
	_workingDirectory: string,
	fileService: IFileService,
): Promise<IOpenFloatingResult> {
	const tabResult = await openPowerModeInTab(
		webviewWorkbenchService, environmentService, editorGroupsService,
		_workingDirectory, true, fileService,
	);
	return {
		terminal: tabResult.terminal,
		webviewInput: tabResult.webviewInput,
		setSidebarSections: (sections: IPMSidebarSection[]) => tabResult.terminal.setSidebarSections(sections),
		dispose: () => { tabResult.disposeShell(); tabResult.terminal.dispose(); },
	};
}

// ─── Mode 2: Editor tab ───────────────────────────────────────────────────────

export async function openPowerModeInTab(
	webviewWorkbenchService: IWebviewWorkbenchService,
	environmentService: INativeEnvironmentService,
	editorGroupsService: IEditorGroupsService,
	_workingDirectory: string,
	floatingWindow: boolean,
	fileService: IFileService,
): Promise<IOpenTabResult> {

	const { xtermJs, xtermCss } = await _readXtermInline(fileService, environmentService.appRoot);

	let group: ReturnType<IEditorGroupsService['getGroup']> | undefined;
	if (floatingWindow) {
		const auxPart = await editorGroupsService.createAuxiliaryEditorPart({ bounds: { width: 900, height: 680 } });
		auxPart.enforcePartOptions({ showTabs: 'none' });
		group = auxPart.activeGroup;
	}

	const webviewInput = webviewWorkbenchService.openWebview(
		{
			providedViewType: 'powerModeTerminal',
			title: 'Power Mode',
			options: { enableFindWidget: false, retainContextWhenHidden: true },
			contentOptions: { allowScripts: true, localResourceRoots: [] },
			extension: undefined,
		},
		'powerModeTerminal',
		'Power Mode',
		{ group, preserveFocus: false },
	);

	webviewInput.webview.setHtml(buildPowerModeWebviewHtml(xtermJs, xtermCss));

	const terminal = new WebviewTerminal(webviewInput.webview);
	_setActiveTerminal(terminal);
	webviewInput.onWillDispose(() => { if (_activeTerminal === terminal) { _setActiveTerminal(undefined); } });

	return { terminal, webviewInput, disposeShell: () => { } };
}
