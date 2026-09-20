/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
// node-runner benchmark: intentionally drives browser-layer services from the
// standalone node runner (same pattern as virtualContext1m below)
// eslint-disable-next-line local/code-layering, local/code-import-patterns
import type { CompactableMessage } from '../../browser/conversationCompactor.js';
import { assemble, checkPrefixStability, metricName, type IAssembleInput } from '../../common/contextAssembler.js';
import { DEFAULT_LEDGER_POLICY } from '../../common/ledgerPolicy.js';
import type { IContextUsageSection, IEpisodeBody, IWorkingBrief } from '../../common/ledgerTypes.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The exact trailer the assembler appends to the brief text (task M5, 6-5). */
const BRIEF_SUFFIX = '\n\n(Earlier conversation is preserved in the ledger; the most recent messages follow. Use recall_history for exact older content.)';

/** estimateTokens(text) = ceil(len/4) + 8 — fixed message sizes keep the budget math exact. */
const CHARS_33 = 100;      // → 33 tokens per message
const CHARS_508 = 2_000;   // → 508 tokens per message
const CHARS_5008 = 20_000; // → 5_008 tokens per message

/** contextWindow 100_000 + reservedOutputTokenSpace 25_000 → available = 100_000 − 25_000 − 10_000 = 65_000. */
const CONTEXT_WINDOW = 100_000;
const OUTPUT_RESERVE = 25_000;
const AVAILABLE = 65_000;

function episodeBody(): IEpisodeBody {
	return {
		goal: 'goal',
		decisions: [], rejected: [], failures: [], corrections: [], invariants: [],
		artifacts: { files: [], symbols: [], commands: [], configs: [] },
		state: { done: [], inProgress: [], verified: [] },
		next: [], openQuestions: [],
	};
}

function makeBrief(overrides: Partial<IWorkingBrief> = {}): IWorkingBrief {
	return {
		threadId: 'thread-1',
		revision: 3,
		builtFromEpisodes: [1, 2],
		builtAtSeq: 120,
		tokens: 500,
		text: '<working_memory revision="3">brief body</working_memory>',
		merged: episodeBody(),
		...overrides,
	};
}

/**
 * `count` messages of exactly `charsPerMessage` chars. Default role pattern per
 * 4-block: [user, assistant, tool, assistant] — so `user` sits at every index
 * divisible by 4 and assistant→tool pairs span indices (4k+1, 4k+2).
 */
function buildConversation(count: number, charsPerMessage: number, roleAt?: (i: number) => CompactableMessage['role']): { compactables: CompactableMessage[]; raws: { i: number }[] } {
	const compactables: CompactableMessage[] = [];
	for (let i = 0; i < count; i++) {
		const role = roleAt ? roleAt(i) : (i % 4 === 0 ? 'user' : (i % 4 === 2 ? 'tool' : 'assistant'));
		const tag = `${role[0]}${String(i).padStart(3, '0')}:`; // fixed 5 chars → exact content length
		compactables.push({ role, content: tag + 'x'.repeat(charsPerMessage - tag.length) });
	}
	return { compactables, raws: compactables.map((_, i) => ({ i })) };
}

function baseInput<T>(raws: T[], compactables: CompactableMessage[], overrides: Partial<IAssembleInput<T>> = {}): IAssembleInput<T> {
	return {
		raws,
		compactables,
		brief: null,
		contextWindow: CONTEXT_WINDOW,
		reservedOutputTokenSpace: OUTPUT_RESERVE,
		policy: DEFAULT_LEDGER_POLICY,
		...overrides,
	};
}

function sectionTokens(name: IContextUsageSection['name'], sections: IContextUsageSection[]): number {
	const section = sections.find(s => s.name === name);
	assert.ok(section, `section ${name} must exist`);
	return section.tokens;
}

// ---------------------------------------------------------------------------
// Suite: assemble
// ---------------------------------------------------------------------------

