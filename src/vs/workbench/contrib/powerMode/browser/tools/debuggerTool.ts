/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *
 *  Debugger Integration Tool — Agent-controlled debugging for Power Mode.
 *
 *  Enables the agent to control the VS Code debugger:
 *    • Start debug sessions with configurations
 *    • Set/remove breakpoints on files and lines
 *    • Get stack frames when stopped at breakpoints
 *    • Inspect variables in scopes
 *    • Step over, step into, step out, continue
 *    • Evaluate expressions in current scope
 *    • Stop debug sessions
 *
 *  Parameters:
 *    action: One of 'start', 'set_breakpoints', 'remove_breakpoints',
 *            'get_stack', 'get_variables', 'step_over', 'step_into',
 *            'step_out', 'continue', 'evaluate', 'stop', 'list_sessions'
 *    sessionId: Optional session ID (for multi-action workflows)
 *    configuration: Debug configuration for 'start' action
 *    breakpoints: Array of { uri, line } for 'set_breakpoints'
 *    breakpointIds: Array of breakpoint IDs for 'remove_breakpoints'
 *    frameId: Stack frame ID for 'get_variables' / 'evaluate'
 *    expression: Expression string for 'evaluate'
 *    threadId: Thread ID for stepping actions
 *
 *  Returns:
 *    Depends on action.
 *--------------------------------------------------------------------------------------------*/

import { definePowerTool } from './powerToolRegistry.js';
import { IToolContext, IToolResult } from '../../common/powerModeTypes.js';
import { IDebugService, IDebugSession, IBreakpointData } from '../../../workbench/contrib/debug/common/debug.js';
import { URI } from '../../../../../base/common/uri.js';

interface DebugSessionInfo {
	session: IDebugSession;
	threadId: number | null;
	frameId: number | null;
}

const activeSessions = new Map<string, DebugSessionInfo>();
let pendingSession: Promise<IDebugSession> | null = null;

export function createDebuggerTool(
	debugService: IDebugService,
): IPowerTool {
	return definePowerTool(
		'debugger',
		`Control the VS Code debugger from Power Mode agents.

Allows the agent to start debug sessions, set breakpoints, inspect
variables, step through code, and evaluate expressions.

Parameters:
- action: One of 'start', 'set_breakpoints', 'remove_breakpoints',
  'get_stack', 'get_variables', 'step_over', 'step_into', 'step_out',
  'continue', 'evaluate', 'stop', 'list_sessions'
- sessionId: Session ID (returned by start, required for most actions)
- configuration: Debug configuration for 'start' action
- breakpoints: Array of { uri, line } for 'set_breakpoints'
- breakpointIds: Array of breakpoint IDs for 'remove_breakpoints'
- frameId: Stack frame ID for 'get_variables' / 'evaluate'
- threadId: Thread ID for stepping actions
- expression: Expression string for 'evaluate'

Example:
  debugger({
    action: 'start',
    configuration: {
      name: 'Launch Node',
      type: 'node',
      request: 'launch',
      program: '\${workspaceFolder}/app.js'
    }
  })`,
		[
			{
				name: 'action',
				type: 'string',
				description: 'Debugger action',
				required: true,
			},
			{
				name: 'sessionId',
				type: 'string',
				description: 'Session ID (returned by start)',
				required: false,
			},
			{
				name: 'configuration',
				type: 'object',
				description: 'Debug configuration for start action',
				required: false,
			},
			{
				name: 'breakpoints',
				type: 'array',
				description: 'Array of { uri, line } for set_breakpoints',
				required: false,
			},
			{
				name: 'breakpointIds',
				type: 'array',
				description: 'Array of breakpoint IDs for remove_breakpoints',
				required: false,
			},
			{
				name: 'frameId',
				type: 'number',
				description: 'Stack frame ID for get_variables / evaluate',
				required: false,
			},
			{
				name: 'threadId',
				type: 'number',
				description: 'Thread ID for stepping actions',
				required: false,
			},
			{
				name: 'expression',
				type: 'string',
				description: 'Expression string for evaluate',
				required: false,
			},
		],
		async (args: Record<string, any>, ctx: IToolContext): Promise<IToolResult> => {
			const action = args.action as string;
			const sessionId = args.sessionId as string | undefined;

			if (typeof action !== 'string' || action.trim().length === 0) {
				return {
					title: 'Invalid action',
					output: 'Error: action must be a non-empty string.',
					metadata: { error: true },
				};
			}

			switch (action) {
				case 'start':
					return await _handleStart(debugService, args, ctx);
				case 'set_breakpoints':
					return await _handleSetBreakpoints(debugService, args, ctx);
				case 'remove_breakpoints':
					return await _handleRemoveBreakpoints(debugService, args, ctx);
				case 'get_stack':
					return await _handleGetStack(debugService, sessionId, ctx);
				case 'get_variables':
					return await _handleGetVariables(debugService, sessionId, args.frameId, ctx);
				case 'step_over':
					return await _handleStep(debugService, sessionId, args.threadId, 'next', ctx);
				case 'step_into':
					return await _handleStep(debugService, sessionId, args.threadId, 'stepIn', ctx);
				case 'step_out':
					return await _handleStep(debugService, sessionId, args.threadId, 'stepOut', ctx);
				case 'continue':
					return await _handleContinue(debugService, sessionId, args.threadId, ctx);
				case 'evaluate':
					return await _handleEvaluate(debugService, sessionId, args.frameId, args.expression, ctx);
				case 'stop':
					return await _handleStop(debugService, sessionId, ctx);
				case 'list_sessions':
					return await _handleListSessions(ctx);
				default:
					return {
						title: 'Unknown action',
						output: `Error: Unknown debugger action '${action}'.`,
						metadata: { error: true },
					};
			}
		},
	);
}

