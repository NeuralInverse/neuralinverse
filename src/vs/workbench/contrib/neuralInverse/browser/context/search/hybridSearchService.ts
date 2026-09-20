/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Hybrid Search Service — combines BM25 + trigram + embeddings for semantic search.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceBM25Service, IBM25Result } from './bm25Index.js';
import { ITrigramIndexService, ITrigramMatch } from './trigramIndex.js';
import { IEmbeddingService, IEmbeddingResult } from './embeddingService.js';

export interface IHybridSearchResult {
	filePath: string;
	content: string;
	startLine: number;
	endLine: number;
	symbolName?: string;
	score: number;
	sources: ('bm25' | 'trigram' | 'embedding')[];
}

export interface IHybridSearchService {
	readonly _serviceBrand: undefined;

	search(query: string, maxResults?: number): Promise<IHybridSearchResult[]>;
	getStatus(): { bm25Files: number; trigramEntries: number; embeddingsAvailable: boolean };
}

export const IHybridSearchService = createDecorator<IHybridSearchService>('hybridSearchService');

// Score weights for combining results
const W_BM25 = 0.55;
const W_TRIGRAM = 0.25;
const W_EMBEDDING = 0.20;

export class HybridSearchService extends Disposable implements IHybridSearchService {
	readonly _serviceBrand: undefined;

	constructor(
		@IWorkspaceBM25Service private readonly _bm25: IWorkspaceBM25Service,
		@ITrigramIndexService private readonly _trigram: ITrigramIndexService,
		@IEmbeddingService private readonly _embedding: IEmbeddingService,
	) {
		super();
	}

	async search(query: string, maxResults: number = 20): Promise<IHybridSearchResult[]> {
		// Run all search backends in parallel
		const [bm25Results, trigramResults, embeddingResults] = await Promise.all([
			this._bm25.search(query, maxResults * 2),
			Promise.resolve(this._trigram.search(query, maxResults * 2)),
			this._embedding.search(query, maxResults * 2),
		]);

		// Normalize scores to 0-1 range per source
		const bm25Normalized = this._normalizeScores(bm25Results.map(r => ({ key: r.chunkId, score: r.score })));
		const trigramNormalized = this._normalizeScores(trigramResults.map(r => ({ key: r.id, score: r.score })));
		const embeddingNormalized = this._normalizeScores(embeddingResults.map(r => ({ key: r.id, score: r.similarity })));

		// Merge into unified score map (keyed by filePath:startLine for dedup)
		const merged = new Map<string, {
			score: number;
			sources: Set<'bm25' | 'trigram' | 'embedding'>;
			bm25Result?: IBM25Result;
			trigramResult?: ITrigramMatch;
			embeddingResult?: IEmbeddingResult;
		}>();

		// Add BM25 results
		for (const result of bm25Results) {
			const key = `${result.filePath}:${result.startLine}`;
			const normalizedScore = bm25Normalized.get(result.chunkId) || 0;
			merged.set(key, {
				score: normalizedScore * W_BM25,
				sources: new Set(['bm25']),
				bm25Result: result,
			});
		}

		// Add trigram results (boost existing or create new)
		for (const result of trigramResults) {
			const key = `${result.filePath}:0`; // trigram matches are file-level
			const normalizedScore = trigramNormalized.get(result.id) || 0;
			const existing = merged.get(key);
			if (existing) {
				existing.score += normalizedScore * W_TRIGRAM;
				existing.sources.add('trigram');
				existing.trigramResult = result;
			} else {
				merged.set(key, {
					score: normalizedScore * W_TRIGRAM,
					sources: new Set(['trigram']),
					trigramResult: result,
				});
			}
		}

		// Add embedding results (boost existing or create new). Vector hits
		// keep their chunk identity (content + line range, persisted with the
		// vector) so a file that only the vector backend found still surfaces
		// usable content instead of being dropped by the output filter.
		for (const result of embeddingResults) {
			const key = `${result.filePath}:${result.startLine ?? 0}`;
			const normalizedScore = embeddingNormalized.get(result.id) || 0;
			const existing = merged.get(key);
			if (existing) {
				existing.score += normalizedScore * W_EMBEDDING;
				existing.sources.add('embedding');
			} else {
				merged.set(key, {
					score: normalizedScore * W_EMBEDDING,
					sources: new Set(['embedding']),
					embeddingResult: result,
				});
			}
		}

		// Sort and format results
		const sorted = [...merged.entries()]
			.sort((a, b) => b[1].score - a[1].score)
			.slice(0, maxResults);

		return sorted.map(([_key, data]) => ({
			filePath: data.bm25Result?.filePath || data.trigramResult?.filePath || data.embeddingResult?.filePath || '',
			content: data.bm25Result?.content || data.embeddingResult?.content || '',
			startLine: data.bm25Result?.startLine || data.embeddingResult?.startLine || 0,
			endLine: data.bm25Result?.endLine || data.embeddingResult?.endLine || 0,
			symbolName: data.bm25Result?.symbolName || data.trigramResult?.symbolName,
			score: data.score,
			sources: [...data.sources],
		})).filter(r => r.filePath);
	}

	getStatus(): { bm25Files: number; trigramEntries: number; embeddingsAvailable: boolean } {
		return {
			bm25Files: this._bm25.getIndexedFileCount(),
			trigramEntries: this._trigram.getEntryCount(),
			embeddingsAvailable: this._embedding.isAvailable,
		};
	}

	private _normalizeScores(items: { key: string; score: number }[]): Map<string, number> {
		const result = new Map<string, number>();
		if (items.length === 0) { return result; }

		const maxScore = Math.max(...items.map(i => i.score));
		if (maxScore <= 0) { return result; }

		for (const item of items) {
			result.set(item.key, item.score / maxScore);
		}
		return result;
	}
}

registerSingleton(IHybridSearchService, HybridSearchService, InstantiationType.Delayed);
