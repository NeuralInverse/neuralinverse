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
 * ## Semantic rerank (B2, 2026-09-15)
 *
 * The cosine slot is now WIRED: a bounded background queue embeds every indexed
 * entry/episode through IEmbeddingService (vectors persisted with the model
 * identity), recall embeds the query and ranks with the full weight set
 * (0.45 / 0.25 / 0.15 / 0.15). Records stamped with a DIFFERENT embedding
 * model score cosine 0 and are re-embedded lazily — a model switch invalidates
 * without a full rebuild. Without a configured embedding provider everything
 * degrades to the lexical-only weight set (0.70 / 0.20 / 0.10), exactly the
 * previous behavior. pathOverlap stays 0 until the assembler passes the active
 * file context in (D6 remainder).
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../../base/common/event.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IPersistentContextStore, IStoredLedgerEntry, IStoredLedgerEpisode, IEmbeddedLedgerRecordRef } from './persistentStore.js';
import { ILedgerEntry, IEpisodeSummary } from '../../../../void/common/ledgerTypes.js';
import { renderEntryLine } from '../../../../void/common/ledgerJournalCore.js';
import { IContextLedgerService } from '../../../../void/browser/contextLedgerService.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IEmbeddingService } from './embeddingService.js';
import { niTask1Obs, niTask1ObsPush } from '../obs/task1Obs.js';

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
/** B2 embed queue: bounded, low-priority background work — never blocks chat */
const EMBED_QUEUE_CONCURRENCY = 2;
const EMBED_QUEUE_MAX_PENDING = 500;
const EMBED_TEXT_MAX_CHARS = 4_000;
/** B2 re-embed sweep batch: stale/missing vectors re-enqueued per pass */
const REEMBED_SWEEP_BATCH = 100;
/** B2-L5 (2026-09-18): closed-class function words (EN + minimal FA). A query
 *  that shares ONLY these with a record is not a topical match — measured live
 *  leak: an unrelated marine-biology query admitted a fresh KNOWLEDGE_FACT
 *  record on why=["in","the"] with cosine 0.66 < MIN_SEMANTIC_COSINE 0.72,
 *  because any single term match bypassed the semantic gate. Stop-words still
 *  count toward termScore for ranking once a candidate is admitted. */
const STOP_TERMS: ReadonlySet<string> = new Set([
	// English closed-class
	'the', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'is', 'are', 'was', 'were',
	'be', 'been', 'being', 'am', 'it', 'its', 'this', 'that', 'these', 'those', 'with',
	'as', 'by', 'from', 'about', 'into', 'over', 'under', 'after', 'before', 'between',
	'during', 'through', 'when', 'what', 'where', 'which', 'who', 'whom', 'whose', 'how',
	'why', 'not', 'no', 'nor', 'but', 'so', 'than', 'then', 'too', 'can', 'could',
	'should', 'would', 'will', 'shall', 'may', 'might', 'must', 'do', 'does', 'did',
	'have', 'has', 'had', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him', 'his',
	'she', 'they', 'them', 'their', 'there', 'here', 'if', 'else', 'any', 'some',
	'such', 'up', 'down', 'out', 'off', 'because', 'while', 'until', 'against', 'above',
	'below', 'per', 'via', 'each', 'both',
	// Persian closed-class
	'و', 'در', 'به', 'از', 'که', 'این', 'آن', 'با', 'برای', 'روی', 'تا', 'هم', 'یا',
	'را', 'است', 'هست', 'بود', 'اگر', 'اما',
]);

/** True when the term is a closed-class function word (see STOP_TERMS). */
export function isStopTerm(term: string): boolean {
	return STOP_TERMS.has(term);
}
/** B2 in-memory vector index cap: only the N newest vector-bearing records
 *  are searched semantically — keeps recall bounded on huge archives. */
const VECTOR_INDEX_MAX_RECORDS = 5_000;

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

