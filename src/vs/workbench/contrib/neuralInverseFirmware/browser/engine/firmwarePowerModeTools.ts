/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Firmware Power Mode Tools
 *
 * Bridges firmware services into the Power Mode terminal agent.
 * These tools are registered with Power Mode's tool system so the firmware
 * agent can:
 *   - Build and flash firmware with structured output
 *   - Monitor serial port and retrieve output
 *   - Start GDB debug sessions and send commands
 *   - Generate peripheral initialization code from register maps
 *   - Query platform skills for setup guidance
 *
 * This is the execution layer — the firmware system prompt tells the agent
 * WHEN and WHY to use these tools; this module implements HOW.
 */

import { IFirmwareSessionService } from '../firmwareSessionService.js';
import { IBuildSystemService } from './build/buildSystemService.js';
import { ISerialMonitorService } from './serial/serialMonitorService.js';
import { IFirmwareDebugService, GDBServerTool } from './debug/debugService.js';
import { getPlatformSkill, getAllPlatformSkills, IPlatformSkill } from './skills/platformSkills.js';
import { IRegisterValue } from './debug/debugService.js';
import { IDatasheetIntelligenceService } from './datasheet/datasheetIntelligenceService.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';


// ─── Service Interface ────────────────────────────────────────────────────────

export const IFirmwarePowerModeToolService = createDecorator<IFirmwarePowerModeToolService>('firmwarePowerModeToolService');

export interface IFirmwarePowerModeToolService {
	readonly _serviceBrand: undefined;

	/**
	 * Get all firmware Power Mode tool definitions for registration.
	 */
	getToolDefinitions(): IFirmwarePMTool[];
}

/** A tool definition for Power Mode registration. */
export interface IFirmwarePMTool {
	name: string;
	description: string;
	params: Record<string, { type: string; description: string; required?: boolean }>;
	execute: (args: Record<string, string>) => Promise<string>;
}


// ─── Implementation ───────────────────────────────────────────────────────────

class FirmwarePowerModeToolService extends Disposable implements IFirmwarePowerModeToolService {
	readonly _serviceBrand: undefined;

	constructor(
		@IFirmwareSessionService        private readonly _session: IFirmwareSessionService,
		@IBuildSystemService            private readonly _build: IBuildSystemService,
		@ISerialMonitorService          private readonly _serial: ISerialMonitorService,
		@IFirmwareDebugService          private readonly _debug: IFirmwareDebugService,
		@IDatasheetIntelligenceService  private readonly _datasheetService: IDatasheetIntelligenceService,
	) {
		super();
	}

	getToolDefinitions(): IFirmwarePMTool[] {
		return [
			this._buildTool(),
			this._flashTool(),
			this._serialMonitorTool(),
			this._serialSendTool(),
			this._binarySizeTool(),
			this._gdbConnectTool(),
			this._gdbCommandTool(),
			this._gdbReadRegsTool(),
			this._gdbReadMemTool(),
			this._gdbBreakpointTool(),
			this._initSequenceTool(),
			this._platformInfoTool(),
			this._sessionInfoTool(),
			this._scanProjectTool(),
			// ── Hardware KB ──
			this._uploadDatasheetTool(),
			this._queryDatasheetTool(),
			// ── SVD Register Tools ──
			this._listPeripheralsTool(),
			this._queryRegisterTool(),
		];
	}


	// ─── Build & Flash ────────────────────────────────────────────────

	private _buildTool(): IFirmwarePMTool {
		return {
			name: 'fw_build_project',
			description: 'Build the firmware project. Auto-detects build system (PlatformIO, CMake, ESP-IDF, Zephyr, Make, Cargo, Arduino). Returns build result with errors/warnings.',
			params: {
				target: { type: 'string', description: 'Build target/environment (optional, e.g. "debug", "release", board name)' },
			},
			execute: async (args) => {
				const s = this._session.session;
				if (!s.isActive) { return 'No active firmware session. Open a firmware project first.'; }

				const projectType = s.projectInfo?.projectType ?? 'generic';
				const projectRoot = s.projectUri ?? s.projectInfo?.projectRoot ?? '.';

				try {
					const result = await this._build.build(projectRoot, projectType, args.target);
					this._session.setLastBuildResult(result);

					const lines = [
						result.success ? '✅ BUILD SUCCEEDED' : '❌ BUILD FAILED',
						`Duration: ${result.durationMs}ms`,
						`Errors: ${result.errors.length}  |  Warnings: ${result.warnings.length}`,
					];

					if (result.errors.length > 0) {
						lines.push('', '--- Errors ---');
						for (const e of result.errors.slice(0, 10)) {
							lines.push(`  ${e.file}:${e.line}:${e.column ?? 0}: ${e.message}`);
						}
						if (result.errors.length > 10) {
							lines.push(`  ... and ${result.errors.length - 10} more errors`);
						}
					}

					if (result.warnings.length > 0) {
						lines.push('', '--- Warnings ---');
						for (const w of result.warnings.slice(0, 5)) {
							lines.push(`  ${w.file}:${w.line}:${w.column ?? 0}: ${w.message}`);
						}
					}

					return lines.join('\n');
				} catch (err) {
					return `Build failed with exception: ${err}`;
				}
			},
		};
	}

