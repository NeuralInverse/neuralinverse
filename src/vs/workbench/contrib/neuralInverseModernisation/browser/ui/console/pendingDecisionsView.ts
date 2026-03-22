/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pending Decisions View — Tab 2 of the Modernisation Console.
 *
 * Shows every unanswered IPendingDecision sorted by priority (blocking first).
 * Each card has:
 *  - Priority badge (blocking | high | medium | low) with colour coding
 *  - Decision type badge (approval | type-mapping | naming | rule-interpretation | exclusion)
 *  - Unit name + current status
 *  - Full question text
 *  - Context (collapsible if > 200 chars)
 *  - Suggested options as clickable chips (if decision.options is set)
 *  - Inline answer form: textarea pre-populated from selected option
 *  - Submit button → calls tools.answerDecision()
 *  - Per-decision hint explaining the expected answer format for the decision type
 */

import { IKnowledgeBaseService } from '../../knowledgeBase/service.js';
import { IModernisationAgentToolService } from '../../engine/agentTools/service.js';
import { IPendingDecision } from '../../../common/knowledgeBaseTypes.js';
import {
	$e, $t, $btn, $textarea, $sectionHeader, $emptyState,
	$statusBadge, $priorityBadge, $typeBadge,
	truncate, relativeTime,
} from './consoleHelpers.js';

// ─── Priority sort order ──────────────────────────────────────────────────────

const PRIORITY_ORDER = ['blocking', 'high', 'medium', 'low'];

function priorityRank(p: string): number {
	return PRIORITY_ORDER.indexOf(p) >= 0 ? PRIORITY_ORDER.indexOf(p) : 99;
}

// ─── Answer hint by decision type ────────────────────────────────────────────

const ANSWER_HINTS: Record<string, string> = {
	'type-mapping':        'Enter the target type name (e.g. "LocalDate" for a COBOL date field, or "BigDecimal" for COMP-3 PIC 9).',
	'naming':              'Enter the target identifier name (e.g. "customerBillingAddress" for CUST-BILL-ADDR).',
	'rule-interpretation': 'Describe what this business rule means in the target domain context.',
	'approval':            'Type your approval decision or explanation.',
	'exclusion':           'Enter the file pattern or unit name to exclude (e.g. "*.dat" or "INIT-ROUTINE").',
	'pattern-override':    'Enter the override value for this pattern.',
};


// ─── Build ────────────────────────────────────────────────────────────────────

export function buildPendingDecisionsView(
	kb:        IKnowledgeBaseService,
	tools:     IModernisationAgentToolService,
	onRefresh: () => void,
): HTMLElement {
	const root = $e('div', 'display:flex;flex-direction:column;height:100%;overflow:hidden;');

	if (!kb.isActive) {
		root.appendChild($emptyState(
			'\u{1F914}', 'Knowledge base not active', 'Initialise a session to see decisions here.',
		));
		return root;
	}

	const decisions = kb.getPendingDecisions()
		.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));

	// Header with count
	const countBadge = $t('span', String(decisions.length), [
		'font-size:10px', 'font-weight:700',
		'background:var(--vscode-badge-background)',
		'color:var(--vscode-badge-foreground)',
		'border-radius:8px', 'padding:1px 7px', 'min-width:20px', 'text-align:center',
	].join(';'));
	root.appendChild($sectionHeader('Pending Decisions', countBadge));

	if (decisions.length === 0) {
		root.appendChild($emptyState(
			'\u2713',
			'All clear — no pending decisions',
			'Every blocked unit has been unblocked. The AI agent can proceed with translation.',
		));
		return root;
	}

	// Decision cards
	const list = $e('div', 'flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px;');

	for (const decision of decisions) {
		const unit = kb.getUnit(decision.unitId);
		list.appendChild(_buildDecisionCard(decision, unit?.name, unit?.status, tools, onRefresh));
	}

	root.appendChild(list);
	return root;
}


// ─── Decision card ────────────────────────────────────────────────────────────

