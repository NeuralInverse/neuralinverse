/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Validation Result Parser
 *
 * Parses the XML response from the LLM equivalence analysis prompt into
 * an IValidationParseResult.
 *
 * ## Extraction strategy (4 passes, most strict to most lenient)
 *
 *   Pass 1 \u2014 Strict XML: look for well-formed <equivalence>...</equivalence> block
 *   Pass 2 \u2014 Lenient XML: extract individual <test_case> blocks + <summary>
 *   Pass 3 \u2014 Partial recovery: extract whatever test cases are present, infer totals
 *   Pass 4 \u2014 Failure: return parseSucceeded=false with the raw text as parseError
 *
 * ## XML schema parsed
 *
 *   <equivalence>
 *     <test_cases>
 *       <test_case id="tc-N">
 *         <input>...</input>
 *         <expected_legacy>...</expected_legacy>
 *         <expected_modern>...</expected_modern>
 *         <status>pass|fail</status>
 *         <divergence_type>value|...</divergence_type>   <!-- only when fail -->
 *         <explanation>...</explanation>
 *       </test_case>
 *     </test_cases>
 *     <summary>
 *       <total>N</total>
 *       <passed>N</passed>
 *       <failed>N</failed>
 *       <confidence>high|medium|low|uncertain</confidence>
 *       <analysis>...</analysis>
 *     </summary>
 *   </equivalence>
 */

import { IValidationParseResult, IValidationTestCase, ValidationConfidence } from './validationTypes.js';
import { OutputDivergenceType } from '../../../../common/modernisationTypes.js';


// \u2500\u2500\u2500 Valid enum values \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const VALID_CONFIDENCE: ValidationConfidence[] = ['high', 'medium', 'low', 'uncertain'];
const VALID_DIVERGENCE: OutputDivergenceType[] = [
	'value', 'rounding', 'missing-record', 'extra-record', 'checksum', 'precision',
];

function isValidConfidence(s: string): s is ValidationConfidence {
	return (VALID_CONFIDENCE as string[]).includes(s);
}

function isValidDivergenceType(s: string): s is OutputDivergenceType {
	return (VALID_DIVERGENCE as string[]).includes(s);
}


// \u2500\u2500\u2500 Main parser \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Parse the raw LLM response string into an IValidationParseResult.
 * Never throws \u2014 all failures return parseSucceeded=false.
 */
export function parseValidationResponse(rawResponse: string): IValidationParseResult {
	if (!rawResponse || rawResponse.trim().length === 0) {
		return _failResult('LLM returned an empty response.');
	}

	// Pass 1: try to extract the full <equivalence> block
	const xmlBlock = _extractXmlBlock(rawResponse, 'equivalence');

	if (xmlBlock) {
		const result = _parseEquivalenceXml(xmlBlock);
		if (result.parseSucceeded) { return result; }
	}

	// Pass 2: lenient \u2014 extract individual test case blocks directly from raw
	const lenientResult = _parseLenient(rawResponse);
	if (lenientResult.parseSucceeded) { return lenientResult; }

	// Pass 3: partial recovery \u2014 even if no well-formed XML, try to recover test cases
	const partialResult = _parsePartial(rawResponse);
	if (partialResult.parseSucceeded) { return partialResult; }

	// Pass 4: total failure
	return _failResult(
		`Could not extract structured equivalence analysis from LLM response. ` +
		`Raw length: ${rawResponse.length} chars. ` +
		`First 200 chars: ${rawResponse.slice(0, 200)}`,
	);
}


// \u2500\u2500\u2500 Pass 1: strict XML parse \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _parseEquivalenceXml(xml: string): IValidationParseResult {
	const testCases = _parseTestCases(xml);
	const summary   = _parseSummary(xml);

	if (testCases.length === 0 && !summary.analysis) {
		return _failResult('XML block found but contained no test cases or summary.');
	}

	const passCount = testCases.filter(tc => tc.passed).length;
	const failCount = testCases.filter(tc => !tc.passed).length;

	// Prefer parsed counts from summary; fall back to computed
	const totalFromXml  = summary.total  ?? testCases.length;
	const passFromXml   = summary.passed ?? passCount;
	const failFromXml   = summary.failed ?? failCount;
	const confidence    = summary.confidence ?? _inferConfidence(testCases, failFromXml, totalFromXml);

	return {
		parseSucceeded: true,
		testCases,
		totalCount:  totalFromXml,
		passCount:   passFromXml,
		failCount:   failFromXml,
		confidence,
		analysis:    summary.analysis ?? '',
	};
}


