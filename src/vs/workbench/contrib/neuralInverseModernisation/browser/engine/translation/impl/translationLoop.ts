/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Translation Loop
 *
 * Executes the full 5-step translation sequence for a single knowledge unit.
 * This is the innermost worker that `batchTranslationEngine.ts` calls concurrently.
 *
 * ## The 5 Steps
 *
 * ```
 * Step 1 — Resolve
 *   Verify that resolved source is available.
 *   Acquire a KB unit lock to prevent concurrent double-translation.
 *
 * Step 2 — Context
 *   Load IResolvedUnitContext from the KB (decisions, glossary, interfaces…).
 *   Build the IBuiltTranslationContext, applying token budget management.
 *   If source exceeds the token budget even after trimming \u2192 route to chunker.
 *
 * Step 3 — Model selection
 *   Resolve the LLM model to use (Checks feature \u2192 fallback to Chat).
 *
 * Step 4 — Translate (with retries)
 *   Call the LLM with the built prompt.
 *   Parse the XML-tagged response into ITranslationParseResult.
 *   On failure: retry up to `maxRetries` times, injecting the specific
 *   verification failures from the previous attempt into the retry prompt.
 *
 * Step 5 — Verify
 *   Run the deterministic verification suite (8 checks).
 *   If blockers remain after all retries, produce outcome='blocked'.
 *
 * Step 6 — Extract decisions
 *   Promote raw IRaisedDecision[] \u2192 IPendingDecision[] with IDs and timestamps.
 *   Determine final TranslationOutcome based on confidence and decisions.
 * ```
 *
 * ## Chunked translation
 *
 * When the resolved source is too large to fit within the token budget — even after
 * all context sections have been trimmed — the loop delegates to `runChunkedTranslation()`.
 * That function uses `splitIntoChunks()` to break the ORIGINAL (untruncated) source into
 * language-aware sections, translates each chunk independently with full context, then
 * stitches the results using `stitchChunks()`.
 *
 * Detection: `ctx.isSourceTruncated === true` after `buildTranslationContext()`.
 *
 * ## Unit locking
 *
 * The KB has a `lockUnit()/unlockUnit()` API for multi-agent concurrency.
 * The loop acquires a lock before starting and releases it in a `finally` block,
 * regardless of outcome. Lock TTL = 10 minutes (enough for even the slowest LLM).
 * If the unit is already locked (another concurrent job), the loop returns 'skipped'.
 *
 * ## Abort support
 *
 * The caller passes an `AbortSignal`. The loop checks it between steps and between
 * retries. The current LLM request is also cancelled via the `requestId` returned
 * by `sendLLMMessage()`.
 *
 * ## Error contract
 *
 * `runTranslationLoop()` NEVER throws. All failures produce an `ITranslationResult`
 * with `outcome = 'error'` and the error message in `result.error`.
 */

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { IKnowledgeUnit, IPendingDecision } from '../../../../common/knowledgeBaseTypes.js';
import { analyzeUnitDebt } from '../../discovery/techDebtAnalyzer.js';
import { ITechDebtItem } from '../../discovery/discoveryTypes.js';
import { ILLMMessageService } from '../../../../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../../../../../void/common/voidSettingsService.js';
import { ModelSelection } from '../../../../../void/common/voidSettingsTypes.js';
import {
	ITranslationOptions,
	ITranslationResult,
	ITranslationParseResult,
	ITranslationVerificationResult,
	IBuiltTranslationContext,
	IVerificationCheck,
	IRaisedDecision,
	TranslationConfidence,
	TranslationOutcome,
} from './translationTypes.js';
import { buildTranslationContext } from './translationContextBuilder.js';
import { buildTranslationPrompt } from './translationPromptBuilder.js';
import { parseTranslationResponse } from './translationResultParser.js';
import { verifyTranslation } from './translationVerifier.js';
import { extractDecisions } from './decisionExtractor.js';
import {
	splitIntoChunks,
	stitchChunks,
	buildChunkContextPrefix,
	IChunkStitchInput,
} from './translationChunker.js';


// ─── Constants ────────────────────────────────────────────────────────────────

const LOGGING_NAME = 'ModernisationTranslationEngine';
const LOCK_OWNER   = 'translation-engine';
const LOCK_TTL_MS  = 10 * 60 * 1000; // 10 minutes

