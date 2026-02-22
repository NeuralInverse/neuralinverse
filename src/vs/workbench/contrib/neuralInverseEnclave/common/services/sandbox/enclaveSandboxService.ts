/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IEnclaveEnvironmentService } from '../environment/enclaveEnvironmentService.js';

export const IEnclaveSandboxService = createDecorator<IEnclaveSandboxService>('enclaveSandboxService');

export interface ISandboxViolationEvent {
	id: string;
	timestamp: number;
	type: 'network' | 'filesystem' | 'command_timeout' | 'dangerous_command';
	details: string;
	wasBlocked: boolean;
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

	/** Emitted when a Sandbox violation occurs */
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
	private readonly MAX_RECENT_VIOLATIONS = 200;

	private readonly _onDidSandboxViolation = this._register(new Emitter<ISandboxViolationEvent>());
	public readonly onDidSandboxViolation = this._onDidSandboxViolation.event;

	// Blocked filesystem paths — system directories and sensitive dotfiles
	private readonly blockedPathPatterns = [
		'/etc/', '/var/', '/usr/', '/sbin/', '/bin/',
		'/.ssh', '/.aws', '/.gnupg', '/.kube', '/.docker',
		'/.env', '/id_rsa', '/id_ed25519',
		'.inverse/audit' // Protect Enclave audit logs from AI tampering
	];

	// Dangerous command fragments that should be blocked or flagged
	private readonly dangerousCommandPatterns = [
		{ pattern: /\brm\s+-[rR]f?\b/, reason: 'Recursive delete command' },
		{ pattern: /\bcurl\b|\bwget\b/, reason: 'Network request' },
		{ pattern: /\bssh\b|\bscp\b/, reason: 'SSH network access' },
		{ pattern: /\bchmod\s+[0-7]{3,4}\b/, reason: 'Permission modification' },
		{ pattern: /\bsudo\b/, reason: 'Privilege escalation' },
		{ pattern: /\b(nc|ncat|netcat)\b/, reason: 'Network socket command' },
		{ pattern: />\s*\/dev\//, reason: 'Device file write' },
	];

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IEnclaveEnvironmentService private readonly enclaveEnv: IEnclaveEnvironmentService
	) {
		super();

		// Auto-adjust enforcement based on Enclave mode
		this._register(this.enclaveEnv.onDidChangeMode(mode => {
			if (mode === 'draft') {
				this._isEnforcing = false;
			} else {
				this._isEnforcing = true;
			}
			console.log(`[Enclave Sandbox] Mode changed to ${mode}. Enforcing: ${this._isEnforcing}`);
		}));

		// Initialize based on current mode
		this._isEnforcing = this.enclaveEnv.mode !== 'draft';
		console.log(`[Enclave] Sandbox Service initialized. Mode: ${this.enclaveEnv.mode}. Enforcing: ${this._isEnforcing}`);
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

		const uriPath = uri.path.toLowerCase();

		// Deny access to system paths and sensitive dotfiles
		for (const pattern of this.blockedPathPatterns) {
			if (uriPath.includes(pattern)) {
				this._recordViolation(
					'filesystem',
					`Agent attempted to ${isWrite ? 'WRITE' : 'READ'} blocked path: ${uri.path}`,
					true
				);
				return false;
			}
		}

		// Ensure access is within the current workspace folders
		const workspaceFolders = this.workspaceContextService.getWorkspace().folders;
		if (workspaceFolders.length === 0) {
			if (isWrite) {
				this._recordViolation(
					'filesystem',
					`Agent write attempt blocked (no active workspace): ${uri.path}`,
					true
				);
				return false;
			}
			return true; // Allow reads outside workspace by default if no workspace
		}

		const isWithinWorkspace = workspaceFolders.some(folder =>
			uri.path.startsWith(folder.uri.path)
		);

		if (!isWithinWorkspace) {
			this._recordViolation(
				'filesystem',
				`Agent attempted ${isWrite ? 'WRITE' : 'READ'} outside workspace: ${uri.path}`,
				true
			);
			return false;
		}

		return true;
	}

	public wrapCommand(command: string, timeoutMs: number = 30000): string {
		if (!this._isEnforcing) {
			return command;
		}

		const mode = this.enclaveEnv.mode;

		// Check for dangerous command patterns
		for (const { pattern, reason } of this.dangerousCommandPatterns) {
			if (pattern.test(command)) {
				const shouldBlock = mode === 'prod';
				this._recordViolation(
					pattern.source.includes('curl') || pattern.source.includes('wget') || pattern.source.includes('ssh')
						? 'network' : 'dangerous_command',
					`Agent attempted: ${reason} — "${command.substring(0, 100)}"`,
					shouldBlock
				);

				if (shouldBlock) {
					return `echo "[Enclave Sandbox] Command blocked in PROD mode: ${reason}" >&2 && exit 1`;
				}
				// Dev mode: warn but allow through with timeout
			}
		}

		// Wrap with timeout
		// Note: On macOS, 'timeout' requires 'gtimeout' from GNU coreutils.
		// Cross-platform: use the available timeout mechanism.
		return `timeout ${timeoutMs / 1000}s bash -c '${command.replace(/'/g, "'\\''")}'`;
	}

	private _recordViolation(type: ISandboxViolationEvent['type'], details: string, wasBlocked: boolean) {
		const event: ISandboxViolationEvent = {
			id: this._generateId(),
			timestamp: Date.now(),
			type,
			details,
			wasBlocked
		};

		this._recentViolations.unshift(event);
		if (this._recentViolations.length > this.MAX_RECENT_VIOLATIONS) {
			this._recentViolations.pop();
		}

		this._onDidSandboxViolation.fire(event);
		if (wasBlocked) {
			console.warn(`[Enclave Sandbox] BLOCKED (${type}): ${details}`);
		} else {
			console.log(`[Enclave Sandbox] FLAGGED (${type}): ${details}`);
		}
	}

	private _generateId(): string {
		try {
			return crypto.randomUUID();
		} catch {
			return `sb-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
		}
	}

	public getRecentViolations(): ISandboxViolationEvent[] {
		return [...this._recentViolations];
	}
}

registerSingleton(IEnclaveSandboxService, EnclaveSandboxService, InstantiationType.Delayed);

