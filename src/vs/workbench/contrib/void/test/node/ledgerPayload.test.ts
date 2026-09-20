/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * INTEGRATION tests: the REAL assembly core feeding the REAL budget core
 * (re-review S1/S3/S5).
 *
 * The re-review proved that testing assembly and budgeting in isolation
 * hides composition bugs: a tool result merged with the current request
 * made the request look like tool output, so the budget shortened it away
 * (S1), and a last-message content check re-appended the request after
 * tool activity (S3). These tests consume assembleLedgerPayload's actual
 * output and run applyLoopBudget over it — the composition the provider
 * sends.
 */

import assert from 'assert';
import { assembleLedgerPayload, INativePayloadMessage } from '../../common/ledgerPayload.js';
import { applyLoopBudget } from '../../common/loopBudget.js';
import { DEFAULT_LEDGER_POLICY } from '../../common/ledgerPolicy.js';
import { ILedgerEntry } from '../../common/ledgerTypes.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const POLICY = DEFAULT_LEDGER_POLICY;
const ARCHIVE_NOTE = 'the ledger archive preserves the original';

let _seq = 0;
function entry(overrides: Partial<ILedgerEntry>): ILedgerEntry {
	const seq = overrides.seq ?? ++_seq;
	return {
		id: `le_t_${seq}`,
		seq,
		threadId: 't',
		role: 'user',
		content: '',
		ts: seq,
		tokens: 10,
		...overrides,
	} as ILedgerEntry;
}

function payload(entries: ILedgerEntry[], current: { message: string; seq: number | null }) {
	return assembleLedgerPayload({
		entries,
		brief: null,
		contextWindow: 32_768,
		reservedOutputTokenSpace: 4_096,
		policy: POLICY,
		current,
	});
}

