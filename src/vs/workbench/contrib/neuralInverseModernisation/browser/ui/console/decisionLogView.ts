/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Decision Log View — Tab 3 of the Modernisation Console.
 *
 * Displays the full IDecisionLog across five sub-tabs:
 *   Type Mappings | Naming | Rule Interpretations | Exclusions | Pattern Overrides
 *
 * Each sub-tab renders a table of all recorded decisions for that category
 * with delete buttons and relevant metadata columns.
 *
 * Top actions:
 *   Export Decisions \u2192 downloads the decision log as JSON
 *   Import Decisions \u2192 opens a textarea dialog to paste a JSON payload
 */

import { IKnowledgeBaseService } from '../../knowledgeBase/service.js';
import { IModernisationAgentToolService } from '../../engine/agentTools/service.js';
import {
	ITypeMappingDecision,
	INamingDecision,
	IRuleInterpretation,
	IExclusionDecision,
	IPatternOverride,
} from '../../../common/knowledgeBaseTypes.js';
import {
	$e, $t, $btn, $textarea, $emptyState,
	truncate,
} from './consoleHelpers.js';

// ─── Sub-tab type ─────────────────────────────────────────────────────────────

export type DecisionLogSubTab =
	| 'type-mapping'
	| 'naming'
	| 'rule-interpretation'
	| 'exclusion'
	| 'pattern-override';

export interface IDecisionLogState {
	subTab:    DecisionLogSubTab;
	importing: boolean;
}

export function defaultDecisionLogState(): IDecisionLogState {
	return { subTab: 'type-mapping', importing: false };
}

const SUB_TABS: Array<{ id: DecisionLogSubTab; label: string }> = [
	{ id: 'type-mapping',       label: 'Type Mappings' },
	{ id: 'naming',             label: 'Naming' },
	{ id: 'rule-interpretation',label: 'Rules' },
	{ id: 'exclusion',          label: 'Exclusions' },
	{ id: 'pattern-override',   label: 'Patterns' },
];


// ─── Build ────────────────────────────────────────────────────────────────────

export function buildDecisionLogView(
	kb:        IKnowledgeBaseService,
	tools:     IModernisationAgentToolService,
	state:     IDecisionLogState,
	onRefresh: () => void,
): HTMLElement {
	const root = $e('div', 'display:flex;flex-direction:column;height:100%;overflow:hidden;');

	if (!kb.isActive) {
		root.appendChild($emptyState('\u{1F4DD}', 'Knowledge base not active', 'Initialise a session to see decisions.'));
		return root;
	}

	const log = kb.getDecisions();

	// ── Actions bar (Export / Import) ─────────────────────────────────────
	const actBar = _buildActionsBar(log, tools, state, onRefresh);
	root.appendChild(actBar);

	// ── Import pane (shown when importing) ───────────────────────────────
	if (state.importing) {
		root.appendChild(_buildImportPane(tools, state, onRefresh));
		return root;
	}

	// ── Sub-tab bar ───────────────────────────────────────────────────────
	root.appendChild(_buildSubTabBar(log, state, onRefresh));

	// ── Content ───────────────────────────────────────────────────────────
	const content = $e('div', 'flex:1;overflow-y:auto;');
	root.appendChild(content);

	switch (state.subTab) {
		case 'type-mapping':       content.appendChild(_buildTypeMappingsTable(log.typeMapping ?? [], tools, onRefresh)); break;
		case 'naming':             content.appendChild(_buildNamingTable(log.naming ?? [], tools, onRefresh)); break;
		case 'rule-interpretation':content.appendChild(_buildRuleInterpTable(log.ruleInterpret ?? [], tools, onRefresh)); break;
		case 'exclusion':          content.appendChild(_buildExclusionsTable(log.exclusions ?? [], tools, onRefresh)); break;
		case 'pattern-override':   content.appendChild(_buildPatternOverridesTable(log.patternOverrides ?? [], tools, onRefresh)); break;
	}

	return root;
}


// ─── Actions bar ─────────────────────────────────────────────────────────────

