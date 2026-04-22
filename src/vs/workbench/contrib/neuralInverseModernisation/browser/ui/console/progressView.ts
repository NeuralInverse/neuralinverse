/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Progress View — Tab 4 of the Modernisation Console.
 *
 * Comprehensive live progress dashboard showing:
 *  1. Overall completion bar with percentage
 *  2. Status breakdown grid (pending / ready / translating / review / blocked / etc.)
 *  3. Velocity metrics: units/day rolling average, ETA
 *  4. Phase-by-phase progress bars (from KB phases)
 *  5. Risk breakdown: critical/high/medium/low unit counts + bars
 *  6. Language breakdown: top languages by unit count
 *  7. Domain breakdown: top domains by unit count
 *  8. KB health status: healthy / warnings / critical with issue list
 *  9. Decision health: pending count by priority, conflict count, drift alerts
 * 10. Work packages summary
 */

import { IKnowledgeBaseService } from '../../knowledgeBase/service.js';
import { IValidationEngineService } from '../../engine/validation/service.js';
import { ICutoverService } from '../../engine/cutover/service.js';
import { IAutonomyService } from '../../engine/autonomy/service.js';
import { complianceScoreFromSnapshot, primaryFrameworkFromSnapshot, SAFETY_CRITICAL_DOMAINS } from '../../engine/discovery/grcSnapshotBuilder.js';
import type { IGRCSnapshot } from '../../engine/discovery/discoveryTypes.js';
import {
	ALL_AUTONOMY_STAGES,
	type BatchState, type AutonomyStage, type IAutonomyOptions,
} from '../../engine/autonomy/impl/autonomyTypes.js';
import { UnitStatus, RiskLevel } from '../../../common/knowledgeBaseTypes.js';
import {
	$e, $t, $btn, $card, $input, $sectionHeader, $emptyState, $progressBar, $divider,
	STATUS_COLOR, RISK_COLOR,
	pct, formatNumber, relativeTime,
} from './consoleHelpers.js';

// ─── Status display order ─────────────────────────────────────────────────────

const STATUS_DISPLAY: Array<{ status: UnitStatus; label: string }> = [
	{ status: 'complete',    label: 'Complete'    },
	{ status: 'validated',   label: 'Validated'   },
	{ status: 'committed',   label: 'Committed'   },
	{ status: 'committing',  label: 'Committing'  },
	{ status: 'approved',    label: 'Approved'    },
	{ status: 'validating',  label: 'Validating'  },
	{ status: 'review',      label: 'In Review'   },
	{ status: 'translating', label: 'Translating' },
	{ status: 'ready',       label: 'Ready'       },
	{ status: 'resolving',   label: 'Resolving'   },
	{ status: 'pending',     label: 'Pending'     },
	{ status: 'blocked',     label: 'Blocked'     },
	{ status: 'flagged',     label: 'Flagged'     },
	{ status: 'skipped',     label: 'Skipped'     },
];

const RISK_DISPLAY: RiskLevel[] = ['critical', 'high', 'medium', 'low'];
const RISK_LABEL: Record<RiskLevel, string> = {
	critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low',
};


// ─── Build ────────────────────────────────────────────────────────────────────

export function buildProgressView(
	kb:          IKnowledgeBaseService,
	validation?: IValidationEngineService,
	onRefresh?:  () => void,
	cutover?:    ICutoverService,
	autonomy?:   IAutonomyService,
	grcSnapshot?: IGRCSnapshot,
): HTMLElement {
	const root = $e('div', 'display:flex;flex-direction:column;height:100%;overflow:hidden;');

	if (!kb.isActive) {
		root.appendChild($emptyState('\u{1F4CA}', 'Knowledge base not active', 'Initialise a session to track progress.'));
		return root;
	}

	const stats    = kb.getStats();
	const phases   = kb.getAllPhases();
	const velocity = kb.getVelocityMetrics(7);
	const health   = kb.getLastHealthCheck();
	const drifts   = kb.getDriftAlerts(true);
	const conflicts = kb.getDecisionConflicts(true);
	const pending  = kb.getPendingDecisions();

	const scroll = $e('div', 'flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:16px;');
	root.appendChild($sectionHeader('Progress Dashboard'));
	root.appendChild(scroll);

	// 1. Overall progress
	scroll.appendChild(_buildOverallProgress(stats));

	// 2. Status breakdown
	scroll.appendChild(_buildStatusBreakdown(stats));

	// 3. Velocity
	scroll.appendChild(_buildVelocity(velocity, stats));

	// 4. Phase progress (only if phases are set)
	if (phases.length > 0) {
		scroll.appendChild(_buildPhaseProgress(phases));
	}

	// 5. Risk breakdown
	scroll.appendChild(_buildRiskBreakdown(stats));

	// 6. Language breakdown (from stats.byLanguage)
	if (stats.byLanguage && stats.byLanguage.length > 0) {
		scroll.appendChild(_buildLanguageBreakdown(stats));
	}

	// 7. Domain breakdown (from stats.byDomain)
	if (stats.byDomain && stats.byDomain.length > 0) {
		scroll.appendChild(_buildDomainBreakdown(stats));
	}

	// 8. GRC compliance score (when discovery snapshot is available)
	if (grcSnapshot) {
		scroll.appendChild(_buildComplianceScoreSection(grcSnapshot));
	}

	// 9. Decision health
	scroll.appendChild(_buildDecisionHealth(stats, pending, conflicts, drifts));

	// 10. KB health
	scroll.appendChild(_buildKBHealth(health, stats));

	// 11. Validation (Phase 10) — only when engine is available
	if (validation) {
		scroll.appendChild(_buildValidationSection(kb, validation, stats, onRefresh ?? (() => { /* no-op */ })));
	}

	// 12. Cutover (Phase 11) — only when service is available
	if (cutover) {
		scroll.appendChild(_buildCutoverSection(kb, cutover, onRefresh ?? (() => { /* no-op */ })));
	}

	// 13. Autonomy (Phase 12) — only when service is available
	if (autonomy) {
		scroll.appendChild(_buildAutonomySection(autonomy, onRefresh ?? (() => { /* no-op */ })));
	}

	// Spacer
	scroll.appendChild($e('div', 'height:16px;flex-shrink:0;'));

	return root;
}


// ─── Overall progress card ────────────────────────────────────────────────────

function _buildOverallProgress(
	stats: import('../../knowledgeBase/types.js').IKnowledgeBaseStats,
): HTMLElement {
	const card = $e('div', [
		'border:1px solid var(--vscode-widget-border)',
		'border-radius:6px', 'padding:16px',
		'background:var(--vscode-sideBar-background,var(--vscode-editor-background))',
	].join(';'));

	// Big percentage
	const pctRow = $e('div', 'display:flex;align-items:baseline;gap:8px;margin-bottom:8px;');
	pctRow.appendChild($t('span', `${stats.percentComplete}%`, [
		'font-size:36px', 'font-weight:700', 'line-height:1',
		'color:var(--vscode-focusBorder,#6496fa)',
	].join(';')));
	pctRow.appendChild($t('span', 'complete', 'font-size:14px;color:var(--vscode-descriptionForeground);'));
	card.appendChild(pctRow);

	// Progress bar
	const bar = $progressBar(stats.percentComplete, 'var(--vscode-focusBorder,#6496fa)', 8);
	bar.style.marginBottom = '12px';
	card.appendChild(bar);

	// Quick stats row
	const quickStats = $e('div', 'display:flex;flex-wrap:wrap;gap:16px;font-size:11px;');
	const qs = (label: string, value: string | number, color?: string) => {
		const item = $e('div', 'text-align:center;');
		item.appendChild($t('div', String(value), [
			'font-size:18px', 'font-weight:700', 'line-height:1',
			color ? `color:${color};` : 'color:var(--vscode-editor-foreground);',
		].join(';')));
		item.appendChild($t('div', label, 'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:2px;'));
		return item;
	};

	const doneCount = (stats.byStatus['complete'] ?? 0) + (stats.byStatus['validated'] ?? 0) + (stats.byStatus['committed'] ?? 0) + (stats.byStatus['committing'] ?? 0);
	quickStats.appendChild(qs('Total Units',  formatNumber(stats.totalUnits)));
	quickStats.appendChild($divider());
	quickStats.appendChild(qs('Done',         formatNumber(doneCount), 'var(--vscode-terminal-ansiGreen,#4caf50)'));
	quickStats.appendChild($divider());
	quickStats.appendChild(qs('Blocked',      formatNumber(stats.byStatus['blocked'] ?? 0), (stats.byStatus['blocked'] ?? 0) > 0 ? '#f44336' : undefined));
	quickStats.appendChild($divider());
	quickStats.appendChild(qs('Pending Dec.', formatNumber(stats.pendingDecisionCount), stats.pendingDecisionCount > 0 ? '#e0a84e' : undefined));
	quickStats.appendChild($divider());
	quickStats.appendChild(qs('Files',        formatNumber(stats.totalFiles)));
	quickStats.appendChild($divider());
	quickStats.appendChild(qs('Decisions',    formatNumber(stats.totalDecisions)));
	card.appendChild(quickStats);

	return card;
}


