/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * EnclaveActionLogService \u2014 the central nervous system for IDE action tracking.
 *
 * Hooks into every major VS Code / Void / NeuralInverse / Checks / Power Mode
 * service event bus and funnels all actions into IEnclaveActionLogStorageService
 * for in-memory query and disk persistence.
 *
 * Categories tracked:
 *   command, editor, file, terminal, debug, configuration, lifecycle,
 *   ai (chat/settings/policy), agent (NI agent + sub-agents),
 *   checks (GRC engine, violations, checks agent, socket),
 *   powermode (sessions, tool calls, agent bus),
 *   enclave (mode, firewall, sandbox)
 */

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';

// \u2500\u2500\u2500 Platform Services \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { ILifecycleService, LifecyclePhase } from '../../../../../services/lifecycle/common/lifecycle.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { ITextFileService } from '../../../../../services/textfile/common/textfiles.js';
import { IDebugService } from '../../../../debug/common/debug.js';
import { ITerminalService } from '../../../../terminal/browser/terminal.js';

// \u2500\u2500\u2500 Void Services \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
import { IChatThreadService } from '../../../../void/browser/chatThreadServiceInterface.js';
import { IVoidSettingsService } from '../../../../void/common/voidSettingsService.js';
import { IEnterprisePolicyService } from '../../../../void/common/enterprisePolicyService.js';
import { INeuralInverseAgentService } from '../../../../void/browser/neuralInverseAgentService.js';
import { INeuralInverseSubAgentService } from '../../../../void/browser/neuralInverseSubAgentService.js';
import { INeuralInverseAgentConfigService } from '../../../../void/browser/neuralInverseAgentConfigService.js';

// \u2500\u2500\u2500 NeuralInverse Checks Services \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
import { IGRCEngineService } from '../../../../neuralInverseChecks/browser/engine/services/grcEngineService.js';
import { IChecksAgentService } from '../../../../neuralInverseChecks/browser/checksAgent/checksAgentService.js';
import { IChecksSocketService } from '../../../../neuralInverseChecks/browser/checksSocket/checksSocketService.js';
import { IExternalToolService } from '../../../../neuralInverseChecks/browser/engine/services/externalToolService.js';
import { IContractReasonService } from '../../../../neuralInverseChecks/browser/engine/services/contractReasonService.js';
import { IFrameworkRegistry } from '../../../../neuralInverseChecks/browser/engine/framework/frameworkRegistry.js';

// \u2500\u2500\u2500 Power Mode Services \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
import { IPowerModeService } from '../../../../powerMode/browser/powerModeService.js';
import { IPowerBusService } from '../../../../powerMode/browser/powerBusService.js';

// \u2500\u2500\u2500 Enclave Services \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
import { IEnclaveEnvironmentService } from '../../../common/services/environment/enclaveEnvironmentService.js';
import { IEnclaveFirewallService } from '../../../common/services/firewall/enclaveFirewallService.js';
import { IEnclaveSandboxService } from '../../../common/services/sandbox/enclaveSandboxService.js';

// \u2500\u2500\u2500 Action Log Types \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
import {
	IActionLogEntry,
	IActionLogFilter,
	IActionLogStats,
	ActionCategory,
	ActionSeverity,
	ActionSource,
} from '../../../common/services/actionLog/enclaveActionLogTypes.js';
import { IEnclaveActionLogStorageService } from '../../../common/services/actionLog/enclaveActionLogStorageService.js';

export const IEnclaveActionLogService = createDecorator<IEnclaveActionLogService>('enclaveActionLogService');

export interface IEnclaveActionLogService {
	readonly _serviceBrand: undefined;

	/** Fires for every logged action */
	readonly onDidLogAction: Event<IActionLogEntry>;

	/** Manually log a custom action (for other services to push events) */
	logAction(
		category: ActionCategory,
		action: string,
		label: string,
		source?: ActionSource,
		severity?: ActionSeverity,
		target?: string,
		metadata?: Record<string, unknown>,
		durationMs?: number
	): IActionLogEntry;

