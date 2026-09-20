/*--------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------*/

/**
 *  A3 send-path integration (task 2026-09-15 §A3): the REAL provider request
 *  implementation (electron-main sendLLMMessage.impl, OpenAI-compatible
 *  streaming) against a controllable local HTTP endpoint that counts every
 *  request and captures the exact body — plus the REAL pure budget functions
 *  the chat service uses at its final send boundary (finalSendBudget /
 *  rawFallbackDecision / estimateTokens / assemble / availableTools). Not
 *  assemble-only: every "sent" case proves an HTTP request reached the
 *  endpoint with a body that fits the ceiling, and every "stopped" case
 *  proves the endpoint counter stayed at zero.
 */
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ChatRequestGuard } from '../../common/chatRequestGuard.js';
import { defaultSettingsOfProvider, type ChatMode } from '../../common/voidSettingsTypes.js';
import type { OnFinalMessage } from '../../common/sendLLMMessageTypes.js';
import { sendLLMMessageToProviderImplementation } from '../../electron-main/llmMessage/sendLLMMessage.impl.js';
import { assemble } from '../../common/contextAssembler.js';
import { availableTools } from '../../common/prompt/prompts.js';
import { DEFAULT_LEDGER_POLICY, estimateTokens, estimateTokensOf, finalSendBudget, rawFallbackDecision } from '../../common/ledgerPolicy.js';
import type { CompactableMessage, IWorkingBrief } from '../../common/ledgerTypes.js';

// ─── local controllable endpoint ─────────────────────────────────────────────

interface CapturedRequest {
	body: string;
	estTokens: number;
}

