/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { BUILTIN_ERRATA, lookupErrataForMCU, searchErrata } from '../../../../browser/engine/errata/errataDatabase.js';

suite('Errata Database', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	// ─── BUILTIN_ERRATA structure ──────────────────────────────────────────────

	test('BUILTIN_ERRATA contains at least 6 families', () => {
		assert.ok(BUILTIN_ERRATA.length >= 6, `Expected >= 6 families, got ${BUILTIN_ERRATA.length}`);
	});

	test('every errata entry has required fields', () => {
		for (const family of BUILTIN_ERRATA) {
			for (const e of family.errata) {
				assert.ok(e.id, `Missing id in family ${family.family}`);
				assert.ok(e.title, `Missing title for ${e.id}`);
				assert.ok(e.affectedPeripheral, `Missing affectedPeripheral for ${e.id}`);
				assert.ok(e.description, `Missing description for ${e.id}`);
				assert.ok(['critical', 'major', 'minor'].includes(e.severity), `Invalid severity "${e.severity}" for ${e.id}`);
				assert.ok(Array.isArray(e.affectedRevisions), `Missing affectedRevisions for ${e.id}`);
			}
		}
	});

	test('all errata IDs are unique across families', () => {
		const ids = BUILTIN_ERRATA.flatMap(f => f.errata.map(e => e.id));
		const unique = new Set(ids);
		assert.strictEqual(ids.length, unique.size, `Duplicate errata IDs found: ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`);
	});

	// ─── lookupErrataForMCU ────────────────────────────────────────────────────

	test('lookupErrataForMCU("STM32F407") returns STM32F4 errata', () => {
		const errata = lookupErrataForMCU('STM32F407');
		assert.ok(errata.length > 0, 'Expected non-empty errata for STM32F407');
		assert.ok(errata.some(e => e.id.includes('STM32F4')));
	});

	test('lookupErrataForMCU("STM32F407") returns I2C BUSY bug (ES_STM32F4_2.1.8)', () => {
		const errata = lookupErrataForMCU('STM32F407');
		const busy = errata.find(e => e.id === 'ES_STM32F4_2.1.8');
		assert.ok(busy, 'ES_STM32F4_2.1.8 not found for STM32F407');
		assert.strictEqual(busy!.affectedPeripheral, 'I2C');
		assert.strictEqual(busy!.severity, 'critical');
	});

	test('lookupErrataForMCU("STM32F407") returns DMA2 AHB/APB bug (ES_STM32F4_2.5.1)', () => {
		const errata = lookupErrataForMCU('STM32F407');
		const dma = errata.find(e => e.id === 'ES_STM32F4_2.5.1');
		assert.ok(dma, 'ES_STM32F4_2.5.1 not found for STM32F407');
		assert.strictEqual(dma!.affectedPeripheral, 'DMA');
		assert.strictEqual(dma!.severity, 'critical');
	});

	test('lookupErrataForMCU("nRF52840") returns nRF52 errata including E78', () => {
		const errata = lookupErrataForMCU('nRF52840');
		assert.ok(errata.length > 0, 'Expected errata for nRF52840');
		const e78 = errata.find(e => e.id === 'nRF52_E78');
		assert.ok(e78, 'nRF52_E78 not found for nRF52840');
		assert.strictEqual(e78!.affectedPeripheral, 'RADIO');
	});

	test('lookupErrataForMCU("ESP32") returns deep-sleep SPI flash bug (ESP32_ECO3_3.9)', () => {
		const errata = lookupErrataForMCU('ESP32');
		const deepSleep = errata.find(e => e.id === 'ESP32_ECO3_3.9');
		assert.ok(deepSleep, 'ESP32_ECO3_3.9 not found for ESP32');
		assert.strictEqual(deepSleep!.affectedPeripheral, 'SPI');
	});

	test('lookupErrataForMCU("RP2040") returns SSI deadlock bug (RP2040_E7)', () => {
		const errata = lookupErrataForMCU('RP2040');
		const ssi = errata.find(e => e.id === 'RP2040_E7');
		assert.ok(ssi, 'RP2040_E7 not found for RP2040');
		assert.strictEqual(ssi!.severity, 'critical');
	});

	test('lookupErrataForMCU("UNKNOWN999") returns empty array', () => {
		const errata = lookupErrataForMCU('UNKNOWN999');
		assert.strictEqual(errata.length, 0, 'Expected empty errata for unknown MCU');
	});

	test('lookupErrataForMCU is case-insensitive', () => {
		const upper = lookupErrataForMCU('STM32F407VG');
		const lower = lookupErrataForMCU('stm32f407vg');
		assert.strictEqual(upper.length, lower.length);
	});

	// ─── searchErrata ──────────────────────────────────────────────────────────

	test('searchErrata by peripheral "I2C" for STM32F4 returns I2C errata', () => {
		const results = searchErrata({ peripheral: 'I2C', mcuFamily: 'STM32F407' });
		assert.ok(results.length > 0, 'Expected I2C errata for STM32F4');
		assert.ok(results.every(e => e.affectedPeripheral.toUpperCase().includes('I2C') || 'I2C'.includes(e.affectedPeripheral.toUpperCase())));
	});

	test('searchErrata by operation "busy" finds I2C BUSY bug', () => {
		const results = searchErrata({ operation: 'busy', mcuFamily: 'STM32F407' });
		assert.ok(results.some(e => e.id === 'ES_STM32F4_2.1.8'));
	});

	test('searchErrata by peripheral "DMA" for STM32F4 finds AHB/APB bug', () => {
		const results = searchErrata({ peripheral: 'DMA', mcuFamily: 'STM32F407' });
		assert.ok(results.some(e => e.id === 'ES_STM32F4_2.5.1'));
	});

	test('searchErrata with no mcuFamily returns results across all families', () => {
		const results = searchErrata({ peripheral: 'USB' });
		assert.ok(results.length > 0, 'Expected USB errata across families');
		const families = new Set(results.map(e => e.id.split('_')[0]));
		assert.ok(families.size >= 2, 'Expected USB errata from multiple families');
	});

	test('searchErrata with no query params and mcuFamily returns all MCU errata', () => {
		const results = searchErrata({ mcuFamily: 'STM32F407' });
		assert.ok(results.length > 0);
	});

	test('all critical errata have workarounds', () => {
		const critical = BUILTIN_ERRATA.flatMap(f => f.errata).filter(e => e.severity === 'critical');
		for (const e of critical) {
			assert.ok(e.workaround && e.workaround.length > 10, `Critical errata ${e.id} missing workaround`);
		}
	});
});
