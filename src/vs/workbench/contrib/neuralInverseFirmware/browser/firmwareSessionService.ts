/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * FirmwareSessionService
 *
 * Single source of truth for the active firmware development session.
 * Tracks which MCU is targeted, loaded datasheets and SVD files,
 * compliance frameworks, and the currently focused peripheral.
 *
 * Consumed by:
 *  - FirmwarePart (Firmware Environment aux window)
 *  - HardwareContextProvider (system prompt injection)
 *  - FirmwareAgentTools (fw_* tools)
 *  - FirmwareStatusContribution (status bar item)
 *  - convertToLLMMessageService (_buildFirmwareContext)
 */

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	IFirmwareSessionData,
	IMCUConfig,
	IDatasheetInfo,
	IPeripheralRegisterMap,
	ITimingConstraint,
	IErrata,
	FirmwareComplianceFramework,
	IFirmwareProjectInfo,
	ISerialPortConfig,
	IBuildResult,
	IDebugSessionState,
	DEFAULT_FIRMWARE_SESSION,
} from '../common/firmwareTypes.js';
import { ISVDParserService } from './engine/svd/svdParserService.js';
import { BUNDLED_SVD_XML, lookupBundledSVDKey } from '../common/bundledSVDs.js';


// ─── Service interface ────────────────────────────────────────────────────────

export const IFirmwareSessionService = createDecorator<IFirmwareSessionService>('firmwareSessionService');

export interface IFirmwareSessionService {
	readonly _serviceBrand: undefined;

	/** Current session snapshot. Mutates reactively — listen to onDidChangeSession for updates. */
	readonly session: IFirmwareSessionData;

	/** Fires whenever session state changes. */
	readonly onDidChangeSession: Event<IFirmwareSessionData>;

	/**
	 * Start a new firmware session.
	 *
	 * @param mcuConfig  MCU hardware configuration
	 * @param boardName  Board name (optional)
	 * @param projectUri Workspace folder URI for the firmware project
	 */
	startSession(mcuConfig: IMCUConfig, boardName?: string, projectUri?: string): void;

	/** End the session (clears all state). */
	endSession(): void;

	/** Update the MCU configuration. */
	setMCUConfig(config: IMCUConfig): void;

	/** Set the active peripheral for focused context injection. */
	setActivePeripheral(peripheral: string | undefined): void;

	/** Add a parsed SVD file and its register maps. */
	addSVDFile(filePath: string, registerMaps: IPeripheralRegisterMap[]): void;

	/** Add a parsed datasheet and its extracted data. */
	addDatasheet(info: IDatasheetInfo, registerMaps: IPeripheralRegisterMap[], timingConstraints: ITimingConstraint[], errata: IErrata[]): void;

	/** Remove a datasheet by ID. */
	removeDatasheet(datasheetId: string): void;

	/** Set the active compliance frameworks. */
	setComplianceFrameworks(frameworks: FirmwareComplianceFramework[]): void;

	/** Set the RTOS in use. */
	setRTOS(rtos: string | undefined): void;

	/** Set the build system. */
	setBuildSystem(buildSystem: string | undefined): void;

	/** Set detected project information. */
	setProjectInfo(info: IFirmwareProjectInfo): void;

	/** Store last serial port configuration for session restore. */
	setLastSerialConfig(config: ISerialPortConfig, connected: boolean): void;

	/** Store last build result for session persistence. */
	setLastBuildResult(result: IBuildResult): void;

	/** Set the platform skill ID (e.g. 'stm32', 'esp32'). */
	setPlatformId(platformId: string | undefined): void;

	/** Update debug session state. */
	setDebugState(state: IDebugSessionState): void;

	/** Touch the session activity timer. */
	touchActivity(): void;

	/** Get register map for a specific peripheral. */
	getPeripheralRegisterMap(peripheralName: string): IPeripheralRegisterMap | undefined;

	/** Get all peripheral names available in the session. */
	getPeripheralNames(): string[];

	/** Get errata entries for a specific peripheral. */
	getErrataForPeripheral(peripheralName: string): IErrata[];

	/** Get timing constraints for a specific peripheral. */
	getTimingForPeripheral(peripheralName: string): ITimingConstraint[];
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const SESSION_STORAGE_KEY = 'neuralInverseFirmware.session';

// ─── Implementation ───────────────────────────────────────────────────────────

class FirmwareSessionService extends Disposable implements IFirmwareSessionService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChangeSession = this._register(new Emitter<IFirmwareSessionData>());
	readonly onDidChangeSession: Event<IFirmwareSessionData> = this._onDidChangeSession.event;

