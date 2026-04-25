/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Validation Loop
 *
 * Executes the full equivalence validation sequence for a single knowledge unit.
 * This is the innermost worker called concurrently by batchValidationEngine.
 *
 * ## 4-step sequence
 *
 * ```
 * Step 1 — Eligibility check
 *   Verify unit exists, has both sourceText/resolvedSource and targetText.
 *   Acquire a KB lock to prevent concurrent validation jobs on the same unit.
 *
 * Step 2 — Layer 1: Static checks
 *   Run deterministic structural checks (no LLM).
 *   If ALL static checks fail (obvious broken translation), short-circuit to 'failed'.
 *   This saves LLM budget on clearly broken translations.
 *
 * Step 3 — Layer 2: LLM semantic analysis (optional)
 *   Build the equivalence prompt.
 *   Call the LLM with retry logic.
 *   Parse the XML response into test cases + divergences.
 *
 * Step 4 — Outcome determination
 *   Combine Layer 1 static results with Layer 2 LLM test cases.
 *   Classify into ValidationOutcome.
 *   Build and return IValidationResult.
 * ```
 *
 * ## Outcome classification rules
 *
 *   - Any static 'fail' AND LLM failCount > 0  \u2192 'failed'
 *   - LLM failCount > 0                         \u2192 'failed'
 *   - Static has 'fail' but LLM all pass        \u2192 'partial'  (static concern, LLM disagrees)
 *   - Static has 'warn' OR confidence < 'high'  \u2192 'partial'
 *   - All pass, confidence = 'high'             \u2192 'validated'
 *   - All pass, confidence = 'medium'           \u2192 'validated' (medium is good enough)
 *   - All pass, confidence = 'low'/'uncertain'  \u2192 'partial'
 *
 * ## Error contract
 *
 * `runValidationLoop()` NEVER throws. All failures return an IValidationResult
 * with outcome='error' and the error message in result.error.
 */

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import { ILLMMessageService } from '../../../../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../../../../../void/common/voidSettingsService.js';
import { ModelSelection } from '../../../../../void/common/voidSettingsTypes.js';
import {
	IValidationOptions,
	IValidationResult,
	IValidationTestCase,
	IStaticCheckResult,
	ValidationOutcome,
	ValidationConfidence,
	DEFAULT_VALIDATION_OPTIONS,
} from './validationTypes.js';
import { runStaticChecks, aggregateStaticStatus } from './validationStaticChecker.js';
import { buildValidationPrompt } from './validationPromptBuilder.js';
import { parseValidationResponse } from './validationResultParser.js';


// ─── Constants ────────────────────────────────────────────────────────────────

const LOGGING_NAME = 'ModernisationValidationEngine';
const LOCK_OWNER   = 'validation-engine';
const LOCK_TTL_MS  = 8 * 60 * 1000; // 8 minutes

/** Confidence values good enough to produce 'validated' outcome */
const VALIDATED_CONFIDENCE: ValidationConfidence[] = ['high', 'medium'];


// ─── Main entry ───────────────────────────────────────────────────────────────

/**
 * Execute the full validation loop for a single knowledge unit.
 *
 * @param unitId   KB unit ID
 * @param options  Validation run options
 * @param kb       Knowledge Base service
 * @param llm      LLM message service
 * @param settings Void settings service (for model selection)
 * @param signal   Abort signal
 * @returns        A fully populated IValidationResult (never throws)
 */
