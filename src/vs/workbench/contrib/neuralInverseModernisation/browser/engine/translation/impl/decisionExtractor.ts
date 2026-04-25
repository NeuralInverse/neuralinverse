/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Decision Extractor
 *
 * Promotes the raw `IRaisedDecision[]` from the AI's metadata block into fully
 * formed `IPendingDecision` objects ready to be stored in the Knowledge Base.
 *
 * ## What this adds to each raised decision:
 * - A unique `id` (format: `dec-{unitId-prefix}-{timestamp}-{index}`)
 * - The `unitId` linking it to the KB unit
 * - `raisedAt` timestamp
 * - Normalised `type` and `priority`
 * - Validation / filtering of malformed entries
 *
 * ## Decision Types (from IPendingDecision)
 *
 * | Type                | When to use                                             |
 * |---------------------|---------------------------------------------------------|
 * | type-mapping        | Source type has no clear target equivalent             |
 * | naming              | Source identifier conflicts with target naming rules   |
 * | rule-interpretation | Business rule semantics are ambiguous                 |
 * | approval            | Human sign-off required (regulated domain)             |
 * | exclusion           | Unit should possibly be excluded from migration        |
 */

import { IPendingDecision } from '../../../../common/knowledgeBaseTypes.js';
import { IRaisedDecision } from './translationTypes.js';


// \u2500\u2500\u2500 Main entry point \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Convert the AI's raised decisions into fully formed `IPendingDecision` objects.
 *
 * @param raised    Raw decisions from the parsed AI metadata
 * @param unitId    The KB unit ID that raised these decisions
 * @param unitName  The unit's display name (used in id generation)
 * @returns         Array of ready-to-store IPendingDecision objects
 */
export function extractDecisions(
	raised: IRaisedDecision[],
	unitId: string,
	unitName: string,
): IPendingDecision[] {
	const now = Date.now();
	const unitPrefix = sanitiseForId(unitName).slice(0, 12);

	return raised
		.filter(r => isValidRaisedDecision(r))
		.map((r, index): IPendingDecision => ({
			id:         `dec-${unitPrefix}-${now}-${index}`,
			unitId,
			type:       r.type,
			priority:   r.priority,
			question:   r.question.trim(),
			context:    r.context.trim(),
			options:    r.options && r.options.length > 0 ? r.options : undefined,
			raisedAt:   now,
		}));
}

/**
 * Return only the blocking decisions (those that prevent unit progress).
 * Used to determine whether to call `kb.flagBlocked()`.
 */
export function getBlockingDecisions(decisions: IPendingDecision[]): IPendingDecision[] {
	return decisions.filter(d => d.priority === 'blocking');
}

/**
 * Return only non-blocking decisions (those that allow progress with human review).
 */
export function getNonBlockingDecisions(decisions: IPendingDecision[]): IPendingDecision[] {
	return decisions.filter(d => d.priority !== 'blocking');
}

/**
 * Whether any decision in the list is blocking.
 */
export function hasBlockingDecision(decisions: IPendingDecision[]): boolean {
	return decisions.some(d => d.priority === 'blocking');
}


// \u2500\u2500\u2500 Validation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function isValidRaisedDecision(r: IRaisedDecision): boolean {
	// Must have both question and context with meaningful content
	if (!r.question || r.question.trim().length < 5) { return false; }
	if (!r.context  || r.context.trim().length  < 5) { return false; }
	return true;
}


// \u2500\u2500\u2500 Utility \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function sanitiseForId(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-{2,}/g, '-');
}
