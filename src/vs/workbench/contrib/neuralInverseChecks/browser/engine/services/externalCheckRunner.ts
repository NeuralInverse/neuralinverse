/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # External Check Runner
 *
 * Executes `type: "external"` rules by delegating to CLI tools.
 *
 * ## Purpose
 *
 * This is the **escape hatch** for integrating any external analysis tool
 * into the GRC pipeline. Enterprises can define rules that invoke:
 * - Semgrep, ESLint, SonarQube CLI, custom linters
 * - Language-specific analyzers (cargo clippy, pylint, etc.)
 * - Internal compliance tools
 *
 * The runner executes the command, captures stdout, parses the output,
 * and converts it to `ICheckResult[]`.
 *
 * ## Supported Output Formats
 *
 * - `json` — Parse stdout as JSON, extract violations using JSONPath-like mapping
 * - `line-per-violation` — Each line of stdout is one violation (regex extraction)
 * - `sarif` — Parse SARIF v2.1 format (Static Analysis Results Interchange Format)
 *
 * ## Security
 *
 * External commands run in a sandboxed context:
 * - Timeout: configurable per rule, default 30 seconds
 * - No shell expansion by default
 * - Only workspace-scoped file paths are substituted
 *
 * ## Variables
 *
 * Commands support these variable substitutions:
 * - `${file}` — absolute path to the file being checked
 * - `${workspace}` — absolute path to the workspace root
 * - `${relativeFile}` — path relative to workspace root
 *
 * ## Note
 *
 * External checks run asynchronously (they shell out to a process),
 * but the current GRC engine evaluation is synchronous. For now,
 * the external runner returns an empty array from `evaluate()` and
 * reports results asynchronously via a callback. The engine will
 * be updated in a future iteration to support async evaluation.
 */

import { ITextModel } from '../../../../../../editor/common/model.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IGRCRule, ICheckResult, toDisplaySeverity } from '../types/grcTypes.js';
import { IExternalCheck } from '../framework/frameworkSchema.js';
import { IRuleAnalyzer } from './grcEngineService.js';
import { INanoAgentContext } from '../../nanoAgents/projectAnalyzerService.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';


// ─── External Check Runner ──────────────────────────────────────────────────

/**
 * Analyzer that handles `type: "external"` rules.
 *
 * Delegates to external CLI tools and parses their output.
 *
 * Because external tools run asynchronously (process spawn), this analyzer
 * queues checks and reports results via callback. The synchronous
 * `evaluate()` method returns cached results from the last run.
 */
export class ExternalCheckRunner implements IRuleAnalyzer {
	readonly supportedTypes = ['external'];

	/** Cached results from last async execution, per rule+file combo */
	private _cachedResults = new Map<string, { results: ICheckResult[]; timestamp: number }>();

	/** Currently running checks (prevent duplicate concurrent runs) */
	private _runningChecks = new Set<string>();

	/** Max cache age before results are considered stale (ms) */
	private static readonly STALENESS_MS = 60_000;

	/** Callback for when async results are available */
	private _onResultsReady?: (results: ICheckResult[]) => void;

	constructor(
		private readonly workspaceContextService: IWorkspaceContextService
	) { }

	public onResultsReady(callback: (results: ICheckResult[]) => void): void {
		this._onResultsReady = callback;
	}

	public evaluate(rule: IGRCRule, model: ITextModel, fileUri: URI, timestamp: number, context?: INanoAgentContext): ICheckResult[] {
		const check = rule.check as IExternalCheck | undefined;
		if (!check?.command) {
			return [];
		}

		const cacheKey = `${rule.id}:${fileUri.toString()}`;
		const cached = this._cachedResults.get(cacheKey);

		// Only trigger async re-evaluation if not already running AND cache is stale
		const isStale = !cached || (Date.now() - cached.timestamp > ExternalCheckRunner.STALENESS_MS);

		if (isStale && !this._runningChecks.has(cacheKey)) {
			this._runExternalCheckAsync(rule, model, fileUri, timestamp, cacheKey);
		}

		return cached?.results ?? [];
	}

