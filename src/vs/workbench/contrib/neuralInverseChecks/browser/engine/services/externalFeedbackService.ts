/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # External Feedback Service
 *
 * Closes the loop between external tool results and the AI context layers.
 *
 * When an external tool (CodeQL, Semgrep, clang-tidy, Polyspace, custom)
 * completes a job with real violations, this service:
 *
 *   Layer 1 (Brief)      — records which rules fired, so the brief context
 *                          surfaces "these patterns were actually found here"
 *                          as highest-priority signals.
 *
 *   Layer 2 (Rule Index) — boosts relevance scores for confirmed rules so
 *                          they rank higher in passive context injection and
 *                          search_compliance_rules results.
 *
 * No LLM calls. Pure signal routing — deterministic, zero latency.
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IExternalToolService } from './externalToolService.js';
import { IFrameworkBriefService } from '../framework/frameworkBriefService.js';
import { IFrameworkRuleIndexService } from '../framework/frameworkRuleIndexService.js';
import { IGRCEngineService } from './grcEngineService.js';

export const IExternalFeedbackService = createDecorator<IExternalFeedbackService>('neuralInverseExternalFeedbackService');

export interface IExternalFeedbackService {
	readonly _serviceBrand: undefined;
}

class ExternalFeedbackService extends Disposable implements IExternalFeedbackService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IExternalToolService private readonly externalToolService: IExternalToolService,
		@IFrameworkBriefService private readonly briefService: IFrameworkBriefService,
		@IFrameworkRuleIndexService private readonly ruleIndexService: IFrameworkRuleIndexService,
		@IGRCEngineService private readonly grcEngine: IGRCEngineService,
	) {
		super();

		// Listen to every job state change from external tools
		this._register(this.externalToolService.onDidJobUpdate(job => {
			// Only act on completed jobs that actually found violations
			if (job.status !== 'complete' || job.resultCount === 0) return;

			const toolName = job.toolName || 'external-tool';

			// Resolve which rules fired by looking at current engine results
			// Filter to results that match this job's rule and scope
			const allResults = this.grcEngine.getAllResults();
			const jobResults = allResults.filter(r => {
				if (r.ruleId !== job.ruleId) return false;
				// For file-scope jobs, filter to that file; workspace-scope: all
				if (job.scope === 'file' && job.targetUri) {
					return r.fileUri.toString() === job.targetUri.toString();
				}
				return true;
			});

			if (jobResults.length === 0) return;

			// Deduplicate rule IDs from results (one job can produce multiple rule IDs via SARIF)
			const ruleIds = [...new Set(jobResults.map(r => r.ruleId))];
			const count = jobResults.length;

			// Feed Layer 1 — brief service records confirmed patterns
			for (const ruleId of ruleIds) {
				const ruleCount = jobResults.filter(r => r.ruleId === ruleId).length;
				this.briefService.recordExternalHit(ruleId, toolName, ruleCount);
			}

			// Feed Layer 2 — rule index boosts confirmed rules
			this.ruleIndexService.boostRules(ruleIds);

			console.log(`[ExternalFeedback] Tool "${toolName}" confirmed ${count} violation(s) for rules [${ruleIds.join(', ')}] — boosted in Layer 1 + Layer 2`);
		}));
	}
}

registerSingleton(IExternalFeedbackService, ExternalFeedbackService, InstantiationType.Eager);
