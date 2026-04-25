/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
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
import { IFormalVerificationService } from '../engine/services/formalVerificationService.js';
import { IFVSession, IFVPreset, INVARIANT_PRESET_TEMPLATES } from '../engine/services/formalVerificationTypes.js';

type FVTab = 'invariants' | 'tools' | 'obligations' | 'presets';

const TOOL_KIND_LABELS: Record<string, string> = {
	'cbmc':          'CBMC',
	'frama-c':       'Frama-C',
	'spark-ada':     'GNATprove (SPARK)',
	'dafny':         'Dafny',
	'tlaplus':       'TLA+',
	'alloy':         'Alloy',
	'z3':            'Z3 (SMT)',
	'spin':          'Spin / Promela',
	'coq':           'Coq',
	'isabelle':      'Isabelle/HOL',
	'why3':          'Why3',
	'polyspace-cp':  'Polyspace Code Prover',
	'custom':        'Custom',
};

const TOOL_KIND_COLORS: Record<string, string> = {
	'cbmc':          '#4fc1ff',
	'frama-c':       '#73c991',
	'spark-ada':     '#dcdcaa',
	'dafny':         '#ce9178',
	'tlaplus':       '#c586c0',
	'alloy':         '#569cd6',
	'z3':            '#4ec9b0',
	'spin':          '#e0a84e',
	'coq':           '#b5cea8',
	'isabelle':      '#9cdcfe',
	'why3':          '#d7ba7d',
	'polyspace-cp':  '#f14c4c',
	'custom':        '#858585',
};

const OBLIGATION_STATUS_COLORS: Record<string, string> = {
	'proved':  '#73c991',
	'failed':  '#f14c4c',
	'unknown': '#e0a84e',
	'timeout': '#c586c0',
	'error':   '#f14c4c',
};

export class FormalVerificationControl extends Disposable {

	private readonly webviewElement: IWebviewElement;
	private readonly _invariantLoader: InvariantConfigLoader;
	private _tab: FVTab = 'invariants';
	private _fvSessions: IFVSession[] = [];
	private _interactionLocked = false;
	private _interactionTimer: ReturnType<typeof setTimeout> | undefined;
	private static readonly INTERACTION_LOCK_MS = 8000;

	constructor(
		private readonly container: HTMLElement,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IGRCEngineService private readonly grcEngine: IGRCEngineService,
		@IFileService fileService: IFileService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
		@IFormalVerificationService private readonly fvService: IFormalVerificationService,
	) {
		super();

		this._invariantLoader = this._register(new InvariantConfigLoader(fileService, workspaceContextService));

		this.webviewElement = this.webviewService.createWebviewElement({
			title: 'Formal Verification',
			options: { enableFindWidget: true, tryRestoreScrollPosition: true, retainContextWhenHidden: true },
			contentOptions: { allowScripts: true },
			extension: undefined,
		});

		this.webviewElement.mountTo(this.container, getWindow(this.container));
		this._register(this.webviewElement.onMessage(msg => this._handleMessage(msg.message)));
		this._register(this.grcEngine.onDidCheckComplete(() => this._refresh()));
		this._register(this.grcEngine.onDidRulesChange(() => this._refresh()));
		this._register(this._invariantLoader.onDidChange(() => this._refresh()));
		this._register(this.fvService.onDidSessionUpdate(session => {
			// Patch session snapshot and send targeted update (no full re-render)
			const idx = this._fvSessions.findIndex(s => s.config.id === session.config.id);
			if (idx >= 0) { this._fvSessions[idx] = { ...session }; } else { this._fvSessions.push({ ...session }); }
			this.webviewElement.postMessage({ type: 'fvSessionUpdate', session });
		}));

		this._fvSessions = this.fvService.getSessions();
		this._refresh();
	}

	private _touchInteractionLock(): void {
		this._interactionLocked = true;
		if (this._interactionTimer !== undefined) { clearTimeout(this._interactionTimer); }
		this._interactionTimer = setTimeout(() => { this._interactionLocked = false; }, FormalVerificationControl.INTERACTION_LOCK_MS);
	}

	private _refresh(): void {
		if (this._interactionLocked) { return; }
		const invariants = this._invariantLoader.getInvariants();
		const violations = this.grcEngine.getResultsForDomain('formal-verification');
		this._fvSessions = this.fvService.getSessions();
		this.webviewElement.setHtml(this._getHtml(invariants, violations));
	}

