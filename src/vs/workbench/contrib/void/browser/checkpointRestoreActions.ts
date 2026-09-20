/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Task A3: the Restore entry point for workspace checkpoints. Content
// checkpoints are created at the toolsService callTool boundary whenever a
// builtin tool writes a file (chat sidebar and native chat bridge alike);
// this action lists them and rewinds the workspace to the chosen one.

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { ICheckpointService, ICheckpoint } from '../../neuralInverseFirmware/browser/engine/projectConfig/checkpointService.js';

interface CheckpointPickItem extends IQuickPickItem {
	checkpoint: ICheckpoint;
}

class RestoreCheckpointAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.checkpoint.restore',
			title: localize2('neuralInverse.checkpoint.restore', 'Neural Inverse: Restore Workspace Checkpoint…'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const checkpointService = accessor.get(ICheckpointService);
		const quickInput = accessor.get(IQuickInputService);
		const notificationService = accessor.get(INotificationService);

		await checkpointService.ready();
		const checkpoints = checkpointService.listCheckpoints();
		if (checkpoints.length === 0) {
			notificationService.info(localize('neuralInverse.checkpoint.none', "No checkpoints yet. Checkpoints are created automatically when an agent edits files."));
			return;
		}

		const picks: CheckpointPickItem[] = checkpoints.map(cp => ({
			label: cp.label,
			description: localize('neuralInverse.checkpoint.fileCount', "{0} file{1}", cp.filesChanged.length, cp.filesChanged.length === 1 ? '' : 's'),
			detail: `${new Date(cp.timestamp).toLocaleString()} — ${cp.filesChanged.slice(0, 4).join(', ')}${cp.filesChanged.length > 4 ? ', …' : ''}`,
			checkpoint: cp,
		}));

		const pick = await quickInput.pick<CheckpointPickItem>(picks, {
			placeHolder: localize('neuralInverse.checkpoint.placeHolder', "Choose a checkpoint to restore the workspace files to"),
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!pick) { return; }

		const chosen = pick.checkpoint;
		try {
			await checkpointService.rewindTo(chosen.id);
			notificationService.info(localize('neuralInverse.checkpoint.restored', "Restored {0} file{1} to the checkpoint from {2}.", chosen.filesChanged.length, chosen.filesChanged.length === 1 ? '' : 's', new Date(chosen.timestamp).toLocaleTimeString()));
		} catch (e) {
			notificationService.error(localize('neuralInverse.checkpoint.restoreFailed', "Restoring the checkpoint failed: {0}", (e as Error).message));
		}
	}
}

registerAction2(RestoreCheckpointAction);
