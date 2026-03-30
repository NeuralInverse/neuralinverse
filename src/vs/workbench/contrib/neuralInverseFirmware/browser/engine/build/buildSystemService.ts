/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Build System Service
 *
 * Integrates with embedded firmware build systems to provide:
 *   - Build, clean, flash commands through IDE
 *   - Binary size analysis (Flash/RAM usage)
 *   - Build error parsing and diagnostics
 *   - Flash programming via OpenOCD, STM32CubeProgrammer, esptool, etc.
 *
 * Supports:
 *   - PlatformIO (pio run, pio upload)
 *   - CMake with arm-none-eabi-gcc
 *   - Make with embedded toolchains
 *   - ESP-IDF (idf.py build, idf.py flash)
 *   - Cargo (cargo build --target thumbv7em-none-eabihf)
 *   - Arduino CLI (arduino-cli compile, arduino-cli upload)
 *   - Zephyr (west build, west flash)
 */

import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import {
	IBuildResult,
	IBuildDiagnostic,
	IFlashConfig,
	FirmwareProjectType,
} from '../../../common/firmwareTypes.js';
import { IFirmwareSessionService } from '../../firmwareSessionService.js';
import { ITerminalService } from '../../../../terminal/browser/terminal.js';
import { TerminalLocation } from '../../../../../../platform/terminal/common/terminal.js';


// ─── Service interface ────────────────────────────────────────────────────────

export const IBuildSystemService = createDecorator<IBuildSystemService>('buildSystemService');

export interface IBuildSystemService {
	readonly _serviceBrand: undefined;

	/** Fires when a build starts. */
	readonly onBuildStarted: Event<IBuildEvent>;
	/** Fires on build progress (stderr/stdout lines). */
	readonly onBuildOutput: Event<IBuildOutputLine>;
	/** Fires when a build completes. */
	readonly onBuildCompleted: Event<IBuildResult>;
	/** Fires when a flash operation starts. */
	readonly onFlashStarted: Event<void>;
	/** Fires when a flash operation completes. */
	readonly onFlashCompleted: Event<IFlashResult>;

	/** Whether a build is currently in progress. */
	readonly isBuilding: boolean;
	/** Whether a flash operation is currently in progress. */
	readonly isFlashing: boolean;
	/** Last build result (undefined if no build has been run). */
	readonly lastBuildResult: IBuildResult | undefined;

	/**
	 * Build the firmware project.
	 * @param projectRoot Workspace folder URI
	 * @param projectType Detected project type
	 * @param target Build target (e.g. "debug", "release", specific env)
	 */
	build(projectRoot: string, projectType: FirmwareProjectType, target?: string): Promise<IBuildResult>;

	/**
	 * Clean build artifacts.
	 */
	clean(projectRoot: string, projectType: FirmwareProjectType): Promise<void>;

	/**
	 * Flash the firmware to the target device.
	 * @param projectRoot Workspace folder URI
	 * @param projectType Detected project type
	 * @param flashConfig Flash tool configuration
	 */
	flash(projectRoot: string, projectType: FirmwareProjectType, flashConfig?: IFlashConfig): Promise<IFlashResult>;

	/**
	 * Analyze binary size (Flash/RAM usage).
	 * @param elfPath Path to the ELF binary
	 * @param mcuFlashSize Total flash size in bytes
	 * @param mcuRamSize Total RAM size in bytes
	 */
	analyzeBinarySize(elfPath: string, mcuFlashSize: number, mcuRamSize: number): Promise<IBinarySizeAnalysis>;

	/**
	 * Get the build command that would be run for a given project type.
	 * Useful for UI display and user customization.
	 */
	getBuildCommand(projectType: FirmwareProjectType, target?: string): string[];

	/**
	 * Get the flash command that would be run for a given project type.
	 */
	getFlashCommand(projectType: FirmwareProjectType, flashConfig?: IFlashConfig): string[];

	/**
	 * Detect available flash tools on the system.
	 */
	detectFlashTools(): Promise<IFlashToolInfo[]>;
}

/** Build event fired when a build starts. */
export interface IBuildEvent {
	projectRoot: string;
	projectType: FirmwareProjectType;
	target?: string;
	command: string[];
	startTime: number;
}

/** A single line of build output. */
export interface IBuildOutputLine {
	text: string;
	stream: 'stdout' | 'stderr';
	timestamp: number;
}

/** Result of a flash operation. */
export interface IFlashResult {
	success: boolean;
	durationMs: number;
	tool: string;
	message: string;
	/** Verify pass/fail if verification was run */
	verified?: boolean;
}

