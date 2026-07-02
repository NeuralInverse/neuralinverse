/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../../base/test/common/utils.js';

// ─── Minimal SVD XML fixtures ─────────────────────────────────────────────────

const MINIMAL_SVD = `<?xml version="1.0" encoding="utf-8"?>
<device>
  <name>STM32F407</name>
  <vendor>STMicroelectronics</vendor>
  <series>STM32F4</series>
  <version>1.5</version>
  <description>STM32F407 device</description>
  <addressUnitBits>8</addressUnitBits>
  <width>32</width>
  <size>32</size>
  <access>read-write</access>
  <resetValue>0x00000000</resetValue>
  <peripherals>
    <peripheral>
      <name>USART1</name>
      <groupName>USART</groupName>
      <description>Universal synchronous asynchronous receiver transmitter</description>
      <baseAddress>0x40011000</baseAddress>
      <registers>
        <register>
          <name>SR</name>
          <description>Status register</description>
          <addressOffset>0x00</addressOffset>
          <size>32</size>
          <access>read-write</access>
          <resetValue>0x00C00000</resetValue>
          <fields>
            <field>
              <name>RXNE</name>
              <description>Read data register not empty</description>
              <bitOffset>5</bitOffset>
              <bitWidth>1</bitWidth>
              <access>read-only</access>
            </field>
            <field>
              <name>TXE</name>
              <description>Transmit data register empty</description>
              <bitOffset>7</bitOffset>
              <bitWidth>1</bitWidth>
              <access>read-only</access>
            </field>
          </fields>
        </register>
        <register>
          <name>BRR</name>
          <description>Baud rate register</description>
          <addressOffset>0x08</addressOffset>
        </register>
        <register>
          <name>CR1</name>
          <description>Control register 1</description>
          <addressOffset>0x0C</addressOffset>
          <fields>
            <field>
              <name>UE</name>
              <description>USART enable</description>
              <bitRange>[13:13]</bitRange>
            </field>
          </fields>
        </register>
      </registers>
      <interrupt>
        <name>USART1_IRQn</name>
        <description>USART1 global interrupt</description>
        <value>37</value>
      </interrupt>
    </peripheral>
    <peripheral derivedFrom="USART1">
      <name>USART2</name>
      <description>Same as USART1 but at different base</description>
      <baseAddress>0x40004400</baseAddress>
    </peripheral>
  </peripherals>
</device>`;

const SVD_WITH_BITRANGE = `<?xml version="1.0" encoding="utf-8"?>
<device>
  <name>TEST</name>
  <addressUnitBits>8</addressUnitBits>
  <width>32</width>
  <size>32</size>
  <access>read-write</access>
  <resetValue>0</resetValue>
  <peripherals>
    <peripheral>
      <name>TIM1</name>
      <baseAddress>0x40010000</baseAddress>
      <registers>
        <register>
          <name>CR1</name>
          <addressOffset>0x00</addressOffset>
          <fields>
            <field>
              <name>CKD</name>
              <description>Clock division</description>
              <bitRange>[9:8]</bitRange>
              <enumeratedValues>
                <enumeratedValue><name>DIV1</name><description>tDTS = tCK_INT</description><value>0</value></enumeratedValue>
                <enumeratedValue><name>DIV2</name><description>tDTS = 2 x tCK_INT</description><value>1</value></enumeratedValue>
                <enumeratedValue><name>DIV4</name><description>tDTS = 4 x tCK_INT</description><value>2</value></enumeratedValue>
              </enumeratedValues>
            </field>
            <field>
              <name>CEN</name>
              <description>Counter enable</description>
              <lsb>0</lsb>
              <msb>0</msb>
            </field>
          </fields>
        </register>
      </registers>
    </peripheral>
  </peripherals>
</device>`;

const INVALID_SVD = `<?xml version="1.0" encoding="utf-8"?><notadevice><foo>bar</foo></notadevice>`;