// \u2500\u2500\u2500 Test case extraction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _parseTestCases(xml: string): IValidationTestCase[] {
	const testCases: IValidationTestCase[] = [];
	const tcBlockRe = /<test_case\b[^>]*>([\s\S]*?)<\/test_case>/gi;

	let match: RegExpExecArray | null;
	while ((match = tcBlockRe.exec(xml)) !== null) {
		const block  = match[0];
		const inner  = match[1];

		const idAttr  = _extractAttr(block, 'id') ?? `tc-${testCases.length + 1}`;
		const input   = _extractTag(inner, 'input')           ?? '';
		const legacy  = _extractTag(inner, 'expected_legacy') ?? '';
		const modern  = _extractTag(inner, 'expected_modern') ?? '';
		const status  = _extractTag(inner, 'status')          ?? 'pass';
		const divType = _extractTag(inner, 'divergence_type');
		const expl    = _extractTag(inner, 'explanation')     ?? '';

		const passed = status.toLowerCase().trim() === 'pass';

		const tc: IValidationTestCase = {
			id:               idAttr,
			inputDescription: input.trim(),
			expectedLegacy:   legacy.trim(),
			expectedModern:   modern.trim(),
			passed,
			explanation:      expl.trim(),
		};

		if (!passed && divType && isValidDivergenceType(divType.trim())) {
			tc.divergenceType = divType.trim() as OutputDivergenceType;
		} else if (!passed && divType) {
			// Map common aliases
			tc.divergenceType = _normalizeDivergenceType(divType.trim());
		}

		testCases.push(tc);
	}

	return testCases;
}


// \u2500\u2500\u2500 Summary extraction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface ISummaryData {
	total?:      number;
	passed?:     number;
	failed?:     number;
	confidence?: ValidationConfidence;
	analysis?:   string;
}

function _parseSummary(xml: string): ISummaryData {
	const summaryBlock = _extractXmlBlock(xml, 'summary');
	if (!summaryBlock) { return {}; }

	const totalStr  = _extractTag(summaryBlock, 'total');
	const passedStr = _extractTag(summaryBlock, 'passed');
	const failedStr = _extractTag(summaryBlock, 'failed');
	const confStr   = _extractTag(summaryBlock, 'confidence');
	const analysis  = _extractTag(summaryBlock, 'analysis');

	const result: ISummaryData = {};

	if (totalStr  !== null) { result.total  = _safeInt(totalStr);  }
	if (passedStr !== null) { result.passed = _safeInt(passedStr); }
	if (failedStr !== null) { result.failed = _safeInt(failedStr); }

	if (confStr) {
		const c = confStr.trim().toLowerCase() as ValidationConfidence;
		result.confidence = isValidConfidence(c) ? c : 'uncertain';
	}

	if (analysis) { result.analysis = analysis.trim(); }

	return result;
}


// \u2500\u2500\u2500 Pass 2: lenient parse \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _parseLenient(raw: string): IValidationParseResult {
	// Try extracting test case blocks without requiring <equivalence> wrapper
	const testCases = _parseTestCases(raw);
	if (testCases.length === 0) {
		return _failResult('Lenient parse: no <test_case> blocks found.');
	}

	// Try to find summary block anywhere in the text
	const summary   = _parseSummary(raw);
	const passCount = testCases.filter(tc => tc.passed).length;
	const failCount = testCases.filter(tc => !tc.passed).length;

	return {
		parseSucceeded: true,
		testCases,
		totalCount:  summary.total  ?? testCases.length,
		passCount:   summary.passed ?? passCount,
		failCount:   summary.failed ?? failCount,
		confidence:  summary.confidence ?? _inferConfidence(testCases, failCount, testCases.length),
		analysis:    summary.analysis ?? '',
	};
}


