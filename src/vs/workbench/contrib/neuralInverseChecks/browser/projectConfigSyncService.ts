/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *
 *  Licensed under the Business Source License 1.1 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at https://mariadb.com/bsl11
 *
 *  Change Date: 2029-07-14
 *  Change License: GNU Affero General Public License v3.0
 *
 *  Use of this software in production requires a commercial license from Neural Inverse Inc.
 *  Contact (code): github@neuralinverse.com | Contact (sales): sales@neuralinverse.com
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export const IProjectConfigSyncService = createDecorator<IProjectConfigSyncService>('projectConfigSyncService');

export interface ISuppressedViolation {
	ruleId: string;
	filePath: string | null;
	line: number | null;
}

export interface IProjectConfigSyncService {
	readonly _serviceBrand: undefined;
	/**
	 * Fires when the enterprise backend resolves or false-alarms violations.
	 * The payload is the newly suppressed set so consumers can clear diagnostics immediately.
	 */
	readonly onDidChangeSuppressedViolations: Event<ISuppressedViolation[]>;
	/**
	 * Returns true when a violation has been suppressed (resolved / false-alarmed)
	 * by the enterprise web console. Always false in the OSS build.
	 */
	isViolationSuppressed(ruleId: string, filePath: string, line: number): boolean;
	/** Add a suppression locally (called when the backend pushes a resolution). */
	addSuppression(violation: ISuppressedViolation): void;
}

const STORAGE_KEY = 'neuralInverse.checks.suppressedViolations';

class ProjectConfigSyncService extends Disposable implements IProjectConfigSyncService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeSuppressedViolations = this._register(new Emitter<ISuppressedViolation[]>());
	readonly onDidChangeSuppressedViolations: Event<ISuppressedViolation[]> = this._onDidChangeSuppressedViolations.event;

	/** key = `ruleId:filePath:line` */
	private readonly _suppressed = new Set<string>();

	constructor(@IStorageService private readonly _storageService: IStorageService) {
		super();
		this._loadFromStorage();
		console.log('[ProjectConfigSyncService] Initialized');
	}

	isViolationSuppressed(ruleId: string, filePath: string, line: number): boolean {
		return this._suppressed.has(this._key(ruleId, filePath, String(line)))
			|| this._suppressed.has(this._key(ruleId, filePath, 'null'))
			|| this._suppressed.has(this._key(ruleId, null, null));
	}

	addSuppression(violation: ISuppressedViolation): void {
		const key = this._key(violation.ruleId, violation.filePath, violation.line !== null ? String(violation.line) : null);
		if (this._suppressed.has(key)) { return; }
		this._suppressed.add(key);
		this._persist();
		this._onDidChangeSuppressedViolations.fire([violation]);
	}

	/**
	 * Build a stable key that is safe for Windows paths containing colons
	 * (e.g. C:\foo\bar). We JSON-encode each component so colons inside
	 * a path segment cannot be confused with the delimiter.
	 */
	private _key(ruleId: string, filePath: string | null, line: string | null): string {
		return JSON.stringify([ruleId, filePath ?? null, line ?? null]);
	}

	private _loadFromStorage(): void {
		try {
			const raw = this._storageService.get(STORAGE_KEY, StorageScope.WORKSPACE);
			if (!raw) { return; }
			const items: ISuppressedViolation[] = JSON.parse(raw);
			for (const v of items) {
				this._suppressed.add(this._key(v.ruleId, v.filePath, v.line !== null ? String(v.line) : null));
			}
		} catch { /* corrupt storage — start fresh */ }
	}

	private _persist(): void {
		// Decode keys back to ISuppressedViolation objects for storage
		const items: ISuppressedViolation[] = [];
		for (const key of this._suppressed) {
			try {
				const [ruleId, filePath, line] = JSON.parse(key) as [string, string | null, string | null];
				items.push({ ruleId, filePath, line: line !== null ? Number(line) : null });
			} catch { /* skip malformed key */ }
		}
		this._storageService.store(STORAGE_KEY, JSON.stringify(items), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

registerSingleton(IProjectConfigSyncService, ProjectConfigSyncService, InstantiationType.Delayed);
