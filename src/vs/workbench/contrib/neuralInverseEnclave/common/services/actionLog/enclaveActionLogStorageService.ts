/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IActionLogEntry, IActionLogFilter, IActionLogStats } from './enclaveActionLogTypes.js';

export const IEnclaveActionLogStorageService = createDecorator<IEnclaveActionLogStorageService>('enclaveActionLogStorageService');

export interface IEnclaveActionLogStorageService {
	readonly _serviceBrand: undefined;

	/** Append an entry to the in-memory ring buffer and schedule disk flush */
	append(entry: IActionLogEntry): void;

	/** Query entries from the in-memory buffer with optional filters */
	query(filter?: IActionLogFilter): IActionLogEntry[];

	/** Get summary statistics */
	getStats(): IActionLogStats;

	/** Clear all in-memory entries */
	clear(): void;

	/** Force-flush pending entries to disk */
	flush(): Promise<void>;
}

const MAX_IN_MEMORY = 5000;
const FLUSH_DEBOUNCE_MS = 3000;
const LOGS_FOLDER = '.inverse/enclave-logs';

export class EnclaveActionLogStorageService extends Disposable implements IEnclaveActionLogStorageService {
	declare readonly _serviceBrand: undefined;

	private _entries: IActionLogEntry[] = [];
	private _pendingFlush: IActionLogEntry[] = [];
	private _flushTimer: any;
	private _sessionStart = Date.now();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService
	) {
		super();
	}

	public append(entry: IActionLogEntry): void {
		this._entries.push(entry);

		// Ring buffer eviction
		if (this._entries.length > MAX_IN_MEMORY) {
			this._entries.splice(0, this._entries.length - MAX_IN_MEMORY);
		}

		// Queue for disk persistence
		this._pendingFlush.push(entry);
		this._scheduleDiskFlush();
	}

	public query(filter?: IActionLogFilter): IActionLogEntry[] {
		let results = this._entries;

		if (!filter) {
			return [...results];
		}

		if (filter.categories?.length) {
			const set = new Set(filter.categories);
			results = results.filter(e => set.has(e.category));
		}
		if (filter.sources?.length) {
			const set = new Set(filter.sources);
			results = results.filter(e => set.has(e.source));
		}
		if (filter.severities?.length) {
			const set = new Set(filter.severities);
			results = results.filter(e => set.has(e.severity));
		}
		if (filter.since !== undefined) {
			results = results.filter(e => e.timestamp >= filter.since!);
		}
		if (filter.until !== undefined) {
			results = results.filter(e => e.timestamp <= filter.until!);
		}
		if (filter.search) {
			const term = filter.search.toLowerCase();
			results = results.filter(e =>
				e.label.toLowerCase().includes(term) ||
				e.action.toLowerCase().includes(term) ||
				(e.target?.toLowerCase().includes(term) ?? false)
			);
		}

		if (filter.limit !== undefined && filter.limit > 0) {
			results = results.slice(-filter.limit);
		}

		return [...results];
	}

	public getStats(): IActionLogStats {
		const byCategory: Partial<Record<string, number>> = {};
		const bySource: Partial<Record<string, number>> = {};

		for (const e of this._entries) {
			byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
			bySource[e.source] = (bySource[e.source] ?? 0) + 1;
		}

		return {
			totalEntries: this._entries.length,
			entriesByCategory: byCategory as any,
			entriesBySource: bySource as any,
			sessionStartedAt: this._sessionStart,
			oldestEntryTimestamp: this._entries[0]?.timestamp ?? 0,
			newestEntryTimestamp: this._entries[this._entries.length - 1]?.timestamp ?? 0,
		};
	}

	public clear(): void {
		this._entries = [];
		this._pendingFlush = [];
	}

	public async flush(): Promise<void> {
		if (this._flushTimer) {
			clearTimeout(this._flushTimer);
			this._flushTimer = undefined;
		}
		await this._writeToDisk();
	}

	// --- Disk Persistence ---

	private _scheduleDiskFlush(): void {
		if (this._flushTimer) {
			clearTimeout(this._flushTimer);
		}
		this._flushTimer = setTimeout(() => {
			this._flushTimer = undefined;
			this._writeToDisk().catch(err => {
				console.error('[Enclave ActionLogStorage] Disk flush failed:', err);
			});
		}, FLUSH_DEBOUNCE_MS);
	}

	private async _writeToDisk(): Promise<void> {
		if (this._pendingFlush.length === 0) {
			return;
		}

		const entries = [...this._pendingFlush];
		this._pendingFlush = [];

		const logUri = this._getLogFileUri();
		if (!logUri) {
			return;
		}

		const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';

		try {
			let existing = '';
			try {
				const content = await this.fileService.readFile(logUri);
				existing = content.value.toString();
			} catch {
				// File doesn't exist yet \u2014 that's fine
			}

			await this.fileService.writeFile(logUri, VSBuffer.fromString(existing + lines));
		} catch (err) {
			console.warn('[Enclave ActionLogStorage] Write error (non-fatal):', err);
		}
	}

	private _getLogFileUri(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}

		const dateStr = new Date().toISOString().split('T')[0];
		return URI.joinPath(folders[0].uri, LOGS_FOLDER, `actions-${dateStr}.jsonl`);
	}

	override dispose(): void {
		if (this._flushTimer) {
			clearTimeout(this._flushTimer);
		}
		// Best-effort final flush
		this._writeToDisk().catch(() => {});
		super.dispose();
	}
}

registerSingleton(IEnclaveActionLogStorageService, EnclaveActionLogStorageService, InstantiationType.Delayed);
