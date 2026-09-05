/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Agent Memory Service — persistent cross-session memory for the NI agent.
 *
 *  Stores observations, learned patterns, and project-specific context that
 *  persists across IDE restarts. Scoped per workspace.
 *
 *  Recall is hybrid: semantic (cosine over entry embeddings, when an embedding
 *  provider has been registered) fused with lexical term match, recency, and
 *  access frequency. Without an embedding provider everything degrades
 *  gracefully to the original lexical scoring — never errors, never blocks.
 *---------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type MemoryEntryType = 'pattern' | 'preference' | 'project-fact' | 'error-fix' | 'tool-usage' | 'file-context';

export interface IAgentMemoryEntry {
	id: string;
	type: MemoryEntryType;
	content: string;
	/** Relevance score — decays over time, boosted on access */
	relevance: number;
	createdAt: number;
	lastAccessedAt: number;
	accessCount: number;
	tags: string[];
	/** Optional embedding vector for semantic recall (absent on legacy entries or when no provider is set) */
	embedding?: number[];
	/** Whether the memory was added by the user or learned automatically by the agent */
	source?: 'manual' | 'auto';
	/** Pinned memories are never evicted */
	pinned?: boolean;
}

/** Single recall result with the reasons it matched (for debugging / context injection) */
export interface IAgentMemoryRecallResult {
	entry: IAgentMemoryEntry;
	reasons: string[];
}

/** Embeds text into a vector; resolves null when it cannot (no provider configured, network failure, …) */
export type EmbeddingProviderFn = (text: string) => Promise<number[] | null>;

export interface IAgentMemoryService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeMemory: Event<void>;

	/** Store a new memory */
	remember(type: MemoryEntryType, content: string, tags?: string[], source?: 'manual' | 'auto'): IAgentMemoryEntry;

	/** Recall memories relevant to a query (hybrid: vector + term match + recency + access frequency) */
	recall(query: string, maxResults?: number): Promise<IAgentMemoryEntry[]>;

	/** Like recall(), but each result also carries why it matched (e.g. 'vector:0.82', 'term:pnpm', 'recent') */
	recallWithReasons(query: string, maxResults?: number): Promise<IAgentMemoryRecallResult[]>;

	/** Keep a memory forever — pinned entries are never evicted */
	pin(id: string): void;

	/** Make a pinned memory evictable again */
	unpin(id: string): void;

	/**
	 * Register (or clear, with null) the embedding provider used for semantic recall.
	 * Optional — while unset, recall and context summaries stay purely lexical.
	 */
	setEmbeddingProvider(fn: EmbeddingProviderFn | null): void;

	/** Boost relevance of a memory (when it proved useful) */
	reinforce(id: string): void;

	/** Remove a specific memory */
	forget(id: string): void;

	/** Get all memories of a given type */
	getByType(type: MemoryEntryType): IAgentMemoryEntry[];

	/** Get compressed context string for injection into agent prompt */
	getContextSummary(maxTokens?: number): string;

	/** Total stored memories */
	readonly count: number;
}

export const IAgentMemoryService = createDecorator<IAgentMemoryService>('agentMemoryService');

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = 'ni.agent.memory';
const MAX_MEMORIES = 2000;
const DECAY_RATE = 0.995; // per-day relevance decay
const DAY_MS = 86_400_000;
const PERSIST_DEBOUNCE_MS = 1000;

// ─── Pure scoring functions (exported for tests) ─────────────────────────────

/** Weighting scheme applied to the recall factors */
export type FuseMode =
	| 'hybrid'           // query + entry both embedded: 0.5·cosine + 0.2·term + 0.2·recency + 0.1·frequency
	| 'lexical-promoted' // query embedded but this entry has no vector: 0.7·term + 0.2·recency + 0.1·frequency
	| 'lexical';         // no embeddings involved: exactly the original term-match scoring

/** Recall factors, each normalized to 0..1 (cosine is null when not comparable) */
export interface IFuseFactors {
	/** Cosine similarity between query and entry embeddings, or null when unavailable */
	cosine: number | null;
	/** Fraction of query terms matched by the entry (content + tags) */
	term: number;
	/** Time decay of last access (DECAY_RATE per day, 1 = just accessed) */
	recency: number;
	/** Access frequency, saturating at 10 accesses */
	frequency: number;
	/** Stored relevance of the entry (base weight in lexical mode) */
	relevance: number;
}

