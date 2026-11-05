/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

/**
 * PowerModeProcessor — the core agent execution loop.
 *
 * Modeled after OpenCode's SessionProcessor. This is the brain that:
 * 1. Sends messages to the LLM
 * 2. Streams back text + tool calls
 * 3. Executes tool calls
 * 4. Feeds results back to the LLM
 * 5. Loops until the agent is done or max steps reached
 *
 * The processor is stateless — all state is written into IPowerMessage parts
 * and emitted via callbacks. The PowerModeService owns the session state.
 */

import {
	IPowerMessage,
	IPowerMessagePart,
	ITextPart,
	IReasoningPart,
	IToolCallPart,
	IStepStartPart,
	IStepFinishPart,
	IPowerAgent,
	IToolContext,
	ITokenUsage,
	ToolPermissionDecision,
} from '../../common/powerModeTypes.js';
import { PowerToolRegistry } from '../tools/powerToolRegistry.js';
import { ICompactionService } from './compaction/compactionService.js';
import { ISummarizationLLM } from './compaction/conversationSummarizer.js';

/** Tools that require user approval before execution */
const TOOLS_REQUIRING_APPROVAL = new Set(['bash', 'write', 'edit', 'web_preview', 'web_qa_loop', 'multi_file_edit', 'self_heal_code', 'visual_diff', 'parallel_sub_agent', 'code_archaeology', 'debugger']);

const MAX_STEPS_DEFAULT = 200;
const DOOM_LOOP_THRESHOLD = 3;

export interface IProcessorCallbacks {
	/** Called when a new part is added to the assistant message */
	onPartCreated(part: IPowerMessagePart): void;
	/** Called when an existing part is updated */
	onPartUpdated(part: IPowerMessagePart): void;
	/** Called for streaming text deltas */
	onTextDelta(partId: string, delta: string): void;
	/** Called to send a message to the LLM and get a streaming response */
	sendToLLM(request: ILLMRequest): Promise<ILLMStreamResponse>;
	/** Called when compaction occurs (for UI notification) */
	onCompaction?(tokensBefore: number, tokensAfter: number, stepsCompacted: number): void;
	/**
	 * Called before executing a tool that requires approval.
	 * Returns 'allow', 'allow-all' (skip future asks this session), or 'deny' (cancel).
	 */
	askPermission(toolName: string, input: Record<string, any>): Promise<ToolPermissionDecision>;
	/**
	 * Optional: called at the start of each step to inject queued inter-agent messages.
	 * Messages are prepended as user turns before the LLM call.
	 */
	getPendingMessages?(): string[];
}

export interface ILLMRequest {
	systemPrompt: string;
	messages: ILLMMessage[];
	tools: Record<string, { description: string; parameters: Record<string, any> }>;
	temperature?: number;
	maxTokens?: number;
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
	/** Async iterator over stream events */
	stream: AsyncIterable<ILLMStreamEvent>;
}

export type ILLMStreamEvent =
	| { type: 'text-delta'; text: string }
	| { type: 'text-done'; text: string }
	| { type: 'reasoning-delta'; text: string }
	| { type: 'reasoning-done'; text: string }
	| { type: 'tool-call'; id: string; name: string; arguments: string }
	| { type: 'finish'; usage?: { inputTokens: number; outputTokens: number }; finishReason: string }
	| { type: 'error'; error: Error };

/**
 * Run the agent loop for a single session message.
 *
 * This function mutates the assistantMessage in place (adding parts)
 * and calls the callbacks for real-time UI updates.
 */
