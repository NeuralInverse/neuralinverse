/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit Editor View \u2014 Phase 8: Two-window editor (production).
 *
 * Side-by-side source \u2194 translated code review panel, rendered entirely inside
 * the Modernisation aux window (Cmd+Alt+M). Zero impact on VS Code's normal
 * editor, tabs, or workspace \u2014 pure DOM component.
 *
 * Layout:
 *   \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510
 *   \u2502 Header: name · status · risk · lang pair · tags · nav · queue pos  \u2502
 *   \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
 *   \u2502 Banners: lock warning · source drift · stale unit                  \u2502
 *   \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
 *   \u2502 [Fingerprint Divergences \u2014 only when unit.status === 'flagged']    \u2502
 *   \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
 *   \u2502 [Compliance gate failures \u2014 shown before/after approve attempt]    \u2502
 *   \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
 *   \u2502 Pane controls: split [30|50|70] · Word Wrap · Show Original        \u2502
 *   \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
 *   \u2502  SOURCE (read-only)         \u2502  TRANSLATED (editable / diff view)   \u2502
 *   \u2502  + line numbers             \u2502  + line numbers                      \u2502
 *   \u2502  + copy button              \u2502  + dirty indicator + diff count      \u2502
 *   \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
 *   \u2502 [\u25BC Bottom panel] Rules | Decisions | Annotations | History         \u2502
 *   \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
 *   \u2502 [Change request form \u2014 inline, shown on demand]                    \u2502
 *   \u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524
 *   \u2502 Action bar: Approve · Save Edits · Request Changes · Skip · Batch  \u2502
 *   \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518
 *
 * Production features:
 *   - Advisory unit locking: acquires lock on open, releases on back/navigate
 *   - Compliance gate: auto-checked on first render, blocks approve if failing
 *   - Fingerprint divergences: full panel with severity badges for 'flagged' units
 *   - Line numbers in both source and target panes with scroll sync
 *   - Word wrap toggle (both panes together)
 *   - Split layout buttons: 30/70, 50/50, 70/30
 *   - Show-original toggle: diff view (original AI output vs human edits)
 *   - Bottom panel: Business Rules | Applied Decisions | Annotations | Audit History
 *   - Inline annotation add form with kind selector
 *   - Tags and work-package display in header
 *   - Source drift warning banner
 *   - Stale unit warning banner (stuck in review > 24h)
 *   - Keyboard shortcuts: Ctrl+Enter = approve, Esc = back to index
 *   - Batch approve: approve all 'review' units in queue at once
 *   - Correct AnnotationKind: 'review-note' (not 'reviewer-note')
 *   - Review queue stats: X flagged, Y in review, Z approved
 */

import {
	IKnowledgeBaseService,
	IUnitTag,
	IComplianceGateResult,
	IWorkPackage,
} from '../../knowledgeBase/service.js';
import { IModernisationAgentToolService } from '../../engine/agentTools/service.js';
import { IValidationEngineService } from '../../engine/validation/service.js';
import {
	IKnowledgeUnit,
	IDecisionLog,
	AnnotationKind,
	IKnowledgeAuditEntry,
} from '../../../common/knowledgeBaseTypes.js';
import { IApprovalRecord } from '../../../common/modernisationTypes.js';
import {
	$e, $t, $btn, $textarea, $select,
	$statusBadge, $riskBadge, $divider,
	relativeTime, truncate, basename,
} from '../console/consoleHelpers.js';


// \u2500\u2500\u2500 Constants \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const LOCK_OWNER_PREFIX = 'human-reviewer-';
/** How long (ms) a unit must be in 'review'/'flagged' before we show the stale warning. */
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

const DIVERGENCE_COLOR: Record<string, string> = {
	blocking: 'var(--vscode-inputValidation-errorBorder,#f44336)',
	warning:  '#e0a84e',
	info:     '#64b5f6',
};

const ANNOTATION_KIND_OPTIONS: Array<{ value: AnnotationKind; label: string }> = [
	{ value: 'review-note',       label: 'Review Note' },
	{ value: 'blocker',           label: 'Blocker' },
	{ value: 'compliance-note',   label: 'Compliance Note' },
	{ value: 'context-injection', label: 'Context Injection' },
];


// \u2500\u2500\u2500 Bottom panel tab \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

type BottomPanelTab = 'rules' | 'decisions' | 'annotations' | 'history' | 'validation';


// \u2500\u2500\u2500 State \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IUnitEditorState {
	// Editing
	editedTarget:      string;
	changeNote:        string;
	annotationDraft:   string;
	annotationKind:    AnnotationKind;

	// UI
	busy:              boolean;
	error:             string;
	successMsg:        string;
	showChangeForm:    boolean;
	wordWrap:          boolean;
	showOriginal:      boolean;   // diff view: show original AI translation
	leftPct:           number;    // split position 20\u201380, default 50
	bottomTab:         BottomPanelTab;
	bottomCollapsed:   boolean;
	showBatchConfirm:  boolean;

	// Locking
	lockOwnerId:       string | undefined;
	lockAcquired:      boolean;
	lockConflict:      string | undefined; // ownerId holding the lock if we failed

	// Compliance gate (lazy)
	complianceResult:  IComplianceGateResult | undefined;
	complianceChecked: boolean;

	// Validation (Phase 10)
	validationBusy:    boolean;
	validationError:   string;
	showOverrideForm:  boolean;
	overrideRationale: string;
	overrideTicketRef: string;
}

export function defaultUnitEditorState(unit: IKnowledgeUnit): IUnitEditorState {
	return {
		editedTarget:     unit.targetText ?? '',
		changeNote:       '',
		annotationDraft:  '',
		annotationKind:   'review-note',
		busy:             false,
		error:            '',
		successMsg:       '',
		showChangeForm:   false,
		wordWrap:         false,
		showOriginal:     false,
		leftPct:          50,
		bottomTab:        'rules',
		bottomCollapsed:  false,
		showBatchConfirm: false,
		lockOwnerId:      undefined,
		lockAcquired:     false,
		lockConflict:     undefined,
		complianceResult:  undefined,
		complianceChecked: false,
		validationBusy:    false,
		validationError:   '',
		showOverrideForm:  false,
		overrideRationale: '',
		overrideTicketRef: '',
	};
}


// \u2500\u2500\u2500 Main entry \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function buildUnitEditorView(
	unitId:     string,
	kb:         IKnowledgeBaseService,
	tools:      IModernisationAgentToolService,
	state:      IUnitEditorState,
	onBack:     () => void,
	onNavigate: (unitId: string) => void,
	onRefresh:  () => void,
	validation?: IValidationEngineService,
): HTMLElement {

	const root = $e('div', [
		'display:flex', 'flex-direction:column',
		'height:100%', 'overflow:hidden',
		'background:var(--vscode-editor-background)',
	].join(';'));

	// \u2500\u2500 1. Acquire advisory lock (once per unit) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (!state.lockOwnerId) {
		const ownerId = LOCK_OWNER_PREFIX + Math.random().toString(36).slice(2, 8);
		state.lockOwnerId = ownerId;
		const lock = kb.lockUnit(unitId, ownerId, 0); // indefinite
		state.lockAcquired = !!lock;
		if (!lock) {
			const existing = kb.getLock(unitId);
			state.lockConflict = existing?.ownerId;
		}
	}

	// \u2500\u2500 2. Run compliance gate once (sync, before first render) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (!state.complianceChecked && kb.isActive) {
		const gateResult = kb.checkComplianceGate(unitId);
		state.complianceResult = gateResult;
		state.complianceChecked = true;
	}

	const unit = kb.getUnit(unitId);
	if (!unit) {
		const err = $e('div', 'flex:1;display:flex;align-items:center;justify-content:center;');
		err.appendChild($t('span', 'Unit "' + unitId + '" not found in knowledge base.',
			'font-size:12px;color:var(--vscode-descriptionForeground);'));
		root.appendChild(err);
		const backBar = $e('div', 'padding:10px 14px;flex-shrink:0;border-top:1px solid var(--vscode-panel-border);');
		backBar.appendChild($btn('\u2190 Back to Index', false, () => { _releaseLock(unitId, state, kb); onBack(); }, 'font-size:11px;'));
		root.appendChild(backBar);
		return root;
	}

	// \u2500\u2500 Callbacks that release the lock before navigating \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const onBackWithLock = () => { _releaseLock(unitId, state, kb); onBack(); };
	const onNavigateWithLock = (nextId: string) => { _releaseLock(unitId, state, kb); onNavigate(nextId); };

	// \u2500\u2500 Navigation context \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const reviewQueue = _buildReviewQueue(kb);
	const idx         = reviewQueue.findIndex(u => u.id === unitId);
	const prevUnit    = idx > 0                      ? reviewQueue[idx - 1] : undefined;
	const nextUnit    = idx < reviewQueue.length - 1 ? reviewQueue[idx + 1] : undefined;

	// \u2500\u2500 Fetch contextual data \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const tags         = kb.getTagsForUnit(unitId);
	const workPackage  = kb.getWorkPackageForUnit(unitId);
	const staleReports = kb.getStaleUnits(STALE_THRESHOLD_MS).filter(r => r.unitId === unitId);
	const driftAlerts  = kb.getDriftAlerts(true).filter(a => a.filePath === unit.sourceFile);
	const isDrift      = driftAlerts.length > 0;
	const isStale      = staleReports.length > 0;
	const isLockConflict = !state.lockAcquired && !!state.lockConflict;

	// \u2500\u2500 Header \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	root.appendChild(_buildHeader(
		unit, idx, reviewQueue, tags, workPackage,
		prevUnit, nextUnit, onNavigateWithLock, onBackWithLock,
	));

	// \u2500\u2500 Banners \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (isLockConflict) {
		root.appendChild(_buildBanner(
			'\u{1F512} This unit is being edited by another process (' + (state.lockConflict ?? 'unknown') + '). Your changes may conflict.',
			'#e0a84e',
		));
	}
	if (isDrift) {
		root.appendChild(_buildBanner(
			'\u26A0 Source file has changed since last scan. This translation may be out of date. Re-scan recommended.',
			'var(--vscode-inputValidation-errorBorder,#f44336)',
		));
	}
	if (isStale) {
		const stale = staleReports[0];
		const hours = Math.round(stale.stuckSinceMs / 3_600_000);
		root.appendChild(_buildBanner(
			'\u23F0 This unit has been in "' + unit.status + '" for ' + hours + 'h without action.',
			'#64b5f6',
		));
	}

	// \u2500\u2500 Feedback bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (state.error) {
		root.appendChild($t('div', '\u2715  ' + state.error, [
			'padding:6px 16px', 'font-size:11px', 'flex-shrink:0',
			'background:rgba(244,67,54,0.08)',
			'color:var(--vscode-inputValidation-errorBorder,#f44336)',
			'border-bottom:1px solid rgba(244,67,54,0.3)',
		].join(';')));
	}
	if (state.successMsg) {
		root.appendChild($t('div', '\u2713  ' + state.successMsg, [
			'padding:6px 16px', 'font-size:11px', 'flex-shrink:0',
			'background:rgba(76,175,80,0.08)',
			'color:var(--vscode-terminal-ansiGreen,#4caf50)',
			'border-bottom:1px solid rgba(76,175,80,0.25)',
		].join(';')));
	}

	// \u2500\u2500 Fingerprint divergence panel (flagged units) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (unit.status === 'flagged' && unit.fingerprintComparison) {
		root.appendChild(_buildFingerprintDivergencePanel(unit.fingerprintComparison));
	}

	// \u2500\u2500 Compliance gate failure panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (state.complianceResult && state.complianceResult.overallStatus === 'fail') {
		root.appendChild(_buildComplianceFailurePanel(state.complianceResult));
	}

	// \u2500\u2500 Pane controls row \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	root.appendChild(_buildPaneControlsRow(unit, state, onRefresh));

	// \u2500\u2500 Two-pane editor area \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const panesRow = $e('div', 'flex:1;display:flex;overflow:hidden;min-height:0;');
	root.appendChild(panesRow);

	panesRow.appendChild(_buildSourcePane(unit, state));
	panesRow.appendChild(_buildResizeHandle(state, onRefresh));
	panesRow.appendChild(_buildTargetPane(unit, state, onRefresh));

	// \u2500\u2500 Bottom panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	root.appendChild(_buildBottomPanel(unitId, unit, kb, tools, state, onRefresh, validation));

	// \u2500\u2500 Batch approve confirmation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (state.showBatchConfirm) {
		root.appendChild(_buildBatchApprovePanel(reviewQueue, kb, tools, state, onBackWithLock, onRefresh));
	}

	// \u2500\u2500 Change request form \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (state.showChangeForm && !state.showBatchConfirm) {
		root.appendChild(_buildChangeRequestForm(unit, state, tools, onRefresh));
	}

	// \u2500\u2500 Action bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	root.appendChild(_buildActionBar(
		unit, state, kb, tools,
		prevUnit, nextUnit,
		reviewQueue,
		onNavigateWithLock, onBackWithLock, onRefresh,
		validation,
	));

	// \u2500\u2500 Keyboard shortcuts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	root.setAttribute('tabindex', '0');
	root.addEventListener('keydown', (e: KeyboardEvent) => {
		if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			_doApprove(unit, state, kb, tools, nextUnit?.id, onNavigateWithLock, onRefresh);
		}
		if (e.key === 'Escape' && !state.showChangeForm && !state.showBatchConfirm) {
			e.preventDefault();
			onBackWithLock();
		}
		if (e.key === 'Escape' && (state.showChangeForm || state.showBatchConfirm)) {
			e.preventDefault();
			state.showChangeForm  = false;
			state.showBatchConfirm = false;
			onRefresh();
		}
	});

	return root;
}


