/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getWindow } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { Part } from '../../../browser/part.js';
import { IWebviewService, IWebviewElement } from '../../webview/browser/webview.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IAgentStoreService } from './agentStoreService.js';
import { IVoidSettingsService } from '../../void/common/voidSettingsService.js';
import { mountSidebar } from '../../void/browser/react/out/sidebar-tsx/index.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkflowAgentService } from './workflowAgentService.js';
import { IPowerBusService } from '../../powerMode/browser/powerBusService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEnterprisePolicyService } from '../../void/common/enterprisePolicyService.js';
import { IModelManagementService } from '../common/modelManagement/index.js';
import { IModelMarketplaceService } from './modelManagement/marketplaceService.js';
import { ICloudCredentialService } from './modelManagement/cloudCredentialService.js';
import { ICloudDeploymentService } from './modelManagement/cloudDeploymentService.js';
import { IDeploymentRegistryService } from './modelManagement/deployment/deploymentRegistryService.js';
import { IUnifiedDeployment, isLocalDeployment, isCloudDeployment, isDeploymentActive, getDeploymentEndpoint } from './modelManagement/deployment/deploymentTypes.js';
import { CloudProvider, CloudDeploymentStatus, ICloudCredentials, ICloudDeployment, getRecommendedInstances } from '../common/modelManagement/cloudTypes.js';
import { IWorkflowComposerService } from './composer/service.js';
import { IBackgroundAgentService } from './backgroundAgentService.js';
import { BackgroundTaskStatus } from '../common/backgroundAgentTypes.js';

export class AgentManagerPart extends Part {

    static readonly ID = 'workbench.parts.agentManager';

    minimumWidth: number = 300;
    maximumWidth: number = Infinity;
    minimumHeight: number = 300;
    maximumHeight: number = Infinity;

    private webviewElement: IWebviewElement | undefined;
    private controlContainer: HTMLElement | undefined;
    private readonly disposables = new DisposableStore();

