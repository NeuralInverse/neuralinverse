/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Embedding Service — optional API-based embeddings for semantic search and agent memory.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IPersistentContextStore, IStoredEmbedding } from './persistentStore.js';
import { IVoidSettingsService } from '../../../../void/common/voidSettingsService.js';
import { niTask1ObsPush } from '../obs/task1Obs.js';

export interface IEmbeddingResult {
	id: string;
	filePath: string;
	similarity: number; // cosine similarity 0-1
	/** Chunk provenance — kept so vector-only hits stay usable in hybrid
	 *  search (content + line range) instead of degrading to a bare path. */
	model?: string;
	startLine?: number;
	endLine?: number;
	content?: string;
}

/** Identity-bearing embed result (B2 live closure): the model is the one the
 *  REQUEST was built with — a settings change during the await must never
 *  relabel a vector produced by another model. */
export interface IEmbedTextResult {
	vector: Float32Array;
	model: string;
}

export interface IEmbeddingService {
	readonly _serviceBrand: undefined;

	readonly isAvailable: boolean;
	/** Identity of the currently configured embedding model (F06): records
	 *  stamped with a different model are stale and must be re-embedded. */
	readonly model: string | undefined;
	/** Fires whenever the configured embedding model identity changes (B2):
	 *  consumers with persisted vectors re-embed stale records in response. */
	readonly onDidChangeModel: Event<string | undefined>;

	embed(id: string, filePath: string, content: string, contentHash: string): Promise<void>;
	embedToVector(text: string): Promise<Float32Array | null>;
	/** Embed text and return the vector TOGETHER with the model identity of
	 *  the request that produced it (B2 live closure — stamp callers use this
	 *  so mid-flight provider/model switches cannot mislabel a vector). */
	embedText(text: string): Promise<IEmbedTextResult | null>;
	search(query: string, maxResults?: number): Promise<IEmbeddingResult[]>;
	batchEmbed(items: { id: string; filePath: string; content: string; contentHash: string }[]): Promise<void>;
	/** Stamped variant used by the ingestion pipeline: chunk metadata is
	 *  persisted with the vector and the current model identity. */
	embedChunk(chunk: { id: string; filePath: string; content: string; contentHash: string; startLine: number; endLine: number }): Promise<boolean>;
	getEmbeddingsForFile(filePath: string): Promise<IStoredEmbedding[]>;
	deleteEmbeddingsForFile(filePath: string): Promise<void>;
}

export const IEmbeddingService = createDecorator<IEmbeddingService>('embeddingService');

interface IEmbeddingRecord {
	filePath: string;
	model: string | undefined;
	startLine: number | undefined;
	endLine: number | undefined;
	content: string | undefined;
	vector: Float32Array;
}

const EMBED_TIMEOUT_MS = 15_000;
const STORED_CONTENT_PREVIEW = 2_000;

/**
 * Normalizes an embedding base URL into an OpenAI-compatible /v1/embeddings endpoint.
 * - Handles host, port, and pathname cleanly using structural URL parsing.
 * - Preserves user-specified explicit port and base paths (e.g. /api).
 * - Avoids /v1/v1 duplication if the user provides a path ending in /v1.
 * - Normalizes exact loopback and local router aliases (127.0.0.1 and omni.local) to localhost
 *   for Electron renderer connect-src CSP compatibility, without mangling lookalike hostnames (like 127.0.0.1.example.test).
 * - Only defaults port to 20128 for the 'omni' provider when no port is specified.
 * - Leaves HTTPS and remote hosts untouched.
 */