suite('ledgerPayload → loopBudget — composition (re-review S1/S3/S5)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('S1: a merged tool result can never hide the current request from the budget', () => {
		// the re-review's probe: an old request, a 40k-char tool result, and
		// the current request (3,015 tokens) under a 2,000-token allowance —
		// the merged-message bug classified the request as tool output and
		// shortened it away with infeasible:false
		const marker = 'UNIQUE-CURRENT-INTENT-7f3a';
		const currentMessage = `${marker} ${'c'.repeat(12_000)}`;
		const entries = [
			entry({ role: 'user', content: 'older request about the build' }),
			entry({ role: 'assistant', content: 'Checking now.', meta: { toolCalls: [{ id: 'call-1', name: 'bash' }] } }),
			entry({ role: 'tool', name: 'bash', content: 'x'.repeat(40_000), meta: { toolCallId: 'call-1' } }),
			entry({ role: 'user', content: currentMessage }),
		];
		const currentSeq = entries[entries.length - 1].seq;
		const assembled = payload(entries, { message: currentMessage, seq: currentSeq });
		assert.ok(assembled, 'assembly must produce a payload');

		// the current request is its OWN message — never merged into the
		// preceding tool result
		const currentMsg = assembled.messages[assembled.currentRequestIdx];
		assert.ok(currentMsg, 'the assembly must report a current-request index');
		assert.strictEqual(currentMsg.role, 'user');
		assert.ok(currentMsg.content.startsWith(marker), 'the current request message must START with the request, not a tool result');
		assert.ok(!currentMsg.content.startsWith('<tool_result'), 'a genuine user turn must never be merged into tool output');

		const budgeted = applyLoopBudget(assembled.messages, 2_000, ARCHIVE_NOTE, { currentRequestIdx: assembled.currentRequestIdx });
		// either the payload fits with the request intact, or the budget
		// refuses — what may NEVER happen is a feasible payload whose
		// request was shortened away
		const sent = budgeted.messages;
		const requestSurvives = sent.some(m => typeof m.content === 'string' && m.content.includes(marker));
		if (!budgeted.infeasible) {
			assert.ok(requestSurvives, 'a feasible payload must still carry the current request verbatim');
		}
		assert.ok(requestSurvives || budgeted.infeasible, 'the current request is never silently removed');
	});

	test('S3: after tool activity the current request appears EXACTLY ONCE (no recovery duplicate)', () => {
		// the re-review's probe: journal [current request, assistant call,
		// tool result] with journaled:true — a last-message check decided
		// the request was missing and appended it again
		const marker = 'UNIQUE-REQUEST-91c4';
		const currentMessage = `${marker} please continue`;
		const entries = [
			entry({ role: 'user', content: currentMessage }),
			entry({ role: 'assistant', content: 'Running the tool.', meta: { toolCalls: [{ id: 'call-9', name: 'grep' }] } }),
			entry({ role: 'tool', name: 'grep', content: '3 matches', meta: { toolCallId: 'call-9' } }),
		];
		const currentSeq = entries[0].seq;
		const assembled = payload(entries, { message: currentMessage, seq: currentSeq });
		assert.ok(assembled);
		const occurrences = assembled.messages
			.filter(m => typeof m.content === 'string' && m.content.includes(marker)).length;
		assert.strictEqual(occurrences, 1, 'a journaled current request enters the payload exactly once');
		// the last message is the tool result — the identity must still point
		// at the request sitting EARLIER
		const last = assembled.messages[assembled.messages.length - 1];
		assert.ok(typeof last.content === 'string' && last.content.startsWith('<tool_result'), 'fixture sanity: tool result is last');
		assert.ok(assembled.messages[assembled.currentRequestIdx].content.includes(marker), 'the reported index points at the request');
	});

	test('S3: a FAILED append is repaired exactly once (seq null)', () => {
		const marker = 'UNIQUE-FAILED-APPEND-22e8';
		const currentMessage = `${marker} do the thing`;
		const entries = [
			entry({ role: 'user', content: 'old request' }),
			entry({ role: 'assistant', content: 'old answer' }),
		];
		const assembled = payload(entries, { message: currentMessage, seq: null });
		assert.ok(assembled);
		const occurrences = assembled.messages
			.filter(m => typeof m.content === 'string' && m.content.includes(marker)).length;
		assert.strictEqual(occurrences, 1, 'the repair pushes the request exactly once');
		assert.strictEqual(assembled.messages[assembled.currentRequestIdx].content, currentMessage);
	});

	test('S5: several large tool results in the current turn fit via CUMULATIVE shortening', () => {
		// the re-review's probe: three ~8k-char results under a 2,000-token
		// allowance — no single result could reclaim the whole excess, so the
		// budget wrongly reported infeasible
		const currentMessage = 'run all three checks please';
		const entries = [
			entry({ role: 'user', content: currentMessage }),
			entry({ role: 'assistant', content: 'Running three checks.', meta: { toolCalls: [{ id: 'c1', name: 'bash' }] } }),
			entry({ role: 'tool', name: 'bash', content: 'r'.repeat(8_000), meta: { toolCallId: 'c1' } }),
			entry({ role: 'tool', name: 'bash', content: 's'.repeat(8_000), meta: { toolCallId: 'c1' } }),
			entry({ role: 'tool', name: 'bash', content: 't'.repeat(8_000), meta: { toolCallId: 'c1' } }),
		];
		const assembled = payload(entries, { message: currentMessage, seq: entries[0].seq });
		assert.ok(assembled);
		const budgeted = applyLoopBudget(assembled.messages, 2_000, ARCHIVE_NOTE, { currentRequestIdx: assembled.currentRequestIdx });
		assert.ok(!budgeted.infeasible, 'distributable shortening must succeed instead of refusing');
		// all three results survive (shortened), with their assistant
		// same-turn tool results merge into ONE user message (alternation) —
		// count the <tool_result> occurrences, not the messages
		const toolBlocks = budgeted.messages
			.map(m => typeof m.content === 'string' ? (m.content.match(/<tool_result/g) ?? []).length : 0)
			.reduce((s, n) => s + n, 0);
		assert.strictEqual(toolBlocks, 3, 'every tool result stays in the payload');
		const merged = budgeted.messages.find(m => typeof m.content === 'string' && (m.content as string).includes('truncated'));
		assert.ok(merged, 'the merged tool message was shortened in place');
		assert.ok(budgeted.messages.some(m => m.role === 'assistant' && (m.content as string).includes('three checks')), 'the issuing assistant stays');
		assert.ok(budgeted.messages.some(m => (m.content as string).includes('run all three checks')), 'the current request stays');
	});

	test('tool results still merge together; a user turn splits them (alternation kept, identity kept)', () => {
		const entries = [
			entry({ role: 'user', content: 'first request' }),
			entry({ role: 'assistant', content: 'working', meta: { toolCalls: [{ id: 'a', name: 'bash' }, { id: 'b', name: 'grep' }] } }),
			entry({ role: 'tool', name: 'bash', content: 'out-a', meta: { toolCallId: 'a' } }),
			entry({ role: 'tool', name: 'grep', content: 'out-b', meta: { toolCallId: 'b' } }),
			entry({ role: 'user', content: 'second request' }),
		];
		const assembled = payload(entries, { message: 'second request', seq: entries[entries.length - 1].seq });
		assert.ok(assembled);
		const roles = assembled.messages.map(m => m.role);
		// no two adjacent assistant messages; the two tool results share ONE
		// user message; the second request is its own message
		const mergedResults = assembled.messages.find(m => typeof m.content === 'string' && (m.content as string).includes('out-a'));
		assert.ok(mergedResults && (mergedResults.content as string).includes('out-b'), 'same-turn tool results merge into one message');
		const secondIdx = assembled.messages.findIndex(m => m.content === 'second request');
		assert.strictEqual(secondIdx, assembled.currentRequestIdx);
		assert.ok(roles[secondIdx] === 'user');
		for (let i = 1; i < roles.length; i++) {
			assert.ok(!(roles[i] === 'assistant' && roles[i - 1] === 'assistant'), 'no adjacent assistant messages');
		}
	});
});

