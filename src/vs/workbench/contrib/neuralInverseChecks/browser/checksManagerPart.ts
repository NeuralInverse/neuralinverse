/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow } from '../../../../base/browser/dom.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { Part } from '../../../browser/part.js';
import { IWebviewService, IWebviewElement } from '../../webview/browser/webview.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
// import { IAgentRegistryService } from '../common/agentRegistryService.js'; // Checks might use a different service or none for now
import { mountSidebar } from '../../void/browser/react/out/sidebar-tsx/index.js'; // Reusing Void Sidebar for 'Chat' tab
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { ITerminalService, ITerminalInstance } from '../../terminal/browser/terminal.js';
import { Sash, IHorizontalSashLayoutProvider, Orientation, ISashEvent } from '../../../../base/browser/ui/sash/sash.js';

import { NanoAgentsControl } from './nanoAgents/nanoAgentsControl.js';
import { CodeAsPolicyControl } from './codeAsPolicy/codeAsPolicyControl.js';
import { ArchitectureAsCodeControl } from './architectureAsCode/architectureAsCodeControl.js';
import { ComplianceAsCodeControl } from './complianceAsCode/complianceAsCodeControl.js';
import { SecurityAsCodeControl } from './securityAsCode/securityAsCodeControl.js';
import { DataIntegrityControl } from './dataIntegrity/dataIntegrityControl.js';
import { AuditAndEvidenceControl } from './auditAndEvidence/auditAndEvidenceControl.js';
import { FailSafeDefaultsControl } from './failSafeDefaults/failSafeDefaultsControl.js';
import { FormalVerificationControl } from './formalVerification/formalVerificationControl.js';
import { IGRCEngineService } from './engine/services/grcEngineService.js';
import { IFrameworkIntelligenceService } from './engine/services/frameworkIntelligenceService.js';

export class ChecksManagerPart extends Part implements IHorizontalSashLayoutProvider {

    static readonly ID = 'workbench.parts.checksManager';

    minimumWidth: number = 300;
    maximumWidth: number = Infinity;
    minimumHeight: number = 300;
    maximumHeight: number = Infinity;

    private webviewElement: IWebviewElement | undefined;
    private nanoAgentsControl: NanoAgentsControl | undefined;
    private codeAsPolicyControl: CodeAsPolicyControl | undefined;
    private architectureAsCodeControl: ArchitectureAsCodeControl | undefined;
    private complianceAsCodeControl: ComplianceAsCodeControl | undefined;
    private securityAsCodeControl: SecurityAsCodeControl | undefined;
    private dataIntegrityControl: DataIntegrityControl | undefined;
    private auditAndEvidenceControl: AuditAndEvidenceControl | undefined;
    private failSafeDefaultsControl: FailSafeDefaultsControl | undefined;
    private formalVerificationControl: FormalVerificationControl | undefined;
    private sidebarVisible: boolean = true;
    private terminalContainer: HTMLElement | undefined;
    private terminalBody: HTMLElement | undefined;
    private terminalInstance: ITerminalInstance | undefined;
    private terminalVisible: boolean = false;
    private terminalHeight: number = 300;
    private minTerminalHeight: number = 100;
    private _sash: Sash | undefined;
    private _startHeight: number = 0;

    constructor(
        @IThemeService themeService: IThemeService,
        @IStorageService storageService: IStorageService,
        @IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
        @IInstantiationService private readonly instantiationService: IInstantiationService,
        @IWebviewService private readonly webviewService: IWebviewService,
        @ITerminalService private readonly terminalService: ITerminalService,
        @IGRCEngineService private readonly grcEngine: IGRCEngineService,
        @IFrameworkIntelligenceService private readonly intelligenceService: IFrameworkIntelligenceService,
    ) {
        super(ChecksManagerPart.ID, { hasTitle: false }, themeService, storageService, layoutService);
    }

