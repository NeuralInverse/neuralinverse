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
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';

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
    private _currentDomain: string | undefined = undefined;
    private _currentViewMode: 'dashboard' | 'ignore' | 'nano' | 'chat' = 'dashboard';

    constructor(
        @IThemeService themeService: IThemeService,
        @IStorageService storageService: IStorageService,
        @IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
        @IInstantiationService private readonly instantiationService: IInstantiationService,
        @IWebviewService private readonly webviewService: IWebviewService,
        @ITerminalService private readonly terminalService: ITerminalService,
        @IGRCEngineService private readonly grcEngine: IGRCEngineService,
        @IFrameworkIntelligenceService private readonly intelligenceService: IFrameworkIntelligenceService,
        @IEditorService private readonly editorService: IEditorService,
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
        nanoContainer.style.cssText = 'width:100%;height:100%;display:none';
        body.appendChild(nanoContainer);
        this.nanoAgentsControl = this.instantiationService.createInstance(NanoAgentsControl, nanoContainer);
        this._register(this.nanoAgentsControl);

        // Legacy domain containers — kept for controls that may be reused, but hidden by default
        const makeHiddenDiv = () => { const d = document.createElement('div'); d.style.cssText = 'width:100%;height:100%;display:none'; body.appendChild(d); return d; };
        const policyContainer = makeHiddenDiv();
        this.codeAsPolicyControl = this.instantiationService.createInstance(CodeAsPolicyControl, policyContainer);
        this._register(this.codeAsPolicyControl);

        const aacContainer = makeHiddenDiv();
        this.architectureAsCodeControl = this.instantiationService.createInstance(ArchitectureAsCodeControl, aacContainer);
        this._register(this.architectureAsCodeControl);

        const cacContainer = makeHiddenDiv();
        this.complianceAsCodeControl = this.instantiationService.createInstance(ComplianceAsCodeControl, cacContainer);
        this._register(this.complianceAsCodeControl);

        const sacContainer = makeHiddenDiv();
        this.securityAsCodeControl = this.instantiationService.createInstance(SecurityAsCodeControl, sacContainer);
        this._register(this.securityAsCodeControl);

        const dicContainer = makeHiddenDiv();
        this.dataIntegrityControl = this.instantiationService.createInstance(DataIntegrityControl, dicContainer);
        this._register(this.dataIntegrityControl);

        const aedContainer = makeHiddenDiv();
        this.auditAndEvidenceControl = this.instantiationService.createInstance(AuditAndEvidenceControl, aedContainer);
        this._register(this.auditAndEvidenceControl);

        const fsdContainer = makeHiddenDiv();
        this.failSafeDefaultsControl = this.instantiationService.createInstance(FailSafeDefaultsControl, fsdContainer);
        this._register(this.failSafeDefaultsControl);

        const fvContainer = makeHiddenDiv();
        this.formalVerificationControl = this.instantiationService.createInstance(FormalVerificationControl, fvContainer);
        this._register(this.formalVerificationControl);

        // VIEW: Void Sidebar (Chat) — hidden until selected
        const voidContainer = document.createElement('div');
        voidContainer.style.cssText = 'width:100%;height:100%;display:none';
        body.appendChild(voidContainer);

        // Terminal Container (Appended last to be at bottom)
        body.appendChild(this.terminalContainer);


        // ── Sidebar Navigation ────────────────────────────────────────
        type ViewId = 'all' | 'security' | 'compliance' | 'policy' | 'architecture' | 'data-integrity' | 'fail-safe' | 'reliability' | 'availability' | 'processing-integrity' | 'confidentiality' | 'ignore' | 'nano' | 'chat';
        const DOMAIN_MAP: Partial<Record<ViewId, string>> = {
            security: 'security', compliance: 'compliance', policy: 'policy',
            architecture: 'architecture', 'data-integrity': 'data-integrity',
            'fail-safe': 'fail-safe', reliability: 'reliability',
            availability: 'availability', 'processing-integrity': 'processing-integrity',
            confidentiality: 'confidentiality',
        };
        const sidebarItems: Partial<Record<ViewId, HTMLElement>> = {};

        const refreshWebview = () => {
            if (!this.webviewElement) return;
            if (this._currentViewMode === 'ignore') {
                this.webviewElement.setHtml(this.getIgnoreHtml());
            } else if (this._currentViewMode === 'dashboard') {
                this.webviewElement.setHtml(this.getDashboardHtml(this._currentDomain));
            }
        };

        const updateView = (view: ViewId) => {
            // Update active sidebar highlight
            (Object.keys(sidebarItems) as ViewId[]).forEach(k => {
                const el = sidebarItems[k]!;
                el.style.backgroundColor = k === view ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent';
                el.style.color = k === view ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)';
            });

            // Hide ALL body containers — webview/nano/void are the only active views now
            [checksContainer, nanoContainer, voidContainer,
             policyContainer, aacContainer, cacContainer, sacContainer,
             dicContainer, aedContainer, fsdContainer, fvContainer
            ].forEach(el => { el.style.display = 'none'; });
            this.nanoAgentsControl?.hide();
            this.codeAsPolicyControl?.hide();
            this.architectureAsCodeControl?.hide();
            this.complianceAsCodeControl?.hide();
            this.securityAsCodeControl?.hide();
            this.dataIntegrityControl?.hide();
            this.auditAndEvidenceControl?.hide();
            this.failSafeDefaultsControl?.hide();
            this.formalVerificationControl?.hide();

            if (view === 'nano') {
                nanoContainer.style.display = 'block';
                this.nanoAgentsControl?.show();
                this.nanoAgentsControl?.layout(body.clientWidth, body.clientHeight);
                this._currentViewMode = 'nano';
            } else if (view === 'chat') {
                voidContainer.style.display = 'block';
                this._currentViewMode = 'chat';
            } else if (view === 'ignore') {
                checksContainer.style.display = 'block';
                this._currentViewMode = 'ignore';
                this._currentDomain = undefined;
                refreshWebview();
            } else {
                checksContainer.style.display = 'block';
                this._currentViewMode = 'dashboard';
                this._currentDomain = DOMAIN_MAP[view];
                refreshWebview();
            }
        };

        const addSidebarLabel = (text: string) => {
            const label = document.createElement('div');
            label.textContent = text;
            label.style.padding = '12px 12px 4px';
            label.style.fontSize = '10px';
            label.style.fontWeight = '700';
            label.style.textTransform = 'uppercase';
            label.style.letterSpacing = '0.5px';
            label.style.opacity = '0.45';
            label.style.userSelect = 'none';
            sidebar.appendChild(label);
        };

        const createSidebarItem = (text: string, viewId: ViewId, icon?: string) => {
            const item = document.createElement('div');
            item.style.padding = '6px 12px 6px 14px';
            item.style.cursor = 'pointer';
            item.style.fontSize = '12px';
            item.style.display = 'flex';
            item.style.alignItems = 'center';
            item.style.gap = '6px';
            item.style.userSelect = 'none';
            item.style.borderRadius = '4px';
            item.style.margin = '1px 6px';
            item.style.color = 'var(--vscode-foreground)';
            item.style.transition = 'background 0.1s';
            if (icon) {
                const iconSpan = document.createElement('span');
                iconSpan.textContent = icon;
                iconSpan.style.fontSize = '11px';
                iconSpan.style.opacity = '0.7';
                iconSpan.style.flexShrink = '0';
                item.appendChild(iconSpan);
            }
            const textSpan = document.createElement('span');
            textSpan.textContent = text;
            item.appendChild(textSpan);
            item.addEventListener('click', () => updateView(viewId));
            item.addEventListener('mouseenter', () => {
                if (item.style.backgroundColor !== 'var(--vscode-list-activeSelectionBackground)') {
                    item.style.backgroundColor = 'var(--vscode-list-hoverBackground)';
                }
            });
            item.addEventListener('mouseleave', () => {
                if (item.style.backgroundColor !== 'var(--vscode-list-activeSelectionBackground)') {
                    item.style.backgroundColor = 'transparent';
                }
            });
            sidebarItems[viewId] = item;
            sidebar.appendChild(item);
        };

        // Build sidebar sections
        addSidebarLabel('Overview');
        createSidebarItem('All Checks', 'all', '⬡');

        addSidebarLabel('Domains');
        createSidebarItem('Security', 'security', '⚔');
        createSidebarItem('Compliance', 'compliance', '⚖');
        createSidebarItem('Architecture', 'architecture', '◈');
        createSidebarItem('Data Integrity', 'data-integrity', '⊕');
        createSidebarItem('Policy', 'policy', '≡');
        createSidebarItem('Fail-Safe', 'fail-safe', '⊘');
        createSidebarItem('Reliability', 'reliability', '⟳');
        createSidebarItem('Availability', 'availability', '◎');
        createSidebarItem('Confidentiality', 'confidentiality', '⊛');
        createSidebarItem('Processing Integrity', 'processing-integrity', '⊞');

        addSidebarLabel('Settings');
        createSidebarItem('Ignore Rules', 'ignore', '⊖');

        addSidebarLabel('Tools');
        createSidebarItem('Nano Agents', 'nano', '◇');
        createSidebarItem('Chat', 'chat', '◉');

        // Initialize view
        updateView('all');

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
        this.webviewElement.setHtml(this.getDashboardHtml(undefined));

        // Handle messages from the webview
        this._register(this.webviewElement.onMessage(async (event) => {
            const msg = event.message as { type: string; json?: string; pattern?: string };
            if (msg.type === 'importFramework' && msg.json) {
                const result = await this.grcEngine.importFramework(msg.json);
                if (this.webviewElement) {
                    this.webviewElement.postMessage({
                        type: 'importResult',
                        valid: result.valid,
                        errors: result.errors ?? [],
                        warnings: result.warnings ?? []
                    });
                    if (result.valid) refreshWebview();
                }
            } else if (msg.type === 'toggleAI') {
                this.intelligenceService.setEnabled(!this.intelligenceService.isEnabled);
            } else if (msg.type === 'navigateToFile') {
                try {
                    const nav = msg as { type: string; uri: string; line: number; col: number };
                    const resource = URI.parse(nav.uri);
                    this.editorService.openEditor({
                        resource,
                        options: {
                            selection: {
                                startLineNumber: nav.line, startColumn: nav.col,
                                endLineNumber: nav.line,   endColumn: nav.col,
                            },
                            preserveFocus: false,
                        }
                    });
                } catch (e) {
                    console.error('[ChecksManagerPart] navigateToFile failed:', e);
                }
            } else if (msg.type === 'scanWorkspace') {
                this.grcEngine.scanWorkspace().catch(e => console.error('[ChecksManagerPart] scanWorkspace failed:', e));
            } else if (msg.type === 'addIgnorePattern' && msg.pattern) {
                this.grcEngine.addIgnorePattern(msg.pattern);
                // ignore view will auto-refresh via onDidRulesChange
            } else if (msg.type === 'removeIgnorePattern' && msg.pattern) {
                this.grcEngine.removeIgnorePattern(msg.pattern);
            }
        }));

        // Subscribe to engine events
        this._register(this.grcEngine.onDidCheckComplete(() => refreshWebview()));
        this._register(this.grcEngine.onDidRulesChange(() => refreshWebview()));
        this._register(this.intelligenceService.onDidEnabledChange(() => refreshWebview()));

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

    private getDashboardHtml(domainFilter?: string): string {
        const frameworks = this.grcEngine.getActiveFrameworks();
        const domainSummary = this.grcEngine.getDomainSummary();
        const allResultsRaw = this.grcEngine.getAllResults();
        // Apply domain filter if set
        const allResults = domainFilter
            ? allResultsRaw.filter(r => (r.domain || 'general') === domainFilter)
            : allResultsRaw;
        const blockingViolations = this.grcEngine.getBlockingViolations()
            .filter(v => !domainFilter || (v.domain || 'general') === domainFilter);
        const rules = this.grcEngine.getRules();
        const totalRules = rules.length;
        const totalViolations = allResults.length;

        // Pass rate = % of rules with zero violations (meaningful metric)
        const violatedRuleIds = new Set(allResults.map(r => r.ruleId));
        const passingRules = Math.max(0, totalRules - violatedRuleIds.size);
        const passRate = totalRules > 0 ? Math.round((passingRules / totalRules) * 100) : 100;
        const passColor = passRate >= 80 ? '#73c991' : passRate >= 50 ? '#cca700' : '#f48771';

        const totalErrors = allResults.filter(r => r.severity === 'error').length;
        const totalWarnings = allResults.filter(r => r.severity === 'warning').length;

        // Hybrid Intelligence state
        const aiEnabled = this.intelligenceService.isEnabled;
        const aiAvailable = this.intelligenceService.isAvailable;

        // ── Language & source coverage ────────────────────────────────
        const langSet = new Set<string>();
        for (const r of allResults) {
            const ext = r.fileUri.path.split('.').pop()?.toLowerCase();
            if (ext && ext.length <= 6) langSet.add(ext.toUpperCase());
        }
        const langTagsHtml = [...langSet].slice(0, 10).map(e => `<span class="cov-tag lang-tag">${this._esc(e)}</span>`).join('');
        const hasStatic = allResults.some(r => !r.checkSource || r.checkSource === 'static');
        const hasAI = allResults.some(r => r.checkSource === 'ai');
        const hasBreaking = allResults.some(r => r.checkSource === 'breaking' || r.isBreakingChange);
        const srcTagsHtml = [
            hasStatic   ? `<span class="cov-tag src-static">STATIC</span>` : '',
            hasAI       ? `<span class="cov-tag src-ai">AI</span>` : '',
            hasBreaking ? `<span class="cov-tag src-break">BREAK</span>` : '',
        ].filter(Boolean).join('');

        // ── Domain filter chips ───────────────────────────────────────
        const domainCounts = new Map<string, number>();
        for (const r of allResults) {
            const d = r.domain || 'general';
            domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
        }
        const domainChipsHtml = [
            `<span class="dom-chip active" data-d="" onclick="filterDomain(this,'')">All <span class="chip-n">${totalViolations}</span></span>`,
            ...[...domainCounts.entries()].map(([d, n]) =>
                `<span class="dom-chip" data-d="${this._esc(d)}" onclick="filterDomain(this,'${this._jsesc(d)}')">${this._esc(d)} <span class="chip-n">${n}</span></span>`
            )
        ].join('');

        // ── Domain summary table ──────────────────────────────────────
        const domainRowsHtml = domainSummary.map(d => {
            const violations = d.errorCount + d.warningCount + d.infoCount;
            const status = violations === 0 ? 'pass' : d.errorCount > 0 ? 'fail' : 'warn';
            return `<tr>
                <td>${this._esc(d.domain)}</td>
                <td class="num">${d.errorCount}</td>
                <td class="num">${d.warningCount}</td>
                <td class="num">${d.infoCount}</td>
                <td class="num">${d.enabledRules}/${d.totalRules}</td>
                <td><span class="badge-${status}">${status.toUpperCase()}</span></td>
            </tr>`;
        }).join('');

        // ── Frameworks table ──────────────────────────────────────────
        const fwRowsHtml = frameworks.length > 0
            ? frameworks.map(fw => {
                const fwRuleCount = rules.filter(r => r.frameworkId === fw.id).length;
                return `<tr>
                    <td class="mono">${this._esc(fw.id)}</td>
                    <td>${this._esc(fw.name)}</td>
                    <td class="num">${this._esc(fw.version)}</td>
                    <td class="num">${fwRuleCount}</td>
                </tr>`;
            }).join('')
            : `<tr><td colspan="4" class="muted">No frameworks loaded</td></tr>`;

        // ── Commit blockers ───────────────────────────────────────────
        const blockingRowsHtml = blockingViolations.length > 0
            ? blockingViolations.slice(0, 10).map(v => {
                const file = v.fileUri.path.split('/').pop() || '';
                const shortMsg = v.message.split('\n')[0].replace(/^\[[\w-]+\]\s*/, '').substring(0, 100);
                return `<tr>
                    <td class="mono nav-link" onclick="navigate('${this._jsesc(v.fileUri.toString())}',${v.line},${v.column})">${this._esc(file)}:${v.line}</td>
                    <td>${this._esc(shortMsg)}</td>
                    <td class="mono">${this._esc(v.ruleId)}</td>
                </tr>`;
            }).join('')
            : `<tr><td colspan="3" class="muted">No blocking violations</td></tr>`;

        // ── Violations list grouped by file ───────────────────────────
        const sorted = [...allResults].sort((a, b) => {
            const ord = { error: 0, warning: 1, info: 2 } as Record<string, number>;
            return (ord[a.severity] ?? 2) - (ord[b.severity] ?? 2);
        });
        const byFile = new Map<string, typeof sorted>();
        for (const r of sorted) {
            const k = r.fileUri.toString();
            if (!byFile.has(k)) byFile.set(k, []);
            byFile.get(k)!.push(r);
        }

        let violListHtml = '';
        for (const [, fileResults] of byFile) {
            const first = fileResults[0];
            const fileName = first.fileUri.path.split('/').pop() ?? first.fileUri.path;
            const dirParts = first.fileUri.path.replace(/\/[^/]+$/, '').split('/');
            const dirPath = dirParts.slice(-2).join('/');
            const domain = first.domain || 'general';
            const errCount  = fileResults.filter(r => r.severity === 'error').length;
            const warnCount = fileResults.filter(r => r.severity === 'warning').length;
            const autoCollapsed = fileResults.length > 4 ? ' collapsed' : '';

            const itemsHtml = fileResults.map(r => {
                const sevCls = r.severity === 'error' ? 'sev-err' : r.severity === 'warning' ? 'sev-warn' : 'sev-info';
                const srcBadge = (r.checkSource === 'breaking' || r.isBreakingChange)
                    ? '<span class="src-badge src-break">BREAK</span>'
                    : r.checkSource === 'ai'
                    ? '<span class="src-badge src-ai">AI</span>'
                    : '<span class="src-badge src-static">STATIC</span>';
                const shortMsg = r.message.split('\n')[0].replace(/^\[[\w-]+\]\s*/, '').substring(0, 120);
                return `<div class="viol ${sevCls}" onclick="navigate('${this._jsesc(r.fileUri.toString())}',${r.line},${r.column})">
                    <div class="viol-top">
                        <span class="rule-id">${this._esc(r.ruleId)}</span>
                        ${srcBadge}
                        <span class="viol-msg">${this._esc(shortMsg)}</span>
                    </div>
                    <div class="viol-loc">${this._esc(fileName)}:${r.line}</div>
                </div>`;
            }).join('');

            violListHtml += `<div class="file-group${autoCollapsed}" data-d="${this._esc(domain)}">
                <div class="file-hdr" onclick="this.parentElement.classList.toggle('collapsed')">
                    <span class="collapse-icon">▾</span>
                    <span class="file-name">${this._esc(fileName)}</span>
                    <span class="file-dir">${this._esc(dirPath)}</span>
                    <span class="file-counts">
                        ${errCount  > 0 ? `<span class="fc-err">${errCount}✖</span>` : ''}
                        ${warnCount > 0 ? `<span class="fc-warn">${warnCount}⚠</span>` : ''}
                    </span>
                </div>
                <div class="file-items">${itemsHtml}</div>
            </div>`;
        }

        if (!violListHtml) {
            violListHtml = '<div class="muted" style="padding:12px 0;text-align:center">No violations found — all checks passing</div>';
        }

        const viewTitle = domainFilter
            ? domainFilter.charAt(0).toUpperCase() + domainFilter.slice(1).replace(/-/g, ' ')
            : 'All Checks';

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
:root {
    --fg:       var(--vscode-foreground, #ccc);
    --fg-muted: var(--vscode-descriptionForeground, #888);
    --bg:       var(--vscode-editor-background, #1e1e1e);
    --bg-alt:   var(--vscode-editorWidget-background, #252526);
    --border:   var(--vscode-widget-border, #333);
    --input-bg: var(--vscode-input-background, #3c3c3c);
    --input-bd: var(--vscode-input-border, #555);
    --input-fg: var(--vscode-input-foreground, #ccc);
    --btn-bg:   var(--vscode-button-background, #0e639c);
    --btn-fg:   var(--vscode-button-foreground, #fff);
    --btn-hov:  var(--vscode-button-hoverBackground, #1177bb);
    --btn2-bg:  var(--vscode-button-secondaryBackground, #3a3d41);
    --btn2-fg:  var(--vscode-button-secondaryForeground, #ccc);
    --err:  #f48771; --warn: #cca700; --info: #4fc1ff; --ok: #73c991;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    font-size: 12px; line-height: 1.5;
    background: var(--bg); color: var(--fg);
    padding: 14px 18px 24px;
}

/* ── Header ── */
.hdr { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.hdr-title { font-size: 14px; font-weight: 600; }
.hdr-sub { font-size: 11px; color: var(--fg-muted); }
.hdr-badge {
    margin-left: auto; font-size: 10px; font-weight: 700;
    padding: 2px 8px; border-radius: 3px; letter-spacing: 0.5px;
}
.hdr-badge.ok   { background: rgba(115,201,145,.15); color: var(--ok); border: 1px solid rgba(115,201,145,.3); }
.hdr-badge.warn { background: rgba(204,167,0,.15);   color: var(--warn); border: 1px solid rgba(204,167,0,.3); }
.hdr-badge.err  { background: rgba(244,135,113,.15); color: var(--err); border: 1px solid rgba(244,135,113,.3); }

/* ── Metrics bar ── */
.metrics {
    display: flex; gap: 16px; align-items: center;
    padding: 9px 0; margin-bottom: 12px;
    border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
}
.metric { display: flex; align-items: baseline; gap: 4px; }
.m-val  { font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
.m-lbl  { font-size: 11px; color: var(--fg-muted); }
.m-val.err  { color: var(--err); }
.m-val.warn { color: var(--warn); }
.m-val.ok   { color: var(--ok); }
.prog-bar { flex: 1; height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; }
.prog-fill { height: 100%; border-radius: 2px; }

/* ── Coverage strip ── */
.coverage {
    display: flex; gap: 12px; align-items: center;
    padding: 7px 10px; margin-bottom: 12px;
    background: var(--bg-alt); border: 1px solid var(--border); border-radius: 4px;
    flex-wrap: wrap;
}
.cov-row { display: flex; align-items: center; gap: 6px; }
.cov-label { font-size: 9px; text-transform: uppercase; letter-spacing: .4px; opacity: .5; width: 52px; flex-shrink: 0; }
.cov-tags  { display: flex; flex-wrap: wrap; gap: 4px; }
.cov-tag {
    font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 2px;
}
.lang-tag   { background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.12); color: var(--fg); }
.src-static { background: rgba(96,125,139,.25);  border: 1px solid rgba(96,125,139,.4);  color: #b0bec5; }
.src-ai     { background: rgba(103,58,183,.25);  border: 1px solid rgba(103,58,183,.45); color: #ce93d8; }
.src-break  { background: rgba(244,67,54,.2);    border: 1px solid rgba(244,67,54,.4);   color: #ef9a9a; }

/* ── Domain filter chips ── */
.dom-bar { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 12px; }
.dom-chip {
    font-size: 10px; font-weight: 500; padding: 3px 9px; border-radius: 10px;
    cursor: pointer; border: 1px solid var(--border);
    background: var(--bg-alt); color: var(--fg-muted);
    transition: all 0.12s;
}
.dom-chip:hover { color: var(--fg); border-color: rgba(255,255,255,.2); }
.dom-chip.active { background: rgba(79,193,255,.12); color: var(--info); border-color: rgba(79,193,255,.35); }
.chip-n { font-size: 9px; opacity: .7; margin-left: 2px; }

/* ── Section ── */
.section { margin-bottom: 18px; }
.sec-hdr {
    display: flex; align-items: center; justify-content: space-between;
    padding: 5px 0; margin-bottom: 6px;
    border-bottom: 1px solid var(--border);
}
.sec-title {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .6px; color: var(--fg-muted);
}

/* ── Violations list ── */
.viol-list { display: flex; flex-direction: column; gap: 5px; }

.file-group { border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.file-hdr {
    display: flex; align-items: center; gap: 6px;
    padding: 5px 8px; cursor: pointer; user-select: none;
    background: var(--bg-alt); font-size: 11px;
}
.file-hdr:hover { background: rgba(255,255,255,.04); }
.collapse-icon { font-size: 10px; opacity: .6; flex-shrink: 0; transition: transform .15s; }
.file-group.collapsed .collapse-icon { transform: rotate(-90deg); }
.file-group.collapsed .file-items { display: none; }
.file-name  { font-weight: 700; flex-shrink: 0; }
.file-dir   { font-size: 10px; opacity: .4; font-family: var(--vscode-editor-font-family, monospace); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-counts { display: flex; gap: 5px; margin-left: auto; flex-shrink: 0; }
.fc-err  { color: #ef9a9a; font-size: 10px; font-weight: 700; }
.fc-warn { color: #ffcc80; font-size: 10px; font-weight: 700; }

.file-items { display: flex; flex-direction: column; }
.viol {
    display: flex; flex-direction: column; gap: 2px;
    padding: 5px 8px 5px 10px; border-left: 3px solid transparent;
    cursor: pointer; font-size: 11px; line-height: 1.4;
}
.viol:hover { background: rgba(255,255,255,.03); }
.viol + .viol { border-top: 1px solid var(--border); }
.sev-err  { border-left-color: #ef5350; }
.sev-warn { border-left-color: #ffa726; }
.sev-info { border-left-color: #42a5f5; }
.viol-top { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.rule-id {
    font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 2px;
    background: rgba(255,255,255,.07); color: var(--fg); flex-shrink: 0;
    font-family: var(--vscode-editor-font-family, monospace);
}
.src-badge { font-size: 8px; font-weight: 800; padding: 1px 4px; border-radius: 2px; flex-shrink: 0; }
.viol-msg { font-size: 11px; opacity: .85; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.viol-loc {
    font-size: 9px; font-family: var(--vscode-editor-font-family, monospace);
    color: var(--info); opacity: .65; padding-left: 1px;
}
.viol:hover .viol-loc { opacity: 1; text-decoration: underline; }

/* ── Tables ── */
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font-size: 11px; font-weight: 500; color: var(--fg-muted); padding: 4px 8px 4px 0; border-bottom: 1px solid var(--border); }
td { padding: 4px 8px 4px 0; font-size: 12px; border-bottom: 1px solid var(--border); }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
td.muted, div.muted { color: var(--fg-muted); font-style: italic; }
tr:last-child td { border-bottom: none; }
.nav-link { cursor: pointer; color: var(--info); }
.nav-link:hover { text-decoration: underline; }

/* ── Status badges ── */
.badge-pass, .badge-fail, .badge-warn {
    display: inline-block; font-size: 10px; font-weight: 600;
    padding: 1px 6px; border-radius: 3px; letter-spacing: .3px;
}
.badge-pass { background: rgba(115,201,145,.15); color: var(--ok); }
.badge-fail { background: rgba(244,135,113,.15); color: var(--err); }
.badge-warn { background: rgba(204,167,0,.15);   color: var(--warn); }

/* ── Buttons ── */
.btn { font-size: 11px; padding: 4px 10px; border: none; border-radius: 3px; cursor: pointer; font-family: inherit; background: var(--btn-bg); color: var(--btn-fg); }
.btn:hover { background: var(--btn-hov); }
.btn-sec { background: var(--btn2-bg); color: var(--btn2-fg); }
.btn-sec:hover { opacity: 0.9; }
.btn-scan { margin-left: auto; background: rgba(79,193,255,.12); color: var(--info); border: 1px solid rgba(79,193,255,.3); }
.btn-scan:hover { background: rgba(79,193,255,.2); }
.btn-scan.scanning { opacity: .6; cursor: default; }

/* ── Import panel ── */
.import-panel { display: none; margin-top: 8px; padding: 12px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-alt); }
.import-panel.visible { display: block; }
.import-panel textarea { width: 100%; height: 120px; resize: vertical; background: var(--input-bg); color: var(--input-fg); border: 1px solid var(--input-bd); border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; padding: 8px; margin-bottom: 8px; }
.import-panel textarea:focus { outline: 1px solid var(--info); }
.import-actions { display: flex; gap: 8px; align-items: center; }
.import-feedback { font-size: 11px; margin-left: 8px; }
.import-feedback.err { color: var(--err); }
.import-feedback.ok  { color: var(--ok); }
</style>
</head>
<body>

<div class="hdr">
    <span class="hdr-title">${this._esc(viewTitle)}</span>
    <span class="hdr-sub">${totalRules} rules &middot; ${frameworks.length} framework${frameworks.length !== 1 ? 's' : ''}</span>
    <span class="hdr-badge ${passRate >= 80 ? 'ok' : passRate >= 50 ? 'warn' : 'err'}">${totalViolations === 0 ? 'ALL CLEAR' : totalViolations + ' VIOLATIONS'}</span>
    <button class="btn btn-scan" onclick="scanWorkspace()" id="scanBtn">⟳ Scan Workspace</button>
</div>

<div class="metrics">
    <div class="metric">
        <span class="m-val ${passRate >= 80 ? 'ok' : passRate >= 50 ? 'warn' : 'err'}">${passRate}%</span>
        <span class="m-lbl">rules passing</span>
    </div>
    <div class="prog-bar">
        <div class="prog-fill" style="width:${passRate}%;background:${passColor}"></div>
    </div>
    <div class="metric"><span class="m-val err">${totalErrors}</span><span class="m-lbl">errors</span></div>
    <div class="metric"><span class="m-val warn">${totalWarnings}</span><span class="m-lbl">warnings</span></div>
    <div class="metric"><span class="m-val ${blockingViolations.length > 0 ? 'err' : 'ok'}">${blockingViolations.length}</span><span class="m-lbl">blocking</span></div>
</div>

${totalViolations > 0 ? `
<div class="coverage">
    <div class="cov-row">
        <span class="cov-label">Languages</span>
        <div class="cov-tags">${langTagsHtml || '<span style="opacity:.4;font-size:9px;font-style:italic">none</span>'}</div>
    </div>
    <div class="cov-row">
        <span class="cov-label">Analysis</span>
        <div class="cov-tags">${srcTagsHtml || '<span style="opacity:.4;font-size:9px;font-style:italic">none</span>'}</div>
    </div>
</div>

<div class="section">
    <div class="sec-hdr"><span class="sec-title">Violations</span></div>
    <div class="dom-bar">${domainChipsHtml}</div>
    <div class="viol-list" id="violList">${violListHtml}</div>
</div>
` : ''}

<div class="section">
    <div class="sec-hdr"><span class="sec-title">Domains</span></div>
    <table>
        <thead><tr><th>Domain</th><th class="num">Errors</th><th class="num">Warnings</th><th class="num">Info</th><th class="num">Rules</th><th>Status</th></tr></thead>
        <tbody>${domainRowsHtml || '<tr><td colspan="6" class="muted">No domains discovered</td></tr>'}</tbody>
    </table>
</div>

<div class="section">
    <div class="sec-hdr">
        <span class="sec-title">Frameworks</span>
        <button class="btn" onclick="toggleImport()">Import Framework</button>
    </div>
    <div class="import-panel" id="importPanel">
        <textarea id="fwJson" placeholder="Paste framework JSON here..."></textarea>
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
    <div class="sec-hdr">
        <span class="sec-title">Hybrid Intelligence</span>
        <button class="btn${aiEnabled ? ' btn-sec' : ''}" onclick="toggleAI()">${aiEnabled ? 'Disable' : 'Enable'}</button>
    </div>
    <table>
        <tbody>
            <tr><td style="width:130px;color:var(--fg-muted)">Status</td><td><span class="badge-${aiEnabled ? (aiAvailable ? 'pass' : 'warn') : 'fail'}">${aiEnabled ? (aiAvailable ? 'ACTIVE' : 'PENDING') : 'OFFLINE'}</span></td></tr>
            <tr><td style="color:var(--fg-muted)">Mode</td><td>${aiEnabled ? 'Pattern checks + AI enrichment' : 'Pattern checks only'}</td></tr>
            <tr><td style="color:var(--fg-muted)">Capabilities</td><td>${aiEnabled ? 'Context-aware explanations, concrete fixes, false positive detection, missed violations' : 'Disabled — enable to activate AI-enhanced analysis'}</td></tr>
            <tr><td style="color:var(--fg-muted)">LLM Provider</td><td>${aiEnabled ? 'Uses configured Chat model' : 'N/A'}</td></tr>
        </tbody>
    </table>
</div>

<div class="section">
    <div class="sec-hdr"><span class="sec-title">Commit Blockers</span></div>
    <table>
        <thead><tr><th>Location</th><th>Message</th><th>Rule</th></tr></thead>
        <tbody>${blockingRowsHtml}</tbody>
    </table>
</div>

<script>
const vscode = acquireVsCodeApi();

function navigate(uri, line, col) {
    vscode.postMessage({ type: 'navigateToFile', uri, line, col });
}

function scanWorkspace() {
    const btn = document.getElementById('scanBtn');
    if (btn) { btn.textContent = '⟳ Scanning...'; btn.classList.add('scanning'); btn.disabled = true; }
    vscode.postMessage({ type: 'scanWorkspace' });
}

function filterDomain(chipEl, d) {
    document.querySelectorAll('.dom-chip').forEach(el => el.classList.remove('active'));
    chipEl.classList.add('active');
    document.querySelectorAll('#violList .file-group').forEach(el => {
        el.style.display = (!d || el.dataset.d === d) ? '' : 'none';
    });
}

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
    vscode.postMessage({ type: 'importFramework', json });
}

function showFb(msg, isErr) {
    const el = document.getElementById('importFeedback');
    el.textContent = msg;
    el.className = 'import-feedback ' + (isErr ? 'err' : 'ok');
}

window.addEventListener('message', function(ev) {
    const msg = ev.data;
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

    private getIgnoreHtml(): string {
        const patterns = this.grcEngine.getIgnorePatterns();
        const rowsHtml = patterns.length > 0
            ? patterns.map(p => `
                <div class="ignore-row">
                    <span class="ignore-pattern">${this._esc(p)}</span>
                    <button class="btn-remove" onclick="removePattern('${this._jsesc(p)}')" title="Remove">✕</button>
                </div>`).join('')
            : '<div class="empty-state">No patterns configured — all files are scanned.</div>';

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
    --input-bd: var(--vscode-input-border, #555);
    --input-fg: var(--vscode-input-foreground, #ccc);
    --btn-bg: var(--vscode-button-background, #0e639c);
    --btn-fg: var(--vscode-button-foreground, #fff);
    --err: #f48771; --info: #4fc1ff; --ok: #73c991;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family, -apple-system, sans-serif);
    font-size: 12px; line-height: 1.5;
    background: var(--bg); color: var(--fg);
    padding: 20px 22px;
}
.hdr { margin-bottom: 6px; }
.hdr-title { font-size: 14px; font-weight: 600; }
.hdr-sub { font-size: 11px; color: var(--fg-muted); margin-top: 4px; line-height: 1.6; }
.section { margin-top: 20px; }
.sec-title {
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .6px; color: var(--fg-muted);
    padding-bottom: 6px; border-bottom: 1px solid var(--border); margin-bottom: 10px;
}
.add-row { display: flex; gap: 8px; margin-bottom: 16px; }
.add-row input {
    flex: 1; background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-bd); border-radius: 3px;
    padding: 5px 8px; font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
}
.add-row input:focus { outline: 1px solid var(--info); }
.btn-add {
    font-size: 11px; padding: 5px 12px; border: none; border-radius: 3px;
    cursor: pointer; font-family: inherit;
    background: var(--btn-bg); color: var(--btn-fg);
}
.btn-add:hover { opacity: 0.9; }
.ignore-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 7px 10px; border: 1px solid var(--border); border-radius: 3px;
    margin-bottom: 4px; background: var(--bg-alt);
}
.ignore-pattern {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px; color: var(--fg);
}
.btn-remove {
    background: none; border: none; cursor: pointer; color: var(--err);
    font-size: 12px; padding: 2px 4px; opacity: .7; line-height: 1;
}
.btn-remove:hover { opacity: 1; }
.empty-state { font-size: 11px; color: var(--fg-muted); font-style: italic; padding: 12px 0; }
.hint-list { display: flex; flex-direction: column; gap: 5px; }
.hint {
    font-size: 11px; padding: 5px 10px; border-radius: 3px;
    border: 1px solid var(--border); background: var(--bg-alt);
    opacity: .75; display: flex; justify-content: space-between; align-items: center; gap: 8px;
}
.hint code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: rgba(255,255,255,.08); padding: 1px 5px; border-radius: 2px; font-size: 10px;
}
.hint-add {
    font-size: 9px; padding: 1px 6px; border: none; border-radius: 2px;
    cursor: pointer; background: rgba(79,193,255,.15); color: var(--info); flex-shrink: 0;
}
.hint-add:hover { background: rgba(79,193,255,.25); }
.feedback { font-size: 11px; margin-top: 6px; color: var(--err); min-height: 16px; }
</style>
</head>
<body>
<div class="hdr">
    <div class="hdr-title">Ignore Rules</div>
    <div class="hdr-sub">
        Files and folders matching these glob patterns are excluded from all violation scanning.<br>
        Patterns are stored per workspace and are never committed to source control.
    </div>
</div>

<div class="section">
    <div class="sec-title">Add Pattern</div>
    <div class="add-row">
        <input type="text" id="patternInput" placeholder="e.g.  **/node_modules/**  or  src/tests/**  or  *.generated.ts" />
        <button class="btn-add" onclick="addPattern()">Add</button>
    </div>
    <div class="feedback" id="feedback"></div>
</div>

<div class="section">
    <div class="sec-title">Active Patterns <span style="font-weight:400;text-transform:none;letter-spacing:0">(${patterns.length})</span></div>
    ${rowsHtml}
</div>

<div class="section">
    <div class="sec-title">Common Examples</div>
    <div class="hint-list">
        <div class="hint"><span>Ignore all node_modules</span><code>**/node_modules/**</code><button class="hint-add" onclick="quickAdd('**/node_modules/**')">+ Add</button></div>
        <div class="hint"><span>Ignore test files</span><code>**/*.test.ts</code><button class="hint-add" onclick="quickAdd('**/*.test.ts')">+ Add</button></div>
        <div class="hint"><span>Ignore spec files</span><code>**/*.spec.ts</code><button class="hint-add" onclick="quickAdd('**/*.spec.ts')">+ Add</button></div>
        <div class="hint"><span>Ignore build output</span><code>dist/**</code><button class="hint-add" onclick="quickAdd('dist/**')">+ Add</button></div>
        <div class="hint"><span>Ignore generated files</span><code>**/*.generated.ts</code><button class="hint-add" onclick="quickAdd('**/*.generated.ts')">+ Add</button></div>
        <div class="hint"><span>Ignore a specific folder</span><code>src/migrations/**</code><button class="hint-add" onclick="quickAdd('src/migrations/**')">+ Add</button></div>
        <div class="hint"><span>Ignore mock files</span><code>**/__mocks__/**</code><button class="hint-add" onclick="quickAdd('**/__mocks__/**')">+ Add</button></div>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();
function addPattern() {
    const input = document.getElementById('patternInput');
    const val = input.value.trim();
    if (!val) { showFb('Please enter a pattern.'); return; }
    vscode.postMessage({ type: 'addIgnorePattern', pattern: val });
    input.value = '';
    showFb('');
}
function quickAdd(p) {
    vscode.postMessage({ type: 'addIgnorePattern', pattern: p });
}
function removePattern(p) {
    vscode.postMessage({ type: 'removeIgnorePattern', pattern: p });
}
function showFb(msg) {
    document.getElementById('feedback').textContent = msg;
}
document.getElementById('patternInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') addPattern();
});
</script>
</body>
</html>`;
    }

    /** HTML-escape to prevent XSS in webview content */
    private _esc(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    /** JS string-escape for values embedded in onclick attribute strings */
    private _jsesc(s: string): string {
        return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"').replace(/\n/g, '\\n');
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

