/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

/**
 *  B4 auto-context acceptance (task 2026-09-15 §B4): REAL relevance scorer +
 *  REAL context packer + REAL ledger assembler over a multi-file fixture, with
 *  NO active editor — the selection must come from the project map (symbol
 *  matches + import edges), the dependency of the target file must ride along,
 *  a big unrelated file must be dropped, a dependency change must refresh the
 *  selection, and the injected block must be origin-tagged and budget-capped.
 */
import assert from 'assert';
import { Event } from '../../../../../../base/common/event.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { RelevanceScorerService } from '../../../browser/context/relevance/relevanceScorer.js';
import { ContextPackerService } from '../../../browser/context/packer/contextPacker.js';
import { assemble } from '../../../../void/common/contextAssembler.js';
import { DEFAULT_LEDGER_POLICY } from '../../../../void/common/ledgerPolicy.js';
import type { CompactableMessage, IWorkingBrief } from '../../../../void/common/ledgerTypes.js';

const pricingUri = 'file:///ws/src/pricing.ts';
const currencyUri = 'file:///ws/src/currency.ts';
const taxesUri = 'file:///ws/src/taxes.ts';
const unrelatedUri = 'file:///ws/src/unrelated-huge.ts';

const filesOnDisk: Record<string, string> = {
	[pricingUri]: 'export function checkoutTotal() {\n\treturn 42;\n}\n',
	[currencyUri]: 'export function formatMoney(c: number) {\n\treturn `$${c}`;\n}\n',
	[taxesUri]: 'export function applyTax(base: number) {\n\treturn base * 1.09;\n}\n',
	[unrelatedUri]: '// lorem ipsum filler\n'.repeat(4_000),
};

/** Mutable import graph so the test can simulate a dependency change. */
const importsOf: Record<string, string[]> = {
	[pricingUri]: [currencyUri],
};

function makeScorer() {
	const symbolIndex = {
		getSymbolsByName: (name: string) => name.toLowerCase().includes('checkout')
			? [{ name: 'checkoutTotal', kind: 12, filePath: pricingUri, range: { startLine: 1, endLine: 3 } }]
			: [],
		getImports: (uri: string) => importsOf[uri] ?? [],
		getImporters: (uri: string) => Object.entries(importsOf).filter(([, v]) => v.includes(uri)).map(([k]) => k),
		getSymbolsInFile: (uri: string) => symbolsByFile[uri] ?? [],
		getFileIndex: (uri: string) => filesOnDisk[uri] !== undefined ? { uri } : undefined,
	};
	return new RelevanceScorerService(
		{
			activeEditor: undefined, // NO active editor — B4's core requirement
			editors: [], // no open tabs either
			onDidActiveEditorChange: Event.None,
			onDidCloseEditor: Event.None,
		} as never,
		symbolIndex as never,
		{ getCoEditedFiles: () => [], getRecentlyEdited: () => [], getEditHeat: () => 0, getEditVelocity: () => 0, getHotRegions: () => [] } as never,
		{ search: async () => [] } as never,
	);
}

const symbolsByFile: Record<string, Array<{ name: string; kind: number; filePath: string; range: { startLine: number; endLine: number }; exportedAs?: string }>> = {
	[pricingUri]: [{ name: 'checkoutTotal', kind: 12, filePath: pricingUri, range: { startLine: 1, endLine: 3 }, exportedAs: 'checkoutTotal' }],
	[currencyUri]: [{ name: 'formatMoney', kind: 12, filePath: currencyUri, range: { startLine: 1, endLine: 3 }, exportedAs: 'formatMoney' }],
	[taxesUri]: [{ name: 'applyTax', kind: 12, filePath: taxesUri, range: { startLine: 1, endLine: 3 }, exportedAs: 'applyTax' }],
};

function makePacker(scorer: RelevanceScorerService) {
	return new ContextPackerService(
		{
			readFile: async (uri: URI) => {
				const content = filesOnDisk[uri.toString()];
				if (content === undefined) { throw new Error('not found'); }
				return { value: VSBuffer.fromString(content) };
			},
		} as never,
		{ getModel: () => null } as never,
		scorer as never,
		{
			getSymbolsByName: (name: string) => name.toLowerCase().includes('checkout')
				? [{ name: 'checkoutTotal', kind: 12, filePath: pricingUri, range: { startLine: 1, endLine: 3 } }]
				: [],
			getSymbolsInFile: (uri: string) => symbolsByFile[uri] ?? [],
			getImports: (uri: string) => importsOf[uri] ?? [],
		} as never,
		{ getCoEditedFiles: () => [], getRecentlyEdited: () => [], getEditHeat: () => 0, getEditVelocity: () => 0, getHotRegions: () => [] } as never,
	);
}

