/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  BM25 Index — full-text search over workspace file contents.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IPersistentContextStore, IStoredChunk } from './persistentStore.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';

// BM25 parameters
const K1 = 1.2;
const B = 0.75;

export interface IBM25Result {
	filePath: string;
	chunkId: string;
	score: number;
	content: string;
	startLine: number;
	endLine: number;
	symbolName?: string;
	/** B3 docs citation: the section this chunk belongs to */
	sectionTitle?: string;
}

export interface IWorkspaceBM25Service {
	readonly _serviceBrand: undefined;

	readonly isReady: boolean;

	indexFile(filePath: string, content: string, contentHash: string): Promise<void>;
	removeFile(filePath: string): Promise<void>;
	search(query: string, maxResults?: number): Promise<IBM25Result[]>;
	getIndexedFileCount(): number;
	rebuild(): Promise<void>;
}

export const IWorkspaceBM25Service = createDecorator<IWorkspaceBM25Service>('workspaceBM25Service');

// In-memory inverted index for fast search (persisted to IndexedDB for restart survival)
interface PostingEntry {
	chunkId: string;
	filePath: string;
	tf: number; // term frequency in this chunk
}

export class WorkspaceBM25Service extends Disposable implements IWorkspaceBM25Service {
	readonly _serviceBrand: undefined;

	private _invertedIndex = new Map<string, PostingEntry[]>(); // term -> postings
	private _docLengths = new Map<string, number>(); // chunkId -> doc length (in terms)
	private _avgDocLength = 0;
	private _totalDocs = 0;
	private _indexedFiles = new Set<string>();
	private _ready = false;

	/**
	 * Lazy init for the persistent store — one attempt per workspace,
	 * keyed by the sanitized workspace URI (same pattern as
	 * ledgerRecallService._ensureStore).  A failed init degrades to
	 * in-memory-only operation — never an error for the caller.
	 */
	private _storeInit: Promise<boolean> | undefined;

	/**
	 * Guards the one-shot hydration from the persistent store so that
	 * rebuild() runs exactly once per service lifetime, right after the
	 * store initializes successfully.  Without this, the in-memory
	 * inverted index stays empty on every restart after the first
	 * because indexFile() early-returns for unchanged files (line 94).
	 */
	private _hydrated = false;

	get isReady(): boolean { return this._ready; }

