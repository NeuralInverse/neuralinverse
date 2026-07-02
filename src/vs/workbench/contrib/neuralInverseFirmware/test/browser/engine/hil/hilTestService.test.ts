/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import {
	IHILTestSpec,
	IHILExpectation,
	IHILExpectationResult,
} from '../../../../browser/engine/hil/hilTypes.js';

// ─── Inline expectation evaluator (mirrors HILTestServiceImpl._evaluateExpectation) ──

function evaluateExpectation(exp: IHILExpectation, serial: string): IHILExpectationResult {
	const result: IHILExpectationResult = { description: exp.description, passed: false };

	switch (exp.type) {
		case 'serial-contains':
			result.passed = serial.includes(exp.params['text'] as string);
			result.expected = exp.params['text'] as string;
			if (!result.passed) result.message = `Expected serial to contain "${exp.params['text']}"`;
			break;
		case 'serial-regex': {
			const regex = new RegExp(exp.params['pattern'] as string, exp.params['flags'] as string ?? '');
			result.passed = regex.test(serial);
			result.expected = exp.params['pattern'] as string;
			if (!result.passed) result.message = `Expected serial to match /${exp.params['pattern']}/`;
			break;
		}
		case 'serial-not-contains':
			result.passed = !serial.includes(exp.params['text'] as string);
			if (!result.passed) result.message = `Expected serial NOT to contain "${exp.params['text']}"`;
			break;
		case 'serial-sequence': {
			const sequence = exp.params['sequence'] as string[];
			let lastIdx = -1;
			result.passed = sequence.every(s => {
				const idx = serial.indexOf(s, lastIdx + 1);
				if (idx > lastIdx) { lastIdx = idx; return true; }
				return false;
			});
			if (!result.passed) result.message = 'Expected messages did not appear in sequence';
			break;
		}
		case 'no-crash':
			result.passed = !serial.includes('HardFault') &&
				!serial.includes('panic') &&
				!serial.includes('assert failed') &&
				!serial.includes('Guru Meditation Error');
			if (!result.passed) result.message = 'Crash/fault detected in serial output';
			break;
		case 'power-below-mw':
		case 'power-above-mw':
		case 'timing-within-us':
		case 'logic-pattern':
			result.message = `Expectation type "${exp.type}" requires instrument connection`;
			break;
	}
	return result;
}

suite('HIL Test Service - Expectation Evaluation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── serial-contains ──────────────────────────────────────────────────────

	test('serial-contains: passes when text present', () => {
		const r = evaluateExpectation({ type: 'serial-contains', description: 'has pass', params: { text: 'TEST PASS' } }, 'Boot\nTEST PASS\nDone');
		assert.strictEqual(r.passed, true);
	});

	test('serial-contains: fails when text absent', () => {
		const r = evaluateExpectation({ type: 'serial-contains', description: 'has pass', params: { text: 'TEST PASS' } }, 'Boot\nTEST FAIL\n');
		assert.strictEqual(r.passed, false);
		assert.ok(r.message?.includes('TEST PASS'));
	});

	// ─── serial-not-contains ─────────────────────────────────────────────────

	test('serial-not-contains: passes when text absent', () => {
		const r = evaluateExpectation({ type: 'serial-not-contains', description: 'no fault', params: { text: 'HardFault' } }, 'Boot OK\nAll good');
		assert.strictEqual(r.passed, true);
	});

	test('serial-not-contains: fails when text present', () => {
		const r = evaluateExpectation({ type: 'serial-not-contains', description: 'no fault', params: { text: 'HardFault' } }, 'HardFault_Handler called');
		assert.strictEqual(r.passed, false);
	});

	// ─── serial-regex ─────────────────────────────────────────────────────────

	test('serial-regex: matches digit pattern', () => {
		const r = evaluateExpectation({ type: 'serial-regex', description: 'count', params: { pattern: 'count:\\s*\\d+' } }, 'Result count: 42');
		assert.strictEqual(r.passed, true);
	});

	test('serial-regex: fails when pattern has no match', () => {
		const r = evaluateExpectation({ type: 'serial-regex', description: 'count', params: { pattern: 'ERROR:\\s*\\d+' } }, 'All tests passed');
		assert.strictEqual(r.passed, false);
		assert.ok(r.message?.includes('ERROR'));
	});

	test('serial-regex: case insensitive flag works', () => {
		const r = evaluateExpectation({ type: 'serial-regex', description: 'pass', params: { pattern: 'test pass', flags: 'i' } }, 'TEST PASS');
		assert.strictEqual(r.passed, true);
	});

	// ─── serial-sequence ─────────────────────────────────────────────────────

	test('serial-sequence: passes when messages appear in order', () => {
		const r = evaluateExpectation(
			{ type: 'serial-sequence', description: 'startup', params: { sequence: ['Init', 'Config', 'Ready'] } },
			'Init OK\nConfig loaded\nReady'
		);
		assert.strictEqual(r.passed, true);
	});

	test('serial-sequence: fails when messages appear out of order', () => {
		const r = evaluateExpectation(
			{ type: 'serial-sequence', description: 'startup', params: { sequence: ['Config', 'Init', 'Ready'] } },
			'Init OK\nConfig loaded\nReady'
		);
		assert.strictEqual(r.passed, false);
		assert.ok(r.message?.includes('sequence'));
	});

	test('serial-sequence: fails when a message is missing', () => {
		const r = evaluateExpectation(
			{ type: 'serial-sequence', description: 'startup', params: { sequence: ['Init', 'MISSING_MSG', 'Ready'] } },
			'Init OK\nReady'
		);
		assert.strictEqual(r.passed, false);
	});

	// ─── no-crash ─────────────────────────────────────────────────────────────

	test('no-crash: passes on clean output', () => {
		const r = evaluateExpectation({ type: 'no-crash', description: 'no crash', params: {} }, 'System OK\nAll running\nHeartbeat');
		assert.strictEqual(r.passed, true);
	});

	test('no-crash: fails on HardFault', () => {
		const r = evaluateExpectation({ type: 'no-crash', description: 'no crash', params: {} }, 'Running...\nHardFault_Handler: PC=0x0800ABCD');
		assert.strictEqual(r.passed, false);
		assert.ok(r.message?.includes('Crash'));
	});

	test('no-crash: fails on panic', () => {
		const r = evaluateExpectation({ type: 'no-crash', description: 'no crash', params: {} }, 'Starting...\npanic: unhandled exception');
		assert.strictEqual(r.passed, false);
	});

	test('no-crash: fails on ESP32 Guru Meditation Error', () => {
		const r = evaluateExpectation({ type: 'no-crash', description: 'no crash', params: {} }, 'Guru Meditation Error: Core 0 panic');
		assert.strictEqual(r.passed, false);
	});

	test('no-crash: fails on assert failed', () => {
		const r = evaluateExpectation({ type: 'no-crash', description: 'no crash', params: {} }, 'assert failed: some_condition, file.c, 99');
		assert.strictEqual(r.passed, false);
	});

	// ─── instrument expectations (no hardware) ────────────────────────────────

	test('power-below-mw: returns requires-instrument message', () => {
		const r = evaluateExpectation({ type: 'power-below-mw', description: 'power', params: { threshold: 100 } }, '');
		assert.ok(r.message?.includes('instrument'), `Got: ${r.message}`);
	});

	test('logic-pattern: returns requires-instrument message', () => {
		const r = evaluateExpectation({ type: 'logic-pattern', description: 'logic', params: {} }, '');
		assert.ok(r.message?.includes('instrument'), `Got: ${r.message}`);
	});
});

