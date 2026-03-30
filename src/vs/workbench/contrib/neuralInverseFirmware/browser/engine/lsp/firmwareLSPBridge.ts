/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Firmware LSP Bridge
 *
 * Bridges the firmware session context with VS Code's Language Server Protocol
 * infrastructure to provide firmware-aware code intelligence:
 *
 *   - Register name completions with addresses and bit field docs
 *   - Hover info on hardware register accesses (shows bit field layout)
 *   - Inline diagnostics for common firmware mistakes
 *   - MISRA C rule checking on save
 *   - Peripheral-aware goto-definition (jump to SVD source)
 *
 * This service doesn't implement a full LSP server — instead it augments the
 * existing clangd/ccls/rust-analyzer with firmware-specific overlays.
 * The register knowledge comes from the session's loaded SVD/datasheet data.
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { IFirmwareSessionService } from '../../firmwareSessionService.js';
import {
	IPeripheralRegisterMap,
	IRegister,
	IBitField,
} from '../../../common/firmwareTypes.js';


// ─── Service interface ────────────────────────────────────────────────────────

export const IFirmwareLSPBridge = createDecorator<IFirmwareLSPBridge>('firmwareLSPBridge');

export interface IFirmwareLSPBridge {
	readonly _serviceBrand: undefined;

	/** Fires when firmware diagnostics change. */
	readonly onDiagnosticsChanged: Event<IFirmwareDiagnostic[]>;

	/**
	 * Get register completions for a given prefix.
	 * Used by inline completion provider to suggest register names,
	 * bit field names, and hardware constants.
	 *
	 * @param prefix  Current word being typed
	 * @returns Completion items with register metadata
	 */
	getRegisterCompletions(prefix: string): IRegisterCompletion[];

	/**
	 * Get hover information for a register or bit field name.
	 * Returns formatted markdown with address, reset value, bit layout, etc.
	 *
	 * @param word  The word under the cursor
	 * @returns Hover content or undefined if not a known register
	 */
	getRegisterHoverInfo(word: string): IRegisterHoverInfo | undefined;

	/**
	 * Analyze a C/C++ source file for firmware-specific issues.
	 * Checks for common embedded programming mistakes:
	 *   - Missing volatile on register accesses
	 *   - Incorrect bit manipulation patterns
	 *   - Non-atomic read-modify-write on shared registers
	 *   - Unbounded loops (potential MISRA violation)
	 *   - Stack-allocated VLAs in interrupt context
	 *
	 * @param fileContent  Full file content
	 * @param filePath     File path for diagnostic reporting
	 * @returns Array of firmware-specific diagnostics
	 */
	analyzeFirmwareCode(fileContent: string, filePath: string): IFirmwareDiagnostic[];

	/**
	 * Get all known register and peripheral symbols for the current session.
	 * Used by the document symbol provider.
	 */
	getHardwareSymbols(): IHardwareSymbol[];
}

/** A completion item for a register or bit field. */
export interface IRegisterCompletion {
	/** Label shown in the completion list */
	label: string;
	/** Detail line (peripheral, address) */
	detail: string;
	/** Full documentation markdown */
	documentation: string;
	/** Completion kind */
	kind: 'register' | 'bitfield' | 'peripheral' | 'constant';
	/** Sort order (lower = higher priority) */
	sortPriority: number;
	/** Insert text (may differ from label) */
	insertText: string;
}

/** Hover information for a register or bit field. */
export interface IRegisterHoverInfo {
	/** Formatted markdown content */
	markdown: string;
	/** Peripheral name */
	peripheral: string;
	/** Register name */
	register?: string;
	/** Bit field name */
	bitField?: string;
}

/** A firmware-specific diagnostic. */
export interface IFirmwareDiagnostic {
	/** File path */
	file: string;
	/** Line number (1-indexed) */
	line: number;
	/** Column (1-indexed) */
	column?: number;
	/** Severity */
	severity: 'error' | 'warning' | 'info' | 'hint';
	/** Diagnostic message */
	message: string;
	/** Rule ID (e.g. "FW001", "MISRA-8.4") */
	ruleId: string;
	/** Category */
	category: 'volatile' | 'bit-manipulation' | 'atomicity' | 'misra' | 'stack' | 'interrupt' | 'general';
	/** Quick fix suggestion */
	fix?: string;
}

