/*---------------------------------------------------------------------------------------------
 *  Ported from Claude Code (MIT License - Copyright (c) Anthropic)
 *  Source: src/cost-tracker.ts + src/utils/modelCost.ts
 *  Adapted for Neural Inverse IDE — VS Code DI-compatible, per-session tracking
 *--------------------------------------------------------------------------------------------*/

import type { SessionCostSummary } from '../../common/neuralInverseCCTypes.js';
import { calculateUSDCost, formatCostUSD } from './modelCosts.js';

export class TokenCostTracker {
	private readonly _sessions = new Map<string, SessionCostSummary>();
	private _aggregate: SessionCostSummary = this._emptySummary('__aggregate__');

	// ─── Record usage ─────────────────────────────────────────────────────────

	recordTokenUsage(params: {
		sessionId: string;
		model: string;
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
		durationMs?: number;
	}): void {
		const costUSD = calculateUSDCost(params.model, {
			inputTokens: params.inputTokens,
			outputTokens: params.outputTokens,
			cacheReadInputTokens: params.cacheReadInputTokens,
			cacheCreationInputTokens: params.cacheCreationInputTokens,
		});

		this._accumulate(this._getOrCreate(params.sessionId), params, costUSD);
		this._accumulate(this._aggregate, params, costUSD);
	}

	private _accumulate(
		summary: SessionCostSummary,
		params: { model: string; inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number },
		costUSD: number
	): void {
		summary.totalCostUSD += costUSD;
		summary.totalInputTokens += params.inputTokens;
		summary.totalOutputTokens += params.outputTokens;
		summary.totalCacheReadTokens += params.cacheReadInputTokens ?? 0;
		summary.totalCacheWriteTokens += params.cacheCreationInputTokens ?? 0;
		summary.turnCount++;

		const existing = summary.byModel[params.model] ?? {
			inputTokens: 0, outputTokens: 0,
			cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0,
		};
		existing.inputTokens += params.inputTokens;
		existing.outputTokens += params.outputTokens;
		existing.cacheReadInputTokens += params.cacheReadInputTokens ?? 0;
		existing.cacheCreationInputTokens += params.cacheCreationInputTokens ?? 0;
		existing.costUSD += costUSD;
		summary.byModel[params.model] = existing;
	}

	// ─── Read ────────────────────────────────────────────────────────────────

	getSessionCost(sessionId: string): SessionCostSummary {
		return this._getOrCreate(sessionId);
	}

	getAggregateCost(): SessionCostSummary {
		return this._aggregate;
	}

	resetSessionCost(sessionId: string): void {
		this._sessions.set(sessionId, this._emptySummary(sessionId));
	}

	// ─── Format ──────────────────────────────────────────────────────────────

	formatSessionCost(sessionId: string): string {
		const s = this._getOrCreate(sessionId);
		const lines = [
			`Cost: ${formatCostUSD(s.totalCostUSD)}`,
			`Input: ${s.totalInputTokens.toLocaleString()} tokens`,
			`Output: ${s.totalOutputTokens.toLocaleString()} tokens`,
		];
		if (s.totalCacheReadTokens > 0) {
			lines.push(`Cache read: ${s.totalCacheReadTokens.toLocaleString()} tokens`);
		}
		if (s.totalCacheWriteTokens > 0) {
			lines.push(`Cache write: ${s.totalCacheWriteTokens.toLocaleString()} tokens`);
		}
		const modelLines = Object.entries(s.byModel).map(
			([model, u]) => `  ${model}: ${formatCostUSD(u.costUSD)} (${u.inputTokens.toLocaleString()} in, ${u.outputTokens.toLocaleString()} out)`
		);
		if (modelLines.length > 1) {
			lines.push('By model:');
			lines.push(...modelLines);
		}
		return lines.join('\n');
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	private _getOrCreate(sessionId: string): SessionCostSummary {
		let s = this._sessions.get(sessionId);
		if (!s) {
			s = this._emptySummary(sessionId);
			this._sessions.set(sessionId, s);
		}
		return s;
	}

	private _emptySummary(sessionId: string): SessionCostSummary {
		return {
			sessionId,
			totalCostUSD: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCacheReadTokens: 0,
			totalCacheWriteTokens: 0,
			byModel: {},
			turnCount: 0,
		};
	}
}

// ─── Token estimation (CC heuristic) ─────────────────────────────────────────

/**
 * Fast token estimator without API call.
 * Ported from CC tokenEstimation.ts — character-count heuristic.
 * ~4 chars per token for code/text, 2 for JSON.
 */
export function estimateTokens(text: string): number {
	if (!text) { return 0; }
	// Detect JSON-heavy content (2 chars/token), else use 4 chars/token
	const isJsonLike = text.trimStart().startsWith('{') || text.trimStart().startsWith('[');
	const charsPerToken = isJsonLike ? 2 : 4;
	return Math.ceil(text.length / charsPerToken);
}