// \u2500\u2500\u2500 Review queue \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildReviewQueue(kb: IKnowledgeBaseService): IKnowledgeUnit[] {
	if (!kb.isActive) { return []; }
	const all     = kb.getAllUnits();
	const flagged  = all.filter(u => u.status === 'flagged');
	const review   = all.filter(u => u.status === 'review');
	const approved = all.filter(u => u.status === 'approved');
	return [...flagged, ...review, ...approved];
}


// \u2500\u2500\u2500 Generic banner \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildBanner(text: string, color: string): HTMLElement {
	return $t('div', text, [
		'padding:5px 14px', 'font-size:11px', 'flex-shrink:0',
		`background:${color}18`,
		`color:${color}`,
		`border-bottom:1px solid ${color}44`,
		'line-height:1.5',
	].join(';'));
}


// \u2500\u2500\u2500 Fingerprint divergence panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildFingerprintDivergencePanel(
	comparison: NonNullable<IKnowledgeUnit['fingerprintComparison']>,
): HTMLElement {
	const panel = $e('div', [
		'flex-shrink:0', 'border-bottom:2px solid var(--vscode-inputValidation-errorBorder,#f44336)',
		'background:rgba(244,67,54,0.04)',
	].join(';'));

	const hdr = $e('div', [
		'display:flex', 'align-items:center', 'gap:8px',
		'padding:6px 14px',
		'background:rgba(244,67,54,0.08)',
	].join(';'));
	hdr.appendChild($t('span', '\u{1F6A8} FINGERPRINT DIVERGENCE', [
		'font-size:10px', 'font-weight:700', 'letter-spacing:0.07em',
		'color:var(--vscode-inputValidation-errorBorder,#f44336)',
	].join(';')));
	hdr.appendChild($t('span', 'Match: ' + comparison.matchPercentage + '%', [
		'font-size:10px', 'color:var(--vscode-descriptionForeground)',
	].join(';')));
	hdr.appendChild($t('span', comparison.overallResult.toUpperCase(), [
		'font-size:9px', 'font-weight:700', 'padding:1px 6px', 'border-radius:8px',
		comparison.overallResult === 'blocked'
			? 'background:rgba(244,67,54,0.2);color:var(--vscode-inputValidation-errorBorder,#f44336);'
			: 'background:rgba(224,168,78,0.2);color:#e0a84e;',
	].join(';')));
	panel.appendChild(hdr);

	const list = $e('div', 'padding:6px 14px 8px;display:flex;flex-direction:column;gap:4px;max-height:120px;overflow-y:auto;');
	for (const div of comparison.divergences) {
		const color = DIVERGENCE_COLOR[div.severity] ?? '#888';
		const row = $e('div', 'display:flex;align-items:flex-start;gap:6px;');
		row.appendChild($t('span', div.severity.toUpperCase(), [
			'font-size:8px', 'font-weight:700', 'padding:1px 4px', 'border-radius:3px',
			`background:${color}22;color:${color};border:1px solid ${color}55;`,
			'flex-shrink:0', 'margin-top:1px',
		].join(';')));
		row.appendChild($t('span', '[' + div.type + '] ' + div.description, [
			'font-size:11px', 'color:var(--vscode-editor-foreground)', 'line-height:1.5',
		].join(';')));
		list.appendChild(row);
	}
	if (comparison.divergences.length === 0) {
		list.appendChild($t('span', 'No divergences recorded.', 'font-size:11px;color:var(--vscode-descriptionForeground);'));
	}
	panel.appendChild(list);
	return panel;
}


// \u2500\u2500\u2500 Compliance gate failure panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildComplianceFailurePanel(gate: IComplianceGateResult): HTMLElement {
	const panel = $e('div', [
		'flex-shrink:0',
		'background:rgba(224,168,78,0.06)',
		'border-bottom:1px solid rgba(224,168,78,0.4)',
	].join(';'));

	const hdr = $e('div', 'padding:5px 14px;display:flex;align-items:center;gap:8px;');
	hdr.appendChild($t('span', '\u26D4 COMPLIANCE GATE: ' + gate.overallStatus.toUpperCase(), [
		'font-size:10px', 'font-weight:700', 'letter-spacing:0.07em', 'color:#e0a84e',
	].join(';')));
	hdr.appendChild($t('span',
		gate.failedCount + ' failed, ' + gate.passedCount + ' passed, ' + gate.pendingCount + ' pending',
		'font-size:10px;color:var(--vscode-descriptionForeground);'));
	panel.appendChild(hdr);

	if (gate.blockerReasons.length > 0) {
		const reasonsList = $e('div', 'padding:0 14px 6px;display:flex;flex-direction:column;gap:2px;');
		for (const r of gate.blockerReasons) {
			reasonsList.appendChild($t('div', '\u2022 ' + r, 'font-size:11px;color:#e0a84e;line-height:1.5;'));
		}
		panel.appendChild(reasonsList);
	}

	return panel;
}