/** A hardware symbol for document outline. */
export interface IHardwareSymbol {
	name: string;
	kind: 'peripheral' | 'register' | 'bitfield';
	detail: string;
	address: string;
}


// ─── Firmware analysis rules ─────────────────────────────────────────────────

interface IAnalysisRule {
	id: string;
	category: IFirmwareDiagnostic['category'];
	severity: IFirmwareDiagnostic['severity'];
	pattern: RegExp;
	message: (match: RegExpExecArray) => string;
	fix?: (match: RegExpExecArray) => string;
}

const FIRMWARE_ANALYSIS_RULES: IAnalysisRule[] = [
	// FW001: Register access without volatile
	{
		id: 'FW001',
		category: 'volatile',
		severity: 'warning',
		pattern: /\b(?:uint32_t|uint16_t|uint8_t)\s*\*\s*(\w+)\s*=\s*\((?:uint32_t|uint16_t|uint8_t)\s*\*\)\s*(0x[0-9A-Fa-f]+)/g,
		message: (m) => `Register pointer '${m[1]}' at ${m[2]} should use volatile qualifier. Memory-mapped I/O requires volatile to prevent compiler optimizations.`,
		fix: (m) => `volatile ${m[0]}`,
	},
	// FW002: Non-atomic read-modify-write on shared register
	{
		id: 'FW002',
		category: 'atomicity',
		severity: 'warning',
		pattern: /(\w+->(?:CR|SR|DR|CCR|CCER|DIER|IER|ISR)\w*)\s*\|=\s*/g,
		message: (m) => `Non-atomic read-modify-write on '${m[1]}'. Consider disabling interrupts around this operation if register is shared between ISR and main context.`,
		fix: () => `/* Wrap with __disable_irq() / __enable_irq() if register is shared with ISR */`,
	},
	// FW003: malloc/calloc in firmware code
	{
		id: 'FW003',
		category: 'misra',
		severity: 'warning',
		pattern: /\b(malloc|calloc|realloc|free)\s*\(/g,
		message: (m) => `Dynamic memory allocation '${m[1]}()' detected. Avoid in firmware — use static allocation or memory pools instead. [MISRA C:2012 Rule 21.3]`,
	},
	// FW004: Unbounded loop
	{
		id: 'FW004',
		category: 'misra',
		severity: 'info',
		pattern: /while\s*\(\s*1\s*\)|for\s*\(\s*;\s*;\s*\)/g,
		message: () => `Infinite loop detected. If this is the main loop, ensure it has proper WDT refresh. If waiting for hardware, add a timeout. [MISRA C:2012 Rule 14.4]`,
	},
	// FW005: Direct register address cast without volatile
	{
		id: 'FW005',
		category: 'volatile',
		severity: 'warning',
		pattern: /\*\s*\(\s*(?:uint32_t|uint16_t|uint8_t)\s*\*\s*\)\s*(0x[0-9A-Fa-f]{8})/g,
		message: (m) => `Direct memory access at ${m[1]} without volatile. Use: *(volatile uint32_t *)${m[1]}`,
		fix: (m) => `*(volatile uint32_t *)${m[1]}`,
	},
	// FW006: Recursive function
	{
		id: 'FW006',
		category: 'misra',
		severity: 'info',
		pattern: /(\w+)\s*\([^)]*\)\s*\{[^}]*\b\1\s*\(/gs,
		message: (m) => `Possible recursion in '${m[1]}()'. Recursion should be avoided in firmware — stack space is limited. [MISRA C:2012 Rule 17.2]`,
	},
	// FW007: Float in ISR
	{
		id: 'FW007',
		category: 'interrupt',
		severity: 'warning',
		pattern: /void\s+\w+_IRQHandler\s*\([^)]*\)\s*\{[^}]*(float|double)\b/gs,
		message: () => `Floating-point operations in interrupt handler. This causes FPU context save/restore overhead and may corrupt FPU state if lazy stacking is not configured.`,
	},
	// FW008: printf in firmware
	{
		id: 'FW008',
		category: 'general',
		severity: 'hint',
		pattern: /\b(printf|fprintf|sprintf)\s*\(/g,
		message: (m) => `'${m[1]}()' uses significant stack space and may not be available without retargeting. Consider using a lightweight logging alternative.`,
	},
	// FW009: Variable-length array
	{
		id: 'FW009',
		category: 'stack',
		severity: 'warning',
		pattern: /\b(?:int|uint\d+_t|char|uint8_t)\s+(\w+)\s*\[\s*(\w+)\s*\]/g,
		message: (m) => `Possible variable-length array '${m[1]}[${m[2]}]'. VLAs can cause stack overflow in embedded systems. Use fixed-size arrays or static allocation. [MISRA C:2012 Rule 18.8]`,
	},
	// FW010: Missing interrupt flag clear
	{
		id: 'FW010',
		category: 'interrupt',
		severity: 'info',
		pattern: /void\s+(\w+_IRQHandler)\s*\([^)]*\)\s*\{(?:(?!->SR|->ICR|->IFCR|__HAL_.*CLEAR|CLEAR_BIT|RESET_BIT).)*\}/gs,
		message: (m) => `Interrupt handler '${m[1]}' may not clear the interrupt flag. Failing to clear flags can cause infinite interrupt re-entry.`,
	},
];


