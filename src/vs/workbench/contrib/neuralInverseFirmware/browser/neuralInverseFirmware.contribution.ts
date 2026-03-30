/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # NeuralInverse Firmware — Contribution
 *
 * Opens a dedicated auxiliary window (like Modernisation Mode) on Cmd+Alt+F.
 * The FirmwarePart IS the console — no sidebar.
 *
 * When a firmware session is active, context is automatically injected into
 * Void sidebar chat and Power Mode terminal system prompts.
 *
 * Registers all firmware services:
 *   - FirmwareSessionService (session state management)
 *   - MCUDatabaseService (MCU database search/lookup)
 *   - ProjectDetectorService (auto-detect firmware projects)
 *   - SVDParserService (SVD XML parser)
 *   - DatasheetIntelligenceService (PDF datasheet extraction)
 *   - FirmwareAgentToolService (fw_* agent tools)
 *   - BuildSystemService (build, flash, size analysis)
 *   - FirmwareLSPBridge (register completions, diagnostics)
 *   - SerialMonitorService (serial port communication)
 *   - FirmwareDebugService (GDB integration)
 *   - FirmwarePowerModeToolService (Power Mode tool bridge)
 *
 * Commands:
 *  neuralInverse.openFirmware              Cmd+Alt+F  — open / focus Firmware console
 *  neuralInverse.endFirmwareSession                   — end session (clears state)
 *  neuralInverse.scanFirmwareProject                  — scan workspace for firmware project
 */

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { FirmwarePart } from './ui/firmwarePart.js';
import { IFirmwareSessionService } from './firmwareSessionService.js';
import { IProjectDetectorService } from './projectDetectorService.js';
import { IMCUDatabaseService } from './mcuDatabaseService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { IDatasheetIntelligenceService } from './engine/datasheet/datasheetIntelligenceService.js';
import { ISVDParserService } from './engine/svd/svdParserService.js';

// Register DI singletons (side-effect imports)
// Phase 1: Core Intelligence
import './firmwareSessionService.js';
import './mcuDatabaseService.js';
import './projectDetectorService.js';
import './engine/svd/svdParserService.js';
import './engine/datasheet/datasheetKBService.js';
import './engine/datasheet/svdFetchService.js';
import './engine/datasheet/datasheetIntelligenceService.js';
import './engine/hardwareContext/hardwareContextProvider.js';
import './engine/agentTools/firmwareAgentToolService.js';

// Phase 2: Build System & Integration
import './engine/build/buildSystemService.js';
import './engine/lsp/firmwareLSPBridge.js';
import './engine/serial/serialMonitorService.js';

// Phase 3: Hardware-in-the-Loop
import './engine/debug/debugService.js';
import './engine/firmwarePowerModeTools.js';

// Infrastructure
import './voidFirmwareToolsContrib.js';
import './statusbar/firmwareStatus.contribution.js';

const FIRMWARE_WINDOW_TYPE = 'neuralInverseFirmware';
const FIRMWARE_STATE_KEY   = 'neuralInverseFirmware.windowState';

// ─── Window helper ────────────────────────────────────────────────────────────

