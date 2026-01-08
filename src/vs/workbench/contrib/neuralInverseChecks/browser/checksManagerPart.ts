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
// import { IAgentRegistryService } from '../common/agentRegistryService.js'; // Checks might use a different service or none for now
import { mountSidebar } from '../../void/browser/react/out/sidebar-tsx/index.js'; // Reusing Void Sidebar for 'Chat' tab
import { toDisposable } from '../../../../base/common/lifecycle.js';

export class ChecksManagerPart extends Part {

	static readonly ID = 'workbench.parts.checksManager';

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
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super(ChecksManagerPart.ID, { hasTitle: false }, themeService, storageService, layoutService);
		// this.registerListeners();
	}

	override createContentArea(parent: HTMLElement): HTMLElement | undefined {
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

		// VIEW 1: Checks Webview
		const checksContainer = document.createElement('div');
		checksContainer.style.width = '100%';
		checksContainer.style.height = '100%';
		body.appendChild(checksContainer);

		// VIEW 2: Void Sidebar (Shared Chat)
		const voidContainer = document.createElement('div');
		voidContainer.style.width = '100%';
		voidContainer.style.height = '100%';
		body.appendChild(voidContainer);


		// State Management

		const updateView = (view: 'manager' | 'chat') => {
			if (view === 'manager') {
				checksContainer.style.display = 'block';
				voidContainer.style.display = 'none';

				styleActive(tabChecks);
				styleInactive(tabChat);
			} else {
				checksContainer.style.display = 'none';
				voidContainer.style.display = 'block';

				styleInactive(tabChecks);
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
		const tabChecks = createTab('Checks', () => updateView('manager'));

		tabsContainer.appendChild(tabChecks);
		tabsContainer.appendChild(tabChat);

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

		this.updateWebviewContent();
		// this.registerWebviewListeners();
		// this.registerConfigurationListeners();

		return parent;
	}

	private updateWebviewContent(): void {
		if (this.webviewElement) {
			this.webviewElement.setHtml(this.getDashboardHtml());
		}
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
            <h1>Checks</h1>
            <p>Checks manager content goes here.</p>
        </body>
        </html>`;
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
	}

	toJSON(): object {
		return {
			type: ChecksManagerPart.ID
		};
	}

	override dispose(): void {
		this.disposables.dispose();
		super.dispose();
	}
}
