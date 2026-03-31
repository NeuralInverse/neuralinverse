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
		if (!check || check.detect !== 'reserved-bit-write') return [];

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
}
