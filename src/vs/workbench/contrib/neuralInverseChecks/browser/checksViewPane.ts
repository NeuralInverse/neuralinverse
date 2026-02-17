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
import { IGRCEngineService } from './engine/grcEngineService.js';
import { GRCDomain, ICheckResult } from './engine/grcTypes.js';

export class ChecksViewPane extends ViewPane {

	public static readonly ID = 'workbench.view.checks.pane';

	private _container: HTMLElement | undefined;

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
		@IGRCEngineService private readonly grcEngine: IGRCEngineService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._container = container;
		container.style.overflow = 'auto';

		this._renderContent();

		this._register(this.grcEngine.onDidCheckComplete(() => this._renderContent()));
		this._register(this.grcEngine.onDidRulesChange(() => this._renderContent()));
	}

	private _renderContent(): void {
		if (!this._container) { return; }
		const c = this._container;
		c.innerHTML = '';

		const summary = this.grcEngine.getDomainSummary();
		const allResults = this.grcEngine.getAllResults();
		const totalErrors = summary.reduce((a, s) => a + s.errorCount, 0);
		const totalWarnings = summary.reduce((a, s) => a + s.warningCount, 0);
		const totalInfos = summary.reduce((a, s) => a + s.infoCount, 0);
		const totalIssues = totalErrors + totalWarnings + totalInfos;

		// ─── Styles ───
		const style = document.createElement('style');
		style.textContent = `
			.grc-panel { padding:12px 16px; font-family:var(--vscode-font-family); font-size:12px; color:var(--vscode-foreground); }
			.grc-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; }
			.grc-header h3 { margin:0; font-size:13px; font-weight:600; }
			.grc-badge { font-size:10px; font-weight:700; padding:2px 8px; border-radius:10px; }
			.grc-badge-ok { background:#4caf50; color:#000; }
			.grc-badge-issues { background:#ff5252; color:#fff; }
			.grc-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-bottom:14px; }
			.grc-stat { background:var(--vscode-sideBar-background); border:1px solid var(--vscode-panel-border); padding:8px; border-radius:4px; text-align:center; }
			.grc-stat-label { font-size:9px; opacity:0.6; text-transform:uppercase; letter-spacing:0.3px; }
			.grc-stat-val { font-size:20px; font-weight:700; margin-top:2px; }
			.grc-stat-val.err { color:#ff5252; } .grc-stat-val.warn { color:#ff9800; } .grc-stat-val.info { color:#64b5f6; }
			.grc-domain { margin-bottom:8px; }
			.grc-domain-header { display:flex; align-items:center; gap:8px; padding:6px 8px; cursor:pointer; border-radius:4px; user-select:none; }
			.grc-domain-header:hover { background:rgba(255,255,255,0.04); }
			.grc-domain-name { flex:1; font-weight:600; text-transform:capitalize; }
			.grc-domain-count { font-size:10px; font-weight:700; padding:1px 6px; border-radius:10px; }
			.grc-count-err { background:rgba(255,82,82,0.15); color:#ff5252; }
			.grc-count-warn { background:rgba(255,152,0,0.15); color:#ff9800; }
			.grc-count-ok { background:rgba(76,175,80,0.15); color:#4caf50; }
			.grc-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
			.grc-dot-security { background:#ff5252; } .grc-dot-compliance { background:#7c4dff; }
			.grc-dot-data-integrity { background:#00bcd4; } .grc-dot-fail-safe { background:#ff9800; }
			.grc-dot-architecture { background:#42a5f5; } .grc-dot-policy { background:#66bb6a; }
			.grc-issues { margin-left:16px; margin-bottom:4px; }
			.grc-issue { display:flex; align-items:flex-start; gap:6px; padding:4px 8px; font-size:11px; border-left:2px solid transparent; cursor:default; }
			.grc-issue:hover { background:rgba(255,255,255,0.03); }
			.grc-issue-err { border-left-color:#ff5252; } .grc-issue-warn { border-left-color:#ff9800; } .grc-issue-info { border-left-color:#64b5f6; }
			.grc-issue-msg { flex:1; line-height:1.4; }
			.grc-issue-file { font-size:10px; color:#888; font-family:monospace; }
			.grc-issue-sev { font-size:9px; font-weight:700; flex-shrink:0; }
			.grc-empty { text-align:center; padding:24px; opacity:0.5; font-size:12px; }
			.grc-sep { border:none; border-top:1px solid var(--vscode-panel-border); margin:10px 0; }
		`;
		c.appendChild(style);

		const panel = document.createElement('div');
		panel.className = 'grc-panel';
		c.appendChild(panel);

		// ─── Header ───
		const header = document.createElement('div');
		header.className = 'grc-header';
		header.innerHTML = `<h3>GRC Checks</h3><span class="grc-badge ${totalIssues === 0 ? 'grc-badge-ok' : 'grc-badge-issues'}">${totalIssues === 0 ? 'ALL CLEAR' : totalIssues + ' issue' + (totalIssues > 1 ? 's' : '')}</span>`;
		panel.appendChild(header);

		// ─── Stats ───
		const stats = document.createElement('div');
		stats.className = 'grc-stats';
		stats.innerHTML = `
			<div class="grc-stat"><div class="grc-stat-label">Errors</div><div class="grc-stat-val err">${totalErrors}</div></div>
			<div class="grc-stat"><div class="grc-stat-label">Warnings</div><div class="grc-stat-val warn">${totalWarnings}</div></div>
			<div class="grc-stat"><div class="grc-stat-label">Info</div><div class="grc-stat-val info">${totalInfos}</div></div>
		`;
		panel.appendChild(stats);

		// ─── Separator ───
		const sep = document.createElement('hr');
		sep.className = 'grc-sep';
		panel.appendChild(sep);

		// ─── Per-Domain Collapsible Sections ───
		const domains: GRCDomain[] = ['security', 'compliance', 'data-integrity', 'architecture', 'fail-safe', 'policy'];

		if (totalIssues === 0) {
			const empty = document.createElement('div');
			empty.className = 'grc-empty';
			empty.textContent = '✓ No GRC violations detected';
			panel.appendChild(empty);
		}

		for (const domain of domains) {
			const domainResults = allResults.filter(r => r.domain === domain);
			const domainErrors = domainResults.filter(r => r.severity === 'error').length;
			const domainTotal = domainResults.length;

			if (domainTotal === 0) { continue; }

			const section = document.createElement('div');
			section.className = 'grc-domain';
			panel.appendChild(section);

			const domainHeader = document.createElement('div');
			domainHeader.className = 'grc-domain-header';
			const countClass = domainErrors > 0 ? 'grc-count-err' : 'grc-count-warn';
			domainHeader.innerHTML = `
				<span class="grc-dot grc-dot-${domain}"></span>
				<span class="grc-domain-name">${domain}</span>
				<span class="grc-domain-count ${countClass}">${domainTotal}</span>
			`;
			section.appendChild(domainHeader);

			const issuesContainer = document.createElement('div');
			issuesContainer.className = 'grc-issues';
			issuesContainer.style.display = 'block';
			section.appendChild(issuesContainer);

			// Toggle collapse
			domainHeader.addEventListener('click', () => {
				issuesContainer.style.display = issuesContainer.style.display === 'none' ? 'block' : 'none';
			});

			for (const result of domainResults) {
				this._renderIssue(issuesContainer, result);
			}
		}
	}

	private _renderIssue(parent: HTMLElement, r: ICheckResult): void {
		const issue = document.createElement('div');
		const sevClass = r.severity === 'error' ? 'grc-issue-err' : r.severity === 'warning' ? 'grc-issue-warn' : 'grc-issue-info';
		issue.className = `grc-issue ${sevClass}`;

		const filePath = r.fileUri.path.split('/').pop() || r.fileUri.path;

		issue.innerHTML = `
			<span class="grc-issue-sev" style="color:${r.severity === 'error' ? '#ff5252' : r.severity === 'warning' ? '#ff9800' : '#64b5f6'}">${r.ruleId}</span>
			<span class="grc-issue-msg">${this._esc(r.message)}<br><span class="grc-issue-file">${this._esc(filePath)}:${r.line}</span></span>
		`;
		parent.appendChild(issue);
	}

	private _esc(t: string): string {
		return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}
}
