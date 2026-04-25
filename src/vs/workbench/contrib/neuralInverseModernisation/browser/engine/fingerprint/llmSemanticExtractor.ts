/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # LLM Semantic Extractor \u2014 Layer 2
 *
 * Extracts business rules and compliance domains from legacy source code
 * using the platform's LLM (via Void). Operates after Layer 1 (deterministic
 * extractor) and enriches its results with semantic understanding.
 *
 * ## What It Does
 *
 * Given a migration unit's source and the Layer 1 regulated fields, it asks
 * the LLM to extract:
 * - Business rules in plain English (what this code does, not how)
 * - Which compliance domains are involved (fee_calculation, settlement, etc.)
 * - Logical invariants the modern translation must preserve
 *
 * ## LLM API
 *
 * Uses the same pattern as ContractReasonService:
 * ```
 * ILLMMessageService.sendLLMMessage() with feature 'Checks' \u2192 fallback 'Chat'
 * ```
 * TODO: Register 'Modernisation' in voidSettingsTypes.ts featureNames when adding
 * the model selection UI. For now uses 'Checks' feature model.
 *
 * ## Output Format
 *
 * The LLM is prompted to respond in structured JSON so output can be parsed
 * deterministically without string heuristics.
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { ILLMMessageService } from '../../../../void/common/sendLLMMessageService.js';
import { IVoidSettingsService } from '../../../../void/common/voidSettingsService.js';
import { LLMChatMessage } from '../../../../void/common/sendLLMMessageTypes.js';
import { IRegulatedField, ISemanticRule, ILogicalInvariant } from '../../../common/modernisationTypes.js';

export interface ILLMSemanticExtractionResult {
	semanticRules: ISemanticRule[];
	complianceDomains: string[];
	/** Additional invariants the LLM identified beyond the deterministic layer */
	additionalInvariants: ILogicalInvariant[];
}

export const ILLMSemanticExtractorService = createDecorator<ILLMSemanticExtractorService>('modernisationLLMSemanticExtractor');

export interface ILLMSemanticExtractorService {
	readonly _serviceBrand: undefined;

	/**
	 * Extract semantic business rules and compliance domains from a legacy unit.
	 *
	 * @param unitName         Name of the unit (e.g. "CALC-LATE-FEE")
	 * @param source           Raw source text of the unit (post-Enclave redaction)
	 * @param language         Source language (e.g. 'cobol')
	 * @param regulatedFields  Regulated fields already identified by Layer 1
	 */
	extractSemantics(
		unitName: string,
		source: string,
		language: string,
		regulatedFields: IRegulatedField[],
	): Promise<ILLMSemanticExtractionResult>;
}

class LLMSemanticExtractorService extends Disposable implements ILLMSemanticExtractorService {
	readonly _serviceBrand: undefined;

	constructor(
		@ILLMMessageService private readonly llmMessageService: ILLMMessageService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
	) {
		super();
	}

	async extractSemantics(
		unitName: string,
		source: string,
		language: string,
		regulatedFields: IRegulatedField[],
	): Promise<ILLMSemanticExtractionResult> {
		const modelSelection =
			this.voidSettingsService.state.modelSelectionOfFeature['Checks'] ??
			this.voidSettingsService.state.modelSelectionOfFeature['Chat'];

		if (!modelSelection) {
			return { semanticRules: [], complianceDomains: [], additionalInvariants: [] };
		}

		const prompt = buildExtractionPrompt(unitName, source, language, regulatedFields);

		return new Promise((resolve) => {
			this.llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				messages: prompt,
				separateSystemMessage: undefined,
				chatMode: null,
				modelSelection,
				logging: { loggingName: 'ModernisationSemanticExtractor' },
				modelSelectionOptions: undefined,
				overridesOfModel: undefined,
				onText: () => { },
				onFinalMessage: ({ fullText: finalText }) => {
					resolve(parseExtractionResponse(finalText));
				},
				onError: (_error) => {
					// On LLM error, return empty \u2014 deterministic layer still provides partial fingerprint
					resolve({ semanticRules: [], complianceDomains: [], additionalInvariants: [] });
				},
				onAbort: () => { },
			});
		});
	}
}


