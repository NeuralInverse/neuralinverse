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
import { ICheckResult, IDomainSummary, IGRCRule, IImpactNode, IInvariantDefinition, GRCDomain } from '../types/grcTypes.js';
import { IFrameworkMetadata } from '../framework/frameworkSchema.js';

export const EXT_TO_LANGUAGE_ID: Record<string, string> = {
	ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
	py: 'python', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
	java: 'java', go: 'go', rs: 'rust', rb: 'ruby', cs: 'csharp',
	swift: 'swift', kt: 'kotlin', php: 'php', scala: 'scala',
};

export interface IRuleAnalyzer {
	readonly id: string;
	readonly supportedTypes: string[];
	readonly supportedLanguages?: string[];
	analyzeFile(fileUri: URI, content: string, rules: IGRCRule[]): Promise<ICheckResult[]>;
}

export const IGRCEngineService = createDecorator<IGRCEngineService>('neuralInverseGRCEngineService');

export interface IGRCEngineService {
	readonly _serviceBrand: undefined;
	readonly onDidCheckComplete: Event<ICheckResult[]>;
	readonly onDidRulesChange: Event<void>;
	getResultsForDomain(domain: GRCDomain): ICheckResult[];
	getAllResults(): ICheckResult[];
	getDomainSummary(): IDomainSummary[];
	getActiveDomains(): GRCDomain[];
	getActiveFrameworks(): IFrameworkMetadata[];
	getRules(): IGRCRule[];
	getBlockingViolations(): ICheckResult[];
	registerAnalyzer(analyzer: IRuleAnalyzer): void;
	getInvariants(): IInvariantDefinition[];
	removeFramework(id: string): Promise<void>;
	setBreakingChangeViolations(fileUri: URI, violations: ICheckResult[]): void;
	getIgnorePatterns(): string[];
	addIgnorePattern(pattern: string): void;
	removeIgnorePattern(pattern: string): void;
	getContextOnlyPatterns(): string[];
	addContextOnlyPattern(pattern: string): void;
	removeContextOnlyPattern(pattern: string): void;
	getContextFileContents(): Map<string, string>;
	getImportedByMap(): ReadonlyMap<string, readonly string[]>;
	getImpactChain(fileUri: URI, maxDepth?: number): IImpactNode | undefined;
	scanWorkspace(): Promise<void>;
	scanWorkspaceWithAI(): Promise<void>;
	readonly isPeriodicAIScanActive: boolean;
	setExternalResults(fileUri: URI, ruleId: string, results: ICheckResult[]): void;
	getCachedContent(fileUri: URI): string | undefined;
	readonly inlineDiagnosticsEnabled: boolean;
	setInlineDiagnosticsEnabled(enabled: boolean): void;
	readonly onDidInlineDiagnosticsChange: Event<boolean>;
	getLastWorkspaceScanTime(): number;
}