// \u2500\u2500\u2500 Pass 3: partial recovery \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _parsePartial(raw: string): IValidationParseResult {
	// Try to infer a minimal result from the LLM's plain-text response
	// Look for pass/fail mentions, confidence terms

	const lower    = raw.toLowerCase();
	const hasPass  = /\bpass(ed)?\b/.test(lower);
	const hasFail  = /\bfail(ed)?\b/.test(lower) || /\bdiverg/.test(lower);
	const hasEquiv = /\bequivalent\b/.test(lower) || /\bidentical\b/.test(lower);

	if (!hasPass && !hasFail && !hasEquiv) {
		return _failResult('Partial recovery: no equivalence signals found in response.');
	}

	// Synthesise a single summary test case from the plain-text response
	const syntheticTc: IValidationTestCase = {
		id:               'tc-synthetic-1',
		inputDescription: 'General equivalence assessment (auto-synthesised from plain-text response)',
		expectedLegacy:   'Defined by source code logic',
		expectedModern:   'Defined by translated code logic',
		passed:           hasEquiv && !hasFail,
		explanation:      raw.slice(0, 500),
	};

	return {
		parseSucceeded: true,
		testCases:      [syntheticTc],
		totalCount:     1,
		passCount:      syntheticTc.passed ? 1 : 0,
		failCount:      syntheticTc.passed ? 0 : 1,
		confidence:     'uncertain',
		analysis:       raw.slice(0, 1000),
	};
}


// \u2500\u2500\u2500 Confidence inference \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _inferConfidence(
	testCases: IValidationTestCase[],
	failCount: number,
	total: number,
): ValidationConfidence {
	if (total === 0) { return 'uncertain'; }
	const failRatio = failCount / total;
	if (failRatio === 0)   { return 'high'; }
	if (failRatio <= 0.25) { return 'medium'; }
	if (failRatio <= 0.5)  { return 'low'; }
	return 'uncertain';
}


// \u2500\u2500\u2500 XML utilities \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** Extract the content of a self-contained <tag>...</tag> block (first match) */
function _extractTag(xml: string, tag: string): string | null {
	const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
	const m  = re.exec(xml);
	return m ? _decodeXmlEntities(m[1]) : null;
}

/** Extract the raw (outer) content of a tag block including the wrapper tags */
function _extractXmlBlock(xml: string, tag: string): string | null {
	const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'i');
	const m  = re.exec(xml);
	return m ? m[0] : null;
}

/** Extract a named attribute from an opening tag, e.g. id="tc-1" */
function _extractAttr(tag: string, attr: string): string | null {
	const re = new RegExp(`\\b${attr}\\s*=\\s*["']([^"']*)["']`, 'i');
	const m  = re.exec(tag);
	return m ? m[1] : null;
}

function _decodeXmlEntities(s: string): string {
	return s
		.replace(/&amp;/g,  '&')
		.replace(/&lt;/g,   '<')
		.replace(/&gt;/g,   '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g,  "'");
}

function _safeInt(s: string): number {
	const n = parseInt(s.trim(), 10);
	return Number.isNaN(n) ? 0 : n;
}

function _normalizeDivergenceType(raw: string): OutputDivergenceType {
	const lower = raw.toLowerCase();
	if (lower.includes('round'))   { return 'rounding'; }
	if (lower.includes('missing')) { return 'missing-record'; }
	if (lower.includes('extra'))   { return 'extra-record'; }
	if (lower.includes('check'))   { return 'checksum'; }
	if (lower.includes('precis'))  { return 'precision'; }
	return 'value'; // default
}


// \u2500\u2500\u2500 Failure factory \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _failResult(parseError: string): IValidationParseResult {
	return {
		parseSucceeded: false,
		testCases:      [],
		totalCount:     0,
		passCount:      0,
		failCount:      0,
		confidence:     'uncertain',
		analysis:       '',
		parseError,
	};
}
