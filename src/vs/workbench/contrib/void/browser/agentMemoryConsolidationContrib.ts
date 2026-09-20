/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * B1 automatic memory capture/consolidation (task 2026-09-15 §B1)
 *
 * The ledger's frozen episodes are the richest structured record of DURABLE
 * user preferences and decisions in the product: `invariants` are permanent
 * user rules, `corrections[].ruleDerived` are rules the user corrected us on,
 * and `decisions[].what` are stable decisions with their why. Nothing consumed
 * them — they lived and died with the working brief.
 *
 * This contribution consolidates exactly those three fields into the agent
 * memory service when an episode freezes:
 *  - provenance is preserved as tags (ledger, thread, episode ordinal) + the
 *    service's own createdAt timestamp;
 *  - dedup/replacement goes through `upsertByKey` keyed on a normalized hash
 *    of the rule text — a rule re-recorded in a later episode REPLACES the
 *    old entry instead of duplicating (an edit takes the old truth's place);
 *  - raw journal text, tool output and file contents are NEVER captured — only
 *    the structured preference fields above;
 *  - secret-shaped strings are refused (never become durable memory);
 *  - the capture path is gated on `autoMemoryCaptureEnabled` (toggleable from
 *    the memory manager command).
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IAgentMemoryService } from './agentMemoryService.js';
import { IContextLedgerService } from './contextLedgerService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';
import type { IEpisodeSummary } from '../common/ledgerTypes.js';

/** Lightweight secret detector for the capture gate — deliberately coarse:
 *  false positives only cost us a skipped memory, false negatives are worse. */
export function looksLikeSecret(text: string): boolean {
	return /(\bsk-[a-z0-9_-]{16,}\b|\bapi[_-]?key\b|\baccess[_-]?token\b|\bsecret\b\s*[:=]|\bpassword\b\s*[:=]|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|\bgh[pousr]_[a-z0-9]{30,})/i.test(text);
}

/** Stable, human-inspectable dedup key for a captured rule. */
export function memoryKeyOf(rule: string): string {
	const normalized = rule.trim().toLowerCase().replace(/\s+/g, ' ');
	let hash = 0x811c9dc5;
	for (let i = 0; i < normalized.length; i++) {
		hash ^= normalized.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return `ledger:${(hash >>> 0).toString(36)}`;
}

/** Pure extraction: which (type, rule) pairs does this episode contribute?
 *  Only structured user-level fields — never raw transcript/tool content. */
export function extractDurableMemories(ep: IEpisodeSummary): Array<{ type: 'preference' | 'project-fact'; rule: string }> {
	const out: Array<{ type: 'preference' | 'project-fact'; rule: string }> = [];
	for (const invariant of ep.body.invariants) {
		const rule = invariant.trim();
		if (rule.length >= 4 && !looksLikeSecret(rule)) { out.push({ type: 'preference', rule }); }
	}
	for (const correction of ep.body.corrections) {
		const rule = (correction.ruleDerived ?? correction.userSaid).trim();
		if (rule.length >= 4 && !looksLikeSecret(rule)) { out.push({ type: 'preference', rule }); }
	}
	for (const decision of ep.body.decisions) {
		const rule = decision.what.trim();
		if (rule.length >= 4 && !looksLikeSecret(rule)) { out.push({ type: 'project-fact', rule }); }
	}
	return out;
}

class AgentMemoryConsolidationContribution extends Disposable {

	constructor(
		@IAgentMemoryService memoryService: IAgentMemoryService,
		@IContextLedgerService ledgerService: IContextLedgerService,
		@IVoidSettingsService settingsService: IVoidSettingsService,
	) {
		super();

		this._register(ledgerService.onDidFreezeEpisode(({ threadId, episode }) => {
			try {
				if (!settingsService.state.globalSettings.autoMemoryCaptureEnabled) { return; }
				consolidateEpisode(memoryService, threadId, episode);
			} catch { /* capture is best-effort — never disturb the episode freeze */ }
		}));
	}
}

/** Exported for tests: the exact consolidation the event feed performs.
 *  Replacing keeps the FIRST-seen provenance tags (when the rule was learned),
 *  which is the honest provenance for a durable preference. */
export function consolidateEpisode(memoryService: IAgentMemoryService, threadId: string, episode: IEpisodeSummary): number {
	let stored = 0;
	const provenance = ['ledger', `thread:${threadId.slice(0, 8)}`, `ep:${episode.ordinal}`];
	for (const { type, rule } of extractDurableMemories(episode)) {
		const key = memoryKeyOf(rule);
		const existing = memoryService.findByTag(key);
		if (existing) {
			memoryService.forget(existing.id);
			memoryService.remember(type, rule, existing.tags, 'auto');
		} else {
			memoryService.remember(type, rule, [key, ...provenance], 'auto');
		}
		stored++;
	}
	return stored;
}

registerWorkbenchContribution2('agentMemoryConsolidationContrib', AgentMemoryConsolidationContribution, WorkbenchPhase.Eventually);

export { AgentMemoryConsolidationContribution };
