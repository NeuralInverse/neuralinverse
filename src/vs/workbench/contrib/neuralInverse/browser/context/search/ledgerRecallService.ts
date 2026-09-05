/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Ledger Recall Service — searchable index + ranked recall over the context ledger (L3).
 *--------------------------------------------------------------------------------------*/

/**
 * # Context Ledger — recall layer (task M5, phase 3)
 *
 * Indexes journal entries and frozen episode summaries into the persistent
 * context store (IndexedDB v2 stores `ledger-entries` / `ledger-episodes`) and
 * serves the two recall primitives:
 *
 *   recall()  — term search over both stores, ranked by
 *               0.45·term + 0.25·cosine + 0.15·recency + 0.15·pathOverlap
 *   expand()  — verbatim seq ranges from the journal, middle-truncated to a
 *               token budget so both ends of the window survive
 *
 * ## Degradation (D6)
 *
 * The cosine slot is *reserved*: embeddings are not wired into recall yet, so
 * every candidate scores cosine = 0 and the weight set redistributes onto
 * term/recency/pathOverlap (0.70 / 0.20 / 0.10 — both sets sum to 1). The same
 * applies to pathOverlap until the assembler passes the active file context
 * in. No error, no silent zero-column: the ranking function honors whatever
 * weights it is given, and switching to the full set is a one-line change.
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IPersistentContextStore, IStoredLedgerEntry, IStoredLedgerEpisode } from './persistentStore.js';
import { ILedgerEntry, IEpisodeSummary } from '../../../../void/common/ledgerTypes.js';
import { renderEntryLine } from '../../../../void/common/ledgerJournalCore.js';
import { IContextLedgerService } from '../../../../void/browser/contextLedgerService.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_TERM_LENGTH = 2;
const MAX_INDEX_TERMS = 40;
const SNIPPET_MAX_CHARS = 240;
const EPISODE_BODY_MAX_CHARS = 4000;
/** chars-per-token budget for expand() (matches the ledger's cheap estimate) */
const CHARS_PER_TOKEN = 4;
const DEFAULT_RECALL_LIMIT = 20;
const MS_PER_DAY = 86_400_000;
/** recency half-life factor: 0.995^days */
const RECENCY_DECAY_PER_DAY = 0.995;

// ─── Tokenizer ────────────────────────────────────────────────────────────────

/** Latin alphanumerics plus the Arabic/Persian block survive; everything else is a separator. */
const TERM_RE = /[a-z0-9\u0600-\u06FF]+/g;

/**
 * Tokenize text into lowercase search terms: split on non-alphanumeric
 * characters (Persian letters included), drop terms shorter than 2 chars,
 * dedupe, cap at MAX_INDEX_TERMS.
 */
export function tokenize(text: string): string[] {
	const raw = text.toLowerCase().match(TERM_RE) ?? [];
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const term of raw) {
		if (term.length < MIN_TERM_LENGTH || seen.has(term)) { continue; }
		seen.add(term);
		terms.push(term);
		if (terms.length >= MAX_INDEX_TERMS) { break; }
	}
	return terms;
}

// ─── Record builders (pure) ───────────────────────────────────────────────────

/** Build the searchable index record for one journal entry. */
export function buildLedgerEntryRecord(threadId: string, entry: ILedgerEntry): IStoredLedgerEntry {
	return {
		id: `${threadId}:${entry.seq}`,
		threadId,
		seq: entry.seq,
		role: entry.role,
		...(entry.name !== undefined ? { name: entry.name } : {}),
		ts: entry.ts,
		tokens: entry.tokens,
		terms: tokenize(entry.content),
		snippet: entry.content.slice(0, SNIPPET_MAX_CHARS),
	};
}

/**
 * Build the searchable index record for one frozen episode. Terms are drawn
 * from the highest-signal fields — goal, invariants, rejected approaches and
 * decisions — so a query about a dead end surfaces the episode that recorded
 * it; the compact JSON body is capped at EPISODE_BODY_MAX_CHARS.
 */