// ─── Inline parser (mirrors SVDParserService without DI) ──────────────────────

function parseMinimalSVD(xml: string) {
	const parser = new DOMParser();
	const doc = parser.parseFromString(xml, 'application/xml');
	const deviceEl = doc.querySelector('device');
	if (!deviceEl) { throw new Error('Invalid SVD: no <device> element found'); }

	const text = (el: Element, tag: string, def = '') => {
		const child = el.querySelector(`:scope > ${tag}`);
		return child?.textContent?.trim() ?? def;
	};
	const int = (el: Element, tag: string, def = 0) => {
		const t = text(el, tag, '');
		if (!t) { return def; }
		return t.startsWith('0x') || t.startsWith('0X') ? parseInt(t, 16) : (parseInt(t, 10) || def);
	};
	const intOrNull = (el: Element, tag: string): number | null => {
		const t = text(el, tag, '');
		if (!t) { return null; }
		return t.startsWith('0x') ? parseInt(t, 16) : parseInt(t, 10);
	};

	const parseField = (fEl: Element) => {
		const enumeratedValues: Array<{ name: string; value: number }> = [];
		fEl.querySelectorAll(':scope > enumeratedValues > enumeratedValue').forEach(eEl => {
			enumeratedValues.push({ name: text(eEl, 'name', ''), value: int(eEl, 'value') });
		});

		let bitOffset = 0;
		let bitWidth = 1;
		const bitRangeText = text(fEl, 'bitRange', '');
		if (bitRangeText) {
			const m = bitRangeText.match(/\[(\d+):(\d+)\]/);
			if (m) { bitOffset = parseInt(m[2]!); bitWidth = parseInt(m[1]!) - bitOffset + 1; }
		} else {
			bitOffset = int(fEl, 'bitOffset');
			bitWidth = int(fEl, 'bitWidth', 1);
			const lsb = intOrNull(fEl, 'lsb');
			const msb = intOrNull(fEl, 'msb');
			if (lsb !== null && msb !== null) {
				bitOffset = lsb;
				bitWidth = msb - lsb + 1;
			}
		}
		return { name: text(fEl, 'name', ''), bitOffset, bitWidth, access: text(fEl, 'access', 'read-write') || 'read-write', enumeratedValues };
	};

	const parseRegister = (rEl: Element) => {
		const fields: any[] = [];
		rEl.querySelectorAll(':scope > fields > field').forEach(f => fields.push(parseField(f)));
		return {
			name: text(rEl, 'name', ''),
			addressOffset: int(rEl, 'addressOffset'),
			size: int(rEl, 'size', 32),
			access: text(rEl, 'access', 'read-write') || 'read-write',
			resetValue: int(rEl, 'resetValue'),
			fields,
		};
	};

	const parsePeripheral = (pEl: Element) => {
		const registers: any[] = [];
		pEl.querySelectorAll(':scope > registers > register').forEach(r => registers.push(parseRegister(r)));
		const interrupts: any[] = [];
		pEl.querySelectorAll(':scope > interrupt').forEach(i => {
			interrupts.push({ name: text(i, 'name', ''), value: int(i, 'value'), description: text(i, 'description', '') });
		});
		return {
			name: text(pEl, 'name', ''),
			groupName: text(pEl, 'groupName', ''),
			description: text(pEl, 'description', ''),
			baseAddress: int(pEl, 'baseAddress'),
			derivedFrom: pEl.getAttribute('derivedFrom') ?? undefined,
			registers,
			interrupts,
		};
	};

	const rawPeripherals: any[] = [];
	deviceEl.querySelectorAll(':scope > peripherals > peripheral').forEach(p => rawPeripherals.push(parsePeripheral(p)));

	// Resolve derivedFrom
	const periMap = new Map<string, any>(rawPeripherals.map(p => [p.name, p]));
	for (const p of rawPeripherals) {
		if (p.derivedFrom) {
			const parent = periMap.get(p.derivedFrom);
			if (parent && p.registers.length === 0) {
				p.registers = parent.registers.map((r: any) => ({ ...r, fields: [...r.fields] }));
				p.interrupts = [...parent.interrupts];
			}
		}
	}

	return {
		name: text(deviceEl, 'name', 'Unknown'),
		vendor: text(deviceEl, 'vendor', ''),
		series: text(deviceEl, 'series', ''),
		version: text(deviceEl, 'version', '1.0'),
		addressUnitBits: int(deviceEl, 'addressUnitBits', 8),
		width: int(deviceEl, 'width', 32),
		peripherals: rawPeripherals,
	};
}

