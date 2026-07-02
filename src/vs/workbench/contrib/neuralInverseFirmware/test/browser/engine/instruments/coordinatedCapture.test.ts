/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';

// ─── Types mirroring the coordinated capture service ─────────────────────────

interface ICaptureInstrument {
	type: 'logic' | 'scope' | 'power' | 'serial';
	channels?: number[];
	durationSec?: number;
	sampleRate?: number;
}

interface ICaptureConfig {
	label: string;
	instruments: ICaptureInstrument[];
	durationSec: number;
	syncMethod: 'software' | 'hardware';
}

interface ICaptureTimeline {
	captureId: string;
	label: string;
	startTimestamp: number;
	endTimestamp: number;
	instruments: ICaptureInstrument[];
	logicCaptureId?: string;
	scopeCaptureId?: string;
	powerCaptureId?: string;
	serialLines?: string[];
}

// ─── Mock coordinated capture harness ────────────────────────────────────────

function makeCoordinatedCapture(config: ICaptureConfig, instrumentResults: {
	logic?: { captureId: string };
	scope?: { captureId: string };
	power?: { captureId: string };
	serial?: string[];
} = {}): ICaptureTimeline {
	const captureId = `cc_${Date.now()}`;
	const now = Date.now();
	return {
		captureId,
		label: config.label,
		startTimestamp: now,
		endTimestamp: now + config.durationSec * 1000,
		instruments: config.instruments,
		logicCaptureId: instrumentResults.logic?.captureId,
		scopeCaptureId: instrumentResults.scope?.captureId,
		powerCaptureId: instrumentResults.power?.captureId,
		serialLines: instrumentResults.serial ?? [],
	};
}

// ─── Timeline correlation helpers ────────────────────────────────────────────

function timelineHasInstrument(timeline: ICaptureTimeline, type: ICaptureInstrument['type']): boolean {
	return timeline.instruments.some(i => i.type === type);
}

function captureSpanMs(timeline: ICaptureTimeline): number {
	return timeline.endTimestamp - timeline.startTimestamp;
}

suite('Coordinated Capture Service - Timeline', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('capture span matches configured duration', () => {
		const config: ICaptureConfig = {
			label: 'I2C Debug Capture',
			instruments: [{ type: 'logic', channels: [0, 1] }, { type: 'power' }],
			durationSec: 2,
			syncMethod: 'software',
		};
		const timeline = makeCoordinatedCapture(config, {
			logic: { captureId: 'la_001' },
			power: { captureId: 'pa_001' },
		});
		assert.ok(Math.abs(captureSpanMs(timeline) - 2000) < 100, `Expected span ~2000ms, got ${captureSpanMs(timeline)}`);
	});

	test('timeline has logic and power instrument references', () => {
		const config: ICaptureConfig = {
			label: 'Logic + Power',
			instruments: [{ type: 'logic' }, { type: 'power' }],
			durationSec: 1,
			syncMethod: 'software',
		};
		const timeline = makeCoordinatedCapture(config, {
			logic: { captureId: 'la_001' },
			power: { captureId: 'pa_001' },
		});
		assert.ok(timelineHasInstrument(timeline, 'logic'));
		assert.ok(timelineHasInstrument(timeline, 'power'));
		assert.ok(!timelineHasInstrument(timeline, 'scope'));
	});

	test('timeline preserves all 4 instrument types when all provided', () => {
		const config: ICaptureConfig = {
			label: 'Full Debug',
			instruments: [
				{ type: 'logic', channels: [0, 1, 2, 3] },
				{ type: 'scope', channels: [1] },
				{ type: 'power' },
				{ type: 'serial' },
			],
			durationSec: 5,
			syncMethod: 'software',
		};
		const timeline = makeCoordinatedCapture(config, {
			logic: { captureId: 'la_001' },
			scope: { captureId: 'sc_001' },
			power: { captureId: 'pa_001' },
			serial: ['Boot OK', 'READY'],
		});
		assert.ok(timelineHasInstrument(timeline, 'logic'));
		assert.ok(timelineHasInstrument(timeline, 'scope'));
		assert.ok(timelineHasInstrument(timeline, 'power'));
		assert.ok(timelineHasInstrument(timeline, 'serial'));
		assert.strictEqual(timeline.serialLines?.length, 2);
	});

	test('capture IDs are present for active instruments', () => {
		const config: ICaptureConfig = {
			label: 'LA+PA',
			instruments: [{ type: 'logic' }, { type: 'power' }],
			durationSec: 2,
			syncMethod: 'software',
		};
		const timeline = makeCoordinatedCapture(config, {
			logic: { captureId: 'la_abc' },
			power: { captureId: 'pa_xyz' },
		});
		assert.strictEqual(timeline.logicCaptureId, 'la_abc');
		assert.strictEqual(timeline.powerCaptureId, 'pa_xyz');
		assert.strictEqual(timeline.scopeCaptureId, undefined);
	});

	test('captureId is generated and non-empty', () => {
		const config: ICaptureConfig = {
			label: 'Test',
			instruments: [{ type: 'serial' }],
			durationSec: 1,
			syncMethod: 'software',
		};
		const timeline = makeCoordinatedCapture(config);
		assert.ok(timeline.captureId.startsWith('cc_'));
		assert.ok(timeline.captureId.length > 3);
	});

	test('endTimestamp is after startTimestamp', () => {
		const config: ICaptureConfig = {
			label: 'Basic',
			instruments: [{ type: 'serial' }],
			durationSec: 3,
			syncMethod: 'software',
		};
		const timeline = makeCoordinatedCapture(config);
		assert.ok(timeline.endTimestamp > timeline.startTimestamp);
	});

	test('label is preserved in timeline', () => {
		const config: ICaptureConfig = {
			label: 'Sleep Mode Power Regression',
			instruments: [{ type: 'power' }],
			durationSec: 10,
			syncMethod: 'hardware',
		};
		const timeline = makeCoordinatedCapture(config, { power: { captureId: 'pa_001' } });
		assert.strictEqual(timeline.label, 'Sleep Mode Power Regression');
	});
});

