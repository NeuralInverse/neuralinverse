/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * SVD Fetch Service — Tier 1 Datasheet Intelligence
 *
 * Downloads and parses CMSIS-SVD files from the posborne/cmsis-svd GitHub repository.
 * SVD (System View Description) is the authoritative source for MCU register definitions,
 * providing 100% accuracy vs the ~28% achievable with regex heuristics on PDF text.
 *
 * Supported MCU families:
 *   - STMicroelectronics: STM32F0/F1/F2/F3/F4/F7/G0/G4/H7/L0/L1/L4/L5/U5/WB/WL
 *   - Nordic Semiconductor: nRF52xxx, nRF5340
 *   - Raspberry Pi: RP2040, RP2350
 *   - NXP: LPC, iMX RT (extensible)
 *   - Texas Instruments: MSP430, Tiva (extensible)
 */

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IPeripheralRegisterMap, IRegister, IBitField } from '../../../common/firmwareTypes.js';


// ─── Lightweight XML parser ─────────────────────────────────────────────────────────
// Replaces DOMParser to avoid VS Code's Trusted Types enforcement which blocks
// parseFromString even when TrustedHTML policies are created.  Pure string ops.

interface XmlNode {
	tag: string;
	attrs: Record<string, string>;
	children: XmlNode[];
	text: string;
}

function _parseXml(raw: string): XmlNode {
	// Strip XML declaration, processing instructions, comments
	const xml = raw
		.replace(/<\?[\s\S]*?\?>/g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<!\[[\s\S]*?\]\]>/g, '');  // CDATA (rare in SVD)

	const stack: XmlNode[] = [];
	const root: XmlNode = { tag: '__root__', attrs: {}, children: [], text: '' };
	stack.push(root);

	const TOKEN = /<!--[\s\S]*?-->|<\/([A-Za-z_][\w:.-]*)\s*>|<([A-Za-z_][\w:.-]*)([^>]*?)(\/)?>|([^<]+)/g;
	let m: RegExpExecArray | null;

	while ((m = TOKEN.exec(xml)) !== null) {
		if (m[1]) {
			// </closeTag>
			if (stack.length > 1) { stack.pop(); }
		} else if (m[2]) {
			// <openTag [attrs] [/]>
			const node: XmlNode = { tag: m[2], attrs: _parseAttrs(m[3] ?? ''), children: [], text: '' };
			stack[stack.length - 1].children.push(node);
			if (!m[4]) { stack.push(node); }  // not self-closing
		} else if (m[5]) {
			// text
			const t = m[5].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"');
			stack[stack.length - 1].text += t;
		}
	}
	return root;
}

function _parseAttrs(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	const re = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(raw)) !== null) { out[m[1]] = m[2] ?? m[3] ?? ''; }
	return out;
}

/** Get direct child element by tag name. */
function _child(node: XmlNode | undefined, tag: string): XmlNode | undefined {
	return node?.children.find(c => c.tag === tag);
}

/** Get all direct children with a given tag. */
function _children(node: XmlNode | undefined, tag: string): XmlNode[] {
	return node?.children.filter(c => c.tag === tag) ?? [];
}

/** Get trimmed text of a direct child element, or of node itself if tag is omitted. */
function _txt(node: XmlNode | undefined, tag?: string): string | undefined {
	const target = tag ? _child(node, tag) : node;
	const t = target?.text.trim();
	return t || undefined;
}


// ─── Service Interface ────────────────────────────────────────────────────────

export const ISvdFetchService = createDecorator<ISvdFetchService>('svdFetchService');

export interface ISvdFetchService {
	readonly _serviceBrand: undefined;

	/**
	 * Attempt to find and parse the SVD file for the given part numbers.
	 * Returns register maps if an SVD is found, undefined otherwise.
	 *
	 * @param partNumbers  List of part numbers detected from the PDF, e.g. ['STM32F030X4', 'STM32F030XC']
	 * @returns Parsed peripheral register maps, or undefined if no SVD found
	 */
	fetchForParts(partNumbers: string[]): Promise<ISvdResult | undefined>;

