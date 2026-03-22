/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

let _counter = 0;

/**
 * Generate a short unique ID with an optional prefix.
 * Format: `<prefix>-<base36-timestamp><base36-counter>`
 * e.g. `tm-lz3k4a0`, `nd-lz3k4a1`
 */
export function generateId(prefix: string): string {
	const ts  = Date.now().toString(36);
	const cnt = (_counter++ & 0xffff).toString(36).padStart(3, '0');
	return `${prefix}-${ts}${cnt}`;
}

/**
 * Format an IAgentToolCallResult as a JSON string for LLM consumption.
 * Adds a `_summary` field so the model sees the human-readable summary inline.
 */
export function formatToolResult(result: { success: boolean; data?: unknown; error?: string; summary?: string }): string {
	if (!result.success) {
		return JSON.stringify({ success: false, error: result.error });
	}
	const out: Record<string, unknown> = { success: true };
	if (result.summary)  { out['_summary'] = result.summary; }
	if (result.data !== undefined) { out['data'] = result.data; }
	return JSON.stringify(out, null, 2);
}