// ─── Action Handlers ─────────────────────────────────────────────────────

async function _handleStart(
	debugService: IDebugService,
	args: Record<string, any>,
	ctx: IToolContext,
): Promise<IToolResult> {
	const configuration = args.configuration;
	if (!configuration || typeof configuration !== 'object') {
		return {
			title: 'Invalid configuration',
			output: 'Error: configuration object is required for start action.',
			metadata: { error: true },
		};
	}

	ctx.metadata({ title: 'Starting debug session' });

	try {
		// Set up a one-time listener for the new session
		const sessionPromise = new Promise<IDebugSession>((resolve, reject) => {
			const listener = debugService.onDidNewSession((session) => {
				debugService.onDidNewSession.dispose ? debugService.onDidNewSession.dispose() : undefined;
				resolve(session);
			});
			// Timeout after 10 seconds
			setTimeout(() => reject(new Error('Debug session start timed out')), 10000);
		});

		const success = await debugService.startDebugging(undefined, configuration as any);
		if (!success) {
			return {
				title: 'Debug start failed',
				output: 'Error: startDebugging returned false. Check debug configuration.',
				metadata: { error: true },
			};
		}

		const newSession = await sessionPromise;
		const sessionId = `debug_${Date.now()}`;
		activeSessions.set(sessionId, {
			session: newSession,
			threadId: null,
			frameId: null,
		});

		return {
			title: 'Debug session started',
			output: `Started debug session: ${newSession.name}`,
			metadata: {
				sessionId,
				name: newSession.name,
				configuration,
				state: newSession.state,
			},
		};
	} catch (err: any) {
		return {
			title: 'Debug start error',
			output: `Error: ${err.message}`,
			metadata: { error: true },
		};
	}
}

