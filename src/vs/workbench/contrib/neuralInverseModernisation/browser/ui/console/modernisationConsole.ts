/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ModernisationConsole — 4-tab live console for the Migration and Validation stages.
 *
 * Tabs:
 *   1. Unit Index       — filterable / sortable / paginated table of all KB units
 *   2. Pending Decisions — every unanswered IPendingDecision, inline answer form
 *   3. Decision Log     — 5 sub-tabs of recorded decisions (export/import JSON)
 *   4. Progress         — full progress dashboard: velocity, phases, risk, health
 *
 * The class owns the top-level DOM node `domNode` which is appended once into the
 * Part container and never re-created — only its contents are replaced on `refresh()`.
 * Tab/filter state is stored as class fields so it survives re-renders.
 *
 * Usage:
 *   const console = new ModernisationConsole(kbService, agentToolsService);
 *   parent.appendChild(console.domNode);
 *   console.refresh();
 *   // call console.dispose() when session ends
 */

import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { IKnowledgeBaseService } from '../../knowledgeBase/service.js';
import { IModernisationAgentToolService } from '../../engine/agentTools/service.js';
import {
	buildUnitIndexView,
	IUnitIndexState,
	defaultUnitIndexState,
} from './unitIndexView.js';
import { buildPendingDecisionsView } from './pendingDecisionsView.js';
import {
	buildDecisionLogView,
	IDecisionLogState,
	defaultDecisionLogState,
} from './decisionLogView.js';
import { buildProgressView } from './progressView.js';
import { IValidationEngineService } from '../../engine/validation/service.js';
import { ICutoverService } from '../../engine/cutover/service.js';
import { IAutonomyService } from '../../engine/autonomy/service.js';
import type { IGRCSnapshot } from '../../engine/discovery/discoveryTypes.js';
import {
	buildUnitEditorView,
	IUnitEditorState,
	defaultUnitEditorState,
} from '../twoWindowEditor/unitEditorView.js';
import { $e, $t } from './consoleHelpers.js';

// ─── Tab type ─────────────────────────────────────────────────────────────────

type ConsoleTab = 'unit-index' | 'pending' | 'decision-log' | 'progress';

const TAB_DEFS: Array<{ id: ConsoleTab; label: string }> = [
	{ id: 'unit-index',    label: 'Unit Index' },
	{ id: 'pending',       label: 'Pending Decisions' },
	{ id: 'decision-log',  label: 'Decision Log' },
	{ id: 'progress',      label: 'Progress' },
];


// ─── Console class ────────────────────────────────────────────────────────────

export class ModernisationConsole {

	/** The root DOM element — append this once into the parent container. */
	readonly domNode: HTMLElement;

	// ── Persistent tab / filter state ─────────────────────────────────────
	private _activeTab:        ConsoleTab         = 'unit-index';
	private _unitIndexState:   IUnitIndexState    = defaultUnitIndexState();
	private _decisionLogState: IDecisionLogState  = defaultDecisionLogState();

	// ── Editor state (Phase 8) ─────────────────────────────────────────────
	/** When set, the content area shows the Unit Editor instead of the tab content. */
	private _reviewingUnitId:  string | undefined;
	private _editorState:      IUnitEditorState | undefined;

	// ── Internal DOM refs ─────────────────────────────────────────────────
	private _tabBarEl:   HTMLElement;
	private _contentEl:  HTMLElement;

	// ── Event subscriptions ───────────────────────────────────────────────
	private readonly _disposables = new DisposableStore();