export function fuseScores(factors: IFuseFactors, mode: FuseMode): number {
	const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
	const term = clamp01(factors.term);
	const recency = clamp01(factors.recency);
	const frequency = clamp01(factors.frequency);
	const relevance = clamp01(factors.relevance);
	const cosine = factors.cosine === null ? 0 : clamp01(factors.cosine);

	switch (mode) {
		case 'hybrid':
			return 0.5 * cosine + 0.2 * term + 0.2 * recency + 0.1 * frequency;
		case 'lexical-promoted':
			return 0.7 * term + 0.2 * recency + 0.1 * frequency;
		case 'lexical':
			return 0.5 * term + 0.25 * recency + 0.15 * frequency + 0.1 * relevance;
	}
}

/** Cosine similarity between two raw vectors (unit-normalized internally). 0 for empty or length-mismatched vectors. */
export function scoreCosine(a: number[], b: number[]): number {
	if (a.length === 0 || a.length !== b.length) { return 0; }
	let dot = 0, normA = 0, normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom > 0 ? dot / denom : 0;
}

/** Term overlap between tokenized query and entry terms: matched fraction plus which terms matched */
export function computeTermOverlap(queryTerms: string[], entryTerms: ReadonlySet<string>): { score: number; matched: string[] } {
	if (queryTerms.length === 0) { return { score: 0, matched: [] }; }
	const matched: string[] = [];
	for (const term of queryTerms) {
		if (entryTerms.has(term)) { matched.push(term); }
	}
	return { score: matched.length / queryTerms.length, matched };
}

/** Compact human-readable reasons a memory matched, e.g. ['vector:0.82', 'term:pnpm', 'recent'] */
export function buildMatchReasons(cosine: number | null, matchedTerms: string[], daysSinceAccess: number, accessCount: number): string[] {
	const reasons: string[] = [];
	if (cosine !== null && cosine > 0.05) { reasons.push(`vector:${cosine.toFixed(2)}`); }
	if (matchedTerms.length > 0) {
		const unique = [...new Set(matchedTerms)];
		reasons.push(`term:${unique.slice(0, 3).join(',')}`);
	}
	if (daysSinceAccess <= 7) { reasons.push('recent'); }
	if (accessCount >= 3) { reasons.push('frequent'); }
	return reasons;
}

/** Long-term importance used for eviction: relevance decayed by recency plus access frequency */
export function fusedImportance(entry: IAgentMemoryEntry, now: number): number {
	const daysSinceAccess = (now - entry.lastAccessedAt) / DAY_MS;
	const recency = Math.pow(DECAY_RATE, daysSinceAccess);
	const frequency = Math.min(entry.accessCount / 10, 1);
	return 0.7 * entry.relevance * recency + 0.3 * frequency;
}

/** Entries to evict when over capacity: lowest fused-importance first; pinned entries always survive */
export function selectEvictionCandidates(entries: IAgentMemoryEntry[], max: number, now: number): IAgentMemoryEntry[] {
	const excess = entries.length - max;
	if (excess <= 0) { return []; }
	return entries
		.filter(e => !e.pinned)
		.sort((a, b) => fusedImportance(a, now) - fusedImportance(b, now))
		.slice(0, excess);
}

// ─── Implementation ──────────────────────────────────────────────────────────

class AgentMemoryService extends Disposable implements IAgentMemoryService {
	readonly _serviceBrand: undefined;

	private _entries: Map<string, IAgentMemoryEntry> = new Map();
	private _dirty = false;
	private _embeddingProvider: EmbeddingProviderFn | undefined;
	private _persistTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly _onDidChangeMemory = this._register(new Emitter<void>());
	readonly onDidChangeMemory: Event<void> = this._onDidChangeMemory.event;

