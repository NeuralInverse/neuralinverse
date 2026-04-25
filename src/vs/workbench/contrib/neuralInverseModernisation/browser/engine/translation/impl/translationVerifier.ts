/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Translation Verifier
 *
 * Runs a suite of deterministic checks on translated code to catch the most
 * common LLM translation failures before storing the result in the KB.
 *
 * ## Check Suite
 *
 * | Check                    | Severity | Description                                    |
 * |--------------------------|----------|------------------------------------------------|
 * | non-empty                | blocker  | Translated code must not be empty              |
 * | no-placeholders          | blocker  | No TODO/FIXME/TRANSLATE/??? placeholder markers|
 * | no-truncation-markers    | blocker  | No `[truncated]` or `... more ...` markers     |
 * | source-lang-keywords     | warning  | Source language keywords still in output       |
 * | balanced-braces          | warning  | Brace-delimited language has balanced braces   |
 * | length-sanity            | warning  | Translated code is 10%\u2013800% of source length   |
 * | blocking-decision-raised | info     | AI raised a blocking decision                  |
 * | low-confidence           | info     | AI reported low/uncertain confidence           |
 *
 * ## Severity Semantics
 *
 * - `blocker` \u2014 The result should be retried if retries remain; if not, the unit
 *               is recorded with outcome='error' and flagged for human review.
 * - `warning`  \u2014 The result is stored but the unit goes to 'review' status regardless
 *               of confidence, so a human can catch the issue.
 * - `info`     \u2014 Informational only; does not change the outcome.
 *
 * Checks are language-aware: a COBOL verifier knows that seeing `IDENTIFICATION DIVISION`
 * in Java output is a source-language-leak, but it does NOT flag COBOL keywords that
 * legitimately appear in Java comments.
 */

import { ITranslationParseResult, ITranslationVerificationResult, IVerificationCheck, TranslationConfidence } from './translationTypes.js';
import { IBuiltTranslationContext } from './translationTypes.js';


// \u2500\u2500\u2500 Main entry point \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Run all verification checks on the parsed translation result.
 *
 * @param parseResult  The parsed LLM response
 * @param ctx          The context that was passed to the LLM (for cross-checking)
 * @returns            Aggregated verification result
 */
export function verifyTranslation(
	parseResult: ITranslationParseResult,
	ctx: IBuiltTranslationContext,
): ITranslationVerificationResult {
	const checks: IVerificationCheck[] = [
		checkNonEmpty(parseResult),
		checkNoPlaceholders(parseResult),
		checkNoTruncationMarkers(parseResult),
		checkNoSourceLanguageKeywords(parseResult, ctx),
		checkBalancedBraces(parseResult, ctx),
		checkLengthSanity(parseResult, ctx),
		checkBlockingDecisions(parseResult),
		checkLowConfidence(parseResult),
	];

	const blockerCount = checks.filter(c => !c.passed && c.severity === 'blocker').length;
	const warningCount = checks.filter(c => !c.passed && c.severity === 'warning').length;

	return {
		passed:       blockerCount === 0,
		checks,
		blockerCount,
		warningCount,
	};
}


// \u2500\u2500\u2500 Individual checks \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function checkNonEmpty(parseResult: ITranslationParseResult): IVerificationCheck {
	const isEmpty = parseResult.translatedCode.trim().length === 0;
	return {
		name:    'non-empty',
		passed:  !isEmpty,
		severity: 'blocker',
		message: isEmpty ? 'Translated code block is empty \u2014 LLM may have failed to produce output' : undefined,
	};
}

