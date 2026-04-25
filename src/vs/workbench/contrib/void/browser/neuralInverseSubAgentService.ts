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
import { IChecksAgentService } from '../../neuralInverseChecks/browser/checksAgent/checksAgentService.js';
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
	private _checksAgent: IChecksAgentService | null | undefined;
	private _getChecksAgent(): IChecksAgentService | null {
		if (this._checksAgent === undefined) {
			try { this._checksAgent = this._instantiationService.invokeFunction(a => a.get(IChecksAgentService)); }
			catch { this._checksAgent = null; }
		}
		return this._checksAgent;
	}

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
		if (request.role === 'checks-agent' || request.role === 'power-mode') {
			return this._startDelegatedSubAgent(parentId, request);
		}

		// CC-backed agents run via answerQueryWithAgent() with CC system prompts
		if (request.role === 'cc:explore' || request.role === 'cc:plan' || request.role === 'cc:general' || request.role === 'cc:verify') {
			return this._startCCSubAgent(parentId, request);
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

	// ── CC system prompts (sourced from CC built-in agent definitions) ─────────

	private static readonly _CC_EXPLORE_PROMPT = `You are a file search specialist. You excel at thoroughly navigating and exploring codebases.

=== READ-ONLY MODE — NO FILE MODIFICATIONS ===
You CANNOT create, modify, or delete files. Your role is EXCLUSIVELY to search and analyze.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use glob/grep for broad searches; use read when you know the specific path
- Use bash ONLY for read-only operations (ls, git status, git log, git diff, find, cat, head, tail)
- NEVER use bash for: mkdir, touch, rm, cp, mv, git add, git commit, or any file modification
- Spawn multiple parallel tool calls for grepping and reading files where possible
- Communicate findings directly — do NOT create files

Complete the search request efficiently and report findings clearly.`;

	private static readonly _CC_PLAN_PROMPT = `You are a software architect and planning specialist. Your role is to explore the codebase and design implementation plans.

=== READ-ONLY MODE — NO FILE MODIFICATIONS ===
You CANNOT create, modify, or delete files. Your role is EXCLUSIVELY to explore and plan.

## Your Process
1. **Understand Requirements**: Focus on requirements and apply your architectural perspective.
2. **Explore Thoroughly**: Read provided files, find patterns with glob/grep, understand existing architecture.
3. **Design Solution**: Create an implementation approach with clear trade-offs and architectural decisions.
4. **Detail the Plan**: Provide step-by-step implementation strategy, dependencies, and sequencing.

## Required Output
End your response with:
### Critical Files for Implementation
List 3-5 files most critical for implementing this plan.

REMEMBER: You can ONLY explore and plan. You CANNOT write, edit, or modify any files.`;

	private static readonly _CC_GENERAL_PROMPT = `You are a general-purpose research and task agent. Given the user's message, use the tools available to complete the task fully — don't gold-plate, but don't leave it half-done.

Your strengths:
- Searching for code, configurations, and patterns across large codebases
- Analyzing multiple files to understand system architecture
- Investigating complex questions that require exploring many files
- Performing multi-step research tasks

Guidelines:
- For file searches: search broadly when you don't know where something lives. Use read when you know the specific file path.
- For analysis: Start broad and narrow down. Use multiple search strategies if the first doesn't yield results.
- Be thorough: Check multiple locations, consider different naming conventions, look for related files.
- NEVER create files unless absolutely necessary. ALWAYS prefer editing existing files.
- When complete, respond with a concise report covering what was done and key findings.`;

	private static readonly _CC_VERIFY_PROMPT = `You are a verification specialist. Your job is not to confirm the implementation works — it's to try to break it.

=== DO NOT MODIFY PROJECT FILES ===
You CANNOT create, modify, or delete project files. You MAY write ephemeral test scripts to /tmp.

=== VERIFICATION STRATEGY ===
Adapt based on what was changed:
- **Code changes**: Run builds, test suites, linters, type-checkers
- **API changes**: Start server \u2192 curl endpoints \u2192 verify response shapes \u2192 test error handling
- **Bug fixes**: Reproduce original bug \u2192 verify fix \u2192 run regressions
- **Refactoring**: Existing test suite MUST pass unchanged \u2192 check public API surface

=== REQUIRED STEPS ===
1. Run the build (if applicable). A broken build is an automatic FAIL.
2. Run the project's test suite. Failing tests are an automatic FAIL.
3. Run linters/type-checkers if configured.
4. Apply adversarial probes: concurrency, boundary values (0/-1/empty/long/unicode), idempotency, orphan operations.

=== OUTPUT FORMAT ===
Every check MUST include: Command run, Output observed, Result: PASS or FAIL.
A check without a command run is not a PASS — it's a skip.

End with exactly one of:
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL`;

	private static readonly _CC_SYSTEM_PROMPTS: Record<'cc:explore' | 'cc:plan' | 'cc:general' | 'cc:verify', string> = {
		'cc:explore': NeuralInverseSubAgentService._CC_EXPLORE_PROMPT,
		'cc:plan': NeuralInverseSubAgentService._CC_PLAN_PROMPT,
		'cc:general': NeuralInverseSubAgentService._CC_GENERAL_PROMPT,
		'cc:verify': NeuralInverseSubAgentService._CC_VERIFY_PROMPT,
	};

	/**
	 * Start a CC-backed sub-agent via answerQueryWithAgent().
	 * Each CC role gets its own system prompt and model hint.
	 */
	private _startCCSubAgent(parentId: string, request: SubAgentSpawnRequest): SubAgentTask {
		const subAgent = this._createSubAgentTask(parentId, request, 'running');
		subAgent.threadId = `cc-${request.role}-${subAgent.id}`;

		const role = request.role as 'cc:explore' | 'cc:plan' | 'cc:general' | 'cc:verify';

		const runCC = async () => {
			try {
				const powerMode = this._getPowerMode();
				if (!powerMode) throw new Error('Power Mode service not available');

				const systemPrompt = NeuralInverseSubAgentService._CC_SYSTEM_PROMPTS[role];
				const allowWrite = role === 'cc:verify';
				const modelHint: 'haiku' | 'inherit' = role === 'cc:explore' ? 'haiku' : 'inherit';

				// Build goal with role prefix and optional modernisation context
				const sessionCtx = this._buildModernisationContext();
				const fullGoal = sessionCtx
					? `${request.goal}\n\n${sessionCtx}`
					: request.goal;

				const result = await (powerMode as any).answerQueryWithAgent(fullGoal, {
					systemPrompt,
					allowWrite,
					modelHint,
					maxSteps: role === 'cc:verify' ? 60 : role === 'cc:explore' ? 20 : 30,
				});

				subAgent.status = 'completed';
				subAgent.result = result;
			} catch (err: any) {
				subAgent.status = 'failed';
				subAgent.error = err.message ?? 'Unknown error';
			}
			subAgent.completedAt = new Date().toISOString();
			this._onDidChangeSubAgent.fire({ subAgentId: subAgent.id, status: subAgent.status });
			this._drainQueue();
		};

		runCC();
		return subAgent;
	}

	/** Build modernisation session context string (shared by headless + CC agents) */
	private _buildModernisationContext(): string | null {
		const session = this._getModernisationSession()?.session;
		if (!session?.isActive) return null;

		const lines: string[] = ['## Active Modernisation Session — Project Paths'];
		lines.push(`Stage: ${session.currentStage}  |  Pattern: ${session.migrationPattern ?? 'custom'}`);
		if (session.sources.length > 0) {
			lines.push('Source (legacy) projects:');
			for (const s of session.sources) lines.push(`  ${s.label}: ${s.folderUri}`);
		}
		if (session.targets.length > 0) {
			lines.push('Target (modern) projects:');
			for (const t of session.targets) lines.push(`  ${t.label}: ${t.folderUri}`);
		}
		if (session.activeSourceFileUri) lines.push(`Active source file: ${session.activeSourceFileUri}`);
		if (session.activeTargetFileUri) lines.push(`Active target file: ${session.activeTargetFileUri}`);
		lines.push('IMPORTANT: Always use the absolute paths above.');
		return lines.join('\n');
	}

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
	 * Start a delegated sub-agent that runs via an external service (Checks Agent or Power Mode).
	 * These don't consume a chat thread — they call the service's answerQuery() directly and
	 * run the full agent loop inside that service, then report results back.
	 */
	private _startDelegatedSubAgent(parentId: string, request: SubAgentSpawnRequest): SubAgentTask {
		const subAgent = this._createSubAgentTask(parentId, request, 'running');
		subAgent.threadId = `delegated-${request.role}-${subAgent.id}`;

		const runDelegated = async () => {
			try {
				let result: string;
				if (request.role === 'checks-agent') {
					const checksAgent = this._getChecksAgent();
					if (!checksAgent) throw new Error('Checks Agent service not available');
					result = await checksAgent.answerQuery(request.goal);
				} else {
					const powerMode = this._getPowerMode();
					if (!powerMode) throw new Error('Power Mode service not available');
					result = await powerMode.answerQuery(request.goal);
				}

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
				importance: request.role === 'checks-agent' ? 6 : 4,
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
			editor: `You are a code editing sub-agent. Your job is to make targeted code changes.${request.scopedFiles?.length ? ` You are scoped to these files: ${request.scopedFiles.join(', ')}` : ''}`,
			verifier: 'You are a verification sub-agent. Your job is to run tests, check lint errors, and verify that changes are correct. Report pass/fail results clearly.',
			compliance: `You are a GRC compliance sub-agent powered by the Checks Agent. Your job is to:\n1. Trigger \`grc_rescan\` to re-evaluate files after code changes\n2. Use \`grc_ai_scan\` for deep AI-powered compliance analysis\n3. Check \`grc_blocking_violations\` and report any blockers\n4. Use \`ask_checksagent\` to reason about complex compliance questions\n5. Use \`grc_impact_chain\` to assess blast radius of changes\n6. Report a clear compliance verdict: PASS (no blockers), WARN (warnings only), or FAIL (blocking violations)${request.scopedFiles?.length ? `\nFocus on these files: ${request.scopedFiles.join(', ')}` : ''}`,
			'checks-agent': `You are a delegated Checks Agent sub-agent. The Checks Agent runs its own full multi-tool GRC analysis loop internally. You will receive a compliance question or task and the Checks Agent service will handle tool execution, reasoning, and analysis autonomously. Report your compliance findings clearly.`,
			'power-mode': `You are a delegated Power Mode sub-agent. Power Mode runs its own full multi-tool coding agent loop internally (bash, read, write, edit, glob, grep). You will receive a research or execution task and Power Mode will handle it autonomously. Report your findings clearly.`,
			debugger: 'You are a debugging specialist sub-agent. Your job is to analyze bugs, reproduce errors, identify root causes, and implement fixes. You can read code, search for patterns, run tests to reproduce issues, and edit files to fix bugs. Always verify your fixes work by running tests.',
			reviewer: 'You are a code review sub-agent. Your job is to analyze code for security vulnerabilities, code quality issues, best practices violations, and performance problems. You are READ-ONLY and cannot modify code. Provide detailed, actionable feedback with severity levels and suggested fixes.',
			tester: 'You are a test engineer sub-agent. Your job is to write comprehensive tests (unit, integration, e2e), identify edge cases, and improve code coverage. You can read existing code, create new test files, and run tests to verify they work. Write clear, maintainable tests that catch bugs.',
			documenter: 'You are a technical documentation sub-agent. Your job is to create clear, comprehensive documentation for code, APIs, and systems. You can read code, write/update README files, generate API docs, add code comments, and create tutorials. Focus on clarity and completeness.',
			architect: 'You are a software architecture sub-agent. Your job is to analyze system design, propose architectural improvements, identify design patterns, and create refactoring plans. You can read code, analyze dependencies, and use query_ni_agent for research. Think holistically about the system.',
			// CC-backed: these never reach _buildSubAgentPrefix (handled by _startCCSubAgent), but TypeScript needs entries
			'cc:explore': NeuralInverseSubAgentService._CC_EXPLORE_PROMPT,
			'cc:plan': NeuralInverseSubAgentService._CC_PLAN_PROMPT,
			'cc:general': NeuralInverseSubAgentService._CC_GENERAL_PROMPT,
			'cc:verify': NeuralInverseSubAgentService._CC_VERIFY_PROMPT,
		};

		let prefix = `[NI Sub-Agent: ${request.role.toUpperCase()}]\n${roleDescriptions[request.role]}`;

		// Inject modernisation project paths when a session is active
		const modCtx = this._buildModernisationContext();
		if (modCtx) {
			prefix += `\n\n${modCtx}`;
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
