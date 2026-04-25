/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Validation Prompt Builder (Layer 2)
 *
 * Builds the LLMChatMessage[] array for the semantic equivalence analysis prompt.
 *
 * ## Prompt structure
 *
 *   System message:
 *     - Role: expert code equivalence analyst
 *     - XML output format specification
 *     - Divergence type taxonomy
 *
 *   User message:
 *     - Source code (legacy, with language label)
 *     - Target code (modern translation, with language label)
 *     - Unit metadata (name, domain, applicable business rules)
 *     - Layer 1 static check failures (if any) \u2014 give the LLM pre-computed hints
 *     - On retry: previous failure reason
 *
 * ## Output format
 *
 *   The LLM is asked to produce XML:
 *
 *   <equivalence>
 *     <test_cases>
 *       <test_case id="tc-1">
 *         <input>...</input>
 *         <expected_legacy>...</expected_legacy>
 *         <expected_modern>...</expected_modern>
 *         <status>pass|fail</status>
 *         <divergence_type>value|rounding|missing-record|extra-record|checksum|precision</divergence_type>
 *         <explanation>...</explanation>
 *       </test_case>
 *       ...
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

import { IStaticCheckResult } from './validationTypes.js';

export interface LLMChatMessage {
	role:    'system' | 'user' | 'assistant';
	content: string;
}


// \u2500\u2500\u2500 Token budget \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** Approximate char budget for each code section (allows ~4k tokens each) */
const SOURCE_CHAR_BUDGET = 8_000;
const TARGET_CHAR_BUDGET = 8_000;


// \u2500\u2500\u2500 Prompt builder \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IValidationPromptInput {
	unitName:        string;
	sourceLang:      string;
	targetLang:      string;
	sourceCode:      string;
	targetCode:      string;
	/** Optional domain context */
	domain?:         string;
	/** Top business rules for this unit (max 5 displayed) */
	businessRules?:  string[];
	/** Layer 1 static check warnings/failures */
	staticFailures?: IStaticCheckResult[];
	/** Injected on retry: the error/issue from the previous parse attempt */
	retryReason?:    string;
	/** 0-based attempt index */
	attemptIndex?:   number;
}

/**
 * Build the LLM prompt messages for equivalence analysis.
 * Returns a `LLMChatMessage[]` array suitable for sendLLMMessage.
 */
export function buildValidationPrompt(input: IValidationPromptInput): LLMChatMessage[] {
	const messages: LLMChatMessage[] = [];

	messages.push({ role: 'system', content: _buildSystemPrompt() });
	messages.push({ role: 'user',   content: _buildUserPrompt(input) });

	// On retries, append the previous failure as an assistant + user turn
	if (input.attemptIndex && input.attemptIndex > 0 && input.retryReason) {
		messages.push({
			role:    'assistant',
			content: `I encountered an issue with my previous response: the output could not be parsed correctly.`,
		});
		messages.push({
			role:    'user',
			content: `Your previous response could not be parsed. Reason: ${input.retryReason}\n\nPlease try again and ensure your entire response is valid XML strictly matching the <equivalence>...</equivalence> format specified in the instructions. Do not include any text outside the XML tags.`,
		});
	}

	return messages;
}


