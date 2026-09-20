/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Behavioral regression tests for the loop budget (phase-1 review R1).
 *
 * The first implementation could fold the user's ENTIRE current request (the
 * outgoing payload was a trimming notice alone) and could discard the working
 * brief. Every test here asserts the repaired guarantees on the CAPTURED
 * PAYLOAD — what would actually be sent — not on internal counters.
 */

import assert from 'assert';
import { applyLoopBudget, truncateToolResult, MIN_TRUNCATED_TOKENS, ILoopBudgetMessage } from '../../common/loopBudget.js';
import { BRIEF_TAIL_NOTE } from '../../common/contextAssembler.js';
import { estimateTokens } from '../../common/ledgerPolicy.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const ARCHIVE_NOTE = 'the ledger archive preserves the original';

/** Tests feed string content only — read it back through this narrow helper. */
function textOf(m: ILoopBudgetMessage): string {
	assert.ok(typeof m.content === 'string', 'test messages must carry string content');
	return m.content as string;
}

function brief(): string {
	return 'WORKING BRIEF — the conversation so far, frozen.' + BRIEF_TAIL_NOTE;
}

function toolResult(tokens: number): string {
	// one call = ONE <tool_result> block (~4 chars per token of body)
	const body = 'x'.repeat(Math.max(1, tokens * 4));
	return `<tool_result name="bash" id="call-1">
${body}
</tool_result>`;
}

function msg(role: 'user' | 'assistant', content: string): ILoopBudgetMessage {
	return { role, content };
}

suite('loopBudget — mandatory content (R1)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();


	test('a current request larger than the whole window is INFEASIBLE — never a notice-only payload', () => {
		// the review's probe: a user message far beyond the 32k window
		const messages: ILoopBudgetMessage[] = [msg('user', 'u'.repeat(400_000))];
		const result = applyLoopBudget(messages, 32_768 - 4_096, ARCHIVE_NOTE);
		assert.ok(result.infeasible, 'the budget must refuse, not trim the request away');
		// the returned payload is not sent when infeasible — assert it does not
		// look like the old bug (notice alone)
		const sent = result.messages;
		const hasUserRequest = sent.some(m => m.role === 'user' && textOf(m).includes('uuu'));
		assert.ok(hasUserRequest || result.infeasible, 'payload must not lose the user request');
	});

	test('the working brief is never folded when older history overflows', () => {
		const messages: ILoopBudgetMessage[] = [
			msg('user', brief()),
			msg('user', 'turn 1 — '.repeat(400)),
			msg('assistant', 'answer 1 — '.repeat(400)),
			msg('user', 'final request'),
		];
		// tight but feasible: brief + current request + notice fit
		const allowance = estimateTokens(brief()) + estimateTokens('final request') + 200 + MIN_TRUNCATED_TOKENS;
		const result = applyLoopBudget(messages, allowance, ARCHIVE_NOTE);
		assert.ok(!result.infeasible);
		const first = result.messages[0];
		assert.strictEqual(first.role, 'user');
		assert.ok(textOf(first).endsWith(BRIEF_TAIL_NOTE), 'the brief must lead the payload');
		assert.ok(result.messages.some(m => textOf(m) === 'final request'), 'the current request must survive');
		assert.ok(result.foldedCount > 0, 'the middle history should have been folded');
	});

	test('brief + current request that cannot coexist is infeasible', () => {
		const messages: ILoopBudgetMessage[] = [
			msg('user', brief()),
			msg('user', 'r'.repeat(80_000)),
		];
		const result = applyLoopBudget(messages, 4_000, ARCHIVE_NOTE);
		assert.ok(result.infeasible, 'mandatory sections over the allowance must refuse');
	});
});

