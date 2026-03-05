/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # GRC Engine Service
 *
 * The core evaluation engine of the Neural Inverse GRC platform.
 *
 * ## How Evaluation Works
 *
 * When a document is evaluated (`evaluateDocument()`), the engine:
 *
 * 1. Gets all enabled rules from the config loader (built-in + framework + user)
 * 2. Routes each rule to the appropriate analyzer based on `rule.type`:
 *    - `regex` → regex pattern matching (inline, fast)
 *    - `file-level` → file-level checks (line count, headers)
 *    - `ast` → AST analyzer (when available)
 *    - `dataflow` → Data flow analyzer (when available)
 *    - `import-graph` → Import graph analyzer (workspace-level)
 *    - `external` → External tool runner (CLI delegation)
 * 3. Collects all violations as `ICheckResult[]`
 * 4. Caches results per file URI
 * 5. Fires `onDidCheckComplete` event for diagnostics and UI consumers
 *
 * ## Analyzer Registration
 *
 * The engine uses a pluggable analyzer architecture. Analyzers register
 * themselves via `registerAnalyzer()`. If an analyzer is not registered
 * for a rule type, the engine logs a warning and skips those rules.
 *
 * This allows Phase 2 analyzers (AST, dataflow, etc.) to be built
 * independently and plugged into the engine without modifying this file.
 *
 * ## Domain Discovery
 *
 * Domains are NOT hardcoded. The engine discovers all unique domains
 * from loaded rules (built-in, framework, and user-defined). This
 * supports the framework-agnostic architecture where enterprises
 * define their own categories.
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { URI } from '../../../../../../base/common/uri.js';
import { GRCDomain, IGRCRule, ICheckResult, IDomainSummary, GRC_BUILTIN_DOMAIN_LIST, toDisplaySeverity } from '../types/grcTypes.js';
import { GRCConfigLoader } from '../config/grcConfigLoader.js';
import { IFrameworkRegistry } from '../framework/frameworkRegistry.js';
import { IRegexCheck, IFileLevelCheck, IFrameworkMetadata, IFrameworkValidationResult } from '../framework/frameworkSchema.js';
import { IProjectAnalyzerService, INanoAgentContext } from '../../nanoAgents/projectAnalyzerService.js';
import { IFrameworkIntelligenceService } from './frameworkIntelligenceService.js';
import { ITextFileService } from '../../../../../services/textfile/common/textfiles.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';

export const IGRCEngineService = createDecorator<IGRCEngineService>('neuralInverseGRCEngineService');


// ─── Analyzer Interface ──────────────────────────────────────────────────────

/**
 * Interface for pluggable rule analyzers.
 *
 * Each analyzer handles one or more rule types. The engine routes
 * rules to analyzers based on `rule.type`.
 *
 * ## Implementing a New Analyzer
 *
 * ```typescript
 * class MyAstAnalyzer implements IRuleAnalyzer {
 *   readonly supportedTypes = ['ast'];
 *
 *   evaluate(rule: IGRCRule, model: ITextModel, fileUri: URI): ICheckResult[] {
 *     // Parse AST, match against rule.check, return violations
 *   }
 * }
 *
 * // Register with the engine:
 * engineService.registerAnalyzer(myAstAnalyzer);
 * ```
 */
export interface IRuleAnalyzer {
	/** Which rule types this analyzer can handle */
	readonly supportedTypes: string[];

	/**
	 * Evaluate a single rule against an open text model.
	 * Returns an array of violations found.
	 *
	 * @param context Optional nano agent context (metrics, capabilities,
	 *   call hierarchy, symbols) for the file being evaluated.
	 */
	evaluate(rule: IGRCRule, model: ITextModel, fileUri: URI, timestamp: number, context?: INanoAgentContext): ICheckResult[];

	/**
	 * Optional: evaluate against raw file content without an open ITextModel.
	 * Implement this to support background workspace scanning for this analyzer.
	 *
	 * @param languageId VS Code language ID detected from the file extension.
	 */
	evaluateContent?(rule: IGRCRule, content: string, fileUri: URI, languageId: string, timestamp: number): ICheckResult[];
}


// ─── Language ID from Extension ──────────────────────────────────────────────

/** Maps common file extensions to VS Code language identifiers */
export const EXT_TO_LANGUAGE_ID: Record<string, string> = {
	ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
	py: 'python', java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
	cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php',
	swift: 'swift', kt: 'kotlin', scala: 'scala', sh: 'shellscript', bash: 'shellscript',
	sql: 'sql', yaml: 'yaml', yml: 'yaml', json: 'json', xml: 'xml',
	html: 'html', css: 'css', scss: 'scss', dockerfile: 'dockerfile',
	tf: 'terraform', hcl: 'hcl', r: 'r', m: 'objective-c',
};


// ─── Service Interface ───────────────────────────────────────────────────────

export interface IGRCEngineService {
	readonly _serviceBrand: undefined;

	/** Fires when a document has been evaluated and new results are available */
	readonly onDidCheckComplete: Event<ICheckResult[]>;

	/** Fires when rules are reloaded from config or frameworks */
	readonly onDidRulesChange: Event<void>;

