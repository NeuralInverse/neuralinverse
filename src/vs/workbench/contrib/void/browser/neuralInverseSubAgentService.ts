/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Sub-Agent Service — Spawns and orchestrates parallel sub-agents.
 *
 *  Sub-agents are lightweight agent instances that:
 *    - Run in their own chat thread
 *    - Have scoped tool access based on role (explorer/editor/verifier)
 *    - Execute concurrently (up to maxConcurrentSubAgents)
 *    - Report results back to the parent agent
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { generateUuid } from '../../../../base/common/uuid.js';

import { IChatThreadService } from './chatThreadServiceInterface.js';
import { INeuralInverseAgentService } from './neuralInverseAgentService.js';
import { INeuralInverseAgentConfigService } from './neuralInverseAgentConfigService.js';
import { IPowerModeService } from '../../powerMode/browser/powerModeService.js';
import { IModernisationSessionService } from '../../neuralInverseModernisation/browser/modernisationSessionService.js';

import {
	SubAgentTask,
	SubAgentStatus,
	SubAgentSpawnRequest,
	SubAgentRole,
	SubAgentParentContext,
	toolScopeOfRole,
	MAX_CONCURRENT_SUB_AGENTS,
} from '../common/subAgentTypes.js';


// ======================== Service Interface ========================

export interface INeuralInverseSubAgentService {
	readonly _serviceBrand: undefined;

	/** All sub-agents for the current parent task */
	readonly subAgents: ReadonlyMap<string, SubAgentTask>;

	/** Event fired when any sub-agent state changes */
	readonly onDidChangeSubAgent: Event<{ subAgentId: string, status: SubAgentStatus }>;

	/** Set parent context for sub-agents (Power Mode integration) */
	setParentContext(context: SubAgentParentContext | null): void;

	/** Get current parent context */
	getParentContext(): SubAgentParentContext | null;

	/** Spawn a new sub-agent under the current parent task */
	spawn(request: SubAgentSpawnRequest): SubAgentTask | null;

	/** Cancel a running sub-agent */
	cancel(subAgentId: string): void;

	/** Cancel all sub-agents for the current parent task */
	cancelAll(): void;

	/** Get tool name whitelist for a given role */
	getAllowedToolNames(role: SubAgentRole): string[];

	/** Get the sub-agent's result (after completion) */
	getResult(subAgentId: string): string | undefined;

	/** Number of currently running sub-agents */
	readonly runningCount: number;
}

export const INeuralInverseSubAgentService = createDecorator<INeuralInverseSubAgentService>('neuralInverseSubAgentService');


// ======================== Implementation ========================

class NeuralInverseSubAgentService extends Disposable implements INeuralInverseSubAgentService {
	readonly _serviceBrand: undefined;

	private _subAgents: Map<string, SubAgentTask> = new Map();
	private _pendingQueue: SubAgentSpawnRequest[] = [];
	private _parentContext: SubAgentParentContext | null = null;

	private readonly _onDidChangeSubAgent = this._register(new Emitter<{ subAgentId: string, status: SubAgentStatus }>());
	readonly onDidChangeSubAgent: Event<{ subAgentId: string, status: SubAgentStatus }> = this._onDidChangeSubAgent.event;

	get subAgents(): ReadonlyMap<string, SubAgentTask> { return this._subAgents; }

	get runningCount(): number {
		let count = 0;
		for (const agent of this._subAgents.values()) {
			if (agent.status === 'running') count++;
		}
		return count;
	}

	constructor(
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
		@INeuralInverseAgentService private readonly _agentService: INeuralInverseAgentService,
		@INeuralInverseAgentConfigService private readonly _configService: INeuralInverseAgentConfigService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._registerCompletionListener();
	}

	// Lazy-resolved delegated services
	private _powerMode: IPowerModeService | null | undefined;
	private _getPowerMode(): IPowerModeService | null {
		if (this._powerMode === undefined) {
			try { this._powerMode = this._instantiationService.invokeFunction(a => a.get(IPowerModeService)); }
			catch { this._powerMode = null; }
		}
		return this._powerMode;
	}

	private _modernisationSession: IModernisationSessionService | null | undefined;
	private _getModernisationSession(): IModernisationSessionService | null {
		if (this._modernisationSession === undefined) {
			try { this._modernisationSession = this._instantiationService.invokeFunction(a => a.get(IModernisationSessionService)); }
			catch { this._modernisationSession = null; }
		}
		return this._modernisationSession;
	}


	setParentContext(context: SubAgentParentContext | null): void {
		this._parentContext = context;
	}

