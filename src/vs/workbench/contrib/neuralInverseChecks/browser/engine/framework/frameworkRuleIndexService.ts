/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Framework Rule Index Service
 *
 * Builds a keyword index for every active framework at import time.
 * At prompt construction time, scores all rules against the current code
 * context (active file tail + user message) and returns the top N most
 * relevant rules verbatim \u2014 with description and fix \u2014 to append after
 * the compliance brief.
 *
 * Zero external dependencies, zero LLM calls, deterministic.
 * Index stored at .inverse/frameworks/{id}.index.json (rebuilt on demand).
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IFrameworkRegistry } from './frameworkRegistry.js';
import { IGRCRule } from '../types/grcTypes.js';
import { withInverseWriteAccess } from '../utils/inverseFs.js';

export const IFrameworkRuleIndexService = createDecorator<IFrameworkRuleIndexService>('frameworkRuleIndexService');

export interface IRelevantRule {
	frameworkName: string;
	id: string;
	message: string;
	severity: string;
	description?: string;
	fix?: string;
}

export interface IFrameworkRuleIndexService {
	readonly _serviceBrand: undefined;

	/**
	 * Given a text context (active file snippet + user message), returns the
	 * top N most relevant rules across all active frameworks.
	 */
	searchRules(contextText: string, maxResults?: number): IRelevantRule[];

	/**
	 * Boost relevance scores for rules that external tools have confirmed firing.
	 * Called by ExternalFeedbackService when a tool completes with results.
	 */
	boostRules(ruleIds: string[]): void;

	/**
	 * Returns a compact summary of rules that have been confirmed by external tools,
	 * suitable for appending to AI prompts (Layer 2 enrichment).
	 */
	getBoostedRulesSummary(): string;
}

// \u2500\u2500\u2500 Internal index entry \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface IRuleIndexEntry {
	id: string;
	message: string;
	severity: string;
	description?: string;
	fix?: string;
	/** Tokenised keyword set \u2014 lower-cased, de-duped */
	keywords: string[];
}

interface IFrameworkIndex {
	frameworkId: string;
	frameworkName: string;
	entries: IRuleIndexEntry[];
}

// \u2500\u2500\u2500 Stop words \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const STOP_WORDS = new Set([
	'a', 'an', 'the', 'and', 'or', 'not', 'in', 'of', 'to', 'is', 'are',
	'for', 'with', 'that', 'this', 'it', 'be', 'as', 'at', 'by', 'on',
	'if', 'all', 'any', 'use', 'used', 'when', 'shall', 'must', 'should',
	'may', 'can', 'do', 'does', 'has', 'have', 'from', 'no', 'will',
]);

// \u2500\u2500\u2500 Service implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

class FrameworkRuleIndexService extends Disposable implements IFrameworkRuleIndexService {
	declare readonly _serviceBrand: undefined;

	/** In-memory index: frameworkId \u2192 IFrameworkIndex */
	private readonly _indexes = new Map<string, IFrameworkIndex>();

	/** Boost counter: ruleId \u2192 hit count from external tools */
	private readonly _boostCounts = new Map<string, number>();

	constructor(
		@IFrameworkRegistry private readonly frameworkRegistry: IFrameworkRegistry,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();

		this._register(this.frameworkRegistry.onDidFrameworksChange(() => {
			this._syncIndexes();
		}));

		setTimeout(() => this._syncIndexes(), 5500); // slightly after brief service (5000ms)
	}

	// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public searchRules(contextText: string, maxResults = 8): IRelevantRule[] {
		if (!contextText || this._indexes.size === 0) return [];

		const queryTokens = this._tokenize(contextText);
		if (queryTokens.length === 0) return [];

		const querySet = new Set(queryTokens);

		interface Scored { rule: IRuleIndexEntry; frameworkName: string; score: number; }
		const scored: Scored[] = [];

		for (const idx of this._indexes.values()) {
			for (const entry of idx.entries) {
				let score = 0;
				for (const kw of entry.keywords) {
					if (querySet.has(kw)) score += 1;
					// Partial prefix match \u2014 "interrupt" matches "interrupts"
					else {
						for (const qt of queryTokens) {
							if (qt.length >= 4 && (kw.startsWith(qt) || qt.startsWith(kw))) {
								score += 0.5;
								break;
							}
						}
					}
				}
				if (score > 0) scored.push({ rule: entry, frameworkName: idx.frameworkName, score });
			}
		}

		// Sort by score descending, then by rule id ascending for determinism
		scored.sort((a, b) => b.score - a.score || a.rule.id.localeCompare(b.rule.id));