function _buildActionsBar(
	log:       import('../../../common/knowledgeBaseTypes.js').IDecisionLog,
	tools:     IModernisationAgentToolService,
	state:     IDecisionLogState,
	onRefresh: () => void,
): HTMLElement {
	const bar = $e('div', [
		'display:flex', 'align-items:center', 'gap:8px', 'flex-wrap:wrap',
		'padding:8px 12px',
		'border-bottom:1px solid var(--vscode-panel-border)',
		'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
		'flex-shrink:0',
	].join(';'));

	const totalDecisions =
		(log.typeMapping?.length ?? 0) +
		(log.naming?.length ?? 0) +
		(log.ruleInterpret?.length ?? 0) +
		(log.exclusions?.length ?? 0) +
		(log.patternOverrides?.length ?? 0);

	bar.appendChild($t('span', `${totalDecisions} decisions recorded`, [
		'font-size:11px', 'color:var(--vscode-descriptionForeground)', 'flex:1',
	].join(';')));

	// Export button
	bar.appendChild($btn('\u2193 Export JSON', false, () => {
		const result = tools.exportDecisions();
		if (result.success && result.data) {
			// Trigger browser download
			const blob = new Blob([result.data.json], { type: 'application/json' });
			const url  = URL.createObjectURL(blob);
			const a    = document.createElement('a');
			a.href     = url;
			a.download = 'modernisation-decisions.json';
			a.click();
			URL.revokeObjectURL(url);
		}
	}, 'font-size:11px;padding:3px 10px;'));

	// Import button
	bar.appendChild($btn('\u2191 Import JSON', false, () => {
		state.importing = true;
		onRefresh();
	}, 'font-size:11px;padding:3px 10px;'));

	return bar;
}


// ─── Import pane ─────────────────────────────────────────────────────────────

function _buildImportPane(
	tools:     IModernisationAgentToolService,
	state:     IDecisionLogState,
	onRefresh: () => void,
): HTMLElement {
	const pane = $e('div', 'flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;');

	pane.appendChild($t('div', 'Import Decisions',
		'font-size:14px;font-weight:700;color:var(--vscode-editor-foreground);'));
	pane.appendChild($t('div',
		'Paste the JSON from a previous Export Decisions. Decisions will be merged with the current KB — no units will be overwritten.',
		'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;'));

	const area = $textarea('Paste JSON here\u2026', 10);
	pane.appendChild(area);

	const errorMsg   = $e('div', 'font-size:11px;color:var(--vscode-inputValidation-errorBorder,#f44336);');
	const successMsg = $e('div', 'font-size:11px;color:var(--vscode-terminal-ansiGreen,#4caf50);');
	pane.appendChild(errorMsg);
	pane.appendChild(successMsg);

	const btnRow = $e('div', 'display:flex;gap:8px;');
	btnRow.appendChild($btn('Import', true, () => {
		const json = area.value.trim();
		if (!json) { errorMsg.textContent = 'Paste a JSON payload first.'; return; }
		const result = tools.importDecisions({ decisionsJson: json });
		if (result.success) {
			successMsg.textContent = result.summary ?? 'Imported successfully.';
			errorMsg.textContent   = '';
			setTimeout(() => {
				state.importing = false;
				onRefresh();
			}, 1000);
		} else {
			errorMsg.textContent   = result.error ?? 'Import failed.';
			successMsg.textContent = '';
		}
	}, 'font-size:12px;'));
	btnRow.appendChild($btn('Cancel', false, () => {
		state.importing = false;
		onRefresh();
	}, 'font-size:12px;'));
	pane.appendChild(btnRow);

	return pane;
}


// ─── Sub-tab bar ─────────────────────────────────────────────────────────────