// \u2500\u2500\u2500 Header \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildHeader(
	unit:        IKnowledgeUnit,
	idx:         number,
	queue:       IKnowledgeUnit[],
	tags:        IUnitTag[],
	workPackage: IWorkPackage | undefined,
	prevUnit:    IKnowledgeUnit | undefined,
	nextUnit:    IKnowledgeUnit | undefined,
	onNavigate:  (id: string) => void,
	onBack:      () => void,
): HTMLElement {
	const hdr = $e('div', [
		'flex-shrink:0',
		'background:var(--vscode-sideBarSectionHeader-background)',
		'border-bottom:1px solid var(--vscode-panel-border)',
	].join(';'));

	// \u2500\u2500 Row 1: back · name · badges · lang pair · nav \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const row1 = $e('div', [
		'display:flex', 'align-items:center', 'flex-wrap:wrap', 'gap:6px',
		'padding:7px 12px',
	].join(';'));

	// Back button
	row1.appendChild($btn('\u2190 Index', false, onBack, 'font-size:10px;padding:3px 8px;'));

	// Unit name
	row1.appendChild($t('span', unit.name, [
		'font-size:12px', 'font-weight:700', 'color:var(--vscode-editor-foreground)',
		'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis', 'max-width:280px',
	].join(';')));

	row1.appendChild($statusBadge(unit.status));
	row1.appendChild($riskBadge(unit.riskLevel));

	// Unit type badge
	row1.appendChild($t('span', unit.unitType, [
		'font-size:9px', 'font-weight:600', 'padding:1px 5px', 'border-radius:3px',
		'background:var(--vscode-badge-background)', 'color:var(--vscode-badge-foreground)',
		'white-space:nowrap',
	].join(';')));

	// Language pair
	const targetLang = unit.targetFile ? _inferTargetLang(unit.targetFile) : '?';
	row1.appendChild($t('span',
		(unit.sourceLang ?? '?').toUpperCase() + ' \u2192 ' + targetLang.toUpperCase(),
		[
			'font-size:10px', 'font-weight:600', 'padding:2px 7px', 'border-radius:8px',
			'background:rgba(100,181,246,0.12)', 'color:#64b5f6',
			'border:1px solid rgba(100,181,246,0.3)',
			'white-space:nowrap', 'flex-shrink:0',
		].join(';')));

	// Tags
	for (const tag of tags) {
		row1.appendChild($t('span', tag.name, [
			'font-size:9px', 'padding:1px 5px', 'border-radius:8px',
			tag.color ? `background:${tag.color}22;color:${tag.color};border:1px solid ${tag.color}44;` : '',
			'white-space:nowrap',
		].join(';')));
	}

	// Work package
	if (workPackage) {
		row1.appendChild($t('span', '\u{1F4E6} ' + workPackage.label, [
			'font-size:9px', 'color:var(--vscode-descriptionForeground)', 'white-space:nowrap',
		].join(';')));
	}

	// Spacer
	row1.appendChild($e('div', 'flex:1;'));

	// Nav: prev / position / next
	const navGroup = $e('div', 'display:flex;align-items:center;gap:4px;flex-shrink:0;');
	const prevBtn  = $btn('\u2039', false, () => prevUnit && onNavigate(prevUnit.id), 'padding:2px 7px;font-size:13px;');
	if (!prevUnit) { (prevBtn as HTMLButtonElement).disabled = true; prevBtn.style.opacity = '0.35'; }
	navGroup.appendChild(prevBtn);
	navGroup.appendChild($t('span',
		queue.length > 0 ? (idx + 1) + ' / ' + queue.length : '\u2014',
		'font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;padding:0 4px;',
	));
	const nextBtn = $btn('\u203a', false, () => nextUnit && onNavigate(nextUnit.id), 'padding:2px 7px;font-size:13px;');
	if (!nextUnit) { (nextBtn as HTMLButtonElement).disabled = true; nextBtn.style.opacity = '0.35'; }
	navGroup.appendChild(nextBtn);
	row1.appendChild(navGroup);
	hdr.appendChild(row1);

	// \u2500\u2500 Row 2: meta strip \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const row2 = $e('div', [
		'display:flex', 'align-items:center', 'gap:12px', 'flex-wrap:wrap',
		'padding:2px 12px 5px',
		'font-size:10px', 'color:var(--vscode-descriptionForeground)',
	].join(';'));

	// Queue stats
	const flaggedCount  = queue.filter(u => u.status === 'flagged').length;
	const reviewCount   = queue.filter(u => u.status === 'review').length;
	const approvedCount = queue.filter(u => u.status === 'approved').length;
	if (flaggedCount > 0) {
		row2.appendChild($t('span', flaggedCount + ' flagged', 'color:var(--vscode-inputValidation-errorBorder,#f44336);font-weight:600;'));
	}
	if (reviewCount > 0) {
		row2.appendChild($t('span', reviewCount + ' in review', 'color:#9c64fa;font-weight:600;'));
	}
	if (approvedCount > 0) {
		row2.appendChild($t('span', approvedCount + ' approved', 'color:#ab47bc;'));
	}

	// Domain
	if (unit.domain) { row2.appendChild($t('span', 'domain: ' + unit.domain)); }

	// Phase
	if (unit.phaseId) { row2.appendChild($t('span', 'phase: ' + unit.phaseId)); }

	// Files
	row2.appendChild($t('span', 'src: ' + basename(unit.sourceFile), 'font-family:var(--vscode-editor-font-family,monospace);'));
	if (unit.targetFile) {
		row2.appendChild($t('span', 'dst: ' + basename(unit.targetFile), 'font-family:var(--vscode-editor-font-family,monospace);'));
	}

	// Updated
	if (unit.updatedAt) { row2.appendChild($t('span', 'updated ' + relativeTime(unit.updatedAt))); }

	// Approvals count
	if (unit.approvals?.length > 0) {
		row2.appendChild($t('span', unit.approvals.length + ' approval' + (unit.approvals.length !== 1 ? 's' : '')));
	}

	hdr.appendChild(row2);
	return hdr;
}


// \u2500\u2500\u2500 Pane controls row \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildPaneControlsRow(
	unit:      IKnowledgeUnit,
	state:     IUnitEditorState,
	onRefresh: () => void,
): HTMLElement {
	const row = $e('div', [
		'display:flex', 'align-items:center', 'flex-wrap:wrap', 'gap:6px',
		'padding:4px 10px', 'flex-shrink:0',
		'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
		'border-bottom:1px solid var(--vscode-panel-border)',
	].join(';'));

	row.appendChild($t('span', 'Split:', 'font-size:10px;color:var(--vscode-descriptionForeground);'));
	for (const [pct, label] of [[30, '30/70'], [50, '50/50'], [70, '70/30']] as [number, string][]) {
		const isActive = state.leftPct === pct;
		const btn = $btn(label, false, () => { state.leftPct = pct; onRefresh(); },
			'font-size:9px;padding:2px 6px;' + (isActive ? 'opacity:1;font-weight:700;' : 'opacity:0.6;'));
		row.appendChild(btn);
	}

	row.appendChild($divider());

	const wrapBtn = $btn(state.wordWrap ? '\u{1F4D4} Wrap: ON' : '\u{1F4D4} Wrap: OFF', false,
		() => { state.wordWrap = !state.wordWrap; onRefresh(); }, 'font-size:9px;padding:2px 7px;');
	row.appendChild(wrapBtn);

	// Show original toggle (only when there are human edits)
	const isDirty = state.editedTarget !== (unit.targetText ?? '');
	if (isDirty || state.showOriginal) {
		row.appendChild($divider());
		const origBtn = $btn(
			state.showOriginal ? 'Edit Mode' : 'Show Original (diff)',
			false,
			() => { state.showOriginal = !state.showOriginal; onRefresh(); },
			'font-size:9px;padding:2px 7px;',
		);
		row.appendChild(origBtn);
	}

	// Diff stats
	if (isDirty && unit.targetText) {
		row.appendChild($divider());
		const stats = _computeDiffStats(unit.targetText, state.editedTarget);
		row.appendChild($t('span',
			'+' + stats.added + ' / -' + stats.removed + ' lines',
			'font-size:9px;color:#e0a84e;font-weight:600;',
		));
	}

	return row;
}


// \u2500\u2500\u2500 Source pane (read-only with line numbers) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildSourcePane(unit: IKnowledgeUnit, state: IUnitEditorState): HTMLElement {
	const pane = $e('div', `flex:${state.leftPct};display:flex;flex-direction:column;overflow:hidden;min-width:0;`);

	// Pane header
	const ph = $e('div', [
		'display:flex', 'align-items:center', 'gap:8px', 'padding:4px 10px', 'flex-shrink:0',
		'background:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-sideBar-background))',
		'border-bottom:1px solid var(--vscode-panel-border)',
	].join(';'));
	ph.appendChild($t('span', 'SOURCE', [
		'font-size:9px', 'font-weight:700', 'letter-spacing:0.08em',
		'color:var(--vscode-descriptionForeground)',
	].join(';')));
	ph.appendChild($t('span', (unit.sourceLang ?? '?').toUpperCase(), [
		'font-size:9px', 'padding:1px 5px', 'border-radius:3px',
		'background:var(--vscode-badge-background)', 'color:var(--vscode-badge-foreground)',
	].join(';')));
	ph.appendChild($t('span', basename(unit.sourceFile), [
		'font-size:10px', 'color:var(--vscode-descriptionForeground)',
		'font-family:var(--vscode-editor-font-family,monospace)',
		'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap', 'flex:1',
	].join(';')));

	// Copy button
	const copyBtn = $btn('Copy', false, () => {
		const text = unit.resolvedSource || unit.sourceText || '';
		navigator.clipboard?.writeText(text).catch(() => { /* ignore */ });
		copyBtn.textContent = 'Copied!';
		setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
	}, 'font-size:9px;padding:2px 6px;flex-shrink:0;');
	ph.appendChild(copyBtn);
	ph.appendChild($t('span', 'READ ONLY', 'font-size:8px;color:var(--vscode-descriptionForeground);opacity:0.45;'));
	pane.appendChild(ph);

	// Code with line numbers
	const codeArea = $e('div', 'flex:1;overflow:auto;display:flex;min-height:0;');
	const sourceText = unit.resolvedSource || unit.sourceText || '';
	codeArea.appendChild(_buildLineNumberedPre(sourceText, state.wordWrap));
	pane.appendChild(codeArea);

	// Stats strip
	const lines = sourceText.split('\n').length;
	const statsEl = $e('div', [
		'display:flex', 'gap:12px', 'padding:3px 10px', 'flex-shrink:0',
		'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
		'border-top:1px solid var(--vscode-panel-border)',
		'font-size:10px', 'color:var(--vscode-descriptionForeground)',
	].join(';'));
	statsEl.appendChild($t('span', lines + ' lines'));
	if (unit.businessRules?.length) { statsEl.appendChild($t('span', unit.businessRules.length + ' rules')); }
	if (unit.dependsOn?.length)     { statsEl.appendChild($t('span', unit.dependsOn.length + ' deps')); }
	if (unit.fingerprint)           { statsEl.appendChild($t('span', '\u{1F4CB} fingerprinted', 'color:#64b5f6;')); }
	if (unit.resolvedSource && unit.resolvedSource !== unit.sourceText) {
		statsEl.appendChild($t('span', '(showing resolved source)', 'opacity:0.6;'));
	}
	pane.appendChild(statsEl);

	return pane;
}


