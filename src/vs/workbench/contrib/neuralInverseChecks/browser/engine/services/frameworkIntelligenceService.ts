/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Framework Intelligence Service
 *
 * A **separate AI system** that makes GRC checks smarter without touching
 * framework definitions. Frameworks stay pure pattern-based (regex, AST,
 * dataflow, import-graph). This service operates alongside them.
 *
 * ## How It Works
 *
 * **Phase 1 — Framework Comprehension (on import)**
 *
 * When a framework is loaded, this service sends ALL its rules to the LLM
 * with a comprehension prompt. The LLM builds an understanding of:
 * - What each rule is trying to enforce
 * - Edge cases that patterns might miss
 * - Relationships between rules
 * - Common violation patterns
 *
 * This understanding is cached per framework ID + version.
 *
 * **Phase 2 — Intelligent Analysis (on file save)**
 *
 * After pattern checks run, this service receives the code + pattern results
 * and uses the framework understanding to:
 * - Find violations that patterns missed
 * - Flag likely false positives
 * - Add contextual explanations
 *
 * ## Void LLM API Reference
 *
 * This service calls Void's LLM module without modifying Void core:
 *
 * ```typescript
 * import { ILLMMessageService } from '../../void/common/sendLLMMessageService.js';
 * import { IVoidSettingsService } from '../../void/common/voidSettingsService.js';
 *
 * // Get user's configured model (Checks-specific with Chat fallback):
 * const modelSelection = this.voidSettingsService.state.modelSelectionOfFeature['Checks']
 *     ?? this.voidSettingsService.state.modelSelectionOfFeature['Chat'];
 *
 * // Call LLM:
 * this.llmMessageService.sendLLMMessage({
 *     messagesType: 'chatMessages',
 *     messages: [...],
 *     modelSelection,
 *     onFinalMessage: ({ fullText }) => { ... },
 *     ...
 * });
 * ```
 *
 * ModelSelection = { providerName: ProviderName, modelName: string }
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { URI } from '../../../../../../base/common/uri.js';
import { ICheckResult, IGRCRule, toDisplaySeverity } from '../types/grcTypes.js';
import { IFrameworkRegistry, ILoadedFramework } from '../framework/frameworkRegistry.js';
import { ILLMMessageService } from '../../../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../../../../void/common/voidSettingsService.js';
import { LLMChatMessage } from '../../../../void/common/sendLLMMessageTypes.js';
import { INanoAgentContext, IProjectAnalyzerService } from '../../nanoAgents/projectAnalyzerService.js';
import { IAccessibilitySignalService, AccessibilitySignal } from '../../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';



// ─── Service Interface ───────────────────────────────────────────────────────

export const IFrameworkIntelligenceService = createDecorator<IFrameworkIntelligenceService>('frameworkIntelligenceService');

/**
 * Intelligence results from AI analysis.
 */
export interface IntelligenceResult {
	/** Violations the AI found that patterns missed */
	additionalViolations: ICheckResult[];
	/** Pattern results the AI thinks are false positives */
	falsePositiveFlags: { ruleId: string; line: number; reason: string }[];
	/**
	 * AI enrichments for EXISTING pattern violations.
	 * Maps ruleId:line to AI-generated explanation, fix, and confidence.
	 * These get applied to the existing ICheckResult objects.
	 */
	enrichments: Map<string, {
		aiExplanation: string;
		aiConfidence: 'high' | 'medium' | 'low';
	}>;
	/** File that was analyzed */
	fileUri: URI;
}

/**
 * Cached framework comprehension.
 */
interface FrameworkContext {
	frameworkId: string;
	version: string;
	/** LLM's structured understanding of the framework */
	understanding: string;
	/** When the comprehension was created */
	timestamp: number;
}


export interface IFrameworkIntelligenceService {
	readonly _serviceBrand: undefined;

	/** Whether intelligence is available (model configured + framework comprehended + enabled) */
	readonly isAvailable: boolean;

	/** Whether the hybrid intelligence system is enabled (defaults to OFF) */
	readonly isEnabled: boolean;

	/** Enable or disable the hybrid intelligence system */
	setEnabled(enabled: boolean): void;

	/** Event fired when enabled state changes */
	readonly onDidEnabledChange: Event<boolean>;

	/** Comprehend a framework — called on import/load */
	comprehendFramework(framework: ILoadedFramework): Promise<void>;

