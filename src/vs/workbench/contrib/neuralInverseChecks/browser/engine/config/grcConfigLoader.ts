/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # GRC Config Loader
 *
 * Loads and merges GRC rules from three sources (in priority order):
 *
 * 1. **Built-in rules** (`builtinRules.ts`) — always present, the default framework
 * 2. **Framework rules** (`.inverse/frameworks/*.json`) — enterprise-imported frameworks
 * 3. **User config** (`.inverse/grc-rules.json`) — user overrides and custom rules
 *
 * ## Merge Strategy
 *
 * - Built-in rules are the base layer
 * - Framework rules are added alongside built-in rules
 * - User config can override ANY rule (built-in or framework) by matching rule ID
 * - User config can also add entirely new custom rules
 * - User config can disable framework rules via `frameworkOverrides`
 *
 * ## File Watching
 *
 * The config loader watches `.inverse/grc-rules.json` for changes and reloads
 * automatically. It also listens to `IFrameworkRegistry.onDidFrameworksChange`
 * to re-merge when frameworks are added/removed.
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IGRCConfig, IGRCRule, DEFAULT_GRC_CONFIG } from '../types/grcTypes.js';
import { IInvariantDefinition } from '../types/invariantTypes.js';
import { BUILTIN_RULES } from './builtinRules.js';
import { IFrameworkRegistry } from '../framework/frameworkRegistry.js';
import { InvariantConfigLoader } from './invariantConfigLoader.js';
import { IPolicyService } from '../../context/autocomplete/policy/policyService.js';
import { PolicyRuleGenerator } from '../services/policyRuleGenerator.js';
import { withInverseWriteAccess } from '../utils/inverseFs.js';

const GRC_FOLDER = '.inverse';
const GRC_CONFIG_FILE = 'grc-rules.json';

/**
 * Loads GRC rules from:
 * 1. Built-in rules (builtinRules.ts) - always present
 * 2. Framework rules (IFrameworkRegistry) - enterprise-imported frameworks
 * 3. User config (.inverse/grc-rules.json) - overrides/additions
 *
 * Watches the config file and framework changes, reloads automatically.
 */
export class GRCConfigLoader extends Disposable {

	private _config: IGRCConfig = DEFAULT_GRC_CONFIG;
	private _mergedRules: IGRCRule[] = [];
	private readonly _invariantLoader: InvariantConfigLoader;
	private readonly _policyRuleGenerator = new PolicyRuleGenerator();