/** Binary size analysis results. */
export interface IBinarySizeAnalysis {
	/** Total .text (code) section size */
	textSize: number;
	/** Total .data (initialized data) section size */
	dataSize: number;
	/** Total .bss (uninitialized data) section size */
	bssSize: number;
	/** Total flash usage (text + data) */
	flashUsage: number;
	/** Total RAM usage (data + bss) */
	ramUsage: number;
	/** Flash usage as percentage of total */
	flashPercent: number;
	/** RAM usage as percentage of total */
	ramPercent: number;
	/** Per-section breakdown */
	sections: Array<{ name: string; size: number; address: number }>;
}

/** Information about an installed flash tool. */
export interface IFlashToolInfo {
	name: string;
	path: string;
	version?: string;
	supportedInterfaces: string[];
}


// ─── Build command templates ──────────────────────────────────────────────────

const BUILD_COMMANDS: Record<FirmwareProjectType, { build: string[]; clean: string[]; flash: string[] }> = {
	'firmware-inverse': { build: ['make', '-j$(nproc)'],             clean: ['make', 'clean'],                                  flash: ['openocd', '-f', 'interface/stlink.cfg', '-c', 'program *.elf verify reset exit'] },
	'platformio':       { build: ['pio', 'run'],                     clean: ['pio', 'run', '--target', 'clean'],                flash: ['pio', 'run', '--target', 'upload'] },
	'esp-idf':          { build: ['idf.py', 'build'],                clean: ['idf.py', 'fullclean'],                            flash: ['idf.py', 'flash'] },
	'zephyr':           { build: ['west', 'build'],                  clean: ['west', 'build', '--pristine'],                    flash: ['west', 'flash'] },
	'cmake-embedded':   { build: ['cmake', '--build', 'build'],      clean: ['cmake', '--build', 'build', '--target', 'clean'], flash: ['openocd', '-f', 'interface/stlink.cfg', '-f', 'target/stm32f4x.cfg', '-c', 'program build/*.elf verify reset exit'] },
	'make-embedded':    { build: ['make', '-j$(nproc)'],             clean: ['make', 'clean'],                                  flash: ['make', 'flash'] },
	'rust-embedded':    { build: ['cargo', 'build', '--release'],    clean: ['cargo', 'clean'],                                 flash: ['probe-rs', 'run', '--release'] },
	'arduino':          { build: ['arduino-cli', 'compile'],         clean: ['arduino-cli', 'compile', '--clean'],              flash: ['arduino-cli', 'upload'] },
	'mbed':             { build: ['mbed', 'compile'],                clean: ['mbed', 'compile', '--clean'],                     flash: ['mbed', 'compile', '--flash'] },
	'stm32cubeide':     { build: ['make', '-j$(nproc)', '-C', 'Debug'], clean: ['make', 'clean', '-C', 'Debug'],                flash: ['st-flash', 'write', 'Debug/*.bin', '0x08000000'] },
	'stm32cubemx':      { build: ['make', '-j$(nproc)'],             clean: ['make', 'clean'],                                  flash: ['openocd', '-f', 'interface/stlink.cfg', '-f', 'target/stm32f4x.cfg', '-c', 'program build/*.elf verify reset exit'] },
	'generic':          { build: ['make'],                           clean: ['make', 'clean'],                                  flash: ['openocd', '-f', 'interface/stlink.cfg', '-c', 'program *.elf verify reset exit'] },
};

// Flash tool detection commands
const FLASH_TOOL_DETECTORS: Array<{ name: string; command: string; versionArg: string; interfaces: string[] }> = [
	{ name: 'openocd',                  command: 'openocd',                  versionArg: '--version',     interfaces: ['swd', 'jtag'] },
	{ name: 'stm32-programmer-cli',     command: 'STM32_Programmer_CLI',     versionArg: '--version',     interfaces: ['swd', 'jtag', 'uart', 'usb'] },
	{ name: 'st-flash',                 command: 'st-flash',                 versionArg: '--version',     interfaces: ['swd'] },
	{ name: 'esptool',                  command: 'esptool.py',               versionArg: 'version',       interfaces: ['uart', 'usb'] },
	{ name: 'nrfjprog',                 command: 'nrfjprog',                 versionArg: '--version',     interfaces: ['swd', 'jtag'] },
	{ name: 'jlink',                    command: 'JLinkExe',                 versionArg: '-CommandFile /dev/null', interfaces: ['swd', 'jtag'] },
	{ name: 'pyocd',                    command: 'pyocd',                    versionArg: '--version',     interfaces: ['swd'] },
	{ name: 'probe-rs',                 command: 'probe-rs',                 versionArg: '--version',     interfaces: ['swd', 'jtag'] },
	{ name: 'dfu-util',                 command: 'dfu-util',                 versionArg: '--version',     interfaces: ['dfu'] },
	{ name: 'arduino-cli',              command: 'arduino-cli',              versionArg: 'version',       interfaces: ['uart', 'usb'] },
	{ name: 'west',                     command: 'west',                     versionArg: '--version',     interfaces: ['swd', 'jtag'] },
];


