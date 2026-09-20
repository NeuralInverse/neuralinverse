/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Task-1 observational ring buffer — window.__niTask1Obs (observational only, never fabricates).
 *--------------------------------------------------------------------------------------*/

declare global {
	var __niTask1Obs: NiTask1Obs | undefined;
	var __niTask1DiagnosticsEnabled: boolean | undefined;
}

export type NiTask1ObsKind =
	| 'journal.append'
	| 'ledger.index'
	| 'ledger.indexFail'
	| 'embed.request'
	| 'embed.response'
	| 'embed.persist'
	| 'recall.result'
	| 'payload.assemble'
	| 'turn.cancel'
	| 'turn.settle'
	| 'store.load'
	| 'store.flush'
	| 'store.rehydrate'
	| 'obs.info';

export interface NiTask1ObsEvent {
	t: number;
	kind: NiTask1ObsKind;
	/** Short stable tag for filtering (threadId, requestId, model, …). */
	tags?: Record<string, string | number | boolean | null | undefined>;
	/** Redacted observational payload — no secrets, no full vectors. */
	data?: Record<string, unknown>;
}

export interface NiTask1ObsRecallSnapshot {
	t: number;
	query: string;
	threadScope?: string;
	currentThreadId?: string;
	candidateCount: number;
	top: Array<{
		id: string;
		kind: string;
		score: number;
		termScore?: number;
		cosine?: number;
		snippet?: string;
		threadId?: string;
		why?: string[];
	}>;
	weights?: string;
	embeddingUsed?: boolean;
}

export interface NiTask1ObsPayloadSnapshot {
	t: number;
	availableInputTokens?: number;
	reservedOverheadTokens?: number;
	systemTokens?: number;
	toolTokens?: number;
	messageTokens?: number;
	shedLevel?: string | number;
	compacted?: boolean;
	fit?: boolean;
	contextWindow?: number;
	raw?: Record<string, unknown>;
}

export interface NiTask1Obs {
	readonly version: 1;
	readonly ringSize: number;
	push(evt: Omit<NiTask1ObsEvent, 't'> & { t?: number }): void;
	dump(filter?: { kind?: NiTask1ObsKind | NiTask1ObsKind[]; since?: number; tag?: string; tagValue?: string | number | boolean }): NiTask1ObsEvent[];
	clear(): void;
	lastRecall(): NiTask1ObsRecallSnapshot | null;
	lastPayload(): NiTask1ObsPayloadSnapshot | null;
	/** Wait until an index event for threadId(+optional seq) appears, or timeout. */
	awaitIndex(threadId: string, opts?: { seq?: number; timeoutMs?: number }): Promise<NiTask1ObsEvent | null>;
	/** Wait until embed.persist for key, or timeout. */
	awaitEmbedPersist(key: string, opts?: { timeoutMs?: number }): Promise<NiTask1ObsEvent | null>;
	/** Optional live recall binder — set by LedgerRecallService when constructed. */
	bindRecall?(fn: (query: string, opts?: Record<string, unknown>) => Promise<unknown>): void;
	recall?(query: string, opts?: Record<string, unknown>): Promise<unknown>;
	/**
	 * Optional embedding-service binder — set by LedgerRecallService when
	 * constructed. Mirrors the service instance to `globalThis.__niEmbeddingService`
	 * so the acceptance settings hook can drive the PRODUCT'S OWN settings path
	 * (provider embeddingModel → setFieldProvider → onDidChangeModel) for the
	 * B2-L7 model-switch cell. Observational: it exposes the same service the
	 * DI container already built; it never fabricates vectors or scores.
	 */
	bindEmbedding?(emb: unknown): void;
	_setLastRecall(snap: NiTask1ObsRecallSnapshot): void;
	_setLastPayload(snap: NiTask1ObsPayloadSnapshot): void;
}

const RING_SIZE = 400;
let observationState: NiTask1Obs | undefined;

