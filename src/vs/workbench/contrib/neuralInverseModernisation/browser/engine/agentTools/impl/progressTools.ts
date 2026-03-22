/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import {
	IPendingDecision,
	IUnitAnnotation,
} from '../../../../common/knowledgeBaseTypes.js';
import { generateId } from './toolUtils.js';
import {
	IAgentToolCallResult,
	IGetProgressInput,
	IGetWorkspaceSummaryInput,
	ICheckSourceDriftInput,
	IRecordTranslationInput,
	IFlagBlockedInput,
	IFlagReadyInput,
	IAddAnnotationInput,
	IUpdateAnnotationInput,
	IGetUnitsByPhaseInput,
	IImportDecisionsInput,
	IExportDecisionsResult,
	IExportKbResult,
	ICheckExcludedInput,
	ICheckExcludedResult,
	IProgressResult,
	IWorkspaceSummaryResult,
	IRecordTranslationResult,
	IFlagBlockedResult,
	IVelocityResult,
	IPhaseResult,
	IPhaseDetailResult,
	IUnitSummary,
} from '../agentToolTypes.js';
import { toUnitSummary } from './unitTools.js';
import {
	ISourceDriftAlert,
	IKBHealthReport,
} from '../../../knowledgeBase/service.js';


// ─── Progress tools ───────────────────────────────────────────────────────────

export function getProgress(
	input: IGetProgressInput | undefined,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IProgressResult> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const progress = kb.getProgress();
	const stats    = kb.getStats();

	const result: IProgressResult = {
		totalUnits:           progress.totalUnits,
		byStatus:             progress.byStatus as Record<string, number>,
		byRisk:               progress.byRisk as Record<string, number>,
		percentComplete:      stats.percentComplete,
		pendingDecisionCount: stats.pendingDecisionCount,
		blockedUnitCount:     progress.blockedUnits.length,
	};

	if (input?.includeVelocity) {
		const vm = kb.getVelocityMetrics(7);
		const velocity: IVelocityResult = {
			unitsPerDay:              vm.unitsPerDayRolling,
			rollingAvgUnitsPerDay:    vm.unitsPerDayAllTime,
			estimatedDaysToComplete:  vm.estimatedEtaDays ?? null,
			estimatedCompletionDate:  vm.estimatedEtaMs
				? new Date(vm.estimatedEtaMs).toISOString().split('T')[0]
				: null,
		};
		result.velocity = velocity;
	}

	if (input?.includePhases) {
		const phases = kb.getAllPhases();
		result.phases = phases.map((p): IPhaseResult => ({
			phaseId:         p.phaseId,
			label:           p.label,
			totalUnits:      p.totalUnits,
			completedUnits:  p.completedUnits,
			blockedUnits:    p.blockedUnits,
			percentComplete: p.totalUnits > 0 ? Math.round((p.completedUnits / p.totalUnits) * 100) : 0,
		}));
	}

	const done = (progress.byStatus as Record<string, number>)['complete'] ?? 0;
	return {
		success: true,
		data: result,
		summary: `${stats.percentComplete}% complete — ${done}/${progress.totalUnits} units done`,
	};
}


export function getWorkspaceSummary(
	input: IGetWorkspaceSummaryInput | undefined,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IWorkspaceSummaryResult> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const stats    = kb.getStats();
	const progress = kb.getProgress();
	const health   = kb.getLastHealthCheck();
	const drifts   = kb.getDriftAlerts(true);
	const conflicts = kb.getDecisionConflicts(true);

	// Determine health status from structured issues
	let healthStatus: IWorkspaceSummaryResult['healthStatus'] = 'healthy';
	const healthIssues: string[] = [];

	if (health) {
		if (health.summary.errorCount > 0) {
			healthStatus = 'critical';
		} else if (health.summary.warningCount > 0) {
			healthStatus = 'warnings';
		}
		for (const issue of health.issues) {
			if (issue.severity === 'error' || issue.severity === 'warning') {
				healthIssues.push(issue.message);
			}
		}
	}

	if (conflicts.length > 0) {
		if (healthStatus === 'healthy') { healthStatus = 'warnings'; }
		healthIssues.push(`${conflicts.length} unresolved decision conflict(s)`);
	}

	if (drifts.length > 0) {
		if (healthStatus === 'healthy') { healthStatus = 'warnings'; }
		healthIssues.push(`${drifts.length} source drift alert(s)`);
	}

	// Compute counts not in IKnowledgeBaseStats
	const totalBusinessRules = kb.getAllUnits().reduce((s, u) => s + u.businessRules.length, 0);
	const totalAnnotations   = kb.getAllUnits().reduce((s, u) => s + kb.getAnnotations(u.id).length, 0);

	const result: IWorkspaceSummaryResult = {
		totalUnits:           stats.totalUnits,
		totalFiles:           stats.totalFiles,
		totalDecisions:       stats.totalDecisions,
		totalGlossaryTerms:   stats.totalGlossaryTerms,
		totalBusinessRules,
		totalAnnotations,
		pendingDecisionCount: stats.pendingDecisionCount,
		blockedUnitCount:     progress.blockedUnits.length,
		conflictCount:        conflicts.length,
		driftAlertCount:      drifts.length,
		healthStatus,
		healthIssues,
	};

	if (input?.includeLanguageBreakdown) {
		const byLang = new Map<string, number>();
		for (const unit of kb.getAllUnits()) {
			byLang.set(unit.sourceLang, (byLang.get(unit.sourceLang) ?? 0) + 1);
		}
		result.languageBreakdown = Array.from(byLang.entries())
			.sort((a, b) => b[1] - a[1])
			.map(([language, count]) => ({ language, count }));
	}

	if (input?.includeDomainBreakdown) {
		result.domainBreakdown = kb.getAllDomains().map(d => ({
			domain: d.name,
			count:  kb.getUnitsByDomain(d.name).length,
		})).sort((a, b) => b.count - a.count);
	}

	if (input?.includeRiskBreakdown) {
		const byRisk = new Map<string, number>();
		for (const unit of kb.getAllUnits()) {
			byRisk.set(unit.riskLevel, (byRisk.get(unit.riskLevel) ?? 0) + 1);
		}
		result.riskBreakdown = Array.from(byRisk.entries())
			.map(([risk, count]) => ({ risk, count }));
	}

	return {
		success: true,
		data: result,
		summary: `${stats.totalUnits} units, ${stats.totalDecisions} decisions — ${healthStatus}`,
	};
}