	/** Get intelligence-enhanced results for a file */
	analyzeFile(
		fileUri: URI,
		fileContent: string,
		patternResults: ICheckResult[],
		rules: IGRCRule[],
		context?: INanoAgentContext
	): Promise<IntelligenceResult | undefined>;

	/** Event fired when intelligence results are ready */
	readonly onDidIntelligenceResultsReady: Event<IntelligenceResult>;
}


// ─── Implementation ──────────────────────────────────────────────────────────

export class FrameworkIntelligenceService extends Disposable implements IFrameworkIntelligenceService {
	declare readonly _serviceBrand: undefined;

	/** Storage key for persisting framework comprehension contexts across restarts */
	private static readonly COMPREHENSION_STORAGE_KEY = 'grc.intelligenceComprehensions';

	/** Storage key for persisting per-file content hashes — skip LLM when content unchanged */
	private static readonly FILE_HASH_STORAGE_KEY = 'grc.fileContentHashes';

	/** Persisted content hashes from previous sessions: fileUri → hash */
	private _persistedHashes = new Map<string, string>();

	/** Cached framework comprehension contexts */
	private readonly _frameworkContexts = new Map<string, FrameworkContext>();

	/** Currently running analysis requests (prevent duplicates) */
	private readonly _runningAnalyses = new Set<string>();

	/** Cached analysis results per file hash (LRU) */
	private readonly _resultCache = new Map<string, { result: IntelligenceResult; hash: string }>();

	/** Maximum cached analysis entries */
	private static readonly MAX_CACHE = 50;

	private readonly _onDidIntelligenceResultsReady = this._register(new Emitter<IntelligenceResult>());
	public readonly onDidIntelligenceResultsReady = this._onDidIntelligenceResultsReady.event;

	/** Hybrid intelligence enabled state — auto-enables when model is configured */
	private _enabled = false;
	private readonly _onDidEnabledChange = this._register(new Emitter<boolean>());
	public readonly onDidEnabledChange = this._onDidEnabledChange.event;

	constructor(
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IFrameworkRegistry private readonly frameworkRegistry: IFrameworkRegistry,
		@IProjectAnalyzerService private readonly projectAnalyzerService: IProjectAnalyzerService,
		@IAccessibilitySignalService private readonly accessibilitySignalService: IAccessibilitySignalService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		// Restore framework comprehensions and file hashes from previous session.
		// Prevents re-running LLM calls on every IDE restart.
		this._loadPersistedComprehensions();
		this._loadPersistedHashes();

		// Auto-comprehend when frameworks change (only if enabled)
		this._register(this.frameworkRegistry.onDidFrameworksChange(() => {
			if (this._enabled) {
				this._comprehendAllFrameworks();
			}
		}));

		// Auto-enable/disable when model settings change
		this._register(this.voidSettingsService.onDidChangeState(() => {
			this._autoToggleBasedOnModel();
		}));

		// Check if we should auto-enable on startup
		this.voidSettingsService.waitForInitState.then(() => {
			this._autoToggleBasedOnModel();
		});

		console.log('[FrameworkIntelligence] Service initialized (auto-enables when Checks or Chat model is configured)');
	}

	/**
	 * Load framework comprehension contexts from workspace storage.
	 * Populated by previous sessions — skips LLM calls for already-comprehended frameworks.
	 */
	private _loadPersistedComprehensions(): void {
		try {
			const stored = this.storageService.get(
				FrameworkIntelligenceService.COMPREHENSION_STORAGE_KEY,
				StorageScope.WORKSPACE
			);
			if (!stored) return;

			const contexts: FrameworkContext[] = JSON.parse(stored);
			for (const ctx of contexts) {
				const key = `${ctx.frameworkId}:${ctx.version}`;
				this._frameworkContexts.set(key, ctx);
			}
			console.log(`[FrameworkIntelligence] Restored ${contexts.length} framework comprehension(s) from storage`);
		} catch (e) {
			console.error('[FrameworkIntelligence] Failed to load persisted comprehensions:', e);
		}
	}