// ─── Recall tool argument + result helpers (task F02) ─────────────────────────

/**
 * Strict integer argument parsing for the recall tools. The XML tool-call
 * harness coerces every parameter to string, so numeric STRINGS must be
 * accepted ("12" → 12) while anything else is rejected — `parseInt`-style
 * leniency ("12abc" → 12) would silently expand a wrong range. Returns null
 * when the value is not a clean integer.
 */
export function parseStrictInt(value: unknown): number | null {
	if (typeof value === 'number') {
		return Number.isInteger(value) ? value : null;
	}
	if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
		return Number(value);
	}
	return null;
}

/**
 * Render recall results for the tool response. Cross-thread results carry the
 * owning thread id per line (a `scope: all` match is useless to the model if
 * it cannot ask `expand_history` for the right archive); single-thread
 * results omit it as redundant.
 */
export function renderRecallLines(results: ILedgerRecallResult[], opts: { includeThreadId: boolean }): string {
	return results.map(r => {
		const where = opts.includeThreadId ? ` thread=${r.threadId}` : '';
		return `[${r.kind}${where} seq ${r.seqRange[0]}-${r.seqRange[1]}] (score ${r.score.toFixed(2)}, matched: ${r.why.join(', ') || 'n/a'})\n${r.snippet}`;
	}).join('\n---\n');
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
	/**
	 * Index one journal entry. Returns FALSE when the write did not reach the
	 * store (unavailable store or failed put) — the backfill's checkpoint may
	 * only advance past CONFIRMED writes (phase-1 review R3).
	 */
	indexEntry(threadId: string, entry: ILedgerEntry): Promise<boolean>;
	/** See {@link indexEntry}. */
	indexEpisode(threadId: string, ep: IEpisodeSummary): Promise<boolean>;
	/**
	 * Resolves once every index write queued for `threadId` through the event
	 * feed has settled (2s cap so recall never hangs on a slow store).
	 * Recall immediately after an append waits here or it can miss the very
	 * message the user just sent (phase-1 review R3).
	 */
	whenIndexed(threadId: string): Promise<void>;
	recall(request: ILedgerRecallQuery): Promise<ILedgerRecallResult[]>;
	expand(request: ILedgerExpandRequest): Promise<ILedgerExpandResult>;
	/**
	 * B2 live closure: re-enqueue (bounded) records whose persisted vector is
	 * missing or stamped by a different model — the recovery path after an
	 * embedding-model switch or an ingestion outage. Returns how many records
	 * were enqueued. Never throws.
	 */
	reembedStaleVectors(): Promise<number>;
}

export const ILedgerRecallService = createDecorator<ILedgerRecallService>('ledgerRecallService');

// ─── Implementation ───────────────────────────────────────────────────────────

export class LedgerRecallService extends Disposable implements ILedgerRecallService {
	readonly _serviceBrand: undefined;

	/**
	 * Nothing else in the codebase initializes the persistent store today (the
	 * search indexers were left dormant), so the recall service owns the lazy
	 * init: one attempt per workspace, keyed by the sanitized workspace URI.
	 * A failed/absent init degrades indexing and recall to no-ops — never an
	 * error for the chat path.
	 */
	private _storeInit: Promise<boolean> | undefined;

	/**
	 * Per-thread index watermark (review R3): every event-fed write is chained
	 * onto its thread's tail, so `whenIndexed` waits for exactly the writes
	 * that were still pending when the caller asked.
	 */
	private readonly _indexChains = new Map<string, Promise<void>>();

	/** Rate limit for the swallowed-indexing warning — one per thread per minute. */
	private readonly _lastIndexWarn = new Map<string, number>();

