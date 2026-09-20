/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Loop budget — the per-send window enforcement for the native tool loop
 * (task F01/F10, phase-1 review R1)
 *
 * The first cut of this logic walked the messages backwards and folded
 * whatever did not fit — including the user's ENTIRE current request (the
 * outgoing payload was a trimming notice alone) and the working brief. This
 * module is the repaired, pure core with hard guarantees:
 *
 *   1. MANDATORY content is never folded AND never shortened (re-review T2:
 *      exclusion is by the caller's explicit index, not by what the text looks
 *      like — a request that begins with `<tool_result` survives verbatim):
 *      the working brief (L2 memory) and the current user request. If the two
 *      cannot coexist with even a truncated payload, the result is
 *      `infeasible` — the caller must stop and ask for reduced input, never
 *      send a request without the user's intent.
 *   1b. The result reports WHERE the current request landed in the output
 *      array (`currentRequestIdx`, re-review T1): trimming shifts indices, so
 *      the caller must adopt the returned index for the next send instead of
 *      reusing its stale input-side index.
 *   2. Oversized tool results are TRUNCATED (head + tail + archive pointer),
 *      not dropped — the model keeps the freshest evidence of what it did.
 *   3. Interaction boundaries stay intact: an assistant message and the run
 *      of tool results it issued are kept or folded as ONE group, never
 *      split.
 *   4. The notice is honest: the caller supplies the archive sentence, so a
 *      run with the ledger off does not claim content was archived.
 *
 * Pure by design — the caller measures the real system message and tool
 * definitions and passes the resulting allowance in `availableTokens`.
 */

import { estimateTokens } from './ledgerPolicy.js';
import { BRIEF_TAIL_NOTE } from './contextAssembler.js';

/**
 * The loop payload's messages, minimally constrained: the core only reads
 * `role`/`content` and never changes a message's type, so the provider
 * message unions (OpenAI/Anthropic shapes) pass straight through.
 */
export interface ILoopBudgetMessage {
	role: string;
	content: unknown;
}

export interface ILoopBudgetResult {
	/** the payload to send; identical to the input when nothing was trimmed */
	messages: ILoopBudgetMessage[];
	/** how many older messages were folded behind the notice */
	foldedCount: number;
	/** how many tool results were shortened in place */
	truncatedCount: number;
	/**
	 * Set when mandatory content (brief + current request) cannot fit the
	 * allowance even with every trim applied — the caller must surface an
	 * explicit error instead of sending `messages`.
	 */
	infeasible?: { availableTokens: number; mandatoryTokens: number };
	/**
	 * Where the current request sits in `messages` (re-review T1): trimming
	 * removes a prefix and inserts a notice, so the caller's index into the
	 * INPUT array is stale in the OUTPUT array. The caller must adopt THIS
	 * value before the next loop send — protecting whatever now occupies the
	 * old position protects a random message, not the user's request. -1 when
	 * the payload carries no current request.
	 */
	currentRequestIdx: number;
}

/** Fixed head of an in-loop tool-result user message. */
const TOOL_RESULT_PREFIX = '<tool_result';

/** Never truncate a tool result below this many tokens — fold it instead. */
export const MIN_TRUNCATED_TOKENS = 128;

/** Honest estimate: provider parts (image payloads!) serialize into the request. */
function tokensOf(content: unknown): number {
	return estimateTokens(typeof content === 'string' ? content : JSON.stringify(content ?? ''));
}

function isToolResult(content: unknown): boolean {
	return typeof content === 'string' && content.startsWith(TOOL_RESULT_PREFIX);
}

function isNotice(content: unknown): boolean {
	return typeof content === 'string' && (content.startsWith('<trimmed_loop_context') || content.startsWith('<ledger_notice'));
}

function isBrief(content: unknown): boolean {
	return typeof content === 'string' && content.endsWith(BRIEF_TAIL_NOTE);
}

/**
 * Shorten the message at `idx` in place (tool results are string content).
 * Returns the new token estimate.
 */
function truncateInPlace(messages: ILoopBudgetMessage[], tokens: number[], idx: number, allowanceTokens: number, archiveNote: string): number {
	const raw = messages[idx].content;
	const asText = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
	const tr = truncateToolResult(asText, allowanceTokens, archiveNote);
	tokens[idx] = tr.tokens;
	messages[idx] = { role: 'user', content: tr.content };
	return tr.tokens;
}