export function buildLedgerEpisodeRecord(threadId: string, ep: IEpisodeSummary): IStoredLedgerEpisode {
	const searchable = [
		ep.body.goal,
		...ep.body.invariants,
		...ep.body.rejected.map(r => r.approach),
		...ep.body.decisions.map(d => d.what),
	];
	return {
		id: `${threadId}:${ep.ordinal}`,
		threadId,
		ordinal: ep.ordinal,
		fromSeq: ep.range.fromSeq,
		toSeq: ep.range.toSeq,
		ts: ep.createdAt,
		terms: tokenize(searchable.join('\n')),
		body: JSON.stringify(ep.body).slice(0, EPISODE_BODY_MAX_CHARS),
	};
}

// ─── Ranking (pure) ───────────────────────────────────────────────────────────

export interface ILedgerRecallWeights {
	term: number;
	/** reserved for the embedding cosine rerank (phase 3, part B) */
	embedding: number;
	recency: number;
	pathOverlap: number;
}

/** Full ranking: 0.45 term + 0.25 cosine + 0.15 recency + 0.15 path overlap. */
export const RECALL_WEIGHTS_WITH_EMBEDDINGS: ILedgerRecallWeights = {
	term: 0.45,
	embedding: 0.25,
	recency: 0.15,
	pathOverlap: 0.15,
};

/**
 * Degraded ranking (D6): no embeddings exist, so the reserved cosine weight is
 * redistributed onto term/recency/pathOverlap. Both weight sets sum to 1.
 */
export const RECALL_WEIGHTS_NO_EMBEDDINGS: ILedgerRecallWeights = {
	term: 0.70,
	embedding: 0,
	recency: 0.20,
	pathOverlap: 0.10,
};

export interface ILedgerRecallCandidate {
	/** kind-prefixed dedupe key: `entry:<id>` / `episode:<id>` */
	id: string;
	kind: 'entry' | 'episode';
	/** 0-1 share of the query terms this candidate matched */
	termScore: number;
	/** 0-1 cosine similarity; 0 until embeddings are wired (reserved slot) */
	cosine: number;
	/** epoch ms of the underlying entry/episode */
	ts: number;
	/** 0-1 overlap with the active file context; 0 until the assembler passes it in */
	pathOverlap: number;
	/** matched query terms — surfaced as `why` on results */
	why: string[];
}

export interface IScoredLedgerRecallCandidate extends ILedgerRecallCandidate {
	score: number;
}

/**
 * Pure ranking: score = w.term·termScore + w.embedding·cosine +
 * w.recency·(0.995^days) + w.pathOverlap·pathOverlap, sorted score desc with
 * ts desc and id asc tiebreaks. Candidates with the same id are deduped (first
 * occurrence wins). `now` is a parameter so the function stays deterministic
 * and unit-testable.
 */
export function scoreRecallCandidates(candidates: ILedgerRecallCandidate[], weights: ILedgerRecallWeights, now: number): IScoredLedgerRecallCandidate[] {
	const byId = new Map<string, ILedgerRecallCandidate>();
	for (const candidate of candidates) {
		if (!byId.has(candidate.id)) { byId.set(candidate.id, candidate); }
	}

	const scored: IScoredLedgerRecallCandidate[] = [];
	for (const candidate of byId.values()) {
		const days = Math.max(0, (now - candidate.ts) / MS_PER_DAY);
		const recency = Math.pow(RECENCY_DECAY_PER_DAY, days);
		const score = weights.term * candidate.termScore
			+ weights.embedding * candidate.cosine
			+ weights.recency * recency
			+ weights.pathOverlap * candidate.pathOverlap;
		scored.push({ ...candidate, score });
	}

	scored.sort((a, b) => b.score - a.score || b.ts - a.ts || (a.id < b.id ? -1 : 1));
	return scored;
}

// ─── Window rendering (pure) ──────────────────────────────────────────────────

function truncationMarker(fromSeq: number, toSeq: number): string {
	return `…[recall window truncated between seq ${fromSeq} and ${toSeq}]…`;
}

/**
 * Render a seq range as transcript lines within a character budget of
 * `maxTokens · CHARS_PER_TOKEN`. Overflow is cut from the middle so both ends
 * of the conversation survive, with a marker naming the dropped seq window.
 */