// ─── Status breakdown ─────────────────────────────────────────────────────────

function _buildStatusBreakdown(
	stats: import('../../knowledgeBase/types.js').IKnowledgeBaseStats,
): HTMLElement {
	const wrap = $e('div', [
		'border:1px solid var(--vscode-widget-border)',
		'border-radius:6px', 'overflow:hidden',
	].join(';'));
	wrap.appendChild($sectionHeader('Units by Status'));

	const body = $e('div', 'padding:8px;display:flex;flex-direction:column;gap:4px;');
	const total = stats.totalUnits;

	for (const { status, label } of STATUS_DISPLAY) {
		const count = stats.byStatus[status] ?? 0;
		if (count === 0) { continue; }

		const row = $e('div', 'display:flex;align-items:center;gap:8px;padding:3px 4px;');
		const color = STATUS_COLOR[status] ?? '#888';

		// Dot
		row.appendChild($t('span', '\u25cf', `font-size:10px;color:${color};flex-shrink:0;`));

		// Label
		row.appendChild($t('span', label, 'font-size:11px;color:var(--vscode-editor-foreground);width:90px;flex-shrink:0;'));

		// Bar
		const barWrap = $e('div', 'flex:1;');
		barWrap.appendChild($progressBar(pct(count, total), color, 6));
		row.appendChild(barWrap);

		// Count + pct
		row.appendChild($t('span', `${formatNumber(count)} (${pct(count, total)}%)`, [
			'font-size:10px', 'color:var(--vscode-descriptionForeground)',
			'white-space:nowrap', 'width:80px', 'text-align:right',
		].join(';')));

		body.appendChild(row);
	}

	wrap.appendChild(body);
	return wrap;
}


// ─── Velocity ────────────────────────────────────────────────────────────────

function _buildVelocity(
	velocity: import('../../knowledgeBase/service.js').IVelocityMetrics,
	stats:    import('../../knowledgeBase/types.js').IKnowledgeBaseStats,
): HTMLElement {
	const wrap = $e('div', [
		'border:1px solid var(--vscode-widget-border)',
		'border-radius:6px', 'overflow:hidden',
	].join(';'));
	wrap.appendChild($sectionHeader('Velocity & ETA'));

	const body = $e('div', 'padding:12px;display:flex;flex-wrap:wrap;gap:20px;');

	const vStat = (label: string, value: string, sub?: string) => {
		const item = $e('div', 'flex:1;min-width:100px;text-align:center;');
		item.appendChild($t('div', value, 'font-size:20px;font-weight:700;color:var(--vscode-editor-foreground);line-height:1;'));
		if (sub) { item.appendChild($t('div', sub, 'font-size:9px;color:var(--vscode-descriptionForeground);margin-top:1px;')); }
		item.appendChild($t('div', label, 'font-size:10px;color:var(--vscode-descriptionForeground);margin-top:4px;'));
		return item;
	};

	const rollingStr = velocity.unitsPerDayRolling > 0
		? velocity.unitsPerDayRolling.toFixed(1)
		: '—';
	const allTimeStr = velocity.unitsPerDayAllTime > 0
		? velocity.unitsPerDayAllTime.toFixed(1)
		: '—';
	const etaStr = velocity.estimatedEtaDays != null
		? `${Math.ceil(velocity.estimatedEtaDays)} days`
		: '—';
	const etaDateStr = velocity.estimatedEtaMs
		? new Date(velocity.estimatedEtaMs).toLocaleDateString()
		: undefined;

	body.appendChild(vStat('Units/Day (7d)', rollingStr, '7-day rolling'));
	body.appendChild($divider());
	body.appendChild(vStat('Units/Day (all)', allTimeStr, 'all-time avg'));
	body.appendChild($divider());
	body.appendChild(vStat('ETA', etaStr, etaDateStr));
	body.appendChild($divider());

	const remaining = stats.totalUnits - ((stats.byStatus['complete'] ?? 0) + (stats.byStatus['validated'] ?? 0) + (stats.byStatus['committed'] ?? 0) + (stats.byStatus['committing'] ?? 0));
	body.appendChild(vStat('Remaining', formatNumber(remaining), 'units'));

	wrap.appendChild(body);

	if (velocity.unitsPerDayRolling === 0) {
		const hint = $t('div',
			'No velocity data yet. Units/day is calculated from status transitions to complete/validated/committed.',
			'font-size:10px;color:var(--vscode-descriptionForeground);font-style:italic;padding:0 12px 10px;line-height:1.5;');
		wrap.appendChild(hint);
	}

	return wrap;
}


// ─── Phase progress ───────────────────────────────────────────────────────────

function _buildPhaseProgress(
	phases: import('../../knowledgeBase/service.js').IPhaseProgress[],
): HTMLElement {
	const wrap = $e('div', [
		'border:1px solid var(--vscode-widget-border)',
		'border-radius:6px', 'overflow:hidden',
	].join(';'));

	const totalComplete = phases.reduce((s, p) => s + p.completedUnits, 0);
	const totalAll      = phases.reduce((s, p) => s + p.totalUnits, 0);

	const rightEl = $t('span', `${totalComplete}/${totalAll} total`, [
		'font-size:10px', 'color:var(--vscode-descriptionForeground)',
	].join(';'));
	wrap.appendChild($sectionHeader(`${phases.length} Phases`, rightEl));

	const body = $e('div', 'padding:8px;display:flex;flex-direction:column;gap:6px;');

	for (const phase of phases) {
		const phPct = pct(phase.completedUnits, phase.totalUnits);

		const phRow = $e('div', 'display:flex;flex-direction:column;gap:3px;padding:6px 8px;background:var(--vscode-input-background);border:1px solid var(--vscode-widget-border);border-radius:4px;');

		// Top row: label + counts
		const topRow = $e('div', 'display:flex;align-items:center;gap:8px;margin-bottom:4px;');
		topRow.appendChild($t('span', phase.label, 'font-size:11px;font-weight:600;color:var(--vscode-editor-foreground);flex:1;'));

		if (phase.blockedUnits > 0) {
			topRow.appendChild($t('span', `${phase.blockedUnits} blocked`, [
				'font-size:9px', 'padding:1px 5px', 'border-radius:8px',
				'background:#f4433622', 'color:#f44336', 'border:1px solid #f4433655',
			].join(';')));
		}

		topRow.appendChild($t('span', `${phase.completedUnits}/${phase.totalUnits}  (${phPct}%)`, [
			'font-size:10px', 'color:var(--vscode-descriptionForeground)', 'white-space:nowrap',
		].join(';')));
		phRow.appendChild(topRow);

		// Progress bar
		phRow.appendChild($progressBar(phPct, 'var(--vscode-focusBorder,#6496fa)', 5));

		body.appendChild(phRow);
	}

	wrap.appendChild(body);
	return wrap;
}


// ─── Risk breakdown ───────────────────────────────────────────────────────────

function _buildRiskBreakdown(
	stats: import('../../knowledgeBase/types.js').IKnowledgeBaseStats,
): HTMLElement {
	const wrap = $e('div', [
		'border:1px solid var(--vscode-widget-border)',
		'border-radius:6px', 'overflow:hidden',
	].join(';'));
	wrap.appendChild($sectionHeader('Units by Risk Level'));

	const body = $e('div', 'padding:8px;display:flex;flex-direction:column;gap:4px;');
	const total = stats.totalUnits;

	for (const risk of RISK_DISPLAY) {
		const count = stats.byRisk[risk] ?? 0;
		const color = RISK_COLOR[risk];

		const row = $e('div', 'display:flex;align-items:center;gap:8px;padding:3px 4px;');
		row.appendChild($t('span', '\u25cf', `font-size:10px;color:${color};flex-shrink:0;`));
		row.appendChild($t('span', RISK_LABEL[risk], 'font-size:11px;color:var(--vscode-editor-foreground);width:65px;flex-shrink:0;'));

		const barWrap = $e('div', 'flex:1;');
		barWrap.appendChild($progressBar(pct(count, total), color, 6));
		row.appendChild(barWrap);

		row.appendChild($t('span', `${formatNumber(count)} (${pct(count, total)}%)`, [
			'font-size:10px', 'color:var(--vscode-descriptionForeground)',
			'white-space:nowrap', 'width:80px', 'text-align:right',
		].join(';')));

		body.appendChild(row);
	}

	wrap.appendChild(body);
	return wrap;
}


// ─── Language breakdown ───────────────────────────────────────────────────────

