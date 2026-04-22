/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Framework Registry Service
 *
 * The `IFrameworkRegistry` is the core service that makes Neural Inverse a
 * **framework-agnostic GRC platform**. It loads, validates, indexes, and
 * serves compliance frameworks that enterprises import.
 *
 * ## How It Works
 *
 * 1. On workspace open, scans `.inverse/frameworks/` for JSON files
 * 2. Validates each file against the framework schema
 * 3. Converts framework rules into the engine's `IGRCRule` format
 * 4. Indexes rules by category/domain for fast lookup
 * 5. Watches for file changes — add/remove/modify frameworks live
 *
 * ## Usage
 *
 * ```typescript
 * // Get all active frameworks
 * const frameworks = frameworkRegistry.getActiveFrameworks();
 *
 * // Get rules for a specific category
 * const securityRules = frameworkRegistry.getRulesForCategory('security');
 *
 * // Get all rules from all frameworks
 * const allRules = frameworkRegistry.getAllFrameworkRules();
 *
 * // Listen for framework changes
 * frameworkRegistry.onDidFrameworksChange(() => { re-evaluate... });
 * ```
 *
 * ## File Location
 *
 *   {workspace}/.inverse/frameworks/{name}.json
 *
 * The `.inverse/frameworks/` directory is created automatically on first load.
 */

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Event, Emitter } from '../../../../../../base/common/event.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import {
	IFrameworkDefinition,
	IFrameworkValidationResult,
	validateFramework
} from './frameworkSchema.js';
import { IGRCRule, GRCRuleType, toDisplaySeverity } from '../types/grcTypes.js';
import { withInverseWriteAccess } from '../utils/inverseFs.js';
import { BUILTIN_FRAMEWORK, BUILTIN_RULES } from '../config/builtinRules.js';


// ─── Service Interface ───────────────────────────────────────────────────────

export const IFrameworkRegistry = createDecorator<IFrameworkRegistry>('neuralInverseFrameworkRegistry');

/**
 * Service that manages imported compliance frameworks.
 *
 * Frameworks are loaded from `.inverse/frameworks/*.json` on workspace open.
 * The registry validates, indexes, and serves framework data to the GRC engine
 * and UI components.
 */
export interface IFrameworkRegistry {
	readonly _serviceBrand: undefined;

	/**
	 * Fired when frameworks are loaded, added, removed, or modified.
	 * Consumers (like the GRC engine) should re-evaluate when this fires.
	 */
	readonly onDidFrameworksChange: Event<void>;

	/** Get all successfully loaded frameworks */
	getActiveFrameworks(): ILoadedFramework[];

	/** Get a specific framework by its ID */
	getFrameworkById(id: string): ILoadedFramework | undefined;

	/**
	 * Get all rules from all frameworks, converted to IGRCRule format.
	 * These are ready to be merged into the GRC engine's rule set.
	 */
	getAllFrameworkRules(): IGRCRule[];

	/**
	 * Get rules from all frameworks that belong to a specific category/domain.
	 * e.g. getRulesForCategory('security') returns all security rules from all frameworks.
	 */
	getRulesForCategory(category: string): IGRCRule[];

	/**
	 * Get all unique categories defined across all loaded frameworks.
	 * Includes both built-in domains and custom framework categories.
	 */
	getAllCategories(): string[];

	/**
	 * Get validation results for a specific framework.
	 * Useful for showing errors/warnings in the Checks Manager UI.
	 */
	getValidationResult(frameworkId: string): IFrameworkValidationResult | undefined;

	/**
	 * Force reload all frameworks from disk.
	 */
	reload(): Promise<void>;

	/**
	 * Import a framework from a JSON string.
	 * Validates the JSON, writes to `.inverse/frameworks/{id}.json`, and reloads.
	 * Returns the validation result so callers can display errors.
	 */
	importFramework(json: string): Promise<IFrameworkValidationResult>;

	/**
	 * Remove a framework by ID. Deletes the file from `.inverse/frameworks/` and reloads.
	 */
	removeFramework(id: string): Promise<void>;
}


