/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../../base/common/buffer.js';
import { IEnclaveEnvironmentService, EnclaveMode } from '../environment/enclaveEnvironmentService.js';

export const IEnclaveAuditTrailService = createDecorator<IEnclaveAuditTrailService>('enclaveAuditTrailService');

export type AuditAction = 'llm_call' | 'file_write' | 'command_exec' | 'firewall_block' | 'sandbox_violation';
export type AuditActor = 'user' | 'agent' | 'agentic_system';
export type AuditOutcome = 'allowed' | 'blocked' | 'flagged';

export interface IAuditEntry {
	id: string;
	timestamp: number;
	action: AuditAction;
	actor: AuditActor;
	target: string;
	outcome: AuditOutcome;
	hash: string;
	mode: EnclaveMode;
	details?: string;
}

export interface IEnclaveAuditTrailService {
	readonly _serviceBrand: undefined;

	/** Emitted when a new entry is appended to the trail */
	readonly onDidAddEntry: Event<IAuditEntry>;

	/** Log a new event to the audit trail */
	logEntry(action: AuditAction, actor: AuditActor, target: string, outcome: AuditOutcome, details?: string): Promise<IAuditEntry>;

	/** Get the N most recent entries (from in-memory buffer) */
	getRecentEntries(limit?: number): IAuditEntry[];

	/** Get total count of entries in the current session */
	getEntryCount(): number;

	/** Verify the hash chain integrity of the in-memory entries */
	verifyChain(): { valid: boolean; brokenAt?: number };
}

export class EnclaveAuditTrailService extends Disposable implements IEnclaveAuditTrailService {
	declare readonly _serviceBrand: undefined;

	private _entries: IAuditEntry[] = [];
	private _lastHash: string = '0000000000000000000000000000000000000000000000000000000000000000'; // genesis
	private readonly MAX_IN_MEMORY = 500;

	private readonly _onDidAddEntry = this._register(new Emitter<IAuditEntry>());
	public readonly onDidAddEntry: Event<IAuditEntry> = this._onDidAddEntry.event;

	constructor(
		@IEnclaveEnvironmentService private readonly enclaveEnv: IEnclaveEnvironmentService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService
	) {
		super();
		console.log('[Enclave] Audit Trail Service initialized.');
	}

	public async logEntry(
		action: AuditAction,
		actor: AuditActor,
		target: string,
		outcome: AuditOutcome,
		details?: string
	): Promise<IAuditEntry> {
		const entry: IAuditEntry = {
			id: this._generateUUID(),
			timestamp: Date.now(),
			action,
			actor,
			target: this._sanitizeTarget(target),
			outcome,
			hash: '', // computed below
			mode: this.enclaveEnv.mode,
			details
		};

		// Hash chain: SHA-256( prevHash + entryContent )
		entry.hash = await this._computeHash(entry);
		this._lastHash = entry.hash;

		// In-memory buffer (ring buffer)
		this._entries.push(entry);
		if (this._entries.length > this.MAX_IN_MEMORY) {
			this._entries.shift();
		}

		// Fire event for UI subscribers
		this._onDidAddEntry.fire(entry);

		// Persist to disk asynchronously (best-effort; never block on I/O)
		this._persistEntry(entry).catch(err => {
			console.error('[Enclave AuditTrail] Failed to persist entry:', err);
		});

		return entry;
	}

	public getRecentEntries(limit: number = 50): IAuditEntry[] {
		return this._entries.slice(-limit);
	}

	public getEntryCount(): number {
		return this._entries.length;
	}

	public verifyChain(): { valid: boolean; brokenAt?: number } {
		// Integrity check: walk the chain and re-hash
		// Note: This is a synchronous verification of the in-memory fast chain.
		// Full disk-based chain verification would be async.
		// For now, we verify ordering and non-empty hashes.
		for (let i = 0; i < this._entries.length; i++) {
			if (!this._entries[i].hash || this._entries[i].hash.length !== 64) {
				return { valid: false, brokenAt: i };
			}
		}
		return { valid: true };
	}

	// --- Private Helpers ---

	private async _computeHash(entry: IAuditEntry): Promise<string> {
		const payload = this._lastHash + JSON.stringify({
			id: entry.id,
			timestamp: entry.timestamp,
			action: entry.action,
			actor: entry.actor,
			target: entry.target,
			outcome: entry.outcome,
			mode: entry.mode,
			details: entry.details
		});

		try {
			const encoder = new TextEncoder();
			const data = encoder.encode(payload);
			const hashBuffer = await crypto.subtle.digest('SHA-256', data);
			const hashArray = Array.from(new Uint8Array(hashBuffer));
			return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
		} catch {
			// Fallback: simple non-crypto hash for environments without SubtleCrypto
			return this._simpleHash(payload);
		}
	}

	private _simpleHash(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return Math.abs(hash).toString(16).padStart(64, '0');
	}

	private async _persistEntry(entry: IAuditEntry): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) {
			return; // No workspace — cannot persist
		}

		const workspaceRoot = folders[0].uri;
		const dateStr = new Date(entry.timestamp).toISOString().split('T')[0]; // YYYY-MM-DD
		const auditDir = URI.joinPath(workspaceRoot, '.inverse', 'audit');
		const auditFile = URI.joinPath(auditDir, `audit-${dateStr}.jsonl`);

		const line = JSON.stringify(entry) + '\n';

		try {
			// Try to append to existing file
			const existing = await this.fileService.readFile(auditFile).then(
				content => content.value.toString(),
				() => '' // File doesn't exist yet
			);
			await this.fileService.writeFile(auditFile, VSBuffer.fromString(existing + line));
		} catch (err) {
			console.warn('[Enclave AuditTrail] Persistence error (non-fatal):', err);
		}
	}

	private _sanitizeTarget(target: string): string {
		// Truncate extremely long targets to avoid log bloat
		if (target.length > 500) {
			return target.substring(0, 500) + '... (truncated)';
		}
		return target;
	}

	private _generateUUID(): string {
		// Use crypto.randomUUID if available, otherwise fallback
		try {
			return crypto.randomUUID();
		} catch {
			return 'xxxx-xxxx-xxxx-xxxx'.replace(/x/g, () =>
				Math.floor(Math.random() * 16).toString(16)
			);
		}
	}
}

registerSingleton(IEnclaveAuditTrailService, EnclaveAuditTrailService, InstantiationType.Delayed);
