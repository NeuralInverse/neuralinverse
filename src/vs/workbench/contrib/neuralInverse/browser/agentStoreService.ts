/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Agent Store Service
 *
 * Replaces the legacy AgentRegistryService (.md frontmatter).
 * Agent definitions are now stored as typed JSON in .inverse/agents/<id>.json.
 *
 * ## .inverse/ Access Rule
 *
 * READ  → IFileService.readFile() directly — no unlock needed.
 * WRITE → _withWriteAccess() — .inverse/ is write-locked by the nano agent
 *         after each cycle (chmod -R a-w .inverse). Uses ITerminalService +
 *         a status-file sentinel to make the chmod awaitable, matching the
 *         pattern used by HistoryService / ProjectAnalyzer.
 *
 * ## Agent ID
 *
 * The ID is a stable slug derived from the agent name on creation.
 * The file is named <id>.json. IDs are immutable after creation.
 *
 * ## Built-in Library
 *
 * On first open of an empty .inverse/agents/ directory, built-in agent
 * templates are auto-provisioned so the user has a ready-to-run set.
 * Built-ins are marked isBuiltin: true and can be edited in-place.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService, FileChangesEvent, FileOperationError, FileOperationResult } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IAgentDefinition } from '../common/workflowTypes.js';
import { BUILTIN_AGENTS } from './builtinLibrary.js';
/** Community edition: .inverse/ is not write-locked, so we just run the callback directly. */
const withInverseWriteAccess = async (_path: string, fn: () => Promise<void>): Promise<void> => fn();

// ─── Service Interface ────────────────────────────────────────────────────────

export const IAgentStoreService = createDecorator<IAgentStoreService>('agentStoreService');

export interface IAgentStoreService {
	readonly _serviceBrand: undefined;

	/** Fires whenever the agent list changes (create / update / delete / reload) */
	readonly onDidChange: Event<void>;

	getAgents(): IAgentDefinition[];
	getAgent(id: string): IAgentDefinition | undefined;

	createAgent(
		def: Omit<IAgentDefinition, 'id' | 'createdAt' | 'updatedAt' | 'isBuiltin'>
	): Promise<IAgentDefinition>;

	updateAgent(
		id: string,
		updates: Partial<Pick<IAgentDefinition, 'name' | 'description' | 'model' | 'systemInstructions' | 'allowedTools' | 'maxIterations' | 'tags'>>
	): Promise<void>;

	deleteAgent(id: string): Promise<void>;

	/** Write all built-in templates that don't already exist on disk */
	provisionBuiltinTemplates(): Promise<void>;
}

// ─── Implementation ───────────────────────────────────────────────────────────

const INVERSE_DIR = '.inverse';
const AGENTS_DIR = 'agents';

