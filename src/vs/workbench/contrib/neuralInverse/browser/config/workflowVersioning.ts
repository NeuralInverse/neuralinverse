/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Workflow Versioning
 *
 * Archives workflow definitions before each save, enabling rollback.
 *
 * ## Storage
 *
 * History stored at: .inverse/workflows/.history/<workflowId>/<version>.json
 * Version = monotonically incrementing integer (not semver — workflows are not libraries).
 *
 * ## Write Access
 *
 * Uses IFileService directly for history reads.
 * For writes, the caller (WorkflowConfigLoader) already holds write access —
 * archive() is called inside that write-access window.
 */

import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { IWorkflowDefinition } from '../../common/workflowTypes.js';

export interface IWorkflowVersionEntry {
	version: number;
	savedAt: number;
	workflowId: string;
}

export class WorkflowVersioning {

	constructor(
		private readonly fileService: IFileService,
		private readonly workspaceRoot: URI,
	) {}

	private _historyDir(workflowId: string): URI {
		return URI.joinPath(this.workspaceRoot, '.inverse', 'workflows', '.history', workflowId);
	}

	private _versionUri(workflowId: string, version: number): URI {
		return URI.joinPath(this._historyDir(workflowId), `${version}.json`);
	}

	/**
	 * Archive the current definition before overwriting it.
	 * Increments version on the incoming definition and returns it.
	 * Call this inside the existing write-access window in WorkflowConfigLoader.
	 */
	async archive(current: IWorkflowDefinition): Promise<IWorkflowDefinition> {
		const nextVersion = (current.version ?? 0) + 1;
		const withVersion: IWorkflowDefinition = { ...current, version: nextVersion };

		try {
			const historyDir = this._historyDir(current.id);
			if (!await this.fileService.exists(historyDir)) {
				await this.fileService.createFolder(historyDir);
			}
			const archiveUri = this._versionUri(current.id, current.version ?? 0);
			// Archive the OLD version (before the new one overwrites it)
			const content = JSON.stringify({ ...current, _archivedAt: Date.now() }, null, 2);
			await this.fileService.writeFile(archiveUri, VSBuffer.fromString(content));
		} catch (e: any) {
			// Versioning is best-effort — don't block the save
			console.warn(`[WorkflowVersioning] Failed to archive version for "${current.id}":`, e.message);
		}

		return withVersion;
	}

	/** List all archived versions for a workflow, newest first. */
	async listVersions(workflowId: string): Promise<IWorkflowVersionEntry[]> {
		const historyDir = this._historyDir(workflowId);
		try {
			if (!await this.fileService.exists(historyDir)) return [];
			const entries = await this.fileService.resolve(historyDir);
			const versions: IWorkflowVersionEntry[] = [];

			for (const child of entries.children ?? []) {
				const match = child.name.match(/^(\d+)\.json$/);
				if (!match) continue;
				const version = parseInt(match[1], 10);
				try {
					const raw = await this.fileService.readFile(child.resource);
					const def = JSON.parse(raw.value.toString()) as (IWorkflowDefinition & { _archivedAt?: number });
					versions.push({ version, savedAt: def._archivedAt ?? child.mtime ?? 0, workflowId });
				} catch {
					versions.push({ version, savedAt: child.mtime ?? 0, workflowId });
				}
			}

			return versions.sort((a, b) => b.version - a.version);
		} catch {
			return [];
		}
	}

	/** Load a specific archived version. */
	async loadVersion(workflowId: string, version: number): Promise<IWorkflowDefinition | undefined> {
		const uri = this._versionUri(workflowId, version);
		try {
			const raw = await this.fileService.readFile(uri);
			return JSON.parse(raw.value.toString()) as IWorkflowDefinition;
		} catch {
			return undefined;
		}
	}

	/**
	 * Rollback to a specific version.
	 * Returns the historical definition so the caller can save it via WorkflowConfigLoader.
	 */
	async getRollbackDefinition(workflowId: string, version: number): Promise<IWorkflowDefinition | undefined> {
		const historical = await this.loadVersion(workflowId, version);
		if (!historical) return undefined;

		// Strip the archive metadata and bump to the next version number
		const { _archivedAt, ...clean } = historical as IWorkflowDefinition & { _archivedAt?: number };
		return clean;
	}
}
