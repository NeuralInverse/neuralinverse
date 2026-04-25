/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # External Tool Service
 *
 * Orchestration layer for external static analysis tools (CodeQL, Semgrep, Polyspace,
 * MATLAB mlint, ESLint, Checkstyle, and any custom CLI tool).
 *
 * ## Responsibilities
 *
 * 1. **Tool detection** \u2014 check if the configured binary exists in PATH.
 * 2. **Cache checking** \u2014 skip re-running when source content hasn't changed.
 * 3. **Job lifecycle** \u2014 track queued/running/complete/failed/skipped/cancelled jobs.
 * 4. **Command execution** \u2014 delegate to `IExternalCommandExecutor` (terminal redirect).
 * 5. **Output parsing** \u2014 route stdout to the correct parser (SARIF, Polyspace, \u2026).
 * 6. **Result injection** \u2014 call `IGRCEngineService.setExternalResults()` per file.
 *
 * ## Architecture
 *
 * ```
 * GRCEngineService.scanWorkspace()  \u2500\u2192  runWorkspaceScans(rules)
 * GRCEngineService.evaluateFileContent()  \u2500\u2192  runFileScans(rules, fileUri, content)
 *
 * Both paths share:
 *   ExternalToolDetector  \u2192 ExternalResultCache \u2192 ExternalCommandExecutor
 *                        \u2192 ExternalOutputParsers \u2192 grcEngine.setExternalResults()
 * ```
 *
 * ## Concurrency
 *
 * Max 4 concurrent jobs (2 workspace-scope + 2 file-scope).
 * File-scope jobs are prioritised over workspace-scope jobs since the user
 * is actively editing those files.
 *
 * Deduplication: only one job per `ruleId:scope:targetUri` is active at a time.
 * Duplicate requests are dropped (the in-flight job covers them).
 *
 * See: docs/EXTERNAL_ANALYSIS_BRIDGE.md \u2014 Part 7
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IGRCRule, ICheckResult } from '../types/grcTypes.js';
import { IExternalCheck } from '../framework/frameworkSchema.js';
import { IExternalJob } from '../types/externalJobTypes.js';
import { IExternalCommandExecutor } from './externalCommandExecutor.js';
import { IExternalResultCache, hashString, hashWorkspaceFingerprint } from './externalResultCache.js';
import { ExternalToolDetector } from './externalToolDetector.js';
import {
	SarifParser,
	PolyspaceParser,
	MatlabMlintParser,
	EslintJsonParser,
	CheckstyleXmlParser,
} from './externalOutputParsers.js';


// \u2500\u2500\u2500 Service Interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const IExternalToolService = createDecorator<IExternalToolService>('neuralInverseExternalToolService');

export interface IExternalToolService {
	readonly _serviceBrand: undefined;

	/** Fires on every job state change */
	readonly onDidJobUpdate: Event<IExternalJob>;

	/** Current job list (all statuses) */
	getJobs(): IExternalJob[];

	/**
	 * Run workspace-scope external checks.
	 * Called by `GRCEngineService.scanWorkspace()` for rules with `scope === 'workspace'`.
	 * Async fire-and-forget \u2014 results arrive via `IGRCEngineService.setExternalResults()`.
	 */
	runWorkspaceScans(rules: IGRCRule[]): Promise<void>;

	/**
	 * Run file-scope external checks.
	 * Called by `GRCEngineService.evaluateFileContent()` for rules with `scope === 'file'`.
	 * Fire-and-forget.
	 */
	runFileScans(rules: IGRCRule[], fileUri: URI, content: string): void;

	/** Cancel all queued and running jobs. */
	cancelAll(): Promise<void>;

	/** Check whether a binary is in PATH (cached 60s). */
	isToolAvailable(binary: string): Promise<boolean>;

	/** Invalidate all cached external results so tools are re-run on next scan. */
	clearCache(): void;

	/**
	 * Register the callback that injects results into the GRC engine.
	 * Called once by GRCEngineService after construction.
	 */
	registerResultSink(fn: (fileUri: URI, ruleId: string, results: ICheckResult[]) => void): void;
}


// \u2500\u2500\u2500 Constants \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const MAX_WORKSPACE_CONCURRENT = 2;
const MAX_FILE_CONCURRENT = 2;

/** Extensions included in workspace fingerprint scan */
const SCANNABLE_EXTENSIONS = new Set([
	'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
	'py', 'java', 'c', 'cpp', 'h', 'hpp',
	'cs', 'go', 'rs', 'rb', 'php', 'swift',
	'kt', 'scala', 'm', 'mat', 'f90', 'ada',
]);