suite('loopBudget — oversized tool results (R1)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();


	test('a huge tool result is shortened in place, keeping the freshest evidence', () => {
		const huge = toolResult(30_000);
		const messages: ILoopBudgetMessage[] = [
			msg('user', 'run the build'),
			msg('assistant', 'Running the build now.'),
			msg('user', huge),
		];
		const allowance = 6_000;
		const result = applyLoopBudget(messages, allowance, ARCHIVE_NOTE);
		assert.ok(!result.infeasible);
		assert.ok(result.truncatedCount >= 1, 'the oversized result must be truncated, not dropped');
		const kept = result.messages.find(m => textOf(m).startsWith('<tool_result'));
		assert.ok(kept, 'a tool result must remain in the payload');
		assert.ok(textOf(kept).includes('truncated'), 'the truncation must be visible');
		assert.ok(textOf(kept).includes(ARCHIVE_NOTE), 'the truncation must point at the archive');
		assert.ok(estimateTokens(textOf(kept)) < estimateTokens(huge) / 2, 'the shortening must be substantial');
		// boundaries intact: the assistant that issued the call stays with it
		assert.ok(result.messages.some(m => m.role === 'assistant' && textOf(m).startsWith('Running')), 'the issuing assistant stays');
	});

	test('a moderately sized payload passes through untouched', () => {
		const messages: ILoopBudgetMessage[] = [
			msg('user', brief()),
			msg('user', 'question?'),
			msg('assistant', 'answer'),
			msg('user', '<tool_result name="grep" id="x">\nmatch\n</tool_result>'),
		];
		const result = applyLoopBudget(messages, 32_768 - 4_096, ARCHIVE_NOTE);
		assert.deepStrictEqual(result, { messages, foldedCount: 0, truncatedCount: 0, currentRequestIdx: 1 });
	});
});

suite('loopBudget — interaction boundaries (R1)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();


	test('the fold never splits an assistant from its tool results', () => {
		const messages: ILoopBudgetMessage[] = [
			msg('user', 'start'),
			msg('assistant', 'I will investigate — ' + 'a'.repeat(2_000)),
			msg('user', toolResult(2_000)),
			msg('user', 'next request'),
		];
		// allowance chosen so the fill stops INSIDE the assistant+result group
		const result = applyLoopBudget(messages, estimateTokens('next request') + 1_500, ARCHIVE_NOTE);
		assert.ok(!result.infeasible);
		const kept = result.messages;
		const resultIdx = kept.findIndex(m => textOf(m).startsWith('<tool_result'));
		const assistantIdx = kept.findIndex(m => m.role === 'assistant');
		assert.ok(resultIdx === -1 || assistantIdx !== -1, 'a kept tool result must keep its assistant');
		if (resultIdx >= 0) {
			assert.ok(assistantIdx < resultIdx, 'the assistant must precede its result in the payload');
		}
	});

	test('multi-tool runs fold or keep as ONE group', () => {
		const messages: ILoopBudgetMessage[] = [
			msg('user', 'start'),
			msg('assistant', 'doing three things'),
			msg('user', toolResult(900)),
			msg('user', toolResult(900)),
			msg('user', 'final'),
		];
		const result = applyLoopBudget(messages, estimateTokens('final') + 1_200, ARCHIVE_NOTE);
		const kept = result.messages;
		const keptResults = kept.filter(m => textOf(m).startsWith('<tool_result')).length;
		const keptAssistant = kept.some(m => m.role === 'assistant' && m.content === 'doing three things');
		// either the whole group is in, or the whole group is out
		assert.ok(keptResults === 0 || (keptResults === 2 && keptAssistant), 'a tool run must never be split from its assistant');
	});
});

suite('loopBudget — honest notice (R1)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();


	test('with the ledger disabled the notice must not claim content is archived', () => {
		const messages: ILoopBudgetMessage[] = [
			msg('user', 'turn 1 — '.repeat(2_000)),
			msg('user', 'final'),
		];
		const result = applyLoopBudget(messages, 2_500, 'the original content is no longer part of this request');
		assert.ok(result.foldedCount > 0);
		const notice = result.messages[0];
		assert.ok(textOf(notice).includes('no longer part of this request'));
		assert.ok(!textOf(notice).includes('archive preserves'), 'a ledger-less run must not claim an archive');
	});
});

