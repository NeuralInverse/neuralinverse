/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Cutover Metrics
 *
 * Derives a snapshot of cutover-relevant statistics from the KB for display
 * in the Progress tab's "Cutover" section.
 */

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';


// \u2500\u2500\u2500 Types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface ICutoverMetrics {
	/** Total units in the KB (excludes skipped) */
	totalUnits:        number;
	/** Units in 'committed' status */
	committed:         number;
	/** Units in 'validated' (ready to commit but not yet written) */
	validated:         number;
	/** Units in 'flagged' (have divergences needing resolution) */
	flagged:           number;
	/** Units whose validation was overridden */
	overridden:        number;
	/** Units still not in a terminal state */
	inProgress:        number;
	/** Proportion of non-skipped units in committed+validated state (0\u20131) */
	completionRate:    number;
	/** True when cutover was previously approved */
	cutoverApproved:   boolean;
}


// \u2500\u2500\u2500 Builder \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function buildCutoverMetrics(
	kb:               IKnowledgeBaseService,
	cutoverApproved:  boolean,
): ICutoverMetrics {
	if (!kb.isActive) {
		return {
			totalUnits: 0, committed: 0, validated: 0, flagged: 0,
			overridden: 0, inProgress: 0, completionRate: 0, cutoverApproved,
		};
	}

	const TERMINAL = new Set(['validated', 'committed', 'complete', 'skipped', 'blocked']);
	const units = kb.getAllUnits().filter(u => u.status !== 'skipped');

	let committed  = 0;
	let validated  = 0;
	let flagged    = 0;
	let overridden = 0;
	let inProgress = 0;

	for (const u of units) {
		if (u.status === 'committed') { committed++; }
		else if (u.status === 'validated') { validated++; }
		else if (u.status === 'flagged') { flagged++; }

		if (u.equivalenceResult?.overridden) { overridden++; }

		if (!TERMINAL.has(u.status)) { inProgress++; }
	}

	const totalUnits    = units.length;
	const completionRate = totalUnits > 0
		? (committed + validated) / totalUnits
		: 0;

	return {
		totalUnits,
		committed,
		validated,
		flagged,
		overridden,
		inProgress,
		completionRate,
		cutoverApproved,
	};
}