async function openFirmwareWindow(
	auxWindowService: IAuxiliaryWindowService,
	hostService: IHostService,
	storageService: IStorageService,
	instantiationService: IInstantiationService,
): Promise<void> {
	const existing = auxWindowService.getWindowByType(FIRMWARE_WINDOW_TYPE);
	if (existing && !existing.window.closed) {
		hostService.focus(existing.window, { force: true });
		return;
	}

	const win = await auxWindowService.open({ type: FIRMWARE_WINDOW_TYPE, nativeTitlebar: false });
	const part = instantiationService.createInstance(FirmwarePart);
	part.create(win.container);

	const dim = win.window.document.body.getBoundingClientRect();
	part.layout(dim.width, dim.height, 0, 0);

	const store = new DisposableStore();
	store.add(part);
	store.add(win.onDidLayout(d => part.layout(d.width, d.height, 0, 0)));
	store.add(win.onUnload(() => {
		storageService.store(FIRMWARE_STATE_KEY, JSON.stringify({ isOpen: false }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		store.dispose();
	}));

	storageService.store(FIRMWARE_STATE_KEY, JSON.stringify({ isOpen: true }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	win.layout();
}

// ─── Contribution (restore window + auto-scan on reload) ──────────────────────

class FirmwareContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IAuxiliaryWindowService private readonly auxiliaryWindowService: IAuxiliaryWindowService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFirmwareSessionService private readonly _sessionService: IFirmwareSessionService,
		@IProjectDetectorService private readonly _projectDetector: IProjectDetectorService,
		@IMCUDatabaseService private readonly _mcuDbService: IMCUDatabaseService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IFileService private readonly _fileService: IFileService,
		@IDatasheetIntelligenceService private readonly _datasheetService: IDatasheetIntelligenceService,
		@ISVDParserService private readonly _svdParser: ISVDParserService,
	) {
		super();
		this._restoreWindow();
		this._autoScanProject();
		this._watchInverseFile();
	}

	private _restoreWindow(): void {
		const raw = this.storageService.get(FIRMWARE_STATE_KEY, StorageScope.WORKSPACE);
		if (!raw) { return; }
		try {
			if (!JSON.parse(raw).isOpen) { return; }
		} catch { return; }

		this.auxiliaryWindowService.open({ type: FIRMWARE_WINDOW_TYPE, nativeTitlebar: false }).then(win => {
			const part = this.instantiationService.createInstance(FirmwarePart);
			part.create(win.container);
			const store = new DisposableStore();
			store.add(part);
			store.add(win.onDidLayout(d => part.layout(d.width, d.height, 0, 0)));
			store.add(win.onUnload(() => {
				this.storageService.store(FIRMWARE_STATE_KEY, JSON.stringify({ isOpen: false }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
				store.dispose();
			}));
			win.layout();
		});
	}

	/**
	 * Auto-scan the workspace for firmware project indicators on startup.
	 * Firmware.inverse is checked first (confidence=1.0); heuristic scanners follow.
	 * If a firmware project is detected and no session is active, auto-start it.
	 */
	private async _autoScanProject(): Promise<void> {
		// Only auto-scan if no session is already active
		if (this._sessionService.session.isActive) { return; }

		try {
			const result = await this._projectDetector.scan();
			if (result && result.confidence >= 0.5 && result.mcuVariant) {
				// Look up the detected MCU in the database
				const dbEntry = this._mcuDbService.lookupVariant(result.mcuVariant)
					?? (result.mcuFamily ? this._mcuDbService.search(result.mcuFamily, 1)[0] : undefined);

				if (dbEntry) {
					const config = this._mcuDbService.toMCUConfig(dbEntry);
					this._sessionService.startSession(config, result.boardName, result.projectRoot);
					this._sessionService.setProjectInfo(result);

					if (result.rtos) { this._sessionService.setRTOS(result.rtos); }
					if (result.buildSystem) { this._sessionService.setBuildSystem(result.buildSystem); }

					// ── Firmware.inverse extras ───────────────────────────────
					// Apply compliance frameworks declared in the manifest
					if (result.complianceFrameworks && result.complianceFrameworks.length > 0) {
						this._sessionService.setComplianceFrameworks(result.complianceFrameworks);
					}

					// Auto-load SVD files listed in the manifest
					for (const svdPath of result.svdFilePaths) {
						this._loadSVDAsync(svdPath);
					}

					// Auto-load PDF datasheets listed in the manifest
					if (result.datasheetPaths && result.datasheetPaths.length > 0) {
						const family = result.mcuFamily ?? result.mcuVariant ?? 'Unknown';
						for (const pdfPath of result.datasheetPaths) {
							this._loadDatasheetAsync(pdfPath, family);
						}
					}
				}
			}
		} catch {
			// Silent failure — auto-scan is best-effort
		}
	}

	/**
	 * Watch for `Firmware.inverse` appearing or changing in workspace roots.
	 * When detected, trigger a re-scan so session activates/updates immediately.
	 * Mirrors the .inverse file watcher in ModernisationSessionService.
	 */
	private _watchInverseFile(): void {
		// File service doesn't expose a simple glob watcher in the extension host
		// pattern, so we poll by re-scanning on workspace folder changes.
		this._register(this._workspace.onDidChangeWorkspaceFolders(() => {
			if (!this._sessionService.session.isActive) {
				this._autoScanProject();
			}
		}));
	}

	/** Background SVD load — fire and forget, errors are silent. */
	private async _loadSVDAsync(svdPath: string): Promise<void> {
		try {
			const fileUri = URI.file(svdPath);
			const content = await this._fileService.readFile(fileUri);
			const svdXml = content.value.toString();
			const registerMaps = this._svdParser.parseToRegisterMaps(svdXml);
			this._sessionService.addSVDFile(svdPath, registerMaps);
		} catch {
			// SVD load is best-effort — bundled SVDs will be used as fallback
		}
	}

	/** Background PDF datasheet load — fire and forget, errors are silent. */
	private async _loadDatasheetAsync(pdfPath: string, mcuFamily: string): Promise<void> {
		try {
			const result = await this._datasheetService.extractFromPDF(pdfPath, mcuFamily);
			this._sessionService.addDatasheet(
				result.info,
				result.registerMaps,
				result.timingConstraints,
				result.errata,
			);
		} catch {
			// Datasheet load is best-effort
		}
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(FirmwareContribution, LifecyclePhase.Restored);

// ─── Commands ────────────────────────────────────────────────────────────────

/** Cmd+Alt+F — open / focus the Firmware console window */
registerAction2(class OpenFirmwareAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.openFirmware',
			title: localize2('neuralInverse.openFirmware', 'Neural Inverse: Open Firmware Environment'),
			f1: true,
			keybinding: {
				weight: 200,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyF,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await openFirmwareWindow(
			accessor.get(IAuxiliaryWindowService),
			accessor.get(IHostService),
			accessor.get(IStorageService),
			accessor.get(IInstantiationService),
		);
	}
});

/**
 * Focus (or open) the Firmware console window.
 * Used by statusbar entries as their click target.
 */
registerAction2(class FocusFirmwareAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.focusFirmware',
			title: localize2('neuralInverse.focusFirmware', 'Neural Inverse: Focus Firmware Console'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await openFirmwareWindow(
			accessor.get(IAuxiliaryWindowService),
			accessor.get(IHostService),
			accessor.get(IStorageService),
			accessor.get(IInstantiationService),
		);
	}
});

/** End the session — clears all state, hides statusbar item */
registerAction2(class EndFirmwareSessionAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.endFirmwareSession',
			title: localize2('neuralInverse.endFirmwareSession', 'Neural Inverse: End Firmware Session'),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IFirmwareSessionService).endSession();
	}
});

/** Scan workspace for firmware project indicators */
registerAction2(class ScanFirmwareProjectAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.scanFirmwareProject',
			title: localize2('neuralInverse.scanFirmwareProject', 'Neural Inverse: Scan for Firmware Project'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const detector = accessor.get(IProjectDetectorService);
		await detector.scan();
	}
});