	private _loadPersistedHashes(): void {
		try {
			const stored = this.storageService.get(FrameworkIntelligenceService.FILE_HASH_STORAGE_KEY, StorageScope.WORKSPACE);
			if (!stored) return;
			const entries: [string, string][] = JSON.parse(stored);
			this._persistedHashes = new Map(entries);
			console.log(`[FrameworkIntelligence] Restored content hashes for ${this._persistedHashes.size} file(s)`);
		} catch (e) {
			console.error('[FrameworkIntelligence] Failed to load persisted file hashes:', e);
		}
	}

	private _savePersistedHashes(): void {
		try {
			const entries = Array.from(this._persistedHashes.entries());
			this.storageService.store(
				FrameworkIntelligenceService.FILE_HASH_STORAGE_KEY,
				JSON.stringify(entries),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
		} catch (e) {
			console.error('[FrameworkIntelligence] Failed to persist file hashes:', e);
		}
	}

	/**
	 * Persist all framework comprehension contexts to workspace storage.
	 * Called after each successful comprehension to ensure next restart is free.
	 */
	private _saveComprehensions(): void {
		try {
			const contexts = Array.from(this._frameworkContexts.values());
			this.storageService.store(
				FrameworkIntelligenceService.COMPREHENSION_STORAGE_KEY,
				JSON.stringify(contexts),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
		} catch (e) {
			console.error('[FrameworkIntelligence] Failed to persist comprehensions:', e);
		}
	}

	/**
	 * Automatically enable/disable intelligence based on whether
	 * a Checks or Chat model is configured.
	 */
	private _autoToggleBasedOnModel(): void {
		const modelSelection = this._getModelSelection();
		const shouldBeEnabled = !!modelSelection;

		if (shouldBeEnabled && !this._enabled) {
			this.setEnabled(true);
		} else if (!shouldBeEnabled && this._enabled) {
			this.setEnabled(false);
		}
	}


	// ─── Availability & Toggle ──────────────────────────────────────

	public get isEnabled(): boolean {
		return this._enabled;
	}

	public setEnabled(enabled: boolean): void {
		if (this._enabled === enabled) return;
		this._enabled = enabled;
		this._onDidEnabledChange.fire(enabled);

		if (enabled) {
			console.log('[FrameworkIntelligence] Hybrid Intelligence ENABLED');
			// Comprehend frameworks now that we're enabled
			this._comprehendAllFrameworks();
		} else {
			console.log('[FrameworkIntelligence] Hybrid Intelligence DISABLED');
		}
	}

	public get isAvailable(): boolean {
		if (!this._enabled) return false;
		const modelSelection = this._getModelSelection();
		return !!modelSelection;
	}

	/**
	 * Get the model selection for Checks — uses dedicated 'Checks' model if configured,
	 * otherwise falls back to 'Chat' model. Keeps Checks costs separate and controllable.
	 */
	private _getModelSelection() {
		return this.voidSettingsService.state.modelSelectionOfFeature['Checks']
			?? this.voidSettingsService.state.modelSelectionOfFeature['Chat'];
	}


	// ─── Phase 1: Framework Comprehension ────────────────────────────

	/**
	 * Comprehend all active frameworks.
	 */
	private async _comprehendAllFrameworks(): Promise<void> {
		const frameworks = this.frameworkRegistry.getActiveFrameworks();
		for (const fw of frameworks) {
			await this.comprehendFramework(fw);
		}
	}

	/**
	 * Send a framework's rules to the LLM for comprehension.
	 * The LLM builds an understanding of the framework's intent.
	 *
	 * Cached per framework ID + version — only re-comprehends on change.
	 */
	public async comprehendFramework(framework: ILoadedFramework): Promise<void> {
		const fwId = framework.definition.framework.id;
		const fwVersion = framework.definition.framework.version;
		const cacheKey = `${fwId}:${fwVersion}`;

		// Already comprehended this version
		if (this._frameworkContexts.has(cacheKey)) {
			return;
		}

		const modelSelection = this._getModelSelection();
		if (!modelSelection) {
			console.log('[FrameworkIntelligence] No model configured for Checks or Chat — skipping comprehension');
			return;
		}

		// Build the comprehension prompt
		const rulesDescription = framework.rules.map(r =>
			`- [${r.id}] "${r.message}" (severity: ${r.severity}, type: ${r.type})\n  Check: ${JSON.stringify(r.check).substring(0, 200)}`
		).join('\n');

		const systemPrompt = `You are a compliance framework analyst for critical and regulated software. Study the following framework rules and build a deep understanding of what this framework enforces.

Framework: ${framework.definition.framework.name} v${fwVersion}
Description: ${framework.definition.framework.description || 'N/A'}

Rules:
${rulesDescription}

For each rule, identify:
1. The core intent (what security/reliability issue it prevents)
2. Edge cases that pattern matching might miss
3. How this rule relates to other rules in the framework
4. Common code patterns that violate this rule but are hard to catch with regex/AST

Return your understanding as a structured analysis. Be concise but thorough. Focus on what patterns might MISS, not what they already catch.`;

		return new Promise<void>((resolve) => {
			this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: [{ role: 'user', content: systemPrompt }] as LLMChatMessage[],
				separateSystemMessage: undefined,
				chatMode: null,
				modelSelection,
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				onText: () => { },
				onFinalMessage: (params: { fullText: string }) => {
					this._frameworkContexts.set(cacheKey, {
						frameworkId: fwId,
						version: fwVersion,
						understanding: params.fullText,
						timestamp: Date.now()
					});
					// Persist so next restart doesn't re-call the LLM
					this._saveComprehensions();
					console.log(`[FrameworkIntelligence] Comprehended framework: ${fwId} v${fwVersion} (${params.fullText.length} chars)`);
					resolve();
				},
				onError: (err: { message: string }) => {
					console.error(`[FrameworkIntelligence] Comprehension failed for ${fwId}:`, err.message);
					resolve(); // Don't block on failure
				},
				onAbort: () => { resolve(); },
				logging: { loggingName: 'GRC-Intelligence-Comprehend' },
			});
		});
	}


