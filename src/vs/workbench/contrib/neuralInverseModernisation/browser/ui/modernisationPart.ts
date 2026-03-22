/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ModernisationPart — dedicated auxiliary window console for Modernisation Mode.
 *
 * Opened via Cmd+Alt+M. Fully standalone — no sidebar.
 * Inherits the active VS Code colour theme via CSS custom properties.
 *
 * Screens:
 *  IDLE    — Create or open a Modernisation Project.
 *  WIZARD  — Step 1: Legacy folder · Step 2: Modern folder · Step 3: Migration pattern.
 *  ACTIVE  — Left: workflow stages + config · Right: compliance analysis pane.
 *            Stage 2 (Planning) has an explicit approval gate before Stage 3 unlocks.
 */

import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { Part } from '../../../../browser/part.js';
import { IWorkbenchLayoutService } from '../../../../services/layout/browser/layoutService.js';
import { IFingerprintComparisonService } from '../stage3-migration/fingerprintComparisonService.js';
import { ILLMSemanticExtractorService } from '../engine/fingerprint/llmSemanticExtractor.js';
import { extractDeterministicFingerprint } from '../engine/fingerprint/deterministicExtractor.js';
import {
	IComplianceFingerprint, IFingerprintComparison, IFingerprintDivergence,
	IMigrationRoadmap, MigrationRiskLevel,
} from '../../common/modernisationTypes.js';
import {
	IModernisationSessionService,
	IModernisationSessionData,
	IProjectTarget,
	IPatternTopology,
	STAGES,
	STAGE_LABELS,
	ModernisationStage,
	MigrationPattern,
	MIGRATION_PATTERN_PRESETS,
	MIGRATION_PATTERN_LABELS,
	MIGRATION_PATTERN_DESCRIPTIONS,
} from '../modernisationSessionService.js';
import { IDiscoveryService } from '../engine/discovery/discoveryService.js';
import { IDiscoveryResult } from '../engine/discovery/discoveryTypes.js';
import { IMigrationPlannerService } from '../engine/migrationPlannerService.js';
import { IKnowledgeBaseService } from '../knowledgeBase/service.js';
import { IModernisationAgentToolService } from '../engine/agentTools/service.js';
import { IValidationEngineService } from '../engine/validation/service.js';
import { ICutoverService } from '../engine/cutover/service.js';
import { IAutonomyService } from '../engine/autonomy/service.js';
import { ModernisationConsole } from './console/modernisationConsole.js';

// ─── Stage metadata ───────────────────────────────────────────────────────────

const STAGE_DESCRIPTIONS: Record<ModernisationStage, string> = {
	discovery:  'Scan the legacy codebase. Identify and fingerprint all migration units.',
	planning:   'AI generates migration roadmap. Review and approve before migration begins.',
	migration:  'Translate each unit. Run compliance fingerprint comparison per unit.',
	validation: 'Run equivalence tests. Verify compliance invariants hold.',
	cutover:    'Final approval gate. Commit translated code to production branch.',
};


// ─── DOM helpers (no innerHTML — Trusted Types compliant) ─────────────────────

function $e<K extends keyof HTMLElementTagNameMap>(tag: K, css?: string): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	if (css) { el.style.cssText = css; }
	return el;
}

function $t<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, css?: string): HTMLElementTagNameMap[K] {
	const el = $e(tag, css);
	el.textContent = text;
	return el;
}

// ─── Part ─────────────────────────────────────────────────────────────────────

export class ModernisationPart extends Part {

	static readonly ID = 'workbench.parts.neuralInverseModernisation';

	minimumWidth  = 860;
	maximumWidth  = Infinity;
	minimumHeight = 580;
	maximumHeight = Infinity;

	override toJSON(): object { return { id: ModernisationPart.ID }; }

	private readonly _disposables = new DisposableStore();

	// Wizard state
	private _wizardMode    = false;
	private _wizardSources: Array<{ uri: URI; label: string }> = [];
	private _wizardTargets: Array<{ uri: URI; label: string }> = [];
	private _wizardPattern: MigrationPattern | undefined;
	private _wizardBusy    = false;

	// Analysis result area
	private _resultsEl!: HTMLElement;

	// Stage 1 discovery state
	private _discoveryResult:  IDiscoveryResult | undefined;
	private _discoveryRunning: boolean = false;
	private _discoveryLog:     string[] = [];
	private _discoveryLogEl:   HTMLElement | undefined;

	// Stage 2 planning state
	private _roadmap:        IMigrationRoadmap | undefined;
	private _plannerRunning: boolean = false;
	private _plannerLog:     string[] = [];
	private _plannerLogEl:   HTMLElement | undefined;

	private _root!: HTMLElement;

	// The 4-tab console shown in migration and validation stages
	private _console: ModernisationConsole | undefined;

	constructor(
		@IThemeService           themeService: IThemeService,
		@IStorageService         storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IModernisationSessionService private readonly sessionService: IModernisationSessionService,
		@IFileDialogService      private readonly fileDialogService: IFileDialogService,
		@IFileService            private readonly fileService: IFileService,
		@ICommandService         private readonly commandService: ICommandService,
		@IFingerprintComparisonService private readonly comparisonService: IFingerprintComparisonService,
		@ILLMSemanticExtractorService  private readonly semanticExtractor: ILLMSemanticExtractorService,
		@IDiscoveryService       private readonly discoveryService: IDiscoveryService,
		@IMigrationPlannerService private readonly plannerService: IMigrationPlannerService,
		@IKnowledgeBaseService          private readonly kbService:         IKnowledgeBaseService,
		@IModernisationAgentToolService private readonly agentToolsService: IModernisationAgentToolService,
		@IValidationEngineService       private readonly validationService: IValidationEngineService,
		@ICutoverService                private readonly cutoverService:    ICutoverService,
		@IAutonomyService               private readonly autonomyService:   IAutonomyService,
	) {
		super(ModernisationPart.ID, { hasTitle: false }, themeService, storageService, layoutService);
		this._disposables.add(sessionService.onDidChangeSession(() => this._render()));
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
		return parent;
	}

	// ─── Render dispatcher ───────────────────────────────────────────────────

	private _render(): void {
		while (this._root.firstChild) { this._root.removeChild(this._root.firstChild); }
		const session = this.sessionService.session;

		// Dispose the console when the session is no longer active
		if (!session.isActive && this._console) {
			this._console.dispose();
			this._console = undefined;
		}

		this._root.appendChild(this._buildTopBar(session));
		const body = $e('div', 'flex:1;overflow:hidden;display:flex;flex-direction:column;');
		this._root.appendChild(body);
		if (session.isActive) {
			this._wizardMode = false;
			this._renderActive(body, session);
		} else if (this._wizardMode) {
			this._renderWizard(body);
		} else {
			this._renderIdle(body);
		}
	}

	// ─── Top bar ─────────────────────────────────────────────────────────────

	private _buildTopBar(session: IModernisationSessionData): HTMLElement {
		const bar = $e('div', [
			'display:flex', 'align-items:center', 'gap:12px',
			'height:36px', 'min-height:36px', 'padding:0 16px',
			'background:var(--vscode-titleBar-activeBackground,var(--vscode-sideBarSectionHeader-background))',
			'border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
			'flex-shrink:0',
		].join(';'));

		const brand = $t('span', '\u2297 Neural Inverse  \u00b7  Modernisation Console',
			'color:var(--vscode-titleBar-activeForeground,var(--vscode-foreground));font-weight:700;font-size:12px;letter-spacing:0.04em;flex:1;');
		bar.appendChild(brand);

		if (session.isActive) {
			const stageEl = $t('span', STAGE_LABELS[session.currentStage], [
				'font-size:11px', 'font-weight:600',
				'background:var(--vscode-badge-background)',
				'color:var(--vscode-badge-foreground)',
				'border-radius:3px', 'padding:2px 8px', 'letter-spacing:0.03em',
			].join(';'));
			bar.appendChild(stageEl);

			if (session.migrationPattern) {
				const patternEl = $t('span', MIGRATION_PATTERN_LABELS[session.migrationPattern], [
					'font-size:10px', 'color:var(--vscode-descriptionForeground)',
					'border:1px solid var(--vscode-widget-border)',
					'border-radius:3px', 'padding:1px 7px',
				].join(';'));
				bar.appendChild(patternEl);
			}

			bar.appendChild(this._btn('End Session', false, () => this.sessionService.endSession(),
				'font-size:11px;padding:3px 10px;'));
		}

		bar.appendChild($t('span', 'Cmd+Alt+M', 'color:var(--vscode-descriptionForeground);font-size:10px;opacity:0.5;'));
		return bar;
	}

	// ─── IDLE screen ─────────────────────────────────────────────────────────

	private _renderIdle(root: HTMLElement): void {
		const wrap = $e('div', [
			'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
			'flex:1', 'padding:40px 32px', 'gap:0',
		].join(';'));

		wrap.appendChild($t('div', '\u2297',
			'font-size:52px;color:var(--vscode-descriptionForeground);opacity:0.2;margin-bottom:16px;line-height:1;'));
		wrap.appendChild($t('h2', 'Modernisation Mode',
			'font-size:20px;font-weight:700;color:var(--vscode-editor-foreground);margin:0 0 8px;'));
		wrap.appendChild($t('p', 'Pair a legacy codebase with its modern translation target. Fingerprint, compare, and validate compliance across every migration unit.',
			'font-size:12px;color:var(--vscode-descriptionForeground);text-align:center;max-width:460px;line-height:1.7;margin:0 0 36px;'));

		const createCard = this._idleCard();
		createCard.appendChild($t('div', 'New Modernisation Project',
			'font-size:14px;font-weight:700;color:var(--vscode-editor-foreground);margin-bottom:6px;'));
		createCard.appendChild($t('div', 'Pair a legacy codebase with a modern translation target. Choose your migration architecture pattern and initialise the workspace.',
			'font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.6;margin-bottom:16px;'));
		createCard.appendChild(this._btn('Create Modernisation Project \u2192', true, () => {
			this._wizardMode    = true;
			this._wizardSources = [];
			this._wizardTargets = [];
			this._wizardPattern = undefined;
			this._render();
		}));
		wrap.appendChild(createCard);

		wrap.appendChild($e('div', 'height:12px;'));

		const openCard = this._idleCard();
		openCard.appendChild($t('div', 'Open Existing Project',
			'font-size:14px;font-weight:700;color:var(--vscode-editor-foreground);margin-bottom:6px;'));
		openCard.appendChild($t('div', 'Restore a session from a folder that already contains a Modernisation.inverse file.',
			'font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.6;margin-bottom:16px;'));
		openCard.appendChild(this._btn('Open Existing Project', false, async () => {
			const uris = await this.fileDialogService.showOpenDialog({
				title: 'Open Modernisation Project — select a folder with Modernisation.inverse',
				canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
			});
			if (!uris?.[0]) { return; }
			const ok = await this.sessionService.openExistingProject(uris[0]);
			if (!ok) {
				this._wizardMode    = true;
				this._wizardSources = [{ uri: uris[0], label: this._basename(uris[0].path) }];
				this._wizardTargets = [];
				this._wizardPattern = undefined;
				this._render();
			}
		}));
		wrap.appendChild(openCard);

		root.appendChild(wrap);
	}

	private _idleCard(): HTMLElement {
		return $e('div', [
			'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
			'border-radius:8px', 'padding:20px 22px',
			'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
			'width:100%', 'max-width:500px', 'box-sizing:border-box',
		].join(';'));
	}

	// ─── WIZARD screen ───────────────────────────────────────────────────────

