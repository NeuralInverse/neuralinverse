/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Agentic Mode Service
 *
 * Provides a "Claude Code-like" full-autonomy agent session.
 *
 * ## How it works
 *
 * 1. User gives a mission instruction in the UI
 * 2. Service picks the selected agent and runs it with ALL tools
 * 3. Every output line (tool calls, reasoning, results) streams via onOutput
 * 4. A status bar entry shows the running state \u2014 visible even when the
 *    Agent Manager window is closed
 * 5. The run lives in WorkflowAgentService \u2014 closing the UI does NOT stop it
 * 6. User can stop() at any time via the status bar or UI
 *
 * ## Detach / "Close IDE"
 *
 * The Agent Manager runs in an auxiliary window. The user can close that
 * window and the run continues. The status bar entry in the main window
 * shows "\u26A1 Agent running" and clicking it re-opens the panel.
 *
 * ## Terminal integration
 *
 * runCommand / runScript tool calls already open real VS Code terminal tabs.
 * Users can watch commands execute live in those terminals independently of
 * the chat output panel.
 */

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkflowAgentService } from './workflowAgentService.js';
import { IAgentStoreService } from './agentStoreService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IAgentRun } from '../common/workflowTypes.js';

// \u2500\u2500\u2500 Types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export type AgenticState = 'idle' | 'running' | 'done' | 'failed' | 'cancelled';

export interface IAgenticSession {
	readonly runId: string;
	readonly agentId: string;
	readonly agentName: string;
	readonly instruction: string;
	readonly startedAt: number;
	state: AgenticState;
	outputLines: string[];
	endedAt?: number;
	error?: string;
}

// \u2500\u2500\u2500 Service Interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const IAgenticModeService = createDecorator<IAgenticModeService>('agenticModeService');

export interface IAgenticModeService {
	readonly _serviceBrand: undefined;

	/** True while an agent run is in progress */
	readonly isRunning: boolean;

	/** The current or most recent session */
	readonly session: IAgenticSession | undefined;

	/** Fires whenever state transitions (running \u2192 done / failed / cancelled) */
	readonly onDidChangeState: Event<AgenticState>;

	/** Fires for each new output line as the agent works */
	readonly onOutput: Event<string>;

	/** Start a new agentic session. No-op if already running. */
	start(agentId: string, instruction: string): void;

	/** Cancel the current run. */
	stop(): void;
}

// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class AgenticModeService extends Disposable implements IAgenticModeService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeState = this._register(new Emitter<AgenticState>());
	readonly onDidChangeState = this._onDidChangeState.event;

	private readonly _onOutput = this._register(new Emitter<string>());
	readonly onOutput = this._onOutput.event;

	private _session: IAgenticSession | undefined;
	private _statusBarEntry: IDisposable | undefined;
	/** stepId \u2192 number of outputLog lines already emitted */
	private readonly _stepOutputCursors = new Map<string, number>();

	constructor(
		@IWorkflowAgentService private readonly workflowAgentService: IWorkflowAgentService,
		@IAgentStoreService private readonly agentStore: IAgentStoreService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
	) {
		super();
	}

	// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	get isRunning(): boolean {
		return this._session?.state === 'running';
	}

	get session(): IAgenticSession | undefined {
		return this._session;
	}

	start(agentId: string, instruction: string): void {
		if (this.isRunning) return;

		const agent = this.agentStore.getAgent(agentId);
		if (!agent) {
			console.error(`[AgenticModeService] Agent not found: ${agentId}`);
			return;
		}

		// Create session (runId filled once we capture the first run event)
		const session: IAgenticSession = {
			runId: '',
			agentId,
			agentName: agent.name,
			instruction,
			startedAt: Date.now(),
			state: 'running',
			outputLines: [],
		};
		this._session = session;
		this._stepOutputCursors.clear();

		// Emit header
		this._emit(`\u1F916  Agent  : ${agent.name}`);
		this._emit(`\u1F4CB  Mission: ${instruction}`);
		this._emit(`${'\u2500'.repeat(56)}`);

		this._onDidChangeState.fire('running');
		this._showStatusBar();

		// Listen for streaming output BEFORE starting the run so we don't miss events
		const runSub = this._register(this.workflowAgentService.onDidChangeRun(run => {
			// Capture runId from the first adhoc run that appears
			if (!session.runId && run.workflowId === `adhoc-${agentId}`) {
				(session as any).runId = run.id;
			}
			if (run.id !== session.runId) return;
			this._drainRunOutput(run);
		}));

		// Fire the run
		this.workflowAgentService.runAgent(agentId, instruction).then(run => {
			// Ensure runId is set
			if (!session.runId) {
				(session as any).runId = run.id;
			}
			// Drain any final output
			this._drainRunOutput(run);

			const finalState: AgenticState =
				run.status === 'done' ? 'done' :
				run.status === 'cancelled' ? 'cancelled' : 'failed';

			session.state = finalState;
			session.endedAt = run.endedAt;
			session.error = run.error;

			const icon = finalState === 'done' ? '\u2705' : finalState === 'cancelled' ? '\u26D4' : '\u274C';
			this._emit(`${'\u2500'.repeat(56)}`);
			this._emit(`${icon}  Mission ${finalState}${run.error ? ' \u2014 ' + run.error : ''}`);
			if (run.finalOutput) {
				this._emit('');
				this._emit(run.finalOutput);
			}

			runSub.dispose();
			this._hideStatusBar();
			this._onDidChangeState.fire(finalState);
		}).catch(err => {
			session.state = 'failed';
			session.error = String(err?.message ?? err);
			this._emit(`\u274C  Error: ${session.error}`);
			runSub.dispose();
			this._hideStatusBar();
			this._onDidChangeState.fire('failed');
		});
	}

	stop(): void {
		if (!this._session?.runId) return;
		this.workflowAgentService.cancelRun(this._session.runId);
	}

	// \u2500\u2500\u2500 Internal \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Drain any new outputLog lines from the run and emit them. */
	private _drainRunOutput(run: IAgentRun): void {
		for (const step of run.steps) {
			const cursor = this._stepOutputCursors.get(step.stepId) ?? 0;

			// Announce step start
			if (cursor === 0 && step.status !== 'pending') {
				const roleIcon: Record<string, string> = {
					planner: '\u1F5FA\uFE0F', executor: '\u2699\uFE0F', validator: '\u1F50D', reviewer: '\u1F4DD',
				};
				const icon = roleIcon[step.role] ?? '\u25B6';
				this._emit(`\n${icon}  [${step.role.toUpperCase()}] Step starting\u2026`);
			}

			// New log lines
			const newLines = step.outputLog.slice(cursor);
			for (const line of newLines) {
				this._emit(line);
			}
			this._stepOutputCursors.set(step.stepId, step.outputLog.length);

			// Step done/failed annotation
			if ((step.status === 'done' || step.status === 'failed') && step.outputLog.length === (this._stepOutputCursors.get(step.stepId) ?? 0)) {
				if (step.status === 'failed' && step.error) {
					this._emit(`\u274C  Step failed: ${step.error}`);
				}
			}
		}
	}

	private _emit(line: string): void {
		this._session?.outputLines.push(line);
		this._onOutput.fire(line);
	}

	private _showStatusBar(): void {
		this._hideStatusBar();
		this._statusBarEntry = this.statusbarService.addEntry(
			{
				name: 'Neural Inverse Agentic Mode',
				text: '$(sync~spin) Agent running',
				ariaLabel: 'Neural Inverse agent is running a mission',
				tooltip: 'Click to open Agent Manager',
				command: 'neuralInverse.openAgentManager',
				kind: 'prominent',
			},
			'neuralInverse.agenticMode.statusBar',
			StatusbarAlignment.RIGHT,
			499,
		);
	}

	private _hideStatusBar(): void {
		this._statusBarEntry?.dispose();
		this._statusBarEntry = undefined;
	}

	override dispose(): void {
		this._hideStatusBar();
		super.dispose();
	}
}

registerSingleton(IAgenticModeService, AgenticModeService, InstantiationType.Delayed);
