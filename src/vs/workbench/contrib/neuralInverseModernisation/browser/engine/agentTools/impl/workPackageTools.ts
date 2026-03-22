/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { IWorkPackage } from '../../../../common/knowledgeBaseTypes.js';
import {
	IAgentToolCallResult,
	ICreateWorkPackageInput,
	IGetWorkPackageInput,
	IAddUnitToWorkPackageInput,
	IRemoveUnitFromWorkPackageInput,
	IDeleteWorkPackageInput,
	IWorkPackageSummary,
} from '../agentToolTypes.js';


// ─── Helpers ──────────────────────────────────────────────────────────────────

function toWorkPackageSummary(pkg: IWorkPackage, kb: IKnowledgeBaseService): IWorkPackageSummary {
	return {
		id:           pkg.id,
		label:        pkg.label,
		description:  pkg.description,
		unitCount:    pkg.unitIds.length,
		assignedTo:   pkg.assignedTo,
		dueDate:      pkg.dueDate,
		completedAt:  pkg.completedAt,
		createdAt:    pkg.createdAt,
		createdBy:    pkg.createdBy,
	};
}

function parseDueDate(dueDate: string | number | undefined): number | undefined {
	if (dueDate === undefined) { return undefined; }
	if (typeof dueDate === 'number') { return dueDate; }
	const ms = Date.parse(dueDate);
	return isNaN(ms) ? undefined : ms;
}


// ─── Tool implementations ─────────────────────────────────────────────────────

export function createWorkPackage(
	input: ICreateWorkPackageInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IWorkPackageSummary> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}
	if (!input.label?.trim()) {
		return { success: false, error: 'label is required.' };
	}

	const pkg = kb.createWorkPackage({
		label:       input.label.trim(),
		description: input.description ?? '',
		unitIds:     input.unitIds ?? [],
		assignedTo:  input.assignedTo,
		dueDate:     parseDueDate(input.dueDate),
		createdBy:   input.createdBy ?? 'agent',
	});

	// Add any initial unit IDs
	for (const unitId of (input.unitIds ?? [])) {
		kb.addUnitToWorkPackage(pkg.id, unitId);
	}

	return {
		success: true,
		data:    toWorkPackageSummary(pkg, kb),
		summary: `Work package "${pkg.label}" created (ID: ${pkg.id})`,
	};
}


export function listWorkPackages(
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IWorkPackageSummary[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const packages = kb.getAllWorkPackages().map(p => toWorkPackageSummary(p, kb));

	return {
		success: true,
		data:    packages,
		summary: `${packages.length} work package(s)`,
	};
}


export function getWorkPackage(
	input: IGetWorkPackageInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IWorkPackageSummary & { unitIds: string[] }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const pkg = kb.getWorkPackage(input.workPackageId);
	if (!pkg) {
		return { success: false, error: `Work package not found: ${input.workPackageId}` };
	}

	return {
		success: true,
		data:    { ...toWorkPackageSummary(pkg, kb), unitIds: pkg.unitIds },
		summary: `Work package "${pkg.label}" — ${pkg.unitIds.length} unit(s)`,
	};
}


export function addUnitToWorkPackage(
	input: IAddUnitToWorkPackageInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ workPackageId: string; unitId: string }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const pkg  = kb.getWorkPackage(input.workPackageId);
	if (!pkg) {
		return { success: false, error: `Work package not found: ${input.workPackageId}` };
	}
	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	kb.addUnitToWorkPackage(input.workPackageId, input.unitId);

	return {
		success: true,
		data:    { workPackageId: input.workPackageId, unitId: input.unitId },
		summary: `Unit "${unit.name}" added to work package "${pkg.label}"`,
	};
}


export function removeUnitFromWorkPackage(
	input: IRemoveUnitFromWorkPackageInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ workPackageId: string; unitId: string }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const pkg  = kb.getWorkPackage(input.workPackageId);
	if (!pkg) {
		return { success: false, error: `Work package not found: ${input.workPackageId}` };
	}

	kb.removeUnitFromWorkPackage(input.workPackageId, input.unitId);

	return {
		success: true,
		data:    { workPackageId: input.workPackageId, unitId: input.unitId },
		summary: `Unit ${input.unitId} removed from work package "${pkg.label}"`,
	};
}


export function deleteWorkPackage(
	input: IDeleteWorkPackageInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ deleted: boolean }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const pkg = kb.getWorkPackage(input.workPackageId);
	if (!pkg) {
		return { success: false, error: `Work package not found: ${input.workPackageId}` };
	}

	kb.deleteWorkPackage(input.workPackageId);

	return {
		success: true,
		data:    { deleted: true },
		summary: `Work package "${pkg.label}" deleted`,
	};
}
