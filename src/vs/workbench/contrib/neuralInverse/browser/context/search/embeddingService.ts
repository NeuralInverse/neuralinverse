/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Embedding Service — optional API-based embeddings for semantic search.
 *  No-op when no embedding-capable provider is configured.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IPersistentContextStore, IStoredEmbedding } from './persistentStore.js';
import { IVoidSettingsService } from '../../../../void/common/voidSettingsService.js';

export interface IEmbeddingResult {
	id: string;
	filePath: string;
	similarity: number; // cosine similarity 0-1
}

export interface IEmbeddingService {
	readonly _serviceBrand: undefined;

	readonly isAvailable: boolean;

	embed(id: string, filePath: string, content: string, contentHash: string): Promise<void>;
	embedToVector(text: string): Promise<Float32Array | null>;
	search(query: string, maxResults?: number): Promise<IEmbeddingResult[]>;
	batchEmbed(items: { id: string; filePath: string; content: string; contentHash: string }[]): Promise<void>;
}

export const IEmbeddingService = createDecorator<IEmbeddingService>('embeddingService');

class EmbeddingService extends Disposable implements IEmbeddingService {
	readonly _serviceBrand: undefined;

	// In-memory vector cache for fast cosine search
	private _vectors = new Map<string, { filePath: string; vector: Float32Array }>();
	private _available = false;
	private _embeddingModel = 'text-embedding-3-small';
	private _dimensions = 1536;

	get isAvailable(): boolean { return this._available; }

	constructor(
		@IPersistentContextStore private readonly _contextStore: IPersistentContextStore,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
	) {
		super();
		this._loadFromStore();
		this._checkAvailability();
		this._register(this._settingsService.onDidChangeState(() => this._checkAvailability()));
	}

	private _checkAvailability(): void {
		const config = this._getEmbeddingProviderConfig();
		this._available = config !== null;
	}

	private _getEmbeddingProviderConfig(): { endpoint: string; apiKey: string; model: string } | null {
		const settings = this._settingsService.state.settingsOfProvider;

		// Provider configs: [settingsKey, baseUrl (or use endpoint field), embeddingModel]
		const providers: Array<{ key: string; baseUrl?: string; model?: string }> = [
			{ key: 'openAI', baseUrl: 'https://api.openai.com', model: 'text-embedding-3-small' },
			{ key: 'deepseek', baseUrl: 'https://api.deepseek.com' },
			{ key: 'groq', baseUrl: 'https://api.groq.com/openai' },
			{ key: 'xAI', baseUrl: 'https://api.x.ai' },
			{ key: 'mistral', baseUrl: 'https://api.mistral.ai', model: 'mistral-embed' },
			{ key: 'fireworksAI', baseUrl: 'https://api.fireworks.ai/inference' },
			{ key: 'cerebras', baseUrl: 'https://api.cerebras.ai' },
			{ key: 'githubModels', baseUrl: 'https://models.inference.ai.azure.com', model: 'text-embedding-3-small' },
			// Providers with custom endpoints
			{ key: 'openAICompatible' },
			{ key: 'ollama' },
			{ key: 'vLLM' },
			{ key: 'lmStudio' },
			{ key: 'liteLLM' },
			{ key: 'openRouter', baseUrl: 'https://openrouter.ai/api' },
			{ key: 'niFreeModels' },
			{ key: 'googleVertex' },
			{ key: 'microsoftAzure' },
			{ key: 'awsBedrock' },
		];

		for (const p of providers) {
			const s = (settings as any)[p.key];
			if (!s) continue;

			const base = (s.endpoint || p.baseUrl || '').replace(/\/+$/, '');
			if (!base) continue;

			// Local providers (ollama, vLLM, lmStudio) don't require API keys
			const apiKey = s.apiKey || '';

			return {
				endpoint: `${base}/v1/embeddings`,
				apiKey,
				model: p.model || this._embeddingModel,
			};
		}

		return null;
	}

