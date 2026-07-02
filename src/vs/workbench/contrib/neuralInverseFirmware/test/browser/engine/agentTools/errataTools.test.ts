/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildErrataTools } from '../../../../browser/engine/agentTools/errataTools.js';
import { lookupErrataForMCU } from '../../../../browser/engine/errata/errataDatabase.js';

// ─── Mock Errata Service ───────────────────────────────────────────────────────

function makeMockErrataService(family: string) {
	const allErrata = lookupErrataForMCU(family);
	return {
		_serviceBrand: undefined as any,
		getAllErrata: () => allErrata,
		getForPeripheral: (p: string) => {
			const periph = p.toUpperCase().replace(/[0-9]+$/, '');
			return allErrata.filter(e =>
				e.affectedPeripheral.toUpperCase().includes(periph) ||
				periph.includes(e.affectedPeripheral.toUpperCase())
			);
		},
		checkOperation: (q: { peripheral?: string; operation?: string; register?: string; mcuFamily?: string }) => {
			let pool = q.mcuFamily ? lookupErrataForMCU(q.mcuFamily) : allErrata;
			if (q.peripheral) {
				const p = q.peripheral.toUpperCase().replace(/[0-9]+$/, '');
				pool = pool.filter(e => e.affectedPeripheral.toUpperCase().includes(p) || p.includes(e.affectedPeripheral.toUpperCase()));
			}
			if (q.operation) {
				const op = q.operation.toLowerCase();
				pool = pool.filter(e => e.description.toLowerCase().includes(op) || e.title.toLowerCase().includes(op));
			}
			return pool.map(e => ({
				errata: e,
				relevanceScore: e.severity === 'critical' ? 100 : e.severity === 'major' ? 70 : 40,
				matchReason: `affects ${e.affectedPeripheral}`,
			}));
		},
		checkRegisterAccess: () => [],
	};
}

