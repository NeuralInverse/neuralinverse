/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ITextModel } from '../../../../../../editor/common/model.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IGRCRule, ICheckResult, toDisplaySeverity } from '../types/grcTypes.js';
import { ISvdCCheck } from '../framework/frameworkSchema.js';
import { IRuleAnalyzer } from '../services/grcEngineService.js';
import { INanoAgentContext } from '../../nanoAgents/projectAnalyzerService.js';
import { IFirmwareSessionService } from '../../../../neuralInverseFirmware/browser/firmwareSessionService.js';
import { IPeripheralRegisterMap, IRegister } from '../../../../neuralInverseFirmware/common/firmwareTypes.js';

/**
 * # SVD Register Write Analyzer
 *
 * Scans C and C++ source files for direct register assignments (e.g., `ADC1->CR1 = 0xFFFFFFFF`)
 * and cross-references them against SVD register models in the active firmware session.
 * 
 * If a write touches bits that the SVD marks as "reserved" or undocumented, it emits a violation.
 */
export class SvdRegisterWriteAnalyzer implements IRuleAnalyzer {
	readonly supportedTypes = ['svd-c'];

	constructor(
		private readonly firmwareSession: IFirmwareSessionService
	) { }

	public evaluate(rule: IGRCRule, model: ITextModel, fileUri: URI, timestamp: number, context?: INanoAgentContext): ICheckResult[] {
		// Only run on firmware codebase languages (C / C++ and headers)
		const lang = model.getLanguageId().toLowerCase();
		const path = fileUri.path.toLowerCase();
		if (!['c', 'cpp'].includes(lang) && !path.endsWith('.c') && !path.endsWith('.cpp') && !path.endsWith('.h') && !path.endsWith('.hpp')) {
			return [];
		}
		
		const lines = model.getLinesContent();
		return this._evaluateContentLines(rule, lines, fileUri, timestamp);
	}

	public evaluateContent(rule: IGRCRule, content: string, fileUri: URI, languageId: string, timestamp: number): ICheckResult[] {
		const lang = languageId.toLowerCase();
		const path = fileUri.path.toLowerCase();
		if (!['c', 'cpp'].includes(lang) && !path.endsWith('.c') && !path.endsWith('.cpp') && !path.endsWith('.h') && !path.endsWith('.hpp')) {
			return [];
		}

		const lines = content.split('\n');
		return this._evaluateContentLines(rule, lines, fileUri, timestamp);
	}

	private _evaluateContentLines(rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number): ICheckResult[] {
		const check = rule.check as ISvdCCheck | undefined;
		if (!check) return [];

		if (check.detect === 'missing-clock-enable') {
			return this._checkMissingClockEnable(rule, lines, fileUri, timestamp);
		}
		if (check.detect === 'missing-pin-mux') {
			return this._checkMissingPinMux(rule, lines, fileUri, timestamp);
		}
		if (check.detect !== 'reserved-bit-write') return [];

		const session = this.firmwareSession.session;
		if (!session.isActive || !session.registerMaps || session.registerMaps.length === 0) {
			// No SVD data to check against
			return [];
		}

		const results: ICheckResult[] = [];

		// Matches common peripheral access in embedded C: `ADC1->CR1 = 0xABCD;`
		// Group 1: Peripheral (e.g., ADC1)
		// Group 2: Register (e.g., CR1)
		// Group 3: Operator (=, |=)
		// Group 4: Assigned Value
		const regex = /([A-Za-z0-9_]+)\s*->\s*([A-Za-z0-9_]+)\s*(\|=|=)\s*([A-Za-z0-9_bxX]+)\s*;/g;

		for (let i = 0; i < lines.length; i++) {
			let line = lines[i];
			
			// Quick exclusion of comments (simplistic for Phase 1)
			if (line.trim().startsWith('//')) continue;
			const inlineCommentIndex = line.indexOf('//');
			if (inlineCommentIndex !== -1) {
				line = line.substring(0, inlineCommentIndex);
			}

			regex.lastIndex = 0;
			let match;
			while ((match = regex.exec(line)) !== null) {
				const peripheralName = match[1].toUpperCase();
				const registerName = match[2].toUpperCase();
				const op = match[3];
				const rawValue = match[4].trim();

				// Try to parse the value
				const parsedValue = this._parseLiteral(rawValue);
				if (parsedValue === null) continue; // Not a raw literal (probably a macro/variable), safer to skip false positives

				// Only check assignments that definitively set bits
				if (op !== '=' && op !== '|=') continue;

				// Find the peripheral in the SVD
				const peripheral = session.registerMaps.find((m: IPeripheralRegisterMap) => m.name.toUpperCase() === peripheralName);
				if (!peripheral) continue;

				// Find the register in the peripheral
				const register = peripheral.registers.find((r: IRegister) => r.name.toUpperCase() === registerName);
				if (!register) continue;

				// Compute the reserved mask for this register
				const reservedMask = this._computeReservedMask(register);
				
				// Does the write touch ANY reserved bits?
				// Using BigInt because bitwise ops in TS are signed 32-bit natively
				const writtenBits = BigInt(parsedValue);
				const rMask = BigInt(reservedMask);

				if ((writtenBits & rMask) !== 0n) {
					// Violation found: Writing to reserved bits
					results.push({
						ruleId: rule.id,
						domain: rule.domain,
						severity: toDisplaySeverity(rule.severity),
						message: `[${rule.id}] SVD violation: Writing to reserved bits in ${peripheralName}->${registerName}. Value 0x${parsedValue.toString(16).toUpperCase()} sets bits that are undocumented or reserved.`,
						fileUri: fileUri,
						line: i + 1,
						column: match.index + 1,
						endLine: i + 1,
						endColumn: match.index + match[0].length + 1,
						codeSnippet: match[0],
						timestamp: timestamp,
						frameworkId: rule.frameworkId,
						blockingBehavior: rule.blockingBehavior,
					});
				}
			}
		}

		return results;
	}

