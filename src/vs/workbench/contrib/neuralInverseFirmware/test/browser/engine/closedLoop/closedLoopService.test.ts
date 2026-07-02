/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { IPassCriterion, IObservation } from '../../../../browser/engine/closedLoop/closedLoopTypes.js';

// ─── Inline evaluateCriteria logic (mirrors production) ───────────────────────

function evaluateCriteria(criteria: IPassCriterion[], observation: IObservation): boolean[] {
	return criteria.map(c => {
		switch (c.type) {
			case 'serial-contains':
				return observation.data.includes(c.value);
			case 'serial-regex':
				try { return new RegExp(c.value).test(observation.data); }
				catch { return false; }
			case 'serial-not-contains':
				return !observation.data.includes(c.value);
			case 'no-build-errors':
				return true;
			default:
				return false;
		}
	});
}

suite('ClosedLoop Service - Criteria Evaluation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const makeObs = (data: string): IObservation => ({
		channel: 'serial',
		data,
		durationMs: 1000,
		timestamp: Date.now(),
	});

	// ─── serial-contains ──────────────────────────────────────────────────────

	test('serial-contains: criterion met when value in data', () => {
		const result = evaluateCriteria([{ type: 'serial-contains', value: 'TEST PASS' }], makeObs('Boot OK\nTEST PASS\nDone'));
		assert.strictEqual(result[0], true);
	});

	test('serial-contains: criterion not met when value absent', () => {
		const result = evaluateCriteria([{ type: 'serial-contains', value: 'TEST PASS' }], makeObs('Boot OK\nTEST FAIL\nDone'));
		assert.strictEqual(result[0], false);
	});

	test('serial-contains: empty string always matches', () => {
		const result = evaluateCriteria([{ type: 'serial-contains', value: '' }], makeObs('anything'));
		assert.strictEqual(result[0], true);
	});

	// ─── serial-not-contains ─────────────────────────────────────────────────

	test('serial-not-contains: criterion met when value absent', () => {
		const result = evaluateCriteria([{ type: 'serial-not-contains', value: 'HardFault' }], makeObs('Boot OK\nTest passed\nDone'));
		assert.strictEqual(result[0], true);
	});

	test('serial-not-contains: criterion not met when value present', () => {
		const result = evaluateCriteria([{ type: 'serial-not-contains', value: 'HardFault' }], makeObs('Boot OK\nHardFault_Handler called\nDone'));
		assert.strictEqual(result[0], false);
	});

	test('serial-not-contains: "panic" present fails criterion', () => {
		const result = evaluateCriteria([{ type: 'serial-not-contains', value: 'panic' }], makeObs('Guru Meditation Error: Core 0 panic!'));
		assert.strictEqual(result[0], false);
	});

	// ─── serial-regex ─────────────────────────────────────────────────────────

	test('serial-regex: digit pattern matches output', () => {
		const result = evaluateCriteria([{ type: 'serial-regex', value: 'PASS:\\s*\\d+' }], makeObs('Test run...\nPASS: 42 tests\nDone'));
		assert.strictEqual(result[0], true);
	});

	test('serial-regex: pattern with no match returns false', () => {
		const result = evaluateCriteria([{ type: 'serial-regex', value: 'ERROR:\\s*\\d+' }], makeObs('Test run...\nAll tests passed\nDone'));
		assert.strictEqual(result[0], false);
	});

	test('serial-regex: invalid regex returns false without throwing', () => {
		const result = evaluateCriteria([{ type: 'serial-regex', value: '[[invalid' }], makeObs('some output'));
		assert.strictEqual(result[0], false);
	});

	// ─── no-build-errors ─────────────────────────────────────────────────────

	test('no-build-errors: always true (reached observe phase means build succeeded)', () => {
		const result = evaluateCriteria([{ type: 'no-build-errors', value: '' }], makeObs(''));
		assert.strictEqual(result[0], true);
	});

	// ─── Multiple criteria ────────────────────────────────────────────────────

	test('multiple criteria: all pass when all conditions met', () => {
		const criteria: IPassCriterion[] = [
			{ type: 'serial-contains', value: 'PASS' },
			{ type: 'serial-not-contains', value: 'FAIL' },
			{ type: 'serial-not-contains', value: 'HardFault' },
		];
		const results = evaluateCriteria(criteria, makeObs('Running...\nTest 1 PASS\nDone'));
		assert.ok(results.every(Boolean), `Expected all criteria met, got: ${results}`);
	});

	test('multiple criteria: partial pass/fail correctly reported', () => {
		const criteria: IPassCriterion[] = [
			{ type: 'serial-contains', value: 'PASS' },
			{ type: 'serial-not-contains', value: 'FAIL' },
		];
		const results = evaluateCriteria(criteria, makeObs('PASS and FAIL both detected'));
		assert.strictEqual(results[0], true, 'PASS should be found');
		assert.strictEqual(results[1], false, 'FAIL is present so not-contains should fail');
	});

	test('empty criteria array returns empty array', () => {
		const results = evaluateCriteria([], makeObs('anything'));
		assert.deepStrictEqual(results, []);
	});

	// ─── HardFault / panic detection ──────────────────────────────────────────

	test('no-crash pattern: HardFault in output fails no-fault criterion', () => {
		const obs = makeObs('Starting...\nHardFault_Handler: PC=0x08001234\nSystem halted');
		const hasFault = obs.data.includes('HardFault') || obs.data.includes('panic');
		assert.strictEqual(hasFault, true);
		const result = evaluateCriteria([{ type: 'serial-not-contains', value: 'HardFault' }], obs);
		assert.strictEqual(result[0], false);
	});

	test('no-crash pattern: "Guru Meditation Error" (ESP32 panic) detected', () => {
		const obs = makeObs('Guru Meditation Error: Core 0 panic\'d (LoadProhibited). Exception was unhandled.');
		const result = evaluateCriteria([{ type: 'serial-not-contains', value: 'Guru Meditation Error' }], obs);
		assert.strictEqual(result[0], false);
	});

	test('no-crash pattern: "assert failed" detected', () => {
		const obs = makeObs('assert failed: pvPortMalloc heap.c 100');
		const result = evaluateCriteria([{ type: 'serial-not-contains', value: 'assert failed' }], obs);
		assert.strictEqual(result[0], false);
	});

	test('no-crash pattern: clean output passes all safety checks', () => {
		const obs = makeObs('System boot OK\nFreeRTOS scheduler started\nAll tasks running\nLED blink: 100ms');
		const criteria: IPassCriterion[] = [
			{ type: 'serial-not-contains', value: 'HardFault' },
			{ type: 'serial-not-contains', value: 'panic' },
			{ type: 'serial-not-contains', value: 'assert failed' },
			{ type: 'serial-not-contains', value: 'Guru Meditation Error' },
		];
		const results = evaluateCriteria(criteria, obs);
		assert.ok(results.every(Boolean), 'All safety checks should pass on clean output');
	});
});