	private _flashTool(): IFirmwarePMTool {
		return {
			name: 'fw_flash_device',
			description: 'Flash firmware to the target MCU. Auto-detects flash tool. Build first if not already built.',
			params: {
				tool: { type: 'string', description: 'Flash tool override (openocd, esptool, stm32-programmer-cli, nrfjprog, jlink, etc.)' },
			},
			execute: async (args) => {
				const s = this._session.session;
				if (!s.isActive) { return 'No active firmware session. Open a firmware project first.'; }

				// Check if last build succeeded
				if (s.lastBuildResult && !s.lastBuildResult.success) {
					return '❌ Cannot flash — last build failed. Fix build errors first.';
				}

				const projectType = s.projectInfo?.projectType ?? 'generic';
				const projectRoot = s.projectUri ?? s.projectInfo?.projectRoot ?? '.';
				const flashConfig = args.tool ? { tool: args.tool as any } : undefined;

				try {
					const result = await this._build.flash(projectRoot, projectType, flashConfig);

					if (result.success) {
						return `✅ FLASH SUCCEEDED\nTool: ${result.tool}\nDuration: ${result.durationMs}ms\n${result.verified ? 'Verification: PASSED' : ''}\nDevice is running new firmware. Check serial output for expected behavior.`;
					} else {
						return `❌ FLASH FAILED\nTool: ${result.tool}\nMessage: ${result.message}`;
					}
				} catch (err) {
					return `Flash failed: ${err}`;
				}
			},
		};
	}


	// ─── Serial Monitor ───────────────────────────────────────────────

	private _serialMonitorTool(): IFirmwarePMTool {
		return {
			name: 'fw_serial_read',
			description: 'Read recent serial output from the connected serial port. Returns last N lines received from the device.',
			params: {
				lines: { type: 'string', description: 'Number of lines to return (default: 20)' },
				connect: { type: 'string', description: 'If "true", connect to the last-used port first' },
			},
			execute: async (args) => {
				const lineCount = parseInt(args.lines) || 20;

				// Auto-connect if requested and we have a saved config
				if (args.connect === 'true' && !this._serial.connectionState.isConnected) {
					const lastConfig = this._session.session.lastSerialConfig;
					if (lastConfig) {
						try {
							await this._serial.connect(lastConfig);
						} catch (err) {
							return `Failed to connect to ${lastConfig.port}: ${err}`;
						}
					} else {
						return 'No serial port configured. Use fw_serial_connect to set up serial.';
					}
				}

				if (!this._serial.connectionState.isConnected) {
					return 'Serial not connected. Set connect="true" to auto-connect, or configure serial first.';
				}

				const buffer = this._serial.rxBuffer;
				const recent = buffer.slice(-lineCount);

				if (recent.length === 0) {
					return `Serial connected to ${this._serial.connectionState.port} @ ${this._serial.connectionState.baudRate}. No data received yet.`;
				}

				const lines = recent.map((l: { timestamp: number; text: string }) => {
					const ts = new Date(l.timestamp).toISOString().slice(11, 23);
					return `[${ts}] ${l.text}`;
				});

				return `Serial output (${recent.length} lines from ${this._serial.connectionState.port} @ ${this._serial.connectionState.baudRate}):\n${lines.join('\n')}`;
			},
		};
	}

	private _serialSendTool(): IFirmwarePMTool {
		return {
			name: 'fw_serial_write',
			description: 'Send data to the serial port. Use to interact with the running firmware.',
			params: {
				data: { type: 'string', description: 'Data to send', required: true },
				no_newline: { type: 'string', description: 'If "true", don\'t append \\r\\n' },
			},
			execute: async (args) => {
				if (!args.data) { return 'Error: data parameter is required.'; }

				if (!this._serial.connectionState.isConnected) {
					return 'Serial not connected. Connect first.';
				}

				const appendNewline = args.no_newline !== 'true';
				await this._serial.send(args.data, appendNewline);
				return `Sent: "${args.data}"${appendNewline ? ' (with \\r\\n)' : ''}`;
			},
		};
	}


	// ─── Binary Analysis ──────────────────────────────────────────────

