/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { ClockTreeSolver, IClockTarget } from '../../../../browser/engine/clockTree/clockTreeSolver.js';

suite('ClockTreeSolver', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	let solver: ClockTreeSolver;

	setup(() => {
		solver = new ClockTreeSolver();
	});

	test('solve() for STM32F4 at 168MHz with 8MHz HSE and USB requirement includes M=8,N=336,P=2,Q=7', () => {
		const target: IClockTarget = { sysclkMHz: 168, usb48Required: true };
		const solutions = solver.solve(8, target, 'STM32F4');

		assert.ok(solutions.length > 0, 'Should find at least one solution');

		const expected = solutions.find(
			s => s.pll.m === 8 && s.pll.n === 336 && s.pll.p === 2 && s.pll.q === 7
		);
		assert.ok(expected, 'Should include M=8, N=336, P=2, Q=7 solution');
		assert.strictEqual(expected!.sysclkMHz, 168);
		assert.strictEqual(expected!.pll48MHz, 48);
	});

	test('solve() for STM32F4 at 84MHz returns valid solutions', () => {
		const target: IClockTarget = { sysclkMHz: 84, usb48Required: false };
		const solutions = solver.solve(8, target, 'STM32F4');

		assert.ok(solutions.length > 0, 'Should find valid solutions at 84MHz');
		for (const sol of solutions) {
			assert.strictEqual(sol.sysclkMHz, 84);
		}
	});

	test('solve() with impossible target (500MHz on F4) returns empty array', () => {
		const target: IClockTarget = { sysclkMHz: 500, usb48Required: false };
		const solutions = solver.solve(8, target, 'STM32F4');

		assert.strictEqual(solutions.length, 0);
	});

	test('solve() for STM32H7 at 480MHz with 25MHz HSE returns valid solution', () => {
		const target: IClockTarget = { sysclkMHz: 480, usb48Required: false };
		const solutions = solver.solve(25, target, 'STM32H7');

		assert.ok(solutions.length > 0, 'Should find solutions for H7 at 480MHz');
		for (const sol of solutions) {
			assert.strictEqual(sol.sysclkMHz, 480);
		}
	});

	test('solve() for STM32G4 at 170MHz returns valid solution', () => {
		const target: IClockTarget = { sysclkMHz: 170, usb48Required: false };
		const solutions = solver.solve(8, target, 'STM32G4');

		assert.ok(solutions.length > 0, 'Should find solutions for G4 at 170MHz');
		for (const sol of solutions) {
			assert.strictEqual(sol.sysclkMHz, 170);
		}
	});

	test('all returned solutions pass validation (no errors)', () => {
		const target: IClockTarget = { sysclkMHz: 168, usb48Required: true };
		const solutions = solver.solve(8, target, 'STM32F4');

		assert.ok(solutions.length > 0);
		for (const sol of solutions) {
			// The solver already filters invalid solutions, so all returned
			// should have valid SYSCLK and no violation of constraints
			assert.strictEqual(sol.sysclkMHz, 168);
			assert.ok(sol.vcoMHz >= 100 && sol.vcoMHz <= 432, `VCO ${sol.vcoMHz} should be in F4 range [100, 432]`);
			assert.ok(sol.pllInputMHz >= 1 && sol.pllInputMHz <= 2, `PLL input ${sol.pllInputMHz} should be in [1, 2]`);
		}
	});

	test('solutions sorted by score (first is best)', () => {
		const target: IClockTarget = { sysclkMHz: 168, usb48Required: true };
		const solutions = solver.solve(8, target, 'STM32F4', 10);

		if (solutions.length > 1) {
			for (let i = 1; i < solutions.length; i++) {
				assert.ok(
					solutions[i].score >= solutions[i - 1].score,
					`Solution ${i} score (${solutions[i].score}) should be >= solution ${i - 1} score (${solutions[i - 1].score})`
				);
			}
		}
	});

	test('USB 48MHz constraint satisfied when usb48Required is true', () => {
		const target: IClockTarget = { sysclkMHz: 168, usb48Required: true };
		const solutions = solver.solve(8, target, 'STM32F4');

		assert.ok(solutions.length > 0);
		for (const sol of solutions) {
			assert.ok(sol.pll48MHz !== undefined, 'PLL48 clock should be defined');
			// 0.25% tolerance = 48 +/- 0.12 MHz
			assert.ok(
				Math.abs(sol.pll48MHz! - 48) <= 0.12,
				`PLL48CLK should be within 0.12MHz of 48MHz, got ${sol.pll48MHz}`
			);
		}
	});
});