	private _renderWizard(root: HTMLElement): void {
		// Derive topology from selected pattern (if any)
		const preset = MIGRATION_PATTERN_PRESETS.find(p => p.id === this._wizardPattern);
		const topology: IPatternTopology = preset?.topology ?? {
			sourceCount: 'flexible', targetCount: 'flexible',
			sourceLabel: 'Source Project', targetLabel: 'Target Project',
		};

		// Top bar with title + cancel
		const topBar = $e('div', [
			'display:flex', 'align-items:center', 'gap:12px',
			'padding:16px 24px', 'border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
			'flex-shrink:0',
		].join(';'));
		topBar.appendChild($t('h2', 'New Modernisation Project',
			'font-size:15px;font-weight:700;color:var(--vscode-editor-foreground);margin:0;flex:1;'));
		topBar.appendChild(this._btn('Cancel', false, () => { this._wizardMode = false; this._render(); },
			'font-size:11px;padding:4px 12px;'));
		root.appendChild(topBar);

		// Two-panel layout: left = project pickers + note + init, right = pattern picker
		const body = $e('div', 'flex:1;display:flex;overflow:hidden;');
		root.appendChild(body);

		// ── Left panel ────────────────────────────────────────────────────
		const left = $e('div', [
			'width:340px', 'min-width:280px', 'flex-shrink:0',
			'display:flex', 'flex-direction:column', 'gap:10px',
			'padding:20px', 'overflow-y:auto',
			'border-right:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
		].join(';'));

		// Source projects
		left.appendChild($t('div', `Sources \u2014 ${topology.sourceLabel}`,
			'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-descriptionForeground);margin-bottom:2px;'));
		for (let i = 0; i < Math.max(1, this._wizardSources.length); i++) {
			const src = this._wizardSources[i];
			const idx = i;
			left.appendChild(this._folderStep(
				String(i + 1),
				src?.label ?? topology.sourceLabel,
				i === 0 ? 'The existing codebase to be modernised (COBOL, Java EE, PL/SQL, RPG, etc.)' : `Additional ${topology.sourceLabel}`,
				src?.uri,
				`Select ${topology.sourceLabel} Folder`,
				async () => {
					const uris = await this.fileDialogService.showOpenDialog({
						title: `Select ${topology.sourceLabel} Folder`,
						canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
					});
					if (uris?.[0]) {
						const label = this._basename(uris[0].path);
						if (idx < this._wizardSources.length) {
							this._wizardSources[idx] = { uri: uris[0], label };
						} else {
							this._wizardSources.push({ uri: uris[0], label });
						}
						this._render();
					}
				},
				src ? () => { this._wizardSources.splice(idx, 1); this._render(); } : undefined,
			));
		}
		if (topology.sourceCount === 'many' || topology.sourceCount === 'flexible') {
			const addSrc = this._btn(`+ Add ${topology.sourceLabel}`, false, () => {
				this._wizardSources.push({ uri: URI.parse(''), label: '' });
				this._render();
			}, 'font-size:11px;padding:3px 10px;width:100%;text-align:center;margin-top:2px;');
			left.appendChild(addSrc);
		}

		left.appendChild($e('div', 'height:6px;border-bottom:1px solid var(--vscode-widget-border);'));

		// Target projects
		left.appendChild($t('div', `Targets \u2014 ${topology.targetLabel}`,
			'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-descriptionForeground);margin-top:6px;margin-bottom:2px;'));
		for (let i = 0; i < Math.max(1, this._wizardTargets.length); i++) {
			const tgt = this._wizardTargets[i];
			const idx = i;
			left.appendChild(this._folderStep(
				String(i + 1),
				tgt?.label ?? topology.targetLabel,
				i === 0 ? 'New or existing target for the translated code (TypeScript, Java, Python, etc.)' : `Additional ${topology.targetLabel}`,
				tgt?.uri,
				`Select ${topology.targetLabel} Folder`,
				async () => {
					const uris = await this.fileDialogService.showOpenDialog({
						title: `Select ${topology.targetLabel} Folder`,
						canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
					});
					if (uris?.[0]) {
						const label = this._basename(uris[0].path);
						if (idx < this._wizardTargets.length) {
							this._wizardTargets[idx] = { uri: uris[0], label };
						} else {
							this._wizardTargets.push({ uri: uris[0], label });
						}
						this._render();
					}
				},
				tgt ? () => { this._wizardTargets.splice(idx, 1); this._render(); } : undefined,
			));
		}
		if (topology.targetCount === 'many' || topology.targetCount === 'flexible') {
			const addTgt = this._btn(`+ Add ${topology.targetLabel}`, false, () => {
				this._wizardTargets.push({ uri: URI.parse(''), label: '' });
				this._render();
			}, 'font-size:11px;padding:3px 10px;width:100%;text-align:center;margin-top:2px;');
			left.appendChild(addTgt);
		}

		// Modernisation.inverse note
		const note = $e('div', [
			'padding:10px 12px', 'margin-top:8px',
			'background:var(--vscode-input-background)',
			'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
			'border-left:3px solid var(--vscode-button-background)',
			'border-radius:0 4px 4px 0',
		].join(';'));
		note.appendChild($t('div', 'Modernisation.inverse',
			'font-size:10px;font-weight:700;color:var(--vscode-button-background);letter-spacing:0.07em;margin-bottom:4px;'));
		note.appendChild($t('div',
			'Written to every project root. Links all paired projects without modifying source files.',
			'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;'));
		left.appendChild(note);

		// Spacer + init button
		left.appendChild($e('div', 'flex:1;min-height:12px;'));

		const validSources = this._wizardSources.filter(s => s.uri.path);
		const validTargets = this._wizardTargets.filter(t => t.uri.path);
		const canInit = validSources.length > 0 && validTargets.length > 0 && !!this._wizardPattern && !this._wizardBusy;
		const initBtn = this._btn(
			this._wizardBusy ? 'Initialising\u2026' : 'Initialise Project \u2192',
			true,
			async () => {
				if (!canInit) { return; }
				this._wizardBusy = true;
				this._render();
				try {
					await this.sessionService.createProject(
						validSources,
						validTargets,
						this._wizardPattern,
					);
					await this.commandService.executeCommand('neuralInverse.openModernisationSourceWindows');
					await this.commandService.executeCommand('neuralInverse.openModernisationTargetWindows');
				} finally {
					this._wizardBusy = false;
				}
			},
			'width:100%;text-align:center;padding:8px 14px;font-size:13px;',
		);
		if (!canInit) {
			(initBtn as HTMLButtonElement).disabled = true;
			initBtn.style.opacity = '0.4';
			initBtn.style.cursor  = 'not-allowed';
		}
		left.appendChild(initBtn);

		body.appendChild(left);

		// ── Right panel — pattern picker ──────────────────────────────────
		body.appendChild(this._patternPanel(initBtn as HTMLButtonElement));
	}

	private _folderStep(
		num: string, title: string, desc: string,
		selected: URI | undefined, btnLabel: string,
		onPick: () => void,
		onRemove?: () => void,
	): HTMLElement {
		const isDone = !!selected && !!selected.path;
		const card = $e('div', [
			'border-radius:6px', 'overflow:hidden',
			'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
			isDone ? 'border-left:3px solid var(--vscode-terminal-ansiGreen,#4caf50);' : '',
			'background:var(--vscode-input-background)',
		].join(';'));

		// Header
		const hdr = $e('div', [
			'display:flex', 'align-items:center', 'gap:10px',
			'padding:10px 12px',
			'background:var(--vscode-sideBarSectionHeader-background)',
			'border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
		].join(';'));
		const badge = $t('div', isDone ? '\u2713' : num, [
			'width:20px', 'height:20px', 'border-radius:50%', 'flex-shrink:0',
			'font-size:10px', 'font-weight:700',
			'display:flex', 'align-items:center', 'justify-content:center',
			isDone
				? 'background:var(--vscode-terminal-ansiGreen,#4caf50);color:#fff;'
				: 'border:1.5px solid var(--vscode-descriptionForeground);color:var(--vscode-descriptionForeground);',
		].join(';'));
		hdr.appendChild(badge);
		hdr.appendChild($t('span', title, 'font-size:12px;font-weight:600;color:var(--vscode-foreground);flex:1;'));
		if (onRemove) {
			const removeBtn = this._btn('\u00d7', false, onRemove, 'font-size:12px;padding:1px 5px;opacity:0.6;');
			removeBtn.title = 'Remove';
			hdr.appendChild(removeBtn);
		}
		card.appendChild(hdr);

		// Body
		const bodyEl = $e('div', 'padding:10px 12px;');
		bodyEl.appendChild($t('div', desc, 'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;margin-bottom:10px;'));

		if (isDone) {
			const pathRow = $e('div', 'display:flex;align-items:center;gap:8px;');
			const pathEl = $t('div', selected!.fsPath, [
				'flex:1', 'font-size:11px',
				'font-family:var(--vscode-editor-font-family,monospace)',
				'color:var(--vscode-foreground)',
				'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap',
				'background:var(--vscode-editor-background)',
				'padding:4px 8px', 'border-radius:3px',
				'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
			].join(';'));
			pathEl.title = selected!.toString();
			pathRow.appendChild(pathEl);
			pathRow.appendChild(this._btn('Change', false, onPick, 'font-size:11px;padding:3px 8px;flex-shrink:0;'));
			bodyEl.appendChild(pathRow);
		} else {
			bodyEl.appendChild(this._btn(btnLabel, false, onPick, 'width:100%;text-align:center;padding:6px;'));
		}
		card.appendChild(bodyEl);
		return card;
	}

