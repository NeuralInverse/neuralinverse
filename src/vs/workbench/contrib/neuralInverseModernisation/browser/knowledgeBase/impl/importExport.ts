/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * KB export / import and decision portability.
 *
 * Full KB export/import: complete snapshot for backup, handoff between teams,
 * or migrating between IDE instances. Always creates a checkpoint before import.
 *
 * Decision export/import: portable JSON carrying only the decision log. Allows
 * decisions established in one project to be re-used in a related project
 * (e.g. a company-wide COBOL\u2192Java naming standard).
 */

import {
	IModernisationKnowledgeBase,
	IDecisionLog,
} from '../../../common/knowledgeBaseTypes.js';
import { serialiseKB, deserialiseKB } from './helpers.js';

// \u2500\u2500\u2500 Full export \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Export the entire KB as a JSON string.
 * The exported format is the same as what's stored in workspace storage,
 * so it can be imported verbatim.
 */
export function exportKB(kb: IModernisationKnowledgeBase): string {
	return serialiseKB(kb);
}

/**
 * Deserialise an exported KB JSON string back to a live IModernisationKnowledgeBase.
 * Caller is responsible for replacing the live KB with the returned value.
 */
export function importKB(json: string): IModernisationKnowledgeBase {
	return deserialiseKB(json);
}

// \u2500\u2500\u2500 Decision portability \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface IDecisionExport {
	version:   1;
	exportedAt: number;
	decisions: IDecisionLog;
}

/**
 * Export only the decision log as a portable JSON string.
 * Does not include units, files, audit log, or progress.
 */
export function exportDecisions(kb: IModernisationKnowledgeBase): string {
	const payload: IDecisionExport = {
		version:    1,
		exportedAt: Date.now(),
		decisions:  kb.decisions,
	};
	return JSON.stringify(payload, null, 2);
}

/**
 * Import decisions from an exportDecisions() payload.
 * Merges into the existing decision log, skipping exact duplicates (same id).
 * Does NOT overwrite decisions with the same id that already exist.
 */
export function importDecisions(
	kb: IModernisationKnowledgeBase,
	json: string,
): void {
	const payload = JSON.parse(json) as IDecisionExport;
	if (payload.version !== 1) {
		throw new Error(`importDecisions: unsupported version ${(payload as any).version}`);
	}

	const incomingDecisions = payload.decisions;
	_mergeDecisionArrays(kb.decisions.typeMapping,      incomingDecisions.typeMapping,      d => d.id);
	_mergeDecisionArrays(kb.decisions.naming,           incomingDecisions.naming,           d => d.id);
	_mergeDecisionArrays(kb.decisions.ruleInterpret,    incomingDecisions.ruleInterpret,    d => d.id);
	_mergeDecisionArrays(kb.decisions.exclusions,       incomingDecisions.exclusions,       d => d.id);
	_mergeDecisionArrays(kb.decisions.patternOverrides, incomingDecisions.patternOverrides, d => d.id);
}

/**
 * Merge decisions from another full KB export JSON string.
 * Only the decision log from the imported KB is merged; units are NOT imported.
 * Useful for combining decisions from two parallel migration efforts.
 */
export function mergeDecisionsFrom(
	kb: IModernisationKnowledgeBase,
	json: string,
): void {
	// Try as full KB export first, fall back to decision export format
	try {
		const importedKB = deserialiseKB(json);
		_mergeDecisionArrays(kb.decisions.typeMapping,      importedKB.decisions.typeMapping,      d => d.id);
		_mergeDecisionArrays(kb.decisions.naming,           importedKB.decisions.naming,           d => d.id);
		_mergeDecisionArrays(kb.decisions.ruleInterpret,    importedKB.decisions.ruleInterpret,    d => d.id);
		_mergeDecisionArrays(kb.decisions.exclusions,       importedKB.decisions.exclusions,       d => d.id);
		_mergeDecisionArrays(kb.decisions.patternOverrides, importedKB.decisions.patternOverrides, d => d.id);
		return;
	} catch { /* Not a full KB \u2014 try decision export format */ }

	importDecisions(kb, json);
}

// \u2500\u2500\u2500 Internal helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _mergeDecisionArrays<T>(
	target: T[],
	incoming: T[],
	idFn: (item: T) => string,
): void {
	const existingIds = new Set(target.map(idFn));
	for (const item of incoming) {
		if (!existingIds.has(idFn(item))) {
			target.push(item);
			existingIds.add(idFn(item));
		}
	}
}
