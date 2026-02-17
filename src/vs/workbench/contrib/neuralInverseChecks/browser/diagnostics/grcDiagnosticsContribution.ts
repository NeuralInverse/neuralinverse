/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IMarkerService, IMarkerData, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';
import { IGRCEngineService } from '../engine/grcEngineService.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { GRCSeverity } from '../engine/grcTypes.js';
import { isCodeEditor } from '../../../../../editor/browser/editorBrowser.js';

const GRC_MARKER_OWNER = 'neuralInverse.grc';
const DEBOUNCE_MS = 800;

/**
 * Workbench contribution that provides real-time GRC diagnostics in the editor.
 *
 * Listens to:
 * - Active editor changes
 * - Model content changes (debounced)
 * - GRC rule changes
 *
 * On each trigger:
 * - Runs grcEngine.evaluateDocument() on the active model
 * - Converts ICheckResult[] to IMarkerData[]
 * - Pushes markers to IMarkerService (squiggly underlines + Problems panel)
 * - Also populates engine cache for the Checks panel sidebar
 */
export class GRCDiagnosticsContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.grcDiagnostics';

	private _debounceTimer: any;
	private _modelListeners = this._register(new DisposableStore());

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IMarkerService private readonly markerService: IMarkerService,
		@IGRCEngineService private readonly grcEngine: IGRCEngineService
	) {
		super();

		// Run on active editor change
		this._register(this.editorService.onDidActiveEditorChange(() => {
			this._onEditorChange();
		}));

		// Re-run when rules change
		this._register(this.grcEngine.onDidRulesChange(() => {
			this._runCheck();
		}));

		// Initial check
		this._onEditorChange();
	}

	private _onEditorChange(): void {
		// Clear previous model listeners
		this._modelListeners.clear();

		const model = this._getActiveModel();
		if (!model) {
			return;
		}

		// Listen to content changes on this model (debounced)
		this._modelListeners.add(model.onDidChangeContent(() => {
			this._scheduleCheck();
		}));

		// Run immediately for the newly focused editor
		this._runCheck();
	}

	private _scheduleCheck(): void {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
		}
		this._debounceTimer = setTimeout(() => {
			this._runCheck();
		}, DEBOUNCE_MS);
	}

	private _runCheck(): void {
		const model = this._getActiveModel();
		if (!model) {
			return;
		}

		// Evaluate the document
		const results = this.grcEngine.evaluateDocument(model);

		// Convert to markers for inline highlights + Problems panel
		const markers: IMarkerData[] = results.map(r => ({
			severity: this._toMarkerSeverity(r.severity),
			message: r.message + (r.fix ? `\nFix: ${r.fix}` : ''),
			startLineNumber: r.line,
			startColumn: r.column,
			endLineNumber: r.endLine,
			endColumn: r.endColumn,
			source: 'Neural Inverse GRC',
			code: r.ruleId
		}));

		// Push to marker service (inline squiggly underlines + Problems panel)
		this.markerService.changeOne(GRC_MARKER_OWNER, model.uri, markers);
	}

	private _toMarkerSeverity(severity: GRCSeverity): MarkerSeverity {
		switch (severity) {
			case 'error': return MarkerSeverity.Error;
			case 'warning': return MarkerSeverity.Warning;
			case 'info': return MarkerSeverity.Info;
		}
	}

	private _getActiveModel(): ITextModel | undefined {
		const editor = this.editorService.activeTextEditorControl;
		if (editor && isCodeEditor(editor)) {
			return editor.getModel() ?? undefined;
		}
		return undefined;
	}

	override dispose(): void {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
		}
		super.dispose();
	}
}
