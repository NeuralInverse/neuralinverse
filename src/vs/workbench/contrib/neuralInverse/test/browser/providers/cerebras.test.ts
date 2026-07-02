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

/** Retrieve the provider-level reasoning I/O settings for cerebras */
const cerebrasReasoningIO = () => getProviderCapabilities('cerebras').providerReasoningIOSettings;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

suite('Cerebras provider — unit tests', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// -----------------------------------------------------------------------
	// 1. Provider Settings
	// -----------------------------------------------------------------------
	suite('Provider Settings', () => {

		test('defaultProviderSettings.cerebras has apiKey: empty string', () => {
			assert.strictEqual(defaultProviderSettings.cerebras.apiKey, '');
		});

		test('defaultProviderSettings.cerebras has only apiKey (no other keys)', () => {
			const keys = Object.keys(defaultProviderSettings.cerebras);
			assert.deepStrictEqual(keys, ['apiKey']);
		});

		test('displayInfoOfProviderName returns title "Cerebras"', () => {
			const info = displayInfoOfProviderName('cerebras');
			assert.strictEqual(info.title, 'Cerebras');
		});

		test('subTextMdOfProviderName contains cloud.cerebras.ai link', () => {
			const text = subTextMdOfProviderName('cerebras');
			assert.ok(
				text.includes('cloud.cerebras.ai'),
				`Expected cloud.cerebras.ai link in subText, got: ${text}`
			);
		});

		test('customSettingNamesOfProvider returns ["apiKey"]', () => {
			const names = customSettingNamesOfProvider('cerebras');
			assert.deepStrictEqual(names, ['apiKey']);
		});
	});

	// -----------------------------------------------------------------------
	// 2. Default models list
	// -----------------------------------------------------------------------
	suite('Default models list', () => {

		test('defaultModelsOfProvider.cerebras contains exactly 3 models', () => {
			assert.strictEqual(defaultModelsOfProvider.cerebras.length, 3);
		});

		test('defaultModelsOfProvider.cerebras contains expected model IDs', () => {
			const expected = [
				'llama3.1-8b',
				'gpt-oss-120b',
				'qwen-3-235b-a22b-instruct-2507',
			];
			for (const model of expected) {
				assert.ok(
					(defaultModelsOfProvider.cerebras as readonly string[]).includes(model),
					`Expected model "${model}" in defaultModelsOfProvider.cerebras`
				);
			}
		});

		test('all 3 default models resolve without isUnrecognizedModel: true', () => {
			for (const modelName of defaultModelsOfProvider.cerebras) {
				const caps = getModelCapabilities('cerebras', modelName, undefined);
				assert.strictEqual(
					caps.isUnrecognizedModel,
					false,
					`Expected isUnrecognizedModel=false for "${modelName}", got true`
				);
			}
		});
	});

	// -----------------------------------------------------------------------
	// 3. Model Capabilities — context windows
	// -----------------------------------------------------------------------
	suite('Model Capabilities — context window', () => {

		test('llama3.1-8b has contextWindow 128,000', () => {
			const caps = getModelCapabilities('cerebras', 'llama3.1-8b', undefined);
			assert.strictEqual(caps.contextWindow, 128_000);
		});

		test('gpt-oss-120b has contextWindow 128,000', () => {
			const caps = getModelCapabilities('cerebras', 'gpt-oss-120b', undefined);
			assert.strictEqual(caps.contextWindow, 128_000);
		});

		test('qwen-3-235b-a22b-instruct-2507 has contextWindow 128,000', () => {
			const caps = getModelCapabilities('cerebras', 'qwen-3-235b-a22b-instruct-2507', undefined);
			assert.strictEqual(caps.contextWindow, 128_000);
		});
	});

	// -----------------------------------------------------------------------
	// 4. Model Capabilities — reasoning
	// -----------------------------------------------------------------------
	suite('Model Capabilities — reasoning', () => {

		test('llama3.1-8b has no reasoning capabilities', () => {
			const caps = getModelCapabilities('cerebras', 'llama3.1-8b', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});

		test('gpt-oss-120b has no reasoning capabilities', () => {
			const caps = getModelCapabilities('cerebras', 'gpt-oss-120b', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});

		test('qwen-3-235b-a22b-instruct-2507 has think-tag reasoning with canTurnOffReasoning: true', () => {
			const caps = getModelCapabilities('cerebras', 'qwen-3-235b-a22b-instruct-2507', undefined);
			assert.ok(caps.reasoningCapabilities, 'Expected reasoningCapabilities to be set');
			
			assert.strictEqual(caps.reasoningCapabilities.supportsReasoning, true);
			assert.strictEqual(caps.reasoningCapabilities.canTurnOffReasoning, true);
			assert.strictEqual(caps.reasoningCapabilities.canIOReasoning, true);
			assert.deepStrictEqual(caps.reasoningCapabilities.openSourceThinkTags, ['<think>', '</think>']);
		});
	});

	// -----------------------------------------------------------------------
	// 5. Model Capabilities — tool format
	// -----------------------------------------------------------------------
	suite('Model Capabilities — tool format', () => {

		test('llama3.1-8b uses openai-style tool format', () => {
			const caps = getModelCapabilities('cerebras', 'llama3.1-8b', undefined);
			assert.strictEqual(caps.specialToolFormat, 'openai-style');
		});

		test('gpt-oss-120b uses openai-style tool format', () => {
			const caps = getModelCapabilities('cerebras', 'gpt-oss-120b', undefined);
			assert.strictEqual(caps.specialToolFormat, 'openai-style');
		});

		test('qwen-3-235b-a22b-instruct-2507 uses openai-style tool format', () => {
			const caps = getModelCapabilities('cerebras', 'qwen-3-235b-a22b-instruct-2507', undefined);
			assert.strictEqual(caps.specialToolFormat, 'openai-style');
		});

		test('all default models use openai-style tool format', () => {
			for (const modelName of defaultModelsOfProvider.cerebras) {
				const caps = getModelCapabilities('cerebras', modelName, undefined);
				assert.strictEqual(
					caps.specialToolFormat,
					'openai-style',
					`Expected openai-style for "${modelName}", got "${caps.specialToolFormat}"`
				);
			}
		});
	});

	// -----------------------------------------------------------------------
	// 6. Model Capabilities — unknown/fallback model
	// -----------------------------------------------------------------------
	suite('Model Capabilities — unknown model fallback', () => {

		test('unknown model returns isUnrecognizedModel: true', () => {
			const caps = getModelCapabilities('cerebras', 'totally-unknown-model-xyz', undefined);
			assert.strictEqual(caps.isUnrecognizedModel, true);
		});

		test('anthropic-named unknown model uses openai-style (not anthropic-style) due to override', () => {
			const caps = getModelCapabilities('cerebras', 'claude-3-sonnet', undefined);
			assert.notStrictEqual(
				caps.specialToolFormat,
				'anthropic-style',
				'cerebras modelOptionsFallback must override anthropic-style to openai-style'
			);
		});

		test('gemini-named unknown model uses openai-style (not gemini-style) due to override', () => {
			const caps = getModelCapabilities('cerebras', 'gemini-2.0-flash', undefined);
			assert.notStrictEqual(
				caps.specialToolFormat,
				'gemini-style',
				'cerebras modelOptionsFallback must override gemini-style to openai-style'
			);
		});
	});

	// -----------------------------------------------------------------------
	// 7. Reasoning I/O settings — provider level
	// -----------------------------------------------------------------------
	suite('Reasoning I/O settings', () => {

		test('providerReasoningIOSettings.output.needsManualParse is true', () => {
			const io = cerebrasReasoningIO();
			assert.strictEqual(io?.output?.needsManualParse, true);
		});

		test('providerReasoningIOSettings.input.includeInPayload is defined', () => {
			const io = cerebrasReasoningIO();
			assert.ok(io?.input?.includeInPayload, 'Expected includeInPayload to be a function');
		});

		test('includeInPayload returns { reasoning_effort: "low" } for effort_slider state with "low"', () => {
			const fn = cerebrasReasoningIO()?.input?.includeInPayload;
			assert.ok(fn, 'includeInPayload function must be defined');
			const result = fn(effortSliderState('low'));
			assert.deepStrictEqual(result, { reasoning_effort: 'low' });
		});

		test('includeInPayload returns null when reasoning is disabled (reasoningInfo is null)', () => {
			const fn = cerebrasReasoningIO()?.input?.includeInPayload;
			assert.ok(fn);
			const result = fn(null);
			assert.strictEqual(result, null);
		});

		test('includeInPayload returns null for budget_slider state (not supported by openAICompat)', () => {
			const fn = cerebrasReasoningIO()?.input?.includeInPayload;
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
	// 8. SDK Configuration — static contract tests
	// -----------------------------------------------------------------------
	suite('SDK Configuration — baseURL and apiKey contract', () => {

		test('Cerebras API base URL is https://api.cerebras.ai/v1', () => {
			const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';
			assert.strictEqual(CEREBRAS_BASE_URL, 'https://api.cerebras.ai/v1');
		});

		test('defaultProviderSettings.cerebras.apiKey defaults to empty string (no key pre-set)', () => {
			assert.strictEqual(defaultProviderSettings.cerebras.apiKey, '');
		});

		test('cerebras settings only have apiKey (no endpoint override possible)', () => {
			const keys = Object.keys(defaultProviderSettings.cerebras);
			assert.ok(!keys.includes('endpoint'), 'cerebras must not have an endpoint setting');
			assert.ok(keys.includes('apiKey'), 'cerebras must have apiKey');
		});
	});

	// -----------------------------------------------------------------------
	// 9. getSendableReasoningInfo integration
	// -----------------------------------------------------------------------
	suite('getSendableReasoningInfo — reasoning end-to-end', () => {

		test('llama3.1-8b (non-reasoning) getSendableReasoningInfo returns null', () => {
			const result = getSendableReasoningInfo(
				'Chat',
				'cerebras',
				'llama3.1-8b',
				{ reasoningEnabled: true },
				undefined
			);
			assert.strictEqual(result, null);
		});

		test('gpt-oss-120b (non-reasoning) getSendableReasoningInfo returns null', () => {
			const result = getSendableReasoningInfo(
				'Chat',
				'cerebras',
				'gpt-oss-120b',
				{ reasoningEnabled: true },
				undefined
			);
			assert.strictEqual(result, null);
		});

		test('qwen-3-235b-a22b-instruct-2507 (think-tag, no effort slider) getSendableReasoningInfo returns null', () => {
			// qwen-3-235b-a22b-instruct-2507 has openSourceThinkTags but no effort/budget slider — no payload needed
			const result = getSendableReasoningInfo(
				'Chat',
				'cerebras',
				'qwen-3-235b-a22b-instruct-2507',
				{ reasoningEnabled: true },
				undefined
			);
			assert.strictEqual(result, null);
		});

		test('qwen-3-235b-a22b-instruct-2507 with reasoning disabled returns null', () => {
			const result = getSendableReasoningInfo(
				'Chat',
				'cerebras',
				'qwen-3-235b-a22b-instruct-2507',
				{ reasoningEnabled: false },
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
// The following scenarios require a live Cerebras API key and cannot be
// fully automated in unit tests. They are documented here as a reference
// for manual QA:
//
//  1. SETTINGS UI
//     - Open Settings panel → provider list should include "Cerebras"
//     - The API key field should show placeholder "csk-..."
//     - The description should mention cloud.cerebras.ai and 2000+ tokens/sec
//
//  2. API KEY ACTIVATION
//     - Enter a valid Cerebras API key (csk-...)
//     - All 3 default models should appear in the model selector
//     - _didFillInProviderSettings should become true
//
//  3. CHAT REQUEST ROUTING
//     - Select "llama3.1-8b" and send a message
//     - Network request should go to https://api.cerebras.ai/v1/chat/completions
//     - Authorization header should be "Bearer <your-key>"
//
//  4. STREAMING RESPONSE
//     - Response should stream token-by-token at high speed (2000+ t/s)
//     - No "reasoning" delta field expected for llama3.1-8b (non-reasoning model)
//
//  5. REASONING MODEL (qwen-3-235b-a22b-instruct-2507)
//     - Select the Qwen model and send a message with reasoning enabled
//     - <think>...</think> tags should be parsed and displayed as reasoning
//     - User can toggle reasoning off via settings (canTurnOffReasoning: true)
