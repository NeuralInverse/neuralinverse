/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Simulator Service
 *
 * Manages runtime simulation sessions for embedded/firmware GRC enforcement.
 *
 * ## Responsibilities
 *
 * 1. **Session lifecycle** — configure, build ELF, launch simulator, capture output, stop
 * 2. **Output parsing** — parse QEMU/Renode/GDB/Spike/custom output into ISimulatorViolation[]
 * 3. **GRC injection** — map violations to ICheckResult[] and inject into grcEngine
 * 4. **Persistence** — save/load session configs from .inverse/simulators/{id}.json
 * 5. **Feedback** — route confirmed runtime violations to Layer 1 (brief) + Layer 2 (index)
 *
 * ## Simulator support
 *
 * | Simulator   | Scope           | Protocol          |
 * |-------------|-----------------|-------------------|
 * | QEMU        | ARM, RISC-V, x86| stdout/stderr      |
 * | Renode      | Multi-platform  | stdout/stderr      |
 * | GDB sim     | Any target      | stdout/stderr      |
 * | Spike       | RISC-V          | stdout/stderr      |
 * | Proteus VSM | ARM, 8051, PIC  | stdout/stderr      |
 * | Custom      | Any             | stdout/stderr      |
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IExternalCommandExecutor } from './externalCommandExecutor.js';
import { IGRCEngineService } from './grcEngineService.js';
import { IFrameworkBriefService } from '../framework/frameworkBriefService.js';
import { IFrameworkRuleIndexService } from '../framework/frameworkRuleIndexService.js';
import { withInverseWriteAccess } from '../utils/inverseFs.js';
import { parseSimulatorOutput } from './simulatorOutputParser.js';
import {
	ISimulatorSession,
	ISimulatorSessionConfig,
	ISimulatorViolation,
	RuntimeViolationKind,
} from './simulatorTypes.js';
import { ICheckResult } from '../types/grcTypes.js';


// ─── Service interface ────────────────────────────────────────────────────────

export const ISimulatorService = createDecorator<ISimulatorService>('neuralInverseSimulatorService');

export interface ISimulatorService {
	readonly _serviceBrand: undefined;

	/** Fires whenever a session's status or violations change */
	readonly onDidSessionUpdate: Event<ISimulatorSession>;

	/** All sessions (active + historical) */
	getSessions(): ISimulatorSession[];

	/** Get a specific session by id */
	getSession(id: string): ISimulatorSession | undefined;

	/**
	 * Create and immediately persist a new session config.
	 * Does NOT start the run — call runSession() for that.
	 */
	createSession(config: Omit<ISimulatorSessionConfig, 'id'>): Promise<ISimulatorSession>;

	/**
	 * Run a session: optionally build ELF, launch simulator, capture output, parse violations.
	 * Fire-and-forget — updates arrive via onDidSessionUpdate.
	 */
	runSession(sessionId: string): Promise<void>;

	/** Stop a running session */
	stopSession(sessionId: string): Promise<void>;

	/** Delete a session and its persisted config */
	deleteSession(sessionId: string): Promise<void>;

	/** Load persisted session configs from .inverse/simulators/ */
	loadPersistedSessions(): Promise<void>;
}


// ─── Violation → GRC rule mapping ────────────────────────────────────────────

// Maps runtime violation kinds to built-in GRC rule IDs so violations
// appear in the checks dashboard and feed into the feedback loop.
const VIOLATION_RULE_MAP: Record<RuntimeViolationKind, string> = {
	'stack-overflow':      'RUNTIME-001',
	'heap-overflow':       'RUNTIME-002',
	'null-deref':          'RUNTIME-003',
	'watchdog-timeout':    'RUNTIME-004',
	'timing-violation':    'RUNTIME-005',
	'assertion-failure':   'RUNTIME-006',
	'memory-access-fault': 'RUNTIME-007',
	'divide-by-zero':      'RUNTIME-008',
	'unaligned-access':    'RUNTIME-009',
	'isr-stack-overflow':  'RUNTIME-010',
	'double-fault':        'RUNTIME-011',
	'privilege-violation': 'RUNTIME-012',
	'resource-leak':       'RUNTIME-013',
	'deadlock':            'RUNTIME-014',
	'data-race':           'RUNTIME-015',
	'undefined-behaviour': 'RUNTIME-016',
	'custom':              'RUNTIME-099',
};

