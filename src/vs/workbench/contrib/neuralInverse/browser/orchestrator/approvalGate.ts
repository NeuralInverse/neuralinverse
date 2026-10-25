/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Approval Gate Manager
 *
 * Manages human-in-the-loop approval requests for workflow steps.
 *
 * ## Flow
 *
 * 1. Orchestrator calls requestApproval() — returns a Promise that blocks execution
 * 2. UI subscribes to onDidRequestApproval, shows the approval prompt
 * 3. User approves or rejects via IWorkflowAgentService.respondToApproval()
 * 4. respond() resolves the pending Promise — orchestrator continues
 *
 * ## Auto-approve
 *
 * If autoApproveAt is set, the request is auto-approved after that timestamp.
 * The orchestrator uses Promise.race([userResponse, autoApproveTimeout]).
 */

import { Emitter, Event } from '../../../../../base/common/event.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IApprovalRequest {
	runId: string;
	stepId: string;
	prompt: string;
	/** Present for 'after' timing — shows the step output to the approver */
	stepOutput?: string;
	requestedAt: number;
	/** Epoch ms at which the request auto-approves. Undefined = wait forever. */
	autoApproveAt?: number;
}

export interface IApprovalResponse {
	decision: 'approve' | 'reject';
	feedback?: string;
}

// ─── Approval Gate Manager ────────────────────────────────────────────────────

export class ApprovalGateManager {

	private readonly _onDidRequestApproval = new Emitter<IApprovalRequest>();
	readonly onDidRequestApproval: Event<IApprovalRequest> = this._onDidRequestApproval.event;

	private readonly _resolvers = new Map<string, (response: IApprovalResponse) => void>();
	private readonly _requests = new Map<string, IApprovalRequest>();

	/**
	 * Request approval for a step. The returned Promise resolves when the user
	 * responds OR the auto-approve timeout fires.
	 */
	requestApproval(request: IApprovalRequest): Promise<IApprovalResponse> {
		const key = `${request.runId}:${request.stepId}`;

		const userResponsePromise = new Promise<IApprovalResponse>(resolve => {
			this._resolvers.set(key, resolve);
			this._requests.set(key, request);
		});

		// Fire event so UI can render the prompt
		this._onDidRequestApproval.fire(request);

		const cleanup = () => {
			this._resolvers.delete(key);
			this._requests.delete(key);
		};

		// Auto-approve timeout
		if (request.autoApproveAt) {
			const delayMs = Math.max(0, request.autoApproveAt - Date.now());
			let handle: ReturnType<typeof setTimeout>;
			const timeoutPromise = new Promise<IApprovalResponse>(resolve => {
				handle = setTimeout(() => resolve({ decision: 'approve' }), delayMs);
			});
			return Promise.race([userResponsePromise, timeoutPromise]).finally(() => {
				clearTimeout(handle);
				cleanup();
			});
		}

		return userResponsePromise.finally(cleanup);
	}

	/**
	 * Called by the UI (via IWorkflowAgentService.respondToApproval) to resolve
	 * a pending approval request.
	 */
	respond(runId: string, stepId: string, response: IApprovalResponse): void {
		const key = `${runId}:${stepId}`;
		const resolver = this._resolvers.get(key);
		if (resolver) {
			resolver(response);
		} else {
			console.warn(`[ApprovalGateManager] No pending approval for ${key}`);
		}
	}

	/** All currently pending approval requests, ordered by requestedAt. */
	getPending(): IApprovalRequest[] {
		return [...this._requests.values()].sort((a, b) => a.requestedAt - b.requestedAt);
	}

	/** True if there are any pending approvals. */
	get hasPending(): boolean {
		return this._resolvers.size > 0;
	}
}