	// ── B2 semantic rerank ──
	private readonly _embedding: IEmbeddingService | undefined;
	/** bounded background embed queue (entries + episodes) */
	private readonly _embedPending: Array<{ kind: 'entry' | 'episode'; threadId: string; key: string; text: string; seqRange: [number, number]; ts: number }> = [];
	private _embedActive = 0;
	private readonly _embedInFlight = new Set<string>(); // dedupe by kind:id
	/** B2 in-memory vector index (kind:id → ref); loaded lazily, capped */
	private readonly _vectorIndex = new Map<string, IEmbeddedLedgerRecordRef>();
	private _vectorIndexLoaded = false;

	constructor(
		@IPersistentContextStore private readonly _contextStore: IPersistentContextStore,
		@IContextLedgerService private readonly _ledger: IContextLedgerService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IEmbeddingService embeddingService: IEmbeddingService,
	) {
		super();
		this._embedding = embeddingService;

		// B2 live closure: an embedding-model switch invalidates persisted
		// vectors by identity (cosine drops to 0); this sweep is the recovery
		// half — affected records are re-embedded with the new model. Fake
		// providers in older tests predate the event; absence is a no-op.
		const embWithEvent = this._embedding as { onDidChangeModel?: Event<string | undefined> } | undefined;
		if (embWithEvent?.onDidChangeModel) {
			this._register(embWithEvent.onDidChangeModel(() => { void this.reembedStaleVectors(); }));
		}

		// Task1 obs: expose live recall to CDP without fabricating scores.
		try {
			const obs = niTask1Obs();
			obs.bindRecall?.(async (query, opts) => {
				const results = await this.recall({
					query: String(query || ''),
					limit: typeof opts?.limit === 'number' ? opts.limit : 5,
					threadScope: (opts?.threadScope as 'current' | 'all') || 'all',
					currentThreadId: typeof opts?.currentThreadId === 'string' ? opts.currentThreadId : undefined,
				});
				return { ok: true, source: 'LedgerRecallService', results };
			});
			// native equivalent of the retired live-patch "expose on construct":
			// the L7 settings hook drives the product's OWN settings path through
			// this handle (provider embeddingModel → onDidChangeModel). The old
			// patch-based global died with the reconciliation — without this
			// native binder the hook has no supported path to the service.
			obs.bindEmbedding?.(this._embedding);
			niTask1ObsPush({ kind: 'obs.info', tags: { service: 'LedgerRecallService' }, data: { bound: true, embeddingBound: !!this._embedding } });
		} catch { /* observational */ }

		// F02 index feed: EVERY writer (sidebar, native bridge, executor,
		// workflow) appends through the ledger, so subscribing here — instead of
		// each writer calling indexEntry directly — makes it structurally
		// impossible for the search index to drift from the journal again.
		// A failed write is logged (rate-limited) and retries are left to the
		// backfill — it is never silently forgotten.
		this._register(this._ledger.onDidAppendEntry(({ threadId, entry }) => {
			niTask1ObsPush({
				kind: 'journal.append',
				tags: { threadId, seq: entry.seq, role: entry.role },
				data: { contentPreview: (entry.content || '').slice(0, 100) },
			});
			this._enqueueIndex(threadId, () => this.indexEntry(threadId, entry), `entry seq ${entry.seq}`);
		}));
		this._register(this._ledger.onDidFreezeEpisode(({ threadId, episode }) => {
			this._enqueueIndex(threadId, () => this.indexEpisode(threadId, episode), `episode ${episode.id}`);
		}));
	}

	private _enqueueIndex(threadId: string, run: () => Promise<boolean>, what: string): void {
		const prev = this._indexChains.get(threadId) ?? Promise.resolve();
		const next = prev
			.then(async () => {
				const ok = await run().catch(() => false);
				if (!ok) { this._warnIndexFailure(threadId, what); }
			});
		this._indexChains.set(threadId, next);
		next.finally(() => {
			if (this._indexChains.get(threadId) === next) { this._indexChains.delete(threadId); }
		});
	}