    protected override createContentArea(parent: HTMLElement): HTMLElement | undefined {
        // Root Container (Flex Column)
        const rootContainer = document.createElement('div');
        rootContainer.style.display = 'flex';
        rootContainer.style.flexDirection = 'column';
        rootContainer.style.width = '100%';
        rootContainer.style.height = '100%';
        rootContainer.style.overflow = 'hidden';
        parent.appendChild(rootContainer);

        // Custom Titlebar
        const titlebar = document.createElement('div');
        titlebar.style.height = '35px';
        titlebar.style.minHeight = '35px';
        titlebar.style.display = 'flex';
        titlebar.style.alignItems = 'center';
        titlebar.style.justifyContent = 'space-between'; // Changed to space-between
        titlebar.style.padding = '0 10px';
        titlebar.style.backgroundColor = 'var(--vscode-titleBar-activeBackground)';
        titlebar.style.color = 'var(--vscode-titleBar-activeForeground)';
        titlebar.style.borderBottom = '1px solid var(--vscode-titleBar-border)';
        titlebar.style.userSelect = 'none';
        titlebar.style.cursor = 'default';
        titlebar.style.setProperty('-webkit-app-region', 'drag');
        rootContainer.appendChild(titlebar);

        // Left Spacer (to balance layout if needed, or just flex.
        const leftSpacer = document.createElement('div');
        leftSpacer.style.width = '20px'; // Approx width of toggle button to center title perfectly? Or just flex.
        titlebar.appendChild(leftSpacer);

        // Title
        const titleText = document.createElement('div');
        titleText.textContent = 'Checks Manager';
        titleText.style.fontWeight = '500';
        titleText.style.fontSize = '12px';
        titlebar.appendChild(titleText);

        // Right Actions Container
        const rightActions = document.createElement('div');
        rightActions.style.display = 'flex';
        rightActions.style.alignItems = 'center';
        // rightActions.style.width = '20px';
        titlebar.appendChild(rightActions);

        // Helper to create titlebar actions
        const createActionBtn = (iconClass: string, title: string, onClick: () => void) => {
            const btn = document.createElement('div');
            btn.className = `codicon ${iconClass}`;
            btn.style.cursor = 'pointer';
            btn.style.fontSize = '16px';
            btn.style.padding = '4px';
            btn.style.marginLeft = '4px'; // Spacing between icons
            btn.style.borderRadius = '5px';
            btn.style.display = 'flex';
            btn.style.alignItems = 'center';
            btn.style.justifyContent = 'center';
            btn.title = title;
            btn.style.setProperty('-webkit-app-region', 'no-drag');

            btn.addEventListener('mouseenter', () => {
                btn.style.backgroundColor = 'var(--vscode-toolbar-hoverBackground)';
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.backgroundColor = 'transparent';
            });
            btn.addEventListener('click', onClick);

            rightActions.appendChild(btn);
            return btn;
        };

        // 1. Sidebar Toggle Button
        createActionBtn('codicon-layout-sidebar-left', 'Toggle Sidebar', () => {
            this.sidebarVisible = !this.sidebarVisible;
            sidebar.style.display = this.sidebarVisible ? 'flex' : 'none';
            // Force layout update for nano agents or other resize observers
            const { width, height } = rootContainer.getBoundingClientRect();
            // Manually trigger layout distribution
            this.layout(width, height, 0, 0);
        });

        // 2. Terminal Button (Toggle)
        createActionBtn('codicon-terminal', 'Toggle Terminal', async () => {
            this.terminalVisible = !this.terminalVisible;
            if (this.terminalContainer) {
                this.terminalContainer.style.display = this.terminalVisible ? 'block' : 'none';
            }

            if (this.terminalVisible) {
                if (!this.terminalInstance) {
                    // Create generic terminal
                    try {
                        this.terminalInstance = await this.terminalService.createTerminal();
                    } catch (e) {
                        console.error('Failed to create terminal', e);
                    }
                }

                // Attach if created and xterm is available
                if (this.terminalInstance && this.terminalBody) {
                    if (this.terminalInstance.xterm) {
                        this.terminalInstance.xterm.attachToElement(this.terminalBody);
                    } else {
                        // Wait for xterm to be ready if needed, or retry?
                        // Usually createTerminal awaits until ready.
                        // Fallback: rely on layout to attach?
                        // Actually attachToElement is best called here.
                        // Safe check:
                        console.warn('Terminal created but xterm instance not found immediately.');
                    }
                }
            }

            // Update layout
            const { width, height } = rootContainer.getBoundingClientRect();
            this.layout(width, height, 0, 0);
        });

        // 3. Settings Button
        createActionBtn('codicon-settings-gear', 'Settings', () => {
            // Placeholder: functionality to open settings
            console.log('Open Settings action');
        });

        // Main Content Container (Flex Row)
        const contentContainer = document.createElement('div');
        contentContainer.style.flex = '1';
        contentContainer.style.display = 'flex';
        contentContainer.style.flexDirection = 'row';
        contentContainer.style.width = '100%';
        contentContainer.style.overflow = 'hidden';
        contentContainer.style.position = 'relative';
        rootContainer.appendChild(contentContainer);

        // Sidebar Container
        const sidebar = document.createElement('div');
        sidebar.style.width = '200px';
        sidebar.style.minWidth = '200px';
        sidebar.style.height = '100%';
        sidebar.style.backgroundColor = 'var(--vscode-sideBar-background)';
        sidebar.style.borderRight = '1px solid var(--vscode-sideBar-border)';
        sidebar.style.display = 'flex';
        sidebar.style.flexDirection = 'column';
        sidebar.style.paddingTop = '5px';
        contentContainer.appendChild(sidebar);

        // Content Body container
        const body = document.createElement('div');
        body.style.flex = '1';
        body.style.width = '100%';
        body.style.height = '100%';
        body.style.position = 'relative';
        body.style.overflow = 'hidden';
        body.style.backgroundColor = 'var(--vscode-editor-background)';
        body.style.display = 'flex'; // Change to flex
        body.style.flexDirection = 'column'; // Column layout for views + terminal
        contentContainer.appendChild(body);

        // Terminal Container (Bottom)
        this.terminalContainer = document.createElement('div');
        this.terminalContainer.style.width = '100%';
        this.terminalContainer.style.height = `${this.terminalHeight}px`; // dynamic height
        this.terminalContainer.style.display = 'none';
        this.terminalContainer.style.backgroundColor = 'var(--vscode-panel-background)';
        this.terminalContainer.style.borderTop = '1px solid var(--vscode-panel-border)';
        this.terminalContainer.style.display = 'none'; // Initially hidden
        this.terminalContainer.style.flexDirection = 'column';
        this.terminalContainer.style.position = 'relative'; // For sash positioning

        // VSCode Sash
        this._sash = this._register(new Sash(this.terminalContainer, this, { orientation: Orientation.HORIZONTAL, size: 4 }));

        this._register(this._sash.onDidStart(() => {
            this._startHeight = this.terminalHeight;
        }));

        this._register(this._sash.onDidChange((e: ISashEvent) => {
            // e.currentY is relative to the viewport usually, need to check delta
            // But strict delta usage:
            // Moving UP (negative delta) means INCREASING height because terminal is at bottom.
            // Moving DOWN (positive delta) means DECREASING height.
            const delta = e.currentY - e.startY;
            const newHeight = this._startHeight - delta;

            const rootRect = rootContainer.getBoundingClientRect();
            this.terminalHeight = Math.max(this.minTerminalHeight, Math.min(newHeight, rootRect.height - 35));

            if (this.terminalContainer) {
                this.terminalContainer.style.height = `${this.terminalHeight}px`;
            }
            // Trigger layout
            this.layout(rootRect.width, rootRect.height, 0, 0);
        }));

        // Terminal Header
        const terminalHeader = document.createElement('div');
        terminalHeader.style.height = '22px';
        terminalHeader.style.display = 'flex';
        terminalHeader.style.alignItems = 'center';
        terminalHeader.style.justifyContent = 'space-between';
        terminalHeader.style.padding = '0 10px';
        terminalHeader.style.backgroundColor = 'var(--vscode-panel-background)'; // Match panel bg
        // terminalHeader.style.borderBottom = '1px solid var(--vscode-panel-border)'; // Optional
        terminalHeader.style.userSelect = 'none';

        const terminalTitle = document.createElement('span');
        terminalTitle.textContent = 'TERMINAL';
        terminalTitle.style.fontSize = '11px';
        terminalTitle.style.fontWeight = '600';
        terminalTitle.style.color = 'var(--vscode-panelTitle-activeForeground)';
        terminalTitle.style.cursor = 'default';
        terminalHeader.appendChild(terminalTitle);

        const closeBtn = document.createElement('div');
        closeBtn.className = 'codicon codicon-close';
        closeBtn.style.cursor = 'pointer';
        closeBtn.style.fontSize = '14px';
        closeBtn.style.color = 'var(--vscode-icon-foreground)';
        closeBtn.title = 'Close Panel';
        closeBtn.onclick = () => {
            this.terminalVisible = false;
            this.terminalContainer!.style.display = 'none';
            const { width, height } = rootContainer.getBoundingClientRect();
            this.layout(width, height, 0, 0);
        };
        terminalHeader.appendChild(closeBtn);

        this.terminalContainer.appendChild(terminalHeader);

        // Terminal Body
        this.terminalBody = document.createElement('div');
        this.terminalBody.style.flex = '1';
        this.terminalBody.style.width = '100%';
        this.terminalBody.style.height = 'calc(100% - 22px)';
        this.terminalBody.style.overflow = 'hidden';
        this.terminalBody.style.position = 'relative'; // For xterm positioning
        this.terminalContainer.appendChild(this.terminalBody);


        // VIEW 1: Checks Webview
        const checksContainer = document.createElement('div');
        checksContainer.style.width = '100%';
        checksContainer.style.height = '100%';
        body.appendChild(checksContainer);

        // VIEW 2: Nano Agents
        const nanoContainer = document.createElement('div');
        nanoContainer.style.width = '100%';
        nanoContainer.style.height = '100%';
        body.appendChild(nanoContainer);
        // Initialize control
        this.nanoAgentsControl = this.instantiationService.createInstance(NanoAgentsControl, nanoContainer);
        this._register(this.nanoAgentsControl);

        // VIEW 3: Code as Policy
        const policyContainer = document.createElement('div');
        policyContainer.style.width = '100%';
        policyContainer.style.height = '100%';
        body.appendChild(policyContainer);
        this.codeAsPolicyControl = this.instantiationService.createInstance(CodeAsPolicyControl, policyContainer);
        this._register(this.codeAsPolicyControl);

        // VIEW 4: Architecture as Code (AaC)
        const aacContainer = document.createElement('div');
        aacContainer.style.width = '100%';
        aacContainer.style.height = '100%';
        body.appendChild(aacContainer);
        this.architectureAsCodeControl = this.instantiationService.createInstance(ArchitectureAsCodeControl, aacContainer);
        this._register(this.architectureAsCodeControl);

        // VIEW 5: Compliance as Code (CaC)
        const cacContainer = document.createElement('div');
        cacContainer.style.width = '100%';
        cacContainer.style.height = '100%';
        body.appendChild(cacContainer);
        this.complianceAsCodeControl = this.instantiationService.createInstance(ComplianceAsCodeControl, cacContainer);
        this._register(this.complianceAsCodeControl);

        // VIEW 6: Security as Code (SaC)
        const sacContainer = document.createElement('div');
        sacContainer.style.width = '100%';
        sacContainer.style.height = '100%';
        body.appendChild(sacContainer);
        this.securityAsCodeControl = this.instantiationService.createInstance(SecurityAsCodeControl, sacContainer);
        this._register(this.securityAsCodeControl);

        // VIEW 8: Data Integrity (DIC)
        const dicContainer = document.createElement('div');
        dicContainer.style.width = '100%';
        dicContainer.style.height = '100%';
        body.appendChild(dicContainer);
        this.dataIntegrityControl = this.instantiationService.createInstance(DataIntegrityControl, dicContainer);
        this._register(this.dataIntegrityControl);

        // VIEW 9: Audit & Evidence (AED)
        const aedContainer = document.createElement('div');
        aedContainer.style.width = '100%';
        aedContainer.style.height = '100%';
        body.appendChild(aedContainer);
        this.auditAndEvidenceControl = this.instantiationService.createInstance(AuditAndEvidenceControl, aedContainer);
        this._register(this.auditAndEvidenceControl);

        // VIEW 10: Fail-Safe Defaults (FSD)
        const fsdContainer = document.createElement('div');
        fsdContainer.style.width = '100%';
        fsdContainer.style.height = '100%';
        body.appendChild(fsdContainer);
        this.failSafeDefaultsControl = this.instantiationService.createInstance(FailSafeDefaultsControl, fsdContainer);
        this._register(this.failSafeDefaultsControl);

        // VIEW 11: Formal Verification (FV)
        const fvContainer = document.createElement('div');
        fvContainer.style.width = '100%';
        fvContainer.style.height = '100%';
        body.appendChild(fvContainer);
        this.formalVerificationControl = this.instantiationService.createInstance(FormalVerificationControl, fvContainer);
        this._register(this.formalVerificationControl);

        // VIEW 6: Void Sidebar (Shared Chat)
        const voidContainer = document.createElement('div');
        voidContainer.style.width = '100%';
        voidContainer.style.height = '100%';
        body.appendChild(voidContainer);

        // Terminal Container (Appended last to be at bottom)
        body.appendChild(this.terminalContainer);


        // Sidebar Navigation Logic
        const sidebarItems: Record<string, HTMLElement> = {};

        const updateView = (view: 'manager' | 'nano' | 'policy' | 'aac' | 'cac' | 'sac' | 'dic' | 'aed' | 'fsd' | 'fv' | 'chat') => {
            // Hide all first
            checksContainer.style.display = 'none';
            voidContainer.style.display = 'none';
            nanoContainer.style.display = 'none';
            policyContainer.style.display = 'none';
            aacContainer.style.display = 'none';
            cacContainer.style.display = 'none';
            sacContainer.style.display = 'none';
            dicContainer.style.display = 'none';
            aedContainer.style.display = 'none';
            fsdContainer.style.display = 'none';
            fvContainer.style.display = 'none';
            this.nanoAgentsControl?.hide();
            this.codeAsPolicyControl?.hide();
            this.architectureAsCodeControl?.hide();
            this.complianceAsCodeControl?.hide();
            this.securityAsCodeControl?.hide();
            this.dataIntegrityControl?.hide();
            this.auditAndEvidenceControl?.hide();
            this.failSafeDefaultsControl?.hide();
            this.formalVerificationControl?.hide();

            // Update Sidebar Selection styles
            Object.keys(sidebarItems).forEach(key => {
                const el = sidebarItems[key];
                // Check against specific hex/rgb if strict, but here we set via logic
                if (key === view) {
                    el.style.backgroundColor = 'var(--vscode-list-activeSelectionBackground)';
                    el.style.color = 'var(--vscode-list-activeSelectionForeground)';
                } else {
                    el.style.backgroundColor = 'transparent';
                    el.style.color = 'var(--vscode-foreground)';
                }
            });

            if (view === 'manager') {
                checksContainer.style.display = 'block';
            } else if (view === 'nano') {
                nanoContainer.style.display = 'block';
                this.nanoAgentsControl?.show();
                this.nanoAgentsControl?.layout(body.clientWidth, body.clientHeight);
            } else if (view === 'policy') {
                policyContainer.style.display = 'block';
                this.codeAsPolicyControl?.show();
                this.codeAsPolicyControl?.layout(body.clientWidth, body.clientHeight);
            } else if (view === 'aac') {
                aacContainer.style.display = 'block';
                this.architectureAsCodeControl?.show();
                this.architectureAsCodeControl?.layout(body.clientWidth, body.clientHeight);
            } else if (view === 'cac') {
                console.log('ChecksManagerPart: Switching to Compliance as Code view');
                cacContainer.style.display = 'block';
                this.complianceAsCodeControl?.show();
                this.complianceAsCodeControl?.layout(body.clientWidth, body.clientHeight);
            } else if (view === 'sac') {
                console.log('ChecksManagerPart: Switching to Security as Code view');
                sacContainer.style.display = 'block';
                this.securityAsCodeControl?.show();
                this.securityAsCodeControl?.layout(body.clientWidth, body.clientHeight);
            } else if (view === 'dic') {
                console.log('ChecksManagerPart: Switching to Data Integrity view');
                dicContainer.style.display = 'block';
                this.dataIntegrityControl?.show();
                this.dataIntegrityControl?.layout(body.clientWidth, body.clientHeight);
            } else if (view === 'aed') {
                console.log('ChecksManagerPart: Switching to Audit & Evidence view');
                aedContainer.style.display = 'block';
                this.auditAndEvidenceControl?.show();
                this.auditAndEvidenceControl?.layout(body.clientWidth, body.clientHeight);
            } else if (view === 'fsd') {
                console.log('ChecksManagerPart: Switching to Fail-Safe Defaults view');
                fsdContainer.style.display = 'block';
                this.failSafeDefaultsControl?.show();
                this.failSafeDefaultsControl?.layout(body.clientWidth, body.clientHeight);
            } else if (view === 'fv') {
                console.log('ChecksManagerPart: Switching to Formal Verification view');
                fvContainer.style.display = 'block';
                this.formalVerificationControl?.show();
                this.formalVerificationControl?.layout(body.clientWidth, body.clientHeight);
            } else {
                voidContainer.style.display = 'block';
            }
        };

        const createSidebarItem = (text: string, viewId: 'manager' | 'nano' | 'policy' | 'aac' | 'cac' | 'sac' | 'dic' | 'aed' | 'fsd' | 'fv' | 'chat') => {
            const item = document.createElement('div');
            item.textContent = text;
            item.style.padding = '8px 15px';
            item.style.cursor = 'pointer';
            item.style.fontSize = '13px';
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.userSelect = 'none';
            item.style.marginBottom = '2px';

            item.addEventListener('click', () => updateView(viewId));

            // Basic hover effect handling
            item.addEventListener('mouseenter', () => {
                // Approximate check. In a real app we might track state more robustly.
                // If it's not the active one (we can check color or just check viewId vs active local var if we hoisted it)
                // But simplified: checking style directly is a bit brittle if we used classes, but here we stick to style.
                // Let's iterate sidebarItems to see if this is the active one?
                // Actually easier: just rely on the fact that if it's active validation will reset it on update.
                // But for hover:
                if (item.style.backgroundColor !== 'var(--vscode-list-activeSelectionBackground)') {
                    item.style.backgroundColor = 'var(--vscode-list-hoverBackground)';
                }
            });
            item.addEventListener('mouseleave', () => {
                if (item.style.backgroundColor === 'var(--vscode-list-hoverBackground)') {
                    item.style.backgroundColor = 'transparent';
                }
            });

            sidebarItems[viewId] = item;
            sidebar.appendChild(item);
        };

        createSidebarItem('Checks', 'manager');
        createSidebarItem('Fail-Safe Defaults', 'fsd');
        createSidebarItem('Security as Code', 'sac');
        createSidebarItem('Formal Verification', 'fv');
        createSidebarItem('Compliance as Code', 'cac');
        createSidebarItem('Audit & Evidence', 'aed');
        createSidebarItem('Policy as Code', 'policy');
        createSidebarItem('Data Integrity', 'dic');
        createSidebarItem('Architecture as Code', 'aac');
        createSidebarItem('Nano Agents', 'nano');
        createSidebarItem('Chat', 'chat');

        // Initialize view
        updateView('manager');

        this.webviewElement = this.webviewService.createWebviewElement({
            title: 'Checks Manager',
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

        this.webviewElement.mountTo(checksContainer, getWindow(checksContainer));
        this.webviewElement.setHtml(this.getDashboardHtml());

        // Handle messages from the dashboard webview (framework import)
        this._register(this.webviewElement.onMessage(async (event) => {
            const msg = event.message as { type: string; json?: string };
            if (msg.type === 'importFramework' && msg.json) {
                const result = await this.grcEngine.importFramework(msg.json);
                if (this.webviewElement) {
                    this.webviewElement.postMessage({
                        type: 'importResult',
                        valid: result.valid,
                        errors: result.errors ?? [],
                        warnings: result.warnings ?? []
                    });
                    // Refresh dashboard to show newly imported framework
                    if (result.valid) {
                        this.webviewElement.setHtml(this.getDashboardHtml());
                    }
                }
            } else if (msg.type === 'toggleAI') {
                this.intelligenceService.setEnabled(!this.intelligenceService.isEnabled);
            }
        }));

        // Subscribe to engine events to refresh dashboard
        this._register(this.grcEngine.onDidCheckComplete(() => {
            if (this.webviewElement) {
                this.webviewElement.setHtml(this.getDashboardHtml());
            }
        }));
        this._register(this.grcEngine.onDidRulesChange(() => {
            if (this.webviewElement) {
                this.webviewElement.setHtml(this.getDashboardHtml());
            }
        }));
        // Refresh when intelligence state changes
        this._register(this.intelligenceService.onDidEnabledChange(() => {
            if (this.webviewElement) {
                this.webviewElement.setHtml(this.getDashboardHtml());
            }
        }));

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
                console.error('ChecksManagerPart: failed to mount sidebar', e);
            }
        });

