/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared DOM helpers, colour constants, and formatting utilities
 * used by all four Modernisation Console views.
 *
 * No innerHTML — all DOM construction uses textContent + element APIs (Trusted Types compliant).
 */

import { UnitStatus, RiskLevel } from '../../../common/knowledgeBaseTypes.js';

// ─── DOM helpers ──────────────────────────────────────────────────────────────

export function $e<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	css?: string,
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	if (css) { el.style.cssText = css; }
	return el;
}

export function $t<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	text: string,
	css?: string,
): HTMLElementTagNameMap[K] {
	const el = $e(tag, css);
	el.textContent = text;
	return el;
}

export function $btn(
	label: string,
	primary: boolean,
	onClick: () => void,
	extraCss?: string,
): HTMLButtonElement {
	const btn = document.createElement('button');
	btn.textContent = label;
	btn.style.cssText = [
		'border:none', 'cursor:pointer', 'border-radius:3px',
		'padding:4px 12px', 'font-size:12px', 'font-family:inherit',
		primary
			? 'background:var(--vscode-button-background);color:var(--vscode-button-foreground);'
			: 'background:var(--vscode-button-secondaryBackground,var(--vscode-input-background));color:var(--vscode-button-secondaryForeground,var(--vscode-foreground));border:1px solid var(--vscode-widget-border);',
		extraCss ?? '',
	].join(';');
	btn.addEventListener('click', onClick);
	return btn;
}

export function $input(placeholder: string, value: string, css?: string): HTMLInputElement {
	const inp = document.createElement('input');
	inp.type = 'text';
	inp.placeholder = placeholder;
	inp.value = value;
	inp.style.cssText = [
		'background:var(--vscode-input-background)',
		'color:var(--vscode-input-foreground)',
		'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
		'border-radius:3px', 'padding:4px 8px', 'font-size:12px', 'font-family:inherit',
		css ?? '',
	].join(';');
	return inp;
}

export function $select(options: Array<{ value: string; label: string }>, value: string, css?: string): HTMLSelectElement {
	const sel = document.createElement('select');
	sel.style.cssText = [
		'background:var(--vscode-input-background)',
		'color:var(--vscode-input-foreground)',
		'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
		'border-radius:3px', 'padding:4px 8px', 'font-size:12px', 'font-family:inherit',
		css ?? '',
	].join(';');
	for (const opt of options) {
		const o = document.createElement('option');
		o.value = opt.value;
		o.textContent = opt.label;
		if (opt.value === value) { o.selected = true; }
		sel.appendChild(o);
	}
	return sel;
}

export function $textarea(placeholder: string, rows = 3, css?: string): HTMLTextAreaElement {
	const ta = document.createElement('textarea');
	ta.placeholder = placeholder;
	ta.rows = rows;
	ta.style.cssText = [
		'background:var(--vscode-input-background)',
		'color:var(--vscode-input-foreground)',
		'border:1px solid var(--vscode-input-border,var(--vscode-widget-border))',
		'border-radius:3px', 'padding:6px 8px', 'font-size:12px', 'font-family:inherit',
		'resize:vertical', 'width:100%', 'box-sizing:border-box',
		css ?? '',
	].join(';');
	return ta;
}

export function $divider(): HTMLElement {
	return $e('div', 'width:1px;background:var(--vscode-widget-border);align-self:stretch;margin:0 4px;');
}

export function $sectionHeader(title: string, rightEl?: HTMLElement): HTMLElement {
	const hdr = $e('div', [
		'display:flex', 'align-items:center', 'gap:8px',
		'padding:6px 12px',
		'background:var(--vscode-sideBarSectionHeader-background)',
		'border-bottom:1px solid var(--vscode-panel-border)',
		'flex-shrink:0',
	].join(';'));
	hdr.appendChild($t('span', title, [
		'font-size:10px', 'font-weight:700', 'text-transform:uppercase',
		'letter-spacing:0.07em', 'color:var(--vscode-sideBarSectionHeader-foreground)',
		'flex:1',
	].join(';')));
	if (rightEl) { hdr.appendChild(rightEl); }
	return hdr;
}

export function $emptyState(icon: string, title: string, body: string): HTMLElement {
	const wrap = $e('div', [
		'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
		'flex:1', 'padding:40px 24px', 'text-align:center', 'gap:4px',
	].join(';'));
	wrap.appendChild($t('div', icon, 'font-size:36px;opacity:0.2;margin-bottom:8px;'));
	wrap.appendChild($t('div', title, 'font-size:13px;font-weight:600;color:var(--vscode-editor-foreground);margin-bottom:4px;'));
	wrap.appendChild($t('div', body, 'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.6;max-width:360px;'));
	return wrap;
}

export function $card(extraCss?: string): HTMLElement {
	return $e('div', [
		'border:1px solid var(--vscode-widget-border)',
		'border-radius:5px', 'overflow:hidden',
		extraCss ?? '',
	].join(';'));
}


// ─── Colour maps ──────────────────────────────────────────────────────────────

export const STATUS_COLOR: Record<UnitStatus, string> = {
	pending:     '#888888',
	resolving:   '#64b5f6',
	ready:       'var(--vscode-focusBorder,#6496fa)',
	translating: '#e0a84e',
	review:      '#9c64fa',
	flagged:     '#ff7043',
	approved:    '#ab47bc',
	committed:   '#66bb6a',
	validating:  '#26a69a',
	validated:   '#26c6a6',
	complete:    'var(--vscode-terminal-ansiGreen,#4caf50)',
	skipped:     '#aaaaaa',
	blocked:     'var(--vscode-inputValidation-errorBorder,#f44336)',
};

