/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Token-budget-aware context assembly.
 *
 * Large COBOL programs or programs with deep copybook chains can easily exceed
 * the context window of even the largest LLMs. This module wraps
 * contextAssembler.getResolvedContext() and progressively truncates the least
 * critical parts of the context until it fits the budget.
 *
 * Truncation priority (drop last to first):
 *   1. relatedRules       \u2014 capped first (reduce count)
 *   2. relevantGlossaryTerms \u2014 capped second
 *   3. applicableNamingDecisions \u2014 trimmed to most specific
 *   4. applicableTypeMappings \u2014 trimmed to distinct source types
 *   5. resolvedSource     \u2014 hard-truncated with ellipsis marker (last resort)
 */

import { IResolvedUnitContext } from '../types.js';
import { IBudgetedUnitContext } from '../types.js';

// \u2500\u2500\u2500 Token estimation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** Rough 4-chars-per-token heuristic. Good enough for budget planning. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function estimateContextTokens(ctx: IResolvedUnitContext): number {
	let total = 0;

	// Unit metadata (~200 tokens)
	total += 200;

	// resolvedSource \u2014 largest contributor
	total += estimateTokens(ctx.resolvedSource);

	// Type mappings \u2014 ~50 tokens each
	total += ctx.applicableTypeMappings.length * 50;

	// Naming decisions \u2014 ~40 tokens each
	total += ctx.applicableNamingDecisions.length * 40;

	// Rule interpretations \u2014 ~80 tokens each
	total += ctx.ruleInterpretations.length * 80;

	// Pattern overrides \u2014 ~40 tokens each
	total += ctx.patternOverrides.length * 40;

	// Called interfaces \u2014 ~100 tokens each
	total += ctx.calledInterfaces.length * 100;

	// Related rules \u2014 ~60 tokens each
	total += ctx.relatedRules.length * 60;

	// Glossary terms \u2014 ~30 tokens each
	total += ctx.relevantGlossaryTerms.length * 30;

	// Context-injection annotations \u2014 variable, estimate based on content length
	for (const ann of (ctx.contextAnnotations ?? [])) {
		total += estimateTokens(ann.content);
	}

	return total;
}

// \u2500\u2500\u2500 Budget assembly \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const SOURCE_TRUNCATION_MARKER = '\n\n[... source truncated to fit context budget ...]\n';
const CHARS_PER_TOKEN = 4;

export function assembleWithBudget(
	baseContext: IResolvedUnitContext,
	maxTokens: number,
): IBudgetedUnitContext {
	const truncationLog: string[] = [];

	// Work on a mutable copy
	let ctx: IResolvedUnitContext = { ...baseContext };

	const fits = (): boolean => estimateContextTokens(ctx) <= maxTokens;

	if (fits()) {
		return {
			context:         ctx,
			estimatedTokens: estimateContextTokens(ctx),
			maxTokens,
			wasTruncated:    false,
			truncationLog:   [],
		};
	}

	// \u2500\u2500 Step 1: Halve relatedRules \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	while (ctx.relatedRules.length > 0 && !fits()) {
		const before = ctx.relatedRules.length;
		ctx = { ...ctx, relatedRules: ctx.relatedRules.slice(0, Math.max(0, Math.floor(ctx.relatedRules.length / 2))) };
		if (ctx.relatedRules.length < before) {
			truncationLog.push(`relatedRules: ${before} \u2192 ${ctx.relatedRules.length}`);
		} else {
			// Can't halve further; clear entirely
			ctx = { ...ctx, relatedRules: [] };
			truncationLog.push('relatedRules: cleared');
			break;
		}
	}

	if (fits()) { return _result(ctx, maxTokens, truncationLog); }

	// \u2500\u2500 Step 2: Cap glossary terms \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	while (ctx.relevantGlossaryTerms.length > 5 && !fits()) {
		const before = ctx.relevantGlossaryTerms.length;
		ctx = { ...ctx, relevantGlossaryTerms: ctx.relevantGlossaryTerms.slice(0, Math.max(5, Math.floor(ctx.relevantGlossaryTerms.length / 2))) };
		truncationLog.push(`glossaryTerms: ${before} \u2192 ${ctx.relevantGlossaryTerms.length}`);
	}
	if (!fits()) {
		ctx = { ...ctx, relevantGlossaryTerms: [] };
		truncationLog.push('glossaryTerms: cleared');
	}

	if (fits()) { return _result(ctx, maxTokens, truncationLog); }

	// \u2500\u2500 Step 3: Trim called interfaces to top 3 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (ctx.calledInterfaces.length > 3) {
		ctx = { ...ctx, calledInterfaces: ctx.calledInterfaces.slice(0, 3) };
		truncationLog.push(`calledInterfaces: trimmed to 3`);
	}

	if (fits()) { return _result(ctx, maxTokens, truncationLog); }

	// \u2500\u2500 Step 4: Trim naming decisions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (ctx.applicableNamingDecisions.length > 10) {
		ctx = { ...ctx, applicableNamingDecisions: ctx.applicableNamingDecisions.slice(0, 10) };
		truncationLog.push('namingDecisions: trimmed to 10');
	}

	if (fits()) { return _result(ctx, maxTokens, truncationLog); }

	// \u2500\u2500 Step 5: Trim type mappings \u2014 deduplicate source types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const seenTypes = new Set<string>();
	const deduped = ctx.applicableTypeMappings.filter(tm => {
		if (seenTypes.has(tm.sourceType)) { return false; }
		seenTypes.add(tm.sourceType);
		return true;
	});
	if (deduped.length < ctx.applicableTypeMappings.length) {
		ctx = { ...ctx, applicableTypeMappings: deduped };
		truncationLog.push(`typeMappings: deduped to ${deduped.length}`);
	}

	if (fits()) { return _result(ctx, maxTokens, truncationLog); }

	// \u2500\u2500 Step 6: Truncate resolvedSource (last resort) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const overhead = estimateContextTokens({ ...ctx, resolvedSource: '' });
	const budgetForSource = maxTokens - overhead;
	const maxChars = Math.max(0, budgetForSource * CHARS_PER_TOKEN - SOURCE_TRUNCATION_MARKER.length);

	if (maxChars < ctx.resolvedSource.length) {
		const truncated = ctx.resolvedSource.slice(0, maxChars) + SOURCE_TRUNCATION_MARKER;
		truncationLog.push(`resolvedSource: ${ctx.resolvedSource.length} chars \u2192 ${truncated.length} chars`);
		ctx = { ...ctx, resolvedSource: truncated };
	}

	return _result(ctx, maxTokens, truncationLog);
}

function _result(
	ctx: IResolvedUnitContext,
	maxTokens: number,
	truncationLog: string[],
): IBudgetedUnitContext {
	return {
		context:         ctx,
		estimatedTokens: estimateContextTokens(ctx),
		maxTokens,
		wasTruncated:    truncationLog.length > 0,
		truncationLog,
	};
}
