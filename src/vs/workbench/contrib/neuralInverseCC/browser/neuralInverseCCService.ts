/*---------------------------------------------------------------------------------------------
 *  NeuralInverseCC \u2014 shared Claude Code capability service
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
	PermissionResult,
	PermissionRule,
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
import { PermissionEngine } from './permissions/permissionEngine.js';
import {
	parsePermissionRule,
	matchWildcardPattern,
	suggestionForExactCommand,
	suggestionForPrefix,
} from './permissions/shellRuleMatching.js';

// \u2500\u2500\u2500 Service contract \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const INeuralInverseCCService = createDecorator<INeuralInverseCCService>('neuralInverseCCService');

export interface INeuralInverseCCService {

	readonly _serviceBrand: undefined;

	// \u2500\u2500 Auto-compact \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

	// \u2500\u2500 Cost / token tracking \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

	// \u2500\u2500 Permissions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** True if an allow-rule with this prefix/pattern would grant arbitrary code execution. */
	isDangerousBashPattern(ruleContent: string): boolean;

	parsePermissionRule(ruleContent: string): ReturnType<typeof parsePermissionRule>;

	matchWildcardPattern(pattern: string, command: string, caseInsensitive?: boolean): boolean;

	suggestionForExactCommand(toolName: string, command: string): PermissionUpdate[];

	suggestionForPrefix(toolName: string, prefix: string): PermissionUpdate[];

	// \u2500\u2500 Permission engine \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Full priority-based permission evaluation: session rules \u2192 workspace rules \u2192 builtin. */
	evaluatePermission(sessionId: string, toolName: string, commandOrArg?: string): PermissionResult;

	/** Add a rule to the per-session permission engine. */
	addPermissionRule(sessionId: string, rule: PermissionRule): void;

	/** Remove a rule from the per-session permission engine. */
	removePermissionRule(sessionId: string, toolName: string, ruleContent?: string): void;

	/** Record that a tool invocation was denied (for denial circuit-breaker). */
	recordPermissionDenial(sessionId: string): void;

	/** Record that a tool invocation was allowed (resets denial counter). */
	recordPermissionSuccess(sessionId: string): void;

	/** Get all permission rules stored for this session. */
	getPermissionRules(sessionId: string): PermissionRule[];

	/** Clear all permission state for a session on clear/delete. */
	clearPermissionSession(sessionId: string): void;

	// \u2500\u2500 Skills \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** All registered built-in skills (verify, debug, stuck, loop, batch, \u2026). */
	getSkills(): SkillDefinition[];

	/** Look up a skill by name or alias. */
	getSkill(nameOrAlias: string): SkillDefinition | undefined;

	/** Register an additional skill (used by mode-specific modules). */
	registerSkill(skill: SkillDefinition): void;
}

// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class NeuralInverseCCService implements INeuralInverseCCService {

	declare readonly _serviceBrand: undefined;

	private readonly _compactController = new AutoCompactController();
	private readonly _costTracker = new TokenCostTracker();
	private readonly _permissionEngine = new PermissionEngine();
	private readonly _skills = new Map<string, SkillDefinition>();

	constructor() {
		// Register basic skills synchronously so they're available immediately
		this._registerBasicSkills();
	}

	private _registerBasicSkills(): void {
		// Register essential IDE skills that don't need async loading
		const basicSkills: SkillDefinition[] = [
			{
				name: 'verify',
				description: 'Verify code changes work correctly',
				aliases: ['test', 'check'],
				argumentHint: '[what to verify]',
				userInvocable: true,
				async getPromptText(args: string) {
					return `Verification checklist:\n\n${args || 'General verification'}\n\n1. Run tests\n2. Manual testing\n3. Edge cases\n4. Integration\n5. Performance\n6. Documentation`;
				},
			},
			{
				name: 'explain',
				description: 'Explain code, concepts, or architectural decisions',
				aliases: ['doc', 'why'],
				argumentHint: '[what to explain]',
				userInvocable: true,
				async getPromptText(args: string) {
					return `Explain: ${args || 'Please specify'}\n\n1. Overview\n2. Purpose\n3. How it works\n4. Key concepts\n5. Gotchas\n6. Examples`;
				},
			},
			{
				name: 'review',
				description: 'Code review with checklist',
				aliases: ['lint'],
				argumentHint: '[file]',
				userInvocable: true,
				async getPromptText(args: string) {
					return `Code review: ${args || 'Current changes'}\n\n1. Correctness\n2. Style\n3. Performance\n4. Security\n5. Testing\n6. Documentation\n7. Maintainability`;
				},
			},
			{
				name: 'search',
				description: 'Find code or information in the codebase',
				aliases: ['find', 'locate'],
				argumentHint: '<what to search for>',
				userInvocable: true,
				async getPromptText(args: string) {
					return `Search for: ${args}\n\nI'll use Grep, Glob, and symbol search to locate what you need.`;
				},
			},
			{
				name: 'plan',
				description: 'Create implementation plan',
				aliases: ['design'],
				argumentHint: '<feature>',
				userInvocable: true,
				async getPromptText(args: string) {
					return `Plan: ${args}\n\n1. Requirements\n2. Architecture\n3. Dependencies\n4. Risks\n5. Tasks\n6. Testing`;
				},
			},
			{
				name: 'optimize',
				description: 'Analyze and improve performance',
				aliases: ['perf'],
				argumentHint: '[code]',
				userInvocable: true,
				async getPromptText(args: string) {
					return `Optimize: ${args || 'Current code'}\n\n1. Profile\n2. Hotspots\n3. Algorithm\n4. Memory\n5. Caching`;
				},
			},
			{
				name: 'commit',
				description: 'Generate git commit message',
				aliases: ['commit-msg'],
				userInvocable: true,
				async getPromptText() {
					return 'Generate a commit message:\n\nFormat:\n<type>: <summary>\n\nTypes: feat, fix, refactor, docs, test, chore';
				},
			},
			{
				name: 'simplify',
				description: 'Simplify complex code',
				aliases: ['refactor', 'cleanup'],
				argumentHint: '[file]',
				userInvocable: true,
				async getPromptText(args: string) {
					return `Simplify: ${args || 'Current code'}\n\nLook for:\n1. Unnecessary complexity\n2. Duplication\n3. Unclear naming\n4. Over-engineering\n5. Dead code`;
				},
			},
			{
				name: 'debug',
				description: 'Systematic debugging approach',
				aliases: ['fix', 'troubleshoot'],
				argumentHint: '[error]',
				userInvocable: true,
				async getPromptText(args: string) {
					return `Debug: ${args || 'General'}\n\nSteps:\n1. Reproduce\n2. Isolate\n3. Observe\n4. Hypothesis\n5. Test\n6. Fix`;
				},
			},
			{
				name: 'remember',
				description: 'Remember project context',
				aliases: ['note', 'save'],
				argumentHint: '<what to remember>',
				userInvocable: true,
				async getPromptText(args: string) {
					return `Remember: ${args}\n\nI'll store this for future conversations: patterns, decisions, pitfalls, preferences.`;
				},
			},
		];

		for (const skill of basicSkills) {
			this._skills.set(skill.name, skill);
		}
	}

	// \u2500\u2500 Auto-compact \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

	// \u2500\u2500 Cost / token tracking \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

	// \u2500\u2500 Permissions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

	// \u2500\u2500 Permission engine \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	evaluatePermission(sessionId: string, toolName: string, commandOrArg?: string): PermissionResult {
		return this._permissionEngine.check(sessionId, toolName, commandOrArg);
	}

	addPermissionRule(sessionId: string, rule: PermissionRule): void {
		this._permissionEngine.addRule(sessionId, rule);
	}

	removePermissionRule(sessionId: string, toolName: string, ruleContent?: string): void {
		this._permissionEngine.removeRule(sessionId, toolName, ruleContent);
	}

	recordPermissionDenial(sessionId: string): void {
		this._permissionEngine.recordDenial(sessionId);
	}

	recordPermissionSuccess(sessionId: string): void {
		this._permissionEngine.recordSuccess(sessionId);
	}

	getPermissionRules(sessionId: string): PermissionRule[] {
		return this._permissionEngine.getRules(sessionId);
	}

	clearPermissionSession(sessionId: string): void {
		this._permissionEngine.clearSession(sessionId);
	}

	// \u2500\u2500 Skills \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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