// ─── Implementation ───────────────────────────────────────────────────────────

class FirmwareLSPBridge extends Disposable implements IFirmwareLSPBridge {
	readonly _serviceBrand: undefined;

	private readonly _onDiagnosticsChanged = this._register(new Emitter<IFirmwareDiagnostic[]>());
	readonly onDiagnosticsChanged = this._onDiagnosticsChanged.event;

	constructor(
		@IFirmwareSessionService private readonly _session: IFirmwareSessionService,
	) {
		super();
	}

	getRegisterCompletions(prefix: string): IRegisterCompletion[] {
		const session = this._session.session;
		if (!session.isActive) { return []; }

		const results: IRegisterCompletion[] = [];
		const q = prefix.toUpperCase();

		for (const map of session.registerMaps) {
			// Peripheral name completions
			if (map.name.toUpperCase().startsWith(q) || map.groupName.toUpperCase().startsWith(q)) {
				results.push({
					label: map.name,
					detail: `Peripheral @ 0x${map.baseAddress.toString(16).toUpperCase()}`,
					documentation: this._buildPeripheralDoc(map),
					kind: 'peripheral',
					sortPriority: 0,
					insertText: map.name,
				});
			}

			// Register completions
			for (const reg of map.registers) {
				const fullName = `${map.name}_${reg.name}`;
				const regName = reg.name;

				if (regName.toUpperCase().startsWith(q) || fullName.toUpperCase().startsWith(q)) {
					results.push({
						label: fullName,
						detail: `${map.name}+0x${reg.addressOffset.toString(16).toUpperCase()} ${reg.size}bit ${reg.access}`,
						documentation: this._buildRegisterDoc(map, reg),
						kind: 'register',
						sortPriority: 1,
						insertText: fullName,
					});
				}

				// Bit field completions (e.g. USART_CR1_UE)
				for (const field of reg.fields) {
					const fieldFull = `${map.name}_${reg.name}_${field.name}`;
					if (field.name.toUpperCase().startsWith(q) || fieldFull.toUpperCase().startsWith(q)) {
						results.push({
							label: fieldFull,
							detail: `[${field.bitOffset + field.bitWidth - 1}:${field.bitOffset}] ${field.access}`,
							documentation: this._buildFieldDoc(map, reg, field),
							kind: 'bitfield',
							sortPriority: 2,
							insertText: fieldFull,
						});

						// Bit position constant (e.g. USART_CR1_UE_Pos)
						results.push({
							label: `${fieldFull}_Pos`,
							detail: `= ${field.bitOffset}U`,
							documentation: `Bit position of ${field.name} in ${map.name}->${reg.name}`,
							kind: 'constant',
							sortPriority: 3,
							insertText: `${fieldFull}_Pos`,
						});

						// Bit mask constant (e.g. USART_CR1_UE_Msk)
						const mask = ((1 << field.bitWidth) - 1) << field.bitOffset;
						results.push({
							label: `${fieldFull}_Msk`,
							detail: `= 0x${mask.toString(16).toUpperCase()}U`,
							documentation: `Bit mask of ${field.name} in ${map.name}->${reg.name}`,
							kind: 'constant',
							sortPriority: 3,
							insertText: `${fieldFull}_Msk`,
						});
					}
				}
			}
		}

		// Sort by priority, then alphabetically
		results.sort((a, b) => a.sortPriority - b.sortPriority || a.label.localeCompare(b.label));
		return results.slice(0, 50); // Cap at 50 results
	}