// \u2500\u2500\u2500 Target pane (editable with line numbers) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildTargetPane(
	unit:      IKnowledgeUnit,
	state:     IUnitEditorState,
	onRefresh: () => void,
): HTMLElement {
	const remaining = 100 - state.leftPct;
	const pane = $e('div', `flex:${remaining};display:flex;flex-direction:column;overflow:hidden;min-width:0;`);

	const targetLang = unit.targetFile ? _inferTargetLang(unit.targetFile) : '?';
	const isDirty    = state.editedTarget !== (unit.targetText ?? '');

	// Pane header
	const ph = $e('div', [
		'display:flex', 'align-items:center', 'gap:8px', 'padding:4px 10px', 'flex-shrink:0',
		'background:var(--vscode-editorGroupHeader-tabsBackground,var(--vscode-sideBar-background))',
		'border-bottom:1px solid var(--vscode-panel-border)',
	].join(';'));

	ph.appendChild($t('span', state.showOriginal ? 'ORIGINAL (AI)' : 'TRANSLATED', [
		'font-size:9px', 'font-weight:700', 'letter-spacing:0.08em',
		state.showOriginal ? 'color:#e0a84e;' : 'color:var(--vscode-terminal-ansiGreen,#4caf50);',
	].join(';')));
	ph.appendChild($t('span', targetLang.toUpperCase(), [
		'font-size:9px', 'padding:1px 5px', 'border-radius:3px',
		state.showOriginal
			? 'background:rgba(224,168,78,0.15);color:#e0a84e;border:1px solid rgba(224,168,78,0.3);'
			: 'background:rgba(76,175,80,0.12);color:var(--vscode-terminal-ansiGreen,#4caf50);border:1px solid rgba(76,175,80,0.25);',
	].join(';')));

	if (unit.targetFile) {
		ph.appendChild($t('span', basename(unit.targetFile), [
			'font-size:10px', 'color:var(--vscode-descriptionForeground)',
			'font-family:var(--vscode-editor-font-family,monospace)',
			'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap', 'flex:1',
		].join(';')));
	} else {
		ph.appendChild($e('div', 'flex:1;'));
	}

	if (isDirty && !state.showOriginal) {
		ph.appendChild($t('span', '\u25cf unsaved', 'font-size:9px;color:#e0a84e;font-weight:700;'));
	}
	ph.appendChild($t('span', state.showOriginal ? 'READ ONLY' : 'EDITABLE',
		'font-size:8px;color:var(--vscode-descriptionForeground);opacity:0.45;'));
	pane.appendChild(ph);

	// Code area
	const codeArea = $e('div', 'flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0;');

	if (state.showOriginal && unit.targetText) {
		// Diff view: show original AI output with diff highlighting
		const diffLines = _computeDiffLines(unit.targetText, state.editedTarget);
		codeArea.appendChild(_buildDiffPre(diffLines, state.wordWrap));
	} else if (!unit.targetText && !state.editedTarget) {
		// No translation yet
		const empty = $e('div', [
			'flex:1', 'display:flex', 'flex-direction:column',
			'align-items:center', 'justify-content:center',
			'padding:32px', 'gap:8px', 'text-align:center',
		].join(';'));
		empty.appendChild($t('div', '\u{1F916}', 'font-size:28px;opacity:0.18;'));
		empty.appendChild($t('div', 'No translation yet',
			'font-size:13px;font-weight:600;color:var(--vscode-editor-foreground);'));
		empty.appendChild($t('div',
			'The AI has not translated this unit yet. Run the translation engine to populate this pane.',
			'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;max-width:300px;'));
		codeArea.appendChild(empty);
	} else {
		// Editable textarea with line numbers
		codeArea.appendChild(_buildLineNumberedTextarea(
			state.editedTarget || unit.targetText || '',
			'Start typing the translation\u2026',
			(val) => { state.editedTarget = val; },
			state.wordWrap,
		));
	}
	pane.appendChild(codeArea);

	// Stats strip
	const targetText  = state.editedTarget || unit.targetText || '';
	const targetLines = targetText ? targetText.split('\n').length : 0;
	const statsEl = $e('div', [
		'display:flex', 'gap:12px', 'padding:3px 10px', 'flex-shrink:0',
		'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
		'border-top:1px solid var(--vscode-panel-border)',
		'font-size:10px', 'color:var(--vscode-descriptionForeground)',
	].join(';'));
	if (targetLines > 0) {
		statsEl.appendChild($t('span', targetLines + ' lines'));
		const ratio = unit.sourceText
			? (targetLines / Math.max(1, unit.sourceText.split('\n').length) * 100).toFixed(0) + '% of source'
			: '';
		if (ratio) { statsEl.appendChild($t('span', ratio)); }
	}
	if (isDirty) { statsEl.appendChild($t('span', '\u25cf unsaved changes', 'color:#e0a84e;font-weight:600;')); }
	pane.appendChild(statsEl);

	return pane;
}


// \u2500\u2500\u2500 Resize handle \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildResizeHandle(state: IUnitEditorState, onRefresh: () => void): HTMLElement {
	const handle = $e('div', [
		'width:5px', 'flex-shrink:0', 'cursor:col-resize',
		'background:var(--vscode-panel-border)',
		'position:relative',
		'transition:background 0.15s',
	].join(';'));
	handle.title = 'Drag to resize panes';

	let dragging = false;
	let startX   = 0;
	let startPct = 0;

	handle.addEventListener('mouseenter', () => {
		if (!dragging) { handle.style.background = 'var(--vscode-focusBorder,#6496fa)'; }
	});
	handle.addEventListener('mouseleave', () => {
		if (!dragging) { handle.style.background = 'var(--vscode-panel-border)'; }
	});
	handle.addEventListener('mousedown', (e: MouseEvent) => {
		dragging = true;
		startX   = e.clientX;
		startPct = state.leftPct;
		handle.style.background = 'var(--vscode-focusBorder,#6496fa)';
		e.preventDefault();

		const onMove = (ev: MouseEvent) => {
			if (!dragging) { return; }
			const parent = handle.parentElement;
			if (!parent) { return; }
			const rect = parent.getBoundingClientRect();
			const delta = ev.clientX - startX;
			const deltaPct = (delta / rect.width) * 100;
			const newPct = Math.min(80, Math.max(20, Math.round(startPct + deltaPct)));
			if (newPct !== state.leftPct) {
				state.leftPct = newPct;
				onRefresh();
			}
		};
		const onUp = () => {
			dragging = false;
			handle.style.background = 'var(--vscode-panel-border)';
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
		};
		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	});

	return handle;
}


// \u2500\u2500\u2500 Bottom panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildBottomPanel(
	unitId:     string,
	unit:       IKnowledgeUnit,
	kb:         IKnowledgeBaseService,
	tools:      IModernisationAgentToolService,
	state:      IUnitEditorState,
	onRefresh:  () => void,
	validation?: IValidationEngineService,
): HTMLElement {
	const PANEL_HEIGHT = '200px';

	const panel = $e('div', [
		'flex-shrink:0',
		state.bottomCollapsed ? 'height:28px;' : 'height:' + PANEL_HEIGHT + ';',
		'display:flex', 'flex-direction:column',
		'border-top:1px solid var(--vscode-panel-border)',
		'overflow:hidden',
	].join(';'));

	// Tab bar
	const hasEquivalenceResult = !!unit.equivalenceResult;
	const tabs: Array<{ id: BottomPanelTab; label: string }> = [
		{ id: 'rules',       label: 'Business Rules (' + (unit.businessRules?.length ?? 0) + ')' },
		{ id: 'decisions',   label: 'Decisions' },
		{ id: 'annotations', label: 'Annotations (' + kb.getAnnotations(unitId).length + ')' },
		{ id: 'history',     label: 'History' },
		...(hasEquivalenceResult || validation
			? [{ id: 'validation' as BottomPanelTab, label: hasEquivalenceResult
				? `Validation (${unit.equivalenceResult!.passCount}/${unit.equivalenceResult!.testCaseCount} pass)`
				: 'Validation' }]
			: []),
	];

	const tabBar = $e('div', [
		'display:flex', 'align-items:stretch', 'flex-shrink:0',
		'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
		'border-bottom:1px solid var(--vscode-panel-border)',
	].join(';'));

	for (const tab of tabs) {
		const isActive = !state.bottomCollapsed && state.bottomTab === tab.id;
		const tabEl = $t('div', tab.label, [
			'padding:4px 12px', 'cursor:pointer', 'font-size:10px', 'font-weight:600',
			'border-bottom:2px solid transparent', 'margin-bottom:-1px',
			'white-space:nowrap', 'user-select:none', 'flex-shrink:0',
			isActive
				? 'color:var(--vscode-focusBorder,#6496fa);border-bottom-color:var(--vscode-focusBorder,#6496fa);'
				: 'color:var(--vscode-descriptionForeground);',
		].join(';'));
		tabEl.addEventListener('click', () => {
			if (state.bottomCollapsed) {
				state.bottomCollapsed = false;
				state.bottomTab = tab.id;
			} else if (state.bottomTab === tab.id) {
				state.bottomCollapsed = true;
			} else {
				state.bottomTab = tab.id;
			}
			onRefresh();
		});
		tabBar.appendChild(tabEl);
	}

	// Spacer + collapse toggle
	tabBar.appendChild($e('div', 'flex:1;'));
	const collapseBtn = $t('div',
		state.bottomCollapsed ? '\u25B2 expand' : '\u25BC collapse',
		'font-size:9px;color:var(--vscode-descriptionForeground);padding:0 10px;cursor:pointer;display:flex;align-items:center;',
	);
	collapseBtn.addEventListener('click', () => { state.bottomCollapsed = !state.bottomCollapsed; onRefresh(); });
	tabBar.appendChild(collapseBtn);
	panel.appendChild(tabBar);

	if (state.bottomCollapsed) { return panel; }

	// Content
	const content = $e('div', 'flex:1;overflow-y:auto;padding:8px 12px;');
	switch (state.bottomTab) {
		case 'rules':
			content.appendChild(_buildRulesTab(unit));
			break;
		case 'decisions':
			content.appendChild(_buildDecisionsTab(unitId, kb));
			break;
		case 'annotations':
			content.appendChild(_buildAnnotationsTab(unitId, kb, tools, state, onRefresh));
			break;
		case 'history':
			content.appendChild(_buildHistoryTab(unitId, kb));
			break;
		case 'validation':
			content.appendChild(_buildValidationTab(unitId, unit, state, validation, onRefresh));
			break;
	}
	panel.appendChild(content);
	return panel;
}


// \u2500\u2500\u2500 Business rules tab \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildRulesTab(unit: IKnowledgeUnit): HTMLElement {
	const wrap = $e('div', 'display:flex;flex-direction:column;gap:5px;');

	if (!unit.businessRules?.length) {
		wrap.appendChild($t('div', 'No business rules extracted for this unit.',
			'font-size:11px;color:var(--vscode-descriptionForeground);'));
		return wrap;
	}

	for (const rule of unit.businessRules) {
		const row = $e('div', [
			'display:flex', 'align-items:flex-start', 'gap:6px', 'padding:4px 6px',
			'border-radius:4px', 'border:1px solid var(--vscode-widget-border)',
			rule.preservationRequired ? 'border-left:3px solid var(--vscode-inputValidation-errorBorder,#f44336);' : '',
		].join(';'));
		const domainBadge = $t('span', rule.domain, [
			'font-size:8px', 'padding:1px 4px', 'border-radius:3px',
			'background:var(--vscode-badge-background)', 'color:var(--vscode-badge-foreground)',
			'white-space:nowrap', 'flex-shrink:0', 'margin-top:1px',
		].join(';'));
		row.appendChild(domainBadge);
		row.appendChild($t('span', rule.description, 'font-size:11px;color:var(--vscode-editor-foreground);line-height:1.5;flex:1;'));
		if (rule.preservationRequired) {
			row.appendChild($t('span', 'MUST PRESERVE', [
				'font-size:8px', 'font-weight:700', 'letter-spacing:0.04em',
				'color:var(--vscode-inputValidation-errorBorder,#f44336)', 'white-space:nowrap', 'flex-shrink:0',
			].join(';')));
		}
		wrap.appendChild(row);
	}

	return wrap;
}