/** Minimum acceptable translated code length in characters */
const MIN_TRANSLATED_LENGTH = 10;

/** Preceding-output stub: last N lines of previous chunk injected as boundary context */
const PRECEDING_STUB_LINES = 25;

/** Confidence ordering from best to worst (for min-confidence aggregation across chunks) */
const CONFIDENCE_ORDER: TranslationConfidence[] = ['high', 'medium', 'low', 'uncertain'];


// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Execute the full translation loop for a single knowledge unit.
 *
 * @param unitId   The ID of the unit to translate
 * @param options  Translation run options
 * @param kb       Knowledge Base service
 * @param llm      LLM message service
 * @param settings Void settings service (for model selection)
 * @param signal   Abort signal — checked between steps and retries
 * @returns        A fully populated ITranslationResult (never throws)
 */
export async function runTranslationLoop(
	unitId: string,
	options: ITranslationOptions,
	kb: IKnowledgeBaseService,
	llm: ILLMMessageService,
	settings: IVoidSettingsService,
	signal: AbortSignal,
	migrationPatternId?: string,
): Promise<ITranslationResult> {
	const startMs = Date.now();
	let lockAcquired = false;

	try {
		// ── Step 1: Resolve ──────────────────────────────────────────────────────
		const unit = kb.getUnit(unitId);
		if (!unit) {
			return makeErrorResult(unitId, 'unknown', options.targetLanguage, startMs, 'Unit not found in KB');
		}
		if (signal.aborted) {
			return makeSkippedResult(unit.id, unit.name, unit.sourceLang, options.targetLanguage, startMs);
		}
		if (!unit.resolvedSource || unit.resolvedSource.trim().length === 0) {
			return makeErrorResult(unitId, unit.name, options.targetLanguage, startMs,
				'No resolved source available — run Phase 1 (Source Resolution) first');
		}

		// Acquire unit lock — prevents two concurrent agents translating the same unit
		const lock = kb.lockUnit(unitId, LOCK_OWNER, LOCK_TTL_MS);
		if (!lock) {
			// Unit is already locked by another job — skip silently
			return makeSkippedResult(unit.id, unit.name, unit.sourceLang, options.targetLanguage, startMs);
		}
		lockAcquired = true;

		// ── Step 2: Context ──────────────────────────────────────────────────────
		const resolvedCtx = kb.getResolvedContext(unitId);
		if (signal.aborted) {
			return makeSkippedResult(unit.id, unit.name, unit.sourceLang, options.targetLanguage, startMs);
		}

		// Gather tech debt for the source unit (lightweight — no LLM, pure regex)
		let techDebtItems: ITechDebtItem[] | undefined;
		try {
			const lineCount = unit.resolvedSource.split('\n').length;
			techDebtItems = analyzeUnitDebt({
				unitId:             unit.id,
				unitName:           unit.name,
				content:            unit.resolvedSource,
				lang:               unit.sourceLang,
				complexity:         {
					lineCount,
					logicalLineCount:   lineCount,
					cyclomaticComplexity: 1,
					nestingDepth:       0,
					callCount:          0,
					paramCount:         0,
					hasExternalCalls:   false,
					hasDatabaseOps:     false,
					hasFileOps:         false,
					hasUIInteraction:   false,
				},
				allUnitIds:         [],
				allCallExpressions: [],
				testUnitIds:        [],
			});
		} catch { techDebtItems = undefined; }

		// Gather blocking decisions already raised for this unit (answered = has resolvedAt)
		let blockingDecisions: IPendingDecision[] | undefined;
		try {
			const allDecisions = kb.getPendingDecisions('blocking');
			blockingDecisions = allDecisions.filter(d => d.unitId === unit.id && d.resolvedAt !== undefined);
		} catch { blockingDecisions = undefined; }

		// Build a map of called unit records for health annotation
		let calledUnits: Map<string, IKnowledgeUnit> | undefined;
		try {
			if (resolvedCtx.calledInterfaces.length > 0) {
				calledUnits = new Map();
				for (const iface of resolvedCtx.calledInterfaces) {
					const dep = kb.getUnit(iface.unitId);
					if (dep) { calledUnits.set(iface.unitId, dep); }
				}
			}
		} catch { calledUnits = undefined; }

		const ctx = buildTranslationContext(resolvedCtx, options, techDebtItems, blockingDecisions, calledUnits, migrationPatternId);

		// ── Step 3: Model selection ───────────────────────────────────────────────
		const modelSelection: ModelSelection | null =
			settings.state.modelSelectionOfFeature['Checks'] ??
			settings.state.modelSelectionOfFeature['Chat'] ??
			null;

		if (!modelSelection) {
			return makeErrorResult(unitId, unit.name, options.targetLanguage, startMs,
				'No model configured — set a model for the Checks or Chat feature in Void settings');
		}

		// ── Chunked path ─────────────────────────────────────────────────────────
		// If the source was truncated to fit the token budget, use the full original
		// source for chunked translation instead of the truncated single-shot path.
		if (ctx.isSourceTruncated) {
			return runChunkedTranslation(unit, ctx, options, llm, modelSelection, signal, startMs);
		}

		// ── Step 4: Translate (with retries) ─────────────────────────────────────
		return runSingleShotTranslation(unit, ctx, options, llm, modelSelection, signal, startMs);

	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return makeErrorResult(unitId, '', options.targetLanguage, startMs, message);
	} finally {
		// Always release the unit lock, even on error or abort
		if (lockAcquired) {
			kb.unlockUnit(unitId, LOCK_OWNER);
		}
	}
}