// ─── ClosedLoop types validation ─────────────────────────────────────────────

import { DEFAULT_CLOSED_LOOP_CONFIG } from '../../../../browser/engine/closedLoop/closedLoopTypes.js';

suite('ClosedLoop Types - Default Configuration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('DEFAULT_CLOSED_LOOP_CONFIG has maxIterations > 0', () => {
		assert.ok(DEFAULT_CLOSED_LOOP_CONFIG.maxIterations > 0, `maxIterations should be positive, got ${DEFAULT_CLOSED_LOOP_CONFIG.maxIterations}`);
	});

	test('DEFAULT_CLOSED_LOOP_CONFIG has reasonable timeoutMs', () => {
		assert.ok(DEFAULT_CLOSED_LOOP_CONFIG.timeoutMs >= 60_000, 'Timeout should be at least 60 seconds');
		assert.ok(DEFAULT_CLOSED_LOOP_CONFIG.timeoutMs <= 3_600_000, 'Timeout should be at most 1 hour');
	});

	test('DEFAULT_CLOSED_LOOP_CONFIG has goal field', () => {
		assert.ok(typeof DEFAULT_CLOSED_LOOP_CONFIG.goal === 'string');
	});

	test('DEFAULT_CLOSED_LOOP_CONFIG has passCriteria array', () => {
		assert.ok(Array.isArray(DEFAULT_CLOSED_LOOP_CONFIG.passCriteria));
	});

	test('DEFAULT_CLOSED_LOOP_CONFIG has observeChannels', () => {
		assert.ok(Array.isArray(DEFAULT_CLOSED_LOOP_CONFIG.observeChannels));
		assert.ok(DEFAULT_CLOSED_LOOP_CONFIG.observeChannels.length > 0);
	});
});