	/** Parses hex, bin, and decimal literals */
	private _parseLiteral(value: string): number | null {
		value = value.toLowerCase().replace(/u|l/g, ''); // strip UL suffix
		if (value.startsWith('0x')) {
			const parsed = parseInt(value, 16);
			return isNaN(parsed) ? null : parsed;
		}
		if (value.startsWith('0b')) {
			const parsed = parseInt(value.substring(2), 2);
			return isNaN(parsed) ? null : parsed;
		}
		if (/^[0-9]+$/.test(value)) {
			const parsed = parseInt(value, 10);
			return isNaN(parsed) ? null : parsed;
		}
		return null;
	}

	/** Returns a number where every 1-bit is RESERVED (not mapped by any field) */
	private _computeReservedMask(register: any): number | bigint {
		const sizeBytes = register.size || 32;
		// e.g. 0xFFFFFFFF for 32-bit
		let mask = (1n << BigInt(sizeBytes)) - 1n;

		for (const field of register.fields) {
			const fieldMask = ((1n << BigInt(field.bitWidth)) - 1n) << BigInt(field.bitOffset);
			// Unset the known fields from the mask
			mask &= ~fieldMask;
		}

		return mask;
	}

	/**
	 * Detect peripheral register writes without the corresponding clock-enable write.
	 *
	 * Pattern: any `PERIPHx->REG = value` that does NOT appear after a clock enable
	 * write matching `RCC->?ENR |= ...` or `RCC->?ENR = ...` in the same file
	 * (within the same function body where possible).
	 *
	 * Requires an active firmware session with register maps. Peripheral names
	 * are derived from SVD data so the check is device-specific.
	 */
	private _checkMissingClockEnable(rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number): ICheckResult[] {
		const session = this.firmwareSession.session;
		if (!session.isActive || !session.registerMaps || session.registerMaps.length === 0) {
			return [];
		}

		const results: ICheckResult[] = [];

		// Known peripheral name sets derived from the SVD register maps
		const svdPeripherals = new Set<string>(
			session.registerMaps.map((m: IPeripheralRegisterMap) => m.name.toUpperCase())
		);

		// Regex to match peripheral register writes: PERIPHx->REG = ...
		const PERIPH_WRITE_RE = /([A-Za-z][A-Za-z0-9_]*)\s*->\s*[A-Za-z0-9_]+\s*[\|]?=/g;

		// Clock-enable patterns for common MCU families (STM32, NXP, etc.)
		// RCC->AHBxENR, RCC->APBxENR, CMU->HFPERCLKEN, SIM->SCGC, RCM->SRS
		const CLOCK_ENABLE_RE = /(?:RCC|CMU|SIM|RCM|SYSCTL)\s*->\s*\w*ENR\w*\s*[\|]?=|__HAL_RCC_\w+_CLK_ENABLE|LL_AHB\d_GRP\d_EnableClock|CLOCK_EnableClock/i;

		// Collect all lines where clock is enabled
		const clockEnabledPeripherals = new Set<string>();
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (line.trim().startsWith('//')) continue;

			if (CLOCK_ENABLE_RE.test(line)) {
				// Extract peripheral name from RCC enable patterns like __HAL_RCC_GPIOA_CLK_ENABLE
				const halMatch = line.match(/__HAL_RCC_(\w+?)_CLK_ENABLE/);
				if (halMatch) {
					clockEnabledPeripherals.add(halMatch[1].toUpperCase());
				}
				// For direct register writes like RCC->AHB2ENR |= RCC_AHB2ENR_GPIOAEN
				// extract the peripheral hints from the bit field names
				const enrMatch = line.match(/(\w+EN)\b/g);
				if (enrMatch) {
					for (const en of enrMatch) {
						// Strip EN suffix to get peripheral name hint
						clockEnabledPeripherals.add(en.replace(/EN$/, '').toUpperCase());
					}
				}
			}
		}

