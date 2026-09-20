/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Native ledger payload assembly — the pure core (F01, re-review S1/S3)
 *
 * Extracted from voidModelProvider._assembleNativePayload so the OUTPUT can
 * be integration-tested against the real budget core: the re-review proved
 * that testing assembly and budgeting in isolation hides composition bugs
 * (a tool result merged with the current request made the request look like
 * tool output, so the budget could shorten it away).
 *
 * Identity rules (S1/S3):
 *   - message KIND is explicit through assembly: only TOOL-RESULT blocks
 *     merge into a preceding user-side message (Anthropic alternation); a
 *     genuine user turn ALWAYS starts its own message — never merged into
 *     tool output, never identified later by an XML-looking prefix;
 *   - the current request is tracked by its JOURNAL SEQ (the append
 *     receipt), not by content sniffing of the last message — after tool
 *     activity the current request legitimately sits earlier in the
 *     payload, and a last-message check re-appended it (S3);
 *   - a failed append (seq === null) is repaired by pushing the request
 *     exactly once; a journaled request is NEVER pushed again.
 */

import { ILedgerEntry, IWorkingBrief, CompactableMessage } from './ledgerTypes.js';
import { ILedgerPolicy } from './ledgerPolicy.js';
import { assemble } from './contextAssembler.js';

/** Provider-shaped plain message (the loop's working shape). */
export interface INativePayloadMessage {
	role: 'user' | 'assistant';
	content: string;
}

export interface ILedgerPayloadInput {
	/** the journal window (coveredSeq+1 .. lastSeq), blobs already spliced */
	entries: ILedgerEntry[];
	brief: IWorkingBrief | null;
	contextWindow: number;
	reservedOutputTokenSpace?: number | null;
	policy: ILedgerPolicy;
	/**
	 * The current request: its text, and the journal seq of its appended
	 * entry — null when the append failed (the assembly then repairs the
	 * payload by pushing the message exactly once).
	 */
	current: { message: string; seq: number | null };
}

export interface ILedgerPayloadResult {
	messages: INativePayloadMessage[];
	/** index into `messages` carrying the current request — the budget's mandatory anchor */
	currentRequestIdx: number;
	/** the assembler's usage report, for the caller's honest console line */
	sections: { name: string; tokens: number }[];
	totalTokens: number;
	availableInputTokens: number;
}

/** Render one tool result block with its original call id (R7). */
function renderToolResult(e: ILedgerEntry): string {
	const callId = typeof e.meta?.toolCallId === 'string' && e.meta.toolCallId ? e.meta.toolCallId : undefined;
	return `<tool_result${e.name ? ` name="${e.name}"` : ''}${callId ? ` id="${callId}"` : ''}>\n${e.content}\n</tool_result>`;
}

/**
 * Build the native payload from the journal window. Pure; never throws on
 * content — a journal without renderable entries yields `null` and the
 * caller falls back to the session rebuild.
 */
export function assembleLedgerPayload(input: ILedgerPayloadInput): ILedgerPayloadResult | null {
	const { entries, brief, policy, current } = input;

	const raws: INativePayloadMessage[] = [];
	const compactables: CompactableMessage[] = [];
	let currentRequestIdx = -1;

	const pushTurn = (role: 'user' | 'assistant', content: string, ledgerRole: 'user' | 'assistant' | 'tool') => {
		raws.push({ role, content });
		compactables.push({ role: ledgerRole, content });
	};
	const appendToolResult = (content: string) => {
		// S1: ONLY tool results merge into a preceding user-side message —
		// a genuine user turn always starts its own message so its identity
		// survives into the budget's mandatory selection
		const prev = raws[raws.length - 1];
		const ledgerPrev = compactables[compactables.length - 1];
		if (prev?.role === 'user' && ledgerPrev?.role !== 'assistant') {
			prev.content = `${prev.content}\n\n${content}`;
			ledgerPrev.content = `${ledgerPrev.content}\n\n${content}`;
			return;
		}
		pushTurn('user', content, 'tool');
	};

	for (const e of entries) {
		if (e.role === 'user') {
			pushTurn('user', e.content, 'user');
			if (current.seq !== null && e.seq === current.seq) { currentRequestIdx = raws.length - 1; }
		} else if (e.role === 'assistant') {
			// R7: an assistant entry that issued tool calls renders its
			// tool-call side, so the following <tool_result id> pairs up
			const calls = Array.isArray(e.meta?.toolCalls) ? e.meta.toolCalls : [];
			const callLines = calls.filter(c => typeof c?.name === 'string').map(c => `<tool_call id="${c.id}" name="${c.name}" />`);
			pushTurn('assistant', callLines.length > 0 ? `${e.content}\n${callLines.join('\n')}` : e.content, 'assistant');
		} else if (e.role === 'tool') {
			appendToolResult(renderToolResult(e));
		}
		// system/note entries never enter the payload
	}
	if (raws.length === 0) { return null; }

	// S3: the current request enters EXACTLY once — from the journal when the
	// append succeeded (wherever it sits), repaired at the end only when it
	// failed or the window genuinely does not contain it
	if (currentRequestIdx < 0) {
		if (current.seq !== null) {
			// journaled but not in this window (hole/edge): fall back to an
			// exact-content scan before repairing — never send without it,
			// never duplicate it
			currentRequestIdx = raws.findIndex(m => m.role === 'user' && m.content === current.message);
		}
		if (currentRequestIdx < 0) {
			pushTurn('user', current.message, 'user');
			currentRequestIdx = raws.length - 1;
		}
	}

	const assembled = assemble<INativePayloadMessage>({
		raws,
		compactables,
		brief,
		contextWindow: input.contextWindow,
		reservedOutputTokenSpace: input.reservedOutputTokenSpace,
		policy,
	});
	const tailLen = raws.length - assembled.keepFromIdx;
	const headMsgs = assembled.messages.slice(0, assembled.messages.length - tailLen);
	const head = headMsgs.map(m => ({ role: 'user' as const, content: (m as { content: string }).content }));
	const messages = [...head, ...raws.slice(assembled.keepFromIdx)];
	// the fold may have consumed the current request's raw index — recompute
	// by identity against the final payload
	let finalIdx = messages.length - 1;
	if (assembled.keepFromIdx <= currentRequestIdx) {
		finalIdx = head.length + (currentRequestIdx - assembled.keepFromIdx);
	} else {
		// the assembler folded the current request: it MUST be re-anchored.
		// assemble() keeps the newest messages, so this only happens when the
		// request itself was inside the folded prefix — push it back, once.
		messages.push(raws[currentRequestIdx]);
		finalIdx = messages.length - 1;
	}
	return {
		messages,
		currentRequestIdx: finalIdx,
		sections: assembled.report.sections,
		totalTokens: assembled.report.totalTokens,
		availableInputTokens: assembled.report.availableInputTokens,
	};
}
