/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * HardwareContextProvider
 *
 * Builds a firmware-aware context block for injection into the system prompt
 * of Void sidebar chat and Power Mode terminal.
 *
 * Pattern mirrors `_buildModernisationContext()` in convertToLLMMessageService.ts.
 * When a firmware session is active, this context tells the LLM:
 *   - Active MCU specs (family, core, clock, memory)
 *   - Loaded datasheet summaries
 *   - Register map references for the active peripheral
 *   - MISRA/compliance rules in effect
 *   - Available firmware-specific tools
 *   - Silicon errata warnings
 */

import { IFirmwareSessionService } from '../../firmwareSessionService.js';
import { IPeripheralRegisterMap } from '../../../common/firmwareTypes.js';
import { getPlatformSkill } from '../skills/platformSkills.js';


/**
 * Build a compact firmware context block for system prompt injection.
 * Returns undefined when no session is active — keeps prompt clean for normal coding tasks.
 */
export function buildFirmwareContext(sessionService: IFirmwareSessionService): string | undefined {
	const session = sessionService.session;
	if (!session.isActive || !session.mcuConfig) { return undefined; }

	const lines: string[] = [];

	// ── Header ──
	lines.push('## Active Firmware Session');
	const cfg = session.mcuConfig;
	lines.push(`MCU: ${cfg.family} ${cfg.variant}  |  Core: ${cfg.core}  |  Clock: ${cfg.clockMHz}MHz`);
	lines.push(`Manufacturer: ${cfg.manufacturer}  |  Flash: ${_formatBytes(cfg.flashSize)}  |  RAM: ${_formatBytes(cfg.ramSize)}`);
	lines.push(`FPU: ${cfg.fpu}  |  MPU: ${cfg.hasMPU ? 'yes' : 'no'}  |  DSP: ${cfg.hasDSP ? 'yes' : 'no'}`);
	if (session.boardName) { lines.push(`Board: ${session.boardName}`); }
	if (session.rtos) { lines.push(`RTOS: ${session.rtos}`); }
	if (session.buildSystem) { lines.push(`Build system: ${session.buildSystem}`); }

	// ── Compliance frameworks ──
	if (session.complianceFrameworks.length > 0) {
		lines.push(`Compliance: ${session.complianceFrameworks.join(', ')}`);
	}

	// ── Peripherals overview ──
	if (session.registerMaps.length > 0) {
		const peripheralNames = session.registerMaps.map(m => m.name);
		lines.push(`Peripherals loaded (${peripheralNames.length}): ${peripheralNames.slice(0, 20).join(', ')}${peripheralNames.length > 20 ? ' …' : ''}`);
	}

	// ── Active peripheral spotlight ──
	if (session.activePeripheral) {
		const map = sessionService.getPeripheralRegisterMap(session.activePeripheral);
		if (map) {
			lines.push('');
			lines.push(_buildPeripheralSpotlight(map));
		}

		// Errata warnings for active peripheral
		const errata = sessionService.getErrataForPeripheral(session.activePeripheral);
		if (errata.length > 0) {
			lines.push(`⚠ Silicon errata for ${session.activePeripheral}: ${errata.length} known issues`);
			for (const e of errata.slice(0, 3)) {
				lines.push(`  • ${e.id}: ${e.title} [${e.severity}]${e.workaround ? ' — workaround available' : ''}`);
			}
			if (errata.length > 3) {
				lines.push(`  … and ${errata.length - 3} more — use fw_get_errata for full list`);
			}
		}

		// Timing constraints for active peripheral
		const timing = sessionService.getTimingForPeripheral(session.activePeripheral);
		if (timing.length > 0) {
			lines.push(`Timing constraints for ${session.activePeripheral}: ${timing.length} entries`);
		}
	}

	// ── Datasheets loaded ──
	if (session.datasheets.length > 0) {
		lines.push(`Datasheets: ${session.datasheets.map(d => `${d.title} (${d.peripheralCount} peripherals)`).join(', ')}`);
	}

	// ── Memory map summary ──
	if (cfg.memoryMap.length > 0) {
		lines.push('Memory map:');
		for (const region of cfg.memoryMap) {
			lines.push(`  ${region.name}: 0x${region.baseAddress.toString(16).toUpperCase()} — ${_formatBytes(region.size)} [${region.access}]`);
		}
	}

	// ── Serial connection status ──
	if (session.lastSerialConfig) {
		const port = session.lastSerialConfig.port;
		const baud = session.lastSerialConfig.baudRate;
		lines.push(`Serial: ${port} @ ${baud} baud${session.serialWasConnected ? ' (was connected — reconnect available)' : ''}`);
	}

	// ── Last build result ──
	if (session.lastBuildResult) {
		const b = session.lastBuildResult;
		lines.push(`Last build: ${b.success ? '✅ SUCCESS' : '❌ FAILED'} (${b.errors.length} errors, ${b.warnings.length} warnings, ${b.durationMs}ms)`);
		if (!b.success && b.errors.length > 0) {
			lines.push(`  Top error: ${b.errors[0].file}:${b.errors[0].line}: ${b.errors[0].message}`);
		}
	}

	// ── Debug session state ──
	if (session.debugState?.isActive) {
		lines.push(`Debug: GDB active via ${session.debugState.gdbServer} on port ${session.debugState.gdbPort} — target: ${session.debugState.targetDevice}`);
	}

	// ── Platform skill highlights ──
	if (session.platformId) {
		const skill = getPlatformSkill(session.platformId);
		if (skill) {
			lines.push('');
			lines.push(`## Platform: ${skill.name} (${skill.manufacturer})`);
			// Show top pitfalls (the agent should know these)
			if (skill.pitfalls.length > 0) {
				lines.push('Key pitfalls to watch for:');
				for (const p of skill.pitfalls.slice(0, 4)) {
					lines.push(`  ⚠ ${p}`);
				}
			}
			// Debug probe info
			lines.push(`Debug probe: ${skill.debugConfig.probe}`);
		}
	}

	// ── Tool reference ──
	lines.push('');
	lines.push('## Firmware Tools Available');
	lines.push('  MCU info:     fw_get_mcu_info, fw_list_peripherals, fw_search_mcu');
	lines.push('  Registers:    fw_get_register_map, fw_get_peripheral_config, fw_get_bit_field_info, fw_get_clock_config');
	lines.push('  Datasheets:   fw_upload_datasheet, fw_query_datasheet, fw_get_datasheet_citations');
	lines.push('  Errata:       fw_get_errata, fw_check_silicon_bug, fw_get_timing_constraints');
	lines.push('  Build/Flash:  fw_build_project, fw_flash_device, fw_binary_analysis');
	lines.push('  Serial:       fw_serial_read, fw_serial_write');
	lines.push('  Debug:        fw_debug_start, fw_debug_cmd, fw_debug_regs, fw_debug_mem, fw_debug_break');
	lines.push('  Platform:     fw_init_sequence, fw_platform_info');
	lines.push('  Compliance:   fw_misra_check, fw_cert_c_check, fw_safety_audit');
	lines.push('  Session:      fw_session_info, fw_scan_workspace');

	// ── Coding guidelines ──
	lines.push('');
	lines.push('## Firmware Coding Guidelines');
	lines.push('When generating firmware code in this session:');
	lines.push('- Use volatile for all memory-mapped I/O register accesses');
	lines.push('- Use explicit bit manipulation (|=, &=~, shifts) for register configuration');
	lines.push('- Never use dynamic memory allocation (malloc/free) in ISRs or safety-critical paths');
	lines.push('- Ensure all loops have bounded iteration counts');
	lines.push('- Check and clear interrupt flags before re-enabling interrupts');
	lines.push('- Use the register names and addresses from the loaded SVD/datasheet');
	lines.push('- Cite datasheet section/page numbers when referencing peripheral behaviour');
	lines.push('- After writing code, offer to build→flash→monitor in sequence');
	if (session.complianceFrameworks.includes('misra-c-2012') || session.complianceFrameworks.includes('misra-c-2023')) {
		lines.push('- Follow MISRA C rules: no implicit type conversions, no pointer arithmetic on void*, no recursion');
	}
	if (session.complianceFrameworks.includes('cert-c')) {
		lines.push('- Follow CERT C: validate all inputs, check return values, prevent integer overflow');
	}

	return lines.join('\n');
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

function _formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(0)}MB`; }
	if (bytes >= 1024) { return `${(bytes / 1024).toFixed(0)}KB`; }
	return `${bytes}B`;
}

/**
 * Build a detailed spotlight block for the currently active peripheral.
 * Shows register names, addresses, and key bit fields.
 */
function _buildPeripheralSpotlight(map: IPeripheralRegisterMap): string {
	const lines: string[] = [
		`### Active Peripheral: ${map.name} (${map.groupName})`,
		`Base address: 0x${map.baseAddress.toString(16).toUpperCase()}`,
		`Description: ${map.description}`,
		`Registers (${map.registers.length}):`,
	];

	// Show up to 15 registers with their key fields
	for (const reg of map.registers.slice(0, 15)) {
		const offsetHex = `0x${reg.addressOffset.toString(16).toUpperCase().padStart(4, '0')}`;
		const fieldNames = reg.fields.map(f => f.name).join(', ');
		lines.push(`  ${reg.name} [${offsetHex}] ${reg.access} — ${reg.description.slice(0, 60)}${fieldNames ? ` | Fields: ${fieldNames}` : ''}`);
	}

	if (map.registers.length > 15) {
		lines.push(`  … and ${map.registers.length - 15} more — use fw_get_register_map("${map.name}") for full list`);
	}

	if (map.interrupts.length > 0) {
		lines.push(`Interrupts: ${map.interrupts.map(i => `${i.name}(${i.value})`).join(', ')}`);
	}

	return lines.join('\n');
}