async function _handleSetBreakpoints(
	debugService: IDebugService,
	args: Record<string, any>,
	ctx: IToolContext,
): Promise<IToolResult> {
	const breakpoints = args.breakpoints as Array<{ uri: string; line: number }> | undefined;
	if (!Array.isArray(breakpoints) || breakpoints.length === 0) {
		return {
			title: 'Invalid breakpoints',
			output: 'Error: breakpoints must be a non-empty array of { uri, line }.',
			metadata: { error: true },
		};
	}

	ctx.metadata({ title: 'Setting breakpoints' });

	const results: Array<{ id: string; uri: string; line: number; verified: boolean }> = [];

	for (const bp of breakpoints) {
		if (typeof bp.uri !== 'string' || typeof bp.line !== 'number') {
			results.push({ id: '', uri: String(bp.uri), line: bp.line, verified: false });
			continue;
		}

		try {
			const modelUri = URI.parse(bp.uri);
			const rawBps: IBreakpointData[] = [{ lineNumber: bp.line, enabled: true }];
			const bps = await debugService.addBreakpoints(modelUri, rawBps, false);
			for (const b of bps) {
				results.push({
					id: b.getId(),
					uri: b.uri.toString(),
					line: b.lineNumber,
					verified: b.verified,
				});
			}
		} catch (err: any) {
			results.push({
				id: '',
				uri: bp.uri,
				line: bp.line,
				verified: false,
			});
		}
	}

	return {
		title: `Set ${results.filter(r => r.verified).length}/${results.length} breakpoints`,
		output: results
			.map(r => `${r.verified ? '✓' : '✗'} ${r.uri}:${r.line}`)
			.join('\n'),
		metadata: { breakpoints: results },
	};
}

async function _handleRemoveBreakpoints(
	debugService: IDebugService,
	args: Record<string, any>,
	ctx: IToolContext,
): Promise<IToolResult> {
	const ids = args.breakpointIds as string[] | undefined;
	if (!Array.isArray(ids) || ids.length === 0) {
		return {
			title: 'Invalid breakpointIds',
			output: 'Error: breakpointIds must be a non-empty array.',
			metadata: { error: true },
		};
	}

	ctx.metadata({ title: 'Removing breakpoints' });

	try {
		await debugService.removeBreakpoints(ids);
		return {
			title: 'Breakpoints removed',
			output: `Removed ${ids.length} breakpoint(s).`,
			metadata: { removed: ids.length },
		};
	} catch (err: any) {
		return {
			title: 'Remove breakpoints error',
			output: `Error: ${err.message}`,
			metadata: { error: true },
		};
	}
}

async function _handleGetStack(
	debugService: IDebugService,
	sessionId: string | undefined,
	ctx: IToolContext,
): Promise<IToolResult> {
	const session = _getSession(debugService, sessionId);
	if (!session) {
		return {
			title: 'Session not found',
			output: 'Error: No active debug session. Start one with action "start".',
			metadata: { error: true },
		};
	}

	ctx.metadata({ title: 'Getting stack trace' });

	const threads = session.getAllThreads();
	const threadInfos: Array<{ id: number; name: string; frames: Array<{ id: number; name: string; source: string; line: number; column: number }> }> = [];

	for (const thread of threads) {
		const frames = thread.getCallStack();
		const frameInfos: Array<{ id: number; name: string; source: string; line: number; column: number }> = [];

		for (const frame of frames) {
			frameInfos.push({
				id: frame.frameId,
				name: frame.name,
				source: frame.source ? frame.source.path : 'unknown',
				line: frame.range.startLineNumber,
				column: frame.range.startColumn,
			});
		}

		threadInfos.push({
			id: thread.threadId,
			name: thread.name,
			frames: frameInfos,
		});

		const sessInfo = activeSessions.get(_sessionIdFromSession(session));
		if (sessInfo) {
			sessInfo.threadId = thread.threadId;
			if (frames.length > 0) {
				sessInfo.frameId = frames[0].frameId;
			}
		}
	}

	return {
		title: `Stack trace: ${threadInfos.length} thread(s)`,
		output: threadInfos
			.map(t => `Thread ${t.id} (${t.name}): ${t.frames.length} frame(s)`)
			.join('\n'),
		metadata: { threads: threadInfos },
	};
}