export function runHealthCheck(
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IKBHealthReport> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const report = kb.runHealthCheck();

	return {
		success: true,
		data: report,
		summary: report.isHealthy
			? 'Knowledge base is healthy — no issues found'
			: `Health check: ${report.summary.errorCount} error(s), ${report.summary.warningCount} warning(s)`,
	};
}


export function checkSourceDrift(
	input: ICheckSourceDriftInput | undefined,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<ISourceDriftAlert[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	// Return stored drift alerts (actual file-system checks need IFileService,
	// which belongs at the service impl layer, not the pure tool layer)
	let alerts: ISourceDriftAlert[];

	if (input?.filePath) {
		alerts = kb.getDriftAlerts(false).filter(a => a.filePath === input.filePath);
	} else {
		alerts = kb.getDriftAlerts(false);
	}

	const unacknowledged = alerts.filter(a => !a.acknowledgedAt);

	return {
		success: true,
		data: alerts,
		summary: `${alerts.length} drift alert(s), ${unacknowledged.length} unacknowledged`,
	};
}


// ─── Translation write tools ──────────────────────────────────────────────────

export function recordTranslation(
	input: IRecordTranslationInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IRecordTranslationResult> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	const actor = input.actor ?? 'ai';

	// Record the translated code
	kb.recordTranslation(input.unitId, input.translatedCode, input.targetFile);

	// Transition status based on outcome
	let newStatus: string;
	switch (input.outcome) {
		case 'translated':
			kb.setUnitStatus(input.unitId, 'review', `AI translation complete`, actor);
			newStatus = 'review';
			break;
		case 'partial':
			kb.setUnitStatus(input.unitId, 'review', `Partial translation`, actor);
			newStatus = 'review';
			break;
		case 'blocked':
			// Don't change status — caller should use flag_blocked for this
			newStatus = unit.status;
			break;
		case 'error':
			kb.setUnitStatus(input.unitId, 'flagged', `Translation error: ${input.reasoning}`, actor);
			newStatus = 'flagged';
			break;
		default:
			kb.setUnitStatus(input.unitId, 'review', undefined, actor);
			newStatus = 'review';
	}

	// Attach reasoning as annotation
	if (input.reasoning) {
		kb.addAnnotation(input.unitId, `Translation reasoning: ${input.reasoning}`, actor, 'context-injection');
	}

	return {
		success: true,
		data: {
			unitId:     input.unitId,
			newStatus,
			targetFile: input.targetFile,
			confidence: input.confidence,
			outcome:    input.outcome,
		},
		summary: `Translation recorded for "${unit.name}" — ${input.outcome} (${input.confidence} confidence)`,
	};
}


export function flagBlocked(
	input: IFlagBlockedInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IFlagBlockedResult> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	const decisionId = generateId('pd');

	const pendingDecision: IPendingDecision = {
		id:         decisionId,
		unitId:     input.unitId,
		type:       (input.decisionType ?? 'approval') as IPendingDecision['type'],
		priority:   (input.decisionPriority ?? 'blocking') as IPendingDecision['priority'],
		question:   input.decisionQuestion ?? input.reason,
		context:    input.decisionContext ?? '',
		options:    input.decisionOptions,
		raisedAt:   Date.now(),
	};

	kb.flagBlocked(input.unitId, input.reason, pendingDecision);

	return {
		success: true,
		data: {
			unitId:     input.unitId,
			newStatus:  'blocked',
			decisionId,
		},
		summary: `Unit "${unit.name}" blocked — decision ${decisionId} raised`,
	};
}


export function flagReady(
	input: IFlagReadyInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ unitId: string; newStatus: string }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	const actor = input.actor ?? 'human';
	kb.setUnitStatus(input.unitId, 'ready', input.reason ?? 'Manually set to ready', actor);

	return {
		success: true,
		data: { unitId: input.unitId, newStatus: 'ready' },
		summary: `Unit "${unit.name}" moved to ready`,
	};
}