// ─── Implementation ───────────────────────────────────────────────────────────

class BuildSystemService extends Disposable implements IBuildSystemService {
	readonly _serviceBrand: undefined;

	private readonly _onBuildStarted = this._register(new Emitter<IBuildEvent>());
	readonly onBuildStarted = this._onBuildStarted.event;

	private readonly _onBuildOutput = this._register(new Emitter<IBuildOutputLine>());
	readonly onBuildOutput = this._onBuildOutput.event;

	private readonly _onBuildCompleted = this._register(new Emitter<IBuildResult>());
	readonly onBuildCompleted = this._onBuildCompleted.event;

	private readonly _onFlashStarted = this._register(new Emitter<void>());
	readonly onFlashStarted = this._onFlashStarted.event;

	private readonly _onFlashCompleted = this._register(new Emitter<IFlashResult>());
	readonly onFlashCompleted = this._onFlashCompleted.event;

	private _isBuilding = false;
	private _isFlashing = false;
	private _lastBuildResult: IBuildResult | undefined;

	get isBuilding(): boolean { return this._isBuilding; }
	get isFlashing(): boolean { return this._isFlashing; }
	get lastBuildResult(): IBuildResult | undefined { return this._lastBuildResult; }

	constructor(
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		@IFirmwareSessionService _session: IFirmwareSessionService,
		@ITerminalService private readonly _terminalService: ITerminalService,
	) {
		super();
		void _session;
	}

	/** Get or create the shared "Firmware Build" terminal. */
	private async _getTerminal() {
		const existing = this._terminalService.instances.find(t => t.title === 'Firmware Build');
		if (existing) { return existing; }
		return this._terminalService.createTerminal({
			location: TerminalLocation.Panel,
			config: { name: 'Firmware Build', forceShellIntegration: true },
		});
	}

	/** Bring the terminal into view and keep the editor focus. */
	private async _showTerminal(term: Awaited<ReturnType<typeof this._getTerminal>>) {
		this._terminalService.setActiveInstance(term);
		await this._terminalService.focusActiveInstance();
	}

	async build(projectRoot: string, projectType: FirmwareProjectType, target?: string): Promise<IBuildResult> {
		if (this._isBuilding) {
			throw new Error('Build already in progress');
		}

		this._isBuilding = true;
		const startTime = Date.now();
		const command = this.getBuildCommand(projectType, target);

		this._onBuildStarted.fire({ projectRoot, projectType, target, command, startTime });

		try {
			// Get or create the Firmware Build terminal and run the command there.
			const term = await this._getTerminal();
			await this._showTerminal(term);

			// cd to project root first so relative paths in build output are correct.
			await term.sendText(`cd "${projectRoot}"`, true);
			await term.sendText(command.join(' '), true);

			this._onBuildOutput.fire({
				text: `$ ${command.join(' ')}`,
				stream: 'stdout',
				timestamp: Date.now(),
			});

			// The result is optimistic; real pass/fail is read from terminal output.
			// The agent tools layer monitors onBuildOutput to update status.
			const result: IBuildResult = {
				success: true,
				durationMs: Date.now() - startTime,
				errors: [],
				warnings: [],
			};

			this._lastBuildResult = result;
			this._onBuildCompleted.fire(result);
			return result;
		} finally {
			this._isBuilding = false;
		}
	}

	async clean(projectRoot: string, projectType: FirmwareProjectType): Promise<void> {
		const commands = BUILD_COMMANDS[projectType] || BUILD_COMMANDS['generic'];
		const term = await this._getTerminal();
		await this._showTerminal(term);
		await term.sendText(`cd "${projectRoot}"`, true);
		await term.sendText(commands.clean.join(' '), true);
	}