/**
 * Shorten one tool result to `allowanceTokens`, keeping head + tail and
 * pointing at the archive. BLOCK-AWARE (re-review S5): a user message can
 * carry several merged `<tool_result>` blocks (same-turn results merge for
 * alternation) — each block keeps its header and a shortened body, so every
 * call's evidence survives with its identity instead of the middle results
 * being elided away by a single whole-string cut. Converges strictly: when
 * distribution overhead would exceed the allowance, blocks degrade to
 * header+note stubs (always smaller than the original). Exported for tests.
 */
export function truncateToolResult(content: string, allowanceTokens: number, archiveNote: string): { content: string; tokens: number } {
	const note = `[… truncated — ${archiveNote} …]`;
	const heads = [...content.matchAll(/<tool_result[^>]*>/g)].map(m => m.index ?? 0);
	if (heads.length > 1) {
		// shrink the per-block body budget until the whole message fits the
		// allowance; the floor is headers+notes only, which is always smaller
		// than the original (every truncatable message exceeds MIN tokens)
		let out = distributeBlocks(content, heads, allowanceTokens, note);
		let perBlock = Math.max(0, allowanceTokens);
		for (let round = 0; round < 8 && estimateTokens(out) > allowanceTokens; round++) {
			perBlock = Math.floor(perBlock / 2);
			out = perBlock > 0
				? distributeBlocks(content, heads, perBlock, note)
				: stubBlocks(content, heads, note);
		}
		if (estimateTokens(out) > allowanceTokens) {
			out = stubBlocks(content, heads, note);
		}
		return { content: out, tokens: estimateTokens(out) };
	}
	const shortened = shortenBody(content, allowanceTokens, note);
	return { content: shortened, tokens: estimateTokens(shortened) };
}

/** Rebuild the message with each block's body shortened to `perBlockTokens`. */
function distributeBlocks(content: string, heads: number[], perBlockTokens: number, note: string): string {
	let out = '';
	let cursor = 0;
	for (const start of heads) {
		out += content.slice(cursor, start); // separator text between blocks
		const headerEnd = content.indexOf('>', start) + 1;
		const closeIdx = content.indexOf('</tool_result>', headerEnd);
		const bodyEnd = closeIdx === -1 ? content.length : closeIdx;
		out += content.slice(start, headerEnd);
		out += shortenBody(content.slice(headerEnd, bodyEnd), perBlockTokens, note);
		cursor = bodyEnd;
	}
	out += content.slice(cursor);
	return out;
}

/** Headers + notes only — the hard floor of block-aware shortening. */
function stubBlocks(content: string, heads: number[], note: string): string {
	let out = '';
	let cursor = 0;
	for (const start of heads) {
		out += content.slice(cursor, start);
		const headerEnd = content.indexOf('>', start) + 1;
		const closeIdx = content.indexOf('</tool_result>', headerEnd);
		const bodyEnd = closeIdx === -1 ? content.length : closeIdx;
		out += content.slice(start, headerEnd) + note;
		cursor = bodyEnd;
	}
	out += content.slice(cursor);
	return out;
}

/** Head+tail elision of one block body within `allowanceTokens`. */
function shortenBody(body: string, allowanceTokens: number, note: string): string {
	// estimateTokens adds a per-message constant (+8) — reserve it first, or
	// every "fitting" shortening estimates one notch OVER its allowance
	const budgetChars = Math.max(0, (allowanceTokens - 8) * 4 - note.length - 40);
	if (budgetChars < 40) {
		return budgetChars <= 0 ? note : `${body.slice(0, budgetChars)}\n${note}`;
	}
	const head = Math.max(1, Math.floor(budgetChars * 0.7));
	const tail = Math.max(1, budgetChars - head);
	return `${body.slice(0, head)}\n${note}\n${body.slice(body.length - tail)}`;
}

/** An assistant message plus the run of tool results it issued — one unit. */
interface IGroup {
	from: number;
	to: number;
	tokens: number;
}

/**
 * Group the payload into atomic interaction units: [assistant, tool_result…]
 * runs move together; user messages stand alone.
 */
