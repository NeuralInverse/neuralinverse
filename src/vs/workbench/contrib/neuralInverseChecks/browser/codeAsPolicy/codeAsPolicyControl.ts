/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWebviewService, IWebviewElement } from '../../../webview/browser/webview.js';
import { getWindow } from '../../../../../base/browser/dom.js';
import { IGRCEngineService } from '../engine/services/grcEngineService.js';
import { buildCheckViewHtml } from '../engine/ui/checkViewHtml.js';

export class CodeAsPolicyControl extends Disposable {

    private readonly container: HTMLElement;
    private webviewElement: IWebviewElement | undefined;

    constructor(
        parent: HTMLElement,
        @IWebviewService private readonly webviewService: IWebviewService,
        @IGRCEngineService private readonly grcEngine: IGRCEngineService
    ) {
        super();
        this.container = document.createElement('div');
        this.container.style.width = '100%';
        this.container.style.height = '100%';
        this.container.style.display = 'none';
        parent.appendChild(this.container);
        this._initWebview();
        this._register(this.grcEngine.onDidCheckComplete(() => this._updateView()));
        this._register(this.grcEngine.onDidRulesChange(() => this._updateView()));
    }

    private _initWebview(): void {
        this.webviewElement = this.webviewService.createWebviewElement({
            title: 'Code as Policy',
            options: { enableFindWidget: true, tryRestoreScrollPosition: true, retainContextWhenHidden: true },
            contentOptions: { allowScripts: true },
            extension: undefined
        });
        this.webviewElement.mountTo(this.container, getWindow(this.container));
        this._register(this.webviewElement.onMessage(msg => this._handleMessage(msg.message)));
        this._updateView();
    }

    private _handleMessage(msg: any): void {
        if (msg.command === 'toggleRule') { this.grcEngine.toggleRule(msg.ruleId, msg.enabled); }
        else if (msg.command === 'deleteRule') { this.grcEngine.deleteRule(msg.ruleId); }
        else if (msg.command === 'saveRule') { this.grcEngine.saveRule(msg.rule); }
    }

    private _updateView(): void {
        if (!this.webviewElement) { return; }
        const results = this.grcEngine.getResultsForDomain('policy');
        const rules = this.grcEngine.getRules().filter(r => r.domain === 'policy');
        const activeFrameworks = this.grcEngine.getActiveFrameworks();
        this.webviewElement.setHtml(buildCheckViewHtml({ domain: 'policy', results, rules, activeFrameworks }));
    }

    layout(width: number, height: number) {
        this.container.style.width = `${width}px`;
        this.container.style.height = `${height}px`;
    }
    show() { this.container.style.display = 'block'; this._updateView(); }
    hide() { this.container.style.display = 'none'; }
}
