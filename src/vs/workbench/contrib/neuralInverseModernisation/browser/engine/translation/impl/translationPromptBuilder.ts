/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Translation Prompt Builder
 *
 * Constructs the `LLMChatMessage[]` array (system + user messages) that drives
 * the Translation Engine's LLM call.
 *
 * ## Prompt Architecture
 *
 * ### System Message
 * Sets the AI's expert persona and the mandatory output format.
 * The format is XML-tagged to allow deterministic parsing:
 *
 * ```xml
 * <translation>
 * [full translated code here \u2014 no truncation, no ellipsis]
 * </translation>
 * <metadata>
 * {
 *   "confidence":          "high|medium|low|uncertain",
 *   "reasoning":           "...",
 *   "decisionsRaised":     [ { "type", "priority", "question", "context", "options"? } ],
 *   "sectionsUnresolved":  [],
 *   "idiomNotes":          []
 * }
 * </metadata>
 * ```
 *
 * ### User Message
 * Contains, in order:
 *   1. Unit identity (name, type, risk level, domain, migration pattern)
 *   2. Source code (fully resolved, with inlined dependencies)
 *   3. Established decisions (type mappings, naming, rule interpretations)
 *   4. Called interfaces (exact signatures for dependency calls)
 *   5. Business rules (preservation-required only)
 *   6. Domain glossary
 *   7. Construct mappings for this language pair
 *   8. Target conventions
 *   9. Human context annotations
 *  10. Translation instructions (explicit, unambiguous)
 *
 * ## Decision Raising Protocol
 *
 * When the AI encounters a construct it cannot safely translate without human
 * input, it MUST raise an `IPendingDecision` in the metadata rather than guessing.
 * The system prompt makes this non-negotiable.
 */

import { LLMChatMessage } from '../../../../../void/common/sendLLMMessageTypes.js';
import { IBuiltTranslationContext, IVerificationCheck } from './translationTypes.js';


// \u2500\u2500\u2500 Main entry point \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Build the `LLMChatMessage[]` array for one translation attempt.
 *
 * @param ctx              The assembled context for this unit
 * @param attemptNum       0-based attempt number (affects retry instructions)
 * @param failedChecks     Verification checks that failed in the previous attempt.
 *                         When provided, the specific failures are injected into the
 *                         retry prompt so the AI knows exactly what to fix.
 */
export function buildTranslationPrompt(
	ctx: IBuiltTranslationContext,
	attemptNum: number,
	failedChecks?: IVerificationCheck[],
): LLMChatMessage[] {
	return [
		{ role: 'system', content: buildSystemMessage(ctx) },
		{ role: 'user',   content: buildUserMessage(ctx, attemptNum, failedChecks) },
	] as LLMChatMessage[];
}


// \u2500\u2500\u2500 System message \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function buildSystemMessage(ctx: IBuiltTranslationContext): string {
	const target = ctx.targetFramework
		? `${ctx.targetLang} (${ctx.targetFramework})`
		: ctx.targetLang;

	const sectorBlock = ctx.sectorGuidance
		? `\n\n${ctx.sectorGuidance}`
		: '';

	return `${ctx.systemPersona}${sectorBlock}

Your task is to translate source code from ${ctx.sourceLang.toUpperCase()} to ${target.toUpperCase()}.

## Mandatory Output Format

You MUST respond using EXACTLY this format \u2014 no prose before or after:

<translation>
[Complete translated code here. Do NOT truncate. Do NOT use ellipsis. Do NOT use placeholder comments like "// TODO: implement". The entire translated unit must appear here.]
</translation>
<metadata>
{
  "confidence": "<high|medium|low|uncertain>",
  "reasoning": "<1\u20133 sentence narrative: key decisions made, tricky patterns handled, why confidence is what it is>",
  "decisionsRaised": [
    {
      "type": "<type-mapping|naming|rule-interpretation|approval|exclusion>",
      "priority": "<low|medium|high|blocking>",
      "question": "<the specific question you cannot answer without human input>",
      "context": "<why you cannot decide this alone \u2014 reference the specific construct>",
      "options": ["<option A>", "<option B>"]
    }
  ],
  "sectionsUnresolved": ["<name of section left incomplete, if any>"],
  "idiomNotes": ["<each significant construct mapping applied>"]
}
</metadata>

## Decision Raising Rules

When you encounter a construct you CANNOT safely translate without human input:
1. In the <translation> block, write a comment: \`// [DECISION REQUIRED: brief description]\`
2. In the <metadata> block, add a decisionsRaised entry with ALL fields populated
3. Set "confidence" to "low" or "uncertain" if any blocking decisions are raised
4. Set a decision priority of "blocking" if the unit cannot function without this decision

NEVER guess when raising a decision would be appropriate. It is better to raise a decision than to produce incorrect business logic.

## Confidence Levels

- **high**: All constructs mapped cleanly, zero decisions raised, verified idiom coverage
- **medium**: Minor ambiguities resolved reasonably, at most 1\u20132 low/medium decisions
- **low**: Significant ambiguities, multiple decisions raised, or complex constructs
- **uncertain**: Major constructs not translatable \u2014 blocking decisions raised

## Translation Quality Requirements

1. Produce COMPLETE code \u2014 every paragraph, method, procedure, function
2. Preserve ALL business logic \u2014 every calculation, condition, loop, call
3. Use the EXACT type mappings and naming decisions from the context
4. Use the EXACT method signatures from the calledInterfaces section
5. Apply the idiom mappings from the construct mappings section
6. Use the target framework conventions from the conventions section
7. Never introduce new business logic not present in the source
8. Never omit error handling present in the source
9. Preserve all comments that describe business intent (translate comment text too)`;
}


