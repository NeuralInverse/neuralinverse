/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Contract Reason Service
 *
 * AI-powered contract reasoning engine that validates code against compliance
 * contracts (framework rules) without touching framework definitions.
 * Frameworks stay pure pattern-based (regex, AST, dataflow, import-graph).
 * This service operates alongside them as the reasoning layer.
 *
 * ## How It Works
 *
 * **Phase 1 — Contract Comprehension (on import)**
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
 * **Phase 2 — Contract Reasoning (on file save)**
 *
 * After pattern checks run, this service receives the code + pattern results
 * and uses the contract understanding to:
 * - Find violations that patterns missed
 * - Flag likely false positives
 * - Add contextual explanations
 *
 * **Rate Limiting — Periodic Batch Processing**
 *
 * During workspace scans, files are processed in controlled batches to avoid
 * overwhelming the AI provider with bulk requests. The service uses:
 * - Configurable concurrency limit (max parallel LLM calls)
 * - Inter-batch cooldown delay to respect rate limits
 * - Exponential backoff on rate limit errors
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
import { INanoAgentContext } from '../../nanoAgents/projectAnalyzerService.js';
import { IAccessibilitySignalService, AccessibilitySignal } from '../../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IViolationFeedbackService } from './violationFeedbackService.js';
import { ICodebaseContextService } from './codebaseContextService.js';



// ─── Service Interface ───────────────────────────────────────────────────────

export const IContractReasonService = createDecorator<IContractReasonService>('contractReasonService');

/**
 * Contract reasoning results from AI analysis.
 */
export interface ContractReasonResult {
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
	/**
	 * AI confirmations that a static finding IS a real violation.
	 * Provides a structural reason and confidence level so the engine can
	 * promote static violations to AI-confirmed true positives.
	 */
	positiveFindings: Array<{
		ruleId: string;
		line: number;
		reason: string;
		confidence: 'high' | 'medium' | 'low';
	}>;
	/** File that was analyzed */
	fileUri: URI;
}

/**
 * Cached framework comprehension (contract understanding).
 */
interface ContractContext {
	frameworkId: string;
	version: string;
	/** LLM's structured understanding of the framework */
	understanding: string;
	/** When the comprehension was created */
	timestamp: number;
	/** djb2 of all rule check definitions — used for targeted cache invalidation */
	rulesHash: string;
}


/**
 * Per-file scan tracking entry.
 */
export interface IScanFileEntry {
	/** File URI string */
	fileUri: string;
	/** Short display name (filename) */
	fileName: string;
	/** Scan status */
	status: 'pending' | 'scanning' | 'scanned' | 'skipped' | 'error';
	/** When this entry was last updated */
	timestamp: number;
	/** Number of AI violations found (if scanned) */
	violationCount?: number;
	/** Skip reason if status is 'skipped' */
	skipReason?: string;
	/** Error message if status is 'error' */
	errorMessage?: string;
	/** Risk score computed during scan prioritization (0-100+) */
	riskScore?: number;
}

/**
 * Aggregate scan tracker state exposed to UI.
 */
export interface IScanTrackerState {
	/** All tracked file entries */
	entries: IScanFileEntry[];
	/** How many files total are queued or tracked */
	totalFiles: number;
	/** How many have been scanned (status === 'scanned') */
	scannedCount: number;
	/** How many were skipped (cache hit) */
	skippedCount: number;
	/** How many errored */
	errorCount: number;
	/** How many are currently in-flight */
	scanningCount: number;
	/** Whether a workspace scan is currently running */
	isScanning: boolean;
	/** Timestamp of last completed workspace scan */
	lastScanCompleted: number | undefined;
	/** Whether periodic scanning is active */
	periodicScanActive: boolean;
	/** Periodic scan interval in ms */
	periodicScanIntervalMs: number;
}

export interface IContractReasonService {
	readonly _serviceBrand: undefined;

	/** Whether contract reasoning is available (model configured + contract comprehended + enabled) */
	readonly isAvailable: boolean;

	/** Whether the contract reasoning system is enabled (defaults to OFF) */
	readonly isEnabled: boolean;

	/** Enable or disable the contract reasoning system */
	setEnabled(enabled: boolean): void;

	/** Event fired when enabled state changes */
	readonly onDidEnabledChange: Event<boolean>;

	/**
	 * Provide the current reverse-import map so the service can build multi-hop
	 * dependency context for AI analysis prompts.
	 * Called by GRCEngineService after bootstrap and on each save-triggered update.
	 */
	setImportedByMap(map: ReadonlyMap<string, readonly string[]>): void;

	/** The last imported-by map provided by the engine (read-only). */
	readonly importedByMap: ReadonlyMap<string, readonly string[]>;

	/** Comprehend a framework's contracts — called on import/load */
	comprehendFramework(framework: ILoadedFramework): Promise<void>;

	/** Get contract-reasoning-enhanced results for a file */
	analyzeFile(
		fileUri: URI,
		fileContent: string,
		patternResults: ICheckResult[],
		rules: IGRCRule[],
		context?: INanoAgentContext,
		contextFiles?: Map<string, string>,
		allFileContents?: Map<string, string>,
		riskScore?: number
	): Promise<ContractReasonResult | undefined>;

	/** Event fired when contract reasoning results are ready */
	readonly onDidContractReasonResultsReady: Event<ContractReasonResult>;

	/** Send a one-shot query to the LLM (rate-limited). Returns raw response text. */
	sendOneShotQuery(prompt: string): Promise<string | undefined>;

	// ─── Scan Tracker API ────────────────────────────────────────────

	/** Get the current scan tracker state for UI rendering */
	getScanTrackerState(): IScanTrackerState;

	/** Event fired when scan tracker state changes (file starts/completes/errors) */
	readonly onDidScanTrackerUpdate: Event<IScanTrackerState>;

	/** Mark scan as started (called by grcEngine before batch processing) */
	scanTrackerBeginScan(fileUris: URI[], riskScores?: Map<string, number>): void;

	/** Mark scan as completed */
	scanTrackerEndScan(): void;

	/** Reset scan tracker entries (e.g. on new workspace scan) */
	scanTrackerReset(): void;

	/** Update periodic scan state (called by grcEngine when periodic scan starts/stops) */
	scanTrackerSetPeriodicState(active: boolean, intervalMs?: number): void;

	/**
	 * Record a user-dismissed violation as a false positive.
	 * Delegates to IViolationFeedbackService.dismiss().
	 */
	dismissViolation(result: ICheckResult, reason?: string): void;

	/**
	 * Clear all in-memory + persisted content-hash caches so every file
	 * is treated as never-scanned on the next AI workspace scan.
	 */
	clearAnalysisCache(): void;
}


// ─── Rate Limiter ────────────────────────────────────────────────────────────

/**
 * Controls the rate at which AI analysis requests are dispatched.
 * Prevents bulk workspace scans from overwhelming the LLM provider.
 */
class AnalysisRateLimiter {
	/** Pending analysis tasks waiting to be processed */
	private readonly _queue: Array<{ execute: () => Promise<void>; resolve: () => void }> = [];

	/** Number of currently in-flight LLM calls */
	private _activeCount = 0;

	/** Whether the drain loop is running */
	private _draining = false;

	/** Current backoff delay (increases on rate limit errors) */
	private _backoffMs = 0;

	/** Max concurrent file-level analyses */
	private static readonly MAX_CONCURRENCY = 2;

	/** Delay between batches (ms) — gives the API breathing room */
	private static readonly BATCH_COOLDOWN_MS = 3_000;

	/** Base backoff on rate limit error */
	private static readonly BACKOFF_BASE_MS = 5_000;

	/** Max backoff ceiling */
	private static readonly BACKOFF_MAX_MS = 60_000;

	/**
	 * Enqueue an analysis task. Returns a promise that resolves when the
	 * task has been dispatched (not when the LLM responds).
	 */
	enqueue(execute: () => Promise<void>): Promise<void> {
		return new Promise<void>((resolve) => {
			this._queue.push({ execute, resolve });
			this._drain();
		});
	}

	/** Signal that a rate limit error occurred — increase backoff */
	reportRateLimitError(): void {
		this._backoffMs = this._backoffMs === 0
			? AnalysisRateLimiter.BACKOFF_BASE_MS
			: Math.min(this._backoffMs * 2, AnalysisRateLimiter.BACKOFF_MAX_MS);
		console.warn(`[ContractReason] Rate limit hit — backoff increased to ${this._backoffMs}ms`);
	}

	/** Signal a successful call — gradually reduce backoff */
	reportSuccess(): void {
		if (this._backoffMs > 0) {
			this._backoffMs = Math.max(0, this._backoffMs - AnalysisRateLimiter.BACKOFF_BASE_MS);
		}
	}

	/** Number of items waiting + in-flight */
	get pending(): number {
		return this._queue.length + this._activeCount;
	}

	private async _drain(): Promise<void> {
		if (this._draining) return;
		this._draining = true;

		try {
			while (this._queue.length > 0) {
				// Wait for a slot to open
				if (this._activeCount >= AnalysisRateLimiter.MAX_CONCURRENCY) {
					await new Promise<void>(r => setTimeout(r, 200));
					continue;
				}

				// Apply backoff if we've been rate-limited
				if (this._backoffMs > 0) {
					console.log(`[ContractReason] Rate limit backoff: waiting ${this._backoffMs}ms before next batch`);
					await new Promise<void>(r => setTimeout(r, this._backoffMs));
				}

				// Dispatch up to MAX_CONCURRENCY tasks
				const batch: typeof this._queue[number][] = [];
				while (batch.length < AnalysisRateLimiter.MAX_CONCURRENCY && this._queue.length > 0) {
					batch.push(this._queue.shift()!);
				}

				this._activeCount += batch.length;

				// Fire all tasks in this batch concurrently
				await Promise.all(batch.map(async (task) => {
					try {
						await task.execute();
					} finally {
						this._activeCount--;
						task.resolve();
					}
				}));

				// Cooldown between batches to avoid bursts
				if (this._queue.length > 0) {
					await new Promise<void>(r => setTimeout(r, AnalysisRateLimiter.BATCH_COOLDOWN_MS));
				}
			}
		} finally {
			this._draining = false;
		}
	}
}


// ─── Implementation ──────────────────────────────────────────────────────────

export class ContractReasonService extends Disposable implements IContractReasonService {
	declare readonly _serviceBrand: undefined;

	/** Storage key for persisting framework comprehension contexts across restarts */
	private static readonly COMPREHENSION_STORAGE_KEY = 'grc.contractReasonComprehensions';

	/** Storage key for persisting per-file content hashes — skip LLM when content unchanged */
	private static readonly FILE_HASH_STORAGE_KEY = 'grc.fileContentHashes';

	/** Storage key for persisted AI violations — stored in IStorageService, NOT .inverse/audit */
	private static readonly VIOLATIONS_CACHE_KEY = 'grc.aiViolationsCache';

	/** Persisted content hashes from previous sessions: fileUri → hash */
	private _persistedHashes = new Map<string, string>();

	/** Persisted AI violations from previous sessions: fileUri → serialized violations */
	private _persistedViolations = new Map<string, any[]>();

	/** Cached framework comprehension contexts */
	private readonly _contractContexts = new Map<string, ContractContext>();

	/** Currently running analysis requests (prevent duplicates) */
	private readonly _runningAnalyses = new Set<string>();

	/** Cached analysis results per file hash (LRU) */
	private readonly _resultCache = new Map<string, { result: ContractReasonResult; hash: string }>();

	/** Maximum cached analysis entries */
	private static readonly MAX_CACHE = 50;

	/** Rate limiter for AI analysis requests */
	private readonly _rateLimiter = new AnalysisRateLimiter();

	private readonly _onDidContractReasonResultsReady = this._register(new Emitter<ContractReasonResult>());
	public readonly onDidContractReasonResultsReady = this._onDidContractReasonResultsReady.event;

	/** Contract reasoning enabled state — auto-enables when model is configured */
	private _enabled = false;
	private readonly _onDidEnabledChange = this._register(new Emitter<boolean>());
	public readonly onDidEnabledChange = this._onDidEnabledChange.event;

	// ─── Scan Tracker State ──────────────────────────────────────────
	private readonly _scanEntries = new Map<string, IScanFileEntry>();
	private _isScanning = false;
	private _lastScanCompleted: number | undefined;
	private _periodicScanActive = false;
	private _periodicScanIntervalMs = 120_000; // 2 min default
	private readonly _onDidScanTrackerUpdate = this._register(new Emitter<IScanTrackerState>());
	public readonly onDidScanTrackerUpdate = this._onDidScanTrackerUpdate.event;

	// ─── Cross-File Import Map ────────────────────────────────────────
	/** Reverse-import map: resolved path (no extension) → array of importer URI strings */
	private _importedByMap: ReadonlyMap<string, readonly string[]> = new Map();

