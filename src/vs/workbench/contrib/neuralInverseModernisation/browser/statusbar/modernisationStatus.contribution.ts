/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ModernisationStatusContribution
 *
 * Shows a persistent statusbar item when a modernisation session is active:
 *
 *   $(combine) Modernising  [1/5 Discovery]
 *
 * Clickable — focuses the Compliance Center aux window.
 * Hidden when no session is active.
 */

import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntryAccessor } from '../../../../services/statusbar/browser/statusbar.js';
import { IModernisationSessionService, IModernisationSessionData, STAGE_LABELS } from '../modernisationSessionService.js';
import { IAutonomyService } from '../engine/autonomy/service.js';
import { BatchState } from '../engine/autonomy/impl/autonomyTypes.js';

export class ModernisationStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.modernisationStatus';

	private readonly _entry      = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly _batchEntry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	private _session: IModernisationSessionData;

	constructor(
		@IStatusbarService private readonly _statusbar: IStatusbarService,
		@IModernisationSessionService sessionService: IModernisationSessionService,
		@IAutonomyService autonomyService: IAutonomyService,
	) {
		super();
		this._session = sessionService.session;

		this._renderSession(this._session);
		this._renderBatch(autonomyService.batchState, autonomyService.lastBatchMetrics?.totalProcessed ?? 0);

		this._register(sessionService.onDidChangeSession(s => {
			this._session = s;
			this._renderSession(s);
		}));
		this._register(autonomyService.onBatchStateChanged(e => {
			this._renderBatch(e.next, autonomyService.lastBatchMetrics?.totalProcessed ?? 0);
		}));
		// Update processed count during runs
		this._register(autonomyService.onProgress(ev => {
			if (ev.type === 'unit-completed') {
				this._renderBatch(autonomyService.batchState, ev.data.metrics.totalProcessed);
			}
		}));
	}

	private _renderSession(session: IModernisationSessionData): void {
		if (!session.isActive) {
			this._entry.value = undefined;
			return;
		}

		const stageLabel  = STAGE_LABELS[session.currentStage];
		const sourceNames = session.sources.map(s => s.label || this._basename(s.folderUri)).join(', ') || '?';
		const targetNames = session.targets.map(t => t.label || this._basename(t.folderUri)).join(', ') || '?';

		this._entry.value = this._statusbar.addEntry({
			name:      'NeuralInverse Modernisation',
			text:      `$(combine) Modernising  \u00b7  ${stageLabel}`,
			ariaLabel: `Modernisation active: ${sourceNames} \u2192 ${targetNames}, stage: ${stageLabel}`,
			tooltip:   `NeuralInverse Modernisation Mode\nSources: ${sourceNames}\nTargets: ${targetNames}\nStage: ${stageLabel}\n\nClick to open Compliance Center`,
			command:   'neuralInverse.focusModernisationComplianceCenter',
			kind:      'prominent',
		}, 'neuralInverse.modernisationStatus', StatusbarAlignment.LEFT, 999);
	}

	private _renderBatch(state: BatchState, processed: number): void {
		// Only show when session is active and batch is not idle/completed
		if (!this._session.isActive || state === 'idle' || state === 'completed') {
			this._batchEntry.value = undefined;
			return;
		}

		const icon  = state === 'running'  ? '$(sync~spin)'
		            : state === 'pausing'  ? '$(loading~spin)'
		            : state === 'paused'   ? '$(debug-pause)'
		            : state === 'stopping' ? '$(loading~spin)'
		            : state === 'error'    ? '$(error)'
		            : '$(sync)';

		const label = state === 'running'  ? `Autonomy  \u00b7  ${processed} processed`
		            : state === 'paused'   ? `Autonomy  \u00b7  Paused`
		            : state === 'pausing'  ? `Autonomy  \u00b7  Pausing\u2026`
		            : state === 'stopping' ? `Autonomy  \u00b7  Stopping\u2026`
		            : state === 'error'    ? `Autonomy  \u00b7  Error`
		            : `Autonomy  \u00b7  ${state}`;

		this._batchEntry.value = this._statusbar.addEntry({
			name:      'NeuralInverse Autonomy Batch',
			text:      `${icon} ${label}`,
			ariaLabel: `Autonomy batch ${state}. Units processed: ${processed}.`,
			tooltip:   `Autonomy batch: ${state}\nUnits processed: ${processed}\n\nClick to open Compliance Center`,
			command:   'neuralInverse.focusModernisationComplianceCenter',
			kind:      state === 'error' ? 'warning' : state === 'running' ? 'prominent' : undefined,
		}, 'neuralInverse.autonomyBatchStatus', StatusbarAlignment.LEFT, 998);
	}

	private _basename(uri: string): string {
		return uri.split(/[/\\]/).filter(Boolean).pop() ?? uri;
	}
}