	private _patternPanel(initBtn: HTMLButtonElement): HTMLElement {
		const panel = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;');

		// Panel header
		const hdr = $e('div', [
			'padding:14px 20px 10px',
			'border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
			'flex-shrink:0',
		].join(';'));
		const patternSelected = this._wizardPattern
			? (MIGRATION_PATTERN_LABELS[this._wizardPattern] ?? this._wizardPattern)
			: null;
		hdr.appendChild($t('div', 'Migration Pattern',
			'font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-foreground);margin-bottom:4px;'));
		if (patternSelected) {
			hdr.appendChild($t('div', `\u2713  ${patternSelected}`,
				'font-size:11px;color:var(--vscode-terminal-ansiGreen,#4caf50);'));
		} else {
			hdr.appendChild($t('div', 'Choose a preset or type a custom pattern below.',
				'font-size:11px;color:var(--vscode-descriptionForeground);'));
		}
		panel.appendChild(hdr);

		// Scrollable list
		const list = $e('div', 'flex:1;overflow-y:auto;padding:8px 16px;');

		const categories = [...new Set(MIGRATION_PATTERN_PRESETS.map(p => p.category))];
		for (const cat of categories) {
			list.appendChild($t('div', cat, [
				'font-size:10px', 'font-weight:700', 'text-transform:uppercase',
				'letter-spacing:0.07em', 'color:var(--vscode-descriptionForeground)',
				'margin:12px 0 4px', 'padding:0 2px',
			].join(';')));

			for (const preset of MIGRATION_PATTERN_PRESETS.filter(p => p.category === cat)) {
				const isSelected = this._wizardPattern === preset.id;
				const row = $e('div', [
					'display:flex', 'align-items:flex-start', 'gap:10px',
					'padding:7px 10px', 'border-radius:4px', 'cursor:pointer',
					'border:1px solid transparent',
					isSelected
						? 'background:var(--vscode-list-activeSelectionBackground);border-color:var(--vscode-focusBorder,transparent);'
						: '',
				].join(';'));

				const dot = $e('div', [
					'width:13px', 'height:13px', 'border-radius:50%', 'flex-shrink:0', 'margin-top:3px',
					'border:1.5px solid var(--vscode-descriptionForeground)',
					isSelected ? 'background:var(--vscode-button-background);border-color:var(--vscode-button-background);' : '',
				].join(';'));
				row.appendChild(dot);

				const txt = $e('div', 'flex:1;min-width:0;');
				txt.appendChild($t('div', MIGRATION_PATTERN_LABELS[preset.id], [
					'font-size:12px', 'font-weight:600', 'margin-bottom:1px',
					`color:${isSelected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)'}`,
				].join(';')));
				txt.appendChild($t('div', MIGRATION_PATTERN_DESCRIPTIONS[preset.id], [
					'font-size:10px', 'line-height:1.4',
					`color:${isSelected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-descriptionForeground)'}`,
				].join(';')));
				row.appendChild(txt);

				row.addEventListener('click', () => { this._wizardPattern = preset.id; this._render(); });
				row.addEventListener('mouseenter', () => { if (!isSelected) { row.style.background = 'var(--vscode-list-hoverBackground)'; } });
				row.addEventListener('mouseleave', () => { if (!isSelected) { row.style.background = 'transparent'; } });
				list.appendChild(row);
			}
		}
		panel.appendChild(list);

		// Custom / universal text input — fixed at bottom
		const customBar = $e('div', [
			'flex-shrink:0', 'padding:12px 16px',
			'border-top:1px solid var(--vscode-panel-border,var(--vscode-widget-border))',
			'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
		].join(';'));
		customBar.appendChild($t('div', 'Or define your own pattern:',
			'font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:6px;'));
		const inputRow = $e('div', 'display:flex;gap:8px;align-items:center;');
		const customInput = $e('input', [
			'flex:1', 'padding:5px 10px',
			'background:var(--vscode-input-background)',
			'color:var(--vscode-input-foreground)',
			'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
			'border-radius:3px', 'font-size:12px', 'font-family:inherit',
		].join(';'));
		(customInput as HTMLInputElement).placeholder = 'e.g. PL/1 → Node.js, EJB consolidation…';
		// Pre-fill if the current pattern is not a preset
		const isCustom = this._wizardPattern && !MIGRATION_PATTERN_PRESETS.find(p => p.id === this._wizardPattern);
		if (isCustom) { (customInput as HTMLInputElement).value = this._wizardPattern!; }
		customInput.addEventListener('input', () => {
			const val = (customInput as HTMLInputElement).value.trim();
			this._wizardPattern = val || undefined;
			// Update the header without a full re-render (avoid losing focus)
			const tick = hdr.children[1] as HTMLElement | undefined;
			if (tick) {
				tick.textContent = val ? `\u2713  ${val}` : 'Choose a preset or type a custom pattern below.';
				tick.style.color = val ? 'var(--vscode-terminal-ansiGreen,#4caf50)' : 'var(--vscode-descriptionForeground)';
			}
			// Deselect any preset radio dots
			const allDots = list.querySelectorAll<HTMLElement>('div[style*="border-radius:50%"]');
			allDots.forEach(d => {
				d.style.background = '';
				d.style.borderColor = 'var(--vscode-descriptionForeground)';
			});
			// Update init button state
			const canNow = this._wizardSources.some(s => s.uri.path) && this._wizardTargets.some(t => t.uri.path) && !!val;
			(initBtn as HTMLButtonElement).disabled = !canNow;
			initBtn.style.opacity = canNow ? '1' : '0.4';
			initBtn.style.cursor  = canNow ? 'pointer' : 'not-allowed';
		});
		inputRow.appendChild(customInput);
		customBar.appendChild(inputRow);
		panel.appendChild(customBar);

		return panel;
	}

	// ─── ACTIVE screen ───────────────────────────────────────────────────────

	private _renderActive(root: HTMLElement, session: IModernisationSessionData): void {
		const layout = $e('div', 'flex:1;display:flex;overflow:hidden;');
		root.appendChild(layout);
		layout.appendChild(this._buildWorkflowPanel(session));
		layout.appendChild($e('div', 'width:1px;background:var(--vscode-panel-border,var(--vscode-widget-border));flex-shrink:0;'));
		layout.appendChild(this._buildCompliancePanel(session));
	}

	// Left panel: project info + pattern + workflow + config
	private _buildWorkflowPanel(session: IModernisationSessionData): HTMLElement {
		const panel = $e('div', 'width:300px;min-width:280px;flex-shrink:0;display:flex;flex-direction:column;overflow-y:auto;background:var(--vscode-sideBar-background,var(--vscode-editor-background));');

		// Project section — sources + targets
		const projSec = this._section('Projects');
		for (const pt of session.sources) {
			projSec.appendChild(this._projectRow('SRC', pt, 'neuralInverse.openModernisationSourceWindows'));
		}
		for (const pt of session.targets) {
			projSec.appendChild(this._projectRow('TGT', pt, 'neuralInverse.openModernisationTargetWindows'));
		}
		const inv = $e('div', 'display:flex;align-items:center;gap:6px;margin-top:4px;');
		inv.appendChild($t('span', '\u25cf', 'color:var(--vscode-activityBarBadge-background,var(--vscode-button-background));font-size:8px;'));
		inv.appendChild($t('span', 'Modernisation.inverse  paired',
			'font-size:10px;color:var(--vscode-descriptionForeground);'));
		projSec.appendChild(inv);
		panel.appendChild(projSec);

		// Migration pattern section
		if (session.migrationPattern) {
			const patSec = this._section('Migration Pattern');
			const tile = $e('div', 'padding:8px 10px;border-radius:4px;background:var(--vscode-input-background);border:1px solid var(--vscode-widget-border);');
			tile.appendChild($t('div', MIGRATION_PATTERN_LABELS[session.migrationPattern],
				'font-size:12px;font-weight:600;color:var(--vscode-editor-foreground);margin-bottom:3px;'));
			tile.appendChild($t('div', MIGRATION_PATTERN_DESCRIPTIONS[session.migrationPattern],
				'font-size:10px;color:var(--vscode-descriptionForeground);line-height:1.4;'));

			const changeBtn = this._btn('Change Pattern', false, () => {
				// Re-enter wizard with current projects pre-filled
				this._wizardMode    = true;
				this._wizardSources = session.sources.map(s => ({ uri: URI.parse(s.folderUri), label: s.label }));
				this._wizardTargets = session.targets.map(t => ({ uri: URI.parse(t.folderUri), label: t.label }));
				this._wizardPattern = session.migrationPattern;
				this.sessionService.endSession();
			}, 'font-size:10px;padding:3px 8px;margin-top:8px;');
			tile.appendChild(changeBtn);
			patSec.appendChild(tile);
			panel.appendChild(patSec);
		}

		// Workflow stages
		const wfSec = this._section('Workflow');
		const currentIdx = STAGES.indexOf(session.currentStage);

		for (const stage of STAGES) {
			const idx   = STAGES.indexOf(stage);
			const isCur = idx === currentIdx;
			const isDone = idx < currentIdx;
			// Stage 3 locked unless plan approved
			const isLocked = stage === 'migration' && !session.planApproved && currentIdx <= STAGES.indexOf('planning');

			const row = $e('div', [
				'display:flex', 'align-items:flex-start', 'gap:10px',
				'padding:8px 10px', 'border-radius:4px', 'margin-bottom:2px',
				isLocked ? 'cursor:default;opacity:0.45;' : 'cursor:pointer;',
				isCur
					? 'background:var(--vscode-list-activeSelectionBackground);border:1px solid var(--vscode-focusBorder,transparent);'
					: 'border:1px solid transparent;',
			].join(';'));

			const dot = $t('div', isDone ? '\u2713' : isLocked ? '\u{1F512}' : String(idx + 1), [
				'width:18px', 'height:18px', 'border-radius:50%', 'flex-shrink:0', 'margin-top:1px',
				'font-size:9px', 'font-weight:700',
				'display:flex', 'align-items:center', 'justify-content:center',
				isDone
					? 'background:var(--vscode-terminal-ansiGreen,#4caf50);color:var(--vscode-editor-background);'
					: isCur
						? 'background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground);border:1.5px solid var(--vscode-focusBorder,var(--vscode-button-background));'
						: 'border:1.5px solid var(--vscode-descriptionForeground);color:var(--vscode-descriptionForeground);',
			].join(';'));
			row.appendChild(dot);

			const info = $e('div', 'flex:1;min-width:0;');
			info.appendChild($t('div', STAGE_LABELS[stage], [
				'font-size:12px',
				`font-weight:${isCur ? '600' : '400'}`,
				`color:${isCur ? 'var(--vscode-list-activeSelectionForeground)' : isDone ? 'var(--vscode-editor-foreground)' : 'var(--vscode-descriptionForeground)'}`,
			].join(';')));
			if (isCur) {
				info.appendChild($t('div', STAGE_DESCRIPTIONS[stage],
					'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:3px;line-height:1.4;'));
			}
			if (isLocked) {
				info.appendChild($t('div', 'Requires plan approval',
					'font-size:10px;color:var(--vscode-inputValidation-warningBorder,#e0a84e);margin-top:2px;'));
			}
			row.appendChild(info);

			if (!isLocked) {
				row.addEventListener('click', () => this.sessionService.setStage(stage));
				row.addEventListener('mouseenter', () => { if (!isCur) { row.style.background = 'var(--vscode-list-hoverBackground)'; } });
				row.addEventListener('mouseleave', () => { if (!isCur) { row.style.background = 'transparent'; } });
			}
			wfSec.appendChild(row);
		}

		// Advance button (only if next stage is not locked)
		if (currentIdx < STAGES.length - 1) {
			const nextStage  = STAGES[currentIdx + 1];
			const nextLocked = nextStage === 'migration' && !session.planApproved;
			if (!nextLocked) {
				const advWrap = $e('div', 'margin-top:8px;');
				advWrap.appendChild(this._btn(
					`Advance to ${STAGE_LABELS[nextStage]} \u2192`, false,
					() => this.sessionService.setStage(nextStage),
				));
				wfSec.appendChild(advWrap);
			}
		}
		panel.appendChild(wfSec);

		// Session configuration — always visible at bottom of sidebar
		panel.appendChild($e('div', 'height:8px;border-top:1px solid var(--vscode-widget-border);margin-top:4px;'));
		panel.appendChild(this._buildConfigPanel(session));

		return panel;
	}

	// Right panel: stage-appropriate content
	private _buildCompliancePanel(session: IModernisationSessionData): HTMLElement {
		const panel = $e('div', 'flex:1;display:flex;flex-direction:column;overflow:hidden;');

		if (session.currentStage === 'discovery') {
			panel.appendChild(this._buildDiscoveryPane(session));
		} else if (session.currentStage === 'planning') {
			panel.appendChild(this._buildPlanningPane(session));
		} else if (session.currentStage === 'migration') {
			panel.appendChild(this._buildMigrationPane(session));
		} else if (session.currentStage === 'validation') {
			panel.appendChild(this._buildValidationPane(session));
		} else if (session.currentStage === 'cutover') {
			panel.appendChild(this._buildCutoverPane(session));
		} else {
			// Fallback — should never reach here with a valid stage
			panel.appendChild(this._buildFilePickers(session));
			panel.appendChild(this._buildAnalyseRow());
			this._resultsEl = $e('div', 'flex:1;overflow-y:auto;padding:20px;');
			const hasFiles = session.activeSourceFileUri && session.activeTargetFileUri;
			this._resultsEl.appendChild($t('div',
				hasFiles ? 'Ready \u2014 click Analyse Compliance to run.' : 'Pick a file from each project then click Analyse Compliance.',
				'color:var(--vscode-descriptionForeground);font-style:italic;'));
			panel.appendChild(this._resultsEl);
		}

		return panel;
	}

	// ─── Discovery pane (Stage 1) ─────────────────────────────────────────────