function _buildLanguageBreakdown(
	stats: import('../../knowledgeBase/types.js').IKnowledgeBaseStats,
): HTMLElement {
	const wrap = $e('div', [
		'border:1px solid var(--vscode-widget-border)',
		'border-radius:6px', 'overflow:hidden',
	].join(';'));
	wrap.appendChild($sectionHeader('Units by Language'));

	const sorted = [...stats.byLanguage]
		.sort((a, b) => b.totalUnits - a.totalUnits)
		.slice(0, 10);

	const body = $e('div', 'padding:8px;display:flex;flex-direction:column;gap:4px;');
	const maxCount = sorted[0]?.totalUnits ?? 1;

	for (const lang of sorted) {
		const compPct = pct(lang.completedUnits, lang.totalUnits);
		const row = $e('div', 'display:flex;align-items:center;gap:8px;padding:4px 4px;background:var(--vscode-input-background);border:1px solid var(--vscode-widget-border);border-radius:3px;');

		// Language badge
		row.appendChild($t('span', lang.language.toUpperCase(), [
			'font-size:9px', 'font-weight:700',
			'background:var(--vscode-badge-background)',
			'color:var(--vscode-badge-foreground)',
			'padding:1px 5px', 'border-radius:2px',
			'width:55px', 'text-align:center', 'flex-shrink:0',
			'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap',
		].join(';')));

		// Two-part bar: completed (green) + remaining (grey)
		const barBg = $e('div', 'flex:1;height:6px;border-radius:3px;background:var(--vscode-widget-border);overflow:hidden;position:relative;');
		const totalBar = $e('div', [
			`width:${pct(lang.totalUnits, maxCount)}%`,
			'height:100%', 'border-radius:3px',
			'background:var(--vscode-sideBarSectionHeader-background)',
			'position:absolute', 'left:0', 'top:0',
		].join(';'));
		const doneBar = $e('div', [
			`width:${pct(lang.completedUnits, Math.max(lang.totalUnits, 1))}%`,
			'height:100%', 'border-radius:3px',
			'background:var(--vscode-terminal-ansiGreen,#4caf50)',
			'position:absolute', 'left:0', 'top:0',
		].join(';'));
		barBg.appendChild(totalBar);
		barBg.appendChild(doneBar);
		row.appendChild(barBg);

		// Stats
		row.appendChild($t('span', `${lang.totalUnits} units  ·  ${compPct}% done`, [
			'font-size:10px', 'color:var(--vscode-descriptionForeground)',
			'white-space:nowrap', 'min-width:100px', 'text-align:right',
		].join(';')));

		if (lang.blockedUnits > 0) {
			row.appendChild($t('span', `${lang.blockedUnits} blocked`, [
				'font-size:9px', 'color:#f44336', 'white-space:nowrap',
			].join(';')));
		}

		body.appendChild(row);
	}

	wrap.appendChild(body);
	return wrap;
}


// ─── GRC Compliance Score ─────────────────────────────────────────────────────

const VERTICAL_LABELS: Record<string, string> = {
	'iec-61508':   'IEC 61508 (Functional Safety)',
	'iec-62061':   'IEC 62061 (Machinery Safety)',
	'iec-61511':   'IEC 61511 (SIS/ESD)',
	'iso-26262':   'ISO 26262 (Automotive)',
	'autosar':     'AUTOSAR',
	'misra-c':     'MISRA-C',
	'misra-c++':   'MISRA-C++',
	'iec-62443':   'IEC 62443 (IIoT/OT)',
	'nerc-cip':    'NERC CIP',
	'3gpp-security': '3GPP Security',
	'gsma-nesas':  'GSMA NESAS',
	'certc':       'CERT-C',
	'cert-c++':    'CERT-C++',
	'iso-21434':   'ISO 21434 (Cybersecurity)',
};

function _buildComplianceScoreSection(snapshot: IGRCSnapshot): HTMLElement {
	const score  = complianceScoreFromSnapshot(snapshot);
	const primary = primaryFrameworkFromSnapshot(snapshot);
	const wrap = $e('div', [
		'border:1px solid var(--vscode-widget-border)',
		'border-radius:6px', 'overflow:hidden',
	].join(';'));
	wrap.appendChild($sectionHeader('GRC Compliance Score'));

	const body = $e('div', 'padding:12px;display:flex;flex-direction:column;gap:12px;background:var(--vscode-input-background);');

	// Score gauge row
	const gaugeColor = score >= 80 ? 'var(--vscode-terminal-ansiGreen,#4caf50)'
		: score >= 50  ? '#e0a84e'
		: 'var(--vscode-inputValidation-errorBorder,#f44336)';
	const gaugeLabel = score >= 80 ? 'COMPLIANT' : score >= 50 ? 'AT RISK' : 'NON-COMPLIANT';

	const gaugeRow = $e('div', 'display:flex;align-items:center;gap:14px;');
	const scoreBig = $e('div', 'text-align:center;flex-shrink:0;');
	scoreBig.appendChild($t('div', String(score), `font-size:40px;font-weight:700;line-height:1;color:${gaugeColor};`));
	scoreBig.appendChild($t('div', gaugeLabel, `font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${gaugeColor};margin-top:2px;`));
	gaugeRow.appendChild(scoreBig);

	const gaugeRight = $e('div', 'flex:1;display:flex;flex-direction:column;gap:6px;');
	gaugeRight.appendChild($progressBar(score, gaugeColor, 10));
	gaugeRight.appendChild($t('div',
		`Primary framework: ${VERTICAL_LABELS[primary] ?? primary.toUpperCase()} · ${snapshot.totalViolations} total violations · ${snapshot.blockingCount} blocking`,
		'font-size:10px;color:var(--vscode-descriptionForeground);line-height:1.4;'));
	gaugeRow.appendChild(gaugeRight);
	body.appendChild(gaugeRow);

	// Per-domain breakdown — show only safety-critical domains with hits
	const safeDomains = Object.entries(snapshot.byDomain)
		.filter(([d]) => SAFETY_CRITICAL_DOMAINS.has(d.toLowerCase()))
		.sort((a, b) => b[1] - a[1]);

	if (safeDomains.length > 0) {
		const domSec = $e('div', 'border-top:1px solid var(--vscode-widget-border);padding-top:8px;');
		domSec.appendChild($t('div', 'Regulated Domain Violations',
			'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);margin-bottom:6px;'));
		const maxCount = Math.max(1, ...safeDomains.map(([, c]) => c));
		for (const [domain, count] of safeDomains.slice(0, 8)) {
			const row = $e('div', 'display:flex;align-items:center;gap:8px;margin-bottom:4px;');
			row.appendChild($t('span', VERTICAL_LABELS[domain] ?? domain.toUpperCase(), [
				'font-size:10px', 'color:var(--vscode-editor-foreground)',
				'width:200px', 'flex-shrink:0',
				'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap',
			].join(';')));
			const barWrap = $e('div', 'flex:1;');
			barWrap.appendChild($progressBar(
				Math.round((count / maxCount) * 100),
				'var(--vscode-inputValidation-errorBorder,#f44336)',
				5,
			));
			row.appendChild(barWrap);
			row.appendChild($t('span', String(count), [
				'font-size:10px', 'color:var(--vscode-descriptionForeground)',
				'white-space:nowrap', 'width:28px', 'text-align:right',
			].join(';')));
			domSec.appendChild(row);
		}
		body.appendChild(domSec);
	}

	// Top violated rules (safety-relevant)
	const safetyRules = snapshot.topViolatedRules.filter(r =>
		['sil-', 'asil-', 'misra-c-', 'isr-', 'watchdog-', 'e2e-', 'certc-', 'iec62443-', 'iso21434-'].some(p =>
			r.ruleId.toLowerCase().startsWith(p),
		),
	);
	if (safetyRules.length > 0) {
		const ruleSec = $e('div', 'border-top:1px solid var(--vscode-widget-border);padding-top:8px;');
		ruleSec.appendChild($t('div', 'Top Safety-Critical Rule Violations',
			'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);margin-bottom:6px;'));
		for (const r of safetyRules.slice(0, 5)) {
			const row = $e('div', 'display:flex;align-items:center;gap:8px;padding:2px 0;');
			row.appendChild($t('code', r.ruleId, [
				'font-size:10px', 'color:var(--vscode-inputValidation-errorBorder,#f44336)',
				'flex:1', 'font-family:var(--vscode-editor-font-family,monospace)',
			].join(';')));
			row.appendChild($t('span', `×${r.count}`, [
				'font-size:10px', 'font-weight:700',
				'color:var(--vscode-descriptionForeground)', 'white-space:nowrap',
			].join(';')));
			ruleSec.appendChild(row);
		}
		body.appendChild(ruleSec);
	}

	wrap.appendChild(body);
	return wrap;
}


// ─── Domain breakdown ─────────────────────────────────────────────────────────

