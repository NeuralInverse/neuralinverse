/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { IKnowledgeUnit, RiskLevel, UnitStatus } from '../../../../common/knowledgeBaseTypes.js';
import {
	IAgentToolCallResult,
	ISplitUnitInput,
	ISplitUnitResult,
	IMergeUnitsInput,
	IMergeUnitsResult,
	IRevertUnitInput,
} from '../agentToolTypes.js';


// \u2500\u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const RISK_ORDER: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

function maxRisk(risks: string[]): RiskLevel {
	let max = 0;
	for (const r of risks) {
		const idx = RISK_ORDER.indexOf(r as RiskLevel);
		if (idx > max) { max = idx; }
	}
	return RISK_ORDER[max];
}

function emptyCodeRange() {
	return { startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 };
}


// \u2500\u2500\u2500 Tool implementations \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function splitUnit(
	input: ISplitUnitInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<ISplitUnitResult> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const parent = kb.getUnit(input.unitId);
	if (!parent) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}
	if (!input.subUnits || input.subUnits.length < 2) {
		return { success: false, error: 'At least 2 sub-units required to split.' };
	}
	if (input.subUnits.length > 20) {
		return { success: false, error: 'Cannot split into more than 20 sub-units.' };
	}

	const subUnitDefs: Array<Omit<IKnowledgeUnit, 'id' | 'createdAt' | 'updatedAt'>> =
		input.subUnits.map(s => ({
			sourceFile:   parent.sourceFile,
			sourceRange:  emptyCodeRange(),
			sourceLang:   parent.sourceLang,
			sourceText:   s.sourceText,
			resolvedSource: s.sourceText,
			name:         s.name,
			unitType:     parent.unitType,
			riskLevel:    (s.riskLevel ?? parent.riskLevel) as RiskLevel,
			domain:       s.domain ?? parent.domain,
			phaseId:      s.phaseId ?? parent.phaseId,
			dependsOn:    [],
			usedBy:       [],
			businessRules: [],
			status:       'pending' as UnitStatus,
			approvals:    [],
		}));

	const newUnitIds = kb.splitUnit(input.unitId, subUnitDefs);

	return {
		success: true,
		data:    { parentUnitId: input.unitId, newUnitIds, subUnitCount: newUnitIds.length },
		summary: `"${parent.name}" split into ${newUnitIds.length} sub-units. Parent moved to "skipped".`,
	};
}


export function mergeUnits(
	input: IMergeUnitsInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IMergeUnitsResult> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}
	if (!input.unitIds || input.unitIds.length < 2) {
		return { success: false, error: 'At least 2 unit IDs required to merge.' };
	}
	if (!input.name?.trim()) {
		return { success: false, error: 'name is required for the merged unit.' };
	}

	const units: IKnowledgeUnit[] = [];
	for (const uid of input.unitIds) {
		const u = kb.getUnit(uid);
		if (!u) {
			return { success: false, error: `Unit not found: ${uid}` };
		}
		units.push(u);
	}

	// Derive fields from source units
	const sourceTexts  = units.map(u => `// === ${u.name} ===\n${u.sourceText}`).join('\n\n');
	const riskLevel    = (input.riskLevel ?? maxRisk(units.map(u => u.riskLevel))) as RiskLevel;
	const domain       = input.domain ?? units[0].domain;
	const sourceLang   = units[0].sourceLang;
	const sourceFile   = units[0].sourceFile;

	const mergedDef: Omit<IKnowledgeUnit, 'id' | 'createdAt' | 'updatedAt'> = {
		sourceFile,
		sourceRange:   emptyCodeRange(),
		sourceLang,
		sourceText:    sourceTexts,
		resolvedSource: sourceTexts,
		name:          input.name.trim(),
		unitType:      units[0].unitType,
		riskLevel,
		domain,
		phaseId:       units[0].phaseId,
		dependsOn:     [],
		usedBy:        [],
		businessRules: units.flatMap(u => u.businessRules),
		status:        'pending' as UnitStatus,
		approvals:     [],
	};

	const mergedUnitId = kb.mergeUnits(input.unitIds, mergedDef);

	return {
		success: true,
		data:    { mergedUnitId, sourceUnitIds: input.unitIds },
		summary: `${input.unitIds.length} units merged into "${input.name}" (ID: ${mergedUnitId}). Source units moved to "skipped".`,
	};
}


export function revertUnit(
	input: IRevertUnitInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<{ unitId: string; newStatus: string }> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}
	if (!input.reason?.trim()) {
		return { success: false, error: 'reason is required for revert (audit trail).' };
	}

	kb.revertUnit(input.unitId, input.reason, input.actor ?? 'human');

	return {
		success: true,
		data:    { unitId: input.unitId, newStatus: 'pending' },
		summary: `Unit "${unit.name}" reverted to "pending". Translation artifacts cleared.`,
	};
}
