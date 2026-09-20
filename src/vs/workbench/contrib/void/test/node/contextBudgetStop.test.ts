/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { assemble, type IAssembleInput } from '../../common/contextAssembler.js';
import { DEFAULT_LEDGER_POLICY, availableInputTokens, estimateTokensOf } from '../../common/ledgerPolicy.js';

/** Structural minimal form of the assembler's plain-message input (the real
 *  `CompactableMessage` lives in the browser layer; only these two fields
 *  feed the budget math). */
type Compactable = { role: 'user' | 'assistant' | 'tool'; content: string };

// ---------------------------------------------------------------------------
// Context-budget followup §3: the deterministic decision boundary of the
// pre-send over-budget stop. The REAL payload construction path is `assemble`
// + `availableInputTokens`; the integration stops the send when
// `report.totalTokens > report.availableInputTokens` even after a forced
// compaction. What is tested here, per model-window cap (8k / 32k / 128k):
//
//   1. the exact effective input ceiling (output reserve + system reserve);
//   2. fittable requests stay within the ceiling at every cap (they must
//      SEND — stopping everything is not an acceptable outcome);
//   3. requests that cannot fit (pathologically large pins, or an unfoldable
//      tail: fewer messages than tailMinMessages) produce an over-budget
//      report — the stop condition — instead of silently "fitting";
//   4. the same corpus that overflows a small cap fits a larger cap.
// ---------------------------------------------------------------------------

/** estimateTokens(text) = ceil(len/4) + 8. */
const TOKENS_PER_MSG = 33;   // content of exactly 100 chars
const CHARS_PER_MSG = 100;

const CAP_8K = 8_192;
const CAP_32K = 32_768;
const CAP_128K = 131_072;

function conversation(count: number, charsPerMessage = CHARS_PER_MSG, roleAt?: (i: number) => Compactable['role']): { compactables: Compactable[]; raws: { i: number }[] } {
	const compactables: Compactable[] = [];
	for (let i = 0; i < count; i++) {
		const role = roleAt ? roleAt(i) : (i % 4 === 0 ? 'user' : (i % 4 === 2 ? 'tool' : 'assistant'));
		const tag = `${role[0]}${String(i).padStart(3, '0')}:`;
		compactables.push({ role, content: tag + 'x'.repeat(charsPerMessage - tag.length) });
	}
	return { compactables, raws: compactables.map((_, i) => ({ i })) };
}

function input<T>(raws: T[], compactables: Compactable[], overrides: Partial<IAssembleInput<T>> = {}): IAssembleInput<T> {
	return {
		raws,
		compactables,
		brief: null,
		contextWindow: CAP_32K,
		policy: DEFAULT_LEDGER_POLICY,
		...overrides,
	};
}

suite('Context budget — effective input ceiling per cap', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('exact ceilings: 8k → 256 (floored), 32k → 14.576, 128k → 88.304', () => {
		// outputReserve = max(window/4, 4_096); then −10_000 system reserve;
		// the 256 floor keeps an 8k window from promising a negative budget.
		assert.strictEqual(availableInputTokens(CAP_8K), 256);
		assert.strictEqual(availableInputTokens(CAP_32K), 14_576);
		assert.strictEqual(availableInputTokens(CAP_128K), 88_304);
	});

	test('reserved-output section = window − available (system + output reserves)', () => {
		for (const window of [CAP_8K, CAP_32K, CAP_128K]) {
			const { report } = assemble(input([], [], { contextWindow: window }));
			// A3 split: output and system+tools reserves are separate sections now;
			// their sum is exactly what the window withholds from input.
			const ro = report.sections.find(s => s.name === 'reserved-output')?.tokens ?? 0;
			const rs = report.sections.find(s => s.name === 'reserved-system')?.tokens ?? 0;
			assert.strictEqual(ro + rs, window - report.availableInputTokens);
		}
	});
});

