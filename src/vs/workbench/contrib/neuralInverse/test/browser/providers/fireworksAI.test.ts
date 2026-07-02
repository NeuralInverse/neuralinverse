/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	defaultProviderSettings,
	defaultModelsOfProvider,
	getModelCapabilities,
	getProviderCapabilities,
	getSendableReasoningInfo,
} from '../../../../void/common/modelCapabilities.js';
import {
	displayInfoOfProviderName,
	subTextMdOfProviderName,
	customSettingNamesOfProvider,
} from '../../../../void/common/voidSettingsTypes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SendableReasoningInfo for effort_slider tests */
const effortSliderState = (effort: string) => ({
	type: 'effort_slider_value' as const,
	isReasoningEnabled: true as const,
	reasoningEffort: effort,
});

/** Retrieve the provider-level reasoning I/O settings for fireworksAI */
const fireworksReasoningIO = () => getProviderCapabilities('fireworksAI').providerReasoningIOSettings;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

suite('Fireworks AI provider — unit tests', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// -----------------------------------------------------------------------
	// 1. Provider Settings
	// -----------------------------------------------------------------------
	suite('Provider Settings', () => {

		test('defaultProviderSettings.fireworksAI has apiKey: empty string', () => {
			assert.strictEqual(defaultProviderSettings.fireworksAI.apiKey, '');
		});

		test('defaultProviderSettings.fireworksAI has only apiKey (no other keys)', () => {
			const keys = Object.keys(defaultProviderSettings.fireworksAI);
			assert.deepStrictEqual(keys, ['apiKey']);
		});

		test('displayInfoOfProviderName returns title "Fireworks AI"', () => {
			const info = displayInfoOfProviderName('fireworksAI');
			assert.strictEqual(info.title, 'Fireworks AI');
		});

		test('subTextMdOfProviderName contains API key link to fireworks.ai', () => {
			const text = subTextMdOfProviderName('fireworksAI');
			assert.ok(
				text.includes('fireworks.ai/account/api-keys') || text.includes('fireworks.ai'),
				`Expected fireworks.ai link in subText, got: ${text}`
			);
		});

		test('customSettingNamesOfProvider returns ["apiKey"]', () => {
			const names = customSettingNamesOfProvider('fireworksAI');
			assert.deepStrictEqual(names, ['apiKey']);
		});
	});

	// -----------------------------------------------------------------------
	// 2. Default models list
	// -----------------------------------------------------------------------
	suite('Default models list', () => {

		test('defaultModelsOfProvider.fireworksAI contains exactly 7 models', () => {
			assert.strictEqual(defaultModelsOfProvider.fireworksAI.length, 7);
		});

		test('defaultModelsOfProvider.fireworksAI contains expected model IDs', () => {
			const expected = [
				'accounts/fireworks/models/llama-v3p3-70b-instruct',
				'accounts/fireworks/models/deepseek-r1',
				'accounts/fireworks/models/qwen3-235b-a22b',
				'accounts/fireworks/models/qwen3-32b',
				'accounts/fireworks/models/gemma-4-31b-it',
				'accounts/fireworks/models/gpt-oss-120b',
				'accounts/fireworks/models/gpt-oss-20b',
			];
			for (const model of expected) {
				assert.ok(
					(defaultModelsOfProvider.fireworksAI as readonly string[]).includes(model),
					`Expected model "${model}" in defaultModelsOfProvider.fireworksAI`
				);
			}
		});

		test('all 7 default models resolve without isUnrecognizedModel: true', () => {
			for (const modelName of defaultModelsOfProvider.fireworksAI) {
				const caps = getModelCapabilities('fireworksAI', modelName, undefined);
				assert.strictEqual(
					caps.isUnrecognizedModel,
					false,
					`Expected isUnrecognizedModel=false for "${modelName}", got true`
				);
			}
		});
	});

	// -----------------------------------------------------------------------
	// 3. Model ID format — accounts/fireworks/models/ prefix preserved
	// -----------------------------------------------------------------------
	suite('Model ID format — accounts/fireworks/models/ prefix preserved', () => {

		test('modelName is preserved for accounts/fireworks/models/llama-v3p3-70b-instruct', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/llama-v3p3-70b-instruct', undefined);
			assert.strictEqual(caps.modelName, 'accounts/fireworks/models/llama-v3p3-70b-instruct');
		});

		test('modelName is preserved for accounts/fireworks/models/deepseek-r1', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/deepseek-r1', undefined);
			assert.strictEqual(caps.modelName, 'accounts/fireworks/models/deepseek-r1');
		});

		test('modelName is preserved for accounts/fireworks/models/qwen3-235b-a22b', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/qwen3-235b-a22b', undefined);
			assert.strictEqual(caps.modelName, 'accounts/fireworks/models/qwen3-235b-a22b');
		});

		test('modelName is preserved for accounts/fireworks/models/gemma-4-31b-it', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/gemma-4-31b-it', undefined);
			assert.strictEqual(caps.modelName, 'accounts/fireworks/models/gemma-4-31b-it');
		});
	});

	// -----------------------------------------------------------------------
	// 4. Model Capabilities — context windows
	// -----------------------------------------------------------------------
	suite('Model Capabilities — context window', () => {

		test('accounts/fireworks/models/llama-v3p3-70b-instruct has contextWindow 131,072', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/llama-v3p3-70b-instruct', undefined);
			assert.strictEqual(caps.contextWindow, 131_072);
		});

		test('accounts/fireworks/models/deepseek-r1 has contextWindow 163,840', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/deepseek-r1', undefined);
			assert.strictEqual(caps.contextWindow, 163_840);
		});

		test('accounts/fireworks/models/qwen3-235b-a22b has contextWindow 131,072', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/qwen3-235b-a22b', undefined);
			assert.strictEqual(caps.contextWindow, 131_072);
		});

		test('accounts/fireworks/models/qwen3-32b has contextWindow 131,072', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/qwen3-32b', undefined);
			assert.strictEqual(caps.contextWindow, 131_072);
		});

		test('accounts/fireworks/models/gemma-4-31b-it has contextWindow 262,144', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/gemma-4-31b-it', undefined);
			assert.strictEqual(caps.contextWindow, 262_144);
		});

		test('accounts/fireworks/models/gpt-oss-120b has contextWindow 131,072', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/gpt-oss-120b', undefined);
			assert.strictEqual(caps.contextWindow, 131_072);
		});

		test('accounts/fireworks/models/gpt-oss-20b has contextWindow 131,072', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/gpt-oss-20b', undefined);
			assert.strictEqual(caps.contextWindow, 131_072);
		});
	});

	// -----------------------------------------------------------------------
	// 5. Model Capabilities — reasoning
	// -----------------------------------------------------------------------
	suite('Model Capabilities — reasoning', () => {

		test('accounts/fireworks/models/llama-v3p3-70b-instruct has no reasoning capabilities', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/llama-v3p3-70b-instruct', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});

		test('accounts/fireworks/models/deepseek-r1 has think-tag reasoning with supportsSystemMessage: false', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/deepseek-r1', undefined);
			assert.ok(caps.reasoningCapabilities !== false, 'Expected reasoningCapabilities to be set');
			if (caps.reasoningCapabilities === false) return;
			assert.strictEqual(caps.reasoningCapabilities.supportsReasoning, true);
			assert.strictEqual(caps.reasoningCapabilities.canTurnOffReasoning, false);
			assert.strictEqual(caps.reasoningCapabilities.canIOReasoning, true);
			assert.deepStrictEqual(caps.reasoningCapabilities.openSourceThinkTags, ['<think>', '</think>']);
			assert.strictEqual(caps.supportsSystemMessage, false);
		});

		test('accounts/fireworks/models/qwen3-235b-a22b has toggleable reasoning (canTurnOffReasoning: true)', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/qwen3-235b-a22b', undefined);
			assert.ok(caps.reasoningCapabilities !== false, 'Expected reasoningCapabilities to be set');
			if (caps.reasoningCapabilities === false) return;
			assert.strictEqual(caps.reasoningCapabilities.supportsReasoning, true);
			assert.strictEqual(caps.reasoningCapabilities.canTurnOffReasoning, true);
			assert.strictEqual(caps.reasoningCapabilities.canIOReasoning, true);
			assert.deepStrictEqual(caps.reasoningCapabilities.openSourceThinkTags, ['<think>', '</think>']);
		});

		test('accounts/fireworks/models/qwen3-32b has toggleable reasoning (canTurnOffReasoning: true)', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/qwen3-32b', undefined);
			assert.ok(caps.reasoningCapabilities !== false, 'Expected reasoningCapabilities to be set');
			if (caps.reasoningCapabilities === false) return;
			assert.strictEqual(caps.reasoningCapabilities.supportsReasoning, true);
			assert.strictEqual(caps.reasoningCapabilities.canTurnOffReasoning, true);
		});

		test('accounts/fireworks/models/gemma-4-31b-it has no reasoning capabilities', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/gemma-4-31b-it', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});

		test('accounts/fireworks/models/gpt-oss-120b has no reasoning capabilities', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/gpt-oss-120b', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});

		test('accounts/fireworks/models/gpt-oss-20b has no reasoning capabilities', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/gpt-oss-20b', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});
	});

	// -----------------------------------------------------------------------
	// 6. Model Capabilities — tool format
	// -----------------------------------------------------------------------
	suite('Model Capabilities — tool format', () => {

		test('all default models use openai-style tool format', () => {
			for (const modelName of defaultModelsOfProvider.fireworksAI) {
				const caps = getModelCapabilities('fireworksAI', modelName, undefined);
				assert.strictEqual(
					caps.specialToolFormat,
					'openai-style',
					`Expected openai-style for "${modelName}", got "${caps.specialToolFormat}"`
				);
			}
		});
	});

	// -----------------------------------------------------------------------
	// 7. Model Capabilities — unknown/fallback model
	// -----------------------------------------------------------------------
	suite('Model Capabilities — unknown model fallback', () => {

		test('unknown model returns isUnrecognizedModel: true', () => {
			const caps = getModelCapabilities('fireworksAI', 'accounts/fireworks/models/totally-unknown-model-xyz', undefined);
			assert.strictEqual(caps.isUnrecognizedModel, true);
		});

		test('anthropic-named unknown model uses openai-style (not anthropic-style) due to override', () => {
			const caps = getModelCapabilities('fireworksAI', 'claude-3-sonnet', undefined);
			assert.notStrictEqual(
				caps.specialToolFormat,
				'anthropic-style',
				'fireworksAI modelOptionsFallback must override anthropic-style to openai-style'
			);
		});

		test('gemini-named unknown model uses openai-style (not gemini-style) due to override', () => {
			const caps = getModelCapabilities('fireworksAI', 'gemini-2.0-flash', undefined);
			assert.notStrictEqual(
				caps.specialToolFormat,
				'gemini-style',
				'fireworksAI modelOptionsFallback must override gemini-style to openai-style'
			);
		});
	});

	// -----------------------------------------------------------------------
	// 8. Reasoning I/O settings — provider level
	// -----------------------------------------------------------------------
	suite('Reasoning I/O settings', () => {

		test('providerReasoningIOSettings.output.needsManualParse is true', () => {
			const io = fireworksReasoningIO();
			assert.strictEqual(io?.output?.needsManualParse, true);
		});

		test('providerReasoningIOSettings.input.includeInPayload is defined', () => {
			const io = fireworksReasoningIO();
			assert.ok(io?.input?.includeInPayload, 'Expected includeInPayload to be a function');
		});

		test('includeInPayload returns { reasoning_effort: "low" } for effort_slider state with "low"', () => {
			const fn = fireworksReasoningIO()?.input?.includeInPayload;
			assert.ok(fn, 'includeInPayload function must be defined');
			const result = fn(effortSliderState('low'));
			assert.deepStrictEqual(result, { reasoning_effort: 'low' });
		});

		test('includeInPayload returns { reasoning_effort: "high" } for effort_slider state with "high"', () => {
			const fn = fireworksReasoningIO()?.input?.includeInPayload;
			assert.ok(fn);
			const result = fn(effortSliderState('high'));
			assert.deepStrictEqual(result, { reasoning_effort: 'high' });
		});

		test('includeInPayload returns null when reasoning is disabled (reasoningInfo is null)', () => {
			const fn = fireworksReasoningIO()?.input?.includeInPayload;
			assert.ok(fn);
			const result = fn(null);
			assert.strictEqual(result, null);
		});

		test('includeInPayload returns null for budget_slider state (not supported by openAICompat)', () => {
			const fn = fireworksReasoningIO()?.input?.includeInPayload;
			assert.ok(fn);
			const budgetState = {
				type: 'budget_slider_value' as const,
				isReasoningEnabled: true as const,
				reasoningBudget: 8000,
			};
			const result = fn(budgetState);
			assert.strictEqual(result, null);
		});
	});

	// -----------------------------------------------------------------------
	// 9. SDK Configuration — static contract tests
	// -----------------------------------------------------------------------
	suite('SDK Configuration — baseURL and apiKey contract', () => {

		test('Fireworks AI API base URL is https://api.fireworks.ai/inference/v1', () => {
			const FIREWORKS_BASE_URL = 'https://api.fireworks.ai/inference/v1';
			assert.strictEqual(FIREWORKS_BASE_URL, 'https://api.fireworks.ai/inference/v1');
		});

		test('defaultProviderSettings.fireworksAI.apiKey defaults to empty string (no key pre-set)', () => {
			assert.strictEqual(defaultProviderSettings.fireworksAI.apiKey, '');
		});

		test('fireworksAI settings only have apiKey (no endpoint override possible)', () => {
			const keys = Object.keys(defaultProviderSettings.fireworksAI);
			assert.ok(!keys.includes('endpoint'), 'fireworksAI must not have an endpoint setting');
			assert.ok(keys.includes('apiKey'), 'fireworksAI must have apiKey');
		});
	});

	// -----------------------------------------------------------------------
	// 10. getSendableReasoningInfo integration
	// -----------------------------------------------------------------------
	suite('getSendableReasoningInfo — reasoning end-to-end', () => {

		test('llama-v3p3-70b-instruct (non-reasoning) getSendableReasoningInfo returns null', () => {
			const result = getSendableReasoningInfo(
				'Chat',
				'fireworksAI',
				'accounts/fireworks/models/llama-v3p3-70b-instruct',
				{ reasoningEnabled: true },
				undefined
			);
			assert.strictEqual(result, null);
		});

		test('deepseek-r1 (think-tag, no effort slider) getSendableReasoningInfo returns null', () => {
			// deepseek-r1 has openSourceThinkTags but no effort/budget slider — no payload needed
			const result = getSendableReasoningInfo(
				'Chat',
				'fireworksAI',
				'accounts/fireworks/models/deepseek-r1',
				{ reasoningEnabled: true },
				undefined
			);
			assert.strictEqual(result, null);
		});

		test('qwen3-235b-a22b with reasoning disabled returns null', () => {
			const result = getSendableReasoningInfo(
				'Chat',
				'fireworksAI',
				'accounts/fireworks/models/qwen3-235b-a22b',
				{ reasoningEnabled: false },
				undefined
			);
			assert.strictEqual(result, null);
		});

		test('gemma-4-31b-it (non-reasoning) getSendableReasoningInfo returns null', () => {
			const result = getSendableReasoningInfo(
				'Chat',
				'fireworksAI',
				'accounts/fireworks/models/gemma-4-31b-it',
				{ reasoningEnabled: true },
				undefined
			);
			assert.strictEqual(result, null);
		});
	});
});

