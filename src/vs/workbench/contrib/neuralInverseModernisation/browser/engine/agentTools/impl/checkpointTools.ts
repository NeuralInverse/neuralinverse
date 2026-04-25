/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKnowledgeBaseService, IKnowledgeBaseCheckpoint } from '../../../knowledgeBase/service.js';
import {
	IAgentToolCallResult,
	ICreateCheckpointInput,
	IRestoreCheckpointInput,
	IDeleteCheckpointInput,
} from '../agentToolTypes.js';


// \u2500\u2500\u2500 Tool implementations \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export async function createCheckpoint(
	input: ICreateCheckpointInput,
	kb: IKnowledgeBaseService,
): Promise<IAgentToolCallResult<IKnowledgeBaseCheckpoint>> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}
	if (!input.label?.trim()) {
		return { success: false, error: 'label is required.' };
	}

	try {
		const checkpoint = await kb.createCheckpoint(input.label.trim(), input.triggeredBy ?? 'agent');

		return {
			success: true,
			data:    checkpoint,
			summary: `Checkpoint "${checkpoint.label}" created (ID: ${checkpoint.id}) \u2014 ${checkpoint.unitCount} units, ${checkpoint.snapshotSize} bytes`,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { success: false, error: `Failed to create checkpoint: ${message}` };
	}
}


export function listCheckpoints(
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IKnowledgeBaseCheckpoint[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const checkpoints = kb.listCheckpoints().sort((a, b) => b.createdAt - a.createdAt);

	return {
		success: true,
		data:    checkpoints,
		summary: `${checkpoints.length} checkpoint(s) available`,
	};
}


export async function restoreCheckpoint(
	input: IRestoreCheckpointInput,
	kb: IKnowledgeBaseService,
): Promise<IAgentToolCallResult<{ restored: boolean; checkpointId: string }>> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const checkpoint = kb.getCheckpoint(input.checkpointId);
	if (!checkpoint) {
		return { success: false, error: `Checkpoint not found: ${input.checkpointId}` };
	}

	try {
		// KB auto-snapshots current state as 'pre-restore' before restoring
		await kb.restoreCheckpoint(input.checkpointId);

		return {
			success: true,
			data:    { restored: true, checkpointId: input.checkpointId },
			summary: `KB restored to checkpoint "${checkpoint.label}" (${checkpoint.unitCount} units). Pre-restore state auto-saved.`,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { success: false, error: `Restore failed: ${message}` };
	}
}


export function deleteCheckpoint(
	input: IDeleteCheckpointInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ deleted: boolean }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const checkpoint = kb.getCheckpoint(input.checkpointId);
	if (!checkpoint) {
		return { success: false, error: `Checkpoint not found: ${input.checkpointId}` };
	}

	kb.deleteCheckpoint(input.checkpointId);

	return {
		success: true,
		data:    { deleted: true },
		summary: `Checkpoint "${checkpoint.label}" deleted`,
	};
}
