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

export class AgentManagerPart extends Part {

    static readonly ID = 'workbench.parts.agentManager';

    minimumWidth: number = 300;
    maximumWidth: number = Infinity;
    minimumHeight: number = 300;
    maximumHeight: number = Infinity;

    private webviewElement: IWebviewElement | undefined;
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
        // voidContainer.style.display = 'none';
        body.appendChild(voidContainer);


        // State Management

        const updateView = (view: 'manager' | 'chat') => {
            if (view === 'manager') {
                agentContainer.style.display = 'block';
                voidContainer.style.display = 'none';

                styleActive(tabAgents);
                styleInactive(tabChat);
            } else {
                agentContainer.style.display = 'none';
                voidContainer.style.display = 'block';

                styleInactive(tabAgents);
                styleActive(tabChat);
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

        tabsContainer.appendChild(tabChat);
        tabsContainer.appendChild(tabAgents);

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
        }));
        this.disposables.add(this.voidSettingsService.onDidChangeState(() => {
            this.updateModelsList();
        }));
        this.disposables.add(this.workflowAgentService.onDidChangeWorkflows(() => {
            this.updateWorkflowsList();
        }));
        this.disposables.add(this.workflowAgentService.onDidChangeRun(() => {
            this.updateRunsList();
        }));
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

    private handleAgentMessage(data: { agentId: string; input: string }): void {
        const agent = this.agentStore.getAgent(data.agentId);
        if (!agent) {
            this.webviewElement?.postMessage({ command: 'agentResponseError', data: `Agent "${data.agentId}" not found in .inverse/agents/` });
            return;
        }

        this.webviewElement?.postMessage({ command: 'agentRunStarted' });

        this.workflowAgentService.runAgent(agent.id, data.input)
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
            var editModelSel = document.getElementById('edit-agent-model');
            var agentModelVal = agent.model ? (agent.model.providerName + '::' + agent.model.modelName) : '';
            if (editModelSel.options.length === 0) {
                // Models not yet populated — populate from current models
                syncEditModelDropdown();
            }
            editModelSel.value = agentModelVal;
            var eg = document.getElementById('edit-tool-grid');
            if (eg) eg.innerHTML = buildToolGridHtml('edit-tool-check', agent.allowedTools || []);
            hideSettingsMsg();
            chatMsgsEl.innerHTML = '';
            showView('chat');
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
        function sendMessage() {
            var inp = document.getElementById('user-input');
            var text = inp.value.trim();
            if (!activeAgentId || !text) return;
            addMsg(text, 'user');
            vscode.postMessage({ command: 'sendMessage', data: { agentId: activeAgentId, input: text } });
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
            hideSettingsMsg();
            var btn = document.getElementById('save-agent-btn');
            btn.disabled = true; btn.textContent = 'Saving...';
            vscode.postMessage({ command: 'updateAgent', data: {
                id: activeAgentId,
                updates: { name: name, description: desc, systemInstructions: instr, model: modelObj, allowedTools: tools }
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

    override dispose(): void {
        this.disposables.dispose();
        super.dispose();
    }
}