	constructor(
		private readonly _kb:         IKnowledgeBaseService,
		private readonly _tools:      IModernisationAgentToolService,
		private readonly _validation: IValidationEngineService | undefined,
		private readonly _cutover:    ICutoverService | undefined,
		private readonly _autonomy:   IAutonomyService | undefined,
		/** Called when the user clicks Refresh — re-runs _seedKBFromDiscovery so that
		 *  units added to the target folder since last discovery are promoted to 'committed'. */
		private readonly _onResyncDiscovery?: () => void,
		/** Merged GRC snapshot from the most recent discovery run — shown in the progress dashboard. */
		private _grcSnapshot?: IGRCSnapshot,
	) {
		this.domNode = $e('div', [
			'display:flex', 'flex-direction:column',
			'width:100%', 'height:100%', 'overflow:hidden',
		].join(';'));

		this._tabBarEl  = this._buildTabBar();
		this._contentEl = $e('div', 'flex:1;overflow:hidden;display:flex;flex-direction:column;');

		this.domNode.appendChild(this._tabBarEl);
		this.domNode.appendChild(this._contentEl);

		// Live updates — subscribe to KB change events
		this._disposables.add(this._kb.onDidChange(() => this.refresh()));
		this._disposables.add(this._kb.onDidChangeUnitStatus(() => this.refresh()));
		this._disposables.add(this._kb.onDidRaisePendingDecision(() => this.refresh()));
		this._disposables.add(this._kb.onDidResolvePendingDecision(() => this.refresh()));

		// Live updates — autonomy batch events (Progress tab autonomy section)
		if (this._autonomy) {
			this._disposables.add(this._autonomy.onBatchStateChanged(() => this.refresh()));
			this._disposables.add(this._autonomy.onUnitEscalated(() => this.refresh()));
			this._disposables.add(this._autonomy.onEscalationResolved(() => this.refresh()));
			// Throttle progress refreshes — unit-completed fires on every unit
			let _autonomyProgressTimer: ReturnType<typeof setTimeout> | null = null;
			this._disposables.add(this._autonomy.onProgress(() => {
				if (_autonomyProgressTimer !== null) { return; }
				_autonomyProgressTimer = setTimeout(() => {
					_autonomyProgressTimer = null;
					this.refresh();
				}, 500); // max 2 refreshes/sec during a running batch
			}));
		}

		// Initial render
		this.refresh();
	}

	// ─── Public API ───────────────────────────────────────────────────────

	/**
	 * Re-renders the tab bar (badge counts) and the active tab's content.
	 * Called automatically on every KB change event.
	 */
	refresh(): void {
		this._refreshTabBar();
		this._refreshContent();
	}

	dispose(): void {
		this._disposables.dispose();
	}

	/** Update the GRC snapshot shown on the Progress tab (called after each discovery run). */
	setGRCSnapshot(snapshot: IGRCSnapshot | undefined): void {
		this._grcSnapshot = snapshot;
		if (this._activeTab === 'progress') { this.refresh(); }
	}

	/**
	 * Open the side-by-side Unit Editor for the given unit.
	 * The tab bar is hidden while the editor is open; "← Index" closes it.
	 */
	openUnitEditor(unitId: string): void {
		const unit = this._kb.getUnit(unitId);
		this._reviewingUnitId = unitId;
		this._editorState     = unit ? defaultUnitEditorState(unit) : undefined;
		this.refresh();
	}

	// ─── Tab bar ──────────────────────────────────────────────────────────

	private _buildTabBar(): HTMLElement {
		const bar = $e('div', [
			'display:flex', 'align-items:stretch', 'flex-shrink:0',
			'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
			'border-bottom:2px solid var(--vscode-panel-border)',
		].join(';'));
		// Tabs will be populated by _refreshTabBar()
		return bar;
	}

