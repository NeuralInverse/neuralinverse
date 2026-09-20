/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// Contract parity between the two sendLLMMessage implementations (task Q12).
//
// `common/llmMessage/sendLLMMessage.impl.ts` (web) and
// `electron-main/llmMessage/sendLLMMessage.impl.ts` (desktop — the one the
// installed app runs via sendLLMMessageChannel) are manually kept in sync.
// Type checking cannot catch a field that one side forwards and the other
// drops (all OnFinalMessage fields except fullText are optional), which is
// exactly how `usage` silently disappeared from the desktop path.
//
// This test parses the SOURCE of both files, extracts every
// onFinalMessage({ ... }) / newOnFinalMessage({ ... }) object literal and
// asserts the two paths emit the same set of fields at every call site —
// so ANY future drift (usage, toolCalls, a new field, an added/removed
// call site) fails here instead of shipping.
//
// Limitations (deliberate): object literals are scanned with a balanced-
// delimiter parser; braces inside strings/comments inside a literal would
// confuse it, and non-literal calls (`onFinalMessage(x)`) are not seen.
// Neither pattern exists today and both would be unusual here.

import assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMON_IMPL = 'src/vs/workbench/contrib/void/common/llmMessage/sendLLMMessage.impl.ts';
const DESKTOP_IMPL = 'src/vs/workbench/contrib/void/electron-main/llmMessage/sendLLMMessage.impl.ts';

/** Fields the shared OnFinalMessage type (common/sendLLMMessageTypes.ts) defines. */
const ALLOWED_FIELDS = ['fullText', 'fullReasoning', 'anthropicReasoning', 'toolCalls', 'usage'];

interface CallSite {
	/** 1-based source line of the call. */
	line: number;
	/** Sorted top-level field names of the object literal. */
	fields: string[];
}

/**
 * Repo root, found by walking up from this test file. Sentinel is .git, not
 * package.json: the standalone runner (tools/run-tests-standalone.mjs) writes
 * decoy package.json files into its temp emit tree, which sits above the
 * emitted copy of this test and would resolve one level too low.
 */
function findRepoRoot(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	while (true) {
		if (fs.existsSync(path.join(dir, '.git'))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error('Could not locate repo root (.git) above ' + dir);
}

/**
 * Split on commas that sit at depth 0 across (), [] and {} — commas inside
 * nested calls such as `rawToolCallObjOfParamsStr(t.name, t.args, t.id)`
 * must not split a field.
 */
function splitTopLevel(s: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const c of s) {
		if (c === '(' || c === '[' || c === '{') depth++;
		else if (c === ')' || c === ']' || c === '}') depth--;
		if (c === ',' && depth === 0) {
			parts.push(current);
			current = '';
		} else {
			current += c;
		}
	}
	parts.push(current);
	return parts;
}

/** Extract every `onFinalMessage({ ... })` (incl. `newOnFinalMessage`) literal. */
function extractFinalMessageCallSites(source: string): CallSite[] {
	const sites: CallSite[] = [];
	const marker = /nFinalMessage\(\{/g;
	let match: RegExpExecArray | null;
	while ((match = marker.exec(source)) !== null) {
		const objectStart = match.index + match[0].length - 1; // index of '{'
		let depth = 0;
		let objectEnd = -1;
		for (let i = objectStart; i < source.length; i++) {
			const c = source[i];
			if (c === '{') depth++;
			else if (c === '}') {
				depth--;
				if (depth === 0) { objectEnd = i; break; }
			}
		}
		assert.ok(objectEnd !== -1, `unterminated object literal at offset ${objectStart}`);
		const body = source.slice(objectStart + 1, objectEnd);
		const fields: string[] = [];
		for (const part of splitTopLevel(body)) {
			const segment = part.trim();
			if (segment === '' || segment.startsWith('//')) continue;
			const colon = segment.indexOf(':');
			const name = (colon === -1 ? segment : segment.slice(0, colon)).trim();
			if (name !== '') fields.push(name);
		}
		fields.sort();
		sites.push({ line: source.slice(0, match.index).split('\n').length, fields });
	}
	return sites;
}

function readImpl(relPath: string): string {
	const absolute = path.join(findRepoRoot(), relPath);
	return fs.readFileSync(absolute, 'utf-8');
}

function withUsage(sites: CallSite[]): CallSite[] {
	return sites.filter(s => s.fields.includes('usage'));
}

suite('sendLLMMessage parity — final-message contract (web ↔ electron-main)', () => {

	const commonSource = readImpl(COMMON_IMPL);
	const desktopSource = readImpl(DESKTOP_IMPL);
	const commonSites = extractFinalMessageCallSites(commonSource);
	const desktopSites = extractFinalMessageCallSites(desktopSource);

	test('both implementations have the same number of onFinalMessage call sites', () => {
		assert.ok(commonSites.length > 0, `no call sites found in ${COMMON_IMPL} — did the file move?`);
		assert.ok(desktopSites.length > 0, `no call sites found in ${DESKTOP_IMPL} — did the file move?`);
		assert.strictEqual(
			desktopSites.length, commonSites.length,
			`call-site count drifted: web=${commonSites.length} desktop=${desktopSites.length} ` +
			`(web lines: ${commonSites.map(s => s.line).join(', ')}; ` +
			`desktop lines: ${desktopSites.map(s => s.line).join(', ')})`
		);
	});

	test('every call site sends the same set of fields on both paths', () => {
		const count = Math.min(commonSites.length, desktopSites.length);
		for (let i = 0; i < count; i++) {
			const web = commonSites[i];
			const desktop = desktopSites[i];
			assert.deepStrictEqual(
				desktop.fields, web.fields,
				`call site #${i + 1} drifted (web line ${web.line} vs desktop line ${desktop.line}): ` +
				`web=[${web.fields.join(', ')}] desktop=[${desktop.fields.join(', ')}]`
			);
		}
	});

	test('every field name belongs to the shared OnFinalMessage type', () => {
		for (const [label, sites] of [['web', commonSites], ['desktop', desktopSites]] as const) {
			for (const site of sites) {
				for (const field of site.fields) {
					assert.ok(
						ALLOWED_FIELDS.includes(field),
						`${label} line ${site.line} sends unknown field "${field}" — ` +
						`extend OnFinalMessage in common/sendLLMMessageTypes.ts first, then keep both impls in sync`
					);
				}
			}
		}
	});

	test('both chat success paths request and forward real usage', () => {
		// Anchors against a *coordinated* drop: the pairwise tests above pass
		// even if both sides delete `usage`, so pin the two success paths that
		// must carry it (OpenAI-compatible chat + Anthropic chat — the routes
		// the installed desktop app actually runs).
		assert.ok(withUsage(commonSites).length >= 2, `${COMMON_IMPL} must forward usage on the OpenAI-compatible and Anthropic chat success paths`);
		assert.ok(withUsage(desktopSites).length >= 2, `${DESKTOP_IMPL} must forward usage on the OpenAI-compatible and Anthropic chat success paths`);
		// Forwarding is useless unless the stream actually reports usage:
		// stream_options.include_usage makes OpenAI-compatible servers send a
		// final usage chunk (Anthropic always reports usage on finalMessage).
		assert.ok(commonSource.includes('include_usage: true'), `${COMMON_IMPL} must set stream_options.include_usage`);
		assert.ok(desktopSource.includes('include_usage: true'), `${DESKTOP_IMPL} must set stream_options.include_usage`);
	});
});