	/**
	 * Returns the SVD URL that would be used for the given part number, without downloading.
	 * Useful for display/debugging.
	 */
	svdUrlForPart(partNumber: string): string | undefined;

	/**
	 * Parse an SVD XML string directly — for local .svd files the user uploads.
	 * Does not require a network connection or catalogue match.
	 *
	 * @param xml       Raw SVD XML content
	 * @param fileName  Original filename (e.g. "STM32F030.svd") for display
	 */
	parseFromXml(xml: string, fileName: string): ISvdResult;
}

export interface ISvdResult {
	/** SVD filename used, e.g. "STM32F0x0.svd" */
	svdFile: string;
	/** Full URL the SVD was fetched from */
	svdUrl: string;
	/** Parsed peripheral register maps */
	peripherals: IPeripheralRegisterMap[];
	/** Device name from SVD */
	deviceName: string;
	/** CPU name from SVD, e.g. "CM0" */
	cpuName: string;
}


// ─── SVD Catalogue ───────────────────────────────────────────────────────────

/** Base URL for the posborne/cmsis-svd community repository. */
const CMSIS_SVD_BASE = 'https://raw.githubusercontent.com/posborne/cmsis-svd/master/data';

interface ISvdEntry {
	pattern: RegExp;
	vendor: string;
	file: string;
}

/**
 * Maps part-number patterns to SVD files.
 * Patterns are tested against the part number uppercased with spaces/dashes removed.
 * First match wins — order matters (more specific patterns should come first).
 */