	constructor(
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IFrameworkRegistry private readonly frameworkRegistry: IFrameworkRegistry,
		@IAccessibilitySignalService private readonly accessibilitySignalService: IAccessibilitySignalService,
		@IStorageService private readonly storageService: IStorageService,
		@IViolationFeedbackService private readonly violationFeedbackService: IViolationFeedbackService,
		@ICodebaseContextService private readonly codebaseContextService: ICodebaseContextService,
	) {
		super();

		// Restore framework comprehensions, file hashes, and violation cache from previous session.
		// Prevents re-running LLM calls on every IDE restart.
		this._loadPersistedComprehensions();
		this._loadPersistedHashes();
		this._loadPersistedViolations();

		// Auto-comprehend when frameworks change (only if enabled).
		// Also clear persisted content hashes so files are re-scanned with the new rules —
		// without this, the hash cache would skip all files that haven't changed on disk
		// even though the rules they're evaluated against have changed.
		this._register(this.frameworkRegistry.onDidFrameworksChange(() => {
			if (this._enabled) {
				this._comprehendAllFrameworks();
			}
			// Always invalidate hashes + violations on framework change regardless of enabled state,
			// so the next scan (whenever it runs) picks up new rules.
			this._persistedHashes.clear();
			this._savePersistedHashes();
			this._persistedViolations.clear();
			this._savePersistedViolations();
			console.log('[ContractReason] Frameworks changed — cleared caches so files are re-scanned with updated rules');
		}));

		// Auto-enable/disable when model settings change
		this._register(this.voidSettingsService.onDidChangeState(() => {
			this._autoToggleBasedOnModel();
		}));

		// Check if we should auto-enable on startup
		this.voidSettingsService.waitForInitState.then(() => {
			this._autoToggleBasedOnModel();
		});

		console.log('[ContractReason] Service initialized (auto-enables when Checks or Chat model is configured)');
	}

	/**
	 * Load framework comprehension contexts from workspace storage.
	 * Populated by previous sessions — skips LLM calls for already-comprehended frameworks.
	 */
	private _loadPersistedComprehensions(): void {
		try {
			const stored = this.storageService.get(
				ContractReasonService.COMPREHENSION_STORAGE_KEY,
				StorageScope.WORKSPACE
			);
			if (!stored) return;

			const contexts: ContractContext[] = JSON.parse(stored);
			for (const ctx of contexts) {
				const key = `${ctx.frameworkId}:${ctx.version}`;
				// Ensure rulesHash is present — old-format entries default to '' which triggers re-comprehension
				if (ctx.rulesHash === undefined) {
					(ctx as any).rulesHash = '';
				}
				this._contractContexts.set(key, ctx);
			}
			console.log(`[ContractReason] Restored ${contexts.length} contract comprehension(s) from storage`);
		} catch (e) {
			console.error('[ContractReason] Failed to load persisted comprehensions:', e);
		}
	}

	private _loadPersistedHashes(): void {
		try {
			const stored = this.storageService.get(ContractReasonService.FILE_HASH_STORAGE_KEY, StorageScope.WORKSPACE);
			if (!stored) return;
			const entries: [string, string][] = JSON.parse(stored);
			this._persistedHashes = new Map(entries);
			console.log(`[ContractReason] Restored content hashes for ${this._persistedHashes.size} file(s)`);
		} catch (e) {
			console.error('[ContractReason] Failed to load persisted file hashes:', e);
		}
	}

