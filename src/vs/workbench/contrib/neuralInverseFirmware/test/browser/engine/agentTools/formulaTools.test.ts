/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildFormulaTools } from '../../../../browser/engine/agentTools/formulaTools.js';

// ─── Mock FormulaVerifierService ──────────────────────────────────────────────

function makeMockFormulaService() {
	return {
		_serviceBrand: undefined as any,
		verify: (input: { type: string; params: Record<string, number>; expected?: number }) => {
			// Minimal inline computation matching production logic
			const p = input.params;
			let computed = 0;
			let unit = '';
			let formula = '';
			const warnings: string[] = [];

			switch (input.type) {
				case 'uart-baud': {
					const divisor = (p['over8'] ?? 0) ? 8 * (p['brr'] ?? 0) : 16 * (p['brr'] ?? 0);
					computed = divisor > 0 ? (p['fclk'] ?? 0) / divisor : 0;
					unit = 'baud';
					formula = `baud = f_clk / (${p['over8'] ? 8 : 16} × BRR)`;
					if (input.expected && computed > 0) {
						const errorPct = Math.abs(computed - input.expected) / input.expected * 100;
						if (errorPct > 1) warnings.push(`Baud rate error ${errorPct.toFixed(2)}%`);
					}
					break;
				}
				case 'pll-output': {
					const fin = p['fin'] ?? p['hse'] ?? 0;
					const vco = (fin / (p['m'] ?? 1)) * (p['n'] ?? 1);
					computed = vco / (p['p'] ?? 2);
					unit = 'Hz';
					formula = `f_pll = (f_in / M) × N / P`;
					const vcoMHz = vco / 1_000_000;
					if (vcoMHz < 100) warnings.push(`VCO frequency ${vcoMHz.toFixed(1)} MHz is below typical minimum (100 MHz)`);
					if (vcoMHz > 432) warnings.push(`VCO frequency ${vcoMHz.toFixed(1)} MHz exceeds typical maximum (432 MHz for STM32F4)`);
					break;
				}
				case 'pwm-duty': {
					computed = (p['arr'] ?? 0) > 0 ? ((p['ccr'] ?? 0) / ((p['arr'] ?? 0) + 1)) * 100 : 0;
					unit = '%';
					formula = `duty = CCR / (ARR+1) × 100`;
					if ((p['ccr'] ?? 0) > (p['arr'] ?? 0) + 1) warnings.push('CCR > ARR+1 — output will be permanently high (100% duty).');
					break;
				}
				case 'can-bitrate': {
					const bitTime = 1 + (p['bs1'] ?? 1) + (p['bs2'] ?? 1);
					computed = (p['fclk'] ?? 0) / ((p['prescaler'] ?? 1) * bitTime);
					unit = 'bps';
					formula = `bitrate = f_clk / (BRP × (1 + BS1 + BS2))`;
					const sp = ((1 + (p['bs1'] ?? 1)) / bitTime) * 100;
					if (sp < 75 || sp > 87.5) warnings.push(`Sample point at ${sp.toFixed(1)}% — CAN 2.0 recommends 75-87.5%.`);
					break;
				}
				default:
					unit = '';
					formula = input.type;
			}

			const result: any = { computed, unit, formula, warnings };
			if (input.expected !== undefined && input.expected > 0) {
				const deviation = computed - input.expected;
				const deviationPercent = (deviation / input.expected) * 100;
				if (Math.abs(deviationPercent) > 0.01) {
					result.error = { message: `Expected ${input.expected} ${unit}, computed ${computed.toFixed(4)} ${unit}`, deviation, deviationPercent };
				}
			}
			return result;
		},
		listFormulas: () => [
			{ type: 'uart-baud', description: 'UART baud rate from BRR register value', params: [{ name: 'fclk', description: 'Peripheral clock', unit: 'Hz' }, { name: 'brr', description: 'BRR register', unit: '' }], outputUnit: 'baud' },
			{ type: 'pll-output', description: 'PLL output frequency', params: [{ name: 'fin', description: 'Input frequency', unit: 'Hz' }, { name: 'm', description: 'Input divider', unit: '' }, { name: 'n', description: 'Multiplier', unit: '' }, { name: 'p', description: 'Output divider', unit: '' }], outputUnit: 'Hz' },
			{ type: 'pwm-duty', description: 'PWM duty cycle', params: [{ name: 'ccr', description: 'CCR', unit: '' }, { name: 'arr', description: 'ARR', unit: '' }], outputUnit: '%' },
			{ type: 'can-bitrate', description: 'CAN bus bit rate', params: [], outputUnit: 'bps' },
		],
	};
}

