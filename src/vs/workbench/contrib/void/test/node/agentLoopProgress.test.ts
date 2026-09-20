/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/
import assert from 'assert';
import { advanceExplorationRounds, advanceFruitlessSearchRounds, countRepeatedReads, getAgentLoopReminder } from '../../common/agentLoopProgress.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Agent exploration checkpoints', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('the reported sequence of successful reads triggers a planning checkpoint before 50 requests', () => {
		let rounds = 0;
		for (let i = 0; i < 8; i++) {
			rounds = advanceExplorationRounds(rounds, [{ name: i % 2 ? 'read' : 'search_in_file', success: true }]);
		}
		assert.match(getAgentLoopReminder(8, 50, rounds) ?? '', /8 consecutive rounds/);
	});
	test('writes, failed searches, empty batches and unknown tools break the exploration streak', () => {
		for (const tools of [[{ name: 'write', success: true }], [{ name: 'grep', success: false }], [], [{ name: 'custom_tool', success: true }]]) {
			assert.strictEqual(advanceExplorationRounds(7, tools), 0);
		}
	});
	test('ordinary early exploration needs no reminder', () => {
		assert.strictEqual(getAgentLoopReminder(7, 50, 7), undefined);
	});
	test('near the limit the checkpoint exposes the remaining budget without increasing it', () => {
		assert.match(getAgentLoopReminder(45, 50, 20) ?? '', /5 model requests remain/);
		assert.match(getAgentLoopReminder(49, 50, 0) ?? '', /1 model requests remain/);
	});
	test('analysis requests are allowed to finish without editing files', () => {
		assert.match(getAgentLoopReminder(8, 50, 8) ?? '', /If the user requested analysis, provide the supported answer/);
	});
});

suite('Agent repetition checkpoints', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('rereading the same ranges is counted; new files and ranges are not', () => {
		let state = countRepeatedReads(new Map(), [{ file: 'a.ts', range: '1-50' }]);
		assert.strictEqual(state.totalRepeats, 0);
		state = countRepeatedReads(state.counts, [{ file: 'a.ts', range: '1-50' }, { file: 'b.ts', range: '1-50' }]);
		assert.strictEqual(state.repeatedThisRound, 1);
		assert.strictEqual(state.totalRepeats, 1);
		state = countRepeatedReads(state.counts, [{ file: 'a.ts', range: '1-50' }]);
		assert.strictEqual(state.repeatedThisRound, 1);
		assert.strictEqual(state.totalRepeats, 2);
		assert.strictEqual(countRepeatedReads(state.counts, [{ file: 'c.ts', range: '1-50' }]).totalRepeats, 2);
		assert.match(getAgentLoopReminder(10, 50, { explorationRounds: 0, repeatedReads: 3, fruitlessSearchRounds: 0 }) ?? '', /same file ranges have been read again 3 times/);
	});
	test('fruitless search streaks trigger guidance, and productive or mixed rounds reset them', () => {
		let streak = advanceFruitlessSearchRounds(0, [{ name: 'grep', success: true, emptyResult: true }]);
		streak = advanceFruitlessSearchRounds(streak, [{ name: 'glob', success: true, emptyResult: true }]);
		streak = advanceFruitlessSearchRounds(streak, [{ name: 'search_for_files', success: true, emptyResult: true }]);
		assert.match(getAgentLoopReminder(10, 50, { explorationRounds: 0, repeatedReads: 0, fruitlessSearchRounds: streak }) ?? '', /last 3 search rounds returned no results/);
		assert.strictEqual(advanceFruitlessSearchRounds(streak, [{ name: 'read', success: true, emptyResult: false }]), 0);
		assert.strictEqual(advanceFruitlessSearchRounds(streak, [{ name: 'grep', success: true, emptyResult: false }]), 0);
		assert.strictEqual(advanceFruitlessSearchRounds(streak, [{ name: 'grep', success: false, emptyResult: true }]), 0);
	});
	test('the remaining-budget checkpoint outranks repetition guidance', () => {
		const reminder = getAgentLoopReminder(46, 50, { explorationRounds: 20, repeatedReads: 10, fruitlessSearchRounds: 9 }) ?? '';
		assert.match(reminder, /4 model requests remain/);
		assert.ok(!reminder.includes('same file ranges'));
	});
});
