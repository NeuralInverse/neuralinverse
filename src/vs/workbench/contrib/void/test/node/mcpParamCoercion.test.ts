/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { coerceMCPParamsToSchema } from '../../common/mcpService.js';

// ---------------------------------------------------------------------------
// The clude-memory `recall_memories` inputSchema, captured verbatim from the
// live server (tools/list). The model's tool-call parser produces a map of
// STRINGS, so array-typed params arrive as bare scalars ("episodic") and the
// server rejected them with -32602 "expected array, received string at tags /
// memory_types" (renderer.log 2026-09-14 19:13:40). These tests pin the
// bridge-side coercion that restores the declared shape before the call.
// ---------------------------------------------------------------------------

const RECALL_MEMORIES_SCHEMA = {
	$type: 'http://json-schema.org/draft-07/schema#',
	type: 'object',
	properties: {
		query: { description: 'Text to search', type: 'string' },
		tags: { description: 'Tags to filter by', type: 'array', items: { type: 'string' } },
		memory_types: {
			description: 'Filter by memory type',
			type: 'array',
			items: { type: 'string', enum: ['episodic', 'semantic', 'procedural', 'self_model', 'introspective'] },
		},
		limit: { description: 'Max results', type: 'number', minimum: 1, maximum: 50 },
		track_access: { description: 'Update access timestamps', type: 'boolean' },
		filter: { description: 'structured filter', type: 'object' },
	},
} as unknown as Record<string, unknown>;

suite('coerceMCPParamsToSchema — array params (clude-memory -32602 regression)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('bare string scalar becomes a single-element array (memory_types)', () => {
		const out = coerceMCPParamsToSchema({ query: 'products page', memory_types: 'episodic' }, RECALL_MEMORIES_SCHEMA) as Record<string, unknown>;
		assert.deepStrictEqual(out.memory_types, ['episodic']);
		assert.strictEqual(out.query, 'products page');
	});

	test('bare string scalar becomes a single-element array (tags, no enum)', () => {
		const out = coerceMCPParamsToSchema({ tags: 'escapezoom' }, RECALL_MEMORIES_SCHEMA) as Record<string, unknown>;
		assert.deepStrictEqual(out.tags, ['escapezoom']);
	});

	test('JSON array text is still parsed and kept as-is', () => {
		const out = coerceMCPParamsToSchema({ memory_types: '["episodic","semantic"]' }, RECALL_MEMORIES_SCHEMA) as Record<string, unknown>;
		assert.deepStrictEqual(out.memory_types, ['episodic', 'semantic']);
	});

	test('JSON-encoded scalar string unwraps to a single-element array', () => {
		const out = coerceMCPParamsToSchema({ memory_types: '"episodic"' }, RECALL_MEMORIES_SCHEMA) as Record<string, unknown>;
		assert.deepStrictEqual(out.memory_types, ['episodic']);
	});

	test('comma-joined enum values split into separate entries', () => {
		const out = coerceMCPParamsToSchema({ memory_types: 'episodic, semantic' }, RECALL_MEMORIES_SCHEMA) as Record<string, unknown>;
		assert.deepStrictEqual(out.memory_types, ['episodic', 'semantic']);
	});

	test('partially invalid enum entries are filtered, valid ones survive', () => {
		const out = coerceMCPParamsToSchema({ memory_types: 'episodic,bogus' }, RECALL_MEMORIES_SCHEMA) as Record<string, unknown>;
		assert.deepStrictEqual(out.memory_types, ['episodic']);
	});

	test('all-invalid enum value stays unfiltered so the server names the allowed values', () => {
		// "conversation" is not a valid memory type; the bridge must not invent a
		// silent fallback — the server\'s own -32602 (which lists the enum) is the
		// clear error surfaced back to the model.
		const out = coerceMCPParamsToSchema({ memory_types: 'conversation' }, RECALL_MEMORIES_SCHEMA) as Record<string, unknown>;
		assert.deepStrictEqual(out.memory_types, ['conversation']);
	});

	test('comma strings without an enum schema are never split (tags keep commas)', () => {
		const out = coerceMCPParamsToSchema({ tags: 'page,grid' }, RECALL_MEMORIES_SCHEMA) as Record<string, unknown>;
		assert.deepStrictEqual(out.tags, ['page,grid']);
	});

	test('already-typed values pass through untouched', () => {
		const params = { memory_types: ['episodic'], tags: ['a', 'b'], limit: 5, track_access: false, query: 'q' };
		const out = coerceMCPParamsToSchema(params, RECALL_MEMORIES_SCHEMA) as Record<string, unknown>;
		assert.deepStrictEqual(out, params);
	});

	test('malformed array text falls back to the scalar wrap, never throws', () => {
		const out = coerceMCPParamsToSchema({ tags: '[broken json' }, RECALL_MEMORIES_SCHEMA) as Record<string, unknown>;
		assert.deepStrictEqual(out.tags, ['[broken json']);
	});

	test('empty string is left for the server to reject (no invented empty filter)', () => {
		const out = coerceMCPParamsToSchema({ tags: '' }, RECALL_MEMORIES_SCHEMA) as Record<string, unknown>;
		assert.strictEqual(out.tags, '');
	});

	test('scalar coercions from the previous fix keep working', () => {
		const out = coerceMCPParamsToSchema({ limit: '3', track_access: 'false', filter: '{"k":1}' }, RECALL_MEMORIES_SCHEMA) as Record<string, unknown>;
		assert.strictEqual(out.limit, 3);
		assert.strictEqual(out.track_access, false);
		assert.deepStrictEqual(out.filter, { k: 1 });
	});

	test('non-object params or missing schema are returned as-is', () => {
		assert.strictEqual(coerceMCPParamsToSchema('episodic', RECALL_MEMORIES_SCHEMA), 'episodic');
		assert.deepStrictEqual(coerceMCPParamsToSchema({ memory_types: 'episodic' }, undefined), { memory_types: 'episodic' });
		assert.deepStrictEqual(coerceMCPParamsToSchema({ memory_types: 'episodic' }, {}), { memory_types: 'episodic' });
	});

});
