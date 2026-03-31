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
 *  ACTIVE  — Top bar + 6-tab environment: Dashboard · Datasheets · Registers · Serial · Compliance · Build
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
import { IPeripheralRegisterMap, COMMON_BAUD_RATES, FirmwareComplianceFramework } from '../../common/firmwareTypes.js';


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

type TabId = 'dashboard' | 'pinout' | 'architecture' | 'datasheets' | 'registers' | 'serial' | 'compliance' | 'build';

const TABS: Array<{ id: TabId; label: string }> = [
	{ id: 'dashboard', label: 'Dashboard' },
	{ id: 'pinout', label: 'Pinout' },
	{ id: 'architecture', label: 'Architecture' },
	{ id: 'datasheets', label: 'Datasheets' },
	{ id: 'registers', label: 'Registers' },
	{ id: 'serial', label: 'Serial' },
	{ id: 'compliance', label: 'Compliance' },
	{ id: 'build', label: 'Build' },
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
	) {
		super(FIRMWARE_PART_ID, { hasTitle: false }, themeService, storageService, layoutService);
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
		bar.appendChild($t('span', '\u2297 Neural Inverse  \u00b7  Firmware Console', [
			'color:var(--vscode-titleBar-activeForeground,var(--vscode-foreground))',
			'font-weight:700', 'font-size:12px', 'letter-spacing:0.04em', 'flex:1',
		].join(';')));

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

			bar.appendChild(this._btn('End Session', false, () => this._session.endSession(), 'font-size:11px;padding:3px 10px;'));
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


	// ─── IDLE Screen (Hardware Target Selector) ──────────────────────────────

	private _renderIdle(root: HTMLElement): void {
		const wrap = $e('div', 'flex:1;display:flex;flex-direction:column;background:var(--vscode-editor-background);overflow:hidden;');

		// Header Bar (IDE Native)
		const header = $e('div', 'height:40px;display:flex;align-items:center;padding:0 24px;border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border));background:var(--vscode-sideBarSectionHeader-background,var(--vscode-editor-background));flex-shrink:0;');
		
		const title = $e('div', 'display:flex;align-items:center;margin-right:32px;');
		title.appendChild($t('span', '\u2297', 'color:var(--vscode-focusBorder);font-size:16px;margin-right:8px;'));
		title.appendChild($t('span', 'NEURAL INVERSE FIRMWARE', 'font-size:11px;font-weight:700;letter-spacing:1px;color:var(--vscode-foreground);'));
		header.appendChild(title);

		const searchBox = $e('div', 'flex:1;max-width:500px;position:relative;display:flex;align-items:center;');
		const searchInput = $e('input', [
			'width:100%', 'height:26px', 'padding:0 12px',
			'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
			'background:var(--vscode-input-background)',
			'color:var(--vscode-input-foreground)',
			'font-size:12px', 'font-family:inherit', 'outline:none', 'border-radius:2px'
		].join(';')) as HTMLInputElement;
		searchInput.placeholder = 'Filter part numbers (e.g. STM32F407, NRF52840, RP2040)...';
		searchInput.addEventListener('focus', () => searchInput.style.borderColor = 'var(--vscode-focusBorder)');
		searchInput.addEventListener('blur', () => searchInput.style.borderColor = 'var(--vscode-input-border,var(--vscode-widget-border))');
		searchBox.appendChild(searchInput);
		header.appendChild(searchBox);

		header.appendChild($t('div', `${this._mcuDb.count} Devices Loaded \u00b7 CMSIS-SVD Registry`, 'font-size:11px;color:var(--vscode-descriptionForeground);margin-left:auto;letter-spacing:0.5px;'));
		wrap.appendChild(header);

		// Body Area
		const body = $e('div', 'flex:1;display:flex;flex-direction:row;overflow:hidden;');
		
		// Left Sidebar: Filters & Scan
		const sidebar = $e('div', 'width:260px;background:var(--vscode-sideBar-background);border-right:1px solid var(--vscode-widget-border);display:flex;flex-direction:column;flex-shrink:0;overflow-y:auto;');
		
		const sectionHeader = (txt: string) => {
			const hdr = $e('div', 'padding:12px 16px 8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--vscode-sideBarTitle-foreground,var(--vscode-foreground));');
			hdr.innerText = txt;
			return hdr;
		};

		sidebar.appendChild(sectionHeader('Workspace Intelligence'));
		const scanWrap = $e('div', 'padding:0 16px 16px;border-bottom:1px solid var(--vscode-widget-border);');
		scanWrap.appendChild($t('p', 'Auto-detect toolchains & targets from CMakeLists.txt and platformio.ini.', 'font-size:11px;color:var(--vscode-descriptionForeground);margin:0 0 10px;line-height:1.4;'));
		scanWrap.appendChild(this._btn('Auto-Scan Project', true, () => {}, 'width:100%;padding:4px 0;font-size:11px;'));
		sidebar.appendChild(scanWrap);

		sidebar.appendChild(sectionHeader('Filter by Manufacturer'));
		const mfgList = $e('div', 'padding:0 16px 16px;display:flex;flex-direction:column;gap:6px;');
		const sortedMfgs = this._mcuDb.manufacturers.slice(0, 15);
		for (const mfg of sortedMfgs) {
			const lbl = $e('label', 'font-size:11px;color:var(--vscode-foreground);display:flex;align-items:center;gap:8px;cursor:pointer;');
			const cb = $e('input', 'margin:0;') as HTMLInputElement; cb.type = 'checkbox'; cb.checked = false;
			lbl.appendChild(cb);
			lbl.appendChild(document.createTextNode(mfg));
			mfgList.appendChild(lbl);
		}
		sidebar.appendChild(mfgList);
		body.appendChild(sidebar);

		// Main Table Area
		const tableArea = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;background:var(--vscode-editor-background);');
		
		const colTemplate = '240px 100px 80px 80px 80px 1fr';
		const tableHeader = $e('div', [
			`display:grid`, `grid-template-columns:${colTemplate}`, `gap:16px`,
			`padding:8px 32px`, `border-bottom:1px solid var(--vscode-widget-border)`,
			`font-size:11px`, `font-weight:600`, `color:var(--vscode-descriptionForeground)`,
			`text-transform:uppercase`, `flex-shrink:0`
		].join(';'));
		
		['Part Number', 'Core', 'Clock', 'Flash', 'RAM', 'Manufacturer'].forEach(t => tableHeader.appendChild($t('div', t, 'padding:4px 0;')));
		tableArea.appendChild(tableHeader);

		const tableList = $e('div', 'flex:1;overflow-y:auto;padding:0;margin:0;');
		tableArea.appendChild(tableList);
		body.appendChild(tableArea);

		wrap.appendChild(body);
		root.appendChild(wrap);

		// Render logic
		this._renderMCUDataGrid(tableList, '');
		searchInput.addEventListener('input', () => {
			this._renderMCUDataGrid(tableList, searchInput.value);
		});

		setTimeout(() => searchInput.focus(), 50);
	}

	private _renderMCUDataGrid(container: HTMLElement, query: string): void {
		while (container.firstChild) { container.removeChild(container.firstChild); }
		
		const hits = this._mcuDb.search(query, 120); // Massive list natively handles 120 rows seamlessly

		const colTemplate = '240px 100px 80px 80px 80px 1fr';

		for (const entry of hits) {
			const row = $e('div', [
				`display:grid`, `grid-template-columns:${colTemplate}`, `gap:16px`,
				`padding:6px 32px`, `align-items:center`,
				`border-bottom:1px solid var(--vscode-widget-border)`,
				`font-size:12px`, `cursor:pointer`,
				`color:var(--vscode-foreground)`,
				`transition:background-color 0.1s`
			].join(';'));
			// Ensure very faint borders
			row.style.borderBottomColor = 'rgba(128, 128, 128, 0.15)';

			row.addEventListener('mouseenter', () => row.style.background = 'var(--vscode-list-hoverBackground)');
			row.addEventListener('mouseleave', () => row.style.background = 'transparent');
			row.addEventListener('click', () => {
				const cfg = this._mcuDb.toMCUConfig(entry);
				this._session.startSession(cfg, entry.commonBoards[0]);
			});

			// Part Number
			row.appendChild($t('div', entry.variant, 'font-weight:600;color:var(--vscode-editor-foreground);letter-spacing:0.5px;'));
			
			// Core
			row.appendChild($t('div', entry.core.toUpperCase(), 'font-family:var(--vscode-editor-font-family,monospace);font-size:11px;color:var(--vscode-symbolIcon-classForeground,var(--vscode-foreground));'));
			
			// Clock
			row.appendChild($t('div', `${entry.clockMHz} MHz`, 'font-family:var(--vscode-editor-font-family,monospace);font-size:11px;'));
			
			// Flash
			row.appendChild($t('div', _fmt(entry.flashSize), 'font-family:var(--vscode-editor-font-family,monospace);font-size:11px;'));
			
			// RAM
			row.appendChild($t('div', _fmt(entry.ramSize), 'font-family:var(--vscode-editor-font-family,monospace);font-size:11px;'));
			
			// Vendor
			row.appendChild($t('div', entry.manufacturer, 'font-size:11px;color:var(--vscode-descriptionForeground);text-transform:uppercase;font-weight:600;letter-spacing:0.5px;'));

			container.appendChild(row);
		}

		if (hits.length === 0) {
			container.appendChild($t('div', 'No matching parts found in the registry.', 'padding:32px;color:var(--vscode-descriptionForeground);font-size:12px;font-style:italic;text-align:center;'));
		}
	}


	// ─── Active Tab Dispatch ──────────────────────────────────────────────────

	private _renderActiveTab(root: HTMLElement): void {
		switch (this._activeTab) {
			case 'dashboard': this._renderDashboard(root); break;
			case 'pinout': this._renderPinout(root); break;
			case 'architecture': this._renderArchitecture(root); break;
			case 'datasheets': this._renderDatasheets(root); break;
			case 'registers': this._renderRegisters(root); break;
			case 'serial': this._renderSerial(root); break;
			case 'compliance': this._renderCompliance(root); break;
			case 'build': this._renderBuild(root); break;
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

		scroll.appendChild(grid);
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
			? `Model: ${availableModels[0].label}${availableModels.length > 1 ? ` · Also available: ${availableModels.slice(1).map(m => m.label).join(', ')}` : ''}`
			: '⚠ No model configured — heuristic extraction only (no LLM). Configure a model in Neural Inverse settings.';

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
				`⏳ Processing: ${fileName}`,
				availableModels.length > 0 ? `Using: ${availableModels[0].label}` : 'Heuristic extraction (no model)',
			].join(' · '),
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
					? `⚡ ${result.info.title} — loaded from Hardware KB cache · ${result.registerMaps.length} peripherals · ${result.registerMaps.reduce((n, m) => n + m.registers.length, 0)} registers (To force re-extraction: remove entry from Hardware KB Cache below, then re-upload)`
					: [
						`✅ ${result.info.title}`,
						`${result.registerMaps.length} peripherals`,
						`${result.registerMaps.reduce((n, m) => n + m.registers.length, 0)} registers`,
						`${result.errata.length} errata`,
						`${result.extractionTimeMs}ms`,
					].join(' · '),
			});

			// Warn when no registers were extracted — helps user understand they may need
			// a model configured or an SVD file for complete coverage.
			if (result.registerMaps.length === 0) {
				this._notify.notify({
					severity: Severity.Warning,
					message: availableModels.length > 0
						? `⚠ No registers extracted from ${fileName}. The PDF format may be unsupported. Try Load SVD File for complete register coverage.`
						: `⚠ No registers extracted — no model configured. Configure a model in Neural Inverse Settings, or use Load SVD File instead.`,
				});
			}

			const critical = result.errata.filter(e => e.severity === 'critical' || e.severity === 'major');
			if (critical.length > 0) {
				this._notify.notify({
					severity: Severity.Warning,
					message: `⚠ ${critical.length} major/critical silicon errata in ${result.info.title} — check Datasheets tab.`,
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
			message: `⏳ Parsing SVD: ${fileName}…`,
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
					message: `⚠ SVD device "${svdResult.deviceName}" may not match session MCU "${s.mcuConfig?.family}" — verify register maps in the Registers tab.`,
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

			// Persist to .inverse/hardware-kb/ so it survives reloads
			await this._kbSvc.store(contentHash, {
				info,
				registerMaps: taggedPeripherals,
				timingConstraints: [],
				errata: [],
				pages: [],
				extractionTimeMs: 0,
			});

			notification.close?.();
			this._notify.notify({
				severity: Severity.Info,
				message: `✅ ${svdResult.deviceName} — ${svdResult.peripherals.length} peripherals, ${totalRegs} registers saved to hardware-kb`,
			});
			this._switchTab('registers');
		} catch (err) {
			notification.close?.();
			this._notify.notify({ severity: Severity.Error, message: `Failed to parse ${fileName}: ${err}` });
		}
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
		betaBadge.textContent = 'β';
		pdfBtn.appendChild(betaBadge);
		hdrBtns.appendChild(pdfBtn);

		hdrRow.appendChild(hdrBtns);
		scroll.appendChild(hdrRow);

		// Beta notice
		scroll.appendChild($t('div',
			'⚠ PDF extraction is Beta — errata & timing only. Use Load SVD File for complete register coverage.',
			'font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:14px;opacity:0.75;',
		));

		// ── Live extraction progress card ─────────────────────────────────
		if (this._extractionProgress) {
			const ep = this._extractionProgress;
			const pct = ep.totalPages > 0 ? Math.round((ep.processedPages / ep.totalPages) * 100) : 0;
			const stageLabels: Record<string, string> = {
				'reading-pdf': '📄 Reading PDF…',
				'checking-cache': '🔍 Checking Hardware KB cache…',
				'classifying-pages': `🏷 Classifying pages (${ep.processedPages}/${ep.totalPages})…`,
				'extracting-registers': '⚙ Extracting register maps…',
				'extracting-timing': '⏱ Extracting timing constraints…',
				'extracting-errata': '⚠ Extracting silicon errata…',
				'saving-to-kb': '💾 Saving to Hardware KB…',
			};
			const stageLabel = stageLabels[ep.status] ?? `Processing… (${ep.status})`;

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
			titleCol.appendChild($t('div', ep.fileName || 'Processing…', 'font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
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
			if (ep.totalPages > 0) { counters.appendChild(counter('📄', ep.totalPages, 'Pages')); }
			counters.appendChild(counter('⚙', ep.registers, 'Registers'));
			counters.appendChild(counter('⏱', ep.timing, 'Timing'));
			counters.appendChild(counter('⚠', ep.errata, 'Errata'));
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
					const mismatchBadge = $t('span', '⚠ Wrong MCU', [
						'margin-left:6px', 'flex-shrink:0',
						'font-size:10px', 'padding:2px 6px', 'border-radius:3px',
						'background:rgba(255,180,0,0.15)',
						'color:#e0a84e',
						'border:1px solid rgba(255,180,0,0.4)',
					].join(';'));
					mismatchBadge.title = `Loaded for ${ds.mcuFamily} — session MCU is ${s.mcuConfig?.family}`;
					dsHdr.appendChild(mismatchBadge);

					// "Replace" button — removes bad entry and auto-fetches correct SVD
					if (s.mcuConfig) {
						const replaceBtn = $t('button', '↺ Replace', [
							'margin-left:6px', 'flex-shrink:0',
							'font-size:10px', 'padding:2px 8px', 'border-radius:3px', 'cursor:pointer',
							'background:rgba(255,180,0,0.2)',
							'color:#e0a84e',
							'border:1px solid rgba(255,180,0,0.5)',
						].join(';'));
						replaceBtn.title = `Remove ${ds.mcuFamily} data and load the correct SVD for ${s.mcuConfig.family}`;
						replaceBtn.addEventListener('click', async () => {
							replaceBtn.textContent = '…';
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
								this._notify.notify({ severity: Severity.Info, message: `⏳ Fetching correct SVD for ${s.mcuConfig!.family}…` });
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
										this._notify.notify({ severity: Severity.Info, message: `✅ Replaced with ${result.svdFile} — ${tagged.length} peripherals, ${totalR} registers` });
									} else {
										this._notify.notify({ severity: Severity.Warning, message: `No SVD found for ${s.mcuConfig!.family} — use Load SVD File to provide one manually.` });
									}
								} catch (err) {
									this._notify.notify({ severity: Severity.Error, message: `Failed to fetch SVD: ${err}` });
								}
							} else {
								this._notify.notify({ severity: Severity.Warning, message: `No SVD catalogue entry for ${s.mcuConfig!.family} — use Load SVD File to provide one manually.` });
							}
						});
						dsHdr.appendChild(replaceBtn);
					}
				}

				// "🔄 Re-extract" — clears KB cache entry so the next upload processes fresh.
				// ds.id = 'ds-<contentHash>' for PDF-sourced datasheets (SVD-only use 'svd-...').
				if (ds.id.startsWith('ds-')) {
					const contentHash = ds.id.slice(3);
					const reextractBtn = $t('button', '🔄', [
						'margin-left:6px', 'flex-shrink:0',
						'font-size:11px', 'padding:2px 7px', 'border-radius:4px', 'cursor:pointer',
						'background:transparent',
						'border:1px solid var(--vscode-focusBorder,#007fd4)',
						'color:var(--vscode-focusBorder,#007fd4)',
					].join(';'));
					reextractBtn.title = 'Clear KB cache entry and re-upload to force fresh extraction';
					reextractBtn.addEventListener('click', async () => {
						reextractBtn.textContent = '…';
						reextractBtn.setAttribute('disabled', 'true');
						try {
							await this._kbSvc.remove(contentHash);
							this._session.removeDatasheet(ds.id);
							this._notify.notify({ severity: Severity.Info, message: `🗑 KB cache cleared for ${ds.title}. Re-upload the PDF to extract fresh data.` });
						} catch (err) {
							this._notify.notify({ severity: Severity.Error, message: `Failed to clear KB entry: ${err}` });
							reextractBtn.textContent = '🔄';
							reextractBtn.removeAttribute('disabled');
						}
					});
					dsHdr.appendChild(reextractBtn);
				}

				const removeBtn = $t('button', '✕', [
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

					const removeBtn = $t('button', '✕ Remove', [
						'font-size:10px', 'padding:2px 8px', 'border-radius:4px', 'cursor:pointer',
						'background:transparent', 'border:1px solid var(--vscode-errorForeground,#f48771)',
						'color:var(--vscode-errorForeground,#f48771)',
					].join(';'));
					removeBtn.addEventListener('click', async () => {
						removeBtn.textContent = '…';
						removeBtn.setAttribute('disabled', 'true');
						try {
							await this._kbSvc.remove(e.contentHash);
							this._notify.notify({ severity: Severity.Info, message: `🗑 Removed ${e.fileName} from Hardware KB.` });
							this._switchTab('datasheets'); // re-render
						} catch (err) {
							removeBtn.textContent = '✕ Remove';
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
					stub.title = `Pin ${slot + 1} — VDD/GND`;
				} else if (assignment) {
					stub.style.background = assignment.color;
					stub.style.boxShadow = `0 0 5px ${assignment.color}55`;
					stub.title = `Pin ${slot + 1} — ${assignment.name}`;
				} else {
					stub.style.background = '#3a3a3a';
					stub.title = `Pin ${slot + 1} — Unassigned`;
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
			const backBtn = $t('button', '← Back', 'background:none;border:none;color:var(--vscode-textLink-foreground);font-size:10px;cursor:pointer;padding:0;flex-shrink:0;');
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
			const jumpBtn = $t('button', `Open in Registers Tab →`, [
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
				summary.appendChild($t('div', `${s.mcuConfig.clockMHz ?? '?'} MHz  ·  Flash ${_fmtSize(s.mcuConfig.flashSize)}  ·  RAM ${_fmtSize(s.mcuConfig.ramSize)}`, 'color:var(--vscode-descriptionForeground);'));
				if (s.mcuConfig.gpioCount) {
					summary.appendChild($t('div', `${s.mcuConfig.gpioCount} GPIO  ·  ${totalPins} pins`, 'color:var(--vscode-descriptionForeground);margin-top:2px;'));
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

			// Conflicts
			const conflicts = _detectPinConflicts(loadedMaps);
			if (conflicts.length > 0) {
				padded.appendChild($e('hr', 'border:none;border-bottom:1px solid var(--vscode-widget-border);margin:12px 0;'));
				padded.appendChild($t('div', `⚠ ${conflicts.length} Conflict(s)`, 'font-size:11px;font-weight:700;color:var(--vscode-terminal-ansiYellow);margin-bottom:6px;'));
				for (const c of conflicts) {
					padded.appendChild($t('div', c, 'font-size:10px;color:var(--vscode-terminal-ansiYellow);padding:2px 0;'));
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
			const periphName = titleAttr.replace(/^Pin \d+ — /, '');
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
						const jumpBtn = $t('button', `Open in Registers Tab →`, [
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
				sidebar.appendChild($t('div', (isMismatch ? '⚠ ' : '') + shortSrc, [
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
					cell.title = `${field.name} [${field.bitOffset + field.bitWidth - 1}:${field.bitOffset}] — ${field.description}`;
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
		const refreshBtn = $t('button', '⟳', [
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
			'background:' + (isConnected ? 'var(--vscode-terminal-ansiGreen,#4caf50)' : 'var(--vscode-descriptionForeground)'),
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
			statBar.textContent = `Connected to ${state.port} @ ${state.baudRate} baud since ${since}  ·  RX ${state.bytesReceived} B  ·  TX ${state.bytesTransmitted} B`;
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
			{ id: 'iso-26262', label: 'ISO 26262', desc: 'Road vehicles — Functional Safety (ASIL)' },
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
				active ? 'border-left:3px solid var(--vscode-terminal-ansiGreen,#4caf50);' : '',
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
					'background:var(--vscode-terminal-ansiGreen,#4caf50)',
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

	private _renderBuild(root: HTMLElement): void {
		const s = this._session.session;
		const scroll = $e('div', 'flex:1;overflow-y:auto;padding:20px;');
		root.appendChild(scroll);

		scroll.appendChild($t('h3', 'Build & Flash', 'margin:0 0 16px;font-size:15px;font-weight:700;'));

		// Build actions row
		const actRow = $e('div', 'display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;');
		actRow.appendChild(this._btn('Build Project', true, () => { }, 'font-size:12px;padding:6px 16px;'));
		actRow.appendChild(this._btn('Flash Device', false, () => { }, 'font-size:12px;padding:6px 16px;'));
		actRow.appendChild(this._btn('Analyze Binary Size', false, () => { }, 'font-size:12px;padding:6px 16px;'));
		actRow.appendChild(this._btn('Clean', false, () => { }, 'font-size:12px;padding:6px 16px;'));
		scroll.appendChild(actRow);

		// Last build result
		if (s.lastBuildResult) {
			const b = s.lastBuildResult;
			const resultCard = $e('div', [
				'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
				'border-radius:7px', 'overflow:hidden', 'margin-bottom:14px',
			].join(';'));
			const resultHdr = $e('div', [
				'padding:8px 14px',
				'background:var(--vscode-sideBarSectionHeader-background)',
				'display:flex', 'align-items:center', 'gap:10px',
			].join(';'));
			resultHdr.appendChild($t('span', b.success ? 'Last Build: SUCCESS' : 'Last Build: FAILED', [
				'font-size:12px', 'font-weight:700',
				'color:' + (b.success ? 'var(--vscode-terminal-ansiGreen,#4caf50)' : 'var(--vscode-errorForeground,#f48771)'),
			].join(';')));
			resultHdr.appendChild($t('span', `${b.durationMs}ms \u00b7 ${b.errors.length} errors \u00b7 ${b.warnings.length} warnings`,
				'font-size:11px;color:var(--vscode-descriptionForeground);'));
			resultCard.appendChild(resultHdr);

			const resultBody = $e('div', [
				'padding:10px 14px',
				'font-family:var(--vscode-editor-font-family,monospace)',
				'font-size:11px', 'line-height:1.6',
				'background:var(--vscode-terminal-background,var(--vscode-editor-background))',
				'max-height:200px', 'overflow-y:auto',
			].join(';'));
			for (const err of b.errors.slice(0, 10)) {
				resultBody.appendChild($t('div', `${err.file}:${err.line}: error: ${err.message}`,
					'color:var(--vscode-errorForeground,#f48771);'));
			}
			for (const w of b.warnings.slice(0, 5)) {
				resultBody.appendChild($t('div', `${w.file}:${w.line}: warning: ${w.message}`,
					'color:var(--vscode-editorWarning-foreground,#ffcc02);'));
			}
			resultCard.appendChild(resultBody);
			scroll.appendChild(resultCard);
		} else {
			scroll.appendChild(this._emptyState(
				'No Build Results',
				'Run a build to see output, errors, and warnings here.',
				s.projectInfo ? `Detected project type: ${s.projectInfo.projectType}` : 'No project detected yet.',
			));
		}
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
		wrap.appendChild($t('div', '\u2297', 'font-size:44px;color:var(--vscode-descriptionForeground);opacity:0.2;margin-bottom:16px;'));
		wrap.appendChild($t('div', title, 'font-size:14px;font-weight:700;color:var(--vscode-editor-foreground);margin-bottom:8px;'));
		wrap.appendChild($t('div', desc, 'font-size:12px;color:var(--vscode-descriptionForeground);max-width:380px;margin:0 auto;line-height:1.6;'));
		if (note) {
			wrap.appendChild($t('div', note, 'font-size:11px;color:var(--vscode-descriptionForeground);opacity:0.6;margin-top:12px;'));
		}
		return wrap;
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
			conflicts.push(`${name}: defined in ${[...sources].join(' and ')} — last-loaded definition wins`);
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
	if (u >= 0xE0000000) { return { busName: 'Cortex-M PPB', busSpeed: 'NVIC · SCB · SysTick · ITM' }; }

	// STM32 address map
	if (fam.startsWith('STM32')) {
		if (u >= 0xA0000000 && u <= 0xBFFFFFFF) { return { busName: 'AHB3', busSpeed: 'FMC / QSPI / OctoSPI' }; }
		// STM32F4/F7/H7: AHB2 at 0x50xxxxxx; STM32F0/L0/G0/G4: AHB2/IOPORT at 0x48xxxxxx
		if (u >= 0x50000000 && u <= 0x5FFFFFFF) { return { busName: 'AHB2', busSpeed: 'USB OTG · RNG · DCMI · AES' }; }
		if (u >= 0x48000000 && u <= 0x4FFFFFFF) { return { busName: 'AHB2 (IOPORT)', busSpeed: 'GPIO (STM32F0/L0/G0/G4)' }; }
		if (u >= 0x40020000 && u <= 0x4007FFFF) { return { busName: 'AHB1', busSpeed: 'DMA · GPIO · RCC · CRC · Flash' }; }
		if (u >= 0x40010000 && u <= 0x4001FFFF) { return { busName: 'APB2', busSpeed: 'TIM1/8 · USART1/6 · SPI1 · ADC · EXTI · SYSCFG' }; }
		if (u >= 0x40000000 && u <= 0x4000FFFF) { return { busName: 'APB1', busSpeed: 'TIM2-7 · USART2-5 · SPI2-3 · I2C · CAN · DAC · PWR' }; }
	}

	// STM32WB / WL dual-core — separate radio subsystem
	if (fam.startsWith('STM32WB') || fam.startsWith('STM32WL')) {
		if (u >= 0x58000000 && u <= 0x5FFFFFFF) { return { busName: 'AHB3/Radio', busSpeed: 'RF subsystem' }; }
	}

	// nRF52 / nRF53 / nRF91
	if (fam.startsWith('NRF')) {
		if (u >= 0x50000000) { return { busName: 'AHB',  busSpeed: 'GPIO · CLOCK · POWER · RADIO' }; }
		if (u >= 0x40000000) { return { busName: 'APB',  busSpeed: 'UART · SPI · TWI · SAADC · TIMER' }; }
	}

	// RP2040 / RP2350
	if (fam.startsWith('RP2040') || fam.startsWith('RP2350') || fam.startsWith('RP')) {
		if (u >= 0x50000000) { return { busName: 'AHB-Lite', busSpeed: 'DMA · USB · XIP · PIO' }; }
		if (u >= 0x40000000) { return { busName: 'APB',  busSpeed: 'UART · SPI · I2C · ADC · PWM · PIO' }; }
	}

	// ESP32 family
	if (fam.startsWith('ESP32') || fam.startsWith('ESP')) {
		if (u >= 0x60000000) { return { busName: 'APB', busSpeed: 'UART · SPI · I2C · GPIO · LEDC' }; }
		if (u >= 0x3FF00000) { return { busName: 'AHB', busSpeed: 'Cache · DMA · RTC · SYSCON' }; }
	}

	// GD32 (GigaDevice) — STM32-compatible memory map
	if (fam.startsWith('GD32')) {
		if (u >= 0x40020000 && u <= 0x4007FFFF) { return { busName: 'AHB1', busSpeed: 'DMA · GPIO · RCU · CRC' }; }
		if (u >= 0x40010000 && u <= 0x4001FFFF) { return { busName: 'APB2', busSpeed: 'TIM0/7 · USART0 · SPI0 · ADC' }; }
		if (u >= 0x40000000 && u <= 0x4000FFFF) { return { busName: 'APB1', busSpeed: 'TIM1-6 · USART1-4 · SPI1-2 · I2C · CAN · DAC' }; }
	}

	// NXP Kinetis / i.MX RT / K-series
	if (fam.startsWith('MK') || fam.startsWith('IMXRT') || fam.startsWith('K6') || fam.startsWith('K2')) {
		if (u >= 0x60000000) { return { busName: 'FlexSPI / SEMC', busSpeed: 'External memory interface' }; }
		if (u >= 0x40080000 && u <= 0x400FFFFF) { return { busName: 'AIPS1', busSpeed: 'LPUART · SPI · LPI2C · PIT · DMA' }; }
		if (u >= 0x40000000 && u <= 0x4007FFFF) { return { busName: 'AIPS0', busSpeed: 'GPIO · ADC · FTM · PIT · UART · SPI' }; }
	}

	// Renesas RA (Cortex-M33/M4/M23)
	if (fam.startsWith('RA') || fam.startsWith('RE') || fam.startsWith('RZ')) {
		if (u >= 0x40000000 && u <= 0x4FFFFFFF) { return { busName: 'AHB / APB', busSpeed: 'SCI · SPI · IIC · GPT · AGT · ADC' }; }
	}

	// SAMD / SAME / SAML (Microchip/Atmel)
	if (fam.startsWith('SAMD') || fam.startsWith('SAME') || fam.startsWith('SAML') || fam.startsWith('SAMC')) {
		if (u >= 0x42000000) { return { busName: 'APBC', busSpeed: 'SERCOM · TCC · TC · ADC' }; }
		if (u >= 0x41000000) { return { busName: 'APBB', busSpeed: 'PAC · DSU · NVMCTRL · PORT' }; }
		if (u >= 0x40000000) { return { busName: 'APBA', busSpeed: 'PAC · PM · SYSCTRL · GCLK · WDT · RTC' }; }
	}

	// LPC (NXP)
	if (fam.startsWith('LPC')) {
		if (u >= 0x50000000) { return { busName: 'AHB', busSpeed: 'GPIO · DMA' }; }
		if (u >= 0x40080000) { return { busName: 'APB1', busSpeed: 'UART · SPI · I2C · ADC' }; }
		if (u >= 0x40000000) { return { busName: 'APB0', busSpeed: 'Watchdog · Timer · UART · I2C' }; }
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