// \u2500\u2500\u2500 User message \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function buildUserMessage(ctx: IBuiltTranslationContext, attemptNum: number, failedChecks?: IVerificationCheck[]): string {
	const sections: string[] = [];

	// \u2500\u2500 Unit identity \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	sections.push(buildIdentitySection(ctx));

	// \u2500\u2500 Chunk context (only present during chunked translation) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (ctx.chunkHeader) {
		sections.push(ctx.chunkHeader);
	}

	// \u2500\u2500 Source code \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	sections.push(buildSourceSection(ctx));

	// \u2500\u2500 Established decisions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (ctx.typeMappingContext) {
		sections.push(ctx.typeMappingContext);
	}
	if (ctx.namingContext) {
		sections.push(ctx.namingContext);
	}
	if (ctx.ruleInterpretationContext) {
		sections.push(ctx.ruleInterpretationContext);
	}
	if (ctx.patternOverrideContext) {
		sections.push(ctx.patternOverrideContext);
	}

	// \u2500\u2500 Tech debt summary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (ctx.techDebtSummary) {
		sections.push(ctx.techDebtSummary);
	}

	// \u2500\u2500 Locked blocking decisions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (ctx.blockingDecisionsContext) {
		sections.push(ctx.blockingDecisionsContext);
	}

	// \u2500\u2500 Called interfaces \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (ctx.calledInterfacesContext) {
		sections.push(ctx.calledInterfacesContext);
	}

	// \u2500\u2500 Dependency health \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (ctx.calledUnitHealthContext) {
		sections.push(ctx.calledUnitHealthContext);
	}

	// \u2500\u2500 Business rules \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (ctx.businessRulesContext) {
		sections.push(ctx.businessRulesContext);
	}

	// \u2500\u2500 Glossary \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (ctx.glossaryContext) {
		sections.push(ctx.glossaryContext);
	}

	// \u2500\u2500 Construct mappings (idiom map) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (ctx.idiomMapSummary) {
		sections.push(ctx.idiomMapSummary);
	}

	// \u2500\u2500 Target conventions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	sections.push(buildConventionsSection(ctx));

	// \u2500\u2500 Context annotations (human notes) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (ctx.annotationContext) {
		sections.push(ctx.annotationContext);
	}

	// \u2500\u2500 Retry guidance \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (attemptNum > 0) {
		sections.push(buildRetrySection(attemptNum, failedChecks));
	}

	// \u2500\u2500 Final instruction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	sections.push(buildInstructionSection(ctx));

	return sections.filter(s => s.trim().length > 0).join('\n\n');
}


// \u2500\u2500\u2500 Section builders \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function buildIdentitySection(ctx: IBuiltTranslationContext): string {
	const lines = [
		`## Unit to Translate`,
		`- **Name**: ${ctx.unitName}`,
		`- **Type**: ${ctx.unitType}`,
		`- **Risk Level**: ${ctx.riskLevel.toUpperCase()}`,
	];

	if (ctx.domain) {
		lines.push(`- **Business Domain**: ${ctx.domain}`);
	}

	if (ctx.migrationPatternLabel) {
		lines.push(`- **Migration Pattern**: ${ctx.migrationPatternLabel}`);
	}

	lines.push(`- **Source Language**: ${ctx.sourceLang.toUpperCase()}`);
	lines.push(`- **Target Language**: ${ctx.targetLang.toUpperCase()}${ctx.targetFramework ? ` (${ctx.targetFramework})` : ''}`);

	if (ctx.wasBudgetTrimmed && ctx.trimmedSections.length > 0) {
		lines.push(`\n> \u26A0 Token budget: the following sections were trimmed: ${ctx.trimmedSections.join(', ')}`);
	}

	return lines.join('\n');
}

