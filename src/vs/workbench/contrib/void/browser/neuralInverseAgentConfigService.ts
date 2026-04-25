/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Agent Config Service \u2014 Loads and watches `.neuralinverseagent` project config.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

import {
	NeuralInverseAgentConfig,
	DEFAULT_AGENT_CONFIG,
	AGENT_CONFIG_FILENAME,
} from '../common/neuralInverseAgentConfigTypes.js';
import { ApprovalTier } from '../common/neuralInverseAgentTypes.js';


// ======================== Service Interface ========================

export interface INeuralInverseAgentConfigService {
	readonly _serviceBrand: undefined;

	/** Current merged config (defaults + project overrides) */
	readonly config: Required<NeuralInverseAgentConfig>;

	/** Fires when config file changes */
	readonly onDidChangeConfig: Event<void>;

	/** Reload config from disk */
	reload(): Promise<void>;

	/** Get approval tier override for a tool (from project config) */
	getApprovalTierOverride(toolName: string): ApprovalTier | undefined;

	/** Check if a command is allowed by project constraints */
	isCommandAllowed(command: string): boolean;
}

export const INeuralInverseAgentConfigService = createDecorator<INeuralInverseAgentConfigService>('neuralInverseAgentConfigService');


// ======================== Implementation ========================

class NeuralInverseAgentConfigService extends Disposable implements INeuralInverseAgentConfigService {
	readonly _serviceBrand: undefined;

	private _config: Required<NeuralInverseAgentConfig> = { ...DEFAULT_AGENT_CONFIG };

	private readonly _onDidChangeConfig = this._register(new Emitter<void>());
	readonly onDidChangeConfig: Event<void> = this._onDidChangeConfig.event;

	get config(): Required<NeuralInverseAgentConfig> { return this._config; }

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContext: IWorkspaceContextService,
	) {
		super();

		// Initial load
		this.reload();

		// Watch for workspace changes
		this._register(this._workspaceContext.onDidChangeWorkspaceFolders(() => {
			this.reload();
		}));

		// Watch for file changes on the config file
		this._registerFileWatcher();
	}

	async reload(): Promise<void> {
		const folders = this._workspaceContext.getWorkspace().folders;
		if (folders.length === 0) {
			this._config = { ...DEFAULT_AGENT_CONFIG };
			this._onDidChangeConfig.fire();
			return;
		}

		// Look in the first workspace folder
		const configUri = URI.joinPath(folders[0].uri, AGENT_CONFIG_FILENAME);

		try {
			const content = await this._fileService.readFile(configUri);
			const text = content.value.toString();
			const parsed = JSON.parse(text) as NeuralInverseAgentConfig;
			this._config = this._mergeWithDefaults(parsed);
		} catch {
			// File doesn't exist or is invalid \u2014 use defaults
			this._config = { ...DEFAULT_AGENT_CONFIG };
		}

		this._onDidChangeConfig.fire();
	}

	getApprovalTierOverride(toolName: string): ApprovalTier | undefined {
		return this._config.approvalTiers[toolName] as ApprovalTier | undefined;
	}

	isCommandAllowed(command: string): boolean {
		const { allowedCommands = [], blockedCommands = [] } = this._config.constraints;

		// Check blocked first
		if (blockedCommands.length > 0) {
			const cmdBase = command.trim().split(/\s+/)[0];
			if (blockedCommands.some(blocked => command.includes(blocked) || cmdBase === blocked)) {
				return false;
			}
		}

		// If allowedCommands is empty, everything (not blocked) is allowed
		if (allowedCommands.length === 0) return true;

		// Check if command starts with any allowed command
		return allowedCommands.some(allowed => command.trim().startsWith(allowed));
	}

	private _mergeWithDefaults(parsed: NeuralInverseAgentConfig): Required<NeuralInverseAgentConfig> {
		return {
			approvalTiers: { ...DEFAULT_AGENT_CONFIG.approvalTiers, ...parsed.approvalTiers },
			context: {
				alwaysInclude: parsed.context?.alwaysInclude ?? DEFAULT_AGENT_CONFIG.context.alwaysInclude,
				ignore: parsed.context?.ignore ?? DEFAULT_AGENT_CONFIG.context.ignore,
			},
			constraints: {
				maxIterations: parsed.constraints?.maxIterations ?? DEFAULT_AGENT_CONFIG.constraints.maxIterations,
				maxConcurrentSubAgents: parsed.constraints?.maxConcurrentSubAgents ?? DEFAULT_AGENT_CONFIG.constraints.maxConcurrentSubAgents,
				allowedCommands: parsed.constraints?.allowedCommands ?? DEFAULT_AGENT_CONFIG.constraints.allowedCommands,
				blockedCommands: parsed.constraints?.blockedCommands ?? DEFAULT_AGENT_CONFIG.constraints.blockedCommands,
			},
			memory: {
				persistSession: parsed.memory?.persistSession ?? DEFAULT_AGENT_CONFIG.memory.persistSession,
				maxTokenBudget: parsed.memory?.maxTokenBudget ?? DEFAULT_AGENT_CONFIG.memory.maxTokenBudget,
			},
		};
	}

	private _registerFileWatcher(): void {
		const folders = this._workspaceContext.getWorkspace().folders;
		if (folders.length === 0) return;

		const configUri = URI.joinPath(folders[0].uri, AGENT_CONFIG_FILENAME);
		try {
			const watcher = this._fileService.watch(configUri);
			this._register(watcher);
			this._register(this._fileService.onDidFilesChange(e => {
				if (e.affects(configUri)) {
					this.reload();
				}
			}));
		} catch {
			// Watching not supported \u2014 config only loads on startup/manual reload
		}
	}
}

registerSingleton(INeuralInverseAgentConfigService, NeuralInverseAgentConfigService, InstantiationType.Eager);
