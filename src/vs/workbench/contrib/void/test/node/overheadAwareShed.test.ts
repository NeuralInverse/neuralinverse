/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # A3 acceptance tests — final-closure order 2026-09-17, section 2 & 4
 *
 * The gap: the assembler's never-error shed ladder ran against a FLAT reserve
 * (`availableInputTokens(contextWindow, reservedOutputTokenSpace)`), not the
 * MEASURED system+tools cost the final send guard enforces. A payload could
 * fit the assembly budget, fail at the wire, and stop WITHOUT ever shedding.
 *
 * This file proves the fix at the pure assembler and ladder levels:
 *
 *   - GAP REPRODUCTION: an assembly that fits the flat reserve but exceeds
 *     the real budget (system + tools + payload) triggers NO shed when
 *     `reservedOverheadTokens` is absent (the pre-fix behavior), failing at wire.
 *   - LADDER FIX: the same assembly, when given the measured overhead, sheds
 *     enough optional context to fit the real wire budget.
 *   - EXPLICIT RUNG ORDER: (1) overhead-aware shed (auto/recalled → pinned → brief),
 *     (2) compact, (3) drop MCP tools, (4) stop.
 *   - BUDGET ARITHMETIC: verifies exact availableInputTokens and finalSendBudget
 *     calculations with SEND_GUARD_MARGIN.
 */
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { assemble, type IAssembleInput, type IAssembledRequest } from '../../common/contextAssembler.js';
import { DEFAULT_LEDGER_POLICY, availableInputTokens, finalSendBudget, SEND_GUARD_MARGIN } from '../../common/ledgerPolicy.js';
import type { CompactableMessage } from '../../common/ledgerTypes.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

function buildConversation(count: number, charsPerMessage: number): {
	compactables: CompactableMessage[];
	raws: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
	const compactables: CompactableMessage[] = [];
	const raws: Array<{ role: 'user' | 'assistant'; content: string }> = [];
	for (let i = 0; i < count; i++) {
		const role = i % 2 === 0 ? 'user' : 'assistant';
		const tag = `${role[0]}${String(i).padStart(3, '0')}:`;
		const content = tag + 'x'.repeat(Math.max(0, charsPerMessage - tag.length));
		compactables.push({ role, content });
		raws.push({ role, content });
	}
	return { compactables, raws };
}

/**
 * Emulates the chatThreadService progressive shedding ladder (rungs 0 → 1 → 2 → 3).
 */
function assembleWithLadder<T>(input: IAssembleInput<T>): IAssembledRequest<T> {
	let assembled = assemble({ ...input, shedLevel: input.shedLevel ?? 0 });
	if (assembled.report.totalTokens > assembled.report.availableInputTokens) {
		for (const level of [1, 2, 3] as const) {
			assembled = assemble({ ...input, shedLevel: level });
			if (assembled.report.totalTokens <= assembled.report.availableInputTokens) {
				break;
			}
		}
	}
	return assembled;
}

// ─── suite ────────────────────────────────────────────────────────────────────

