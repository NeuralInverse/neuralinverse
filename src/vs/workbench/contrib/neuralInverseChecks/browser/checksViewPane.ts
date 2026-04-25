/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IMarkerService, MarkerSeverity, IMarker } from '../../../../platform/markers/common/markers.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IGRCEngineService } from './engine/services/grcEngineService.js';
import { IContractReasonService } from './engine/services/contractReasonService.js';
import { URI } from '../../../../base/common/uri.js';

const GRC_MARKER_OWNER = 'neuralInverse.grc';

// \u2500\u2500\u2500 Domain visual config \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
const DOMAIN_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
	'security':       { label: 'Security',       color: '#f44336', icon: '\u2694' },
	'compliance':     { label: 'Compliance',      color: '#9c27b0', icon: '\u2696' },
	'architecture':   { label: 'Architecture',    color: '#2196f3', icon: '\u2B21' },
	'data-integrity': { label: 'Data Integrity',  color: '#ff9800', icon: '\u25C8' },
	'fail-safe':      { label: 'Fail-Safe',       color: '#e91e63', icon: '\u2295' },
	'policy':         { label: 'Policy',          color: '#607d8b', icon: '\u2261' },
};

function domainConfig(domain: string): { label: string; color: string; icon: string } {
	return DOMAIN_CONFIG[domain] ?? { label: domain, color: '#78909c', icon: '\u25CF' };
}