function _buildDomainBreakdown(
	stats: import('../../knowledgeBase/types.js').IKnowledgeBaseStats,
): HTMLElement {
	const wrap = $e('div', [
		'border:1px solid var(--vscode-widget-border)',
		'border-radius:6px', 'overflow:hidden',
	].join(';'));
	wrap.appendChild($sectionHeader('Units by Domain'));

	const sorted = [...stats.byDomain]
		.sort((a, b) => b.totalUnits - a.totalUnits)
		.slice(0, 10);

	const body = $e('div', 'padding:8px;display:flex;flex-direction:column;gap:3px;');

	for (const domain of sorted) {
		const compPct = pct(domain.completedUnits, domain.totalUnits);
		const row = $e('div', 'display:flex;align-items:center;gap:8px;padding:4px 6px;');

		// Regulated indicator
		if (domain.regulated) {
			row.appendChild($t('span', 'REG', [
				'font-size:9px', 'font-weight:700',
				'background:#e0a84e22', 'color:#e0a84e', 'border:1px solid #e0a84e55',
				'padding:1px 4px', 'border-radius:2px', 'flex-shrink:0',
			].join(';')));
		}

		row.appendChild($t('span', domain.domain, [
			'font-size:11px', 'color:var(--vscode-editor-foreground)', 'flex:1',
			'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap',
		].join(';')));

		const barWrap = $e('div', 'width:100px;flex-shrink:0;');
		barWrap.appendChild($progressBar(compPct, 'var(--vscode-focusBorder,#6496fa)', 5));
		row.appendChild(barWrap);

		row.appendChild($t('span', `${domain.totalUnits}u · ${compPct}%`, [
			'font-size:10px', 'color:var(--vscode-descriptionForeground)',
			'white-space:nowrap', 'width:75px', 'text-align:right',
		].join(';')));

		body.appendChild(row);
	}

	wrap.appendChild(body);
	return wrap;
}


// ─── Decision health ──────────────────────────────────────────────────────────

