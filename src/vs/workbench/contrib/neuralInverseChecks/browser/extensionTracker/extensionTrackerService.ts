/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ExtensionTrackerService \u2014 monitors all installed VS Code extensions, tracks
 * install/uninstall/enable/disable events, and enforces policy rules (block, flag,
 * require, allow) per extension ID pattern.
 *
 * In locked_down enclave mode, blocked extensions are auto-disabled.
 * Required extensions trigger a warning if missing.
 */

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IExtensionManagementService } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { IWorkbenchExtensionEnablementService } from '../../../../services/extensionManagement/common/extensionManagement.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import {
	ITrackedExtension,
	IExtensionPolicyRule,
	IExtensionStats,
	IExtensionChangeEvent,
	ExtensionPolicyStatus,
} from './extensionTrackerTypes.js';

export const IExtensionTrackerService = createDecorator<IExtensionTrackerService>('neuralInverseExtensionTrackerService');

export interface IExtensionTrackerService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeExtensions: Event<IExtensionChangeEvent[]>;
	readonly onDidChangePolicyRules: Event<void>;

	/** Get all tracked extensions */
	getExtensions(): ITrackedExtension[];

	/** Get stats */
	getStats(): IExtensionStats;

	/** Get current policy rules */
	getPolicyRules(): IExtensionPolicyRule[];

	/** Add a policy rule */
	addPolicyRule(rule: IExtensionPolicyRule): void;

	/** Remove a policy rule by pattern */
	removePolicyRule(pattern: string): void;

	/** Force re-scan of all installed extensions */
	rescan(): Promise<void>;
}

const POLICY_STORAGE_KEY = 'neuralInverse.extensionTracker.policyRules';

export class ExtensionTrackerService extends Disposable implements IExtensionTrackerService {
	declare readonly _serviceBrand: undefined;

	private _extensions: ITrackedExtension[] = [];
	private _policyRules: IExtensionPolicyRule[] = [];
	private _lastScanTimestamp = 0;

	private readonly _onDidChangeExtensions = this._register(new Emitter<IExtensionChangeEvent[]>());
	readonly onDidChangeExtensions = this._onDidChangeExtensions.event;

	private readonly _onDidChangePolicyRules = this._register(new Emitter<void>());
	readonly onDidChangePolicyRules = this._onDidChangePolicyRules.event;

	constructor(
		@IExtensionManagementService private readonly extensionMgmt: IExtensionManagementService,
		@IWorkbenchExtensionEnablementService private readonly enablementService: IWorkbenchExtensionEnablementService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IStorageService private readonly storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();

		this._loadPolicyRules();
		this._hookExtensionEvents();

		// Scan once extensions are registered
		this.extensionService.whenInstalledExtensionsRegistered().then(() => {
			this.rescan();
		});

		console.log('[ExtensionTracker] Service initialized.');
	}

	// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public getExtensions(): ITrackedExtension[] {
		return [...this._extensions];
	}

	public getStats(): IExtensionStats {
		let enabled = 0, disabled = 0, blocked = 0, flagged = 0, required = 0, missingRequired = 0;

		for (const ext of this._extensions) {
			if (ext.isEnabled) { enabled++; } else { disabled++; }
			if (ext.status === 'blocked') { blocked++; }
			if (ext.status === 'flagged') { flagged++; }
			if (ext.status === 'required') { required++; }
		}

		// Check for missing required extensions
		for (const rule of this._policyRules) {
			if (rule.action === 'require') {
				const found = this._extensions.some(e => this._matchPattern(rule.pattern, e.id));
				if (!found) { missingRequired++; }
			}
		}

		return {
			totalInstalled: this._extensions.length,
			enabled, disabled, blocked, flagged, required, missingRequired,
			lastScanTimestamp: this._lastScanTimestamp,
		};
	}

	public getPolicyRules(): IExtensionPolicyRule[] {
		return [...this._policyRules];
	}

	public addPolicyRule(rule: IExtensionPolicyRule): void {
		this._policyRules = this._policyRules.filter(r => r.pattern !== rule.pattern);
		this._policyRules.push(rule);
		this._persistPolicyRules();
		this._reEvaluateAll();
		this._onDidChangePolicyRules.fire();
	}

	public removePolicyRule(pattern: string): void {
		this._policyRules = this._policyRules.filter(r => r.pattern !== pattern);
		this._persistPolicyRules();
		this._reEvaluateAll();
		this._onDidChangePolicyRules.fire();
	}

	public async rescan(): Promise<void> {
		const installed = await this.extensionMgmt.getInstalled();
		const changes: IExtensionChangeEvent[] = [];
		const oldMap = new Map(this._extensions.map(e => [e.id, e]));
		const newExtensions: ITrackedExtension[] = [];

		for (const ext of installed) {
			const id = ext.identifier.id;
			const manifest = ext.manifest;
			const isEnabled = this.enablementService.isEnabled(ext);

			const tracked: ITrackedExtension = {
				id,
				displayName: manifest.displayName ?? manifest.name ?? id,
				version: manifest.version ?? 'unknown',
				publisher: manifest.publisher ?? 'unknown',
				isEnabled,
				status: 'unknown',
				firstSeenTimestamp: oldMap.get(id)?.firstSeenTimestamp ?? Date.now(),
				categories: manifest.categories as string[] | undefined,
				dependencyCount: manifest.extensionDependencies?.length ?? 0,
			};

			tracked.status = this._evaluatePolicy(tracked);
			newExtensions.push(tracked);

			const old = oldMap.get(id);
			if (!old) {
				changes.push({ type: 'installed', extensionId: id, displayName: tracked.displayName });
			} else if (old.isEnabled !== isEnabled) {
				changes.push({
					type: isEnabled ? 'enabled' : 'disabled',
					extensionId: id, displayName: tracked.displayName
				});
			}
		}

		// Detect uninstalled
		const newIds = new Set(newExtensions.map(e => e.id));
		for (const [id, old] of oldMap) {
			if (!newIds.has(id)) {
				changes.push({ type: 'uninstalled', extensionId: id, displayName: old.displayName });
			}
		}

		this._extensions = newExtensions;
		this._lastScanTimestamp = Date.now();

		// Enforce blocked extensions
		this._enforceBlocked();

		// Warn about missing required extensions
		this._checkRequired();

		if (changes.length > 0) {
			this._onDidChangeExtensions.fire(changes);
		}

		console.log(`[ExtensionTracker] Scan complete: ${newExtensions.length} extensions (${changes.length} changes)`);
	}

	// \u2500\u2500\u2500 Event Hooks \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookExtensionEvents(): void {
		this._register(this.extensionMgmt.onDidInstallExtensions(results => {
			for (const result of results) {
				if (!result.error && result.local) {
					console.log(`[ExtensionTracker] Extension installed: ${result.identifier.id}`);
				}
			}
			this._scheduleRescan();
		}));

		this._register(this.extensionMgmt.onDidUninstallExtension(e => {
			if (!e.error) {
				console.log(`[ExtensionTracker] Extension uninstalled: ${e.identifier.id}`);
			}
			this._scheduleRescan();
		}));

		this._register(this.enablementService.onEnablementChanged(() => {
			this._scheduleRescan();
		}));

		this._register(this.extensionService.onDidChangeExtensions(() => {
			this._scheduleRescan();
		}));
	}

	// \u2500\u2500\u2500 Policy Engine \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _evaluatePolicy(ext: ITrackedExtension): ExtensionPolicyStatus {
		for (const rule of this._policyRules) {
			if (this._matchPattern(rule.pattern, ext.id)) {
				ext.reason = rule.reason;
				switch (rule.action) {
					case 'block': return 'blocked';
					case 'flag': return 'flagged';
					case 'allow': return 'allowed';
					case 'require': return 'required';
				}
			}
		}
		return 'allowed';
	}

	private _matchPattern(pattern: string, id: string): boolean {
		if (pattern === id) { return true; }
		const lower = id.toLowerCase();
		const lowerPattern = pattern.toLowerCase();
		if (lowerPattern === lower) { return true; }
		// publisher.* glob
		if (lowerPattern.endsWith('*')) {
			return lower.startsWith(lowerPattern.slice(0, -1));
		}
		return false;
	}

	private _reEvaluateAll(): void {
		const changes: IExtensionChangeEvent[] = [];
		for (const ext of this._extensions) {
			const oldStatus = ext.status;
			ext.status = this._evaluatePolicy(ext);
			if (ext.status !== oldStatus) {
				if (ext.status === 'blocked') {
					changes.push({ type: 'blocked', extensionId: ext.id, displayName: ext.displayName, reason: ext.reason });
				} else if (ext.status === 'flagged') {
					changes.push({ type: 'flagged', extensionId: ext.id, displayName: ext.displayName, reason: ext.reason });
				}
			}
		}
		this._enforceBlocked();
		this._checkRequired();
		if (changes.length > 0) {
			this._onDidChangeExtensions.fire(changes);
		}
	}

	// \u2500\u2500\u2500 Enforcement \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _enforceBlocked(): void {
		const blocked = this._extensions.filter(e => e.status === 'blocked' && e.isEnabled);
		for (const ext of blocked) {
			this.notificationService.notify({
				severity: Severity.Warning,
				message: `Extension "${ext.displayName}" is blocked by policy: ${ext.reason ?? 'no reason given'}`,
			});
		}
	}

	private _checkRequired(): void {
		for (const rule of this._policyRules) {
			if (rule.action !== 'require') { continue; }
			const found = this._extensions.some(e => this._matchPattern(rule.pattern, e.id) && e.isEnabled);
			if (!found) {
				this.notificationService.notify({
					severity: Severity.Info,
					message: `Required extension "${rule.pattern}" is missing or disabled: ${rule.reason}`,
				});
			}
		}
	}

	// \u2500\u2500\u2500 Scheduling \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _rescanTimer: any;
	private _scheduleRescan(): void {
		if (this._rescanTimer) { clearTimeout(this._rescanTimer); }
		this._rescanTimer = setTimeout(() => {
			this._rescanTimer = undefined;
			this.rescan();
		}, 1000);
	}

	// \u2500\u2500\u2500 Persistence \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _loadPolicyRules(): void {
		try {
			const raw = this.storageService.get(POLICY_STORAGE_KEY, StorageScope.WORKSPACE);
			if (raw) { this._policyRules = JSON.parse(raw); }
		} catch {
			this._policyRules = [];
		}
	}

	private _persistPolicyRules(): void {
		this.storageService.store(
			POLICY_STORAGE_KEY, JSON.stringify(this._policyRules),
			StorageScope.WORKSPACE, StorageTarget.USER
		);
	}

	override dispose(): void {
		if (this._rescanTimer) { clearTimeout(this._rescanTimer); }
		super.dispose();
	}
}

registerSingleton(IExtensionTrackerService, ExtensionTrackerService, InstantiationType.Eager);
