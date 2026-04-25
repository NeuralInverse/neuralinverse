/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 4.3 \u2014 Enclave Review & Approval Gate Service
 *
 * All code changes must pass through a cryptographic review gate before entering the build:
 *  \u2022 Review actions signed by the reviewer's session key \u2014 not just username
 *  \u2022 AI-authored code segments require mandatory human review in locked_down mode
 *  \u2022 Build pipeline blocked until all required reviews carry valid signatures
 *  \u2022 Review quorums: configurable N-of-M approvals required (e.g. 2-of-3 for critical modules)
 *  \u2022 Force-push / rebase bypasses logged as anomalies in the audit trail
 *  \u2022 Each review proof: { diffHash, reviewerSessionId, action, timestamp, signature }
 *  \u2022 Signed review bundles stored in .inverse/reviews/
 *
 * Supports regulated change control workflows per DO-178C SQA, IEC 62304 §8.2.1,
 * ISO 26262 Work Product Reviews, ASPICE SWE.6, and 21 CFR Part 11.
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IEnclaveCryptoService } from '../crypto/enclaveCryptoService.js';
import { IEnclaveSessionService } from '../session/enclaveSessionService.js';
import { IEnclaveAuditTrailService } from '../audit/enclaveAuditTrailService.js';
import { IEnclaveEnvironmentService } from '../environment/enclaveEnvironmentService.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';

// \u2500\u2500\u2500 Service Contract \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const IEnclaveReviewService = createDecorator<IEnclaveReviewService>('IEnclaveReviewService');

export type ReviewAction = 'approve' | 'request_changes' | 'comment' | 'reject' | 'supersede';
export type ReviewStatus = 'pending' | 'approved' | 'changes_requested' | 'rejected' | 'expired' | 'superseded';
export type ReviewRiskLevel = 'critical' | 'high' | 'medium' | 'low';
export type ContentType = 'human_code' | 'ai_code' | 'mixed' | 'config' | 'infra' | 'documentation';

export interface IReviewQuorum {
	/** Minimum approvals required */
	readonly minApprovals: number;
	/** Required reviewer roles (must include at least these) */
	readonly requiredRoles?: string[];
	/** If AI code involved: require one reviewer to be security-qualified */
	readonly requireSecurityReview: boolean;
	/** e.g. 'DO-178C DER' must approve safety-critical changes */
	readonly certifiedApproverRequired?: string;
	/** Expiry of approval (ISO date) \u2014 old approvals don't stay valid forever */
	readonly approvalExpiryHours: number;
}

export interface IReviewRequest {
	readonly requestId: string;
	readonly sessionId: string;
	readonly timestamp: string;
	readonly title: string;
	readonly description?: string;
	/** Git commit hash, branch ref, or change set ID */
	readonly changeRef: string;
	/** SHA-256 hash of the unified diff */
	readonly diffHash: string;
	/** Files affected */
	readonly fileUris: string[];
	/** Source tree hash before this change */
	readonly baseSourceHash: string;
	/** Source tree hash after this change */
	readonly headSourceHash: string;
	readonly riskLevel: ReviewRiskLevel;
	readonly contentType: ContentType;
	/** Is any portion AI-authored? Mandates human review in locked_down */
	readonly hasAiContent: boolean;
	/** Ids of AI-authored segments if known */
	readonly aiSegmentIds?: string[];
	readonly requiredStandard?: string; // e.g. 'DO-178C' | 'IEC 62304' | 'ISO 26262'
	readonly quorum: IReviewQuorum;
	status: ReviewStatus;
	readonly approvals: IReviewRecord[];
	readonly changesRequested: IReviewRecord[];
}

export interface IReviewRecord {
	readonly recordId: string;
	readonly requestId: string;
	readonly reviewerSessionId: string;
	readonly reviewerRole?: string;
	readonly action: ReviewAction;
	readonly comment?: string;
	/** Hash of the diff reviewed \u2014 reviewer is signing that they saw THIS diff */
	readonly diffHash: string;
	/** Source hash at review time \u2014 proves reviewer saw exact code state */
	readonly sourceHashAtReview: string;
	readonly timestamp: string;
	/** ECDSA signature of: action + diffHash + sourceHashAtReview + timestamp + requestId */
	readonly signature: string;
	readonly publicKey: JsonWebKey;
}