function groupify(messages: ILoopBudgetMessage[], tokens: number[]): IGroup[] {
	const groups: IGroup[] = [];
	let i = 0;
	while (i < messages.length) {
		if (messages[i].role === 'assistant') {
			let to = i;
			while (to + 1 < messages.length && messages[to + 1].role === 'user' && isToolResult(messages[to + 1].content)) { to++; }
			groups.push({ from: i, to, tokens: tokens.slice(i, to + 1).reduce((s, t) => s + t, 0) });
			i = to + 1;
		} else {
			groups.push({ from: i, to: i, tokens: tokens[i] });
			i++;
		}
	}
	return groups;
}

function isTruncatableToolResult(messages: ILoopBudgetMessage[], tokens: number[], idx: number, mandatory: Set<number>): boolean {
	// T2: the explicit index is the ONLY kind signal that matters here — a
	// mandatory message is never a truncation victim even when its text starts
	// with `<tool_result` (a pasted log/example must survive verbatim)
	return !mandatory.has(idx)
		&& messages[idx].role === 'user'
		&& isToolResult(messages[idx].content)
		&& !isNotice(messages[idx].content)
		&& tokens[idx] > MIN_TRUNCATED_TOKENS;
}

/**
 * Enforce `availableTokens` over the loop payload. See the module header for
 * the guarantees. `archiveNote` completes the trimming notice's claim about
 * where folded content went (ledger archive vs. nowhere).
 *
 * `currentRequestIdx` (re-review S1): the caller-owned index of the message
 * carrying the current user request — the assembly tracks it by journal seq,
 * so mandatory selection never guesses from message text. When omitted, the
 * newest non-tool-result user message is used (pure/test callers).
 */
