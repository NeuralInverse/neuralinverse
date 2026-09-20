/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Context Ledger — working brief builder (task M5, phase 2)
 *
 * Deterministic merge of frozen episode bodies into the L2 working brief.
 * Decision D3: merging is pure code, never an LLM — rules and dead ends must
 * not be "re-interpreted" between runs. Two builds from the same episodes
 * produce byte-identical output, which is what keeps the request prefix
 * cache-stable (D5) and makes the brief reproducible bit-for-bit after a
 * restart (task section 10).
 *
 * Pipeline: mergeEpisodeBodies → shrinkToBudget → renderWorkingMemory,
 * orchestrated by buildWorkingBrief. This module is intentionally free of
 * vscode/DI/LLM dependencies: it only sees the ledger contracts and policy.
 */

import { IEpisodeBody, IEpisodeSummary, IWorkingBrief } from './ledgerTypes.js';
import { estimateTokens, ILedgerPolicy } from './ledgerPolicy.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

/** appended to an invariant whose key was re-stated with different text (task 6-3) */
const SUPERSEDED_SUFFIX = ' (superseded)';
/** joins the original and the current goal inside `merged.goal`; the renderer splits on it */
const GOAL_SEPARATOR = ' → ';
/** openQuestions cap (task 6-3 — deliberately not part of ILedgerPolicy) */
const MAX_OPEN_QUESTIONS = 10;
/** artifact caps: files / symbols / commands / configs (task 6-3) */
const ARTIFACT_CAPS = { files: 60, symbols: 40, commands: 20, configs: 20 } as const;
/** episodes whose sourceIds count as "recently referenced" for rejected-cap eviction */
const RECENT_EPISODE_WINDOW = 3;
/** chars-per-token approximation used by the budget check */
const CHARS_PER_TOKEN = 4;

// ─── Internal shapes ───────────────────────────────────────────────────────────

/** every merged entry tracks when it first appeared and when it was last restated */
interface ITrackedEntry {
	firstSeen: number;
	lastSeen: number;
}

interface IInvariantEntry extends ITrackedEntry { text: string; }

interface IRejectedEntry extends ITrackedEntry {
	approach: string;
	reason: string;
	evidence?: string;
	sourceIds: number[];
}

interface ICorrectionEntry extends ITrackedEntry {
	userSaid: string;
	ruleDerived?: string;
	sourceIds: number[];
}

interface IDecisionEntry extends ITrackedEntry {
	what: string;
	why: string;
	alternatives?: string[];
	sourceIds: number[];
}

interface IFailureEntry extends ITrackedEntry {
	attempt: string;
	error: string;
	resolution: 'fixed' | 'abandoned' | 'open';
	sourceIds: number[];
}

interface IQuestionEntry extends ITrackedEntry { text: string; }

/**
 * `rejected` items additionally carry their first-seen episode ordinal so the
 * renderer can emit `episode="N"` (task 6-4). The field is additive: every
 * other property matches the IEpisodeBody contract, so the merged body still
 * satisfies the declared shape (and survives a JSON round-trip).
 */
interface IRejectedItemWithEpisode {
	approach: string;
	reason: string;
	evidence?: string;
	sourceIds: number[];
	episode: number;
}

/** what renderWorkingMemory reads off a rejected item (the episode field may be absent on foreign bodies) */
interface IRejectedRenderItem {
	episode?: number;
}

// ─── Key normalization ─────────────────────────────────────────────────────────

/** trim + lowercase + collapse whitespace + strip trailing punctuation (task 6-3). */
export function normalizeKey(s: string): string {
	return s.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.replace(/[.,;:!?]+$/, '')
		.trim();
}

// ─── Small helpers ─────────────────────────────────────────────────────────────

/** code-unit comparison — locale-independent so renders are byte-stable everywhere */
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** union of numeric sourceIds, deduplicated, ascending */
function mergeIds(into: number[], from: number[] | undefined): void {
	if (!from || from.length === 0) return;
	for (const id of from) {
		if (!into.includes(id)) into.push(id);
	}
	into.sort((a, b) => a - b);
}

