/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *
 *  Licensed under the Business Source License 1.1 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at https://mariadb.com/bsl11
 *
 *  Change Date: 2029-07-14
 *  Change License: GNU Affero General Public License v3.0
 *
 *  Use of this software in production requires a commercial license from Neural Inverse Inc.
 *  Contact (code): github@neuralinverse.com | Contact (sales): sales@neuralinverse.com
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWebviewElement, IWebviewService } from '../../../webview/browser/webview.js';
import { getWindow } from '../../../../../base/browser/dom.js';
import { IGRCEngineService } from '../engine/services/grcEngineService.js';
import { ICheckResult } from '../engine/types/grcTypes.js';
import { IInvariantDefinition } from '../engine/types/invariantTypes.js';
import { InvariantConfigLoader } from '../engine/config/invariantConfigLoader.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';

export class FormalVerificationControl extends Disposable {

	private webviewElement: IWebviewElement;
	private readonly _invariantLoader: InvariantConfigLoader;

	constructor(
		private readonly container: HTMLElement,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IGRCEngineService private readonly grcEngine: IGRCEngineService,
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService
	) {
		super();

		this._invariantLoader = this._register(new InvariantConfigLoader(fileService, workspaceContextService));

		this.webviewElement = this.webviewService.createWebviewElement({
			title: 'Formal Verification',
			options: {
				enableFindWidget: true,
				tryRestoreScrollPosition: true,
				retainContextWhenHidden: true,
			},
			contentOptions: {
				allowScripts: true,
			},
			extension: undefined
		});

		this.webviewElement.mountTo(this.container, getWindow(this.container));
		this._register(this.webviewElement.onMessage(msg => this._handleMessage(msg.message)));
		this._register(this.grcEngine.onDidCheckComplete(() => this._updateView()));
		this._register(this.grcEngine.onDidRulesChange(() => this._updateView()));
		this._register(this._invariantLoader.onDidChange(() => this._updateView()));
		this._updateView();
	}

	private async _handleMessage(msg: any): Promise<void> {
		switch (msg.command) {
			case 'addInvariant':
				await this._invariantLoader.saveInvariant(msg.invariant as IInvariantDefinition);
				break;
			case 'deleteInvariant':
				await this._invariantLoader.deleteInvariant(msg.id);
				break;
			case 'toggleInvariant':
				await this._invariantLoader.toggleInvariant(msg.id, msg.enabled);
				break;
			case 'navigateToFile':
				// Delegate navigation — same pattern as checksManagerPart
				break;
		}
	}

	private _updateView(): void {
		const invariants = this._invariantLoader.getInvariants();
		const violations = this.grcEngine.getResultsForDomain('formal-verification');
		this.webviewElement.setHtml(this._getHtml(invariants, violations));
	}

	public layout(width: number, height: number): void {
		this.container.style.width = `${width}px`;
		this.container.style.height = `${height}px`;
	}

	public show(): void {
		this.container.style.display = 'block';
		this._updateView();
	}

	public hide(): void {
		this.container.style.display = 'none';
	}

	private _esc(t: string): string {
		return t ? t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') : '';
	}

