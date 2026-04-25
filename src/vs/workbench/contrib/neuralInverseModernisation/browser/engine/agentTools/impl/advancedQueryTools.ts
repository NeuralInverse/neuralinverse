/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { IStaleUnitReport, UnitStatus, RiskLevel } from '../../../../common/knowledgeBaseTypes.js';
import { IUnitFilterCriteria, IDependencyNode } from '../../../knowledgeBase/types.js';
import {
	IAgentToolCallResult,
	IGetStaleUnitsInput,
	IFilterUnitsInput,
	IGetDependencyTreeInput,
	IDependencyTreeNode,
	IUnitSummary,
} from '../agentToolTypes.js';
import { toUnitSummary } from './unitTools.js';


// \u2500\u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function toDependencyTreeNode(node: IDependencyNode, kb: IKnowledgeBaseService): IDependencyTreeNode {
	const unit = kb.getUnit(node.unitId);
	return {
		unitId:       node.unitId,
		unitName:     unit?.name ?? node.unitId,
		status:       node.status,
		isTranslated: node.isTranslated,
		depth:        node.depth,
		dependsOn:    node.dependsOn.map(child => toDependencyTreeNode(child, kb)),
	};
}


// \u2500\u2500\u2500 Tool implementations \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function getStaleUnits(
	input: IGetStaleUnitsInput | undefined,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IStaleUnitReport[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const thresholdMs = input?.thresholdMs ?? 86_400_000; // 24 hours default
	const stale       = kb.getStaleUnits(thresholdMs);

	const byReason: Record<string, number> = {};
	for (const s of stale) {
		byReason[s.staleReason] = (byReason[s.staleReason] ?? 0) + 1;
	}
	const reasonSummary = Object.entries(byReason)
		.map(([r, c]) => `${c} ${r}`)
		.join(', ');

	return {
		success: true,
		data:    stale,
		summary: stale.length === 0
			? `No stale units found (threshold: ${thresholdMs}ms)`
			: `${stale.length} stale unit(s): ${reasonSummary}`,
	};
}


export function getTopologicalOrder(
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IUnitSummary[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const ordered = kb.getTopologicalOrder().map(toUnitSummary);

	return {
		success: true,
		data:    ordered,
		summary: `${ordered.length} units in dependency-resolved (leaf-first) order`,
	};
}


export function filterUnits(
	input: IFilterUnitsInput | undefined,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IUnitSummary[]> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const criteria: IUnitFilterCriteria = {
		status:        input?.status as UnitStatus[] | undefined,
		risk:          input?.risk   as RiskLevel[]  | undefined,
		language:      input?.language,
		domain:        input?.domain,
		filePattern:   input?.filePattern,
		tagId:         input?.tagId,
		unlockedOnly:  input?.unlockedOnly,
		driftedOnly:   input?.driftedOnly,
		workPackageId: input?.workPackageId,
	};

	const limit  = input?.limit  ?? 50;
	const offset = input?.offset ?? 0;
	const all    = kb.filterUnits(criteria);
	const paged  = all.slice(offset, offset + limit).map(toUnitSummary);

	return {
		success: true,
		data:    paged,
		summary: `${paged.length} of ${all.length} units matching filter criteria`,
	};
}


export function getDependencyTree(
	input: IGetDependencyTreeInput,
	kb: IKnowledgeBaseService,
): IAgentToolCallResult<IDependencyTreeNode> {
	if (!kb.isActive) {
		return { success: false, error: 'No active knowledge base \u2014 open the Modernisation panel (Cmd+Alt+M) to activate the session, then retry.' };
	}

	const unit = kb.getUnit(input.unitId);
	if (!unit) {
		return { success: false, error: `Unit not found: ${input.unitId}` };
	}

	const maxDepth = input.maxDepth ?? 5;
	const rawTree  = kb.getDependencyTree(input.unitId, maxDepth);
	const tree     = toDependencyTreeNode(rawTree, kb);

	// Count total nodes in the tree
	function countNodes(node: IDependencyTreeNode): number {
		return 1 + node.dependsOn.reduce((s, c) => s + countNodes(c), 0);
	}
	const totalNodes = countNodes(tree);

	return {
		success: true,
		data:    tree,
		summary: `Dependency tree for "${unit.name}": ${totalNodes} node(s), max depth ${maxDepth}`,
	};
}