	// ─── Phase 2: Intelligent File Analysis ──────────────────────────

	/**
	 * Analyze a file using the framework understanding + pattern results.
	 *
	 * Called after pattern checks complete (on file save, not keystroke).
	 * Returns additional violations, false positive flags, and explanations.
	 */
	public async analyzeFile(
		fileUri: URI,
		fileContent: string,
		patternResults: ICheckResult[],
		rules: IGRCRule[],
		context?: INanoAgentContext
	): Promise<IntelligenceResult | undefined> {
		if (!this.isAvailable) {
			return undefined;
		}

		// Prevent duplicate analysis for the same file
		const fileKey = fileUri.toString();
		if (this._runningAnalyses.has(fileKey)) {
			return undefined;
		}

		// Check content-based cache — same content means same violations
		const contentHash = this._simpleHash(fileContent);
		const cached = this._resultCache.get(fileKey);
		if (cached && cached.hash === contentHash) {
			// Fire the event so the engine and diagnostics pick up the cached violations.
			// Without this, re-opening a file with unchanged content would silently lose
			// its AI enrichments (the caller ignores the return value).
			this._onDidIntelligenceResultsReady.fire(cached.result);
			return cached.result;
		}

		// Check persisted hash from a previous session.
		// If the content hasn't changed since the last LLM run, violations are already
		// restored from disk by the workspace scan — skip the LLM entirely.
		if (this._persistedHashes.get(fileKey) === contentHash) {
			console.log(`[FrameworkIntelligence] Content unchanged for ${fileUri.path.split('/').pop()} — skipping LLM (use saved violations)`);
			return undefined;
		}

		this._runningAnalyses.add(fileKey);

		try {
			const result = await this._runAnalysis(fileUri, fileContent, patternResults, rules, context);
			if (result) {
				// Cache result in memory
				this._resultCache.set(fileKey, { result, hash: contentHash });

				// Evict old entries
				if (this._resultCache.size > FrameworkIntelligenceService.MAX_CACHE) {
					const firstKey = this._resultCache.keys().next().value;
					if (firstKey) this._resultCache.delete(firstKey);
				}

				// Persist content hash so future sessions skip the LLM for unchanged files
				this._persistedHashes.set(fileKey, contentHash);
				this._savePersistedHashes();

				// Persist AI violations securely to .inverse/audit disk storage
				await this.projectAnalyzerService.saveAuditData(fileUri, result.additionalViolations);

				this._onDidIntelligenceResultsReady.fire(result);
				// Test playing the new sound when an intelligence result is ready
				this.accessibilitySignalService.playSignal(AccessibilitySignal.neuralInverseTaskComplete);
			}
			return result;
		} finally {
			this._runningAnalyses.delete(fileKey);
		}
	}


