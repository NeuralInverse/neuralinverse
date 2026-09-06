/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License. Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isContextOverflowError, isRetryableLlmError, streamEndedPrematurely, truncatedStreamMessage } from '../../common/streamIntegrity.js';

// ---------------------------------------------------------------------------
// Suite: streamEndedPrematurely — the truncation gate
// ---------------------------------------------------------------------------

suite('streamIntegrity — streamEndedPrematurely', () => {

	test('content received but no finish marker → truncated (the reported bug)', () => {
		// Server/proxy closed the connection mid-response without [DONE]:
		// partial text exists, finish_reason never arrived.
		assert.strictEqual(streamEndedPrematurely({ sawFinishMarker: false, hasContent: true }), true);
	});

	test('content received and finish marker seen → complete', () => {
		assert.strictEqual(streamEndedPrematurely({ sawFinishMarker: true, hasContent: true }), false);
	});

	test('no content and no marker → NOT premature (the empty-response path owns it)', () => {
		// A stream that produced nothing takes the existing empty-stream
		// retry path; the truncation gate must not shadow it.
		assert.strictEqual(streamEndedPrematurely({ sawFinishMarker: false, hasContent: false }), false);
	});

	test('finish marker with no content → NOT premature', () => {
		assert.strictEqual(streamEndedPrematurely({ sawFinishMarker: true, hasContent: false }), false);
	});
});

// ---------------------------------------------------------------------------
// Suite: truncatedStreamMessage ↔ isRetryableLlmError contract
// ---------------------------------------------------------------------------

suite('streamIntegrity — truncation message is retryable', () => {

	test('the emitted message is classified transient so retry loops re-send', () => {
		const msg = truncatedStreamMessage(12_345);
		assert.ok(msg.includes('dropped mid-response'), 'message must carry the classification phrase');
		assert.strictEqual(isRetryableLlmError(msg), true);
		assert.ok(msg.includes('12345'), 'message must state how much was received');
	});
});

// ---------------------------------------------------------------------------
// Suite: isRetryableLlmError — connection-level failures under heavy load
// ---------------------------------------------------------------------------

suite('streamIntegrity — isRetryableLlmError', () => {

	test('OpenAI SDK connection failures are retryable (previously fell through)', () => {
		assert.strictEqual(isRetryableLlmError('Connection error.'), true);
		assert.strictEqual(isRetryableLlmError('Failed to fetch'), true);
		assert.strictEqual(isRetryableLlmError('fetch failed'), true); // already matched before
		assert.strictEqual(isRetryableLlmError('TypeError: terminated'), true);
		assert.strictEqual(isRetryableLlmError('socket hang up'), true);
		assert.strictEqual(isRetryableLlmError('read ECONNRESET'), true);
		assert.strictEqual(isRetryableLlmError('write EPIPE'), true);
	});

	test('rate limits and server errors remain retryable', () => {
		assert.strictEqual(isRetryableLlmError('Error 429: rate limit exceeded'), true);
		assert.strictEqual(isRetryableLlmError('503 Service Unavailable'), true);
		assert.strictEqual(isRetryableLlmError('Request timed out'), true);
	});

	test('auth/validation failures still fail fast', () => {
		assert.strictEqual(isRetryableLlmError('Invalid API key'), false);
		assert.strictEqual(isRetryableLlmError('401 Unauthorized'), false);
		assert.strictEqual(isRetryableLlmError('model not found'), false);
		assert.strictEqual(isRetryableLlmError(''), false);
		assert.strictEqual(isRetryableLlmError(undefined), false);
	});

	test('context overflow stays non-retryable at this layer (has its own recovery)', () => {
		const overflow = "This model's maximum context length is 131072 tokens. However, you requested 150000 tokens.";
		assert.strictEqual(isRetryableLlmError(overflow), false);
		assert.strictEqual(isContextOverflowError(overflow), true);
	});
});
