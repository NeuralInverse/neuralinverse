/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # K-1 acceptance tests — final-closure order 2026-09-17, section 3
 *
 * The non-terminating agent turn (run1 2026-09-16: journal stuck at seq 34 for
 * 30+ min while the router kept streaming fresh fallback content; the next
 * user message was accepted but never answered; Stop was never locally
 * effective) is bounded here at the two node-runnable layers:
 *
 *   - the TERMINATION ENGINE (ChatRequestGuard total cap): a stream that
 *     keeps making FRESH progress cannot outlive a non-resettable ceiling —
 *     proven under fake timers AND against the REAL provider implementation
 *     over real HTTP with an endpoint that streams unique chunks forever and
 *     never finishes (scenario 4's engine);
 *   - the PROVIDER/GRAMMAR LAYER (sendLLMMessage.impl + extractXMLToolsWrapper):
 *     tool XML emitted as PLAIN TEXT must not become a structured tool call
 *     (scenario 3), and a structured tool-call with an UNKNOWN name must
 *     surface as a normal tool call object so the loop's guidance path can
 *     answer it (scenario 1's feed).
 *
 * The FULL loop-level reproduction (all four states separated, Stop from the
 * real UI within 5s with a dead provider abort, and the next message answered
 * in the SAME chat) runs LIVE against the final installed build with the EEP
 * controlled endpoint — the browser-side chat thread service cannot load
 * under plain node (its DI import closure reaches workbench browser modules
 * that require a DOM); that split is deliberate and documented in the
 * final-closure evidence.
 *
 * The product caps are pinned up front (the order demands the fixture record
 * them BEFORE the test).
 */
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import * as sinon from 'sinon';
import { ChatRequestGuard } from '../../common/chatRequestGuard.js';
import {
	CHAT_RETRIES,
	RETRY_DELAY,
	LLM_STREAM_STALL_MS,
	LLM_STREAM_TOTAL_CAP_MS,
	ABORT_LOCAL_SETTLE_MS,
	MAX_AGENT_MESSAGES_SENT,
} from '../../common/agentTurnCaps.js';
import { defaultSettingsOfProvider, type ChatMode } from '../../common/voidSettingsTypes.js';
import type { OnFinalMessage } from '../../common/sendLLMMessageTypes.js';
import { sendLLMMessageToProviderImplementation } from '../../electron-main/llmMessage/sendLLMMessage.impl.js';

// ─── pinned product caps (fixture record, asserted unchanged) ────────────────
const PinnedCaps = {
	CHAT_RETRIES,
	RETRY_DELAY,
	LLM_STREAM_STALL_MS,
	LLM_STREAM_TOTAL_CAP_MS,
	ABORT_LOCAL_SETTLE_MS,
	MAX_AGENT_MESSAGES_SENT,
} as const;

// ─── local controllable endpoint (real HTTP, like contextBudgetSendPath) ─────

interface EndpointHandle {
	port: number;
	close: () => Promise<void>;
}

/** An OpenAI-compatible SSE endpoint whose behavior is scripted per test. */
async function makeScriptedEndpoint(serve: (response: import('http').ServerResponse, body: string) => void): Promise<EndpointHandle> {
	const { createServer } = await import('http');
	const server = createServer((incoming, response) => {
		const chunks: Buffer[] = [];
		incoming.on('data', (c: Buffer) => chunks.push(c));
		incoming.on('end', () => {
			serve(response, Buffer.concat(chunks).toString('utf8'));
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	return {
		port: address.port,
		close: async () => {
			server.closeAllConnections?.();
			await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
		},
	};
}

const sse = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;

/** REAL provider send (the exact impl the app uses over IPC). */
async function realSend(port: number, params: {
	messages: { role: string; content: string }[];
	chatMode?: ChatMode;
	stallMs: number;
	totalMs: number;
}): Promise<{ outcome: string; final: Parameters<OnFinalMessage>[0] | null; diagnostics: { elapsedMs: number; progressCount: number } }> {
	const request = new ChatRequestGuard<Parameters<OnFinalMessage>[0]>(params.stallMs, params.totalMs);
	let final: Parameters<OnFinalMessage>[0] | null = null;
	let abort: (() => void) | undefined;
	try {
		await sendLLMMessageToProviderImplementation.openAICompatible.sendChat({
			providerName: 'openAICompatible',
			modelName: 'fixture-model',
			settingsOfProvider: { ...defaultSettingsOfProvider, openAICompatible: { ...defaultSettingsOfProvider.openAICompatible, endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture-only' } },
			messages: params.messages as never,
			modelSelectionOptions: undefined,
			overridesOfModel: undefined,
			separateSystemMessage: undefined,
			chatMode: params.chatMode ?? null,
			mcpTools: [] as never,
			allowedToolNames: undefined,
			_setAborter: callback => { abort = callback; },
			onText: snapshot => { request.progress(snapshot); },
			onFinalMessage: value => { if (request.complete(value)) { final = value; } },
			onError: error => { request.fail(new Error(error.message)); },
		});
		const result = await request.result;
		return {
			outcome: result.type === 'completed' ? 'completed' : result.type,
			final,
			diagnostics: { elapsedMs: request.diagnostics.elapsedMs, progressCount: request.diagnostics.progressCount },
		};
	} catch {
		return { outcome: 'failed', final, diagnostics: { ...request.diagnostics } };
	} finally {
		request.dispose();
		abort?.();
	}
}

// ─── suite ────────────────────────────────────────────────────────────────────

suite('K-1 agent turn termination (final-closure order §3)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('fixture record: the product caps are the values the acceptance pinned', () => {
		assert.strictEqual(PinnedCaps.CHAT_RETRIES, 3);
		assert.strictEqual(PinnedCaps.RETRY_DELAY, 2500);
		assert.strictEqual(PinnedCaps.LLM_STREAM_STALL_MS, 180_000);
		assert.strictEqual(PinnedCaps.LLM_STREAM_TOTAL_CAP_MS, 1_800_000); // 30 min, non-resettable
		assert.strictEqual(PinnedCaps.ABORT_LOCAL_SETTLE_MS, 2_000); // ≤ the 5s Stop threshold, with margin
		assert.strictEqual(PinnedCaps.MAX_AGENT_MESSAGES_SENT, 50);
	});

	// ── termination engine: guard unit (fake timers, tiny caps) ──

	test('K-1 unit: a stream with constant FRESH progress cannot outlive the total cap', async () => {
		const clock = sinon.useFakeTimers();
		const request = new ChatRequestGuard<string>(1_000, 5_000);
		try {
			let n = 0;
			const ticker = setInterval(() => { n += 1; request.progress({ fullText: `fresh chunk ${n}`, fullReasoning: '' }); }, 500);
			clock.tick(6_000);
			clearInterval(ticker);
			const outcome = await request.result;
			assert.strictEqual(outcome.type, 'stalled', 'the total cap must bound even a healthy-looking stream');
			assert.ok(request.diagnostics.progressCount > 0, 'the stream WAS making progress — the idle timer alone would never have fired');
			assert.ok(request.diagnostics.elapsedMs >= 5_000);
		} finally {
			request.dispose();
			clock.restore();
		}
	});

	test('K-1 unit: after the total cap settles, late progress cannot revive the request', async () => {
		const clock = sinon.useFakeTimers();
		const request = new ChatRequestGuard<string>(1_000, 2_000);
		try {
			clock.tick(2_100);
			assert.strictEqual((await request.result).type, 'stalled');
			assert.strictEqual(request.progress({ fullText: 'late text', fullReasoning: '' }), false, 'a late callback must be rejected');
		} finally {
			request.dispose();
			clock.restore();
		}
	});

	// ── termination engine over the REAL provider impl + real HTTP ──

	test('K-1 S4-engine: REAL impl against an endless fresh stream — the guard bounds it despite constant progress', async () => {
		// the endpoint streams a UNIQUE chunk every 30ms forever: no stall (the
		// idle deadline keeps resetting), no finish, no [DONE] — the run1 L6
		// router-fallback-churn shape
		let n = 0;
		let ticker: ReturnType<typeof setInterval> | undefined;
		const endpoint = await makeScriptedEndpoint((response, _body) => {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			ticker = setInterval(() => {
				n += 1;
				try {
					response.write(sse({ choices: [{ index: 0, delta: { role: 'assistant', content: `unique chunk ${n} ` }, finish_reason: null }] }));
				} catch { clearInterval(ticker); }
			}, 30);
			response.on('close', () => { if (ticker) { clearInterval(ticker); } });
		});
		try {
			const startedAt = Date.now();
			const { outcome, diagnostics } = await realSend(endpoint.port, {
				messages: [{ role: 'user', content: 'status check' }],
				stallMs: 700,
				totalMs: 2_000,
			});
			const elapsed = Date.now() - startedAt;
			assert.strictEqual(outcome, 'stalled', 'the total cap ended the endless stream');
			assert.ok(diagnostics.progressCount > 5, `the stream made constant fresh progress (${diagnostics.progressCount} chunks) — only the total cap could bound it`);
			assert.ok(elapsed < 15_000, `bounded in ${elapsed}ms of wall time`);
		} finally {
			if (ticker) { clearInterval(ticker); }
			await endpoint.close();
		}
	});

	// ── provider/grammar layer: scenarios 1 and 3 feeds ──

	test('K-1 S3: tool XML emitted as PLAIN TEXT is NOT parsed into a tool call', async () => {
		const endpoint = await makeScriptedEndpoint((response, _body) => {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			const xml = '<quantum_frobnicator_v7>\n<target>test</target>\n</quantum_frobnicator_v7>';
			response.write(sse({ choices: [{ index: 0, delta: { role: 'assistant', content: xml }, finish_reason: null }] }));
			response.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
			response.end('data: [DONE]\n\n');
		});
		try {
			// agent mode injects the builtin tool list — the exact grammar the
			// app runs with; an unknown tool's markup must stay TEXT
			const { outcome, final } = await realSend(endpoint.port, {
				messages: [{ role: 'user', content: 'emit the tool xml as text' }],
				chatMode: 'agent',
				stallMs: 5_000,
				totalMs: 10_000,
			});
			assert.strictEqual(outcome, 'completed');
			assert.ok(final, 'a final message arrived');
			assert.ok(!final!.toolCalls || final!.toolCalls.length === 0, 'no tool call was extracted from plain-text XML');
			assert.match(final!.fullText, /quantum_frobnicator_v7/, 'the text passed through verbatim');
		} finally {
			await endpoint.close();
		}
	});

	test('K-1 S1-feed: a structured tool-call with an UNKNOWN name surfaces as a normal tool call (guidance path input)', async () => {
		const endpoint = await makeScriptedEndpoint((response, _body) => {
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			response.write(sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'quantum_frobnicator_v7', arguments: '{"target":"test"}' } }] }, finish_reason: null }] }));
			response.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 2 } }));
			response.end('data: [DONE]\n\n');
		});
		try {
			const { outcome, final } = await realSend(endpoint.port, {
				messages: [{ role: 'user', content: 'invoke the unknown tool' }],
				chatMode: 'agent',
				stallMs: 5_000,
				totalMs: 10_000,
			});
			assert.strictEqual(outcome, 'completed');
			assert.ok(final?.toolCalls && final.toolCalls.length === 1, 'the structured call surfaced');
			assert.strictEqual(final!.toolCalls![0].name, 'quantum_frobnicator_v7');
			assert.deepStrictEqual(final!.toolCalls![0].rawParams, { target: 'test' });
		} finally {
			await endpoint.close();
		}
	});
});