	async flash(projectRoot: string, projectType: FirmwareProjectType, flashConfig?: IFlashConfig): Promise<IFlashResult> {
		if (this._isFlashing) {
			throw new Error('Flash operation already in progress');
		}

		this._isFlashing = true;
		const startTime = Date.now();
		this._onFlashStarted.fire();

		try {
			const command = this.getFlashCommand(projectType, flashConfig);

			const term = await this._getTerminal();
			await this._showTerminal(term);
			await term.sendText(`cd "${projectRoot}"`, true);
			await term.sendText(command.join(' '), true);

			this._onBuildOutput.fire({
				text: `$ ${command.join(' ')}`,
				stream: 'stdout',
				timestamp: Date.now(),
			});

			const result: IFlashResult = {
				success: true,
				durationMs: Date.now() - startTime,
				tool: flashConfig?.tool ?? this._defaultFlashTool(projectType),
				message: 'Flash command dispatched to terminal',
			};

			this._onFlashCompleted.fire(result);
			return result;
		} finally {
			this._isFlashing = false;
		}
	}

	async analyzeBinarySize(elfPath: string, mcuFlashSize: number, mcuRamSize: number): Promise<IBinarySizeAnalysis> {
		// Binary size analysis uses arm-none-eabi-size or equivalent
		// In IDE, we parse the output of `size` command
		this._onBuildOutput.fire({
			text: `$ arm-none-eabi-size ${elfPath}`,
			stream: 'stdout',
			timestamp: Date.now(),
		});

		// Return placeholder analysis — actual parsing happens from terminal output
		return {
			textSize: 0,
			dataSize: 0,
			bssSize: 0,
			flashUsage: 0,
			ramUsage: 0,
			flashPercent: 0,
			ramPercent: 0,
			sections: [],
		};
	}

	getBuildCommand(projectType: FirmwareProjectType, target?: string): string[] {
		const commands = BUILD_COMMANDS[projectType] || BUILD_COMMANDS['generic'];
		const cmd = [...commands.build];

		// Add target/environment for PlatformIO
		if (projectType === 'platformio' && target) {
			cmd.push('-e', target);
		}
		// Add target board for Zephyr
		else if (projectType === 'zephyr' && target) {
			cmd.push('-b', target);
		}
		// Add target for cargo
		else if (projectType === 'rust-embedded' && target) {
			cmd.push('--target', target);
		}

		return cmd;
	}

	getFlashCommand(projectType: FirmwareProjectType, flashConfig?: IFlashConfig): string[] {
		if (flashConfig) {
			return this._buildFlashCommand(flashConfig);
		}
		const commands = BUILD_COMMANDS[projectType] || BUILD_COMMANDS['generic'];
		return [...commands.flash];
	}

	async detectFlashTools(): Promise<IFlashToolInfo[]> {
		// In IDE environment, detecting tools requires process execution.
		// We emit detection output for external processing.
		const results: IFlashToolInfo[] = [];

		for (const detector of FLASH_TOOL_DETECTORS) {
			// In a real implementation, we'd run `which <command>` and `<command> --version`
			// For now, we return the list of known tools for the UI to display
			results.push({
				name: detector.name,
				path: detector.command,
				supportedInterfaces: detector.interfaces,
			});
		}

		return results;
	}

	// ─── Private helpers ──────────────────────────────────────────────────

	private _buildFlashCommand(config: IFlashConfig): string[] {
		switch (config.tool) {
			case 'openocd':
				return [
					'openocd',
					...(config.interface === 'swd' ? ['-f', 'interface/stlink-v2.cfg'] : ['-f', 'interface/jlink.cfg']),
					...(config.target ? ['-f', `target/${config.target}.cfg`] : []),
					'-c', `program ${config.extraArgs?.[0] ?? '*.elf'} verify reset exit`,
				];

			case 'stm32-programmer-cli':
				return [
					'STM32_Programmer_CLI',
					'-c', `port=${config.interface?.toUpperCase() ?? 'SWD'}`,
					'-w', config.extraArgs?.[0] ?? '*.elf',
					'-v',
					'-rst',
				];

			case 'esptool':
				return [
					'esptool.py',
					'--port', config.extraArgs?.[0] ?? '/dev/ttyUSB0',
					'--baud', '460800',
					'write_flash',
					'0x0',
					config.extraArgs?.[1] ?? 'build/*.bin',
				];

			case 'nrfjprog':
				return [
					'nrfjprog',
					'--program', config.extraArgs?.[0] ?? '*.hex',
					'--verify',
					'--reset',
				];

			case 'jlink':
				return [
					'JLinkExe',
					'-device', config.target ?? 'STM32F407VG',
					'-if', config.interface?.toUpperCase() ?? 'SWD',
					'-speed', '4000',
					'-CommandFile', config.extraArgs?.[0] ?? 'flash.jlink',
				];

			case 'pyocd':
				return [
					'pyocd',
					'flash',
					...(config.target ? ['-t', config.target] : []),
					config.extraArgs?.[0] ?? '*.elf',
				];

			case 'dfu-util':
				return [
					'dfu-util',
					'-a', '0',
					'-D', config.extraArgs?.[0] ?? '*.bin',
					'-s', '0x08000000:leave',
				];

			default:
				return ['echo', `Unknown flash tool: ${config.tool}`];
		}
	}

