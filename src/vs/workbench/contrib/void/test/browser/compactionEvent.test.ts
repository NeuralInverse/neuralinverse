/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { renderConversationSummaryMessage, ConversationCompactor, type CompactableMessage } from '../../browser/conversationCompactor.js';
import type { ModelSelection } from '../../common/voidSettingsTypes.js';
import type { ILLMMessageService } from '../../common/sendLLMMessageService.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

// ---------------------------------------------------------------------------
// Task C7 — compaction UX contract tests.
//
// These tests verify the pieces that B1 is built on:
//   - renderConversationSummaryMessage wraps the summary in the canonical tag
//   - ConversationCompactor.compactIfNeeded fires with correct token estimates
//   - the ICompactionResult shape matches what onDidCompact carries
//
// The full UI flow (slash command, toast, SummaryCard) is React-side and
// needs a running workbench — documented in the report as owner-testing.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MODEL: ModelSelection = { providerName: 'openAI', modelName: 'gpt-4o' };

function makeMessages(n: number): CompactableMessage[] {
	const msgs: CompactableMessage[] = [];
	for (let i = 0; i < n; i++) {
		msgs.push({
			role: i % 2 === 0 ? 'user' : 'assistant',
			content: `Message ${i}: `.padEnd(200, 'x'),
		});
	}
	return msgs;
}

/** Minimal shape of the sendLLMMessage opts the compactor passes. */
interface MockSendOpts {
	onFinalMessage: (p: { fullText: string }) => void;
	onError?: (p: { message?: string; fullError?: { message?: string } }) => void;
	onText?: (p: { fullText: string }) => void;
	onAbort?: () => void;
}

/** Mock ILLMMessageService that resolves the summarization call synchronously. */
function mockLlmService(summary: string): ILLMMessageService {
	return {
		sendLLMMessage(opts: MockSendOpts) {
			opts.onFinalMessage({ fullText: summary });
		},
	} as unknown as ILLMMessageService;
}

// ---------------------------------------------------------------------------
// Suite: renderConversationSummaryMessage
// ---------------------------------------------------------------------------

suite('compaction C7 — renderConversationSummaryMessage', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('wraps summary in <conversation_summary> tags', () => {
		const result = renderConversationSummaryMessage('did stuff');
		assert.ok(result.startsWith('<conversation_summary>'), 'must start with the tag');
		assert.ok(result.includes('</conversation_summary>'), 'must close the tag');
		assert.ok(result.includes('did stuff'), 'must contain the summary text');
	});

	test('includes continuation instruction for the model', () => {
		const result = renderConversationSummaryMessage('summary');
		assert.ok(result.includes('summarized above'), 'must tell the model history was summarized');
	});
});

// ---------------------------------------------------------------------------
// Suite: ConversationCompactor token accounting + compaction result
// ---------------------------------------------------------------------------

