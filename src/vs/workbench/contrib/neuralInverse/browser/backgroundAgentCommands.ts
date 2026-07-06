/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IBackgroundAgentService } from './backgroundAgentService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

// ─── Spawn Background Agent ──────────────────────────────────────────────────

class SpawnBackgroundAgentAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.bgAgent.spawn',
			title: { value: 'NI: Spawn Background Agent', original: 'NI: Spawn Background Agent' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const bgService = accessor.get(IBackgroundAgentService);
		const notificationService = accessor.get(INotificationService);

		const title = await quickInput.input({
			prompt: 'Background agent task title',
			placeHolder: 'e.g. Add unit tests for auth module',
			ignoreFocusLost: true,
		});
		if (!title) return;

		const description = await quickInput.input({
			prompt: 'Describe what the agent should do',
			placeHolder: 'Write comprehensive unit tests for src/auth/ covering edge cases',
			ignoreFocusLost: true,
		});
		const task = bgService.spawn({ title, description: description || title });
		notificationService.info(`Background agent spawned: ${task.branchName}`);
	}
}

// ─── Cancel Background Agent ─────────────────────────────────────────────────

class CancelBackgroundAgentAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.bgAgent.cancel',
			title: { value: 'NI: Cancel Background Agent', original: 'NI: Cancel Background Agent' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const bgService = accessor.get(IBackgroundAgentService);

		const activeTasks = [...bgService.tasks.values()]
			.filter(t => t.status === 'running' || t.status === 'queued' || t.status === 'branching');

		if (activeTasks.length === 0) {
			accessor.get(INotificationService).info('No active background agents.');
			return;
		}

		const pick = await quickInput.pick(
			activeTasks.map(t => ({ label: t.request.title, description: `[${t.status}] ${t.branchName}`, id: t.id })),
			{ placeHolder: 'Select agent to cancel' }
		);

		if (pick) {
			bgService.cancel((pick as any).id);
		}
	}
}

// ─── View Diff ───────────────────────────────────────────────────────────────

class ViewBackgroundAgentDiffAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.bgAgent.viewDiff',
			title: { value: 'NI: View Background Agent Diff', original: 'NI: View Background Agent Diff' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const bgService = accessor.get(IBackgroundAgentService);
		const editorService = accessor.get(IEditorService);
		const notificationService = accessor.get(INotificationService);

		const completedTasks = [...bgService.tasks.values()]
			.filter(t => t.status === 'completed' && t.commits.length > 0);

		if (completedTasks.length === 0) {
			notificationService.info('No completed background agents with changes.');
			return;
		}

		const pick = await quickInput.pick(
			completedTasks.map(t => ({
				label: t.request.title,
				description: `${t.commits.length} commit(s) on ${t.branchName}`,
				id: t.id,
			})),
			{ placeHolder: 'Select agent to view diff' }
		);

		if (pick) {
			const diff = await bgService.getTaskDiff((pick as any).id);
			if (diff) {
				await editorService.openEditor({
					resource: undefined,
					contents: diff,
					languageId: 'diff',
					options: { pinned: false },
				} as any);
			} else {
				notificationService.info('No diff available (branch may have been cleaned up).');
			}
		}
	}
}

// ─── Register ────────────────────────────────────────────────────────────────

registerAction2(SpawnBackgroundAgentAction);
registerAction2(CancelBackgroundAgentAction);
registerAction2(ViewBackgroundAgentDiffAction);
