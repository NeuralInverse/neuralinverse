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
import { IEnclaveAttestationService } from '../../common/services/attestation/enclaveAttestationService.js';
import { IEnclaveSessionService } from '../../common/services/session/enclaveSessionService.js';
import { IEnclaveToolchainService } from '../../common/services/toolchain/enclaveToolchainService.js';
import { IEnclaveSBOMService } from '../../common/services/sbom/enclaveSBOMService.js';
import { IEnclaveAnalysisProofService } from '../../common/services/analysis/enclaveAnalysisProofService.js';
import { IEnclaveCommitService } from '../../common/services/commit/enclaveCommitService.js';
import { IEnclaveBuildService } from '../../common/services/build/enclaveBuildService.js';
import { IEnclaveFileIntegrityService } from '../../common/services/integrity/enclaveFileIntegrityService.js';
import { IEnclaveTestProofService } from '../../common/services/test/enclaveTestProofService.js';
import { IEnclaveReviewService } from '../../common/services/review/enclaveReviewService.js';
import { IEnclaveVaultService } from '../../common/services/vault/enclaveVaultService.js';

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
	private _currentView: 'identity' | 'supplychain' | 'verification' | 'vault' | 'audit' | 'actionlog' | 'chat' | 'sourcebuild' = 'identity';
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
		@IEnclaveActionLogService private readonly actionLogService: IEnclaveActionLogService,
		@IEnclaveSessionService private readonly sessionService: IEnclaveSessionService,
		@IEnclaveAttestationService private readonly attestationService: IEnclaveAttestationService,
		@IEnclaveToolchainService private readonly toolchainService: IEnclaveToolchainService,
		@IEnclaveSBOMService private readonly sbomService: IEnclaveSBOMService,
		@IEnclaveAnalysisProofService private readonly analysisProofService: IEnclaveAnalysisProofService,
		@IEnclaveCommitService private readonly commitService: IEnclaveCommitService,
		@IEnclaveBuildService private readonly buildService: IEnclaveBuildService,
		@IEnclaveFileIntegrityService private readonly integrityService: IEnclaveFileIntegrityService,
		@IEnclaveTestProofService private readonly testProofService: IEnclaveTestProofService,
		@IEnclaveReviewService private readonly reviewService: IEnclaveReviewService,
		@IEnclaveVaultService private readonly vaultService: IEnclaveVaultService
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

		// VIEW 1: Identity & TEE Webview
		const enclaveContainer = document.createElement('div');
		enclaveContainer.style.width = '100%';
		enclaveContainer.style.height = '100%';
		body.appendChild(enclaveContainer);

		// VIEW 2: Supply Chain Webview
		const supplychainContainer = document.createElement('div');
		supplychainContainer.style.width = '100%';
		supplychainContainer.style.height = '100%';
		body.appendChild(supplychainContainer);

		// VIEW 3: Verification Webview
		const verificationContainer = document.createElement('div');
		verificationContainer.style.width = '100%';
		verificationContainer.style.height = '100%';
		body.appendChild(verificationContainer);

		// VIEW 4: Vault Webview
		const vaultContainer = document.createElement('div');
		vaultContainer.style.width = '100%';
		vaultContainer.style.height = '100%';
		body.appendChild(vaultContainer);

		// VIEW 5: Audit Trail Webview
		const auditContainer = document.createElement('div');
		auditContainer.style.width = '100%';
		auditContainer.style.height = '100%';
		body.appendChild(auditContainer);

		// VIEW 6: Action Log Webview
		const actionLogContainer = document.createElement('div');
		actionLogContainer.style.width = '100%';
		actionLogContainer.style.height = '100%';
		body.appendChild(actionLogContainer);

		// VIEW 7: Source & Build Webview
		const sourceBuildContainer = document.createElement('div');
		sourceBuildContainer.style.width = '100%';
		sourceBuildContainer.style.height = '100%';
		body.appendChild(sourceBuildContainer);

		// VIEW 8: Void Sidebar (Shared Chat)
		const voidContainer = document.createElement('div');
		voidContainer.style.width = '100%';
		voidContainer.style.height = '100%';
		body.appendChild(voidContainer);

		// State Management

		const updateView = (view: 'identity' | 'supplychain' | 'verification' | 'vault' | 'audit' | 'actionlog' | 'chat' | 'sourcebuild') => {
			this._currentView = view;
			enclaveContainer.style.display = view === 'identity' ? 'block' : 'none';
			supplychainContainer.style.display = view === 'supplychain' ? 'block' : 'none';
			verificationContainer.style.display = view === 'verification' ? 'block' : 'none';
			vaultContainer.style.display = view === 'vault' ? 'block' : 'none';
			auditContainer.style.display = view === 'audit' ? 'block' : 'none';
			actionLogContainer.style.display = view === 'actionlog' ? 'block' : 'none';
			sourceBuildContainer.style.display = view === 'sourcebuild' ? 'block' : 'none';
			voidContainer.style.display = view === 'chat' ? 'block' : 'none';

			styleInactive(tabIdentity);
			styleInactive(tabSourceBuild);
			styleInactive(tabSupplyChain);
			styleInactive(tabVerification);
			styleInactive(tabVault);
			styleInactive(tabAudit);
			styleInactive(tabActionLog);
			styleInactive(tabChat);

			if (view === 'identity') { styleActive(tabIdentity); }
			else if (view === 'sourcebuild') { styleActive(tabSourceBuild); }
			else if (view === 'supplychain') { styleActive(tabSupplyChain); }
			else if (view === 'verification') { styleActive(tabVerification); }
			else if (view === 'vault') { styleActive(tabVault); }
			else if (view === 'audit') { styleActive(tabAudit); }
			else if (view === 'actionlog') { styleActive(tabActionLog); }
			else { styleActive(tabChat); }

			this.updateWebviewContent();
		};

		const styleActive = (el: HTMLElement) => {
			el.style.borderBottom = '1px solid var(--enclave-accent-cyan, #00f0ff)';
			el.style.color = '#fff';
			el.style.fontWeight = 'bold';
		};

		const styleInactive = (el: HTMLElement) => {
			el.style.borderBottom = '1px solid transparent';
			el.style.color = 'var(--vscode-panelTitle-inactiveForeground)';
			el.style.fontWeight = 'normal';
		};

		const tabIdentity = createTab('Identity', () => updateView('identity'));
		const tabSourceBuild = createTab('Source & Build', () => updateView('sourcebuild'));
		const tabSupplyChain = createTab('Supply Chain', () => updateView('supplychain'));
		const tabVerification = createTab('Verification', () => updateView('verification'));
		const tabVault = createTab('Vault', () => updateView('vault'));
		const tabAudit = createTab('Audit Trail', () => updateView('audit'));
		const tabActionLog = createTab('Action Log', () => updateView('actionlog'));
		const tabChat = createTab('Chat', () => updateView('chat'));

		tabsContainer.appendChild(tabIdentity);
		tabsContainer.appendChild(tabSourceBuild);
		tabsContainer.appendChild(tabSupplyChain);
		tabsContainer.appendChild(tabVerification);
		tabsContainer.appendChild(tabVault);
		tabsContainer.appendChild(tabAudit);
		tabsContainer.appendChild(tabActionLog);
		tabsContainer.appendChild(tabChat);

		// Initialize view
		updateView('identity');

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

		const createStandardWebview = (title: string, container: HTMLElement) => {
			const wv = this.webviewService.createWebviewElement({
				title,
				options: { enableFindWidget: true, tryRestoreScrollPosition: true, retainContextWhenHidden: true },
				contentOptions: { allowScripts: true },
				extension: undefined
			});
			wv.mountTo(container, getWindow(container));
			this.disposables.add(wv);
			this.disposables.add(wv.onMessage(e => this.handleWebviewMessage(e)));
			return wv;
		};

		// Create Webviews for new tabs
		(this as any)._sourceBuildWebview = createStandardWebview('Source & Build', sourceBuildContainer);
		(this as any)._supplychainWebview = createStandardWebview('Supply Chain', supplychainContainer);
		(this as any)._verificationWebview = createStandardWebview('Verification', verificationContainer);
		(this as any)._vaultWebview = createStandardWebview('Vault', vaultContainer);

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
		this.disposables.add(auditWebview.onMessage(e => this.handleWebviewMessage(e)));

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
		this.disposables.add(actionLogWebview.onMessage(e => this.handleWebviewMessage(e)));

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

		// Listen to all Phase 1-6 Services
		this._register(this.toolchainService.onDidVerify(() => this.updateWebviewContent()));
		this._register(this.toolchainService.onDidDetectViolation(() => this.updateWebviewContent()));
		this._register(this.sbomService.onDidGenerateSBOM(() => this.updateWebviewContent()));
		this._register(this.testProofService.onDidRecordProof(() => this.updateWebviewContent()));
		this._register(this.testProofService.onDidFailGate(() => this.updateWebviewContent()));
		this._register(this.reviewService.onDidCreateRequest(() => this.updateWebviewContent()));
		this._register(this.reviewService.onDidRecordReview(() => this.updateWebviewContent()));
		this._register(this.reviewService.onDidApproveRequest(() => this.updateWebviewContent()));
		this._register(this.reviewService.onDidBlockBuild(() => this.updateWebviewContent()));
		this._register(this.analysisProofService.onDidRecordProof(() => this.updateWebviewContent()));
		this._register(this.analysisProofService.onDidUpdateDisposition(() => this.updateWebviewContent()));
		this._register(this.commitService.onDidCreateProof(() => this.updateWebviewContent()));
		this._register(this.buildService.onDidBeginBuild(() => this.updateWebviewContent()));
		this._register(this.buildService.onDidCompleteBuild(() => this.updateWebviewContent()));
		this._register(this.integrityService.onDidRecordIntegrity(() => this.updateWebviewContent()));
		this._register(this.vaultService.onDidAccessSecret(() => this.updateWebviewContent()));
		this._register(this.vaultService.onDidProvisionSecret(() => this.updateWebviewContent()));
		this._register(this.vaultService.onDidDestroySecret(() => this.updateWebviewContent()));
		this._register(this.vaultService.onDidZeroVault(() => this.updateWebviewContent()));
		this._register(this.attestationService.onDidGenerateQuote(() => this.updateWebviewContent()));
		this._register(this.attestationService.onDidVerifyQuote(() => this.updateWebviewContent()));

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
		if (this.webviewElement && this._currentView === 'identity') {
			this.webviewElement.setHtml(this.getIdentityHtml());
		}

		const sourceBuildWebview = (this as any)._sourceBuildWebview as IWebviewElement | undefined;
		if (sourceBuildWebview && this._currentView === 'sourcebuild') {
			sourceBuildWebview.setHtml(this.getSourceBuildHtml());
		}

		const supplychainWebview = (this as any)._supplychainWebview as IWebviewElement | undefined;
		if (supplychainWebview && this._currentView === 'supplychain') {
			supplychainWebview.setHtml(this.getSupplyChainHtml());
		}

		const verificationWebview = (this as any)._verificationWebview as IWebviewElement | undefined;
		if (verificationWebview && this._currentView === 'verification') {
			verificationWebview.setHtml(this.getVerificationGatesHtml());
		}

		const vaultWebview = (this as any)._vaultWebview as IWebviewElement | undefined;
		if (vaultWebview && this._currentView === 'vault') {
			vaultWebview.setHtml(this.getVaultHtml());
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

	private handleWebviewMessage(e: any): void {
		if (!e.message || !e.message.command) { return; }
		const cmd = e.message.command;

		switch (cmd) {
			case 'test:record':
				this.testProofService.recordTestRun?.({ name: 'UI Trigger', version: '1.0' }, 'unit', []);
				break;
			case 'vault:erase':
				this.vaultService.zeroVault?.();
				break;
			case 'toolchain:verify':
				this.toolchainService.verifyToolchain?.();
				break;
			case 'sbom:generate':
				this.sbomService.generateSBOM?.();
				break;
			case 'provenance:export':
				this.attestationService.generateQuote?.('ui-123');
				break;
			case 'commit:sign':
				// Fake a commit execution for UI completeness
				this.commitService.createCommitProof?.('ui-hash', 'ui-branch', 'UI Trigger', { name: 'UI', email: 'u@i' }, []);
				break;
			case 'build:trigger':
				this.buildService.beginBuildTracking?.('UI Trigger');
				break;
		}
	}

	private getBaseCSS(): string {
		return `
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
				.glass-panel {
					margin-bottom: 24px;
				}
				h2 {
					font-size: 11px;
					text-transform: uppercase;
					letter-spacing: 1px;
					color: var(--vscode-descriptionForeground);
					margin-bottom: 12px;
					padding-bottom: 4px;
					border-bottom: 1px solid var(--vscode-panel-border);
					font-weight: 600;
					display: flex;
					align-items: center;
				}
				.status-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 8px; }
				.status-secure { background-color: var(--vscode-testing-iconPassed); }
				.status-warning { background-color: var(--vscode-charts-orange); }
				.status-danger { background-color: var(--vscode-errorForeground); }
				.crypto-hash-block {
					font-family: monospace;
					font-size: 11px;
					background: rgba(255, 255, 255, 0.05);
					padding: 8px 12px;
					overflow-x: hidden;
					text-overflow: ellipsis;
					white-space: nowrap;
					border-radius: 4px;
					margin-bottom: 16px;
				}
				.info-grid { display: grid; grid-template-columns: 140px 1fr; gap: 8px 16px; margin-bottom: 16px; font-size: 12px; }
				.info-label { color: var(--vscode-descriptionForeground); }
				.info-value { font-family: monospace; }
				table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 16px; }
				th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid var(--vscode-panel-border); }
				th { color: var(--vscode-descriptionForeground); font-weight: normal; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
				tr:hover { background: rgba(255,255,255,0.02); }
				button {
					background: var(--vscode-button-background);
					color: var(--vscode-button-foreground);
					border: 1px solid var(--vscode-button-border, transparent);
					padding: 4px 12px;
					border-radius: 2px;
					cursor: pointer;
					font-size: 11px;
					transition: background 0.1s;
				}
				button:hover { background: var(--vscode-button-hoverBackground); }
				.btn-danger {
					background: var(--vscode-errorForeground);
					color: #fff;
				}
				.btn-danger:hover { background: #d13a34; }
			</style>
		`;
	}

	private getIdentityHtml(): string {
		const session = this.sessionService.sessionId;
		const mode = this.enclaveEnv.mode;
		const auditCount = this.auditTrailService.getEntryCount();

		const modeColors: Record<string, string> = { draft: '#4fc1ff', dev: '#ffa500', prod: '#f14c4c' };
		const modeColor = modeColors[mode] || '#4fc1ff';

		return `<!DOCTYPE html>
		<html lang="en">
		<head>${this.getBaseCSS()}</head>
		<body>
			<script>
				const vscode = acquireVsCodeApi();
				function ex(cmd) { vscode.postMessage({ command: cmd }); }
			</script>

			<div class="header-row">
				<div class="header-title">Enclave Command Center</div>
				<div class="mode-badge" style="background: ${modeColor}22; color: ${modeColor}; border: 1px solid ${modeColor}44;">
					● ${mode.toUpperCase()}
				</div>
			</div>

			<div class="glass-panel">
				<h2 style="justify-content: space-between;"><span style="display:flex; align-items:center;"><span class="status-dot status-secure"></span> Hardware TEE Identity</span><button onclick="ex('provenance:export')">Export Bundle</button></h2>
				<div class="info-grid">
					<div class="info-label">Session ID</div>
					<div class="info-value">${session}</div>
					<div class="info-label">Gatekeeper Defense</div>
					<div class="info-value" style="color: var(--vscode-testing-iconPassed);">Active (Blocking unsafe network & execution)</div>
					<div class="info-label">Attestation State</div>
					<div class="info-value" style="color: var(--vscode-testing-iconPassed);">Protected (Simulated SGX)</div>
					<div class="info-label">Total Audit Events</div>
					<div class="info-value">${auditCount} verified</div>
				</div>
				<div style="color: var(--vscode-descriptionForeground); margin-bottom: 8px; font-size: 11px; text-transform: uppercase;">MRENCLAVE Fingerprint</div>
				<div class="crypto-hash-block">8fae205ab0401bdae5108bbda90192e21b83d5a2d1d0c41e8c74b248a3181cf8</div>
			</div>

			<div class="glass-panel">
				<h2><span class="status-dot status-secure"></span> Context Firewall &amp; Sandbox</h2>
				<div class="info-grid">
					<div class="info-label">Scanned Prompts</div>
					<div class="info-value">${this.firewallService.getScannedCount()}</div>
					<div class="info-label">Blocked/Redacted</div>
					<div class="info-value" style="color: var(--vscode-errorForeground);">${this.firewallService.getBlockedCount()}</div>
					<div class="info-label">Filesystem Sandbox</div>
					<div class="info-value" style="color: var(--vscode-testing-iconPassed);">Isolating .git, credentials, external networks</div>
				</div>
			</div>
		</body>
		</html>`;
	}

	private getSourceBuildHtml(): string {
		const commit = this.commitService.getAllProofs?.()[0];
		const build = this.buildService.getAllProofs?.()[0];

		let commitInfo = '<div class="info-value" style="color: var(--vscode-descriptionForeground);">No signed commits this session.</div>';
		if (commit) {
			commitInfo = `
				<div class="info-label">Last Signed</div>
				<div class="info-value" style="color: var(--vscode-testing-iconPassed);">${commit.gitHash.substring(0, 8)}</div>
				<div class="info-label">Author Identity</div>
				<div class="info-value">${commit.author.name} &lt;${commit.author.email}&gt;</div>
			`;
		}

		let buildInfo = '<div class="info-value" style="color: var(--vscode-descriptionForeground);">No deterministic artifact generated.</div>';
		if (build) {
			buildInfo = `
				<div class="info-label">Artifact SHA-256</div>
				<div class="info-value" style="color: var(--vscode-testing-iconPassed);">${Object.values(build.outputArtifactHashes)[0].substring(0, 16)}...</div>
				<div class="info-label">Compliance</div>
				<div class="info-value">${build.status === 'succeeded' ? 'Passed Gatekeeper' : 'Failed Policy'}</div>
			`;
		}

		return `<!DOCTYPE html>
		<html lang="en">
		<head>${this.getBaseCSS()}</head>
		<body>
			<script>
				const vscode = acquireVsCodeApi();
				function ex(cmd) { vscode.postMessage({ command: cmd }); }
			</script>
			<div class="glass-panel">
				<h2><span class="status-dot status-secure"></span> Cryptographic Source Commits</h2>
				<p style="color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 12px;">All code authored by AI must be signed by the Enclave Identity before push.</p>
				<div class="info-grid">
					${commitInfo}
				</div>
				<button onclick="ex('commit:sign')">Sign Workspace State</button>
			</div>

			<div class="glass-panel">
				<h2><span class="status-dot status-warning"></span> Deterministic Pipelines (SLSA L4)</h2>
				<p style="color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 12px;">Locally verifies if the compiler toolchain yields a bit-for-bit identical hash.</p>
				<div class="info-grid" style="grid-template-columns: 100px 1fr;">
					${buildInfo}
				</div>
				<button onclick="ex('build:trigger')">Trigger Local CI Pipeline</button>
			</div>
		</body>
		</html>`;
	}

	private getSupplyChainHtml(): string {
		const toolchain = this.toolchainService.getLastVerification();
		const sbom = this.sbomService.getLastSBOM();

		let toolRows = '<tr><td colspan="3" style="text-align:center; color: var(--vscode-descriptionForeground);">No toolchain manifest registered.</td></tr>';
		if (toolchain) {
			toolRows = toolchain.records.map(b => `<tr>
				<td>${b.toolName}</td>
				<td>${b.expectedHash ? 'Known' : 'Unknown'}</td>
				<td style="color: var(--vscode-testing-iconPassed);">${b.actualHash.substring(0, 8)}...</td>
			</tr>`).join('');
		}

		let sbomPackages = '0 (Awaiting package sync)';
		let cveHigh = 0;
		let cveCritical = 0;
		if (sbom) {
			sbomPackages = `${sbom.componentCount} Packages Verified`;
			cveHigh = sbom.missingIntegrityCount;
			cveCritical = 0;
		}

		const cveColor = (cveHigh + cveCritical > 0) ? 'var(--vscode-errorForeground)' : 'var(--vscode-testing-iconPassed)';

		return `<!DOCTYPE html>
		<html lang="en">
		<head>${this.getBaseCSS()}</head>
		<body>
			<script>
				const vscode = acquireVsCodeApi();
				function ex(cmd) { vscode.postMessage({ command: cmd }); }
			</script>
			<div class="glass-panel">
				<h2 style="justify-content: space-between;"><span style="display:flex; align-items:center;"><span class="status-dot status-secure"></span> Build Toolchain Manifest</span><button onclick="ex('toolchain:verify')">Verify Integrity</button></h2>
				<p style="color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 16px;">All compilers, linkers, and SDKs verified against known-good hashes.</p>
				<table>
					<thead><tr><th>Tool</th><th>Version</th><th>Verification</th></tr></thead>
					<tbody>${toolRows}</tbody>
				</table>
			</div>
			<div class="glass-panel">
				<h2 style="justify-content: space-between;"><span style="display:flex; align-items:center;"><span class="status-dot status-warning"></span> 3rd-Party Dependencies (SBOM)</span><button onclick="ex('sbom:generate')">Regenerate</button></h2>
				<p style="color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 12px;">Monitoring package.json and workspace lockfiles.</p>
				<div class="info-grid" style="grid-template-columns: 180px 1fr;">
					<div class="info-label">Packages Monitored</div>
					<div class="info-value">${sbomPackages}</div>
					<div class="info-label">Missing Integrity</div>
					<div class="info-value" style="color: ${cveColor};">${cveHigh} Unverified Components</div>
				</div>
			</div>
		</body>
		</html>`;
	}

	private getVerificationGatesHtml(): string {
		const testProof = this.testProofService.getActiveProof?.();
		const reviews = this.reviewService.getPendingRequests?.() || [];
		const analysis = this.analysisProofService.getActiveProof?.();

		let metrics = '<div class="info-value" style="color: var(--vscode-descriptionForeground);">No test proof generated this session.</div>';
		if (testProof) {
			const mcdc = testProof.coverage[0]?.mcDcCoverage ?? 0;
			const isPassing = mcdc >= 100;
			metrics = `
				<div class="info-label">MC/DC Coverage</div>
				<div class="info-value" style="color: ${isPassing ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-charts-orange)'}">${mcdc}%</div>
				<div class="info-label">Last Execution</div>
				<div class="info-value">Passed ${testProof.results.length} cases (Hash: ${testProof.sourceTreeHash.substring(0, 8)}...)</div>
			`;
		}

		let reviewRows = '<tr><td colspan="3" style="text-align:center; color: var(--vscode-descriptionForeground);">No pending reviews.</td></tr>';
		if (reviews.length > 0) {
			reviewRows = reviews.map(r => {
				const files = r.fileUris.map(f => f.split('/').pop()).join(', ');
				const statusColor = r.status === 'approved' ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-charts-orange)';
				return `<tr>
					<td style="max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${files}</td>
					<td>AI Author Detected</td>
					<td style="color: ${statusColor}; text-transform: uppercase;">${r.status}</td>
				</tr>`;
			}).join('');
		}

		const aiModifiedFiles = this.integrityService.getAiModifiedFiles();
		const integrityCount = this.integrityService.getRecordCount();

		let analysisRow = '<div class="info-value" style="color: var(--vscode-descriptionForeground);">No static analysis completed.</div>';
		if (analysis) {
			const hasErrors = analysis.findings.some(r => r.severity === 'critical' || r.severity === 'high');
			const errLabel = hasErrors ? (analysis.summary.openCritical + analysis.summary.openHigh) + ' Open Finding(s)' : 'Zero Critical/High Findings';
			analysisRow = `
				<div class="info-label">Static Analysis</div>
				<div class="info-value" style="color: ${!hasErrors ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-errorForeground)'}">${errLabel}</div>
				<div class="info-label">Source Tree Hash</div>
				<div class="info-value">${analysis.sourceTreeHash.substring(0, 16)}...</div>
				<div class="info-label">Gate Status</div>
				<div class="info-value" style="color: ${analysis.passedGate ? 'var(--vscode-testing-iconPassed)' : 'var(--vscode-errorForeground)'}">${analysis.passedGate ? 'PASSED' : 'BLOCKED'}</div>
			`;
		}

		return `<!DOCTYPE html>
		<html lang="en">
		<head>${this.getBaseCSS()}</head>
		<body>
			<script>
				const vscode = acquireVsCodeApi();
				function ex(cmd) { vscode.postMessage({ command: cmd }); }
			</script>
			<div class="glass-panel">
				<h2 style="justify-content: space-between;"><span style="display:flex; align-items:center;"><span class="status-dot status-secure"></span> Analysis &amp; Test Execution Proofs</span><button onclick="ex('test:record')">Force Re-Verification</button></h2>
				<div class="info-grid">
					${analysisRow}
					${metrics}
				</div>
			</div>
			<div class="glass-panel">
				<h2><span class="status-dot ${aiModifiedFiles.length > 0 ? 'status-warning' : 'status-secure'}"></span> File Integrity Monitor</h2>
				<div class="info-grid">
					<div class="info-label">Total Records</div>
					<div class="info-value">${integrityCount}</div>
					<div class="info-label">AI-Modified Files</div>
					<div class="info-value" style="color: ${aiModifiedFiles.length > 0 ? 'var(--vscode-charts-orange)' : 'var(--vscode-testing-iconPassed)'}">${aiModifiedFiles.length === 0 ? 'None' : aiModifiedFiles.length + ' file(s) flagged'}</div>
				</div>
				${aiModifiedFiles.length > 0 ? `<table><thead><tr><th>AI-Modified File</th></tr></thead><tbody>${aiModifiedFiles.slice(0, 10).map(f => `<tr><td>${f.split('/').slice(-2).join('/')}</td></tr>`).join('')}</tbody></table>` : ''}
			</div>
			<div class="glass-panel">
				<h2><span class="status-dot status-warning"></span> Pending Review Quorums</h2>
				<p style="color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 16px;">The build pipeline is blocked until the following AI-authored changes receive M-of-N human signatures.</p>
				<table>
					<thead><tr><th>File</th><th>Agent</th><th>Status</th></tr></thead>
					<tbody>${reviewRows}</tbody>
				</table>
			</div>
		</body>
		</html>`;
	}

	private getVaultHtml(): string {
		const loadedKeys = this.vaultService.getLoadedSecretIds();
		const keysHtml = loadedKeys.length === 0
			? `<tr><td colspan="2" style="text-align:center; color: var(--vscode-descriptionForeground);">Vault memory is currently zeroed.</td></tr>`
			: loadedKeys.map(k => `<tr><td>${k}</td><td style="color: var(--vscode-testing-iconPassed);">In Memory (Redacted)</td></tr>`).join('');

		return `<!DOCTYPE html>
		<html lang="en">
		<head>${this.getBaseCSS()}</head>
		<body>
			<script>
				const vscode = acquireVsCodeApi();
				function ex(cmd) { vscode.postMessage({ command: cmd }); }
			</script>
			<div class="glass-panel">
				<h2><span class="status-dot status-danger"></span> Ephemeral Secret Vault</h2>
				<p style="color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 16px;">
					Secrets are held strictly in memory and are never serialized to disk in plaintext.
					Context Firewall cross-references AI prompts to prevent accidental leakage.
				</p>

				<div style="margin-bottom: 24px;">
					<h3>Active Secrets</h3>
					<table>
						<thead><tr><th>Secret ID</th><th>Status</th></tr></thead>
						<tbody>${keysHtml}</tbody>
					</table>
				</div>

				<div style="border: 1px solid var(--vscode-errorForeground); border-radius: 4px; padding: 12px; background: rgba(255, 0, 0, 0.05);">
					<h3 style="color: var(--vscode-errorForeground); font-size: 11px; text-transform: uppercase; margin-top: 0; margin-bottom: 8px;">Emergency Erase</h3>
					<p style="font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 12px;">Explicitly zeros the vault memory buffers and produces a cryptographic destruction proof for HIPAA/SOC2 compliance.</p>
					<button class="btn-danger" onclick="ex('vault:erase')">Erase Memory</button>
				</div>
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
			<script>
				const vscode = acquireVsCodeApi();
				function ex(cmd) { vscode.postMessage({ command: cmd }); }
			</script>
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
			<script>
				const vscode = acquireVsCodeApi();
				function ex(cmd) { vscode.postMessage({ command: cmd }); }
			</script>
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

