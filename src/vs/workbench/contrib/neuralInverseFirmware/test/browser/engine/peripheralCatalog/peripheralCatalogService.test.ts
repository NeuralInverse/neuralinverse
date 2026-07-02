/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { BUILTIN_CATALOG } from '../../../../browser/engine/peripheralCatalog/builtinCatalog.js';
import { IPeripheralCatalogEntry } from '../../../../browser/engine/peripheralCatalog/peripheralCatalogTypes.js';

// ─── In-memory service implementation (same logic as the real service) ────────

function makeInMemoryCatalogService(entries: IPeripheralCatalogEntry[] = BUILTIN_CATALOG) {
	const session: IPeripheralCatalogEntry[] = [];

	function search(query: string): IPeripheralCatalogEntry[] {
		const q = query.toLowerCase();
		return entries.filter(e =>
			e.partNumber.toLowerCase().includes(q) ||
			e.description.toLowerCase().includes(q) ||
			e.category.toLowerCase().includes(q) ||
			(e.manufacturer && e.manufacturer.toLowerCase().includes(q))
		);
	}

	function getEntry(partNumber: string): IPeripheralCatalogEntry | null {
		return entries.find(e => e.partNumber.toUpperCase() === partNumber.toUpperCase()) ?? null;
	}

	function attachToSession(partNumber: string): void {
		const entry = getEntry(partNumber);
		if (entry && !session.find(e => e.partNumber === entry.partNumber)) {
			session.push(entry);
		}
	}

	function detachFromSession(partNumber: string): void {
		const idx = session.findIndex(e => e.partNumber.toUpperCase() === partNumber.toUpperCase());
		if (idx >= 0) { session.splice(idx, 1); }
	}

	function getSessionPeripherals(): IPeripheralCatalogEntry[] {
		return [...session];
	}

	function getSystemPromptSection(): string {
		if (session.length === 0) { return ''; }
		const lines = ['Connected peripherals:'];
		for (const e of session) {
			lines.push(`  ${e.partNumber} (${e.manufacturer ?? 'unknown'}) — ${e.description} via ${e.interface}`);
			if (e.driverNotes) { lines.push(`    Driver notes: ${e.driverNotes}`); }
		}
		return lines.join('\n');
	}

	return { search, getEntry, attachToSession, detachFromSession, getSessionPeripherals, getSystemPromptSection, getCatalogSize: () => entries.length };
}

suite('Peripheral Catalog Service - Builtin Catalog', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('builtin catalog is non-empty', () => {
		assert.ok(BUILTIN_CATALOG.length > 0, `Expected builtin catalog entries, got ${BUILTIN_CATALOG.length}`);
	});

	test('all builtin entries have required fields', () => {
		for (const entry of BUILTIN_CATALOG) {
			assert.ok(entry.partNumber, `Missing partNumber: ${JSON.stringify(entry)}`);
			assert.ok(entry.description, `Missing description for ${entry.partNumber}`);
			assert.ok(entry.category, `Missing category for ${entry.partNumber}`);
			assert.ok(entry.interface, `Missing interface for ${entry.partNumber}`);
			assert.ok(Array.isArray(entry.pinout), `Pinout must be array for ${entry.partNumber}`);
		}
	});

	test('catalog contains at least one I2C sensor', () => {
		const i2cSensors = BUILTIN_CATALOG.filter(e => e.interface === 'i2c');
		assert.ok(i2cSensors.length > 0, 'Expected at least one I2C sensor in builtin catalog');
	});

	test('catalog contains at least one SPI device', () => {
		const spiDevices = BUILTIN_CATALOG.filter(e => e.interface === 'spi');
		assert.ok(spiDevices.length > 0, 'Expected at least one SPI device in builtin catalog');
	});
});

