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

type TabId = 'dashboard' | 'datasheets' | 'registers' | 'serial' | 'compliance' | 'build';

const TABS: Array<{ id: TabId; label: string }> = [
	{ id: 'dashboard', label: 'Dashboard' },
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


	// ─── IDLE Screen ─────────────────────────────────────────────────────────

	private _renderIdle(root: HTMLElement): void {
		const wrap = $e('div', [
			'display:flex', 'flex-direction:column', 'align-items:center',
			'justify-content:center', 'flex:1', 'padding:40px 32px', 'gap:0',
		].join(';'));

		// Logo glyph
		wrap.appendChild($t('div', '\u2297', [
			'font-size:52px', 'color:var(--vscode-descriptionForeground)',
			'opacity:0.2', 'margin-bottom:16px', 'line-height:1',
		].join(';')));

		wrap.appendChild($t('h2', 'Firmware Environment', [
			'font-size:20px', 'font-weight:700',
			'color:var(--vscode-editor-foreground)', 'margin:0 0 8px',
		].join(';')));

		wrap.appendChild($t('p', 'Hardware-aware AI coding for embedded firmware development.\nAuto-detects MCU, build system, and RTOS from your workspace.', [
			'font-size:12px', 'color:var(--vscode-descriptionForeground)',
			'text-align:center', 'max-width:460px', 'line-height:1.7',
			'margin:0 0 32px', 'white-space:pre-line',
		].join(';')));

		// Primary card — MCU search
		const searchCard = this._idleCard();
		searchCard.appendChild($t('div', 'Select your MCU', [
			'font-size:14px', 'font-weight:700',
			'color:var(--vscode-editor-foreground)', 'margin-bottom:6px',
		].join(';')));
		searchCard.appendChild($t('div', `Search ${this._mcuDb.count} MCUs across ${this._mcuDb.families.length} families from ${this._mcuDb.manufacturers.length} manufacturers.`, [
			'font-size:12px', 'color:var(--vscode-descriptionForeground)',
			'line-height:1.6', 'margin-bottom:14px',
		].join(';')));

		// Search input
		const searchInput = $e('input', [
			'width:100%', 'padding:8px 12px',
			'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
			'border-radius:4px',
			'background:var(--vscode-input-background)',
			'color:var(--vscode-input-foreground)',
			'font-size:13px', 'font-family:inherit', 'outline:none',
			'box-sizing:border-box',
		].join(';')) as HTMLInputElement;
		searchInput.type = 'text';
		searchInput.placeholder = 'Search MCUs (e.g. STM32F407, nRF52840, ESP32-S3, RP2040)...';
		searchCard.appendChild(searchInput);

		const results = $e('div', 'max-height:280px;overflow-y:auto;margin-top:8px;');
		searchCard.appendChild(results);
		this._renderMCUResults(results, '');
		searchInput.addEventListener('input', () => this._renderMCUResults(results, searchInput.value));

		wrap.appendChild(searchCard);
		wrap.appendChild($e('div', 'height:12px;'));

		// Secondary card — auto-scan
		const scanCard = this._idleCard();
		scanCard.appendChild($t('div', 'Auto-Scan Workspace', [
			'font-size:14px', 'font-weight:700',
			'color:var(--vscode-editor-foreground)', 'margin-bottom:6px',
		].join(';')));
		scanCard.appendChild($t('div', 'Automatically detects MCU, board, build system, and RTOS from CMakeLists.txt, platformio.ini, Kconfig, idf_component.yml, and more.', [
			'font-size:12px', 'color:var(--vscode-descriptionForeground)',
			'line-height:1.6', 'margin-bottom:16px',
		].join(';')));
		scanCard.appendChild(this._btn('Scan Workspace for Firmware Project \u2192', true, () => { }, ''));

		wrap.appendChild(scanCard);
		root.appendChild(wrap);
	}

	private _idleCard(): HTMLElement {
		return $e('div', [
			'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
			'border-radius:8px', 'padding:20px 22px',
			'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
			'width:100%', 'max-width:520px', 'box-sizing:border-box',
		].join(';'));
	}

	private _renderMCUResults(container: HTMLElement, query: string): void {
		while (container.firstChild) { container.removeChild(container.firstChild); }
		const hits = this._mcuDb.search(query, 8);

		for (const entry of hits) {
			const item = $e('div', [
				'padding:8px 10px', 'border-radius:5px',
				'border:1px solid transparent',
				'cursor:pointer',
				'transition:background 0.1s,border-color 0.1s',
			].join(';'));

			item.addEventListener('mouseenter', () => {
				item.style.background = 'var(--vscode-list-hoverBackground)';
				item.style.borderColor = 'var(--vscode-focusBorder)';
			});
			item.addEventListener('mouseleave', () => {
				item.style.background = 'transparent';
				item.style.borderColor = 'transparent';
			});
			item.addEventListener('click', () => {
				const cfg = this._mcuDb.toMCUConfig(entry);
				this._session.startSession(cfg, entry.commonBoards[0]);
			});

			item.appendChild($t('div', entry.variant, 'font-weight:600;font-size:12px;'));
			item.appendChild($t('div',
				`${entry.manufacturer} \u00b7 ${entry.core} \u00b7 ${entry.clockMHz}MHz \u00b7 ${_fmt(entry.flashSize)} Flash \u00b7 ${_fmt(entry.ramSize)} RAM`,
				'font-size:11px;color:var(--vscode-descriptionForeground);margin-top:2px;',
			));
			if (entry.commonBoards.length > 0) {
				item.appendChild($t('div', entry.commonBoards.slice(0, 2).join(', '),
					'font-size:10px;color:var(--vscode-descriptionForeground);opacity:0.7;margin-top:1px;',
				));
			}
			container.appendChild(item);
		}
	}


	// ─── Active Tab Dispatch ──────────────────────────────────────────────────

	private _renderActiveTab(root: HTMLElement): void {
		switch (this._activeTab) {
			case 'dashboard': this._renderDashboard(root); break;
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
			this._notify.notify({
				severity: Severity.Info,
				message: [
					`✅ ${result.info.title}`,
					`${result.registerMaps.length} peripherals`,
					`${result.registerMaps.reduce((n, m) => n + m.registers.length, 0)} registers`,
					`${result.errata.length} errata`,
					`${result.extractionTimeMs}ms`,
				].join(' · '),
			});

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

			// Load into current session immediately
			this._session.addDatasheet(info, svdResult.peripherals, [], []);

			// Persist to .inverse/hardware-kb/ so it survives reloads
			await this._kbSvc.store(contentHash, {
				info,
				registerMaps: svdResult.peripherals,
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
				const removeBtn = $t('button', '✕', [
					'margin-left:10px', 'flex-shrink:0',
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
			kbSection.innerHTML = ''; // safe — we only set it once, after async load

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

		for (const map of s.registerMaps) {
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

		layout.appendChild(sidebar);
		layout.appendChild(detail);

		// Default selection
		showPeriph(s.registerMaps[0]);
	}

	private _renderPeripheralDetail(container: HTMLElement, map: IPeripheralRegisterMap): void {
		// Header
		const hdr = $e('div', 'margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border));');
		hdr.appendChild($t('h3', `${map.name}`, 'margin:0 0 4px 0;font-size:16px;font-weight:700;'));
		hdr.appendChild($t('div', `${map.groupName} \u00b7 Base 0x${map.baseAddress.toString(16).toUpperCase()} \u00b7 ${map.registers.length} registers`,
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

				// Field rows
				for (const field of sorted) {
					const row = $e('div', 'display:grid;grid-template-columns:52px 80px 40px 1fr;gap:8px;font-size:11px;padding:2px 0;');
					row.appendChild($t('span', `[${field.bitOffset + field.bitWidth - 1}:${field.bitOffset}]`,
						'color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family,monospace);'));
					row.appendChild($t('span', field.name, 'font-weight:600;'));
					row.appendChild($t('span', field.access.slice(0, 2).toUpperCase(), 'color:var(--vscode-descriptionForeground);'));
					row.appendChild($t('span', field.description, 'color:var(--vscode-descriptionForeground);'));
					fieldArea.appendChild(row);
				}
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
