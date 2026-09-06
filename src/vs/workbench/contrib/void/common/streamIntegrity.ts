/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Stream Integrity
 *
 * Pure helpers for telling a *completed* LLM stream from one that was cut off
 * mid-response. Kept free of VS Code / SDK imports so the provider impls
 * (electron-main) and the browser layers share one definition, and so the
 * decision is unit-testable without any infrastructure.
 *
 * Why this exists: OpenAI-compatible SSE streams that are closed by the
 * server/proxy without `[DONE]` simply *end* — the async iterator completes
 * without throwing, and whatever partial text arrived is indistinguishable
 * from a finished answer unless the terminal `finish_reason` chunk is checked.
 * Treating a truncated stream as complete made truncated tool-call JSON get
 * silently dropped and the agent stop mid-task with no error.
 */

/** Provider errors that mean "the request does not fit the context window". */
export function isContextOverflowError(message: string | undefined): boolean {
	if (!message) return false
	return /context length|context window|context_length|exceeds?\s+(the\s+)?(maximum\s+)?(context|tokens|input)|maximum.*tokens?|too many tokens|prompt is too long|input.*too long|reduce the length|input_length|MAX_TOKENS/i.test(message)
}

/**
 * Provider errors worth retrying (transient). Anything else should fail fast.
 * Connection-level failures are included on purpose: local endpoints
 * (llama.cpp, ollama, LM Studio, LiteLLM proxies) drop connections under
 * heavy load and recover within seconds — killing the whole agent run on the
 * first blip is worse than one extra attempt.
 */
export function isRetryableLlmError(message: string | undefined): boolean {
	if (!message) return false
	return /\b429\b|rate.?limit|overloaded|quota|timeout|timed out|fetch failed|failed to fetch|network|connection error|connection reset|connection closed|connection terminated|dropped mid-response|stream ended without|socket hang up|terminated|econnreset|econnrefused|econnaborted|enotfound|epipe|\b50[0-4]\b|service unavailable|internal server|temporarily/i.test(message)
}

/**
 * True when a stream produced content but never saw the provider's terminal
 * marker (`finish_reason` on OpenAI-compatible servers, `finishReason` on
 * Gemini) — i.e. the connection was closed mid-response and the content is
 * truncated. Streams with no content at all take the existing empty-response
 * path instead.
 */
export function streamEndedPrematurely(opts: { sawFinishMarker: boolean; hasContent: boolean }): boolean {
	return opts.hasContent && !opts.sawFinishMarker
}

/** The message emitted when a stream is detected truncated. Contains the
 * phrase `isRetryableLlmError` classifies as transient, so callers with a
 * retry loop get one more attempt automatically. */
export function truncatedStreamMessage(receivedChars: number): string {
	return `The connection to the model dropped mid-response — the stream ended after ${receivedChars} characters without a completion marker, so the partial reply was discarded. This is usually a server or proxy closing the connection under heavy load; retrying.`;
}