	constructor(
		@IPersistentContextStore private readonly _contextStore: IPersistentContextStore,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	private _ensureStore(): Promise<boolean> {
		if (!this._storeInit) {
			this._storeInit = (async () => {
				const ws = this._workspaceContextService.getWorkspace().folders[0]?.uri;
				if (!ws) { return false; }
				const id = ws.toString().replace(/[^a-zA-Z0-9]/g, '_').slice(-120) || 'default';
				await this._contextStore.initialize(id);
				// Hydrate the in-memory index from persisted chunks exactly once.
				// Without this, every restart after the first leaves _invertedIndex
				// empty because indexFile() early-returns for unchanged files.
				if (!this._hydrated) {
					this._hydrated = true;
					await this._rebuildFromStore().catch(() => { /* best-effort — degrade to in-memory */ });
				}
				return true;
			})().catch(() => false);
		}
		return this._storeInit;
	}

	async indexFile(filePath: string, content: string, contentHash: string): Promise<void> {
		// Ensure the persistent store is initialized before any access
		const ok = await this._ensureStore();
		if (!ok) { return; }

		// Check if already indexed with same hash
		const existingHash = await this._contextStore.getFileContentHash(filePath);
		if (existingHash === contentHash) { return; }

		// Remove old entries
		await this.removeFile(filePath);

		// Chunk the content
		const chunks = this._chunkContent(filePath, content, contentHash);

		// Build postings
		for (const chunk of chunks) {
			const terms = chunk.terms;
			this._docLengths.set(chunk.id, terms.length);
			this._totalDocs++;

			const termFreqs = new Map<string, number>();
			for (const term of terms) {
				termFreqs.set(term, (termFreqs.get(term) || 0) + 1);
			}

			for (const [term, freq] of termFreqs) {
				if (!this._invertedIndex.has(term)) {
					this._invertedIndex.set(term, []);
				}
				this._invertedIndex.get(term)!.push({
					chunkId: chunk.id,
					filePath: chunk.filePath,
					tf: freq,
				});
			}
		}

		this._avgDocLength = this._totalDocs > 0
			? [...this._docLengths.values()].reduce((a, b) => a + b, 0) / this._totalDocs
			: 0;

		this._indexedFiles.add(filePath);

		// Persist
		await this._contextStore.putChunks(chunks);
		this._ready = true;
	}

	async removeFile(filePath: string): Promise<void> {
		const ok = await this._ensureStore();
		if (!ok) { return; }

		const existingChunks = await this._contextStore.getChunksByFile(filePath);
		for (const chunk of existingChunks) {
			this._docLengths.delete(chunk.id);
			this._totalDocs = Math.max(0, this._totalDocs - 1);

			// Remove from inverted index
			for (const term of chunk.terms) {
				const postings = this._invertedIndex.get(term);
				if (postings) {
					const idx = postings.findIndex(p => p.chunkId === chunk.id);
					if (idx >= 0) { postings.splice(idx, 1); }
					if (postings.length === 0) { this._invertedIndex.delete(term); }
				}
			}
		}

		this._indexedFiles.delete(filePath);
		await this._contextStore.deleteChunksByFile(filePath);
	}

	async search(query: string, maxResults: number = 20): Promise<IBM25Result[]> {
		const ok = await this._ensureStore();
		if (!ok) { return []; }

		const queryTerms = this._tokenize(query);
		const scores = new Map<string, { score: number; filePath: string }>();

		for (const term of queryTerms) {
			const postings = this._invertedIndex.get(term);
			if (!postings) { continue; }

			const df = postings.length;
			const idf = Math.log((this._totalDocs - df + 0.5) / (df + 0.5) + 1);

			for (const posting of postings) {
				const docLen = this._docLengths.get(posting.chunkId) || 1;
				const tfNorm = (posting.tf * (K1 + 1)) /
					(posting.tf + K1 * (1 - B + B * (docLen / (this._avgDocLength || 1))));
				const bm25Score = idf * tfNorm;

				const existing = scores.get(posting.chunkId);
				if (existing) {
					existing.score += bm25Score;
				} else {
					scores.set(posting.chunkId, { score: bm25Score, filePath: posting.filePath });
				}
			}
		}

		// Sort by score, get top results
		const sorted = [...scores.entries()]
			.sort((a, b) => b[1].score - a[1].score)
			.slice(0, maxResults);

		// Fetch chunk content for results
		const results: IBM25Result[] = [];
		for (const [chunkId, { score, filePath }] of sorted) {
			const chunks = await this._contextStore.getChunksByFile(filePath);
			const chunk = chunks.find(c => c.id === chunkId);
			if (chunk) {
				results.push({
					filePath,
					chunkId,
					score,
					content: chunk.content,
					startLine: chunk.startLine,
					endLine: chunk.endLine,
					symbolName: chunk.symbolName,
					sectionTitle: chunk.sectionTitle,
				});
			}
		}

		return results;
	}

	getIndexedFileCount(): number {
		return this._indexedFiles.size;
	}

	async rebuild(): Promise<void> {
		const ok = await this._ensureStore();
		if (!ok) { return; }
		await this._rebuildFromStore();
	}

	/**
	 * The body of rebuild() with the store-readiness check removed.
	 *
	 * _ensureStore() hydrates by calling this, and it must NOT call
	 * _ensureStore() back: the init promise is already assigned but still
	 * pending at that point, so awaiting it would wait on a promise that is
	 * itself waiting on this call — a deadlock that leaves the index empty
	 * and every indexFile() caller hung forever.
	 */
	private async _rebuildFromStore(): Promise<void> {
		this._invertedIndex.clear();
		this._docLengths.clear();
		this._totalDocs = 0;
		this._avgDocLength = 0;
		this._indexedFiles.clear();

		const allChunks = await this._contextStore.getAllChunks();
		for (const chunk of allChunks) {
			this._docLengths.set(chunk.id, chunk.terms.length);
			this._totalDocs++;
			this._indexedFiles.add(chunk.filePath);

			const termFreqs = new Map<string, number>();
			for (const term of chunk.terms) {
				termFreqs.set(term, (termFreqs.get(term) || 0) + 1);
			}

			for (const [term, freq] of termFreqs) {
				if (!this._invertedIndex.has(term)) {
					this._invertedIndex.set(term, []);
				}
				this._invertedIndex.get(term)!.push({
					chunkId: chunk.id,
					filePath: chunk.filePath,
					tf: freq,
				});
			}
		}

		this._avgDocLength = this._totalDocs > 0
			? [...this._docLengths.values()].reduce((a, b) => a + b, 0) / this._totalDocs
			: 0;

		this._ready = true;
	}

	// B3 docs citation: the section heading carried by one line — markdown
	// `#…` headings and html <h1..6> tags. Document types only; plain
	// text/code lines carry none.
	private static _headingOf(filePath: string, line: string): string | undefined {
		if (!/\.(md|mdx|html?|htm)$/i.test(filePath)) { return undefined; }
		const md = /^#{1,6}\s+(.{1,120})/.exec(line);
		if (md) { return md[1].trim(); }
		const html = /<h[1-6][^>]*>\s*([^<]{1,120}?)\s*<\/h[1-6]>/i.exec(line);
		if (html) { return html[1].trim(); }
		return undefined;
	}

	private _chunkContent(filePath: string, content: string, contentHash: string): IStoredChunk[] {
		const lines = content.split('\n');
		const chunks: IStoredChunk[] = [];
		const CHUNK_SIZE = 50; // lines per chunk

		// B3: documents chunk at HEADING boundaries so a citation names the
		// exact section (a heading line starts a new chunk); long sections
		// still split at CHUNK_SIZE. Other files keep the fixed-size window.
		const isDocFile = /\.(md|mdx|html?|htm)$/i.test(filePath);
		let chunkStart = 0;
		while (chunkStart < lines.length) {
			let end: number;
			if (isDocFile) {
				end = chunkStart + 1;
				while (end < lines.length
					&& end - chunkStart < CHUNK_SIZE
					&& WorkspaceBM25Service._headingOf(filePath, lines[end]) === undefined) {
					end++;
				}
			} else {
				end = Math.min(chunkStart + CHUNK_SIZE, lines.length);
			}

			const i = chunkStart;
			const chunkLines = lines.slice(i, end);
			const chunkContent = chunkLines.join('\n');
			// the section title in effect at the chunk's FIRST line
			let sectionTitle: string | undefined;
			for (let h = i; h >= 0; h--) {
				sectionTitle = WorkspaceBM25Service._headingOf(filePath, lines[h]);
				if (sectionTitle !== undefined) { break; }
			}
			// the section title participates in matching: a query about the
			// section topic must hit even when the body wording differs
			const terms = sectionTitle !== undefined
				? [...this._tokenize(sectionTitle), ...this._tokenize(chunkContent)]
				: this._tokenize(chunkContent);

			chunks.push({
				id: `${filePath}:${i}`,
				filePath,
				contentHash,
				content: chunkContent,
				startLine: i + 1,
				endLine: end,
				sectionTitle,
				terms,
				updatedAt: Date.now(),
			});
			chunkStart = end;
		}

		return chunks;
	}

	private _tokenize(text: string): string[] {
		return text
			.toLowerCase()
			.replace(/[^a-z0-9_]/g, ' ')
			.split(/\s+/)
			.filter(t => t.length > 1 && t.length < 50);
	}
}

registerSingleton(IWorkspaceBM25Service, WorkspaceBM25Service, InstantiationType.Delayed);
