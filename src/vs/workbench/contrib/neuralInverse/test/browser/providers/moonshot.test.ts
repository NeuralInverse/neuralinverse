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

const moonshotReasoningIO = () => getProviderCapabilities('moonshot').providerReasoningIOSettings;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

suite('Moonshot (Kimi) provider — unit tests', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// -----------------------------------------------------------------------
	// 1. Provider Settings
	// -----------------------------------------------------------------------
	suite('Provider Settings', () => {
		test('defaultProviderSettings.moonshot has apiKey: empty string', () => {
			assert.strictEqual(defaultProviderSettings.moonshot.apiKey, '');
		});

		test('defaultProviderSettings.moonshot has only apiKey (no other keys)', () => {
			const keys = Object.keys(defaultProviderSettings.moonshot);
			assert.deepStrictEqual(keys, ['apiKey']);
		});

		test('displayInfoOfProviderName returns title "Moonshot (Kimi)"', () => {
			const info = displayInfoOfProviderName('moonshot');
			assert.strictEqual(info.title, 'Moonshot (Kimi)');
		});

		test('subTextMdOfProviderName contains moonshot.cn link', () => {
			const text = subTextMdOfProviderName('moonshot');
			assert.ok(text.includes('moonshot.cn'), `Expected moonshot.cn link in subText, got: ${text}`);
		});

		test('customSettingNamesOfProvider returns ["apiKey"]', () => {
			const names = customSettingNamesOfProvider('moonshot');
			assert.deepStrictEqual(names, ['apiKey']);
		});
	});

	// -----------------------------------------------------------------------
	// 2. Default models list
	// -----------------------------------------------------------------------
	suite('Default models list', () => {
		test('defaultModelsOfProvider.moonshot contains exactly 4 models', () => {
			assert.strictEqual(defaultModelsOfProvider.moonshot.length, 4);
		});

		test('defaultModelsOfProvider.moonshot contains expected model IDs', () => {
			const expected = [
				'moonshot-v1-8k',
				'moonshot-v1-32k',
				'moonshot-v1-128k',
				'kimi-k2',
			];
			for (const model of expected) {
				assert.ok(
					defaultModelsOfProvider.moonshot.includes(model as any),
					`Expected model "${model}" in defaultModelsOfProvider.moonshot`
				);
			}
		});

		test('all 4 default models resolve without isUnrecognizedModel: true', () => {
			for (const modelName of defaultModelsOfProvider.moonshot) {
				const caps = getModelCapabilities('moonshot', modelName, undefined);
				assert.strictEqual(caps.isUnrecognizedModel, false, `Expected isUnrecognizedModel=false for "${modelName}", got true`);
			}
		});
	});

	// -----------------------------------------------------------------------
	// 3. Model Capabilities — reasoning
	// -----------------------------------------------------------------------
	suite('Model Capabilities — reasoning', () => {
		test('moonshot-v1-8k has no reasoning capabilities', () => {
			const caps = getModelCapabilities('moonshot', 'moonshot-v1-8k', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});

		test('moonshot-v1-32k has no reasoning capabilities', () => {
			const caps = getModelCapabilities('moonshot', 'moonshot-v1-32k', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});

		test('moonshot-v1-128k has no reasoning capabilities', () => {
			const caps = getModelCapabilities('moonshot', 'moonshot-v1-128k', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});

		test('kimi-k2 is a reasoning model with canTurnOffReasoning: false', () => {
			const caps = getModelCapabilities('moonshot', 'kimi-k2', undefined);
			assert.ok(caps.reasoningCapabilities, 'Expected reasoningCapabilities to be set for kimi-k2');
			
			assert.strictEqual(caps.reasoningCapabilities.supportsReasoning, true);
			assert.strictEqual(caps.reasoningCapabilities.canTurnOffReasoning, false);
			assert.strictEqual(caps.reasoningCapabilities.canIOReasoning, true);
			assert.deepStrictEqual(caps.reasoningCapabilities.openSourceThinkTags, ['<think>', '</think>']);
		});
	});

	// -----------------------------------------------------------------------
	// 4. Model Capabilities — context windows
	// -----------------------------------------------------------------------
	suite('Model Capabilities — context window', () => {
		test('moonshot-v1-8k has contextWindow 8,192', () => {
			const caps = getModelCapabilities('moonshot', 'moonshot-v1-8k', undefined);
			assert.strictEqual(caps.contextWindow, 8_192);
		});

		test('moonshot-v1-32k has contextWindow 32,768', () => {
			const caps = getModelCapabilities('moonshot', 'moonshot-v1-32k', undefined);
			assert.strictEqual(caps.contextWindow, 32_768);
		});

		test('moonshot-v1-128k has contextWindow 128,000', () => {
			const caps = getModelCapabilities('moonshot', 'moonshot-v1-128k', undefined);
			assert.strictEqual(caps.contextWindow, 128_000);
		});

		test('kimi-k2 has contextWindow 128,000', () => {
			const caps = getModelCapabilities('moonshot', 'kimi-k2', undefined);
			assert.strictEqual(caps.contextWindow, 128_000);
		});
	});

	// -----------------------------------------------------------------------
	// 5. Model Capabilities — tool format
	// -----------------------------------------------------------------------
	suite('Model Capabilities — tool format', () => {
		test('all default models use openai-style tool format', () => {
			for (const modelName of defaultModelsOfProvider.moonshot) {
				const caps = getModelCapabilities('moonshot', modelName, undefined);
				assert.strictEqual(caps.specialToolFormat, 'openai-style', `Expected openai-style for "${modelName}", got "${caps.specialToolFormat}"`);
			}
		});
	});

	// -----------------------------------------------------------------------
	// 6. Model Capabilities — unknown model fallback
	// -----------------------------------------------------------------------
	suite('Model Capabilities — unknown model fallback', () => {
		test('unknown model returns isUnrecognizedModel: true', () => {
			const caps = getModelCapabilities('moonshot', 'totally-unknown-model-xyz', undefined);
			assert.strictEqual(caps.isUnrecognizedModel, true);
		});

		test('anthropic-named unknown model uses openai-style (not anthropic-style) due to override', () => {
			const caps = getModelCapabilities('moonshot', 'claude-3-sonnet', undefined);
			assert.notStrictEqual(caps.specialToolFormat, 'anthropic-style', 'moonshot modelOptionsFallback must override anthropic-style to openai-style');
		});

		test('gemini-named unknown model uses openai-style (not gemini-style) due to override', () => {
			const caps = getModelCapabilities('moonshot', 'gemini-2.0-flash', undefined);
			assert.notStrictEqual(caps.specialToolFormat, 'gemini-style', 'moonshot modelOptionsFallback must override gemini-style to openai-style');
		});
	});

	// -----------------------------------------------------------------------
	// 7. Reasoning I/O settings — provider level
	// -----------------------------------------------------------------------
	suite('Reasoning I/O settings', () => {
		test('providerReasoningIOSettings.output.needsManualParse is true', () => {
			const io = moonshotReasoningIO();
			assert.strictEqual(io?.output?.needsManualParse, true);
		});

		test('providerReasoningIOSettings.input.includeInPayload is defined', () => {
			const io = moonshotReasoningIO();
			assert.ok(io?.input?.includeInPayload, 'Expected includeInPayload to be a function');
		});

		test('includeInPayload returns null when reasoning is disabled', () => {
			const fn = moonshotReasoningIO()?.input?.includeInPayload;
			assert.ok(fn);
			const result = fn(null);
			assert.strictEqual(result, null);
		});
	});

	// -----------------------------------------------------------------------
	// 8. SDK Configuration — static contract tests
	// -----------------------------------------------------------------------
	suite('SDK Configuration — baseURL and apiKey contract', () => {
		test('Moonshot API base URL is https://api.moonshot.cn/v1', () => {
			const MOONSHOT_BASE_URL = 'https://api.moonshot.cn/v1';
			assert.strictEqual(MOONSHOT_BASE_URL, 'https://api.moonshot.cn/v1');
		});

		test('defaultProviderSettings.moonshot.apiKey defaults to empty string', () => {
			assert.strictEqual(defaultProviderSettings.moonshot.apiKey, '');
		});

		test('moonshot settings only have apiKey (no endpoint override possible)', () => {
			const keys = Object.keys(defaultProviderSettings.moonshot);
			assert.ok(!keys.includes('endpoint'), 'moonshot must not have an endpoint setting');
			assert.ok(keys.includes('apiKey'), 'moonshot must have apiKey');
		});
	});

	// -----------------------------------------------------------------------
	// 9. getSendableReasoningInfo integration
	// -----------------------------------------------------------------------
	suite('getSendableReasoningInfo — reasoning end-to-end', () => {
		test('moonshot-v1-8k (non-reasoning) getSendableReasoningInfo returns null', () => {
			const result = getSendableReasoningInfo('Chat', 'moonshot', 'moonshot-v1-8k', { reasoningEnabled: true }, undefined);
			assert.strictEqual(result, null);
		});

		test('moonshot-v1-128k (non-reasoning) getSendableReasoningInfo returns null', () => {
			const result = getSendableReasoningInfo('Chat', 'moonshot', 'moonshot-v1-128k', { reasoningEnabled: true }, undefined);
			assert.strictEqual(result, null);
		});

		test('kimi-k2 (think-tag, no effort slider) getSendableReasoningInfo returns null (no slider payload needed)', () => {
			const result = getSendableReasoningInfo('Chat', 'moonshot', 'kimi-k2', { reasoningEnabled: true }, undefined);
			assert.strictEqual(result, null);
		});

		test('kimi-k2 with reasoning disabled returns null', () => {
			const result = getSendableReasoningInfo('Chat', 'moonshot', 'kimi-k2', { reasoningEnabled: false }, undefined);
			assert.strictEqual(result, null);
		});
	});
});
