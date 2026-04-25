/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

/**
 * PowerModeProcessor \u2014 the core agent execution loop.
 *
 * Modeled after OpenCode's SessionProcessor. This is the brain that:
 * 1. Sends messages to the LLM
 * 2. Streams back text + tool calls
 * 3. Executes tool calls
 * 4. Feeds results back to the LLM
 * 5. Loops until the agent is done or max steps reached
 *
 * The processor is stateless \u2014 all state is written into IPowerMessage parts
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

/** Tools that require user approval before execution */
const TOOLS_REQUIRING_APPROVAL = new Set(['bash', 'write', 'edit', 'multi_edit', 'notebook_edit', 'git_commit', 'git_push', 'git_add', 'enter_worktree', 'exit_worktree']);

/** Tools blocked in plan mode */
const PLAN_MODE_BLOCKED = new Set(['bash', 'write', 'edit', 'multi_edit', 'notebook_edit', 'git_commit', 'git_push', 'git_add', 'git_stash']);

/**
 * Read-only tools safe to execute in parallel.
 * These do not modify state, so concurrent execution is safe.
 */
const PARALLEL_SAFE_TOOLS = new Set([
	'read', 'list', 'glob', 'grep',
	'git_status', 'git_diff', 'git_log',
	'memory_read', 'memory_list', 'memory_search',
	'tasks_get', 'tasks_list',
	'web_fetch', 'web_search',
	'get_agent_status', 'list_agents',
]);

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
	/**
	 * Called before executing a tool that requires approval.
	 * Returns 'allow', 'allow-all' (skip future asks this session), or 'deny' (cancel).
	 * @param dangerous \u2014 true if this command matches a known-dangerous pattern (force approval even in auto-approve-all mode)
	 */
	askPermission(toolName: string, input: Record<string, any>, dangerous?: boolean): Promise<ToolPermissionDecision>;

	/**
	 * Returns true if this tool call is flagged as dangerous.
	 * Dangerous bash commands force a permission prompt even when the user has said "allow all".
	 */
	checkCommandDanger(toolName: string, input: Record<string, any>): boolean;
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
	/** When true, write/bash tools are rejected with a clear plan-mode error */
	planMode?: boolean;
}): Promise<'done' | 'error' | 'cancelled'> {
	const { agent, assistantMessage, sessionMessages, toolRegistry, callbacks, abort, systemPrompt } = input;
	const planModeActive = input.planMode ?? false;
	const maxSteps = agent.maxSteps ?? MAX_STEPS_DEFAULT;
	let step = 0;
	let idCounter = 0;
	const nextId = () => `pp_${Date.now()}_${++idCounter}`;

	// Get available tools for this agent
	const availableTools = toolRegistry.forAgent(agent.permissions);
	const toolSchemas = toolRegistry.buildToolSchemas(availableTools);

	// Track whether the user has approved all tools for this session
	let autoApproveAll = false;

	// \u2500\u2500\u2500 Single tool execution helper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const executeTool = async (toolPart: IToolCallPart): Promise<void> => {
		if (abort.aborted) { return; }

		const tool = toolRegistry.get(toolPart.toolName);
		if (!tool) {
			toolPart.state = {
				...toolPart.state,
				status: 'error',
				error: `Unknown tool: ${toolPart.toolName}. Available: ${availableTools.map(t => t.id).join(', ')}`,
				time: { start: Date.now(), end: Date.now() },
			};
			callbacks.onPartUpdated(toolPart);
			return;
		}

		// \u2500\u2500 Plan mode gate \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		if (planModeActive && PLAN_MODE_BLOCKED.has(toolPart.toolName)) {
			toolPart.state = {
				...toolPart.state,
				status: 'error',
				error: `Tool "${toolPart.toolName}" is blocked \u2014 session is in PLAN MODE.\nCall exit_plan_mode with your implementation plan to re-enable write tools.`,
				time: { start: Date.now(), end: Date.now() },
			};
			callbacks.onPartUpdated(toolPart);
			return;
		}

		// \u2500\u2500 Danger check \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const isDangerous = callbacks.checkCommandDanger(toolPart.toolName, toolPart.state.input);

		// \u2500\u2500 Permission gate \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		// Dangerous commands force a prompt even when the user has set auto-approve-all.
		if ((!autoApproveAll || isDangerous) && TOOLS_REQUIRING_APPROVAL.has(toolPart.toolName)) {
			const decision = await callbacks.askPermission(toolPart.toolName, toolPart.state.input, isDangerous);
			if (decision === 'deny') {
				toolPart.state = {
					...toolPart.state,
					status: 'error',
					error: 'Permission denied by user.',
					time: { start: Date.now(), end: Date.now() },
				};
				callbacks.onPartUpdated(toolPart);
				return;
			}
			if (decision === 'allow-all') { autoApproveAll = true; }
		}

		// Mark running
		toolPart.state = { ...toolPart.state, status: 'running', time: { start: Date.now() } };
		callbacks.onPartUpdated(toolPart);

		const toolCtx: IToolContext = {
			sessionId: assistantMessage.sessionId,
			messageId: assistantMessage.id,
			agentId: agent.id,
			abort,
			metadata: (upd) => {
				if (upd.title) { toolPart.state.title = upd.title; }
				if (upd.metadata) { toolPart.state.metadata = { ...toolPart.state.metadata, ...upd.metadata }; }
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
	};

	// Build conversation history for the LLM
	const buildMessages = (): ILLMMessage[] => {
		const msgs: ILLMMessage[] = [];
		for (const msg of sessionMessages) {
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

	// \u2500\u2500\u2500 Main Loop \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	while (step < maxSteps) {
		if (abort.aborted) { return 'cancelled'; }

		step++;

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

		// \u2500\u2500\u2500 Execute tool calls \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

		if (toolCalls.length > 0) {
			if (abort.aborted) { return 'cancelled'; }

			// Partition into parallel-safe (read-only) and sequential (write) groups.
			// We preserve the original order for the LLM's next turn by maintaining index.
			const safeBatch: IToolCallPart[] = [];
			const sequentialQueue: IToolCallPart[] = [];

			for (const toolPart of toolCalls) {
				if (PARALLEL_SAFE_TOOLS.has(toolPart.toolName)) {
					safeBatch.push(toolPart);
				} else {
					sequentialQueue.push(toolPart);
				}
			}

			// Execute all safe read-only tools concurrently
			if (safeBatch.length > 0) {
				await Promise.all(safeBatch.map(tp => executeTool(tp)));
				if (abort.aborted) { return 'cancelled'; }
			}

			// Execute write tools sequentially (order matters for file mutations)
			for (const toolPart of sequentialQueue) {
				if (abort.aborted) { return 'cancelled'; }
				await executeTool(toolPart);
				// If permission was denied, stop the loop
				if (toolPart.state.status === 'error' && toolPart.state.error === 'Permission denied by user.') {
					return 'cancelled';
				}
			}

			// Clear for next iteration \u2014 tool results will be in the messages
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
