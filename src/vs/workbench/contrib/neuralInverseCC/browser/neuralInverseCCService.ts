/*---------------------------------------------------------------------------------------------
 *  NeuralInverseCC — shared Claude Code capability service
 *
 *  Provides production-grade CC logic to all IDE AI systems:
 *    Power Mode, Checks Agent, Modernisation, Firmware, Sub-Agents
 *
 *  Copyright (c) Neural Inverse Corporation. MIT License.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type {
	CompactionResult,
	ModelCosts,
	PermissionUpdate,
	SessionCostSummary,
	SkillDefinition,
} from '../common/neuralInverseCCTypes.js';
import {
	AutoCompactController,
	calculateTokenWarningState,
	getAutoCompactThreshold,
	getContextWindowForModel,
} from './compact/autoCompactController.js';
import { getCostsForModel, formatCostUSD } from './cost/modelCosts.js';
import { TokenCostTracker, estimateTokens } from './cost/tokenCostTracker.js';
import { DANGEROUS_BASH_PATTERNS } from './permissions/dangerousPatterns.js';
import {
	parsePermissionRule,
	matchWildcardPattern,
	suggestionForExactCommand,
	suggestionForPrefix,
} from './permissions/shellRuleMatching.js';

// ─── Service contract ─────────────────────────────────────────────────────────

export const INeuralInverseCCService = createDecorator<INeuralInverseCCService>('neuralInverseCCService');

export interface INeuralInverseCCService {

	readonly _serviceBrand: undefined;

	// ── Auto-compact ────────────────────────────────────────────────────────────

	/** Returns true if the session should be compacted now (threshold exceeded + circuit breaker OK). */
	shouldAutoCompact(sessionId: string, tokenCount: number, model: string): boolean;

	/** Call after a successful compaction. */
	recordCompactSuccess(sessionId: string, result: CompactionResult): void;

	/** Call after a failed compaction attempt. Returns new consecutive-failure count. */
	recordCompactFailure(sessionId: string): number;

	getAutoCompactThreshold(model: string): number;

	getContextWindowForModel(model: string): number;

	calculateTokenWarningState(tokenUsage: number, model: string): {
		percentLeft: number;
		isAboveWarningThreshold: boolean;
		isAboveErrorThreshold: boolean;
		isAboveAutoCompactThreshold: boolean;
		isAtBlockingLimit: boolean;
	};

	// ── Cost / token tracking ────────────────────────────────────────────────

	recordTokenUsage(params: {
		sessionId: string;
		model: string;
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
	}): void;

	getSessionCost(sessionId: string): SessionCostSummary;

	getAggregateCost(): SessionCostSummary;

	resetSessionCost(sessionId: string): void;

	formatSessionCost(sessionId: string): string;

	getCostsForModel(model: string): ModelCosts;

	/** Estimate token count without an API call (~4 chars/token for text, 2 for JSON). */
	estimateTokens(text: string): number;

	formatCostUSD(cost: number): string;

	// ── Permissions ─────────────────────────────────────────────────────────

	/** True if an allow-rule with this prefix/pattern would grant arbitrary code execution. */
	isDangerousBashPattern(ruleContent: string): boolean;

	parsePermissionRule(ruleContent: string): ReturnType<typeof parsePermissionRule>;

	matchWildcardPattern(pattern: string, command: string, caseInsensitive?: boolean): boolean;

	suggestionForExactCommand(toolName: string, command: string): PermissionUpdate[];

	suggestionForPrefix(toolName: string, prefix: string): PermissionUpdate[];

	// ── Skills ──────────────────────────────────────────────────────────────

	/** All registered built-in skills (verify, debug, stuck, loop, batch, …). */
	getSkills(): SkillDefinition[];

	/** Look up a skill by name or alias. */
	getSkill(nameOrAlias: string): SkillDefinition | undefined;

	/** Register an additional skill (used by mode-specific modules). */
	registerSkill(skill: SkillDefinition): void;
}

