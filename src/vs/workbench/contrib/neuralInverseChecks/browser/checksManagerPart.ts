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
import { IContractReasonService } from './engine/services/contractReasonService.js';
import { IFrameworkRegistry } from './engine/framework/frameworkRegistry.js';
import { ICheckResult, IImpactNode } from './engine/types/grcTypes.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import { IVoidSettingsService } from '../../void/common/voidSettingsService.js';
import { IExternalToolService } from './engine/services/externalToolService.js';
import { IExternalJob } from './engine/types/externalJobTypes.js';
import { IChecksAgentService } from './checksAgent/checksAgentService.js';
import { ChecksAgentTerminalHost } from './checksAgent/checksAgentTerminalHost.js';
import { IViolationFeedbackService } from './engine/services/violationFeedbackService.js';
import { ISimulatorService } from './engine/services/simulatorService.js';
import { ISimulatorSession, ISimulatorPreset } from './engine/services/simulatorTypes.js';
import { IFormalVerificationService } from './engine/services/formalVerificationService.js';

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
    private checksAgentTerminalHost: ChecksAgentTerminalHost | undefined;
    private checksAgentContainer: HTMLElement | undefined;
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
    private _currentViewMode: 'dashboard' | 'ignore' | 'impact' | 'nano' | 'chat' | 'frameworks' | 'external-tools' | 'checks-agent' | 'ai-scan' | 'simulator' = 'dashboard';
    private _frameworksImportOpen = false;
    private _webviewInteractionLocked = false;
    private _webviewInteractionTimer: ReturnType<typeof setTimeout> | undefined = undefined;
    private static readonly INTERACTION_LOCK_MS = 8000;
    private _ignoreSuggestionsLoading = false;
    private _ignoreSuggestions: Array<{ pattern: string; mode: string; reason: string; confidence: string }> = [];
    private _checksContainer: HTMLElement | undefined;

    /** Snapshot of external tool job states for rendering in the dashboard */
    private _externalJobs: IExternalJob[] = [];

    /** Simulator session snapshot */
    private _simulatorSessions: ISimulatorSession[] = [];
    private _simulatorPresets: ISimulatorPreset[] = [];
    private _simTab: 'sessions' | 'presets' = 'sessions';

    constructor(
        @IThemeService themeService: IThemeService,
        @IStorageService storageService: IStorageService,
        @IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
        @IInstantiationService private readonly instantiationService: IInstantiationService,
        @IWebviewService private readonly webviewService: IWebviewService,
        @ITerminalService private readonly terminalService: ITerminalService,
        @IGRCEngineService private readonly grcEngine: IGRCEngineService,
        @IContractReasonService private readonly contractReasonService: IContractReasonService,
        @IEditorService private readonly editorService: IEditorService,
        @IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
        @IFrameworkRegistry private readonly frameworkRegistry: IFrameworkRegistry,
        @IExternalToolService private readonly externalToolService: IExternalToolService,
        @IChecksAgentService private readonly checksAgentService: IChecksAgentService,
        @IViolationFeedbackService private readonly violationFeedbackService: IViolationFeedbackService,
        @ISimulatorService private readonly simulatorService: ISimulatorService,
        @IFormalVerificationService _formalVerificationService: IFormalVerificationService,
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
        this._checksContainer = checksContainer;

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

        // VIEW: Checks Agent terminal — hidden until selected, lazily initialized
        this.checksAgentContainer = document.createElement('div');
        this.checksAgentContainer.style.cssText = 'width:100%;height:100%;display:none;overflow:hidden';
        body.appendChild(this.checksAgentContainer);

        // Terminal Container (Appended last to be at bottom)
        body.appendChild(this.terminalContainer);


        // ── Sidebar Navigation ────────────────────────────────────────
        type ViewId = 'all' | 'security' | 'compliance' | 'policy' | 'architecture' | 'data-integrity' | 'fail-safe' | 'reliability' | 'availability' | 'processing-integrity' | 'confidentiality' | 'formal-verification' | 'impact' | 'audit' | 'ignore' | 'nano' | 'chat' | 'frameworks' | 'external-tools' | 'checks-agent' | 'ai-scan' | 'simulator';
        const DOMAIN_MAP: Partial<Record<ViewId, string>> = {
            security: 'security', compliance: 'compliance', policy: 'policy',
            architecture: 'architecture', 'data-integrity': 'data-integrity',
            'fail-safe': 'fail-safe', reliability: 'reliability',
            availability: 'availability', 'processing-integrity': 'processing-integrity',
            confidentiality: 'confidentiality',
        };
        const sidebarItems: Partial<Record<ViewId, HTMLElement>> = {};

        const refreshWebview = (force = false) => {
            if (!this.webviewElement) return;
            // Block re-renders while user is actively interacting with the webview
            if (!force && this._webviewInteractionLocked) return;
            if (this._currentViewMode === 'ignore') {
                this.webviewElement.setHtml(this.getIgnoreHtml());
            } else if (this._currentViewMode === 'impact') {
                this.webviewElement.setHtml(this._getImpactViewHtml());
            } else if (this._currentViewMode === 'frameworks') {
                this.webviewElement.setHtml(this._getFrameworksHtml());
            } else if (this._currentViewMode === 'external-tools') {
                this.webviewElement.setHtml(this._getExternalToolsHtml());
            } else if (this._currentViewMode === 'ai-scan') {
                this.webviewElement.setHtml(this._getAIScanHtml());
            } else if (this._currentViewMode === 'simulator') {
                this._simulatorSessions = this.simulatorService.getSessions();
                this._simulatorPresets = this.simulatorService.getPresets();
                this.webviewElement.setHtml(this._getSimulatorHtml());
            } else if (this._currentViewMode === 'dashboard') {
                this.webviewElement.setHtml(this.getDashboardHtml(this._currentDomain));
            }
        };

        const updateView = (view: ViewId) => {
            // Lock re-renders while navigating so the view doesn't reset within 2 seconds
            this._touchInteractionLock();
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
            if (this.checksAgentContainer) { this.checksAgentContainer.style.display = 'none'; }
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
            } else if (view === 'formal-verification') {
                fvContainer.style.display = 'block';
                this.formalVerificationControl?.show();
                this.formalVerificationControl?.layout(body.clientWidth, body.clientHeight);
                this._currentViewMode = 'dashboard';
            } else if (view === 'audit') {
                aedContainer.style.display = 'block';
                this.auditAndEvidenceControl?.show();
                this.auditAndEvidenceControl?.layout(body.clientWidth, body.clientHeight);
                this._currentViewMode = 'dashboard';
            } else if (view === 'impact') {
                checksContainer.style.display = 'block';
                this._currentViewMode = 'impact';
                this._currentDomain = undefined;
                if (this.webviewElement) {
                    this.webviewElement.setHtml(this._getImpactViewHtml());
                }
            } else if (view === 'ignore') {
                checksContainer.style.display = 'block';
                this._currentViewMode = 'ignore';
                this._currentDomain = undefined;
                refreshWebview(true);
            } else if (view === 'frameworks') {
                checksContainer.style.display = 'block';
                this._currentViewMode = 'frameworks';
                this._currentDomain = undefined;
                if (this.webviewElement) {
                    this.webviewElement.setHtml(this._getFrameworksHtml());
                }
            } else if (view === 'external-tools') {
                checksContainer.style.display = 'block';
                this._currentViewMode = 'external-tools';
                this._currentDomain = undefined;
                if (this.webviewElement) {
                    this.webviewElement.setHtml(this._getExternalToolsHtml());
                }
            } else if (view === 'ai-scan') {
                checksContainer.style.display = 'block';
                this._currentViewMode = 'ai-scan';
                this._currentDomain = undefined;
                if (this.webviewElement) {
                    this.webviewElement.setHtml(this._getAIScanHtml());
                }
            } else if (view === 'checks-agent') {
                if (this.checksAgentContainer) {
                    this.checksAgentContainer.style.display = 'block';
                    // Lazily create the terminal on first show
                    if (!this.checksAgentTerminalHost) {
                        this.checksAgentTerminalHost = this._register(
                            new ChecksAgentTerminalHost(this.terminalService, this.checksAgentService)
                        );
                        this.checksAgentTerminalHost.createTerminal(this.checksAgentContainer);
                    }
                }
                this._currentViewMode = 'checks-agent';
                this._currentDomain = undefined;
            } else if (view === 'simulator') {
                checksContainer.style.display = 'block';
                this._currentViewMode = 'simulator';
                this._currentDomain = undefined;
                if (this.webviewElement) {
                    this._simulatorSessions = this.simulatorService.getSessions();
                    this._simulatorPresets = this.simulatorService.getPresets();
                    this.webviewElement.setHtml(this._getSimulatorHtml());
                }
            } else {
                checksContainer.style.display = 'block';
                this._currentViewMode = 'dashboard';
                this._currentDomain = DOMAIN_MAP[view];
                refreshWebview(true);
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
        createSidebarItem('Checks Agent', 'checks-agent', '⊗');
        createSidebarItem('AI Scan', 'ai-scan', '⊙');

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

        addSidebarLabel('Verification');
        createSidebarItem('Formal Verification', 'formal-verification', '⊢');
        createSidebarItem('Cross-File Impact', 'impact', '⊷');
        createSidebarItem('Audit & Evidence', 'audit', '⊜');

        addSidebarLabel('Configuration');
        createSidebarItem('Frameworks', 'frameworks', '⊞');
        createSidebarItem('Ignore Rules', 'ignore', '⊖');
        createSidebarItem('External Tools', 'external-tools', '⊳');

        addSidebarLabel('Tools');
        createSidebarItem('Nano Agents', 'nano', '◇');
        createSidebarItem('Simulator', 'simulator', '⊳');

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
            const msg = event.message as { type: string; json?: string; id?: string; pattern?: string };
            if (msg.type === 'webviewInteraction') {
                this._touchInteractionLock();
            } else if (msg.type === 'frameworksImportToggled') {
                this._frameworksImportOpen = (msg as any).open ?? false;
            } else if (msg.type === 'removeFramework' && msg.id) {
                await this.grcEngine.removeFramework(msg.id);
                this._releaseInteractionLock();
                if (this.webviewElement && this._currentViewMode === 'frameworks') {
                    this.webviewElement.setHtml(this._getFrameworksHtml());
                }
            } else if (msg.type === 'importFramework' && msg.json) {
                const result = await this.grcEngine.importFramework(msg.json);
                if (this.webviewElement) {
                    this.webviewElement.postMessage({
                        type: 'importResult',
                        valid: result.valid,
                        errors: result.errors ?? [],
                        warnings: result.warnings ?? []
                    });
                    if (result.valid) { this._releaseInteractionLock(); refreshWebview(true); }
                }
            } else if (msg.type === 'toggleAI') {
                this.contractReasonService.setEnabled(!this.contractReasonService.isEnabled);
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
                // Run static scan first, then AI — results fire onDidCheckComplete which refreshes the webview
                this.grcEngine.scanWorkspace().catch(e => console.error('[ChecksManagerPart] scanWorkspace failed:', e));
            } else if (msg.type === 'addIgnorePattern' && msg.pattern) {
                this.grcEngine.addIgnorePattern(msg.pattern);
                this._releaseInteractionLock();
                if (this._currentViewMode === 'ignore') refreshWebview(true);
            } else if (msg.type === 'removeIgnorePattern' && msg.pattern) {
                this.grcEngine.removeIgnorePattern(msg.pattern);
                this._releaseInteractionLock();
                if (this._currentViewMode === 'ignore') refreshWebview(true);
            } else if (msg.type === 'addContextOnlyPattern' && msg.pattern) {
                this.grcEngine.addContextOnlyPattern(msg.pattern);
                this._releaseInteractionLock();
                if (this._currentViewMode === 'ignore') refreshWebview(true);
            } else if (msg.type === 'removeContextOnlyPattern' && msg.pattern) {
                this.grcEngine.removeContextOnlyPattern(msg.pattern);
                this._releaseInteractionLock();
                if (this._currentViewMode === 'ignore') refreshWebview(true);
            } else if (msg.type === 'dismissIgnoreSuggestion' && (msg as any).pattern) {
                this._ignoreSuggestions = this._ignoreSuggestions.filter(s => s.pattern !== (msg as any).pattern);
                if (this._currentViewMode === 'ignore') refreshWebview(true);
            } else if (msg.type === 'askAgentAboutViolation') {
                const v = msg as any;
                const question = `Explain this GRC violation:\n- Rule: ${v.ruleId}\n- File: ${v.file}\n- Line: ${v.line}\n- Message: ${v.message}`;
                updateView('checks-agent');
                setTimeout(() => {
                    this.checksAgentTerminalHost?.prefill(question);
                }, 300);
            } else if (msg.type === 'dismissViolation') {
                const v = msg as any;
                // Find the actual ICheckResult to pass to the feedback service
                const allResults = this.grcEngine.getAllResults();
                const match = allResults.find(r =>
                    r.ruleId === v.ruleId &&
                    r.line === v.line &&
                    r.fileUri.path.endsWith(v.fileBasename)
                );
                if (match) {
                    this.violationFeedbackService.dismiss(match, v.reason || undefined);
                    // Trigger AI re-analysis so false positive flag reaches the model
                    const content = this.grcEngine.getCachedContent?.(match.fileUri);
                    if (content) this.grcEngine.triggerAIAnalysis(match.fileUri, content);
                }
                this._releaseInteractionLock();
                refreshWebview();
            } else if (msg.type === 'toggleInlineDiagnostics') {
                const enabled = (msg as any).enabled as boolean;
                this.grcEngine.setInlineDiagnosticsEnabled(enabled);
                refreshWebview();
            } else if (msg.type === 'resetAICache') {
                this.contractReasonService.clearAnalysisCache();
                this.contractReasonService.scanTrackerReset();
                this._releaseInteractionLock();
                refreshWebview(true);
            } else if (msg.type === 'scanWorkspaceAI') {
                this.grcEngine.scanWorkspaceWithAI().catch(e => console.error('[ChecksManagerPart] AI scan failed:', e));
            } else if (msg.type === 'retryErrors') {
                // Clear error entries by resetting tracker (scanned/skipped entries will be re-evaluated via cache)
                this.contractReasonService.scanTrackerReset();
                this.grcEngine.scanWorkspaceWithAI().catch(e => console.error('[ChecksManagerPart] retry scan failed:', e));
                refreshWebview(true);
            } else if (msg.type === 'stopPeriodicScan') {
                this.grcEngine.stopPeriodicAIScan();
                refreshWebview(true);
            } else if (msg.type === 'startPeriodicScan') {
                this.grcEngine.startPeriodicAIScan(120_000);
                refreshWebview(true);
            } else if (msg.type === 'runExternalTool') {
                const ruleId = (msg as any).ruleId as string;
                const rule = this.grcEngine.getRules().find(r => r.id === ruleId);
                if (rule) {
                    const check = rule.check as any;
                    if (check?.scope === 'workspace') {
                        this.externalToolService.runWorkspaceScans([rule]).catch(e => console.error('[ChecksManagerPart] runExternalTool failed:', e));
                    }
                }
            } else if (msg.type === 'runAllExternalTools') {
                const extRules = this.grcEngine.getRules().filter(r => r.type === 'external');
                const wsRules = extRules.filter(r => (r.check as any)?.scope === 'workspace');
                if (wsRules.length > 0) this.externalToolService.runWorkspaceScans(wsRules).catch(e => console.error('[ChecksManagerPart] runAllExternalTools failed:', e));
            } else if (msg.type === 'cancelExternalTools') {
                this.externalToolService.cancelAll().catch(e => console.error('[ChecksManagerPart] cancelAll failed:', e));
            } else if (msg.type === 'clearExternalCache') {
                this.externalToolService.clearCache();
                this._externalJobs = [];
                if (this._currentViewMode === 'external-tools' && this.webviewElement) {
                    this.webviewElement.postMessage({ type: 'cacheClearedConfirm' });
                }
            } else if (msg.type === 'addToolPreset') {
                const p = (msg as any).preset as {
                    id: string; name: string; binary: string;
                    command: string; parseOutput: string; scope: string; description: string;
                    tags?: string[]; timeoutMs?: number;
                };
                // Build a minimal standalone framework JSON for this tool
                const frameworkJson = JSON.stringify({
                    framework: {
                        id: p.id,
                        name: p.name + ' (External Tool)',
                        version: '1.0.0',
                        description: p.description,
                    },
                    rules: [{
                        id: p.id.toUpperCase().replace(/-/g, '_') + '_001',
                        title: p.name + ' analysis',
                        description: p.description,
                        severity: 'warning',
                        category: 'external-tool',
                        references: (p.tags ?? []).map(t => ({ id: t, url: '' })),
                        check: {
                            type: 'external',
                            command: p.command,
                            toolBinary: p.binary,
                            parseOutput: p.parseOutput,
                            scope: p.scope,
                            timeoutMs: p.timeoutMs ?? (p.scope === 'workspace' ? 300000 : 30000),
                            cacheStrategy: 'content-hash',
                        },
                    }],
                }, null, 2);

                this.frameworkRegistry.importFramework(frameworkJson).then(result => {
                    if (this.webviewElement) {
                        this.webviewElement.postMessage({
                            type: 'presetAdded',
                            presetId: p.id,
                            presetName: p.name,
                            success: result.valid,
                            error: result.errors?.[0],
                        });
                    }
                    if (result.valid && this._currentViewMode === 'external-tools' && this.webviewElement) {
                        // Refresh the page so the new rule appears in Configured Tools
                        setTimeout(() => {
                            if (this.webviewElement) this.webviewElement.setHtml(this._getExternalToolsHtml());
                        }, 600);
                    }
                }).catch(e => {
                    if (this.webviewElement) {
                        this.webviewElement.postMessage({ type: 'presetAdded', presetId: p.id, presetName: p.name, success: false, error: String(e) });
                    }
                });
            } else if (msg.type === 'checkToolAvailability') {
                const binary = (msg as any).binary as string;
                this.externalToolService.isToolAvailable(binary).then(available => {
                    if (this.webviewElement) {
                        this.webviewElement.postMessage({ type: 'toolAvailabilityResult', binary, available });
                    }
                });
            } else if (msg.type === 'generateIgnoreSuggestions') {
                this._ignoreSuggestionsLoading = true;
                this._ignoreSuggestions = [];
                if (this._currentViewMode === 'ignore') refreshWebview(true);
                this.grcEngine.generateIgnoreSuggestions().then(suggestions => {
                    this._ignoreSuggestionsLoading = false;
                    this._ignoreSuggestions = suggestions ?? [];
                    if (this._currentViewMode === 'ignore') {
                        this._releaseInteractionLock();
                        refreshWebview(true);
                    }
                }).catch(e => {
                    console.error('[ChecksManagerPart] generateIgnoreSuggestions failed:', e);
                    this._ignoreSuggestionsLoading = false;
                    this._ignoreSuggestions = [];
                    if (this._currentViewMode === 'ignore') {
                        this._releaseInteractionLock();
                        refreshWebview(true);
                    }
                });

            // ── Simulator messages ────────────────────────────────────
            } else if (msg.type === 'createSimSession') {
                const cfg = (msg as any).config as {
                    name: string; kind: string; buildCommand?: string;
                    elfPath: string; launchCommand: string; timeoutMs: number; env?: Record<string, string>;
                };
                this.simulatorService.createSession({
                    name: cfg.name,
                    kind: cfg.kind as any,
                    buildCommand: cfg.buildCommand || undefined,
                    elfPath: cfg.elfPath,
                    launchCommand: cfg.launchCommand,
                    timeoutMs: cfg.timeoutMs ?? 120_000,
                    env: cfg.env,
                    persist: true,
                }).then(() => {
                    this._simulatorSessions = this.simulatorService.getSessions();
                    if (this._currentViewMode === 'simulator' && this.webviewElement) {
                        this.webviewElement.setHtml(this._getSimulatorHtml());
                    }
                }).catch(e => console.error('[ChecksManagerPart] createSimSession failed:', e));

            } else if (msg.type === 'runSimSession') {
                const sessionId = (msg as any).sessionId as string;
                this.simulatorService.runSession(sessionId)
                    .catch(e => console.error('[ChecksManagerPart] runSimSession failed:', e));

            } else if (msg.type === 'stopSimSession') {
                const sessionId = (msg as any).sessionId as string;
                this.simulatorService.stopSession(sessionId)
                    .catch(e => console.error('[ChecksManagerPart] stopSimSession failed:', e));

            } else if (msg.type === 'deleteSimSession') {
                const sessionId = (msg as any).sessionId as string;
                this.simulatorService.deleteSession(sessionId).then(() => {
                    this._simulatorSessions = this.simulatorService.getSessions();
                    if (this._currentViewMode === 'simulator' && this.webviewElement) {
                        this.webviewElement.setHtml(this._getSimulatorHtml());
                    }
                }).catch(e => console.error('[ChecksManagerPart] deleteSimSession failed:', e));

            } else if (msg.type === 'cloneSimSession') {
                const { sessionId, newName } = msg as any;
                this.simulatorService.cloneSession(sessionId, newName || 'Copy').then(() => {
                    this._simulatorSessions = this.simulatorService.getSessions();
                    if (this._currentViewMode === 'simulator' && this.webviewElement) {
                        this.webviewElement.setHtml(this._getSimulatorHtml());
                    }
                }).catch(e => console.error('[ChecksManagerPart] cloneSimSession failed:', e));

            } else if (msg.type === 'switchSimTab') {
                this._simTab = (msg as any).tab === 'presets' ? 'presets' : 'sessions';
                this._simulatorSessions = this.simulatorService.getSessions();
                this._simulatorPresets = this.simulatorService.getPresets();
                if (this._currentViewMode === 'simulator' && this.webviewElement) {
                    this.webviewElement.setHtml(this._getSimulatorHtml());
                }

            } else if (msg.type === 'createSessionFromPreset') {
                const p = (msg as any).preset as ISimulatorPreset;
                this.simulatorService.createSession({
                    name: p.name,
                    kind: p.kind,
                    elfPath: p.elfPath,
                    buildCommand: p.buildCommand,
                    launchCommand: p.launchCommand,
                    timeoutMs: p.timeoutMs,
                    env: p.env,
                    persist: true,
                }).then(() => {
                    this._simulatorSessions = this.simulatorService.getSessions();
                    this._simTab = 'sessions';
                    if (this._currentViewMode === 'simulator' && this.webviewElement) {
                        this.webviewElement.setHtml(this._getSimulatorHtml());
                    }
                }).catch(e => console.error('[ChecksManagerPart] createSessionFromPreset failed:', e));

            } else if (msg.type === 'askAgentAboutSimViolation') {
                const v = msg as any;
                const question = `[Simulator Runtime Violation]\nKind: ${v.kind}\nMessage: ${v.message}\nFile: ${v.file || 'unknown'}\nLine: ${v.line || '?'}\n\nExplain this runtime violation and how to fix it according to applicable GRC rules.`;
                updateView('checks-agent');
                setTimeout(() => this.checksAgentTerminalHost?.prefill(question), 300);
            }
        }));

        // Subscribe to engine events
        this._register(this.grcEngine.onDidCheckComplete(() => refreshWebview()));
        this._register(this.grcEngine.onDidRulesChange(() => refreshWebview()));
        this._register(this.grcEngine.onDidInlineDiagnosticsChange(() => refreshWebview()));
        this._register(this.contractReasonService.onDidEnabledChange(() => refreshWebview()));
        this._register(this.contractReasonService.onDidScanTrackerUpdate(() => {
            if (this._currentViewMode === 'ai-scan') refreshWebview();
        }));
        this._register(this.voidSettingsService.onDidChangeState(() => refreshWebview()));
        this._register(this.frameworkRegistry.onDidFrameworksChange(() => refreshWebview()));

        // Subscribe to simulator session updates — push live output + violations to webview
        this._register(this.simulatorService.onDidSessionUpdate(session => {
            const idx = this._simulatorSessions.findIndex(s => s.config.id === session.config.id);
            if (idx >= 0) {
                this._simulatorSessions[idx] = session;
            } else {
                this._simulatorSessions.push(session);
            }
            if (this._currentViewMode === 'simulator' && this.webviewElement) {
                this.webviewElement.postMessage({ type: 'simSessionUpdate', session });
            }
        }));

        // Subscribe to external tool job updates — update snapshot + notify webview via postMessage
        // (avoids full re-render which would reset scroll position in the dashboard)
        this._register(this.externalToolService.onDidJobUpdate(job => {
            // Update our local snapshot
            const idx = this._externalJobs.findIndex(j => j.id === job.id);
            if (idx >= 0) {
                this._externalJobs[idx] = job;
            } else {
                this._externalJobs.push(job);
            }
            // Push incremental update to webview without full re-render
            if (this.webviewElement) {
                if (this._currentViewMode === 'dashboard') {
                    this.webviewElement.postMessage({ type: 'externalJobUpdate', job });
                } else if (this._currentViewMode === 'external-tools') {
                    this.webviewElement.postMessage({ type: 'externalJobUpdate', job });
                }
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

    private _touchInteractionLock(): void {
        this._webviewInteractionLocked = true;
        if (this._webviewInteractionTimer !== undefined) {
            clearTimeout(this._webviewInteractionTimer);
        }
        this._webviewInteractionTimer = setTimeout(() => {
            this._webviewInteractionLocked = false;
            this._webviewInteractionTimer = undefined;
        }, ChecksManagerPart.INTERACTION_LOCK_MS);
    }

    private _releaseInteractionLock(): void {
        this._webviewInteractionLocked = false;
        if (this._webviewInteractionTimer !== undefined) {
            clearTimeout(this._webviewInteractionTimer);
            this._webviewInteractionTimer = undefined;
        }
    }


    private _getFrameworksHtml(): string {
        const frameworks = this.frameworkRegistry.getActiveFrameworks();
        const allRules = this.grcEngine.getRules();
        const totalRules = allRules.length;
        const importOpen = this._frameworksImportOpen;
        const totalDomains = [...new Set(allRules.map(r => r.domain).filter(Boolean))].length;
        const loadedAt = new Date().toISOString().replace('T', ' ').substring(0, 16) + ' UTC';

        const rowsHtml = frameworks.map((fw, idx) => {
            const def = fw.definition.framework;
            const fwRules = allRules.filter(r => r.frameworkId === def.id);
            const domains = [...new Set(fwRules.map(r => r.domain).filter(Boolean))];
            const errCount = fwRules.filter(r => r.severity === 'error' || r.severity === 'critical').length;
            const warnCount = fwRules.filter(r => r.severity === 'warning').length;
            const hasWarnings = fw.validation.warnings && fw.validation.warnings.length > 0;
            const statusDot = hasWarnings ? 'dot-warn' : 'dot-ok';
            const statusText = hasWarnings ? `${fw.validation.warnings!.length} warning${fw.validation.warnings!.length !== 1 ? 's' : ''}` : 'Valid';
            const domainsText = domains.slice(0, 4).join(', ') + (domains.length > 4 ? ` +${domains.length - 4}` : '');
            const warningRowsHtml = hasWarnings
                ? fw.validation.warnings!.slice(0, 5).map(w =>
                    `<div class="warn-row"><span class="warn-dot"></span><span class="warn-text">${this._esc(w)}</span></div>`
                ).join('')
                : '';
            const warningSection = hasWarnings
                ? `<tr class="expand-row" id="expand-${idx}" style="display:none"><td colspan="7"><div class="expand-body">${warningRowsHtml}</div></td></tr>`
                : '';

            return `<tr class="fw-row" onclick="toggleExpand(${idx}, ${hasWarnings})" data-id="${this._esc(def.id)}">
    <td class="td-name">
        <div class="fw-name">${this._esc(def.name)}</div>
        <div class="fw-id">${this._esc(def.id)}</div>
    </td>
    <td class="td-ver mono">${this._esc(def.version ?? '—')}</td>
    <td class="td-num">${fwRules.length}</td>
    <td class="td-num err-val">${errCount > 0 ? errCount : '<span class="zero">0</span>'}</td>
    <td class="td-num warn-val">${warnCount > 0 ? warnCount : '<span class="zero">0</span>'}</td>
    <td class="td-domains mono-sm">${this._esc(domainsText || '—')}</td>
    <td class="td-status"><span class="dot ${statusDot}"></span><span class="status-text">${this._esc(statusText)}</span></td>
    <td class="td-actions">
        ${hasWarnings ? `<span class="action-link" onclick="event.stopPropagation();toggleExpand(${idx}, true)">Warnings</span>` : ''}
        <span class="action-link remove-link" onclick="event.stopPropagation();removeFramework('${this._jsesc(def.id)}')">Remove</span>
    </td>
</tr>${warningSection}`;
        }).join('');

        const emptyRow = frameworks.length === 0
            ? `<tr><td colspan="8" class="empty-cell">No frameworks loaded. Import a framework to activate GRC enforcement.</td></tr>`
            : '';

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
    --bg:        var(--vscode-editor-background, #0d0d0d);
    --bg-raised: var(--vscode-sideBar-background, #111);
    --border:    var(--vscode-panel-border, rgba(255,255,255,0.08));
    --border-med:rgba(255,255,255,0.12);
    --fg:        var(--vscode-foreground, #e0e0e0);
    --fg-muted:  rgba(255,255,255,0.38);
    --fg-dim:    rgba(255,255,255,0.22);
    --mono:      var(--vscode-editor-font-family, 'SF Mono','Menlo','Consolas',monospace);
    --ok:        #4caf50;
    --warn:      #ff9800;
    --err:       #f44336;
    --accent:    #5c6bc0;
    --input-bg:  var(--vscode-input-background, rgba(255,255,255,0.05));
    --input-bd:  var(--vscode-input-border, rgba(255,255,255,0.1));
}

body {
    font-family: var(--vscode-font-family, -apple-system, 'Segoe UI', sans-serif);
    font-size: 12px;
    color: var(--fg);
    background: var(--bg);
    height: 100vh;
    overflow-y: auto;
    -webkit-font-smoothing: antialiased;
}

/* ── Page header ── */
.page-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 16px 20px 12px;
    border-bottom: 1px solid var(--border);
}
.page-heading {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.1px;
    color: var(--fg);
}
.page-meta {
    font-size: 11px;
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
}
.meta-sep { margin: 0 8px; opacity: 0.3; }

/* ── Toolbar ── */
.toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-raised);
}
.toolbar-left { display: flex; align-items: center; gap: 8px; }
.section-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--fg-muted);
}
.count-badge {
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    background: rgba(255,255,255,0.07);
    border: 1px solid var(--border-med);
    border-radius: 2px;
    padding: 1px 6px;
    color: var(--fg-muted);
}
.btn-import {
    font-size: 11px;
    font-weight: 500;
    padding: 4px 12px;
    border-radius: 3px;
    border: 1px solid var(--border-med);
    background: transparent;
    color: var(--fg);
    cursor: pointer;
    letter-spacing: 0.1px;
    transition: background 0.1s, border-color 0.1s;
}
.btn-import:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.2); }
.btn-import.active { background: rgba(92,107,192,0.15); border-color: rgba(92,107,192,0.4); color: #9fa8da; }

/* ── Import panel ── */
.import-panel {
    display: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-raised);
}
.import-panel.open { display: block; }
.import-inner { padding: 16px 20px; }

