/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ledger recall tools (task M5 phase 3, layer L3)
 *
 * Registers the two internal tools that make "nothing is ever deleted" a
 * capability instead of a slogan:
 *
 *   recall_history({ query, scope?, limit? }) — ranked search over the
 *     journal + episode indexes (BM25-style term matching; embeddings when a
 *     provider is configured).
 *   expand_history({ fromSeq, toSeq })       — the exact original messages
 *     from the append-only journal, middle-truncated to the recall budget.
 *
 * Both resolve the current thread from ChatThreadService so the model can
 * simply call them without thread plumbing. Registered only when the
 * contextLedgerEnabled flag is on (they read exclusively from the ledger).
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoidInternalToolService } from './voidInternalToolService.js';
import { IContextLedgerService } from './contextLedgerService.js';
import { ILedgerRecallService } from '../../neuralInverse/browser/context/search/ledgerRecallService.js';
import { IChatThreadService } from './chatThreadServiceInterface.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';

class LedgerRecallContribution extends Disposable {

	constructor(
		@IVoidInternalToolService internalToolService: IVoidInternalToolService,
		@IContextLedgerService ledgerService: IContextLedgerService,
		@ILedgerRecallService recallService: ILedgerRecallService,
		@IChatThreadService chatThreadService: IChatThreadService,
		@IVoidSettingsService settingsService: IVoidSettingsService,
	) {
		super();

		// the tools read exclusively from the ledger — register them only when
		// the flag is on (matches the module header; a mid-session flag flip
		// applies after the next window reload, like the rest of the contrib)
		const ledgerOn = (): boolean => {
			try {
				return settingsService.state.globalSettings.contextLedgerEnabled
			} catch {
				return false
			}
		}
		const threadIdOf = (): string | undefined => {
			try {
				return (chatThreadService as unknown as { state?: { currentThreadId?: string } }).state?.currentThreadId
			} catch {
				return undefined
			}
		}

		if (!ledgerOn()) {
			// keep the ledger service reference alive for future wiring
			void ledgerService
			return
		}

		internalToolService.registerMany([
			{
				name: 'recall_history',
				description: 'Search the permanent conversation archive (journal + episode summaries) of this chat. Returns ranked snippets with seq ranges and why each matched. Use before assuming something was forgotten.',
				params: {
					query: { description: 'Search terms — file paths, error messages, symbols, decisions.' },
					scope: { description: "'current' (default) searches this thread; 'all' searches every thread in the workspace." },
					limit: { description: 'Max results (default 8).' },
				},
				execute: async (args) => {
					const query = typeof args.query === 'string' ? args.query : ''
					if (!query.trim()) return 'recall_history: empty query'
					const scope = args.scope === 'all' ? 'all' : 'current'
					const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 25) : 8
					try {
						const results = await recallService.recall({ query, threadScope: scope, currentThreadId: threadIdOf(), limit })
						if (results.length === 0) return `recall_history: no matches for "${query}"`
						return results.map(r =>
							`[${r.kind} seq ${r.seqRange[0]}-${r.seqRange[1]}] (score ${r.score.toFixed(2)}, matched: ${r.why.join(', ') || 'n/a'})\n${r.snippet}`
						).join('\n---\n')
					} catch (e: any) {
						return `recall_history unavailable: ${e?.message ?? 'archive unreachable'}`
					}
				},
			},
			{
				name: 'expand_history',
				description: 'Return the exact original messages for a seq range from the permanent journal (use seq ranges returned by recall_history). Verbatim transcript, middle-truncated to the recall budget.',
				params: {
					fromSeq: { description: 'First journal seq to include.' },
					toSeq: { description: 'Last journal seq to include.' },
				},
				execute: async (args) => {
					const fromSeq = typeof args.fromSeq === 'number' ? Math.max(1, Math.floor(args.fromSeq)) : NaN
					const toSeq = typeof args.toSeq === 'number' ? Math.max(fromSeq || 1, Math.floor(args.toSeq)) : NaN
					if (!Number.isFinite(fromSeq) || !Number.isFinite(toSeq)) return 'expand_history: fromSeq and toSeq must be integers'
					const threadId = threadIdOf()
					if (!threadId) return 'expand_history: no current thread'
					try {
						const { text, truncated } = await recallService.expand({ threadId, fromSeq, toSeq, maxTokens: 8_000 })
						return (truncated ? '(middle truncated to fit the recall budget)\n' : '') + text
					} catch (e: any) {
						return `expand_history unavailable: ${e?.message ?? 'archive unreachable'}`
					}
				}
			},
		])
	}
}

registerWorkbenchContribution2('ledgerRecallContrib', LedgerRecallContribution, WorkbenchPhase.Eventually);

export { LedgerRecallContribution };
