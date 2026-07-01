/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ProviderName } from '../../common/voidSettingsTypes.js';

export type CredentialSource = 'env' | 'config-file' | 'cli-auth' | 'git-credential';

export interface IDetectedCredential {
	providerName: ProviderName;
	source: CredentialSource;
	settings: Record<string, string>;
	maskedDisplay: string;
}

export interface IAutoConnectState {
	detectedCredentials: IDetectedCredential[];
	appliedProviders: Set<ProviderName>;
	dismissedProviders: Set<ProviderName>;
	neverAskAgain: boolean;
}

export const ENV_VAR_MAP: { providerName: ProviderName; envVars: string[] }[] = [
	{ providerName: 'anthropic', envVars: ['ANTHROPIC_API_KEY'] },
	{ providerName: 'openAI', envVars: ['OPENAI_API_KEY'] },
	{ providerName: 'deepseek', envVars: ['DEEPSEEK_API_KEY'] },
	{ providerName: 'gemini', envVars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'] },
	{ providerName: 'groq', envVars: ['GROQ_API_KEY'] },
	{ providerName: 'xAI', envVars: ['XAI_API_KEY'] },
	{ providerName: 'mistral', envVars: ['MISTRAL_API_KEY'] },
	{ providerName: 'openRouter', envVars: ['OPENROUTER_API_KEY'] },
	{ providerName: 'githubModels', envVars: ['GITHUB_TOKEN', 'GH_TOKEN'] },
	{ providerName: 'fireworksAI', envVars: ['FIREWORKS_API_KEY'] },
	{ providerName: 'cerebras', envVars: ['CEREBRAS_API_KEY'] },
];

export const AWS_ENV_VARS = {
	accessKeyId: ['AWS_ACCESS_KEY_ID'],
	secretAccessKey: ['AWS_SECRET_ACCESS_KEY'],
	region: ['AWS_REGION', 'AWS_DEFAULT_REGION'],
} as const;

export const AZURE_ENV_VARS = {
	apiKey: ['AZURE_OPENAI_API_KEY', 'AZURE_API_KEY'],
	endpoint: ['AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_BASE_URL'],
} as const;

export const GCP_ENV_VARS = {
	credentials: ['GOOGLE_APPLICATION_CREDENTIALS'],
	project: ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'GCP_PROJECT'],
	region: ['GOOGLE_CLOUD_REGION', 'GCP_REGION'],
} as const;

export const AUTO_CONNECT_STORAGE_KEY = 'void.autoConnect';