	private _binarySizeTool(): IFirmwarePMTool {
		return {
			name: 'fw_binary_analysis',
			description: 'Analyze compiled firmware binary size (Flash/RAM usage, section breakdown). Shows how much of the MCU\'s memory is used.',
			params: {
				elf_path: { type: 'string', description: 'Path to ELF binary (auto-detected if not specified)' },
			},
			execute: async (args) => {
				const s = this._session.session;
				if (!s.isActive || !s.mcuConfig) { return 'No active firmware session with MCU config.'; }

				const elfPath = args.elf_path ?? 'build/*.elf';
				const analysis = await this._build.analyzeBinarySize(
					elfPath,
					s.mcuConfig.flashSize,
					s.mcuConfig.ramSize,
				);

				const flashBar = _progressBar(analysis.flashPercent);
				const ramBar = _progressBar(analysis.ramPercent);

				return [
					`Binary Size Analysis: ${elfPath}`,
					``,
					`Flash: ${flashBar} ${analysis.flashPercent.toFixed(1)}% (${_fmt(analysis.flashUsage)} / ${_fmt(s.mcuConfig.flashSize)})`,
					`RAM:   ${ramBar} ${analysis.ramPercent.toFixed(1)}% (${_fmt(analysis.ramUsage)} / ${_fmt(s.mcuConfig.ramSize)})`,
					``,
					`Sections:`,
					`  .text  ${_fmt(analysis.textSize).padStart(8)}  (code)`,
					`  .data  ${_fmt(analysis.dataSize).padStart(8)}  (initialized data)`,
					`  .bss   ${_fmt(analysis.bssSize).padStart(8)}  (uninitialized data)`,
					``,
					analysis.flashPercent > 90 ? '⚠ Flash usage above 90% — consider optimizing code size' : '',
					analysis.ramPercent > 80 ? '⚠ RAM usage above 80% — monitor stack consumption' : '',
				].filter(Boolean).join('\n');
			},
		};
	}


	// ─── GDB Debug ────────────────────────────────────────────────────

	private _gdbConnectTool(): IFirmwarePMTool {
		return {
			name: 'fw_debug_start',
			description: 'Start a GDB debug session. Launches GDB server and connects client. The firmware is halted at reset.',
			params: {
				tool: { type: 'string', description: 'GDB server tool: openocd, jlink-gdbserver, pyocd, st-util, qemu (auto-detected if not specified)' },
				elf_path: { type: 'string', description: 'Path to ELF binary being debugged' },
			},
			execute: async (args) => {
				const s = this._session.session;
				if (!s.isActive || !s.mcuConfig) { return 'No active firmware session with MCU config.'; }

				// Auto-detect GDB server tool from platform
				const tool = (args.tool as GDBServerTool) ?? this._autoDetectGDBTool(s.platformId);
				const elfPath = args.elf_path ?? 'build/*.elf';

				try {
					await this._debug.startGDBServer(tool, s.mcuConfig.variant);
					await this._debug.connectGDB(elfPath);

					return [
						`✅ Debug session started`,
						`GDB server: ${tool} on port 3333`,
						`Target: ${s.mcuConfig.variant}`,
						`ELF: ${elfPath}`,
						`Target state: HALTED (at reset vector)`,
						``,
						`Available debug commands:`,
						`  fw_debug_cmd command="c"        — Continue execution`,
						`  fw_debug_cmd command="s"        — Step one line`,
						`  fw_debug_cmd command="n"        — Step over`,
						`  fw_debug_regs                   — Read CPU registers`,
						`  fw_debug_mem address="0x20000000" length="64"  — Read memory`,
						`  fw_debug_break location="main"  — Set breakpoint`,
					].join('\n');
				} catch (err) {
					return `Debug session failed to start: ${err}`;
				}
			},
		};
	}

	private _gdbCommandTool(): IFirmwarePMTool {
		return {
			name: 'fw_debug_cmd',
			description: 'Send a GDB command and return the response. Common commands: c (continue), s (step), n (next), bt (backtrace), info registers.',
			params: {
				command: { type: 'string', description: 'GDB command to execute', required: true },
			},
			execute: async (args) => {
				if (!args.command) { return 'Error: command parameter required.'; }
				if (!this._debug.state.clientConnected) { return 'No active debug session. Use fw_debug_start first.'; }

				const response = await this._debug.sendCommand(args.command);
				return response.output;
			},
		};
	}

