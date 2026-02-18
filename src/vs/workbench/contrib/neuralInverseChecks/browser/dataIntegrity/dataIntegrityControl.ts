/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWebviewElement, IWebviewService } from '../../../webview/browser/webview.js';
import { getWindow } from '../../../../../base/browser/dom.js';
import { IGRCEngineService } from '../engine/services/grcEngineService.js';
import { buildCheckViewHtml } from '../engine/ui/checkViewHtml.js';

export class DataIntegrityControl extends Disposable {

    private webviewElement: IWebviewElement;

    constructor(
        private readonly container: HTMLElement,
        @IWebviewService private readonly webviewService: IWebviewService,
        @IGRCEngineService private readonly grcEngine: IGRCEngineService
    ) {
        super();
        this.webviewElement = this.webviewService.createWebviewElement({
            title: 'Data Integrity Checks',
            options: { enableFindWidget: true, tryRestoreScrollPosition: true, retainContextWhenHidden: true },
            contentOptions: { allowScripts: true },
            extension: undefined
        });
        this.webviewElement.mountTo(this.container, getWindow(this.container));
        this._updateView();
        this._register(this.grcEngine.onDidCheckComplete(() => this._updateView()));
        this._register(this.grcEngine.onDidRulesChange(() => this._updateView()));
        this._register(this.webviewElement.onMessage(msg => this._handleMessage(msg.message)));
    }

    private _handleMessage(msg: any): void {
        if (msg.command === 'toggleRule') { this.grcEngine.toggleRule(msg.ruleId, msg.enabled); }
        else if (msg.command === 'deleteRule') { this.grcEngine.deleteRule(msg.ruleId); }
        else if (msg.command === 'saveRule') { this.grcEngine.saveRule(msg.rule); }
    }

    private _updateView(): void {
        const results = this.grcEngine.getResultsForDomain('data-integrity');
        const rules = this.grcEngine.getRules().filter(r => r.domain === 'data-integrity');
        const activeFrameworks = this.grcEngine.getActiveFrameworks();
        this.webviewElement.setHtml(buildCheckViewHtml({ domain: 'data-integrity', results, rules, activeFrameworks }));
    }

    public layout(width: number, height: number): void {
        this.container.style.width = `${width}px`;
        this.container.style.height = `${height}px`;
    }
    public show(): void { this.container.style.display = 'block'; this._updateView(); }
    public hide(): void { this.container.style.display = 'none'; }
}
