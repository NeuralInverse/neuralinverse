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
 * 1. **Session lifecycle** \u2014 configure, build ELF, launch simulator, capture output, stop
 * 2. **Output parsing** \u2014 parse QEMU/Renode/GDB/Spike/custom output into ISimulatorViolation[]
 * 3. **GRC injection** \u2014 map violations to ICheckResult[] and inject into grcEngine
 * 4. **Persistence** \u2014 save/load session configs from .inverse/simulators/{id}.json
 * 5. **Feedback** \u2014 route confirmed runtime violations to Layer 1 (brief) + Layer 2 (index)
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
	ISimulatorPreset,
	RuntimeViolationKind,
} from './simulatorTypes.js';
import { ICheckResult } from '../types/grcTypes.js';


// \u2500\u2500\u2500 Service interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const ISimulatorService = createDecorator<ISimulatorService>('neuralInverseSimulatorService');

export interface ISimulatorService {
	readonly _serviceBrand: undefined;

	/** Fires whenever a session's status or violations change */
	readonly onDidSessionUpdate: Event<ISimulatorSession>;

	/** All sessions (active + historical) */
	getSessions(): ISimulatorSession[];

	/** Get a specific session by id */
	getSession(id: string): ISimulatorSession | undefined;

	/** All built-in simulator presets */
	getPresets(): ISimulatorPreset[];

	/**
	 * Create and immediately persist a new session config.
	 * Does NOT start the run \u2014 call runSession() for that.
	 */
	createSession(config: Omit<ISimulatorSessionConfig, 'id'>): Promise<ISimulatorSession>;

	/** Duplicate an existing session under a new name */
	cloneSession(sessionId: string, newName: string): Promise<ISimulatorSession>;

	/** Update a session's config (persists changes) */
	updateSession(sessionId: string, partial: Partial<Omit<ISimulatorSessionConfig, 'id'>>): Promise<void>;

	/**
	 * Run a session: optionally build ELF, launch simulator, capture output, parse violations.
	 * Fire-and-forget \u2014 updates arrive via onDidSessionUpdate.
	 */
	runSession(sessionId: string): Promise<void>;

	/** Stop a running session */
	stopSession(sessionId: string): Promise<void>;

	/** Delete a session and its persisted config */
	deleteSession(sessionId: string): Promise<void>;

	/** Load persisted session configs from .inverse/simulators/ */
	loadPersistedSessions(): Promise<void>;
}


// \u2500\u2500\u2500 Violation \u2192 GRC rule mapping \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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


// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

	// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	getSessions(): ISimulatorSession[] {
		return Array.from(this._sessions.values());
	}

	getSession(id: string): ISimulatorSession | undefined {
		return this._sessions.get(id);
	}

	getPresets(): ISimulatorPreset[] {
		return SIMULATOR_PRESETS;
	}

	async cloneSession(sessionId: string, newName: string): Promise<ISimulatorSession> {
		const existing = this._sessions.get(sessionId);
		if (!existing) throw new Error(`Session not found: ${sessionId}`);
		return this.createSession({ ...existing.config, name: newName, persist: true });
	}

	async updateSession(sessionId: string, partial: Partial<Omit<ISimulatorSessionConfig, 'id'>>): Promise<void> {
		const session = this._sessions.get(sessionId);
		if (!session) return;
		Object.assign(session.config, partial);
		if (session.config.persist) {
			await this._persistSession(session.config);
		}
		this._fire(session);
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

	// \u2500\u2500\u2500 Core run pipeline \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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
			// Non-zero exit is normal for simulators that detect faults \u2014 use whatever output we got
			stdout = e.stdout ?? e.message ?? '';
		}

		const lines = stdout.split('\n');
		this._appendOutput(sessionId, stdout);

		// Step 4: Parse violations
		const timestamp = Date.now();
		const violations = parseSimulatorOutput(lines, config.kind, timestamp);

		// Step 5: Map to GRC results and inject
		let injectedCount = 0;
		if (violations.length > 0) {
			injectedCount = this._injectViolations(violations, workspaceRoot, timestamp);
			this._feedbackLayers(violations);
		}

		this._updateSession(sessionId, {
			status: 'complete',
			completedAt: Date.now(),
			violations,
			injectedCount,
		});

		console.log(`[SimulatorService] Session ${sessionId} complete \u2014 ${violations.length} violation(s) found`);
	}

	// \u2500\u2500\u2500 GRC injection \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _injectViolations(violations: ISimulatorViolation[], workspaceRoot: string, timestamp: number): number {
		let totalInjected = 0;
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
			// Group by violation kind (\u2192 rule ID)
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
				totalInjected += results.length;
			}
		}
		return totalInjected;
	}

	// \u2500\u2500\u2500 Layer 1 + Layer 2 feedback \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

	// \u2500\u2500\u2500 Persistence \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

	// \u2500\u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

