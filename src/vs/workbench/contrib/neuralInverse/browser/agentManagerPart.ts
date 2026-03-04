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
import { IAgentRegistryService } from '../common/agentRegistryService.js';
import { ILLMMessageService } from '../../void/common/sendLLMMessageService.js';
import { IConvertToLLMMessageService } from '../../void/browser/convertToLLMMessageService.js';
import { mountSidebar } from '../../void/browser/react/out/sidebar-tsx/index.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';

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
        @IAgentRegistryService private readonly agentRegistryService: IAgentRegistryService,
        @ILLMMessageService private readonly llmMessageService: ILLMMessageService,
        @IConvertToLLMMessageService private readonly convertToLLMMessageService: IConvertToLLMMessageService
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

        // Initial agent load
        setTimeout(() => this.updateAgentsList(), 1000); // Give webview a moment to load

        return parent;
    }

    private registerListeners(): void {
        this.disposables.add(this.agentRegistryService.onDidAgentsChange(() => {
            this.updateAgentsList();
        }));
    }

    private updateAgentsList(): void {
        const agents = this.agentRegistryService.getAgents();
        this.webviewElement?.postMessage({ command: 'updateAgents', data: agents });
    }

    private updateWebviewContent(): void {
        if (this.webviewElement) {
            this.webviewElement.setHtml(this.getDashboardHtml());
        }
    }

    private registerWebviewListeners(): void {
        if (!this.webviewElement) { return; }

        this.disposables.add(this.webviewElement.onMessage(e => {
            if (e.message.command === 'sendMessage') {
                this.handleAgentMessage(e.message.data);
            } else if (e.message.command === 'refreshAgents') {
                this.updateAgentsList();
            } else if (e.message.command === 'createAgent') {
                this.handleCreateAgent(e.message.data);
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

    private getMappedTools(agentTools: string[] | undefined): string[] {
        const TOOLS_MAP: { [key: string]: string[] } = {
            'Terminal': ['run_command', 'run_persistent_command', 'open_persistent_terminal', 'kill_persistent_terminal'],
            'FileSystem': ['read_file', 'ls_dir', 'get_dir_tree', 'search_pathnames_only', 'search_for_files', 'search_in_file', 'create_file_or_folder', 'delete_file_or_folder', 'edit_file', 'rewrite_file', 'read_lint_errors'],
            'Browser': ['read_browser_page', 'open_browser_url', 'browser_search'],
            'GitHub': [], // Placeholder for internal tools replacement
            'Jira': [], // Placeholder for internal tools replacement
            'Linear': [], // Placeholder for internal tools replacement
            'Database': [] // Placeholder for internal tools replacement
        };

        if (!agentTools || agentTools.length === 0) return []; // No tools

        const allowed: string[] = [];
        agentTools.forEach(t => {
            const mapped = TOOLS_MAP[t];
            if (mapped) allowed.push(...mapped);
            // Also allow direct builtin tool names if specified? Maybe later.
        });
        return [...new Set(allowed)];
    }

    private async handleAgentMessage(data: { agentName: string; input: string }): Promise<void> {
        const agent = this.agentRegistryService.getAgents().find(a => a.name === data.agentName);
        if (!agent) {
            console.error('Agent not found:', data.agentName);
            return;
        }

        const allowedTools = this.getMappedTools(agent.tools);
        // If allowedTools is empty, we might want to use 'normal' mode, but 'agent' mode handles system prompt better.
        // If allowedTools is empty, prompts.ts will filter all tools out, which is what we want.

        // Generate the robust system message including tools definitions and context
        const systemMessage = await this.convertToLLMMessageService.generateSystemMessage('agent', undefined, allowedTools);

        // Combine agent instructions with the scaffolded system message
        const fullSystemMessage = `AGENT INSTRUCTIONS:\n${agent.systemInstructions}\n\n${systemMessage}`;

        const messages = [
            { role: 'system', content: fullSystemMessage },
            { role: 'user', content: data.input }
        ];

        this.webviewElement?.postMessage({ command: 'agentResponseStart' });

        this.llmMessageService.sendLLMMessage({
            messagesType: 'chatMessages',
            messages: messages as any, // Type check bypass for now
            modelSelection: { providerName: 'openAI', modelName: agent.model }, // Defaulting to OpenAI for now
            logging: { loggingName: 'AgentManager' },
            modelSelectionOptions: undefined,
            overridesOfModel: undefined,
            separateSystemMessage: undefined,
            chatMode: 'agent', // Important to trigger tool use logic in downstream services if any
            onText: (params) => {
                this.webviewElement?.postMessage({ command: 'agentResponseText', data: params.fullText });
            },
            onFinalMessage: (params) => {
                this.webviewElement?.postMessage({ command: 'agentResponseEnd' });
            },
            onError: (params) => {
                this.webviewElement?.postMessage({ command: 'agentResponseError', data: params.message });
            },
            onAbort: () => { },
        });
    }

    private async handleCreateAgent(data: { name: string; model: string; instructions: string; tools: string[] }): Promise<void> {
        try {
            await this.agentRegistryService.createAgent({
                name: data.name,
                model: data.model,
                systemInstructions: data.instructions,
                tools: data.tools
            });
            this.webviewElement?.postMessage({ command: 'agentCreated', data: data.name });
            // The registry service listener will trigger updateAgentsList anyway
        } catch (e) {
            this.webviewElement?.postMessage({ command: 'agentResponseError', data: 'Failed to create agent: ' + (e instanceof Error ? e.message : String(e)) });
        }
    }

    private getDashboardHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Agent</title>
    <style>
        :root {
            --sidebar-width: 250px;
        }
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            margin: 0;
            display: flex;
            height: 100vh;
            overflow: hidden;
        }
        /* Sidebar */
        .sidebar {
            width: var(--sidebar-width);
            background-color: var(--vscode-sideBar-background);
            border-right: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border));
            display: flex;
            flex-direction: column;
        }
        .sidebar-header {
            padding: 12px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
        }
        .sidebar-header h2 {
            font-size: 11px;
            text-transform: uppercase;
            margin: 0;
            font-weight: 600;
            color: var(--vscode-sideBarTitle-foreground);
            letter-spacing: 0.5px;
        }
        .new-agent-btn {
            background: transparent;
            color: var(--vscode-icon-foreground);
            border: none;
            cursor: pointer;
            padding: 4px;
            display: flex;
            align-items: center;
            border-radius: 3px;
        }
        .new-agent-btn:hover {
            background: var(--vscode-toolbar-hoverBackground);
        }
        .agent-list {
            flex: 1;
            overflow-y: auto;
            padding: 8px 0;
        }
        .agent-item {
            padding: 6px 16px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            color: var(--vscode-sideBar-foreground);
            font-size: 13px;
            user-select: none;
        }
        .agent-item:hover {
            background-color: var(--vscode-list-hoverBackground);
            color: var(--vscode-list-hoverForeground);
        }
        .agent-item.selected {
            background-color: var(--vscode-list-activeSelectionBackground);
            color: var(--vscode-list-activeSelectionForeground);
        }
        .agent-icon {
            width: 16px;
            height: 16px;
            background-color: var(--vscode-symbolIcon-classForeground);
            border-radius: 50%;
            display: inline-block;
        }

        /* Main Workspace */
        .workspace {
            flex: 1;
            display: flex;
            flex-direction: column;
            background-color: var(--vscode-editor-background);
            position: relative;
        }
        .view {
            display: none;
            flex-direction: column;
            height: 100%;
            width: 100%;
        }
        .view.active {
            display: flex;
        }

        /* Empty State */
        .empty-state {
            align-items: center;
            justify-content: center;
            color: var(--vscode-descriptionForeground);
            text-align: center;
            height: 100%;
            display: flex;
            flex-direction: column;
        }
        .empty-state h3 { margin-bottom: 8px; font-weight: 500; font-size: 16px; color: var(--vscode-foreground); }
        .empty-state p { font-size: 13px; max-width: 300px; line-height: 1.5; }

        /* Form (Create Agent) */
        .form-container {
            padding: 32px;
            max-width: 600px;
            margin: 0 auto;
            width: 100%;
            box-sizing: border-box;
            overflow-y: auto;
        }
        .form-header { margin-bottom: 24px; }
        .form-header h2 { font-size: 18px; font-weight: 500; margin: 0; color: var(--vscode-foreground); }
        .form-group { margin-bottom: 20px; }
        .form-group label {
            display: block;
            font-size: 11px;
            text-transform: uppercase;
            font-weight: 600;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 6px;
        }
        input, select, textarea {
            width: 100%;
            background: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            padding: 8px;
            border-radius: 3px;
            font-family: inherit;
            font-size: 13px;
            box-sizing: border-box;
        }
        input:focus, select:focus, textarea:focus {
            outline: 1px solid var(--vscode-focusBorder);
            border-color: var(--vscode-focusBorder);
        }
        textarea { resize: vertical; min-height: 100px; }
        .tools-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
            background: var(--vscode-editor-inactiveSelectionBackground);
            padding: 16px;
            border-radius: 4px;
            border: 1px solid var(--vscode-widget-border);
        }
        .tool-checkbox {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            cursor: pointer;
        }
        .tool-checkbox input { width: auto; margin: 0; cursor: pointer; }
        .form-actions {
            display: flex;
            justify-content: flex-end;
            gap: 12px;
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid var(--vscode-widget-border);
        }
        button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 16px;
            border-radius: 2px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
        }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-button-border, transparent); }
        button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }

        /* Agent Details Tabs */
        .agent-tabs {
            display: flex;
            gap: 16px;
            padding: 0 20px;
            border-bottom: 1px solid var(--vscode-widget-border);
            margin-top: 12px;
        }
        .agent-tab {
            padding: 8px 4px;
            font-size: 11px;
            text-transform: uppercase;
            font-weight: 500;
            color: var(--vscode-descriptionForeground);
            cursor: pointer;
            border-bottom: 2px solid transparent;
            user-select: none;
        }
        .agent-tab:hover {
            color: var(--vscode-foreground);
        }
        .agent-tab.active {
            color: var(--vscode-foreground);
            border-bottom-color: var(--vscode-button-background);
        }
        .agent-tab-content {
            display: none;
            flex: 1;
            flex-direction: column;
            overflow: hidden;
        }
        .agent-tab-content.active {
            display: flex;
        }

        /* Chat View / Agent Detail */
        .chat-header {
            padding: 16px 20px 0 20px;
            display: flex;
            flex-direction: column;
            background: var(--vscode-editor-background);
        }
        .chat-header-top {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .chat-header h3 { margin: 0; font-size: 14px; font-weight: 500; color: var(--vscode-foreground); }
        .chat-header .model-badge {
            font-size: 11px;
            background: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 6px;
            border-radius: 10px;
        }
        .chat-messages {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            display: flex;
            flex-direction: column;
            gap: 20px;
        }
        .message { display: flex; flex-direction: column; max-width: 85%; }
        .message.user { align-self: flex-end; }
        .message.agent { align-self: flex-start; }
        .message-bubble {
            padding: 10px 14px;
            border-radius: 6px;
            font-size: 13px;
            line-height: 1.5;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .message.user .message-bubble {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border-bottom-right-radius: 2px;
        }
        .message.agent .message-bubble {
            background-color: var(--vscode-editor-inactiveSelectionBackground);
            color: var(--vscode-editor-foreground);
            border-bottom-left-radius: 2px;
            font-family: var(--vscode-editor-font-family, monospace);
        }

        .chat-input-area {
            padding: 16px 20px;
            border-top: 1px solid var(--vscode-widget-border);
            background: var(--vscode-editor-background);
        }
        .input-container {
            display: flex;
            gap: 10px;
        }
        .input-container input {
            flex: 1;
            margin: 0;
            padding: 10px 14px;
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="sidebar-header">
            <h2>Agents</h2>
            <button class="new-agent-btn" onclick="showView('create')" title="New Agent">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/>
                </svg>
            </button>
        </div>
        <div class="agent-list" id="agent-list">
            <!-- Dynamically populated -->
        </div>
    </div>

    <div class="workspace">
        <!-- Empty State -->
        <div class="view active" id="view-empty">
            <div class="empty-state">
                <h3>Agent Manager</h3>
                <p>Select an agent from the sidebar to start a conversation, or create a new agent to replace internal tools.</p>
                <button onclick="showView('create')" style="margin-top: 16px;">Create New Agent</button>
            </div>
        </div>

        <!-- Create Agent -->
        <div class="view" id="view-create">
            <div class="form-container">
                <div class="form-header">
                    <h2>Create New Agent</h2>
                </div>
                <div class="form-group">
                    <label>Name</label>
                    <input type="text" id="new-agent-name" placeholder="e.g. JiraManager, DB_Assistant...">
                </div>
                <div class="form-group">
                    <label>Model</label>
                    <select id="new-agent-model">
                        <option value="gpt-4o">GPT-4o</option>
                        <option value="claude-3-5-sonnet-20240620">Claude 3.5 Sonnet</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>System Instructions</label>
                    <textarea id="new-agent-instructions" placeholder="You are a helpful assistant specialized in..."></textarea>
                </div>
                <div class="form-group">
                    <label>Internal Tools</label>
                    <div class="tools-grid">
                        <label class="tool-checkbox"><input type="checkbox" value="FileSystem" class="tool-check"> FileSystem</label>
                        <label class="tool-checkbox"><input type="checkbox" value="Terminal" class="tool-check"> Terminal</label>
                        <label class="tool-checkbox"><input type="checkbox" value="Browser" class="tool-check"> Browser</label>
                        <label class="tool-checkbox"><input type="checkbox" value="GitHub" class="tool-check"> GitHub</label>
                        <label class="tool-checkbox"><input type="checkbox" value="Jira" class="tool-check"> Jira</label>
                        <label class="tool-checkbox"><input type="checkbox" value="Linear" class="tool-check"> Linear</label>
                        <label class="tool-checkbox"><input type="checkbox" value="Database" class="tool-check"> Database connection</label>
                    </div>
                </div>
                <div class="form-actions">
                    <button class="secondary" onclick="showView('empty')">Cancel</button>
                    <button onclick="createAgent()">Create Agent</button>
                </div>
            </div>
        </div>

        <!-- Agent Detail View -->
        <div class="view" id="view-agent-detail">
            <div class="chat-header">
                <div class="chat-header-top">
                    <div class="agent-icon" style="background-color: var(--vscode-symbolIcon-eventForeground)"></div>
                    <h3 id="chat-header-name">Agent Name</h3>
                    <span class="model-badge" id="chat-header-model">gpt-4o</span>
                </div>
                <!-- Agentic Tabs -->
                <div class="agent-tabs">
                    <div class="agent-tab active" onclick="switchAgentTab('chat')" id="tab-nav-chat">Chat</div>
                    <div class="agent-tab" onclick="switchAgentTab('workflow')" id="tab-nav-workflow">Agentic Workflow</div>
                    <div class="agent-tab" onclick="switchAgentTab('knowledge')" id="tab-nav-knowledge">Knowledge Base</div>
                    <div class="agent-tab" onclick="switchAgentTab('tools')" id="tab-nav-tools">Tools Config</div>
                    <div class="agent-tab" onclick="switchAgentTab('integrations')" id="tab-nav-integrations">Integrations</div>
                    <div class="agent-tab" onclick="switchAgentTab('security')" id="tab-nav-security">Security & Access</div>
                    <div class="agent-tab" onclick="switchAgentTab('audit')" id="tab-nav-audit">Audit Logs</div>
                    <div class="agent-tab" onclick="switchAgentTab('analytics')" id="tab-nav-analytics">Analytics</div>
                </div>
            </div>

            <!-- Tab: Chat -->
            <div class="agent-tab-content active" id="tab-content-chat">
                <div class="chat-messages" id="chat-messages">
                    <!-- Messages go here -->
                </div>
                <div class="chat-input-area">
                    <div class="input-container">
                        <input type="text" id="user-input" placeholder="Ask the agent to do something..." onkeydown="if(event.key === 'Enter') sendMessage()" />
                        <button onclick="sendMessage()">Send</button>
                    </div>
                </div>
            </div>

            <!-- Placeholder Tabs -->
            <div class="agent-tab-content" id="tab-content-workflow">
                <div class="empty-state">
                    <h3>Agentic Workflow</h3>
                    <p>Define multi-step autonomous workflows and triggers (Coming Soon)</p>
                </div>
            </div>
            <div class="agent-tab-content" id="tab-content-knowledge">
                <div class="empty-state">
                    <h3>Knowledge Base</h3>
                    <p>Upload documents, API specs, and connect Vector Databases to ground the agent (Coming Soon)</p>
                </div>
            </div>
            <div class="agent-tab-content" id="tab-content-tools">
                <div class="empty-state">
                    <h3>Tools Config</h3>
                    <p>Configure advanced parameters for attached tools (Coming Soon)</p>
                </div>
            </div>
            <div class="agent-tab-content" id="tab-content-integrations">
                <div class="empty-state">
                    <h3>Integrations</h3>
                    <p>Connect and authenticate with external services (Coming Soon)</p>
                </div>
            </div>
            <div class="agent-tab-content" id="tab-content-security">
                <div class="empty-state">
                    <h3>Security & Access</h3>
                    <p>Configure role-based access control, sandboxing limits, and review human-in-the-loop policies (Coming Soon)</p>
                </div>
            </div>
            <div class="agent-tab-content" id="tab-content-audit">
                <div class="empty-state">
                    <h3>Audit Logs</h3>
                    <p>Review all actions and tool calls made by this agent (Coming Soon)</p>
                </div>
            </div>
            <div class="agent-tab-content" id="tab-content-analytics">
                <div class="empty-state">
                    <h3>Performance Analytics</h3>
                    <p>Monitor token usage, cost projections, latency, and success rates for this agent (Coming Soon)</p>
                </div>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        let currentAgents = [];
        let activeAgentName = null;
        let activeMessageBubble = null;

        const agentListEl = document.getElementById('agent-list');
        const chatMessagesEl = document.getElementById('chat-messages');

        function showView(viewName) {
            document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
            // Map "chat" back to the new "agent-detail" view
            const actualView = viewName === 'chat' ? 'agent-detail' : viewName;
            document.getElementById('view-' + actualView).classList.add('active');

            if (actualView !== 'agent-detail') {
                activeAgentName = null;
                renderAgentList(); // clear selection
            } else if (viewName === 'chat') {
                switchAgentTab('chat');
            }
        }

        function switchAgentTab(tabName) {
            document.querySelectorAll('.agent-tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.agent-tab-content').forEach(c => c.classList.remove('active'));

            document.getElementById('tab-nav-' + tabName).classList.add('active');
            document.getElementById('tab-content-' + tabName).classList.add('active');
        }

        function selectAgent(name) {
            activeAgentName = name;
            const agent = currentAgents.find(a => a.name === name);
            if (agent) {
                document.getElementById('chat-header-name').textContent = agent.name;
                document.getElementById('chat-header-model').textContent = agent.model;
                chatMessagesEl.innerHTML = ''; // clear chat on select
                showView('chat');
                renderAgentList(); // update selection visual
            }
        }

        function renderAgentList() {
            agentListEl.innerHTML = '';
            if (currentAgents.length === 0) {
                const emptyEl = document.createElement('div');
                emptyEl.style.padding = '12px 16px';
                emptyEl.style.color = 'var(--vscode-descriptionForeground)';
                emptyEl.style.fontSize = '12px';
                emptyEl.textContent = 'No agents configured.';
                agentListEl.appendChild(emptyEl);
                return;
            }

            currentAgents.forEach(agent => {
                const el = document.createElement('div');
                el.className = 'agent-item' + (activeAgentName === agent.name ? ' selected' : '');

                // Color based on name hash (simple)
                const hue = agent.name.split('').reduce((a,b)=>a+b.charCodeAt(0),0) % 360;

                el.innerHTML = '<div class="agent-icon" style="background-color: hsl(' + hue + ', 70%, 60%)"></div><span>' + agent.name + '</span>';
                el.onclick = () => selectAgent(agent.name);
                agentListEl.appendChild(el);
            });
        }

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'updateAgents':
                    currentAgents = message.data || [];
                    renderAgentList();
                    if (activeAgentName && !currentAgents.find(a => a.name === activeAgentName)) {
                        showView('empty');
                    } else if (activeAgentName) {
                        // refresh data
                        const agent = currentAgents.find(a => a.name === activeAgentName);
                        document.getElementById('chat-header-model').textContent = agent.model;
                    }
                    break;
                case 'agentResponseStart':
                    activeMessageBubble = addMessage('', 'agent');
                    break;
                case 'agentResponseText':
                    if (activeMessageBubble) {
                        activeMessageBubble.textContent = message.data;
                        chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
                    }
                    break;
                 case 'agentResponseError':
                    addMessage('Error: ' + message.data, 'agent');
                    activeMessageBubble = null;
                    break;
                case 'agentResponseEnd':
                    activeMessageBubble = null;
                    break;
                case 'agentCreated':
                    currentAgents.push({name: message.data, model: 'Unknown'}); // Will get replaced by updateAgents soon
                    selectAgent(message.data);
                    // clear form
                    document.getElementById('new-agent-name').value = '';
                    document.getElementById('new-agent-instructions').value = '';
                    document.querySelectorAll('.tool-check').forEach(cb => cb.checked = false);
                    break;
            }
        });

        function addMessage(text, sender) {
            const msgEl = document.createElement('div');
            msgEl.className = 'message ' + sender;
            const bubbleEl = document.createElement('div');
            bubbleEl.className = 'message-bubble';
            bubbleEl.textContent = text;
            msgEl.appendChild(bubbleEl);
            chatMessagesEl.appendChild(msgEl);
            chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
            return bubbleEl;
        }

        function sendMessage() {
            const inputEl = document.getElementById('user-input');
            const input = inputEl.value.trim();
            if (!activeAgentName) return;
            if (!input) return;

            addMessage(input, 'user');
            vscode.postMessage({ command: 'sendMessage', data: { agentName: activeAgentName, input } });
            inputEl.value = '';
        }

        function createAgent() {
            const name = document.getElementById('new-agent-name').value.trim();
            const model = document.getElementById('new-agent-model').value;
            const instructions = document.getElementById('new-agent-instructions').value.trim();

            const tools = [];
            document.querySelectorAll('.tool-check:checked').forEach(cb => tools.push(cb.value));

            if (!name || !instructions) return;

            vscode.postMessage({
                command: 'createAgent',
                data: { name, model, instructions, tools }
            });
        }

        // Request initial agents
        vscode.postMessage({ command: 'refreshAgents' });
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