	private _warnIndexFailure(threadId: string, what: string): void {
		const now = Date.now();
		if (now - (this._lastIndexWarn.get(threadId) ?? 0) < 60_000) { return; }
		this._lastIndexWarn.set(threadId, now);
		console.warn(`[LedgerRecall] indexing failed for ${threadId} (${what}) — the backfill will retry`);
	}

	async whenIndexed(threadId: string): Promise<void> {
		const chain = this._indexChains.get(threadId);
		if (!chain) { return; }
		await Promise.race([
			chain,
			// recall liveness beats completeness: a stuck store must not hang chat
			new Promise<void>(resolve => setTimeout(resolve, 2_000)),
		]);
	}

	private _ensureStore(): Promise<boolean> {
		if (!this._storeInit) {
			this._storeInit = (async () => {
				const ws = this._workspaceContextService.getWorkspace().folders[0]?.uri;
				if (!ws) { return false; }
				const id = ws.toString().replace(/[^a-zA-Z0-9]/g, '_').slice(-120) || 'default';
				await this._contextStore.initialize(id);
				return true;
			})().catch(() => false);
		}
		return this._storeInit;
	}

	async indexEntry(threadId: string, entry: ILedgerEntry): Promise<boolean> {
		if (!await this._ensureStore()) {
			// L8 cold-start: allow a later append to retry init (workspace may appear after first event).
			this._storeInit = undefined;
			niTask1ObsPush({ kind: 'ledger.indexFail', tags: { threadId, seq: entry.seq, reason: 'store_init' } });
			return false;
		}
		// B2 live closure: a re-index (backfill sweep, repeat event) must not
		// overwrite the record's persisted vector stamp — journal entries are
		// immutable, so the existing stamp is still valid for this seq. Losing
		// it here forced a re-embed on every sweep and lost the vector
		// entirely if the app restarted before the queue re-stamped it.
		const record = buildLedgerEntryRecord(threadId, entry);
		const existing = await this._contextStore.getLedgerEntry(record.id).catch(() => undefined);
		const merged = existing?.embedding?.length && existing.embeddingModel
			? { ...record, embedding: existing.embedding, embeddingModel: existing.embeddingModel }
			: record;
		await this._contextStore.putLedgerEntries([merged]);
		niTask1ObsPush({
			kind: 'ledger.index',
			tags: { threadId, seq: entry.seq, role: entry.role },
			data: { id: record.id, snippetPreview: entry.content.slice(0, 80), hadPriorVector: !!(existing?.embedding?.length) },
		});
		// Knowledge-fact corrections (ALPHA_V2 etc.): prioritize embed so L8 sees vector sooner after chat.
		const prioritize = /KNOWLEDGE_FACT_/i.test(entry.content);
		this._enqueueEmbed({ kind: 'entry', threadId, key: `${threadId}:${entry.seq}`, text: entry.content.slice(0, EMBED_TEXT_MAX_CHARS), seqRange: [entry.seq, entry.seq], ts: entry.ts }, prioritize);
		return true;
	}

	async indexEpisode(threadId: string, ep: IEpisodeSummary): Promise<boolean> {
		if (!await this._ensureStore()) { return false; }
		// stamp preservation on re-index — see indexEntry
		const record = buildLedgerEpisodeRecord(threadId, ep);
		const existing = await this._contextStore.getLedgerEpisode(record.id).catch(() => undefined);
		const merged = existing?.embedding?.length && existing.embeddingModel
			? { ...record, embedding: existing.embedding, embeddingModel: existing.embeddingModel }
			: record;
		await this._contextStore.putLedgerEpisodes([merged]);
		const searchable = [ep.body.goal, ...ep.body.invariants, ...ep.body.rejected.map(r => r.approach), ...ep.body.decisions.map(d => d.what)].join('\n');
		this._enqueueEmbed({ kind: 'episode', threadId, key: `${threadId}:${ep.ordinal}`, text: searchable.slice(0, EMBED_TEXT_MAX_CHARS), seqRange: [ep.range.fromSeq, ep.range.toSeq], ts: ep.createdAt });
		return true;
	}