export function renderRecallWindow(entries: ILedgerEntry[], maxTokens: number): ILedgerExpandResult {
	if (entries.length === 0) { return { text: '', truncated: false }; }
	const lines = entries.map(e => renderEntryLine(e));
	const text = lines.join('\n');
	const maxChars = Math.max(0, maxTokens * CHARS_PER_TOKEN);
	if (text.length <= maxChars) { return { text, truncated: false }; }

	const budget = Math.max(0, maxChars - truncationMarker(0, 0).length - 2);
	const headBudget = Math.floor(budget / 2);
	const tailBudget = budget - headBudget;

	// walk entry boundaries from both ends while they fit in their half
	let headLen = 0;
	let headEnd = -1;
	for (let i = 0; i < lines.length; i++) {
		if (headLen + lines[i].length + 1 > headBudget) { break; }
		headLen += lines[i].length + 1;
		headEnd = i;
	}
	let tailLen = 0;
	let tailStart = lines.length;
	for (let i = lines.length - 1; i > headEnd; i--) {
		if (tailLen + lines[i].length + 1 > tailBudget) { break; }
		tailLen += lines[i].length + 1;
		tailStart = i;
	}

	if (headEnd === -1 && tailStart === lines.length) {
		// a single giant entry dominates the window — cut by characters
		const head = text.slice(0, headBudget);
		const tail = text.slice(Math.max(headBudget, text.length - tailBudget));
		return {
			text: head + '\n' + truncationMarker(entries[0].seq, entries[entries.length - 1].seq) + '\n' + tail,
			truncated: true,
		};
	}

	const head = lines.slice(0, headEnd + 1).join('\n');
	const tail = lines.slice(tailStart).join('\n');
	return {
		text: head + '\n' + truncationMarker(entries[headEnd + 1].seq, entries[tailStart - 1].seq) + '\n' + tail,
		truncated: true,
	};
}

// ─── Service contract ─────────────────────────────────────────────────────────

export interface ILedgerRecallQuery {
	query: string;
	/** 'current' restricts results to currentThreadId (default 'all') */
	threadScope?: 'current' | 'all';
	currentThreadId?: string;
	limit?: number;
}

export interface ILedgerRecallResult {
	kind: 'entry' | 'episode';
	threadId: string;
	/** [fromSeq, toSeq] — a single entry carries seq twice */
	seqRange: [number, number];
	ts: number;
	snippet: string;
	score: number;
	/** matched query terms */
	why: string[];
}

export interface ILedgerExpandResult {
	text: string;
	/** true when the seq window exceeded the budget and was middle-truncated */
	truncated: boolean;
}

export interface ILedgerExpandRequest {
	threadId: string;
	fromSeq: number;
	toSeq: number;
	maxTokens: number;
}

export interface ILedgerRecallService {
	readonly _serviceBrand: undefined;

	indexEntry(threadId: string, entry: ILedgerEntry): Promise<void>;
	indexEpisode(threadId: string, ep: IEpisodeSummary): Promise<void>;
	recall(request: ILedgerRecallQuery): Promise<ILedgerRecallResult[]>;
	expand(request: ILedgerExpandRequest): Promise<ILedgerExpandResult>;
}

export const ILedgerRecallService = createDecorator<ILedgerRecallService>('ledgerRecallService');

// ─── Implementation ───────────────────────────────────────────────────────────

class LedgerRecallService extends Disposable implements ILedgerRecallService {
	readonly _serviceBrand: undefined;

	/**
	 * Nothing else in the codebase initializes the persistent store today (the
	 * search indexers were left dormant), so the recall service owns the lazy
	 * init: one attempt per workspace, keyed by the sanitized workspace URI.
	 * A failed/absent init degrades indexing and recall to no-ops — never an
	 * error for the chat path.
	 */
	private _storeInit: Promise<boolean> | undefined;

