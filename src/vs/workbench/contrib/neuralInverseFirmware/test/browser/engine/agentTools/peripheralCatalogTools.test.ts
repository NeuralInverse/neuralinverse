/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';
import { buildPeripheralCatalogTools } from '../../../../browser/engine/agentTools/peripheralCatalogTools.js';
import { IPeripheralCatalogEntry } from '../../../../browser/engine/peripheralCatalog/peripheralCatalogTypes.js';

const MOCK_MPU6050: IPeripheralCatalogEntry = {
	partNumber: 'MPU-6050',
	manufacturer: 'TDK InvenSense',
	description: '6-axis IMU: 3-axis gyroscope + 3-axis accelerometer via I2C',
	category: 'imu',
	interfaces: ['i2c'],
	i2cAddress: [0x68, 0x69],
	datasheetUrl: 'https://invensense.tdk.com/wp-content/uploads/2015/02/MPU-6000-Datasheet1.pdf',
	agentHints: ['Write 0x00 to PWR_MGMT_1 (0x6B) to wake device from sleep mode.'],
	driverExamples: ['// SDA/SCL wiring: VDD=2.375-3.46V, INT=interrupt output'],
};

const MOCK_W25Q128: IPeripheralCatalogEntry = {
	partNumber: 'W25Q128JV',
	manufacturer: 'Winbond',
	description: '128Mbit SPI NOR Flash',
	category: 'flash',
	interfaces: ['spi'],
	agentHints: ['Send 0x06 (WREN) before any write or erase.'],
};

function makeMockCatalogService(overrides: {
	entries?: IPeripheralCatalogEntry[];
	sessionEntries?: IPeripheralCatalogEntry[];
	catalogSize?: number;
} = {}) {
	const catalog = overrides.entries ?? [MOCK_MPU6050, MOCK_W25Q128];
	const session: IPeripheralCatalogEntry[] = [...(overrides.sessionEntries ?? [])];

	return {
		_serviceBrand: undefined as any,
		getCatalogSize: () => overrides.catalogSize ?? catalog.length,
		search: (query: string) => catalog.filter(e =>
			e.partNumber.toLowerCase().includes(query.toLowerCase()) ||
			e.description.toLowerCase().includes(query.toLowerCase()) ||
			e.category.toLowerCase().includes(query.toLowerCase())
		),
		getEntry: (partNumber: string) => catalog.find(e => e.partNumber.toUpperCase() === partNumber.toUpperCase()) ?? null,
		attachToSession: (partNumber: string) => {
			const entry = catalog.find(e => e.partNumber.toUpperCase() === partNumber.toUpperCase());
			if (entry && !session.find(e => e.partNumber === entry.partNumber)) {
				session.push(entry);
			}
		},
		detachFromSession: (partNumber: string) => {
			const idx = session.findIndex(e => e.partNumber.toUpperCase() === partNumber.toUpperCase());
			if (idx >= 0) { session.splice(idx, 1); }
		},
		getSessionPeripherals: () => [...session],
		getSystemPromptSection: () => session.length > 0
			? `Connected peripherals: ${session.map(e => e.partNumber).join(', ')}`
			: 'No peripherals attached to session.',
	};
}