	/** B2: queue an embedding for a freshly indexed record. Bounded and
	 *  fire-and-forget — a missing vector only means cosine 0 until the queue
	 *  catches up; lexical recall is never blocked. */
	private _enqueueEmbed(item: { kind: 'entry' | 'episode'; threadId: string; key: string; text: string; seqRange: [number, number]; ts: number }, prioritize = false): void {
		if (!this._embedding?.isAvailable) { return; }
		const dedupeKey = `${item.kind}:${item.key}`;
		if (this._embedInFlight.has(dedupeKey)) { return; }
		if (this._embedPending.length >= EMBED_QUEUE_MAX_PENDING) { this._embedPending.shift(); } // drop oldest
		if (prioritize) { this._embedPending.unshift(item); } else { this._embedPending.push(item); }
		this._embedInFlight.add(dedupeKey);
		niTask1ObsPush({ kind: 'embed.request', tags: { key: item.key, kind: item.kind, prioritize }, data: { textChars: item.text.length } });
		this._pumpEmbedQueue();
	}

	private _pumpEmbedQueue(): void {
		while (this._embedActive < EMBED_QUEUE_CONCURRENCY && this._embedPending.length > 0) {
			const item = this._embedPending.shift()!;
			this._embedActive++;
			void (async () => {
				try {
					// Journal entries are immutable and episodes write-once, so
					// the stored record fetched here cannot change under us.
					// Generation guard (B2 live closure): a record that already
					// carries a vector stamped by the CURRENT model is current —
					// repeat enqueues (backfill episode refreshes, sweeps) must
					// not turn into recurring network traffic.
					const existingEntry = item.kind === 'entry' ? await this._contextStore.getLedgerEntry(item.key).catch(() => undefined) : undefined;
					const existingEpisode = item.kind === 'episode' ? await this._contextStore.getLedgerEpisode(item.key).catch(() => undefined) : undefined;
					const existing = existingEntry ?? existingEpisode;
					const currentModel = this._embedding?.model;
					if (existing?.embedding?.length && currentModel !== undefined && existing.embeddingModel === currentModel) { return; }

					// embedText returns the model identity OF THE REQUEST — a
					// settings change during the await cannot relabel the
					// vector with a model that did not produce it.
					const result = await this._embedding!.embedText(item.text);
					if (result) {
						const stamp = { embedding: Array.from(result.vector), embeddingModel: result.model };
						niTask1ObsPush({
							kind: 'embed.response',
							tags: { key: item.key, model: result.model, ok: true },
							data: { dims: result.vector.length },
						});
						this._vectorIndexSet(`${item.kind}:${item.key}`, {
							kind: item.kind, id: item.key, threadId: item.threadId,
							seqRange: item.seqRange, ts: item.ts, snippet: item.text.slice(0, 240),
							embedding: stamp.embedding, embeddingModel: stamp.embeddingModel,
						});
						if (existingEntry) {
							await this._contextStore.putLedgerEntries([{ ...existingEntry, ...stamp }]).catch(() => { });
						} else if (existingEpisode) {
							await this._contextStore.putLedgerEpisodes([{ ...existingEpisode, ...stamp }]).catch(() => { });
						}
						niTask1ObsPush({
							kind: 'embed.persist',
							tags: { key: item.key, model: result.model },
							data: { dims: result.vector.length, kind: item.kind },
						});
					} else {
						niTask1ObsPush({ kind: 'embed.response', tags: { key: item.key, ok: false } });
					}
				} catch { /* embed failures degrade to cosine 0 */ }
				finally {
					this._embedInFlight.delete(`${item.kind}:${item.key}`);
					this._embedActive--;
					this._pumpEmbedQueue();
				}
			})();
		}
	}