	getRegisterHoverInfo(word: string): IRegisterHoverInfo | undefined {
		const session = this._session.session;
		if (!session.isActive) { return undefined; }

		const upper = word.toUpperCase();

		// Check for register pattern: PERIPHERAL_REGISTER (e.g. USART1_CR1)
		for (const map of session.registerMaps) {
			// Match peripheral name
			if (map.name.toUpperCase() === upper) {
				return {
					markdown: this._buildPeripheralDoc(map),
					peripheral: map.name,
				};
			}

			// Match PERIPHERAL_REGISTER
			for (const reg of map.registers) {
				const fullName = `${map.name}_${reg.name}`.toUpperCase();
				if (fullName === upper || reg.name.toUpperCase() === upper) {
					return {
						markdown: this._buildRegisterDoc(map, reg),
						peripheral: map.name,
						register: reg.name,
					};
				}

				// Match PERIPHERAL_REGISTER_FIELD
				for (const field of reg.fields) {
					const fieldFull = `${map.name}_${reg.name}_${field.name}`.toUpperCase();
					if (fieldFull === upper || `${fieldFull}_POS` === upper || `${fieldFull}_MSK` === upper) {
						return {
							markdown: this._buildFieldDoc(map, reg, field),
							peripheral: map.name,
							register: reg.name,
							bitField: field.name,
						};
					}
				}
			}
		}

		return undefined;
	}

	analyzeFirmwareCode(fileContent: string, filePath: string): IFirmwareDiagnostic[] {
		const diagnostics: IFirmwareDiagnostic[] = [];

		for (const rule of FIRMWARE_ANALYSIS_RULES) {
			// Reset the regex (important for global patterns)
			rule.pattern.lastIndex = 0;
			let match: RegExpExecArray | null;

			while ((match = rule.pattern.exec(fileContent)) !== null) {
				// Calculate line number from match index
				const beforeMatch = fileContent.substring(0, match.index);
				const line = beforeMatch.split('\n').length;
				const lastNewline = beforeMatch.lastIndexOf('\n');
				const column = match.index - lastNewline;

				diagnostics.push({
					file: filePath,
					line,
					column,
					severity: rule.severity,
					message: rule.message(match),
					ruleId: rule.id,
					category: rule.category,
					fix: rule.fix ? rule.fix(match) : undefined,
				});
			}
		}

		// Emit diagnostics changed
		if (diagnostics.length > 0) {
			this._onDiagnosticsChanged.fire(diagnostics);
		}

		return diagnostics;
	}

	getHardwareSymbols(): IHardwareSymbol[] {
		const session = this._session.session;
		if (!session.isActive) { return []; }

		const symbols: IHardwareSymbol[] = [];

		for (const map of session.registerMaps) {
			symbols.push({
				name: map.name,
				kind: 'peripheral',
				detail: `${map.groupName} — ${map.registers.length} registers`,
				address: `0x${map.baseAddress.toString(16).toUpperCase()}`,
			});

			for (const reg of map.registers) {
				symbols.push({
					name: `${map.name}.${reg.name}`,
					kind: 'register',
					detail: `${reg.size}bit ${reg.access} — ${reg.description.slice(0, 50)}`,
					address: `+0x${reg.addressOffset.toString(16).toUpperCase()}`,
				});
			}
		}

		return symbols;
	}

