/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit Index View — Tab 1 of the Modernisation Console.
 *
 * Displays every unit in the knowledge base as a filterable, sortable,
 * paginated table. Each row expands inline to show source snippet,
 * translated target path, annotations, and quick-action buttons.
 *
 * Features:
 *  - Live text search (name + file path)
 *  - Multi-status filter (dropdown)
 *  - Multi-risk filter (dropdown)
 *  - Language filter (dropdown built from live KB data)
 *  - Column sort: status | name | language | risk | file | updated
 *  - 50 rows per page with Prev/Next pagination
 *  - Inline row expansion with source preview, decisions count, annotations
 *  - Quick actions: Flag Ready, Revert, Open Source
 */

import { IKnowledgeBaseService } from '../../knowledgeBase/service.js';
import { IModernisationAgentToolService } from '../../engine/agentTools/service.js';
import { IKnowledgeUnit, UnitStatus, RiskLevel } from '../../../common/knowledgeBaseTypes.js';
import {
	$e, $t, $btn, $input, $select,
	$statusBadge, $riskBadge, $emptyState, $pagination,
	STATUS_COLOR,
	relativeTime, truncate, basename,
	IPaginationState,
} from './consoleHelpers.js';

// ─── State ────────────────────────────────────────────────────────────────────

export interface IUnitIndexState {
	search:       string;
	statusFilter: UnitStatus | '';
	riskFilter:   RiskLevel  | '';
	langFilter:   string;
	sortCol:      UnitSortCol;
	sortDir:      'asc' | 'desc';
	page:         number;
	expandedIds:  Set<string>;
}

export type UnitSortCol = 'name' | 'status' | 'risk' | 'language' | 'file' | 'updated' | 'deps';

export function defaultUnitIndexState(): IUnitIndexState {
	return {
		search: '', statusFilter: '', riskFilter: '', langFilter: '',
		sortCol: 'status', sortDir: 'asc',
		page: 0, expandedIds: new Set(),
	};
}

const PAGE_SIZE = 50;

const STATUS_ORDER: UnitStatus[] = [
	'blocked', 'flagged', 'translating', 'review',
	'ready', 'resolving', 'pending', 'complete', 'validated', 'validating', 'approved', 'committed', 'skipped',
];

const RISK_ORDER: RiskLevel[] = ['critical', 'high', 'medium', 'low'];

function statusRank(s: UnitStatus): number { return STATUS_ORDER.indexOf(s) ?? 99; }
function riskRank(r: RiskLevel):   number { return RISK_ORDER.indexOf(r) ?? 99; }


// ─── Filter + sort + page ────────────────────────────────────────────────────

function applyFilters(units: IKnowledgeUnit[], state: IUnitIndexState): IKnowledgeUnit[] {
	let result = units;

	if (state.search) {
		const q = state.search.toLowerCase();
		result = result.filter(u =>
			u.name.toLowerCase().includes(q) ||
			u.sourceFile.toLowerCase().includes(q),
		);
	}
	if (state.statusFilter) {
		result = result.filter(u => u.status === state.statusFilter);
	}
	if (state.riskFilter) {
		result = result.filter(u => u.riskLevel === state.riskFilter);
	}
	if (state.langFilter) {
		result = result.filter(u => u.sourceLang === state.langFilter);
	}
	return result;
}

function applySort(units: IKnowledgeUnit[], state: IUnitIndexState): IKnowledgeUnit[] {
	const { sortCol, sortDir } = state;
	const mult = sortDir === 'asc' ? 1 : -1;

	return [...units].sort((a, b) => {
		let cmp = 0;
		switch (sortCol) {
			case 'name':     cmp = a.name.localeCompare(b.name); break;
			case 'status':   cmp = statusRank(a.status) - statusRank(b.status); break;
			case 'risk':     cmp = riskRank(a.riskLevel) - riskRank(b.riskLevel); break;
			case 'language': cmp = a.sourceLang.localeCompare(b.sourceLang); break;
			case 'file':     cmp = a.sourceFile.localeCompare(b.sourceFile); break;
			case 'updated':  cmp = (b.updatedAt ?? 0) - (a.updatedAt ?? 0); break;
			case 'deps':     cmp = (b.dependsOn?.length ?? 0) - (a.dependsOn?.length ?? 0); break;
		}
		return cmp * mult;
	});
}