        // this.registerConfigurationListeners();

        return parent;
    }

    private getDashboardHtml(): string {
        const frameworks = this.grcEngine.getActiveFrameworks();
        const domainSummary = this.grcEngine.getDomainSummary();
        const allResults = this.grcEngine.getAllResults();
        const blockingViolations = this.grcEngine.getBlockingViolations();
        const rules = this.grcEngine.getRules();
        const totalRules = rules.length;
        const totalViolations = allResults.length;
        const passRate = totalRules > 0 ? Math.round(((totalRules - totalViolations) / totalRules) * 100) : 100;
        const totalErrors = domainSummary.reduce((s, d) => s + d.errorCount, 0);
        const totalWarnings = domainSummary.reduce((s, d) => s + d.warningCount, 0);

        // Hybrid Intelligence state
        const aiEnabled = this.intelligenceService.isEnabled;
        const aiAvailable = this.intelligenceService.isAvailable;

        const domainRowsHtml = domainSummary.map(d => {
            const violations = d.errorCount + d.warningCount + d.infoCount;
            const status = violations === 0 ? 'pass' : d.errorCount > 0 ? 'fail' : 'warn';
            const statusLabel = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'WARN';
            return `<tr>
                <td>${this._esc(d.domain)}</td>
                <td class="num">${d.errorCount}</td>
                <td class="num">${d.warningCount}</td>
                <td class="num">${d.infoCount}</td>
                <td class="num">${d.enabledRules}/${d.totalRules}</td>
                <td><span class="status-${status}">${statusLabel}</span></td>
            </tr>`;
        }).join('');

        const fwRowsHtml = frameworks.length > 0
            ? frameworks.map(fw => {
                const fwRuleCount = rules.filter(r => r.frameworkId === fw.id).length;
                return `<tr>
                    <td>${this._esc(fw.id)}</td>
                    <td>${this._esc(fw.name)}</td>
                    <td class="num">${this._esc(fw.version)}</td>
                    <td class="num">${fwRuleCount}</td>
                </tr>`;
            }).join('')
            : `<tr><td colspan="4" class="muted">No frameworks loaded</td></tr>`;

        const blockingRowsHtml = blockingViolations.length > 0
            ? blockingViolations.slice(0, 8).map(v => {
                const file = v.fileUri.path.split('/').pop() || '';
                return `<tr>
                    <td class="mono">${this._esc(file)}:${v.line}</td>
                    <td>${this._esc(v.message)}</td>
                    <td>${this._esc(v.ruleId)}</td>
                </tr>`;
            }).join('')
            : `<tr><td colspan="3" class="muted">No blocking violations</td></tr>`;

        const passColor = passRate >= 80 ? '#73c991' : passRate >= 50 ? '#cca700' : 'var(--error-fg)';

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
:root {
    --fg: var(--vscode-foreground, #ccc);
    --fg-muted: var(--vscode-descriptionForeground, #888);
    --bg: var(--vscode-editor-background, #1e1e1e);
    --bg-alt: var(--vscode-editorWidget-background, #252526);
    --border: var(--vscode-widget-border, #333);
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --input-border: var(--vscode-input-border, #555);
    --input-fg: var(--vscode-input-foreground, #ccc);
    --btn-bg: var(--vscode-button-background, #0e639c);
    --btn-fg: var(--vscode-button-foreground, #fff);
    --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
    --btn-sec-bg: var(--vscode-button-secondaryBackground, #3a3d41);
    --btn-sec-fg: var(--vscode-button-secondaryForeground, #ccc);
    --error-fg: var(--vscode-errorForeground, #f48771);
    --warn-fg: var(--vscode-editorWarning-foreground, #cca700);
    --link: var(--vscode-textLink-foreground, #4fc1ff);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: 12px; line-height: 1.5;
    background: var(--bg); color: var(--fg);
    padding: 16px 20px;
}
.header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 16px; }
.header h1 { font-size: 14px; font-weight: 600; letter-spacing: -0.2px; }
.header .sub { font-size: 11px; color: var(--fg-muted); }
.metrics {
    display: flex; gap: 20px; align-items: center;
    padding: 10px 0; margin-bottom: 14px;
    border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
}
.metric { display: flex; align-items: baseline; gap: 5px; }
.metric-val { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
.metric-label { font-size: 11px; color: var(--fg-muted); }
.metric-val.error { color: var(--error-fg); }
.metric-val.warning { color: var(--warn-fg); }
.metric-val.good { color: #73c991; }
.progress-bar {
    flex: 1; height: 4px; border-radius: 2px;
    background: var(--border); overflow: hidden; margin-left: 8px;
}
.progress-fill { height: 100%; border-radius: 2px; }
.section { margin-bottom: 16px; }
.section-hdr {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 0; margin-bottom: 4px;
}
.section-title {
    font-size: 11px; font-weight: 600; text-transform: uppercase;
    letter-spacing: 0.5px; color: var(--fg-muted);
}
table { width: 100%; border-collapse: collapse; }
th {
    text-align: left; font-size: 11px; font-weight: 500;
    color: var(--fg-muted); padding: 4px 8px 4px 0;
    border-bottom: 1px solid var(--border);
}
td {
    padding: 4px 8px 4px 0; font-size: 12px;
    border-bottom: 1px solid var(--border);
}
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
td.muted { color: var(--fg-muted); font-style: italic; padding: 8px 0; }
tr:last-child td { border-bottom: none; }
.status-pass, .status-fail, .status-warn {
    display: inline-block; font-size: 10px; font-weight: 600;
    padding: 1px 6px; border-radius: 3px; letter-spacing: 0.3px;
}
.status-pass { background: rgba(115,201,145,0.15); color: #73c991; }
.status-fail { background: rgba(244,135,113,0.15); color: var(--error-fg); }
.status-warn { background: rgba(204,167,0,0.15); color: var(--warn-fg); }
.btn {
    font-size: 11px; padding: 4px 10px; border: none; border-radius: 3px;
    cursor: pointer; font-family: inherit;
    background: var(--btn-bg); color: var(--btn-fg);
}
.btn:hover { background: var(--btn-hover); }
.btn-sec { background: var(--btn-sec-bg); color: var(--btn-sec-fg); }
.btn-sec:hover { opacity: 0.9; }
.import-panel {
    display: none; margin-top: 8px; padding: 12px;
    border: 1px solid var(--border); border-radius: 4px;
    background: var(--bg-alt);
}
.import-panel.visible { display: block; }
.import-panel textarea {
    width: 100%; height: 120px; resize: vertical;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px; padding: 8px; margin-bottom: 8px;
}
.import-panel textarea:focus { outline: 1px solid var(--link); }
.import-actions { display: flex; gap: 8px; align-items: center; }
.import-feedback { font-size: 11px; margin-left: 8px; }
.import-feedback.err { color: var(--error-fg); }
.import-feedback.ok { color: #73c991; }
</style>
</head>
<body>
<div class="header">
    <h1>Checks Manager</h1>
    <span class="sub">${totalRules} rules &middot; ${totalViolations} violations &middot; ${frameworks.length} framework${frameworks.length !== 1 ? 's' : ''}</span>
</div>

<div class="metrics">
    <div class="metric">
        <span class="metric-val${passRate >= 80 ? ' good' : passRate >= 50 ? ' warning' : ' error'}">${passRate}%</span>
        <span class="metric-label">pass rate</span>
    </div>
    <div class="progress-bar">
        <div class="progress-fill" style="width:${passRate}%;background:${passColor}"></div>
    </div>
    <div class="metric">
        <span class="metric-val error">${totalErrors}</span>
        <span class="metric-label">errors</span>
    </div>
    <div class="metric">
        <span class="metric-val warning">${totalWarnings}</span>
        <span class="metric-label">warnings</span>
    </div>
    <div class="metric">
        <span class="metric-val${blockingViolations.length > 0 ? ' error' : ' good'}">${blockingViolations.length}</span>
        <span class="metric-label">blocking</span>
    </div>
</div>

<div class="section">
    <div class="section-hdr"><span class="section-title">Domains</span></div>
    <table>
        <thead><tr><th>Domain</th><th class="num">Errors</th><th class="num">Warnings</th><th class="num">Info</th><th class="num">Rules</th><th>Status</th></tr></thead>
        <tbody>${domainRowsHtml || '<tr><td colspan="6" class="muted">No domains discovered</td></tr>'}</tbody>
    </table>
</div>

<div class="section">
    <div class="section-hdr">
        <span class="section-title">Frameworks</span>
        <button class="btn" id="importBtn" onclick="toggleImport()">Import Framework</button>
    </div>
    <div class="import-panel" id="importPanel">
        <textarea id="fwJson" placeholder='Paste framework JSON here...'></textarea>
        <div class="import-actions">
            <button class="btn" onclick="submitImport()">Validate &amp; Import</button>
            <button class="btn btn-sec" onclick="toggleImport()">Cancel</button>
            <span class="import-feedback" id="importFeedback"></span>
        </div>
    </div>
    <table>
        <thead><tr><th>ID</th><th>Name</th><th class="num">Version</th><th class="num">Rules</th></tr></thead>
        <tbody>${fwRowsHtml}</tbody>
    </table>
</div>

<div class="section">
    <div class="section-hdr">
        <span class="section-title">Hybrid Intelligence</span>
        <button class="btn${aiEnabled ? ' btn-sec' : ''}" id="aiToggleBtn" onclick="toggleAI()">${aiEnabled ? 'Disable' : 'Enable'}</button>
    </div>
    <table>
        <thead><tr><th>Property</th><th>Value</th></tr></thead>
        <tbody>
            <tr>
                <td>Status</td>
                <td><span class="status-${aiEnabled ? (aiAvailable ? 'pass' : 'warn') : 'fail'}">${aiEnabled ? (aiAvailable ? 'ACTIVE' : 'PENDING') : 'OFFLINE'}</span></td>
            </tr>
            <tr>
                <td>Mode</td>
                <td>${aiEnabled ? 'Pattern checks + AI enrichment' : 'Pattern checks only'}</td>
            </tr>
            <tr>
                <td>Capabilities</td>
                <td>${aiEnabled ? 'Context-aware explanations, concrete fixes, false positive detection, missed violation discovery' : 'Disabled — enable to activate AI-enhanced analysis'}</td>
            </tr>
            <tr>
                <td>LLM Provider</td>
                <td>${aiEnabled ? 'Uses configured Chat model' : 'N/A'}</td>
            </tr>
        </tbody>
    </table>
</div>

<div class="section">
    <div class="section-hdr"><span class="section-title">Commit Blockers</span></div>
    <table>
        <thead><tr><th>Location</th><th>Message</th><th>Rule</th></tr></thead>
        <tbody>${blockingRowsHtml}</tbody>
    </table>
</div>

<script>
const vscode = acquireVsCodeApi();
function toggleImport() {
    document.getElementById('importPanel').classList.toggle('visible');
    document.getElementById('importFeedback').textContent = '';
}
function toggleAI() {
    vscode.postMessage({ type: 'toggleAI' });
}
function submitImport() {
    const json = document.getElementById('fwJson').value.trim();
    if (!json) return;
    try { JSON.parse(json); } catch (e) {
        showFb('Invalid JSON: ' + e.message, true); return;
    }
    showFb('Importing...', false);
    vscode.postMessage({ type: 'importFramework', json: json });
}
function showFb(msg, isErr) {
    const el = document.getElementById('importFeedback');
    el.textContent = msg;
    el.className = 'import-feedback ' + (isErr ? 'err' : 'ok');
}
window.addEventListener('message', function(ev) {
    var msg = ev.data;
    if (msg.type === 'importResult') {
        if (msg.valid) {
            showFb('Framework imported successfully', false);
            document.getElementById('fwJson').value = '';
        } else {
            showFb((msg.errors || []).join('; ') || 'Validation failed', true);
        }
    }
});
</script>
</body>
</html>`;
    }

    /** HTML-escape to prevent XSS in webview content */
    private _esc(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }


    override layout(width: number, height: number, top: number, left: number): void {
        super.layout(width, height, top, left);
        const sidebarWidth = this.sidebarVisible ? 200 : 0;
        const titlebarHeight = 35;
        // Clamp terminal height to available space if window shrunk
        if (this.terminalVisible && this.terminalHeight > height - titlebarHeight) {
            this.terminalHeight = Math.max(this.minTerminalHeight, height - titlebarHeight - 50);
            if (this.terminalContainer) {
                this.terminalContainer.style.height = `${this.terminalHeight}px`;
            }
        }
        const terminalHeight = this.terminalVisible ? this.terminalHeight : 0;

        // Main content height is reduced by terminal
        const contentHeight = Math.max(0, height - titlebarHeight - terminalHeight);

        this.nanoAgentsControl?.layout(Math.max(0, width - sidebarWidth), contentHeight);
        this.codeAsPolicyControl?.layout(Math.max(0, width - sidebarWidth), contentHeight);
        this.architectureAsCodeControl?.layout(Math.max(0, width - sidebarWidth), contentHeight);
        this.complianceAsCodeControl?.layout(Math.max(0, width - sidebarWidth), contentHeight);
        this.securityAsCodeControl?.layout(Math.max(0, width - sidebarWidth), contentHeight);
        this.dataIntegrityControl?.layout(Math.max(0, width - sidebarWidth), contentHeight);
        this.auditAndEvidenceControl?.layout(Math.max(0, width - sidebarWidth), contentHeight);
        this.failSafeDefaultsControl?.layout(Math.max(0, width - sidebarWidth), contentHeight);
        this.formalVerificationControl?.layout(Math.max(0, width - sidebarWidth), contentHeight);
        this.auditAndEvidenceControl?.layout(Math.max(0, width - sidebarWidth), contentHeight);

        if (this.terminalVisible && this.terminalInstance && this.terminalInstance.xterm) {
            const font = this.terminalInstance.xterm.getFont();
            const headerHeight = 22;
            const availableHeight = Math.max(0, terminalHeight - headerHeight);
            const availableWidth = Math.max(0, width - sidebarWidth); // Use body width

            if (font && font.charWidth && font.charHeight) {
                const cols = Math.floor(availableWidth / font.charWidth);
                const rows = Math.floor(availableHeight / font.charHeight);
                this.terminalInstance.xterm.resize(cols, rows);
            }
        }


        if (this.terminalVisible && this._sash) {
            this._sash.layout();
        }
    }

    public getHorizontalSashTop(sash: Sash): number {
        return 0; // Sash is at top of terminal container
    }

    public getHorizontalSashLeft?(sash: Sash): number {
        return 0;
    }

    public getHorizontalSashWidth?(sash: Sash): number {
        return this.terminalContainer ? this.terminalContainer.clientWidth : 0;
    }

    override toJSON(): object {
        return {
            type: ChecksManagerPart.ID
        };
    }
}

