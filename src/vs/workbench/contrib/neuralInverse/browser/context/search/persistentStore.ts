/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Persistent Context Store — IndexedDB-backed persistence for search indexes.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';

const DB_NAME = 'ni-context-search';
const DB_VERSION = 2;
const STORE_BM25 = 'bm25-index';
const STORE_TRIGRAM = 'trigram-index';
const STORE_EMBEDDINGS = 'embeddings';
const STORE_LEDGER_ENTRIES = 'ledger-entries';
const STORE_LEDGER_EPISODES = 'ledger-episodes';

export interface IStoredChunk {
	id: string; // workspace_id:file_path:chunk_index
	filePath: string;
	contentHash: string;
	content: string;
	startLine: number;
	endLine: number;
	symbolName?: string;
	terms: string[]; // tokenized terms for BM25
	updatedAt: number;
}

export interface IStoredEmbedding {
	id: string;
	filePath: string;
	contentHash: string;
	vector: Float32Array;
	updatedAt: number;
}

export interface IStoredTrigram {
	trigram: string;
	entries: { id: string; filePath: string; symbolName?: string }[];
}

/** Searchable index record for one ledger journal entry (context ledger, task M5 phase 3). */
export interface IStoredLedgerEntry {
	id: string; // `${threadId}:${seq}` — composite key enables prefix range scans without compound indexes
	threadId: string;
	seq: number;
	role: string; // LedgerRole from the void ledger contracts, kept loose so this module stays dependency-free
	name?: string; // tool name for role='tool'
	ts: number;
	tokens: number;
	terms: string[]; // tokenized search terms (multiEntry index)
	snippet: string;
}

/** Searchable index record for one frozen episode summary (context ledger, task M5 phase 3). */
export interface IStoredLedgerEpisode {
	id: string; // `${threadId}:${ordinal}`
	threadId: string;
	ordinal: number;
	fromSeq: number;
	toSeq: number;
	ts: number;
	terms: string[]; // tokenized search terms (multiEntry index)
	body: string; // compact JSON of the episode body, capped
}

export interface IPersistentContextStore {
	readonly _serviceBrand: undefined;

	initialize(workspaceId: string): Promise<void>;

	// BM25 Index
	putChunks(chunks: IStoredChunk[]): Promise<void>;
	getChunksByFile(filePath: string): Promise<IStoredChunk[]>;
	getAllChunks(): Promise<IStoredChunk[]>;
	deleteChunksByFile(filePath: string): Promise<void>;

	// Trigrams
	putTrigrams(trigrams: IStoredTrigram[]): Promise<void>;
	getTrigramEntries(trigram: string): Promise<IStoredTrigram | undefined>;

	// Embeddings
	putEmbeddings(embeddings: IStoredEmbedding[]): Promise<void>;
	getEmbedding(id: string): Promise<IStoredEmbedding | undefined>;
	getAllEmbeddings(): Promise<IStoredEmbedding[]>;

	// Ledger Entries (context ledger index, task M5 phase 3)
	putLedgerEntries(entries: IStoredLedgerEntry[]): Promise<void>;
	getLedgerEntriesByThread(threadId: string): Promise<IStoredLedgerEntry[]>;
	searchLedgerEntriesByTerms(terms: string[], limit: number): Promise<IStoredLedgerEntry[]>;
	deleteLedgerEntriesByThread(threadId: string): Promise<void>;

	// Ledger Episodes (context ledger index, task M5 phase 3)
	putLedgerEpisodes(episodes: IStoredLedgerEpisode[]): Promise<void>;
	getLedgerEpisodesByThread(threadId: string): Promise<IStoredLedgerEpisode[]>;
	searchLedgerEpisodesByTerms(terms: string[], limit: number): Promise<IStoredLedgerEpisode[]>;

	// Maintenance
	clearAll(): Promise<void>;
	getFileContentHash(filePath: string): Promise<string | undefined>;
}

export const IPersistentContextStore = createDecorator<IPersistentContextStore>('persistentContextStore');

class PersistentContextStore extends Disposable implements IPersistentContextStore {
	readonly _serviceBrand: undefined;

	private _db: IDBDatabase | null = null;
	private _workspaceId = '';

	async initialize(workspaceId: string): Promise<void> {
		this._workspaceId = workspaceId;
		this._db = await this._openDB();
	}