suite('Context budget — fittable requests must send at every cap', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a small conversation fits even the floored 8k ceiling', () => {
		const { raws, compactables } = conversation(3); // 3 × 33 tokens, below tailMinMessages → nothing folds
		for (const window of [CAP_8K, CAP_32K, CAP_128K]) {
			const { report } = assemble(input(raws, compactables, { contextWindow: window }));
			assert.ok(report.totalTokens <= report.availableInputTokens,
				`cap ${window}: ${report.totalTokens} must fit ${report.availableInputTokens}`);
		}
	});

	test('a long conversation folds into the 32k ceiling and still sends', () => {
		const { raws, compactables } = conversation(40); // ~1_320 tokens
		const { report, keepFromIdx } = assemble(input(raws, compactables, { contextWindow: CAP_32K }));
		assert.ok(report.totalTokens <= report.availableInputTokens);
		assert.ok(keepFromIdx >= 0);
		// sections are the honest accounting: they sum to totalTokens
		const sum = report.sections.filter(s => s.name !== 'reserved-output' && s.name !== 'reserved-system').reduce((a, s) => a + s.tokens, 0);
		assert.strictEqual(sum, report.totalTokens);
	});
});

suite('Context budget — the over-budget stop condition', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('pathologically large pins overflow the small caps (stop condition)', () => {
		const pinnedBlocks = ['x'.repeat(160_000)]; // ≈ 40_008 tokens — over 8k and 32k, under 128k
		const { raws, compactables } = conversation(2);
		for (const window of [CAP_8K, CAP_32K]) {
			const { report } = assemble(input(raws, compactables, { contextWindow: window, pinnedBlocks }));
			assert.ok(report.totalTokens > report.availableInputTokens,
				`cap ${window}: expected an over-budget report, got ${report.totalTokens} <= ${report.availableInputTokens}`);
			assert.strictEqual(report.sections.find(s => s.name === 'pinned')?.tokens, estimateTokensOf(pinnedBlocks));
		}
	});

	test('reproduces the observed 68k-into-32.8k shape: an unfoldable tail cannot be folded away', () => {
		// Fewer messages than tailMinMessages (8) means NO safe fold boundary
		// exists; the giant selection message must stay verbatim and the report
		// honestly shows overflow — this is what the gauge displayed (68.0k /
		// 32.8k, 207%) and what the pre-send stop now intercepts.
		const giantSelection = 57 * 1024; // chars — the retest thread's polluted selection
		const compactables: Compactable[] = [
			{ role: 'user', content: 'u'.repeat(giantSelection) },
			{ role: 'assistant', content: 'a'.repeat(TOKENS_PER_MSG * 4) },
			{ role: 'user', content: 'u'.repeat(CHARS_PER_MSG) },
			{ role: 'assistant', content: 'a'.repeat(CHARS_PER_MSG) },
		];
		const raws = compactables.map((_, i) => ({ i }));
		const { report, keepFromIdx } = assemble(input(raws, compactables, { contextWindow: 32_800 }));
		assert.strictEqual(keepFromIdx, 0, 'nothing can fold with fewer than tailMinMessages');
		assert.ok(report.totalTokens > report.availableInputTokens, 'the unfoldable tail overflows the window');
	});

	test('the same pins that overflow 32k fit 128k — fittable instances still send', () => {
		const pinnedBlocks = ['x'.repeat(200_000)]; // ≈ 50_008 tokens: over 14_576, under 88_304
		const { raws, compactables } = conversation(2);
		const over = assemble(input(raws, compactables, { contextWindow: CAP_32K, pinnedBlocks }));
		assert.ok(over.report.totalTokens > over.report.availableInputTokens);
		const fits = assemble(input(raws, compactables, { contextWindow: CAP_128K, pinnedBlocks }));
		assert.ok(fits.report.totalTokens <= fits.report.availableInputTokens,
			`128k must admit this request: ${fits.report.totalTokens} <= ${fits.report.availableInputTokens}`);
	});
});