export function applyLoopBudget(
	messages: ILoopBudgetMessage[],
	availableTokens: number,
	archiveNote: string,
	opts?: { currentRequestIdx?: number },
): ILoopBudgetResult {
	if (messages.length === 0) { return { messages, foldedCount: 0, truncatedCount: 0, currentRequestIdx: -1 }; }
	const original = messages;
	const notice = `<trimmed_loop_context>Older messages from this turn were trimmed to fit the context window. ${archiveNote}</trimmed_loop_context>`;
	const noticeTokens = estimateTokens(notice);

	// ── mandatory sections ──
	const briefIdx = original.findIndex(m => isBrief(m.content));
	let currentUserIdx = -1;
	if (typeof opts?.currentRequestIdx === 'number' && opts.currentRequestIdx >= 0 && opts.currentRequestIdx < original.length) {
		currentUserIdx = opts.currentRequestIdx;
	} else {
		for (let i = original.length - 1; i >= 0; i--) {
			const m = original[i];
			if (m.role === 'user' && !isToolResult(m.content) && !isNotice(m.content)) { currentUserIdx = i; break; }
		}
	}
	// T2: mandatory identity is index-based, never text-based — these indices
	// are excluded from EVERY truncation path below
	const mandatory = new Set<number>([briefIdx, currentUserIdx].filter(i => i >= 0));
	const mandatoryTokens = [briefIdx, currentUserIdx]
		.filter(i => i >= 0)
		.reduce((s, i) => s + tokensOf(original[i].content), 0);
	if (mandatoryTokens + noticeTokens > availableTokens) {
		return { messages: original, foldedCount: 0, truncatedCount: 0, infeasible: { availableTokens, mandatoryTokens: mandatoryTokens + noticeTokens }, currentRequestIdx: currentUserIdx };
	}

	const tokens = original.map(m => tokensOf(m.content));
	const groups = groupify(original, tokens);
	const truncated = new Set<number>();

	// ── newest-first fill over GROUPS ──
	const budget = availableTokens - noticeTokens;
	let kept = 0;
	let firstKeptGroup = groups.length; // past the end → nothing kept yet
	let briefSeparate = false;
	for (let gi = groups.length - 1; gi >= 0; gi--) {
		const g = groups[gi];
		if (kept + g.tokens <= budget) {
			kept += g.tokens;
			firstKeptGroup = gi;
			continue;
		}
		// the group does not fit — decide its fate
		if (g.from === g.to && g.from === briefIdx) {
			// the brief stays, but as the separate head message — the fold
			// region is everything between it and the kept suffix
			briefSeparate = true;
			break;
		}
		if (g.from === g.to && g.from === currentUserIdx) {
			firstKeptGroup = gi; // mandatory — kept regardless; repaired below
			break;
		}
		// oversized tool activity newer than the current request → shorten
		// the largest result in place rather than dropping the whole group
		if (g.from > currentUserIdx) {
			let largest = -1;
			for (let i = g.from; i <= g.to; i++) {
				if (isTruncatableToolResult(original, tokens, i, mandatory) && (largest < 0 || tokens[i] > tokens[largest])) { largest = i; }
			}
			if (largest >= 0) {
				const rest = g.tokens - tokens[largest];
				const allowance = budget - kept - rest;
				if (allowance >= MIN_TRUNCATED_TOKENS) {
					const newTokens = truncateInPlace(original, tokens, largest, allowance, archiveNote);
					truncated.add(largest);
					kept += rest + newTokens;
					firstKeptGroup = gi;
				}
			}
		}
		break; // budget exhausted — everything older folds
	}

	// ── contiguous kept region ──
	let keepFrom = firstKeptGroup < groups.length ? groups[firstKeptGroup].from : original.length;
	// the current request starts the kept suffix even when its own group
	// "lost" the fill (its newer tool activity was truncated/folded instead)
	if (currentUserIdx >= 0 && keepFrom > currentUserIdx) { keepFrom = currentUserIdx; }
	// the brief is mandatory: when the fill cannot reach it, it survives as
	// the separate head message
	if (briefIdx >= 0 && keepFrom > briefIdx) { briefSeparate = true; }

	// ── final feasibility — repair by truncation before giving up ──
	const briefCost = briefSeparate && briefIdx >= 0 ? tokens[briefIdx] : 0;
	const overBy = () => tokens.slice(keepFrom).reduce((s, t) => s + t, 0) + briefCost + noticeTokens - availableTokens;
	for (let excess = overBy(); excess > 0; excess = overBy()) {
		// S5: reclaim CUMULATIVELY across tool results — the needed savings
		// may be distributable even when no single result can cover them all.
		// Take the largest remaining reduction each round; shorten by exactly
		// what is still missing (capped by that result's savings).
		let victim = -1;
		let bestSavings = 0;
		for (let i = keepFrom; i < original.length; i++) {
			if (!isTruncatableToolResult(original, tokens, i, mandatory)) { continue; }
			const savings = tokens[i] - MIN_TRUNCATED_TOKENS;
			if (savings > bestSavings) { victim = i; bestSavings = savings; }
		}
		if (victim < 0 || bestSavings <= 0) {
			return { messages: original, foldedCount: 0, truncatedCount: 0, infeasible: { availableTokens, mandatoryTokens: mandatoryTokens + noticeTokens }, currentRequestIdx: currentUserIdx };
		}
		const before = tokens[victim];
		const take = Math.min(excess, bestSavings);
		truncateInPlace(original, tokens, victim, tokens[victim] - take, archiveNote);
		// convergence guard: block-distribution overhead can eat a tiny
		// requested saving — a non-shrinking round must NOT loop forever
		if (tokens[victim] >= before) {
			truncateInPlace(original, tokens, victim, MIN_TRUNCATED_TOKENS, archiveNote);
		}
		if (tokens[victim] >= before) {
			return { messages: original, foldedCount: 0, truncatedCount: 0, infeasible: { availableTokens, mandatoryTokens: mandatoryTokens + noticeTokens }, currentRequestIdx: currentUserIdx };
		}
		truncated.add(victim);
	}

	// ── payload ──
	// folded = every index below keepFrom except a separately-kept brief
	const folded = keepFrom - (briefSeparate && briefIdx >= 0 && briefIdx < keepFrom ? 1 : 0);
	if (folded <= 0 && !briefSeparate && truncated.size === 0) {
		return { messages: original, foldedCount: 0, truncatedCount: 0, currentRequestIdx: currentUserIdx };
	}
	const head: ILoopBudgetMessage[] = [];
	if (briefSeparate && briefIdx >= 0) { head.push(original[briefIdx]); }
	const out = [...head, { role: 'user' as const, content: notice }, ...original.slice(keepFrom)];
	// T1: remap the current request's index through the array replacement —
	// keepFrom <= currentUserIdx is enforced above, so the request is always
	// inside the kept suffix
	const remapped = currentUserIdx >= 0
		? head.length + 1 + (currentUserIdx - keepFrom)
		: -1;
	return { messages: out, foldedCount: folded, truncatedCount: truncated.size, currentRequestIdx: remapped };
}