export async function runValidationLoop(
	unitId:  string,
	options: IValidationOptions,
	kb:      IKnowledgeBaseService,
	llm:     ILLMMessageService,
	settings: IVoidSettingsService,
	signal:  AbortSignal,
): Promise<IValidationResult> {
	const startMs      = Date.now();
	const maxRetries   = options.maxRetries ?? DEFAULT_VALIDATION_OPTIONS.maxRetries;
	let   lockAcquired = false;

	try {
		// ── Step 1: Eligibility ──────────────────────────────────────────────────
		const unit = kb.getUnit(unitId);
		if (!unit) {
			return _makeErrorResult(unitId, 'unknown', startMs, 'Unit not found in KB.');
		}

		if (signal.aborted) {
			return _makeSkippedResult(unit.id, unit.name, startMs);
		}

		// Must have source and target code
		const sourceCode = unit.resolvedSource || unit.sourceText || '';
		const targetCode = unit.targetText || '';

		if (!sourceCode.trim()) {
			return _makeErrorResult(unitId, unit.name, startMs,
				'No source code available — run Phase 1 (Source Resolution) first.');
		}
		if (!targetCode.trim()) {
			return _makeErrorResult(unitId, unit.name, startMs,
				'No translated target code available — run Phase 4 (Translation) first.');
		}

		// Acquire unit lock
		const lock = kb.lockUnit(unitId, LOCK_OWNER, LOCK_TTL_MS);
		if (!lock) {
			return _makeSkippedResult(unit.id, unit.name, startMs);
		}
		lockAcquired = true;

		// Set unit to 'validating' status
		kb.setUnitStatus(unitId, 'validating', undefined, LOCK_OWNER);

		// Infer target language from file extension or options
		const targetLang = options.targetLanguage ?? _inferLang(unit.targetFile);
		const sourceLang = unit.sourceLang ?? 'unknown';

		// ── Step 2: Static checks ────────────────────────────────────────────────
		let staticChecks: IStaticCheckResult[] = [];

		if (options.includeStaticChecks ?? DEFAULT_VALIDATION_OPTIONS.includeStaticChecks) {
			staticChecks = runStaticChecks(sourceCode, targetCode, sourceLang, targetLang);
		}

		if (signal.aborted) {
			return _makeSkippedResult(unit.id, unit.name, startMs);
		}

		// Short-circuit: if no LLM analysis and static already fails, done
		const staticAggregate = aggregateStaticStatus(staticChecks);
		if (staticAggregate === 'fail' && !(options.includeLLMAnalysis ?? DEFAULT_VALIDATION_OPTIONS.includeLLMAnalysis)) {
			return {
				unitId:        unitId,
				unitName:      unit.name,
				outcome:       'failed',
				staticChecks,
				testCases:     [],
				testCaseCount: 0,
				passCount:     0,
				failCount:     0,
				confidence:    'uncertain',
				analysis:      'Static structural checks failed. LLM analysis disabled.',
				durationMs:    Date.now() - startMs,
				attemptCount:  0,
				tokensUsed:    0,
			};
		}

		// ── Step 3: LLM semantic analysis ────────────────────────────────────────
		let testCases:    IValidationTestCase[]     = [];
		let analysis      = '';
		let confidence:   ValidationConfidence      = 'uncertain';
		let attemptCount  = 0;
		let tokensUsed    = 0;
		let llmSucceeded  = false;
		let lastParseError: string | undefined;

		if (options.includeLLMAnalysis ?? DEFAULT_VALIDATION_OPTIONS.includeLLMAnalysis) {
			// Model selection — same pattern as translation engine
			const modelSelection: ModelSelection | null =
				settings.state.modelSelectionOfFeature['Checks'] ??
				settings.state.modelSelectionOfFeature['Chat'] ??
				null;

			if (!modelSelection) {
				return _makeErrorResult(unitId, unit.name, startMs,
					'No model configured — set a model for the Checks or Chat feature in Void settings.');
			}

			// Gather business rules for the prompt (top 5)
			const businessRules = unit.businessRules?.slice(0, 5).map(r => r.description) ?? [];

			const staticFailures = staticChecks.filter(c => c.status !== 'pass');

			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				if (signal.aborted) {
					return _makeSkippedResult(unit.id, unit.name, startMs);
				}

				const messages = buildValidationPrompt({
					unitName:       unit.name,
					sourceLang,
					targetLang,
					sourceCode,
					targetCode,
					domain:         typeof unit.domain === 'string' ? unit.domain : undefined,
					businessRules,
					staticFailures,
					retryReason:    attempt > 0 ? lastParseError : undefined,
					attemptIndex:   attempt,
				});

				let rawResponse: string | null;
				try {
					rawResponse = await _callLLM(llm, modelSelection, messages, signal);
				} catch (llmErr: unknown) {
					const msg = llmErr instanceof Error ? llmErr.message : String(llmErr);
					if (attempt < maxRetries) {
						lastParseError = `LLM call failed: ${msg}`;
						continue;
					}
					return _makeErrorResult(unitId, unit.name, startMs,
						`LLM call failed after ${attemptCount + 1} attempt(s): ${msg}`,
						attemptCount, tokensUsed, staticChecks);
				}
				attemptCount++;

				if (rawResponse === null) {
					return _makeSkippedResult(unit.id, unit.name, startMs);
				}

				// Rough token estimate: ~4 chars per token
				tokensUsed += Math.round(rawResponse.length / 4) +
				              Math.round(messages.reduce((s, m) => s + m.content.length, 0) / 4);

				const parseResult = parseValidationResponse(rawResponse);

				if (!parseResult.parseSucceeded) {
					lastParseError = parseResult.parseError ?? 'Parse failed';
					if (attempt < maxRetries) { continue; }
					// Use the partial fallback result even if not perfectly parsed
				}

				testCases   = parseResult.testCases;
				analysis    = parseResult.analysis;
				confidence  = parseResult.confidence;
				llmSucceeded = parseResult.parseSucceeded;
				break;
			}

			// Downgrade confidence if there are unresolved decisions for this unit
			if (kb.getPendingDecisionForUnit(unitId) && confidence === 'high') {
				confidence = 'medium';
			}
		}

		// ── Step 4: Outcome determination ────────────────────────────────────────
		const passCount  = testCases.filter(tc => tc.passed).length;
		const failCount  = testCases.filter(tc => !tc.passed).length;
		const outcome    = _determineOutcome(
			staticAggregate, failCount, testCases.length, confidence, llmSucceeded,
		);

		return {
			unitId:        unitId,
			unitName:      unit.name,
			outcome,
			staticChecks,
			testCases,
			testCaseCount: testCases.length,
			passCount,
			failCount,
			confidence,
			analysis,
			durationMs:    Date.now() - startMs,
			attemptCount,
			tokensUsed,
		};

	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		return _makeErrorResult(unitId, '', startMs, message);

	} finally {
		if (lockAcquired) {
			kb.unlockUnit(unitId, LOCK_OWNER);
		}
	}
}