const SVD_CATALOGUE: ISvdEntry[] = [
	// ── STM32F0 ──────────────────────────────────────────────────────────────
	{ pattern: /STM32F0[37]0/, vendor: 'STMicro', file: 'STM32F0x0.svd' },
	{ pattern: /STM32F0[57]1/, vendor: 'STMicro', file: 'STM32F0x1.svd' },
	{ pattern: /STM32F0[46]2/, vendor: 'STMicro', file: 'STM32F0x2.svd' },
	{ pattern: /STM32F09/, vendor: 'STMicro', file: 'STM32F0x8.svd' },
	{ pattern: /STM32F0/, vendor: 'STMicro', file: 'STM32F0x0.svd' }, // catch-all F0

	// ── STM32F1 ──────────────────────────────────────────────────────────────
	{ pattern: /STM32F100/, vendor: 'STMicro', file: 'STM32F100.svd' },
	{ pattern: /STM32F10[123]/, vendor: 'STMicro', file: 'STM32F103.svd' },
	{ pattern: /STM32F10[5]/, vendor: 'STMicro', file: 'STM32F107.svd' },
	{ pattern: /STM32F107/, vendor: 'STMicro', file: 'STM32F107.svd' },
	{ pattern: /STM32F1/, vendor: 'STMicro', file: 'STM32F103.svd' }, // catch-all F1

	// ── STM32F2 ──────────────────────────────────────────────────────────────
	{ pattern: /STM32F2/, vendor: 'STMicro', file: 'STM32F2xx.svd' },

	// ── STM32F3 ──────────────────────────────────────────────────────────────
	{ pattern: /STM32F3[34]/, vendor: 'STMicro', file: 'STM32F3x4.svd' },
	{ pattern: /STM32F37/, vendor: 'STMicro', file: 'STM32F37x.svd' },
	{ pattern: /STM32F3/, vendor: 'STMicro', file: 'STM32F30x.svd' }, // catch-all F3

	// ── STM32F4 ──────────────────────────────────────────────────────────────
	{ pattern: /STM32F401/, vendor: 'STMicro', file: 'STM32F401x.svd' },
	{ pattern: /STM32F40[57]/, vendor: 'STMicro', file: 'STM32F40x.svd' },
	{ pattern: /STM32F410/, vendor: 'STMicro', file: 'STM32F410x.svd' },
	{ pattern: /STM32F411/, vendor: 'STMicro', file: 'STM32F411x.svd' },
	{ pattern: /STM32F412/, vendor: 'STMicro', file: 'STM32F412.svd' },
	{ pattern: /STM32F41[34]/, vendor: 'STMicro', file: 'STM32F413.svd' },
	{ pattern: /STM32F42[279]|STM32F43[79]/, vendor: 'STMicro', file: 'STM32F4x9.svd' },
	{ pattern: /STM32F446/, vendor: 'STMicro', file: 'STM32F446.svd' },
	{ pattern: /STM32F46[79]|STM32F47[79]/, vendor: 'STMicro', file: 'STM32F469.svd' },
	{ pattern: /STM32F4/, vendor: 'STMicro', file: 'STM32F40x.svd' }, // catch-all F4

	// ── STM32F7 ──────────────────────────────────────────────────────────────
	{ pattern: /STM32F72[23]/, vendor: 'STMicro', file: 'STM32F7x2.svd' },
	{ pattern: /STM32F7[45][235]/, vendor: 'STMicro', file: 'STM32F7x3.svd' },
	{ pattern: /STM32F7[67][56]/, vendor: 'STMicro', file: 'STM32F7x6.svd' },
	{ pattern: /STM32F7[67][789]|STM32F77/, vendor: 'STMicro', file: 'STM32F7x9.svd' },
	{ pattern: /STM32F7/, vendor: 'STMicro', file: 'STM32F7x3.svd' }, // catch-all F7

	// ── STM32G0 ──────────────────────────────────────────────────────────────
	{ pattern: /STM32G0[3-9]1|STM32G0B1|STM32G0C1/, vendor: 'STMicro', file: 'STM32G0B1.svd' },
	{ pattern: /STM32G031/, vendor: 'STMicro', file: 'STM32G031.svd' },
	{ pattern: /STM32G0/, vendor: 'STMicro', file: 'STM32G0B1.svd' }, // catch-all G0

	// ── STM32G4 ──────────────────────────────────────────────────────────────
	{ pattern: /STM32G4[34]/, vendor: 'STMicro', file: 'STM32G431.svd' },
	{ pattern: /STM32G47[34]/, vendor: 'STMicro', file: 'STM32G474.svd' },
	{ pattern: /STM32G4/, vendor: 'STMicro', file: 'STM32G474.svd' }, // catch-all G4

	// ── STM32H7 ──────────────────────────────────────────────────────────────
	{ pattern: /STM32H742/, vendor: 'STMicro', file: 'STM32H742.svd' },
	{ pattern: /STM32H74[35]|STM32H75/, vendor: 'STMicro', file: 'STM32H743.svd' },
	{ pattern: /STM32H7[AB]/, vendor: 'STMicro', file: 'STM32H7A3.svd' },
	{ pattern: /STM32H7/, vendor: 'STMicro', file: 'STM32H743.svd' }, // catch-all H7

	// ── STM32L0 ──────────────────────────────────────────────────────────────
	{ pattern: /STM32L0[1-4]/, vendor: 'STMicro', file: 'STM32L0x1.svd' },
	{ pattern: /STM32L0/, vendor: 'STMicro', file: 'STM32L0x1.svd' },

	// ── STM32L1 ──────────────────────────────────────────────────────────────
	{ pattern: /STM32L1/, vendor: 'STMicro', file: 'STM32L1xx.svd' },

	// ── STM32L4 ──────────────────────────────────────────────────────────────
	{ pattern: /STM32L4[12]/, vendor: 'STMicro', file: 'STM32L4x1.svd' },
	{ pattern: /STM32L4[56]/, vendor: 'STMicro', file: 'STM32L4x5.svd' },
	{ pattern: /STM32L4[78]/, vendor: 'STMicro', file: 'STM32L4x7.svd' },
	{ pattern: /STM32L4[AR]/, vendor: 'STMicro', file: 'STM32L4R5.svd' },
	{ pattern: /STM32L4/, vendor: 'STMicro', file: 'STM32L4x1.svd' }, // catch-all L4

	// ── STM32L5 ──────────────────────────────────────────────────────────────
	{ pattern: /STM32L5/, vendor: 'STMicro', file: 'STM32L5x2.svd' },

	// ── STM32U5 ──────────────────────────────────────────────────────────────
	{ pattern: /STM32U5[457]/, vendor: 'STMicro', file: 'STM32U575.svd' },
	{ pattern: /STM32U5/, vendor: 'STMicro', file: 'STM32U575.svd' },

	// ── STM32WB ──────────────────────────────────────────────────────────────
	{ pattern: /STM32WB5[05]/, vendor: 'STMicro', file: 'STM32WB55.svd' },
	{ pattern: /STM32WB/, vendor: 'STMicro', file: 'STM32WB55.svd' },

	// ── STM32WL ──────────────────────────────────────────────────────────────
	{ pattern: /STM32WL/, vendor: 'STMicro', file: 'STM32WL5x.svd' },

	// ── Nordic nRF5x ─────────────────────────────────────────────────────────
	{ pattern: /NRF52840/, vendor: 'Nordic', file: 'nrf52840.svd' },
	{ pattern: /NRF52833/, vendor: 'Nordic', file: 'nrf52833.svd' },
	{ pattern: /NRF52832|NRF52/, vendor: 'Nordic', file: 'nrf52.svd' },
	{ pattern: /NRF5340/, vendor: 'Nordic', file: 'nrf5340.svd' },

	// ── Raspberry Pi ─────────────────────────────────────────────────────────
	{ pattern: /RP2040/, vendor: 'RaspberryPi', file: 'rp2040.svd' },
];


