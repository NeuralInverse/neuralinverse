/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../platform/files/common/files.js';

export const IEnclaveSandboxService = createDecorator<IEnclaveSandboxService>('enclaveSandboxService');

export interface ISandboxViolationEvent {
	id: string;
	timestamp: number;
	type: 'network' | 'filesystem' | 'command_timeout';
	details: string;
}

export interface IEnclaveSandboxService {
	readonly _serviceBrand: undefined;

	/**
	 * Validates if an Agent has permission to read or write to a specific file URI.
	 * Returns true if permitted, false if blocked.
	 */
	validateFileAccess(uri: URI, isWrite: boolean): Promise<boolean>;

	/**
	 * Wraps a shell command with Enclave restrictions (timeout, env vars).
	 * Returns the modified command string to be executed.
	 */
	wrapCommand(command: string, timeoutMs?: number): string;

	/** Emitted when an Sandbox violation occurs */
	readonly onDidSandboxViolation: Event<ISandboxViolationEvent>;

	/** Get recent Sandbox violations */
	getRecentViolations(): ISandboxViolationEvent[];

	/** Get Sandbox status (whether it is actively enforcing rules) */
	readonly isEnforcing: boolean;
	setEnforcing(value: boolean): void;
}

export class EnclaveSandboxService extends Disposable implements IEnclaveSandboxService {
	declare readonly _serviceBrand: undefined;

	private _isEnforcing = true;
	private _recentViolations: ISandboxViolationEvent[] = [];
	private readonly MAX_RECENT_VIOLATIONS = 100;

	private readonly _onDidSandboxViolation = this._register(new Emitter<ISandboxViolationEvent>());
	public readonly onDidSandboxViolation = this._onDidSandboxViolation.event;

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService
	) {
		super();
		console.log('[Enclave] Sandbox Service initialized.');
	}

	public get isEnforcing(): boolean {
		return this._isEnforcing;
	}

	public setEnforcing(value: boolean): void {
		this._isEnforcing = value;
	}

	public async validateFileAccess(uri: URI, isWrite: boolean): Promise<boolean> {
		if (!this._isEnforcing) {
			return true;
		}

		// Deny access to system paths entirely
		const blockedPatterns = ['/etc/', '/var/', '/usr/', '~/.ssh', '~/.aws'];
		const uriPath = uri.path.toLowerCase();

		for (const pattern of blockedPatterns) {
			if (uriPath.includes(pattern)) {
				this._recordViolation('filesystem', `Agent attempted to access system path: ${uri.path}`);
				return false;
			}
		}

		// Ensure access is within the current workspace folders
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
		if (workspaceFolders.length === 0) {
			// No workspace available, default to denying writes
			if (isWrite) {
				this._recordViolation('filesystem', `Agent write attempt blocked (no active workspace): ${uri.path}`);
				return false;
			}
			return true; // Allow reads outside workspace by default if no workspace
		}

		const isWithinWorkspace = workspaceFolders.some(folder =>
			uri.path.startsWith(folder.uri.path)
		);

		if (!isWithinWorkspace) {
			this._recordViolation('filesystem', `Agent attempted ${isWrite ? 'WRITE' : 'READ'} outside workspace: ${uri.path}`);
			return false;
		}

		// Prevent modifications to Enclave logs/audit files
		if (isWrite && uriPath.includes('.inverse/audit')) {
			this._recordViolation('filesystem', `Agent attempted to modify audit trail: ${uri.path}`);
			return false;
		}

		return true;
	}

	public wrapCommand(command: string, timeoutMs: number = 30000): string {
		if (!this._isEnforcing) {
			return command;
		}

		// In a real environment, this might wrap the command in `docker run` or a lightweight `sandbox-exec` (macOS).
		// For now, we enforce a strict timeout utility built into unix (timeout command).
		// Note: 'timeout' is standard on Linux. On macOS, it needs 'gtimeout' from coreutils, or a perl/ruby script wrap.
		// For simplicity in this demo, we simulate the wrapper.

		// Prevent network exfiltration via curl/wget
		if (command.includes('curl ') || command.includes('wget ')) {
			this._recordViolation('network', `Agent attempted to execute network request: ${command}`);
			// Strip the command or return a dummy echo
			return `echo "Enclave Sandbox: Network requests blocked for ( ${command} )" >&2 && exit 1`;
		}

		// Unix timeout wrapper
		// Using generic 'timeout' command.
		return `timeout ${timeoutMs / 1000}s bash -c '${command.replace(/'/g, "'\\''")}'`;
	}

	private _recordViolation(type: 'network' | 'filesystem' | 'command_timeout', details: string) {
		const event: ISandboxViolationEvent = {
			id: crypto.randomUUID(),
			timestamp: Date.now(),
			type,
			details
		};

		this._recentViolations.unshift(event);
		if (this._recentViolations.length > this.MAX_RECENT_VIOLATIONS) {
			this._recentViolations.pop();
		}

		this._onDidSandboxViolation.fire(event);
		console.warn(`[Enclave Sandbox] VIOLATION (${type}): ${details}`);
	}

	public getRecentViolations(): ISandboxViolationEvent[] {
		return [...this._recentViolations];
	}
}

registerSingleton(IEnclaveSandboxService, EnclaveSandboxService, InstantiationType.Delayed);