	/** Evaluate all enabled rules against a text model */
	evaluateDocument(model: ITextModel): ICheckResult[];

	/** Get cached results filtered by domain */
	getResultsForDomain(domain: GRCDomain): ICheckResult[];

	/** Get all cached results across all domains */
	getAllResults(): ICheckResult[];

	/** Get summary counts per domain (dynamic, not hardcoded) */
	getDomainSummary(): IDomainSummary[];

	/**
	 * Get all unique domains from loaded rules.
	 * Includes built-in + framework + user-defined domains.
	 */
	getActiveDomains(): GRCDomain[];

	/**
	 * Get metadata for all currently loaded frameworks.
	 */
	getActiveFrameworks(): IFrameworkMetadata[];

	/** Get all loaded rules */
	getRules(): IGRCRule[];

	/**
	 * Get violations that block commits.
	 * These are violations from rules with blockingBehavior.blocksCommit === true.
	 */
	getBlockingViolations(): ICheckResult[];

	/** Force reload rules from disk */
	reloadRules(): Promise<void>;

	/** Clear cached results for a file */
	clearResultsForFile(fileUri: URI): void;

	/**
	 * Register a pluggable analyzer for specific rule types.
	 * Used by Phase 2 analyzers (AST, dataflow, etc.) to plug into the engine.
	 */
	registerAnalyzer(analyzer: IRuleAnalyzer): void;

	/** Save (add or update) a rule via the config loader */
	saveRule(rule: IGRCRule): Promise<void>;

	/** Toggle a rule on/off */
	toggleRule(ruleId: string, enabled: boolean): Promise<void>;

	/** Delete a user-defined rule */
	deleteRule(ruleId: string): Promise<void>;

	/**
	 * Evaluate rules against raw file content (no ITextModel needed).
	 * Used by the workspace scanner to check files that aren't open.
	 */
	evaluateFileContent(fileUri: URI, content: string): ICheckResult[];

	/**
	 * Restore persisted AI violations for a file into the results cache.
	 * Called on startup after workspace scan to replay saved AI findings
	 * without re-running LLM analysis.
	 */
	restoreAIViolations(fileUri: URI, rawViolations: any[]): void;

	/**
	 * Import a framework from a JSON string.
	 * Delegates to IFrameworkRegistry.importFramework().
	 */
	importFramework(json: string): Promise<IFrameworkValidationResult>;

	/**
	 * Set breaking change violations for a file, replacing any previous ones.
	 *
	 * Called by BreakingChangeDetector during the save participant phase,
	 * BEFORE GRCGatekeeper runs, so the gatekeeper sees breaking changes
	 * and can block the save.
	 *
	 * Pass an empty array to clear breaking change violations for the file.
	 */
	setBreakingChangeViolations(fileUri: URI, violations: ICheckResult[]): void;

	/** Get the current list of ignore glob patterns (persisted per workspace) */
	getIgnorePatterns(): string[];

	/** Add a glob pattern to the ignore list (e.g. "node_modules/**", "src/tests/**") */
	addIgnorePattern(pattern: string): void;

	/** Remove a glob pattern from the ignore list */
	removeIgnorePattern(pattern: string): void;

	/**
	 * Scan all workspace files with static rules and cache results.
	 * Triggers onDidCheckComplete when done.
	 */
	scanWorkspace(): Promise<void>;
}


// ─── Implementation ──────────────────────────────────────────────────────────

export class GRCEngineService extends Disposable implements IGRCEngineService {
	declare readonly _serviceBrand: undefined;

	private readonly _configLoader: GRCConfigLoader;

	/** Cached check results per file URI string */
	private readonly _resultsByFile = new Map<string, ICheckResult[]>();

	/** Compiled regex cache per rule ID */
	private readonly _regexCache = new Map<string, RegExp>();

	/** Registered analyzers by rule type */
	private readonly _analyzers = new Map<string, IRuleAnalyzer>();

	/** Glob patterns for files/folders to exclude from all results */
	private _ignorePatterns: string[] = [];
	private static readonly _IGNORE_KEY = 'grc.ignorePatterns.v1';

	private readonly _onDidCheckComplete = this._register(new Emitter<ICheckResult[]>());
	public readonly onDidCheckComplete: Event<ICheckResult[]> = this._onDidCheckComplete.event;

	private readonly _onDidRulesChange = this._register(new Emitter<void>());
	public readonly onDidRulesChange: Event<void> = this._onDidRulesChange.event;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFrameworkRegistry private readonly frameworkRegistry: IFrameworkRegistry,
		@IProjectAnalyzerService private readonly projectAnalyzerService: IProjectAnalyzerService,
		@IFrameworkIntelligenceService private readonly intelligenceService: IFrameworkIntelligenceService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();

		// Load persisted ignore patterns
		const stored = this._storageService.get(GRCEngineService._IGNORE_KEY, StorageScope.WORKSPACE);
		if (stored) {
			try { this._ignorePatterns = JSON.parse(stored); } catch { /* ignore */ }
		}

		this._configLoader = this._register(
			new GRCConfigLoader(this._fileService, this._workspaceContextService, frameworkRegistry)
		);

