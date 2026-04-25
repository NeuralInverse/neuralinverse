/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Cutover Service
 *
 * The DI-registered façade for Phase 11 of the Neural Inverse Modernisation pipeline.
 *
 * Provides three capabilities:
 *   1. **Audit export** \u2014 serialise and verify the KB audit trail.
 *   2. **Commit batch** \u2014 write translated target files to disk.
 *   3. **Cutover gate** \u2014 pre-flight readiness check + final approval.
 *
 * ## DI token
 *
 * ```typescript
 * import { ICutoverService } from '.../cutover/service.js';
 * constructor(@ICutoverService private readonly _cutover: ICutoverService) {}
 * ```
 */

import { Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IAuditBundle, IAuditBundleOptions } from './impl/auditExporter.js';
import { ICommitBatchOptions, ICommitBatchResult } from './impl/commitWriter.js';
import { ICutoverReadinessReport } from './impl/cutoverGate.js';
import { ICutoverMetrics } from './impl/cutoverMetrics.js';
import { IApprovalRecord } from '../../../common/modernisationTypes.js';


// \u2500\u2500\u2500 DI token \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const ICutoverService = createDecorator<ICutoverService>('cutoverService');


// \u2500\u2500\u2500 Progress event \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface ICommitProgress {
	type:       'unit-committed' | 'unit-skipped' | 'unit-error' | 'batch-completed';
	unitId?:    string;
	unitName?:  string;
	targetFile?: string;
	errorMsg?:  string;
	/** Present on batch-completed */
	result?:    ICommitBatchResult;
}


// \u2500\u2500\u2500 Service interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface ICutoverService {
	readonly _serviceBrand: undefined;

	// \u2500\u2500 State \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** True when a commit batch is actively running */
	readonly isCommitting: boolean;

	/** Metrics from most recently completed commit (or null if not yet run) */
	readonly lastCommitResult: ICommitBatchResult | null;

	/** Whether the cutover has been formally approved */
	readonly isCutoverApproved: boolean;

	/** The approval record for the cutover, if approved */
	readonly cutoverApproval: IApprovalRecord | null;

	// \u2500\u2500 Events \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Fires during a commit batch: unit-committed, unit-error, batch-completed */
	readonly onCommitProgress: Event<ICommitProgress>;

	/** Fires once when cutover is approved */
	readonly onCutoverApproved: Event<IApprovalRecord>;

	// \u2500\u2500 Audit API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Build a portable audit bundle from the current KB state.
	 * Pure in-memory \u2014 does not write to disk.
	 */
	exportAuditBundle(options?: IAuditBundleOptions): IAuditBundle;

	/**
	 * Serialise a bundle to an indented JSON string.
	 */
	formatAuditBundleAsJson(bundle: IAuditBundle): string;

	/**
	 * Verify that a bundle has not been tampered with.
	 */
	verifyAuditBundle(bundle: IAuditBundle): { valid: boolean; message: string };

	// \u2500\u2500 Commit API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Write all eligible translated units to their target files on disk.
	 * Units that succeed are transitioned to 'committed' status in the KB.
	 *
	 * @throws `CommitBatchAlreadyRunningError` if a batch is already running.
	 */
	commitBatch(options?: ICommitBatchOptions): Promise<ICommitBatchResult>;

	/**
	 * Cancel a running commit batch.
	 * Units already committed remain committed. In-flight writes finish before
	 * the cancel takes effect.
	 */
	cancelCommit(): void;

	// \u2500\u2500 Cutover gate \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Run all pre-cutover readiness checks.
	 * Returns a full report with per-check results.
	 */
	checkReadiness(): ICutoverReadinessReport;

	/**
	 * Formally approve the cutover.
	 * Requires `checkReadiness().isReady === true`.
	 * Records an IApprovalRecord in the KB audit log and fires `onCutoverApproved`.
	 *
	 * @throws `CutoverNotReadyError` if blocking checks are still failing.
	 */
	approveCutover(approver: string, rationale: string, changeTicketRef?: string): void;

	// \u2500\u2500 Metrics \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Snapshot of cutover-relevant KB statistics */
	getMetrics(): ICutoverMetrics;
}


// \u2500\u2500\u2500 Error types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class CommitBatchAlreadyRunningError extends Error {
	constructor() {
		super('A commit batch is already running. Call cancelCommit() first.');
		this.name = 'CommitBatchAlreadyRunningError';
	}
}

export class CutoverNotReadyError extends Error {
	constructor(blockingCount: number) {
		super(`Cutover readiness check failed: ${blockingCount} blocking issue(s) must be resolved.`);
		this.name = 'CutoverNotReadyError';
	}
}
