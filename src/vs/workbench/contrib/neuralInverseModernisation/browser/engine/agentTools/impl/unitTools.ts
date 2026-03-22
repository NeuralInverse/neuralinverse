/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { IKnowledgeUnit } from '../../../../common/knowledgeBaseTypes.js';
import { IUnitAnnotation } from '../../../../common/knowledgeBaseTypes.js';
import {
	IAgentToolCallResult,
	IGetUnitInput,
	IListUnitsInput,
	IGetNextUnitInput,
	IGetUnitContextInput,
	IGetUnitDependenciesInput,
	IGetImpactChainInput,
	ISearchUnitsInput,
	IGetUnitHistoryInput,
	IListAnnotationsInput,
	IDeleteAnnotationInput,
	IUnitSummary,
	IUnitContextResult,
	IDependencyResult,
} from '../agentToolTypes.js';


// ─── Unit summary builder ─────────────────────────────────────────────────────

export function toUnitSummary(unit: IKnowledgeUnit): IUnitSummary {
	return {
		id:                  unit.id,
		name:                unit.name,
		unitType:            unit.unitType,
		sourceLang:          unit.sourceLang,
		status:              unit.status,
		riskLevel:           unit.riskLevel,
		domain:              unit.domain,
		sourceFile:          unit.sourceFile,
		dependsOnCount:      unit.dependsOn.length,
		usedByCount:         unit.usedBy.length,
		businessRuleCount:   unit.businessRules.length,
		pendingDecisionId:   unit.pendingDecisionId,
		blockedReason:       unit.blockedReason,
		hasTranslation:      Boolean(unit.targetText),
		hasInterface:        Boolean(unit.targetInterface),
		hasFingerprint:      Boolean(unit.fingerprint),
		createdAt:           unit.createdAt,
		updatedAt:           (unit as unknown as { updatedAt?: number }).updatedAt ?? unit.createdAt,
	};
}


// ─── Tool implementations ─────────────────────────────────────────────────────

export function getUnit(
	input: IGetUnitInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IUnitSummary> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base. Call init() first.' };
	}

	let unit: IKnowledgeUnit | undefined;

	if (input.unitId) {
		unit = kb.getUnit(input.unitId);
	} else if (input.unitName) {
		unit = kb.getAllUnits().find(u => u.name === input.unitName);
	} else {
		return { success: false, error: 'Provide either unitId or unitName.' };
	}

	if (!unit) {
		const identifier = input.unitId ?? input.unitName ?? '';
		return { success: false, error: `Unit not found: ${identifier}` };
	}

	return {
		success: true,
		data: toUnitSummary(unit),
		summary: `Unit "${unit.name}" — status: ${unit.status}, risk: ${unit.riskLevel}`,
	};
}