/**
 * Cap a merged list. When over `cap`, the entries from the most recent episodes
 * survive first (ties broken by earliest first-seen, then alphabetically);
 * survivors are returned in display order — first-seen episode ascending, then
 * alphabetical — which is the stable order the renderer relies on.
 */
function capByRecency<T extends ITrackedEntry>(entries: T[], cap: number, textOf: (e: T) => string): T[] {
	let kept = entries;
	if (entries.length > cap) {
		kept = [...entries].sort((a, b) =>
			b.lastSeen - a.lastSeen
			|| a.firstSeen - b.firstSeen
			|| compareText(textOf(a), textOf(b))
		).slice(0, cap);
	}
	return [...kept].sort((a, b) =>
		a.firstSeen - b.firstSeen
		|| compareText(textOf(a), textOf(b))
	);
}

/** all sourceIds referenced by any entry of the newest episodes (the "recent activity" set) */
function collectRecentSourceIds(sorted: IEpisodeSummary[]): Set<number> {
	const refs = new Set<number>();
	for (const ep of sorted.slice(-RECENT_EPISODE_WINDOW)) {
		const sections = [...ep.body.decisions, ...ep.body.rejected, ...ep.body.failures, ...ep.body.corrections];
		for (const item of sections) {
			for (const id of item.sourceIds) refs.add(id);
		}
	}
	return refs;
}

/** the oldest rejected entry with no recent sourceIds reference; the oldest overall when all are protected */
function pickRejectedEvictionVictim(entries: IRejectedEntry[], recentRefs: Set<number>): IRejectedEntry {
	const older = (a: IRejectedEntry, b: IRejectedEntry): boolean =>
		a.firstSeen < b.firstSeen
		|| (a.firstSeen === b.firstSeen && a.approach < b.approach);
	let victim: IRejectedEntry | undefined;
	for (const e of entries) {
		if (e.sourceIds.some(id => recentRefs.has(id))) continue;
		if (!victim || older(e, victim)) victim = e;
	}
	if (victim) return victim;
	// every entry is referenced by the newest episodes and the cap still wins — evict the oldest overall
	for (const e of entries) {
		if (!victim || older(e, victim)) victim = e;
	}
	return victim!;
}