function _buildSubTabBar(
	log:       import('../../../common/knowledgeBaseTypes.js').IDecisionLog,
	state:     IDecisionLogState,
	onRefresh: () => void,
): HTMLElement {
	const counts: Record<DecisionLogSubTab, number> = {
		'type-mapping':        log.typeMapping?.length ?? 0,
		'naming':              log.naming?.length ?? 0,
		'rule-interpretation': log.ruleInterpret?.length ?? 0,
		'exclusion':           log.exclusions?.length ?? 0,
		'pattern-override':    log.patternOverrides?.length ?? 0,
	};

	const bar = $e('div', [
		'display:flex', 'align-items:center', 'flex-wrap:wrap',
		'border-bottom:1px solid var(--vscode-panel-border)',
		'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
		'flex-shrink:0',
	].join(';'));

	for (const tab of SUB_TABS) {
		const isActive = state.subTab === tab.id;
		const count    = counts[tab.id];

		const tabEl = $e('div', [
			'display:flex', 'align-items:center', 'gap:5px',
			'padding:6px 12px', 'cursor:pointer', 'font-size:11px',
			'font-weight:600', 'border-bottom:2px solid transparent',
			'white-space:nowrap', 'user-select:none',
			isActive
				? 'color:var(--vscode-focusBorder,#6496fa);border-bottom-color:var(--vscode-focusBorder,#6496fa);'
				: 'color:var(--vscode-descriptionForeground);',
		].join(';'));

		tabEl.appendChild($t('span', tab.label));

		if (count > 0) {
			tabEl.appendChild($t('span', String(count), [
				'font-size:9px', 'padding:1px 5px', 'border-radius:8px',
				isActive
					? 'background:var(--vscode-focusBorder,#6496fa);color:var(--vscode-button-foreground,#fff);'
					: 'background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);',
			].join(';')));
		}

		tabEl.addEventListener('click', () => { state.subTab = tab.id; onRefresh(); });
		tabEl.addEventListener('mouseenter', () => { if (!isActive) { tabEl.style.color = 'var(--vscode-editor-foreground)'; } });
		tabEl.addEventListener('mouseleave', () => { if (!isActive) { tabEl.style.color = 'var(--vscode-descriptionForeground)'; } });

		bar.appendChild(tabEl);
	}

	return bar;
}


// ─── Type Mappings table ──────────────────────────────────────────────────────

function _buildTypeMappingsTable(
	items:     ITypeMappingDecision[],
	tools:     IModernisationAgentToolService,
	onRefresh: () => void,
): HTMLElement {
	if (items.length === 0) {
		return $emptyState('\u2194', 'No type mappings', 'Record type mapping decisions as you translate each unit.');
	}

	const wrap = $e('div', 'padding:8px;display:flex;flex-direction:column;gap:4px;');

	// Column header
	const hdr = _tableHeader(['Source Type', 'Target Type', 'Rationale', 'Scope', '']);
	wrap.appendChild(hdr);

	for (const item of items) {
		const row = _tableRow([
			item.sourceType,
			item.targetType,
			truncate(item.rationale ?? '—', 80),
			item.appliesTo?.length ? item.appliesTo.join(', ') : 'global',
		]);
		// Delete button
		const del = $btn('\u00d7', false, () => {
			tools.removeDecision({ decisionId: item.id, decisionType: 'type-mapping' });
			onRefresh();
		}, 'font-size:11px;padding:1px 6px;opacity:0.6;');
		del.title = 'Remove this decision';
		row.appendChild(del);
		wrap.appendChild(row);
	}

	return wrap;
}


// ─── Naming table ─────────────────────────────────────────────────────────────

function _buildNamingTable(
	items:     INamingDecision[],
	tools:     IModernisationAgentToolService,
	onRefresh: () => void,
): HTMLElement {
	if (items.length === 0) {
		return $emptyState('\u{1F520}', 'No naming decisions', 'Record identifier naming decisions as you translate each unit.');
	}

	const wrap = $e('div', 'padding:8px;display:flex;flex-direction:column;gap:4px;');
	wrap.appendChild(_tableHeader(['Source Name', 'Target Name', 'Domain', 'Decided By', '']));

	for (const item of items) {
		const row = _tableRow([
			item.sourceName,
			item.targetName,
			item.domain ?? '—',
			item.decidedBy ?? '—',
		]);
		const del = $btn('\u00d7', false, () => {
			tools.removeDecision({ decisionId: item.id, decisionType: 'naming' });
			onRefresh();
		}, 'font-size:11px;padding:1px 6px;opacity:0.6;');
		row.appendChild(del);
		wrap.appendChild(row);
	}

	return wrap;
}


// ─── Rule Interpretations table ───────────────────────────────────────────────

