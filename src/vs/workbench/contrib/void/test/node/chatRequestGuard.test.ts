/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import * as sinon from 'sinon';
import { ChatRequestGuard } from '../../common/chatRequestGuard.js';

suite('chat request deadlines', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('empty callbacks cannot extend the first-token deadline', async () => {
		const clock = sinon.useFakeTimers();
		const request = new ChatRequestGuard<string>(180_000);
		try {
			for (let i = 0; i < 20; i++) {
				clock.tick(10_000);
				request.progress({ fullText: '', fullReasoning: '' });
			}
			assert.deepStrictEqual({ outcome: await request.result, progress: request.diagnostics.progressCount }, { outcome: { type: 'stalled' }, progress: 0 });
		} finally { request.dispose(); clock.restore(); }
	});

	test('duplicate snapshots after partial text do not keep the request alive', async () => {
		const clock = sinon.useFakeTimers();
		const request = new ChatRequestGuard<string>(100);
		try {
			request.progress({ fullText: 'partial', fullReasoning: '' });
			clock.tick(90);
			request.progress({ fullText: 'partial', fullReasoning: '' });
			clock.tick(10);
			assert.deepStrictEqual(await request.result, { type: 'stalled' });
		} finally { request.dispose(); clock.restore(); }
	});

	test('reasoning and hidden tool argument progress reset the deadline', async () => {
		const clock = sinon.useFakeTimers();
		const request = new ChatRequestGuard<string>(100);
		try {
			clock.tick(90);
			request.progress({ fullText: '', fullReasoning: 'thinking' });
			clock.tick(90);
			request.progress({ fullText: '', fullReasoning: 'thinking', providerOutputCharacters: 50 });
			clock.tick(90);
			request.progress({ fullText: '', fullReasoning: 'thinking', providerOutputCharacters: 75 });
			clock.tick(90);
			request.complete('tool completed');
			assert.deepStrictEqual({ outcome: await request.result, progress: request.diagnostics.progressCount }, { outcome: { type: 'completed', value: 'tool completed' }, progress: 3 });
		} finally { request.dispose(); clock.restore(); }
	});

	test('a stall settles without a provider abort callback and rejects late completion', async () => {
		const clock = sinon.useFakeTimers();
		const request = new ChatRequestGuard<string>(100);
		try {
			clock.tick(100);
			const acceptedLateText = request.progress({ fullText: 'late', fullReasoning: '' });
			const acceptedLateFinal = request.complete('late');
			assert.deepStrictEqual({ outcome: await request.result, acceptedLateText, acceptedLateFinal, timers: clock.countTimers() }, {
				outcome: { type: 'stalled' }, acceptedLateText: false, acceptedLateFinal: false, timers: 0,
			});
		} finally { request.dispose(); clock.restore(); }
	});

	test('cancel frees a pending preparation and ignores its later result', async () => {
		const request = new ChatRequestGuard<string>(100);
		try {
			request.cancel();
			assert.deepStrictEqual({ outcome: await request.result, accepted: request.complete('late context') }, { outcome: { type: 'cancelled' }, accepted: false });
		} finally { request.dispose(); }
	});

	test('preparation failure settles and cancels its timer', async () => {
		const clock = sinon.useFakeTimers();
		const request = new ChatRequestGuard<string>(100);
		const error = new Error('context failed');
		try {
			request.fail(error);
			clock.tick(1000);
			assert.deepStrictEqual({ outcome: await request.result, timers: clock.countTimers() }, { outcome: { type: 'failed', error }, timers: 0 });
		} finally { request.dispose(); clock.restore(); }
	});

	test('completion wins once and leaves no timer', async () => {
		const clock = sinon.useFakeTimers();
		const request = new ChatRequestGuard<string>(100);
		try {
			request.complete('done');
			request.cancel();
			clock.tick(1000);
			assert.deepStrictEqual({ outcome: await request.result, timers: clock.countTimers() }, { outcome: { type: 'completed', value: 'done' }, timers: 0 });
		} finally { request.dispose(); clock.restore(); }
	});

	test('concurrent requests have independent progress and cancellation', async () => {
		const clock = sinon.useFakeTimers();
		const first = new ChatRequestGuard<string>(100);
		const second = new ChatRequestGuard<string>(100);
		try {
			clock.tick(90);
			second.progress({ fullText: 'B', fullReasoning: '' });
			clock.tick(10);
			second.complete('B done');
			assert.deepStrictEqual(await Promise.all([first.result, second.result]), [{ type: 'stalled' }, { type: 'completed', value: 'B done' }]);
		} finally { first.dispose(); second.dispose(); clock.restore(); }
	});
});