	getParentContext(): SubAgentParentContext | null {
		return this._parentContext;
	}

	spawn(request: SubAgentSpawnRequest): SubAgentTask | null {
		// Get parent context from: explicit request > stored context > agent task
		let parentContext: SubAgentParentContext | null = request.parentContext || this._parentContext;

		if (!parentContext) {
			// Fallback to agent task (backward compatibility)
			const parentTask = this._agentService.activeTask;
			if (parentTask) {
				parentContext = { id: parentTask.id, type: 'agent-task' };
			}
		}

		if (!parentContext) return null;

		const parentId = parentContext.id;

		const maxConcurrent = this._configService.config.constraints.maxConcurrentSubAgents
			?? MAX_CONCURRENT_SUB_AGENTS;

		// Delegated roles bypass the queue — they run via external services, not chat threads
		if (request.role === 'power-mode') {
			return this._startDelegatedSubAgent(parentId, request);
		}

		// For Power Mode sessions, ALL sub-agents should run headless (no chat threads)
		// Only Agent mode tasks use chat threads with UI
		if (parentContext.type === 'power-session') {
			return this._startHeadlessSubAgent(parentId, request);
		}

		// If at capacity, queue
		if (this.runningCount >= maxConcurrent) {
			this._pendingQueue.push(request);
			const pendingTask = this._createSubAgentTask(parentId, request, 'pending');
			return pendingTask;
		}

		return this._startSubAgent(parentId, request);
	}

	cancel(subAgentId: string): void {
		const subAgent = this._subAgents.get(subAgentId);
		if (!subAgent || subAgent.status !== 'running') return;

		this._chatThreadService.abortRunning(subAgent.threadId);
		subAgent.status = 'cancelled';
		subAgent.completedAt = new Date().toISOString();
		this._onDidChangeSubAgent.fire({ subAgentId, status: 'cancelled' });

		this._drainQueue();
	}

	cancelAll(): void {
		this._pendingQueue = [];
		for (const [id, agent] of this._subAgents) {
			if (agent.status === 'running') {
				this._chatThreadService.abortRunning(agent.threadId);
				agent.status = 'cancelled';
				agent.completedAt = new Date().toISOString();
				this._onDidChangeSubAgent.fire({ subAgentId: id, status: 'cancelled' });
			}
		}
	}

	getAllowedToolNames(role: SubAgentRole): string[] {
		return [...toolScopeOfRole[role]];
	}

	getResult(subAgentId: string): string | undefined {
		return this._subAgents.get(subAgentId)?.result;
	}


	// ---- Internal ----

	/**
	 * Start a headless sub-agent for Power Mode.
	 * These run via Power Mode's answerQuery() but with role-specific tool restrictions.
	 */
	private _startHeadlessSubAgent(parentId: string, request: SubAgentSpawnRequest): SubAgentTask {
		const subAgent = this._createSubAgentTask(parentId, request, 'running');
		subAgent.threadId = `headless-${request.role}-${subAgent.id}`;

		const runHeadless = async () => {
			try {
				const powerMode = this._getPowerMode();
				if (!powerMode) throw new Error('Power Mode service not available');

				// Build role-specific prompt with tool restrictions
				const rolePrefix = this._buildSubAgentPrefix(request);
				const fullGoal = `${rolePrefix}\n\n${request.goal}\n\nIMPORTANT: You have limited tool access based on your role. Only use the tools explicitly allowed for ${request.role} agents.`;

				// Determine write access based on role
				const writeRoles: SubAgentRole[] = ['editor', 'verifier', 'debugger', 'tester', 'documenter'];
				const allowWrite = writeRoles.includes(request.role);
				const result = await powerMode.answerQuery(fullGoal, allowWrite);

				subAgent.status = 'completed';
				subAgent.result = result;
			} catch (err: any) {
				subAgent.status = 'failed';
				subAgent.error = err.message ?? 'Unknown error';
			}
			subAgent.completedAt = new Date().toISOString();

			this._onDidChangeSubAgent.fire({
				subAgentId: subAgent.id,
				status: subAgent.status,
			});

			this._drainQueue();
		};

		// Fire and forget — runs in parallel
		runHeadless();

		return subAgent;
	}

