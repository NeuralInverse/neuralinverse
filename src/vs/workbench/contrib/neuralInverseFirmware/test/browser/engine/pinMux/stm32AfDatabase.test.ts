/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import {
	getAFDatabaseForFamily,
	getAvailablePinsForVariant,
	filterAFDatabaseForVariant,
	IAFEntry,
} from '../../../../browser/engine/pinMux/stm32AfDatabase.js';

suite('STM32 AF Database - getAFDatabaseForFamily', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('STM32F4 family returns non-empty AF database', () => {
		const db = getAFDatabaseForFamily('STM32F4');
		assert.ok(db.length > 0, `Expected STM32F4 AF entries, got ${db.length}`);
	});

	test('STM32F4 database contains USART1_TX on PA9 AF7', () => {
		const db = getAFDatabaseForFamily('STM32F4');
		const entry = db.find((e: IAFEntry) => e.port === 'A' && e.pin === 9 && e.signal === 'USART1_TX');
		assert.ok(entry, 'Expected PA9 USART1_TX in STM32F4 AF database');
		assert.strictEqual(entry!.af, 7);
	});

	test('STM32F4 database contains I2C1_SCL on PB6 AF4', () => {
		const db = getAFDatabaseForFamily('STM32F4');
		const entry = db.find((e: IAFEntry) => e.port === 'B' && e.pin === 6 && e.signal === 'I2C1_SCL');
		assert.ok(entry, 'Expected PB6 I2C1_SCL in STM32F4 AF database');
		assert.strictEqual(entry!.af, 4);
	});

	test('STM32F4 database contains SPI1_SCK on PA5 AF5', () => {
		const db = getAFDatabaseForFamily('STM32F4');
		const entry = db.find((e: IAFEntry) => e.port === 'A' && e.pin === 5 && e.signal === 'SPI1_SCK');
		assert.ok(entry, 'Expected PA5 SPI1_SCK in STM32F4 database');
		assert.strictEqual(entry!.af, 5);
	});

	test('STM32F4 database contains TIM1 entries', () => {
		const db = getAFDatabaseForFamily('STM32F4');
		const tim1Entries = db.filter((e: IAFEntry) => e.signal.startsWith('TIM1_'));
		assert.ok(tim1Entries.length > 0, 'Expected TIM1 entries in STM32F4 database');
	});

	test('STM32H7 family returns non-empty AF database', () => {
		const db = getAFDatabaseForFamily('STM32H7');
		assert.ok(db.length > 0, `Expected STM32H7 AF entries`);
	});

	test('STM32G4 family returns non-empty AF database', () => {
		const db = getAFDatabaseForFamily('STM32G4');
		assert.ok(db.length > 0, `Expected STM32G4 AF entries`);
	});

	test('unknown family returns empty array', () => {
		const db = getAFDatabaseForFamily('PIC32MX');
		assert.deepStrictEqual(db, []);
	});

	test('all entries have valid port (A-K), pin (0-15), af (0-15)', () => {
		const db = getAFDatabaseForFamily('STM32F4');
		for (const entry of db) {
			assert.ok(/^[A-K]$/.test(entry.port), `Invalid port: ${entry.port} for ${entry.signal}`);
			assert.ok(entry.pin >= 0 && entry.pin <= 15, `Invalid pin: ${entry.pin}`);
			assert.ok(entry.af >= 0 && entry.af <= 15, `Invalid AF: ${entry.af}`);
			assert.ok(entry.signal.length > 0, 'Signal should not be empty');
		}
	});
});

suite('STM32 AF Database - getAvailablePinsForVariant', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('LQFP-64 variant (R suffix) has 51 GPIO pins', () => {
		const pins = getAvailablePinsForVariant('STM32F407RGT6');
		assert.ok(pins !== null, 'Should return pin set for LQFP-64');
		assert.ok(pins!.size >= 48 && pins!.size <= 56, `Expected ~51 GPIO pins for LQFP-64, got ${pins!.size}`);
	});

	test('LQFP-100 variant (V suffix) has more pins than LQFP-64', () => {
		const pinsR = getAvailablePinsForVariant('STM32F407RGT6');
		const pinsV = getAvailablePinsForVariant('STM32F407VGT6');
		assert.ok(pinsR !== null && pinsV !== null);
		assert.ok(pinsV!.size > pinsR!.size, `LQFP-100 should have more pins than LQFP-64`);
	});

	test('TSSOP-20 variant (F suffix) has fewest GPIO pins', () => {
		const pinsF = getAvailablePinsForVariant('STM32F030F4P6');
		assert.ok(pinsF !== null);
		assert.ok(pinsF!.size < 25, `TSSOP-20 should have fewer than 25 GPIO pins, got ${pinsF!.size}`);
	});

	test('returns null for unrecognized variant', () => {
		const pins = getAvailablePinsForVariant('SOMEUNKNOWN');
		assert.strictEqual(pins, null);
	});

	test('pin set contains PA5 for LQFP-64 variant', () => {
		const pins = getAvailablePinsForVariant('STM32F407RGT6');
		assert.ok(pins !== null);
		assert.ok(pins!.has('PA5'), 'PA5 should be present in LQFP-64');
	});
});

suite('STM32 AF Database - filterAFDatabaseForVariant', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('filter removes pins not available in LQFP-48 package', () => {
		const allF4 = getAFDatabaseForFamily('STM32F4');
		// LQFP-48 has C package code (STM32F...C...)
		const filteredC = filterAFDatabaseForVariant(allF4, 'STM32F030C8T6');
		const filteredV = filterAFDatabaseForVariant(allF4, 'STM32F407VGT6');
		// LQFP-100 should have more entries
		assert.ok(filteredV.length >= filteredC.length, `LQFP-100 should have >= entries than LQFP-48`);
	});

	test('filter returns original database when variant not recognized', () => {
		const allF4 = getAFDatabaseForFamily('STM32F4');
		const filtered = filterAFDatabaseForVariant(allF4, 'UNKNOWNPART');
		assert.strictEqual(filtered.length, allF4.length);
	});

	test('filter preserves PA9 USART1_TX AF7 for LQFP-64 packages', () => {
		const allF4 = getAFDatabaseForFamily('STM32F4');
		const filtered = filterAFDatabaseForVariant(allF4, 'STM32F407RGT6');
		const entry = filtered.find((e: IAFEntry) => e.port === 'A' && e.pin === 9 && e.signal === 'USART1_TX');
		assert.ok(entry, 'PA9 USART1_TX should be present in LQFP-64 package');
	});
});