// \u2500\u2500\u2500 System prompt \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildSystemPrompt(): string {
	return `You are an expert code equivalence analyst specialising in legacy system modernisation. Your task is to assess whether a translated (modern) code unit is semantically equivalent to the original (legacy) source code.

You will be shown both the legacy source and the modern translation. You must:
1. Generate concrete test cases \u2014 real inputs that exercise the unit's logic
2. Determine whether the modern code would produce the same output as the legacy for each test case
3. Identify and classify any semantic divergences

## Output Format

You MUST respond with ONLY valid XML in exactly this structure. Do not include any text outside the XML tags:

<equivalence>
  <test_cases>
    <test_case id="tc-1">
      <input>Description of input data / scenario</input>
      <expected_legacy>What legacy code would output or return for this input</expected_legacy>
      <expected_modern>What modern code would output or return for this input</expected_modern>
      <status>pass</status>
      <explanation>Why these outputs are equivalent</explanation>
    </test_case>
    <test_case id="tc-2">
      <input>Description of input data / scenario</input>
      <expected_legacy>What legacy code would output</expected_legacy>
      <expected_modern>What modern code would output (different from legacy)</expected_modern>
      <status>fail</status>
      <divergence_type>value</divergence_type>
      <explanation>Why these outputs diverge and what the impact is</explanation>
    </test_case>
  </test_cases>
  <summary>
    <total>2</total>
    <passed>1</passed>
    <failed>1</failed>
    <confidence>medium</confidence>
    <analysis>Narrative explanation of the overall equivalence assessment, key risks, and any caveats.</analysis>
  </summary>
</equivalence>

## Test Case Requirements

- Generate between 3 and 8 test cases covering:
  * Normal/happy path
  * Boundary values (zero, empty, max, min)
  * Error conditions (null inputs, invalid data)
  * Business logic branches (each major conditional path)
  * Edge cases specific to this domain

## Divergence Types (use in <divergence_type> only for failed test cases)

- value           \u2014 Output value differs (wrong result computed)
- rounding        \u2014 Rounding behaviour differs (common with COMP-3 \u2192 floating point)
- missing-record  \u2014 A record present in legacy output is absent in modern
- extra-record    \u2014 A record present in modern output was not in legacy
- checksum        \u2014 File/batch checksum mismatch
- precision       \u2014 Decimal precision differs

## Confidence Levels

- high      \u2014 You are certain about the equivalence assessment
- medium    \u2014 Likely equivalent but some ambiguity remains
- low       \u2014 Significant uncertainty, human review strongly recommended
- uncertain \u2014 Cannot assess without runtime execution

## Important Guidelines

- If the modern code appears incomplete or has placeholders, mark relevant test cases as fail
- Focus on BUSINESS LOGIC equivalence \u2014 minor stylistic differences are acceptable
- Consider type coercion differences between languages (e.g. integer vs. float division)
- Consider null/undefined handling differences
- Consider string encoding differences
- For COBOL \u2192 Java: pay special attention to COMP-3 arithmetic precision and sign handling
- For Embedded C \u2192 FreeRTOS/Zephyr: verify ISR deferral semantics, RTOS primitive equivalence, watchdog refresh strategy, and absence of blocking calls in ISR handlers
- For IEC 61131-3 Ladder \u2192 Structured Text: verify scan-cycle order, coil latch/unlatch semantics, safety FB (SF_ prefix) call completeness, and timer/counter instance preservation
- For AUTOSAR Classic \u2192 Adaptive: verify Rte_Read/Write equivalence to ara::com Get/Update, DEM event reporting, and NvM block to ara::per KVS mapping
- For CAN DBC \u2192 CANopen: verify PDO signal-to-OD mapping, signal scaling (factor/offset) preservation, COB-ID assignments, and NMT boot sequence
- For bare-metal C \u2192 RTOS: verify volatile globals replaced with RTOS queues/semaphores, no malloc in tasks, and watchdog refresh coverage
- For Assembly \u2192 Embedded C: verify CMSIS named constants replace raw register addresses, ISR naming follows _IRQHandler convention, and critical section symmetry`;
}


// \u2500\u2500\u2500 User prompt \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildUserPrompt(input: IValidationPromptInput): string {
	const parts: string[] = [];

	// Unit header
	parts.push(`## Unit: ${input.unitName}`);
	if (input.domain) {
		parts.push(`**Domain:** ${input.domain}`);
	}
	parts.push(`**Source language:** ${input.sourceLang}`);
	parts.push(`**Target language:** ${input.targetLang}`);
	parts.push('');

	// Business rules (context for equivalence assessment)
	if (input.businessRules && input.businessRules.length > 0) {
		parts.push('## Key Business Rules');
		parts.push('These rules were extracted from the source. The modern translation must preserve all of them:');
		for (const rule of input.businessRules.slice(0, 5)) {
			parts.push(`- ${rule}`);
		}
		parts.push('');
	}

	// Static check failures \u2014 give LLM pre-computed structural hints
	const failures = (input.staticFailures ?? []).filter(c => c.status === 'fail' || c.status === 'warn');
	if (failures.length > 0) {
		parts.push('## Static Analysis Warnings');
		parts.push('The following structural issues were detected in the translation. These should inform your test case selection:');
		for (const f of failures) {
			const icon = f.status === 'fail' ? '\u274C' : '\u26A0\uFE0F';
			parts.push(`${icon} **${f.label}**: ${f.detail}`);
		}
		parts.push('');
	}

	// Source code
	const truncatedSource = input.sourceCode.length > SOURCE_CHAR_BUDGET
		? input.sourceCode.slice(0, SOURCE_CHAR_BUDGET) + '\n... [truncated for token budget]'
		: input.sourceCode;

	parts.push(`## Legacy Source Code (${input.sourceLang})`);
	parts.push('```' + input.sourceLang);
	parts.push(truncatedSource);
	parts.push('```');
	parts.push('');

	// Target code
	const truncatedTarget = input.targetCode.length > TARGET_CHAR_BUDGET
		? input.targetCode.slice(0, TARGET_CHAR_BUDGET) + '\n... [truncated for token budget]'
		: input.targetCode;

	parts.push(`## Modern Translation (${input.targetLang})`);
	parts.push('```' + input.targetLang);
	parts.push(truncatedTarget);
	parts.push('```');
	parts.push('');

	// Instruction
	parts.push('## Instructions');
	parts.push('Analyse the legacy source and modern translation above.');
	parts.push('Generate test cases that exercise the unit\'s business logic and determine if the outputs are equivalent.');
	parts.push('');
	parts.push('Respond with ONLY the XML equivalence analysis. No preamble, no explanation outside the XML.');

	return parts.join('\n');
}