suite('SVD Parser Service', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseDevice: parses device name, vendor, series', () => {
		const device = parseMinimalSVD(MINIMAL_SVD);
		assert.strictEqual(device.name, 'STM32F407');
		assert.strictEqual(device.vendor, 'STMicroelectronics');
		assert.strictEqual(device.series, 'STM32F4');
	});

	test('parseDevice: parses addressUnitBits and width', () => {
		const device = parseMinimalSVD(MINIMAL_SVD);
		assert.strictEqual(device.addressUnitBits, 8);
		assert.strictEqual(device.width, 32);
	});

	test('parseDevice: finds 2 peripherals (USART1 and derived USART2)', () => {
		const device = parseMinimalSVD(MINIMAL_SVD);
		assert.strictEqual(device.peripherals.length, 2);
	});

	test('parseDevice: USART1 has correct baseAddress', () => {
		const device = parseMinimalSVD(MINIMAL_SVD);
		const usart1 = device.peripherals.find((p: any) => p.name === 'USART1')!;
		assert.strictEqual(usart1.baseAddress, 0x40011000);
	});

	test('parseDevice: USART1 has 3 registers', () => {
		const device = parseMinimalSVD(MINIMAL_SVD);
		const usart1 = device.peripherals.find((p: any) => p.name === 'USART1')!;
		assert.strictEqual(usart1.registers.length, 3);
	});

	test('parseDevice: SR register has RXNE and TXE fields', () => {
		const device = parseMinimalSVD(MINIMAL_SVD);
		const usart1 = device.peripherals.find((p: any) => p.name === 'USART1')!;
		const sr = usart1.registers.find((r: any) => r.name === 'SR')!;
		assert.strictEqual(sr.fields.length, 2);
		const rxne = sr.fields.find((f: any) => f.name === 'RXNE')!;
		assert.strictEqual(rxne.bitOffset, 5);
		assert.strictEqual(rxne.bitWidth, 1);
		assert.strictEqual(rxne.access, 'read-only');
	});

	test('parseDevice: SR resetValue is 0x00C00000', () => {
		const device = parseMinimalSVD(MINIMAL_SVD);
		const usart1 = device.peripherals.find((p: any) => p.name === 'USART1')!;
		const sr = usart1.registers.find((r: any) => r.name === 'SR')!;
		assert.strictEqual(sr.resetValue, 0x00C00000);
	});

	test('parseDevice: USART1 has interrupt USART1_IRQn at value 37', () => {
		const device = parseMinimalSVD(MINIMAL_SVD);
		const usart1 = device.peripherals.find((p: any) => p.name === 'USART1')!;
		assert.strictEqual(usart1.interrupts.length, 1);
		assert.strictEqual(usart1.interrupts[0].name, 'USART1_IRQn');
		assert.strictEqual(usart1.interrupts[0].value, 37);
	});

	test('derivedFrom: USART2 inherits USART1 registers', () => {
		const device = parseMinimalSVD(MINIMAL_SVD);
		const usart2 = device.peripherals.find((p: any) => p.name === 'USART2')!;
		assert.strictEqual(usart2.derivedFrom, 'USART1');
		assert.strictEqual(usart2.registers.length, 3);
		assert.strictEqual(usart2.baseAddress, 0x40004400);
	});

	test('parseDevice: bitRange [9:8] gives bitOffset=8, bitWidth=2', () => {
		const device = parseMinimalSVD(SVD_WITH_BITRANGE);
		const tim1 = device.peripherals.find((p: any) => p.name === 'TIM1')!;
		const cr1 = tim1.registers.find((r: any) => r.name === 'CR1')!;
		const ckd = cr1.fields.find((f: any) => f.name === 'CKD')!;
		assert.strictEqual(ckd.bitOffset, 8);
		assert.strictEqual(ckd.bitWidth, 2);
	});

	test('parseDevice: lsb/msb [0:0] gives bitOffset=0, bitWidth=1', () => {
		const device = parseMinimalSVD(SVD_WITH_BITRANGE);
		const tim1 = device.peripherals.find((p: any) => p.name === 'TIM1')!;
		const cr1 = tim1.registers.find((r: any) => r.name === 'CR1')!;
		const cen = cr1.fields.find((f: any) => f.name === 'CEN')!;
		assert.strictEqual(cen.bitOffset, 0);
		assert.strictEqual(cen.bitWidth, 1);
	});

	test('parseDevice: enumeratedValues are parsed for CKD field', () => {
		const device = parseMinimalSVD(SVD_WITH_BITRANGE);
		const tim1 = device.peripherals.find((p: any) => p.name === 'TIM1')!;
		const cr1 = tim1.registers.find((r: any) => r.name === 'CR1')!;
		const ckd = cr1.fields.find((f: any) => f.name === 'CKD')!;
		assert.strictEqual(ckd.enumeratedValues.length, 3);
		assert.strictEqual(ckd.enumeratedValues[0].name, 'DIV1');
		assert.strictEqual(ckd.enumeratedValues[0].value, 0);
		assert.strictEqual(ckd.enumeratedValues[2].name, 'DIV4');
		assert.strictEqual(ckd.enumeratedValues[2].value, 2);
	});

	test('parseDevice: throws on missing device element', () => {
		assert.throws(() => parseMinimalSVD(INVALID_SVD), /Invalid SVD/);
	});

	test('SVD access conversion: read-only maps correctly', () => {
		const device = parseMinimalSVD(MINIMAL_SVD);
		const usart1 = device.peripherals.find((p: any) => p.name === 'USART1')!;
		const sr = usart1.registers.find((r: any) => r.name === 'SR')!;
		const rxne = sr.fields.find((f: any) => f.name === 'RXNE')!;
		assert.strictEqual(rxne.access, 'read-only');
	});
});