suite('Formula Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const svc = makeMockFormulaService();

	test('buildFormulaTools returns 2 tools', () => {
		const tools = buildFormulaTools(svc as any);
		assert.strictEqual(tools.length, 2);
	});

	test('tool names are fw_verify_formula and fw_list_formulas', () => {
		const tools = buildFormulaTools(svc as any);
		const names = tools.map(t => t.name);
		assert.ok(names.includes('fw_verify_formula'));
		assert.ok(names.includes('fw_list_formulas'));
	});

	// ─── fw_list_formulas ──────────────────────────────────────────────────────

	test('fw_list_formulas returns multi-line string with formula types', async () => {
		const tools = buildFormulaTools(svc as any);
		const listTool = tools.find(t => t.name === 'fw_list_formulas')!;
		const result = await listTool.execute({});
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('uart-baud'));
		assert.ok(result.includes('pll-output'));
		assert.ok(result.includes('pwm-duty'));
		assert.ok(result.includes('can-bitrate'));
	});

	test('fw_list_formulas includes output unit for each formula', async () => {
		const tools = buildFormulaTools(svc as any);
		const listTool = tools.find(t => t.name === 'fw_list_formulas')!;
		const result = await listTool.execute({});
		assert.ok(result.includes('baud') || result.includes('Hz') || result.includes('%'));
	});

	// ─── fw_verify_formula: UART baud ─────────────────────────────────────────

	test('fw_verify_formula: UART baud 84MHz / BRR=546 returns computed value', async () => {
		const tools = buildFormulaTools(svc as any);
		const verify = tools.find(t => t.name === 'fw_verify_formula')!;
		const result = await verify.execute({ type: 'uart-baud', params: { fclk: 84_000_000, brr: 546 } });
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('uart-baud'));
		assert.ok(result.includes('Computed:'));
		// 84M / (16*546) ≈ 9615
		assert.ok(result.includes('9615') || result.match(/961\d/), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_verify_formula: UART baud with expected=9600 shows deviation warning', async () => {
		const tools = buildFormulaTools(svc as any);
		const verify = tools.find(t => t.name === 'fw_verify_formula')!;
		const result = await verify.execute({ type: 'uart-baud', params: { fclk: 84_000_000, brr: 546 }, expected: 9600 });
		assert.ok(result.includes('MISMATCH') || result.includes('warning') || result.includes('%'), `Expected mismatch or warning in: ${result.slice(0, 200)}`);
	});

	// ─── fw_verify_formula: PLL ───────────────────────────────────────────────

	test('fw_verify_formula: PLL 8MHz HSE, M=8 N=336 P=2 = 168MHz', async () => {
		const tools = buildFormulaTools(svc as any);
		const verify = tools.find(t => t.name === 'fw_verify_formula')!;
		const result = await verify.execute({ type: 'pll-output', params: { fin: 8_000_000, m: 8, n: 336, p: 2 } });
		assert.ok(result.includes('168') || result.includes('168000000'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_verify_formula: PLL with VCO below 100MHz shows warning', async () => {
		const tools = buildFormulaTools(svc as any);
		const verify = tools.find(t => t.name === 'fw_verify_formula')!;
		// VCO = (8M / 8) * 10 = 10MHz
		const result = await verify.execute({ type: 'pll-output', params: { fin: 8_000_000, m: 8, n: 10, p: 2 } });
		assert.ok(result.toLowerCase().includes('warning') || result.toLowerCase().includes('below') || result.includes('⚠'), `Expected VCO warning: ${result.slice(0, 200)}`);
	});

	test('fw_verify_formula: PLL with VCO above 432MHz shows warning', async () => {
		const tools = buildFormulaTools(svc as any);
		const verify = tools.find(t => t.name === 'fw_verify_formula')!;
		// VCO = (8M / 1) * 100 = 800MHz
		const result = await verify.execute({ type: 'pll-output', params: { fin: 8_000_000, m: 1, n: 100, p: 2 } });
		assert.ok(result.toLowerCase().includes('warning') || result.toLowerCase().includes('exceed') || result.includes('⚠'), `Expected VCO max warning: ${result.slice(0, 200)}`);
	});

	// ─── fw_verify_formula: PWM duty ──────────────────────────────────────────

	test('fw_verify_formula: PWM duty CCR=500 ARR=999 = 50%', async () => {
		const tools = buildFormulaTools(svc as any);
		const verify = tools.find(t => t.name === 'fw_verify_formula')!;
		const result = await verify.execute({ type: 'pwm-duty', params: { ccr: 500, arr: 999 } });
		assert.ok(result.includes('50') || result.includes('50.0'), `Expected 50% in: ${result.slice(0, 200)}`);
	});

	test('fw_verify_formula: PWM duty CCR > ARR+1 triggers permanently-high warning', async () => {
		const tools = buildFormulaTools(svc as any);
		const verify = tools.find(t => t.name === 'fw_verify_formula')!;
		const result = await verify.execute({ type: 'pwm-duty', params: { ccr: 1100, arr: 999 } });
		assert.ok(result.toLowerCase().includes('permanently') || result.includes('⚠') || result.toLowerCase().includes('high'), `Expected permanently-high warning: ${result.slice(0, 200)}`);
	});

	// ─── fw_verify_formula: CAN bitrate ───────────────────────────────────────

	test('fw_verify_formula: CAN sample point out of range triggers warning', async () => {
		const tools = buildFormulaTools(svc as any);
		const verify = tools.find(t => t.name === 'fw_verify_formula')!;
		// bs1=1, bs2=2 => bitTime=4, samplePoint=50% (outside 75-87.5%)
		const result = await verify.execute({ type: 'can-bitrate', params: { fclk: 42_000_000, prescaler: 3, bs1: 1, bs2: 2 } });
		assert.ok(result.toLowerCase().includes('sample') || result.includes('⚠'), `Expected sample point warning: ${result.slice(0, 200)}`);
	});

	// ─── fw_verify_formula: error handling ────────────────────────────────────

	test('fw_verify_formula: missing type returns error message', async () => {
		const tools = buildFormulaTools(svc as any);
		const verify = tools.find(t => t.name === 'fw_verify_formula')!;
		const result = await verify.execute({ params: { fclk: 84_000_000 } });
		assert.ok(result.toLowerCase().includes('error') || result.toLowerCase().includes('provide'));
	});

	test('fw_verify_formula: invalid JSON params string returns error', async () => {
		const tools = buildFormulaTools(svc as any);
		const verify = tools.find(t => t.name === 'fw_verify_formula')!;
		const result = await verify.execute({ type: 'uart-baud', params: 'not-json-{{{' });
		assert.ok(result.toLowerCase().includes('error') || result.toLowerCase().includes('json'));
	});

	test('fw_verify_formula: params as JSON string is parsed correctly', async () => {
		const tools = buildFormulaTools(svc as any);
		const verify = tools.find(t => t.name === 'fw_verify_formula')!;
		const result = await verify.execute({ type: 'uart-baud', params: '{"fclk": 84000000, "brr": 546}' });
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('Computed:') || result.includes('uart-baud'));
	});
});