	private _session: IFirmwareSessionData;

	get session(): IFirmwareSessionData { return this._session; }

	constructor(
		@IStorageService     private readonly storageService: IStorageService,
		@ISVDParserService   private readonly _svdParser: ISVDParserService,
	) {
		super();
		this._session = this._load();
	}

	startSession(mcuConfig: IMCUConfig, boardName?: string, projectUri?: string): void {
		this._mutate({
			...DEFAULT_FIRMWARE_SESSION,
			isActive: true,
			sessionId: this._generateId(),
			mcuConfig,
			boardName,
			projectUri,
			complianceFrameworks: ['misra-c-2012'],
			sessionStartedAt: Date.now(),
			lastActivityAt: Date.now(),
			platformId: this._detectPlatformId(mcuConfig),
		});

		// Auto-load bundled SVD for the detected MCU family
		const svdKey = lookupBundledSVDKey(mcuConfig.family);
		if (svdKey) {
			const xmlString = BUNDLED_SVD_XML[svdKey];
			if (xmlString) {
				try {
					const registerMaps = this._svdParser.parseToRegisterMaps(xmlString);
					if (registerMaps.length > 0) {
						this.addSVDFile(`bundled:${svdKey}`, registerMaps);
					}
				} catch {
					// bundled SVD parse failure is non-fatal
				}
			}
		}
	}

	endSession(): void {
		this._mutate({ ...DEFAULT_FIRMWARE_SESSION });
	}

	setMCUConfig(config: IMCUConfig): void {
		this._mutate({ ...this._session, mcuConfig: config });
	}

	setActivePeripheral(peripheral: string | undefined): void {
		this._mutate({ ...this._session, activePeripheral: peripheral });
	}

	addSVDFile(filePath: string, registerMaps: IPeripheralRegisterMap[]): void {
		const svdFiles = [...this._session.svdFiles, filePath];
		const existingMaps = this._session.registerMaps;

		// Merge register maps: SVD maps replace any existing maps for the same peripheral
		const mergedMaps = [...existingMaps];
		for (const newMap of registerMaps) {
			const existingIdx = mergedMaps.findIndex(m => m.name === newMap.name);
			if (existingIdx >= 0) {
				mergedMaps[existingIdx] = newMap;
			} else {
				mergedMaps.push(newMap);
			}
		}

		this._mutate({ ...this._session, svdFiles, registerMaps: mergedMaps });
	}

	addDatasheet(
		info: IDatasheetInfo,
		registerMaps: IPeripheralRegisterMap[],
		timingConstraints: ITimingConstraint[],
		errata: IErrata[],
	): void {
		const datasheets = [...this._session.datasheets, info];

		// Merge register maps (datasheet maps fill gaps; don't override SVD-sourced maps)
		const mergedMaps = [...this._session.registerMaps];
		for (const newMap of registerMaps) {
			if (!mergedMaps.find(m => m.name === newMap.name)) {
				mergedMaps.push(newMap);
			}
		}

		const mergedTiming = [...this._session.timingConstraints, ...timingConstraints];
		const mergedErrata = [...this._session.errata, ...errata];

		this._mutate({
			...this._session,
			datasheets,
			registerMaps: mergedMaps,
			timingConstraints: mergedTiming,
			errata: mergedErrata,
		});
	}

	removeDatasheet(datasheetId: string): void {
		this._mutate({
			...this._session,
			datasheets: this._session.datasheets.filter(d => d.id !== datasheetId),
		});
	}

	setComplianceFrameworks(frameworks: FirmwareComplianceFramework[]): void {
		this._mutate({ ...this._session, complianceFrameworks: frameworks });
	}

	setRTOS(rtos: string | undefined): void {
		this._mutate({ ...this._session, rtos });
	}

	setBuildSystem(buildSystem: string | undefined): void {
		this._mutate({ ...this._session, buildSystem });
	}

	getPeripheralRegisterMap(peripheralName: string): IPeripheralRegisterMap | undefined {
		return this._session.registerMaps.find(m =>
			m.name.toLowerCase() === peripheralName.toLowerCase() ||
			m.groupName.toLowerCase() === peripheralName.toLowerCase()
		);
	}

