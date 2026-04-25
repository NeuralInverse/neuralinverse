/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ChecksAgentProcessor — the GRC agent execution loop.
 *
 * Adapted from PowerModeProcessor. Simplified because:
 * - All GRC tools are read-only (no approval dialogs needed)
 * - Max 15 steps (compliance queries are focused, not open-ended coding)
 * - No doom-loop detection needed (tools can't modify state to create loops)
 */

import {
	IChecksMessage,
	IChecksMessagePart,
	IChecksTextPart,
	IChecksToolCallPart,
	IChecksStepStartPart,
	IChecksStepFinishPart,
	IChecksTokenUsage,
} from './checksAgentTypes.js';
import { ChecksToolRegistry } from './checksToolRegistry.js';

const MAX_STEPS = 15;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;

// ─── Types shared with the LLM bridge ────────────────────────────────────────

export interface ILLMRequest {
	systemPrompt: string;
	messages: ILLMMessage[];
	tools: Record<string, { description: string; parameters: Record<string, any> }>;
}

export interface ILLMMessage {
	role: 'user' | 'assistant' | 'tool';
	content: string;
	toolCallId?: string;
	toolCalls?: ILLMToolCall[];
}

export interface ILLMToolCall {
	id: string;
	name: string;
	arguments: string; // JSON string
}

export interface ILLMStreamResponse {
	stream: AsyncIterable<ILLMStreamEvent>;
}

export type ILLMStreamEvent =
	| { type: 'text-delta'; text: string }
	| { type: 'text-done'; text: string }
	| { type: 'tool-call'; id: string; name: string; arguments: string }
	| { type: 'finish'; finishReason: string; usage?: { inputTokens: number; outputTokens: number } }
	| { type: 'error'; error: Error };

export interface IProcessorCallbacks {
	onPartCreated(part: IChecksMessagePart): void;
	onPartUpdated(part: IChecksMessagePart): void;
	onTextDelta(partId: string, delta: string): void;
	sendToLLM(request: ILLMRequest): Promise<ILLMStreamResponse>;
}

// ─── Agent Loop ───────────────────────────────────────────────────────────────

/**
 * Run the Checks Agent loop for one user message.
 *
 * Sends to LLM \u2192 streams text + tool calls \u2192 executes tools (no approval) \u2192
 * feeds results back \u2192 repeats until no more tool calls or max steps reached.
 */
export async function runChecksAgentLoop(input: {
	assistantMessage: IChecksMessage;
	sessionMessages: IChecksMessage[];
	toolRegistry: ChecksToolRegistry;
	callbacks: IProcessorCallbacks;
	abort: AbortSignal;
	systemPrompt: string;
}): Promise<'done' | 'error' | 'cancelled'> {
	const { assistantMessage, sessionMessages, toolRegistry, callbacks, abort, systemPrompt } = input;

	let step = 0;
	let idCounter = 0;
	const nextId = () => `cp_${Date.now()}_${++idCounter}`;

	const toolSchemas = toolRegistry.buildToolSchemas();

	// Build conversation history for the LLM from session messages
	const buildMessages = (): ILLMMessage[] => {
		const msgs: ILLMMessage[] = [];
		for (const msg of sessionMessages) {
			if (msg.role === 'user') {
				const text = msg.parts
					.filter((p): p is IChecksTextPart => p.type === 'text')
					.map(p => p.text)
					.join('\n');
				msgs.push({ role: 'user', content: text });
			} else if (msg.role === 'assistant') {
				const textParts = msg.parts.filter((p): p is IChecksTextPart => p.type === 'text');
				const toolParts = msg.parts.filter((p): p is IChecksToolCallPart => p.type === 'tool');

				if (toolParts.length > 0) {
					const text = textParts.map(p => p.text).join('\n');
					msgs.push({
						role: 'assistant',
						content: text || '',
						toolCalls: toolParts.map(t => ({
							id: t.callId,
							name: t.toolName,
							arguments: JSON.stringify(t.state.input),
						})),
					});
					for (const t of toolParts) {
						if (t.state.status === 'completed' || t.state.status === 'error') {
							msgs.push({
								role: 'tool',
								toolCallId: t.callId,
								content: t.state.output ?? t.state.error ?? '',
							});
						}
					}
				} else {
					const text = textParts.map(p => p.text).join('\n');
					if (text) { msgs.push({ role: 'assistant', content: text }); }
				}
			}
		}
		return msgs;
	};

	// ─── Main Loop ────────────────────────────────────────────────────────────

	while (step < MAX_STEPS) {
		if (abort.aborted) { return 'cancelled'; }

		step++;

		// Emit step-start
		const stepStart: IChecksStepStartPart = { type: 'step-start', id: nextId() };
		assistantMessage.parts.push(stepStart);
		callbacks.onPartCreated(stepStart);

		const messages = buildMessages();
		const request: ILLMRequest = { systemPrompt, messages, tools: toolSchemas };

		let currentText: IChecksTextPart | undefined;
		const toolCalls: IChecksToolCallPart[] = [];
		let finishReason = 'unknown';
		let usage: IChecksTokenUsage | undefined;

		let lastError: Error | undefined;
		let succeeded = false;

		for (let retry = 0; retry <= MAX_RETRIES; retry++) {
			if (abort.aborted) { return 'cancelled'; }

			// Reset mutable state for this attempt
			if (retry > 0) {
				currentText = undefined;
				toolCalls.length = 0;
				finishReason = 'unknown';
				usage = undefined;
				await new Promise(r => setTimeout(r, RETRY_DELAY_MS * retry));
			}

			try {
				const response = await callbacks.sendToLLM(request);

				for await (const event of response.stream) {
					if (abort.aborted) { return 'cancelled'; }

					switch (event.type) {
						case 'text-delta': {
							if (!currentText) {
								currentText = { type: 'text', id: nextId(), text: '' };
								assistantMessage.parts.push(currentText);
								callbacks.onPartCreated(currentText);
							}
							currentText.text += event.text;
							callbacks.onTextDelta(currentText.id, event.text);
							break;
						}

						case 'text-done': {
							if (currentText) {
								currentText.text = event.text;
								callbacks.onPartUpdated(currentText);
							}
							break;
						}

						case 'tool-call': {
							const toolPart: IChecksToolCallPart = {
								type: 'tool',
								id: nextId(),
								callId: event.id,
								toolName: event.name,
								state: {
									status: 'pending',
									input: (() => { try { return JSON.parse(event.arguments); } catch { return {}; } })(),
									time: { start: Date.now() },
								},
							};
							assistantMessage.parts.push(toolPart);
							callbacks.onPartCreated(toolPart);
							toolCalls.push(toolPart);
							break;
						}

						case 'finish': {
							finishReason = event.finishReason;
							if (event.usage) {
								usage = { input: event.usage.inputTokens, output: event.usage.outputTokens };
							}
							break;
						}

						case 'error': {
							throw event.error;
						}
					}
				}

				succeeded = true;
				break; // stream completed — exit retry loop
			} catch (e: any) {
				lastError = e;
				// Only retry on transient errors (not model config / validation errors)
				const msg = (e.message ?? '').toLowerCase();
				const isTransient = msg.includes('timeout') || msg.includes('connection')
					|| msg.includes('rate') || msg.includes('503') || msg.includes('429')
					|| msg.includes('network') || msg.includes('econnreset') || msg.includes('socket');
				if (!isTransient || retry >= MAX_RETRIES) {
					break; // non-transient or exhausted retries
				}
			}
		}

		if (!succeeded && lastError) {
			const errText: IChecksTextPart = {
				type: 'text',
				id: nextId(),
				text: `\nError: ${lastError.message}`,
			};
			assistantMessage.parts.push(errText);
			callbacks.onPartCreated(errText);

			const stepFinish: IChecksStepFinishPart = { type: 'step-finish', id: nextId(), tokens: usage };
			assistantMessage.parts.push(stepFinish);
			callbacks.onPartCreated(stepFinish);

			return 'error';
		}

		// ── Execute tool calls ─────────────────────────────────────────────

		for (const toolPart of toolCalls) {
			if (abort.aborted) { return 'cancelled'; }

			toolPart.state.status = 'running';
			callbacks.onPartUpdated(toolPart);

			const tool = toolRegistry.get(toolPart.toolName);

			if (!tool) {
				// Don't silently fail — inject a corrective result that forces the model
				// to reason about what tools it actually has and retry correctly.
				const available = toolRegistry.getToolNames().join(', ');
				toolPart.state.status = 'error';
				toolPart.state.error = [
					`"${toolPart.toolName}" does not exist in this agent.`,
					``,
					`You have NO terminal, bash, or shell access.`,
					`Your available tools are: ${available}`,
					``,
					`Reason through which of these tools answers the question, then call it.`,
				].join('\n');
				toolPart.state.time = { ...toolPart.state.time!, end: Date.now() };
				callbacks.onPartUpdated(toolPart);
				continue;
			}

			try {
				const output = await tool.execute(toolPart.state.input);
				toolPart.state.status = 'completed';
				toolPart.state.output = output;
				toolPart.state.title = `${toolPart.toolName}`;
			} catch (e: any) {
				toolPart.state.status = 'error';
				toolPart.state.error = e.message;
			}

			toolPart.state.time = { ...toolPart.state.time!, end: Date.now() };
			callbacks.onPartUpdated(toolPart);
		}

		// ── Emit step-finish ───────────────────────────────────────────────

		const stepFinish: IChecksStepFinishPart = { type: 'step-finish', id: nextId(), tokens: usage };
		assistantMessage.parts.push(stepFinish);
		callbacks.onPartCreated(stepFinish);

		// ── Decide whether to loop ─────────────────────────────────────────

		if (finishReason === 'stop' || toolCalls.length === 0) {
			return 'done';
		}

		if (finishReason === 'cancelled') {
			return 'cancelled';
		}

		// Tool calls were made — loop to feed results back
	}

	return 'done';
}
