/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Project Detector Service
 *
 * Scans workspace folders for firmware project indicators and extracts
 * MCU configuration from project files. Supports:
 *
 *   - PlatformIO (platformio.ini)
 *   - STM32CubeMX (.ioc files)
 *   - STM32CubeIDE (.cproject)
 *   - ESP-IDF (sdkconfig)
 *   - Zephyr (prj.conf + boards/)
 *   - CMake embedded projects (CMakeLists.txt with MCU patterns)
 *   - Makefile projects (Makefile with MCU patterns)
 *   - Rust embedded (Cargo.toml with embedded crates)
 *   - Arduino (.ino files)
 *   - Mbed (mbed_app.json)
 *
 * Runs on workspace open (debounced) and on demand.
 * Emits onProjectDetected when a firmware project is found.
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import {
	IFirmwareProjectInfo,
	IDetectedConfigFile,
	FirmwareProjectType,
	FIRMWARE_INVERSE_FILENAME,
	IFirmwareInverseFile,
} from '../common/firmwareTypes.js';


// ─── Service interface ────────────────────────────────────────────────────────

export const IProjectDetectorService = createDecorator<IProjectDetectorService>('projectDetectorService');

export interface IProjectDetectorService {
	readonly _serviceBrand: undefined;

	/** Fires when a firmware project is detected in a workspace folder. */
	readonly onProjectDetected: Event<IFirmwareProjectInfo>;

	/** Last detection result (may be undefined if not yet scanned). */
	readonly lastResult: IFirmwareProjectInfo | undefined;

	/**
	 * Scan all workspace folders for firmware project indicators.
	 * Returns the best match, or undefined if no firmware project detected.
	 */
	scan(): Promise<IFirmwareProjectInfo | undefined>;

	/**
	 * Scan a specific folder URI for firmware project indicators.
	 */
	scanFolder(folderUri: URI): Promise<IFirmwareProjectInfo | undefined>;
}


// ─── Implementation ───────────────────────────────────────────────────────────

class ProjectDetectorService extends Disposable implements IProjectDetectorService {
	readonly _serviceBrand: undefined;

	private readonly _onProjectDetected = this._register(new Emitter<IFirmwareProjectInfo>());
	readonly onProjectDetected: Event<IFirmwareProjectInfo> = this._onProjectDetected.event;

	private _lastResult: IFirmwareProjectInfo | undefined;
	get lastResult(): IFirmwareProjectInfo | undefined { return this._lastResult; }

	constructor(
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
	}

	async scan(): Promise<IFirmwareProjectInfo | undefined> {
		const folders = this._workspace.getWorkspace().folders;
		if (folders.length === 0) return undefined;

		let bestResult: IFirmwareProjectInfo | undefined;
		let bestConfidence = 0;

		for (const folder of folders) {
			const result = await this.scanFolder(folder.uri);
			if (result && result.confidence > bestConfidence) {
				bestResult = result;
				bestConfidence = result.confidence;
			}
		}

		if (bestResult) {
			this._lastResult = bestResult;
			this._onProjectDetected.fire(bestResult);
		}

		return bestResult;
	}