	private readonly _onDidChange = this._register(new Emitter<void>());
	public readonly onDidChange: Event<void> = this._onDidChange.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFrameworkRegistry private readonly frameworkRegistry: IFrameworkRegistry,
		@IPolicyService private readonly policyService: IPolicyService,
	) {
		super();
		this._invariantLoader = this._register(new InvariantConfigLoader(fileService, workspaceContextService));
		this._initialize();
	}

	private async _initialize(): Promise<void> {
		await this._ensureConfigExists();
		await this._loadConfig();
		this._registerFileWatcher();
		this._registerFrameworkWatcher();
	}

	private _registerFileWatcher(): void {
		const configUri = this._getConfigUri();
		if (!configUri) {
			return;
		}

		this._register(this.fileService.onDidFilesChange(e => {
			if (e.contains(configUri)) {
				console.log('[GRCConfigLoader] Config file changed, reloading...');
				this._loadConfig();
			}
		}));
	}

	/**
	 * Re-merge rules whenever frameworks change.
	 *
	 * When an enterprise adds, removes, or modifies a framework file,
	 * the registry fires onDidFrameworksChange. We re-merge to include
	 * or exclude those framework rules.
	 */
	private _registerFrameworkWatcher(): void {
		this._register(this.frameworkRegistry.onDidFrameworksChange(() => {
			console.log('[GRCConfigLoader] Frameworks changed, re-merging rules...');
			this._mergedRules = this._mergeRules();
			this._onDidChange.fire();
		}));

		this._register(this._invariantLoader.onDidChange(() => {
			console.log('[GRCConfigLoader] Invariants changed, re-merging rules...');
			this._mergedRules = this._mergeRules();
			this._onDidChange.fire();
		}));

		this._register(this.policyService.onDidChangePolicy(() => {
			console.log('[GRCConfigLoader] Policy changed, re-merging rules...');
			this._mergedRules = this._mergeRules();
			this._onDidChange.fire();
		}));
	}

	private _getConfigUri(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}
		return URI.joinPath(folders[0].uri, GRC_FOLDER, GRC_CONFIG_FILE);
	}

	private async _ensureConfigExists(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return;
		}

		const rootUri = folders[0].uri;
		const folderUri = URI.joinPath(rootUri, GRC_FOLDER);
		const configUri = URI.joinPath(folderUri, GRC_CONFIG_FILE);

		try {
			if (!(await this.fileService.exists(configUri))) {
				await withInverseWriteAccess(folderUri.fsPath, async () => {
					try {
						if (!(await this.fileService.exists(folderUri))) {
							await this.fileService.createFolder(folderUri);
						}
					} catch { /* Folder may already exist */ }
					const content = VSBuffer.fromString(JSON.stringify(DEFAULT_GRC_CONFIG, null, 4));
					await this.fileService.createFile(configUri, content);
					console.log('[GRCConfigLoader] Created default GRC config file');
				});
			}
		} catch (e) {
			console.error('[GRCConfigLoader] Failed to ensure config file exists:', e);
		}
	}

	private async _loadConfig(): Promise<void> {
		const configUri = this._getConfigUri();
		if (!configUri) {
			this._mergedRules = [...BUILTIN_RULES];
			return;
		}

		try {
			const exists = await this.fileService.exists(configUri);
			if (!exists) {
				this._config = DEFAULT_GRC_CONFIG;
				this._mergedRules = this._mergeRules();
				this._onDidChange.fire();
				return;
			}

			const content = await this.fileService.readFile(configUri);
			const json = content.value.toString();
			this._config = JSON.parse(json) as IGRCConfig;
			console.log('[GRCConfigLoader] Loaded GRC config with', this._config.rules.length, 'user rules');

		} catch (e) {
			console.error('[GRCConfigLoader] Failed to load config, using defaults:', e);
			this._config = DEFAULT_GRC_CONFIG;
		}

		// Merge: built-in + framework + user overrides
		this._mergedRules = this._mergeRules();
		this._onDidChange.fire();
	}

	/**
	 * Merges rules from all three sources:
	 *
	 * 1. Start with built-in rules
	 * 2. Add framework rules (from IFrameworkRegistry)
	 * 3. Apply user overrides (from .inverse/grc-rules.json)
	 *
	 * User rules can:
	 * - Override any built-in or framework rule by ID (change severity, disable, etc.)
	 * - Add entirely new custom rules
	 * - Use frameworkOverrides to disable specific framework rules
	 */
	private _mergeRules(): IGRCRule[] {
		const merged: IGRCRule[] = [];
		const userRulesById = new Map<string, IGRCRule>();

		// Index user rules by ID for override lookup
		for (const rule of this._config.rules) {
			userRulesById.set(rule.id, rule);
		}

		// Get framework overrides from config
		const frameworkOverrides = this._config.frameworkOverrides ?? {};

		// ── Layer 1: Built-in rules ──────────────────────────────────────
		for (const builtin of BUILTIN_RULES) {
			const userOverride = userRulesById.get(builtin.id);
			if (userOverride) {
				// User overrides the built-in: merge, keeping builtin flag
				merged.push({
					...builtin,
					...userOverride,
					builtin: true // Cannot remove builtin flag
				});
				userRulesById.delete(builtin.id);
			} else {
				merged.push({ ...builtin });
			}
		}

		// ── Layer 2: Framework rules ─────────────────────────────────────
		const frameworkRules = this.frameworkRegistry.getAllFrameworkRules();
		for (const fwRule of frameworkRules) {
			// Skip if a built-in rule already exists with this ID
			// (built-in takes precedence)
			if (merged.some(r => r.id === fwRule.id)) {
				continue;
			}

			// Check framework-level overrides
			const fwOverrides = fwRule.frameworkId ? frameworkOverrides[fwRule.frameworkId] : undefined;

			// Check if rule is disabled via frameworkOverrides
			if (fwOverrides?.disabledRules?.includes(fwRule.id)) {
				merged.push({ ...fwRule, enabled: false });
				continue;
			}

			// Check if severity is overridden
			let severityOverride: string | undefined;
			if (fwOverrides?.severityOverrides?.[fwRule.id]) {
				severityOverride = fwOverrides.severityOverrides[fwRule.id];
			}

			// Check if user has a direct rule override
			const userOverride = userRulesById.get(fwRule.id);
			if (userOverride) {
				merged.push({
					...fwRule,
					...userOverride,
					frameworkId: fwRule.frameworkId, // Preserve framework origin
					builtin: false,
				});
				userRulesById.delete(fwRule.id);
			} else if (severityOverride) {
				merged.push({
					...fwRule,
					severity: severityOverride,
				});
			} else {
				merged.push({ ...fwRule });
			}
		}

		// ── Layer 2.5: Invariant rules ──────────────────────────────────
		const invariantRules = this._invariantLoader.toGRCRules();
		for (const invRule of invariantRules) {
			if (!merged.some(r => r.id === invRule.id)) {
				merged.push(invRule);
			}
		}

		// ── Layer 2.75: Policy rules ────────────────────────────────────
		const policy = this.policyService.getPolicy();
		if (policy) {
			const policyRules = this._policyRuleGenerator.generateRules(policy);
			for (const pRule of policyRules) {
				// User rules can override policy rules by ID
				const userOverride = userRulesById.get(pRule.id);
				if (userOverride) {
					merged.push({ ...pRule, ...userOverride });
					userRulesById.delete(pRule.id);
				} else if (!merged.some(r => r.id === pRule.id)) {
					merged.push(pRule);
				}
			}
		}

		// ── Layer 3: Remaining user-defined rules (custom, non-override) ─
		for (const [, userRule] of userRulesById) {
			merged.push({
				...userRule,
				builtin: false
			});
		}

		console.log(
			`[GRCConfigLoader] Merged rules: ${BUILTIN_RULES.length} built-in + ` +
			`${frameworkRules.length} framework + ${this._config.rules.length} user \u2192 ` +
			`${merged.length} total (${merged.filter(r => r.enabled).length} enabled)`
		);

		return merged;
	}

	/**
	 * Get all merged rules (built-in + framework + user overrides + user additions).
	 */
	public getRules(): IGRCRule[] {
		return this._mergedRules;
	}

	/**
	 * Get the current config settings.
	 */
	public getSettings(): IGRCConfig['settings'] {
		return this._config.settings;
	}

	/**
	 * Force a reload of the config from disk.
	 */
	public async reload(): Promise<void> {
		await this._loadConfig();
	}


	// ─── Invariant Management (pass-through) ──────────────────────────

	public getInvariants(): IInvariantDefinition[] {
		return this._invariantLoader.getInvariants();
	}

	public async saveInvariant(invariant: IInvariantDefinition): Promise<void> {
		await this._invariantLoader.saveInvariant(invariant);
	}

	public async deleteInvariant(id: string): Promise<void> {
		await this._invariantLoader.deleteInvariant(id);
	}

	public async toggleInvariant(id: string, enabled: boolean): Promise<void> {
		await this._invariantLoader.toggleInvariant(id, enabled);
	}

	// ─── Write Methods (for UI console) ──────────────────────────────

	/**
	 * Add or update a rule in the user config.
	 * For built-in rules, this creates an override entry.
	 */
	public async saveRule(rule: IGRCRule): Promise<void> {
		const idx = this._config.rules.findIndex(r => r.id === rule.id);
		if (idx >= 0) {
			this._config.rules[idx] = { ...rule, builtin: undefined } as IGRCRule;
		} else {
			this._config.rules.push({ ...rule, builtin: undefined } as IGRCRule);
		}
		await this._persistConfig();
	}

	/**
	 * Toggle enable/disable for a rule.
	 */
	public async toggleRule(ruleId: string, enabled: boolean): Promise<void> {
		const existing = this._config.rules.find(r => r.id === ruleId);
		if (existing) {
			existing.enabled = enabled;
		} else {
			// Create override entry for built-in or framework rule
			this._config.rules.push({ id: ruleId, enabled } as IGRCRule);
		}
		await this._persistConfig();
	}

	/**
	 * Delete a user-defined rule. Built-in rules cannot be deleted (only disabled).
	 */
	public async deleteRule(ruleId: string): Promise<void> {
		this._config.rules = this._config.rules.filter(r => r.id !== ruleId);
		await this._persistConfig();
	}

	/**
	 * Write the current config back to .inverse/grc-rules.json
	 */
	private async _persistConfig(): Promise<void> {
		const configUri = this._getConfigUri();
		if (!configUri) {
			return;
		}

		const inversePath = URI.joinPath(this.workspaceContextService.getWorkspace().folders[0].uri, GRC_FOLDER).fsPath;
		try {
			const json = JSON.stringify(this._config, null, 4);
			const buffer = VSBuffer.fromString(json);
			await withInverseWriteAccess(inversePath, async () => {
				await this.fileService.writeFile(configUri, buffer);
			});
			console.log('[GRCConfigLoader] Config saved');
			// Reload to re-merge rules
			await this._loadConfig();
		} catch (e) {
			console.error('[GRCConfigLoader] Failed to save config:', e);
		}
	}
}
