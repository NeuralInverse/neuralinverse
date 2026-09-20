/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { FileOperationError, FileOperationResult, IFileService } from '../../../../platform/files/common/files.js';
import { toSlashes } from '../../../../base/common/extpath.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { estimateTokensOf } from '../common/ledgerPolicy.js';
import { PINNED_CONTEXT_STORAGE_KEY } from '../common/storageKeys.js';
import type { IWorkspaceSymbolIndexService } from '../../neuralInverse/browser/context/index/workspaceSymbolIndex.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type PinnedItemType = 'file' | 'folder' | 'symbol' | 'range' | 'notepad';

export interface IPinnedItem {
	id: string;
	type: PinnedItemType;
	uri?: string;
	name: string;
	content?: string;
	createdAt: number;
	/** range pins: inclusive 1-based line window inside `uri`. */
	range?: { startLine: number; endLine: number };
	/** symbol pins: symbol name resolved through the workspace index. */
	symbol?: string;
}

// ─── Pin target resolution ─────────────────────────────────────────────────────

/**
 * Resolve a stored pin target (`IPinnedItem.uri`) to a URI.
 *
 * The pin contract stores `uri.toString()` (scheme + authority preserved).
 * Pins written by older builds stored the raw OS path (`s.uri.fsPath`), which
 * `URI.parse` misreads on Windows — `c:\x` becomes scheme `c:`. Legacy values
 * are recognized by SHAPE before any scheme sniffing: a Windows drive prefix
 * (`c:` / `c:\` / `c:/`), a `\\server\share` UNC prefix, or a POSIX absolute
 * path is a raw path and goes through `URI.file`; everything else parses as a
 * URI and round-trips untouched — remote schemes (`untitled`, `http(s)`,
 * `vscode-*`, …) are never rewritten to `file`.
 */
export function pinTargetToUri(stored: string): URI | undefined {
	const s = stored.trim();
	if (s === '') { return undefined; }
	// Windows drive BEFORE generic scheme detection: `c:` parses as a scheme.
	// Backslashes normalize to forward slashes so a legacy pin resolves
	// identically on every platform, not just where it was authored.
	if (/^[a-zA-Z]:($|[\\/])/.test(s)) { return URI.file(toSlashes(s)); }
	// UNC shares (`\\server\share\…`) are raw paths, never URIs; after the
	// slash normalization `URI.file` keeps the share host as the authority.
	if (s.startsWith('\\\\')) { return URI.file(toSlashes(s)); }
	// POSIX absolute path; `//x` carries an authority and parses below.
	if (s.startsWith('/') && !s.startsWith('//')) { return URI.file(s); }
	try {
		const parsed = URI.parse(s);
		if (parsed.scheme === '') {
			// schemeless `//server/…` keeps its authority; anything else is a
			// bare relative path — best-effort file URI
			return s.startsWith('//') ? parsed : URI.file(s);
		}
		return parsed;
	} catch {
		return undefined;
	}
}

/** Outcome of reading a pinned target: content, or the failure class the
 *  materialized block must report (missing ≠ denied ≠ too large ≠ unreadable). */
export type PinnedReadOutcome =
	| { outcome: 'content'; content: string }
	| { outcome: 'missing' }
	| { outcome: 'denied' }
	| { outcome: 'too-large' }
	| { outcome: 'unreadable'; reason: string };

/** Map a fileService error to its reportable class; unknown errors stay
 *  `unreadable` with their message instead of masquerading as "missing". */
export function classifyReadError(err: unknown): Exclude<PinnedReadOutcome, { outcome: 'content' }> {
	if (err instanceof FileOperationError) {
		switch (err.fileOperationResult) {
			case FileOperationResult.FILE_NOT_FOUND: return { outcome: 'missing' };
			case FileOperationResult.FILE_PERMISSION_DENIED: return { outcome: 'denied' };
			case FileOperationResult.FILE_TOO_LARGE: return { outcome: 'too-large' };
			case FileOperationResult.FILE_IS_DIRECTORY: return { outcome: 'unreadable', reason: 'target is a directory' };
			case FileOperationResult.FILE_INVALID_PATH: return { outcome: 'unreadable', reason: 'invalid path' };
			default: return { outcome: 'unreadable', reason: err.message || 'unreadable' };
		}
	}
	return { outcome: 'unreadable', reason: err instanceof Error ? err.message : 'unreadable' };
}