.import-tabs {
    display: flex;
    gap: 0;
    margin-bottom: 12px;
    border-bottom: 1px solid var(--border);
}
.itab {
    font-size: 11px;
    font-weight: 500;
    padding: 5px 14px;
    cursor: pointer;
    color: var(--fg-muted);
    border-bottom: 1px solid transparent;
    margin-bottom: -1px;
    user-select: none;
    transition: color 0.1s;
}
.itab:hover { color: var(--fg); }
.itab.active { color: var(--fg); border-bottom-color: var(--accent); }

#tab-paste { display: block; }
#tab-schema { display: none; }

textarea#fwJson {
    width: 100%;
    height: 120px;
    resize: vertical;
    background: var(--input-bg);
    color: var(--fg);
    border: 1px solid var(--input-bd);
    border-radius: 3px;
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.55;
    padding: 8px 10px;
    outline: none;
    display: block;
}
textarea#fwJson:focus { border-color: var(--accent); }
textarea#fwJson::placeholder { color: var(--fg-dim); }

.import-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
}
.btn-submit {
    font-size: 11px;
    font-weight: 500;
    padding: 4px 14px;
    border-radius: 3px;
    border: 1px solid rgba(92,107,192,0.5);
    background: rgba(92,107,192,0.18);
    color: #9fa8da;
    cursor: pointer;
    transition: background 0.1s;
}
.btn-submit:hover { background: rgba(92,107,192,0.28); }
.btn-cancel {
    font-size: 11px;
    font-weight: 500;
    padding: 4px 12px;
    border-radius: 3px;
    border: 1px solid var(--border-med);
    background: transparent;
    color: var(--fg-muted);
    cursor: pointer;
}
.btn-cancel:hover { color: var(--fg); }

.fb { font-size: 11px; }
.fb.ok  { color: var(--ok); }
.fb.err { color: var(--err); }

.schema-box {
    font-family: var(--mono);
    font-size: 10.5px;
    line-height: 1.6;
    background: rgba(0,0,0,0.25);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 12px 14px;
    color: rgba(255,255,255,0.5);
    white-space: pre;
    overflow-x: auto;
}
.schema-box .k { color: #9fa8da; }
.schema-box .s { color: #80cbc4; }
.schema-box .c { color: rgba(255,255,255,0.25); font-style: italic; }

/* ── Frameworks table ── */
.fw-table-wrap {
    overflow-x: auto;
}
table.fw-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
}
table.fw-table thead tr {
    border-bottom: 1px solid var(--border-med);
}
table.fw-table thead th {
    padding: 8px 12px 7px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--fg-muted);
    text-align: left;
    white-space: nowrap;
    background: var(--bg-raised);
}
th.th-r, td.td-num { text-align: right; }
th.th-r { padding-right: 16px; }
td.td-num { padding-right: 16px; font-variant-numeric: tabular-nums; }

table.fw-table tbody tr.fw-row {
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    transition: background 0.08s;
}
table.fw-table tbody tr.fw-row:hover { background: rgba(255,255,255,0.025); }
table.fw-table tbody tr.fw-row:last-child { border-bottom: none; }

td { padding: 9px 12px; vertical-align: middle; }
.td-name { min-width: 200px; }
.fw-name { font-size: 12px; font-weight: 500; color: var(--fg); line-height: 1.3; }
.fw-id {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--fg-muted);
    margin-top: 2px;
    letter-spacing: 0.1px;
}
.td-ver { font-family: var(--mono); font-size: 11px; color: var(--fg-muted); white-space: nowrap; }
.mono { font-family: var(--mono); }
.mono-sm { font-family: var(--mono); font-size: 10.5px; color: var(--fg-muted); }

.err-val { color: var(--err); }
.warn-val { color: var(--warn); }
.zero { color: var(--fg-dim); }

.td-status { white-space: nowrap; }
.dot {
    display: inline-block;
    width: 6px; height: 6px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
    flex-shrink: 0;
}
.dot-ok   { background: var(--ok); box-shadow: 0 0 4px rgba(76,175,80,0.4); }
.dot-warn { background: var(--warn); box-shadow: 0 0 4px rgba(255,152,0,0.4); }
.dot-err  { background: var(--err); box-shadow: 0 0 4px rgba(244,67,54,0.4); }
.status-text { font-size: 11px; color: var(--fg-muted); vertical-align: middle; }

.td-actions { white-space: nowrap; text-align: right; padding-right: 16px; }
.action-link {
    font-size: 11px;
    color: var(--fg-dim);
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 2px;
    transition: color 0.1s, background 0.1s;
    margin-left: 4px;
    display: inline-block;
}
.action-link:hover { color: var(--fg); background: rgba(255,255,255,0.06); }
.remove-link:hover { color: var(--err); background: rgba(244,67,54,0.08); }

/* ── Expand row ── */
tr.expand-row td { padding: 0; }
.expand-body {
    padding: 10px 12px 12px 28px;
    background: rgba(0,0,0,0.2);
    border-top: 1px solid var(--border);
}
.warn-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 3px 0;
    font-size: 11px;
    color: rgba(255,152,0,0.75);
    line-height: 1.5;
}
.warn-dot {
    display: inline-block;
    width: 4px; height: 4px;
    border-radius: 50%;
    background: var(--warn);
    flex-shrink: 0;
    margin-top: 5px;
}
.warn-text { opacity: 0.9; }

.empty-cell {
    padding: 32px 20px;
    color: var(--fg-muted);
    font-size: 12px;
    text-align: center;
}

/* ── Confirm dialog ── */
.overlay {
    display: none;
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.55);
    z-index: 999;
    align-items: center;
    justify-content: center;
}
.overlay.visible { display: flex; }
.dialog {
    background: var(--bg-raised);
    border: 1px solid var(--border-med);
    border-radius: 4px;
    width: 320px;
    padding: 20px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
}
.dialog-title {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 8px;
}
.dialog-body {
    font-size: 11px;
    color: var(--fg-muted);
    line-height: 1.55;
    margin-bottom: 16px;
}
.dialog-body code {
    font-family: var(--mono);
    font-size: 10.5px;
    background: rgba(255,255,255,0.06);
    padding: 1px 5px;
    border-radius: 2px;
    color: var(--fg);
}
.dialog-actions { display: flex; gap: 6px; justify-content: flex-end; }
.btn-dlg-cancel {
    font-size: 11px; padding: 4px 12px; border-radius: 3px;
    border: 1px solid var(--border-med); background: transparent;
    color: var(--fg-muted); cursor: pointer;
}
.btn-dlg-cancel:hover { color: var(--fg); }
.btn-dlg-remove {
    font-size: 11px; padding: 4px 12px; border-radius: 3px;
    border: 1px solid rgba(244,67,54,0.35); background: rgba(244,67,54,0.12);
    color: #ef9a9a; cursor: pointer;
}
.btn-dlg-remove:hover { background: rgba(244,67,54,0.22); }
</style>
</head>
<body>

<div class="overlay" id="overlay">
    <div class="dialog">
        <div class="dialog-title">Remove Framework</div>
        <div class="dialog-body" id="dlg-body">Remove <code id="dlg-id"></code>? The file will be deleted from <code>.inverse/frameworks/</code>. This cannot be undone.</div>
        <div class="dialog-actions">
            <button class="btn-dlg-cancel" onclick="cancelRemove()">Cancel</button>
            <button class="btn-dlg-remove" onclick="confirmRemove()">Remove</button>
        </div>
    </div>
</div>

<div class="page-top">
    <span class="page-heading">Compliance Frameworks</span>
    <span class="page-meta">
        ${frameworks.length} loaded<span class="meta-sep">·</span>${totalRules} rules<span class="meta-sep">·</span>${totalDomains} domains<span class="meta-sep">·</span>Last refreshed ${this._esc(loadedAt)}
    </span>
</div>

<div class="toolbar">
    <div class="toolbar-left">
        <span class="section-label">Loaded</span>
        <span class="count-badge">${frameworks.length}</span>
    </div>
    <button class="btn-import${importOpen ? ' active' : ''}" id="btn-import" onclick="toggleImport()">Import Framework</button>
</div>

<div class="import-panel${importOpen ? ' open' : ''}" id="import-panel">
    <div class="import-inner">
        <div class="import-tabs">
            <span class="itab active" id="tab-paste-btn" onclick="switchTab('paste')">Paste JSON</span>
            <span class="itab" id="tab-schema-btn" onclick="switchTab('schema')">Schema</span>
        </div>
        <div id="tab-paste">
            <textarea id="fwJson" placeholder="Paste framework JSON  { &quot;framework&quot;: { &quot;id&quot;: &quot;...&quot;, &quot;name&quot;: &quot;...&quot;, &quot;version&quot;: &quot;...&quot; }, &quot;rules&quot;: [...] }"></textarea>
            <div class="import-row">
                <button class="btn-submit" onclick="submitImport()">Validate &amp; Import</button>
                <button class="btn-cancel" onclick="toggleImport()">Cancel</button>
                <span class="fb" id="fb" style="display:none"></span>
            </div>
        </div>
        <div id="tab-schema">
            <div class="schema-box"><span class="c">// Minimum required structure</span>
<span class="k">{</span>
  <span class="s">"framework"</span>: <span class="k">{</span>
    <span class="s">"id"</span>:          <span class="s">"unique-id"</span>,          <span class="c">// used as filename, required</span>
    <span class="s">"name"</span>:        <span class="s">"Framework Name"</span>,      <span class="c">// required</span>
    <span class="s">"version"</span>:     <span class="s">"1.0.0"</span>,               <span class="c">// required</span>
    <span class="s">"description"</span>: <span class="s">"..."</span>,                 <span class="c">// optional</span>
    <span class="s">"authority"</span>:   <span class="s">"Issuing Body"</span>         <span class="c">// optional</span>
  <span class="k">}</span>,
  <span class="s">"rules"</span>: <span class="k">[{</span>
    <span class="s">"id"</span>:          <span class="s">"RULE-001"</span>,
    <span class="s">"name"</span>:        <span class="s">"Rule description"</span>,
    <span class="s">"domain"</span>:      <span class="s">"security"</span>,             <span class="c">// security | compliance | architecture | ...</span>
    <span class="s">"severity"</span>:    <span class="s">"error"</span>,                <span class="c">// error | warning | info</span>
    <span class="s">"type"</span>:        <span class="s">"pattern"</span>,              <span class="c">// pattern | ast | custom</span>
    <span class="s">"pattern"</span>:     <span class="s">"eval\\\\("</span>,
    <span class="s">"message"</span>:     <span class="s">"eval() is forbidden"</span>,
    <span class="s">"enabled"</span>:     true,
    <span class="s">"languages"</span>:   <span class="k">[</span><span class="s">"typescript"</span>, <span class="s">"javascript"</span><span class="k">]</span>
  <span class="k">}]</span>
<span class="k">}</span></div>
        </div>
    </div>
</div>

<div class="fw-table-wrap">
    <table class="fw-table">
        <thead>
            <tr>
                <th>Framework</th>
                <th>Version</th>
                <th class="th-r">Rules</th>
                <th class="th-r">Errors</th>
                <th class="th-r">Warnings</th>
                <th>Domains</th>
                <th>Status</th>
                <th></th>
            </tr>
        </thead>
        <tbody>
            ${rowsHtml}
            ${emptyRow}
        </tbody>
    </table>
</div>

<script>
const vscode = acquireVsCodeApi();
// Notify host on any interaction so it holds off re-rendering
(function(){const _iv=()=>vscode.postMessage({type:'webviewInteraction'});document.addEventListener('click',_iv,true);document.addEventListener('input',_iv,true);document.addEventListener('keydown',_iv,true);})();
let _pendingId = null;

function toggleImport() {
    const panel = document.getElementById('import-panel');
    const btn = document.getElementById('btn-import');
    const open = panel.classList.toggle('open');
    btn.classList.toggle('active', open);
    if (!open) { document.getElementById('fb').style.display = 'none'; }
    vscode.postMessage({ type: 'frameworksImportToggled', open });
}

function switchTab(t) {
    document.getElementById('tab-paste').style.display = t === 'paste' ? 'block' : 'none';
    document.getElementById('tab-schema').style.display = t === 'schema' ? 'block' : 'none';
    document.getElementById('tab-paste-btn').classList.toggle('active', t === 'paste');
    document.getElementById('tab-schema-btn').classList.toggle('active', t === 'schema');
}

function submitImport() {
    const json = document.getElementById('fwJson').value.trim();
    const fb = document.getElementById('fb');
    if (!json) { fb.textContent = 'Paste framework JSON first.'; fb.className = 'fb err'; fb.style.display = 'inline'; return; }
    try { JSON.parse(json); } catch(e) { fb.textContent = 'Invalid JSON: ' + e.message; fb.className = 'fb err'; fb.style.display = 'inline'; return; }
    fb.textContent = 'Validating...'; fb.className = 'fb'; fb.style.display = 'inline';
    vscode.postMessage({ type: 'importFramework', json });
}

function toggleExpand(idx, hasWarnings) {
    if (!hasWarnings) return;
    const row = document.getElementById('expand-' + idx);
    if (!row) return;
    row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
}

function removeFramework(id) {
    _pendingId = id;
    document.getElementById('dlg-id').textContent = id;
    document.getElementById('overlay').classList.add('visible');
}
function cancelRemove() { _pendingId = null; document.getElementById('overlay').classList.remove('visible'); }
function confirmRemove() {
    if (!_pendingId) return;
    vscode.postMessage({ type: 'removeFramework', id: _pendingId });
    document.getElementById('overlay').classList.remove('visible');
    _pendingId = null;
}

window.addEventListener('message', e => {
    const d = e.data;
    if (d.type === 'importResult') {
        const fb = document.getElementById('fb');
        fb.style.display = 'inline';
        if (d.valid) {
            fb.textContent = 'Imported successfully' + (d.warnings?.length ? ' — ' + d.warnings.length + ' warning(s)' : '');
            fb.className = 'fb ok';
            document.getElementById('fwJson').value = '';
        } else {
            fb.textContent = d.errors?.[0] ?? 'Validation failed';
            fb.className = 'fb err';
        }
    }
});
</script>
</body>
</html>`;
    }

    private getDashboardHtml(domainFilter?: string): string {
        const inlineDiagEnabled = this.grcEngine.inlineDiagnosticsEnabled;
        const lastScanMs = this.grcEngine.getLastWorkspaceScanTime();
        const lastScanLabel = lastScanMs > 0 ? this._timeAgo(lastScanMs) : 'never';
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
        const aiEnabled = this.contractReasonService.isEnabled;
        const aiAvailable = this.contractReasonService.isAvailable;
        const modelState = this.voidSettingsService.state;
        const checksModel = modelState.modelSelectionOfFeature['Checks'] ?? modelState.modelSelectionOfFeature['Chat'];
        const activeModelLabel = checksModel
            ? `${checksModel.modelName} (${checksModel.providerName})`
            : 'No model configured';

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

        // ── Sort files by cross-file impact score (dependents count) ──
        const importedByMap = this.grcEngine.getImportedByMap();
        const getImpactScore = (fileUriStr: string): number => {
            const path = URI.parse(fileUriStr).path.replace(/\.[^/.]+$/, '');
            let score = 0;
            for (const [key, importers] of importedByMap) {
                if (key === path || key.startsWith(path + '/') || path.endsWith('/' + key)) {
                    score += importers.length;
                }
            }
            return score;
        };
        const sortedByFile = [...byFile.entries()].sort((a, b) => {
            const scoreB = getImpactScore(b[0]);
            const scoreA = getImpactScore(a[0]);
            if (scoreB !== scoreA) return scoreB - scoreA;
            // Secondary: error count descending
            const errA = a[1].filter(r => r.severity === 'error').length;
            const errB = b[1].filter(r => r.severity === 'error').length;
            return errB - errA;
        });

        let violListHtml = '';
        for (const [fileKey, fileResults] of sortedByFile) {
            const first = fileResults[0];
            const fileName = first.fileUri.path.split('/').pop() ?? first.fileUri.path;
            const dirParts = first.fileUri.path.replace(/\/[^/]+$/, '').split('/');
            const dirPath = dirParts.slice(-2).join('/');
            const domain = first.domain || 'general';
            const errCount  = fileResults.filter(r => r.severity === 'error').length;
            const warnCount = fileResults.filter(r => r.severity === 'warning').length;
            const impactScore = getImpactScore(fileKey);
            const autoCollapsed = fileResults.length > 4 ? ' collapsed' : '';

            const dismissedKeys = new Set(
                this.violationFeedbackService.getEntriesForFile(fileName).map(e => `${e.ruleId}:${e.codeSnippet.slice(0, 40)}`)
            );

            const itemsHtml = fileResults.map((r, ridx) => {
                const sevCls = r.severity === 'error' ? 'sev-err' : r.severity === 'warning' ? 'sev-warn' : 'sev-info';
                const srcBadge = (r.checkSource === 'breaking' || r.isBreakingChange)
                    ? '<span class="src-badge src-break">BREAK</span>'
                    : r.checkSource === 'ai'
                    ? '<span class="src-badge src-ai">AI</span>'
                    : '<span class="src-badge src-static">STATIC</span>';

                // AI confidence badge
                const confBadge = r.aiConfidence
                    ? `<span class="conf-badge conf-${r.aiConfidence}" title="AI confidence: ${r.aiConfidence}">${r.aiConfidence.toUpperCase()}</span>`
                    : '';

                // Positive finding indicator (AI confirmed this is a real violation)
                const positiveBadge = r.aiConfidence === 'high' && r.aiExplanation?.includes('[AI confirmed:')
                    ? '<span class="pos-badge" title="AI confirmed this is a true positive">✓ CONFIRMED</span>'
                    : '';

                // Dismissed badge
                const snippetKey = `${r.ruleId}:${(r.codeSnippet ?? '').slice(0, 40)}`;
                const isDismissed = dismissedKeys.has(snippetKey);
                const dismissedBadge = isDismissed ? '<span class="dismissed-badge">DISMISSED</span>' : '';

                const shortMsg = r.message.split('\n')[0].replace(/^\[[\w-]+\]\s*/, '').substring(0, 120);

                // AI explanation row (only if present and not just the generic fallback)
                const hasExplanation = r.aiExplanation && r.aiExplanation.length > 10;
                const explanationHtml = hasExplanation
                    ? `<div class="viol-explanation">${this._esc(r.aiExplanation!)}</div>`
                    : '';

                // Reasoning chain (collapsible)
                const violId = `v-${fileKey.replace(/[^a-z0-9]/gi,'_')}-${ridx}`;
                const hasReasoning = Array.isArray((r as any).reasoningChain) && (r as any).reasoningChain.length > 0;
                const reasoningHtml = hasReasoning
                    ? `<div class="reasoning" id="rc-${violId}">
                        ${((r as any).reasoningChain as Array<{step:number;observation:string;implication:string;ruleRelevance:string}>).map(s =>
                            `<div class="rc-step"><span class="rc-num">${s.step}</span><div class="rc-body"><div class="rc-obs">${this._esc(s.observation)}</div><div class="rc-impl">${this._esc(s.implication)}</div></div></div>`
                        ).join('')}
                      </div>`
                    : '';
                const reasoningToggle = hasReasoning
                    ? `<button class="reasoning-btn" onclick="event.stopPropagation();toggleReasoning('${violId}')">Why ▾</button>`
                    : '';

                // Fix hint
                const fixHtml = r.fix
                    ? `<div class="viol-fix" title="Suggested fix">${this._esc(r.fix.substring(0, 160))}</div>`
                    : '';

                // Dismiss button (not for confirmed positives)
                const dismissBtn = !isDismissed
                    ? `<button class="dismiss-btn" onclick="event.stopPropagation();dismissViol('${this._jsesc(r.ruleId)}','${this._jsesc(fileName)}',${r.line},'${this._jsesc((r.codeSnippet ?? '').slice(0, 80))}','')" title="Mark as false positive">✕ Dismiss</button>`
                    : `<button class="undismiss-btn" onclick="event.stopPropagation();dismissViol('${this._jsesc(r.ruleId)}','${this._jsesc(fileName)}',${r.line},'${this._jsesc((r.codeSnippet ?? '').slice(0, 80))}','re-evaluate')" title="Un-dismiss">↺ Re-check</button>`;

                return `<div class="viol ${sevCls}${isDismissed ? ' viol-dismissed' : ''}">
                    <div class="viol-top" onclick="navigate('${this._jsesc(r.fileUri.toString())}',${r.line},${r.column})">
                        <span class="rule-id">${this._esc(r.ruleId)}</span>
                        ${srcBadge}${confBadge}${positiveBadge}${dismissedBadge}
                        <span class="viol-msg">${this._esc(shortMsg)}</span>
                    </div>
                    ${explanationHtml}
                    ${fixHtml}
                    ${reasoningHtml}
                    <div class="viol-bottom">
                        <span class="viol-loc" onclick="navigate('${this._jsesc(r.fileUri.toString())}',${r.line},${r.column})">${this._esc(fileName)}:${r.line}</span>
                        <div class="viol-actions">
                            ${reasoningToggle}
                            <button class="ask-agent-btn" onclick="event.stopPropagation();askAgent('${this._jsesc(r.ruleId)}','${this._jsesc(fileName)}',${r.line},'${this._jsesc(shortMsg)}')">Ask Agent</button>
                            ${dismissBtn}
                        </div>
                    </div>
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
                        ${impactScore > 0 ? `<span class="fc-impact" title="${impactScore} file(s) import this">⊷${impactScore}</span>` : ''}
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

        // ── External Tool Jobs ────────────────────────────────────────
        const extJobs = this._externalJobs;
        const runningJobs = extJobs.filter(j => j.status === 'running');
        const cachedJobs = extJobs.filter(j => j.status === 'skipped' && j.skipReason === 'cache-hit');
        const extHeaderBadge = runningJobs.length > 0
            ? `<span class="ext-badge running">${runningJobs.length} running</span>`
            : cachedJobs.length > 0
            ? `<span class="ext-badge cached">${cachedJobs.length} cached</span>`
            : '';
        const extJobRowsHtml = extJobs.length > 0
            ? extJobs.map(j => {
                const dotCls = j.status === 'running' ? 'ext-dot running' : j.status === 'complete' ? 'ext-dot ok' : j.status === 'failed' ? 'ext-dot err' : 'ext-dot muted';
                const dur = j.durationMs ? (j.durationMs > 60000 ? `${Math.round(j.durationMs/60000)}m ${Math.round((j.durationMs%60000)/1000)}s` : `${(j.durationMs/1000).toFixed(1)}s`) : '';
                const statusLabel = j.status === 'running' ? `running${dur ? ' ' + dur : ''}` : j.status === 'complete' ? `complete${dur ? ' · ' + dur : ''}${j.resultCount > 0 ? ' · ' + j.resultCount + ' hits' : ''}` : j.status === 'skipped' ? (j.skipReason === 'cache-hit' ? 'cached' : j.skipReason === 'tool-not-found' ? 'tool not found' : 'skipped') : j.status === 'failed' ? `failed${j.error ? ' · ' + j.error.substring(0, 50) : ''}` : j.status;
                const cacheTag = j.cacheHit ? ' <span class="ext-cache-tag">cached</span>' : '';
                return `<tr id="extj-${this._esc(j.id)}" class="ext-job-row ext-${j.status}">
                    <td><span class="${dotCls}">●</span></td>
                    <td class="mono">${this._esc(j.toolName)}</td>
                    <td class="ext-domain">${this._esc(j.ruleId.split(':')[0] ?? j.ruleId)}</td>
                    <td class="ext-status">${this._esc(statusLabel)}${cacheTag}</td>
                </tr>`;
            }).join('')
            : `<tr><td colspan="4" class="muted">No external tool jobs yet — configure <code>type: external</code> rules in a framework</td></tr>`;

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