	// ─── Documentation builders ──────────────────────────────────────────

	private _buildPeripheralDoc(map: IPeripheralRegisterMap): string {
		const lines = [
			`### ${map.name} (${map.groupName})`,
			`**Base Address:** \`0x${map.baseAddress.toString(16).toUpperCase()}\``,
			``,
			map.description,
			``,
			`**Registers (${map.registers.length}):**`,
		];

		for (const reg of map.registers.slice(0, 15)) {
			const offset = `0x${reg.addressOffset.toString(16).toUpperCase().padStart(4, '0')}`;
			lines.push(`- \`${reg.name}\` [${offset}] — ${reg.description.slice(0, 60)}`);
		}
		if (map.registers.length > 15) {
			lines.push(`- ... and ${map.registers.length - 15} more`);
		}

		if (map.interrupts.length > 0) {
			lines.push('', '**Interrupts:**');
			for (const irq of map.interrupts) {
				lines.push(`- \`${irq.name}\` (IRQ ${irq.value}) — ${irq.description}`);
			}
		}

		return lines.join('\n');
	}

	private _buildRegisterDoc(map: IPeripheralRegisterMap, reg: IRegister): string {
		const absAddr = map.baseAddress + reg.addressOffset;
		const lines = [
			`### ${map.name}->${reg.name}`,
			`**Address:** \`0x${absAddr.toString(16).toUpperCase()}\` (${map.name} + 0x${reg.addressOffset.toString(16).toUpperCase()})`,
			`**Size:** ${reg.size} bits | **Access:** ${reg.access} | **Reset:** \`0x${reg.resetValue.toString(16).toUpperCase().padStart(reg.size / 4, '0')}\``,
			'',
			reg.description,
			'',
			'**Bit Fields:**',
			'| Bits | Name | Access | Description |',
			'|------|------|--------|-------------|',
		];

		const sorted = [...reg.fields].sort((a, b) => b.bitOffset - a.bitOffset);
		for (const f of sorted) {
			const msb = f.bitOffset + f.bitWidth - 1;
			const bits = f.bitWidth === 1 ? `${f.bitOffset}` : `${msb}:${f.bitOffset}`;
			lines.push(`| [${bits}] | ${f.name} | ${f.access} | ${f.description.slice(0, 40)} |`);
		}

		return lines.join('\n');
	}

	private _buildFieldDoc(map: IPeripheralRegisterMap, reg: IRegister, field: IBitField): string {
		const absAddr = map.baseAddress + reg.addressOffset;
		const msb = field.bitOffset + field.bitWidth - 1;
		const mask = ((1 << field.bitWidth) - 1) << field.bitOffset;

		const lines = [
			`### ${map.name}->${reg.name}.${field.name}`,
			`**Bits:** [${msb}:${field.bitOffset}] | **Width:** ${field.bitWidth} | **Access:** ${field.access}`,
			`**Position:** ${field.bitOffset} | **Mask:** \`0x${mask.toString(16).toUpperCase()}\``,
			`**Register:** \`0x${absAddr.toString(16).toUpperCase()}\``,
			'',
			field.description,
		];

		if (field.enumeratedValues) {
			lines.push('', '**Values:**');
			for (const [val, name] of Object.entries(field.enumeratedValues)) {
				lines.push(`- \`${val}\` = ${name}`);
			}
		}

		lines.push('', '**Usage:**');
		lines.push(`\`\`\`c`);
		lines.push(`// Set ${field.name}`);
		lines.push(`${map.name}->${reg.name} |= (value << ${map.name}_${reg.name}_${field.name}_Pos) & ${map.name}_${reg.name}_${field.name}_Msk;`);
		lines.push(`// Read ${field.name}`);
		lines.push(`uint32_t val = (${map.name}->${reg.name} & ${map.name}_${reg.name}_${field.name}_Msk) >> ${map.name}_${reg.name}_${field.name}_Pos;`);
		lines.push(`\`\`\``);

		return lines.join('\n');
	}
}


registerSingleton(IFirmwareLSPBridge, FirmwareLSPBridge, InstantiationType.Delayed);