// ─── Languages list ───────────────────────────────────────────────────────────

function getLanguages(units: IKnowledgeUnit[]): string[] {
	const langs = new Set<string>();
	for (const u of units) { if (u.sourceLang) { langs.add(u.sourceLang); } }
	return [...langs].sort();
}


// ─── Build ────────────────────────────────────────────────────────────────────

export function buildUnitIndexView(
	kb: IKnowledgeBaseService,
	tools: IModernisationAgentToolService,
	state: IUnitIndexState,
	onRefresh: () => void,
	onOpenEditor: (unitId: string) => void = () => { /* no-op */ },
): HTMLElement {
	const root = $e('div', 'display:flex;flex-direction:column;height:100%;overflow:hidden;');

	if (!kb.isActive) {
		root.appendChild($emptyState(
			'\u{1F4DA}',
			'Knowledge base not active',
			'Initialise a session to see units here.',
		));
		return root;
	}

	const allUnits = kb.getAllUnits();

	// ── Filter bar ────────────────────────────────────────────────────────
	const filterBar = _buildFilterBar(allUnits, state, onRefresh);
	root.appendChild(filterBar);

	// ── Apply filters + sort ─────────────────────────────────────────────
	const filtered = applySort(applyFilters(allUnits, state), state);
	const total     = filtered.length;
	const page      = Math.min(state.page, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));
	if (page !== state.page) { state.page = page; }
	const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

	// ── Summary row ───────────────────────────────────────────────────────
	const summaryRow = _buildSummaryRow(allUnits, filtered.length);
	root.appendChild(summaryRow);

	// ── Table ─────────────────────────────────────────────────────────────
	const tableWrap = $e('div', 'flex:1;overflow-y:auto;');
	root.appendChild(tableWrap);

	if (paged.length === 0) {
		tableWrap.appendChild($emptyState(
			'\u{1F50D}',
			total === 0 && allUnits.length === 0
				? 'Knowledge base is empty'
				: 'No units match your filters',
			total === 0 && allUnits.length === 0
				? 'Units are populated when you run the Discovery scan and load them into the KB.'
				: 'Try clearing the search or changing the status/risk filters.',
		));
	} else {
		const table = _buildTable(paged, state, kb, tools, onRefresh, onOpenEditor);
		tableWrap.appendChild(table);
	}

	// ── Pagination ────────────────────────────────────────────────────────
	if (total > PAGE_SIZE) {
		const paginState: IPaginationState = { page, pageSize: PAGE_SIZE, total };
		root.appendChild($pagination(
			paginState,
			() => { state.page = Math.max(0, page - 1); onRefresh(); },
			() => { state.page = page + 1; onRefresh(); },
		));
	}

	return root;
}


// ─── Filter bar ──────────────────────────────────────────────────────────────