// ---------------------------------------------------------------------------
// Manual / E2E verification checklist (informational — not automated)
// ---------------------------------------------------------------------------
//
// The following scenarios require a live Fireworks AI API key and cannot be
// fully automated in unit tests. They are documented here as a reference
// for manual QA:
//
//  1. SETTINGS UI
//     - Open Settings panel → provider list should include "Fireworks AI"
//     - The API key field should show placeholder "fw_..."
//     - The description should mention fireworks.ai/account/api-keys
//
//  2. API KEY ACTIVATION
//     - Enter a valid Fireworks AI API key (fw_...)
//     - All 7 default models should appear in the model selector
//     - _didFillInProviderSettings should become true
//
//  3. CHAT REQUEST ROUTING
//     - Select "accounts/fireworks/models/llama-v3p3-70b-instruct" and send a message
//     - Network request should go to https://api.fireworks.ai/inference/v1/chat/completions
//     - Authorization header should be "Bearer <your-key>"
//     - The full model path (accounts/fireworks/models/...) must be sent as-is
//
//  4. REASONING MODEL (deepseek-r1)
//     - Select "accounts/fireworks/models/deepseek-r1" and send a message
//     - <think>...</think> tags should be parsed and displayed as reasoning
//     - System message should NOT be included in the request (supportsSystemMessage: false)
//
//  5. TOGGLEABLE REASONING (qwen3-235b-a22b)
//     - User can enable/disable reasoning from the UI
//     - When enabled: <think> tags appear in output
//     - When disabled: no think tags
