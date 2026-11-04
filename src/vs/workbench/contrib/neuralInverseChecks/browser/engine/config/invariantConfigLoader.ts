/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *  Licensed under the Business Source License 1.1 (the "License").
 *  Change Date: 2029-07-14 | Change License: GNU Affero General Public License v3.0
 *--------------------------------------------------------------------------------------------*/
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { IInvariantDefinition } from '../types/invariantTypes.js';

/**
 * Loads and persists invariant definitions from `.inverse/invariants.json`.
 * OSS stub — reads nothing, persists nothing.
 */
export class InvariantConfigLoader extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _invariants: IInvariantDefinition[] = [];

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
	) {
		super();
		void this._fileService; // referenced for DI, unused in stub
		void this._workspaceService;
	}

	getInvariants(): IInvariantDefinition[] {
		return this._invariants;
	}

	async saveInvariant(invariant: IInvariantDefinition): Promise<void> {
		const idx = this._invariants.findIndex(i => i.id === invariant.id);
		if (idx >= 0) {
			this._invariants[idx] = invariant;
		} else {
			this._invariants.push(invariant);
		}
		this._onDidChange.fire();
	}

	async deleteInvariant(id: string): Promise<void> {
		this._invariants = this._invariants.filter(i => i.id !== id);
		this._onDidChange.fire();
	}

	async toggleInvariant(id: string, enabled: boolean): Promise<void> {
		const inv = this._invariants.find(i => i.id === id);
		if (inv) {
			inv.enabled = enabled;
			this._onDidChange.fire();
		}
	}
}
