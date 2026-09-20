/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Code Embedding Ingestion — feeds lexical chunks into the vector store (phase 2).
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../../../platform/log/common/log.js';
import { IPersistentContextStore } from './persistentStore.js';
import { IEmbeddingService } from './embeddingService.js';
import { IWorkspaceSymbolIndexService } from '../index/workspaceSymbolIndex.js';

export const ICodeEmbeddingIngestionService = createDecorator<ICodeEmbeddingIngestionService>('codeEmbeddingIngestion');

export interface ICodeEmbeddingIngestionService {
	readonly _serviceBrand: undefined;
	/** Test/telemetry view of the ingestion state. */
	getStatus(): { queued: number; active: number; embedded: number; dropped: number; failed: number; lastError: string | undefined };
	/** Explicitly (re)ingest one file — used after lexical indexing events. */
	ingestFile(filePath: string): Promise<void>;
}

/** Bounded background queue (F-code-ingestion): lexical indexing ALWAYS stays
 *  usable without embeddings — this service no-ops unless an embedding
 *  provider is actually configured, never blocks the lexical path, and keeps
 *  the queue finite so a huge workspace cannot exhaust memory or API budget. */
const MAX_CONCURRENCY = 2;
const MAX_PENDING_FILES = 2_000;
const RETRY_LIMIT = 1;

export class CodeEmbeddingIngestionService extends Disposable implements ICodeEmbeddingIngestionService {
	readonly _serviceBrand: undefined;

	private _queue: string[] = [];
	private _active = 0;
	private _queued = new Set<string>();
	private _embedded = 0;
	private _dropped = 0;
	private _failed = 0;
	private _lastError: string | undefined;
	private _disposed = false;

	constructor(
		@IPersistentContextStore private readonly _contextStore: IPersistentContextStore,
		@IEmbeddingService private readonly _embeddings: IEmbeddingService,
		@IWorkspaceSymbolIndexService symbolIndex: IWorkspaceSymbolIndexService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		// Lexical events drive ingestion: only files whose chunks exist get
		// embedded, and deletions/renames/ignore-drops clean the vector store.
		this._register(symbolIndex.onDidReindex(uris => {
			if (!this._embeddings.isAvailable) { return; }
			for (const uri of uris) { this._enqueue(this._uriToPath(uri)); }
			this._pump();
		}));
		this._register(symbolIndex.onDidRemoveFiles(uris => {
			for (const uri of uris) {
				void this._embeddings.deleteEmbeddingsForFile(this._uriToPath(uri));
			}
		}));
	}

	getStatus(): { queued: number; active: number; embedded: number; dropped: number; failed: number; lastError: string | undefined } {
		return { queued: this._queue.length, active: this._active, embedded: this._embedded, dropped: this._dropped, failed: this._failed, lastError: this._lastError };
	}

	async ingestFile(filePath: string): Promise<void> {
		if (!this._embeddings.isAvailable) { return; }
		await this._ingestOne(filePath);
	}

	private _uriToPath(uri: string): string {
		try {
			const resource = URI.parse(uri);
			// Non-file schemes (vscode-remote, untitled, …) have no BM25 chunks
			// keyed by fsPath — the lexical feed keyed by fsPath only covers
			// local files, so skip everything else.
			return resource.scheme === 'file' ? resource.fsPath : '';
		} catch {
			return '';
		}
	}

	private _enqueue(filePath: string): void {
		if (this._disposed || filePath === '' || this._queued.has(filePath)) { return; }
		if (this._queued.size >= MAX_PENDING_FILES) {
			this._dropped++;
			if (this._dropped === 1 || this._dropped % 500 === 0) {
				this._logService.warn(`[EmbedIngest] queue cap reached (${MAX_PENDING_FILES}); ${this._dropped} files skipped this session — run a reindex to embed them`);
			}
			return;
		}
		this._queued.add(filePath);
		this._queue.push(filePath);
	}

	private _pump(): void {
		while (this._active < MAX_CONCURRENCY && this._queue.length > 0 && !this._disposed) {
			const filePath = this._queue.shift()!;
			this._queued.delete(filePath);
			this._active++;
			void (async () => {
				try {
					await this._ingestOne(filePath);
				} finally {
					this._active--;
					this._pump();
				}
			})();
		}
	}

	private async _ingestOne(filePath: string): Promise<void> {
		if (this._disposed) { return; }
		let chunks;
		try {
			chunks = await this._contextStore.getChunksByFile(filePath);
		} catch (e) {
			this._failed++;
			this._lastError = `chunk read failed for ${filePath}: ${e instanceof Error ? e.message : String(e)}`;
			return;
		}
		if (chunks.length === 0) { return; }

		let stored: Awaited<ReturnType<IEmbeddingService['getEmbeddingsForFile']>>;
		try {
			stored = await this._embeddings.getEmbeddingsForFile(filePath);
		} catch {
			stored = [];
		}
		const storedById = new Map(stored.map(e => [e.id, e]));
		const liveIds = new Set(chunks.map(c => c.id));

		// Orphan cleanup: chunks that no longer exist (edit shrank the file,
		// file rewritten with fewer chunks) leave stale vectors behind. The
		// whole file's vectors are dropped first (awaited, so the re-embeds
		// below cannot race the delete), then every live chunk re-embeds.
		if (stored.some(e => !liveIds.has(e.id))) {
			await this._embeddings.deleteEmbeddingsForFile(filePath);
			storedById.clear();
		}

		const model = this._embeddings.model;
		for (const chunk of chunks) {
			if (this._disposed) { return; }
			const existing = storedById.get(chunk.id);
			// Generation check: embed only when the chunk is new, its content
			// hash changed, or the vector came from a different embedding
			// model (legacy records without a model count as stale).
			if (existing && existing.contentHash === chunk.contentHash && existing.model === model) {
				continue;
			}
			let ok = false;
			for (let attempt = 0; attempt <= RETRY_LIMIT && !ok && !this._disposed; attempt++) {
				ok = await this._embeddings.embedChunk({
					id: chunk.id,
					filePath,
					content: chunk.content,
					contentHash: chunk.contentHash,
					startLine: chunk.startLine,
					endLine: chunk.endLine,
				});
			}
			if (ok) {
				this._embedded++;
			} else {
				this._failed++;
				this._lastError = `embed failed for ${chunk.id}`;
			}
		}
	}

	override dispose(): void {
		this._disposed = true;
		this._queue = [];
		this._queued.clear();
		super.dispose();
	}
}

registerSingleton(ICodeEmbeddingIngestionService, CodeEmbeddingIngestionService, InstantiationType.Delayed);