	private _refreshTabBar(): void {
		// Clear and rebuild tab buttons so badge counts stay up to date
		while (this._tabBarEl.firstChild) { this._tabBarEl.removeChild(this._tabBarEl.firstChild); }

		const pendingCount = this._kb.isActive ? this._kb.getPendingDecisions().length : 0;

		const badges: Partial<Record<ConsoleTab, number>> = {
			pending: pendingCount > 0 ? pendingCount : 0,
		};

		for (const tab of TAB_DEFS) {
			const isActive = this._activeTab === tab.id;
			const tabEl    = $e('div', [
				'display:flex', 'align-items:center', 'gap:6px',
				'padding:8px 16px', 'cursor:pointer',
				'font-size:11px', 'font-weight:600',
				'border-bottom:2px solid transparent',
				'margin-bottom:-2px',
				'white-space:nowrap', 'user-select:none',
				'flex-shrink:0',
				isActive
					? 'color:var(--vscode-focusBorder,#6496fa);border-bottom-color:var(--vscode-focusBorder,#6496fa);'
					: 'color:var(--vscode-descriptionForeground);',
			].join(';'));

			tabEl.appendChild($t('span', tab.label));

			const badgeCount = badges[tab.id] ?? 0;
			if (badgeCount > 0) {
				tabEl.appendChild($t('span', String(badgeCount), [
					'font-size:9px', 'padding:1px 6px', 'border-radius:9px',
					'font-weight:700',
					tab.id === 'pending'
						? 'background:var(--vscode-inputValidation-errorBorder,#f44336);color:#fff;'
						: 'background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);',
				].join(';')));
			}

			tabEl.addEventListener('click', () => {
				this._activeTab = tab.id;
				this.refresh();
			});
			tabEl.addEventListener('mouseenter', () => {
				if (!isActive) { tabEl.style.color = 'var(--vscode-editor-foreground)'; }
			});
			tabEl.addEventListener('mouseleave', () => {
				if (!isActive) { tabEl.style.color = 'var(--vscode-descriptionForeground)'; }
			});

			this._tabBarEl.appendChild(tabEl);
		}

		// Spacer + refresh button on the right
		const spacer = $e('div', 'flex:1;');
		this._tabBarEl.appendChild(spacer);

		const refreshBtn = $e('button', [
			'border:none', 'cursor:pointer', 'border-radius:3px',
			'padding:4px 10px', 'margin:4px 8px',
			'font-size:10px', 'font-family:inherit',
			'background:transparent',
			'color:var(--vscode-descriptionForeground)',
		].join(';'));
		refreshBtn.textContent = '\u21bb Refresh';
		refreshBtn.title = 'Refresh console — also re-detects committed units from the target folder';
		refreshBtn.addEventListener('click', () => {
			// Re-sync KB with discovery result first (promotes pending\u2192committed for
			// units that exist in the target folder), then re-render.
			this._onResyncDiscovery?.();
			this.refresh();
		});
		this._tabBarEl.appendChild(refreshBtn);
	}

	// ─── Content area ─────────────────────────────────────────────────────

	private _refreshContent(): void {
		// Remove old content — but preserve the element itself
		while (this._contentEl.firstChild) { this._contentEl.removeChild(this._contentEl.firstChild); }

		const onRefresh = () => this.refresh();

		// ── Editor overlay (Phase 8) ─────────────────────────────────────
		if (this._reviewingUnitId) {
			const unitId = this._reviewingUnitId;

			// Ensure editor state exists / stays in sync when unit changes
			if (!this._editorState) {
				const unit = this._kb.getUnit(unitId);
				this._editorState = unit ? defaultUnitEditorState(unit) : undefined;
			}
			if (!this._editorState) {
				this._reviewingUnitId = undefined;
				this._tabBarEl.style.display = '';
				return;
			}

			const onBack = () => {
				this._reviewingUnitId = undefined;
				this._editorState     = undefined;
				this.refresh();
			};
			const onNavigate = (nextId: string) => {
				const nextUnit = this._kb.getUnit(nextId);
				this._reviewingUnitId = nextId;
				this._editorState     = nextUnit ? defaultUnitEditorState(nextUnit) : undefined;
				this.refresh();
			};

			// Hide tab bar while editor is open
			this._tabBarEl.style.display = 'none';

			const view = buildUnitEditorView(
				unitId, this._kb, this._tools,
				this._editorState!,
				onBack, onNavigate, onRefresh,
				this._validation,
			);
			view.style.flex    = '1';
			view.style.overflow = 'hidden';
			this._contentEl.appendChild(view);
			return;
		}

		// ── Normal tab bar visible ────────────────────────────────────────
		this._tabBarEl.style.display = '';

		let view: HTMLElement;

		switch (this._activeTab) {
			case 'unit-index':
				view = buildUnitIndexView(
					this._kb, this._tools, this._unitIndexState, onRefresh,
					(unitId) => this.openUnitEditor(unitId),
				);
				break;

			case 'pending':
				view = buildPendingDecisionsView(this._kb, this._tools, onRefresh);
				break;

			case 'decision-log':
				view = buildDecisionLogView(this._kb, this._tools, this._decisionLogState, onRefresh);
				break;

			case 'progress':
				view = buildProgressView(this._kb, this._validation, onRefresh, this._cutover, this._autonomy, this._grcSnapshot);
				break;

			default:
				view = $e('div', 'padding:24px;');
				view.appendChild($t('span', 'Unknown tab', 'color:var(--vscode-descriptionForeground);'));
				break;
		}

		view.style.flex = '1';
		view.style.overflow = 'hidden';
		this._contentEl.appendChild(view);
	}
}