	get count(): number { return this._entries.size; }

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();
		this._load();
		this._register(this._storageService.onWillSaveState(() => this._persist()));
	}

	setEmbeddingProvider(fn: EmbeddingProviderFn | null): void {
		this._embeddingProvider = fn ?? undefined;
	}

	remember(type: MemoryEntryType, content: string, tags?: string[], source: 'manual' | 'auto' = 'auto'): IAgentMemoryEntry {
		// Deduplicate by content hash
		for (const entry of this._entries.values()) {
			if (entry.content === content) {
				entry.lastAccessedAt = Date.now();
				entry.accessCount++;
				entry.relevance = Math.min(1, entry.relevance + 0.1);
				this._emitChange();
				return entry;
			}
		}

		const entry: IAgentMemoryEntry = {
			id: this._generateId(),
			type,
			content,
			relevance: 1.0,
			createdAt: Date.now(),
			lastAccessedAt: Date.now(),
			accessCount: 0,
			tags: tags || [],
			source,
		};

		this._entries.set(entry.id, entry);
		this._embedInBackground(entry); // fire-and-forget — failure leaves the entry usable
		this._evictIfNeeded();
		this._emitChange();
		return entry;
	}

	async recall(query: string, maxResults: number = 10): Promise<IAgentMemoryEntry[]> {
		const results = await this.recallWithReasons(query, maxResults);
		return results.map(r => r.entry);
	}

	async recallWithReasons(query: string, maxResults: number = 10): Promise<IAgentMemoryRecallResult[]> {
		const queryTerms = this._tokenize(query);
		const queryVector = await this._embedQuery(query); // null when no provider / failure — silent degrade
		const hybrid = queryVector !== null && this._anyEmbedded();

		const now = Date.now();
		const scored: { entry: IAgentMemoryEntry; score: number; reasons: string[] }[] = [];
		for (const entry of this._entries.values()) {
			const entryTerms = new Set([...this._tokenize(entry.content), ...entry.tags]);
			const { score: termScore, matched } = computeTermOverlap(queryTerms, entryTerms);
			const daysSinceAccess = (now - entry.lastAccessedAt) / DAY_MS;
			const cosine = (queryVector && entry.embedding && entry.embedding.length > 0)
				? scoreCosine(queryVector, entry.embedding)
				: null;
			const mode: FuseMode = !hybrid ? 'lexical' : (cosine !== null ? 'hybrid' : 'lexical-promoted');

			const score = fuseScores({
				cosine,
				term: termScore,
				recency: Math.pow(DECAY_RATE, daysSinceAccess),
				frequency: Math.min(entry.accessCount / 10, 1),
				relevance: entry.relevance,
			}, mode);

			if (score <= 0.05) { continue; }
			scored.push({ entry, score, reasons: buildMatchReasons(cosine, matched, daysSinceAccess, entry.accessCount) });
		}

		scored.sort((a, b) => b.score - a.score);
		const results = scored.slice(0, maxResults);

		// Boost accessed entries
		for (const { entry } of results) {
			entry.lastAccessedAt = now;
			entry.accessCount++;
		}
		if (results.length > 0) { this._schedulePersist(); }

		return results.map(({ entry, reasons }) => ({ entry, reasons }));
	}

	pin(id: string): void {
		const entry = this._entries.get(id);
		if (!entry || entry.pinned) { return; }
		entry.pinned = true;
		this._emitChange();
	}

	unpin(id: string): void {
		const entry = this._entries.get(id);
		if (!entry || !entry.pinned) { return; }
		entry.pinned = false;
		this._emitChange();
	}

	reinforce(id: string): void {
		const entry = this._entries.get(id);
		if (!entry) return;
		entry.relevance = Math.min(1, entry.relevance + 0.15);
		entry.lastAccessedAt = Date.now();
		entry.accessCount++;
		this._emitChange();
	}

	forget(id: string): void {
		if (this._entries.delete(id)) {
			this._emitChange();
		}
	}

	getByType(type: MemoryEntryType): IAgentMemoryEntry[] {
		const results: IAgentMemoryEntry[] = [];
		for (const entry of this._entries.values()) {
			if (entry.type === type) results.push(entry);
		}
		return results.sort((a, b) => b.relevance - a.relevance);
	}

	getContextSummary(maxTokens: number = 2000): string {
		// Top memories by fused importance, packed under a token budget.
		// Each line carries its top match reason for debuggability.
		const now = Date.now();
		const ranked = Array.from(this._entries.values())
			.map(entry => {
				const daysSinceAccess = (now - entry.lastAccessedAt) / DAY_MS;
				const score = fuseScores({
					cosine: null,
					term: 0,
					recency: Math.pow(DECAY_RATE, daysSinceAccess),
					frequency: Math.min(entry.accessCount / 10, 1),
					relevance: entry.relevance,
				}, 'lexical');
				return { entry, score, reasons: buildMatchReasons(null, [], daysSinceAccess, entry.accessCount) };
			})
			.sort((a, b) => b.score - a.score);

		const lines: string[] = [];
		let tokens = 0;
		for (const { entry, reasons } of ranked) {
			const suffix = reasons.length > 0 ? ` (matched: ${reasons[0]})` : '';
			const line = `[${entry.type}] ${entry.content}${suffix}`;
			const lineTokens = Math.ceil(line.length / 4);
			if (tokens + lineTokens > maxTokens) break;
			lines.push(line);
			tokens += lineTokens;
		}

		return lines.length > 0 ? `Agent Memory (${lines.length} entries):\n${lines.join('\n')}` : '';
	}

	public override dispose(): void {
		if (this._persistTimer !== undefined) {
			clearTimeout(this._persistTimer);
			this._persistTimer = undefined;
		}
		if (this._dirty) { this._persist(); }
		super.dispose();
	}

	// ─── Private ─────────────────────────────────────────────────────────────

	private _load(): void {
		try {
			const raw = this._storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
			if (raw) {
				const parsed: IAgentMemoryEntry[] = JSON.parse(raw);
				for (const entry of parsed) {
					if (!entry || typeof entry.id !== 'string') continue;
					if (!Array.isArray(entry.embedding)) { delete entry.embedding; } // tolerate legacy/corrupt vectors
					this._entries.set(entry.id, entry);
				}
			}
		} catch { /* corrupted — start fresh */ }
	}

	private _persist(): void {
		if (this._persistTimer !== undefined) {
			clearTimeout(this._persistTimer);
			this._persistTimer = undefined;
		}
		if (!this._dirty && this._entries.size === 0) return;
		const arr = Array.from(this._entries.values());
		this._storageService.store(STORAGE_KEY, JSON.stringify(arr), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._dirty = false;
	}

	/** Debounced persist so a crash doesn't lose recent mutations */
	private _schedulePersist(): void {
		this._dirty = true;
		if (this._persistTimer !== undefined) { clearTimeout(this._persistTimer); }
		this._persistTimer = setTimeout(() => {
			this._persistTimer = undefined;
			this._persist();
		}, PERSIST_DEBOUNCE_MS);
	}

	private _evictIfNeeded(): void {
		if (this._entries.size <= MAX_MEMORIES) return;
		const all = Array.from(this._entries.values());
		for (const victim of selectEvictionCandidates(all, MAX_MEMORIES, Date.now())) {
			this._entries.delete(victim.id);
		}
	}

	private _anyEmbedded(): boolean {
		for (const entry of this._entries.values()) {
			if (entry.embedding && entry.embedding.length > 0) { return true; }
		}
		return false;
	}

	private async _embedQuery(query: string): Promise<number[] | null> {
		const provider = this._embeddingProvider;
		if (!provider) { return null; }
		try {
			const vector = await provider(query);
			return (Array.isArray(vector) && vector.length > 0) ? vector : null;
		} catch {
			return null; // degrade silently to lexical scoring
		}
	}

	/** Fire-and-forget embedding of a stored entry; any failure simply leaves the entry without a vector */
	private _embedInBackground(entry: IAgentMemoryEntry): void {
		const provider = this._embeddingProvider;
		if (!provider || entry.embedding) { return; }
		try {
			provider(entry.content)
				.then(vector => {
					if (!Array.isArray(vector) || vector.length === 0) { return; }
					if (this._entries.get(entry.id) !== entry) { return; } // removed/evicted meanwhile
					entry.embedding = vector;
					this._schedulePersist();
				})
				.catch(() => { /* embedding failed — entry stays usable */ });
		} catch {
			// synchronous provider failure — ignore
		}
	}

	private _emitChange(): void {
		this._schedulePersist();
		this._onDidChangeMemory.fire();
	}

	private _tokenize(text: string): string[] {
		return text.toLowerCase().split(/[\s\-_./\\]+/).filter(t => t.length > 2);
	}

	private _generateId(): string {
		return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	}
}

registerSingleton(IAgentMemoryService, AgentMemoryService, InstantiationType.Delayed);