	private _buildDiscoveryPane(session: IModernisationSessionData): HTMLElement {
		const pane = $e('div', 'flex:1;overflow-y:auto;padding:24px 28px;');

		pane.appendChild($t('h3', 'Codebase Discovery',
			'font-size:15px;font-weight:700;color:var(--vscode-editor-foreground);margin:0 0 4px;'));
		pane.appendChild($t('p',
			'Scan all source and target projects to extract migration units, build dependency graphs, detect regulated data, and assess technical complexity before planning.',
			'font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.6;margin:0 0 20px;'));

		// Run button row
		const ctrlRow = $e('div', 'display:flex;align-items:center;gap:10px;margin-bottom:20px;flex-wrap:wrap;');
		const runBtn = this._btn(
			this._discoveryRunning
				? 'Scanning\u2026'
				: this._discoveryResult ? '\u21ba Re-run Discovery' : '\u25b6 Run Discovery Scan',
			!this._discoveryResult,
			async () => { await this._runDiscoveryScan(session); },
			'white-space:nowrap;',
		);
		if (this._discoveryRunning) {
			(runBtn as HTMLButtonElement).disabled = true;
			runBtn.style.opacity = '0.5';
			runBtn.style.cursor  = 'not-allowed';
		}
		ctrlRow.appendChild(runBtn);
		if (this._discoveryResult && !this._discoveryRunning) {
			ctrlRow.appendChild(this._btn('Advance to Planning \u2192', true,
				() => this.sessionService.setStage('planning'),
				'white-space:nowrap;'));
		}
		pane.appendChild(ctrlRow);

		// Progress log
		if (this._discoveryRunning || this._discoveryLog.length > 0) {
			const logWrap = $e('div', [
				'border:1px solid var(--vscode-widget-border)',
				'border-radius:5px', 'overflow:hidden', 'margin-bottom:20px',
			].join(';'));
			const logHdr = $e('div', [
				'padding:6px 12px',
				'background:var(--vscode-sideBarSectionHeader-background)',
				'border-bottom:1px solid var(--vscode-panel-border)',
				'display:flex', 'align-items:center', 'gap:8px',
			].join(';'));
			if (this._discoveryRunning) {
				logHdr.appendChild($t('span', '\u25cf', 'color:var(--vscode-terminal-ansiGreen,#4caf50);font-size:10px;'));
			}
			logHdr.appendChild($t('span', 'Scan Progress',
				'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-sideBarSectionHeader-foreground);'));
			logWrap.appendChild(logHdr);
			this._discoveryLogEl = $e('div', [
				'padding:10px 12px', 'font-family:var(--vscode-editor-font-family,monospace)',
				'font-size:11px', 'line-height:1.7',
				'color:var(--vscode-descriptionForeground)',
				'max-height:160px', 'overflow-y:auto',
			].join(';'));
			for (const line of this._discoveryLog) {
				this._discoveryLogEl.appendChild($t('div', line));
			}
			logWrap.appendChild(this._discoveryLogEl);
			pane.appendChild(logWrap);
		}

		// Results
		if (this._discoveryResult) {
			const r = this._discoveryResult;
			const allProjects     = [...r.sources, ...r.targets];
			const scannedProjects = allProjects.filter(p => p.fileCount > 0 || p.units.length > 0);
			const totalUnits   = allProjects.reduce((n, p) => n + p.units.length, 0);
			const totalFiles   = allProjects.reduce((n, p) => n + p.fileCount, 0);
			const totalHits    = allProjects.reduce((n, p) => n + p.regulatedDataHits.length, 0);
			const totalViol    = allProjects.reduce((n, p) => n + (p.grcSnapshot.violations?.length ?? 0), 0);
			const elapsedSec   = (r.totalElapsedMs / 1000).toFixed(1);

			// Summary bar
			const bar = $e('div', [
				'display:flex', 'flex-wrap:wrap', 'gap:10px',
				'padding:14px 16px', 'border-radius:6px', 'margin-bottom:16px',
				'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
				'border:1px solid var(--vscode-widget-border)',
			].join(';'));
			const stat = (label: string, value: string, accent?: string) => {
				const cell = $e('div', 'text-align:center;min-width:80px;');
				cell.appendChild($t('div', value, `font-size:22px;font-weight:700;line-height:1;color:${accent ?? 'var(--vscode-editor-foreground)'};`));
				cell.appendChild($t('div', label, 'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:3px;'));
				return cell;
			};
			bar.appendChild(stat('Files', String(totalFiles)));
			bar.appendChild(this._divider());
			bar.appendChild(stat('Units', String(totalUnits)));
			bar.appendChild(this._divider());
			bar.appendChild(stat('Regulated Data', String(totalHits),
				totalHits > 0 ? 'var(--vscode-inputValidation-warningBorder,#e0a84e)' : undefined));
			bar.appendChild(this._divider());
			bar.appendChild(stat('GRC Violations', String(totalViol),
				totalViol > 0 ? 'var(--vscode-inputValidation-errorBorder,#f44336)' : undefined));
			bar.appendChild(this._divider());
			bar.appendChild(stat('Scan Time', `${elapsedSec}s`));
			pane.appendChild(bar);

			// Per-project cards
			const projWrap = $e('div', [
				'border:1px solid var(--vscode-widget-border)',
				'border-radius:6px', 'overflow:hidden',
			].join(';'));
			const projHdr = $e('div', [
				'padding:8px 13px',
				'background:var(--vscode-sideBarSectionHeader-background)',
				'border-bottom:1px solid var(--vscode-panel-border)',
			].join(';'));
			projHdr.appendChild($t('span', 'Projects Scanned',
				'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-sideBarSectionHeader-foreground);'));
			projWrap.appendChild(projHdr);

			const projBody = $e('div', 'padding:8px 12px;display:flex;flex-direction:column;gap:8px;');
			for (const proj of allProjects) {
				const isNewProject = proj.fileCount === 0 && proj.units.length === 0;
				const isTarget = r.targets.includes(proj);
				const card = $e('div', [
					'padding:10px 12px', 'border-radius:4px',
					isNewProject
						? 'background:var(--vscode-editor-background);border:1px dashed var(--vscode-widget-border);opacity:0.75;'
						: 'background:var(--vscode-input-background);border:1px solid var(--vscode-widget-border);',
				].join(';'));
				const cardTop = $e('div', 'display:flex;align-items:center;gap:8px;margin-bottom:6px;');
				const roleBadge = $t('span', isTarget ? 'TGT' : 'SRC', [
					'font-size:9px', 'font-weight:700', 'letter-spacing:0.06em',
					'background:var(--vscode-badge-background)',
					'color:var(--vscode-badge-foreground)',
					'border-radius:2px', 'padding:1px 5px', 'flex-shrink:0',
				].join(';'));
				cardTop.appendChild(roleBadge);
				cardTop.appendChild($t('span', proj.projectLabel,
					'font-size:12px;font-weight:600;color:var(--vscode-editor-foreground);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
				const langLabel = isNewProject ? 'New Project' : proj.dominantLanguage.toUpperCase();
				cardTop.appendChild($t('span', langLabel,
					'font-size:10px;color:var(--vscode-descriptionForeground);'));
				card.appendChild(cardTop);

				const chips = $e('div', 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;');
				const chip = (label: string, accent?: string) => $t('span', label, [
					'font-size:10px', 'padding:2px 7px', 'border-radius:10px',
					`background:${accent ? accent + '22' : 'var(--vscode-badge-background)'}`,
					`color:${accent ?? 'var(--vscode-badge-foreground)'}`,
					`border:1px solid ${accent ? accent + '55' : 'transparent'}`,
				].join(';'));

				if (isNewProject) {
					// Empty target — will be created during migration
					chips.appendChild($t('span',
						isTarget
							? '\u2014 Empty target directory. Will be populated during migration.'
							: '\u2014 Empty source directory.',
						'font-size:10px;color:var(--vscode-descriptionForeground);font-style:italic;'));
				} else {
					chips.appendChild(chip(`${proj.fileCount} files`));
					chips.appendChild(chip(`${proj.units.length} units`));
					if (proj.stats.totalUnitsExtracted > 0) {
						chips.appendChild(chip(`${proj.stats.criticalUnitCount} critical`, proj.stats.criticalUnitCount > 0 ? '#f44336' : undefined));
					}
					if (proj.regulatedDataHits.length > 0) {
						chips.appendChild(chip(`${proj.regulatedDataHits.length} regulated data hits`, '#e0a84e'));
					}
					if (proj.metadata.buildSystem) {
						chips.appendChild(chip(proj.metadata.buildSystem));
					}
				}
				card.appendChild(chips);
				projBody.appendChild(card);
			}
			projWrap.appendChild(projBody);
			pane.appendChild(projWrap);
			pane.appendChild($e('div', 'height:16px;'));

			// Advance banner
			const advBanner = $e('div', [
				'padding:14px 16px', 'border-radius:6px',
				'background:var(--vscode-inputValidation-infoBackground,rgba(100,150,250,0.07))',
				'border:1px solid var(--vscode-focusBorder,rgba(100,150,250,0.4))',
				'display:flex', 'align-items:center', 'gap:16px',
			].join(';'));
			const advText = $e('div', 'flex:1;');
			advText.appendChild($t('div', '\u2713  Discovery Complete',
				'font-size:13px;font-weight:700;color:var(--vscode-focusBorder,#6496fa);margin-bottom:4px;'));
			advText.appendChild($t('div',
				`Found ${totalUnits} migration units across ${scannedProjects.length} scanned project(s)${scannedProjects.length < allProjects.length ? ` (${allProjects.length - scannedProjects.length} new/empty target project(s) will be created during migration)` : ''}. Proceed to Planning to generate the AI-refined migration roadmap.`,
				'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;'));
			advBanner.appendChild(advText);
			advBanner.appendChild(this._btn('Go to Planning \u2192', true,
				() => this.sessionService.setStage('planning'),
				'white-space:nowrap;flex-shrink:0;padding:7px 16px;font-size:13px;'));
			pane.appendChild(advBanner);
			pane.appendChild($e('div', 'height:20px;'));
		} else if (!this._discoveryRunning) {
			// Empty state
			const empty = $e('div', [
				'border:1px dashed var(--vscode-widget-border)',
				'border-radius:6px', 'padding:40px 20px', 'text-align:center',
			].join(';'));
			empty.appendChild($t('div', '\u{1F50D}', 'font-size:36px;margin-bottom:12px;opacity:0.25;'));
			empty.appendChild($t('div', 'No scan results yet.',
				'font-size:13px;font-weight:600;color:var(--vscode-editor-foreground);margin-bottom:6px;'));
			empty.appendChild($t('div',
				'Click "Run Discovery Scan" to analyse all source and target projects. Results will guide the AI migration planner in Stage 2.',
				'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.6;max-width:400px;margin:0 auto;'));
			pane.appendChild(empty);
		}

		return pane;
	}

	private async _runDiscoveryScan(session: IModernisationSessionData): Promise<void> {
		if (this._discoveryRunning) { return; }
		this._discoveryRunning = true;
		this._discoveryLog     = [];
		this._discoveryResult  = undefined;
		this._render();

		const log = (msg: string) => {
			this._discoveryLog.push(msg);
			if (this._discoveryLogEl) {
				this._discoveryLogEl.appendChild($t('div', msg));
				this._discoveryLogEl.scrollTop = this._discoveryLogEl.scrollHeight;
			}
		};

		try {
			const sub = this.discoveryService.onDidProgress(e => {
				log(`${e.phase}${e.currentFile ? ' \u2014 ' + e.currentFile : ''}${e.projectLabel ? ' (' + e.projectLabel + ')' : ''}`);
			});
			log('Starting discovery scan\u2026');
			const result = await this.discoveryService.scan(session.sources, session.targets);
			sub.dispose();
			const totalUnits = [...result.sources, ...result.targets].reduce((n, p) => n + p.units.length, 0);
			log(`\u2713 Scan complete \u2014 ${totalUnits} units in ${(result.totalElapsedMs / 1000).toFixed(1)}s`);
			this._discoveryResult = result;
		} catch (err) {
			log(`\u2717 Error: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this._discoveryRunning = false;
			this._render();
		}
	}

	// ─── Planning pane ───────────────────────────────────────────────────────

	private _buildPlanningPane(session: IModernisationSessionData): HTMLElement {
		const pane = $e('div', 'flex:1;overflow-y:auto;padding:24px 28px;');

		// Title
		pane.appendChild($t('h3', 'Migration Planning Workspace',
			'font-size:15px;font-weight:700;color:var(--vscode-editor-foreground);margin:0 0 4px;'));
		pane.appendChild($t('p',
			'Scan the legacy codebase, generate an AI-refined migration roadmap, review every phase and blocker, then approve to unlock Stage 3.',
			'font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.6;margin:0 0 20px;'));

		// ── Run / regenerate button ───────────────────────────────────────
		const hasStage1 = !!this._discoveryResult;
		const ctrlRow = $e('div', 'display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap;');
		const runBtn = this._btn(
			this._plannerRunning
				? 'Generating\u2026'
				: this._roadmap
					? '\u21ba Regenerate Roadmap'
					: hasStage1
						? '\u25b6 Generate Roadmap'
						: '\u25b6 Run Discovery + Generate Roadmap',
			!this._roadmap,
			async () => { await this._runDiscoveryAndPlan(session, hasStage1 && !this._roadmap); },
			'white-space:nowrap;',
		);
		if (this._plannerRunning) {
			(runBtn as HTMLButtonElement).disabled = true;
			runBtn.style.opacity = '0.5';
			runBtn.style.cursor  = 'not-allowed';
		}
		ctrlRow.appendChild(runBtn);

		if (this._roadmap) {
			const methodBadge = $t('span',
				this._roadmap.generationMethod === 'ai-guided' ? '\u2728 AI-guided' : '\u2699 Deterministic',
				[
					'font-size:10px', 'border-radius:3px', 'padding:2px 8px',
					'border:1px solid var(--vscode-widget-border)',
					'color:var(--vscode-descriptionForeground)',
				].join(';'));
			ctrlRow.appendChild(methodBadge);
		}
		pane.appendChild(ctrlRow);

		// Stage 1 hint row
		if (!this._plannerRunning && !this._roadmap) {
			const hintRow = $e('div', 'display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap;');
			if (hasStage1) {
				const totalUnits = [...this._discoveryResult!.sources, ...this._discoveryResult!.targets]
					.reduce((n, p) => n + p.units.length, 0);
				hintRow.appendChild($t('span',
					`\u2713 Using Stage 1 results \u2014 ${totalUnits} units`,
					'font-size:10px;color:var(--vscode-terminal-ansiGreen,#4caf50);'));
				hintRow.appendChild(this._btn('Re-run with fresh discovery', false,
					async () => { await this._runDiscoveryAndPlan(session, false); },
					'font-size:10px;padding:2px 8px;opacity:0.7;'));
			} else {
				hintRow.appendChild($t('span',
					'Tip: complete Stage 1 Discovery first to speed this up.',
					'font-size:10px;color:var(--vscode-descriptionForeground);font-style:italic;'));
			}
			pane.appendChild(hintRow);
		} else {
			pane.appendChild($e('div', 'height:12px;'));
		}

		// ── Progress log (visible while running, or if log has entries) ──
		if (this._plannerRunning || this._plannerLog.length > 0) {
			const logWrap = $e('div', [
				'border:1px solid var(--vscode-widget-border)',
				'border-radius:5px', 'overflow:hidden', 'margin-bottom:20px',
			].join(';'));
			const logHdr = $e('div', [
				'padding:6px 12px',
				'background:var(--vscode-sideBarSectionHeader-background)',
				'border-bottom:1px solid var(--vscode-panel-border)',
				'display:flex', 'align-items:center', 'gap:8px',
			].join(';'));
			if (this._plannerRunning) {
				logHdr.appendChild($t('span', '\u25cf', 'color:var(--vscode-terminal-ansiGreen,#4caf50);font-size:10px;'));
			}
			logHdr.appendChild($t('span', 'Progress',
				'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-sideBarSectionHeader-foreground);'));
			logWrap.appendChild(logHdr);

			this._plannerLogEl = $e('div', [
				'padding:10px 12px', 'font-family:var(--vscode-editor-font-family,monospace)',
				'font-size:11px', 'line-height:1.7',
				'color:var(--vscode-descriptionForeground)',
				'max-height:160px', 'overflow-y:auto',
			].join(';'));
			for (const line of this._plannerLog) {
				this._plannerLogEl.appendChild($t('div', line));
			}
			logWrap.appendChild(this._plannerLogEl);
			pane.appendChild(logWrap);
		}

		// ── Roadmap content ───────────────────────────────────────────────
		if (this._roadmap) {
			// Summary stats bar
			pane.appendChild(this._buildRoadmapSummary(this._roadmap));
			pane.appendChild($e('div', 'height:16px;'));

			// Phases
			if (this._roadmap.phases && this._roadmap.phases.length > 0) {
				pane.appendChild(this._buildSection('Migration Phases', this._buildPhasesView(this._roadmap)));
				pane.appendChild($e('div', 'height:16px;'));
			}

			// Critical path
			if (this._roadmap.criticalPath && this._roadmap.criticalPath.length > 0) {
				pane.appendChild(this._buildSection('Critical Path', this._buildCriticalPathView(this._roadmap)));
				pane.appendChild($e('div', 'height:16px;'));
			}

			// Blockers
			if (this._roadmap.migrationBlockers && this._roadmap.migrationBlockers.length > 0) {
				pane.appendChild(this._buildSection('Migration Blockers', this._buildBlockersView(this._roadmap)));
				pane.appendChild($e('div', 'height:16px;'));
			}

			// AI notes
			if (this._roadmap.complianceNotes || this._roadmap.riskNarrative) {
				pane.appendChild(this._buildSection('AI Analysis Notes', this._buildAINotes(this._roadmap)));
				pane.appendChild($e('div', 'height:16px;'));
			}

			// Approve gate (or approved state)
			pane.appendChild(this._buildApprovalGate(session));
			pane.appendChild($e('div', 'height:20px;'));
		} else if (!this._plannerRunning) {
			// Empty state
			const empty = $e('div', [
				'border:1px dashed var(--vscode-widget-border)',
				'border-radius:6px', 'padding:40px 20px', 'text-align:center',
			].join(';'));
			empty.appendChild($t('div', '\u{1F5FA}', 'font-size:36px;margin-bottom:12px;opacity:0.25;'));
			empty.appendChild($t('div', 'No roadmap yet.',
				'font-size:13px;font-weight:600;color:var(--vscode-editor-foreground);margin-bottom:6px;'));
			empty.appendChild($t('div',
				'Click "Run Discovery + Generate Roadmap" above. The discovery engine will scan all source and target projects, then the AI planner will produce a structured migration roadmap for your review.',
				'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.6;max-width:400px;margin:0 auto;'));
			pane.appendChild(empty);
			pane.appendChild($e('div', 'height:20px;'));
		}

		return pane;
	}

	private async _runDiscoveryAndPlan(session: IModernisationSessionData, useExistingDiscovery = false): Promise<void> {
		if (this._plannerRunning) { return; }
		this._plannerRunning = true;
		this._plannerLog     = [];
		this._roadmap        = undefined;
		this._reRenderPlanningPane(session);

		const log = (msg: string) => {
			this._plannerLog.push(msg);
			if (this._plannerLogEl) {
				this._plannerLogEl.appendChild($t('div', msg));
				this._plannerLogEl.scrollTop = this._plannerLogEl.scrollHeight;
			}
		};

		try {
			let discovery = useExistingDiscovery && this._discoveryResult ? this._discoveryResult : undefined;

			if (discovery) {
				const totalUnits = [...discovery.sources, ...discovery.targets].reduce((n, p) => n + p.units.length, 0);
				log(`Using Stage 1 discovery results \u2014 ${totalUnits} units across ${discovery.sources.length + discovery.targets.length} project(s).`);
			} else {
				// Run discovery from scratch
				const discSub = this.discoveryService.onDidProgress(e => {
					log(`[discovery] ${e.phase}${e.currentFile ? ' \u2014 ' + e.currentFile : ''}${e.projectLabel ? ' (' + e.projectLabel + ')' : ''}`);
				});
				log('Running discovery\u2026');
				discovery = await this.discoveryService.scan(session.sources, session.targets);
				discSub.dispose();
				// Cache for future use from Stage 2
				this._discoveryResult = discovery;
				const totalUnits = discovery.sources.reduce((n, s) => n + s.units.length, 0);
				log(`Discovery complete: ${discovery.sources.length} source project(s), ${totalUnits} units found.`);
			}

			// Planner progress
			const planSub = this.plannerService.onDidProgress(msg => log(`[planner] ${msg}`));
			log('Generating migration roadmap\u2026');
			const roadmap = await this.plannerService.generateRoadmap(
				discovery,
				session.migrationPattern ?? 'custom',
				session.sources[0]?.id ?? 'session',
			);
			planSub.dispose();

			this._roadmap = roadmap;
			log(`\u2713 Roadmap complete \u2014 ${roadmap.totalUnits} units, ${roadmap.phases?.length ?? 0} phases.`);
		} catch (err) {
			log(`\u2717 Error: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this._plannerRunning = false;
			this._reRenderPlanningPane(session);
		}
	}

	/** Re-render only the right-panel pane without a full root re-render (avoids flicker). */
	private _reRenderPlanningPane(session: IModernisationSessionData): void {
		// Full re-render is safe here — the planning pane is stateful via class fields
		this._render();
	}

	// ─── Stage 3 + 4: Migration & Validation (parallel progress dashboard) ──────

	private _buildMigrationPane(session: IModernisationSessionData): HTMLElement {
		return this._buildMigrationValidationDashboard(session, 'migration');
	}

	private _buildValidationPane(session: IModernisationSessionData): HTMLElement {
		return this._buildMigrationValidationDashboard(session, 'validation');
	}

	/**
	 * Shared dashboard shown for both Stage 3 and Stage 4.
	 * Renders the 4-tab ModernisationConsole (Unit Index, Pending Decisions,
	 * Decision Log, Progress) — or a plan-not-approved guard if needed.
	 */
	private _buildMigrationValidationDashboard(session: IModernisationSessionData, _activeView: 'migration' | 'validation'): HTMLElement {
		const pane = $e('div', 'flex:1;overflow:hidden;display:flex;flex-direction:column;');

		// ── Plan not approved guard ───────────────────────────────────────
		if (!session.planApproved) {
			const warn = $e('div', [
				'padding:14px 16px', 'border-radius:6px',
				'background:var(--vscode-inputValidation-warningBackground,rgba(224,168,78,0.07))',
				'border:1px solid var(--vscode-inputValidation-warningBorder,rgba(224,168,78,0.4))',
				'display:flex', 'align-items:center', 'gap:12px',
			].join(';'));
			warn.appendChild($t('span', '\u26a0', 'font-size:18px;color:#e0a84e;flex-shrink:0;'));
			const warnText = $e('div', 'flex:1;');
			warnText.appendChild($t('div', 'Migration is locked',
				'font-size:13px;font-weight:700;color:#e0a84e;margin-bottom:3px;'));
			warnText.appendChild($t('div', 'Approve the migration plan in Stage 2 to unlock this stage.',
				'font-size:11px;color:var(--vscode-descriptionForeground);'));
			warn.appendChild(warnText);
			warn.appendChild(this._btn('Go to Planning \u2192', false,
				() => this.sessionService.setStage('planning'),
				'white-space:nowrap;flex-shrink:0;padding:6px 14px;font-size:12px;'));
			pane.appendChild(warn);
			return pane;
		}

		// ── 4-tab Modernisation Console ──────────────────────────────────
		// Create once and reuse across re-renders to preserve filter/tab state
		if (!this._console) {
			this._console = new ModernisationConsole(this.kbService, this.agentToolsService, this.validationService, this.cutoverService, this.autonomyService);
		}
		pane.appendChild(this._console.domNode);
		return pane;

	}

	// ─── Stage 5: Cutover pane ───────────────────────────────────────────────

	private _buildCutoverPane(_session: IModernisationSessionData): HTMLElement {
		const pane = $e('div', 'flex:1;overflow-y:auto;padding:24px 28px;');

		pane.appendChild($t('h3', 'Cutover',
			'font-size:15px;font-weight:700;color:var(--vscode-editor-foreground);margin:0 0 4px;'));
		pane.appendChild($t('p',
			'Final steps to switch production traffic to the modernised system. Complete each item before ending the session.',
			'font-size:12px;color:var(--vscode-descriptionForeground);line-height:1.6;margin:0 0 20px;'));

		const items = [
			'All migration units marked pass or warning-accepted',
			'Validation scan shows no new critical GRC violations',
			'CI/CD pipeline updated to point at target project',
			'Compliance officer sign-off on regulated data handling',
			'Rollback plan documented and tested',
			'Monitoring and alerting configured for target system',
		];

		const checklist = $e('div', [
			'border:1px solid var(--vscode-widget-border)',
			'border-radius:6px', 'overflow:hidden', 'margin-bottom:20px',
		].join(';'));
		const clHdr = $e('div', [
			'padding:8px 13px',
			'background:var(--vscode-sideBarSectionHeader-background)',
			'border-bottom:1px solid var(--vscode-panel-border)',
		].join(';'));
		clHdr.appendChild($t('span', 'Pre-Cutover Checklist',
			'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-sideBarSectionHeader-foreground);'));
		checklist.appendChild(clHdr);

		const clBody = $e('div', 'padding:8px 12px;display:flex;flex-direction:column;gap:4px;');
		for (const item of items) {
			const row = $e('div', [
				'display:flex', 'align-items:flex-start', 'gap:8px',
				'padding:7px 10px', 'border-radius:4px',
				'background:var(--vscode-input-background)',
				'border:1px solid var(--vscode-widget-border)',
			].join(';'));
			row.appendChild($t('span', '\u25a1',
				'font-size:12px;color:var(--vscode-descriptionForeground);flex-shrink:0;margin-top:1px;'));
			row.appendChild($t('span', item,
				'font-size:11px;color:var(--vscode-editor-foreground);line-height:1.5;'));
			clBody.appendChild(row);
		}
		checklist.appendChild(clBody);
		pane.appendChild(checklist);

		// Summary from roadmap (if available)
		if (this._roadmap) {
			const summary = $e('div', [
				'padding:12px 16px', 'border-radius:6px', 'margin-bottom:16px',
				'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
				'border:1px solid var(--vscode-widget-border)',
			].join(';'));
			summary.appendChild($t('div', 'Session Summary',
				'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-descriptionForeground);margin-bottom:8px;'));
			const summaryGrid = $e('div', 'display:flex;gap:20px;flex-wrap:wrap;');
			const sCell = (label: string, value: string) => {
				const c = $e('div', '');
				c.appendChild($t('div', value, 'font-size:18px;font-weight:700;color:var(--vscode-editor-foreground);line-height:1;'));
				c.appendChild($t('div', label, 'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px;'));
				return c;
			};
			summaryGrid.appendChild(sCell('Total Units', String(this._roadmap.totalUnits)));
			summaryGrid.appendChild(sCell('Phases', String(this._roadmap.phases?.length ?? 0)));
			if (this._roadmap.estimatedHoursLow && this._roadmap.estimatedHoursHigh) {
				summaryGrid.appendChild(sCell('Est. Hours', `${this._roadmap.estimatedHoursLow}–${this._roadmap.estimatedHoursHigh}`));
			}
			summary.appendChild(summaryGrid);
			pane.appendChild(summary);
		}

		// End session CTA row
		const endRow = $e('div', 'display:flex;justify-content:space-between;align-items:center;gap:10px;');
		endRow.appendChild($t('span',
			'Complete all checklist items before ending the session.',
			'font-size:11px;color:var(--vscode-descriptionForeground);font-style:italic;flex:1;'));
		endRow.appendChild(this._btn('End Session', false,
			() => this.sessionService.endSession(),
			'padding:8px 20px;font-size:13px;'));
		pane.appendChild(endRow);

		return pane;
	}

	// ─── Roadmap sub-views ───────────────────────────────────────────────────

	private _buildRoadmapSummary(roadmap: IMigrationRoadmap): HTMLElement {
		const bar = $e('div', [
			'display:flex', 'flex-wrap:wrap', 'gap:10px',
			'padding:14px 16px', 'border-radius:6px',
			'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
			'border:1px solid var(--vscode-widget-border)',
		].join(';'));

		const stat = (label: string, value: string, accent?: string) => {
			const cell = $e('div', 'text-align:center;min-width:80px;');
			cell.appendChild($t('div', value, `font-size:22px;font-weight:700;line-height:1;color:${accent ?? 'var(--vscode-editor-foreground)'};`));
			cell.appendChild($t('div', label, 'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:3px;'));
			return cell;
		};

		bar.appendChild(stat('Units', String(roadmap.totalUnits)));
		bar.appendChild(this._divider());
		bar.appendChild(stat('Phases', String(roadmap.phases?.length ?? 0)));
		bar.appendChild(this._divider());
		bar.appendChild(stat('Critical Path', String(roadmap.criticalPath?.length ?? 0),
			'var(--vscode-inputValidation-warningBorder,#e0a84e)'));
		bar.appendChild(this._divider());

		const blockingCount = roadmap.migrationBlockers?.filter(b => b.severity === 'blocking').length ?? 0;
		bar.appendChild(stat('Blockers',
			String(blockingCount),
			blockingCount > 0 ? 'var(--vscode-inputValidation-errorBorder,#f44336)' : 'var(--vscode-editor-foreground)'));
		bar.appendChild(this._divider());

		const effortLow  = roadmap.estimatedHoursLow  ?? 0;
		const effortHigh = roadmap.estimatedHoursHigh ?? 0;
		bar.appendChild(stat('Est. Effort', effortHigh > 0 ? `${effortLow}–${effortHigh}h` : '—'));

		if (roadmap.aiEstimatedEffort) {
			bar.appendChild(this._divider());
			bar.appendChild(stat('AI Effort Band', roadmap.aiEstimatedEffort.toUpperCase(),
				'var(--vscode-button-background)'));
		}

		return bar;
	}

	private _buildPhasesView(roadmap: IMigrationRoadmap): HTMLElement {
		const container = $e('div', 'display:flex;flex-direction:column;gap:6px;');

		for (const phase of roadmap.phases ?? []) {
			const blockingHere = roadmap.migrationBlockers?.filter(b => b.resolveByPhaseIndex === phase.index && b.severity === 'blocking').length ?? 0;

			// Collapsible phase card
			const card = $e('div', [
				'border:1px solid var(--vscode-widget-border)',
				'border-radius:5px', 'overflow:hidden',
			].join(';'));

			const hdr = $e('div', [
				'display:flex', 'align-items:center', 'gap:10px',
				'padding:9px 13px', 'cursor:pointer',
				'background:var(--vscode-sideBarSectionHeader-background)',
				'user-select:none',
			].join(';'));

			// Phase index badge
			hdr.appendChild($t('span', `P${phase.index}`, [
				'font-size:9px', 'font-weight:700', 'padding:1px 5px',
				'border-radius:2px', 'flex-shrink:0',
				'background:var(--vscode-badge-background)',
				'color:var(--vscode-badge-foreground)',
			].join(';')));

			hdr.appendChild($t('span', phase.label,
				'font-size:12px;font-weight:600;flex:1;color:var(--vscode-editor-foreground);'));

			// Unit count
			hdr.appendChild($t('span', `${phase.unitIds.length} units`,
				'font-size:10px;color:var(--vscode-descriptionForeground);'));
			// Effort
			hdr.appendChild($t('span', `${phase.estimatedHoursLow}–${phase.estimatedHoursHigh}h`,
				'font-size:10px;color:var(--vscode-descriptionForeground);'));

			// Gate badges
			if (phase.hasComplianceGate) {
				hdr.appendChild($t('span', '\u26a0 Compliance Gate', [
					'font-size:9px', 'padding:1px 5px', 'border-radius:2px',
					'background:rgba(224,168,78,0.15)',
					'color:var(--vscode-inputValidation-warningBorder,#e0a84e)',
					'border:1px solid var(--vscode-inputValidation-warningBorder,rgba(224,168,78,0.4))',
				].join(';')));
			}
			if (phase.hasAPICompatibilityGate) {
				hdr.appendChild($t('span', '\u{1F517} API Gate', [
					'font-size:9px', 'padding:1px 5px', 'border-radius:2px',
					'background:rgba(100,150,250,0.1)',
					'color:var(--vscode-focusBorder,#6496fa)',
					'border:1px solid var(--vscode-focusBorder,rgba(100,150,250,0.4))',
				].join(';')));
			}
			if (blockingHere > 0) {
				hdr.appendChild($t('span', `\u2715 ${blockingHere} blocking`, [
					'font-size:9px', 'padding:1px 5px', 'border-radius:2px',
					'background:rgba(244,67,54,0.1)',
					'color:var(--vscode-inputValidation-errorBorder,#f44336)',
					'border:1px solid rgba(244,67,54,0.3)',
				].join(';')));
			}

			const chevron = $t('span', '\u203a', 'font-size:14px;color:var(--vscode-descriptionForeground);transition:transform 0.15s;display:inline-block;');
			hdr.appendChild(chevron);
			card.appendChild(hdr);

			// Collapsible body
			const body = $e('div', 'padding:12px 14px;display:none;');

			// Description
			body.appendChild($t('div', phase.description,
				'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;margin-bottom:10px;'));

			// Risk distribution chips
			const riskRow = $e('div', 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;');
			const riskColors: Record<MigrationRiskLevel, string> = {
				critical: '#f44336', high: '#e0a84e', medium: '#64b5f6', low: '#81c784',
			};
			for (const level of ['critical', 'high', 'medium', 'low'] as MigrationRiskLevel[]) {
				const count = phase.riskDistribution[level];
				if (count === 0) { continue; }
				riskRow.appendChild($t('span', `${count} ${level}`, [
					'font-size:10px', 'padding:2px 7px', 'border-radius:10px',
					`background:${riskColors[level]}22`,
					`color:${riskColors[level]}`,
					`border:1px solid ${riskColors[level]}55`,
				].join(';')));
			}
			body.appendChild(riskRow);

			// Compliance notes
			if (phase.complianceNotes) {
				const note = $e('div', [
					'padding:8px 10px', 'border-radius:4px', 'margin-bottom:10px',
					'background:rgba(224,168,78,0.07)',
					'border-left:3px solid var(--vscode-inputValidation-warningBorder,#e0a84e)',
				].join(';'));
				note.appendChild($t('div', phase.complianceNotes,
					'font-size:11px;color:var(--vscode-editor-foreground);line-height:1.5;'));
				body.appendChild(note);
			}

			card.appendChild(body);

			// Toggle expand
			let expanded = false;
			hdr.addEventListener('click', () => {
				expanded = !expanded;
				body.style.display = expanded ? 'block' : 'none';
				chevron.style.transform = expanded ? 'rotate(90deg)' : '';
			});

			container.appendChild(card);
		}

		return container;
	}

	private _buildCriticalPathView(roadmap: IMigrationRoadmap): HTMLElement {
		const container = $e('div', '');
		const nodes = (roadmap.criticalPath ?? []).slice(0, 20);

		const table = $e('div', 'display:grid;grid-template-columns:1fr auto auto auto;gap:0;');

		// Header
		for (const h of ['Unit', 'Phase', 'Effort', 'Slack']) {
			table.appendChild($t('div', h, [
				'font-size:10px', 'font-weight:700', 'text-transform:uppercase',
				'letter-spacing:0.06em', 'padding:5px 8px',
				'color:var(--vscode-descriptionForeground)',
				'border-bottom:1px solid var(--vscode-widget-border)',
			].join(';')));
		}

		for (const node of nodes) {
			const rowCss = 'padding:6px 8px;border-bottom:1px solid var(--vscode-widget-border,rgba(0,0,0,0.05));font-size:11px;';
			const nameCss = rowCss + 'color:var(--vscode-editor-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
			const nameEl = $t('div', node.unitName, nameCss);
			nameEl.title = node.unitName;
			table.appendChild(nameEl);
			table.appendChild($t('div', node.phaseType, rowCss + 'color:var(--vscode-descriptionForeground);'));
			table.appendChild($t('div', `${node.effortHoursHigh}h`, rowCss + 'color:var(--vscode-editor-foreground);text-align:right;'));
			table.appendChild($t('div', `${node.slack}h`, rowCss + (node.slack === 0 ? 'color:var(--vscode-inputValidation-errorBorder,#f44336);font-weight:600;' : 'color:var(--vscode-descriptionForeground);') + 'text-align:right;'));
		}

		container.appendChild(table);

		if ((roadmap.criticalPath?.length ?? 0) > 20) {
			container.appendChild($t('div',
				`\u2026 and ${(roadmap.criticalPath!.length) - 20} more zero-slack units`,
				'font-size:10px;color:var(--vscode-descriptionForeground);padding:6px 8px;'));
		}
		return container;
	}

	private _buildBlockersView(roadmap: IMigrationRoadmap): HTMLElement {
		const container = $e('div', 'display:flex;flex-direction:column;gap:6px;');
		const blockers = roadmap.migrationBlockers ?? [];
		const blocking = blockers.filter(b => b.severity === 'blocking');
		const warnings = blockers.filter(b => b.severity === 'warning');

		const renderGroup = (items: typeof blockers, color: string, label: string) => {
			if (items.length === 0) { return; }
			container.appendChild($t('div', `${label} (${items.length})`, [
				'font-size:10px', 'font-weight:700', 'text-transform:uppercase',
				'letter-spacing:0.06em', `color:${color}`, 'margin-top:4px',
			].join(';')));

			for (const b of items) {
				const card = $e('div', [
					'border:1px solid var(--vscode-widget-border)',
					'border-radius:4px', 'overflow:hidden', 'margin-bottom:4px',
				].join(';'));

				const hdr = $e('div', [
					'display:flex', 'align-items:center', 'gap:8px',
					'padding:7px 11px', 'cursor:pointer',
					'background:var(--vscode-input-background)',
					'user-select:none',
				].join(';'));

				hdr.appendChild($t('span', b.blockerType.replace(/-/g, ' '), [
					'font-size:9px', 'font-weight:700', 'text-transform:uppercase',
					'letter-spacing:0.05em', 'padding:1px 5px', 'border-radius:2px', 'flex-shrink:0',
					`background:${color}18`, `color:${color}`,
					`border:1px solid ${color}44`,
				].join(';')));
				hdr.appendChild($t('span', b.title,
					'font-size:12px;font-weight:500;flex:1;color:var(--vscode-editor-foreground);'));
				hdr.appendChild($t('span', `resolve by phase ${b.resolveByPhaseIndex}`,
					'font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;'));
				const ch = $t('span', '\u203a', 'font-size:14px;color:var(--vscode-descriptionForeground);display:inline-block;');
				hdr.appendChild(ch);
				card.appendChild(hdr);

				const body = $e('div', 'padding:10px 12px;display:none;');
				body.appendChild($t('div', b.description,
					'font-size:11px;color:var(--vscode-editor-foreground);line-height:1.5;margin-bottom:8px;'));
				const actionWrap = $e('div', [
					'padding:8px 10px', 'border-radius:3px',
					'background:var(--vscode-textBlockQuote-background,rgba(100,100,100,0.1))',
					'border-left:3px solid var(--vscode-button-background)',
				].join(';'));
				actionWrap.appendChild($t('div', '\u{1F527} Recommended Action',
					'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-button-background);margin-bottom:4px;'));
				actionWrap.appendChild($t('div', b.recommendedAction,
					'font-size:11px;line-height:1.5;color:var(--vscode-editor-foreground);'));
				body.appendChild(actionWrap);
				card.appendChild(body);

				let open = false;
				hdr.addEventListener('click', () => {
					open = !open;
					body.style.display = open ? 'block' : 'none';
					ch.style.transform = open ? 'rotate(90deg)' : '';
				});
				container.appendChild(card);
			}
		};

		renderGroup(blocking, 'var(--vscode-inputValidation-errorBorder,#f44336)', 'Blocking');
		renderGroup(warnings,  'var(--vscode-inputValidation-warningBorder,#e0a84e)', 'Warnings');

		return container;
	}

	private _buildAINotes(roadmap: IMigrationRoadmap): HTMLElement {
		const container = $e('div', 'display:flex;flex-direction:column;gap:10px;');

		if (roadmap.riskNarrative) {
			const block = $e('div', [
				'padding:10px 12px', 'border-radius:4px',
				'background:rgba(244,67,54,0.05)',
				'border-left:3px solid var(--vscode-inputValidation-errorBorder,#f44336)',
			].join(';'));
			block.appendChild($t('div', '\u26a0 Risk Narrative',
				'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-inputValidation-errorBorder,#f44336);margin-bottom:5px;'));
			block.appendChild($t('div', roadmap.riskNarrative,
				'font-size:12px;line-height:1.6;color:var(--vscode-editor-foreground);'));
			container.appendChild(block);
		}

		if (roadmap.complianceNotes) {
			const block = $e('div', [
				'padding:10px 12px', 'border-radius:4px',
				'background:rgba(224,168,78,0.05)',
				'border-left:3px solid var(--vscode-inputValidation-warningBorder,#e0a84e)',
			].join(';'));
			block.appendChild($t('div', '\u{1F4CB} Compliance Notes',
				'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-inputValidation-warningBorder,#e0a84e);margin-bottom:5px;'));
			block.appendChild($t('div', roadmap.complianceNotes,
				'font-size:12px;line-height:1.6;color:var(--vscode-editor-foreground);'));
			container.appendChild(block);
		}

		return container;
	}

	private _buildApprovalGate(session: IModernisationSessionData): HTMLElement {
		if (session.planApproved) {
			// Already approved — show status + navigation
			const banner = $e('div', [
				'padding:14px 16px', 'border-radius:6px',
				'background:var(--vscode-inputValidation-infoBackground,rgba(100,200,100,0.07))',
				'border:1px solid rgba(100,200,100,0.4)',
				'display:flex', 'align-items:center', 'gap:16px',
			].join(';'));
			const text = $e('div', 'flex:1;');
			text.appendChild($t('div', '\u2713  Plan Approved',
				'font-size:13px;font-weight:700;color:rgba(100,200,100,1);margin-bottom:4px;'));
			text.appendChild($t('div',
				'This migration plan has been approved. Stage 3 (Migration) is unlocked.',
				'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;'));
			banner.appendChild(text);
			banner.appendChild(this._btn('Go to Migration \u2192', true,
				() => this.sessionService.setStage('migration'),
				'white-space:nowrap;flex-shrink:0;padding:7px 16px;font-size:13px;'));
			return banner;
		}

		// Not yet approved
		const banner = $e('div', [
			'padding:14px 16px', 'border-radius:6px',
			'background:var(--vscode-inputValidation-warningBackground,rgba(224,168,78,0.07))',
			'border:1px solid var(--vscode-inputValidation-warningBorder,rgba(224,168,78,0.4))',
			'display:flex', 'align-items:center', 'gap:16px',
		].join(';'));
		const text = $e('div', 'flex:1;');
		text.appendChild($t('div', '\u26a0  Awaiting Plan Approval',
			'font-size:13px;font-weight:700;color:var(--vscode-inputValidation-warningBorder,#e0a84e);margin-bottom:4px;'));
		text.appendChild($t('div',
			'Review all phases and blockers above. Once you approve, Stage 3 (Migration) will unlock and translation can begin.',
			'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;'));
		banner.appendChild(text);
		banner.appendChild(this._btn('Approve Plan \u2192', true, () => {
			this.sessionService.approvePlan();
			this.sessionService.setStage('migration');
		}, 'white-space:nowrap;flex-shrink:0;padding:7px 16px;font-size:13px;'));
		return banner;
	}

	// ─── Helpers shared by planning view ─────────────────────────────────────

	private _buildSection(title: string, content: HTMLElement): HTMLElement {
		const wrap = $e('div', [
			'border:1px solid var(--vscode-widget-border)',
			'border-radius:6px', 'overflow:hidden',
		].join(';'));
		const hdr = $e('div', [
			'padding:8px 13px',
			'background:var(--vscode-sideBarSectionHeader-background)',
			'border-bottom:1px solid var(--vscode-panel-border)',
		].join(';'));
		hdr.appendChild($t('span', title,
			'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-sideBarSectionHeader-foreground);'));
		wrap.appendChild(hdr);
		content.style.cssText += ';padding:12px;';
		wrap.appendChild(content);
		return wrap;
	}

	private _divider(): HTMLElement {
		return $e('div', 'width:1px;background:var(--vscode-widget-border);align-self:stretch;margin:4px 0;');
	}

	// In-console reconfiguration
	private _buildConfigPanel(session: IModernisationSessionData): HTMLElement {
		const sec = $e('div', [
			'border:1px solid var(--vscode-widget-border,var(--vscode-panel-border))',
			'border-radius:6px', 'overflow:hidden',
		].join(';'));
		const hdr = $e('div', [
			'padding:10px 14px',
			'background:var(--vscode-sideBarSectionHeader-background)',
			'border-bottom:1px solid var(--vscode-panel-border)',
		].join(';'));
		hdr.appendChild($t('span', 'Session Configuration',
			'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--vscode-sideBarSectionHeader-foreground);'));
		sec.appendChild(hdr);

		const body = $e('div', 'padding:14px;display:flex;flex-direction:column;gap:10px;');

		// Migration pattern selector
		const row1 = $e('div', 'display:flex;align-items:center;gap:10px;');
		row1.appendChild($t('span', 'Migration Pattern',
			'font-size:12px;color:var(--vscode-editor-foreground);min-width:140px;'));
		const select = $e('select', [
			'flex:1', 'padding:4px 8px',
			'background:var(--vscode-input-background)',
			'color:var(--vscode-input-foreground)',
			'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
			'border-radius:3px', 'font-size:12px', 'font-family:inherit',
		].join(';'));
		const patterns: MigrationPattern[] = MIGRATION_PATTERN_PRESETS.map(p => p.id);
		for (const p of patterns) {
			const opt = $t('option', MIGRATION_PATTERN_LABELS[p]);
			opt.value = p;
			if (p === session.migrationPattern) { (opt as HTMLOptionElement).selected = true; }
			select.appendChild(opt);
		}
		select.addEventListener('change', () => {
			this.sessionService.setMigrationPattern((select as HTMLSelectElement).value as MigrationPattern);
		});
		row1.appendChild(select);
		body.appendChild(row1);

		// Stage reset
		const row2 = $e('div', 'display:flex;align-items:center;gap:10px;');
		row2.appendChild($t('span', 'Current Stage',
			'font-size:12px;color:var(--vscode-editor-foreground);min-width:140px;'));
		const stageSelect = $e('select', [
			'flex:1', 'padding:4px 8px',
			'background:var(--vscode-input-background)',
			'color:var(--vscode-input-foreground)',
			'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
			'border-radius:3px', 'font-size:12px', 'font-family:inherit',
		].join(';'));
		for (const s of STAGES) {
			const opt = $t('option', STAGE_LABELS[s]);
			opt.value = s;
			if (s === session.currentStage) { (opt as HTMLOptionElement).selected = true; }
			stageSelect.appendChild(opt);
		}
		stageSelect.addEventListener('change', () => {
			this.sessionService.setStage((stageSelect as HTMLSelectElement).value as ModernisationStage);
		});
		row2.appendChild(stageSelect);
		body.appendChild(row2);

		sec.appendChild(body);
		return sec;
	}

	private _buildFilePickers(session: IModernisationSessionData): HTMLElement {
		const row = $e('div', 'display:flex;border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border));flex-shrink:0;');
		// Use first source and first target for file-level compliance analysis
		const src = session.sources[0];
		const tgt = session.targets[0];
		row.appendChild(this._filePicker('SOURCE', src?.folderUri, session.activeSourceFileUri, 'source'));
		row.appendChild($e('div', 'width:1px;background:var(--vscode-panel-border,var(--vscode-widget-border));flex-shrink:0;'));
		row.appendChild(this._filePicker('TARGET', tgt?.folderUri, session.activeTargetFileUri, 'target'));
		return row;
	}

	private _filePicker(label: string, folderUri: string | undefined, fileUri: string | undefined, side: 'source' | 'target'): HTMLElement {
		const pane = $e('div', 'flex:1;padding:12px 16px;min-width:0;');
		pane.appendChild($t('div', label,
			'font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--vscode-descriptionForeground);margin-bottom:8px;'));
		const folder = $t('div', folderUri ? this._basename(folderUri) : 'No project',
			'font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
		folder.title = folderUri ?? '';
		pane.appendChild(folder);
		const fileRow = $e('div', 'display:flex;align-items:center;gap:6px;');
		const fname = $t('span', fileUri ? this._basename(fileUri) : 'No file selected',
			'font-size:11px;color:var(--vscode-descriptionForeground);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
		fname.title = fileUri ?? '';
		fileRow.appendChild(fname);
		fileRow.appendChild(this._btn('Pick', false, async () => {
			const defaultUri = folderUri ? URI.parse(folderUri) : undefined;
			const uris = await this.fileDialogService.showOpenDialog({
				title: `Select ${label} Source File`, defaultUri,
				canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
			});
			if (!uris?.[0]) { return; }
			const cur = this.sessionService.session;
			this.sessionService.setFilePair(
				side === 'source' ? uris[0].toString() : cur.activeSourceFileUri,
				side === 'target' ? uris[0].toString() : cur.activeTargetFileUri,
			);
		}, 'font-size:10px;padding:2px 8px;'));
		pane.appendChild(fileRow);
		return pane;
	}

	private _buildAnalyseRow(): HTMLElement {
		const row = $e('div', 'padding:10px 16px;border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border));display:flex;justify-content:center;flex-shrink:0;');
		row.appendChild(this._btn('Analyse Compliance', true, () => this._runAnalysis()));
		return row;
	}

	// ─── Analysis ────────────────────────────────────────────────────────────

	private async _runAnalysis(): Promise<void> {
		const session = this.sessionService.session;
		if (!session.activeSourceFileUri || !session.activeTargetFileUri) {
			this._msg('Select both a source file and a target file before analysing.', 'error');
			return;
		}
		this._msg('Extracting Layer 1 fingerprints\u2026', 'status');
		try {
			const legacyUri  = URI.parse(session.activeSourceFileUri);
			const modernUri  = URI.parse(session.activeTargetFileUri);
			const [legacyRaw, modernRaw] = await Promise.all([
				this.fileService.readFile(legacyUri),
				this.fileService.readFile(modernUri),
			]);
			const legacySrc  = legacyRaw.value.toString();
			const modernSrc  = modernRaw.value.toString();
			const legacyLang = this._detectLang(legacyUri.path);
			const modernLang = this._detectLang(modernUri.path);
			const unitName   = this._basename(session.activeSourceFileUri).replace(/\.[^.]+$/, '');

			const legacyDet  = extractDeterministicFingerprint(legacySrc, legacyLang, unitName);
			const modernDet  = extractDeterministicFingerprint(modernSrc, modernLang, unitName + '-modern');

			this._msg('Running LLM semantic extraction (Layer 2)\u2026', 'status');
			const [legacySem, modernSem] = await Promise.all([
				this.semanticExtractor.extractSemantics(unitName, legacySrc, legacyLang, legacyDet.regulatedFields),
				this.semanticExtractor.extractSemantics(unitName + '-modern', modernSrc, modernLang, modernDet.regulatedFields),
			]);

			const legacyFP: IComplianceFingerprint = {
				unitId: unitName, extractedAt: Date.now(), sourceLanguage: legacyLang,
				regulatedFields: legacyDet.regulatedFields,
				invariants: [...legacyDet.invariants, ...legacySem.additionalInvariants],
				semanticRules: legacySem.semanticRules, complianceDomains: legacySem.complianceDomains,
				llmExtractionComplete: true,
			};
			const modernFP: IComplianceFingerprint = {
				unitId: unitName + '-modern', extractedAt: Date.now(), sourceLanguage: modernLang,
				regulatedFields: modernDet.regulatedFields,
				invariants: [...modernDet.invariants, ...modernSem.additionalInvariants],
				semanticRules: modernSem.semanticRules, complianceDomains: modernSem.complianceDomains,
				llmExtractionComplete: true,
			};

			this._msg('Comparing fingerprints\u2026', 'status');
			const cmp = this.comparisonService.compare(unitName, legacyFP, modernFP);
			this._renderComparison(cmp, legacyUri.path, modernUri.path);
		} catch (err) {
			this._msg(`Analysis failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
		}
	}

	private _renderComparison(cmp: IFingerprintComparison, legacyPath: string, modernPath: string): void {
		while (this._resultsEl.firstChild) { this._resultsEl.removeChild(this._resultsEl.firstChild); }

		const pct     = Math.round(cmp.matchPercentage);
		const color   = cmp.overallResult === 'pass'
			? 'var(--vscode-terminal-ansiGreen,#4caf50)'
			: cmp.overallResult === 'warning'
				? 'var(--vscode-inputValidation-warningBorder,#e0a84e)'
				: 'var(--vscode-inputValidation-errorBorder,#f44336)';
		const blocking = cmp.divergences.filter(d => d.severity === 'blocking');
		const warnings = cmp.divergences.filter(d => d.severity === 'warning');

		const header = $e('div', 'display:flex;align-items:center;gap:16px;margin-bottom:16px;flex-wrap:wrap;');
		header.appendChild($t('div', `${this._basename(legacyPath)} \u2192 ${this._basename(modernPath)}`,
			'font-size:11px;color:var(--vscode-descriptionForeground);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
		const score = $e('div', 'display:flex;align-items:baseline;gap:8px;flex-shrink:0;');
		score.appendChild($t('span', `${pct}%`, `font-size:40px;font-weight:700;line-height:1;color:${color};`));
		score.appendChild($t('span', cmp.overallResult.toUpperCase(), `font-size:13px;font-weight:700;color:${color};letter-spacing:0.05em;`));
		header.appendChild(score);
		this._resultsEl.appendChild(header);

		const track = $e('div', 'background:var(--vscode-input-background);border-radius:3px;height:6px;margin-bottom:20px;overflow:hidden;');
		track.appendChild($e('div', `height:100%;width:${pct}%;background:${color};`));
		this._resultsEl.appendChild(track);

		if (blocking.length > 0) { this._resultsEl.appendChild(this._divSection('Blocking', 'var(--vscode-inputValidation-errorBorder,#f44336)', blocking)); }
		if (warnings.length  > 0) { this._resultsEl.appendChild(this._divSection('Warnings', 'var(--vscode-inputValidation-warningBorder,#e0a84e)', warnings)); }
		if (blocking.length === 0 && warnings.length === 0) {
			this._resultsEl.appendChild($t('div', '\u2713  All compliance checks passed \u2014 translation is equivalent.',
				'color:var(--vscode-terminal-ansiGreen,#4caf50);font-size:13px;'));
		}
	}

	private _divSection(title: string, color: string, items: IFingerprintDivergence[]): HTMLElement {
		const sec = $e('div', 'margin-bottom:16px;');
		sec.appendChild($t('div', `${title} (${items.length})`,
			`font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${color};margin-bottom:8px;`));
		for (const d of items) {
			const row = $e('div', 'display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--vscode-widget-border,var(--vscode-panel-border));');
			row.appendChild($t('code', d.type.replace(/-/g, ' '),
				'font-size:10px;font-weight:600;text-transform:uppercase;opacity:0.6;min-width:100px;flex-shrink:0;word-break:break-all;'));
			row.appendChild($t('span', d.description, 'flex:1;font-size:12px;line-height:1.5;'));
			sec.appendChild(row);
		}
		return sec;
	}

	// ─── Shared helpers ───────────────────────────────────────────────────────

	private _projectRow(badge: string, pt: IProjectTarget, openCmd: string): HTMLElement {
		const row = $e('div', 'display:flex;align-items:center;gap:8px;margin-bottom:6px;');
		row.appendChild($t('span', badge,
			'font-size:9px;font-weight:700;letter-spacing:0.06em;color:var(--vscode-badge-foreground);background:var(--vscode-badge-background);border-radius:2px;padding:1px 5px;flex-shrink:0;'));
		const name = $t('div', pt.label || this._basename(pt.folderUri),
			'font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
		name.title = pt.folderUri;
		row.appendChild(name);
		const openBtn = this._btn('\u2197', false, () => this.commandService.executeCommand(openCmd, pt.folderUri),
			'font-size:11px;padding:1px 6px;');
		openBtn.title = `Open in VS Code window`;
		row.appendChild(openBtn);
		return row;
	}

	private _section(title: string): HTMLElement {
		const s = $e('div', 'padding:12px 14px 8px;border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border));');
		s.appendChild($t('div', title,
			'font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--vscode-sideBarSectionHeader-foreground,var(--vscode-descriptionForeground));margin-bottom:10px;'));
		return s;
	}

	private _btn(label: string, primary: boolean, onClick: () => void, extraCss = ''): HTMLButtonElement {
		const btn = $t('button', label, [
			'padding:5px 14px', 'border-radius:3px', 'cursor:pointer',
			'font-size:12px', 'font-family:inherit',
			primary
				? 'background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid var(--vscode-button-border,transparent);'
				: 'background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-widget-border,transparent);',
			extraCss,
		].join(';')) as HTMLButtonElement;
		btn.addEventListener('click', onClick);
		this._disposables.add({ dispose: () => btn.removeEventListener('click', onClick) });
		return btn;
	}

	private _msg(text: string, kind: 'status' | 'error'): void {
		while (this._resultsEl.firstChild) { this._resultsEl.removeChild(this._resultsEl.firstChild); }
		this._resultsEl.appendChild($t('div', text,
			kind === 'error'
				? 'color:var(--vscode-inputValidation-errorBorder,#f44336);'
				: 'color:var(--vscode-descriptionForeground);font-style:italic;'));
	}

	private _basename(p: string): string {
		return p.split(/[/\\]/).filter(Boolean).pop() ?? p;
	}

	private _detectLang(filePath: string): string {
		const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
		const map: Record<string, string> = {
			cob: 'cobol', cbl: 'cobol', cobol: 'cobol',
			ts: 'typescript', tsx: 'typescript',
			js: 'javascript', jsx: 'javascript',
			java: 'java',
			sql: 'plsql', pls: 'plsql', pkb: 'plsql', pks: 'plsql',
			py: 'python', rpg: 'rpg', rpgle: 'rpg',
			nat: 'natural', vb: 'vb6', bas: 'vb6',
		};
		return map[ext] ?? ext;
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
	}

	override dispose(): void {
		this._console?.dispose();
		this._disposables.dispose();
		super.dispose();
	}
}