function buildSourceSection(ctx: IBuiltTranslationContext): string {
	return `## Source Code (${ctx.sourceLang.toUpperCase()} \u2014 fully resolved with all dependencies inlined)

\`\`\`${ctx.sourceLang}
${ctx.resolvedSource}
\`\`\``;
}

function buildConventionsSection(ctx: IBuiltTranslationContext): string {
	const parts: string[] = [];

	if (ctx.conventionNotes) {
		parts.push(`## Target Conventions (${ctx.languagePairLabel})\n${ctx.conventionNotes}`);
	}

	if (ctx.targetConventions) {
		parts.push(`## Project-Specific Conventions\n${ctx.targetConventions}`);
	}

	if (ctx.warningPatternNotes) {
		parts.push(`## Warning Patterns \u2014 Raise Decisions For These\n${ctx.warningPatternNotes}`);
	}

	if (ctx.targetTestFramework) {
		parts.push(`## Test Framework\nIf the source contains test assertions or test programs, translate them using **${ctx.targetTestFramework}**.`);
	}

	return parts.join('\n\n');
}

function buildRetrySection(attemptNum: number, failedChecks?: IVerificationCheck[]): string {
	// List the specific failures from the previous attempt (if available)
	const failureDetail = buildFailureDetail(failedChecks);

	if (attemptNum === 1) {
		return `## Retry Guidance (Attempt ${attemptNum + 1})

The previous attempt produced a result that did NOT pass verification.${failureDetail}

Fix ALL of the issues above, then:
- Ensure the <translation> block contains COMPLETE code with no truncation, no ellipsis, no placeholder comments
- Ensure the <metadata> block contains valid JSON
- If any construct cannot be translated, raise a decision rather than leaving a placeholder`;
	}

	return `## Retry Guidance (Attempt ${attemptNum + 1}) \u2014 FINAL ATTEMPT

Previous attempts have not produced a valid result.${failureDetail}

This is the final attempt. Prioritise correctness over completeness:
- Write the FULL translation \u2014 every method, class, and function
- For any construct you are unsure about, write your best translation AND add a comment: \`// [UNCERTAIN: describe issue]\`
- Raise a decision in the metadata for every uncertain construct
- Set confidence to "low" or "uncertain" as appropriate
- Do NOT truncate \u2014 it is better to produce low-confidence output than empty output`;
}

/**
 * Format the specific verification failures from the previous attempt for injection
 * into the retry prompt. Returns an empty string if no failures are provided.
 */
function buildFailureDetail(failedChecks?: IVerificationCheck[]): string {
	if (!failedChecks || failedChecks.length === 0) { return ''; }

	const blockers  = failedChecks.filter(c => !c.passed && c.severity === 'blocker');
	const warnings  = failedChecks.filter(c => !c.passed && c.severity === 'warning');

	const lines: string[] = ['\n\n**Specific failures to fix:**'];

	for (const c of blockers) {
		lines.push(`- \u274C [BLOCKER] ${c.name}: ${c.message ?? 'check failed'}`);
	}
	for (const c of warnings) {
		lines.push(`- \u26A0 [WARNING] ${c.name}: ${c.message ?? 'check failed'}`);
	}

	return lines.join('\n');
}

function buildInstructionSection(ctx: IBuiltTranslationContext): string {
	const riskGuidance = ctx.riskLevel === 'critical' || ctx.riskLevel === 'high'
		? `\n\nThis is a **${ctx.riskLevel.toUpperCase()} RISK** unit. Apply maximum care to preserve all business logic. When in doubt, raise a decision rather than guessing.`
		: '';

	return `## Translate Now

Translate the ${ctx.sourceLang.toUpperCase()} unit "${ctx.unitName}" to ${ctx.targetLang.toUpperCase()}.${riskGuidance}

Apply all established decisions, naming conventions, type mappings, and idiom mappings above.
Produce the complete <translation> + <metadata> response now.`;
}