	getPeripheralNames(): string[] {
		return this._session.registerMaps.map(m => m.name);
	}

	getErrataForPeripheral(peripheralName: string): IErrata[] {
		return this._session.errata.filter(e =>
			e.affectedPeripheral.toLowerCase() === peripheralName.toLowerCase()
		);
	}

	getTimingForPeripheral(peripheralName: string): ITimingConstraint[] {
		return this._session.timingConstraints.filter(t =>
			t.peripheral.toLowerCase() === peripheralName.toLowerCase()
		);
	}

	setProjectInfo(info: IFirmwareProjectInfo): void {
		this._mutate({ ...this._session, projectInfo: info, lastActivityAt: Date.now() });
	}

	setLastSerialConfig(config: ISerialPortConfig, connected: boolean): void {
		this._mutate({ ...this._session, lastSerialConfig: config, serialWasConnected: connected, lastActivityAt: Date.now() });
	}

	setLastBuildResult(result: IBuildResult): void {
		this._mutate({ ...this._session, lastBuildResult: result, lastActivityAt: Date.now() });
	}

	setPlatformId(platformId: string | undefined): void {
		this._mutate({ ...this._session, platformId, lastActivityAt: Date.now() });
	}

	setDebugState(state: IDebugSessionState): void {
		this._mutate({ ...this._session, debugState: state, lastActivityAt: Date.now() });
	}

	touchActivity(): void {
		this._mutate({ ...this._session, lastActivityAt: Date.now() });
	}

	// ─── Private helpers ──────────────────────────────────────────────────────

	private _generateId(): string {
		return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
	}

	/**
	 * Auto-detect platform ID from MCU config for platform skill injection.
	 */
	private _detectPlatformId(mcuConfig: IMCUConfig): string | undefined {
		const family = mcuConfig.family.toLowerCase();
		const manufacturer = mcuConfig.manufacturer.toLowerCase();

		if (family.startsWith('stm32') || manufacturer.includes('stmicro')) return 'stm32';
		if (family.startsWith('esp') || manufacturer.includes('espressif')) return 'esp32';
		if (family.startsWith('nrf') || manufacturer.includes('nordic')) return 'nrf';
		if (family.startsWith('rp2') || manufacturer.includes('raspberry')) return 'rp2040';
		if (family.startsWith('sam') || manufacturer.includes('microchip') || manufacturer.includes('atmel')) return 'sam';
		if (family.startsWith('lpc') || family.startsWith('imx') || manufacturer.includes('nxp')) return 'nxp';
		if (family.startsWith('msp') || family.startsWith('tms') || manufacturer.includes('texas')) return 'ti';
		if (family.includes('aurix') || manufacturer.includes('infineon')) return 'aurix';
		if (manufacturer.includes('renesas')) return 'renesas';

		return undefined;
	}

	private _mutate(next: IFirmwareSessionData): void {
		this._session = next;
		// Persist — but only store a lightweight version (register maps can be large)
		const toStore: IFirmwareSessionData = {
			...next,
			// Don't persist full register maps — they are re-loaded from SVD/datasheets
			registerMaps: [],
			timingConstraints: [],
			errata: [],
		};
		this.storageService.store(SESSION_STORAGE_KEY, JSON.stringify(toStore), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._onDidChangeSession.fire(next);
	}

	private _load(): IFirmwareSessionData {
		const raw = this.storageService.get(SESSION_STORAGE_KEY, StorageScope.WORKSPACE);
		if (raw) {
			try {
				const parsed = JSON.parse(raw);
				return {
					isActive: parsed.isActive ?? false,
					sessionId: parsed.sessionId,
					mcuConfig: parsed.mcuConfig,
					boardName: parsed.boardName,
					projectUri: parsed.projectUri,
					svdFiles: parsed.svdFiles ?? [],
					datasheets: parsed.datasheets ?? [],
					complianceFrameworks: parsed.complianceFrameworks ?? [],
					registerMaps: parsed.registerMaps ?? [],
					timingConstraints: parsed.timingConstraints ?? [],
					errata: parsed.errata ?? [],
					activePeripheral: parsed.activePeripheral,
					rtos: parsed.rtos,
					buildSystem: parsed.buildSystem,
				};
			} catch { /* fall through to default */ }
		}
		return { ...DEFAULT_FIRMWARE_SESSION };
	}
}

registerSingleton(IFirmwareSessionService, FirmwareSessionService, InstantiationType.Delayed);