	constructor(
		@IPersistentContextStore private readonly _contextStore: IPersistentContextStore,
		@IContextLedgerService private readonly _ledger: IContextLedgerService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	private _ensureStore(): Promise<boolean> {
		if (!this._storeInit) {
			this._storeInit = (async () => {
				const ws = this._workspaceContextService.getWorkspace().folders[0]?.uri;
				if (!ws) return false;
				const id = ws.toString().replace(/[^a-zA-Z0-9]/g, '_').slice(-120) || 'default';
				await this._contextStore.initialize(id);
				return true;
			})().catch(() => false);
		}
		return this._storeInit;
	}

	async indexEntry(threadId: string, entry: ILedgerEntry): Promise<void> {
		if (!await this._ensureStore()) return;
		await this._contextStore.putLedgerEntries([buildLedgerEntryRecord(threadId, entry)]);
	}

	async indexEpisode(threadId: string, ep: IEpisodeSummary): Promise<void> {
		if (!await this._ensureStore()) return;
		await this._contextStore.putLedgerEpisodes([buildLedgerEpisodeRecord(threadId, ep)]);
	}

	async recall(request: ILedgerRecallQuery): Promise<ILedgerRecallResult[]> {
		const limit = request.limit ?? DEFAULT_RECALL_LIMIT;
		const queryTerms = tokenize(request.query);
		if (queryTerms.length === 0) { return []; }
		if (request.threadScope === 'current' && !request.currentThreadId) { return []; }
		if (!await this._ensureStore()) { return []; }

		const [entryMatches, episodeMatches] = await Promise.all([
			this._contextStore.searchLedgerEntriesByTerms(queryTerms, limit * 2),
			this._contextStore.searchLedgerEpisodesByTerms(queryTerms, limit * 2),
		]);

		const records = new Map<string, IStoredLedgerEntry | IStoredLedgerEpisode>();
		const candidates: ILedgerRecallCandidate[] = [];

		for (const entry of entryMatches) {
			if (request.threadScope === 'current' && entry.threadId !== request.currentThreadId) { continue; }
			const why = queryTerms.filter(t => entry.terms.includes(t));
			if (why.length === 0) { continue; }
			const id = `entry:${entry.id}`;
			records.set(id, entry);
			candidates.push({
				id,
				kind: 'entry',
				termScore: why.length / queryTerms.length,
				cosine: 0,
				ts: entry.ts,
				pathOverlap: 0,
				why,
			});
		}
		for (const ep of episodeMatches) {
			if (request.threadScope === 'current' && ep.threadId !== request.currentThreadId) { continue; }
			const why = queryTerms.filter(t => ep.terms.includes(t));
			if (why.length === 0) { continue; }
			const id = `episode:${ep.id}`;
			records.set(id, ep);
			candidates.push({
				id,
				kind: 'episode',
				termScore: why.length / queryTerms.length,
				cosine: 0,
				ts: ep.ts,
				pathOverlap: 0,
				why,
			});
		}

		// D6: embeddings (and the assembler's file context) are not wired into
		// recall yet — cosine and pathOverlap are reserved slots scoring 0, so
		// the degraded weight set keeps the total weight at 1 (see header).
		const scored = scoreRecallCandidates(candidates, RECALL_WEIGHTS_NO_EMBEDDINGS, Date.now());

		const results: ILedgerRecallResult[] = [];
		for (const candidate of scored.slice(0, limit)) {
			if (candidate.kind === 'entry') {
				const entry = records.get(candidate.id) as IStoredLedgerEntry;
				results.push({
					kind: 'entry',
					threadId: entry.threadId,
					seqRange: [entry.seq, entry.seq],
					ts: entry.ts,
					snippet: entry.snippet,
					score: candidate.score,
					why: candidate.why,
				});
			} else {
				const ep = records.get(candidate.id) as IStoredLedgerEpisode;
				results.push({
					kind: 'episode',
					threadId: ep.threadId,
					seqRange: [ep.fromSeq, ep.toSeq],
					ts: ep.ts,
					snippet: ep.body.slice(0, SNIPPET_MAX_CHARS),
					score: candidate.score,
					why: candidate.why,
				});
			}
		}
		return results;
	}

	async expand(request: ILedgerExpandRequest): Promise<ILedgerExpandResult> {
		const entries = await this._ledger.readRange(request.threadId, request.fromSeq, request.toSeq);
		return renderRecallWindow(entries, request.maxTokens);
	}
}

registerSingleton(ILedgerRecallService, LedgerRecallService, InstantiationType.Delayed);
