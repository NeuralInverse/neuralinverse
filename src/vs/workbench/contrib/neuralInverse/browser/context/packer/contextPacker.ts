/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IModelService } from '../../../../../../editor/common/services/model.js';
import { IRelevanceScorerService, IRelevanceQuery } from '../relevance/relevanceScorer.js';
import { IWorkspaceSymbolIndexService } from '../index/workspaceSymbolIndex.js';
import { IChangeTrackerService } from '../tracker/changeTracker.js';

export const IContextPackerService = createDecorator<IContextPackerService>('neuralInverseContextPacker');

export type ContextMode = 'autocomplete' | 'chat' | 'inline-edit' | 'agent';

export interface IPackRequest {
	query: IRelevanceQuery;
	budget?: number;
	mode: ContextMode;
	includeActiveFile?: boolean;
	priorityFiles?: string[];
	excludeFiles?: string[];
}

export interface IContextSection {
	uri: string;
	label: string;
	content: string;
	tokenCount: number;
	relevanceScore: number;
	extractionMode: 'full' | 'signatures' | 'region' | 'imports-only' | 'truncated';
}

export interface IPackedContext {
	sections: IContextSection[];
	totalTokens: number;
	budgetUsed: number;
	budgetTotal: number;
	truncated: boolean;
	filesIncluded: string[];
	filesSkipped: string[];
}

export interface IContextPackerService {
	readonly _serviceBrand: undefined;
	pack(request: IPackRequest): Promise<IPackedContext>;
	packToString(request: IPackRequest): Promise<string>;
	estimateTokens(text: string): number;
	getDefaultBudget(mode: ContextMode): number;
}

const DEFAULT_BUDGETS: Record<ContextMode, number> = {
	autocomplete: 2048,
	chat: 8192,
	'inline-edit': 4096,
	agent: 16384,
};

// Reserve ratios
const ACTIVE_FILE_RESERVE_RATIO = 0.35;
const PRIORITY_FILE_RESERVE_RATIO = 0.20;
const MIN_REMAINING_BUDGET = 150;
const MAX_FILE_READ_SIZE = 524_288; // 512KB