function _buildDecisionCard(
	decision:   IPendingDecision,
	unitName:   string | undefined,
	unitStatus: string | undefined,
	tools:      IModernisationAgentToolService,
	onRefresh:  () => void,
): HTMLElement {
	const card = $e('div', [
		'border:1px solid var(--vscode-widget-border)',
		'border-radius:6px', 'overflow:hidden',
		decision.priority === 'blocking'
			? 'border-left:3px solid var(--vscode-inputValidation-errorBorder,#f44336);'
			: decision.priority === 'high'
				? 'border-left:3px solid #e0a84e;'
				: '',
	].join(';'));

	// ── Card header ───────────────────────────────────────────────────────
	const hdr = $e('div', [
		'display:flex', 'align-items:center', 'flex-wrap:wrap', 'gap:6px',
		'padding:8px 12px',
		'background:var(--vscode-sideBarSectionHeader-background)',
		'border-bottom:1px solid var(--vscode-widget-border)',
	].join(';'));

	hdr.appendChild($priorityBadge(decision.priority));
	hdr.appendChild($typeBadge(decision.type));

	// Unit name
	if (unitName) {
		const unitEl = $e('div', 'display:flex;align-items:center;gap:5px;flex:1;min-width:0;overflow:hidden;');
		unitEl.appendChild($t('span', unitName, [
			'font-size:11px', 'font-weight:600', 'color:var(--vscode-editor-foreground)',
			'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
		].join(';')));
		if (unitStatus) {
			unitEl.appendChild($statusBadge(unitStatus as import('../../../common/knowledgeBaseTypes.js').UnitStatus));
		}
		hdr.appendChild(unitEl);
	} else {
		hdr.appendChild($e('div', 'flex:1;'));
	}

	// Raised time
	if (decision.raisedAt) {
		hdr.appendChild($t('span', relativeTime(decision.raisedAt), [
			'font-size:10px', 'color:var(--vscode-descriptionForeground)', 'white-space:nowrap',
		].join(';')));
	}

	card.appendChild(hdr);

	// ── Card body ─────────────────────────────────────────────────────────
	const body = $e('div', 'padding:12px;display:flex;flex-direction:column;gap:8px;background:var(--vscode-input-background);');

	// Decision ID (small, monospace)
	body.appendChild($t('div', `Decision ID: ${decision.id}`, [
		'font-size:9px', 'font-family:var(--vscode-editor-font-family,monospace)',
		'color:var(--vscode-descriptionForeground)', 'opacity:0.6',
	].join(';')));

	// Question
	const qWrap = $e('div', '');
	qWrap.appendChild($t('div', 'Question',
		'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-descriptionForeground);margin-bottom:4px;'));
	qWrap.appendChild($t('div', decision.question, [
		'font-size:12px', 'color:var(--vscode-editor-foreground)', 'line-height:1.6',
	].join(';')));
	body.appendChild(qWrap);

	// Context (collapsible if long)
	if (decision.context) {
		const ctxWrap = $e('div', '');
		ctxWrap.appendChild($t('div', 'Context',
			'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-descriptionForeground);margin-bottom:4px;'));

		const isLong = decision.context.length > 220;
		const ctxText = $t('div',
			isLong ? truncate(decision.context, 220) : decision.context,
			'font-size:11px;color:var(--vscode-descriptionForeground);line-height:1.5;white-space:pre-wrap;',
		);
		ctxWrap.appendChild(ctxText);

		if (isLong) {
			let expanded = false;
			const toggleBtn = $t('span', 'Show more\u2026',
				'font-size:10px;color:var(--vscode-textLink-foreground,#6496fa);cursor:pointer;margin-top:2px;display:inline-block;');
			toggleBtn.addEventListener('click', () => {
				expanded = !expanded;
				ctxText.textContent = expanded ? decision.context : truncate(decision.context, 220);
				toggleBtn.textContent = expanded ? 'Show less' : 'Show more\u2026';
			});
			ctxWrap.appendChild(toggleBtn);
		}
		body.appendChild(ctxWrap);
	}

	// Options as clickable chips
	let selectedOption = '';
	if (decision.options && decision.options.length > 0) {
		const optWrap = $e('div', '');
		optWrap.appendChild($t('div', 'Suggested Options',
			'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-descriptionForeground);margin-bottom:6px;'));
		const chips = $e('div', 'display:flex;flex-wrap:wrap;gap:6px;');

		for (const opt of decision.options) {
			const chip = $t('span', opt, [
				'font-size:11px', 'padding:4px 10px', 'border-radius:12px', 'cursor:pointer',
				'border:1px solid var(--vscode-widget-border)',
				'background:var(--vscode-editor-background)',
				'color:var(--vscode-editor-foreground)',
				'user-select:none',
			].join(';'));
			chip.addEventListener('click', () => {
				selectedOption = opt;
				answerArea.value = opt;
				// Update chip styles
				for (const c of chips.children) {
					(c as HTMLElement).style.background = 'var(--vscode-editor-background)';
					(c as HTMLElement).style.borderColor = 'var(--vscode-widget-border)';
					(c as HTMLElement).style.color = 'var(--vscode-editor-foreground)';
				}
				chip.style.background = 'var(--vscode-button-background)';
				chip.style.borderColor = 'var(--vscode-button-background)';
				chip.style.color       = 'var(--vscode-button-foreground)';
			});
			chip.addEventListener('mouseenter', () => {
				if (chip.style.background !== 'var(--vscode-button-background)') {
					chip.style.background = 'var(--vscode-list-hoverBackground)';
				}
			});
			chip.addEventListener('mouseleave', () => {
				if (chip.style.background !== 'var(--vscode-button-background)') {
					chip.style.background = 'var(--vscode-editor-background)';
				}
			});
			chips.appendChild(chip);
		}
		optWrap.appendChild(chips);
		body.appendChild(optWrap);
	}

	// Answer form
	const answerWrap = $e('div', '');
	answerWrap.appendChild($t('div', 'Your Answer',
		'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--vscode-descriptionForeground);margin-bottom:4px;'));

	const hint = ANSWER_HINTS[decision.type];
	if (hint) {
		answerWrap.appendChild($t('div', hint, [
			'font-size:10px', 'color:var(--vscode-descriptionForeground)',
			'font-style:italic', 'margin-bottom:5px', 'line-height:1.4',
		].join(';')));
	}

	const answerArea = $textarea(
		'Type your answer here\u2026',
		decision.type === 'rule-interpretation' ? 4 : 2,
	);
	if (selectedOption) { answerArea.value = selectedOption; }
	answerWrap.appendChild(answerArea);
	body.appendChild(answerWrap);

	// Submit row
	const submitRow = $e('div', 'display:flex;align-items:center;gap:10px;margin-top:4px;');
	const errorMsg  = $e('div', 'flex:1;font-size:10px;color:var(--vscode-inputValidation-errorBorder,#f44336);');
	const successMsg = $e('div', 'flex:1;font-size:10px;color:var(--vscode-terminal-ansiGreen,#4caf50);');

	const submitBtn = $btn('Answer Decision', true, async () => {
		const answer = answerArea.value.trim();
		if (!answer) {
			errorMsg.textContent = 'Please enter an answer.';
			successMsg.textContent = '';
			return;
		}
		(submitBtn as HTMLButtonElement).disabled = true;
		submitBtn.textContent = 'Submitting\u2026';
		errorMsg.textContent  = '';

		try {
			const result = tools.answerDecision({
				decisionId: decision.id,
				answer,
				actor: 'human',
			});
			if (result.success) {
				successMsg.textContent = `\u2713 Decision answered. Unit ${result.data?.unitUnblocked ? 'unblocked' : 'updated'}.`;
				// Collapse answer form
				answerArea.disabled = true;
				(submitBtn as HTMLButtonElement).disabled = true;
				submitBtn.textContent = 'Answered';
				submitBtn.style.opacity = '0.5';
				submitBtn.style.cursor  = 'not-allowed';
				// Refresh after short delay so user sees the success state
				setTimeout(onRefresh, 800);
			} else {
				errorMsg.textContent = result.error ?? 'Failed to answer decision.';
				(submitBtn as HTMLButtonElement).disabled = false;
				submitBtn.textContent = 'Answer Decision';
			}
		} catch (err) {
			errorMsg.textContent = err instanceof Error ? err.message : String(err);
			(submitBtn as HTMLButtonElement).disabled = false;
			submitBtn.textContent = 'Answer Decision';
		}
	}, 'font-size:12px;padding:5px 16px;');

	submitRow.appendChild(submitBtn);
	submitRow.appendChild(errorMsg);
	submitRow.appendChild(successMsg);
	body.appendChild(submitRow);

	card.appendChild(body);
	return card;
}