	/**
	 * Start a delegated sub-agent that runs via an external service (Power Mode).
	 * These don't consume a chat thread — they call the service's answerQuery() directly and
	 * run the full agent loop inside that service, then report results back.
	 */
	private _startDelegatedSubAgent(parentId: string, request: SubAgentSpawnRequest): SubAgentTask {
		const subAgent = this._createSubAgentTask(parentId, request, 'running');
		subAgent.threadId = `delegated-${request.role}-${subAgent.id}`;

		const runDelegated = async () => {
			try {
				const powerMode = this._getPowerMode();
				if (!powerMode) throw new Error('Power Mode service not available');
				const result = await powerMode.answerQuery(request.goal);

				subAgent.status = 'completed';
				subAgent.result = result;
			} catch (err: any) {
				subAgent.status = 'failed';
				subAgent.error = err.message ?? 'Unknown error';
			}
			subAgent.completedAt = new Date().toISOString();

			this._onDidChangeSubAgent.fire({
				subAgentId: subAgent.id,
				status: subAgent.status,
			});

			// Record result into parent agent context
			this._agentService.recordContext({
				type: subAgent.status === 'completed' ? 'search_result' : 'error',
				summary: `Sub-agent [${request.role}] ${subAgent.status}: ${subAgent.result?.substring(0, 500) || subAgent.error || '(no output)'}`,
				importance: 4,
			});

			this._drainQueue();
		};

		// Fire and forget — runs in parallel
		runDelegated();

		return subAgent;
	}

	private _startSubAgent(parentId: string, request: SubAgentSpawnRequest): SubAgentTask {
		const subAgent = this._createSubAgentTask(parentId, request, 'running');

		// Run headless - don't create UI messages
		subAgent.threadId = `inline-${request.role}-${subAgent.id}`;

		const runHeadless = async () => {
			try {
				const powerMode = this._getPowerMode();
				if (!powerMode) throw new Error('Power Mode service not available');

				// Build role-specific prompt
				const rolePrefix = this._buildSubAgentPrefix(request);
				const fullGoal = `${rolePrefix}\n\n${request.goal}`;

				// Run with appropriate permissions
				const writeRoles: SubAgentRole[] = ['editor', 'verifier', 'debugger', 'tester', 'documenter'];
				const allowWrite = writeRoles.includes(request.role);
				const result = await powerMode.answerQuery(fullGoal, allowWrite);

				subAgent.status = 'completed';
				subAgent.result = result;
			} catch (err: any) {
				subAgent.status = 'failed';
				subAgent.error = err.message ?? 'Unknown error';
			}
			subAgent.completedAt = new Date().toISOString();

			this._onDidChangeSubAgent.fire({
				subAgentId: subAgent.id,
				status: subAgent.status,
			});

			this._drainQueue();
		};

		// Fire and forget — runs in parallel
		runHeadless();

		return subAgent;
	}

	private _createSubAgentTask(parentId: string, request: SubAgentSpawnRequest, status: SubAgentStatus): SubAgentTask {
		const task: SubAgentTask = {
			id: generateUuid(),
			parentTaskId: parentId,
			role: request.role,
			goal: request.goal,
			status,
			threadId: '', // set when thread is created
			createdAt: new Date().toISOString(),
			scopedFiles: request.scopedFiles,
		};
		this._subAgents.set(task.id, task);
		this._onDidChangeSubAgent.fire({ subAgentId: task.id, status });
		return task;
	}

