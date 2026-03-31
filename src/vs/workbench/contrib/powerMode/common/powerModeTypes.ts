/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

// Session types
export interface IPowerSession {
	readonly id: string;
	readonly title: string;
	readonly agentId: string;       // 'build' | 'plan' | custom
	readonly directory: string;
	readonly createdAt: number;
	updatedAt: number;
	status: PowerSessionStatus;
	messages: IPowerMessage[];
	summary?: ISessionSummary;
	/** When true, write/edit/bash tools are blocked in this session */
	planMode?: boolean;
	/** Set when the session has entered a git worktree */
	worktree?: IPowerWorktreeInfo;
}

export interface IPowerWorktreeInfo {
	path: string;
	branch: string;
	originalDirectory: string;
}

export type PowerSessionStatus = 'idle' | 'busy' | 'error' | 'compact';

export interface ISessionSummary {
	additions: number;
	deletions: number;
	files: number;
}

// Message types (following OpenCode's message-v2 model)
export interface IPowerMessage {
	readonly id: string;
	readonly sessionId: string;
	readonly role: 'user' | 'assistant';
	readonly createdAt: number;
	parts: IPowerMessagePart[];
	// Assistant-specific
	agentId?: string;
	cost?: number;
	tokens?: ITokenUsage;
	error?: IPowerError;
}

export type IPowerMessagePart =
	| ITextPart
	| IReasoningPart
	| IToolCallPart
	| IStepStartPart
	| IStepFinishPart;

export interface ITextPart {
	readonly type: 'text';
	readonly id: string;
	text: string;
}

export interface IReasoningPart {
	readonly type: 'reasoning';
	readonly id: string;
	text: string;
}

export interface IToolCallPart {
	readonly type: 'tool';
	readonly id: string;
	readonly callId: string;
	readonly toolName: string;
	state: IToolCallState;
}

export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'error';

export interface IToolCallState {
	status: ToolCallStatus;
	input: Record<string, any>;
	output?: string;
	error?: string;
	title?: string;
	metadata?: Record<string, any>;
	time?: { start: number; end?: number };
}

export interface IStepStartPart {
	readonly type: 'step-start';
	readonly id: string;
}

export interface IStepFinishPart {
	readonly type: 'step-finish';
	readonly id: string;
	readonly reason: string;
	tokens?: ITokenUsage;
	cost?: number;
}

export interface ITokenUsage {
	input: number;
	output: number;
	reasoning?: number;
	cache?: { read: number; write: number };
}

// Tool types (matching OpenCode's Tool.Info pattern)
export interface IPowerTool {
	readonly id: string;
	readonly description: string;
	readonly parameters: IPowerToolParameter[];
	execute(args: Record<string, any>, ctx: IToolContext): Promise<IToolResult>;
}

export interface IPowerToolParameter {
	name: string;
	type: string;
	description: string;
	required: boolean;
}

export interface IToolContext {
	sessionId: string;
	messageId: string;
	agentId: string;
	abort: AbortSignal;
	metadata(input: { title?: string; metadata?: Record<string, any> }): void;
}

export interface IToolResult {
	title: string;
	output: string;
	metadata: Record<string, any>;
}

// Agent definition (matching OpenCode's Agent.Info)
export interface IPowerAgent {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly mode: 'primary' | 'subagent';
	readonly systemPrompt?: string;
	readonly temperature?: number;
	readonly maxSteps?: number;
	permissions: IPowerPermissions;
}

export interface IPowerPermissions {
	// Tool ID -> 'allow' | 'deny' | 'ask'
	tools: Record<string, 'allow' | 'deny' | 'ask'>;
	// Patterns for file access
	readPatterns?: string[];
	writePatterns?: string[];
}

// Error types
export interface IPowerError {
	name: string;
	message: string;
	retryable?: boolean;
}

// Permission types
export type ToolPermissionDecision = 'allow' | 'allow-all' | 'deny';

export interface IPermissionRequest {
	requestId: string;
	sessionId: string;
	toolName: string;
	/** Key fields from the tool input to show the user */
	preview: string;
}

// UI event types (for webview communication)
export type PowerModeUIEvent =
	| { type: 'session-created'; session: IPowerSession }
	| { type: 'session-updated'; sessionId: string; status: PowerSessionStatus }
	| { type: 'message-created'; message: IPowerMessage }
	| { type: 'part-updated'; sessionId: string; messageId: string; part: IPowerMessagePart }
	| { type: 'part-delta'; sessionId: string; messageId: string; partId: string; field: string; delta: string }
	| { type: 'sessions-list'; sessions: IPowerSession[] }
	| { type: 'permission-request'; request: IPermissionRequest }
	| { type: 'user-question'; questionId: string; sessionId: string; question: string }
	| { type: 'bus-message'; from: string; to: string | '*'; messageType: string; content: string }
	| { type: 'error'; error: string };

export type PowerModeUICommand =
	| { type: 'send-message'; sessionId: string; text: string }
	| { type: 'create-session'; agentId?: string }
	| { type: 'switch-session'; sessionId: string }
	| { type: 'cancel'; sessionId: string }
	| { type: 'list-sessions' }
	| { type: 'ready' };
