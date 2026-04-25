/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

/**
 * PowerModeLLMBridge \u2014 adapts the processor's ILLMRequest to the Void IDE
 * ILLMMessageService callback-based API.
 *
 * Uses ILLMMessageService (routes through Electron main process) to avoid
 * browser CORS restrictions. Uses chatMode: 'power' so Power Mode's
 * mcpTools are included via native tool calling.
 *
 * Reads LLM config (provider, model, API key) from IVoidSettingsService.
 */

import { ILLMMessageService } from '../../../void/common/sendLLMMessageService.js';
import type { IVoidSettingsService } from '../../../void/common/voidSettingsService.js';
import {
	LLMChatMessage,
	RawToolCallObj,
} from '../../../void/common/sendLLMMessageTypes.js';
import { InternalToolInfo } from '../../../void/common/prompt/prompts.js';
import { ModelSelection } from '../../../void/common/voidSettingsTypes.js';
import {
	ILLMRequest,
	ILLMStreamResponse,
	ILLMStreamEvent,
	ILLMMessage,
} from './powerModeProcessor.js';

/**
 * Bridge that wraps ILLMMessageService for use by the PowerModeProcessor.
 */
export class PowerModeLLMBridge {

	constructor(
		private readonly llmMessageService: ILLMMessageService,
		_voidSettingsService: IVoidSettingsService,
	) { }

	/**
	 * Convert processor tool schemas into InternalToolInfo format for the LLM service.
	 */
	private _buildToolInfos(tools: Record<string, { description: string; parameters: Record<string, any> }>): InternalToolInfo[] {
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
	 * Convert the processor's ILLMMessage array into plain-text LLMChatMessages.
	 *
	 * Uses simple string content (no tool_use/tool_result blocks) so it works
	 * with any provider (Anthropic, OpenAI, etc). Tool call history and results
	 * are serialized as readable text in the conversation.
	 */
	private _convertMessages(systemPrompt: string, messages: ILLMMessage[]): { system: string; chatMessages: LLMChatMessage[] } {
		const chatMessages: LLMChatMessage[] = [];

		// Prepend system prompt as first message so it reaches ALL providers
		// (OpenAI-compatible path ignores separateSystemMessage)
		chatMessages.push({ role: 'system' as any, content: systemPrompt });

		for (const msg of messages) {
			if (msg.role === 'user') {
				chatMessages.push({ role: 'user', content: msg.content });
			} else if (msg.role === 'assistant') {
				// Flatten tool calls into text so the history is provider-agnostic
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
				// Tool results as plain user messages
				chatMessages.push({
					role: 'user',
					content: `[Tool Result: ${msg.toolCallId}]\n${msg.content}`,
				});
			}
		}

		return { system: systemPrompt, chatMessages };
	}

	/**
	 * Send a request to the LLM and return an async iterable stream of events.
	 * @param modelSelection \u2014 Power Mode's active model (own or fallback to Chat)
	 */
	sendToLLM(request: ILLMRequest, modelSelection: ModelSelection | null): Promise<ILLMStreamResponse> {
		if (!modelSelection) {
			return Promise.resolve({
				stream: (async function* () {
					yield { type: 'error' as const, error: new Error('No Chat model configured. Please select a model in Void Settings.') };
				})(),
			});
		}

		const { system, chatMessages } = this._convertMessages(request.systemPrompt, request.messages);
		const toolInfos = this._buildToolInfos(request.tools);

		// Build the list of ONLY Power Mode tool names
		const powerModeToolNames = toolInfos.map(t => t.name);

		console.log('[PowerMode LLM Bridge] Sending request:', {
			chatMode: 'power',
			toolCount: toolInfos.length,
			toolNames: powerModeToolNames,
			systemPromptLength: system.length,
			systemPromptPreview: system.substring(0, 200),
			messageCount: chatMessages.length,
			modelSelection: modelSelection,
		});

		return new Promise<ILLMStreamResponse>((resolve) => {
			// We'll use a queue + resolver pattern to convert callbacks \u2192 async iterable
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

			// Track previous text/reasoning lengths for delta computation
			let prevText = '';
			let prevReasoning = '';
			let prevToolCalls: RawToolCallObj[] = [];

			this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: chatMessages,
				separateSystemMessage: system,
				// Use 'power' mode \u2014 only includes mcpTools, no Void builtins
				chatMode: 'power',
				modelSelection,
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				mcpTools: toolInfos,
				logging: { loggingName: 'powerMode' },

				onText: ({ fullText, fullReasoning, toolCalls }) => {
					// Emit text deltas
					if (fullText.length > prevText.length) {
						const delta = fullText.slice(prevText.length);
						push({ type: 'text-delta', text: delta });
					}
					prevText = fullText;

					// Emit reasoning deltas
					if (fullReasoning.length > prevReasoning.length) {
						const delta = fullReasoning.slice(prevReasoning.length);
						push({ type: 'reasoning-delta', text: delta });
					}
					prevReasoning = fullReasoning;

					// Check for new completed tool calls
					if (toolCalls) {
						for (const tc of toolCalls) {
							if (tc.isDone) {
								const alreadyEmitted = prevToolCalls.find(
									pt => pt.id === tc.id && pt.isDone
								);
								if (!alreadyEmitted) {
									push({
										type: 'tool-call',
										id: tc.id,
										name: tc.name,
										arguments: JSON.stringify(tc.rawParams),
									});
								}
							}
						}
						prevToolCalls = toolCalls.map(tc => ({ ...tc }));
					}
				},

				onFinalMessage: ({ fullText, fullReasoning, toolCalls }) => {
					// Emit final text
					if (fullText && fullText !== prevText) {
						push({ type: 'text-done', text: fullText });
					}
					if (fullReasoning && fullReasoning !== prevReasoning) {
						push({ type: 'reasoning-done', text: fullReasoning });
					}

					// Emit any remaining tool calls
					if (toolCalls) {
						for (const tc of toolCalls) {
							if (tc.isDone) {
								const alreadyEmitted = prevToolCalls.find(
									pt => pt.id === tc.id && pt.isDone
								);
								if (!alreadyEmitted) {
									push({
										type: 'tool-call',
										id: tc.id,
										name: tc.name,
										arguments: JSON.stringify(tc.rawParams),
									});
								}
							}
						}
					}

					// Finish event
					push({
						type: 'finish',
						finishReason: (toolCalls && toolCalls.length > 0) ? 'tool_calls' : 'stop',
					});
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

			// Build the async iterable from the queue
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
							return new Promise<IteratorResult<ILLMStreamEvent>>(r => {
								resolveNext = r;
							});
						},
					};
				},
			};

			resolve({ stream });
		});
	}
}