// \u2500\u2500\u2500 Applied decisions tab \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildDecisionsTab(unitId: string, kb: IKnowledgeBaseService): HTMLElement {
	const wrap = $e('div', 'display:flex;flex-direction:column;gap:8px;');
	const log: IDecisionLog = kb.getDecisionsForUnit(unitId);

	const sections: Array<{ label: string; items: unknown[] }> = [
		{ label: 'Type Mappings (' + log.typeMapping.length + ')',      items: log.typeMapping },
		{ label: 'Naming Decisions (' + log.naming.length + ')',        items: log.naming },
		{ label: 'Rule Interpretations (' + log.ruleInterpret.length + ')', items: log.ruleInterpret },
		{ label: 'Pattern Overrides (' + log.patternOverrides.length + ')', items: log.patternOverrides },
	];

	let hasAny = false;
	for (const sec of sections) {
		if (sec.items.length === 0) { continue; }
		hasAny = true;
		wrap.appendChild($t('div', sec.label,
			'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-descriptionForeground);'));

		for (const item of sec.items as any[]) {
			const row = $e('div', [
				'display:flex', 'align-items:flex-start', 'gap:6px',
				'padding:3px 6px', 'border-radius:3px',
				'border:1px solid var(--vscode-widget-border)',
			].join(';'));
			if (item.sourceType) {
				row.appendChild($t('span', item.sourceType + ' \u2192 ' + item.targetType,
					'font-size:11px;font-family:var(--vscode-editor-font-family,monospace);flex:1;'));
				if (item.rationale) {
					row.appendChild($t('span', truncate(item.rationale, 60),
						'font-size:10px;color:var(--vscode-descriptionForeground);'));
				}
			} else if (item.sourceName) {
				row.appendChild($t('span', item.sourceName + ' \u2192 ' + item.targetName,
					'font-size:11px;font-family:var(--vscode-editor-font-family,monospace);flex:1;'));
				if (item.domain) { row.appendChild($t('span', item.domain, 'font-size:10px;color:var(--vscode-descriptionForeground);')); }
			} else if (item.meaning) {
				row.appendChild($t('span', truncate(item.sourceText ?? item.id, 50),
					'font-size:11px;font-family:var(--vscode-editor-font-family,monospace);flex:1;'));
				row.appendChild($t('span', truncate(item.meaning, 80), 'font-size:10px;color:var(--vscode-descriptionForeground);flex:2;'));
			} else if (item.overrideType) {
				row.appendChild($t('span', '[' + item.overrideType + '] ' + item.value,
					'font-size:11px;flex:1;'));
				if (item.rationale) { row.appendChild($t('span', truncate(item.rationale, 60), 'font-size:10px;color:var(--vscode-descriptionForeground);')); }
			}
			wrap.appendChild(row);
		}
	}

	if (!hasAny) {
		wrap.appendChild($t('div', 'No decisions recorded for this unit.',
			'font-size:11px;color:var(--vscode-descriptionForeground);'));
	}

	return wrap;
}


// \u2500\u2500\u2500 Annotations tab \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildAnnotationsTab(
	unitId:    string,
	kb:        IKnowledgeBaseService,
	tools:     IModernisationAgentToolService,
	state:     IUnitEditorState,
	onRefresh: () => void,
): HTMLElement {
	const wrap = $e('div', 'display:flex;flex-direction:column;gap:6px;');
	const annotations = kb.getAnnotations(unitId);

	// Existing annotations
	if (annotations.length === 0) {
		wrap.appendChild($t('div', 'No annotations yet.',
			'font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:6px;'));
	}
	for (const ann of annotations) {
		const KIND_COLOR: Record<string, string> = {
			'review-note':      '#9c64fa',
			'blocker':          'var(--vscode-inputValidation-errorBorder,#f44336)',
			'compliance-note':  '#e0a84e',
			'context-injection':'#64b5f6',
			'agent-note':       '#888',
		};
		const color = KIND_COLOR[ann.kind] ?? '#888';
		const card = $e('div', [
			'border-radius:4px', 'border:1px solid var(--vscode-widget-border)',
			`border-left:3px solid ${color}`,
			'padding:5px 8px',
		].join(';'));
		const cardHdr = $e('div', 'display:flex;align-items:center;gap:6px;margin-bottom:3px;');
		cardHdr.appendChild($t('span', ann.kind, `font-size:9px;font-weight:700;color:${color};`));
		cardHdr.appendChild($t('span', ann.author, 'font-size:9px;color:var(--vscode-descriptionForeground);'));
		cardHdr.appendChild($t('span', relativeTime(ann.createdAt), 'font-size:9px;color:var(--vscode-descriptionForeground);'));
		// Delete button
		const delBtn = $t('span', '\u00D7', [
			'font-size:12px', 'cursor:pointer', 'margin-left:auto',
			'color:var(--vscode-descriptionForeground)', 'opacity:0.5',
			'padding:0 2px', 'line-height:1',
		].join(';'));
		delBtn.title = 'Delete annotation';
		delBtn.addEventListener('click', () => {
			tools.deleteAnnotation({ annotationId: ann.id });
			onRefresh();
		});
		cardHdr.appendChild(delBtn);
		card.appendChild(cardHdr);
		card.appendChild($t('div', ann.content, [
			'font-size:11px', 'color:var(--vscode-editor-foreground)', 'line-height:1.5',
			'white-space:pre-wrap', 'word-break:break-word',
		].join(';')));
		wrap.appendChild(card);
	}

	// Add annotation form
	const formHdr = $t('div', '+ Add Annotation',
		'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-descriptionForeground);margin-top:4px;');
	wrap.appendChild(formHdr);

	const kindSelect = $select(
		ANNOTATION_KIND_OPTIONS,
		state.annotationKind,
		'font-size:10px;padding:2px 6px;',
	);
	kindSelect.addEventListener('change', () => {
		state.annotationKind = kindSelect.value as AnnotationKind;
	});
	wrap.appendChild(kindSelect);

	const draftTa = $textarea('Write your annotation\u2026', 2);
	draftTa.value = state.annotationDraft;
	draftTa.addEventListener('input', () => { state.annotationDraft = draftTa.value; });
	wrap.appendChild(draftTa);

	const addBtn = $btn('Add Annotation', false, () => {
		const content = draftTa.value.trim();
		if (!content) { return; }
		tools.addAnnotation({ unitId, content, author: 'human', kind: state.annotationKind });
		state.annotationDraft = '';
		onRefresh();
	}, 'font-size:10px;padding:3px 10px;margin-top:2px;');
	wrap.appendChild(addBtn);

	return wrap;
}


// \u2500\u2500\u2500 Audit history tab \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildHistoryTab(unitId: string, kb: IKnowledgeBaseService): HTMLElement {
	const wrap = $e('div', 'display:flex;flex-direction:column;gap:3px;');
	const entries: IKnowledgeAuditEntry[] = kb.getAuditLogForUnit(unitId, 20);

	if (entries.length === 0) {
		wrap.appendChild($t('div', 'No audit history for this unit.',
			'font-size:11px;color:var(--vscode-descriptionForeground);'));
		return wrap;
	}

	for (const entry of [...entries].reverse()) {
		const row = $e('div', 'display:flex;align-items:flex-start;gap:6px;padding:2px 0;');
		row.appendChild($t('span', relativeTime(entry.timestamp),
			'font-size:9px;color:var(--vscode-descriptionForeground);white-space:nowrap;width:60px;flex-shrink:0;'));
		row.appendChild($t('span', entry.actorId,
			'font-size:9px;color:var(--vscode-badge-foreground);background:var(--vscode-badge-background);padding:0 3px;border-radius:2px;white-space:nowrap;flex-shrink:0;'));
		row.appendChild($t('span', entry.summary,
			'font-size:11px;color:var(--vscode-editor-foreground);line-height:1.4;flex:1;'));
		wrap.appendChild(row);
	}

	return wrap;
}


// \u2500\u2500\u2500 Validation tab (Phase 10) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const DIVERGENCE_TYPE_LABEL: Record<string, string> = {
	'value':          'Value Mismatch',
	'rounding':       'Rounding Difference',
	'missing-record': 'Missing Record',
	'extra-record':   'Extra Record',
	'checksum':       'Checksum Mismatch',
	'precision':      'Precision Difference',
};