	/** Query the log */
	query(filter?: IActionLogFilter): IActionLogEntry[];

	/** Get stats */
	getStats(): IActionLogStats;

	/** Clear all logs */
	clear(): void;

	/** Force-flush to disk */
	flush(): Promise<void>;
}

export class EnclaveActionLogService extends Disposable implements IEnclaveActionLogService {
	declare readonly _serviceBrand: undefined;

	private readonly _sessionId: string;
	private readonly _onDidLogAction = this._register(new Emitter<IActionLogEntry>());
	public readonly onDidLogAction: Event<IActionLogEntry> = this._onDidLogAction.event;

	constructor(
		@IEnclaveActionLogStorageService private readonly storage: IEnclaveActionLogStorageService,
		// Platform
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IFileService private readonly fileService: IFileService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IDebugService private readonly debugService: IDebugService,
		@ITerminalService private readonly terminalService: ITerminalService,
		// Void
		@IChatThreadService private readonly chatThreadService: IChatThreadService,
		@IVoidSettingsService private readonly voidSettingsService: IVoidSettingsService,
		@IEnterprisePolicyService private readonly enterprisePolicyService: IEnterprisePolicyService,
		@INeuralInverseAgentService private readonly agentService: INeuralInverseAgentService,
		@INeuralInverseSubAgentService private readonly subAgentService: INeuralInverseSubAgentService,
		@INeuralInverseAgentConfigService private readonly agentConfigService: INeuralInverseAgentConfigService,
		// Checks
		@IGRCEngineService private readonly grcEngine: IGRCEngineService,
		@IChecksAgentService private readonly checksAgent: IChecksAgentService,
		@IChecksSocketService private readonly checksSocket: IChecksSocketService,
		@IExternalToolService private readonly externalToolService: IExternalToolService,
		@IContractReasonService private readonly contractReasonService: IContractReasonService,
		@IFrameworkRegistry private readonly frameworkRegistry: IFrameworkRegistry,
		// Power Mode
		@IPowerModeService private readonly powerModeService: IPowerModeService,
		@IPowerBusService private readonly powerBusService: IPowerBusService,
		// Enclave
		@IEnclaveEnvironmentService private readonly enclaveEnv: IEnclaveEnvironmentService,
		@IEnclaveFirewallService private readonly firewallService: IEnclaveFirewallService,
		@IEnclaveSandboxService private readonly sandboxService: IEnclaveSandboxService,
	) {
		super();
		this._sessionId = this._generateSessionId();

		console.log(`[Enclave ActionLog] Service initialized. Session: ${this._sessionId}`);

		this.logAction('lifecycle', 'lifecycle.session_start', 'IDE session started', 'system', 'info');

		// Wire up all listeners
		this._hookCommands();
		this._hookEditors();
		this._hookFiles();
		this._hookConfiguration();
		this._hookLifecycle();
		this._hookDebug();
		this._hookTerminals();
		// Void / AI
		this._hookChat();
		this._hookVoidSettings();
		this._hookEnterprisePolicy();
		// NeuralInverse Agents
		this._hookAgent();
		this._hookSubAgents();
		this._hookAgentConfig();
		// Checks / GRC
		this._hookGRCEngine();
		this._hookChecksAgent();
		this._hookChecksSocket();
		this._hookExternalTools();
		this._hookContractReason();
		this._hookFrameworkRegistry();
		// File system watcher (real-time file changes from outside)
		this._hookFileWatcher();
		// Power Mode
		this._hookPowerMode();
		this._hookPowerBus();
		// Enclave
		this._hookEnclave();
		this._hookFirewall();
		this._hookSandbox();
	}

	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
	// Public API
	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

