/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import type { ProviderName } from '../voidSettingsTypes.js';

/**
 * Providers whose models ALWAYS need the enhanced agentic harness prompt.
 * Any model served through these providers triggers enhancement.
 */
const OSS_PROVIDERS: ReadonlySet<ProviderName> = new Set([
	'ollama',
	'vLLM',
	'lmStudio',
	'openAICompatible',
	'liteLLM',
	'omni',
]);

/**
 * Model name patterns that are known-strong and NEVER need enhancement,
 * regardless of provider. These models are natively tool-call capable.
 */
const STRONG_MODEL_PATTERNS: readonly RegExp[] = [
	// Anthropic
	/claude/i,
	// OpenAI
	/gpt-[45]/i,
	/gpt-oss/i,
	/o[134]-/i,
	/chatgpt-4o/i,
	// Google
	/gemini-2\.5-pro/i,
	/gemini-[23]\.\d+-pro/i,
	/gemini-2\.5-flash/i,
	// xAI
	/grok-[34]/i,
	// Moonshot
	/kimi-k2/i,
	// Cohere (strong tool use)
	/command-r-plus/i,
	/command-a/i,
];

/**
 * Model name patterns that indicate a weak/OSS model,
 * triggering enhancement even on non-OSS providers (e.g., Bedrock, OpenRouter).
 * Patterns are ordered by prevalence.
 */
const WEAK_MODEL_PATTERNS: readonly RegExp[] = [
	// Meta Llama family
	/llama/i,
	// Alibaba Qwen (exclude Qwen-Max which is strong)
	/qwen(?!.*max)/i,
	// Mistral (exclude Mistral Large 3+ which is strong)
	/mistral(?!.*large-[3-9])/i,
	// DeepSeek (V2/V3/chat are weak at tool calling)
	/deepseek-v/i,
	/deepseek-chat/i,
	/deepseek-coder/i,
	/deepseek-r1/i,
	// Microsoft Phi
	/phi[- ]?[234]/i,
	// Google Gemma (open-weight, weak at tools)
	/gemma/i,
	// StarCoder / CodeStral / DevStral
	/starcoder/i,
	/codestral/i,
	/devstral/i,
	// Mistral small models
	/ministral/i,
	/pixtral/i,
	// Amazon Nova (lite/micro tiers)
	/nova-lite/i,
	/nova-micro/i,
	// Open-source coding models
	/openhands/i,
	/codellama/i,
	/code-llama/i,
	/wizardcoder/i,
	/phind/i,
	/magicoder/i,
	// Yi family
	/^yi-/i,
	/yi-coder/i,
	// InternLM
	/internlm/i,
	// Cohere (basic models)
	/command-r(?!-plus)/i,
	// Nous Research
	/nous-/i,
	/hermes/i,
	// Mixtral (MoE, still weak at structured tool calling)
	/mixtral/i,
	// Solar
	/solar/i,
	// OpenChat / Openchat
	/openchat/i,
	// Falcon
	/falcon/i,
	// Vicuna
	/vicuna/i,
	// Zephyr
	/zephyr/i,
	// Neural Chat (Intel)
	/neural-chat/i,
	// Granite (IBM)
	/granite/i,
	// Jamba (AI21)
	/jamba/i,
	// DBRX (Databricks)
	/dbrx/i,
	// Arctic (Snowflake)
	/arctic/i,
	// Aya (Cohere multilingual)
	/^aya-/i,
	// OLMo (Allen AI)
	/olmo/i,
];

/**
 * Returns true if the given provider+model combination needs
 * the OSS enhancement system activated.
 *
 * Two paths to trigger:
 * 1. Provider is in OSS_PROVIDERS set (ollama, vLLM, etc.) AND model is not strong
 * 2. Model name matches WEAK_MODEL_PATTERNS AND model is not strong
 *    (catches weak models on Bedrock, OpenRouter, Together, Groq, Fireworks, etc.)
 */
export function needsOSSEnhancement(providerName: ProviderName, modelName: string): boolean {
	if (!modelName) return false;

	// Strong models NEVER need enhancement regardless of provider
	for (const pattern of STRONG_MODEL_PATTERNS) {
		if (pattern.test(modelName)) {
			return false;
		}
	}

	// Path 1: known OSS provider (all models served here are assumed weak)
	if (OSS_PROVIDERS.has(providerName)) {
		return true;
	}

	// Path 2: weak model on any provider (Bedrock, OpenRouter, Groq, etc.)
	for (const pattern of WEAK_MODEL_PATTERNS) {
		if (pattern.test(modelName)) {
			return true;
		}
	}

	return false;
}