	/**
	 * Run the actual LLM analysis.
	 */
	private async _runAnalysis(
		fileUri: URI,
		fileContent: string,
		patternResults: ICheckResult[],
		rules: IGRCRule[],
		context?: INanoAgentContext
	): Promise<IntelligenceResult | undefined> {
		const modelSelection = this._getModelSelection();
		if (!modelSelection) return undefined;

		// Gather framework understanding
		const allContexts = Array.from(this._frameworkContexts.values())
			.map(ctx => ctx.understanding)
			.join('\n\n---\n\n');

		// Extract functions from the file for function-level analysis
		const functions = this._extractFunctions(fileContent);

		// Get file extension for language hint
		const ext = fileUri.path.split('.').pop() || 'ts';
		const fileName = fileUri.path.split('/').pop() || 'unknown';

		// If we extracted functions, analyze each individually with relevant rules
		if (functions.length > 0) {
			console.log(`[FrameworkIntelligence] Analyzing ${functions.length} functions in ${fileName}`);

			// Analyze functions concurrently (max 3 at a time)
			const allResults: (IntelligenceResult | undefined)[] = [];
			const concurrencyLimit = 3;

			for (let i = 0; i < functions.length; i += concurrencyLimit) {
				const batch = functions.slice(i, i + concurrencyLimit);
				const batchResults = await Promise.all(
					batch.map(fn => {
						// Get pattern results that fall within this function's line range
						const fnPatternResults = patternResults.filter(
							r => r.line >= fn.startLine && r.line <= fn.endLine
						);

						// Route relevant rules based on function content patterns
						const relevantRules = this._getRelevantRules(fn, rules, context);

						console.log(`[FrameworkIntelligence] Analyzing function: ${fn.name} (lines ${fn.startLine}-${fn.endLine}, ${relevantRules.length} rules)`);

						return this._analyzeFunctionChunk(
							fileUri, fn, ext, fnPatternResults, relevantRules, allContexts, modelSelection
						);
					})
				);
				allResults.push(...batchResults);
			}

			// Merge all function-level results into one file-level result
			return this._mergeResults(allResults, fileUri);
		}

		// Fallback: analyze the whole file if no functions were extracted
		return this._analyzeWholeFile(
			fileUri, fileContent, ext, patternResults, rules, allContexts, modelSelection
		);
	}


	// ─── Function-Level Analysis ────────────────────────────────────

	/**
	 * Represents a function/method/arrow extracted from source code.
	 */
	private _extractFunctions(fileContent: string): Array<{
		name: string;
		startLine: number;
		endLine: number;
		code: string;
	}> {
		const functions: Array<{ name: string; startLine: number; endLine: number; code: string }> = [];
		const lines = fileContent.split('\n');

		// Match common function patterns: function decl, method, arrow, exports
		const fnPatterns = [
			/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
			/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\(|function)/,
			/^\s*(?:public|private|protected|static|async|\s)*\s+(\w+)\s*\([^)]*\)\s*[:{]/,
			/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?\(.*\)\s*=>/,
		];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			let fnName: string | null = null;

			for (const pattern of fnPatterns) {
				const match = line.match(pattern);
				if (match) {
					fnName = match[1] || `anonymous_L${i + 1}`;
					break;
				}
			}

			if (fnName) {
				// Find the end of this function by tracking brace depth
				let braceDepth = 0;
				let foundOpen = false;
				let endLine = i;

				for (let j = i; j < lines.length; j++) {
					for (const ch of lines[j]) {
						if (ch === '{') { braceDepth++; foundOpen = true; }
						if (ch === '}') { braceDepth--; }
					}
					if (foundOpen && braceDepth <= 0) {
						endLine = j;
						break;
					}
					if (j === lines.length - 1) {
						endLine = j;
					}
				}

				// Only include functions with meaningful body (>2 lines)
				if (endLine - i >= 2) {
					functions.push({
						name: fnName,
						startLine: i + 1, // 1-indexed
						endLine: endLine + 1,
						code: lines.slice(i, endLine + 1).join('\n'),
					});
				}

				// Skip past this function body
				i = endLine;
			}
		}