		// When config/framework changes, clear caches and fire event
		this._register(this._configLoader.onDidChange(() => {
			this._regexCache.clear();
			this._onDidRulesChange.fire();
			console.log('[GRCEngine] Rules reloaded:', this._configLoader.getRules().length, 'total rules');
		}));

		// When nano agent analysis completes, re-fire rules change
		// so diagnostics re-evaluate with updated context
		this._register(this.projectAnalyzerService.onDidAnalysisComplete(() => {
			this._onDidRulesChange.fire();
		}));

		// AI analysis triggers on file SAVE — not on every keystroke.
		// The intelligence service deduplicates via content hash, so saving
		// an unchanged file costs zero LLM calls.
		this._register(this.textFileService.files.onDidSave(e => {
			const model = e.model.textEditorModel;
			if (!model) return;
			const fileUri = e.model.resource;
			if (fileUri.path.includes('/.inverse/')) return;
			if (!this.intelligenceService.isAvailable) return;

			const cachedResults = this._resultsByFile.get(fileUri.toString()) || [];
			const allRules = this._configLoader.getRules();
			const nanoContext = this.projectAnalyzerService.getContextForFile(fileUri);

			this.intelligenceService.analyzeFile(
				fileUri,
				model.getValue(),
				cachedResults,
				allRules,
				nanoContext
			);
		}));