function _buildFilterBar(
	allUnits: IKnowledgeUnit[],
	state:    IUnitIndexState,
	onRefresh: () => void,
): HTMLElement {
	const bar = $e('div', [
		'display:flex', 'align-items:center', 'flex-wrap:wrap', 'gap:6px',
		'padding:8px 12px',
		'border-bottom:1px solid var(--vscode-panel-border)',
		'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
		'flex-shrink:0',
	].join(';'));

	// Search
	const searchInp = $input('\u{1F50D}  Search units\u2026', state.search, 'flex:1;min-width:140px;max-width:260px;');
	searchInp.addEventListener('input', () => {
		state.search = searchInp.value;
		state.page   = 0;
		onRefresh();
	});
	bar.appendChild(searchInp);

	// Status filter
	const statusOptions: Array<{ value: string; label: string }> = [
		{ value: '', label: 'All Statuses' },
		...STATUS_ORDER.map(s => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) })),
	];
	const statusSel = $select(statusOptions, state.statusFilter, 'font-size:11px;');
	statusSel.addEventListener('change', () => {
		state.statusFilter = statusSel.value as UnitStatus | '';
		state.page = 0;
		onRefresh();
	});
	bar.appendChild(statusSel);

	// Risk filter
	const riskOptions: Array<{ value: string; label: string }> = [
		{ value: '', label: 'All Risks' },
		...RISK_ORDER.map(r => ({ value: r, label: r.charAt(0).toUpperCase() + r.slice(1) })),
	];
	const riskSel = $select(riskOptions, state.riskFilter, 'font-size:11px;');
	riskSel.addEventListener('change', () => {
		state.riskFilter = riskSel.value as RiskLevel | '';
		state.page = 0;
		onRefresh();
	});
	bar.appendChild(riskSel);

	// Language filter
	const langs = getLanguages(allUnits);
	if (langs.length > 1) {
		const langOptions: Array<{ value: string; label: string }> = [
			{ value: '', label: 'All Languages' },
			...langs.map(l => ({ value: l, label: l.toUpperCase() })),
		];
		const langSel = $select(langOptions, state.langFilter, 'font-size:11px;');
		langSel.addEventListener('change', () => {
			state.langFilter = langSel.value;
			state.page = 0;
			onRefresh();
		});
		bar.appendChild(langSel);
	}

	// Clear filters button
	const hasFilter = state.search || state.statusFilter || state.riskFilter || state.langFilter;
	if (hasFilter) {
		const clearBtn = $btn('Clear', false, () => {
			state.search = ''; state.statusFilter = '';
			state.riskFilter = ''; state.langFilter = '';
			state.page = 0;
			onRefresh();
		}, 'font-size:11px;padding:3px 10px;opacity:0.7;');
		bar.appendChild(clearBtn);
	}

	return bar;
}


// ─── Summary row ─────────────────────────────────────────────────────────────

function _buildSummaryRow(all: IKnowledgeUnit[], filteredCount: number): HTMLElement {
	const byStatus: Partial<Record<UnitStatus, number>> = {};
	for (const u of all) { byStatus[u.status] = (byStatus[u.status] ?? 0) + 1; }

	const row = $e('div', [
		'display:flex', 'align-items:center', 'flex-wrap:wrap', 'gap:6px',
		'padding:5px 12px',
		'border-bottom:1px solid var(--vscode-panel-border)',
		'background:var(--vscode-editor-background)',
		'flex-shrink:0', 'font-size:10px', 'color:var(--vscode-descriptionForeground)',
	].join(';'));

	row.appendChild($t('span', `${filteredCount} of ${all.length} units`));

	const statusChip = (s: UnitStatus) => {
		const count = byStatus[s];
		if (!count) { return; }
		const color = STATUS_COLOR[s] ?? '#888';
		const chip = $t('span', `${count} ${s}`, [
			'padding:1px 6px', 'border-radius:8px',
			`background:${color}22`,
			`color:${color}`,
			`border:1px solid ${color}44`,
			'font-size:9px', 'font-weight:600', 'white-space:nowrap',
		].join(';'));
		row.appendChild(chip);
	};

	for (const s of ['blocked', 'flagged', 'translating', 'review', 'ready', 'pending', 'complete'] as UnitStatus[]) {
		statusChip(s);
	}

	return row;
}


// ─── Table ───────────────────────────────────────────────────────────────────