// ─── Loaded Framework ────────────────────────────────────────────────────────

/**
 * A framework that has been loaded and validated from disk.
 *
 * Contains the original definition plus metadata about the loading process.
 */
export interface ILoadedFramework {
	/** The parsed framework definition */
	definition: IFrameworkDefinition;

	/** URI of the source file */
	sourceUri: URI;

	/** Validation result (may have warnings even if valid) */
	validation: IFrameworkValidationResult;

	/** When this framework was last loaded */
	loadedAt: number;

	/** The framework's rules converted to IGRCRule format */
	rules: IGRCRule[];
}


// ─── Constants ───────────────────────────────────────────────────────────────

const FRAMEWORKS_FOLDER = '.inverse';
const FRAMEWORKS_SUBFOLDER = 'frameworks';


// ─── Implementation ──────────────────────────────────────────────────────────

export class FrameworkRegistry extends Disposable implements IFrameworkRegistry {
	declare readonly _serviceBrand: undefined;

	/** Map of framework ID → loaded framework */
	private _frameworks = new Map<string, ILoadedFramework>();

	/** Map of framework ID → validation result (includes failed frameworks) */
	private _validationResults = new Map<string, IFrameworkValidationResult>();

	/** Index: category → rule IDs for fast lookup */
	private _categoryIndex = new Map<string, Set<string>>();

	/** All framework rules converted to IGRCRule, keyed by rule ID */
	private _allRules = new Map<string, IGRCRule>();