/** rank values by the number of episodes mentioning them (duplicates within one episode count once), then alphabetically; hard cap */
function mergeRanked(valuesPerEpisode: string[][], cap: number): string[] {
	const counts = new Map<string, number>();
	for (const values of valuesPerEpisode) {
		for (const v of new Set(values)) {
			counts.set(v, (counts.get(v) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
		.slice(0, cap)
		.map(([v]) => v);
}

function emptyBody(): IEpisodeBody {
	return {
		goal: '',
		decisions: [],
		rejected: [],
		failures: [],
		corrections: [],
		invariants: [],
		artifacts: { files: [], symbols: [], commands: [], configs: [] },
		state: { done: [], inProgress: [], verified: [] },
		next: [],
		openQuestions: [],
	};
}

// ─── Merge (task 6-3 — all nine rules, deterministic) ──────────────────────────

/**
 * Merge frozen episode bodies into one IEpisodeBody. Implements the nine rules
 * of task section 6-3 exactly; the input is never mutated and the output only
 * depends on the episode content (input order is normalized by ordinal).
 */
export function mergeEpisodeBodies(episodes: IEpisodeSummary[], policy: ILedgerPolicy): IEpisodeBody {
	const sorted = [...episodes].sort((a, b) => a.ordinal - b.ordinal);
	if (sorted.length === 0) return emptyBody();
	const first = sorted[0]!;
	const last = sorted[sorted.length - 1]!;

	// ── Rule 1 — invariants: union by key; on conflict the newer text wins and the
	//    older one is kept with the superseded marker (both count toward the cap)
	const invariantByKey = new Map<string, IInvariantEntry>();
	const supersededInvariants: IInvariantEntry[] = [];
	for (const ep of sorted) {
		for (const text of ep.body.invariants) {
			const key = normalizeKey(text);
			const existing = invariantByKey.get(key);
			if (!existing) {
				invariantByKey.set(key, { text, firstSeen: ep.ordinal, lastSeen: ep.ordinal });
			} else if (existing.text === text) {
				existing.lastSeen = ep.ordinal;
			} else {
				supersededInvariants.push({ text: existing.text + SUPERSEDED_SUFFIX, firstSeen: existing.firstSeen, lastSeen: existing.lastSeen });
				existing.text = text;
				existing.lastSeen = ep.ordinal;
			}
		}
	}
	const invariants = capByRecency(
		[...invariantByKey.values(), ...supersededInvariants],
		policy.maxInvariants,
		e => e.text,
	).map(e => e.text);

	// ── Rule 2 — rejected: union by approach key; reason/evidence always come from
	//    the NEWEST episode restating the approach; entries are never dropped
	//    except by the cap (oldest without a recent sourceIds reference goes first)
	const rejectedByKey = new Map<string, IRejectedEntry>();
	for (const ep of sorted) {
		for (const item of ep.body.rejected) {
			const key = normalizeKey(item.approach);
			const existing = rejectedByKey.get(key);
			if (!existing) {
				rejectedByKey.set(key, {
					approach: item.approach,
					reason: item.reason,
					evidence: item.evidence,
					sourceIds: [...item.sourceIds],
					firstSeen: ep.ordinal,
					lastSeen: ep.ordinal,
				});
			} else {
				existing.approach = item.approach;
				existing.reason = item.reason;
				existing.evidence = item.evidence;
				existing.lastSeen = ep.ordinal;
				mergeIds(existing.sourceIds, item.sourceIds);
			}
		}
	}

	// Rule 4 removes decisions whose key was rejected. The check uses the FULL
	// union (before cap eviction) so state-machine correctness never depends on
	// whether a rejected entry happened to survive the overflow trim.
	const rejectedKeys = new Set(rejectedByKey.keys());

	const recentRefs = collectRecentSourceIds(sorted);
	const rejectedEntries = [...rejectedByKey.values()];
	while (rejectedEntries.length > policy.maxRejected) {
		const victim = pickRejectedEvictionVictim(rejectedEntries, recentRefs);
		rejectedEntries.splice(rejectedEntries.indexOf(victim), 1);
	}
	const rejected: IRejectedItemWithEpisode[] = rejectedEntries
		.sort((a, b) => a.firstSeen - b.firstSeen || compareText(a.approach, b.approach))
		.map(e => ({ approach: e.approach, reason: e.reason, evidence: e.evidence, sourceIds: e.sourceIds, episode: e.firstSeen }));

	// ── Rule 3 — corrections: union by ruleDerived ?? userSaid; newest phrasing wins
	const correctionByKey = new Map<string, ICorrectionEntry>();
	for (const ep of sorted) {
		for (const item of ep.body.corrections) {
			const key = normalizeKey(item.ruleDerived ?? item.userSaid);
			const existing = correctionByKey.get(key);
			if (!existing) {
				correctionByKey.set(key, { userSaid: item.userSaid, ruleDerived: item.ruleDerived, sourceIds: [...item.sourceIds], firstSeen: ep.ordinal, lastSeen: ep.ordinal });
			} else {
				existing.userSaid = item.userSaid;
				existing.ruleDerived = item.ruleDerived;
				existing.lastSeen = ep.ordinal;
				mergeIds(existing.sourceIds, item.sourceIds);
			}
		}
	}
	const corrections = capByRecency([...correctionByKey.values()], policy.maxCorrections, e => e.userSaid)
		.map(e => ({ userSaid: e.userSaid, ruleDerived: e.ruleDerived, sourceIds: e.sourceIds }));

	// ── Rule 4 — decisions: union by what; any decision whose key also appears in
	//    rejected is REMOVED (it was later rejected — state-machine correctness)
	const decisionByKey = new Map<string, IDecisionEntry>();
	for (const ep of sorted) {
		for (const item of ep.body.decisions) {
			const key = normalizeKey(item.what);
			const existing = decisionByKey.get(key);
			if (!existing) {
				decisionByKey.set(key, { what: item.what, why: item.why, alternatives: item.alternatives ? [...item.alternatives] : undefined, sourceIds: [...item.sourceIds], firstSeen: ep.ordinal, lastSeen: ep.ordinal });
			} else {
				existing.what = item.what;
				existing.why = item.why;
				existing.alternatives = item.alternatives ? [...item.alternatives] : undefined;
				existing.lastSeen = ep.ordinal;
				mergeIds(existing.sourceIds, item.sourceIds);
			}
		}
	}
	const liveDecisions = [...decisionByKey.entries()]
		.filter(([key]) => !rejectedKeys.has(key))
		.map(([, e]) => e);
	const decisions = capByRecency(liveDecisions, policy.maxDecisions, e => e.what)
		// `alternatives` is omitted rather than set to undefined: the merged body is
		// persisted as JSON (brief.json) and read back, so it must be round-trip
		// stable — an explicit undefined key would not survive the reload.
		.map(e => ({ what: e.what, why: e.why, ...(e.alternatives ? { alternatives: e.alternatives } : {}), sourceIds: e.sourceIds }));

	// ── Rule 5 — failures: only resolution !== 'fixed' survives. A failure that a
	//    later episode marks fixed disappears entirely (newest resolution wins on
	//    key collision); there is deliberately no "fixed counter" in IEpisodeBody.
	const failureByKey = new Map<string, IFailureEntry>();
	for (const ep of sorted) {
		for (const item of ep.body.failures) {
			const key = normalizeKey(item.attempt);
			const existing = failureByKey.get(key);
			if (!existing) {
				failureByKey.set(key, { attempt: item.attempt, error: item.error, resolution: item.resolution, sourceIds: [...item.sourceIds], firstSeen: ep.ordinal, lastSeen: ep.ordinal });
			} else {
				existing.attempt = item.attempt;
				existing.error = item.error;
				existing.resolution = item.resolution;
				existing.lastSeen = ep.ordinal;
				mergeIds(existing.sourceIds, item.sourceIds);
			}
		}
	}
	const failures = capByRecency(
		[...failureByKey.values()].filter(e => e.resolution !== 'fixed'),
		policy.maxFailures,
		e => e.attempt,
	).map(e => ({ attempt: e.attempt, error: e.error, resolution: e.resolution, sourceIds: e.sourceIds }));

	// ── Rule 6 — artifacts: rank by cross-episode frequency, then alphabetical; hard caps
	const artifacts = {
		files: mergeRanked(sorted.map(ep => ep.body.artifacts.files), ARTIFACT_CAPS.files),
		symbols: mergeRanked(sorted.map(ep => ep.body.artifacts.symbols), ARTIFACT_CAPS.symbols),
		commands: mergeRanked(sorted.map(ep => ep.body.artifacts.commands), ARTIFACT_CAPS.commands),
		configs: mergeRanked(sorted.map(ep => ep.body.artifacts.configs), ARTIFACT_CAPS.configs),
	};

	// ── Rule 7 — state and next describe *now*: they come from the LAST episode only
	const state = {
		done: [...last.body.state.done],
		inProgress: [...last.body.state.inProgress],
		verified: [...last.body.state.verified],
	};
	const next = [...last.body.next];

	// ── Rule 8 — goal: original from episode 1, current from the last episode.
	// Stored joined as "original → current" when they differ, else the single
	// text; the renderer splits on the separator.
	const originalGoal = first.body.goal;
	const currentGoal = last.body.goal;
	const goal = originalGoal !== currentGoal ? `${originalGoal}${GOAL_SEPARATOR}${currentGoal}` : currentGoal;

	// ── Rule 9 — openQuestions: union minus the ones a LATER episode answered
	// (same normalized key appears in its decisions[].what or artifacts.symbols)
	const questionByKey = new Map<string, IQuestionEntry>();
	for (const ep of sorted) {
		for (const q of ep.body.openQuestions) {
			const key = normalizeKey(q);
			const existing = questionByKey.get(key);
			if (!existing) {
				questionByKey.set(key, { text: q, firstSeen: ep.ordinal, lastSeen: ep.ordinal });
			} else {
				existing.text = q;
				existing.lastSeen = ep.ordinal;
			}
		}
	}
	const answerKeysByOrdinal = sorted.map(ep => ({
		ordinal: ep.ordinal,
		keys: new Set([
			...ep.body.decisions.map(d => normalizeKey(d.what)),
			...ep.body.artifacts.symbols.map(s => normalizeKey(s)),
		]),
	}));
	const openQuestions = capByRecency(
		[...questionByKey.entries()]
			.filter(([key, e]) => !answerKeysByOrdinal.some(a => a.ordinal > e.lastSeen && a.keys.has(key)))
			.map(([, e]) => e),
		MAX_OPEN_QUESTIONS,
		e => e.text,
	).map(e => e.text);

	return { goal, decisions, rejected, failures, corrections, invariants, artifacts, state, next, openQuestions };
}

// ─── Budget shrink (task 6-3 tail) ─────────────────────────────────────────────

/** halve every non-empty artifact list in place, keeping the highest-ranked half; false when nothing could be halved */
function halveArtifacts(body: IEpisodeBody): boolean {
	const lists = [body.artifacts.files, body.artifacts.symbols, body.artifacts.commands, body.artifacts.configs];
	let shrunk = false;
	for (const list of lists) {
		if (list.length > 0) {
			list.length = Math.floor(list.length / 2);
			shrunk = true;
		}
	}
	return shrunk;
}

/**
 * Bring a merged body under the brief budget by trimming, in this order and
 * never any other: artifacts (halved repeatedly), failures, the OLDEST
 * decisions, openQuestions. invariants / rejected / corrections are NEVER
 * trimmed — they are the reason this task exists. If the body is still over
 * budget after the allowed trims it is returned as-is (the caller decides how
 * to surface that; this module stays log-free and side-effect-free).
 */
export function shrinkToBudget(body: IEpisodeBody, policy: ILedgerPolicy): IEpisodeBody {
	// JSON round-trip: the input (already persisted episodes) must never be mutated
	// and the result must stay a plain serializable value.
	const out: IEpisodeBody = JSON.parse(JSON.stringify(body));
	const overBudget = () => estimateTokens(JSON.stringify(out)) > policy.briefMaxTokens * CHARS_PER_TOKEN;
	while (overBudget()) {
		if (halveArtifacts(out)) continue;                                        // 1. artifacts (halve)
		if (out.failures.length > 0) { out.failures = []; continue; }             // 2. failures
		if (out.decisions.length > 0) { out.decisions = out.decisions.slice(1); continue; } // 3. oldest decision (merge sorts ascending)
		if (out.openQuestions.length > 0) { out.openQuestions = []; continue; }   // 4. openQuestions
		break; // invariants / rejected / corrections are never the first victims
	}
	return out;
}

// ─── Render (task 6-4 — stable order) ──────────────────────────────────────────

/** what renderWorkingMemory needs: everything except the thread bookkeeping */
export interface IWorkingMemoryRenderInput {
	revision: number;
	builtFromEpisodes: number[];
	builtAtSeq: number;
	merged: IEpisodeBody;
}

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function escapeText(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function renderTextSection(tag: string, items: string[]): string[] {
	if (items.length === 0) return [`  <${tag}/>`];
	const lines = [`  <${tag}>`];
	for (const item of items) lines.push(`    <item>${escapeText(item)}</item>`);
	lines.push(`  </${tag}>`);
	return lines;
}

/**
 * The stable XML-ish `<working_memory>` block of task 6-4. Ordering inside each
 * section was already made deterministic by the merge (episode ordinal
 * ascending, then alphabetical); the renderer just maps. Items are escaped for
 * XML attributes (& < > "), text content for XML (& < >).
 */
export function renderWorkingMemory(brief: IWorkingMemoryRenderInput): string {
	const ordinals = brief.builtFromEpisodes;
	const firstEpisode = ordinals.length > 0 ? Math.min(...ordinals) : 0;
	const lastEpisode = ordinals.length > 0 ? Math.max(...ordinals) : 0;
	const merged = brief.merged;
	const lines: string[] = [
		`<working_memory revision="${brief.revision}" episodes="${firstEpisode}-${lastEpisode}" covers_seq="1-${brief.builtAtSeq}">`,
	];

	// goal — the merge stored "original → current"; split on the first separator
	const sepIdx = merged.goal.indexOf(GOAL_SEPARATOR);
	if (sepIdx >= 0) {
		const original = merged.goal.slice(0, sepIdx);
		const current = merged.goal.slice(sepIdx + GOAL_SEPARATOR.length);
		lines.push(`  <goal original="${escapeAttr(original)}" current="${escapeAttr(current)}"/>`);
	} else {
		lines.push(`  <goal current="${escapeAttr(merged.goal)}"/>`);
	}

	lines.push(...renderTextSection('invariants', merged.invariants));

	if (merged.rejected.length === 0) {
		lines.push('  <rejected_approaches/>');
	} else {
		lines.push('  <rejected_approaches>');
		for (const item of merged.rejected) {
			const episode = (item as IRejectedRenderItem).episode;
			const episodeAttr = typeof episode === 'number' ? ` episode="${episode}"` : '';
			lines.push(`    <item approach="${escapeAttr(item.approach)}" reason="${escapeAttr(item.reason)}"${episodeAttr}/>`);
		}
		lines.push('  </rejected_approaches>');
	}

	if (merged.failures.length === 0) {
		lines.push('  <open_failures/>');
	} else {
		lines.push('  <open_failures>');
		for (const item of merged.failures) {
			lines.push(`    <item attempt="${escapeAttr(item.attempt)}" error="${escapeAttr(item.error)}" resolution="${item.resolution}"/>`);
		}
		lines.push('  </open_failures>');
	}

	if (merged.corrections.length === 0) {
		lines.push('  <user_corrections/>');
	} else {
		lines.push('  <user_corrections>');
		for (const item of merged.corrections) {
			const ruleAttr = item.ruleDerived !== undefined ? ` rule="${escapeAttr(item.ruleDerived)}"` : '';
			lines.push(`    <item user_said="${escapeAttr(item.userSaid)}"${ruleAttr}/>`);
		}
		lines.push('  </user_corrections>');
	}

	if (merged.decisions.length === 0) {
		lines.push('  <decisions/>');
	} else {
		lines.push('  <decisions>');
		for (const item of merged.decisions) {
			lines.push(`    <item what="${escapeAttr(item.what)}" why="${escapeAttr(item.why)}"/>`);
		}
		lines.push('  </decisions>');
	}

	lines.push(`  <artifacts files="${escapeAttr(merged.artifacts.files.join(', '))}" symbols="${escapeAttr(merged.artifacts.symbols.join(', '))}" commands="${escapeAttr(merged.artifacts.commands.join(', '))}"/>`);
	lines.push(`  <state done="${escapeAttr(merged.state.done.join(', '))}" in_progress="${escapeAttr(merged.state.inProgress.join(', '))}" verified="${escapeAttr(merged.state.verified.join(', '))}"/>`);

	lines.push(...renderTextSection('next', merged.next));
	lines.push('  <recall_hint>Use the recall_history tool to see the exact older conversation when you need details.</recall_hint>');
	lines.push('</working_memory>');
	return lines.join('\n');
}

// ─── Orchestration ─────────────────────────────────────────────────────────────

export interface IBuildWorkingBriefOptions {
	threadId: string;
	previousBrief: IWorkingBrief | null;
	episodes: IEpisodeSummary[];
	lastSeq: number;
	policy: ILedgerPolicy;
}

/**
 * Build the working brief: merge → shrink → render → token estimate.
 * The revision bumps on every call — the CALLER controls call timing so that
 * this only happens at episode boundaries (D5); building twice from the same
 * frozen episodes yields the same text with a higher revision number only.
 */
export function buildWorkingBrief(opts: IBuildWorkingBriefOptions): IWorkingBrief {
	const sorted = [...opts.episodes].sort((a, b) => a.ordinal - b.ordinal);
	const merged = shrinkToBudget(mergeEpisodeBodies(sorted, opts.policy), opts.policy);
	const builtFromEpisodes = sorted.map(ep => ep.ordinal);
	const revision = (opts.previousBrief?.revision ?? 0) + 1;
	const text = renderWorkingMemory({ revision, builtFromEpisodes, builtAtSeq: opts.lastSeq, merged });
	return {
		threadId: opts.threadId,
		revision,
		builtFromEpisodes,
		builtAtSeq: opts.lastSeq,
		tokens: estimateTokens(text),
		text,
		merged,
	};
}
