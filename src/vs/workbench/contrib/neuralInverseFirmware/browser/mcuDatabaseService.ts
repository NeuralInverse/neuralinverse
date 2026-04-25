/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * MCU Database Service
 *
 * Provides searchable access to the built-in MCU database.
 * Supports fuzzy matching by variant, family, board name, and keywords.
 * Converts database entries to IMCUConfig for session injection.
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IMCUConfig, IMCUDatabaseEntry } from '../common/firmwareTypes.js';
import { MCU_DATABASE, MCU_FAMILIES, MCU_MANUFACTURERS, MCU_DATABASE_COUNT } from '../common/mcuDatabase.js';


// \u2500\u2500\u2500 Service interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const IMCUDatabaseService = createDecorator<IMCUDatabaseService>('mcuDatabaseService');

export interface IMCUDatabaseService {
	readonly _serviceBrand: undefined;

	/** Total number of MCU variants in the database. */
	readonly count: number;

	/** All unique MCU family names. */
	readonly families: string[];

	/** All unique manufacturers. */
	readonly manufacturers: string[];

	/**
	 * Search the MCU database with fuzzy matching.
	 * Matches against variant, family, subfamily, manufacturer, board names, and keywords.
	 * @param query  Search string (e.g. "stm32f407", "nucleo", "teensy", "esp32s3")
	 * @param limit  Max results (default 10)
	 * @returns Matching entries sorted by relevance (best match first)
	 */
	search(query: string, limit?: number): IMCUDatabaseEntry[];

	/**
	 * Look up an exact MCU variant.
	 * @param variant  Full part number (e.g. "STM32F407VGT6")
	 * @returns The database entry, or undefined if not found
	 */
	lookupVariant(variant: string): IMCUDatabaseEntry | undefined;

	/**
	 * Get all entries for a specific MCU family.
	 * @param family  Family name (e.g. "STM32F4", "nRF52", "ESP32")
	 */
	getFamily(family: string): IMCUDatabaseEntry[];

	/**
	 * Get all entries for a specific manufacturer.
	 * @param manufacturer  Manufacturer name (e.g. "STMicroelectronics", "Nordic Semiconductor")
	 */
	getByManufacturer(manufacturer: string): IMCUDatabaseEntry[];

	/**
	 * Find MCU by board name.
	 * @param boardName  Board name (e.g. "NUCLEO-F446RE", "Pico", "Teensy 4.1")
	 */
	findByBoard(boardName: string): IMCUDatabaseEntry | undefined;

	/**
	 * Convert a database entry to an IMCUConfig for session injection.
	 */
	toMCUConfig(entry: IMCUDatabaseEntry): IMCUConfig;
}


// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

class MCUDatabaseService extends Disposable implements IMCUDatabaseService {
	readonly _serviceBrand: undefined;

	get count(): number { return MCU_DATABASE_COUNT; }
	get families(): string[] { return MCU_FAMILIES; }
	get manufacturers(): string[] { return MCU_MANUFACTURERS; }

	search(query: string, limit: number = 10): IMCUDatabaseEntry[] {
		if (!query || query.length < 2) return MCU_DATABASE.slice(0, limit);

		const q = query.toLowerCase().trim();
		const terms = q.split(/[\s,;_-]+/).filter(Boolean);

		// Score each entry
		const scored = MCU_DATABASE.map(entry => {
			let score = 0;

			// Exact variant match = highest score
			if (entry.variant.toLowerCase() === q) score += 1000;
			else if (entry.variant.toLowerCase().includes(q)) score += 500;

			// Family match
			if (entry.family.toLowerCase() === q) score += 400;
			else if (entry.family.toLowerCase().includes(q)) score += 200;

			// Subfamily match
			if (entry.subfamily.toLowerCase().includes(q)) score += 300;

			// Board match
			for (const board of entry.commonBoards) {
				if (board.toLowerCase() === q) { score += 450; break; }
				if (board.toLowerCase().includes(q)) { score += 250; break; }
			}

			// Keyword match \u2014 each matching term adds score
			for (const term of terms) {
				for (const keyword of entry.searchKeywords) {
					if (keyword.toLowerCase() === term) { score += 100; break; }
					if (keyword.toLowerCase().includes(term)) { score += 50; break; }
				}
			}

			// Manufacturer match
			if (entry.manufacturer.toLowerCase().includes(q)) score += 30;

			return { entry, score };
		});

		return scored
			.filter(s => s.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map(s => s.entry);
	}

	lookupVariant(variant: string): IMCUDatabaseEntry | undefined {
		const v = variant.toLowerCase();
		return MCU_DATABASE.find(e => e.variant.toLowerCase() === v);
	}

	getFamily(family: string): IMCUDatabaseEntry[] {
		const f = family.toLowerCase();
		return MCU_DATABASE.filter(e => e.family.toLowerCase() === f);
	}

	getByManufacturer(manufacturer: string): IMCUDatabaseEntry[] {
		const m = manufacturer.toLowerCase();
		return MCU_DATABASE.filter(e => e.manufacturer.toLowerCase().includes(m));
	}

	findByBoard(boardName: string): IMCUDatabaseEntry | undefined {
		const b = boardName.toLowerCase();
		return MCU_DATABASE.find(e =>
			e.commonBoards.some((board: string) => board.toLowerCase().includes(b))
		);
	}

	toMCUConfig(entry: IMCUDatabaseEntry): IMCUConfig {
		return {
			family: entry.family,
			variant: entry.variant,
			manufacturer: entry.manufacturer,
			core: entry.core,
			clockMHz: entry.clockMHz,
			flashSize: entry.flashSize,
			ramSize: entry.ramSize,
			memoryMap: entry.memoryMap,
			gpioCount: entry.gpioCount,
			peripherals: entry.peripherals,
			fpu: entry.fpu,
			hasMPU: entry.hasMPU,
			hasDSP: entry.hasDSP,
		};
	}
}


registerSingleton(IMCUDatabaseService, MCUDatabaseService, InstantiationType.Delayed);