suite('ledgerPayload → loopBudget — the provider two-send sequence (re-review T1/T2)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('T1: the second tool-loop send adopts the REMAPPED index and keeps the request', () => {
		// the re-review's probe: two old turns (8k chars each) push the
		// current request to raw index 4; the first budget call trims and the
		// array is REPLACED — the provider must adopt the returned index, or
		// the second send protects whatever message now sits at the stale
		// position (an assistant) and drops the request
		const currentMessage = 'continue the investigation of the failing index write';
		const oldTurn = (q: string) => [
			entry({ role: 'user', content: `${q} ${'o'.repeat(8_000)}` }),
			entry({ role: 'assistant', content: 'old answer '.repeat(700) }),
		];
		const entries = [
			...oldTurn('first old question'),
			...oldTurn('second old question'),
			entry({ role: 'user', content: currentMessage }),
			entry({ role: 'assistant', content: 'Running the first tool.', meta: { toolCalls: [{ id: 'call-1', name: 'bash' }] } }),
			entry({ role: 'tool', name: 'bash', content: 'z'.repeat(2_000), meta: { toolCallId: 'call-1' } }),
		];
		const assembled = payload(entries, { message: currentMessage, seq: entries[4].seq });
		assert.ok(assembled);
		assert.strictEqual(assembled.currentRequestIdx, 4, 'fixture sanity: the request sits after the old turns');

		// the provider's exact loop sequence
		const loopMessages: INativePayloadMessage[] = [...assembled.messages];
		let currentUserIdx = assembled.currentRequestIdx;
		const first = applyLoopBudget(loopMessages, 1_000, ARCHIVE_NOTE, { currentRequestIdx: currentUserIdx });
		assert.ok(!first.infeasible);
		assert.ok(first.foldedCount > 0, 'fixture sanity: the first send trims the old turns');
		loopMessages.length = 0;
		loopMessages.push(...first.messages as INativePayloadMessage[]);
		currentUserIdx = first.currentRequestIdx; // T1: adopt the remapped index
		assert.ok(currentUserIdx >= 0 && loopMessages[currentUserIdx].content === currentMessage,
			'the remapped index must point at the current request in the NEW array');

		// second send: another assistant + result appended after it
		loopMessages.push({ role: 'assistant', content: 'Running the second tool.' });
		loopMessages.push({ role: 'user', content: `<tool_result name="bash" id="call-2">\n${'y'.repeat(4_000)}\n</tool_result>` });
		const second = applyLoopBudget(loopMessages, 1_000, ARCHIVE_NOTE, { currentRequestIdx: currentUserIdx });
		assert.ok(!second.infeasible, 'the second send stays feasible');
		const idx = second.messages.findIndex(m => m.content === currentMessage);
		assert.ok(idx !== -1, 'the second send must still carry the current request VERBATIM');
		assert.strictEqual(idx, second.currentRequestIdx, 'the budget must keep reporting where the request landed');
	});

	test('T2: a request that LOOKS like a tool result is never a truncation victim', () => {
		// the re-review's probe: the user pasted a tool-output example — the
		// mandatory index protects it from folding, but the victim search
		// still classified it by its text prefix and shortened it away
		const currentMessage = `<tool_result name="example">\n${'request-body-'.repeat(160)}\n</tool_result>`;
		const entries = [
			entry({ role: 'user', content: currentMessage }),
			entry({ role: 'assistant', content: 'Inspecting this log output.', meta: { toolCalls: [{ id: 'c1', name: 'bash' }] } }),
			entry({ role: 'tool', name: 'bash', content: 'r'.repeat(8_000), meta: { toolCallId: 'c1' } }),
		];
		const assembled = payload(entries, { message: currentMessage, seq: entries[0].seq });
		assert.ok(assembled);
		assert.strictEqual(assembled.currentRequestIdx, 0, 'a genuine user turn keeps its own message even with a tool-result prefix');

		const budgeted = applyLoopBudget(assembled.messages, 1_500, ARCHIVE_NOTE, { currentRequestIdx: assembled.currentRequestIdx });
		const sentTexts = budgeted.messages.map(m => String(m.content));
		assert.ok(!budgeted.infeasible);
		assert.strictEqual(sentTexts[budgeted.currentRequestIdx], currentMessage,
			'the prefix-looking request must survive byte-for-byte');
		assert.ok(budgeted.truncatedCount >= 1, 'the REAL oversized tool result is what gets shortened');
		assert.ok(sentTexts.some(t => t !== currentMessage && t.includes('truncated')),
			'the truncation landed on the tool result, not the request');

		// tighter than the request + minimum viable history → refuse; never
		// shorten the request to fit (the exact probe shape: mandatory content
		// must not be sacrificed to stay feasible)
		const refusing = applyLoopBudget(assembled.messages, 800, ARCHIVE_NOTE, { currentRequestIdx: assembled.currentRequestIdx });
		const refusedTexts = refusing.messages.map(m => String(m.content));
		if (refusing.infeasible) {
			assert.strictEqual(refusedTexts[refusing.currentRequestIdx], currentMessage,
				'the refused payload still carries the request untouched');
		} else {
			assert.strictEqual(refusedTexts[refusing.currentRequestIdx], currentMessage,
				'even a feasible outcome must keep the request verbatim');
		}
	});
});