class ContextPackerService extends Disposable implements IContextPackerService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IModelService private readonly _modelService: IModelService,
		@IRelevanceScorerService private readonly _relevanceScorer: IRelevanceScorerService,
		@IWorkspaceSymbolIndexService private readonly _symbolIndex: IWorkspaceSymbolIndexService,
		@IChangeTrackerService private readonly _changeTracker: IChangeTrackerService,
	) {
		super();
	}

	estimateTokens(text: string): number {
		// GPT/Claude token approximation for code: ~3.5 chars/token on average
		// Accounts for whitespace, operators, keywords being separate tokens
		return Math.ceil(text.length / 3.5);
	}

	getDefaultBudget(mode: ContextMode): number {
		return DEFAULT_BUDGETS[mode];
	}

	async pack(request: IPackRequest): Promise<IPackedContext> {
		const budget = request.budget || DEFAULT_BUDGETS[request.mode];
		const sections: IContextSection[] = [];
		const filesSkipped: string[] = [];
		let remaining = budget;
		let truncated = false;

		const excludeSet = new Set(request.excludeFiles ?? []);

		// Phase 1: Reserve and pack active file
		if (request.includeActiveFile && request.query.activeFileUri) {
			const activeUri = request.query.activeFileUri;
			if (!excludeSet.has(activeUri)) {
				const reservedBudget = Math.floor(budget * ACTIVE_FILE_RESERVE_RATIO);
				const section = await this._packFile(activeUri, request.mode, request.query, reservedBudget, 1.0);
				if (section) {
					sections.push(section);
					remaining -= section.tokenCount;
				}
			}
		}

		// Phase 2: Pack priority files
		if (request.priorityFiles) {
			const priorityBudget = Math.floor(budget * PRIORITY_FILE_RESERVE_RATIO);
			let priorityRemaining = priorityBudget;

			for (const uri of request.priorityFiles) {
				if (excludeSet.has(uri)) continue;
				if (sections.some(s => s.uri === uri)) continue;
				if (priorityRemaining < MIN_REMAINING_BUDGET) break;

				const section = await this._packFile(uri, request.mode, request.query, priorityRemaining, 0.95);
				if (section) {
					sections.push(section);
					priorityRemaining -= section.tokenCount;
					remaining -= section.tokenCount;
				}
			}
		}

		// Phase 3: Score and pack remaining context
		const scoredFiles = this._relevanceScorer.scoreFiles(request.query, 60);
		const alreadyIncluded = new Set(sections.map(s => s.uri));

		for (const item of scoredFiles) {
			if (remaining < MIN_REMAINING_BUDGET) {
				truncated = true;
				break;
			}

			if (alreadyIncluded.has(item.uri) || excludeSet.has(item.uri)) continue;

			const section = await this._packFile(item.uri, request.mode, request.query, remaining, item.score);
			if (section) {
				if (section.tokenCount <= remaining) {
					sections.push(section);
					remaining -= section.tokenCount;
					alreadyIncluded.add(item.uri);
				} else {
					// Try to get a truncated version
					const truncSection = await this._packFile(item.uri, request.mode, request.query, remaining - 20, item.score);
					if (truncSection && truncSection.tokenCount <= remaining) {
						sections.push(truncSection);
						remaining -= truncSection.tokenCount;
						alreadyIncluded.add(item.uri);
						truncated = true;
					} else {
						filesSkipped.push(item.uri);
					}
				}
			}
		}

		return {
			sections,
			totalTokens: budget - remaining,
			budgetUsed: budget - remaining,
			budgetTotal: budget,
			truncated,
			filesIncluded: sections.map(s => s.uri),
			filesSkipped,
		};
	}

	async packToString(request: IPackRequest): Promise<string> {
		const packed = await this.pack(request);
		if (packed.sections.length === 0) return '';

		const parts: string[] = [];

		for (const section of packed.sections) {
			parts.push(`// ─── ${section.label} (relevance: ${(section.relevanceScore * 100).toFixed(0)}%) ───`);
			parts.push(section.content);
			parts.push('');
		}

		if (packed.truncated) {
			parts.push(`// ─── Context truncated: ${packed.filesSkipped.length} additional relevant files not included ───`);
		}

		return parts.join('\n');
	}

	// ─── File Packing ───────────────────────────────────────────────────────────

	private async _packFile(
		uri: string,
		mode: ContextMode,
		query: IRelevanceQuery,
		maxTokens: number,
		relevanceScore: number,
	): Promise<IContextSection | undefined> {
		const content = await this._readFile(uri);
		if (!content || content.trim().length === 0) return undefined;

		const fullTokens = this.estimateTokens(content);

		// If full file fits in budget, include it entirely (for agent mode or small files)
		if (fullTokens <= maxTokens && mode === 'agent') {
			return {
				uri,
				label: this._formatLabel(uri),
				content,
				tokenCount: fullTokens,
				relevanceScore,
				extractionMode: 'full',
			};
		}

		// Mode-specific extraction
		const extracted = this._extractForMode(content, uri, mode, query, maxTokens);
		const tokens = this.estimateTokens(extracted.content);

		if (tokens > maxTokens) {
			// Hard truncate as last resort
			const truncContent = this._hardTruncate(extracted.content, maxTokens);
			return {
				uri,
				label: this._formatLabel(uri),
				content: truncContent,
				tokenCount: this.estimateTokens(truncContent),
				relevanceScore,
				extractionMode: 'truncated',
			};
		}

		return {
			uri,
			label: this._formatLabel(uri),
			content: extracted.content,
			tokenCount: tokens,
			relevanceScore,
			extractionMode: extracted.mode,
		};
	}

	private _extractForMode(
		content: string,
		uri: string,
		mode: ContextMode,
		query: IRelevanceQuery,
		maxTokens: number,
	): { content: string; mode: IContextSection['extractionMode'] } {
		const lines = content.split('\n');

		switch (mode) {
			case 'autocomplete':
				return this._extractAutocompleteContext(lines, uri, query, maxTokens);
			case 'chat':
				return this._extractChatContext(lines, uri, query, maxTokens);
			case 'inline-edit':
				return this._extractInlineEditContext(lines, uri, query, maxTokens);
			case 'agent':
				return this._extractAgentContext(content, maxTokens);
			default:
				return { content, mode: 'full' };
		}
	}

	private _extractAutocompleteContext(
		lines: string[],
		uri: string,
		query: IRelevanceQuery,
		maxTokens: number,
	): { content: string; mode: IContextSection['extractionMode'] } {
		const parts: string[] = [];

		// Always include imports (crucial for type inference)
		const importLines = this._extractImportBlock(lines);
		parts.push(...importLines);

		// Include exported type signatures (interfaces, types, function signatures)
		const symbols = this._symbolIndex.getSymbolsInFile(uri);
		const typeSymbols = symbols.filter(s =>
			s.kind === 10 /* Interface */ || s.kind === 25 /* TypeParameter */ ||
			s.kind === 4 /* Enum */
		);

		for (const sym of typeSymbols) {
			if (this.estimateTokens(parts.join('\n')) > maxTokens * 0.8) break;
			const startLine = sym.range.startLine - 1;
			const blockEnd = this._findBlockEnd(lines, startLine);
			if (blockEnd - startLine < 30) {
				parts.push('');
				parts.push(...lines.slice(startLine, blockEnd));
			} else {
				// Just the signature
				parts.push('');
				parts.push(lines[startLine]);
			}
		}

		// Include function signatures (just the declaration line)
		const funcSymbols = symbols.filter(s =>
			s.kind === 11 /* Function */ || s.kind === 5 /* Method */
		);
		for (const sym of funcSymbols.slice(0, 15)) {
			if (this.estimateTokens(parts.join('\n')) > maxTokens * 0.9) break;
			const line = sym.range.startLine - 1;
			if (line < lines.length) {
				parts.push(lines[line]);
			}
		}

		const result = parts.join('\n');
		const hasSignatures = typeSymbols.length > 0 || funcSymbols.length > 0;
		return { content: result, mode: hasSignatures ? 'signatures' : 'imports-only' };
	}

	private _extractChatContext(
		lines: string[],
		uri: string,
		query: IRelevanceQuery,
		maxTokens: number,
	): { content: string; mode: IContextSection['extractionMode'] } {
		const parts: string[] = [];

		// Imports
		const importLines = this._extractImportBlock(lines);
		if (importLines.length > 0 && importLines.length < 20) {
			parts.push(...importLines);
			parts.push('');
		}

		// All exported symbols with their full signatures
		const symbols = this._symbolIndex.getSymbolsInFile(uri);
		const exported = symbols.filter(s => s.exportedAs);

		for (const sym of exported) {
			if (this.estimateTokens(parts.join('\n')) > maxTokens * 0.85) break;

			const startLine = sym.range.startLine - 1;
			if (startLine >= lines.length) continue;

			// For classes/interfaces: include full definition up to reasonable limit
			if (sym.kind === 4 /* Class */ || sym.kind === 10 /* Interface */ || sym.kind === 9 /* Enum */) {
				const blockEnd = this._findBlockEnd(lines, startLine);
				const blockLines = lines.slice(startLine, Math.min(blockEnd, startLine + 50));
				const blockTokens = this.estimateTokens(blockLines.join('\n'));

				if (blockTokens < maxTokens * 0.3) {
					parts.push(...blockLines);
					if (blockEnd > startLine + 50) parts.push('  // ... (truncated)');
					parts.push('');
				} else {
					// Just members list
					parts.push(lines[startLine]);
					const members = symbols.filter(s => s.containerName === sym.name);
					for (const m of members.slice(0, 20)) {
						if (m.range.startLine - 1 < lines.length) {
							parts.push('  ' + lines[m.range.startLine - 1].trim());
						}
					}
					parts.push('}');
					parts.push('');
				}
			} else {
				// Functions/variables: include full signature line
				parts.push(lines[startLine]);
			}
		}

		// If we haven't used much budget and there are non-exported top-level declarations, include them
		const currentTokens = this.estimateTokens(parts.join('\n'));
		if (currentTokens < maxTokens * 0.6) {
			const nonExported = symbols.filter(s => !s.exportedAs && !s.containerName);
			for (const sym of nonExported.slice(0, 10)) {
				if (this.estimateTokens(parts.join('\n')) > maxTokens * 0.85) break;
				const line = sym.range.startLine - 1;
				if (line < lines.length) parts.push(lines[line]);
			}
		}

		return { content: parts.join('\n'), mode: 'signatures' };
	}

	private _extractInlineEditContext(
		lines: string[],
		uri: string,
		query: IRelevanceQuery,
		maxTokens: number,
	): { content: string; mode: IContextSection['extractionMode'] } {
		const cursorLine = (query.position?.line ?? Math.floor(lines.length / 2)) - 1;
		const parts: string[] = [];

		// Imports are important for inline edit (type context)
		const importLines = this._extractImportBlock(lines);
		parts.push(...importLines);
		if (importLines.length > 0) parts.push('');

		// Region around cursor (or hot regions from change tracker)
		const hotRegions = this._changeTracker.getHotRegions(uri);
		let regionStart: number;
		let regionEnd: number;

		if (hotRegions.length > 0) {
			// Use the hottest region that contains or is near the cursor
			const nearestHot = hotRegions.reduce((best, r) => {
				const dist = Math.min(Math.abs(r.start - cursorLine), Math.abs(r.end - cursorLine));
				const bestDist = Math.min(Math.abs(best.start - cursorLine), Math.abs(best.end - cursorLine));
				return dist < bestDist ? r : best;
			});
			regionStart = Math.max(0, Math.min(nearestHot.start - 5, cursorLine - 20));
			regionEnd = Math.min(lines.length, Math.max(nearestHot.end + 5, cursorLine + 20));
		} else {
			regionStart = Math.max(0, cursorLine - 25);
			regionEnd = Math.min(lines.length, cursorLine + 25);
		}

		parts.push(`// ... (line ${regionStart + 1})`);
		parts.push(...lines.slice(regionStart, regionEnd));

		// Add relevant type definitions from imported files
		const remainingBudget = maxTokens - this.estimateTokens(parts.join('\n'));
		if (remainingBudget > 200) {
			const typeContext = this._gatherTypeContext(uri, remainingBudget);
			if (typeContext) {
				parts.push('');
				parts.push('// ─── Related type definitions ───');
				parts.push(typeContext);
			}
		}

		return { content: parts.join('\n'), mode: 'region' };
	}

	private _extractAgentContext(content: string, maxTokens: number): { content: string; mode: IContextSection['extractionMode'] } {
		const tokens = this.estimateTokens(content);
		if (tokens <= maxTokens) {
			return { content, mode: 'full' };
		}
		return { content: this._hardTruncate(content, maxTokens), mode: 'truncated' };
	}

	// ─── Helpers ────────────────────────────────────────────────────────────────

	private _extractImportBlock(lines: string[]): string[] {
		const imports: string[] = [];
		for (let i = 0; i < Math.min(lines.length, 60); i++) {
			const trimmed = lines[i].trim();
			if (/^(?:import|from|require|use |using |#include|package )/.test(trimmed)) {
				imports.push(lines[i]);
			} else if (trimmed === '' && imports.length > 0) {
				// Allow one blank line in import block
				continue;
			} else if (imports.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
				break;
			}
		}
		return imports;
	}

	private _findBlockEnd(lines: string[], startLine: number): number {
		let depth = 0;
		let foundOpen = false;

		for (let i = startLine; i < lines.length; i++) {
			for (const ch of lines[i]) {
				if (ch === '{') { depth++; foundOpen = true; }
				if (ch === '}') depth--;
			}
			if (foundOpen && depth <= 0) return i + 1;
		}

		return Math.min(startLine + 30, lines.length);
	}

	private _gatherTypeContext(uri: string, budgetTokens: number): string | undefined {
		const imports = this._symbolIndex.getImports(uri);
		const typeParts: string[] = [];
		let used = 0;

		for (const impUri of imports.slice(0, 8)) {
			const symbols = this._symbolIndex.getSymbolsInFile(impUri);
			const types = symbols.filter(s =>
				(s.kind === 10 || s.kind === 25) && s.exportedAs
			);

			for (const t of types.slice(0, 5)) {
				const line = `${t.exportedAs}: ${t.containerName ? t.containerName + '.' : ''}${t.name} (${impUri.split('/').pop()})`;
				const lineTokens = this.estimateTokens(line);
				if (used + lineTokens > budgetTokens) return typeParts.length > 0 ? typeParts.join('\n') : undefined;
				typeParts.push(`// ${line}`);
				used += lineTokens;
			}
		}

		return typeParts.length > 0 ? typeParts.join('\n') : undefined;
	}

	private _hardTruncate(text: string, maxTokens: number): string {
		const maxChars = Math.floor(maxTokens * 3.5);
		if (text.length <= maxChars) return text;

		// Try to truncate at a line boundary
		const truncated = text.slice(0, maxChars);
		const lastNewline = truncated.lastIndexOf('\n');
		if (lastNewline > maxChars * 0.8) {
			return truncated.slice(0, lastNewline) + '\n// ... (truncated)';
		}
		return truncated + '\n// ... (truncated)';
	}

	private async _readFile(uri: string): Promise<string | undefined> {
		const resource = URI.parse(uri);

		// Prefer in-memory model (already open, no disk IO)
		const model = this._modelService.getModel(resource);
		if (model) return model.getValue();

		// Disk read with size limit
		try {
			const file = await this._fileService.readFile(resource, { limits: { size: MAX_FILE_READ_SIZE } });
			return file.value.toString();
		} catch {
			return undefined;
		}
	}

	private _formatLabel(uri: string): string {
		const parts = uri.split('/');

		// Find workspace-relative path
		const srcIdx = parts.lastIndexOf('src');
		const libIdx = parts.lastIndexOf('lib');
		const appIdx = parts.lastIndexOf('app');
		const startIdx = Math.max(srcIdx, libIdx, appIdx, 0);

		if (startIdx > 0) {
			return parts.slice(startIdx).join('/');
		}

		// Fallback: last 4 segments
		return parts.slice(-4).join('/');
	}
}

registerSingleton(IContextPackerService, ContextPackerService, InstantiationType.Eager);