		// Check each peripheral write: if no clock enable found for that peripheral, flag it
		for (let i = 0; i < lines.length; i++) {
			let line = lines[i];
			if (line.trim().startsWith('//')) continue;
			const inlineIdx = line.indexOf('//');
			if (inlineIdx !== -1) { line = line.substring(0, inlineIdx); }

			PERIPH_WRITE_RE.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = PERIPH_WRITE_RE.exec(line)) !== null) {
				const peripheralName = match[1].toUpperCase();

				// Only check peripherals that exist in the SVD
				if (!svdPeripherals.has(peripheralName)) continue;

				// Skip RCC itself (it's the clock controller)
				if (peripheralName === 'RCC' || peripheralName === 'CMU' || peripheralName === 'SIM') continue;

				// Check if clock was enabled for this peripheral
				// Try both full name and prefix (GPIO_A vs GPIOA)
				const clockEnabled =
					clockEnabledPeripherals.has(peripheralName) ||
					Array.from(clockEnabledPeripherals).some(en =>
						peripheralName.startsWith(en) || en.startsWith(peripheralName.replace(/\d+$/, ''))
					);

				if (!clockEnabled) {
					results.push({
						ruleId: rule.id,
						domain: rule.domain,
						severity: toDisplaySeverity(rule.severity),
						message: `[${rule.id}] SVD clock-enable gap: ${peripheralName} register written before its clock is enabled via RCC/clock controller \u2014 peripheral may be in reset state`,
						fileUri,
						line: i + 1,
						column: match.index + 1,
						endLine: i + 1,
						endColumn: match.index + match[0].length + 1,
						codeSnippet: match[0],
						timestamp,
						frameworkId: rule.frameworkId,
						blockingBehavior: rule.blockingBehavior,
					});
				}
			}
		}

		return results;
	}

	/**
	 * Detect peripheral enable writes where the corresponding GPIO pin mux
	 * (alternate function) has not been configured.
	 *
	 * Pattern: peripheral usage (e.g. USART1->CR1 |= USART_CR1_UE) without a
	 * preceding GPIO_InitTypeDef / HAL_GPIO_Init / LL_GPIO_SetAFPin call
	 * that sets the GPIO alternate function for that peripheral.
	 */
	private _checkMissingPinMux(rule: IGRCRule, lines: string[], fileUri: URI, timestamp: number): ICheckResult[] {
		const session = this.firmwareSession.session;
		if (!session.isActive || !session.registerMaps || session.registerMaps.length === 0) {
			return [];
		}

		const results: ICheckResult[] = [];

		// Peripherals that require GPIO pin mux (alternate function config)
		// These are communication/analog peripherals \u2014 not timers or core peripherals
		const PIN_MUX_REQUIRED = /^(USART\d*|UART\d*|SPI\d*|I2C\d*|CAN\d*|ADC\d*|DAC\d*|SAI\d*|SDIO|USB|ETH|QUADSPI|LTDC|FMC|FSMC)\d*$/i;

		// GPIO pin mux configuration patterns
		const PIN_MUX_RE = /(?:HAL_GPIO_Init|GPIO_InitTypeDef|LL_GPIO_SetAFPin|GPIO_PinAFConfig|gpio_set_function|alt_func_enable|PINMUX_Config|pinmux_select|GPIO_AF_|AlternateFunction)/i;

		// Check if any pin mux configuration exists in the file
		const hasPinMuxConfig = lines.some(l => PIN_MUX_RE.test(l));

		// If file has pin mux config, we trust it's been done correctly (avoid false positives)
		// Only flag if there's absolutely no GPIO alt function setup in the file
		if (hasPinMuxConfig) {
			return [];
		}

		// Check for peripheral enable writes for mux-required peripherals
		const svdPeripherals = new Set<string>(
			session.registerMaps.map((m: IPeripheralRegisterMap) => m.name.toUpperCase())
		);

		const PERIPH_ENABLE_RE = /([A-Za-z][A-Za-z0-9_]*)\s*->\s*CR1\s*[\|]?=.*(?:EN\b|ENABLE\b)/gi;

		for (let i = 0; i < lines.length; i++) {
			let line = lines[i];
			if (line.trim().startsWith('//')) continue;
			const inlineIdx = line.indexOf('//');
			if (inlineIdx !== -1) { line = line.substring(0, inlineIdx); }

			PERIPH_ENABLE_RE.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = PERIPH_ENABLE_RE.exec(line)) !== null) {
				const peripheralName = match[1].toUpperCase();

				if (!svdPeripherals.has(peripheralName)) continue;
				if (!PIN_MUX_REQUIRED.test(peripheralName)) continue;

				results.push({
					ruleId: rule.id,
					domain: rule.domain,
					severity: toDisplaySeverity(rule.severity),
					message: `[${rule.id}] SVD pin-mux gap: ${peripheralName} enabled but no GPIO alternate function configuration (HAL_GPIO_Init / GPIO_PinAFConfig) found in this file \u2014 peripheral pins may not be mapped`,
					fileUri,
					line: i + 1,
					column: match.index + 1,
					endLine: i + 1,
					endColumn: match.index + match[0].length + 1,
					codeSnippet: match[0],
					timestamp,
					frameworkId: rule.frameworkId,
					blockingBehavior: rule.blockingBehavior,
				});
			}
		}

		return results;
	}
}
