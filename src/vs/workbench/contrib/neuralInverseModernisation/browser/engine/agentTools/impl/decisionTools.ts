/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import {
	IPendingDecision,
	IDecisionLog,
} from '../../../../common/knowledgeBaseTypes.js';
import { generateId } from './toolUtils.js';
import {
	IAgentToolCallResult,
	IGetPendingDecisionsInput,
	IGetDecisionInput,
	IAnswerDecisionInput,
	IGetDecisionLogInput,
	IGetDecisionImpactInput,
	IAnswerDecisionResult,
} from '../agentToolTypes.js';
import { IDecisionConflict, IDecisionImpactResult } from '../../../knowledgeBase/service.js';


// ─── Tool implementations ─────────────────────────────────────────────────────

export function getPendingDecisions(
	input: IGetPendingDecisionsInput | undefined,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IPendingDecision[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	let decisions: IPendingDecision[];

	if (input?.unitId) {
		const d = kb.getPendingDecisionForUnit(input.unitId);
		decisions = d ? [d] : [];
	} else {
		decisions = kb.getPendingDecisions(
			input?.priority as IPendingDecision['priority'] | undefined,
		);
	}

	if (input?.type) {
		decisions = decisions.filter(d => d.type === input.type);
	}

	const blocking   = decisions.filter(d => d.priority === 'blocking').length;
	const high       = decisions.filter(d => d.priority === 'high').length;

	return {
		success: true,
		data: decisions,
		summary: `${decisions.length} pending decision(s) — ${blocking} blocking, ${high} high`,
	};
}


export function getDecision(
	input: IGetDecisionInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IPendingDecision | null> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const decision = kb.getPendingDecision(input.decisionId);

	return {
		success: true,
		data: decision ?? null,
		summary: decision
			? `Decision [${decision.priority}] for unit ${decision.unitId}: ${decision.question}`
			: `No pending decision found with ID: ${input.decisionId}`,
	};
}


export function answerDecision(
	input: IAnswerDecisionInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IAnswerDecisionResult> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const decision = kb.getPendingDecision(input.decisionId);
	if (!decision) {
		return { success: false, error: `Pending decision not found: ${input.decisionId}` };
	}

	const actor = input.actor ?? 'human';
	const now   = Date.now();
	let   recordCreated = false;
	let   recordId: string | undefined;

	// Create the appropriate decision record based on decision type
	switch (decision.type) {
		case 'type-mapping': {
			// Parse "SourceType -> TargetType" format
			const parts = input.answer.split(/\s*->\s*/);
			if (parts.length >= 2) {
				const id = generateId('tm');
				kb.recordTypeMappingDecision({
					id,
					sourceType:  parts[0].trim(),
					targetType:  parts[1].trim(),
					rationale:   input.answerNotes ?? `Answered via decision ${input.decisionId}`,
					appliesTo:   [],
					decidedBy:   actor,
					decidedAt:   now,
					confidence:  1,
				});
				recordCreated = true;
				recordId = id;
			}
			break;
		}

		case 'naming': {
			// Parse "SourceName -> TargetName" format
			const parts = input.answer.split(/\s*->\s*/);
			if (parts.length >= 2) {
				const id = generateId('nd');
				kb.recordNamingDecision({
					id,
					sourceName:  parts[0].trim(),
					targetName:  parts[1].trim(),
					domain:      input.answerNotes ?? '',
					decidedBy:   actor,
					decidedAt:   now,
				});
				recordCreated = true;
				recordId = id;
			}
			break;
		}

		case 'rule-interpretation': {
			const id = generateId('ri');
			kb.recordRuleInterpretation({
				id,
				unitId:      decision.unitId,
				meaning:     input.answer,
				sourceText:  decision.context,
				appliesTo:   [],
				domain:      '',
				decidedBy:   actor,
				decidedAt:   now,
			});
			recordCreated = true;
			recordId = id;
			break;
		}

		case 'exclusion': {
			if (input.answer.toLowerCase().includes('exclude')) {
				const id = generateId('ex');
				const unit = kb.getUnit(decision.unitId);
				if (unit) {
					kb.recordExclusion({
						id,
						pattern:   unit.name,
						reason:    input.answerNotes ?? input.answer,
						decidedBy: actor,
						decidedAt: now,
					});
					recordCreated = true;
					recordId = id;
				}
			}
			break;
		}

		case 'approval':
			// Approval decisions are answered by annotation — the human's answer is the record
			if (input.answerNotes) {
				kb.addAnnotation(
					decision.unitId,
					`Approval decision answered: ${input.answer}. ${input.answerNotes}`,
					actor,
					'agent-note',
				);
				recordCreated = true;
			}
			break;
	}

	// Mark the pending decision resolved
	kb.resolvePendingDecision(input.decisionId, actor);

	// Unblock the unit if this was the blocking decision
	const unit = kb.getUnit(decision.unitId);
	let unitUnblocked = false;
	if (unit?.status === 'blocked' && unit.pendingDecisionId === input.decisionId) {
		kb.markResolved(decision.unitId, actor);
		unitUnblocked = true;
	}

	return {
		success: true,
		data: {
			decisionId:    input.decisionId,
			decisionType:  decision.type,
			resolved:      true,
			recordCreated,
			recordId,
			unitUnblocked,
		},
		summary: `Decision answered. ${recordCreated ? `${decision.type} record created. ` : ''}` +
			`${unitUnblocked ? `Unit ${decision.unitId} unblocked.` : ''}`,
	};
}


export function getDecisionLog(
	input: IGetDecisionLogInput | undefined,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IDecisionLog> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const log = input?.unitId
		? kb.getDecisionsForUnit(input.unitId)
		: kb.getDecisions();

	// Apply type filter if provided
	const filteredLog: IDecisionLog = { ...log };

	if (input?.type) {
		switch (input.type) {
			case 'type-mapping':
				filteredLog.typeMapping = log.typeMapping;
				filteredLog.naming = [];
				filteredLog.ruleInterpret = [];
				filteredLog.exclusions = [];
				filteredLog.patternOverrides = [];
				break;
			case 'naming':
				filteredLog.typeMapping = [];
				filteredLog.naming = log.naming;
				filteredLog.ruleInterpret = [];
				filteredLog.exclusions = [];
				filteredLog.patternOverrides = [];
				break;
			case 'rule-interpretation':
				filteredLog.typeMapping = [];
				filteredLog.naming = [];
				filteredLog.ruleInterpret = log.ruleInterpret;
				filteredLog.exclusions = [];
				filteredLog.patternOverrides = [];
				break;
			case 'exclusion':
				filteredLog.typeMapping = [];
				filteredLog.naming = [];
				filteredLog.ruleInterpret = [];
				filteredLog.exclusions = log.exclusions;
				filteredLog.patternOverrides = [];
				break;
			case 'pattern-override':
				filteredLog.typeMapping = [];
				filteredLog.naming = [];
				filteredLog.ruleInterpret = [];
				filteredLog.exclusions = [];
				filteredLog.patternOverrides = log.patternOverrides;
				break;
		}
	}

	const total =
		filteredLog.typeMapping.length +
		filteredLog.naming.length +
		filteredLog.ruleInterpret.length +
		filteredLog.exclusions.length +
		filteredLog.patternOverrides.length;

	return {
		success: true,
		data: filteredLog,
		summary: `${total} decision records: ${filteredLog.typeMapping.length} type mappings, ` +
			`${filteredLog.naming.length} naming, ` +
			`${filteredLog.ruleInterpret.length} rule interpretations`,
	};
}


export function detectConflicts(
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IDecisionConflict[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const conflicts = kb.detectDecisionConflicts();
	const unresolved = kb.getDecisionConflicts(true);

	return {
		success: true,
		data: conflicts,
		summary: `${conflicts.length} conflict(s) detected, ${unresolved.length} unresolved`,
	};
}


export function getDecisionImpact(
	input: IGetDecisionImpactInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IDecisionImpactResult> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const impact = kb.getDecisionImpact(
		input.decisionId,
		input.decisionType as IDecisionConflict['decisionType'],
	);

	return {
		success: true,
		data: impact,
		summary: `Decision ${input.decisionId} affects ${impact.totalAffected} unit(s)`,
	};
}


// ── Decision record tools ──────────────────────────────────────────────────────

export function recordTypeMapping(
	input: import('../agentToolTypes.js').IRecordTypeMappingInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ id: string }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const id  = generateId('tm');
	const now = Date.now();
	kb.recordTypeMappingDecision({
		id,
		sourceType:  input.sourceType,
		targetType:  input.targetType,
		rationale:   input.rationale ?? '',
		appliesTo:   input.appliesTo ? [input.appliesTo] : [],
		decidedBy:   'human',
		decidedAt:   now,
		confidence:  1,
	});

	return {
		success: true,
		data: { id },
		summary: `Type mapping recorded: ${input.sourceType} → ${input.targetType}`,
	};
}


export function recordNamingDecision(
	input: import('../agentToolTypes.js').IRecordNamingDecisionInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ id: string }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const id  = generateId('nd');
	const now = Date.now();
	kb.recordNamingDecision({
		id,
		sourceName:  input.sourceName,
		targetName:  input.targetName,
		domain:      input.domain ?? '',
		decidedBy:   'human',
		decidedAt:   now,
	});

	return {
		success: true,
		data: { id },
		summary: `Naming decision recorded: ${input.sourceName} → ${input.targetName}`,
	};
}