suite('compaction C7 — ConversationCompactor', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('estimateTextTokens is deterministic (chars/4 + overhead)', () => {
		const text = 'a'.repeat(400);
		const tokens = ConversationCompactor.estimateTextTokens(text);
		assert.strictEqual(tokens, Math.ceil(400 / 4) + 8);
	});

	test('estimateTokens sums per-message estimates', () => {
		const msgs = makeMessages(3);
		const total = new ConversationCompactor(mockLlmService('')).estimateTokens(msgs);
		const perMsg = ConversationCompactor.estimateTextTokens(msgs[0].content);
		assert.strictEqual(total, perMsg * 3);
	});

	test('compactIfNeeded leaves a thread below the token threshold intact', async () => {
		const compactor = new ConversationCompactor(mockLlmService('summary'));
		const msgs = makeMessages(3); // well below 8 minimum
		const result = await compactor.compactIfNeeded({
			messages: msgs,
			contextWindow: 128_000,
			modelSelection: MODEL,
			cacheKey: 'test',
			force: false, // not forced → returns noCompact immediately
		});
		assert.strictEqual(result.keepFromIdx, 0, 'small thread should not compact');
		assert.strictEqual(result.summary, undefined, 'no summary for small thread');
	});

	test('automatically compacts a large older turn even in a three-message thread', async () => {
		const compactor = new ConversationCompactor(mockLlmService('Earlier work summary'));
		const messages = makeMessages(3);
		messages[0].content = 'x'.repeat(80_000);
		const result = await compactor.compactIfNeeded({ messages, contextWindow: 32_768, modelSelection: MODEL });
		assert.deepStrictEqual({ boundary: result.keepFromIdx, fits: result.tokensAfter < 14_576 }, { boundary: 2, fits: true });
	});

	test('moves the boundary forward when the preferred tail exceeds the budget', async () => {
		const compactor = new ConversationCompactor(mockLlmService('Earlier work summary'));
		const messages = makeMessages(20);
		messages[12].content = 'x'.repeat(80_000);
		const result = await compactor.compactIfNeeded({ messages, contextWindow: 32_768, modelSelection: MODEL, force: true });
		assert.deepStrictEqual({ boundary: result.keepFromIdx, fits: result.tokensAfter < 14_576 }, { boundary: 14, fits: true });
	});

	test('does not discard an oversized current request to claim a fit', async () => {
		const compactor = new ConversationCompactor(mockLlmService('Earlier work summary'));
		const messages = makeMessages(3);
		messages[2].content = 'x'.repeat(80_000);
		const result = await compactor.compactIfNeeded({ messages, contextWindow: 32_768, modelSelection: MODEL, force: true });
		assert.deepStrictEqual({ boundary: result.keepFromIdx, fits: result.tokensAfter < 14_576 }, { boundary: 2, fits: false });
	});

	test('compactIfNeeded produces a summary with token estimates for a large thread', async () => {
		const compactor = new ConversationCompactor(mockLlmService('The user worked on tests.'));
		const msgs = makeMessages(20); // above minimum
		const result = await compactor.compactIfNeeded({
			messages: msgs,
			contextWindow: 500, // tiny window forces compaction
			modelSelection: MODEL,
			cacheKey: 'test-large',
			force: true,
		});
		assert.ok(result.tokensBefore > 0, 'tokensBefore must be > 0');
		assert.ok(result.tokensAfter >= 0, 'tokensAfter must be >= 0');
		assert.ok(result.tokensBefore >= result.tokensAfter,
			'compaction must not increase token count');
	});

	test('compactIfNeeded caches summaries per cacheKey', async () => {
		let callCount = 0;
		const llmService: ILLMMessageService = {
			sendLLMMessage(opts: MockSendOpts) {
				callCount++;
				opts.onFinalMessage({ fullText: 'summary' });
			},
		} as unknown as ILLMMessageService;
		const compactor = new ConversationCompactor(llmService);
		const msgs = makeMessages(20);
		const opts = { messages: msgs, contextWindow: 500, modelSelection: MODEL, cacheKey: 'cache-test', force: true };
		await compactor.compactIfNeeded(opts);
		await compactor.compactIfNeeded(opts);
		// second call should hit cache (same prefix → same summary)
		assert.ok(callCount <= 1, 'second compactIfNeeded on same prefix should not call LLM again');
	});
});

// ---------------------------------------------------------------------------
// Suite: onDidCompact event contract
// ---------------------------------------------------------------------------

suite('compaction C7 — onDidCompact contract', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the result shape from compactIfNeeded matches what onDidCompact carries', async () => {
		const compactor = new ConversationCompactor(mockLlmService('summary text'));
		const msgs = makeMessages(20);
		const result = await compactor.compactIfNeeded({
			messages: msgs,
			contextWindow: 500,
			modelSelection: MODEL,
			cacheKey: 'contract-test',
			force: true,
		});
		// onDidCompact carries { tokensBefore, tokensAfter, summary }
		// these come straight from the ICompactionResult
		assert.ok(typeof result.tokensBefore === 'number');
		assert.ok(typeof result.tokensAfter === 'number');
		assert.ok(typeof result.summary === 'string');
	});
});