// ─── Single-shot translation ──────────────────────────────────────────────────

/**
 * Translate a single unit in one LLM call (with retries).
 * Called when the source fits within the token budget.
 */
async function runSingleShotTranslation(
	unit: IKnowledgeUnit,
	ctx: IBuiltTranslationContext,
	options: ITranslationOptions,
	llm: ILLMMessageService,
	modelSelection: ModelSelection,
	signal: AbortSignal,
	startMs: number,
): Promise<ITranslationResult> {
	const maxRetries = options.maxRetries ?? 2;
	let lastParseResult:  ITranslationParseResult | null = null;
	let lastVerification: ITranslationVerificationResult  | undefined;
	let lastFailedChecks: IVerificationCheck[]            = [];
	let totalLLMCalls   = 0;
	let parseSucceeded  = false;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (signal.aborted) {
			return makeSkippedResult(unit.id, unit.name, unit.sourceLang, options.targetLanguage, startMs);
		}

		const messages = buildTranslationPrompt(ctx, attempt, attempt > 0 ? lastFailedChecks : undefined);

		let rawResponse: string | null;
		try {
			rawResponse = await callLLM(llm, modelSelection, messages, signal);
		} catch (llmErr: unknown) {
			const msg = llmErr instanceof Error ? llmErr.message : String(llmErr);
			if (attempt < maxRetries) { continue; }
			return makeErrorResult(unit.id, unit.name, options.targetLanguage, startMs,
				`LLM call failed: ${msg}`, totalLLMCalls, ctx.estimatedTokens);
		}
		totalLLMCalls++;

		if (rawResponse === null) {
			return makeSkippedResult(unit.id, unit.name, unit.sourceLang, options.targetLanguage, startMs);
		}

		if (rawResponse.trim().length < MIN_TRANSLATED_LENGTH) {
			if (attempt < maxRetries) { continue; }
			return makeErrorResult(unit.id, unit.name, options.targetLanguage, startMs,
				`LLM returned empty response after ${totalLLMCalls} attempt(s)`,
				totalLLMCalls, ctx.estimatedTokens);
		}

		const parseResult = parseTranslationResponse(rawResponse);
		lastParseResult   = parseResult;

		if (!parseResult.parseSucceeded) {
			if (attempt < maxRetries) { continue; }
			return makeErrorResult(unit.id, unit.name, options.targetLanguage, startMs,
				`Translation response parse failed after ${totalLLMCalls} attempt(s) — LLM did not follow the required format`,
				totalLLMCalls, ctx.estimatedTokens);
		}

		// ── Step 5: Verify ─────────────────────────────────────────────────
		if (options.verifyAfterTranslate) {
			const verification = verifyTranslation(parseResult, ctx);
			lastVerification   = verification;
			lastFailedChecks   = verification.checks.filter(c => !c.passed);

			if (!verification.passed && attempt < maxRetries) {
				continue;
			}
		}

		parseSucceeded = true;
		break;
	}

	if (!parseSucceeded || !lastParseResult) {
		return makeErrorResult(unit.id, unit.name, options.targetLanguage, startMs,
			'Translation failed after all retries', totalLLMCalls, ctx.estimatedTokens);
	}

	// ── Step 6: Extract & classify decisions ─────────────────────────────────
	const decisionsRaised = options.extractDecisions
		? extractDecisions(lastParseResult.decisionsRaised, unit.id, unit.name)
		: [];

	const hasBlocking = decisionsRaised.some(d => d.priority === 'blocking');
	const outcome     = determineOutcome(lastParseResult, hasBlocking);

	return {
		unitId:             unit.id,
		unitName:           unit.name,
		sourceLang:         unit.sourceLang,
		targetLang:         options.targetLanguage,
		translatedCode:     lastParseResult.translatedCode,
		confidence:         lastParseResult.confidence,
		reasoning:          lastParseResult.reasoning,
		decisionsRaised,
		tokensUsed:         ctx.estimatedTokens,
		attemptCount:       totalLLMCalls,
		durationMs:         Date.now() - startMs,
		outcome,
		verificationResult: lastVerification,
	};
}


