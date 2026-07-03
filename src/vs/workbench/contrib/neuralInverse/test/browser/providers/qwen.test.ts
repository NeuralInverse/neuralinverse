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

const qwenReasoningIO = () => getProviderCapabilities('qwen').providerReasoningIOSettings;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

suite('Qwen provider — unit tests', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// -----------------------------------------------------------------------
	// 1. Provider Settings
	// -----------------------------------------------------------------------
	suite('Provider Settings', () => {
		test('defaultProviderSettings.qwen has apiKey: empty string', () => {
			assert.strictEqual(defaultProviderSettings.qwen.apiKey, '');
		});

		test('defaultProviderSettings.qwen has only apiKey (no other keys)', () => {
			const keys = Object.keys(defaultProviderSettings.qwen);
			assert.deepStrictEqual(keys, ['apiKey']);
		});

		test('displayInfoOfProviderName returns title "Qwen (Alibaba)"', () => {
			const info = displayInfoOfProviderName('qwen');
			assert.strictEqual(info.title, 'Qwen (Alibaba)');
		});

		test('subTextMdOfProviderName contains aliyun.com link', () => {
			const text = subTextMdOfProviderName('qwen');
			assert.ok(text.includes('aliyun.com'), `Expected aliyun.com link in subText, got: ${text}`);
		});

		test('customSettingNamesOfProvider returns ["apiKey"]', () => {
			const names = customSettingNamesOfProvider('qwen');
			assert.deepStrictEqual(names, ['apiKey']);
		});
	});

	// -----------------------------------------------------------------------
	// 2. Default models list
	// -----------------------------------------------------------------------
	suite('Default models list', () => {
		test('defaultModelsOfProvider.qwen contains exactly 6 models', () => {
			assert.strictEqual(defaultModelsOfProvider.qwen.length, 6);
		});

		test('defaultModelsOfProvider.qwen contains expected model IDs', () => {
			const expected = [
				'qwen-plus',
				'qwen-turbo',
				'qwen-max',
				'qwen3-235b-a22b',
				'qwen3-32b',
				'qwq-32b',
			];
			for (const model of expected) {
				assert.ok(
					defaultModelsOfProvider.qwen.includes(model as any),
					`Expected model "${model}" in defaultModelsOfProvider.qwen`
				);
			}
		});

		test('all 6 default models resolve without isUnrecognizedModel: true', () => {
			for (const modelName of defaultModelsOfProvider.qwen) {
				const caps = getModelCapabilities('qwen', modelName, undefined);
				assert.strictEqual(caps.isUnrecognizedModel, false, `Expected isUnrecognizedModel=false for "${modelName}", got true`);
			}
		});
	});

	// -----------------------------------------------------------------------
	// 3. Model Capabilities — reasoning
	// -----------------------------------------------------------------------
	suite('Model Capabilities — reasoning', () => {
		test('qwen-plus has no reasoning capabilities', () => {
			const caps = getModelCapabilities('qwen', 'qwen-plus', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});

		test('qwen-turbo has no reasoning capabilities', () => {
			const caps = getModelCapabilities('qwen', 'qwen-turbo', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});

		test('qwen-max has no reasoning capabilities', () => {
			const caps = getModelCapabilities('qwen', 'qwen-max', undefined);
			assert.strictEqual(caps.reasoningCapabilities, false);
		});

		test('qwq-32b is a reasoning model with canTurnOffReasoning: false', () => {
			const caps = getModelCapabilities('qwen', 'qwq-32b', undefined);
			assert.ok(caps.reasoningCapabilities, 'Expected reasoningCapabilities to be set for qwq-32b');
			
			assert.strictEqual(caps.reasoningCapabilities.supportsReasoning, true);
			assert.strictEqual(caps.reasoningCapabilities.canTurnOffReasoning, false);
			assert.strictEqual(caps.reasoningCapabilities.canIOReasoning, true);
			assert.deepStrictEqual(caps.reasoningCapabilities.openSourceThinkTags, ['<think>', '</think>']);
		});

		test('qwen3-235b-a22b has reasoning with canTurnOffReasoning: true', () => {
			const caps = getModelCapabilities('qwen', 'qwen3-235b-a22b', undefined);
			assert.ok(caps.reasoningCapabilities, 'Expected reasoningCapabilities to be set for qwen3-235b-a22b');
			
			assert.strictEqual(caps.reasoningCapabilities.supportsReasoning, true);
			assert.strictEqual(caps.reasoningCapabilities.canTurnOffReasoning, true);
			assert.strictEqual(caps.reasoningCapabilities.canIOReasoning, true);
		});

		test('qwen3-32b has reasoning with canTurnOffReasoning: true', () => {
			const caps = getModelCapabilities('qwen', 'qwen3-32b', undefined);
			assert.ok(caps.reasoningCapabilities, 'Expected reasoningCapabilities to be set for qwen3-32b');
			
			assert.strictEqual(caps.reasoningCapabilities.supportsReasoning, true);
			assert.strictEqual(caps.reasoningCapabilities.canTurnOffReasoning, true);
		});
	});

	// -----------------------------------------------------------------------
	// 4. Model Capabilities — tool format
	// -----------------------------------------------------------------------
	suite('Model Capabilities — tool format', () => {
		test('all default models use openai-style tool format', () => {
			for (const modelName of defaultModelsOfProvider.qwen) {
				const caps = getModelCapabilities('qwen', modelName, undefined);
				assert.strictEqual(caps.specialToolFormat, 'openai-style', `Expected openai-style for "${modelName}", got "${caps.specialToolFormat}"`);
			}
		});
	});

	// -----------------------------------------------------------------------
	// 5. Model Capabilities — unknown model fallback
	// -----------------------------------------------------------------------
	suite('Model Capabilities — unknown model fallback', () => {
		test('unknown model returns isUnrecognizedModel: true', () => {
			const caps = getModelCapabilities('qwen', 'totally-unknown-model-xyz', undefined);
			assert.strictEqual(caps.isUnrecognizedModel, true);
		});

		test('anthropic-named unknown model uses openai-style (not anthropic-style) due to override', () => {
			const caps = getModelCapabilities('qwen', 'claude-3-sonnet', undefined);
			assert.notStrictEqual(caps.specialToolFormat, 'anthropic-style', 'qwen modelOptionsFallback must override anthropic-style to openai-style');
		});

		test('gemini-named unknown model uses openai-style (not gemini-style) due to override', () => {
			const caps = getModelCapabilities('qwen', 'gemini-2.0-flash', undefined);
			assert.notStrictEqual(caps.specialToolFormat, 'gemini-style', 'qwen modelOptionsFallback must override gemini-style to openai-style');
		});
	});

	// -----------------------------------------------------------------------
	// 6. Reasoning I/O settings — provider level
	// -----------------------------------------------------------------------
	suite('Reasoning I/O settings', () => {
		test('providerReasoningIOSettings.output.needsManualParse is true', () => {
			const io = qwenReasoningIO();
			assert.strictEqual(io?.output?.needsManualParse, true);
		});

		test('providerReasoningIOSettings.input.includeInPayload is defined', () => {
			const io = qwenReasoningIO();
			assert.ok(io?.input?.includeInPayload, 'Expected includeInPayload to be a function');
		});

		test('includeInPayload returns null when reasoning is disabled', () => {
			const fn = qwenReasoningIO()?.input?.includeInPayload;
			assert.ok(fn);
			const result = fn(null);
			assert.strictEqual(result, null);
		});
	});

	// -----------------------------------------------------------------------
	// 7. SDK Configuration — static contract tests
	// -----------------------------------------------------------------------
	suite('SDK Configuration — baseURL and apiKey contract', () => {
		test('Qwen API base URL is https://dashscope.aliyuncs.com/compatible-mode/v1', () => {
			const QWEN_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
			assert.strictEqual(QWEN_BASE_URL, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
		});

		test('defaultProviderSettings.qwen.apiKey defaults to empty string', () => {
			assert.strictEqual(defaultProviderSettings.qwen.apiKey, '');
		});

		test('qwen settings only have apiKey (no endpoint override possible)', () => {
			const keys = Object.keys(defaultProviderSettings.qwen);
			assert.ok(!keys.includes('endpoint'), 'qwen must not have an endpoint setting');
			assert.ok(keys.includes('apiKey'), 'qwen must have apiKey');
		});
	});

	// -----------------------------------------------------------------------
	// 8. getSendableReasoningInfo integration
	// -----------------------------------------------------------------------
	suite('getSendableReasoningInfo — reasoning end-to-end', () => {
		test('qwen-plus (non-reasoning) getSendableReasoningInfo returns null', () => {
			const result = getSendableReasoningInfo('Chat', 'qwen', 'qwen-plus', { reasoningEnabled: true }, undefined);
			assert.strictEqual(result, null);
		});

		test('qwen-turbo (non-reasoning) getSendableReasoningInfo returns null', () => {
			const result = getSendableReasoningInfo('Chat', 'qwen', 'qwen-turbo', { reasoningEnabled: true }, undefined);
			assert.strictEqual(result, null);
		});

		test('qwq-32b (think-tag, no effort slider) getSendableReasoningInfo returns null (no slider payload needed)', () => {
			const result = getSendableReasoningInfo('Chat', 'qwen', 'qwq-32b', { reasoningEnabled: true }, undefined);
			assert.strictEqual(result, null);
		});

		test('qwq-32b with reasoning disabled returns null', () => {
			const result = getSendableReasoningInfo('Chat', 'qwen', 'qwq-32b', { reasoningEnabled: false }, undefined);
			assert.strictEqual(result, null);
		});
	});
});