	private _savePersistedHashes(): void {
		try {
			const entries = Array.from(this._persistedHashes.entries());
			this.storageService.store(
				ContractReasonService.FILE_HASH_STORAGE_KEY,
				JSON.stringify(entries),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
		} catch (e) {
			console.error('[ContractReason] Failed to persist file hashes:', e);
		}
	}

	private _loadPersistedViolations(): void {
		try {
			const stored = this.storageService.get(ContractReasonService.VIOLATIONS_CACHE_KEY, StorageScope.WORKSPACE);
			if (!stored) return;
			const entries: [string, any[]][] = JSON.parse(stored);
			this._persistedViolations = new Map(entries);
			console.log(`[ContractReason] Restored AI violations cache for ${this._persistedViolations.size} file(s)`);
		} catch (e) {
			console.error('[ContractReason] Failed to load persisted violations:', e);
		}
	}

	private _savePersistedViolations(): void {
		try {
			// Cap at 100 entries to keep storage size reasonable
			const entries = Array.from(this._persistedViolations.entries()).slice(-100);
			this.storageService.store(
				ContractReasonService.VIOLATIONS_CACHE_KEY,
				JSON.stringify(entries),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
		} catch (e) {
			console.error('[ContractReason] Failed to persist violations cache:', e);
		}
	}

	/**
	 * Persist all framework comprehension contexts to workspace storage.
	 * Called after each successful comprehension to ensure next restart is free.
	 */
	private _saveComprehensions(): void {
		try {
			const contexts = Array.from(this._contractContexts.values());
			this.storageService.store(
				ContractReasonService.COMPREHENSION_STORAGE_KEY,
				JSON.stringify(contexts),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
		} catch (e) {
			console.error('[ContractReason] Failed to persist comprehensions:', e);
		}
	}

	/**
	 * Automatically enable/disable contract reasoning based on whether
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
			console.log('[ContractReason] Contract Reasoning ENABLED');
			// Comprehend frameworks now that we're enabled
			this._comprehendAllFrameworks();
		} else {
			console.log('[ContractReason] Contract Reasoning DISABLED');
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


	// ─── Phase 1: Contract Comprehension ─────────────────────────────

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

		// Compute hash of current rule definitions — used to detect rule changes
		const rulesHash = this._computeRulesHash(framework.rules);

		// Already comprehended this version AND rules haven't changed
		const existing = this._contractContexts.get(cacheKey);
		if (existing) {
			if (existing.rulesHash === rulesHash) {
				// Rules unchanged — no need to re-comprehend
				return;
			}
			// Rules changed — fall through to re-comprehend with updated rules
			console.log(`[ContractReason] Rules changed for ${fwId} v${fwVersion} (hash mismatch) — re-comprehending`);
		}

		const modelSelection = this._getModelSelection();
		if (!modelSelection) {
			console.log('[ContractReason] No model configured for Checks or Chat — skipping comprehension');
			return;
		}

		// Build the comprehension prompt
		const rulesDescription = framework.rules.map(r =>
			`- [${r.id}] "${r.message}" (severity: ${r.severity}, type: ${r.type})\n  Check: ${JSON.stringify(r.check).substring(0, 200)}`
		).join('\n');

		const comprehensionSystemMsg = `You are a compliance framework analyst for critical and regulated software. Your job is to deeply understand compliance frameworks so you can later identify violations that static pattern matching misses. Respond ONLY with valid JSON — no prose, no markdown fences.`;

		const comprehensionUserMsg = `Study this framework and produce a structured machine-readable understanding of what it enforces.

Framework: ${framework.definition.framework.name} v${fwVersion}
Description: ${framework.definition.framework.description || 'N/A'}

Rules:
${rulesDescription}

Return ONLY valid JSON in this exact format:
{
  "schemaVersion": 1,
  "rules": {
    "<ruleId>": {
      "intent": "<one sentence: what the rule enforces>",
      "missedPatterns": ["<code pattern regex patterns can miss>"],
      "violationSignals": ["<observable code signal indicating violation>"],
      "falsePositiveTriggers": ["<code pattern that looks like violation but isn't>"]
    }
  },
  "crossRuleRelationships": [
    {"rules": ["<ruleId1>", "<ruleId2>"], "relationship": "<brief description>"}
  ]
}`;

		return new Promise<void>((resolve) => {
			this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: [{ role: 'user', content: comprehensionUserMsg }] as LLMChatMessage[],
				separateSystemMessage: comprehensionSystemMsg,
				chatMode: null,
				modelSelection,
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				onText: () => { },
				onFinalMessage: (params: { fullText: string }) => {
					this._contractContexts.set(cacheKey, {
						frameworkId: fwId,
						version: fwVersion,
						understanding: params.fullText,
						timestamp: Date.now(),
						rulesHash,
					});
					// Persist so next restart doesn't re-call the LLM
					this._saveComprehensions();
					console.log(`[ContractReason] Comprehended framework: ${fwId} v${fwVersion} (${params.fullText.length} chars)`);
					resolve();
				},
				onError: (err: { message: string }) => {
					console.error(`[ContractReason] Comprehension failed for ${fwId}:`, err.message);
					resolve(); // Don't block on failure
				},
				onAbort: () => { resolve(); },
				logging: { loggingName: 'GRC-ContractReason-Comprehend' },
			});
		});
	}


	// ─── Phase 2: Contract Reasoning (File Analysis) ─────────────────

	/**
	 * Analyze a file using the contract understanding + pattern results.
	 *
	 * Called after pattern checks complete (on file save, not keystroke).
	 * Returns additional violations, false positive flags, and explanations.
	 *
	 * All calls are routed through the rate limiter to prevent overwhelming
	 * the AI provider during bulk workspace scans.
	 */
	public async analyzeFile(
		fileUri: URI,
		fileContent: string,
		patternResults: ICheckResult[],
		rules: IGRCRule[],
		context?: INanoAgentContext,
		contextFiles?: Map<string, string>,
		allFileContents?: Map<string, string>,
		riskScore?: number
	): Promise<ContractReasonResult | undefined> {
		if (!this.isAvailable) {
			return undefined;
		}

		// Prevent duplicate analysis for the same file
		const fileKey = fileUri.toString();
		if (this._runningAnalyses.has(fileKey)) {
			this._scanTrackerMarkSkipped(fileUri, 'already in-flight');
			return undefined;
		}

		// Check content-based cache — same content means same violations
		const contentHash = this._simpleHash(fileContent);
		const cached = this._resultCache.get(fileKey);
		if (cached && cached.hash === contentHash) {
			// Fire the event so the engine and diagnostics pick up the cached violations.
			this._onDidContractReasonResultsReady.fire(cached.result);
			this._scanTrackerMarkSkipped(fileUri, 'in-memory cache hit');
			return cached.result;
		}

		// Check persisted hash from a previous session.
		// Content unchanged — restore saved violations from in-memory/storage cache.
		if (this._persistedHashes.get(fileKey) === contentHash) {
			const saved = this._persistedViolations.get(fileKey);
			if (saved && saved.length > 0) {
				const violations: ICheckResult[] = saved.map((v: any) => ({ ...v, fileUri, checkSource: 'ai' as const }));
				const restored: ContractReasonResult = {
					additionalViolations: violations,
					falsePositiveFlags: [],
					enrichments: new Map(),
					positiveFindings: [],
					fileUri,
				};
				this._resultCache.set(fileKey, { result: restored, hash: contentHash });
				this._onDidContractReasonResultsReady.fire(restored);
				this._scanTrackerMarkSkipped(fileUri, `restored ${violations.length} from cache`);
				console.log(`[ContractReason] Restored ${violations.length} AI violation(s) for ${fileUri.path.split('/').pop()} from cache`);
			} else {
				this._scanTrackerMarkSkipped(fileUri, 'content unchanged, no prior violations');
				console.log(`[ContractReason] Content unchanged for ${fileUri.path.split('/').pop()} — no prior AI violations`);
			}
			return undefined;
		}

		this._runningAnalyses.add(fileKey);
		this._scanTrackerMarkScanning(fileUri);

		// Route through rate limiter — waits for a slot before executing
		let result: ContractReasonResult | undefined;
		try {
			await this._rateLimiter.enqueue(async () => {
				try {
					result = await this._runAnalysis(fileUri, fileContent, patternResults, rules, context, contextFiles, allFileContents, riskScore);
					if (result) {
						this._rateLimiter.reportSuccess();

						// Cache result in memory
						this._resultCache.set(fileKey, { result, hash: contentHash });

						// Evict old entries
						if (this._resultCache.size > ContractReasonService.MAX_CACHE) {
							const firstKey = this._resultCache.keys().next().value;
							if (firstKey) this._resultCache.delete(firstKey);
						}

						// Persist content hash + violations to IStorageService (no .inverse disk writes)
						this._persistedHashes.set(fileKey, contentHash);
						this._savePersistedHashes();

						// Store violations in cache — survives IDE restarts via IStorageService
						this._persistedViolations.set(fileKey, result.additionalViolations.map(v => ({
							ruleId: v.ruleId, domain: v.domain, severity: v.severity,
							message: v.message, line: v.line, column: v.column,
							endLine: v.endLine, endColumn: v.endColumn,
							codeSnippet: v.codeSnippet, fix: v.fix,
							frameworkId: v.frameworkId, references: v.references,
							blockingBehavior: v.blockingBehavior,
							aiExplanation: v.aiExplanation, aiConfidence: v.aiConfidence,
							timestamp: v.timestamp,
						})));
						this._savePersistedViolations();

						this._onDidContractReasonResultsReady.fire(result);
						this.accessibilitySignalService.playSignal(AccessibilitySignal.neuralInverseTaskComplete);

						this._scanTrackerMarkScanned(fileUri, result.additionalViolations.length);
					} else {
						this._scanTrackerMarkError(fileUri, 'LLM returned no result');
					}
				} catch (e) {
					this._scanTrackerMarkError(fileUri, e instanceof Error ? e.message : 'unknown error');
					throw e;
				}
			});
		} finally {
			this._runningAnalyses.delete(fileKey);
		}

		return result;
	}


	/**
	 * Run the actual LLM analysis — routes to single-call or two-phase
	 * based on risk score.
	 *
	 * For high-risk files (riskScore > 50): Two-phase analysis
	 *   Phase A — Threat modeling (identify attack surfaces)
	 *   Phase B — Targeted violation detection (using threat model)
	 *
	 * For low-risk files: Single-call analysis (efficient, one LLM round-trip)
	 */
	private async _runAnalysis(
		fileUri: URI,
		fileContent: string,
		patternResults: ICheckResult[],
		rules: IGRCRule[],
		context?: INanoAgentContext,
		contextFiles?: Map<string, string>,
		allFileContents?: Map<string, string>,
		riskScore?: number
	): Promise<ContractReasonResult | undefined> {
		const modelSelection = this._getModelSelection();
		if (!modelSelection) return undefined;

		const ext = fileUri.path.split('.').pop() || 'ts';
		const fileName = fileUri.path.split('/').pop() || 'unknown';
		const startTime = Date.now();

		// Inject codebase context into prompts so AI knows the project's tech stack
		const codebaseContext = this.codebaseContextService.formatForPrompt();

		// Enabled rules (computed early so we can build the relevantRuleIds set for context filtering)
		const enabledRules = rules.filter(r => r.enabled);

		// Gather contract understanding — filter to relevant rule IDs for a tighter prompt
		const relevantRuleIds = new Set(enabledRules.map(r => r.id));
		const frameworkContext = Array.from(this._contractContexts.values())
			.map(ctx => this._extractRelevantRuleContext(ctx.understanding, relevantRuleIds, 4000))
			.join('\n---\n')
			.substring(0, 4000);

		// Build false positive trigger summary from structured comprehension (if available)
		const fpTriggerLines: string[] = [];
		for (const ctx of this._contractContexts.values()) {
			try {
				const parsed = JSON.parse(ctx.understanding);
				if (parsed?.rules) {
					for (const ruleId of Object.keys(parsed.rules)) {
						if (!relevantRuleIds.has(ruleId)) continue;
						const entry = parsed.rules[ruleId];
						if (Array.isArray(entry.falsePositiveTriggers) && entry.falsePositiveTriggers.length > 0) {
							fpTriggerLines.push(`- Rule ${ruleId}: ${entry.falsePositiveTriggers.join(', ')}`);
						}
					}
				}
			} catch {
				// old-format cache — skip
			}
		}
		const fpTriggersSection = fpTriggerLines.length > 0
			? `\nKNOWN FALSE POSITIVE PATTERNS (from framework comprehension — be skeptical of these):\n${fpTriggerLines.join('\n')}\n`
			: '';

		// User-dismissed false positives — inject so AI knows to be skeptical
		const fileBasename = fileUri.path.split('/').pop() ?? '';
		const feedbackEntries = this.violationFeedbackService.getEntriesForFile(fileBasename);
		const relevantFeedback = feedbackEntries.filter(e => relevantRuleIds.has(e.ruleId));
		let feedbackSection = '';
		if (relevantFeedback.length > 0) {
			feedbackSection = '\n\nUSER-DISMISSED VIOLATIONS (user confirmed these are false positives in this file — be very skeptical before flagging similar patterns):\n';
			for (const entry of relevantFeedback.slice(0, 20)) {
				feedbackSection += `- Rule ${entry.ruleId}: code "${entry.codeSnippet.slice(0, 60)}" — user reason: "${entry.reason}"\n`;
			}
		}

		// Context files snippet (tests, mocks, configs)
		const contextSnippet = this._buildContextFilesSnippet(contextFiles);

		// Cross-file dependency context (2-hop BFS walk)
		const dependencyContext = this._buildMultiHopDependencyContext(fileUri, allFileContents, this._importedByMap);

		// Pattern results summary
		const patternSummary = patternResults.length > 0
			? patternResults.map(r =>
				`  L${r.line}: [${r.ruleId}] ${r.message.substring(0, 80)}`
			).join('\n')
			: '  (none)';

		// TS compiler diagnostics from nano agent context — richer type info than single-file analysis.
		// These are the real language server errors already shown as squiggles in the editor.
		// Injecting them lets the AI correlate GRC violations with type-system proof.
		const lspDiagnosticsSection = this._buildLspDiagnosticsSection(context);

		// Type signatures (hoverProvider): exact inferred types for every function/method/variable.
		// The AI no longer has to guess "what type is this param?" — the language server tells it.
		const typeSignaturesSection = this._buildTypeSignaturesSection(context);

		// Reference counts (referenceProvider): how many files depend on each symbol.
		// High cross-file reference count → violation has higher blast radius → escalate severity.
		const referenceInfoSection = this._buildReferenceInfoSection(context);

		// Inlay hints (inlayHintsProvider): inferred types VS Code shows inline.
		// Reveals implicit `any`, unannotated variables, and inferred return types.
		const inlayHintsSection = this._buildInlayHintsSection(context);

		// Definition map (definitionProvider): where each import actually resolves.
		// Distinguishes `node:crypto` (external) from workspace-internal modules.
		const definitionMapSection = this._buildDefinitionMapSection(context);

		// Extract key functions and build a focused code view.
		// Prefer LSP DocumentSymbol[] from nano agent context (accurate ranges from the TS language server)
		// over the regex brace-depth parser — LSP gives exact start/end lines even for complex syntax.
		const functions = context?.symbols && Array.isArray(context.symbols) && context.symbols.length > 0
			? this._extractFunctionsFromLsp(fileContent, context.symbols)
			: this._extractFunctions(fileContent);

		// No functions extracted — delegate to whole-file analyzer
		if (functions.length === 0) {
			console.log(`[ContractReason] No functions extracted in ${fileName} — using whole-file analysis`);
			return this._analyzeWholeFile(
				fileUri, fileContent, ext, patternResults, enabledRules, frameworkContext, modelSelection,
				contextSnippet + dependencyContext, codebaseContext,
				lspDiagnosticsSection + typeSignaturesSection + inlayHintsSection + referenceInfoSection + definitionMapSection
			);
		}

		// Use rule routing to get the relevant rules for the combined function content
		const combinedFn = { name: fileName, code: functions.map(f => f.code).join('\n') };
		const relevantRules = this._getRelevantRules(combinedFn, enabledRules, context);

		// Cap at 8 functions, prioritize ones with existing violations + largest
		const MAX_FNS = 8;
		const prioritized = functions.length > MAX_FNS
			? [
				...functions.filter(fn => patternResults.some(r => r.line >= fn.startLine && r.line <= fn.endLine)),
				...functions
					.filter(fn => !patternResults.some(r => r.line >= fn.startLine && r.line <= fn.endLine))
					.sort((a, b) => (b.endLine - b.startLine) - (a.endLine - a.startLine)),
			].slice(0, MAX_FNS)
			: functions;

		// Build batched code section with function boundaries marked
		const MAX_CODE = 10000;
		let codeLen = 0;
		const parts: string[] = [];
		for (const fn of prioritized) {
			const header = `// ── ${fn.name} (lines ${fn.startLine}-${fn.endLine}) ──`;
			const chunk = header + '\n' + fn.code;
			if (codeLen + chunk.length > MAX_CODE) break;
			parts.push(chunk);
			codeLen += chunk.length;
		}
		const codeSection = parts.join('\n\n');

		// Route: two-phase for high-risk files, single-call for low-risk
		const effectiveRisk = riskScore ?? 0;
		if (effectiveRisk > 50) {
			console.log(`[ContractReason] Two-phase analysis for ${fileName} (risk: ${effectiveRisk}, ${parts.length}/${functions.length} fns, ${relevantRules.length} rules)`);
			const richContext = lspDiagnosticsSection + typeSignaturesSection + inlayHintsSection + referenceInfoSection + definitionMapSection;
			return this._runTwoPhaseAnalysis(
				fileUri, fileName, ext, codeSection, patternSummary, relevantRules, enabledRules,
				frameworkContext, contextSnippet, dependencyContext, modelSelection, startTime, fpTriggersSection + feedbackSection, codebaseContext,
				richContext
			);
		}

		console.log(`[ContractReason] Single-call analysis for ${fileName} (risk: ${effectiveRisk}, ${parts.length}/${functions.length} fns, ${relevantRules.length} rules)`);

		const rulesSummary = relevantRules.map(r => {
			let entry = `- [${r.id}] "${r.message}" (${r.severity})`;
			if (r.description) entry += `\n  What to look for: ${r.description}`;
			if (r.fix) entry += `\n  Expected fix: ${r.fix}`;
			return entry;
		}).join('\n');

		const systemMsg = `${codebaseContext ? `CODEBASE CONTEXT: ${codebaseContext}\n\n` : ''}You are a security auditor and logic analyzer for critical software. Your analysis must be deeper than pattern matching.

IMPORTANT: Never flag code inside comments, docstrings, doxygen blocks (/** ... */), or string literals as violations. Only flag executable code. A pattern appearing only in a comment or documentation block is NOT a violation.

ANALYSIS DEPTH:
1. DATA FLOW TRACING: Follow variables from input to output. Track through assignments, function calls, destructuring, spreads, and returns. Flag when tainted data reaches sensitive sinks without sanitization.
2. LOGIC INVARIANT CHECKING: Identify assumptions the code makes (non-null, specific types, array bounds, enum completeness) and check if they can be violated by callers or external input.
3. CROSS-FILE BOUNDARY ANALYSIS: When cross-file context is provided, check that data contracts between files are honored — types match, error cases are handled, auth checks aren't bypassed.
4. CONTROL FLOW ANALYSIS: Check for unreachable code, impossible conditions, race conditions in async code, and unhandled promise rejections.
5. SECURITY PATTERN DETECTION: Check for TOCTOU, prototype pollution, ReDoS patterns, insecure deserialization, and missing rate limiting on sensitive endpoints.

DATA CLASSIFICATION & AUTHORIZATION ANALYSIS:
You MUST check for these regardless of whether rules explicitly mention them:

1. PII/Secrets exposure: Identify any variable/field/param that contains or likely contains: email addresses, phone numbers, SSNs/national IDs, passwords, API keys/tokens, credit card numbers, encryption keys, private keys, session tokens, or healthcare identifiers. For each: trace where it flows. Flag if it reaches: log statements, error messages, HTTP responses (without masking), unencrypted storage, or third-party services.

2. Authorization bypass: Identify the authentication/authorization check in this code (e.g. verifyToken, isAdmin, hasRole, requiresPermission, checkACL). Verify the check executes BEFORE any sensitive operation (database write, config change, user data access, admin action). Flag any code path that reaches a sensitive operation without passing through an authorization check.

3. For firmware/embedded/C/C++ code: Flag any direct memory writes to hardware registers without checking return values or error flags. Flag any ISR (interrupt service routine) that modifies shared state without using volatile or critical section guards. Flag dynamic memory allocation (malloc/new) in ISR or real-time task context. Flag recursive functions in safety-critical code without depth limits. Flag missing watchdog kicks in infinite loops. Flag goto statements (MISRA C Rule 15.1). Flag switch statements missing default clause (MISRA C Rule 16.4).

4. For SCADA/ICS/Critical Infrastructure (Energy, Oil & Gas, Power Grid) code: Flag any hardcoded credentials, IP addresses, or server paths. Flag Modbus/DNP3/OPC-UA connections without authentication. Flag OPC-UA endpoints with SecurityMode=None. Flag firmware update calls without signature verification. Flag any OT-to-IT network crossing without DMZ reference. Flag IEC 61850 GOOSE/MMS operations without IEC 62351 security.

5. For Telecom/5G code: Flag any IMSI, MSISDN, SUPI, or SUCI values logged or transmitted in plaintext without masking. Flag SIP header construction with string concatenation from user-controlled input. Flag NAS message transmissions without integrity protection. Flag Diameter connections without TLS. Flag SUCI concealment disabled (null scheme). Flag authentication keys (Ki, OPC, K_AMF) as plaintext literals. Flag SS7 MAP invocations without source validation.

6. For Industrial IoT/OT real-time code: Flag infinite loops without watchdog timer kicks. Flag heap allocation (malloc/new/std::vector) inside real-time tasks or interrupt handlers. Flag safety-critical output writes (valve, relay, actuator) without interlock checks. Flag non-deterministic calls (printf, sleep, socket I/O) inside real-time task functions. Flag safety function return values that are not checked (bare function call statement). Flag state machines without FAULT/SAFE/EMERGENCY states. Flag missing heartbeat signals in redundant system components.

7. For Legacy Enterprise code (COBOL, RPG, ABAP, FORTRAN, Natural, VB6): Flag unhandled file/DB status codes (SQLCODE/FILE STATUS not checked). Flag GOTO/ALTER statements. Flag hardcoded credentials in WORKING-STORAGE. Flag missing COMMIT/ROLLBACK around DB updates. Flag unbounded MOVE/string ops. Flag ABAP missing AUTHORITY-CHECK before RFC/BAPI. Use ruleId "GRC-LEGACY-ERRPROP", "GRC-LEGACY-FLOW", "GRC-SECRET-HARDCODED", "GRC-LEGACY-TRANSACTION", "GRC-LEGACY-BOUNDS".

8. For Modern/Cloud code (Python, Java, Go, Rust, C#, Kotlin, Swift): Flag unhandled promise rejections or uncaught async exceptions. Flag race conditions on shared goroutine/thread state. Flag null/nil/None dereference without guard. Flag SQL built from user input string concat. Flag user-controlled URL to HTTP client (SSRF). Flag untrusted deserialization. Use ruleId "GRC-ASYNC-UNSAFE", "GRC-CONCURRENCY", "GRC-NULL-DEREF", "GRC-SQLI", "GRC-SSRF", "GRC-DESER-UNSAFE".

9. For DevOps/Infrastructure (Terraform, Dockerfile, YAML, Shell): Flag publicly accessible or unencrypted Terraform resources. Flag Docker FROM latest. Flag Kubernetes privileged:true or hostNetwork:true. Flag shell eval or unquoted variable expansion. Flag secrets in plaintext CI YAML env vars. Use ruleId "GRC-INFRA-EXPOSURE", "GRC-SCRIPT-INJECT", "GRC-SECRET-HARDCODED".

Add violations for any findings above using the ruleId that best matches the sector. Set aiConfidence based on certainty.

POSITIVE FINDINGS: When a pattern violation IS confirmed by your analysis (especially ones the static analyzer might over-fire), add it to positiveFindings with a specific structural reason WHY it is a true positive. This helps the system learn from your reasoning. Example: a void* cast that IS unsafe because it's not a null-pointer constant should go in positiveFindings, not just be left unremarked. A missing return-value check on a function that genuinely returns an error code should also appear in positiveFindings with the specific data-flow path showing why the unchecked return matters.

Be conservative — only flag issues you are confident about. For each violation, explain the EXACT data flow or logic path that leads to the issue. Respond with ONLY valid JSON, no prose.`;

		const userMsg = `Analyze this code against the compliance rules.
${frameworkContext ? `\nFRAMEWORK CONTEXT:\n${frameworkContext}\n` : ''}
RULES (use exact IDs):
${rulesSummary}
${fpTriggersSection}${feedbackSection}
EXISTING PATTERN VIOLATIONS:
${patternSummary}
${lspDiagnosticsSection}${typeSignaturesSection}${inlayHintsSection}${referenceInfoSection}${definitionMapSection}${contextSnippet}${dependencyContext}
FILE: ${fileName}

\`\`\`${ext}
${codeSection}
\`\`\`

JSON response:
{"additionalViolations":[{"line":<number>,"ruleId":"<ID>","severity":"error|warning|info","message":"<what>","snippet":"<code max 80ch>","aiExplanation":"<why>","aiConfidence":"high|medium|low","dataFlowTrace":[{"file":"<filename>","line":<n>,"description":"<step>"}],"brokenAssumption":"<optional>","reasoningChain":[{"step":1,"observation":"<what you observed in the code — specific, not generic>","implication":"<what the observation means for compliance>","ruleRelevance":"<why this maps to the specific rule ID>"},{"step":2,"observation":"<next observation>","implication":"<implication>","ruleRelevance":"<rule relevance>"}]}],"enrichments":[{"ruleId":"<ID>","line":<n>,"aiExplanation":"<context>","aiConfidence":"high|medium|low"}],"falsePositives":[{"ruleId":"<ID>","line":<n>,"reason":"<why this is NOT a violation — specific structural reason>"}],"positiveFindings":[{"ruleId":"<ID>","line":<n>,"reason":"<why this IS confirmed a real violation — data flow or structural proof>","confidence":"high|medium|low"}]}
IMPORTANT: ALWAYS include reasoningChain with 2-4 steps for each violation. Do not omit it — it is required for audit traceability.`;

		const singleCallTimeout = this._analysisTimeout(codeSection.length + userMsg.length);
		return new Promise<ContractReasonResult | undefined>((resolve) => {
			const timeoutId = setTimeout(() => {
				console.warn(`[ContractReason] Analysis timed out for ${fileName} after ${singleCallTimeout / 1000}s`);
				resolve(undefined);
			}, singleCallTimeout);

			this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: [{ role: 'user', content: userMsg }] as LLMChatMessage[],
				separateSystemMessage: systemMsg,
				chatMode: null,
				modelSelection: modelSelection as any,
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				onText: () => { },
				onFinalMessage: (params: { fullText: string }) => {
					clearTimeout(timeoutId);
					const elapsed = Date.now() - startTime;
					console.log(`[ContractReason] ${fileName} analyzed in ${elapsed}ms`);
					resolve(this._parseAnalysisResponse(params.fullText, fileUri, enabledRules, riskScore));
				},
				onError: (err: { message: string }) => {
					clearTimeout(timeoutId);
					if (err.message && (err.message.includes('rate') || err.message.includes('429') || err.message.includes('quota'))) {
						this._rateLimiter.reportRateLimitError();
					}
					console.error(`[ContractReason] Analysis error for ${fileName}:`, err.message);
					resolve(undefined);
				},
				onAbort: () => { clearTimeout(timeoutId); resolve(undefined); },
				logging: { loggingName: `GRC-ContractReason-${fileName}` },
			});
		});
	}


	// ─── Two-Phase Analysis (high-risk files) ────────────────────────

	/**
	 * Phase A: Threat modeling — identify attack surfaces and data flows.
	 * Phase B: Targeted violation detection using the threat model.
	 */
	private async _runTwoPhaseAnalysis(
		fileUri: URI,
		fileName: string,
		ext: string,
		codeSection: string,
		patternSummary: string,
		relevantRules: IGRCRule[],
		allEnabledRules: IGRCRule[],
		frameworkContext: string,
		contextSnippet: string,
		dependencyContext: string,
		modelSelection: { providerName: string; modelName: string },
		startTime: number,
		fpTriggersSection: string = '',
		codebaseCtx: string = '',
		richContext: string = '',
	): Promise<ContractReasonResult | undefined> {

		// ── Phase A: Threat Modeling ──
		// richContext = all LSP/type/reference/inlay/definition sections concatenated.
		// Injecting into Phase A lets the threat modeler know exact types and import sources
		// before it identifies attack surfaces — higher quality threat model → better Phase B.
		const phaseASystem = `${codebaseCtx ? `CODEBASE CONTEXT: ${codebaseCtx}\n\n` : ''}You are a security threat modeler. Identify potential attack surfaces and logic vulnerabilities. Respond with ONLY valid JSON, no prose.`;

		const phaseAUser = `Given this code and its cross-file context, identify:
1. Data entry points (user input, API params, env vars, file reads)
2. Sensitive operations (DB writes, auth decisions, crypto, file system)
3. Data flow paths from entry points to sensitive operations
4. Logic assumptions that could be violated (null checks, type coercions, race conditions)
${richContext}${dependencyContext}${contextSnippet}
FILE: ${fileName}

\`\`\`${ext}
${codeSection}
\`\`\`

JSON response:
{"entryPoints":["<description>"],"sensitiveOps":["<description>"],"dataFlows":["<source → transform → sink>"],"assumptions":["<assumption that could be broken>"]}`;

		const phaseATimeout = this._analysisTimeout(codeSection.length + phaseAUser.length);
		const threatModel = await new Promise<string | undefined>((resolve) => {
			const timeoutId = setTimeout(() => {
				console.warn(`[ContractReason] Phase A (threat model) timed out for ${fileName} after ${phaseATimeout / 1000}s`);
				resolve(undefined);
			}, phaseATimeout);

			this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: [{ role: 'user', content: phaseAUser }] as LLMChatMessage[],
				separateSystemMessage: phaseASystem,
				chatMode: null,
				modelSelection: modelSelection as any,
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				onText: () => { },
				onFinalMessage: (params: { fullText: string }) => {
					clearTimeout(timeoutId);
					resolve(params.fullText);
				},
				onError: (err: { message: string }) => {
					clearTimeout(timeoutId);
					if (err.message && (err.message.includes('rate') || err.message.includes('429') || err.message.includes('quota'))) {
						this._rateLimiter.reportRateLimitError();
					}
					console.error(`[ContractReason] Phase A error for ${fileName}:`, err.message);
					resolve(undefined);
				},
				onAbort: () => { clearTimeout(timeoutId); resolve(undefined); },
				logging: { loggingName: `GRC-ContractReason-PhaseA-${fileName}` },
			});
		});