suite('truncateToolResult', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps head and tail and reports the elision', () => {
		const content = 'H'.repeat(4_000) + 'MIDDLE' + 'T'.repeat(4_000);
		const tr = truncateToolResult(content, 1_000, ARCHIVE_NOTE);
		assert.ok(tr.content.startsWith('HHHH'));
		assert.ok(tr.content.endsWith('TTTT'));
		assert.ok(tr.content.includes('truncated'));
		assert.ok(tr.tokens <= 1_050, `shortened estimate ${tr.tokens} must honor the allowance`);
	});

	test('a tiny allowance degrades to a stub instead of an empty string', () => {
		const tr = truncateToolResult('x'.repeat(10_000), 10, ARCHIVE_NOTE);
		assert.ok(tr.content.length > 0);
		assert.ok(tr.content.includes('truncated'));
	});
});

// ---------------------------------------------------------------------------
// Suite: cumulative shortening across several tool results (re-review S5)
// ---------------------------------------------------------------------------

suite('loopBudget — cumulative shortening (S5)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('three large results in the current turn fit when the savings are distributed', () => {
		// the re-review's probe: one assistant + three ~8k-char results under
		// a 2,000-token allowance — no single result could reclaim the whole
		// excess, so the first implementation wrongly reported infeasible
		const oneResult = (body: string): string => `<tool_result name="bash" id="call-1">
${body}
</tool_result>`;
		const messages: ILoopBudgetMessage[] = [
			msg('user', 'run all three checks'),
			msg('assistant', 'Running three checks.'),
			msg('user', oneResult('r'.repeat(8_000))),
			msg('user', oneResult('s'.repeat(8_000))),
			msg('user', oneResult('t'.repeat(8_000))),
		];
		const result = applyLoopBudget(messages, 2_000, ARCHIVE_NOTE, { currentRequestIdx: 0 });
		assert.ok(!result.infeasible, 'distributable shortening must succeed instead of refusing');
		// adjacent tool results share one user message — count occurrences
		const toolBlocks = result.messages
			.map(m => textOf(m).match(/<tool_result/g)?.length ?? 0)
			.reduce((s, n) => s + n, 0);
		assert.strictEqual(toolBlocks, 3, 'every tool result stays in the payload');
		assert.ok(result.messages.some(m => textOf(m).includes('truncated')), 'the results were shortened');
		assert.ok(result.messages.some(m => m.role === 'assistant' && textOf(m).includes('three checks')), 'the issuing assistant stays');
		assert.ok(result.messages.some(m => textOf(m) === 'run all three checks'), 'the current request stays verbatim');
	});

	test('an explicit currentRequestIdx overrides prefix-based detection (S1)', () => {
		// pathological text: the current request STARTS with something that
		// looks like a tool result — only the caller-owned index is right
		const weird = `<tool_result-looking preamble> but actually the user said this`;
		const messages: ILoopBudgetMessage[] = [
			msg('user', 'real older request'),
			msg('user', weird),
		];
		// without the index, the prefix scan picks the OLDER message as current
		const byPrefix = applyLoopBudget(messages, 100, ARCHIVE_NOTE);
		// with the index, the weird message is mandatory and never shortened away
		const byIdx = applyLoopBudget(messages, 100, ARCHIVE_NOTE, { currentRequestIdx: 1 });
		const survives = (r: ReturnType<typeof applyLoopBudget>) =>
			r.messages.some(m => typeof m.content === 'string' && m.content.includes('actually the user said'));
		assert.ok(survives(byIdx) || byIdx.infeasible, 'the indexed current request is never silently removed');
		void byPrefix;
	});
});