	private _gdbReadRegsTool(): IFirmwarePMTool {
		return {
			name: 'fw_debug_regs',
			description: 'Read CPU register values from the debugger.',
			params: {
				names: { type: 'string', description: 'Comma-separated register names (e.g. "r0,r1,sp,pc"). All if omitted.' },
			},
			execute: async (args) => {
				if (!this._debug.state.clientConnected) { return 'No active debug session.'; }

				const names = args.names ? args.names.split(',').map(s => s.trim()) : undefined;
				const regs = await this._debug.readRegisters(names);

				const lines = regs.map((r: IRegisterValue) => `  ${r.name.padEnd(6)} = ${r.hexValue}  (${r.value})`);
				return `CPU Registers:\n${lines.join('\n')}`;
			},
		};
	}

	private _gdbReadMemTool(): IFirmwarePMTool {
		return {
			name: 'fw_debug_mem',
			description: 'Read memory at a given address. Useful for inspecting peripheral registers or RAM contents.',
			params: {
				address: { type: 'string', description: 'Memory address (hex, e.g. "0x40021000")', required: true },
				length: { type: 'string', description: 'Number of bytes to read (default: 32)' },
			},
			execute: async (args) => {
				if (!this._debug.state.clientConnected) { return 'No active debug session.'; }

				const address = parseInt(args.address, 16) || parseInt(args.address);
				const length = parseInt(args.length) || 32;

				if (isNaN(address)) { return 'Error: invalid address.'; }

				const dump = await this._debug.readMemory(address, length);
				const addrHex = `0x${dump.startAddress.toString(16).toUpperCase().padStart(8, '0')}`;
				return `Memory at ${addrHex} (${length} bytes):\n${dump.hexString}`;
			},
		};
	}

	private _gdbBreakpointTool(): IFirmwarePMTool {
		return {
			name: 'fw_debug_break',
			description: 'Set a breakpoint at a source location or memory address.',
			params: {
				location: { type: 'string', description: 'Breakpoint location: function name (e.g. "main"), file:line (e.g. "main.c:42"), or address (e.g. "0x08001234")', required: true },
			},
			execute: async (args) => {
				if (!this._debug.state.clientConnected) { return 'No active debug session.'; }
				if (!args.location) { return 'Error: location parameter required.'; }

				// Detect if it's an address
				const loc = args.location.startsWith('0x')
					? parseInt(args.location, 16)
					: args.location;

				const bp = await this._debug.setBreakpoint(loc);
				return `Breakpoint ${bp.id} set at ${bp.location}`;
			},
		};
	}


	// ─── Platform Knowledge ───────────────────────────────────────────

	private _initSequenceTool(): IFirmwarePMTool {
		return {
			name: 'fw_init_sequence',
			description: 'Get a peripheral initialization code template for the active platform. Returns register-level C code.',
			params: {
				peripheral: { type: 'string', description: 'Peripheral name (e.g. "USART", "SPI", "I2C", "GPIO", "ADC", "DMA", "TIM_PWM")', required: true },
			},
			execute: async (args) => {
				if (!args.peripheral) { return 'Error: peripheral parameter required.'; }

				const platformId = this._session.session.platformId;
				if (!platformId) { return 'No platform detected. Set MCU first.'; }

				const skill = getPlatformSkill(platformId);
				if (!skill) { return `No skill pack for platform: ${platformId}`; }

				// Find the init sequence (case-insensitive match)
				const key = Object.keys(skill.initSequences).find(
					k => k.toLowerCase() === args.peripheral.toLowerCase()
				);

				if (!key) {
					const available = Object.keys(skill.initSequences).join(', ');
					return `No init sequence for "${args.peripheral}" on ${skill.name}.\nAvailable: ${available}`;
				}

				return `// ${skill.name} — ${key} initialization\n// Platform: ${skill.manufacturer}\n\n${skill.initSequences[key]}`;
			},
		};
	}

