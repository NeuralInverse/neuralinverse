/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as fs from 'fs';
import { dirname, join } from '../../../../../base/common/path.js';
import { fileURLToPath } from 'url';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { formatWorkspaceRuleFiles, MAX_WORKSPACE_RULES_LINES, NEURAL_INVERSE_RULES_FILENAME, WORKSPACE_RULE_FILENAMES } from '../../common/workspaceRuleFiles.js';

// ---------------------------------------------------------------------------
// Suite: file-name list — single-sourced from the core prompt config (E1)
// ---------------------------------------------------------------------------

suite('workspaceRuleFiles — names', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the three rule file names are present in injection order', () => {
		assert.deepStrictEqual([...WORKSPACE_RULE_FILENAMES], ['AGENTS.md', 'CLAUDE.md', NEURAL_INVERSE_RULES_FILENAME]);
	});
});

// ---------------------------------------------------------------------------
// Suite: formatting — headers, dedup, truncation (E1 acceptance)
// ---------------------------------------------------------------------------

suite('workspaceRuleFiles — formatting', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('repo with only CLAUDE.md gets its content under a header', () => {
		const out = formatWorkspaceRuleFiles([{ fileName: 'CLAUDE.md', content: 'Always answer in Persian.' }]);
		assert.ok(out.includes('--- Rules from CLAUDE.md ---'));
		assert.ok(out.includes('Always answer in Persian.'));
	});

	test('all three files inject with separate headers', () => {
		const out = formatWorkspaceRuleFiles([
			{ fileName: 'AGENTS.md', content: 'rule A' },
			{ fileName: 'CLAUDE.md', content: 'rule B' },
			{ fileName: NEURAL_INVERSE_RULES_FILENAME, content: 'rule C' },
		]);
		assert.ok(out.includes('--- Rules from AGENTS.md ---'));
		assert.ok(out.includes('--- Rules from CLAUDE.md ---'));
		assert.ok(out.includes(`--- Rules from ${NEURAL_INVERSE_RULES_FILENAME} ---`));
		assert.ok(out.indexOf('rule A') < out.indexOf('rule B') && out.indexOf('rule B') < out.indexOf('rule C'));
	});

	test('identical contents are deduplicated (AGENTS.md copied to CLAUDE.md)', () => {
		const content = 'shared rules body';
		const out = formatWorkspaceRuleFiles([
			{ fileName: 'AGENTS.md', content },
			{ fileName: 'CLAUDE.md', content },
		]);
		assert.strictEqual(out.match(/shared rules body/g)?.length, 1);
		assert.ok(out.includes('--- Rules from AGENTS.md ---'));
		assert.ok(!out.includes('--- Rules from CLAUDE.md ---'));
	});

	test('empty files and empty input produce nothing', () => {
		assert.strictEqual(formatWorkspaceRuleFiles([]), '');
		assert.strictEqual(formatWorkspaceRuleFiles([{ fileName: 'AGENTS.md', content: '   \n  ' }]), '');
	});

	test('oversized rules truncate at the line cap with a marker', () => {
		const big = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n');
		const out = formatWorkspaceRuleFiles([{ fileName: 'AGENTS.md', content: big }]);
		const lines = out.split('\n');
		assert.strictEqual(lines.length, MAX_WORKSPACE_RULES_LINES + 1); // cap + marker line
		assert.ok(out.includes(`[... rules truncated at ${MAX_WORKSPACE_RULES_LINES} lines]`));
		assert.ok(!out.includes('line 999'));
	});

	test('the cap applies to the total across files, not per file', () => {
		const half = Array.from({ length: 200 }, (_, i) => `a${i}`).join('\n');
		const out = formatWorkspaceRuleFiles([
			{ fileName: 'AGENTS.md', content: half },
			{ fileName: 'CLAUDE.md', content: half.replace(/a/g, 'b') },
		]);
		assert.ok(out.includes(`[... rules truncated at ${MAX_WORKSPACE_RULES_LINES} lines]`));
		assert.ok(!out.includes('b199'));
	});
});

// ---------------------------------------------------------------------------
// Suite: rule reader — the editor model registry is consulted before disk (R8)
// ---------------------------------------------------------------------------

suite('workspaceRuleFiles — async reader fallback order (R8)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// The reader is DI-heavy (IFileService + two model services), so the
	// fallback ORDER is pinned on the source the same way the parity suites
	// pin wiring: a rule file opened AFTER startup has a live editor model
	// that Void's private map never retained — only the real registry sees it.
	function findRepoRoot(): string {
		let dir = dirname(fileURLToPath(import.meta.url));
		while (true) {
			if (fs.existsSync(join(dir, '.git'))) { return dir; }
			const parent = dirname(dir);
			if (parent === dir) { break; }
			dir = parent;
		}
		throw new Error('Could not locate repo root (.git) above ' + dir);
	}

	const src = fs.readFileSync(join(findRepoRoot(), 'src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts'), 'utf-8');

	test('the async reader checks the editor model registry after the Void map', () => {
		const registryIdx = src.indexOf('this.modelService.getModels()');
		const voidMapIdx = src.indexOf('this.voidModelService.getModel(uri)');
		assert.ok(voidMapIdx !== -1, 'the unsaved-edit path via voidModelService.getModel must stay first');
		assert.ok(registryIdx !== -1, 'convertToLLMMessageService must consult modelService.getModels() — a rule file opened after startup lives only in the editor registry (R8)');
		assert.ok(registryIdx > voidMapIdx, 'the registry check must come after the Void model map but BEFORE the disk read');
		const diskIdx = src.indexOf('this.fileService.readFile(uri)', registryIdx);
		assert.ok(diskIdx > registryIdx, 'the disk fallback must remain the LAST resort');
	});
});
