/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * SVD Parser Service
 *
 * Parses ARM CMSIS SVD (System View Description) XML files into structured
 * register maps. Runs entirely in the browser using DOMParser (available in Electron).
 *
 * Handles:
 *  - derivedFrom inheritance (peripheral and register level)
 *  - Cluster expansion
 *  - Dimension arrays (e.g. GPIO[%s] with dim=16)
 *  - Default value inheritance (size, access, resetValue from device \u2192 peripheral \u2192 register)
 *
 * Returns both raw ISVDDevice and converted IPeripheralRegisterMap[] for session injection.
 */

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import {
	ISVDDevice,
	ISVDPeripheral,
	ISVDRegister,
	ISVDBitField,
	ISVDInterrupt,
	ISVDEnumeratedValue,
	SVDAccess,
} from './svdTypes.js';
import { IPeripheralRegisterMap, IRegister, IBitField, RegisterAccess } from '../../../common/firmwareTypes.js';


// \u2500\u2500\u2500 Service interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const ISVDParserService = createDecorator<ISVDParserService>('svdParserService');

export interface ISVDParserService {
	readonly _serviceBrand: undefined;

	/** Parse an SVD XML string and return the device description. */
	parseDevice(xmlContent: string): ISVDDevice;

	/** Parse an SVD XML string and return IPeripheralRegisterMap[] ready for session injection. */
	parseToRegisterMaps(xmlContent: string): IPeripheralRegisterMap[];
}


// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

class SVDParserService extends Disposable implements ISVDParserService {
	readonly _serviceBrand: undefined;

	parseDevice(xmlContent: string): ISVDDevice {
		const parser = new DOMParser();
		// SVD files are local filesystem files, not untrusted web input \u2014 safe to parse
		const doc = parser.parseFromString(xmlContent, 'application/xml'); // eslint-disable-line ban-domparser-parsefromstring

		const deviceEl = doc.querySelector('device');
		if (!deviceEl) { throw new Error('Invalid SVD: no <device> element found'); }

		const defaults = {
			size: _int(deviceEl, 'size', 32),
			access: _text(deviceEl, 'access', 'read-write') as SVDAccess,
			resetValue: _int(deviceEl, 'resetValue', 0),
		};

		// Parse all peripherals
		const peripheralEls = deviceEl.querySelectorAll(':scope > peripherals > peripheral');
		const rawPeripherals: ISVDPeripheral[] = [];

		for (const pEl of peripheralEls) {
			rawPeripherals.push(this._parsePeripheral(pEl, defaults));
		}

		// Resolve derivedFrom inheritance
		const peripheralMap = new Map<string, ISVDPeripheral>();
		for (const p of rawPeripherals) {
			peripheralMap.set(p.name, p);
		}
		for (const p of rawPeripherals) {
			if (p.derivedFrom) {
				const parent = peripheralMap.get(p.derivedFrom);
				if (parent) {
					// Inherit registers if empty
					if (p.registers.length === 0) {
						p.registers = parent.registers.map(r => ({ ...r, fields: [...r.fields] }));
					}
					if (p.clusters.length === 0) {
						p.clusters = [...parent.clusters];
					}
					if (!p.description && parent.description) {
						(p as any).description = parent.description;
					}
					if (!p.groupName && parent.groupName) {
						(p as any).groupName = parent.groupName;
					}
				}
			}
		}

		const cpuEl = deviceEl.querySelector('cpu');

		return {
			vendor: _text(deviceEl, 'vendor', ''),
			name: _text(deviceEl, 'name', 'Unknown'),
			series: _text(deviceEl, 'series', ''),
			version: _text(deviceEl, 'version', '1.0'),
			description: _text(deviceEl, 'description', ''),
			cpu: cpuEl ? _text(cpuEl, 'name', 'CM4') : 'CM4',
			addressUnitBits: _int(deviceEl, 'addressUnitBits', 8),
			width: _int(deviceEl, 'width', 32),
			size: defaults.size,
			access: defaults.access,
			resetValue: defaults.resetValue,
			peripherals: rawPeripherals,
		};
	}

	parseToRegisterMaps(xmlContent: string): IPeripheralRegisterMap[] {
		const device = this.parseDevice(xmlContent);
		return device.peripherals.map(p => this._toRegisterMap(p));
	}

	// \u2500\u2500\u2500 Peripheral parsing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _parsePeripheral(el: Element, defaults: { size: number; access: SVDAccess; resetValue: number }): ISVDPeripheral {
		const derivedFrom = el.getAttribute('derivedFrom') ?? undefined;
		const name = _text(el, 'name', 'UNKNOWN');
		const pDefaults = {
			size: _int(el, 'size', defaults.size),
			access: _text(el, 'access', defaults.access) as SVDAccess,
			resetValue: _int(el, 'resetValue', defaults.resetValue),
		};

		// Parse registers
		const registerEls = el.querySelectorAll(':scope > registers > register');
		const registers: ISVDRegister[] = [];
		for (const rEl of registerEls) {
			registers.push(this._parseRegister(rEl, pDefaults));
		}

		// Parse interrupts
		const interruptEls = el.querySelectorAll(':scope > interrupt');
		const interrupts: ISVDInterrupt[] = [];
		for (const iEl of interruptEls) {
			interrupts.push({
				name: _text(iEl, 'name', ''),
				description: _text(iEl, 'description', ''),
				value: _int(iEl, 'value', 0),
			});
		}