		if (!threatModel) {
			// Phase A failed — fall back to whole-file single-call analysis
			console.log(`[ContractReason] Phase A failed for ${fileName}, falling back to whole-file analysis`);
			return this._analyzeWholeFile(
				fileUri, codeSection, ext, [], allEnabledRules, frameworkContext, modelSelection,
				contextSnippet + dependencyContext, codebaseCtx, richContext
			);
		}

		const phaseAElapsed = Date.now() - startTime;
		console.log(`[ContractReason] Phase A complete for ${fileName} in ${phaseAElapsed}ms`);

		// Parse threat model to enhance rule routing
		let parsedThreatModel: { entryPoints?: string[]; sensitiveOps?: string[]; dataFlows?: string[]; assumptions?: string[] } | undefined;
		try {
			let jsonStr = threatModel.trim();
			const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
			if (jsonMatch) jsonStr = jsonMatch[1].trim();
			parsedThreatModel = JSON.parse(jsonStr);
		} catch {
			// Use raw threat model text as context even if not parseable
		}

		// Re-route rules using threat model for better relevance
		const threatEnhancedRules = parsedThreatModel
			? this._getRelevantRules({ name: fileName, code: codeSection }, allEnabledRules, undefined, parsedThreatModel)
			: relevantRules;

		// ── Phase B: Targeted Violation Detection ──
		const rulesSummary = threatEnhancedRules.map(r => {
			let entry = `- [${r.id}] "${r.message}" (${r.severity})`;
			if (r.description) entry += `\n  What to look for: ${r.description}`;
			if (r.fix) entry += `\n  Expected fix: ${r.fix}`;
			return entry;
		}).join('\n');

		const phaseBSystem = `You are a compliance auditor for critical software. Use the threat model to find real violations. For each violation, trace the data flow path that leads to it. Be conservative — only flag issues you are confident about. Respond with ONLY valid JSON, no prose.

IMPORTANT: Never flag code inside comments, docstrings, doxygen blocks (/** ... */), or string literals as violations. Only flag executable code.

DATA CLASSIFICATION & AUTHORIZATION ANALYSIS:
You MUST check for these regardless of whether rules explicitly mention them:

1. PII/Secrets exposure: Identify any variable/field/param that contains or likely contains: email addresses, phone numbers, SSNs/national IDs, passwords, API keys/tokens, credit card numbers, encryption keys, private keys, session tokens, or healthcare identifiers. For each: trace where it flows. Flag if it reaches: log statements, error messages, HTTP responses (without masking), unencrypted storage, or third-party services.

2. Authorization bypass: Identify the authentication/authorization check in this code (e.g. verifyToken, isAdmin, hasRole, requiresPermission, checkACL). Verify the check executes BEFORE any sensitive operation (database write, config change, user data access, admin action). Flag any code path that reaches a sensitive operation without passing through an authorization check.

3. For firmware/embedded/C/C++ code: Flag any direct memory writes to hardware registers without checking return values or error flags. Flag any ISR (interrupt service routine) that modifies shared state without using volatile or critical section guards. Flag dynamic memory allocation in ISR/RT task context. Flag missing watchdog in infinite loops. Flag goto statements and switch without default (MISRA C).

4. For SCADA/ICS/Critical Infrastructure code: Flag hardcoded credentials. Flag Modbus/DNP3/OPC-UA without authentication. Flag OPC-UA SecurityMode=None. Flag firmware updates without signature verification.

5. For Telecom/5G code: Flag IMSI/MSISDN/SUPI in plaintext logs. Flag SIP header injection. Flag NAS without integrity protection. Flag Ki/OPC auth keys as plaintext literals. Flag SUCI concealment disabled.

6. For Industrial IoT/OT code: Flag infinite loops without watchdog kicks. Flag heap allocation in real-time tasks. Flag safety outputs without interlock. Flag non-deterministic calls in RT context. Flag state machines without fault states.

7. For Legacy Enterprise code (COBOL, RPG, ABAP, FORTRAN, Natural, VB6): Flag unhandled file/DB status codes (SQLCODE/FILE STATUS not checked). Flag GOTO/ALTER statements. Flag hardcoded credentials in WORKING-STORAGE. Flag missing COMMIT/ROLLBACK around DB updates. Flag unbounded MOVE/string ops. Flag ABAP missing AUTHORITY-CHECK before RFC/BAPI. Use ruleId "GRC-LEGACY-ERRPROP", "GRC-LEGACY-FLOW", "GRC-SECRET-HARDCODED", "GRC-LEGACY-TRANSACTION", "GRC-LEGACY-BOUNDS".

8. For Modern/Cloud code (Python, Java, Go, Rust, C#, Kotlin, Swift): Flag unhandled promise rejections or uncaught async exceptions. Flag race conditions on shared goroutine/thread state. Flag null/nil/None dereference without guard. Flag SQL built from user input string concat. Flag user-controlled URL to HTTP client (SSRF). Flag untrusted deserialization. Use ruleId "GRC-ASYNC-UNSAFE", "GRC-CONCURRENCY", "GRC-NULL-DEREF", "GRC-SQLI", "GRC-SSRF", "GRC-DESER-UNSAFE".

9. For DevOps/Infrastructure (Terraform, Dockerfile, YAML, Shell): Flag publicly accessible or unencrypted Terraform resources. Flag Docker FROM latest. Flag Kubernetes privileged:true or hostNetwork:true. Flag shell eval or unquoted variable expansion. Flag secrets in plaintext CI YAML env vars. Use ruleId "GRC-INFRA-EXPOSURE", "GRC-SCRIPT-INJECT", "GRC-SECRET-HARDCODED".

Add violations for any findings above using the ruleId that best matches the sector. Set aiConfidence based on certainty.`;

