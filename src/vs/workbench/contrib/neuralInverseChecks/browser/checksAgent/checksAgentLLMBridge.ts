/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ChecksAgentLLMBridge \u2014 adapts ILLMRequest to the Void ILLMMessageService API.
 *
 * Adapted from PowerModeLLMBridge. Key differences:
 * - Uses `'Checks'` feature model selection (falls back to 'Chat')
 * - Uses chatMode: 'power' for native tool-calling via mcpTools
 * - No reasoning delta support needed (compliance agent)
 */

import { ILLMMessageService } from '../../../void/common/sendLLMMessageService.js';
import type { IVoidSettingsService } from '../../../void/common/voidSettingsService.js';
import { LLMChatMessage, RawToolCallObj } from '../../../void/common/sendLLMMessageTypes.js';
import { InternalToolInfo } from '../../../void/common/prompt/prompts.js';
import { ModelSelection } from '../../../void/common/voidSettingsTypes.js';
import { ILLMRequest, ILLMStreamResponse, ILLMStreamEvent, ILLMMessage } from './checksAgentProcessor.js';

export class ChecksAgentLLMBridge {

	constructor(
		private readonly llmMessageService: ILLMMessageService,
		private readonly voidSettingsService: IVoidSettingsService,
	) { }

	/**
	 * Get the active model selection for the Checks Agent.
	 * Uses 'Checks' feature model, falls back to 'Chat'.
	 */
	getModelSelection(): ModelSelection | null {
		return this.voidSettingsService.state.modelSelectionOfFeature['Checks']
			?? this.voidSettingsService.state.modelSelectionOfFeature['Chat']
			?? null;
	}

	/**
	 * Convert tool schemas into InternalToolInfo[] for mcpTools.
	 */
	private _buildToolInfos(
		tools: Record<string, { description: string; parameters: Record<string, any> }>
	): InternalToolInfo[] {
		const infos: InternalToolInfo[] = [];
		for (const [name, schema] of Object.entries(tools)) {
			const params: Record<string, { description: string }> = {};
			const props = schema.parameters?.properties ?? {};
			for (const [paramName, paramSchema] of Object.entries(props) as [string, any][]) {
				params[paramName] = { description: paramSchema.description ?? '' };
			}
			infos.push({ name, description: schema.description, params });
		}
		return infos;
	}

	/**
	 * Convert ILLMMessage[] to LLMChatMessage[] with system prompt prepended.
	 * Tool results are flattened to plain text (provider-agnostic).
	 */
	private _convertMessages(
		systemPrompt: string,
		messages: ILLMMessage[]
	): { chatMessages: LLMChatMessage[] } {
		const chatMessages: LLMChatMessage[] = [];
		chatMessages.push({ role: 'system' as any, content: systemPrompt });

		for (const msg of messages) {
			if (msg.role === 'user') {
				chatMessages.push({ role: 'user', content: msg.content });
			} else if (msg.role === 'assistant') {
				let text = msg.content || '';
				if (msg.toolCalls && msg.toolCalls.length > 0) {
					for (const tc of msg.toolCalls) {
						text += `\n[Tool Call: ${tc.name}]\n${tc.arguments}\n`;
					}
				}
				if (text) {
					chatMessages.push({ role: 'assistant', content: text });
				}
			} else if (msg.role === 'tool') {
				chatMessages.push({
					role: 'user',
					content: `[Tool Result: ${msg.toolCallId}]\n${msg.content}`,
				});
			}
		}

		return { chatMessages };
	}

	/**
	 * Send a request to the LLM and return an async iterable stream of events.
	 * @param modelOverride Optional model selection override (from setModel). Falls back to getModelSelection().
	 */
	sendToLLM(request: ILLMRequest, modelOverride?: ModelSelection | null): Promise<ILLMStreamResponse> {
		const modelSelection = modelOverride ?? this.getModelSelection();

		if (!modelSelection) {
			return Promise.resolve({
				stream: (async function* () {
					yield {
						type: 'error' as const,
						error: new Error('No model configured for Checks. Please select a model in Void Settings \u2192 Checks.'),
					};
				})(),
			});
		}

		const { chatMessages } = this._convertMessages(request.systemPrompt, request.messages);
		const toolInfos = this._buildToolInfos(request.tools);

		return new Promise<ILLMStreamResponse>((resolve) => {
			const eventQueue: ILLMStreamEvent[] = [];
			let resolveNext: ((value: IteratorResult<ILLMStreamEvent>) => void) | null = null;
			let done = false;

			const push = (event: ILLMStreamEvent) => {
				if (resolveNext) {
					const r = resolveNext;
					resolveNext = null;
					r({ value: event, done: false });
				} else {
					eventQueue.push(event);
				}
			};

			const finish = () => {
				done = true;
				if (resolveNext) {
					const r = resolveNext;
					resolveNext = null;
					r({ value: undefined as any, done: true });
				}
			};

			let prevText = '';
			let prevToolCalls: RawToolCallObj[] = [];

			this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: chatMessages,
				separateSystemMessage: request.systemPrompt,
				chatMode: 'checks',
				modelSelection,
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				mcpTools: toolInfos,
				logging: { loggingName: 'checksAgent' },

				onText: ({ fullText, toolCalls }) => {
					if (fullText.length > prevText.length) {
						push({ type: 'text-delta', text: fullText.slice(prevText.length) });
					}
					prevText = fullText;

					if (toolCalls) {
						for (const tc of toolCalls) {
							if (tc.isDone) {
								const alreadyEmitted = prevToolCalls.find(pt => pt.id === tc.id && pt.isDone);
								if (!alreadyEmitted) {
									push({ type: 'tool-call', id: tc.id, name: tc.name, arguments: JSON.stringify(tc.rawParams) });
								}
							}
						}
						prevToolCalls = toolCalls.map(tc => ({ ...tc }));
					}
				},

				onFinalMessage: ({ fullText, toolCalls }) => {
					if (fullText && fullText !== prevText) {
						push({ type: 'text-done', text: fullText });
					}
					if (toolCalls) {
						for (const tc of toolCalls) {
							if (tc.isDone) {
								const alreadyEmitted = prevToolCalls.find(pt => pt.id === tc.id && pt.isDone);
								if (!alreadyEmitted) {
									push({ type: 'tool-call', id: tc.id, name: tc.name, arguments: JSON.stringify(tc.rawParams) });
								}
							}
						}
					}
					push({ type: 'finish', finishReason: (toolCalls && toolCalls.length > 0) ? 'tool_calls' : 'stop' });
					finish();
				},

				onError: ({ message }) => {
					push({ type: 'error', error: new Error(message) });
					finish();
				},

				onAbort: () => {
					push({ type: 'finish', finishReason: 'cancelled' });
					finish();
				},
			});

			const stream: AsyncIterable<ILLMStreamEvent> = {
				[Symbol.asyncIterator]() {
					return {
						next(): Promise<IteratorResult<ILLMStreamEvent>> {
							if (eventQueue.length > 0) {
								return Promise.resolve({ value: eventQueue.shift()!, done: false });
							}
							if (done) {
								return Promise.resolve({ value: undefined as any, done: true });
							}
							return new Promise<IteratorResult<ILLMStreamEvent>>(r => { resolveNext = r; });
						},
					};
				},
			};

			resolve({ stream });
		});
	}
}