const MAX_FINGERPRINT_FILES = 2000;


// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export class ExternalToolServiceImpl extends Disposable implements IExternalToolService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidJobUpdate = this._register(new Emitter<IExternalJob>());
	readonly onDidJobUpdate: Event<IExternalJob> = this._onDidJobUpdate.event;

	/** All jobs, keyed by job ID */
	private readonly _jobs = new Map<string, IExternalJob>();

	/** IDs of currently running workspace-scope jobs */
	private readonly _runningWorkspace = new Set<string>();

	/** IDs of currently running file-scope jobs */
	private readonly _runningFile = new Set<string>();

	/** Result injection callback (set by GRCEngineService) */
	private _resultSink?: (fileUri: URI, ruleId: string, results: ICheckResult[]) => void;

	/** Exec function for ExternalToolDetector */
	private readonly _execForDetector: (cmd: string) => Promise<string>;

	constructor(
		@IExternalCommandExecutor private readonly _commandExecutor: IExternalCommandExecutor,
		@IExternalResultCache private readonly _cache: IExternalResultCache,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();

		// Build exec adapter: ExternalToolDetector expects (cmd) => Promise<string>
		// We piggy-back on ExternalCommandExecutor for a quick `which`-style exec.
		this._execForDetector = async (cmd: string) => {
			return this._commandExecutor.execute(
				`detector_${Date.now()}`,
				cmd,
				5_000  // 5s timeout for which/where
			);
		};
	}

	// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	getJobs(): IExternalJob[] {
		return Array.from(this._jobs.values());
	}

	registerResultSink(fn: (fileUri: URI, ruleId: string, results: ICheckResult[]) => void): void {
		this._resultSink = fn;
	}

	async isToolAvailable(binary: string): Promise<boolean> {
		return ExternalToolDetector.isAvailable(binary, this._execForDetector);
	}

	clearCache(): void {
		this._cache.invalidateAll();
		console.log('[ExternalToolService] Result cache cleared');
	}

	async runWorkspaceScans(rules: IGRCRule[]): Promise<void> {
		const wsRules = rules.filter(r => {
			const check = r.check as IExternalCheck | undefined;
			return check?.type === 'external' && check.scope === 'workspace';
		});

		for (const rule of wsRules) {
			// Fire-and-forget each rule (respect max concurrency internally)
			this._runWorkspaceRule(rule).catch(e =>
				console.error(`[ExternalToolService] workspace scan error for ${rule.id}:`, e)
			);
		}
	}

	runFileScans(rules: IGRCRule[], fileUri: URI, content: string): void {
		const fileRules = rules.filter(r => {
			const check = r.check as IExternalCheck | undefined;
			return check?.type === 'external' && (check.scope ?? 'file') === 'file';
		});

		for (const rule of fileRules) {
			this._runFileRule(rule, fileUri, content).catch(e =>
				console.error(`[ExternalToolService] file scan error for ${rule.id}:`, e)
			);
		}
	}

	async cancelAll(): Promise<void> {
		for (const [id, job] of this._jobs) {
			if (job.status === 'queued' || job.status === 'running') {
				this._updateJob(id, { status: 'cancelled' });
			}
		}
		this._runningWorkspace.clear();
		this._runningFile.clear();
	}


	// \u2500\u2500\u2500 Workspace Scan Pipeline \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _runWorkspaceRule(rule: IGRCRule): Promise<void> {
		const check = rule.check as IExternalCheck;
		const jobId = `${rule.id}:workspace`;

		// Deduplication
		if (this._runningWorkspace.has(jobId)) {
			return;
		}

		// Wait if at capacity
		while (this._runningWorkspace.size >= MAX_WORKSPACE_CONCURRENT) {
			await _sleep(1_000);
		}

		// Check if job was cancelled while waiting
		const existingJob = this._jobs.get(jobId);
		if (existingJob?.status === 'cancelled') {
			return;
		}

		// Enqueue
		const job = this._createJob(jobId, rule, 'workspace');

		// 1. Tool availability check
		if (check.toolBinary) {
			const available = await ExternalToolDetector.isAvailable(check.toolBinary, this._execForDetector);
			if (!available) {
				this._updateJob(jobId, { status: 'skipped', skipReason: 'tool-not-found' });
				return;
			}
		}

		// 2. Workspace fingerprint + cache check
		if ((check.cacheStrategy ?? 'content-hash') === 'content-hash') {
			const fingerprint = await this._computeWorkspaceFingerprint();
			const cached = this._cache.get(jobId, fingerprint);
			if (cached) {
				this._updateJob(jobId, { status: 'skipped', skipReason: 'cache-hit', cacheHit: true, resultCount: _countResults(cached) });
				this._injectResults(cached);
				return;
			}
		}

		// 3. Run
		this._runningWorkspace.add(jobId);
		this._updateJob(jobId, { status: 'running', startedAt: Date.now() });

		try {
			const workspaceRoot = this._getWorkspaceRoot();
			if (!workspaceRoot) {
				this._updateJob(jobId, { status: 'skipped', skipReason: 'no-workspace' });
				return;
			}

			const command = this._substituteVariables(check.command, undefined, workspaceRoot, workspaceRoot, check.workingDirectory);
			const timestamp = Date.now();

			const stdout = await this._commandExecutor.execute(
				jobId,
				command,
				check.timeoutMs ?? 300_000,  // Default 5 min for workspace tools
				check.maxOutputBytes ?? 5_242_880,
				check.env
			);

			const results = _parseOutput(stdout, check, rule, workspaceRoot, timestamp);
			const count = _countResults(results);

			// Cache results
			if ((check.cacheStrategy ?? 'content-hash') === 'content-hash') {
				const fingerprint = await this._computeWorkspaceFingerprint();
				this._cache.set(jobId, fingerprint, results);
			}

			// Inject into engine
			this._injectResults(results);

			this._updateJob(jobId, {
				status: 'complete',
				completedAt: Date.now(),
				durationMs: Date.now() - (job.startedAt ?? Date.now()),
				resultCount: count,
			});
		} catch (e: any) {
			const isLicense = e.message?.toLowerCase().includes('license');
			this._updateJob(jobId, {
				status: isLicense ? 'skipped' : 'failed',
				skipReason: isLicense ? 'license-error' : undefined,
				error: e.message,
				completedAt: Date.now(),
			});
		} finally {
			this._runningWorkspace.delete(jobId);
		}
	}


	// \u2500\u2500\u2500 File Scan Pipeline \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _runFileRule(rule: IGRCRule, fileUri: URI, content: string): Promise<void> {
		const check = rule.check as IExternalCheck;
		const jobId = `${rule.id}:file:${fileUri.toString()}`;

		// Deduplication
		if (this._runningFile.has(jobId)) {
			return;
		}

		// Wait if at capacity
		while (this._runningFile.size >= MAX_FILE_CONCURRENT) {
			await _sleep(500);
		}

		// 1. Tool availability check
		if (check.toolBinary) {
			const available = await ExternalToolDetector.isAvailable(check.toolBinary, this._execForDetector);
			if (!available) {
				const job = this._createJob(jobId, rule, 'file', fileUri);
				this._updateJob(jobId, { status: 'skipped', skipReason: 'tool-not-found' });
				void job;
				return;
			}
		}

		// 2. Content-hash cache check
		if ((check.cacheStrategy ?? 'content-hash') === 'content-hash') {
			const contentHash = hashString(content);
			const cached = this._cache.get(jobId, contentHash);
			if (cached) {
				const job = this._createJob(jobId, rule, 'file', fileUri);
				this._updateJob(jobId, { status: 'skipped', skipReason: 'cache-hit', cacheHit: true, resultCount: _countResults(cached) });
				this._injectResults(cached);
				void job;
				return;
			}
		}

		// 3. Run
		const job = this._createJob(jobId, rule, 'file', fileUri);
		this._runningFile.add(jobId);
		this._updateJob(jobId, { status: 'running', startedAt: Date.now() });

		try {
			const workspaceRoot = this._getWorkspaceRoot(fileUri) ?? fileUri.fsPath;
			const fileDir = fileUri.fsPath.replace(/[/\\][^/\\]+$/, '');
			const workingDir = check.workingDirectory === 'file-dir' ? fileDir : workspaceRoot;

			const command = this._substituteVariables(check.command, fileUri, workspaceRoot, workingDir, check.workingDirectory);
			const timestamp = Date.now();

			const stdout = await this._commandExecutor.execute(
				jobId,
				command,
				check.timeoutMs ?? 30_000,
				check.maxOutputBytes ?? 5_242_880,
				check.env
			);

			const results = _parseOutput(stdout, check, rule, workspaceRoot, timestamp, fileUri);
			const count = _countResults(results);

			// Cache
			if ((check.cacheStrategy ?? 'content-hash') === 'content-hash') {
				const contentHash = hashString(content);
				this._cache.set(jobId, contentHash, results);
			}

			this._injectResults(results);

			this._updateJob(jobId, {
				status: 'complete',
				completedAt: Date.now(),
				durationMs: Date.now() - (job.startedAt ?? Date.now()),
				resultCount: count,
			});
		} catch (e: any) {
			const isLicense = e.message?.toLowerCase().includes('license');
			this._updateJob(jobId, {
				status: isLicense ? 'skipped' : 'failed',
				skipReason: isLicense ? 'license-error' : undefined,
				error: e.message,
				completedAt: Date.now(),
			});
		} finally {
			this._runningFile.delete(jobId);
		}
	}


	// \u2500\u2500\u2500 Job Management \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _createJob(
		id: string,
		rule: IGRCRule,
		scope: 'file' | 'workspace',
		targetUri?: URI
	): IExternalJob {
		const check = rule.check as IExternalCheck | undefined;
		const toolName = check?.toolBinary ?? rule.id;
		const job: IExternalJob = {
			id,
			ruleId: rule.id,
			toolName,
			scope,
			targetUri,
			status: 'queued',
			queuedAt: Date.now(),
			resultCount: 0,
			cacheHit: false,
		};
		this._jobs.set(id, job);
		this._onDidJobUpdate.fire(job);
		return job;
	}

	private _updateJob(id: string, updates: Partial<IExternalJob>): void {
		const job = this._jobs.get(id);
		if (!job) return;
		const updated = { ...job, ...updates };
		this._jobs.set(id, updated);
		this._onDidJobUpdate.fire(updated);
	}


	// \u2500\u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _injectResults(results: Map<string, ICheckResult[]>): void {
		if (!this._resultSink) {
			console.warn('[ExternalToolService] No result sink registered; results discarded');
			return;
		}
		for (const [fileUriStr, fileResults] of results) {
			if (fileResults.length === 0) continue;
			const fileUri = URI.parse(fileUriStr);
			const ruleId = fileResults[0].ruleId;
			this._resultSink(fileUri, ruleId, fileResults);
		}
	}

	private _getWorkspaceRoot(fileUri?: URI): string | undefined {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) return undefined;
		if (fileUri) {
			const folder = this._workspaceContextService.getWorkspaceFolder(fileUri);
			return folder?.uri.fsPath ?? folders[0].uri.fsPath;
		}
		return folders[0].uri.fsPath;
	}

	private async _computeWorkspaceFingerprint(): Promise<number> {
		const wsRoot = this._getWorkspaceRoot();
		if (!wsRoot) return 0;

		try {
			const rootUri = URI.file(wsRoot);
			const files = await this._collectScannableFiles(rootUri);
			return hashWorkspaceFingerprint(files);
		} catch {
			return Date.now(); // Fallback \u2014 always re-run on error
		}
	}

	private async _collectScannableFiles(
		dirUri: URI,
		files: Array<{ path: string; mtime: number }> = [],
		depth = 0
	): Promise<Array<{ path: string; mtime: number }>> {
		if (depth > 8 || files.length >= MAX_FINGERPRINT_FILES) return files;

		try {
			const stat = await this._fileService.resolve(dirUri);
			if (!stat.children) return files;

			for (const child of stat.children) {
				if (files.length >= MAX_FINGERPRINT_FILES) break;
				const name = child.name;

				if (child.isDirectory) {
					// Skip common non-source dirs
					if (/^(node_modules|\.git|\.inverse|dist|build|out|target|\.polyspace)$/.test(name)) continue;
					await this._collectScannableFiles(child.resource, files, depth + 1);
				} else {
					const ext = name.split('.').pop()?.toLowerCase() ?? '';
					if (SCANNABLE_EXTENSIONS.has(ext)) {
						files.push({ path: child.resource.fsPath, mtime: child.mtime ?? 0 });
					}
				}
			}
		} catch {
			// Directory unreadable \u2014 skip
		}

		return files;
	}

	private _substituteVariables(
		command: string,
		fileUri: URI | undefined,
		workspaceRoot: string,
		workingDir: string,
		dirMode?: 'workspace' | 'file-dir'
	): string {
		let result = command;

		// ${workspace}
		result = result.replace(/\$\{workspace\}/g, workspaceRoot);

		// ${file}
		if (fileUri) {
			result = result.replace(/\$\{file\}/g, fileUri.fsPath);

			// ${relativeFile}
			const rel = fileUri.fsPath.startsWith(workspaceRoot)
				? fileUri.fsPath.slice(workspaceRoot.length).replace(/^[/\\]/, '')
				: fileUri.fsPath;
			result = result.replace(/\$\{relativeFile\}/g, rel);
		}

		// ${env:VAR} \u2014 resolved from process.env if available
		result = result.replace(/\$\{env:([^}]+)\}/g, (_match, varName) => {
			// Best-effort: process.env is available in Electron renderer with nodeIntegration
			try {
				return (globalThis as any).process?.env?.[varName] ?? '';
			} catch {
				return '';
			}
		});

		return result;
	}
}


