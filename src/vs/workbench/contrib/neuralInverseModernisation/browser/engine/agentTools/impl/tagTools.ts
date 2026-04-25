/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKnowledgeBaseService, IUnitTag } from '../../../knowledgeBase/service.js';
import {
	IAgentToolCallResult,
	ICreateTagInput,
	IAddTagToUnitInput,
	IRemoveTagFromUnitInput,
	IGetTagsForUnitInput,
} from '../agentToolTypes.js';


// \u2500\u2500\u2500 Tool implementations \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function createTag(
	input: ICreateTagInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IUnitTag> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}
	if (!input.name?.trim()) {
		return { success: false, error: 'name is required.' };
	}

	// Check for duplicate name
	const existing = kb.getAllTags().find(t => t.name === input.name.trim());
	if (existing) {
		return {
			success: true,
			data:    existing,
			summary: `Tag "${existing.name}" already exists (ID: ${existing.id})`,
		};
	}

	const tag = kb.createTag({ name: input.name.trim(), color: input.color });

	return {
		success: true,
		data:    tag,
		summary: `Tag "${tag.name}" created (ID: ${tag.id})`,
	};
}


export function listTags(
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<Array<IUnitTag & { unitCount: number }>> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const tags = kb.getAllTags().map(tag => ({
		...tag,
		unitCount: kb.getUnitsByTag(tag.id).length,
	}));

	return {
		success: true,
		data:    tags,
		summary: `${tags.length} tag(s) defined`,
	};
}


export function addTagToUnit(
	input: IAddTagToUnitInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ unitId: string; tagId: string }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}
	const tag = kb.getTag(input.tagId);
	if (!tag) {
		return { success: false, error: `Tag not found: ${input.tagId}` };
	}

	kb.addTagToUnit(input.unitId, input.tagId);

	return {
		success: true,
		data:    { unitId: input.unitId, tagId: input.tagId },
		summary: `Tag "${tag.name}" applied to unit "${unit.name}"`,
	};
}


export function removeTagFromUnit(
	input: IRemoveTagFromUnitInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ unitId: string; tagId: string }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}
	const tag = kb.getTag(input.tagId);
	if (!tag) {
		return { success: false, error: `Tag not found: ${input.tagId}` };
	}

	kb.removeTagFromUnit(input.unitId, input.tagId);

	return {
		success: true,
		data:    { unitId: input.unitId, tagId: input.tagId },
		summary: `Tag "${tag.name}" removed from unit "${unit.name}"`,
	};
}


export function getTagsForUnit(
	input: IGetTagsForUnitInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IUnitTag[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	const tags = kb.getTagsForUnit(input.unitId);

	return {
		success: true,
		data:    tags,
		summary: `"${unit.name}" has ${tags.length} tag(s): ${tags.map(t => t.name).join(', ') || '(none)'}`,
	};
}


export function deleteTag(
	input: { tagId: string },
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ deleted: boolean }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const tag = kb.getTag(input.tagId);
	if (!tag) {
		return { success: false, error: `Tag not found: ${input.tagId}` };
	}

	kb.deleteTag(input.tagId);

	return {
		success: true,
		data:    { deleted: true },
		summary: `Tag "${tag.name}" deleted`,
	};
}
