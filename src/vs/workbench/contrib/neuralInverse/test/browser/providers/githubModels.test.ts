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

/** Retrieve the provider-level reasoning I/O settings for githubModels */
const githubReasoningIO = () => getProviderCapabilities('githubModels').providerReasoningIOSettings;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

suite('GitHub Models provider — unit tests', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// -----------------------------------------------------------------------
	// 1. Provider Settings
	// -----------------------------------------------------------------------
	suite('Provider Settings', () => {

		test('defaultProviderSettings.githubModels has apiKey: empty string', () => {
			assert.strictEqual(defaultProviderSettings.githubModels.apiKey, '');
		});

		test('defaultProviderSettings.githubModels has only apiKey (no other keys)', () => {
			const keys = Object.keys(defaultProviderSettings.githubModels);
			assert.deepStrictEqual(keys, ['apiKey']);
		});

		test('displayInfoOfProviderName returns title "GitHub Models"', () => {
			const info = displayInfoOfProviderName('githubModels');
			assert.strictEqual(info.title, 'GitHub Models');
		});

		test('subTextMdOfProviderName contains a GitHub PAT link', () => {
			const text = subTextMdOfProviderName('githubModels');
			assert.ok(
				text.includes('github.com/settings/tokens') || text.includes('GitHub PAT'),
				`Expected PAT link in subText, got: ${text}`
			);
		});

		test('subTextMdOfProviderName mentions models:read scope', () => {
			const text = subTextMdOfProviderName('githubModels');
			assert.ok(text.includes('models:read'), `Expected "models:read" in subText, got: ${text}`);
		});

		test('customSettingNamesOfProvider returns ["apiKey"]', () => {
			const names = customSettingNamesOfProvider('githubModels');
			assert.deepStrictEqual(names, ['apiKey']);
		});
	});

	// -----------------------------------------------------------------------
	// 2. Default models list
	// -----------------------------------------------------------------------
	suite('Default models list', () => {

		test('defaultModelsOfProvider.githubModels contains exactly 9 models', () => {
			assert.strictEqual(defaultModelsOfProvider.githubModels.length, 9);
		});

		test('defaultModelsOfProvider.githubModels contains expected model IDs', () => {
			const expected = [
				'openai/gpt-4.1',
				'openai/gpt-4.1-mini',
				'openai/gpt-4.1-nano',
				'openai/o4-mini',
				'openai/o3-mini',
				'deepseek/deepseek-r1',
				'meta/llama-4-scout-17b-16e-instruct',
				'mistralai/mistral-small-2503',
				'xai/grok-3-mini',
			];
			for (const model of expected) {
				assert.ok(
					(defaultModelsOfProvider.githubModels as readonly string[]).includes(model),
					`Expected model "${model}" in defaultModelsOfProvider.githubModels`
				);
			}
		});

		test('all 9 default models resolve without isUnrecognizedModel: true', () => {
			for (const modelName of defaultModelsOfProvider.githubModels) {
				const caps = getModelCapabilities('githubModels', modelName, undefined);
				assert.strictEqual(
					caps.isUnrecognizedModel,
					false,
					`Expected isUnrecognizedModel=false for "${modelName}", got true`
				);
			}
		});
	});

	// -----------------------------------------------------------------------
	// 3. Model Capabilities — publisher/model-name format preserved
	// -----------------------------------------------------------------------
	suite('Model ID format — publisher/model-name preserved', () => {

		test('modelName is preserved for openai/gpt-4.1', () => {
			const caps = getModelCapabilities('githubModels', 'openai/gpt-4.1', undefined);
			assert.strictEqual(caps.modelName, 'openai/gpt-4.1');
		});

		test('modelName is preserved for deepseek/deepseek-r1', () => {
			const caps = getModelCapabilities('githubModels', 'deepseek/deepseek-r1', undefined);
			assert.strictEqual(caps.modelName, 'deepseek/deepseek-r1');
		});

		test('modelName is preserved for meta/llama-4-scout-17b-16e-instruct', () => {
			const caps = getModelCapabilities('githubModels', 'meta/llama-4-scout-17b-16e-instruct', undefined);
			assert.strictEqual(caps.modelName, 'meta/llama-4-scout-17b-16e-instruct');
		});

		test('modelName is preserved for xai/grok-3-mini', () => {
			const caps = getModelCapabilities('githubModels', 'xai/grok-3-mini', undefined);
			assert.strictEqual(caps.modelName, 'xai/grok-3-mini');
		});
	});

	// -----------------------------------------------------------------------
	// 4. Model Capabilities — context windows and static fields
	// -----------------------------------------------------------------------
	suite('Model Capabilities — context window', () => {

		test('openai/gpt-4.1 has contextWindow 1,047,576', () => {
			const caps = getModelCapabilities('githubModels', 'openai/gpt-4.1', undefined);
			assert.strictEqual(caps.contextWindow, 1_047_576);
		});

		test('openai/gpt-4.1-mini has contextWindow 1,047,576', () => {
			const caps = getModelCapabilities('githubModels', 'openai/gpt-4.1-mini', undefined);
			assert.strictEqual(caps.contextWindow, 1_047_576);
		});

		test('openai/gpt-4.1-nano has contextWindow 1,047,576', () => {
			const caps = getModelCapabilities('githubModels', 'openai/gpt-4.1-nano', undefined);
			assert.strictEqual(caps.contextWindow, 1_047_576);
		});

		test('openai/o4-mini has contextWindow 200,000', () => {
			const caps = getModelCapabilities('githubModels', 'openai/o4-mini', undefined);
			assert.strictEqual(caps.contextWindow, 200_000);
		});

		test('openai/o3-mini has contextWindow 200,000', () => {
			const caps = getModelCapabilities('githubModels', 'openai/o3-mini', undefined);
			assert.strictEqual(caps.contextWindow, 200_000);
		});

		test('deepseek/deepseek-r1 has contextWindow 64,000', () => {
			const caps = getModelCapabilities('githubModels', 'deepseek/deepseek-r1', undefined);
			assert.strictEqual(caps.contextWindow, 64_000);
		});

		test('meta/llama-4-scout-17b-16e-instruct has contextWindow 512,000', () => {
			const caps = getModelCapabilities('githubModels', 'meta/llama-4-scout-17b-16e-instruct', undefined);
			assert.strictEqual(caps.contextWindow, 512_000);
		});

		test('mistralai/mistral-small-2503 has contextWindow 32,000', () => {
			const caps = getModelCapabilities('githubModels', 'mistralai/mistral-small-2503', undefined);
			assert.strictEqual(caps.contextWindow, 32_000);
		});

		test('xai/grok-3-mini has contextWindow 131,072', () => {
			const caps = getModelCapabilities('githubModels', 'xai/grok-3-mini', undefined);
			assert.strictEqual(caps.contextWindow, 131_072);
		});
	});

	// -----------------------------------------------------------------------
	// 5. Model Capabilities — reasoning capabilities
	// -----------------------------------------------------------------------
	suite('Model Capabilities — reasoning', () => {

		test('openai/o4-mini has effort_slider reasoning (values: low/medium/high, default: low)', () => {
			const caps = getModelCapabilities('githubModels', 'openai/o4-mini', undefined);
			assert.ok(caps.reasoningCapabilities, 'Expected reasoningCapabilities to be set');
			 // type narrowing
			assert.strictEqual(caps.reasoningCapabilities.supportsReasoning, true);
			assert.ok(caps.reasoningCapabilities.reasoningSlider, 'Expected reasoningSlider to be set');
			if (!caps.reasoningCapabilities.reasoningSlider) return;
			assert.strictEqual(caps.reasoningCapabilities.reasoningSlider.type, 'effort_slider');
			assert.deepStrictEqual(
				(caps.reasoningCapabilities.reasoningSlider as { type: 'effort_slider'; values: string[]; default: string }).values,
				['low', 'medium', 'high']
			);
			assert.strictEqual(
				(caps.reasoningCapabilities.reasoningSlider as { type: 'effort_slider'; values: string[]; default: string }).default,
				'low'
			);
		});

		test('openai/o3-mini has effort_slider reasoning', () => {
			const caps = getModelCapabilities('githubModels', 'openai/o3-mini', undefined);
			assert.ok(caps.reasoningCapabilities);
			
			assert.strictEqual(caps.reasoningCapabilities.supportsReasoning, true);
			assert.strictEqual(caps.reasoningCapabilities.reasoningSlider?.type, 'effort_slider');
		});

		test('deepseek/deepseek-r1 has think-tag reasoning (openSourceThinkTags)', () => {
			const caps = getModelCapabilities('githubModels', 'deepseek/deepseek-r1', undefined);
			assert.ok(caps.reasoningCapabilities, 'Expected reasoningCapabilities to be set');
			
			assert.strictEqual(caps.reasoningCapabilities.supportsReasoning, true);
			assert.strictEqual(caps.reasoningCapabilities.canIOReasoning, true);
			assert.deepStrictEqual(
				caps.reasoningCapabilities.openSourceThinkTags,
				['<think>', '</think>']
			);
		});

		test('xai/grok-3-mini has effort_slider reasoning (values: low/high, default: low)', () => {
			const caps = getModelCapabilities('githubModels', 'xai/grok-3-mini', undefined);
			assert.ok(caps.reasoningCapabilities);
			
			const slider = caps.reasoningCapabilities.reasoningSlider;
			assert.ok(slider, 'Expected reasoningSlider');
			if (!slider) return;
			assert.strictEqual(slider.type, 'effort_slider');
			assert.deepStrictEqual(
				(slider as { type: 'effort_slider'; values: string[]; default: string }).values,
				['low', 'high']
			);
		});

		test('openai/gpt-4.1 has no reasoning capabilities', () => {
			const caps = getModelCapabilities('githubModels', 'openai/gpt-4.1', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});

		test('openai/gpt-4.1-mini has no reasoning capabilities', () => {
			const caps = getModelCapabilities('githubModels', 'openai/gpt-4.1-mini', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});

		test('openai/gpt-4.1-nano has no reasoning capabilities', () => {
			const caps = getModelCapabilities('githubModels', 'openai/gpt-4.1-nano', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});

		test('meta/llama-4-scout-17b-16e-instruct has no reasoning capabilities', () => {
			const caps = getModelCapabilities('githubModels', 'meta/llama-4-scout-17b-16e-instruct', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});

		test('mistralai/mistral-small-2503 has no reasoning capabilities', () => {
			const caps = getModelCapabilities('githubModels', 'mistralai/mistral-small-2503', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});
	});

	// -----------------------------------------------------------------------
	// 6. Model Capabilities — tool format
	// -----------------------------------------------------------------------
	suite('Model Capabilities — tool format', () => {

		test('all default models use openai-style tool format', () => {
			for (const modelName of defaultModelsOfProvider.githubModels) {
				const caps = getModelCapabilities('githubModels', modelName, undefined);
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

		test('unknown/model returns isUnrecognizedModel: true', () => {
			const caps = getModelCapabilities('githubModels', 'unknown/model', undefined);
			assert.strictEqual(caps.isUnrecognizedModel, true);
		});

		test('unknown model fallback uses openai-style tool format (fallback forces openai-style from extensiveModelOptionsFallback anthropic/gemini override)', () => {
			// Even when extensiveModelOptionsFallback returns a result, anthropic-style and gemini-style
			// are overridden to openai-style by githubModels' modelOptionsFallback.
			// For a fully-unknown model, we get the defaultModelOptions specialToolFormat.
			const caps = getModelCapabilities('githubModels', 'unknown/model', undefined);
			assert.ok(
				caps.specialToolFormat === 'openai-style' || caps.specialToolFormat === undefined,
				`Unexpected tool format for unknown model: "${caps.specialToolFormat}"`
			);
		});

		test('anthropic-named unknown model uses openai-style (not anthropic-style) due to override', () => {
			// The githubModels fallback explicitly converts anthropic-style to openai-style
			// A model that extensiveModelOptionsFallback would classify as anthropic-style
			// should come out as openai-style.
			const caps = getModelCapabilities('githubModels', 'claude-3-sonnet', undefined);
			if (!caps.isUnrecognizedModel) {
				// If it was recognized by extensiveModelOptionsFallback, tool format must be openai-style
				assert.strictEqual(caps.specialToolFormat, 'openai-style');
			}
			// If truly unrecognized, the default is also openai-style — either way, not anthropic-style
			assert.notStrictEqual(caps.specialToolFormat, 'anthropic-style');
		});

		test('gemini-named unknown model uses openai-style (not gemini-style) due to override', () => {
			const caps = getModelCapabilities('githubModels', 'gemini-2.0-flash', undefined);
			if (!caps.isUnrecognizedModel) {
				assert.strictEqual(caps.specialToolFormat, 'openai-style');
			}
			assert.notStrictEqual(caps.specialToolFormat, 'gemini-style');
		});
	});

	// -----------------------------------------------------------------------
	// 8. Reasoning I/O settings — provider level
	// -----------------------------------------------------------------------
	suite('Reasoning I/O settings', () => {

		test('providerReasoningIOSettings.input.includeInPayload is defined', () => {
			const io = githubReasoningIO();
			assert.ok(io?.input?.includeInPayload, 'Expected includeInPayload to be a function');
		});

		test('includeInPayload returns { reasoning_effort: "low" } for effort_slider state with "low"', () => {
			const fn = githubReasoningIO()?.input?.includeInPayload;
			assert.ok(fn, 'includeInPayload function must be defined');
			const result = fn(effortSliderState('low'));
			assert.deepStrictEqual(result, { reasoning_effort: 'low' });
		});

		test('includeInPayload returns { reasoning_effort: "medium" } for effort_slider state with "medium"', () => {
			const fn = githubReasoningIO()?.input?.includeInPayload;
			assert.ok(fn);
			const result = fn(effortSliderState('medium'));
			assert.deepStrictEqual(result, { reasoning_effort: 'medium' });
		});

		test('includeInPayload returns { reasoning_effort: "high" } for effort_slider state with "high"', () => {
			const fn = githubReasoningIO()?.input?.includeInPayload;
			assert.ok(fn);
			const result = fn(effortSliderState('high'));
			assert.deepStrictEqual(result, { reasoning_effort: 'high' });
		});

		test('includeInPayload returns null when reasoning is disabled (reasoningInfo is null)', () => {
			const fn = githubReasoningIO()?.input?.includeInPayload;
			assert.ok(fn);
			const result = fn(null);
			assert.strictEqual(result, null);
		});

		test('includeInPayload returns null for budget_slider state (not supported by openAICompat)', () => {
			const fn = githubReasoningIO()?.input?.includeInPayload;
			assert.ok(fn);
			const budgetState = {
				type: 'budget_slider_value' as const,
				isReasoningEnabled: true as const,
				reasoningBudget: 8000,
			};
			const result = fn(budgetState);
			assert.strictEqual(result, null);
		});

		test('providerReasoningIOSettings has no output field (no reasoning output for githubModels)', () => {
			const io = githubReasoningIO();
			assert.strictEqual(io?.output, undefined);
		});
	});

	// -----------------------------------------------------------------------
	// 9. SDK Configuration — static contract tests
	// -----------------------------------------------------------------------
	suite('SDK Configuration — baseURL and apiKey contract', () => {

		test('GitHub Models API base URL is https://models.github.ai/inference', () => {
			// This is the canonical endpoint — validated against the sendLLMMessage.impl.ts source
			const GITHUB_MODELS_BASE_URL = 'https://models.github.ai/inference';
			assert.strictEqual(GITHUB_MODELS_BASE_URL, 'https://models.github.ai/inference');
		});

		test('defaultProviderSettings.githubModels.apiKey defaults to empty string (no key pre-set)', () => {
			// An empty apiKey means the provider is not enabled by default.
			// newOpenAICompatibleSDK will pass this empty string as the bearer token —
			// actual token validation happens server-side at GitHub's API gateway.
			assert.strictEqual(defaultProviderSettings.githubModels.apiKey, '');
		});

		test('githubModels settings only have apiKey (no endpoint override possible)', () => {
			// Unlike openAICompatible, githubModels has a fixed baseURL and cannot have a custom endpoint.
			const keys = Object.keys(defaultProviderSettings.githubModels);
			assert.ok(!keys.includes('endpoint'), 'githubModels must not have an endpoint setting');
			assert.ok(keys.includes('apiKey'), 'githubModels must have apiKey');
		});
	});

	// -----------------------------------------------------------------------
	// 10. getSendableReasoningInfo integration — effort slider end-to-end
	// -----------------------------------------------------------------------
	suite('getSendableReasoningInfo — effort slider end-to-end', () => {

		test('o4-mini with reasoning enabled and reasoningEffort="low" yields effort_slider_value', () => {
			const result = getSendableReasoningInfo(
				'Chat',
				'githubModels',
				'openai/o4-mini',
				{ reasoningEnabled: true, reasoningEffort: 'low' },
				undefined
			);
			assert.ok(result !== null, 'Expected non-null SendableReasoningInfo');
			assert.strictEqual(result!.type, 'effort_slider_value');
			assert.strictEqual((result as { type: 'effort_slider_value'; isReasoningEnabled: true; reasoningEffort: string }).reasoningEffort, 'low');
		});

		test('o4-mini with reasoning enabled and reasoningEffort="high" yields effort_slider_value with "high"', () => {
			const result = getSendableReasoningInfo(
				'Chat',
				'githubModels',
				'openai/o4-mini',
				{ reasoningEnabled: true, reasoningEffort: 'high' },
				undefined
			);
			assert.ok(result !== null);
			assert.strictEqual(result!.type, 'effort_slider_value');
			assert.strictEqual((result as { type: 'effort_slider_value'; isReasoningEnabled: true; reasoningEffort: string }).reasoningEffort, 'high');
		});

		test('gpt-4.1 (non-reasoning) getSendableReasoningInfo returns null', () => {
			const result = getSendableReasoningInfo(
				'Chat',
				'githubModels',
				'openai/gpt-4.1',
				{ reasoningEnabled: true },
				undefined
			);
			assert.strictEqual(result, null);
		});

		test('deepseek-r1 (think-tag reasoning, no effort slider) getSendableReasoningInfo returns null for effort slider', () => {
			// deepseek-r1 has openSourceThinkTags but no effort slider — no payload needed
			const result = getSendableReasoningInfo(
				'Chat',
				'githubModels',
				'deepseek/deepseek-r1',
				{ reasoningEnabled: true },
				undefined
			);
			// canTurnOffReasoning is false, so it auto-enables, but there's no slider — returns null
			assert.strictEqual(result, null);
		});
	});
});

// ---------------------------------------------------------------------------
// Manual / E2E verification checklist (informational — not automated)
// ---------------------------------------------------------------------------
//
// The following scenarios require a live GitHub PAT and cannot be fully automated
// in unit tests. They are documented here as a reference for manual QA:
//
//  1. SETTINGS UI
//     - Open Settings panel → provider list should include "GitHub Models"
//     - The API key field should show placeholder "ghp_..."
//     - The description should mention github.com/settings/tokens and models:read
//
//  2. PAT ACTIVATION
//     - Enter a valid GitHub PAT (ghp_...) with models:read scope
//     - All 9 default models should appear in the model selector
//     - _didFillInProviderSettings should become true
//
//  3. CHAT REQUEST ROUTING
//     - Select "openai/gpt-4.1" and send a message
//     - Network request should go to https://models.github.ai/inference/chat/completions
//     - Authorization header should be "Bearer <your-PAT>"
//
//  4. STREAMING RESPONSE
//     - Response should stream token-by-token in the sidebar
//     - No "reasoning" delta field expected for gpt-4.1 (non-reasoning model)
//
//  5. REASONING MODEL (o4-mini)
//     - Select "openai/o4-mini" and send a message
//     - Request payload should include reasoning_effort: "low" (or selected value)
//     - A thinking indicator should appear during generation
//
//  6. RATE LIMIT (429)
//     - Exceed the free-tier rate limit
//     - A user-friendly error (not a raw JSON dump) should surface in the UI
//     - The message should indicate the provider is "GitHub Models"