// \u2500\u2500\u2500 Fix suggestions per violation kind \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

// \u2500\u2500\u2500 Built-in simulator presets \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const SIMULATOR_PRESETS: ISimulatorPreset[] = [

	// \u2500\u2500 QEMU \u2014 ARM \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{
		id: 'preset-qemu-cortex-m4',
		name: 'QEMU \u2014 ARM Cortex-M4 (lm3s6965evb)',
		sector: 'Firmware & Embedded',
		targetPlatform: 'ARM Cortex-M4',
		kind: 'qemu',
		description: 'QEMU Cortex-M4 emulation for STM32/TI LM3S target. Detects HardFault, stack overflow, watchdog.',
		tags: ['ARM', 'Cortex-M4', 'MISRA-C:2012', 'IEC 61508'],
		elfPath: 'build/firmware.elf',
		buildCommand: 'make all',
		launchCommand: 'qemu-system-arm -machine lm3s6965evb -nographic -semihosting -kernel ${elfAbs}',
		timeoutMs: 60000,
	},
	{
		id: 'preset-qemu-cortex-m33',
		name: 'QEMU \u2014 ARM Cortex-M33 (mps2-an505)',
		sector: 'Firmware & Embedded',
		targetPlatform: 'ARM Cortex-M33',
		kind: 'qemu',
		description: 'QEMU Cortex-M33 with TrustZone \u2014 MPS2-AN505. Detects privilege violations, MPU faults.',
		tags: ['ARM', 'Cortex-M33', 'TrustZone', 'ISO 26262'],
		elfPath: 'build/firmware.elf',
		buildCommand: 'make all',
		launchCommand: 'qemu-system-arm -machine mps2-an505 -nographic -semihosting-config enable=on -kernel ${elfAbs}',
		timeoutMs: 60000,
	},
	{
		id: 'preset-qemu-cortex-a53',
		name: 'QEMU \u2014 ARM Cortex-A53 (virt)',
		sector: 'Telecom & 5G',
		targetPlatform: 'ARM Cortex-A53',
		kind: 'qemu',
		description: 'QEMU ARM64 virt machine for Cortex-A53 telecom/baseband. Detects data race, privilege faults.',
		tags: ['ARM64', 'Cortex-A53', '3GPP', 'GSMA'],
		elfPath: 'build/image.elf',
		buildCommand: 'make Image',
		launchCommand: 'qemu-system-aarch64 -machine virt -cpu cortex-a53 -nographic -kernel ${elfAbs}',
		timeoutMs: 120000,
	},
	{
		id: 'preset-qemu-riscv32',
		name: 'QEMU \u2014 RISC-V 32-bit (sifive_e)',
		sector: 'Industrial IoT & OT',
		targetPlatform: 'RISC-V RV32IMC',
		kind: 'qemu',
		description: 'QEMU RISC-V 32-bit SiFive E emulation. Detects access faults, misaligned access, WFI traps.',
		tags: ['RISC-V', 'IEC 62443', 'Industrial IoT'],
		elfPath: 'build/firmware.elf',
		buildCommand: 'make',
		launchCommand: 'qemu-system-riscv32 -machine sifive_e -nographic -kernel ${elfAbs}',
		timeoutMs: 60000,
	},
	{
		id: 'preset-qemu-riscv64',
		name: 'QEMU \u2014 RISC-V 64-bit (virt)',
		sector: 'Industrial IoT & OT',
		targetPlatform: 'RISC-V RV64GC',
		kind: 'qemu',
		description: 'QEMU RISC-V 64-bit virt machine. Suitable for RISC-V Linux-capable targets, safety-critical.',
		tags: ['RISC-V', 'IEC 62443', 'IEC 61508'],
		elfPath: 'build/image.elf',
		launchCommand: 'qemu-system-riscv64 -machine virt -nographic -kernel ${elfAbs}',
		timeoutMs: 120000,
	},
	{
		id: 'preset-qemu-microblaze',
		name: 'QEMU \u2014 Xilinx MicroBlaze',
		sector: 'Critical Infrastructure',
		targetPlatform: 'Xilinx MicroBlaze',
		kind: 'qemu',
		description: 'QEMU MicroBlaze for Xilinx FPGA-based critical infrastructure controllers.',
		tags: ['MicroBlaze', 'FPGA', 'IEC 62443', 'NERC CIP'],
		elfPath: 'build/firmware.elf',
		launchCommand: 'qemu-system-microblaze -machine petalogix-s3adsp1800 -nographic -kernel ${elfAbs}',
		timeoutMs: 120000,
	},
	{
		id: 'preset-qemu-mips',
		name: 'QEMU \u2014 MIPS Malta',
		sector: 'Telecom & 5G',
		targetPlatform: 'MIPS32',
		kind: 'qemu',
		description: 'QEMU MIPS Malta board for telecom equipment (DSPs, packet processors). Memory fault detection.',
		tags: ['MIPS', 'Telecom', 'ETSI'],
		elfPath: 'build/firmware.elf',
		launchCommand: 'qemu-system-mips -machine malta -nographic -kernel ${elfAbs}',
		timeoutMs: 120000,
	},
	{
		id: 'preset-qemu-ubsan',
		name: 'QEMU \u2014 UBSan + ASan (ARM)',
		sector: 'Automotive',
		targetPlatform: 'ARM Cortex-M (Sanitizers)',
		kind: 'qemu',
		description: 'Run UBSAN/ASAN-instrumented firmware under QEMU. Detects undefined behaviour, out-of-bounds.',
		tags: ['UBSan', 'ASan', 'MISRA-C:2012', 'ISO 26262'],
		elfPath: 'build/firmware_ubsan.elf',
		buildCommand: 'make CFLAGS="-fsanitize=undefined,address -g" all',
		launchCommand: 'qemu-system-arm -machine lm3s6965evb -nographic -semihosting -kernel ${elfAbs}',
		timeoutMs: 60000,
	},

	// \u2500\u2500 Renode \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{
		id: 'preset-renode-stm32',
		name: 'Renode \u2014 STM32F4 Discovery',
		sector: 'Firmware & Embedded',
		targetPlatform: 'STM32F4',
		kind: 'renode',
		description: 'Renode STM32F4 board. Precise peripheral emulation, watchdog, HardFault, MPU fault detection.',
		tags: ['STM32', 'ARM Cortex-M4', 'IEC 61508', 'DO-178C'],
		elfPath: 'build/firmware.elf',
		buildCommand: 'make',
		launchCommand: 'renode --disable-xwt -e "mach create; machine LoadPlatformDescription @platforms/boards/stm32f4_discovery.repl; sysbus LoadELF @${elfAbs}; start"',
		timeoutMs: 120000,
	},
	{
		id: 'preset-renode-nrf52',
		name: 'Renode \u2014 nRF52840',
		sector: 'Industrial IoT & OT',
		targetPlatform: 'Nordic nRF52840',
		kind: 'renode',
		description: 'Renode nRF52840 emulation for Bluetooth LE IoT firmware. Stack overflow, WDT detection.',
		tags: ['nRF52840', 'BLE', 'IEC 62443', 'Zephyr RTOS'],
		elfPath: 'build/zephyr/zephyr.elf',
		buildCommand: 'west build -b nrf52840dk_nrf52840',
		launchCommand: 'renode --disable-xwt -e "mach create; machine LoadPlatformDescription @platforms/cpus/nrf52840.repl; sysbus LoadELF @${elfAbs}; start"',
		timeoutMs: 120000,
	},
	{
		id: 'preset-renode-riscv-fe310',
		name: 'Renode \u2014 SiFive FE310',
		sector: 'Industrial IoT & OT',
		targetPlatform: 'SiFive FE310 (RISC-V)',
		kind: 'renode',
		description: 'Renode SiFive FE310 RISC-V simulation. Access faults, privilege trap, timing analysis.',
		tags: ['RISC-V', 'FE310', 'IEC 62443', 'FreeRTOS'],
		elfPath: 'build/firmware.elf',
		launchCommand: 'renode --disable-xwt -e "mach create; machine LoadPlatformDescription @platforms/cpus/sifive-fe310.repl; sysbus LoadELF @${elfAbs}; start"',
		timeoutMs: 120000,
	},
	{
		id: 'preset-renode-sam4s',
		name: 'Renode \u2014 Microchip SAM4S',
		sector: 'Automotive',
		targetPlatform: 'Microchip SAM4S (ARM M4)',
		kind: 'renode',
		description: 'Renode SAM4S \u2014 automotive ECU-class MCU. MISRA compliance + WDT, MPU violation detection.',
		tags: ['SAM4S', 'ARM Cortex-M4', 'ISO 26262', 'MISRA-C:2012'],
		elfPath: 'build/firmware.elf',
		buildCommand: 'make',
		launchCommand: 'renode --disable-xwt -e "mach create; machine LoadPlatformDescription @platforms/boards/sam4s-xplained.repl; sysbus LoadELF @${elfAbs}; start"',
		timeoutMs: 120000,
	},

	// \u2500\u2500 Spike (RISC-V ISA simulator) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{
		id: 'preset-spike-rv32',
		name: 'Spike \u2014 RISC-V RV32GC',
		sector: 'Firmware & Embedded',
		targetPlatform: 'RISC-V RV32GC',
		kind: 'spike',
		description: 'Spike RISC-V ISA simulator for RV32GC bare-metal. Detects access faults, illegal instructions.',
		tags: ['RISC-V', 'IEC 61508', 'CERT-C'],
		elfPath: 'build/firmware.elf',
		buildCommand: 'riscv32-unknown-elf-gcc -march=rv32gc -O2 -o ${elfAbs} src/*.c',
		launchCommand: 'spike --isa=rv32gc pk ${elfAbs}',
		timeoutMs: 60000,
	},
	{
		id: 'preset-spike-rv64',
		name: 'Spike \u2014 RISC-V RV64GC',
		sector: 'Industrial IoT & OT',
		targetPlatform: 'RISC-V RV64GC',
		kind: 'spike',
		description: 'Spike RISC-V 64-bit ISA simulator. Precise trap detection, privilege level enforcement.',
		tags: ['RISC-V', 'IEC 62443', 'CERT-C'],
		elfPath: 'build/firmware.elf',
		launchCommand: 'spike --isa=rv64gc pk ${elfAbs}',
		timeoutMs: 60000,
	},
	{
		id: 'preset-spike-rv32-htif',
		name: 'Spike \u2014 RV32 + UBSan (HTIF)',
		sector: 'Firmware & Embedded',
		targetPlatform: 'RISC-V RV32 + Sanitizers',
		kind: 'spike',
		description: 'RISC-V Spike with UBSan-instrumented firmware. Catches undefined behaviour in bare-metal.',
		tags: ['RISC-V', 'UBSan', 'IEC 61508', 'CERT-C'],
		elfPath: 'build/firmware_san.elf',
		buildCommand: 'riscv32-unknown-elf-gcc -fsanitize=undefined -march=rv32gc -o ${elfAbs} src/*.c',
		launchCommand: 'spike --isa=rv32gc pk ${elfAbs}',
		timeoutMs: 60000,
	},

	// \u2500\u2500 GDB Simulator \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{
		id: 'preset-gdbsim-arm-none',
		name: 'GDB Sim \u2014 ARM bare-metal (arm-none-eabi)',
		sector: 'Firmware & Embedded',
		targetPlatform: 'ARM bare-metal',
		kind: 'gdb-sim',
		description: 'GDB built-in ARM simulator for bare-metal ELF. Runs test harness, detects SIGSEGV, SIGFPE.',
		tags: ['ARM', 'GDB', 'DO-178C', 'IEC 61508'],
		elfPath: 'build/firmware.elf',
		buildCommand: 'arm-none-eabi-gcc -g -O0 -o ${elfAbs} src/*.c',
		launchCommand: 'arm-none-eabi-gdb --batch -ex "target sim" -ex "load ${elfAbs}" -ex "run" -ex "quit" ${elfAbs}',
		timeoutMs: 60000,
	},
	{
		id: 'preset-gdbsim-riscv',
		name: 'GDB Sim \u2014 RISC-V bare-metal',
		sector: 'Industrial IoT & OT',
		targetPlatform: 'RISC-V bare-metal',
		kind: 'gdb-sim',
		description: 'riscv-gdb simulator for bare-metal test execution. Catches illegal instruction, access faults.',
		tags: ['RISC-V', 'GDB', 'IEC 62443'],
		elfPath: 'build/firmware.elf',
		launchCommand: 'riscv64-unknown-elf-gdb --batch -ex "target sim" -ex "load ${elfAbs}" -ex "run" -ex "quit" ${elfAbs}',
		timeoutMs: 60000,
	},

	// \u2500\u2500 ARM Fast Models / AEM \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{
		id: 'preset-armvirt-cortex-r52',
		name: 'ARM FVP \u2014 Cortex-R52 (automotive)',
		sector: 'Automotive',
		targetPlatform: 'ARM Cortex-R52',
		kind: 'armvirt',
		description: 'ARM Fixed Virtual Platform for Cortex-R52 \u2014 real-time MCU class used in ISO 26262 ASIL-D.',
		tags: ['Cortex-R52', 'ISO 26262', 'ASIL-D', 'AUTOSAR'],
		elfPath: 'build/firmware.elf',
		buildCommand: 'make',
		launchCommand: 'FVP_BaseR_AEMv8R --application ${elfAbs} --no-interactive',
		timeoutMs: 180000,
	},
	{
		id: 'preset-armvirt-cortex-a55',
		name: 'ARM FVP \u2014 Cortex-A55 (5G modem)',
		sector: 'Telecom & 5G',
		targetPlatform: 'ARM Cortex-A55',
		kind: 'armvirt',
		description: 'ARM FVP Cortex-A55 for 5G baseband/modem firmware. Privilege, alignment, SError detection.',
		tags: ['Cortex-A55', '3GPP', 'GSMA', 'TS 33.117'],
		elfPath: 'build/image.elf',
		launchCommand: 'FVP_Base_Cortex-A55 --application ${elfAbs} --no-interactive',
		timeoutMs: 180000,
	},
	{
		id: 'preset-armvirt-m85',
		name: 'ARM FVP \u2014 Cortex-M85 (TrustZone-M)',
		sector: 'Critical Infrastructure',
		targetPlatform: 'ARM Cortex-M85',
		kind: 'armvirt',
		description: 'ARM FVP Cortex-M85 with TrustZone-M \u2014 critical infrastructure secure firmware.',
		tags: ['Cortex-M85', 'TrustZone-M', 'IEC 62443', 'PSA Certified'],
		elfPath: 'build/firmware.elf',
		buildCommand: 'make',
		launchCommand: 'FVP_MPS2_Cortex-M85 --application ${elfAbs} --no-interactive',
		timeoutMs: 120000,
	},

	// \u2500\u2500 Proteus VSM \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{
		id: 'preset-proteus-arduino',
		name: 'Proteus VSM \u2014 Arduino Mega (ATmega2560)',
		sector: 'Industrial IoT & OT',
		targetPlatform: 'Arduino Mega / ATmega2560',
		kind: 'proteus',
		description: 'Proteus VSM simulation for Arduino Mega. Detects WDT reset, stack overflow, divide-by-zero.',
		tags: ['AVR', 'ATmega2560', 'IEC 62443', 'Industrial IoT'],
		elfPath: 'build/firmware.hex',
		buildCommand: 'arduino-cli compile --fqbn arduino:avr:mega --output-dir build .',
		launchCommand: 'vsm-headless -proj ${workspace}/proteus/mega.pdsprj -bin ${elfAbs} -run 60 -log .inverse/proteus.log',
		timeoutMs: 120000,
	},
	{
		id: 'preset-proteus-stm32f103',
		name: 'Proteus VSM \u2014 STM32F103 (Blue Pill)',
		sector: 'Firmware & Embedded',
		targetPlatform: 'STM32F103',
		kind: 'proteus',
		description: 'Proteus VSM STM32F103 simulation with peripheral models. MISRA runtime fault detection.',
		tags: ['STM32F103', 'ARM Cortex-M3', 'MISRA-C:2012', 'IEC 61508'],
		elfPath: 'build/firmware.hex',
		buildCommand: 'make',
		launchCommand: 'vsm-headless -proj ${workspace}/proteus/stm32f103.pdsprj -bin ${elfAbs} -run 60 -log .inverse/proteus.log',
		timeoutMs: 120000,
	},
	{
		id: 'preset-proteus-pic18',
		name: 'Proteus VSM \u2014 PIC18F4550',
		sector: 'Industrial IoT & OT',
		targetPlatform: 'Microchip PIC18F4550',
		kind: 'proteus',
		description: 'Proteus PIC18 simulation for legacy industrial IoT. WDT, stack, interrupt violation detection.',
		tags: ['PIC18', 'Microchip', 'IEC 62443', 'Industrial IoT'],
		elfPath: 'build/firmware.hex',
		buildCommand: 'xc8 --chip=18F4550 -O src/*.c -o ${elfAbs}',
		launchCommand: 'vsm-headless -proj ${workspace}/proteus/pic18.pdsprj -bin ${elfAbs} -run 60 -log .inverse/proteus.log',
		timeoutMs: 120000,
	},

	// \u2500\u2500 MATLAB / Simulink \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{
		id: 'preset-matlab-sil-automotive',
		name: 'MATLAB SIL \u2014 Automotive ECU (ISO 26262)',
		sector: 'Automotive',
		targetPlatform: 'MATLAB/Simulink SIL',
		kind: 'matlab',
		description: 'Software-in-the-Loop execution of Simulink Coder-generated C code. ASIL-B/D timing + assertion checks.',
		tags: ['ISO 26262', 'ASIL-D', 'MATLAB', 'Simulink'],
		elfPath: 'slprj/sil/EcuModel',
		buildCommand: 'matlab -batch "codegen_script; exit"',
		launchCommand: 'matlab -batch "runtests(\'EcuModel_SIL_Tests\'); exit" 2>&1',
		timeoutMs: 300000,
	},
	{
		id: 'preset-matlab-sil-do178',
		name: 'MATLAB SIL \u2014 Avionics DO-178C',
		sector: 'Firmware & Embedded',
		targetPlatform: 'MATLAB/Simulink SIL',
		kind: 'matlab',
		description: 'DO-178C Level A SIL verification. Structural coverage + timing analysis via Simulink Test.',
		tags: ['DO-178C', 'MATLAB', 'Simulink', 'IEC 61508'],
		elfPath: 'slprj/sil/FlightControl',
		buildCommand: 'matlab -batch "coder.workflow.generateCode(\'FlightControl\'); exit"',
		launchCommand: 'matlab -batch "run(\'FlightControl_SILTest.mldatx\'); exit" 2>&1',
		timeoutMs: 600000,
	},
	{
		id: 'preset-simulink-mil',
		name: 'Simulink MIL \u2014 Model-in-the-Loop (IEC 61508)',
		sector: 'Critical Infrastructure',
		targetPlatform: 'Simulink Model-in-the-Loop',
		kind: 'simulink',
		description: 'Model-in-the-Loop harness run via simulink-batch. Detects assertion failures, timing overruns, overflows.',
		tags: ['IEC 61508', 'Simulink', 'MIL', 'SIL'],
		elfPath: 'models/SafetyController.slx',
		buildCommand: 'matlab -batch "open_system(\'SafetyController\'); sim_build; exit"',
		launchCommand: 'matlab -batch "results = sim(\'SafetyController\'); disp(results.logsout); exit" 2>&1',
		timeoutMs: 300000,
	},
	{
		id: 'preset-simulink-pil-stm32',
		name: 'Simulink PIL \u2014 STM32 Processor-in-the-Loop',
		sector: 'Automotive',
		targetPlatform: 'STM32 / Embedded Coder PIL',
		kind: 'simulink',
		description: 'PIL execution on real STM32 hardware via Embedded Coder. Timing, overflow, ASIL checks.',
		tags: ['ISO 26262', 'ASIL-B', 'STM32', 'Embedded Coder'],
		elfPath: 'slprj/pil/EcuController',
		buildCommand: 'matlab -batch "set_param(\'EcuController\',\'SimulationMode\',\'pil\'); slbuild(\'EcuController\'); exit"',
		launchCommand: 'matlab -batch "sim(\'EcuController_PIL_harness\'); exit" 2>&1',
		timeoutMs: 600000,
	},

	// \u2500\u2500 gem5 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{
		id: 'preset-gem5-arm-se',
		name: 'gem5 \u2014 ARM Syscall-Emulation',
		sector: 'Firmware & Embedded',
		targetPlatform: 'ARM (gem5 SE mode)',
		kind: 'gem5',
		description: 'gem5 ARM syscall-emulation mode. Deep microarchitecture fidelity, timing analysis, cache fault detection.',
		tags: ['ARM', 'gem5', 'IEC 61508', 'CERT-C'],
		elfPath: 'build/firmware',
		buildCommand: 'make',
		launchCommand: 'gem5.opt ${workspace}/configs/example/se.py --cmd=${elfAbs} --cpu-type=O3CPU 2>&1',
		timeoutMs: 300000,
	},
	{
		id: 'preset-gem5-arm-fs',
		name: 'gem5 \u2014 ARM Full-System (Linux)',
		sector: 'Telecom & 5G',
		targetPlatform: 'ARM64 Full-System (gem5)',
		kind: 'gem5',
		description: 'gem5 full-system simulation with Linux boot. Detects privilege violations, memory faults in telecom stacks.',
		tags: ['ARM64', 'gem5', '3GPP', 'GSMA'],
		elfPath: 'images/arm-linux-kernel',
		launchCommand: 'gem5.opt ${workspace}/configs/example/arm/fs_bigLITTLE.py --kernel=${elfAbs} --bootscript=${workspace}/scripts/boot.rcS 2>&1',
		timeoutMs: 600000,
	},
	{
		id: 'preset-gem5-riscv-se',
		name: 'gem5 \u2014 RISC-V Syscall-Emulation',
		sector: 'Industrial IoT & OT',
		targetPlatform: 'RISC-V (gem5 SE mode)',
		kind: 'gem5',
		description: 'gem5 RISC-V SE mode for IIoT/OT firmware. Memory access faults, illegal instructions, timing.',
		tags: ['RISC-V', 'gem5', 'IEC 62443', 'IEC 61508'],
		elfPath: 'build/firmware',
		buildCommand: 'riscv64-unknown-linux-gnu-gcc -O2 -o ${elfAbs} src/*.c',
		launchCommand: 'gem5.opt ${workspace}/configs/example/se.py --isa=riscv --cmd=${elfAbs} 2>&1',
		timeoutMs: 300000,
	},

	// \u2500\u2500 OVPsim / Imperas \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{
		id: 'preset-ovpsim-cortex-m4',
		name: 'OVPsim \u2014 ARM Cortex-M4 (Imperas)',
		sector: 'Firmware & Embedded',
		targetPlatform: 'ARM Cortex-M4 (OVPsim)',
		kind: 'ovpsim',
		description: 'Imperas OVPsim instruction-accurate Cortex-M4. MISRA runtime, WDT, MPU violation detection.',
		tags: ['ARM Cortex-M4', 'OVPsim', 'MISRA-C:2012', 'IEC 61508'],
		elfPath: 'build/firmware.elf',
		buildCommand: 'make',
		launchCommand: 'ovpsimdemo.exe --program ${elfAbs} --processorvendor arm.ovpworld.org --processorname cortexm4 2>&1',
		timeoutMs: 120000,
	},
	{
		id: 'preset-ovpsim-riscv',
		name: 'OVPsim \u2014 RISC-V (Imperas)',
		sector: 'Industrial IoT & OT',
		targetPlatform: 'RISC-V (OVPsim)',
		kind: 'ovpsim',
		description: 'OVPsim RISC-V instruction-accurate simulation. Privilege trap, unaligned access, WDT detection.',
		tags: ['RISC-V', 'OVPsim', 'IEC 62443', 'CERT-C'],
		elfPath: 'build/firmware.elf',
		launchCommand: 'ovpsimdemo.exe --program ${elfAbs} --processorvendor riscv.ovpworld.org --processorname riscv 2>&1',
		timeoutMs: 120000,
	},
	{
		id: 'preset-ovpsim-mips',
		name: 'OVPsim \u2014 MIPS (Imperas)',
		sector: 'Telecom & 5G',
		targetPlatform: 'MIPS32 (OVPsim)',
		kind: 'ovpsim',
		description: 'OVPsim MIPS for telecom DSP/packet processor firmware. Memory fault, privilege level checks.',
		tags: ['MIPS', 'OVPsim', 'Telecom', 'ETSI'],
		elfPath: 'build/firmware.elf',
		launchCommand: 'ovpsimdemo.exe --program ${elfAbs} --processorvendor mips.ovpworld.org --processorname mips32 2>&1',
		timeoutMs: 120000,
	},

	// \u2500\u2500 Bochs x86 \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{
		id: 'preset-bochs-x86-bios',
		name: 'Bochs \u2014 x86 Firmware / BIOS (IEC 62443)',
		sector: 'Critical Infrastructure',
		targetPlatform: 'x86 (Bochs)',
		kind: 'bochs',
		description: 'Bochs x86 emulation for legacy SCADA/HMI BIOS firmware. Page fault, privilege, GPF detection.',
		tags: ['x86', 'Bochs', 'IEC 62443', 'NERC CIP'],
		elfPath: 'build/bios.bin',
		buildCommand: 'make bios',
		launchCommand: 'bochs -q -f ${workspace}/bochsrc.txt 2>&1',
		timeoutMs: 300000,
	},
	{
		id: 'preset-bochs-x86-bootloader',
		name: 'Bochs \u2014 x86 Bootloader / Bare-metal',
		sector: 'Firmware & Embedded',
		targetPlatform: 'x86 Bare-metal (Bochs)',
		kind: 'bochs',
		description: 'Bochs x86 bare-metal bootloader simulation. Detects stack overflow, divide-by-zero, unaligned access.',
		tags: ['x86', 'Bochs', 'Bootloader', 'IEC 61508'],
		elfPath: 'build/boot.bin',
		buildCommand: 'nasm -f bin src/boot.asm -o ${elfAbs}',
		launchCommand: 'bochs -q -f ${workspace}/bochsrc.txt 2>&1',
		timeoutMs: 120000,
	},

	// \u2500\u2500 VirtualBox Headless \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{
		id: 'preset-vbox-linux-compliance',
		name: 'VirtualBox \u2014 Linux OS Compliance Test',
		sector: 'Critical Infrastructure',
		targetPlatform: 'Linux x86-64 VM (VirtualBox)',
		kind: 'virtualbox',
		description: 'Headless VirtualBox VM running compliance test scripts. Kernel panic, assertion, resource leak detection.',
		tags: ['Linux', 'VirtualBox', 'IEC 62443', 'NERC CIP'],
		elfPath: 'scripts/compliance_test.sh',
		buildCommand: 'VBoxManage import ${workspace}/vm/compliance_test.ova --vsys 0 --vmname ComplianceTest',
		launchCommand: 'VBoxHeadless --startvm ComplianceTest & sleep 60 && VBoxManage guestcontrol ComplianceTest run --exe /compliance_test.sh 2>&1',
		timeoutMs: 600000,
	},
	{
		id: 'preset-vbox-rtos-test',
		name: 'VirtualBox \u2014 RTOS Integration Test',
		sector: 'Industrial IoT & OT',
		targetPlatform: 'x86 RTOS VM (VirtualBox)',
		kind: 'virtualbox',
		description: 'Headless VM running RTOS integration test suite. Detects deadlock, race condition, timing overruns.',
		tags: ['RTOS', 'VirtualBox', 'IEC 62443', 'FreeRTOS'],
		elfPath: 'build/rtos_test.bin',
		buildCommand: 'make integration',
		launchCommand: 'VBoxHeadless --startvm RTOSTest 2>&1',
		timeoutMs: 600000,
	},

	// \u2500\u2500 Custom examples \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	{
		id: 'preset-custom-ctest',
		name: 'Custom \u2014 CTest / Catch2 (bare-metal)',
		sector: 'General',
		targetPlatform: 'Any (host-side test runner)',
		kind: 'custom',
		description: 'Run CTest or Catch2 test suite. Parses SIGSEGV, SIGFPE, assertion failures into violations.',
		tags: ['CTest', 'Catch2', 'Unit Testing', 'CERT-C'],
		elfPath: 'build/tests/unit_tests',
		buildCommand: 'cmake --build ${workspace}/build --target unit_tests',
		launchCommand: '${elfAbs} --reporter console',
		timeoutMs: 60000,
	},
	{
		id: 'preset-custom-valgrind',
		name: 'Custom \u2014 Valgrind Memcheck',
		sector: 'General',
		targetPlatform: 'Linux x86-64',
		kind: 'custom',
		description: 'Valgrind memcheck for heap analysis. Detects heap overflow, null-deref, resource leaks.',
		tags: ['Valgrind', 'Memcheck', 'CWE', 'CERT-C'],
		elfPath: 'build/firmware_host',
		buildCommand: 'make host',
		launchCommand: 'valgrind --tool=memcheck --leak-check=full --error-exitcode=1 ${elfAbs}',
		timeoutMs: 120000,
	},
	{
		id: 'preset-custom-sanitizers',
		name: 'Custom \u2014 ASAN + UBSAN (host)',
		sector: 'General',
		targetPlatform: 'Linux x86-64 (Sanitizers)',
		kind: 'custom',
		description: 'ASAN + UBSAN sanitizer run. Detects heap overflow, undefined behaviour, memory faults.',
		tags: ['ASan', 'UBSan', 'CERT-C', 'CWE'],
		elfPath: 'build/firmware_san',
		buildCommand: 'gcc -fsanitize=address,undefined -g -O1 -o ${elfAbs} src/*.c',
		launchCommand: '${elfAbs}',
		timeoutMs: 60000,
		env: { ASAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1', UBSAN_OPTIONS: 'print_stacktrace=1' },
	},
	{
		id: 'preset-custom-tsan',
		name: 'Custom \u2014 ThreadSanitizer (TSan)',
		sector: 'General',
		targetPlatform: 'Linux x86-64 (TSan)',
		kind: 'custom',
		description: 'ThreadSanitizer for data race detection in RTOS-like host builds.',
		tags: ['TSan', 'Data Race', 'CERT-C', 'CWE-362'],
		elfPath: 'build/firmware_tsan',
		buildCommand: 'gcc -fsanitize=thread -g -O1 -o ${elfAbs} src/*.c',
		launchCommand: '${elfAbs}',
		timeoutMs: 60000,
	},
];

registerSingleton(ISimulatorService, SimulatorServiceImpl, InstantiationType.Eager);