		return scored.slice(0, maxResults).map(s => ({
			frameworkName: s.frameworkName,
			id: s.rule.id,
			message: s.rule.message,
			severity: s.rule.severity,
			description: s.rule.description,
			fix: s.rule.fix,
		}));
	}

	public boostRules(ruleIds: string[]): void {
		for (const id of ruleIds) {
			this._boostCounts.set(id, (this._boostCounts.get(id) ?? 0) + 1);
		}
	}

	public getBoostedRulesSummary(): string {
		if (this._boostCounts.size === 0) return '';

		// Collect boosted rules sorted by hit count descending
		const boosted: Array<{ rule: IRuleIndexEntry; frameworkName: string; hits: number }> = [];

		for (const idx of this._indexes.values()) {
			for (const entry of idx.entries) {
				const hits = this._boostCounts.get(entry.id);
				if (hits) boosted.push({ rule: entry, frameworkName: idx.frameworkName, hits });
			}
		}

		if (boosted.length === 0) return '';

		boosted.sort((a, b) => b.hits - a.hits);
		const top = boosted.slice(0, 10);

		const lines = top.map(b => {
			let line = `\u2022 [${b.rule.id}] ${b.rule.message} \u2014 confirmed ${b.hits}x by external tools`;
			if (b.rule.fix) line += `\n  Fix: ${b.rule.fix}`;
			return line;
		});

		return `RULES CONFIRMED BY EXTERNAL TOOLS (highest priority \u2014 these patterns were actually found in this codebase):\n${lines.join('\n')}`;
	}

	// \u2500\u2500\u2500 Sync \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private async _syncIndexes(): Promise<void> {
		const frameworks = this.frameworkRegistry.getActiveFrameworks()
			.filter(fw => fw.validation.valid && fw.definition.framework.id !== 'neural-inverse-builtin');

		console.log(`[RuleIndex] Syncing indexes for ${frameworks.length} framework(s)`);

		for (const fw of frameworks) {
			const id = fw.definition.framework.id;
			if (this._indexes.has(id)) continue;

			// Try loading from disk first
			const stored = await this._loadIndexFromDisk(id);
			if (stored) {
				this._indexes.set(id, stored);
				console.log(`[RuleIndex] Loaded index from disk for ${id} (${stored.entries.length} rules)`);
				continue;
			}

			// Build and store
			const idx = this._buildIndex(fw.definition.framework.id, fw.definition.framework.name, fw.rules.filter(r => r.enabled !== false));
			this._indexes.set(id, idx);
			console.log(`[RuleIndex] Built index for ${id} (${idx.entries.length} rules)`);
			this._writeIndexToDisk(id, idx).catch(e => {
				console.warn(`[RuleIndex] Failed to write index for ${id}:`, e);
			});
		}
	}

	// \u2500\u2500\u2500 Index builder \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _buildIndex(frameworkId: string, frameworkName: string, rules: IGRCRule[]): IFrameworkIndex {
		const entries: IRuleIndexEntry[] = rules.map(r => ({
			id: r.id,
			message: r.message,
			severity: r.severity,
			description: r.description,
			fix: r.fix,
			keywords: this._extractKeywords(r),
		}));
		return { frameworkId, frameworkName, entries };
	}

	private _extractKeywords(r: IGRCRule): string[] {
		// Concatenate all text fields + rule id segments
		const raw = [
			r.id.replace(/[-_]/g, ' '),   // "SEC-001" \u2192 "sec 001"
			r.message,
			r.description ?? '',
			r.fix ?? '',
			r.domain ?? '',
		].join(' ');

		return [...new Set(this._tokenize(raw))];
	}

	private _tokenize(text: string): string[] {
		return text
			.toLowerCase()
			// Split on non-word chars and camelCase boundaries
			.replace(/([a-z])([A-Z])/g, '$1 $2')
			.split(/[^a-z0-9]+/)
			.filter(t => t.length >= 3 && !STOP_WORDS.has(t));
	}

	// \u2500\u2500\u2500 Disk I/O \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _getIndexUri(frameworkId: string): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) return undefined;
		return URI.joinPath(folders[0].uri, '.inverse', 'frameworks', `${frameworkId}.index.json`);
	}

	private async _loadIndexFromDisk(frameworkId: string): Promise<IFrameworkIndex | undefined> {
		try {
			const uri = this._getIndexUri(frameworkId);
			if (!uri) return undefined;
			if (!(await this.fileService.exists(uri))) return undefined;
			const content = await this.fileService.readFile(uri);
			const parsed = JSON.parse(content.value.toString()) as IFrameworkIndex;
			if (!parsed.entries || parsed.entries.length === 0) return undefined;
			return parsed;
		} catch {
			return undefined;
		}
	}

	private async _writeIndexToDisk(frameworkId: string, idx: IFrameworkIndex): Promise<void> {
		try {
			const uri = this._getIndexUri(frameworkId);
			if (!uri) return;
			const folders = this.workspaceContextService.getWorkspace().folders;
			if (folders.length === 0) return;
			const inverseDir = URI.joinPath(folders[0].uri, '.inverse').fsPath;
			await withInverseWriteAccess(inverseDir, async () => {
				await this.fileService.writeFile(uri, VSBuffer.fromString(JSON.stringify(idx, null, 2)));
			});
		} catch (e) {
			console.warn('[RuleIndex] Failed to write index to disk:', e);
		}
	}
}

registerSingleton(IFrameworkRuleIndexService, FrameworkRuleIndexService, InstantiationType.Eager);
