/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow } from '../../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { Part } from '../../../../browser/part.js';
import { IWebviewService, IWebviewElement } from '../../../webview/browser/webview.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IEnclaveFirewallService } from '../../common/services/firewall/enclaveFirewallService.js';
import { IEnclaveSandboxService } from '../../common/services/sandbox/enclaveSandboxService.js';
import { IEnclaveAuditTrailService } from '../../common/services/audit/enclaveAuditTrailService.js';
import { IEnclaveEnvironmentService } from '../../common/services/environment/enclaveEnvironmentService.js';
import { IEnclaveActionLogService } from '../services/actionLog/enclaveActionLogService.js';
import { IActionLogFilter, ActionCategory, ActionSource } from '../../common/services/actionLog/enclaveActionLogTypes.js';
import { IVerifyChainResult } from '../../common/services/audit/enclaveAuditTrailService.js';
import { mountSidebar } from '../../../void/browser/react/out/sidebar-tsx/index.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';

export class EnclaveManagerPart extends Part {

	static readonly ID = 'workbench.parts.enclaveManager';

	minimumWidth: number = 300;
	maximumWidth: number = Infinity;
	minimumHeight: number = 300;
	maximumHeight: number = Infinity;

	private webviewElement: IWebviewElement | undefined;
	private readonly disposables = new DisposableStore();
	private _currentView: 'manager' | 'audit' | 'actionlog' | 'chat' = 'manager';
	private _actionLogCategoryFilter: string = 'all';
	private _actionLogSourceFilter: string = 'all';