	private _buildSubAgentPrefix(request: SubAgentSpawnRequest): string {
		const roleDescriptions: Record<SubAgentRole, string> = {
			explorer: 'You are a read-only research sub-agent. Your job is to explore the codebase, find relevant files, and report findings. You CANNOT edit files or run commands.',
			editor: `You are a code editing sub-agent. Your job is to make targeted code changes.${request.scopedFiles?.length ? ` You are scoped to these files: ${request.scopedFiles.join(', ')}` : ''}`,
			verifier: 'You are a verification sub-agent. Your job is to run tests, check lint errors, and verify that changes are correct. Report pass/fail results clearly.',
			'power-mode': `You are a delegated Power Mode sub-agent. Power Mode runs its own full multi-tool coding agent loop internally (bash, read, write, edit, glob, grep). You will receive a research or execution task and Power Mode will handle it autonomously. Report your findings clearly.`,
			debugger: 'You are a debugging specialist sub-agent. Your job is to analyze bugs, reproduce errors, identify root causes, and implement fixes. You can read code, search for patterns, run tests to reproduce issues, and edit files to fix bugs. Always verify your fixes work by running tests.',
			reviewer: 'You are a code review sub-agent. Your job is to analyze code for security vulnerabilities, code quality issues, best practices violations, and performance problems. You are READ-ONLY and cannot modify code. Provide detailed, actionable feedback with severity levels and suggested fixes.',
			tester: 'You are a test engineer sub-agent. Your job is to write comprehensive tests (unit, integration, e2e), identify edge cases, and improve code coverage. You can read existing code, create new test files, and run tests to verify they work. Write clear, maintainable tests that catch bugs.',
			documenter: 'You are a technical documentation sub-agent. Your job is to create clear, comprehensive documentation for code, APIs, and systems. You can read code, write/update README files, generate API docs, add code comments, and create tutorials. Focus on clarity and completeness.',
			architect: 'You are a software architecture sub-agent. Your job is to analyze system design, propose architectural improvements, identify design patterns, and create refactoring plans. You can read code, analyze dependencies, and use query_ni_agent for research. Think holistically about the system.',
		};

		let prefix = `[NI Sub-Agent: ${request.role.toUpperCase()}]\n${roleDescriptions[request.role]}`;

		// Inject modernisation project paths only when a session is active so the
		// sub-agent can resolve folder labels (e.g. "m-legacy") to absolute paths.
		const session = this._getModernisationSession()?.session;
		if (session?.isActive) {
			const lines: string[] = ['\n\n## Active Modernisation Session — Project Paths'];
			lines.push(`Stage: ${session.currentStage}  |  Pattern: ${session.migrationPattern ?? 'custom'}`);
			if (session.sources.length > 0) {
				lines.push('Source (legacy) projects — use these ABSOLUTE paths when reading source files:');
				for (const s of session.sources) {
					lines.push(`  ${s.label}: ${s.folderUri}`);
				}
			}
			if (session.targets.length > 0) {
				lines.push('Target (modern) projects — use these ABSOLUTE paths when reading/writing target files:');
				for (const t of session.targets) {
					lines.push(`  ${t.label}: ${t.folderUri}`);
				}
			}
			if (session.activeSourceFileUri) { lines.push(`Active source file: ${session.activeSourceFileUri}`); }
			if (session.activeTargetFileUri) { lines.push(`Active target file: ${session.activeTargetFileUri}`); }
			lines.push('IMPORTANT: Always use the absolute paths above — do NOT use project label names as relative paths.');
			prefix += lines.join('\n');
		}

		return prefix;
	}

	private _registerCompletionListener(): void {
		this._register(this._chatThreadService.onDidChangeStreamState(({ threadId }) => {
			// Find sub-agent by threadId
			let targetAgent: SubAgentTask | undefined;
			for (const agent of this._subAgents.values()) {
				if (agent.threadId === threadId && agent.status === 'running') {
					targetAgent = agent;
					break;
				}
			}
			if (!targetAgent) return;

			const streamState = this._chatThreadService.streamState[threadId];

			// Sub-agent finished
			if (streamState?.isRunning === undefined) {
				if (streamState?.error) {
					targetAgent.status = 'failed';
					targetAgent.error = streamState.error.message;
				} else {
					targetAgent.status = 'completed';
					// Extract last assistant message as result
					const thread = this._chatThreadService.state.allThreads[threadId];
					if (thread) {
						const lastAssistant = [...thread.messages].reverse().find(m => m.role === 'assistant');
						if (lastAssistant && lastAssistant.role === 'assistant') {
							targetAgent.result = lastAssistant.displayContent;
						}
					}
				}
				targetAgent.completedAt = new Date().toISOString();
				this._onDidChangeSubAgent.fire({
					subAgentId: targetAgent.id,
					status: targetAgent.status,
				});

				// Record result into parent agent context
				this._agentService.recordContext({
					type: targetAgent.status === 'completed' ? 'search_result' : 'error',
					summary: `Sub-agent [${targetAgent.role}] ${targetAgent.status}: ${targetAgent.result?.substring(0, 500) || targetAgent.error || '(no output)'}`,
					importance: 4,
				});

				this._drainQueue();
			}
		}));
	}

	private _drainQueue(): void {
		// Get parent context (either stored or from agent task)
		let parentContext = this._parentContext;
		if (!parentContext) {
			const parentTask = this._agentService.activeTask;
			if (!parentTask) return;
			parentContext = { id: parentTask.id, type: 'agent-task' };
		}

		const maxConcurrent = this._configService.config.constraints.maxConcurrentSubAgents
			?? MAX_CONCURRENT_SUB_AGENTS;

		while (this.runningCount < maxConcurrent && this._pendingQueue.length > 0) {
			const next = this._pendingQueue.shift()!;
			this._startSubAgent(parentContext.id, next);
		}
	}
}

registerSingleton(INeuralInverseSubAgentService, NeuralInverseSubAgentService, InstantiationType.Eager);