	private _platformInfoTool(): IFirmwarePMTool {
		return {
			name: 'fw_platform_info',
			description: 'Get platform-specific knowledge: clock tree, interrupts, DMA, pitfalls, debug setup, low-power modes.',
			params: {
				topic: { type: 'string', description: 'Topic: clock, interrupts, dma, pitfalls, debug, startup, lowpower, all (default: all)' },
			},
			execute: async (args) => {
				const platformId = this._session.session.platformId;
				if (!platformId) {
					const all = getAllPlatformSkills();
					return `No platform detected. Available skill packs: ${all.map((s: IPlatformSkill) => s.id).join(', ')}`;
				}

				const skill = getPlatformSkill(platformId);
				if (!skill) { return `No skill pack for platform: ${platformId}`; }

				const topic = (args.topic ?? 'all').toLowerCase();
				const sections: string[] = [`# ${skill.name} (${skill.manufacturer})`];

				if (topic === 'all' || topic === 'clock') {
					sections.push('\n## Clock Tree\n' + skill.clockTreeNotes);
				}
				if (topic === 'all' || topic === 'interrupts') {
					sections.push('\n## Interrupts\n' + skill.interruptNotes);
				}
				if (topic === 'all' || topic === 'dma') {
					sections.push('\n## DMA\n' + skill.dmaNotes);
				}
				if (topic === 'all' || topic === 'pitfalls') {
					sections.push('\n## Common Pitfalls\n' + skill.pitfalls.map((p: string) => `• ${p}`).join('\n'));
				}
				if (topic === 'all' || topic === 'debug') {
					sections.push('\n## Debug Configuration\n' +
						`Probe: ${skill.debugConfig.probe}\n` +
						`OpenOCD: ${skill.debugConfig.openocdConfig.join(' ')}\n` +
						`Flash: ${skill.debugConfig.flashCommand.join(' ')}`);
				}
				if (topic === 'all' || topic === 'startup') {
					sections.push('\n## Boot Sequence\n' + skill.startupNotes);
				}
				if (topic === 'all' || topic === 'lowpower') {
					sections.push('\n## Low Power\n' + skill.lowPowerNotes);
				}

				return sections.join('\n');
			},
		};
	}


	// ─── Session Management ───────────────────────────────────────────

	private _sessionInfoTool(): IFirmwarePMTool {
		return {
			name: 'fw_session_info',
			description: 'Get complete firmware session status: MCU, project, serial, build, debug state.',
			params: {},
			execute: async () => {
				const s = this._session.session;
				if (!s.isActive) {
					return 'No active firmware session. Open a firmware project or use fw_scan_project.';
				}

				const lines = ['=== Firmware Session ==='];

				// MCU
				if (s.mcuConfig) {
					lines.push(`MCU: ${s.mcuConfig.family} ${s.mcuConfig.variant} (${s.mcuConfig.manufacturer})`);
					lines.push(`Core: ${s.mcuConfig.core}  |  Clock: ${s.mcuConfig.clockMHz}MHz  |  FPU: ${s.mcuConfig.fpu}`);
					lines.push(`Flash: ${_fmt(s.mcuConfig.flashSize)}  |  RAM: ${_fmt(s.mcuConfig.ramSize)}`);
				}

				// Project
				if (s.projectInfo) {
					lines.push(`Project: ${s.projectInfo.projectType}  |  Root: ${s.projectInfo.projectRoot}`);
				}

				// Platform
				if (s.platformId) {
					lines.push(`Platform: ${s.platformId}`);
				}

				// Board
				if (s.boardName) {
					lines.push(`Board: ${s.boardName}`);
				}

				// RTOS
				if (s.rtos) {
					lines.push(`RTOS: ${s.rtos}`);
				}

				// Register maps
				lines.push(`Register maps: ${s.registerMaps.length} peripherals loaded`);
				lines.push(`Errata: ${s.errata.length} entries`);
				lines.push(`Datasheets: ${s.datasheets.length} loaded`);

				// Serial
				const sc = this._serial.connectionState;
				if (sc.isConnected) {
					lines.push(`Serial: ✅ Connected to ${sc.port} @ ${sc.baudRate} (${sc.bytesReceived}B rx, ${sc.bytesTransmitted}B tx)`);
				} else if (s.lastSerialConfig) {
					lines.push(`Serial: ⚪ Disconnected (last: ${s.lastSerialConfig.port} @ ${s.lastSerialConfig.baudRate})`);
				} else {
					lines.push(`Serial: ⚪ Not configured`);
				}

				// Build
				if (s.lastBuildResult) {
					const b = s.lastBuildResult;
					lines.push(`Last build: ${b.success ? '✅' : '❌'} ${b.errors.length}E ${b.warnings.length}W (${b.durationMs}ms)`);
				}

				// Debug
				const ds = this._debug.state;
				if (ds.clientConnected) {
					lines.push(`Debug: ✅ GDB connected via ${ds.serverTool} — target ${ds.targetState}`);
				}

				// Compliance
				if (s.complianceFrameworks.length > 0) {
					lines.push(`Compliance: ${s.complianceFrameworks.join(', ')}`);
				}

				// Session timing
				if (s.sessionStartedAt) {
					const uptime = Date.now() - s.sessionStartedAt;
					const mins = Math.floor(uptime / 60000);
					lines.push(`Session uptime: ${mins}m`);
				}

				return lines.join('\n');
			},
		};
	}

	private _scanProjectTool(): IFirmwarePMTool {
		return {
			name: 'fw_scan_workspace',
			description: 'Scan the workspace for firmware project indicators and auto-configure the session.',
			params: {},
			execute: async () => {
				const s = this._session.session;
				if (s.isActive && s.projectInfo) {
					return `Session already active with ${s.projectInfo.projectType} project. End session first if you want to rescan.`;
				}
				return 'Use the project detector service to scan. This triggers auto-detection via the contribution module.';
			},
		};
	}


