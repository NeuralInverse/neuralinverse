/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Violation Feedback Service
 *
 * Persists user-dismissed false positives so AI analysis can be skeptical
 * of patterns the user has already confirmed are non-violations.
 *
 * ## Design
 *
 * - Storage: `IStorageService` (workspace-scoped, machine-level)
 * - Dedup key: `ruleId + fileBasename + codeSnippet.slice(0, 40)` \u2014 update existing entry on dupe
 * - Eviction: oldest entries removed when total exceeds 500
 * - File basename (not full path) survives workspace renames and moves
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { ICheckResult } from '../types/grcTypes.js';


// \u2500\u2500\u2500 Public types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IFeedbackEntry {
	readonly ruleId: string;
	/** Just basename, e.g. "main.c" \u2014 survives renames */
	readonly fileBasename: string;
	/** First 80 chars of the offending line, trimmed */
	readonly codeSnippet: string;
	readonly aiConfidence: 'high' | 'medium' | 'low' | undefined;
	/** User-provided text OR AI-generated reason */
	readonly reason: string;
	/** Epoch ms */
	readonly dismissedAt: number;
	readonly checkSource: 'static' | 'ai' | 'breaking' | undefined;
}


// \u2500\u2500\u2500 Service Interface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const IViolationFeedbackService = createDecorator<IViolationFeedbackService>('violationFeedbackService');

export interface IViolationFeedbackService {
	readonly _serviceBrand: undefined;

	/**
	 * Record a dismissed violation. Idempotent \u2014 same ruleId+basename+snippet
	 * won't create duplicates; instead updates `dismissedAt` and `reason`.
	 */
	dismiss(result: ICheckResult, reason?: string): void;

	/** Get all feedback entries for a given file basename */
	getEntriesForFile(fileBasename: string): IFeedbackEntry[];

	/** Get all feedback entries for a given ruleId */
	getEntriesForRule(ruleId: string): IFeedbackEntry[];

	/** Get all feedback entries */
	getAllEntries(): IFeedbackEntry[];

	/** Remove a specific entry (un-dismiss). Returns true if removed. */
	removeFeedback(ruleId: string, fileBasename: string, codeSnippet: string): boolean;

	/** Clear all feedback (for testing/reset) */
	clearAll(): void;

	/** Total number of entries */
	readonly entryCount: number;
}


// \u2500\u2500\u2500 Implementation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/** Mutable internal shape for storage (same fields as IFeedbackEntry but writable) */
interface IStoredEntry {
	ruleId: string;
	fileBasename: string;
	codeSnippet: string;
	aiConfidence: 'high' | 'medium' | 'low' | undefined;
	reason: string;
	dismissedAt: number;
	checkSource: 'static' | 'ai' | 'breaking' | undefined;
}

export class ViolationFeedbackService extends Disposable implements IViolationFeedbackService {
	declare readonly _serviceBrand: undefined;

	private static readonly STORAGE_KEY = 'grc.violationFeedback.v1';
	private static readonly MAX_ENTRIES = 500;

	/** In-memory store \u2014 loaded once on construction */
	private _entries: IStoredEntry[] = [];

	constructor(
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this._load();
	}


	// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public dismiss(result: ICheckResult, reason?: string): void {
		const fileBasename = result.fileUri.path.split('/').pop() ?? '';
		const rawSnippet = result.codeSnippet ?? '';
		const codeSnippet = rawSnippet.trim().slice(0, 80);

		const dedupKey = this._dedupKey(result.ruleId, fileBasename, codeSnippet);
		const existing = this._entries.find(e => this._dedupKey(e.ruleId, e.fileBasename, e.codeSnippet) === dedupKey);

		if (existing) {
			// Update in-place \u2014 refresh timestamp and reason
			existing.dismissedAt = Date.now();
			if (reason !== undefined) {
				existing.reason = reason;
			}
		} else {
			const entry: IStoredEntry = {
				ruleId: result.ruleId,
				fileBasename,
				codeSnippet,
				aiConfidence: result.aiConfidence,
				reason: reason ?? result.aiExplanation ?? `User dismissed violation of rule ${result.ruleId}`,
				dismissedAt: Date.now(),
				checkSource: result.checkSource,
			};
			this._entries.push(entry);

			// Evict oldest entries when over the limit
			if (this._entries.length > ViolationFeedbackService.MAX_ENTRIES) {
				this._entries.sort((a, b) => a.dismissedAt - b.dismissedAt);
				this._entries.splice(0, this._entries.length - ViolationFeedbackService.MAX_ENTRIES);
			}
		}

		this._save();
	}

	public getEntriesForFile(fileBasename: string): IFeedbackEntry[] {
		return this._entries.filter(e => e.fileBasename === fileBasename);
	}

	public getEntriesForRule(ruleId: string): IFeedbackEntry[] {
		return this._entries.filter(e => e.ruleId === ruleId);
	}

	public getAllEntries(): IFeedbackEntry[] {
		return [...this._entries];
	}

	public removeFeedback(ruleId: string, fileBasename: string, codeSnippet: string): boolean {
		const dedupKey = this._dedupKey(ruleId, fileBasename, codeSnippet);
		const idx = this._entries.findIndex(e => this._dedupKey(e.ruleId, e.fileBasename, e.codeSnippet) === dedupKey);
		if (idx === -1) return false;
		this._entries.splice(idx, 1);
		this._save();
		return true;
	}

	public clearAll(): void {
		this._entries = [];
		this._save();
	}

	public get entryCount(): number {
		return this._entries.length;
	}


	// \u2500\u2500\u2500 Persistence \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _load(): void {
		try {
			const raw = this.storageService.get(ViolationFeedbackService.STORAGE_KEY, StorageScope.WORKSPACE);
			if (!raw) return;
			const parsed: IStoredEntry[] = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				this._entries = parsed;
			}
			console.log(`[ViolationFeedback] Restored ${this._entries.length} feedback entries from storage`);
		} catch (e) {
			console.error('[ViolationFeedback] Failed to load entries from storage:', e);
			this._entries = [];
		}
	}

	private _save(): void {
		try {
			this.storageService.store(
				ViolationFeedbackService.STORAGE_KEY,
				JSON.stringify(this._entries),
				StorageScope.WORKSPACE,
				StorageTarget.MACHINE
			);
		} catch (e) {
			console.error('[ViolationFeedback] Failed to persist entries to storage:', e);
		}
	}


	// \u2500\u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	/**
	 * Compute a deduplication key from ruleId + fileBasename + first 40 chars of snippet.
	 * Using only the first 40 chars of the snippet means minor whitespace variations
	 * in the same line still deduplicate correctly.
	 */
	private _dedupKey(ruleId: string, fileBasename: string, codeSnippet: string): string {
		return `${ruleId}\0${fileBasename}\0${codeSnippet.slice(0, 40)}`;
	}
}


// \u2500\u2500\u2500 Registration \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

registerSingleton(IViolationFeedbackService, ViolationFeedbackService, InstantiationType.Delayed);