function _buildDecisionHealth(
	stats:     import('../../knowledgeBase/types.js').IKnowledgeBaseStats,
	pending:   import('../../../common/knowledgeBaseTypes.js').IPendingDecision[],
	conflicts: import('../../knowledgeBase/service.js').IDecisionConflict[],
	drifts:    import('../../knowledgeBase/service.js').ISourceDriftAlert[],
): HTMLElement {
	const wrap = $e('div', [
		'border:1px solid var(--vscode-widget-border)',
		'border-radius:6px', 'overflow:hidden',
	].join(';'));
	wrap.appendChild($sectionHeader('Decision & Drift Health'));

	const body = $e('div', 'padding:12px;display:flex;flex-direction:column;gap:8px;');

	// Pending by priority
	const byPriority = stats.pendingDecisionsByPriority;
	if (pending.length > 0) {
		const priRow = $e('div', 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;');
		priRow.appendChild($t('span', 'Pending Decisions: ', 'font-size:11px;font-weight:600;color:var(--vscode-editor-foreground);'));

		const priBadge = (label: string, count: number, color: string) => {
			if (count === 0) { return; }
			priRow.appendChild($t('span', `${count} ${label}`, [
				'font-size:10px', 'padding:2px 7px', 'border-radius:8px',
				`background:${color}22`, `color:${color}`, `border:1px solid ${color}55`,
			].join(';')));
		};

		priBadge('blocking', byPriority.blocking ?? 0, '#f44336');
		priBadge('high',     byPriority.high     ?? 0, '#e0a84e');
		priBadge('medium',   byPriority.medium   ?? 0, '#64b5f6');
		priBadge('low',      byPriority.low      ?? 0, '#888888');

		body.appendChild(priRow);
	} else {
		body.appendChild($t('div', '\u2713  No pending decisions — all decisions are resolved.',
			'font-size:11px;color:var(--vscode-terminal-ansiGreen,#4caf50);'));
	}

	// Conflicts
	if (conflicts.length > 0) {
		const confRow = $e('div', 'display:flex;align-items:center;gap:8px;');
		confRow.appendChild($t('span', '\u26a0', 'font-size:14px;color:#e0a84e;'));
		confRow.appendChild($t('span', `${conflicts.length} decision conflict(s) — use the Checks Agent or agent tool detect_conflicts to review.`,
			'font-size:11px;color:var(--vscode-editor-foreground);line-height:1.4;'));
		body.appendChild(confRow);
	}

	// Drift alerts
	if (drifts.length > 0) {
		const driftRow = $e('div', 'display:flex;align-items:center;gap:8px;');
		driftRow.appendChild($t('span', '\u{1F504}', 'font-size:14px;'));
		driftRow.appendChild($t('span', `${drifts.length} source file(s) have drifted since the last scan. Re-run Discovery to update.`,
			'font-size:11px;color:var(--vscode-editor-foreground);line-height:1.4;'));
		body.appendChild(driftRow);
	}

	if (pending.length === 0 && conflicts.length === 0 && drifts.length === 0) {
		body.appendChild($t('div', 'No drift alerts. Source files are current.',
			'font-size:10px;color:var(--vscode-descriptionForeground);font-style:italic;'));
	}

	wrap.appendChild(body);
	return wrap;
}


// ─── KB health ────────────────────────────────────────────────────────────────

function _buildKBHealth(
	health: import('../../knowledgeBase/service.js').IKBHealthReport | undefined,
	stats:  import('../../knowledgeBase/types.js').IKnowledgeBaseStats,
): HTMLElement {
	const wrap = $e('div', [
		'border:1px solid var(--vscode-widget-border)',
		'border-radius:6px', 'overflow:hidden',
	].join(';'));
	wrap.appendChild($sectionHeader('Knowledge Base Health'));

	const body = $e('div', 'padding:12px;display:flex;flex-direction:column;gap:8px;');

	// KB stats row
	const kbStats = $e('div', 'display:flex;flex-wrap:wrap;gap:16px;font-size:11px;margin-bottom:4px;');
	const kbStat = (label: string, value: string | number) => {
		const item = $e('div', '');
		item.appendChild($t('span', String(value), 'font-weight:600;color:var(--vscode-editor-foreground);'));
		item.appendChild($t('span', ' ' + label, 'color:var(--vscode-descriptionForeground);'));
		return item;
	};
	kbStats.appendChild(kbStat('decisions', stats.totalDecisions));
	kbStats.appendChild(kbStat('glossary terms', stats.totalGlossaryTerms));
	kbStats.appendChild(kbStat('audit entries', stats.totalAuditEntries));
	kbStats.appendChild(kbStat('files tracked', stats.totalFiles));
	body.appendChild(kbStats);

	if (!health) {
		body.appendChild($t('div',
			'No health check data. Use the agent tool run_health_check to run a full integrity check.',
			'font-size:10px;color:var(--vscode-descriptionForeground);font-style:italic;'));
	} else {
		// Health status badge
		const statusColor = health.isHealthy ? '#4caf50' : health.summary.errorCount > 0 ? '#f44336' : '#e0a84e';
		const statusText  = health.isHealthy ? '\u2713 Healthy' : health.summary.errorCount > 0 ? '\u2715 Critical' : '\u26a0 Warnings';

		const statusRow = $e('div', 'display:flex;align-items:center;gap:8px;');
		statusRow.appendChild($t('span', statusText, `font-size:12px;font-weight:700;color:${statusColor};`));
		statusRow.appendChild($t('span',
			`${health.summary.errorCount} error(s), ${health.summary.warningCount} warning(s)`,
			'font-size:10px;color:var(--vscode-descriptionForeground);'));
		if (health.generatedAt) {
			statusRow.appendChild($t('span', `Last run: ${relativeTime(health.generatedAt)}`,
				'font-size:10px;color:var(--vscode-descriptionForeground);'));
		}
		body.appendChild(statusRow);

		// Issues list
		const issues = health.issues.filter(i => i.severity === 'error' || i.severity === 'warning');
		if (issues.length > 0) {
			const issueList = $e('div', 'display:flex;flex-direction:column;gap:3px;margin-top:4px;');
			for (const issue of issues.slice(0, 8)) {
				const issueRow = $e('div', 'display:flex;gap:6px;align-items:flex-start;');
				const ic = issue.severity === 'error' ? '#f44336' : '#e0a84e';
				issueRow.appendChild($t('span', issue.severity === 'error' ? '\u2715' : '\u26a0', `color:${ic};font-size:11px;flex-shrink:0;margin-top:1px;`));
				issueRow.appendChild($t('span', issue.message, 'font-size:10px;color:var(--vscode-editor-foreground);line-height:1.4;'));
				issueList.appendChild(issueRow);
			}
			if (issues.length > 8) {
				issueList.appendChild($t('div', `+ ${issues.length - 8} more issues — run run_health_check for full report.`,
					'font-size:10px;color:var(--vscode-descriptionForeground);font-style:italic;margin-top:2px;'));
			}
			body.appendChild(issueList);
		}
	}

	wrap.appendChild(body);
	return wrap;
}


// ─── Validation section (Phase 10) ───────────────────────────────────────────

function _buildValidationSection(
	kb:         IKnowledgeBaseService,
	validation: IValidationEngineService,
	stats:      import('../../knowledgeBase/types.js').IKnowledgeBaseStats,
	onRefresh:  () => void,
): HTMLElement {
	const wrap = $e('div', [
		'border:1px solid var(--vscode-widget-border)',
		'border-radius:6px', 'overflow:hidden',
	].join(';'));

	wrap.appendChild($sectionHeader('Equivalence Validation'));

	const body = $e('div', 'padding:12px;display:flex;flex-direction:column;gap:10px;background:var(--vscode-input-background);');

	// Counts row
	const approvedCount   = stats.byStatus['approved']   ?? 0;
	const validatingCount = stats.byStatus['validating']  ?? 0;
	const validatedCount  = stats.byStatus['validated']   ?? 0;
	const flaggedCount    = stats.byStatus['flagged']     ?? 0;

	const countsRow = $e('div', 'display:flex;flex-wrap:wrap;gap:16px;');
	const statTile = (label: string, count: number, color: string) => {
		const tile = $e('div', 'text-align:center;min-width:60px;');
		tile.appendChild($t('div', String(count), `font-size:20px;font-weight:700;color:${color};line-height:1;`));
		tile.appendChild($t('div', label, 'font-size:9px;color:var(--vscode-descriptionForeground);margin-top:2px;text-transform:uppercase;letter-spacing:0.05em;'));
		return tile;
	};

	countsRow.appendChild(statTile('Approved',   approvedCount,   'var(--vscode-focusBorder,#6496fa)'));
	countsRow.appendChild(statTile('Validating', validatingCount, '#e0a84e'));
	countsRow.appendChild(statTile('Validated',  validatedCount,  'var(--vscode-terminal-ansiGreen,#4caf50)'));
	countsRow.appendChild(statTile('Diverged',   flaggedCount,    'var(--vscode-inputValidation-errorBorder,#f44336)'));
	body.appendChild(countsRow);

	// Last batch metrics
	const lastMetrics = validation.lastBatchMetrics;
	if (lastMetrics) {
		const passRate = lastMetrics.totalTestCases > 0
			? Math.round((lastMetrics.passedTestCases / lastMetrics.totalTestCases) * 100)
			: 100;
		const metricsRow = $e('div', 'font-size:10px;color:var(--vscode-descriptionForeground);border-top:1px solid var(--vscode-widget-border);padding-top:8px;');
		metricsRow.textContent =
			`Last batch: ${lastMetrics.validated} validated \u00b7 ${lastMetrics.failed} failed \u00b7 ${lastMetrics.partial} partial \u00b7 ${lastMetrics.totalTestCases} test cases \u00b7 ${passRate}% pass rate`;
		body.appendChild(metricsRow);

		body.appendChild($progressBar(passRate,
			passRate >= 80 ? 'var(--vscode-terminal-ansiGreen,#4caf50)'
			: passRate >= 50 ? '#e0a84e'
			: 'var(--vscode-inputValidation-errorBorder,#f44336)',
			6,
		));
	}

	// Action row
	const actionRow = $e('div', 'display:flex;align-items:center;gap:8px;margin-top:4px;');
	const statusEl  = $e('div', 'flex:1;font-size:10px;color:var(--vscode-descriptionForeground);');

	if (validation.isRunning) {
		statusEl.textContent = '\u23f3 Validation batch running\u2026';
		statusEl.style.color = '#e0a84e';
		const cancelBtn = $btn('Cancel', false, () => {
			validation.cancelBatch();
			onRefresh();
		}, 'font-size:10px;padding:3px 10px;');
		actionRow.appendChild(statusEl);
		actionRow.appendChild(cancelBtn);

	} else if (approvedCount === 0) {
		statusEl.textContent = '\u2713 No approved units pending validation.';
		actionRow.appendChild(statusEl);

	} else {
		statusEl.textContent = `${approvedCount} approved unit${approvedCount === 1 ? '' : 's'} ready.`;

		const schedule = validation.previewSchedule({ eligibleStatuses: ['approved'] });
		if (schedule.length > 0) {
			const critCount = schedule.filter(e => e.riskLevel === 'critical').length;
			const previewEl = $e('div', 'font-size:9px;color:var(--vscode-descriptionForeground);font-style:italic;margin-bottom:4px;');
			previewEl.textContent = critCount > 0
				? `${schedule.length} units queued \u00b7 ${critCount} critical first`
				: `${schedule.length} units queued`;
			body.appendChild(previewEl);
		}

		const runBtn = $btn('\u25b6 Run Validation', true, async () => {
			(runBtn as HTMLButtonElement).disabled = true;
			runBtn.textContent = 'Running\u2026';
			statusEl.textContent = 'Starting validation batch\u2026';
			statusEl.style.color = '#e0a84e';
			try {
				await validation.validateBatch({ eligibleStatuses: ['approved'] });
				onRefresh();
			} catch (err) {
				statusEl.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
				statusEl.style.color = 'var(--vscode-inputValidation-errorBorder,#f44336)';
				(runBtn as HTMLButtonElement).disabled = false;
				runBtn.textContent = '\u25b6 Run Validation';
			}
		}, 'font-size:10px;padding:3px 10px;');

		actionRow.appendChild(statusEl);
		actionRow.appendChild(runBtn);
	}

	body.appendChild(actionRow);

	// Divergence warning
	const divergedUnits = kb.getAllUnits().filter(u =>
		u.status === 'flagged' &&
		u.equivalenceResult &&
		u.equivalenceResult.failCount > 0 &&
		!u.equivalenceResult.overridden,
	);
	if (divergedUnits.length > 0) {
		const divRow = $e('div', [
			'font-size:10px',
			'color:var(--vscode-inputValidation-errorBorder,#f44336)',
			'border-top:1px solid var(--vscode-widget-border)',
			'padding-top:8px',
		].join(';'));
		divRow.textContent = `\u26a0 ${divergedUnits.length} unit${divergedUnits.length === 1 ? '' : 's'} have unresolved divergences \u2014 open in Unit Editor to review or override.`;
		body.appendChild(divRow);
	}

	wrap.appendChild(body);
	return wrap;
}


// ─── Cutover section (Phase 11) ───────────────────────────────────────────────

function _buildCutoverSection(
	kb:        IKnowledgeBaseService,
	cutover:   ICutoverService,
	onRefresh: () => void,
): HTMLElement {
	const wrap = $e('div', [
		'border:1px solid var(--vscode-widget-border)',
		'border-radius:6px', 'overflow:hidden',
	].join(';'));
	wrap.appendChild($sectionHeader('Cutover & Audit'));

	const body = $e('div', 'padding:12px;display:flex;flex-direction:column;gap:10px;background:var(--vscode-input-background);');

	const metrics = cutover.getMetrics();
	const report  = cutover.checkReadiness();

	// ── Stat tiles ────────────────────────────────────────────────────────────
	const tilesRow = $e('div', 'display:flex;flex-wrap:wrap;gap:16px;');
	const tile = (label: string, count: number, color: string) => {
		const el = $e('div', 'text-align:center;min-width:60px;');
		el.appendChild($t('div', String(count), `font-size:20px;font-weight:700;color:${color};line-height:1;`));
		el.appendChild($t('div', label, 'font-size:9px;color:var(--vscode-descriptionForeground);margin-top:2px;text-transform:uppercase;letter-spacing:0.05em;'));
		return el;
	};
	tilesRow.appendChild(tile('Validated',  metrics.validated,  'var(--vscode-terminal-ansiGreen,#4caf50)'));
	tilesRow.appendChild(tile('Committed',  metrics.committed,  'var(--vscode-focusBorder,#6496fa)'));
	tilesRow.appendChild(tile('Overridden', metrics.overridden, '#e0a84e'));
	tilesRow.appendChild(tile('Flagged',    metrics.flagged,    metrics.flagged > 0 ? 'var(--vscode-inputValidation-errorBorder,#f44336)' : 'var(--vscode-descriptionForeground)'));
	body.appendChild(tilesRow);

	// Commit coverage bar
	const compPct = Math.round(metrics.completionRate * 100);
	const coverRow = $e('div', 'display:flex;align-items:center;gap:8px;');
	coverRow.appendChild($t('span', 'Commit coverage:', 'font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;'));
	const coverBarWrap = $e('div', 'flex:1;');
	coverBarWrap.appendChild($progressBar(
		compPct,
		compPct === 100 ? 'var(--vscode-terminal-ansiGreen,#4caf50)' : 'var(--vscode-focusBorder,#6496fa)',
		6,
	));
	coverRow.appendChild(coverBarWrap);
	coverRow.appendChild($t('span', `${compPct}%`, 'font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;'));
	body.appendChild(coverRow);

	// ── Readiness checks ─────────────────────────────────────────────────────
	const readinessHeader = $e('div', 'display:flex;align-items:center;gap:8px;border-top:1px solid var(--vscode-widget-border);padding-top:8px;');
	const readyIcon  = report.isReady ? '\u2713' : '\u2715';
	const readyColor = report.isReady
		? 'var(--vscode-terminal-ansiGreen,#4caf50)'
		: 'var(--vscode-inputValidation-errorBorder,#f44336)';
	readinessHeader.appendChild($t('span', readyIcon, `font-size:14px;font-weight:700;color:${readyColor};`));
	readinessHeader.appendChild($t('span',
		report.isReady
			? 'Ready for cutover'
			: `Not ready \u2014 ${report.blocking} blocking check${report.blocking === 1 ? '' : 's'} failing`,
		`font-size:11px;font-weight:600;color:${readyColor};`));
	if (report.warnings > 0) {
		readinessHeader.appendChild($t('span',
			`${report.warnings} warning${report.warnings === 1 ? '' : 's'}`,
			'font-size:10px;color:#e0a84e;'));
	}
	body.appendChild(readinessHeader);

	// Per-check list
	const checkList = $e('div', 'display:flex;flex-direction:column;gap:3px;');
	for (const check of report.checks) {
		const checkRow = $e('div', 'display:flex;gap:6px;align-items:flex-start;');
		const ic = check.passed ? '\u2713'
			: check.severity === 'blocking' ? '\u2715'
			: check.severity === 'warning'  ? '\u26a0'
			: '\u2139';
		const icColor = check.passed    ? 'var(--vscode-terminal-ansiGreen,#4caf50)'
			: check.severity === 'blocking' ? 'var(--vscode-inputValidation-errorBorder,#f44336)'
			: check.severity === 'warning'  ? '#e0a84e'
			: 'var(--vscode-descriptionForeground)';
		checkRow.appendChild($t('span', ic, `font-size:11px;color:${icColor};flex-shrink:0;margin-top:1px;`));
		checkRow.appendChild($t('span',
			check.passed ? check.label : check.detail,
			`font-size:10px;color:${check.passed ? 'var(--vscode-descriptionForeground)' : 'var(--vscode-editor-foreground)'};line-height:1.4;`));
		checkList.appendChild(checkRow);
	}
	body.appendChild(checkList);

	// ── Action row ────────────────────────────────────────────────────────────
	const actionRow = $e('div', [
		'display:flex', 'align-items:center', 'gap:8px', 'flex-wrap:wrap',
		'border-top:1px solid var(--vscode-widget-border)', 'padding-top:8px',
	].join(';'));

	if (cutover.isCutoverApproved) {
		const rec       = cutover.cutoverApproval;
		const approvedAt = rec ? new Date(rec.approvedAt).toLocaleString() : '';
		const approvedBy = rec?.approvedBy ?? '';
		actionRow.appendChild($t('span',
			`\u2713 Cutover approved by ${approvedBy} at ${approvedAt}`,
			'font-size:11px;color:var(--vscode-terminal-ansiGreen,#4caf50);flex:1;'));
	} else {
		// Commit button
		const commitBtn = $btn(
			cutover.isCommitting ? 'Committing\u2026' : '\u{1F4BE} Commit Files',
			!cutover.isCommitting,
			async () => {
				(commitBtn as HTMLButtonElement).disabled = true;
				commitBtn.textContent = 'Committing\u2026';
				try {
					await cutover.commitBatch({ eligibleStatuses: ['validated'] });
				} finally {
					onRefresh();
				}
			},
			'font-size:10px;padding:3px 10px;',
		);
		actionRow.appendChild(commitBtn);

		// Export audit bundle button
		const exportBtn = $btn('\u{1F4C4} Export Audit', kb.isActive, () => {
			const bundle = cutover.exportAuditBundle({ exportedBy: 'user', exportedUnitsFilter: 'all' });
			const json   = cutover.formatAuditBundleAsJson(bundle);
			const blob   = new Blob([json], { type: 'application/json' });
			const url    = URL.createObjectURL(blob);
			const a      = document.createElement('a');
			a.href       = url;
			a.download   = `audit-bundle-${Date.now()}.json`;
			a.click();
			URL.revokeObjectURL(url);
		}, 'font-size:10px;padding:3px 10px;');
		actionRow.appendChild(exportBtn);

		// Approve cutover (only when all blocking checks pass)
		if (report.isReady) {
			const approveBtn = $btn('\u2713 Approve Cutover', true, () => {
				const approver  = window.prompt('Approver identity (name / ID):');
				if (!approver) { return; }
				const rationale = window.prompt('Rationale for cutover approval:');
				if (!rationale) { return; }
				const ticketRef = window.prompt('Change ticket reference (optional):') || undefined;
				try {
					cutover.approveCutover(approver, rationale, ticketRef);
					onRefresh();
				} catch (err) {
					window.alert(`Cutover approval failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}, [
				'font-size:10px', 'padding:3px 10px',
				'background:var(--vscode-button-background)',
				'color:var(--vscode-button-foreground)',
			].join(';'));
			actionRow.appendChild(approveBtn);
		}
	}

	body.appendChild(actionRow);

	// Last commit result summary
	const lastResult = cutover.lastCommitResult;
	if (lastResult) {
		const resultRow = $e('div', 'font-size:10px;color:var(--vscode-descriptionForeground);');
		resultRow.textContent =
			`Last commit: ${lastResult.committed} committed \u00b7 ${lastResult.skipped} skipped \u00b7 ${lastResult.errors} error(s)`;
		if (lastResult.errors > 0) {
			resultRow.style.color = 'var(--vscode-inputValidation-errorBorder,#f44336)';
		}
		body.appendChild(resultRow);
	}

	wrap.appendChild(body);
	return wrap;
}


// ─── Autonomy options state (persists across re-renders) ──────────────────────

interface _IAutonomyOpts {
	maxConcurrency: number;
	autoApprove:    boolean;
	stages:         AutonomyStage[];
}
const _autonomyOpts: _IAutonomyOpts = {
	maxConcurrency: 3,
	autoApprove:    false,
	stages:         [...ALL_AUTONOMY_STAGES],
};

const STAGE_COLORS: Record<AutonomyStage, string> = {
	resolve:   'var(--vscode-focusBorder,#6496fa)',
	translate: '#e0a84e',
	validate:  '#26c6a6',
	commit:    'var(--vscode-terminal-ansiGreen,#4caf50)',
};

// ─── Autonomy section (Phase 12) ──────────────────────────────────────────────

function _buildAutonomySection(
	autonomy:  IAutonomyService,
	onRefresh: () => void,
): HTMLElement {
	const state     = autonomy.batchState;
	const metrics   = autonomy.lastBatchMetrics;
	const escalated = autonomy.escalatedUnits;
	const history   = autonomy.getRunHistory().slice(0, 5);

	const wrap = $card();

	// ── Header ──────────────────────────────────────────────────────────────

	const stateColor = _autonomyBatchStateColor(state);
	const stateLabel = _autonomyBatchStateLabel(state);

	const hdrRight = $e('div', 'display:flex;align-items:center;gap:6px;');

	// BatchState chip
	const stateDot  = $e('span', `display:inline-block;width:7px;height:7px;border-radius:50%;background:${stateColor};flex-shrink:0;${state === 'running' ? 'animation:pulse 1.4s ease-in-out infinite;' : ''}`);
	const stateChip = $e('span', `display:inline-flex;align-items:center;gap:4px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:${stateColor};padding:2px 7px;border-radius:10px;background:${stateColor}18;border:1px solid ${stateColor}44;`);
	stateChip.appendChild(stateDot);
	stateChip.appendChild(document.createTextNode(stateLabel));
	hdrRight.appendChild(stateChip);

	// Run ID chip (when active or paused)
	if (autonomy.currentRunId) {
		hdrRight.appendChild($t('span', autonomy.currentRunId.slice(-10),
			'font-size:9px;color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family,monospace);padding:2px 6px;border-radius:3px;background:var(--vscode-widget-border);'));
	}

	// Live throughput (when running)
	if (metrics && metrics.unitsPerMinute > 0) {
		hdrRight.appendChild($t('span', `${metrics.unitsPerMinute} u/min`,
			'font-size:9px;color:var(--vscode-descriptionForeground);'));
	}

	wrap.appendChild($sectionHeader('Autonomous Migration  \u00b7  Phase 12', hdrRight));

	const body = $e('div', 'padding:12px;display:flex;flex-direction:column;gap:12px;background:var(--vscode-input-background);');

	// ── Outcome metrics ──────────────────────────────────────────────────────

	if (metrics) {
		// 4 outcome tiles
		const tileRow = $e('div', 'display:grid;grid-template-columns:repeat(4,1fr);gap:6px;');
		const tile = (label: string, value: number, color: string, sub?: string) => {
			const el = $e('div', 'background:var(--vscode-editor-background);border:1px solid var(--vscode-widget-border);border-radius:4px;padding:7px 8px;text-align:center;');
			el.appendChild($t('div', String(value), `font-size:20px;font-weight:700;color:${color};line-height:1;`));
			el.appendChild($t('div', label, 'font-size:9px;color:var(--vscode-descriptionForeground);text-transform:uppercase;letter-spacing:0.05em;margin-top:2px;'));
			if (sub) { el.appendChild($t('div', sub, `font-size:9px;color:${color}99;margin-top:1px;`)); }
			return el;
		};
		const advPct = pct(metrics.advanced, metrics.totalProcessed);
		tileRow.appendChild(tile('Advanced',  metrics.advanced,  'var(--vscode-terminal-ansiGreen,#4caf50)',   metrics.totalProcessed > 0 ? `${advPct}%` : undefined));
		tileRow.appendChild(tile('Escalated', metrics.escalated, '#e0a84e'));
		tileRow.appendChild(tile('Errors',    metrics.errors,    'var(--vscode-inputValidation-errorBorder,#f44336)'));
		tileRow.appendChild(tile('Skipped',   metrics.skipped,   'var(--vscode-descriptionForeground,#888)'));
		body.appendChild(tileRow);

		// Progress bar: advanced / totalProcessed
		if (metrics.totalProcessed > 0) {
			const barRow = $e('div', 'display:flex;align-items:center;gap:8px;');
			barRow.appendChild($t('span', 'Processed:', 'font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;'));
			const barWrap = $e('div', 'flex:1;');
			barWrap.appendChild($progressBar(
				pct(metrics.advanced, metrics.totalProcessed),
				'var(--vscode-terminal-ansiGreen,#4caf50)',
				6,
			));
			barRow.appendChild(barWrap);
			barRow.appendChild($t('span', `${metrics.advanced}/${metrics.totalProcessed}`,
				'font-size:10px;color:var(--vscode-descriptionForeground);white-space:nowrap;'));
			body.appendChild(barRow);
		}

		// Stage grid: stage | bar | count | avg | max
		const hasStageData = ALL_AUTONOMY_STAGES.some(s => metrics.byStage[s] > 0);
		if (hasStageData) {
			const stageSection = $e('div', 'border-top:1px solid var(--vscode-widget-border);padding-top:8px;');
			stageSection.appendChild($t('div', 'Stage completions',
				'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);margin-bottom:6px;'));

			const grid = $e('div', 'display:grid;grid-template-columns:auto 1fr auto auto auto;gap:4px 10px;align-items:center;');
			for (const h of ['Stage', '', 'Count', 'Avg', 'Max']) {
				grid.appendChild($t('span', h,
					'font-size:9px;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);font-weight:700;'));
			}
			const maxStageCount = Math.max(1, ...ALL_AUTONOMY_STAGES.map(s => metrics.byStage[s]));
			for (const stage of ALL_AUTONOMY_STAGES) {
				const count  = metrics.byStage[stage];
				const timing = metrics.stageTiming[stage];
				const color  = STAGE_COLORS[stage];
				grid.appendChild($t('span', stage, `font-size:11px;font-weight:600;color:${color};`));
				const barCell = $e('div', '');
				if (count > 0) { barCell.appendChild($progressBar(pct(count, maxStageCount), color, 4)); }
				grid.appendChild(barCell);
				grid.appendChild($t('span', count > 0 ? String(count) : '—',
					'font-size:11px;text-align:right;color:var(--vscode-foreground);'));
				grid.appendChild($t('span', count > 0 ? `${(timing.avgMs / 1000).toFixed(1)}s` : '—',
					'font-size:11px;text-align:right;color:var(--vscode-descriptionForeground);'));
				grid.appendChild($t('span', count > 0 ? `${(timing.maxMs / 1000).toFixed(1)}s` : '—',
					'font-size:11px;text-align:right;color:var(--vscode-descriptionForeground);'));
			}
			stageSection.appendChild(grid);
			body.appendChild(stageSection);
		}

		// Info row: duration · throughput · ETA · aborted flag
		const infoRow = $e('div', 'display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:var(--vscode-descriptionForeground);border-top:1px solid var(--vscode-widget-border);padding-top:8px;');
		infoRow.appendChild($t('span', `Duration: ${(metrics.durationMs / 1000).toFixed(1)}s`, ''));
		if (metrics.unitsPerMinute > 0) {
			infoRow.appendChild($t('span', `Throughput: ${metrics.unitsPerMinute} u/min`, ''));
		}
		if (metrics.estimatedRemainingMs != null) {
			const s   = Math.round(metrics.estimatedRemainingMs / 1000);
			const eta = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
			infoRow.appendChild($t('span', `ETA: ${eta}`, 'color:#e0a84e;'));
		}
		if (metrics.wasAborted) {
			infoRow.appendChild($t('span', 'Run was aborted',
				'color:var(--vscode-inputValidation-errorBorder,#f44336);'));
		}
		body.appendChild(infoRow);
	}

	// ── Batch options ────────────────────────────────────────────────────────

	{
		const optCard = $e('div',
			'border:1px solid var(--vscode-widget-border);border-radius:4px;padding:10px;display:flex;flex-direction:column;gap:8px;');
		optCard.appendChild($t('div', 'Batch Options',
			'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);'));

		// Concurrency + Auto-approve row
		const row1 = $e('div', 'display:flex;align-items:center;gap:20px;flex-wrap:wrap;');

		const concRow = $e('div', 'display:flex;align-items:center;gap:6px;');
		concRow.appendChild($t('span', 'Concurrency:', 'font-size:11px;color:var(--vscode-foreground);white-space:nowrap;'));
		const concInput = $input('3', String(_autonomyOpts.maxConcurrency), 'width:44px;text-align:center;padding:2px 6px;');
		(concInput as HTMLInputElement).type = 'number';
		(concInput as HTMLInputElement).min  = '1';
		(concInput as HTMLInputElement).max  = '10';
		concInput.addEventListener('change', () => {
			const v = parseInt((concInput as HTMLInputElement).value, 10);
			if (!isNaN(v) && v >= 1 && v <= 10) { _autonomyOpts.maxConcurrency = v; }
		});
		concRow.appendChild(concInput);
		row1.appendChild(concRow);

		const autoRow = $e('div', 'display:flex;align-items:center;gap:6px;cursor:pointer;');
		const autoChk = document.createElement('input');
		autoChk.type    = 'checkbox';
		autoChk.checked = _autonomyOpts.autoApprove;
		autoChk.style.cursor = 'pointer';
		autoChk.addEventListener('change', () => { _autonomyOpts.autoApprove = autoChk.checked; });
		const autoLbl = $t('span', 'Auto-approve low/medium risk', 'font-size:11px;color:var(--vscode-foreground);cursor:pointer;');
		autoLbl.addEventListener('click', () => { autoChk.checked = !autoChk.checked; _autonomyOpts.autoApprove = autoChk.checked; });
		autoRow.appendChild(autoChk);
		autoRow.appendChild(autoLbl);
		row1.appendChild(autoRow);
		optCard.appendChild(row1);

		// Stages row
		const stageRow = $e('div', 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;');
		stageRow.appendChild($t('span', 'Stages:', 'font-size:11px;color:var(--vscode-foreground);'));
		const STAGE_LABELS: Record<AutonomyStage, string> = {
			resolve: 'Resolve', translate: 'Translate', validate: 'Validate', commit: 'Commit',
		};
		for (const stage of ALL_AUTONOMY_STAGES) {
			const chk = document.createElement('input');
			chk.type    = 'checkbox';
			chk.checked = _autonomyOpts.stages.includes(stage);
			chk.style.cursor = 'pointer';
			chk.addEventListener('change', () => {
				if (chk.checked) {
					if (!_autonomyOpts.stages.includes(stage)) { _autonomyOpts.stages.push(stage); }
				} else {
					_autonomyOpts.stages = _autonomyOpts.stages.filter(s => s !== stage);
				}
			});
			const lbl = document.createElement('label');
			lbl.style.cssText = 'display:flex;align-items:center;gap:3px;font-size:11px;color:var(--vscode-foreground);cursor:pointer;';
			lbl.appendChild(chk);
			lbl.appendChild(document.createTextNode(STAGE_LABELS[stage]));
			stageRow.appendChild(lbl);
		}
		optCard.appendChild(stageRow);
		body.appendChild(optCard);
	}

	// ── Escalation queue ─────────────────────────────────────────────────────

	if (escalated.length > 0) {
		const escSection = $e('div', 'border-top:1px solid var(--vscode-widget-border);padding-top:8px;display:flex;flex-direction:column;gap:6px;');

		const escHdr = $e('div', 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;');
		escHdr.appendChild($t('span', 'Escalations', 'font-size:11px;font-weight:700;color:var(--vscode-foreground);'));
		escHdr.appendChild($t('span', String(escalated.length),
			'font-size:9px;font-weight:700;padding:1px 6px;border-radius:10px;background:#e0a84e22;color:#e0a84e;border:1px solid #e0a84e44;'));
		escHdr.appendChild($t('span', 'Resolve each unit before the pipeline can continue.',
			'font-size:10px;color:var(--vscode-descriptionForeground);'));
		escSection.appendChild(escHdr);

		const escList = $e('div', 'display:flex;flex-direction:column;gap:6px;max-height:360px;overflow-y:auto;');

		for (const unit of escalated) {
			const card = $e('div',
				'border:1px solid var(--vscode-widget-border);border-radius:4px;padding:8px 10px;display:flex;flex-direction:column;gap:6px;background:var(--vscode-editor-background);');

			// Info row: name + badges + time
			const infoRow = $e('div', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;');
			infoRow.appendChild($t('span', unit.unitName,
				'font-size:12px;font-weight:600;color:var(--vscode-foreground);'));

			// Risk badge
			const riskColor = unit.riskLevel === 'critical' ? '#f44336'
				: unit.riskLevel === 'high'   ? '#e0a84e'
				: unit.riskLevel === 'medium' ? '#64b5f6' : '#81c784';
			infoRow.appendChild($t('span', unit.riskLevel,
				`font-size:9px;font-weight:700;padding:2px 6px;border-radius:10px;background:${riskColor}22;color:${riskColor};border:1px solid ${riskColor}44;text-transform:uppercase;letter-spacing:0.04em;`));

			if (unit.domain) {
				infoRow.appendChild($t('span', unit.domain,
					'font-size:9px;padding:2px 6px;border-radius:10px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);'));
			}
			if (unit.stage) {
				infoRow.appendChild($t('span', unit.stage,
					'font-size:9px;padding:2px 6px;border-radius:3px;background:var(--vscode-widget-border);color:var(--vscode-descriptionForeground);font-family:var(--vscode-editor-font-family,monospace);'));
			}
			infoRow.appendChild($t('span', relativeTime(unit.escalatedAt),
				'font-size:9px;color:var(--vscode-descriptionForeground);margin-left:auto;white-space:nowrap;'));
			card.appendChild(infoRow);

			// Reason
			if (unit.reason) {
				card.appendChild($t('div', unit.reason,
					'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;padding-left:2px;'));
			}

			// Action buttons
			const actionRow = $e('div', 'display:flex;gap:6px;flex-wrap:wrap;');

			// Approve (requires reason)
			actionRow.appendChild($btn('Approve', true, () => {
				const reason = window.prompt(`Approval reason for \u201c${unit.unitName}\u201d (required):`);
				if (reason === null) { return; }
				if (!reason.trim()) { window.alert('A documented reason is required for approval.'); return; }
				autonomy.resolveEscalation(unit.unitId, 'approve', 'user', reason.trim())
					.then(() => onRefresh()).catch((e: unknown) => window.alert(String(e)));
			}, 'background:rgba(76,175,80,0.12);color:var(--vscode-terminal-ansiGreen,#4caf50);border:1px solid rgba(76,175,80,0.35);'));

			// Skip (reason optional)
			actionRow.appendChild($btn('Skip', false, () => {
				const reason = window.prompt(`Reason for skipping \u201c${unit.unitName}\u201d (optional):`);
				if (reason === null) { return; }
				autonomy.resolveEscalation(unit.unitId, 'skip', 'user', reason.trim() || undefined)
					.then(() => onRefresh()).catch((e: unknown) => window.alert(String(e)));
			}));

			// Revert to pending (confirm only)
			actionRow.appendChild($btn('Revert to Pending', false, () => {
				if (!window.confirm(`Revert \u201c${unit.unitName}\u201d to pending?\nThis clears all translation artefacts and queues the unit for a fresh attempt.`)) { return; }
				autonomy.resolveEscalation(unit.unitId, 'revert-to-pending', 'user')
					.then(() => onRefresh()).catch((e: unknown) => window.alert(String(e)));
			}));

			// Block (requires reason)
			actionRow.appendChild($btn('Block', false, () => {
				const reason = window.prompt(`Block reason for \u201c${unit.unitName}\u201d (required):`);
				if (reason === null) { return; }
				if (!reason.trim()) { window.alert('A documented reason is required to block a unit.'); return; }
				autonomy.resolveEscalation(unit.unitId, 'block', 'user', reason.trim())
					.then(() => onRefresh()).catch((e: unknown) => window.alert(String(e)));
			}, 'background:rgba(244,67,54,0.1);color:var(--vscode-inputValidation-errorBorder,#f44336);border:1px solid rgba(244,67,54,0.3);'));

			card.appendChild(actionRow);
			escList.appendChild(card);
		}
		escSection.appendChild(escList);
		body.appendChild(escSection);
	}

	// ── Run history ──────────────────────────────────────────────────────────

	if (history.length > 0) {
		const histSection = $e('div',
			'border-top:1px solid var(--vscode-widget-border);padding-top:8px;display:flex;flex-direction:column;gap:6px;');
		histSection.appendChild($t('div', 'Recent Runs',
			'font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);'));

		const histGrid = $e('div',
			'display:grid;grid-template-columns:1fr auto auto auto;gap:4px 12px;align-items:center;');
		for (const h of ['Run ID', 'When', 'State', 'Result']) {
			histGrid.appendChild($t('span', h,
				'font-size:9px;text-transform:uppercase;letter-spacing:0.05em;color:var(--vscode-descriptionForeground);font-weight:700;'));
		}
		for (const run of history) {
			const runStateColor = _autonomyBatchStateColor(run.state);
			histGrid.appendChild($t('span', run.runId.slice(-12),
				'font-size:10px;font-family:var(--vscode-editor-font-family,monospace);color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'));
			histGrid.appendChild($t('span', relativeTime(run.startedAt),
				'font-size:11px;color:var(--vscode-descriptionForeground);white-space:nowrap;'));
			histGrid.appendChild($t('span', run.state,
				`font-size:11px;color:${runStateColor};white-space:nowrap;`));
			histGrid.appendChild($t('span',
				`${run.metrics.advanced}/${run.metrics.totalProcessed}`,
				'font-size:11px;text-align:right;color:var(--vscode-foreground);white-space:nowrap;'));
		}
		histSection.appendChild(histGrid);
		body.appendChild(histSection);
	}

	// ── Controls ─────────────────────────────────────────────────────────────

	{
		const ctrlRow = $e('div',
			'display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid var(--vscode-widget-border);padding-top:10px;');

		const batchOpts = (): IAutonomyOptions => ({
			maxConcurrency: _autonomyOpts.maxConcurrency,
			autoApprove:    _autonomyOpts.autoApprove,
			stages:         [..._autonomyOpts.stages],
		});

		// Start (idle / completed / error)
		if (state === 'idle' || state === 'completed' || state === 'error') {
			ctrlRow.appendChild($btn('\u25b6 Start Batch', true, () => {
				autonomy.startBatch(batchOpts())
					.then(() => onRefresh())
					.catch((e: unknown) => { window.alert(`Batch error: ${e}`); onRefresh(); });
				onRefresh(); // optimistic: show Running immediately
			}));
		}

		// Resume (paused only)
		if (state === 'paused') {
			ctrlRow.appendChild($btn('\u21ba Resume', true, () => {
				autonomy.resumeBatch()
					.then(() => onRefresh())
					.catch((e: unknown) => { window.alert(`Resume error: ${e}`); onRefresh(); });
				onRefresh();
			}, 'background:rgba(100,150,250,0.15);border-color:var(--vscode-focusBorder,#6496fa);'));
		}

		// Pause (running only — not while already pausing/stopping)
		if (state === 'running') {
			ctrlRow.appendChild($btn('\u23f8 Pause', false, () => {
				autonomy.pauseBatch(); onRefresh();
			}));
		}

		// Stop (running or pausing — drain and abort)
		if (state === 'running' || state === 'pausing') {
			ctrlRow.appendChild($btn('\u23f9 Stop', false, () => {
				autonomy.stopBatch(); onRefresh();
			}, 'background:rgba(244,67,54,0.1);color:var(--vscode-inputValidation-errorBorder,#f44336);border:1px solid rgba(244,67,54,0.3);'));
		}

		// Preview schedule (always available)
		ctrlRow.appendChild($btn('Preview Schedule', false, () => {
			const preview = autonomy.previewSchedule(batchOpts());
			const lines = [
				`Total eligible units: ${preview.totalUnits}`,
				'',
				'By stage:',
				...ALL_AUTONOMY_STAGES.map(s => `  ${s}: ${preview.byStage[s]}`),
				'',
				'Depth groups:',
				...preview.depthGroups.map(g => `  Depth ${g.depth}: ${g.unitCount} unit(s)`),
			];
			window.alert(lines.join('\n'));
		}));

		// Clear escalations bulk action
		if (escalated.length > 0) {
			ctrlRow.appendChild($btn('Clear Escalations', false, () => {
				if (window.confirm('Remove all escalations from the queue?\nUnits will remain at their current KB status — no transitions applied.')) {
					autonomy.clearEscalations(); onRefresh();
				}
			}));
		}

		body.appendChild(ctrlRow);
	}

	wrap.appendChild(body);
	return wrap;
}


// ─── BatchState display helpers ───────────────────────────────────────────────

function _autonomyBatchStateColor(state: BatchState): string {
	switch (state) {
		case 'running':   return 'var(--vscode-terminal-ansiGreen,#4caf50)';
		case 'pausing':   return '#e0a84e';
		case 'paused':    return 'var(--vscode-focusBorder,#6496fa)';
		case 'stopping':  return '#e0a84e';
		case 'completed': return 'var(--vscode-terminal-ansiGreen,#4caf50)';
		case 'error':     return 'var(--vscode-inputValidation-errorBorder,#f44336)';
		default:          return 'var(--vscode-descriptionForeground,#888)';
	}
}

function _autonomyBatchStateLabel(state: BatchState): string {
	switch (state) {
		case 'idle':      return 'Idle';
		case 'running':   return 'Running';
		case 'pausing':   return 'Pausing\u2026';
		case 'paused':    return 'Paused';
		case 'stopping':  return 'Stopping\u2026';
		case 'completed': return 'Completed';
		case 'error':     return 'Error';
	}
}