		// When intelligence results arrive, enrich existing violations and add new ones
		this._register(this.intelligenceService.onDidIntelligenceResultsReady((result) => {
			const fileKey = result.fileUri.toString();
			const existing = this._resultsByFile.get(fileKey) || [];
			let changed = false;

			// Apply AI enrichments to existing pattern violations
			if (result.enrichments.size > 0) {
				for (const r of existing) {
					const key = `${r.ruleId}:${r.line}`;
					const enrichment = result.enrichments.get(key);
					if (enrichment) {
						r.aiExplanation = enrichment.aiExplanation;
						r.aiConfidence = enrichment.aiConfidence;
						changed = true;
					}
				}
			}

			// Add intelligence-discovered violations (deduplicated)
			const existingKeys = new Set(existing.map(r => `${r.ruleId}:${r.line}`));
			const newViolations = result.additionalViolations.filter(
				v => !existingKeys.has(`${v.ruleId}:${v.line}`)
			);
			if (newViolations.length > 0) {
				existing.push(...newViolations);
				changed = true;
			}

			if (changed) {
				this._resultsByFile.set(fileKey, existing);
				this._onDidCheckComplete.fire(existing);
				const enrichCount = result.enrichments.size;
				const newCount = newViolations.length;
				console.log(`[GRCEngine] Intelligence: ${enrichCount} enriched, ${newCount} new violations for ${result.fileUri.path.split('/').pop()}`);
			}
		}));
	}


	// ─── Analyzer Registration ───────────────────────────────────────

	/**
	 * Register a pluggable analyzer for specific rule types.
	 *
	 * Example:
	 * ```typescript
	 * engineService.registerAnalyzer(new AstAnalyzer());
	 * ```
	 *
	 * If an analyzer is already registered for a type, it is replaced.
	 */
	public registerAnalyzer(analyzer: IRuleAnalyzer): void {
		for (const type of analyzer.supportedTypes) {
			this._analyzers.set(type, analyzer);
			console.log(`[GRCEngine] Registered analyzer for type: ${type}`);
		}
	}


	// ─── Evaluation ──────────────────────────────────────────────────

	/**
	 * Evaluate all enabled rules against a text model.
	 *
	 * Routes each rule to the appropriate analyzer based on `rule.type`:
	 * - `regex` → built-in regex matching (handled here)
	 * - `file-level` → built-in file-level checks (handled here)
	 * - Other types → delegated to registered analyzers
	 *
	 * Results are cached per file URI and an event is fired.
	 */
	public evaluateDocument(model: ITextModel): ICheckResult[] {
		const fileUri = model.uri;

		// ── Guard: never run GRC checks on files inside .inverse/ ──
		if (fileUri.path.includes('/.inverse/') || fileUri.path.endsWith('/.inverse')) {
			return [];
		}

		// ── Get nano agent context for this file ──
		const nanoContext = this.projectAnalyzerService.getContextForFile(fileUri);

		const rules = this._configLoader.getRules().filter(r => r.enabled);
		const results: ICheckResult[] = [];
		const lines = model.getLinesContent();
		const now = Date.now();

		for (const rule of rules) {
			const ruleType = rule.type ?? 'regex';

			switch (ruleType) {
				case 'regex':
					results.push(...this._evaluateRegexRule(rule, lines, fileUri, now));
					break;

				case 'file-level':
					results.push(...this._evaluateFileLevelRule(rule, lines, fileUri, now));
					break;

				default: {
					// Delegate to registered analyzer with nano agent context
					const analyzer = this._analyzers.get(ruleType);
					if (analyzer) {
						try {
							const analyzerResults = analyzer.evaluate(rule, model, fileUri, now, nanoContext);
							results.push(...analyzerResults);
						} catch (e) {
							console.error(`[GRCEngine] Analyzer error for rule ${rule.id} (type: ${ruleType}):`, e);
						}
					}
					break;
				}
			}
		}

		// Cache results — preserve any previous AI-found violations and enrichments
		const existingResults = this._resultsByFile.get(fileUri.toString()) || [];

		// 1. Restore AI enrichments to the newly computed static results
		for (const newR of results) {
			const existingEnriched = existingResults.find(r => r.ruleId === newR.ruleId && r.line === newR.line && r.aiExplanation);
			if (existingEnriched) {
				newR.aiExplanation = existingEnriched.aiExplanation;
				newR.aiConfidence = existingEnriched.aiConfidence;
			}
		}

		// 2. Keep purely AI-discovered violations that aren't in the static results at all
		const aiViolations = existingResults.filter(r => r.aiExplanation && !results.some(
			newR => newR.ruleId === r.ruleId && newR.line === r.line
		));

		// 3. Keep breaking-change violations (managed by BreakingChangeDetector)
		const breakingViolations = existingResults.filter(r => r.isBreakingChange);

		const mergedResults = [...results, ...aiViolations, ...breakingViolations];
		this._resultsByFile.set(fileUri.toString(), mergedResults);

		// Fire event for pattern results immediately.
		// AI analysis is triggered separately on file save (see constructor).
		this._onDidCheckComplete.fire(mergedResults);

		return mergedResults;
	}

	/**
	 * Evaluate rules against raw file content (no ITextModel needed).
	 *
	 * Supports regex and file-level checks only (AST/dataflow analyzers
	 * require an ITextModel and are skipped for background scanning).
	 * Used by the workspace scanner to check files that aren't open.
	 */
	public evaluateFileContent(fileUri: URI, content: string): ICheckResult[] {
		// Skip .inverse files
		if (fileUri.path.includes('/.inverse/') || fileUri.path.endsWith('/.inverse')) {
			return [];
		}

		const rules = this._configLoader.getRules().filter(r => r.enabled);
		const results: ICheckResult[] = [];
		const lines = content.split('\n');
		const now = Date.now();

		for (const rule of rules) {
			const ruleType = rule.type ?? 'regex';

			switch (ruleType) {
				case 'regex':
					results.push(...this._evaluateRegexRule(rule, lines, fileUri, now));
					break;

				case 'file-level':
					results.push(...this._evaluateFileLevelRule(rule, lines, fileUri, now));
					break;

				// Delegate to analyzer.evaluateContent() if supported (e.g. UniversalAnalyzer)
				default: {
					const analyzer = this._analyzers.get(ruleType);
					if (analyzer?.evaluateContent) {
						const ext = fileUri.path.split('.').pop()?.toLowerCase() ?? '';
						const langId = EXT_TO_LANGUAGE_ID[ext] ?? ext;
						try {
							results.push(...analyzer.evaluateContent(rule, content, fileUri, langId, now));
						} catch (e) {
							console.error(`[GRCEngine] evaluateContent error for rule ${rule.id}:`, e);
						}
					}
					break;
				}
			}
		}

		// Cache results — preserve any previous AI-found violations and enrichments
		const existingResults = this._resultsByFile.get(fileUri.toString()) || [];

		for (const newR of results) {
			const existingEnriched = existingResults.find(r => r.ruleId === newR.ruleId && r.line === newR.line && r.aiExplanation);
			if (existingEnriched) {
				newR.aiExplanation = existingEnriched.aiExplanation;
				newR.aiConfidence = existingEnriched.aiConfidence;
			}
		}

		const aiViolations = existingResults.filter(r => r.aiExplanation && !results.some(
			newR => newR.ruleId === r.ruleId && newR.line === r.line
		));

		const breakingViolations = existingResults.filter(r => r.isBreakingChange);

		const mergedResults = [...results, ...aiViolations, ...breakingViolations];
		this._resultsByFile.set(fileUri.toString(), mergedResults);

		// Fire event
		this._onDidCheckComplete.fire(mergedResults);

		return mergedResults;
	}


	/**
	 * Restore persisted AI violations into the results cache.
	 *
	 * Merges raw violations (loaded from .inverse/audit/) into _resultsByFile
	 * without overwriting pattern-based results. Fires onDidCheckComplete so
	 * diagnostics and the Checks panel update immediately on startup.
	 */
	public restoreAIViolations(fileUri: URI, rawViolations: any[]): void {
		if (rawViolations.length === 0) return;

		const fileKey = fileUri.toString();
		const existing = this._resultsByFile.get(fileKey) || [];

		// Revive each violation: fileUri comes back from JSON as a plain object
		const violations: ICheckResult[] = rawViolations.map(v => ({
			...v,
			fileUri: fileUri, // Use the known URI directly — avoids URI.revive complexity
		}));

		// Deduplicate against pattern results already in cache
		const existingKeys = new Set(existing.map(r => `${r.ruleId}:${r.line}`));
		const toAdd = violations.filter(v => !existingKeys.has(`${v.ruleId}:${v.line}`));

		if (toAdd.length === 0) return;

		const merged = [...existing, ...toAdd];
		this._resultsByFile.set(fileKey, merged);
		this._onDidCheckComplete.fire(merged);

		console.log(`[GRCEngine] Restored ${toAdd.length} AI violations for ${fileUri.path.split('/').pop()}`);
	}


	/**
	 * Set (replace) breaking change violations for a file.
	 *
	 * Replaces all previous breaking-change violations for this file,
	 * then re-merges with existing pattern + AI results and fires
	 * onDidCheckComplete so GRCGatekeeper and diagnostics update.
	 */
	public setBreakingChangeViolations(fileUri: URI, violations: ICheckResult[]): void {
		const fileKey = fileUri.toString();
		const existing = this._resultsByFile.get(fileKey) || [];

		// Remove old breaking-change violations, keep pattern + AI results
		const withoutBreaking = existing.filter(r => !r.isBreakingChange);

		// Tag new violations as breaking changes
		const tagged: ICheckResult[] = violations.map(v => ({ ...v, isBreakingChange: true as const }));

		const merged = [...withoutBreaking, ...tagged];
		this._resultsByFile.set(fileKey, merged);
		this._onDidCheckComplete.fire(merged);

		if (violations.length > 0) {
			console.log(`[GRCEngine] ${violations.length} breaking change violation(s) detected in ${fileUri.path.split('/').pop()}`);
		}
	}


	// ─── Regex Evaluation (built-in) ─────────────────────────────────

	/**
	 * Evaluate a regex-type rule against all lines of code.
	 *
	 * Supports two patterns:
	 * 1. Rule has `pattern` field directly (backward compat / built-in rules)
	 * 2. Rule has `check.pattern` (framework-imported rules)
	 */
	private _evaluateRegexRule(rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number): ICheckResult[] {
		const results: ICheckResult[] = [];

		const check = rule.check as IRegexCheck | undefined;
		const regex = this._getRegex(rule);
		if (!regex) {
			return results;
		}

		const excludeContexts = check?.excludeContexts;

		// ── Multi-line mode: run against entire file content ──
		if (check?.multiline) {
			const fullContent = lines.join('\n');
			const cleanedContent = excludeContexts
				? this._stripContexts(fullContent, excludeContexts)
				: fullContent;

			regex.lastIndex = 0;
			let match: RegExpExecArray | null;
			const globalRegex = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');

			while ((match = globalRegex.exec(cleanedContent)) !== null) {
				const { line, col } = this._posToLineCol(fullContent, match.index);
				const endPos = this._posToLineCol(fullContent, match.index + match[0].length);

				results.push({
					ruleId: rule.id,
					domain: rule.domain,
					severity: toDisplaySeverity(rule.severity),
					message: `[${rule.id}] ${rule.message}`,
					fileUri: fileUri,
					line,
					column: col,
					endLine: endPos.line,
					endColumn: endPos.col,
					codeSnippet: match[0].substring(0, 100),
					fix: rule.fix,
					timestamp: timestamp,
					frameworkId: rule.frameworkId,
					references: rule.references,
					blockingBehavior: rule.blockingBehavior,
				});

				// Prevent infinite loops on zero-length matches
				if (match[0].length === 0) globalRegex.lastIndex++;
			}

			return results;
		}

		// ── Line-by-line mode (default) ──
		for (let i = 0; i < lines.length; i++) {
			let line = lines[i];

			// Strip contexts if configured
			if (excludeContexts) {
				line = this._stripContextsLine(line, excludeContexts);
			} else {
				// Default: skip obvious comment-only lines
				const trimmed = line.trim();
				if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
					continue;
				}
			}

			regex.lastIndex = 0;
			const match = regex.exec(line);
			if (match) {
				results.push({
					ruleId: rule.id,
					domain: rule.domain,
					severity: toDisplaySeverity(rule.severity),
					message: `[${rule.id}] ${rule.message}`,
					fileUri: fileUri,
					line: i + 1,
					column: match.index + 1,
					endLine: i + 1,
					endColumn: match.index + match[0].length + 1,
					codeSnippet: match[0],
					fix: rule.fix,
					timestamp: timestamp,
					frameworkId: rule.frameworkId,
					references: rule.references,
					blockingBehavior: rule.blockingBehavior,
				});
			}
		}

		return results;
	}


	// ─── Context Stripping Helpers ────────────────────────────────────

	/**
	 * Convert a character position in full content to line:col (1-based).
	 */
	private _posToLineCol(content: string, pos: number): { line: number; col: number } {
		let line = 1;
		let col = 1;
		for (let i = 0; i < pos && i < content.length; i++) {
			if (content[i] === '\n') {
				line++;
				col = 1;
			} else {
				col++;
			}
		}
		return { line, col };
	}

	/**
	 * Strip specified contexts from a full file string.
	 * Replaces matched regions with spaces (preserving positions).
	 */
	private _stripContexts(content: string, contexts: ('comment' | 'string' | 'template-literal')[]): string {
		const chars = content.split('');
		const len = chars.length;
		let i = 0;

		while (i < len) {
			// Single-line comment
			if (contexts.includes('comment') && chars[i] === '/' && chars[i + 1] === '/') {
				while (i < len && chars[i] !== '\n') { chars[i] = ' '; i++; }
				continue;
			}

			// Block comment
			if (contexts.includes('comment') && chars[i] === '/' && chars[i + 1] === '*') {
				chars[i] = ' '; chars[i + 1] = ' '; i += 2;
				while (i < len && !(chars[i] === '*' && chars[i + 1] === '/')) {
					if (chars[i] !== '\n') chars[i] = ' ';
					i++;
				}
				if (i < len) { chars[i] = ' '; chars[i + 1] = ' '; i += 2; }
				continue;
			}

			// String literals (single/double quote)
			if (contexts.includes('string') && (chars[i] === '"' || chars[i] === "'")) {
				const quote = chars[i];
				chars[i] = ' '; i++;
				while (i < len && chars[i] !== quote && chars[i] !== '\n') {
					if (chars[i] === '\\') { chars[i] = ' '; i++; } // skip escaped
					if (i < len) { chars[i] = ' '; i++; }
				}
				if (i < len) { chars[i] = ' '; i++; }
				continue;
			}

			// Template literals
			if (contexts.includes('template-literal') && chars[i] === '`') {
				chars[i] = ' '; i++;
				let depth = 0;
				while (i < len) {
					if (chars[i] === '\\') { chars[i] = ' '; i++; if (i < len) { chars[i] = ' '; i++; } continue; }
					if (chars[i] === '$' && chars[i + 1] === '{') { depth++; chars[i] = ' '; i++; chars[i] = ' '; i++; continue; }
					if (chars[i] === '}' && depth > 0) { depth--; chars[i] = ' '; i++; continue; }
					if (chars[i] === '`' && depth === 0) { chars[i] = ' '; i++; break; }
					if (chars[i] !== '\n') chars[i] = ' ';
					i++;
				}
				continue;
			}

			i++;
		}

		return chars.join('');
	}

	/**
	 * Strip contexts from a single line (simplified version).
	 */
	private _stripContextsLine(line: string, contexts: ('comment' | 'string' | 'template-literal')[]): string {
		let result = line;

		if (contexts.includes('comment')) {
			// Remove // comments (not inside strings — best effort)
			result = result.replace(/\/\/.*$/, '');
			// Remove inline /* ... */ comments
			result = result.replace(/\/\*.*?\*\//g, ' ');
		}

		if (contexts.includes('string')) {
			// Replace string contents (preserve quotes structure)
			result = result.replace(/"(?:[^"\\]|\\.)*"/g, '""');
			result = result.replace(/'(?:[^'\\]|\\.)*'/g, "''");
		}

		if (contexts.includes('template-literal')) {
			// Replace template literal contents (simplified single-line)
			result = result.replace(/`(?:[^`\\]|\\.)*`/g, '``');
		}

		return result;
	}


	// ─── File-Level Evaluation (built-in) ────────────────────────────

	/**
	 * Evaluate a file-level rule.
	 *
	 * Supports:
	 * - `max-lines`: file exceeds a line count threshold
	 * - `missing-header`: file doesn't start with expected pattern
	 * - `naming`: filename doesn't match expected pattern
	 *
	 * Also supports legacy rule IDs for backward compat (ARC-001).
	 */
	private _evaluateFileLevelRule(rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Determine what to check — use structured check if available, else legacy
		const check = rule.check as IFileLevelCheck | undefined;
		const detectType = check?.detect ?? (rule.id === 'ARC-001' ? 'max-lines' : undefined);

		if (!detectType) {
			return results;
		}

		switch (detectType) {
			case 'max-lines': {
				const threshold = check?.threshold ?? rule.threshold ?? 500;
				if (lines.length > threshold) {
					results.push({
						ruleId: rule.id,
						domain: rule.domain,
						severity: toDisplaySeverity(rule.severity),
						message: `[${rule.id}] ${rule.message} (${lines.length} lines, limit: ${threshold})`,
						fileUri: fileUri,
						line: 1,
						column: 1,
						endLine: 1,
						endColumn: 1,
						fix: rule.fix,
						timestamp: timestamp,
						frameworkId: rule.frameworkId,
						references: rule.references,
						blockingBehavior: rule.blockingBehavior,
					});
				}
				break;
			}

			case 'missing-header': {
				const headerPattern = check?.headerPattern;
				if (headerPattern && lines.length > 0) {
					// Check first 5 lines for the header pattern
					const headerText = lines.slice(0, 5).join('\n');
					const headerRegex = new RegExp(headerPattern);
					if (!headerRegex.test(headerText)) {
						results.push({
							ruleId: rule.id,
							domain: rule.domain,
							severity: toDisplaySeverity(rule.severity),
							message: `[${rule.id}] ${rule.message}`,
							fileUri: fileUri,
							line: 1,
							column: 1,
							endLine: 1,
							endColumn: 1,
							fix: rule.fix,
							timestamp: timestamp,
							frameworkId: rule.frameworkId,
							references: rule.references,
						});
					}
				}
				break;
			}

			case 'naming': {
				const namePattern = check?.namePattern;
				if (namePattern) {
					const fileName = fileUri.path.split('/').pop() ?? '';
					const nameRegex = new RegExp(namePattern);
					if (!nameRegex.test(fileName)) {
						results.push({
							ruleId: rule.id,
							domain: rule.domain,
							severity: toDisplaySeverity(rule.severity),
							message: `[${rule.id}] ${rule.message} (file: ${fileName})`,
							fileUri: fileUri,
							line: 1,
							column: 1,
							endLine: 1,
							endColumn: 1,
							fix: rule.fix,
							timestamp: timestamp,
							frameworkId: rule.frameworkId,
							references: rule.references,
						});
					}
				}
				break;
			}
		}

		return results;
	}


	// ─── Regex Cache ─────────────────────────────────────────────────

	/**
	 * Gets or compiles a regex for a rule.
	 *
	 * Supports:
	 * - `rule.pattern` (legacy/built-in rules)
	 * - `rule.check.pattern` (framework rules with type: "regex")
	 */
	private _getRegex(rule: IGRCRule): RegExp | null {
		// Determine pattern — prefer check.pattern, fall back to rule.pattern
		let pattern = rule.pattern;
		let flags = 'gi';

		if (rule.check && rule.check.type === 'regex') {
			const regexCheck = rule.check as IRegexCheck;
			pattern = regexCheck.pattern || pattern;
			if (regexCheck.flags) {
				flags = regexCheck.flags + (regexCheck.flags.includes('g') ? '' : 'g');
			}
		}

		if (!pattern) {
			return null;
		}

		const cacheKey = `${rule.id}:${pattern}:${flags}`;
		const cached = this._regexCache.get(cacheKey);
		if (cached) {
			return cached;
		}

		try {
			const regex = new RegExp(pattern, flags);
			this._regexCache.set(cacheKey, regex);
			return regex;
		} catch (e) {
			console.error(`[GRCEngine] Invalid regex for rule ${rule.id}:`, pattern, e);
			return null;
		}
	}


	// ─── Query Methods ───────────────────────────────────────────────

	/**
	 * Get cached results filtered by domain.
	 */
	public getResultsForDomain(domain: GRCDomain): ICheckResult[] {
		const allResults: ICheckResult[] = [];
		for (const [, results] of this._resultsByFile) {
			for (const r of results) {
				if (r.domain === domain) {
					allResults.push(r);
				}
			}
		}
		return allResults;
	}

	/**
	 * Get all cached results across all domains and files,
	 * excluding files that match an ignore pattern.
	 */
	public getAllResults(): ICheckResult[] {
		const allResults: ICheckResult[] = [];
		for (const [, results] of this._resultsByFile) {
			if (results.length === 0) continue;
			if (this._matchesIgnore(results[0].fileUri)) continue;
			allResults.push(...results);
		}
		return allResults;
	}

	/**
	 * Get summary counts per domain.
	 *
	 * IMPORTANT: Domains are NOT hardcoded. This method discovers all
	 * unique domains from loaded rules, supporting enterprise-defined
	 * categories from imported frameworks.
	 */
	public getDomainSummary(): IDomainSummary[] {
		const rules = this._configLoader.getRules();

		// Discover all unique domains from rules
		const domainSet = new Set<GRCDomain>(GRC_BUILTIN_DOMAIN_LIST);
		for (const rule of rules) {
			domainSet.add(rule.domain);
		}

		return Array.from(domainSet).map(domain => {
			const domainRules = rules.filter(r => r.domain === domain);
			const domainResults = this.getResultsForDomain(domain);

			// Find which frameworks contribute to this domain
			const frameworkIds = new Set<string>();
			for (const r of domainRules) {
				if (r.frameworkId) {
					frameworkIds.add(r.frameworkId);
				}
			}

			return {
				domain,
				errorCount: domainResults.filter(r => toDisplaySeverity(r.severity) === 'error').length,
				warningCount: domainResults.filter(r => toDisplaySeverity(r.severity) === 'warning').length,
				infoCount: domainResults.filter(r => toDisplaySeverity(r.severity) === 'info').length,
				totalRules: domainRules.length,
				enabledRules: domainRules.filter(r => r.enabled).length,
				frameworkIds: frameworkIds.size > 0 ? Array.from(frameworkIds) : undefined,
			};
		});
	}

	/**
	 * Get all unique domains from loaded rules.
	 * Includes built-in + framework + user-defined domains.
	 */
	public getActiveDomains(): GRCDomain[] {
		const rules = this._configLoader.getRules();
		const domainSet = new Set<GRCDomain>(GRC_BUILTIN_DOMAIN_LIST);
		for (const rule of rules) {
			domainSet.add(rule.domain);
		}
		return Array.from(domainSet);
	}

	public getActiveFrameworks(): IFrameworkMetadata[] {
		return this.frameworkRegistry.getActiveFrameworks()
			.filter(fw => fw.validation.valid)
			.map(fw => fw.definition.framework);
	}

	public async importFramework(json: string): Promise<IFrameworkValidationResult> {
		return this.frameworkRegistry.importFramework(json);
	}

	/**
	 * Get violations that block commits.
	 *
	 * Returns only violations from rules that have
	 * `blockingBehavior.blocksCommit === true`.
	 */
	public getBlockingViolations(): ICheckResult[] {
		const allResults = this.getAllResults();
		return allResults.filter(r => r.blockingBehavior?.blocksCommit === true);
	}

	/**
	 * Get all loaded rules.
	 */
	public getRules(): IGRCRule[] {
		return this._configLoader.getRules();
	}

	/**
	 * Force reload rules from disk.
	 */
	public async reloadRules(): Promise<void> {
		await this._configLoader.reload();
	}

	/**
	 * Clear cached results for a specific file.
	 */
	public clearResultsForFile(fileUri: URI): void {
		this._resultsByFile.delete(fileUri.toString());
	}


	// ─── Rule Management (delegated to config loader) ────────────────

	public async saveRule(rule: IGRCRule): Promise<void> {
		await this._configLoader.saveRule(rule);
	}

	public async toggleRule(ruleId: string, enabled: boolean): Promise<void> {
		await this._configLoader.toggleRule(ruleId, enabled);
	}

	public async deleteRule(ruleId: string): Promise<void> {
		await this._configLoader.deleteRule(ruleId);
	}


	// ─── Ignore Patterns ─────────────────────────────────────────────

	public getIgnorePatterns(): string[] {
		return [...this._ignorePatterns];
	}

	public addIgnorePattern(pattern: string): void {
		const p = pattern.trim();
		if (!p || this._ignorePatterns.includes(p)) return;
		this._ignorePatterns.push(p);
		this._saveIgnorePatterns();
		this._onDidRulesChange.fire();
	}

	public removeIgnorePattern(pattern: string): void {
		const idx = this._ignorePatterns.indexOf(pattern);
		if (idx < 0) return;
		this._ignorePatterns.splice(idx, 1);
		this._saveIgnorePatterns();
		this._onDidRulesChange.fire();
	}

	private _saveIgnorePatterns(): void {
		this._storageService.store(
			GRCEngineService._IGNORE_KEY,
			JSON.stringify(this._ignorePatterns),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE
		);
	}

	/** Returns true if fileUri matches any ignore pattern */
	private _matchesIgnore(fileUri: URI): boolean {
		if (this._ignorePatterns.length === 0) return false;
		const fsPath = fileUri.path.replace(/\\/g, '/');
		return this._ignorePatterns.some(p => _globMatches(p, fsPath));
	}


	// ─── Workspace Scan ──────────────────────────────────────────────

	private static readonly _SCANNABLE_EXT = new Set([
		'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
		'py', 'java', 'c', 'cpp', 'cc', 'h', 'hpp',
		'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt',
		'sh', 'bash', 'yaml', 'yml', 'json', 'tf', 'toml',
		'sql', 'html', 'css', 'scss', 'less', 'lua',
	]);

	private static readonly _SKIP_DIRS = new Set([
		'node_modules', '.git', 'dist', 'build', 'out',
		'.next', '__pycache__', '.cache', 'coverage', '.nyc_output',
		'vendor', 'Pods', '.idea', '.vscode',
	]);

	public async scanWorkspace(): Promise<void> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		for (const folder of folders) {
			await this._scanDir(folder.uri, 0);
		}
		this._onDidCheckComplete.fire(this.getAllResults());
		console.log(`[GRCEngine] Workspace scan complete: ${this.getAllResults().length} violations across ${this._resultsByFile.size} files`);
	}

	private async _scanDir(dirUri: URI, depth: number): Promise<void> {
		if (depth > 12) return;
		try {
			const stat = await this._fileService.resolve(dirUri);
			if (!stat.children) return;
			for (const child of stat.children) {
				if (this._matchesIgnore(child.resource)) continue;
				if (child.isDirectory) {
					if (GRCEngineService._SKIP_DIRS.has(child.name)) continue;
					await this._scanDir(child.resource, depth + 1);
				} else {
					const ext = child.name.split('.').pop()?.toLowerCase() ?? '';
					if (!GRCEngineService._SCANNABLE_EXT.has(ext)) continue;
					try {
						const file = await this._fileService.readFile(child.resource);
						this.evaluateFileContent(child.resource, file.value.toString());
					} catch { /* unreadable file — skip */ }
				}
			}
		} catch { /* directory unreadable — skip */ }
	}
}

/**
 * Simple glob pattern matcher for ignore rules.
 * Supports: `*` (any non-separator chars), `**` (any path segment), `?` (any single char).
 * Pattern matches against forward-slash-normalized absolute paths.
 */
function _globMatches(pattern: string, filePath: string): boolean {
	const p = pattern.trim().replace(/\\/g, '/');
	const f = filePath.replace(/\\/g, '/');
	// Build regex from glob
	const reStr = p
		.replace(/[.+^${}()|[\]]/g, '\\$&')  // escape regex specials (not * ? /)
		.replace(/\*\*/g, '\x00')             // placeholder for **
		.replace(/\*/g, '[^/]*')              // * → any non-separator
		.replace(/\?/g, '[^/]')              // ? → single non-separator
		.replace(/\x00/g, '.*');             // ** → any sequence
	// If pattern doesn't start with /, match anywhere in path
	const anchored = p.startsWith('/') || p.startsWith('**/');
	try {
		const re = new RegExp(anchored ? reStr : `(^|/)${reStr}($|/|$)`);
		return re.test(f);
	} catch {
		return false;
	}
}

registerSingleton(IGRCEngineService, GRCEngineService, InstantiationType.Eager);
