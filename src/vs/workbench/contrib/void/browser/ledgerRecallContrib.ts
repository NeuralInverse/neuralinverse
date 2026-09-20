/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * Ledger recall tools (task M5 phase 3, layer L3; identity + validation per F02)
 *
 * Registers the two internal tools that make "nothing is ever deleted" a
 * capability instead of a slogan:
 *
 *   recall_history({ query, scope?, limit? })          — ranked search over the
 *     journal + episode indexes (BM25-style term matching; embeddings when a
 *     provider is configured).
 *   expand_history({ fromSeq, toSeq, threadId? })      — the exact original
 *     messages from the append-only journal, middle-truncated to the recall
 *     budget. `threadId` targets another archive explicitly; the range is
 *     validated against that archive's real lastSeq.
 *
 * The conversation identity comes from the CALLER through
 * ILedgerRequestContext (sidebar → its thread id, native chat → its session
 * id) — never from the active sidebar singleton, which would silently hand a
 * native request a different conversation's archive. Registered only when the
 * contextLedgerEnabled flag is on (they read exclusively from the ledger).
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVoidInternalToolService } from './voidInternalToolService.js';
import { IContextLedgerService } from './contextLedgerService.js';
import { ILedgerRecallService, parseStrictInt, renderRecallLines } from '../../neuralInverse/browser/context/search/ledgerRecallService.js';
import { IVoidSettingsService } from '../common/voidSettingsService.js';

class LedgerRecallContribution extends Disposable {

	constructor(
		@IVoidInternalToolService internalToolService: IVoidInternalToolService,
		@IContextLedgerService ledgerService: IContextLedgerService,
		@ILedgerRecallService recallService: ILedgerRecallService,
		@IVoidSettingsService settingsService: IVoidSettingsService,
	) {
		super();

		// the tools read exclusively from the ledger — register them only when
		// the flag is on (matches the module header; a mid-session flag flip
		// applies after the next window reload, like the rest of the contrib)
		const ledgerOn = (): boolean => {
			try {
				return settingsService.state.globalSettings.contextLedgerEnabled;
			} catch {
				return false;
			}
		};

		if (!ledgerOn()) {
			// keep the ledger service reference alive for future wiring
			void ledgerService;
			return;
		}

		internalToolService.registerMany([
			{
				name: 'recall_history',
				description: 'Search the permanent conversation archive (journal + episode summaries) of this chat. Returns ranked snippets with seq ranges and why each matched. Use before assuming something was forgotten.',
				params: {
					query: { description: 'Search terms — file paths, error messages, symbols, decisions.' },
					scope: { description: 'current (default) searches this thread; all searches every thread in the workspace and labels each result with its thread.' },
					limit: { description: 'Max results, integer (default 8, max 25).' },
				},
				execute: async (args, ctx) => {
					const query = typeof args.query === 'string' ? args.query : '';
					if (!query.trim()) { return 'recall_history: empty query'; }
					const scope = args.scope === 'all' ? 'all' : 'current';
					const parsedLimit = parseStrictInt(args.limit);
					const limit = parsedLimit === null ? 8 : Math.min(Math.max(parsedLimit, 1), 25);
					if (scope === 'current' && !ctx?.conversationId) {
						return 'recall_history: no conversation identity for this request';
					}
					try {
						const results = await recallService.recall({ query, threadScope: scope, currentThreadId: ctx?.conversationId, limit });
						if (results.length === 0) { return `recall_history: no matches for "${query}"`; }
						return renderRecallLines(results, { includeThreadId: scope === 'all' });
					} catch (e) {
						return `recall_history unavailable: ${e instanceof Error ? e.message : 'archive unreachable'}`;
					}
				},
			},
			{
				name: 'expand_history',
				description: 'Return the exact original messages for a seq range from the permanent journal (use seq ranges returned by recall_history). Verbatim transcript, middle-truncated to the recall budget.',
				params: {
					fromSeq: { description: 'First journal seq to include (integer).' },
					toSeq: { description: 'Last journal seq to include (integer, >= fromSeq).' },
					threadId: { description: 'Optional archive to expand — defaults to this conversation. Cross-thread targets must be a thread= value from a scope=all recall_history result.' },
				},
				execute: async (args, ctx) => {
					const fromSeq = parseStrictInt(args.fromSeq);
					const toSeq = parseStrictInt(args.toSeq);
					if (fromSeq === null || toSeq === null || fromSeq < 1 || toSeq < fromSeq) {
						return 'expand_history: fromSeq and toSeq must be integers with 1 <= fromSeq <= toSeq';
					}
					// an explicit target must be a real archive in this workspace —
					// a model-invented thread id gets a loud no, not an empty window
					const requested = typeof args.threadId === 'string' && args.threadId.trim() ? args.threadId.trim() : undefined;
					const threadId = requested ?? ctx?.conversationId;
					if (!threadId) { return 'expand_history: no conversation identity for this request'; }
					try {
						if (requested) {
							const known = await ledgerService.listThreads();
							if (!known.includes(threadId)) {
								return `expand_history: no archive named "${threadId}" in this workspace`;
							}
						}
						const stats = await ledgerService.stats(threadId);
						if (!stats || stats.lastSeq === 0) {
							return `expand_history: the archive "${threadId}" is empty`;
						}
						if (fromSeq > stats.lastSeq) {
							return `expand_history: fromSeq ${fromSeq} is beyond the end of the archive (last seq ${stats.lastSeq})`;
						}
						const { text, truncated } = await recallService.expand({ threadId, fromSeq, toSeq: Math.min(toSeq, stats.lastSeq), maxTokens: 8_000 });
						return (truncated ? '(middle truncated to fit the recall budget)\n' : '') + text;
					} catch (e) {
						return `expand_history unavailable: ${e instanceof Error ? e.message : 'archive unreachable'}`;
					}
				}
			},
		]);
	}
}

registerWorkbenchContribution2('ledgerRecallContrib', LedgerRecallContribution, WorkbenchPhase.Eventually);

export { LedgerRecallContribution };