suite('contextAssembler — assemble', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('small thread, no brief, no blocks: verbatim passthrough', () => {
		const { compactables, raws } = buildConversation(5, CHARS_33); // 5 × 33 = 165 tokens, fits easily
		const result = assemble(baseInput(raws, compactables));

		assert.strictEqual(result.keepFromIdx, 0);
		assert.strictEqual(result.messages.length, 5);
		assert.strictEqual(result.messages[0], raws[0], 'raws pass through unchanged');
		assert.strictEqual(sectionTokens('tail', result.report.sections), 165);
		assert.strictEqual(sectionTokens('brief', result.report.sections), 0);
		assert.strictEqual(sectionTokens('pinned', result.report.sections), 0);
		assert.strictEqual(sectionTokens('recalled', result.report.sections), 0);
		// A3 split: the two informational reserves are reported separately and
		// together still account for everything the window withholds from input.
		assert.strictEqual(
			sectionTokens('reserved-output', result.report.sections) + sectionTokens('reserved-system', result.report.sections),
			CONTEXT_WINDOW - AVAILABLE);
		assert.strictEqual(result.report.totalTokens, 165);
	});

	test('overflow folds at the oldest user boundary; min tail respected; no-brief fold injects a <ledger_notice> head (M6 item 2)', () => {
		const { compactables, raws } = buildConversation(100, CHARS_508); // 50_800 tokens total
		const result = assemble(baseInput(raws, compactables));

		// tail budget = floor(65_000 · 0.60) = 39_000 → at most floor(39_000 / 508) = 76 messages
		// → oldest user boundary keeping ≤ 76 is index 24 (76 kept ≥ tailMinMessages 8).
		// The notice's ~55 tokens are reserved from the tail budget (upper-bounded by
		// digits(raws.length)), which still admits 76 messages here.
		assert.strictEqual(result.keepFromIdx, 24);
		assert.strictEqual(compactables[result.keepFromIdx].role, 'user', 'fold boundary must land on a user message');
		assert.ok(raws.length - result.keepFromIdx >= DEFAULT_LEDGER_POLICY.tailMinMessages, 'at least tailMinMessages kept verbatim');
		assert.strictEqual(result.messages.length, 77, 'notice head + 76 verbatim tail messages');
		const notice = result.messages[0] as { role: string; content: string };
		assert.strictEqual(notice.role, 'user');
		assert.ok(notice.content.startsWith('<ledger_notice covers_messages="1-24">'), 'notice names the folded message range');
		assert.ok(notice.content.includes('Use recall_history to retrieve any of them.'));
		for (const m of result.messages.slice(1)) {
			assert.ok(!((m as { __ledgerBrief?: boolean }).__ledgerBrief), 'no brief message is emitted when brief is null');
		}
		assert.strictEqual(sectionTokens('tail', result.report.sections), 76 * 508);
		assert.ok(sectionTokens('notice', result.report.sections) > 0);
		assert.ok(result.report.totalTokens <= AVAILABLE, 'notice tokens are reserved from the tail budget, total still fits');
	});

	test('no notice when nothing is folded, even with brief=null (fits-everything passthrough is unchanged)', () => {
		const { compactables, raws } = buildConversation(5, CHARS_33);
		const result = assemble(baseInput(raws, compactables));
		assert.strictEqual(result.keepFromIdx, 0);
		assert.strictEqual(result.messages.length, 5);
		assert.strictEqual(sectionTokens('notice', result.report.sections), 0);
		for (const m of result.messages) {
			assert.ok(!String((m as { content?: string }).content ?? '').includes('<ledger_notice'));
		}
	});

	test('no notice when a brief exists — the brief trailer already points at the ledger', () => {
		const { compactables, raws } = buildConversation(100, CHARS_508);
		const result = assemble(baseInput(raws, compactables, { brief: makeBrief() }));
		assert.ok(result.keepFromIdx > 0);
		assert.strictEqual((result.messages[0] as { __ledgerBrief?: true }).__ledgerBrief, true);
		for (const m of result.messages.slice(1)) {
			assert.ok(!String((m as { content?: string }).content ?? '').includes('<ledger_notice'));
		}
		assert.strictEqual(sectionTokens('notice', result.report.sections), 0);
	});

	test('fold boundary never splits an assistant→tool pair', () => {
		const roles: CompactableMessage['role'][] = ['user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'user', 'assistant', 'tool', 'user', 'assistant', 'tool'];
		const { compactables, raws } = buildConversation(12, CHARS_5008, i => roles[i]);

		// 12 × 5_008 = 60_096 tokens; tailMinMessages 4; tail budget 39_000 → at most
		// 7 messages fit (7 × 5_008 = 35_056), so the raw fit point is index 5 — a tool
		// message mid-pair (4=assistant, 5=tool). The boundary must move to index 6 (user).
		const policy = { ...DEFAULT_LEDGER_POLICY, tailMinMessages: 4 };
		const result = assemble(baseInput(raws, compactables, { policy }));

		assert.strictEqual(compactables[4].role, 'assistant');
		assert.strictEqual(compactables[5].role, 'tool');
		assert.strictEqual(result.keepFromIdx, 6, 'boundary moves past the assistant→tool pair to the next user message');
		assert.strictEqual(compactables[result.keepFromIdx].role, 'user');
		assert.ok(raws.length - result.keepFromIdx >= policy.tailMinMessages);
		// brief=null + folding ⇒ the head is the no-brief notice (M6 item 2),
		// then the tail; pair (4,5) folded whole; pair (7,8) kept whole in the tail
		const first = result.messages[0] as { role: string; content: string };
		assert.ok(first.content.startsWith('<ledger_notice'), 'fold without a brief injects the notice head');
		const tail = result.messages.slice(1) as { i: number }[];
		assert.deepStrictEqual(tail.map(m => m.i), [6, 7, 8, 9, 10, 11]);
	});

	test('brief message comes first with the exact trailer text; briefTokens override respected', () => {
		const { compactables, raws } = buildConversation(6, CHARS_33);
		const brief = makeBrief();
		const result = assemble(baseInput(raws, compactables, { brief }));

		assert.strictEqual(result.keepFromIdx, 0);
		assert.strictEqual(result.messages.length, 7);
		const first = result.messages[0] as { __ledgerBrief?: true; role: string; content: string };
		assert.strictEqual(first.__ledgerBrief, true);
		assert.strictEqual(first.role, 'user');
		assert.strictEqual(first.content, brief.text + BRIEF_SUFFIX);
		assert.strictEqual(sectionTokens('brief', result.report.sections), 500);

		const withOverride = assemble(baseInput(raws, compactables, { brief, briefTokens: 617 }));
		assert.strictEqual(sectionTokens('brief', withOverride.report.sections), 617);
		// raw messages pass through untouched after the brief
		assert.strictEqual((withOverride.messages[1] as { i: number }).i, 0);
	});

	test('pinned and recalled render as single user messages after the brief, in stable order', () => {
		const { compactables, raws } = buildConversation(4, CHARS_33);
		const result = assemble(baseInput(raws, compactables, {
			brief: makeBrief(),
			pinnedBlocks: ['PIN-A', 'PIN-B'],
			recalledBlocks: ['REC-1'],
		}));

		// order: brief → pinned → recalled → tail
		assert.strictEqual(result.messages.length, 7);
		assert.strictEqual((result.messages[0] as { __ledgerBrief?: true }).__ledgerBrief, true);
		assert.strictEqual((result.messages[1] as { role: string; content: string }).content,
			'<pinned_context>\nPIN-A\n</pinned_context>\n\n<pinned_context>\nPIN-B\n</pinned_context>');
		assert.strictEqual((result.messages[2] as { role: string; content: string }).content,
			'<recalled_context source="recall_history">\nREC-1\n</recalled_context>');
		assert.strictEqual((result.messages[3] as { i: number }).i, 0);
	});

	test('recall cap admits whole blocks only — the first overflow block is dropped entirely', () => {
		const { compactables, raws } = buildConversation(3, CHARS_33);
		const block = (c: string) => c.repeat(92); // 92 chars → 31 tokens each
		const policy = { ...DEFAULT_LEDGER_POLICY, recallMaxTokens: 75 };
		const result = assemble(baseInput(raws, compactables, {
			recalledBlocks: [block('1'), block('2'), block('3')],
			policy,
		}));

		// 31 + 31 = 62 ≤ 75; admitting the third would make 93 > 75 → dropped whole.
		const recalled = result.messages[0] as { role: string; content: string };
		assert.strictEqual(recalled.role, 'user');
		assert.ok(recalled.content.includes(block('1')));
		assert.ok(recalled.content.includes(block('2')));
		assert.ok(!recalled.content.includes('3'), 'overflow block dropped whole, never partially');
		assert.strictEqual(sectionTokens('recalled', result.report.sections), 62);
	});

	test('budget math: total stays within available; tail keeps at least tailMinMessages when folding', () => {
		const { compactables, raws } = buildConversation(100, CHARS_508);
		const result = assemble(baseInput(raws, compactables, {
			brief: makeBrief({ tokens: 4_000 }),
			pinnedBlocks: ['p'.repeat(4_000)],                 // 1_008 tokens
			recalledBlocks: ['r'.repeat(4_000), 's'.repeat(4_000)], // 1_008 each → 2_016 (cap 8_000 ok)
		}));

		// fixed = 4_000 + 1_008 + 2_016 = 7_024 → tail budget = 39_000 − 7_024 = 31_976
		// → at most floor(31_976 / 508) = 62 messages → oldest user boundary is index 40 (60 kept).
		assert.strictEqual(result.keepFromIdx, 40);
		assert.strictEqual(compactables[result.keepFromIdx].role, 'user');
		assert.ok(raws.length - result.keepFromIdx >= DEFAULT_LEDGER_POLICY.tailMinMessages);
		assert.strictEqual(sectionTokens('tail', result.report.sections), 60 * 508);

		assert.strictEqual(result.report.availableInputTokens, AVAILABLE);
		assert.strictEqual(result.report.contextWindow, CONTEXT_WINDOW);
		assert.strictEqual(result.report.totalTokens, 4_000 + 1_008 + 2_016 + 60 * 508);
		assert.ok(result.report.totalTokens <= AVAILABLE, 'assembled total must fit the available window');
		// the four input sections sum exactly to totalTokens (reserves are informational)
		const sum = result.report.sections.filter(s => s.name !== 'reserved-output' && s.name !== 'reserved-system').reduce((a, s) => a + s.tokens, 0);
		assert.strictEqual(sum, result.report.totalTokens);
	});

	test('report.cacheStable reflects prevPrefix: a break is flagged only on same-revision drift', () => {
		const { compactables, raws } = buildConversation(4, CHARS_33);
		const brief = makeBrief();

		const first = assemble(baseInput(raws, compactables, { brief }));
		assert.strictEqual(first.report.cacheStable, true, 'no prev prefix → first request is stable');

		const prefix = (first.messages[0] as { content: string }).content;
		const stillStable = assemble(baseInput(raws, compactables, { brief, prevPrefix: { revision: brief.revision, prefix } }));
		assert.strictEqual(stillStable.report.cacheStable, true);

		const broken = assemble(baseInput(raws, compactables, { brief, prevPrefix: { revision: brief.revision, prefix: 'different bytes' } }));
		assert.strictEqual(broken.report.cacheStable, false);

		const bumped = assemble(baseInput(raws, compactables, {
			brief: makeBrief({ revision: brief.revision + 1 }),
			prevPrefix: { revision: brief.revision, prefix },
		}));
		assert.strictEqual(bumped.report.cacheStable, true, 'a revision bump legitimately changes the prefix');
	});
});