// \u2500\u2500\u2500 Output Routing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _parseOutput(
	stdout: string,
	check: IExternalCheck,
	rule: IGRCRule,
	workspaceRoot: string,
	timestamp: number,
	fileUri?: URI
): Map<string, ICheckResult[]> {
	const fmt = check.parseOutput;

	switch (fmt) {
		case 'sarif':
			return SarifParser.parse(stdout, rule, workspaceRoot, timestamp);

		case 'polyspace-csv':
		case 'polyspace-xml':
			return PolyspaceParser.parse(stdout, fmt, rule, workspaceRoot, timestamp);

		case 'matlab-mlint':
			if (!fileUri) return new Map();
			return MatlabMlintParser.parse(stdout, fileUri, rule, timestamp);

		case 'eslint-json':
			return EslintJsonParser.parse(stdout, rule, timestamp);

		case 'checkstyle-xml':
			return CheckstyleXmlParser.parse(stdout, rule, timestamp);

		case 'json':
			return _parseGenericJson(stdout, check, rule, fileUri, timestamp);

		case 'line-per-violation':
			return _parseLinePerViolation(stdout, rule, fileUri, timestamp);

		default:
			console.warn(`[ExternalToolService] Unknown output format: ${fmt}`);
			return new Map();
	}
}

function _parseGenericJson(
	json: string,
	check: IExternalCheck,
	rule: IGRCRule,
	fileUri: URI | undefined,
	timestamp: number
): Map<string, ICheckResult[]> {
	const out = new Map<string, ICheckResult[]>();
	if (!fileUri) return out;

	try {
		const data = JSON.parse(json);
		const items: any[] = Array.isArray(data) ? data : _findFirstArray(data);
		const results: ICheckResult[] = [];

		for (const item of items) {
			results.push({
				ruleId: rule.id,
				domain: rule.domain,
				severity: item.severity ?? rule.severity,
				message: `[${rule.id}] ${item.message ?? rule.message}`,
				fileUri,
				line: Math.max(1, item.line ?? item.startLine ?? 1),
				column: Math.max(1, item.column ?? item.startColumn ?? 1),
				endLine: Math.max(1, item.endLine ?? item.line ?? 1),
				endColumn: Math.max(1, item.endColumn ?? (item.column ?? 0) + 1),
				fix: rule.fix,
				timestamp,
				frameworkId: rule.frameworkId,
				references: rule.references,
				blockingBehavior: rule.blockingBehavior,
			});
		}

		if (results.length > 0) {
			out.set(fileUri.toString(), results);
		}
	} catch (e) {
		console.error('[ExternalToolService] Failed to parse JSON output:', e);
	}

	return out;
}

