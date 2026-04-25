/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure helper functions for the Knowledge Base implementation.
 * No side effects, no DI dependencies.
 */

import {
	IModernisationKnowledgeBase,
	IModernisationKnowledgeBaseJSON,
	IDecisionLog,
	IBusinessGlossary,
	IProgressState,
	IKnowledgeAuditEntry,
	IKnowledgeUnit,
	KnowledgeAuditEventType,
	UnitStatus,
	RiskLevel,
	KNOWLEDGE_BASE_VERSION,
	emptyExtensions,
} from '../../../common/knowledgeBaseTypes.js';

// \u2500\u2500\u2500 Constants \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export const ALL_STATUSES: UnitStatus[] = [
	'pending', 'resolving', 'ready', 'translating', 'review', 'flagged',
	'approved', 'committed', 'validating', 'validated', 'complete', 'skipped', 'blocked',
];

export const ALL_RISKS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

/** Statuses considered "done" for dependency-checking purposes */
export const DONE_STATUSES = new Set<UnitStatus>([
	'approved', 'committed', 'validating', 'validated', 'complete',
]);

/** Statuses that count as fully complete for progress % calculation */
export const COMPLETE_STATUSES = new Set<UnitStatus>([
	'committed', 'validated', 'complete',
]);

export const RISK_ORDER: Record<RiskLevel, number> = {
	critical: 0, high: 1, medium: 2, low: 3,
};

export const PRIORITY_ORDER: Record<'low' | 'medium' | 'high' | 'blocking', number> = {
	blocking: 0, high: 1, medium: 2, low: 3,
};


// \u2500\u2500\u2500 Empty constructors \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function emptyDecisionLog(): IDecisionLog {
	return {
		typeMapping:      [],
		naming:           [],
		ruleInterpret:    [],
		exclusions:       [],
		patternOverrides: [],
	};
}

export function emptyGlossary(): IBusinessGlossary {
	return { terms: [], domains: [], patterns: [] };
}

export function emptyProgress(): IProgressState {
	const byStatus = Object.fromEntries(ALL_STATUSES.map(s => [s, 0])) as Record<UnitStatus, number>;
	const byRisk   = Object.fromEntries(ALL_RISKS.map(r => [r, 0])) as Record<RiskLevel, number>;
	return {
		totalUnits:       0,
		byStatus,
		byRisk,
		byPhase:          [],
		blockedUnits:     [],
		pendingDecisions: [],
	};
}

export function newKnowledgeBase(sessionId: string): IModernisationKnowledgeBase {
	const now = Date.now();
	return {
		sessionId,
		createdAt:  now,
		updatedAt:  now,
		version:    KNOWLEDGE_BASE_VERSION,
		units:      new Map(),
		files:      new Map(),
		decisions:  emptyDecisionLog(),
		glossary:   emptyGlossary(),
		progress:   emptyProgress(),
		auditLog:   [],
		ext:        emptyExtensions(),
	};
}


// \u2500\u2500\u2500 Serialisation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function serialiseKB(kb: IModernisationKnowledgeBase): string {
	const json: IModernisationKnowledgeBaseJSON = {
		...kb,
		units: Object.fromEntries(kb.units),
		files: Object.fromEntries(kb.files),
	};
	return JSON.stringify(json);
}

export function deserialiseKB(raw: string): IModernisationKnowledgeBase {
	const json = JSON.parse(raw) as IModernisationKnowledgeBaseJSON;
	return {
		...json,
		units: new Map(Object.entries(json.units)),
		files: new Map(Object.entries(json.files)),
		// Migration guard: older persisted KBs won't have ext \u2014 initialise to empty
		ext: json.ext ?? emptyExtensions(),
	};
}


// \u2500\u2500\u2500 Hashing \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * FNV-1a 32-bit hash.
 * Fast, deterministic, good distribution \u2014 used for tamper-evident audit chaining.
 */
export function fnv1a32(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

export function hashAuditEntry(entry: IKnowledgeAuditEntry): string {
	return fnv1a32(
		`${entry.id}|${entry.eventType}|${entry.timestamp}|${JSON.stringify(entry.payload)}|${entry.previousEntryHash}`
	);
}


// \u2500\u2500\u2500 ID generation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

let _seq = 0;

export function makeId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${(++_seq).toString(36)}`;
}


// \u2500\u2500\u2500 Audit entry factory \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

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
		previousEntryHash: '',
	};
}


// \u2500\u2500\u2500 Index map utilities \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export function addToIndex<K>(map: Map<K, Set<string>>, key: K, id: string): void {
	if (!map.has(key)) { map.set(key, new Set()); }
	map.get(key)!.add(id);
}

export function removeFromIndex<K>(map: Map<K, Set<string>>, key: K, id: string): void {
	map.get(key)?.delete(id);
}

export function resolveIds(
	ids: Set<string> | undefined,
	units: Map<string, IKnowledgeUnit>,
): IKnowledgeUnit[] {
	if (!ids) { return []; }
	const result: IKnowledgeUnit[] = [];
	ids.forEach(id => {
		const u = units.get(id);
		if (u) { result.push(u); }
	});
	return result;
}