/** The exact chatThreadService auto-context flow (B4). */
async function materializeAutoContext(queryText: string, scorer: RelevanceScorerService, packer: ContextPackerService): Promise<string[]> {
	const scored = await scorer.scoreFilesAsync({ type: 'message', text: queryText }, 6);
	if (scored.length === 0) { return []; }
	const packed = await packer.packToString({
		query: { type: 'message', text: queryText },
		budget: DEFAULT_LEDGER_POLICY.autoContextMaxTokens,
		mode: 'chat',
	});
	if (packed.trim().length === 0) { return []; }
	return [packed];
}

suite('Auto-context selection — B4 (real scorer + packer + assembler)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('without an active editor the target AND its dependency are retrieved; the big unrelated file is dropped', async () => {
		const scorer = makeScorer();
		const packer = makePacker(scorer);
		try {
			const scored = await scorer.scoreFilesAsync({ type: 'message', text: 'edit the checkout total calculation' }, 6);
			const uris = scored.map(s => s.uri);
			assert.ok(uris.includes(pricingUri), 'the symbol-matched target must be found');
			assert.ok(uris.includes(currencyUri), 'its direct dependency must ride along (import seeding, no active editor)');
			assert.ok(!uris.includes(unrelatedUri), 'the unrelated file must not be a candidate at all');

			const blocks = await materializeAutoContext('edit the checkout total calculation', scorer, packer);
			assert.strictEqual(blocks.length, 1);
			assert.ok(blocks[0].includes('checkoutTotal'), 'the packed block carries the target');
			assert.ok(blocks[0].includes('formatMoney'), 'and the dependency content');
			assert.ok(!blocks[0].includes('lorem ipsum'), 'the unrelated big file is dropped');
		} finally { scorer.dispose(); packer.dispose(); }
	});

	test('a dependency change refreshes the selection after reindex', async () => {
		const scorer = makeScorer();
		const packer = makePacker(scorer);
		try {
			// pricing switches its dependency: currency -> taxes
			importsOf[pricingUri] = [taxesUri];
			const scored = await scorer.scoreFilesAsync({ type: 'message', text: 'edit the checkout total calculation' }, 6);
			const uris = scored.map(s => s.uri);
			assert.ok(uris.includes(taxesUri), 'the NEW dependency is selected');
			assert.ok(!uris.includes(currencyUri), 'the stale dependency is gone');
		} finally { scorer.dispose(); packer.dispose(); importsOf[pricingUri] = [currencyUri]; }
	});

	test('the assembler injects auto-context origin-tagged, budget-capped, and reports its own section', async () => {
		const scorer = makeScorer();
		const packer = makePacker(scorer);
		try {
			const blocks = await materializeAutoContext('edit the checkout total calculation', scorer, packer);
			const raws = [{ role: 'user', content: 'edit the checkout total calculation' }];
			const compactables: CompactableMessage[] = raws.map(m => ({ role: m.role as 'user', content: m.content }));
			const assembled = assemble({
				raws, compactables,
				brief: { threadId: 't', revision: 1, tokens: 100, text: '<working_memory>brief</working_memory>' } as unknown as IWorkingBrief,
				autoContextBlocks: blocks,
				contextWindow: 32_768,
				policy: DEFAULT_LEDGER_POLICY,
			});
			const autoSection = assembled.report.sections.find(s => s.name === 'auto');
			assert.ok(autoSection && autoSection.tokens > 0, 'the auto section is reported for the gauge (origin visibility)');
			assert.ok(autoSection!.tokens <= DEFAULT_LEDGER_POLICY.autoContextMaxTokens, 'auto-context never exceeds its own cap');
			const autoMessage = assembled.messages.find(m => (m as { content?: string }).content?.includes('<auto_context source="relevance">'));
			assert.ok(autoMessage, 'the block is injected with its origin tag');
			assert.ok(assembled.report.totalTokens <= assembled.report.availableInputTokens, 'the whole request stays within the ceiling');
		} finally { scorer.dispose(); packer.dispose(); }
	});

	test('an oversized auto-context block is dropped whole — never partially injected', async () => {
		const raws = [{ role: 'user', content: 'q' }];
		const compactables: CompactableMessage[] = [{ role: 'user', content: 'q' }];
		const assembled = assemble({
			raws, compactables, brief: null,
			autoContextBlocks: ['x'.repeat(DEFAULT_LEDGER_POLICY.autoContextMaxTokens * 4 * 4 + 1)], // ~4x over cap in chars
			contextWindow: 32_768,
			policy: DEFAULT_LEDGER_POLICY,
		});
		const autoSection = assembled.report.sections.find(s => s.name === 'auto');
		assert.strictEqual(autoSection?.tokens ?? 0, 0, 'a block over the cap is dropped whole');
		assert.ok(!assembled.messages.some(m => (m as { content?: string }).content?.includes('<auto_context')), 'nothing is injected');
	});
});