/** The materialized-block line for a read outcome; `target` is echoed verbatim. */
function readOutcomeLine(outcome: Exclude<PinnedReadOutcome, { outcome: 'content' }>, target: string, kind: 'file' | 'folder'): string {
	switch (outcome.outcome) {
		case 'missing': return `[pinned ${kind} no longer exists: ${target}]`;
		case 'denied': return `[pinned ${kind} is not accessible: ${target}]`;
		case 'too-large': return `[pinned ${kind} exceeds the pin size limit: ${target}]`;
		default: return `[pinned ${kind} could not be read (${outcome.reason}): ${target}]`;
	}
}

// ─── Service interface ────────────────────────────────────────────────────────

export const IPinnedContextService = createDecorator<IPinnedContextService>('pinnedContextService');

export interface IPinnedContextService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;

	readonly items: IPinnedItem[];

	/** Maximum number of pinned items allowed. */
	readonly maxItems: number;
	/** Maximum token budget for all pinned items combined. */
	readonly maxTokens: number;

	add(item: Omit<IPinnedItem, 'id' | 'createdAt'>): IPinnedItem;
	remove(id: string): void;
	clear(): void;

	/** Stored-content blocks only (notepad text etc.) — cheap and sync. */
	getPinnedBlocks(): string[];

	/** F08: materialize every pin into real content. URI-only file/folder/
	 *  symbol/range pins read their content (open editor model first, disk
	 *  second), deleted files are reported visibly instead of silently
	 *  empty, and each item is capped before the combined budget is cut. */
	materializePinnedBlocks(): Promise<string[]>;

	/** Estimated token count of all pinned items combined. */
	getTokenEstimate(): number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STORAGE_KEY = PINNED_CONTEXT_STORAGE_KEY;
const MAX_ITEMS = 8;
export const PINNED_MAX_TOKENS = 20_000;
const PINNED_MAX_TOKENS_PER_ITEM = 6_000;
const PERSIST_DEBOUNCE_MS = 1000;
const PINNED_MAX_FILE_BYTES = 512 * 1024;
const PINNED_FOLDER_FILE_LIMIT = 40;

// ─── Implementation ──────────────────────────────────────────────────────────

export class PinnedContextService extends Disposable implements IPinnedContextService {
	readonly _serviceBrand: undefined;

	readonly maxItems = MAX_ITEMS;
	readonly maxTokens = PINNED_MAX_TOKENS;

	private readonly _items: IPinnedItem[] = [];
	private _dirty = false;
	private _persistTimer: ReturnType<typeof setTimeout> | undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	get items(): IPinnedItem[] { return this._items; }

	getTokenEstimate(): number {
		return estimateTokensOf(this.getPinnedBlocks());
	}

	constructor(
		@IStorageService private readonly _storageService: IStorageService,
		@IFileService private readonly _fileService: IFileService,
		@IModelService private readonly _modelService: IModelService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._load();
		this._register(this._storageService.onWillSaveState(() => this._persist()));
	}

	/** Lazy-resolved (void → neuralInverse static import would create the DI
	 *  cycle toolsService already works around). */
	private async _symbolIndex(): Promise<IWorkspaceSymbolIndexService> {
		const { IWorkspaceSymbolIndexService } = await import('../../neuralInverse/browser/context/index/workspaceSymbolIndex.js');
		return this._instantiationService.invokeFunction(accessor => accessor.get(IWorkspaceSymbolIndexService));
	}

	add(item: Omit<IPinnedItem, 'id' | 'createdAt'>): IPinnedItem {
		const full: IPinnedItem = {
			...item,
			id: this._generateId(),
			createdAt: Date.now(),
		};
		this._items.push(full);
		this._enforceLimits();
		this._schedulePersist();
		this._onDidChange.fire();
		return full;
	}

	remove(id: string): void {
		const idx = this._items.findIndex(i => i.id === id);
		if (idx === -1) { return; }
		this._items.splice(idx, 1);
		this._schedulePersist();
		this._onDidChange.fire();
	}

	clear(): void {
		if (this._items.length === 0) { return; }
		this._items.length = 0;
		this._schedulePersist();
		this._onDidChange.fire();
	}

	getPinnedBlocks(): string[] {
		if (this._items.length === 0) { return []; }
		return this._items.map(item => {
			const header = this._headerOf(item);
			const body = item.content ?? '';
			return `${header}\n${body}`;
		});
	}

	async materializePinnedBlocks(): Promise<string[]> {
		if (this._items.length === 0) { return []; }
		const blocks: string[] = [];
		for (const item of this._items) {
			blocks.push(await this._materializeOne(item));
		}
		return this._capCombined(blocks);
	}

	private _headerOf(item: IPinnedItem): string {
		const icon = item.type === 'notepad' ? '📝' : item.type === 'folder' ? '📁' : item.type === 'symbol' ? '🔖' : item.type === 'range' ? '📍' : '📄';
		return `${icon} ${item.name}`;
	}