	// ─── Private helpers ──────────────────────────────────────────────

	private _autoDetectGDBTool(platformId?: string): GDBServerTool {
		switch (platformId) {
			case 'stm32': return 'openocd';
			case 'nrf': return 'jlink-gdbserver';
			case 'esp32': return 'openocd';
			case 'rp2040': return 'openocd';
			default: return 'openocd';
		}
	}


	// ─── Hardware KB Tools ────────────────────────────────────────────────

	/**
	 * fw_upload_datasheet — ingest a PDF into the Hardware KB.
	 *
	 * Checks the KB cache first (hash-deduped): if this exact PDF was already
	 * processed, returns the stored result instantly with zero LLM calls.
	 * Otherwise runs the full pipeline (heuristic classify → batched LLM extract
	 * → save to .inverse/hardware-kb/) and adds results to the active session.
	 */
	private _uploadDatasheetTool(): IFirmwarePMTool {
		return {
			name: 'fw_upload_datasheet',
			description: 'Ingest a PDF datasheet into the Hardware KB. ' +
				'Extracts register maps, timing constraints, and silicon errata using BYOLLM. ' +
				'Results are cached in .inverse/hardware-kb/ so re-processing the same PDF is instant. ' +
				'Call this when the user provides a datasheet path or after listing datasheets in Firmware.inverse.',
			params: {
				filePath: {
					type: 'string',
					description: 'Absolute or workspace-relative path to the PDF datasheet file.',
					required: true,
				},
			},
			execute: async (args) => {
				const s = this._session.session;
				if (!s.isActive || !s.mcuConfig) {
					return 'No active firmware session. Configure an MCU first.';
				}

				const filePath = args['filePath'];
				if (!filePath) { return 'filePath is required.'; }

				const mcuFamily = s.mcuConfig.family;
				const lines: string[] = [
					`📄 Processing datasheet: ${filePath}`,
					`MCU family: ${mcuFamily}`,
					'',
				];

				try {
					const result = await this._datasheetService.extractFromPDF(filePath, mcuFamily);

					// Add to active session
					this._session.addDatasheet(
						result.info,
						result.registerMaps,
						result.timingConstraints,
						result.errata,
					);

					lines.push(`✅ Extraction complete (${result.extractionTimeMs}ms)`);
					lines.push(`  Registers:  ${result.registerMaps.reduce((n, m) => n + m.registers.length, 0)} across ${result.registerMaps.length} peripherals`);
					lines.push(`  Timing:     ${result.timingConstraints.length} constraints`);
					lines.push(`  Errata:     ${result.errata.length} entries`);
					lines.push(`  Pages:      ${result.pages.length} (${result.info.partNumbers.join(', ') || 'no part numbers detected'})`);
					lines.push('');
					lines.push('Hardware KB updated. Use fw_query_datasheet to search the extracted data.');

					if (result.errata.length > 0) {
						lines.push('');
						lines.push(`⚠ Silicon errata detected (${result.errata.length}):`);
						for (const e of result.errata.slice(0, 3)) {
							lines.push(`  • [${e.severity.toUpperCase()}] ${e.id}: ${e.title}`);
							if (e.workaround) { lines.push(`    Workaround: ${e.workaround.slice(0, 80)}`); }
						}
						if (result.errata.length > 3) { lines.push(`  … ${result.errata.length - 3} more`); }
					}
				} catch (err) {
					lines.push(`❌ Failed: ${err}`);
				}

				return lines.join('\n');
			},
		};
	}