/**
 * Create a `Firmware.inverse` file in the first workspace root folder.
 * Pre-fills from the active firmware session if one exists.
 * Mirrors the "Modernisation.inverse" project pairing pattern.
 */
registerAction2(class CreateFirmwareInverseAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.createFirmwareInverse',
			title: localize2('neuralInverse.createFirmwareInverse', 'Neural Inverse: Create Firmware.inverse Project File'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const fileService = accessor.get(IFileService);
		const workspaceService = accessor.get(IWorkspaceContextService);
		const sessionService = accessor.get(IFirmwareSessionService);

		const folders = workspaceService.getWorkspace().folders;
		if (folders.length === 0) { return; }

		const session = sessionService.session;
		const mcuVariant = session.mcuConfig?.variant ?? 'STM32F407VGT6';

		const manifest = {
			neuralInverseFirmware: true,
			version: '1' as const,
			mcu: mcuVariant,
			...(session.boardName ? { board: session.boardName } : {}),
			...(session.rtos ? { rtos: session.rtos } : {}),
			...(session.buildSystem ? { buildSystem: session.buildSystem } : {}),
			...(session.complianceFrameworks?.length ? { compliance: session.complianceFrameworks } : {}),
			datasheets: [],
			svd: '',
			createdAt: Date.now(),
		};

		const { VSBuffer } = await import('../../../../base/common/buffer.js');
		const content = JSON.stringify(manifest, null, '\t');
		const fileUri = URI.joinPath(folders[0].uri, FIRMWARE_INVERSE_FILENAME_CMD);
		await fileService.writeFile(fileUri, VSBuffer.fromString(content));
	}
});

// Constant for command (avoids import in class scope)
const FIRMWARE_INVERSE_FILENAME_CMD = 'Firmware.inverse';