// ─── Chunked translation ──────────────────────────────────────────────────────

/**
 * Translate an oversized unit by splitting it into language-aware chunks,
 * translating each independently, then stitching the results together.
 *
 * This path is taken when `ctx.isSourceTruncated === true`, meaning the source
 * was too large to fit within the token budget even after all context sections
 * were dropped. We fall back to using the full `unit.resolvedSource` for splitting.
 *
 * Each chunk receives:
 *  - The full context (decisions, glossary, interfaces) — shared overhead
 *  - A chunk header explaining its position and what to produce
 *  - The last N lines of the previous chunk's translation as a boundary stub
 *
 * The final result confidence is the minimum across all chunks.
 * Decisions and idiom notes are merged and deduplicated.
 */
async function runChunkedTranslation(
	unit: IKnowledgeUnit,
	ctx: IBuiltTranslationContext,
	options: ITranslationOptions,
	llm: ILLMMessageService,
	modelSelection: ModelSelection,
	signal: AbortSignal,
	startMs: number,
): Promise<ITranslationResult> {
	// Use the full original source (not the budget-trimmed version) for splitting
	const fullSource = unit.resolvedSource;

	const splitResult = splitIntoChunks(
		{ ...ctx, resolvedSource: fullSource },
	);

	// If for some reason no chunking happened (e.g. source fits in one chunk),
	// fall back to single-shot with the truncated ctx (shouldn't normally happen)
	if (!splitResult.wasChunked || splitResult.chunks.length === 0) {
		return runSingleShotTranslation(unit, ctx, options, llm, modelSelection, signal, startMs);
	}

	const chunks         = splitResult.chunks;
	const translatedChunks: IChunkStitchInput[] = [];
	const allRawDecisions: IRaisedDecision[]     = [];
	const allReasonings: string[]                = [];
	let   totalLLMCalls  = 0;
	let   minConfidence: TranslationConfidence = 'high';

	for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
		if (signal.aborted) {
			return makeSkippedResult(unit.id, unit.name, unit.sourceLang, options.targetLanguage, startMs);
		}

		const chunk = chunks[chunkIdx];

		// Attach preceding output stub for boundary context continuity
		if (chunkIdx > 0 && translatedChunks.length > 0) {
			const prevLines = translatedChunks[chunkIdx - 1].translatedContent.split('\n');
			chunk.precedingOutputStub = prevLines
				.slice(Math.max(0, prevLines.length - PRECEDING_STUB_LINES))
				.join('\n');
		}

		// Per-chunk context: replace resolvedSource with this chunk's content,
		// inject the chunk header as a prompt prefix for positional awareness
		const chunkCtx: IBuiltTranslationContext = {
			...ctx,
			resolvedSource: chunk.content,
			chunkHeader:    buildChunkContextPrefix(chunk, unit.name, options.targetLanguage),
			// Source is now the chunk content — it's not truncated in isolation
			isSourceTruncated: false,
		};

		const chunkResult = await translateOneChunk(
			unit, chunkCtx, chunk.index, chunks.length,
			options, llm, modelSelection, signal, startMs,
		);

		if (chunkResult.type === 'abort') {
			return makeSkippedResult(unit.id, unit.name, unit.sourceLang, options.targetLanguage, startMs);
		}
		if (chunkResult.type === 'error') {
			return makeErrorResult(unit.id, unit.name, options.targetLanguage, startMs,
				chunkResult.message, totalLLMCalls);
		}

		totalLLMCalls += chunkResult.llmCalls;
		translatedChunks.push({ chunk, translatedContent: chunkResult.parseResult.translatedCode });
		allRawDecisions.push(...chunkResult.parseResult.decisionsRaised);
		allReasonings.push(`[Chunk ${chunkIdx + 1}/${chunks.length}] ${chunkResult.parseResult.reasoning}`);

		// Track minimum confidence across all chunks
		const newIdx = CONFIDENCE_ORDER.indexOf(chunkResult.parseResult.confidence);
		const curIdx = CONFIDENCE_ORDER.indexOf(minConfidence);
		if (newIdx > curIdx) {
			minConfidence = chunkResult.parseResult.confidence;
		}
	}

	// ── Stitch all translated chunks into one coherent output ─────────────────
	const stitch = stitchChunks(translatedChunks, options.targetLanguage);

	// ── Extract & classify decisions across all chunks ────────────────────────
	const decisionsRaised = options.extractDecisions
		? extractDecisions(allRawDecisions, unit.id, unit.name)
		: [];

	const hasBlocking = decisionsRaised.some(d => d.priority === 'blocking');
	const outcome     = determineOutcome(
		{
			translatedCode:     stitch.stitchedCode,
			confidence:         minConfidence,
			decisionsRaised:    allRawDecisions,
			sectionsUnresolved: stitch.sectionsUnresolved,
		} as ITranslationParseResult,
		hasBlocking,
	);

	return {
		unitId:          unit.id,
		unitName:        unit.name,
		sourceLang:      unit.sourceLang,
		targetLang:      options.targetLanguage,
		translatedCode:  stitch.stitchedCode,
		confidence:      minConfidence,
		reasoning:       allReasonings.join('\n\n'),
		decisionsRaised,
		tokensUsed:      ctx.estimatedTokens * chunks.length,
		attemptCount:    totalLLMCalls,
		durationMs:      Date.now() - startMs,
		outcome,
	};
}