suite('Peripheral Catalog Agent Tools', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('buildPeripheralCatalogTools returns 6 tools', () => {
		const tools = buildPeripheralCatalogTools({} as any, makeMockCatalogService() as any);
		assert.strictEqual(tools.length, 6);
	});

	test('tool names include all expected catalog tools', () => {
		const tools = buildPeripheralCatalogTools({} as any, makeMockCatalogService() as any);
		const names = new Set(tools.map(t => t.name));
		assert.ok(names.has('fw_peripheral_search'));
		assert.ok(names.has('fw_peripheral_add'));
		assert.ok(names.has('fw_peripheral_remove'));
		assert.ok(names.has('fw_peripheral_list'));
		assert.ok(names.has('fw_peripheral_wiring'));
		assert.ok(names.has('fw_peripheral_driver'));
	});

	// ─── fw_peripheral_search ─────────────────────────────────────────────────

	test('fw_peripheral_search finds by part number', async () => {
		const tools = buildPeripheralCatalogTools({} as any, makeMockCatalogService() as any);
		const tool = tools.find(t => t.name === 'fw_peripheral_search')!;
		const result = await tool.execute({ query: 'MPU' });
		assert.ok(result.includes('MPU-6050') || result.includes('IMU') || result.includes('InvenSense'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_peripheral_search finds by category', async () => {
		const tools = buildPeripheralCatalogTools({} as any, makeMockCatalogService() as any);
		const tool = tools.find(t => t.name === 'fw_peripheral_search')!;
		const result = await tool.execute({ query: 'flash' });
		assert.ok(result.includes('W25Q128') || result.includes('Flash') || result.includes('Winbond'), `Result: ${result.slice(0, 200)}`);
	});

	test('fw_peripheral_search with no results shows no-results message', async () => {
		const tools = buildPeripheralCatalogTools({} as any, makeMockCatalogService() as any);
		const tool = tools.find(t => t.name === 'fw_peripheral_search')!;
		const result = await tool.execute({ query: 'xyznomatch99999' });
		assert.ok(result.toLowerCase().includes('no') && (result.toLowerCase().includes('found') || result.toLowerCase().includes('match')));
	});

	// ─── fw_peripheral_add ────────────────────────────────────────────────────

	test('fw_peripheral_add attaches peripheral to session', async () => {
		const svc = makeMockCatalogService();
		const tools = buildPeripheralCatalogTools({} as any, svc as any);
		const tool = tools.find(t => t.name === 'fw_peripheral_add')!;
		const result = await tool.execute({ partNumber: 'MPU-6050' });
		assert.ok(result.includes('MPU-6050') || result.includes('added') || result.includes('attached'), `Result: ${result.slice(0, 200)}`);
		assert.strictEqual(svc.getSessionPeripherals().length, 1);
	});

	test('fw_peripheral_add unknown part number returns not found message', async () => {
		const tools = buildPeripheralCatalogTools({} as any, makeMockCatalogService() as any);
		const tool = tools.find(t => t.name === 'fw_peripheral_add')!;
		const result = await tool.execute({ partNumber: 'NOTAPART9999' });
		assert.ok(result.toLowerCase().includes('not found') || result.toLowerCase().includes('fw_peripheral_search'));
	});

	// ─── fw_peripheral_remove ────────────────────────────────────────────────

	test('fw_peripheral_remove detaches peripheral from session', async () => {
		const svc = makeMockCatalogService({ sessionEntries: [MOCK_MPU6050] });
		const tools = buildPeripheralCatalogTools({} as any, svc as any);
		const tool = tools.find(t => t.name === 'fw_peripheral_remove')!;
		await tool.execute({ partNumber: 'MPU-6050' });
		assert.strictEqual(svc.getSessionPeripherals().length, 0);
	});

	// ─── fw_peripheral_list ───────────────────────────────────────────────────

	test('fw_peripheral_list with empty session shows no peripherals message', async () => {
		const tools = buildPeripheralCatalogTools({} as any, makeMockCatalogService() as any);
		const tool = tools.find(t => t.name === 'fw_peripheral_list')!;
		const result = await tool.execute({});
		assert.ok(result.toLowerCase().includes('no peripheral') || result.toLowerCase().includes('empty') || result.toLowerCase().includes('none'));
	});

	test('fw_peripheral_list shows attached peripherals', async () => {
		const tools = buildPeripheralCatalogTools({} as any, makeMockCatalogService({ sessionEntries: [MOCK_MPU6050, MOCK_W25Q128] }) as any);
		const tool = tools.find(t => t.name === 'fw_peripheral_list')!;
		const result = await tool.execute({});
		assert.ok(result.includes('MPU-6050'));
		assert.ok(result.includes('W25Q128'));
	});

	// ─── fw_peripheral_wiring ─────────────────────────────────────────────────

	test('fw_peripheral_wiring for I2C device shows SDA/SCL pinout', async () => {
		const tools = buildPeripheralCatalogTools({} as any, makeMockCatalogService() as any);
		const tool = tools.find(t => t.name === 'fw_peripheral_wiring')!;
		const result = await tool.execute({ partNumber: 'MPU-6050' });
		assert.ok(result.includes('SDA') || result.includes('SCL') || result.includes('I2C'), `Result: ${result.slice(0, 200)}`);
	});

	// ─── fw_peripheral_driver ─────────────────────────────────────────────────

	test('fw_peripheral_driver shows driver notes', async () => {
		const tools = buildPeripheralCatalogTools({} as any, makeMockCatalogService() as any);
		const tool = tools.find(t => t.name === 'fw_peripheral_driver')!;
		const result = await tool.execute({ partNumber: 'MPU-6050' });
		assert.ok(result.includes('PWR_MGMT_1') || result.includes('wake') || result.includes('driver'), `Result: ${result.slice(0, 200)}`);
	});
});