// \u2500\u2500\u2500 ChecksViewPane \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class ChecksViewPane extends ViewPane {

	public static readonly ID = 'workbench.view.checks.pane';
	private _container: HTMLElement | undefined;
	private _activeDomainFilter: string | null = null;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IEditorService private readonly editorService: IEditorService,
		@IGRCEngineService private readonly grcEngine: IGRCEngineService,
		@IContractReasonService private readonly contractReasonService: IContractReasonService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		this._container = container;
		container.style.overflow = 'auto';
		container.style.userSelect = 'text';
		container.style.height = '100%';
		container.style.minHeight = '40px';

		try { super.renderBody(container); } catch (_) { /* best-effort */ }

		this._renderContent();

		this._register(this.markerService.onMarkerChanged(() => this._renderContent()));
		this._register(this.grcEngine.onDidRulesChange(() => this._renderContent()));
		this._register(this.grcEngine.onDidCheckComplete(() => this._renderContent()));
	}


	// \u2500\u2500\u2500 Main render \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _renderContent(): void {
		if (!this._container) return;
		const c = this._container;
		c.innerHTML = '';

		this._injectStyles(c);

		try {
			const allMarkers = this.markerService.read({ owner: GRC_MARKER_OWNER });
			const rulesCount = this.grcEngine.getRules().length;
			const isConfigured = rulesCount > 0;
			let aiEnabled = false;
			let aiAvailable = false;
			try { aiEnabled = this.contractReasonService.isEnabled; } catch (_) { /* service not ready */ }
			try { aiAvailable = this.contractReasonService.isAvailable; } catch (_) { /* service not ready */ }
			const allResults = this.grcEngine.getAllResults();
			const totalFiles = allResults.reduce<Set<string>>((s, r) => { s.add(r.fileUri.toString()); return s; }, new Set()).size;

			const panel = document.createElement('div');
			panel.className = 'ni-panel';
			c.appendChild(panel);

			this._renderHeader(panel, allMarkers, isConfigured);
			this._renderSummaryRow(panel, allMarkers);
			this._renderActionBar(panel, rulesCount, aiEnabled, aiAvailable, allResults.length, totalFiles);

			if (!isConfigured) {
				this._renderZeroState(panel);
				return;
			}

			if (allMarkers.length === 0) {
				this._renderAllClear(panel);
				return;
			}

			this._renderAnalysisCoverage(panel, allMarkers);
			this._renderDomainBar(panel, allMarkers);
			this._renderIssueList(panel, allMarkers);
		} catch (err) {
			const errDiv = document.createElement('div');
			errDiv.style.cssText = 'padding:16px;font-size:12px;color:#ef5350;font-family:monospace;white-space:pre-wrap;';
			errDiv.textContent = `Neural Inverse Checks \u2014 render error:\n${err instanceof Error ? err.message + '\n' + err.stack : String(err)}`;
			c.appendChild(errDiv);
		}
	}


	// \u2500\u2500\u2500 Action bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _renderActionBar(panel: HTMLElement, rulesCount: number, aiEnabled: boolean, aiAvailable: boolean, totalViolations: number, totalFiles: number): void {
		const bar = document.createElement('div');
		bar.className = 'ni-action-bar';

		// Scan button
		const scanBtn = document.createElement('button');
		scanBtn.className = 'ni-scan-btn';
		scanBtn.textContent = '\u27F3 Scan Workspace';
		scanBtn.title = 'Run static + AI analysis on all workspace files';
		scanBtn.addEventListener('click', () => {
			scanBtn.textContent = '\u27F3 Scanning\u2026';
			scanBtn.disabled = true;
			this.grcEngine.scanWorkspace().finally(() => {
				scanBtn.textContent = '\u27F3 Scan Workspace';
				scanBtn.disabled = false;
			});
		});
		bar.appendChild(scanBtn);

		// Stats row
		const stats = document.createElement('div');
		stats.className = 'ni-bar-stats';

		const rulesPill = document.createElement('span');
		rulesPill.className = 'ni-bar-pill';
		rulesPill.title = 'Active rules';
		rulesPill.innerHTML = `<span class="ni-pill-icon">\u2261</span>${rulesCount} rules`;
		stats.appendChild(rulesPill);

		if (totalFiles > 0) {
			const filesPill = document.createElement('span');
			filesPill.className = 'ni-bar-pill';
			filesPill.title = 'Files with results';
			filesPill.innerHTML = `<span class="ni-pill-icon">\u25C8</span>${totalFiles} files`;
			stats.appendChild(filesPill);
		}

		// AI status pill
		const aiPill = document.createElement('span');
		aiPill.className = `ni-bar-pill ${aiEnabled && aiAvailable ? 'ni-pill-ai-on' : 'ni-pill-ai-off'}`;
		aiPill.title = aiEnabled ? (aiAvailable ? 'AI analysis active' : 'AI enabled, no model configured') : 'AI analysis disabled';
		aiPill.innerHTML = `<span class="ni-pill-icon">\u25C6</span>AI ${aiEnabled && aiAvailable ? 'ON' : 'OFF'}`;
		stats.appendChild(aiPill);

		bar.appendChild(stats);
		panel.appendChild(bar);
	}


	// \u2500\u2500\u2500 Header \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _renderHeader(panel: HTMLElement, markers: IMarker[], isConfigured: boolean): void {
		const total = markers.length;
		let badgeClass: string;
		let badgeText: string;

		if (!isConfigured) {
			badgeClass = 'ni-badge-grey';
			badgeText = 'NOT CONFIGURED';
		} else if (total === 0) {
			badgeClass = 'ni-badge-ok';
			badgeText = 'ALL CLEAR';
		} else {
			const errors = markers.filter(m => m.severity === MarkerSeverity.Error).length;
			badgeClass = errors > 0 ? 'ni-badge-err' : 'ni-badge-warn';
			badgeText = `${total} ISSUE${total > 1 ? 'S' : ''}`;
		}

		const header = document.createElement('div');
		header.className = 'ni-header';
		header.innerHTML = `
			<div class="ni-header-left">
				<span class="ni-title">Neural Inverse Checks</span>
			</div>
			<span class="ni-badge ${badgeClass}">${this._esc(badgeText)}</span>
		`;
		panel.appendChild(header);
	}


	// \u2500\u2500\u2500 Summary row (E / W / I counts) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _renderSummaryRow(panel: HTMLElement, markers: IMarker[]): void {
		const errors   = markers.filter(m => m.severity === MarkerSeverity.Error).length;
		const warnings = markers.filter(m => m.severity === MarkerSeverity.Warning).length;
		const infos    = markers.filter(m => m.severity === MarkerSeverity.Info).length;

		const row = document.createElement('div');
		row.className = 'ni-summary-row';
		row.innerHTML = `
			<div class="ni-stat-pill ni-stat-err" title="Errors"><span class="ni-stat-icon">\u2716</span>${errors}</div>
			<div class="ni-stat-pill ni-stat-warn" title="Warnings"><span class="ni-stat-icon">\u26A0</span>${warnings}</div>
			<div class="ni-stat-pill ni-stat-info" title="Info"><span class="ni-stat-icon">\u2139</span>${infos}</div>
		`;
		panel.appendChild(row);
	}


	// \u2500\u2500\u2500 Analysis coverage strip \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _renderAnalysisCoverage(panel: HTMLElement, markers: IMarker[]): void {
		// Detect languages from file extensions
		const langSet = new Set<string>();
		for (const m of markers) {
			const ext = m.resource.path.split('.').pop()?.toLowerCase();
			if (ext) langSet.add(ext);
		}

		// Detect which check sources are present from marker source strings
		const hasAI = markers.some(m => m.source?.includes('[AI]'));
		const hasBreaking = markers.some(m => String(m.code ?? '').startsWith('BREAK-'));
		const hasStatic = markers.some(m => !m.source?.includes('[AI]') && !String(m.code ?? '').startsWith('BREAK-'));

		const langTags = Array.from(langSet).slice(0, 8).map(ext =>
			`<span class="ni-lang-tag">${this._esc(ext.toUpperCase())}</span>`
		).join('');

		const sourceTags = [
			hasStatic  ? `<span class="ni-src-tag ni-src-static" title="Deterministic pattern analysis">STATIC</span>` : '',
			hasAI      ? `<span class="ni-src-tag ni-src-ai" title="AI semantic reasoning">AI</span>` : '',
			hasBreaking ? `<span class="ni-src-tag ni-src-break" title="Breaking change detection">BREAK</span>` : '',
		].filter(Boolean).join('');

		const coverage = document.createElement('div');
		coverage.className = 'ni-coverage';
		coverage.innerHTML = `
			<div class="ni-coverage-row">
				<span class="ni-coverage-label">Languages</span>
				<div class="ni-tags">${langTags || '<span class="ni-tag-empty">none</span>'}</div>
			</div>
			<div class="ni-coverage-row">
				<span class="ni-coverage-label">Analysis</span>
				<div class="ni-tags">${sourceTags || '<span class="ni-tag-empty">none</span>'}</div>
			</div>
		`;
		panel.appendChild(coverage);
	}


	// \u2500\u2500\u2500 Domain filter bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _renderDomainBar(panel: HTMLElement, markers: IMarker[]): void {
		// Count by domain (inferred from marker source field)
		const domainCounts = new Map<string, number>();
		for (const m of markers) {
			const domain = this._getDomainFromMarker(m);
			domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
		}

		if (domainCounts.size === 0) return;

		const bar = document.createElement('div');
		bar.className = 'ni-domain-bar';

		// "All" chip
		const allChip = document.createElement('span');
		allChip.className = `ni-domain-chip ${this._activeDomainFilter === null ? 'ni-chip-active' : ''}`;
		allChip.textContent = `All (${markers.length})`;
		allChip.addEventListener('click', () => {
			this._activeDomainFilter = null;
			this._renderContent();
		});
		bar.appendChild(allChip);

		for (const [domain, count] of domainCounts) {
			const cfg = domainConfig(domain);
			const chip = document.createElement('span');
			chip.className = `ni-domain-chip ${this._activeDomainFilter === domain ? 'ni-chip-active' : ''}`;
			chip.style.setProperty('--chip-color', cfg.color);
			chip.innerHTML = `${this._esc(cfg.icon)} ${this._esc(cfg.label)} <span class="ni-chip-count">${count}</span>`;
			chip.addEventListener('click', () => {
				this._activeDomainFilter = this._activeDomainFilter === domain ? null : domain;
				this._renderContent();
			});
			bar.appendChild(chip);
		}

		panel.appendChild(bar);
	}


	// \u2500\u2500\u2500 Issue list \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _renderIssueList(panel: HTMLElement, allMarkers: IMarker[]): void {
		// Apply domain filter
		const markers = this._activeDomainFilter
			? allMarkers.filter(m => this._getDomainFromMarker(m) === this._activeDomainFilter)
			: allMarkers;

		if (markers.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'ni-empty';
			empty.textContent = 'No issues in this domain';
			panel.appendChild(empty);
			return;
		}

		// Sort: errors first, then warnings, then info; within each group sort by file
		const sorted = [...markers].sort((a, b) => {
			if (a.severity !== b.severity) return a.severity < b.severity ? -1 : 1; // Error(6) > Warning(4) > Info(2) in VS Code
			return a.resource.path.localeCompare(b.resource.path);
		});

		// Group by file
		const byFile = new Map<string, IMarker[]>();
		for (const m of sorted) {
			const key = m.resource.toString();
			if (!byFile.has(key)) byFile.set(key, []);
			byFile.get(key)!.push(m);
		}

		const list = document.createElement('div');
		list.className = 'ni-issue-list';
		panel.appendChild(list);

		for (const [, fileMarkers] of byFile) {
			const fileUri = fileMarkers[0].resource;
			const fileName = fileUri.path.split('/').pop() ?? fileUri.path;
			const dirPath = fileUri.path.replace(/\/[^/]+$/, '').split('/').slice(-2).join('/');

			// File group header
			const fileGroup = document.createElement('div');
			fileGroup.className = 'ni-file-group';
			list.appendChild(fileGroup);

			const errCount  = fileMarkers.filter(m => m.severity === MarkerSeverity.Error).length;
			const warnCount = fileMarkers.filter(m => m.severity === MarkerSeverity.Warning).length;

			const fileHeader = document.createElement('div');
			fileHeader.className = 'ni-file-header';
			fileHeader.innerHTML = `
				<span class="ni-file-name">${this._esc(fileName)}</span>
				<span class="ni-file-dir">${this._esc(dirPath)}</span>
				<span class="ni-file-counts">
					${errCount > 0  ? `<span class="ni-fc-err">${errCount}\u2716</span>` : ''}
					${warnCount > 0 ? `<span class="ni-fc-warn">${warnCount}\u26A0</span>` : ''}
				</span>
			`;

			const issuesContainer = document.createElement('div');
			issuesContainer.className = 'ni-issues-container';
			fileGroup.appendChild(fileHeader);
			fileGroup.appendChild(issuesContainer);

			// Collapse/expand
			let collapsed = false;
			fileHeader.addEventListener('click', () => {
				collapsed = !collapsed;
				issuesContainer.style.display = collapsed ? 'none' : '';
				fileHeader.classList.toggle('ni-collapsed', collapsed);
			});

			for (const m of fileMarkers) {
				const issueEl = this._makeIssueEl(m, fileUri, fileName);
				issuesContainer.appendChild(issueEl);
			}
		}
	}

	private _makeIssueEl(m: IMarker, fileUri: URI, fileName: string): HTMLElement {
		const isError = m.severity === MarkerSeverity.Error;
		const isWarn  = m.severity === MarkerSeverity.Warning;

		const sevClass = isError ? 'ni-sev-err' : isWarn ? 'ni-sev-warn' : 'ni-sev-info';
		const ruleId = String(m.code ?? '');
		const isAI       = m.source?.includes('[AI]') ?? false;
		const isBreaking = ruleId.startsWith('BREAK-');

		const el = document.createElement('div');
		el.className = `ni-issue ${sevClass}`;
		el.title = m.message;

		// Source badge
		let sourceBadge = '';
		if (isBreaking) {
			sourceBadge = `<span class="ni-issue-src ni-src-break" title="Breaking change">BREAK</span>`;
		} else if (isAI) {
			sourceBadge = `<span class="ni-issue-src ni-src-ai" title="AI analysis">AI</span>`;
		} else {
			sourceBadge = `<span class="ni-issue-src ni-src-static" title="Static analysis">STATIC</span>`;
		}

		// First line of message (before any \n\n)
		const shortMsg = m.message.split('\n')[0].replace(/^\[[\w-]+\]\s*/, '');

		el.innerHTML = `
			<div class="ni-issue-top">
				${ruleId ? `<span class="ni-issue-code">${this._esc(ruleId)}</span>` : ''}
				${sourceBadge}
				<span class="ni-issue-msg">${this._esc(shortMsg.substring(0, 100))}</span>
			</div>
			<div class="ni-issue-loc">${this._esc(fileName)}:${m.startLineNumber}</div>
		`;

		// Click \u2192 navigate to file:line
		el.addEventListener('click', (e) => {
			e.stopPropagation();
			this.editorService.openEditor({
				resource: fileUri,
				options: {
					selection: {
						startLineNumber: m.startLineNumber,
						startColumn: m.startColumn,
						endLineNumber: m.endLineNumber,
						endColumn: m.endColumn,
					},
					preserveFocus: false,
				}
			});
		});

		return el;
	}


	// \u2500\u2500\u2500 Zero state \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _renderZeroState(panel: HTMLElement): void {
		const z = document.createElement('div');
		z.className = 'ni-zero-state';
		z.innerHTML = `
			<div class="ni-zero-icon">\u25C8</div>
			<div class="ni-zero-title">No framework loaded</div>
			<div class="ni-zero-body">
				Import a compliance framework to activate GRC rule enforcement.
				Open the Checks Manager window (\u2318\u2325C) to import a framework JSON.
			</div>
			<div class="ni-zero-hints">
				<div class="ni-zero-hint">Place framework <code>.json</code> files in <code>.inverse/frameworks/</code></div>
				<div class="ni-zero-hint">Supports TypeScript, Python, Java, Go, Rust, C/C++ and more</div>
				<div class="ni-zero-hint">AI checks activate automatically when a Chat or Checks model is configured</div>
			</div>
		`;
		panel.appendChild(z);
	}

	private _renderAllClear(panel: HTMLElement): void {
		const ok = document.createElement('div');
		ok.className = 'ni-all-clear';
		ok.innerHTML = `
			<div class="ni-ok-icon">\u2713</div>
			<div class="ni-ok-title">All checks passed</div>
		`;
		panel.appendChild(ok);
	}


	// \u2500\u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _getDomainFromMarker(m: IMarker): string {
		// Source format: "Neural Inverse GRC [domain]" or "Neural Inverse GRC [AI] [domain]"
		const src = m.source ?? '';
		const match = src.match(/\[([^\]]+)\]\s*$/);
		if (match) {
			const last = match[1].toLowerCase();
			if (last !== 'ai') return last;
		}
		// Fallback: infer from rule ID prefix
		const code = String(m.code ?? '').toUpperCase();
		if (code.startsWith('SEC')) return 'security';
		if (code.startsWith('COMP') || code.startsWith('GRC')) return 'compliance';
		if (code.startsWith('ARC') || code.startsWith('BREAK')) return 'architecture';
		if (code.startsWith('DI')) return 'data-integrity';
		if (code.startsWith('FS')) return 'fail-safe';
		if (code.startsWith('POL')) return 'policy';
		return 'general';
	}

	private _esc(t: string): string {
		return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}


	// \u2500\u2500\u2500 Styles \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _injectStyles(container: HTMLElement): void {
		const style = document.createElement('style');
		style.textContent = `
/* \u2500\u2500 Layout \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.ni-panel {
	padding: 10px 12px 16px;
	font-family: var(--vscode-font-family);
	font-size: 12px;
	color: var(--vscode-foreground);
	min-height: 100%;
}

/* \u2500\u2500 Header \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.ni-header {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin-bottom: 10px;
}
.ni-title {
	font-size: 11px;
	font-weight: 700;
	letter-spacing: 0.4px;
	text-transform: uppercase;
	opacity: 0.7;
}
.ni-badge {
	font-size: 9px;
	font-weight: 800;
	letter-spacing: 0.8px;
	padding: 2px 7px;
	border-radius: 3px;
	text-transform: uppercase;
}
.ni-badge-ok   { background: #1b5e20; color: #a5d6a7; border: 1px solid #2e7d32; }
.ni-badge-err  { background: #b71c1c; color: #ef9a9a; border: 1px solid #c62828; }
.ni-badge-warn { background: #e65100; color: #ffcc80; border: 1px solid #ef6c00; }
.ni-badge-grey { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border: 1px solid var(--vscode-panel-border); }

/* \u2500\u2500 Action bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.ni-action-bar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	margin-bottom: 10px;
}
.ni-scan-btn {
	font-size: 10px;
	font-weight: 700;
	padding: 4px 10px;
	border-radius: 3px;
	border: 1px solid var(--vscode-button-background, #0e639c);
	background: var(--vscode-button-background, #0e639c);
	color: var(--vscode-button-foreground, #fff);
	cursor: pointer;
	letter-spacing: 0.2px;
	flex-shrink: 0;
}
.ni-scan-btn:hover:not(:disabled) { opacity: 0.9; }
.ni-scan-btn:disabled { opacity: 0.5; cursor: default; }
.ni-bar-stats { display: flex; gap: 6px; flex-wrap: wrap; }
.ni-bar-pill {
	display: inline-flex;
	align-items: center;
	gap: 3px;
	font-size: 9px;
	font-weight: 600;
	padding: 2px 6px;
	border-radius: 10px;
	border: 1px solid rgba(255,255,255,0.1);
	background: rgba(255,255,255,0.05);
	color: var(--vscode-foreground);
	opacity: 0.65;
}
.ni-pill-ai-on  { background: rgba(103,58,183,0.2); border-color: rgba(103,58,183,0.4); color: #ce93d8; opacity: 1; }
.ni-pill-ai-off { background: rgba(96,125,139,0.15); border-color: rgba(96,125,139,0.3); opacity: 0.5; }
.ni-pill-icon { font-size: 8px; }

/* \u2500\u2500 Summary row \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.ni-summary-row {
	display: flex;
	gap: 6px;
	margin-bottom: 10px;
}
.ni-stat-pill {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 3px 8px;
	border-radius: 12px;
	font-size: 11px;
	font-weight: 700;
	border: 1px solid transparent;
}
.ni-stat-icon { font-size: 9px; }
.ni-stat-err  { color: #ef9a9a; background: rgba(244,67,54,0.12); border-color: rgba(244,67,54,0.25); }
.ni-stat-warn { color: #ffcc80; background: rgba(255,152,0,0.12); border-color: rgba(255,152,0,0.25); }
.ni-stat-info { color: #90caf9; background: rgba(33,150,243,0.12); border-color: rgba(33,150,243,0.25); }

/* \u2500\u2500 Analysis coverage \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.ni-coverage {
	background: var(--vscode-sideBar-background, rgba(0,0,0,0.15));
	border: 1px solid var(--vscode-panel-border);
	border-radius: 4px;
	padding: 7px 10px;
	margin-bottom: 10px;
}
.ni-coverage-row {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-bottom: 4px;
}
.ni-coverage-row:last-child { margin-bottom: 0; }
.ni-coverage-label {
	font-size: 9px;
	text-transform: uppercase;
	letter-spacing: 0.4px;
	opacity: 0.5;
	width: 56px;
	flex-shrink: 0;
}
.ni-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.ni-lang-tag {
	font-size: 9px;
	font-weight: 700;
	font-family: var(--vscode-editor-font-family, monospace);
	padding: 1px 5px;
	border-radius: 2px;
	background: rgba(255,255,255,0.08);
	border: 1px solid rgba(255,255,255,0.12);
}
.ni-tag-empty { font-size: 9px; opacity: 0.4; font-style: italic; }
.ni-src-tag {
	font-size: 9px;
	font-weight: 800;
	padding: 1px 6px;
	border-radius: 2px;
	letter-spacing: 0.3px;
}
.ni-src-static { background: rgba(96,125,139,0.25); color: #b0bec5; border: 1px solid rgba(96,125,139,0.4); }
.ni-src-ai     { background: rgba(103,58,183,0.25); color: #ce93d8; border: 1px solid rgba(103,58,183,0.45); }
.ni-src-break  { background: rgba(244,67,54,0.2);   color: #ef9a9a; border: 1px solid rgba(244,67,54,0.4); }

/* \u2500\u2500 Domain filter bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.ni-domain-bar {
	display: flex;
	flex-wrap: wrap;
	gap: 5px;
	margin-bottom: 10px;
}
.ni-domain-chip {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	font-size: 10px;
	font-weight: 600;
	padding: 3px 8px;
	border-radius: 12px;
	cursor: pointer;
	border: 1px solid var(--vscode-panel-border);
	background: var(--vscode-editor-background);
	color: var(--vscode-foreground);
	opacity: 0.7;
	transition: opacity 0.1s, background 0.1s;
}
.ni-domain-chip:hover { opacity: 1; background: rgba(255,255,255,0.06); }
.ni-chip-active {
	opacity: 1;
	background: rgba(var(--chip-color, 120,144,156), 0.15) !important;
	border-color: color-mix(in srgb, var(--chip-color, #78909c) 70%, transparent) !important;
	color: var(--chip-color, #78909c) !important;
}
.ni-chip-count {
	background: rgba(255,255,255,0.1);
	border-radius: 8px;
	padding: 0 4px;
	font-size: 9px;
}

/* \u2500\u2500 Issue list \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.ni-issue-list { display: flex; flex-direction: column; gap: 6px; }

.ni-file-group {
	border: 1px solid var(--vscode-panel-border);
	border-radius: 4px;
	overflow: hidden;
}
.ni-file-header {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 5px 8px;
	background: var(--vscode-sideBar-background, rgba(0,0,0,0.15));
	cursor: pointer;
	user-select: none;
	font-size: 11px;
}
.ni-file-header:hover { background: rgba(255,255,255,0.05); }
.ni-file-name { font-weight: 700; }
.ni-file-dir  { font-size: 10px; opacity: 0.45; font-family: var(--vscode-editor-font-family, monospace); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ni-file-counts { display: flex; gap: 5px; margin-left: auto; flex-shrink: 0; }
.ni-fc-err  { color: #ef9a9a; font-size: 10px; font-weight: 700; }
.ni-fc-warn { color: #ffcc80; font-size: 10px; font-weight: 700; }

.ni-issues-container { display: flex; flex-direction: column; }

.ni-issue {
	display: flex;
	flex-direction: column;
	gap: 2px;
	padding: 5px 8px 5px 10px;
	border-left: 3px solid transparent;
	cursor: pointer;
	font-size: 11px;
	line-height: 1.4;
	transition: background 0.1s;
}
.ni-issue:hover { background: rgba(255,255,255,0.04); }
.ni-issue + .ni-issue { border-top: 1px solid var(--vscode-panel-border); }
.ni-sev-err  { border-left-color: #ef5350; }
.ni-sev-warn { border-left-color: #ffa726; }
.ni-sev-info { border-left-color: #42a5f5; }

.ni-issue-top { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.ni-issue-code {
	font-size: 9px;
	font-weight: 700;
	font-family: var(--vscode-editor-font-family, monospace);
	padding: 1px 5px;
	border-radius: 2px;
	background: rgba(255,255,255,0.07);
	color: var(--vscode-foreground);
	flex-shrink: 0;
}
.ni-issue-src {
	font-size: 8px;
	font-weight: 800;
	padding: 1px 4px;
	border-radius: 2px;
	letter-spacing: 0.2px;
	flex-shrink: 0;
}
.ni-issue-msg {
	font-size: 11px;
	color: var(--vscode-foreground);
	opacity: 0.85;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.ni-issue-loc {
	font-size: 9px;
	font-family: var(--vscode-editor-font-family, monospace);
	color: var(--vscode-textLink-foreground, #4fc3f7);
	opacity: 0.7;
	padding-left: 1px;
}
.ni-issue:hover .ni-issue-loc { opacity: 1; text-decoration: underline; }

/* \u2500\u2500 Zero state \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.ni-zero-state {
	padding: 20px 12px;
	text-align: center;
}
.ni-zero-icon  { font-size: 28px; opacity: 0.3; margin-bottom: 10px; }
.ni-zero-title { font-size: 13px; font-weight: 700; margin-bottom: 8px; }
.ni-zero-body  { font-size: 11px; opacity: 0.6; line-height: 1.6; margin-bottom: 14px; }
.ni-zero-hints { display: flex; flex-direction: column; gap: 6px; text-align: left; }
.ni-zero-hint {
	font-size: 10px;
	padding: 6px 10px;
	border-radius: 4px;
	border: 1px solid var(--vscode-panel-border);
	background: var(--vscode-sideBar-background);
	opacity: 0.7;
	line-height: 1.5;
}
.ni-zero-hint code {
	font-family: var(--vscode-editor-font-family, monospace);
	background: rgba(255,255,255,0.1);
	padding: 1px 4px;
	border-radius: 2px;
}

/* \u2500\u2500 All clear \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.ni-all-clear { text-align: center; padding: 28px 12px; }
.ni-ok-icon   { font-size: 28px; color: #66bb6a; margin-bottom: 8px; }
.ni-ok-title  { font-size: 12px; color: #66bb6a; font-weight: 700; }

/* \u2500\u2500 Empty filter \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */
.ni-empty { text-align: center; padding: 16px; opacity: 0.45; font-size: 11px; font-style: italic; }
		`;
		container.appendChild(style);
	}
}