	/** Read a pinned file's current content: an unsaved editor model wins over
	 *  disk (F08 "open-model-first"), and failures are classified so missing ≠
	 *  denied ≠ too large ≠ unreadable. Legacy raw-path targets resolve through
	 *  `pinTargetToUri` — the open model is found by the SAME resolved URI. */
	private async _readPinnedFile(uriStr: string): Promise<PinnedReadOutcome> {
		const resource = pinTargetToUri(uriStr);
		if (!resource) { return { outcome: 'unreadable', reason: 'invalid pin target' }; }
		const model = this._modelService.getModel(resource);
		if (model) { return { outcome: 'content', content: model.getValue() }; }
		try {
			const file = await this._fileService.readFile(resource, { limits: { size: PINNED_MAX_FILE_BYTES } });
			return { outcome: 'content', content: file.value.toString() };
		} catch (err) {
			return classifyReadError(err);
		}
	}

	private async _materializeOne(item: IPinnedItem): Promise<string> {
		const header = this._headerOf(item);

		// Notepads and explicitly-provided content need no IO.
		if (item.type === 'notepad') {
			return this._capOne(`${header}\n${item.content ?? ''}`);
		}

		// Symbol pins resolve through the workspace index to the symbol's
		// defining file/range. When the pin carries a `uri` (every pin created
		// since the identity fix does), resolution is BOUND to that file: a
		// same-name symbol in a different file must never leak into the
		// payload — the user picked THIS definition, not a name search.
		if (item.type === 'symbol') {
			const index = await this._symbolIndex();

			if (item.uri && item.symbol) {
				const fileUri = pinTargetToUri(item.uri);
				if (!fileUri) {
					return this._capOne(`${header}\n[pin target is not a valid path or URI: ${item.uri}]`);
				}
				const canonical = fileUri.toString();
				const matches = index.getSymbolsInFile(canonical)
					.filter(s => s.name === item.symbol)
					.slice(0, 3);
				if (matches.length > 0) {
					const parts: string[] = [];
					for (const sym of matches) {
						const read = await this._readPinnedFile(sym.filePath);
						if (read.outcome !== 'content') {
							parts.push(`${sym.name} @ ${sym.filePath} ${readOutcomeLine(read, sym.filePath, 'file')}`);
							continue;
						}
						parts.push(this._symbolBlock(sym, read.content));
					}
					return this._capOne(`${header}\n${parts.join('\n\n')}`);
				}
				// The index has no match in the pinned file. If the index never
				// saw the file at all, fall back to the pin-time range (stale
				// index); if the file IS indexed, the definition was renamed,
				// moved or deleted — say so instead of guessing by name.
				const indexed = index.getFileIndex(canonical);
				if (!indexed && item.range) {
					const read = await this._readPinnedFile(item.uri);
					if (read.outcome === 'content') {
						const lines = read.content.split('\n');
						const from = Math.max(0, item.range.startLine - 1);
						const to = Math.min(lines.length, item.range.endLine);
						return this._capOne(`${header} (pinned range ${item.range.startLine}-${item.range.endLine}; file not in the workspace index)\n${lines.slice(from, to).join('\n')}`);
					}
					return `${header}\n${readOutcomeLine(read, item.uri, 'file')}`;
				}
				if (indexed) {
					return `${header}\n[pinned symbol "${item.symbol}" is no longer defined in ${canonical} — it may have been renamed or moved. Re-pin it.]`;
				}
				return `${header}\n[pinned symbol "${item.symbol}" is not in the workspace index (its file was never indexed)]`;
			}

			// Legacy identity-less symbol pins (no uri): keep the historical
			// workspace-wide name resolution so old storage still materializes.
			const matches = item.symbol ? index.getSymbolsByName(item.symbol) : [];
			if (matches.length === 0) {
				return `${header}\n[pinned symbol "${item.symbol ?? item.name}" is not in the workspace index]`;
			}
			const parts: string[] = [];
			for (const sym of matches.slice(0, 3)) {
				const read = await this._readPinnedFile(sym.filePath);
				if (read.outcome !== 'content') {
					parts.push(`${sym.name} @ ${sym.filePath} ${readOutcomeLine(read, sym.filePath, 'file')}`);
					continue;
				}
				parts.push(this._symbolBlock(sym, read.content));
			}
			return this._capOne(`${header}\n${parts.join('\n\n')}`);
		}

		if (!item.uri) {
			return this._capOne(`${header}\n[pin has no target]`);
		}
		const target = pinTargetToUri(item.uri);
		if (!target) {
			return this._capOne(`${header}\n[pin target is not a valid path or URI: ${item.uri}]`);
		}

		if (item.type === 'folder') {
			try {
				const resolved = await this._fileService.resolve(target);
				const children = (resolved.children ?? []).slice(0, PINNED_FOLDER_FILE_LIMIT);
				const lines = children.map(c => `${c.isDirectory ? 'dir ' : 'file'} ${c.name}`);
				if ((resolved.children ?? []).length > PINNED_FOLDER_FILE_LIMIT) {
					lines.push(`… and ${(resolved.children ?? []).length - PINNED_FOLDER_FILE_LIMIT} more`);
				}
				return this._capOne(`${header}\n${lines.join('\n') || '(empty folder)'}`);
			} catch (err) {
				return `${header}\n${readOutcomeLine(classifyReadError(err), item.uri, 'folder')}`;
			}
		}

		// file / range pins
		if (item.content !== undefined) {
			return this._capOne(`${header}\n${item.content}`);
		}
		const read = await this._readPinnedFile(item.uri);
		if (read.outcome !== 'content') {
			return `${header}\n${readOutcomeLine(read, item.uri, 'file')}`;
		}
		if (item.type === 'range' && item.range) {
			const lines = read.content.split('\n');
			const from = Math.max(0, item.range.startLine - 1);
			const to = Math.min(lines.length, item.range.endLine);
			return this._capOne(`${header} (lines ${item.range.startLine}-${item.range.endLine})\n${lines.slice(from, to).join('\n')}`);
		}
		return this._capOne(`${header}\n${read.content}`);
	}

