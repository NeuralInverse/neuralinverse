/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *
 *  Licensed under the Business Source License 1.1 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at https://mariadb.com/bsl11
 *
 *  Change Date: 2029-07-14
 *  Change License: GNU Affero General Public License v3.0
 *
 *  Use of this software in production requires a commercial license from Neural Inverse Inc.
 *  Contact (code): github@neuralinverse.com | Contact (sales): sales@neuralinverse.com
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IGRCRule } from '../types/grcTypes.js';
import { IFrameworkDefinition, IFrameworkValidationResult } from './frameworkSchema.js';

export const IFrameworkRegistry = createDecorator<IFrameworkRegistry>('neuralInverseFrameworkRegistry');

export interface ILoadedFramework {
	definition: IFrameworkDefinition;
	sourceUri: URI;
	loadedAt: number;
	isValid: boolean;
}

export interface IFrameworkRegistry {
	readonly _serviceBrand: undefined;
	readonly onDidFrameworksChange: Event<void>;
	getActiveFrameworks(): ILoadedFramework[];
	getFrameworkById(id: string): ILoadedFramework | undefined;
	getAllFrameworkRules(): IGRCRule[];
	getRulesForCategory(category: string): IGRCRule[];
	getAllCategories(): string[];
	getValidationResult(frameworkId: string): IFrameworkValidationResult | undefined;
	reload(): Promise<void>;
	importFramework(json: string): Promise<IFrameworkValidationResult>;
	removeFramework(id: string): Promise<void>;
}