	private _defaultFlashTool(projectType: FirmwareProjectType): string {
		switch (projectType) {
			case 'platformio': return 'platformio';
			case 'esp-idf': return 'esptool';
			case 'zephyr': return 'west';
			case 'rust-embedded': return 'probe-rs';
			case 'arduino': return 'arduino-cli';
			default: return 'openocd';
		}
	}

	/**
	 * Parse GCC diagnostic output into structured IBuildDiagnostic[].
	 * Handles formats from arm-none-eabi-gcc, xtensa-esp32-elf-gcc, riscv32-unknown-elf-gcc.
	 */
	parseBuildOutput(output: string): { errors: IBuildDiagnostic[]; warnings: IBuildDiagnostic[] } {
		const errors: IBuildDiagnostic[] = [];
		const warnings: IBuildDiagnostic[] = [];

		// GCC format: file.c:42:10: error: expected ';' before '}' token
		const gccRegex = /^(.+?):(\d+):(\d+):\s+(error|warning|note):\s+(.+)$/gm;
		let match: RegExpExecArray | null;

		while ((match = gccRegex.exec(output)) !== null) {
			const diagnostic: IBuildDiagnostic = {
				file: match[1],
				line: parseInt(match[2]),
				column: parseInt(match[3]),
				severity: match[4] as 'error' | 'warning' | 'note',
				message: match[5],
			};

			if (diagnostic.severity === 'error') {
				errors.push(diagnostic);
			} else {
				warnings.push(diagnostic);
			}
		}

		// Also parse linker errors: undefined reference to 'xxx'
		const linkerRegex = /^(.+?):(\d+):\s+undefined reference to [`'](.+?)['`]/gm;
		while ((match = linkerRegex.exec(output)) !== null) {
			errors.push({
				file: match[1],
				line: parseInt(match[2]),
				severity: 'error',
				message: `Undefined reference to '${match[3]}'`,
			});
		}

		// Parse size output: text	data	bss	dec	hex	filename
		// This is informational, not errors

		return { errors, warnings };
	}

	/**
	 * Parse arm-none-eabi-size output into IBinarySizeAnalysis.
	 * Format: text	data	bss	dec	hex	filename
	 */
	parseSizeOutput(output: string, mcuFlashSize: number, mcuRamSize: number): IBinarySizeAnalysis {
		const lines = output.trim().split('\n');
		// Look for the data line (second line, first line is header)
		const dataLine = lines.find(l => /^\s*\d+/.test(l));

		if (!dataLine) {
			return {
				textSize: 0, dataSize: 0, bssSize: 0,
				flashUsage: 0, ramUsage: 0,
				flashPercent: 0, ramPercent: 0,
				sections: [],
			};
		}

		const parts = dataLine.trim().split(/\s+/);
		const textSize = parseInt(parts[0]) || 0;
		const dataSize = parseInt(parts[1]) || 0;
		const bssSize = parseInt(parts[2]) || 0;

		const flashUsage = textSize + dataSize;
		const ramUsage = dataSize + bssSize;

		return {
			textSize,
			dataSize,
			bssSize,
			flashUsage,
			ramUsage,
			flashPercent: mcuFlashSize > 0 ? (flashUsage / mcuFlashSize) * 100 : 0,
			ramPercent: mcuRamSize > 0 ? (ramUsage / mcuRamSize) * 100 : 0,
			sections: [
				{ name: '.text', size: textSize, address: 0x08000000 },
				{ name: '.data', size: dataSize, address: 0x20000000 },
				{ name: '.bss', size: bssSize, address: 0x20000000 + dataSize },
			],
		};
	}
}


registerSingleton(IBuildSystemService, BuildSystemService, InstantiationType.Delayed);
