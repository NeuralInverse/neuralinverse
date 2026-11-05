/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

export interface IReviewRequest { id: string; fileUris: string[]; status: 'pending' | 'approved' | 'rejected'; createdAt: number; }

export const IEnclaveReviewService = createDecorator<IEnclaveReviewService>('neuralInverseEnclaveReviewService');
export interface IEnclaveReviewService {
	readonly _serviceBrand: undefined;
	readonly onDidCreateRequest: Event<IReviewRequest>;
	readonly onDidRecordReview: Event<IReviewRequest>;
	readonly onDidApproveRequest: Event<IReviewRequest>;
	readonly onDidBlockBuild: Event<IReviewRequest>;
	getPendingRequests?(): IReviewRequest[];
}

class EnclaveReviewService extends Disposable implements IEnclaveReviewService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidCreateRequest = this._register(new Emitter<IReviewRequest>());
	readonly onDidCreateRequest: Event<IReviewRequest> = this._onDidCreateRequest.event;
	private readonly _onDidRecordReview = this._register(new Emitter<IReviewRequest>());
	readonly onDidRecordReview: Event<IReviewRequest> = this._onDidRecordReview.event;
	private readonly _onDidApproveRequest = this._register(new Emitter<IReviewRequest>());
	readonly onDidApproveRequest: Event<IReviewRequest> = this._onDidApproveRequest.event;
	private readonly _onDidBlockBuild = this._register(new Emitter<IReviewRequest>());
	readonly onDidBlockBuild: Event<IReviewRequest> = this._onDidBlockBuild.event;
	getPendingRequests(): IReviewRequest[] { return []; }
}

registerSingleton(IEnclaveReviewService, EnclaveReviewService, InstantiationType.Delayed);
