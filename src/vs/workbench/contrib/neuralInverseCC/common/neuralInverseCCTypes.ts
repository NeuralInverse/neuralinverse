/*---------------------------------------------------------------------------------------------
 *  Ported from Claude Code (MIT License - Copyright (c) Anthropic)
 *  Adapted for Neural Inverse IDE by Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared types for the NeuralInverseCC shared service.
 * All AI systems (Power Mode, Checks Agent, Modernisation, Firmware, Sub-Agents) use these.
 * No browser/Node.js deps \u2014 pure TypeScript types only.
 */

// \u2500\u2500\u2500 Conversation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IConversationMessage {
	role: 'user' | 'assistant' | 'tool';
	content: string;
	id?: string;
	toolCallId?: string;
}

// \u2500\u2500\u2500 Bash Security \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface SecurityCheckResult {
	safe: boolean;
	reason?: string;
	/** Which of the 23 CC security categories triggered */
	category?: string;
	checkId?: number;
}

// \u2500\u2500\u2500 Permission Tiers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** Maps CC's 4-tier permission system */
export type PermissionBehavior = 'allow' | 'deny' | 'ask' | 'always';

export interface PermissionRuleValue {
	toolName: string;
	ruleContent?: string;
}

export interface PermissionRule {
	toolName: string;
	behavior: PermissionBehavior;
	/** e.g. 'npm:*' or 'git commit *' \u2014 undefined means "applies to all invocations" */
	ruleContent?: string;
	source: 'session' | 'workspace' | 'builtin';
}

export type PermissionDecisionReason =
	| 'builtin-allow'
	| 'builtin-deny'
	| 'session-rule'
	| 'workspace-rule'
	| 'denial-circuit-breaker'
	| 'default-policy';

export interface PermissionResult {
	behavior: 'allow' | 'deny' | 'ask';
	matchedRule?: PermissionRule;
	reason: PermissionDecisionReason;
}

// \u2500\u2500\u2500 Denial Tracking \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface DenialTrackingState {
	consecutiveDenials: number;
	totalDenials: number;
}

// \u2500\u2500\u2500 Auto-Compact \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** Ported from CC AutoCompactTrackingState */
export interface AutoCompactState {
	compacted: boolean;
	turnCounter: number;
	turnId: string;
	/** Consecutive failures \u2014 circuit breaker stops retrying at MAX_CONSECUTIVE_FAILURES */
	consecutiveFailures?: number;
}

export interface CompactionResult {
	summary: string;
	messageCountBefore: number;
	messageCountAfter: number;
}

// \u2500\u2500\u2500 File History \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface FileHistoryEntry {
	filePath: string;
	backupPath: string;
	/** sha256 of file content at backup time */
	contentHash: string;
	messageId: string;
	timestamp: number;
}

export interface FileHistorySnapshot {
	index: number;
	messageId: string;
	timestamp: number;
	entries: FileHistoryEntry[];
}

export interface FileHistoryState {
	sessionId: string;
	snapshots: FileHistorySnapshot[];
	/** All file paths that have been touched in this session */
	trackedFiles: Set<string>;
}

export interface DiffStats {
	linesAdded: number;
	linesRemoved: number;
	filesChanged: number;
}

// \u2500\u2500\u2500 Token / Cost \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface ModelUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	costUSD: number;
}

export interface SessionCostSummary {
	sessionId: string;
	totalCostUSD: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	byModel: Record<string, ModelUsage>;
	turnCount: number;
}

export interface ModelCosts {
	inputTokens: number;
	outputTokens: number;
	promptCacheWriteTokens: number;
	promptCacheReadTokens: number;
	webSearchRequests: number;
}

// \u2500\u2500\u2500 Permission Updates \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type PermissionUpdateDestination =
	| 'userSettings'
	| 'projectSettings'
	| 'localSettings'
	| 'session'
	| 'cliArg';

export type PermissionUpdate =
	| { type: 'addRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
	| { type: 'replaceRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
	| { type: 'removeRules'; rules: PermissionRuleValue[]; behavior: PermissionBehavior; destination: PermissionUpdateDestination }
	| { type: 'setMode'; mode: string; destination: PermissionUpdateDestination }
	| { type: 'addDirectories'; directories: string[]; destination: PermissionUpdateDestination }
	| { type: 'removeDirectories'; directories: string[]; destination: PermissionUpdateDestination };

// \u2500\u2500\u2500 Skills \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface SkillInvocationContext {
	workingDirectory: string;
	agentId: string;
	sessionId: string;
}

export interface SkillInvocationResult {
	promptText: string;
	skillName: string;
}

export interface SkillDefinition {
	name: string;
	description: string;
	aliases?: string[];
	whenToUse?: string;
	argumentHint?: string;
	allowedTools?: string[];
	userInvocable?: boolean;
	getPromptText(args: string, context: SkillInvocationContext): Promise<string>;
}
