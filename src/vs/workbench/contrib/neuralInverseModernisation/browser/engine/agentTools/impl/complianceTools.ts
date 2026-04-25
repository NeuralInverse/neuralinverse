/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKnowledgeBaseService, IComplianceGateResult } from '../../../knowledgeBase/service.js';
import {
	IAgentToolCallResult,
	ICheckComplianceGateInput,
	IRecordComplianceApprovalInput,
	IWaiveComplianceRequirementInput,
	IComplianceFailureSummary,
} from '../agentToolTypes.js';


// \u2500\u2500\u2500 Tool implementations \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function checkComplianceGate(
	input: ICheckComplianceGateInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IComplianceGateResult> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	const result = kb.checkComplianceGate(input.unitId);

	const statusEmoji = result.overallStatus === 'pass' ? '\u2714' :
		result.overallStatus === 'partial' ? '\u26A0' : '\u2716';

	return {
		success: true,
		data: result,
		summary: `${statusEmoji} Compliance gate for "${unit.name}": ${result.overallStatus.toUpperCase()} \u2014 ` +
			`${result.passedCount} passed, ${result.failedCount} failed, ${result.pendingCount} pending, ${result.waivedCount} waived`,
	};
}


export function recordComplianceApproval(
	input: IRecordComplianceApprovalInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ unitId: string; requirementId: string; approver: string }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	kb.recordComplianceApproval(input.unitId, input.requirementId, input.approver, input.evidence);

	return {
		success: true,
		data: { unitId: input.unitId, requirementId: input.requirementId, approver: input.approver },
		summary: `Compliance requirement "${input.requirementId}" approved by "${input.approver}" for unit "${unit.name}"`,
	};
}


export function waiveComplianceRequirement(
	input: IWaiveComplianceRequirementInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ unitId: string; requirementId: string; waivedBy: string }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}
	if (!input.reason?.trim()) {
		return { success: false, error: 'reason is required for compliance waivers (audit trail).' };
	}

	kb.waiveComplianceRequirement(input.unitId, input.requirementId, input.waivedBy, input.reason);

	return {
		success: true,
		data: { unitId: input.unitId, requirementId: input.requirementId, waivedBy: input.waivedBy },
		summary: `Compliance requirement "${input.requirementId}" waived for "${unit.name}" by "${input.waivedBy}"`,
	};
}


export function getComplianceFailures(
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IComplianceFailureSummary[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const failures = kb.getComplianceGateFailures();

	const summaries: IComplianceFailureSummary[] = failures.map(f => {
		const unit = kb.getUnit(f.unitId);
		return {
			unitId: f.unitId,
			unitName: unit?.name ?? f.unitId,
			overallStatus: f.result.overallStatus,
			failedCount: f.result.failedCount,
			passedCount: f.result.passedCount,
			pendingCount: f.result.pendingCount,
			waivedCount: f.result.waivedCount,
			blockerReasons: f.result.blockerReasons,
			evaluatedAt: f.result.evaluatedAt,
		};
	});

	const failCount = summaries.filter(s => s.overallStatus === 'fail').length;
	const partialCount = summaries.filter(s => s.overallStatus === 'partial').length;

	return {
		success: true,
		data: summaries,
		summary: `${summaries.length} unit(s) failing compliance gate \u2014 ${failCount} FAIL, ${partialCount} PARTIAL`,
	};
}
