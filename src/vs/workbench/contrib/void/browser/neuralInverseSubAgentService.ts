/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Sub-Agent Service — Spawns and orchestrates parallel sub-agents.
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
	readonly subAgents: ReadonlyMap<string, SubAgentTask>;
	readonly onDidChangeSubAgent: Event<{ subAgentId: string, status: SubAgentStatus }>;
	readonly runningCount: number;

	setParentContext(context: SubAgentParentContext | null): void;
	getParentContext(): SubAgentParentContext | null;
	spawn(request: SubAgentSpawnRequest): SubAgentTask | null;
	cancel(subAgentId: string): void;
	cancelAll(): void;
	getAllowedToolNames(role: SubAgentRole): string[];
	getResult(subAgentId: string): string | undefined;
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
	}

	// Lazy-resolved services
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
		let parentContext: SubAgentParentContext | null = request.parentContext || this._parentContext;
		if (!parentContext) {
			const parentTask = this._agentService.activeTask;
			if (parentTask) {
				parentContext = { id: parentTask.id, type: 'agent-task' };
			}
		}
		if (!parentContext) return null;

		const parentId = parentContext.id;
		const maxConcurrent = this._configService.config.constraints.maxConcurrentSubAgents ?? MAX_CONCURRENT_SUB_AGENTS;

		if (this.runningCount >= maxConcurrent) {
			this._pendingQueue.push(request);
			return this._createSubAgentTask(parentId, request, 'pending');
		}

		return this._startSubAgent(parentId, request);
	}

	cancel(subAgentId: string): void {
		const subAgent = this._subAgents.get(subAgentId);
		if (!subAgent || subAgent.status !== 'running') return;
		// Signal the running agent loop to stop
		subAgent.abortController?.abort();
		subAgent.status = 'cancelled';
		subAgent.completedAt = new Date().toISOString();
		this._onDidChangeSubAgent.fire({ subAgentId, status: 'cancelled' });
		this._drainQueue();
	}

	cancelAll(): void {
		this._pendingQueue = [];
		for (const [id, agent] of this._subAgents) {
			if (agent.status === 'running') {
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

	private _startSubAgent(parentId: string, request: SubAgentSpawnRequest): SubAgentTask {
		const subAgent = this._createSubAgentTask(parentId, request, 'running');

		// Create a real background thread (navigable, but no streaming/agent pipeline)
		const threadId = this._chatThreadService.createBackgroundThread();
		subAgent.threadId = threadId;

		// Inject user message so clicking into thread shows the goal
		this._chatThreadService.addBackgroundMessage(threadId, {
			role: 'user',
			content: request.goal,
			displayContent: request.goal,
			selections: [],
			state: { isCollapsed: false },
		} as any);

		// Run headlessly via PowerMode answerQuery
		this._runHeadless(subAgent, request);

		return subAgent;
	}

	private async _runHeadless(subAgent: SubAgentTask, request: SubAgentSpawnRequest): Promise<void> {
		try {
			const powerMode = this._getPowerMode();
			if (!powerMode) throw new Error('Power Mode service not available');

			// Create a real abort controller for this agent's execution
			const abort = new AbortController();
			subAgent.abortController = abort;

			const rolePrefix = this._buildSubAgentPrefix(request);
			const result = await powerMode.runSubAgentLoop(subAgent.id, request, rolePrefix, abort.signal);

			if (!abort.signal.aborted) {
				subAgent.status = 'completed';
				subAgent.result = result;

				this._chatThreadService.addBackgroundMessage(subAgent.threadId, {
					role: 'assistant',
					content: result,
					displayContent: result,
				} as any);
			}
		} catch (err: any) {
			if (subAgent.status !== 'cancelled') {
				subAgent.status = 'failed';
				subAgent.error = err.message ?? 'Unknown error';
			}
		}

		if (!subAgent.completedAt) {
			subAgent.completedAt = new Date().toISOString();
		}
		this._onDidChangeSubAgent.fire({ subAgentId: subAgent.id, status: subAgent.status });

		this._agentService.recordContext({
			type: subAgent.status === 'completed' ? 'search_result' : 'error',
			summary: `Sub-agent [${subAgent.role}] ${subAgent.status}: ${subAgent.result?.substring(0, 500) || subAgent.error || '(no output)'}`,
			importance: 4,
		});

		this._drainQueue();
	}

	private _createSubAgentTask(parentId: string, request: SubAgentSpawnRequest, status: SubAgentStatus): SubAgentTask {
		const task: SubAgentTask = {
			id: generateUuid(),
			parentTaskId: parentId,
			role: request.role,
			goal: request.goal,
			status,
			threadId: '',
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
			'power-mode': 'You are a delegated Power Mode sub-agent. Report your findings clearly.',
			debugger: 'You are a debugging specialist sub-agent. Analyze bugs, reproduce errors, identify root causes, and implement fixes.',
			reviewer: 'You are a code review sub-agent. Analyze code for security vulnerabilities, quality issues, and performance problems. You are READ-ONLY.',
			tester: 'You are a test engineer sub-agent. Write comprehensive tests, identify edge cases, and improve code coverage.',
			documenter: 'You are a technical documentation sub-agent. Create clear documentation for code, APIs, and systems.',
			architect: 'You are a software architecture sub-agent. Analyze system design and propose improvements.',
		};

		let prefix = `[NI Sub-Agent: ${request.role.toUpperCase()}]\n${roleDescriptions[request.role]}`;

		const session = this._getModernisationSession()?.session;
		if (session?.isActive) {
			const lines: string[] = ['\n\n## Active Modernisation Session'];
			lines.push(`Stage: ${session.currentStage}  |  Pattern: ${session.migrationPattern ?? 'custom'}`);
			if (session.sources.length > 0) {
				lines.push('Source projects:');
				for (const s of session.sources) { lines.push(`  ${s.label}: ${s.folderUri}`); }
			}
			if (session.targets.length > 0) {
				lines.push('Target projects:');
				for (const t of session.targets) { lines.push(`  ${t.label}: ${t.folderUri}`); }
			}
			prefix += lines.join('\n');
		}

		return prefix;
	}

	private _drainQueue(): void {
		let parentContext = this._parentContext;
		if (!parentContext) {
			const parentTask = this._agentService.activeTask;
			if (!parentTask) return;
			parentContext = { id: parentTask.id, type: 'agent-task' };
		}

		const maxConcurrent = this._configService.config.constraints.maxConcurrentSubAgents ?? MAX_CONCURRENT_SUB_AGENTS;

		while (this.runningCount < maxConcurrent && this._pendingQueue.length > 0) {
			const next = this._pendingQueue.shift()!;
			this._startSubAgent(parentContext.id, next);
		}
	}
}

registerSingleton(INeuralInverseSubAgentService, NeuralInverseSubAgentService, InstantiationType.Eager);