	private _getHtml(invariants: IInvariantDefinition[], violations: ICheckResult[]): string {
		const invariantRows = invariants.map(inv => {
			const violationCount = violations.filter(v => v.ruleId === inv.id).length;
			const statusBadge = violationCount > 0
				? `<span class="badge badge-error">${violationCount} violation${violationCount > 1 ? 's' : ''}</span>`
				: '<span class="badge badge-ok">Passing</span>';
			const enabledCheck = inv.enabled !== false ? 'checked' : '';

			return `<tr>
				<td><input type="checkbox" ${enabledCheck} onchange="toggleInvariant('${this._esc(inv.id)}', this.checked)" /></td>
				<td class="mono">${this._esc(inv.id)}</td>
				<td>${this._esc(inv.name)}</td>
				<td class="mono">${this._esc(inv.expression)}</td>
				<td>${this._esc(inv.scope)}</td>
				<td>${this._esc(inv.severity)}</td>
				<td>${statusBadge}</td>
				<td><button class="btn-sm btn-danger" onclick="deleteInvariant('${this._esc(inv.id)}')">Delete</button></td>
			</tr>`;
		}).join('');

		const violationRows = violations.map(v => {
			const fileName = v.fileUri.path.split('/').pop() ?? v.fileUri.path;
			const traceHtml = (v.traceInfo ?? []).map(t =>
				`<div class="trace-step">Line ${t.line}: ${this._esc(t.label)}</div>`
			).join('');
			const confidenceBadge = v.aiConfidence
				? `<span class="badge badge-${v.aiConfidence}">${v.aiConfidence}</span>`
				: '';

			return `<div class="violation-card">
				<div class="violation-header">
					<span class="severity-${v.severity === 'error' ? 'error' : v.severity === 'warning' ? 'warn' : 'info'}">${this._esc(v.severity).toUpperCase()}</span>
					<span class="mono">${this._esc(v.ruleId)}</span>
					${confidenceBadge}
				</div>
				<div class="violation-message">${this._esc(v.message)}</div>
				<div class="violation-location">
					<a href="#" onclick="navigateToFile('${this._esc(v.fileUri.toString())}', ${v.line}, ${v.column}); return false;">${this._esc(fileName)}:${v.line}</a>
				</div>
				${v.codeSnippet ? `<pre class="code-snippet">${this._esc(v.codeSnippet)}</pre>` : ''}
				${traceHtml ? `<div class="trace-section"><strong>Trace:</strong>${traceHtml}</div>` : ''}
			</div>`;
		}).join('');

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
	body {
		font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
		background: var(--vscode-editor-background);
		color: var(--vscode-foreground);
		margin: 0; padding: 0;
		font-size: 13px;
	}
	.container { padding: 16px; overflow-y: auto; height: 100vh; box-sizing: border-box; }
	h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-sideBarTitle-foreground); margin: 16px 0 8px 0; }
	h2:first-child { margin-top: 0; }

	/* Metrics bar */
	.metrics { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
	.metric { padding: 12px 16px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; min-width: 120px; }
	.metric-value { font-size: 24px; font-weight: 700; font-family: var(--vscode-editor-font-family); }
	.metric-label { font-size: 11px; opacity: 0.7; margin-top: 2px; }
	.metric-ok .metric-value { color: #66bb6a; }
	.metric-error .metric-value { color: #ff5252; }
	.metric-warn .metric-value { color: #ff9800; }
	.metric-accent .metric-value { color: #e040fb; }

	/* Table */
	table { width: 100%; border-collapse: collapse; }
	th { text-align: left; font-size: 11px; text-transform: uppercase; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); opacity: 0.7; }
	td { padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.05)); }
	.mono { font-family: var(--vscode-editor-font-family); font-size: 12px; }

	/* Badges */
	.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
	.badge-ok { background: rgba(102,187,106,0.15); color: #66bb6a; }
	.badge-error { background: rgba(255,82,82,0.15); color: #ff5252; }
	.badge-high { background: rgba(255,82,82,0.15); color: #ff5252; }
	.badge-medium { background: rgba(255,152,0,0.15); color: #ff9800; }
	.badge-low { background: rgba(66,165,245,0.15); color: #42a5f5; }

	/* Buttons */
	.btn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 14px; cursor: pointer; font-size: 12px; border-radius: 2px; }
	.btn:hover { background: var(--vscode-button-hoverBackground); }
	.btn-sm { padding: 2px 8px; font-size: 11px; }
	.btn-danger { background: rgba(255,82,82,0.2); color: #ff5252; }
	.btn-danger:hover { background: rgba(255,82,82,0.35); }

	/* Violation cards */
	.violation-card { padding: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 8px; border-left: 3px solid #e040fb; }
	.violation-header { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
	.violation-message { margin-bottom: 4px; }
	.violation-location a { color: var(--vscode-textLink-foreground); text-decoration: none; font-family: var(--vscode-editor-font-family); font-size: 12px; }
	.violation-location a:hover { text-decoration: underline; }
	.severity-error { color: #ff5252; font-weight: 700; font-size: 11px; }
	.severity-warn { color: #ff9800; font-weight: 700; font-size: 11px; }
	.severity-info { color: #42a5f5; font-weight: 700; font-size: 11px; }
	.code-snippet { background: var(--vscode-textBlockQuote-background); padding: 8px; border-radius: 3px; font-size: 12px; overflow-x: auto; margin: 4px 0; }
	.trace-section { margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border); }
	.trace-step { padding: 2px 0 2px 12px; font-size: 12px; color: var(--vscode-descriptionForeground); border-left: 2px solid #e040fb; margin: 2px 0; }

	/* Add form */
	.add-form { background: var(--vscode-textBlockQuote-background); padding: 12px; border-radius: 4px; margin-bottom: 16px; display: none; }
	.add-form.visible { display: block; }
	.form-row { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; flex-wrap: wrap; }
	.form-row label { font-size: 12px; min-width: 80px; }
	.form-row input, .form-row select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; font-size: 12px; flex: 1; min-width: 120px; }

	.empty-state { padding: 24px; text-align: center; opacity: 0.6; }
</style>
</head>
<body>
<div class="container">
	<div class="metrics">
		<div class="metric metric-accent">
			<div class="metric-value">${invariants.length}</div>
			<div class="metric-label">Invariants Defined</div>
		</div>
		<div class="metric ${violations.length === 0 ? 'metric-ok' : 'metric-error'}">
			<div class="metric-value">${violations.length}</div>
			<div class="metric-label">Violations</div>
		</div>
		<div class="metric metric-ok">
			<div class="metric-value">${invariants.filter(i => {
				const v = violations.filter(vi => vi.ruleId === i.id);
				return v.length === 0 && i.enabled !== false;
			}).length}</div>
			<div class="metric-label">Passing</div>
		</div>
	</div>

	<div style="display:flex; gap:8px; margin-bottom:12px;">
		<button class="btn" onclick="toggleAddForm()">+ Add Invariant</button>
	</div>

	<div id="addForm" class="add-form">
		<div class="form-row">
			<label>ID:</label><input id="inv-id" type="text" placeholder="INV-001" />
			<label>Name:</label><input id="inv-name" type="text" placeholder="Non-negative balance" />
		</div>
		<div class="form-row">
			<label>Expression:</label><input id="inv-expr" type="text" placeholder="balance >= 0" />
		</div>
		<div class="form-row">
			<label>Scope:</label>
			<select id="inv-scope">
				<option value="always">always</option>
				<option value="before-call">before-call</option>
				<option value="after-call">after-call</option>
			</select>
			<label>Severity:</label>
			<select id="inv-severity">
				<option value="error">error</option>
				<option value="warning">warning</option>
				<option value="info">info</option>
			</select>
		</div>
		<div class="form-row">
			<label>Variables:</label><input id="inv-vars" type="text" placeholder="balance, count (comma separated)" />
		</div>
		<div class="form-row">
			<label>Target Calls:</label><input id="inv-calls" type="text" placeholder="accessResource, query (for before-call/after-call)" />
		</div>
		<div class="form-row">
			<button class="btn" onclick="submitInvariant()">Save Invariant</button>
			<button class="btn btn-sm" onclick="toggleAddForm()">Cancel</button>
		</div>
	</div>

	<h2>Invariant Definitions</h2>
	${invariants.length === 0
		? '<div class="empty-state">No invariants defined yet. Add one above or create <code>.inverse/invariants.json</code>.</div>'
		: `<table>
		<tr><th></th><th>ID</th><th>Name</th><th>Expression</th><th>Scope</th><th>Severity</th><th>Status</th><th></th></tr>
		${invariantRows}
	</table>`}

	<h2>Violations (${violations.length})</h2>
	${violations.length === 0
		? '<div class="empty-state">No invariant violations detected. All invariants are passing.</div>'
		: violationRows}
</div>

<script>
	const vscode = acquireVsCodeApi();

	function toggleAddForm() {
		document.getElementById('addForm').classList.toggle('visible');
	}

	function submitInvariant() {
		const id = document.getElementById('inv-id').value.trim();
		const name = document.getElementById('inv-name').value.trim();
		const expression = document.getElementById('inv-expr').value.trim();
		const scope = document.getElementById('inv-scope').value;
		const severity = document.getElementById('inv-severity').value;
		const varsRaw = document.getElementById('inv-vars').value.trim();
		const callsRaw = document.getElementById('inv-calls').value.trim();

		if (!id || !name || !expression) return;

		const invariant = {
			id, name, expression, scope, severity, enabled: true,
			variables: varsRaw ? varsRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined,
			targetCalls: callsRaw ? callsRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined
		};

		vscode.postMessage({ command: 'addInvariant', invariant });
		toggleAddForm();
	}

	function deleteInvariant(id) {
		vscode.postMessage({ command: 'deleteInvariant', id });
	}

	function toggleInvariant(id, enabled) {
		vscode.postMessage({ command: 'toggleInvariant', id, enabled });
	}

	function navigateToFile(uri, line, col) {
		vscode.postMessage({ command: 'navigateToFile', uri, line, col });
	}
</script>
</body>
</html>`;
	}
}
