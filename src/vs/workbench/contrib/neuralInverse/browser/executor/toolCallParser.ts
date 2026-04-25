/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Tool Call Parser
 *
 * Parses tool call invocations from raw LLM response text.
 *
 * Agents signal tool calls by embedding a JSON code block in their response:
 *
 *   ```json
 *   { "tool": "readFile", "args": { "path": "src/index.ts" } }
 *   ```
 *
 * Multiple calls in a single response are supported via a JSON array:
 *
 *   ```json
 *   [
 *     { "tool": "readFile", "args": { "path": "src/index.ts" } },
 *     { "tool": "listDirectory", "args": { "path": "src" } }
 *   ]
 *   ```
 *
 * When no JSON code block is present the response is treated as a final answer.
 */

export interface IParsedToolCall {
	tool: string;
	args: Record<string, unknown>;
}

/**
 * Extract all tool calls from an LLM response string.
 * Returns an empty array if the response is a final answer with no tool calls.
 */
export function parseToolCalls(text: string): IParsedToolCall[] {
	const calls: IParsedToolCall[] = [];

	// Match every ```json ... ``` block in the response
	const blockRegex = /```(?:json)?\s*\n([\s\S]*?)\n\s*```/g;
	let match: RegExpExecArray | null;

	while ((match = blockRegex.exec(text)) !== null) {
		const raw = match[1].trim();
		let parsed: unknown;

		try {
			parsed = JSON.parse(raw);
		} catch {
			continue; // Not valid JSON \u2014 skip this block
		}

		if (Array.isArray(parsed)) {
			// Array of tool calls
			for (const item of parsed) {
				const call = _extractCall(item);
				if (call) calls.push(call);
			}
		} else {
			// Single tool call object
			const call = _extractCall(parsed);
			if (call) calls.push(call);
		}
	}

	return calls;
}

/**
 * Returns true if the text contains at least one parseable tool call.
 */
export function hasToolCalls(text: string): boolean {
	return parseToolCalls(text).length > 0;
}

/**
 * Strip all JSON tool-call blocks from a response to get the prose around them.
 */
export function stripToolCallBlocks(text: string): string {
	return text.replace(/```(?:json)?\s*\n[\s\S]*?\n\s*```/g, '').trim();
}

function _extractCall(obj: unknown): IParsedToolCall | null {
	if (!obj || typeof obj !== 'object') return null;
	const o = obj as Record<string, unknown>;
	if (typeof o['tool'] !== 'string' || !o['tool']) return null;
	const args = (o['args'] && typeof o['args'] === 'object') ? o['args'] as Record<string, unknown> : {};
	return { tool: o['tool'], args };
}