export const RISK_COLOR: Record<RiskLevel, string> = {
	critical: 'var(--vscode-inputValidation-errorBorder,#f44336)',
	high:     '#e0a84e',
	medium:   '#64b5f6',
	low:      'var(--vscode-terminal-ansiGreen,#81c784)',
};

export const PRIORITY_COLOR: Record<string, string> = {
	blocking: '#f44336',
	high:     '#e0a84e',
	medium:   '#64b5f6',
	low:      '#888888',
};

export const DECISION_TYPE_LABEL: Record<string, string> = {
	'type-mapping':       'Type Mapping',
	'naming':             'Naming',
	'rule-interpretation':'Rule',
	'approval':           'Approval',
	'exclusion':          'Exclusion',
	'pattern-override':   'Pattern',
};


// ─── Formatting ───────────────────────────────────────────────────────────────

export function relativeTime(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 60_000)    { return 'just now'; }
	if (diff < 3_600_000) { return `${Math.floor(diff / 60_000)}m ago`; }
	if (diff < 86_400_000){ return `${Math.floor(diff / 3_600_000)}h ago`; }
	return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function truncate(s: string, maxLen: number): string {
	if (s.length <= maxLen) { return s; }
	return s.slice(0, maxLen) + '\u2026';
}

export function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

export function formatNumber(n: number): string {
	return n.toLocaleString();
}

export function pct(n: number, total: number): number {
	return total > 0 ? Math.round((n / total) * 100) : 0;
}


// ─── Status badge ─────────────────────────────────────────────────────────────

export function $statusBadge(status: UnitStatus): HTMLElement {
	const color = STATUS_COLOR[status] ?? '#888';
	const el = $t('span', status, [
		'font-size:9px', 'font-weight:700', 'letter-spacing:0.05em',
		'padding:2px 6px', 'border-radius:10px',
		`background:${color}22`,
		`color:${color}`,
		`border:1px solid ${color}55`,
		'white-space:nowrap',
	].join(';'));
	return el;
}

export function $riskBadge(risk: RiskLevel): HTMLElement {
	const color = RISK_COLOR[risk] ?? '#888';
	const el = $t('span', risk, [
		'font-size:9px', 'font-weight:700', 'letter-spacing:0.05em',
		'padding:2px 6px', 'border-radius:10px',
		`background:${color}22`,
		`color:${color}`,
		`border:1px solid ${color}55`,
		'white-space:nowrap',
	].join(';'));
	return el;
}

export function $priorityBadge(priority: string): HTMLElement {
	const color = PRIORITY_COLOR[priority] ?? '#888';
	const el = $t('span', priority.toUpperCase(), [
		'font-size:9px', 'font-weight:700', 'letter-spacing:0.05em',
		'padding:2px 6px', 'border-radius:10px',
		`background:${color}22`,
		`color:${color}`,
		`border:1px solid ${color}55`,
		'white-space:nowrap',
	].join(';'));
	return el;
}

export function $typeBadge(type: string): HTMLElement {
	const el = $t('span', DECISION_TYPE_LABEL[type] ?? type, [
		'font-size:9px', 'font-weight:700', 'letter-spacing:0.05em',
		'padding:2px 6px', 'border-radius:10px',
		'background:var(--vscode-badge-background)',
		'color:var(--vscode-badge-foreground)',
		'white-space:nowrap',
	].join(';'));
	return el;
}


// ─── Progress bar ─────────────────────────────────────────────────────────────

export function $progressBar(
	value: number,    // 0-100
	accent: string,
	heightPx = 4,
): HTMLElement {
	const bg = $e('div', [
		`height:${heightPx}px`, 'border-radius:2px',
		'background:var(--vscode-widget-border)',
		'overflow:hidden', 'flex-shrink:0',
	].join(';'));
	const fill = $e('div', [
		`width:${Math.min(100, Math.max(0, value))}%`,
		'height:100%', 'border-radius:2px',
		`background:${accent}`,
	].join(';'));
	bg.appendChild(fill);
	return bg;
}


// ─── Pagination controls ──────────────────────────────────────────────────────

export interface IPaginationState {
	page: number;
	pageSize: number;
	total: number;
}

export function $pagination(
	state: IPaginationState,
	onPrev: () => void,
	onNext: () => void,
): HTMLElement {
	const { page, pageSize, total } = state;
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const start      = page * pageSize + 1;
	const end        = Math.min(total, (page + 1) * pageSize);

	const row = $e('div', [
		'display:flex', 'align-items:center', 'gap:8px',
		'padding:8px 12px',
		'border-top:1px solid var(--vscode-widget-border)',
		'font-size:11px', 'color:var(--vscode-descriptionForeground)',
		'flex-shrink:0',
	].join(';'));

	const prevBtn = $btn('\u2039 Prev', false, onPrev, 'padding:2px 8px;font-size:11px;');
	if (page === 0) {
		(prevBtn as HTMLButtonElement).disabled = true;
		prevBtn.style.opacity = '0.4';
		prevBtn.style.cursor  = 'not-allowed';
	}
	row.appendChild(prevBtn);

	row.appendChild($t('span',
		total === 0 ? 'No results' : `${start}–${end} of ${total}`,
		'flex:1;text-align:center;'));

	const nextBtn = $btn('Next \u203a', false, onNext, 'padding:2px 8px;font-size:11px;');
	if (page >= totalPages - 1) {
		(nextBtn as HTMLButtonElement).disabled = true;
		nextBtn.style.opacity = '0.4';
		nextBtn.style.cursor  = 'not-allowed';
	}
	row.appendChild(nextBtn);

	return row;
}