	private async _handleMessage(msg: any): Promise<void> {
		switch (msg.command ?? msg.type) {
			// ── Interaction lock ───────────────────────────────────────────────
			case 'webviewInteraction':
				this._touchInteractionLock();
				break;
			// ── Tab switching ─────────────────────────────────────────────────
			case 'switchFVTab':
				this._tab = msg.tab as FVTab;
				this._refresh();
				break;
			// ── Invariant management ───────────────────────────────────────────
			case 'addInvariant':
				await this._invariantLoader.saveInvariant(msg.invariant as IInvariantDefinition);
				break;
			case 'deleteInvariant':
				await this._invariantLoader.deleteInvariant(msg.id);
				break;
			case 'toggleInvariant':
				await this._invariantLoader.toggleInvariant(msg.id, msg.enabled);
				break;
			case 'applyInvariantTemplate': {
				const tmpl = INVARIANT_PRESET_TEMPLATES.find(t => t.id === msg.templateId);
				if (tmpl) {
					const inv: IInvariantDefinition = {
						id: `INV-${String(Date.now()).slice(-6)}`,
						name: tmpl.name,
						expression: tmpl.expression ?? '',
						scope: tmpl.scope as any,
						severity: tmpl.severity,
						enabled: true,
						variables: tmpl.variables,
						targetCalls: tmpl.targetCalls,
						trackedClass: tmpl.trackedClass,
						acquirePattern: tmpl.acquirePattern,
						releasePattern: tmpl.releasePattern,
						stateVariable: tmpl.stateVariable,
						validTransitions: tmpl.validTransitions,
						precedesCall: tmpl.precedesCall,
						backend: tmpl.backend,
					};
					await this._invariantLoader.saveInvariant(inv);
				}
				break;
			}
			case 'navigateToFile':
				break;
			// ── FV tool sessions ───────────────────────────────────────────────
			case 'createFVSession':
				await this.fvService.createSession(msg.config);
				this._refresh();
				break;
			case 'runFVSession':
				this.fvService.runSession(msg.sessionId).catch(e => console.error('[FVControl] run failed:', e));
				break;
			case 'stopFVSession':
				this.fvService.stopSession(msg.sessionId);
				break;
			case 'deleteFVSession':
				this.fvService.deleteSession(msg.sessionId);
				this._refresh();
				break;
			case 'cloneFVSession': {
				await this.fvService.cloneSession(msg.sessionId, msg.newName);
				this._refresh();
				break;
			}
			case 'createSessionFromPreset': {
				await this.fvService.createSessionFromPreset(msg.preset as IFVPreset);
				this._tab = 'tools';
				this._refresh();
				break;
			}
		}
	}

	public layout(width: number, height: number): void {
		this.container.style.width = `${width}px`;
		this.container.style.height = `${height}px`;
	}

	public show(): void {
		this.container.style.display = 'block';
		this._refresh();
	}

	public hide(): void {
		this.container.style.display = 'none';
	}

