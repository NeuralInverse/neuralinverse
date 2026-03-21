/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Audit Log Manager
 *
 * Maintains a tamper-evident append-only log of every mutation to the knowledge base.
 * Each entry includes an FNV-1a hash of the previous entry, forming a hash chain.
 * Verifying the chain detects any offline tampering of the audit trail.
 *
 * Cap: MAX_AUDIT_LOG entries in memory. On overflow, oldest entries are trimmed (they
 * were already persisted to storage). The chain hash is preserved through trimming.
 */

import { IKnowledgeAuditEntry, KnowledgeAuditEventType } from '../../../common/knowledgeBaseTypes.js';
import { hashAuditEntry, makeId } from './helpers.js';
import { MAX_AUDIT_LOG, AUDIT_LOG_TRIM } from './persistence.js';


// ─── Append ───────────────────────────────────────────────────────────────────

/**
 * Append a new entry to the audit log, linking it to the previous entry via hash.
 * Mutates the log array in place.
 */
export function appendAuditEntry(
	log: IKnowledgeAuditEntry[],
	entry: IKnowledgeAuditEntry,
): void {
	entry.previousEntryHash = log.length > 0
		? hashAuditEntry(log[log.length - 1])
		: '00000000';

	log.push(entry);

	// Rolling cap — trim oldest when limit exceeded
	if (log.length > MAX_AUDIT_LOG) {
		log.splice(0, AUDIT_LOG_TRIM);
	}
}


// ─── Factory ──────────────────────────────────────────────────────────────────

export function makeAuditEntry(
	type: KnowledgeAuditEventType,
	summary: string,
	payload: Record<string, unknown>,
	unitId?: string,
	actor  = 'system',
): IKnowledgeAuditEntry {
	return {
		id:                makeId('a'),
		eventType:         type,
		unitId,
		timestamp:         Date.now(),
		actorId:           actor,
		summary,
		payload,
		previousEntryHash: '',   // Filled by appendAuditEntry()
	};
}


// ─── Query helpers ────────────────────────────────────────────────────────────

export function queryAuditLog(
	log: IKnowledgeAuditEntry[],
	options?: { unitId?: string; limit?: number; offset?: number },
): IKnowledgeAuditEntry[] {
	let filtered = options?.unitId
		? log.filter(e => e.unitId === options.unitId)
		: log;

	// Return most-recent first (reverse order), with pagination
	const total   = filtered.length;
	const offset  = options?.offset ?? 0;
	const limit   = options?.limit  ?? 200;
	const start   = Math.max(0, total - offset - limit);
	const end     = Math.max(0, total - offset);
	return filtered.slice(start, end).reverse();
}


// ─── Integrity verification ───────────────────────────────────────────────────

/**
 * Verify the hash chain integrity of the audit log.
 * Returns { valid, firstBrokenIndex } for compliance auditing.
 * firstBrokenIndex is null if the chain is intact.
 */
export function verifyAuditLogIntegrity(
	log: IKnowledgeAuditEntry[],
): { valid: boolean; firstBrokenIndex: number | null } {
	for (let i = 1; i < log.length; i++) {
		const expectedPrevHash = hashAuditEntry(log[i - 1]);
		if (log[i].previousEntryHash !== expectedPrevHash) {
			return { valid: false, firstBrokenIndex: i };
		}
	}
	return { valid: true, firstBrokenIndex: null };
}