const VIOLATION_DOMAIN: Record<RuntimeViolationKind, string> = {
	'stack-overflow':      'fail-safe',
	'heap-overflow':       'fail-safe',
	'null-deref':          'fail-safe',
	'watchdog-timeout':    'fail-safe',
	'timing-violation':    'reliability',
	'assertion-failure':   'fail-safe',
	'memory-access-fault': 'fail-safe',
	'divide-by-zero':      'fail-safe',
	'unaligned-access':    'fail-safe',
	'isr-stack-overflow':  'fail-safe',
	'double-fault':        'fail-safe',
	'privilege-violation': 'security',
	'resource-leak':       'reliability',
	'deadlock':            'reliability',
	'data-race':           'data-integrity',
	'undefined-behaviour': 'fail-safe',
	'custom':              'fail-safe',
} as Record<RuntimeViolationKind, string>;


// ─── Implementation ───────────────────────────────────────────────────────────

class SimulatorServiceImpl extends Disposable implements ISimulatorService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidSessionUpdate = this._register(new Emitter<ISimulatorSession>());
	readonly onDidSessionUpdate: Event<ISimulatorSession> = this._onDidSessionUpdate.event;

	private readonly _sessions = new Map<string, ISimulatorSession>();

	constructor(
		@IExternalCommandExecutor private readonly _commandExecutor: IExternalCommandExecutor,
		@IGRCEngineService private readonly _grcEngine: IGRCEngineService,
		@IFrameworkBriefService private readonly _briefService: IFrameworkBriefService,
		@IFrameworkRuleIndexService private readonly _ruleIndex: IFrameworkRuleIndexService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		// Load persisted sessions at startup (non-blocking)
		setTimeout(() => this.loadPersistedSessions(), 3000);
	}

	// ─── Public API ──────────────────────────────────────────────────────────

	getSessions(): ISimulatorSession[] {
		return Array.from(this._sessions.values());
	}

	getSession(id: string): ISimulatorSession | undefined {
		return this._sessions.get(id);
	}

	async createSession(config: Omit<ISimulatorSessionConfig, 'id'>): Promise<ISimulatorSession> {
		const id = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		const fullConfig: ISimulatorSessionConfig = { ...config, id, persist: config.persist ?? true };
		const session: ISimulatorSession = {
			config: fullConfig,
			status: 'idle',
			outputLines: [],
			violations: [],
		};
		this._sessions.set(id, session);
		if (fullConfig.persist) {
			await this._persistSession(fullConfig);
		}
		this._fire(session);
		return session;
	}

	async runSession(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (!session) throw new Error(`Simulator session not found: ${sessionId}`);
		if (session.status === 'running' || session.status === 'building' || session.status === 'loading') {
			return; // already running
		}

		this._updateSession(sessionId, { status: 'idle', outputLines: [], violations: [], error: undefined });

		// Run async, never throw
		this._runSessionAsync(sessionId).catch(e => {
			this._updateSession(sessionId, { status: 'failed', error: String(e) });
			console.error(`[SimulatorService] Session ${sessionId} failed:`, e);
		});
	}

	async stopSession(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (!session) return;
		if (session.status === 'running' || session.status === 'building' || session.status === 'loading') {
			this._updateSession(sessionId, { status: 'cancelled', completedAt: Date.now() });
		}
	}

	async deleteSession(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (!session) return;
		this._sessions.delete(sessionId);
		await this._deletePersistedSession(sessionId);
	}

	async loadPersistedSessions(): Promise<void> {
		const dir = this._getSimulatorsDir();
		if (!dir) return;
		try {
			if (!(await this._fileService.exists(dir))) return;
			const entries = await this._fileService.resolve(dir);
			for (const child of entries.children ?? []) {
				if (!child.name.endsWith('.json')) continue;
				try {
					const content = await this._fileService.readFile(child.resource);
					const config = JSON.parse(content.value.toString()) as ISimulatorSessionConfig;
					if (config.id && !this._sessions.has(config.id)) {
						this._sessions.set(config.id, {
							config,
							status: 'idle',
							outputLines: [],
							violations: [],
						});
					}
				} catch {
					// skip malformed files
				}
			}
			console.log(`[SimulatorService] Loaded ${this._sessions.size} persisted session(s)`);
		} catch (e) {
			console.warn('[SimulatorService] Failed to load persisted sessions:', e);
		}
	}

	// ─── Core run pipeline ────────────────────────────────────────────────────

	private async _runSessionAsync(sessionId: string): Promise<void> {
		const session = this._sessions.get(sessionId)!;
		const config = session.config;
		const workspaceRoot = this._getWorkspaceRoot();
		if (!workspaceRoot) throw new Error('No workspace folder open');

		// Step 1: Build ELF if buildCommand specified
		if (config.buildCommand) {
			this._updateSession(sessionId, { status: 'building', startedAt: Date.now() });
			const buildCmd = this._substituteVars(config.buildCommand, workspaceRoot, '');
			try {
				const buildOutput = await this._commandExecutor.execute(
					`sim-build-${sessionId}`, buildCmd, 300_000
				);
				this._appendOutput(sessionId, `[BUILD]\n${buildOutput}`);
			} catch (e: any) {
				throw new Error(`Build failed: ${e.message}`);
			}
		}

		// Step 2: Resolve ELF path
		this._updateSession(sessionId, { status: 'loading' });
		const elfAbs = config.elfPath.startsWith('/')
			? config.elfPath
			: `${workspaceRoot}/${config.elfPath.replace('${workspace}', workspaceRoot)}`;

		// Step 3: Launch simulator
		this._updateSession(sessionId, { status: 'running' });
		const launchCmd = this._substituteVars(config.launchCommand, workspaceRoot, elfAbs);

		let stdout = '';
		try {
			stdout = await this._commandExecutor.execute(
				`sim-run-${sessionId}`,
				launchCmd,
				config.timeoutMs,
				5 * 1024 * 1024, // 5MB output cap
				config.env
			);
		} catch (e: any) {
			// Non-zero exit is normal for simulators that detect faults — use whatever output we got
			stdout = e.stdout ?? e.message ?? '';
		}

		const lines = stdout.split('\n');
		this._appendOutput(sessionId, stdout);

		// Step 4: Parse violations
		const timestamp = Date.now();
		const violations = parseSimulatorOutput(lines, config.kind, timestamp);

		// Step 5: Map to GRC results and inject
		if (violations.length > 0) {
			this._injectViolations(violations, workspaceRoot, timestamp);
			this._feedbackLayers(violations);
		}

		this._updateSession(sessionId, {
			status: 'complete',
			completedAt: Date.now(),
			violations,
		});

		console.log(`[SimulatorService] Session ${sessionId} complete — ${violations.length} violation(s) found`);
	}

	// ─── GRC injection ────────────────────────────────────────────────────────

	private _injectViolations(violations: ISimulatorViolation[], workspaceRoot: string, timestamp: number): void {
		// Group by file so we inject per-file (as grcEngine.setExternalResults expects)
		const byFile = new Map<string, ISimulatorViolation[]>();
		for (const v of violations) {
			const filePath = v.file
				? (v.file.startsWith('/') ? v.file : `${workspaceRoot}/${v.file}`)
				: workspaceRoot;
			const existing = byFile.get(filePath) ?? [];
			existing.push(v);
			byFile.set(filePath, existing);
		}

		for (const [filePath, vList] of byFile) {
			const fileUri = URI.file(filePath);
			// Group by violation kind (→ rule ID)
			const byRule = new Map<string, ISimulatorViolation[]>();
			for (const v of vList) {
				const ruleId = VIOLATION_RULE_MAP[v.kind];
				const existing = byRule.get(ruleId) ?? [];
				existing.push(v);
				byRule.set(ruleId, existing);
			}

			for (const [ruleId, rvList] of byRule) {
				const results: ICheckResult[] = rvList.map(v => ({
					ruleId,
					domain: VIOLATION_DOMAIN[v.kind] as any,
					severity: 'error',
					message: `[Simulator] ${v.message}`,
					fileUri,
					line: v.line ?? 1,
					column: 1,
					endLine: v.line ?? 1,
					endColumn: 1,
					codeSnippet: v.context,
					fix: _fixSuggestion(v.kind),
					timestamp,
					frameworkId: 'simulator',
					references: v.address ? [`Address: 0x${v.address}`] : undefined,
				}));
				this._grcEngine.setExternalResults(fileUri, ruleId, results);
			}
		}
	}

	// ─── Layer 1 + Layer 2 feedback ───────────────────────────────────────────

	private _feedbackLayers(violations: ISimulatorViolation[]): void {
		const ruleIds = [...new Set(violations.map(v => VIOLATION_RULE_MAP[v.kind]))];

		// Layer 2: boost confirmed runtime rules in index
		this._ruleIndex.boostRules(ruleIds);

		// Layer 1: record confirmed patterns in brief
		for (const v of violations) {
			this._briefService.recordExternalHit(
				VIOLATION_RULE_MAP[v.kind],
				'simulator',
				1
			);
		}
	}

	// ─── Persistence ─────────────────────────────────────────────────────────

	private async _persistSession(config: ISimulatorSessionConfig): Promise<void> {
		const dir = this._getSimulatorsDir();
		if (!dir) return;
		const inverseDir = this._getInverseDir();
		if (!inverseDir) return;
		try {
			await withInverseWriteAccess(inverseDir, async () => {
				if (!(await this._fileService.exists(dir))) {
					await this._fileService.createFolder(dir);
				}
				const uri = URI.joinPath(dir, `${config.id}.json`);
				await this._fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(config, null, 2)));
			});
		} catch (e) {
			console.warn('[SimulatorService] Failed to persist session:', e);
		}
	}

	private async _deletePersistedSession(sessionId: string): Promise<void> {
		const dir = this._getSimulatorsDir();
		const inverseDir = this._getInverseDir();
		if (!dir || !inverseDir) return;
		try {
			const uri = URI.joinPath(dir, `${sessionId}.json`);
			if (await this._fileService.exists(uri)) {
				await withInverseWriteAccess(inverseDir, async () => {
					await this._fileService.del(uri);
				});
			}
		} catch (e) {
			console.warn('[SimulatorService] Failed to delete session:', e);
		}
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────

	private _updateSession(id: string, partial: Partial<ISimulatorSession>): void {
		const session = this._sessions.get(id);
		if (!session) return;
		Object.assign(session, partial);
		this._fire(session);
	}

	private _appendOutput(id: string, text: string): void {
		const session = this._sessions.get(id);
		if (!session) return;
		const newLines = text.split('\n').filter(l => l.trim());
		session.outputLines.push(...newLines);
		// Keep last 2000 lines
		if (session.outputLines.length > 2000) {
			session.outputLines.splice(0, session.outputLines.length - 2000);
		}
		this._fire(session);
	}

	private _fire(session: ISimulatorSession): void {
		this._onDidSessionUpdate.fire(session);
	}

	private _substituteVars(cmd: string, workspaceRoot: string, elfAbs: string): string {
		return cmd
			.replace(/\$\{workspace\}/g, workspaceRoot)
			.replace(/\$\{elfAbs\}/g, elfAbs)
			.replace(/\$\{elf\}/g, elfAbs);
	}

	private _getWorkspaceRoot(): string | undefined {
		return this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
	}

	private _getSimulatorsDir(): URI | undefined {
		const root = this._workspaceContextService.getWorkspace().folders[0]?.uri;
		return root ? URI.joinPath(root, '.inverse', 'simulators') : undefined;
	}

	private _getInverseDir(): string | undefined {
		const root = this._workspaceContextService.getWorkspace().folders[0]?.uri.fsPath;
		return root ? `${root}/.inverse` : undefined;
	}
}