function _buildValidationTab(
	unitId:      string,
	unit:        IKnowledgeUnit,
	state:       IUnitEditorState,
	validation:  IValidationEngineService | undefined,
	onRefresh:   () => void,
): HTMLElement {
	const wrap = $e('div', 'display:flex;flex-direction:column;gap:8px;');

	const equiv = unit.equivalenceResult;

	if (!equiv) {
		// No result yet
		const emptyMsg = $t('div',
			unit.status === 'approved'
				? '\u{1F9EA} No equivalence test has been run for this unit yet. Click "\u{1F9EA} Validate" in the action bar to run the test.'
				: 'Equivalence validation is available for approved units. Approve this unit first.',
			'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;',
		);
		wrap.appendChild(emptyMsg);
		return wrap;
	}

	// \u2500\u2500 Summary row \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const summaryRow = $e('div', 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:6px 0;');

	const passColor   = equiv.failCount === 0 ? 'var(--vscode-terminal-ansiGreen,#4caf50)' : '#e0a84e';
	const statusLabel = equiv.overridden ? 'Overridden' : equiv.failCount === 0 ? 'Passed' : 'Divergences Found';
	const statusColor = equiv.overridden ? '#e0a84e' : equiv.failCount === 0 ? 'var(--vscode-terminal-ansiGreen,#4caf50)' : 'var(--vscode-inputValidation-errorBorder,#f44336)';

	summaryRow.appendChild($t('span', statusLabel, `font-size:11px;font-weight:700;color:${statusColor};`));
	summaryRow.appendChild($t('span', `${equiv.passCount}/${equiv.testCaseCount} test cases passed`, `font-size:11px;color:${passColor};`));
	summaryRow.appendChild($t('span', 'Tested ' + relativeTime(equiv.testedAt), 'font-size:10px;color:var(--vscode-descriptionForeground);'));
	if (equiv.overridden && equiv.overrideApproval) {
		summaryRow.appendChild($t('span',
			`Override by ${equiv.overrideApproval.approvedBy}: ${truncate(equiv.overrideApproval.rationale, 60)}`,
			'font-size:10px;color:#e0a84e;font-style:italic;',
		));
	}
	wrap.appendChild(summaryRow);

	// \u2500\u2500 Divergences (only when there are failures) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (equiv.failCount > 0 && equiv.divergences.length > 0) {
		wrap.appendChild($t('div', 'Divergences', 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-descriptionForeground);margin-top:4px;'));

		for (const div of equiv.divergences) {
			const card = $e('div', [
				'border:1px solid var(--vscode-inputValidation-errorBorder,#f44336)',
				'border-left:3px solid var(--vscode-inputValidation-errorBorder,#f44336)',
				'border-radius:4px', 'padding:6px 8px',
				'background:rgba(244,67,54,0.04)',
				'display:flex', 'flex-direction:column', 'gap:4px',
			].join(';'));

			const typeLabel = DIVERGENCE_TYPE_LABEL[div.divergenceType] ?? div.divergenceType;
			const hdr = $e('div', 'display:flex;gap:6px;align-items:center;');
			hdr.appendChild($t('span', typeLabel, 'font-size:10px;font-weight:700;color:var(--vscode-inputValidation-errorBorder,#f44336);'));
			hdr.appendChild($t('span', div.testCaseId, 'font-size:9px;color:var(--vscode-descriptionForeground);'));
			card.appendChild(hdr);

			card.appendChild($t('div', 'Input: ' + truncate(div.inputDescription, 120), 'font-size:10px;color:var(--vscode-descriptionForeground);'));

			const cmpRow = $e('div', 'display:flex;gap:8px;margin-top:2px;');
			const legacyEl = $e('div', 'flex:1;');
			legacyEl.appendChild($t('div', 'Legacy', 'font-size:9px;color:var(--vscode-descriptionForeground);margin-bottom:2px;'));
			legacyEl.appendChild($t('div', truncate(div.legacyOutput, 80), 'font-size:10px;font-family:monospace;color:var(--vscode-editor-foreground);background:rgba(76,175,80,0.1);padding:2px 4px;border-radius:2px;'));
			const modernEl = $e('div', 'flex:1;');
			modernEl.appendChild($t('div', 'Modern', 'font-size:9px;color:var(--vscode-descriptionForeground);margin-bottom:2px;'));
			modernEl.appendChild($t('div', truncate(div.modernOutput, 80), 'font-size:10px;font-family:monospace;color:var(--vscode-editor-foreground);background:rgba(244,67,54,0.1);padding:2px 4px;border-radius:2px;'));
			cmpRow.appendChild(legacyEl);
			cmpRow.appendChild(modernEl);
			card.appendChild(cmpRow);

			wrap.appendChild(card);
		}
	}

	// \u2500\u2500 Override form \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (state.showOverrideForm && validation && equiv.failCount > 0 && !equiv.overridden) {
		const formEl = $e('div', [
			'border:1px solid #e0a84e55', 'border-radius:4px', 'padding:10px',
			'background:rgba(224,168,78,0.05)', 'display:flex', 'flex-direction:column', 'gap:8px',
			'margin-top:4px',
		].join(';'));

		formEl.appendChild($t('div', 'Override Divergence \u2014 Document your rationale', [
			'font-size:11px', 'font-weight:700', 'color:#e0a84e',
		].join(';')));
		formEl.appendChild($t('div',
			'By overriding, you confirm the divergence is acceptable (e.g. known precision difference, test limitation). This action is audit-logged.',
			'font-size:10px;color:var(--vscode-descriptionForeground);line-height:1.4;',
		));

		const rationaleArea = $textarea('Rationale \u2014 why is this divergence acceptable? (required)', 3);
		rationaleArea.value = state.overrideRationale;
		rationaleArea.addEventListener('input', () => { state.overrideRationale = rationaleArea.value; });
		formEl.appendChild(rationaleArea);

		const ticketInput = document.createElement('input');
		ticketInput.type = 'text';
		ticketInput.placeholder = 'Change ticket ref (optional, e.g. JIRA-1234)';
		ticketInput.value = state.overrideTicketRef;
		ticketInput.style.cssText = [
			'width:100%', 'box-sizing:border-box',
			'background:var(--vscode-input-background)',
			'color:var(--vscode-input-foreground)',
			'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
			'border-radius:3px', 'padding:4px 8px', 'font-size:11px', 'font-family:inherit',
		].join(';');
		ticketInput.addEventListener('input', () => { state.overrideTicketRef = ticketInput.value; });
		formEl.appendChild(ticketInput);

		const overrideErrEl = $t('div', '', 'font-size:10px;color:var(--vscode-inputValidation-errorBorder,#f44336);');
		formEl.appendChild(overrideErrEl);

		const btnRow = $e('div', 'display:flex;gap:8px;');
		const confirmBtn = $btn('Confirm Override', false, () => {
			if (!state.overrideRationale.trim()) {
				overrideErrEl.textContent = 'Rationale is required.';
				return;
			}
			(confirmBtn as HTMLButtonElement).disabled = true;
			confirmBtn.textContent = 'Saving\u2026';
			validation.recordOverride(
				unitId, 'human', state.overrideRationale.trim(),
				state.overrideTicketRef.trim() || undefined,
			);
			state.showOverrideForm  = false;
			state.overrideRationale = '';
			state.overrideTicketRef = '';
			onRefresh();
		}, 'font-size:11px;padding:4px 12px;color:#e0a84e;border-color:#e0a84e55;');

		btnRow.appendChild(confirmBtn);
		btnRow.appendChild($btn('Cancel', false, () => {
			state.showOverrideForm = false;
			onRefresh();
		}, 'font-size:11px;'));
		formEl.appendChild(btnRow);
		wrap.appendChild(formEl);
	}

	return wrap;
}


// \u2500\u2500\u2500 Change request form \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildChangeRequestForm(
	unit:      IKnowledgeUnit,
	state:     IUnitEditorState,
	tools:     IModernisationAgentToolService,
	onRefresh: () => void,
): HTMLElement {
	const form = $e('div', [
		'padding:10px 14px', 'flex-shrink:0',
		'background:rgba(244,67,54,0.04)',
		'border-top:1px solid rgba(244,67,54,0.25)',
		'display:flex', 'flex-direction:column', 'gap:6px',
	].join(';'));

	form.appendChild($t('div', 'Request Changes \u2014 describe what needs to be fixed:', [
		'font-size:11px', 'font-weight:700',
		'color:var(--vscode-inputValidation-errorBorder,#f44336)',
	].join(';')));

	const ta = $textarea('Describe what the AI got wrong or what needs to change\u2026', 3);
	ta.value = state.changeNote;
	ta.addEventListener('input', () => { state.changeNote = ta.value; });
	form.appendChild(ta);

	const errEl = $t('div', '', 'font-size:10px;color:var(--vscode-inputValidation-errorBorder,#f44336);');
	form.appendChild(errEl);

	const btnRow = $e('div', 'display:flex;gap:8px;');

	const sendBtn = $btn('Send + Revert to Ready', false, () => {
		const note = ta.value.trim();
		if (!note) { errEl.textContent = 'Please describe what needs to change.'; return; }
		errEl.textContent = '';

		const annotResult = tools.addAnnotation({
			unitId: unit.id,
			content: note,
			author: 'human',
			kind: 'review-note',
		});
		if (!annotResult.success) {
			errEl.textContent = annotResult.error ?? 'Failed to save annotation.';
			return;
		}

		const revertResult = tools.revertUnit({
			unitId: unit.id,
			reason: 'Review requested: ' + truncate(note, 100),
			actor: 'human',
		});
		if (!revertResult.success) {
			errEl.textContent = revertResult.error ?? 'Failed to revert unit.';
			return;
		}

		state.changeNote     = '';
		state.showChangeForm = false;
		state.successMsg     = 'Changes requested \u2014 unit reverted to Ready for re-translation.';
		onRefresh();
	}, 'font-size:11px;');

	btnRow.appendChild(sendBtn);
	btnRow.appendChild($btn('Cancel', false, () => {
		state.showChangeForm = false;
		onRefresh();
	}, 'font-size:11px;'));
	form.appendChild(btnRow);

	return form;
}


