/*---------------------------------------------------------------------------------------------
 *  Ported from Claude Code (MIT License - Copyright (c) Anthropic)
 *  Source: src/utils/modelCost.ts
 *  Adapted for Neural Inverse IDE \u2014 no external deps
 *--------------------------------------------------------------------------------------------*/

import type { ModelCosts } from '../../common/neuralInverseCCTypes.js';

export type { ModelCosts };

// Standard pricing tiers \u2014 from https://platform.claude.com/docs/en/about-claude/pricing
export const COST_TIER_3_15: ModelCosts = { inputTokens: 3, outputTokens: 15, promptCacheWriteTokens: 3.75, promptCacheReadTokens: 0.3, webSearchRequests: 0.01 };
export const COST_TIER_5_25: ModelCosts = { inputTokens: 5, outputTokens: 25, promptCacheWriteTokens: 6.25, promptCacheReadTokens: 0.5, webSearchRequests: 0.01 };
export const COST_TIER_15_75: ModelCosts = { inputTokens: 15, outputTokens: 75, promptCacheWriteTokens: 18.75, promptCacheReadTokens: 1.5, webSearchRequests: 0.01 };
export const COST_TIER_30_150: ModelCosts = { inputTokens: 30, outputTokens: 150, promptCacheWriteTokens: 37.5, promptCacheReadTokens: 3, webSearchRequests: 0.01 };
export const COST_HAIKU_35: ModelCosts = { inputTokens: 0.8, outputTokens: 4, promptCacheWriteTokens: 1, promptCacheReadTokens: 0.08, webSearchRequests: 0.01 };
export const COST_HAIKU_45: ModelCosts = { inputTokens: 1, outputTokens: 5, promptCacheWriteTokens: 1.25, promptCacheReadTokens: 0.1, webSearchRequests: 0.01 };

/**
 * Model name patterns \u2192 cost tier.
 * Matched by substring/prefix \u2014 most specific first.
 */
const MODEL_COST_MAP: Array<{ pattern: RegExp; costs: ModelCosts }> = [
	{ pattern: /haiku-4-5|haiku-4\.5/i, costs: COST_HAIKU_45 },
	{ pattern: /haiku/i, costs: COST_HAIKU_35 },
	{ pattern: /opus-4-6|opus-4\.6/i, costs: COST_TIER_5_25 },
	{ pattern: /opus-4-5|opus-4\.5/i, costs: COST_TIER_5_25 },
	{ pattern: /opus-4-1|opus-4\.1/i, costs: COST_TIER_15_75 },
	{ pattern: /opus-4(?![\d.])/i, costs: COST_TIER_15_75 },
	{ pattern: /opus/i, costs: COST_TIER_15_75 },
	{ pattern: /sonnet/i, costs: COST_TIER_3_15 },
];

const DEFAULT_COSTS = COST_TIER_3_15;

export function getCostsForModel(model: string): ModelCosts {
	for (const entry of MODEL_COST_MAP) {
		if (entry.pattern.test(model)) { return entry.costs; }
	}
	return DEFAULT_COSTS;
}

export function calculateUSDCost(model: string, usage: {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
}): number {
	const costs = getCostsForModel(model);
	return (
		(usage.inputTokens / 1_000_000) * costs.inputTokens +
		(usage.outputTokens / 1_000_000) * costs.outputTokens +
		((usage.cacheReadInputTokens ?? 0) / 1_000_000) * costs.promptCacheReadTokens +
		((usage.cacheCreationInputTokens ?? 0) / 1_000_000) * costs.promptCacheWriteTokens
	);
}

export function formatCostUSD(cost: number): string {
	return cost > 0.5
		? `$${(Math.round(cost * 100) / 100).toFixed(2)}`
		: `$${cost.toFixed(4)}`;
}