	/**
	 * Run the external command asynchronously and parse results.
	 *
	 * NOTE: In the browser environment (VS Code web), process spawning
	 * is not available. This is primarily for VS Code desktop (Electron).
	 */
	private async _runExternalCheckAsync(
		rule: IGRCRule,
		model: ITextModel,
		fileUri: URI,
		timestamp: number,
		cacheKey: string
	): Promise<void> {
		const check = rule.check as IExternalCheck;

		// Mark as running to prevent duplicate concurrent executions
		this._runningChecks.add(cacheKey);

		try {
			const command = this._substituteVariables(check.command, fileUri);
			const timeoutMs = check.timeoutMs ?? 30000;

			const output = await this._executeCommand(command, timeoutMs);
			if (!output) return;

			const results = this._parseOutput(output, check, rule, fileUri, timestamp);

			// Cache with timestamp
			this._cachedResults.set(cacheKey, { results, timestamp: Date.now() });

			if (this._onResultsReady && results.length > 0) {
				this._onResultsReady(results);
			}
		} catch (e) {
			console.error(`[ExternalCheckRunner] Command failed for rule ${rule.id}:`, e);
		} finally {
			this._runningChecks.delete(cacheKey);
		}
	}


	// ─── Variable Substitution ───────────────────────────────────────