	async scanFolder(folderUri: URI): Promise<IFirmwareProjectInfo | undefined> {
		const configFiles: IDetectedConfigFile[] = [];
		const svdFilePaths: string[] = [];
		let projectType: FirmwareProjectType = 'generic';
		let confidence = 0;
		let mcuFamily: string | undefined;
		let mcuVariant: string | undefined;
		let boardName: string | undefined;
		let rtos: string | undefined;
		let buildSystem: string | undefined;
		let framework: string | undefined;
		let hal: string | undefined;

		const rootPath = folderUri.path;

		// ── Firmware.inverse — highest priority, confidence 1.0 ──────────────
		// Mirrors how Modernisation.inverse works: presence of this file is a
		// guaranteed, user-confirmed firmware project declaration.
		const inverseData = await this._readInverseFile(folderUri);
		if (inverseData) {
			const extractedData: Record<string, string> = { mcu: inverseData.mcu };
			if (inverseData.board) { extractedData['board'] = inverseData.board; }
			if (inverseData.buildSystem) { extractedData['buildSystem'] = inverseData.buildSystem; }
			if (inverseData.hal) { extractedData['hal'] = inverseData.hal; }

			const svdFilePaths: string[] = [];
			if (inverseData.svd) { svdFilePaths.push(`${rootPath}/${inverseData.svd}`); }

			const info: IFirmwareProjectInfo = {
				projectType: 'firmware-inverse',
				mcuFamily: this._mcuVariantToFamily(inverseData.mcu),
				mcuVariant: inverseData.mcu,
				boardName: inverseData.board,
				rtos: inverseData.rtos,
				buildSystem: inverseData.buildSystem,
				hal: inverseData.hal,
				projectRoot: folderUri.toString(),
				configFiles: [{ path: FIRMWARE_INVERSE_FILENAME, type: 'Firmware.inverse', extractedData }],
				svdFilePaths,
				confidence: 1.0,
				// Carry datasheets and compliance so contribution can auto-load them
				datasheetPaths: inverseData.datasheets?.map(d => `${rootPath}/${d}`) ?? [],
				complianceFrameworks: inverseData.compliance ?? [],
			};
			this._lastResult = info;
			this._onProjectDetected.fire(info);
			return info;
		}

		// ── Check for each project type ──────────────────────────────────

		// PlatformIO
		const pioIni = await this._tryReadFile(folderUri, 'platformio.ini');
		if (pioIni) {
			projectType = 'platformio';
			buildSystem = 'platformio';
			confidence += 0.9;

			const extractedData: Record<string, string> = {};
			const boardMatch = pioIni.match(/board\s*=\s*(\S+)/);
			if (boardMatch) { boardName = boardMatch[1]; extractedData['board'] = boardMatch[1]; }
			const frameworkMatch = pioIni.match(/framework\s*=\s*(\S+)/);
			if (frameworkMatch) { framework = frameworkMatch[1]; extractedData['framework'] = frameworkMatch[1]; }
			const platformMatch = pioIni.match(/platform\s*=\s*(\S+)/);
			if (platformMatch) { extractedData['platform'] = platformMatch[1]; }

			// Derive MCU from PlatformIO board names
			if (boardName) {
				const pio = this._pioBoardToMCU(boardName);
				mcuFamily = pio.family;
				mcuVariant = pio.variant;
			}

			if (framework === 'arduino') { hal = 'arduino'; }
			else if (framework === 'espidf') { hal = 'esp-idf'; }
			else if (framework === 'zephyr') { hal = 'zephyr-api'; rtos = 'Zephyr'; }
			else if (framework === 'stm32cube') { hal = 'stm32-hal'; }
			else if (framework === 'mbed') { hal = 'mbed'; }

			// Check for FreeRTOS
			if (pioIni.includes('freertos') || pioIni.includes('FreeRTOS')) { rtos = 'FreeRTOS'; }

			configFiles.push({ path: 'platformio.ini', type: 'platformio.ini', extractedData });
		}

		// STM32CubeMX .ioc files
		const iocFiles = await this._findFiles(folderUri, '*.ioc');
		if (iocFiles.length > 0) {
			const iocContent = await this._tryReadFile(folderUri, iocFiles[0]);
			if (iocContent) {
				projectType = 'stm32cubemx';
				confidence += 0.95;
				buildSystem = buildSystem || 'stm32cubeide';
				hal = hal || 'stm32-hal';

				const extractedData: Record<string, string> = {};
				const mcuMatch = iocContent.match(/Mcu\.UserName\s*=\s*(\S+)/);
				if (mcuMatch) {
					mcuVariant = mcuMatch[1];
					mcuFamily = this._mcuVariantToFamily(mcuVariant);
					extractedData['mcu'] = mcuMatch[1];
				}
				const ipMatch = iocContent.match(/ProjectManager\.LibraryCopy\s*=\s*(\d+)/);
				if (ipMatch) { extractedData['libraryCopy'] = ipMatch[1]; }

				// Check for FreeRTOS middleware
				if (iocContent.includes('FREERTOS')) { rtos = 'FreeRTOS'; }

				configFiles.push({ path: iocFiles[0], type: '.ioc', extractedData });
			}
		}

		// ESP-IDF (sdkconfig)
		const sdkconfig = await this._tryReadFile(folderUri, 'sdkconfig');
		if (sdkconfig) {
			projectType = 'esp-idf';
			buildSystem = buildSystem || 'cmake';
			hal = hal || 'esp-idf';
			confidence += 0.9;

			const extractedData: Record<string, string> = {};
			const targetMatch = sdkconfig.match(/CONFIG_IDF_TARGET="?(\w+)"?/);
			if (targetMatch) {
				const target = targetMatch[1].toLowerCase();
				extractedData['target'] = target;
				mcuFamily = 'ESP32';
				if (target === 'esp32') mcuVariant = 'ESP32-D0WDQ6';
				else if (target === 'esp32s3') mcuVariant = 'ESP32-S3-WROOM-1';
				else if (target === 'esp32c3') mcuVariant = 'ESP32-C3-MINI-1';
				else if (target === 'esp32c6') mcuVariant = 'ESP32-C6-WROOM-1';
				else if (target === 'esp32h2') mcuVariant = 'ESP32-H2-MINI-1';
			}

			configFiles.push({ path: 'sdkconfig', type: 'sdkconfig', extractedData });
		}

		// Zephyr (prj.conf)
		const prjConf = await this._tryReadFile(folderUri, 'prj.conf');
		if (prjConf) {
			projectType = 'zephyr';
			buildSystem = buildSystem || 'cmake';
			rtos = 'Zephyr';
			hal = hal || 'zephyr-api';
			confidence += 0.85;

			const extractedData: Record<string, string> = {};
			const boardMatch = prjConf.match(/CONFIG_BOARD="?(\S+)"?/);
			if (boardMatch) { boardName = boardMatch[1]; extractedData['board'] = boardMatch[1]; }

			configFiles.push({ path: 'prj.conf', type: 'prj.conf', extractedData });
		}

		// CMakeLists.txt with embedded patterns
		const cmake = await this._tryReadFile(folderUri, 'CMakeLists.txt');
		if (cmake) {
			const extractedData: Record<string, string> = {};
			const mcuModelMatch = cmake.match(/set\s*\(\s*MCU_MODEL\s+(\S+)/i) || cmake.match(/STM32(\w+)/);
			if (mcuModelMatch) {
				if (!mcuVariant) {
					mcuVariant = mcuModelMatch[1];
					mcuFamily = this._mcuVariantToFamily(mcuVariant);
				}
				extractedData['mcu'] = mcuModelMatch[1];
				if (projectType === 'generic') { projectType = 'cmake-embedded'; }
				confidence += 0.5;
			}
			// Check for arm-none-eabi toolchain
			if (cmake.includes('arm-none-eabi') || cmake.includes('arm_none_eabi')) {
				confidence += 0.3;
				if (projectType === 'generic') { projectType = 'cmake-embedded'; }
			}
			if (!buildSystem) { buildSystem = 'cmake'; }

			if (Object.keys(extractedData).length > 0 || cmake.includes('arm-none-eabi')) {
				configFiles.push({ path: 'CMakeLists.txt', type: 'CMakeLists.txt', extractedData });
			}
		}

		// Makefile with embedded patterns
		const makefile = await this._tryReadFile(folderUri, 'Makefile');
		if (makefile) {
			const extractedData: Record<string, string> = {};
			const deviceMatch = makefile.match(/(?:DEVICE|MCU|TARGET_MCU)\s*[=:]+\s*(\S+)/i);
			if (deviceMatch) {
				if (!mcuVariant) {
					mcuVariant = deviceMatch[1];
					mcuFamily = this._mcuVariantToFamily(mcuVariant);
				}
				extractedData['device'] = deviceMatch[1];
				if (projectType === 'generic') { projectType = 'make-embedded'; }
				confidence += 0.5;
			}
			if (makefile.includes('arm-none-eabi') || makefile.includes('openocd') || makefile.includes('.elf')) {
				confidence += 0.3;
				if (projectType === 'generic') { projectType = 'make-embedded'; }
			}
			if (!buildSystem) { buildSystem = 'make'; }

			if (Object.keys(extractedData).length > 0) {
				configFiles.push({ path: 'Makefile', type: 'Makefile', extractedData });
			}
		}

		// Rust embedded (Cargo.toml)
		const cargo = await this._tryReadFile(folderUri, 'Cargo.toml');
		if (cargo) {
			const extractedData: Record<string, string> = {};
			const isEmbedded = cargo.includes('cortex-m') || cargo.includes('embassy') ||
				cargo.includes('esp-hal') || cargo.includes('nrf-hal') ||
				cargo.includes('stm32') || cargo.includes('rp-hal') ||
				cargo.includes('embedded-hal');

			if (isEmbedded) {
				projectType = 'rust-embedded';
				confidence += 0.8;
				buildSystem = 'cargo';

				if (cargo.includes('embassy-stm32')) { hal = 'embassy-stm32'; extractedData['hal'] = 'embassy-stm32'; }
				else if (cargo.includes('stm32f4xx-hal')) { hal = 'stm32f4xx-hal'; mcuFamily = 'STM32F4'; }
				else if (cargo.includes('stm32h7xx-hal')) { hal = 'stm32h7xx-hal'; mcuFamily = 'STM32H7'; }
				else if (cargo.includes('nrf52840-hal')) { hal = 'nrf52840-hal'; mcuFamily = 'nRF52'; mcuVariant = 'nRF52840-QIAA'; }
				else if (cargo.includes('esp-hal')) { hal = 'esp-hal'; mcuFamily = 'ESP32'; }
				else if (cargo.includes('rp-hal') || cargo.includes('rp2040-hal')) { hal = 'rp-hal'; mcuFamily = 'RP2040'; mcuVariant = 'RP2040'; }

				if (cargo.includes('embassy-executor')) { rtos = 'Embassy'; }
				else if (cargo.includes('rtic')) { rtos = 'RTIC'; }

				configFiles.push({ path: 'Cargo.toml', type: 'Cargo.toml', extractedData });
			}
		}

		// Arduino (.ino files)
		const inoFiles = await this._findFiles(folderUri, '*.ino');
		if (inoFiles.length > 0 && projectType === 'generic') {
			projectType = 'arduino';
			confidence += 0.6;
			hal = 'arduino';
			buildSystem = 'arduino-cli';
			configFiles.push({ path: inoFiles[0], type: 'arduino.ino', extractedData: {} });
		}

		// Mbed (mbed_app.json)
		const mbedApp = await this._tryReadFile(folderUri, 'mbed_app.json');
		if (mbedApp) {
			projectType = 'mbed';
			confidence += 0.8;
			hal = 'mbed';
			rtos = 'Mbed OS';
			try {
				const config = JSON.parse(mbedApp);
				if (config.target_overrides?.['*']?.target_name) {
					boardName = config.target_overrides['*'].target_name;
				}
			} catch { /* not valid JSON */ }
			configFiles.push({ path: 'mbed_app.json', type: 'mbed_app.json', extractedData: {} });
		}

		// Scan for SVD files
		const svdFiles = await this._findFiles(folderUri, '*.svd');
		svdFilePaths.push(...svdFiles.map(f => `${rootPath}/${f}`));
		if (svdFiles.length > 0) { confidence += 0.2; }

		// ── Minimum confidence gate ──────────────────────────────────────
		if (confidence < 0.3) { return undefined; }

		const info: IFirmwareProjectInfo = {
			projectType,
			mcuFamily,
			mcuVariant,
			boardName,
			rtos,
			buildSystem,
			framework,
			hal,
			projectRoot: folderUri.toString(),
			configFiles,
			svdFilePaths,
			confidence: Math.min(confidence, 1.0),
		};

		return info;
	}

	// ─── Firmware.inverse helper ────────────────────────────────────────────

	/**
	 * Read and parse `Firmware.inverse` from a folder root.
	 * Returns the parsed manifest or undefined if not found / invalid.
	 * Mirrors `openExistingProject()` in ModernisationSessionService.
	 */
	private async _readInverseFile(folderUri: URI): Promise<IFirmwareInverseFile | undefined> {
		try {
			const fileUri = URI.joinPath(folderUri, FIRMWARE_INVERSE_FILENAME);
			const content = await this._fileService.readFile(fileUri);
			const data = JSON.parse(content.value.toString()) as Partial<IFirmwareInverseFile>;
			// Validate discriminator
			if (data.neuralInverseFirmware !== true || !data.mcu) { return undefined; }
			return data as IFirmwareInverseFile;
		} catch {
			return undefined;
		}
	}

	// ─── File helpers ────────────────────────────────────────────────────

	private async _tryReadFile(folderUri: URI, relativePath: string): Promise<string | undefined> {
		try {
			const fileUri = URI.joinPath(folderUri, relativePath);
			const content = await this._fileService.readFile(fileUri);
			return content.value.toString();
		} catch {
			return undefined;
		}
	}

	private async _findFiles(folderUri: URI, pattern: string): Promise<string[]> {
		// Simple file discovery — look in root and common subdirectories
		const results: string[] = [];
		const ext = pattern.replace('*', '');
		const dirsToCheck = ['', 'src', 'lib', 'core', 'Drivers', 'Inc', 'Src'];

		for (const dir of dirsToCheck) {
			try {
				const dirUri = dir ? URI.joinPath(folderUri, dir) : folderUri;
				const stat = await this._fileService.resolve(dirUri);
				if (stat.children) {
					for (const child of stat.children) {
						if (!child.isDirectory && child.name.endsWith(ext)) {
							results.push(dir ? `${dir}/${child.name}` : child.name);
						}
					}
				}
			} catch { /* directory doesn't exist */ }
		}

		return results;
	}

	// ─── MCU name mappers ────────────────────────────────────────────────

	private _mcuVariantToFamily(variant: string): string {
		const v = variant.toUpperCase();
		if (v.startsWith('STM32F0')) return 'STM32F0';
		if (v.startsWith('STM32F1')) return 'STM32F1';
		if (v.startsWith('STM32F2')) return 'STM32F2';
		if (v.startsWith('STM32F3')) return 'STM32F3';
		if (v.startsWith('STM32F4')) return 'STM32F4';
		if (v.startsWith('STM32F7')) return 'STM32F7';
		if (v.startsWith('STM32H7')) return 'STM32H7';
		if (v.startsWith('STM32L0')) return 'STM32L0';
		if (v.startsWith('STM32L1')) return 'STM32L1';
		if (v.startsWith('STM32L4')) return 'STM32L4';
		if (v.startsWith('STM32G0')) return 'STM32G0';
		if (v.startsWith('STM32G4')) return 'STM32G4';
		if (v.startsWith('STM32U5')) return 'STM32U5';
		if (v.startsWith('STM32WB')) return 'STM32WB';
		if (v.startsWith('STM32WL')) return 'STM32WL';
		if (v.startsWith('NRF52')) return 'nRF52';
		if (v.startsWith('NRF53')) return 'nRF53';
		if (v.startsWith('NRF91')) return 'nRF91';
		if (v.startsWith('ESP32')) return 'ESP32';
		if (v.startsWith('RP2040')) return 'RP2040';
		if (v.startsWith('RP2350')) return 'RP2350';
		if (v.startsWith('SAMD21') || v.startsWith('ATSAMD21')) return 'SAM D21';
		if (v.startsWith('SAME51') || v.startsWith('ATSAME51')) return 'SAM E51';
		if (v.startsWith('ATMEGA')) return 'AVR';
		if (v.startsWith('MSP430')) return 'MSP430';
		if (v.startsWith('GD32VF')) return 'GD32VF';
		if (v.startsWith('MIMXRT')) return 'i.MX RT';
		if (v.startsWith('LPC55')) return 'LPC55';
		return variant;
	}

	private _pioBoardToMCU(board: string): { family?: string; variant?: string } {
		const b = board.toLowerCase();

		// STM32
		if (b.includes('nucleo_f401re')) return { family: 'STM32F4', variant: 'STM32F401RET6' };
		if (b.includes('nucleo_f446re')) return { family: 'STM32F4', variant: 'STM32F446RET6' };
		if (b.includes('nucleo_f411re')) return { family: 'STM32F4', variant: 'STM32F411CEU6' };
		if (b.includes('nucleo_f103rb')) return { family: 'STM32F1', variant: 'STM32F103RET6' };
		if (b.includes('nucleo_l476rg')) return { family: 'STM32L4', variant: 'STM32L476RGT6' };
		if (b.includes('nucleo_h743zi')) return { family: 'STM32H7', variant: 'STM32H743VIT6' };
		if (b.includes('disco_f407vg') || b.includes('f407')) return { family: 'STM32F4', variant: 'STM32F407VGT6' };
		if (b.includes('blackpill_f401')) return { family: 'STM32F4', variant: 'STM32F401CCU6' };
		if (b.includes('blackpill_f411')) return { family: 'STM32F4', variant: 'STM32F411CEU6' };
		if (b.includes('bluepill_f103c8')) return { family: 'STM32F1', variant: 'STM32F103C8T6' };

		// ESP32
		if (b.includes('esp32dev') || b.includes('esp32doit')) return { family: 'ESP32', variant: 'ESP32-D0WDQ6' };
		if (b.includes('esp32-s3')) return { family: 'ESP32', variant: 'ESP32-S3-WROOM-1' };
		if (b.includes('esp32-c3')) return { family: 'ESP32', variant: 'ESP32-C3-MINI-1' };
		if (b.includes('esp32-c6')) return { family: 'ESP32', variant: 'ESP32-C6-WROOM-1' };

		// Nordic
		if (b.includes('nrf52840_dk')) return { family: 'nRF52', variant: 'nRF52840-QIAA' };
		if (b.includes('nrf52832_dk')) return { family: 'nRF52', variant: 'nRF52832-QIAA' };

		// RP2040
		if (b.includes('pico') && !b.includes('pico2')) return { family: 'RP2040', variant: 'RP2040' };
		if (b.includes('pico2')) return { family: 'RP2350', variant: 'RP2350A' };

		// Teensy
		if (b.includes('teensy41') || b.includes('teensy40')) return { family: 'i.MX RT', variant: 'MIMXRT1062DVL6A' };

		// Arduino
		if (b.includes('uno')) return { family: 'AVR', variant: 'ATmega328P' };
		if (b.includes('mega')) return { family: 'AVR', variant: 'ATmega2560' };
		if (b.includes('zero') || b.includes('mkr')) return { family: 'SAM D21', variant: 'ATSAMD21G18A' };

		return {};
	}
}


registerSingleton(IProjectDetectorService, ProjectDetectorService, InstantiationType.Delayed);