// \u2500\u2500\u2500 Action bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildActionBar(
	unit:        IKnowledgeUnit,
	state:       IUnitEditorState,
	kb:          IKnowledgeBaseService,
	tools:       IModernisationAgentToolService,
	prevUnit:    IKnowledgeUnit | undefined,
	nextUnit:    IKnowledgeUnit | undefined,
	queue:       IKnowledgeUnit[],
	onNavigate:  (id: string) => void,
	onBack:      () => void,
	onRefresh:   () => void,
	validation?: IValidationEngineService,
): HTMLElement {
	const bar = $e('div', [
		'display:flex', 'align-items:center', 'flex-wrap:wrap', 'gap:6px',
		'padding:7px 14px', 'flex-shrink:0',
		'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
		'border-top:2px solid var(--vscode-panel-border)',
	].join(';'));

	const busy = state.busy;
	const canApprove = !!(unit.targetText || state.editedTarget);

	// Compliance gate guard
	const gateBlocks = state.complianceResult?.overallStatus === 'fail';

	// \u2500\u2500 Approve \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const approveBtn = $btn('\u2713 Approve', true, () => {
		_doApprove(unit, state, kb, tools, nextUnit?.id, onNavigate, onRefresh);
	}, 'font-size:12px;padding:6px 18px;');
	if (!canApprove || busy || gateBlocks) {
		(approveBtn as HTMLButtonElement).disabled = true;
		approveBtn.style.opacity = gateBlocks ? '0.5' : '0.45';
		approveBtn.style.cursor  = 'not-allowed';
	}
	if (gateBlocks) {
		approveBtn.title = 'Compliance gate has failures. Resolve them before approving.';
	}
	if (!canApprove) {
		approveBtn.title = 'No translation available to approve.';
	}
	approveBtn.title += '\nShortcut: Ctrl+Enter';
	bar.appendChild(approveBtn);

	// Re-run compliance gate button (if gate blocked)
	if (gateBlocks) {
		const reRunBtn = $btn('\u{1F504} Re-check Gate', false, () => {
			state.complianceChecked = false;
			state.complianceResult  = undefined;
			const result = kb.checkComplianceGate(unit.id);
			state.complianceResult  = result;
			state.complianceChecked = true;
			onRefresh();
		}, 'font-size:11px;padding:4px 10px;');
		bar.appendChild(reRunBtn);
	}

	// \u2500\u2500 Save Edits \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const isDirty = state.editedTarget !== (unit.targetText ?? '');
	if (isDirty) {
		const saveBtn = $btn('\u{1F4BE} Save Edits', false, () => {
			if (busy) { return; }
			const targetFile = unit.targetFile ?? unit.name + '.translated';
			const result = tools.recordTranslation({
				unitId:         unit.id,
				translatedCode: state.editedTarget,
				targetFile,
				confidence:     'medium',
				reasoning:      'Manually edited by human reviewer.',
				outcome:        'translated',
				actor:          'human',
			});
			if (!result.success) {
				state.error = result.error ?? 'Failed to save edits.';
				onRefresh();
				return;
			}
			state.successMsg = 'Edits saved. Unit stays in review until explicitly approved.';
			state.error      = '';
			onRefresh();
		}, 'font-size:12px;padding:6px 14px;');
		if (busy) { (saveBtn as HTMLButtonElement).disabled = true; saveBtn.style.opacity = '0.5'; }
		bar.appendChild(saveBtn);
	}

	// \u2500\u2500 Request Changes \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (!state.showChangeForm && !state.showBatchConfirm) {
		const changeBtn = $btn('\u2715 Request Changes', false, () => {
			state.showChangeForm = true;
			state.successMsg     = '';
			state.error          = '';
			onRefresh();
		}, 'font-size:12px;padding:6px 14px;');
		if (busy) { (changeBtn as HTMLButtonElement).disabled = true; changeBtn.style.opacity = '0.5'; }
		bar.appendChild(changeBtn);
	}

	// \u2500\u2500 Validate (Phase 10) \u2014 for approved units \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (validation && unit.status === 'approved') {
		const validateBtn = $btn('\u{1F9EA} Validate', false, async () => {
			if (state.validationBusy) { return; }
			state.validationBusy  = true;
			state.validationError = '';
			onRefresh();
			try {
				await validation.validateUnit(unit.id);
				// Switch to validation tab on completion
				state.bottomTab      = 'validation';
				state.bottomCollapsed = false;
				state.validationBusy = false;
				onRefresh();
			} catch (err) {
				state.validationError = err instanceof Error ? err.message : String(err);
				state.validationBusy  = false;
				onRefresh();
			}
		}, 'font-size:11px;padding:4px 12px;');
		if (state.validationBusy || busy) {
			(validateBtn as HTMLButtonElement).disabled = true;
			validateBtn.style.opacity = '0.5';
			validateBtn.textContent   = state.validationBusy ? 'Validating\u2026' : '\u{1F9EA} Validate';
		}
		bar.appendChild(validateBtn);
	}

	// \u2500\u2500 Override divergence (Phase 10) \u2014 for flagged units with equivalence fail \u2500\u2500
	if (
		validation &&
		unit.status === 'flagged' &&
		unit.equivalenceResult &&
		unit.equivalenceResult.failCount > 0 &&
		!unit.equivalenceResult.overridden
	) {
		const overrideBtn = $btn('\u26a0 Override Divergence', false, () => {
			state.showOverrideForm = !state.showOverrideForm;
			state.bottomTab       = 'validation';
			state.bottomCollapsed = false;
			onRefresh();
		}, 'font-size:11px;padding:4px 12px;color:#e0a84e;border-color:#e0a84e55;');
		bar.appendChild(overrideBtn);
	}

	// Validation error display
	if (state.validationError) {
		bar.appendChild($t('span', '\u26a0 ' + state.validationError,
			'font-size:10px;color:var(--vscode-inputValidation-errorBorder,#f44336);max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'));
	}

	// \u2500\u2500 Spacer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	bar.appendChild($e('div', 'flex:1;'));

	// \u2500\u2500 Review notes count \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const reviewNotes = kb.getAnnotations(unit.id).filter(a => a.kind === 'review-note');
	if (reviewNotes.length > 0) {
		bar.appendChild($t('span',
			reviewNotes.length + ' review note' + (reviewNotes.length !== 1 ? 's' : ''),
			'font-size:10px;color:var(--vscode-descriptionForeground);',
		));
	}

	// \u2500\u2500 Batch Approve \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const batchCandidates = queue.filter(u => u.status === 'review' && (u.targetText || u.id === unit.id));
	if (batchCandidates.length > 1 && !state.showBatchConfirm) {
		bar.appendChild($btn(
			'\u{2713}\u{2713} Batch Approve (' + batchCandidates.length + ')',
			false,
			() => { state.showBatchConfirm = true; state.showChangeForm = false; onRefresh(); },
			'font-size:11px;padding:4px 12px;',
		));
	}

	// \u2500\u2500 Skip \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (nextUnit) {
		bar.appendChild($btn('Skip \u203a', false, () => onNavigate(nextUnit.id),
			'font-size:11px;padding:4px 12px;'));
	}

	// \u2500\u2500 Keyboard hint \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	bar.appendChild($t('span', 'Ctrl+Enter=approve  Esc=back',
		'font-size:9px;color:var(--vscode-descriptionForeground);opacity:0.4;white-space:nowrap;'));

	return bar;
}


// \u2500\u2500\u2500 Batch approve panel \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildBatchApprovePanel(
	queue:     IKnowledgeUnit[],
	kb:        IKnowledgeBaseService,
	tools:     IModernisationAgentToolService,
	state:     IUnitEditorState,
	onBack:    () => void,
	onRefresh: () => void,
): HTMLElement {
	const candidates = queue.filter(u => u.status === 'review' && u.targetText);

	const panel = $e('div', [
		'padding:12px 14px', 'flex-shrink:0',
		'background:rgba(100,181,246,0.05)',
		'border-top:1px solid rgba(100,181,246,0.3)',
		'display:flex', 'flex-direction:column', 'gap:8px',
	].join(';'));

	panel.appendChild($t('div',
		'\u{2713}\u{2713} Batch Approve ' + candidates.length + ' units currently in "review"',
		'font-size:12px;font-weight:700;color:var(--vscode-editor-foreground);'));
	panel.appendChild($t('div',
		'This will record a human translation + approval for each of the following units. Flagged units are excluded.',
		'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;'));

	// List unit names
	const nameList = $e('div', 'display:flex;flex-wrap:wrap;gap:4px;max-height:60px;overflow-y:auto;');
	for (const u of candidates) {
		nameList.appendChild($t('span', u.name, [
			'font-size:10px', 'padding:1px 6px', 'border-radius:3px',
			'background:var(--vscode-badge-background)', 'color:var(--vscode-badge-foreground)',
		].join(';')));
	}
	panel.appendChild(nameList);

	const errEl  = $t('div', '', 'font-size:10px;color:var(--vscode-inputValidation-errorBorder,#f44336);');
	const okEl   = $t('div', '', 'font-size:10px;color:var(--vscode-terminal-ansiGreen,#4caf50);');
	panel.appendChild(errEl);
	panel.appendChild(okEl);

	const btnRow = $e('div', 'display:flex;gap:8px;');

	const confirmBtn = $btn('Confirm Batch Approve', true, () => {
		(confirmBtn as HTMLButtonElement).disabled = true;
		confirmBtn.textContent = 'Approving\u2026';

		let approved = 0;
		let errors   = 0;
		for (const u of candidates) {
			const targetFile = u.targetFile ?? u.name + '.translated';
			const recResult = tools.recordTranslation({
				unitId:         u.id,
				translatedCode: u.targetText ?? '',
				targetFile,
				confidence:     'high',
				reasoning:      'Batch-approved via Modernisation Console.',
				outcome:        'translated',
				actor:          'human',
			});
			if (!recResult.success) { errors++; continue; }

			const approval: IApprovalRecord = {
				id:           'apr-batch-' + u.id + '-' + Date.now(),
				unitId:       u.id,
				approvalType: 'translation',
				approvedBy:   'human',
				approvedAt:   Date.now(),
				rationale:    'Batch-approved via Modernisation Console Unit Editor.',
			};
			kb.addApproval(u.id, approval);
			approved++;
		}

		if (errors > 0) {
			errEl.textContent = errors + ' unit(s) failed to approve.';
		}
		okEl.textContent = approved + ' unit(s) approved successfully.';
		state.showBatchConfirm = false;

		// Return to index after brief pause
		setTimeout(() => onBack(), 1500);
	}, 'font-size:12px;padding:6px 18px;');

	btnRow.appendChild(confirmBtn);
	btnRow.appendChild($btn('Cancel', false, () => {
		state.showBatchConfirm = false;
		onRefresh();
	}, 'font-size:12px;'));
	panel.appendChild(btnRow);

	return panel;
}


// \u2500\u2500\u2500 Approve action (shared by button + keyboard shortcut) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _doApprove(
	unit:       IKnowledgeUnit,
	state:      IUnitEditorState,
	kb:         IKnowledgeBaseService,
	tools:      IModernisationAgentToolService,
	nextUnitId: string | undefined,
	onNavigate: (id: string) => void,
	onRefresh:  () => void,
): void {
	if (state.busy) { return; }
	if (!(unit.targetText || state.editedTarget)) {
		state.error = 'No translation to approve.';
		onRefresh();
		return;
	}

	// Block if compliance gate fails
	if (state.complianceResult?.overallStatus === 'fail') {
		state.error = 'Compliance gate has failures. Resolve them before approving.';
		onRefresh();
		return;
	}

	state.busy  = true;
	state.error = '';

	const targetCode = state.editedTarget || unit.targetText || '';
	const targetFile = unit.targetFile ?? unit.name + '.translated';

	const result = tools.recordTranslation({
		unitId:         unit.id,
		translatedCode: targetCode,
		targetFile,
		confidence:     'high',
		reasoning:      'Human-reviewed and approved via Modernisation Console Unit Editor.',
		outcome:        'translated',
		actor:          'human',
	});

	if (!result.success) {
		state.busy  = false;
		state.error = result.error ?? 'Failed to record translation.';
		onRefresh();
		return;
	}

	const approval: IApprovalRecord = {
		id:           'apr-' + unit.id + '-' + Date.now(),
		unitId:       unit.id,
		approvalType: 'translation',
		approvedBy:   'human',
		approvedAt:   Date.now(),
		rationale:    'Approved via Modernisation Console Unit Editor.',
	};
	kb.addApproval(unit.id, approval);

	state.busy         = false;
	state.successMsg   = '\u2713 Unit "' + unit.name + '" approved.';
	state.editedTarget = '';
	onRefresh();

	// Auto-advance to next unit after 1.2 s
	if (nextUnitId) {
		setTimeout(() => onNavigate(nextUnitId), 1200);
	}
}


