/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *
 *  Licensed under the Business Source License 1.1 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at https://mariadb.com/bsl11
 *
 *  Change Date: 2029-07-14
 *  Change License: GNU Affero General Public License v3.0
 *
 *  Use of this software in production requires a commercial license from Neural Inverse Inc.
 *  Contact (code): github@neuralinverse.com | Contact (sales): sales@neuralinverse.com
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWebviewElement, IWebviewService } from '../../../webview/browser/webview.js';
import { getWindow } from '../../../../../base/browser/dom.js';
import { IGRCEngineService } from '../engine/services/grcEngineService.js';
import { buildCheckViewHtml } from '../engine/ui/checkViewHtml.js';

export class FailSafeDefaultsControl extends Disposable {

    private webviewElement: IWebviewElement;

    constructor(
        private readonly container: HTMLElement,
        @IWebviewService private readonly webviewService: IWebviewService,
        @IGRCEngineService private readonly grcEngine: IGRCEngineService
    ) {
        super();
        this.webviewElement = this.webviewService.createWebviewElement({
            title: 'Fail-Safe Defaults',
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
        const results = this.grcEngine.getResultsForDomain('fail-safe');
        const rules = this.grcEngine.getRules().filter(r => r.domain === 'fail-safe');
        const activeFrameworks = this.grcEngine.getActiveFrameworks();
        this.webviewElement.setHtml(buildCheckViewHtml({ domain: 'fail-safe', results, rules, activeFrameworks }));
    }

    public layout(width: number, height: number): void {
        this.container.style.width = `${width}px`;
        this.container.style.height = `${height}px`;
    }
    public show(): void { this.container.style.display = 'block'; this._updateView(); }
    public hide(): void { this.container.style.display = 'none'; }
}