    constructor(
        @IThemeService themeService: IThemeService,
        @IStorageService storageService: IStorageService,
        @IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
        @IInstantiationService private readonly instantiationService: IInstantiationService,
        @IWebviewService private readonly webviewService: IWebviewService,
        @IConfigurationService private readonly configurationService: IConfigurationService,
        @IAgentStoreService private readonly agentStore: IAgentStoreService,
        @IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
        @IWorkflowAgentService private readonly workflowAgentService: IWorkflowAgentService,
        @IPowerBusService private readonly powerBusService: IPowerBusService,
        @ICommandService private readonly commandService: ICommandService,
        @IEnterprisePolicyService private readonly enterprisePolicyService: IEnterprisePolicyService,
        @IModelManagementService private readonly modelManagementService: IModelManagementService,
        @IModelMarketplaceService private readonly marketplaceService: IModelMarketplaceService,
        @ICloudCredentialService private readonly cloudCredentialService: ICloudCredentialService,
        @ICloudDeploymentService private readonly cloudDeploymentService: ICloudDeploymentService,
        @IDeploymentRegistryService private readonly deploymentRegistryService: IDeploymentRegistryService,
        @IWorkflowComposerService private readonly workflowComposerService: IWorkflowComposerService,
        @IBackgroundAgentService private readonly backgroundAgentService: IBackgroundAgentService,
    ) {
        super(AgentManagerPart.ID, { hasTitle: false }, themeService, storageService, layoutService);
        this.registerListeners();
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

        // VIEW 1: Agent Manager Webview
        const agentContainer = document.createElement('div');
        agentContainer.style.width = '100%';
        agentContainer.style.height = '100%';
        // agentContainer.style.display = 'none'; // Initially hidden or shown
        body.appendChild(agentContainer);

        // VIEW 2: Void Sidebar
        const voidContainer = document.createElement('div');
        voidContainer.style.width = '100%';
        voidContainer.style.height = '100%';
        body.appendChild(voidContainer);

        // VIEW 3: Control Center (native DOM — no webview needed)
        const controlCenterContainer = document.createElement('div');
        controlCenterContainer.style.width = '100%';
        controlCenterContainer.style.height = '100%';
        controlCenterContainer.style.overflow = 'auto';
        controlCenterContainer.style.background = 'var(--vscode-editor-background)';
        body.appendChild(controlCenterContainer);
        this.controlContainer = controlCenterContainer;

        // VIEW 4: Models Management
        const modelsContainer = document.createElement('div');
        modelsContainer.style.width = '100%';
        modelsContainer.style.height = '100%';
        modelsContainer.style.overflow = 'auto';
        modelsContainer.style.background = 'var(--vscode-editor-background)';
        body.appendChild(modelsContainer);

        // VIEW 5: Deployments
        const deploymentsContainer = document.createElement('div');
        deploymentsContainer.style.width = '100%';
        deploymentsContainer.style.height = '100%';
        deploymentsContainer.style.overflow = 'auto';
        deploymentsContainer.style.background = 'var(--vscode-editor-background)';
        body.appendChild(deploymentsContainer);

        // VIEW 6: Workflow Composer
        const workflowsContainer = document.createElement('div');
        workflowsContainer.style.width = '100%';
        workflowsContainer.style.height = '100%';
        workflowsContainer.style.overflow = 'hidden';
        workflowsContainer.style.background = 'var(--vscode-editor-background)';
        body.appendChild(workflowsContainer);

        // VIEW 7: Background Agents (under Agents tab as sub-view)
        const backgroundContainer = document.createElement('div');
        backgroundContainer.style.width = '100%';
        backgroundContainer.style.height = '100%';
        body.appendChild(backgroundContainer);

        // State Management
        const allContainers = [agentContainer, voidContainer, controlCenterContainer, modelsContainer, deploymentsContainer, workflowsContainer, backgroundContainer];
        let allTabs: HTMLElement[] = [];
        let composerMounted = false;
        let bgMounted = false;

        const updateView = (view: 'manager' | 'chat' | 'control' | 'models' | 'deployments' | 'workflows' | 'background') => {
            for (const c of allContainers) { c.style.display = 'none'; }
            for (const t of allTabs) { styleInactive(t); }

            if (view === 'manager') {
                agentContainer.style.display = 'block';
                styleActive(tabAgents);
            } else if (view === 'chat') {
                voidContainer.style.display = 'block';
                styleActive(tabChat);
            } else if (view === 'models') {
                modelsContainer.style.display = 'block';
                styleActive(tabModels);
                this.renderModelsView(modelsContainer).catch(err => {
                    console.error('Failed to render models view:', err);
                    modelsContainer.innerHTML = `<div style="padding:20px;color:red">Error loading models: ${err.message}</div>`;
                });
            } else if (view === 'deployments') {
                deploymentsContainer.style.display = 'block';
                styleActive(tabDeployments);
                this._renderDeploymentsView(deploymentsContainer);
            } else if (view === 'workflows') {
                workflowsContainer.style.display = 'block';
                styleActive(tabWorkflows);
                if (!composerMounted) {
                    composerMounted = true;
                    this.workflowComposerService.mount(workflowsContainer);
                    this.disposables.add(toDisposable(() => this.workflowComposerService.unmount()));
                } else {
                    requestAnimationFrame(() => this.workflowComposerService.refresh());
                }
            } else if (view === 'background') {
                backgroundContainer.style.display = 'flex';
                styleActive(tabBackground);
                if (!bgMounted) {
                    bgMounted = true;
                    this._renderBackgroundAgentsView(backgroundContainer);
                }
            }
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

        const tabChat = createTab('Chat', () => updateView('chat'));
        const tabAgents = createTab('Agents', () => updateView('manager'));
        const tabBackground = createTab('Background', () => updateView('background'));
        const tabWorkflows = createTab('Workflows', () => updateView('workflows'));
        const tabModels = createTab('Models', () => updateView('models'));
        const tabDeployments = createTab('Deployments', () => updateView('deployments'));

        allTabs = [tabChat, tabAgents, tabBackground, tabWorkflows, tabModels, tabDeployments];

        tabsContainer.appendChild(tabChat);
        tabsContainer.appendChild(tabAgents);
        tabsContainer.appendChild(tabBackground);
        tabsContainer.appendChild(tabWorkflows);
        tabsContainer.appendChild(tabModels);
        tabsContainer.appendChild(tabDeployments);

        // Power Mode launcher — placed after tabs, before spacer so it is
        // never hidden by window controls on Windows/Linux
        const powerModeBtn = document.createElement('div');
        powerModeBtn.textContent = '⚡ Power Mode';
        powerModeBtn.title = 'Open Power Mode window (Ctrl+Alt+P)';
        powerModeBtn.style.cssText = [
            'display:flex', 'align-items:center', 'height:100%',
            'padding:0 10px', 'cursor:pointer', 'font-size:11px',
            'color:#5eaed6', 'font-weight:bold', 'letter-spacing:0.03em',
            'border-left:1px solid var(--vscode-panel-border)',
            'white-space:nowrap', 'user-select:none',
        ].join(';');
        powerModeBtn.addEventListener('mouseenter', () => { if (powerModeBtn.style.display !== 'none') powerModeBtn.style.color = '#7dcfff'; });
        powerModeBtn.addEventListener('mouseleave', () => { powerModeBtn.style.color = '#5eaed6'; });
        powerModeBtn.addEventListener('click', () => {
            this.commandService.executeCommand('neuralInverse.openPowerMode');
        });
        header.appendChild(powerModeBtn);

        // Flexible spacer pushes nothing to the right edge
        const spacer = document.createElement('div');
        spacer.style.flex = '1';
        header.appendChild(spacer);

        // Sync visibility with enterprise policy
        const syncPowerModeBtn = () => {
            const blocked = this.enterprisePolicyService.policy?.powerModePolicy?.enabled === false;
            powerModeBtn.style.display = blocked ? 'none' : 'flex';
        };
        syncPowerModeBtn();
        this.disposables.add(this.enterprisePolicyService.onDidChangePolicy(() => syncPowerModeBtn()));

        // Initialize view
        updateView('chat');

        this.webviewElement = this.webviewService.createWebviewElement({
            title: 'Agent Manager',
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

        this.webviewElement.mountTo(agentContainer, getWindow(agentContainer));

        // Mount Void Sidebar
        console.log('AgentManagerPart: mounting sidebar...');

        // HACK: Override createElement to bypass "Not allowed to create elements in child window" error
        const auxDoc = parent.ownerDocument;
        let observer: MutationObserver | undefined;

        let intervalId: any;

        if (auxDoc && auxDoc !== document) {
            console.log('AgentManagerPart: patching auxDoc.createElement');
            (auxDoc as any).createElement = function (tagName: string, options?: any) {
                return document.createElement(tagName, options);
            };

            // HACK: Mirror styles from main window to aux window (including dynamic ones)
            console.log('AgentManagerPart: starting style mirror');
            const mainHead = document.head;
            const auxHead = auxDoc.head;
            const mainBody = document.body;
            const auxBody = auxDoc.body;
            const mainHtml = document.documentElement;
            const auxHtml = auxDoc.documentElement;

            // Mirror attributes/classes (CRITICAL for VS Code themes/layout)
            const copyAttributes = (src: HTMLElement, dest: HTMLElement) => {
                Array.from(src.attributes).forEach(attr => {
                    dest.setAttribute(attr.name, attr.value);
                });
            };
            copyAttributes(mainHtml, auxHtml);
            copyAttributes(mainBody, auxBody);

            // Watch for attribute changes on body/html (theme changes)
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

            // Copy existing styles
            Array.from(mainHead.children).forEach(copyNode);

            // Watch for new styles (e.g. injected by webpack/vite)
            observer = new MutationObserver((mutations) => {
                mutations.forEach((m) => {
                    m.addedNodes.forEach(copyNode);
                });
            });
            observer.observe(mainHead, { childList: true, subtree: false });

            // POLLING FALLBACK: Force re-sync every 1s to catch lazy-loaded styles
            intervalId = setInterval(() => {
                // Re-copy attributes
                copyAttributes(mainHtml, auxHtml);
                copyAttributes(mainBody, auxBody);
                // Re-copy styles
                Array.from(mainHead.children).forEach(copyNode);
            }, 1000);

            // Force base font style if missing
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
                    // attrObserver?.disconnect();
                    clearInterval(intervalId);
                }));
                console.log('AgentManagerPart: sidebar mounted successfully');
            } catch (e) {
                console.error('AgentManagerPart: failed to mount sidebar', e);
            }
        });

        this.updateWebviewContent();
        this.registerWebviewListeners();
        this.registerConfigurationListeners();

        // Initial data load — give webview a moment to initialise
        setTimeout(() => {
            this.updateAgentsList();
            this.updateModelsList();
            this.updateWorkflowsList();
            this.updateRunsList();
        }, 1000);

        return parent;
    }

    private registerListeners(): void {
        this.disposables.add(this.agentStore.onDidChange(() => {
            this.updateAgentsList();
            this._renderControlPanel();
        }));
        this.disposables.add(this.voidSettingsService.onDidChangeState(() => {
            this.updateModelsList();
            this._renderControlPanel();
        }));
        this.disposables.add(this.workflowAgentService.onDidChangeWorkflows(() => {
            this.updateWorkflowsList();
        }));
        this.disposables.add(this.workflowAgentService.onDidChangeRun(() => {
            this.updateRunsList();
            this._renderControlPanel();
        }));
        this.disposables.add(this.powerBusService.onAgentsChanged(() => {
            this._renderControlPanel();
        }));
    }

    // ── Control Center ────────────────────────────────────────────────────────

    private _renderControlPanel(): void {
        const container = this.controlContainer;
        if (!container || container.style.display === 'none') return;

        container.innerHTML = '';
        container.style.fontFamily = 'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif)';
        container.style.fontSize = '13px';
        container.style.color = 'var(--vscode-editor-foreground)';
        container.style.padding = '20px 24px';
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.gap = '24px';

        const models = this.voidSettingsService.state._modelOptions;
        const agents = this.agentStore.getAgents();
        const busAgents = this.powerBusService.getAgents();
        const activeRuns = this.workflowAgentService.getActiveRuns();

        const borderColor = 'var(--vscode-widget-border, rgba(255,255,255,0.1))';
        const bgPanel = 'var(--vscode-editorWidget-background, rgba(255,255,255,0.05))';
        const fgDim = 'var(--vscode-descriptionForeground)';

        const mkSection = (title: string): HTMLElement => {
            const sec = document.createElement('div');
            const h = document.createElement('div');
            h.textContent = title;
            h.style.cssText = `font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:${fgDim};margin-bottom:10px;`;
            sec.appendChild(h);
            return sec;
        };

        // ── Section 1: Agent LLM Settings ───────────────────────────────────
        const agentSec = mkSection('Agents & LLM');

        if (agents.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = 'No agents found in .inverse/agents/';
            empty.style.cssText = `font-size:12px;color:${fgDim};padding:12px;background:${bgPanel};border-radius:6px;border:1px solid ${borderColor};`;
            agentSec.appendChild(empty);
        } else {
            const grid = document.createElement('div');
            grid.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

            for (const agent of agents) {
                const row = document.createElement('div');
                row.style.cssText = `display:flex;align-items:center;gap:10px;padding:8px 12px;background:${bgPanel};border:1px solid ${borderColor};border-radius:6px;`;

                // Colour dot
                const dot = document.createElement('div');
                const hue = Math.abs(agent.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % 360;
                dot.style.cssText = `width:8px;height:8px;border-radius:50%;flex-shrink:0;background:hsl(${hue},60%,55%);`;
                row.appendChild(dot);

                // Name
                const nameEl = document.createElement('div');
                nameEl.textContent = agent.name;
                nameEl.style.cssText = `flex:1;font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
                row.appendChild(nameEl);

                // Builtin badge
                if (agent.isBuiltin) {
                    const badge = document.createElement('span');
                    badge.textContent = 'built-in';
                    badge.style.cssText = `font-size:9px;padding:2px 6px;border-radius:8px;background:rgba(99,102,241,0.2);color:#a78bfa;border:1px solid rgba(99,102,241,0.3);flex-shrink:0;`;
                    row.appendChild(badge);
                }

                // Model selector
                const sel = document.createElement('select');
                sel.style.cssText = `background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid ${borderColor};border-radius:4px;padding:3px 6px;font-size:11px;font-family:inherit;cursor:pointer;max-width:200px;`;
                const currentVal = `${agent.model.providerName}::${agent.model.modelName}`;

                for (const opt of models) {
                    const o = document.createElement('option');
                    const val = `${opt.selection.providerName}::${opt.selection.modelName}`;
                    o.value = val;
                    o.textContent = opt.name;
                    if (val === currentVal) o.selected = true;
                    sel.appendChild(o);
                }
                if (models.length === 0) {
                    const o = document.createElement('option');
                    o.value = currentVal;
                    o.textContent = agent.model.modelName || '(no models configured)';
                    sel.appendChild(o);
                }

                sel.addEventListener('change', () => {
                    const [providerName, modelName] = sel.value.split('::');
                    this.agentStore.updateAgent(agent.id, {
                        model: { providerName: providerName ?? '', modelName: modelName ?? sel.value },
                    }).catch((e: Error) => console.error('[AgentManagerPart] model update failed', e));
                });

                row.appendChild(sel);

                // Iterations label
                const iterEl = document.createElement('div');
                iterEl.textContent = `max ${agent.maxIterations ?? 20} iter`;
                iterEl.style.cssText = `font-size:10px;color:${fgDim};flex-shrink:0;`;
                row.appendChild(iterEl);

                grid.appendChild(row);
            }

            agentSec.appendChild(grid);
        }
        container.appendChild(agentSec);

        // ── Section 2: Network (PowerBus) ────────────────────────────────────
        const netSec = mkSection('Agent Network (PowerBus)');

        if (busAgents.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = 'No agents registered on the bus yet.';
            empty.style.cssText = `font-size:12px;color:${fgDim};padding:12px;background:${bgPanel};border-radius:6px;border:1px solid ${borderColor};`;
            netSec.appendChild(empty);
        } else {
            const busGrid = document.createElement('div');
            busGrid.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';

            for (const ba of busAgents) {
                const pill = document.createElement('div');
                pill.style.cssText = `display:inline-flex;align-items:center;gap:6px;padding:5px 10px;background:${bgPanel};border:1px solid ${borderColor};border-radius:20px;font-size:11px;`;

                const onlineDot = document.createElement('div');
                onlineDot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:#22c55e;flex-shrink:0;';
                pill.appendChild(onlineDot);

                const nameEl = document.createElement('span');
                nameEl.textContent = ba.displayName ?? ba.agentId;
                nameEl.style.fontWeight = '500';
                pill.appendChild(nameEl);

                if (ba.capabilities.length > 0) {
                    const caps = document.createElement('span');
                    caps.textContent = ba.capabilities.join(', ');
                    caps.style.cssText = `color:${fgDim};font-size:10px;`;
                    pill.appendChild(caps);
                }

                busGrid.appendChild(pill);
            }
            netSec.appendChild(busGrid);
        }
        container.appendChild(netSec);

        // ── Section 3: Active Runs ───────────────────────────────────────────
        const runSec = mkSection('Active Runs');

        if (activeRuns.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = 'No workflows running.';
            empty.style.cssText = `font-size:12px;color:${fgDim};padding:12px;background:${bgPanel};border-radius:6px;border:1px solid ${borderColor};`;
            runSec.appendChild(empty);
        } else {
            const runList = document.createElement('div');
            runList.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

            for (const run of activeRuns) {
                const card = document.createElement('div');
                card.style.cssText = `padding:8px 12px;background:${bgPanel};border:1px solid ${borderColor};border-radius:6px;display:flex;align-items:center;gap:12px;`;

                const statusDot = document.createElement('div');
                statusDot.style.cssText = 'width:8px;height:8px;border-radius:50%;flex-shrink:0;background:#3b82f6;animation:pulse 1.5s infinite;';
                card.appendChild(statusDot);

                const info = document.createElement('div');
                info.style.cssText = 'flex:1;';

                const nameEl = document.createElement('div');
                nameEl.textContent = run.workflowName;
                nameEl.style.cssText = 'font-size:13px;font-weight:500;';
                info.appendChild(nameEl);

                const statusEl = document.createElement('div');
                statusEl.textContent = `${run.status} · started ${new Date(run.startedAt).toLocaleTimeString()}`;
                statusEl.style.cssText = `font-size:11px;color:${fgDim};margin-top:2px;`;
                info.appendChild(statusEl);

                card.appendChild(info);

                const cancelBtn = document.createElement('button');
                cancelBtn.textContent = 'Cancel';
                cancelBtn.style.cssText = `background:transparent;border:1px solid ${borderColor};color:${fgDim};border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer;font-family:inherit;`;
                cancelBtn.addEventListener('click', () => {
                    this.workflowAgentService.cancelRun(run.id);
                    this._renderControlPanel();
                });
                card.appendChild(cancelBtn);

                runList.appendChild(card);
            }
            runSec.appendChild(runList);
        }
        container.appendChild(runSec);

        // ── Section 4: Bus Message Log ───────────────────────────────────────
        const logSec = mkSection('Recent Bus Messages');
        const recentMsgs = this.powerBusService.getHistory(15);

        if (recentMsgs.length === 0) {
            const empty = document.createElement('div');
            empty.textContent = 'No messages yet.';
            empty.style.cssText = `font-size:12px;color:${fgDim};padding:12px;background:${bgPanel};border-radius:6px;border:1px solid ${borderColor};`;
            logSec.appendChild(empty);
        } else {
            const logEl = document.createElement('div');
            logEl.style.cssText = `background:${bgPanel};border:1px solid ${borderColor};border-radius:6px;overflow:hidden;`;

            for (const msg of [...recentMsgs].reverse()) {
                const row = document.createElement('div');
                row.style.cssText = `display:flex;align-items:baseline;gap:8px;padding:5px 12px;border-bottom:1px solid ${borderColor};font-size:11px;`;

                const time = document.createElement('span');
                time.textContent = new Date(msg.timestamp).toLocaleTimeString();
                time.style.cssText = `color:${fgDim};flex-shrink:0;font-variant-numeric:tabular-nums;`;
                row.appendChild(time);

                const route = document.createElement('span');
                route.textContent = `${msg.from} → ${msg.to}`;
                route.style.cssText = 'font-weight:500;flex-shrink:0;';
                row.appendChild(route);

                const typePill = document.createElement('span');
                typePill.textContent = msg.type;
                const typeColor = msg.type === 'tool-request' ? '#e0a84e' : msg.type === 'tool-result' ? '#22c55e' : '#3b82f6';
                typePill.style.cssText = `color:${typeColor};flex-shrink:0;`;
                row.appendChild(typePill);

                const content = document.createElement('span');
                content.textContent = msg.content.substring(0, 80) + (msg.content.length > 80 ? '…' : '');
                content.style.cssText = `color:${fgDim};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
                row.appendChild(content);

                logEl.appendChild(row);
            }
            logSec.appendChild(logEl);
        }
        container.appendChild(logSec);
    }

    private updateAgentsList(): void {
        const agents = this.agentStore.getAgents();
        this.webviewElement?.postMessage({ command: 'updateAgents', data: agents });
    }

    private updateModelsList(): void {
        const models = this.voidSettingsService.state._modelOptions.map(opt => ({
            label: opt.name,
            providerName: opt.selection.providerName,
            modelName: opt.selection.modelName,
            value: `${opt.selection.providerName}::${opt.selection.modelName}`,
        }));
        this.webviewElement?.postMessage({ command: 'updateModels', data: models });
    }

    private updateWorkflowsList(): void {
        const workflows = this.workflowAgentService.getWorkflows();
        this.webviewElement?.postMessage({ command: 'updateWorkflows', data: workflows });
    }

    private updateRunsList(): void {
        const active = this.workflowAgentService.getActiveRuns();
        const history = this.workflowAgentService.getRunHistory(20);
        this.webviewElement?.postMessage({ command: 'updateRuns', data: { active, history } });
    }

    private updateWebviewContent(): void {
        if (this.webviewElement) {
            this.webviewElement.setHtml(this.getDashboardHtml());
        }
    }

    private registerWebviewListeners(): void {
        if (!this.webviewElement) { return; }

        this.disposables.add(this.webviewElement.onMessage(e => {
            const { command, data } = e.message;
            if (command === 'sendMessage') {
                this.handleAgentMessage(data);
            } else if (command === 'refreshAgents') {
                this.updateAgentsList();
            } else if (command === 'createAgent') {
                this.handleCreateAgent(data);
            } else if (command === 'runWorkflow') {
                this.workflowAgentService.runWorkflow(data.workflowId, data.input ?? '', 'manual').catch((err: Error) => {
                    console.error('[AgentManagerPart] runWorkflow error:', err);
                });
            } else if (command === 'cancelRun') {
                this.workflowAgentService.cancelRun(data.runId);
            } else if (command === 'refreshWorkflows') {
                this.updateWorkflowsList();
                this.updateRunsList();
            } else if (command === 'refreshModels') {
                this.updateModelsList();
            } else if (command === 'deleteAgent') {
                this.agentStore.deleteAgent(data.id).catch((err: Error) => {
                    this.webviewElement?.postMessage({ command: 'agentCreateError', data: 'Delete failed: ' + err.message });
                });
            } else if (command === 'updateAgent') {
                this.agentStore.updateAgent(data.id, data.updates).then(() => {
                    this.webviewElement?.postMessage({ command: 'agentUpdated', data: data.id });
                }).catch((err: Error) => {
                    this.webviewElement?.postMessage({ command: 'agentUpdateError', data: 'Update failed: ' + err.message });
                });
            } else if (command === 'createWorkflow') {
                this.workflowAgentService.saveWorkflow(data).then(() => {
                    this.webviewElement?.postMessage({ command: 'workflowCreated', data: data.id });
                    this.updateWorkflowsList();
                }).catch((err: Error) => {
                    this.webviewElement?.postMessage({ command: 'workflowCreateError', data: err.message });
                });
            } else if (command === 'deleteWorkflow') {
                this.workflowAgentService.deleteWorkflow(data.id).then(() => {
                    this.updateWorkflowsList();
                }).catch((err: Error) => {
                    console.error('[AgentManagerPart] deleteWorkflow error:', err);
                });
            }
        }));
    }

    private registerConfigurationListeners(): void {
        this.disposables.add(this.configurationService.onDidChangeConfiguration(e => {
            // Forward configuration changes to webview if needed
            // For now, just re-render if something major changes? Or post message.
            this.webviewElement?.postMessage({ command: 'configChanged', data: e });
        }));
    }

    private handleAgentMessage(data: { agentId: string; input: string; intakeAnswers?: { [id: string]: string } }): void {
        const agent = this.agentStore.getAgent(data.agentId);
        if (!agent) {
            this.webviewElement?.postMessage({ command: 'agentResponseError', data: `Agent "${data.agentId}" not found in .inverse/agents/` });
            return;
        }

        // Locally-collected intake answers ride along with the first message so
        // the model never spends a turn asking opening questions itself.
        let prompt = data.input;
        if (data.intakeAnswers && Object.keys(data.intakeAnswers).length > 0) {
            const qa = (agent.intakeQuestions ?? [])
                .map(q => `- ${q.question}\n  Answer: ${data.intakeAnswers![q.id] ?? '(not answered)'}`)
                .join('\n');
            prompt = `${data.input}\n\n<IntakeAnswers>\n${qa}\n</IntakeAnswers>\n(The user already answered the intake questions above in the UI. Use these answers and do NOT ask them again — start working immediately.)`;
        }

        this.webviewElement?.postMessage({ command: 'agentRunStarted' });

        this.workflowAgentService.runAgent(agent.id, prompt)
            .then(run => {
                this.webviewElement?.postMessage({ command: 'agentRunFinished', data: { runId: run.id, status: run.status, output: run.finalOutput, error: run.error } });
            })
            .catch((err: Error) => {
                this.webviewElement?.postMessage({ command: 'agentResponseError', data: err.message });
            });
    }

    private async handleCreateAgent(data: { name: string; model: string; description: string; instructions: string; tools: string[] }): Promise<void> {
        try {
            // model is "providerName::modelName" from the webview dropdown
            const [providerName, modelName] = data.model.split('::');
            const agent = await this.agentStore.createAgent({
                name: data.name,
                description: data.description || undefined,
                model: { providerName: providerName ?? '', modelName: modelName ?? data.model },
                systemInstructions: data.instructions,
                allowedTools: data.tools,
            });
            this.webviewElement?.postMessage({ command: 'agentCreated', data: agent.id });
        } catch (e) {
            this.webviewElement?.postMessage({ command: 'agentCreateError', data: 'Failed to create agent: ' + (e instanceof Error ? e.message : String(e)) });
        }
    }

    private getDashboardHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Neural Inverse</title>
    <style>
        :root {
            --sidebar-w: 256px;
            --radius: 6px;
            --radius-lg: 10px;
            --bg: var(--vscode-editor-background);
            --bg-panel: var(--vscode-editorWidget-background, var(--vscode-editor-inactiveSelectionBackground));
            --bg-sidebar: var(--vscode-sideBar-background);
            --border: var(--vscode-widget-border, rgba(255,255,255,0.1));
            --fg: var(--vscode-editor-foreground);
            --fg-dim: var(--vscode-descriptionForeground);
            --accent: var(--vscode-button-background);
            --accent-hover: var(--vscode-button-hoverBackground);
            --accent-fg: var(--vscode-button-foreground);
            --green: #22c55e;
            --red: #ef4444;
            --blue: #3b82f6;
            --yellow: #eab308;
            --purple: #a78bfa;
        }
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
            font-size: 13px;
            background: var(--bg);
            color: var(--fg);
            display: flex;
            height: 100vh;
            overflow: hidden;
        }
        /* ─── Sidebar ─────────────────────────────────────────────────────── */
        .sidebar {
            width: var(--sidebar-w); min-width: var(--sidebar-w); flex-shrink: 0;
            background: var(--bg-sidebar);
            border-right: 1px solid var(--border);
            display: flex; flex-direction: column; overflow: hidden;
        }
        .sidebar-header {
            padding: 10px 16px 0; display: flex; align-items: center;
            justify-content: space-between; flex-shrink: 0;
        }
        .sidebar-title {
            font-size: 11px; font-weight: 700; text-transform: uppercase;
            letter-spacing: 0.8px; color: var(--vscode-sideBarTitle-foreground);
        }
        .icon-btn {
            background: transparent; border: none; cursor: pointer; color: var(--fg-dim);
            width: 22px; height: 22px; border-radius: 4px; display: flex;
            align-items: center; justify-content: center; flex-shrink: 0;
        }
        .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--fg); }
        .sidebar-search { padding: 8px 12px 6px; flex-shrink: 0; }
        .sidebar-search input {
            width: 100%; background: var(--vscode-input-background); color: var(--fg);
            border: 1px solid var(--border); padding: 5px 10px; border-radius: 4px;
            font-size: 12px; font-family: inherit;
        }
        .sidebar-search input:focus { outline: none; border-color: var(--vscode-focusBorder); }
        .sidebar-search input::placeholder { color: var(--fg-dim); }
        .sidebar-scroll { flex: 1; overflow-y: auto; }
        .sec-label {
            padding: 10px 16px 3px; font-size: 10px; font-weight: 700; text-transform: uppercase;
            letter-spacing: 0.8px; color: var(--fg-dim); display: flex; align-items: center;
            justify-content: space-between;
        }
        .sec-label button {
            background: transparent; border: none; cursor: pointer; color: var(--fg-dim);
            font-size: 10px; padding: 2px 6px; border-radius: 3px; font-family: inherit;
        }
        .sec-label button:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--fg); }
        .agent-item {
            padding: 6px 16px; cursor: pointer; display: flex; align-items: center;
            gap: 9px; font-size: 13px; user-select: none;
        }
        .agent-item:hover { background: var(--vscode-list-hoverBackground); }
        .agent-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
        .a-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .a-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .a-del {
            background: transparent; border: none; cursor: pointer; color: var(--fg-dim);
            opacity: 0; font-size: 14px; padding: 0 3px; border-radius: 3px; flex-shrink: 0;
            line-height: 1;
        }
        .agent-item:hover .a-del { opacity: 0.5; }
        .a-del:hover { opacity: 1 !important; color: var(--red); }
        .wf-sidebar-item {
            padding: 5px 16px; cursor: pointer; display: flex; align-items: center;
            gap: 8px; font-size: 12px; color: var(--fg-dim); user-select: none;
        }
        .wf-sidebar-item:hover { background: var(--vscode-list-hoverBackground); color: var(--fg); }
        .wf-bullet { width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
        .wf-bullet.off { background: var(--fg-dim); }

        /* ─── Workspace ────────────────────────────────────────────────────── */
        .workspace { flex: 1; position: relative; overflow: hidden; background: var(--bg); }
        .view { display: none; flex-direction: column; height: 100%; width: 100%; position: absolute; top: 0; left: 0; }
        .view.active { display: flex; }

        /* ─── Empty State ──────────────────────────────────────────────────── */
        .empty-state {
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            height: 100%; gap: 10px; color: var(--fg-dim); text-align: center; padding: 40px;
        }
        .empty-icon {
            width: 52px; height: 52px; border-radius: 14px; background: var(--bg-panel);
            border: 1px solid var(--border); display: flex; align-items: center; justify-content: center;
            margin-bottom: 6px;
        }
        .empty-state h3 { font-size: 15px; font-weight: 500; color: var(--fg); }
        .empty-state p { font-size: 12px; max-width: 280px; line-height: 1.6; }

        /* ─── Buttons ──────────────────────────────────────────────────────── */
        .btn {
            border: none; border-radius: var(--radius); cursor: pointer; font-size: 13px;
            font-weight: 500; font-family: inherit; padding: 7px 16px;
            display: inline-flex; align-items: center; gap: 6px; transition: background 0.1s;
        }
        .btn-primary { background: var(--accent); color: var(--accent-fg); }
        .btn-primary:hover { background: var(--accent-hover); }
        .btn-ghost {
            background: transparent; color: var(--fg-dim);
            border: 1px solid var(--border);
        }
        .btn-ghost:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--fg); }
        .btn-sm { padding: 4px 12px; font-size: 11px; }
        .btn:disabled { opacity: 0.45; cursor: not-allowed; }

        /* ─── Create Agent Form ────────────────────────────────────────────── */
        .form-scroll { overflow-y: auto; padding: 32px 40px 40px; flex: 1; }
        .form-card { max-width: 580px; width: 100%; margin: 0 auto; }
        .form-title { font-size: 20px; font-weight: 600; color: var(--fg); margin-bottom: 4px; }
        .form-sub { font-size: 12px; color: var(--fg-dim); margin-bottom: 28px; line-height: 1.5; }
        .form-group { margin-bottom: 18px; }
        .form-label {
            display: flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 700;
            text-transform: uppercase; letter-spacing: 0.5px; color: var(--fg-dim); margin-bottom: 6px;
        }
        .req { color: var(--red); }
        .form-ctrl {
            width: 100%; background: var(--vscode-input-background); color: var(--fg);
            border: 1px solid var(--border); padding: 8px 12px; border-radius: var(--radius);
            font-family: inherit; font-size: 13px;
        }
        .form-ctrl:focus { outline: none; border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
        textarea.form-ctrl { resize: vertical; min-height: 110px; line-height: 1.5; }
        .form-hint { font-size: 11px; color: var(--fg-dim); margin-top: 5px; line-height: 1.4; }
        .form-err {
            display: none; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.35);
            color: #f87171; border-radius: var(--radius); padding: 8px 12px; font-size: 12px;
            margin-bottom: 14px;
        }
        .form-err.show { display: block; }
        .form-divider { border: none; border-top: 1px solid var(--border); margin: 24px 0; }
        .form-actions { display: flex; justify-content: flex-end; gap: 10px; }
        .tools-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
        .tool-chip {
            display: flex; align-items: center; gap: 6px; padding: 6px 10px;
            background: var(--bg-panel); border: 1px solid var(--border);
            border-radius: var(--radius); cursor: pointer; font-size: 11px;
            font-weight: 500; user-select: none; transition: border-color 0.1s;
        }
        .tool-chip input[type="checkbox"] { margin: 0; width: auto; cursor: pointer; }
        .tool-chip:has(input:checked) { border-color: var(--vscode-focusBorder); }

        /* ─── Agent Detail ─────────────────────────────────────────────────── */
        .detail-head { padding: 16px 20px 0; border-bottom: 1px solid var(--border); flex-shrink: 0; }
        .detail-top { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
        .agent-avatar {
            width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center;
            justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; color: #fff;
        }
        .detail-name { font-size: 15px; font-weight: 600; flex: 1; }
        .model-pill {
            font-size: 10px; padding: 3px 8px; border-radius: 10px; background: var(--bg-panel);
            border: 1px solid var(--border); color: var(--fg-dim);
        }
        .tab-bar { display: flex; padding: 0 4px; }
        .tab {
            padding: 8px 12px; font-size: 12px; font-weight: 500; color: var(--fg-dim);
            cursor: pointer; border-bottom: 2px solid transparent; user-select: none; white-space: nowrap;
        }
        .tab:hover { color: var(--fg); }
        .tab.active { color: var(--fg); border-bottom-color: var(--accent); }
        .tab-panel { display: none; flex: 1; flex-direction: column; overflow: hidden; }
        .tab-panel.active { display: flex; }
        .chat-msgs {
            flex: 1; overflow-y: auto; padding: 20px; display: flex;
            flex-direction: column; gap: 14px;
        }
        .msg { display: flex; flex-direction: column; max-width: 82%; }
        .msg.user { align-self: flex-end; }
        .msg.agent { align-self: flex-start; }
        .bubble {
            padding: 9px 14px; border-radius: var(--radius-lg); font-size: 13px;
            line-height: 1.5; white-space: pre-wrap; word-break: break-word;
        }
        .msg.user .bubble { background: var(--accent); color: var(--accent-fg); border-bottom-right-radius: 3px; }
        .msg.agent .bubble { background: var(--bg-panel); border: 1px solid var(--border); border-bottom-left-radius: 3px; }
        .chat-bar { padding: 12px 20px; border-top: 1px solid var(--border); display: flex; gap: 8px; flex-shrink: 0; }
        .chat-bar input {
            flex: 1; background: var(--vscode-input-background); color: var(--fg);
            border: 1px solid var(--border); padding: 8px 12px; border-radius: var(--radius);
            font-family: inherit; font-size: 13px;
        }
        .chat-bar input:focus { outline: none; border-color: var(--vscode-focusBorder); }

        /* ─── Settings Tab ─────────────────────────────────────────────────── */
        .settings-form { display: flex; flex-direction: column; gap: 16px; padding: 20px; overflow-y: auto; height: 100%; }
        .settings-form .field-group { display: flex; flex-direction: column; gap: 6px; }
        .settings-form label { font-size: 11px; font-weight: 600; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.5px; }
        .settings-form input, .settings-form textarea, .settings-form select {
            background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
            color: var(--fg); font-size: 12px; padding: 6px 8px; width: 100%; box-sizing: border-box;
        }
        .settings-form textarea { resize: vertical; min-height: 80px; font-family: var(--vscode-editor-font-family, monospace); }
        .settings-form input:focus, .settings-form textarea:focus, .settings-form select:focus {
            outline: none; border-color: var(--vscode-focusBorder);
        }
        .settings-form .tool-grid { display: flex; flex-wrap: wrap; gap: 8px; }
        .settings-form .tool-label { display: flex; align-items: center; gap: 5px; font-size: 11px; cursor: pointer; }
        .settings-footer { display: flex; align-items: center; gap: 10px; padding-top: 4px; border-top: 1px solid var(--border); }
        .settings-msg { font-size: 11px; color: var(--green); }
        .settings-err { font-size: 11px; color: #f87171; }

        /* ─── Tool Groups ──────────────────────────────────────────────────── */
        .tool-group { margin-bottom: 8px; }
        .tool-group-name { font-size: 10px; font-weight: 600; text-transform: uppercase; color: var(--fg-dim); margin-bottom: 4px; letter-spacing: 0.5px; }
        .tool-group-checks { display: flex; flex-wrap: wrap; gap: 6px; }
        .tool-chip { display: flex; align-items: center; gap: 4px; font-size: 11px; cursor: pointer;
            background: var(--bg); border: 1px solid var(--border); border-radius: 3px; padding: 2px 7px; }
        .tool-chip:hover { border-color: var(--accent); }
        .tool-chip input { margin: 0; cursor: pointer; }

        /* ─── Workflow Builder ──────────────────────────────────────────────── */
        .wf-builder { display: flex; flex-direction: column; gap: 14px; padding: 20px; overflow-y: auto; height: 100%; }
        .wf-builder .field-group { display: flex; flex-direction: column; gap: 5px; }
        .wf-builder label { font-size: 11px; font-weight: 600; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.5px; }
        .wf-builder input[type=text], .wf-builder input[type=number], .wf-builder textarea, .wf-builder select {
            background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
            color: var(--fg); font-size: 12px; padding: 6px 8px; width: 100%; box-sizing: border-box;
        }
        .wf-builder textarea { resize: vertical; min-height: 54px; }
        .wf-builder input:focus, .wf-builder textarea:focus, .wf-builder select:focus { outline: none; border-color: var(--vscode-focusBorder); }
        .wf-enabled-row { display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; }
        .wf-enabled-row input { margin: 0; width: auto; }
        .step-section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
        .step-section-head span { font-size: 11px; font-weight: 600; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.5px; }
        .step-card { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 6px; padding: 12px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 10px; }
        .step-card-head { display: flex; align-items: center; justify-content: space-between; }
        .step-card-head .step-num { font-size: 11px; font-weight: 600; color: var(--accent); }
        .step-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .step-tools-wrap { grid-column: 1 / -1; }

        /* ─── Workflows Panel ──────────────────────────────────────────────── */
        .wf-page { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
        .wf-toolbar {
            padding: 14px 24px; border-bottom: 1px solid var(--border);
            display: flex; align-items: center; gap: 12px; flex-shrink: 0;
        }
        .wf-toolbar h2 { font-size: 14px; font-weight: 600; flex: 1; }
        .wf-scroll { flex: 1; overflow-y: auto; padding: 20px 24px; }
        .wf-section { margin-bottom: 28px; }
        .wf-sec-title {
            font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px;
            color: var(--fg-dim); margin-bottom: 10px;
        }
        .wf-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
        .wf-card {
            background: var(--bg-panel); border: 1px solid var(--border);
            border-radius: var(--radius-lg); padding: 16px; transition: border-color 0.15s;
        }
        .wf-card:hover { border-color: var(--vscode-focusBorder); }
        .wf-card-top { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 8px; }
        .wf-icon {
            width: 28px; height: 28px; border-radius: 7px; background: rgba(99,102,241,0.2);
            display: flex; align-items: center; justify-content: center;
            font-size: 14px; flex-shrink: 0; color: var(--purple);
        }
        .wf-card-name { font-size: 13px; font-weight: 600; color: var(--fg); flex: 1; line-height: 1.3; }
        .wf-card-desc { font-size: 11px; color: var(--fg-dim); line-height: 1.4; margin-bottom: 10px; }
        .wf-card-meta { display: flex; gap: 12px; font-size: 10px; color: var(--fg-dim); margin-bottom: 12px; }
        .wf-card-footer { display: flex; justify-content: flex-end; }
        .run-list { display: flex; flex-direction: column; gap: 6px; }
        .run-card { background: var(--bg-panel); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
        .run-card-head {
            padding: 9px 14px; display: flex; align-items: center; gap: 8px;
            cursor: pointer; user-select: none;
        }
        .run-card-head:hover { background: rgba(255,255,255,0.03); }
        .run-card-name { font-size: 12px; font-weight: 500; flex: 1; }
        .run-card-time { font-size: 10px; color: var(--fg-dim); }
        .run-card-body { display: none; padding: 8px 14px 12px; border-top: 1px solid var(--border); }
        .run-card-body.open { display: block; }
        .step-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 11px; color: var(--fg-dim); }
        .step-name { flex: 1; }
        .log-box {
            margin-top: 8px; background: var(--vscode-terminal-background, var(--bg));
            border: 1px solid var(--border); border-radius: 4px; padding: 6px 10px;
            font-family: var(--vscode-editor-font-family, monospace); font-size: 10px;
            max-height: 100px; overflow-y: auto; white-space: pre-wrap; color: var(--fg-dim);
        }
        .cancel-btn {
            background: transparent; border: 1px solid var(--border); color: var(--fg-dim);
            border-radius: 3px; padding: 2px 8px; font-size: 10px; cursor: pointer; font-family: inherit;
        }
        .cancel-btn:hover { border-color: var(--red); color: var(--red); }
        .empty-list { text-align: center; padding: 16px; color: var(--fg-dim); font-size: 12px; }

        /* ─── Status Chips ─────────────────────────────────────────────────── */
        .chip { display: inline-flex; align-items: center; padding: 2px 7px; border-radius: 10px; font-size: 10px; font-weight: 600; flex-shrink: 0; }
        .chip-running   { background: rgba(34,197,94,0.15);   color: #22c55e; }
        .chip-done      { background: rgba(148,163,184,0.12); color: #94a3b8; }
        .chip-failed    { background: rgba(239,68,68,0.15);   color: #f87171; }
        .chip-cancelled { background: rgba(234,179,8,0.15);   color: #eab308; }
        .chip-queued    { background: rgba(59,130,246,0.15);  color: #60a5fa; }
        .chip-planning  { background: rgba(167,139,250,0.15); color: #a78bfa; }
        .chip-skipped   { background: rgba(100,116,139,0.15); color: #94a3b8; }

        /* ─── Scrollbars ───────────────────────────────────────────────────── */
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }
    </style>
</head>
<body>

    <!-- ── Sidebar ────────────────────────────────────────────────────────── -->
    <div class="sidebar">
        <div class="sidebar-header">
            <span class="sidebar-title">Agents / Workflows <span style="font-size:9px;font-weight:500;opacity:0.55;letter-spacing:0;text-transform:none;vertical-align:middle;background:rgba(99,102,241,0.18);color:#a78bfa;border-radius:3px;padding:1px 5px">beta</span></span>
            <button class="icon-btn" id="new-agent-btn" title="New Agent">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/></svg>
            </button>
        </div>
        <div class="sidebar-search">
            <input type="text" id="agent-search" placeholder="Search agents...">
        </div>
        <div class="sidebar-scroll">
            <div id="agent-list"></div>
            <div class="sec-label" style="margin-top:6px">
                <span>Workflows</span>
                <button id="open-workflows-btn">Open</button>
            </div>
            <div style="padding:4px 12px 6px">
                <button class="btn btn-primary btn-sm" id="new-workflow-sidebar-btn" style="width:100%">+ New Workflow</button>
            </div>
            <div id="workflow-list"></div>
        </div>
    </div>

    <!-- ── Workspace ──────────────────────────────────────────────────────── -->
    <div class="workspace">

        <!-- Empty -->
        <div class="view active" id="view-empty">
            <div class="empty-state">
                <div class="empty-icon">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                    </svg>
                </div>
                <h3>No agent selected</h3>
                <p>Pick an agent from the sidebar or create a new one to automate your workflows.</p>
                <button class="btn btn-primary" id="show-create-btn" style="margin-top:6px">+ New Agent</button>
            </div>
        </div>

        <!-- Create Agent -->
        <div class="view" id="view-create">
            <div class="form-scroll">
                <div class="form-card">
                    <h2 class="form-title">New Agent</h2>
                    <p class="form-sub">Configure an autonomous agent that will run as part of a multi-step workflow.</p>

                    <div class="form-group">
                        <label class="form-label">Name <span class="req">*</span></label>
                        <input type="text" class="form-ctrl" id="new-agent-name" placeholder="e.g. code-reviewer, db-migrator">
                        <div class="form-hint">Letters, numbers, hyphens, underscores only — no spaces.</div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Description</label>
                        <input type="text" class="form-ctrl" id="new-agent-description" placeholder="What does this agent do?">
                    </div>
                    <div class="form-group">
                        <label class="form-label">Model <span class="req">*</span></label>
                        <select class="form-ctrl" id="new-agent-model">
                            <option value="" disabled selected>Loading models...</option>
                        </select>
                        <div class="form-hint">Configured in Settings &rsaquo; Void &rsaquo; LLM Providers.</div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">System Instructions <span class="req">*</span></label>
                        <textarea class="form-ctrl" id="new-agent-instructions" rows="5" placeholder="You are a senior engineer. Your role is to review code for correctness, security, and performance..."></textarea>
                        <div class="form-hint">What this agent knows, how it behaves, and what it focuses on.</div>
                    </div>
                    <div class="form-group">
                        <label class="form-label">Allowed Tools</label>
                        <div id="create-tool-grid"></div>
                    </div>

                    <div id="form-err" class="form-err"></div>
                    <hr class="form-divider">
                    <div class="form-actions">
                        <button class="btn btn-ghost" id="cancel-create-btn">Cancel</button>
                        <button class="btn btn-primary" id="create-agent-btn">Create Agent</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- Agent Detail -->
        <div class="view" id="view-agent-detail">
            <div class="detail-head">
                <div class="detail-top">
                    <div class="agent-avatar" id="detail-avatar">A</div>
                    <span class="detail-name" id="detail-name">Agent</span>
                    <span class="model-pill" id="detail-model">model</span>
                </div>
                <div class="tab-bar">
                    <div class="tab active" data-tab="chat" id="tab-nav-chat">Chat</div>
                    <div class="tab" data-tab="settings" id="tab-nav-settings">Settings</div>
                </div>
            </div>
            <div class="tab-panel active" id="tab-content-chat">
                <div class="chat-msgs" id="chat-messages"></div>
                <div class="chat-bar">
                    <input type="text" id="user-input" placeholder="Instruct the agent...">
                    <button class="btn btn-primary btn-sm" id="send-msg-btn">Send</button>
                </div>
            </div>
            <div class="tab-panel" id="tab-content-settings">
                <div class="settings-form">
                    <div class="field-group">
                        <label>Name</label>
                        <input type="text" id="edit-agent-name" placeholder="Agent name">
                    </div>
                    <div class="field-group">
                        <label>Description</label>
                        <input type="text" id="edit-agent-description" placeholder="Short description (optional)">
                    </div>
                    <div class="field-group">
                        <label>Model</label>
                        <select id="edit-agent-model"></select>
                    </div>
                    <div class="field-group">
                        <label>System Instructions</label>
                        <textarea id="edit-agent-instructions" rows="6" placeholder="System prompt for this agent..."></textarea>
                    </div>
                    <div class="field-group">
                        <label>Intake Questions (asked locally in chat — no model call)</label>
                        <textarea id="edit-agent-intake" rows="3" placeholder="One per line. Options in [brackets], * prefix = required.&#10;e.g.  What should I focus on? [bugs|security|all]&#10;* Which branch/release?"></textarea>
                    </div>
                    <div class="field-group">
                        <label>Allowed Tools</label>
                        <div id="edit-tool-grid"></div>
                    </div>
                    <div class="settings-footer">
                        <button class="btn btn-primary btn-sm" id="save-agent-btn">Save Changes</button>
                        <span id="settings-msg" class="settings-msg" style="display:none"></span>
                        <span id="settings-err" class="settings-err" style="display:none"></span>
                    </div>
                </div>
            </div>
        </div>

        <!-- Workflow Builder -->
        <div class="view" id="view-create-workflow">
            <div class="wf-page">
                <div class="wf-toolbar">
                    <h2>New Workflow</h2>
                    <button class="btn btn-ghost btn-sm" id="cancel-wf-btn">Cancel</button>
                </div>
                <div class="wf-builder">
                    <div class="field-group">
                        <label>Name *</label>
                        <input type="text" id="wf-name" placeholder="e.g. code-review (letters, numbers, hyphens)">
                    </div>
                    <div class="field-group">
                        <label>Description</label>
                        <textarea id="wf-description" rows="2" placeholder="What does this workflow do?"></textarea>
                    </div>
                    <div class="field-group">
                        <label>Trigger</label>
                        <select id="wf-trigger">
                            <option value="manual">Manual — run on demand</option>
                            <option value="file-save">On File Save</option>
                            <option value="on-commit">On Git Commit</option>
                            <option value="schedule">Schedule (interval)</option>
                            <option value="terminal-command">Terminal Command (watch exit code)</option>
                        </select>
                    </div>
                    <div class="field-group" id="wf-glob-row" style="display:none">
                        <label>File Glob</label>
                        <input type="text" id="wf-glob" placeholder="src/**/*.ts">
                    </div>
                    <div class="field-group" id="wf-schedule-row" style="display:none">
                        <label>Poll Interval (minutes)</label>
                        <input type="number" id="wf-schedule-minutes" min="1" value="60" style="width:120px">
                    </div>
                    <div id="wf-terminal-cmd-row" style="display:none;flex-direction:column;gap:10px">
                        <div class="field-group">
                            <label>Command to watch</label>
                            <input type="text" id="wf-trigger-command" placeholder="e.g. npm run check, tsc --noEmit, pytest -q">
                            <div style="font-size:11px;color:var(--fg-dim);margin-top:3px">Runs in a background terminal. Workflow fires based on exit code below.</div>
                        </div>
                        <div class="field-group">
                            <label>Fire workflow when</label>
                            <select id="wf-trigger-on-exit">
                                <option value="failure">Command fails (exit ≠ 0) — agent fixes the error</option>
                                <option value="success">Command succeeds (exit = 0) — agent acts on results</option>
                                <option value="any">Any exit — always fire</option>
                            </select>
                        </div>
                        <div class="field-group">
                            <label>Poll every (minutes)</label>
                            <input type="number" id="wf-cmd-interval-minutes" min="1" value="5" style="width:120px">
                        </div>
                    </div>
                    <label class="wf-enabled-row">
                        <input type="checkbox" id="wf-enabled" checked> Enabled
                    </label>
                    <div>
                        <div class="step-section-head">
                            <span>Steps</span>
                            <button class="btn btn-ghost btn-sm" id="add-step-btn">+ Add Step</button>
                        </div>
                        <div id="wf-steps-list"></div>
                        <div id="wf-steps-empty" style="font-size:12px;color:var(--fg-dim);padding:8px 0">Add at least one step to define what agents run.</div>
                    </div>
                    <div class="settings-footer">
                        <button class="btn btn-primary btn-sm" id="create-wf-btn">Create Workflow</button>
                        <span id="wf-create-msg" class="settings-msg" style="display:none"></span>
                        <span id="wf-create-err" class="settings-err" style="display:none"></span>
                    </div>
                </div>
            </div>
        </div>

        <!-- Workflows Panel -->
        <div class="view" id="view-workflows">
            <div class="wf-page">
                <div class="wf-toolbar">
                    <h2>Workflows</h2>
                    <div style="display:flex;gap:8px">
                        <button class="btn btn-primary btn-sm" id="new-workflow-btn">+ New</button>
                        <button class="btn btn-ghost btn-sm" id="refresh-wf-btn">Refresh</button>
                    </div>
                </div>
                <div class="wf-scroll">
                    <div class="wf-section">
                        <div class="wf-sec-title">Active Runs</div>
                        <div class="run-list" id="active-runs-list"><div class="empty-list">No active runs</div></div>
                    </div>
                    <div class="wf-section">
                        <div class="wf-sec-title">Defined Workflows</div>
                        <div class="wf-grid" id="workflow-defs-list">
                            <div class="empty-list" style="grid-column:1/-1">No workflows found. Add JSON files to .inverse/workflows/</div>
                        </div>
                    </div>
                    <div class="wf-section">
                        <div class="wf-sec-title">Recent History</div>
                        <div class="run-list" id="history-runs-list"><div class="empty-list">No completed runs yet</div></div>
                    </div>
                </div>
            </div>
        </div>

    </div><!-- /workspace -->

    <script>
        var vscode = acquireVsCodeApi();
        var currentAgents = [];
        var currentWorkflows = [];
        var activeAgentId = null;
        var activeMessageBubble = null;
        var agentListEl = document.getElementById('agent-list');
        var chatMsgsEl  = document.getElementById('chat-messages');

        // ── Tool Groups ────────────────────────────────────────────────────
        var TOOL_GROUPS = [
            { group: 'Filesystem',     tools: ['readFile','writeFile','listDirectory','searchCode','deleteFile'] },
            { group: 'Terminal',       tools: ['runCommand','runScript'] },
            { group: 'Git',            tools: ['gitStatus','gitDiff','gitLog','gitBranches','gitAdd','gitCommit','gitCreateBranch'] },
            { group: 'HTTP',           tools: ['httpRequest'] },
            { group: 'Communication',  tools: ['notify','playNotificationSound','setStatusBar','showProgress','clipboardWrite','clipboardRead','openUrl'] },
        ];
        function buildToolGridHtml(checkClass, selectedTools) {
            return TOOL_GROUPS.map(function(g) {
                return '<div class="tool-group">' +
                    '<div class="tool-group-name">' + g.group + '</div>' +
                    '<div class="tool-group-checks">' +
                    g.tools.map(function(t) {
                        var chk = selectedTools && selectedTools.indexOf(t) >= 0 ? ' checked' : '';
                        return '<label class="tool-chip"><input type="checkbox" class="' + esc(checkClass) + '" value="' + esc(t) + '"' + chk + '> ' + esc(t) + '</label>';
                    }).join('') +
                    '</div></div>';
            }).join('');
        }
        function initToolGrids() {
            var cg = document.getElementById('create-tool-grid');
            if (cg) cg.innerHTML = buildToolGridHtml('tool-check', ['readFile','writeFile','listDirectory','searchCode']);
            var eg = document.getElementById('edit-tool-grid');
            if (eg) eg.innerHTML = buildToolGridHtml('edit-tool-check', []);
        }
        initToolGrids();

        // ── Utility ────────────────────────────────────────────────────────
        function esc(s) {
            if (!s) return '';
            return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
        }
        function chip(status) {
            return '<span class="chip chip-' + status + '">' + status + '</span>';
        }
        function relTime(ts) {
            if (!ts) return '';
            var d = Math.round((Date.now() - ts) / 1000);
            if (d < 60) return d + 's ago';
            if (d < 3600) return Math.round(d/60) + 'm ago';
            return Math.round(d/3600) + 'h ago';
        }
        function colorHue(str) {
            var h = 0;
            for (var i = 0; i < str.length; i++) h = (h + str.charCodeAt(i)) % 360;
            return h;
        }

        // ── Navigation ─────────────────────────────────────────────────────
        function showView(name) {
            document.querySelectorAll('.view').forEach(function(v) { v.classList.remove('active'); });
            var actual = name === 'chat' ? 'agent-detail' : name;
            var el = document.getElementById('view-' + actual);
            if (el) el.classList.add('active');
            if (actual !== 'agent-detail') { activeAgentId = null; renderAgentList(); }
            else if (name === 'chat') { switchTab('chat'); }
        }
        function switchTab(tab) {
            document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
            document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
            var n = document.getElementById('tab-nav-' + tab);
            var p = document.getElementById('tab-content-' + tab);
            if (n) n.classList.add('active');
            if (p) p.classList.add('active');
        }

        // ── Agent List ─────────────────────────────────────────────────────
        function selectAgent(id) {
            activeAgentId = id;
            var agent = currentAgents.find(function(a) { return a.id === id; });
            if (!agent) return;
            var h = colorHue(agent.id || agent.name);
            var av = document.getElementById('detail-avatar');
            av.textContent = agent.name.charAt(0).toUpperCase();
            av.style.background = 'hsl(' + h + ',55%,42%)';
            document.getElementById('detail-name').textContent = agent.name;
            document.getElementById('detail-model').textContent =
                agent.model ? (agent.model.providerName + ' / ' + agent.model.modelName) : 'no model';
            // Populate settings form
            document.getElementById('edit-agent-name').value = agent.name || '';
            document.getElementById('edit-agent-description').value = agent.description || '';
            document.getElementById('edit-agent-instructions').value = agent.systemInstructions || '';
            document.getElementById('edit-agent-intake').value = (agent.intakeQuestions || []).map(function(q) {
                return (q.required ? '* ' : '') + q.question + (q.options && q.options.length ? ' [' + q.options.join('|') + ']' : '');
            }).join('\\n');
            var editModelSel = document.getElementById('edit-agent-model');
            var agentModelVal = agent.model ? (agent.model.providerName + '::' + agent.model.modelName) : '';
            // Always sync — the initial placeholder has 1 option but no real values
            syncEditModelDropdown();
            editModelSel.value = agentModelVal;
            var eg = document.getElementById('edit-tool-grid');
            if (eg) eg.innerHTML = buildToolGridHtml('edit-tool-check', agent.allowedTools || []);
            hideSettingsMsg();
            chatMsgsEl.innerHTML = '';
            showView('chat');
            renderIntakeCard(agent);
            renderAgentList();
        }
        function syncEditModelDropdown() {
            var src = document.getElementById('new-agent-model');
            var dst = document.getElementById('edit-agent-model');
            dst.innerHTML = src.innerHTML;
        }
        function renderAgentList() {
            var search = (document.getElementById('agent-search').value || '').toLowerCase();
            agentListEl.innerHTML = '';
            var list = currentAgents.filter(function(a) {
                return !search || a.name.toLowerCase().indexOf(search) >= 0;
            });
            if (!list.length) {
                agentListEl.innerHTML = '<div style="padding:10px 16px;font-size:12px;color:var(--fg-dim)">' +
                    (currentAgents.length === 0 ? 'No agents yet. Click + to create one.' : 'No results.') + '</div>';
                return;
            }
            list.forEach(function(agent) {
                var el = document.createElement('div');
                el.className = 'agent-item' + (activeAgentId === agent.id ? ' selected' : '');
                el.dataset.agentId = agent.id;
                var h = colorHue(agent.id || agent.name);
                var badge = agent.isBuiltin ? '<span style="font-size:9px;opacity:0.45;margin-left:3px">built-in</span>' : '';
                el.innerHTML =
                    '<div class="a-dot" style="background:hsl(' + h + ',60%,50%)"></div>' +
                    '<span class="a-name">' + esc(agent.name) + badge + '</span>' +
                    '<button class="a-del" data-action="delete-agent" data-id="' + esc(agent.id) + '" title="Delete">&times;</button>';
                agentListEl.appendChild(el);
            });
        }
        agentListEl.addEventListener('click', function(e) {
            var del = e.target.closest('[data-action="delete-agent"]');
            if (del) { e.stopPropagation(); vscode.postMessage({ command: 'deleteAgent', data: { id: del.dataset.id } }); return; }
            var item = e.target.closest('.agent-item');
            if (item && item.dataset.agentId) selectAgent(item.dataset.agentId);
        });

        // ── Chat ───────────────────────────────────────────────────────────
        function addMsg(text, sender) {
            var wrap = document.createElement('div');
            wrap.className = 'msg ' + sender;
            var b = document.createElement('div');
            b.className = 'bubble';
            b.textContent = text;
            wrap.appendChild(b);
            chatMsgsEl.appendChild(wrap);
            chatMsgsEl.scrollTop = chatMsgsEl.scrollHeight;
            return b;
        }
        function setBusy(busy) {
            var inp = document.getElementById('user-input');
            var btn = document.getElementById('send-msg-btn');
            inp.disabled = busy;
            if (btn) { btn.disabled = busy; btn.textContent = busy ? '...' : 'Send'; }
        }
        // ── Local intake form (no LLM round-trip) ─────────────────────────
        // Rendered when the selected agent defines intakeQuestions. The answers
        // are collected locally and attached to the FIRST message only, so the
        // model starts working instead of spending a turn asking them.
        function renderIntakeCard(agent) {
            if (!agent || !agent.intakeQuestions || !agent.intakeQuestions.length) return;
            var card = document.createElement('div');
            card.className = 'msg agent';
            card.id = 'intake-card';
            var b = document.createElement('div');
            b.className = 'bubble';
            b.style.background = 'rgba(59,130,246,0.07)';
            b.style.borderColor = 'rgba(59,130,246,0.25)';
            var title = document.createElement('div');
            title.textContent = 'Quick setup — answered locally, sent with your first message (no model call needed):';
            title.style.cssText = 'font-size:11px;font-weight:600;margin-bottom:6px;opacity:.85';
            b.appendChild(title);
            agent.intakeQuestions.forEach(function(q) {
                var lbl = document.createElement('label');
                lbl.textContent = q.question + (q.required ? ' *' : '');
                lbl.style.cssText = 'display:block;font-size:11px;margin:8px 0 3px';
                b.appendChild(lbl);
                if (q.options && q.options.length) {
                    var wrap = document.createElement('div');
                    wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px';
                    q.options.forEach(function(opt, i) {
                        var chip = document.createElement('button');
                        chip.type = 'button';
                        chip.textContent = opt;
                        chip.dataset.qid = q.id;
                        chip.dataset.val = opt;
                        chip.style.cssText = 'padding:3px 10px;font-size:11px;border-radius:12px;cursor:pointer;border:1px solid var(--border);background:var(--bg-2);color:inherit';
                        chip.onclick = function() {
                            wrap.querySelectorAll('button').forEach(function(c) { c.style.background = 'var(--bg-2)'; c.style.fontWeight = 'normal'; });
                            chip.style.background = 'rgba(59,130,246,0.25)';
                            chip.style.fontWeight = '600';
                        };
                        if (q.required && i === 0) { /* highlight nothing by default */ }
                        wrap.appendChild(chip);
                    });
                    b.appendChild(wrap);
                } else {
                    var inp = document.createElement('input');
                    inp.type = 'text';
                    inp.placeholder = q.placeholder || '';
                    inp.dataset.intakeId = q.id;
                    inp.style.cssText = 'width:100%;box-sizing:border-box;padding:5px 8px;font-size:12px;background:var(--bg-2);border:1px solid var(--border);border-radius:4px;color:inherit';
                    b.appendChild(inp);
                }
            });
            card.appendChild(b);
            chatMsgsEl.appendChild(card);
        }
        function collectIntake() {
            var card = document.getElementById('intake-card');
            if (!card) return undefined;
            var answers = {};
            card.querySelectorAll('input[data-intake-id]').forEach(function(i) { answers[i.dataset.intakeId] = i.value.trim(); });
            card.querySelectorAll('button[data-qid]').forEach(function(c) {
                if (c.style.background && c.style.background !== 'var(--bg-2)') answers[c.dataset.qid] = c.dataset.val;
            });
            card.remove(); // intake applies to the first message only
            return Object.keys(answers).length ? answers : undefined;
        }
        function sendMessage() {
            var inp = document.getElementById('user-input');
            var text = inp.value.trim();
            if (!activeAgentId || !text) return;
            addMsg(text, 'user');
            vscode.postMessage({ command: 'sendMessage', data: { agentId: activeAgentId, input: text, intakeAnswers: collectIntake() } });
            inp.value = '';
        }

        // ── Model Dropdown ─────────────────────────────────────────────────
        function renderModels(models) {
            var sel = document.getElementById('new-agent-model');
            var prev = sel.value;
            sel.innerHTML = '';
            if (!models || !models.length) {
                var o = document.createElement('option');
                o.value = ''; o.disabled = true; o.selected = true;
                o.textContent = 'No models -- configure a provider in Settings > Void';
                sel.appendChild(o); return;
            }
            var byP = {};
            models.forEach(function(m) { if (!byP[m.providerName]) byP[m.providerName] = []; byP[m.providerName].push(m); });
            Object.entries(byP).forEach(function(e) {
                var grp = document.createElement('optgroup'); grp.label = e[0];
                e[1].forEach(function(m) {
                    var o = document.createElement('option'); o.value = m.value;
                    o.textContent = m.label || m.modelName;
                    if (m.value === prev) o.selected = true;
                    grp.appendChild(o);
                });
                sel.appendChild(grp);
            });
            if (!sel.value && sel.options.length) sel.options[0].selected = true;
        }

        // ── Settings Form ──────────────────────────────────────────────────
        function hideSettingsMsg() {
            var m = document.getElementById('settings-msg');
            var e = document.getElementById('settings-err');
            if (m) { m.style.display = 'none'; m.textContent = ''; }
            if (e) { e.style.display = 'none'; e.textContent = ''; }
        }
        function showSettingsMsg(text) {
            hideSettingsMsg();
            var el = document.getElementById('settings-msg');
            if (el) { el.textContent = text; el.style.display = 'inline'; }
        }
        function showSettingsErr(text) {
            hideSettingsMsg();
            var el = document.getElementById('settings-err');
            if (el) { el.textContent = text; el.style.display = 'inline'; }
        }
        function saveAgentSettings() {
            if (!activeAgentId) return;
            var name  = document.getElementById('edit-agent-name').value.trim();
            var desc  = document.getElementById('edit-agent-description').value.trim();
            var instr = document.getElementById('edit-agent-instructions').value.trim();
            var modelVal = document.getElementById('edit-agent-model').value;
            var tools = Array.from(document.querySelectorAll('.edit-tool-check:checked')).map(function(cb) { return cb.value; });
            if (!name) { showSettingsErr('Name is required.'); return; }
            if (!/^[a-zA-Z0-9_-]+$/.test(name)) { showSettingsErr('Name must contain only letters, numbers, underscores, or hyphens.'); return; }
            if (!instr) { showSettingsErr('System instructions are required.'); return; }
            var modelObj = null;
            if (modelVal) {
                var parts = modelVal.split('::');
                modelObj = { providerName: parts[0], modelName: parts[1] };
            }
            // Intake questions: one per line, "[a|b|c]" = chip options, "* " prefix = required
            var intakeRaw = document.getElementById('edit-agent-intake').value;
            var intakeQuestions = intakeRaw.split('\\n').map(function(l) { return l.trim(); }).filter(Boolean).map(function(l, i) {
                var required = l.charAt(0) === '*';
                if (required) l = l.replace(/^\\*\\s*/, '');
                var m = l.match(/\\s*\\[([^\\]]+)\\]\\s*$/);
                var options = m ? m[1].split('|').map(function(o) { return o.trim(); }).filter(Boolean) : undefined;
                var question = (m ? l.slice(0, m.index) : l).trim();
                return { id: 'q' + (i + 1), question: question, options: options, required: required };
            }).filter(function(q) { return q.question; });
            hideSettingsMsg();
            var btn = document.getElementById('save-agent-btn');
            btn.disabled = true; btn.textContent = 'Saving...';
            vscode.postMessage({ command: 'updateAgent', data: {
                id: activeAgentId,
                updates: { name: name, description: desc, systemInstructions: instr, model: modelObj, allowedTools: tools, intakeQuestions: intakeQuestions.length ? intakeQuestions : [] }
            }});
        }

        // ── Create Form ────────────────────────────────────────────────────
        function showErr(msg) {
            var el = document.getElementById('form-err');
            if (msg) { el.textContent = msg; el.classList.add('show'); }
            else { el.classList.remove('show'); }
        }
        function setCreateBusy(busy) {
            var btn = document.getElementById('create-agent-btn');
            btn.disabled = busy; btn.textContent = busy ? 'Creating...' : 'Create Agent';
        }
        function resetForm() {
            document.getElementById('new-agent-name').value = '';
            document.getElementById('new-agent-description').value = '';
            document.getElementById('new-agent-instructions').value = '';
            // Re-render grid to reset checkboxes to defaults
            var cg = document.getElementById('create-tool-grid');
            if (cg) cg.innerHTML = buildToolGridHtml('tool-check', ['readFile','writeFile','listDirectory','searchCode']);
            showErr(null); setCreateBusy(false);
        }
        function createAgent() {
            var name  = document.getElementById('new-agent-name').value.trim();
            var model = document.getElementById('new-agent-model').value;
            var instr = document.getElementById('new-agent-instructions').value.trim();
            var tools = Array.from(document.querySelectorAll('.tool-check:checked')).map(function(cb) { return cb.value; });
            showErr(null);
            if (!name) { showErr('Name is required.'); return; }
            if (!/^[a-zA-Z0-9_-]+$/.test(name)) { showErr('Name must contain only letters, numbers, underscores, or hyphens.'); return; }
            if (!model) { showErr('Please select a model.'); return; }
            if (!instr) { showErr('System instructions are required.'); return; }
            var desc = document.getElementById('new-agent-description').value.trim();
            setCreateBusy(true);
            vscode.postMessage({ command: 'createAgent', data: { name: name, model: model, description: desc, instructions: instr, tools: tools } });
        }

        // ── Workflows ──────────────────────────────────────────────────────
        function renderWfSidebar() {
            var el = document.getElementById('workflow-list');
            if (!currentWorkflows.length) {
                el.innerHTML = '<div style="padding:8px 16px;font-size:11px;color:var(--fg-dim)">No workflows yet.</div>';
                return;
            }
            el.innerHTML = '';
            currentWorkflows.forEach(function(wf) {
                var item = document.createElement('div');
                item.className = 'wf-sidebar-item';
                item.dataset.action = 'open-workflow'; item.dataset.id = wf.id;
                item.innerHTML =
                    '<div class="wf-bullet' + (wf.enabled ? '' : ' off') + '"></div>' +
                    '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(wf.name) + '</span>' +
                    '<span style="font-size:9px;opacity:0.5">' + ((wf.steps && wf.steps.length) || 0) + ' steps</span>';
                el.appendChild(item);
            });
        }
        function renderWfDefs() {
            var el = document.getElementById('workflow-defs-list');
            if (!currentWorkflows.length) {
                el.innerHTML = '<div class="empty-list" style="grid-column:1/-1">No workflows found. Add JSON files to .inverse/workflows/</div>'; return;
            }
            el.innerHTML = currentWorkflows.map(function(wf) {
                var runBtn = wf.enabled
                    ? '<button class="btn btn-primary btn-sm" data-action="run-workflow" data-id="' + esc(wf.id) + '">Run</button>'
                    : '<span style="font-size:10px;color:var(--fg-dim)">Disabled</span>';
                var triggerLabel = { 'manual': 'Manual', 'file-save': 'On Save', 'on-commit': 'On Commit', 'schedule': 'Scheduled', 'terminal-command': 'Terminal' }[wf.trigger] || wf.trigger;
                return (
                    '<div class="wf-card">' +
                        '<div class="wf-card-top">' +
                            '<div class="wf-icon">&#9881;</div>' +
                            '<span class="wf-card-name">' + esc(wf.name) + '</span>' +
                            '<button class="a-del" style="margin-left:auto" data-action="delete-workflow" data-id="' + esc(wf.id) + '" title="Delete workflow">&times;</button>' +
                        '</div>' +
                        (wf.description ? '<div class="wf-card-desc">' + esc(wf.description) + '</div>' : '') +
                        '<div class="wf-card-meta">' +
                            '<span>' + ((wf.steps && wf.steps.length) || 0) + ' steps</span>' +
                            '<span class="chip chip-' + esc(wf.trigger) + '" style="font-size:9px">' + esc(triggerLabel) + '</span>' +
                        '</div>' +
                        '<div class="wf-card-footer">' + runBtn + '</div>' +
                    '</div>'
                );
            }).join('');
        }
        function renderRunCard(run, isActive) {
            var elapsed = run.endedAt ? (Math.round((run.endedAt - run.startedAt) / 1000) + 's') : 'running...';
            var stepsHtml = (run.steps || []).map(function(s) {
                return '<div class="step-row">' + chip(s.status) + '<span class="step-name">' + esc(s.role || s.stepId) + '</span>' +
                    (s.iterationsUsed ? '<span style="font-size:10px">' + s.iterationsUsed + 'x</span>' : '') + '</div>';
            }).join('');
            var last = (run.steps || []).find(function(s) { return s.outputLog && s.outputLog.length; });
            var logHtml = last ? '<div class="log-box">' + esc(last.outputLog.slice(-5).join('\\n')) + '</div>' : '';
            var cancelBtn = isActive ? '<button class="cancel-btn" data-action="cancel-run" data-id="' + esc(run.id) + '">Cancel</button>' : '';
            var errHtml = run.error ? '<div style="font-size:11px;color:#f87171;margin-top:6px">' + esc(run.error) + '</div>' : '';
            return (
                '<div class="run-card">' +
                    '<div class="run-card-head" data-action="toggle-run-card">' +
                        chip(run.status) +
                        '<span class="run-card-name">' + esc(run.workflowName || run.workflowId) + '</span>' +
                        '<span class="run-card-time">' + relTime(run.startedAt) + '  ' + elapsed + '</span>' +
                        cancelBtn +
                    '</div>' +
                    '<div class="run-card-body">' + stepsHtml + logHtml + errHtml + '</div>' +
                '</div>'
            );
        }
        function renderActiveRuns(runs) {
            var el = document.getElementById('active-runs-list');
            el.className = 'run-list';
            el.innerHTML = runs.length ? runs.map(function(r) { return renderRunCard(r, true); }).join('') : '<div class="empty-list">No active runs</div>';
        }
        function renderHistoryRuns(runs) {
            var el = document.getElementById('history-runs-list');
            el.className = 'run-list';
            el.innerHTML = runs.length ? runs.map(function(r) { return renderRunCard(r, false); }).join('') : '<div class="empty-list">No completed runs yet</div>';
        }

        // ── Workflow Builder ───────────────────────────────────────────────
        var wfStepCount = 0;

        function showWfErr(msg) {
            var e = document.getElementById('wf-create-err');
            var m = document.getElementById('wf-create-msg');
            if (e) { e.textContent = msg || ''; e.style.display = msg ? 'inline' : 'none'; }
            if (m) m.style.display = 'none';
        }
        function showWfMsg(msg) {
            var e = document.getElementById('wf-create-err');
            var m = document.getElementById('wf-create-msg');
            if (m) { m.textContent = msg; m.style.display = 'inline'; }
            if (e) e.style.display = 'none';
        }
        function resetWorkflowForm() {
            document.getElementById('wf-name').value = '';
            document.getElementById('wf-description').value = '';
            document.getElementById('wf-trigger').value = 'manual';
            document.getElementById('wf-glob-row').style.display = 'none';
            document.getElementById('wf-schedule-row').style.display = 'none';
            document.getElementById('wf-terminal-cmd-row').style.display = 'none';
            document.getElementById('wf-trigger-command').value = '';
            document.getElementById('wf-trigger-on-exit').value = 'failure';
            document.getElementById('wf-cmd-interval-minutes').value = '5';
            document.getElementById('wf-enabled').checked = true;
            document.getElementById('wf-steps-list').innerHTML = '';
            document.getElementById('wf-steps-empty').style.display = '';
            wfStepCount = 0;
            showWfErr(null);
            var btn = document.getElementById('create-wf-btn');
            if (btn) { btn.disabled = false; btn.textContent = 'Create Workflow'; }
        }
        function addWorkflowStep() {
            var idx = wfStepCount++;
            var list = document.getElementById('wf-steps-list');
            var empty = document.getElementById('wf-steps-empty');
            if (empty) empty.style.display = 'none';
            var agentOptions = currentAgents.length
                ? currentAgents.map(function(a) { return '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>'; }).join('')
                : '<option value="">— No agents defined —</option>';
            var card = document.createElement('div');
            card.className = 'step-card';
            card.dataset.stepIdx = String(idx);
            card.innerHTML =
                '<div class="step-card-head">' +
                    '<span class="step-num">Step ' + (idx + 1) + '</span>' +
                    '<button class="btn btn-ghost btn-sm" data-action="remove-step" data-idx="' + idx + '">Remove</button>' +
                '</div>' +
                '<div class="step-fields">' +
                    '<div class="field-group">' +
                        '<label>Agent</label>' +
                        '<select class="step-agent-sel">' + agentOptions + '</select>' +
                    '</div>' +
                    '<div class="field-group">' +
                        '<label>Role</label>' +
                        '<select class="step-role-sel">' +
                            '<option value="executor">executor</option>' +
                            '<option value="planner">planner</option>' +
                            '<option value="validator">validator</option>' +
                            '<option value="reviewer">reviewer</option>' +
                        '</select>' +
                    '</div>' +
                    '<div class="field-group">' +
                        '<label>Max Iterations</label>' +
                        '<input type="number" class="step-max-iter" value="20" min="1" max="100">' +
                    '</div>' +
                    '<div class="field-group step-tools-wrap">' +
                        '<label>Allowed Tools</label>' +
                        '<div class="step-tool-grid-' + idx + '">' + buildToolGridHtml('step-tool-check-' + idx, ['readFile','writeFile','listDirectory','searchCode']) + '</div>' +
                    '</div>' +
                '</div>';
            list.appendChild(card);
        }
        function submitCreateWorkflow() {
            var name    = document.getElementById('wf-name').value.trim();
            var desc    = document.getElementById('wf-description').value.trim();
            var trigger = document.getElementById('wf-trigger').value;
            var glob    = document.getElementById('wf-glob').value.trim() || undefined;
            var schedMins = parseInt(document.getElementById('wf-schedule-minutes').value, 10) || 60;
            var trigCmd = document.getElementById('wf-trigger-command').value.trim() || undefined;
            var trigOnExit = document.getElementById('wf-trigger-on-exit').value;
            var cmdIntervalMins = parseInt(document.getElementById('wf-cmd-interval-minutes').value, 10) || 5;
            var enabled = document.getElementById('wf-enabled').checked;

            showWfErr(null);
            if (!name) { showWfErr('Name is required.'); return; }
            if (!/^[a-zA-Z0-9_-]+$/.test(name)) { showWfErr('Name must use only letters, numbers, hyphens, or underscores.'); return; }
            if (trigger === 'terminal-command' && !trigCmd) { showWfErr('Enter the command to watch (e.g. npm run check).'); return; }

            var stepCards = document.querySelectorAll('#wf-steps-list .step-card');
            if (!stepCards.length) { showWfErr('Add at least one step.'); return; }
            var steps = [];
            var valid = true;
            stepCards.forEach(function(card) {
                var idx     = card.dataset.stepIdx;
                var agentId = card.querySelector('.step-agent-sel').value;
                var role    = card.querySelector('.step-role-sel').value;
                var maxIter = parseInt(card.querySelector('.step-max-iter').value, 10) || 20;
                var tools   = Array.from(card.querySelectorAll('.step-tool-check-' + idx + ':checked')).map(function(cb) { return cb.value; });
                if (!agentId) { showWfErr('Each step must have an agent selected.'); valid = false; return; }
                steps.push({ id: 'step-' + (steps.length + 1), agentId: agentId, role: role, allowedTools: tools, maxIterations: maxIter });
            });
            if (!valid) return;

            var def = { id: name, name: name, description: desc, trigger: trigger, enabled: enabled, steps: steps };
            if (trigger === 'file-save' && glob) def.triggerGlob = glob;
            if (trigger === 'schedule') def.scheduleIntervalMinutes = schedMins;
            if (trigger === 'terminal-command') {
                def.triggerCommand = trigCmd;
                def.triggerOnExit = trigOnExit;
                def.scheduleIntervalMinutes = cmdIntervalMins;
            }

            var btn = document.getElementById('create-wf-btn');
            btn.disabled = true; btn.textContent = 'Creating...';
            vscode.postMessage({ command: 'createWorkflow', data: def });
        }

        // ── Extension Messages ─────────────────────────────────────────────
        window.addEventListener('message', function(event) {
            var msg = event.data;
            switch (msg.command) {
                case 'updateAgents':
                    currentAgents = msg.data || [];
                    renderAgentList();
                    if (activeAgentId && !currentAgents.find(function(a) { return a.id === activeAgentId; })) showView('empty');
                    break;
                case 'updateModels':
                    renderModels(msg.data || []);
                    syncEditModelDropdown();
                    break;
                case 'updateWorkflows':
                    currentWorkflows = msg.data || [];
                    renderWfSidebar(); renderWfDefs(); break;
                case 'updateRuns':
                    renderActiveRuns((msg.data && msg.data.active) || []);
                    renderHistoryRuns((msg.data && msg.data.history) || []);
                    break;
                case 'agentRunStarted':
                    activeMessageBubble = addMsg('Running...', 'agent'); setBusy(true); break;
                case 'agentRunFinished':
                    if (activeMessageBubble) {
                        var d = msg.data;
                        if (d.status === 'done' && d.output) { activeMessageBubble.textContent = d.output; }
                        else if (d.error) { activeMessageBubble.textContent = 'Error: ' + d.error; activeMessageBubble.style.color = '#f87171'; }
                        else if (d.status === 'done') { activeMessageBubble.textContent = '(done with no output — the model returned an empty response)'; activeMessageBubble.style.color = '#f87171'; }
                        else { activeMessageBubble.textContent = '(' + d.status + ')'; }
                        chatMsgsEl.scrollTop = chatMsgsEl.scrollHeight;
                        activeMessageBubble = null;
                    }
                    setBusy(false); break;
                case 'agentResponseError':
                    if (activeMessageBubble) {
                        activeMessageBubble.textContent = 'Error: ' + msg.data;
                        activeMessageBubble.style.color = '#f87171'; activeMessageBubble = null;
                    } else { addMsg('Error: ' + msg.data, 'agent'); }
                    setBusy(false); break;
                case 'agentCreated':
                    resetForm();
                    setTimeout(function() { selectAgent(msg.data); }, 300); break;
                case 'agentCreateError':
                    showErr(msg.data); setCreateBusy(false); break;
                case 'workflowCreated':
                    showWfMsg('Workflow created.');
                    setTimeout(function() { resetWorkflowForm(); showView('workflows'); }, 800);
                    break;
                case 'workflowCreateError':
                    showWfErr(msg.data);
                    var btn4 = document.getElementById('create-wf-btn');
                    if (btn4) { btn4.disabled = false; btn4.textContent = 'Create Workflow'; }
                    break;
                case 'agentUpdated':
                    showSettingsMsg('Saved.');
                    var btn2 = document.getElementById('save-agent-btn');
                    if (btn2) { btn2.disabled = false; btn2.textContent = 'Save Changes'; }
                    // Refresh detail header with new name/model
                    if (activeAgentId) {
                        var upd = currentAgents.find(function(a) { return a.id === activeAgentId; });
                        if (upd) {
                            document.getElementById('detail-name').textContent = upd.name;
                            document.getElementById('detail-model').textContent =
                                upd.model ? (upd.model.providerName + ' / ' + upd.model.modelName) : 'no model';
                        }
                    }
                    break;
                case 'agentUpdateError':
                    showSettingsErr(msg.data);
                    var btn3 = document.getElementById('save-agent-btn');
                    if (btn3) { btn3.disabled = false; btn3.textContent = 'Save Changes'; }
                    break;
            }
        });

        // ── Event Wiring ───────────────────────────────────────────────────
        document.getElementById('new-agent-btn').addEventListener('click', function() { showView('create'); });
        document.getElementById('show-create-btn').addEventListener('click', function() { showView('create'); });
        document.getElementById('open-workflows-btn').addEventListener('click', function() { showView('workflows'); });
        document.getElementById('new-workflow-sidebar-btn').addEventListener('click', function() { resetWorkflowForm(); showView('create-workflow'); });
        document.getElementById('cancel-create-btn').addEventListener('click', function() { resetForm(); showView('empty'); });
        document.getElementById('create-agent-btn').addEventListener('click', createAgent);
        document.getElementById('save-agent-btn').addEventListener('click', saveAgentSettings);
        document.getElementById('send-msg-btn').addEventListener('click', sendMessage);
        document.getElementById('user-input').addEventListener('keydown', function(e) { if (e.key === 'Enter') sendMessage(); });
        document.getElementById('refresh-wf-btn').addEventListener('click', function() { vscode.postMessage({ command: 'refreshWorkflows' }); });
        document.getElementById('new-workflow-btn').addEventListener('click', function() { resetWorkflowForm(); showView('create-workflow'); });
        document.getElementById('cancel-wf-btn').addEventListener('click', function() { resetWorkflowForm(); showView('workflows'); });
        document.getElementById('add-step-btn').addEventListener('click', addWorkflowStep);
        document.getElementById('create-wf-btn').addEventListener('click', submitCreateWorkflow);
        document.getElementById('wf-trigger').addEventListener('change', function() {
            var v = this.value;
            document.getElementById('wf-glob-row').style.display = v === 'file-save' ? '' : 'none';
            document.getElementById('wf-schedule-row').style.display = v === 'schedule' ? '' : 'none';
            document.getElementById('wf-terminal-cmd-row').style.display = v === 'terminal-command' ? 'flex' : 'none';
        });
        document.getElementById('agent-search').addEventListener('input', renderAgentList);
        document.querySelectorAll('.tab').forEach(function(tab) {
            tab.addEventListener('click', function() { switchTab(tab.dataset.tab); });
        });
        document.addEventListener('click', function(e) {
            var t = e.target.closest('[data-action]');
            if (!t) return;
            var a = t.dataset.action;
            if (a === 'nav') { showView(t.dataset.view); }
            else if (a === 'open-workflow') { showView('workflows'); }
            else if (a === 'run-workflow') { vscode.postMessage({ command: 'runWorkflow', data: { workflowId: t.dataset.id, input: '' } }); }
            else if (a === 'cancel-run')   { vscode.postMessage({ command: 'cancelRun',   data: { runId: t.dataset.id } }); }
            else if (a === 'toggle-run-card') {
                var body = t.closest('.run-card').querySelector('.run-card-body');
                if (body) body.classList.toggle('open');
            }
            else if (a === 'delete-workflow') {
                vscode.postMessage({ command: 'deleteWorkflow', data: { id: t.dataset.id } });
            }
            else if (a === 'remove-step') {
                var card = t.closest('.step-card');
                if (card) {
                    card.remove();
                    var remaining = document.querySelectorAll('#wf-steps-list .step-card');
                    if (!remaining.length) document.getElementById('wf-steps-empty').style.display = '';
                    // Re-number visible steps
                    remaining.forEach(function(c, i) { var s = c.querySelector('.step-num'); if (s) s.textContent = 'Step ' + (i + 1); });
                }
            }
        });

        // ── Bootstrap ──────────────────────────────────────────────────────
        vscode.postMessage({ command: 'refreshAgents' });
        vscode.postMessage({ command: 'refreshModels' });
        vscode.postMessage({ command: 'refreshWorkflows' });
    </script>
</body>
</html>`;
    }

    override layout(width: number, height: number, top: number, left: number): void {
        super.layout(width, height, top, left);
        if (this.webviewElement) {
            // Webview layout logic if part doesn't handle it automatically via CSS
        }
    }

    toJSON(): object {
        return {
            type: AgentManagerPart.ID
        };
    }

    private _modelsViewMode: 'simple' | 'advanced' = 'simple';

    private async renderModelsView(container: HTMLElement): Promise<void> {
        while (container.firstChild) container.removeChild(container.firstChild);
        container.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;padding:0;margin:0';

        if (this._modelsViewMode === 'simple') {
            this._renderSimpleModelsView(container);
        } else {
            // Advanced: full marketplace
            const marketplaceWrap = document.createElement('div');
            marketplaceWrap.style.cssText = 'display:flex;flex:1;overflow:hidden';

            // Top bar with back link and context
            const topBar = document.createElement('div');
            topBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 20px;border-bottom:1px solid var(--vscode-panel-border);flex-shrink:0;background:var(--vscode-sideBar-background)';

            const backLink = document.createElement('span');
            backLink.textContent = '← Quick Install';
            backLink.style.cssText = 'font-size:11px;color:var(--vscode-textLink-foreground);cursor:pointer;font-weight:500';
            backLink.addEventListener('click', () => {
                this._modelsViewMode = 'simple';
                this.renderModelsView(container);
            });
            topBar.appendChild(backLink);

            const modeLabel = document.createElement('span');
            modeLabel.textContent = 'MARKETPLACE';
            modeLabel.style.cssText = 'font-size:9px;font-weight:700;letter-spacing:1px;color:var(--vscode-descriptionForeground);padding:2px 8px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:3px';
            topBar.appendChild(modeLabel);

            container.appendChild(topBar);
            container.appendChild(marketplaceWrap);

            try {
                await this.renderModelsMarketplace(marketplaceWrap);
            } catch (error) {
                console.error('Error rendering models view:', error);
                const errorDiv = document.createElement('div');
                errorDiv.style.cssText = 'padding:40px;text-align:center;color:var(--vscode-errorForeground)';
                errorDiv.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
                marketplaceWrap.appendChild(errorDiv);
            }
        }
    }

    private _renderSimpleModelsView(container: HTMLElement): void {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'flex:1;overflow-y:auto;padding:0';

        // Hero section
        const hero = document.createElement('div');
        hero.style.cssText = 'padding:36px 40px 28px;background:linear-gradient(135deg, color-mix(in srgb, var(--vscode-editor-background) 85%, var(--vscode-focusBorder)), var(--vscode-editor-background))';

        const heroInner = document.createElement('div');
        heroInner.style.cssText = 'max-width:720px';

        const title = document.createElement('h1');
        title.textContent = 'Models';
        title.style.cssText = 'margin:0;font-size:22px;font-weight:700;color:var(--vscode-foreground);letter-spacing:-0.3px';
        heroInner.appendChild(title);

        const sub = document.createElement('p');
        sub.textContent = 'Install AI models locally with one click. Powered by Ollama — runs entirely on your machine, no API keys needed.';
        sub.style.cssText = 'margin:8px 0 0;font-size:13px;color:var(--vscode-descriptionForeground);line-height:1.5';
        heroInner.appendChild(sub);

        // Status pill inline in hero
        const statusPill = document.createElement('div');
        statusPill.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-top:14px;padding:5px 12px;background:var(--vscode-editor-background);border-radius:20px;border:1px solid var(--vscode-input-border)';
        heroInner.appendChild(statusPill);
        hero.appendChild(heroInner);
        wrapper.appendChild(hero);

        this._checkOllamaStatus(statusPill);

        // Main content
        const content = document.createElement('div');
        content.style.cssText = 'padding:24px 40px 40px';

        // Curated models
        interface ICuratedModel {
            id: string;
            name: string;
            org: string;
            description: string;
            size: string;
            params: string;
            tags: string[];
            recommended?: boolean;
            category: 'coding' | 'general' | 'small';
        }

        const curatedModels: ICuratedModel[] = [
            { id: 'qwen2.5-coder:7b', name: 'Qwen 2.5 Coder', org: 'Alibaba', description: 'Best coding model for its size. Excellent at generation, completion, and refactoring.', size: '4.7 GB', params: '7B', tags: ['coding', 'fast'], category: 'coding', recommended: true },
            { id: 'deepseek-coder-v2:16b', name: 'DeepSeek Coder V2', org: 'DeepSeek', description: 'Strong MoE coding model. Top-tier accuracy on HumanEval and code benchmarks.', size: '8.9 GB', params: '16B', tags: ['coding', 'accurate'], category: 'coding' },
            { id: 'starcoder2:7b', name: 'StarCoder2', org: 'BigCode', description: 'Trained on 600+ languages. Excellent FIM (fill-in-middle) for autocomplete.', size: '3.8 GB', params: '7B', tags: ['autocomplete', 'multi-lang'], category: 'coding' },
            { id: 'codellama:7b', name: 'Code Llama', org: 'Meta', description: 'Dedicated code model with infilling support. Strong at code generation.', size: '3.8 GB', params: '7B', tags: ['coding', 'infill'], category: 'coding' },
            { id: 'llama3.1:8b', name: 'Llama 3.1', org: 'Meta', description: 'Best general-purpose open model. Great for chat, reasoning, analysis, and code.', size: '4.7 GB', params: '8B', tags: ['general', 'reasoning'], category: 'general' },
            { id: 'mistral:7b', name: 'Mistral', org: 'Mistral AI', description: 'Fast and efficient. Excellent speed-to-quality ratio for general tasks.', size: '4.1 GB', params: '7B', tags: ['general', 'fast'], category: 'general' },
            { id: 'llama3.1:70b', name: 'Llama 3.1 70B', org: 'Meta', description: 'Highest quality open model. Near GPT-4 performance. Requires 40+ GB RAM.', size: '40 GB', params: '70B', tags: ['powerful', 'large'], category: 'general' },
            { id: 'phi3:mini', name: 'Phi-3 Mini', org: 'Microsoft', description: 'Ultra-compact model. Runs on 4 GB RAM. Ideal for low-end hardware.', size: '2.3 GB', params: '3.8B', tags: ['tiny', 'efficient'], category: 'small' },
        ];

        // Section: For Coding
        const codingModels = curatedModels.filter(m => m.category === 'coding');
        const generalModels = curatedModels.filter(m => m.category === 'general');
        const smallModels = curatedModels.filter(m => m.category === 'small');

        content.appendChild(this._createModelSection('For Coding', 'Optimized for code generation, completion, and understanding', codingModels, container));
        content.appendChild(this._createModelSection('General Purpose', 'Chat, reasoning, writing, and multi-task', generalModels, container));
        content.appendChild(this._createModelSection('Lightweight', 'Runs on minimal hardware', smallModels, container));

        // Advanced section
        const advSection = document.createElement('div');
        advSection.style.cssText = 'margin-top:32px;padding:20px 24px;border:1px solid var(--vscode-input-border);border-radius:8px;display:flex;align-items:center;justify-content:space-between;gap:16px;background:var(--vscode-editor-inactiveSelectionBackground)';

        const advLeft = document.createElement('div');
        const advTitle = document.createElement('div');
        advTitle.textContent = 'Need something specific?';
        advTitle.style.cssText = 'font-size:13px;font-weight:600;color:var(--vscode-foreground)';
        advLeft.appendChild(advTitle);
        const advDesc = document.createElement('div');
        advDesc.textContent = 'Browse thousands of models from HuggingFace, or deploy to AWS/Azure GPU instances.';
        advDesc.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);margin-top:3px';
        advLeft.appendChild(advDesc);
        advSection.appendChild(advLeft);

        const advBtn = document.createElement('button');
        advBtn.textContent = 'Advanced →';
        advBtn.style.cssText = 'padding:8px 18px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;cursor:pointer;font-size:12px;font-weight:600;border-radius:4px;white-space:nowrap;transition:opacity 0.1s';
        advBtn.addEventListener('mouseenter', () => { advBtn.style.opacity = '0.85'; });
        advBtn.addEventListener('mouseleave', () => { advBtn.style.opacity = '1'; });
        advBtn.addEventListener('click', () => {
            this._modelsViewMode = 'advanced';
            this.renderModelsView(container);
        });
        advSection.appendChild(advBtn);
        content.appendChild(advSection);

        wrapper.appendChild(content);
        container.appendChild(wrapper);
    }

    private _createModelSection(title: string, subtitle: string, models: Array<{ id: string; name: string; org: string; description: string; size: string; params: string; tags: string[]; recommended?: boolean }>, rootContainer: HTMLElement): HTMLElement {
        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom:28px';

        const header = document.createElement('div');
        header.style.cssText = 'margin-bottom:12px';
        const titleEl = document.createElement('div');
        titleEl.textContent = title;
        titleEl.style.cssText = 'font-size:14px;font-weight:600;color:var(--vscode-foreground)';
        header.appendChild(titleEl);
        const subEl = document.createElement('div');
        subEl.textContent = subtitle;
        subEl.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px';
        header.appendChild(subEl);
        section.appendChild(header);

        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px';

        for (const model of models) {
            grid.appendChild(this._createCuratedModelCard(model, rootContainer));
        }
        section.appendChild(grid);
        return section;
    }

    private async _checkOllamaStatus(statusEl: HTMLElement): Promise<void> {
        statusEl.replaceChildren();

        const dot = document.createElement('div');
        dot.style.cssText = 'width:6px;height:6px;border-radius:50%;flex-shrink:0';
        statusEl.appendChild(dot);

        const msg = document.createElement('span');
        msg.style.cssText = 'font-size:11px;flex:1';
        statusEl.appendChild(msg);

        try {
            const resp = await fetch('http://localhost:11434/', { signal: AbortSignal.timeout(3000) });
            if (resp.ok) {
                dot.style.background = 'var(--vscode-testing-iconPassed)';
                msg.textContent = 'Ollama running';
                msg.style.color = 'var(--vscode-testing-iconPassed)';

                try {
                    const tagsResp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
                    if (tagsResp.ok) {
                        const data = await tagsResp.json();
                        const count = (data.models || []).length;
                        if (count > 0) {
                            msg.textContent = `Ollama running · ${count} model${count > 1 ? 's' : ''}`;
                        }
                    }
                } catch { /* ignore */ }
            } else {
                dot.style.background = 'var(--vscode-editorWarning-foreground)';
                msg.textContent = 'Ollama: issue detected';
                msg.style.color = 'var(--vscode-editorWarning-foreground)';
            }
        } catch {
            dot.style.background = 'var(--vscode-descriptionForeground)';
            msg.textContent = 'Ollama not running';
            msg.style.color = 'var(--vscode-descriptionForeground)';

            const installLink = document.createElement('span');
            installLink.textContent = 'Install';
            installLink.style.cssText = 'font-size:10px;color:var(--vscode-textLink-foreground);cursor:pointer;margin-left:6px;text-decoration:underline';
            installLink.addEventListener('click', () => {
                this.commandService.executeCommand('vscode.open', 'https://ollama.com/download');
            });
            statusEl.appendChild(installLink);
        }
    }

    private _createCuratedModelCard(model: { id: string; name: string; org: string; description: string; size: string; params: string; tags: string[]; recommended?: boolean }, _rootContainer: HTMLElement): HTMLElement {
        const card = document.createElement('div');
        card.style.cssText = 'padding:14px 16px;border:1px solid var(--vscode-input-border);border-radius:6px;display:flex;flex-direction:column;transition:border-color 0.15s,box-shadow 0.15s;position:relative';
        card.addEventListener('mouseenter', () => {
            card.style.borderColor = 'var(--vscode-focusBorder)';
            card.style.boxShadow = '0 2px 8px rgba(0,0,0,0.12)';
        });
        card.addEventListener('mouseleave', () => {
            card.style.borderColor = 'var(--vscode-input-border)';
            card.style.boxShadow = 'none';
        });

        if (model.recommended) {
            card.style.borderColor = 'var(--vscode-focusBorder)';
        }

        // Row 1: Name + org + params badge
        const topRow = document.createElement('div');
        topRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px';

        const nameEl = document.createElement('span');
        nameEl.textContent = model.name;
        nameEl.style.cssText = 'font-size:12px;font-weight:600;color:var(--vscode-foreground)';
        topRow.appendChild(nameEl);

        const paramsBadge = document.createElement('span');
        paramsBadge.textContent = model.params;
        paramsBadge.style.cssText = 'font-size:9px;padding:1px 5px;background:var(--vscode-editor-inactiveSelectionBackground);color:var(--vscode-descriptionForeground);border-radius:3px;font-weight:600';
        topRow.appendChild(paramsBadge);

        if (model.recommended) {
            const star = document.createElement('span');
            star.textContent = '★';
            star.title = 'Recommended';
            star.style.cssText = 'font-size:11px;color:var(--vscode-focusBorder);margin-left:auto';
            topRow.appendChild(star);
        }
        card.appendChild(topRow);

        // Row 2: Org
        const orgEl = document.createElement('div');
        orgEl.textContent = model.org;
        orgEl.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:8px';
        card.appendChild(orgEl);

        // Row 3: Description
        const desc = document.createElement('div');
        desc.textContent = model.description;
        desc.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.45;flex:1;margin-bottom:10px';
        card.appendChild(desc);

        // Row 4: Tags + Size (bottom aligned)
        const bottom = document.createElement('div');
        bottom.style.cssText = 'display:flex;align-items:center;gap:4px;margin-bottom:10px';

        for (const tag of model.tags) {
            const tagEl = document.createElement('span');
            tagEl.textContent = tag;
            tagEl.style.cssText = 'font-size:9px;padding:2px 5px;background:var(--vscode-editor-inactiveSelectionBackground);color:var(--vscode-descriptionForeground);border-radius:3px;font-weight:500';
            bottom.appendChild(tagEl);
        }

        const sizeEl = document.createElement('span');
        sizeEl.textContent = model.size;
        sizeEl.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);margin-left:auto;font-weight:500';
        bottom.appendChild(sizeEl);
        card.appendChild(bottom);

        // Install button
        const installBtn = document.createElement('button');
        installBtn.textContent = 'Install';
        installBtn.style.cssText = 'padding:7px 0;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;cursor:pointer;font-size:11px;font-weight:600;border-radius:4px;width:100%;transition:opacity 0.1s,transform 0.1s';
        installBtn.addEventListener('mouseenter', () => { installBtn.style.opacity = '0.9'; installBtn.style.transform = 'translateY(-1px)'; });
        installBtn.addEventListener('mouseleave', () => { installBtn.style.opacity = '1'; installBtn.style.transform = 'none'; });

        installBtn.addEventListener('click', async () => {
            installBtn.textContent = 'Downloading...';
            installBtn.disabled = true;
            installBtn.style.opacity = '0.7';

            // Progress bar overlay
            const progressTrack = document.createElement('div');
            progressTrack.style.cssText = 'position:absolute;bottom:0;left:0;right:0;height:3px;background:var(--vscode-input-border);border-radius:0 0 6px 6px;overflow:hidden';
            const progressFill = document.createElement('div');
            progressFill.style.cssText = 'height:100%;width:0%;background:var(--vscode-progressBar-background);transition:width 0.3s ease';
            progressTrack.appendChild(progressFill);
            card.appendChild(progressTrack);

            const progressDisposable = this.modelManagementService.onPullProgress((progress) => {
                if (progress.modelId !== model.id) { return; }
                if (progress.status === 'downloading' && progress.percentage !== undefined) {
                    installBtn.textContent = `${progress.percentage}%`;
                    progressFill.style.width = `${progress.percentage}%`;
                } else if (progress.status === 'completed') {
                    installBtn.textContent = '✓ Installed';
                    installBtn.style.background = 'var(--vscode-testing-iconPassed)';
                    installBtn.style.opacity = '1';
                    progressTrack.remove();
                    progressDisposable.dispose();
                } else if (progress.status === 'failed') {
                    installBtn.textContent = 'Retry';
                    installBtn.disabled = false;
                    installBtn.style.opacity = '1';
                    progressTrack.remove();
                    progressDisposable.dispose();
                }
            });

            try {
                await this.modelManagementService.pullModel('ollama', model.id);
            } catch (err: unknown) {
                const errMsg = err instanceof Error ? err.message : String(err);
                if (errMsg.includes('not running') || errMsg.includes('fetch')) {
                    installBtn.textContent = 'Ollama offline';
                } else if (errMsg.includes('disk space')) {
                    installBtn.textContent = 'No space';
                } else if (errMsg.includes('already being pulled')) {
                    installBtn.textContent = 'In progress...';
                } else {
                    installBtn.textContent = 'Retry';
                }
                installBtn.disabled = false;
                installBtn.style.opacity = '1';
                progressTrack.remove();
                progressDisposable.dispose();
            }
        });

        this._checkModelInstalled(model.id, installBtn);
        card.appendChild(installBtn);
        return card;
    }

    private async _checkModelInstalled(modelId: string, btn: HTMLButtonElement): Promise<void> {
        try {
            const resp = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
            if (resp.ok) {
                const data = await resp.json();
                const models: string[] = (data.models || []).map((m: { name: string }) => m.name);
                const isInstalled = models.some(m => m === modelId || m.startsWith(modelId.split(':')[0] + ':'));
                if (isInstalled) {
                    btn.textContent = '✓ Installed';
                    btn.style.background = 'var(--vscode-testing-iconPassed)';
                    btn.disabled = true;
                    btn.style.cursor = 'default';
                }
            }
        } catch { /* Ollama not running */ }
    }

    private async renderModelsMarketplace(container: HTMLElement): Promise<void> {
        const providers = await this.modelManagementService.detectProviders();

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;width:100%;height:100%;overflow:hidden';
        container.appendChild(wrapper);

        // LEFT SIDEBAR
        const sidebar = document.createElement('div');
        sidebar.style.cssText = 'width:180px;min-width:180px;height:100%;border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);overflow-y:auto;padding:16px 12px';
        wrapper.appendChild(sidebar);

        // Search at top of sidebar
        const searchWrap = document.createElement('div');
        searchWrap.style.cssText = 'margin-bottom:16px';
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Search...';
        searchInput.style.cssText = 'width:100%;padding:6px 10px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-input-foreground);font-size:11px;border-radius:4px;box-sizing:border-box;outline:none';
        searchInput.addEventListener('focus', () => { searchInput.style.borderColor = 'var(--vscode-focusBorder)'; });
        searchInput.addEventListener('blur', () => { searchInput.style.borderColor = 'var(--vscode-input-border)'; });
        searchWrap.appendChild(searchInput);
        sidebar.appendChild(searchWrap);

        // Provider filter
        const providerSection = document.createElement('div');
        providerSection.style.cssText = 'margin-bottom:18px';
        const providerLabel = document.createElement('div');
        providerLabel.textContent = 'PROVIDER';
        providerLabel.style.cssText = 'font-size:9px;font-weight:700;color:var(--vscode-descriptionForeground);margin-bottom:6px;letter-spacing:0.8px;padding:0 6px';
        providerSection.appendChild(providerLabel);

        const providerFilters = ['ollama', 'vLLM', 'lmStudio'];
        let selectedProvider = providers.find(p => p.detected)?.provider || 'ollama';

        const providerButtons: HTMLElement[] = [];
        for (const prov of providerFilters) {
            const provBtn = document.createElement('div');
            const displayName = prov === 'ollama' ? 'Ollama' : prov === 'vLLM' ? 'vLLM' : 'LM Studio';
            provBtn.textContent = displayName;
            provBtn.style.cssText = 'padding:5px 10px;margin-bottom:1px;cursor:pointer;font-size:11px;border-radius:4px;color:var(--vscode-foreground);transition:background 0.1s;font-weight:500';
            provBtn.addEventListener('mouseenter', () => {
                if (!provBtn.classList.contains('active')) { provBtn.style.background = 'var(--vscode-list-hoverBackground)'; }
            });
            provBtn.addEventListener('mouseleave', () => {
                if (!provBtn.classList.contains('active')) { provBtn.style.background = 'transparent'; }
            });
            provBtn.addEventListener('click', () => {
                selectedProvider = prov as any;
                providerButtons.forEach(b => {
                    b.classList.remove('active');
                    b.style.background = 'transparent';
                    b.style.fontWeight = '500';
                });
                provBtn.classList.add('active');
                provBtn.style.background = 'var(--vscode-list-activeSelectionBackground)';
                provBtn.style.fontWeight = '600';
                loadModels('code');
            });
            providerButtons.push(provBtn);
            providerSection.appendChild(provBtn);
        }
        sidebar.appendChild(providerSection);

        // Domain filter
        const domainSection = document.createElement('div');
        domainSection.style.cssText = 'margin-bottom:18px';
        const domainLabel = document.createElement('div');
        domainLabel.textContent = 'DOMAIN';
        domainLabel.style.cssText = 'font-size:9px;font-weight:700;color:var(--vscode-descriptionForeground);margin-bottom:6px;letter-spacing:0.8px;padding:0 6px';
        domainSection.appendChild(domainLabel);

        const domains = [
            { label: 'Code Generation', query: 'code' },
            { label: 'Firmware', query: 'firmware' },
            { label: 'Embedded Systems', query: 'embedded' },
            { label: 'Legacy Modernization', query: 'legacy cobol' },
            { label: 'Compliance', query: 'compliance safety' },
            { label: 'Automotive', query: 'automotive' }
        ];

        const domainButtons: HTMLElement[] = [];
        for (const domain of domains) {
            const domBtn = document.createElement('div');
            domBtn.textContent = domain.label;
            domBtn.style.cssText = 'padding:5px 10px;margin-bottom:1px;cursor:pointer;font-size:11px;border-radius:4px;color:var(--vscode-foreground);transition:background 0.1s;font-weight:500';
            domBtn.addEventListener('mouseenter', () => {
                if (!domBtn.classList.contains('active')) { domBtn.style.background = 'var(--vscode-list-hoverBackground)'; }
            });
            domBtn.addEventListener('mouseleave', () => {
                if (!domBtn.classList.contains('active')) { domBtn.style.background = 'transparent'; }
            });
            domBtn.addEventListener('click', () => {
                domainButtons.forEach(b => {
                    b.classList.remove('active');
                    b.style.background = 'transparent';
                    b.style.fontWeight = '500';
                });
                domBtn.classList.add('active');
                domBtn.style.background = 'var(--vscode-list-activeSelectionBackground)';
                domBtn.style.fontWeight = '600';
                loadModels(domain.query);
            });
            domainButtons.push(domBtn);
            domainSection.appendChild(domBtn);
        }
        sidebar.appendChild(domainSection);

        // Wire search
        let searchTimeout: ReturnType<typeof setTimeout> | undefined;
        searchInput.addEventListener('input', () => {
            if (searchTimeout) { clearTimeout(searchTimeout); }
            searchTimeout = setTimeout(() => {
                const q = searchInput.value.trim();
                if (q.length >= 2) { loadModels(q); }
                else if (q.length === 0) { loadModels('code'); }
            }, 400);
        });

        // Set defaults
        providerButtons[0].classList.add('active');
        providerButtons[0].style.background = 'var(--vscode-list-activeSelectionBackground)';
        providerButtons[0].style.fontWeight = '600';
        domainButtons[0].classList.add('active');
        domainButtons[0].style.background = 'var(--vscode-list-activeSelectionBackground)';
        domainButtons[0].style.fontWeight = '600';

        // RIGHT MAIN AREA - Split view (list + detail)
        const mainSplit = document.createElement('div');
        mainSplit.style.cssText = 'flex:1;height:100%;display:flex;overflow:hidden';
        wrapper.appendChild(mainSplit);

        // LEFT: List pane (100% width by default, 20% when detail shown)
        const listPane = document.createElement('div');
        listPane.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;transition:width 0.2s';
        mainSplit.appendChild(listPane);

        // List container
        const listContainer = document.createElement('div');
        listContainer.style.cssText = 'flex:1;overflow-y:auto;background:var(--vscode-editor-background)';
        listPane.appendChild(listContainer);

        // RIGHT: Detail pane (HIDDEN by default)
        const detailPane = document.createElement('div');
        detailPane.style.cssText = 'position:relative;display:none;width:80%;height:100%;overflow-y:auto;background:var(--vscode-editor-background);border-left:1px solid var(--vscode-panel-border)';
        mainSplit.appendChild(detailPane);

        // Loading function
        const loadModels = async (query: string) => {
            while (listContainer.firstChild) listContainer.removeChild(listContainer.firstChild);
            const loadingDiv = document.createElement('div');
            loadingDiv.textContent = 'Loading models...';
            loadingDiv.style.cssText = 'padding:40px 20px;text-align:center;color:var(--vscode-descriptionForeground);font-size:13px';
            listContainer.appendChild(loadingDiv);

            const models = await this.marketplaceService.fetchModels(selectedProvider, query);
            while (listContainer.firstChild) listContainer.removeChild(listContainer.firstChild);
            renderModelList(models);
        };

        // Generate unique color for icon based on model name
        const getIconColor = (name: string): string => {
            const colors = ['#3794ff', '#89d185', '#f48771', '#b180d7', '#f9c859', '#cc6688', '#56b6c2'];
            let hash = 0;
            for (let i = 0; i < name.length; i++) {
                hash = name.charCodeAt(i) + ((hash << 5) - hash);
            }
            return colors[Math.abs(hash) % colors.length];
        };

        // Render detail pane (EXACT VS Code extension-style with REAL data)
        const renderDetail = (model: any) => {
            while (detailPane.firstChild) detailPane.removeChild(detailPane.firstChild);

            // Close button (top-right corner)
            const closeBtn = document.createElement('div');
            closeBtn.textContent = '✕';
            closeBtn.style.cssText = 'position:absolute;top:12px;right:12px;width:28px;height:28px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:16px;color:var(--vscode-foreground);opacity:0.7;transition:opacity 0.2s;z-index:10';
            closeBtn.addEventListener('mouseenter', () => closeBtn.style.opacity = '1');
            closeBtn.addEventListener('mouseleave', () => closeBtn.style.opacity = '0.7');
            closeBtn.addEventListener('click', () => {
                detailPane.style.display = 'none';
                listPane.style.width = '100%';
            });
            detailPane.appendChild(closeBtn);

            // Header section
            const headerSection = document.createElement('div');
            headerSection.style.cssText = 'display:flex;gap:20px;padding:24px;border-bottom:1px solid var(--vscode-panel-border)';

            // Icon (128x128) - try real avatar from HuggingFace organization
            const icon = document.createElement('div');
            const iconColor = getIconColor(model.name);
            icon.style.cssText = `width:128px;height:128px;background:${iconColor};border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:64px;font-weight:700;color:#fff;flex-shrink:0;overflow:hidden;position:relative`;

            // Show letter immediately
            const iconLetter = model.name.split('/').pop()?.[0]?.toUpperCase() || model.provider[0].toUpperCase();
            const letterSpan = document.createElement('span');
            letterSpan.textContent = iconLetter;
            letterSpan.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center';
            icon.appendChild(letterSpan);

            // Fetch avatar from HuggingFace API (user endpoint, fallback to generated)
            if (model.avatar) {
                const orgName = model.avatar;
                (async () => {
                    try {
                        const response = await fetch(`https://huggingface.co/api/users/${orgName}/overview`);
                        let avatarUrl = null;

                        if (response.ok) {
                            const userData = await response.json();
                            avatarUrl = userData.avatarUrl;
                        }

                        // If no avatar from API, use generated avatar
                        if (!avatarUrl) {
                            avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(orgName)}&background=random&size=128&bold=true`;
                        }

                        const avatarImg = document.createElement('img');
                        avatarImg.src = avatarUrl;
                        avatarImg.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0';
                        avatarImg.onload = () => {
                            letterSpan.style.display = 'none';
                        };
                        icon.appendChild(avatarImg);
                    } catch (err) {
                        // Keep letter on error
                    }
                })();
            }

            headerSection.appendChild(icon);

            const headerInfo = document.createElement('div');
            headerInfo.style.cssText = 'flex:1;min-width:0';

            // Title
            const title = document.createElement('h1');
            title.textContent = model.name;
            title.style.cssText = 'margin:0 0 8px 0;font-size:22px;font-weight:600;color:var(--vscode-foreground)';
            headerInfo.appendChild(title);

            // Publisher + stats row
            const metaRow = document.createElement('div');
            metaRow.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:12px;font-size:13px';

            const publisher = document.createElement('span');
            publisher.textContent = model.provider;
            publisher.style.cssText = 'color:var(--vscode-foreground)';
            metaRow.appendChild(publisher);

            const sep1 = document.createElement('span');
            sep1.textContent = '|';
            sep1.style.cssText = 'color:var(--vscode-descriptionForeground)';
            metaRow.appendChild(sep1);

            const headerDownloads = model.description?.match(/(\d+)\s+downloads?/)?.[1];
            if (headerDownloads) {
                const dlSpan = document.createElement('span');
                dlSpan.textContent = `↓ ${parseInt(headerDownloads).toLocaleString()}`;
                dlSpan.style.cssText = 'color:var(--vscode-descriptionForeground)';
                metaRow.appendChild(dlSpan);
            }

            headerInfo.appendChild(metaRow);

            // Description
            const desc = document.createElement('div');
            desc.textContent = model.description || 'No description';
            desc.style.cssText = 'font-size:13px;color:var(--vscode-foreground);margin-bottom:16px;line-height:1.5';
            headerInfo.appendChild(desc);

            // Action buttons row
            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;align-items:center;gap:8px';

            // Install Locally button
            const installLocalBtn = document.createElement('button');
            installLocalBtn.textContent = 'Install Locally';
            installLocalBtn.style.cssText = 'padding:6px 16px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;cursor:pointer;font-size:13px;font-weight:600;border-radius:2px';
            installLocalBtn.addEventListener('click', async () => {
                installLocalBtn.textContent = 'Pulling 0%...';
                installLocalBtn.disabled = true;
                installLocalBtn.style.opacity = '0.8';
                installLocalBtn.style.minWidth = '140px';

                const progressDisposable = this.modelManagementService.onPullProgress((progress) => {
                    if (progress.modelId !== model.id) { return; }
                    if (progress.status === 'downloading' && progress.percentage !== undefined) {
                        installLocalBtn.textContent = `Pulling ${progress.percentage}%...`;
                    } else if (progress.status === 'queued') {
                        installLocalBtn.textContent = 'Queued...';
                    } else if (progress.status === 'completed') {
                        installLocalBtn.textContent = '✓ Installed';
                        installLocalBtn.style.opacity = '1';
                        progressDisposable.dispose();
                    } else if (progress.status === 'failed') {
                        installLocalBtn.textContent = 'Failed — Retry';
                        installLocalBtn.disabled = false;
                        installLocalBtn.style.opacity = '1';
                        progressDisposable.dispose();
                    } else if (progress.status === 'cancelled') {
                        installLocalBtn.textContent = 'Install Locally';
                        installLocalBtn.disabled = false;
                        installLocalBtn.style.opacity = '1';
                        progressDisposable.dispose();
                    }
                });

                try {
                    await this.modelManagementService.pullModel(model.provider, model.id);
                } catch (err: unknown) {
                    const msg = err instanceof Error ? err.message : String(err);
                    if (msg.includes('already being pulled')) {
                        installLocalBtn.textContent = 'Already pulling...';
                    } else if (msg.includes('disk space')) {
                        installLocalBtn.textContent = 'No disk space';
                        installLocalBtn.title = msg;
                    } else if (msg.includes('not supported')) {
                        installLocalBtn.textContent = 'Not supported';
                        installLocalBtn.title = `Only Ollama supports local pull. Provider: ${model.provider}`;
                    } else {
                        installLocalBtn.textContent = 'Failed — Retry';
                        installLocalBtn.title = msg;
                    }
                    installLocalBtn.disabled = false;
                    installLocalBtn.style.opacity = '1';
                    progressDisposable.dispose();
                }
            });
            btnRow.appendChild(installLocalBtn);

            // Deploy to Cloud button
            const deployCloudBtn = document.createElement('button');
            deployCloudBtn.textContent = 'Deploy to Cloud';
            deployCloudBtn.style.cssText = 'padding:6px 16px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:none;cursor:pointer;font-size:13px;font-weight:600;border-radius:2px';
            deployCloudBtn.addEventListener('click', () => {
                this._showCloudDeployWizard(detailPane, model);
            });
            btnRow.appendChild(deployCloudBtn);

            headerInfo.appendChild(btnRow);
            headerSection.appendChild(headerInfo);
            detailPane.appendChild(headerSection);

            // Single DETAILS tab (FEATURES removed as unused)
            const tabsRow = document.createElement('div');
            tabsRow.style.cssText = 'display:flex;gap:24px;padding:0 24px;border-bottom:1px solid var(--vscode-panel-border)';

            const tabEl = document.createElement('div');
            tabEl.textContent = 'DETAILS';
            tabEl.style.cssText = 'padding:12px 0;font-size:11px;font-weight:600;color:var(--vscode-foreground);border-bottom:2px solid var(--vscode-focusBorder)';
            tabsRow.appendChild(tabEl);
            detailPane.appendChild(tabsRow);

            // Content area with sidebar
            const contentArea = document.createElement('div');
            contentArea.style.cssText = 'display:flex;padding:24px;gap:32px';

            // Left: Main content
            const mainContent = document.createElement('div');
            mainContent.style.cssText = 'flex:1;min-width:0;overflow-x:hidden';

            // Fetch and display README from HuggingFace
            const readmeContainer = document.createElement('div');
            readmeContainer.style.cssText = 'font-size:13px;line-height:1.7;color:var(--vscode-foreground)';
            readmeContainer.textContent = 'Loading model details...';
            mainContent.appendChild(readmeContainer);

            // Fetch README from HuggingFace
            (async () => {
                try {
                    const readmeUrl = `https://huggingface.co/${model.id}/raw/main/README.md`;
                    const response = await fetch(readmeUrl);
                    if (response.ok) {
                        const readme = await response.text();
                        readmeContainer.textContent = '';

                        // Format inline markdown and return DOM nodes
                        const formatInline = (text: string, container: HTMLElement) => {
                            // Parse markdown syntax and create DOM nodes
                            let remaining = text;
                            let maxIterations = text.length + 100; // Safety limit
                            let iterations = 0;

                            while (remaining.length > 0 && iterations++ < maxIterations) {
                                // Try to match patterns
                                const codeMatch = remaining.match(/^`([^`]+)`/);
                                const boldMatch = remaining.match(/^\*\*([^*]+)\*\*/);
                                const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
                                const htmlLinkMatch = remaining.match(/^<a href="([^"]+)">([^<]+)<\/a>/);

                                if (codeMatch) {
                                    const code = document.createElement('code');
                                    code.style.cssText = 'background:var(--vscode-textCodeBlock-background);padding:2px 6px;border-radius:3px;font-family:monospace;font-size:12px';
                                    code.textContent = codeMatch[1];
                                    container.appendChild(code);
                                    remaining = remaining.substring(codeMatch[0].length);
                                } else if (boldMatch) {
                                    const strong = document.createElement('strong');
                                    strong.textContent = boldMatch[1];
                                    container.appendChild(strong);
                                    remaining = remaining.substring(boldMatch[0].length);
                                } else if (linkMatch) {
                                    const a = document.createElement('a');
                                    a.href = linkMatch[2];
                                    a.target = '_blank';
                                    a.textContent = linkMatch[1];
                                    a.style.cssText = 'color:var(--vscode-textLink-foreground);text-decoration:none';
                                    container.appendChild(a);
                                    remaining = remaining.substring(linkMatch[0].length);
                                } else if (htmlLinkMatch) {
                                    const a = document.createElement('a');
                                    a.href = htmlLinkMatch[1];
                                    a.target = '_blank';
                                    a.textContent = htmlLinkMatch[2];
                                    a.style.cssText = 'color:var(--vscode-textLink-foreground);text-decoration:none';
                                    container.appendChild(a);
                                    remaining = remaining.substring(htmlLinkMatch[0].length);
                                } else {
                                    // Regular text - find next special char
                                    const nextSpecial = remaining.search(/[`*\[<]/);
                                    if (nextSpecial === -1) {
                                        // No more special chars, append all remaining text
                                        container.appendChild(document.createTextNode(remaining));
                                        remaining = '';
                                    } else if (nextSpecial === 0) {
                                        // Special char at start but no pattern matched - treat as literal
                                        container.appendChild(document.createTextNode(remaining[0]));
                                        remaining = remaining.substring(1);
                                    } else {
                                        // Append text before special char
                                        container.appendChild(document.createTextNode(remaining.substring(0, nextSpecial)));
                                        remaining = remaining.substring(nextSpecial);
                                    }
                                }
                            }

                            // Safety: if we hit max iterations, just append remaining as text
                            if (remaining.length > 0) {
                                container.appendChild(document.createTextNode(remaining));
                            }
                        };

                        // Markdown renderer
                        const renderMarkdown = (md: string) => {
                            const container = document.createElement('div');
                            const lines = md.split('\n');
                            let inCodeBlock = false;
                            let codeBlock: HTMLPreElement | null = null;
                            let codeContent = '';

                            for (let i = 0; i < lines.length; i++) {
                                const line = lines[i];

                                // Code block toggle
                                if (line.startsWith('```')) {
                                    if (!inCodeBlock) {
                                        inCodeBlock = true;
                                        codeBlock = document.createElement('pre');
                                        codeBlock.style.cssText = 'background:var(--vscode-textCodeBlock-background);padding:12px;border-radius:4px;overflow-x:auto;font-family:monospace;font-size:12px;margin:12px 0;white-space:pre-wrap;word-wrap:break-word';
                                        codeContent = '';
                                    } else {
                                        inCodeBlock = false;
                                        if (codeBlock) {
                                            codeBlock.textContent = codeContent;
                                            container.appendChild(codeBlock);
                                        }
                                        codeBlock = null;
                                    }
                                    continue;
                                }

                                if (inCodeBlock) {
                                    codeContent += line + '\n';
                                    continue;
                                }

                                // Horizontal rule
                                if (line.trim() === '---' || line.trim() === '***') {
                                    const hr = document.createElement('hr');
                                    hr.style.cssText = 'border:none;border-top:1px solid var(--vscode-panel-border);margin:20px 0';
                                    container.appendChild(hr);
                                    continue;
                                }

                                // Headings
                                if (line.startsWith('# ')) {
                                    const h1 = document.createElement('h1');
                                    h1.style.cssText = 'font-size:24px;font-weight:700;margin:24px 0 12px 0;color:var(--vscode-foreground)';
                                    formatInline(line.substring(2), h1);
                                    container.appendChild(h1);
                                } else if (line.startsWith('## ')) {
                                    const h2 = document.createElement('h2');
                                    h2.style.cssText = 'font-size:18px;font-weight:600;margin:20px 0 10px 0;color:var(--vscode-foreground)';
                                    formatInline(line.substring(3), h2);
                                    container.appendChild(h2);
                                } else if (line.startsWith('### ')) {
                                    const h3 = document.createElement('h3');
                                    h3.style.cssText = 'font-size:15px;font-weight:600;margin:16px 0 8px 0;color:var(--vscode-foreground)';
                                    formatInline(line.substring(4), h3);
                                    container.appendChild(h3);
                                } else if (line.startsWith('- ') || line.startsWith('* ')) {
                                    const li = document.createElement('p');
                                    li.style.cssText = 'margin:4px 0 4px 20px;line-height:1.6;color:var(--vscode-foreground)';
                                    li.appendChild(document.createTextNode('• '));
                                    formatInline(line.substring(2), li);
                                    container.appendChild(li);
                                } else if (line.trim()) {
                                    const p = document.createElement('p');
                                    p.style.cssText = 'margin:8px 0;line-height:1.6;color:var(--vscode-foreground)';
                                    formatInline(line, p);
                                    container.appendChild(p);
                                }
                            }

                            return container;
                        };

                        const rendered = renderMarkdown(readme);
                        readmeContainer.appendChild(rendered);
                    } else {
                        readmeContainer.textContent = model.description || 'No detailed information available.';
                    }
                } catch (err) {
                    readmeContainer.textContent = model.description || 'Failed to load model details.';
                }
            })();

            // Capabilities section (below README)
            const capSection = document.createElement('div');
            capSection.style.cssText = 'margin-top:32px;padding-top:24px;border-top:1px solid var(--vscode-panel-border)';
            const capTitle = document.createElement('h3');
            capTitle.textContent = 'Capabilities';
            capTitle.style.cssText = 'margin:0 0 12px 0;font-size:16px;font-weight:600;color:var(--vscode-foreground)';
            capSection.appendChild(capTitle);

            const capList = document.createElement('ul');
            capList.style.cssText = 'margin:0;padding-left:20px;color:var(--vscode-foreground);font-size:13px;line-height:1.8';
            (model.capabilities || ['chat', 'code']).forEach((cap: string) => {
                const li = document.createElement('li');
                li.textContent = cap.charAt(0).toUpperCase() + cap.slice(1);
                capList.appendChild(li);
            });
            capSection.appendChild(capList);
            mainContent.appendChild(capSection);

            contentArea.appendChild(mainContent);

            // Right: Sidebar
            const sidebar = document.createElement('div');
            sidebar.style.cssText = 'width:240px;flex-shrink:0';

            // Installation section first
            const installTitle = document.createElement('h3');
            installTitle.textContent = 'Installation';
            installTitle.style.cssText = 'margin:0 0 16px 0;font-size:14px;font-weight:600;color:var(--vscode-foreground)';
            sidebar.appendChild(installTitle);

            const installData = [
                ['Identifier', model.id.split('/').pop() || model.id],
                ['Size', `${(model.size! / (1024*1024*1024)).toFixed(2)} GB`]
            ];

            installData.forEach(([label, value]) => {
                const row = document.createElement('div');
                row.style.cssText = 'margin-bottom:12px';

                const labelDiv = document.createElement('div');
                labelDiv.textContent = label;
                labelDiv.style.cssText = 'font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);margin-bottom:4px';
                row.appendChild(labelDiv);

                const valueDiv = document.createElement('div');
                valueDiv.textContent = value;
                valueDiv.style.cssText = 'font-size:12px;color:var(--vscode-foreground)';
                row.appendChild(valueDiv);

                sidebar.appendChild(row);
            });

            // Marketplace section
            const marketplaceTitle = document.createElement('h3');
            marketplaceTitle.textContent = 'Marketplace';
            marketplaceTitle.style.cssText = 'margin:24px 0 16px 0;font-size:14px;font-weight:600;color:var(--vscode-foreground)';
            sidebar.appendChild(marketplaceTitle);

            const downloadsCount = model.description?.match(/(\d+)\s+downloads?/)?.[1];
            const sidebarData = [
                ['Downloads', downloadsCount ? parseInt(downloadsCount).toLocaleString() : 'N/A'],
                ['Last Updated', 'Recently'],
                ['Context Window', model.contextWindow ? `${model.contextWindow.toLocaleString()} tokens` : '4,096 tokens'],
                ['Provider', model.provider]
            ];

            sidebarData.forEach(([label, value]) => {
                const row = document.createElement('div');
                row.style.cssText = 'margin-bottom:12px';

                const labelDiv = document.createElement('div');
                labelDiv.textContent = label;
                labelDiv.style.cssText = 'font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);margin-bottom:4px';
                row.appendChild(labelDiv);

                const valueDiv = document.createElement('div');
                valueDiv.textContent = value;
                valueDiv.style.cssText = 'font-size:12px;color:var(--vscode-foreground)';
                row.appendChild(valueDiv);

                sidebar.appendChild(row);
            });

            // Resources section
            const resourcesTitle = document.createElement('h3');
            resourcesTitle.textContent = 'Resources';
            resourcesTitle.style.cssText = 'margin:24px 0 12px 0;font-size:14px;font-weight:600;color:var(--vscode-foreground)';
            sidebar.appendChild(resourcesTitle);

            const hfLink = document.createElement('a');
            hfLink.textContent = 'Model Card';
            hfLink.href = `https://huggingface.co/${model.id}`;
            hfLink.target = '_blank';
            hfLink.style.cssText = 'display:block;font-size:12px;color:var(--vscode-textLink-foreground);text-decoration:none;margin-bottom:8px';
            sidebar.appendChild(hfLink);

            contentArea.appendChild(sidebar);
            detailPane.appendChild(contentArea);

            // Show detail pane and resize list to 20%
            detailPane.style.display = 'block';
            listPane.style.width = '20%';
        };

        // Render list (EXACT VS Code extension-style)
        const renderModelList = (models: any[]) => {
            if (models.length === 0) {
                const emptyDiv = document.createElement('div');
                emptyDiv.textContent = 'No models found';
                emptyDiv.style.cssText = 'padding:40px 20px;text-align:center;color:var(--vscode-descriptionForeground);font-size:13px';
                listContainer.appendChild(emptyDiv);
                return;
            }

            for (const model of models) {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-bottom:1px solid var(--vscode-panel-border);cursor:pointer;transition:background 0.1s';
                row.addEventListener('mouseenter', () => row.style.background = 'var(--vscode-list-hoverBackground)');
                row.addEventListener('mouseleave', () => row.style.background = 'transparent');
                row.addEventListener('click', () => renderDetail(model));

                // Icon (40x40 for narrow view) - try real avatar from HuggingFace organization
                const icon = document.createElement('div');
                const iconColor = getIconColor(model.name);
                icon.style.cssText = `width:40px;height:40px;min-width:40px;background:${iconColor};border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#fff;flex-shrink:0;overflow:hidden;position:relative`;

                // Show letter immediately
                const iconLetter = model.name.split('/').pop()?.[0]?.toUpperCase() || model.provider[0].toUpperCase();
                const letterSpan = document.createElement('span');
                letterSpan.textContent = iconLetter;
                letterSpan.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center';
                icon.appendChild(letterSpan);

                // Fetch avatar from HuggingFace API (user endpoint, fallback to generated)
                if (model.avatar) {
                    const orgName = model.avatar;
                    (async () => {
                        try {
                            const response = await fetch(`https://huggingface.co/api/users/${orgName}/overview`);
                            let avatarUrl = null;

                            if (response.ok) {
                                const userData = await response.json();
                                avatarUrl = userData.avatarUrl;
                            }

                            // If no avatar from API, use generated avatar
                            if (!avatarUrl) {
                                avatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(orgName)}&background=random&size=128&bold=true`;
                            }

                            const avatarImg = document.createElement('img');
                            avatarImg.src = avatarUrl;
                            avatarImg.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0';
                            avatarImg.onload = () => {
                                letterSpan.style.display = 'none';
                            };
                            icon.appendChild(avatarImg);
                        } catch (err) {
                            // Keep letter on error
                        }
                    })();
                }

                row.appendChild(icon);

                // Info column
                const info = document.createElement('div');
                info.style.cssText = 'flex:1;min-width:0;overflow:hidden';

                // Name (wrap on narrow, truncate on wide)
                const name = document.createElement('div');
                name.textContent = model.name;
                name.style.cssText = 'font-size:12px;font-weight:600;color:var(--vscode-foreground);margin-bottom:4px;word-wrap:break-word;line-height:1.3';
                info.appendChild(name);

                // Stats + provider in one line
                const metaRow = document.createElement('div');
                metaRow.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:11px;color:var(--vscode-descriptionForeground)';

                const provider = document.createElement('span');
                provider.textContent = model.provider;
                metaRow.appendChild(provider);

                const downloads = model.description?.match(/(\d+)\s+downloads?/)?.[1];
                if (downloads) {
                    const sep = document.createElement('span');
                    sep.textContent = '·';
                    metaRow.appendChild(sep);

                    const dlCount = parseInt(downloads);
                    const dlSpan = document.createElement('span');
                    dlSpan.textContent = `↓ ${dlCount > 1000000 ? (dlCount / 1000000).toFixed(1) + 'M' : dlCount > 1000 ? (dlCount / 1000).toFixed(1) + 'K' : dlCount}`;
                    metaRow.appendChild(dlSpan);
                }

                info.appendChild(metaRow);
                row.appendChild(info);

                listContainer.appendChild(row);
            }
        };

        // Initial load
        await loadModels('code');

        // Search handled by sidebar searchInput listener above
    }

    private _getIconColor(name: string): string {
        const colors = ['#3794ff', '#89d185', '#f48771', '#b180d7', '#f9c859', '#cc6688', '#56b6c2'];
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        return colors[Math.abs(hash) % colors.length];
    }

    // === BACKGROUND AGENTS TAB ===

    private _renderBackgroundAgentsView(container: HTMLElement): void {
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.overflow = 'hidden';

        // Header
        const header = document.createElement('div');
        header.style.display = 'flex';
        header.style.alignItems = 'center';
        header.style.justifyContent = 'space-between';
        header.style.padding = '12px 16px';
        header.style.borderBottom = '1px solid var(--vscode-panel-border)';

        const titleArea = document.createElement('div');
        titleArea.style.display = 'flex';
        titleArea.style.alignItems = 'center';
        titleArea.style.gap = '8px';

        const title = document.createElement('span');
        title.textContent = 'Background Agents';
        title.style.fontSize = '13px';
        title.style.fontWeight = '500';
        title.style.color = 'var(--vscode-foreground)';
        titleArea.appendChild(title);

        const badge = document.createElement('span');
        badge.style.fontSize = '10px';
        badge.style.padding = '1px 6px';
        badge.style.borderRadius = '8px';
        badge.style.background = 'rgba(59,130,246,0.2)';
        badge.style.color = '#93c5fd';
        badge.style.display = 'none';
        titleArea.appendChild(badge);
        header.appendChild(titleArea);

        const spawnBtn = document.createElement('button');
        spawnBtn.textContent = '+ New Agent';
        spawnBtn.style.fontSize = '11px';
        spawnBtn.style.padding = '4px 10px';
        spawnBtn.style.borderRadius = '4px';
        spawnBtn.style.background = 'var(--vscode-button-secondaryBackground)';
        spawnBtn.style.color = 'var(--vscode-button-secondaryForeground)';
        spawnBtn.style.border = '1px solid var(--vscode-panel-border)';
        spawnBtn.style.cursor = 'pointer';
        spawnBtn.addEventListener('click', () => {
            this.commandService.executeCommand('neuralInverse.bgAgent.spawn');
        });
        header.appendChild(spawnBtn);
        container.appendChild(header);

        // Task list area
        const listArea = document.createElement('div');
        listArea.style.flex = '1';
        listArea.style.minHeight = '0';
        listArea.style.overflowY = 'auto';
        listArea.style.padding = '12px';
        container.appendChild(listArea);

        const render = () => {
            const tasks = [...this.backgroundAgentService.tasks.values()];

            // Always show task count in header for debug
            title.textContent = `Background Agents (${tasks.length})`;

            listArea.innerHTML = '';
            const statusOrder: BackgroundTaskStatus[] = ['running', 'branching', 'committing', 'queued', 'completed', 'failed', 'cancelled'];
            tasks.sort((a, b) => statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));

            const running = tasks.filter(t => t.status === 'running' || t.status === 'branching' || t.status === 'committing');
            if (running.length > 0) {
                badge.textContent = `${running.length} active`;
                badge.style.display = 'inline';
            } else {
                badge.style.display = 'none';
            }

            if (tasks.length === 0) {
                const empty = document.createElement('div');
                empty.style.display = 'flex';
                empty.style.flexDirection = 'column';
                empty.style.alignItems = 'center';
                empty.style.justifyContent = 'center';
                empty.style.height = '100%';
                empty.style.opacity = '0.5';
                empty.style.textAlign = 'center';
                empty.innerHTML = `
                    <div style="font-size:32px;margin-bottom:12px">⊘</div>
                    <div style="font-size:12px;color:var(--vscode-descriptionForeground)">No background agents running</div>
                    <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:4px;opacity:0.7">Spawn one to work on a branch while you continue coding</div>
                `;
                listArea.appendChild(empty);
                return;
            }

            for (const task of tasks) {
                const card = document.createElement('div');
                card.style.marginBottom = '8px';
                card.style.borderRadius = '6px';
                card.style.border = '1px solid var(--vscode-panel-border)';
                card.style.overflow = 'hidden';

                const isActive = task.status === 'running' || task.status === 'branching' || task.status === 'committing';
                if (isActive) {
                    card.style.borderColor = 'rgba(59,130,246,0.3)';
                    card.style.background = 'rgba(30,58,138,0.1)';
                } else {
                    card.style.background = 'var(--vscode-editor-inactiveSelectionBackground)';
                }

                // Card header
                const cardHeader = document.createElement('div');
                cardHeader.style.display = 'flex';
                cardHeader.style.alignItems = 'center';
                cardHeader.style.gap = '8px';
                cardHeader.style.padding = '8px 12px';
                cardHeader.style.cursor = 'pointer';

                const dot = document.createElement('span');
                dot.style.width = '6px';
                dot.style.height = '6px';
                dot.style.borderRadius = '50%';
                dot.style.flexShrink = '0';
                if (isActive) { dot.style.background = '#60a5fa'; }
                else if (task.status === 'completed') { dot.style.background = '#4ade80'; }
                else if (task.status === 'failed') { dot.style.background = '#f87171'; }
                else { dot.style.background = '#666'; }
                cardHeader.appendChild(dot);

                const taskTitle = document.createElement('span');
                taskTitle.textContent = task.request.title;
                taskTitle.style.fontSize = '12px';
                taskTitle.style.fontWeight = '600';
                taskTitle.style.color = 'var(--vscode-foreground)';
                taskTitle.style.flex = '1';
                taskTitle.style.overflow = 'hidden';
                taskTitle.style.textOverflow = 'ellipsis';
                taskTitle.style.whiteSpace = 'nowrap';
                cardHeader.appendChild(taskTitle);

                const statusLabel = document.createElement('span');
                const labels: Record<string, string> = { running: '⚡ Running', branching: '🔀 Branching', committing: '💾 Committing', queued: '⏳ Queued', completed: '✓ Done', failed: '✗ Failed', cancelled: '⊘ Cancelled' };
                statusLabel.textContent = labels[task.status] || task.status;
                statusLabel.style.fontSize = '10px';
                statusLabel.style.color = 'var(--vscode-descriptionForeground)';
                cardHeader.appendChild(statusLabel);

                card.appendChild(cardHeader);

                // Expandable console
                const consoleArea = document.createElement('div');
                consoleArea.style.display = isActive ? 'block' : 'none';
                consoleArea.style.borderTop = '1px solid var(--vscode-panel-border)';

                // Metadata
                const meta = document.createElement('div');
                meta.style.display = 'flex';
                meta.style.gap = '12px';
                meta.style.padding = '4px 12px';
                meta.style.fontSize = '10px';
                meta.style.color = 'var(--vscode-descriptionForeground)';
                meta.style.opacity = '0.6';
                meta.style.background = 'rgba(0,0,0,0.1)';
                meta.innerHTML = `<span style="font-family:monospace">${task.branchName}</span><span>${task.commits.length} commit(s)</span><span>${task.progress.length} steps</span>`;
                consoleArea.appendChild(meta);

                // Progress log
                const log = document.createElement('div');
                log.style.padding = '8px 12px';
                log.style.maxHeight = '200px';
                log.style.overflowY = 'auto';
                log.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
                log.style.fontSize = '11px';
                log.style.color = 'var(--vscode-foreground)';
                log.style.opacity = '0.8';

                if (task.progress.length === 0) {
                    log.innerHTML = '<div style="opacity:0.4;font-style:italic">Waiting...</div>';
                } else {
                    log.innerHTML = task.progress.map(l => `<div style="padding:1px 0"><span style="opacity:0.3;margin-right:6px">&gt;</span>${this._escapeHtml(l)}</div>`).join('');
                }
                if (task.error) {
                    log.innerHTML += `<div style="color:var(--vscode-errorForeground);margin-top:4px;padding-left:12px;border-left:2px solid var(--vscode-errorForeground)">${this._escapeHtml(task.error)}</div>`;
                }
                consoleArea.appendChild(log);

                // Actions
                const actions = document.createElement('div');
                actions.style.display = 'flex';
                actions.style.gap = '8px';
                actions.style.padding = '6px 12px';
                actions.style.borderTop = '1px solid var(--vscode-panel-border)';

                if (isActive) {
                    const cancelBtn = document.createElement('button');
                    cancelBtn.textContent = 'Cancel';
                    cancelBtn.style.fontSize = '10px';
                    cancelBtn.style.padding = '2px 8px';
                    cancelBtn.style.borderRadius = '3px';
                    cancelBtn.style.background = 'rgba(239,68,68,0.2)';
                    cancelBtn.style.color = '#fca5a5';
                    cancelBtn.style.border = 'none';
                    cancelBtn.style.cursor = 'pointer';
                    cancelBtn.addEventListener('click', () => this.backgroundAgentService.cancel(task.id));
                    actions.appendChild(cancelBtn);
                }
                if (task.status === 'completed' && task.commits.length > 0) {
                    const diffBtn = document.createElement('button');
                    diffBtn.textContent = 'View Diff';
                    diffBtn.style.fontSize = '10px';
                    diffBtn.style.padding = '2px 8px';
                    diffBtn.style.borderRadius = '3px';
                    diffBtn.style.background = 'rgba(59,130,246,0.2)';
                    diffBtn.style.color = '#93c5fd';
                    diffBtn.style.border = 'none';
                    diffBtn.style.cursor = 'pointer';
                    diffBtn.addEventListener('click', () => this.commandService.executeCommand('neuralInverse.bgAgent.viewDiff'));
                    actions.appendChild(diffBtn);
                }
                if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
                    const removeBtn = document.createElement('button');
                    removeBtn.textContent = 'Remove';
                    removeBtn.style.fontSize = '10px';
                    removeBtn.style.padding = '2px 8px';
                    removeBtn.style.borderRadius = '3px';
                    removeBtn.style.background = 'var(--vscode-button-secondaryBackground)';
                    removeBtn.style.color = 'var(--vscode-button-secondaryForeground)';
                    removeBtn.style.border = 'none';
                    removeBtn.style.cursor = 'pointer';
                    removeBtn.style.marginLeft = 'auto';
                    removeBtn.addEventListener('click', () => { this.backgroundAgentService.removeTask(task.id); render(); });
                    actions.appendChild(removeBtn);
                }
                consoleArea.appendChild(actions);
                card.appendChild(consoleArea);

                // Toggle expand
                cardHeader.addEventListener('click', () => {
                    consoleArea.style.display = consoleArea.style.display === 'none' ? 'block' : 'none';
                });

                listArea.appendChild(card);
            }
        };

        render();
        this.disposables.add(this.backgroundAgentService.onDidChangeTask(() => render()));
    }

    private _escapeHtml(str: string): string {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // === DEPLOYMENTS TAB ===

    private _deploymentsDisposable: DisposableStore | undefined;

    private _renderDeploymentsView(container: HTMLElement): void {
        // Cleanup previous render
        if (this._deploymentsDisposable) {
            this._deploymentsDisposable.dispose();
        }
        this._deploymentsDisposable = new DisposableStore();
        while (container.firstChild) { container.removeChild(container.firstChild); }

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'padding:24px;height:100%;display:flex;flex-direction:column';

        // Header
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-shrink:0';

        const titleCol = document.createElement('div');
        const title = document.createElement('h2');
        title.textContent = 'Deployments';
        title.style.cssText = 'margin:0;font-size:16px;font-weight:600;color:var(--vscode-foreground)';
        titleCol.appendChild(title);
        const subtitle = document.createElement('div');
        subtitle.textContent = 'Local providers and cloud GPU instances';
        subtitle.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);margin-top:3px';
        titleCol.appendChild(subtitle);
        header.appendChild(titleCol);

        const refreshBtn = document.createElement('button');
        refreshBtn.textContent = '↻ Refresh';
        refreshBtn.style.cssText = 'padding:4px 12px;background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-input-border);cursor:pointer;font-size:11px;border-radius:3px';
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.textContent = '↻ Refreshing...';
            refreshBtn.disabled = true;
            await this.deploymentRegistryService.refresh();
            this._renderDeploymentsView(container);
        });
        header.appendChild(refreshBtn);
        wrapper.appendChild(header);

        // Content
        const content = document.createElement('div');
        content.style.cssText = 'flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:12px';

        const deployments = this.deploymentRegistryService.getAll();
        const localDeployments = deployments.filter(isLocalDeployment);
        const cloudDeployments = deployments.filter(isCloudDeployment);

        // --- Local Providers Section ---
        if (localDeployments.length > 0) {
            const section = this._createDeploymentSection('LOCAL PROVIDERS', localDeployments.length);
            const list = document.createElement('div');
            list.style.cssText = 'display:flex;flex-direction:column;gap:1px;border:1px solid var(--vscode-input-border);border-radius:4px;overflow:hidden';

            for (const dep of localDeployments) {
                list.appendChild(this._createDeploymentRow(dep));
            }
            section.appendChild(list);
            content.appendChild(section);
        }

        // --- Cloud Deployments Section ---
        const cloudSection = this._createDeploymentSection('CLOUD DEPLOYMENTS', cloudDeployments.length);

        if (cloudDeployments.length > 0) {
            const list = document.createElement('div');
            list.style.cssText = 'display:flex;flex-direction:column;gap:1px;border:1px solid var(--vscode-input-border);border-radius:4px;overflow:hidden';

            for (const dep of cloudDeployments) {
                list.appendChild(this._createDeploymentRow(dep));
            }
            cloudSection.appendChild(list);
        } else {
            const empty = document.createElement('div');
            empty.style.cssText = 'padding:20px;text-align:center;color:var(--vscode-descriptionForeground);font-size:12px;border:1px dashed var(--vscode-input-border);border-radius:4px';
            empty.textContent = 'No cloud deployments. Deploy a model from the Models tab.';
            cloudSection.appendChild(empty);
        }
        content.appendChild(cloudSection);

        // --- Auto-Config Status ---
        const configSection = this._createDeploymentSection('AUTO-CONFIGURATION', undefined);
        const configInfo = document.createElement('div');
        configInfo.style.cssText = 'padding:10px 12px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px;font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5';

        const activeEndpoints = deployments.filter(d => isDeploymentActive(d) && getDeploymentEndpoint(d));
        if (activeEndpoints.length > 0) {
            configInfo.textContent = `${activeEndpoints.length} active endpoint(s) available. Settings are auto-configured when a new deployment comes online (only if unconfigured).`;
        } else {
            configInfo.textContent = 'No active endpoints. Start a local provider or deploy a model to cloud to auto-configure IDE settings.';
        }
        configSection.appendChild(configInfo);
        content.appendChild(configSection);

        wrapper.appendChild(content);
        container.appendChild(wrapper);

        // Live updates
        this._deploymentsDisposable.add(this.deploymentRegistryService.onDidChange(() => {
            this._renderDeploymentsView(container);
        }));
    }

    private _createDeploymentSection(label: string, count: number | undefined): HTMLElement {
        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom:8px';

        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px';

        const labelEl = document.createElement('div');
        labelEl.textContent = label;
        labelEl.style.cssText = 'font-size:10px;font-weight:700;letter-spacing:0.8px;color:var(--vscode-descriptionForeground)';
        header.appendChild(labelEl);

        if (count !== undefined) {
            const badge = document.createElement('span');
            badge.textContent = String(count);
            badge.style.cssText = 'font-size:9px;padding:1px 5px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:8px';
            header.appendChild(badge);
        }

        section.appendChild(header);
        return section;
    }

    private _createDeploymentRow(deployment: IUnifiedDeployment): HTMLElement {
        const row = document.createElement('div');
        row.style.cssText = 'display:grid;grid-template-columns:auto 1fr auto auto;align-items:center;gap:12px;padding:10px 12px;background:var(--vscode-editor-background);transition:background 0.1s';
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--vscode-list-hoverBackground)'; });
        row.addEventListener('mouseleave', () => { row.style.background = 'var(--vscode-editor-background)'; });

        // Status indicator
        const statusDot = document.createElement('div');
        const active = isDeploymentActive(deployment);
        const dotColor = active ? 'var(--vscode-testing-iconPassed)' :
            deployment.status === 'failed' ? 'var(--vscode-errorForeground)' :
            deployment.status === 'stopped' ? 'var(--vscode-descriptionForeground)' :
            'var(--vscode-editorWarning-foreground)';
        statusDot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${dotColor};flex-shrink:0`;
        if (active && deployment.kind === 'local') {
            statusDot.style.boxShadow = `0 0 4px ${dotColor}`;
        }
        row.appendChild(statusDot);

        // Info column
        const info = document.createElement('div');
        info.style.cssText = 'min-width:0';

        const nameRow = document.createElement('div');
        nameRow.style.cssText = 'display:flex;align-items:center;gap:6px';

        const name = document.createElement('span');
        name.style.cssText = 'font-size:12px;font-weight:600;color:var(--vscode-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis';

        if (isLocalDeployment(deployment)) {
            name.textContent = deployment.displayName;
        } else {
            name.textContent = deployment.modelName;
        }
        nameRow.appendChild(name);

        const kindBadge = document.createElement('span');
        kindBadge.textContent = deployment.kind === 'local' ? 'LOCAL' : deployment.kind === 'cloud' ? (deployment as any).cloudProvider?.toUpperCase() : 'CLOUD';
        kindBadge.style.cssText = 'font-size:9px;padding:1px 4px;border-radius:2px;font-weight:600;letter-spacing:0.3px;' +
            (deployment.kind === 'local'
                ? 'background:var(--vscode-editor-inactiveSelectionBackground);color:var(--vscode-descriptionForeground)'
                : 'background:#ff990022;color:#ff9900');
        nameRow.appendChild(kindBadge);
        info.appendChild(nameRow);

        const details = document.createElement('div');
        details.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';

        if (isLocalDeployment(deployment)) {
            const modelCount = deployment.models.length;
            details.textContent = `${deployment.endpoint} · ${modelCount} model${modelCount !== 1 ? 's' : ''} · ${deployment.status}`;
        } else if (isCloudDeployment(deployment)) {
            details.textContent = `${deployment.config.instanceType} · ${deployment.config.gpuType} · $${deployment.costPerHour.toFixed(2)}/hr · ${deployment.status}`;
        }
        info.appendChild(details);
        row.appendChild(info);

        // Endpoint / connect button
        const endpoint = getDeploymentEndpoint(deployment);
        if (endpoint && active) {
            const connectBtn = document.createElement('button');
            connectBtn.textContent = 'Connect';
            connectBtn.style.cssText = 'padding:3px 8px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;cursor:pointer;font-size:10px;font-weight:600;border-radius:3px;white-space:nowrap';
            connectBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.voidSettingsService.setSettingOfProvider(endpoint.provider, 'endpoint', endpoint.url);
                if (endpoint.apiKey) {
                    this.voidSettingsService.setSettingOfProvider(endpoint.provider, 'apiKey', endpoint.apiKey);
                }
                if (endpoint.modelName) {
                    this.voidSettingsService.setAutodetectedModels(endpoint.provider, [endpoint.modelName], { enableProviderOnSuccess: true, hideRefresh: false });
                }
                connectBtn.textContent = '✓';
                connectBtn.disabled = true;
                connectBtn.style.opacity = '0.7';
            });
            row.appendChild(connectBtn);
        } else {
            const spacer = document.createElement('div');
            row.appendChild(spacer);
        }

        // Actions
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:4px';

        if (isCloudDeployment(deployment)) {
            if (deployment.status === 'running') {
                const stopBtn = this._createSmallAction('■', 'Stop', async () => {
                    await this.cloudDeploymentService.stop(deployment.id);
                });
                actions.appendChild(stopBtn);
            } else if (deployment.status === 'stopped') {
                const startBtn = this._createSmallAction('▶', 'Start', async () => {
                    await this.cloudDeploymentService.start(deployment.id);
                });
                actions.appendChild(startBtn);
            }

            if (deployment.status !== 'terminated' && deployment.status !== 'terminating') {
                const deleteBtn = this._createSmallAction('✕', 'Terminate', async () => {
                    await this.cloudDeploymentService.teardown(deployment.id);
                });
                deleteBtn.style.color = 'var(--vscode-errorForeground)';
                actions.appendChild(deleteBtn);
            }
        }

        row.appendChild(actions);
        return row;
    }

    private _createSmallAction(icon: string, title: string, onClick: () => Promise<void>): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.textContent = icon;
        btn.title = title;
        btn.style.cssText = 'width:22px;height:22px;display:flex;align-items:center;justify-content:center;background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-input-border);cursor:pointer;font-size:10px;border-radius:3px;transition:opacity 0.1s';
        btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.7'; });
        btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; });
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            btn.disabled = true;
            btn.style.opacity = '0.4';
            try { await onClick(); } catch { btn.disabled = false; btn.style.opacity = '1'; }
        });
        return btn;
    }

    // === CLOUD DEPLOY WIZARD ===

    private _showCloudDeployWizard(detailPane: HTMLElement, model: any): void {
        while (detailPane.firstChild) { detailPane.removeChild(detailPane.firstChild); }

        const wizard = document.createElement('div');
        wizard.style.cssText = 'padding:24px 28px;height:100%;overflow-y:auto;display:flex;flex-direction:column';

        // --- Header ---
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;flex-shrink:0';

        const titleCol = document.createElement('div');
        const title = document.createElement('h2');
        title.textContent = 'Deploy to Cloud';
        title.style.cssText = 'margin:0;font-size:16px;font-weight:600;color:var(--vscode-foreground)';
        titleCol.appendChild(title);
        const subtitle = document.createElement('div');
        subtitle.textContent = 'Provision a GPU instance and serve via vLLM (OpenAI-compatible)';
        subtitle.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground);margin-top:3px';
        titleCol.appendChild(subtitle);
        header.appendChild(titleCol);

        const backBtn = document.createElement('button');
        backBtn.textContent = '← Back';
        backBtn.style.cssText = 'padding:4px 12px;background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-input-border);cursor:pointer;font-size:11px;border-radius:3px;white-space:nowrap';
        backBtn.addEventListener('click', () => {
            while (detailPane.firstChild) { detailPane.removeChild(detailPane.firstChild); }
            detailPane.style.display = 'none';
            const listPane = detailPane.previousElementSibling as HTMLElement;
            if (listPane) { listPane.style.width = '100%'; }
        });
        header.appendChild(backBtn);
        wizard.appendChild(header);

        // --- Model info card ---
        const modelSizeGB = (model.size || 0) / (1024 * 1024 * 1024);
        const requiredVRAM = Math.ceil(modelSizeGB * 1.2);

        const modelInfo = document.createElement('div');
        modelInfo.style.cssText = 'background:var(--vscode-editor-inactiveSelectionBackground);padding:12px 14px;border-radius:6px;margin-bottom:20px;display:flex;align-items:center;gap:12px;flex-shrink:0';

        const modelIcon = document.createElement('div');
        const iconColor = this._getIconColor(model.name);
        const iconLetter = model.name.split('/').pop()?.[0]?.toUpperCase() || '?';
        modelIcon.textContent = iconLetter;
        modelIcon.style.cssText = `width:32px;height:32px;background:${iconColor};border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:#fff;flex-shrink:0`;
        modelInfo.appendChild(modelIcon);

        const modelMeta = document.createElement('div');
        modelMeta.style.cssText = 'min-width:0;flex:1';
        const modelNameEl = document.createElement('div');
        modelNameEl.textContent = model.name;
        modelNameEl.style.cssText = 'font-size:12px;font-weight:600;color:var(--vscode-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        modelMeta.appendChild(modelNameEl);
        const modelSizeEl = document.createElement('div');
        modelSizeEl.textContent = `${modelSizeGB.toFixed(1)} GB · Requires ${requiredVRAM} GB VRAM`;
        modelSizeEl.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px';
        modelMeta.appendChild(modelSizeEl);
        modelInfo.appendChild(modelMeta);
        wizard.appendChild(modelInfo);

        // --- Check existing deployment ---
        const existingDeployment = this.cloudDeploymentService.getActiveDeploymentForModel(model.id);
        if (existingDeployment) {
            this._renderExistingDeployment(wizard, existingDeployment, detailPane);
            detailPane.appendChild(wizard);
            return;
        }

        // --- Main content area ---
        const content = document.createElement('div');
        content.style.cssText = 'flex:1;overflow-y:auto';
        wizard.appendChild(content);

        let selectedProvider: CloudProvider = 'aws';
        let resolvedCredentials: ICloudCredentials | null = null;

        // --- Step 1: Provider ---
        const step1 = document.createElement('div');
        step1.style.cssText = 'margin-bottom:20px';

        const step1Label = document.createElement('div');
        step1Label.textContent = 'PROVIDER';
        step1Label.style.cssText = 'font-size:10px;font-weight:700;letter-spacing:0.8px;color:var(--vscode-descriptionForeground);margin-bottom:8px';
        step1.appendChild(step1Label);

        const providerRow = document.createElement('div');
        providerRow.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px';

        const providerCards: HTMLElement[] = [];
        const providers: Array<{ id: CloudProvider; name: string; sub: string; color: string }> = [
            { id: 'aws', name: 'Amazon Web Services', sub: 'EC2 GPU Instances', color: '#ff9900' },
            { id: 'azure', name: 'Microsoft Azure', sub: 'NC-series VMs', color: '#0078d4' },
        ];

        for (const prov of providers) {
            const card = document.createElement('div');
            card.style.cssText = 'padding:10px 12px;border:1px solid var(--vscode-input-border);border-radius:4px;cursor:pointer;transition:border-color 0.1s,background 0.1s';

            const nameRow = document.createElement('div');
            nameRow.style.cssText = 'display:flex;align-items:center;gap:6px';
            const dot = document.createElement('span');
            dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${prov.color}`;
            nameRow.appendChild(dot);
            const nameEl = document.createElement('span');
            nameEl.textContent = prov.name;
            nameEl.style.cssText = 'font-size:11px;font-weight:600;color:var(--vscode-foreground)';
            nameRow.appendChild(nameEl);
            card.appendChild(nameRow);

            const subEl = document.createElement('div');
            subEl.textContent = prov.sub;
            subEl.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:3px;margin-left:14px';
            card.appendChild(subEl);

            card.addEventListener('click', () => {
                selectedProvider = prov.id;
                providerCards.forEach(c => { c.style.borderColor = 'var(--vscode-input-border)'; c.style.background = 'transparent'; });
                card.style.borderColor = prov.color;
                card.style.background = 'var(--vscode-editor-inactiveSelectionBackground)';
                renderCredentialCheck();
            });
            providerCards.push(card);
            providerRow.appendChild(card);
        }

        providerCards[0].style.borderColor = '#ff9900';
        providerCards[0].style.background = 'var(--vscode-editor-inactiveSelectionBackground)';
        step1.appendChild(providerRow);
        content.appendChild(step1);

        // --- Step 2: Credentials ---
        const step2 = document.createElement('div');
        step2.style.cssText = 'margin-bottom:20px';
        content.appendChild(step2);

        // --- Step 3: Instance + Deploy ---
        const step3 = document.createElement('div');
        content.appendChild(step3);

        const renderCredentialCheck = async () => {
            while (step2.firstChild) { step2.removeChild(step2.firstChild); }
            while (step3.firstChild) { step3.removeChild(step3.firstChild); }
            resolvedCredentials = null;

            const label = document.createElement('div');
            label.textContent = 'AUTHENTICATION';
            label.style.cssText = 'font-size:10px;font-weight:700;letter-spacing:0.8px;color:var(--vscode-descriptionForeground);margin-bottom:8px';
            step2.appendChild(label);

            const statusRow = document.createElement('div');
            statusRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px';

            const spinner = document.createElement('span');
            spinner.textContent = '◌';
            spinner.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground);animation:spin 1s linear infinite';
            statusRow.appendChild(spinner);

            const statusMsg = document.createElement('span');
            statusMsg.textContent = `Detecting ${selectedProvider.toUpperCase()} credentials...`;
            statusMsg.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground)';
            statusRow.appendChild(statusMsg);
            step2.appendChild(statusRow);

            try {
                const detected = await this.cloudCredentialService.detectCredentials(selectedProvider);

                if (detected && detected.valid) {
                    spinner.textContent = '✓';
                    spinner.style.cssText = 'font-size:12px;color:var(--vscode-testing-iconPassed)';
                    spinner.style.animation = 'none';
                    const source = detected.source === 'cli' ? 'CLI environment' : 'stored credentials';
                    statusMsg.textContent = `Authenticated via ${source}`;
                    statusMsg.style.color = 'var(--vscode-testing-iconPassed)';

                    const changeLink = document.createElement('span');
                    changeLink.textContent = '(change)';
                    changeLink.style.cssText = 'font-size:10px;color:var(--vscode-textLink-foreground);cursor:pointer;margin-left:auto';
                    changeLink.addEventListener('click', () => renderCredentialForm(selectedProvider));
                    statusRow.appendChild(changeLink);

                    resolvedCredentials = detected;
                    renderInstanceSelection();
                } else {
                    spinner.textContent = '!';
                    spinner.style.cssText = 'font-size:12px;color:var(--vscode-editorWarning-foreground)';
                    spinner.style.animation = 'none';
                    statusMsg.textContent = 'No credentials found';
                    statusMsg.style.color = 'var(--vscode-editorWarning-foreground)';
                    renderCredentialForm(selectedProvider);
                }
            } catch (err) {
                spinner.textContent = '✗';
                spinner.style.cssText = 'font-size:12px;color:var(--vscode-errorForeground)';
                spinner.style.animation = 'none';
                statusMsg.textContent = `Detection failed: ${err}`;
                statusMsg.style.color = 'var(--vscode-errorForeground)';
                renderCredentialForm(selectedProvider);
            }
        };

        const renderCredentialForm = (provider: CloudProvider) => {
            // Remove any previous form
            const existing = step2.querySelector('.cred-form');
            if (existing) { existing.remove(); }

            const form = document.createElement('div');
            form.className = 'cred-form';
            form.style.cssText = 'margin-top:10px;padding:12px;border:1px solid var(--vscode-input-border);border-radius:4px;display:flex;flex-direction:column;gap:8px';

            const formTitle = document.createElement('div');
            formTitle.textContent = `Enter ${provider.toUpperCase()} Credentials`;
            formTitle.style.cssText = 'font-size:11px;font-weight:600;color:var(--vscode-foreground);margin-bottom:2px';
            form.appendChild(formTitle);

            const fields = provider === 'aws' ? [
                { label: 'Access Key ID', key: 'awsAccessKeyId', placeholder: 'AKIA...', required: true },
                { label: 'Secret Access Key', key: 'awsSecretAccessKey', placeholder: 'Enter secret key', required: true, secret: true },
                { label: 'Region', key: 'awsRegion', placeholder: 'us-east-1', required: false },
            ] : [
                { label: 'Subscription ID', key: 'azureSubscriptionId', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', required: true },
                { label: 'Tenant ID', key: 'azureTenantId', placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', required: true },
                { label: 'Client ID', key: 'azureClientId', placeholder: 'Optional — for service principal', required: false },
                { label: 'Client Secret', key: 'azureClientSecret', placeholder: 'Optional', required: false, secret: true },
                { label: 'Region', key: 'azureRegion', placeholder: 'eastus', required: false },
            ];

            const inputs: Map<string, HTMLInputElement> = new Map();
            for (const field of fields) {
                const row = document.createElement('div');
                const labelEl = document.createElement('label');
                labelEl.style.cssText = 'font-size:10px;font-weight:600;color:var(--vscode-descriptionForeground);display:flex;align-items:center;gap:4px;margin-bottom:3px';
                labelEl.textContent = field.label;
                if (field.required) {
                    const req = document.createElement('span');
                    req.textContent = '*';
                    req.style.color = 'var(--vscode-errorForeground)';
                    labelEl.appendChild(req);
                }
                row.appendChild(labelEl);

                const input = document.createElement('input');
                input.type = field.secret ? 'password' : 'text';
                input.placeholder = field.placeholder;
                input.style.cssText = 'width:100%;padding:5px 8px;background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);color:var(--vscode-input-foreground);font-size:11px;border-radius:3px;box-sizing:border-box';
                row.appendChild(input);
                inputs.set(field.key, input);
                form.appendChild(row);
            }

            const errorMsg = document.createElement('div');
            errorMsg.style.cssText = 'font-size:10px;color:var(--vscode-errorForeground);display:none';
            form.appendChild(errorMsg);

            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;gap:8px;margin-top:4px';

            const validateBtn = document.createElement('button');
            validateBtn.textContent = 'Validate & Continue';
            validateBtn.style.cssText = 'padding:5px 14px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;cursor:pointer;font-size:11px;font-weight:600;border-radius:3px';
            validateBtn.addEventListener('click', async () => {
                errorMsg.style.display = 'none';
                validateBtn.textContent = 'Validating...';
                validateBtn.disabled = true;

                const creds: ICloudCredentials = provider === 'aws' ? {
                    provider: 'aws', valid: true, source: 'manual',
                    awsAccessKeyId: inputs.get('awsAccessKeyId')!.value,
                    awsSecretAccessKey: inputs.get('awsSecretAccessKey')!.value,
                    awsRegion: inputs.get('awsRegion')!.value || 'us-east-1',
                } : {
                    provider: 'azure', valid: true, source: 'manual',
                    azureSubscriptionId: inputs.get('azureSubscriptionId')!.value,
                    azureTenantId: inputs.get('azureTenantId')!.value,
                    azureClientId: inputs.get('azureClientId')!.value || undefined,
                    azureClientSecret: inputs.get('azureClientSecret')!.value || undefined,
                    azureRegion: inputs.get('azureRegion')!.value || 'eastus',
                };

                // Check required fields
                const missing = fields.filter(f => f.required && !inputs.get(f.key)!.value.trim());
                if (missing.length > 0) {
                    errorMsg.textContent = `Required: ${missing.map(f => f.label).join(', ')}`;
                    errorMsg.style.display = 'block';
                    validateBtn.textContent = 'Validate & Continue';
                    validateBtn.disabled = false;
                    return;
                }

                try {
                    const valid = await this.cloudCredentialService.validateCredentials(creds);
                    if (!valid) {
                        errorMsg.textContent = 'Credentials validation failed. Check your keys and try again.';
                        errorMsg.style.display = 'block';
                        validateBtn.textContent = 'Validate & Continue';
                        validateBtn.disabled = false;
                        return;
                    }

                    await this.cloudCredentialService.storeCredentials(creds);
                    resolvedCredentials = creds;
                    form.remove();

                    // Update status display
                    const statusRow2 = step2.querySelector('div') as HTMLElement;
                    if (statusRow2) {
                        statusRow2.replaceChildren();
                        const check = document.createElement('span');
                        check.textContent = '✓';
                        check.style.cssText = 'font-size:12px;color:var(--vscode-testing-iconPassed)';
                        statusRow2.appendChild(check);
                        const msg = document.createElement('span');
                        msg.textContent = 'Credentials saved and verified';
                        msg.style.cssText = 'font-size:11px;color:var(--vscode-testing-iconPassed)';
                        statusRow2.appendChild(msg);
                    }

                    renderInstanceSelection();
                } catch (err) {
                    errorMsg.textContent = `Error: ${err}`;
                    errorMsg.style.display = 'block';
                    validateBtn.textContent = 'Validate & Continue';
                    validateBtn.disabled = false;
                }
            });
            btnRow.appendChild(validateBtn);
            form.appendChild(btnRow);
            step2.appendChild(form);
        };

        const renderInstanceSelection = () => {
            while (step3.firstChild) { step3.removeChild(step3.firstChild); }

            const label = document.createElement('div');
            label.textContent = 'SELECT INSTANCE';
            label.style.cssText = 'font-size:10px;font-weight:700;letter-spacing:0.8px;color:var(--vscode-descriptionForeground);margin-bottom:8px';
            step3.appendChild(label);

            const instances = getRecommendedInstances(selectedProvider, model.size || 8 * 1024 * 1024 * 1024);

            if (instances.length === 0) {
                const warn = document.createElement('div');
                warn.style.cssText = 'padding:12px;background:var(--vscode-inputValidation-warningBackground);border:1px solid var(--vscode-inputValidation-warningBorder);border-radius:4px;font-size:11px;color:var(--vscode-foreground)';
                warn.textContent = `No instances with sufficient VRAM (${requiredVRAM} GB needed). This model may be too large for standard GPU instances. Consider a multi-GPU setup.`;
                step3.appendChild(warn);
                return;
            }

            // Instance table
            const table = document.createElement('div');
            table.style.cssText = 'border:1px solid var(--vscode-input-border);border-radius:4px;overflow:hidden;margin-bottom:16px';

            // Table header
            const thead = document.createElement('div');
            thead.style.cssText = 'display:grid;grid-template-columns:1fr 1.2fr 80px 80px;padding:6px 12px;background:var(--vscode-editor-inactiveSelectionBackground);border-bottom:1px solid var(--vscode-input-border);font-size:10px;font-weight:600;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.5px';
            const cols = ['Instance', 'GPU', 'VRAM', 'Cost'];
            for (const col of cols) {
                const cell = document.createElement('div');
                cell.textContent = col;
                thead.appendChild(cell);
            }
            table.appendChild(thead);

            let selectedInstance = instances[0];
            const rows: HTMLElement[] = [];

            for (let i = 0; i < instances.length; i++) {
                const inst = instances[i];
                const row = document.createElement('div');
                row.style.cssText = 'display:grid;grid-template-columns:1fr 1.2fr 80px 80px;padding:8px 12px;cursor:pointer;transition:background 0.1s;border-bottom:1px solid var(--vscode-input-border);align-items:center';
                if (i === instances.length - 1) { row.style.borderBottom = 'none'; }

                const instCell = document.createElement('div');
                instCell.style.cssText = 'font-size:11px;font-weight:600;color:var(--vscode-foreground)';
                instCell.textContent = inst.instanceType;
                row.appendChild(instCell);

                const gpuCell = document.createElement('div');
                gpuCell.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground)';
                gpuCell.textContent = inst.gpuType;
                row.appendChild(gpuCell);

                const vramCell = document.createElement('div');
                vramCell.style.cssText = 'font-size:11px;color:var(--vscode-foreground)';
                vramCell.textContent = `${inst.gpuMemoryGB} GB`;
                row.appendChild(vramCell);

                const costCell = document.createElement('div');
                costCell.style.cssText = 'font-size:11px;font-weight:600;color:var(--vscode-foreground)';
                costCell.textContent = `$${inst.estimatedCostPerHour.toFixed(2)}/hr`;
                row.appendChild(costCell);

                row.addEventListener('click', () => {
                    selectedInstance = inst;
                    rows.forEach(r => { r.style.background = 'transparent'; });
                    row.style.background = 'var(--vscode-list-activeSelectionBackground)';
                    updateCostAndDeploy(inst);
                });

                row.addEventListener('mouseenter', () => {
                    if (selectedInstance !== inst) { row.style.background = 'var(--vscode-list-hoverBackground)'; }
                });
                row.addEventListener('mouseleave', () => {
                    if (selectedInstance !== inst) { row.style.background = 'transparent'; }
                });

                rows.push(row);
                table.appendChild(row);
            }

            // Select first
            rows[0].style.background = 'var(--vscode-list-activeSelectionBackground)';
            step3.appendChild(table);

            // Recommended badge
            if (instances.length > 1) {
                const rec = document.createElement('div');
                rec.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:-12px;margin-bottom:12px;padding-left:2px';
                rec.textContent = `↑ ${instances.length} instances meet the ${requiredVRAM} GB VRAM requirement. Cheapest option selected.`;
                step3.appendChild(rec);
            }

            // Cost + Deploy section
            const deploySection = document.createElement('div');
            deploySection.style.cssText = 'padding:14px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:6px;margin-bottom:12px';
            step3.appendChild(deploySection);

            const updateCostAndDeploy = (inst: typeof instances[0]) => {
                while (deploySection.firstChild) { deploySection.removeChild(deploySection.firstChild); }

                // Cost breakdown
                const costGrid = document.createElement('div');
                costGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px';

                const hourly = document.createElement('div');
                hourly.appendChild(this._createCostLabel('Hourly'));
                hourly.appendChild(this._createCostValue(`$${inst.estimatedCostPerHour.toFixed(2)}`));
                costGrid.appendChild(hourly);

                const daily = document.createElement('div');
                daily.appendChild(this._createCostLabel('Daily (24hr)'));
                daily.appendChild(this._createCostValue(`$${(inst.estimatedCostPerHour * 24).toFixed(0)}`));
                costGrid.appendChild(daily);

                const monthly = document.createElement('div');
                monthly.appendChild(this._createCostLabel('Monthly'));
                monthly.appendChild(this._createCostValue(`$${(inst.estimatedCostPerHour * 24 * 30).toFixed(0)}`));
                costGrid.appendChild(monthly);

                deploySection.appendChild(costGrid);

                // Info line
                const infoLine = document.createElement('div');
                infoLine.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:14px;padding:6px 8px;background:var(--vscode-input-background);border-radius:3px';
                infoLine.textContent = `Region: ${inst.region} · Endpoint secured with generated API key · Auto-stop available`;
                deploySection.appendChild(infoLine);

                // Deploy button
                const btnRow = document.createElement('div');
                btnRow.style.cssText = 'display:flex;align-items:center;gap:10px';

                const deployBtn = document.createElement('button');
                deployBtn.textContent = `Deploy on ${selectedProvider.toUpperCase()}`;
                deployBtn.style.cssText = 'padding:8px 20px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;cursor:pointer;font-size:12px;font-weight:600;border-radius:4px;transition:opacity 0.1s';
                deployBtn.addEventListener('mouseenter', () => { deployBtn.style.opacity = '0.85'; });
                deployBtn.addEventListener('mouseleave', () => { deployBtn.style.opacity = '1'; });
                deployBtn.addEventListener('click', () => startDeploy(inst, deployBtn));
                btnRow.appendChild(deployBtn);

                const cancelHint = document.createElement('span');
                cancelHint.textContent = 'You can abort at any time';
                cancelHint.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground)';
                btnRow.appendChild(cancelHint);

                deploySection.appendChild(btnRow);
            };

            updateCostAndDeploy(selectedInstance);

            const startDeploy = async (inst: typeof instances[0], btn: HTMLButtonElement) => {
                btn.textContent = 'Initializing...';
                btn.disabled = true;
                btn.style.opacity = '0.6';

                try {
                    const deploymentId = await this.cloudDeploymentService.deploy(model.id, model.name, resolvedCredentials!, inst);
                    // Replace entire content with progress view
                    while (content.firstChild) { content.removeChild(content.firstChild); }
                    renderDeploymentProgress(content, deploymentId);
                } catch (err: unknown) {
                    btn.textContent = `Deploy on ${selectedProvider.toUpperCase()}`;
                    btn.disabled = false;
                    btn.style.opacity = '1';

                    const errDiv = document.createElement('div');
                    errDiv.style.cssText = 'margin-top:10px;padding:8px 12px;background:var(--vscode-inputValidation-errorBackground);border:1px solid var(--vscode-inputValidation-errorBorder);border-radius:4px;font-size:11px;color:var(--vscode-errorForeground)';
                    errDiv.textContent = err instanceof Error ? err.message : String(err);
                    deploySection.appendChild(errDiv);
                    setTimeout(() => errDiv.remove(), 8000);
                }
            };
        };

        const renderDeploymentProgress = (container: HTMLElement, deploymentId: string) => {
            const progressWrap = document.createElement('div');
            progressWrap.style.cssText = 'display:flex;flex-direction:column;gap:16px';

            // Status header
            const statusHeader = document.createElement('div');
            statusHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between';

            const statusLeft = document.createElement('div');
            statusLeft.style.cssText = 'display:flex;align-items:center;gap:8px';

            const statusIcon = document.createElement('div');
            statusIcon.style.cssText = 'width:10px;height:10px;border-radius:50%;background:var(--vscode-progressBar-background);animation:pulse 1.5s ease-in-out infinite';
            statusLeft.appendChild(statusIcon);

            const statusLabel = document.createElement('div');
            statusLabel.textContent = 'Provisioning...';
            statusLabel.style.cssText = 'font-size:13px;font-weight:600;color:var(--vscode-foreground)';
            statusLeft.appendChild(statusLabel);
            statusHeader.appendChild(statusLeft);

            const abortBtn = document.createElement('button');
            abortBtn.textContent = 'Abort';
            abortBtn.style.cssText = 'padding:3px 10px;background:transparent;color:var(--vscode-errorForeground);border:1px solid var(--vscode-errorForeground);cursor:pointer;font-size:10px;border-radius:3px';
            abortBtn.addEventListener('click', async () => {
                abortBtn.disabled = true;
                abortBtn.textContent = 'Aborting...';
                await this.cloudDeploymentService.abort(deploymentId);
            });
            statusHeader.appendChild(abortBtn);
            progressWrap.appendChild(statusHeader);

            // Progress bar
            const progressTrack = document.createElement('div');
            progressTrack.style.cssText = 'width:100%;height:3px;background:var(--vscode-input-border);border-radius:2px;overflow:hidden';
            const progressFill = document.createElement('div');
            progressFill.style.cssText = 'width:10%;height:100%;background:var(--vscode-progressBar-background);transition:width 0.5s ease;border-radius:2px';
            progressTrack.appendChild(progressFill);
            progressWrap.appendChild(progressTrack);

            // Timeline log
            const timeline = document.createElement('div');
            timeline.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto;padding:10px;background:var(--vscode-editor-background);border:1px solid var(--vscode-input-border);border-radius:4px;font-family:var(--vscode-editor-font-family);font-size:11px';

            const addLogEntry = (message: string, type: 'info' | 'success' | 'error' | 'warn' = 'info') => {
                const entry = document.createElement('div');
                entry.style.cssText = 'display:flex;gap:6px;align-items:flex-start';

                const time = document.createElement('span');
                time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                time.style.cssText = 'color:var(--vscode-descriptionForeground);flex-shrink:0;font-size:10px;min-width:60px';
                entry.appendChild(time);

                const msg = document.createElement('span');
                msg.textContent = message;
                const colors: Record<string, string> = {
                    info: 'var(--vscode-foreground)',
                    success: 'var(--vscode-testing-iconPassed)',
                    error: 'var(--vscode-errorForeground)',
                    warn: 'var(--vscode-editorWarning-foreground)',
                };
                msg.style.cssText = `color:${colors[type]};word-break:break-word`;
                entry.appendChild(msg);

                timeline.appendChild(entry);
                timeline.scrollTop = timeline.scrollHeight;
            };

            addLogEntry('Deployment initiated');
            progressWrap.appendChild(timeline);

            // Connection info (shown when ready)
            const connectionInfo = document.createElement('div');
            connectionInfo.style.cssText = 'display:none';
            progressWrap.appendChild(connectionInfo);

            container.appendChild(progressWrap);

            // Listen for progress events
            const disposable = this.cloudDeploymentService.onDeploymentProgress((progress) => {
                if (progress.deploymentId !== deploymentId) { return; }

                addLogEntry(progress.message, progress.status === 'failed' ? 'error' : progress.status === 'running' ? 'success' : 'info');

                if (progress.percentage !== undefined) {
                    progressFill.style.width = `${progress.percentage}%`;
                }

                statusLabel.textContent = this._getStatusDisplayText(progress.status);

                if (progress.status === 'running') {
                    statusIcon.style.background = 'var(--vscode-testing-iconPassed)';
                    statusIcon.style.animation = 'none';
                    abortBtn.style.display = 'none';
                    progressFill.style.width = '100%';
                    progressFill.style.background = 'var(--vscode-testing-iconPassed)';

                    const deployment = this.cloudDeploymentService.getDeployment(deploymentId);
                    this._renderConnectionInfo(connectionInfo, deployment);
                    disposable.dispose();
                } else if (progress.status === 'failed') {
                    statusIcon.style.background = 'var(--vscode-errorForeground)';
                    statusIcon.style.animation = 'none';
                    abortBtn.style.display = 'none';
                    progressFill.style.background = 'var(--vscode-errorForeground)';

                    const deployment = this.cloudDeploymentService.getDeployment(deploymentId);
                    if (deployment?.error) {
                        addLogEntry(deployment.error, 'error');
                    }

                    // Retry button
                    const retryBtn = document.createElement('button');
                    retryBtn.textContent = 'Retry Deployment';
                    retryBtn.style.cssText = 'margin-top:8px;padding:6px 14px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;cursor:pointer;font-size:11px;font-weight:600;border-radius:3px';
                    retryBtn.addEventListener('click', () => {
                        this._showCloudDeployWizard(detailPane, model);
                    });
                    progressWrap.appendChild(retryBtn);
                    disposable.dispose();
                }
            });
        };

        // Initial render
        renderCredentialCheck();
        detailPane.appendChild(wizard);
    }

    private _renderExistingDeployment(container: HTMLElement, deployment: ICloudDeployment, detailPane: HTMLElement): void {
        const section = document.createElement('div');
        section.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:14px';

        // Status badge
        const statusRow = document.createElement('div');
        statusRow.style.cssText = 'display:flex;align-items:center;gap:8px';

        const statusDot = document.createElement('div');
        const dotColor = deployment.status === 'running' ? 'var(--vscode-testing-iconPassed)' :
            deployment.status === 'failed' ? 'var(--vscode-errorForeground)' :
            deployment.status === 'stopped' ? 'var(--vscode-descriptionForeground)' : 'var(--vscode-progressBar-background)';
        statusDot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${dotColor}`;
        statusRow.appendChild(statusDot);

        const statusText = document.createElement('div');
        statusText.textContent = `Active Deployment — ${this._getStatusDisplayText(deployment.status)}`;
        statusText.style.cssText = 'font-size:12px;font-weight:600;color:var(--vscode-foreground)';
        statusRow.appendChild(statusText);
        section.appendChild(statusRow);

        // Details table
        const details = document.createElement('div');
        details.style.cssText = 'padding:12px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:4px;display:flex;flex-direction:column;gap:6px;font-size:11px';

        const addDetailRow = (label: string, value: string) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;justify-content:space-between;align-items:center';
            const l = document.createElement('span');
            l.textContent = label;
            l.style.color = 'var(--vscode-descriptionForeground)';
            row.appendChild(l);
            const v = document.createElement('span');
            v.textContent = value;
            v.style.cssText = 'color:var(--vscode-foreground);font-family:var(--vscode-editor-font-family)';
            row.appendChild(v);
            details.appendChild(row);
        };

        addDetailRow('Provider', deployment.provider.toUpperCase());
        addDetailRow('Instance', deployment.config.instanceType);
        addDetailRow('GPU', `${deployment.config.gpuType} (${deployment.config.gpuMemoryGB} GB)`);
        addDetailRow('Region', deployment.config.region);
        if (deployment.endpoint) { addDetailRow('Endpoint', deployment.endpoint); }
        if (deployment.publicIp) { addDetailRow('IP', deployment.publicIp); }
        addDetailRow('Cost', `$${deployment.config.estimatedCostPerHour.toFixed(2)}/hr`);
        addDetailRow('Created', new Date(deployment.createdAt).toLocaleString());
        if (deployment.error) { addDetailRow('Error', deployment.error); }

        section.appendChild(details);

        // Connection info
        if (deployment.status === 'running' && deployment.endpoint) {
            const connInfo = document.createElement('div');
            connInfo.style.display = 'block';
            this._renderConnectionInfo(connInfo, deployment);
            section.appendChild(connInfo);
        }

        // Action buttons
        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';

        if (deployment.status === 'running') {
            const stopBtn = this._createActionButton('Stop Instance', 'var(--vscode-editorWarning-foreground)', async () => {
                await this.cloudDeploymentService.stop(deployment.id);
                this._showCloudDeployWizard(detailPane, { id: deployment.modelId, name: deployment.modelName, size: 0 });
            });
            actions.appendChild(stopBtn);
        }

        if (deployment.status === 'stopped') {
            const startBtn = this._createActionButton('Start Instance', 'var(--vscode-testing-iconPassed)', async () => {
                await this.cloudDeploymentService.start(deployment.id);
                this._showCloudDeployWizard(detailPane, { id: deployment.modelId, name: deployment.modelName, size: 0 });
            });
            actions.appendChild(startBtn);
        }

        const teardownBtn = this._createActionButton('Terminate & Delete', 'var(--vscode-errorForeground)', async () => {
            await this.cloudDeploymentService.teardown(deployment.id);
            this._showCloudDeployWizard(detailPane, { id: deployment.modelId, name: deployment.modelName, size: 0 });
        });
        actions.appendChild(teardownBtn);

        const newDeployBtn = this._createActionButton('New Deployment', 'var(--vscode-foreground)', () => {
            this._showCloudDeployWizard(detailPane, { id: deployment.modelId, name: deployment.modelName, size: 0 });
        });
        actions.appendChild(newDeployBtn);

        section.appendChild(actions);
        container.appendChild(section);
    }

    private _renderConnectionInfo(container: HTMLElement, deployment: ICloudDeployment | undefined): void {
        if (!deployment) { return; }
        container.style.cssText = 'display:block;padding:14px;border:1px solid var(--vscode-testing-iconPassed);border-radius:4px;background:var(--vscode-editor-inactiveSelectionBackground)';
        container.replaceChildren();

        const title = document.createElement('div');
        title.textContent = 'CONNECTION DETAILS';
        title.style.cssText = 'font-size:10px;font-weight:700;letter-spacing:0.8px;color:var(--vscode-testing-iconPassed);margin-bottom:10px';
        container.appendChild(title);

        const endpoint = deployment.endpoint || `http://${deployment.publicIp}:8000/v1`;

        const codeBlock = document.createElement('div');
        codeBlock.style.cssText = 'padding:8px 10px;background:var(--vscode-editor-background);border-radius:3px;font-family:var(--vscode-editor-font-family);font-size:11px;color:var(--vscode-foreground);margin-bottom:10px;word-break:break-all';
        codeBlock.textContent = endpoint;
        container.appendChild(codeBlock);

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';

        const connectBtn = document.createElement('button');
        connectBtn.textContent = 'Connect to IDE';
        connectBtn.style.cssText = 'padding:5px 12px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;cursor:pointer;font-size:11px;font-weight:600;border-radius:3px';
        connectBtn.addEventListener('click', () => {
            this.voidSettingsService.setSettingOfProvider('vLLM', 'endpoint', endpoint);
            connectBtn.textContent = '✓ Connected';
            connectBtn.disabled = true;
            connectBtn.style.opacity = '0.7';
        });
        btnRow.appendChild(connectBtn);

        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'Copy Endpoint';
        copyBtn.style.cssText = 'padding:5px 12px;background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-input-border);cursor:pointer;font-size:11px;border-radius:3px';
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(endpoint);
            copyBtn.textContent = '✓ Copied';
            setTimeout(() => { copyBtn.textContent = 'Copy Endpoint'; }, 2000);
        });
        btnRow.appendChild(copyBtn);

        container.appendChild(btnRow);
    }

    private _createActionButton(text: string, color: string, onClick: () => void): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.style.cssText = `padding:5px 12px;background:transparent;color:${color};border:1px solid ${color};cursor:pointer;font-size:10px;border-radius:3px;transition:opacity 0.1s`;
        btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.7'; });
        btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; });
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.style.opacity = '0.5';
            btn.textContent = '...';
            try { await onClick(); } catch { btn.textContent = text; btn.disabled = false; btn.style.opacity = '1'; }
        });
        return btn;
    }

    private _createCostLabel(text: string): HTMLElement {
        const el = document.createElement('div');
        el.textContent = text;
        el.style.cssText = 'font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:var(--vscode-descriptionForeground);margin-bottom:2px';
        return el;
    }

    private _createCostValue(text: string): HTMLElement {
        const el = document.createElement('div');
        el.textContent = text;
        el.style.cssText = 'font-size:14px;font-weight:700;color:var(--vscode-foreground)';
        return el;
    }

    private _getStatusDisplayText(status: CloudDeploymentStatus): string {
        const map: Record<CloudDeploymentStatus, string> = {
            'pending': 'Pending',
            'provisioning': 'Provisioning Instance...',
            'deploying-vllm': 'Installing vLLM...',
            'loading-model': 'Loading Model...',
            'running': 'Running',
            'stopping': 'Stopping...',
            'stopped': 'Stopped',
            'terminating': 'Terminating...',
            'terminated': 'Terminated',
            'failed': 'Failed',
        };
        return map[status] || status;
    }

    override dispose(): void {
        this.disposables.dispose();
        super.dispose();
    }
}
