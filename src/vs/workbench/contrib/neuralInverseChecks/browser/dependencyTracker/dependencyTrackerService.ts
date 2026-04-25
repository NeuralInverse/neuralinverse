/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * DependencyTrackerService \u2014 scans workspace manifest files (package.json, requirements.txt,
 * go.mod, Cargo.toml, etc.), builds a dependency inventory, watches for changes, and enforces
 * policy rules (block/flag/allow) per dependency name pattern.
 *
 * Persists policy rules to `.inverse/dependency-policy.json` in workspace root.
 */

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../base/common/uri.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import {
	ITrackedDependency,
	IDependencyPolicyRule,
	IDependencyStats,
	IDependencyChangeEvent,
	DependencyEcosystem,
	DependencyStatus,
} from './dependencyTrackerTypes.js';

export const IDependencyTrackerService = createDecorator<IDependencyTrackerService>('neuralInverseDependencyTrackerService');

export interface IDependencyTrackerService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeDependencies: Event<IDependencyChangeEvent[]>;
	readonly onDidChangePolicyRules: Event<void>;

	/** Get all tracked dependencies */
	getDependencies(): ITrackedDependency[];

	/** Get stats */
	getStats(): IDependencyStats;

	/** Get current policy rules */
	getPolicyRules(): IDependencyPolicyRule[];

	/** Add a policy rule */
	addPolicyRule(rule: IDependencyPolicyRule): void;

	/** Remove a policy rule by pattern */
	removePolicyRule(pattern: string): void;

	/** Force re-scan of all workspace manifest files */
	rescan(): Promise<void>;
}

// Manifest file patterns to scan
const MANIFEST_FILES: { file: string; ecosystem: DependencyEcosystem }[] = [
	{ file: 'package.json', ecosystem: 'npm' },
	{ file: 'requirements.txt', ecosystem: 'pip' },
	{ file: 'Pipfile', ecosystem: 'pip' },
	{ file: 'pyproject.toml', ecosystem: 'pip' },
	{ file: 'go.mod', ecosystem: 'go' },
	{ file: 'Cargo.toml', ecosystem: 'cargo' },
	{ file: 'pom.xml', ecosystem: 'maven' },
	{ file: '*.csproj', ecosystem: 'nuget' },
];

const POLICY_STORAGE_KEY = 'neuralInverse.dependencyTracker.policyRules';

export class DependencyTrackerService extends Disposable implements IDependencyTrackerService {
	declare readonly _serviceBrand: undefined;

	private _dependencies: ITrackedDependency[] = [];
	private _policyRules: IDependencyPolicyRule[] = [];
	private _lastScanTimestamp = 0;

	private readonly _onDidChangeDependencies = this._register(new Emitter<IDependencyChangeEvent[]>());
	readonly onDidChangeDependencies = this._onDidChangeDependencies.event;

	private readonly _onDidChangePolicyRules = this._register(new Emitter<void>());
	readonly onDidChangePolicyRules = this._onDidChangePolicyRules.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();

		// Load persisted policy rules
		this._loadPolicyRules();

		// Watch for manifest file changes
		this._watchManifestFiles();

		// Initial scan
		this.rescan();

