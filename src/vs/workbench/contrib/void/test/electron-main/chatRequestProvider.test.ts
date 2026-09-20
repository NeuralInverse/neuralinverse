/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

import { ChatRequestGuard } from '../../common/chatRequestGuard.js';
import { defaultSettingsOfProvider } from '../../common/voidSettingsTypes.js';
import type { OnFinalMessage } from '../../common/sendLLMMessageTypes.js';
import { sendLLMMessageToProviderImplementation } from '../../electron-main/llmMessage/sendLLMMessage.impl.js';

/** Real desktop SDK + streaming parsers against a local SSE fixture, with no credentials or external traffic. */
async function runProviderFixture(mode: 'keepalive' | 'tool') {
	const { createServer } = await import('http');
	let interval: ReturnType<typeof setInterval> | undefined;
	let abort: (() => void) | undefined;
	let receivedRequests = 0;
	const server = createServer((incoming, response) => {
		receivedRequests++;
		incoming.resume();
		response.writeHead(200, { 'Content-Type': 'text/event-stream' });
		let step = 0;
		interval = setInterval(() => {
			step++;
			const args = step === 1 ? '{"command":"' : step === 18 ? '"}' : 'x';
			const delta = mode === 'keepalive' ? {} : { tool_calls: [{ index: 0, ...(step === 1 ? { id: 'call-fixture' } : {}), function: { ...(step === 1 ? { name: 'bash' } : {}), arguments: args } }] };
			response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
			if (mode === 'tool' && step === 18) {
				clearInterval(interval);
				response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
			}
		}, 100);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	assert.ok(address && typeof address === 'object');
	const request = new ChatRequestGuard<Parameters<OnFinalMessage>[0]>(1000);
	try {
		await sendLLMMessageToProviderImplementation.openAICompatible.sendChat({
			providerName: 'openAICompatible', modelName: 'gpt-4o',
			settingsOfProvider: { ...defaultSettingsOfProvider, openAICompatible: { ...defaultSettingsOfProvider.openAICompatible, endpoint: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture-only' } },
			messages: [{ role: 'user', content: 'Synthetic watchdog fixture' }],
			modelSelectionOptions: undefined, overridesOfModel: undefined,
			separateSystemMessage: undefined, chatMode: 'agent', mcpTools: [], allowedToolNames: ['bash'],
			_setAborter: callback => { abort = callback; },
			onText: snapshot => { request.progress(snapshot); },
			onFinalMessage: value => { request.complete(value); },
			onError: error => { request.fail(new Error(error.message)); },
		});
		const result = await request.result;
		return { result, diagnostics: request.diagnostics, receivedRequests };
	} finally {
		request.dispose();
		abort?.();
		clearInterval(interval);
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
	}
}

suite('desktop provider request deadlines', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('a real SSE stream containing only empty deltas cannot postpone the watchdog', async () => {
		const { result, diagnostics, receivedRequests } = await runProviderFixture('keepalive');
		assert.deepStrictEqual({ result, receivedRequests, hadCallbacks: diagnostics.callbackCount > 0, progress: diagnostics.progressCount }, {
			result: { type: 'stalled' }, receivedRequests: 1, hadCallbacks: true, progress: 0,
		});
	});

	test('native tool JSON keeps progressing through desktop parsers beyond the idle deadline', async () => {
		const { result, diagnostics, receivedRequests } = await runProviderFixture('tool');
		assert.strictEqual(result.type, 'completed');
		if (result.type !== 'completed') { return; }
		assert.deepStrictEqual({ commands: result.value.toolCalls?.map(tool => tool.rawParams.command), receivedRequests, trackedAllChunks: diagnostics.progressCount >= 18 }, {
			commands: ['x'.repeat(16)], receivedRequests: 1, trackedAllChunks: true,
		});
	});
});
