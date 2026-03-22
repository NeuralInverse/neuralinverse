/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IKnowledgeBaseService } from '../../knowledgeBase/service.js';
import {
	ICutoverService,
	CommitBatchAlreadyRunningError,
	CutoverNotReadyError,
	ICommitProgress,
} from './service.js';
import {
	exportAuditBundle,
	formatAuditBundleAsJson,
	verifyAuditBundleIntegrity,
	IAuditBundle,
	IAuditBundleOptions,
} from './impl/auditExporter.js';
import {
	writeCommittedFiles,
	ICommitBatchOptions,
	ICommitBatchResult,
} from './impl/commitWriter.js';
import {
	checkCutoverReadiness,
	ICutoverReadinessReport,
} from './impl/cutoverGate.js';
import { buildCutoverMetrics, ICutoverMetrics } from './impl/cutoverMetrics.js';
import { IApprovalRecord } from '../../../common/modernisationTypes.js';


export class CutoverServiceImpl extends Disposable implements ICutoverService {
	readonly _serviceBrand: undefined;

	// ── Events ────────────────────────────────────────────────────────────────

	private readonly _onCommitProgress = this._register(new Emitter<ICommitProgress>());
	readonly onCommitProgress: Event<ICommitProgress> = this._onCommitProgress.event;

	private readonly _onCutoverApproved = this._register(new Emitter<IApprovalRecord>());
	readonly onCutoverApproved: Event<IApprovalRecord> = this._onCutoverApproved.event;

	// ── State ─────────────────────────────────────────────────────────────────

	private _isCommitting                            = false;
	private _commitController: AbortController | null = null;
	private _lastCommitResult: ICommitBatchResult | null = null;
	private _isCutoverApproved                       = false;
	private _cutoverApproval: IApprovalRecord | null  = null;

	get isCommitting():      boolean                  { return this._isCommitting; }
	get lastCommitResult():  ICommitBatchResult | null { return this._lastCommitResult; }
	get isCutoverApproved(): boolean                  { return this._isCutoverApproved; }
	get cutoverApproval():   IApprovalRecord | null    { return this._cutoverApproval; }

	constructor(
		@IKnowledgeBaseService private readonly _kb:          IKnowledgeBaseService,
		@IFileService           private readonly _fileService: IFileService,
	) {
		super();
	}


	// ── Audit API ─────────────────────────────────────────────────────────────

	exportAuditBundle(options?: IAuditBundleOptions): IAuditBundle {
		return exportAuditBundle(this._kb, options);
	}

	formatAuditBundleAsJson(bundle: IAuditBundle): string {
		return formatAuditBundleAsJson(bundle);
	}

	verifyAuditBundle(bundle: IAuditBundle): { valid: boolean; message: string } {
		return verifyAuditBundleIntegrity(bundle);
	}


	// ── Commit API ────────────────────────────────────────────────────────────

	async commitBatch(options: ICommitBatchOptions = {}): Promise<ICommitBatchResult> {
		if (this._isCommitting) {
			throw new CommitBatchAlreadyRunningError();
		}

		this._isCommitting     = true;
		this._commitController = new AbortController();

		try {
			const result = await writeCommittedFiles(
				this._kb,
				this._fileService,
				options,
				this._commitController.signal,
			);

			// Emit per-unit progress events
			for (const job of result.jobs) {
				if (job.errorMsg === 'skipped (file exists)') {
					this._onCommitProgress.fire({ type: 'unit-skipped', unitId: job.unitId, unitName: job.unitName, targetFile: job.targetFile });
				} else if (job.ok) {
					this._onCommitProgress.fire({ type: 'unit-committed', unitId: job.unitId, unitName: job.unitName, targetFile: job.targetFile });
				} else {
					this._onCommitProgress.fire({ type: 'unit-error', unitId: job.unitId, unitName: job.unitName, targetFile: job.targetFile, errorMsg: job.errorMsg });
				}
			}
			this._onCommitProgress.fire({ type: 'batch-completed', result });

			this._lastCommitResult = result;
			return result;

		} finally {
			this._isCommitting     = false;
			this._commitController = null;
		}
	}

	cancelCommit(): void {
		this._commitController?.abort();
	}


	// ── Cutover gate ──────────────────────────────────────────────────────────

	checkReadiness(): ICutoverReadinessReport {
		return checkCutoverReadiness(this._kb);
	}

	approveCutover(approver: string, rationale: string, changeTicketRef?: string): void {
		const report = checkCutoverReadiness(this._kb);
		if (!report.isReady) {
			throw new CutoverNotReadyError(report.blocking);
		}

		const approval: IApprovalRecord = {
			id:             `cutover-approval-${Date.now()}`,
			unitId:         'session',
			approvalType:   'plan',   // closest ApprovalType for a top-level session approval
			approvedBy:     approver,
			approvedAt:     Date.now(),
			rationale,
			changeTicketRef,
		};

		this._isCutoverApproved = true;
		this._cutoverApproval   = approval;
		this._onCutoverApproved.fire(approval);
	}


	// ── Metrics ───────────────────────────────────────────────────────────────

	getMetrics(): ICutoverMetrics {
		return buildCutoverMetrics(this._kb, this._isCutoverApproved);
	}
}