// ─── Outcome determination ────────────────────────────────────────────────────

function _determineOutcome(
	staticAggregate: 'pass' | 'warn' | 'fail',
	failCount:       number,
	totalTests:      number,
	confidence:      ValidationConfidence,
	llmSucceeded:    boolean,
): ValidationOutcome {
	// Any LLM-confirmed divergences \u2192 failed
	if (failCount > 0) { return 'failed'; }

	// Static check failure with no LLM override \u2192 partial (needs human review)
	if (staticAggregate === 'fail' && totalTests === 0) { return 'failed'; }
	if (staticAggregate === 'fail') { return 'partial'; }

	// If LLM didn't succeed at all, fall back to static result
	if (!llmSucceeded && totalTests === 0) {
		return staticAggregate === 'pass' ? 'partial' : 'failed';
	}

	// All tests pass — check confidence
	if (VALIDATED_CONFIDENCE.includes(confidence)) {
		// Static warnings allowed with high/medium confidence
		return 'validated';
	}

	// Low confidence or uncertain: human review
	return 'partial';
}


// ─── LLM call wrapper ─────────────────────────────────────────────────────────

type PromptMessage = { role: 'system' | 'user' | 'assistant'; content: string };

function _callLLM(
	llm:            ILLMMessageService,
	modelSelection: ModelSelection,
	messages:       PromptMessage[],
	signal:         AbortSignal,
): Promise<string | null> {
	return new Promise((resolve, reject) => {
		let requestId: string | null = null;

		const onAbort = (): void => {
			if (requestId) { llm.abort(requestId); }
			resolve(null);
		};
		signal.addEventListener('abort', onAbort, { once: true });

		requestId = (llm.sendLLMMessage as unknown as (p: unknown) => string)({
			messagesType:          'chatMessages',
			messages,
			separateSystemMessage: undefined,
			chatMode:              null,
			modelSelection,
			logging:               { loggingName: LOGGING_NAME },
			modelSelectionOptions: undefined,
			overridesOfModel:      undefined,
			onText:        () => { /* streaming not used */ },
			onFinalMessage: ({ fullText }: { fullText: string }) => {
				signal.removeEventListener('abort', onAbort);
				resolve(fullText ?? '');
			},
			onError: (error: unknown) => {
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


// ─── Language inference ────────────────────────────────────────────────────────

function _inferLang(targetFile: string | undefined): string {
	if (!targetFile) { return 'unknown'; }
	const ext = targetFile.split('.').pop()?.toLowerCase() ?? '';
	const MAP: Record<string, string> = {
		java: 'java', kt: 'kotlin', scala: 'scala',
		ts: 'typescript', tsx: 'typescript', js: 'javascript', mjs: 'javascript',
		py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
		cs: 'csharp', vb: 'vbnet', fs: 'fsharp',
		php: 'php', swift: 'swift', dart: 'dart',
		sql: 'sql', pls: 'plsql', pck: 'plsql',
		cbl: 'cobol', cob: 'cobol',
	};
	return MAP[ext] ?? 'unknown';
}


// ─── Result factories ─────────────────────────────────────────────────────────

function _makeErrorResult(
	unitId:      string,
	unitName:    string,
	startMs:     number,
	error:       string,
	attemptCount = 0,
	tokensUsed   = 0,
	staticChecks: IStaticCheckResult[] = [],
): IValidationResult {
	return {
		unitId, unitName,
		outcome:       'error',
		staticChecks,
		testCases:     [],
		testCaseCount: 0,
		passCount:     0,
		failCount:     0,
		confidence:    'uncertain',
		analysis:      '',
		durationMs:    Date.now() - startMs,
		attemptCount,
		tokensUsed,
		error,
	};
}

function _makeSkippedResult(
	unitId:  string,
	unitName: string,
	startMs: number,
): IValidationResult {
	return {
		unitId, unitName,
		outcome:       'skipped',
		staticChecks:  [],
		testCases:     [],
		testCaseCount: 0,
		passCount:     0,
		failCount:     0,
		confidence:    'uncertain',
		analysis:      '',
		durationMs:    Date.now() - startMs,
		attemptCount:  0,
		tokensUsed:    0,
	};
}