	/**
	 * fw_query_datasheet — natural language search over the Hardware KB.
	 *
	 * Searches register maps, timing constraints, and errata loaded in the
	 * session. Returns relevant register definitions, bit fields, and citations
	 * so the agent can generate accurate, datasheet-backed firmware code.
	 */
	private _queryDatasheetTool(): IFirmwarePMTool {
		return {
			name: 'fw_query_datasheet',
			description: 'Search the Hardware KB for register definitions, timing constraints, or errata. ' +
				'Use this before generating register-level firmware code to get exact address offsets, ' +
				'bit field names, reset values, and any relevant silicon errata. ' +
				'Examples: "USART1 baud rate register", "SPI clock timing", "DMA errata".',
			params: {
				query: {
					type: 'string',
					description: 'Natural language query, e.g. "USART CR1 register", "I2C timing constraints", "DMA2 errata".',
					required: true,
				},
				peripheral: {
					type: 'string',
					description: 'Optional peripheral name to scope the search (e.g. "USART1", "SPI2").',
				},
			},
			execute: async (args) => {
				const s = this._session.session;
				if (!s.isActive) { return 'No active firmware session.'; }
				if (s.datasheets.length === 0 && s.registerMaps.length === 0) {
					return 'No datasheets loaded. Use fw_upload_datasheet first.';
				}

				const query = (args['query'] ?? '').toLowerCase();
				const peripheralFilter = args['peripheral']?.toUpperCase();
				const lines: string[] = [`🔍 Hardware KB query: "${args['query']}"`, ''];

				// Search register maps
				const matchedMaps = s.registerMaps.filter(m =>
					(!peripheralFilter || m.name.startsWith(peripheralFilter) || m.groupName === peripheralFilter) &&
					(query.includes(m.name.toLowerCase()) || query.includes(m.groupName.toLowerCase()) ||
					m.registers.some(r => query.includes(r.name.toLowerCase()) || query.includes(r.description.toLowerCase().slice(0, 30))))
				);

				if (matchedMaps.length > 0) {
					for (const map of matchedMaps.slice(0, 3)) {
						lines.push(`## ${map.name} — base 0x${map.baseAddress.toString(16).toUpperCase()}`);
						lines.push(map.description);

						const relevantRegs = map.registers.filter(r =>
							query.includes(r.name.toLowerCase()) ||
							r.description.toLowerCase().includes(query.slice(0, 20))
						).slice(0, 5);

						const regsToShow = relevantRegs.length > 0 ? relevantRegs : map.registers.slice(0, 5);
						for (const reg of regsToShow) {
							lines.push(`  ${reg.name} [+0x${reg.addressOffset.toString(16).toUpperCase().padStart(4,'0')}] ${reg.access} reset=0x${reg.resetValue.toString(16).toUpperCase()}`);
							lines.push(`    ${reg.description}`);
							for (const f of reg.fields.slice(0, 6)) {
								lines.push(`    [${f.bitOffset + f.bitWidth - 1}:${f.bitOffset}] ${f.name} — ${f.description}`);
							}
						}
						lines.push('');
					}
				}

				// Search timing constraints
				const matchedTiming = s.timingConstraints.filter(t =>
					(!peripheralFilter || t.peripheral.startsWith(peripheralFilter)) &&
					(query.includes(t.peripheral.toLowerCase()) || query.includes(t.name.toLowerCase()) ||
					 query.includes('timing') || query.includes('clock'))
				).slice(0, 8);

				if (matchedTiming.length > 0) {
					lines.push('## Timing Constraints');
					for (const t of matchedTiming) {
						const vals = [
							t.minValue !== undefined ? `min=${t.minValue}` : null,
							t.typValue !== undefined ? `typ=${t.typValue}` : null,
							t.maxValue !== undefined ? `max=${t.maxValue}` : null,
						].filter(Boolean).join('  ');
						lines.push(`  ${t.peripheral}.${t.name}: ${vals} ${t.unit}${t.conditions ? `  (${t.conditions})` : ''}`);
					}
					lines.push('');
				}

				// Search errata
				const matchedErrata = s.errata.filter(e =>
					(!peripheralFilter || e.affectedPeripheral.startsWith(peripheralFilter)) &&
					(query.includes('errata') || query.includes(e.affectedPeripheral.toLowerCase()) ||
					 e.title.toLowerCase().includes(query.slice(0, 20)))
				).slice(0, 5);

				if (matchedErrata.length > 0) {
					lines.push('## Silicon Errata');
					for (const e of matchedErrata) {
						lines.push(`  ⚠ [${e.severity.toUpperCase()}] ${e.id}: ${e.title}`);
						if (e.workaround) { lines.push(`    Workaround: ${e.workaround}`); }
					}
					lines.push('');
				}

				if (matchedMaps.length === 0 && matchedTiming.length === 0 && matchedErrata.length === 0) {
					lines.push('No matches found in Hardware KB.');
					lines.push(`Loaded: ${s.datasheets.map(d => d.title).join(', ') || 'none'}`);
					lines.push(`Peripherals: ${s.registerMaps.map(m => m.name).slice(0, 10).join(', ') || 'none'}`);
				}

				return lines.join('\n');
			},
		};
	}
	private _listPeripheralsTool(): IFirmwarePMTool {
		return {
			name: 'fw_list_peripherals',
			description: 'List all available peripherals on the MCU from the loaded SVD datasource.',
			params: {},
			execute: async () => {
				const s = this._session.session;
				if (!s.isActive) return 'No active firmware session.';
				if (!s.registerMaps || s.registerMaps.length === 0) return 'No SVD/register map data loaded. Try opening an SVD file if one is available.';

				const lines = [`MCU Peripherals (Total: ${s.registerMaps.length}):`];
				for (const p of s.registerMaps) {
					lines.push(`  - ${p.name.padEnd(10)}(Base: 0x${p.baseAddress.toString(16).padStart(8, '0')}) — ${p.registers.length} registers`);
				}
				
				// Truncate to avoid blowing up context window if massive
				const out = lines.join('\n');
				return out.length > 50000 ? out.substring(0, 50000) + '... (truncated)' : out;
			}
		};
	}