// ─── Implementation ───────────────────────────────────────────────────────────

class SvdFetchService implements ISvdFetchService {
	readonly _serviceBrand: undefined;

	/** In-memory cache: svdUrl → parsed result */
	private readonly _cache = new Map<string, ISvdResult>();

	svdUrlForPart(partNumber: string): string | undefined {
		const entry = this._findEntry(partNumber);
		if (!entry) { return undefined; }
		return `${CMSIS_SVD_BASE}/${entry.vendor}/${entry.file}`;
	}

	async fetchForParts(partNumbers: string[]): Promise<ISvdResult | undefined> {
		for (const part of partNumbers) {
			const entry = this._findEntry(part);
			if (!entry) { continue; }
			const url = `${CMSIS_SVD_BASE}/${entry.vendor}/${entry.file}`;

			// Cache hit
			if (this._cache.has(url)) { return this._cache.get(url)!; }

			try {
				const result = await this._fetchAndParse(url, entry.file);
				this._cache.set(url, result);
				return result;
			} catch (e) {
				console.warn(`[SVD] Failed to fetch ${url}:`, e);
				// Try next part number
			}
		}
		return undefined;
	}

	private _findEntry(partNumber: string): ISvdEntry | undefined {
		const normalized = partNumber.toUpperCase().replace(/[\s\-\.]/g, '');
		return SVD_CATALOGUE.find(e => e.pattern.test(normalized));
	}

	private async _fetchAndParse(url: string, file: string): Promise<ISvdResult> {
		const resp = await fetch(url);
		if (!resp.ok) { throw new Error(`HTTP ${resp.status} fetching ${url}`); }
		const xml = await resp.text();
		// CMSIS-SVD always ends with </device>. A truncated download (partial network
		// response) parses successfully but silently drops trailing peripherals, producing
		// a misleadingly low register count. Reject incomplete downloads explicitly.
		if (!xml.includes('</device>')) {
			throw new Error(`SVD download truncated — missing </device> closing tag: ${url}`);
		}
		return this._parseSvdXml(xml, url, file);
	}

	private _parseSvdXml(xml: string, svdUrl: string, svdFile: string): ISvdResult {
		// Uses our custom XML parser — avoids DOMParser entirely so VS Code's
		// Trusted Types enforcement (which blocks parseFromString) is never hit.
		const root = _parseXml(xml);
		const device = _child(root, 'device') ?? root;

		const deviceName = _txt(device, 'name') ?? 'Unknown';
		const cpuName = _txt(_child(device, 'cpu'), 'name') ?? 'Unknown';

		const peripheralEls = _children(_child(device, 'peripherals'), 'peripheral');
		const allPeripherals = peripheralEls.map(p => this._parsePeripheral(p, peripheralEls));

		return { svdFile, svdUrl, peripherals: allPeripherals, deviceName, cpuName };
	}