	/**
	 * Cached result of the most recent async chain verification.
	 * Updated every time a new audit entry is logged.
	 * Defaults to valid=true/'pending' so the UI doesn't flash red on startup.
	 */
	private _chainVerificationResult: IVerifyChainResult = { valid: true, entriesChecked: 0 };
	private _chainVerificationPending: boolean = false;

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IEnclaveFirewallService private readonly firewallService: IEnclaveFirewallService,
		@IEnclaveSandboxService private readonly sandboxService: IEnclaveSandboxService,
		@IEnclaveAuditTrailService private readonly auditTrailService: IEnclaveAuditTrailService,
		@IEnclaveEnvironmentService private readonly enclaveEnv: IEnclaveEnvironmentService,
		@IEnclaveActionLogService private readonly actionLogService: IEnclaveActionLogService
	) {
		super(EnclaveManagerPart.ID, { hasTitle: false }, themeService, storageService, layoutService);
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement | undefined {
		// Create main container
		const container = document.createElement('div');
		container.style.display = 'flex';
		container.style.flexDirection = 'column';
		container.style.width = '100%';
		container.style.height = '100%';
		container.style.overflow = 'hidden';
		parent.appendChild(container);

		// Header Container (Tabs style)
		const header = document.createElement('div');
		header.style.display = 'flex';
		header.style.alignItems = 'center';
		header.style.justifyContent = 'flex-start';
		header.style.height = '35px';
		header.style.minHeight = '35px';
		header.style.borderBottom = '1px solid var(--vscode-panel-border)';
		header.style.backgroundColor = 'var(--vscode-panel-background)';
		header.style.padding = '0 10px';
		container.appendChild(header);

		// Tabs Container
		const tabsContainer = document.createElement('div');
		tabsContainer.style.display = 'flex';
		tabsContainer.style.height = '100%';
		tabsContainer.style.flex = '1';
		header.appendChild(tabsContainer);

		const createTab = (text: string, onClick: () => void) => {
			const tab = document.createElement('div');
			tab.textContent = text;
			tab.style.padding = '0 10px';
			tab.style.cursor = 'pointer';
			tab.style.fontSize = '11px';
			tab.style.textTransform = 'uppercase';
			tab.style.display = 'flex';
			tab.style.alignItems = 'center';
			tab.style.height = '100%';
			tab.style.userSelect = 'none';
			tab.style.borderBottom = '1px solid transparent';
			tab.style.color = 'var(--vscode-panelTitle-inactiveForeground)';

			tab.addEventListener('click', onClick);
			return tab;
		};

		// Content Body container
		const body = document.createElement('div');
		body.style.flex = '1';
		body.style.position = 'relative';
		body.style.overflow = 'hidden';
		container.appendChild(body);

		// VIEW 1: Enclave Webview (Firewall + Sandbox)
		const enclaveContainer = document.createElement('div');
		enclaveContainer.style.width = '100%';
		enclaveContainer.style.height = '100%';
		body.appendChild(enclaveContainer);

		// VIEW 2: Audit Trail Webview
		const auditContainer = document.createElement('div');
		auditContainer.style.width = '100%';
		auditContainer.style.height = '100%';
		body.appendChild(auditContainer);

		// VIEW 3: Action Log Webview
		const actionLogContainer = document.createElement('div');
		actionLogContainer.style.width = '100%';
		actionLogContainer.style.height = '100%';
		body.appendChild(actionLogContainer);

		// VIEW 4: Void Sidebar (Shared Chat)
		const voidContainer = document.createElement('div');
		voidContainer.style.width = '100%';
		voidContainer.style.height = '100%';
		body.appendChild(voidContainer);


		// State Management

		const updateView = (view: 'manager' | 'audit' | 'actionlog' | 'chat') => {
			this._currentView = view;
			enclaveContainer.style.display = view === 'manager' ? 'block' : 'none';
			auditContainer.style.display = view === 'audit' ? 'block' : 'none';
			actionLogContainer.style.display = view === 'actionlog' ? 'block' : 'none';
			voidContainer.style.display = view === 'chat' ? 'block' : 'none';

			styleInactive(tabEnclave);
			styleInactive(tabAudit);
			styleInactive(tabActionLog);
			styleInactive(tabChat);

			if (view === 'manager') { styleActive(tabEnclave); }
			else if (view === 'audit') { styleActive(tabAudit); }
			else if (view === 'actionlog') { styleActive(tabActionLog); }
			else { styleActive(tabChat); }

			this.updateWebviewContent();
		};

		const styleActive = (el: HTMLElement) => {
			el.style.borderBottom = '1px solid var(--vscode-panelTitle-activeBorder)';
			el.style.color = 'var(--vscode-panelTitle-activeForeground)';
			el.style.fontWeight = 'normal';
		};

		const styleInactive = (el: HTMLElement) => {
			el.style.borderBottom = '1px solid transparent';
			el.style.color = 'var(--vscode-panelTitle-inactiveForeground)';
			el.style.fontWeight = 'normal';
		};

		const tabEnclave = createTab('Enclave', () => updateView('manager'));
		const tabAudit = createTab('Audit Trail', () => updateView('audit'));
		const tabActionLog = createTab('Action Log', () => updateView('actionlog'));
		const tabChat = createTab('Chat', () => updateView('chat'));

		tabsContainer.appendChild(tabEnclave);
		tabsContainer.appendChild(tabAudit);
		tabsContainer.appendChild(tabActionLog);
		tabsContainer.appendChild(tabChat);

		// Initialize view
		updateView('manager');

		// Create Enclave webview
		this.webviewElement = this.webviewService.createWebviewElement({
			title: 'Enclave Manager',
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

		this.webviewElement.mountTo(enclaveContainer, getWindow(enclaveContainer));

		// Create Audit Trail webview (separate)
		const auditWebview = this.webviewService.createWebviewElement({
			title: 'Audit Trail',
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
		auditWebview.mountTo(auditContainer, getWindow(auditContainer));
		this.disposables.add(auditWebview);

		// Store audit webview for updates
		(this as any)._auditWebview = auditWebview;

		// Create Action Log webview
		const actionLogWebview = this.webviewService.createWebviewElement({
			title: 'Action Log',
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
		actionLogWebview.mountTo(actionLogContainer, getWindow(actionLogContainer));
		this.disposables.add(actionLogWebview);

		// Handle messages from Action Log webview (filter changes)
		this.disposables.add(actionLogWebview.onMessage(e => {
			if (e.message?.type === 'filterChange') {
				this._actionLogCategoryFilter = e.message.category ?? 'all';
				this._actionLogSourceFilter = e.message.source ?? 'all';
				this.updateWebviewContent();
			}
		}));

		(this as any)._actionLogWebview = actionLogWebview;

		// Mount Void Sidebar
		// HACK: Override createElement to bypass "Not allowed to create elements in child window" error
		const auxDoc = parent.ownerDocument;
		let observer: MutationObserver | undefined;

		let intervalId: any;

		if (auxDoc && auxDoc !== document) {
			(auxDoc as any).createElement = function (tagName: string, options?: any) {
				return document.createElement(tagName, options);
			};

			// HACK: Mirror styles from main window to aux window (including dynamic ones)
			const mainHead = document.head;
			const auxHead = auxDoc.head;
			const mainBody = document.body;
			const auxBody = auxDoc.body;
			const mainHtml = document.documentElement;
			const auxHtml = auxDoc.documentElement;

			const copyAttributes = (src: HTMLElement, dest: HTMLElement) => {
				Array.from(src.attributes).forEach(attr => {
					dest.setAttribute(attr.name, attr.value);
				});
			};
			copyAttributes(mainHtml, auxHtml);
			copyAttributes(mainBody, auxBody);

			const attrObserver = new MutationObserver((mutations) => {
				mutations.forEach(m => {
					if (m.target === mainBody) copyAttributes(mainBody, auxBody);
					if (m.target === mainHtml) copyAttributes(mainHtml, auxHtml);
				});
			});
			attrObserver.observe(mainBody, { attributes: true });
			attrObserver.observe(mainHtml, { attributes: true });

			const copyNode = (node: Node) => {
				if (node instanceof HTMLElement) {
					if (node.tagName === 'LINK' && (node as HTMLLinkElement).rel === 'stylesheet') {
						const href = (node as HTMLLinkElement).href;
						if (Array.from(auxHead.querySelectorAll('link')).some(l => l.href === href)) return;
						const newLink = auxDoc.createElement('link');
						newLink.rel = 'stylesheet';
						newLink.href = href;
						auxHead.appendChild(newLink);
					} else if (node.tagName === 'STYLE') {
						const textContent = node.textContent;
						if (!textContent) return;
						if (Array.from(auxHead.querySelectorAll('style')).some(s => s.textContent === textContent)) return;

						const newStyle = auxDoc.createElement('style');
						newStyle.textContent = textContent;
						auxHead.appendChild(newStyle);
					}
				}
			};

			Array.from(mainHead.children).forEach(copyNode);

			observer = new MutationObserver((mutations) => {
				mutations.forEach((m) => {
					m.addedNodes.forEach(copyNode);
				});
			});
			observer.observe(mainHead, { childList: true, subtree: false });

			intervalId = setInterval(() => {
				copyAttributes(mainHtml, auxHtml);
				copyAttributes(mainBody, auxBody);
				Array.from(mainHead.children).forEach(copyNode);
			}, 1000);

			auxBody.style.fontFamily = 'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif)';
			auxBody.style.fontSize = 'var(--vscode-font-size, 13px)';
			auxBody.style.color = 'var(--vscode-foreground)';
		}

		this.instantiationService.invokeFunction(accessor => {
			try {
				const disposeFn = mountSidebar(voidContainer, accessor)?.dispose;
				this._register(toDisposable(() => {
					disposeFn?.();
					observer?.disconnect();
					clearInterval(intervalId);
				}));
			} catch (e) {
				console.error('EnclaveManagerPart: failed to mount sidebar', e);
			}
		});

		this.updateWebviewContent();

		// Listen to Enclave Services
		this._register(this.firewallService.onDidBlockRequest(() => this.updateWebviewContent()));
		this._register(this.sandboxService.onDidSandboxViolation(() => this.updateWebviewContent()));
		this._register(this.auditTrailService.onDidAddEntry(() => {
			// Re-run chain verification asynchronously, then refresh the UI
			if (!this._chainVerificationPending) {
				this._chainVerificationPending = true;
				this.auditTrailService.verifyChain().then(result => {
					this._chainVerificationResult = result;
					this._chainVerificationPending = false;
					this.updateWebviewContent();
				}).catch(err => {
					console.error('[EnclaveManagerPart] verifyChain failed:', err);
					this._chainVerificationPending = false;
					this.updateWebviewContent();
				});
			} else {
				// Verification already in-flight — just refresh the display without waiting
				this.updateWebviewContent();
			}
		}));
		this._register(this.enclaveEnv.onDidChangeMode(() => this.updateWebviewContent()));

		// Throttled action log updates (fires frequently — only update if tab is visible)
		let actionLogUpdateTimer: any;
		this._register(this.actionLogService.onDidLogAction(() => {
			if (this._currentView !== 'actionlog') { return; }
			if (actionLogUpdateTimer) { clearTimeout(actionLogUpdateTimer); }
			actionLogUpdateTimer = setTimeout(() => {
				actionLogUpdateTimer = undefined;
				this.updateWebviewContent();
			}, 500);
		}));

		return parent;
	}

	private updateWebviewContent(): void {
		if (this.webviewElement) {
			if (this._currentView === 'manager') {
				this.webviewElement.setHtml(this.getDashboardHtml());
			}
		}
		const auditWebview = (this as any)._auditWebview as IWebviewElement | undefined;
		if (auditWebview && this._currentView === 'audit') {
			auditWebview.setHtml(this.getAuditTrailHtml());
		}
		const actionLogWebview = (this as any)._actionLogWebview as IWebviewElement | undefined;
		if (actionLogWebview && this._currentView === 'actionlog') {
			actionLogWebview.setHtml(this.getActionLogHtml());
		}
	}

	private getDashboardHtml(): string {
		const mode = this.enclaveEnv.mode;
		const scannedCalls = this.firewallService.getScannedCount();
		const blockedCalls = this.firewallService.getBlockedCount();
		const flaggedCalls = this.firewallService.getFlaggedCount();
		const recentBlocks = this.firewallService.getRecentBlocks();
		const sandboxViolations = this.sandboxService.getRecentViolations();
		const sandboxActive = this.sandboxService.isEnforcing;
		const auditCount = this.auditTrailService.getEntryCount();

		// Mode badge color
		const modeColors: Record<string, string> = {
			draft: '#4fc1ff',
			dev: '#ffa500',
			prod: '#f14c4c'
		};
		const modeColor = modeColors[mode] || '#4fc1ff';
		const modeLabel = mode.toUpperCase();

		// Firewall table rows
		let firewallTableRows = '';
		if (recentBlocks.length > 0) {
			for (const b of recentBlocks.slice(0, 8)) {
				const timeStr = new Date(b.timestamp).toLocaleTimeString();
				const statusBadge = b.wasBlocked
					? '<span style="color: var(--vscode-errorForeground); font-weight: 600;">BLOCKED</span>'
					: '<span style="color: var(--vscode-charts-orange);">FLAGGED</span>';
				firewallTableRows += `
					<tr>
						<td style="padding: 4px 8px; font-family: monospace; font-size: 11px; color: var(--vscode-descriptionForeground);">${timeStr}</td>
						<td style="padding: 4px 8px;">${statusBadge}</td>
						<td style="padding: 4px 8px;">${b.reason}</td>
						<td style="padding: 4px 8px; font-family: monospace; font-size: 11px; opacity: 0.7;">${b.snippet}</td>
					</tr>`;
			}
		} else {
			firewallTableRows = `<tr><td colspan="4" style="padding: 12px 8px; color: var(--vscode-descriptionForeground); text-align: center;">No firewall events recorded yet.</td></tr>`;
		}

		// Sandbox table rows
		let sandboxTableRows = '';
		if (sandboxViolations.length > 0) {
			for (const v of sandboxViolations.slice(0, 8)) {
				const timeStr = new Date(v.timestamp).toLocaleTimeString();
				const typeBadge = `<span style="background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">${v.type}</span>`;
				const statusBadge = v.wasBlocked
					? '<span style="color: var(--vscode-errorForeground); font-weight: 600;">BLOCKED</span>'
					: '<span style="color: var(--vscode-charts-orange);">FLAGGED</span>';
				sandboxTableRows += `
					<tr>
						<td style="padding: 4px 8px; font-family: monospace; font-size: 11px; color: var(--vscode-descriptionForeground);">${timeStr}</td>
						<td style="padding: 4px 8px;">${typeBadge}</td>
						<td style="padding: 4px 8px;">${statusBadge}</td>
						<td style="padding: 4px 8px; font-size: 12px;">${v.details.substring(0, 120)}</td>
					</tr>`;
			}
		} else {
			sandboxTableRows = `<tr><td colspan="4" style="padding: 12px 8px; color: var(--vscode-descriptionForeground); text-align: center;">No sandbox violations recorded yet.</td></tr>`;
		}

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Enclave Control Center</title>
			<style>
				body {
					font-family: var(--vscode-font-family);
					font-size: var(--vscode-font-size);
					padding: 16px 20px;
					background-color: var(--vscode-editor-background);
					color: var(--vscode-editor-foreground);
					margin: 0;
				}
				.header-row {
					display: flex;
					align-items: center;
					gap: 16px;
					margin-bottom: 20px;
					padding-bottom: 12px;
					border-bottom: 1px solid var(--vscode-panel-border);
				}
				.header-title {
					font-size: 1.3em;
					font-weight: 500;
					flex: 1;
				}
				.mode-badge {
					display: inline-flex;
					align-items: center;
					gap: 6px;
					padding: 4px 12px;
					border-radius: 4px;
					font-size: 11px;
					font-weight: 700;
					letter-spacing: 1px;
					text-transform: uppercase;
				}
				.stat-row {
					display: flex;
					gap: 12px;
					margin-bottom: 20px;
				}
				.stat-box {
					background: rgba(255,255,255,0.03);
					border: 1px solid var(--vscode-widget-border);
					padding: 10px 14px;
					border-radius: 4px;
					min-width: 100px;
					flex: 1;
				}
				.stat-value {
					font-size: 1.6em;
					font-weight: 700;
					font-family: monospace;
				}
				.stat-label {
					font-size: 10px;
					text-transform: uppercase;
					letter-spacing: 0.5px;
					opacity: 0.6;
					margin-top: 4px;
				}
				.section {
					margin-bottom: 20px;
				}
				.section-header {
					font-size: 11px;
					text-transform: uppercase;
					letter-spacing: 1px;
					color: var(--vscode-descriptionForeground);
					margin-bottom: 8px;
					padding-bottom: 4px;
					border-bottom: 1px solid var(--vscode-panel-border);
				}
				table {
					width: 100%;
					border-collapse: collapse;
					font-size: 12px;
				}
				th {
					text-align: left;
					padding: 6px 8px;
					font-size: 10px;
					text-transform: uppercase;
					letter-spacing: 0.5px;
					color: var(--vscode-descriptionForeground);
					border-bottom: 1px solid var(--vscode-panel-border);
				}
				tr:hover {
					background: rgba(255,255,255,0.02);
				}
			</style>
		</head>
		<body>
			<div class="header-row">
				<div class="header-title">Enclave Control Center</div>
				<div class="mode-badge" style="background: ${modeColor}22; color: ${modeColor}; border: 1px solid ${modeColor}44;">
					● ${modeLabel}
				</div>
			</div>

			<div class="stat-row">
				<div class="stat-box">
					<div class="stat-value">${scannedCalls}</div>
					<div class="stat-label">Requests Scanned</div>
				</div>
				<div class="stat-box">
					<div class="stat-value" style="color: var(--vscode-errorForeground);">${blockedCalls}</div>
					<div class="stat-label">Blocked</div>
				</div>
				<div class="stat-box">
					<div class="stat-value" style="color: var(--vscode-charts-orange);">${flaggedCalls}</div>
					<div class="stat-label">Flagged</div>
				</div>
				<div class="stat-box">
					<div class="stat-value" style="color: ${sandboxActive ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-testing-iconFailed)'};">${sandboxActive ? 'ON' : 'OFF'}</div>
					<div class="stat-label">Sandbox</div>
				</div>
				<div class="stat-box">
					<div class="stat-value">${auditCount}</div>
					<div class="stat-label">Audit Entries</div>
				</div>
			</div>

			<div class="section">
				<div class="section-header">Context Firewall</div>
				<table>
					<thead><tr><th>Time</th><th>Status</th><th>Rule</th><th>Snippet</th></tr></thead>
					<tbody>${firewallTableRows}</tbody>
				</table>
			</div>

			<div class="section">
				<div class="section-header">Execution Sandbox</div>
				<table>
					<thead><tr><th>Time</th><th>Type</th><th>Status</th><th>Details</th></tr></thead>
					<tbody>${sandboxTableRows}</tbody>
				</table>
			</div>
		</body>
		</html>`;
	}

	private getAuditTrailHtml(): string {
		const mode = this.enclaveEnv.mode;
		const entries = this.auditTrailService.getRecentEntries(50);
		// Use the pre-computed cached verification result — verifyChain() is async
		// and is triggered on every new entry. See _chainVerificationResult field.
		const chainResult = this._chainVerificationResult;
		const chainVerifying = this._chainVerificationPending;

		const modeColors: Record<string, string> = {
			draft: '#4fc1ff',
			dev: '#ffa500',
			prod: '#f14c4c'
		};
		const modeColor = modeColors[mode] || '#4fc1ff';

		// Audit trail table rows
		let auditRows = '';
		if (entries.length > 0) {
			for (const e of entries.reverse().slice(0, 30)) {
				const timeStr = new Date(e.timestamp).toLocaleTimeString();
				const outcomeColor = e.outcome === 'allowed' ? 'var(--vscode-testing-iconPassed)' :
					e.outcome === 'blocked' ? 'var(--vscode-errorForeground)' : 'var(--vscode-charts-orange)';
				const hashShort = e.hash.substring(0, 8) + '…';
				auditRows += `
					<tr>
						<td style="padding: 4px 8px; font-family: monospace; font-size: 11px; color: var(--vscode-descriptionForeground);">${timeStr}</td>
						<td style="padding: 4px 8px;"><span style="background: rgba(255,255,255,0.05); padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; text-transform: uppercase;">${e.action}</span></td>
						<td style="padding: 4px 8px; font-size: 11px;">${e.actor}</td>
						<td style="padding: 4px 8px; font-weight: 600; color: ${outcomeColor};">${e.outcome.toUpperCase()}</td>
						<td style="padding: 4px 8px; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px;">${e.target}</td>
						<td style="padding: 4px 8px; font-family: monospace; font-size: 10px; opacity: 0.5;">${hashShort}</td>
					</tr>`;
			}
		} else {
			auditRows = `<tr><td colspan="6" style="padding: 20px 8px; color: var(--vscode-descriptionForeground); text-align: center;">No audit entries recorded yet. Entries will appear here as AI actions occur.</td></tr>`;
		}


		const chainBadge = chainVerifying
			? '<span style="color: var(--vscode-descriptionForeground); font-weight: 600;">◌ Verifying chain…</span>'
			: chainResult.valid
				? `<span style="color: var(--vscode-testing-iconPassed); font-weight: 600;">✓ Chain Valid (${chainResult.entriesChecked} entries verified)</span>`
				: `<span style="color: var(--vscode-errorForeground); font-weight: 600;">✗ Chain Broken at Entry ${chainResult.brokenAt ?? '?'} — ${chainResult.reason ?? 'Unknown reason'}</span>`;
		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Audit Trail</title>
			<style>
				body {
					font-family: var(--vscode-font-family);
					font-size: var(--vscode-font-size);
					padding: 16px 20px;
					background-color: var(--vscode-editor-background);
					color: var(--vscode-editor-foreground);
					margin: 0;
				}
				.header-row {
					display: flex;
					align-items: center;
					gap: 16px;
					margin-bottom: 16px;
					padding-bottom: 12px;
					border-bottom: 1px solid var(--vscode-panel-border);
				}
				.header-title {
					font-size: 1.3em;
					font-weight: 500;
					flex: 1;
				}
				.chain-badge {
					font-size: 12px;
				}
				.mode-badge {
					display: inline-flex;
					align-items: center;
					gap: 6px;
					padding: 4px 12px;
					border-radius: 4px;
					font-size: 11px;
					font-weight: 700;
					letter-spacing: 1px;
					text-transform: uppercase;
				}
				table {
					width: 100%;
					border-collapse: collapse;
					font-size: 12px;
				}
				th {
					text-align: left;
					padding: 6px 8px;
					font-size: 10px;
					text-transform: uppercase;
					letter-spacing: 0.5px;
					color: var(--vscode-descriptionForeground);
					border-bottom: 1px solid var(--vscode-panel-border);
					position: sticky;
					top: 0;
					background: var(--vscode-editor-background);
				}
				tr:hover {
					background: rgba(255,255,255,0.02);
				}
				.entries-count {
					font-size: 12px;
					color: var(--vscode-descriptionForeground);
					margin-bottom: 12px;
				}
			</style>
		</head>
		<body>
			<div class="header-row">
				<div class="header-title">Cryptographic Audit Trail</div>
				<div class="chain-badge">${chainBadge}</div>
				<div class="mode-badge" style="background: ${modeColor}22; color: ${modeColor}; border: 1px solid ${modeColor}44;">
					● ${mode.toUpperCase()}
				</div>
			</div>
			<div class="entries-count">${entries.length} entries in session</div>
			<table>
				<thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Outcome</th><th>Target</th><th>Hash</th></tr></thead>
				<tbody>${auditRows}</tbody>
			</table>
		</body>
		</html>`;
	}

	private getActionLogHtml(): string {
		const mode = this.enclaveEnv.mode;
		const stats = this.actionLogService.getStats();

		// Build filter for query
		const filter: IActionLogFilter = {
			limit: 100,
		};
		if (this._actionLogCategoryFilter !== 'all') {
			filter.categories = [this._actionLogCategoryFilter as ActionCategory];
		}
		if (this._actionLogSourceFilter !== 'all') {
			filter.sources = [this._actionLogSourceFilter as ActionSource];
		}

		const entries = this.actionLogService.query(filter);

		const modeColors: Record<string, string> = {
			open: '#4fc1ff',
			standard: '#ffa500',
			locked_down: '#f14c4c'
		};
		const modeColor = modeColors[mode] || '#4fc1ff';

		// Category color map
		const catColors: Record<string, string> = {
			command: '#569cd6',
			editor: '#4ec9b0',
			file: '#dcdcaa',
			terminal: '#ce9178',
			debug: '#c586c0',
			configuration: '#9cdcfe',
			lifecycle: '#608b4e',
			ai: '#b5cea8',
			agent: '#c586c0',
			checks: '#f14c4c',
			powermode: '#ff8c00',
			enclave: '#e0a84e',
			search: '#d7ba7d',
			window: '#6a9955',
			keyboard: '#d4d4d4',
			scm: '#4fc1ff',
			extension: '#c586c0',
		};

		// Severity icons
		const sevIcons: Record<string, string> = {
			trace: '·',
			info: '●',
			warning: '▲',
			error: '✗',
			critical: '⬤',
		};
		const sevColors: Record<string, string> = {
			trace: 'var(--vscode-descriptionForeground)',
			info: 'var(--vscode-charts-blue, #569cd6)',
			warning: 'var(--vscode-charts-orange, #ffa500)',
			error: 'var(--vscode-errorForeground)',
			critical: '#ff0000',
		};

		// Build stat boxes
		const topCategories = Object.entries(stats.entriesByCategory)
			.sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
			.slice(0, 5);

		let statBoxes = `
			<div class="stat-box">
				<div class="stat-value">${stats.totalEntries}</div>
				<div class="stat-label">Total Actions</div>
			</div>`;
		for (const [cat, count] of topCategories) {
			const color = catColors[cat] ?? '#888';
			statBoxes += `
			<div class="stat-box">
				<div class="stat-value" style="color: ${color};">${count}</div>
				<div class="stat-label">${cat}</div>
			</div>`;
		}

		// Build category filter options
		const allCategories = ['all', 'command', 'editor', 'file', 'terminal', 'debug', 'configuration', 'lifecycle', 'ai', 'agent', 'checks', 'powermode', 'enclave', 'search', 'window', 'scm'];
		let categoryOptions = '';
		for (const c of allCategories) {
			const selected = c === this._actionLogCategoryFilter ? ' selected' : '';
			categoryOptions += `<option value="${c}"${selected}>${c === 'all' ? 'All Categories' : c.toUpperCase()}</option>`;
		}

		// Build source filter options
		const allSources = ['all', 'user', 'agent', 'system', 'extension'];
		let sourceOptions = '';
		for (const s of allSources) {
			const selected = s === this._actionLogSourceFilter ? ' selected' : '';
			sourceOptions += `<option value="${s}"${selected}>${s === 'all' ? 'All Sources' : s.toUpperCase()}</option>`;
		}

		// Build table rows (newest first)
		let tableRows = '';
		if (entries.length > 0) {
			const reversed = [...entries].reverse();
			for (const e of reversed) {
				const timeStr = new Date(e.timestamp).toLocaleTimeString();
				const catColor = catColors[e.category] ?? '#888';
				const sevIcon = sevIcons[e.severity] ?? '·';
				const sevColor = sevColors[e.severity] ?? 'inherit';
				const targetStr = e.target
					? (e.target.length > 60 ? e.target.substring(e.target.length - 60) : e.target)
					: '—';

				tableRows += `
					<tr>
						<td class="col-time">${timeStr}</td>
						<td class="col-sev"><span style="color: ${sevColor};" title="${e.severity}">${sevIcon}</span></td>
						<td class="col-cat"><span class="category-badge" style="background: ${catColor}18; color: ${catColor}; border: 1px solid ${catColor}33;">${e.category}</span></td>
						<td class="col-source">${e.source}</td>
						<td class="col-label" title="${this._escapeHtml(e.label)}">${this._escapeHtml(e.label)}</td>
						<td class="col-target" title="${this._escapeHtml(targetStr)}">${this._escapeHtml(targetStr)}</td>
					</tr>`;
			}
		} else {
			tableRows = `<tr><td colspan="6" class="empty-state">No actions logged yet. Actions will appear here as you use the IDE.</td></tr>`;
		}

		return `<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Action Log</title>
			<style>
				body {
					font-family: var(--vscode-font-family);
					font-size: var(--vscode-font-size);
					padding: 16px 20px;
					background-color: var(--vscode-editor-background);
					color: var(--vscode-editor-foreground);
					margin: 0;
				}
				.header-row {
					display: flex;
					align-items: center;
					gap: 16px;
					margin-bottom: 16px;
					padding-bottom: 12px;
					border-bottom: 1px solid var(--vscode-panel-border);
				}
				.header-title {
					font-size: 1.3em;
					font-weight: 500;
					flex: 1;
				}
				.mode-badge {
					display: inline-flex;
					align-items: center;
					gap: 6px;
					padding: 4px 12px;
					border-radius: 4px;
					font-size: 11px;
					font-weight: 700;
					letter-spacing: 1px;
					text-transform: uppercase;
				}
				.stat-row {
					display: flex;
					gap: 10px;
					margin-bottom: 16px;
				}
				.stat-box {
					background: rgba(255,255,255,0.03);
					border: 1px solid var(--vscode-widget-border);
					padding: 8px 12px;
					border-radius: 4px;
					min-width: 80px;
					flex: 1;
				}
				.stat-value {
					font-size: 1.4em;
					font-weight: 700;
					font-family: monospace;
				}
				.stat-label {
					font-size: 9px;
					text-transform: uppercase;
					letter-spacing: 0.5px;
					opacity: 0.6;
					margin-top: 2px;
				}
				.filter-row {
					display: flex;
					gap: 10px;
					margin-bottom: 12px;
					align-items: center;
				}
				.filter-row label {
					font-size: 10px;
					text-transform: uppercase;
					letter-spacing: 0.5px;
					color: var(--vscode-descriptionForeground);
				}
				.filter-row select {
					background: var(--vscode-input-background);
					color: var(--vscode-input-foreground);
					border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
					padding: 3px 8px;
					font-size: 11px;
					border-radius: 3px;
					outline: none;
					font-family: var(--vscode-font-family);
				}
				.entries-count {
					font-size: 11px;
					color: var(--vscode-descriptionForeground);
					margin-left: auto;
				}
				table {
					width: 100%;
					border-collapse: collapse;
					font-size: 12px;
					table-layout: fixed;
				}
				th {
					text-align: left;
					padding: 6px 8px;
					font-size: 10px;
					text-transform: uppercase;
					letter-spacing: 0.5px;
					color: var(--vscode-descriptionForeground);
					border-bottom: 1px solid var(--vscode-panel-border);
					position: sticky;
					top: 0;
					background: var(--vscode-editor-background);
				}
				td {
					padding: 3px 8px;
					vertical-align: middle;
					overflow: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
				}
				tr:hover {
					background: rgba(255,255,255,0.03);
				}
				.col-time { width: 80px; font-family: monospace; font-size: 11px; color: var(--vscode-descriptionForeground); }
				.col-sev { width: 24px; text-align: center; }
				.col-cat { width: 110px; }
				.col-source { width: 70px; font-size: 11px; opacity: 0.7; }
				.col-label { }
				.col-target { width: 180px; font-family: monospace; font-size: 11px; opacity: 0.6; }
				.category-badge {
					display: inline-block;
					padding: 1px 6px;
					border-radius: 3px;
					font-size: 10px;
					font-weight: 600;
					text-transform: uppercase;
					letter-spacing: 0.3px;
				}
				.empty-state {
					padding: 24px 8px !important;
					color: var(--vscode-descriptionForeground);
					text-align: center;
				}
				.table-wrap {
					overflow-y: auto;
					max-height: calc(100vh - 200px);
				}
			</style>
		</head>
		<body>
			<div class="header-row">
				<div class="header-title">Action Log</div>
				<span style="font-size: 12px; color: var(--vscode-testing-iconPassed);">● Live</span>
				<div class="mode-badge" style="background: ${modeColor}22; color: ${modeColor}; border: 1px solid ${modeColor}44;">
					● ${mode.toUpperCase()}
				</div>
			</div>

			<div class="stat-row">${statBoxes}</div>

			<div class="filter-row">
				<label>Category</label>
				<select id="categoryFilter" onchange="sendFilter()">
					${categoryOptions}
				</select>
				<label>Source</label>
				<select id="sourceFilter" onchange="sendFilter()">
					${sourceOptions}
				</select>
				<div class="entries-count">Showing ${entries.length} of ${stats.totalEntries} entries</div>
			</div>

			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th style="width: 80px;">Time</th>
							<th style="width: 24px;"></th>
							<th style="width: 110px;">Category</th>
							<th style="width: 70px;">Source</th>
							<th>Action</th>
							<th style="width: 180px;">Target</th>
						</tr>
					</thead>
					<tbody>${tableRows}</tbody>
				</table>
			</div>

			<script>
				const vscode = acquireVsCodeApi();
				function sendFilter() {
					const category = document.getElementById('categoryFilter').value;
					const source = document.getElementById('sourceFilter').value;
					vscode.postMessage({ type: 'filterChange', category, source });
				}
			</script>
		</body>
		</html>`;
	}

	private _escapeHtml(str: string): string {
		return str
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
	}

	toJSON(): object {
		return {
			type: EnclaveManagerPart.ID
		};
	}

	override dispose(): void {
		this.disposables.dispose();
		super.dispose();
	}
}