function _buildTable(
	units:        IKnowledgeUnit[],
	state:        IUnitIndexState,
	kb:           IKnowledgeBaseService,
	tools:        IModernisationAgentToolService,
	onRefresh:    () => void,
	onOpenEditor: (unitId: string) => void,
): HTMLElement {
	const table = $e('div', 'display:flex;flex-direction:column;gap:0;');

	// Column header
	const colHdr = $e('div', [
		'display:grid',
		'grid-template-columns:120px 1fr 80px 70px 60px 60px 70px',
		'padding:5px 12px', 'font-size:10px', 'font-weight:700',
		'text-transform:uppercase', 'letter-spacing:0.06em',
		'color:var(--vscode-descriptionForeground)',
		'border-bottom:1px solid var(--vscode-widget-border)',
		'user-select:none', 'flex-shrink:0',
	].join(';'));

	const sortHdr = (label: string, col: UnitSortCol) => {
		const isActive = state.sortCol === col;
		const hdrEl = $t('div', [
			label,
			isActive ? (state.sortDir === 'asc' ? ' \u25b2' : ' \u25bc') : '',
		].join(''), [
			'cursor:pointer', 'padding:2px 4px',
			'border-radius:2px',
			isActive ? 'color:var(--vscode-editor-foreground);' : '',
		].join(';'));
		hdrEl.addEventListener('click', () => {
			if (state.sortCol === col) {
				state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
			} else {
				state.sortCol = col;
				state.sortDir = 'asc';
			}
			state.page = 0;
			onRefresh();
		});
		return hdrEl;
	};

	colHdr.appendChild(sortHdr('Status',   'status'));
	colHdr.appendChild(sortHdr('Name',     'name'));
	colHdr.appendChild(sortHdr('Language', 'language'));
	colHdr.appendChild(sortHdr('Risk',     'risk'));
	colHdr.appendChild(sortHdr('Deps',     'deps'));
	colHdr.appendChild(sortHdr('Updated',  'updated'));
	colHdr.appendChild($t('div', 'Actions', 'padding:2px 4px;'));
	table.appendChild(colHdr);

	for (const unit of units) {
		table.appendChild(_buildUnitRow(unit, state, kb, tools, onRefresh, onOpenEditor));
	}

	return table;
}


// ─── Unit row ─────────────────────────────────────────────────────────────────

