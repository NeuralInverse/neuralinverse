/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * FirmwarePart — Production UI
 *
 * Dedicated auxiliary window console for the Neural Inverse Firmware Environment.
 * Opened via Cmd+Alt+F. Fully standalone — no sidebar.
 * Inherits the active VS Code colour theme via CSS custom properties.
 *
 * Screens:
 *  IDLE    — Welcome screen with MCU search, auto-scan, and feature showcase.
 *  ACTIVE  — Top bar + 6-tab environment: Dashboard / Datasheets / Registers / Serial / Compliance / Build
 *
 * Design language mirrors neuralInverseModernisation/browser/ui/modernisationPart.ts:
 *   - $e / $t DOM helpers (Trusted Types compliant, no innerHTML)
 *   - CSS custom properties only — zero hardcoded hex colours
 *   - VS Code structural backgrounds (editor, sideBar, sideBarSectionHeader)
 *   - 36px top bar, 36px tab bar — identical to Modernisation console
 */

import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Part } from '../../../../browser/part.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IFirmwareSessionService } from '../firmwareSessionService.js';
import { IMCUDatabaseService } from '../mcuDatabaseService.js';
import { ISerialMonitorService } from '../engine/serial/serialMonitorService.js';
import { IDatasheetIntelligenceService } from '../engine/datasheet/datasheetIntelligenceService.js';
import { IDatasheetKBService } from '../engine/datasheet/datasheetKBService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IVoidSettingsService } from '../../../void/common/voidSettingsService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { URI } from '../../../../../base/common/uri.js';
import { ISvdFetchService } from '../engine/datasheet/svdFetchService.js';
import { IPeripheralRegisterMap, COMMON_BAUD_RATES, FirmwareComplianceFramework, IFirmwareSessionData, IBuildResult, IMCUConfig } from '../../common/firmwareTypes.js';
import { IPinMuxService } from '../engine/pinMux/service.js';
import { IClockTreeService } from '../engine/clockTree/service.js';
import { IMemoryLayoutService } from '../engine/memory/service.js';
import { IPeripheralDependencyService } from '../engine/dependencies/service.js';
import { IRegisterCompositorService } from '../engine/registerCompositor/service.js';
import { ILogicAnalyzerService } from '../engine/instruments/logicAnalyzer/logicAnalyzerService.js';
import { IPowerAnalyzerService } from '../engine/instruments/powerAnalyzer/powerAnalyzerService.js';
import { IOscilloscopeService } from '../engine/instruments/oscilloscope/oscilloscopeService.js';
import { ISchematicService } from '../engine/schematic/schematicService.js';
type ISchematicPin = NonNullable<ReturnType<ISchematicService['getPinoutMap']>>['pins'][number];
import { ICheckpointService } from '../engine/projectConfig/checkpointService.js';
import { INIMdService } from '../engine/projectConfig/niMdService.js';
import {
	IBuildSystemService, IFlashResult, IBinarySizeAnalysis,
	IStackUsageReport, IElfSymbol, IBuildOutputLine,
} from '../engine/build/buildSystemService.js';
import { IRTOSDebugService } from '../engine/rtos/rtosDebugService.js';
import { IRTOSSnapshot } from '../engine/rtos/rtosTypes.js';
import { IHILTestService } from '../engine/hil/hilTestService.js';
import { IHILTestResult, IHILSuiteResult } from '../engine/hil/hilTypes.js';
import { IClosedLoopService } from '../engine/closedLoop/closedLoopService.js';
import { IClosedLoopIteration, ClosedLoopPhase } from '../engine/closedLoop/closedLoopTypes.js';
import { ICoordinatedCaptureService } from '../engine/instruments/coordinatedCaptureService.js';
import { IErrataService } from '../engine/errata/errataService.js';
import { IProjectDetectorService } from '../projectDetectorService.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';


// ─── DOM helpers (no innerHTML — Trusted Types compliant) ─────────────────────

/** HTML tags that are safe to use with textContent / appendChild — excludes 'script'. */
type SafeHTMLTag = Exclude<keyof HTMLElementTagNameMap, 'script'>;

function $e<K extends SafeHTMLTag>(tag: K, css?: string): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	if (css) { el.style.cssText = css; }
	return el;
}

function $t<K extends SafeHTMLTag>(tag: K, text: string, css?: string): HTMLElementTagNameMap[K] {
	const el = $e(tag, css);
	el.textContent = text;
	return el;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FIRMWARE_PART_ID = 'workbench.parts.neuralInverseFirmware';

type TabId = 'dashboard' | 'pinout' | 'architecture' | 'datasheets' | 'registers' | 'serial' | 'compliance' | 'build' | 'hw-tools' | 'instruments' | 'rtos' | 'hil' | 'closed-loop';

const TABS: Array<{ id: TabId; label: string }> = [
	{ id: 'dashboard',   label: 'Dashboard' },
	{ id: 'pinout',      label: 'Pinout' },
	{ id: 'architecture',label: 'Architecture' },
	{ id: 'hw-tools',    label: 'HW Tools' },
	{ id: 'instruments', label: 'Instruments' },
	{ id: 'datasheets',  label: 'Datasheets' },
	{ id: 'registers',   label: 'Registers' },
	{ id: 'serial',      label: 'Serial' },
	{ id: 'compliance',  label: 'Compliance' },
	{ id: 'build',       label: 'Build' },
	{ id: 'rtos',        label: 'RTOS' },
	{ id: 'hil',         label: 'HIL Tests' },
	{ id: 'closed-loop', label: 'Auto Loop' },
];

// ─── Part ─────────────────────────────────────────────────────────────────────

export class FirmwarePart extends Part {

	static readonly ID = FIRMWARE_PART_ID;

	minimumWidth = 740;
	maximumWidth = Infinity;
	minimumHeight = 480;
	maximumHeight = Infinity;

	override toJSON(): object { return { id: FIRMWARE_PART_ID }; }

	private readonly _disposables = new DisposableStore();

	private _root!: HTMLElement;
	private _activeTab: TabId = 'dashboard';
	private _tabButtons = new Map<TabId, HTMLButtonElement>();

	// Datasheet extraction live progress
	private _extractionProgress: {
		status: string; fileName: string;
		totalPages: number; processedPages: number;
		registers: number; timing: number; errata: number;
	} | null = null;

	// Serial UI — live output node (no local state; service is the source of truth)
	private _serialOutputEl: HTMLElement | undefined;
	private _serialInputEl: HTMLInputElement | undefined;

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IFirmwareSessionService private readonly _session: IFirmwareSessionService,
		@IMCUDatabaseService private readonly _mcuDb: IMCUDatabaseService,
		@ISerialMonitorService private readonly _serialSvc: ISerialMonitorService,
		@IDatasheetIntelligenceService private readonly _dsSvc: IDatasheetIntelligenceService,
		@IDatasheetKBService private readonly _kbSvc: IDatasheetKBService,
		@IFileDialogService private readonly _dialogs: IFileDialogService,
		@INotificationService private readonly _notify: INotificationService,
		@IVoidSettingsService private readonly _voidSettings: IVoidSettingsService,
		@IFileService private readonly _fileService: IFileService,
		@ISvdFetchService private readonly _svdFetch: ISvdFetchService,
		@IPinMuxService private readonly _pinMuxSvc: IPinMuxService,
		@IClockTreeService private readonly _clockTreeSvc: IClockTreeService,
		@IMemoryLayoutService private readonly _memoryLayoutSvc: IMemoryLayoutService,
		@IPeripheralDependencyService private readonly _depSvc: IPeripheralDependencyService,
		@IRegisterCompositorService private readonly _regCompositorSvc: IRegisterCompositorService,
		@ILogicAnalyzerService private readonly _laSvc: ILogicAnalyzerService,
		@IPowerAnalyzerService private readonly _paSvc: IPowerAnalyzerService,
		@IOscilloscopeService private readonly _scopeSvc: IOscilloscopeService,
		@ISchematicService private readonly _schematicSvc: ISchematicService,
		@ICheckpointService private readonly _checkpointSvc: ICheckpointService,
		@INIMdService private readonly _niMdSvc: INIMdService,
		@IRTOSDebugService private readonly _rtosSvc: IRTOSDebugService,
		@IHILTestService private readonly _hilSvc: IHILTestService,
		@IClosedLoopService private readonly _closedLoopSvc: IClosedLoopService,
		@ICoordinatedCaptureService private readonly _coordCaptureSvc: ICoordinatedCaptureService,
		@IErrataService private readonly _errataSvc: IErrataService,
		@IBuildSystemService private readonly _buildSvc: IBuildSystemService,
		@IProjectDetectorService private readonly _projectDetector: IProjectDetectorService,
		@IWorkspaceContextService private readonly _workspaceCtx: IWorkspaceContextService,
		@IDialogService private readonly _dialogSvc: IDialogService,
	) {
		super(FIRMWARE_PART_ID, { hasTitle: false }, themeService, storageService, layoutService);
		void this._schematicSvc;
		void this._niMdSvc;
		void this._coordCaptureSvc;
		void this._errataSvc;
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this._root = $e('div', [
			'display:flex', 'flex-direction:column',
			'width:100%', 'height:100%', 'overflow:hidden',
			'background:var(--vscode-editor-background)',
			'color:var(--vscode-editor-foreground)',
			'font-family:var(--vscode-font-family,system-ui,sans-serif)',
			'font-size:13px',
		].join(';'));
		parent.appendChild(this._root);
		this._render();

		this._disposables.add(this._session.onDidChangeSession(() => this._render()));

		// Live-append serial RX lines without full re-render
		this._disposables.add(this._serialSvc.onDataReceived(line => {
			if (this._activeTab !== 'serial' || !this._serialOutputEl) { return; }
			this._appendSerialLine(this._serialOutputEl, line.text, 'rx', line.timestamp);
			this._serialOutputEl.scrollTop = this._serialOutputEl.scrollHeight;
		}));
		this._disposables.add(this._serialSvc.onDataTransmitted(line => {
			if (this._activeTab !== 'serial' || !this._serialOutputEl) { return; }
			this._appendSerialLine(this._serialOutputEl, line.text, 'tx', line.timestamp);
			this._serialOutputEl.scrollTop = this._serialOutputEl.scrollHeight;
		}));
		// Re-render serial toolbar on connection state change
		this._disposables.add(this._serialSvc.onConnectionChanged(() => {
			if (this._activeTab === 'serial') { this._render(); }
		}));

		// ── Real-time datasheet extraction progress ───────────────────────
		this._disposables.add(this._dsSvc.onProgress(p => {
			if (p.status === 'complete' || p.status === 'error') {
				this._extractionProgress = null;
			} else {
				this._extractionProgress = {
					status: p.status,
					fileName: p.fileName ?? '',
					totalPages: p.totalPages,
					processedPages: p.processedPages,
					registers: p.registersExtracted,
					timing: p.timingValuesExtracted,
					errata: p.errataExtracted,
				};
			}
			// Always re-render the Datasheets tab if it's active
			if (this._activeTab === 'datasheets') { this._render(); }
		}));

		return parent;
	}

	override layout(width: number, height: number, top: number, left: number): void {
		if (this._root) {
			this._root.style.width = `${width}px`;
			this._root.style.height = `${height}px`;
		}
		super.layout(width, height, top, left);
	}

	override dispose(): void {
		this._disposables.dispose();
		super.dispose();
	}


	// ─── Master Renderer ─────────────────────────────────────────────────────

	private _render(): void {
		while (this._root.firstChild) { this._root.removeChild(this._root.firstChild); }

		const session = this._session.session;

		this._root.appendChild(this._buildTopBar(session.isActive));

		if (session.isActive) {
			this._root.appendChild(this._buildTabBar());
			const body = $e('div', 'flex:1;overflow:hidden;display:flex;flex-direction:column;');
			this._root.appendChild(body);
			this._renderActiveTab(body);
		} else {
			const body = $e('div', 'flex:1;overflow:hidden;display:flex;flex-direction:column;');
			this._root.appendChild(body);
			this._renderIdle(body);
		}
	}


	// ─── Top Bar ─────────────────────────────────────────────────────────────

	private _buildTopBar(isActive: boolean): HTMLElement {
		const bar = $e('div', [
			'display:flex', 'align-items:center', 'gap:10px',
			'height:36px', 'min-height:36px', 'padding:0 16px',
			'background:var(--vscode-titleBar-activeBackground,var(--vscode-sideBarSectionHeader-background))',
			'border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
			'flex-shrink:0',
		].join(';'));

		// Brand
		const brand = $e('span', [
			'color:var(--vscode-titleBar-activeForeground,var(--vscode-foreground))',
			'font-weight:700', 'font-size:12px', 'letter-spacing:0.04em', 'flex:1',
			'display:inline-flex', 'align-items:center', 'gap:6px',
		].join(';'));
		const brandIcon = $e('span', 'font-size:14px;');
		brandIcon.classList.add('codicon', 'codicon-circuit-board');
		brand.appendChild(brandIcon);
		brand.appendChild(document.createTextNode('Neural Inverse  \u00b7  Firmware Console'));
		bar.appendChild(brand);

		if (isActive) {
			const s = this._session.session;

			// MCU badge
			if (s.mcuConfig) {
				bar.appendChild($t('span', `${s.mcuConfig.family} ${s.mcuConfig.variant}`, [
					'font-size:11px', 'font-weight:600',
					'background:var(--vscode-badge-background)',
					'color:var(--vscode-badge-foreground)',
					'border-radius:3px', 'padding:2px 8px', 'letter-spacing:0.03em',
				].join(';')));
			}

			// RTOS badge
			if (s.rtos) {
				bar.appendChild($t('span', s.rtos, [
					'font-size:10px', 'color:var(--vscode-descriptionForeground)',
					'border:1px solid var(--vscode-widget-border)',
					'border-radius:3px', 'padding:1px 7px',
				].join(';')));
			}

			// Build system badge
			if (s.buildSystem) {
				bar.appendChild($t('span', s.buildSystem, [
					'font-size:10px', 'color:var(--vscode-descriptionForeground)',
					'border:1px solid var(--vscode-widget-border)',
					'border-radius:3px', 'padding:1px 7px',
				].join(';')));
			}

			bar.appendChild(this._btn('End Session', false, () => {
				this._dialogSvc.confirm({
					message: 'End firmware session?',
					detail: 'The session state will be cleared. Your Firmware.inverse project file (if present) will be preserved on disk.',
					primaryButton: 'End Session',
				}).then(r => {
					if (r.confirmed) { this._session.endSession(); }
				});
			}, 'font-size:11px;padding:3px 10px;'));
		}

		bar.appendChild($t('span', 'Cmd+Alt+F', 'color:var(--vscode-descriptionForeground);font-size:10px;opacity:0.5;'));

		return bar;
	}


	// ─── Tab Bar ─────────────────────────────────────────────────────────────

	private _buildTabBar(): HTMLElement {
		const bar = $e('div', [
			'display:flex', 'flex-shrink:0',
			'border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
			'background:var(--vscode-editor-background)',
			'padding-left:4px',
		].join(';'));

		this._tabButtons.clear();

		for (const tab of TABS) {
			const btn = $t('button', tab.label, this._tabCss(tab.id === this._activeTab));
			btn.addEventListener('click', () => this._switchTab(tab.id));
			btn.addEventListener('mouseenter', () => {
				if (tab.id !== this._activeTab) { btn.style.opacity = '0.9'; btn.style.background = 'var(--vscode-toolbar-hoverBackground)'; }
			});
			btn.addEventListener('mouseleave', () => {
				if (tab.id !== this._activeTab) { btn.style.opacity = '0.55'; btn.style.background = 'transparent'; }
			});
			this._tabButtons.set(tab.id, btn as HTMLButtonElement);
			bar.appendChild(btn);
		}

		return bar;
	}

	private _tabCss(active: boolean): string {
		return [
			'padding:0 16px', 'height:36px', 'border:none', 'background:transparent',
			'color:var(--vscode-foreground)', 'cursor:pointer', 'font-family:inherit',
			'font-size:12px', 'font-weight:' + (active ? '600' : '400'),
			'opacity:' + (active ? '1' : '0.55'),
			'border-bottom:2px solid ' + (active ? 'var(--vscode-focusBorder)' : 'transparent'),
			'transition:opacity 0.12s,border-color 0.12s,background 0.1s',
			'letter-spacing:0.02em',
		].join(';');
	}

	private _switchTab(id: TabId): void {
		if (id === this._activeTab) { return; }
		this._activeTab = id;
		this._render();
	}


	// ─── IDLE Screen ─────────────────────────────────────────────────────────

	private _idleScanning = false;
	private _idleScanDone = false;
	private _idleInverse: { mcu: string; board?: string; rtos?: string; buildSystem?: string; compliance?: string[] } | null = null;
	private _idleSearchQuery = '';
	private _idleSelectedMcu: string | null = null;
	private _idleToolchain = 'Auto-detect';
	private _idleRtos = 'Bare Metal';
	private _idleCompliance: string[] = [];

	private _hasWorkspace(): boolean {
		return this._workspaceCtx.getWorkspace().folders.length > 0;
	}

	private _renderIdle(root: HTMLElement): void {
		// ── Kick off background scan (once) ───────────────────────────────
		if (!this._idleScanning && !this._idleInverse && !this._idleScanDone) {
			this._idleScanDone = true;
			this._loadInverseFile();
		}

		// ── Auto-start if .inverse detected ───────────────────────────────
		if (this._idleInverse && this._hasWorkspace()) {
			const inv = this._idleInverse;
			const entry = this._mcuDb.lookupVariant(inv.mcu) ?? this._mcuDb.search(inv.mcu, 1)[0];
			if (entry) {
				const cfg = this._mcuDb.toMCUConfig(entry);
				this._session.startSession(cfg, inv.board);
				if (inv.buildSystem) { this._session.setBuildSystem(inv.buildSystem); }
				if (inv.rtos) { this._session.setRTOS(inv.rtos); }
				if (inv.compliance && inv.compliance.length) { this._session.setComplianceFrameworks(inv.compliance as FirmwareComplianceFramework[]); }
				return;
			}
		}

		// ── MCU selector (only shows when no auto-detect) ─────────────────
		const wrap = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;');
		let activeFilter = '';

		// Search + filter bar
		const searchBar = $e('div', 'padding:10px 16px 0 16px;');
		const searchRow = $e('div', 'display:flex;align-items:center;gap:8px;');
		const searchIcon = $e('span', 'font-size:14px;color:var(--vscode-descriptionForeground);');
		searchIcon.classList.add('codicon', 'codicon-search');
		searchRow.appendChild(searchIcon);
		const mcuInput = $e('input', [
			'flex:1', 'height:28px', 'padding:0 8px',
			'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
			'border-radius:4px',
			'background:var(--vscode-input-background)',
			'color:var(--vscode-input-foreground)',
			'font-size:12px', 'font-family:inherit', 'outline:none', 'box-sizing:border-box',
		].join(';')) as HTMLInputElement;
		mcuInput.placeholder = 'Filter MCU...';
		mcuInput.value = this._idleSearchQuery;
		mcuInput.addEventListener('focus', () => { mcuInput.style.borderColor = 'var(--vscode-focusBorder)'; });
		mcuInput.addEventListener('blur', () => { mcuInput.style.borderColor = 'var(--vscode-input-border,var(--vscode-widget-border))'; });
		mcuInput.addEventListener('input', () => {
			this._idleSearchQuery = mcuInput.value;
			this._idleSelectedMcu = null;
			renderList(mcuInput.value, activeFilter);
		});
		searchRow.appendChild(mcuInput);
		searchBar.appendChild(searchRow);

		// Manufacturer filter tabs
		const filters = ['All', 'ST', 'Nordic', 'Espressif', 'Raspberry Pi', 'NXP', 'Microchip', 'TI', 'Renesas'];
		const filterRow = $e('div', 'display:flex;gap:2px;padding:8px 0 10px 0;overflow-x:auto;');
		const filterBtns: HTMLButtonElement[] = [];
		for (const f of filters) {
			const fb = $e('button', [
				'border:none', 'padding:3px 10px', 'border-radius:3px',
				'font-size:10px', 'font-family:inherit', 'cursor:pointer', 'white-space:nowrap',
				'transition:background 0.1s,color 0.1s',
				f === 'All'
					? 'background:var(--vscode-button-background);color:var(--vscode-button-foreground);'
					: 'background:transparent;color:var(--vscode-descriptionForeground);',
			].join(';')) as HTMLButtonElement;
			fb.textContent = f;
			fb.addEventListener('click', () => {
				activeFilter = f === 'All' ? '' : f;
				for (const b of filterBtns) {
					b.style.background = 'transparent';
					b.style.color = 'var(--vscode-descriptionForeground)';
				}
				fb.style.background = 'var(--vscode-button-background)';
				fb.style.color = 'var(--vscode-button-foreground)';
				renderList(this._idleSearchQuery, activeFilter);
			});
			fb.addEventListener('mouseenter', () => { if (fb.style.background === 'transparent') { fb.style.background = 'var(--vscode-toolbar-hoverBackground)'; } });
			fb.addEventListener('mouseleave', () => { if (fb.style.color !== 'var(--vscode-button-foreground)') { fb.style.background = 'transparent'; } });
			filterBtns.push(fb);
			filterRow.appendChild(fb);
		}
		searchBar.appendChild(filterRow);
		wrap.appendChild(searchBar);

		// Separator
		wrap.appendChild($e('div', 'height:1px;background:var(--vscode-widget-border);'));

		// Results list
		const list = $e('div', 'flex:1;overflow-y:auto;padding:4px 0;');
		const renderList = (q: string, mfgFilter: string) => {
			while (list.firstChild) { list.removeChild(list.firstChild); }
			const searchTerm = mfgFilter ? (q ? `${mfgFilter} ${q}` : mfgFilter) : (q || 'STM32');
			const hits = this._mcuDb.search(searchTerm, 40);
			if (hits.length === 0) {
				list.appendChild($t('div', 'No results', 'padding:20px;text-align:center;font-size:12px;color:var(--vscode-descriptionForeground);'));
				return;
			}
			for (const h of hits) {
				const row = $e('div', 'display:flex;align-items:center;gap:8px;padding:6px 16px;cursor:pointer;font-size:12px;transition:background 0.06s;');
				// Chip icon
				const chipIcon = $e('span', 'font-size:13px;color:var(--vscode-descriptionForeground);width:16px;text-align:center;');
				chipIcon.classList.add('codicon', 'codicon-circuit-board');
				row.appendChild(chipIcon);
				// Variant name
				row.appendChild($t('span', h.variant, 'font-weight:600;min-width:140px;'));
				// Core badge
				row.appendChild($t('span', h.core.toUpperCase(), 'font-size:9px;padding:1px 5px;border-radius:3px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);'));
				// Specs
				row.appendChild($t('span', `${h.clockMHz} MHz`, 'color:var(--vscode-descriptionForeground);font-size:11px;'));
				row.appendChild($t('span', _fmt(h.flashSize) + ' flash', 'color:var(--vscode-descriptionForeground);font-size:11px;'));
				row.appendChild($t('span', _fmt(h.ramSize) + ' RAM', 'color:var(--vscode-descriptionForeground);font-size:11px;'));
				row.appendChild($e('div', 'flex:1;'));
				// Manufacturer
				row.appendChild($t('span', h.manufacturer, 'color:var(--vscode-descriptionForeground);font-size:10px;text-transform:uppercase;letter-spacing:0.03em;'));
				row.addEventListener('mouseenter', () => { row.style.background = 'var(--vscode-list-hoverBackground)'; });
				row.addEventListener('mouseleave', () => { row.style.background = ''; });
				row.addEventListener('click', () => {
					this._idleSelectedMcu = h.variant;
					this._idleSearchQuery = h.variant;
					const cfg = this._mcuDb.toMCUConfig(h);
					this._session.startSession(cfg);
					if (this._idleToolchain !== 'Auto-detect') { this._session.setBuildSystem(this._idleToolchain); }
					if (this._idleRtos !== 'Bare Metal') { this._session.setRTOS(this._idleRtos); }
					if (this._idleCompliance.length > 0) { this._session.setComplianceFrameworks(this._idleCompliance as FirmwareComplianceFramework[]); }
				});
				list.appendChild(row);
			}
		};
		renderList(this._idleSearchQuery, activeFilter);
		wrap.appendChild(list);

		// Config bar
		const configBar = $e('div', 'padding:8px 16px;border-top:1px solid var(--vscode-widget-border);display:flex;align-items:center;gap:10px;flex-wrap:wrap;');

		// Build system
		const buildSel = this._select(['Auto-detect', 'CMake', 'Make', 'PlatformIO', 'ESP-IDF', 'Zephyr', 'Cargo', 'Arduino', 'STM32CubeIDE', 'Mbed']);
		buildSel.style.cssText = 'height:24px;font-size:11px;padding:0 6px;';
		buildSel.value = this._idleToolchain;
		buildSel.addEventListener('change', () => { this._idleToolchain = buildSel.value; });
		configBar.appendChild(buildSel);

		// RTOS
		const rtosSel = this._select(['Bare Metal', 'FreeRTOS', 'Zephyr', 'ThreadX', 'RIOT', 'ChibiOS', 'NuttX', 'Embassy']);
		rtosSel.style.cssText = 'height:24px;font-size:11px;padding:0 6px;';
		rtosSel.value = this._idleRtos;
		rtosSel.addEventListener('change', () => { this._idleRtos = rtosSel.value; });
		configBar.appendChild(rtosSel);

		// Compliance (multi-select as chips)
		const compBtn = $e('button', [
			'border:1px solid var(--vscode-widget-border)', 'background:transparent',
			'color:var(--vscode-foreground)', 'padding:2px 8px', 'border-radius:3px',
			'font-size:11px', 'font-family:inherit', 'cursor:pointer', 'height:24px',
		].join(';')) as HTMLButtonElement;
		compBtn.textContent = this._idleCompliance.length > 0
			? this._idleCompliance.length + ' standard' + (this._idleCompliance.length > 1 ? 's' : '')
			: 'Compliance';
		const compMenu = $e('div', [
			'position:absolute', 'bottom:100%', 'left:0', 'margin-bottom:4px',
			'background:var(--vscode-editorWidget-background,var(--vscode-editor-background))',
			'border:1px solid var(--vscode-widget-border)', 'border-radius:4px',
			'padding:4px 0', 'display:none', 'min-width:140px', 'z-index:100',
			'box-shadow:0 2px 6px rgba(0,0,0,0.25)',
		].join(';'));
		const compIds = ['misra-c-2012', 'misra-c-2023', 'cert-c', 'iec-62304', 'iso-26262', 'do-178c', 'iec-61508', 'autosar'];
		const compLabels = ['MISRA C:2012', 'MISRA C:2023', 'CERT C', 'IEC 62304', 'ISO 26262', 'DO-178C', 'IEC 61508', 'AUTOSAR'];
		for (let i = 0; i < compIds.length; i++) {
			const cid = compIds[i];
			const item = $e('div', 'padding:4px 10px;font-size:11px;cursor:pointer;display:flex;align-items:center;gap:6px;');
			const chk = $e('span', 'width:12px;font-size:11px;');
			chk.textContent = this._idleCompliance.includes(cid) ? '✓' : ' ';
			item.appendChild(chk);
			item.appendChild($t('span', compLabels[i], ''));
			item.addEventListener('mousedown', (e) => { e.preventDefault(); });
			item.addEventListener('mouseenter', () => { item.style.background = 'var(--vscode-list-hoverBackground)'; });
			item.addEventListener('mouseleave', () => { item.style.background = ''; });
			item.addEventListener('click', () => {
				if (this._idleCompliance.includes(cid)) {
					this._idleCompliance = this._idleCompliance.filter(c => c !== cid);
				} else {
					this._idleCompliance = [...this._idleCompliance, cid];
				}
				chk.textContent = this._idleCompliance.includes(cid) ? '✓' : ' ';
				compBtn.textContent = this._idleCompliance.length > 0
					? this._idleCompliance.length + ' standard' + (this._idleCompliance.length > 1 ? 's' : '')
					: 'Compliance';
			});
			compMenu.appendChild(item);
		}
		const compWrap = $e('div', 'position:relative;');
		compWrap.appendChild(compMenu);
		compBtn.addEventListener('click', () => { compMenu.style.display = compMenu.style.display === 'none' ? 'block' : 'none'; });
		compBtn.addEventListener('blur', () => { setTimeout(() => { compMenu.style.display = 'none'; }, 120); });
		compWrap.appendChild(compBtn);
		configBar.appendChild(compWrap);

		// Spacer + info
		configBar.appendChild($e('div', 'flex:1;'));
		const info = $e('span', 'font-size:10px;color:var(--vscode-descriptionForeground);');
		const infoParts: string[] = [`${this._mcuDb.count} targets`];
		if (this._idleScanning) { infoParts.push('scanning...'); }
		if (!this._hasWorkspace()) { infoParts.push('no folder open'); }
		info.textContent = infoParts.join(' \xb7 ');
		configBar.appendChild(info);

		wrap.appendChild(configBar);

		root.appendChild(wrap);
		setTimeout(() => mcuInput.focus(), 50);
	}

	private async _loadInverseFile(): Promise<void> {
		try {
			const det = this._projectDetector.lastResult;
			if (det && det.projectType === 'firmware-inverse' && det.mcuVariant) {
				this._idleInverse = {
					mcu: det.mcuVariant,
					board: det.boardName,
					rtos: det.rtos,
					buildSystem: det.buildSystem,
					compliance: det.complianceFrameworks,
				};
				this._render();
				return;
			}
			this._runIdleScan();
		} catch { /* best-effort */ }
	}

	private async _runIdleScan(): Promise<void> {
		this._idleScanning = true;
		try {
			const result = await this._projectDetector.scan();
			if (result && result.confidence >= 0.5 && result.mcuVariant) {
				this._idleInverse = {
					mcu: result.mcuVariant,
					board: result.boardName,
					rtos: result.rtos,
					buildSystem: result.buildSystem,
					compliance: result.complianceFrameworks,
				};
			}
		} catch { /* best-effort */ }
		this._idleScanning = false;
		this._render();
	}



	// ─── Active Tab Dispatch ──────────────────────────────────────────────────

	private _renderActiveTab(root: HTMLElement): void {
		switch (this._activeTab) {
			case 'dashboard':    this._renderDashboard(root); break;
			case 'pinout':       this._renderPinout(root); break;
			case 'architecture': this._renderArchitecture(root); break;
			case 'hw-tools':     this._renderHWTools(root); break;
			case 'instruments':  this._renderInstruments(root); break;
			case 'datasheets':   this._renderDatasheets(root); break;
			case 'registers':    this._renderRegisters(root); break;
			case 'serial':       this._renderSerial(root); break;
			case 'compliance':   this._renderCompliance(root); break;
			case 'build':        this._renderBuild(root); break;
			case 'rtos':         this._renderRTOS(root); break;
			case 'hil':          this._renderHIL(root); break;
			case 'closed-loop':  this._renderClosedLoop(root); break;
		}
	}


	// ─── Dashboard ───────────────────────────────────────────────────────────

	private _renderDashboard(root: HTMLElement): void {
		const s = this._session.session;

		const scroll = $e('div', 'flex:1;overflow-y:auto;padding:20px;');
		root.appendChild(scroll);

		const grid = $e('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;');

		// MCU config card
		if (s.mcuConfig) {
			const cfg = s.mcuConfig;
			grid.appendChild(this._dashCard('MCU Configuration', [
				['Family', cfg.family],
				['Variant', cfg.variant],
				['Manufacturer', cfg.manufacturer],
				['Core', cfg.core],
				['Clock', `${cfg.clockMHz} MHz`],
				['Flash', _fmt(cfg.flashSize)],
				['RAM', _fmt(cfg.ramSize)],
				['FPU', cfg.fpu],
				['MPU', cfg.hasMPU ? 'Yes' : 'No'],
				['DSP', cfg.hasDSP ? 'Yes' : 'No'],
				...(cfg.gpioCount ? [['GPIO', `${cfg.gpioCount} pins`] as [string, string]] : []),
			]));
		}

		// Hardware context card
		grid.appendChild(this._dashCard('Hardware Context', [
			['Peripherals', `${s.registerMaps.length}`],
			['Datasheets', `${s.datasheets.length}`],
			['SVD files', `${s.svdFiles.length}`],
			['Errata entries', `${s.errata.length}`],
			['Timing constraints', `${s.timingConstraints.length}`],
			...(s.boardName ? [['Board', s.boardName] as [string, string]] : []),
		]));

		// Compliance card
		grid.appendChild(this._dashCard('Compliance & Toolchain', [
			['Frameworks', s.complianceFrameworks.join(', ') || 'None configured'],
			...(s.rtos ? [['RTOS', s.rtos] as [string, string]] : []),
			...(s.buildSystem ? [['Build System', s.buildSystem] as [string, string]] : []),
		]));

		// Peripherals card
		if (s.registerMaps.length > 0) {
			const rows: Array<[string, string]> = s.registerMaps.slice(0, 10).map(m => [
				m.name, `${m.registers.length} regs @ 0x${m.baseAddress.toString(16).toUpperCase()}`
			]);
			if (s.registerMaps.length > 10) { rows.push(['...', `+${s.registerMaps.length - 10} more`]); }
			grid.appendChild(this._dashCard('Peripherals Loaded', rows));
		}

		// Memory map card
		if (s.mcuConfig && s.mcuConfig.memoryMap.length > 0) {
			const rows: Array<[string, string]> = s.mcuConfig.memoryMap.map(m => [
				m.name, `0x${m.baseAddress.toString(16).toUpperCase()} \u2014 ${_fmt(m.size)} [${m.access}]`
			]);
			grid.appendChild(this._dashCard('Memory Map', rows));
		}

		// Quick actions card
		const actCard = this._sectionCard('Quick Actions');
		const actions: Array<{ label: string; desc: string }> = [
			{ label: 'Upload Datasheet', desc: 'Parse a PDF to extract register maps and timing data' },
			{ label: 'Load SVD File', desc: 'Import CMSIS SVD for complete register coverage' },
			{ label: 'Scan Workspace', desc: 'Re-detect MCU, toolchain, and RTOS from project files' },
		];
		for (const { label, desc } of actions) {
			const row = $e('div', [
				'padding:8px 10px', 'margin:4px 0', 'border-radius:5px',
				'cursor:pointer', 'transition:background 0.1s',
				'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
			].join(';'));
			row.addEventListener('mouseenter', () => { row.style.background = 'var(--vscode-list-hoverBackground)'; });
			row.addEventListener('mouseleave', () => { row.style.background = 'transparent'; });
			row.appendChild($t('div', label, 'font-weight:600;font-size:12px;'));
			row.appendChild($t('div', desc, 'font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px;'));
			actCard.appendChild(row);
		}
		grid.appendChild(actCard);

		// Developer productivity card
		if (s.mcuConfig) {
			const devCard = this._sectionCard('Developer Tools');
			const pinConflicts = this._pinMuxSvc.getConflicts();
			const clockConstraints = this._clockTreeSvc.getConstraints(s.mcuConfig.family);
			const linkerPreview = this._memoryLayoutSvc.generateLinkerScript();
			const hasLinkerScript = linkerPreview.includes('MEMORY');
			const sampleDeps = this._depSvc.getDependencyChain('USART1');
			const devRows: Array<[string, string]> = [
				['Pin Mux', pinConflicts.length === 0 ? 'No conflicts' : `${pinConflicts.length} conflict(s)`],
				['Clock Tree', `Max SYSCLK: ${clockConstraints.sysclkMax} MHz`],
				['Memory', hasLinkerScript ? `Linker ready / ${_fmt(s.mcuConfig.flashSize)} Flash` : `Flash: ${_fmt(s.mcuConfig.flashSize)} / RAM: ${_fmt(s.mcuConfig.ramSize)}`],
				['Dependencies', `${sampleDeps.nodes.length} init steps for USART1`],
				['Agent Tools', '14 fw_* developer productivity tools active'],
			];
			for (const [key, val] of devRows) {
				const row = $e('div', [
					'display:flex', 'justify-content:space-between', 'align-items:baseline',
					'padding:3px 0', 'border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
					'font-size:12px',
				].join(';'));
				row.appendChild($t('span', key, 'color:var(--vscode-descriptionForeground);'));
				const valEl = $t('span', val, 'font-weight:600;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;');
				if (key === 'Pin Mux' && pinConflicts.length > 0) {
					valEl.style.color = 'var(--vscode-errorForeground,#f48771)';
				}
				row.appendChild(valEl);
				devCard.appendChild(row);
			}
			grid.appendChild(devCard);
		}

		scroll.appendChild(grid);

		// ── Checkpoint Timeline ──────────────────────────────────────────────
		const checkpoints = this._checkpointSvc.listCheckpoints();
		if (checkpoints.length > 0) {
			const cpSection = $e('div', 'margin-top:20px;');
			cpSection.appendChild($t('div', 'Checkpoints', [
				'font-size:10px', 'font-weight:700', 'text-transform:uppercase',
				'letter-spacing:0.07em', 'color:var(--vscode-descriptionForeground)', 'margin-bottom:8px',
			].join(';')));

			for (const cp of checkpoints.slice(0, 8)) {
				const row = $e('div', 'display:flex;align-items:center;gap:8px;padding:6px 8px;margin-bottom:4px;border-radius:4px;background:var(--vscode-sideBar-background);border:1px solid var(--vscode-widget-border);');
				const ts = new Date(cp.timestamp).toISOString().slice(0, 16).replace('T', ' ');
				row.appendChild($t('span', ts, 'font-size:10px;color:var(--vscode-descriptionForeground);font-family:monospace;flex-shrink:0;'));
				row.appendChild($t('span', cp.label, 'font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
				row.appendChild($t('span', `${cp.filesChanged.length} files`, 'font-size:10px;color:var(--vscode-descriptionForeground);flex-shrink:0;'));

				const rewindBtn = $e('button', 'padding:2px 8px;font-size:10px;background:transparent;border:1px solid var(--vscode-widget-border);border-radius:3px;cursor:pointer;color:var(--vscode-foreground);flex-shrink:0;') as HTMLButtonElement;
				rewindBtn.textContent = 'Rewind';
				rewindBtn.title = `Rewind to: ${cp.label}`;
				rewindBtn.addEventListener('click', async () => {
					rewindBtn.textContent = '...';
					rewindBtn.disabled = true;
					try {
						await this._checkpointSvc.rewindTo(cp.id);
						rewindBtn.textContent = 'Done';
						this._render();
					} catch (e) {
						rewindBtn.textContent = 'Err';
						rewindBtn.title = (e as Error).message;
					}
				});
				row.appendChild(rewindBtn);
				cpSection.appendChild(row);
			}

			if (checkpoints.length > 8) {
				cpSection.appendChild($t('div', `+ ${checkpoints.length - 8} more checkpoints — use fw_checkpoint_list`, 'font-size:10px;color:var(--vscode-descriptionForeground);padding:4px 0;'));
			}
			scroll.appendChild(cpSection);
		}
	}

	private _dashCard(title: string, rows: Array<[string, string]>): HTMLElement {
		const card = this._sectionCard(title);
		for (const [key, val] of rows) {
			const row = $e('div', [
				'display:flex', 'justify-content:space-between', 'align-items:baseline',
				'padding:3px 0', 'border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
				'font-size:12px',
			].join(';'));
			row.appendChild($t('span', key, 'color:var(--vscode-descriptionForeground);'));
			row.appendChild($t('span', val, 'font-weight:600;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;'));
			card.appendChild(row);
		}
		return card;
	}

	private _sectionCard(title: string): HTMLElement {
		const card = $e('div', [
			'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
			'border-radius:7px', 'overflow:hidden',
		].join(';'));

		const hdr = $e('div', [
			'padding:8px 14px',
			'background:var(--vscode-sideBarSectionHeader-background)',
			'border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
		].join(';'));
		hdr.appendChild($t('span', title, [
			'font-size:10px', 'font-weight:700', 'letter-spacing:0.07em',
			'text-transform:uppercase', 'color:var(--vscode-sideBarSectionHeader-foreground,var(--vscode-foreground))',
		].join(';')));
		card.appendChild(hdr);

		const body = $e('div', 'padding:10px 14px;background:var(--vscode-sideBar-background,var(--vscode-editor-background));');
		card.appendChild(body);

		// Return body so callers can append rows directly
		body._isBodyMarker = true;

		// Patch appendChild to append to body unless it's the header
		const origAppend = card.appendChild.bind(card);
		card.appendChild = (child: Node) => {
			if ((child as HTMLElement)?._isBodyMarker || child === hdr || !body._isBodyMarker) {
				return origAppend(child as any);
			}
			if (child !== hdr) { return body.appendChild(child as any) as any; }
			return origAppend(child as any);
		};

		return card;
	}
	// ─── HW Tools ────────────────────────────────────────────────────────────────

	private _renderHWTools(root: HTMLElement): void {
		const s = this._session.session;
		const layout = $e('div', 'flex:1;display:flex;overflow:hidden;');
		root.appendChild(layout);

		type HWPanel = 'pin-mux' | 'clock-tree' | 'memory' | 'register' | 'deps';
		const panels: Array<{ id: HWPanel; label: string; badge: string; desc: string; color: string }> = [
			{ id: 'pin-mux',    label: 'Pin Mux',           badge: 'GPIO',  desc: 'Conflict detection & AF validation',  color: 'var(--vscode-focusBorder)' },
			{ id: 'clock-tree', label: 'Clock Tree',        badge: 'PLL',   desc: 'PLL validator & SYSCLK solver',       color: 'var(--vscode-focusBorder)' },
			{ id: 'memory',     label: 'Memory & Linker',   badge: '.ld',   desc: 'Linker script & DMA hazard check',    color: 'var(--vscode-focusBorder)' },
			{ id: 'register',   label: 'Register Composer', badge: 'REG',   desc: 'Decode / diff register values',       color: 'var(--vscode-focusBorder)' },
			{ id: 'deps',       label: 'Init Dependencies', badge: 'INIT',  desc: 'Full peripheral init chain & C code', color: '#e0a84e' },
		];

		let activePanel: HWPanel = 'pin-mux';
		const detail = $e('div', 'flex:1;overflow-y:auto;padding:16px 20px;background:var(--vscode-editor-background);');

		const nav = $e('div', [
			'width:220px', 'flex-shrink:0',
			'border-right:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
			'background:var(--vscode-sideBar-background)', 'overflow-y:auto',
			'display:flex', 'flex-direction:column',
		].join(';'));

		const navHdr = $e('div', 'padding:14px 16px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-widget-border);margin-bottom:4px;');
		navHdr.textContent = 'Hardware Tools';
		nav.appendChild(navHdr);

		const renderDetail = (id: HWPanel) => {
			while (detail.firstChild) { detail.removeChild(detail.firstChild); }
			switch (id) {
				case 'pin-mux':    this._renderPinMuxPanel(detail, s); break;
				case 'clock-tree': this._renderClockTreePanel(detail, s); break;
				case 'memory':     this._renderMemoryPanel(detail, s); break;
				case 'register':   this._renderRegisterCompositorPanel(detail, s); break;
				case 'deps':       this._renderDepsPanel(detail, s); break;
			}
		};

		for (const p of panels) {
			const item = $e('div', [
				'padding:10px 16px', 'cursor:pointer',
				'border-left:3px solid transparent',
				'transition:background 0.1s,border-color 0.1s',
				'display:flex', 'align-items:flex-start', 'gap:10px',
			].join(';'));
			item.dataset.panel = p.id;

			const badgeEl = $e('div', [
				'font-size:9px', 'font-weight:700', 'letter-spacing:0.05em',
				`background:${p.color}22`, `color:${p.color}`,
				`border:1px solid ${p.color}44`,
				'border-radius:3px', 'padding:2px 5px', 'flex-shrink:0', 'margin-top:1px',
			].join(';'));
			badgeEl.textContent = p.badge;

			const textWrap = $e('div', 'flex:1;min-width:0;');
			textWrap.appendChild($t('div', p.label, 'font-size:12px;font-weight:600;color:var(--vscode-foreground);line-height:1.3;'));
			textWrap.appendChild($t('div', p.desc, 'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px;line-height:1.4;'));

			item.appendChild(badgeEl);
			item.appendChild(textWrap);

			const setActive = (el: HTMLElement, color: string) => {
				nav.querySelectorAll<HTMLElement>('[data-panel]').forEach(n => {
					n.style.background = 'transparent';
					n.style.borderLeftColor = 'transparent';
				});
				el.style.background = 'var(--vscode-list-activeSelectionBackground)';
				el.style.borderLeftColor = color;
			};

			item.addEventListener('mouseenter', () => { if (item.dataset.panel !== activePanel) { item.style.background = 'var(--vscode-list-hoverBackground)'; } });
			item.addEventListener('mouseleave', () => { if (item.dataset.panel !== activePanel) { item.style.background = 'transparent'; } });
			item.addEventListener('click', () => {
				activePanel = p.id;
				setActive(item, p.color);
				renderDetail(p.id);
			});

			if (p.id === activePanel) {
				item.style.background = 'var(--vscode-list-activeSelectionBackground)';
				item.style.borderLeftColor = p.color;
			}

			nav.appendChild(item);
		}

		layout.appendChild(nav);
		layout.appendChild(detail);
		renderDetail(activePanel);
	}

	// ─── Pin Mux Panel ────────────────────────────────────────────────────────

	private _renderPinMuxPanel(root: HTMLElement, s: IFirmwareSessionData): void {
		const map = this._schematicSvc.getPinoutMap();

		// ── Header ────────────────────────────────────────────────────────────
		const hdr = $e('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-shrink:0;');
		const hdrLeft = $e('div','display:flex;align-items:center;gap:8px;');
		hdrLeft.appendChild($t('span','Pin Mux','font-size:13px;font-weight:700;'));
		if(map){
			hdrLeft.appendChild($t('span',`— ${map.variant} ${map.packageType} ${map.pinCount}-pin`,'font-size:11px;color:var(--vscode-descriptionForeground);'));
		}
		// Filter bar
		const filterWrap = $e('div','display:flex;gap:4px;');
		const filters = ['All','Allocated','Available','Conflicts'] as const;
		type FilterT = typeof filters[number];
		let activeFilter: FilterT = 'All';
		const filterBtns: HTMLElement[] = [];
		for(const f of filters){
			const b = $e('div',`padding:3px 8px;font-size:10px;border-radius:3px;cursor:pointer;border:1px solid var(--vscode-widget-border);background:${f==='All'?'var(--vscode-button-background)':'transparent'};color:${f==='All'?'var(--vscode-button-foreground)':'var(--vscode-descriptionForeground)'};`);
			b.textContent=f;
			b.addEventListener('click',()=>{
				activeFilter=f;
				filterBtns.forEach((fb,i)=>{
					fb.style.background=filters[i]===f?'var(--vscode-button-background)':'transparent';
					fb.style.color=filters[i]===f?'var(--vscode-button-foreground)':'var(--vscode-descriptionForeground)';
				});
				renderDiagram();
			});
			filterBtns.push(b); filterWrap.appendChild(b);
		}
		hdr.appendChild(hdrLeft); hdr.appendChild(filterWrap);
		root.appendChild(hdr);

		// ── Layout: SVG diagram left, detail panel right ──────────────────────
		const body = $e('div','display:flex;gap:10px;flex:1;overflow:hidden;min-height:0;');
		root.appendChild(body);

		// SVG container — square-ish, fills height
		const svgWrap = $e('div','flex-shrink:0;position:relative;overflow:hidden;');
		body.appendChild(svgWrap);

		// Detail panel right
		const detail = $e('div','flex:1;overflow-y:auto;font-size:11px;');
		body.appendChild(detail);

		// Tooltip
		const tip = $e('div','position:fixed;display:none;pointer-events:none;background:var(--vscode-editorWidget-background,#1e1e1e);border:1px solid var(--vscode-focusBorder);border-radius:4px;padding:5px 9px;font-size:10px;z-index:100;max-width:200px;line-height:1.5;');
		document.body.appendChild(tip);

		const conflicts = this._pinMuxSvc.getConflicts();

		const renderDiagram = () => {
			while(svgWrap.firstChild){svgWrap.removeChild(svgWrap.firstChild);}
			while(detail.firstChild){detail.removeChild(detail.firstChild);}

			if(!map){
				detail.appendChild($t('div','No pin data available. Load an SVD file or select an MCU with GPIO definitions.','font-size:11px;color:var(--vscode-descriptionForeground);padding:12px 0;'));
				// Fallback: show validate + suggest forms
				renderForms(detail);
				return;
			}

			const PIN_COLOR: Record<string,string> = {
				available:'#37474f', allocated:'#1b5e20', conflict:'#7f0000',
				power:'#263238', unused:'#1a1a1a', debug:'#3e2723',
			};
			const PIN_TEXT: Record<string,string> = {
				available:'rgba(255,255,255,0.30)', allocated:'#81c784',
				conflict:'#ef9a9a', power:'rgba(255,255,255,0.15)',
				unused:'rgba(255,255,255,0.10)', debug:'#bcaaa4',
			};

			// Filter pins
			let pins = map.pins;
			if(activeFilter==='Allocated') pins=pins.filter(p=>p.color==='allocated');
			else if(activeFilter==='Available') pins=pins.filter(p=>p.color==='available');
			else if(activeFilter==='Conflicts') pins=pins.filter(p=>p.conflict);

			// Package geometry
			const pinsPerSide = Math.ceil(map.pinCount/4);
			const PIN_H = 22; const PIN_W = 60; const GAP = 2;
			const bodySize = pinsPerSide*(PIN_H+GAP)+20;
			const svgSize = bodySize + PIN_W*2 + 20;
			svgWrap.style.width = svgSize+'px';
			svgWrap.style.height = svgSize+'px';

			const NS = 'http://www.w3.org/2000/svg';
			const svg = document.createElementNS(NS,'svg');
			svg.setAttribute('width',String(svgSize));
			svg.setAttribute('height',String(svgSize));
			svg.style.cssText='display:block;';

			// IC body
			const bodyX = PIN_W+10, bodyY = PIN_W+10;
			const body2 = document.createElementNS(NS,'rect');
			body2.setAttribute('x',String(bodyX)); body2.setAttribute('y',String(bodyY));
			body2.setAttribute('width',String(bodySize)); body2.setAttribute('height',String(bodySize));
			body2.setAttribute('rx','6'); body2.setAttribute('fill','#161b22');
			body2.setAttribute('stroke','rgba(255,255,255,0.12)'); body2.setAttribute('stroke-width','1.5');
			svg.appendChild(body2);

			// Package label
			const pkgLbl = document.createElementNS(NS,'text');
			pkgLbl.setAttribute('x',String(bodyX+bodySize/2)); pkgLbl.setAttribute('y',String(bodyY+bodySize/2-8));
			pkgLbl.setAttribute('text-anchor','middle'); pkgLbl.setAttribute('font-size','11');
			pkgLbl.setAttribute('font-family','monospace'); pkgLbl.setAttribute('fill','rgba(255,255,255,0.25)');
			pkgLbl.textContent = map.variant;
			svg.appendChild(pkgLbl);
			const pkgLbl2 = document.createElementNS(NS,'text');
			pkgLbl2.setAttribute('x',String(bodyX+bodySize/2)); pkgLbl2.setAttribute('y',String(bodyY+bodySize/2+8));
			pkgLbl2.setAttribute('text-anchor','middle'); pkgLbl2.setAttribute('font-size','9');
			pkgLbl2.setAttribute('font-family','system-ui'); pkgLbl2.setAttribute('fill','rgba(255,255,255,0.18)');
			pkgLbl2.textContent = map.packageType;
			svg.appendChild(pkgLbl2);

			// Pin 1 dot
			const p1dot = document.createElementNS(NS,'circle');
			p1dot.setAttribute('cx',String(bodyX+8)); p1dot.setAttribute('cy',String(bodyY+8));
			p1dot.setAttribute('r','3'); p1dot.setAttribute('fill','rgba(255,255,255,0.25)');
			svg.appendChild(p1dot);

			const mkPin = (pin: ISchematicPin, x:number, y:number, w:number, h:number, textRight:boolean) => {
				const inFilter = pins.includes(pin);
				const col = inFilter ? (PIN_COLOR[pin.color]??'#37474f') : '#1a1a1a';
				const tcol = inFilter ? (PIN_TEXT[pin.color]??'rgba(255,255,255,0.3)') : 'rgba(255,255,255,0.08)';

				const g = document.createElementNS(NS,'g');
				g.style.cursor='pointer';

				const rect = document.createElementNS(NS,'rect');
				rect.setAttribute('x',String(x)); rect.setAttribute('y',String(y));
				rect.setAttribute('width',String(w)); rect.setAttribute('height',String(h));
				rect.setAttribute('rx','2'); rect.setAttribute('fill',col);
				rect.setAttribute('stroke',pin.conflict?'#ef5350':'rgba(255,255,255,0.06)');
				rect.setAttribute('stroke-width',pin.conflict?'1.5':'0.5');
				g.appendChild(rect);

				// Pin label
				const lbl = document.createElementNS(NS,'text');
				lbl.setAttribute('x',String(textRight ? x+4 : x+w-4));
				lbl.setAttribute('y',String(y+h/2+4));
				lbl.setAttribute('text-anchor',textRight?'start':'end');
				lbl.setAttribute('font-size','8'); lbl.setAttribute('font-family','monospace');
				lbl.setAttribute('fill',tcol);
				lbl.textContent = pin.portPin || String(pin.physicalPin);
				g.appendChild(lbl);

				// Hover + click
				g.addEventListener('mouseenter',(e)=>{
					rect.setAttribute('stroke','var(--vscode-focusBorder,#007acc)');
					rect.setAttribute('stroke-width','1.5');
					tip.style.display='block';
					const lines = [`${pin.portPin} — Pin ${pin.physicalPin}`,
						pin.primaryFunction||'No function',
						pin.peripheral?`Peripheral: ${pin.peripheral}`:'',
						pin.conflict?'CONFLICT: multiple peripherals':'',
					].filter(Boolean);
					while(tip.firstChild){tip.removeChild(tip.firstChild);}
					for(const l of lines){tip.appendChild($t('div',l,l.includes('CONFLICT')?'color:#ef9a9a;font-weight:700;':''));}
					tip.style.left=(e.clientX+12)+'px'; tip.style.top=(e.clientY-10)+'px';
				});
				g.addEventListener('mousemove',(e)=>{tip.style.left=(e.clientX+12)+'px'; tip.style.top=(e.clientY-10)+'px';});
				g.addEventListener('mouseleave',()=>{
					rect.setAttribute('stroke',pin.conflict?'#ef5350':'rgba(255,255,255,0.06)');
					rect.setAttribute('stroke-width',pin.conflict?'1.5':'0.5');
					tip.style.display='none';
				});
				g.addEventListener('click',()=>showPinDetail(pin));
				svg.appendChild(g);
			};

			// Place pins around package edges
			// Sorted by physicalPin; distribute around 4 sides
			const sorted = [...map.pins].sort((a,b)=>a.physicalPin-b.physicalPin);
			const sides:[number,number,number,number,boolean][] = []; // x,y,w,h,textRight
			for(let i=0;i<sorted.length;i++){
				const side = Math.floor(i/pinsPerSide); // 0=bottom 1=left 2=top 3=right
				const idx = i%pinsPerSide;
				const off = 10+idx*(PIN_H+GAP);
				let x=0,y=0,w=PIN_W,h=PIN_H,tr=false;
				if(side===0){x=bodyX+off;y=bodyY+bodySize;w=PIN_H;h=PIN_W;tr=false;}       // bottom: rotated
				else if(side===1){x=bodyX-PIN_W;y=bodyY+off;tr=false;}                       // left
				else if(side===2){x=bodyX+bodySize-off-PIN_H;y=bodyY-PIN_W;w=PIN_H;h=PIN_W;tr=false;} // top
				else{x=bodyX+bodySize;y=bodyY+bodySize-off-PIN_H;tr=true;}                   // right
				sides.push([x,y,w,h,tr]);
				if(i<sorted.length) mkPin(sorted[i],x,y,w,h,tr);
			}
			void sides;

			svgWrap.appendChild(svg);
		};

		// ── Detail pane: show pin info ────────────────────────────────────────
		const showPinDetail = (pin: ISchematicPin) => {
			while(detail.firstChild){detail.removeChild(detail.firstChild);}

			const colorNames: Record<string,string> = {available:'Free',allocated:'Allocated',conflict:'CONFLICT',power:'Power',unused:'NC',debug:'Debug'};
			detail.appendChild($t('div',`${pin.portPin}  —  Pin ${pin.physicalPin}`,'font-size:13px;font-weight:700;margin-bottom:6px;font-family:monospace;'));
			const rows: [string,string][] = [
				['Status', colorNames[pin.color]??pin.color],
				['Primary Function', pin.primaryFunction||'—'],
				['Peripheral', pin.peripheral||'—'],
				['Conflict', pin.conflict?'YES — multiple peripherals assigned':'No'],
			];
			const grid=$e('div','display:grid;grid-template-columns:110px 1fr;gap:4px 10px;margin-bottom:12px;');
			for(const [k,v] of rows){
				grid.appendChild($t('div',k,'font-size:10px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.05em;padding-top:1px;'));
				grid.appendChild($t('div',v,`font-size:11px;font-family:monospace;${v==='CONFLICT'||v.startsWith('YES')?'color:#ef9a9a;font-weight:700;':''}`));
			}
			detail.appendChild(grid);

			if(pin.conflict){
				const confs=conflicts.filter(c=>c.allocations.some(a=>a.signal.startsWith(pin.portPin)));
				for(const c of confs){
					const box=$e('div','border:1px solid rgba(239,83,80,0.3);border-radius:5px;padding:8px 10px;margin-bottom:6px;background:rgba(239,83,80,0.05);');
					box.appendChild($t('div',c.message,'font-size:10px;color:#ef9a9a;font-weight:700;margin-bottom:4px;'));
					for(const a of c.allocations){
						const r=$e('div','display:flex;gap:8px;font-size:10px;font-family:monospace;padding:2px 0;border-top:1px solid rgba(239,83,80,0.12);');
						r.appendChild($t('span',a.signal,'min-width:80px;font-weight:600;'));
						r.appendChild($t('span',`AF${a.af}`,'color:#e0a84e;min-width:28px;'));
						r.appendChild($t('span',a.source,'color:var(--vscode-descriptionForeground);'));
						box.appendChild(r);
					}
					detail.appendChild(box);
				}
			}

			// Validate AF inline
			detail.appendChild($t('div','Validate AF','font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);margin-bottom:4px;margin-top:4px;'));
			const vRow=$e('div','display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap;');
			const vPeriph=this._hwLabeledInput('Peripheral','e.g. USART1','','' );
			const vAF=this._hwLabeledInput('AF','0-15','','50px');
			vPeriph.input.style.width='100px'; vPeriph.input.style.fontSize='10px';
			vAF.input.style.width='40px'; vAF.input.style.fontSize='10px';
			const vBtn=this._btn('Check',true,()=>{
				const pm=pin.portPin.match(/P?([A-K])(\d+)/);
				if(!pm){return;}
				const res=this._pinMuxSvc.validateAF({port:pm[1]!,pin:parseInt(pm[2]!)},vPeriph.input.value.trim().toUpperCase(),parseInt(vAF.input.value)||0);
				while(vOut.firstChild){vOut.removeChild(vOut.firstChild);}
				vOut.appendChild($t('div',res.message,`font-size:10px;color:${res.valid?'#81c784':'#ef9a9a'};`));
			},'font-size:10px;padding:3px 8px;align-self:flex-end;');
			const vOut=$e('div','margin-top:4px;');
			vRow.appendChild(vPeriph.wrap); vRow.appendChild(vAF.wrap); vRow.appendChild(vBtn);
			detail.appendChild(vRow); detail.appendChild(vOut);
		};

		// Default detail: summary + conflict list
		const renderForms = (container: HTMLElement) => {
			if(map){
				// Summary stats
				const statRow=$e('div','display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;');
				const mkStat=(label:string,val:string,color?:string)=>{
					const c=$e('div','border:1px solid var(--vscode-widget-border);border-radius:5px;padding:6px 10px;');
					c.appendChild($t('div',val,`font-size:14px;font-weight:700;font-family:monospace;${color?'color:'+color:''}`));
					c.appendChild($t('div',label,'font-size:9px;color:var(--vscode-descriptionForeground);margin-top:2px;text-transform:uppercase;letter-spacing:0.05em;'));
					return c;
				};
				statRow.appendChild(mkStat('Total Pins',String(map.pinCount)));
				statRow.appendChild(mkStat('Allocated',String(map.allocatedCount),'#81c784'));
				statRow.appendChild(mkStat('Conflicts',String(map.conflictCount),map.conflictCount>0?'#ef9a9a':undefined));
				container.appendChild(statRow);
			}
			if(conflicts.length>0){
				container.appendChild($t('div','Conflicts','font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);margin-bottom:4px;'));
				for(const c of conflicts.slice(0,6)){
					const box=$e('div','border:1px solid rgba(239,83,80,0.3);border-radius:5px;padding:7px 9px;margin-bottom:5px;background:rgba(239,83,80,0.05);cursor:pointer;');
					box.appendChild($t('div',c.message,'font-size:10px;color:#ef9a9a;font-weight:700;'));
					container.appendChild(box);
				}
			} else if(map){
				container.appendChild($t('div','No conflicts — click any pin for details','font-size:11px;color:var(--vscode-descriptionForeground);padding:4px 0;'));
			}
			// Find pins form
			container.appendChild($t('div','Find Pins for Peripheral','font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);margin-top:10px;margin-bottom:4px;'));
			const sRow=$e('div','display:flex;gap:6px;align-items:flex-end;');
			const sIn=this._hwLabeledInput('Peripheral','e.g. SPI1','','120px');
			sIn.input.style.fontSize='10px';
			const sBtn=this._btn('Find',true,()=>{
				const sugs=this._pinMuxSvc.suggestPin(sIn.input.value.trim().toUpperCase());
				while(sOut.firstChild){sOut.removeChild(sOut.firstChild);}
				if(!sugs.length){sOut.appendChild($t('div','No results','font-size:10px;color:var(--vscode-descriptionForeground);'));return;}
				const tbl=$e('div','border:1px solid var(--vscode-widget-border);border-radius:4px;overflow:hidden;margin-top:6px;');
				const th=$e('div','display:grid;grid-template-columns:52px 34px 1fr 60px;gap:6px;padding:4px 8px;background:var(--vscode-sideBarSectionHeader-background);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);');
				['Pin','AF','Signal','Status'].forEach(h=>th.appendChild($t('div',h)));
				tbl.appendChild(th);
				for(const sg of sugs.slice(0,12)){
					const r=$e('div','display:grid;grid-template-columns:52px 34px 1fr 60px;gap:6px;padding:4px 8px;font-size:10px;font-family:monospace;border-top:1px solid var(--vscode-widget-border);');
					r.appendChild($t('div',`P${sg.pin.port}${sg.pin.pin}`,'font-weight:700;'));
					r.appendChild($t('div',`AF${sg.af}`,'color:var(--vscode-descriptionForeground);'));
					r.appendChild($t('div',sg.signal,''));
					const av=sg.reason==='available';
					r.appendChild($t('div',sg.reason,`color:${av?'#81c784':'var(--vscode-descriptionForeground)'};`));
					tbl.appendChild(r);
				}
				sOut.appendChild(tbl);
			},'font-size:10px;padding:3px 8px;align-self:flex-end;');
			const sOut=$e('div');
			sRow.appendChild(sIn.wrap); sRow.appendChild(sBtn);
			container.appendChild(sRow); container.appendChild(sOut);
		};

		renderDiagram();
		renderForms(detail);

		// Cleanup tooltip on destroy
		const cleanupTip = () => { if(tip.parentNode){tip.parentNode.removeChild(tip);} };
		root.addEventListener('disconnectedCallback' as never, cleanupTip);
		// Fallback cleanup after 5 min
		setTimeout(cleanupTip, 300000);
	}

	// ─── Clock Tree Panel ─────────────────────────────────────────────────────

	private _renderClockTreePanel(root: HTMLElement, s: IFirmwareSessionData): void {
		const family = s.mcuConfig?.family ?? 'STM32F4';
		const constraints = this._clockTreeSvc.getConstraints(family);

		// ── Header ────────────────────────────────────────────────────────────
		const hdr = $e('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;flex-shrink:0;');
		const hdrLeft = $e('div');
		hdrLeft.appendChild($t('span', 'Clock Tree', 'font-size:13px;font-weight:700;'));
		hdrLeft.appendChild($t('span', ` — ${family} PLL validator & SYSCLK constraint solver`, 'font-size:11px;color:var(--vscode-descriptionForeground);margin-left:8px;'));
		// Source badge — updated once real config is loaded
		const srcBadge = $e('div','font-size:9px;padding:2px 7px;border-radius:3px;border:1px solid var(--vscode-widget-border);color:var(--vscode-descriptionForeground);');
		srcBadge.textContent = 'Scanning project...';
		hdr.appendChild(srcBadge);
		root.appendChild(hdr);

		// ── Canvas block diagram ──────────────────────────────────────────────
		// Solver fallback defaults — overwritten by real project config below
		const defaultHse = 8;
		const fallbackSols = this._clockTreeSvc.solve(defaultHse, {
			sysclkMHz: constraints.sysclkMax,
			usb48Required: constraints.peripheralClockRequirements.some(r => r.clockSource === 'PLL48CLK'),
		}, family, 1);
		const fb = fallbackSols[0];
		const defM = fb?.pll.m ?? constraints.mRange[0];
		const defN = fb?.pll.n ?? Math.round(constraints.sysclkMax * constraints.pValues[0] / defaultHse);
		const defP = fb?.pll.p ?? constraints.pValues[0];
		const defQ = fb?.pll.q ?? constraints.qRange[0];
		const defApb1 = constraints.sysclkMax > constraints.apb1Max ? Math.ceil(constraints.sysclkMax / constraints.apb1Max) : 1;
		const defApb2 = constraints.sysclkMax > constraints.apb2Max ? Math.ceil(constraints.sysclkMax / constraints.apb2Max) : 1;

		// State for the diagram
		type ClkState = { hse:number; m:number; n:number; p:number; q:number; ahb:number; apb1:number; apb2:number; };
		let st: ClkState = { hse: defaultHse, m: defM, n: defN, p: defP, q: defQ, ahb: 1, apb1: defApb1, apb2: defApb2 };

		const canvasWrap = $e('div', 'position:relative;width:100%;flex:1;min-height:180px;max-height:340px;');
		const canvas = $e('canvas', 'display:block;width:100%;height:100%;') as HTMLCanvasElement;
		canvasWrap.appendChild(canvas);

		// Floating editor overlay
		const editor = $e('div', 'position:absolute;display:none;flex-direction:column;gap:4px;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-focusBorder);border-radius:6px;padding:8px 10px;z-index:10;min-width:110px;box-shadow:0 4px 16px rgba(0,0,0,0.4);') as HTMLDivElement;
		const editorLabel = $t('div', '', 'font-size:9px;font-weight:700;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:2px;');
		const editorInput = $e('input', 'font-size:14px;font-weight:700;font-family:monospace;background:transparent;border:none;outline:none;color:var(--vscode-editor-foreground);width:80px;') as HTMLInputElement;
		const editorHint = $t('div', '', 'font-size:9px;color:var(--vscode-descriptionForeground);margin-top:2px;');
		editor.appendChild(editorLabel); editor.appendChild(editorInput); editor.appendChild(editorHint);
		canvasWrap.appendChild(editor);
		root.appendChild(canvasWrap);

		// ── Status bar below canvas ───────────────────────────────────────────
		const statusBar = $e('div', 'display:flex;align-items:center;gap:0;border:1px solid var(--vscode-widget-border);border-radius:5px;overflow:hidden;flex-shrink:0;margin-top:10px;');
		const statusKeys = ['SYSCLK','HCLK','APB1','APB2','PLL48','VCO','Flash WS'] as const;
		const statusCells: Record<string, HTMLElement> = {};
		for (const k of statusKeys) {
			const cell = $e('div', 'flex:1;padding:8px 6px;text-align:center;border-right:1px solid var(--vscode-widget-border);');
			const val = $t('div', '--', 'font-size:13px;font-weight:700;font-family:monospace;');
			const lbl = $t('div', k, 'font-size:9px;color:var(--vscode-descriptionForeground);margin-top:2px;text-transform:uppercase;letter-spacing:0.05em;');
			cell.appendChild(val); cell.appendChild(lbl);
			statusCells[k] = val;
			statusBar.appendChild(cell);
		}
		(statusBar.lastElementChild as HTMLElement).style.borderRight = 'none';
		root.appendChild(statusBar);

		// Error strip
		const errStrip = $e('div', 'margin-top:8px;font-size:11px;min-height:18px;flex-shrink:0;');
		root.appendChild(errStrip);

		// ── Solver strip ──────────────────────────────────────────────────────
		root.appendChild($e('div','height:10px;flex-shrink:0;'));
		const solveHdr = $e('div','display:flex;align-items:center;gap:8px;padding:6px 0 6px;border-top:1px solid var(--vscode-widget-border);flex-shrink:0;');
		solveHdr.appendChild($t('span','Find Configuration','font-size:11px;font-weight:600;'));
		solveHdr.appendChild($t('span','Enter target SYSCLK — solver enumerates all valid M/N/P/Q combinations','font-size:10px;color:var(--vscode-descriptionForeground);'));
		root.appendChild(solveHdr);
		const solveRow = $e('div','display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin-top:4px;flex-shrink:0;');
		const solveHseIn = this._hwLabeledInput('HSE (MHz)','Crystal',String(defaultHse),'80px');
		const solveFreqIn = this._hwLabeledInput('Target SYSCLK',`max ${constraints.sysclkMax}`,String(constraints.sysclkMax),'100px');
		const usbWrap = $e('div','display:flex;flex-direction:column;gap:3px;');
		usbWrap.appendChild($t('label','USB 48 MHz','font-size:9px;font-weight:600;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.06em;'));
		const usbCb = $e('input','cursor:pointer;') as HTMLInputElement; usbCb.type='checkbox'; usbCb.checked=true;
		const usbLbl = $e('label','display:flex;align-items:center;gap:5px;font-size:10px;cursor:pointer;padding:4px 0;');
		usbLbl.appendChild(usbCb); usbLbl.appendChild(document.createTextNode('Required'));
		usbWrap.appendChild(usbLbl);
		const findBtn = this._btn('Find Solutions', true, () => {
			const hv=+solveHseIn.input.value, fv=+solveFreqIn.input.value;
			while(solveOut.firstChild){solveOut.removeChild(solveOut.firstChild);}
			if(!hv||!fv){return;}
			const sols=this._clockTreeSvc.solve(hv,{sysclkMHz:fv,usb48Required:usbCb.checked},family);
			if(!sols.length){solveOut.appendChild($t('div',`No solution for ${fv} MHz @ HSE=${hv} MHz`,'font-size:11px;color:var(--vscode-descriptionForeground);padding:6px 0;'));return;}
			solveOut.appendChild($t('div',`${sols.length} solution${sols.length>1?'s':''} — click to apply:`,'font-size:10px;color:var(--vscode-descriptionForeground);margin-bottom:6px;'));
			for(const [i,sol] of sols.slice(0,5).entries()){
				const row=$e('div',`display:flex;align-items:center;gap:0;border:1px solid ${i===0?'var(--vscode-focusBorder)':'var(--vscode-widget-border)'};border-radius:5px;overflow:hidden;margin-bottom:5px;cursor:pointer;`);
				const mkCell=(lbl:string,v:string)=>{const c=$e('div','padding:6px 10px;text-align:center;border-right:1px solid var(--vscode-widget-border);flex:1;');c.appendChild($t('div',v,'font-size:12px;font-weight:700;font-family:monospace;'));c.appendChild($t('div',lbl,'font-size:9px;color:var(--vscode-descriptionForeground);'));return c;};
				row.appendChild(mkCell('M',String(sol.pll.m)));
				row.appendChild(mkCell('N',String(sol.pll.n)));
				row.appendChild(mkCell('P',String(sol.pll.p)));
				row.appendChild(mkCell('Q',String(sol.pll.q)));
				const fCell=$e('div','padding:6px 10px;text-align:center;flex:1.5;');
				fCell.appendChild($t('div',`${sol.sysclkMHz.toFixed(0)} MHz`,'font-size:12px;font-weight:700;font-family:monospace;color:#4caf50;'));
				fCell.appendChild($t('div','SYSCLK','font-size:9px;color:var(--vscode-descriptionForeground);'));
				row.appendChild(fCell);
				if(i===0){const b=$e('div','padding:6px 10px;font-size:9px;font-weight:700;color:var(--vscode-focusBorder);align-self:center;');b.textContent='BEST';row.appendChild(b);}
				row.addEventListener('click',()=>{
					st={...st,hse:hv,m:sol.pll.m,n:sol.pll.n,p:sol.pll.p,q:sol.pll.q};
					drawDiagram(); updateStatus();
				});
				solveOut.appendChild(row);
			}
		},'font-size:10px;padding:4px 12px;align-self:flex-end;');
		solveRow.appendChild(solveHseIn.wrap); solveRow.appendChild(solveFreqIn.wrap); solveRow.appendChild(usbWrap); solveRow.appendChild(findBtn);
		root.appendChild(solveRow);
		const solveOut=$e('div','margin-top:8px;flex-shrink:0;');
		root.appendChild(solveOut);

		// ── Canvas rendering ──────────────────────────────────────────────────
		// Block layout (logical columns, drawn left→right):
		// [HSE] --/M--> [PLL block: M/N/P/Q] --/P--> [SYSCLK] --/AHB--> [HCLK] --/APB1--> [APB1]
		//                                     --/Q--> [PLL48]                   --/APB2--> [APB2]

		type HitBox = { x:number; y:number; w:number; h:number; key:keyof ClkState; label:string; hint:string; min:number; max:number; };
		let hitBoxes: HitBox[] = [];
		let activeKey: keyof ClkState | null = null;

		const drawDiagram = () => {
			const DPR = window.devicePixelRatio || 1;
			const W = canvas.parentElement!.clientWidth;
			const H = Math.max(180, canvasWrap.clientHeight || 220);
			canvas.width = W * DPR; canvas.height = H * DPR;
			canvas.style.height = H + 'px';
			const ctx = canvas.getContext('2d')!;
			ctx.scale(DPR, DPR);

			const BG = '#0d1117';
			const BORDER = 'rgba(255,255,255,0.12)';
			const TEXT = 'rgba(255,255,255,0.88)';
			const DIM = 'rgba(255,255,255,0.40)';
			const ACCENT = '#4fc3f7';
			const GREEN = '#4caf50';
			const RED = '#f48771';
			const ORANGE = '#e0a84e';
			const PURPLE = '#ab47bc';
			const WIRE = 'rgba(255,255,255,0.20)';

			ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
			hitBoxes = [];

			const result = this._clockTreeSvc.validate({m:st.m,n:st.n,p:st.p,q:st.q}, st.hse, st.ahb, st.apb1, st.apb2, family);
			const cv = result.valid ? result.computedValues : null;
			const OK = result.valid;

			// ── Drawing helpers ───────────────────────────────────────────────
			const roundRect = (x:number,y:number,w:number,h:number,stroke:string,fill='rgba(255,255,255,0.04)') => {
				const r=6; ctx.beginPath(); ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r); ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r); ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r); ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r); ctx.closePath();
				ctx.fillStyle=fill; ctx.fill(); ctx.strokeStyle=stroke; ctx.lineWidth=1.5; ctx.stroke();
			};
			const node = (x:number,y:number,w:number,h:number,stroke:string,topLbl:string,mainVal:string,subLbl?:string,key?:keyof ClkState,hint?:string,kmin?:number,kmax?:number) => {
				const isActive = key && key===activeKey;
				const isHover = key && key===hoverKey && !isActive;
				roundRect(x,y,w,h, isActive?ACCENT:isHover?'rgba(255,255,255,0.45)':stroke, isHover?'rgba(255,255,255,0.08)':'rgba(255,255,255,0.04)');
				ctx.font='8px system-ui'; ctx.textAlign='center'; ctx.fillStyle=DIM; ctx.fillText(topLbl,x+w/2,y+10);
				ctx.font='bold 11px monospace'; ctx.textAlign='center'; ctx.fillStyle=isActive?ACCENT:TEXT; ctx.fillText(mainVal,x+w/2,y+h/2+4);
				if(subLbl){ctx.font='8px system-ui'; ctx.textAlign='center'; ctx.fillStyle=DIM; ctx.fillText(subLbl,x+w/2,y+h-5);}
				if(key) hitBoxes.push({x,y,w,h,key,label:topLbl,hint:hint??'',min:kmin??0,max:kmax??999});
			};
			const divider = (x:number,y:number,val:string,stroke:string,key:keyof ClkState,hint:string,min:number,max:number) => {
				const w=26,h=18,isActive=key===activeKey,isHover=key===hoverKey&&!isActive;
				roundRect(x,y,w,h,isActive?ACCENT:isHover?'rgba(255,255,255,0.5)':stroke,isHover?'rgba(255,255,255,0.12)':'rgba(255,255,255,0.07)');
				ctx.font='bold 9px monospace'; ctx.textAlign='center'; ctx.fillStyle=isActive?ACCENT:stroke; ctx.fillText('/'+val,x+w/2,y+h/2+3);
				hitBoxes.push({x,y,w,h,key,label:key.toUpperCase(),hint,min,max});
			};
			const hLine = (x1:number,y:number,x2:number) => { ctx.strokeStyle=WIRE; ctx.lineWidth=1.5; ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(x1,y); ctx.lineTo(x2,y); ctx.stroke(); };
			const elbow = (x1:number,y1:number,turnX:number,x2:number,y2:number) => {
				ctx.strokeStyle=WIRE; ctx.lineWidth=1.5; ctx.setLineDash([]);
				ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(turnX,y1); ctx.lineTo(turnX,y2); ctx.lineTo(x2,y2); ctx.stroke();
			};

			// ── Proportional layout ───────────────────────────────────────────
			// Rows:  mainY=110  (HSE, PLL, SYSCLK, HCLK)
			//        apb1Y=40   (APB1 output box, top branch)
			//        pll48Y=190 (PLL48, bottom-left branch)
			//        apb2Y=190  (APB2 output box, bottom-right branch)
			const mainY = Math.round(H * 0.42);
			const apb1Y = Math.round(H * 0.06);
			const apb2Y = Math.round(H * 0.72);
			const pll48Y = Math.round(H * 0.72);
			const BH = Math.round(H * 0.24); const BW = Math.max(66, Math.min(90, W * 0.085));
			const pad = 16;

			// Column x-positions as fractions of W
			const hseX   = pad;
			const divMX  = hseX + BW + 10;
			const pllX   = divMX + 36;
			const pllW   = BW + 20;
			const pllH   = BH + 10;
			const divPX  = pllX + pllW + 8;
			const sysclkX = divPX + 36;
			const divAhbX = sysclkX + BW + 10;
			const hclkX   = divAhbX + 36;
			// APB branches start after HCLK
			const branchX = hclkX + BW + 10;
			const divApb1X = branchX + 14;
			const divApb2X = branchX + 14;
			const apb1X   = divApb1X + 36;
			const apb2X   = divApb2X + 36;
			// PLL48 under PLL /Q output
			const divQX   = pllX + pllW + 8;
			const pll48X  = divQX + 36;

			// ── Draw ──────────────────────────────────────────────────────────
			// HSE
			node(hseX, mainY-BH/2, BW, BH, BORDER, 'HSE', `${st.hse} MHz`, 'Crystal', 'hse', 'HSE frequency (MHz)', 1, 50);
			hLine(hseX+BW, mainY, divMX);
			divider(divMX, mainY-12, String(st.m), ORANGE, 'm', `PLLM (${constraints.mRange[0]}-${constraints.mRange[1]})`, constraints.mRange[0], constraints.mRange[1]);
			hLine(divMX+34, mainY, pllX);

			// PLL block — taller, shows xN multiplier + VCO
			const pllPy = mainY - pllH/2;
			roundRect(pllX, pllPy, pllW, pllH, OK?GREEN:RED);
			ctx.font='8px system-ui'; ctx.textAlign='center'; ctx.fillStyle=DIM; ctx.fillText('PLL', pllX+pllW/2, pllPy+10);
			ctx.font='bold 12px monospace'; ctx.textAlign='center'; ctx.fillStyle=OK?GREEN:RED; ctx.fillText('x'+st.n, pllX+pllW/2, pllPy+pllH/2+3);
			const vcoMHz = st.hse/st.m*st.n;
			ctx.font='8px system-ui'; ctx.fillStyle=DIM; ctx.fillText(`VCO ${vcoMHz.toFixed(0)} MHz`, pllX+pllW/2, pllPy+pllH-6);
			hitBoxes.push({x:pllX,y:pllPy,w:pllW,h:pllH,key:'n',label:'PLLN',hint:`PLLN (${constraints.nRange[0]}-${constraints.nRange[1]})`,min:constraints.nRange[0],max:constraints.nRange[1]});

			// /P output → SYSCLK (top output from PLL right side)
			const pllRightX = pllX + pllW;
			const pllTopOutY = mainY - 16;
			hLine(pllRightX, pllTopOutY, divPX);
			divider(divPX, pllTopOutY-12, String(st.p), ACCENT, 'p', `PLLP (${constraints.pValues.join('/')})`, constraints.pValues[0], constraints.pValues[constraints.pValues.length-1]);
			hLine(divPX+34, pllTopOutY, sysclkX);

			// SYSCLK
			node(sysclkX, pllTopOutY-BH/2, BW, BH, OK?GREEN:RED, 'SYSCLK', cv?`${cv.sysclkMHz.toFixed(0)} MHz`:'--');
			hLine(sysclkX+BW, pllTopOutY, divAhbX);
			divider(divAhbX, pllTopOutY-12, String(st.ahb), WIRE, 'ahb', 'AHB Prescaler (1/2/4/8/16)', 1, 16);
			hLine(divAhbX+34, pllTopOutY, hclkX);

			// HCLK
			node(hclkX, pllTopOutY-BH/2, BW, BH, OK?GREEN:BORDER, 'HCLK', cv?`${cv.hclkMHz.toFixed(0)} MHz`:'--');

			// APB1 branch (top)
			const sH = Math.round(BH * 0.72); // small node height
			const hclkMidY = pllTopOutY;
			const hclkRightX = hclkX + BW;
			const apb1MidY = apb1Y + Math.round(sH/2);
			const apb2MidY = apb2Y + Math.round(sH/2);
			const pll48MidY = pll48Y + Math.round(sH/2);
			const dW = 26; // divider width
			elbow(hclkRightX, hclkMidY, branchX+13, divApb1X, apb1MidY);
			divider(divApb1X, apb1MidY-9, String(st.apb1), ORANGE, 'apb1', `APB1 max ${constraints.apb1Max} MHz`, 1, 16);
			hLine(divApb1X+dW, apb1MidY, apb1X);
			node(apb1X, apb1Y, BW, sH, OK?GREEN:BORDER, 'APB1', cv?`${cv.apb1MHz.toFixed(0)} MHz`:'--');

			// APB2 branch (bottom)
			elbow(hclkRightX, hclkMidY, branchX+13, divApb2X, apb2MidY);
			divider(divApb2X, apb2MidY-9, String(st.apb2), ORANGE, 'apb2', `APB2 max ${constraints.apb2Max} MHz`, 1, 16);
			hLine(divApb2X+dW, apb2MidY, apb2X);
			node(apb2X, apb2Y, BW, sH, OK?GREEN:BORDER, 'APB2', cv?`${cv.apb2MHz.toFixed(0)} MHz`:'--');

			// /Q output → PLL48 (bottom output from PLL)
			const pllBotOutY = mainY + Math.round(pllH * 0.28);
			elbow(pllRightX, pllBotOutY, divQX+13, divQX, pll48MidY);
			divider(divQX, pll48MidY-9, String(st.q), PURPLE, 'q', `PLLQ (${constraints.qRange[0]}-${constraints.qRange[1]})`, constraints.qRange[0], constraints.qRange[1]);
			hLine(divQX+dW, pll48MidY, pll48X);
			node(pll48X, pll48Y, BW, sH, PURPLE, 'PLL48', cv?`${cv.pll48MHz.toFixed(1)} MHz`:'--', 'USB/SDIO');
		};

		const updateStatus = () => {
			const result = this._clockTreeSvc.validate({m:st.m,n:st.n,p:st.p,q:st.q}, st.hse, st.ahb, st.apb1, st.apb2, family);
			while(errStrip.firstChild){errStrip.removeChild(errStrip.firstChild);}
			if(result.valid){
				const cv = result.computedValues;
				statusCells['SYSCLK']!.textContent = `${cv.sysclkMHz.toFixed(0)} MHz`;
				statusCells['HCLK']!.textContent   = `${cv.hclkMHz.toFixed(0)} MHz`;
				statusCells['APB1']!.textContent   = `${cv.apb1MHz.toFixed(0)} MHz`;
				statusCells['APB2']!.textContent   = `${cv.apb2MHz.toFixed(0)} MHz`;
				statusCells['PLL48']!.textContent  = `${cv.pll48MHz.toFixed(2)} MHz`;
				statusCells['VCO']!.textContent    = `${cv.vcoMHz.toFixed(0)} MHz`;
				statusCells['Flash WS']!.textContent = `${cv.flashWaitStates} WS`;
				for(const v of Object.values(statusCells)){v.style.color='#4caf50';}
				statusCells['SYSCLK']!.style.color='var(--vscode-focusBorder)';
			} else {
				for(const v of Object.values(statusCells)){v.textContent='--';v.style.color='var(--vscode-descriptionForeground)';}
				for(const e of result.errors.slice(0,3)){
					const row=$e('div','font-size:10px;color:#f48771;padding:1px 0;');
					row.appendChild($t('span',e.field+': ','font-weight:700;font-family:monospace;'));
					row.appendChild($t('span',e.message,''));
					errStrip.appendChild(row);
				}
			}
		};

		// Hit testing + click to edit
		const getHit = (mx:number,my:number) => hitBoxes.find(b=>mx>=b.x&&mx<=b.x+b.w&&my>=b.y&&my<=b.y+b.h) ?? null;

		// Tooltip element
		const tooltip = $e('div', 'position:absolute;display:none;pointer-events:none;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-widget-border);border-radius:4px;padding:4px 8px;font-size:10px;color:var(--vscode-foreground);z-index:20;white-space:nowrap;');
		canvasWrap.appendChild(tooltip);

		let hoverKey: string | null = null;
		canvas.addEventListener('mousemove', (e) => {
			const rect=canvas.getBoundingClientRect(); const mx=(e.clientX-rect.left)*(canvas.width/rect.width/window.devicePixelRatio), my=(e.clientY-rect.top)*(canvas.height/rect.height/window.devicePixelRatio);
			const hit=getHit(mx,my);
			canvas.style.cursor = hit ? 'pointer' : 'default';
			if(hit?.key !== hoverKey){ hoverKey = hit?.key ?? null; drawDiagram(); }
			if(hit){
				tooltip.textContent = hit.hint || hit.label;
				tooltip.style.display='block';
				tooltip.style.left=`${e.clientX-rect.left+10}px`;
				tooltip.style.top=`${e.clientY-rect.top-28}px`;
			} else {
				tooltip.style.display='none';
			}
		});
		canvas.addEventListener('mouseleave', () => { tooltip.style.display='none'; hoverKey=null; drawDiagram(); });

		canvas.addEventListener('click', (e) => {
			const rect=canvas.getBoundingClientRect(); const mx=e.clientX-rect.left, my=e.clientY-rect.top;
			const hit=getHit(mx,my);
			if(!hit){ editor.style.display='none'; activeKey=null; drawDiagram(); return; }
			activeKey=hit.key;
			editorLabel.textContent=hit.label;
			editorInput.value=String(st[hit.key]);
			editorHint.textContent=hit.hint;
			// Position editor above/below the block
			const cx=hit.x+hit.w/2; const cy=hit.y;
			editor.style.display='flex';
			editor.style.left=`${Math.min(cx-55, canvas.offsetWidth-130)}px`;
			editor.style.top=`${Math.max(cy-70,4)}px`;
			editorInput.focus(); editorInput.select();
			drawDiagram();
		});

		editorInput.addEventListener('keydown', (e) => {
			if(e.key==='Enter'||e.key==='Escape'){
				if(e.key==='Enter'&&activeKey){
					const v=parseFloat(editorInput.value);
					if(!isNaN(v)){
						const hit=hitBoxes.find(b=>b.key===activeKey);
						if(hit){ (st as Record<string,number>)[activeKey]=Math.round(Math.min(hit.max,Math.max(hit.min,v))); }
					}
				}
				editor.style.display='none'; activeKey=null;
				drawDiagram(); updateStatus();
			}
		});

		editorInput.addEventListener('blur', () => {
			if(activeKey){
				const v=parseFloat(editorInput.value);
				if(!isNaN(v)){
					const hit=hitBoxes.find(b=>b.key===activeKey);
					if(hit){ (st as Record<string,number>)[activeKey]=Math.round(Math.min(hit.max,Math.max(hit.min,v))); }
				}
			}
			editor.style.display='none'; activeKey=null;
			drawDiagram(); updateStatus();
		});

		// Initial render + resize
		const ro = new ResizeObserver(() => { drawDiagram(); });
		ro.observe(canvasWrap);
		drawDiagram(); updateStatus();

		// ── Async: read real PLL config from project files ────────────────────
		this._clockTreeSvc.readProjectClockConfig().then(cfg => {
			if (!cfg) {
				srcBadge.textContent = 'No project config — solver defaults';
				srcBadge.style.color = 'var(--vscode-descriptionForeground)';
				return;
			}
			// Apply real values — only override fields we actually found
			if (cfg.hseMHz !== undefined) { st.hse  = cfg.hseMHz; }
			if (cfg.m      !== undefined) { st.m    = cfg.m; }
			if (cfg.n      !== undefined) { st.n    = cfg.n; }
			if (cfg.p      !== undefined) { st.p    = cfg.p; }
			if (cfg.q      !== undefined) { st.q    = cfg.q; }
			if (cfg.ahbPrescaler  !== undefined) { st.ahb  = cfg.ahbPrescaler; }
			if (cfg.apb1Prescaler !== undefined) { st.apb1 = cfg.apb1Prescaler; }
			if (cfg.apb2Prescaler !== undefined) { st.apb2 = cfg.apb2Prescaler; }
			// Update source badge
			const fname = cfg.sourceFile ? cfg.sourceFile.split('/').pop()! : 'project file';
			srcBadge.textContent = `From ${fname} (${cfg.confidence} confidence)`;
			srcBadge.style.borderColor = cfg.confidence === 'high' ? 'rgba(76,175,80,0.4)' : 'rgba(224,168,78,0.4)';
			srcBadge.style.color = cfg.confidence === 'high' ? '#81c784' : '#e0a84e';
			drawDiagram(); updateStatus();
		}).catch(() => {
			srcBadge.textContent = 'Could not scan project';
		});
	}

	// ─── Memory Panel ─────────────────────────────────────────────────────────

	private _renderMemoryPanel(root: HTMLElement, s: IFirmwareSessionData): void {
		const hdr = $e('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-shrink:0;');
		const hdrLeft = $e('div');
		hdrLeft.appendChild($t('span', 'Memory & Linker', 'font-size:13px;font-weight:700;'));
		hdrLeft.appendChild($t('span', ' — DMA-access hazard warnings + GNU .ld generator', 'font-size:11px;color:var(--vscode-descriptionForeground);margin-left:8px;'));
		hdr.appendChild(hdrLeft);
		root.appendChild(hdr);

		if (!s.mcuConfig) {
			root.appendChild(this._emptyState('No MCU Selected', 'Start a firmware session with an MCU to use the memory tools.'));
			return;
		}

		const mcu = s.mcuConfig;
		const rtos = s.rtos ?? 'none';
		const family = mcu.family.toUpperCase();

		// ── Canvas memory map bar — driven by real .map file ─────────────────
		const flashOrigin = this._memoryLayoutSvc.getFlashOrigin();
		const ramOrigin   = this._memoryLayoutSvc.getRamOrigin();

		// Section color palette
		const SECT_COLOR: Record<string,string> = {
			'.isr_vector':'#546e7a', '.text':'#1565c0', '.rodata':'#00695c',
			'.data':'#e65100', '.bss':'#6a1b9a', '.heap':'#1b5e20',
			'.stack':'#b71c1c', '.heap+stack':'#7b1fa2', 'other':'#37474f', 'free':'#1a2332',
		};

		type MemSect = { label:string; size:number; color:string; };

		const barCanvas = $e('canvas','display:block;width:100%;flex-shrink:0;') as HTMLCanvasElement;
		const barTip = $e('div','position:fixed;display:none;pointer-events:none;background:var(--vscode-editorWidget-background,#1e1e1e);border:1px solid var(--vscode-widget-border);border-radius:4px;padding:4px 8px;font-size:10px;z-index:100;');
		document.body.appendChild(barTip);
		const cleanupBarTip=()=>{if(barTip.parentNode){barTip.parentNode.removeChild(barTip);}};
		setTimeout(cleanupBarTip, 300000);

		// State: null = loading, budget = parsed, 'none' = no map file
		let budget: import('../engine/memory/mapFileParser.js').IParsedMapFile | null | 'none' = null;
		let flashSects: MemSect[] = [];
		let ramSects:   MemSect[] = [];

		const buildSects = (regions: import('../engine/memory/memoryTypes.js').IRegionBudget[], total: number, isFlash: boolean): MemSect[] => {
			const out: MemSect[] = [];
			let used = 0;
			// Group by category
			const cats = new Map<string,number>();
			for (const r of regions) {
				for (const sec of r.sections) {
					// Categorise
					let cat = sec.name;
					if (sec.name.startsWith('.text') || sec.name.startsWith('.init') || sec.name.startsWith('.fini') || sec.name.startsWith('.ARM.ex')) cat = sec.name.startsWith('.rodata') || sec.name.startsWith('.ARM') ? '.rodata' : '.text';
					if (sec.name.startsWith('.rodata')) cat = '.rodata';
					if (sec.name.startsWith('.isr_vector')) cat = '.isr_vector';
					if (sec.name.startsWith('.data') || sec.name.startsWith('.fast') || sec.name.startsWith('.ram')) cat = '.data';
					if (sec.name.startsWith('.bss') || sec.name.startsWith('.noinit')) cat = '.bss';
					if (sec.name.includes('heap')) cat = '.heap';
					if (sec.name.includes('stack') || sec.name.includes('Stack')) cat = '.stack';
					cats.set(cat, (cats.get(cat)??0) + sec.size);
					used += sec.size;
				}
			}
			const order = isFlash ? ['.isr_vector','.text','.rodata','other'] : ['.data','.bss','.heap','.stack','other'];
			for (const lbl of order) {
				const sz = cats.get(lbl)??0;
				if (sz > 0) { out.push({label:lbl, size:sz, color:SECT_COLOR[lbl]??'#37474f'}); cats.delete(lbl); }
			}
			// Remaining categories
			for (const [lbl,sz] of cats) {
				if (sz > 0) out.push({label:lbl, size:sz, color:SECT_COLOR[lbl]??'#37474f'});
			}
			const free = total - used;
			if (free > 0) out.push({label:'free', size:free, color:'#1a2332'});
			return out;
		};

		const drawBar = () => {
			const DPR = window.devicePixelRatio||1;
			const W = barCanvas.parentElement?.clientWidth||600;
			const isLoading = budget === null;
			const noMap     = budget === 'none';
			const H = noMap ? 48 : 90;
			barCanvas.width=W*DPR; barCanvas.height=H*DPR; barCanvas.style.height=H+'px';
			const ctx = barCanvas.getContext('2d')!;
			ctx.scale(DPR,DPR);
			ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,W,H);

			if (isLoading) {
				ctx.fillStyle='rgba(255,255,255,0.3)'; ctx.font='11px system-ui'; ctx.textAlign='center';
				ctx.fillText('Scanning for .map file...', W/2, H/2+4);
				return;
			}
			if (noMap) {
				ctx.fillStyle='rgba(255,255,255,0.25)'; ctx.font='10px system-ui'; ctx.textAlign='center';
				ctx.fillText('No .map file found — build the project or drag a .map file here', W/2, H/2+4);
				ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.lineWidth=1; ctx.strokeRect(0,0,W,H);
				return;
			}

			const barH=22; const pad=8; const lblW=52; const barW=W-lblW-pad*2-40;

			const drawRow = (label:string, total:number, sects:MemSect[], y:number, usedBytes:number) => {
				ctx.fillStyle='rgba(255,255,255,0.55)'; ctx.font='bold 9px system-ui'; ctx.textAlign='right';
				ctx.fillText(label, lblW-4, y+barH/2+3);
				let x = lblW+pad;
				for(const sec of sects){
					const sw = Math.round((sec.size/total)*barW);
					if(sw<1) continue;
					ctx.fillStyle=sec.color; ctx.fillRect(x,y,sw,barH);
					if(sw>28){
						ctx.fillStyle='rgba(255,255,255,0.75)'; ctx.font='8px monospace'; ctx.textAlign='center';
						ctx.fillText(sec.label, x+sw/2, y+barH/2+3);
					}
					x+=sw;
				}
				ctx.strokeStyle='rgba(255,255,255,0.12)'; ctx.lineWidth=0.5;
				ctx.strokeRect(lblW+pad, y, barW, barH);
				// Usage text: "12.4 KB / 64 KB (19%)"
				const pct = total>0?Math.round(usedBytes/total*100):0;
				ctx.fillStyle='rgba(255,255,255,0.45)'; ctx.font='8px monospace'; ctx.textAlign='left';
				ctx.fillText(`${_fmt(usedBytes)} / ${_fmt(total)} (${pct}%)`, lblW+pad+barW+6, y+barH/2+3);
			};

			const bud = budget as import('../engine/memory/mapFileParser.js').IParsedMapFile;
			const flashReg = bud.flashRegions[0];
			const ramReg   = bud.ramRegions[0];
			if (flashReg) drawRow('FLASH', flashReg.size, flashSects, pad, flashReg.used);
			if (ramReg)   drawRow('RAM',   ramReg.size,   ramSects,   pad+(flashReg?barH+10:0), ramReg.used);

			// Legend
			const allSects = [...flashSects, ...ramSects].filter(s=>s.label!=='free');
			const seen = new Set<string>();
			const unique = allSects.filter(s=>{ if(seen.has(s.label))return false; seen.add(s.label); return true; });
			let lx = lblW+pad; const ly = pad+(flashReg?barH+10:0)+(ramReg?barH:0)+12;
			ctx.font='8px system-ui';
			for(const s of unique){
				ctx.fillStyle=s.color; ctx.fillRect(lx,ly,8,8);
				ctx.fillStyle='rgba(255,255,255,0.45)'; ctx.textAlign='left';
				ctx.fillText(s.label, lx+10, ly+7);
				lx+=ctx.measureText(s.label).width+22;
				if (lx > W-60) break;
			}
		};

		// Hover hit-test
		barCanvas.addEventListener('mousemove',(e)=>{
			if(budget===null||budget==='none'){return;}
			const bud = budget as import('../engine/memory/mapFileParser.js').IParsedMapFile;
			const r=barCanvas.getBoundingClientRect();
			const mx=(e.clientX-r.left); const my=(e.clientY-r.top);
			const pad=8; const lblW=52; const barW=(barCanvas.offsetWidth||600)-lblW-pad*2-40;
			const flashReg=bud.flashRegions[0]; const ramReg=bud.ramRegions[0];
			const rows: [MemSect[],number,number][] = [];
			if(flashReg) rows.push([flashSects,flashReg.size,pad]);
			if(ramReg)   rows.push([ramSects,  ramReg.size,  pad+(flashReg?22+10:0)]);
			let hit: MemSect|null=null; let total=0;
			for(const [sects,tot,ry] of rows){
				if(my>=ry&&my<=ry+22&&mx>=lblW+pad&&mx<=lblW+pad+barW){
					let x=lblW+pad; total=tot;
					for(const sec of sects){
						const sw=Math.round((sec.size/tot)*barW);
						if(mx>=x&&mx<=x+sw){hit=sec; break;}
						x+=sw;
					}
				}
			}
			if(hit){barTip.textContent=`${hit.label}: ${_fmt(hit.size)} (${Math.round(hit.size/total*100)}%)`;barTip.style.display='block';barTip.style.left=(e.clientX+12)+'px';barTip.style.top=(e.clientY-24)+'px';}
			else{barTip.style.display='none';}
		});
		barCanvas.addEventListener('mouseleave',()=>{barTip.style.display='none';});

		// Drop zone: accept .map files dragged onto canvas
		barCanvas.addEventListener('dragover',(e)=>{e.preventDefault();});
		barCanvas.addEventListener('drop',(e)=>{
			e.preventDefault();
			const file=e.dataTransfer?.files[0];
			if(!file||!file.name.endsWith('.map')){return;}
			const reader=new FileReader();
			reader.onload=()=>{
				const { parseMapFile: pmf, groupSectionsForChart: gsc } = (globalThis as Record<string,unknown>)['__niMapParser'] as never ?? {};
				void pmf; void gsc;
				// inline parse since we can't async import here
				import('../engine/memory/mapFileParser.js').then(mod=>{
					const bud2 = mod.parseMapFile(String(reader.result), mcu.flashSize, mcu.ramSize);
					const synth = {flashRegions:bud2.regions.filter(r=>r.name.toUpperCase().includes('FLASH')||r.origin<0x20000000), ramRegions:bud2.regions.filter(r=>r.name.toUpperCase().includes('RAM')||r.origin>=0x20000000), warnings:bud2.warnings};
					budget = synth as never;
					flashSects = buildSects(synth.flashRegions, mcu.flashSize, true);
					ramSects   = buildSects(synth.ramRegions,   mcu.ramSize,   false);
					drawBar();
					// update usage bars in stat row
					updateUsageBars(bud2.totalFlashUsed, mcu.flashSize, bud2.totalRAMUsed, mcu.ramSize);
				}).catch(()=>{});
			};
			reader.readAsText(file);
		});

		root.appendChild(barCanvas);
		const roBar=new ResizeObserver(()=>drawBar()); roBar.observe(barCanvas.parentElement!);
		drawBar(); // show loading state

		// Async: scan workspace for .map file
		this._memoryLayoutSvc.parseWorkspaceMapFile().then(bud2=>{
			if(!bud2){ budget='none'; drawBar(); return; }
			const synth = {flashRegions:bud2.regions.filter(r=>r.name.toUpperCase().includes('FLASH')||r.origin<0x20000000), ramRegions:bud2.regions.filter(r=>r.name.toUpperCase().includes('RAM')||r.origin>=0x20000000), warnings:bud2.warnings};
			budget = synth as never;
			flashSects = buildSects(synth.flashRegions, mcu.flashSize, true);
			ramSects   = buildSects(synth.ramRegions,   mcu.ramSize,   false);
			drawBar();
			updateUsageBars(bud2.totalFlashUsed, mcu.flashSize, bud2.totalRAMUsed, mcu.ramSize);
		}).catch(()=>{ budget='none'; drawBar(); });

		// ── Compact stats row ─────────────────────────────────────────────────
		let flashUsedBar: HTMLElement, ramUsedBar: HTMLElement;
		const updateUsageBars = (flashUsed:number, flashTot:number, ramUsed:number, ramTot:number) => {
			if(flashUsedBar){ flashUsedBar.style.width=`${Math.min(100,Math.round(flashUsed/flashTot*100))}%`; flashUsedBar.style.background=flashUsed/flashTot>0.9?'#f48771':'var(--vscode-focusBorder)'; }
			if(ramUsedBar){   ramUsedBar.style.width=`${Math.min(100,Math.round(ramUsed/ramTot*100))}%`;     ramUsedBar.style.background=ramUsed/ramTot>0.9?'#f48771':'var(--vscode-focusBorder)'; }
		};

		const statRow = $e('div', 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;margin-bottom:10px;flex-shrink:0;');
		const memStat = (label: string, size: number, origin: string): HTMLElement => {
			const c = $e('div', 'border:1px solid var(--vscode-widget-border);border-radius:5px;padding:8px 12px;');
			const top=$e('div','display:flex;align-items:center;gap:8px;margin-bottom:5px;');
			top.appendChild($t('span', _fmt(size), 'font-size:18px;font-weight:700;font-family:monospace;'));
			top.appendChild($t('span', ' '+label, 'font-size:10px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.05em;'));
			top.appendChild($t('div', `@ ${origin}`, 'font-size:10px;font-family:monospace;color:var(--vscode-descriptionForeground);margin-left:auto;'));
			c.appendChild(top);
			const track=$e('div','height:3px;border-radius:2px;background:var(--vscode-widget-border);');
			const fill=$e('div','height:100%;border-radius:2px;background:var(--vscode-focusBorder);width:0%;transition:width 0.4s;');
			track.appendChild(fill); c.appendChild(track);
			return c;
		};
		const flashCard = memStat('Flash', mcu.flashSize, flashOrigin);
		const ramCard   = memStat('RAM',   mcu.ramSize,   ramOrigin);
		flashUsedBar = flashCard.querySelector('div div') as HTMLElement;
		ramUsedBar   = ramCard.querySelector('div div') as HTMLElement;
		statRow.appendChild(flashCard);
		statRow.appendChild(ramCard);
		root.appendChild(statRow);

		// ── Region table ───────────────────────────────────────────────────────
		root.appendChild(this._hwPanelSection('Memory Regions', 'All memory regions for this MCU with DMA accessibility. DMA buffers placed in NO-access regions will silently fail.'));
		const table = $e('div', 'border:1px solid var(--vscode-widget-border);border-radius:7px;overflow:hidden;margin-bottom:20px;');
		const tHdr = $e('div', 'display:grid;grid-template-columns:100px 110px 70px 52px 1fr;gap:12px;padding:8px 14px;background:var(--vscode-sideBarSectionHeader-background);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-descriptionForeground);');
		['Region', 'Origin', 'Size', 'DMA', 'Notes'].forEach(h => tHdr.appendChild($t('div', h)));
		table.appendChild(tHdr);
		const memRows: Array<[string, string, string, 'YES'|'NO'|'n/a', string, boolean]> = [
			['FLASH', '0x08000000', _fmt(mcu.flashSize), 'n/a', 'Code + read-only data', false],
			['RAM', '0x20000000', _fmt(mcu.ramSize), 'YES', 'Main SRAM — stack, heap, .data, .bss', false],
		];
		if (family.startsWith('STM32F4') && mcu.ramSize > 128 * 1024) {
			memRows.push(['CCMRAM', '0x10000000', '64 KB', 'NO', 'Core-Coupled Memory — CPU-only, never place DMA buffers here', true]);
		}
		if (family.startsWith('STM32F7')) {
			memRows.push(['DTCM', '0x20000000', '128 KB', 'NO', 'Data TCM — CPU zero-wait-state, not DMA-accessible', true]);
			memRows.push(['SRAM1', '0x20020000', '240 KB', 'YES', 'Main DMA-accessible SRAM — use for DMA buffers', false]);
		}
		if (family.startsWith('STM32H7')) {
			memRows.push(['AXI_SRAM', '0x24000000', '512 KB', 'YES', 'DMA-accessible via AXI bus', false]);
			memRows.push(['DTCM', '0x20000000', '128 KB', 'NO', 'CPU-only — no DMA access', true]);
		}
		for (const [region, origin, size, dma, notes, hazard] of memRows) {
			const row = $e('div', `display:grid;grid-template-columns:100px 110px 70px 52px 1fr;gap:12px;padding:7px 14px;font-size:11px;border-top:1px solid var(--vscode-widget-border);${hazard ? 'background:rgba(244,135,113,0.04);' : ''}`);
			row.appendChild($t('div', region, 'font-weight:700;font-family:monospace;'));
			row.appendChild($t('div', origin, 'font-family:monospace;color:var(--vscode-descriptionForeground);font-size:10px;'));
			row.appendChild($t('div', size, 'font-family:monospace;'));
			const dmaEl = $t('div', dma, `font-weight:700;color:${dma === 'NO' ? 'var(--vscode-errorForeground,#f48771)' : dma === 'YES' ? '#4caf50' : 'var(--vscode-descriptionForeground)'};`);
			row.appendChild(dmaEl);
			row.appendChild($t('div', notes, `font-size:10px;color:${hazard ? 'var(--vscode-errorForeground,#f48771)' : 'var(--vscode-descriptionForeground)'};`));
			table.appendChild(row);
		}
		root.appendChild(table);

		// ── Linker script generator ────────────────────────────────────────────
		root.appendChild(this._hwPanelSection('Generate Linker Script', 'Generates a complete GNU linker script (.ld) from the MCU memory map. Configure stack and heap for your RTOS.'));

		const configRow = $e('div', 'display:flex;gap:12px;align-items:flex-end;margin-bottom:14px;');
		const stackIn = this._hwLabeledInput('Stack size (bytes)', `default: ${rtos === 'freertos' ? '2048' : '1024'}`, rtos === 'freertos' ? '2048' : '1024', '120px');
		const heapIn  = this._hwLabeledInput('Heap size (bytes)', `default: ${rtos === 'freertos' ? '16384' : '512'}`, rtos === 'freertos' ? '16384' : '512', '120px');
		const copyLdBtn = this._btn('Copy', false, () => {
			const ta = root.querySelector<HTMLTextAreaElement>('[data-ld-out]')!;
			if (ta.value) { navigator.clipboard.writeText(ta.value); copyLdBtn.textContent = 'Copied!'; setTimeout(() => copyLdBtn.textContent = 'Copy', 2000); }
		}, 'font-size:11px;padding:5px 14px;');
		const regenBtn = this._btn('Regenerate', true, () => {
			const ta = root.querySelector<HTMLTextAreaElement>('[data-ld-out]')!;
			ta.value = this._memoryLayoutSvc.generateLinkerScript({ stackSize: +stackIn.input.value, heapSize: +heapIn.input.value });
		}, 'font-size:11px;padding:5px 14px;');
		configRow.appendChild(stackIn.wrap); configRow.appendChild(heapIn.wrap); configRow.appendChild(regenBtn); configRow.appendChild(copyLdBtn);
		root.appendChild(configRow);

		const ldOut = $e('textarea', [
			'width:100%', 'min-height:380px', 'resize:vertical',
			'font-family:var(--vscode-editor-font-family,monospace)', 'font-size:11px', 'line-height:1.5',
			'padding:12px', 'border:1px solid var(--vscode-widget-border)', 'border-radius:6px',
			'background:var(--vscode-editor-background)', 'color:var(--vscode-editor-foreground)',
			'outline:none', 'box-sizing:border-box',
		].join(';')) as HTMLTextAreaElement;
		ldOut.readOnly = true;
		ldOut.dataset.ldOut = '';
		ldOut.value = this._memoryLayoutSvc.generateLinkerScript();
		root.appendChild(ldOut);
	}

	// ─── Register Compositor Panel ────────────────────────────────────────────

	private _renderRegisterCompositorPanel(root: HTMLElement, _s: IFirmwareSessionData): void {
		// ── Header ────────────────────────────────────────────────────────────
		const hdr = $e('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-shrink:0;');
		const hdrLeft = $e('div');
		hdrLeft.appendChild($t('span', 'Register Composer', 'font-size:13px;font-weight:700;'));
		hdrLeft.appendChild($t('span', ' — 32-bit SVD bit field viewer & diff', 'font-size:11px;color:var(--vscode-descriptionForeground);margin-left:8px;'));
		hdr.appendChild(hdrLeft);

		// Mode toggle: Decode | Diff
		const modeWrap = $e('div', 'display:flex;gap:0;border:1px solid var(--vscode-widget-border);border-radius:4px;overflow:hidden;');
		type Mode = 'decode' | 'diff';
		let mode: Mode = 'decode';
		const modeDecBtn = $e('div', 'padding:3px 10px;font-size:10px;cursor:pointer;background:var(--vscode-button-background);color:var(--vscode-button-foreground);');
		const modeDifBtn = $e('div', 'padding:3px 10px;font-size:10px;cursor:pointer;background:transparent;color:var(--vscode-descriptionForeground);border-left:1px solid var(--vscode-widget-border);');
		modeDecBtn.textContent = 'Decode'; modeDifBtn.textContent = 'Diff';
		modeWrap.appendChild(modeDecBtn); modeWrap.appendChild(modeDifBtn);
		hdr.appendChild(modeWrap);
		root.appendChild(hdr);

		// ── Selector row ──────────────────────────────────────────────────────
		const selRow = $e('div', 'display:flex;gap:8px;align-items:flex-end;margin-bottom:8px;flex-shrink:0;flex-wrap:wrap;');
		const periphIn = this._hwLabeledInput('Peripheral', 'e.g. USART1', 'USART1', '110px');
		const regIn    = this._hwLabeledInput('Register', 'e.g. CR1', 'CR1', '80px');
		const valIn    = this._hwLabeledInput('Value', 'hex or dec', '0x200C', '100px');
		const beforeIn = this._hwLabeledInput('Before', 'hex or dec', '0x2000', '90px');
		const afterIn  = this._hwLabeledInput('After', 'hex or dec', '0x200C', '90px');
		beforeIn.wrap.style.display = 'none'; afterIn.wrap.style.display = 'none';
		const goBtn = this._btn('Decode', true, () => run(), 'font-size:10px;padding:4px 12px;align-self:flex-end;');
		selRow.appendChild(periphIn.wrap); selRow.appendChild(regIn.wrap);
		selRow.appendChild(valIn.wrap); selRow.appendChild(beforeIn.wrap); selRow.appendChild(afterIn.wrap);
		selRow.appendChild(goBtn);
		root.appendChild(selRow);

		const setMode = (m: Mode) => {
			mode = m;
			modeDecBtn.style.background = m === 'decode' ? 'var(--vscode-button-background)' : 'transparent';
			modeDecBtn.style.color = m === 'decode' ? 'var(--vscode-button-foreground)' : 'var(--vscode-descriptionForeground)';
			modeDifBtn.style.background = m === 'diff' ? 'var(--vscode-button-background)' : 'transparent';
			modeDifBtn.style.color = m === 'diff' ? 'var(--vscode-button-foreground)' : 'var(--vscode-descriptionForeground)';
			valIn.wrap.style.display = m === 'decode' ? '' : 'none';
			beforeIn.wrap.style.display = m === 'diff' ? '' : 'none';
			afterIn.wrap.style.display  = m === 'diff' ? '' : 'none';
			goBtn.textContent = m === 'decode' ? 'Decode' : 'Diff';
		};
		modeDecBtn.addEventListener('click', () => setMode('decode'));
		modeDifBtn.addEventListener('click', () => setMode('diff'));

		// ── Canvas bit field strip ────────────────────────────────────────────
		const canvasWrap = $e('div', 'position:relative;width:100%;flex-shrink:0;');
		const bitCanvas = $e('canvas', 'display:block;width:100%;') as HTMLCanvasElement;
		canvasWrap.appendChild(bitCanvas);
		root.appendChild(canvasWrap);

		// Tooltip
		const tip = $e('div', 'position:fixed;display:none;pointer-events:none;background:var(--vscode-editorWidget-background,#1e1e1e);border:1px solid var(--vscode-focusBorder);border-radius:4px;padding:5px 9px;font-size:10px;z-index:100;max-width:220px;line-height:1.5;');
		document.body.appendChild(tip);
		setTimeout(() => { if (tip.parentNode) tip.parentNode.removeChild(tip); }, 300000);

		// ── Field table below canvas ──────────────────────────────────────────
		const fieldTable = $e('div', 'margin-top:8px;flex-shrink:0;overflow-y:auto;');
		root.appendChild(fieldTable);

		// ── Error / status strip ──────────────────────────────────────────────
		const errStrip = $e('div', 'font-size:11px;min-height:16px;flex-shrink:0;margin-top:4px;color:var(--vscode-errorForeground,#f48771);');
		root.appendChild(errStrip);

		// Field color palette (by index mod 8)
		const FIELD_COLORS = ['#1565c0','#6a1b9a','#1b5e20','#e65100','#37474f','#00695c','#7b1fa2','#880e4f'];
		const CHANGED_COLOR = '#b71c1c';
		const UNCHANGED_DIM = '#1a2332';

		interface RenderedField { name: string; bitHigh: number; bitLow: number; value: number; access: string; description: string; changed?: boolean; beforeVal?: number; }

		const drawBitStrip = (fields: RenderedField[], regVal: number, isDiff: boolean, afterVal?: number) => {
			const DPR = window.devicePixelRatio || 1;
			const W = bitCanvas.parentElement!.clientWidth || 800;
			const H = 68;
			bitCanvas.width = W * DPR; bitCanvas.height = H * DPR;
			bitCanvas.style.height = H + 'px';
			const ctx = bitCanvas.getContext('2d')!;
			ctx.scale(DPR, DPR);
			ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);

			const pad = 8;
			const stripY = 20; const stripH = 32;
			const totalBits = 32;
			const bitW = (W - pad * 2) / totalBits;

			// Bit number labels top (31 down to 0)
			ctx.font = '7px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,0.25)';
			for (let b = 31; b >= 0; b--) {
				const x = pad + (31 - b) * bitW + bitW / 2;
				if (b % 4 === 0 || b === 31 || b === 0) { ctx.fillText(String(b), x, 12); }
			}

			// Draw each field as a colored group of bits
			for (let fi = 0; fi < fields.length; fi++) {
				const f = fields[fi]!;
				const col = isDiff && f.changed ? CHANGED_COLOR : (isDiff && !f.changed ? UNCHANGED_DIM : (FIELD_COLORS[fi % FIELD_COLORS.length]!));
				for (let b = f.bitLow; b <= f.bitHigh; b++) {
					const bitPos = 31 - b;
					const x = pad + bitPos * bitW;
					const bitSet = (regVal >> b) & 1;
					ctx.fillStyle = col;
					ctx.fillRect(x + 0.5, stripY, bitW - 1, stripH);
					// Bit value
					ctx.fillStyle = 'rgba(255,255,255,0.8)';
					ctx.font = 'bold 9px monospace'; ctx.textAlign = 'center';
					ctx.fillText(String(bitSet), x + bitW / 2, stripY + stripH / 2 + 4);
				}
				// Field name at bottom of group
				const groupW = (f.bitHigh - f.bitLow + 1) * bitW;
				const groupX = pad + (31 - f.bitHigh) * bitW;
				if (groupW > 10) {
					ctx.font = '8px system-ui'; ctx.textAlign = 'center';
					ctx.fillStyle = 'rgba(255,255,255,0.55)';
					const label = f.name.length > Math.floor(groupW / 5) ? f.name.slice(0, Math.floor(groupW / 5) - 1) + '..' : f.name;
					ctx.fillText(label, groupX + groupW / 2, stripY + stripH + 12);
				}
				// Separator line between fields
				if (f.bitLow > 0) {
					const sepX = pad + (31 - f.bitLow + 1) * bitW;
					ctx.strokeStyle = '#0d1117'; ctx.lineWidth = 1.5;
					ctx.beginPath(); ctx.moveTo(sepX, stripY); ctx.lineTo(sepX, stripY + stripH); ctx.stroke();
				}
			}

			// Unused bits (reserved/unassigned) shown as dark
			const coveredBits = new Set<number>();
			for (const f of fields) { for (let b = f.bitLow; b <= f.bitHigh; b++) coveredBits.add(b); }
			for (let b = 0; b < 32; b++) {
				if (coveredBits.has(b)) continue;
				const x = pad + (31 - b) * bitW;
				ctx.fillStyle = '#111820';
				ctx.fillRect(x + 0.5, stripY, bitW - 1, stripH);
				const bitSet = (regVal >> b) & 1;
				if (bitSet) {
					ctx.fillStyle = 'rgba(255,255,255,0.3)';
					ctx.font = '8px monospace'; ctx.textAlign = 'center';
					ctx.fillText('1', x + bitW / 2, stripY + stripH / 2 + 4);
				}
			}

			// Hex value display
			ctx.font = 'bold 10px monospace'; ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.5)';
			const hexVal = isDiff && afterVal !== undefined ? `0x${afterVal.toString(16).toUpperCase().padStart(8,'0')}` : `0x${regVal.toString(16).toUpperCase().padStart(8,'0')}`;
			ctx.fillText(hexVal, W - pad, 12);
		};

		// Hit test: which field is under cursor?
		const hitField = (mx: number, fields: RenderedField[]): RenderedField | null => {
			const W = bitCanvas.offsetWidth || 800;
			const pad = 8; const bitW = (W - pad * 2) / 32;
			const bit = Math.floor((W - pad - mx) / bitW);
			if (bit < 0 || bit > 31) return null;
			return fields.find(f => bit >= f.bitLow && bit <= f.bitHigh) || null;
		};

		let lastFields: RenderedField[] = [];
		let lastVal = 0;

		bitCanvas.addEventListener('mousemove', (e) => {
			const r = bitCanvas.getBoundingClientRect();
			const mx = (e.clientX - r.left) * (bitCanvas.width / r.width / window.devicePixelRatio);
			const f = hitField(mx, lastFields);
			if (f) {
				bitCanvas.style.cursor = 'pointer';
				const lines = [
					`${f.name}  [${f.bitHigh}:${f.bitLow}]  = 0x${f.value.toString(16).toUpperCase()} (${f.value})`,
					`Access: ${f.access || 'rw'}`,
					f.description || '',
					f.changed !== undefined ? (f.changed ? 'CHANGED' : 'unchanged') : '',
				].filter(Boolean);
				while (tip.firstChild) { tip.removeChild(tip.firstChild); }
				for (const l of lines) {
					tip.appendChild($t('div', l, l === 'CHANGED' ? 'color:#ef9a9a;font-weight:700;' : ''));
				}
				tip.style.display = 'block';
				tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY - 10) + 'px';
			} else {
				bitCanvas.style.cursor = 'default'; tip.style.display = 'none';
			}
		});
		bitCanvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; });

		// ── Field property table ──────────────────────────────────────────────
		const renderFieldTable = (fields: RenderedField[], isDiff: boolean) => {
			while (fieldTable.firstChild) { fieldTable.removeChild(fieldTable.firstChild); }
			if (!fields.length) { return; }
			const tbl = $e('div', 'border:1px solid var(--vscode-widget-border);border-radius:5px;overflow:hidden;');
			const cols = isDiff ? '80px 60px 50px 50px 50px 1fr' : '80px 60px 60px 40px 1fr';
			const th = $e('div', `display:grid;grid-template-columns:${cols};gap:8px;padding:5px 10px;background:var(--vscode-sideBarSectionHeader-background);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);`);
			const heads = isDiff ? ['Field','Bits','Before','After','Status','Description'] : ['Field','Bits','Value','Hex','Description'];
			heads.forEach(h => th.appendChild($t('div', h)));
			tbl.appendChild(th);
			for (let fi = 0; fi < fields.length; fi++) {
				const f = fields[fi]!;
				const changed = f.changed;
				const row = $e('div', `display:grid;grid-template-columns:${cols};gap:8px;padding:5px 10px;font-size:10px;font-family:monospace;border-top:1px solid var(--vscode-widget-border);${changed ? 'background:rgba(183,28,28,0.06);' : ''}`);
				const nameEl = $t('div', f.name, `font-weight:700;color:${isDiff && changed ? '#ef9a9a' : (FIELD_COLORS[fi % FIELD_COLORS.length]!)};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`);
				row.appendChild(nameEl);
				row.appendChild($t('div', `[${f.bitHigh}:${f.bitLow}]`, 'color:var(--vscode-descriptionForeground);'));
				if (isDiff) {
					row.appendChild($t('div', `0x${(f.beforeVal || 0).toString(16).toUpperCase()}`, 'color:var(--vscode-descriptionForeground);'));
					row.appendChild($t('div', `0x${f.value.toString(16).toUpperCase()}`, changed ? 'color:#ef9a9a;font-weight:700;' : ''));
					row.appendChild($t('div', changed ? 'CHANGED' : '', changed ? 'color:#ef9a9a;font-weight:700;' : 'color:var(--vscode-descriptionForeground);'));
				} else {
					row.appendChild($t('div', String(f.value), ''));
					row.appendChild($t('div', `0x${f.value.toString(16).toUpperCase()}`, 'color:var(--vscode-descriptionForeground);'));
				}
				row.appendChild($t('div', f.description || '', 'color:var(--vscode-descriptionForeground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'));
				tbl.appendChild(row);
			}
			fieldTable.appendChild(tbl);
		};

		// ── Run decode / diff ─────────────────────────────────────────────────
		const run = () => {
			while (errStrip.firstChild) { errStrip.removeChild(errStrip.firstChild); }
			const periph = periphIn.input.value.trim().toUpperCase();
			const reg    = regIn.input.value.trim().toUpperCase();
			const parse  = (v: string) => { const s = v.trim(); return parseInt(s, s.toLowerCase().startsWith('0x') ? 16 : 10); };

			if (mode === 'decode') {
				const num = parse(valIn.input.value);
				if (isNaN(num)) { errStrip.textContent = 'Invalid value — use hex (0x200C) or decimal.'; return; }
				const decoded = this._regCompositorSvc.decodeRegisterValue(periph, reg, num);
				if (!decoded) { errStrip.textContent = `${periph}.${reg} not found in loaded SVD. Load an SVD in Datasheets first.`; renderFieldTable([], false); return; }
				// Build RenderedField list from decoded result
				const text = this._regCompositorSvc.formatDecoded(decoded);
				const fields: RenderedField[] = this._parseDecodedFields(text, num);
				lastFields = fields; lastVal = num;
				drawBitStrip(fields, num, false);
				renderFieldTable(fields, false);
			} else {
				const before = parse(beforeIn.input.value), after = parse(afterIn.input.value);
				if (isNaN(before) || isNaN(after)) { errStrip.textContent = 'Invalid values.'; return; }
				const diff = this._regCompositorSvc.diffRegisters(periph, reg, before, after);
				if (!diff) { errStrip.textContent = `${periph}.${reg} not found in loaded SVD.`; renderFieldTable([], true); return; }
				const text = this._regCompositorSvc.formatDiff(diff);
				const fields: RenderedField[] = this._parseDiffFields(text, before, after);
				lastFields = fields; lastVal = after;
				drawBitStrip(fields, after, true, after);
				renderFieldTable(fields, true);
			}
		};

		[periphIn.input, regIn.input, valIn.input].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') run(); }));
		[beforeIn.input, afterIn.input].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') run(); }));

		// Initial empty canvas
		const ro = new ResizeObserver(() => { if (lastFields.length) drawBitStrip(lastFields, lastVal, mode === 'diff'); });
		ro.observe(bitCanvas.parentElement!);
		// Draw placeholder
		const DPR = window.devicePixelRatio || 1;
		const W0 = bitCanvas.parentElement?.clientWidth || 800;
		bitCanvas.width = W0 * DPR; bitCanvas.height = 68 * DPR;
		bitCanvas.style.height = '68px';
		const ctx0 = bitCanvas.getContext('2d')!;
		ctx0.scale(DPR, DPR);
		ctx0.fillStyle = '#0d1117'; ctx0.fillRect(0, 0, W0, 68);
		ctx0.fillStyle = 'rgba(255,255,255,0.18)'; ctx0.font = '11px system-ui'; ctx0.textAlign = 'center';
		ctx0.fillText('Enter peripheral + register + value, then press Decode', W0 / 2, 38);
	}

	/** Parse formatDecoded() text output into RenderedField list. */
	private _parseDecodedFields(text: string, regVal: number): Array<{name:string;bitHigh:number;bitLow:number;value:number;access:string;description:string;}> {
		const fields: Array<{name:string;bitHigh:number;bitLow:number;value:number;access:string;description:string;}> = [];
		// Format: "  FIELDNAME  [hi:lo]  = VALUE  (decimal)  access  description"
		// or single-bit: "  FIELDNAME  [bit]  = VALUE"
		const re = /^\s{2,}(\S+)\s+\[(\d+)(?::(\d+))?\]\s+=\s+(\S+)/mg;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			const hi = parseInt(m[2]!);
			const lo = m[3] !== undefined ? parseInt(m[3]!) : hi;
			const rawVal = m[4]!;
			const val = parseInt(rawVal, rawVal.startsWith('0x') || rawVal.startsWith('0X') ? 16 : 10);
			// Extract description from rest of line
			const lineEnd = text.indexOf('\n', re.lastIndex - m[0].length + m[0].length);
			const rest = lineEnd > 0 ? text.slice(re.lastIndex - m[0].length + m[0].length, lineEnd) : '';
			fields.push({ name: m[1]!, bitHigh: hi, bitLow: lo, value: isNaN(val) ? (regVal >> lo) & ((1 << (hi-lo+1))-1) : val, access: 'rw', description: rest.trim() });
		}
		// Fallback: if no structured parse, synthesise 1-bit fields from value
		if (!fields.length) {
			for (let b = 0; b < 32; b++) {
				const v = (regVal >> b) & 1;
				if (v) fields.push({name:`BIT${b}`, bitHigh:b, bitLow:b, value:v, access:'rw', description:''});
			}
		}
		return fields;
	}

	/** Parse formatDiff() text output into RenderedField list. */
	private _parseDiffFields(text: string, before: number, after: number): Array<{name:string;bitHigh:number;bitLow:number;value:number;access:string;description:string;changed:boolean;beforeVal:number;}> {
		const fields: Array<{name:string;bitHigh:number;bitLow:number;value:number;access:string;description:string;changed:boolean;beforeVal:number;}> = [];
		const re = /^\s{2,}(\S+)\s+\[(\d+)(?::(\d+))?\]\s+(CHANGED|unchanged)/mg;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			const hi = parseInt(m[2]!);
			const lo = m[3] !== undefined ? parseInt(m[3]!) : hi;
			const mask = (1 << (hi - lo + 1)) - 1;
			const afterVal = (after >> lo) & mask;
			const beforeVal = (before >> lo) & mask;
			fields.push({ name: m[1]!, bitHigh: hi, bitLow: lo, value: afterVal, access: 'rw', description: '', changed: m[4] === 'CHANGED', beforeVal });
		}
		return fields;
	}

	// ─── Init Dependencies Panel ──────────────────────────────────────────────

	private _renderDepsPanel(root: HTMLElement, s: IFirmwareSessionData): void {
		// ── Header ────────────────────────────────────────────────────────────
		const hdr = $e('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-shrink:0;');
		const hdrLeft = $e('div');
		hdrLeft.appendChild($t('span', 'Init Dependencies', 'font-size:13px;font-weight:700;'));
		hdrLeft.appendChild($t('span', ' — ordered init chain with C code', 'font-size:11px;color:var(--vscode-descriptionForeground);margin-left:8px;'));
		hdr.appendChild(hdrLeft);
		const copyAllBtn = this._btn('Copy All C', false, () => {}, 'font-size:10px;padding:3px 10px;');
		hdr.appendChild(copyAllBtn);
		root.appendChild(hdr);

		// ── Control row ───────────────────────────────────────────────────────
		const controlRow = $e('div', 'display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:10px;flex-shrink:0;');
		const periphIn = this._hwLabeledInput('Peripheral', 'e.g. USART1, SPI2', 'USART1', '120px');
		const mkCheck = (label: string, checked: boolean) => {
			const cb = $e('input', 'margin:0;cursor:pointer;') as HTMLInputElement;
			cb.type = 'checkbox'; cb.checked = checked;
			const lbl = $e('label', 'display:flex;align-items:center;gap:4px;font-size:10px;cursor:pointer;padding-bottom:4px;');
			lbl.appendChild(cb); lbl.appendChild(document.createTextNode(label));
			return { cb, lbl };
		};
		const { cb: dmaCb, lbl: dmaLbl } = mkCheck('DMA', false);
		const { cb: irqCb, lbl: irqLbl } = mkCheck('IRQ', true);
		const analyzeBtn = this._btn('Analyze', true, () => runAnalyze(), 'font-size:10px;padding:4px 12px;align-self:flex-end;');
		controlRow.appendChild(periphIn.wrap);
		controlRow.appendChild(dmaLbl); controlRow.appendChild(irqLbl);
		controlRow.appendChild(analyzeBtn);
		root.appendChild(controlRow);
		periphIn.input.addEventListener('keydown', e => { if (e.key === 'Enter') runAnalyze(); });

		// ── Step flow container ───────────────────────────────────────────────
		const flowWrap = $e('div', 'flex:1;overflow-y:auto;padding-right:4px;');
		root.appendChild(flowWrap);

		// Kind color map
		const KIND_COLOR: Record<string, string> = {
			'rcc-clock-enable':  '#0288d1',
			'gpio-af-config':    '#388e3c',
			'gpio-analog-config':'#388e3c',
			'nvic-enable':       '#7b1fa2',
			'dma-stream-config': '#e65100',
			'peripheral-enable': '#1565c0',
			'pll-config':        '#f57f17',
			'power-domain':      '#ad1457',
			'bus-prescaler':     '#546e7a',
		};
		const KIND_SHORT: Record<string, string> = {
			'rcc-clock-enable':  'RCC',
			'gpio-af-config':    'GPIO',
			'gpio-analog-config':'GPIO',
			'nvic-enable':       'NVIC',
			'dma-stream-config': 'DMA',
			'peripheral-enable': 'PERI',
			'pll-config':        'PLL',
			'power-domain':      'PWR',
			'bus-prescaler':     'BUS',
		};

		const NS = 'http://www.w3.org/2000/svg';

		const runAnalyze = () => {
			while (flowWrap.firstChild) { flowWrap.removeChild(flowWrap.firstChild); }

			const chain = this._depSvc.getDependencyChain(periphIn.input.value.trim().toUpperCase(), {
				useDMA: dmaCb.checked, useInterrupt: irqCb.checked, useHAL: false,
				rtos: (s.rtos as 'none' | 'freertos' | 'zephyr' | undefined) || 'none',
			});

			// Update copy-all button
			copyAllBtn.addEventListener('click', () => {
				const seq = this._depSvc.generateInitSequence(periphIn.input.value.trim().toUpperCase(), { useDMA: dmaCb.checked, useInterrupt: irqCb.checked, useHAL: false });
				navigator.clipboard.writeText(seq);
				copyAllBtn.textContent = 'Copied!';
				setTimeout(() => { copyAllBtn.textContent = 'Copy All C'; }, 2000);
			});

			if (!chain.nodes.length) {
				flowWrap.appendChild($t('div', `No dependency data for ${chain.peripheral}. Load an SVD file first.`, 'font-size:11px;color:var(--vscode-descriptionForeground);padding:12px 0;'));
				return;
			}

			// Summary row
			const req = chain.nodes.filter(n => !n.optional).length;
			const opt = chain.nodes.filter(n => n.optional).length;
			const sumRow = $e('div', 'display:flex;align-items:center;gap:10px;margin-bottom:10px;');
			sumRow.appendChild($t('span', chain.peripheral, 'font-size:12px;font-weight:700;font-family:monospace;'));
			sumRow.appendChild($t('span', `${req} required`, 'font-size:10px;color:#81c784;'));
			if (opt) sumRow.appendChild($t('span', `${opt} optional`, 'font-size:10px;color:var(--vscode-descriptionForeground);'));
			flowWrap.appendChild(sumRow);

			// Track expanded state
			const expanded = new Set<number>();

			const renderFlow = () => {
				// Remove all step nodes (keep sumRow)
				while (flowWrap.children.length > 1) { flowWrap.removeChild(flowWrap.lastChild!); }

				for (let i = 0; i < chain.nodes.length; i++) {
					const node = chain.nodes[i]!;
					const color = KIND_COLOR[node.kind] || '#546e7a';
					const shortKind = KIND_SHORT[node.kind] || node.kind.slice(0, 4).toUpperCase();
					const isLast = i === chain.nodes.length - 1;
					const isExpanded = expanded.has(i);

					// Row container: SVG circle + connector + content card
					const row = $e('div', 'display:flex;align-items:flex-start;gap:0;');

					// Left column: circle + vertical line
					const leftCol = $e('div', 'display:flex;flex-direction:column;align-items:center;width:40px;flex-shrink:0;');

					// SVG circle with step number
					const circleSvg = document.createElementNS(NS, 'svg');
					circleSvg.setAttribute('width', '28'); circleSvg.setAttribute('height', '28');
					circleSvg.style.cssText = 'display:block;flex-shrink:0;';
					const circle = document.createElementNS(NS, 'circle');
					circle.setAttribute('cx', '14'); circle.setAttribute('cy', '14'); circle.setAttribute('r', '12');
					circle.setAttribute('fill', node.optional ? 'rgba(84,110,122,0.15)' : color + '22');
					circle.setAttribute('stroke', node.optional ? '#546e7a' : color);
					circle.setAttribute('stroke-width', '1.5');
					const cText = document.createElementNS(NS, 'text');
					cText.setAttribute('x', '14'); cText.setAttribute('y', '18');
					cText.setAttribute('text-anchor', 'middle'); cText.setAttribute('font-size', '9');
					cText.setAttribute('font-family', 'monospace'); cText.setAttribute('font-weight', 'bold');
					cText.setAttribute('fill', node.optional ? '#546e7a' : color);
					cText.textContent = String(node.order);
					circleSvg.appendChild(circle); circleSvg.appendChild(cText);
					leftCol.appendChild(circleSvg);

					// Vertical connector line (not on last item)
					if (!isLast) {
						const lineEl = $e('div', `width:1px;flex:1;min-height:${isExpanded ? '8px' : '4px'};background:rgba(255,255,255,0.10);margin-top:0;`);
						leftCol.appendChild(lineEl);
					}

					row.appendChild(leftCol);

					// Right column: card
					const card = $e('div', `flex:1;margin-bottom:${isLast ? '4px' : '2px'};margin-left:6px;border-radius:5px;border:1px solid ${isExpanded ? color + '44' : 'var(--vscode-widget-border)'};overflow:hidden;${node.optional ? 'opacity:0.7;' : ''}`);

					// Card header — always visible, click to expand
					const cardHdr = $e('div', `display:flex;align-items:center;gap:8px;padding:6px 10px;cursor:pointer;background:${isExpanded ? color + '0d' : 'transparent'};`);

					const kindPill = $e('div', `font-size:8px;font-weight:700;padding:1px 5px;border-radius:2px;background:${color}20;color:${color};flex-shrink:0;font-family:monospace;`);
					kindPill.textContent = shortKind;

					const descSpan = $t('span', node.description, 'font-size:11px;font-weight:600;flex:1;');

					const rightSide = $e('div', 'display:flex;align-items:center;gap:6px;flex-shrink:0;');
					if (node.optional) {
						rightSide.appendChild($t('span', 'optional', 'font-size:9px;color:var(--vscode-descriptionForeground);'));
					}
					// Expand chevron
					const chevron = $t('span', isExpanded ? '▲' : '▼', 'font-size:8px;color:var(--vscode-descriptionForeground);');
					rightSide.appendChild(chevron);

					cardHdr.appendChild(kindPill); cardHdr.appendChild(descSpan); cardHdr.appendChild(rightSide);
					card.appendChild(cardHdr);

					// Condition text (if optional)
					if (node.condition) {
						const condEl = $t('div', `Condition: ${node.condition}`, `font-size:9px;color:var(--vscode-descriptionForeground);padding:0 10px 4px;${isExpanded ? '' : 'display:none;'}`);
						card.appendChild(condEl);
					}

					// Code snippet (expanded only)
					if (isExpanded && node.codeSnippet) {
						const codeWrap = $e('div', 'padding:0 10px 8px;');
						const pre = $e('pre', 'margin:0;padding:8px 10px;border-radius:4px;background:var(--vscode-editor-background);font-size:10px;font-family:var(--vscode-editor-font-family,monospace);color:var(--vscode-editor-foreground);border:1px solid var(--vscode-widget-border);white-space:pre-wrap;overflow-x:auto;');
						pre.textContent = node.codeSnippet;
						const copyBtn2 = this._btn('Copy', false, () => {
							navigator.clipboard.writeText(node.codeSnippet);
							copyBtn2.textContent = 'Copied!';
							setTimeout(() => { copyBtn2.textContent = 'Copy'; }, 1500);
						}, 'font-size:9px;padding:2px 8px;margin-top:4px;');
						codeWrap.appendChild(pre); codeWrap.appendChild(copyBtn2);
						card.appendChild(codeWrap);
					}

					cardHdr.addEventListener('click', () => {
						if (expanded.has(i)) { expanded.delete(i); } else { expanded.add(i); }
						renderFlow();
					});

					row.appendChild(card);
					flowWrap.appendChild(row);
				}

				// Platform notes
				if (chain.notes.length > 0) {
					const notes = $e('div', 'margin-top:8px;padding:8px 10px;background:rgba(224,168,78,0.06);border:1px solid rgba(224,168,78,0.22);border-radius:5px;');
					notes.appendChild($t('div', 'Platform Notes', 'font-size:9px;font-weight:700;color:#e0a84e;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em;'));
					for (const note of chain.notes) {
						const nr = $e('div', 'font-size:10px;padding:2px 0;color:var(--vscode-foreground);line-height:1.5;');
						nr.appendChild($t('span', '• ', 'color:#e0a84e;'));
						nr.appendChild($t('span', note, ''));
						notes.appendChild(nr);
					}
					flowWrap.appendChild(notes);
				}
			};

			renderFlow();
		};

		root.appendChild(flowWrap);
		runAnalyze();
	}

	// ─── HW Tools shared helpers ──────────────────────────────────────────────

	/** Labeled input: returns { wrap, input } — wrap goes in the form, input is the <input> element. */
	private _hwLabeledInput(label: string, hint: string, defaultVal: string, width: string): { wrap: HTMLElement; input: HTMLInputElement } {
		const wrap = $e('div', 'display:flex;flex-direction:column;gap:2px;');
		const lbl = $t('label', label, 'font-size:9px;font-weight:600;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.04em;');
		const el = $e('input', [
			`width:${width}`, 'padding:4px 7px', 'box-sizing:border-box',
			'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
			'border-radius:3px', 'background:var(--vscode-input-background)',
			'color:var(--vscode-input-foreground)', 'font-size:11px',
			'font-family:var(--vscode-editor-font-family,monospace)', 'outline:none',
		].join(';')) as HTMLInputElement;
		el.placeholder = hint; el.value = defaultVal;
		el.addEventListener('focus', () => { el.style.borderColor = 'var(--vscode-focusBorder)'; });
		el.addEventListener('blur', () => { el.style.borderColor = 'var(--vscode-input-border,var(--vscode-widget-border))'; });
		wrap.appendChild(lbl); wrap.appendChild(el);
		return { wrap, input: el };
	}

	private _hwPanelSection(title: string, desc: string): HTMLElement {
		const wrap = $e('div', 'margin:12px 0 8px;padding-top:10px;border-top:1px solid var(--vscode-widget-border);');
		const row = $e('div', 'display:flex;align-items:baseline;gap:8px;');
		row.appendChild($t('span', title, 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--vscode-foreground);'));
		row.appendChild($t('span', desc, 'font-size:10px;color:var(--vscode-descriptionForeground);'));
		wrap.appendChild(row);
		return wrap;
	}

	protected _hwSetResult(el: HTMLElement, message: string, ok: boolean): void {
		el.textContent = message;
		el.style.color = ok ? '#4caf50' : 'var(--vscode-errorForeground,#f48771)';
	}

	// ─── Upload datasheet ─────────────────────────────────────────────────────

	private async _uploadDatasheet(): Promise<void> {
		const s = this._session.session;
		if (!s.isActive || !s.mcuConfig) {
			this._notify.notify({ severity: Severity.Warning, message: 'Start a firmware session before uploading a datasheet.' });
			return;
		}

		// ── Show model selector ────────────────────────────────────────────
		// Let the user pick which of their configured models processes the PDF.
		// Reads from the same IVoidSettingsService state that the rest of
		// the Neural Inverse stack uses — no separate config needed.
		const modelSettings = this._voidSettings.state.modelSelectionOfFeature;
		const availableModels: Array<{ label: string; feature: 'Checks' | 'Chat' }> = [];
		if (modelSettings['Checks']) { availableModels.push({ label: `${modelSettings['Checks'].modelName} (Checks)`, feature: 'Checks' }); }
		if (modelSettings['Chat']) { availableModels.push({ label: `${modelSettings['Chat'].modelName} (Chat)`, feature: 'Chat' }); }

		const modelNote = availableModels.length > 0
			? `Model: ${availableModels[0].label}${availableModels.length > 1 ? ` / Also available: ${availableModels.slice(1).map(m => m.label).join(', ')}` : ''}`
			: '[!] No model configured - heuristic extraction only (no LLM). Configure a model in Neural Inverse settings.';

		if (availableModels.length === 0) {
			this._notify.notify({ severity: Severity.Warning, message: modelNote });
		}

		// ── Open native file picker ────────────────────────────────────────
		const picks = await this._dialogs.showOpenDialog({
			title: 'Select MCU Datasheet PDF',
			filters: [{ name: 'PDF Datasheet', extensions: ['pdf'] }],
			canSelectMany: false,
			canSelectFiles: true,
			canSelectFolders: false,
		});
		if (!picks || picks.length === 0) { return; }

		const pdfUri = picks[0];
		const filePath = pdfUri.fsPath;
		const fileName = pdfUri.path.split('/').pop() ?? 'datasheet';
		const mcuFamily = s.mcuConfig.family;

		// ── Progress toast with model info ────────────────────────────────
		const notification = this._notify.notify({
			severity: Severity.Info,
			message: [
				`[~] Processing: ${fileName}`,
				availableModels.length > 0 ? `Using: ${availableModels[0].label}` : 'Heuristic extraction (no model)',
			].join(' / '),
		});

		try {
			const result = await this._dsSvc.extractFromPDF(filePath, mcuFamily);

			this._session.addDatasheet(
				result.info,
				result.registerMaps,
				result.timingConstraints,
				result.errata,
			);

			notification.close?.();
			// extractionTimeMs === 0 means the result was served from the Hardware KB cache.
			const fromCache = result.extractionTimeMs === 0;
			this._notify.notify({
				severity: Severity.Info,
				message: fromCache
					? `[~] ${result.info.title} - loaded from Hardware KB cache | ${result.registerMaps.length} peripherals | ${result.registerMaps.reduce((n, m) => n + m.registers.length, 0)} registers (To force re-extraction: remove entry from Hardware KB Cache below, then re-upload)`
					: [
						`[OK] ${result.info.title}`,
						`${result.registerMaps.length} peripherals`,
						`${result.registerMaps.reduce((n, m) => n + m.registers.length, 0)} registers`,
						`${result.errata.length} errata`,
						`${result.extractionTimeMs}ms`,
					].join(' / '),
			});

			// Warn when no registers were extracted — helps user understand they may need
			// a model configured or an SVD file for complete coverage.
			if (result.registerMaps.length === 0) {
				this._notify.notify({
					severity: Severity.Warning,
					message: availableModels.length > 0
						? `[!] No registers extracted from ${fileName}. The PDF format may be unsupported. Try Load SVD File for complete register coverage.`
						: `[!] No registers extracted - no model configured. Configure a model in Neural Inverse Settings, or use Load SVD File instead.`,
				});
			}

			const critical = result.errata.filter(e => e.severity === 'critical' || e.severity === 'major');
			if (critical.length > 0) {
				this._notify.notify({
					severity: Severity.Warning,
					message: `[!] ${critical.length} major/critical silicon errata in ${result.info.title} - check Datasheets tab.`,
				});
			}

			this._switchTab('datasheets');
		} catch (err) {
			notification.close?.();
			this._notify.notify({ severity: Severity.Error, message: `Failed to process ${fileName}: ${err}` });
		}
	}


	// ─── Load SVD file directly ─────────────────────────────────────────────────

	private async _loadSvdFile(): Promise<void> {
		const s = this._session.session;
		if (!s.isActive) {
			this._notify.notify({ severity: Severity.Warning, message: 'Start a firmware session before loading an SVD file.' });
			return;
		}

		const picks = await this._dialogs.showOpenDialog({
			title: 'Select CMSIS SVD File',
			filters: [{ name: 'CMSIS SVD', extensions: ['svd', 'xml'] }],
			canSelectMany: false,
			canSelectFiles: true,
			canSelectFolders: false,
		});
		if (!picks || picks.length === 0) { return; }

		const svdUri = picks[0];
		const fileName = svdUri.path.split('/').pop() ?? 'device.svd';

		const notification = this._notify.notify({
			severity: Severity.Info,
			message: `[~] Parsing SVD: ${fileName}...`,
		});

		try {
			// Read the file via IFileService (works with any URI scheme)
			const content = await this._fileService.readFile(URI.file(svdUri.fsPath));
			const xml = content.value.toString();

			// Parse using the same SVD parser as the auto-fetch pipeline
			const svdResult = this._svdFetch.parseFromXml(xml, fileName);

			// Warn if the SVD device name doesn't match the active session MCU family.
			// Still load it — the user may intentionally be loading a compatible variant.
			const sessionFamilyPrefix = s.mcuConfig?.family.toUpperCase().slice(0, 6) ?? '';
			const svdDevicePrefix = svdResult.deviceName.toUpperCase().slice(0, 6);
			if (sessionFamilyPrefix && svdDevicePrefix && sessionFamilyPrefix !== svdDevicePrefix) {
				this._notify.notify({
					severity: Severity.Warning,
					message: `[!] SVD device "${svdResult.deviceName}" may not match session MCU "${s.mcuConfig?.family}" - verify register maps in the Registers tab.`,
				});
			}

			// Build a minimal IDatasheetInfo so it appears as a datasheet card
			const totalRegs = svdResult.peripherals.reduce((n, p) => n + p.registers.length, 0);
			const contentHash = this._kbSvc.hashBuffer(content.value.buffer);
			const info = {
				id: `svd-${contentHash}`,
				fileName,
				title: svdResult.deviceName,
				mcuFamily: svdResult.deviceName,
				partNumbers: [svdResult.deviceName],
				pageCount: 0,
				parsedAt: Date.now(),
				peripheralCount: svdResult.peripherals.length,
				registerCount: totalRegs,
				errataCount: 0,
				svdSource: fileName,
			};

			// Tag each peripheral with its source file for provenance display in Registers tab
			const taggedPeripherals = svdResult.peripherals.map(p => ({ ...p, source: fileName }));

			// Load into current session immediately
			this._session.addDatasheet(info, taggedPeripherals, [], []);

			// Persist to .inverse/hardware-kb/ so it survives reloads (best-effort)
			let persisted = true;
			try {
				await this._kbSvc.store(contentHash, {
					info,
					registerMaps: taggedPeripherals,
					timingConstraints: [],
					errata: [],
					pages: [],
					extractionTimeMs: 0,
				});
			} catch (storeErr) {
				persisted = false;
				console.warn('[FirmwarePart] Could not persist SVD to hardware-kb (session data still loaded):', storeErr);
			}

			notification.close?.();
			this._notify.notify({
				severity: Severity.Info,
				message: persisted
					? `[OK] ${svdResult.deviceName} - ${svdResult.peripherals.length} peripherals, ${totalRegs} registers saved to hardware-kb`
					: `[OK] ${svdResult.deviceName} - ${svdResult.peripherals.length} peripherals loaded (could not persist to hardware-kb - check .inverse/ permissions)`,
			});
			this._switchTab('registers');
		} catch (err) {
			notification.close?.();
			this._notify.notify({ severity: Severity.Error, message: `Failed to parse ${fileName}: ${err}` });
		}
	}


	// ─── Instruments ─────────────────────────────────────────────────────────

	private _renderInstruments(root: HTMLElement): void {
		const wrap = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;background:var(--vscode-editor-background);');
		root.appendChild(wrap);

		type InstrTab = 'logic' | 'power' | 'scope' | 'combined';
		let activeInstr: InstrTab = 'logic';

		// VS Code native tab-style bar
		const toolbar = $e('div', [
			'display:flex', 'align-items:center', 'gap:1px', 'padding:0',
			'background:var(--vscode-editorGroupHeader-tabsBackground)',
			'border-bottom:1px solid var(--vscode-editorGroupHeader-tabsBorder,var(--vscode-widget-border))',
			'flex-shrink:0', 'height:35px',
		].join(';'));

		const content = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;');
		wrap.appendChild(toolbar);
		wrap.appendChild(content);

		const subTabs: Array<{ id: InstrTab; label: string }> = [
			{ id: 'logic', label: 'Logic' }, { id: 'power', label: 'Power' },
			{ id: 'scope', label: 'Scope' }, { id: 'combined', label: 'Combined' },
		];

		const renderContent = (tab: InstrTab): void => {
			content.textContent = '';
			switch (tab) {
				case 'logic':    this._renderLogicPanel(content); break;
				case 'power':    this._renderPowerPanel(content); break;
				case 'scope':    this._renderScopePanel(content); break;
				case 'combined': this._renderCombinedPanel(content); break;
			}
		};

		const subBtns = new Map<InstrTab, HTMLButtonElement>();
		for (const st of subTabs) {
			const btn = $e('button', [
				'padding:0 14px', 'border:none', 'border-bottom:2px solid transparent',
				'cursor:pointer', 'font-size:11px', 'font-weight:500',
				'background:transparent', 'color:var(--vscode-tab-inactiveForeground)',
				'height:35px', 'white-space:nowrap',
			].join(';')) as HTMLButtonElement;
			btn.textContent = st.label;
			btn.addEventListener('click', () => {
				activeInstr = st.id;
				subBtns.forEach((b, id) => {
					const active = id === activeInstr;
					b.style.borderBottomColor = active ? 'var(--vscode-panelTitle-activeBorder,var(--vscode-focusBorder))' : 'transparent';
					b.style.color = active ? 'var(--vscode-tab-activeForeground)' : 'var(--vscode-tab-inactiveForeground)';
				});
				renderContent(st.id);
			});
			subBtns.set(st.id, btn);
			toolbar.appendChild(btn);
		}
		toolbar.appendChild($e('div', 'flex:1;'));

		const first = subBtns.get('logic')!;
		first.style.borderBottomColor = 'var(--vscode-panelTitle-activeBorder,var(--vscode-focusBorder))';
		first.style.color = 'var(--vscode-tab-activeForeground)';
		renderContent('logic');
	}

	private _renderLogicPanel(root: HTMLElement): void {
		// ── Layout: compact toolbar / dark canvas / decode table ──
		const panel = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;');
		root.appendChild(panel);

		const tb = $e('div', 'display:flex;align-items:center;gap:6px;padding:5px 10px;background:var(--vscode-sideBarSectionHeader-background);border-bottom:1px solid var(--vscode-widget-border);flex-shrink:0;');
		const statusDot = $e('div', 'width:7px;height:7px;border-radius:50%;background:#616161;flex-shrink:0;');
		const statusLbl = $t('span', 'Disconnected', 'font-size:10px;color:var(--vscode-descriptionForeground);min-width:100px;');
		tb.appendChild(statusDot); tb.appendChild(statusLbl);
		tb.appendChild($e('div', 'width:1px;height:14px;background:var(--vscode-widget-border);margin:0 2px;'));

		const durIn = this._instrInput('Dur', '2', '44px');
		const rateIn = this._instrInput('MHz', '12', '36px');
		const protoSel = $e('select', 'padding:3px 5px;font-size:10px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,var(--vscode-widget-border));border-radius:3px;') as HTMLSelectElement;
		for (const p of ['uart','spi','i2c','can','lin','i2s','jtag','swd']) { const o=$e('option') as HTMLOptionElement; o.value=p; o.textContent=p.toUpperCase(); protoSel.appendChild(o); }

		const detBtn = this._instrBtn('Detect');
		const capBtn = this._instrBtn('Capture');
		capBtn.style.background = '#2e7d32'; capBtn.style.color = '#fff';
		const stopBtn = this._instrBtn('Stop');
		stopBtn.style.background = '#c62828'; stopBtn.style.color = '#fff'; stopBtn.style.display = 'none';

		tb.appendChild($t('span','Dur:','font-size:10px;color:var(--vscode-descriptionForeground);')); tb.appendChild(durIn);
		tb.appendChild($t('span','@','font-size:10px;color:var(--vscode-descriptionForeground);')); tb.appendChild(rateIn);
		tb.appendChild($t('span','MHz','font-size:10px;color:var(--vscode-descriptionForeground);'));
		tb.appendChild($e('div','width:1px;height:14px;background:var(--vscode-widget-border);margin:0 2px;'));
		tb.appendChild(protoSel); tb.appendChild($e('div','flex:1;'));
		tb.appendChild(detBtn); tb.appendChild(capBtn); tb.appendChild(stopBtn);
		panel.appendChild(tb);

		// Canvas waveform area
		const cWrap = $e('div', 'flex:2;position:relative;overflow:hidden;background:#1a1a2e;border-bottom:1px solid var(--vscode-widget-border);min-height:180px;');
		const canvas = $e('canvas', 'width:100%;height:100%;display:block;') as HTMLCanvasElement;
		cWrap.appendChild(canvas);
		const overlay = $t('div','Click Detect, then Capture to see waveforms','position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;color:#607D8B;pointer-events:none;');
		cWrap.appendChild(overlay);
		panel.appendChild(cWrap);

		// Decode table
		const dWrap = $e('div', 'flex:1;overflow-y:auto;min-height:100px;');
		const dHdr = $e('div','display:grid;grid-template-columns:90px 60px 80px 1fr 80px 60px;gap:1px;padding:4px 10px;background:var(--vscode-sideBarSectionHeader-background);font-size:9px;font-weight:700;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.04em;border-bottom:1px solid var(--vscode-widget-border);flex-shrink:0;');
		for (const h of ['Timestamp','Proto','Address','Data','ASCII','Status']) dHdr.appendChild($t('span',h));
		dWrap.appendChild(dHdr);
		const dBody = $e('div','font-family:var(--vscode-editor-font-family,monospace);font-size:10px;');
		dBody.appendChild($t('div','No decoded frames yet','padding:12px;color:var(--vscode-descriptionForeground);font-size:11px;'));
		dWrap.appendChild(dBody);
		panel.appendChild(dWrap);

		// ── Canvas drawing ──
		const COLORS = ['#4fc3f7','#81c784','#ffb74d','#f06292','#ba68c8','#4db6ac','#ff8a65','#aed581'];
		let lastSamples: Record<number,number[]> | null = null;

		const drawWaveform = (samples: Record<number,number[]>, sr: number) => {
			overlay.style.display = 'none';
			const ctx = canvas.getContext('2d'); if (!ctx) return;
			const r = cWrap.getBoundingClientRect();
			const dpr = window.devicePixelRatio||1;
			canvas.width = r.width*dpr; canvas.height = r.height*dpr;
			ctx.scale(dpr,dpr);
			const W=r.width, H=r.height;
			ctx.fillStyle='#1a1a2e'; ctx.fillRect(0,0,W,H);
			ctx.strokeStyle='#2a2a4a'; ctx.lineWidth=0.5;
			for(let x=0;x<W;x+=W/10){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,H);ctx.stroke();}

			const ids = Object.keys(samples).map(Number).sort();
			const chH = Math.max(28, H/Math.max(ids.length,1));
			for(let ci=0;ci<ids.length;ci++){
				const s=samples[ids[ci]!]??[]; if(!s.length) continue;
				const yLo=ci*chH+chH*0.8, yHi=ci*chH+chH*0.2;
				const col=COLORS[ci%COLORS.length]!;
				ctx.fillStyle=col; ctx.font='9px monospace';
				ctx.fillText(`CH${ids[ci]}`,4,ci*chH+12);
				ctx.strokeStyle=col; ctx.lineWidth=1.5; ctx.beginPath();
				let ly=s[0]?yHi:yLo; ctx.moveTo(0,ly);
				for(let px=1;px<W;px++){
					const si=Math.floor((px/W)*s.length);
					const y=(s[Math.min(si,s.length-1)]??0)?yHi:yLo;
					if(y!==ly){ctx.lineTo(px,ly);ctx.lineTo(px,y);}
					ly=y;
				}
				ctx.lineTo(W,ly); ctx.stroke();
				if(ci<ids.length-1){ctx.strokeStyle='#2a2a4a';ctx.lineWidth=0.5;ctx.beginPath();ctx.moveTo(0,(ci+1)*chH);ctx.lineTo(W,(ci+1)*chH);ctx.stroke();}
			}
			const dur=(Object.values(samples)[0]?.length??0)/sr;
			ctx.fillStyle='#546E7A'; ctx.font='9px monospace'; ctx.textAlign='left'; ctx.textBaseline='bottom';
			for(let i=0;i<=10;i++){const t=(i/10)*dur;ctx.fillText(t<0.001?`${(t*1e6).toFixed(0)}us`:t<1?`${(t*1e3).toFixed(1)}ms`:`${t.toFixed(2)}s`,(i/10)*W+2,H-2);}
		};

		const renderFrames = (frames: Array<{timestamp:number;protocol:string;address?:number;data:number[];dataHex:string;dataAscii:string;error?:string}>) => {
			dBody.textContent='';
			if(!frames.length){dBody.appendChild($t('div','No frames decoded. Check channel assignment and baud rate.','padding:10px;color:var(--vscode-descriptionForeground);font-size:11px;'));return;}
			for(const f of frames.slice(0,200)){
				const row=$e('div',`display:grid;grid-template-columns:90px 60px 80px 1fr 80px 60px;gap:1px;padding:3px 10px;border-top:1px solid var(--vscode-widget-border);font-size:10px;${f.error?'background:rgba(244,67,54,0.07);':''}`);
				row.appendChild($t('span',`${f.timestamp.toFixed(6)}s`,'color:var(--vscode-descriptionForeground);'));
				row.appendChild($t('span',f.protocol.toUpperCase(),'font-weight:600;'));
				row.appendChild($t('span',f.address!==undefined?`0x${f.address.toString(16).toUpperCase().padStart(2,'0')}`:'-',''));
				row.appendChild($t('span',f.dataHex,'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
				row.appendChild($t('span',f.dataAscii,'color:var(--vscode-descriptionForeground);'));
				const st=$t('span',f.error?'ERR':'OK','font-weight:600;');
				st.style.color=f.error?'#f44336':'#4caf50'; if(f.error)st.title=f.error;
				row.appendChild(st); dBody.appendChild(row);
			}
			if(frames.length>200)dBody.appendChild($t('div',`Showing 200 of ${frames.length}`,'padding:4px 10px;font-size:9px;color:var(--vscode-descriptionForeground);'));
		};

		detBtn.addEventListener('click', async()=>{
			statusLbl.textContent='Detecting...'; statusDot.style.background='#ffc107';
			try{const s=await this._laSvc.detect(); if(s.connected){statusDot.style.background='#4caf50';statusLbl.textContent=`${s.backend.toUpperCase()} (${s.availableChannels}ch)`;}else{statusDot.style.background='#f44336';statusLbl.textContent='Not found';}}
			catch(e){statusDot.style.background='#f44336';statusLbl.textContent=`Error`;}
		});

		capBtn.addEventListener('click', async()=>{
			capBtn.style.display='none'; stopBtn.style.display='';
			overlay.textContent='Capturing...'; overlay.style.display='flex';
			try{
				const dur=parseFloat(durIn.value)||2, rate=(parseFloat(rateIn.value)||12)*1e6;
				const cap=await this._laSvc.captureChannels([{id:0,label:'CH0',threshold:1.65,pullup:false},{id:1,label:'CH1',threshold:1.65,pullup:true}],dur,rate);
				if(cap.rawSamples&&Object.keys(cap.rawSamples).length>0){lastSamples=cap.rawSamples;drawWaveform(cap.rawSamples,cap.sampleRate);}
				else{overlay.textContent=`Captured ${cap.captureId}`;}
				const proto=protoSel.value as 'uart'|'spi'|'i2c'|'can'|'lin'|'i2s'|'jtag'|'swd';
				const frames=await this._laSvc.decodeProtocol(cap.captureId,{protocol:proto,baudRate:115200,dataChannel:0,clockChannel:1});
				renderFrames(frames);
			}catch(e){overlay.textContent=`Error: ${(e as Error).message}`;overlay.style.display='flex';}
			finally{capBtn.style.display='';stopBtn.style.display='none';}
		});

		new ResizeObserver(()=>{if(lastSamples)drawWaveform(lastSamples,12e6);}).observe(cWrap);
	}

	private _renderPowerPanel(root: HTMLElement): void {
		const panel = $e('div','flex:1;display:flex;flex-direction:column;overflow:hidden;');
		root.appendChild(panel);

		const tb = $e('div','display:flex;align-items:center;gap:6px;padding:5px 10px;background:var(--vscode-sideBarSectionHeader-background);border-bottom:1px solid var(--vscode-widget-border);flex-shrink:0;');
		const dot = $e('div','width:7px;height:7px;border-radius:50%;background:#616161;flex-shrink:0;');
		const lbl = $t('span','Disconnected','font-size:10px;color:var(--vscode-descriptionForeground);min-width:80px;');
		tb.appendChild(dot); tb.appendChild(lbl);
		tb.appendChild($e('div','width:1px;height:14px;background:var(--vscode-widget-border);margin:0 2px;'));
		const durIn=this._instrInput('Dur','5','40px');
		const voltIn=this._instrInput('V','3.3','36px');
		const modeSel=$e('select','padding:3px 5px;font-size:10px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,var(--vscode-widget-border));border-radius:3px;') as HTMLSelectElement;
		for(const m of [['ampere','Ampere'],['source','Source']]){const o=$e('option') as HTMLOptionElement;o.value=m[0]!;o.textContent=m[1]!;modeSel.appendChild(o);}
		const detBtn=this._instrBtn('Detect');
		const measBtn=this._instrBtn('Measure');
		measBtn.style.background='#2e7d32'; measBtn.style.color='#fff';
		tb.appendChild($t('span','Dur:','font-size:10px;color:var(--vscode-descriptionForeground);')); tb.appendChild(durIn);
		tb.appendChild($t('span','s V:','font-size:10px;color:var(--vscode-descriptionForeground);')); tb.appendChild(voltIn);
		tb.appendChild(modeSel); tb.appendChild($e('div','flex:1;'));
		tb.appendChild(detBtn); tb.appendChild(measBtn);
		panel.appendChild(tb);

		// Current graph canvas (Nordic PPK2 style)
		const gWrap=$e('div','flex:3;position:relative;overflow:hidden;background:#0d1117;border-bottom:1px solid var(--vscode-widget-border);min-height:200px;');
		const gCanvas=$e('canvas','width:100%;height:100%;display:block;') as HTMLCanvasElement;
		gWrap.appendChild(gCanvas);
		const gOverlay=$t('div','Click Detect, then Measure','position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;color:#607D8B;pointer-events:none;');
		gWrap.appendChild(gOverlay);
		panel.appendChild(gWrap);

		// Stats bar
		const statsBar=$e('div','display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:var(--vscode-widget-border);border-top:1px solid var(--vscode-widget-border);flex-shrink:0;');
		const statVals: Record<string,HTMLElement>={};
		for(const lb of ['AVG','MIN','MAX','PEAK','ENERGY','CHARGE']){
			const cell=$e('div','padding:6px 8px;background:var(--vscode-editor-background);text-align:center;');
			const v=$t('div','-','font-size:13px;font-weight:700;font-family:var(--vscode-editor-font-family,monospace);');
			cell.appendChild(v); cell.appendChild($t('div',lb,'font-size:8px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.04em;margin-top:1px;'));
			statsBar.appendChild(cell); statVals[lb]=v;
		}
		panel.appendChild(statsBar);

		const fmtUa=(ua:number)=>ua>=1000?`${(ua/1000).toFixed(2)} mA`:`${ua.toFixed(1)} uA`;

		const drawGraph=(r:{avgUa:number;minUa:number;maxUa:number;peakUa:number;energyUJ:number;chargeUC:number;durationMs:number})=>{
			gOverlay.style.display='none';
			const ctx=gCanvas.getContext('2d'); if(!ctx) return;
			const rect=gWrap.getBoundingClientRect();
			const dpr=window.devicePixelRatio||1;
			gCanvas.width=rect.width*dpr; gCanvas.height=rect.height*dpr;
			ctx.scale(dpr,dpr); const W=rect.width,H=rect.height;
			ctx.fillStyle='#0d1117'; ctx.fillRect(0,0,W,H);
			const yMax=r.peakUa*1.2||1000;
			ctx.strokeStyle='#1c2433'; ctx.lineWidth=0.5;
			for(let i=0;i<=5;i++){const y=(i/5)*H;ctx.beginPath();ctx.moveTo(40,y);ctx.lineTo(W,y);ctx.stroke();const val=yMax-(i/5)*yMax;ctx.fillStyle='#546E7A';ctx.font='9px monospace';ctx.textAlign='left';ctx.fillText(val>=1000?`${(val/1000).toFixed(1)}mA`:`${val.toFixed(0)}uA`,2,y+3);}
			// avg line + range band
			const avgY=H-(r.avgUa/yMax)*H;
			const minY=H-(r.minUa/yMax)*H;
			const maxY=H-(r.maxUa/yMax)*H;
			ctx.fillStyle='rgba(79,195,247,0.07)'; ctx.fillRect(40,maxY,W-40,minY-maxY);
			ctx.strokeStyle='#4fc3f7'; ctx.lineWidth=2; ctx.setLineDash([4,4]);
			ctx.beginPath(); ctx.moveTo(40,avgY); ctx.lineTo(W,avgY); ctx.stroke(); ctx.setLineDash([]);
			ctx.fillStyle='#4fc3f7'; ctx.font='11px monospace'; ctx.textAlign='center';
			ctx.fillText(fmtUa(r.avgUa),W/2,avgY-8);
			statVals['AVG']!.textContent=fmtUa(r.avgUa);
			statVals['MIN']!.textContent=fmtUa(r.minUa);
			statVals['MAX']!.textContent=fmtUa(r.maxUa);
			statVals['PEAK']!.textContent=fmtUa(r.peakUa);
			statVals['ENERGY']!.textContent=r.energyUJ>=1000?`${(r.energyUJ/1000).toFixed(1)}mJ`:`${r.energyUJ.toFixed(0)}uJ`;
			statVals['CHARGE']!.textContent=`${r.chargeUC.toFixed(1)}uC`;
		};

		detBtn.addEventListener('click',async()=>{lbl.textContent='Detecting...';dot.style.background='#ffc107';const s=await this._paSvc.detect();if(s.connected){dot.style.background='#4caf50';lbl.textContent=s.device.toUpperCase();}else{dot.style.background='#f44336';lbl.textContent='Not found';}});
		measBtn.addEventListener('click',async()=>{gOverlay.textContent='Measuring...';gOverlay.style.display='flex';try{const s=this._paSvc.getStatus();const r=await this._paSvc.measure({device:s.device,mode:modeSel.value as 'source'|'ampere',voltageV:parseFloat(voltIn.value)||3.3},parseFloat(durIn.value)||5);drawGraph(r);}catch(e){gOverlay.textContent=`Error: ${(e as Error).message}`;gOverlay.style.display='flex';}});
		new ResizeObserver(()=>{gCanvas.style.width=`${gWrap.clientWidth}px`;gCanvas.style.height=`${gWrap.clientHeight}px`;}).observe(gWrap);
	}

	private _renderScopePanel(root: HTMLElement): void {
		const panel=$e('div','flex:1;display:flex;flex-direction:column;overflow:hidden;');
		root.appendChild(panel);

		const tb=$e('div','display:flex;align-items:center;gap:6px;padding:5px 10px;background:var(--vscode-sideBarSectionHeader-background);border-bottom:1px solid var(--vscode-widget-border);flex-shrink:0;');
		const dot=$e('div','width:7px;height:7px;border-radius:50%;background:#616161;flex-shrink:0;');
		const lbl=$t('span','No scope','font-size:10px;color:var(--vscode-descriptionForeground);min-width:70px;');
		tb.appendChild(dot); tb.appendChild(lbl);
		tb.appendChild($e('div','width:1px;height:14px;background:var(--vscode-widget-border);margin:0 2px;'));
		const chIn=this._instrInput('CH','1','28px');
		const vdivIn=this._instrInput('V/div','1.0','46px');
		const trigIn=this._instrInput('Trig','0','46px');
		const trigSel=$e('select','padding:3px 4px;font-size:10px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,var(--vscode-widget-border));border-radius:3px;') as HTMLSelectElement;
		for(const e of [['POS','Rise'],['NEG','Fall']]){const o=$e('option') as HTMLOptionElement;o.value=e[0]!;o.textContent=e[1]!;trigSel.appendChild(o);}
		const discBtn=this._instrBtn('Discover');
		const capBtn=this._instrBtn('Capture'); capBtn.style.background='#2e7d32'; capBtn.style.color='#fff';
		tb.appendChild($t('span','CH:','font-size:10px;color:var(--vscode-descriptionForeground);')); tb.appendChild(chIn);
		tb.appendChild($t('span','V/div:','font-size:10px;color:var(--vscode-descriptionForeground);')); tb.appendChild(vdivIn);
		tb.appendChild($t('span','Trig:','font-size:10px;color:var(--vscode-descriptionForeground);')); tb.appendChild(trigIn); tb.appendChild(trigSel);
		tb.appendChild($e('div','flex:1;')); tb.appendChild(discBtn); tb.appendChild(capBtn);
		panel.appendChild(tb);

		// CRT-style scope canvas
		const sWrap=$e('div','flex:1;position:relative;overflow:hidden;background:#001a00;border-bottom:1px solid var(--vscode-widget-border);min-height:250px;');
		const sCanvas=$e('canvas','width:100%;height:100%;display:block;') as HTMLCanvasElement;
		sWrap.appendChild(sCanvas);
		const sOverlay=$t('div','Click Discover to find scope on LAN','position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;color:#2e7d32;pointer-events:none;');
		sWrap.appendChild(sOverlay);
		panel.appendChild(sWrap);

		// Measurements bar
		const mBar=$e('div','display:flex;gap:18px;padding:7px 12px;background:var(--vscode-sideBarSectionHeader-background);border-top:1px solid var(--vscode-widget-border);flex-shrink:0;font-family:var(--vscode-editor-font-family,monospace);font-size:11px;');
		const mVals: Record<string,HTMLElement>={};
		for(const m of ['Freq','Pk-Pk','Rise','Mean','RMS']){const c=$e('span');c.appendChild($t('span',`${m}: `,'font-size:9px;color:var(--vscode-descriptionForeground);'));const v=$t('span','-','color:#66bb6a;font-weight:600;');c.appendChild(v);mBar.appendChild(c);mVals[m]=v;}
		panel.appendChild(mBar);

		const drawScope=(voltages:number[],vDiv:number)=>{
			sOverlay.style.display='none';
			const ctx=sCanvas.getContext('2d'); if(!ctx) return;
			const r=sWrap.getBoundingClientRect();
			const dpr=window.devicePixelRatio||1;
			sCanvas.width=r.width*dpr; sCanvas.height=r.height*dpr;
			ctx.scale(dpr,dpr); const W=r.width,H=r.height;
			ctx.fillStyle='#001a00'; ctx.fillRect(0,0,W,H);
			// Grid 10x8
			ctx.strokeStyle='#0a3d0a'; ctx.lineWidth=0.5;
			for(let i=0;i<=10;i++){ctx.beginPath();ctx.moveTo((i/10)*W,0);ctx.lineTo((i/10)*W,H);ctx.stroke();}
			for(let i=0;i<=8;i++){ctx.beginPath();ctx.moveTo(0,(i/8)*H);ctx.lineTo(W,(i/8)*H);ctx.stroke();}
			ctx.strokeStyle='#1b5e20'; ctx.lineWidth=1;
			ctx.beginPath();ctx.moveTo(W/2,0);ctx.lineTo(W/2,H);ctx.stroke();
			ctx.beginPath();ctx.moveTo(0,H/2);ctx.lineTo(W,H/2);ctx.stroke();
			// Waveform
			const vRange=vDiv*8;
			ctx.strokeStyle='#66bb6a'; ctx.lineWidth=1.5; ctx.shadowColor='#66bb6a'; ctx.shadowBlur=3;
			ctx.beginPath();
			for(let i=0;i<voltages.length;i++){const x=(i/voltages.length)*W;const y=H/2-((voltages[i]??0)/vRange)*H;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}
			ctx.stroke(); ctx.shadowBlur=0;
			// Trigger line
			const tLv=parseFloat(trigIn.value)||0;
			const tY=H/2-(tLv/vRange)*H;
			ctx.strokeStyle='#ff9800'; ctx.lineWidth=1; ctx.setLineDash([3,3]);
			ctx.beginPath();ctx.moveTo(0,tY);ctx.lineTo(20,tY);ctx.stroke(); ctx.setLineDash([]);
			ctx.fillStyle='#ff9800'; ctx.font='9px monospace'; ctx.fillText('T',2,tY-3);
			// Measurements
			const vMin=Math.min(...voltages),vMax=Math.max(...voltages);
			const vMean=voltages.reduce((a,b)=>a+b,0)/voltages.length;
			const vRms=Math.sqrt(voltages.reduce((a,b)=>a+b*b,0)/voltages.length);
			mVals['Pk-Pk']!.textContent=`${(vMax-vMin).toFixed(3)}V`;
			mVals['Mean']!.textContent=`${vMean.toFixed(3)}V`;
			mVals['RMS']!.textContent=`${vRms.toFixed(3)}V`;
		};

		discBtn.addEventListener('click',async()=>{lbl.textContent='Scanning...';dot.style.background='#ffc107';const ss=await this._scopeSvc.discover();if(ss.length>0){dot.style.background='#4caf50';lbl.textContent=(ss[0]!.model).substring(0,14);}else{dot.style.background='#f44336';lbl.textContent='Not found';}});
		capBtn.addEventListener('click',async()=>{sOverlay.textContent='Arming trigger...';sOverlay.style.display='flex';try{const ch=(parseInt(chIn.value)||1) as 1|2|3|4;const vDiv=parseFloat(vdivIn.value)||1;await this._scopeSvc.configureChannel({channel:ch,vDiv,coupling:'DC',probe:1,enabled:true});await this._scopeSvc.configureTrigger({source:`C${ch}`,edge:trigSel.value as 'POS'|'NEG',level:parseFloat(trigIn.value)||0,mode:'SING'});const cap=await this._scopeSvc.capture(5);const wf=cap.channels[0];if(wf?.voltages.length)drawScope(wf.voltages,vDiv);else{sOverlay.textContent='No waveform data';sOverlay.style.display='flex';}}catch(e){sOverlay.textContent=`Error: ${(e as Error).message}`;sOverlay.style.display='flex';}});
		new ResizeObserver(()=>{sCanvas.style.width=`${sWrap.clientWidth}px`;sCanvas.style.height=`${sWrap.clientHeight}px`;}).observe(sWrap);
	}

	private _renderCombinedPanel(root: HTMLElement): void {
		const panel=$e('div','flex:1;display:flex;flex-direction:column;overflow:hidden;');
		root.appendChild(panel);

		// Header
		const hdr=$e('div','padding:10px 14px;border-bottom:1px solid var(--vscode-widget-border);flex-shrink:0;');
		hdr.appendChild($t('div','Multi-Instrument Debug Workflows','font-size:13px;font-weight:600;margin-bottom:2px;'));
		hdr.appendChild($t('div','Coordinated hardware debugging across GDB, logic analyzer, power profiler, and oscilloscope','font-size:10px;color:var(--vscode-descriptionForeground);'));
		panel.appendChild(hdr);

		// Full-height 3-row grid
		const grid=$e('div','flex:1;display:grid;grid-template-rows:1fr 1fr 1fr;gap:1px;overflow:hidden;background:var(--vscode-widget-border);');
		panel.appendChild(grid);

		const scenarios=[
			{id:'sleep-regression',label:'Sleep Current Regression',short:'SLEEP',color:'#4fc3f7',
			 instrs:['Power','GDB','Logic'],
			 steps:['Detect PPK2/Joulescope','Measure current (5s)','GDB: read RCC_CSR+PWR_CSR','LA: decode UART log','Correlate timestamps']},
			{id:'i2c-nack',label:'I2C NACK Hunt',short:'I2C',color:'#81c784',
			 instrs:['Logic','GDB'],
			 steps:['Set breakpoint on I2C error CB','Arm LA trigger (SCL falling)','Wait for NACK event','Decode I2C frames','Report address+data']},
			{id:'brownout',label:'Brown-out Diagnosis',short:'BOR',color:'#ffb74d',
			 instrs:['Scope','Logic','GDB'],
			 steps:['Configure scope CH1 on VDD','Set trigger below 2.8V','Capture PWM on LA','Read SCB CFSR (no halt)','Correlate droop vs load']},
		];

		for(const sc of scenarios){
			const card=$e('div',`display:grid;grid-template-columns:56px 1fr 230px;background:var(--vscode-editor-background);overflow:hidden;`);

			// Left icon strip
			const iconCol=$e('div',`background:${sc.color}10;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;border-left:3px solid ${sc.color};`);
			const circle=$t('div',sc.short,`width:28px;height:28px;border-radius:50%;background:${sc.color}25;color:${sc.color};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;`);
			iconCol.appendChild(circle);
			card.appendChild(iconCol);

			// Center: title + instrument dots + run button
			const center=$e('div','padding:10px 12px;display:flex;flex-direction:column;justify-content:center;gap:5px;');
			center.appendChild($t('div',sc.label,'font-size:12px;font-weight:600;'));
			const dotsRow=$e('div','display:flex;gap:8px;align-items:center;');
			for(const ins of sc.instrs){
				const d=$e('div','display:flex;align-items:center;gap:3px;');
				d.appendChild($e('div','width:6px;height:6px;border-radius:50%;background:#616161;'));
				d.appendChild($t('span',ins,'font-size:9px;color:var(--vscode-descriptionForeground);'));
				dotsRow.appendChild(d);
			}
			center.appendChild(dotsRow);
			const runRow=$e('div','display:flex;align-items:center;gap:8px;');
			const runBtn=$e('button',`padding:4px 12px;border:none;border-radius:3px;cursor:pointer;font-size:10px;font-weight:600;background:${sc.color};color:#000;`) as HTMLButtonElement;
			runBtn.textContent='Run';
			const runStatus=$t('span','','font-size:9px;color:var(--vscode-descriptionForeground);');
			runBtn.addEventListener('click',()=>{runStatus.textContent=`fw_debug_combined({ scenario: "${sc.id}" })`;runStatus.style.color=sc.color;});
			runRow.appendChild(runBtn); runRow.appendChild(runStatus);
			center.appendChild(runRow);
			card.appendChild(center);

			// Right: step list
			const stepsCol=$e('div','padding:10px 12px;display:flex;flex-direction:column;justify-content:center;gap:3px;border-left:1px solid var(--vscode-widget-border);background:var(--vscode-sideBar-background);');
			stepsCol.appendChild($t('div','STEPS','font-size:8px;font-weight:700;letter-spacing:0.06em;color:var(--vscode-descriptionForeground);margin-bottom:2px;'));
			for(let i=0;i<sc.steps.length;i++){
				const s=$e('div','display:flex;align-items:center;gap:5px;');
				const n=$t('span',`${i+1}`,'width:14px;height:14px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;background:var(--vscode-widget-border);color:var(--vscode-descriptionForeground);flex-shrink:0;');
				s.appendChild(n);
				s.appendChild($t('span',sc.steps[i]!,'font-size:9px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
				stepsCol.appendChild(s);
			}
			card.appendChild(stepsCol);
			grid.appendChild(card);
		}
	}

	// ─── Instrument UI helpers ────────────────────────────────────────────────

	private _instrBtn(label: string): HTMLButtonElement {
		const btn=$e('button','padding:4px 10px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:3px;cursor:pointer;font-size:10px;font-weight:600;') as HTMLButtonElement;
		btn.textContent=label;
		return btn;
	}

	private _instrInput(placeholder: string, defaultVal: string, width: string): HTMLInputElement {
		const el=$e('input',`width:${width};padding:3px 5px;font-size:10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-widget-border));border-radius:3px;font-family:var(--vscode-editor-font-family,monospace);`) as HTMLInputElement;
		el.placeholder=placeholder; el.value=defaultVal;
		return el;
	}


	// ─── Datasheets ──────────────────────────────────────────────────────────

	private _renderDatasheets(root: HTMLElement): void {
		const s = this._session.session;
		const scroll = $e('div', 'flex:1;overflow-y:auto;padding:20px;');

		// Header row
		const hdrRow = $e('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;');
		hdrRow.appendChild($t('h3', 'Datasheets', 'margin:0;font-size:15px;font-weight:700;'));
		const hdrBtns = $e('div', 'display:flex;gap:8px;align-items:center;');
		if (s.datasheets.length > 1) {
			const clearBtn = $t('button', 'Clear All', [
				'font-size:11px', 'padding:4px 10px', 'border-radius:5px', 'cursor:pointer',
				'background:transparent',
				'border:1px solid var(--vscode-errorForeground,#f48771)',
				'color:var(--vscode-errorForeground,#f48771)',
			].join(';'));
			clearBtn.addEventListener('click', () => {
				for (const ds of [...s.datasheets]) { this._session.removeDatasheet(ds.id); }
			});
			hdrBtns.appendChild(clearBtn);
		}
		hdrBtns.appendChild(this._btn('Load SVD File', false, () => this._loadSvdFile(), 'font-size:11px;padding:4px 12px;'));

		// PDF upload — marked Beta because register extraction via PDF text is
		// less accurate than SVD; use SVD for 100% coverage.
		const pdfBtn = this._btn('Upload PDF Datasheet', true, () => this._uploadDatasheet(), 'font-size:11px;padding:4px 12px;position:relative;');
		const betaBadge = $e('span', [
			'position:absolute', 'top:-6px', 'right:-6px',
			'background:#f59e0b', 'color:#000',
			'font-size:8px', 'font-weight:700', 'line-height:1',
			'padding:2px 4px', 'border-radius:3px', 'letter-spacing:0.5px',
		].join(';'));
		betaBadge.textContent = 'Beta';
		pdfBtn.appendChild(betaBadge);
		hdrBtns.appendChild(pdfBtn);

		hdrRow.appendChild(hdrBtns);
		scroll.appendChild(hdrRow);

		// Beta notice
		scroll.appendChild($t('div',
			'[!] PDF extraction is Beta - errata & timing only. Use Load SVD File for complete register coverage.',
			'font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:14px;opacity:0.75;',
		));

		// ── Live extraction progress card ─────────────────────────────────
		if (this._extractionProgress) {
			const ep = this._extractionProgress;
			const pct = ep.totalPages > 0 ? Math.round((ep.processedPages / ep.totalPages) * 100) : 0;
			const stageLabels: Record<string, string> = {
				'reading-pdf': 'Reading PDF...',
				'checking-cache': 'Checking Hardware KB cache...',
				'classifying-pages': `Classifying pages (${ep.processedPages}/${ep.totalPages})...`,
				'extracting-registers': 'Extracting register maps...',
				'extracting-timing': 'Extracting timing constraints...',
				'extracting-errata': '[!] Extracting silicon errata...',
				'saving-to-kb': 'Saving to Hardware KB...',
			};
			const stageLabel = stageLabels[ep.status] ?? `Processing... (${ep.status})`;

			const card = $e('div', [
				'border:1px solid var(--vscode-focusBorder,var(--vscode-widget-border))',
				'border-radius:8px', 'padding:20px 24px', 'margin-bottom:16px',
				'background:var(--vscode-sideBar-background)',
			].join(';'));

			// Title row with spinner
			const titleRow = $e('div', 'display:flex;align-items:center;gap:10px;margin-bottom:12px;');
			// CSS spinner
			const spinner = $e('div', [
				'width:16px', 'height:16px', 'border-radius:50%',
				'border:2px solid var(--vscode-focusBorder,#007fd4)',
				'border-top-color:transparent',
				'animation:fw-spin 0.8s linear infinite',
				'flex-shrink:0',
			].join(';'));
			// Inject spinner keyframes once
			if (!document.getElementById('fw-spinner-style')) {
				const style = document.createElement('style');
				style.id = 'fw-spinner-style';
				style.textContent = '@keyframes fw-spin{to{transform:rotate(360deg)}}';
				document.head.appendChild(style);
			}
			titleRow.appendChild(spinner);
			const titleCol = $e('div', 'flex:1;min-width:0;');
			titleCol.appendChild($t('div', ep.fileName || 'Processing...', 'font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
			titleCol.appendChild($t('div', stageLabel, 'font-size:12px;color:var(--vscode-descriptionForeground);margin-top:2px;'));
			titleRow.appendChild(titleCol);
			if (ep.totalPages > 0) {
				titleRow.appendChild($t('span', `${pct}%`, 'font-size:12px;font-weight:700;color:var(--vscode-focusBorder,#007fd4);'));
			}
			card.appendChild(titleRow);

			// Progress bar
			if (ep.totalPages > 0) {
				const track = $e('div', [
					'height:4px', 'border-radius:2px', 'background:var(--vscode-widget-border)', 'margin-bottom:14px',
				].join(';'));
				const fill = $e('div', [
					`width:${pct}%`, 'height:100%', 'border-radius:2px',
					'background:var(--vscode-focusBorder,#007fd4)',
					'transition:width 0.3s ease',
				].join(';'));
				track.appendChild(fill);
				card.appendChild(track);
			}

			// Live counters
			const counters = $e('div', 'display:flex;gap:20px;');
			const counter = (icon: string, val: number, label: string) => {
				const c = $e('div', 'text-align:center;');
				c.appendChild($t('div', `${icon} ${val}`, 'font-size:18px;font-weight:700;'));
				c.appendChild($t('div', label, 'font-size:10px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.06em;'));
				return c;
			};
			if (ep.totalPages > 0) { counters.appendChild(counter('', ep.totalPages, 'Pages')); }
			counters.appendChild(counter('', ep.registers, 'Registers'));
			counters.appendChild(counter('', ep.timing, 'Timing'));
			counters.appendChild(counter('[!]', ep.errata, 'Errata'));
			card.appendChild(counters);

			scroll.appendChild(card);
		} else if (s.datasheets.length === 0) {
			scroll.appendChild(this._emptyState(
				'No Datasheets Loaded',
				'Upload a PDF datasheet to extract register maps, timing constraints, and errata with inline page citations.',
				'Supports STM32 Reference Manuals, Nordic Product Specs, ESP32 Technical Reference, and more.',
			));
		} else {
			for (const ds of s.datasheets) {
				const card = $e('div', [
					'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
					'border-radius:7px', 'margin-bottom:10px', 'overflow:hidden',
				].join(';'));

				const dsHdr = $e('div', [
					'padding:10px 14px',
					'background:var(--vscode-sideBarSectionHeader-background)',
					'border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
					'display:flex', 'align-items:center', 'justify-content:space-between',
				].join(';'));
				dsHdr.appendChild($t('span', ds.title, 'font-weight:700;font-size:13px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));

				// MCU family mismatch — badge + "Replace" action
				const sessionFamilyPfx = s.mcuConfig?.family.toUpperCase().slice(0, 6) ?? '';
				const dsFamilyPfx = ds.mcuFamily.toUpperCase().slice(0, 6);
				if (sessionFamilyPfx && dsFamilyPfx && sessionFamilyPfx !== dsFamilyPfx) {
					const mismatchBadge = $t('span', '[!] Wrong MCU', [
						'margin-left:6px', 'flex-shrink:0',
						'font-size:10px', 'padding:2px 6px', 'border-radius:3px',
						'background:rgba(255,180,0,0.15)',
						'color:#e0a84e',
						'border:1px solid rgba(255,180,0,0.4)',
					].join(';'));
					mismatchBadge.title = `Loaded for ${ds.mcuFamily} - session MCU is ${s.mcuConfig?.family}`;
					dsHdr.appendChild(mismatchBadge);

					// "Replace" button — removes bad entry and auto-fetches correct SVD
					if (s.mcuConfig) {
						const replaceBtn = $t('button', '<< Replace', [
							'margin-left:6px', 'flex-shrink:0',
							'font-size:10px', 'padding:2px 8px', 'border-radius:3px', 'cursor:pointer',
							'background:rgba(255,180,0,0.2)',
							'color:#e0a84e',
							'border:1px solid rgba(255,180,0,0.5)',
						].join(';'));
						replaceBtn.title = `Remove ${ds.mcuFamily} data and load the correct SVD for ${s.mcuConfig.family}`;
						replaceBtn.addEventListener('click', async () => {
							replaceBtn.textContent = '...';
							replaceBtn.setAttribute('disabled', 'true');
							// 1. Remove the mismatched datasheet from session + KB
							if (ds.id.startsWith('ds-') || ds.id.startsWith('svd-')) {
								const hash = ds.id.slice(4);
								try { await this._kbSvc.remove(hash); } catch { /* best-effort */ }
							}
							this._session.removeDatasheet(ds.id);
							// 2. Auto-fetch the correct SVD for the current session MCU
							const correctUrl = this._svdFetch.svdUrlForPart(s.mcuConfig!.variant ?? s.mcuConfig!.family);
							if (correctUrl) {
								this._notify.notify({ severity: Severity.Info, message: `[~] Fetching correct SVD for ${s.mcuConfig!.family}...` });
								try {
									const result = await this._svdFetch.fetchForParts([s.mcuConfig!.variant ?? s.mcuConfig!.family]);
									if (result) {
										const tagged = result.peripherals.map(p => ({ ...p, source: result.svdFile }));
										const totalR = tagged.reduce((n, p) => n + p.registers.length, 0);
										const info2 = {
											id: `svd-auto-${s.mcuConfig!.family}`,
											fileName: result.svdFile,
											title: result.deviceName,
											mcuFamily: s.mcuConfig!.family,
											partNumbers: [result.deviceName],
											pageCount: 0,
											parsedAt: Date.now(),
											peripheralCount: tagged.length,
											registerCount: totalR,
											errataCount: 0,
											svdSource: result.svdFile,
										};
										this._session.addDatasheet(info2, tagged, [], []);
										this._notify.notify({ severity: Severity.Info, message: `[OK] Replaced with ${result.svdFile} - ${tagged.length} peripherals, ${totalR} registers` });
									} else {
										this._notify.notify({ severity: Severity.Warning, message: `No SVD found for ${s.mcuConfig!.family} - use Load SVD File to provide one manually.` });
									}
								} catch (err) {
									this._notify.notify({ severity: Severity.Error, message: `Failed to fetch SVD: ${err}` });
								}
							} else {
								this._notify.notify({ severity: Severity.Warning, message: `No SVD catalogue entry for ${s.mcuConfig!.family} - use Load SVD File to provide one manually.` });
							}
						});
						dsHdr.appendChild(replaceBtn);
					}
				}

				// "<< Re-extract" — clears KB cache entry so the next upload processes fresh.
				// ds.id = 'ds-<contentHash>' for PDF-sourced datasheets (SVD-only use 'svd-...').
				if (ds.id.startsWith('ds-')) {
					const contentHash = ds.id.slice(3);
					const reextractBtn = $t('button', '<<', [
						'margin-left:6px', 'flex-shrink:0',
						'font-size:11px', 'padding:2px 7px', 'border-radius:4px', 'cursor:pointer',
						'background:transparent',
						'border:1px solid var(--vscode-focusBorder,#007fd4)',
						'color:var(--vscode-focusBorder,#007fd4)',
					].join(';'));
					reextractBtn.title = 'Clear KB cache entry and re-upload to force fresh extraction';
					reextractBtn.addEventListener('click', async () => {
						reextractBtn.textContent = '...';
						reextractBtn.setAttribute('disabled', 'true');
						try {
							await this._kbSvc.remove(contentHash);
							this._session.removeDatasheet(ds.id);
							this._notify.notify({ severity: Severity.Info, message: `KB cache cleared for ${ds.title}. Re-upload the PDF to extract fresh data.` });
						} catch (err) {
							this._notify.notify({ severity: Severity.Error, message: `Failed to clear KB entry: ${err}` });
							reextractBtn.textContent = '<<';
							reextractBtn.removeAttribute('disabled');
						}
					});
					dsHdr.appendChild(reextractBtn);
				}

				const removeBtn = $t('button', 'X', [
					'margin-left:4px', 'flex-shrink:0',
					'font-size:11px', 'padding:2px 7px', 'border-radius:4px', 'cursor:pointer',
					'background:transparent',
					'border:1px solid var(--vscode-errorForeground,#f48771)',
					'color:var(--vscode-errorForeground,#f48771)',
				].join(';'));
				removeBtn.title = 'Remove from session';
				removeBtn.addEventListener('click', () => this._session.removeDatasheet(ds.id));
				dsHdr.appendChild(removeBtn);
				card.appendChild(dsHdr);

				const dsBody = $e('div', 'padding:10px 14px;display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:12px;');
				const pairs: Array<[string, string, string?]> = [
					['MCU Family', ds.mcuFamily],
					['Pages', `${ds.pageCount}`],
					['Peripherals', `${ds.peripheralCount}`],
					['Registers', `${ds.registerCount}`, ds.svdSource ? 'color:#4caf50;' : undefined],
					['Errata', `${ds.errataCount}`],
					['Parts', ds.partNumbers.join(', ')],
					...(ds.svdSource ? [['Register Source', ds.svdSource, 'color:#4caf50;font-family:monospace;'] as [string, string, string]] : []),
				];
				for (const [k, v, style] of pairs) {
					dsBody.appendChild($t('span', k, 'color:var(--vscode-descriptionForeground);'));
					dsBody.appendChild($t('span', v, `font-weight:600;${style ?? ''}`));
				}
				card.appendChild(dsBody);
				scroll.appendChild(card);
			}
		}

		// ── Hardware KB Index ─────────────────────────────────────────────
		// Show what's persisted in .inverse/hardware-kb/ — separate from the
		// active session datasheets above. Load async, render when ready.
		const kbSection = $e('div', 'margin-top:24px;');
		scroll.appendChild(kbSection);

		this._kbSvc.listEntries().then(entries => {
			while (kbSection.firstChild) { kbSection.removeChild(kbSection.firstChild); }

			const kbHdr = $e('div', 'display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;');
			kbHdr.appendChild($t('h4', `Hardware KB Cache (${entries.length})`, 'margin:0;font-size:13px;font-weight:700;'));
			kbHdr.appendChild($t('span', '.inverse/hardware-kb/', 'font-size:10px;color:var(--vscode-descriptionForeground);font-family:monospace;'));
			kbSection.appendChild(kbHdr);

			if (entries.length === 0) {
				kbSection.appendChild($t('div',
					'No PDFs cached yet. Upload a datasheet to populate the Hardware KB.',
					'font-size:12px;color:var(--vscode-descriptionForeground);font-style:italic;padding:8px 0;'
				));
			} else {
				const table = $e('div', 'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:7px;overflow:hidden;');
				for (let i = 0; i < entries.length; i++) {
					const e = entries[i];
					const row = $e('div', [
						'display:grid',
						'grid-template-columns:1fr auto auto',
						'align-items:center',
						'gap:12px',
						'padding:8px 12px',
						'font-size:12px',
						i % 2 === 0 ? 'background:var(--vscode-sideBar-background,var(--vscode-editor-background))' : '',
						i < entries.length - 1 ? 'border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border))' : '',
					].filter(Boolean).join(';'));

					const nameCol = $e('div', '');
					nameCol.appendChild($t('div', e.fileName, 'font-weight:600;'));
					nameCol.appendChild($t('div', `Hash: ${e.contentHash}`, 'font-size:10px;color:var(--vscode-descriptionForeground);font-family:monospace;'));
					row.appendChild(nameCol);

					row.appendChild($t('span', new Date(e.parsedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
						'font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap;'));

					const removeBtn = $t('button', 'X Remove', [
						'font-size:10px', 'padding:2px 8px', 'border-radius:4px', 'cursor:pointer',
						'background:transparent', 'border:1px solid var(--vscode-errorForeground,#f48771)',
						'color:var(--vscode-errorForeground,#f48771)',
					].join(';'));
					removeBtn.addEventListener('click', async () => {
						removeBtn.textContent = '...';
						removeBtn.setAttribute('disabled', 'true');
						try {
							await this._kbSvc.remove(e.contentHash);
							this._notify.notify({ severity: Severity.Info, message: `Removed ${e.fileName} from Hardware KB.` });
							this._switchTab('datasheets'); // re-render
						} catch (err) {
							removeBtn.textContent = 'X Remove';
							removeBtn.removeAttribute('disabled');
							this._notify.notify({ severity: Severity.Error, message: `Failed to remove from KB: ${err}` });
						}
					});
					row.appendChild(removeBtn);

					table.appendChild(row);
				}
				kbSection.appendChild(table);
			}
		}).catch(() => {
			// .inverse/hardware-kb/ doesn't exist yet — this is normal before
			// the first PDF is processed. Show a calm informational note.
			const note = $e('div', 'margin-top:24px;');
			note.appendChild($t('h4', 'Hardware KB Cache (0)', 'margin:0 0 6px;font-size:13px;font-weight:700;'));
			note.appendChild($t('div',
				'No cached datasheets yet. Upload a PDF to create the Hardware KB.',
				'font-size:12px;color:var(--vscode-descriptionForeground);font-style:italic;'
			));
			kbSection.replaceWith(note);
		});

		root.appendChild(scroll);
	}


	// ─── Pinout Visualizer ───────────────────────────────────────────────────

	private _renderPinout(root: HTMLElement): void {
		const s = this._session.session;

		const wrapper = $e('div', 'flex:1;display:flex;flex-direction:row;overflow:hidden;background:var(--vscode-editor-background);');
		root.appendChild(wrapper);

		// ── Derive real data from session ────────────────────────────────────
		const loadedMaps = s.registerMaps ?? [];
		const totalPins = _pinCountFromVariant(s.mcuConfig?.variant ?? '', s.mcuConfig?.gpioCount);
		const pinsPerSide = Math.floor(totalPins / 4);

		// Group register maps by peripheral type for color assignment
		const typeGroups = _groupByPeripheralType(loadedMaps);

		// Build a flat assignment: slot index (0..totalPins-1) → { name, color }
		// Power slots are fixed at corners and regular intervals
		const powerSlots = _powerSlots(totalPins);
		const peripheralSlots = _assignPeripheralSlots(typeGroups, totalPins, powerSlots);

		// ── Left: The Visual Chip ────────────────────────────────────────────
		const chipArea = $e('div', 'flex:2;position:relative;display:flex;align-items:center;justify-content:center;border-right:1px solid var(--vscode-widget-border);overflow:hidden;');

		// Chip container: 60px gutters give room for pin stubs + pin number labels
		const mcuContainer = $e('div', `position:relative;width:440px;height:440px;display:grid;grid-template-columns:60px 320px 60px;grid-template-rows:60px 320px 60px;`);

		// The black plastic body
		const body = $e('div', [
			'grid-column:2', 'grid-row:2',
			'background:#1e1e1e', 'border:1.5px solid #333', 'border-radius:8px',
			'box-shadow:inset 0 0 24px rgba(0,0,0,0.9), 0 4px 20px rgba(0,0,0,0.7), 0 0 0 1px #111',
			'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center', 'z-index:2', 'position:relative', 'gap:6px'
		].join(';'));

		// Pin 1 dot (chamfered corner indicator)
		const pin1Mark = $e('div', 'position:absolute;top:14px;left:14px;width:10px;height:10px;border-radius:50%;background:#0a0a0a;box-shadow:inset 0 1px 3px rgba(255,255,255,0.08);border:1px solid #2a2a2a;');
		body.appendChild(pin1Mark);

		// Chip label from real session data
		const variantLabel = s.mcuConfig?.variant || s.mcuConfig?.family || 'Generic MCU';
		const coreLabel = s.mcuConfig?.core ? s.mcuConfig.core.toUpperCase() : 'CORTEX-M';
		const flashLabel = s.mcuConfig?.flashSize ? `${s.mcuConfig.flashSize >= 1024 ? (s.mcuConfig.flashSize / 1024).toFixed(0) + 'MB' : s.mcuConfig.flashSize + 'KB'} Flash` : '';
		body.appendChild($t('div', variantLabel, 'color:#aaa;font-size:14px;font-weight:700;letter-spacing:1.5px;font-family:monospace;text-align:center;padding:0 12px;'));
		body.appendChild($t('div', coreLabel, 'color:#555;font-size:10px;letter-spacing:2px;font-family:monospace;'));
		if (flashLabel) {
			body.appendChild($t('div', flashLabel, 'color:#444;font-size:9px;letter-spacing:1px;font-family:monospace;'));
		}
		body.appendChild($t('div', `${totalPins}-PIN`, 'color:#3a3a3a;font-size:9px;margin-top:2px;letter-spacing:3px;font-family:monospace;'));
		if (loadedMaps.length > 0) {
			const periph = $t('div', `${loadedMaps.length} PERIPHERALS`, 'color:var(--vscode-terminal-ansiGreen);font-size:9px;letter-spacing:1px;font-family:monospace;opacity:0.8;');
			body.appendChild(periph);
		}
		mcuContainer.appendChild(body);

		// Pin renderer — wider stubs with number labels
		const renderPins = (side: 'top'|'bottom'|'left'|'right') => {
			const isVertical = side === 'left' || side === 'right';
			const container = $e('div', `display:flex;align-items:stretch;justify-content:space-evenly;${isVertical ? 'flex-direction:column;' : ''}`);
			if (side === 'top')    { container.style.gridColumn = '2'; container.style.gridRow = '1'; container.style.alignItems = 'flex-end'; }
			if (side === 'bottom') { container.style.gridColumn = '2'; container.style.gridRow = '3'; container.style.alignItems = 'flex-start'; }
			if (side === 'left')   { container.style.gridColumn = '1'; container.style.gridRow = '2'; container.style.justifyContent = 'space-evenly'; container.style.alignItems = 'flex-end'; }
			if (side === 'right')  { container.style.gridColumn = '3'; container.style.gridRow = '2'; container.style.justifyContent = 'space-evenly'; container.style.alignItems = 'flex-start'; }

			for (let i = 0; i < pinsPerSide; i++) {
				// Global 0-based slot: left=0..N-1, bottom=N..2N-1, right=2N..3N-1 (reversed), top=3N..4N-1 (reversed)
				const slot = side === 'left'   ? i :
				             side === 'bottom' ? pinsPerSide + i :
				             side === 'right'  ? pinsPerSide * 2 + (pinsPerSide - 1 - i) :
				             /* top */           pinsPerSide * 3 + (pinsPerSide - 1 - i);

				const isPower = powerSlots.has(slot);
				const assignment = peripheralSlots.get(slot);

				// Wrapper holds stub + number label stacked
				const pinWrapper = $e('div', `display:flex;flex-direction:${
					side === 'top' ? 'column-reverse' : side === 'bottom' ? 'column' : side === 'left' ? 'row-reverse' : 'row'
				};align-items:center;gap:2px;`);

				// The metal stub
				const stub = $e('div', 'border-radius:2px;transition:all 0.12s;cursor:default;');
				if (!isVertical) { stub.style.width = '10px'; stub.style.height = '28px'; }
				else             { stub.style.width = '28px'; stub.style.height = '10px'; }

				if (isPower) {
					stub.style.background = 'var(--vscode-terminal-ansiRed)';
					stub.style.opacity = '0.85';
					stub.title = `Pin ${slot + 1} - VDD/GND`;
				} else if (assignment) {
					stub.style.background = assignment.color;
					stub.style.boxShadow = `0 0 5px ${assignment.color}55`;
					stub.title = `Pin ${slot + 1} - ${assignment.name}`;
				} else {
					stub.style.background = '#3a3a3a';
					stub.title = `Pin ${slot + 1} - Unassigned`;
				}

				stub.addEventListener('mouseenter', () => {
					stub.style.transform = !isVertical ? 'scaleX(1.4)' : 'scaleY(1.4)';
					stub.style.zIndex = '10';
					stub.style.opacity = '1';
				});
				stub.addEventListener('mouseleave', () => {
					stub.style.transform = 'scale(1)';
					stub.style.zIndex = '1';
					stub.style.opacity = isPower ? '0.85' : '1';
				});

				// Pin number label
				const numLabel = $t('div', String(slot + 1), 'font-size:7px;color:#404040;font-family:monospace;line-height:1;user-select:none;');
				if (isVertical) { numLabel.style.writingMode = 'horizontal-tb'; }

				pinWrapper.appendChild(stub);
				pinWrapper.appendChild(numLabel);
				container.appendChild(pinWrapper);
			}
			return container;
		};

		mcuContainer.appendChild(renderPins('top'));
		mcuContainer.appendChild(renderPins('bottom'));
		mcuContainer.appendChild(renderPins('left'));
		mcuContainer.appendChild(renderPins('right'));

		chipArea.appendChild(mcuContainer);
		wrapper.appendChild(chipArea);

		// ── Right: Context Sidebar ───────────────────────────────────────────
		const sidebar = $e('div', 'width:300px;flex-shrink:0;background:var(--vscode-sideBar-background);overflow-y:auto;display:flex;flex-direction:column;');

		// ── Helper: render the peripheral detail drill-down ──────────────────
		const showPeriphDetail = (map: IPeripheralRegisterMap, color: string) => {
			while (sidebar.firstChild) { sidebar.removeChild(sidebar.firstChild); }

			// Header bar
			const hdr = $e('div', 'padding:12px 16px;border-bottom:1px solid var(--vscode-widget-border);display:flex;align-items:center;gap:8px;position:sticky;top:0;background:var(--vscode-sideBar-background);z-index:2;');
			const backBtn = $t('button', '< Back', 'background:none;border:none;color:var(--vscode-textLink-foreground);font-size:10px;cursor:pointer;padding:0;flex-shrink:0;');
			backBtn.addEventListener('click', () => {
				while (sidebar.firstChild) { sidebar.removeChild(sidebar.firstChild); }
				buildOverview();
			});
			hdr.appendChild(backBtn);
			const colorDot = $e('div', `width:8px;height:8px;border-radius:2px;background:${color};flex-shrink:0;`);
			hdr.appendChild(colorDot);
			hdr.appendChild($t('span', map.name, 'font-size:12px;font-weight:700;font-family:monospace;color:var(--vscode-foreground);'));
			sidebar.appendChild(hdr);

			// Reuse the same full interactive register detail as the Registers tab
			// (bit-field checkboxes, hex inputs, live C-code generator, copy button)
			const body = $e('div', 'padding:0 16px 16px;flex:1;overflow-y:auto;');
			this._renderPeripheralDetail(body, map);

			// Jump button at top so it's always visible without scrolling
			const jumpBtn = $t('button', `Open in Registers Tab ->`, [
				'width:100%', 'padding:6px 10px', 'cursor:pointer', 'margin-bottom:12px',
				`background:${color}22`, `border:1px solid ${color}55`,
				'border-radius:4px', 'font-size:10px', 'font-family:monospace',
				`color:${color}`, 'text-align:left',
			].join(';'));
			jumpBtn.addEventListener('click', () => { this._switchTab('registers'); });
			body.insertBefore(jumpBtn, body.firstChild);

			sidebar.appendChild(body);
		};

		// ── Helper: build the overview (legend + peripheral list) ────────────
		const buildOverview = () => {
			const padded = $e('div', 'padding:16px;');
			padded.appendChild($t('h3', 'Pin Multiplexing', 'font-size:12px;font-weight:700;text-transform:uppercase;color:var(--vscode-descriptionForeground);margin:0 0 12px 0;letter-spacing:0.5px;'));

			// MCU summary
			if (s.mcuConfig) {
				const summary = $e('div', 'margin-bottom:12px;padding:8px;background:var(--vscode-editor-background);border-radius:4px;border:1px solid var(--vscode-widget-border);font-size:10px;font-family:monospace;');
				summary.appendChild($t('div', s.mcuConfig.variant || s.mcuConfig.family, 'color:var(--vscode-foreground);font-weight:700;margin-bottom:4px;'));
				summary.appendChild($t('div', `${s.mcuConfig.clockMHz ?? '?'} MHz  /  Flash ${_fmtSize(s.mcuConfig.flashSize)}  /  RAM ${_fmtSize(s.mcuConfig.ramSize)}`, 'color:var(--vscode-descriptionForeground);'));
				if (s.mcuConfig.gpioCount) {
					summary.appendChild($t('div', `${s.mcuConfig.gpioCount} GPIO  /  ${totalPins} pins`, 'color:var(--vscode-descriptionForeground);margin-top:2px;'));
				}
				padded.appendChild(summary);
			}

			// Legend
			const legendSection = $e('div', 'margin-bottom:12px;');
			for (const [type, { color }] of typeGroups) {
				const l = $e('div', 'display:flex;align-items:center;margin-bottom:5px;font-size:10px;color:var(--vscode-foreground);cursor:pointer;border-radius:3px;padding:2px 3px;');
				const dot = $e('div', `width:8px;height:8px;border-radius:2px;background:${color};margin-right:8px;flex-shrink:0;`);
				l.appendChild(dot);
				l.appendChild(document.createTextNode(type));
				legendSection.appendChild(l);
			}
			if (typeGroups.size > 0) {
				const powerL = $e('div', 'display:flex;align-items:center;margin-bottom:5px;font-size:10px;color:var(--vscode-foreground);');
				const powerDot = $e('div', 'width:8px;height:8px;border-radius:2px;background:var(--vscode-terminal-ansiRed);margin-right:8px;flex-shrink:0;');
				powerL.appendChild(powerDot);
				powerL.appendChild(document.createTextNode('Power (VDD/GND)'));
				legendSection.appendChild(powerL);
				const unL = $e('div', 'display:flex;align-items:center;font-size:10px;color:var(--vscode-foreground);');
				const unDot = $e('div', 'width:8px;height:8px;border-radius:2px;background:#555;margin-right:8px;flex-shrink:0;');
				unL.appendChild(unDot);
				unL.appendChild(document.createTextNode('Unassigned'));
				legendSection.appendChild(unL);
			}
			padded.appendChild(legendSection);
			padded.appendChild($e('hr', 'border:none;border-bottom:1px solid var(--vscode-widget-border);margin:12px 0;'));

			// Peripheral list
			const listHeader = $e('div', 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;');
			listHeader.appendChild($t('div', 'Loaded Peripherals', 'font-size:11px;font-weight:700;color:var(--vscode-descriptionForeground);'));
			listHeader.appendChild($t('div', `${loadedMaps.length}`, 'font-size:11px;color:var(--vscode-descriptionForeground);'));
			padded.appendChild(listHeader);

			if (loadedMaps.length === 0) {
				padded.appendChild($t('div', 'No peripherals loaded. Upload an SVD or datasheet in the Datasheets tab.', 'font-size:11px;color:var(--vscode-descriptionForeground);font-style:italic;padding:8px 0;'));
			} else {
				for (const [type, { maps, color }] of typeGroups) {
					const groupHeader = $e('div', `display:flex;align-items:center;margin:8px 0 4px;font-size:10px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:0.5px;`);
					const groupDot = $e('div', `width:6px;height:6px;border-radius:50%;background:${color};margin-right:6px;`);
					groupHeader.appendChild(groupDot);
					groupHeader.appendChild(document.createTextNode(type));
					padded.appendChild(groupHeader);

					for (const map of maps) {
						const item = $e('div', 'padding:4px 0 4px 12px;font-size:11px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--vscode-widget-border);cursor:pointer;border-radius:2px;transition:background 0.1s;');
						item.title = `Click to inspect ${map.name}`;
						item.addEventListener('mouseenter', () => { item.style.background = 'var(--vscode-list-hoverBackground)'; });
						item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
						item.addEventListener('click', () => showPeriphDetail(map, color));

						const nameSpan = $e('div', 'display:flex;flex-direction:column;');
						nameSpan.appendChild($t('span', map.name, 'font-family:monospace;'));
						if (map.source) {
							nameSpan.appendChild($t('span', map.source, 'font-size:9px;color:var(--vscode-descriptionForeground);'));
						}
						item.appendChild(nameSpan);
						const badge = $t('span', `${map.registers.length}R`, `color:${color};font-size:9px;font-family:monospace;border:1px solid ${color};padding:1px 4px;border-radius:3px;white-space:nowrap;`);
						badge.title = `${map.registers.length} registers @ 0x${(map.baseAddress).toString(16).toUpperCase()}`;
						item.appendChild(badge);
						padded.appendChild(item);
					}
				}
			}

			// Pin Mux Conflicts (real AF-level + source-level detection)
			const muxConflicts = this._pinMuxSvc.getConflicts();
			const svdConflicts = _detectPinConflicts(loadedMaps);
			const allConflicts = [...muxConflicts.map(c => c.message), ...svdConflicts];
			if (allConflicts.length > 0) {
				padded.appendChild($e('hr', 'border:none;border-bottom:1px solid var(--vscode-widget-border);margin:12px 0;'));
				const conflictHdr = $e('div', 'display:flex;align-items:center;gap:6px;margin-bottom:6px;');
				conflictHdr.appendChild($t('span', `[!] ${allConflicts.length} Conflict(s)`, 'font-size:11px;font-weight:700;color:var(--vscode-descriptionForeground);'));
				if (muxConflicts.length > 0) {
					conflictHdr.appendChild($t('span', `${muxConflicts.length} pin mux`, 'font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(255,180,0,0.15);color:#e0a84e;'));
				}
				padded.appendChild(conflictHdr);
				for (const c of allConflicts) {
					padded.appendChild($t('div', c, 'font-size:10px;color:var(--vscode-descriptionForeground);padding:2px 0;'));
				}
			}

			padded.appendChild($t('div', 'Click any pin or peripheral to inspect', 'font-size:9px;color:var(--vscode-descriptionForeground);margin-top:16px;text-align:center;opacity:0.6;'));
			sidebar.appendChild(padded);
		};

		buildOverview();

		// Wire up pin click → detail
		// Re-wire renderPins to also fire showPeriphDetail on click
		// (done by re-adding click handlers after the container is built)
		chipArea.querySelectorAll<HTMLDivElement>('[title]').forEach(pinEl => {
			const titleAttr = pinEl.title;
			if (!titleAttr.startsWith('Pin ') || titleAttr.includes('Unassigned') || titleAttr.includes('VDD/GND')) { return; }
			const periphName = titleAttr.replace(/^Pin \d+ - /, '');
			const map = loadedMaps.find(m => m.name === periphName);
			if (!map) { return; }
			const color = _peripheralColor(map.name);
			pinEl.style.cursor = 'pointer';
			pinEl.addEventListener('click', () => showPeriphDetail(map, color));
		});

		wrapper.appendChild(sidebar);
	}

	// ─── Architecture Visualizer ─────────────────────────────────────────────

	private _renderArchitecture(root: HTMLElement): void {
		const s = this._session.session;

		const wrapper = $e('div', 'flex:1;display:flex;flex-direction:column;overflow-y:auto;background:var(--vscode-editor-background);padding:32px 40px;');
		root.appendChild(wrapper);

		wrapper.appendChild($t('h2', 'HARDWARE ARCHITECTURE GRAPH', 'margin:0 0 8px 0;font-size:16px;font-weight:600;color:var(--vscode-editor-foreground);letter-spacing:1px;text-transform:uppercase;'));
		wrapper.appendChild($t('p', 'Live static-analysis of memory matrices and interconnected peripherals, derived directly from compiled SVD layout vectors.', 'margin:0 0 48px 0;font-size:12px;color:var(--vscode-descriptionForeground);'));

		try {
			// The Canvas
			const canvas = $e('div', 'position:relative;display:flex;flex-direction:row;align-items:flex-start;gap:70px;');
			
			// CPU Node
			const cpuNode = $e('div', [
				'width:120px', 'padding:16px 0', 'border-radius:2px',
				'background:var(--vscode-editor-background)', 'border:1px solid var(--vscode-focusBorder)',
				'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center', 'z-index:10'
			].join(';'));
			const coreText = s.mcuConfig?.core ? s.mcuConfig.core.toUpperCase() : 'MCU CORE';
			cpuNode.appendChild($t('div', coreText, 'font-size:12px;font-weight:600;color:var(--vscode-foreground);letter-spacing:1px;font-family:var(--vscode-editor-font-family,monospace);text-align:center;'));
			cpuNode.appendChild($t('div', s.mcuConfig?.clockMHz ? `${s.mcuConfig.clockMHz} MHz` : 'SYSCLK', 'font-size:10px;color:var(--vscode-terminal-ansiGreen);margin-top:6px;'));
			canvas.appendChild(cpuNode);

			const buses = new Map<number, typeof s.registerMaps>();
			for (const map of (s.registerMaps || [])) {
				// >>> 0 forces unsigned 32-bit — prevents 0xE0000000 becoming -0x20000000
				const base = (map.baseAddress || 0) >>> 0;
				const seg = (base & 0xFFFF0000) >>> 0;
				if (!buses.has(seg)) buses.set(seg, []);
				buses.get(seg)!.push(map);
			}

			// Sort ascending unsigned: PPB (0xE000xxxx) sorts after peripheral space
			const sortedBusAddresses = Array.from(buses.keys()).sort((a, b) => (a >>> 0) - (b >>> 0));
			const family = s.mcuConfig?.family ?? '';

			const renderBus = (name: string, mhz: string, color: string, maps: typeof s.registerMaps) => {
				if (maps.length === 0) return null;

				const busContainer = $e('div', 'display:flex;flex-direction:column;align-items:flex-start;position:relative;');
				
				const busLine = $e('div', `position:absolute;left:10px;top:0;bottom:0;width:1px;background:${color};`);
				busContainer.appendChild(busLine);

				const header = $e('div', `margin-left:24px;margin-bottom:24px;border-left:2px solid ${color};padding-left:10px;`);
				header.appendChild($t('div', name, 'font-size:12px;font-weight:600;color:var(--vscode-foreground);font-family:var(--vscode-editor-font-family,monospace);'));
				header.appendChild($t('div', mhz, `font-size:9px;color:${color};margin-top:4px;text-transform:uppercase;`));
				busContainer.appendChild(header);

				for (const map of maps) {
					// Outer wrapper: connector + box + expandable detail stacked vertically
					const rowGroup = $e('div', 'margin-bottom:8px;');

					const row = $e('div', 'display:flex;align-items:center;position:relative;');
					const connector = $e('div', `width:14px;height:1px;background:${color};margin-left:10px;flex-shrink:0;`);
					row.appendChild(connector);

					const pbox = $e('div', [
						'padding:6px 10px', 'background:var(--vscode-editor-background)',
						'border:1px solid var(--vscode-widget-border)', 'border-radius:2px',
						'min-width:150px', 'display:flex', 'flex-direction:column',
						'transition:border-color 0.1s,background 0.1s', 'cursor:pointer', 'user-select:none',
					].join(';'));

					const regCount = map.registers?.length ?? 0;
					const baseHex = (map.baseAddress >>> 0).toString(16).toUpperCase().padStart(8, '0');

					pbox.addEventListener('mouseenter', () => { if (!expanded) { pbox.style.borderColor = color; } });
					pbox.addEventListener('mouseleave', () => { if (!expanded) { pbox.style.borderColor = 'var(--vscode-widget-border)'; } });

					const pName = map.name || 'UNKNOWN';
					const pGroup = map.groupName || '';
					pbox.appendChild($t('div', pName, 'font-size:11px;font-weight:600;color:var(--vscode-foreground);font-family:var(--vscode-editor-font-family,monospace);'));

					const subLine = $e('div', 'display:flex;align-items:center;gap:6px;margin-top:3px;');
					if (pGroup) { subLine.appendChild($t('span', pGroup, 'font-size:8px;color:var(--vscode-descriptionForeground);text-transform:uppercase;')); }
					subLine.appendChild($t('span', `${regCount}R`, `font-size:8px;color:${color};font-family:monospace;`));
					subLine.appendChild($t('span', `0x${baseHex}`, 'font-size:8px;color:var(--vscode-descriptionForeground);font-family:monospace;'));
					pbox.appendChild(subLine);

					row.appendChild(pbox);
					rowGroup.appendChild(row);

					// Expandable detail panel
					const detailPanel = $e('div', [
						'display:none', 'margin-left:24px', 'margin-top:2px',
						`border-left:2px solid ${color}`, 'padding:8px 10px',
						'background:var(--vscode-editor-background)',
						'border-radius:0 4px 4px 0',
						'font-size:10px',
					].join(';'));
					rowGroup.appendChild(detailPanel);

					let expanded = false;

					const buildDetail = () => {
						while (detailPanel.firstChild) { detailPanel.removeChild(detailPanel.firstChild); }

						// Jump to full Registers tab
						const jumpBtn = $t('button', `Open in Registers Tab ->`, [
							'padding:4px 8px', 'cursor:pointer', 'margin-bottom:8px', 'display:block',
							`background:${color}15`, `border:1px solid ${color}55`,
							'border-radius:3px', 'font-size:9px', 'font-family:monospace',
							`color:${color}`, 'width:100%', 'text-align:left',
						].join(';'));
						jumpBtn.addEventListener('click', (e) => {
							e.stopPropagation();
							this._switchTab('registers');
						});
						detailPanel.appendChild(jumpBtn);

						// Full interactive register detail — same checkboxes/inputs/copy as Registers tab
						this._renderPeripheralDetail(detailPanel, map);
					};

					pbox.addEventListener('click', () => {
						expanded = !expanded;
						if (expanded) {
							buildDetail();
							detailPanel.style.display = 'block';
							pbox.style.borderColor = color;
							pbox.style.background = `${color}11`;
						} else {
							detailPanel.style.display = 'none';
							pbox.style.borderColor = 'var(--vscode-widget-border)';
							pbox.style.background = 'var(--vscode-editor-background)';
						}
					});

					busContainer.appendChild(rowGroup);
				}

				return busContainer;
			};

			const busesWrapper = $e('div', 'display:flex;flex-direction:row;gap:60px;position:relative;');
			
			const mainTrunk = $e('div', 'position:absolute;left:-70px;top:44px;width:70px;height:1px;background:var(--vscode-focusBorder);');
			busesWrapper.appendChild(mainTrunk);

			const palette = [
				'var(--vscode-terminal-ansiCyan)', 
				'var(--vscode-terminal-ansiMagenta)', 
				'var(--vscode-terminal-ansiBlue)', 
				'var(--vscode-terminal-ansiGreen)',
				'var(--vscode-terminal-ansiYellow)'
			];

			let i = 0;
			for (const baseAddr of sortedBusAddresses) {
				const group = buses.get(baseAddr)!;
				const color = palette[i % palette.length];
				const { busName, busSpeed } = _semanticBusName(baseAddr, family);
				const addrStr = `0x${(baseAddr || 0).toString(16).toUpperCase().padStart(8, '0')}`;
				const name = `${busName}  [${addrStr}]`;

				const node = renderBus(name, busSpeed, color, group);
				if (node) busesWrapper.appendChild(node);
				i++;
			}

			if (buses.size === 0) {
				busesWrapper.appendChild($t('div', 'AWAITING_SVD_MAP()', 'padding:20px;color:var(--vscode-descriptionForeground);font-size:11px;font-family:monospace;'));
			}

			canvas.appendChild(busesWrapper);
			wrapper.appendChild(canvas);
		} catch (error: any) {
			wrapper.appendChild($t('div', `Exception resolving Architecture graph from SVD Layout: ${error?.message || 'Unknown exception'}`, 'color:var(--vscode-terminal-ansiRed);padding:20px;font-family:monospace;font-size:11px;'));
		}
	}

	// ─── Registers ───────────────────────────────────────────────────────────

	private _renderRegisters(root: HTMLElement): void {
		const s = this._session.session;

		if (s.registerMaps.length === 0) {
			const wrap = $e('div', 'flex:1;display:flex;align-items:center;justify-content:center;');
			wrap.appendChild(this._emptyState(
				'No Register Maps Loaded',
				'Load an SVD file or parse a PDF datasheet to populate the register explorer.',
			));
			root.appendChild(wrap);
			return;
		}

		const layout = $e('div', 'flex:1;display:flex;overflow:hidden;');
		root.appendChild(layout);

		// Peripheral sidebar
		const sidebar = $e('div', [
			'width:200px', 'min-width:160px', 'flex-shrink:0',
			'border-right:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
			'overflow-y:auto', 'padding:4px 0',
			'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
		].join(';'));

		sidebar.appendChild($t('div', `Peripherals (${s.registerMaps.length})`, [
			'padding:8px 12px', 'font-size:10px', 'font-weight:700',
			'text-transform:uppercase', 'letter-spacing:0.07em',
			'color:var(--vscode-descriptionForeground)',
		].join(';')));

		const detail = $e('div', 'flex:1;overflow-y:auto;padding:16px;');

		const showPeriph = (map: IPeripheralRegisterMap) => {
			while (detail.firstChild) { detail.removeChild(detail.firstChild); }
			this._renderPeripheralDetail(detail, map);
			sidebar.querySelectorAll('[data-periph]').forEach(el => {
				(el as HTMLElement).style.background = 'transparent';
				(el as HTMLElement).style.borderLeft = '3px solid transparent';
				(el as HTMLElement).style.fontWeight = '400';
			});
			const sel = sidebar.querySelector(`[data-periph="${map.name}"]`) as HTMLElement | null;
			if (sel) {
				sel.style.background = 'var(--vscode-list-activeSelectionBackground)';
				sel.style.borderLeft = '3px solid var(--vscode-focusBorder)';
				sel.style.fontWeight = '600';
			}
		};

		// Group peripherals by source when multiple sources are present
		// (e.g. STM32F0x0.svd + RM0360.pdf). Single source = flat list.
		const sources = [...new Set(s.registerMaps.map(m => m.source ?? 'Unknown'))];
		const multiSource = sources.length > 1;

		for (const source of sources) {
			const group = s.registerMaps.filter(m => (m.source ?? 'Unknown') === source);

			// Source group header (only shown when multiple sources)
			if (multiSource) {
				const shortSrc = source.split('/').pop() ?? source; // e.g. "STM32F0x0.svd"
				const sessionFamilyPfx2 = s.mcuConfig?.family.toUpperCase().slice(0, 6) ?? '';
				const srcPfx = shortSrc.toUpperCase().slice(0, 6);
				const isMismatch = sessionFamilyPfx2 && srcPfx && sessionFamilyPfx2 !== srcPfx;
				sidebar.appendChild($t('div', (isMismatch ? '[!] ' : '') + shortSrc, [
					'padding:6px 12px 4px',
					'font-size:10px', 'font-weight:700',
					'letter-spacing:0.05em', 'text-transform:uppercase',
					isMismatch
						? 'color:#e0a84e;border-top:1px solid rgba(255,180,0,0.3);margin-top:4px;'
						: 'color:var(--vscode-focusBorder);border-top:1px solid var(--vscode-widget-border);margin-top:4px;',
				].join(';')));
			}

			for (const map of group) {
				const item = $e('div', [
					'padding:7px 12px 7px 9px',
					'cursor:pointer', 'font-size:12px',
					'border-left:3px solid transparent',
					'transition:background 0.1s',
				].join(';'));
				item.dataset.periph = map.name;
				item.appendChild($t('div', map.name, 'font-size:12px;'));
				item.appendChild($t('div', `${map.registers.length} regs \u00b7 0x${map.baseAddress.toString(16).toUpperCase()}`,
					'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:1px;'));
				item.addEventListener('mouseenter', () => {
					if (item.style.background !== 'var(--vscode-list-activeSelectionBackground)') {
						item.style.background = 'var(--vscode-list-hoverBackground)';
					}
				});
				item.addEventListener('mouseleave', () => {
					if (item.style.borderLeft !== '3px solid var(--vscode-focusBorder)') {
						item.style.background = 'transparent';
					}
				});
				item.addEventListener('click', () => showPeriph(map));
				sidebar.appendChild(item);
			}
		}

		layout.appendChild(sidebar);
		layout.appendChild(detail);

		// Default selection
		showPeriph(s.registerMaps[0]);
	}

	private _renderPeripheralDetail(container: HTMLElement, map: IPeripheralRegisterMap): void {
		// Header
		const hdr = $e('div', 'margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border));');
		hdr.appendChild($t('h3', `${map.name}`, 'margin:0 0 4px 0;font-size:16px;font-weight:700;'));
		const srcLabel = map.source ? ` \u00b7 ${map.source.split('/').pop()}` : '';
		hdr.appendChild($t('div', `${map.groupName} \u00b7 Base 0x${map.baseAddress.toString(16).toUpperCase()} \u00b7 ${map.registers.length} registers${srcLabel}`,
			'font-size:11px;color:var(--vscode-descriptionForeground);'));
		if (map.description) {
			hdr.appendChild($t('div', map.description, 'font-size:12px;margin-top:6px;color:var(--vscode-descriptionForeground);'));
		}
		container.appendChild(hdr);

		// Interrupts
		if (map.interrupts.length > 0) {
			container.appendChild($t('div', 'Interrupts', [
				'font-size:10px', 'font-weight:700', 'letter-spacing:0.07em',
				'text-transform:uppercase', 'color:var(--vscode-descriptionForeground)',
				'margin-bottom:6px',
			].join(';')));
			for (const irq of map.interrupts) {
				container.appendChild($t('div', `IRQ ${irq.value}: ${irq.name} \u2014 ${irq.description}`,
					'font-size:12px;padding:2px 0;'));
			}
			container.appendChild($e('div', 'height:1px;background:var(--vscode-widget-border);margin:12px 0;'));
		}

		// Registers
		for (const reg of map.registers) {
			const block = $e('div', [
				'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
				'border-radius:6px', 'margin-bottom:8px', 'overflow:hidden',
			].join(';'));

			// Register header
			const regHdr = $e('div', [
				'padding:8px 12px',
				'background:var(--vscode-sideBarSectionHeader-background)',
				'display:flex', 'justify-content:space-between', 'align-items:center',
			].join(';'));
			regHdr.appendChild($t('span', reg.name,
				'font-weight:700;font-family:var(--vscode-editor-font-family,monospace);font-size:13px;'));
			const absAddr = map.baseAddress + reg.addressOffset;
			regHdr.appendChild($t('span',
				`0x${absAddr.toString(16).toUpperCase()} | ${reg.size}b | ${reg.access} | RST=0x${reg.resetValue.toString(16).toUpperCase().padStart(reg.size / 4, '0')}`,
				'font-size:10px;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family,monospace);'));
			block.appendChild(regHdr);

			if (reg.description) {
				block.appendChild($t('div', reg.description,
					'padding:4px 12px;font-size:11px;color:var(--vscode-descriptionForeground);'));
			}

			// Bit fields
			if (reg.fields.length > 0) {
				const fieldArea = $e('div', 'padding:6px 12px 10px;');

				// Bit layout bar
				const bitBar = $e('div', [
					'display:flex', 'margin-bottom:6px',
					'font-size:9px', 'font-family:var(--vscode-editor-font-family,monospace)',
				].join(';'));
				const sorted = [...reg.fields].sort((a, b) => b.bitOffset - a.bitOffset);
				for (const field of sorted) {
					const cell = $e('div', [
						`flex:${field.bitWidth}`, 'min-width:0',
						'border:1px solid var(--vscode-widget-border)', 'border-radius:2px',
						'padding:3px 2px', 'text-align:center', 'margin:0 1px',
						'overflow:hidden', 'background:' + _fieldColor(field.access),
					].join(';'));
					cell.title = `${field.name} [${field.bitOffset + field.bitWidth - 1}:${field.bitOffset}] - ${field.description}`;
					cell.textContent = field.bitWidth >= 3 ? field.name : field.name.charAt(0);
					bitBar.appendChild(cell);
				}
				fieldArea.appendChild(bitBar);

				// Live Bit-Math State
				let currentValue: bigint = BigInt(reg.resetValue ?? 0);
				const cCodeDisplay = $e('div', [
					'display:flex', 'align-items:center', 'justify-content:space-between',
					'margin-top:16px', 'padding:8px 12px', 'background:var(--vscode-editor-background)',
					'border:1px solid var(--vscode-widget-border)', 'border-radius:4px',
					'font-family:var(--vscode-editor-font-family,monospace)', 'font-size:12px', 'color:var(--vscode-editor-foreground)',
				].join(';'));

				const cCodeText = $e('span');
				const copyBtn = $t('button', 'Copy', [
					'padding:2px 8px', 'background:var(--vscode-button-background)', 'color:var(--vscode-button-foreground)',
					'border:none', 'border-radius:2px', 'cursor:pointer', 'font-size:10px'
				].join(';'));

				const updateCCode = () => {
					const hexStr = currentValue.toString(16).toUpperCase().padStart(reg.size / 4, '0');
					cCodeText.textContent = `${map.name}->${reg.name} = 0x${hexStr};`;
				};

				copyBtn.addEventListener('click', async () => {
					await navigator.clipboard.writeText(cCodeText.textContent!);
					copyBtn.textContent = 'Copied!';
					setTimeout(() => copyBtn.textContent = 'Copy', 2000);
				});

				cCodeDisplay.appendChild(cCodeText);
				cCodeDisplay.appendChild(copyBtn);

				// Field rows
				for (const field of sorted) {
					const row = $e('div', 'display:grid;grid-template-columns:52px 80px 40px 60px 1fr;gap:8px;font-size:11px;padding:3px 0;align-items:center;');
					row.appendChild($t('span', `[${field.bitOffset + field.bitWidth - 1}:${field.bitOffset}]`,
						'color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family,monospace);'));
					row.appendChild($t('span', field.name, 'font-weight:600;'));
					row.appendChild($t('span', field.access.slice(0, 2).toUpperCase(), 'color:var(--vscode-descriptionForeground);'));

					// Interactive toggle control
					const controlWrap = $e('div');
					const isWritable = field.access.includes('write') || field.access === 'read-write';

					if (isWritable) {
						if (field.bitWidth === 1) {
							const cb = $e('input', 'margin:0;cursor:pointer;');
							cb.type = 'checkbox';
							const bitMask = 1n << BigInt(field.bitOffset);
							cb.checked = (currentValue & bitMask) !== 0n;
							cb.addEventListener('change', () => {
								if (cb.checked) {
									currentValue |= bitMask;
								} else {
									currentValue &= ~bitMask;
								}
								updateCCode();
							});
							controlWrap.appendChild(cb);
						} else {
							const input = $e('input', 'width:40px;font-size:10px;padding:2px 4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:2px;');
							input.type = 'text';
							const mask = ((1n << BigInt(field.bitWidth)) - 1n);
							const currentFieldVal = (currentValue >> BigInt(field.bitOffset)) & mask;
							input.value = '0x' + currentFieldVal.toString(16).toUpperCase();

							input.addEventListener('change', () => {
								try {
									const rawVal = input.value.trim().toLowerCase();
									const parsed = BigInt(rawVal.startsWith('0x') ? rawVal : '0x' + rawVal);
									const cleanVal = parsed & mask;
									input.value = '0x' + cleanVal.toString(16).toUpperCase();

									// Clear field bits, then OR new val
									currentValue &= ~(mask << BigInt(field.bitOffset));
									currentValue |= (cleanVal << BigInt(field.bitOffset));
									updateCCode();
								} catch {
									// Revert on error
									const oldVal = (currentValue >> BigInt(field.bitOffset)) & mask;
									input.value = '0x' + oldVal.toString(16).toUpperCase();
								}
							});
							controlWrap.appendChild(input);
						}
					} else {
						controlWrap.appendChild($t('span', '-', 'color:var(--vscode-descriptionForeground);text-align:center;display:block;'));
					}
					row.appendChild(controlWrap);

					row.appendChild($t('span', field.description, 'color:var(--vscode-descriptionForeground);line-height:1.4;'));
					fieldArea.appendChild(row);
				}

				updateCCode();
				fieldArea.appendChild(cCodeDisplay);
				block.appendChild(fieldArea);
			}

			container.appendChild(block);
		}
	}


	// ─── Serial Monitor ───────────────────────────────────────────────────────

	private _renderSerial(root: HTMLElement): void {
		const svc = this._serialSvc;
		const state = svc.connectionState;
		const isConnected = state.isConnected;

		const wrapper = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;');
		root.appendChild(wrapper);

		// ── Connection control bar ─────────────────────────────────────────────
		const connBar = $e('div', [
			'display:flex', 'align-items:center', 'gap:8px',
			'padding:6px 14px', 'flex-shrink:0',
			'border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
			'background:var(--vscode-sideBarSectionHeader-background)',
		].join(';'));

		connBar.appendChild($t('span', 'Port:', 'font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);'));

		// Port dropdown — populated from real listPorts() on next tick
		const portSel = this._select(['/dev/ttyUSB0', '/dev/ttyACM0', '/dev/cu.usbserial', 'COM3', 'COM4']);
		if (state.port) {
			let found = false;
			Array.from(portSel.options).forEach(o => { if (o.value === state.port) { o.selected = found = true; } });
			if (!found) {
				const o = $e('option'); o.value = state.port; o.textContent = state.port;
				portSel.insertBefore(o, portSel.firstChild);
				(portSel.firstChild as HTMLOptionElement).selected = true;
			}
		}
		connBar.appendChild(portSel);

		// Refresh ports button
		const refreshBtn = $t('button', '<<', [
			'padding:2px 6px', 'border:1px solid var(--vscode-widget-border)', 'border-radius:3px',
			'background:transparent', 'color:var(--vscode-foreground)', 'cursor:pointer', 'font-size:12px',
			'title:Refresh port list',
		].join(';'));
		refreshBtn.title = 'Refresh available ports';
		refreshBtn.addEventListener('click', async () => {
			const ports = await svc.listPorts();
			while (portSel.options.length > 0) { portSel.remove(0); }
			for (const p of ports) {
				const o = $e('option'); o.value = p.path; o.textContent = p.path + (p.manufacturer ? ` (${p.manufacturer})` : '');
				portSel.appendChild(o);
			}
		});
		connBar.appendChild(refreshBtn);

		connBar.appendChild($t('span', 'Baud:', 'font-size:11px;font-weight:600;color:var(--vscode-descriptionForeground);'));
		const baudSel = this._select(['Auto', ...COMMON_BAUD_RATES.map(String)]);
		Array.from(baudSel.options).forEach(o => { if (o.value === String(state.baudRate ?? 115200)) { o.selected = true; } });
		connBar.appendChild(baudSel);

		// Status dot
		const dot = $e('span', [
			'width:7px', 'height:7px', 'border-radius:50%', 'flex-shrink:0',
			'background:' + (isConnected ? '#4caf50' : 'var(--vscode-descriptionForeground)'),
			'transition:background 0.2s',
		].join(';'));
		connBar.appendChild(dot);

		// Connect / Disconnect button (calls real service)
		const connectBtn = this._btn(
			isConnected ? 'Disconnect' : 'Connect',
			!isConnected,
			async () => {
				if (isConnected) {
					await svc.disconnect();
				} else {
					const port = portSel.value;
					let baud = parseInt(baudSel.value, 10);
					if (isNaN(baud)) {
						// Auto-detect baud rate
						const detected = await svc.autoDetectBaudRate(port);
						baud = detected ?? 115200;
					}
					await svc.connect({ port, baudRate: baud, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
				}
			},
			'font-size:11px;padding:3px 10px;',
		);
		connBar.appendChild(connectBtn);

		const clearBtn = this._btn('Clear', false, () => {
			svc.clearBuffers();
			if (this._serialOutputEl) { while (this._serialOutputEl.firstChild) { this._serialOutputEl.removeChild(this._serialOutputEl.firstChild); } }
			if (this._serialOutputEl) {
				this._serialOutputEl.appendChild($t('span', 'Connect to a serial port to start monitoring...',
					'color:var(--vscode-descriptionForeground);opacity:0.4;'));
			}
		}, 'font-size:11px;padding:3px 10px;');
		connBar.appendChild(clearBtn);

		const exportBtn = this._btn('Export', false, () => {
			const log = svc.exportLog('text');
			const blob = new Blob([log], { type: 'text/plain' });
			const url = URL.createObjectURL(blob);
			const a = $e('a'); a.href = url; a.download = 'serial_log.txt';
			a.click(); URL.revokeObjectURL(url);
		}, 'font-size:11px;padding:3px 10px;');
		connBar.appendChild(exportBtn);

		connBar.appendChild($e('span', 'flex:1;'));

		// Hex mode toggle
		let _hexMode = false;
		const hexBtn = $t('span', 'HEX', [
			'font-size:10px', 'padding:2px 6px', 'border-radius:3px',
			'border:1px solid var(--vscode-widget-border)', 'cursor:pointer',
			'color:var(--vscode-descriptionForeground)',
		].join(';'));
		hexBtn.addEventListener('click', () => {
			_hexMode = !_hexMode;
			hexBtn.style.background = _hexMode ? 'var(--vscode-badge-background)' : 'transparent';
			hexBtn.style.color = _hexMode ? 'var(--vscode-badge-foreground)' : 'var(--vscode-descriptionForeground)';
		});
		connBar.appendChild(hexBtn);

		wrapper.appendChild(connBar);

		// Stat bar beneath toolbar
		if (isConnected) {
			const statBar = $e('div', 'padding:2px 14px;font-size:10px;color:var(--vscode-descriptionForeground);background:var(--vscode-editorWidget-background);flex-shrink:0;');
			const since = state.connectedSince ? new Date(state.connectedSince).toLocaleTimeString() : '';
			statBar.textContent = `Connected to ${state.port} @ ${state.baudRate} baud since ${since}  /  RX ${state.bytesReceived} B  /  TX ${state.bytesTransmitted} B`;
			wrapper.appendChild(statBar);
		}

		// ── Output area ────────────────────────────────────────────────────────
		this._serialOutputEl = $e('div', [
			'flex:1', 'overflow-y:auto', 'padding:8px 14px',
			'font-family:var(--vscode-editor-font-family,"Cascadia Code","Fira Code",monospace)',
			'font-size:12px', 'line-height:1.65', 'white-space:pre-wrap',
			'background:var(--vscode-terminal-background,var(--vscode-editor-background))',
		].join(';'));

		const rxBuf = svc.rxBuffer;
		const txBuf = svc.txBuffer;

		if (rxBuf.length === 0 && txBuf.length === 0) {
			this._serialOutputEl.appendChild($t('span', 'Connect to a serial port to start monitoring...',
				'color:var(--vscode-descriptionForeground);opacity:0.4;'));
		} else {
			// Merge and sort by timestamp
			const all = [...rxBuf.map(l => ({ ...l, dir: 'rx' as const })),
			...txBuf.map(l => ({ ...l, dir: 'tx' as const }))]
				.sort((a, b) => a.timestamp - b.timestamp);
			for (const l of all) {
				this._appendSerialLine(this._serialOutputEl, l.text, l.dir, l.timestamp);
			}
			// Scroll to bottom
			this._serialOutputEl.scrollTop = this._serialOutputEl.scrollHeight;
		}
		wrapper.appendChild(this._serialOutputEl);

		// ── Input bar ──────────────────────────────────────────────────────────
		const inputBar = $e('div', [
			'display:flex', 'gap:6px', 'padding:6px 14px', 'flex-shrink:0',
			'border-top:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
			'background:var(--vscode-terminal-background,var(--vscode-editor-background))',
		].join(';'));

		this._serialInputEl = $e('input', [
			'flex:1', 'padding:5px 10px',
			'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
			'border-radius:4px', 'background:var(--vscode-input-background)',
			'color:var(--vscode-input-foreground)', 'font-size:12px',
			'font-family:var(--vscode-editor-font-family,monospace)', 'outline:none',
		].join(';')) as HTMLInputElement;
		this._serialInputEl.type = 'text';
		this._serialInputEl.placeholder = 'Type command and press Enter...';
		this._serialInputEl.addEventListener('keydown', async (e) => {
			if (e.key === 'Enter' && this._serialInputEl?.value) {
				await svc.send(this._serialInputEl.value, true);
				this._serialInputEl.value = '';
			}
		});
		inputBar.appendChild(this._serialInputEl);
		inputBar.appendChild(this._btn('Send', true, async () => {
			if (this._serialInputEl?.value) {
				await svc.send(this._serialInputEl.value, true);
				this._serialInputEl.value = '';
			}
		}, 'font-size:11px;padding:5px 14px;'));

		wrapper.appendChild(inputBar);
	}

	/** Append a single serial line to the output DOM node. */
	private _appendSerialLine(container: HTMLElement, text: string, dir: 'tx' | 'rx', timestamp: number): void {
		const isPlaceholder = container.firstChild && (container.firstChild as HTMLElement).tagName === 'SPAN' &&
			(container.firstChild as HTMLElement).style.opacity === '0.4';
		if (isPlaceholder) { container.removeChild(container.firstChild!); }

		const row = $e('div', '');
		const ts = new Date(timestamp).toISOString().slice(11, 23);
		row.appendChild($t('span', `[${ts}] `, 'color:var(--vscode-descriptionForeground);opacity:0.4;'));
		row.appendChild($t('span', dir === 'tx' ? '\u2192 ' : '\u2190 ',
			`color:${dir === 'tx' ? 'var(--vscode-terminal-ansiBlue,#60a5fa)' : 'var(--vscode-terminal-ansiGreen,#4ade80)'};font-weight:600;`));
		row.appendChild($t('span', text, 'color:var(--vscode-terminal-foreground,var(--vscode-editor-foreground));'));
		container.appendChild(row);
	}


	// ─── Compliance ───────────────────────────────────────────────────────────

	private _renderCompliance(root: HTMLElement): void {
		const s = this._session.session;
		const scroll = $e('div', 'flex:1;overflow-y:auto;padding:20px;');
		root.appendChild(scroll);

		scroll.appendChild($t('h3', 'Compliance Dashboard', 'margin:0 0 16px;font-size:15px;font-weight:700;'));

		const frameworks = [
			{ id: 'misra-c-2012', label: 'MISRA C:2012', desc: 'Motor Industry Software Reliability Association C guidelines' },
			{ id: 'misra-c-2023', label: 'MISRA C:2023', desc: 'Latest edition of MISRA C rules' },
			{ id: 'cert-c', label: 'CERT C', desc: 'SEI CERT C Coding Standard' },
			{ id: 'iec-62304', label: 'IEC 62304', desc: 'Medical device software lifecycle processes' },
			{ id: 'iso-26262', label: 'ISO 26262', desc: 'Road vehicles - Functional Safety (ASIL)' },
			{ id: 'do-178c', label: 'DO-178C', desc: 'Software considerations in airborne systems' },
			{ id: 'autosar', label: 'AUTOSAR', desc: 'Automotive Open System Architecture guidelines' },
			{ id: 'iec-61508', label: 'IEC 61508', desc: 'Functional safety of E/E/PE safety-related systems' },
		];

		const grid = $e('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin-bottom:20px;');

		for (const fw of frameworks) {
			const active = s.complianceFrameworks.includes(fw.id as FirmwareComplianceFramework);
			const card = $e('div', [
				'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
				'border-radius:7px', 'padding:14px 16px',
				active ? 'border-left:3px solid #4caf50;' : '',
				'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
				'cursor:pointer', 'transition:border-color 0.1s,background 0.1s',
			].join(';'));

			card.addEventListener('mouseenter', () => { card.style.background = 'var(--vscode-list-hoverBackground)'; });
			card.addEventListener('mouseleave', () => { card.style.background = 'var(--vscode-sideBar-background,var(--vscode-editor-background))'; });

			const top = $e('div', 'display:flex;align-items:center;gap:8px;margin-bottom:6px;');
			top.appendChild($t('span', fw.label, 'font-weight:700;font-size:12px;flex:1;'));
			if (active) {
				top.appendChild($t('span', 'ACTIVE', [
					'font-size:9px', 'font-weight:700', 'padding:2px 7px', 'border-radius:3px',
					'background:#4caf50',
					'color:var(--vscode-editor-background)',
				].join(';')));
			}
			card.appendChild(top);
			card.appendChild($t('div', fw.desc, 'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;'));

			grid.appendChild(card);
		}

		scroll.appendChild(grid);
	}


	// ─── Build ────────────────────────────────────────────────────────────────

	// \u2500\u2500\u2500 Build tab state \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	private _buildOutputLines: string[] = [];
	private _lastFlashResult: IFlashResult | undefined;
	private _lastBinaryAnalysis: IBinarySizeAnalysis | undefined;
	private _lastStackReport: IStackUsageReport | undefined;
	private _lastSymbols: IElfSymbol[] = [];
	private _buildSubTab: 'output' | 'diagnostics' | 'size' | 'symbols' | 'disasm' | 'stack' | 'toolchain' | 'flash' = 'output';

	private _renderBuild(root: HTMLElement): void {
		const s = this._session.session;
		const projectType = s.projectInfo?.projectType ?? 'generic';
		const buildSystem = s.projectInfo?.buildSystem ?? s.buildSystem ?? projectType;

		// \u2500\u2500 Full-height panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const panel = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;');
		root.appendChild(panel);

		// \u2500\u2500 Toolbar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const toolbar = $e('div', [
			'padding:0 10px', 'height:36px', 'display:flex', 'align-items:center', 'gap:6px',
			'border-bottom:1px solid var(--vscode-widget-border)', 'flex-shrink:0', 'flex-wrap:wrap',
		].join(';'));

		// Project badge
		toolbar.appendChild($t('span', buildSystem.toUpperCase(), [
			'font-size:9px', 'font-weight:700', 'padding:2px 7px', 'border-radius:3px',
			'background:var(--vscode-badge-background)', 'color:var(--vscode-badge-foreground)',
			'flex-shrink:0',
		].join(';')));

		const mkBtn = (label: string, primary: boolean): HTMLButtonElement => {
			const btn = $e('button', [
				'padding:3px 11px', 'border-radius:3px', 'cursor:pointer', 'font-size:11px',
				'font-weight:600', 'white-space:nowrap', 'flex-shrink:0',
				primary
					? 'background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;'
					: 'background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-widget-border);',
			].join(';')) as HTMLButtonElement;
			btn.textContent = label;
			return btn;
		};

		const buildBtn = mkBtn('Build', true);
		const flashBtn = mkBtn('Flash', false);
		const cleanBtn = mkBtn('Clean', false);
		const abortBtn = mkBtn('Abort', false);
		abortBtn.style.color = 'var(--vscode-errorForeground)';
		abortBtn.style.borderColor = 'var(--vscode-errorForeground)';
		abortBtn.title = 'Abort running build/flash';

		// Build target input
		const targetInput = $e('input', [
			'width:100px', 'padding:2px 6px', 'font-size:10px', 'border-radius:3px',
			'background:var(--vscode-input-background)', 'color:var(--vscode-input-foreground)',
			'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))', 'flex-shrink:0',
		].join(';')) as HTMLInputElement;
		targetInput.placeholder = 'target (opt)';

		const statusLabel = $t('span', '', 'font-size:10px;color:var(--vscode-descriptionForeground);margin-left:4px;');
		const elapsedLabel = $t('span', '', 'font-size:10px;color:var(--vscode-descriptionForeground);margin-left:auto;flex-shrink:0;');

		toolbar.appendChild(buildBtn);
		toolbar.appendChild(flashBtn);
		toolbar.appendChild(cleanBtn);
		toolbar.appendChild(abortBtn);
		toolbar.appendChild(targetInput);
		toolbar.appendChild(statusLabel);
		toolbar.appendChild(elapsedLabel);
		panel.appendChild(toolbar);

		// \u2500\u2500 Command preview bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const cmdBar = $e('div', [
			'padding:3px 12px', 'font-size:9px', 'font-family:var(--vscode-editor-font-family,monospace)',
			'color:var(--vscode-descriptionForeground)', 'background:var(--vscode-sideBarSectionHeader-background)',
			'border-bottom:1px solid var(--vscode-widget-border)', 'flex-shrink:0', 'overflow:hidden',
			'text-overflow:ellipsis', 'white-space:nowrap',
		].join(';'));
		const updateCmdBar = (target?: string): void => {
			const bc = this._buildSvc.getBuildCommand(projectType, target || undefined);
			const fc = this._buildSvc.getFlashCommand(projectType);
			cmdBar.textContent = `build: ${bc.join(' ')}   \u2502   flash: ${fc.join(' ')}`;
		};
		updateCmdBar();
		targetInput.addEventListener('input', () => updateCmdBar(targetInput.value));
		panel.appendChild(cmdBar);

		// \u2500\u2500 Sub-tab bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		type SubTab = typeof this._buildSubTab;
		const subTabs: Array<{ id: SubTab; label: string }> = [
			{ id: 'output',      label: 'Output' },
			{ id: 'diagnostics', label: 'Diagnostics' },
			{ id: 'size',        label: 'Binary Size' },
			{ id: 'symbols',     label: 'Symbols' },
			{ id: 'disasm',      label: 'Disassembly' },
			{ id: 'stack',       label: 'Stack Usage' },
			{ id: 'toolchain',   label: 'Toolchain' },
			{ id: 'flash',       label: 'Flash Tools' },
		];

		const tabBar = $e('div', [
			'display:flex', 'align-items:stretch', 'border-bottom:1px solid var(--vscode-widget-border)',
			'background:var(--vscode-editorGroupHeader-tabsBackground)', 'flex-shrink:0', 'overflow-x:auto',
		].join(';'));
		const tabBtnMap = new Map<SubTab, HTMLButtonElement>();
		const content = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;');

		const activateSubTab = (id: SubTab): void => {
			this._buildSubTab = id;
			tabBtnMap.forEach((btn, tid) => {
				const active = tid === id;
				btn.style.color = active ? 'var(--vscode-tab-activeForeground)' : 'var(--vscode-tab-inactiveForeground)';
				btn.style.borderBottom = active ? '2px solid var(--vscode-tab-activeBorderTop,var(--vscode-focusBorder))' : '2px solid transparent';
				btn.style.background = active ? 'var(--vscode-tab-activeBackground)' : 'transparent';
			});
			renderSubTab(id);
		};

		for (const st of subTabs) {
			const btn = $e('button', [
				'padding:0 14px', 'height:33px', 'border:none', 'cursor:pointer', 'font-size:11px',
				'font-weight:500', 'white-space:nowrap', 'flex-shrink:0', 'color:var(--vscode-tab-inactiveForeground)',
				'border-bottom:2px solid transparent',
			].join(';')) as HTMLButtonElement;
			btn.textContent = st.label;
			btn.addEventListener('click', () => activateSubTab(st.id));
			tabBtnMap.set(st.id, btn);
			tabBar.appendChild(btn);
		}
		panel.appendChild(tabBar);
		panel.appendChild(content);

		// \u2500\u2500 Sub-tab renderers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

		const renderSubTab = (id: SubTab): void => {
			content.textContent = '';
			switch (id) {
				case 'output':      renderOutput(); break;
				case 'diagnostics': renderDiagnostics(); break;
				case 'size':        renderSize(); break;
				case 'symbols':     renderSymbols(); break;
				case 'disasm':      renderDisasm(); break;
				case 'stack':       renderStack(); break;
				case 'toolchain':   void renderToolchain(); break;
				case 'flash':       void renderFlashTools(); break;
			}
		};

		// \u2500\u2500 OUTPUT \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		let outputEl: HTMLElement;
		const renderOutput = (): void => {
			const wrap = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;min-height:0;');
			const clearBtn = $e('button', [
				'position:absolute', 'top:6px', 'right:10px', 'border:none', 'background:transparent',
				'color:var(--vscode-descriptionForeground)', 'cursor:pointer', 'font-size:10px', 'z-index:1',
			].join(';')) as HTMLButtonElement;
			clearBtn.textContent = 'Clear';
			clearBtn.addEventListener('click', () => { this._buildOutputLines = []; repaintOutput(); });

			const rel = $e('div', 'flex:1;position:relative;overflow:hidden;min-height:0;');
			rel.appendChild(clearBtn);
			outputEl = $e('div', [
				'flex:1', 'height:100%', 'overflow-y:auto', 'padding:8px 12px',
				'font-family:var(--vscode-editor-font-family,monospace)', 'font-size:11px', 'line-height:1.65',
				'background:var(--vscode-terminal-background,#1e1e1e)',
				'color:var(--vscode-terminal-foreground,#cccccc)',
				'white-space:pre-wrap', 'word-break:break-all',
			].join(';'));
			rel.appendChild(outputEl);
			wrap.appendChild(rel);
			content.appendChild(wrap);
			repaintOutput();
		};

		const repaintOutput = (): void => {
			if (!outputEl) return;
			outputEl.textContent = '';
			if (this._buildOutputLines.length === 0) {
				outputEl.appendChild($t('div', 'Build output will appear here...', 'opacity:0.4;'));
				return;
			}
			const frag = document.createDocumentFragment();
			for (const line of this._buildOutputLines.slice(-2000)) {
				const el = $e('div', '');
				el.textContent = line;
				if (/\berror[:\s]/i.test(line)) el.style.color = 'var(--vscode-errorForeground,#f48771)';
				else if (/\bwarning[:\s]/i.test(line)) el.style.color = 'var(--vscode-editorWarning-foreground,#ffcc02)';
				else if (line.startsWith('$') || line.startsWith('>')) el.style.color = 'var(--vscode-terminal-ansiCyan,#80cbc4)';
				else if (/^\u2713|^\u2717/.test(line)) el.style.color = line.startsWith('\u2713') ? '#4caf50' : 'var(--vscode-errorForeground)';
				frag.appendChild(el);
			}
			outputEl.appendChild(frag);
			outputEl.scrollTop = outputEl.scrollHeight;
		};

		// \u2500\u2500 DIAGNOSTICS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const renderDiagnostics = (): void => {
			const result = this._buildSvc.lastBuildResult ?? s.lastBuildResult;
			if (!result) {
				content.appendChild(this._emptyState('No Diagnostics', 'Run a build to see structured errors and warnings.'));
				return;
			}

			const wrap = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;');
			// Summary strip
			const sumRow = $e('div', [
				'padding:6px 14px', 'display:flex', 'gap:16px', 'align-items:center', 'flex-shrink:0',
				'border-bottom:1px solid var(--vscode-widget-border)',
				'background:var(--vscode-sideBarSectionHeader-background)',
			].join(';'));
			const c = result.success ? '#4caf50' : 'var(--vscode-errorForeground)';
			sumRow.appendChild($t('span', result.success ? '\u2713 SUCCESS' : '\u2717 FAILED', `font-size:11px;font-weight:700;color:${c};`));
			sumRow.appendChild($t('span', `${result.durationMs}ms`, 'font-size:10px;color:var(--vscode-descriptionForeground);'));
			sumRow.appendChild($t('span', `${result.errors.length} error${result.errors.length !== 1 ? 's' : ''}`, `font-size:11px;font-weight:600;color:${result.errors.length > 0 ? 'var(--vscode-errorForeground)' : '#4caf50'};`));
			sumRow.appendChild($t('span', `${result.warnings.length} warning${result.warnings.length !== 1 ? 's' : ''}`, `font-size:11px;color:${result.warnings.length > 0 ? 'var(--vscode-editorWarning-foreground)' : 'var(--vscode-descriptionForeground)'};`));
			if (result.outputPath) sumRow.appendChild($t('span', result.outputPath.split('/').pop()!, 'font-size:10px;color:var(--vscode-descriptionForeground);margin-left:auto;'));
			wrap.appendChild(sumRow);

			const diagScroll = $e('div', 'flex:1;overflow-y:auto;');
			wrap.appendChild(diagScroll);
			content.appendChild(wrap);

			const mkDiagRow = (sev: 'error' | 'warning', file: string, line: number, col: number | undefined, message: string, code?: string): HTMLElement => {
				const row = $e('div', 'display:flex;align-items:flex-start;gap:8px;padding:5px 12px;border-bottom:1px solid var(--vscode-widget-border);cursor:pointer;');
				row.addEventListener('mouseenter', () => { row.style.background = 'var(--vscode-list-hoverBackground)'; });
				row.addEventListener('mouseleave', () => { row.style.background = ''; });

				const badge = $t('span', sev === 'error' ? 'E' : 'W', [
					'font-size:8px', 'font-weight:700', 'padding:1px 4px', 'border-radius:2px', 'flex-shrink:0', 'margin-top:1px',
					sev === 'error'
						? 'background:var(--vscode-errorForeground);color:#fff;'
						: 'background:var(--vscode-editorWarning-foreground);color:#000;',
				].join(';'));
				row.appendChild(badge);

				const info = $e('div', 'min-width:0;flex:1;');
				const msgLine = $e('div', 'display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;');
				msgLine.appendChild($t('span', message, `font-size:11px;color:${sev === 'error' ? 'var(--vscode-errorForeground)' : 'var(--vscode-editorWarning-foreground)'};`));
				if (code) msgLine.appendChild($t('span', `[${code}]`, 'font-size:9px;color:var(--vscode-descriptionForeground);'));
				info.appendChild(msgLine);
				const locLine = $t('span', `${file}:${line}${col ? ':' + col : ''}`, 'font-size:9px;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family,monospace);');
				info.appendChild(locLine);
				row.appendChild(info);
				return row;
			};

			for (const err of result.errors) diagScroll.appendChild(mkDiagRow('error', err.file, err.line, err.column, err.message, err.code));
			for (const w of result.warnings) diagScroll.appendChild(mkDiagRow('warning', w.file, w.line, w.column, w.message, w.code));

			if (result.errors.length === 0 && result.warnings.length === 0) {
				diagScroll.appendChild($t('div', 'No errors or warnings.', 'padding:20px;color:var(--vscode-descriptionForeground);font-size:11px;'));
			}
		};

		// \u2500\u2500 BINARY SIZE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const renderSize = (): void => {
			const a = this._lastBinaryAnalysis;
			const mcuFlash = s.mcuConfig?.flashSize ?? 0;
			const mcuRam = s.mcuConfig?.ramSize ?? 0;

			const wrap = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;');
			const hdr = $e('div', 'padding:6px 14px;border-bottom:1px solid var(--vscode-widget-border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;background:var(--vscode-sideBarSectionHeader-background);');
			hdr.appendChild($t('span', 'BINARY SIZE', 'font-size:10px;font-weight:700;letter-spacing:.05em;color:var(--vscode-descriptionForeground);'));
			const analyzeBtn = mkBtn('Analyze', false);
			analyzeBtn.style.fontSize = '10px';
			analyzeBtn.style.padding = '2px 8px';
			analyzeBtn.addEventListener('click', async () => {
				analyzeBtn.disabled = true;
				analyzeBtn.textContent = 'Running...';
				statusLabel.textContent = 'Analyzing binary...';
				const elfPath = s.lastBuildResult?.outputPath ?? 'auto';
				this._lastBinaryAnalysis = await this._buildSvc.analyzeBinarySize(elfPath, mcuFlash, mcuRam);
				analyzeBtn.textContent = 'Analyze';
				analyzeBtn.disabled = false;
				statusLabel.textContent = '';
				renderSubTab('size');
			});
			hdr.appendChild(analyzeBtn);
			wrap.appendChild(hdr);

			if (!a || (a.flashUsage === 0 && a.sections.length === 0)) {
				const empty = $e('div', 'flex:1;display:flex;align-items:center;justify-content:center;');
				empty.appendChild($t('div', 'Click Analyze to run arm-none-eabi-size on the ELF binary.', 'color:var(--vscode-descriptionForeground);font-size:12px;'));
				wrap.appendChild(empty);
				content.appendChild(wrap);
				return;
			}

			const body = $e('div', 'flex:1;overflow-y:auto;padding:14px;');
			wrap.appendChild(body);
			content.appendChild(wrap);

			const mkBar = (label: string, used: number, total: number, pct: number): HTMLElement => {
				const el = $e('div', 'margin-bottom:14px;');
				const top = $e('div', 'display:flex;justify-content:space-between;margin-bottom:4px;');
				top.appendChild($t('span', label, 'font-size:11px;font-weight:600;'));
				top.appendChild($t('span', `${(used / 1024).toFixed(1)} KB / ${total ? (total / 1024).toFixed(0) + ' KB' : '?'}  (${pct.toFixed(1)}%)`, 'font-size:10px;color:var(--vscode-descriptionForeground);'));
				el.appendChild(top);
				const outer = $e('div', 'height:18px;background:var(--vscode-input-background);border-radius:3px;overflow:hidden;');
				const color = pct > 90 ? 'var(--vscode-errorForeground)' : pct > 75 ? 'var(--vscode-editorWarning-foreground)' : 'var(--vscode-progressBar-background)';
				outer.appendChild($e('div', `height:100%;width:${Math.min(pct, 100)}%;background:${color};border-radius:3px;transition:width .4s;`));
				el.appendChild(outer);
				if (pct > 90) el.appendChild($t('div', `\u26a0 Only ${(total - used) / 1024 < 1 ? Math.round(total - used) + ' B' : ((total - used) / 1024).toFixed(1) + ' KB'} remaining`, 'font-size:10px;color:var(--vscode-errorForeground);margin-top:3px;'));
				return el;
			};

			body.appendChild(mkBar('Flash', a.flashUsage, mcuFlash, mcuFlash > 0 ? a.flashPercent : 0));
			body.appendChild(mkBar('RAM', a.ramUsage, mcuRam, mcuRam > 0 ? a.ramPercent : 0));

			// Section breakdown
			if (a.sections.length > 0 || a.textSize > 0) {
				body.appendChild($t('div', 'SECTIONS', 'font-size:10px;font-weight:700;letter-spacing:.05em;color:var(--vscode-descriptionForeground);margin:16px 0 8px;'));
				const tbl = $e('div', 'font-family:var(--vscode-editor-font-family,monospace);font-size:11px;border:1px solid var(--vscode-widget-border);border-radius:3px;overflow:hidden;');
				const hdrRow = $e('div', 'display:grid;grid-template-columns:130px 90px 90px 120px;padding:4px 10px;background:var(--vscode-sideBarSectionHeader-background);font-size:10px;font-weight:700;color:var(--vscode-descriptionForeground);');
				hdrRow.appendChild($t('span', 'Section', ''));
				hdrRow.appendChild($t('span', 'Size', ''));
				hdrRow.appendChild($t('span', 'Addr', ''));
				tbl.appendChild(hdrRow);

				const sections = a.sections.length > 0 ? a.sections : [
					{ name: '.text', size: a.textSize, address: 0x08000000 },
					{ name: '.data', size: a.dataSize, address: 0x20000000 },
					{ name: '.bss',  size: a.bssSize,  address: 0x20000000 + a.dataSize },
				];
				for (const sec of sections.filter(sec => sec.size > 0)) {
					const row = $e('div', 'display:grid;grid-template-columns:130px 90px 120px;padding:4px 10px;border-top:1px solid var(--vscode-widget-border);');
					row.appendChild($t('span', sec.name, ''));
					row.appendChild($t('span', sec.size >= 1024 ? `${(sec.size / 1024).toFixed(1)} KB` : `${sec.size} B`, ''));
					row.appendChild($t('span', `0x${sec.address.toString(16).toUpperCase().padStart(8, '0')}`, 'color:var(--vscode-descriptionForeground);'));
					tbl.appendChild(row);
				}
				body.appendChild(tbl);
			}
		};

		// \u2500\u2500 SYMBOLS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const renderSymbols = (): void => {
			const wrap = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;');
			const hdr = $e('div', 'padding:6px 10px;border-bottom:1px solid var(--vscode-widget-border);display:flex;gap:6px;align-items:center;flex-shrink:0;background:var(--vscode-sideBarSectionHeader-background);');
			const searchInput = $e('input', 'flex:1;padding:3px 7px;font-size:10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-widget-border));border-radius:3px;') as HTMLInputElement;
			searchInput.placeholder = 'Search symbols (regex)...';
			const searchBtn = mkBtn('Search', true);
			searchBtn.style.fontSize = '10px';
			searchBtn.style.padding = '2px 8px';
			hdr.appendChild(searchInput);
			hdr.appendChild(searchBtn);
			wrap.appendChild(hdr);

			const body = $e('div', 'flex:1;overflow-y:auto;');
			wrap.appendChild(body);
			content.appendChild(wrap);

			const renderSymTable = (syms: IElfSymbol[]): void => {
				body.textContent = '';
				if (syms.length === 0) {
					body.appendChild($t('div', 'No symbols found.', 'padding:16px;color:var(--vscode-descriptionForeground);font-size:11px;'));
					return;
				}
				const tbl = $e('div', 'font-family:var(--vscode-editor-font-family,monospace);font-size:11px;');
				const hdrRow = $e('div', 'display:grid;grid-template-columns:110px 70px 50px 60px 1fr;padding:4px 10px;background:var(--vscode-sideBarSectionHeader-background);font-size:10px;font-weight:700;color:var(--vscode-descriptionForeground);position:sticky;top:0;');
				for (const col of ['Address', 'Size', 'Bind', 'Type', 'Name']) hdrRow.appendChild($t('span', col, ''));
				tbl.appendChild(hdrRow);
				for (const sym of syms.slice(0, 500)) {
					const row = $e('div', 'display:grid;grid-template-columns:110px 70px 50px 60px 1fr;padding:3px 10px;border-top:1px solid var(--vscode-widget-border);');
					row.appendChild($t('span', `0x${sym.address.toString(16).padStart(8, '0')}`, ''));
					row.appendChild($t('span', sym.size !== undefined ? (sym.size >= 1024 ? `${(sym.size / 1024).toFixed(1)}K` : `${sym.size}`) : '\u2014', 'color:var(--vscode-descriptionForeground);'));
					row.appendChild($t('span', sym.binding, 'color:var(--vscode-descriptionForeground);'));
					const typeColors: Record<string, string> = { function: '#4fc3f7', object: '#81c784', section: '#ffb74d', file: '#9e9e9e', unknown: '#616161' };
					row.appendChild($t('span', sym.type, `color:${typeColors[sym.type] ?? '#616161'};`));
					row.appendChild($t('span', sym.name, 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
					tbl.appendChild(row);
				}
				if (syms.length > 500) tbl.appendChild($t('div', `... ${syms.length - 500} more symbols`, 'padding:6px 10px;color:var(--vscode-descriptionForeground);font-size:10px;'));
				body.appendChild(tbl);
			};

			if (this._lastSymbols.length > 0) renderSymTable(this._lastSymbols);
			else body.appendChild($t('div', 'Enter a pattern and click Search to look up ELF symbols.', 'padding:16px;color:var(--vscode-descriptionForeground);font-size:11px;'));

			const doSearch = async (): Promise<void> => {
				const elfPath = s.lastBuildResult?.outputPath;
				if (!elfPath) { body.textContent = ''; body.appendChild($t('div', 'Build the project first \u2014 ELF not available.', 'padding:16px;color:var(--vscode-errorForeground);font-size:11px;')); return; }
				searchBtn.disabled = true;
				searchBtn.textContent = '...';
				this._lastSymbols = await this._buildSvc.lookupSymbols(elfPath, searchInput.value);
				renderSymTable(this._lastSymbols);
				searchBtn.textContent = 'Search';
				searchBtn.disabled = false;
			};
			searchBtn.addEventListener('click', () => { void doSearch(); });
			searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void doSearch(); });
		};

		// \u2500\u2500 DISASSEMBLY \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const renderDisasm = (): void => {
			const wrap = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;');
			const hdr = $e('div', 'padding:6px 10px;border-bottom:1px solid var(--vscode-widget-border);display:flex;gap:6px;align-items:center;flex-shrink:0;background:var(--vscode-sideBarSectionHeader-background);');
			const symInput = $e('input', 'flex:1;padding:3px 7px;font-size:10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-widget-border));border-radius:3px;') as HTMLInputElement;
			symInput.placeholder = 'Function name (e.g. HAL_UART_IRQHandler)';
			const disasmBtn = mkBtn('Disassemble', true);
			disasmBtn.style.fontSize = '10px';
			disasmBtn.style.padding = '2px 8px';
			hdr.appendChild(symInput);
			hdr.appendChild(disasmBtn);
			wrap.appendChild(hdr);

			const body = $e('div', [
				'flex:1', 'overflow-y:auto', 'padding:8px 12px',
				'font-family:var(--vscode-editor-font-family,monospace)', 'font-size:11px', 'line-height:1.6',
				'background:var(--vscode-terminal-background,#1e1e1e)', 'color:var(--vscode-terminal-foreground,#ccc)',
			].join(';'));
			body.appendChild($t('div', 'Enter a function name and click Disassemble.', 'opacity:0.4;'));
			wrap.appendChild(body);
			content.appendChild(wrap);

			const doDisasm = async (): Promise<void> => {
				const sym = symInput.value.trim();
				if (!sym) return;
				const elfPath = s.lastBuildResult?.outputPath;
				if (!elfPath) { body.textContent = ''; body.appendChild($t('div', 'Build project first.', 'color:var(--vscode-errorForeground);')); return; }
				disasmBtn.disabled = true;
				disasmBtn.textContent = '...';
				body.textContent = '';
				try {
					const result = await this._buildSvc.disassemble(elfPath, sym);
					if (result.lines.length === 0) {
						body.appendChild($t('div', `Symbol "${sym}" not found in ELF. Use Symbols tab to search.`, 'color:var(--vscode-errorForeground);'));
					} else {
						body.appendChild($t('div', `${sym}  @  0x${result.address.toString(16).padStart(8, '0')}  \u2014  ${result.sizeBytes} bytes  /  ${result.lines.length} instructions`, 'color:var(--vscode-terminal-ansiCyan,#80cbc4);margin-bottom:8px;'));
						for (const line of result.lines) {
							const row = $e('div', 'display:flex;gap:16px;');
							row.appendChild($t('span', `0x${line.address.toString(16).padStart(8, '0')}`, 'color:#616161;flex-shrink:0;'));
							row.appendChild($t('span', line.mnemonic, 'color:#e3b96a;flex-shrink:0;width:60px;'));
							const ops = $t('span', line.operands, 'color:var(--vscode-terminal-foreground,#ccc);');
							if (line.comment) ops.title = line.comment;
							row.appendChild(ops);
							if (line.comment) row.appendChild($t('span', `; ${line.comment}`, 'color:#616161;font-size:10px;'));
							body.appendChild(row);
						}
					}
				} catch (err: any) {
					body.appendChild($t('div', err.message ?? String(err), 'color:var(--vscode-errorForeground);'));
				}
				disasmBtn.textContent = 'Disassemble';
				disasmBtn.disabled = false;
			};
			disasmBtn.addEventListener('click', () => { void doDisasm(); });
			symInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') void doDisasm(); });
		};

		// \u2500\u2500 STACK USAGE \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const renderStack = (): void => {
			const wrap = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;');
			const hdr = $e('div', 'padding:6px 14px;border-bottom:1px solid var(--vscode-widget-border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0;background:var(--vscode-sideBarSectionHeader-background);');
			hdr.appendChild($t('span', 'STACK USAGE', 'font-size:10px;font-weight:700;letter-spacing:.05em;color:var(--vscode-descriptionForeground);'));
			const analyzeStackBtn = mkBtn('Analyze', false);
			analyzeStackBtn.style.fontSize = '10px';
			analyzeStackBtn.style.padding = '2px 8px';
			hdr.appendChild(analyzeStackBtn);
			wrap.appendChild(hdr);

			const body = $e('div', 'flex:1;overflow-y:auto;padding:10px 14px;');
			wrap.appendChild(body);
			content.appendChild(wrap);

			const renderReport = (r: IStackUsageReport): void => {
				body.textContent = '';
				if (r.functions.length === 0) {
					body.appendChild($t('div', 'No .su files found. Build with -fstack-usage flag (add to CFLAGS) to enable stack analysis.', 'color:var(--vscode-descriptionForeground);font-size:11px;'));
					return;
				}

				// Summary
				body.appendChild($t('div', `Max stack depth: ${r.maxStack} bytes \u2014 ${r.maxStackFunction}`, `font-size:12px;font-weight:600;color:${r.maxStack > 512 ? 'var(--vscode-editorWarning-foreground)' : '#4caf50'};margin-bottom:12px;`));

				// Table sorted by stack depth desc
				const sorted = [...r.functions].sort((a, b) => b.bytes - a.bytes);
				const tbl = $e('div', 'font-family:var(--vscode-editor-font-family,monospace);font-size:10px;border:1px solid var(--vscode-widget-border);border-radius:3px;overflow:hidden;');
				const hdrRow = $e('div', 'display:grid;grid-template-columns:70px 160px 1fr;padding:4px 8px;background:var(--vscode-sideBarSectionHeader-background);font-size:9px;font-weight:700;color:var(--vscode-descriptionForeground);');
				for (const col of ['Bytes', 'Qualifier', 'Function']) hdrRow.appendChild($t('span', col, ''));
				tbl.appendChild(hdrRow);

				for (const fn of sorted.slice(0, 100)) {
					const row = $e('div', 'display:grid;grid-template-columns:70px 160px 1fr;padding:3px 8px;border-top:1px solid var(--vscode-widget-border);align-items:center;');
					const sizeColor = fn.bytes > 256 ? 'var(--vscode-errorForeground)' : fn.bytes > 128 ? 'var(--vscode-editorWarning-foreground)' : '';
					row.appendChild($t('span', String(fn.bytes), sizeColor ? `font-weight:700;color:${sizeColor};` : ''));
					const qualColor: Record<string, string> = { 'static': '#4caf50', 'dynamic': '#ff9800', 'dynamic,bounded': '#ff9800', 'unbounded': '#f44336' };
					row.appendChild($t('span', fn.qualifier, `color:${qualColor[fn.qualifier] ?? '#9e9e9e'};font-size:9px;`));
					row.appendChild($t('span', fn.function, 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
					tbl.appendChild(row);
				}
				if (sorted.length > 100) tbl.appendChild($t('div', `... ${sorted.length - 100} more`, 'padding:4px 8px;color:var(--vscode-descriptionForeground);'));
				body.appendChild(tbl);
			};

			if (this._lastStackReport) renderReport(this._lastStackReport);
			else body.appendChild($t('div', 'Click Analyze to scan .su stack-usage files from last build.', 'color:var(--vscode-descriptionForeground);font-size:11px;'));

			analyzeStackBtn.addEventListener('click', async () => {
				if (!s.projectInfo?.projectRoot) { body.textContent = ''; body.appendChild($t('div', 'No project root.', 'color:var(--vscode-errorForeground);')); return; }
				analyzeStackBtn.disabled = true;
				analyzeStackBtn.textContent = '...';
				this._lastStackReport = await this._buildSvc.analyzeStackUsage(s.projectInfo.projectRoot);
				if (this._lastStackReport) renderReport(this._lastStackReport);
				analyzeStackBtn.textContent = 'Analyze';
				analyzeStackBtn.disabled = false;
			});
		};

		// \u2500\u2500 TOOLCHAIN \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const renderToolchain = async (): Promise<void> => {
			const loadingEl = $t('div', 'Checking toolchain...', 'padding:16px;color:var(--vscode-descriptionForeground);font-size:11px;');
			content.appendChild(loadingEl);

			const result = await this._buildSvc.checkToolchain(projectType);
			content.textContent = '';

			const wrap = $e('div', 'flex:1;overflow-y:auto;padding:14px;');
			content.appendChild(wrap);

			const banner = $e('div', `padding:10px 14px;border-radius:4px;margin-bottom:14px;background:${result.available ? 'rgba(76,175,80,0.1)' : 'rgba(244,67,54,0.1)'};border:1px solid ${result.available ? 'rgba(76,175,80,0.3)' : 'rgba(244,67,54,0.3)'};`);
			banner.appendChild($t('div', result.available ? '\u2713 Toolchain Ready' : '\u2717 Toolchain Incomplete', `font-size:12px;font-weight:700;color:${result.available ? '#4caf50' : '#f44336'};`));
			banner.appendChild($t('div', `Project type: ${projectType}`, 'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px;'));
			wrap.appendChild(banner);

			if (result.missing.length > 0) {
				wrap.appendChild($t('div', 'MISSING TOOLS', 'font-size:10px;font-weight:700;letter-spacing:.05em;color:var(--vscode-errorForeground);margin-bottom:8px;'));
				for (const m of result.missing) {
					const card = $e('div', 'padding:10px 12px;border:1px solid var(--vscode-widget-border);border-radius:3px;margin-bottom:6px;');
					card.appendChild($t('div', m.tool, 'font-size:11px;font-weight:600;font-family:var(--vscode-editor-font-family,monospace);'));
					card.appendChild($t('div', m.purpose, 'font-size:10px;color:var(--vscode-descriptionForeground);margin:2px 0;'));
					card.appendChild($t('div', m.installHint, 'font-size:10px;font-family:var(--vscode-editor-font-family,monospace);color:var(--vscode-terminal-ansiCyan,#80cbc4);'));
					wrap.appendChild(card);
				}
			}

			if (result.found.length > 0) {
				wrap.appendChild($t('div', 'INSTALLED', 'font-size:10px;font-weight:700;letter-spacing:.05em;color:var(--vscode-descriptionForeground);margin:12px 0 8px;'));
				for (const f of result.found) {
					const row = $e('div', 'display:flex;align-items:center;gap:10px;padding:4px 0;border-bottom:1px solid var(--vscode-widget-border);');
					row.appendChild($e('div', 'width:7px;height:7px;border-radius:50%;background:#4caf50;flex-shrink:0;'));
					row.appendChild($t('span', f.tool, 'font-size:11px;font-weight:500;font-family:var(--vscode-editor-font-family,monospace);'));
					row.appendChild($t('span', f.version, 'font-size:10px;color:var(--vscode-descriptionForeground);'));
					row.appendChild($t('span', f.path, 'font-size:9px;color:var(--vscode-descriptionForeground);margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;'));
					wrap.appendChild(row);
				}
			}
		};

		// \u2500\u2500 FLASH TOOLS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		const renderFlashTools = async (): Promise<void> => {
			const loadingEl = $t('div', 'Detecting flash tools...', 'padding:16px;color:var(--vscode-descriptionForeground);font-size:11px;');
			content.appendChild(loadingEl);

			const tools = await this._buildSvc.detectFlashTools();
			content.textContent = '';

			const wrap = $e('div', 'flex:1;overflow-y:auto;');
			content.appendChild(wrap);

			if (this._lastFlashResult) {
				const fr = this._lastFlashResult;
				const banner = $e('div', `padding:8px 14px;margin-bottom:1px;background:${fr.success ? 'rgba(76,175,80,0.1)' : 'rgba(244,67,54,0.1)'};border-bottom:1px solid var(--vscode-widget-border);display:flex;align-items:center;gap:10px;`);
				banner.appendChild($t('span', `Last flash: ${fr.success ? '\u2713 OK' : '\u2717 FAILED'}`, `font-size:11px;font-weight:600;color:${fr.success ? '#4caf50' : '#f44336'};`));
				banner.appendChild($t('span', fr.tool, 'font-size:10px;color:var(--vscode-descriptionForeground);'));
				banner.appendChild($t('span', `${fr.durationMs}ms`, 'font-size:10px;color:var(--vscode-descriptionForeground);'));
				if (fr.verified !== undefined) banner.appendChild($t('span', fr.verified ? 'Verified \u2713' : 'Verify FAILED \u2717', `font-size:10px;color:${fr.verified ? '#4caf50' : '#f44336'};`));
				wrap.appendChild(banner);
			}

			const hdr = $e('div', 'padding:6px 14px;background:var(--vscode-sideBarSectionHeader-background);');
			hdr.appendChild($t('span', `FLASH TOOLS  (${tools.length} detected)`, 'font-size:10px;font-weight:700;letter-spacing:.05em;color:var(--vscode-descriptionForeground);'));
			wrap.appendChild(hdr);

			if (tools.length === 0) {
				wrap.appendChild($t('div', 'No flash tools found on PATH. Install openocd, esptool, nrfjprog, or a similar tool.', 'padding:16px;color:var(--vscode-descriptionForeground);font-size:11px;'));
			}
			for (const tool of tools) {
				const row = $e('div', 'display:grid;grid-template-columns:160px 1fr auto;align-items:center;gap:10px;padding:7px 14px;border-bottom:1px solid var(--vscode-widget-border);');
				row.appendChild($t('span', tool.name, 'font-size:11px;font-weight:600;font-family:var(--vscode-editor-font-family,monospace);'));
				row.appendChild($t('span', tool.path, 'font-size:10px;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
				const rightCol = $e('div', 'display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex-shrink:0;');
				if (tool.version) rightCol.appendChild($t('span', tool.version, 'font-size:9px;color:var(--vscode-descriptionForeground);'));
				const ifBadges = $e('div', 'display:flex;gap:3px;');
				for (const iface of tool.supportedInterfaces) {
					ifBadges.appendChild($t('span', iface, 'font-size:8px;font-weight:700;padding:1px 5px;border-radius:3px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);'));
				}
				rightCol.appendChild(ifBadges);
				row.appendChild(rightCol);
				wrap.appendChild(row);
			}
		};

		// \u2500\u2500 BUILD / FLASH BUTTON HANDLERS \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		let buildStartTime = 0;
		let timerInterval: ReturnType<typeof setInterval> | undefined;

		const startTimer = (): void => {
			buildStartTime = Date.now();
			timerInterval = setInterval(() => {
				elapsedLabel.textContent = `${((Date.now() - buildStartTime) / 1000).toFixed(1)}s`;
			}, 100);
		};
		const stopTimer = (): void => {
			if (timerInterval) { clearInterval(timerInterval); timerInterval = undefined; }
			elapsedLabel.textContent = `${((Date.now() - buildStartTime) / 1000).toFixed(1)}s`;
		};

		buildBtn.addEventListener('click', async () => {
			if (!s.projectInfo?.projectRoot) {
				this._notify.notify({ severity: Severity.Warning, message: 'No project detected. Open a firmware workspace and run fw_scan_project.' });
				return;
			}
			buildBtn.disabled = true;
			statusLabel.textContent = 'Building...';
			startTimer();
			this._buildOutputLines.push(`$ ${this._buildSvc.getBuildCommand(projectType, targetInput.value || undefined).join(' ')}`);
			if (this._buildSubTab === 'output') repaintOutput();
			else activateSubTab('output');

			try {
				const result = await this._buildSvc.build(s.projectInfo.projectRoot, projectType, targetInput.value || undefined);
				this._buildOutputLines.push(result.success ? `\u2713 Build complete (${result.durationMs}ms)` : `\u2717 Build failed \u2014 ${result.errors.length} error(s)`);
				repaintOutput();
				if (!result.success) activateSubTab('diagnostics');
			} catch (err: any) {
				this._buildOutputLines.push(`\u2717 ${err.message ?? err}`);
				repaintOutput();
			}
			stopTimer();
			statusLabel.textContent = '';
			buildBtn.disabled = false;
		});

		flashBtn.addEventListener('click', async () => {
			if (!s.projectInfo?.projectRoot) {
				this._notify.notify({ severity: Severity.Warning, message: 'No project detected.' });
				return;
			}
			flashBtn.disabled = true;
			statusLabel.textContent = 'Flashing...';
			startTimer();
			this._buildOutputLines.push(`$ ${this._buildSvc.getFlashCommand(projectType).join(' ')}`);
			if (this._buildSubTab !== 'output') activateSubTab('output');

			try {
				const result = await this._buildSvc.flash(s.projectInfo.projectRoot, projectType);
				this._lastFlashResult = result;
				this._buildOutputLines.push(result.success
					? `\u2713 Flash complete (${result.tool}, ${result.durationMs}ms)${result.verified === true ? ' \u2014 verified' : result.verified === false ? ' \u2014 VERIFY FAILED' : ''}`
					: `\u2717 Flash failed: ${result.message}`);
				repaintOutput();
			} catch (err: any) {
				this._buildOutputLines.push(`\u2717 ${err.message ?? err}`);
				repaintOutput();
			}
			stopTimer();
			statusLabel.textContent = '';
			flashBtn.disabled = false;
		});

		cleanBtn.addEventListener('click', async () => {
			if (!s.projectInfo?.projectRoot) return;
			cleanBtn.disabled = true;
			statusLabel.textContent = 'Cleaning...';
			startTimer();
			const cmds = this._buildSvc.getBuildCommand(projectType);
			this._buildOutputLines.push(`$ clean`);
			if (this._buildSubTab !== 'output') activateSubTab('output');

			try {
				await this._buildSvc.clean(s.projectInfo.projectRoot, projectType);
				this._buildOutputLines.push('\u2713 Clean complete');
				repaintOutput();
			} catch (err: any) {
				this._buildOutputLines.push(`\u2717 ${err.message ?? err}`);
				repaintOutput();
			}
			void cmds;
			stopTimer();
			statusLabel.textContent = '';
			cleanBtn.disabled = false;
		});

		abortBtn.addEventListener('click', () => {
			this._buildSvc.abort();
			statusLabel.textContent = 'Aborted';
			stopTimer();
			buildBtn.disabled = false;
			flashBtn.disabled = false;
			cleanBtn.disabled = false;
		});

		// \u2500\u2500 Live output streaming \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		this._buildSvc.onBuildOutput((line: IBuildOutputLine) => {
			this._buildOutputLines.push(line.text);
			if (this._buildOutputLines.length > 5000) this._buildOutputLines.splice(0, 1000);
			if (this._buildSubTab === 'output') repaintOutput();
		});

		this._buildSvc.onBuildCompleted((_result: IBuildResult) => {
			statusLabel.textContent = '';
			stopTimer();
			buildBtn.disabled = false;
			if (this._buildSubTab === 'diagnostics') renderSubTab('diagnostics');
		});

		this._buildSvc.onFlashCompleted((result: IFlashResult) => {
			this._lastFlashResult = result;
			statusLabel.textContent = '';
			stopTimer();
			flashBtn.disabled = false;
		});

		// \u2500\u2500 Initial render \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
		activateSubTab(this._buildSubTab);
	}


	// ─── Shared Primitives ────────────────────────────────────────────────────

	private _btn(label: string, primary: boolean, onClick: () => void, extraCss: string): HTMLButtonElement {
		const btn = $e('button', [
			'display:inline-flex', 'align-items:center', 'gap:6px',
			'padding:5px 14px', 'border-radius:4px', 'cursor:pointer',
			'font-family:inherit', 'font-size:12px', 'font-weight:600',
			'transition:opacity 0.1s,background 0.1s',
			primary
				? 'background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;'
				: 'background:transparent;color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));',
			extraCss,
		].join(';')) as HTMLButtonElement;
		btn.textContent = label;
		btn.addEventListener('click', onClick);
		btn.addEventListener('mouseenter', () => { btn.style.opacity = '0.85'; });
		btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; });
		return btn;
	}

	private _select(options: string[]): HTMLSelectElement {
		const sel = $e('select', [
			'padding:3px 8px',
			'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
			'border-radius:4px',
			'background:var(--vscode-input-background)',
			'color:var(--vscode-input-foreground)',
			'font-size:11px', 'font-family:inherit',
		].join(';')) as HTMLSelectElement;
		for (const o of options) {
			const opt = $e('option');
			opt.value = o;
			opt.textContent = o;
			sel.appendChild(opt);
		}
		return sel;
	}

	private _emptyState(title: string, desc: string, note?: string): HTMLElement {
		const wrap = $e('div', 'text-align:center;padding:48px 24px;');
		const emptyIcon = $e('div', 'font-size:44px;color:var(--vscode-descriptionForeground);opacity:0.2;margin-bottom:16px;');
		const emptyIconSpan = $e('span');
		emptyIconSpan.classList.add('codicon', 'codicon-circuit-board');
		emptyIcon.appendChild(emptyIconSpan);
		wrap.appendChild(emptyIcon);
		wrap.appendChild($t('div', title, 'font-size:14px;font-weight:700;color:var(--vscode-editor-foreground);margin-bottom:8px;'));
		wrap.appendChild($t('div', desc, 'font-size:12px;color:var(--vscode-descriptionForeground);max-width:380px;margin:0 auto;line-height:1.6;'));
		if (note) {
			wrap.appendChild($t('div', note, 'font-size:11px;color:var(--vscode-descriptionForeground);opacity:0.6;margin-top:12px;'));
		}
		return wrap;
	}

	// ─── RTOS Tab ────────────────────────────────────────────────────────────────

	private _rtosSnapshot: IRTOSSnapshot | undefined;
	private _rtosHeapHistory: number[] = [];    // heap used % rolling 60-sample
	private _rtosLiveTimer: ReturnType<typeof setInterval> | null = null;

	private _renderRTOS(root: HTMLElement): void {
		const panel = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;');
		root.appendChild(panel);

		// ── Top bar ───────────────────────────────────────────────────────────
		const topBar = $e('div', 'display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--vscode-widget-border);flex-shrink:0;background:var(--vscode-sideBarSectionHeader-background);');

		// RTOS type + status dot
		const statusDot = $e('div', 'width:8px;height:8px;border-radius:50%;background:#616161;flex-shrink:0;');
		const rtosTypeLbl = $t('span', 'No RTOS', 'font-size:11px;font-weight:700;font-family:monospace;');
		const tickLbl = $t('span', '', 'font-size:10px;color:var(--vscode-descriptionForeground);margin-left:4px;');
		topBar.appendChild(statusDot); topBar.appendChild(rtosTypeLbl); topBar.appendChild(tickLbl);
		topBar.appendChild($e('div', 'flex:1;'));

		// Live toggle
		const liveDot = $e('div', 'width:6px;height:6px;border-radius:50%;background:#616161;flex-shrink:0;');
		const liveBtn = $e('div', 'display:flex;align-items:center;gap:5px;padding:3px 8px;border-radius:3px;border:1px solid var(--vscode-widget-border);cursor:pointer;font-size:10px;');
		liveBtn.appendChild(liveDot); liveBtn.appendChild($t('span', 'Live', ''));
		let liveOn = false;

		// Interval selector
		const intervalSel = $e('select', 'font-size:10px;padding:2px 4px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,var(--vscode-widget-border));border-radius:3px;') as HTMLSelectElement;
		for (const [label, ms] of [['500ms','500'],['1s','1000'],['2s','2000'],['5s','5000']]) {
			const o = $e('option') as HTMLOptionElement; o.value = ms!; o.textContent = label!;
			if (ms === '1000') o.selected = true;
			intervalSel.appendChild(o);
		}

		const snapshotBtn = $e('div', 'padding:3px 10px;border-radius:3px;border:1px solid var(--vscode-widget-border);cursor:pointer;font-size:10px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);');
		snapshotBtn.textContent = 'Snapshot';
		const detectBtn = $e('div', 'padding:3px 10px;border-radius:3px;border:1px solid var(--vscode-widget-border);cursor:pointer;font-size:10px;');
		detectBtn.textContent = 'Detect';

		topBar.appendChild(liveBtn); topBar.appendChild(intervalSel);
		topBar.appendChild(detectBtn); topBar.appendChild(snapshotBtn);
		panel.appendChild(topBar);

		// ── Two-column layout: left=threads, right=heap+sync+timers ──────────
		const body = $e('div', 'flex:1;display:flex;overflow:hidden;');
		panel.appendChild(body);

		// Left: threads (60% width)
		const leftPane = $e('div', 'flex:0 0 60%;display:flex;flex-direction:column;border-right:1px solid var(--vscode-widget-border);overflow:hidden;');
		body.appendChild(leftPane);

		// Right: stats panels (40% width)
		const rightPane = $e('div', 'flex:1;display:flex;flex-direction:column;overflow-y:auto;');
		body.appendChild(rightPane);

		// ── Left: CPU canvas + thread table ──────────────────────────────────
		const cpuSection = $e('div', 'flex-shrink:0;border-bottom:1px solid var(--vscode-widget-border);');
		const cpuHdr = $e('div', 'padding:5px 10px;display:flex;align-items:center;justify-content:space-between;');
		cpuHdr.appendChild($t('span', 'CPU / THREAD', 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);'));
		cpuSection.appendChild(cpuHdr);
		const cpuCanvas = $e('canvas', 'display:block;width:100%;') as HTMLCanvasElement;
		cpuSection.appendChild(cpuCanvas);
		leftPane.appendChild(cpuSection);

		// Thread table
		const threadWrap = $e('div', 'flex:1;overflow-y:auto;');
		leftPane.appendChild(threadWrap);

		// ── Right: Heap canvas + stat cards + sync + timers ──────────────────
		// Heap canvas
		const heapSection = $e('div', 'border-bottom:1px solid var(--vscode-widget-border);flex-shrink:0;');
		const heapHdr = $e('div', 'padding:5px 10px;display:flex;align-items:center;justify-content:space-between;');
		heapHdr.appendChild($t('span', 'HEAP', 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);'));
		const heapPctLbl = $t('span', '', 'font-size:10px;font-family:monospace;');
		heapHdr.appendChild(heapPctLbl);
		heapSection.appendChild(heapHdr);
		const heapCanvas = $e('canvas', 'display:block;width:100%;') as HTMLCanvasElement;
		heapSection.appendChild(heapCanvas);
		// Heap stat row
		const heapStatRow = $e('div', 'display:grid;grid-template-columns:1fr 1fr 1fr 1fr;padding:6px 10px;gap:4px;');
		heapSection.appendChild(heapStatRow);
		rightPane.appendChild(heapSection);

		// Sync primitives section
		const syncSection = $e('div', 'border-bottom:1px solid var(--vscode-widget-border);flex-shrink:0;');
		const syncHdr = $e('div', 'padding:5px 10px;');
		syncHdr.appendChild($t('span', 'SYNC PRIMITIVES', 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);'));
		syncSection.appendChild(syncHdr);
		const syncBody = $e('div', '');
		syncSection.appendChild(syncBody);
		rightPane.appendChild(syncSection);

		// Timers section
		const timersSection = $e('div', 'flex-shrink:0;');
		const timersHdr = $e('div', 'padding:5px 10px;');
		timersHdr.appendChild($t('span', 'TIMERS', 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);'));
		timersSection.appendChild(timersHdr);
		const timersBody = $e('div', '');
		timersSection.appendChild(timersBody);
		rightPane.appendChild(timersSection);

		// ── Canvas draw helpers ───────────────────────────────────────────────
		const STATE_COLOR: Record<string,string> = {
			running:'#4caf50', ready:'#2196f3', blocked:'#ff9800',
			suspended:'#546e7a', deleted:'#f44336', unknown:'#616161',
		};

		const drawCpuCanvas = (snap: IRTOSSnapshot) => {
			const DPR = window.devicePixelRatio || 1;
			const W = cpuCanvas.parentElement!.clientWidth || 400;
			const H = 56;
			cpuCanvas.width = W*DPR; cpuCanvas.height = H*DPR; cpuCanvas.style.height = H+'px';
			const ctx = cpuCanvas.getContext('2d')!;
			ctx.scale(DPR, DPR);
			ctx.fillStyle = '#0d1117'; ctx.fillRect(0,0,W,H);

			const pad = 8; const barH = 12; const gap = 4;
			const labelW = 70; const barW = W - labelW - pad*2 - 40;

			for (let i = 0; i < Math.min(snap.threads.length, 4); i++) {
				const t = snap.threads[i]!;
				const y = pad + i * (barH + gap);
				const col = STATE_COLOR[t.state] || '#546e7a';
				const pct = t.cpuPercent !== undefined ? t.cpuPercent : 0;

				// Label
				ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.font = '9px system-ui'; ctx.textAlign = 'right';
				const lbl = t.name.length > 9 ? t.name.slice(0,8)+'..' : t.name;
				ctx.fillText(lbl, labelW, y+barH-2);

				// Bar track
				ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(labelW+4, y, barW, barH);
				// Bar fill
				ctx.fillStyle = col; ctx.fillRect(labelW+4, y, barW*pct/100, barH);
				// Pct label
				ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = '8px monospace'; ctx.textAlign = 'left';
				ctx.fillText(`${pct.toFixed(0)}%`, labelW+4+barW+4, y+barH-2);
			}
			if (snap.threads.length > 4) {
				ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.font = '8px system-ui'; ctx.textAlign = 'left';
				ctx.fillText(`+${snap.threads.length-4} more`, labelW+4, pad+4*(barH+gap)+barH-2);
			}
		};

		const HEAP_SAMPLES = 60;
		const drawHeapCanvas = (snap: IRTOSSnapshot) => {
			if (!snap.heap) { heapCanvas.style.display='none'; return; }
			heapCanvas.style.display='block';
			const DPR = window.devicePixelRatio || 1;
			const W = heapCanvas.parentElement!.clientWidth || 400;
			const H = 44;
			heapCanvas.width = W*DPR; heapCanvas.height = H*DPR; heapCanvas.style.height = H+'px';
			const ctx = heapCanvas.getContext('2d')!;
			ctx.scale(DPR, DPR);
			ctx.fillStyle = '#0d1117'; ctx.fillRect(0,0,W,H);

			const pct = snap.heap.totalSize > 0 ? snap.heap.usedSize/snap.heap.totalSize*100 : 0;
			// Push history
			this._rtosHeapHistory.push(pct);
			if (this._rtosHeapHistory.length > HEAP_SAMPLES) this._rtosHeapHistory.shift();

			const pad = 6; const lineW = W - pad*2;
			// Draw history sparkline
			if (this._rtosHeapHistory.length > 1) {
				const step = lineW / (HEAP_SAMPLES-1);
				const startIdx = Math.max(0, HEAP_SAMPLES - this._rtosHeapHistory.length);
				ctx.beginPath();
				for (let i = 0; i < this._rtosHeapHistory.length; i++) {
					const x = pad + (startIdx + i) * step;
					const y = H - pad - (this._rtosHeapHistory[i]!/100) * (H - pad*2);
					if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
				}
				const color = pct > 90 ? '#f48771' : pct > 75 ? '#e0a84e' : '#4caf50';
				ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
				// Fill under
				ctx.lineTo(pad + (startIdx + this._rtosHeapHistory.length-1)*step, H-pad);
				ctx.lineTo(pad + startIdx*step, H-pad); ctx.closePath();
				ctx.fillStyle = color+'22'; ctx.fill();
			}
			// Current pct label
			const col = pct > 90 ? '#f48771' : pct > 75 ? '#e0a84e' : '#4caf50';
			heapPctLbl.textContent = `${pct.toFixed(1)}%`;
			heapPctLbl.style.color = col;

			// Stat cells
			while (heapStatRow.firstChild) heapStatRow.removeChild(heapStatRow.firstChild);
			const mkStat = (lbl:string, val:string, c?:string) => {
				const el=$e('div','text-align:center;');
				el.appendChild($t('div',val,`font-size:11px;font-weight:700;font-family:monospace;${c?'color:'+c:''}`));
				el.appendChild($t('div',lbl,'font-size:8px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.04em;margin-top:1px;'));
				return el;
			};
			const h = snap.heap;
			heapStatRow.appendChild(mkStat('Used', `${(h.usedSize/1024).toFixed(1)}K`, col));
			heapStatRow.appendChild(mkStat('Free', `${(h.freeSize/1024).toFixed(1)}K`));
			heapStatRow.appendChild(mkStat('Min Free', `${(h.minimumEverFree/1024).toFixed(1)}K`));
			heapStatRow.appendChild(mkStat('Largest', `${(h.largestFreeBlock/1024).toFixed(1)}K`));
		};

		// ── Thread table render ───────────────────────────────────────────────
		const renderThreadTable = (snap: IRTOSSnapshot) => {
			while (threadWrap.firstChild) threadWrap.removeChild(threadWrap.firstChild);
			if (!snap.threads.length) {
				threadWrap.appendChild($t('div','No threads — connect debugger and take snapshot','font-size:11px;color:var(--vscode-descriptionForeground);padding:20px;text-align:center;'));
				return;
			}
			const tbl = $e('div','font-size:10px;font-family:monospace;');
			// Header
			const th = $e('div','display:grid;grid-template-columns:28px 1fr 72px 32px 100px 52px;gap:6px;padding:4px 10px;background:var(--vscode-sideBarSectionHeader-background);color:var(--vscode-descriptionForeground);font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;position:sticky;top:0;');
			['ID','Name','State','Pri','Stack','CPU'].forEach(h=>th.appendChild($t('span',h)));
			tbl.appendChild(th);

			for (const t of snap.threads) {
				const stateCol = STATE_COLOR[t.state] || '#616161';
				const stackPct = t.stackSize > 0 ? t.stackUsed/t.stackSize*100 : 0;
				const stackCol = stackPct > 90 ? '#f48771' : stackPct > 70 ? '#e0a84e' : '#4caf50';
				const cpuPct = t.cpuPercent !== undefined ? t.cpuPercent : -1;
				const row = $e('div',`display:grid;grid-template-columns:28px 1fr 72px 32px 100px 52px;gap:6px;padding:4px 10px;border-top:1px solid var(--vscode-widget-border);align-items:center;`);

				// ID
				row.appendChild($t('span',String(t.id),'color:var(--vscode-descriptionForeground);'));
				// Name
				row.appendChild($t('span',t.name,'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
				// State badge
				const stateBadge = $e('div','display:flex;align-items:center;gap:3px;');
				stateBadge.appendChild($e('div',`width:6px;height:6px;border-radius:50%;background:${stateCol};flex-shrink:0;`));
				stateBadge.appendChild($t('span',t.state,'font-size:9px;'));
				row.appendChild(stateBadge);
				// Priority
				row.appendChild($t('span',String(t.priority),'text-align:center;'));
				// Stack bar
				const stackEl = $e('div','display:flex;align-items:center;gap:3px;');
				const sTrack = $e('div','flex:1;height:6px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;');
				sTrack.appendChild($e('div',`height:100%;width:${Math.min(stackPct,100)}%;background:${stackCol};border-radius:2px;transition:width 0.3s;`));
				stackEl.appendChild(sTrack);
				stackEl.appendChild($t('span',`${stackPct.toFixed(0)}%`,`font-size:8px;color:${stackCol};width:22px;`));
				row.appendChild(stackEl);
				// CPU
				row.appendChild($t('span', cpuPct >= 0 ? `${cpuPct.toFixed(1)}%` : '--', `font-size:9px;color:${cpuPct>50?'#f48771':cpuPct>20?'#e0a84e':'var(--vscode-descriptionForeground)'};`));

				tbl.appendChild(row);
			}
			threadWrap.appendChild(tbl);
		};

		// ── Sync primitives render ────────────────────────────────────────────
		const SYNC_COLOR: Record<string,string> = {
			mutex:'#7b1fa2', semaphore:'#1565c0', queue:'#e65100',
			'event-group':'#1b5e20', timer:'#0277bd',
		};
		const renderSync = (snap: IRTOSSnapshot) => {
			while (syncBody.firstChild) syncBody.removeChild(syncBody.firstChild);
			if (!snap.syncPrimitives.length) {
				syncBody.appendChild($t('div','None','font-size:10px;color:var(--vscode-descriptionForeground);padding:4px 10px 8px;'));
				return;
			}
			for (const p of snap.syncPrimitives) {
				const col = SYNC_COLOR[p.type] || '#546e7a';
				const row = $e('div','display:flex;align-items:center;gap:8px;padding:4px 10px;border-top:1px solid var(--vscode-widget-border);');
				const pill = $e('div',`font-size:8px;font-weight:700;padding:1px 5px;border-radius:2px;background:${col}22;color:${col};flex-shrink:0;font-family:monospace;`);
				pill.textContent = p.type.slice(0,3).toUpperCase();
				row.appendChild(pill);
				row.appendChild($t('span',p.name,'font-size:10px;font-family:monospace;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
				row.appendChild($t('span',p.value,'font-size:10px;color:var(--vscode-descriptionForeground);'));
				if (p.waiters.length > 0) {
					const wEl = $e('div','display:flex;align-items:center;gap:3px;flex-shrink:0;');
					wEl.appendChild($e('div','width:6px;height:6px;border-radius:50%;background:#ff9800;'));
					wEl.appendChild($t('span',`${p.waiters.length} waiting`,'font-size:9px;color:#ff9800;'));
					row.appendChild(wEl);
				}
				syncBody.appendChild(row);
			}
		};

		// ── Timers render ─────────────────────────────────────────────────────
		const renderTimers = (snap: IRTOSSnapshot) => {
			while (timersBody.firstChild) timersBody.removeChild(timersBody.firstChild);
			if (!snap.timers.length) {
				timersBody.appendChild($t('div','None','font-size:10px;color:var(--vscode-descriptionForeground);padding:4px 10px 8px;'));
				return;
			}
			for (const tm of snap.timers) {
				const row = $e('div','display:grid;grid-template-columns:1fr 60px 50px 40px;gap:6px;padding:4px 10px;border-top:1px solid var(--vscode-widget-border);align-items:center;font-size:10px;font-family:monospace;');
				row.appendChild($t('span',tm.name,'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
				row.appendChild($t('span',`${tm.periodTicks}t`,'color:var(--vscode-descriptionForeground);'));
				row.appendChild($t('span',tm.isAutoReload?'auto':'one-shot','font-size:9px;color:var(--vscode-descriptionForeground);'));
				const actEl = $e('div','display:flex;align-items:center;gap:3px;');
				actEl.appendChild($e('div',`width:6px;height:6px;border-radius:50%;background:${tm.isActive?'#4caf50':'#546e7a'};`));
				row.appendChild(actEl);
				timersBody.appendChild(row);
			}
		};

		// ── Main render ───────────────────────────────────────────────────────
		const renderSnapshot = (snap: IRTOSSnapshot) => {
			this._rtosSnapshot = snap;
			// Update top bar
			statusDot.style.background = snap.rtosType === 'none' ? '#616161' : '#4caf50';
			rtosTypeLbl.textContent = snap.rtosType === 'none' ? 'No RTOS' : snap.rtosType;
			tickLbl.textContent = snap.tickCount ? `tick: ${snap.tickCount}` : '';
			// Draw canvases
			drawCpuCanvas(snap);
			drawHeapCanvas(snap);
			// Render sections
			renderThreadTable(snap);
			renderSync(snap);
			renderTimers(snap);
		};

		// Empty state
		if (!this._rtosSnapshot) {
			const emptyEl = $t('div','Connect debugger and click Snapshot to read RTOS state','font-size:11px;color:var(--vscode-descriptionForeground);padding:20px;text-align:center;');
			threadWrap.appendChild(emptyEl);
		} else {
			renderSnapshot(this._rtosSnapshot);
		}

		// Resize observers for canvases
		const ro = new ResizeObserver(() => {
			if (this._rtosSnapshot) { drawCpuCanvas(this._rtosSnapshot); drawHeapCanvas(this._rtosSnapshot); }
		});
		ro.observe(cpuCanvas.parentElement!); ro.observe(heapCanvas.parentElement!);

		// ── Event handlers ────────────────────────────────────────────────────
		detectBtn.addEventListener('click', async () => {
			detectBtn.textContent = 'Detecting...';
			const rtos = await this._rtosSvc.detect();
			rtosTypeLbl.textContent = rtos === 'none' ? 'No RTOS' : rtos;
			statusDot.style.background = rtos === 'none' ? '#616161' : '#4caf50';
			detectBtn.textContent = 'Detect';
			if (rtos === 'none') {
				this._notify.notify({ severity: Severity.Warning, message: 'No RTOS detected. Ensure debugger is connected and target is halted.' });
			}
		});

		snapshotBtn.addEventListener('click', async () => {
			snapshotBtn.textContent = 'Reading...';
			try {
				const snap = await this._rtosSvc.snapshot();
				renderSnapshot(snap);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				this._notify.notify({ severity: Severity.Error, message: `RTOS snapshot failed: ${msg}` });
			}
			snapshotBtn.textContent = 'Snapshot';
		});

		// Live polling
		liveBtn.addEventListener('click', () => {
			liveOn = !liveOn;
			liveDot.style.background = liveOn ? '#4caf50' : '#616161';
			if (liveOn) {
				const poll = () => {
					this._rtosSvc.snapshot().then(snap => renderSnapshot(snap)).catch(() => {});
					this._rtosLiveTimer = setTimeout(poll, parseInt(intervalSel.value));
				};
				this._rtosLiveTimer = setTimeout(poll, parseInt(intervalSel.value));
			} else {
				if (this._rtosLiveTimer) { clearTimeout(this._rtosLiveTimer); this._rtosLiveTimer = null; }
			}
		});

		intervalSel.addEventListener('change', () => {
			if (liveOn) {
				if (this._rtosLiveTimer) { clearTimeout(this._rtosLiveTimer); this._rtosLiveTimer = null; }
				liveBtn.click(); liveBtn.click(); // restart with new interval
			}
		});

		// Service-push updates
		this._rtosSvc.onSnapshotUpdated(snap => renderSnapshot(snap));
	}

	// ─── HIL Tests Tab ───────────────────────────────────────────────────────────

	private _renderHIL(root: HTMLElement): void {
		const panel = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;');
		root.appendChild(panel);

		// ── Top bar ───────────────────────────────────────────────────────────
		const topBar = $e('div', 'display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--vscode-widget-border);flex-shrink:0;background:var(--vscode-sideBarSectionHeader-background);');
		topBar.appendChild($t('span', 'HIL Tests', 'font-size:11px;font-weight:700;'));

		// Summary pills (updated after each run)
		const summaryPills = $e('div', 'display:flex;gap:6px;margin-left:8px;');
		topBar.appendChild(summaryPills);
		topBar.appendChild($e('div', 'flex:1;'));

		// Filter
		const filterIn = $e('input', 'padding:3px 7px;font-size:10px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-widget-border));border-radius:3px;outline:none;width:120px;') as HTMLInputElement;
		filterIn.placeholder = 'Filter tests...';
		topBar.appendChild(filterIn);

		const refreshBtn = $e('div', 'padding:3px 8px;border-radius:3px;border:1px solid var(--vscode-widget-border);cursor:pointer;font-size:10px;');
		refreshBtn.textContent = 'Refresh';
		const runAllBtn = $e('div', 'padding:3px 10px;border-radius:3px;cursor:pointer;font-size:10px;font-weight:600;background:var(--vscode-button-background);color:var(--vscode-button-foreground);');
		runAllBtn.textContent = 'Run All';
		topBar.appendChild(refreshBtn); topBar.appendChild(runAllBtn);
		panel.appendChild(topBar);

		// ── Body: left=test list, right=detail pane ───────────────────────────
		const body = $e('div', 'flex:1;display:flex;overflow:hidden;');
		panel.appendChild(body);

		// Left panel
		const leftPane = $e('div', 'width:260px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid var(--vscode-widget-border);overflow:hidden;');
		body.appendChild(leftPane);

		const testListEl = $e('div', 'flex:1;overflow-y:auto;');
		leftPane.appendChild(testListEl);

		// Right panel
		const rightPane = $e('div', 'flex:1;overflow-y:auto;display:flex;flex-direction:column;');
		body.appendChild(rightPane);

		// Progress bar at top of right pane (hidden normally)
		const progressBar = $e('div', 'height:2px;background:var(--vscode-focusBorder);width:0%;transition:width 0.3s;flex-shrink:0;');
		rightPane.appendChild(progressBar);

		const detailArea = $e('div', 'flex:1;overflow-y:auto;padding:12px 14px;');
		rightPane.appendChild(detailArea);

		// State
		let allTests: import('../engine/hil/hilTypes.js').IHILTestSpec[] = [];
		let testResults = new Map<string, IHILTestResult>();
		let runningId: string | null = null;
		let selectedId: string | null = null;

		// ── Test list item renderer ───────────────────────────────────────────
		const renderTestList = () => {
			while (testListEl.firstChild) testListEl.removeChild(testListEl.firstChild);
			const filter = filterIn.value.toLowerCase();
			const visible = filter ? allTests.filter(t => t.name.toLowerCase().includes(filter) || (t.tags||[]).some(g=>g.toLowerCase().includes(filter))) : allTests;

			if (!visible.length) {
				testListEl.appendChild($t('div', allTests.length ? 'No tests match filter' : 'No HIL tests found', 'padding:16px 12px;font-size:11px;color:var(--vscode-descriptionForeground);'));
				if (!allTests.length) testListEl.appendChild($t('div', 'Use fw_hil_define to create tests', 'padding:0 12px;font-size:10px;color:var(--vscode-descriptionForeground);opacity:0.7;'));
				return;
			}

			for (const test of visible) {
				const result = testResults.get(test.id);
				const isRunning = runningId === test.id;
				const isSelected = selectedId === test.id;

				const item = $e('div', `display:flex;flex-direction:column;padding:7px 10px;cursor:pointer;border-bottom:1px solid var(--vscode-widget-border);border-left:3px solid transparent;${isSelected ? 'background:var(--vscode-list-activeSelectionBackground,rgba(255,255,255,0.06));border-left-color:var(--vscode-focusBorder);' : ''}`);

				// Row 1: status indicator + name + run button
				const row1 = $e('div', 'display:flex;align-items:center;gap:6px;');

				// Status indicator
				const ind = $e('div', 'width:8px;height:8px;border-radius:50%;flex-shrink:0;');
				if (isRunning) {
					ind.style.background = '#e0a84e';
					ind.style.boxShadow = '0 0 4px #e0a84e88';
				} else if (!result) {
					ind.style.background = 'rgba(255,255,255,0.15)';
				} else {
					ind.style.background = result.passed ? '#4caf50' : '#f44336';
					if (!result.passed) ind.style.boxShadow = '0 0 4px #f4433688';
				}
				row1.appendChild(ind);

				row1.appendChild($t('span', test.name, 'font-size:11px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));

				if (result) {
					row1.appendChild($t('span', `${(result.durationMs/1000).toFixed(1)}s`, 'font-size:9px;color:var(--vscode-descriptionForeground);flex-shrink:0;'));
				}

				const runOneBtn = $e('div', `padding:2px 7px;border-radius:3px;cursor:pointer;font-size:9px;font-weight:600;flex-shrink:0;border:1px solid var(--vscode-widget-border);${isRunning ? 'opacity:0.5;pointer-events:none;' : ''}`);
				runOneBtn.textContent = isRunning ? '...' : 'Run';
				row1.appendChild(runOneBtn);
				item.appendChild(row1);

				// Row 2: meta tags
				const row2 = $e('div', 'display:flex;gap:5px;margin-top:3px;margin-left:14px;');
				row2.appendChild($t('span', `${test.stimulus.length}S`, 'font-size:8px;padding:1px 4px;border-radius:2px;background:rgba(255,255,255,0.06);color:var(--vscode-descriptionForeground);font-family:monospace;'));
				row2.appendChild($t('span', `${test.expectations.length}C`, 'font-size:8px;padding:1px 4px;border-radius:2px;background:rgba(255,255,255,0.06);color:var(--vscode-descriptionForeground);font-family:monospace;'));
				if (test.tags) {
					for (const tag of test.tags.slice(0,2)) {
						row2.appendChild($t('span', tag, 'font-size:8px;padding:1px 4px;border-radius:2px;background:rgba(33,150,243,0.15);color:#64b5f6;'));
					}
				}
				item.appendChild(row2);

				// Row 3: failure reason (if failed)
				if (result && !result.passed && result.failureReason) {
					const row3 = $t('div', result.failureReason, 'font-size:9px;color:#ef9a9a;margin-top:3px;margin-left:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
					item.appendChild(row3);
				}

				item.addEventListener('click', () => { selectedId = test.id; renderTestList(); if(result) showDetail(result); });
				item.addEventListener('mouseenter', () => { if(!isSelected) item.style.background='var(--vscode-list-hoverBackground)'; });
				item.addEventListener('mouseleave', () => { if(!isSelected) item.style.background=''; });

				runOneBtn.addEventListener('click', async (e) => {
					e.stopPropagation();
					selectedId = test.id;
					runningId = test.id;
					renderTestList();
					progressBar.style.width = '30%';
					try {
						const r = await this._hilSvc.runTest(test);
						testResults.set(test.id, r);
						progressBar.style.width = '100%';
						setTimeout(() => { progressBar.style.width = '0%'; }, 600);
						showDetail(r);
					} catch (err: unknown) {
						const msg = err instanceof Error ? err.message : String(err);
						this._notify.notify({ severity: Severity.Error, message: `HIL test failed: ${msg}` });
					}
					runningId = null;
					renderTestList();
					updateSummary();
				});

				testListEl.appendChild(item);
			}
		};

		// ── Detail pane ───────────────────────────────────────────────────────
		const showDetail = (result: IHILTestResult) => {
			while (detailArea.firstChild) detailArea.removeChild(detailArea.firstChild);

			// Header
			const ok = result.passed;
			const hdrEl = $e('div', `padding:10px 12px;border-radius:5px;margin-bottom:10px;background:${ok?'rgba(76,175,80,0.08)':'rgba(244,67,54,0.08)'};border:1px solid ${ok?'rgba(76,175,80,0.25)':'rgba(244,67,54,0.25)'};`);
			const hRow = $e('div', 'display:flex;align-items:center;gap:8px;');
			const hDot = $e('div', `width:10px;height:10px;border-radius:50%;background:${ok?'#4caf50':'#f44336'};flex-shrink:0;`);
			hRow.appendChild(hDot);
			hRow.appendChild($t('span', result.testName, 'font-size:12px;font-weight:700;'));
			hRow.appendChild($t('span', ok?'PASS':'FAIL', `font-size:10px;font-weight:700;color:${ok?'#4caf50':'#f44336'};padding:1px 6px;border-radius:3px;border:1px solid ${ok?'rgba(76,175,80,0.4)':'rgba(244,67,54,0.4)'};margin-left:auto;`));
			hdrEl.appendChild(hRow);
			// Phase pipeline
			if (result.buildResult || result.flashResult) {
				const phases = $e('div', 'display:flex;gap:0;margin-top:8px;border:1px solid var(--vscode-widget-border);border-radius:4px;overflow:hidden;');
				const mkPhase = (label:string, sub:string, pass:boolean) => {
					const p = $e('div', `flex:1;padding:5px 8px;background:${pass?'rgba(76,175,80,0.06)':'rgba(244,67,54,0.06)'};border-right:1px solid var(--vscode-widget-border);`);
					p.appendChild($t('div', label, `font-size:10px;font-weight:700;color:${pass?'#81c784':'#ef9a9a'};`));
					p.appendChild($t('div', sub, 'font-size:9px;color:var(--vscode-descriptionForeground);'));
					return p;
				};
				if (result.buildResult) phases.appendChild(mkPhase('BUILD', `${result.buildResult.durationMs}ms`, result.buildResult.success));
				if (result.flashResult) phases.appendChild(mkPhase('FLASH', `${result.flashResult.durationMs}ms`, result.flashResult.success));
				phases.appendChild(mkPhase('TEST', `${(result.durationMs/1000).toFixed(1)}s`, ok));
				(phases.lastElementChild as HTMLElement).style.borderRight = 'none';
				hdrEl.appendChild(phases);
			}
			detailArea.appendChild(hdrEl);

			// Expectations — numbered steps with pass/fail
			if (result.expectationResults.length) {
				detailArea.appendChild($t('div', 'CHECKS', 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);margin-bottom:6px;'));
				for (let i = 0; i < result.expectationResults.length; i++) {
					const exp = result.expectationResults[i]!;
					const eRow = $e('div', `display:flex;gap:8px;padding:6px 8px;border-radius:4px;margin-bottom:4px;background:${exp.passed?'rgba(76,175,80,0.04)':'rgba(244,67,54,0.06)'};border:1px solid ${exp.passed?'rgba(76,175,80,0.12)':'rgba(244,67,54,0.2)'};`);
					// Step number circle
					const numEl = $e('div', `width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;flex-shrink:0;background:${exp.passed?'rgba(76,175,80,0.15)':'rgba(244,67,54,0.15)'};color:${exp.passed?'#81c784':'#ef9a9a'};`);
					numEl.textContent = String(i+1);
					eRow.appendChild(numEl);
					const eBody = $e('div', 'flex:1;');
					eBody.appendChild($t('div', exp.description, 'font-size:10px;font-weight:600;'));
					if (!exp.passed) {
						if (exp.actual !== undefined && exp.expected !== undefined) {
							const diffRow = $e('div', 'display:flex;gap:8px;margin-top:4px;font-size:9px;font-family:monospace;');
							diffRow.appendChild($t('span', `Expected: ${exp.expected}`, 'color:#81c784;'));
							diffRow.appendChild($t('span', `Got: ${exp.actual}`, 'color:#ef9a9a;'));
							eBody.appendChild(diffRow);
						}
						if (exp.message) eBody.appendChild($t('div', exp.message, 'font-size:9px;color:#ef9a9a;margin-top:2px;'));
					}
					eRow.appendChild(eBody);
					detailArea.appendChild(eRow);
				}
			}

			// Serial capture
			if (result.serialCapture) {
				detailArea.appendChild($t('div', 'SERIAL OUTPUT', 'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);margin:10px 0 5px;'));
				const pre = $e('pre', 'padding:8px;background:#0d1117;color:rgba(255,255,255,0.75);border-radius:4px;font-size:10px;font-family:monospace;overflow-x:auto;max-height:180px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;margin:0;border:1px solid var(--vscode-widget-border);');
				pre.textContent = result.serialCapture;
				detailArea.appendChild(pre);
			}
		};

		const showSuiteResult = (suite: IHILSuiteResult) => {
			while (detailArea.firstChild) detailArea.removeChild(detailArea.firstChild);
			const ok = suite.passedTests === suite.totalTests;

			// Suite summary header
			const sumEl = $e('div', `padding:10px 12px;border-radius:5px;margin-bottom:12px;background:${ok?'rgba(76,175,80,0.08)':'rgba(244,67,54,0.08)'};border:1px solid ${ok?'rgba(76,175,80,0.25)':'rgba(244,67,54,0.25)'};`);
			const sr = $e('div', 'display:flex;align-items:center;gap:8px;');
			sr.appendChild($t('span', suite.suiteName, 'font-size:12px;font-weight:700;'));
			sr.appendChild($t('span', `${suite.passedTests}/${suite.totalTests} passed`, `font-size:10px;font-weight:700;color:${ok?'#4caf50':'#f44336'};margin-left:auto;`));
			sumEl.appendChild(sr);
			sumEl.appendChild($t('div', `${((suite.endTime-suite.startTime)/1000).toFixed(1)}s total`, 'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:3px;'));
			// Progress bar
			const barOuter = $e('div', 'height:6px;background:rgba(255,255,255,0.06);border-radius:3px;overflow:hidden;margin-top:8px;');
			barOuter.appendChild($e('div', `height:100%;width:${suite.totalTests?suite.passedTests/suite.totalTests*100:0}%;background:${ok?'#4caf50':'#f44336'};border-radius:3px;`));
			sumEl.appendChild(barOuter);
			detailArea.appendChild(sumEl);

			// Result rows
			for (const r of suite.results) {
				const rRow = $e('div', `display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;margin-bottom:3px;background:${r.passed?'rgba(76,175,80,0.04)':'rgba(244,67,54,0.06)'};border:1px solid ${r.passed?'rgba(76,175,80,0.10)':'rgba(244,67,54,0.18)'};cursor:pointer;`);
				rRow.appendChild($e('div', `width:8px;height:8px;border-radius:50%;background:${r.passed?'#4caf50':'#f44336'};flex-shrink:0;`));
				rRow.appendChild($t('span', r.testName, 'font-size:11px;font-weight:600;flex:1;'));
				rRow.appendChild($t('span', `${r.expectationResults.filter(e=>e.passed).length}/${r.expectationResults.length} checks`, 'font-size:9px;color:var(--vscode-descriptionForeground);'));
				rRow.appendChild($t('span', `${(r.durationMs/1000).toFixed(1)}s`, 'font-size:9px;color:var(--vscode-descriptionForeground);'));
				rRow.addEventListener('click', () => { selectedId = r.testId; renderTestList(); showDetail(r); });
				detailArea.appendChild(rRow);
			}
		};

		// ── Summary pills ─────────────────────────────────────────────────────
		const updateSummary = () => {
			while (summaryPills.firstChild) summaryPills.removeChild(summaryPills.firstChild);
			if (!testResults.size) return;
			const passed = [...testResults.values()].filter(r=>r.passed).length;
			const failed = testResults.size - passed;
			if (passed) summaryPills.appendChild($t('span', `${passed} pass`, 'font-size:9px;padding:1px 6px;border-radius:3px;background:rgba(76,175,80,0.15);color:#81c784;'));
			if (failed) summaryPills.appendChild($t('span', `${failed} fail`, 'font-size:9px;padding:1px 6px;border-radius:3px;background:rgba(244,67,54,0.15);color:#ef9a9a;'));
		};

		// ── Load tests ────────────────────────────────────────────────────────
		const loadTests = async () => {
			const tests = await this._hilSvc.loadTests();
			allTests = tests;
			renderTestList();
		};

		// ── Event handlers ────────────────────────────────────────────────────
		filterIn.addEventListener('input', () => renderTestList());

		refreshBtn.addEventListener('click', () => { void loadTests(); });

		runAllBtn.addEventListener('click', async () => {
			runAllBtn.textContent = 'Running...';
			(runAllBtn as HTMLElement & {disabled?:boolean}).disabled = true;
			progressBar.style.width = '10%';
			try {
				const suite = await this._hilSvc.runSuite();
				suite.results.forEach(r => testResults.set(r.testId, r));
				progressBar.style.width = '100%';
				setTimeout(() => { progressBar.style.width = '0%'; }, 600);
				showSuiteResult(suite);
				updateSummary();
				renderTestList();
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				this._notify.notify({ severity: Severity.Error, message: `HIL suite failed: ${msg}` });
				progressBar.style.width = '0%';
			}
			runAllBtn.textContent = 'Run All';
			(runAllBtn as HTMLElement & {disabled?:boolean}).disabled = false;
		});

		this._hilSvc.onTestCompleted(result => {
			testResults.set(result.testId, result);
			renderTestList();
			updateSummary();
			if (selectedId === result.testId) showDetail(result);
		});

		void loadTests();
	}

	// ─── Closed-Loop (Auto Loop) Tab ─────────────────────────────────────────────

	private _loopIterations: IClosedLoopIteration[] = [];
	protected _loopCanvas: HTMLCanvasElement | null = null;

	private _renderClosedLoop(root: HTMLElement): void {
		const panel = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;background:var(--vscode-editor-background);');
		root.appendChild(panel);

		const PHASE_COLOR: Record<string,string> = {
			build:'#1565c0', flash:'#7b1fa2', observe:'#00838f',
			diagnose:'#e65100', fix:'#ad1457', complete:'#2e7d32', failed:'#b71c1c',
		};
		const PHASES: ClosedLoopPhase[] = ['build','flash','observe','diagnose','fix'];

		// ── Compact top bar ──────────────────────────────────────────────────
		const topBar = $e('div', 'display:flex;align-items:center;gap:8px;padding:6px 14px;border-bottom:1px solid var(--vscode-widget-border);flex-shrink:0;');
		const statusDot = $e('div', 'width:8px;height:8px;border-radius:50%;background:#616161;flex-shrink:0;transition:background 0.3s;');
		const statusLbl = $t('span', 'IDLE', 'font-size:10px;font-weight:700;color:var(--vscode-descriptionForeground);min-width:80px;font-family:monospace;');
		topBar.appendChild(statusDot); topBar.appendChild(statusLbl);
		topBar.appendChild($e('div','flex:1;'));
		// iter counter
		const iterCounter = $t('span', '', 'font-size:10px;color:var(--vscode-descriptionForeground);font-family:monospace;');
		topBar.appendChild(iterCounter);
		panel.appendChild(topBar);

		// Progress bar
		const progressBar = $e('div', 'height:2px;background:var(--vscode-focusBorder);width:0%;transition:width 0.5s;flex-shrink:0;');
		panel.appendChild(progressBar);

		// ── Goal + pass in single inline row ─────────────────────────────────
		const configBar = $e('div', 'display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--vscode-widget-border);flex-shrink:0;flex-wrap:wrap;');

		const mkInput = (ph:string, w:string) => {
			const el = $e('input', `padding:5px 9px;font-size:11px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-widget-border));border-radius:3px;outline:none;width:${w};`) as HTMLInputElement;
			el.placeholder = ph;
			return el;
		};
		const goalInput   = mkInput('Goal — e.g. Blink LED on PA5 at 1 Hz', '280px');
		const criteriaInput = mkInput('Pass — serial contains e.g. BLINK OK', '220px');
		const maxIterInput  = mkInput('Max', '42px'); maxIterInput.value='10'; maxIterInput.title='Max iterations';
		const channelSel = $e('select','padding:4px 6px;font-size:10px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border,var(--vscode-widget-border));border-radius:3px;') as HTMLSelectElement;
		for(const ch of ['serial','rtt','itm']){const o=$e('option') as HTMLOptionElement;o.value=ch;o.textContent=ch.toUpperCase();channelSel.appendChild(o);}

		const abortBtn = $e('div','padding:4px 10px;border-radius:3px;cursor:pointer;font-size:10px;border:1px solid rgba(244,67,54,0.35);color:#ef9a9a;display:none;flex-shrink:0;');
		abortBtn.textContent='Abort';
		const startBtn = $e('div','padding:4px 14px;border-radius:3px;cursor:pointer;font-size:10px;font-weight:600;background:var(--vscode-button-background);color:var(--vscode-button-foreground);flex-shrink:0;');
		startBtn.textContent='Start Loop';

		configBar.appendChild($t('span','Goal','font-size:9px;font-weight:700;color:var(--vscode-descriptionForeground);flex-shrink:0;'));
		configBar.appendChild(goalInput);
		configBar.appendChild($t('span','Pass','font-size:9px;font-weight:700;color:var(--vscode-descriptionForeground);flex-shrink:0;'));
		configBar.appendChild(criteriaInput);
		configBar.appendChild(maxIterInput);
		configBar.appendChild(channelSel);
		configBar.appendChild(abortBtn);
		configBar.appendChild(startBtn);
		panel.appendChild(configBar);

		// ── Canvas pipeline diagram (hero area) ──────────────────────────────
		const canvasWrap = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;background:#0d1117;');
		const canvas = $e('canvas', 'display:block;width:100%;height:100%;') as HTMLCanvasElement;
		this._loopCanvas = canvas;
		canvasWrap.appendChild(canvas);
		panel.appendChild(canvasWrap);


		// ── Canvas draw ───────────────────────────────────────────────────────
		const drawPipeline = () => {
			const DPR = window.devicePixelRatio || 1;
			const W = canvas.parentElement!.clientWidth || 800;
			const H = Math.max(200, canvas.parentElement!.clientHeight || 400);
			canvas.width = W*DPR; canvas.height = H*DPR;
			const ctx = canvas.getContext('2d')!;
			ctx.scale(DPR, DPR);
			ctx.fillStyle = '#0d1117'; ctx.fillRect(0,0,W,H);

			const iters = this._loopIterations;
			const maxIter = parseInt(maxIterInput.value) || 10;
			const pad = 16;
			const hdrH = 28;          // phase header row height
			const iterRowH = 52;      // height per iteration row

			// Phase column geometry
			const numCols = PHASES.length;
			const colW = (W - pad*2) / numCols;

			// ── Phase header row ──────────────────────────────────────────────
			for(let i=0; i<numCols; i++){
				const ph = PHASES[i]!;
				const col = PHASE_COLOR[ph] || '#546e7a';
				const cx = pad + i*colW;
				const cw = colW;

				// Column background tint
				ctx.fillStyle = col+'0a'; ctx.fillRect(cx, 0, cw, H);

				// Header label
				ctx.fillStyle = col+'cc'; ctx.font='bold 10px monospace'; ctx.textAlign='center';
				ctx.fillText(ph.toUpperCase(), cx+cw/2, 18);

				// Separator
				if(i>0){
					ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.lineWidth=1;
					ctx.beginPath(); ctx.moveTo(cx,0); ctx.lineTo(cx,H); ctx.stroke();
				}
			}

			// Header separator line
			ctx.strokeStyle='rgba(255,255,255,0.08)'; ctx.lineWidth=1;
			ctx.beginPath(); ctx.moveTo(pad,hdrH); ctx.lineTo(W-pad,hdrH); ctx.stroke();

			// ── Empty state ───────────────────────────────────────────────────
			if(!iters.length){
				ctx.fillStyle='rgba(255,255,255,0.18)'; ctx.font='13px system-ui'; ctx.textAlign='center';
				ctx.fillText('Enter goal above and click Start Loop', W/2, H/2-8);
				ctx.fillStyle='rgba(255,255,255,0.08)'; ctx.font='10px system-ui';
				ctx.fillText('Build  Flash  Observe  Diagnose  Fix — repeats until pass criteria met', W/2, H/2+14);
				return;
			}

			// ── Iteration rows ────────────────────────────────────────────────
			const visibleRows = Math.floor((H - hdrH - 20) / iterRowH);
			const visIters = iters.slice(-visibleRows);

			for(let ri=0; ri<visIters.length; ri++){
				const iter = visIters[ri]!;
				const rowY = hdrH + ri*iterRowH;
				const isLatest = ri === visIters.length-1;
				const allPassed = iter.passCriteriaMet.every(Boolean);
				const resultOk = iter.phase==='complete' && allPassed;
				const resultFail = iter.phase==='failed';

				// Row background — latest iteration highlighted
				if(isLatest){
					ctx.fillStyle='rgba(255,255,255,0.025)'; ctx.fillRect(pad, rowY, W-pad*2, iterRowH);
				}
				// Row bottom border
				ctx.strokeStyle='rgba(255,255,255,0.05)'; ctx.lineWidth=0.5;
				ctx.beginPath(); ctx.moveTo(pad,rowY+iterRowH); ctx.lineTo(W-pad,rowY+iterRowH); ctx.stroke();

				// Iter number (left margin)
				const numX = 8;
				ctx.fillStyle = isLatest?'rgba(255,255,255,0.55)':'rgba(255,255,255,0.20)';
				ctx.font = (isLatest?'bold ':'')+'10px monospace'; ctx.textAlign='center';
				ctx.fillText('#'+iter.index, numX, rowY+iterRowH/2+4);

				// Phase state in each column
				const phaseIdx = PHASES.indexOf(iter.phase);
				for(let pi=0; pi<PHASES.length; pi++){
					const ph = PHASES[pi]!;
					const col = PHASE_COLOR[ph] || '#546e7a';
					const cx = pad + pi*colW + colW/2;
					const cy = rowY + iterRowH*0.35;
					const done = pi < phaseIdx || iter.phase==='complete';
					const active = pi===phaseIdx && iter.phase!=='complete' && iter.phase!=='failed';
					const failed2 = resultFail && pi===phaseIdx;

					const r = isLatest ? 7 : 5;
					ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2);
					ctx.fillStyle = done ? col : active ? col : failed2 ? '#f44336' : 'rgba(255,255,255,0.06)';
					ctx.fill();
					if(active){
						ctx.strokeStyle=col; ctx.lineWidth=1.5;
						// Pulse ring
						ctx.beginPath(); ctx.arc(cx, cy, r+3, 0, Math.PI*2);
						ctx.strokeStyle=col+'44'; ctx.stroke();
					}
					// Connector line to next done phase
					if(pi>0 && done){
						const prevCol = PHASE_COLOR[PHASES[pi-1]!] || '#546e7a';
						const prevCX = pad+(pi-1)*colW+colW/2;
						ctx.strokeStyle=prevCol+'55'; ctx.lineWidth=1.5; ctx.setLineDash([]);
						ctx.beginPath(); ctx.moveTo(prevCX+r+2,cy); ctx.lineTo(cx-r-2,cy); ctx.stroke();
					}

					// Text label under dot for latest row
					if(isLatest && (done||active)){
						let subtext = '';
						if(ph==='build' && iter.buildResult) subtext = iter.buildResult.success?'ok':`${iter.buildResult.errorCount}err`;
						if(ph==='flash' && iter.flashResult) subtext = iter.flashResult.success?'ok':'fail';
						if(ph==='observe' && iter.observation) subtext = iter.observation.data.trim().split('\n').pop()?.slice(0,12) || '';
						if(ph==='diagnose' && iter.diagnosis) subtext = iter.diagnosis.slice(0,16);
						if(ph==='fix' && iter.fix) subtext = iter.fix.file.split('/').pop()?.slice(0,12) || '';
						if(subtext){
							ctx.fillStyle = col+'bb'; ctx.font='8px monospace'; ctx.textAlign='center';
							ctx.fillText(subtext, cx, rowY+iterRowH*0.72);
						}
					}
				}

				// Result dot + duration (right side)
				if(resultOk || resultFail){
					const rx = W-pad-6;
					ctx.beginPath(); ctx.arc(rx, rowY+iterRowH*0.35, 5, 0, Math.PI*2);
					ctx.fillStyle = resultOk?'#4caf50':'#f44336'; ctx.fill();
				}
				if(iter.endTime){
					ctx.fillStyle='rgba(255,255,255,0.25)'; ctx.font='8px monospace'; ctx.textAlign='right';
					ctx.fillText(`${((iter.endTime-iter.startTime)/1000).toFixed(1)}s`, W-pad, rowY+iterRowH*0.65);
				}
			}

			// ── Stats footer ──────────────────────────────────────────────────
			const passed = iters.filter(i=>i.phase==='complete'&&i.passCriteriaMet.every(Boolean)).length;
			const failed = iters.filter(i=>i.phase==='failed').length;
			const bY = H - 10;
			ctx.fillStyle='rgba(255,255,255,0.12)'; ctx.font='8px system-ui'; ctx.textAlign='left';
			ctx.fillText(`${iters.length}/${maxIter} iters`, pad, bY);
			if(passed>0){ctx.fillStyle='#4caf50'; ctx.fillText(`${passed} pass`, pad+70, bY);}
			if(failed>0){ctx.fillStyle='#f44336'; ctx.fillText(`${failed} fail`, pad+110, bY);}
		};

		// renderLog is now integrated into drawPipeline canvas
		const renderLog = () => {
			// all rendering on canvas
		};

		// ── Status helpers ────────────────────────────────────────────────────
		const setStatus = (label:string, col:string, dotBg:string) => {
			statusLbl.textContent=label; statusLbl.style.color=col;
			statusDot.style.background=dotBg;
			statusDot.style.boxShadow=(dotBg==='#616161')?'none':`0 0 5px ${dotBg}88`;
		};

		// Resize
		const ro = new ResizeObserver(()=>drawPipeline());
		ro.observe(canvasWrap);
		drawPipeline();

		// ── Events ────────────────────────────────────────────────────────────
		startBtn.addEventListener('click', async () => {
			const goal=goalInput.value.trim();
			if(!goal){this._notify.notify({severity:Severity.Warning,message:'Enter a goal.'});return;}
			const crit=criteriaInput.value.trim();
			const passCriteria=crit
				?[{type:'serial-contains' as const,value:crit,description:crit}]
				:[{type:'no-build-errors' as const,value:'',description:'Build succeeds'}];

			this._loopIterations=[];
			startBtn.style.opacity='0.5'; startBtn.style.pointerEvents='none';
			abortBtn.style.display='';
			setStatus('RUNNING','#4caf50','#4caf50');
			progressBar.style.width='4%';
			drawPipeline(); renderLog();

			try{
				const result=await this._closedLoopSvc.start({
					goal, passCriteria,
					maxIterations:parseInt(maxIterInput.value)||10,
					timeoutMs:300_000,
					observeChannels:[channelSel.value as 'serial'|'rtt'|'itm'],
					autoFix:true,
				});
				progressBar.style.width='100%';
				setTimeout(()=>{progressBar.style.width='0%';},700);
				setStatus(result.success?'PASSED':'FAILED',result.success?'#4caf50':'#f44336',result.success?'#4caf50':'#f44336');
			}catch(err:unknown){
				const msg=err instanceof Error?err.message:String(err);
				this._notify.notify({severity:Severity.Error,message:`Loop error: ${msg}`});
				setStatus('ERROR','#ef9a9a','#f44336');
				progressBar.style.width='0%';
			}
			startBtn.style.opacity=''; startBtn.style.pointerEvents='';
			abortBtn.style.display='none';
		});

		abortBtn.addEventListener('click',()=>{
			this._closedLoopSvc.abort();
			setStatus('ABORTED','#e0a84e','#ff9800');
			progressBar.style.width='0%';
			startBtn.style.opacity=''; startBtn.style.pointerEvents='';
			abortBtn.style.display='none';
		});

		this._closedLoopSvc.onIterationCompleted(iter=>{
			this._loopIterations.push(iter);
			const maxIter=parseInt(maxIterInput.value)||10;
			iterCounter.textContent=`${iter.index}/${maxIter}`;
			progressBar.style.width=`${Math.min(95,iter.index/maxIter*100)}%`;
			drawPipeline(); renderLog();
		});

		this._closedLoopSvc.onPhaseChanged(({iteration,phase})=>{
			const col=PHASE_COLOR[phase]||'#4caf50';
			setStatus(`#${iteration} ${phase.toUpperCase()}`,col,col);
		});
	}

}


// ─── Module-level helpers ─────────────────────────────────────────────────────

// ── Pinout helpers ────────────────────────────────────────────────────────────

/** Derive total pin count from variant name (STM32 suffix letter) or gpioCount fallback. */
function _pinCountFromVariant(variant: string, gpioCount?: number): number {
	const v = variant.toUpperCase();
	// STM32 package suffix: C=48, G=28, F=20, R=64, V=100, Z=144, A=169, B=208
	const stmPkg = v.match(/STM32\w+([CFGRVZAB])(?:\d+)?(?:T|H|U|Y|I)?(?:\d+)?$/)?.[1];
	if (stmPkg) {
		const map: Record<string, number> = { F: 20, G: 28, C: 48, R: 64, V: 100, Z: 144, A: 169, B: 208 };
		if (map[stmPkg]) { return map[stmPkg]; }
	}
	// nRF52840 QFN73
	if (v.includes('NRF52840')) { return 72; }
	if (v.includes('NRF52832')) { return 48; }
	// RP2040 QFN56
	if (v.includes('RP2040')) { return 56; }
	if (v.includes('RP2350')) { return 80; }
	// ESP32
	if (v.includes('ESP32')) { return 48; }
	// Fallback: 2× GPIO count capped at sensible range
	if (gpioCount && gpioCount > 0) { return Math.min(Math.max(gpioCount + 16, 32), 176); }
	return 64;
}

/** Color palette per peripheral type group. */
const PERIPH_TYPE_COLORS: Array<[RegExp, string]> = [
	[/^USART|^UART|^LPUART/,        'var(--vscode-terminal-ansiCyan)'],
	[/^SPI|^I2S|^QSPI|^OSPI/,       'var(--vscode-terminal-ansiMagenta)'],
	[/^I2C|^SMBUS/,                  'var(--vscode-terminal-ansiBlue)'],
	[/^TIM|^HRTIM|^LPTIM/,          'var(--vscode-terminal-ansiYellow)'],
	[/^ADC|^DAC|^COMP|^OPAMP/,      '#e0a84e'],
	[/^DMA|^BDMA|^MDMA/,            '#c586c0'],
	[/^USB|^OTG|^ETH|^CAN|^FDCAN/,  '#4ec9b0'],
	[/^GPIO/,                        'var(--vscode-terminal-ansiGreen)'],
	[/^RCC|^PWR|^FLASH/,            '#888888'],
	[/^NVIC|^SCB|^ITM|^DWT|^SCS/,  '#555555'],
];

function _peripheralColor(groupName: string): string {
	const upper = (groupName || '').toUpperCase();
	for (const [pat, color] of PERIPH_TYPE_COLORS) {
		if (pat.test(upper)) { return color; }
	}
	return 'var(--vscode-terminal-ansiBrightBlack)';
}

/** Map any peripheral name/groupName to a human-readable category for sidebar grouping. */
function _peripheralCategory(name: string): string {
	const u = (name || '').toUpperCase();
	if (/^USART|^UART|^LPUART/.test(u)) { return 'USART / UART'; }
	if (/^SPI|^QSPI|^OCTOSPI|^OSPI/.test(u)) { return 'SPI / QSPI'; }
	if (/^I2S|^SAI/.test(u)) { return 'I2S / SAI'; }
	if (/^I2C|^SMBUS/.test(u)) { return 'I2C'; }
	if (/^HRTIM|^LPTIM|^TIM/.test(u)) { return 'Timers'; }
	if (/^ADC/.test(u)) { return 'ADC'; }
	if (/^DAC|^COMP|^OPAMP/.test(u)) { return 'DAC / Analog'; }
	if (/^DMA|^BDMA|^MDMA/.test(u)) { return 'DMA'; }
	if (/^USB|^OTG/.test(u)) { return 'USB'; }
	if (/^ETH/.test(u)) { return 'Ethernet'; }
	if (/^FDCAN|^CAN/.test(u)) { return 'CAN / FDCAN'; }
	if (/^GPIO/.test(u)) { return 'GPIO'; }
	if (/^EXTI/.test(u)) { return 'EXTI'; }
	if (/^RCC/.test(u)) { return 'RCC (Clocks)'; }
	if (/^PWR/.test(u)) { return 'Power'; }
	if (/^FLASH/.test(u)) { return 'Flash'; }
	if (/^IWDG|^WWDG/.test(u)) { return 'Watchdog'; }
	if (/^RTC/.test(u)) { return 'RTC'; }
	if (/^CRC/.test(u)) { return 'CRC'; }
	if (/^SDIO|^SDMMC/.test(u)) { return 'SDIO / SDMMC'; }
	if (/^NVIC|^SCB|^ITM|^DWT|^SCS|^STK/.test(u)) { return 'Cortex-M Core'; }
	if (/^SYSCFG|^AFIO|^DBGMCU/.test(u)) { return 'System Config'; }
	if (/^FMC|^FSMC/.test(u)) { return 'FMC / FSMC'; }
	if (/^DCMI/.test(u)) { return 'Camera (DCMI)'; }
	if (/^CRYP|^HASH|^RNG/.test(u)) { return 'Crypto / RNG'; }
	return 'Other';
}

/** Group register maps by semantic type category (not raw groupName). */
function _groupByPeripheralType(maps: IPeripheralRegisterMap[]): Map<string, { maps: IPeripheralRegisterMap[]; color: string }> {
	const groups = new Map<string, { maps: IPeripheralRegisterMap[]; color: string }>();
	for (const map of maps) {
		// Use category derived from the peripheral name — this ensures TIM1/TIM2/TIM17
		// all land under "Timers" rather than individual per-SVD groupName values.
		const key = _peripheralCategory(map.name);
		if (!groups.has(key)) {
			groups.set(key, { maps: [], color: _peripheralColor(map.name) });
		}
		groups.get(key)!.maps.push(map);
	}
	return groups;
}

/** Fixed power pin slots — corners and regular VDD/GND intervals. */
function _powerSlots(totalPins: number): Set<number> {
	const slots = new Set<number>();
	const interval = Math.floor(totalPins / 8);
	for (let i = 0; i < totalPins; i += interval) { slots.add(i); }
	slots.add(0);
	slots.add(totalPins - 1);
	return slots;
}

/** Spread peripheral maps evenly around the chip slots, skipping power slots. */
function _assignPeripheralSlots(
	typeGroups: Map<string, { maps: IPeripheralRegisterMap[]; color: string }>,
	totalPins: number,
	powerSlots: Set<number>,
): Map<number, { name: string; color: string }> {
	const assignments = new Map<number, { name: string; color: string }>();
	const available: number[] = [];
	for (let i = 0; i < totalPins; i++) {
		if (!powerSlots.has(i)) { available.push(i); }
	}

	let slotIdx = 0;
	for (const [, { maps, color }] of typeGroups) {
		for (const map of maps) {
			// Spread each peripheral across 2–4 adjacent slots (simulating multiple pins per peripheral)
			const pinCount = Math.min(Math.max(2, Math.floor(map.registers.length / 4)), 6);
			for (let p = 0; p < pinCount && slotIdx < available.length; p++, slotIdx++) {
				assignments.set(available[slotIdx], { name: map.name, color });
			}
		}
	}
	return assignments;
}

/** Detect real conflicts: same peripheral NAME loaded from two different SVD/datasheet sources. */
function _detectPinConflicts(maps: IPeripheralRegisterMap[]): string[] {
	const conflicts: string[] = [];

	// Conflict type 1: same peripheral name, different SVD sources
	const nameSources = new Map<string, Set<string>>();
	for (const map of maps) {
		const key = map.name.toUpperCase();
		if (!nameSources.has(key)) { nameSources.set(key, new Set()); }
		if (map.source) { nameSources.get(key)!.add(map.source); }
	}
	for (const [name, sources] of nameSources) {
		if (sources.size > 1) {
			conflicts.push(`${name}: defined in ${[...sources].join(' and ')} - last-loaded definition wins`);
		}
	}

	// Conflict type 2: two different peripherals share the same non-zero base address
	const addrMap = new Map<number, string>();
	for (const map of maps) {
		if (!map.baseAddress) { continue; }
		if (addrMap.has(map.baseAddress)) {
			const existing = addrMap.get(map.baseAddress)!;
			if (existing.toUpperCase() !== map.name.toUpperCase()) {
				conflicts.push(`${map.name} and ${existing} share base address 0x${map.baseAddress.toString(16).toUpperCase().padStart(8, '0')}`);
			}
		} else {
			addrMap.set(map.baseAddress, map.name);
		}
	}

	return conflicts;
}

function _fmtSize(bytes: number): string {
	if (!bytes) { return '?'; }
	if (bytes >= 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(0)} MB`; }
	if (bytes >= 1024) { return `${(bytes / 1024).toFixed(0)} KB`; }
	return `${bytes} B`;
}

// ── Architecture helpers ───────────────────────────────────────────────────────

/** Map a peripheral base address segment to a semantic bus name and speed label. */
function _semanticBusName(seg: number, family: string): { busName: string; busSpeed: string } {
	const fam = family.toUpperCase();

	// All comparisons use unsigned 32-bit (seg comes in via >>> 0 from caller)
	const u = seg >>> 0;

	// Cortex-M Private Peripheral Bus — check first (applies to all Cortex-M MCUs)
	if (u >= 0xE0000000) { return { busName: 'Cortex-M PPB', busSpeed: 'NVIC / SCB / SysTick / ITM' }; }

	// STM32 address map
	if (fam.startsWith('STM32')) {
		if (u >= 0xA0000000 && u <= 0xBFFFFFFF) { return { busName: 'AHB3', busSpeed: 'FMC / QSPI / OctoSPI' }; }
		// STM32F4/F7/H7: AHB2 at 0x50xxxxxx; STM32F0/L0/G0/G4: AHB2/IOPORT at 0x48xxxxxx
		if (u >= 0x50000000 && u <= 0x5FFFFFFF) { return { busName: 'AHB2', busSpeed: 'USB OTG / RNG / DCMI / AES' }; }
		if (u >= 0x48000000 && u <= 0x4FFFFFFF) { return { busName: 'AHB2 (IOPORT)', busSpeed: 'GPIO (STM32F0/L0/G0/G4)' }; }
		if (u >= 0x40020000 && u <= 0x4007FFFF) { return { busName: 'AHB1', busSpeed: 'DMA / GPIO / RCC / CRC / Flash' }; }
		if (u >= 0x40010000 && u <= 0x4001FFFF) { return { busName: 'APB2', busSpeed: 'TIM1/8 / USART1/6 / SPI1 / ADC / EXTI / SYSCFG' }; }
		if (u >= 0x40000000 && u <= 0x4000FFFF) { return { busName: 'APB1', busSpeed: 'TIM2-7 / USART2-5 / SPI2-3 / I2C / CAN / DAC / PWR' }; }
	}

	// STM32WB / WL dual-core — separate radio subsystem
	if (fam.startsWith('STM32WB') || fam.startsWith('STM32WL')) {
		if (u >= 0x58000000 && u <= 0x5FFFFFFF) { return { busName: 'AHB3/Radio', busSpeed: 'RF subsystem' }; }
	}

	// nRF52 / nRF53 / nRF91
	if (fam.startsWith('NRF')) {
		if (u >= 0x50000000) { return { busName: 'AHB',  busSpeed: 'GPIO / CLOCK / POWER / RADIO' }; }
		if (u >= 0x40000000) { return { busName: 'APB',  busSpeed: 'UART / SPI / TWI / SAADC / TIMER' }; }
	}

	// RP2040 / RP2350
	if (fam.startsWith('RP2040') || fam.startsWith('RP2350') || fam.startsWith('RP')) {
		if (u >= 0x50000000) { return { busName: 'AHB-Lite', busSpeed: 'DMA / USB / XIP / PIO' }; }
		if (u >= 0x40000000) { return { busName: 'APB',  busSpeed: 'UART / SPI / I2C / ADC / PWM / PIO' }; }
	}

	// ESP32 family
	if (fam.startsWith('ESP32') || fam.startsWith('ESP')) {
		if (u >= 0x60000000) { return { busName: 'APB', busSpeed: 'UART / SPI / I2C / GPIO / LEDC' }; }
		if (u >= 0x3FF00000) { return { busName: 'AHB', busSpeed: 'Cache / DMA / RTC / SYSCON' }; }
	}

	// GD32 (GigaDevice) — STM32-compatible memory map
	if (fam.startsWith('GD32')) {
		if (u >= 0x40020000 && u <= 0x4007FFFF) { return { busName: 'AHB1', busSpeed: 'DMA / GPIO / RCU / CRC' }; }
		if (u >= 0x40010000 && u <= 0x4001FFFF) { return { busName: 'APB2', busSpeed: 'TIM0/7 / USART0 / SPI0 / ADC' }; }
		if (u >= 0x40000000 && u <= 0x4000FFFF) { return { busName: 'APB1', busSpeed: 'TIM1-6 / USART1-4 / SPI1-2 / I2C / CAN / DAC' }; }
	}

	// NXP Kinetis / i.MX RT / K-series
	if (fam.startsWith('MK') || fam.startsWith('IMXRT') || fam.startsWith('K6') || fam.startsWith('K2')) {
		if (u >= 0x60000000) { return { busName: 'FlexSPI / SEMC', busSpeed: 'External memory interface' }; }
		if (u >= 0x40080000 && u <= 0x400FFFFF) { return { busName: 'AIPS1', busSpeed: 'LPUART / SPI / LPI2C / PIT / DMA' }; }
		if (u >= 0x40000000 && u <= 0x4007FFFF) { return { busName: 'AIPS0', busSpeed: 'GPIO / ADC / FTM / PIT / UART / SPI' }; }
	}

	// Renesas RA (Cortex-M33/M4/M23)
	if (fam.startsWith('RA') || fam.startsWith('RE') || fam.startsWith('RZ')) {
		if (u >= 0x40000000 && u <= 0x4FFFFFFF) { return { busName: 'AHB / APB', busSpeed: 'SCI / SPI / IIC / GPT / AGT / ADC' }; }
	}

	// SAMD / SAME / SAML (Microchip/Atmel)
	if (fam.startsWith('SAMD') || fam.startsWith('SAME') || fam.startsWith('SAML') || fam.startsWith('SAMC')) {
		if (u >= 0x42000000) { return { busName: 'APBC', busSpeed: 'SERCOM / TCC / TC / ADC' }; }
		if (u >= 0x41000000) { return { busName: 'APBB', busSpeed: 'PAC / DSU / NVMCTRL / PORT' }; }
		if (u >= 0x40000000) { return { busName: 'APBA', busSpeed: 'PAC / PM / SYSCTRL / GCLK / WDT / RTC' }; }
	}

	// LPC (NXP)
	if (fam.startsWith('LPC')) {
		if (u >= 0x50000000) { return { busName: 'AHB', busSpeed: 'GPIO / DMA' }; }
		if (u >= 0x40080000) { return { busName: 'APB1', busSpeed: 'UART / SPI / I2C / ADC' }; }
		if (u >= 0x40000000) { return { busName: 'APB0', busSpeed: 'Watchdog / Timer / UART / I2C' }; }
	}

	// Generic fallback — show address range
	const addrStr = `0x${u.toString(16).toUpperCase().padStart(8, '0')}`;
	return { busName: `BUS`, busSpeed: addrStr };
}

function _fmt(bytes: number): string {
	if (bytes >= 1024 * 1024) { return `${(bytes / (1024 * 1024)).toFixed(0)} MB`; }
	if (bytes >= 1024) { return `${(bytes / 1024).toFixed(0)} KB`; }
	return `${bytes} B`;
}

function _fieldColor(access: string): string {
	switch (access) {
		case 'read-write': return 'var(--vscode-badge-background)';
		case 'read-only': return 'transparent';
		case 'write-only': return 'var(--vscode-editorWarning-background,transparent)';
		default: return 'transparent';
	}
}

// Extend HTMLElement for internal marker
declare global {
	interface HTMLElement {
		_isBodyMarker?: boolean;
	}
}
