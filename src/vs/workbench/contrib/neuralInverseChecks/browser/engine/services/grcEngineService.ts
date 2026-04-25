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
 *    - `regex` \u2192 regex pattern matching (inline, fast)
 *    - `file-level` \u2192 file-level checks (line count, headers)
 *    - `ast` \u2192 AST analyzer (when available)
 *    - `dataflow` \u2192 Data flow analyzer (when available)
 *    - `import-graph` \u2192 Import graph analyzer (workspace-level)
 *    - `external` \u2192 External tool runner (CLI delegation)
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
import { GRCDomain, IGRCRule, ICheckResult, IDomainSummary, GRC_BUILTIN_DOMAIN_LIST, toDisplaySeverity, IIgnoreSuggestion, IImpactNode } from '../types/grcTypes.js';
import { IInvariantDefinition } from '../types/invariantTypes.js';
import { GRCConfigLoader } from '../config/grcConfigLoader.js';
import { IFrameworkRegistry } from '../framework/frameworkRegistry.js';
import { IRegexCheck, IFileLevelCheck, IFrameworkMetadata, IFrameworkValidationResult } from '../framework/frameworkSchema.js';
import { IProjectAnalyzerService, INanoAgentContext } from '../../nanoAgents/projectAnalyzerService.js';
import { IContractReasonService } from './contractReasonService.js';
import { ITextFileService } from '../../../../../services/textfile/common/textfiles.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IPolicyService } from '../../context/autocomplete/policy/policyService.js';
import { detectDomainFromPath } from './policyRuleGenerator.js';
import { IExternalToolService } from './externalToolService.js';
import { ImportPatternRegistry } from '../config/importPatternRegistry.js';

export const IGRCEngineService = createDecorator<IGRCEngineService>('neuralInverseGRCEngineService');


// \u2500\u2500\u2500 Analyzer Interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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
	 * If defined, this analyzer only handles files whose language ID or extension
	 * matches one of these values. The engine checks this before dispatching.
	 * If undefined, the analyzer handles all languages for its supported types.
	 *
	 * Values are compared case-insensitively against the file's language ID and
	 * file extension. Special handling: 'python' matches both 'python' language ID
	 * and '.py' / '.pyw' extensions.
	 */
	readonly supportedLanguages?: string[];

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


// \u2500\u2500\u2500 Language ID from Extension \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** Maps common file extensions to VS Code language identifiers */
export const EXT_TO_LANGUAGE_ID: Record<string, string> = {
	ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
	py: 'python', java: 'java',
	c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cc: 'cpp', cxx: 'cpp', hh: 'cpp', hxx: 'cpp',
	cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php',
	swift: 'swift', kt: 'kotlin', scala: 'scala', sh: 'shellscript', bash: 'shellscript',
	sql: 'sql', yaml: 'yaml', yml: 'yaml', json: 'json', xml: 'xml',
	html: 'html', css: 'css', scss: 'scss', dockerfile: 'dockerfile',
	tf: 'terraform', hcl: 'hcl', r: 'r', m: 'objective-c',
	ino: 'c', pde: 'c',  // Arduino/Processing embedded C variants
	s: 'asm', asm: 'asm', // Assembler (handled generically)
};


// \u2500\u2500\u2500 Service Interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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
	 * Remove specific violations from a file's cached results by ruleId+line.
	 * Used to clear diagnostics for violations resolved/suppressed on the web console.
	 */
	clearSpecificViolations(fileUri: URI, keys: Array<{ ruleId: string; line: number }>): void;

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

	// \u2500\u2500\u2500 Formal Verification / Invariant Management \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/** Get all invariant definitions from .inverse/invariants.json */
	getInvariants(): IInvariantDefinition[];

	/** Add or update an invariant definition */
	saveInvariant(invariant: IInvariantDefinition): Promise<void>;

	/** Delete an invariant by ID */
	deleteInvariant(id: string): Promise<void>;

	/** Toggle an invariant's enabled state */
	toggleInvariant(id: string, enabled: boolean): Promise<void>;

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

	/** Remove a framework by ID. */
	removeFramework(id: string): Promise<void>;

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

	/** Get the current list of context-only patterns (excluded from scanning, kept as AI context) */
	getContextOnlyPatterns(): string[];

	/** Add a context-only pattern (file excluded from violations but used as AI context) */
	addContextOnlyPattern(pattern: string): void;

	/** Remove a context-only pattern */
	removeContextOnlyPattern(pattern: string): void;

	/** Get contents of context-only files collected during workspace scan */
	getContextFileContents(): Map<string, string>;

	/** Use AI to suggest ignore/context-only patterns based on project structure */
	generateIgnoreSuggestions(): Promise<IIgnoreSuggestion[]>;

	/** Get the reverse import map (normalized path \u2192 importer URIs) */
	getImportedByMap(): ReadonlyMap<string, readonly string[]>;

	/** Build a cross-file impact tree starting from a file */
	getImpactChain(fileUri: URI, maxDepth?: number): IImpactNode | undefined;

	/**
	 * Scan all workspace files with static rules and cache results.
	 * Triggers onDidCheckComplete when done. Also schedules AI scan.
	 */
	scanWorkspace(): Promise<void>;

	/**
	 * Run AI analysis across all workspace files.
	 * The intelligence service's content-hash cache prevents redundant LLM calls
	 * \u2014 files whose content has not changed since the last analysis are skipped.
	 * Cross-file import relationships are tracked so dependents can be re-analysed
	 * when a dependency changes.
	 */
	scanWorkspaceWithAI(): Promise<void>;

	/** Start periodic AI workspace scans at the given interval (ms). Skips already-scanned unchanged files. */
	startPeriodicAIScan(intervalMs?: number): void;

	/** Stop periodic AI workspace scans. */
	stopPeriodicAIScan(): void;

	/** Whether periodic AI scanning is active */
	readonly isPeriodicAIScanActive: boolean;

	/**
	 * Merge externally-produced results (from IExternalToolService) into the
	 * results cache for a specific file + ruleId, then fire onDidCheckComplete.
	 *
	 * This replaces any previous results for this ruleId in the file, preserving
	 * all other rule violations, AI findings, and breaking-change markers.
	 *
	 * Called asynchronously by ExternalToolService after a tool completes.
	 */
	setExternalResults(fileUri: URI, ruleId: string, results: ICheckResult[]): void;

	/**
	 * Trigger AI analysis on the active editor file as the user types.
	 * Fire-and-forget; respects a 3s per-file debounce so rapid typing does not
	 * spam LLM calls. No-ops when AI is unavailable or the file is ignored.
	 */
	triggerAIAnalysis(fileUri: URI, content: string): void;

	/** Get cached file content for a URI (used by dismiss \u2192 re-analysis flow) */
	getCachedContent(fileUri: URI): string | undefined;

	/** Whether inline VS Code diagnostics (squiggly lines) are currently shown */
	readonly inlineDiagnosticsEnabled: boolean;

	/** Toggle inline VS Code diagnostics on/off (engine keeps running) */
	setInlineDiagnosticsEnabled(enabled: boolean): void;

	/** Fires when inlineDiagnosticsEnabled changes */
	readonly onDidInlineDiagnosticsChange: Event<boolean>;

	/** Timestamp (ms since epoch) of last completed workspace scan, or 0 if never */
	getLastWorkspaceScanTime(): number;
}


// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

	/** Glob patterns for files excluded from scanning but kept as AI context */
	private _contextOnlyPatterns: string[] = [];
	private static readonly _CONTEXT_ONLY_KEY = 'grc.contextOnlyPatterns.v1';

	/** Content of context-only files (uri string \u2192 content). Capped at 20 files, 10KB each */
	private _contextFiles = new Map<string, string>();
	private static readonly _MAX_CONTEXT_FILES = 20;
	private static readonly _MAX_CONTEXT_FILE_SIZE = 10_240; // 10KB

	/**
	 * Reverse import map: resolved file path \u2192 URIs of files that import it.
	 * Used for cross-file AI re-analysis when a dependency changes.
	 */
	private readonly _importedBy = new Map<string, Set<string>>();

	/**
	 * Content cache for all workspace-scanned files (URI string \u2192 content).
	 * Built during static scan and updated on each save.
	 * Used to provide cross-file dependency context to AI analysis on save.
	 * Capped at 200 files × 50KB each to bound memory usage.
	 */
	private readonly _fileContentCache = new Map<string, string>();
	private static readonly _MAX_CONTENT_CACHE_FILES = 200;
	private static readonly _MAX_CONTENT_CACHE_FILE_SIZE = 51_200; // 50KB

	/** Guards against scheduling the initial AI scan more than once */
	private _initialAIScanScheduled = false;

	/** Guards against bootstrapping the import map more than once */
	private _importMapBootstrapped = false;

	/** Timer handle for periodic AI workspace scans */
	private _periodicAIScanTimer: ReturnType<typeof setInterval> | undefined;
	private _periodicAIScanActive = false;

	/** Last AI scan timestamp per file URI string \u2014 used to debounce save-triggered scans */
	private readonly _lastScanTimestamp = new Map<string, number>();

	/** Whether live (save-triggered) scanning is active \u2014 shown in UI */
	private _liveScanActive = false;

	/** Language-agnostic import pattern registry \u2014 covers all sectors and languages */
	private readonly _importPatternRegistry: ImportPatternRegistry;

	private readonly _onDidCheckComplete = this._register(new Emitter<ICheckResult[]>());
	public readonly onDidCheckComplete: Event<ICheckResult[]> = this._onDidCheckComplete.event;

	private readonly _onDidRulesChange = this._register(new Emitter<void>());
	public readonly onDidRulesChange: Event<void> = this._onDidRulesChange.event;

	private readonly _onDidInlineDiagnosticsChange = this._register(new Emitter<boolean>());
	public readonly onDidInlineDiagnosticsChange: Event<boolean> = this._onDidInlineDiagnosticsChange.event;

	private static readonly _INLINE_DIAG_KEY = 'grc.inlineDiagnosticsEnabled.v1';
	private _inlineDiagnosticsEnabled: boolean = true;
	private _lastWorkspaceScanTime: number = 0;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IFrameworkRegistry private readonly frameworkRegistry: IFrameworkRegistry,
		@IProjectAnalyzerService private readonly projectAnalyzerService: IProjectAnalyzerService,
		@IContractReasonService private readonly contractReasonService: IContractReasonService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IStorageService private readonly _storageService: IStorageService,
		@IPolicyService private readonly policyService: IPolicyService,
		@IExternalToolService private readonly externalToolService: IExternalToolService,
	) {
		super();

		// Wire the result sink so external tools can inject results without a circular import
		this.externalToolService.registerResultSink((fileUri, ruleId, results) => {
			this.setExternalResults(fileUri, ruleId, results);
		});

		// Load persisted ignore patterns
		const stored = this._storageService.get(GRCEngineService._IGNORE_KEY, StorageScope.WORKSPACE);
		if (stored) {
			try { this._ignorePatterns = JSON.parse(stored); } catch { /* ignore */ }
		}

		// Load persisted inline diagnostics preference (default: enabled=true)
		// Only override if explicitly stored \u2014 absence means "use default ON"
		const storedInlineDiag = this._storageService.get(GRCEngineService._INLINE_DIAG_KEY, StorageScope.WORKSPACE);
		if (storedInlineDiag === 'false') {
			this._inlineDiagnosticsEnabled = false;
		}
		// else: stays true (the field default)

		// Load persisted context-only patterns
		const ctxStored = this._storageService.get(GRCEngineService._CONTEXT_ONLY_KEY, StorageScope.WORKSPACE);
		if (ctxStored) {
			try { this._contextOnlyPatterns = JSON.parse(ctxStored); } catch { /* ignore */ }
		}

		// Language-universal import pattern registry
		this._importPatternRegistry = new ImportPatternRegistry(this._fileService, this._workspaceContextService);

		this._configLoader = this._register(
			new GRCConfigLoader(this._fileService, this._workspaceContextService, frameworkRegistry, this.policyService)
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

		// Real-time AI analysis on file save.
		// Intelligence service handles content-hash dedup (unchanged files cost zero LLM calls).
		// Debounced: won't re-scan the same file more than once every 10 seconds.
		// After primary file is analyzed, dependents are queued with a short delay.
		this._register(this.textFileService.files.onDidSave(e => {
			const model = e.model.textEditorModel;
			if (!model) return;
			const fileUri = e.model.resource;

			// Skip anything outside the workspace (covers scheme, folder, system dirs, etc.)
			if (!this._isInWorkspace(fileUri)) return;
			if (fileUri.path.includes('/.inverse/')) return;

			// Skip fully-ignored files entirely
			if (this._matchesIgnore(fileUri)) return;

			const content = model.getValue();
			const allRules = this._configLoader.getRules();

			// Always update import map and content cache on save so cross-file data stays current
			this._updateImportMap(fileUri, content);
			this._cacheFileContent(fileUri.toString(), content);

			// Skip context-only files from AI analysis (they're context, not targets)
			if (this._matchesContextOnly(fileUri)) return;

			if (!this.contractReasonService.isAvailable) return;

			// Debounce: skip if we just scanned this file within the last 10 seconds
			const fileKey = fileUri.toString();
			const lastScan = this._lastScanTimestamp.get(fileKey);
			if (lastScan && Date.now() - lastScan < 10_000) return;

			this._lastScanTimestamp.set(fileKey, Date.now());

			// Mark live scan active for UI
			if (!this._liveScanActive) {
				this._liveScanActive = true;
				this.contractReasonService.scanTrackerSetPeriodicState(this._periodicAIScanActive, undefined);
			}

			const cachedResults = this._resultsByFile.get(fileKey) || [];
			const nanoContext = this.projectAnalyzerService.getContextForFile(fileUri);

			// Primary: analyze the saved file with cross-file context
			const ctxFiles = this._contextFiles.size > 0 ? new Map(this._contextFiles) : undefined;
			const allFileContents = this._buildAllFileContents();
			const riskScore = this._computeRiskScore(fileUri, content, cachedResults);
			this.contractReasonService.analyzeFile(fileUri, content, cachedResults, allRules, nanoContext, ctxFiles, allFileContents, riskScore);

			// Cross-file: re-analyze dependents after a short delay (max 5)
			const basePath = fileUri.path.replace(/\.[^/.]+$/, '');
			const dependents = new Set<string>();
			for (const [key, importers] of this._importedBy) {
				if (key === basePath || key.startsWith(basePath + '/') || basePath.endsWith('/' + key)) {
					for (const imp of importers) dependents.add(imp);
				}
			}

			if (dependents.size > 0) {
				setTimeout(() => {
					let count = 0;
					for (const depUriStr of dependents) {
						if (++count > 5) break;
						const lastDepScan = this._lastScanTimestamp.get(depUriStr);
						if (lastDepScan && Date.now() - lastDepScan < 10_000) continue;
						this._lastScanTimestamp.set(depUriStr, Date.now());

						const depUri = URI.parse(depUriStr);
						this._fileService.readFile(depUri).then(file => {
							const depContent = file.value.toString();
							this._cacheFileContent(depUriStr, depContent);
							const depResults = this._resultsByFile.get(depUriStr) || [];
							const depContext = this.projectAnalyzerService.getContextForFile(depUri);
							const depRisk = this._computeRiskScore(depUri, depContent, depResults);
							const depAllFileContents = this._buildAllFileContents();
							this.contractReasonService.analyzeFile(depUri, depContent, depResults, allRules, depContext, ctxFiles, depAllFileContents, depRisk);
						}).catch(() => { /* dependent unreadable \u2014 skip */ });
					}
				}, 3_000);
			}
		}));

		// Schedule initial full workspace AI scan once rules are loaded and AI is ready.
		// Delay gives the editor time to fully initialise before we start reading files.
		// Also bootstrap the import map at 2s so cross-file impact works immediately
		// without waiting for the full AI scan (which may be 10s+ or disabled).
		this._register(this._configLoader.onDidChange(() => {
			if (this._configLoader.getRules().length === 0) return;

			// Bootstrap import map at 2s \u2014 import parsing only, no AI, no pattern evaluation
			if (!this._importMapBootstrapped) {
				this._importMapBootstrapped = true;
				setTimeout(() => {
					this._bootstrapImportMap().catch(e =>
						console.error('[GRCEngine] Import map bootstrap failed:', e)
					);
				}, 2_000);
			}

			if (this._initialAIScanScheduled) return;
			this._initialAIScanScheduled = true;
			setTimeout(() => {
				this.scanWorkspaceWithAI().catch(e =>
					console.error('[GRCEngine] Initial AI workspace scan failed:', e)
				);
			}, 10_000); // 10s after first rule load
		}));

		// When the contract reasoning service becomes available (model configured after the
		// initial 10s scan window passed), trigger a workspace scan so AI results are not
		// permanently skipped for a session. Content-hash caching in contractReasonService
		// makes repeated scans cheap \u2014 unchanged files cost zero LLM calls.
		this._register(this.contractReasonService.onDidEnabledChange((enabled) => {
			if (!enabled) return;
			if (this._configLoader.getRules().length === 0) return;
			// Brief delay lets framework comprehension finish before we start file analysis
			setTimeout(() => {
				this.scanWorkspaceWithAI().catch(e =>
					console.error('[GRCEngine] Post-enable AI workspace scan failed:', e)
				);
			}, 3_000);
		}));

		// When infra pushes new/updated frameworks, re-run AI scan with fresh rules.
		// ContractReasonService already clears its hash cache on frameworksChange,
		// so this scan will re-analyze all files against the updated rule set.
		this._register(this.frameworkRegistry.onDidFrameworksChange(() => {
			if (!this.contractReasonService.isAvailable) return;
			if (this._configLoader.getRules().length === 0) return;
			console.log('[GRCEngine] Frameworks changed \u2014 scheduling AI rescan with updated rules');
			setTimeout(() => {
				this.scanWorkspaceWithAI().catch(e =>
					console.error('[GRCEngine] Framework-change AI scan failed:', e)
				);
			}, 5_000); // give comprehension time to finish first
		}));

		// When intelligence results arrive, enrich existing violations and add new ones
		this._register(this.contractReasonService.onDidContractReasonResultsReady((result) => {
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

			// Apply false positive flags \u2014 mark matched violations as low-confidence
			let fpCount = 0;
			if (result.falsePositiveFlags && result.falsePositiveFlags.length > 0) {
				for (const fp of result.falsePositiveFlags) {
					for (const r of existing) {
						if (r.ruleId === fp.ruleId && r.line === fp.line) {
							r.aiConfidence = 'low';
							r.aiExplanation = (r.aiExplanation || '') + ` [AI: likely false positive \u2014 ${fp.reason}]`;
							changed = true;
							fpCount++;
						}
					}
				}
			}

			// Apply positive findings \u2014 mark static violations as AI-confirmed true positives
			if (result.positiveFindings && result.positiveFindings.length > 0) {
				for (const pf of result.positiveFindings) {
					for (const r of existing) {
						if (r.ruleId === pf.ruleId && r.line === pf.line) {
							r.aiConfidence = pf.confidence;
							r.aiExplanation = (r.aiExplanation ? r.aiExplanation + ' ' : '') + `[AI confirmed: ${pf.reason}]`;
							changed = true;
						}
					}
				}
			}

			// Add intelligence-discovered violations (deduplicated, with low-confidence corroboration filter)
			const existingKeys = new Set(existing.map(r => `${r.ruleId}:${r.line}`));
			const newViolations = result.additionalViolations.filter(v => {
				if (existingKeys.has(`${v.ruleId}:${v.line}`)) return false; // already in static cache

				// Low-confidence AI violations require static corroboration within ±5 lines on same rule
				if (v.aiConfidence === 'low') {
					const hasCorroboration = existing.some(r =>
						r.ruleId === v.ruleId &&
						r.checkSource !== 'ai' &&
						Math.abs(r.line - v.line) <= 5
					);
					return hasCorroboration;
				}
				return true;
			});
			// \u2500\u2500 Cross-file relatedViolations linkage \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
			// Populate relatedViolations by cross-referencing dataFlowTrace file
			// references against the results cache for other files.
			for (const v of newViolations) {
				if (!v.dataFlowTrace || v.dataFlowTrace.length === 0) continue;

				for (const traceStep of v.dataFlowTrace) {
					const traceFileKey = this._resolveTraceFileKey(traceStep.file, result.fileUri);
					if (!traceFileKey) continue;

					const traceResults = this._resultsByFile.get(traceFileKey);
					if (!traceResults || traceResults.length === 0) continue;

					const relatedInTrace = traceResults.filter(r =>
						r.ruleId === v.ruleId && r.checkSource !== 'breaking'
					);

					if (relatedInTrace.length > 0) {
						v.relatedViolations = v.relatedViolations ?? [];
						for (const rel of relatedInTrace) {
							const alreadyLinked = v.relatedViolations.some(
								rv => rv.fileUri === traceFileKey && rv.line === rel.line && rv.ruleId === rel.ruleId
							);
							if (!alreadyLinked) {
								v.relatedViolations.push({
									fileUri: traceFileKey,
									line: rel.line,
									ruleId: rel.ruleId,
									relationship: traceStep.description.toLowerCase().includes('source') ||
										traceStep.description.toLowerCase().includes('tainted') ? 'upstream' : 'downstream',
								});
							}
						}
					}
				}
			}

			if (newViolations.length > 0) {
				existing.push(...newViolations);
				changed = true;
			}

			if (changed) {
				this._resultsByFile.set(fileKey, existing);
				this._onDidCheckComplete.fire(existing);
				const enrichCount = result.enrichments.size;
				const newCount = newViolations.length;
				console.log(`[GRCEngine] Intelligence: ${enrichCount} enriched, ${newCount} new violations, ${fpCount} false positive flags for ${result.fileUri.path.split('/').pop()}`);
			}
		}));
	}


	// \u2500\u2500\u2500 Analyzer Registration \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

	/** Cache file content for cross-file AI context, evicting oldest entries when full. */
	private _cacheFileContent(uriStr: string, content: string): void {
		if (content.length > GRCEngineService._MAX_CONTENT_CACHE_FILE_SIZE) return;
		if (this._fileContentCache.size >= GRCEngineService._MAX_CONTENT_CACHE_FILES) {
			// Evict the first (oldest) entry
			const firstKey = this._fileContentCache.keys().next().value;
			if (firstKey) this._fileContentCache.delete(firstKey);
		}
		this._fileContentCache.set(uriStr, content);
	}

	/** Build a snapshot of file contents available for cross-file AI context. */
	private _buildAllFileContents(): Map<string, string> | undefined {
		if (this._fileContentCache.size === 0) return undefined;
		return new Map(this._fileContentCache);
	}


	// \u2500\u2500\u2500 Evaluation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Evaluate all enabled rules against a text model.
	 *
	 * Routes each rule to the appropriate analyzer based on `rule.type`:
	 * - `regex` \u2192 built-in regex matching (handled here)
	 * - `file-level` \u2192 built-in file-level checks (handled here)
	 * - Other types \u2192 delegated to registered analyzers
	 *
	 * Results are cached per file URI and an event is fired.
	 */
	public evaluateDocument(model: ITextModel): ICheckResult[] {
		const fileUri = model.uri;

		// \u2500\u2500 Guard: workspace containment (scheme, folder, blocked dirs, system paths) \u2500\u2500
		if (!this._isInWorkspace(fileUri)) {
			this._resultsByFile.delete(fileUri.toString());
			return [];
		}

		// \u2500\u2500 Guard: never run GRC checks on files inside .inverse/ \u2500\u2500
		if (fileUri.path.includes('/.inverse/') || fileUri.path.endsWith('/.inverse')) {
			return [];
		}

		// \u2500\u2500 Guard: fully-ignored files produce no violations \u2500\u2500
		if (this._matchesIgnore(fileUri)) {
			this._resultsByFile.delete(fileUri.toString());
			return [];
		}

		// \u2500\u2500 Guard: context-only files are never scanned for violations \u2500\u2500
		if (this._matchesContextOnly(fileUri)) {
			this._resultsByFile.delete(fileUri.toString());
			return [];
		}

		// \u2500\u2500 Get nano agent context for this file \u2500\u2500
		const nanoContext = this.projectAnalyzerService.getContextForFile(fileUri);

		const allRules = this._configLoader.getRules().filter(r => r.enabled);
		const results: ICheckResult[] = [];
		const lines = model.getLinesContent();
		const now = Date.now();

		// Cache the content of open files so save-triggered AI analysis has cross-file context
		this._cacheFileContent(fileUri.toString(), lines.join('\n'));

		// Detect file's policy domain for policy-tagged rule filtering
		const policy = this.policyService.getPolicy();
		const fileDomain = policy ? detectDomainFromPath(fileUri.path, policy) : 'default';

		// Filter: policy-tagged rules only apply to their target domain (or 'default' applies everywhere)
		// Also exclude external rules \u2014 they run async via IExternalToolService
		const rules = allRules.filter(r => {
			if ((r.type ?? 'regex') === 'external') return false; // handled by ExternalToolService
			if (!r.tags?.includes('policy')) return true; // Non-policy rules always apply
			const ruleDomain = r.tags.find(t => t !== 'policy' && t !== 'security');
			if (!ruleDomain || ruleDomain === 'default') return true; // 'default' domain rules apply everywhere
			return ruleDomain === fileDomain;
		});

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
						// Language guard: if the analyzer declares supported languages, only dispatch
						// when the file's language ID or extension matches one of those languages.
						if (analyzer.supportedLanguages && analyzer.supportedLanguages.length > 0) {
							const fileLang = (model?.getLanguageId() ?? '').toLowerCase();
							const ext = fileUri.path.split('.').pop()?.toLowerCase() ?? '';
							const matches = analyzer.supportedLanguages.some(l => {
								const lc = l.toLowerCase();
								if (lc === fileLang) return true;
								if (lc === ext) return true;
								if (lc === 'python' && (ext === 'py' || ext === 'pyw')) return true;
								return false;
							});
							if (!matches) break;
						}
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

		// Dedup: remove same-location same-detector violations from multiple rules
		const dedupedResults = this._deduplicateResults(results, rules);

		// Cache results \u2014 preserve any previous AI-found violations and enrichments
		const existingResults = this._resultsByFile.get(fileUri.toString()) || [];

		// 1. Restore AI enrichments to the newly computed static results
		for (const newR of dedupedResults) {
			const existingEnriched = existingResults.find(r => r.ruleId === newR.ruleId && r.line === newR.line && r.aiExplanation);
			if (existingEnriched) {
				newR.aiExplanation = existingEnriched.aiExplanation;
				newR.aiConfidence = existingEnriched.aiConfidence;
			}
		}

		// 2. Keep purely AI-discovered violations that aren't in the static results at all
		const aiViolations = existingResults.filter(r => (r.checkSource === 'ai' || r.aiExplanation) && !dedupedResults.some(
			newR => newR.ruleId === r.ruleId && newR.line === r.line
		));

		// 3. Keep breaking-change violations (managed by BreakingChangeDetector)
		const breakingViolations = existingResults.filter(r => r.isBreakingChange);

		const mergedResults = [...dedupedResults, ...aiViolations, ...breakingViolations];
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
		// Skip files outside the workspace (scheme, folder, blocked dirs, system paths)
		if (!this._isInWorkspace(fileUri)) {
			this._resultsByFile.delete(fileUri.toString());
			return [];
		}

		// Skip .inverse files
		if (fileUri.path.includes('/.inverse/') || fileUri.path.endsWith('/.inverse')) {
			return [];
		}

		// Skip fully-ignored files
		if (this._matchesIgnore(fileUri)) {
			this._resultsByFile.delete(fileUri.toString());
			return [];
		}

		// Skip context-only files \u2014 they are AI context, not scanned for violations
		if (this._matchesContextOnly(fileUri)) {
			this._resultsByFile.delete(fileUri.toString());
			return [];
		}

		const allRules = this._configLoader.getRules().filter(r => r.enabled);
		const results: ICheckResult[] = [];
		const lines = content.split('\n');
		const now = Date.now();

		// Trigger file-scope external rules asynchronously (results arrive via setExternalResults)
		const externalFileRules = allRules.filter(r => r.type === 'external');
		if (externalFileRules.length > 0) {
			this.externalToolService.runFileScans(externalFileRules, fileUri, content);
		}

		// Detect file's policy domain for policy-tagged rule filtering
		const policy = this.policyService.getPolicy();
		const fileDomain = policy ? detectDomainFromPath(fileUri.path, policy) : 'default';

		// Exclude external rules from synchronous evaluation
		const rules = allRules.filter(r => {
			if ((r.type ?? 'regex') === 'external') return false;
			if (!r.tags?.includes('policy')) return true;
			const ruleDomain = r.tags.find(t => t !== 'policy' && t !== 'security');
			if (!ruleDomain || ruleDomain === 'default') return true;
			return ruleDomain === fileDomain;
		});

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

						// Language guard: only dispatch if the file language matches
						if (analyzer.supportedLanguages && analyzer.supportedLanguages.length > 0) {
							const matches = analyzer.supportedLanguages.some(l => {
								const lc = l.toLowerCase();
								if (lc === langId.toLowerCase()) return true;
								if (lc === ext) return true;
								if (lc === 'python' && (ext === 'py' || ext === 'pyw')) return true;
								return false;
							});
							if (!matches) break;
						}

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

		// Dedup: remove same-location same-detector violations from multiple rules
		const dedupedResults = this._deduplicateResults(results, rules);

		// Cache results \u2014 preserve any previous AI-found violations and enrichments
		const existingResults = this._resultsByFile.get(fileUri.toString()) || [];

		for (const newR of dedupedResults) {
			const existingEnriched = existingResults.find(r => r.ruleId === newR.ruleId && r.line === newR.line && r.aiExplanation);
			if (existingEnriched) {
				newR.aiExplanation = existingEnriched.aiExplanation;
				newR.aiConfidence = existingEnriched.aiConfidence;
			}
		}

		const aiViolations = existingResults.filter(r => (r.checkSource === 'ai' || r.aiExplanation) && !dedupedResults.some(
			newR => newR.ruleId === r.ruleId && newR.line === r.line
		));

		const breakingViolations = existingResults.filter(r => r.isBreakingChange);

		const mergedResults = [...dedupedResults, ...aiViolations, ...breakingViolations];
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
		if (!this._isInWorkspace(fileUri)) return;

		const fileKey = fileUri.toString();
		const existing = this._resultsByFile.get(fileKey) || [];

		// Revive each violation: fileUri comes back from JSON as a plain object
		const violations: ICheckResult[] = rawViolations.map(v => ({
			...v,
			fileUri: fileUri, // Use the known URI directly \u2014 avoids URI.revive complexity
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
	 * Fire-and-forget AI analysis triggered by the active editor while typing.
	 * Uses the same 3s per-file timestamp guard as save-triggered analysis so a
	 * rapid sequence of keystrokes still produces at most one LLM call per 3s.
	 */
	public triggerAIAnalysis(fileUri: URI, content: string): void {
		if (!this._isInWorkspace(fileUri)) return;
		if (!this.contractReasonService.isAvailable) return;
		if (this._matchesIgnore(fileUri)) return;
		if (this._matchesContextOnly(fileUri)) return;
		if (fileUri.path.includes('/.inverse/')) return;

		const fileKey = fileUri.toString();
		const lastScan = this._lastScanTimestamp.get(fileKey);
		if (lastScan && Date.now() - lastScan < 3_000) return;
		this._lastScanTimestamp.set(fileKey, Date.now());

		const allRules = this._configLoader.getRules();
		const cachedResults = this._resultsByFile.get(fileKey) || [];
		const nanoContext = this.projectAnalyzerService.getContextForFile(fileUri);
		const ctxFiles = this._contextFiles.size > 0 ? new Map(this._contextFiles) : undefined;
		const riskScore = this._computeRiskScore(fileUri, content, cachedResults);
		this.contractReasonService.analyzeFile(fileUri, content, cachedResults, allRules, nanoContext, ctxFiles, undefined, riskScore);
	}


	public getCachedContent(fileUri: URI): string | undefined {
		return this._fileContentCache.get(fileUri.toString());
	}

	public get inlineDiagnosticsEnabled(): boolean {
		return this._inlineDiagnosticsEnabled;
	}

	public setInlineDiagnosticsEnabled(enabled: boolean): void {
		if (this._inlineDiagnosticsEnabled === enabled) return;
		this._inlineDiagnosticsEnabled = enabled;
		this._storageService.store(GRCEngineService._INLINE_DIAG_KEY, String(enabled), StorageScope.WORKSPACE, StorageTarget.USER);
		this._onDidInlineDiagnosticsChange.fire(enabled);
	}

	public getLastWorkspaceScanTime(): number {
		return this._lastWorkspaceScanTime;
	}

	/**
	 * Remove specific violations from a file's cached results.
	 * Called when suppressions change (e.g. resolved on the web console) so
	 * diagnostics clear without waiting for a full rescan.
	 */
	public clearSpecificViolations(fileUri: URI, keys: Array<{ ruleId: string; line: number }>): void {
		if (keys.length === 0) return;
		const fileKey = fileUri.toString();
		const existing = this._resultsByFile.get(fileKey);
		if (!existing || existing.length === 0) return;

		const keySet = new Set(keys.map(k => `${k.ruleId}:${k.line}`));
		const filtered = existing.filter(r => !keySet.has(`${r.ruleId}:${r.line}`));
		if (filtered.length === existing.length) return; // nothing changed

		if (filtered.length === 0) {
			this._resultsByFile.delete(fileKey);
		} else {
			this._resultsByFile.set(fileKey, filtered);
		}
		this._onDidCheckComplete.fire(filtered);
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


	// \u2500\u2500\u2500 Regex Evaluation (built-in) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Evaluate a regex-type rule against all lines of code.
	 *
	 * Supports two patterns:
	 * 1. Rule has `pattern` field directly (backward compat / built-in rules)
	 * 2. Rule has `check.pattern` (framework-imported rules)
	 */
	private _evaluateRegexRule(rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number): ICheckResult[] {
		const results: ICheckResult[] = [];

		// Skip languages where this rule intentionally defers to a structural analyzer
		if (rule.skipLanguages && rule.skipLanguages.length > 0) {
			const ext = fileUri.path.split('.').pop()?.toLowerCase() ?? '';
			const langId = EXT_TO_LANGUAGE_ID[ext] ?? ext;
			const skip = rule.skipLanguages.some(l => {
				const lc = l.toLowerCase();
				return lc === langId || lc === ext;
			});
			if (skip) return results;
		}

		const check = rule.check as IRegexCheck | undefined;
		const regex = this._getRegex(rule);
		if (!regex) {
			return results;
		}

		const excludeContexts = check?.excludeContexts;

		// \u2500\u2500 Multi-line mode: run against entire file content \u2500\u2500
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

		// \u2500\u2500 Line-by-line mode (default) \u2500\u2500
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


	// \u2500\u2500\u2500 Context Stripping Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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
			// Remove // comments (not inside strings \u2014 best effort)
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


	// \u2500\u2500\u2500 File-Level Evaluation (built-in) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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

		// Determine what to check \u2014 use structured check if available, else legacy
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


	// \u2500\u2500\u2500 Result Deduplication \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Remove duplicate violations that fire at the same location for the same
	 * underlying detector \u2014 which happens when both a builtin rule and a
	 * framework rule map to the same structural check (e.g. MISRA-015 and
	 * FW-ERROR-PROP both use detect:'missing-error-propagation').
	 *
	 * Dedup key: `checkType:detectOrPattern:line`
	 * When two results share the same key, the builtin rule's result wins;
	 * otherwise the first-encountered result is kept.
	 */
	private _deduplicateResults(results: ICheckResult[], rules: IGRCRule[]): ICheckResult[] {
		const ruleById = new Map<string, IGRCRule>();
		for (const r of rules) ruleById.set(r.id, r);

		const seen = new Map<string, ICheckResult>();

		for (const result of results) {
			const rule = ruleById.get(result.ruleId);
			const check = rule?.check as { type?: string; detect?: string; pattern?: string } | undefined;

			let dedupKey: string;
			if (check?.detect) {
				dedupKey = `${check.type}:${check.detect}:${result.line}:${result.column}`;
			} else if (check?.pattern) {
				dedupKey = `regex:${check.pattern}:${result.line}:${result.column}`;
			} else if (rule?.pattern) {
				dedupKey = `regex:${rule.pattern}:${result.line}:${result.column}`;
			} else {
				// No structural key \u2014 keep as-is
				seen.set(`unique:${result.ruleId}:${result.line}:${result.column}`, result);
				continue;
			}

			const existing = seen.get(dedupKey);
			if (!existing) {
				seen.set(dedupKey, result);
			} else {
				// Prefer the builtin rule's result over a framework rule's result
				const existingRule = ruleById.get(existing.ruleId);
				if (!existingRule?.builtin && rule?.builtin) {
					seen.set(dedupKey, result);
				}
			}
		}

		return Array.from(seen.values());
	}


	// \u2500\u2500\u2500 Regex Cache \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Gets or compiles a regex for a rule.
	 *
	 * Supports:
	 * - `rule.pattern` (legacy/built-in rules)
	 * - `rule.check.pattern` (framework rules with type: "regex")
	 */
	private _getRegex(rule: IGRCRule): RegExp | null {
		// Determine pattern \u2014 prefer check.pattern, fall back to rule.pattern
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


	// \u2500\u2500\u2500 Query Methods \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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
			if (!this._isInWorkspace(results[0].fileUri)) continue; // purge stale out-of-workspace entries
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

	public async removeFramework(id: string): Promise<void> {
		return this.frameworkRegistry.removeFramework(id);
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


	// \u2500\u2500\u2500 Rule Management (delegated to config loader) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public async saveRule(rule: IGRCRule): Promise<void> {
		await this._configLoader.saveRule(rule);
	}

	public async toggleRule(ruleId: string, enabled: boolean): Promise<void> {
		await this._configLoader.toggleRule(ruleId, enabled);
	}

	public async deleteRule(ruleId: string): Promise<void> {
		await this._configLoader.deleteRule(ruleId);
	}


	// \u2500\u2500\u2500 Formal Verification / Invariant Management \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public getInvariants(): IInvariantDefinition[] {
		return this._configLoader.getInvariants();
	}

	public async saveInvariant(invariant: IInvariantDefinition): Promise<void> {
		await this._configLoader.saveInvariant(invariant);
	}

	public async deleteInvariant(id: string): Promise<void> {
		await this._configLoader.deleteInvariant(id);
	}

	public async toggleInvariant(id: string, enabled: boolean): Promise<void> {
		await this._configLoader.toggleInvariant(id, enabled);
	}


	// \u2500\u2500\u2500 Ignore Patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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


	// \u2500\u2500\u2500 Context-Only Patterns \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public getContextOnlyPatterns(): string[] {
		return [...this._contextOnlyPatterns];
	}

	public addContextOnlyPattern(pattern: string): void {
		const p = pattern.trim();
		if (!p || this._contextOnlyPatterns.includes(p)) return;
		this._contextOnlyPatterns.push(p);
		this._saveContextOnlyPatterns();
		this._onDidRulesChange.fire();
	}

	public removeContextOnlyPattern(pattern: string): void {
		const idx = this._contextOnlyPatterns.indexOf(pattern);
		if (idx < 0) return;
		this._contextOnlyPatterns.splice(idx, 1);
		this._saveContextOnlyPatterns();
		this._onDidRulesChange.fire();
	}

	public getContextFileContents(): Map<string, string> {
		return new Map(this._contextFiles);
	}

	private _saveContextOnlyPatterns(): void {
		this._storageService.store(
			GRCEngineService._CONTEXT_ONLY_KEY,
			JSON.stringify(this._contextOnlyPatterns),
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE
		);
	}

	/** Returns true if fileUri matches a context-only pattern */
	private _matchesContextOnly(fileUri: URI): boolean {
		if (this._contextOnlyPatterns.length === 0) return false;
		const fsPath = fileUri.path.replace(/\\/g, '/');
		return this._contextOnlyPatterns.some(p => _globMatches(p, fsPath));
	}

	/**
	 * Authoritative workspace containment check.
	 *
	 * Returns true ONLY when ALL of the following conditions hold:
	 *   1. The URI scheme is 'file' (rejects untitled:, vscode-extension:,
	 *      vscode-userdata:, output:, debug:, git:, memfs:, ts-nul-authority:,
	 *      extension-output:, readonly:, walkThrough:, and any other virtual scheme)
	 *   2. The file path is inside at least one workspace folder
	 *      (exact folder root match OR path starts with folder path + '/')
	 *   3. The file is NOT inside a hard-blocked system/tool directory
	 *      (node_modules, .git, dist, build, out, __pycache__, vendor, Pods, ...)
	 *   4. The file is NOT a known VS Code internal virtual path
	 *      (/extension/, /.vscode/extensions/, vscode-app/, etc.)
	 *
	 * All four conditions must pass. If the workspace has no folders yet
	 * (empty window / untitled workspace), returns false \u2014 nothing to scan.
	 *
	 * This is the ONLY place that decides whether a URI is in-scope.
	 * All other entry points (evaluateDocument, evaluateFileContent,
	 * triggerAIAnalysis, onDidSave, restoreAIViolations) delegate here.
	 */
	private _isInWorkspace(uri: URI): boolean {
		// \u2500\u2500 Rule 1: only real on-disk files \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		// Rejects: untitled, vscode-extension, vscode-userdata, output, debug,
		// git (diff view), memfs (extension virtual FS), ts-nul-authority,
		// extension-output, readonly, walkThrough, command, webview-panel, etc.
		if (uri.scheme !== 'file') return false;

		// \u2500\u2500 Rule 2: path must be inside a workspace folder \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) return false; // untitled/empty window \u2014 nothing to scan

		const filePath = uri.path;
		const inFolder = folders.some(f => {
			const fp = f.uri.path;
			// exact match (folder root itself) OR strict prefix with '/' separator
			// We normalize away any trailing slash on the folder path to be safe.
			const normalized = fp.endsWith('/') ? fp.slice(0, -1) : fp;
			return filePath === normalized || filePath.startsWith(normalized + '/');
		});
		if (!inFolder) return false;

		// \u2500\u2500 Rule 3: not inside a blocked infrastructure directory \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		// These dirs never contain user-authored source code and scanning them
		// produces noise (minified bundles, lock files, build artifacts, etc.).
		const BLOCKED_SEGMENTS = [
			'/node_modules/',
			'/.git/',
			'/dist/',
			'/build/',
			'/out/',
			'/__pycache__/',
			'/vendor/',
			'/Pods/',
			'/.nyc_output/',
			'/coverage/',
			'/.cache/',
			'/.next/',
			'/.nuxt/',
			'/.svelte-kit/',
			'/target/',        // Rust / Maven
			'/bin/',           // common compiled output
			'/obj/',           // .NET / C++ build artefacts
			'/.gradle/',
			'/.m2/',
			'/__mocks__/',
		];
		if (BLOCKED_SEGMENTS.some(seg => filePath.includes(seg))) return false;

		// Also block if the path ends with one of these (e.g. a file called node_modules)
		if (
			filePath.endsWith('/node_modules') ||
			filePath.endsWith('/.git') ||
			filePath.endsWith('/dist') ||
			filePath.endsWith('/build') ||
			filePath.endsWith('/out') ||
			filePath.endsWith('/target')
		) return false;

		// \u2500\u2500 Rule 4: not a VS Code internal / extension virtual path \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		// VS Code can open internal files (extension manifests, theme JSON,
		// grammar files, etc.) via go-to-definition or extension preview.
		const BLOCKED_PATH_PREFIXES = [
			'/.vscode/extensions/',
			'/vscode-app/',
			'/.cursor/extensions/',    // Cursor IDE
			'/extensions/',            // when path is absolute from VS Code root
		];
		// Only block these if they appear as a path segment after the workspace root
		// \u2014 i.e., they are NOT inside any workspace folder (already checked above),
		// so this is an extra defence for absolute system paths.
		const BLOCKED_ABSOLUTE_PREFIXES = [
			'/Applications/',          // macOS applications
			'/System/',                // macOS system
			'/Library/',               // macOS system libraries
			'/usr/',                   // Unix system
			'/opt/',                   // Unix optional packages
			'/private/',               // macOS private namespace
			'C:\\Windows\\',           // Windows system (forward-slashed by VS Code)
			'C:\\Program Files\\',
			'C:\\Program Files (x86)\\',
		];
		if (BLOCKED_ABSOLUTE_PREFIXES.some(p => filePath.startsWith(p) || filePath.startsWith(p.replace(/\\/g, '/')))) return false;

		// Internal VS Code path segments that can appear inside a workspace path
		// when a file is opened via extension API (e.g. walkthrough, welcome page)
		if (BLOCKED_PATH_PREFIXES.some(seg => filePath.includes(seg))) return false;

		return true;
	}

	/** Store a file's content for context-only use, respecting size caps */
	private _addContextFile(uriStr: string, content: string): void {
		if (content.length > GRCEngineService._MAX_CONTEXT_FILE_SIZE) return;
		if (this._contextFiles.size >= GRCEngineService._MAX_CONTEXT_FILES && !this._contextFiles.has(uriStr)) {
			// Evict oldest entry
			const firstKey = this._contextFiles.keys().next().value;
			if (firstKey) this._contextFiles.delete(firstKey);
		}
		this._contextFiles.set(uriStr, content);
	}


	// \u2500\u2500\u2500 AI Ignore Suggestions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public async generateIgnoreSuggestions(): Promise<IIgnoreSuggestion[]> {
		// Gather project metadata (shallow scan, depth 2)
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) return [];

		const rootUri = folders[0].uri;
		const fileTree: string[] = [];
		const configFiles: string[] = [];
		let packageJsonDeps = '';
		let gitignorePatterns = '';
		let tsconfigInfo = '';

		await this._gatherProjectMetadata(rootUri, 0, fileTree, configFiles);

		// Try reading key config files
		try {
			const pkg = await this._fileService.readFile(URI.joinPath(rootUri, 'package.json'));
			const pkgJson = JSON.parse(pkg.value.toString());
			const devDeps = Object.keys(pkgJson.devDependencies || {}).join(', ');
			const deps = Object.keys(pkgJson.dependencies || {}).join(', ');
			packageJsonDeps = `devDependencies: ${devDeps || 'none'}\ndependencies: ${deps || 'none'}`;
		} catch { /* no package.json */ }

		try {
			const gi = await this._fileService.readFile(URI.joinPath(rootUri, '.gitignore'));
			gitignorePatterns = gi.value.toString().split('\n').filter(l => l.trim() && !l.startsWith('#')).join(', ');
		} catch { /* no .gitignore */ }

		try {
			const tsconfig = await this._fileService.readFile(URI.joinPath(rootUri, 'tsconfig.json'));
			const tsJson = JSON.parse(tsconfig.value.toString());
			tsconfigInfo = `outDir: ${tsJson.compilerOptions?.outDir || 'N/A'}, rootDir: ${tsJson.compilerOptions?.rootDir || 'N/A'}`;
		} catch { /* no tsconfig */ }

		const prompt = `You are an AI assistant for a GRC (Governance, Risk, Compliance) IDE that scans code for security and compliance violations.

Analyze this project structure and suggest which files/patterns should be:
- "ignore": Fully excluded from compliance scanning (build artifacts, vendor, generated code, binary assets)
- "context-only": Excluded from scanning but kept as AI context so the AI understands tests, mocks, and configs

PROJECT FILE TREE (top 2 levels):
${fileTree.slice(0, 100).join('\n')}

CONFIG FILES FOUND: ${configFiles.join(', ') || 'none'}

${packageJsonDeps ? `PACKAGE.JSON:\n${packageJsonDeps}\n` : ''}
${gitignorePatterns ? `GITIGNORE PATTERNS: ${gitignorePatterns}\n` : ''}
${tsconfigInfo ? `TSCONFIG: ${tsconfigInfo}\n` : ''}
ALREADY FULLY IGNORED: ${this._ignorePatterns.join(', ') || 'none'}
ALREADY CONTEXT-ONLY: ${this._contextOnlyPatterns.join(', ') || 'none'}

Return ONLY valid JSON \u2014 an array of suggestions. Do NOT suggest patterns already in the ignore or context-only lists:
[
  {
    "pattern": "glob pattern",
    "reason": "brief explanation",
    "mode": "ignore" or "context-only",
    "confidence": "high" or "medium" or "low",
    "category": "build-output" or "test-files" or "config" or "generated" or "vendor" or "other"
  }
]

Be specific to this project. Suggest 3-8 patterns. Return ONLY valid JSON array.`;

		const response = await this.contractReasonService.sendOneShotQuery(prompt);
		if (!response) return [];

		try {
			let jsonStr = response.trim();
			const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
			if (jsonMatch) jsonStr = jsonMatch[1].trim();
			const suggestions: IIgnoreSuggestion[] = JSON.parse(jsonStr);
			return suggestions.filter(s => s.pattern && s.reason && s.mode);
		} catch (e) {
			console.error('[GRCEngine] Failed to parse ignore suggestions:', e);
			return [];
		}
	}

	private async _gatherProjectMetadata(
		dirUri: URI, depth: number,
		fileTree: string[], configFiles: string[]
	): Promise<void> {
		if (depth > 2) return;
		try {
			const stat = await this._fileService.resolve(dirUri);
			if (!stat.children) return;
			const indent = '  '.repeat(depth);
			for (const child of stat.children) {
				if (child.name.startsWith('.') && child.name !== '.gitignore') continue;
				if (GRCEngineService._SKIP_DIRS.has(child.name)) {
					fileTree.push(`${indent}${child.name}/ (skipped)`);
					continue;
				}
				if (child.isDirectory) {
					fileTree.push(`${indent}${child.name}/`);
					await this._gatherProjectMetadata(child.resource, depth + 1, fileTree, configFiles);
				} else {
					fileTree.push(`${indent}${child.name}`);
					const name = child.name.toLowerCase();
					if (name.includes('config') || name.includes('.rc') || name === 'jest.config.ts'
						|| name === 'vite.config.ts' || name === 'webpack.config.js'
						|| name === '.eslintrc.js' || name === 'babel.config.js'
						|| name.endsWith('.config.js') || name.endsWith('.config.ts')) {
						configFiles.push(child.name);
					}
				}
			}
		} catch { /* unreadable */ }
	}


	// \u2500\u2500\u2500 Cross-File Impact \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public getImportedByMap(): ReadonlyMap<string, readonly string[]> {
		const result = new Map<string, readonly string[]>();
		for (const [key, set] of this._importedBy) {
			result.set(key, Array.from(set));
		}
		return result;
	}

	public getImpactChain(fileUri: URI, maxDepth: number = 3): IImpactNode | undefined {
		// Strip any extension \u2014 import map keys are stored without extensions, universally
		const basePath = fileUri.path.replace(/\.[^/.]+$/, '');

		// Collect direct dependents \u2014 also match package-style keys that end with the same suffix
		const dependentUris = new Set<string>();
		for (const [key, importers] of this._importedBy) {
			if (key === basePath || key.startsWith(basePath + '/') || basePath.endsWith('/' + key)) {
				for (const imp of importers) dependentUris.add(imp);
			}
		}

		if (dependentUris.size === 0) return undefined;

		const fileKey = fileUri.toString();
		const results = this._resultsByFile.get(fileKey) || [];
		const hasBreaking = results.some(r => r.isBreakingChange);

		const rootNode: IImpactNode = {
			fileUri: fileKey,
			fileName: fileUri.path.split('/').pop() || 'unknown',
			filePath: fileUri.path,
			violations: results.length,
			hasBreakingChanges: hasBreaking,
			dependents: [],
		};

		// pathVisited tracks the current root\u2192leaf path only, so a shared dependency
		// (imported by multiple parents) appears under each parent rather than being
		// silently dropped after its first occurrence.
		const pathVisited = new Set<string>([fileKey]);
		this._buildImpactTree(rootNode, pathVisited, maxDepth, 1);
		return rootNode;
	}

	/**
	 * Attempt to resolve a trace file reference (which may be a relative path,
	 * basename, or absolute path) to a full URI string matching a key in _resultsByFile.
	 */
	private _resolveTraceFileKey(traceFile: string, contextUri: URI): string | undefined {
		// Direct match first (absolute path or exact URI string)
		for (const key of this._resultsByFile.keys()) {
			if (key.endsWith(traceFile) || key.includes(traceFile.replace(/^\.\//, ''))) {
				return key;
			}
		}

		// Try resolving relative path against the context file's directory
		if (traceFile.startsWith('./') || traceFile.startsWith('../')) {
			try {
				const dir = contextUri.path.substring(0, contextUri.path.lastIndexOf('/'));
				const resolved = dir + '/' + traceFile.replace(/^\.\//, '');
				for (const key of this._resultsByFile.keys()) {
					if (key.includes(resolved) || key.endsWith(resolved)) {
						return key;
					}
				}
			} catch { /* resolution failed \u2014 skip */ }
		}

		return undefined;
	}

	private _buildImpactTree(node: IImpactNode, pathVisited: Set<string>, maxDepth: number, currentDepth: number): void {
		if (currentDepth >= maxDepth) return;

		// Strip any extension \u2014 works for all languages
		const nodePath = node.filePath.replace(/\.[^/.]+$/, '');
		const dependentUris = new Set<string>();
		for (const [key, importers] of this._importedBy) {
			if (key === nodePath || key.startsWith(nodePath + '/') || nodePath.endsWith('/' + key)) {
				for (const imp of importers) {
					if (!pathVisited.has(imp)) dependentUris.add(imp);
				}
			}
		}

		for (const depUriStr of dependentUris) {
			if (node.dependents.length >= 10) break; // cap per node

			const depUri = URI.parse(depUriStr);
			const depResults = this._resultsByFile.get(depUriStr) || [];
			const depNode: IImpactNode = {
				fileUri: depUriStr,
				fileName: depUri.path.split('/').pop() || 'unknown',
				filePath: depUri.path,
				violations: depResults.length,
				hasBreakingChanges: depResults.some(r => r.isBreakingChange),
				dependents: [],
			};

			// Clone pathVisited for this branch so siblings are independent;
			// only ancestors on the current root\u2192leaf path block re-entry (cycle guard).
			const branchVisited = new Set(pathVisited);
			branchVisited.add(depUriStr);
			this._buildImpactTree(depNode, branchVisited, maxDepth, currentDepth + 1);
			node.dependents.push(depNode);
		}
	}


	// \u2500\u2500\u2500 Workspace Scan \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private static readonly _SCANNABLE_EXT = new Set([
		// Modern
		'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
		'py', 'pyw', 'java', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx',
		'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'kts', 'scala', 'sc',
		'lua', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1',
		'yaml', 'yml', 'json', 'tf', 'hcl', 'toml',
		'sql', 'html', 'css', 'scss', 'less',
		// Firmware/embedded
		's', 'S', 'asm', 'inc',
		// Legacy enterprise
		'cbl', 'cob', 'cpy',          // COBOL
		'rpg', 'rpgle', 'sqlrpgle',    // RPG / IBM AS/400
		'abap',                         // SAP ABAP
		'f', 'f90', 'f95', 'f03', 'f08', 'for', // FORTRAN
		'pas', 'pp', 'dpr', 'dpk',     // Pascal / Delphi
		'bas', 'vb', 'vbs',            // VB6 / VBScript
		'adb', 'ads',                   // Ada
		'erl', 'hrl', 'ex', 'exs',     // Erlang / Elixir
		'zig',                          // Zig
		// Industrial/ICS
		'st', 'il', 'pou', 'fbd', 'sfc', 'ldr',  // IEC 61131-3
		'dbc', 'sym', 'ldf',           // CAN DBC / LIN
		'arxml',                        // AUTOSAR
		// Telecom
		'ttcn', 'ttcn3', 'asn', 'asn1', // TTCN-3 / ASN.1
		// DevOps/Infra
		'dockerfile', 'makefile', 'mk', // Dockerfile / Makefile
		'gradle', 'groovy',             // Gradle / Groovy
	]);

	private static readonly _SKIP_DIRS = new Set([
		'node_modules', '.git', 'dist', 'build', 'out',
		'.next', '__pycache__', '.cache', 'coverage', '.nyc_output',
		'vendor', 'Pods', '.idea', '.vscode',
		'.inverse',   // GRC config \u2014 never scan our own config files
	]);

	/**
	 * Extensions that make sense for AI GRC analysis.
	 * Excludes pure config/data formats (json, yaml, toml, sql, html, css)
	 * that produce LLM errors because the model can't map them to GRC rules.
	 */
	private static readonly _AI_SCANNABLE_EXT = new Set([
		// Modern languages \u2014 full AI analysis
		'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
		'py', 'pyw', 'java', 'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx',
		'cs', 'go', 'rs', 'rb', 'php', 'swift', 'kt', 'kts', 'scala', 'sc',
		'lua', 'sh', 'bash', 'zsh', 'fish', 'ps1',
		// Firmware/embedded \u2014 .ld excluded (linker scripts are declarative, not C)
		's', 'S', 'asm',
		// Industrial/ICS
		'st', 'il', 'pou', 'fbd', 'sfc',
		// Telecom
		'ttcn', 'ttcn3', 'asn', 'asn1',
		// Legacy enterprise \u2014 AI can reason about these even without structural analyzer
		'cbl', 'cob', 'cpy',           // COBOL
		'rpg', 'rpgle', 'sqlrpgle',     // RPG
		'abap',                          // SAP ABAP
		'f90', 'f95', 'f03', 'f08',     // FORTRAN
		'adb', 'ads',                    // Ada
		'erl', 'hrl',                    // Erlang
		'zig',                           // Zig
		// Automotive
		'arxml', 'dbc',                  // AUTOSAR / CAN DBC
		// DevOps
		'tf', 'hcl', 'groovy',          // Terraform / Gradle
	]);

	public async scanWorkspace(): Promise<void> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		for (const folder of folders) {
			await this._scanDir(folder.uri, 0);
		}
		this._lastWorkspaceScanTime = Date.now();
		this._onDidCheckComplete.fire(this.getAllResults());
		console.log(`[GRCEngine] Static scan complete: ${this.getAllResults().length} violations across ${this._resultsByFile.size} files`);

		// Trigger workspace-scope external tool scans (async, results arrive via setExternalResults)
		const externalWorkspaceRules = this._configLoader.getRules().filter(r =>
			r.enabled && r.type === 'external' && (r.check as any)?.scope === 'workspace'
		);
		if (externalWorkspaceRules.length > 0) {
			this.externalToolService.runWorkspaceScans(externalWorkspaceRules).catch(e =>
				console.error('[GRCEngine] Workspace external tool scan failed:', e)
			);
		}

		// Chain the AI scan \u2014 it will skip files whose content hash hasn't changed
		this.scanWorkspaceWithAI().catch(e => console.error('[GRCEngine] AI scan after workspace scan failed:', e));
	}


	/**
	 * Merge results from an external tool into the results cache for a specific file.
	 * Replaces any previous results for the given ruleId while preserving all others.
	 */
	public setExternalResults(fileUri: URI, ruleId: string, results: ICheckResult[]): void {
		const fileKey = fileUri.toString();
		const existing = this._resultsByFile.get(fileKey) ?? [];

		// Remove old results from this ruleId; keep everything else
		const filtered = existing.filter(r => r.ruleId !== ruleId);
		const merged = [...filtered, ...results];

		this._resultsByFile.set(fileKey, merged);
		this._onDidCheckComplete.fire(merged);

		console.log(`[GRCEngine] External results: ${results.length} violations from rule ${ruleId} in ${fileUri.path.split('/').pop()}`);
	}

	// \u2500\u2500\u2500 AI Workspace Scan \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public async scanWorkspaceWithAI(): Promise<void> {
		if (!this.contractReasonService.isAvailable) {
			console.log('[GRCEngine] AI scan skipped \u2014 contract reason service unavailable');
			return;
		}
		console.log('[GRCEngine] Starting workspace AI scan...');

		// Phase 1: Collect all scannable files (fast, no AI calls)
		const allFiles: { uri: URI; content: string }[] = [];
		const folders = this._workspaceContextService.getWorkspace().folders;
		for (const folder of folders) {
			await this._collectFilesForAI(folder.uri, 0, allFiles);
		}

		// Build allFileContents map for cross-file dependency context
		const allFileContents = new Map<string, string>();
		for (const f of allFiles) {
			allFileContents.set(f.uri.toString(), f.content);
		}

		// \u2500\u2500 Load C/C++ headers into CStructuralAnalyzer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		// Collect all .h and .hpp files and pass them to the CStructuralAnalyzer so
		// that void-returning functions declared in headers are known to the
		// missing-error-propagation detector (avoids false positives on HAL/BSP calls).
		const headerFiles = allFiles.filter(f => {
			const p = f.uri.path.toLowerCase();
			return p.endsWith('.h') || p.endsWith('.hpp');
		}).map(f => ({ path: f.uri.path, content: f.content }));

		if (headerFiles.length > 0) {
			const cAnalyzer = this._analyzers.get('c-structural');
			(cAnalyzer as any).loadHeaders?.(headerFiles);
		}

		// Phase 2: Risk-based prioritization \u2014 score each file and sort descending.
		// This ensures auth handlers, DB layers, and payment code get scanned first
		// even if they have zero static violations.
		const MAX_AI_FILES = 60;
		const scored = allFiles.map(f => ({
			...f,
			riskScore: this._computeRiskScore(f.uri, f.content, this._resultsByFile.get(f.uri.toString()) || []),
		}));
		scored.sort((a, b) => b.riskScore - a.riskScore);
		const filesToScan = scored.slice(0, MAX_AI_FILES);

		const highRiskCount = filesToScan.filter(f => f.riskScore > 50).length;
		console.log(`[GRCEngine] AI scan: ${filesToScan.length} files (${highRiskCount} high-risk, top score: ${filesToScan[0]?.riskScore ?? 0})`);

		// Notify scan tracker of all files we intend to process (with risk scores for UI)
		const riskScoreMap = new Map(filesToScan.map(f => [f.uri.toString(), f.riskScore]));
		this.contractReasonService.scanTrackerBeginScan(filesToScan.map(f => f.uri), riskScoreMap);

		// Phase 3: Process in small batches with cooldown to respect rate limits
		const BATCH_SIZE = 3;
		const BATCH_INTERVAL_MS = 5_000;
		let processed = 0;
		const contextFiles = this._contextFiles.size > 0 ? new Map(this._contextFiles) : undefined;
		const allRules = this._configLoader.getRules();

		for (let i = 0; i < filesToScan.length; i += BATCH_SIZE) {
			const batch = filesToScan.slice(i, i + BATCH_SIZE);

			await Promise.all(batch.map(({ uri, content, riskScore }) => {
				const cachedResults = this._resultsByFile.get(uri.toString()) || [];
				const nanoContext = this.projectAnalyzerService.getContextForFile(uri);
				return this.contractReasonService.analyzeFile(uri, content, cachedResults, allRules, nanoContext, contextFiles, allFileContents, riskScore);
			}));

			processed += batch.length;
			console.log(`[GRCEngine] AI scan progress: ${processed}/${filesToScan.length}`);

			if (i + BATCH_SIZE < filesToScan.length) {
				await new Promise<void>(r => setTimeout(r, BATCH_INTERVAL_MS));
			}
		}

		// Notify scan tracker that scan is complete
		this.contractReasonService.scanTrackerEndScan();
		console.log(`[GRCEngine] AI scan complete: ${processed} file(s) processed`);
	}

	// \u2500\u2500\u2500 Periodic AI Scan \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public get isPeriodicAIScanActive(): boolean {
		return this._periodicAIScanActive;
	}

	public startPeriodicAIScan(intervalMs: number = 120_000): void {
		if (this._periodicAIScanTimer) {
			clearInterval(this._periodicAIScanTimer);
		}
		this._periodicAIScanActive = true;
		this.contractReasonService.scanTrackerSetPeriodicState(true, intervalMs);
		console.log(`[GRCEngine] Periodic AI scan started (every ${intervalMs / 1000}s)`);

		this._periodicAIScanTimer = setInterval(() => {
			if (!this.contractReasonService.isAvailable) return;
			console.log('[GRCEngine] Periodic AI scan triggered');
			this.scanWorkspaceWithAI().catch(e =>
				console.error('[GRCEngine] Periodic AI scan failed:', e)
			);
		}, intervalMs);
	}

	public stopPeriodicAIScan(): void {
		if (this._periodicAIScanTimer) {
			clearInterval(this._periodicAIScanTimer);
			this._periodicAIScanTimer = undefined;
		}
		this._periodicAIScanActive = false;
		this.contractReasonService.scanTrackerSetPeriodicState(false);
		console.log('[GRCEngine] Periodic AI scan stopped');
	}


	/**
	 * Compute a risk score for a file based on its path, content signals,
	 * existing violations, and how many other files depend on it.
	 * Higher scores = higher priority for AI analysis.
	 */
	private _computeRiskScore(uri: URI, content: string, staticViolations: ICheckResult[]): number {
		let score = 0;
		const path = uri.path.toLowerCase();

		// \u2500\u2500 Tier 1: High-risk file roles (+30-40 each, capped at 80) \u2500\u2500\u2500\u2500\u2500\u2500
		const authRole     = /\b(auth|login|logout|session|token|credential|password|secret|jwt|oauth|saml|sso|mfa|2fa)\b/.test(path);
		const dataRole     = /\b(db|database|query|repository|repo|dao|model|schema|migration|store|storage)\b/.test(path);
		const paymentRole  = /\b(payment|billing|invoice|transaction|checkout|stripe|paypal|commerce)\b/.test(path);
		const cryptoRole   = /\b(crypto|encrypt|decrypt|hash|sign|verify|cipher|key|cert|pki|tls|ssl)\b/.test(path);
		const networkRole  = /\b(api|router|route|controller|endpoint|handler|gateway|proxy|middleware|server)\b/.test(path);
		const firmwareRole = /\b(isr|interrupt|hal|bsp|driver|peripheral|register|dma|uart|spi|i2c|can|adc|dac|pwm|gpio|nvic|rtos|task|scheduler)\b/.test(path);
		const safetyRole   = /\b(safety|failsafe|watchdog|plc|scada|modbus|profibus|dnp3|iec|interlock|shutdown)\b/.test(path);
		const infraRole    = /\b(terraform|ansible|dockerfile|k8s|kubernetes|deploy|pipeline|ci|cd|config|secret|vault)\b/.test(path);

		if (authRole)     score += 40;
		if (dataRole)     score += 35;
		if (paymentRole)  score += 40;
		if (cryptoRole)   score += 35;
		if (networkRole)  score += 25;
		if (firmwareRole) score += 40;
		if (safetyRole)   score += 45;
		if (infraRole)    score += 30;

		// Cap tier 1 at 80 to prevent runaway single-file scores
		score = Math.min(score, 80);

		// \u2500\u2500 Tier 2: Content signals (+10-50 each) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		if (/\beval\s*\(/.test(content))                    score += 35;
		if (/Function\s*\(/.test(content))                  score += 25;
		if (/innerHTML|dangerouslySetInnerHTML/.test(content)) score += 30;
		if (/child_process|exec\s*\(|spawn\s*\(/.test(content)) score += 35;
		if (/process\.env\b/.test(content))                 score += 20;
		if (/\b(password|passwd|secret|apikey|api_key)\s*[=:]/i.test(content)) score += 30;
		if (/\b(private_key|privatekey|signing_key)\b/i.test(content)) score += 40;
		if (/\bSELECT\b.*\bFROM\b/i.test(content))         score += 15;
		if (/\bDELETE\b.*\bFROM\b/i.test(content))         score += 25;
		if (/\bDROP\b.*\bTABLE\b/i.test(content))          score += 40;
		// Firmware-specific content signals
		if (/\b(NVIC_|SCB_|RCC_|GPIO_|USART_|SPI_|I2C_|TIM_|ADC_|DMA_)\w+\s*[=(]/.test(content)) score += 25;
		if (/\b(__disable_irq|__enable_irq|taskENTER_CRITICAL|taskEXIT_CRITICAL)\b/.test(content)) score += 30;
		if (/\b(volatile|__IO|__IM|__OM)\s+\w+\s*\*/.test(content)) score += 20;
		if (/\b(memset|memcpy|memmove)\s*\(/.test(content)) score += 15;
		if (/\b(strcpy|strcat|sprintf|gets)\s*\(/.test(content)) score += 30;
		// Industrial/SCADA signals
		if (/\b(modbus|dnp3|profibus|opcua|opc.ua|bacnet)\b/i.test(content)) score += 35;
		if (/\b(setpoint|pid_|plc_|hmi_|scada_)\b/i.test(content)) score += 30;
		// Telecom signals
		if (/\b(sip_|sip\.|rtp_|rtp\.|diameter_|radius_|gtp_|3gpp)\b/i.test(content)) score += 30;
		if (/\b(imsi|imei|msisdn|suci|supi)\b/i.test(content)) score += 35;

		// \u2500\u2500 Tier 3: Violation-based amplification \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const errorViolations = staticViolations.filter(r => toDisplaySeverity(r.severity) === 'error');
		const aiHighConf      = staticViolations.filter(r => r.checkSource === 'ai' && r.aiConfidence === 'high');
		const uniqueRulesFired = new Set(staticViolations.map(r => r.ruleId)).size;

		score += errorViolations.length * 20;      // each error violation adds significant weight
		score += aiHighConf.length * 30;           // prior high-confidence AI finds = re-examine
		score += Math.min(uniqueRulesFired * 8, 40); // more rules fired = broader surface area

		// \u2500\u2500 Tier 4: Fan-in (imported by many files = high blast radius) \u2500
		const basePath = uri.path.replace(/\.[^/.]+$/, '');
		for (const [key, importers] of this._importedBy) {
			if (key === basePath || key.endsWith('/' + (basePath.split('/').pop() ?? ''))) {
				score += Math.min(importers.size * 8, 50);
				break;
			}
		}

		return score;
	}

	/**
	 * Recursively collect all scannable files and their content for AI analysis.
	 * Does NOT trigger any AI calls \u2014 just builds the file list.
	 */
	private async _collectFilesForAI(
		dirUri: URI,
		depth: number,
		out: { uri: URI; content: string }[]
	): Promise<void> {
		if (depth > 12) return;
		try {
			const stat = await this._fileService.resolve(dirUri);
			if (!stat.children) return;
			for (const child of stat.children) {
				if (this._matchesIgnore(child.resource)) continue;
				if (child.isDirectory) {
					if (GRCEngineService._SKIP_DIRS.has(child.name)) continue;
					// Never recurse into .inverse directory (GRC config, not user code)
					if (child.name === '.inverse') continue;
					await this._collectFilesForAI(child.resource, depth + 1, out);
				} else {
					// Use AI-specific extension list \u2014 also handle extensionless files (Dockerfile, Makefile)
					const nameLower = child.name.toLowerCase();
					const ext = child.name.includes('.') ? (child.name.split('.').pop()?.toLowerCase() ?? '') : nameLower;
					if (!GRCEngineService._AI_SCANNABLE_EXT.has(ext)) continue;
					try {
						const file = await this._fileService.readFile(child.resource);
						const content = file.value.toString();
						const uriStr = child.resource.toString();

						// Build reverse import map and content cache during collection
						this._updateImportMap(child.resource, content);
						this._cacheFileContent(uriStr, content);

						// Context-only files: store for AI context but don't queue for scanning
						if (this._matchesContextOnly(child.resource)) {
							this._addContextFile(uriStr, content);
							continue;
						}

						// Run static analysis if we haven't seen this file yet
						if (!this._resultsByFile.has(uriStr)) {
							this.evaluateFileContent(child.resource, content);
						}

						out.push({ uri: child.resource, content });
					} catch { /* unreadable \u2014 skip */ }
				}
			}
		} catch { /* unreadable dir \u2014 skip */ }
	}


	// \u2500\u2500\u2500 Import Graph & Cross-File Triggers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Parse the imports of `fileUri` from `content` using the `ImportPatternRegistry`
	 * and update `_importedBy`. Fully language-agnostic \u2014 pattern definitions live
	 * in `importPatternRegistry.ts` and `.inverse/import-patterns.json`.
	 */
	private _updateImportMap(fileUri: URI, content: string): void {
		const importerStr = fileUri.toString();
		const dirPath = fileUri.path.replace(/\/[^/]+$/, '');
		const ext = fileUri.path.split('.').pop()?.toLowerCase() ?? '';

		// Remove stale entries for this importer
		for (const [, importers] of this._importedBy) {
			importers.delete(importerStr);
		}

		const patterns = this._importPatternRegistry.getPatterns(ext);
		for (const pattern of patterns) {
			const re = new RegExp(pattern.regex, 'gm');
			let m: RegExpExecArray | null;
			while ((m = re.exec(content)) !== null) {
				let rawCapture = m[pattern.group];
				if (!rawCapture) continue;

				// Skip if it matches an external/stdlib prefix
				if (pattern.externalPrefixes?.some(p => rawCapture.startsWith(p))) continue;

				// Normalise the captured path to a resolvable string
				let rawPath: string;
				if (pattern.resolution === 'package-to-path') {
					// e.g. com.example.Auth \u2192 com/example/Auth (no leading ./)
					// stored as a package key; lookup matches with endsWith in getImpactChain
					rawPath = rawCapture.replace(/\./g, '/');
				} else {
					// 'relative' \u2014 ensure it starts with ./ or ../
					rawPath = rawCapture.startsWith('.') ? rawCapture : './' + rawCapture;
				}

				const resolved = this._resolveRelativePath(dirPath, rawPath);
				if (!resolved) continue;
				if (!this._importedBy.has(resolved)) this._importedBy.set(resolved, new Set());
				this._importedBy.get(resolved)!.add(importerStr);
			}
		}

		// Keep the contract reason service's copy in sync so save-triggered analyses
		// always see an up-to-date reverse-import graph.
		this.contractReasonService.setImportedByMap(this.getImportedByMap());
	}

	/**
	 * Walk all workspace files and populate `_importedBy` immediately at startup.
	 * Import parsing only \u2014 no AI, no pattern evaluation, no diagnostics.
	 * Covers all supported languages so cross-file impact works right after restart.
	 */
	private async _bootstrapImportMap(): Promise<void> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		let count = 0;
		for (const folder of folders) {
			count += await this._walkForImports(folder.uri, 0);
		}
		console.log(`[GRCEngine] Import map bootstrapped: ${this._importedBy.size} unique import targets from ${count} files`);
		// Share the populated map with the contract reason service so it can build
		// multi-hop dependency context without a circular import dependency.
		this.contractReasonService.setImportedByMap(this.getImportedByMap());
		// Fire onDidCheckComplete so the Cross-File Impact view refreshes immediately
		// after the import map is populated (it was empty at startup when the view first rendered).
		this._onDidCheckComplete.fire(this.getAllResults());
	}

	private async _walkForImports(dirUri: URI, depth: number): Promise<number> {
		if (depth > 12) return 0;
		let count = 0;
		try {
			const stat = await this._fileService.resolve(dirUri);
			if (!stat.children) return 0;
			for (const child of stat.children) {
				if (this._matchesIgnore(child.resource)) continue;
				if (child.isDirectory) {
					if (GRCEngineService._SKIP_DIRS.has(child.name)) continue;
					count += await this._walkForImports(child.resource, depth + 1);
				} else {
					const ext = child.name.includes('.') ? (child.name.split('.').pop()?.toLowerCase() ?? '') : child.name.toLowerCase();
					if (!GRCEngineService._SCANNABLE_EXT.has(ext)) continue;
					try {
						const file = await this._fileService.readFile(child.resource);
						this._updateImportMap(child.resource, file.value.toString());
						count++;
					} catch { /* unreadable \u2014 skip */ }
				}
			}
		} catch { /* unreadable dir \u2014 skip */ }
		return count;
	}

	/** Resolve a relative import path to a normalised absolute path (no extension). */
	private _resolveRelativePath(dirPath: string, importPath: string): string | null {
		let resolved = dirPath;
		for (const part of importPath.split('/')) {
			if (part === '.' || part === '') continue;
			if (part === '..') { resolved = resolved.replace(/\/[^/]+$/, ''); }
			else resolved = `${resolved}/${part}`;
		}
		// Strip extension so lookup is language-agnostic (.ts, .c, .py, .v, etc.)
		return resolved.replace(/\.[^/.]+$/, '');
	}

	// \u2500\u2500\u2500 Static Workspace Scan \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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
					const ext = child.name.includes('.') ? (child.name.split('.').pop()?.toLowerCase() ?? '') : child.name.toLowerCase();
					if (!GRCEngineService._SCANNABLE_EXT.has(ext)) continue;
					try {
						const file = await this._fileService.readFile(child.resource);
						const content = file.value.toString();
						const uriStr = child.resource.toString();

						// Context-only files: read content for AI context but skip violation scanning
						if (this._matchesContextOnly(child.resource)) {
							this._addContextFile(uriStr, content);
							this._updateImportMap(child.resource, content);
							continue;
						}

						// Always cache content for cross-file AI context
						this._cacheFileContent(uriStr, content);

						// Skip files already evaluated by evaluateDocument() (open editor files).
						// Their results are already in _resultsByFile; re-running would produce
						// a duplicate onDidCheckComplete fire with identical results.
						if (this._resultsByFile.has(uriStr)) continue;

						this.evaluateFileContent(child.resource, content);
					} catch { /* unreadable file \u2014 skip */ }
				}
			}
		} catch { /* directory unreadable \u2014 skip */ }
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
		.replace(/\*/g, '[^/]*')              // * \u2192 any non-separator
		.replace(/\?/g, '[^/]')              // ? \u2192 single non-separator
		.replace(/\x00/g, '.*');             // ** \u2192 any sequence
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