// ─── Single-chunk translator ──────────────────────────────────────────────────

type ChunkTranslationResult =
	| { type: 'ok';    parseResult: ITranslationParseResult; llmCalls: number }
	| { type: 'abort' }
	| { type: 'error'; message: string };

/**
 * Translate a single chunk (with retries), returning a discriminated union
 * so the caller can handle abort/error without throwing.
 */
async function translateOneChunk(
	unit: IKnowledgeUnit,
	chunkCtx: IBuiltTranslationContext,
	chunkIndex: number,
	totalChunks: number,
	options: ITranslationOptions,
	llm: ILLMMessageService,
	modelSelection: ModelSelection,
	signal: AbortSignal,
	_startMs: number,
): Promise<ChunkTranslationResult> {
	const maxRetries     = options.maxRetries ?? 2;
	const chunkLabel     = `chunk ${chunkIndex + 1}/${totalChunks}`;
	let   lastParseResult: ITranslationParseResult | null = null;
	let   lastFailedChecks: IVerificationCheck[]          = [];
	let   llmCalls = 0;
	let   parseSucceeded = false;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		if (signal.aborted) { return { type: 'abort' }; }

		const messages = buildTranslationPrompt(chunkCtx, attempt, attempt > 0 ? lastFailedChecks : undefined);

		let rawResponse: string | null;
		try {
			rawResponse = await callLLM(llm, modelSelection, messages, signal);
		} catch (llmErr: unknown) {
			const msg = llmErr instanceof Error ? llmErr.message : String(llmErr);
			if (attempt < maxRetries) { continue; }
			return { type: 'error', message: `LLM call failed for ${chunkLabel}: ${msg}` };
		}
		llmCalls++;

		if (rawResponse === null) { return { type: 'abort' }; }

		if (rawResponse.trim().length < MIN_TRANSLATED_LENGTH) {
			if (attempt < maxRetries) { continue; }
			return { type: 'error', message: `Empty LLM response for ${chunkLabel} after ${llmCalls} attempt(s)` };
		}

		const parseResult = parseTranslationResponse(rawResponse);
		lastParseResult   = parseResult;

		if (!parseResult.parseSucceeded) {
			if (attempt < maxRetries) { continue; }
			return {
				type: 'error',
				message: `Parse failed for ${chunkLabel} after ${llmCalls} attempt(s) — LLM did not follow output format`,
			};
		}

		// Verify chunk output
		if (options.verifyAfterTranslate) {
			const verification = verifyTranslation(parseResult, chunkCtx);
			lastFailedChecks   = verification.checks.filter(c => !c.passed);
			if (!verification.passed && attempt < maxRetries) { continue; }
		}

		parseSucceeded = true;
		break;
	}

	if (!parseSucceeded || !lastParseResult) {
		return { type: 'error', message: `Translation failed for ${chunkLabel} after all retries` };
	}

	return { type: 'ok', parseResult: lastParseResult, llmCalls };
}