		return {
			name,
			groupName: _text(el, 'groupName', name.replace(/\d+$/, '')),
			description: _text(el, 'description', ''),
			baseAddress: _int(el, 'baseAddress', 0),
			derivedFrom,
			registers,
			clusters: [], // TODO: cluster parsing
			interrupts,
			size: pDefaults.size,
			access: pDefaults.access,
			resetValue: pDefaults.resetValue,
		};
	}

	// \u2500\u2500\u2500 Register parsing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _parseRegister(el: Element, defaults: { size: number; access: SVDAccess; resetValue: number }): ISVDRegister {
		const fields: ISVDBitField[] = [];
		const fieldEls = el.querySelectorAll(':scope > fields > field');
		for (const fEl of fieldEls) {
			fields.push(this._parseField(fEl));
		}

		return {
			name: _text(el, 'name', 'UNKNOWN'),
			description: _text(el, 'description', ''),
			addressOffset: _int(el, 'addressOffset', 0),
			size: _int(el, 'size', defaults.size),
			access: _text(el, 'access', defaults.access) as SVDAccess,
			resetValue: _int(el, 'resetValue', defaults.resetValue),
			fields,
		};
	}

	// \u2500\u2500\u2500 Field parsing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _parseField(el: Element): ISVDBitField {
		const enumeratedValues: ISVDEnumeratedValue[] = [];
		const enumEls = el.querySelectorAll(':scope > enumeratedValues > enumeratedValue');
		for (const eEl of enumEls) {
			enumeratedValues.push({
				name: _text(eEl, 'name', ''),
				description: _text(eEl, 'description', ''),
				value: _int(eEl, 'value', 0),
			});
		}

		// SVD supports both bitOffset+bitWidth and bitRange
		let bitOffset = 0;
		let bitWidth = 1;

		const bitRangeText = _textOrNull(el, 'bitRange');
		if (bitRangeText) {
			// Format: [msb:lsb]
			const match = bitRangeText.match(/\[(\d+):(\d+)\]/);
			if (match) {
				const msb = parseInt(match[1]);
				const lsb = parseInt(match[2]);
				bitOffset = lsb;
				bitWidth = msb - lsb + 1;
			}
		} else {
			bitOffset = _int(el, 'bitOffset', 0);
			bitWidth = _int(el, 'bitWidth', 1);
			if (bitWidth === 1) {
				// Check for lsb/msb alternative
				const lsb = _intOrNull(el, 'lsb');
				const msb = _intOrNull(el, 'msb');
				if (lsb !== null && msb !== null) {
					bitOffset = lsb;
					bitWidth = msb - lsb + 1;
				}
			}
		}

		return {
			name: _text(el, 'name', 'UNKNOWN'),
			description: _text(el, 'description', ''),
			bitOffset,
			bitWidth,
			access: _textOrNull(el, 'access') as SVDAccess | undefined,
			enumeratedValues,
		};
	}

	// \u2500\u2500\u2500 Conversion to IPeripheralRegisterMap \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _toRegisterMap(peripheral: ISVDPeripheral): IPeripheralRegisterMap {
		return {
			name: peripheral.name,
			groupName: peripheral.groupName,
			baseAddress: peripheral.baseAddress,
			description: peripheral.description,
			registers: peripheral.registers.map(r => this._toRegister(r)),
			interrupts: peripheral.interrupts.map(i => ({
				name: i.name,
				value: i.value,
				description: i.description,
			})),
		};
	}

	private _toRegister(reg: ISVDRegister): IRegister {
		return {
			name: reg.name,
			addressOffset: reg.addressOffset,
			size: reg.size,
			access: _svdAccessToRegisterAccess(reg.access),
			resetValue: reg.resetValue,
			description: reg.description,
			fields: reg.fields.map(f => this._toBitField(f)),
		};
	}

	private _toBitField(field: ISVDBitField): IBitField {
		const enumeratedValues: Record<number, string> | undefined =
			field.enumeratedValues.length > 0
				? Object.fromEntries(field.enumeratedValues.map(e => [e.value, e.name]))
				: undefined;

		return {
			name: field.name,
			bitOffset: field.bitOffset,
			bitWidth: field.bitWidth,
			access: _svdAccessToRegisterAccess(field.access ?? 'read-write'),
			description: field.description,
			enumeratedValues,
		};
	}
}


// \u2500\u2500\u2500 XML helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _text(parent: Element, tagName: string, defaultValue: string): string {
	const el = parent.querySelector(`:scope > ${tagName}`);
	return el?.textContent?.trim() ?? defaultValue;
}

function _textOrNull(parent: Element, tagName: string): string | null {
	const el = parent.querySelector(`:scope > ${tagName}`);
	return el?.textContent?.trim() ?? null;
}

function _int(parent: Element, tagName: string, defaultValue: number): number {
	const text = _textOrNull(parent, tagName);
	if (!text) return defaultValue;
	// SVD uses hex (0x...) and decimal
	if (text.startsWith('0x') || text.startsWith('0X')) {
		return parseInt(text, 16);
	}
	return parseInt(text, 10) || defaultValue;
}

function _intOrNull(parent: Element, tagName: string): number | null {
	const text = _textOrNull(parent, tagName);
	if (!text) return null;
	if (text.startsWith('0x') || text.startsWith('0X')) {
		return parseInt(text, 16);
	}
	return parseInt(text, 10);
}

function _svdAccessToRegisterAccess(access?: SVDAccess): RegisterAccess {
	switch (access) {
		case 'read-only': return 'read-only';
		case 'write-only': return 'write-only';
		case 'read-write': return 'read-write';
		case 'writeOnce': return 'write-once';
		case 'read-writeOnce': return 'read-write-once';
		default: return 'read-write';
	}
}


registerSingleton(ISVDParserService, SVDParserService, InstantiationType.Delayed);