		const phaseBUser = `THREAT MODEL (from security analysis):
${threatModel}

RULES TO CHECK (use exact IDs):
${rulesSummary}
${fpTriggersSection}${frameworkContext ? `\nFRAMEWORK CONTEXT:\n${frameworkContext}\n` : ''}
EXISTING PATTERN VIOLATIONS:
${patternSummary}
${richContext}${dependencyContext}
FILE: ${fileName}

\`\`\`${ext}
${codeSection}
\`\`\`

Using the threat model above, find violations that match the identified data flows and broken assumptions.
For each violation, trace the data flow path that leads to it.

JSON response:
{"additionalViolations":[{"line":<number>,"ruleId":"<ID>","severity":"error|warning|info","message":"<what>","snippet":"<code max 80ch>","aiExplanation":"<why — reference specific threat model findings>","aiConfidence":"high|medium|low","dataFlowTrace":[{"file":"<filename>","line":<n>,"description":"<step>"}],"brokenAssumption":"<from threat model>","reasoningChain":[{"step":1,"observation":"<what you observed in the code — specific, not generic>","implication":"<what the observation means for compliance>","ruleRelevance":"<why this maps to the specific rule ID>"},{"step":2,"observation":"<next observation>","implication":"<implication>","ruleRelevance":"<rule relevance>"}]}],"enrichments":[{"ruleId":"<ID>","line":<n>,"aiExplanation":"<context>","aiConfidence":"high|medium|low"}],"falsePositives":[{"ruleId":"<ID>","line":<n>,"reason":"<why this is NOT a violation — specific structural reason>"}],"positiveFindings":[{"ruleId":"<ID>","line":<n>,"reason":"<why this IS confirmed a real violation — data flow or structural proof>","confidence":"high|medium|low"}]}
IMPORTANT: ALWAYS include reasoningChain with 2-4 steps for each violation. Do not omit it — it is required for audit traceability.`;