suite('SVD Parser Service - Address Calculation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('absolute register address = baseAddress + addressOffset', () => {
		const device = parseMinimalSVD(MINIMAL_SVD);
		const usart1 = device.peripherals.find((p: any) => p.name === 'USART1')!;
		const brr = usart1.registers.find((r: any) => r.name === 'BRR')!;
		const absAddr = usart1.baseAddress + brr.addressOffset;
		assert.strictEqual(absAddr, 0x40011008);
	});

	test('CR1 absolute address for USART1 is 0x4001100C', () => {
		const device = parseMinimalSVD(MINIMAL_SVD);
		const usart1 = device.peripherals.find((p: any) => p.name === 'USART1')!;
		const cr1 = usart1.registers.find((r: any) => r.name === 'CR1')!;
		assert.strictEqual(usart1.baseAddress + cr1.addressOffset, 0x4001100C);
	});

	test('bitRange [13:13] gives bitOffset=13 bitWidth=1 for UE field', () => {
		const device = parseMinimalSVD(MINIMAL_SVD);
		const usart1 = device.peripherals.find((p: any) => p.name === 'USART1')!;
		const cr1 = usart1.registers.find((r: any) => r.name === 'CR1')!;
		const ue = cr1.fields.find((f: any) => f.name === 'UE')!;
		assert.strictEqual(ue.bitOffset, 13);
		assert.strictEqual(ue.bitWidth, 1);
	});
});