function ensureObs(): NiTask1Obs {
	if (observationState) { return observationState; }
	const g = globalThis as typeof globalThis & { __niTask1Obs?: NiTask1Obs; window?: { __niTask1Obs?: NiTask1Obs } };
	if (g.__niTask1Obs && g.__niTask1Obs.version === 1) {
		return g.__niTask1Obs;
	}

	const ring: NiTask1ObsEvent[] = [];
	let lastRecall: NiTask1ObsRecallSnapshot | null = null;
	let lastPayload: NiTask1ObsPayloadSnapshot | null = null;
	let recallFn: ((query: string, opts?: Record<string, unknown>) => Promise<unknown>) | undefined;

	const api: NiTask1Obs = {
		version: 1,
		ringSize: RING_SIZE,
		push(evt) {
			const full: NiTask1ObsEvent = { t: evt.t ?? Date.now(), kind: evt.kind, tags: evt.tags, data: evt.data };
			ring.push(full);
			while (ring.length > RING_SIZE) { ring.shift(); }
		},
		dump(filter) {
			let out = ring.slice();
			if (filter?.kind) {
				const kinds = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
				out = out.filter(e => kinds.includes(e.kind));
			}
			if (filter?.since !== undefined && filter?.since !== null) { out = out.filter(e => e.t >= filter.since!); }
			if (filter?.tag !== undefined && filter?.tag !== null) {
				out = out.filter(e => e.tags && e.tags[filter.tag!] === (filter.tagValue !== undefined ? filter.tagValue : e.tags[filter.tag!]));
			}
			return out;
		},
		clear() { ring.length = 0; lastRecall = null; lastPayload = null; },
		lastRecall() { return lastRecall; },
		lastPayload() { return lastPayload; },
		async awaitIndex(threadId, opts) {
			const timeoutMs = opts?.timeoutMs ?? 15_000;
			const seq = opts?.seq;
			const deadline = Date.now() + timeoutMs;
			const match = () => ring.slice().reverse().find(e =>
				e.kind === 'ledger.index'
				&& e.tags?.threadId === threadId
				&& (seq === undefined || seq === null || e.tags?.seq === seq)
			) ?? null;
			const hit = match();
			if (hit) { return hit; }
			return await new Promise(resolve => {
				const iv = globalThis.setInterval(() => {
					const h = match();
					if (h) { globalThis.clearInterval(iv); resolve(h); }
					else if (Date.now() >= deadline) { globalThis.clearInterval(iv); resolve(null); }
				}, 100);
			});
		},
		async awaitEmbedPersist(key, opts) {
			const timeoutMs = opts?.timeoutMs ?? 20_000;
			const deadline = Date.now() + timeoutMs;
			const match = () => ring.slice().reverse().find(e =>
				e.kind === 'embed.persist' && (e.tags?.key === key || e.data?.key === key)
			) ?? null;
			const hit = match();
			if (hit) { return hit; }
			return await new Promise(resolve => {
				const iv = globalThis.setInterval(() => {
					const h = match();
					if (h) { globalThis.clearInterval(iv); resolve(h); }
					else if (Date.now() >= deadline) { globalThis.clearInterval(iv); resolve(null); }
				}, 100);
			});
		},
		bindRecall(fn) { recallFn = fn; },
		bindEmbedding(emb) {
			if (globalThis.__niTask1DiagnosticsEnabled !== true) { return; }
			try {
				const g2 = globalThis as typeof globalThis & { __niEmbeddingService?: unknown };
				g2.__niEmbeddingService = emb;
			} catch { /* observational only */ }
		},
		async recall(query, opts) {
			if (!recallFn) {
				const g = globalThis as typeof globalThis & { __niLedgerRecallRaw?: { recall: (req: Record<string, unknown>) => Promise<unknown> } };
				const svc = g.__niLedgerRecallRaw;
				if (svc && typeof svc.recall === 'function') {
					recallFn = async (q, o) => {
						const results = await svc.recall({
							query: String(q || ''),
							limit: typeof o?.limit === 'number' ? o.limit : 5,
							threadScope: (o?.threadScope as string) || 'all',
							currentThreadId: typeof o?.currentThreadId === 'string' ? o.currentThreadId : undefined,
						});
						return { ok: true, source: 'LedgerRecallService', results };
					};
				}
			}
			if (!recallFn) { return { ok: false, error: 'recall binder not set' }; }
			return recallFn(query, opts);
		},
		_setLastRecall(snap) { lastRecall = snap; },
		_setLastPayload(snap) { lastPayload = snap; },
	};

	observationState = api;
	if (globalThis.__niTask1DiagnosticsEnabled !== true) { return api; }
	g.__niTask1Obs = api;
	try {
		if (typeof g.window !== 'undefined') { g.window.__niTask1Obs = api; }
	} catch { /* non-DOM */ }
	return api;
}

/** Safe push helper for product call sites — never throws into chat path. */
export function niTask1ObsPush(evt: Omit<NiTask1ObsEvent, 't'> & { t?: number }): void {
	try { ensureObs().push(evt); } catch { /* observational only */ }
}

export function niTask1Obs(): NiTask1Obs {
	return ensureObs();
}

// Keep diagnostics module-local unless explicitly enabled before startup.
ensureObs();