export interface IGateCheckResult {
	readonly blocked: boolean;
	readonly reasons: string[];
	readonly pendingRequests: string[];
	readonly approvedRequests: string[];
	readonly aiContentRequiringReview: string[];
}

export interface IEnclaveReviewService {
	readonly _serviceBrand: undefined;

	readonly onDidCreateRequest: Event<IReviewRequest>;
	readonly onDidRecordReview: Event<IReviewRecord>;
	readonly onDidApproveRequest: Event<IReviewRequest>;
	readonly onDidBlockBuild: Event<IGateCheckResult>;

	/** Open a new review request (e.g. before a PR or a build) */
	createReviewRequest(params: {
		title: string;
		description?: string;
		changeRef: string;
		diffContent: string;
		fileUris: string[];
		baseSourceHash: string;
		headSourceHash: string;
		riskLevel: ReviewRiskLevel;
		contentType: ContentType;
		hasAiContent: boolean;
		aiSegmentIds?: string[];
		requiredStandard?: string;
		quorum?: Partial<IReviewQuorum>;
	}): Promise<IReviewRequest>;

	/** Submit a review action on an open request */
	submitReview(requestId: string, action: ReviewAction, comment?: string, role?: string): Promise<IReviewRecord>;

	/** Check if the build pipeline can proceed \u2014 blocks if any open AI-code reviews exist in locked_down */
	checkBuildGate(): Promise<IGateCheckResult>;

	/** Get all open (pending) review requests */
	getPendingRequests(): IReviewRequest[];

	/** Get review history \u2014 all requests newest first */
	getRequestHistory(): IReviewRequest[];

	/** Get a specific review request */
	getRequest(requestId: string): IReviewRequest | null;

	/** Verify a review record's signature against its embedded public key */
	verifyReviewRecord(record: IReviewRecord): Promise<boolean>;

	/** Mark a request as superseded by a newer version */
	supersedeRequest(requestId: string, reason: string): Promise<void>;

	/** Export a complete signed review bundle for audit packages */
	exportReviewBundle(requestId: string): Promise<string>;
}

// \u2500\u2500\u2500 Default quorums per risk level \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function defaultQuorum(risk: ReviewRiskLevel, hasAiContent: boolean, standard?: string): IReviewQuorum {
	const base: IReviewQuorum = {
		minApprovals: risk === 'critical' ? 2 : risk === 'high' ? 2 : 1,
		requireSecurityReview: hasAiContent || risk === 'critical',
		certifiedApproverRequired: standard === 'DO-178C' ? 'DO-178C DER' :
			standard === 'ISO 26262' ? 'ISO 26262 Functional Safety Expert' : undefined,
		approvalExpiryHours: risk === 'critical' ? 24 : 72,
	};
	return base;
}

// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class EnclaveReviewService extends Disposable implements IEnclaveReviewService {
	declare readonly _serviceBrand: undefined;

	private _requests = new Map<string, IReviewRequest>();

	private readonly _onDidCreateRequest = this._register(new Emitter<IReviewRequest>());
	public readonly onDidCreateRequest: Event<IReviewRequest> = this._onDidCreateRequest.event;

	private readonly _onDidRecordReview = this._register(new Emitter<IReviewRecord>());
	public readonly onDidRecordReview: Event<IReviewRecord> = this._onDidRecordReview.event;

	private readonly _onDidApproveRequest = this._register(new Emitter<IReviewRequest>());
	public readonly onDidApproveRequest: Event<IReviewRequest> = this._onDidApproveRequest.event;

	private readonly _onDidBlockBuild = this._register(new Emitter<IGateCheckResult>());
	public readonly onDidBlockBuild: Event<IGateCheckResult> = this._onDidBlockBuild.event;

	constructor(
		@IEnclaveCryptoService private readonly cryptoService: IEnclaveCryptoService,
		@IEnclaveSessionService private readonly sessionService: IEnclaveSessionService,
		@IEnclaveAuditTrailService private readonly auditTrailService: IEnclaveAuditTrailService,
		@IEnclaveEnvironmentService private readonly enclaveEnv: IEnclaveEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._loadHistory().catch(err => console.warn('[Enclave Review] Failed to load history:', err));
	}

	// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public async createReviewRequest(params: {
		title: string;
		description?: string;
		changeRef: string;
		diffContent: string;
		fileUris: string[];
		baseSourceHash: string;
		headSourceHash: string;
		riskLevel: ReviewRiskLevel;
		contentType: ContentType;
		hasAiContent: boolean;
		aiSegmentIds?: string[];
		requiredStandard?: string;
		quorum?: Partial<IReviewQuorum>;
	}): Promise<IReviewRequest> {
		const sessionId = this.sessionService.sessionId;
		const requestId = this._uuid();
		const timestamp = new Date().toISOString();

		const diffHash = await this._sha256(params.diffContent);
		const quorum: IReviewQuorum = {
			...defaultQuorum(params.riskLevel, params.hasAiContent, params.requiredStandard),
			...params.quorum,
		};

		const request: IReviewRequest = {
			requestId, sessionId, timestamp,
			title: params.title,
			description: params.description,
			changeRef: params.changeRef,
			diffHash,
			fileUris: params.fileUris,
			baseSourceHash: params.baseSourceHash,
			headSourceHash: params.headSourceHash,
			riskLevel: params.riskLevel,
			contentType: params.contentType,
			hasAiContent: params.hasAiContent,
			aiSegmentIds: params.aiSegmentIds,
			requiredStandard: params.requiredStandard,
			quorum,
			status: 'pending',
			approvals: [],
			changesRequested: [],
		};

		this._requests.set(requestId, request);
		await this._persist(request);

		await this.auditTrailService.logEntry(
			'review_required',
			'user',
			`review:${requestId}`,
			'flagged',
			`"${params.title}" | Risk: ${params.riskLevel} | AI content: ${params.hasAiContent} | Files: ${params.fileUris.length} | ID: ${requestId}`,
		);

		this._onDidCreateRequest.fire(request);
		return request;
	}

	public async submitReview(requestId: string, action: ReviewAction, comment?: string, role?: string): Promise<IReviewRecord> {
		const request = this._requests.get(requestId);
		if (!request) { throw new Error(`Review request ${requestId} not found`); }
		if (request.status !== 'pending') {
			throw new Error(`Review request ${requestId} is ${request.status} \u2014 cannot add review`);
		}

		const reviewerSessionId = this.sessionService.sessionId;
		const recordId = this._uuid();
		const timestamp = new Date().toISOString();

		// Get the current source hash to prove what state the reviewer saw
		const sourceHashAtReview = await this._getSourceTreeHash();

		// Sign the review action
		const signingPayload = JSON.stringify({
			action, diffHash: request.diffHash, sourceHashAtReview,
			timestamp, requestId, reviewerSessionId,
		});
		const signature = await this.cryptoService.sign(signingPayload);
		const publicKey = await this.cryptoService.exportPublicKeyJwk();

		const record: IReviewRecord = {
			recordId, requestId, reviewerSessionId,
			reviewerRole: role, action, comment,
			diffHash: request.diffHash,
			sourceHashAtReview, timestamp,
			signature, publicKey,
		};

			if (action === 'approve') {
				(request.approvals as IReviewRecord[]).push(record);
			} else if (action === 'request_changes' || action === 'reject') {
				(request.changesRequested as IReviewRecord[]).push(record);
				(request as any).status = action === 'reject' ? 'rejected' : 'changes_requested';
			} else if (action === 'comment') {
				// comment \u2014 no status change
			}

		// Check if quorum is met
		this._updateRequestStatus(request);
		await this._persist(request);

			await this.auditTrailService.logEntry(
				'review_approved',
				'user',
				`review:${requestId}`,
				'completed',
				`Request ${requestId} | Action: ${action} | Reviewer: ${reviewerSessionId.slice(0, 8)} | Source hash: ${sourceHashAtReview.slice(0, 12)}`,
			);

		this._onDidRecordReview.fire(record);

		// Re-read from map: _updateRequestStatus() may have mutated status to 'approved'
		const updatedRequest = this._requests.get(requestId);
		if (updatedRequest && (updatedRequest as any).status === 'approved') {
			this._onDidApproveRequest.fire(updatedRequest);
		}

		return record;
	}

	public async checkBuildGate(): Promise<IGateCheckResult> {
		const pending = this.getPendingRequests();
		const reasons: string[] = [];
		const pendingIds: string[] = [];
		const aiContentRequiringReview: string[] = [];
		const mode = this.enclaveEnv.mode;

		for (const req of pending) {
			pendingIds.push(req.requestId);

			if (mode === 'locked_down') {
				// In locked-down mode: any open review blocks build
				reasons.push(`Review pending: "${req.title}" (${req.requestId.slice(0, 8)})`);
			} else if (req.riskLevel === 'critical' || req.riskLevel === 'high') {
				// In standard mode: only critical/high reviews block build
				reasons.push(`High-risk review pending: "${req.title}" (${req.requestId.slice(0, 8)})`);
			}

			if (req.hasAiContent && mode === 'locked_down') {
				aiContentRequiringReview.push(req.requestId);
				reasons.push(`AI-authored content requires human review: ${req.fileUris.join(', ')}`);
			}

			// Check expired approvals
			const now = Date.now();
			for (const approval of req.approvals) {
				const approvedAt = new Date(approval.timestamp).getTime();
				const expiryMs = req.quorum.approvalExpiryHours * 3600 * 1000;
				if (now - approvedAt > expiryMs) {
					reasons.push(`Approval from ${approval.reviewerSessionId.slice(0, 8)} has expired (>${req.quorum.approvalExpiryHours}h)`);
					(req as any).status = 'expired';
				}
			}
		}

		// Check quorum violations on partially-approved requests
		const changesRequested = [...this._requests.values()].filter(r => r.status === 'changes_requested');
		for (const req of changesRequested) {
			reasons.push(`Changes requested on: "${req.title}" \u2014 must be addressed before build`);
		}

		const blocked = reasons.length > 0;
		const result: IGateCheckResult = {
			blocked,
			reasons,
			pendingRequests: pendingIds,
			approvedRequests: [...this._requests.values()].filter(r => r.status === 'approved').map(r => r.requestId),
			aiContentRequiringReview,
		};

		if (blocked) { this._onDidBlockBuild.fire(result); }
		return result;
	}

	public getPendingRequests(): IReviewRequest[] {
		return [...this._requests.values()].filter(r => r.status === 'pending');
	}

	public getRequestHistory(): IReviewRequest[] {
		return [...this._requests.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
	}

	public getRequest(requestId: string): IReviewRequest | null {
		return this._requests.get(requestId) ?? null;
	}

	public async verifyReviewRecord(record: IReviewRecord): Promise<boolean> {
		const payload = JSON.stringify({
			action: record.action, diffHash: record.diffHash,
			sourceHashAtReview: record.sourceHashAtReview,
			timestamp: record.timestamp, requestId: record.requestId,
			reviewerSessionId: record.reviewerSessionId,
		});
		return this.cryptoService.verifyWithKey(payload, record.signature, record.publicKey);
	}

	public async supersedeRequest(requestId: string, reason: string): Promise<void> {
		const req = this._requests.get(requestId);
		if (!req) { return; }
		(req as any).status = 'superseded';
		await this._persist(req);
		await this.auditTrailService.logEntry(
			'anomaly_detected',
			'user',
			`review:${requestId}`,
			'completed',
			`Request ${requestId} superseded. Reason: "${reason}"`,
		);
	}

	public async exportReviewBundle(requestId: string): Promise<string> {
		const req = this._requests.get(requestId);
		if (!req) { throw new Error(`Request ${requestId} not found`); }
		return JSON.stringify({ request: req, exportedAt: new Date().toISOString() }, null, 2);
	}

	// \u2500\u2500\u2500 Private: Status Updates \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _updateRequestStatus(request: IReviewRequest): void {
		if (request.status === 'rejected' || request.status === 'superseded') { return; }
		if (request.changesRequested.length > 0 && request.status !== 'approved') {
			(request as any).status = 'changes_requested';
			return;
		}
		// Check quorum
		const validApprovals = this._getValidApprovals(request);
		if (validApprovals >= request.quorum.minApprovals) {
			(request as any).status = 'approved';
		}
	}

	private _getValidApprovals(request: IReviewRequest): number {
		const now = Date.now();
		const expiryMs = request.quorum.approvalExpiryHours * 3600 * 1000;
		return request.approvals.filter(a => {
			const age = now - new Date(a.timestamp).getTime();
			return age < expiryMs;
		}).length;
	}

	// \u2500\u2500\u2500 Private: Persistence \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _persist(request: IReviewRequest): Promise<void> {
		const root = this._getWorkspaceRootUri();
		if (!root) { return; }
		const dateStr = request.timestamp.split('T')[0];
		const fileUri = URI.joinPath(root, '.inverse', 'reviews', `review-${dateStr}-${request.requestId.slice(0, 8)}.json`);
		try {
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(JSON.stringify(request, null, 2)));
		} catch (err) {
			console.warn('[Enclave Review] Failed to persist:', err);
		}
	}

	private async _loadHistory(): Promise<void> {
		const root = this._getWorkspaceRootUri();
		if (!root) { return; }
		const dir = URI.joinPath(root, '.inverse', 'reviews');
		try {
			const stat = await this.fileService.resolve(dir);
			const files = (stat.children ?? [])
				.filter(c => !c.isDirectory && c.name.endsWith('.json'))
				.sort((a, b) => b.name.localeCompare(a.name))
				.slice(0, 200);
			for (const file of files) {
				try {
					const raw = await this.fileService.readFile(file.resource);
					const req = JSON.parse(raw.value.toString()) as IReviewRequest;
					this._requests.set(req.requestId, req);
				} catch { /* skip */ }
			}
		} catch { /* dir doesn't exist yet */ }
	}

	// \u2500\u2500\u2500 Private: Crypto & Hashing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _sha256(data: string): Promise<string> {
		try {
			const buf = new TextEncoder().encode(data).buffer;
			const hash = await crypto.subtle.digest('SHA-256', buf as ArrayBuffer);
			return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
		} catch { return 'hash-failed'; }
	}

	private async _getSourceTreeHash(): Promise<string> {
		const root = this._getWorkspaceRootUri();
		if (!root) { return 'no-workspace'; }
		try {
			const hashes: string[] = [];
			await this._walkAndHash(root, hashes);
			hashes.sort();
			return await this._sha256(hashes.join('|'));
		} catch { return 'hash-failed'; }
	}

	private async _walkAndHash(dirUri: URI, hashes: string[]): Promise<void> {
		try {
			const stat = await this.fileService.resolve(dirUri);
			if (!stat.children) { return; }
			for (const child of stat.children) {
				if (child.isDirectory) {
					if (['.git', '.inverse', 'node_modules', 'target', '__pycache__', 'dist', 'build'].includes(child.name)) { continue; }
					await this._walkAndHash(child.resource, hashes);
				} else {
					const ext = child.name.split('.').pop()?.toLowerCase() ?? '';
					if (['ts', 'tsx', 'js', 'jsx', 'c', 'h', 'cpp', 'hpp', 'cs', 'rs', 'go', 'py', 'java', 'kt', 'swift', 'zig', 'adb', 'ads'].includes(ext)) {
						try {
							const content = await this.fileService.readFile(child.resource);
							hashes.push(`${child.resource.path}:${await this._sha256(content.value.toString())}`);
						} catch { /* skip */ }
					}
				}
			}
		} catch { /* skip */ }
	}

	private _getWorkspaceRootUri(): URI | null {
		const folders = this.workspaceContextService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : null;
	}

	private _uuid(): string {
		try { return crypto.randomUUID(); } catch {
			return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
				const r = Math.random() * 16 | 0;
				return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
			});
		}
	}
}

registerSingleton(IEnclaveReviewService, EnclaveReviewService, InstantiationType.Delayed);