// ─── HIL Test Spec structure validation ───────────────────────────────────────

suite('HIL Test Spec - JSON Structure', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const validSpec: IHILTestSpec = {
		id: 'uart-echo-test',
		name: 'UART Echo Test',
		description: 'Sends a string via serial and expects it echoed back',
		buildFirst: true,
		stimulus: [
			{ type: 'serial-send', delayMs: 500, params: { data: 'HELLO\r\n', newline: false } },
		],
		expectations: [
			{ type: 'serial-contains', description: 'echo received', params: { text: 'HELLO' } },
			{ type: 'no-crash', description: 'no crash', params: {} },
		],
		timeoutMs: 10_000,
		postFlashDelayMs: 500,
		tags: ['uart', 'smoke'],
	};

	test('valid spec has all required fields', () => {
		assert.ok(validSpec.id);
		assert.ok(validSpec.name);
		assert.ok(typeof validSpec.buildFirst === 'boolean');
		assert.ok(Array.isArray(validSpec.stimulus));
		assert.ok(Array.isArray(validSpec.expectations));
		assert.ok(validSpec.timeoutMs > 0);
		assert.ok(validSpec.postFlashDelayMs >= 0);
	});

	test('spec serializes and deserializes correctly', () => {
		const json = JSON.stringify(validSpec);
		const parsed = JSON.parse(json) as IHILTestSpec;
		assert.strictEqual(parsed.id, validSpec.id);
		assert.strictEqual(parsed.name, validSpec.name);
		assert.strictEqual(parsed.stimulus.length, validSpec.stimulus.length);
		assert.strictEqual(parsed.expectations.length, validSpec.expectations.length);
	});

	test('spec with reset-target stimulus is valid', () => {
		const spec: IHILTestSpec = {
			...validSpec,
			id: 'reset-test',
			stimulus: [{ type: 'reset-target', delayMs: 0, params: {} }],
		};
		assert.strictEqual(spec.stimulus[0]!.type, 'reset-target');
	});

	test('spec with gpio-pulse stimulus is valid', () => {
		const spec: IHILTestSpec = {
			...validSpec,
			id: 'gpio-test',
			stimulus: [{ type: 'gpio-pulse', delayMs: 100, params: { port: 'A', pin: 5, durationMs: 10 } }],
		};
		assert.strictEqual(spec.stimulus[0]!.params['port'], 'A');
		assert.strictEqual(spec.stimulus[0]!.params['pin'], 5);
	});

	test('suite result structure is correct', () => {
		const suite = {
			suiteName: 'All Tests',
			startTime: Date.now(),
			endTime: Date.now() + 5000,
			totalTests: 3,
			passedTests: 2,
			failedTests: 1,
			results: [],
		};
		assert.strictEqual(suite.totalTests, suite.passedTests + suite.failedTests);
	});
});