function _buildUnitRow(
	unit:         IKnowledgeUnit,
	state:        IUnitIndexState,
	kb:           IKnowledgeBaseService,
	tools:        IModernisationAgentToolService,
	onRefresh:    () => void,
	onOpenEditor: (unitId: string) => void,
): HTMLElement {
	const isExpanded = state.expandedIds.has(unit.id);

	const wrapper = $e('div', [
		'border-bottom:1px solid var(--vscode-widget-border)',
		isExpanded ? 'background:var(--vscode-list-inactiveSelectionBackground,rgba(255,255,255,0.03));' : '',
	].join(';'));

	// Main row
	const row = $e('div', [
		'display:grid',
		'grid-template-columns:120px 1fr 80px 70px 60px 60px 70px',
		'align-items:center', 'padding:6px 12px', 'cursor:pointer',
		'min-height:34px',
	].join(';'));
	row.addEventListener('mouseenter', () => {
		if (!isExpanded) { row.style.background = 'var(--vscode-list-hoverBackground)'; }
	});
	row.addEventListener('mouseleave', () => {
		if (!isExpanded) { row.style.background = ''; }
	});
	row.addEventListener('click', () => {
		if (isExpanded) { state.expandedIds.delete(unit.id); }
		else             { state.expandedIds.add(unit.id); }
		onRefresh();
	});

	// Status
	row.appendChild($statusBadge(unit.status));

	// Name + file
	const nameCell = $e('div', 'overflow:hidden;padding:0 6px;');
	nameCell.appendChild($t('div', unit.name, [
		'font-size:12px', 'font-weight:600',
		'color:var(--vscode-editor-foreground)',
		'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
	].join(';')));
	nameCell.appendChild($t('div', basename(unit.sourceFile), [
		'font-size:10px', 'color:var(--vscode-descriptionForeground)',
		'font-family:var(--vscode-editor-font-family,monospace)',
		'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
	].join(';')));
	row.appendChild(nameCell);

	// Language
	row.appendChild($t('span', unit.sourceLang?.toUpperCase() ?? '—', [
		'font-size:10px', 'color:var(--vscode-descriptionForeground)',
	].join(';')));

	// Risk
	row.appendChild($riskBadge(unit.riskLevel));

	// Deps count
	const depCount = (unit.dependsOn?.length ?? 0);
	row.appendChild($t('span', depCount > 0 ? String(depCount) : '—', [
		'font-size:11px',
		depCount > 0 ? 'color:var(--vscode-editor-foreground);' : 'color:var(--vscode-descriptionForeground);',
	].join(';')));

	// Updated
	row.appendChild($t('span', unit.updatedAt ? relativeTime(unit.updatedAt) : '—', [
		'font-size:10px', 'color:var(--vscode-descriptionForeground)',
	].join(';')));

	// Actions
	const actionsCell = $e('div', 'display:flex;gap:4px;align-items:center;');

	// "Review" button: shown for units that have a translation draft needing review
	if (['review', 'flagged', 'approved'].includes(unit.status) && (unit.targetText || unit.targetFile)) {
		const reviewBtn = $btn('Review', true, () => { onOpenEditor(unit.id); }, 'font-size:9px;padding:2px 6px;');
		reviewBtn.addEventListener('click', (e) => e.stopPropagation());
		actionsCell.appendChild(reviewBtn);
	}

	if (unit.status === 'blocked' || unit.status === 'flagged') {
		const readyBtn = $btn('Ready', false, () => {
			tools.flagReady({ unitId: unit.id, actor: 'human', reason: 'Manually set to ready from Console' });
			onRefresh();
		}, 'font-size:9px;padding:2px 6px;');
		readyBtn.addEventListener('click', (e) => e.stopPropagation());
		actionsCell.appendChild(readyBtn);
	}
	row.appendChild(actionsCell);

	wrapper.appendChild(row);

	// Expanded detail pane
	if (isExpanded) {
		wrapper.appendChild(_buildExpandedDetail(unit, kb, tools, onRefresh));
	}

	return wrapper;
}


// ─── Expanded detail ──────────────────────────────────────────────────────────

