/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';

export const IComplianceReportService = createDecorator<IComplianceReportService>('neuralInverseComplianceReportService');
export interface IComplianceReportService {
	readonly _serviceBrand: undefined;
	exportReport(): Promise<URI | undefined>;
}

class ComplianceReportService extends Disposable implements IComplianceReportService {
	declare readonly _serviceBrand: undefined;
	async exportReport(): Promise<URI | undefined> { return undefined; }
}

registerSingleton(IComplianceReportService, ComplianceReportService, InstantiationType.Delayed);
