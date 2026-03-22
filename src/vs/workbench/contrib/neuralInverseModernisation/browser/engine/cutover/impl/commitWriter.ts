/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Commit Writer
 *
 * Writes translated target files to disk and transitions unit statuses to 'committed'.
 *
 * ## Contract
 *
 * A unit is eligible for commit if ALL of the following hold:
 *   - `unit.targetText` is non-empty
 *   - `unit.targetFile` is set
 *   - `unit.status` is `'validated'` OR (`'approved'` with `equivalenceResult.failCount === 0`)
 *
 * For each eligible unit the writer:
 *   1. Encodes `targetText` as UTF-8
 *   2. Creates any missing parent directories via `IFileService`
 *   3. Writes the file (overwrites if it already exists)
 *   4. Calls `kb.setUnitStatus(unitId, 'committed')` on success
 *   5. Records any errors without aborting the remaining units
 *
 * ## Return value
 *
 * `ICommitBatchResult` contains per-unit outcomes and aggregate counts.
 * Callers should surface the `errors` list to the user after the run.
 */

import { URI } from '../../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../../base/common/buffer.js';
import { IFileService } from '../../../../../../../platform/files/common/files.js';
import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { IKnowledgeUnit } from '../../../../common/knowledgeBaseTypes.js';


// ─── Types ────────────────────────────────────────────────────────────────────

export interface ICommitJobResult {
	unitId:    string;
	unitName:  string;
	targetFile: string;
	/** Whether the write succeeded */
	ok:        boolean;
	/** Set when ok=false */
	errorMsg?: string;
}

export interface ICommitBatchOptions {
	/**
	 * Unit statuses that are eligible for commit.
	 * Default: `['validated']`
	 */
	eligibleStatuses?: string[];
	/** When true (default), skip units whose targetFile already exists on disk */
	skipExisting?: boolean;
}

export interface ICommitBatchResult {
	totalEligible:  number;
	committed:      number;
	skipped:        number;
	errors:         number;
	jobs:           ICommitJobResult[];
	startedAt:      number;
	completedAt:    number;
}

export const DEFAULT_COMMIT_OPTIONS: Required<ICommitBatchOptions> = {
	eligibleStatuses: ['validated'],
	skipExisting:     false,
};


// ─── Eligibility helper ───────────────────────────────────────────────────────

function _isEligible(unit: IKnowledgeUnit, eligibleStatuses: Set<string>): boolean {
	if (!unit.targetText || !unit.targetFile) { return false; }
	if (eligibleStatuses.has(unit.status)) { return true; }
	// Also allow 'approved' units whose equivalence result has no failures
	if (
		unit.status === 'approved'
		&& unit.equivalenceResult
		&& unit.equivalenceResult.failCount === 0
		&& unit.equivalenceResult.overridden === false
	) {
		return true;
	}
	return false;
}


// ─── Core writer ─────────────────────────────────────────────────────────────

/**
 * Write all eligible translated units to their target files.
 *
 * @param kb          Knowledge base service (provides units + status transitions)
 * @param fileService VS Code platform file service (handles URI-based writes)
 * @param options     Optional overrides for eligible statuses and skip-existing behaviour
 * @param signal      Optional AbortSignal to cancel mid-batch
 */
export async function writeCommittedFiles(
	kb:          IKnowledgeBaseService,
	fileService: IFileService,
	options:     ICommitBatchOptions = {},
	signal?:     AbortSignal,
): Promise<ICommitBatchResult> {
	const startedAt       = Date.now();
	const eligibleSet     = new Set(options.eligibleStatuses ?? DEFAULT_COMMIT_OPTIONS.eligibleStatuses);
	const skipExisting    = options.skipExisting ?? DEFAULT_COMMIT_OPTIONS.skipExisting;

	const allUnits        = kb.getAllUnits();
	const eligible        = allUnits.filter(u => _isEligible(u, eligibleSet));

	let committed = 0;
	let skipped   = 0;
	let errors    = 0;
	const jobs: ICommitJobResult[] = [];

	for (const unit of eligible) {
		if (signal?.aborted) { break; }

		const targetFile = unit.targetFile!;
		const targetText = unit.targetText!;

		// ── Optional skip-existing check ─────────────────────────────────────
		if (skipExisting) {
			try {
				await fileService.stat(URI.file(targetFile));
				// File exists — skip
				jobs.push({ unitId: unit.id, unitName: unit.name, targetFile, ok: true, errorMsg: 'skipped (file exists)' });
				skipped++;
				continue;
			} catch {
				// File does not exist — proceed
			}
		}

		// ── Write ─────────────────────────────────────────────────────────────
		try {
			const content = VSBuffer.fromString(targetText);
			await fileService.writeFile(URI.file(targetFile), content);
			kb.setUnitStatus(unit.id, 'committed', 'Written to disk by commit flow', 'system');
			jobs.push({ unitId: unit.id, unitName: unit.name, targetFile, ok: true });
			committed++;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			jobs.push({ unitId: unit.id, unitName: unit.name, targetFile, ok: false, errorMsg: msg });
			errors++;
		}
	}

	return {
		totalEligible: eligible.length,
		committed,
		skipped,
		errors,
		jobs,
		startedAt,
		completedAt: Date.now(),
	};
}