async function _handleGetVariables(
	debugService: IDebugService,
	sessionId: string | undefined,
	frameId: number | undefined,
	ctx: IToolContext,
): Promise<IToolResult> {
	const session = _getSession(debugService, sessionId);
	if (!session) {
		return {
			title: 'Session not found',
			output: 'Error: No active debug session.',
			metadata: { error: true },
		};
	}

	if (typeof frameId !== 'number') {
		return {
			title: 'Invalid frameId',
			output: 'Error: frameId is required for get_variables.',
			metadata: { error: true },
		};
	}

	ctx.metadata({ title: 'Getting variables' });

	const threads = session.getAllThreads();
	let targetThread: { threadId: number; frameId: number } | null = null;

	for (const thread of threads) {
		const frames = thread.getCallStack();
		const frame = frames.find(f => f.frameId === frameId);
		if (frame) {
			targetThread = { threadId: thread.threadId, frameId };
			break;
		}
	}

	if (!targetThread) {
		return {
			title: 'Frame not found',
			output: `Error: Frame ${frameId} not found in any thread.`,
			metadata: { error: true },
		};
	}

	try {
		const scopes = await session.scopes(frameId, targetThread.threadId);
		if (!scopes || !scopes.scopes) {
			return {
				title: 'No scopes',
				output: 'No variable scopes available for this frame.',
				metadata: { variables: [] },
			};
		}

		const scopeInfos: Array<{ name: string; variables: Array<{ name: string; value: string; type: string }> }> = [];

		for (const scope of scopes.scopes) {
			const vars = await session.variables(scope.variablesReference, targetThread.threadId, undefined, 0, 50);
			if (!vars || !vars.variables) continue;

			const varInfos: Array<{ name: string; value: string; type: string }> = [];
			for (const v of vars.variables) {
				varInfos.push({
					name: v.name,
					value: v.value,
					type: v.type,
				});
			}

			scopeInfos.push({
				name: scope.name,
				variables: varInfos,
			});
		}

		const sessInfo = activeSessions.get(_sessionIdFromSession(session));
		if (sessInfo) {
			sessInfo.frameId = frameId;
		}

		return {
			title: `Variables: ${scopeInfos.length} scope(s)`,
			output: scopeInfos
				.map(s => `${s.name}: ${s.variables.length} variable(s)`)
				.join('\n'),
			metadata: { scopes: scopeInfos },
		};
	} catch (err: any) {
		return {
			title: 'Get variables error',
			output: `Error: ${err.message}`,
			metadata: { error: true },
		};
	}
}

async function _handleStep(
	debugService: IDebugService,
	sessionId: string | undefined,
	threadId: number | undefined,
	action: 'next' | 'stepIn' | 'stepOut',
	ctx: IToolContext,
): Promise<IToolResult> {
	const session = _getSession(debugService, sessionId);
	if (!session) {
		return {
			title: 'Session not found',
			output: 'Error: No active debug session.',
			metadata: { error: true },
		};
	}

	const threads = session.getAllThreads();
	const targetThread = threads.find(t => threadId === undefined || t.threadId === threadId);
	if (!targetThread) {
		return {
			title: 'Thread not found',
			output: `Error: Thread ${threadId ?? 'any'} not found.`,
			metadata: { error: true },
		};
	}

	ctx.metadata({ title: `Stepping: ${action}` });

	try {
		if (action === 'next') {
			await targetThread.next();
		} else if (action === 'stepIn') {
			await targetThread.stepIn();
		} else if (action === 'step_out') {
			await targetThread.stepOut();
		}

		const sessInfo = activeSessions.get(_sessionIdFromSession(session));
		if (sessInfo) {
			sessInfo.threadId = targetThread.threadId;
			const frames = targetThread.getCallStack();
			if (frames.length > 0) {
				sessInfo.frameId = frames[0].frameId;
			}
		}

		return {
			title: `Stepped: ${action}`,
			output: `Thread ${targetThread.threadId} ${action} completed.`,
			metadata: { status: 'stepped', threadId: targetThread.threadId },
		};
	} catch (err: any) {
		return {
			title: 'Step error',
			output: `Error: ${err.message}`,
			metadata: { error: true },
		};
	}
}