	private _openDB(): Promise<IDBDatabase> {
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(`${DB_NAME}-${this._workspaceId}`, DB_VERSION);
			req.onupgradeneeded = (e) => {
				const db = (e.target as IDBOpenDBRequest).result;
				if (!db.objectStoreNames.contains(STORE_BM25)) {
					const store = db.createObjectStore(STORE_BM25, { keyPath: 'id' });
					store.createIndex('filePath', 'filePath', { unique: false });
					store.createIndex('contentHash', 'contentHash', { unique: false });
				}
				if (!db.objectStoreNames.contains(STORE_TRIGRAM)) {
					db.createObjectStore(STORE_TRIGRAM, { keyPath: 'trigram' });
				}
				if (!db.objectStoreNames.contains(STORE_EMBEDDINGS)) {
					const eStore = db.createObjectStore(STORE_EMBEDDINGS, { keyPath: 'id' });
					eStore.createIndex('filePath', 'filePath', { unique: false });
				}
				// v2: context ledger index stores (task M5 phase 3). Both blocks are
				// guarded so a v1 → v2 upgrade and a fresh open take the same path,
				// and the three stores above pass through untouched (indexes survive).
				if (!db.objectStoreNames.contains(STORE_LEDGER_ENTRIES)) {
					const lStore = db.createObjectStore(STORE_LEDGER_ENTRIES, { keyPath: 'id' });
					lStore.createIndex('threadId', 'threadId', { unique: false });
					lStore.createIndex('terms', 'terms', { unique: false, multiEntry: true });
				}
				if (!db.objectStoreNames.contains(STORE_LEDGER_EPISODES)) {
					const epStore = db.createObjectStore(STORE_LEDGER_EPISODES, { keyPath: 'id' });
					epStore.createIndex('threadId', 'threadId', { unique: false });
					epStore.createIndex('terms', 'terms', { unique: false, multiEntry: true });
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	async putChunks(chunks: IStoredChunk[]): Promise<void> {
		const tx = this._tx(STORE_BM25, 'readwrite');
		const store = tx.objectStore(STORE_BM25);
		for (const chunk of chunks) {
			store.put(chunk);
		}
		await this._complete(tx);
	}

	async getChunksByFile(filePath: string): Promise<IStoredChunk[]> {
		const tx = this._tx(STORE_BM25, 'readonly');
		const index = tx.objectStore(STORE_BM25).index('filePath');
		return this._getAllFromIndex(index, filePath);
	}

	async getAllChunks(): Promise<IStoredChunk[]> {
		const tx = this._tx(STORE_BM25, 'readonly');
		const store = tx.objectStore(STORE_BM25);
		return this._getAll(store);
	}

	async deleteChunksByFile(filePath: string): Promise<void> {
		const existing = await this.getChunksByFile(filePath);
		const tx = this._tx(STORE_BM25, 'readwrite');
		const store = tx.objectStore(STORE_BM25);
		for (const chunk of existing) {
			store.delete(chunk.id);
		}
		await this._complete(tx);
	}

	async putTrigrams(trigrams: IStoredTrigram[]): Promise<void> {
		const tx = this._tx(STORE_TRIGRAM, 'readwrite');
		const store = tx.objectStore(STORE_TRIGRAM);
		for (const t of trigrams) {
			store.put(t);
		}
		await this._complete(tx);
	}

	async getTrigramEntries(trigram: string): Promise<IStoredTrigram | undefined> {
		const tx = this._tx(STORE_TRIGRAM, 'readonly');
		const store = tx.objectStore(STORE_TRIGRAM);
		return this._get(store, trigram);
	}

	async putEmbeddings(embeddings: IStoredEmbedding[]): Promise<void> {
		const tx = this._tx(STORE_EMBEDDINGS, 'readwrite');
		const store = tx.objectStore(STORE_EMBEDDINGS);
		for (const e of embeddings) {
			store.put(e);
		}
		await this._complete(tx);
	}

	async getEmbedding(id: string): Promise<IStoredEmbedding | undefined> {
		const tx = this._tx(STORE_EMBEDDINGS, 'readonly');
		const store = tx.objectStore(STORE_EMBEDDINGS);
		return this._get(store, id);
	}

	async getAllEmbeddings(): Promise<IStoredEmbedding[]> {
		const tx = this._tx(STORE_EMBEDDINGS, 'readonly');
		const store = tx.objectStore(STORE_EMBEDDINGS);
		return this._getAll(store);
	}

	async putLedgerEntries(entries: IStoredLedgerEntry[]): Promise<void> {
		const tx = this._tx(STORE_LEDGER_ENTRIES, 'readwrite');
		const store = tx.objectStore(STORE_LEDGER_ENTRIES);
		for (const entry of entries) {
			store.put(entry);
		}
		await this._complete(tx);
	}

	async getLedgerEntriesByThread(threadId: string): Promise<IStoredLedgerEntry[]> {
		const tx = this._tx(STORE_LEDGER_ENTRIES, 'readonly');
		const index = tx.objectStore(STORE_LEDGER_ENTRIES).index('threadId');
		const entries = await this._getAllFromIndex<IStoredLedgerEntry>(index, threadId);
		return entries.sort((a, b) => a.seq - b.seq);
	}

	async searchLedgerEntriesByTerms(terms: string[], limit: number): Promise<IStoredLedgerEntry[]> {
		return this._searchStoreByTerms<IStoredLedgerEntry>(STORE_LEDGER_ENTRIES, terms, limit);
	}

	async deleteLedgerEntriesByThread(threadId: string): Promise<void> {
		const existing = await this.getLedgerEntriesByThread(threadId);
		const tx = this._tx(STORE_LEDGER_ENTRIES, 'readwrite');
		const store = tx.objectStore(STORE_LEDGER_ENTRIES);
		for (const entry of existing) {
			store.delete(entry.id);
		}
		await this._complete(tx);
	}

	async putLedgerEpisodes(episodes: IStoredLedgerEpisode[]): Promise<void> {
		const tx = this._tx(STORE_LEDGER_EPISODES, 'readwrite');
		const store = tx.objectStore(STORE_LEDGER_EPISODES);
		for (const ep of episodes) {
			store.put(ep);
		}
		await this._complete(tx);
	}

	async getLedgerEpisodesByThread(threadId: string): Promise<IStoredLedgerEpisode[]> {
		const tx = this._tx(STORE_LEDGER_EPISODES, 'readonly');
		const index = tx.objectStore(STORE_LEDGER_EPISODES).index('threadId');
		const episodes = await this._getAllFromIndex<IStoredLedgerEpisode>(index, threadId);
		return episodes.sort((a, b) => a.ordinal - b.ordinal);
	}

	async searchLedgerEpisodesByTerms(terms: string[], limit: number): Promise<IStoredLedgerEpisode[]> {
		return this._searchStoreByTerms<IStoredLedgerEpisode>(STORE_LEDGER_EPISODES, terms, limit);
	}

	async clearAll(): Promise<void> {
		for (const storeName of [STORE_BM25, STORE_TRIGRAM, STORE_EMBEDDINGS, STORE_LEDGER_ENTRIES, STORE_LEDGER_EPISODES]) {
			const tx = this._tx(storeName, 'readwrite');
			tx.objectStore(storeName).clear();
			await this._complete(tx);
		}
	}

	async getFileContentHash(filePath: string): Promise<string | undefined> {
		const chunks = await this.getChunksByFile(filePath);
		return chunks.length > 0 ? chunks[0].contentHash : undefined;
	}

	private _tx(storeName: string, mode: IDBTransactionMode): IDBTransaction {
		if (!this._db) { throw new Error('DB not initialized'); }
		return this._db.transaction(storeName, mode);
	}

	private _complete(tx: IDBTransaction): Promise<void> {
		return new Promise((resolve, reject) => {
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}

	private _get<T>(store: IDBObjectStore, key: string): Promise<T | undefined> {
		return new Promise((resolve, reject) => {
			const req = store.get(key);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	private _getAll<T>(store: IDBObjectStore): Promise<T[]> {
		return new Promise((resolve, reject) => {
			const req = store.getAll();
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	private _getAllFromIndex<T>(index: IDBIndex, key: string): Promise<T[]> {
		return new Promise((resolve, reject) => {
			const req = index.getAll(key);
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	/**
	 * Query the multiEntry `terms` index of a ledger store: gather candidates
	 * per term, dedupe by id, then rank by term-hit count desc with ts desc as
	 * the tiebreak. All getAll requests are issued synchronously up front so
	 * the transaction cannot auto-commit between awaits.
	 */
	private async _searchStoreByTerms<T extends { id: string; ts: number }>(storeName: string, terms: string[], limit: number): Promise<T[]> {
		const uniqueTerms = [...new Set(terms)];
		if (uniqueTerms.length === 0) { return []; }
		const tx = this._tx(storeName, 'readonly');
		const index = tx.objectStore(storeName).index('terms');
		const perTerm = await Promise.all(uniqueTerms.map(term => this._getAllFromIndex<T>(index, term)));

		const byId = new Map<string, { record: T; hits: number }>();
		for (const matches of perTerm) {
			for (const record of matches) {
				const existing = byId.get(record.id);
				if (existing) {
					existing.hits++;
				} else {
					byId.set(record.id, { record, hits: 1 });
				}
			}
		}

		return [...byId.values()]
			.sort((a, b) => b.hits - a.hits || b.record.ts - a.record.ts)
			.slice(0, limit)
			.map(c => c.record);
	}
}

registerSingleton(IPersistentContextStore, PersistentContextStore, InstantiationType.Delayed);