// \u2500\u2500\u2500 Release lock helper \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _releaseLock(unitId: string, state: IUnitEditorState, kb: IKnowledgeBaseService): void {
	if (state.lockAcquired && state.lockOwnerId) {
		kb.unlockUnit(unitId, state.lockOwnerId);
		state.lockAcquired = false;
	}
	state.lockOwnerId = undefined;
}


// \u2500\u2500\u2500 Line-numbered pre (read-only source pane) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildLineNumberedPre(text: string, wordWrap: boolean): HTMLElement {
	const wrapper = $e('div', 'display:flex;flex:1;overflow:auto;');

	const lines = text.split('\n');
	const pad   = String(lines.length).length;

	const lineNumEl = $t('pre',
		lines.map((_, i) => String(i + 1).padStart(pad, ' ')).join('\n'),
		[
			'flex-shrink:0', 'margin:0', 'padding:12px 6px 12px 10px',
			'font-family:var(--vscode-editor-font-family,\'Menlo\',\'Consolas\',monospace)',
			'font-size:12px', 'line-height:1.7',
			'color:var(--vscode-editorLineNumber-foreground,#4e4e4e)',
			'text-align:right', 'user-select:none', 'white-space:pre',
			'background:var(--vscode-editor-background)',
			'border-right:1px solid var(--vscode-panel-border)',
			'min-width:38px',
		].join(';'));

	const codeEl = $t('pre',
		text || '(no source text recorded)',
		[
			'flex:1', 'margin:0', 'padding:12px 14px',
			'font-family:var(--vscode-editor-font-family,\'Menlo\',\'Consolas\',monospace)',
			'font-size:12px', 'line-height:1.7',
			'color:var(--vscode-editor-foreground)',
			'background:var(--vscode-editor-background)',
			wordWrap ? 'white-space:pre-wrap;word-break:break-all;' : 'white-space:pre;',
			'tab-size:4', 'min-width:0',
		].join(';'));

	wrapper.appendChild(lineNumEl);
	wrapper.appendChild(codeEl);
	return wrapper;
}


// \u2500\u2500\u2500 Line-numbered textarea (editable target pane) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _buildLineNumberedTextarea(
	value:     string,
	placeholder: string,
	onInput:   (val: string) => void,
	wordWrap:  boolean,
): HTMLElement {
	const wrapper = $e('div', 'display:flex;flex:1;overflow:hidden;');

	const initialLines = Math.max(1, value.split('\n').length);
	const initialPad   = String(initialLines).length;

	const lineNumEl = $e('div', [
		'flex-shrink:0', 'min-width:38px',
		'padding:12px 6px 12px 10px',
		'font-family:var(--vscode-editor-font-family,\'Menlo\',\'Consolas\',monospace)',
		'font-size:12px', 'line-height:1.7',
		'color:var(--vscode-editorLineNumber-foreground,#4e4e4e)',
		'text-align:right', 'user-select:none', 'white-space:pre',
		'overflow:hidden',
		'background:var(--vscode-editor-background)',
		'border-right:1px solid var(--vscode-panel-border)',
	].join(';'));
	lineNumEl.textContent = Array.from(
		{ length: initialLines },
		(_, i) => String(i + 1).padStart(initialPad, ' '),
	).join('\n');

	const ta = document.createElement('textarea');
	ta.value       = value;
	ta.placeholder = placeholder;
	ta.spellcheck  = false;
	ta.style.cssText = [
		'flex:1', 'box-sizing:border-box', 'margin:0',
		'padding:12px 14px',
		'font-family:var(--vscode-editor-font-family,\'Menlo\',\'Consolas\',monospace)',
		'font-size:12px', 'line-height:1.7',
		'color:var(--vscode-editor-foreground)',
		'background:var(--vscode-editor-background)',
		'border:none', 'outline:none', 'resize:none',
		'tab-size:4',
		wordWrap ? 'white-space:pre-wrap;word-break:break-all;overflow-y:auto;' : 'white-space:pre;overflow:auto;',
	].join(';');

	function updateLineNums(): void {
		const count = Math.max(1, ta.value.split('\n').length);
		const p     = String(count).length;
		lineNumEl.textContent = Array.from(
			{ length: count },
			(_, i) => String(i + 1).padStart(p, ' '),
		).join('\n');
	}

	ta.addEventListener('input', () => {
		onInput(ta.value);
		updateLineNums();
	});

	// Sync scroll: when textarea scrolls, scroll the line number column too
	ta.addEventListener('scroll', () => {
		lineNumEl.scrollTop = ta.scrollTop;
	});

	// Tab key \u2192 insert 4 spaces instead of focus-out
	ta.addEventListener('keydown', (e: KeyboardEvent) => {
		if (e.key === 'Tab') {
			e.preventDefault();
			const start = ta.selectionStart;
			const end   = ta.selectionEnd;
			ta.value    = ta.value.slice(0, start) + '    ' + ta.value.slice(end);
			ta.selectionStart = ta.selectionEnd = start + 4;
			onInput(ta.value);
			updateLineNums();
		}
	});

	wrapper.appendChild(lineNumEl);
	wrapper.appendChild(ta);
	return wrapper;
}


// \u2500\u2500\u2500 Diff pre (show-original mode) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface IDiffLine { text: string; kind: 'same' | 'added' | 'removed' | 'changed'; }

function _buildDiffPre(lines: IDiffLine[], wordWrap: boolean): HTMLElement {
	const wrapper = $e('div', 'display:flex;flex:1;overflow:auto;');

	const pad = String(lines.length).length;

	const lineNumEl = $e('pre', [
		'flex-shrink:0', 'min-width:38px', 'margin:0', 'padding:12px 6px 12px 10px',
		'font-family:var(--vscode-editor-font-family,\'Menlo\',\'Consolas\',monospace)',
		'font-size:12px', 'line-height:1.7',
		'color:var(--vscode-editorLineNumber-foreground,#4e4e4e)',
		'text-align:right', 'user-select:none', 'white-space:pre',
		'background:var(--vscode-editor-background)',
		'border-right:1px solid var(--vscode-panel-border)',
	].join(';'));
	lineNumEl.textContent = lines.map((_, i) => String(i + 1).padStart(pad, ' ')).join('\n');

	// Code container (line-by-line spans for diff coloring)
	const codeEl = $e('pre', [
		'flex:1', 'margin:0', 'padding:0',
		'font-family:var(--vscode-editor-font-family,\'Menlo\',\'Consolas\',monospace)',
		'font-size:12px', 'line-height:1.7',
		'color:var(--vscode-editor-foreground)',
		'background:var(--vscode-editor-background)',
		wordWrap ? 'white-space:pre-wrap;word-break:break-all;' : 'white-space:pre;',
		'tab-size:4', 'min-width:0',
	].join(';'));

	const DIFF_BG: Record<IDiffLine['kind'], string> = {
		same:    'transparent',
		added:   'rgba(76,175,80,0.1)',
		removed: 'rgba(244,67,54,0.1)',
		changed: 'rgba(224,168,78,0.1)',
	};

	for (const line of lines) {
		const span = document.createElement('span');
		span.textContent = line.text + '\n';
		span.style.display    = 'block';
		span.style.background = DIFF_BG[line.kind];
		if (line.kind === 'changed') {
			span.style.borderLeft = '3px solid rgba(224,168,78,0.5)';
			span.style.paddingLeft = '11px';
		} else if (line.kind === 'added') {
			span.style.borderLeft  = '3px solid rgba(76,175,80,0.5)';
			span.style.paddingLeft = '11px';
		} else if (line.kind === 'removed') {
			span.style.borderLeft  = '3px solid rgba(244,67,54,0.5)';
			span.style.paddingLeft = '11px';
		} else {
			span.style.paddingLeft = '14px';
		}
		codeEl.appendChild(span);
	}

	if (lines.length === 0) {
		codeEl.textContent = '(empty)';
	}

	wrapper.appendChild(lineNumEl);
	wrapper.appendChild(codeEl);
	return wrapper;
}


// \u2500\u2500\u2500 Diff utilities \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _computeDiffLines(original: string, edited: string): IDiffLine[] {
	const origLines = original.split('\n');
	const editLines = edited.split('\n');
	const maxLen    = Math.max(origLines.length, editLines.length);
	return Array.from({ length: maxLen }, (_, i): IDiffLine => {
		const origLine = origLines[i];
		const editLine = editLines[i];
		if (origLine === undefined) { return { text: editLine ?? '', kind: 'added' }; }
		if (editLine === undefined) { return { text: origLine,       kind: 'removed' }; }
		return { text: origLine, kind: origLine === editLine ? 'same' : 'changed' };
	});
}

function _computeDiffStats(original: string, edited: string): { added: number; removed: number; changed: number } {
	const lines   = _computeDiffLines(original, edited);
	const added   = lines.filter(l => l.kind === 'added').length;
	const removed = lines.filter(l => l.kind === 'removed').length;
	const changed = lines.filter(l => l.kind === 'changed').length;
	return { added, removed, changed };
}


// \u2500\u2500\u2500 Infer target language from file extension \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function _inferTargetLang(filePath: string): string {
	const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
	const MAP: Record<string, string> = {
		java:   'java',   kt:    'kotlin',     scala: 'scala',
		ts:     'typescript', js: 'javascript', tsx:  'typescript', jsx: 'javascript',
		py:     'python', rb:    'ruby',        go:   'go',
		rs:     'rust',   cs:    'c#',          cpp:  'c++',
		c:      'c',      swift: 'swift',       php:  'php',
		sql:    'sql',    pl:    'pl/sql',      vb:   'vb',
		dart:   'dart',   ex:    'elixir',
	};
	return MAP[ext] ?? (ext || '?');
}