export function listUnits(
	input: IListUnitsInput | undefined,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IUnitSummary[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const {
		status, riskLevel, language, domain, filePath,
		tagId, workPackageId, limit = 50, offset = 0,
	} = input ?? {};

	let units = kb.getAllUnits();

	// Apply filters
	if (status)         { units = units.filter(u => u.status === status); }
	if (riskLevel)      { units = units.filter(u => u.riskLevel === riskLevel); }
	if (language)       { units = units.filter(u => u.sourceLang.toLowerCase() === language.toLowerCase()); }
	if (domain)         { units = units.filter(u => u.domain === domain); }
	if (filePath)       { units = units.filter(u => u.sourceFile.includes(filePath)); }
	if (tagId)          { units = kb.getUnitsByTag(tagId).filter(u => units.includes(u)); }
	if (workPackageId)  { units = kb.getUnitsByWorkPackage(workPackageId).filter(u => units.includes(u)); }

	const total  = units.length;
	const paged  = units.slice(offset, offset + limit).map(toUnitSummary);

	return {
		success: true,
		data: paged,
		summary: `${paged.length} of ${total} matching units returned`,
	};
}


export function getNextUnit(
	input: IGetNextUnitInput | undefined,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IUnitSummary | null> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const unit = kb.getNextUnit({
		riskLevel:  input?.riskLevel as IKnowledgeUnit['riskLevel'] | undefined,
		domain:     input?.domain,
		language:   input?.language,
	});

	if (!unit) {
		return {
			success: true,
			data: null,
			summary: 'No units currently ready for translation.',
		};
	}

	return {
		success: true,
		data: toUnitSummary(unit),
		summary: `Next unit: "${unit.name}" (${unit.riskLevel} risk, ${unit.sourceLang})`,
	};
}


export function getUnitContext(
	input: IGetUnitContextInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IUnitContextResult> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	const maxTokens  = input.maxTokens ?? 12_000;
	const budgeted   = kb.getContextForBudget(input.unitId, maxTokens);
	const resolved   = kb.getResolvedContext(input.unitId);

	const preview    = (unit.resolvedSource ?? unit.sourceText ?? '').slice(0, 500);
	const srcLength  = (unit.resolvedSource ?? unit.sourceText ?? '').length;

	const result: IUnitContextResult = {
		unitId:                    unit.id,
		unitName:                  unit.name,
		sourceLang:                unit.sourceLang,
		resolvedSourcePreview:     preview,
		resolvedSourceLength:      srcLength,
		estimatedTokens:           kb.estimateTokens(budgeted.context.resolvedSource ?? ''),
		calledInterfaceCount:      resolved.calledInterfaces.length,
		typeMappingDecisionCount:  resolved.applicableTypeMappings.length,
		namingDecisionCount:       resolved.applicableNamingDecisions.length,
		ruleInterpretationCount:   resolved.ruleInterpretations.length,
		businessRuleCount:         resolved.relatedRules.length,
		glossaryTermCount:         resolved.relevantGlossaryTerms.length,
		annotationCount:           resolved.contextAnnotations.length,
	};

	if (input.includeFullContext) {
		result.fullContext = kb.exportDecisionsAsContext(input.unitId) +
			'\n\n' + kb.exportGlossaryAsContext(unit.domain);
	}

	return {
		success: true,
		data: result,
		summary: `Context for "${unit.name}": ~${result.estimatedTokens} tokens, ` +
			`${result.calledInterfaceCount} interfaces, ${result.businessRuleCount} rules`,
	};
}


export function getUnitDependencies(
	input: IGetUnitDependenciesInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IDependencyResult> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	const direction   = input.direction ?? 'both';
	const transitive  = input.transitive ?? false;

	const dependsOnUnits = (direction === 'dependsOn' || direction === 'both')
		? (transitive ? kb.getTransitiveDependencies(input.unitId) : kb.getDependencies(input.unitId))
		: [];

	const usedByUnits = (direction === 'usedBy' || direction === 'both')
		? kb.getDependents(input.unitId)
		: [];

	// Cycle detection
	const cycles      = kb.findDependencyCycles();
	const hasCycle    = cycles.some(cycle => cycle.includes(input.unitId));

	const transitiveDepsCount = transitive
		? kb.getTransitiveDependencies(input.unitId).length
		: dependsOnUnits.length;

	return {
		success: true,
		data: {
			unitId:                      unit.id,
			unitName:                    unit.name,
			dependsOn:                   dependsOnUnits.map(toUnitSummary),
			usedBy:                      usedByUnits.map(toUnitSummary),
			transitiveDependsOnCount:    transitiveDepsCount,
			transitiveUsedByCount:       kb.getImpactChain(input.unitId).length,
			hasCycle,
		},
		summary: `"${unit.name}" depends on ${dependsOnUnits.length} unit(s), ` +
			`used by ${usedByUnits.length} unit(s)${hasCycle ? ' ⚠ cycle detected' : ''}`,
	};
}


export function getImpactChain(
	input: IGetImpactChainInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IUnitSummary[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	const chain = kb.getImpactChain(input.unitId).map(toUnitSummary);

	return {
		success: true,
		data: chain,
		summary: `Changing "${unit.name}" would affect ${chain.length} downstream unit(s)`,
	};
}


export function searchUnits(
	input: ISearchUnitsInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IUnitSummary[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const limit   = input.limit ?? 20;
	const results = kb.searchUnits(input.query).slice(0, limit).map(toUnitSummary);

	return {
		success: true,
		data: results,
		summary: `Found ${results.length} units matching "${input.query}"`,
	};
}


export function getUnitHistory(
	input: IGetUnitHistoryInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<ReturnType<IKnowledgeBaseService['getAuditLogForUnit']>> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	const limit   = input.limit ?? 20;
	const entries = kb.getAuditLogForUnit(input.unitId, limit);

	return {
		success: true,
		data: entries,
		summary: `${entries.length} audit entries for "${unit.name}"`,
	};
}


// ── Annotation read/delete ─────────────────────────────────────────────────────

export function listAnnotations(
	input: IListAnnotationsInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IUnitAnnotation[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	const annotations = kb.getAnnotations(input.unitId);

	return {
		success: true,
		data:    annotations,
		summary: `${annotations.length} annotation(s) on "${unit.name}"`,
	};
}


export function deleteAnnotation(
	input: IDeleteAnnotationInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ deleted: boolean }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	kb.deleteAnnotation(input.annotationId);

	return {
		success: true,
		data:    { deleted: true },
		summary: `Annotation ${input.annotationId} deleted`,
	};
}