	public logAction(
		category: ActionCategory,
		action: string,
		label: string,
		source: ActionSource = 'system',
		severity: ActionSeverity = 'info',
		target?: string,
		metadata?: Record<string, unknown>,
		durationMs?: number
	): IActionLogEntry {
		const entry: IActionLogEntry = {
			id: this._uuid(),
			timestamp: Date.now(),
			category,
			action,
			label,
			source,
			severity,
			target,
			metadata,
			durationMs,
			sessionId: this._sessionId,
		};

		this.storage.append(entry);
		this._onDidLogAction.fire(entry);
		return entry;
	}

	public query(filter?: IActionLogFilter): IActionLogEntry[] {
		return this.storage.query(filter);
	}

	public getStats(): IActionLogStats {
		return this.storage.getStats();
	}

	public clear(): void {
		this.storage.clear();
	}

	public flush(): Promise<void> {
		return this.storage.flush();
	}

	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
	// PLATFORM HOOKS
	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

	// \u2500\u2500\u2500 Commands \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookCommands(): void {
		this._register(this.commandService.onDidExecuteCommand(e => {
			if (this._isNoisyCommand(e.commandId)) {
				return;
			}
			this.logAction(
				'command',
				`command.${e.commandId}`,
				`Command: ${e.commandId}`,
				'user',
				'trace',
				e.commandId,
				{ args: this._safeStringify(e.args) }
			);
		}));
	}

	private _isNoisyCommand(id: string): boolean {
		return id.startsWith('editor.action.triggerSuggest')
			|| id === 'type'
			|| id === 'compositionType'
			|| id === 'compositionStart'
			|| id === 'compositionEnd'
			|| id === 'replacePreviousChar'
			|| id === 'cut'
			|| id === 'deleteLeft'
			|| id === 'deleteRight'
			|| id === 'cursorMove'
			|| id === '_setContext'
			|| id === 'setContext'
			|| id.startsWith('cursor')
			|| id.startsWith('scroll')
			|| id.startsWith('_')
			|| id.startsWith('vscode.setEditorLayout');
	}

	// \u2500\u2500\u2500 Editors \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookEditors(): void {
		this._register(this.editorService.onDidActiveEditorChange(() => {
			const editor = this.editorService.activeEditor;
			const uri = editor?.resource;
			this.logAction('editor', 'editor.focus', `Editor focus: ${uri?.path ?? 'unknown'}`, 'user', 'trace', uri?.path);
		}));

		this._register(this.editorService.onDidCloseEditor(e => {
			const uri = e.editor.resource;
			this.logAction('editor', 'editor.close', `Editor closed: ${uri?.path ?? 'unknown'}`, 'user', 'info', uri?.path);
		}));

		this._register(this.editorService.onDidVisibleEditorsChange(() => {
			this.logAction('editor', 'editor.visible_change', 'Visible editors changed', 'user', 'trace');
		}));
	}

	// \u2500\u2500\u2500 Files \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookFiles(): void {
		this._register(this.fileService.onDidRunOperation(e => {
			const opName = this._fileOperationName(e.operation);
			const source = e.resource.path;
			const meta: Record<string, unknown> = { operation: opName, sourcePath: source };
			if (e.target) { meta['targetPath'] = e.target.resource.path; }
			this.logAction(
				'file', `file.${opName}`, `File ${opName}: ${source}`,
				'user', opName === 'delete' ? 'warning' : 'info', source, meta
			);
		}));

		this._register(this.textFileService.files.onDidSave(e => {
			const path = e.model.resource.path;
			const ext = path.split('.').pop() ?? '';
			this.logAction('file', 'file.save', `File saved: ${path}`, 'user', 'info', path,
				{ fileType: ext });
		}));

		this._register(this.textFileService.files.onDidChangeDirty(model => {
			if (model.isDirty()) {
				this.logAction('file', 'file.dirty', `File modified (unsaved): ${model.resource.path}`, 'user', 'trace', model.resource.path);
			}
		}));
	}

	private _fileOperationName(op: number): string {
		switch (op) {
			case 0: return 'create';
			case 1: return 'delete';
			case 2: return 'move';
			case 3: return 'copy';
			case 4: return 'write';
			default: return `operation_${op}`;
		}
	}

	// \u2500\u2500\u2500 Configuration \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookConfiguration(): void {
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			const keys = e.affectedKeys;
			if (keys.size === 0) { return; }
			const keyList = Array.from(keys).slice(0, 10);
			// Capture before/after for the first changed key so the detail row can show a diff
			const firstKey = keyList[0];
			const afterVal = firstKey ? this.configurationService.getValue(firstKey) : undefined;
			const meta: Record<string, unknown> = {
				keys: keyList,
				totalKeys: keys.size,
			};
			if (firstKey !== undefined && afterVal !== undefined) {
				meta['changedKey'] = firstKey;
				meta['after'] = typeof afterVal === 'object' ? JSON.stringify(afterVal) : String(afterVal);
			}
			this.logAction(
				'configuration', 'configuration.change',
				`Settings changed: ${keyList.join(', ')}${keys.size > 10 ? ` (+${keys.size - 10} more)` : ''}`,
				e.source === 7 ? 'system' : 'user', 'info', undefined, meta
			);
		}));
	}

	// \u2500\u2500\u2500 Lifecycle \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookLifecycle(): void {
		this.lifecycleService.when(LifecyclePhase.Ready).then(() => {
			this.logAction('lifecycle', 'lifecycle.phase_ready', 'Lifecycle: Ready', 'system', 'info');
		});
		this.lifecycleService.when(LifecyclePhase.Restored).then(() => {
			this.logAction('lifecycle', 'lifecycle.phase_restored', 'Lifecycle: Restored (UI visible)', 'system', 'info');
		});
		this.lifecycleService.when(LifecyclePhase.Eventually).then(() => {
			this.logAction('lifecycle', 'lifecycle.phase_eventually', 'Lifecycle: Eventually (idle tasks)', 'system', 'trace');
		});
		this._register(this.lifecycleService.onBeforeShutdown(e => {
			this.logAction('lifecycle', 'lifecycle.before_shutdown', 'IDE shutting down', 'system', 'info', undefined, { reason: e.reason });
			e.veto(this.flush().then(() => false), 'enclaveActionLog.flush');
		}));
	}

	// \u2500\u2500\u2500 Debug \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookDebug(): void {
		this._register(this.debugService.onDidNewSession(session => {
			this.logAction('debug', 'debug.session_start', `Debug session started: ${session.configuration.name}`, 'user', 'info',
				session.configuration.name, { type: session.configuration.type });
		}));
		this._register(this.debugService.onDidEndSession(e => {
			this.logAction('debug', 'debug.session_end', `Debug session ended: ${e.session.configuration.name}`, 'user', 'info',
				e.session.configuration.name);
		}));
		this._register(this.debugService.getModel().onDidChangeBreakpoints(e => {
			if (!e) { return; }
			if (e.added?.length) {
				for (const bp of e.added) {
					this.logAction('debug', 'debug.breakpoint_add',
						`Breakpoint added: ${(bp as any).uri?.path ?? 'unknown'}:${(bp as any).lineNumber ?? '?'}`, 'user', 'trace');
				}
			}
			if (e.removed?.length) {
				this.logAction('debug', 'debug.breakpoint_remove', `${e.removed.length} breakpoint(s) removed`, 'user', 'trace');
			}
		}));
	}

	// \u2500\u2500\u2500 Terminals \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookTerminals(): void {
		this._register(this.terminalService.onDidCreateInstance(instance => {
			this.logAction('terminal', 'terminal.create', `Terminal created: ${instance.title}`, 'user', 'info',
				instance.title, { shellType: instance.shellType });
		}));
		this._register(this.terminalService.onDidDisposeInstance(instance => {
			this.logAction('terminal', 'terminal.dispose', `Terminal disposed: ${instance.title}`, 'user', 'info', instance.title);
		}));
		this._register(this.terminalService.onDidChangeActiveInstance(instance => {
			if (instance) {
				this.logAction('terminal', 'terminal.focus', `Terminal focus: ${instance.title}`, 'user', 'trace', instance.title);
			}
		}));
	}

	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
	// VOID / AI HOOKS
	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

	// \u2500\u2500\u2500 Chat Thread \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookChat(): void {
		this._register(this.chatThreadService.onDidChangeCurrentThread(() => {
			this.logAction('ai', 'ai.chat.thread_change', 'Chat thread changed', 'user', 'info');
		}));
		this._register(this.chatThreadService.onDidChangeStreamState(e => {
			this.logAction('ai', 'ai.chat.stream_state', `Chat stream state changed`, 'agent', 'trace',
				e.threadId, { threadId: e.threadId });
		}));
	}

	// \u2500\u2500\u2500 Void Settings \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookVoidSettings(): void {
		this._register(this.voidSettingsService.onDidChangeState(() => {
			this.logAction('ai', 'ai.settings.change', 'Void settings changed', 'user', 'info');
		}));
	}

	// \u2500\u2500\u2500 Enterprise Policy \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookEnterprisePolicy(): void {
		this._register(this.enterprisePolicyService.onDidChangePolicy(() => {
			this.logAction('ai', 'ai.policy.change', 'Enterprise policy changed', 'system', 'warning');
		}));
	}

	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
	// NEURAL INVERSE AGENT HOOKS
	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

	// \u2500\u2500\u2500 Agent Lifecycle \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookAgent(): void {
		this._register(this.agentService.onDidChangeAgentState(e => {
			const sevMap: Record<string, ActionSeverity> = {
				TaskStarted: 'info',
				TaskCompleted: 'info',
				TaskCancelled: 'warning',
				ToolApproved: 'info',
				ToolRejected: 'warning',
				ContextRecorded: 'trace',
				IterationLimitReached: 'warning',
				ErrorOccurred: 'error',
				PausedByUser: 'info',
				ResumedByUser: 'info',
			};
			const ev = e as any;
			const meta: Record<string, unknown> = { type: e.type };
			if (ev.taskId) { meta['taskId'] = ev.taskId; }
			if (ev.toolName) { meta['toolName'] = ev.toolName; }
			if (ev.toolArgs !== undefined) {
				const argsStr = typeof ev.toolArgs === 'object' ? JSON.stringify(ev.toolArgs) : String(ev.toolArgs);
				meta['toolArgs'] = argsStr.length > 300 ? argsStr.slice(0, 300) + '\u2026' : argsStr;
			}
			if (ev.result !== undefined) {
				const resultStr = typeof ev.result === 'object' ? JSON.stringify(ev.result) : String(ev.result);
				meta['result'] = resultStr.length > 300 ? resultStr.slice(0, 300) + '\u2026' : resultStr;
			}
			if (ev.error) { meta['error'] = String(ev.error); }
			if (ev.message) { meta['message'] = String(ev.message).slice(0, 200); }
			const target = ev.toolName ?? ev.taskId ?? undefined;
			this.logAction(
				'agent', `agent.${e.type}`,
				`Agent: ${e.type}${ev.toolName ? ` \u2192 ${ev.toolName}` : ''}`,
				'agent',
				sevMap[e.type] ?? 'info',
				target,
				meta
			);
		}));
	}

	// \u2500\u2500\u2500 Sub-Agents \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookSubAgents(): void {
		this._register(this.subAgentService.onDidChangeSubAgent(e => {
			const sevMap: Record<string, ActionSeverity> = {
				pending: 'trace',
				running: 'info',
				completed: 'info',
				failed: 'error',
				cancelled: 'warning',
			};
			this.logAction(
				'agent', `agent.subagent.${e.status}`,
				`Sub-agent ${e.subAgentId}: ${e.status}`,
				'agent',
				sevMap[e.status] ?? 'info',
				e.subAgentId,
				{ subAgentId: e.subAgentId, status: e.status }
			);
		}));
	}

	// \u2500\u2500\u2500 Agent Config \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookAgentConfig(): void {
		this._register(this.agentConfigService.onDidChangeConfig(() => {
			this.logAction('agent', 'agent.config_change', '.neuralinverseagent config changed', 'system', 'info');
		}));
	}

	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
	// NEURAL INVERSE CHECKS / GRC HOOKS
	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

	// \u2500\u2500\u2500 GRC Engine \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookGRCEngine(): void {
		this._register(this.grcEngine.onDidCheckComplete(results => {
			if (results.length === 0) { return; }
			const violations = results.filter(r => r.severity === 'error' || r.severity === 'critical');
			const warnings = results.filter(r => r.severity === 'warning');
			// Collect unique rule IDs and affected files from violations
			const ruleIds = [...new Set(violations.map(r => (r as any).ruleId).filter(Boolean))].slice(0, 10) as string[];
			const affectedFiles = [...new Set(violations.map(r => (r as any).fileUri ?? (r as any).file).filter(Boolean))]
				.slice(0, 5)
				.map((f: unknown) => typeof f === 'string' ? f.split('/').pop() ?? f : String(f));
			this.logAction(
				'checks', 'checks.scan_complete',
				`GRC scan: ${results.length} results (${violations.length} violations, ${warnings.length} warnings)`,
				'system',
				violations.length > 0 ? 'warning' : 'info',
				undefined,
				{
					total: results.length,
					violations: violations.length,
					warnings: warnings.length,
					...(ruleIds.length > 0 && { violatedRules: ruleIds }),
					...(affectedFiles.length > 0 && { affectedFiles }),
				}
			);
		}));
		this._register(this.grcEngine.onDidRulesChange(() => {
			this.logAction('checks', 'checks.rules_change', 'GRC rules reloaded', 'system', 'info');
		}));
	}

	// \u2500\u2500\u2500 Checks Agent \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookChecksAgent(): void {
		this._register(this.checksAgent.onDidEmitUIEvent(e => {
			switch (e.type) {
				case 'session-created':
					this.logAction('checks', 'checks.agent.session_created', 'Checks Agent session created', 'agent', 'info');
					break;
				case 'session-updated':
					this.logAction('checks', 'checks.agent.session_updated', `Checks Agent session: ${e.status}`, 'agent', 'info',
						e.sessionId, { status: e.status });
					break;
				case 'message-created':
					this.logAction('checks', 'checks.agent.message', 'Checks Agent message', 'agent', 'trace');
					break;
				case 'error':
					this.logAction('checks', 'checks.agent.error', `Checks Agent error: ${e.error}`, 'agent', 'error');
					break;
				// Skip part-updated, part-delta \u2014 too high-frequency
			}
		}));
	}

	// \u2500\u2500\u2500 Checks Socket (Enterprise) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookChecksSocket(): void {
		this._register(this.checksSocket.onDidChangeConnection(connected => {
			this.logAction(
				'checks', 'checks.socket.connection',
				`Checks socket ${connected ? 'connected' : 'disconnected'}`,
				'system',
				connected ? 'info' : 'warning',
				undefined,
				{ connected }
			);
		}));
		this._register(this.checksSocket.onDidRegisterProject(projectId => {
			this.logAction('checks', 'checks.socket.project_registered', `Project registered: ${projectId}`, 'system', 'info', projectId);
		}));
	}

	// \u2500\u2500\u2500 External Tool Jobs (CodeQL, Semgrep, Polyspace, ...) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookExternalTools(): void {
		this._register(this.externalToolService.onDidJobUpdate(job => {
			this.logAction(
				'checks', `checks.external.${(job as any).status ?? 'update'}`,
				`External tool ${(job as any).toolName ?? 'unknown'}: ${(job as any).status ?? 'updated'}`,
				'system',
				(job as any).status === 'failed' ? 'error' : 'info',
				(job as any).toolName,
				{ jobId: (job as any).id, tool: (job as any).toolName, status: (job as any).status }
			);
		}));
	}

	// \u2500\u2500\u2500 Contract Reason (AI Compliance Analysis) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookContractReason(): void {
		this._register(this.contractReasonService.onDidEnabledChange(enabled => {
			this.logAction('checks', 'checks.contract_reason.toggle',
				`Contract Reason AI ${enabled ? 'enabled' : 'disabled'}`, 'system', 'info', undefined, { enabled });
		}));
		this._register(this.contractReasonService.onDidContractReasonResultsReady(result => {
			this.logAction('checks', 'checks.contract_reason.result',
				`Contract Reason analysis complete: ${(result as any).fileUri?.path ?? 'unknown'}`,
				'agent', 'info', (result as any).fileUri?.path,
				{ violations: (result as any).violations?.length ?? 0 });
		}));
		this._register(this.contractReasonService.onDidScanTrackerUpdate(state => {
			this.logAction('checks', 'checks.scan_progress',
				`Workspace scan: ${(state as any).scannedFiles ?? 0}/${(state as any).totalFiles ?? '?'} files`,
				'system', 'trace', undefined,
				{ scanned: (state as any).scannedFiles, total: (state as any).totalFiles, status: (state as any).status });
		}));
	}

	// \u2500\u2500\u2500 Framework Registry \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookFrameworkRegistry(): void {
		this._register(this.frameworkRegistry.onDidFrameworksChange(() => {
			this.logAction('checks', 'checks.frameworks_change', 'Compliance frameworks updated', 'system', 'info');
		}));
	}

	// \u2500\u2500\u2500 File System Watcher (external changes) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookFileWatcher(): void {
		this._register(this.fileService.onDidFilesChange(e => {
			const created = e.rawAdded.length;
			const updated = e.rawUpdated.length;
			const deleted = e.rawDeleted.length;
			const total = created + updated + deleted;
			if (total === 0) { return; }
			const parts: string[] = [];
			if (created) { parts.push(`${created} created`); }
			if (updated) { parts.push(`${updated} updated`); }
			if (deleted) { parts.push(`${deleted} deleted`); }
			this.logAction(
				'file', 'file.watch',
				`File watcher: ${parts.join(', ')}`,
				'system', 'trace', undefined,
				{ created, updated, deleted, total }
			);
		}));
	}

	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
	// POWER MODE HOOKS
	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

	// \u2500\u2500\u2500 Power Mode Sessions \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookPowerMode(): void {
		this._register(this.powerModeService.onDidEmitUIEvent(e => {
			switch (e.type) {
				case 'session-created':
					this.logAction('powermode', 'powermode.session_created', 'Power Mode session created', 'agent', 'info');
					break;
				case 'session-updated':
					this.logAction('powermode', 'powermode.session_updated', `Power Mode session: ${e.status}`, 'agent', 'info',
						e.sessionId, { status: e.status });
					break;
				case 'message-created':
					this.logAction('powermode', 'powermode.message', 'Power Mode message', 'agent', 'trace');
					break;
				case 'permission-request':
					this.logAction('powermode', 'powermode.permission_request', 'Power Mode permission request', 'agent', 'info');
					break;
				case 'bus-message':
					this.logAction('powermode', 'powermode.bus_message', `Power Mode bus: ${e.from} \u2192 ${e.to}`, 'agent', 'trace',
						undefined, { from: e.from, to: e.to, messageType: e.messageType });
					break;
				case 'error':
					this.logAction('powermode', 'powermode.error', `Power Mode error: ${e.error}`, 'agent', 'error');
					break;
				// Skip part-updated, part-delta, sessions-list \u2014 too high-frequency
			}
		}));
	}

	// \u2500\u2500\u2500 Power Bus (Agent-to-Agent) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookPowerBus(): void {
		this._register(this.powerBusService.onMessage(msg => {
			this.logAction(
				'powermode', 'powermode.bus.message',
				`Agent bus: ${(msg as any).from ?? '?'} \u2192 ${(msg as any).to ?? 'broadcast'}`,
				'agent', 'trace', undefined,
				{ from: (msg as any).from, to: (msg as any).to, type: (msg as any).type }
			);
		}));
		this._register(this.powerBusService.onToolRequest(msg => {
			const toolMsg = msg as any;
			const meta: Record<string, unknown> = {};
			if (toolMsg.toolArgs !== undefined) {
				const argsStr = typeof toolMsg.toolArgs === 'object' ? JSON.stringify(toolMsg.toolArgs) : String(toolMsg.toolArgs);
				meta['toolArgs'] = argsStr.length > 300 ? argsStr.slice(0, 300) + '\u2026' : argsStr;
			}
			if (toolMsg.requestId) { meta['requestId'] = toolMsg.requestId; }
			this.logAction(
				'powermode', 'powermode.bus.tool_request',
				`Agent bus tool request: ${toolMsg.toolName ?? 'unknown'}`,
				'agent', 'info', toolMsg.toolName,
				Object.keys(meta).length > 0 ? meta : undefined
			);
		}));
		this._register(this.powerBusService.onAgentsChanged(agents => {
			this.logAction(
				'powermode', 'powermode.bus.agents_changed',
				`Agent bus: ${agents.length} agent(s) registered`,
				'system', 'info', undefined,
				{ count: agents.length, agents: agents.map((a: any) => a.id ?? a.name ?? 'unknown') }
			);
		}));
	}

	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
	// ENCLAVE HOOKS
	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

	// \u2500\u2500\u2500 Enclave Mode \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookEnclave(): void {
		this._register(this.enclaveEnv.onDidChangeMode(mode => {
			this.logAction('enclave', 'enclave.mode_change', `Enclave mode changed to: ${mode}`, 'user', 'warning', undefined, { mode });
		}));
	}

	// \u2500\u2500\u2500 Context Firewall \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookFirewall(): void {
		this._register(this.firewallService.onDidBlockRequest(e => {
			this.logAction(
				'enclave', 'enclave.firewall.block',
				`Firewall ${(e as any).wasBlocked ? 'BLOCKED' : 'FLAGGED'}: ${(e as any).reason ?? 'unknown'}`,
				'system',
				(e as any).wasBlocked ? 'error' : 'warning',
				undefined,
				{ reason: (e as any).reason, wasBlocked: (e as any).wasBlocked, snippet: (e as any).snippet }
			);
		}));
	}

	// \u2500\u2500\u2500 Execution Sandbox \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

	private _hookSandbox(): void {
		this._register(this.sandboxService.onDidSandboxViolation(e => {
			this.logAction(
				'enclave', 'enclave.sandbox.violation',
				`Sandbox ${(e as any).wasBlocked ? 'BLOCKED' : 'FLAGGED'}: ${(e as any).type ?? 'unknown'}`,
				'system',
				(e as any).wasBlocked ? 'error' : 'warning',
				undefined,
				{ type: (e as any).type, wasBlocked: (e as any).wasBlocked, details: (e as any).details }
			);
		}));
	}

	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
	// UTILITIES
	// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

	private _uuid(): string {
		try {
			return crypto.randomUUID();
		} catch {
			return 'xxxx-xxxx-xxxx-xxxx'.replace(/x/g, () =>
				Math.floor(Math.random() * 16).toString(16)
			);
		}
	}

	private _generateSessionId(): string {
		return `ses_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
	}

	private _safeStringify(value: unknown): string | undefined {
		if (value === undefined || value === null) {
			return undefined;
		}
		try {
			const str = JSON.stringify(value);
			return str.length > 500 ? str.substring(0, 500) + '...' : str;
		} catch {
			return '[unserializable]';
		}
	}
}

registerSingleton(IEnclaveActionLogService, EnclaveActionLogService, InstantiationType.Eager);