function _parseLinePerViolation(
	output: string,
	rule: IGRCRule,
	fileUri: URI | undefined,
	timestamp: number
): Map<string, ICheckResult[]> {
	const out = new Map<string, ICheckResult[]>();
	if (!fileUri) return out;

	const lines = output.split('\n').filter(l => l.trim());
	if (lines.length === 0) return out;

	const results: ICheckResult[] = lines.map((line, idx) => ({
		ruleId: rule.id,
		domain: rule.domain,
		severity: rule.severity,
		message: `[${rule.id}] ${line.trim()}`,
		fileUri,
		line: idx + 1,
		column: 1,
		endLine: idx + 1,
		endColumn: 1,
		fix: rule.fix,
		timestamp,
		frameworkId: rule.frameworkId,
		references: rule.references,
		blockingBehavior: rule.blockingBehavior,
	}));

	out.set(fileUri.toString(), results);
	return out;
}

function _findFirstArray(data: any): any[] {
	for (const key of ['results', 'diagnostics', 'errors', 'warnings', 'issues', 'violations']) {
		if (Array.isArray(data[key])) return data[key];
	}
	return [];
}

function _countResults(map: Map<string, ICheckResult[]>): number {
	let n = 0;
	for (const v of map.values()) n += v.length;
	return n;
}

function _sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}


// \u2500\u2500\u2500 Registration \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

registerSingleton(IExternalToolService, ExternalToolServiceImpl, InstantiationType.Delayed);