// \u2500\u2500\u2500 Prompt Construction \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function buildExtractionPrompt(
	unitName: string,
	source: string,
	language: string,
	regulatedFields: IRegulatedField[],
): LLMChatMessage[] {
	const fieldSummary = regulatedFields.length > 0
		? regulatedFields.map(f => `- ${f.fieldName} (${f.regulatedAttribute}, ${f.framework})`).join('\n')
		: 'None identified by structural analysis.';

	const systemPrompt = `You are a compliance analysis engine for a regulated software modernisation platform.
Your role is to extract the regulatory and business logic meaning from legacy code.
You MUST respond with valid JSON only \u2014 no explanation, no markdown, no prose.
The JSON must match the schema exactly.`;

	const userPrompt = `Analyse this ${language.toUpperCase()} unit named "${unitName}" and extract its compliance fingerprint.

## Source Code
\`\`\`${language}
${source}
\`\`\`

## Regulated Fields Already Identified (Layer 1)
${fieldSummary}

## Required Output (JSON only)

Respond with this exact JSON structure:
{
  "semanticRules": [
    {
      "description": "<plain English: what this unit does from a business/regulatory perspective>",
      "domain": "<one of: fee_calculation | interest_accrual | transaction_settlement | tax_computation | identity_verification | audit_logging | payment_processing | usage_billing | data_validation | authorisation | reconciliation | end_of_day_processing | other>",
      "preservationRequired": <true if this rule directly affects a regulated monetary or compliance outcome, false otherwise>,
      "involvedFields": ["<field names from the regulated fields list>"]
    }
  ],
  "complianceDomains": ["<list of domain strings from above that apply to this unit>"],
  "additionalInvariants": [
    {
      "description": "<a specific constraint the modern translation must preserve \u2014 be precise>",
      "invariantType": "<rounding_behaviour | decimal_precision | transaction_atomicity | null_handling | overflow_behaviour | order_dependency | other>",
      "testable": <true if this can be verified with input/output testing, false if it requires manual review>
    }
  ]
}

Rules:
- If this unit contains no business logic relevant to compliance, return empty arrays.
- semanticRules should describe WHAT the code does, not HOW (avoid mentioning PERFORM, MOVE, etc.)
- Be specific about monetary amounts: "calculates late fee as 1.5% of overdue balance after 30 days" not "processes a fee"
- additionalInvariants should capture constraints not obvious from field names alone (e.g. specific rounding rules, NULL handling, overflow behaviour)`;

	return [
		{ role: 'system', content: systemPrompt },
		{ role: 'user', content: userPrompt },
	] as LLMChatMessage[];
}


// \u2500\u2500\u2500 Response Parser \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function parseExtractionResponse(responseText: string): ILLMSemanticExtractionResult {
	// Strip markdown code fences if the model wrapped the JSON
	const cleaned = responseText.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

	try {
		const parsed = JSON.parse(cleaned);

		const semanticRules: ISemanticRule[] = (parsed.semanticRules ?? []).map((r: Record<string, unknown>) => ({
			description: String(r.description ?? ''),
			domain: String(r.domain ?? 'other'),
			preservationRequired: Boolean(r.preservationRequired ?? false),
			involvedFields: Array.isArray(r.involvedFields) ? r.involvedFields.map(String) : [],
		}));

		const complianceDomains: string[] = Array.isArray(parsed.complianceDomains)
			? parsed.complianceDomains.map(String)
			: [];

		const additionalInvariants: ILogicalInvariant[] = (parsed.additionalInvariants ?? []).map((i: Record<string, unknown>) => ({
			description: String(i.description ?? ''),
			invariantType: String(i.invariantType ?? 'other'),
			testable: Boolean(i.testable ?? false),
		}));

		return { semanticRules, complianceDomains, additionalInvariants };
	} catch {
		// JSON parse failed \u2014 return empty rather than crash
		return { semanticRules: [], complianceDomains: [], additionalInvariants: [] };
	}
}


registerSingleton(ILLMSemanticExtractorService, LLMSemanticExtractorService, InstantiationType.Delayed);