export function normalizeEmbeddingEndpoint(rawInput: string, providerKey?: string): string | null {
	const trimmed = rawInput.trim();
	if (!trimmed) {
		return null;
	}

	let urlObj: URL;
	try {
		if (!/^https?:\/\//i.test(trimmed)) {
			urlObj = new URL(`http://${trimmed}`);
		} else {
			urlObj = new URL(trimmed);
		}
	} catch {
		return null;
	}

	const protocol = urlObj.protocol.toLowerCase();
	if (protocol !== 'http:' && protocol !== 'https:') {
		return null;
	}

	let hostname = urlObj.hostname.toLowerCase();
	const explicitPortMatch = trimmed.match(/:(\d+)(?:\/|$|\?|#)/);
	const explicitPort = explicitPortMatch ? explicitPortMatch[1] : (urlObj.port || '');
	let port = explicitPort;

	// Provider-specific loopback alias and default port behavior (scoped to omni provider contract)
	if (providerKey === 'omni') {
		if ((hostname === '127.0.0.1' || hostname === 'omni.local') && protocol === 'http:') {
			hostname = 'localhost';
		}
		if (!port) {
			port = '20128';
		}
	}

	// Pathname handling:
	// Strip trailing slashes and trailing /v1 (case-insensitive)
	let pathname = urlObj.pathname.replace(/\/+$/, '');
	if (pathname.toLowerCase().endsWith('/v1')) {
		pathname = pathname.slice(0, -3).replace(/\/+$/, '');
	}

	const hostAndPort = port ? `${hostname}:${port}` : hostname;
	const cleanBase = pathname ? `${protocol}//${hostAndPort}${pathname}` : `${protocol}//${hostAndPort}`;
	return `${cleanBase}/v1/embeddings`;
}

export class EmbeddingService extends Disposable implements IEmbeddingService {
	readonly _serviceBrand: undefined;

	// In-memory vector cache for fast cosine search
	private _vectors = new Map<string, IEmbeddingRecord>();
	private _available = false;
	private _embeddingModel: string | undefined;

	private readonly _onDidChangeModel = new Emitter<string | undefined>();
	readonly onDidChangeModel: Event<string | undefined> = this._onDidChangeModel.event;

	get isAvailable(): boolean { return this._available; }
	get model(): string | undefined { return this._embeddingModel; }

	constructor(
		@IPersistentContextStore private readonly _contextStore: IPersistentContextStore,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
	) {
		super();
		this._loadFromStore();
		this._checkAvailability();
		this._register(this._settingsService.onDidChangeState(() => this._checkAvailability()));
		this._register(this._onDidChangeModel);
	}

	private _checkAvailability(): void {
		const config = this._getEmbeddingProviderConfig();
		this._available = config !== null;
		if (config && this._embeddingModel !== config.model) {
			this._embeddingModel = config.model;
			// Model switch: vectors from the previous model live in a
			// different dimension space — cosine against them is meaningless.
			// Evict them from the live cache; the store keeps them until the
			// ingestion pass re-embeds the files.
			this._evictOtherModelVectors(config.model);
			this._onDidChangeModel.fire(config.model);
		}
	}

	private _evictOtherModelVectors(currentModel: string): void {
		for (const [id, rec] of this._vectors) {
			if (rec.model !== currentModel) {
				this._vectors.delete(id);
			}
		}
	}

	private _getEmbeddingProviderConfig(): { endpoint: string; apiKey: string; model: string } | null {
		const settings = this._settingsService.state.settingsOfProvider;

		// Provider configs: [settingsKey, baseUrl, embeddingModel]. Only
		// providers that actually expose an OpenAI-compatible /v1/embeddings
		// endpoint are auto-selected (task M2 item 3): picking a provider
		// merely because a config object exists made _available true for
		// chat-only setups whose embed calls then failed on every request.
		// deepseek/groq/xAI/fireworksAI/cerebras have no
		// OpenAI-compatible embeddings endpoint; Vertex/Azure/Bedrock need
		// their own clients — add those here when implemented.
		// omni is LOCAL (parity with voidSettingsTypes.localProviderNames):
		// the chat path does not require an API key either, so gating
		// embeddings on one made a working router look unavailable (B2 live
		// closure, 2026-09-16). Its default model is a real router embedding
		// combo — the previous generic fallback ('text-embedding-3-small') is
		// an OpenAI name the router routes to a credit-less upstream.
		const providers: Array<{ key: string; baseUrl?: string; model?: string; local?: boolean }> = [
			{ key: 'openAI', baseUrl: 'https://api.openai.com', model: 'text-embedding-3-small' },
			{ key: 'mistral', baseUrl: 'https://api.mistral.ai', model: 'mistral-embed' },
			{ key: 'githubModels', baseUrl: 'https://models.inference.ai.azure.com', model: 'text-embedding-3-small' },
			{ key: 'openRouter', baseUrl: 'https://openrouter.ai/api' },
			// Providers with custom endpoints (OpenAI-compatible by design)
			{ key: 'openAICompatible' },
			{ key: 'omni', model: 'mistral-embed', local: true },
			{ key: 'ollama', model: 'nomic-embed-text', local: true },
			{ key: 'vLLM', local: true },
			{ key: 'lmStudio', local: true },
			{ key: 'liteLLM' },
		];

		for (const p of providers) {
			const s = (settings as Record<string, { endpoint?: string; apiKey?: string; embeddingModel?: string } | undefined>)[p.key];
			if (!s) { continue; }

			const rawUrl = s.endpoint || p.baseUrl || '';
			if (!rawUrl) { continue; }

			const endpoint = normalizeEmbeddingEndpoint(rawUrl, p.key);
			if (!endpoint) { continue; }

			// Local providers (omni, ollama, vLLM, lmStudio) don't require API keys;
			// a remote provider without a key would fail every request, so it
			// does NOT count as available. For omni, fall back to environment key if present.
			const globalEnvHolder = globalThis as { vscode?: { process?: { env?: Record<string, string | undefined> } } };
			const envKey = (typeof process !== 'undefined' ? process.env?.['OMNI_API_KEY'] : undefined)
				|| globalEnvHolder.vscode?.process?.env?.['OMNI_API_KEY'];
			const apiKey = s.apiKey || (p.key === 'omni' ? envKey : '') || '';
			if (!p.local && !apiKey) { continue; }

			// Model precedence: the per-provider `embeddingModel` SETTING, then
			// the provider preset. Filter out broken legacy default 'openrouter/qwen/qwen3-embedding-4b'.
			const rawModel = s.embeddingModel?.trim();
			const model = (rawModel && rawModel !== 'openrouter/qwen/qwen3-embedding-4b') ? rawModel : (p.model || 'mistral-embed');

			return {
				endpoint,
				apiKey,
				model,
			};
		}

		return null;
	}

	async embed(id: string, filePath: string, content: string, contentHash: string): Promise<void> {
		await this.embedChunk({ id, filePath, content, contentHash, startLine: 0, endLine: 0 });
	}

	async embedChunk(chunk: { id: string; filePath: string; content: string; contentHash: string; startLine: number; endLine: number }): Promise<boolean> {
		if (!this._available) { return false; }

		const result = await this._requestEmbedding(chunk.content);
		if (!result) { return false; }

		const record: IEmbeddingRecord = {
			filePath: chunk.filePath,
			// stamp the model of the REQUEST that produced this vector — not
			// the current setting (B2: a mid-flight model switch must not
			// relabel a vector from another model's vector space)
			model: result.model,
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			content: chunk.content.slice(0, STORED_CONTENT_PREVIEW),
			vector: result.vector,
		};
		this._vectors.set(chunk.id, record);
		const stored: IStoredEmbedding = {
			id: chunk.id,
			filePath: chunk.filePath,
			contentHash: chunk.contentHash,
			vector: result.vector,
			updatedAt: Date.now(),
			model: record.model,
			startLine: record.startLine,
			endLine: record.endLine,
			content: record.content,
		};
		try {
			await this._contextStore.putEmbeddings([stored]);
			niTask1ObsPush({
				kind: 'embed.persist',
				tags: { key: chunk.id, model: record.model ?? null, store: 'embeddings' },
				data: { dims: result.vector.length, filePath: chunk.filePath },
			});
		} catch {
			// Store failure leaves the in-memory cache populated — search
			// works for this session; durability is re-established on the
			// next ingestion pass (content-hash generation check).
			niTask1ObsPush({ kind: 'embed.persist', tags: { key: chunk.id, ok: false, store: 'embeddings' } });
		}
		return true;
	}

	/**
	 * Embed arbitrary text and return the raw vector (task M2): lets callers
	 * outside the code index — e.g. the agent memory hybrid retrieval — use the
	 * same provider without storing into this service's vector cache.
	 * Returns null whenever no embedding provider is configured (graceful).
	 */
	async embedToVector(text: string): Promise<Float32Array | null> {
		const result = await this.embedText(text);
		return result?.vector ?? null;
	}

	/**
	 * Identity-bearing variant (B2 live closure): the returned model is the
	 * one the HTTP request carried, so a caller stamping a persisted record
	 * cannot mislabel it after a mid-flight settings change.
	 */
	async embedText(text: string): Promise<IEmbedTextResult | null> {
		if (!this._available) {
			niTask1ObsPush({ kind: 'embed.request', tags: { available: false }, data: { textChars: text.length } });
			return null;
		}
		const t0 = Date.now();
		niTask1ObsPush({ kind: 'embed.request', tags: { available: true, model: this._embeddingModel ?? null }, data: { textChars: text.length } });
		try {
			const result = await this._requestEmbedding(text);
			niTask1ObsPush({
				kind: 'embed.response',
				tags: { ok: !!result, model: result?.model ?? this._embeddingModel ?? null },
				data: { dims: result?.vector?.length ?? 0, latencyMs: Date.now() - t0 },
			});
			return result;
		} catch {
			niTask1ObsPush({ kind: 'embed.response', tags: { ok: false }, data: { latencyMs: Date.now() - t0 } });
			return null;
		}
	}

	async search(query: string, maxResults: number = 10): Promise<IEmbeddingResult[]> {
		if (!this._available || this._vectors.size === 0) { return []; }

		const queryResult = await this._requestEmbedding(query);
		if (!queryResult) { return []; }
		const queryVector = queryResult.vector;

		const results: IEmbeddingResult[] = [];
		for (const [id, rec] of this._vectors) {
			// Stale-model vectors (including legacy records with no model
			// identity) must not answer queries — they were computed in a
			// different vector space.
			if (rec.model !== this._embeddingModel) { continue; }
			const similarity = this._cosineSimilarity(queryVector, rec.vector);
			results.push({
				id,
				filePath: rec.filePath,
				similarity,
				model: rec.model,
				startLine: rec.startLine,
				endLine: rec.endLine,
				content: rec.content,
			});
		}

		return results
			.sort((a, b) => b.similarity - a.similarity)
			.slice(0, maxResults);
	}

	async batchEmbed(items: { id: string; filePath: string; content: string; contentHash: string }[]): Promise<void> {
		// Process in batches of 100
		const BATCH_SIZE = 100;
		for (let i = 0; i < items.length; i += BATCH_SIZE) {
			const batch = items.slice(i, i + BATCH_SIZE);
			for (const item of batch) {
				await this.embedChunk({ ...item, startLine: 0, endLine: 0 });
			}
		}
	}

	async getEmbeddingsForFile(filePath: string): Promise<IStoredEmbedding[]> {
		try {
			return await this._contextStore.getEmbeddingsByFile(filePath);
		} catch {
			return [];
		}
	}

	async deleteEmbeddingsForFile(filePath: string): Promise<void> {
		for (const [id, rec] of this._vectors) {
			if (rec.filePath === filePath) { this._vectors.delete(id); }
		}
		try {
			await this._contextStore.deleteEmbeddingsByFile(filePath);
		} catch { /* best-effort cleanup */ }
	}

	private async _loadFromStore(): Promise<void> {
		try {
			const all = await this._contextStore.getAllEmbeddings();
			for (const e of all) {
				this._vectors.set(e.id, {
					filePath: e.filePath,
					model: e.model,
					startLine: e.startLine,
					endLine: e.endLine,
					content: e.content,
					vector: e.vector,
				});
			}
		} catch {
			// Store not initialized yet — will be loaded later
		}
	}

	/** POST one embeddings request. The returned `model` is the config value
	 *  the request was built with — captured BEFORE the await so a settings
	 *  change mid-flight cannot detach a vector from its producing model. */
	private async _requestEmbedding(content: string): Promise<IEmbedTextResult | null> {
		const config = this._getEmbeddingProviderConfig();
		if (!config) { return null; }
		const model = config.model;

		try {
			const truncated = content.slice(0, 8000);
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (config.apiKey) { headers['Authorization'] = `Bearer ${config.apiKey}`; }
			// No `dimensions` request param: it is OpenAI-specific and made
			// every other provider (e.g. mistral-embed, fixed at 1024) fail.
			// Each provider returns its native dimension; the model identity
			// on stored vectors keeps mixed-dimension spaces apart.
			const res = await fetch(config.endpoint, {
				method: 'POST',
				headers,
				body: JSON.stringify({ model, input: truncated }),
				signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
			});
			if (!res.ok) { return null; }
			const json = await res.json();
			const embedding = json?.data?.[0]?.embedding;
			if (!Array.isArray(embedding) || embedding.length === 0) { return null; }
			const vector = new Float32Array(embedding);
			// Finite-vector validation (F06): NaN/Inf components poison cosine
			// similarity for the whole cache.
			for (let i = 0; i < vector.length; i++) {
				if (!Number.isFinite(vector[i])) { return null; }
			}
			return { vector, model };
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
