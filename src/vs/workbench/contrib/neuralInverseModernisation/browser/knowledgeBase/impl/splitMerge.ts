/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit splitting and merging.
 *
 * Split: decompose a "god unit" (e.g. a 3,000-line COBOL program) into smaller,
 * independently translatable sub-units. The parent is moved to 'skipped'; sub-units
 * are created as 'pending' with explicit `dependsOn` pointing at each other where
 * the caller specifies.
 *
 * Merge: combine several over-decomposed units (e.g. 50 trivial copybook stubs)
 * into a single unit. Source units are moved to 'skipped'; the merged unit is
 * created as 'pending'.
 *
 * Both operations are recorded in the audit log.
 */

import {
	IKnowledgeUnit,
	IModernisationKnowledgeBase,
} from '../../../common/knowledgeBaseTypes.js';
import { makeId, makeAuditEntry } from './helpers.js';
import { appendAuditEntry } from './auditLog.js';

// \u2500\u2500\u2500 Split \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Split `unitId` into N sub-units.
 *
 * @param kb         Live knowledge base (mutated in place)
 * @param unitId     The unit to split
 * @param subUnits   Partial definitions for each sub-unit (id/createdAt/updatedAt generated)
 * @returns          IDs of the newly created sub-units
 */
export function splitUnit(
	kb: IModernisationKnowledgeBase,
	unitId: string,
	subUnits: Array<Omit<IKnowledgeUnit, 'id' | 'createdAt' | 'updatedAt'>>,
): string[] {
	const parent = kb.units.get(unitId);
	if (!parent) {
		throw new Error(`splitUnit: unit not found: ${unitId}`);
	}
	if (subUnits.length === 0) {
		throw new Error(`splitUnit: must provide at least one sub-unit`);
	}

	const now = Date.now();
	const newIds: string[] = [];

	// Create sub-units
	for (const partial of subUnits) {
		const id = makeId('u');
		const unit: IKnowledgeUnit = {
			...partial,
			id,
			createdAt:  now,
			updatedAt:  now,
		};
		kb.units.set(id, unit);
		newIds.push(id);
	}

	// Mark parent as skipped
	kb.units.set(unitId, {
		...parent,
		status:    'skipped',
		updatedAt: now,
		// Store child IDs for traceability
		splitInto: newIds,
	} as IKnowledgeUnit & { splitInto?: string[] });

	// Audit
	appendAuditEntry(
		kb.auditLog,
		makeAuditEntry(
			'unit-split',
			`Split unit ${unitId} into ${newIds.length} sub-units`,
			{ parentId: unitId, childIds: newIds },
			unitId,
			'system',
		),
	);

	kb.updatedAt = now;
	return newIds;
}

// \u2500\u2500\u2500 Merge \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Merge several `unitIds` into one.
 *
 * @param kb         Live knowledge base (mutated in place)
 * @param unitIds    Units to merge (all moved to 'skipped')
 * @param merged     Partial definition for the merged unit
 * @returns          ID of the new merged unit
 */
export function mergeUnits(
	kb: IModernisationKnowledgeBase,
	unitIds: string[],
	merged: Omit<IKnowledgeUnit, 'id' | 'createdAt' | 'updatedAt'>,
): string {
	if (unitIds.length < 2) {
		throw new Error(`mergeUnits: need at least 2 units to merge`);
	}

	for (const id of unitIds) {
		if (!kb.units.has(id)) {
			throw new Error(`mergeUnits: unit not found: ${id}`);
		}
	}

	const now = Date.now();
	const mergedId = makeId('u');

	// Create the merged unit
	const mergedUnit: IKnowledgeUnit = {
		...merged,
		id:        mergedId,
		createdAt: now,
		updatedAt: now,
	};
	kb.units.set(mergedId, mergedUnit);

	// Mark source units as skipped
	for (const id of unitIds) {
		const unit = kb.units.get(id)!;
		kb.units.set(id, {
			...unit,
			status:    'skipped',
			updatedAt: now,
			mergedInto: mergedId,
		} as IKnowledgeUnit & { mergedInto?: string });
	}

	// Audit
	appendAuditEntry(
		kb.auditLog,
		makeAuditEntry(
			'units-merged',
			`Merged ${unitIds.length} units into ${mergedId}`,
			{ sourceIds: unitIds, mergedId },
			mergedId,
			'system',
		),
	);

	kb.updatedAt = now;
	return mergedId;
}