/* ── External Tools ── */
.ext-badge { font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 2px; }
.ext-badge.running { background: rgba(79,193,255,.15); color: #4fc1ff; border: 1px solid rgba(79,193,255,.3); }
.ext-badge.cached  { background: rgba(115,201,145,.15); color: var(--ok); border: 1px solid rgba(115,201,145,.3); }
.ext-dot { font-size: 10px; }
.ext-dot.running { color: #4fc1ff; animation: pulse 1.4s infinite; }
.ext-dot.ok      { color: var(--ok); }
.ext-dot.err     { color: var(--err); }
.ext-dot.muted   { color: var(--fg-muted); }
.ext-status   { font-size: 11px; color: var(--fg-muted); }
.ext-domain   { font-size: 10px; color: var(--fg-muted); }
.ext-running .ext-status { color: #4fc1ff; }
.ext-failed  .ext-status { color: var(--err); }
.ext-complete .ext-status { color: var(--ok); }
.ext-cache-tag { font-size: 9px; font-weight: 700; padding: 0 4px; border-radius: 2px; background: rgba(115,201,145,.15); color: var(--ok); margin-left: 4px; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }

/* ── Source badges ── */
.src-badge { font-size: 8px; font-weight: 800; padding: 1px 5px; border-radius: 2px; flex-shrink: 0; letter-spacing: .3px; }
.src-static { background: rgba(96,125,139,.3);  border: 1px solid rgba(96,125,139,.5);  color: #b0bec5; }
.src-ai     { background: rgba(103,58,183,.3);  border: 1px solid rgba(103,58,183,.55); color: #ce93d8; }
.src-break  { background: rgba(244,67,54,.25);  border: 1px solid rgba(244,67,54,.5);   color: #ef9a9a; }

/* ── Violations list ── */
.viol-list { display: flex; flex-direction: column; gap: 4px; }

.file-group { border: 1px solid var(--border); border-radius: 4px; overflow: hidden; margin-bottom: 2px; }
.file-hdr {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 10px; cursor: pointer; user-select: none;
    background: var(--bg-alt); font-size: 11px; border-bottom: 1px solid transparent;
}
.file-group:not(.collapsed) .file-hdr { border-bottom-color: var(--border); }
.file-hdr:hover { background: rgba(255,255,255,.05); }
.collapse-icon { font-size: 10px; opacity: .5; flex-shrink: 0; transition: transform .15s; }
.file-group.collapsed .collapse-icon { transform: rotate(-90deg); }
.file-group.collapsed .file-items { display: none; }
.file-name  { font-weight: 600; flex-shrink: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
.file-dir   { font-size: 10px; opacity: .35; font-family: var(--vscode-editor-font-family, monospace); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.file-counts { display: flex; gap: 6px; margin-left: auto; flex-shrink: 0; align-items: center; }
.fc-err    { color: #ef9a9a; font-size: 10px; font-weight: 700; }
.fc-warn   { color: #ffcc80; font-size: 10px; font-weight: 700; }
.fc-impact { color: #7eb8f7; font-size: 10px; opacity: 0.7; }

.file-items { display: flex; flex-direction: column; }
.viol {
    display: flex; flex-direction: column; gap: 3px;
    padding: 6px 10px 6px 12px; border-left: 3px solid transparent;
    font-size: 11px; line-height: 1.4;
    border-bottom: 1px solid rgba(255,255,255,.04);
}
.viol:last-child { border-bottom: none; }
.viol:hover { background: rgba(255,255,255,.025); }
.sev-err  { border-left-color: var(--err); }
.sev-warn { border-left-color: var(--warn); }
.sev-info { border-left-color: #42a5f5; }

.viol-top { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; min-height: 20px; }
.rule-id {
    font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 2px;
    background: rgba(255,255,255,.08); color: var(--fg); flex-shrink: 0;
    font-family: var(--vscode-editor-font-family, monospace); letter-spacing: .2px;
}
.viol-msg { font-size: 11px; color: rgba(255,255,255,.82); line-height: 1.4; flex: 1; min-width: 0; word-break: break-word; }

.viol-bottom {
    display: flex; align-items: center; justify-content: space-between;
    gap: 6px; margin-top: 1px;
}
.viol-loc {
    font-size: 9px; font-family: var(--vscode-editor-font-family, monospace);
    color: var(--info); opacity: .6; cursor: pointer; flex-shrink: 0;
}
.viol-loc:hover { opacity: 1; text-decoration: underline; }
.viol-actions { display: flex; align-items: center; gap: 4px; }

/* action buttons — always visible, subtle */
.ask-agent-btn {
    font-size: 9px; padding: 2px 7px;
    background: rgba(79,193,255,.12); color: var(--info);
    border: 1px solid rgba(79,193,255,.25); border-radius: 2px;
    cursor: pointer; font-family: inherit; white-space: nowrap;
}
.ask-agent-btn:hover { background: rgba(79,193,255,.22); }
.dismiss-btn {
    font-size: 9px; padding: 2px 7px;
    background: rgba(244,135,113,.1); color: #f48771;
    border: 1px solid rgba(244,135,113,.2); border-radius: 2px;
    cursor: pointer; font-family: inherit; white-space: nowrap;
}
.dismiss-btn:hover { background: rgba(244,135,113,.22); border-color: rgba(244,135,113,.4); }
.undismiss-btn {
    font-size: 9px; padding: 2px 7px;
    background: rgba(79,193,255,.1); color: #4fc1ff;
    border: 1px solid rgba(79,193,255,.2); border-radius: 2px;
    cursor: pointer; font-family: inherit; white-space: nowrap;
}
.undismiss-btn:hover { background: rgba(79,193,255,.2); }
.reasoning-btn {
    font-size: 9px; padding: 2px 7px;
    background: rgba(255,255,255,.06); color: rgba(255,255,255,.5);
    border: 1px solid rgba(255,255,255,.1); border-radius: 2px;
    cursor: pointer; font-family: inherit; white-space: nowrap;
}
.reasoning-btn:hover { background: rgba(255,255,255,.12); color: var(--fg); }

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

/* ── Confidence & positive badges ── */
.conf-badge {
    font-size: 8px; font-weight: 800; padding: 1px 5px; border-radius: 2px;
    flex-shrink: 0; letter-spacing: 0.3px;
}
.conf-high   { background: rgba(115,201,145,.2); color: #73c991; border: 1px solid rgba(115,201,145,.35); }
.conf-medium { background: rgba(204,167,0,.2);   color: #cca700; border: 1px solid rgba(204,167,0,.35); }
.conf-low    { background: rgba(244,135,113,.2); color: #f48771; border: 1px solid rgba(244,135,113,.35); }

.pos-badge {
    font-size: 8px; font-weight: 800; padding: 1px 5px; border-radius: 2px;
    background: rgba(115,201,145,.15); color: #73c991; border: 1px solid rgba(115,201,145,.3);
    flex-shrink: 0;
}
.dismissed-badge {
    font-size: 8px; font-weight: 700; padding: 1px 5px; border-radius: 2px;
    background: rgba(255,255,255,.06); color: rgba(255,255,255,.35); border: 1px solid rgba(255,255,255,.12);
    flex-shrink: 0;
}
.viol-dismissed { opacity: 0.5; }
.viol-dismissed .sev-err  { border-left-color: rgba(239,83,80,.3); }
.viol-dismissed .sev-warn { border-left-color: rgba(255,167,38,.3); }

/* ── Violation detail rows ── */
.viol-explanation {
    font-size: 10.5px; color: rgba(255,255,255,.55); line-height: 1.45;
    padding: 2px 0 0 1px;
}
.viol-fix {
    font-size: 10px; color: rgba(79,193,255,.7); font-family: var(--vscode-editor-font-family, monospace);
    padding: 2px 0 0 1px; white-space: pre-wrap; word-break: break-word;
}

/* ── Reasoning chain ── */
.reasoning {
    display: none; flex-direction: column; gap: 4px;
    padding: 6px 8px; margin: 3px 0;
    background: rgba(0,0,0,.25); border-radius: 3px;
    border: 1px solid rgba(255,255,255,.07);
}
.reasoning.open { display: flex; }
.rc-step { display: flex; gap: 8px; align-items: flex-start; }
.rc-num {
    font-size: 9px; font-weight: 700; min-width: 16px; height: 16px;
    border-radius: 50%; background: rgba(255,255,255,.1);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; margin-top: 1px; color: rgba(255,255,255,.6);
}
.rc-body { display: flex; flex-direction: column; gap: 1px; }
.rc-obs  { font-size: 10.5px; color: rgba(255,255,255,.65); }
.rc-impl { font-size: 10px; color: rgba(255,255,255,.4); font-style: italic; }

/* ── Violation action buttons ── */
.viol-actions { display: flex; align-items: center; gap: 4px; }
.reasoning-btn, .dismiss-btn, .undismiss-btn {
    font-size: 9px; padding: 1px 6px; border: none; border-radius: 2px;
    cursor: pointer; font-family: inherit; opacity: 0; transition: opacity .15s;
}
.viol:hover .reasoning-btn, .viol:hover .dismiss-btn, .viol:hover .undismiss-btn { opacity: 1; }
.reasoning-btn   { background: rgba(255,255,255,.08); color: rgba(255,255,255,.6); }
.reasoning-btn:hover { background: rgba(255,255,255,.14); color: var(--fg); }
.dismiss-btn     { background: rgba(244,135,113,.12); color: #f48771; }
.dismiss-btn:hover { background: rgba(244,135,113,.22); }
.undismiss-btn   { background: rgba(79,193,255,.1); color: #4fc1ff; }
.undismiss-btn:hover { background: rgba(79,193,255,.2); }

/* ── Settings bar ── */
.settings-bar {
    display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
    padding: 6px 0; margin-bottom: 10px;
    border-bottom: 1px solid var(--border);
    font-size: 11px; color: var(--fg-muted);
}
.setting-item { display: flex; align-items: center; gap: 6px; }
.toggle-track {
    width: 28px; height: 14px; border-radius: 7px; cursor: pointer;
    position: relative; flex-shrink: 0; transition: background .15s;
    border: 1px solid rgba(255,255,255,.15);
}
.toggle-track.on  { background: rgba(79,193,255,.35); border-color: rgba(79,193,255,.5); }
.toggle-track.off { background: rgba(255,255,255,.06); }
.toggle-thumb {
    width: 10px; height: 10px; border-radius: 50%; background: white;
    position: absolute; top: 1px; transition: left .15s;
}
.toggle-track.on  .toggle-thumb { left: 15px; }
.toggle-track.off .toggle-thumb { left: 2px; }
.setting-label { user-select: none; }
.last-scan-label { margin-left: auto; font-size: 10px; opacity: .5; }
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

<div class="settings-bar">
    <div class="setting-item" onclick="toggleInlineDiag()" title="${inlineDiagEnabled ? 'Inline errors ON — squiggly lines visible. Click to hide.' : 'Inline errors OFF — GRC still runs in background. Click to show.'}">
        <div class="toggle-track ${inlineDiagEnabled ? 'on' : 'off'}" id="inlineDiagTrack"><div class="toggle-thumb"></div></div>
        <span class="setting-label">Inline errors &nbsp;<span style="opacity:.45;font-size:9px">${inlineDiagEnabled ? '● visible' : '○ hidden'}</span></span>
    </div>
    <span class="last-scan-label">Last scan: ${this._esc(lastScanLabel)}</span>
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
            <tr><td style="color:var(--fg-muted)">Model</td><td style="font-family:monospace;font-size:11px">${this._esc(activeModelLabel)}</td></tr>
            <tr><td style="color:var(--fg-muted)">Mode</td><td>${aiEnabled ? 'Pattern checks + AI enrichment' : 'Pattern checks only'}</td></tr>
            <tr><td style="color:var(--fg-muted)">Capabilities</td><td>${aiEnabled ? 'Semantic analysis, missed violations, false positive detection, AI explanations' : 'Disabled — enable to activate AI-enhanced analysis'}</td></tr>
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

<div class="section" id="extToolsSection">
    <div class="sec-hdr">
        <span class="sec-title">External Tools</span>
        ${extHeaderBadge}
    </div>
    <table id="extJobsTable" style="width:100%;border-collapse:collapse">
        <thead><tr><th style="width:20px"></th><th>Tool</th><th>Rule</th><th>Status</th></tr></thead>
        <tbody id="extJobsTbody">${extJobRowsHtml}</tbody>
    </table>
</div>

${this._buildImpactHtml(allResults)}

<script>
const vscode = acquireVsCodeApi();
// Notify host on any interaction so it holds off re-rendering
(function(){const _iv=()=>vscode.postMessage({type:'webviewInteraction'});document.addEventListener('click',_iv,true);document.addEventListener('input',_iv,true);document.addEventListener('keydown',_iv,true);})();

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

function askAgent(ruleId, file, line, message) {
    vscode.postMessage({ type: 'askAgentAboutViolation', ruleId, file, line, message });
}

function toggleReasoning(violId) {
    const el = document.getElementById('rc-' + violId);
    if (el) el.classList.toggle('open');
    const btn = el && el.parentElement && el.parentElement.querySelector('.reasoning-btn');
    if (btn) btn.textContent = el && el.classList.contains('open') ? 'Why ▴' : 'Why ▾';
}

function dismissViol(ruleId, fileBasename, line, snippet, reason) {
    vscode.postMessage({ type: 'dismissViolation', ruleId, fileBasename, line, snippet, reason });
}

function toggleInlineDiag() {
    const track = document.getElementById('inlineDiagTrack');
    const enabled = track ? !track.classList.contains('on') : true;
    vscode.postMessage({ type: 'toggleInlineDiagnostics', enabled });
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
    } else if (msg.type === 'externalJobUpdate') {
        const job = msg.job;
        const tbody = document.getElementById('extJobsTbody');
        if (!tbody) return;
        const rowId = 'extj-' + job.id.replace(/[^a-zA-Z0-9_-]/g, '_');
        let row = document.getElementById(rowId);
        const dotCls = job.status === 'running' ? 'ext-dot running' : job.status === 'complete' ? 'ext-dot ok' : job.status === 'failed' ? 'ext-dot err' : 'ext-dot muted';
        const dur = job.durationMs ? (job.durationMs > 60000 ? Math.round(job.durationMs/60000)+'m '+Math.round((job.durationMs%60000)/1000)+'s' : (job.durationMs/1000).toFixed(1)+'s') : '';
        const statusMap = { running:'running', complete:'complete', failed:'failed', skipped:'skipped', queued:'queued', cancelled:'cancelled' };
        const statusLabel = job.status === 'running' ? ('running'+(dur?' '+dur:'')) : job.status === 'complete' ? ('complete'+(dur?' · '+dur:'')+(job.resultCount>0?' · '+job.resultCount+' hits':'')) : job.status === 'skipped' ? (job.skipReason==='cache-hit'?'cached':job.skipReason==='tool-not-found'?'tool not found':'skipped') : job.status === 'failed' ? ('failed'+(job.error?' · '+job.error.substring(0,50):'')) : job.status;
        const cacheTag = job.cacheHit ? '<span class="ext-cache-tag">cached</span>' : '';
        const html = '<td><span class="'+dotCls+'">●</span></td><td class="mono">'+job.toolName+'</td><td class="ext-domain">'+(job.ruleId.split(':')[0]||job.ruleId)+'</td><td class="ext-status">'+statusLabel+cacheTag+'</td>';
        if (row) {
            row.className = 'ext-job-row ext-'+job.status;
            row.innerHTML = html;
        } else {
            // Remove "no jobs yet" placeholder if present
            const placeholder = tbody.querySelector('tr td[colspan]');
            if (placeholder) tbody.innerHTML = '';
            row = document.createElement('tr');
            row.id = rowId;
            row.className = 'ext-job-row ext-'+job.status;
            row.innerHTML = html;
            tbody.appendChild(row);
        }
        // Update header badge
        const hdr = document.querySelector('#extToolsSection .sec-hdr');
        if (hdr) {
            let badge = hdr.querySelector('.ext-badge');
            const rows = Array.from(tbody.querySelectorAll('tr'));
            const running = rows.filter(r=>r.className.includes('ext-running')).length;
            const cached = rows.filter(r=>r.className.includes('ext-skipped')).length;
            if (!badge) { badge = document.createElement('span'); hdr.appendChild(badge); }
            if (running > 0) {
                badge.className = 'ext-badge running'; badge.textContent = running+' running';
            } else if (cached > 0) {
                badge.className = 'ext-badge cached'; badge.textContent = cached+' cached';
            } else {
                badge.remove();
            }
        }
    }
});
</script>
</body>
</html>`;
    }

    private _getExternalToolsHtml(): string {
        const allRules = this.grcEngine.getRules().filter(r => r.type === 'external');
        const jobs = this._externalJobs;

        // Build per-rule latest job map
        const latestJobByRule = new Map<string, IExternalJob>();
        for (const j of jobs) {
            const existing = latestJobByRule.get(j.ruleId);
            if (!existing || j.queuedAt > existing.queuedAt) {
                latestJobByRule.set(j.ruleId, j);
            }
        }

        // Configured tools table rows
        const toolRowsHtml = allRules.length > 0
            ? allRules.map(rule => {
                const check = rule.check as any;
                const scope: string = check?.scope ?? 'file';
                const binary: string = check?.toolBinary ?? '';
                const fmt: string = check?.parseOutput ?? 'json';
                const latestJob = latestJobByRule.get(rule.id);
                const status = latestJob?.status ?? 'idle';
                const isRunning = status === 'running' || status === 'queued';
                const dotCls = isRunning ? 'dot-running' : status === 'complete' ? 'dot-ok' : status === 'failed' ? 'dot-err' : status === 'skipped' ? 'dot-muted' : 'dot-idle';
                const dotChar = isRunning ? '●' : status === 'complete' ? '✓' : status === 'failed' ? '✗' : '○';
                const dur = latestJob?.durationMs ? (latestJob.durationMs > 60000 ? `${Math.round(latestJob.durationMs / 60000)}m ${Math.round((latestJob.durationMs % 60000) / 1000)}s` : `${(latestJob.durationMs / 1000).toFixed(1)}s`) : '—';
                const results = latestJob?.resultCount ?? '—';
                const skipNote = latestJob?.skipReason === 'tool-not-found' ? '<span class="badge-notfound">not in PATH</span>' : latestJob?.skipReason === 'cache-hit' ? '<span class="badge-cached">cached</span>' : latestJob?.skipReason === 'license-error' ? '<span class="badge-err">license error</span>' : '';
                const actionBtn = scope === 'workspace'
                    ? (isRunning
                        ? `<button class="btn-sm btn-cancel" onclick="cancelAll()">✕</button>`
                        : `<button class="btn-sm btn-run" onclick="runTool('${this._jsesc(rule.id)}')">▶ Run</button>`)
                    : `<span class="muted" title="File-scope tools run automatically on file open/save">auto</span>`;
                const availBtn = binary
                    ? `<button class="btn-sm btn-check" onclick="checkAvail('${this._jsesc(binary)}','${this._jsesc(rule.id)}')">check</button>`
                    : '';
                return `<tr id="rule-row-${this._esc(rule.id)}">
                    <td><span class="${dotCls}">${dotChar}</span></td>
                    <td class="mono rule-id-cell">${this._esc(rule.id)}</td>
                    <td>${this._esc(binary || '—')}</td>
                    <td><span class="scope-badge scope-${this._esc(scope)}">${this._esc(scope)}</span></td>
                    <td class="mono fmt-cell">${this._esc(fmt)}</td>
                    <td class="num">${dur}</td>
                    <td class="num">${typeof results === 'number' ? (results > 0 ? `<span class="hit-count">${results}</span>` : '0') : results}</td>
                    <td>${skipNote}</td>
                    <td id="avail-${this._esc(rule.id)}">${availBtn}</td>
                    <td>${actionBtn}</td>
                </tr>`;
            }).join('')
            : `<tr><td colspan="10" class="muted" style="padding:12px;text-align:center">
                No external tool rules configured.<br>
                <span style="font-size:11px;opacity:.6">Add a rule with <code>type: "external"</code> to a framework in <code>.inverse/frameworks/</code></span>
               </td></tr>`;

        // Job history rows (most recent 30)
        const historyJobs = [...jobs].sort((a, b) => b.queuedAt - a.queuedAt).slice(0, 30);
        const historyRowsHtml = historyJobs.length > 0
            ? historyJobs.map(j => {
                const statusCls = j.status === 'running' ? 'st-running' : j.status === 'complete' ? 'st-ok' : j.status === 'failed' ? 'st-err' : 'st-muted';
                const dur = j.durationMs ? (j.durationMs > 60000 ? `${Math.round(j.durationMs / 60000)}m ${Math.round((j.durationMs % 60000) / 1000)}s` : `${(j.durationMs / 1000).toFixed(1)}s`) : '';
                const errNote = j.error ? `<span class="err-note" title="${this._esc(j.error)}">⚠</span>` : '';
                return `<tr>
                    <td><span class="${statusCls}">${this._esc(j.status)}</span></td>
                    <td class="mono">${this._esc(j.ruleId)}</td>
                    <td><span class="scope-badge scope-${this._esc(j.scope)}">${this._esc(j.scope)}</span></td>
                    <td class="num">${dur || '—'}</td>
                    <td class="num">${j.resultCount > 0 ? `<span class="hit-count">${j.resultCount}</span>` : j.resultCount}</td>
                    <td class="muted">${this._timeAgo(j.queuedAt)}</td>
                    <td>${j.cacheHit ? '<span class="badge-cached">cached</span>' : ''}${errNote}</td>
                </tr>`;
            }).join('')
            : `<tr><td colspan="7" class="muted" style="padding:10px;text-align:center">No job history yet</td></tr>`;

        // Pre-configured tool presets — sector-aware, comprehensive coverage
        type ToolPreset = {
            id: string; name: string; sector: string; category: string; binary: string;
            description: string; command: string; parseOutput: string; scope: string;
            timeoutMs: number; tags: string[];
        };
        const TOOL_PRESETS: ToolPreset[] = [
            // ── Automotive ──────────────────────────────────────────────────────────
            { id: 'ext-automotive-polyspace-bf',    name: 'Polyspace Bug Finder',   sector: 'Automotive',               category: 'Formal Verification', binary: 'polyspace-bug-finder',  description: 'MathWorks formal verification — MISRA C, ISO 26262 ASIL',                              command: 'polyspace-bug-finder -sources ${workspace} -results-dir .inverse/polyspace',                           parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['MISRA-C:2012', 'ISO 26262', 'AUTOSAR'] },
            { id: 'ext-automotive-polyspace-cp',    name: 'Polyspace Code Prover',  sector: 'Automotive',               category: 'Formal Verification', binary: 'polyspace-code-prover', description: 'MathWorks formal proof of absence of runtime errors — ASIL D',                         command: 'polyspace-code-prover -sources ${workspace} -results-dir .inverse/polyspace-cp',                       parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['ISO 26262', 'ASIL-D', 'MISRA-C:2012'] },
            { id: 'ext-automotive-klocwork',        name: 'Klocwork',               sector: 'Automotive',               category: 'SAST',                binary: 'kwcheck',               description: 'Perforce Klocwork — AUTOSAR C++14, ISO 26262 compliance',                             command: 'kwcheck run --report ${workspace} --format sarif',                                                     parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 300000, tags: ['AUTOSAR', 'ISO 26262', 'MISRA-C:2012'] },
            { id: 'ext-automotive-pclint',          name: 'PC-lint Plus',           sector: 'Automotive',               category: 'MISRA',               binary: 'pclp64',                description: 'Gimpel PC-lint Plus — MISRA C:2012, MISRA C++:2008 certified',                       command: 'pclp64 ${file} 2>&1',                                                                                  parseOutput: 'line-per-violation', scope: 'file',      timeoutMs: 30000,  tags: ['MISRA-C:2012', 'MISRA-C++:2008'] },
            { id: 'ext-automotive-clang-tidy',      name: 'clang-tidy (AUTOSAR)',   sector: 'Automotive',               category: 'SAST',                binary: 'clang-tidy',            description: 'LLVM linter with AUTOSAR C++14 and CERT checks',                                      command: 'clang-tidy --checks=autosar-*,cert-* ${file} 2>&1',                                                    parseOutput: 'line-per-violation', scope: 'file',      timeoutMs: 30000,  tags: ['AUTOSAR', 'CERT-C++', 'ISO 26262'] },
            { id: 'ext-automotive-cppcheck',        name: 'cppcheck (MISRA)',       sector: 'Automotive',               category: 'MISRA',               binary: 'cppcheck',              description: 'cppcheck with MISRA C:2012 addon — memory, UB, MISRA violations',                    command: 'cppcheck --addon=misra --enable=all --xml ${workspace} 2>&1',                                          parseOutput: 'line-per-violation', scope: 'workspace', timeoutMs: 300000, tags: ['MISRA-C:2012'] },
            { id: 'ext-automotive-axivion',         name: 'Axivion Suite',          sector: 'Automotive',               category: 'Architecture',        binary: 'axivion-ci',            description: 'Axivion architecture analysis — MISRA, ISO 26262 structural checks',                  command: 'axivion-ci --project ${workspace} --report sarif --output .inverse/axivion',                           parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['MISRA-C:2012', 'ISO 26262', 'AUTOSAR'] },
            { id: 'ext-automotive-ldra',            name: 'LDRA TBvision',          sector: 'Automotive',               category: 'MISRA',               binary: 'tbvision',              description: 'LDRA TBvision — DO-178C, ISO 26262, MISRA certified analysis',                        command: 'tbvision --project ${workspace} --report-sarif .inverse/ldra.sarif',                                   parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['DO-178C', 'ISO 26262', 'MISRA-C:2012'] },
            { id: 'ext-automotive-qac',             name: 'QA-C / QA-C++',         sector: 'Automotive',               category: 'MISRA',               binary: 'qac',                   description: 'Perforce QA-C — MISRA C:2012 certified, deep dataflow',                              command: 'qac --project ${workspace} --output-format sarif --output .inverse/qac.sarif',                          parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 300000, tags: ['MISRA-C:2012', 'MISRA-C++:2008'] },
            { id: 'ext-automotive-helix-qac',       name: 'Helix QAC',              sector: 'Automotive',               category: 'MISRA',               binary: 'helix-qac',             description: 'Perforce Helix QAC — MISRA C:2012, AUTOSAR C++14 certified',                         command: 'helix-qac analyze --project ${workspace} --format sarif --output .inverse/helix-qac.sarif',             parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 300000, tags: ['MISRA-C:2012', 'AUTOSAR', 'ISO 26262'] },

            // ── Critical Infrastructure ──────────────────────────────────────────
            { id: 'ext-ci-claroty',                 name: 'Claroty CTD',            sector: 'Critical Infrastructure',  category: 'OT/ICS Scanning',     binary: 'ctd-scan',              description: 'Claroty CTD — OT/ICS vulnerability scanning, IEC 62443',                             command: 'ctd-scan --workspace ${workspace} --output .inverse/claroty.json',                                     parseOutput: 'json',               scope: 'workspace', timeoutMs: 600000, tags: ['IEC 62443', 'NERC CIP', 'API 1164'] },
            { id: 'ext-ci-tenable-ot',              name: 'Tenable OT Security',    sector: 'Critical Infrastructure',  category: 'OT/ICS Scanning',     binary: 'tenable-ot',            description: 'Tenable OT Security — industrial asset vulnerability scanning',                       command: 'tenable-ot scan --target ${workspace} --output .inverse/tenable-ot.json',                              parseOutput: 'json',               scope: 'workspace', timeoutMs: 600000, tags: ['IEC 62443', 'NIST SP 800-82', 'NERC CIP'] },
            { id: 'ext-ci-semgrep',                 name: 'Semgrep (ICS rules)',    sector: 'Critical Infrastructure',  category: 'SAST',                binary: 'semgrep',               description: 'Semgrep with ICS/SCADA security rules — IEC 62443 patterns',                         command: 'semgrep --config=p/ics --sarif --output .inverse/semgrep-ics.sarif ${workspace}',                      parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 300000, tags: ['IEC 62443', 'IEC 61511', 'NIST SP 800-82'] },
            { id: 'ext-ci-checkmarx',               name: 'Checkmarx SAST',         sector: 'Critical Infrastructure',  category: 'SAST',                binary: 'cx-cli',                description: 'Checkmarx SAST — IEC 62443 mappings, critical infrastructure rules',                 command: 'cx-cli scan create --project-name ci-scan --branch main --directory ${workspace} --report-format sarif', parseOutput: 'sarif',             scope: 'workspace', timeoutMs: 600000, tags: ['IEC 62443', 'OWASP', 'NERC CIP'] },
            { id: 'ext-ci-veracode',                name: 'Veracode',               sector: 'Critical Infrastructure',  category: 'SAST',                binary: 'veracode-cli',          description: 'Veracode static analysis — compliance scanning, IEC 62443',                          command: 'veracode-cli static scan --source ${workspace} --format sarif --output .inverse/veracode.sarif',        parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['IEC 62443', 'OWASP', 'CWE'] },
            { id: 'ext-ci-fortify',                 name: 'Fortify SCA',            sector: 'Critical Infrastructure',  category: 'SAST',                binary: 'sourceanalyzer',        description: 'OpenText Fortify SCA — IEC 62443, OWASP Top 10, deep taint analysis',               command: 'sourceanalyzer -b ci-scan -scan -f .inverse/fortify.fpr ${workspace}',                                 parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['IEC 62443', 'OWASP', 'CWE'] },
            { id: 'ext-ci-bandit',                  name: 'Bandit',                 sector: 'Critical Infrastructure',  category: 'Python Security',     binary: 'bandit',                description: 'Bandit Python SAST — security issues in SCADA/HMI Python scripts',                   command: 'bandit -r ${workspace} -f sarif -o .inverse/bandit.sarif',                                             parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 120000, tags: ['IEC 62443', 'CWE', 'OWASP'] },
            { id: 'ext-ci-safety',                  name: 'Safety',                 sector: 'Critical Infrastructure',  category: 'Python Security',     binary: 'safety',                description: 'Safety — Python dependency CVE checker for SCADA/HMI stacks',                        command: 'safety check --json --output .inverse/safety.json',                                                    parseOutput: 'json',               scope: 'workspace', timeoutMs: 60000,  tags: ['CVE', 'IEC 62443', 'NIST SP 800-82'] },

            // ── Firmware & Embedded Systems ──────────────────────────────────────
            { id: 'ext-fw-polyspace-bf',            name: 'Polyspace Bug Finder',   sector: 'Firmware & Embedded',      category: 'Formal Verification', binary: 'polyspace-bug-finder',  description: 'MathWorks formal verification — MISRA C, DO-178C Level A compliance',               command: 'polyspace-bug-finder -sources ${workspace} -results-dir .inverse/polyspace',                           parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['MISRA-C:2012', 'DO-178C', 'IEC 61508'] },
            { id: 'ext-fw-pclint',                  name: 'PC-lint Plus',           sector: 'Firmware & Embedded',      category: 'MISRA',               binary: 'pclp64',                description: 'Gimpel PC-lint Plus — MISRA C:2012, MISRA C++:2008 for embedded',                   command: 'pclp64 ${file} 2>&1',                                                                                  parseOutput: 'line-per-violation', scope: 'file',      timeoutMs: 30000,  tags: ['MISRA-C:2012', 'MISRA-C++:2008', 'DO-178C'] },
            { id: 'ext-fw-clang-tidy',              name: 'clang-tidy (CERT C)',    sector: 'Firmware & Embedded',      category: 'SAST',                binary: 'clang-tidy',            description: 'LLVM clang-tidy — CERT C, embedded readability and safety checks',                   command: 'clang-tidy --checks=cert-*,readability-*,cppcoreguidelines-* ${file} 2>&1',                            parseOutput: 'line-per-violation', scope: 'file',      timeoutMs: 30000,  tags: ['CERT-C', 'MISRA-C:2012'] },
            { id: 'ext-fw-cppcheck',                name: 'cppcheck (embedded)',    sector: 'Firmware & Embedded',      category: 'SAST',                binary: 'cppcheck',              description: 'cppcheck — embedded-specific null ptr, buffer overflow, UB checks',                  command: 'cppcheck --enable=all --platform=avr8 --xml ${workspace} 2>&1',                                        parseOutput: 'line-per-violation', scope: 'workspace', timeoutMs: 300000, tags: ['MISRA-C:2012', 'IEC 61508', 'CERT-C'] },
            { id: 'ext-fw-ldra',                    name: 'LDRA TBvision',          sector: 'Firmware & Embedded',      category: 'MISRA',               binary: 'tbvision',              description: 'LDRA TBvision — DO-178C, IEC 61508 SIL 4 certified analysis',                       command: 'tbvision --project ${workspace} --report-sarif .inverse/ldra.sarif',                                   parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['DO-178C', 'IEC 61508', 'MISRA-C:2012'] },
            { id: 'ext-fw-iar-cstat',               name: 'IAR C-STAT',             sector: 'Firmware & Embedded',      category: 'MISRA',               binary: 'iccarm',                description: 'IAR C-STAT — MISRA C:2012 static analysis for IAR toolchain targets',               command: 'iccarm --misra2 ${file} 2>&1',                                                                         parseOutput: 'line-per-violation', scope: 'file',      timeoutMs: 30000,  tags: ['MISRA-C:2012', 'IEC 61508', 'DO-178C'] },
            { id: 'ext-fw-coverity',                name: 'Coverity',               sector: 'Firmware & Embedded',      category: 'SAST',                binary: 'cov-analyze',           description: 'Synopsys Coverity — DO-178C, IEC 61508 deep defect detection',                       command: 'cov-analyze --dir .inverse/coverity-int --all --security',                                             parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['DO-178C', 'IEC 61508', 'CERT-C'] },
            { id: 'ext-fw-helix-qac',               name: 'Helix QAC',              sector: 'Firmware & Embedded',      category: 'MISRA',               binary: 'helix-qac',             description: 'Perforce Helix QAC — MISRA C certified for embedded/firmware',                       command: 'helix-qac analyze --project ${workspace} --format sarif --output .inverse/helix-qac.sarif',             parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 300000, tags: ['MISRA-C:2012', 'IEC 61508', 'DO-178C'] },
            { id: 'ext-fw-pvs-studio',              name: 'PVS-Studio',             sector: 'Firmware & Embedded',      category: 'SAST',                binary: 'pvs-studio',            description: 'PVS-Studio — embedded C/C++ deep static analysis, MISRA checks',                    command: 'pvs-studio-analyzer analyze -o .inverse/pvs.log ${workspace} && plog-converter -a GA:1,2 -t sarif .inverse/pvs.log -o .inverse/pvs.sarif', parseOutput: 'sarif', scope: 'workspace', timeoutMs: 300000, tags: ['MISRA-C:2012', 'CERT-C', 'CWE'] },
            { id: 'ext-fw-flawfinder',              name: 'Flawfinder',             sector: 'Firmware & Embedded',      category: 'SAST',                binary: 'flawfinder',            description: 'Flawfinder — C/C++ buffer overflow, format string vulnerabilities',                  command: 'flawfinder --sarif ${workspace}',                                                                      parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 120000, tags: ['CWE', 'CERT-C'] },
            { id: 'ext-fw-cppdepend',               name: 'CppDepend',              sector: 'Firmware & Embedded',      category: 'Metrics',             binary: 'cppdepend',             description: 'CppDepend — code metrics, complexity, coupling for embedded C/C++',                  command: 'cppdepend --project ${workspace} --report .inverse/cppdepend.xml',                                     parseOutput: 'line-per-violation', scope: 'workspace', timeoutMs: 300000, tags: ['IEC 61508', 'DO-178C'] },
            { id: 'ext-fw-cmetrics',                name: 'CMetrics',               sector: 'Firmware & Embedded',      category: 'Metrics',             binary: 'cmetrics',              description: 'CMetrics — cyclomatic complexity, MISRA metric thresholds for C',                    command: 'cmetrics --output json ${workspace} > .inverse/cmetrics.json',                                         parseOutput: 'json',               scope: 'workspace', timeoutMs: 120000, tags: ['MISRA-C:2012', 'IEC 61508'] },

            // ── Telecom & 5G ─────────────────────────────────────────────────────
            { id: 'ext-telecom-semgrep',            name: 'Semgrep (Telecom)',      sector: 'Telecom & 5G',             category: 'SAST',                binary: 'semgrep',               description: 'Semgrep with 3GPP/GSMA rules — telecom protocol security patterns',                  command: 'semgrep --config=p/telecom --sarif --output .inverse/semgrep-telecom.sarif ${workspace}',              parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 300000, tags: ['3GPP', 'GSMA', 'TS 33.117'] },
            { id: 'ext-telecom-codeql',             name: 'CodeQL',                 sector: 'Telecom & 5G',             category: 'SAST',                binary: 'codeql',                description: 'GitHub CodeQL — deep semantic analysis for C/Java telecom stacks',                   command: 'codeql database analyze --format=sarif-latest --output=.inverse/codeql.sarif ${workspace}',            parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['3GPP', 'ETSI', 'CWE'] },
            { id: 'ext-telecom-checkmarx',          name: 'Checkmarx SAST',         sector: 'Telecom & 5G',             category: 'SAST',                binary: 'cx-cli',                description: 'Checkmarx SAST — GSMA NESAS compliance scanning',                                    command: 'cx-cli scan create --project-name telecom-scan --branch main --directory ${workspace} --report-format sarif', parseOutput: 'sarif',             scope: 'workspace', timeoutMs: 600000, tags: ['GSMA', 'ETSI', 'TS 33.117'] },
            { id: 'ext-telecom-fortify',            name: 'Fortify SCA',            sector: 'Telecom & 5G',             category: 'SAST',                binary: 'sourceanalyzer',        description: 'Fortify SCA — ETSI NFV SEC, telecom deep taint analysis',                            command: 'sourceanalyzer -b telecom-scan -scan -f .inverse/fortify.fpr ${workspace}',                            parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['ETSI', 'NFV SEC', 'GSMA'] },
            { id: 'ext-telecom-sonarqube',          name: 'SonarQube',              sector: 'Telecom & 5G',             category: 'Code Quality',        binary: 'sonar-scanner',         description: 'SonarQube — telecom code quality, security hotspots',                               command: 'sonar-scanner -Dsonar.projectKey=telecom -Dsonar.sources=${workspace}',                                parseOutput: 'json',               scope: 'workspace', timeoutMs: 300000, tags: ['GSMA', 'ETSI', 'OWASP'] },
            { id: 'ext-telecom-bandit',             name: 'Bandit',                 sector: 'Telecom & 5G',             category: 'Python Security',     binary: 'bandit',                description: 'Bandit — Python security for network function scripts and automation',               command: 'bandit -r ${workspace} -f sarif -o .inverse/bandit.sarif',                                             parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 120000, tags: ['3GPP', 'CWE', 'OWASP'] },
            { id: 'ext-telecom-eslint',             name: 'ESLint (security)',      sector: 'Telecom & 5G',             category: 'JS/TS Security',      binary: 'eslint',                description: 'ESLint security plugin — Node.js telecom microservices security',                    command: 'eslint --format=json ${file}',                                                                         parseOutput: 'json',               scope: 'file',      timeoutMs: 30000,  tags: ['ETSI', 'OWASP', 'CWE'] },
            { id: 'ext-telecom-trivy',              name: 'Trivy',                  sector: 'Telecom & 5G',             category: 'Container/SCA',       binary: 'trivy',                 description: 'Trivy — container/dependency CVE scanner for VNF/CNF images',                        command: 'trivy fs --format sarif --output .inverse/trivy.sarif ${workspace}',                                   parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 300000, tags: ['CVE', 'GSMA', 'ETSI'] },
            { id: 'ext-telecom-grype',              name: 'Grype',                  sector: 'Telecom & 5G',             category: 'Container/SCA',       binary: 'grype',                 description: 'Grype — SCA CVE scanning for containerized network functions',                       command: 'grype dir:${workspace} -o sarif --file .inverse/grype.sarif',                                          parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 120000, tags: ['CVE', 'GSMA', 'NFV SEC'] },
            { id: 'ext-telecom-dep-check',          name: 'OWASP Dependency-Check', sector: 'Telecom & 5G',             category: 'SCA',                 binary: 'dependency-check',      description: 'OWASP Dependency-Check — CVE scanning for telecom dependencies',                     command: 'dependency-check --project telecom --scan ${workspace} --format SARIF --out .inverse',                 parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 300000, tags: ['CVE', 'OWASP', 'GSMA'] },

            // ── Industrial IoT & OT ──────────────────────────────────────────────
            { id: 'ext-iiot-claroty',               name: 'Claroty CTD',            sector: 'Industrial IoT & OT',      category: 'OT/ICS Scanning',     binary: 'ctd-scan',              description: 'Claroty CTD — IIoT/OT protocol analysis, IEC 62443 zone/conduit',                   command: 'ctd-scan --workspace ${workspace} --output .inverse/claroty.json',                                     parseOutput: 'json',               scope: 'workspace', timeoutMs: 600000, tags: ['IEC 62443', 'IEC 61850', 'NERC CIP'] },
            { id: 'ext-iiot-semgrep',               name: 'Semgrep (OT rules)',     sector: 'Industrial IoT & OT',      category: 'SAST',                binary: 'semgrep',               description: 'Semgrep with OT/ICS patterns — IEC 62443-4-1 secure coding',                        command: 'semgrep --config=p/ics --sarif --output .inverse/semgrep-ot.sarif ${workspace}',                       parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 300000, tags: ['IEC 62443-4-1', 'IEC 61850', 'NERC CIP'] },
            { id: 'ext-iiot-codesonar',             name: 'CodeSonar',              sector: 'Industrial IoT & OT',      category: 'SAST',                binary: 'codesonar',             description: 'GrammaTech CodeSonar — RTOS/embedded deep static analysis',                          command: 'codesonar analyze ${workspace} .inverse/codesonar -conf .inverse/codesonar.conf',                      parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['IEC 62443-4-1', 'IEC 61508', 'CWE'] },
            { id: 'ext-iiot-polyspace-bf',          name: 'Polyspace Bug Finder',   sector: 'Industrial IoT & OT',      category: 'Formal Verification', binary: 'polyspace-bug-finder',  description: 'Polyspace Bug Finder — IEC 62443 SIL, IIoT firmware safety',                        command: 'polyspace-bug-finder -sources ${workspace} -results-dir .inverse/polyspace',                           parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['IEC 62443', 'IEC 62443-4-1', 'IEC 61508'] },
            { id: 'ext-iiot-checkmarx',             name: 'Checkmarx SAST',         sector: 'Industrial IoT & OT',      category: 'SAST',                binary: 'cx-cli',                description: 'Checkmarx SAST — IEC 62443-4-1 secure development lifecycle',                        command: 'cx-cli scan create --project-name iiot-scan --branch main --directory ${workspace} --report-format sarif', parseOutput: 'sarif',            scope: 'workspace', timeoutMs: 600000, tags: ['IEC 62443-4-1', 'NERC CIP', 'IEC 61850'] },
            { id: 'ext-iiot-infer',                 name: 'Infer',                  sector: 'Industrial IoT & OT',      category: 'SAST',                binary: 'infer',                 description: 'Facebook Infer — null deref, resource leak for IoT C/Java code',                     command: 'infer run -- make -C ${workspace}',                                                                    parseOutput: 'json',               scope: 'workspace', timeoutMs: 300000, tags: ['IEC 62443-4-1', 'CWE'] },
            { id: 'ext-iiot-pvs-studio',            name: 'PVS-Studio',             sector: 'Industrial IoT & OT',      category: 'SAST',                binary: 'pvs-studio',            description: 'PVS-Studio — C/C++ deep analysis for IoT firmware and gateways',                    command: 'pvs-studio-analyzer analyze -o .inverse/pvs.log ${workspace} && plog-converter -a GA:1,2 -t sarif .inverse/pvs.log -o .inverse/pvs.sarif', parseOutput: 'sarif', scope: 'workspace', timeoutMs: 300000, tags: ['IEC 62443-4-1', 'CWE', 'CERT-C'] },
            { id: 'ext-iiot-bandit',                name: 'Bandit',                 sector: 'Industrial IoT & OT',      category: 'Python Security',     binary: 'bandit',                description: 'Bandit Python SAST — IIoT Python scripts, MQTT/CoAP automation',                    command: 'bandit -r ${workspace} -f sarif -o .inverse/bandit.sarif',                                             parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 120000, tags: ['IEC 62443', 'CWE', 'OWASP'] },
            { id: 'ext-iiot-safety',                name: 'Safety',                 sector: 'Industrial IoT & OT',      category: 'Python Security',     binary: 'safety',                description: 'Safety — Python dependency CVEs for IIoT edge stacks',                               command: 'safety check --json --output .inverse/safety.json',                                                    parseOutput: 'json',               scope: 'workspace', timeoutMs: 60000,  tags: ['CVE', 'IEC 62443'] },
            { id: 'ext-iiot-dep-track',             name: 'Dependency-Track',       sector: 'Industrial IoT & OT',      category: 'SBOM',                binary: 'dependency-track-cli',  description: 'OWASP Dependency-Track — SBOM + CVE for IoT supply chain',                          command: 'dependency-track-cli upload --project iiot-sbom --bom ${workspace}/sbom.json',                         parseOutput: 'json',               scope: 'workspace', timeoutMs: 120000, tags: ['IEC 62443', 'CVE', 'SBOM'] },

            // ── General SAST ─────────────────────────────────────────────────────
            { id: 'ext-sast-semgrep',               name: 'Semgrep',                sector: 'General SAST',             category: 'SAST',                binary: 'semgrep',               description: 'Open-source SAST — OWASP, security, cross-language custom rules',                   command: 'semgrep --config=auto --sarif --output .inverse/semgrep.sarif ${workspace}',                           parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 300000, tags: ['OWASP', 'CWE', 'SANS Top 25'] },
            { id: 'ext-sast-codeql',                name: 'CodeQL',                 sector: 'General SAST',             category: 'SAST',                binary: 'codeql',                description: 'GitHub CodeQL — deep semantic code analysis, security queries',                      command: 'codeql database analyze --format=sarif-latest --output=.inverse/codeql.sarif ${workspace}',            parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['CWE', 'OWASP', 'CVE'] },
            { id: 'ext-sast-checkmarx',             name: 'Checkmarx SAST',         sector: 'General SAST',             category: 'SAST',                binary: 'cx-cli',                description: 'Checkmarx SAST — enterprise multi-language vulnerability scanning',                  command: 'cx-cli scan create --project-name gen-scan --branch main --directory ${workspace} --report-format sarif', parseOutput: 'sarif',            scope: 'workspace', timeoutMs: 600000, tags: ['OWASP', 'CWE', 'SANS Top 25'] },
            { id: 'ext-sast-fortify',               name: 'Fortify SCA',            sector: 'General SAST',             category: 'SAST',                binary: 'sourceanalyzer',        description: 'OpenText Fortify SCA — deep taint, dataflow, OWASP Top 10',                          command: 'sourceanalyzer -b gen-scan -scan -f .inverse/fortify.fpr ${workspace}',                                parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['OWASP', 'CWE', 'SANS Top 25'] },
            { id: 'ext-sast-veracode',              name: 'Veracode',               sector: 'General SAST',             category: 'SAST',                binary: 'veracode-cli',          description: 'Veracode — cloud SAST, SCA, DAST, compliance reporting',                            command: 'veracode-cli static scan --source ${workspace} --format sarif --output .inverse/veracode.sarif',        parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['OWASP', 'CWE', 'PCI-DSS'] },
            { id: 'ext-sast-coverity',              name: 'Coverity',               sector: 'General SAST',             category: 'SAST',                binary: 'cov-analyze',           description: 'Synopsys Coverity — enterprise SAST, deep defect, security',                         command: 'cov-analyze --dir .inverse/coverity-int --all --security',                                             parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['OWASP', 'CWE', 'CERT-C'] },
            { id: 'ext-sast-sonarqube',             name: 'SonarQube',              sector: 'General SAST',             category: 'Code Quality',        binary: 'sonar-scanner',         description: 'SonarQube — multi-language code quality and security hotspots',                      command: 'sonar-scanner -Dsonar.projectKey=myproject -Dsonar.sources=${workspace}',                              parseOutput: 'json',               scope: 'workspace', timeoutMs: 300000, tags: ['OWASP', 'CWE', 'SANS Top 25'] },
            { id: 'ext-sast-flawfinder',            name: 'Flawfinder',             sector: 'General SAST',             category: 'C/C++ Security',      binary: 'flawfinder',            description: 'Flawfinder — C/C++ buffer overflow, format string, race conditions',                command: 'flawfinder --sarif ${workspace}',                                                                      parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 120000, tags: ['CWE', 'OWASP'] },
            { id: 'ext-sast-infer',                 name: 'Infer',                  sector: 'General SAST',             category: 'SAST',                binary: 'infer',                 description: 'Meta Infer — null deref, resource leak, concurrency for C/Java',                     command: 'infer run -- make -C ${workspace}',                                                                    parseOutput: 'json',               scope: 'workspace', timeoutMs: 300000, tags: ['CWE', 'OWASP'] },

            // ── General C/C++ ────────────────────────────────────────────────────
            { id: 'ext-cpp-clang-tidy',             name: 'clang-tidy',             sector: 'General C/C++',            category: 'Linter',              binary: 'clang-tidy',            description: 'LLVM clang-tidy — MISRA, CERT, cppcoreguidelines, modernize',                        command: 'clang-tidy ${file} 2>&1',                                                                              parseOutput: 'line-per-violation', scope: 'file',      timeoutMs: 30000,  tags: ['CERT-C', 'CERT-C++', 'CWE'] },
            { id: 'ext-cpp-cppcheck',               name: 'cppcheck',               sector: 'General C/C++',            category: 'SAST',                binary: 'cppcheck',              description: 'cppcheck — open-source C/C++ null ptr, memory leak, undefined behaviour',           command: 'cppcheck --enable=all --xml ${workspace} 2>&1',                                                        parseOutput: 'line-per-violation', scope: 'workspace', timeoutMs: 300000, tags: ['CWE', 'MISRA-C:2012'] },
            { id: 'ext-cpp-pclint',                 name: 'PC-lint Plus',           sector: 'General C/C++',            category: 'MISRA',               binary: 'pclp64',                description: 'Gimpel PC-lint Plus — MISRA C:2012, MISRA C++:2008, strict mode',                   command: 'pclp64 ${file} 2>&1',                                                                                  parseOutput: 'line-per-violation', scope: 'file',      timeoutMs: 30000,  tags: ['MISRA-C:2012', 'MISRA-C++:2008'] },
            { id: 'ext-cpp-pvs-studio',             name: 'PVS-Studio',             sector: 'General C/C++',            category: 'SAST',                binary: 'pvs-studio',            description: 'PVS-Studio — deep C/C++ static analysis, 64-bit, concurrency',                      command: 'pvs-studio-analyzer analyze -o .inverse/pvs.log ${workspace} && plog-converter -a GA:1,2 -t sarif .inverse/pvs.log -o .inverse/pvs.sarif', parseOutput: 'sarif', scope: 'workspace', timeoutMs: 300000, tags: ['CWE', 'MISRA-C:2012', 'CERT-C'] },
            { id: 'ext-cpp-cppdepend',              name: 'CppDepend',              sector: 'General C/C++',            category: 'Metrics',             binary: 'cppdepend',             description: 'CppDepend — C/C++ code metrics, coupling, cyclomatic complexity',                   command: 'cppdepend --project ${workspace} --report .inverse/cppdepend.xml',                                     parseOutput: 'line-per-violation', scope: 'workspace', timeoutMs: 300000, tags: ['CWE'] },
            { id: 'ext-cpp-helix-qac',              name: 'Helix QAC',              sector: 'General C/C++',            category: 'MISRA',               binary: 'helix-qac',             description: 'Perforce Helix QAC — MISRA C:2012, MISRA C++:2008 certified',                        command: 'helix-qac analyze --project ${workspace} --format sarif --output .inverse/helix-qac.sarif',             parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 300000, tags: ['MISRA-C:2012', 'MISRA-C++:2008'] },

            // ── General Enterprise ───────────────────────────────────────────────
            { id: 'ext-ent-klocwork',               name: 'Klocwork',               sector: 'General Enterprise',       category: 'SAST',                binary: 'kwcheck',               description: 'Perforce Klocwork — automotive, aerospace, medical device compliance',               command: 'kwcheck run --report ${workspace} --format sarif',                                                     parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 300000, tags: ['MISRA-C:2012', 'ISO 26262', 'CWE'] },
            { id: 'ext-ent-axivion',                name: 'Axivion Suite',          sector: 'General Enterprise',       category: 'Architecture',        binary: 'axivion-ci',            description: 'Axivion Suite — architecture conformance, MISRA, clone detection',                   command: 'axivion-ci --project ${workspace} --report sarif --output .inverse/axivion',                           parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['MISRA-C:2012', 'ISO 26262', 'CWE'] },
            { id: 'ext-ent-ldra',                   name: 'LDRA TBvision',          sector: 'General Enterprise',       category: 'SAST',                binary: 'tbvision',              description: 'LDRA TBvision — multi-standard certified: DO-178C, IEC 61508, MISRA',               command: 'tbvision --project ${workspace} --report-sarif .inverse/ldra.sarif',                                   parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 600000, tags: ['DO-178C', 'IEC 61508', 'MISRA-C:2012'] },
            { id: 'ext-ent-checkmarx',              name: 'Checkmarx SAST',         sector: 'General Enterprise',       category: 'SAST',                binary: 'cx-cli',                description: 'Checkmarx enterprise SAST — multi-language, compliance reporting',                   command: 'cx-cli scan create --project-name ent-scan --branch main --directory ${workspace} --report-format sarif', parseOutput: 'sarif',            scope: 'workspace', timeoutMs: 600000, tags: ['OWASP', 'CWE', 'PCI-DSS'] },
            { id: 'ext-ent-black-duck',             name: 'Black Duck',             sector: 'General Enterprise',       category: 'SCA',                 binary: 'detect',                description: 'Synopsys Black Duck — open source license compliance + CVE scanning',               command: 'detect --detect.source.path=${workspace} --detect.output.path=.inverse/blackduck',                     parseOutput: 'json',               scope: 'workspace', timeoutMs: 300000, tags: ['CVE', 'OSS License', 'SBOM'] },
            { id: 'ext-ent-snyk',                   name: 'Snyk',                   sector: 'General Enterprise',       category: 'SCA',                 binary: 'snyk',                  description: 'Snyk — developer-first SCA, dependency CVE, IaC misconfigs',                        command: 'snyk test --all-projects --sarif --sarif-file-output=.inverse/snyk.sarif ${workspace}',                 parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 120000, tags: ['CVE', 'OWASP', 'CWE'] },
            { id: 'ext-ent-dep-check',              name: 'OWASP Dependency-Check', sector: 'General Enterprise',       category: 'SCA',                 binary: 'dependency-check',      description: 'OWASP Dependency-Check — NVD CVE scanning for project dependencies',               command: 'dependency-check --project myproject --scan ${workspace} --format SARIF --out .inverse',               parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 300000, tags: ['CVE', 'OWASP', 'NVD'] },
            { id: 'ext-ent-trivy',                  name: 'Trivy',                  sector: 'General Enterprise',       category: 'Container/SCA',       binary: 'trivy',                 description: 'Aqua Trivy — filesystem, container image, IaC CVE scanning',                        command: 'trivy fs --format sarif --output .inverse/trivy.sarif ${workspace}',                                   parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 300000, tags: ['CVE', 'OWASP', 'CIS'] },
            { id: 'ext-ent-grype',                  name: 'Grype',                  sector: 'General Enterprise',       category: 'Container/SCA',       binary: 'grype',                 description: 'Anchore Grype — SCA vulnerability scanning for containers and filesystems',          command: 'grype dir:${workspace} -o sarif --file .inverse/grype.sarif',                                          parseOutput: 'sarif',              scope: 'workspace', timeoutMs: 120000, tags: ['CVE', 'OWASP'] },
        ];

        // Which presets are already configured
        const configuredIds = new Set(this.frameworkRegistry.getActiveFrameworks().map(fw => fw.definition.framework.id));

        // Build per-sector card HTML
        const SECTORS = ['Automotive', 'Critical Infrastructure', 'Firmware & Embedded', 'Telecom & 5G', 'Industrial IoT & OT', 'General SAST', 'General C/C++', 'General Enterprise'] as const;

        const buildSectorCards = (sectorFilter: string | null): string => {
            const filtered = sectorFilter ? TOOL_PRESETS.filter(p => p.sector === sectorFilter) : TOOL_PRESETS;
            if (filtered.length === 0) return '<div class="muted" style="padding:12px 0;font-size:11px">No tools in this sector.</div>';
            // Group by category within sector
            const cats = [...new Set(filtered.map(p => p.category))];
            return cats.map(cat => {
                const presets = filtered.filter(p => p.category === cat);
                const cards = presets.map(p => {
                    const isAdded = configuredIds.has(p.id);
                    const btn = isAdded
                        ? `<span class="preset-added">✓ Added</span>`
                        : `<button class="btn-sm btn-run preset-add-btn" data-preset-id="${this._esc(p.id)}" onclick="addPreset('${this._jsesc(p.id)}')">+ Add</button>`;
                    const cmdShort = p.command.length > 58 ? p.command.slice(0, 58) + '…' : p.command;
                    const tagsHtml = p.tags.slice(0, 3).map(t => `<span class="tag-badge">${this._esc(t)}</span>`).join('');
                    return `<div class="preset-card" id="preset-${this._esc(p.id)}">
                        <div class="preset-head">
                            <span class="preset-name">${this._esc(p.name)}</span>
                            <span class="scope-badge scope-${this._esc(p.scope)}">${this._esc(p.scope)}</span>
                        </div>
                        <div class="preset-tags">${tagsHtml}</div>
                        <div class="preset-desc">${this._esc(p.description)}</div>
                        <div class="preset-cmd mono" title="${this._esc(p.command)}">${this._esc(cmdShort)}</div>
                        <div class="preset-foot">
                            <span class="muted" style="font-size:10px">${this._esc(p.binary)}</span>
                            ${btn}
                        </div>
                    </div>`;
                }).join('');
                return `<div class="preset-cat-label">${this._esc(cat)}</div><div class="preset-grid">${cards}</div>`;
            }).join('');
        };

        const allCardsHtml = buildSectorCards(null);
        const sectorCardsMap: Record<string, string> = {};
        for (const s of SECTORS) {
            sectorCardsMap[s] = buildSectorCards(s);
        }

        // Custom tool builder form HTML
        const customFormHtml = `<div class="custom-form" id="customForm">
            <div class="custom-form-grid">
                <div class="form-group">
                    <label class="form-label">Tool Name</label>
                    <input class="form-input" id="cf-name" type="text" placeholder="e.g. My SAST Tool">
                </div>
                <div class="form-group">
                    <label class="form-label">Binary / Command <span class="muted" style="font-weight:400">(use \${workspace}, \${file}, \${relativeFile})</span></label>
                    <input class="form-input" id="cf-command" type="text" placeholder="e.g. mytool --sarif \${workspace}">
                </div>
                <div class="form-group">
                    <label class="form-label">Output Format</label>
                    <select class="form-select" id="cf-format">
                        <option value="sarif">sarif</option>
                        <option value="json">json</option>
                        <option value="line-per-violation">line-per-violation</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Scope</label>
                    <select class="form-select" id="cf-scope">
                        <option value="workspace">workspace</option>
                        <option value="file">file</option>
                    </select>
                </div>
                <div class="form-group">
                    <label class="form-label">Timeout (ms)</label>
                    <input class="form-input" id="cf-timeout" type="number" value="30000" min="5000" max="600000">
                </div>
                <div class="form-group">
                    <label class="form-label">Description</label>
                    <input class="form-input" id="cf-desc" type="text" placeholder="One-line description">
                </div>
                <div class="form-group form-group-wide">
                    <label class="form-label">Compliance Tags <span class="muted" style="font-weight:400">(comma-separated, e.g. MISRA-C:2012, ISO 26262)</span></label>
                    <input class="form-input" id="cf-tags" type="text" placeholder="OWASP, CWE, MISRA-C:2012">
                </div>
            </div>
            <div class="custom-form-actions">
                <button class="btn" onclick="addCustomTool()">+ Add Custom Tool</button>
            </div>
        </div>`;

        // Serialise preset lookup map for the webview JS
        const presetsJson = JSON.stringify(Object.fromEntries(TOOL_PRESETS.map(p => [p.id, p])));
        // Sector cards data for JS tab switching (render all upfront as hidden divs)
        const sectorDivsHtml = SECTORS.map(s =>
            `<div class="sector-pane" id="sector-pane-${this._esc(s.replace(/[ &\/]/g, '-'))}" style="display:none">${sectorCardsMap[s]}</div>`
        ).join('');
        const presetCardsHtml = `<div class="sector-pane" id="sector-pane-All" style="display:block">${allCardsHtml}</div>${sectorDivsHtml}<div class="sector-pane" id="sector-pane-Custom" style="display:none">${customFormHtml}</div>`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
:root {
    --fg: var(--vscode-foreground,#ccc);
    --fg-muted: var(--vscode-descriptionForeground,#888);
    --bg: var(--vscode-editor-background,#1e1e1e);
    --bg-alt: var(--vscode-editorWidget-background,#252526);
    --border: var(--vscode-widget-border,#333);
    --btn-bg: var(--vscode-button-background,#0e639c);
    --btn-fg: var(--vscode-button-foreground,#fff);
    --btn-hov: var(--vscode-button-hoverBackground,#1177bb);
    --err: #f48771; --warn: #cca700; --ok: #73c991; --info: #4fc1ff;
}
* { box-sizing:border-box; margin:0; padding:0; }
body {
    font-family: var(--vscode-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif);
    font-size:12px; line-height:1.5;
    background:var(--bg); color:var(--fg);
    padding:14px 18px 32px;
}
.page-hdr {
    display:flex; align-items:center; justify-content:space-between;
    margin-bottom:16px; flex-wrap:wrap; gap:8px;
}
.page-title { font-size:14px; font-weight:600; }
.page-sub { font-size:11px; color:var(--fg-muted); margin-top:2px; }
.hdr-actions { display:flex; gap:6px; flex-wrap:wrap; }
.btn { padding:4px 10px; font-size:11px; border:none; border-radius:3px; cursor:pointer;
       background:var(--btn-bg); color:var(--btn-fg); font-family:inherit; }
.btn:hover { background:var(--btn-hov); }
.btn.btn-secondary { background:var(--vscode-button-secondaryBackground,#3a3d41); color:var(--vscode-button-secondaryForeground,#ccc); }
.btn.btn-secondary:hover { background:var(--vscode-button-secondaryHoverBackground,#45494e); }
.btn.btn-danger { background:rgba(244,135,113,.15); color:var(--err); border:1px solid rgba(244,135,113,.3); }
.btn.btn-danger:hover { background:rgba(244,135,113,.25); }
.btn-sm { padding:2px 8px; font-size:10px; border:none; border-radius:2px; cursor:pointer; font-family:inherit; }
.btn-run { background:rgba(79,193,255,.15); color:#4fc1ff; border:1px solid rgba(79,193,255,.3); }
.btn-run:hover { background:rgba(79,193,255,.25); }
.btn-cancel { background:rgba(244,135,113,.15); color:var(--err); border:1px solid rgba(244,135,113,.3); }
.btn-cancel:hover { background:rgba(244,135,113,.25); }
.btn-check { background:rgba(204,167,0,.1); color:var(--warn); border:1px solid rgba(204,167,0,.3); }
.btn-check:hover { background:rgba(204,167,0,.2); }
.section { margin-bottom:22px; }
.sec-hdr {
    display:flex; align-items:center; justify-content:space-between;
    padding:5px 0; margin-bottom:8px;
    border-bottom:1px solid var(--border);
}
.sec-title { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.6px; color:var(--fg-muted); }
.sec-note  { font-size:10px; color:var(--fg-muted); opacity:.6; }
table { width:100%; border-collapse:collapse; }
th { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.4px;
     color:var(--fg-muted); text-align:left; padding:4px 6px; border-bottom:1px solid var(--border); }
td { padding:5px 6px; border-bottom:1px solid rgba(255,255,255,.04); font-size:11px; vertical-align:middle; }
tr:last-child td { border-bottom:none; }
tr:hover td { background:rgba(255,255,255,.025); }
.num { text-align:right; font-variant-numeric:tabular-nums; }
.mono { font-family:var(--vscode-editor-font-family,monospace); font-size:10px; }
.muted { color:var(--fg-muted); }
.rule-id-cell { max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fmt-cell { color:var(--fg-muted); }
/* status dots */
.dot-running { color:#4fc1ff; animation:pulse 1.4s infinite; }
.dot-ok      { color:var(--ok); }
.dot-err     { color:var(--err); }
.dot-muted   { color:var(--fg-muted); }
.dot-idle    { color:var(--fg-muted); opacity:.4; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
/* scope badges */
.scope-badge { font-size:9px; font-weight:700; padding:1px 5px; border-radius:2px; }
.scope-workspace { background:rgba(79,193,255,.12); color:#4fc1ff; border:1px solid rgba(79,193,255,.25); }
.scope-file      { background:rgba(115,201,145,.12); color:var(--ok); border:1px solid rgba(115,201,145,.25); }
/* availability badges */
.avail-ok   { color:var(--ok); font-size:10px; font-weight:700; }
.avail-err  { color:var(--err); font-size:10px; font-weight:700; }
.avail-checking { color:var(--warn); font-size:10px; animation:pulse 1s infinite; }
/* status badges in history */
.st-running { color:#4fc1ff; font-weight:700; }
.st-ok      { color:var(--ok); font-weight:700; }
.st-err     { color:var(--err); font-weight:700; }
.st-muted   { color:var(--fg-muted); }
/* misc */
.badge-notfound { font-size:9px; font-weight:700; padding:1px 5px; border-radius:2px; background:rgba(244,135,113,.12); color:var(--err); border:1px solid rgba(244,135,113,.25); }
.badge-cached { font-size:9px; font-weight:700; padding:1px 5px; border-radius:2px; background:rgba(115,201,145,.12); color:var(--ok); border:1px solid rgba(115,201,145,.25); }
.badge-err { font-size:9px; font-weight:700; padding:1px 5px; border-radius:2px; background:rgba(244,135,113,.12); color:var(--err); border:1px solid rgba(244,135,113,.25); }
.hit-count { color:var(--err); font-weight:700; }
.err-note { color:var(--warn); cursor:help; }
.toast { display:none; position:fixed; bottom:16px; right:16px; padding:8px 14px; border-radius:4px;
         background:var(--bg-alt); border:1px solid var(--border); font-size:11px; z-index:99; }
.toast.show { display:block; animation:fadein .2s; }
@keyframes fadein { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
code { font-family:var(--vscode-editor-font-family,monospace); font-size:10px; background:rgba(255,255,255,.06); padding:1px 4px; border-radius:2px; }
/* ── Tool Presets ── */
.preset-cat-label { font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:.6px; color:var(--fg-muted); margin:8px 0 4px; }
.preset-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:6px; margin-bottom:10px; }
.preset-card { background:var(--bg-alt); border:1px solid var(--border); border-radius:4px; padding:8px 10px; display:flex; flex-direction:column; gap:4px; }
.preset-head { display:flex; align-items:center; gap:5px; }
.preset-name { font-size:11px; font-weight:600; flex:1; }
.preset-desc { font-size:10px; color:var(--fg-muted); line-height:1.4; }
.preset-cmd  { font-size:9px; color:var(--fg-muted); opacity:.7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.preset-foot { display:flex; align-items:center; justify-content:space-between; margin-top:2px; }
.preset-add-btn { padding:2px 8px; font-size:10px; }
.preset-added { font-size:10px; color:var(--ok); font-weight:700; }
/* tag badges */
.preset-tags { display:flex; flex-wrap:wrap; gap:3px; }
.tag-badge { font-size:8px; font-weight:700; padding:1px 4px; border-radius:2px; background:rgba(204,167,0,.1); color:var(--warn); border:1px solid rgba(204,167,0,.25); white-space:nowrap; }
/* sector tabs */
.sector-tabs { display:flex; flex-wrap:wrap; gap:4px; margin-bottom:10px; }
.sector-tab { padding:3px 9px; font-size:10px; font-weight:600; border-radius:3px; cursor:pointer; border:1px solid var(--border); background:transparent; color:var(--fg-muted); font-family:inherit; white-space:nowrap; }
.sector-tab:hover { background:rgba(255,255,255,.05); color:var(--fg); }
.sector-tab.active { background:var(--btn-bg); color:var(--btn-fg); border-color:var(--btn-bg); }
.sector-tab.tab-custom { background:rgba(79,193,255,.08); color:#4fc1ff; border-color:rgba(79,193,255,.3); }
.sector-tab.tab-custom.active { background:rgba(79,193,255,.25); }
/* custom form */
.custom-form { padding:10px 0; }
.custom-form-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.form-group { display:flex; flex-direction:column; gap:3px; }
.form-group-wide { grid-column:1/-1; }
.form-label { font-size:10px; font-weight:600; color:var(--fg-muted); text-transform:uppercase; letter-spacing:.4px; }
.form-input, .form-select { background:var(--bg-alt); border:1px solid var(--border); border-radius:3px; padding:4px 7px; font-size:11px; color:var(--fg); font-family:inherit; outline:none; width:100%; }
.form-input:focus, .form-select:focus { border-color:rgba(79,193,255,.5); }
.custom-form-actions { margin-top:12px; }
</style>
</head>
<body>
<div class="page-hdr">
    <div>
        <div class="page-title">External Tools</div>
        <div class="page-sub">Configure and manage CLI tool integrations (CodeQL, Semgrep, Polyspace, MATLAB, ESLint…)</div>
    </div>
    <div class="hdr-actions">
        <button class="btn" onclick="runAll()">▶ Run All</button>
        <button class="btn btn-secondary" onclick="cancelAll()">✕ Cancel All</button>
        <button class="btn btn-secondary" onclick="clearCache()">⊘ Clear Cache</button>
    </div>
</div>

<div class="section">
    <div class="sec-hdr">
        <span class="sec-title">Tool Presets</span>
        <span class="sec-note">One click to connect any tool — generates a framework rule and writes it to .inverse/frameworks/</span>
    </div>
    <div class="sector-tabs" id="sectorTabs">
        <button class="sector-tab active" onclick="switchSector('All')" id="stab-All">All</button>
        <button class="sector-tab" onclick="switchSector('Automotive')" id="stab-Automotive">Automotive</button>
        <button class="sector-tab" onclick="switchSector('Critical Infrastructure')" id="stab-Critical-Infrastructure">Critical Infrastructure</button>
        <button class="sector-tab" onclick="switchSector('Firmware &amp; Embedded')" id="stab-Firmware---Embedded">Firmware &amp; Embedded</button>
        <button class="sector-tab" onclick="switchSector('Telecom &amp; 5G')" id="stab-Telecom---5G">Telecom &amp; 5G</button>
        <button class="sector-tab" onclick="switchSector('Industrial IoT &amp; OT')" id="stab-Industrial-IoT---OT">Industrial IoT &amp; OT</button>
        <button class="sector-tab" onclick="switchSector('General')" id="stab-General">General</button>
        <button class="sector-tab tab-custom" onclick="switchSector('Custom')" id="stab-Custom">+ Custom</button>
    </div>
    <div id="presetPanes">
        ${presetCardsHtml}
    </div>
</div>

<div class="section">
    <div class="sec-hdr">
        <span class="sec-title">Configured Tools</span>
        <span class="sec-note">${allRules.length} rule${allRules.length !== 1 ? 's' : ''} · workspace-scope runs once per scan · file-scope runs on save</span>
    </div>
    <table>
        <thead>
            <tr>
                <th style="width:18px"></th>
                <th>Rule ID</th>
                <th>Binary</th>
                <th>Scope</th>
                <th>Format</th>
                <th class="num">Duration</th>
                <th class="num">Hits</th>
                <th>Note</th>
                <th>Available?</th>
                <th>Action</th>
            </tr>
        </thead>
        <tbody id="toolsTbody">${toolRowsHtml}</tbody>
    </table>
</div>

<div class="section">
    <div class="sec-hdr">
        <span class="sec-title">Job History</span>
        <span class="sec-note">Last 30 runs · updates live</span>
    </div>
    <table>
        <thead>
            <tr>
                <th>Status</th>
                <th>Rule</th>
                <th>Scope</th>
                <th class="num">Duration</th>
                <th class="num">Hits</th>
                <th>Started</th>
                <th>Notes</th>
            </tr>
        </thead>
        <tbody id="historyTbody">${historyRowsHtml}</tbody>
    </table>
</div>

<div class="toast" id="toast"></div>

<script>
const vscode = acquireVsCodeApi();
(function(){const _iv=()=>vscode.postMessage({type:'webviewInteraction'});document.addEventListener('click',_iv,true);document.addEventListener('input',_iv,true);document.addEventListener('keydown',_iv,true);})();

function runTool(ruleId) {
    vscode.postMessage({ type: 'runExternalTool', ruleId });
    showToast('Job queued for ' + ruleId);
}
function runAll() {
    vscode.postMessage({ type: 'runAllExternalTools' });
    showToast('All workspace-scope tools queued');
}
function cancelAll() {
    vscode.postMessage({ type: 'cancelExternalTools' });
    showToast('Cancelling all jobs…');
}
function clearCache() {
    vscode.postMessage({ type: 'clearExternalCache' });
}
function checkAvail(binary, ruleId) {
    const cell = document.getElementById('avail-' + ruleId.replace(/[^a-zA-Z0-9_-]/g,'_'));
    if (cell) cell.innerHTML = '<span class="avail-checking">checking…</span>';
    vscode.postMessage({ type: 'checkToolAvailability', binary });
}
const _PRESETS = ${presetsJson};

// Sector tab keys mapped to pane IDs (IDs derived from sector.replace(/[ &\/]/g,'-'))
const _SECTOR_PANE_IDS = {
    'All': 'sector-pane-All',
    'Automotive': 'sector-pane-Automotive',
    'Critical Infrastructure': 'sector-pane-Critical-Infrastructure',
    'Firmware & Embedded': 'sector-pane-Firmware---Embedded',
    'Telecom & 5G': 'sector-pane-Telecom---5G',
    'Industrial IoT & OT': 'sector-pane-Industrial-IoT---OT',
    'General SAST': 'sector-pane-General-SAST',
    'General C/C++': 'sector-pane-General-C-C++',
    'General Enterprise': 'sector-pane-General-Enterprise',
    'Custom': 'sector-pane-Custom',
};
// "General" tab shows all three General sub-sectors
let _activeSector = 'All';
function switchSector(sector) {
    _activeSector = sector;
    // Hide all panes
    document.querySelectorAll('.sector-pane').forEach(el => { el.style.display = 'none'; });
    // Show relevant panes
    if (sector === 'General') {
        ['sector-pane-General-SAST','sector-pane-General-C-C++','sector-pane-General-Enterprise'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'block';
        });
    } else {
        const paneId = _SECTOR_PANE_IDS[sector];
        if (paneId) {
            const el = document.getElementById(paneId);
            if (el) el.style.display = 'block';
        }
    }
    // Update tab active states
    document.querySelectorAll('.sector-tab').forEach(btn => btn.classList.remove('active'));
    // Find the clicked tab by mapping sector to button id
    const tabIdMap = {
        'All': 'stab-All',
        'Automotive': 'stab-Automotive',
        'Critical Infrastructure': 'stab-Critical-Infrastructure',
        'Firmware & Embedded': 'stab-Firmware---Embedded',
        'Telecom & 5G': 'stab-Telecom---5G',
        'Industrial IoT & OT': 'stab-Industrial-IoT---OT',
        'General': 'stab-General',
        'Custom': 'stab-Custom',
    };
    const tabEl = document.getElementById(tabIdMap[sector]);
    if (tabEl) tabEl.classList.add('active');
}

function addPreset(presetId) {
    const p = _PRESETS[presetId];
    if (!p) return;
    const card = document.getElementById('preset-' + presetId);
    const btn = card && card.querySelector('.preset-add-btn');
    if (btn) { btn.textContent = 'Adding…'; btn.disabled = true; }
    vscode.postMessage({ type: 'addToolPreset', preset: p });
}

function addCustomTool() {
    const name = (document.getElementById('cf-name').value || '').trim();
    const command = (document.getElementById('cf-command').value || '').trim();
    const fmt = document.getElementById('cf-format').value;
    const scope = document.getElementById('cf-scope').value;
    const timeout = parseInt(document.getElementById('cf-timeout').value, 10) || 30000;
    const desc = (document.getElementById('cf-desc').value || '').trim();
    const tagsRaw = (document.getElementById('cf-tags').value || '').trim();
    if (!name || !command) { showToast('Tool Name and Command are required.'); return; }
    // Extract binary as first token of command
    const binary = command.split(/\s+/)[0];
    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
    const id = 'ext-custom-' + Date.now();
    const preset = { id, name, sector: 'Custom', category: 'Custom', binary, description: desc || name, command, parseOutput: fmt, scope, timeoutMs: timeout, tags };
    vscode.postMessage({ type: 'addToolPreset', preset });
    showToast('Adding custom tool "' + name + '"…');
}
function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2500);
}

// Time-ago helper (runs in webview, no server round-trip needed for display refresh)
function timeAgo(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s/60) + 'm ago';
    return Math.floor(s/3600) + 'h ago';
}

window.addEventListener('message', function(ev) {
    const msg = ev.data;
    if (msg.type === 'externalJobUpdate') {
        updateJobInTables(msg.job);
    } else if (msg.type === 'toolAvailabilityResult') {
        updateAvailability(msg.binary, msg.available);
    } else if (msg.type === 'cacheClearedConfirm') {
        document.getElementById('historyTbody').innerHTML =
            '<tr><td colspan="7" class="muted" style="padding:10px;text-align:center">No job history yet</td></tr>';
        showToast('Cache cleared');
    } else if (msg.type === 'presetAdded') {
        const card = document.getElementById('preset-' + msg.presetId);
        if (card) {
            const foot = card.querySelector('.preset-foot');
            if (foot) {
                const btn = foot.querySelector('.preset-add-btn');
                if (btn) btn.remove();
                const badge = document.createElement('span');
                badge.className = 'preset-added';
                badge.textContent = msg.success ? '✓ Added' : '✗ Failed';
                foot.appendChild(badge);
            }
        }
        showToast(msg.success ? msg.presetName + ' added — appears in Configured Tools' : 'Failed to add ' + msg.presetName + ': ' + (msg.error || 'unknown error'));
    }
});

function updateAvailability(binary, available) {
    // Find all rows whose binary column matches and update avail cell
    document.querySelectorAll('#toolsTbody tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells[2] && cells[2].textContent.trim() === binary) {
            const availCell = cells[8];
            if (availCell) {
                if (available) {
                    availCell.innerHTML = '<span class="avail-ok">✓ available</span>';
                } else {
                    availCell.innerHTML = '<span class="avail-err">✗ not in PATH</span>';
                }
            }
        }
    });
}

function updateJobInTables(job) {
    // Update the configured-tools row
    const dotCls = job.status==='running'?'dot-running':job.status==='complete'?'dot-ok':job.status==='failed'?'dot-err':'dot-muted';
    const dotChar = job.status==='running'?'●':job.status==='complete'?'✓':job.status==='failed'?'✗':'○';
    const rowId = 'rule-row-' + job.ruleId.replace(/[^a-zA-Z0-9_-]/g,'_');
    const row = document.getElementById(rowId);
    if (row) {
        const cells = row.querySelectorAll('td');
        // col 0 = dot
        if (cells[0]) cells[0].innerHTML = '<span class="' + dotCls + '">' + dotChar + '</span>';
        // col 5 = duration
        if (cells[5] && job.durationMs) {
            const d = job.durationMs > 60000
                ? Math.round(job.durationMs/60000)+'m '+Math.round((job.durationMs%60000)/1000)+'s'
                : (job.durationMs/1000).toFixed(1)+'s';
            cells[5].textContent = d;
        }
        // col 6 = hits
        if (cells[6] && job.resultCount !== undefined) {
            cells[6].innerHTML = job.resultCount > 0
                ? '<span class="hit-count">'+job.resultCount+'</span>'
                : ''+job.resultCount;
        }
        // col 7 = note
        if (cells[7]) {
            const skipNote = job.skipReason==='tool-not-found'?'<span class="badge-notfound">not in PATH</span>'
                :job.skipReason==='cache-hit'?'<span class="badge-cached">cached</span>'
                :job.skipReason==='license-error'?'<span class="badge-err">license error</span>':'';
            cells[7].innerHTML = skipNote;
        }
        // col 9 = action
        if (cells[9]) {
            const isRunning = job.status==='running'||job.status==='queued';
            if (job.scope === 'workspace') {
                cells[9].innerHTML = isRunning
                    ? '<button class="btn-sm btn-cancel" onclick="cancelAll()">✕</button>'
                    : '<button class="btn-sm btn-run" onclick="runTool(\\'' + job.ruleId.replace(/'/g,"\\'") + '\\')">▶ Run</button>';
            }
        }
    }

    // Prepend to history table
    const tbody = document.getElementById('historyTbody');
    if (tbody) {
        const placeholder = tbody.querySelector('tr td[colspan]');
        if (placeholder) tbody.innerHTML = '';
        // Remove stale entry for this job if already present
        const existing = document.getElementById('hjob-' + job.id.replace(/[^a-zA-Z0-9_-]/g,'_'));
        if (existing) existing.remove();
        // Build new row
        const statusCls = job.status==='running'?'st-running':job.status==='complete'?'st-ok':job.status==='failed'?'st-err':'st-muted';
        const dur = job.durationMs?(job.durationMs>60000?Math.round(job.durationMs/60000)+'m '+Math.round((job.durationMs%60000)/1000)+'s':(job.durationMs/1000).toFixed(1)+'s'):'—';
        const tr = document.createElement('tr');
        tr.id = 'hjob-' + job.id.replace(/[^a-zA-Z0-9_-]/g,'_');
        tr.innerHTML =
            '<td><span class="'+statusCls+'">'+job.status+'</span></td>'+
            '<td class="mono">'+job.ruleId+'</td>'+
            '<td><span class="scope-badge scope-'+job.scope+'">'+job.scope+'</span></td>'+
            '<td class="num">'+dur+'</td>'+
            '<td class="num">'+(job.resultCount>0?'<span class="hit-count">'+job.resultCount+'</span>':job.resultCount)+'</td>'+
            '<td class="muted">'+timeAgo(job.queuedAt)+'</td>'+
            '<td>'+(job.cacheHit?'<span class="badge-cached">cached</span>':'')+(job.error?'<span class="err-note" title="'+job.error.substring(0,200)+'">⚠</span>':'')+'</td>';
        tbody.insertBefore(tr, tbody.firstChild);
        // Keep history to 30 rows
        while (tbody.children.length > 30) tbody.removeChild(tbody.lastChild);
    }
}
</script>
</body>
</html>`;
    }

    private _getAIScanHtml(): string {
        const state = this.contractReasonService.getScanTrackerState();
        const periodicActive = this.grcEngine.isPeriodicAIScanActive;
        const inlineDiagEnabled = this.grcEngine.inlineDiagnosticsEnabled;

        const progress = state.totalFiles > 0
            ? Math.round(((state.scannedCount + state.skippedCount + state.errorCount) / state.totalFiles) * 100)
            : 0;

        const lastCompleted = state.lastScanCompleted
            ? this._timeAgo(state.lastScanCompleted)
            : '—';

        const statusLabel = state.isScanning
            ? `<span style="color:#4fc1ff;animation:pulse 1.2s infinite">Scanning...</span>`
            : state.totalFiles > 0
            ? `<span style="color:#73c991">Idle</span>`
            : `<span style="opacity:.5">Not started</span>`;

        // Sort: errors first, then in-flight, then scanned, then skipped
        const sortOrder: Record<string, number> = { error: 0, scanning: 1, scanned: 2, skipped: 3, queued: 4 };
        const sortedEntries = [...state.entries].sort((a, b) => {
            const statusDiff = (sortOrder[a.status] ?? 5) - (sortOrder[b.status] ?? 5);
            if (statusDiff !== 0) return statusDiff;
            return (b.riskScore ?? 0) - (a.riskScore ?? 0);
        });

        const fileRowsHtml = sortedEntries.slice(0, 200).map(e => {
            const fname = e.fileName || (e.fileUri.split('/').pop() ?? e.fileUri);
            const dotCls = e.status === 'error' ? 'ai-dot-err' : e.status === 'scanning' ? 'ai-dot-scan' : e.status === 'scanned' ? 'ai-dot-ok' : 'ai-dot-skip';
            const statusText = e.status === 'error' ? (e.errorMessage ?? 'error') : e.status === 'scanning' ? 'scanning...' : e.status === 'scanned' ? `${e.violationCount ?? 0} violations` : (e.skipReason ?? 'skipped');
            const timeLabel = e.timestamp ? this._timeAgo(e.timestamp) : '';
            const riskBar = e.riskScore != null && e.riskScore > 0
                ? `<div style="width:${Math.min(e.riskScore, 100)}%;height:2px;background:rgba(244,135,113,${Math.min(e.riskScore / 100, 0.9)});border-radius:1px;margin-top:1px"></div>`
                : '';
            return `<tr class="ai-file-row ai-${e.status}">
                <td><span class="${dotCls}">●</span></td>
                <td class="ai-fname" title="${this._esc(e.fileUri)}">${this._esc(fname)}${riskBar}</td>
                <td class="ai-status-cell">${this._esc(statusText)}</td>
                <td class="ai-time-cell">${this._esc(timeLabel)}</td>
            </tr>`;
        }).join('');

        const filterBtnsHtml = ['All', 'Scanned', 'Skipped', 'Errors', 'In-flight'].map(f =>
            `<button class="ai-filter-btn" data-filter="${f.toLowerCase().replace('-', '')}" onclick="filterRows(this,'${f.toLowerCase().replace('-', '')}')">${f}</button>`
        ).join('');

        const sortBtnsHtml = ['Risk', 'Violations', 'Recent', 'Name'].map(s =>
            `<button class="ai-sort-btn" data-sort="${s.toLowerCase()}" onclick="sortRows(this,'${s.toLowerCase()}')">${s}</button>`
        ).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8">
<style>
:root {
    --fg: var(--vscode-foreground,#ccc); --fg-muted: var(--vscode-descriptionForeground,#888);
    --bg: var(--vscode-editor-background,#1e1e1e); --bg-alt: var(--vscode-editorWidget-background,#252526);
    --border: var(--vscode-widget-border,#333);
    --btn-bg: var(--vscode-button-background,#0e639c); --btn-fg: var(--vscode-button-foreground,#fff);
    --btn-hov: var(--vscode-button-hoverBackground,#1177bb);
    --err: #f48771; --warn: #cca700; --ok: #73c991; --info: #4fc1ff;
}
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:var(--vscode-font-family,-apple-system,sans-serif); font-size:12px; line-height:1.5; background:var(--bg); color:var(--fg); padding:14px 18px 32px; }

.page-hdr { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; flex-wrap:wrap; gap:8px; }
.page-title { font-size:14px; font-weight:600; }
.hdr-actions { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }

.btn { padding:4px 10px; font-size:11px; border:none; border-radius:3px; cursor:pointer; background:var(--btn-bg); color:var(--btn-fg); font-family:inherit; }
.btn:hover { background:var(--btn-hov); }
.btn-sec { background:var(--vscode-button-secondaryBackground,#3a3d41); color:var(--vscode-button-secondaryForeground,#ccc); }
.btn-sec:hover { background:var(--vscode-button-secondaryHoverBackground,#45494e); }
.btn-danger { background:rgba(244,135,113,.15); color:var(--err); border:1px solid rgba(244,135,113,.3); }
.btn-danger:hover { background:rgba(244,135,113,.25); }
.btn-warn { background:rgba(204,167,0,.15); color:var(--warn); border:1px solid rgba(204,167,0,.3); }
.btn-warn:hover { background:rgba(204,167,0,.25); }
.live-badge { display:inline-block; font-size:9px; font-weight:700; letter-spacing:.05em; color:#fff; background:var(--err); border-radius:3px; padding:1px 5px; margin-left:6px; vertical-align:middle; animation:livePulse 1.4s ease-in-out infinite; }
@keyframes livePulse { 0%,100%{opacity:1} 50%{opacity:.5} }
.error-notice { background:rgba(244,135,113,.1); border:1px solid rgba(244,135,113,.3); border-radius:4px; padding:8px 12px; margin-bottom:12px; font-size:11px; color:var(--err); }

/* ── Stats grid ── */
.stats-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-bottom:14px; }
.stat-card { background:var(--bg-alt); border:1px solid var(--border); border-radius:4px; padding:8px 10px; }
.stat-val { font-size:18px; font-weight:700; font-variant-numeric:tabular-nums; }
.stat-lbl { font-size:10px; color:var(--fg-muted); margin-top:2px; }
.stat-val.err { color:var(--err); } .stat-val.ok { color:var(--ok); } .stat-val.info { color:var(--info); } .stat-val.warn { color:var(--warn); }

/* ── Progress bar ── */
.prog-wrap { margin-bottom:14px; }
.prog-track { height:4px; border-radius:2px; background:var(--border); overflow:hidden; }
.prog-fill { height:100%; border-radius:2px; background:var(--info); transition:width .3s; }
.prog-label { font-size:10px; color:var(--fg-muted); margin-top:4px; }

/* ── Inline diag toggle ── */
.settings-row { display:flex; align-items:center; gap:16px; margin-bottom:14px; padding:8px 10px; background:var(--bg-alt); border:1px solid var(--border); border-radius:4px; font-size:11px; flex-wrap:wrap; }
.setting-item { display:flex; align-items:center; gap:6px; cursor:pointer; user-select:none; }
.toggle-track { width:28px; height:14px; border-radius:7px; position:relative; flex-shrink:0; transition:background .15s; border:1px solid rgba(255,255,255,.15); }
.toggle-track.on  { background:rgba(79,193,255,.35); border-color:rgba(79,193,255,.5); }
.toggle-track.off { background:rgba(255,255,255,.06); }
.toggle-thumb { width:10px; height:10px; border-radius:50%; background:white; position:absolute; top:1px; transition:left .15s; }
.toggle-track.on  .toggle-thumb { left:15px; }
.toggle-track.off .toggle-thumb { left:2px; }
.setting-label { color:var(--fg-muted); }

/* ── Status table ── */
.info-table { width:100%; border-collapse:collapse; margin-bottom:14px; }
.info-table td { padding:5px 0; font-size:12px; border-bottom:1px solid var(--border); }
.info-table td:first-child { color:var(--fg-muted); width:140px; }
.info-table tr:last-child td { border-bottom:none; }

/* ── Filter / sort bar ── */
.filter-bar { display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px; align-items:center; }
.filter-label { font-size:10px; color:var(--fg-muted); margin-right:2px; }
.ai-filter-btn, .ai-sort-btn { font-size:10px; padding:2px 8px; border:1px solid var(--border); border-radius:10px; background:var(--bg-alt); color:var(--fg-muted); cursor:pointer; font-family:inherit; }
.ai-filter-btn:hover, .ai-sort-btn:hover { color:var(--fg); border-color:rgba(255,255,255,.2); }
.ai-filter-btn.active { background:rgba(79,193,255,.12); color:var(--info); border-color:rgba(79,193,255,.35); }
.ai-sort-btn.active  { background:rgba(255,255,255,.07); color:var(--fg); border-color:rgba(255,255,255,.2); }
.filter-sep { width:1px; height:16px; background:var(--border); margin:0 4px; }

/* ── File table ── */
table.ai-table { width:100%; border-collapse:collapse; }
.ai-file-row td { padding:4px 6px 4px 0; border-bottom:1px solid rgba(255,255,255,.04); font-size:11px; }
.ai-file-row:last-child td { border-bottom:none; }
.ai-fname { font-family:var(--vscode-editor-font-family,monospace); max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ai-status-cell { color:var(--fg-muted); font-size:10.5px; }
.ai-time-cell { color:var(--fg-muted); font-size:10px; opacity:.55; text-align:right; white-space:nowrap; }
.ai-dot-err  { color:var(--err); font-size:10px; }
.ai-dot-scan { color:var(--info); font-size:10px; animation:pulse 1.2s infinite; }
.ai-dot-ok   { color:var(--ok); font-size:10px; }
.ai-dot-skip { color:var(--fg-muted); font-size:10px; opacity:.4; }
.ai-error .ai-status-cell { color:var(--err); }
.ai-scanned .ai-status-cell { color:var(--ok); }

@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
</style></head>
<body>

<div class="page-hdr">
    <div>
        <div class="page-title">⊙ AI Scan Tracker ${state.isScanning ? '<span class="live-badge">LIVE</span>' : ''}</div>
        <div style="font-size:11px;color:var(--fg-muted);margin-top:3px">${periodicActive ? `Periodic scan active — interval: 120s` : 'On-demand scanning'}</div>
    </div>
    <div class="hdr-actions">
        <button class="btn" onclick="scanNow()" id="scanNowBtn" ${state.isScanning ? 'disabled' : ''}>Scan Workspace</button>
        ${periodicActive
            ? `<button class="btn btn-sec" onclick="stopPeriodic()">Stop Periodic Scan</button>`
            : `<button class="btn btn-sec" onclick="startPeriodic()">Start Periodic Scan</button>`
        }
        ${state.errorCount > 0
            ? `<button class="btn btn-warn" onclick="retryErrors()" title="Clear error state and re-scan failed files">↺ Retry ${state.errorCount} Error${state.errorCount !== 1 ? 's' : ''}</button>`
            : ''
        }
        <button class="btn btn-danger" onclick="resetCache()" title="Clear AI content-hash cache — forces full re-analysis of all files">Reset Cache</button>
    </div>
</div>
${state.errorCount > 0 ? `
<div class="error-notice">
    <span class="err-icon">⚠</span>
    <span>${state.errorCount} file${state.errorCount !== 1 ? 's' : ''} failed AI analysis — usually caused by the model not returning a parseable GRC response. Click <b>↺ Retry</b> to re-scan, or <b>Reset Cache</b> to force a full fresh scan.</span>
</div>` : ''}

<div class="settings-row">
    <div class="setting-item" onclick="toggleInlineDiag()" title="Show/hide editor squiggly lines — analysis always runs in background">
        <div class="toggle-track ${inlineDiagEnabled ? 'on' : 'off'}" id="inlineDiagTrack">
            <div class="toggle-thumb"></div>
        </div>
        <span class="setting-label">Inline errors ${inlineDiagEnabled ? '<span style="color:#73c991;font-size:9px">● visible</span>' : '<span style="opacity:.4;font-size:9px">○ hidden</span>'}</span>
    </div>
    <div class="setting-item" style="margin-left:auto;cursor:default;pointer-events:none">
        <span style="font-size:10px;opacity:.45">GRC engine always active in background</span>
    </div>
</div>

<div class="stats-grid">
    <div class="stat-card"><div class="stat-val">${state.totalFiles}</div><div class="stat-lbl">Total Files</div></div>
    <div class="stat-card"><div class="stat-val ok">${state.scannedCount}</div><div class="stat-lbl">Scanned (AI)</div></div>
    <div class="stat-card"><div class="stat-val" style="color:var(--fg-muted)">${state.skippedCount}</div><div class="stat-lbl">Skipped (cached)</div></div>
    <div class="stat-card"><div class="stat-val err">${state.errorCount}</div><div class="stat-lbl">Errors</div></div>
    <div class="stat-card"><div class="stat-val info">${state.scanningCount}</div><div class="stat-lbl">In-flight</div></div>
    <div class="stat-card"><div class="stat-val">${statusLabel}</div><div class="stat-lbl">Status</div></div>
</div>

${state.totalFiles > 0 ? `
<div class="prog-wrap">
    <div class="prog-track"><div class="prog-fill" style="width:${progress}%"></div></div>
    <div class="prog-label">${progress}% complete · Last completed: ${this._esc(lastCompleted)}</div>
</div>` : ''}

<div class="filter-bar">
    <span class="filter-label">Filter:</span>
    ${filterBtnsHtml}
    <div class="filter-sep"></div>
    <span class="filter-label">Sort:</span>
    ${sortBtnsHtml}
</div>

<table class="ai-table" id="aiTable">
<thead><tr>
    <th style="width:20px"></th>
    <th style="text-align:left;font-size:10px;font-weight:600;color:var(--fg-muted);padding:4px 0;border-bottom:1px solid var(--border)">File</th>
    <th style="text-align:left;font-size:10px;font-weight:600;color:var(--fg-muted);padding:4px 0;border-bottom:1px solid var(--border)">Status</th>
    <th style="text-align:right;font-size:10px;font-weight:600;color:var(--fg-muted);padding:4px 0;border-bottom:1px solid var(--border)">Time</th>
</tr></thead>
<tbody id="aiTableBody">${fileRowsHtml || '<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--fg-muted);font-style:italic">No files scanned yet — click Scan Workspace to start</td></tr>'}</tbody>
</table>

<script>
const vscode = acquireVsCodeApi();
(function(){const _iv=()=>vscode.postMessage({type:'webviewInteraction'});document.addEventListener('click',_iv,true);document.addEventListener('input',_iv,true);})();

function scanNow() { vscode.postMessage({ type: 'scanWorkspaceAI' }); }
function stopPeriodic() { vscode.postMessage({ type: 'stopPeriodicScan' }); }
function startPeriodic() { vscode.postMessage({ type: 'startPeriodicScan' }); }
function resetCache() { vscode.postMessage({ type: 'resetAICache' }); }
function retryErrors() { vscode.postMessage({ type: 'retryErrors' }); }

function toggleInlineDiag() {
    const track = document.getElementById('inlineDiagTrack');
    const enabled = track ? !track.classList.contains('on') : true;
    vscode.postMessage({ type: 'toggleInlineDiagnostics', enabled });
}

let _activeFilter = 'all';
let _activeSort = 'risk';

function filterRows(btn, filter) {
    _activeFilter = filter;
    document.querySelectorAll('.ai-filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    document.querySelectorAll('.ai-file-row').forEach(row => {
        const cls = row.className;
        if (filter === 'all') { row.style.display = ''; return; }
        if (filter === 'scanned') { row.style.display = cls.includes('ai-scanned') ? '' : 'none'; return; }
        if (filter === 'skipped') { row.style.display = cls.includes('ai-skipped') || cls.includes('ai-queued') ? '' : 'none'; return; }
        if (filter === 'errors') { row.style.display = cls.includes('ai-error') ? '' : 'none'; return; }
        if (filter === 'inflight') { row.style.display = cls.includes('ai-scanning') ? '' : 'none'; return; }
        row.style.display = '';
    });
}

function sortRows(btn, sort) {
    document.querySelectorAll('.ai-sort-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    _activeSort = sort;
}

// Activate first filter and sort buttons on load
window.addEventListener('DOMContentLoaded', () => {
    const fb = document.querySelector('.ai-filter-btn');
    if (fb) fb.classList.add('active');
    const sb = document.querySelector('.ai-sort-btn');
    if (sb) sb.classList.add('active');
});
</script>
</body></html>`;
    }

    private _buildImpactHtml(allResults: ICheckResult[]): string {
        // Get files with violations
        const filesWithViolations = new Map<string, URI>();
        for (const r of allResults) {
            filesWithViolations.set(r.fileUri.toString(), r.fileUri);
        }

        if (filesWithViolations.size === 0) return '';

        // Build impact trees for files that have dependents
        const impactTrees: string[] = [];
        let filesProcessed = 0;

        for (const [, fileUri] of filesWithViolations) {
            if (filesProcessed >= 5) break;
            const chain = this.grcEngine.getImpactChain(fileUri, 3);
            if (!chain || chain.dependents.length === 0) continue;

            filesProcessed++;
            const breakingAlert = chain.hasBreakingChanges
                ? `<div class="impact-alert">Breaking changes in <strong>${this._esc(chain.fileName)}</strong> affect <strong>${chain.dependents.length} dependent file${chain.dependents.length === 1 ? '' : 's'}</strong></div>`
                : '';

            impactTrees.push(`
                ${breakingAlert}
                <div class="impact-tree">
                    ${this._renderImpactNode(chain, true)}
                </div>
            `);
        }

        if (impactTrees.length === 0) {
            const importMap = this.grcEngine.getImportedByMap();
            if (importMap.size === 0) {
                return `<div class="section">
                    <div class="sec-hdr"><span class="sec-title">Cross-File Impact</span></div>
                    <div style="font-size:11px;color:var(--fg-muted);font-style:italic;padding:8px 0">Run a workspace scan to discover import relationships.</div>
                </div>`;
            }
            // Violations exist but none propagate — show a summary count as a hint
            return `<div class="section">
                <div class="sec-hdr"><span class="sec-title">Cross-File Impact</span></div>
                <div style="font-size:11px;color:var(--fg-muted);padding:6px 0">${filesWithViolations.size} file${filesWithViolations.size === 1 ? '' : 's'} with violations — none imported by other files. <span style="cursor:pointer;text-decoration:underline" onclick="(function(){const vsc=acquireVsCodeApi?.();if(vsc)vsc.postMessage({type:'navigateView',view:'impact'});})()">View all →</span></div>
            </div>`;
        }

        return `<div class="section">
    <div class="sec-hdr"><span class="sec-title">Cross-File Impact</span></div>
    ${impactTrees.join('')}
</div>
<style>
.impact-tree { margin-bottom: 12px; }
.impact-node {
    padding: 4px 0 4px 12px;
    border-left: 2px solid var(--border);
    margin-left: 4px;
}
.impact-node.root { border-left: 2px solid var(--err); padding-left: 12px; }
.impact-node.root.no-breaking { border-left-color: var(--warn); }
.impact-file {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px; font-weight: 600;
}
.impact-file.nav-link { cursor: pointer; text-decoration: underline; text-decoration-style: dotted; }
.impact-file.nav-link:hover { color: var(--info); }
.impact-badge {
    font-size: 9px; padding: 1px 5px; border-radius: 2px;
    margin-left: 6px; vertical-align: middle;
}
.impact-badge.breaking { background: rgba(244,135,113,.15); color: var(--err); }
.impact-badge.affected { background: rgba(204,167,0,.15); color: var(--warn); }
.impact-badge.ok { background: rgba(115,201,145,.15); color: var(--ok); }
.impact-arrow {
    font-size: 9px; color: var(--fg-muted); margin: 2px 0 2px 16px;
}
.impact-alert {
    font-size: 11px; padding: 6px 10px; margin-bottom: 8px;
    background: rgba(244,135,113,.08); border: 1px solid rgba(244,135,113,.3);
    border-radius: 3px; color: var(--err);
}
</style>`;
    }

    private _renderImpactNode(node: IImpactNode, isRoot: boolean): string {
        const badge = node.hasBreakingChanges
            ? '<span class="impact-badge breaking">breaking</span>'
            : node.violations > 0
                ? `<span class="impact-badge affected">${node.violations} violation${node.violations === 1 ? '' : 's'}</span>`
                : '<span class="impact-badge ok">ok</span>';

        const rootClass = isRoot ? (node.hasBreakingChanges ? 'root' : 'root no-breaking') : '';
        const fileClass = isRoot ? 'impact-file' : 'impact-file nav-link';
        const onclick = isRoot ? '' : ` onclick="navigate('${this._jsesc(node.fileUri)}', 1, 1)"`;

        let html = `<div class="impact-node ${rootClass}">
            <span class="${fileClass}"${onclick}>${this._esc(node.fileName)}</span>${badge}`;

        if (node.dependents.length > 0) {
            html += '<div class="impact-arrow">imported by ↓</div>';
            for (const dep of node.dependents) {
                html += this._renderImpactNode(dep, false);
            }
        }

        html += '</div>';
        return html;
    }

    private _getImpactViewHtml(): string {
        const allResults = this.grcEngine.getAllResults();
        const importMap = this.grcEngine.getImportedByMap();

        // Collect unique files with violations
        const filesWithViolations = new Map<string, URI>();
        for (const r of allResults) {
            filesWithViolations.set(r.fileUri.toString(), r.fileUri);
        }

        // Build impact trees for ALL files with violations (not just 5)
        const impactTrees: string[] = [];
        // Isolated = violating files with no dependents (e.g. leaf .c files)
        const isolatedViolators: Array<{ name: string; uri: string; violations: number; breaking: boolean }> = [];

        for (const [uriStr, fileUri] of filesWithViolations) {
            const chain = this.grcEngine.getImpactChain(fileUri, 3);
            if (!chain || chain.dependents.length === 0) {
                // Still show the file — it has violations even if nothing imports it
                const fileResults = allResults.filter(r => r.fileUri.toString() === uriStr);
                isolatedViolators.push({
                    name: fileUri.path.split('/').pop() || fileUri.path,
                    uri: uriStr,
                    violations: fileResults.length,
                    breaking: fileResults.some(r => r.isBreakingChange),
                });
                continue;
            }

            const breakingAlert = chain.hasBreakingChanges
                ? `<div class="impact-alert">Breaking changes in <strong>${this._esc(chain.fileName)}</strong> affect <strong>${chain.dependents.length} dependent file${chain.dependents.length === 1 ? '' : 's'}</strong></div>`
                : '';

            impactTrees.push(`
                ${breakingAlert}
                <div class="impact-tree">
                    ${this._renderImpactNode(chain, true)}
                </div>
            `);
        }

        // Stats — "Tracked Files" = all files in results cache (not just import map keys)
        const allTrackedFiles = new Set<string>();
        for (const r of allResults) allTrackedFiles.add(r.fileUri.toString());
        for (const key of importMap.keys()) allTrackedFiles.add(key);
        const totalTrackedFiles = allTrackedFiles.size;
        const totalViolatedFiles = filesWithViolations.size;
        const filesWithDependents = impactTrees.length;
        const breakingCount = allResults.filter(r => r.isBreakingChange).length;

        const statsHtml = `
<div class="impact-stats">
    <div class="impact-stat"><span class="impact-stat-n">${totalTrackedFiles}</span><span class="impact-stat-l">Tracked Files</span></div>
    <div class="impact-stat"><span class="impact-stat-n">${totalViolatedFiles}</span><span class="impact-stat-l">With Violations</span></div>
    <div class="impact-stat"><span class="impact-stat-n">${filesWithDependents}</span><span class="impact-stat-l">Propagating</span></div>
    <div class="impact-stat"><span class="impact-stat-n" style="color:var(--err)">${breakingCount}</span><span class="impact-stat-l">Breaking</span></div>
</div>`;

        // Render isolated violators as a flat list with violation counts
        let isolatedHtml = '';
        if (isolatedViolators.length > 0) {
            const rows = isolatedViolators.map(f => {
                const badge = f.breaking
                    ? '<span class="impact-badge breaking">breaking</span>'
                    : `<span class="impact-badge affected">${f.violations} violation${f.violations === 1 ? '' : 's'}</span>`;
                return `<div class="isolated-file" onclick="navigate('${this._jsesc(f.uri)}', 1, 1)">
                    <span class="impact-file nav-link">${this._esc(f.name)}</span>${badge}
                </div>`;
            }).join('');
            isolatedHtml = `
<div class="isolated-section">
    <div class="isolated-hdr">Files with violations (no dependents — leaf nodes)</div>
    ${rows}
</div>`;
        }

        let bodyHtml: string;
        if (importMap.size === 0 && filesWithViolations.size === 0) {
            bodyHtml = `<div class="impact-empty">
                <div class="impact-empty-icon">⊷</div>
                <div class="impact-empty-title">No import graph available</div>
                <div class="impact-empty-desc">Run a <strong>Workspace Scan</strong> from the All Checks view to discover cross-file import relationships.</div>
                <button class="impact-scan-btn" onclick="scanWorkspace()">Scan Workspace</button>
            </div>`;
        } else {
            bodyHtml = (impactTrees.length > 0 ? impactTrees.join('') : '') + isolatedHtml;
        }

        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
body { font-family: var(--vscode-font-family, sans-serif); font-size: 12px; color: var(--vscode-foreground); padding: 16px; margin: 0; background: transparent; }
:root { --err: #f48771; --warn: #cca700; --ok: #73c991; --info: #75beff; --border: var(--vscode-panel-border, #333); --fg-muted: var(--vscode-descriptionForeground, #888); }
h2 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
.impact-subtitle { font-size: 11px; color: var(--fg-muted); margin-bottom: 16px; }
.impact-stats { display: flex; gap: 16px; margin-bottom: 20px; padding: 12px; background: var(--vscode-editor-background); border: 1px solid var(--border); border-radius: 6px; }
.impact-stat { display: flex; flex-direction: column; align-items: center; flex: 1; }
.impact-stat-n { font-size: 20px; font-weight: 700; }
.impact-stat-l { font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--fg-muted); margin-top: 2px; }
.impact-tree { margin-bottom: 12px; }
.impact-node { padding: 4px 0 4px 12px; border-left: 2px solid var(--border); margin-left: 4px; }
.impact-node.root { border-left: 2px solid var(--err); padding-left: 12px; }
.impact-node.root.no-breaking { border-left-color: var(--warn); }
.impact-file { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; font-weight: 600; }
.impact-file.nav-link { cursor: pointer; text-decoration: underline; text-decoration-style: dotted; }
.impact-file.nav-link:hover { color: var(--info); }
.impact-badge { font-size: 9px; padding: 1px 5px; border-radius: 2px; margin-left: 6px; vertical-align: middle; }
.impact-badge.breaking { background: rgba(244,135,113,.15); color: var(--err); }
.impact-badge.affected { background: rgba(204,167,0,.15); color: var(--warn); }
.impact-badge.ok { background: rgba(115,201,145,.15); color: var(--ok); }
.impact-arrow { font-size: 9px; color: var(--fg-muted); margin: 2px 0 2px 16px; }
.impact-alert { font-size: 11px; padding: 6px 10px; margin-bottom: 8px; background: rgba(244,135,113,.08); border: 1px solid rgba(244,135,113,.3); border-radius: 3px; color: var(--err); }
.impact-empty { text-align: center; padding: 48px 20px; }
.impact-empty-icon { font-size: 36px; margin-bottom: 12px; opacity: 0.4; }
.impact-empty-title { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.impact-empty-desc { font-size: 11px; color: var(--fg-muted); max-width: 340px; margin: 0 auto 16px; line-height: 1.5; }
.impact-scan-btn { padding: 6px 16px; background: var(--info); color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 11px; }
.impact-scan-btn:hover { filter: brightness(1.1); }
.isolated-section { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px; }
.isolated-hdr { font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--fg-muted); margin-bottom: 8px; }
.isolated-file { display: flex; align-items: center; padding: 3px 0; cursor: pointer; }
.isolated-file:hover .impact-file { color: var(--info); }
</style></head><body>
<h2>Cross-File Impact</h2>
<div class="impact-subtitle">Shows how violations in one file propagate to files that import it</div>
${statsHtml}
${bodyHtml}
<script>
const vscode = acquireVsCodeApi();
// Notify host on any interaction so it holds off re-rendering
(function(){const _iv=()=>vscode.postMessage({type:'webviewInteraction'});document.addEventListener('click',_iv,true);document.addEventListener('input',_iv,true);document.addEventListener('keydown',_iv,true);})();
function navigate(uri, line, col) { vscode.postMessage({ type: 'navigateToFile', uri, line, col }); }
function scanWorkspace() { vscode.postMessage({ type: 'scanWorkspace' }); }
</script>
</body></html>`;
    }

    private getIgnoreHtml(): string {
        const patterns = this.grcEngine.getIgnorePatterns();
        const contextOnlyPatterns = this.grcEngine.getContextOnlyPatterns();

        // Build suggestions section HTML from persistent state
        let suggestionsInnerHtml: string;
        if (this._ignoreSuggestionsLoading) {
            suggestionsInnerHtml = '<div class="sug-loading">Analyzing project structure...</div>';
        } else if (this._ignoreSuggestions.length > 0) {
            suggestionsInnerHtml = '<div class="suggestions">' + this._ignoreSuggestions.map(s =>
                '<div class="suggestion-card">' +
                '<div class="sug-top">' +
                '<span class="sug-pattern">' + this._esc(s.pattern) + '</span>' +
                '<span class="sug-mode ' + this._esc(s.mode) + '">' + this._esc(s.mode) + '</span>' +
                '</div>' +
                '<div class="sug-reason">' + this._esc(s.reason) + ' <span class="confidence">(' + this._esc(s.confidence) + ' confidence)</span></div>' +
                '<div class="sug-actions">' +
                '<button class="sug-accept" onclick="acceptSuggestion(\'' + this._jsesc(s.pattern) + '\',\'' + this._jsesc(s.mode) + '\')">Accept</button>' +
                '<button class="sug-dismiss" onclick="dismissSuggestion(\'' + this._jsesc(s.pattern) + '\')">Dismiss</button>' +
                '</div></div>'
            ).join('') + '</div>';
        } else {
            suggestionsInnerHtml = '<div class="empty-state">Click "Suggest Patterns" to analyze your project structure and get recommendations.</div>';
        }

        const rowsHtml = patterns.length > 0
            ? patterns.map(p => `
                <div class="ignore-row">
                    <span class="ignore-pattern">${this._esc(p)}</span>
                    <button class="btn-remove" onclick="removePattern('${this._jsesc(p)}')" title="Remove">✕</button>
                </div>`).join('')
            : '<div class="empty-state">No patterns configured — all files are scanned.</div>';

        const ctxRowsHtml = contextOnlyPatterns.length > 0
            ? contextOnlyPatterns.map(p => `
                <div class="ignore-row ctx-row">
                    <span class="ignore-pattern">${this._esc(p)}</span>
                    <button class="btn-remove" onclick="removeCtxPattern('${this._jsesc(p)}')" title="Remove">✕</button>
                </div>`).join('')
            : '<div class="empty-state">No context-only patterns — all scanned files generate violations.</div>';

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
    --err: #f48771; --info: #4fc1ff; --ok: #73c991; --warn: #cca700;
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
.add-row { display: flex; gap: 8px; margin-bottom: 8px; }
.add-row input {
    flex: 1; background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-bd); border-radius: 3px;
    padding: 5px 8px; font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
}
.add-row input:focus { outline: 1px solid var(--info); }
.mode-row { display: flex; gap: 16px; margin-bottom: 12px; font-size: 11px; }
.mode-row label { display: flex; align-items: center; gap: 4px; cursor: pointer; color: var(--fg-muted); }
.mode-row input[type=radio] { accent-color: var(--info); }
.btn-add, .btn-suggest {
    font-size: 11px; padding: 5px 12px; border: none; border-radius: 3px;
    cursor: pointer; font-family: inherit;
    background: var(--btn-bg); color: var(--btn-fg);
}
.btn-suggest {
    background: rgba(79,193,255,.15); color: var(--info); margin-left: auto;
}
.btn-add:hover, .btn-suggest:hover { opacity: 0.9; }
.ignore-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 7px 10px; border: 1px solid var(--border); border-radius: 3px;
    margin-bottom: 4px; background: var(--bg-alt);
}
.ctx-row { border-left: 2px solid var(--info); }
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
.suggestions { display: flex; flex-direction: column; gap: 6px; }
.suggestion-card {
    padding: 8px 12px; border: 1px solid var(--border); border-radius: 4px;
    background: var(--bg-alt);
}
.sug-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.sug-pattern { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; font-weight: 600; }
.sug-mode {
    font-size: 9px; padding: 1px 6px; border-radius: 2px; text-transform: uppercase; letter-spacing: .4px;
}
.sug-mode.ignore { background: rgba(244,135,113,.15); color: var(--err); }
.sug-mode.context-only { background: rgba(79,193,255,.15); color: var(--info); }
.sug-reason { font-size: 10px; color: var(--fg-muted); margin-top: 3px; }
.sug-actions { display: flex; gap: 6px; margin-top: 6px; }
.sug-accept {
    font-size: 10px; padding: 2px 8px; border: none; border-radius: 2px;
    cursor: pointer; background: var(--btn-bg); color: var(--btn-fg);
}
.sug-dismiss {
    font-size: 10px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 2px;
    cursor: pointer; background: transparent; color: var(--fg-muted);
}
.sug-loading { font-size: 11px; color: var(--fg-muted); font-style: italic; padding: 8px 0; }
.confidence { font-size: 9px; color: var(--fg-muted); }
</style>
</head>
<body>
<div class="hdr">
    <div class="hdr-title">Ignore Rules</div>
    <div class="hdr-sub">
        <strong>Fully Ignore</strong>: Files excluded from all scanning and AI analysis.<br>
        <strong>Context-Only</strong>: Files excluded from violation scanning but kept as AI context (tests, mocks, configs).
    </div>
</div>

<div class="section">
    <div class="sec-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>AI Suggestions</span>
        <button class="btn-suggest" onclick="suggestPatterns()">Suggest Patterns</button>
    </div>
    <div id="suggestionsContainer">
        ${suggestionsInnerHtml}
    </div>
</div>

<div class="section">
    <div class="sec-title">Add Pattern</div>
    <div class="add-row">
        <input type="text" id="patternInput" placeholder="e.g.  **/node_modules/**  or  src/tests/**  or  *.generated.ts" />
        <button class="btn-add" onclick="addPattern()">Add</button>
    </div>
    <div class="mode-row">
        <label><input type="radio" name="mode" value="ignore" checked /> Fully Ignore</label>
        <label><input type="radio" name="mode" value="context-only" /> Context-Only</label>
    </div>
    <div class="feedback" id="feedback"></div>
</div>

<div class="section">
    <div class="sec-title">Fully Ignored <span style="font-weight:400;text-transform:none;letter-spacing:0">(${patterns.length})</span></div>
    ${rowsHtml}
</div>

<div class="section">
    <div class="sec-title">Context-Only <span style="font-weight:400;text-transform:none;letter-spacing:0">(${contextOnlyPatterns.length})</span></div>
    ${ctxRowsHtml}
</div>

<div class="section">
    <div class="sec-title">Common Examples</div>
    <div class="hint-list">
        <div class="hint"><span>Ignore all node_modules</span><code>**/node_modules/**</code><button class="hint-add" onclick="quickAdd('**/node_modules/**','ignore')">+ Ignore</button></div>
        <div class="hint"><span>Ignore build output</span><code>dist/**</code><button class="hint-add" onclick="quickAdd('dist/**','ignore')">+ Ignore</button></div>
        <div class="hint"><span>Ignore generated files</span><code>**/*.generated.ts</code><button class="hint-add" onclick="quickAdd('**/*.generated.ts','ignore')">+ Ignore</button></div>
        <div class="hint"><span>Test files as context</span><code>**/*.test.ts</code><button class="hint-add" onclick="quickAdd('**/*.test.ts','context-only')">+ Context</button></div>
        <div class="hint"><span>Spec files as context</span><code>**/*.spec.ts</code><button class="hint-add" onclick="quickAdd('**/*.spec.ts','context-only')">+ Context</button></div>
        <div class="hint"><span>Mock files as context</span><code>**/__mocks__/**</code><button class="hint-add" onclick="quickAdd('**/__mocks__/**','context-only')">+ Context</button></div>
        <div class="hint"><span>Config files as context</span><code>**/*.config.*</code><button class="hint-add" onclick="quickAdd('**/*.config.*','context-only')">+ Context</button></div>
    </div>
</div>

<script>
const vscode = acquireVsCodeApi();
// Notify host on any interaction so it holds off re-rendering
(function(){const _iv=()=>vscode.postMessage({type:'webviewInteraction'});document.addEventListener('click',_iv,true);document.addEventListener('input',_iv,true);document.addEventListener('keydown',_iv,true);})();
function getMode() {
    return document.querySelector('input[name="mode"]:checked')?.value || 'ignore';
}
function addPattern() {
    const input = document.getElementById('patternInput');
    const val = input.value.trim();
    if (!val) { showFb('Please enter a pattern.'); return; }
    const mode = getMode();
    if (mode === 'context-only') {
        vscode.postMessage({ type: 'addContextOnlyPattern', pattern: val });
    } else {
        vscode.postMessage({ type: 'addIgnorePattern', pattern: val });
    }
    input.value = '';
    showFb('');
}
function quickAdd(p, mode) {
    if (mode === 'context-only') {
        vscode.postMessage({ type: 'addContextOnlyPattern', pattern: p });
    } else {
        vscode.postMessage({ type: 'addIgnorePattern', pattern: p });
    }
}
function removePattern(p) {
    vscode.postMessage({ type: 'removeIgnorePattern', pattern: p });
}
function removeCtxPattern(p) {
    vscode.postMessage({ type: 'removeContextOnlyPattern', pattern: p });
}
function suggestPatterns() {
    vscode.postMessage({ type: 'generateIgnoreSuggestions' });
}
function acceptSuggestion(pattern, mode) {
    if (mode === 'context-only') {
        vscode.postMessage({ type: 'addContextOnlyPattern', pattern: pattern });
    } else {
        vscode.postMessage({ type: 'addIgnorePattern', pattern: pattern });
    }
    vscode.postMessage({ type: 'dismissIgnoreSuggestion', pattern: pattern });
}
function dismissSuggestion(pattern) {
    vscode.postMessage({ type: 'dismissIgnoreSuggestion', pattern: pattern });
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

    /** Server-side time-ago helper for rendering HTML */
    private _timeAgo(ms: number): string {
        const s = Math.round((Date.now() - ms) / 1000);
        if (s < 5) return 'just now';
        if (s < 60) return `${s}s ago`;
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        return `${Math.floor(s / 3600)}h ago`;
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

        if (this.checksAgentContainer) {
            const agentW = Math.max(0, width - sidebarWidth);
            this.checksAgentContainer.style.width = `${agentW}px`;
            this.checksAgentContainer.style.height = `${contentHeight}px`;
            this.checksAgentTerminalHost?.layout(Math.max(0, width - sidebarWidth), contentHeight);
        }

        if (this._checksContainer) {
            this._checksContainer.style.width = `${Math.max(0, width - sidebarWidth)}px`;
            this._checksContainer.style.height = `${contentHeight}px`;
        }

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

    private _getSimulatorHtml(): string {
        const sessions = this._simulatorSessions;
        const presets = this._simulatorPresets;
        const activeTab = this._simTab;

        const vkColor = (k: string) => {
            if (['stack-overflow','heap-overflow','null-deref','memory-access-fault','double-fault','isr-stack-overflow'].includes(k)) return '#f14c4c';
            if (['watchdog-timeout','timing-violation','resource-leak','deadlock','unaligned-access','divide-by-zero'].includes(k)) return '#e0a84e';
            if (['privilege-violation','data-race','undefined-behaviour'].includes(k)) return '#c586c0';
            return '#9cdcfe';
        };

        const stColor = (s: string) => {
            if (s === 'running' || s === 'building' || s === 'loading') return '#4fc1ff';
            if (s === 'complete') return '#73c991';
            if (s === 'failed') return '#f14c4c';
            if (s === 'cancelled') return '#e0a84e';
            return 'var(--vscode-descriptionForeground)';
        };

        const stIcon = (s: string) => {
            if (s === 'running') return '<span style="animation:spin 1s linear infinite;display:inline-block">⟳</span>';
            if (s === 'building') return '🔨';
            if (s === 'loading') return '📂';
            if (s === 'complete') return '✓';
            if (s === 'failed') return '✗';
            if (s === 'cancelled') return '⊘';
            return '○';
        };

        const KIND_LABELS: Record<string, string> = {
            'qemu':       'QEMU', 'renode': 'Renode', 'gdb-sim': 'GDB-sim',
            'spike':      'Spike', 'proteus': 'Proteus VSM', 'armvirt': 'ARM FVP',
            'matlab':     'MATLAB SIL', 'simulink': 'Simulink', 'gem5': 'gem5',
            'ovpsim':     'OVPsim', 'bochs': 'Bochs', 'virtualbox': 'VirtualBox',
            'custom':     'Custom',
        };
        const kindLabel = (k: string) => KIND_LABELS[k] ?? k;

        const KIND_COLORS: Record<string, string> = {
            'qemu':'#4fc1ff','renode':'#73c991','gdb-sim':'#9cdcfe','spike':'#ce9178',
            'proteus':'#c586c0','armvirt':'#dcdcaa','matlab':'#e0a84e','simulink':'#f14c4c',
            'gem5':'#4ec9b0','ovpsim':'#569cd6','bochs':'#b5cea8','virtualbox':'#d7ba7d',
            'custom':'#858585',
        };
        const kindColor = (k: string) => KIND_COLORS[k] ?? '#858585';

        const kindOptions = [
            ['qemu',       'QEMU (ARM / RISC-V / x86)'],
            ['renode',     'Renode (multi-platform embedded)'],
            ['gdb-sim',    'GDB Simulator (bare-metal)'],
            ['spike',      'Spike (RISC-V ISA)'],
            ['proteus',    'Proteus VSM (ARM / AVR / PIC)'],
            ['armvirt',    'ARM Fast Models / FVP'],
            ['matlab',     'MATLAB SIL / Simulink Coder'],
            ['simulink',   'Simulink MIL / PIL'],
            ['gem5',       'gem5 (full-system / SE mode)'],
            ['ovpsim',     'OVPsim / Imperas (instruction-accurate)'],
            ['bochs',      'Bochs (x86 emulator)'],
            ['virtualbox', 'VirtualBox Headless (OS-level)'],
            ['custom',     'Custom (any CLI simulator)'],
        ].map(([v,l]) => `<option value="${v}">${l}</option>`).join('');

        // ── Stats bar ──────────────────────────────────────────────────────
        const totalSessions = sessions.length;
        const totalViolations = sessions.reduce((sum, s) => sum + s.violations.length, 0);
        const totalInjected = sessions.reduce((sum, s) => sum + (s.injectedCount ?? 0), 0);
        const runningCount = sessions.filter(s => s.status === 'running' || s.status === 'building' || s.status === 'loading').length;
        const failedCount = sessions.filter(s => s.status === 'failed').length;

        // ── Session cards ──────────────────────────────────────────────────
        const sessionCardsHtml = sessions.length === 0
            ? `<div style="text-align:center;padding:60px 20px;opacity:.4;font-size:12px">
                <div style="font-size:32px;margin-bottom:12px">⊳</div>
                No sessions yet — create one from the form above or pick a preset from the Presets tab.
               </div>`
            : sessions.map(s => {
                const isActive = s.status === 'running' || s.status === 'building' || s.status === 'loading';
                const vc = s.violations.length;
                const dur = (s.startedAt && s.completedAt)
                    ? (s.completedAt - s.startedAt > 60000
                        ? `${Math.floor((s.completedAt - s.startedAt) / 60000)}m ${Math.round(((s.completedAt - s.startedAt) % 60000) / 1000)}s`
                        : `${((s.completedAt - s.startedAt) / 1000).toFixed(1)}s`)
                    : isActive ? 'running…' : '—';

                const violRows = s.violations.slice(0, 50).map(v =>
                    `<tr style="border-bottom:1px solid var(--vscode-panel-border)">
                        <td style="padding:4px 8px;white-space:nowrap">
                            <span style="background:${vkColor(v.kind)}22;color:${vkColor(v.kind)};padding:1px 5px;border-radius:3px;font-size:10px">${v.kind}</span>
                        </td>
                        <td style="padding:4px 8px;font-size:11px;font-family:monospace;opacity:.7;white-space:nowrap">${v.file ? this._esc(v.file.split('/').pop()!) + (v.line ? ':' + v.line : '') : '—'}</td>
                        <td style="padding:4px 8px;font-size:11px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this._esc(v.message)}">${this._esc(v.message.slice(0, 100))}</td>
                        <td style="padding:4px 6px;text-align:right">
                            <button data-vkind="${v.kind}" data-vmsg="${this._esc(v.message.slice(0, 200))}" data-vfile="${this._esc(v.file || '')}" data-vline="${v.line || 0}" onclick="askAgentBtn(this)" style="background:transparent;color:#e0a84e;border:1px solid #e0a84e44;padding:1px 6px;border-radius:3px;cursor:pointer;font-size:10px" title="Ask Checks Agent">Ask ⊗</button>
                        </td>
                    </tr>`
                ).join('');

                const recentOutput = s.outputLines.slice(-20).join('\n');

                return `
                <div class="sim-card" data-id="${this._esc(s.config.id)}" style="background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px;margin-bottom:14px;overflow:hidden">

                    <!-- Card header -->
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:var(--vscode-sideBar-background);border-bottom:1px solid var(--vscode-panel-border)">
                        <div style="display:flex;align-items:center;gap:8px;min-width:0">
                            <span style="font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._esc(s.config.name)}</span>
                            <span style="font-size:10px;background:${kindColor(s.config.kind)}22;color:${kindColor(s.config.kind)};padding:1px 6px;border-radius:3px;flex-shrink:0;border:1px solid ${kindColor(s.config.kind)}44">${kindLabel(s.config.kind)}</span>
                            <span class="sim-status" data-id="${this._esc(s.config.id)}" style="font-size:11px;color:${stColor(s.status)};flex-shrink:0">${stIcon(s.status)} ${s.status}</span>
                        </div>
                        <div style="display:flex;gap:6px;flex-shrink:0">
                            ${isActive
                                ? `<button onclick="stopSession('${this._jsesc(s.config.id)}')" style="background:#e0a84e22;color:#e0a84e;border:1px solid #e0a84e55;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px">⏹ Stop</button>`
                                : `<button onclick="runSession('${this._jsesc(s.config.id)}')" style="background:#73c99122;color:#73c991;border:1px solid #73c99155;padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px">▶ Run</button>`
                            }
                            <button onclick="cloneSession('${this._jsesc(s.config.id)}')" style="background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border);padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px" title="Duplicate session">⊕</button>
                            <button onclick="deleteSession('${this._jsesc(s.config.id)}')" style="background:#f14c4c22;color:#f14c4c;border:1px solid #f14c4c55;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px" title="Delete session">✕</button>
                        </div>
                    </div>

                    <!-- Meta row -->
                    <div style="display:flex;gap:20px;padding:8px 14px;font-size:11px;opacity:.6;border-bottom:1px solid var(--vscode-panel-border);font-family:monospace;flex-wrap:wrap">
                        <span title="ELF path">📦 ${this._esc(s.config.elfPath)}</span>
                        <span title="Duration">⏱ ${dur}</span>
                        ${vc > 0 ? `<span style="color:${vkColor('stack-overflow')}">⚠ ${vc} violation${vc > 1 ? 's' : ''}</span>` : '<span style="color:#73c991">✓ No violations</span>'}
                        ${(s.injectedCount ?? 0) > 0 ? `<span title="GRC checks injected">⊘ ${s.injectedCount} GRC result${(s.injectedCount ?? 0) > 1 ? 's' : ''} injected</span>` : ''}
                    </div>

                    <!-- Violations table -->
                    ${vc > 0 ? `
                    <details open>
                        <summary style="padding:8px 14px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;opacity:.5;cursor:pointer;user-select:none;list-style:none">▸ Violations (${vc})</summary>
                        <div style="overflow-x:auto">
                            <table style="width:100%;border-collapse:collapse">
                                <thead><tr style="font-size:10px;opacity:.4;text-transform:uppercase">
                                    <th style="text-align:left;padding:3px 8px">Kind</th>
                                    <th style="text-align:left;padding:3px 8px">Location</th>
                                    <th style="text-align:left;padding:3px 8px">Message</th>
                                    <th style="padding:3px 6px"></th>
                                </tr></thead>
                                <tbody>${violRows}</tbody>
                            </table>
                            ${s.violations.length > 50 ? `<div style="padding:6px 14px;font-size:10px;opacity:.4">…and ${s.violations.length - 50} more violations</div>` : ''}
                        </div>
                    </details>` : ''}

                    <!-- Output log -->
                    ${recentOutput ? `
                    <details>
                        <summary style="padding:8px 14px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;opacity:.5;cursor:pointer;user-select:none;list-style:none">▸ Output (last ${s.outputLines.length > 20 ? '20 of ' + s.outputLines.length : s.outputLines.length} lines)</summary>
                        <pre class="sim-output" data-id="${this._esc(s.config.id)}" style="margin:0;padding:10px 14px;font-family:'Cascadia Code','Menlo',monospace;font-size:11px;background:#0d1117;color:#c9d1d9;border-top:1px solid var(--vscode-panel-border);max-height:240px;overflow-y:auto;white-space:pre-wrap;word-break:break-all">${this._esc(recentOutput)}</pre>
                    </details>` : ''}

                    <!-- Error banner -->
                    ${s.error ? `<div style="padding:8px 14px;color:#f14c4c;font-size:11px;border-top:1px solid #f14c4c44;background:#f14c4c11">⚠ ${this._esc(s.error)}</div>` : ''}
                </div>`;
            }).join('');

        // ── Preset cards ───────────────────────────────────────────────────
        const sectors = [...new Set(presets.map(p => p.sector))];
        const presetSectorTabs = ['All', ...sectors]
            .map(s => `<button class="preset-sector-tab${s === 'All' ? ' active' : ''}" onclick="switchPresetSector(this,'${this._jsesc(s)}')" data-sector="${this._esc(s)}" style="padding:4px 12px;border-radius:20px;border:1px solid var(--vscode-panel-border);background:${s === 'All' ? 'var(--vscode-button-background)' : 'transparent'};color:${s === 'All' ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)'};cursor:pointer;font-size:11px;font-weight:600;white-space:nowrap">${this._esc(s)}</button>`)
            .join('');

        const presetCardsHtml = presets.map(p => {
            const tagBadges = p.tags.slice(0,3).map(t => `<span style="background:${kindColor(p.kind)}22;color:${kindColor(p.kind)};padding:1px 5px;border-radius:3px;font-size:9px;border:1px solid ${kindColor(p.kind)}33">${this._esc(t)}</span>`).join('');
            const searchText = `${p.name} ${p.targetPlatform} ${p.description} ${p.tags.join(' ')} ${p.kind} ${p.sector}`.toLowerCase();
            return `
            <div class="preset-card" data-sector="${this._esc(p.sector)}" data-search-text="${this._esc(searchText)}" style="background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:12px;display:flex;flex-direction:column;gap:6px;transition:border-color .15s" onmouseenter="this.style.borderColor='${kindColor(p.kind)}88'" onmouseleave="this.style.borderColor='var(--vscode-panel-border)'">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
                    <div style="min-width:0">
                        <div style="font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${this._esc(p.name)}</div>
                        <div style="font-size:10px;opacity:.5;margin-top:2px">${this._esc(p.targetPlatform)}</div>
                    </div>
                    <span style="background:${kindColor(p.kind)}22;color:${kindColor(p.kind)};padding:1px 7px;border-radius:3px;font-size:10px;flex-shrink:0;border:1px solid ${kindColor(p.kind)}44">${kindLabel(p.kind)}</span>
                </div>
                <div style="font-size:11px;opacity:.6;line-height:1.4">${this._esc(p.description)}</div>
                <div style="display:flex;flex-wrap:wrap;gap:4px">${tagBadges}</div>
                <div style="font-size:10px;font-family:monospace;opacity:.45;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${this._esc(p.launchCommand)}">${this._esc(p.launchCommand.slice(0, 70))}${p.launchCommand.length > 70 ? '…' : ''}</div>
                <button data-preset-id="${this._esc(p.id)}" onclick="addPreset(this.dataset.presetId)" style="background:${kindColor(p.kind)}22;color:${kindColor(p.kind)};border:1px solid ${kindColor(p.kind)}55;padding:5px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;margin-top:2px;align-self:flex-start">+ Add Session</button>
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
.presets-grid { display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-top:14px; }
.preset-card[data-sector] { transition:opacity .15s; }
.stat-card { background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px 16px;text-align:center; }
@keyframes spin { to { transform:rotate(360deg); } }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
details summary::-webkit-details-marker { display:none; }
details > summary { cursor:pointer;user-select:none; }
</style>
</head>
<body>

<!-- Header -->
<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:16px">
    <div>
        <div style="font-size:16px;font-weight:700;letter-spacing:.3px">Runtime Simulator</div>
        <div style="font-size:11px;opacity:.45;margin-top:2px">QEMU · Renode · GDB-sim · Spike · Proteus · ARM FVP · MATLAB/Simulink · gem5 · OVPsim · Bochs · VirtualBox · Custom</div>
    </div>
    <button onclick="document.getElementById('create-form').style.display=document.getElementById('create-form').style.display==='none'?'block':'none'" style="background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600">+ New Session</button>
</div>

<!-- Stats bar -->
<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:16px">
    <div class="stat-card"><div style="font-size:18px;font-weight:700">${totalSessions}</div><div style="font-size:10px;opacity:.5;margin-top:2px">Sessions</div></div>
    <div class="stat-card"><div style="font-size:18px;font-weight:700;${runningCount > 0 ? 'color:#4fc1ff;animation:pulse 1.2s infinite' : ''}">${runningCount}</div><div style="font-size:10px;opacity:.5;margin-top:2px">Running</div></div>
    <div class="stat-card"><div style="font-size:18px;font-weight:700;${totalViolations > 0 ? 'color:#f14c4c' : 'color:#73c991'}">${totalViolations}</div><div style="font-size:10px;opacity:.5;margin-top:2px">Violations</div></div>
    <div class="stat-card"><div style="font-size:18px;font-weight:700;${totalInjected > 0 ? 'color:#e0a84e' : ''}">${totalInjected}</div><div style="font-size:10px;opacity:.5;margin-top:2px">GRC Injected</div></div>
    <div class="stat-card"><div style="font-size:18px;font-weight:700;${failedCount > 0 ? 'color:#f14c4c' : ''}">${failedCount}</div><div style="font-size:10px;opacity:.5;margin-top:2px">Failed</div></div>
</div>

<!-- Create Form -->
<div id="create-form" style="display:none;background:var(--vscode-sideBar-background);border:1px solid var(--vscode-panel-border);border-radius:6px;padding:16px;margin-bottom:20px">
    <div style="font-size:12px;font-weight:700;margin-bottom:12px;opacity:.8">New Simulator Session</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div><label>Session Name</label><input id="sim-name" type="text" placeholder="e.g. QEMU Cortex-M4 watchdog test" oninput="lock()" onfocus="lock()"></div>
        <div><label>Simulator Kind</label><select id="sim-kind" onchange="lock()">${kindOptions}</select></div>
        <div><label>ELF / Binary Path <span style="font-weight:400;text-transform:none;opacity:.6">(relative to workspace)</span></label><input id="sim-elf" type="text" placeholder="build/firmware.elf" oninput="lock()" onfocus="lock()"></div>
        <div><label>Timeout (ms)</label><input id="sim-timeout" type="number" value="120000" min="5000" max="3600000" oninput="lock()" onfocus="lock()"></div>
    </div>
    <label>Build Command <span style="font-weight:400;text-transform:none;opacity:.6">(optional)</span></label>
    <input id="sim-build" type="text" placeholder="make all  or  cmake --build \${workspace}/build" oninput="lock()" onfocus="lock()">
    <label>Launch Command <span style="font-weight:400;text-transform:none;opacity:.6">(\${workspace}, \${elfAbs} substituted)</span></label>
    <textarea id="sim-launch" rows="2" placeholder="qemu-system-arm -machine lm3s6965evb -nographic -semihosting -kernel \${elfAbs}" oninput="lock()" onfocus="lock()"></textarea>
    <div style="display:flex;gap:8px;margin-top:12px">
        <button onclick="createSession()" style="background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600">Create Session</button>
        <button onclick="document.getElementById('create-form').style.display='none'" style="background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border);padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px">Cancel</button>
    </div>
</div>

<!-- Tab bar -->
<div style="display:flex;gap:0;margin-bottom:0;border-bottom:1px solid var(--vscode-panel-border)">
    <button class="tab-btn${activeTab === 'sessions' ? ' active' : ''}" onclick="switchTab('sessions')">Sessions (${totalSessions})</button>
    <button class="tab-btn${activeTab === 'presets' ? ' active' : ''}" onclick="switchTab('presets')">Presets (${presets.length})</button>
</div>

<!-- Sessions tab -->
<div id="tab-sessions" style="display:${activeTab === 'sessions' ? 'block' : 'none'};padding-top:14px">
    ${sessionCardsHtml}
</div>

<!-- Presets tab -->
<div id="tab-presets" style="display:${activeTab === 'presets' ? 'block' : 'none'}">
    <!-- Search + sector filter -->
    <div style="display:flex;flex-direction:column;gap:8px;padding:12px 0 8px">
        <input id="preset-search" type="text" placeholder="Search presets by name, platform, tag…" oninput="filterPresets()" style="max-width:400px">
        <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${presetSectorTabs}
        </div>
    </div>
    <div id="preset-count" style="font-size:11px;opacity:.45;margin-bottom:8px">${presets.length} presets</div>
    <div class="presets-grid" id="presets-grid">
        ${presetCardsHtml}
    </div>
</div>

<!-- Violation legend -->
<div style="margin-top:24px;padding:12px 16px;background:var(--vscode-sideBar-background);border-radius:6px;border:1px solid var(--vscode-panel-border)">
    <div style="font-size:10px;font-weight:700;text-transform:uppercase;opacity:.4;margin-bottom:8px;letter-spacing:.5px">Violation Kind Reference</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">
        ${['stack-overflow','heap-overflow','null-deref','memory-access-fault','double-fault','isr-stack-overflow',
           'watchdog-timeout','timing-violation','resource-leak','deadlock','unaligned-access','divide-by-zero',
           'privilege-violation','data-race','undefined-behaviour','assertion-failure','custom'].map(k =>
            `<span style="background:${vkColor(k)}22;color:${vkColor(k)};padding:2px 7px;border-radius:3px;font-size:10px">${k}</span>`
        ).join('')}
    </div>
</div>

<script>
    const vscode = acquireVsCodeApi();

    // Interaction lock — prevents engine-event re-renders while user types
    function lock() { vscode.postMessage({ type: 'webviewInteraction' }); }

    // Preset lookup map (ID → preset data) — avoids inline JSON in onclick attrs
    const PRESET_MAP = {${presets.map(p => `'${this._jsesc(p.id)}':${JSON.stringify({id:p.id,name:p.name,kind:p.kind,elfPath:p.elfPath,buildCommand:p.buildCommand||'',launchCommand:p.launchCommand,timeoutMs:p.timeoutMs,tags:p.tags,description:p.description,env:p.env||{}})}`).join(',')}};

    function switchTab(tab) {
        vscode.postMessage({ type: 'switchSimTab', tab });
    }

    function createSession() {
        const name = document.getElementById('sim-name').value.trim();
        const kind = document.getElementById('sim-kind').value;
        const elfPath = document.getElementById('sim-elf').value.trim();
        const launchCommand = document.getElementById('sim-launch').value.trim();
        const buildCommand = document.getElementById('sim-build').value.trim();
        const timeoutMs = parseInt(document.getElementById('sim-timeout').value) || 120000;
        if (!name) { alert('Session name is required'); return; }
        if (!elfPath) { alert('ELF / binary path is required'); return; }
        if (!launchCommand) { alert('Launch command is required'); return; }
        vscode.postMessage({ type: 'createSimSession', config: { name, kind, elfPath, launchCommand, buildCommand: buildCommand || undefined, timeoutMs } });
        document.getElementById('create-form').style.display = 'none';
    }

    function runSession(id) { vscode.postMessage({ type: 'runSimSession', sessionId: id }); }
    function stopSession(id) { vscode.postMessage({ type: 'stopSimSession', sessionId: id }); }
    function cloneSession(id) {
        const newName = prompt('Name for cloned session:');
        if (!newName) return;
        vscode.postMessage({ type: 'cloneSimSession', sessionId: id, newName });
    }
    function deleteSession(id) {
        if (!confirm('Delete this simulator session?')) return;
        vscode.postMessage({ type: 'deleteSimSession', sessionId: id });
    }
    function addPreset(id) {
        const p = PRESET_MAP[id];
        if (p) vscode.postMessage({ type: 'createSessionFromPreset', preset: p });
    }
    function askAgentBtn(btn) {
        vscode.postMessage({ type: 'askAgentAboutSimViolation', kind: btn.dataset.vkind, message: btn.dataset.vmsg, file: btn.dataset.vfile, line: parseInt(btn.dataset.vline) || 0 });
    }

    let _activeSector = 'All';

    function switchPresetSector(btn, sector) {
        _activeSector = sector;
        document.querySelectorAll('.preset-sector-tab').forEach(b => {
            b.style.background = 'transparent';
            b.style.color = 'var(--vscode-foreground)';
            b.classList.remove('active');
        });
        btn.style.background = 'var(--vscode-button-background)';
        btn.style.color = 'var(--vscode-button-foreground)';
        btn.classList.add('active');
        applyPresetFilter();
    }

    function filterPresets() { applyPresetFilter(); }

    function applyPresetFilter() {
        const q = (document.getElementById('preset-search')?.value || '').toLowerCase();
        let visible = 0;
        document.querySelectorAll('.preset-card').forEach(c => {
            const matchSector = _activeSector === 'All' || c.dataset.sector === _activeSector;
            const matchSearch = !q || c.dataset.searchText.includes(q);
            const show = matchSector && matchSearch;
            c.style.display = show ? '' : 'none';
            if (show) visible++;
        });
        const cnt = document.getElementById('preset-count');
        if (cnt) cnt.textContent = visible + ' preset' + (visible !== 1 ? 's' : '');
    }

    // Live session updates (no full re-render — just patch the card)
    window.addEventListener('message', e => {
        const msg = e.data;
        if (msg.type !== 'simSessionUpdate') return;
        const s = msg.session;
        const card = document.querySelector('.sim-card[data-id="' + s.config.id + '"]');
        if (!card) return;

        // Status badge
        const stEl = card.querySelector('.sim-status[data-id="' + s.config.id + '"]');
        if (stEl) {
            const stColors = { running:'#4fc1ff', building:'#4fc1ff', loading:'#4fc1ff', complete:'#73c991', failed:'#f14c4c', cancelled:'#e0a84e' };
            const stIcons = { running:'⟳ ', building:'🔨 ', loading:'📂 ', complete:'✓ ', failed:'✗ ', cancelled:'⊘ ' };
            stEl.textContent = (stIcons[s.status] || '○ ') + s.status;
            stEl.style.color = stColors[s.status] || 'var(--vscode-descriptionForeground)';
        }

        // Output log
        const outEl = card.querySelector('.sim-output[data-id="' + s.config.id + '"]');
        if (outEl && s.outputLines && s.outputLines.length > 0) {
            outEl.textContent = s.outputLines.slice(-20).join('\\n');
            outEl.scrollTop = outEl.scrollHeight;
        }
    });
</script>
</body>
</html>`;
    }

    override toJSON(): object {
        return {
            type: ChecksManagerPart.ID
        };
    }
}