	async embed(id: string, filePath: string, content: string, contentHash: string): Promise<void> {
		if (!this._available) { return; }

		const vector = await this._getEmbeddingVector(content);
		if (!vector) { return; }

		this._vectors.set(id, { filePath, vector });
		await this._contextStore.putEmbeddings([{
			id,
			filePath,
			contentHash,
			vector,
			updatedAt: Date.now(),
		}]);
	}

	/**
	 * Embed arbitrary text and return the raw vector (task M2): lets callers
	 * outside the code index — e.g. the agent memory hybrid retrieval — use the
	 * same provider without storing into this service's vector cache.
	 * Returns null whenever no embedding provider is configured (graceful).
	 */
	async embedToVector(text: string): Promise<Float32Array | null> {
		if (!this._available) { return null; }
		try {
			return await this._getEmbeddingVector(text);
		} catch {
			return null;
		}
	}

	async search(query: string, maxResults: number = 10): Promise<IEmbeddingResult[]> {
		if (!this._available || this._vectors.size === 0) { return []; }

		const queryVector = await this._getEmbeddingVector(query);
		if (!queryVector) { return []; }

		const results: IEmbeddingResult[] = [];
		for (const [id, { filePath, vector }] of this._vectors) {
			const similarity = this._cosineSimilarity(queryVector, vector);
			results.push({ id, filePath, similarity });
		}

		return results
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, maxResults);
	}

	async batchEmbed(items: { id: string; filePath: string; content: string; contentHash: string }[]): Promise<void> {
		if (!this._available) { return; }

		// Process in batches of 100
		const BATCH_SIZE = 100;
		for (let i = 0; i < items.length; i += BATCH_SIZE) {
			const batch = items.slice(i, i + BATCH_SIZE);
			const embeddings: IStoredEmbedding[] = [];

			for (const item of batch) {
				const vector = await this._getEmbeddingVector(item.content);
				if (vector) {
					this._vectors.set(item.id, { filePath: item.filePath, vector });
					embeddings.push({
						id: item.id,
						filePath: item.filePath,
						contentHash: item.contentHash,
						vector,
						updatedAt: Date.now(),
					});
				}
			}

			if (embeddings.length > 0) {
				await this._contextStore.putEmbeddings(embeddings);
			}
		}
	}

	private async _loadFromStore(): Promise<void> {
		try {
			const all = await this._contextStore.getAllEmbeddings();
			for (const e of all) {
				this._vectors.set(e.id, { filePath: e.filePath, vector: e.vector });
			}
		} catch {
			// Store not initialized yet — will be loaded later
		}
	}

	private async _getEmbeddingVector(content: string): Promise<Float32Array | null> {
		const config = this._getEmbeddingProviderConfig();
		if (!config) return null;

		try {
			const truncated = content.slice(0, 8000);
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (config.apiKey) { headers['Authorization'] = `Bearer ${config.apiKey}`; }
			const res = await fetch(config.endpoint, {
				method: 'POST',
				headers,
				body: JSON.stringify({ model: config.model, input: truncated, dimensions: this._dimensions }),
			});
			if (!res.ok) return null;
			const json = await res.json();
			const embedding = json?.data?.[0]?.embedding;
			if (!Array.isArray(embedding)) return null;
			return new Float32Array(embedding);
		} catch {
			return null;
		}
	}

	private _cosineSimilarity(a: Float32Array, b: Float32Array): number {
		if (a.length !== b.length) { return 0; }
		let dot = 0, normA = 0, normB = 0;
		for (let i = 0; i < a.length; i++) {
			dot += a[i] * b[i];
			normA += a[i] * a[i];
			normB += b[i] * b[i];
		}
		const denom = Math.sqrt(normA) * Math.sqrt(normB);
		return denom > 0 ? dot / denom : 0;
	}
}

registerSingleton(IEmbeddingService, EmbeddingService, InstantiationType.Delayed);