function _buildExpandedDetail(
	unit:      IKnowledgeUnit,
	kb:        IKnowledgeBaseService,
	tools:     IModernisationAgentToolService,
	onRefresh: () => void,
): HTMLElement {
	const detail = $e('div', [
		'padding:12px 16px 16px',
		'background:var(--vscode-input-background)',
		'border-top:1px solid var(--vscode-widget-border)',
		'display:flex', 'flex-direction:column', 'gap:10px',
	].join(';'));

	// Meta row
	const meta = $e('div', 'display:flex;flex-wrap:wrap;gap:16px;font-size:11px;color:var(--vscode-descriptionForeground);');
	const metaItem = (label: string, value: string) => {
		const item = $e('div', '');
		item.appendChild($t('span', label + ': ', 'font-weight:600;'));
		item.appendChild($t('span', value));
		return item;
	};
	meta.appendChild(metaItem('ID', unit.id));
	meta.appendChild(metaItem('Type', unit.unitType ?? '—'));
	meta.appendChild(metaItem('Domain', unit.domain ?? '—'));
	meta.appendChild(metaItem('Phase', unit.phaseId ?? '—'));
	if (unit.targetFile) { meta.appendChild(metaItem('Target', unit.targetFile)); }
	detail.appendChild(meta);

	// Source snippet
	if (unit.sourceText) {
		const snipWrap = $e('div', '');
		snipWrap.appendChild($t('div', 'Source Preview',
			'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-descriptionForeground);margin-bottom:4px;'));
		const snip = $t('pre', truncate(unit.sourceText, 400), [
			'font-size:11px', 'line-height:1.6',
			'font-family:var(--vscode-editor-font-family,monospace)',
			'color:var(--vscode-editor-foreground)',
			'background:var(--vscode-editor-background)',
			'border:1px solid var(--vscode-widget-border)',
			'padding:8px 10px', 'border-radius:3px',
			'overflow:auto', 'max-height:120px', 'white-space:pre-wrap', 'word-break:break-word',
			'margin:0',
		].join(';'));
		snipWrap.appendChild(snip);
		detail.appendChild(snipWrap);
	}

	// Translated target snippet
	if (unit.targetText) {
		const tgtWrap = $e('div', '');
		tgtWrap.appendChild($t('div', 'Translated Output',
			'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-terminal-ansiGreen,#4caf50);margin-bottom:4px;'));
		const tgtSnip = $t('pre', truncate(unit.targetText, 300), [
			'font-size:11px', 'line-height:1.6',
			'font-family:var(--vscode-editor-font-family,monospace)',
			'color:var(--vscode-editor-foreground)',
			'background:var(--vscode-editor-background)',
			'border:1px solid rgba(76,175,80,0.3)',
			'padding:8px 10px', 'border-radius:3px',
			'overflow:auto', 'max-height:100px', 'white-space:pre-wrap', 'word-break:break-word',
			'margin:0',
		].join(';'));
		tgtWrap.appendChild(tgtSnip);
		detail.appendChild(tgtWrap);
	}

	// Business rules + annotations counts
	const counts = $e('div', 'display:flex;gap:12px;flex-wrap:wrap;');
	const countChip = (label: string, n: number) => {
		const color = n > 0 ? 'var(--vscode-badge-foreground)' : 'var(--vscode-descriptionForeground)';
		return $t('span', `${n} ${label}`, [
			'font-size:10px', 'padding:1px 6px', 'border-radius:8px',
			n > 0 ? 'background:var(--vscode-badge-background);' : '',
			`color:${color}`,
		].join(';'));
	};
	counts.appendChild(countChip('business rules', unit.businessRules?.length ?? 0));
	counts.appendChild(countChip('annotations',    kb.getAnnotations(unit.id).length));
	counts.appendChild(countChip('approvals',      unit.approvals?.length ?? 0));
	const decLog = kb.getDecisionsForUnit(unit.id);
	const decCount = (decLog.typeMapping?.length ?? 0) + (decLog.naming?.length ?? 0) + (decLog.ruleInterpret?.length ?? 0);
	counts.appendChild(countChip('decisions', decCount));
	detail.appendChild(counts);

	// Action buttons row
	const actRow = $e('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;');

	if (unit.status === 'blocked' || unit.status === 'flagged') {
		actRow.appendChild($btn('Set Ready', false, () => {
			tools.flagReady({ unitId: unit.id, actor: 'human', reason: 'Set ready from Unit Index' });
			onRefresh();
		}, 'font-size:11px;'));
	}

	if (['review', 'complete', 'validated', 'approved'].includes(unit.status)) {
		actRow.appendChild($btn('Revert to Pending', false, () => {
			tools.revertUnit({ unitId: unit.id, reason: 'Reverted from Console', actor: 'human' });
			onRefresh();
		}, 'font-size:11px;'));
	}

	if (unit.status === 'pending' || unit.status === 'ready') {
		// Check if there's a pending decision for this unit
		const pending = kb.getPendingDecisionForUnit(unit.id);
		if (pending) {
			const blockedBadge = $t('span',
				'\u26a0 Pending Decision: ' + truncate(pending.question, 60),
				'font-size:10px;color:#e0a84e;font-style:italic;');
			actRow.appendChild(blockedBadge);
		}
	}

	if (actRow.children.length === 0) {
		actRow.appendChild($t('span', 'No actions available for current status.',
			'font-size:10px;color:var(--vscode-descriptionForeground);font-style:italic;'));
	}

	detail.appendChild(actRow);
	return detail;
}