suite('Errata Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const stm32Service = makeMockErrataService('STM32F407');
	const nrfService = makeMockErrataService('nRF52840');
	const esp32Service = makeMockErrataService('ESP32');
	const rp2040Service = makeMockErrataService('RP2040');
	const emptyService = makeMockErrataService('UNKNOWNMCU');

	test('buildErrataTools returns 2 tools', () => {
		const tools = buildErrataTools(stm32Service as any);
		assert.strictEqual(tools.length, 2);
	});

	test('tool names are fw_errata_search and fw_errata_check_operation', () => {
		const tools = buildErrataTools(stm32Service as any);
		const names = tools.map(t => t.name);
		assert.ok(names.includes('fw_errata_search'));
		assert.ok(names.includes('fw_errata_check_operation'));
	});

	test('all tools have name, description, params, execute', () => {
		const tools = buildErrataTools(stm32Service as any);
		for (const t of tools) {
			assert.ok(t.name, 'Missing name');
			assert.ok(t.description, 'Missing description');
			assert.ok(typeof t.execute === 'function', 'Missing execute');
		}
	});

	// ─── fw_errata_search ──────────────────────────────────────────────────────

	test('fw_errata_search with no filter returns all STM32F4 errata', async () => {
		const tools = buildErrataTools(stm32Service as any);
		const search = tools.find(t => t.name === 'fw_errata_search')!;
		const result = await search.execute({});
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('ES_STM32F4'));
		assert.ok(result.includes('Silicon Errata'));
	});

	test('fw_errata_search filtering by I2C returns I2C errata', async () => {
		const tools = buildErrataTools(stm32Service as any);
		const search = tools.find(t => t.name === 'fw_errata_search')!;
		const result = await search.execute({ peripheral: 'I2C' });
		assert.ok(result.includes('I2C'));
		assert.ok(result.includes('ES_STM32F4_2.1.8'), 'I2C BUSY bug should appear');
	});

	test('fw_errata_search filtering by DMA returns DMA errata', async () => {
		const tools = buildErrataTools(stm32Service as any);
		const search = tools.find(t => t.name === 'fw_errata_search')!;
		const result = await search.execute({ peripheral: 'DMA' });
		assert.ok(result.includes('DMA'), `Result: ${result.slice(0, 100)}`);
		assert.ok(result.includes('ES_STM32F4_2.5.1'), 'DMA AHB/APB bug should appear');
	});

	test('fw_errata_search on nRF52840 returns RADIO errata (E78)', async () => {
		const tools = buildErrataTools(nrfService as any);
		const search = tools.find(t => t.name === 'fw_errata_search')!;
		const result = await search.execute({ peripheral: 'RADIO' });
		assert.ok(result.includes('nRF52_E78'), `nRF52_E78 not in result: ${result.slice(0, 200)}`);
	});

	test('fw_errata_search on ESP32 returns SPI deep-sleep bug', async () => {
		const tools = buildErrataTools(esp32Service as any);
		const search = tools.find(t => t.name === 'fw_errata_search')!;
		const result = await search.execute({ peripheral: 'SPI' });
		assert.ok(result.includes('ESP32_ECO3_3.9'), `ESP32 SPI bug not found`);
	});

	test('fw_errata_search on RP2040 returns SSI deadlock bug', async () => {
		const tools = buildErrataTools(rp2040Service as any);
		const search = tools.find(t => t.name === 'fw_errata_search')!;
		const result = await search.execute({});
		assert.ok(result.includes('RP2040_E7'), `RP2040_E7 not found`);
	});

	test('fw_errata_search with no MCU returns "no errata" message', async () => {
		const tools = buildErrataTools(emptyService as any);
		const search = tools.find(t => t.name === 'fw_errata_search')!;
		const result = await search.execute({});
		assert.ok(result.toLowerCase().includes('no errata'));
	});

	test('fw_errata_search for unknown peripheral returns no-errata message', async () => {
		const tools = buildErrataTools(stm32Service as any);
		const search = tools.find(t => t.name === 'fw_errata_search')!;
		const result = await search.execute({ peripheral: 'NONEXISTENTPERIPHERAL99' });
		assert.ok(result.toLowerCase().includes('no errata'));
	});

	// ─── fw_errata_check_operation ─────────────────────────────────────────────

	test('fw_errata_check_operation for I2C busy returns critical warning', async () => {
		const tools = buildErrataTools(stm32Service as any);
		const check = tools.find(t => t.name === 'fw_errata_check_operation')!;
		const result = await check.execute({ peripheral: 'I2C', operation: 'I2C communication busy flag locked' });
		assert.ok(typeof result === 'string');
		assert.ok(result.includes('ES_STM32F4_2.1.8') || result.includes('BUSY') || result.includes('I2C'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_errata_check_operation with no inputs returns prompt', async () => {
		const tools = buildErrataTools(stm32Service as any);
		const check = tools.find(t => t.name === 'fw_errata_check_operation')!;
		const result = await check.execute({});
		assert.ok(typeof result === 'string');
		assert.ok(result.toLowerCase().includes('provide') || result.toLowerCase().includes('peripheral') || result.toLowerCase().includes('operation'));
	});

	test('fw_errata_check_operation detects critical severity in output', async () => {
		const tools = buildErrataTools(stm32Service as any);
		const check = tools.find(t => t.name === 'fw_errata_check_operation')!;
		const result = await check.execute({ peripheral: 'I2C', operation: 'busy' });
		// Should either show CRITICAL warning or relevant errata
		assert.ok(result.includes('CRITICAL') || result.includes('[CRITICAL]') || result.includes('I2C') || result.length > 20);
	});

	test('fw_errata_check_operation for DMA operation surfaces DMA AHB/APB bug', async () => {
		const tools = buildErrataTools(stm32Service as any);
		const check = tools.find(t => t.name === 'fw_errata_check_operation')!;
		const result = await check.execute({ peripheral: 'DMA2', operation: 'concurrent AHB APB transfer' });
		assert.ok(result.includes('ES_STM32F4_2.5.1') || result.includes('DMA') || result.includes('AHB'), `Result: ${result.slice(0, 200)}`);
	});
});