export class AgentStoreService extends Disposable implements IAgentStoreService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _agents = new Map<string, IAgentDefinition>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._init();
	}

	// ─── Lifecycle ──────────────────────────────────────────────────────────

	private async _init(): Promise<void> {
		await this._reload();
		this._registerWatcher();
	}

	private _registerWatcher(): void {
		this._register(this.fileService.onDidFilesChange((e: FileChangesEvent) => {
			const agentsDir = this._agentsDirUri();
			if (agentsDir && e.affects(agentsDir)) {
				this._reload();
			}
		}));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._reload();
		}));
	}

	private async _reload(): Promise<void> {
		this._agents.clear();

		const dir = this._agentsDirUri();
		if (!dir) return;

		// Ensure the directory exists (first-run provisioning)
		let dirStat;
		try {
			dirStat = await this.fileService.resolve(dir);
		} catch {
			// Directory doesn't exist — provision built-ins then reload
			await this.provisionBuiltinTemplates();
			return;
		}

		if (!dirStat.children || dirStat.children.length === 0) {
			await this.provisionBuiltinTemplates();
			return;
		}

		for (const child of dirStat.children) {
			if (!child.name.endsWith('.json')) continue;
			try {
				const raw = (await this.fileService.readFile(child.resource)).value.toString();
				const def = JSON.parse(raw) as IAgentDefinition;
				if (def.id) {
					this._agents.set(def.id, def);
				}
			} catch (e) {
				console.warn('[AgentStoreService] Failed to parse agent file', child.name, e);
			}
		}

		this._onDidChange.fire();
	}

	// ─── Helpers ────────────────────────────────────────────────────────────

	private _workspaceRootUri(): URI | undefined {
		return this.workspaceContextService.getWorkspace().folders[0]?.uri;
	}

	private _inverseDirUri(): URI | undefined {
		const root = this._workspaceRootUri();
		if (!root) return undefined;
		return URI.joinPath(root, INVERSE_DIR);
	}

	private _agentsDirUri(): URI | undefined {
		const inv = this._inverseDirUri();
		if (!inv) return undefined;
		return URI.joinPath(inv, AGENTS_DIR);
	}

	private _agentFileUri(id: string): URI | undefined {
		const dir = this._agentsDirUri();
		if (!dir) return undefined;
		return URI.joinPath(dir, `${id}.json`);
	}

	private _slugify(name: string): string {
		return name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 64) || 'agent';
	}

	// ─── Write access via shared inverseFs utility ──────────────────────────
	// .inverse/ is write-locked by the nano agent. Use the shared
	// withInverseWriteAccess utility that routes through IInverseAccessService.

	private async _write(fileUri: URI, def: IAgentDefinition): Promise<void> {
		const inversePath = this._inverseDirUri()?.fsPath;
		if (!inversePath) throw new Error('No workspace folder');

		await withInverseWriteAccess(inversePath, async () => {
			// Ensure the agents sub-directory exists before writing
			const agentsDir = this._agentsDirUri();
			if (agentsDir) {
				try { await this.fileService.createFolder(agentsDir); } catch { /* already exists */ }
			}
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(JSON.stringify(def, null, 2)));
		});
	}

	private async _deleteFile(fileUri: URI): Promise<void> {
		const inversePath = this._inverseDirUri()?.fsPath;
		if (!inversePath) throw new Error('No workspace folder');

		await withInverseWriteAccess(inversePath, async () => {
			await this.fileService.del(fileUri, { recursive: false });
		});
	}

	// ─── Public API ─────────────────────────────────────────────────────────

	getAgents(): IAgentDefinition[] {
		return [...this._agents.values()].sort((a, b) =>
			(a.createdAt ?? 0) - (b.createdAt ?? 0)
		);
	}

	getAgent(id: string): IAgentDefinition | undefined {
		return this._agents.get(id);
	}

	async createAgent(
		def: Omit<IAgentDefinition, 'id' | 'createdAt' | 'updatedAt' | 'isBuiltin'>
	): Promise<IAgentDefinition> {
		// Generate a unique ID
		let id = this._slugify(def.name);
		if (this._agents.has(id)) {
			id = `${id}-${Date.now().toString(36)}`;
		}

		const full: IAgentDefinition = {
			...def,
			id,
			isBuiltin: false,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		const fileUri = this._agentFileUri(id);
		if (!fileUri) throw new Error('No workspace folder');

		// Check for name collision
		try {
			await this.fileService.resolve(fileUri);
			throw new Error(`Agent file already exists: ${id}.json`);
		} catch (e: any) {
			// FileOperationError with FILE_NOT_FOUND is expected — anything else rethrow
			if (!(e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND)) {
				if (e.message?.includes('already exists')) throw e;
			}
		}

		await this._write(fileUri, full);
		this._agents.set(id, full);
		this._onDidChange.fire();
		return full;
	}

	async updateAgent(
		id: string,
		updates: Partial<Pick<IAgentDefinition, 'name' | 'description' | 'model' | 'systemInstructions' | 'allowedTools' | 'maxIterations' | 'tags'>>
	): Promise<void> {
		const existing = this._agents.get(id);
		if (!existing) throw new Error(`Agent "${id}" not found`);

		const updated: IAgentDefinition = { ...existing, ...updates, updatedAt: Date.now() };
		const fileUri = this._agentFileUri(id);
		if (!fileUri) throw new Error('No workspace folder');

		await this._write(fileUri, updated);
		this._agents.set(id, updated);
		this._onDidChange.fire();
	}

	async deleteAgent(id: string): Promise<void> {
		const fileUri = this._agentFileUri(id);
		if (!fileUri) throw new Error('No workspace folder');

		await this._deleteFile(fileUri);
		this._agents.delete(id);
		this._onDidChange.fire();
	}

	async provisionBuiltinTemplates(): Promise<void> {
		const dir = this._agentsDirUri();
		if (!dir) return;

		const inversePath = this._inverseDirUri()?.fsPath;
		if (!inversePath) throw new Error('No workspace folder');

		await withInverseWriteAccess(inversePath, async () => {
			// Ensure dir exists
			try {
				await this.fileService.createFolder(dir);
			} catch { /* already exists */ }

			for (const template of BUILTIN_AGENTS) {
				const fileUri = URI.joinPath(dir, `${template.id}.json`);
				try {
					// Only write if file doesn't already exist
					await this.fileService.resolve(fileUri);
				} catch {
					// File not found — write it
					try {
						await this.fileService.createFile(
							fileUri,
							VSBuffer.fromString(JSON.stringify(template, null, 2)),
							{ overwrite: false },
						);
					} catch (e) {
						console.warn('[AgentStoreService] Failed to provision built-in agent', template.id, e);
					}
				}
			}
		});

		// Reload after provisioning
		await this._reload();
	}
}

registerSingleton(IAgentStoreService, AgentStoreService, InstantiationType.Delayed);