	/** Insert into the in-memory vector index, evicting the OLDEST ref at cap. */
	private _vectorIndexSet(dedupeKey: string, ref: IEmbeddedLedgerRecordRef): void {
		this._vectorIndex.delete(dedupeKey); // refresh LRU position
		this._vectorIndex.set(dedupeKey, ref);
		while (this._vectorIndex.size > VECTOR_INDEX_MAX_RECORDS) {
			const oldest = [...this._vectorIndex.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
			if (!oldest) { break; }
			this._vectorIndex.delete(oldest[0]);
		}
	}

	/**
	 * B2 live closure: bounded sweep that re-enqueues records whose persisted
	 * vector is missing or stamped by a different model than the currently
	 * configured one — the recovery path after a model switch or an ingestion
	 * outage (entries that failed to embed while the endpoint was down).
	 * Entry text is re-read verbatim from the journal (the stored record only
	 * keeps a 240-char snippet); episode text is rebuilt from the stored body.
	 */
	async reembedStaleVectors(): Promise<number> {
		if (!this._embedding?.isAvailable) { return 0; }
		const model = this._embedding.model;
		if (!model || !await this._ensureStore()) { return 0; }
		try {
			const stale = await this._contextStore.getLedgerRecordsNeedingEmbedding(model, REEMBED_SWEEP_BATCH);
			let enqueued = 0;
			for (const ref of stale) {
				if (ref.kind === 'entry') {
					const entries = await this._ledger.readRange(ref.threadId, ref.seqRange[0], ref.seqRange[1]).catch(() => []);
					for (const e of entries) {
						this._enqueueEmbed({ kind: 'entry', threadId: ref.threadId, key: `${ref.threadId}:${e.seq}`, text: e.content.slice(0, EMBED_TEXT_MAX_CHARS), seqRange: [e.seq, e.seq], ts: e.ts });
						enqueued++;
					}
				} else {
					const rec = await this._contextStore.getLedgerEpisode(ref.id).catch(() => undefined);
					this._enqueueEmbed({ kind: 'episode', threadId: ref.threadId, key: ref.id, text: this._episodeSearchableText(rec?.body).slice(0, EMBED_TEXT_MAX_CHARS) || ref.snippet, seqRange: ref.seqRange, ts: ref.ts });
					enqueued++;
				}
			}
			return enqueued;
		} catch {
			return 0;
		}
	}

	/** Rebuild the episode embed text from its stored compact JSON body — the
	 *  same fields {@link buildLedgerEpisodeRecord} indexes (goal, invariants,
	 *  rejected approaches, decisions). Falls back to the raw body/snippet. */
	private _episodeSearchableText(body: string | undefined): string {
		if (!body) { return ''; }
		try {
			const parsed = JSON.parse(body) as { goal?: string; invariants?: string[]; rejected?: { approach: string }[]; decisions?: { what: string }[] };
			return [parsed.goal, ...(parsed.invariants ?? []), ...(parsed.rejected ?? []).map(r => r.approach), ...(parsed.decisions ?? []).map(d => d.what)]
				.filter(x => x !== undefined && x !== '')
				.join('\n');
		} catch {
			return body;
		}
	}

	/** Lazy one-shot load of persisted vectors (B2): bounded to the newest
	 *  VECTOR_INDEX_MAX_RECORDS refs; failures degrade to an empty index. */
	private async _ensureVectorIndex(): Promise<void> {
		if (this._vectorIndexLoaded) { return; }
		this._vectorIndexLoaded = true;
		try {
			const refs = await this._contextStore.getRecentEmbeddedLedgerRecords(VECTOR_INDEX_MAX_RECORDS);
			for (const ref of refs) { this._vectorIndex.set(`${ref.kind}:${ref.id}`, ref); }
		} catch { /* empty index — semantic recall degrades to term-only */ }
	}

	/** B2: cosine between a stored record vector and the query vector; 0 when
	 *  the record has no vector or was stamped by a different model (stale —
	 *  invalidation by model identity, F06-style). */
	private static readonly MIN_SEMANTIC_COSINE = 0.72;

	private _cosine(queryVec: number[] | undefined, record: { embedding?: number[]; embeddingModel?: string }): number {
		if (!queryVec || !record.embedding || !record.embeddingModel) { return 0; }
		if (this._embedding?.model !== undefined && record.embeddingModel !== this._embedding.model) { return 0; }
		const len = Math.min(queryVec.length, record.embedding.length);
		let dot = 0, qa = 0, ra = 0;
		for (let i = 0; i < len; i++) { dot += queryVec[i] * record.embedding[i]; }
		for (let i = 0; i < queryVec.length; i++) { qa += queryVec[i] * queryVec[i]; }
		for (let i = 0; i < record.embedding.length; i++) { ra += record.embedding[i] * record.embedding[i]; }
		const denom = Math.sqrt(qa) * Math.sqrt(ra);
		return denom > 0 ? Math.max(0, dot / denom) : 0;
	}

	async recall(request: ILedgerRecallQuery): Promise<ILedgerRecallResult[]> {
		const limit = request.limit ?? DEFAULT_RECALL_LIMIT;
		const queryTerms = tokenize(request.query);
		if (queryTerms.length === 0) { return []; }
		if (request.threadScope === 'current' && !request.currentThreadId) { return []; }
		if (!await this._ensureStore()) { return []; }
		// R3: a recall fired right after an append must see that append
		if (request.threadScope === 'current' && request.currentThreadId) {
			await this.whenIndexed(request.currentThreadId);
		}

		const [entryMatches, episodeMatches] = await Promise.all([
			this._contextStore.searchLedgerEntriesByTerms(queryTerms, limit * 2),
			this._contextStore.searchLedgerEpisodesByTerms(queryTerms, limit * 2),
		]);

		const records = new Map<string, IStoredLedgerEntry | IStoredLedgerEpisode>();
		const candidates: ILedgerRecallCandidate[] = [];

		// B2: embed the query once when a provider is configured; a failed or
		// unavailable embedder degrades to the lexical-only weight set.
		let queryVec: number[] | undefined;
		if (this._embedding?.isAvailable) {
			const vec = await this._embedding.embedToVector(request.query).catch(() => null);
			if (vec) { queryVec = Array.from(vec); }
			await this._ensureVectorIndex();
		}

		for (const entry of entryMatches) {
			if (request.threadScope === 'current' && entry.threadId !== request.currentThreadId) { continue; }
			const why = queryTerms.filter(t => entry.terms.includes(t));
			const cosine = this._cosine(queryVec, entry);
			// B2-L5: lexical admission requires a CONTENT-term match — stop-word
			// overlap alone never admits (the semantic gate then decides when
			// there is no content overlap). See STOP_TERMS for the live evidence.
			const contentWhy = why.filter(t => !isStopTerm(t));
			if (contentWhy.length === 0 && cosine < LedgerRecallService.MIN_SEMANTIC_COSINE) { continue; }
			const id = `entry:${entry.id}`;
			records.set(id, entry);
			candidates.push({
				id,
				kind: 'entry',
				termScore: why.length / queryTerms.length,
				cosine,
				ts: entry.ts,
				pathOverlap: 0,
				why,
			});
		}
		for (const ep of episodeMatches) {
			if (request.threadScope === 'current' && ep.threadId !== request.currentThreadId) { continue; }
			const why = queryTerms.filter(t => ep.terms.includes(t));
			const cosine = this._cosine(queryVec, ep);
			// B2-L5: same content-term admission rule as entries (symmetric).
			const contentWhy = why.filter(t => !isStopTerm(t));
			if (contentWhy.length === 0 && cosine < LedgerRecallService.MIN_SEMANTIC_COSINE) { continue; }
			const id = `episode:${ep.id}`;
			records.set(id, ep);
			candidates.push({
				id,
				kind: 'episode',
				termScore: why.length / queryTerms.length,
				cosine,
				ts: ep.ts,
				pathOverlap: 0,
				why,
			});
		}

		// B2 semantic pool: candidates with a same-model vector that the TERM
		// search never surfaced (zero lexical overlap) enter through cosine —
		// that is the entire point of semantic archive recall.
		if (queryVec !== undefined) {
			for (const [dedupeKey, ref] of this._vectorIndex) {
				if (request.threadScope === 'current' && ref.threadId !== request.currentThreadId) { continue; }
				const cosine = this._cosine(queryVec, ref);
				if (cosine < LedgerRecallService.MIN_SEMANTIC_COSINE) { continue; }
				if (!records.has(dedupeKey)) {
					records.set(dedupeKey, ref as unknown as IStoredLedgerEntry);
					candidates.push({
						id: dedupeKey,
						kind: ref.kind,
						termScore: 0,
						cosine,
						ts: ref.ts,
						pathOverlap: 0,
						why: [],
					});
				}
			}
		}

		// B2: with a live query vector the full weight set applies (records
		// without a same-model vector honestly score cosine 0); otherwise the
		// degraded lexical set — exactly the pre-B2 behavior. pathOverlap stays
		// a reserved slot until the assembler passes the active file in.
		const scored = scoreRecallCandidates(candidates, queryVec !== undefined ? RECALL_WEIGHTS_WITH_EMBEDDINGS : RECALL_WEIGHTS_NO_EMBEDDINGS, Date.now());

		const results: ILedgerRecallResult[] = [];
		for (const candidate of scored.slice(0, limit)) {
			if (candidate.kind === 'entry') {
				const entry = records.get(candidate.id) as IStoredLedgerEntry & IEmbeddedLedgerRecordRef;
				results.push({
					kind: 'entry',
					threadId: entry.threadId,
					seqRange: entry.seqRange ?? [entry.seq, entry.seq],
					ts: entry.ts,
					snippet: entry.snippet,
					score: candidate.score,
					why: candidate.why,
				});
			} else {
				const ep = records.get(candidate.id) as IStoredLedgerEpisode & IEmbeddedLedgerRecordRef;
				results.push({
					kind: 'episode',
					threadId: ep.threadId,
					seqRange: ep.seqRange ?? [ep.fromSeq, ep.toSeq],
					ts: ep.ts,
					snippet: (ep.snippet ?? ep.body).slice(0, SNIPPET_MAX_CHARS),
					score: candidate.score,
					why: candidate.why,
				});
			}
		}
		try {
			const snap = {
				t: Date.now(),
				query: request.query,
				threadScope: request.threadScope,
				currentThreadId: request.currentThreadId,
				candidateCount: scored.length,
				top: results.slice(0, 5).map((r, i) => ({
					id: scored[i]?.id ?? `${r.kind}:${r.threadId}`,
					kind: r.kind,
					score: r.score,
					termScore: scored[i]?.termScore,
					cosine: scored[i]?.cosine,
					snippet: (r.snippet || '').slice(0, 120),
					threadId: r.threadId,
					why: r.why,
				})),
				weights: queryVec !== undefined ? 'with_embeddings' : 'lexical_only',
				embeddingUsed: queryVec !== undefined,
			};
			niTask1Obs()._setLastRecall(snap);
			niTask1ObsPush({ kind: 'recall.result', tags: { queryChars: request.query.length, n: results.length }, data: { topIds: snap.top.map(t => t.id), embeddingUsed: snap.embeddingUsed } });
		} catch { /* observational */ }
		return results;
	}

	async expand(request: ILedgerExpandRequest): Promise<ILedgerExpandResult> {
		const entries = await this._ledger.readRange(request.threadId, request.fromSeq, request.toSeq);
		return renderRecallWindow(entries, request.maxTokens);
	}
}

registerSingleton(ILedgerRecallService, LedgerRecallService, InstantiationType.Delayed);
