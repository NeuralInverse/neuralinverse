/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License. Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import { shouldAutoRetry, looksLikeQuestion } from '../../common/ossModelEnhancement/autoRetryCorrection.js';

// ---------------------------------------------------------------------------
// Suite: looksLikeQuestion — the guard that stops the resume-after-answer bug
// ---------------------------------------------------------------------------

suite('ossEnhancement — looksLikeQuestion', () => {

	test('Persian questions about the task are detected (the reported bug)', () => {
		assert.strictEqual(looksLikeQuestion('چقدر زمان برد این تسک اجرا بشه؟'), true);
		assert.strictEqual(looksLikeQuestion('چقدر زمان برد تا اینجا؟'), true);
		assert.strictEqual(looksLikeQuestion('چرا این فایل رو نشناختی؟'), true);
		assert.strictEqual(looksLikeQuestion('آیا تسک تموم شد؟'), true);
		assert.strictEqual(looksLikeQuestion('چطور میتونم این رو عوض کنم؟'), true);
	});

	test('English questions are detected', () => {
		assert.strictEqual(looksLikeQuestion('How long did the task take?'), true);
		assert.strictEqual(looksLikeQuestion('did the build pass?'), true);
		assert.strictEqual(looksLikeQuestion('What is left to do'), true); // interrogative start, no mark
	});

	test('instructions are NOT questions', () => {
		assert.strictEqual(looksLikeQuestion('تسک رو ادامه بده'), false);
		assert.strictEqual(looksLikeQuestion('continue the task'), false);
		assert.strictEqual(looksLikeQuestion('فایل X رو هم درست کن'), false);
		assert.strictEqual(looksLikeQuestion('run the tests and fix failures'), false);
		assert.strictEqual(looksLikeQuestion(''), false);
		assert.strictEqual(looksLikeQuestion(undefined), false);
	});

	test('edge: anchored interrogatives do not match mid-word', () => {
		// «کی» must be a standalone word at the start, not a substring
		assert.strictEqual(looksLikeQuestion('دستگیره‌ی ماوس کی‌بورد رو عوض کن'), false);
		assert.strictEqual(looksLikeQuestion('کی این رو نوشت؟'), true);
	});
});

// ---------------------------------------------------------------------------
// Suite: shouldAutoRetry — question guard
// ---------------------------------------------------------------------------

suite('ossEnhancement — shouldAutoRetry question guard', () => {

	// an answer ABOUT the task: mentions a path and narrative — the old
	// heuristics alone would flag it as "narrating instead of acting"
	const answerAboutTask = 'This task took about 25 minutes. The slow part was rebuilding dist in .ai/tasks/EZ-0102/task.md — I can check the logs if you want.';

	test('text answer to a question, no tools yet this run → NO retry (the fix)', () => {
		assert.strictEqual(
			shouldAutoRetry(answerAboutTask, 0, 'agent', 0, { userMessage: 'چقدر زمان برد این تسک اجرا بشه؟', toolsExecutedThisRun: false }),
			false);
		assert.strictEqual(
			shouldAutoRetry(answerAboutTask, 0, 'agent', 0, { userMessage: 'How long did it take?', toolsExecutedThisRun: false }),
			false);
	});

	test('same text mid-task (tools already ran this run) → retry still applies', () => {
		// mid-run narration after tools is still suspicious — the user's
		// interrupting question deserves an answer AND the task should resume
		assert.strictEqual(
			shouldAutoRetry(answerAboutTask, 0, 'agent', 0, { userMessage: 'چقدر زمان مونده؟', toolsExecutedThisRun: true }),
			true);
	});

	test('non-question instructions keep the old behavior', () => {
		// "continue the task" + narrating answer → retry (model must act)
		assert.strictEqual(
			shouldAutoRetry(answerAboutTask, 0, 'agent', 0, { userMessage: 'تسک رو ادامه بده', toolsExecutedThisRun: false }),
			true);
	});

	test('context is optional — old callers unchanged', () => {
		assert.strictEqual(shouldAutoRetry(answerAboutTask, 0, 'agent', 0), true);
		assert.strictEqual(shouldAutoRetry('ok', 0, 'agent', 0), false); // < 20 chars
		assert.strictEqual(shouldAutoRetry(answerAboutTask, 0, 'ask', 0, { userMessage: 'why?', toolsExecutedThisRun: false }), false); // non-agentic mode
		assert.strictEqual(shouldAutoRetry('I will run `npm install` now', 2, 'agent', 0, { userMessage: 'why?', toolsExecutedThisRun: false }), false); // toolCalls > 0
	});
});
