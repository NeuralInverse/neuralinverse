/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWebviewElement, IWebviewService } from '../../../webview/browser/webview.js';
import { getWindow } from '../../../../../base/browser/dom.js';
import { IGRCEngineService } from '../engine/services/grcEngineService.js';
import { IAuditTrailService } from '../engine/services/auditTrailService.js';
import { IComplianceReportService } from '../engine/services/complianceReportService.js';
import { buildAuditViewHtml } from '../engine/ui/checkViewHtml.js';

export class AuditAndEvidenceControl extends Disposable {

    private webviewElement: IWebviewElement;

    constructor(
        private readonly container: HTMLElement,
        @IWebviewService private readonly webviewService: IWebviewService,
        @IGRCEngineService private readonly grcEngine: IGRCEngineService,
        @IAuditTrailService private readonly auditTrail: IAuditTrailService,
        @IComplianceReportService private readonly complianceReportService: IComplianceReportService
    ) {
        super();
        this.webviewElement = this.webviewService.createWebviewElement({
            title: 'Audit & Evidence',
            options: { enableFindWidget: true, tryRestoreScrollPosition: true, retainContextWhenHidden: true },
            contentOptions: { allowScripts: true },
            extension: undefined
        });
        this.webviewElement.mountTo(this.container, getWindow(this.container));
        this._updateView();
        this._register(this.grcEngine.onDidCheckComplete(() => this._updateView()));
        this._register(this.grcEngine.onDidRulesChange(() => this._updateView()));
        this._register(this.webviewElement.onMessage(async (event) => {
            const msg = event.message as { type: string };
            if (msg.type === 'exportReport') {
                const uri = await this.complianceReportService.exportReport();
                this.webviewElement.postMessage({ type: 'exportResult', kind: 'html', success: !!uri, path: uri?.path });
            } else if (msg.type === 'exportJson') {
                const uri = await this.complianceReportService.exportJson();
                this.webviewElement.postMessage({ type: 'exportResult', kind: 'json', success: !!uri, path: uri?.path });
            }
        }));
    }

    private async _updateView(): Promise<void> {
        const entries = await this.auditTrail.getEntries();
        const availableDates = await this.auditTrail.getAvailableDates();
        const summary = this.grcEngine.getDomainSummary();
        this.webviewElement.setHtml(buildAuditViewHtml(entries, availableDates, summary));
    }

    public layout(width: number, height: number): void {
        this.container.style.width = `${width}px`;
        this.container.style.height = `${height}px`;
    }
    public show(): void { this.container.style.display = 'block'; this._updateView(); }
    public hide(): void { this.container.style.display = 'none'; }
}
