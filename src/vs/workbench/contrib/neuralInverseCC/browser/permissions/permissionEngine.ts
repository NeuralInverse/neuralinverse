// @ts-nocheck
/*---------------------------------------------------------------------------------------------
 *  Ported from Claude Code (MIT License - Copyright (c) Anthropic)
 *  Adapted for Neural Inverse IDE — VS Code DI-compatible permission engine
 *--------------------------------------------------------------------------------------------*/

import type {
	DenialTrackingState,
	PermissionBehavior,
	PermissionDecisionReason,
	PermissionResult,
	PermissionRule,
} from '../../common/neuralInverseCCTypes.js';
import { commandMatchesRule, parsePermissionRule } from './shellRuleMatching.js';
import {
	createDenialTrackingState,
	recordDenial,
	recordSuccess,
	shouldFallbackToPrompting,
} from './denialTracker.js';

interface PermissionSessionState {
	rules: PermissionRule[];
	denialState: DenialTrackingState;
}

/**
 * In-memory permission store per session.
 * Workspace rules are persisted separately via the service (IStorageService).
 */
export class PermissionEngine {
	private readonly _sessions = new Map<string, PermissionSessionState>();

	// ─── Session lifecycle ────────────────────────────────────────────────────

	private _getOrCreate(sessionId: string): PermissionSessionState {
		let state = this._sessions.get(sessionId);
		if (!state) {
			state = { rules: [], denialState: createDenialTrackingState() };
			this._sessions.set(sessionId, state);
		}
		return state;
	}

	clearSession(sessionId: string): void {
		this._sessions.delete(sessionId);
	}

	// ─── Rule management ──────────────────────────────────────────────────────

	addRule(sessionId: string, rule: PermissionRule): void {
		const state = this._getOrCreate(sessionId);
		// Deduplicate: replace existing rule for same tool+content+source
		const existing = state.rules.findIndex(
			r => r.toolName === rule.toolName &&
				r.ruleContent === rule.ruleContent &&
				r.source === rule.source
		);
		if (existing !== -1) {
			state.rules[existing] = rule;
		} else {
			state.rules.push(rule);
		}
	}

	removeRule(sessionId: string, toolName: string, ruleContent: string | undefined): void {
		const state = this._sessions.get(sessionId);
		if (!state) { return; }
		state.rules = state.rules.filter(
			r => !(r.toolName === toolName && r.ruleContent === ruleContent)
		);
	}

	getRules(sessionId: string): PermissionRule[] {
		return this._sessions.get(sessionId)?.rules ?? [];
	}

	// ─── Permission check ─────────────────────────────────────────────────────

	check(sessionId: string, toolName: string, commandOrArg?: string): PermissionResult {
		const state = this._getOrCreate(sessionId);

		// Circuit breaker — too many denials, always ask
		if (shouldFallbackToPrompting(state.denialState)) {
			return { behavior: 'ask', reason: 'denial-circuit-breaker' };
		}

		// Check rules from highest priority (session) to lowest (builtin)
		const sources: Array<PermissionRule['source']> = ['session', 'workspace', 'builtin'];
		for (const source of sources) {
			const sourceRules = state.rules.filter(r => r.source === source && r.toolName === toolName);
			for (const rule of sourceRules) {
				if (this._ruleMatches(rule, commandOrArg)) {
					return {
						behavior: rule.behavior === 'always' ? 'allow' : rule.behavior,
						matchedRule: rule,
						reason: (source + '-rule') as PermissionDecisionReason,
					};
				}
			}
		}

		return { behavior: 'ask', reason: 'default-policy' };
	}

	private _ruleMatches(rule: PermissionRule, commandOrArg?: string): boolean {
		if (!rule.ruleContent) {
			// Rule applies to all invocations of this tool
			return true;
		}
		if (!commandOrArg) {
			return false;
		}
		const parsed = parsePermissionRule(rule.ruleContent);
		return commandMatchesRule(commandOrArg, parsed);
	}

	// ─── Denial tracking ──────────────────────────────────────────────────────

	recordDenial(sessionId: string): void {
		const state = this._getOrCreate(sessionId);
		state.denialState = recordDenial(state.denialState);
	}

	recordSuccess(sessionId: string): void {
		const state = this._getOrCreate(sessionId);
		state.denialState = recordSuccess(state.denialState);
	}

	shouldFallbackToPrompting(sessionId: string): boolean {
		const state = this._sessions.get(sessionId);
		if (!state) { return false; }
		return shouldFallbackToPrompting(state.denialState);
	}
}
