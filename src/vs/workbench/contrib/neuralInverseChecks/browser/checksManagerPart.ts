/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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

export class ChecksManagerPart extends Part implements IHorizontalSashLayoutProvider {

    static readonly ID = 'workbench.parts.checksManager';

    minimumWidth: number = 300;
    maximumWidth: number = Infinity;
    minimumHeight: number = 300;
    maximumHeight: number = Infinity;

    private webviewElement: IWebviewElement | undefined;
    private nanoAgentsControl: NanoAgentsControl | undefined;
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
    ) {
        super(ChecksManagerPart.ID, { hasTitle: false }, themeService, storageService, layoutService);
    }

    override createContentArea(parent: HTMLElement): HTMLElement | undefined {
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

        // Left Spacer (to balance layout if needed, or just empty)
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


        // VIEW 3: Void Sidebar (Shared Chat)
        const voidContainer = document.createElement('div');
        voidContainer.style.width = '100%';
        voidContainer.style.height = '100%';
        body.appendChild(voidContainer);

        // Terminal Container (Appended last to be at bottom)
        body.appendChild(this.terminalContainer);


        // Sidebar Navigation Logic
        const sidebarItems: Record<string, HTMLElement> = {};

        const updateView = (view: 'manager' | 'nano' | 'chat') => {
            // Hide all first
            checksContainer.style.display = 'none';
            voidContainer.style.display = 'none';
            nanoContainer.style.display = 'none';
            this.nanoAgentsControl?.hide();

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
            } else {
                voidContainer.style.display = 'block';
            }
        };

        const createSidebarItem = (text: string, viewId: 'manager' | 'nano' | 'chat') => {
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
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Checks</title>
            <style>
                body {
                    font-family: var(--vscode-font-family);
                    font-size: var(--vscode-font-size);
                    padding: 20px;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                    margin: 0;
                }
                h1 {
                    font-size: 1.2em;
                    font-weight: 500;
                    margin: 0;
                    color: var(--vscode-foreground);
                }
            </style>
        </head>
        <body>
            <h1>Checks Manager</h1>
        </body>
        </html>`;
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