		console.log('[DependencyTracker] Service initialized.');
	}

	// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	public getDependencies(): ITrackedDependency[] {
		return [...this._dependencies];
	}

	public getStats(): IDependencyStats {
		const byEcosystem: Partial<Record<DependencyEcosystem, number>> = {};
		let dev = 0, prod = 0, blocked = 0, flagged = 0;

		for (const d of this._dependencies) {
			byEcosystem[d.ecosystem] = (byEcosystem[d.ecosystem] ?? 0) + 1;
			if (d.isDev) { dev++; } else { prod++; }
			if (d.status === 'blocked') { blocked++; }
			if (d.status === 'flagged') { flagged++; }
		}

		return {
			totalDependencies: this._dependencies.length,
			devDependencies: dev,
			prodDependencies: prod,
			blocked,
			flagged,
			byEcosystem,
			lastScanTimestamp: this._lastScanTimestamp,
		};
	}

	public getPolicyRules(): IDependencyPolicyRule[] {
		return [...this._policyRules];
	}

	public addPolicyRule(rule: IDependencyPolicyRule): void {
		// Replace if pattern already exists
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
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return; }

		const oldDeps = new Map(this._dependencies.map(d => [`${d.ecosystem}:${d.name}`, d]));
		const newDeps: ITrackedDependency[] = [];
		const changes: IDependencyChangeEvent[] = [];

		for (const folder of folders) {
			for (const manifest of MANIFEST_FILES) {
				if (manifest.file.includes('*')) { continue; } // Skip glob patterns for now
				const uri = URI.joinPath(folder.uri, manifest.file);
				try {
					if (await this.fileService.exists(uri)) {
						const content = await this.fileService.readFile(uri);
						const parsed = this._parseManifest(content.value.toString(), manifest.ecosystem, manifest.file);
						newDeps.push(...parsed);
					}
				} catch {
					// File doesn't exist or can't be read \u2014 skip
				}
			}
		}

		// Apply policy rules
		for (const dep of newDeps) {
			dep.status = this._evaluatePolicy(dep);
		}

		// Diff
		const newMap = new Map(newDeps.map(d => [`${d.ecosystem}:${d.name}`, d]));
		for (const [key, dep] of newMap) {
			const old = oldDeps.get(key);
			if (!old) {
				changes.push({ type: 'added', dependency: dep, sourceFile: dep.sourceFile });
			} else if (old.versionConstraint !== dep.versionConstraint) {
				changes.push({ type: 'updated', dependency: dep, sourceFile: dep.sourceFile });
			}
		}
		for (const [key, dep] of oldDeps) {
			if (!newMap.has(key)) {
				changes.push({ type: 'removed', dependency: dep, sourceFile: dep.sourceFile });
			}
		}

		this._dependencies = newDeps;
		this._lastScanTimestamp = Date.now();

		if (changes.length > 0) {
			this._onDidChangeDependencies.fire(changes);
		}

		console.log(`[DependencyTracker] Scan complete: ${newDeps.length} dependencies (${changes.length} changes)`);
	}

	// \u2500\u2500\u2500 Manifest Parsers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _parseManifest(content: string, ecosystem: DependencyEcosystem, sourceFile: string): ITrackedDependency[] {
		switch (ecosystem) {
			case 'npm': return this._parsePackageJson(content, sourceFile);
			case 'pip': return this._parsePipRequirements(content, sourceFile);
			case 'go': return this._parseGoMod(content, sourceFile);
			default: return [];
		}
	}

	private _parsePackageJson(content: string, sourceFile: string): ITrackedDependency[] {
		const deps: ITrackedDependency[] = [];
		try {
			const pkg = JSON.parse(content);

			if (pkg.dependencies) {
				for (const [name, version] of Object.entries(pkg.dependencies)) {
					deps.push({
						name, versionConstraint: String(version), isDev: false,
						ecosystem: 'npm', sourceFile, status: 'unknown',
					});
				}
			}
			if (pkg.devDependencies) {
				for (const [name, version] of Object.entries(pkg.devDependencies)) {
					deps.push({
						name, versionConstraint: String(version), isDev: true,
						ecosystem: 'npm', sourceFile, status: 'unknown',
					});
				}
			}
			if (pkg.peerDependencies) {
				for (const [name, version] of Object.entries(pkg.peerDependencies)) {
					deps.push({
						name, versionConstraint: String(version), isDev: false,
						ecosystem: 'npm', sourceFile, status: 'unknown',
					});
				}
			}
		} catch {
			// Invalid JSON \u2014 skip
		}
		return deps;
	}

	private _parsePipRequirements(content: string, sourceFile: string): ITrackedDependency[] {
		const deps: ITrackedDependency[] = [];
		for (const line of content.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) { continue; }
			// Match: package==1.0.0, package>=1.0.0, package~=1.0.0, package
			const match = trimmed.match(/^([a-zA-Z0-9._-]+)\s*([><=!~]+\s*\S+)?/);
			if (match) {
				deps.push({
					name: match[1], versionConstraint: match[2]?.trim() ?? '*',
					isDev: false, ecosystem: 'pip', sourceFile, status: 'unknown',
				});
			}
		}
		return deps;
	}

	private _parseGoMod(content: string, sourceFile: string): ITrackedDependency[] {
		const deps: ITrackedDependency[] = [];
		const lines = content.split('\n');
		let inRequire = false;

		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed === 'require (') { inRequire = true; continue; }
			if (trimmed === ')') { inRequire = false; continue; }
			if (inRequire) {
				const match = trimmed.match(/^(\S+)\s+(\S+)/);
				if (match) {
					deps.push({
						name: match[1], versionConstraint: match[2],
						isDev: false, ecosystem: 'go', sourceFile, status: 'unknown',
					});
				}
			}
		}
		return deps;
	}

	// \u2500\u2500\u2500 Policy Engine \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _evaluatePolicy(dep: ITrackedDependency): DependencyStatus {
		for (const rule of this._policyRules) {
			if (rule.ecosystems?.length && !rule.ecosystems.includes(dep.ecosystem)) {
				continue;
			}
			if (this._matchPattern(rule.pattern, dep.name)) {
				dep.reason = rule.reason;
				if (rule.action === 'block') { return 'blocked'; }
				if (rule.action === 'flag') { return 'flagged'; }
				if (rule.action === 'allow') { return 'allowed'; }
			}
		}
		return 'allowed';
	}

	private _matchPattern(pattern: string, name: string): boolean {
		if (pattern === name) { return true; }
		// Simple glob: "@scope/*" matches "@scope/anything"
		if (pattern.endsWith('*')) {
			return name.startsWith(pattern.slice(0, -1));
		}
		return false;
	}

	private _reEvaluateAll(): void {
		const changes: IDependencyChangeEvent[] = [];
		for (const dep of this._dependencies) {
			const oldStatus = dep.status;
			dep.status = this._evaluatePolicy(dep);
			if (dep.status !== oldStatus) {
				changes.push({ type: 'updated', dependency: dep, sourceFile: dep.sourceFile });
			}
		}
		if (changes.length > 0) {
			this._onDidChangeDependencies.fire(changes);
		}
	}

	// \u2500\u2500\u2500 File Watching \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _watchManifestFiles(): void {
		this._register(this.fileService.onDidFilesChange(e => {
			const folders = this.workspaceContextService.getWorkspace().folders;
			if (folders.length === 0) { return; }

			// Check if any manifest file changed
			let needsRescan = false;
			for (const folder of folders) {
				for (const manifest of MANIFEST_FILES) {
					if (manifest.file.includes('*')) { continue; }
					const manifestUri = URI.joinPath(folder.uri, manifest.file);
					if (e.contains(manifestUri)) {
						needsRescan = true;
						break;
					}
				}
				if (needsRescan) { break; }
			}

			if (needsRescan) {
				// Debounce rescan
				this._scheduleRescan();
			}
		}));
	}

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
			if (raw) {
				this._policyRules = JSON.parse(raw);
			}
		} catch {
			this._policyRules = [];
		}
	}

	private _persistPolicyRules(): void {
		this.storageService.store(
			POLICY_STORAGE_KEY,
			JSON.stringify(this._policyRules),
			StorageScope.WORKSPACE,
			StorageTarget.USER
		);
	}

	override dispose(): void {
		if (this._rescanTimer) { clearTimeout(this._rescanTimer); }
		super.dispose();
	}
}

registerSingleton(IDependencyTrackerService, DependencyTrackerService, InstantiationType.Eager);