		return functions;
	}

	/**
	 * Route relevant rules to a function based on its content patterns.
	 * Instead of sending ALL rules to AI for every function, we select
	 * rules that are likely relevant based on what the function does.
	 */
	private _getRelevantRules(
		fn: { name: string; code: string },
		allRules: IGRCRule[],
		context?: INanoAgentContext
	): IGRCRule[] {
		const code = fn.code.toLowerCase();
		const relevant: IGRCRule[] = [];

		for (const rule of allRules) {
			if (!rule.enabled) continue;

			// Always include critical/blocker rules
			if (rule.severity === 'blocker' || rule.severity === 'critical') {
				relevant.push(rule);
				continue;
			}

			// Route by tags or content analysis
			const tags = rule.tags || [];
			const isNetworkRelated = tags.some(t => ['network', 'authentication', 'api'].includes(t))
				|| code.includes('fetch') || code.includes('axios') || code.includes('http')
				|| code.includes('req.') || code.includes('res.');

			const isCryptoRelated = tags.some(t => ['crypto', 'encryption'].includes(t))
				|| code.includes('crypto') || code.includes('encrypt') || code.includes('hash');

			const isAuthRelated = tags.some(t => ['auth', 'authentication', 'credentials', 'secrets'].includes(t))
				|| code.includes('token') || code.includes('password') || code.includes('secret')
				|| code.includes('apikey') || code.includes('api_key');

			const isDbRelated = tags.some(t => ['sql', 'database', 'sql-injection'].includes(t))
				|| code.includes('query') || code.includes('execute') || code.includes('sql');

			const isErrorHandling = tags.some(t => ['error-handling', 'async'].includes(t))
				|| code.includes('async') || code.includes('try') || code.includes('catch');

			// Also use nano agent context if available
			const ctxRelevant = context && context.capabilities && (
				(context.capabilities.hasNetwork && isNetworkRelated) ||
				(context.capabilities.hasCrypto && isCryptoRelated) ||
				(context.capabilities.hasAuth && isAuthRelated)
			);

			if (isNetworkRelated || isCryptoRelated || isAuthRelated || isDbRelated || isErrorHandling || ctxRelevant) {
				relevant.push(rule);
			}
		}

		// If very few rules matched, include all (better safe than sorry)
		if (relevant.length < 3) {
			return allRules.filter(r => r.enabled);
		}

		return relevant;
	}

	/**
	 * Analyze a single function chunk with AI, using only relevant rules.
	 */
	private async _analyzeFunctionChunk(
		fileUri: URI,
		fn: { name: string; startLine: number; endLine: number; code: string },
		ext: string,
		patternResults: ICheckResult[],
		relevantRules: IGRCRule[],
		frameworkContext: string,
		modelSelection: { providerName: string; modelName: string }
	): Promise<IntelligenceResult | undefined> {
		const patternSummary = patternResults.length > 0
			? patternResults.map(r =>
				`  Line ${r.line}: [${r.ruleId}] ${r.message.substring(0, 100)}`
			).join('\n')
			: '  (No violations found by pattern checks for this function)';

		const rulesSummary = relevantRules.map(r =>
			`- [${r.id}] "${r.message}" (severity: ${r.severity})\n  Intent: ${r.fix || 'N/A'}`
		).join('\n');

		const prompt = `You are a compliance auditor. Analyze this SINGLE FUNCTION against the framework rules below.

FRAMEWORK UNDERSTANDING:
${frameworkContext.substring(0, 2000)}

RULES TO CHECK (only these):
${rulesSummary}

PATTERN CHECKS ALREADY FOUND IN THIS FUNCTION:
${patternSummary}

FUNCTION: ${fn.name} (lines ${fn.startLine}-${fn.endLine})

\`\`\`${ext}
${fn.code}
\`\`\`

Respond with ONLY valid JSON:
{
  "additionalViolations": [
    {
      "line": <absolute line number in file>,
      "ruleId": "<rule ID from rules above>",
      "severity": "error|warning|info",
      "message": "<what's wrong, mentioning specific variables/flows>",
      "snippet": "<offending code, max 80 chars>",
      "aiExplanation": "<why this matters from framework perspective>",
      "aiConfidence": "high|medium|low"
    }
  ],
  "enrichments": [
    {
      "ruleId": "<rule ID>",
      "line": <number>,
      "aiExplanation": "<context-specific explanation using actual variable names>",
      "aiConfidence": "high|medium|low"
    }
  ],
  "falsePositives": [
    { "ruleId": "<rule ID>", "line": <number>, "reason": "<why this is likely wrong>" }
  ]
}

FOCUS ON:
- Violations patterns MISSED (obfuscated secrets, aliased variables, indirect flows)
- Each additionalViolation MUST reference a ruleId from the rules above
- Be conservative — only flag real issues with high confidence
- Return ONLY valid JSON`;

		return new Promise<IntelligenceResult | undefined>((resolve) => {
			const timeoutId = setTimeout(() => {
				resolve(undefined);
			}, 20_000);

			this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: [{ role: 'user', content: prompt }] as LLMChatMessage[],
				separateSystemMessage: undefined,
				chatMode: null,
				modelSelection: modelSelection as any,
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				onText: () => { },
				onFinalMessage: (params: { fullText: string }) => {
					clearTimeout(timeoutId);
					const result = this._parseAnalysisResponse(params.fullText, fileUri, relevantRules);
					resolve(result);
				},
				onError: (err: { message: string }) => {
					clearTimeout(timeoutId);
					console.error(`[FrameworkIntelligence] Function analysis error (${fn.name}):`, err.message);
					resolve(undefined);
				},
				onAbort: () => { clearTimeout(timeoutId); resolve(undefined); },
				logging: { loggingName: `GRC-Intelligence-Function-${fn.name}` },
			});
		});
	}

	/**
	 * Fallback: analyze the whole file when function extraction isn't possible.
	 */
	private async _analyzeWholeFile(
		fileUri: URI,
		fileContent: string,
		ext: string,
		patternResults: ICheckResult[],
		rules: IGRCRule[],
		frameworkContext: string,
		modelSelection: { providerName: string; modelName: string }
	): Promise<IntelligenceResult | undefined> {
		const patternSummary = patternResults.length > 0
			? patternResults.map(r =>
				`  Line ${r.line}: [${r.ruleId}] ${r.message.substring(0, 100)}`
			).join('\n')
			: '  (No violations found by pattern checks)';

		const maxCodeLength = 8000;
		const truncatedCode = fileContent.length > maxCodeLength
			? fileContent.substring(0, maxCodeLength) + '\n... (truncated)'
			: fileContent;

		const rulesSummary = rules.filter(r => r.enabled).map(r =>
			`- [${r.id}] "${r.message}" (severity: ${r.severity})`
		).join('\n');

		const prompt = `You are a compliance auditor reviewing code against a regulatory framework.

FRAMEWORK UNDERSTANDING:
${frameworkContext.substring(0, 4000)}

RULES TO CHECK:
${rulesSummary}

PATTERN CHECKS ALREADY FOUND:
${patternSummary}

FILE: ${fileUri.path.split('/').pop()}

\`\`\`${ext}
${truncatedCode}
\`\`\`

Respond with ONLY valid JSON:
{
  "enrichments": [
    { "ruleId": "<rule ID>", "line": <number>, "aiExplanation": "<context explanation>", "aiConfidence": "high|medium|low" }
  ],
  "additionalViolations": [
    { "line": <number>, "ruleId": "<rule ID from framework>", "severity": "error|warning|info", "message": "<what's wrong>", "snippet": "<code, max 80 chars>", "aiExplanation": "<why this matters>", "aiConfidence": "high|medium|low" }
  ],
  "falsePositives": [
    { "ruleId": "<rule ID>", "line": <number>, "reason": "<why likely wrong>" }
  ]
}

FOCUS ON: violations patterns MISSED. Be conservative. Return ONLY valid JSON.`;

		return new Promise<IntelligenceResult | undefined>((resolve) => {
			const timeoutId = setTimeout(() => {
				console.warn('[FrameworkIntelligence] Whole-file analysis timed out for', fileUri.path);
				resolve(undefined);
			}, 30_000);

			this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: [{ role: 'user', content: prompt }] as LLMChatMessage[],
				separateSystemMessage: undefined,
				chatMode: null,
				modelSelection: modelSelection as any,
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				onText: () => { },
				onFinalMessage: (params: { fullText: string }) => {
					clearTimeout(timeoutId);
					resolve(this._parseAnalysisResponse(params.fullText, fileUri, rules));
				},
				onError: (err: { message: string }) => {
					clearTimeout(timeoutId);
					console.error('[FrameworkIntelligence] Analysis error:', err.message);
					resolve(undefined);
				},
				onAbort: () => { clearTimeout(timeoutId); resolve(undefined); },
				logging: { loggingName: 'GRC-Intelligence-WholeFile' },
			});
		});
	}

	/**
	 * Merge multiple function-level analysis results into one file-level result.
	 */
	private _mergeResults(
		results: (IntelligenceResult | undefined)[],
		fileUri: URI
	): IntelligenceResult {
		const merged: IntelligenceResult = {
			additionalViolations: [],
			falsePositiveFlags: [],
			enrichments: new Map(),
			fileUri,
		};

		for (const result of results) {
			if (!result) continue;
			merged.additionalViolations.push(...result.additionalViolations);
			merged.falsePositiveFlags.push(...result.falsePositiveFlags);
			for (const [key, value] of result.enrichments) {
				merged.enrichments.set(key, value);
			}
		}

		console.log(
			`[FrameworkIntelligence] Merged results: ` +
			`${merged.additionalViolations.length} AI violations, ` +
			`${merged.enrichments.size} enrichments, ` +
			`${merged.falsePositiveFlags.length} false positives`
		);

		return merged;
	}


	// ─── Response Parsing ────────────────────────────────────────────

	/**
	 * Parse the LLM's JSON response into a structured IntelligenceResult.
	 */
	private _parseAnalysisResponse(
		response: string,
		fileUri: URI,
		rules: IGRCRule[]
	): IntelligenceResult | undefined {
		try {
			// Extract JSON from response (handle markdown-wrapped responses)
			let jsonStr = response.trim();

			// Strip markdown code fences if present
			const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
			if (jsonMatch) {
				jsonStr = jsonMatch[1].trim();
			}

			const data = JSON.parse(jsonStr);
			const now = Date.now();

			// Build rule lookup map
			const ruleMap = new Map(rules.map(r => [r.id, r]));

			// Convert additional violations to ICheckResult[]
			const additionalViolations: ICheckResult[] = [];
			for (const v of (data.additionalViolations || [])) {
				const rule = ruleMap.get(v.ruleId);
				if (!rule) continue; // Skip violations referencing unknown rules

				additionalViolations.push({
					ruleId: v.ruleId,
					domain: rule.domain,
					severity: toDisplaySeverity(v.severity || rule.severity),
					message: `[${v.ruleId}] ${v.message}`,
					fileUri: fileUri,
					line: v.line || 1,
					column: 1,
					endLine: v.line || 1,
					endColumn: (v.snippet?.length || 0) + 1,
					codeSnippet: v.snippet,
					fix: rule.fix,
					timestamp: now,
					frameworkId: rule.frameworkId,
					references: rule.references,
					blockingBehavior: rule.blockingBehavior,
					// AI-generated fields
					aiExplanation: v.aiExplanation,
					aiConfidence: v.aiConfidence || 'medium',
				});
			}

			// Build enrichments map for existing pattern violations
			const enrichments = new Map<string, {
				aiExplanation: string;
				aiConfidence: 'high' | 'medium' | 'low';
			}>();
			for (const e of (data.enrichments || [])) {
				if (e.ruleId && e.line && e.aiExplanation) {
					enrichments.set(`${e.ruleId}:${e.line}`, {
						aiExplanation: e.aiExplanation,
						aiConfidence: e.aiConfidence || 'medium',
					});
				}
			}

			return {
				additionalViolations,
				falsePositiveFlags: data.falsePositives || [],
				enrichments,
				fileUri,
			};
		} catch (e) {
			console.error('[FrameworkIntelligence] Failed to parse LLM response:', e);
			return undefined;
		}
	}


	// ─── Helpers ─────────────────────────────────────────────────────

	/**
	 * Simple hash for content-based caching.
	 * Uses djb2 algorithm — fast and sufficient for cache keys.
	 */
	private _simpleHash(str: string): string {
		let hash = 5381;
		for (let i = 0; i < str.length; i++) {
			hash = ((hash << 5) + hash) + str.charCodeAt(i);
			hash = hash & hash; // Convert to 32-bit integer
		}
		return hash.toString(36);
	}
}


// ─── Registration ────────────────────────────────────────────────────────────

registerSingleton(IFrameworkIntelligenceService, FrameworkIntelligenceService, InstantiationType.Delayed);