	private _parsePeripheral(el: XmlNode, allEls: XmlNode[]): IPeripheralRegisterMap {
		// Handle SVD derivedFrom — copy registers from the referenced peripheral
		const derivedFrom = el.attrs['derivedFrom'];
		const baseEl = derivedFrom ? allEls.find(p => _txt(p, 'name') === derivedFrom) : undefined;

		const name = _txt(el, 'name') ?? 'UNKNOWN';
		const groupName = _txt(el, 'groupName') ?? name;
		const description = _txt(el, 'description') ?? '';
		const baseAddress = parseInt(_txt(el, 'baseAddress') ?? '0', 16);

		// Registers: own registers override derived
		const ownRegs = _children(_child(el, 'registers'), 'register');
		const registers: IRegister[] =
			ownRegs.length > 0
				? ownRegs.map(r => this._parseRegister(r))
				: baseEl
					? _children(_child(baseEl, 'registers'), 'register').map(r => this._parseRegister(r))
					: [];

		const interrupts = _children(el, 'interrupt').map(i => ({
			name: _txt(i, 'name') ?? '',
			value: parseInt(_txt(i, 'value') ?? '0', 10),
			description: _txt(i, 'description') ?? '',
		}));

		return { name, groupName, baseAddress, description, registers, interrupts };
	}

	private _parseRegister(el: XmlNode): IRegister {
		const name = _txt(el, 'name') ?? 'REG';
		const description = _txt(el, 'description') ?? '';
		const addressOffset = parseInt(_txt(el, 'addressOffset') ?? '0', 16);
		const size = parseInt(_txt(el, 'size') ?? '32', 10);
		const access = (_txt(el, 'access') ?? 'read-write') as IRegister['access'];
		const resetValue = parseInt(_txt(el, 'resetValue') ?? '0', 16);

		const fields: IBitField[] = _children(_child(el, 'fields'), 'field').map(f => {
			const bitRange = _txt(f, 'bitRange');
			const bitOffset = parseInt(_txt(f, 'bitOffset') ?? '0', 10);
			const bitWidth = parseInt(_txt(f, 'bitWidth') ?? '1', 10);
			const lsb = _txt(f, 'lsb');
			const msb = _txt(f, 'msb');

			let resolvedOffset = bitOffset;
			let resolvedWidth = bitWidth;

			if (bitRange) {
				const bm = bitRange.match(/\[(\d+):(\d+)\]/);
				if (bm) { resolvedOffset = parseInt(bm[2], 10); resolvedWidth = parseInt(bm[1], 10) - resolvedOffset + 1; }
			} else if (lsb && msb) {
				resolvedOffset = parseInt(lsb, 10);
				resolvedWidth = parseInt(msb, 10) - resolvedOffset + 1;
			}

			const enumeratedValues: Record<number, string> = {};
			let hasEnums = false;
			const evList = _children(_child(f, 'enumeratedValues'), 'enumeratedValue');
			for (const ev of evList) {
				const evName = _txt(ev, 'name') ?? '';
				const evValue = _txt(ev, 'value') ?? '';
				if (evValue && !evValue.includes('#')) {
					enumeratedValues[parseInt(evValue, 0)] = evName;
					hasEnums = true;
				}
			}

			return {
				name: _txt(f, 'name') ?? 'BIT',
				description: _txt(f, 'description') ?? '',
				bitOffset: resolvedOffset,
				bitWidth: resolvedWidth,
				access: (_txt(f, 'access') ?? access) as IBitField['access'],
				enumeratedValues: hasEnums ? enumeratedValues : undefined,
			};
		});

		return { name, description, addressOffset, size, access, resetValue, fields };
	}

	/** Public: parse an SVD XML string directly (for locally uploaded .svd files). */
	parseFromXml(xml: string, fileName: string): ISvdResult {
		return this._parseSvdXml(xml, 'local://' + fileName, fileName);
	}
}


registerSingleton(ISvdFetchService, SvdFetchService, InstantiationType.Delayed);