// ─── Annotation tools ─────────────────────────────────────────────────────────

export function addAnnotation(
	input: IAddAnnotationInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IUnitAnnotation> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	const author = input.author ?? 'agent';
	const kind   = (input.kind ?? 'context-injection') as IUnitAnnotation['kind'];

	const annotation = kb.addAnnotation(input.unitId, input.content, author, kind);

	return {
		success: true,
		data: annotation,
		summary: `Annotation added to "${unit.name}" (${kind})`,
	};
}


export function updateAnnotation(
	input: IUpdateAnnotationInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ updated: boolean }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	kb.updateAnnotation(input.annotationId, input.content);

	return {
		success: true,
		data: { updated: true },
		summary: `Annotation ${input.annotationId} updated`,
	};
}


// ─── Phase tools ──────────────────────────────────────────────────────────────

export function getPhases(
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IPhaseDetailResult[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const phases = kb.getAllPhases().map((p): IPhaseDetailResult => ({
		phaseId:         p.phaseId,
		label:           p.label,
		totalUnits:      p.totalUnits,
		completedUnits:  p.completedUnits,
		blockedUnits:    p.blockedUnits,
		percentComplete: p.totalUnits > 0 ? Math.round((p.completedUnits / p.totalUnits) * 100) : 0,
	}));

	const totalComplete = phases.reduce((s, p) => s + p.completedUnits, 0);
	const totalUnits    = phases.reduce((s, p) => s + p.totalUnits, 0);

	return {
		success: true,
		data:    phases,
		summary: `${phases.length} phase(s) — ${totalComplete}/${totalUnits} units complete across all phases`,
	};
}


export function getUnitsByPhase(
	input: IGetUnitsByPhaseInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IUnitSummary[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const phase = kb.getPhase(input.phaseId);
	if (!phase) {
		return { success: false, error: `Phase not found: ${input.phaseId}` };
	}

	const limit  = input.limit  ?? 50;
	const offset = input.offset ?? 0;
	const all    = kb.getUnitsByPhase(input.phaseId);
	const paged  = all.slice(offset, offset + limit).map(toUnitSummary);

	return {
		success: true,
		data:    paged,
		summary: `${paged.length} of ${all.length} unit(s) in phase "${phase.label}"`,
	};
}


// ─── Export / Import tools ────────────────────────────────────────────────────

export function exportDecisions(
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IExportDecisionsResult> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const json = kb.exportDecisions();
	const log  = kb.getDecisions();

	return {
		success: true,
		data: {
			json,
			typeMappingCount:       log.typeMapping.length,
			namingCount:            log.naming.length,
			ruleInterpretationCount: log.ruleInterpret.length,
			exclusionCount:         log.exclusions.length,
			patternOverrideCount:   log.patternOverrides.length,
		},
		summary: `Decisions exported — ${log.typeMapping.length} type mappings, ${log.naming.length} naming, ` +
			`${log.ruleInterpret.length} rule interpretations, ${log.exclusions.length} exclusions`,
	};
}


export function importDecisions(
	input: IImportDecisionsInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ imported: boolean }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}
	if (!input.decisionsJson?.trim()) {
		return { success: false, error: 'decisionsJson is required.' };
	}

	try {
		kb.importDecisions(input.decisionsJson);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { success: false, error: `Import failed: ${message}` };
	}

	const log = kb.getDecisions();

	return {
		success: true,
		data:    { imported: true },
		summary: `Decisions imported and merged. KB now has ${log.typeMapping.length} type mappings, ` +
			`${log.naming.length} naming, ${log.ruleInterpret.length} rule interpretations`,
	};
}


export function exportKb(
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IExportKbResult> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const json       = kb.exportKB();
	const stats      = kb.getStats();
	const sizeBytes  = new TextEncoder().encode(json).length;

	return {
		success: true,
		data: {
			json,
			totalUnits: stats.totalUnits,
			totalFiles: stats.totalFiles,
			sizeBytes,
		},
		summary: `Full KB exported — ${stats.totalUnits} units, ${stats.totalFiles} files, ${sizeBytes} bytes`,
	};
}


// ─── Utility tools ────────────────────────────────────────────────────────────

export function checkExcluded(
	input: ICheckExcludedInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<ICheckExcludedResult> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base.' };
	}

	const isExcluded = kb.isExcluded(input.filePath, input.unitName);

	return {
		success: true,
		data: {
			filePath:    input.filePath,
			unitName:    input.unitName,
			isExcluded,
		},
		summary: isExcluded
			? `"${input.filePath}"${input.unitName ? ` / "${input.unitName}"` : ''} IS excluded — skip this path`
			: `"${input.filePath}"${input.unitName ? ` / "${input.unitName}"` : ''} is NOT excluded`,
	};
}
