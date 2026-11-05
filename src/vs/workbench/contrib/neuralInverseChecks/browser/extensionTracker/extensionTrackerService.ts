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
import { IExtensionManagementService } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import {
	ITrackedExtension,
	IExtensionPolicyRule,
	IExtensionStats,
	IExtensionChangeEvent,
	ExtensionPolicyStatus,
} from './extensionTrackerTypes.js';

export const IExtensionTrackerService = createDecorator<IExtensionTrackerService>('extensionTrackerService');

export interface IExtensionTrackerService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeExtension: Event<IExtensionChangeEvent>;
	getExtensions(): ITrackedExtension[];
	getStats(): IExtensionStats;
	getPolicyRules(): IExtensionPolicyRule[];
	setPolicyRules(rules: IExtensionPolicyRule[]): void;
}

class ExtensionTrackerService extends Disposable implements IExtensionTrackerService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeExtension = this._register(new Emitter<IExtensionChangeEvent>());
	readonly onDidChangeExtension: Event<IExtensionChangeEvent> = this._onDidChangeExtension.event;

	private readonly _extensions = new Map<string, ITrackedExtension>();
	private _policyRules: IExtensionPolicyRule[] = [];

	constructor(
		@IExtensionManagementService private readonly _extensionManagementService: IExtensionManagementService,
	) {
		super();
		this._init().catch(() => {});

		this._register(this._extensionManagementService.onDidInstallExtensions(results => {
			for (const r of results) {
				if (r.error) { continue; }
				this._trackExtension(r.identifier.id, r.local?.manifest.displayName ?? r.identifier.id, r.local?.manifest.version ?? '', r.local?.manifest.publisher ?? '', true);
			}
		}));

		this._register(this._extensionManagementService.onDidUninstallExtension(e => {
			const id = e.identifier.id;
			this._extensions.delete(id);
			this._onDidChangeExtension.fire({ type: 'uninstalled', extensionId: id });
		}));

		console.log('[ExtensionTrackerService] Initialized');
	}

	getExtensions(): ITrackedExtension[] { return [...this._extensions.values()]; }

	getStats(): IExtensionStats {
		const exts = [...this._extensions.values()];
		const blocked = exts.filter(e => e.status === 'blocked').length;
		const flagged = exts.filter(e => e.status === 'flagged').length;
		const required = exts.filter(e => e.status === 'required').length;
		const requiredIds = this._policyRules.filter(r => r.action === 'require').map(r => r.pattern);
		const missingRequired = requiredIds.filter(id => !this._extensions.has(id)).length;
		return {
			totalInstalled: exts.length,
			enabled: exts.filter(e => e.isEnabled).length,
			disabled: exts.filter(e => !e.isEnabled).length,
			blocked,
			flagged,
			required,
			missingRequired,
			lastScanTimestamp: Date.now(),
		};
	}

	getPolicyRules(): IExtensionPolicyRule[] { return [...this._policyRules]; }

	setPolicyRules(rules: IExtensionPolicyRule[]): void {
		this._policyRules = rules;
		// Re-evaluate all tracked extensions against new rules
		for (const ext of this._extensions.values()) {
			const { status, reason } = this._evaluatePolicy(ext.id);
			ext.status = status;
			ext.reason = reason;
		}
	}

	private async _init(): Promise<void> {
		try {
			const installed = await this._extensionManagementService.getInstalled();
			for (const ext of installed) {
				this._trackExtension(
					ext.identifier.id,
					ext.manifest.displayName ?? ext.identifier.id,
					ext.manifest.version,
					ext.manifest.publisher ?? '',
					true,
				);
			}
		} catch { /* extension service not ready */ }
	}

	private _trackExtension(id: string, displayName: string, version: string, publisher: string, isEnabled: boolean): void {
		const { status, reason } = this._evaluatePolicy(id);
		const existing = this._extensions.get(id);
		const tracked: ITrackedExtension = {
			id,
			displayName,
			version,
			publisher,
			isEnabled,
			status,
			reason,
			firstSeenTimestamp: existing?.firstSeenTimestamp ?? Date.now(),
			dependencyCount: 0,
		};
		this._extensions.set(id, tracked);
		this._onDidChangeExtension.fire({ type: isEnabled ? 'enabled' : 'disabled', extensionId: id, displayName, reason });
	}

	private _evaluatePolicy(id: string): { status: ExtensionPolicyStatus; reason?: string } {
		for (const rule of this._policyRules) {
			let re: RegExp;
			try {
				const pattern = rule.pattern.replace(/\*/g, '.*');
				re = new RegExp(`^${pattern}$`, 'i');
			} catch {
				// Malformed pattern — skip this rule rather than fail-open
				console.warn(`[ExtensionTrackerService] Skipping malformed policy pattern: ${rule.pattern}`);
				continue;
			}
			if (re.test(id)) {
				return { status: rule.action === 'block' ? 'blocked' : rule.action === 'flag' ? 'flagged' : rule.action === 'require' ? 'required' : 'allowed', reason: rule.reason };
			}
		}
		return { status: 'allowed' };
	}
}

registerSingleton(IExtensionTrackerService, ExtensionTrackerService, InstantiationType.Delayed);