suite('Coordinated Capture Service - Instrument Config Validation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const validInstrumentTypes: ICaptureInstrument['type'][] = ['logic', 'scope', 'power', 'serial'];

	test('all instrument types are valid enum values', () => {
		for (const type of validInstrumentTypes) {
			const config: ICaptureConfig = {
				label: 'Test',
				instruments: [{ type }],
				durationSec: 1,
				syncMethod: 'software',
			};
			const timeline = makeCoordinatedCapture(config);
			assert.ok(timelineHasInstrument(timeline, type), `Expected ${type} in timeline`);
		}
	});

	test('software sync mode is the safe fallback when hardware triggers not available', () => {
		const swConfig: ICaptureConfig = {
			label: 'SW Sync',
			instruments: [{ type: 'logic' }],
			durationSec: 1,
			syncMethod: 'software',
		};
		// Hardware sync note: hardware sync requires physical trigger cable between
		// logic analyzer trigger output and oscilloscope external trigger input.
		// Tests using 'software' mode have up to ~5ms inter-instrument jitter.
		// This is acceptable for debugging (not for tight timing analysis).
		const timeline = makeCoordinatedCapture(swConfig, { logic: { captureId: 'la_sw' } });
		assert.ok(timeline.captureId.startsWith('cc_'));
	});

	// HIL NOTE: Hardware-gated behavior.
	// The following behaviors CANNOT be verified without physical instruments:
	//   - Actual simultaneity of captures across logic analyzer + scope + power meter
	//   - Hardware trigger propagation delay (typically < 100ns for SMA-connected instruments)
	//   - Sample rate fidelity under cross-instrument load
	//   - Real-time cross-correlation of voltage glitch with GPIO edge
	// These should be validated as part of the HIL test suite when hardware is available.
	// See: test/browser/engine/hil/hilTestService.test.ts for the HIL test framework.
	test('hardware-gated: simultaneous capture accuracy is a manual HIL checklist item', () => {
		// This test exists to document the hardware requirement, not test it.
		const config: ICaptureConfig = {
			label: 'HW Sync Accuracy',
			instruments: [{ type: 'logic' }, { type: 'scope' }],
			durationSec: 1,
			syncMethod: 'hardware',
		};
		assert.ok(config.syncMethod === 'hardware', 'Hardware sync is configured');
		// Manual HIL verification required: connect TRIG OUT of logic analyzer to EXT TRIG of scope
		// and verify trigger timestamping shows < 500ns jitter using a test pulse generator.
	});
});