async function makeEndpoint(): Promise<{
	requests: CapturedRequest[];
	port: number;
	close: () => Promise<void>;
}> {
	const { createServer } = await import('http');
	const requests: CapturedRequest[] = [];
	let abort: (() => void) | undefined;
	const server = createServer((incoming, response) => {
		const chunks: Buffer[] = [];
		incoming.on('data', (c: Buffer) => chunks.push(c));
		incoming.on('end', () => {
			const body = Buffer.concat(chunks).toString('utf8');
			requests.push({ body, estTokens: estimateTokens(body) });
			response.writeHead(200, { 'Content-Type': 'text/event-stream' });
			response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`);
			response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 1 } })}\n\n`);
			response.end('data: [DONE]\n\n');
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	return {
		requests,
		port: address.port,
		close: async () => {
			abort?.();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
		},
	};
}

/** REAL provider send (the exact impl the app uses over IPC). chatMode drives
 *  the builtin-tool injection exactly as in production agent requests. */
async function realSend(port: number, params: {
	messages: { role: string; content: string }[];
	systemMessage?: string;
	mcpTools?: unknown[];
	chatMode?: ChatMode;
}): Promise<'completed' | 'failed'> {
	const request = new ChatRequestGuard<Parameters<OnFinalMessage>[0]>(20_000);
	let abort: (() => void) | undefined;
	try {
		await sendLLMMessageToProviderImplementation.openAICompatible.sendChat({
			providerName: 'openAICompatible',
			modelName: 'fixture-model',
			settingsOfProvider: { ...defaultSettingsOfProvider, openAICompatible: { ...defaultSettingsOfProvider.openAICompatible, endpoint: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture-only' } },
			messages: params.messages as never,
			modelSelectionOptions: undefined,
			overridesOfModel: undefined,
			separateSystemMessage: params.systemMessage,
			chatMode: params.chatMode ?? null,
			mcpTools: (params.mcpTools ?? []) as never,
			allowedToolNames: undefined,
			_setAborter: callback => { abort = callback; },
			onText: snapshot => { request.progress(snapshot); },
			onFinalMessage: value => { request.complete(value); },
			onError: error => { request.fail(new Error(error.message)); },
		});
		const result = await request.result;
		return result.type === 'completed' ? 'completed' : 'failed';
	} catch {
		return 'failed';
	} finally {
		request.dispose();
		abort?.();
	}
}

// ─── fixtures ────────────────────────────────────────────────────────────────

/** The EXACT tool list the provider impl serializes for a chat mode — the
 *  chat service's final guard measures this same merge (availableTools). */
function serializedToolsOf(chatMode: ChatMode | null): unknown[] {
	return availableTools(chatMode, [], undefined) ?? [];
}

/** Same boundary math the chat service runs before sendLLMMessage (A3). */
function guardOf(payload: {
	systemMessage?: string;
	messages: { content: string }[];
	chatMode?: ChatMode | null;
}, contextWindow: number): { ok: boolean; total: number; ceiling: number; toolTokens: number } {
	const toolTokens = payload.chatMode !== undefined && payload.chatMode !== null
		? estimateTokens(JSON.stringify(serializedToolsOf(payload.chatMode)))
		: 0;
	const budget = finalSendBudget({
		systemTokens: payload.systemMessage !== undefined ? estimateTokens(payload.systemMessage) : 0,
		messageTokens: estimateTokensOf(payload.messages.map(m => m.content)),
		toolTokens,
		contextWindow,
	});
	return { ...budget, toolTokens };
}

const englishCorpus = (messages: number, charsPerMessage: number) =>
	Array.from({ length: messages }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(charsPerMessage) + ` turn ${i} ` }));

const persianCorpus = (messages: number, charsPerMessage: number) =>
	Array.from({ length: messages }, (_, i) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'سلام این یک متن آزمایشی است. '.repeat(Math.ceil(charsPerMessage / 31)) + ` نوبت ${i}` }));

function toolPairTurns(rounds: number, resultChars: number): { role: string; content: string }[] {
	const out: { role: string; content: string }[] = [];
	for (let i = 0; i < rounds; i++) {
		out.push({ role: 'user', content: `run round ${i}` });
		out.push({ role: 'assistant', content: '' });
		out.push({ role: 'tool', content: 'r'.repeat(resultChars) + ` round ${i}` });
	}
	out.push({ role: 'user', content: 'summarize the rounds' });
	return out;
}

suite('Context budget — REAL send path against a controllable endpoint (A3)', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a fittable request REALLY sends at 32k/128k (agent tools included) and the endpoint body fits the ceiling', async () => {
		const endpoint = await makeEndpoint();
		try {
			for (const window of [32_768, 131_072]) {
				const before = endpoint.requests.length;
				const ceiling = finalSendBudget({ systemTokens: 0, messageTokens: 0, toolTokens: 0, contextWindow: window }).ceiling;
				const guard0 = guardOf({ chatMode: 'agent', messages: [] }, window);
				// corpus fills a share of the space the agent tools leave free
				const free = ceiling - guard0.toolTokens - 200;
				assert.ok(free > 0, `agent builtin tools must leave room at ${window}`);
				const msgs = englishCorpus(12, Math.floor(free * 0.35 * 4 / 12));
				const payload = { systemMessage: 'You are a fixture agent.', messages: msgs, chatMode: 'agent' as const };
				const guard = guardOf(payload, window);
				assert.strictEqual(guard.ok, true, `corpus sized for ${window} must pass the guard (total ${guard.total} / ceiling ${guard.ceiling})`);
				assert.strictEqual(await realSend(endpoint.port, payload), 'completed');
				assert.strictEqual(endpoint.requests.length, before + 1, `exactly one endpoint request at window ${window}`);
				const captured = endpoint.requests[endpoint.requests.length - 1];
				const parsed = JSON.parse(captured.body) as { tools?: unknown[] };
				assert.ok(parsed.tools && parsed.tools.length > 0, 'agent mode really serializes its builtin tools');
				assert.ok(captured.estTokens <= guard.ceiling, `captured endpoint body (~${captured.estTokens}) must fit the ${window}-window ceiling ${guard.ceiling}`);
			}
		} finally { await endpoint.close(); }
	});

	test('a valid 8k config sends: no-tool chat fits and reaches the endpoint', async () => {
		const endpoint = await makeEndpoint();
		try {
			const window = 8_192;
			const ceiling = finalSendBudget({ systemTokens: 0, messageTokens: 0, toolTokens: 0, contextWindow: window }).ceiling;
			const msgs = englishCorpus(4, 500);
			const payload = { systemMessage: 'You are a fixture assistant.', messages: msgs };
			const guard = guardOf(payload, window);
			assert.strictEqual(guard.ok, true, `a small no-tool chat must fit 8k (total ${guard.total}/${ceiling})`);
			assert.strictEqual(await realSend(endpoint.port, payload), 'completed');
			assert.strictEqual(endpoint.requests.length, 1);
		} finally { await endpoint.close(); }
	});

	test('agent mode at 8k is detected as incompatible (builtin tools alone overflow) — zero endpoint traffic; the same corpus sends at 32k', async () => {
		const endpoint = await makeEndpoint();
		try {
			const guard8k = guardOf({ chatMode: 'agent', messages: englishCorpus(2, 100) }, 8_192);
			assert.strictEqual(guard8k.ok, false, 'agent builtin tool schemas + output reserve cannot fit an 8k window');
			assert.ok(guard8k.toolTokens > guard8k.ceiling / 2, `tool tokens (${guard8k.toolTokens}) must dominate the 8k failure`);
			// the service stops here — no sendChat call, so the endpoint sees nothing
			assert.strictEqual(endpoint.requests.length, 0);

			const guard32k = guardOf({ chatMode: 'agent', messages: englishCorpus(2, 100) }, 32_768);
			assert.strictEqual(guard32k.ok, true, 'the same payload is fine on a 32k window');
			assert.strictEqual(await realSend(endpoint.port, { messages: englishCorpus(2, 100), chatMode: 'agent' }), 'completed');
			assert.strictEqual(endpoint.requests.length, 1);
		} finally { await endpoint.close(); }
	});

	test('an inherently unsendable no-tool request is stopped BEFORE any endpoint traffic; a smaller follow-up still sends', async () => {
		const endpoint = await makeEndpoint();
		try {
			const window = 8_192;
			const huge = { systemMessage: 'sys', messages: englishCorpus(6, 6_000) };
			const guard = guardOf(huge, window);
			assert.strictEqual(guard.ok, false, '6 x ~6k chars at an 8k window cannot fit');
			// the service stops here — the endpoint stays untouched
			assert.strictEqual(endpoint.requests.length, 0);

			// a test that stops everything is invalid: a small request in the
			// same window succeeds right after the stop
			const small = { systemMessage: 'sys', messages: englishCorpus(2, 200) };
			assert.strictEqual(guardOf(small, window).ok, true);
			assert.strictEqual(await realSend(endpoint.port, small), 'completed');
			assert.strictEqual(endpoint.requests.length, 1);
		} finally { await endpoint.close(); }
	});

	test('switching the same payload to a small window flips the guard — no send happens', async () => {
		const endpoint = await makeEndpoint();
		try {
			const payload = { systemMessage: 'sys', messages: englishCorpus(10, 2_500) };
			assert.strictEqual(guardOf(payload, 131_072).ok, true, 'fits a 128k window');
			const small = guardOf(payload, 8_192);
			assert.strictEqual(small.ok, false, 'the same payload must not ship at 8k');
			// (no realSend call for the small window — endpoint stays at zero)
			assert.strictEqual(endpoint.requests.length, 0);
		} finally { await endpoint.close(); }
	});

	test('oversized MCP tool schemas are caught at 8k on top of the builtins — the 256 floor never licenses a fake send', async () => {
		const endpoint = await makeEndpoint();
		try {
			const bigTools = Array.from({ length: 8 }, (_, i) => ({
				name: `tool_${i}`, description: 'd'.repeat(1_500),
				parameters: { type: 'object', properties: Object.fromEntries(Array.from({ length: 20 }, (_, j) => [`p${j}`, { type: 'string', description: 'x'.repeat(80) }])) },
			}));
			// guard with the merged set (builtins + big MCP tools)
			const merged = [...(availableTools('agent', [], undefined) ?? []), ...bigTools];
			const toolTokens = estimateTokens(JSON.stringify(merged));
			const guard = finalSendBudget({
				systemTokens: estimateTokens('sys'),
				messageTokens: estimateTokensOf(englishCorpus(2, 100).map(m => m.content)),
				toolTokens, contextWindow: 8_192,
			});
			assert.strictEqual(guard.ok, false, 'system+tools alone must exceed the 8k input ceiling');
			assert.ok(toolTokens > guard.ceiling / 2, `tool tokens (${toolTokens}) must dominate the failure`);
			assert.strictEqual(endpoint.requests.length, 0);
		} finally { await endpoint.close(); }
	});

	test('multi-round tool loops: every sent payload fits and tool pairs stay intact in the endpoint body', async () => {
		const endpoint = await makeEndpoint();
		try {
			const window = 32_768;
			const rounds = toolPairTurns(3, 1_200);
			const payload = { systemMessage: 'You are a fixture agent with tools.', messages: rounds, chatMode: 'agent' as const };
			const guard = guardOf(payload, window);
			assert.strictEqual(guard.ok, true, `tool-loop payload must fit 32k (total ${guard.total}/${guard.ceiling})`);
			assert.strictEqual(await realSend(endpoint.port, payload), 'completed');
			const captured = JSON.parse(endpoint.requests[0].body);
			// tool pairing survives the real serialization: every tool-role
			// message kept its result in the captured body
			const roles = (captured.messages as { role: string; tool_call_id?: string }[]).map(m => m.role);
			assert.ok(roles.includes('tool'), 'tool results must be serialized');
			assert.ok(roles.filter(r => r === 'tool').length >= 3, 'all three tool rounds kept their results');
			assert.ok(endpoint.requests[0].estTokens <= guard.ceiling, 'captured body fits the ceiling');
		} finally { await endpoint.close(); }
	});

	test('degraded raw-fallback: fits → sends; over → stops with zero endpoint traffic', async () => {
		const endpoint = await makeEndpoint();
		try {
			const window = 32_768;
			// ledger assembly "failed" → the service would fall back to the raw
			// thread; rawFallbackDecision is the exact gate it applies
			const fittingRaw = englishCorpus(6, 800);
			const rawTokens = estimateTokensOf(fittingRaw.map(m => m.content));
			const decision = rawFallbackDecision(rawTokens, window);
			assert.strictEqual(decision.ok, true, 'a fitting raw thread still sends after degradation');
			assert.strictEqual(await realSend(endpoint.port, { systemMessage: 'sys', messages: fittingRaw }), 'completed');
			assert.strictEqual(endpoint.requests.length, 1);

			const overRaw = englishCorpus(20, 5_000);
			const overTokens = estimateTokensOf(overRaw.map(m => m.content));
			const stopDecision = rawFallbackDecision(overTokens, window);
			assert.strictEqual(stopDecision.ok, false, 'an over-budget raw thread must NOT ship through the fallback');
			// service stops → no sendChat → endpoint counter unchanged
			assert.strictEqual(endpoint.requests.length, 1);
		} finally { await endpoint.close(); }
	});

	test('compressible thread: real assemble() folds at 32k, then the folded payload REALLY sends without the folded prefix', async () => {
		const endpoint = await makeEndpoint();
		try {
			const window = 32_768;
			// 30 large messages — far beyond the tail budget, foldable at user
			// boundaries, with the last 8+ kept verbatim
			const raws = englishCorpus(30, 4_000);
			const compactables: CompactableMessage[] = raws.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));
			const brief = { threadId: 'fixture', revision: 1, tokens: 200, text: '<working_memory>fixture brief</working_memory>' } as unknown as IWorkingBrief;
			const assembled = assemble({ raws, compactables, brief, contextWindow: window, policy: DEFAULT_LEDGER_POLICY });
			assert.ok(assembled.report.totalTokens <= assembled.report.availableInputTokens, 'compaction must bring the payload inside the ceiling');
			assert.ok(assembled.keepFromIdx > 0, 'the aged prefix must be folded');

			// the assembled payload goes through the SAME final boundary guard
			const sentMessages = assembled.messages.map(m => ({ role: 'user' as const, content: (m as { content: string }).content }))
				.concat(raws.slice(assembled.keepFromIdx).map(m => ({ role: m.role as 'user', content: m.content })));
			const payload = { systemMessage: 'sys', messages: sentMessages };
			const guard = guardOf(payload, window);
			assert.strictEqual(guard.ok, true, `post-compaction payload must fit (total ${guard.total}/${guard.ceiling})`);
			assert.strictEqual(await realSend(endpoint.port, payload), 'completed');
			assert.strictEqual(endpoint.requests.length, 1);
			const body = endpoint.requests[0].body;
			assert.ok(body.includes('fixture brief'), 'the brief (archive coverage) is in the sent payload');
			assert.ok(body.includes('turn 29'), 'the verbatim tail reaches the endpoint');
			assert.ok(!body.includes('"turn 0"') && !body.includes('"turn 1"'), 'folded prefix messages must NOT be sent');
		} finally { await endpoint.close(); }
	});

	test('the estimator is conservative for Persian text and keeps unicode payloads inside the ceiling', async () => {
		const endpoint = await makeEndpoint();
		try {
			const window = 32_768;
			const ceiling = finalSendBudget({ systemTokens: 0, messageTokens: 0, toolTokens: 0, contextWindow: window }).ceiling;
			const persian = persianCorpus(20, 900);
			const persianTokens = estimateTokensOf(persian.map(m => m.content));
			const naive = persian.reduce((sum, m) => sum + Math.ceil(m.content.length / 4) + 8, 0);
			assert.ok(persianTokens > naive, `the conservative estimate (${persianTokens}) must exceed the naive chars/4 count (${naive}) for Persian`);
			const guard = guardOf({ messages: persian }, window);
			if (guard.total > ceiling) {
				assert.strictEqual(guard.ok, false);
				assert.strictEqual(endpoint.requests.length, 0); // stopped — no send
			} else {
				assert.strictEqual(guard.ok, true);
				assert.strictEqual(await realSend(endpoint.port, { messages: persian }), 'completed');
				assert.strictEqual(endpoint.requests.length, 1);
				assert.ok(endpoint.requests[0].estTokens <= ceiling, 'captured unicode body fits the ceiling');
			}
		} finally { await endpoint.close(); }
	});
});