	private _queryRegisterTool(): IFirmwarePMTool {
		return {
			name: 'fw_query_register',
			description: 'Query detailed SVD register structure for a given peripheral. Provides offsets, bitfields, access types, and enumerations.',
			params: {
				peripheral: { type: 'string', description: 'Name of the peripheral (e.g., "ADC1", "USART2")' },
				registerOrField: { type: 'string', description: '(Optional) Specific register or bitfield to narrow the search (e.g., "CR1")' }
			},
			execute: async (args) => {
				const s = this._session.session;
				if (!s.isActive) return 'No active firmware session.';
				if (!s.registerMaps || s.registerMaps.length === 0) return 'No register map data loaded.';
				
				const periphName = args.peripheral?.toUpperCase();
				if (!periphName) { return 'Error: peripheral argument is required.'; }

				// Find best-matching peripheral
				const p = s.registerMaps.find(m => m.name.toUpperCase() === periphName) 
						|| s.registerMaps.find(m => m.name.toUpperCase().includes(periphName));
						
				if (!p) {
					return `Peripheral "${periphName}" not found. Available: ${s.registerMaps.map(m => m.name).slice(0, 50).join(', ')}... Use fw_list_peripherals for full list.`;
				}

				const lines = [
					`Peripheral: ${p.name} (Base Address: 0x${p.baseAddress.toString(16).padStart(8, '0')})`,
					`Description: ${p.description || '(no description)'}`,
				];

				let registers = p.registers;
				const filter = args.registerOrField?.toUpperCase();
				if (filter) {
					// Either an exact register match, or a register that contains a matching field
					registers = p.registers.filter(r => 
						r.name.toUpperCase() === filter ||
						r.name.toUpperCase().includes(filter) ||
						r.fields.some(f => f.name.toUpperCase() === filter || f.name.toUpperCase().includes(filter))
					);
				}

				if (registers.length === 0) {
					return lines.join('\n') + `\nNo registers/fields containing "${filter}" found in ${p.name}.`;
				}
				
				lines.push(`\nRegisters (${registers.length} matched):`);
				for (const r of registers) {
					lines.push(`\n[0x${r.addressOffset.toString(16).padStart(4, '0')}] ${r.name} (${r.size}-bit) - Access: ${r.access || 'RW'} - Reset: 0x${r.resetValue ? r.resetValue.toString(16) : '0'}`);
					if (r.description) lines.push(`  Description: ${r.description}`);
					
					if (r.fields && r.fields.length > 0) {
						// Sort fields MSB to LSB for intuitive reading
						const sortedFields = [...r.fields].sort((a, b) => b.bitOffset - a.bitOffset);
						lines.push(`  Bitfields:`);
						for (const f of sortedFields) {
							const bitRange = f.bitWidth > 1 
								? `[${f.bitOffset + f.bitWidth - 1}:${f.bitOffset}]`
								: `[${f.bitOffset}]`;
							lines.push(`    ${bitRange.padEnd(8)} ${f.name.padEnd(12)} (${f.access || 'RW'}) - ${f.description || ''}`);
							
							if (f.enumeratedValues && Object.keys(f.enumeratedValues).length > 0) {
								for (const [val, desc] of Object.entries(f.enumeratedValues)) {
									lines.push(`      Value ${val}: ${desc}`);
								}
							}
						}
					} else {
						lines.push(`  (No named bitfields extracted / register is treated as whole)`);
					}
				}

				const out = lines.join('\n');
				return out.length > 50000 ? out.substring(0, 50000) + '\n... (truncated to save token space. query narrower scope)' : out;
			}
		};
	}
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

function _fmt(bytes: number): string {
	if (bytes >= 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(0)}MB`; }
	if (bytes >= 1024) { return `${(bytes / 1024).toFixed(0)}KB`; }
	return `${bytes}B`;
}

function _progressBar(percent: number): string {
	const filled = Math.round(percent / 5);
	const empty = 20 - filled;
	return `[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, empty))}]`;
}


registerSingleton(IFirmwarePowerModeToolService, FirmwarePowerModeToolService, InstantiationType.Delayed);