export async function runAgentLoop(input: {
	agent: IPowerAgent;
	assistantMessage: IPowerMessage;
	sessionMessages: IPowerMessage[];
	toolRegistry: PowerToolRegistry;
	callbacks: IProcessorCallbacks;
	abort: AbortSignal;
	workingDirectory: string;
	systemPrompt: string;
	compactionService?: ICompactionService;
	summarizationLLM?: ISummarizationLLM;
}): Promise<'done' | 'error' | 'cancelled'> {
	const { agent, assistantMessage, sessionMessages, toolRegistry, callbacks, abort, systemPrompt, compactionService, summarizationLLM } = input;
	const maxSteps = agent.maxSteps ?? MAX_STEPS_DEFAULT;
	let step = 0;
	let idCounter = 0;
	const nextId = () => `pp_${Date.now()}_${++idCounter}`;

	// Get available tools for this agent
	const availableTools = toolRegistry.forAgent(agent.permissions);
	const toolSchemas = toolRegistry.buildToolSchemas(availableTools);

	// Track whether the user has approved all tools for this session
	let autoApproveAll = false;

	// Build conversation history for the LLM
	const buildMessages = (): ILLMMessage[] => {
		const msgs: ILLMMessage[] = [];
		for (const msg of effectiveSessionMessages) {
			if (msg.role === 'user') {
				const text = msg.parts
					.filter((p): p is ITextPart => p.type === 'text')
					.map(p => p.text)
					.join('\n');
				msgs.push({ role: 'user', content: text });
			} else if (msg.role === 'assistant') {
				// Reconstruct assistant message with tool calls
				const textParts = msg.parts.filter((p): p is ITextPart => p.type === 'text');
				const toolParts = msg.parts.filter((p): p is IToolCallPart => p.type === 'tool');

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
					// Add tool results
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
					if (text) {
						msgs.push({ role: 'assistant', content: text });
					}
				}
			}
		}
		return msgs;
	};

	// ─── Compaction state ────────────────────────────────────────────────
	let effectiveSessionMessages = sessionMessages;

	// ─── Main Loop ───────────────────────────────────────────────────────

	while (step < maxSteps) {
		if (abort.aborted) { return 'cancelled'; }

		step++;

		// ── Pre-step compaction check ────────────────────────────────
		if (compactionService && step > 1) {
			if (compactionService.shouldCompact(systemPrompt, effectiveSessionMessages)) {
				try {
					const result = await compactionService.compact(
						systemPrompt,
						effectiveSessionMessages,
						summarizationLLM ?? null,
					);
					if (result.success && result.stepsCompacted > 0) {
						effectiveSessionMessages = compactionService.getCompactedMessages(
							systemPrompt, effectiveSessionMessages
						);
						callbacks.onCompaction?.(result.tokensBefore, result.tokensAfter, result.stepsCompacted);
					}
				} catch {
					// Compaction failure is non-fatal — continue with full history
				}
			}
		}

		// ── Drain inter-agent message queue ─────────────────────────
		// Messages queued via send_message are injected as user turns before the LLM call.
		if (callbacks.getPendingMessages && step > 1) {
			const queued = callbacks.getPendingMessages();
			for (const qm of queued) {
				const injectId = nextId();
				effectiveSessionMessages.push({
					id: injectId,
					sessionId: assistantMessage.sessionId,
					role: 'user',
					createdAt: Date.now(),
					parts: [{ type: 'text', id: nextId(), text: `[inter-agent message]: ${qm}` }],
				} as import('../../common/powerModeTypes.js').IPowerMessage);
			}
		}

		// Emit step-start
		const stepStartPart: IStepStartPart = { type: 'step-start', id: nextId() };
		assistantMessage.parts.push(stepStartPart);
		callbacks.onPartCreated(stepStartPart);

		// Build request
		const messages = buildMessages();
		const request: ILLMRequest = {
			systemPrompt,
			messages,
			tools: toolSchemas,
			temperature: agent.temperature,
		};

		let currentText: ITextPart | undefined;
		let currentReasoning: IReasoningPart | undefined;
		const toolCalls: IToolCallPart[] = [];
		let finishReason = 'unknown';
		let usage: ITokenUsage | undefined;

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
						currentText = undefined;
						break;
					}

					case 'reasoning-delta': {
						if (!currentReasoning) {
							currentReasoning = { type: 'reasoning', id: nextId(), text: '' };
							assistantMessage.parts.push(currentReasoning);
							callbacks.onPartCreated(currentReasoning);
						}
						currentReasoning.text += event.text;
						callbacks.onTextDelta(currentReasoning.id, event.text);
						break;
					}

					case 'reasoning-done': {
						if (currentReasoning) {
							currentReasoning.text = event.text;
							callbacks.onPartUpdated(currentReasoning);
						}
						currentReasoning = undefined;
						break;
					}

					case 'tool-call': {
						let args: Record<string, any>;
						try {
							args = JSON.parse(event.arguments);
						} catch {
							args = { _raw: event.arguments };
						}

						const toolPart: IToolCallPart = {
							type: 'tool',
							id: nextId(),
							callId: event.id,
							toolName: event.name,
							state: {
								status: 'pending',
								input: args,
							},
						};
						assistantMessage.parts.push(toolPart);
						toolCalls.push(toolPart);
						callbacks.onPartCreated(toolPart);
						break;
					}

					case 'finish': {
						finishReason = event.finishReason;
						if (event.usage) {
							usage = {
								input: event.usage.inputTokens,
								output: event.usage.outputTokens,
							};
						}
						break;
					}

					case 'error': {
						throw event.error;
					}
				}
			}

		} catch (err: any) {
			const errorText: ITextPart = {
				type: 'text',
				id: nextId(),
				text: `[Error] ${err?.message ?? String(err)}`,
			};
			assistantMessage.parts.push(errorText);
			callbacks.onPartCreated(errorText);
			assistantMessage.error = { name: err?.name ?? 'Error', message: err?.message ?? String(err) };
			return 'error';
		}

		// ─── Execute tool calls ──────────────────────────────────────────

		if (toolCalls.length > 0) {
			for (const toolPart of toolCalls) {
				if (abort.aborted) { return 'cancelled'; }

				const tool = toolRegistry.get(toolPart.toolName);
				if (!tool) {
					toolPart.state = {
						...toolPart.state,
						status: 'error',
						error: `Unknown tool: ${toolPart.toolName}. You do NOT have access to this tool. Only use these tools: ${availableTools.map(t => t.id).join(', ')}`,
						time: { start: Date.now(), end: Date.now() },
					};
					callbacks.onPartUpdated(toolPart);
					continue;
				}

				// ── Permission gate ──────────────────────────────────
				if (!autoApproveAll && TOOLS_REQUIRING_APPROVAL.has(toolPart.toolName)) {
					const decision = await callbacks.askPermission(toolPart.toolName, toolPart.state.input);
					if (decision === 'deny') {
						toolPart.state = {
							...toolPart.state,
							status: 'error',
							error: 'Permission denied by user.',
							time: { start: Date.now(), end: Date.now() },
						};
						callbacks.onPartUpdated(toolPart);
						return 'cancelled';
					}
					if (decision === 'allow-all') {
						autoApproveAll = true;
					}
				}

				// Mark as running
				toolPart.state = {
					...toolPart.state,
					status: 'running',
					time: { start: Date.now() },
				};
				callbacks.onPartUpdated(toolPart);

				// Execute
				const toolCtx: IToolContext = {
					sessionId: assistantMessage.sessionId,
					messageId: assistantMessage.id,
					agentId: agent.id,
					abort,
					metadata: (input) => {
						if (input.title) {
							toolPart.state.title = input.title;
						}
						if (input.metadata) {
							toolPart.state.metadata = { ...toolPart.state.metadata, ...input.metadata };
						}
						callbacks.onPartUpdated(toolPart);
					},
				};

				try {
					const result = await tool.execute(toolPart.state.input, toolCtx);
					toolPart.state = {
						status: 'completed',
						input: toolPart.state.input,
						output: result.output,
						title: result.title,
						metadata: result.metadata,
						time: { start: toolPart.state.time!.start, end: Date.now() },
					};
				} catch (err: any) {
					toolPart.state = {
						status: 'error',
						input: toolPart.state.input,
						error: err?.message ?? String(err),
						time: { start: toolPart.state.time!.start, end: Date.now() },
					};
				}

				callbacks.onPartUpdated(toolPart);
			}

			// Clear for next iteration — tool results will be in the messages
			toolCalls.length = 0;
		}

		// Emit step-finish
		const stepFinishPart: IStepFinishPart = {
			type: 'step-finish',
			id: nextId(),
			reason: finishReason,
			tokens: usage,
		};
		assistantMessage.parts.push(stepFinishPart);
		callbacks.onPartCreated(stepFinishPart);

		// If no tool calls were made, the agent is done
		const lastToolCalls = assistantMessage.parts.filter((p): p is IToolCallPart => p.type === 'tool');
		const thisStepTools = lastToolCalls.slice(-10); // Check recent
		if (finishReason === 'stop' || finishReason === 'end_turn' || thisStepTools.length === 0) {
			return 'done';
		}

		// Doom loop detection: same tool + same args N times in a row
		if (thisStepTools.length >= DOOM_LOOP_THRESHOLD) {
			const recent = thisStepTools.slice(-DOOM_LOOP_THRESHOLD);
			const allSame = recent.every(
				t => t.toolName === recent[0].toolName &&
					JSON.stringify(t.state.input) === JSON.stringify(recent[0].state.input)
			);
			if (allSame) {
				const warnPart: ITextPart = {
					type: 'text',
					id: nextId(),
					text: `[Warning] Detected repeated tool call (${recent[0].toolName}). Breaking loop.`,
				};
				assistantMessage.parts.push(warnPart);
				callbacks.onPartCreated(warnPart);
				return 'done';
			}
		}
	}

	// Max steps reached
	const maxStepPart: ITextPart = {
		type: 'text',
		id: nextId(),
		text: `[Max steps reached (${maxSteps}). Agent loop terminated.]`,
	};
	assistantMessage.parts.push(maxStepPart);
	callbacks.onPartCreated(maxStepPart);
	return 'done';
}