// ─── LLM call wrapper ─────────────────────────────────────────────────────────

/**
 * Call the LLM and return the full response text, or `null` if aborted.
 * Throws on LLM error so the retry loop can handle it.
 */
function callLLM(
	llm: ILLMMessageService,
	modelSelection: ModelSelection,
	messages: ReturnType<typeof buildTranslationPrompt>,
	signal: AbortSignal,
): Promise<string | null> {
	return new Promise((resolve, reject) => {
		let requestId: string | null = null;

		const onAbort = (): void => {
			if (requestId) { llm.abort(requestId); }
			resolve(null);
		};
		signal.addEventListener('abort', onAbort, { once: true });

		requestId = llm.sendLLMMessage({
			messagesType:          'chatMessages',
			messages,
			separateSystemMessage: undefined,
			chatMode:              null,
			modelSelection,
			logging:               { loggingName: LOGGING_NAME },
			modelSelectionOptions: undefined,
			overridesOfModel:      undefined,
			onText:        () => { /* streaming not used — collect full response */ },
			onFinalMessage: ({ fullText }) => {
				signal.removeEventListener('abort', onAbort);
				resolve(fullText ?? '');
			},
			onError: (error) => {
				signal.removeEventListener('abort', onAbort);
				reject(new Error(String(error)));
			},
			onAbort: () => {
				signal.removeEventListener('abort', onAbort);
				resolve(null);
			},
		}) ?? null;
	});
}


// ─── Outcome determination ────────────────────────────────────────────────────

function determineOutcome(
	parseResult: Pick<ITranslationParseResult, 'confidence' | 'decisionsRaised' | 'sectionsUnresolved'>,
	hasBlocking: boolean,
): TranslationOutcome {
	if (hasBlocking) { return 'blocked'; }
	if (parseResult.confidence === 'low' || parseResult.confidence === 'uncertain') { return 'partial'; }
	if (parseResult.decisionsRaised.length > 0)    { return 'partial'; }
	if (parseResult.sectionsUnresolved.length > 0) { return 'partial'; }
	return 'translated';
}


// ─── Result factories ─────────────────────────────────────────────────────────

function makeErrorResult(
	unitId: string,
	unitName: string,
	targetLang: string,
	startMs: number,
	error: string,
	attemptCount = 0,
	tokensUsed = 0,
): ITranslationResult {
	return {
		unitId,
		unitName,
		sourceLang:      '',
		targetLang,
		translatedCode:  '',
		confidence:      'uncertain' as TranslationConfidence,
		reasoning:       '',
		decisionsRaised: [],
		tokensUsed,
		attemptCount,
		durationMs:      Date.now() - startMs,
		outcome:         'error' as TranslationOutcome,
		error,
	};
}

function makeSkippedResult(
	unitId: string,
	unitName: string,
	sourceLang: string,
	targetLang: string,
	startMs: number,
): ITranslationResult {
	return {
		unitId,
		unitName,
		sourceLang,
		targetLang,
		translatedCode:  '',
		confidence:      'uncertain' as TranslationConfidence,
		reasoning:       '',
		decisionsRaised: [],
		tokensUsed:      0,
		attemptCount:    0,
		durationMs:      Date.now() - startMs,
		outcome:         'skipped' as TranslationOutcome,
	};
}