	private readonly _onDidFrameworksChange = this._register(new Emitter<void>());
	public readonly onDidFrameworksChange = this._onDidFrameworksChange.event;

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._initialize();
	}


	// ─── Initialization ──────────────────────────────────────────────────

	private async _initialize(): Promise<void> {
		await this._ensureFrameworksDirExists();
		await this._loadAllFrameworks();
		this._registerFileWatcher();
	}

	/**
	 * Creates the `.inverse/frameworks/` directory if it doesn't exist.
	 * Also creates a README.md explaining the format.
	 */

	/**
	 * Returns the URI of the `.inverse` root directory.
	 */
	private _getInverseDir(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}
		return URI.joinPath(folders[0].uri, FRAMEWORKS_FOLDER);
	}

	private async _ensureFrameworksDirExists(): Promise<void> {
		const frameworksUri = this._getFrameworksDir();
		if (!frameworksUri) {
			return;
		}

		const inverseDir = this._getInverseDir();
		try {
			if (!(await this.fileService.exists(frameworksUri))) {
				await withInverseWriteAccess(inverseDir?.fsPath ?? frameworksUri.fsPath, async () => {
					await this.fileService.createFolder(frameworksUri);

					// Create a README explaining the format
					const readmePath = URI.joinPath(frameworksUri, 'README.md');
					const readmeContent = [
						'# GRC Compliance Frameworks',
						'',
						'Place your compliance framework JSON files in this directory.',
						'The Neural Inverse IDE will automatically load and enforce them.',
						'',
						'## Format',
						'',
						'Each `.json` file must follow the framework schema:',
						'',
						'```json',
						'{',
						'  "framework": {',
						'    "id": "your-framework-id",',
						'    "name": "Your Framework Name",',
						'    "version": "1.0.0",',
						'    "appliesTo": ["typescript", "javascript"]',
						'  },',
						'  "rules": [',
						'    {',
						'      "id": "RULE-001",',
						'      "title": "Rule Title",',
						'      "severity": "error",',
						'      "category": "security",',
						'      "check": { "type": "regex", "pattern": "\\\\beval\\\\s*\\\\(" },',
						'      "fix": "Suggested fix",',
						'      "references": ["CWE-94"]',
						'    }',
						'  ]',
						'}',
						'```',
						'',
						'## Check Types',
						'',
						'- `regex` — Pattern matching per line',
						'- `ast` — TypeScript AST structural analysis',
						'- `dataflow` — Taint tracking (source → sink)',
						'- `import-graph` — Architecture-level checks',
						'- `external` — Delegate to any CLI tool',
						'- `file-level` — File-level checks (max lines, headers)',
						'',
						'## Live Reload',
						'',
						'Changes to framework files take effect immediately. No IDE restart needed.',
						''
					].join('\n');

					await this.fileService.createFile(readmePath, VSBuffer.fromString(readmeContent));
					console.log('[FrameworkRegistry] Created frameworks directory with README');
				});  // end withInverseWriteAccess
			}
		} catch (e) {
			console.error('[FrameworkRegistry] Failed to create frameworks directory:', e);
		}
	}


	// ─── File Watching ───────────────────────────────────────────────────

	/**
	 * Watches `.inverse/frameworks/` for changes.
	 * Any add/modify/delete of a .json file triggers a full reload.
	 */
	private _registerFileWatcher(): void {
		const frameworksUri = this._getFrameworksDir();
		if (!frameworksUri) {
			return;
		}

		this._register(this.fileService.onDidFilesChange(e => {
			// Check if any changed file is in the frameworks directory
			if (e.affects(frameworksUri)) {
				console.log('[FrameworkRegistry] Framework files changed, reloading...');
				this._loadAllFrameworks();
			}
		}));
	}


	// ─── Loading ─────────────────────────────────────────────────────────

	/**
	 * Loads all framework JSON files from `.inverse/frameworks/`.
	 *
	 * For each file:
	 * 1. Read and parse JSON
	 * 2. Validate against schema
	 * 3. If valid, convert rules to IGRCRule format and index
	 * 4. If invalid, store validation errors for the UI to display
	 */
	private async _loadAllFrameworks(): Promise<void> {
		const frameworksUri = this._getFrameworksDir();
		if (!frameworksUri) {
			return;
		}

		// Clear previous state
		this._frameworks.clear();
		this._validationResults.clear();
		this._categoryIndex.clear();
		this._allRules.clear();

		// Always register the built-in framework first so the UI always has at least one framework
		const builtinLoaded: ILoadedFramework = {
			definition: BUILTIN_FRAMEWORK,
			sourceUri: URI.parse('builtin://neural-inverse-builtin'),
			validation: { valid: true, errors: [], warnings: [] },
			loadedAt: Date.now(),
			rules: BUILTIN_RULES,
		};
		this._frameworks.set(BUILTIN_FRAMEWORK.framework.id, builtinLoaded);
		for (const rule of BUILTIN_RULES) {
			this._allRules.set(rule.id, rule);
			if (!this._categoryIndex.has(rule.domain)) {
				this._categoryIndex.set(rule.domain, new Set());
			}
			this._categoryIndex.get(rule.domain)!.add(rule.id);
		}

		try {
			const exists = await this.fileService.exists(frameworksUri);
			if (!exists) {
				this._onDidFrameworksChange.fire();
				return;
			}

			const stat = await this.fileService.resolve(frameworksUri);
			if (!stat.children) {
				this._onDidFrameworksChange.fire();
				return;
			}

			// Load each JSON file
			for (const child of stat.children) {
				if (child.isDirectory || !child.name.endsWith('.json')) {
					continue;
				}

				await this._loadSingleFramework(child.resource);
			}

			console.log(
				`[FrameworkRegistry] Loaded ${this._frameworks.size} framework(s), ` +
				`${this._allRules.size} total rules across ${this._categoryIndex.size} categories`
			);

		} catch (e) {
			console.error('[FrameworkRegistry] Failed to scan frameworks directory:', e);
		}

		this._onDidFrameworksChange.fire();
	}

	/**
	 * Loads a single framework file from disk.
	 */
	private async _loadSingleFramework(uri: URI): Promise<void> {
		try {
			const content = await this.fileService.readFile(uri);
			const jsonStr = content.value.toString();
			let parsed: unknown;

			try {
				parsed = JSON.parse(jsonStr);
			} catch (parseError: any) {
				const result: IFrameworkValidationResult = {
					valid: false,
					errors: [`JSON parse error: ${parseError.message}`],
					warnings: []
				};
				// Use filename as key if we can't get framework ID
				this._validationResults.set(uri.path, result);
				console.warn(`[FrameworkRegistry] Invalid JSON in ${uri.path}:`, parseError.message);
				return;
			}

			// Validate against schema
			const validation = validateFramework(parsed);
			const definition = parsed as IFrameworkDefinition;
			const frameworkId = definition.framework?.id || uri.path;

			this._validationResults.set(frameworkId, validation);

			if (!validation.valid) {
				console.warn(
					`[FrameworkRegistry] Framework "${frameworkId}" has validation errors:`,
					validation.errors
				);
				return;
			}

			if (validation.warnings.length > 0) {
				console.info(
					`[FrameworkRegistry] Framework "${frameworkId}" has warnings:`,
					validation.warnings
				);
			}

			// Convert framework rules to IGRCRule format
			const convertedRules = this._convertFrameworkRules(definition);

			// Store the loaded framework
			const loaded: ILoadedFramework = {
				definition,
				sourceUri: uri,
				validation,
				loadedAt: Date.now(),
				rules: convertedRules
			};

			this._frameworks.set(frameworkId, loaded);

			// Index rules
			for (const rule of convertedRules) {
				this._allRules.set(rule.id, rule);

				if (!this._categoryIndex.has(rule.domain)) {
					this._categoryIndex.set(rule.domain, new Set());
				}
				this._categoryIndex.get(rule.domain)!.add(rule.id);
			}

			console.log(
				`[FrameworkRegistry] Loaded framework "${definition.framework.name}" ` +
				`v${definition.framework.version} with ${convertedRules.length} rules`
			);

		} catch (e) {
			console.error(`[FrameworkRegistry] Failed to load framework from ${uri.path}:`, e);
		}
	}


	// ─── Rule Conversion ─────────────────────────────────────────────────

	/**
	 * Converts a framework's rules from the import format (IFrameworkRule)
	 * to the engine's internal format (IGRCRule).
	 *
	 * This is the bridge between "what the enterprise defines" and
	 * "what the engine can execute."
	 */
	private _convertFrameworkRules(definition: IFrameworkDefinition): IGRCRule[] {
		const frameworkId = definition.framework.id;
		const severityLevels = definition.framework.severityLevels;
		const rules: IGRCRule[] = [];

		for (const fwRule of definition.rules) {
			// Determine the rule type from the check definition
			const ruleType: GRCRuleType = fwRule.check.type as GRCRuleType;

			// Determine blocking behavior from framework severity levels
			let blockingBehavior: { blocksCommit: boolean; blocksDeploy: boolean } | undefined;
			if (severityLevels && severityLevels[fwRule.severity]) {
				blockingBehavior = {
					blocksCommit: severityLevels[fwRule.severity].blocksCommit,
					blocksDeploy: severityLevels[fwRule.severity].blocksDeploy,
				};
			}

			// Extract pattern for regex-type rules (backward compat with engine)
			let pattern = '';
			if (fwRule.check.type === 'regex') {
				pattern = (fwRule.check as any).pattern || '';
			}

			const converted: IGRCRule = {
				id: fwRule.id,
				domain: fwRule.category,
				severity: toDisplaySeverity(fwRule.severity),
				pattern: pattern,
				message: fwRule.title + (fwRule.description ? ` — ${fwRule.description}` : ''),
				fix: fwRule.fix,
				description: fwRule.description || undefined,
				enabled: fwRule.enabled !== false, // Default: enabled
				builtin: false,
				type: ruleType,
				check: fwRule.check,
				frameworkId: frameworkId,
				references: fwRule.references,
				tags: fwRule.tags,
				blockingBehavior: blockingBehavior,
			};

			rules.push(converted);
		}

		return rules;
	}


	// ─── Public API ──────────────────────────────────────────────────────

	public getActiveFrameworks(): ILoadedFramework[] {
		return Array.from(this._frameworks.values());
	}

	public getFrameworkById(id: string): ILoadedFramework | undefined {
		return this._frameworks.get(id);
	}

	public getAllFrameworkRules(): IGRCRule[] {
		return Array.from(this._allRules.values());
	}

	public getRulesForCategory(category: string): IGRCRule[] {
		const ruleIds = this._categoryIndex.get(category);
		if (!ruleIds) {
			return [];
		}
		return Array.from(ruleIds)
			.map(id => this._allRules.get(id))
			.filter((r): r is IGRCRule => r !== undefined);
	}

	public getAllCategories(): string[] {
		return Array.from(this._categoryIndex.keys());
	}

	public getValidationResult(frameworkId: string): IFrameworkValidationResult | undefined {
		return this._validationResults.get(frameworkId);
	}

	public async reload(): Promise<void> {
		await this._loadAllFrameworks();
	}


	/**
	 * Import a framework from a JSON string.
	 * Validates, writes to disk, and reloads.
	 */
	public async importFramework(json: string): Promise<IFrameworkValidationResult> {
		// 1. Parse JSON
		let parsed: IFrameworkDefinition;
		try {
			parsed = JSON.parse(json);
		} catch (e) {
			return {
				valid: false,
				errors: [`Invalid JSON: ${(e as Error).message}`],
				warnings: []
			};
		}

		// 2. Validate against schema
		const validation = validateFramework(parsed);
		if (!validation.valid) {
			return validation;
		}

		// 3. Determine file path
		const frameworkId = parsed.framework?.id;
		if (!frameworkId) {
			return {
				valid: false,
				errors: ['Framework must have a framework.id field'],
				warnings: []
			};
		}

		const frameworksDir = this._getFrameworksDir();
		if (!frameworksDir) {
			return {
				valid: false,
				errors: ['No workspace open — cannot write framework file'],
				warnings: []
			};
		}

		// 4. Unlock .inverse, ensure directory exists, and write file
		const inverseUri = this._getInverseDir();
		if (!inverseUri) {
			return { valid: false, errors: ['Cannot resolve .inverse directory'], warnings: [] };
		}
		try {
			const fileName = `${frameworkId}.json`;
			const fileUri = URI.joinPath(frameworksDir, fileName);
			const buffer = VSBuffer.fromString(JSON.stringify(parsed, null, 2));
			await withInverseWriteAccess(inverseUri.fsPath, async () => {
				if (!(await this.fileService.exists(frameworksDir))) {
					await this.fileService.createFolder(frameworksDir);
				}
				await this.fileService.writeFile(fileUri, buffer);
			});
			console.log(`[FrameworkRegistry] Imported framework: ${frameworkId} → ${fileUri.path}`);
		} catch (e) {
			return {
				valid: false,
				errors: [`Failed to write file: ${(e as Error).message}`],
				warnings: []
			};
		}

		// 5. Reload all frameworks
		await this._loadAllFrameworks();

		return validation;
	}

	public async removeFramework(id: string): Promise<void> {
		const frameworksDir = this._getFrameworksDir();
		const inverseUri = this._getInverseDir();
		if (!frameworksDir || !inverseUri) return;

		const fileUri = URI.joinPath(frameworksDir, `${id}.json`);
		try {
			await withInverseWriteAccess(inverseUri.fsPath, async () => {
				if (await this.fileService.exists(fileUri)) {
					await this.fileService.del(fileUri);
				}
			});
			await this._loadAllFrameworks();
		} catch (e) {
			console.error(`[FrameworkRegistry] Failed to remove framework ${id}:`, e);
		}
	}




	// ─── Helpers ─────────────────────────────────────────────────────────

	/**
	 * Returns the URI of the `.inverse / frameworks / ` directory,
	 * or undefined if no workspace is open.
	 */
	private _getFrameworksDir(): URI | undefined {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return undefined;
		}
		return URI.joinPath(folders[0].uri, FRAMEWORKS_FOLDER, FRAMEWORKS_SUBFOLDER);
	}
}


// ─── Registration ────────────────────────────────────────────────────────────

registerSingleton(IFrameworkRegistry, FrameworkRegistry, InstantiationType.Eager);