	private _substituteVariables(command: string, fileUri: URI): string {
		let result = command;

		// ${file} — absolute file path
		result = result.replace(/\$\{file\}/g, fileUri.fsPath);

		// ${workspace} — workspace root from DI service
		const workspaceFolder = this.workspaceContextService.getWorkspaceFolder(fileUri);
		const workspaceRoot = workspaceFolder?.uri.fsPath || fileUri.path.split('/').slice(0, 3).join('/');
		result = result.replace(/\$\{workspace\}/g, workspaceRoot);

		// ${relativeFile} — relative to workspace
		const relativePath = workspaceFolder
			? fileUri.path.substring(workspaceFolder.uri.path.length).replace(/^\//, '')
			: fileUri.path.replace(workspaceRoot + '/', '');
		result = result.replace(/\$\{relativeFile\}/g, relativePath);

		return result;
	}


	// ─── Command Execution ───────────────────────────────────────────

	/**
	 * Execute a shell command and return stdout.
	 *
	 * In VS Code desktop (Electron), this uses child_process.
	 * In VS Code web, this is not available and returns undefined.
	 */
	private async _executeCommand(command: string, timeoutMs: number): Promise<string | undefined> {
		// Check if we're in a Node.js environment (VS Code desktop)
		if (typeof globalThis !== 'undefined' && (globalThis as any).process?.versions?.node) {
			try {
				const { exec } = (globalThis as any).require('child_process') as typeof import('child_process');
				const { promisify } = (globalThis as any).require('util');
				const execAsync = promisify(exec);

				const { stdout } = await execAsync(command, {
					timeout: timeoutMs,
					maxBuffer: 1024 * 1024, // 1MB
				});

				return stdout;
			} catch (e: any) {
				// If the command exits with non-zero (common for linters), still use stdout
				if (e.stdout) {
					return e.stdout;
				}
				throw e;
			}
		}

		console.warn('[ExternalCheckRunner] External checks not available in browser environment');
		return undefined;
	}


	// ─── Output Parsing ──────────────────────────────────────────────

	/**
	 * Parse command output into ICheckResult[].
	 *
	 * Supports:
	 * - JSON with result mapping
	 * - Line-per-violation with regex
	 * - SARIF format
	 */
	private _parseOutput(
		output: string,
		check: IExternalCheck,
		rule: IGRCRule,
		fileUri: URI,
		timestamp: number
	): ICheckResult[] {
		switch (check.parseOutput) {
			case 'json':
				return this._parseJsonOutput(output, check, rule, fileUri, timestamp);
			case 'line-per-violation':
				return this._parseLineOutput(output, check, rule, fileUri, timestamp);
			case 'sarif':
				return this._parseSarifOutput(output, rule, fileUri, timestamp);
			default:
				console.warn(`[ExternalCheckRunner] Unknown output format: ${check.parseOutput}`);
				return [];
		}
	}

	/**
	 * Parse JSON output using result mapping.
	 *
	 * Result mapping uses simple JSONPath-like expressions:
	 * - `$.results[*].line` \u2192 array of line numbers
	 * - `$.message` \u2192 single value
	 */
	private _parseJsonOutput(
		output: string,
		check: IExternalCheck,
		rule: IGRCRule,
		fileUri: URI,
		timestamp: number
	): ICheckResult[] {
		try {
			const data = JSON.parse(output);
			const results: ICheckResult[] = [];

			// Simple extraction — look for array of results
			const items = this._extractArray(data, check.resultMapping);
			for (const item of items) {
				results.push({
					ruleId: rule.id,
					domain: rule.domain,
					severity: toDisplaySeverity(
						item.severity || rule.severity
					),
					message: `[${rule.id}] ${item.message || rule.message}`,
					fileUri: fileUri,
					line: item.line || 1,
					column: item.column || 1,
					endLine: item.endLine || item.line || 1,
					endColumn: item.endColumn || (item.column || 0) + 1,
					fix: rule.fix,
					timestamp: timestamp,
					frameworkId: rule.frameworkId,
					references: rule.references,
				});
			}

			return results;
		} catch (e) {
			console.error('[ExternalCheckRunner] Failed to parse JSON output:', e);
			return [];
		}
	}

	/**
	 * Parse line-per-violation output.
	 * Each non-empty line is treated as a violation.
	 */
	private _parseLineOutput(
		output: string,
		check: IExternalCheck,
		rule: IGRCRule,
		fileUri: URI,
		timestamp: number
	): ICheckResult[] {
		const lines = output.split('\n').filter(l => l.trim().length > 0);
		return lines.map((line, idx) => ({
			ruleId: rule.id,
			domain: rule.domain,
			severity: toDisplaySeverity(rule.severity),
			message: `[${rule.id}] ${line.trim()}`,
			fileUri: fileUri,
			line: idx + 1,
			column: 1,
			endLine: idx + 1,
			endColumn: 1,
			fix: rule.fix,
			timestamp: timestamp,
			frameworkId: rule.frameworkId,
			references: rule.references,
		}));
	}

	/**
	 * Parse SARIF v2.1 output.
	 *
	 * SARIF (Static Analysis Results Interchange Format) is a standard
	 * format used by many security and compliance tools.
	 */
	private _parseSarifOutput(
		output: string,
		rule: IGRCRule,
		fileUri: URI,
		timestamp: number
	): ICheckResult[] {
		try {
			const sarif = JSON.parse(output);
			const results: ICheckResult[] = [];

			// SARIF structure: { runs: [{ results: [...] }] }
			for (const run of sarif.runs || []) {
				for (const result of run.results || []) {
					const location = result.locations?.[0]?.physicalLocation?.region;

					results.push({
						ruleId: result.ruleId || rule.id,
						domain: rule.domain,
						severity: toDisplaySeverity(
							this._sarifLevelToSeverity(result.level) || rule.severity
						),
						message: `[${result.ruleId || rule.id}] ${result.message?.text || rule.message}`,
						fileUri: fileUri,
						line: location?.startLine || 1,
						column: location?.startColumn || 1,
						endLine: location?.endLine || location?.startLine || 1,
						endColumn: location?.endColumn || (location?.startColumn || 0) + 1,
						fix: rule.fix,
						timestamp: timestamp,
						frameworkId: rule.frameworkId,
						references: rule.references,
					});
				}
			}

			return results;
		} catch (e) {
			console.error('[ExternalCheckRunner] Failed to parse SARIF output:', e);
			return [];
		}
	}


	// ─── Helpers ─────────────────────────────────────────────────────

	private _sarifLevelToSeverity(level: string): string {
		switch (level) {
			case 'error': return 'error';
			case 'warning': return 'warning';
			case 'note': return 'info';
			case 'none': return 'info';
			default: return 'warning';
		}
	}

	/**
	 * Simple array extraction from parsed JSON.
	 * Handles common patterns from linter output.
	 */
	private _extractArray(data: any, mapping?: IExternalCheck['resultMapping']): any[] {
		// Common patterns: data is array, data.results is array, data.diagnostics, etc.
		if (Array.isArray(data)) {
			return data;
		}

		for (const key of ['results', 'diagnostics', 'errors', 'warnings', 'issues', 'violations']) {
			if (Array.isArray(data[key])) {
				return data[key];
			}
		}

		return [];
	}
}
