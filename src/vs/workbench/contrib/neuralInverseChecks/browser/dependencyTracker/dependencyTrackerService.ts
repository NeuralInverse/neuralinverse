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

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../base/common/uri.js';
import {
	ITrackedDependency,
	IDependencyPolicyRule,
	IDependencyStats,
	IDependencyChangeEvent,
	DependencyEcosystem,
	DependencyStatus,
} from './dependencyTrackerTypes.js';

export const IDependencyTrackerService = createDecorator<IDependencyTrackerService>('dependencyTrackerService');

export interface IDependencyTrackerService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeDependency: Event<IDependencyChangeEvent>;
	getDependencies(): ITrackedDependency[];
	getStats(): IDependencyStats;
	getPolicyRules(): IDependencyPolicyRule[];
	setPolicyRules(rules: IDependencyPolicyRule[]): void;
	/** Re-scan all lockfiles in the workspace. */
	scan(): Promise<void>;
}

class DependencyTrackerService extends Disposable implements IDependencyTrackerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeDependency = this._register(new Emitter<IDependencyChangeEvent>());
	readonly onDidChangeDependency: Event<IDependencyChangeEvent> = this._onDidChangeDependency.event;

	private readonly _dependencies = new Map<string, ITrackedDependency>();
	private _policyRules: IDependencyPolicyRule[] = [];
	private _lastScanTimestamp = 0;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
	) {
		super();
		// Initial scan deferred so workspace is fully loaded
		setTimeout(() => this.scan().catch(() => {}), 3000);
		console.log('[DependencyTrackerService] Initialized');
	}

	getDependencies(): ITrackedDependency[] { return [...this._dependencies.values()]; }

	getStats(): IDependencyStats {
		const deps = [...this._dependencies.values()];
		const byEcosystem: Partial<Record<DependencyEcosystem, number>> = {};
		for (const d of deps) {
			byEcosystem[d.ecosystem] = (byEcosystem[d.ecosystem] ?? 0) + 1;
		}
		return {
			totalDependencies: deps.length,
			devDependencies: deps.filter(d => d.isDev).length,
			prodDependencies: deps.filter(d => !d.isDev).length,
			blocked: deps.filter(d => d.status === 'blocked').length,
			flagged: deps.filter(d => d.status === 'flagged').length,
			byEcosystem,
			lastScanTimestamp: this._lastScanTimestamp,
		};
	}

	getPolicyRules(): IDependencyPolicyRule[] { return [...this._policyRules]; }

	setPolicyRules(rules: IDependencyPolicyRule[]): void {
		this._policyRules = rules;
		for (const dep of this._dependencies.values()) {
			const { status, reason } = this._evaluatePolicy(dep.name, dep.ecosystem);
			dep.status = status;
			dep.reason = reason;
		}
	}

	async scan(): Promise<void> {
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) { return; }
		const root = folders[0].uri;

		await this._scanNpm(root);
		this._lastScanTimestamp = Date.now();
	}

	// ─── npm / package.json ───────────────────────────────────────────────────

	private async _scanNpm(root: URI): Promise<void> {
		try {
			const pkgUri = URI.joinPath(root, 'package.json');
			const pkg = JSON.parse((await this._fileService.readFile(pkgUri)).value.toString());

			const add = (name: string, version: string, isDev: boolean) => {
				const key = `npm:${name}`;
				const { status, reason } = this._evaluatePolicy(name, 'npm');
				const dep: ITrackedDependency = { name, versionConstraint: version, isDev, ecosystem: 'npm', sourceFile: pkgUri.path, status, reason };
				const isNew = !this._dependencies.has(key);
				this._dependencies.set(key, dep);
				this._onDidChangeDependency.fire({ type: isNew ? 'added' : 'updated', dependency: dep, sourceFile: pkgUri.path });
			};

			for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
				add(name, version as string, false);
			}
			for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
				add(name, version as string, true);
			}
		} catch { /* no package.json */ }
	}

	private _evaluatePolicy(name: string, ecosystem: DependencyEcosystem): { status: DependencyStatus; reason?: string } {
		for (const rule of this._policyRules) {
			if (rule.ecosystems && !rule.ecosystems.includes(ecosystem)) { continue; }
			let re: RegExp;
			try {
				const pattern = rule.pattern.replace(/\*/g, '.*');
				re = new RegExp(`^${pattern}$`, 'i');
			} catch {
				// Malformed pattern — skip rather than fail-open
				console.warn(`[DependencyTrackerService] Skipping malformed policy pattern: ${rule.pattern}`);
				continue;
			}
			if (re.test(name)) {
				const status: DependencyStatus = rule.action === 'block' ? 'blocked' : rule.action === 'flag' ? 'flagged' : 'allowed';
				return { status, reason: rule.reason };
			}
		}
		return { status: 'allowed' };
	}
}

registerSingleton(IDependencyTrackerService, DependencyTrackerService, InstantiationType.Delayed);