// ─── Fix suggestions per violation kind ──────────────────────────────────────

function _fixSuggestion(kind: RuntimeViolationKind): string {
	const fixes: Record<RuntimeViolationKind, string> = {
		'stack-overflow':      'Increase stack size, reduce local variable use, or check for unbounded recursion.',
		'heap-overflow':       'Check malloc/free pairs, use memory-safe APIs, add bounds checks.',
		'null-deref':          'Add null checks before pointer dereference. Use MISRA Rule 11.5 compliant patterns.',
		'watchdog-timeout':    'Ensure watchdog is kicked within deadline. Check for blocking code in main loop.',
		'timing-violation':    'Profile ISR execution time. Use RTOS priority ceiling or reduce ISR workload.',
		'assertion-failure':   'Investigate assert condition. Add defensive checks around the assertion site.',
		'memory-access-fault': 'Check MPU configuration. Verify pointer arithmetic and array bounds.',
		'divide-by-zero':      'Add divisor != 0 check before division operations.',
		'unaligned-access':    'Use memcpy for packed struct access. Align data structures to natural boundaries.',
		'isr-stack-overflow':  'Increase ISR stack size. Move processing out of ISR into task context.',
		'double-fault':        'Investigate exception handler stack. Check for nested fault conditions.',
		'privilege-violation': 'Check MPU/memory permissions. Verify code runs in correct privilege level.',
		'resource-leak':       'Ensure all file handles, mutexes, and memory are released in all code paths.',
		'deadlock':            'Review mutex acquisition order. Implement lock ordering protocol.',
		'data-race':           'Add mutex/critical section around shared variable access.',
		'undefined-behaviour': 'Compile with -fsanitize=undefined. Review arithmetic and pointer operations.',
		'custom':              'Review simulator output and debug the flagged condition.',
	};
	return fixes[kind] ?? 'Review the flagged runtime condition.';
}

registerSingleton(ISimulatorService, SimulatorServiceImpl, InstantiationType.Eager);