	/** Render one resolved symbol: its location line plus the exact definition
	 *  range from the CURRENT index (an edit that moved the body re-resolves
	 *  on the next reindex — the pin-time range is only a fallback). */
	private _symbolBlock(sym: { name: string; filePath: string; range: { startLine: number; endLine: number } }, content: string): string {
		const lines = content.split('\n');
		const from = Math.max(0, sym.range.startLine - 1);
		const to = Math.min(lines.length, sym.range.endLine);
		return `${sym.name} @ ${sym.filePath}:${sym.range.startLine}-${sym.range.endLine}\n${lines.slice(from, to).join('\n')}`;
	}

	private _capOne(block: string): string {
		if (estimateTokensOf([block]) <= PINNED_MAX_TOKENS_PER_ITEM) { return block; }
		const keep = block.length - (estimateTokensOf([block]) - PINNED_MAX_TOKENS_PER_ITEM) * 4;
		return `${block.slice(0, Math.max(0, keep))}\n[pinned item truncated at ${PINNED_MAX_TOKENS_PER_ITEM} tokens]`;
	}

	private _capCombined(blocks: string[]): string[] {
		let total = estimateTokensOf(blocks);
		while (total > PINNED_MAX_TOKENS && blocks.length > 1) {
			blocks.pop();
			total = estimateTokensOf(blocks);
		}
		return blocks;
	}

	override dispose(): void {
		if (this._persistTimer !== undefined) {
			clearTimeout(this._persistTimer);
			this._persistTimer = undefined;
		}
		if (this._dirty) { this._persist(); }
		super.dispose();
	}

	// ─── Private ─────────────────────────────────────────────────────────────

	private _load(): void {
		try {
			const raw = this._storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
			if (raw) {
				const parsed: IPinnedItem[] = JSON.parse(raw);
				for (const item of parsed) {
					if (!item || typeof item.id !== 'string') { continue; }
					this._items.push(item);
				}
			}
		} catch { /* corrupted — start fresh */ }
	}

	private _persist(): void {
		if (this._persistTimer !== undefined) {
			clearTimeout(this._persistTimer);
			this._persistTimer = undefined;
		}
		if (!this._dirty && this._items.length === 0) { return; }
		this._storageService.store(STORAGE_KEY, JSON.stringify(this._items), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this._dirty = false;
	}

	private _schedulePersist(): void {
		this._dirty = true;
		if (this._persistTimer !== undefined) { clearTimeout(this._persistTimer); }
		this._persistTimer = setTimeout(() => {
			this._persistTimer = undefined;
			this._persist();
		}, PERSIST_DEBOUNCE_MS);
	}

	/** Drop oldest items until both the count and token ceilings hold. */
	private _enforceLimits(): void {
		while (this._items.length > MAX_ITEMS) {
			this._items.shift();
		}
		let tokens = estimateTokensOf(this.getPinnedBlocks());
		while (tokens > PINNED_MAX_TOKENS && this._items.length > 0) {
			this._items.shift();
			tokens = estimateTokensOf(this.getPinnedBlocks());
		}
	}

	private _generateId(): string {
		return `pin_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	}
}

registerSingleton(IPinnedContextService, PinnedContextService, InstantiationType.Delayed);