export function recordRuleInterpretation(
	input: import('../agentToolTypes.js').IRecordRuleInterpretationInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ id: string }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const id  = generateId('ri');
	const now = Date.now();
	kb.recordRuleInterpretation({
		id,
		unitId:      '',
		meaning:     input.meaning,
		sourceText:  input.sourceText ?? '',
		appliesTo:   [],
		domain:      '',
		decidedBy:   'human',
		decidedAt:   now,
	});

	return {
		success: true,
		data: { id },
		summary: `Rule interpretation recorded for rule ${input.ruleId}`,
	};
}


// ── Conflict resolution ────────────────────────────────────────────────────────

export function resolveConflict(
	input: import('../agentToolTypes.js').IResolveConflictInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ conflictId: string; resolved: boolean }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const conflict = kb.getDecisionConflict(input.conflictId);
	if (!conflict) {
		return { success: false, error: `Decision conflict not found: ${input.conflictId}` };
	}

	kb.resolveDecisionConflict(input.conflictId, input.winningDecisionId, input.actor ?? 'human');

	return {
		success: true,
		data:    { conflictId: input.conflictId, resolved: true },
		summary: `Conflict "${input.conflictId}" resolved — winning decision: ${input.winningDecisionId}`,
	};
}


// ── Decision removal ───────────────────────────────────────────────────────────

export function removeDecision(
	input: import('../agentToolTypes.js').IRemoveDecisionInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ removed: boolean }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	switch (input.decisionType) {
		case 'type-mapping':
			kb.removeTypeMappingDecision(input.decisionId);
			break;
		case 'naming':
			kb.removeNamingDecision(input.decisionId);
			break;
		case 'rule-interpretation':
			kb.removeRuleInterpretation(input.decisionId);
			break;
		case 'exclusion':
			kb.removeExclusion(input.decisionId);
			break;
		case 'pattern-override':
			kb.removePatternOverride(input.decisionId);
			break;
		default:
			return { success: false, error: `Unknown decision type: "${input.decisionType}"` };
	}

	return {
		success: true,
		data:    { removed: true },
		summary: `${input.decisionType} decision ${input.decisionId} removed`,
	};
}
