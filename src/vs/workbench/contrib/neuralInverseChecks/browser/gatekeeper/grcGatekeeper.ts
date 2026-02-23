/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ITextFileService, ITextFileSaveParticipant, ITextFileEditorModel, ITextFileSaveParticipantContext } from '../../../../services/textfile/common/textfiles.js';
import { IProgress, IProgressStep } from '../../../../../platform/progress/common/progress.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { IGRCEngineService } from '../engine/services/grcEngineService.js';
import { IEnclaveEnvironmentService } from '../../../neuralInverseEnclave/common/services/environment/enclaveEnvironmentService.js';
import { toDisplaySeverity } from '../engine/types/grcTypes.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { localize } from '../../../../../nls.js';

export class GRCGatekeeper extends Disposable implements IWorkbenchContribution, ITextFileSaveParticipant {

	constructor(
		@ITextFileService private readonly textFileService: ITextFileService,
		@IGRCEngineService private readonly grcEngine: IGRCEngineService,
		@IEnclaveEnvironmentService private readonly enclaveEnv: IEnclaveEnvironmentService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super();
		this._register(this.textFileService.files.addSaveParticipant(this));
	}

	async participate(
		model: ITextFileEditorModel,
		context: ITextFileSaveParticipantContext,
		progress: IProgress<IProgressStep>,
		token: CancellationToken
	): Promise<void> {

		const mode = this.enclaveEnv.mode;

		// OPEN Mode: Never block
		if (mode === 'open') {
			return;
		}

		// Run checks
		const textModel = model.textEditorModel;
		if (!textModel) {
			return;
		}

		// We run checks synchronously here to ensure we catch everything before save
		// The engine caches results, so this is efficient if already run by diagnostics
		const results = this.grcEngine.evaluateDocument(textModel);

		let blockingViolations = [];

		if (mode === 'standard') {
			// STANDARD Mode: Block only 'critical' / 'blocker' severity OR explicit blocking behavior
			blockingViolations = results.filter(r => {
				const isCritical = r.severity === 'critical' || r.severity === 'blocker';
				const explicitBlock = r.blockingBehavior?.blocksDeploy === true || r.blockingBehavior?.blocksCommit === true; // Reusing existing flags for now
				return isCritical || explicitBlock;
			});
		}
		else if (mode === 'locked_down') {
			// LOCKED DOWN Mode: Block ALL Errors
			blockingViolations = results.filter(r => {
				return toDisplaySeverity(r.severity) === 'error';
			});
		}

		if (blockingViolations.length > 0) {
			const count = blockingViolations.length;
			const message = localize(
				'grc.saveBlocked',
				"Save blocked by GRC {0} Mode: {1} critical violation{2} found.",
				mode.toUpperCase(),
				count,
				count === 1 ? '' : 's'
			);

			this.notificationService.notify({
				severity: Severity.Error,
				message: message,
				source: 'Neural Inverse GRC'
			});

			// Throwing error cancels the save
			throw new Error(message);
		}
	}
}