// ---------------------------------------------------------------------------
// Suite: shedLevel — the "never error" ladder
// ---------------------------------------------------------------------------

suite('contextAssembler — shedLevel', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// window 25_000 → available = 25_000 − 6_250 (window/4 output reserve) − 10_000 (system reserve) = 8_750
	const SHED_BASE = { contextWindow: 25_000, reservedOutputTokenSpace: 1_000 }; // available = 25_000 - max(6_250, 1_000) - 10_000 = 8_750

	test('level 0 is the default and reports no shedding', () => {
		const { compactables, raws } = buildConversation(5, CHARS_33);
		const result = assemble(baseInput(raws, compactables, { brief: makeBrief() }));
		assert.strictEqual(result.report.shedLevel, 0);
		assert.ok(sectionTokens('brief', result.report.sections) > 0);
	});

	test('level 1 drops auto only — brief, pins and recalled survive (retraction ladder 2026-09-18)', () => {
		const { compactables, raws } = buildConversation(5, CHARS_33);
		const result = assemble(baseInput(raws, compactables, {
			brief: makeBrief(),
			pinnedBlocks: ['p'.repeat(4_000)],           // 1_008 tokens
			recalledBlocks: ['r'.repeat(4_000)],        // 1_008 tokens (under the 8k cap)
			autoContextBlocks: ['a'.repeat(4_000)],     // 1_008 tokens (under the 2_048 cap)
			shedLevel: 1,
		}));
		assert.strictEqual(result.report.shedLevel, 1);
		assert.strictEqual(sectionTokens('auto', result.report.sections), 0);
		assert.strictEqual(sectionTokens('recalled', result.report.sections), 1008, 'recalled survives shedLevel 1 (drops at 2)');
		assert.ok(sectionTokens('brief', result.report.sections) > 0);
		assert.ok(sectionTokens('pinned', result.report.sections) > 0);
		assert.ok(result.messages.some(m => (m as { content: string }).content?.includes('<recalled_context source="recall_history">')));
		assert.ok(!result.messages.some(m => (m as { content: string }).content?.includes('<auto_context')));
		assert.ok(result.messages.some(m => (m as { content: string }).content?.includes('<pinned_context>')));
	});

	test('level 2 also drops pinned blocks', () => {
		const { compactables, raws } = buildConversation(5, CHARS_33);
		const result = assemble(baseInput(raws, compactables, {
			brief: makeBrief(),
			pinnedBlocks: ['p'.repeat(4_000)],
			shedLevel: 2,
		}));
		assert.strictEqual(sectionTokens('pinned', result.report.sections), 0);
		assert.ok(!result.messages.some(m => (m as { content: string }).content?.includes('<pinned_context>')));
		assert.ok(sectionTokens('brief', result.report.sections) > 0, 'brief survives level 2');
	});

	test('level 3 also drops the brief', () => {
		const { compactables, raws } = buildConversation(5, CHARS_33);
		const result = assemble(baseInput(raws, compactables, {
			brief: makeBrief(),
			shedLevel: 3,
		}));
		assert.strictEqual(sectionTokens('brief', result.report.sections), 0);
		assert.ok(!result.messages.some(m => (m as { __ledgerBrief?: boolean }).__ledgerBrief));
	});

	test('recalled survives the ladder longer than auto: fat recalled+auto fits at level 2, not level 1', () => {
		// tail folds to the 8-message minimum (8 × 508 = 4_064 tokens)
		const { compactables, raws } = buildConversation(20, CHARS_508);
		const fat = ['y'.repeat(20_000), 'z'.repeat(8_100)]; // recalled 5_008 (cap-kept) + auto 2_033
		const input: Partial<IAssembleInput<unknown>> = {
			recalledBlocks: [fat[0]],
			autoContextBlocks: [fat[1]],
			...SHED_BASE,
		};
		const overflow = assemble(baseInput(raws, compactables, input));
		// level 0: 5_008 + 2_033 + 4_064 = 11_105 > 8_750
		assert.ok(overflow.report.totalTokens > overflow.report.availableInputTokens, 'fixture must overflow at level 0');
		// level 1 drops auto (2_033) but recalled now survives it: 5_008 + 4_064 = 9_072 > 8_750
		const shed1 = assemble(baseInput(raws, compactables, { ...input, shedLevel: 1 }));
		assert.strictEqual(shed1.report.shedLevel, 1);
		assert.strictEqual(sectionTokens('recalled', shed1.report.sections), 5_008, 'recalled kept at level 1');
		assert.ok(shed1.report.totalTokens > shed1.report.availableInputTokens, 'level 1 cannot shed recalled anymore');
		// level 2 drops recalled → 4_064 ≤ 8_750
		const shed2 = assemble(baseInput(raws, compactables, { ...input, shedLevel: 2 }));
		assert.strictEqual(sectionTokens('recalled', shed2.report.sections), 0);
		assert.ok(shed2.report.totalTokens <= shed2.report.availableInputTokens, 'level 2 must fit');
	});

	test('pinned-driven overflow is resolved at level 2', () => {
		const { compactables, raws } = buildConversation(20, CHARS_508);
		const pins = ['p'.repeat(20_000), 'q'.repeat(20_000)]; // 2 × 5_008 = 10_016
		const input: Partial<IAssembleInput<unknown>> = {
			pinnedBlocks: pins,
			...SHED_BASE,
		};
		const overflow = assemble(baseInput(raws, compactables, input));
		assert.ok(overflow.report.totalTokens > overflow.report.availableInputTokens);
		const level1 = assemble(baseInput(raws, compactables, { ...input, shedLevel: 1 }));
		assert.ok(level1.report.totalTokens > level1.report.availableInputTokens, 'level 1 cannot drop pins');
		const level2 = assemble(baseInput(raws, compactables, { ...input, shedLevel: 2 }));
		assert.ok(level2.report.totalTokens <= level2.report.availableInputTokens, 'level 2 must fit');
	});

	test('brief-driven overflow is resolved at level 3', () => {
		// window 17_000 → available = 17_000 − 4_250 − 10_000 = 2_750
		const { compactables, raws } = buildConversation(5, CHARS_33);
		const bigBrief = makeBrief({ tokens: 4_000, text: 'b'.repeat(16_000) });
		const input: Partial<IAssembleInput<unknown>> = {
			brief: bigBrief,
			contextWindow: 17_000, reservedOutputTokenSpace: 1_000,
		};
		const overflow = assemble(baseInput(raws, compactables, input));
		assert.ok(overflow.report.totalTokens > overflow.report.availableInputTokens);
		const level2 = assemble(baseInput(raws, compactables, { ...input, shedLevel: 2 }));
		assert.ok(level2.report.totalTokens > level2.report.availableInputTokens, 'level 2 keeps the brief');
		const level3 = assemble(baseInput(raws, compactables, { ...input, shedLevel: 3 }));
		assert.ok(level3.report.totalTokens <= level3.report.availableInputTokens, 'level 3 must fit');
	});
});

// ---------------------------------------------------------------------------
// Suite: checkPrefixStability
// ---------------------------------------------------------------------------

suite('contextAssembler — checkPrefixStability', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('first request (prev == null) is stable', () => {
		assert.strictEqual(checkPrefixStability(null, { revision: 1, prefix: 'A' }), true);
	});

	test('same revision, identical prefix bytes is stable', () => {
		assert.strictEqual(checkPrefixStability({ revision: 4, prefix: 'A' }, { revision: 4, prefix: 'A' }), true);
	});

	test('same revision, different prefix bytes is a D5 violation', () => {
		assert.strictEqual(checkPrefixStability({ revision: 4, prefix: 'A' }, { revision: 4, prefix: 'B' }), false);
	});

	test('revision moved forward is stable even though the prefix changed', () => {
		assert.strictEqual(checkPrefixStability({ revision: 4, prefix: 'A' }, { revision: 5, prefix: 'B' }), true);
	});

	test('revision regression is not stable', () => {
		assert.strictEqual(checkPrefixStability({ revision: 5, prefix: 'A' }, { revision: 4, prefix: 'A' }), false);
	});

	test('metricName is the ledger cache-break counter', () => {
		assert.strictEqual(metricName, 'ledger.cacheBreak');
	});
});