suite('Peripheral Catalog Service - Search', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const svc = makeInMemoryCatalogService();

	test('search by category "imu" returns IMU devices', () => {
		const results = svc.search('imu');
		assert.ok(results.length > 0, 'Expected at least one IMU in catalog');
		assert.ok(results.every(e => e.category === 'imu' || e.description.toLowerCase().includes('imu') || e.description.toLowerCase().includes('gyro') || e.description.toLowerCase().includes('accelerom')));
	});

	test('search by part number prefix is case-insensitive', () => {
		if (BUILTIN_CATALOG.length === 0) { return; }
		const first = BUILTIN_CATALOG[0]!;
		const lower = svc.search(first.partNumber.toLowerCase());
		const upper = svc.search(first.partNumber.toUpperCase());
		assert.strictEqual(lower.length, upper.length, 'Case should not matter for search');
	});

	test('search for non-existent part returns empty array', () => {
		const results = svc.search('XYZNOPARTMATCH99999');
		assert.deepStrictEqual(results, []);
	});
});

suite('Peripheral Catalog Service - getEntry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const svc = makeInMemoryCatalogService();

	test('getEntry returns null for unknown part', () => {
		const entry = svc.getEntry('UNKNOWN-PART-9999');
		assert.strictEqual(entry, null);
	});

	test('getEntry is case-insensitive', () => {
		if (BUILTIN_CATALOG.length === 0) { return; }
		const partNumber = BUILTIN_CATALOG[0]!.partNumber;
		const upper = svc.getEntry(partNumber.toUpperCase());
		const lower = svc.getEntry(partNumber.toLowerCase());
		assert.deepStrictEqual(upper, lower);
	});
});

suite('Peripheral Catalog Service - Session Management', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('session starts empty', () => {
		const svc = makeInMemoryCatalogService();
		assert.strictEqual(svc.getSessionPeripherals().length, 0);
	});

	test('attachToSession adds peripheral', () => {
		const svc = makeInMemoryCatalogService();
		if (BUILTIN_CATALOG.length === 0) { return; }
		svc.attachToSession(BUILTIN_CATALOG[0]!.partNumber);
		assert.strictEqual(svc.getSessionPeripherals().length, 1);
	});

	test('attachToSession is idempotent', () => {
		const svc = makeInMemoryCatalogService();
		if (BUILTIN_CATALOG.length === 0) { return; }
		const pn = BUILTIN_CATALOG[0]!.partNumber;
		svc.attachToSession(pn);
		svc.attachToSession(pn);
		assert.strictEqual(svc.getSessionPeripherals().length, 1, 'Should not add duplicate');
	});

	test('detachFromSession removes peripheral', () => {
		const svc = makeInMemoryCatalogService();
		if (BUILTIN_CATALOG.length === 0) { return; }
		const pn = BUILTIN_CATALOG[0]!.partNumber;
		svc.attachToSession(pn);
		assert.strictEqual(svc.getSessionPeripherals().length, 1);
		svc.detachFromSession(pn);
		assert.strictEqual(svc.getSessionPeripherals().length, 0);
	});

	test('detachFromSession is safe when peripheral not attached', () => {
		const svc = makeInMemoryCatalogService();
		assert.doesNotThrow(() => svc.detachFromSession('NOTATTACHED-9999'));
	});

	test('getSystemPromptSection returns empty string when no peripherals attached', () => {
		const svc = makeInMemoryCatalogService();
		const section = svc.getSystemPromptSection();
		assert.strictEqual(section, '');
	});

	test('getSystemPromptSection includes part number when peripheral attached', () => {
		const svc = makeInMemoryCatalogService();
		if (BUILTIN_CATALOG.length === 0) { return; }
		const pn = BUILTIN_CATALOG[0]!.partNumber;
		svc.attachToSession(pn);
		const section = svc.getSystemPromptSection();
		assert.ok(section.includes(pn), `Expected ${pn} in system prompt section`);
	});

	test('getSystemPromptSection includes driver notes when present', () => {
		const testEntry: IPeripheralCatalogEntry = {
			partNumber: 'TEST-SENSOR-X',
			manufacturer: 'TestCo',
			description: 'Test sensor',
			category: 'sensor',
			interface: 'i2c',
			voltage: '3.3V',
			pinout: [],
			driverNotes: 'Set register 0x1A to 0x07 to start measurement.',
		};
		const svc = makeInMemoryCatalogService([testEntry]);
		svc.attachToSession('TEST-SENSOR-X');
		const section = svc.getSystemPromptSection();
		assert.ok(section.includes('0x1A') || section.includes('driver') || section.includes('Driver'), `Got: ${section}`);
	});
});