async function _handleContinue(
	debugService: IDebugService,
	sessionId: string | undefined,
	threadId: number | undefined,
	ctx: IToolContext,
): Promise<IToolResult> {
	const session = _getSession(debugService, sessionId);
	if (!session) {
		return {
			title: 'Session not found',
			output: 'Error: No active debug session.',
			metadata: { error: true },
		};
	}

	const threads = session.getAllThreads();
	const targetThread = threads.find(t => threadId === undefined || t.threadId === threadId);
	if (!targetThread) {
		return {
			title: 'Thread not found',
			output: `Error: Thread ${threadId ?? 'any'} not found.`,
			metadata: { error: true },
		};
	}

	ctx.metadata({ title: 'Continuing execution' });

	try {
		await targetThread.continue();

		const sessInfo = activeSessions.get(_sessionIdFromSession(session));
		if (sessInfo) {
			sessInfo.threadId = targetThread.threadId;
			sessInfo.frameId = null;
		}

		return {
			title: 'Continued execution',
			output: `Thread ${targetThread.threadId} continued.`,
			metadata: { status: 'continued', threadId: targetThread.threadId },
		};
	} catch (err: any) {
		return {
			title: 'Continue error',
			output: `Error: ${err.message}`,
			metadata: { error: true },
		};
	}
}

async function _handleEvaluate(
	debugService: IDebugService,
	sessionId: string | undefined,
	frameId: number | undefined,
	expression: string | undefined,
	ctx: IToolContext,
): Promise<IToolResult> {
	if (typeof expression !== 'string' || expression.trim().length === 0) {
		return {
			title: 'Invalid expression',
			output: 'Error: expression is required for evaluate action.',
			metadata: { error: true },
		};
	}

	const session = _getSession(debugService, sessionId);
	if (!session) {
		return {
			title: 'Session not found',
			output: 'Error: No active debug session.',
			metadata: { error: true },
		};
	}

	if (typeof frameId !== 'number') {
		return {
			title: 'Invalid frameId',
			output: 'Error: frameId is required for evaluate.',
			metadata: { error: true },
		};
	}

	ctx.metadata({ title: `Evaluating: ${expression}` });

	try {
		const result = await session.evaluate(expression, frameId, 'hover');
		if (!result) {
			return {
				title: 'Evaluate error',
				output: 'Error: No result from evaluate.',
				metadata: { error: true },
			};
		}

		return {
			title: `Evaluate: ${expression}`,
			output: `Result: ${result.result ?? '(no value)'}`,
			metadata: {
				result: result.result,
				type: result.type,
				expression,
			},
		};
	} catch (err: any) {
		return {
			title: 'Evaluate error',
			output: `Error: ${err.message}`,
			metadata: { error: true },
		};
	}
}

async function _handleStop(
	debugService: IDebugService,
	sessionId: string | undefined,
	ctx: IToolContext,
): Promise<IToolResult> {
	const session = _getSession(debugService, sessionId);
	if (!session) {
		return {
			title: 'Session not found',
			output: 'Error: No active debug session.',
			metadata: { error: true },
		};
	}

	ctx.metadata({ title: 'Stopping debug session' });

	try {
		await session.terminate();
		activeSessions.delete(_sessionIdFromSession(session));

		return {
			title: 'Debug session stopped',
			output: `Stopped session: ${session.name}`,
			metadata: { status: 'stopped', sessionId: _sessionIdFromSession(session) },
		};
	} catch (err: any) {
		return {
			title: 'Stop error',
			output: `Error: ${err.message}`,
			metadata: { error: true },
		};
	}
}

async function _handleListSessions(
	ctx: IToolContext,
): Promise<IToolResult> {
	const sessionInfos = Array.from(activeSessions.entries()).map(([id, info]) => ({
		id,
		name: info.session.name,
		state: info.session.state,
		configuration: info.session.configuration,
	}));

	return {
		title: `Active debug sessions: ${sessionInfos.length}`,
		output: sessionInfos
			.map(s => `${s.id}: ${s.name} (${s.state})`)
			.join('\n') || '(no active sessions)',
		metadata: { sessions: sessionInfos },
	};
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function _getSession(debugService: IDebugService, sessionId: string | undefined): IDebugSession | undefined {
	if (!sessionId) {
		const sessions = Array.from(activeSessions.values());
		if (sessions.length === 0) return undefined;
		return sessions[sessions.length - 1].session;
	}
	const info = activeSessions.get(sessionId);
	return info ? info.session : undefined;
}

function _sessionIdFromSession(session: IDebugSession): string {
	for (const [id, info] of activeSessions.entries()) {
		if (info.session === session) return id;
	}
	return `debug_unknown_${Date.now()}`;
}