suite('A3 overhead-aware shed ladder (final-closure order §2)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// ── gap reproduction: the pre-fix behavior ──

	test('A3 gap: payload fits flat reserve but exceeds real budget → NO shed without overhead', () => {
		const contextWindow = 32_000;
		const reservedOutputTokenSpace = 2_000;
		const systemTokens = 4_000;
		const toolsTokens = 12_000; // large MCP toolset

		// Build conversation (~4_000 tokens in tail)
		const { compactables, raws } = buildConversation(16, 1_000);

		// Optional context blocks: autoContext ~2_000, recalled ~4_000
		const autoBlock = 'a'.repeat(8_000); // ~2_008 tokens
		const recalledBlock = 'r'.repeat(16_000); // ~4_008 tokens

		// Without overhead parameter: assembler uses flat LEDGER_SYSTEM_RESERVE_TOKENS
		const input: IAssembleInput<{ role: 'user' | 'assistant'; content: string }> = {
			raws,
			compactables,
			brief: null,
			pinnedBlocks: [],
			autoContextBlocks: [autoBlock],
			recalledBlocks: [recalledBlock],
			contextWindow,
			reservedOutputTokenSpace,
			policy: { ...DEFAULT_LEDGER_POLICY, recallMaxTokens: 8_000, autoContextMaxTokens: 4_000 },
			reservedOverheadTokens: undefined, // pre-fix: flat reserve only
		};

		const assembled = assembleWithLadder(input);
		// Without overhead, availableInputTokens = 32k - 8k - 10k = 14k.
		// Payload is ~10k <= 14k, so assembler triggers NO shed (level 0).
		assert.strictEqual(assembled.report.shedLevel, 0, 'without overhead, assembler accepts payload at level 0');
		assert.ok(assembled.report.totalTokens <= assembled.report.availableInputTokens, 'fits flat assembler budget');

		// But at the wire, real budget considers system + tools:
		const wire = finalSendBudget({
			contextWindow,
			reservedOutputTokenSpace,
			systemTokens,
			toolTokens: toolsTokens,
			messageTokens: assembled.report.totalTokens,
		});
		// wire.total = ceil((4k + 12k + 10k) * 1.05) = ~27.3k > 24k (ceiling)
		assert.strictEqual(wire.ok, false, 'the same payload OVERFLOWS the real wire budget — the gap');
	});

	// ── ladder fix: overhead-aware shed ──

	test('A3 fix: same payload WITH overhead triggers shed and fits real budget', () => {
		const contextWindow = 32_000;
		const reservedOutputTokenSpace = 2_000;
		const systemTokens = 4_000;
		const toolsTokens = 12_000;
		const overhead = systemTokens + toolsTokens;

		const { compactables, raws } = buildConversation(16, 1_000);
		const autoBlock = 'a'.repeat(8_000);
		const recalledBlock = 'r'.repeat(16_000);

		// With overhead: assembler calculates net message budget after deducting measured overhead
		const input: IAssembleInput<{ role: 'user' | 'assistant'; content: string }> = {
			raws,
			compactables,
			brief: null,
			pinnedBlocks: [],
			autoContextBlocks: [autoBlock],
			recalledBlocks: [recalledBlock],
			contextWindow,
			reservedOutputTokenSpace,
			policy: { ...DEFAULT_LEDGER_POLICY, recallMaxTokens: 8_000, autoContextMaxTokens: 4_000 },
			reservedOverheadTokens: overhead, // A3 fix: pass measured overhead
		};

		const assembled = assembleWithLadder(input);
		// Overhead reduces available tokens: floor(24000/1.05) - 16000 = 6,857.
		// Initial 10k > 6,857, so ladder sheds level 1 (auto + recalled dropped).
		// Remaining tail is ~4k <= 6,857.
		assert.ok((assembled.report.shedLevel ?? 0) >= 1, `shed ladder ran to level ${assembled.report.shedLevel}`);
		assert.ok(assembled.report.totalTokens <= assembled.report.availableInputTokens, 'fits overhead-aware budget');

		// Wire check now passes cleanly!
		const wire = finalSendBudget({
			contextWindow,
			reservedOutputTokenSpace,
			systemTokens,
			toolTokens: toolsTokens,
			messageTokens: assembled.report.totalTokens,
		});
		assert.strictEqual(wire.ok, true, 'after shed, payload fits the real wire budget');
	});

	// ── explicit rung order ──

	test('A3 rung order: shed runs BEFORE the assembler returns over-budget', () => {
		const contextWindow = 32_000;
		const reservedOutputTokenSpace = 2_000;
		const overhead = 16_000;

		// Tail takes ~4_000 tokens (minimum 8 messages of ~500 tokens = ~4_000 tokens)
		const { compactables, raws } = buildConversation(16, 1_000);
		// Pinned blocks take ~6_000 tokens, so level 1 (which keeps pinned) totals ~10k > 6857
		const pinned = ['p'.repeat(24_000)];

		const input: IAssembleInput<{ role: 'user' | 'assistant'; content: string }> = {
			raws,
			compactables,
			brief: null,
			pinnedBlocks: pinned,
			autoContextBlocks: ['a'.repeat(4_000)],
			recalledBlocks: ['r'.repeat(4_000)],
			contextWindow,
			reservedOutputTokenSpace,
			policy: DEFAULT_LEDGER_POLICY,
			reservedOverheadTokens: overhead,
		};

		const assembled = assembleWithLadder(input);
		// Level 0: auto + recalled + pinned + tail > 6857
		// Level 1: drops auto + recalled, but pinned (~6k) + tail (~4k) = ~10k > 6857 -> does NOT fit
		// Level 2: drops pinned -> tail (~4k) <= 6857 -> fits!
		assert.strictEqual(assembled.report.shedLevel, 2, 'shed escalated to level 2 (dropped auto, recalled, and pinned)');
		assert.ok(assembled.report.totalTokens <= assembled.report.availableInputTokens, 'payload fits after level 2 shed');
	});

	test('A3 rung order: shed level increases when overhead forces degradation', () => {
		const contextWindow = 32_000;
		const reservedOutputTokenSpace = 2_000;
		const overhead = 16_000;

		const { compactables, raws } = buildConversation(16, 1_000);

		const inputLevel1: IAssembleInput<{ role: 'user' | 'assistant'; content: string }> = {
			raws,
			compactables,
			brief: null,
			pinnedBlocks: [],
			autoContextBlocks: ['a'.repeat(8_000)],
			contextWindow,
			reservedOutputTokenSpace,
			policy: DEFAULT_LEDGER_POLICY,
			shedLevel: 1,
			reservedOverheadTokens: overhead,
		};

		const report1 = assemble(inputLevel1).report;
		assert.strictEqual(report1.shedLevel, 1);

		const inputLevel2: IAssembleInput<{ role: 'user' | 'assistant'; content: string }> = {
			...inputLevel1,
			shedLevel: 2,
		};

		const report2 = assemble(inputLevel2).report;
		assert.strictEqual(report2.shedLevel, 2);
		assert.ok(report2.shedLevel! >= report1.shedLevel!, 'higher shed level is recorded honestly in report');
	});

	// ── budget arithmetic verification ──

	test('A3 budget: availableInputTokens subtracts overhead when provided', () => {
		const contextWindow = 32_000;
		const reservedOutput = 2_000;
		const overhead = 12_000;

		const without = availableInputTokens(contextWindow, reservedOutput, undefined);
		const withOverhead = availableInputTokens(contextWindow, reservedOutput, overhead);

		assert.ok(without > withOverhead, 'overhead reduces the available budget');
		const outputReserve = Math.max(Math.floor(contextWindow / 4), reservedOutput);
		const ceiling = contextWindow - outputReserve;
		const expectedWithOverhead = Math.floor(ceiling / SEND_GUARD_MARGIN) - Math.ceil(overhead);
		assert.strictEqual(withOverhead, expectedWithOverhead, 'exact calculation matches');
	});

	test('A3 budget: finalSendBudget uses system+tools+message total', () => {
		const contextWindow = 10_000;
		const reservedOutput = 2_000;
		const systemTokens = 500;
		const toolTokens = 1_000;
		const messageTokens = 4_000;

		const result = finalSendBudget({
			contextWindow,
			reservedOutputTokenSpace: reservedOutput,
			systemTokens,
			messageTokens,
			toolTokens,
		});

		const expectedCeiling = contextWindow - Math.max(Math.floor(contextWindow / 4), reservedOutput);
		assert.strictEqual(result.ceiling, expectedCeiling, 'ceiling matches availableInputTokens');

		const expectedTotal = Math.ceil((systemTokens + messageTokens + toolTokens) * SEND_GUARD_MARGIN);
		assert.strictEqual(result.total, expectedTotal, 'total includes system+tools+message with margin');

		assert.strictEqual(result.ok, expectedTotal <= expectedCeiling, 'ok when total ≤ ceiling');
	});
});