	private _esc(t: string | undefined | null): string {
		if (!t) { return ''; }
		return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	private _jsesc(s: string): string {
		return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
	}

	// ─── HTML ─────────────────────────────────────────────────────────────────

	private _getHtml(invariants: IInvariantDefinition[], violations: ICheckResult[]): string {
		const tab = this._tab;
		const sessions = this._fvSessions;
		const presets = this.fvService.getPresets();

		// ── Stats ──────────────────────────────────────────────────────────────
		const totalInvariants = invariants.length;
		const passingInvariants = invariants.filter(i => i.enabled !== false && violations.filter(v => v.ruleId === i.id).length === 0).length;
		const totalObligations = sessions.reduce((n, s) => n + s.proofObligations.length, 0);
		const provedCount = sessions.reduce((n, s) => n + s.proofObligations.filter(o => o.status === 'proved').length, 0);
		const failedCount = sessions.reduce((n, s) => n + s.proofObligations.filter(o => o.status === 'failed').length, 0);
		const runningSessions = sessions.filter(s => s.status === 'running').length;

		// ── Invariants tab ─────────────────────────────────────────────────────
		const invariantRows = invariants.map(inv => {
			const vc = violations.filter(v => v.ruleId === inv.id).length;
			const statusBadge = !inv.enabled
				? `<span style="background:#55555522;color:#858585;padding:1px 7px;border-radius:10px;font-size:10px">Disabled</span>`
				: vc > 0
					? `<span style="background:#f14c4c22;color:#f14c4c;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:600">${vc} violation${vc > 1 ? 's' : ''}</span>`
					: `<span style="background:#73c99122;color:#73c991;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:600">Passing</span>`;
			return `<tr style="border-bottom:1px solid var(--vscode-panel-border)">
				<td style="padding:5px 8px"><input type="checkbox" ${inv.enabled !== false ? 'checked' : ''} onchange="toggle('${this._esc(inv.id)}',this.checked)"></td>
				<td style="padding:5px 8px;font-family:monospace;font-size:11px">${this._esc(inv.id)}</td>
				<td style="padding:5px 8px;font-size:12px;font-weight:600">${this._esc(inv.name)}</td>
				<td style="padding:5px 8px;font-family:monospace;font-size:11px;opacity:.7">${this._esc(inv.expression || inv.acquirePattern ? `${inv.acquirePattern ?? ''} \u2192 ${inv.releasePattern ?? ''}` : inv.stateVariable ?? '')}</td>
				<td style="padding:5px 8px"><span style="background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);padding:1px 6px;border-radius:3px;font-size:10px">${this._esc(inv.scope)}</span></td>
				<td style="padding:5px 8px">${statusBadge}</td>
				<td style="padding:5px 8px;text-align:right"><button data-inv-id="${this._esc(inv.id)}" onclick="delInv(this.dataset.invId)" style="background:#f14c4c22;color:#f14c4c;border:1px solid #f14c4c55;padding:1px 8px;border-radius:3px;cursor:pointer;font-size:10px">Delete</button></td>
			</tr>`;
		}).join('');

		// Invariant template categories
		const templateCategories = [...new Set(INVARIANT_PRESET_TEMPLATES.map(t => t.category))];
		const templateMap: Record<string, string> = {};
		for (const t of INVARIANT_PRESET_TEMPLATES) { templateMap[t.id] = JSON.stringify({ id: t.id, name: t.name }); }
		const templateSections = templateCategories.map(cat => {
			const tmpls = INVARIANT_PRESET_TEMPLATES.filter(t => t.category === cat);
			const items = tmpls.map(t => `<div style="padding:6px 10px;border-radius:4px;background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);cursor:pointer" onclick="applyTemplate('${this._jsesc(t.id)}')" title="${this._esc(t.description)}">
				<div style="font-size:11px;font-weight:600">${this._esc(t.name)}</div>
				<div style="font-size:10px;opacity:.5;margin-top:2px">${this._esc(t.description.slice(0, 60))}${t.description.length > 60 ? '…' : ''}</div>
			</div>`).join('');
			return `<div style="margin-bottom:12px">
				<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;opacity:.4;margin-bottom:6px">${this._esc(cat)}</div>
				<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px">${items}</div>
			</div>`;
		}).join('');

		// Violation detail cards for invariant violations
		const violationCards = violations.slice(0, 30).map(v => {
			const fileName = v.fileUri.path.split('/').pop() ?? v.fileUri.path;
			return `<div style="padding:10px 12px;border:1px solid var(--vscode-panel-border);border-radius:4px;border-left:3px solid #e040fb;margin-bottom:6px">
				<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px">
					<span style="font-size:10px;font-weight:700;color:#f14c4c">${this._esc(v.severity?.toUpperCase() ?? 'ERROR')}</span>
					<span style="font-family:monospace;font-size:11px;opacity:.6">${this._esc(v.ruleId)}</span>
				</div>
				<div style="font-size:12px">${this._esc(v.message)}</div>
				<div style="font-size:11px;font-family:monospace;opacity:.5;margin-top:3px">${this._esc(fileName)}:${v.line}</div>
				${v.codeSnippet ? `<pre style="margin:4px 0;padding:6px;background:#0d1117;border-radius:3px;font-size:11px;overflow-x:auto">${this._esc(v.codeSnippet)}</pre>` : ''}
			</div>`;
		}).join('');

		// ── FV Tool Sessions tab ───────────────────────────────────────────────
		const toolKindOptions = Object.entries(TOOL_KIND_LABELS)
			.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

		const sessionCards = sessions.length === 0
			? `<div style="text-align:center;padding:60px 20px;opacity:.4;font-size:12px">
				<div style="font-size:28px;margin-bottom:10px">⊢</div>
				No FV sessions yet — create one above or pick a preset from the Presets tab.
			   </div>`
			: sessions.map(s => {
				const isActive = s.status === 'running';
				const kColor = TOOL_KIND_COLORS[s.config.kind] ?? '#858585';
				const proved = s.proofObligations.filter(o => o.status === 'proved').length;
				const failed = s.proofObligations.filter(o => o.status === 'failed').length;
				const unknown = s.proofObligations.filter(o => o.status === 'unknown' || o.status === 'timeout').length;
				const dur = (s.startedAt && s.completedAt)
					? `${((s.completedAt - s.startedAt) / 1000).toFixed(1)}s` : isActive ? 'running…' : '—';

				const oblRows = s.proofObligations.slice(0, 40).map(o => {
					const sColor = OBLIGATION_STATUS_COLORS[o.status] ?? '#9cdcfe';
					return `<tr style="border-bottom:1px solid var(--vscode-panel-border)">
						<td style="padding:3px 8px"><span style="background:${sColor}22;color:${sColor};padding:1px 5px;border-radius:3px;font-size:10px;font-weight:600">${o.status}</span></td>
						<td style="padding:3px 8px"><span style="background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);padding:1px 5px;border-radius:3px;font-size:10px">${this._esc(o.kind)}</span></td>
						<td style="padding:3px 8px;font-size:11px;font-family:monospace;opacity:.6">${o.file ? this._esc(o.file.split('/').pop()!) + (o.line ? ':' + o.line : '') : '—'}</td>
						<td style="padding:3px 8px;font-size:11px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this._esc(o.message)}">${this._esc(o.message.slice(0, 90))}</td>
					</tr>`;
				}).join('');

				return `<div style="background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-left:3px solid ${kColor};border-radius:6px;margin-bottom:12px;overflow:hidden">
					<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border)">
						<div style="display:flex;align-items:center;gap:8px;min-width:0">
							<span style="font-weight:600;font-size:12px">${this._esc(s.config.name)}</span>
							<span style="font-size:10px;background:${kColor}22;color:${kColor};padding:1px 6px;border-radius:3px;flex-shrink:0;border:1px solid ${kColor}44">${this._esc(TOOL_KIND_LABELS[s.config.kind] ?? s.config.kind)}</span>
							<span style="font-size:11px;color:${s.status === 'complete' ? '#73c991' : s.status === 'failed' ? '#f14c4c' : s.status === 'running' ? '#4fc1ff' : '#858585'}">${s.status}</span>
						</div>
						<div style="display:flex;gap:6px;flex-shrink:0">
							${isActive
								? `<button onclick="stopFV('${this._jsesc(s.config.id)}')" style="background:#e0a84e22;color:#e0a84e;border:1px solid #e0a84e55;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px">⏹ Stop</button>`
								: `<button onclick="runFV('${this._jsesc(s.config.id)}')" style="background:#73c99122;color:#73c991;border:1px solid #73c99155;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px">▶ Run</button>`}
							<button onclick="deleteFV('${this._jsesc(s.config.id)}')" style="background:#f14c4c22;color:#f14c4c;border:1px solid #f14c4c55;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px">✕</button>
						</div>
					</div>
					<div style="display:flex;gap:18px;padding:7px 14px;font-size:11px;opacity:.6;border-bottom:1px solid var(--vscode-panel-border);font-family:monospace;flex-wrap:wrap">
						<span>⏱ ${dur}</span>
						${proved > 0 ? `<span style="color:#73c991">✓ ${proved} proved</span>` : ''}
						${failed > 0 ? `<span style="color:#f14c4c">✗ ${failed} failed</span>` : ''}
						${unknown > 0 ? `<span style="color:#e0a84e">? ${unknown} unknown</span>` : ''}
						${s.injectedCount ? `<span style="color:#e0a84e">⊘ ${s.injectedCount} injected into GRC</span>` : ''}
					</div>
					${s.proofObligations.length > 0 ? `
					<details open>
						<summary style="padding:7px 14px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;opacity:.5;cursor:pointer;list-style:none">▸ Proof Obligations (${s.proofObligations.length})</summary>
						<div style="overflow-x:auto">
							<table style="width:100%;border-collapse:collapse">
								<thead><tr style="font-size:10px;opacity:.4;text-transform:uppercase">
									<th style="text-align:left;padding:3px 8px">Status</th>
									<th style="text-align:left;padding:3px 8px">Kind</th>
									<th style="text-align:left;padding:3px 8px">Location</th>
									<th style="text-align:left;padding:3px 8px">Message</th>
								</tr></thead>
								<tbody>${oblRows}</tbody>
							</table>
							${s.proofObligations.length > 40 ? `<div style="padding:5px 14px;font-size:10px;opacity:.4">…and ${s.proofObligations.length - 40} more</div>` : ''}
						</div>
					</details>` : ''}
					${s.outputLines.length > 0 ? `
					<details>
						<summary style="padding:7px 14px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;opacity:.5;cursor:pointer;list-style:none">▸ Output (last ${Math.min(s.outputLines.length, 20)} lines)</summary>
						<pre style="margin:0;padding:10px 14px;font-family:monospace;font-size:11px;background:#0d1117;color:#c9d1d9;border-top:1px solid var(--vscode-panel-border);max-height:200px;overflow-y:auto;white-space:pre-wrap;word-break:break-all">${this._esc(s.outputLines.slice(-20).join('\n'))}</pre>
					</details>` : ''}
					${s.error ? `<div style="padding:7px 14px;color:#f14c4c;font-size:11px;border-top:1px solid #f14c4c44;background:#f14c4c11">⚠ ${this._esc(s.error)}</div>` : ''}
				</div>`;
			}).join('');

		// ── Proof Obligations aggregated tab ───────────────────────────────────
		const allObligations = sessions.flatMap(s => s.proofObligations);
		const oblsByStatus = {
			proved:  allObligations.filter(o => o.status === 'proved'),
			failed:  allObligations.filter(o => o.status === 'failed'),
			unknown: allObligations.filter(o => o.status === 'unknown' || o.status === 'timeout'),
			error:   allObligations.filter(o => o.status === 'error'),
		};
		const obligationsTabHtml = allObligations.length === 0
			? `<div style="text-align:center;padding:60px 20px;opacity:.4;font-size:12px"><div style="font-size:28px;margin-bottom:10px">✓</div>No proof obligations yet — run a FV tool session to generate them.</div>`
			: Object.entries(oblsByStatus).filter(([, arr]) => arr.length > 0).map(([status, obls]) => {
				const sColor = OBLIGATION_STATUS_COLORS[status] ?? '#9cdcfe';
				const rows = obls.slice(0, 50).map(o => `<tr style="border-bottom:1px solid var(--vscode-panel-border)">
					<td style="padding:4px 8px;font-family:monospace;font-size:10px;opacity:.5">${this._esc(o.tool)}</td>
					<td style="padding:4px 8px"><span style="background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);padding:1px 5px;border-radius:3px;font-size:10px">${this._esc(o.kind)}</span></td>
					<td style="padding:4px 8px;font-size:11px;font-family:monospace;opacity:.6">${o.file ? this._esc(o.file.split('/').pop()!) + (o.line ? ':' + o.line : '') : '—'}</td>
					<td style="padding:4px 8px;font-size:11px;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this._esc(o.message)}">${this._esc(o.message.slice(0, 100))}</td>
				</tr>`).join('');
				return `<div style="margin-bottom:16px">
					<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
						<span style="background:${sColor}22;color:${sColor};padding:2px 10px;border-radius:10px;font-size:11px;font-weight:700">${status.toUpperCase()}</span>
						<span style="font-size:12px;font-weight:600">${obls.length} obligation${obls.length > 1 ? 's' : ''}</span>
					</div>
					<div style="overflow-x:auto">
						<table style="width:100%;border-collapse:collapse">
							<thead><tr style="font-size:10px;opacity:.4;text-transform:uppercase">
								<th style="text-align:left;padding:3px 8px">Tool</th>
								<th style="text-align:left;padding:3px 8px">Kind</th>
								<th style="text-align:left;padding:3px 8px">Location</th>
								<th style="text-align:left;padding:3px 8px">Message</th>
							</tr></thead>
							<tbody>${rows}</tbody>
						</table>
					</div>
				</div>`;
			}).join('');

		// ── Presets tab ────────────────────────────────────────────────────────
		const sectors = [...new Set(presets.map(p => p.sector))];
		const presetSectorTabs = ['All', ...sectors].map(s =>
			`<button class="fv-sector-tab${s === 'All' ? ' active' : ''}" onclick="switchSector(this,'${this._jsesc(s)}')" data-sector="${this._esc(s)}" style="padding:3px 12px;border-radius:20px;border:1px solid var(--vscode-panel-border);background:${s === 'All' ? 'var(--vscode-button-background)' : 'transparent'};color:${s === 'All' ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)'};cursor:pointer;font-size:11px;font-weight:600;white-space:nowrap">${this._esc(s)}</button>`
		).join('');

		// Build PRESET_MAP for JS (safe — all values go through JSON.stringify and are embedded in a JS var)
		const presetMapJs = presets.map(p => `'${this._jsesc(p.id)}':${JSON.stringify({ id: p.id, name: p.name, kind: p.kind, verifyCommand: p.verifyCommand, buildCommand: p.buildCommand ?? '', timeoutMs: p.timeoutMs, tags: p.tags, description: p.description, env: p.env ?? {} })}`).join(',');

		const presetCards = presets.map(p => {
			const kColor = TOOL_KIND_COLORS[p.kind] ?? '#858585';
			const tagBadges = p.tags.slice(0, 3).map(t => `<span style="background:${kColor}22;color:${kColor};padding:1px 5px;border-radius:3px;font-size:9px;border:1px solid ${kColor}33">${this._esc(t)}</span>`).join('');
			const searchText = `${p.name} ${p.targetLanguage} ${p.description} ${p.tags.join(' ')} ${p.kind} ${p.sector}`.toLowerCase();
			return `<div class="fv-preset-card" data-sector="${this._esc(p.sector)}" data-search-text="${this._esc(searchText)}" style="background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px;display:flex;flex-direction:column;gap:6px;transition:border-color .15s" onmouseenter="this.style.borderColor='${kColor}88'" onmouseleave="this.style.borderColor='var(--vscode-panel-border)'">
				<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
					<div style="min-width:0">
						<div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${this._esc(p.name)}</div>
						<div style="font-size:10px;opacity:.5;margin-top:2px">${this._esc(p.targetLanguage)}</div>
					</div>
					<span style="background:${kColor}22;color:${kColor};padding:1px 7px;border-radius:3px;font-size:10px;flex-shrink:0;border:1px solid ${kColor}44">${this._esc(TOOL_KIND_LABELS[p.kind] ?? p.kind)}</span>
				</div>
				<div style="font-size:11px;opacity:.6;line-height:1.4">${this._esc(p.description)}</div>
				<div style="display:flex;flex-wrap:wrap;gap:4px">${tagBadges}</div>
				<div style="font-size:10px;font-family:monospace;opacity:.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this._esc(p.verifyCommand)}">${this._esc(p.verifyCommand.slice(0, 70))}${p.verifyCommand.length > 70 ? '…' : ''}</div>
				<button data-preset-id="${this._esc(p.id)}" onclick="addPreset(this.dataset.presetId)" style="background:${kColor}22;color:${kColor};border:1px solid ${kColor}55;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;margin-top:2px;align-self:flex-start">+ Add Session</button>
			</div>`;
		}).join('');

		return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
* { box-sizing:border-box; }
body { margin:0; padding:16px 20px; font-family:var(--vscode-font-family,'Segoe UI',sans-serif); font-size:13px; color:var(--vscode-foreground); background:var(--vscode-editor-background); }
input,select,textarea { background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border,#555); border-radius:4px; padding:5px 8px; font-family:inherit; font-size:12px; width:100%; }
input:focus,select:focus,textarea:focus { outline:1px solid var(--vscode-focusBorder); }
label { display:block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;opacity:.5;margin-bottom:3px;margin-top:10px; }
.tab-btn { padding:5px 16px;border-radius:4px 4px 0 0;border:1px solid var(--vscode-panel-border);border-bottom:none;background:transparent;color:var(--vscode-foreground);cursor:pointer;font-size:12px;font-weight:600;opacity:.5; }
.tab-btn.active { background:var(--vscode-editor-background);opacity:1;border-bottom:1px solid var(--vscode-editor-background); }
.stat-card { background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px 16px;text-align:center; }
.presets-grid { display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-top:12px; }
details summary::-webkit-details-marker { display:none; }
details > summary { cursor:pointer;user-select:none; }
</style>
</head>
<body>

<!-- Header -->
<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px">
	<div>
		<div style="font-size:16px;font-weight:700;letter-spacing:.3px">Formal Verification</div>
		<div style="font-size:11px;opacity:.45;margin-top:2px">CBMC · Frama-C · GNATprove · Dafny · TLA+ · Alloy · Z3 · Spin · Coq · Isabelle · Why3 · Polyspace CP</div>
	</div>
	<div style="display:flex;gap:8px">
		<button onclick="document.getElementById('fv-create-form').style.display=document.getElementById('fv-create-form').style.display==='none'?'block':'none'" style="background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600">+ New Session</button>
		<button onclick="document.getElementById('inv-add-form').style.display=document.getElementById('inv-add-form').style.display==='none'?'block':'none'" style="background:var(--vscode-button-secondaryBackground,#3a3a3a);color:var(--vscode-button-secondaryForeground,#ccc);border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600">+ Add Invariant</button>
	</div>
</div>

<!-- Stats bar -->
<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:16px">
	<div class="stat-card"><div style="font-size:18px;font-weight:700;color:#e040fb">${totalInvariants}</div><div style="font-size:10px;opacity:.5;margin-top:2px">Invariants</div></div>
	<div class="stat-card"><div style="font-size:18px;font-weight:700;color:#73c991">${passingInvariants}</div><div style="font-size:10px;opacity:.5;margin-top:2px">Passing</div></div>
	<div class="stat-card"><div style="font-size:18px;font-weight:700;${runningSessions > 0 ? 'color:#4fc1ff' : ''}">${sessions.length}</div><div style="font-size:10px;opacity:.5;margin-top:2px">FV Sessions</div></div>
	<div class="stat-card"><div style="font-size:18px;font-weight:700;color:#73c991">${provedCount}</div><div style="font-size:10px;opacity:.5;margin-top:2px">Proved</div></div>
	<div class="stat-card"><div style="font-size:18px;font-weight:700;${failedCount > 0 ? 'color:#f14c4c' : ''}">${failedCount}</div><div style="font-size:10px;opacity:.5;margin-top:2px">Failed</div></div>
</div>

<!-- New FV Session Form -->
<div id="fv-create-form" style="display:none;background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:16px;margin-bottom:16px">
	<div style="font-size:12px;font-weight:700;margin-bottom:12px;opacity:.8">New FV Tool Session</div>
	<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
		<div><label>Session Name</label><input id="fv-name" type="text" placeholder="e.g. CBMC memory safety — firmware" oninput="lock()" onfocus="lock()"></div>
		<div><label>Tool Kind</label><select id="fv-kind" onchange="lock()">${toolKindOptions}</select></div>
		<div><label>Timeout (ms)</label><input id="fv-timeout" type="number" value="180000" min="5000" max="3600000" oninput="lock()" onfocus="lock()"></div>
	</div>
	<label>Build Command <span style="font-weight:400;text-transform:none;opacity:.6">(optional)</span></label>
	<input id="fv-build" type="text" placeholder="make all" oninput="lock()" onfocus="lock()">
	<label>Verify Command <span style="font-weight:400;text-transform:none;opacity:.6">(\${workspace}, \${file} substituted)</span></label>
	<textarea id="fv-verify" rows="2" placeholder="cbmc \${workspace}/src --unwind 10 --bounds-check" oninput="lock()" onfocus="lock()"></textarea>
	<div style="display:flex;gap:8px;margin-top:12px">
		<button onclick="createSession()" style="background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600">Create Session</button>
		<button onclick="document.getElementById('fv-create-form').style.display='none'" style="background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border);padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px">Cancel</button>
	</div>
</div>

<!-- Add Invariant Form -->
<div id="inv-add-form" style="display:none;background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:16px;margin-bottom:16px">
	<div style="font-size:12px;font-weight:700;margin-bottom:10px;opacity:.8">New Invariant</div>
	<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
		<div><label>ID</label><input id="inv-id" type="text" placeholder="INV-001" oninput="lock()" onfocus="lock()"></div>
		<div><label>Name</label><input id="inv-name" type="text" placeholder="Non-negative balance" oninput="lock()" onfocus="lock()"></div>
		<div><label>Scope</label><select id="inv-scope" onchange="lock()">
			<option value="value">value — expression holds at every assignment</option>
			<option value="precondition">precondition — holds before targetCalls</option>
			<option value="postcondition">postcondition — holds after targetCalls</option>
			<option value="class-invariant">class-invariant — holds after every public method</option>
			<option value="resource-pair">resource-pair — acquire/release pairing</option>
			<option value="state-machine">state-machine — valid transitions only</option>
			<option value="temporal">temporal — precedesCall before targetCalls</option>
			<option value="loop-invariant">loop-invariant — holds at every iteration</option>
		</select></div>
		<div><label>Severity</label><select id="inv-sev" onchange="lock()">
			<option value="error">error</option>
			<option value="warning">warning</option>
			<option value="info">info</option>
		</select></div>
		<div style="grid-column:1/-1"><label>Expression <span style="font-weight:400;text-transform:none;opacity:.5">(balance >= 0 · ptr != null · state == 'READY')</span></label>
			<input id="inv-expr" type="text" placeholder="balance >= 0" oninput="lock()" onfocus="lock()"></div>
		<div><label>Variables <span style="font-weight:400;text-transform:none;opacity:.5">(comma-separated)</span></label>
			<input id="inv-vars" type="text" placeholder="balance, count" oninput="lock()" onfocus="lock()"></div>
		<div><label>Target Calls <span style="font-weight:400;text-transform:none;opacity:.5">(for pre/post/temporal)</span></label>
			<input id="inv-calls" type="text" placeholder="accessResource, write" oninput="lock()" onfocus="lock()"></div>
		<div><label>Acquire Pattern <span style="font-weight:400;text-transform:none;opacity:.5">(resource-pair)</span></label>
			<input id="inv-acq" type="text" placeholder="\\bmalloc\\s*\\(" oninput="lock()" onfocus="lock()"></div>
		<div><label>Release Pattern <span style="font-weight:400;text-transform:none;opacity:.5">(resource-pair)</span></label>
			<input id="inv-rel" type="text" placeholder="\\bfree\\s*\\(" oninput="lock()" onfocus="lock()"></div>
		<div><label>State Variable <span style="font-weight:400;text-transform:none;opacity:.5">(state-machine)</span></label>
			<input id="inv-stvar" type="text" placeholder="this.connectionState" oninput="lock()" onfocus="lock()"></div>
		<div><label>Precedes Call <span style="font-weight:400;text-transform:none;opacity:.5">(temporal)</span></label>
			<input id="inv-prec" type="text" placeholder="authenticate" oninput="lock()" onfocus="lock()"></div>
		<div><label>Backend</label><select id="inv-backend" onchange="lock()">
			<option value="auto">auto (all layers)</option>
			<option value="pattern">pattern only</option>
			<option value="ast">AST only (TS/JS)</option>
			<option value="ai">AI only</option>
		</select></div>
	</div>
	<div style="display:flex;gap:8px;margin-top:12px">
		<button onclick="submitInvariant()" style="background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600">Save Invariant</button>
		<button onclick="document.getElementById('inv-add-form').style.display='none'" style="background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border);padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px">Cancel</button>
	</div>
</div>

<!-- Tab bar -->
<div style="display:flex;gap:0;margin-bottom:0;border-bottom:1px solid var(--vscode-panel-border)">
	<button class="tab-btn${tab === 'invariants' ? ' active' : ''}" onclick="switchTab('invariants')">Invariants (${totalInvariants})</button>
	<button class="tab-btn${tab === 'tools' ? ' active' : ''}" onclick="switchTab('tools')">FV Tools (${sessions.length})</button>
	<button class="tab-btn${tab === 'obligations' ? ' active' : ''}" onclick="switchTab('obligations')">Proof Obligations (${totalObligations})</button>
	<button class="tab-btn${tab === 'presets' ? ' active' : ''}" onclick="switchTab('presets')">Presets (${presets.length})</button>
</div>

<!-- Invariants tab -->
<div id="tab-invariants" style="display:${tab === 'invariants' ? 'block' : 'none'};padding-top:14px">
	${invariants.length === 0
		? `<div style="text-align:center;padding:60px 20px;opacity:.4;font-size:12px"><div style="font-size:28px;margin-bottom:10px">⊢</div>No invariants defined yet. Add one above or create <code>.inverse/invariants.json</code>.</div>`
		: `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse">
			<thead><tr style="font-size:10px;opacity:.4;text-transform:uppercase">
				<th style="padding:4px 8px"></th>
				<th style="text-align:left;padding:4px 8px">ID</th>
				<th style="text-align:left;padding:4px 8px">Name</th>
				<th style="text-align:left;padding:4px 8px">Expression / Pattern</th>
				<th style="text-align:left;padding:4px 8px">Scope</th>
				<th style="text-align:left;padding:4px 8px">Status</th>
				<th style="padding:4px 8px"></th>
			</tr></thead>
			<tbody>${invariantRows}</tbody>
		</table></div>
		${violations.length > 0 ? `<div style="margin-top:16px"><div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;opacity:.4;margin-bottom:8px">Violation Details</div>${violationCards}</div>` : ''}`}

	<!-- Template library -->
	<div style="margin-top:20px">
		<details>
			<summary style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;opacity:.5;cursor:pointer;user-select:none;list-style:none;padding:4px 0">▸ Invariant Template Library (${INVARIANT_PRESET_TEMPLATES.length} templates)</summary>
			<div style="margin-top:10px">${templateSections}</div>
		</details>
	</div>
</div>

<!-- FV Tools tab -->
<div id="tab-tools" style="display:${tab === 'tools' ? 'block' : 'none'};padding-top:14px">
	${sessionCards}
</div>

<!-- Proof Obligations tab -->
<div id="tab-obligations" style="display:${tab === 'obligations' ? 'block' : 'none'};padding-top:14px">
	${obligationsTabHtml}
</div>

<!-- Presets tab -->
<div id="tab-presets" style="display:${tab === 'presets' ? 'block' : 'none'}">
	<div style="display:flex;flex-direction:column;gap:8px;padding:12px 0 8px">
		<input id="fv-preset-search" type="text" placeholder="Search presets by name, language, tag…" oninput="filterPresets()" style="max-width:400px">
		<div style="display:flex;flex-wrap:wrap;gap:6px">${presetSectorTabs}</div>
	</div>
	<div id="fv-preset-count" style="font-size:11px;opacity:.45;margin-bottom:8px">${presets.length} presets</div>
	<div class="presets-grid" id="fv-presets-grid">${presetCards}</div>
</div>

<script>
const vscode = acquireVsCodeApi();
function lock() { vscode.postMessage({ type: 'webviewInteraction' }); }

const PRESET_MAP = {${presetMapJs}};

function switchTab(tab) { vscode.postMessage({ command: 'switchFVTab', tab }); }

function createSession() {
	const name = document.getElementById('fv-name').value.trim();
	const kind = document.getElementById('fv-kind').value;
	const verifyCommand = document.getElementById('fv-verify').value.trim();
	const buildCommand = document.getElementById('fv-build').value.trim();
	const timeoutMs = parseInt(document.getElementById('fv-timeout').value) || 180000;
	if (!name) { alert('Session name is required'); return; }
	if (!verifyCommand) { alert('Verify command is required'); return; }
	vscode.postMessage({ type: 'createFVSession', config: { name, kind, verifyCommand, buildCommand: buildCommand || undefined, timeoutMs } });
	document.getElementById('fv-create-form').style.display = 'none';
}

function runFV(id) { vscode.postMessage({ type: 'runFVSession', sessionId: id }); }
function stopFV(id) { vscode.postMessage({ type: 'stopFVSession', sessionId: id }); }
function deleteFV(id) {
	if (!confirm('Delete this FV session?')) { return; }
	vscode.postMessage({ type: 'deleteFVSession', sessionId: id });
}

function toggle(id, enabled) { vscode.postMessage({ command: 'toggleInvariant', id, enabled }); }
function delInv(id) {
	if (!confirm('Delete invariant ' + id + '?')) { return; }
	vscode.postMessage({ command: 'deleteInvariant', id });
}
function applyTemplate(id) { vscode.postMessage({ command: 'applyInvariantTemplate', templateId: id }); }

function submitInvariant() {
	const id = document.getElementById('inv-id').value.trim();
	const name = document.getElementById('inv-name').value.trim();
	const scope = document.getElementById('inv-scope').value;
	const severity = document.getElementById('inv-sev').value;
	const backend = document.getElementById('inv-backend').value;
	if (!id || !name) { alert('ID and Name are required'); return; }
	const inv = {
		id, name, scope, severity, backend: backend === 'auto' ? undefined : backend, enabled: true,
		expression: document.getElementById('inv-expr').value.trim() || undefined,
		variables: document.getElementById('inv-vars').value.trim() ? document.getElementById('inv-vars').value.split(',').map(s=>s.trim()).filter(Boolean) : undefined,
		targetCalls: document.getElementById('inv-calls').value.trim() ? document.getElementById('inv-calls').value.split(',').map(s=>s.trim()).filter(Boolean) : undefined,
		acquirePattern: document.getElementById('inv-acq').value.trim() || undefined,
		releasePattern: document.getElementById('inv-rel').value.trim() || undefined,
		stateVariable: document.getElementById('inv-stvar').value.trim() || undefined,
		precedesCall: document.getElementById('inv-prec').value.trim() || undefined,
	};
	vscode.postMessage({ command: 'addInvariant', invariant: inv });
	document.getElementById('inv-add-form').style.display = 'none';
}

function addPreset(id) {
	const p = PRESET_MAP[id];
	if (p) { vscode.postMessage({ type: 'createSessionFromPreset', preset: p }); }
}

let _activeSector = 'All';
function switchSector(btn, sector) {
	_activeSector = sector;
	document.querySelectorAll('.fv-sector-tab').forEach(b => {
		b.style.background = 'transparent'; b.style.color = 'var(--vscode-foreground)'; b.classList.remove('active');
	});
	btn.style.background = 'var(--vscode-button-background)';
	btn.style.color = 'var(--vscode-button-foreground)';
	btn.classList.add('active');
	applyFilter();
}
function filterPresets() { applyFilter(); }
function applyFilter() {
	const q = (document.getElementById('fv-preset-search')?.value || '').toLowerCase();
	let visible = 0;
	document.querySelectorAll('.fv-preset-card').forEach(c => {
		const matchSector = _activeSector === 'All' || c.dataset.sector === _activeSector;
		const matchSearch = !q || c.dataset.searchText.includes(q);
		c.style.display = matchSector && matchSearch ? '' : 'none';
		if (matchSector && matchSearch) { visible++; }
	});
	const cnt = document.getElementById('fv-preset-count');
	if (cnt) { cnt.textContent = visible + ' preset' + (visible !== 1 ? 's' : ''); }
}

// Live FV session card updates — no full re-render
window.addEventListener('message', e => {
	const msg = e.data;
	if (msg.type !== 'fvSessionUpdate') { return; }
	// If on tools or obligations tab, trigger tab re-render on next unlock
	// For now: sessions are shown after next refresh — proof obligations update on status change
});
</script>
</body>
</html>`;
	}
}