		const phaseBTimeout = this._analysisTimeout(codeSection.length + phaseBUser.length);
		return new Promise<ContractReasonResult | undefined>((resolve) => {
			const timeoutId = setTimeout(() => {
				console.warn(`[ContractReason] Phase B timed out for ${fileName} after ${phaseBTimeout / 1000}s`);
				resolve(undefined);
			}, phaseBTimeout);

			this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: [{ role: 'user', content: phaseBUser }] as LLMChatMessage[],
				separateSystemMessage: phaseBSystem,
				chatMode: null,
				modelSelection: modelSelection as any,
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				onText: () => { },
				onFinalMessage: (params: { fullText: string }) => {
					clearTimeout(timeoutId);
					const elapsed = Date.now() - startTime;
					console.log(`[ContractReason] ${fileName} two-phase analysis complete in ${elapsed}ms`);
					resolve(this._parseAnalysisResponse(params.fullText, fileUri, allEnabledRules));
				},
				onError: (err: { message: string }) => {
					clearTimeout(timeoutId);
					if (err.message && (err.message.includes('rate') || err.message.includes('429') || err.message.includes('quota'))) {
						this._rateLimiter.reportRateLimitError();
					}
					console.error(`[ContractReason] Phase B error for ${fileName}:`, err.message);
					resolve(undefined);
				},
				onAbort: () => { clearTimeout(timeoutId); resolve(undefined); },
				logging: { loggingName: `GRC-ContractReason-PhaseB-${fileName}` },
			});
		});
	}


	// ─── Function Extraction (used by single-call analysis) ─────────

	/**
	 * Extract function/method code using LSP DocumentSymbol[] ranges.
	 * Accurate line numbers from the TS language server — no regex brace counting.
	 * Falls back gracefully: returns empty array if symbols can't be flattened.
	 */
	private _extractFunctionsFromLsp(fileContent: string, symbols: any[]): Array<{
		name: string;
		startLine: number;
		endLine: number;
		code: string;
	}> {
		const lines = fileContent.split('\n');
		const results: Array<{ name: string; startLine: number; endLine: number; code: string }> = [];

		// LSP SymbolKind values for function-like nodes (Function=11, Method=5, Constructor=8, ArrowFunction is typically Method or Function)
		const FUNCTION_KINDS = new Set([5 /* Method */, 8 /* Constructor */, 11 /* Function */]);

		const flatten = (items: any[]) => {
			for (const s of items) {
				if (!s?.name || s?.range === undefined) continue;
				// range has startLineNumber/endLineNumber (VS Code IRange is 1-based)
				const startLine: number = s.range.startLineNumber ?? (s.range.start?.line !== undefined ? s.range.start.line + 1 : undefined);
				const endLine: number = s.range.endLineNumber ?? (s.range.end?.line !== undefined ? s.range.end.line + 1 : undefined);
				if (!startLine || !endLine || endLine < startLine) continue;

				if (FUNCTION_KINDS.has(s.kind as number)) {
					const codeLines = lines.slice(startLine - 1, endLine);
					if (codeLines.length >= 1) {
						results.push({
							name: s.name as string,
							startLine,
							endLine,
							code: codeLines.join('\n'),
						});
					}
				}
				if (Array.isArray(s.children)) flatten(s.children);
			}
		};
		flatten(symbols);
		return results;
	}

	private _extractFunctions(fileContent: string): Array<{
		name: string;
		startLine: number;
		endLine: number;
		code: string;
	}> {
		const functions: Array<{ name: string; startLine: number; endLine: number; code: string }> = [];
		const lines = fileContent.split('\n');

		const CONTROL_FLOW = new Set(['if', 'for', 'while', 'switch', 'do', 'else', 'try', 'catch', 'finally', 'return', 'class', 'new', 'typeof', 'instanceof', 'void', 'delete', 'throw']);

		const fnPatterns = [
			/^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
			/^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\(|function)/,
			/^\s*(?:(?:public|private|protected|static|async|override)\s+)+(\w+)\s*\([^)]*\)\s*[:{]/,
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

			if (fnName && !CONTROL_FLOW.has(fnName)) {
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

				if (endLine - i >= 2) {
					functions.push({
						name: fnName,
						startLine: i + 1,
						endLine: endLine + 1,
						code: lines.slice(i, endLine + 1).join('\n'),
					});
				}

				i = endLine;
			}
		}

		return functions;
	}


	// ─── Rule Routing & Legacy Multi-Call Helpers ───────────────────

	/**
	 * Route relevant rules to a function based on its content patterns.
	 * Optionally uses a parsed threat model (from Phase A) for semantic routing.
	 */
	private _getRelevantRules(
		fn: { name: string; code: string },
		allRules: IGRCRule[],
		_context?: INanoAgentContext,
		threatModel?: { entryPoints?: string[]; sensitiveOps?: string[]; dataFlows?: string[]; assumptions?: string[] }
	): IGRCRule[] {
		const code = fn.code.toLowerCase();
		const enabledRules = allRules.filter(r => r.enabled);

		// ── Framework rules: always include all ──
		// Any rule that declares a check.type has a concrete structural detector
		// (c-structural, iot-ot, cobol-structural, python-ast, regex, file-level, etc.).
		// These must always reach the AI — their trigger conditions exist only in code
		// patterns (|= on registers, GOTO, unhandled SQLCODE) not in English keywords,
		// so keyword filtering silently drops them. Language doesn't matter here.
		const structuralRules = enabledRules.filter(r => !!(r.check as any)?.type);

		// ── Dynamic/semantic rules: route by relevance to this file's content ──
		// Rules with no check.type are pure AI-routed rules. Only include when
		// relevant signals are found in the file.
		const semanticRules = enabledRules.filter(r => !(r.check as any)?.type);

		const relevant = new Set<IGRCRule>(structuralRules);

		// Build threat keyword set for semantic routing
		const threatKeywords = threatModel
			? [...(threatModel.entryPoints || []), ...(threatModel.sensitiveOps || []), ...(threatModel.dataFlows || [])].join(' ').toLowerCase()
			: '';

		for (const rule of semanticRules) {
			// Always include critical/blocker rules
			if (rule.severity === 'blocker' || rule.severity === 'critical') {
				relevant.add(rule);
				continue;
			}

			// Threat model semantic routing
			if (threatModel && threatKeywords) {
				const ruleTags = (rule.tags || []).map(t => t.toLowerCase());
				if (ruleTags.some(t => threatKeywords.includes(t))) { relevant.add(rule); continue; }
				if (rule.domain && threatKeywords.includes(rule.domain.toLowerCase())) { relevant.add(rule); continue; }
			}

			// Keyword matching against code content
			const tags = (rule.tags || []).map(t => t.toLowerCase());

			const isNetworkRelated = tags.some(t => ['network', 'authentication', 'api'].includes(t))
				|| code.includes('fetch') || code.includes('axios') || code.includes('http')
				|| code.includes('req.') || code.includes('res.');
			const isCryptoRelated = tags.some(t => ['crypto', 'encryption', 'hash'].includes(t))
				|| code.includes('crypto') || code.includes('encrypt') || code.includes('hash');
			const isAuthRelated = tags.some(t => ['auth', 'authentication', 'credentials', 'secrets', 'token'].includes(t))
				|| code.includes('token') || code.includes('password') || code.includes('secret')
				|| code.includes('apikey') || code.includes('api_key');
			const isDbRelated = tags.some(t => ['sql', 'database', 'sql-injection', 'db'].includes(t))
				|| code.includes('query') || code.includes('execute') || code.includes('sql');
			const isErrorHandling = tags.some(t => ['error-handling', 'async', 'exception'].includes(t))
				|| code.includes('async') || code.includes('try') || code.includes('catch');

			const ctxRelevant = _context?.capabilities && (
				(_context.capabilities.hasNetwork && isNetworkRelated) ||
				(_context.capabilities.hasCrypto && isCryptoRelated) ||
				(_context.capabilities.hasAuth && isAuthRelated)
			);

			if (isNetworkRelated || isCryptoRelated || isAuthRelated || isDbRelated || isErrorHandling || ctxRelevant) {
				relevant.add(rule);
			}
		}

		return Array.from(relevant);
	}

	private async _analyzeWholeFile(
		fileUri: URI,
		fileContent: string,
		ext: string,
		patternResults: ICheckResult[],
		rules: IGRCRule[],
		frameworkContext: string,
		modelSelection: { providerName: string; modelName: string },
		contextSnippet: string = '',
		codebaseCtx: string = '',
		richContext: string = ''
	): Promise<ContractReasonResult | undefined> {
		const CHUNK_CHARS = 8000;

		// Split large files into line-aligned chunks so no context is lost
		if (fileContent.length > CHUNK_CHARS) {
			return this._analyzeInChunks(
				fileUri, fileContent, ext, patternResults, rules,
				frameworkContext, modelSelection, contextSnippet, codebaseCtx, richContext
			);
		}

		return this._analyzeChunk(
			fileUri, fileContent, ext, patternResults, rules,
			frameworkContext, modelSelection, contextSnippet, codebaseCtx, richContext
		);
	}

	/** Single-chunk LLM call — no recursion, always sends content as-is. */
	private async _analyzeChunk(
		fileUri: URI,
		fileContent: string,
		ext: string,
		patternResults: ICheckResult[],
		rules: IGRCRule[],
		frameworkContext: string,
		modelSelection: { providerName: string; modelName: string },
		contextSnippet: string = '',
		codebaseCtx: string = '',
		richContext: string = ''
	): Promise<ContractReasonResult | undefined> {
		const patternSummary = patternResults.length > 0
			? patternResults.map(r =>
				`  Line ${r.line}: [${r.ruleId}] ${r.message.substring(0, 100)}`
			).join('\n')
			: '  (No violations found by pattern checks)';

		const truncatedCode = fileContent;

		const rulesSummary = rules.filter(r => r.enabled).map(r => {
			let entry = `- [${r.id}] "${r.message}" (severity: ${r.severity})`;
			if (r.description) entry += `\n  What to look for: ${r.description}`;
			if (r.fix) entry += `\n  Expected fix: ${r.fix}`;
			return entry;
		}).join('\n');

		const wfSystemMsg = `${codebaseCtx ? `CODEBASE CONTEXT: ${codebaseCtx}\n\n` : ''}You are a compliance auditor for critical software across all sectors and languages. You find violations that static pattern matching misses. Be conservative: only flag real issues with high confidence. Respond ONLY with valid JSON, no prose.

IMPORTANT: Never flag code inside comments, docstrings, doxygen blocks (/** ... */), or string literals as violations. Only flag executable code. A pattern appearing only in a comment or documentation block is NOT a violation.

Beyond the framework rules, also check based on the file's language/sector:

UNIVERSAL (all languages):
- PII/secret data (passwords, tokens, API keys, private keys) in logs/responses → ruleId "GRC-PII-FLOW"
- Authorization bypass (sensitive op before auth check) → ruleId "GRC-AUTH-BYPASS"
- Hardcoded credentials or secrets → ruleId "GRC-SECRET-HARDCODED"

FIRMWARE / EMBEDDED (C, C++, Assembly, Ada, Zig, Rust embedded):
- ISR shared state without volatile/atomic → ruleId "GRC-HW-UNSAFE"
- Dynamic memory (malloc/new) in ISR or RT task → ruleId "GRC-HW-UNSAFE"
- Missing watchdog kick in infinite loops → ruleId "GRC-HW-UNSAFE"
- Polling without timeout guard → ruleId "GRC-HW-UNSAFE"
- goto statement or switch without default (MISRA C) → ruleId "GRC-HW-UNSAFE"
- Non-atomic read-modify-write on hardware register → ruleId "GRC-HW-UNSAFE"

ICS / SCADA / OT (IEC 61131-3, C/C++ for PLC, AUTOSAR):
- Hardcoded credentials, IP addresses, server paths → ruleId "GRC-ICS-CRED"
- Modbus/DNP3/OPC-UA without authentication → ruleId "GRC-ICS-CRED"
- OPC-UA SecurityMode=None → ruleId "GRC-ICS-CRED"
- Safety output write without interlock check → ruleId "GRC-OT-SAFETY"
- Non-deterministic call (printf/sleep/socket) in real-time task → ruleId "GRC-OT-SAFETY"
- Missing FAULT/SAFE/EMERGENCY state in state machine → ruleId "GRC-OT-SAFETY"
- Heap allocation inside real-time or interrupt context → ruleId "GRC-OT-SAFETY"

TELECOM / 5G (TTCN-3, ASN.1, Go, C++, Python, Erlang):
- IMSI, MSISDN, SUPI, SUCI, Ki, OPC keys logged or transmitted unprotected → ruleId "GRC-TELECOM-PII"
- SIP header construction with user-controlled string concatenation → ruleId "GRC-TELECOM-PII"
- NAS message without integrity protection → ruleId "GRC-TELECOM-PII"
- Authentication keys as plaintext literals → ruleId "GRC-TELECOM-PII"
- SUCI concealment disabled (null scheme) → ruleId "GRC-TELECOM-PII"

LEGACY ENTERPRISE (COBOL, RPG, ABAP, FORTRAN, Natural, VB6):
- Unhandled file status codes after READ/WRITE/OPEN in COBOL → ruleId "GRC-LEGACY-ERRPROP"
- GOTO or ALTER statement in COBOL (unstructured control flow) → ruleId "GRC-LEGACY-FLOW"
- SQL EXEC without error handling (SQLCODE/SQLSTATE not checked) → ruleId "GRC-LEGACY-ERRPROP"
- Hardcoded literal passwords or credentials in WORKING-STORAGE → ruleId "GRC-SECRET-HARDCODED"
- Missing COMMIT/ROLLBACK pairing around DB updates → ruleId "GRC-LEGACY-TRANSACTION"
- Unbounded string MOVE without size check (COBOL buffer overflow) → ruleId "GRC-LEGACY-BOUNDS"
- RPG: missing *PSSR error subroutine in programs modifying DB records → ruleId "GRC-LEGACY-ERRPROP"
- ABAP: missing AUTHORITY-CHECK before sensitive BAPI/RFC call → ruleId "GRC-AUTH-BYPASS"
- FORTRAN: array access without explicit DIMENSION bounds check → ruleId "GRC-LEGACY-BOUNDS"

MODERN / CLOUD (TypeScript, Python, Java, Go, Rust, C#, Kotlin, Swift):
- Unhandled promise rejections / uncaught async exceptions → ruleId "GRC-ASYNC-UNSAFE"
- Race conditions on shared state in goroutines/threads → ruleId "GRC-CONCURRENCY"
- Missing null/nil/None checks before dereference → ruleId "GRC-NULL-DEREF"
- Deserializing untrusted JSON/XML/YAML without schema validation → ruleId "GRC-DESER-UNSAFE"
- SQL query built with string concatenation from user input → ruleId "GRC-SQLI"
- Server-side request forgery (SSRF) — user-controlled URL passed to HTTP client → ruleId "GRC-SSRF"

DEVOPS / INFRASTRUCTURE (Terraform, Dockerfile, YAML, Shell, PowerShell):
- Terraform resource with no encryption_at_rest or publicly_accessible=true → ruleId "GRC-INFRA-EXPOSURE"
- Docker image FROM latest (unpinned base image) → ruleId "GRC-INFRA-EXPOSURE"
- Kubernetes pod with privileged:true or hostNetwork:true → ruleId "GRC-INFRA-EXPOSURE"
- Shell script using eval or unquoted variable expansion (injection) → ruleId "GRC-SCRIPT-INJECT"
- Secrets passed as environment variables in plaintext in CI YAML → ruleId "GRC-SECRET-HARDCODED"`;

		const wfUserMsg = `Analyze this file against the compliance rules below.

FRAMEWORK UNDERSTANDING:
${frameworkContext.substring(0, 6000)}

RULES TO CHECK (use their exact IDs in your response):
${rulesSummary}

PATTERN CHECKS ALREADY FOUND:
${patternSummary}
${richContext}${contextSnippet}
FILE: ${fileUri.path.split('/').pop()}

\`\`\`${ext}
${truncatedCode}
\`\`\`

Respond with ONLY this JSON structure:
{
  "additionalViolations": [
    { "line": <number>, "ruleId": "<exact rule ID>", "severity": "error|warning|info", "message": "<what's wrong>", "snippet": "<code max 80 chars>", "aiExplanation": "<why this matters>", "aiConfidence": "high|medium|low", "reasoningChain": [{"step": 1, "observation": "<what you observed in the code — specific, not generic>", "implication": "<what the observation means for compliance>", "ruleRelevance": "<why this maps to the specific rule ID>"}, {"step": 2, "observation": "<next observation>", "implication": "<implication>", "ruleRelevance": "<rule relevance>"}] }
  ],
  "enrichments": [
    { "ruleId": "<exact rule ID>", "line": <number>, "aiExplanation": "<context explanation using actual variable names>", "aiConfidence": "high|medium|low" }
  ],
  "falsePositives": [
    { "ruleId": "<exact rule ID>", "line": <number>, "reason": "<why this is NOT a violation — specific structural reason>" }
  ],
  "positiveFindings": [
    { "ruleId": "<exact rule ID>", "line": <number>, "reason": "<why this IS confirmed a real violation — data flow or structural proof>", "confidence": "high|medium|low" }
  ]
}
IMPORTANT: ALWAYS include reasoningChain with 2-4 steps for each violation. Do not omit it — it is required for audit traceability.`;

		const wfTimeout = this._analysisTimeout(truncatedCode.length + wfUserMsg.length);
		return new Promise<ContractReasonResult | undefined>((resolve) => {
			const timeoutId = setTimeout(() => {
				console.warn(`[ContractReason] Whole-file analysis timed out for ${fileUri.path} after ${wfTimeout / 1000}s`);
				resolve(undefined);
			}, wfTimeout);

			this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: [{ role: 'user', content: wfUserMsg }] as LLMChatMessage[],
				separateSystemMessage: wfSystemMsg,
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
					if (err.message && (err.message.includes('rate') || err.message.includes('429') || err.message.includes('quota'))) {
						this._rateLimiter.reportRateLimitError();
					}
					console.error('[ContractReason] Analysis error:', err.message);
					resolve(undefined);
				},
				onAbort: () => { clearTimeout(timeoutId); resolve(undefined); },
				logging: { loggingName: 'GRC-ContractReason-WholeFile' },
			});
		});
	}

	/**
	 * Analyze a large file by splitting it into line-aligned chunks of ~8 KB each,
	 * running _analyzeChunk on each chunk sequentially, then merging all results.
	 * Line offsets in violations are preserved because each chunk knows its start line.
	 */
	private async _analyzeInChunks(
		fileUri: URI,
		fileContent: string,
		ext: string,
		patternResults: ICheckResult[],
		rules: IGRCRule[],
		frameworkContext: string,
		modelSelection: { providerName: string; modelName: string },
		contextSnippet: string,
		codebaseCtx: string,
		richContext: string,
	): Promise<ContractReasonResult | undefined> {
		const CHUNK_CHARS = 8000;
		const fileName = fileUri.path.split('/').pop() ?? '';
		const lines = fileContent.split('\n');
		const chunks: Array<{ startLine: number; content: string }> = [];

		let chunkLines: string[] = [];
		let chunkStart = 1;
		let chunkLen = 0;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			chunkLines.push(line);
			chunkLen += line.length + 1;

			if (chunkLen >= CHUNK_CHARS) {
				chunks.push({ startLine: chunkStart, content: chunkLines.join('\n') });
				chunkStart = i + 2; // next chunk starts at next line (1-based)
				chunkLines = [];
				chunkLen = 0;
			}
		}
		if (chunkLines.length > 0) {
			chunks.push({ startLine: chunkStart, content: chunkLines.join('\n') });
		}

		console.log(`[ContractReason] Chunked analysis: ${fileName} → ${chunks.length} chunks (${Math.round(fileContent.length / 1024)}KB)`);

		const allViolations: ICheckResult[] = [];
		const allFalsePositives: Array<{ ruleId: string; line: number; reason: string }> = [];
		const allEnrichments = new Map<string, { aiExplanation: string; aiConfidence: 'high' | 'medium' | 'low' }>();
		const allPositiveFindings: Array<{ ruleId: string; line: number; reason: string; confidence: 'high' | 'medium' | 'low' }> = [];

		for (let ci = 0; ci < chunks.length; ci++) {
			const chunk = chunks[ci];
			// Filter pattern results that fall in this chunk's line range
			const chunkEndLine = chunk.startLine + chunk.content.split('\n').length - 1;
			const chunkPatterns = patternResults.filter(r => r.line >= chunk.startLine && r.line <= chunkEndLine);

			const chunkHeader = chunks.length > 1
				? `\n[CHUNK ${ci + 1}/${chunks.length} — lines ${chunk.startLine}-${chunkEndLine} of ${lines.length}]\n`
				: '';

			const chunkResult = await this._analyzeChunk(
				fileUri, chunk.content, ext, chunkPatterns, rules,
				frameworkContext, modelSelection,
				chunkHeader + contextSnippet, codebaseCtx, richContext
			);

			if (chunkResult) {
				// Violations use line numbers relative to the chunk — offset them back to file-absolute
				const lineOffset = chunk.startLine - 1;
				for (const v of chunkResult.additionalViolations) {
					allViolations.push({ ...v, line: v.line + lineOffset, endLine: (v.endLine ?? v.line) + lineOffset });
				}
				for (const fp of chunkResult.falsePositiveFlags) {
					allFalsePositives.push({ ...fp, line: fp.line + lineOffset });
				}
				chunkResult.enrichments.forEach((val, key) => {
					const [ruleId, lineStr] = key.split(':');
					const absLine = parseInt(lineStr, 10) + lineOffset;
					allEnrichments.set(`${ruleId}:${absLine}`, val);
				});
				for (const pf of (chunkResult.positiveFindings ?? [])) {
					allPositiveFindings.push({ ...pf, line: pf.line + lineOffset });
				}
			}
		}

		return {
			additionalViolations: allViolations,
			falsePositiveFlags: allFalsePositives,
			enrichments: allEnrichments,
			positiveFindings: allPositiveFindings,
			fileUri,
		};
	}

	// ─── Response Parsing ────────────────────────────────────────────

	/** Timeout in ms scaled to prompt length: 30s base + 1s per 1 KB, capped at 120s. */
	private _analysisTimeout(promptLength: number): number {
		return Math.min(30_000 + Math.floor(promptLength / 1000) * 1000, 120_000);
	}

	private _parseAnalysisResponse(
		response: string,
		fileUri: URI,
		rules: IGRCRule[],
		riskScore?: number
	): ContractReasonResult | undefined {
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

			// Synthetic rules for built-in AI classification checks (not in the rule registry).
			// These cover all sectors — firmware, ICS, telecom, legacy enterprise, modern, devops.
			const SYNTHETIC_RULES: Record<string, { domain: string; severity: string; message: string }> = {
				// Universal
				'GRC-PII-FLOW':              { domain: 'data-privacy',        severity: 'error',   message: 'PII or secret data flows to an unsafe sink' },
				'GRC-AUTH-BYPASS':           { domain: 'security',            severity: 'error',   message: 'Sensitive operation reachable without authorization check' },
				'GRC-SECRET-HARDCODED':      { domain: 'security',            severity: 'error',   message: 'Hardcoded credential, API key, or secret literal in source code' },
				// Firmware / embedded
				'GRC-HW-UNSAFE':             { domain: 'firmware-safety',     severity: 'error',   message: 'Unsafe hardware register access or unguarded shared ISR state' },
				// ICS / OT
				'GRC-ICS-CRED':              { domain: 'ics-security',        severity: 'error',   message: 'Hardcoded credential or insecure SCADA/ICS protocol configuration' },
				'GRC-OT-SAFETY':             { domain: 'ot-safety',           severity: 'error',   message: 'Industrial OT safety violation — real-time constraint, interlock, or redundancy gap' },
				// Telecom / 5G
				'GRC-TELECOM-PII':           { domain: 'telecom-security',    severity: 'error',   message: 'Subscriber identity (IMSI/MSISDN/SUPI) or auth key exposed without protection' },
				// Legacy enterprise
				'GRC-LEGACY-ERRPROP':        { domain: 'legacy-safety',       severity: 'error',   message: 'Error status code not checked after I/O or DB operation' },
				'GRC-LEGACY-FLOW':           { domain: 'legacy-safety',       severity: 'warning', message: 'Unstructured control flow (GOTO/ALTER) in legacy code' },
				'GRC-LEGACY-TRANSACTION':    { domain: 'legacy-safety',       severity: 'error',   message: 'Missing COMMIT/ROLLBACK pairing around database update' },
				'GRC-LEGACY-BOUNDS':         { domain: 'legacy-safety',       severity: 'error',   message: 'Unbounded string or array operation without size guard' },
				// Modern / cloud
				'GRC-ASYNC-UNSAFE':          { domain: 'reliability',         severity: 'warning', message: 'Unhandled promise rejection or uncaught async exception' },
				'GRC-CONCURRENCY':           { domain: 'reliability',         severity: 'error',   message: 'Race condition on shared state in concurrent execution context' },
				'GRC-NULL-DEREF':            { domain: 'reliability',         severity: 'error',   message: 'Potential null/nil/None dereference without guard check' },
				'GRC-DESER-UNSAFE':          { domain: 'security',            severity: 'error',   message: 'Untrusted data deserialized without schema validation' },
				'GRC-SQLI':                  { domain: 'security',            severity: 'error',   message: 'SQL query constructed with user-controlled string concatenation' },
				'GRC-SSRF':                  { domain: 'security',            severity: 'error',   message: 'Server-side request forgery — user-controlled URL passed to HTTP client' },
				// DevOps / infrastructure
				'GRC-INFRA-EXPOSURE':        { domain: 'infrastructure',      severity: 'error',   message: 'Infrastructure resource publicly exposed or unencrypted' },
				'GRC-SCRIPT-INJECT':         { domain: 'security',            severity: 'error',   message: 'Shell script injection via eval or unquoted variable expansion' },
			};

			// Convert additional violations to ICheckResult[]
			const additionalViolations: ICheckResult[] = [];
			for (const v of (data.additionalViolations || [])) {
				const rule = ruleMap.get(v.ruleId);
				const synthetic = SYNTHETIC_RULES[v.ruleId];
				if (!rule && !synthetic) continue; // Skip violations referencing unknown rules

				const effectiveDomain = rule?.domain ?? synthetic!.domain;
				const effectiveSeverity = rule?.severity ?? synthetic!.severity;

				additionalViolations.push({
					ruleId: v.ruleId,
					domain: effectiveDomain,
					severity: toDisplaySeverity(v.severity || effectiveSeverity),
					message: `[${v.ruleId}] ${v.message}`,
					fileUri: fileUri,
					line: v.line || 1,
					column: 1,
					endLine: v.line || 1,
					endColumn: (v.snippet?.length || 0) + 1,
					codeSnippet: v.snippet,
					fix: rule?.fix,
					timestamp: now,
					frameworkId: rule?.frameworkId,
					references: rule?.references,
					blockingBehavior: rule?.blockingBehavior,
					// AI-generated fields
					checkSource: 'ai' as const,
					aiExplanation: v.aiExplanation || rule?.description || `AI detected a potential ${effectiveDomain} violation.`,
					aiConfidence: v.aiConfidence || 'medium',
					// Deep analysis fields
					dataFlowTrace: Array.isArray(v.dataFlowTrace) ? v.dataFlowTrace : undefined,
					brokenAssumption: v.brokenAssumption || undefined,
					riskScore: riskScore,
				});

				// Extract reasoningChain if present
				const lastViolation = additionalViolations[additionalViolations.length - 1];
				if (lastViolation && Array.isArray(v.reasoningChain)) {
					lastViolation.reasoningChain = v.reasoningChain
						.filter((step: any) => step && typeof step === 'object')
						.map((step: any, idx: number) => ({
							step: typeof step.step === 'number' ? step.step : idx + 1,
							observation: String(step.observation ?? '').slice(0, 500),
							implication: String(step.implication ?? '').slice(0, 500),
							ruleRelevance: String(step.ruleRelevance ?? '').slice(0, 300),
						}))
						.filter((step: { observation: string; implication: string; ruleRelevance: string; step: number }) => step.observation.length > 0)
						.slice(0, 10); // cap at 10 steps
				}
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

			// Parse positiveFindings — AI confirmations that static findings are real
			const positiveFindings: Array<{ ruleId: string; line: number; reason: string; confidence: 'high' | 'medium' | 'low' }> = [];
			for (const p of (data.positiveFindings || [])) {
				if (p.ruleId && p.line) {
					positiveFindings.push({
						ruleId: String(p.ruleId),
						line: Number(p.line),
						reason: String(p.reason ?? ''),
						confidence: p.confidence === 'high' || p.confidence === 'low' ? p.confidence : 'medium',
					});
				}
			}

			return {
				additionalViolations,
				falsePositiveFlags: data.falsePositives || [],
				enrichments,
				positiveFindings,
				fileUri,
			};
		} catch (e) {
			console.error('[ContractReason] Failed to parse LLM response:', e);
			return undefined;
		}
	}


	// ─── One-Shot Query ─────────────────────────────────────────────

	/**
	 * Send a single prompt to the LLM, rate-limited.
	 * Used for non-file-analysis queries like ignore suggestions.
	 */
	public async sendOneShotQuery(prompt: string): Promise<string | undefined> {
		if (!this.isAvailable) return undefined;

		const modelSelection = this._getModelSelection();
		if (!modelSelection) return undefined;

		let response: string | undefined;
		await this._rateLimiter.enqueue(async () => {
			response = await new Promise<string | undefined>((resolve) => {
				const timeoutId = setTimeout(() => resolve(undefined), 30_000);

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
						this._rateLimiter.reportSuccess();
						resolve(params.fullText);
					},
					onError: (err: { message: string }) => {
						clearTimeout(timeoutId);
						if (err.message && (err.message.includes('rate') || err.message.includes('429') || err.message.includes('quota'))) {
							this._rateLimiter.reportRateLimitError();
						}
						console.error('[ContractReason] One-shot query error:', err.message);
						resolve(undefined);
					},
					onAbort: () => { clearTimeout(timeoutId); resolve(undefined); },
					logging: { loggingName: 'GRC-ContractReason-OneShot' },
				});
			});
		});

		return response;
	}


	// ─── Scan Tracker API ────────────────────────────────────────────

	public getScanTrackerState(): IScanTrackerState {
		const entries = Array.from(this._scanEntries.values());
		return {
			entries,
			totalFiles: entries.length,
			scannedCount: entries.filter(e => e.status === 'scanned').length,
			skippedCount: entries.filter(e => e.status === 'skipped').length,
			errorCount: entries.filter(e => e.status === 'error').length,
			scanningCount: entries.filter(e => e.status === 'scanning').length,
			isScanning: this._isScanning,
			lastScanCompleted: this._lastScanCompleted,
			periodicScanActive: this._periodicScanActive,
			periodicScanIntervalMs: this._periodicScanIntervalMs,
		};
	}

	public scanTrackerBeginScan(fileUris: URI[], riskScores?: Map<string, number>): void {
		this._isScanning = true;
		for (const uri of fileUris) {
			const key = uri.toString();
			const riskScore = riskScores?.get(key);
			// Only set to pending if not already tracked from a previous scan
			if (!this._scanEntries.has(key)) {
				this._scanEntries.set(key, {
					fileUri: key,
					fileName: uri.path.split('/').pop() || 'unknown',
					status: 'pending',
					timestamp: Date.now(),
					riskScore,
				});
			} else {
				// Re-queue: reset to pending unless already scanned with same hash
				const existing = this._scanEntries.get(key)!;
				if (existing.status !== 'scanned' && existing.status !== 'skipped') {
					existing.status = 'pending';
					existing.timestamp = Date.now();
				}
				// Always update risk score when available
				if (riskScore !== undefined) existing.riskScore = riskScore;
			}
		}
		this._fireScanTrackerUpdate();
	}

	public scanTrackerEndScan(): void {
		this._isScanning = false;
		this._lastScanCompleted = Date.now();
		this._fireScanTrackerUpdate();
	}

	public scanTrackerReset(): void {
		this._scanEntries.clear();
		this._fireScanTrackerUpdate();
	}

	public scanTrackerSetPeriodicState(active: boolean, intervalMs?: number): void {
		this._periodicScanActive = active;
		if (intervalMs !== undefined) {
			this._periodicScanIntervalMs = intervalMs;
		}
		this._fireScanTrackerUpdate();
	}

	/** Internal: mark a file as scanning */
	private _scanTrackerMarkScanning(fileUri: URI): void {
		const key = fileUri.toString();
		const entry = this._scanEntries.get(key);
		if (entry) {
			entry.status = 'scanning';
			entry.timestamp = Date.now();
		} else {
			this._scanEntries.set(key, {
				fileUri: key,
				fileName: fileUri.path.split('/').pop() || 'unknown',
				status: 'scanning',
				timestamp: Date.now(),
			});
		}
		this._fireScanTrackerUpdate();
	}

	/** Internal: mark a file as scanned with result count */
	private _scanTrackerMarkScanned(fileUri: URI, violationCount: number): void {
		const key = fileUri.toString();
		const entry = this._scanEntries.get(key) || {
			fileUri: key,
			fileName: fileUri.path.split('/').pop() || 'unknown',
			status: 'scanned' as const,
			timestamp: Date.now(),
		};
		entry.status = 'scanned';
		entry.violationCount = violationCount;
		entry.timestamp = Date.now();
		this._scanEntries.set(key, entry);
		this._fireScanTrackerUpdate();
	}

	/** Internal: mark a file as skipped (cache hit or duplicate) */
	private _scanTrackerMarkSkipped(fileUri: URI, reason: string): void {
		const key = fileUri.toString();
		const entry = this._scanEntries.get(key) || {
			fileUri: key,
			fileName: fileUri.path.split('/').pop() || 'unknown',
			status: 'skipped' as const,
			timestamp: Date.now(),
		};
		entry.status = 'skipped';
		entry.skipReason = reason;
		entry.timestamp = Date.now();
		this._scanEntries.set(key, entry);
		// Don't fire on every skip during bulk scan — too noisy
	}

	/** Internal: mark a file as errored */
	private _scanTrackerMarkError(fileUri: URI, errorMessage: string): void {
		const key = fileUri.toString();
		const entry = this._scanEntries.get(key) || {
			fileUri: key,
			fileName: fileUri.path.split('/').pop() || 'unknown',
			status: 'error' as const,
			timestamp: Date.now(),
		};
		entry.status = 'error';
		entry.errorMessage = errorMessage;
		entry.timestamp = Date.now();
		this._scanEntries.set(key, entry);
		this._fireScanTrackerUpdate();
	}

	private _fireScanTrackerUpdate(): void {
		this._onDidScanTrackerUpdate.fire(this.getScanTrackerState());
	}


	// ─── Helpers ─────────────────────────────────────────────────────

	/**
	 * Extract exported signatures from source content, capped at `maxChars`.
	 * Handles TypeScript/JS, C/C++, Python, and falls back to the first 20 lines
	 * for other languages.
	 */
	private _extractSignatures(content: string, maxChars: number): string {
		const lines = content.split('\n');
		const collected: string[] = [];

		// Detect language from first substantive lines
		const sampleLines = lines.slice(0, 30).join('\n').toLowerCase();
		const isTs = /import\s+|export\s+|interface\s+|type\s+\w+\s*=/.test(sampleLines);
		const isPy = /^def |^class |^async def /.test(sampleLines);
		const isC = /#include\s+|^[a-zA-Z_].*\(.*\).*[;{]/.test(sampleLines);

		if (isTs) {
			// TypeScript/JS: export declarations + next 3 lines for param lists
			const exportRe = /^export\s+(function|class|interface|type|const|enum|abstract)/;
			for (let i = 0; i < lines.length; i++) {
				if (exportRe.test(lines[i])) {
					const chunk = lines.slice(i, i + 4).join('\n');
					collected.push(chunk);
				}
			}
		} else if (isPy) {
			// Python: function and class declarations
			const pyRe = /^(?:def |class |async def )/;
			for (let i = 0; i < lines.length; i++) {
				if (pyRe.test(lines[i])) {
					collected.push(lines[i]);
				}
			}
		} else if (isC) {
			// C/C++: function prototypes and definitions
			const cRe = /^[a-zA-Z_].*\(.*\).*[;{]/;
			for (const line of lines) {
				if (cRe.test(line)) {
					collected.push(line);
				}
			}
		} else {
			// Generic fallback: first 20 lines
			collected.push(...lines.slice(0, 20));
		}

		const joined = collected.join('\n');
		if (joined.length <= maxChars) return joined;
		return joined.substring(0, maxChars) + '\n[...truncated]';
	}

	/**
	 * Build a 2-hop BFS cross-file dependency context for the LLM analysis prompt.
	 *
	 * Hop 1 — direct imports of `fileUri` + files that directly import `fileUri`.
	 * Hop 2 — their imports + their importers.
	 *
	 * Hop-1 files contribute up to 2000 chars (exported signatures via _extractSignatures).
	 * Hop-2 files contribute up to 800 chars (exports/type declarations only).
	 * Total output is capped at `totalBudgetChars`.
	 */
	private _buildMultiHopDependencyContext(
		fileUri: URI,
		allFileContents: Map<string, string> | undefined,
		importedByMap: ReadonlyMap<string, readonly string[]>,
		maxHops: number = 2,
		totalBudgetChars: number = 8000
	): string {
		if (!allFileContents || allFileContents.size === 0) return '';

		const targetUriStr = fileUri.toString();
		const targetPath = fileUri.path;
		const targetDir = targetPath.replace(/\/[^/]+$/, '');
		const targetBasePath = targetPath.replace(/\.[^/.]+$/, '');
		const targetContent = allFileContents.get(targetUriStr) ?? '';

		// Shared import regex for parsing direct imports from any file
		const importRegex = /(?:import|require)\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)?\s*(?:from\s*)?['"](\.[^'"]+)['"]/g;

		/**
		 * Resolve the direct imports (relative paths) of a given file.
		 * Returns an array of matched URI strings from allFileContents.
		 */
		const resolveDirectImports = (content: string, dirPath: string): string[] => {
			const results: string[] = [];
			const re = new RegExp(importRegex.source, importRegex.flags);
			let m: RegExpExecArray | null;
			while ((m = re.exec(content)) !== null) {
				const relPath = m[1];
				let resolved = dirPath;
				for (const part of relPath.split('/')) {
					if (part === '.' || part === '') continue;
					if (part === '..') { resolved = resolved.replace(/\/[^/]+$/, ''); }
					else resolved = `${resolved}/${part}`;
				}
				const resolvedBase = resolved.replace(/\.[^/.]+$/, '');

				// Find matching URI in allFileContents
				for (const uriStr of allFileContents.keys()) {
					if (uriStr === targetUriStr) continue;
					try {
						const uriPath = URI.parse(uriStr).path;
						const uriBase = uriPath.replace(/\.[^/.]+$/, '');
						if (uriBase === resolvedBase || uriBase.endsWith('/' + resolvedBase.split('/').pop()!)) {
							results.push(uriStr);
							break;
						}
					} catch { /* malformed URI — skip */ }
				}
			}
			return results;
		};

		/**
		 * Find files in allFileContents that import the given basePath (no extension).
		 * Uses the importedByMap first (fast); falls back to a simple content scan.
		 */
		const findDirectDependents = (basePath: string): string[] => {
			const results: string[] = [];

			// Primary: use the engine-provided importedByMap
			for (const [key, importers] of importedByMap) {
				if (key === basePath || key.startsWith(basePath + '/') || basePath.endsWith('/' + key)) {
					for (const imp of importers) {
						if (imp !== targetUriStr && allFileContents.has(imp)) {
							results.push(imp);
						}
					}
				}
			}

			// Secondary: lightweight content scan for cases not in the map
			if (results.length === 0) {
				const baseName = basePath.split('/').pop() || '';
				for (const [uriStr, content] of allFileContents) {
					if (uriStr === targetUriStr) continue;
					if (
						content.includes(`'${baseName}'`) ||
						content.includes(`"${baseName}"`) ||
						content.includes(`/${baseName}'`) ||
						content.includes(`/${baseName}"`)
					) {
						results.push(uriStr);
					}
				}
			}

			return results;
		};

		// ── BFS ──────────────────────────────────────────────────────────
		const visited = new Set<string>([targetUriStr]);

		// Hop 1
		const hop1Imports = resolveDirectImports(targetContent, targetDir);
		const hop1Dependents = findDirectDependents(targetBasePath);
		const hop1Uris = [...new Set([...hop1Imports, ...hop1Dependents])].filter(u => !visited.has(u));
		for (const u of hop1Uris) visited.add(u);

		// Hop 2 (only if requested)
		const hop2UrisSet = new Set<string>();
		if (maxHops >= 2) {
			for (const hop1Uri of hop1Uris) {
				const hop1Content = allFileContents.get(hop1Uri) ?? '';
				let hop1Dir: string;
				try {
					hop1Dir = URI.parse(hop1Uri).path.replace(/\/[^/]+$/, '');
				} catch { continue; }

				const hop2Imports = resolveDirectImports(hop1Content, hop1Dir);
				const hop1BasePath = (() => {
					try { return URI.parse(hop1Uri).path.replace(/\.[^/.]+$/, ''); } catch { return ''; }
				})();
				const hop2Dependents = findDirectDependents(hop1BasePath);

				for (const u of [...hop2Imports, ...hop2Dependents]) {
					if (!visited.has(u)) hop2UrisSet.add(u);
				}
			}
		}
		const hop2Uris = Array.from(hop2UrisSet);

		if (hop1Uris.length === 0 && hop2Uris.length === 0) return '';

		// ── Build output sections ─────────────────────────────────────────
		const sections: string[] = [];
		let budgetUsed = 0;

		const targetName = targetPath.split('/').pop() || 'unknown';

		for (const uriStr of hop1Uris) {
			if (budgetUsed >= totalBudgetChars) break;
			const content = allFileContents.get(uriStr) ?? '';
			if (!content) continue;

			let label: string;
			try {
				label = URI.parse(uriStr).path.split('/').pop() || uriStr;
			} catch { label = uriStr.split('/').pop() || uriStr; }

			const isImport = hop1Imports.includes(uriStr);
			const tag = isImport ? 'hop-1 dep' : 'hop-1 dependent';
			const maxAlloc = Math.min(2000, totalBudgetChars - budgetUsed);
			const signatures = this._extractSignatures(content, maxAlloc);

			const block = `--- [${tag}] ${label} ---\n${signatures}`;
			sections.push(block);
			budgetUsed += block.length;
		}

		for (const uriStr of hop2Uris) {
			if (budgetUsed >= totalBudgetChars) break;
			const content = allFileContents.get(uriStr) ?? '';
			if (!content) continue;

			let label: string;
			try {
				label = URI.parse(uriStr).path.split('/').pop() || uriStr;
			} catch { label = uriStr.split('/').pop() || uriStr; }

			const maxAlloc = Math.min(800, totalBudgetChars - budgetUsed);
			const signatures = this._extractSignatures(content, maxAlloc);

			const block = `--- [hop-2] ${label} ---\n${signatures}`;
			sections.push(block);
			budgetUsed += block.length;
		}

		if (sections.length === 0) return '';

		return `\n\n=== Cross-File Context (2-hop) ===
These files are connected to ${targetName} via import relationships. Check for:
- Tainted data flowing across file boundaries
- Missing validation at import boundaries
- Inconsistent error handling across the call chain
- Auth checks bypassed by callers

${sections.join('\n\n')}`;
	}

	/**
	 * Build a short TS compiler diagnostics section from nano agent context.
	 * The nano agent already reads IMarkerService for the file and stores error/warning
	 * counts in context.metrics — but we also get the raw markers via IMarkerService
	 * in diagnostics field. We use what's available.
	 *
	 * This lets the AI know the TS language server already flagged type issues — it can
	 * correlate those with GRC rule violations (e.g. implicit any → paramTypeIsAny rule).
	 */
	private _buildLspDiagnosticsSection(context?: INanoAgentContext): string {
		const diag = context?.diagnostics;
		if (!diag || (diag.errorCount === 0 && diag.warningCount === 0)) return '';

		let section = `\nTS COMPILER DIAGNOSTICS (live from VS Code language server — real type errors in this file):
  Errors: ${diag.errorCount}, Warnings: ${diag.warningCount}`;

		if (diag.errors && diag.errors.length > 0) {
			section += '\n  Error details:';
			for (const e of diag.errors.slice(0, 8)) {
				section += `\n    L${e.line}: ${e.message.substring(0, 120)}`;
			}
		}
		section += '\n  (Use these as additional evidence when assessing type-safety rules — they confirm the TS compiler agrees)\n';
		return section;
	}

	/**
	 * Inject type signatures (hoverProvider) into AI prompt.
	 * Each entry: `functionName(param: Type): ReturnType` from the TS language server.
	 * The AI can use these to detect type-safety GRC violations without guessing.
	 */
	private _buildTypeSignaturesSection(context?: INanoAgentContext): string {
		const sigs = context?.typeSignatures;
		if (!sigs?.length) return '';

		const lines = sigs.slice(0, 25).map(s => `  L${s.line} [${s.kind}] ${s.name}: ${s.signature}`).join('\n');
		return `\nTYPE SIGNATURES (from VS Code TS language server — exact inferred types, use these to assess type-safety rules):\n${lines}\n`;
	}

	/**
	 * Inject reference counts (referenceProvider) into AI prompt.
	 * Symbols with high cross-file reference counts have larger blast radius.
	 */
	private _buildReferenceInfoSection(context?: INanoAgentContext): string {
		const refs = context?.referenceInfo;
		if (!refs?.length) return '';

		// Only include symbols with cross-file references (truly exported/shared)
		const shared = refs.filter(r => r.crossFileCount > 0).slice(0, 15);
		if (!shared.length) return '';

		const lines = shared.map(r =>
			`  ${r.name} (L${r.line}): ${r.referenceCount} total refs, ${r.crossFileCount} cross-file`
		).join('\n');
		return `\nSYMBOL REFERENCE COUNTS (cross-file usage — violations in high-ref symbols have larger blast radius):\n${lines}\n`;
	}

	/**
	 * Inject inlay hints (inlayHintsProvider) into AI prompt.
	 * Reveals implicit `any` inferences and missing type annotations the TS server computed.
	 */
	private _buildInlayHintsSection(context?: INanoAgentContext): string {
		const hints = context?.inlayHints;
		if (!hints?.length) return '';

		// Filter to type hints only (kind='type') — parameter hints at call sites are noise for GRC
		const typeHints = hints.filter(h => h.kind === 'type').slice(0, 20);
		if (!typeHints.length) return '';

		const lines = typeHints.map(h => `  L${h.line}:${h.column} ${h.label}`).join('\n');
		return `\nINLAY TYPE HINTS (inferred types VS Code shows inline — reveals implicit any and unannotated variables):\n${lines}\n`;
	}

	/**
	 * Inject definition resolution (definitionProvider) into AI prompt.
	 * Tells AI whether imports are from node_modules (external, untrusted) or workspace.
	 */
	private _buildDefinitionMapSection(context?: INanoAgentContext): string {
		const defs = context?.definitionMap;
		if (!defs?.length) return '';

		const external = defs.filter(d => d.isExternal).slice(0, 10);
		const workspace = defs.filter(d => d.isWorkspace).slice(0, 10);
		if (!external.length && !workspace.length) return '';

		let section = '\nIMPORT RESOLUTION (from VS Code definition provider):';
		if (external.length) {
			section += `\n  External (node_modules): ${external.map(d => d.name).join(', ')}`;
		}
		if (workspace.length) {
			section += `\n  Workspace-internal: ${workspace.map(d => `${d.name} → ${d.resolvedUri}`).join(', ')}`;
		}
		return section + '\n';
	}

	private _buildContextFilesSnippet(contextFiles?: Map<string, string>): string {
		if (!contextFiles || contextFiles.size === 0) return '';

		const MAX_FILES = 5;
		const MAX_CHARS_PER_FILE = 2000;
		const entries = Array.from(contextFiles.entries()).slice(0, MAX_FILES);

		const snippets = entries.map(([uriStr, content]) => {
			const fileName = uriStr.split('/').pop() || 'unknown';
			const truncated = content.length > MAX_CHARS_PER_FILE
				? content.substring(0, MAX_CHARS_PER_FILE) + '\n... (truncated)'
				: content;
			return `--- ${fileName} ---\n${truncated}`;
		}).join('\n\n');

		return `\n\nCONTEXT FILES (excluded from scanning, for reference only — tests, mocks, configs):\n${snippets}`;
	}

	/**
	 * Extract only the rule context entries relevant to the current file's rule set.
	 *
	 * If `understanding` is structured JSON (from the new comprehension format), we filter
	 * to only the rules in `relevantRuleIds` before serialising, keeping the prompt focused.
	 * If it's freeform text (old-format cache), we fall back to a plain substring.
	 */
	private _extractRelevantRuleContext(understanding: string, relevantRuleIds: Set<string>, maxChars: number): string {
		try {
			const parsed = JSON.parse(understanding);
			if (parsed && typeof parsed === 'object' && parsed.rules && typeof parsed.rules === 'object') {
				// Structured comprehension — filter to relevant rules only
				const filteredRules: Record<string, unknown> = {};
				for (const ruleId of Object.keys(parsed.rules)) {
					if (relevantRuleIds.has(ruleId)) {
						filteredRules[ruleId] = parsed.rules[ruleId];
					}
				}
				const filtered = {
					schemaVersion: parsed.schemaVersion,
					rules: filteredRules,
					crossRuleRelationships: (parsed.crossRuleRelationships || []).filter(
						(rel: { rules?: string[] }) =>
							Array.isArray(rel.rules) && rel.rules.some((id: string) => relevantRuleIds.has(id))
					),
				};
				const serialised = JSON.stringify(filtered);
				return serialised.length > maxChars ? serialised.substring(0, maxChars) : serialised;
			}
		} catch {
			// Not valid JSON — fall through to substring fallback
		}
		// Old-format cache (freeform text)
		return understanding.substring(0, maxChars);
	}

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

	/**
	 * Compute a djb2 hash of all rule check definitions + ids + severities.
	 * Used for per-rule targeted cache invalidation in comprehendFramework.
	 */
	private _computeRulesHash(rules: IGRCRule[]): string {
		const source = rules.map(r => `${r.id}:${r.severity}:${JSON.stringify(r.check ?? r.pattern)}`).join('|');
		let hash = 5381;
		for (let i = 0; i < source.length; i++) {
			hash = ((hash << 5) + hash) ^ source.charCodeAt(i);
			hash = hash >>> 0; // keep unsigned 32-bit
		}
		return hash.toString(16);
	}

	/**
	 * Record a user-dismissed violation as a confirmed false positive.
	 * Delegates to IViolationFeedbackService so the next AI scan will be
	 * skeptical of the same pattern in the same file.
	 */
	public dismissViolation(result: ICheckResult, reason?: string): void {
		this.violationFeedbackService.dismiss(result, reason);
	}

	public clearAnalysisCache(): void {
		this._resultCache.clear();
		this._persistedHashes.clear();
		// Persist the cleared state so it survives IDE restart
		this.storageService.remove(ContractReasonService.FILE_HASH_STORAGE_KEY, StorageScope.WORKSPACE);
		console.log('[ContractReason] Analysis cache cleared — all files will be re-analysed on next scan');
	}


	// ─── Imported-By Map (cross-file wiring) ─────────────────────────

	public get importedByMap(): ReadonlyMap<string, readonly string[]> {
		return this._importedByMap;
	}

	public setImportedByMap(map: ReadonlyMap<string, readonly string[]>): void {
		this._importedByMap = map;
	}

}


// ─── Registration ────────────────────────────────────────────────────────────

registerSingleton(IContractReasonService, ContractReasonService, InstantiationType.Delayed);