function _buildRuleInterpTable(
	items:     IRuleInterpretation[],
	tools:     IModernisationAgentToolService,
	onRefresh: () => void,
): HTMLElement {
	if (items.length === 0) {
		return $emptyState('\u{1F4D6}', 'No rule interpretations', 'Record business rule interpretations to guide AI translation.');
	}

	const wrap = $e('div', 'padding:8px;display:flex;flex-direction:column;gap:4px;');
	wrap.appendChild(_tableHeader(['Source Text', 'Meaning', 'Domain', '']));

	for (const item of items) {
		const row = _tableRow([
			truncate(item.sourceText ?? item.id, 60),
			truncate(item.meaning ?? '—', 100),
			item.domain ?? '—',
		]);
		const del = $btn('\u00d7', false, () => {
			tools.removeDecision({ decisionId: item.id, decisionType: 'rule-interpretation' });
			onRefresh();
		}, 'font-size:11px;padding:1px 6px;opacity:0.6;');
		row.appendChild(del);
		wrap.appendChild(row);
	}

	return wrap;
}


// ─── Exclusions table ─────────────────────────────────────────────────────────

function _buildExclusionsTable(
	items:     IExclusionDecision[],
	tools:     IModernisationAgentToolService,
	onRefresh: () => void,
): HTMLElement {
	if (items.length === 0) {
		return $emptyState('\u26d4', 'No exclusions', 'Record exclusion rules to skip files or units from translation.');
	}

	const wrap = $e('div', 'padding:8px;display:flex;flex-direction:column;gap:4px;');
	wrap.appendChild(_tableHeader(['Pattern', 'Reason', 'Decided By', '']));

	for (const item of items) {
		const row = _tableRow([
			item.pattern ?? item.id,
			truncate(item.reason ?? '—', 100),
			item.decidedBy ?? '—',
		]);
		const del = $btn('\u00d7', false, () => {
			tools.removeDecision({ decisionId: item.id, decisionType: 'exclusion' });
			onRefresh();
		}, 'font-size:11px;padding:1px 6px;opacity:0.6;');
		row.appendChild(del);
		wrap.appendChild(row);
	}

	return wrap;
}


// ─── Pattern Overrides table ──────────────────────────────────────────────────

function _buildPatternOverridesTable(
	items:     IPatternOverride[],
	tools:     IModernisationAgentToolService,
	onRefresh: () => void,
): HTMLElement {
	if (items.length === 0) {
		return $emptyState('\u{1F527}', 'No pattern overrides', 'Pattern overrides customise how the AI handles specific code patterns.');
	}

	const wrap = $e('div', 'padding:8px;display:flex;flex-direction:column;gap:4px;');
	wrap.appendChild(_tableHeader(['Pattern', 'Type', 'Value', 'Rationale', '']));

	for (const item of items) {
		const row = _tableRow([
			item.pattern ?? item.id,
			item.overrideType ?? '—',
			truncate(item.value ?? '—', 60),
			truncate(item.rationale ?? '—', 80),
		]);
		const del = $btn('\u00d7', false, () => {
			tools.removeDecision({ decisionId: item.id, decisionType: 'pattern-override' });
			onRefresh();
		}, 'font-size:11px;padding:1px 6px;opacity:0.6;');
		row.appendChild(del);
		wrap.appendChild(row);
	}

	return wrap;
}


// ─── Shared table helpers ─────────────────────────────────────────────────────

function _tableHeader(cols: string[]): HTMLElement {
	const hdr = $e('div', [
		'display:flex', 'align-items:center', 'gap:8px',
		'padding:4px 8px',
		'font-size:9px', 'font-weight:700', 'text-transform:uppercase', 'letter-spacing:0.07em',
		'color:var(--vscode-descriptionForeground)',
		'border-bottom:1px solid var(--vscode-widget-border)',
	].join(';'));
	for (const col of cols) {
		hdr.appendChild($t('div', col, 'flex:1;padding:0 2px;'));
	}
	return hdr;
}

function _tableRow(cells: string[]): HTMLElement {
	const row = $e('div', [
		'display:flex', 'align-items:flex-start', 'gap:8px',
		'padding:6px 8px', 'border-radius:3px',
		'background:var(--vscode-input-background)',
		'border:1px solid var(--vscode-widget-border)',
		'font-size:11px', 'color:var(--vscode-editor-foreground)',
	].join(';'));
	for (const cell of cells) {
		row.appendChild($t('div', cell, [
			'flex:1', 'overflow:hidden', 'text-overflow:ellipsis',
			'white-space:nowrap', 'padding:0 2px', 'line-height:1.5',
		].join(';')));
	}
	return row;
}
