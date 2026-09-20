/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

/**
 * Layer 6: Progress Feedback Loop
 *
 * After tool execution, wraps the result with explicit continuation prompts
 * to keep OSS models in agentic loop mode. Without this, weak models treat
 * a single tool result as the end of their turn and emit a summary instead
 * of continuing to the next step.
 *
 * The prompts are calibrated to:
 * 1. Reinforce that tool calling is the only valid action
 * 2. Remind the model of the correct format
 * 3. Indicate success/failure so the model knows what to do next
 * 4. Prevent the model from outputting markdown/explanations
 */

/**
 * Wraps a tool result string with feedback that encourages continued execution.
 *
 * `maxPreviewChars`: results longer than this are previewed. The old hard cap
 * of 3000 chars silently destroyed file reads — read_file serves whole pages
 * (up to MAX_FILE_CHARS_PAGE) and reports hasNextPage itself, so the wrapper
 * cut mid-file with no way for the model to fetch the rest (paging past a
 * single-page file returns empty). The default now matches capToolResult
 * (24k), and the marker tells the model exactly how much was held back and
 * how to get it.
 */
export function wrapToolResultForOSS(
	toolName: string,
	success: boolean,
	rawResult: string,
	_remainingTools: number,
	maxPreviewChars: number = 24_000,
): string {
	const statusLine = success
		? `[Tool "${toolName}" completed successfully]`
		: `[Tool "${toolName}" FAILED - see error below]`;

	const resultPreview = rawResult.length > maxPreviewChars
		? rawResult.substring(0, maxPreviewChars)
			+ `\n[... output truncated: showing first ${maxPreviewChars.toLocaleString()} of ${rawResult.length.toLocaleString()} chars — use grep/search_in_file for the rest]`
		: rawResult;

	let continuationPrompt: string;
	if (success) {
		if (toolName === 'bash') {
			continuationPrompt = 'Command succeeded. If there are more steps, call the next tool now. If the task is complete, briefly confirm what was done (1 sentence max). Do NOT repeat the output above.';
		} else if (toolName === 'write') {
			continuationPrompt = 'File written. Continue to the next step (install deps, run commands, create more files). Use <bash> or <write> tool calls. Do NOT output the file contents again.';
		} else if (toolName === 'read') {
			continuationPrompt = 'File contents above. Now act on what you read using tool calls (<edit>, <write>, or <bash>). Do NOT just describe what you see.';
		} else if (toolName === 'edit') {
			continuationPrompt = 'Edit applied. Continue with next changes or verify by running the code. Use tool calls only.';
		} else {
			continuationPrompt = 'Tool succeeded. Continue with the next step using XML tool calls. Do NOT output markdown or explanations. (If the user\'s latest message is a question, answer it in text instead — resume this task only when asked.)';
		}
	} else {
		if (toolName === 'bash') {
			continuationPrompt = 'Command failed. Read the error output above, then fix the issue. Common fixes: install missing packages, fix typos, check paths. Use <bash> to retry or <edit> to fix files. Do NOT explain the error in text.';
		} else if (toolName === 'edit') {
			continuationPrompt = 'Edit failed (likely old_string not found). Use <read> to see the current file content, then retry <edit> with the correct old_string. Do NOT guess.';
		} else {
			continuationPrompt = 'Tool failed. Read the error, fix the issue with another tool call. Do NOT output explanations.';
		}
	}

	return `${statusLine}\n${resultPreview}\n\n---\n${continuationPrompt}`;
}

/**
 * Returns a nudge message to append after all tool results in a step,
 * reminding the model it should keep going.
 */
export function getStepContinuationNudge(toolsExecutedThisStep: number): string {
	if (toolsExecutedThisStep === 0) {
		return 'You have not called any tools yet. The ONLY way to make progress is via XML tool calls like <bash><command>...</command></bash>. Do it now.';
	}
	if (toolsExecutedThisStep >= 5) {
		return 'Good progress. If the task is done, state the result in 1 sentence. If not, continue with tool calls.';
	}
	return `${toolsExecutedThisStep} tool(s) executed. Continue with the next step using XML tool calls. Start with < not with text.`;
}
