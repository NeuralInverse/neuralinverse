/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Checks Agent Types
 *
 * Modeled after PowerMode types. The Checks Agent is a read-only GRC specialist
 * \u2014 no file write tools, no approval dialogs, simplified session model.
 */

// \u2500\u2500\u2500 Session \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IChecksSession {
	readonly id: string;
	status: ChecksSessionStatus;
	messages: IChecksMessage[];
	createdAt: number;
	updatedAt: number;
}

export type ChecksSessionStatus = 'idle' | 'busy' | 'error';

// \u2500\u2500\u2500 Messages \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IChecksMessage {
	readonly id: string;
	readonly sessionId: string;
	readonly role: 'user' | 'assistant';
	readonly createdAt: number;
	parts: IChecksMessagePart[];
	error?: IChecksError;
	tokens?: IChecksTokenUsage;
}

export type IChecksMessagePart =
	| IChecksTextPart
	| IChecksReasoningPart
	| IChecksToolCallPart
	| IChecksStepStartPart
	| IChecksStepFinishPart;

export interface IChecksTextPart {
	readonly type: 'text';
	readonly id: string;
	text: string;
}

export interface IChecksReasoningPart {
	readonly type: 'reasoning';
	readonly id: string;
	text: string;
}

export interface IChecksToolCallPart {
	readonly type: 'tool';
	readonly id: string;
	readonly callId: string;
	readonly toolName: string;
	state: IChecksToolCallState;
}

export type ChecksToolCallStatus = 'pending' | 'running' | 'completed' | 'error';

export interface IChecksToolCallState {
	status: ChecksToolCallStatus;
	input: Record<string, any>;
	output?: string;
	error?: string;
	title?: string;
	time?: { start: number; end?: number };
}

export interface IChecksStepStartPart {
	readonly type: 'step-start';
	readonly id: string;
}

export interface IChecksStepFinishPart {
	readonly type: 'step-finish';
	readonly id: string;
	tokens?: IChecksTokenUsage;
}

export interface IChecksTokenUsage {
	input: number;
	output: number;
}

export interface IChecksError {
	message: string;
}

// \u2500\u2500\u2500 Tool \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IChecksTool {
	readonly id: string;
	readonly description: string;
	readonly parameters: IChecksToolParam[];
	execute(args: Record<string, any>): Promise<string>;
}

export interface IChecksToolParam {
	readonly name: string;
	readonly type: 'string' | 'number' | 'boolean';
	readonly description: string;
	readonly required: boolean;
}

// \u2500\u2500\u2500 UI Events (service \u2192 webview) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type ChecksAgentUIEvent =
	| { type: 'session-created'; session: IChecksSession }
	| { type: 'session-updated'; sessionId: string; status: ChecksSessionStatus }
	| { type: 'message-created'; message: IChecksMessage }
	| { type: 'part-updated'; sessionId: string; messageId: string; part: IChecksMessagePart }
	| { type: 'part-delta'; sessionId: string; messageId: string; partId: string; delta: string }
	| { type: 'error'; error: string };

// \u2500\u2500\u2500 UI Commands (webview \u2192 service) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type ChecksAgentUICommand =
	| { type: 'ready' }
	| { type: 'create-session' }
	| { type: 'send-message'; sessionId: string; text: string }
	| { type: 'cancel'; sessionId: string }
	| { type: 'clear'; sessionId: string }
	| { type: 'prefill'; text: string };