// ─── Implementation ──────────────────────────────────────────────────────────

export class NeuralInverseCCService implements INeuralInverseCCService {

	declare readonly _serviceBrand: undefined;

	private readonly _compactController = new AutoCompactController();
	private readonly _costTracker = new TokenCostTracker();
	private readonly _skills = new Map<string, SkillDefinition>();

	// ── Auto-compact ────────────────────────────────────────────────────────

	shouldAutoCompact(sessionId: string, tokenCount: number, model: string): boolean {
		return this._compactController.shouldAutoCompact(sessionId, tokenCount, model);
	}

	recordCompactSuccess(sessionId: string, result: CompactionResult): void {
		this._compactController.recordSuccess(sessionId, result);
	}

	recordCompactFailure(sessionId: string): number {
		return this._compactController.recordFailure(sessionId);
	}

	getAutoCompactThreshold(model: string): number {
		return getAutoCompactThreshold(model);
	}

	getContextWindowForModel(model: string): number {
		return getContextWindowForModel(model);
	}

	calculateTokenWarningState(tokenUsage: number, model: string) {
		return calculateTokenWarningState(tokenUsage, model);
	}

	// ── Cost / token tracking ────────────────────────────────────────────────

	recordTokenUsage(params: {
		sessionId: string;
		model: string;
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens?: number;
		cacheCreationInputTokens?: number;
	}): void {
		this._costTracker.recordTokenUsage(params);
	}

	getSessionCost(sessionId: string): SessionCostSummary {
		return this._costTracker.getSessionCost(sessionId);
	}

	getAggregateCost(): SessionCostSummary {
		return this._costTracker.getAggregateCost();
	}

	resetSessionCost(sessionId: string): void {
		this._costTracker.resetSessionCost(sessionId);
	}

	formatSessionCost(sessionId: string): string {
		return this._costTracker.formatSessionCost(sessionId);
	}

	getCostsForModel(model: string): ModelCosts {
		return getCostsForModel(model);
	}

	estimateTokens(text: string): number {
		return estimateTokens(text);
	}

	formatCostUSD(cost: number): string {
		return formatCostUSD(cost);
	}

	// ── Permissions ─────────────────────────────────────────────────────────

	isDangerousBashPattern(ruleContent: string): boolean {
		const lower = ruleContent.toLowerCase().trim();
		// Check exact match, prefix `:*` match, trailing `*` / ` *`, or ` -...*`
		for (const pattern of DANGEROUS_BASH_PATTERNS) {
			if (
				lower === pattern ||
				lower === `${pattern}:*` ||
				lower.startsWith(`${pattern} `) ||
				lower.startsWith(`${pattern}\t`)
			) {
				return true;
			}
		}
		return false;
	}

	parsePermissionRule(ruleContent: string) {
		return parsePermissionRule(ruleContent);
	}

	matchWildcardPattern(pattern: string, command: string, caseInsensitive = false): boolean {
		return matchWildcardPattern(pattern, command, caseInsensitive);
	}

	suggestionForExactCommand(toolName: string, command: string): PermissionUpdate[] {
		return suggestionForExactCommand(toolName, command);
	}

	suggestionForPrefix(toolName: string, prefix: string): PermissionUpdate[] {
		return suggestionForPrefix(toolName, prefix);
	}

	// ── Skills ──────────────────────────────────────────────────────────────

	getSkills(): SkillDefinition[] {
		return [...this._skills.values()];
	}

	getSkill(nameOrAlias: string): SkillDefinition | undefined {
		// Direct name lookup
		const direct = this._skills.get(nameOrAlias);
		if (direct) { return direct; }
		// Alias scan
		for (const skill of this._skills.values()) {
			if (skill.aliases?.includes(nameOrAlias)) { return skill; }
		}
		return undefined;
	}

	registerSkill(skill: SkillDefinition): void {
		this._skills.set(skill.name, skill);
	}
}