function checkNoPlaceholders(parseResult: ITranslationParseResult): IVerificationCheck {
	// Patterns that indicate the AI left work incomplete
	const PLACEHOLDER_PATTERNS = [
		/\/\/\s*TODO:\s*(?:translate|implement|add|fill)/i,
		/\/\/\s*FIXME:\s*(?:translate|implement)/i,
		/\[TRANSLATE\]/i,
		/\[NEEDS TRANSLATION\]/i,
		/\[IMPLEMENT\]/i,
		/\/\*\s*\.\.\.\s*implement\s*\.\.\.\s*\*\//i,
		/\?\?\?(?:\s*\/\/[^\n]*)?\n/,          // ??? on its own line
		/\/\/\s*\.\.\.\s*rest of.*translat/i,
		/\/\*\s*stub\s*\*\//i,
	];

	const found = PLACEHOLDER_PATTERNS.find(p => p.test(parseResult.translatedCode));
	return {
		name:    'no-placeholders',
		passed:  !found,
		severity: 'blocker',
		message: found ? 'Translated code contains placeholder markers \u2014 translation is incomplete' : undefined,
	};
}

function checkNoTruncationMarkers(parseResult: ITranslationParseResult): IVerificationCheck {
	const TRUNCATION_PATTERNS = [
		/\[truncated\]/i,
		/\[content truncated/i,
		/\.\.\.more\.\.\./i,
		/\/\*\s*\[RESOLUTION\]\s*Content truncated/i,
		/\/\/\s*\.\.\.\s*\(continued\)/i,
		/\[due to length/i,
	];

	const found = TRUNCATION_PATTERNS.find(p => p.test(parseResult.translatedCode));
	return {
		name:    'no-truncation-markers',
		passed:  !found,
		severity: 'blocker',
		message: found ? 'Translated code contains truncation markers \u2014 output was cut off' : undefined,
	};
}

function checkNoSourceLanguageKeywords(
	parseResult: ITranslationParseResult,
	ctx: IBuiltTranslationContext,
): IVerificationCheck {
	// Source-language keyword patterns that should NOT appear in translated code
	// (outside of comments \u2014 we do a coarse check, not a parser)
	const LEAK_PATTERNS_BY_LANG: Record<string, RegExp[]> = {
		cobol: [
			/^\s*IDENTIFICATION\s+DIVISION\s*\./m,
			/^\s*PROCEDURE\s+DIVISION\s*\./m,
			/^\s*DATA\s+DIVISION\s*\./m,
			/^\s*WORKING-STORAGE\s+SECTION\s*\./m,
			/^\s*PERFORM\s+\w/m,
			/^\s*MOVE\s+\w.*\s+TO\s+\w/m,
		],
		rpgle: [
			/^\s*D\s+\w.*S\s+\d+[PA]/m,
			/^\s*C\s+.*\s+EVAL\s+/m,
		],
		natural: [
			/^\s*DEFINE\s+DATA\s+LOCAL/m,
			/^\s*END-DEFINE/m,
		],
		fortran: [
			/^\s*SUBROUTINE\s+\w/im,
			/^\s*PROGRAM\s+\w/im,
			/^\s*REAL\s*\*\s*8/im,
		],
		pl1: [
			/^\s*PROCEDURE\s+OPTIONS\s*\(/m,
			/^\s*DCL\s+.*\s+FIXED\s+DEC/m,
		],
	};

	const src = ctx.sourceLang.toLowerCase();
	const patterns = LEAK_PATTERNS_BY_LANG[src] ?? [];
	if (patterns.length === 0) {
		// No specific patterns registered for this source language
		return { name: 'source-lang-keywords', passed: true, severity: 'warning' };
	}

	// Remove comment lines before checking to avoid false positives in comment blocks
	const codeWithoutComments = stripLineComments(parseResult.translatedCode, ctx.targetLang);
	const found = patterns.find(p => p.test(codeWithoutComments));

	return {
		name:    'source-lang-keywords',
		passed:  !found,
		severity: 'warning',
		message: found ? `Source language (${src.toUpperCase()}) keywords detected in translated output \u2014 may indicate untranslated blocks` : undefined,
	};
}

function checkBalancedBraces(
	parseResult: ITranslationParseResult,
	ctx: IBuiltTranslationContext,
): IVerificationCheck {
	// Only applicable to brace-delimited languages
	const BRACE_DELIMITED = new Set(['java', 'typescript', 'javascript', 'csharp', 'c', 'cpp', 'go', 'rust', 'kotlin', 'scala']);
	if (!BRACE_DELIMITED.has(ctx.targetLang.toLowerCase())) {
		return { name: 'balanced-braces', passed: true, severity: 'warning' };
	}

	const code = parseResult.translatedCode;
	let depth = 0;
	let inString = false;
	let stringChar = '';
	let inLineComment = false;
	let inBlockComment = false;

	for (let i = 0; i < code.length; i++) {
		const ch = code[i];
		const next = code[i + 1] ?? '';

		if (inLineComment) {
			if (ch === '\n') { inLineComment = false; }
			continue;
		}
		if (inBlockComment) {
			if (ch === '*' && next === '/') { inBlockComment = false; i++; }
			continue;
		}
		if (inString) {
			if (ch === '\\') { i++; continue; } // escape
			if (ch === stringChar) { inString = false; }
			continue;
		}

		if (ch === '/' && next === '/') { inLineComment = true; continue; }
		if (ch === '/' && next === '*') { inBlockComment = true; continue; }
		if (ch === '"' || ch === "'") { inString = true; stringChar = ch; continue; }
		if (ch === '`') { inString = true; stringChar = '`'; continue; } // template literal

		if (ch === '{') { depth++; }
		if (ch === '}') { depth--; }
	}

	const balanced = depth === 0;
	return {
		name:    'balanced-braces',
		passed:  balanced,
		severity: 'warning',
		message: balanced ? undefined : `Unbalanced braces in translated code (net depth=${depth}) \u2014 likely incomplete output`,
	};
}

function checkLengthSanity(
	parseResult: ITranslationParseResult,
	ctx: IBuiltTranslationContext,
): IVerificationCheck {
	const sourceLen = ctx.resolvedSource.length;
	const outputLen = parseResult.translatedCode.length;

	if (sourceLen === 0) {
		return { name: 'length-sanity', passed: true, severity: 'warning' };
	}

	const ratio = outputLen / sourceLen;
	// Very short output relative to source (< 10%) suggests truncation or failure
	const tooShort = ratio < 0.10;
	// Excessively long output (> 1200%) suggests the AI included explanatory text
	const tooLong  = ratio > 12.0;

	const passed = !tooShort && !tooLong;
	let message: string | undefined;
	if (tooShort) {
		message = `Translated code is suspiciously short (${Math.round(ratio * 100)}% of source) \u2014 possible truncation`;
	} else if (tooLong) {
		message = `Translated code is very long (${Math.round(ratio * 100)}% of source) \u2014 may contain extraneous text`;
	}

	return { name: 'length-sanity', passed, severity: 'warning', message };
}

function checkBlockingDecisions(parseResult: ITranslationParseResult): IVerificationCheck {
	const blockingCount = parseResult.decisionsRaised.filter(d => d.priority === 'blocking').length;
	const hasBlocking   = blockingCount > 0;
	return {
		name:    'blocking-decision-raised',
		passed:  !hasBlocking,
		severity: 'info',
		message: hasBlocking ? `${blockingCount} blocking decision(s) raised \u2014 unit will be flagged as blocked` : undefined,
	};
}

function checkLowConfidence(parseResult: ITranslationParseResult): IVerificationCheck {
	const LOW_CONFIDENCE: TranslationConfidence[] = ['low', 'uncertain'];
	const isLow = LOW_CONFIDENCE.includes(parseResult.confidence);
	return {
		name:    'low-confidence',
		passed:  !isLow,
		severity: 'info',
		message: isLow ? `AI reported ${parseResult.confidence} confidence \u2014 human review recommended` : undefined,
	};
}


// \u2500\u2500\u2500 Utility \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** Strip single-line comments to avoid false-positive keyword detection in comments */
function stripLineComments(code: string, targetLang: string): string {
	const lang = targetLang.toLowerCase();

	// Languages using // for comments
	if (['java', 'typescript', 'javascript', 'csharp', 'c', 'cpp', 'go', 'rust', 'kotlin', 'scala'].includes(lang)) {
		return code.replace(/\/\/[^\n]*/g, '');
	}
	// Languages using # for comments
	if (['python', 'ruby', 'perl'].includes(lang)) {
		return code.replace(/#[^\n]*/g, '');
	}
	return code;
}
