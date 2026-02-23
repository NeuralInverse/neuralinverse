/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IEnclaveEnvironmentService, EnclaveMode } from '../environment/enclaveEnvironmentService.js';
import { IEnclaveFirewallService } from '../firewall/enclaveFirewallService.js';
import { IEnclaveSandboxService } from '../sandbox/enclaveSandboxService.js';
import { IEnclaveAuditTrailService } from '../audit/enclaveAuditTrailService.js';

export const IEnclaveGatekeeperService = createDecorator<IEnclaveGatekeeperService>('enclaveGatekeeperService');

export interface IGatekeeperResult {
	allowed: boolean;
	reason?: string;
	severity: 'block' | 'flag' | 'log';
}

export interface IEnclaveGatekeeperService {
	readonly _serviceBrand: undefined;

	/**
	 * Check if an outbound LLM prompt is permitted.
	 * Runs the Firewall and logs the result to the audit trail.
	 */
	canSendPrompt(text: string, actor?: 'user' | 'agent' | 'agentic_system'): Promise<IGatekeeperResult>;

	/**
	 * Check if an AI agent may write to a file.
	 * Runs the Sandbox validator and logs the result.
	 */
	canWriteFile(uri: URI, actor?: 'user' | 'agent' | 'agentic_system'): Promise<IGatekeeperResult>;

	/**
	 * Check if an AI agent may execute a terminal command.
	 * Wraps the command through the Sandbox and logs the result.
	 * Returns the (potentially modified) command string along with the result.
	 */
	canExecuteCommand(command: string, actor?: 'user' | 'agent' | 'agentic_system'): Promise<IGatekeeperResult & { wrappedCommand?: string }>;

	/**
	 * Get the current enforcement mode.
	 */
	readonly currentMode: EnclaveMode;
}

export class EnclaveGatekeeperService extends Disposable implements IEnclaveGatekeeperService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IEnclaveEnvironmentService private readonly enclaveEnv: IEnclaveEnvironmentService,
		@IEnclaveFirewallService private readonly firewallService: IEnclaveFirewallService,
		@IEnclaveSandboxService private readonly sandboxService: IEnclaveSandboxService,
		@IEnclaveAuditTrailService private readonly auditTrailService: IEnclaveAuditTrailService
	) {
		super();
		console.log('[Enclave] Gatekeeper Service initialized.');
	}

	public get currentMode(): EnclaveMode {
		return this.enclaveEnv.mode;
	}

	public async canSendPrompt(
		text: string,
		actor: 'user' | 'agent' | 'agentic_system' = 'agent'
	): Promise<IGatekeeperResult> {
		const mode = this.enclaveEnv.mode;
		const firewallResult = this.firewallService.validatePrompt(text);

		if (firewallResult.blocked) {
			const severity = this._getPromptBlockSeverity(mode);
			const result: IGatekeeperResult = {
				allowed: severity !== 'block',
				reason: firewallResult.reason,
				severity
			};

			// Always log to audit trail
			await this.auditTrailService.logEntry(
				'firewall_block',
				actor,
				firewallResult.snippet ?? text.substring(0, 100),
				severity === 'block' ? 'blocked' : 'flagged',
				firewallResult.reason
			);

			if (severity === 'block') {
				console.warn(`[Enclave Gatekeeper] BLOCKED prompt in ${mode.toUpperCase()} mode: ${firewallResult.reason}`);
			} else {
				console.log(`[Enclave Gatekeeper] FLAGGED prompt in ${mode.toUpperCase()} mode (not blocking): ${firewallResult.reason}`);
			}

			return result;
		}

		// Clean pass — log it
		await this.auditTrailService.logEntry('llm_call', actor, text.substring(0, 100), 'allowed');

		return { allowed: true, severity: 'log' };
	}

	public async canWriteFile(
		uri: URI,
		actor: 'user' | 'agent' | 'agentic_system' = 'agent'
	): Promise<IGatekeeperResult> {
		const mode = this.enclaveEnv.mode;

		// Open mode: allow everything
		if (mode === 'open') {
			await this.auditTrailService.logEntry('file_write', actor, uri.path, 'allowed');
			return { allowed: true, severity: 'log' };
		}

		const permitted = await this.sandboxService.validateFileAccess(uri, true);

		if (!permitted) {
			await this.auditTrailService.logEntry(
				'sandbox_violation',
				actor,
				uri.path,
				'blocked',
				'Write access denied by Sandbox'
			);

			return {
				allowed: false,
				reason: `Sandbox: Write access to ${uri.path} is not permitted in ${mode.toUpperCase()} mode`,
				severity: 'block'
			};
		}

		await this.auditTrailService.logEntry('file_write', actor, uri.path, 'allowed');
		return { allowed: true, severity: 'log' };
	}

	public async canExecuteCommand(
		command: string,
		actor: 'user' | 'agent' | 'agentic_system' = 'agent'
	): Promise<IGatekeeperResult & { wrappedCommand?: string }> {
		const mode = this.enclaveEnv.mode;

		// Open mode: pass through without wrapping
		if (mode === 'open') {
			await this.auditTrailService.logEntry('command_exec', actor, command.substring(0, 200), 'allowed');
			return { allowed: true, severity: 'log', wrappedCommand: command };
		}

		// Let the sandbox wrap the command (may block network commands, etc.)
		const wrappedCommand = this.sandboxService.wrapCommand(command);

		// Check if the sandbox transformed the command into a block sentinel
		const wasBlocked = wrappedCommand.startsWith('echo "Enclave Sandbox:');

		if (wasBlocked) {
			await this.auditTrailService.logEntry(
				'sandbox_violation',
				actor,
				command.substring(0, 200),
				mode === 'locked_down' ? 'blocked' : 'flagged',
				'Network command blocked by Sandbox'
			);

			if (mode === 'locked_down') {
				return {
					allowed: false,
					reason: `Sandbox: Command blocked in LOCKED_DOWN mode`,
					severity: 'block',
					wrappedCommand
				};
			}

			// Standard mode: flag but allow (the wrapped command already echoes a warning)
			return {
				allowed: true,
				reason: 'Sandbox: Network command flagged in STANDARD mode',
				severity: 'flag',
				wrappedCommand
			};
		}

		await this.auditTrailService.logEntry('command_exec', actor, command.substring(0, 200), 'allowed');
		return { allowed: true, severity: 'log', wrappedCommand };
	}

	// --- Private Helpers ---

	private _getPromptBlockSeverity(mode: EnclaveMode): 'block' | 'flag' | 'log' {
		switch (mode) {
			case 'open': return 'log';         // Log only, never block
			case 'standard': return 'block';   // Block critical patterns
			case 'locked_down': return 'block'; // Block everything
			default: return 'block';
		}
	}
}

registerSingleton(IEnclaveGatekeeperService, EnclaveGatekeeperService, InstantiationType.Delayed);
