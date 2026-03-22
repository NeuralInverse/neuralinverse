/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Audit Trail Exporter
 *
 * Serialises the full KB audit log into a portable, tamper-evident JSON bundle.
 * The bundle can be handed to compliance teams, stored in a GRC system, or attached
 * to a change-management ticket.
 *
 * ## Bundle structure
 *
 * ```
 * {
 *   meta:            export metadata (sessionId, exportedAt, exportedBy, ...)
 *   auditEntries:    IKnowledgeAuditEntry[] — the full chain
 *   unitSummaries:   per-unit migration summary (status, approvals, equivalence)
 *   decisionSummary: aggregate counts of each decision type
 *   integrity:       hash of this bundle — verify with verifyAuditBundleIntegrity()
 * }
 * ```
 *
 * ## Tamper-evidence
 *
 * The existing `IKnowledgeAuditEntry.previousEntryHash` chain already links each
 * entry to its predecessor via FNV-1a.  The bundle adds a second `integrity.bundleHash`
 * that is the FNV-1a hash of the canonicalised `auditEntries` array so that any
 * post-export tampering can be detected without the original KB.
 */

import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';
import {
	IKnowledgeAuditEntry,
	IKnowledgeUnit,
} from '../../../../common/knowledgeBaseTypes.js';
import { IApprovalRecord, IEquivalenceResult } from '../../../../common/modernisationTypes.js';


// ─── Types ────────────────────────────────────────────────────────────────────

export interface IAuditBundleOptions {
	/** Identity label of the person / system triggering the export */
	exportedBy?: string;
	/**
	 * When true (default) include only the final approved / validated / committed
	 * units in the unitSummaries list.  When false, include all units.
	 */
	exportedUnitsFilter?: 'all' | 'terminal';
}

export interface IAuditBundleUnitSummary {
	unitId:            string;
	unitName:          string;
	sourceLang:        string;
	riskLevel:         string;
	domain?:           string;
	status:            string;
	approvalCount:     number;
	/** Summarised equivalence result — present when validation ran */
	equivalence?:      IAuditBundleEquivalenceSummary;
	createdAt:         number;
	updatedAt:         number;
}

export interface IAuditBundleEquivalenceSummary {
	testedAt:      number;
	testCaseCount: number;
	passCount:     number;
	failCount:     number;
	overridden:    boolean;
}

export interface IAuditBundleDecisionSummary {
	typeMappings:    number;
	namingDecisions: number;
	ruleInterpretations: number;
	exclusions:      number;
	patternOverrides: number;
}

export interface IAuditBundleIntegrity {
	/** FNV-1a hash of the canonicalised auditEntries array */
	bundleHash:        string;
	/** Whether the internal previousEntryHash chain was intact at export time */
	chainValid:        boolean;
	/** Index of the first broken link, or null if chain is valid */
	firstBrokenIndex:  number | null;
}

export interface IAuditBundleMeta {
	schemaVersion:  number;
	sessionId:      string;
	exportedAt:     number;
	exportedBy:     string;
	totalUnits:     number;
	totalAuditEntries: number;
}

export interface IAuditBundle {
	meta:             IAuditBundleMeta;
	auditEntries:     IKnowledgeAuditEntry[];
	unitSummaries:    IAuditBundleUnitSummary[];
	decisionSummary:  IAuditBundleDecisionSummary;
	integrity:        IAuditBundleIntegrity;
}

/** Current schema version — increment on breaking changes */
const BUNDLE_SCHEMA_VERSION = 1;


// ─── FNV-1a hash (32-bit) ────────────────────────────────────────────────────

function _fnv1a(str: string): string {
	let h = 0x811c9dc5 >>> 0;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}


// ─── Bundle builder ──────────────────────────────────────────────────────────

/**
 * Build a complete `IAuditBundle` from the current KB state.
 * This is a pure in-memory operation — nothing is written to disk here.
 */
export function exportAuditBundle(
	kb:      IKnowledgeBaseService,
	options: IAuditBundleOptions = {},
): IAuditBundle {
	const exportedBy     = options.exportedBy ?? 'system';
	const unitsFilter    = options.exportedUnitsFilter ?? 'terminal';
	const TERMINAL_STATUSES = new Set(['validated', 'committed', 'complete', 'approved', 'skipped']);

	// ── Audit entries ───────────────────────────────────────────────────────
	const auditEntries = kb.getAuditLog();

	// ── Chain integrity ─────────────────────────────────────────────────────
	const chainResult = kb.verifyAuditLogIntegrity();

	// ── Unit summaries ───────────────────────────────────────────────────────
	let allUnits = kb.getAllUnits();
	if (unitsFilter === 'terminal') {
		allUnits = allUnits.filter(u => TERMINAL_STATUSES.has(u.status));
	}
	const unitSummaries: IAuditBundleUnitSummary[] = allUnits.map(u =>
		_buildUnitSummary(u),
	);

	// ── Decision summary ─────────────────────────────────────────────────────
	const decisions = kb.getDecisions();
	const decisionSummary: IAuditBundleDecisionSummary = {
		typeMappings:        decisions.typeMapping.length,
		namingDecisions:     decisions.naming.length,
		ruleInterpretations: decisions.ruleInterpret.length,
		exclusions:          decisions.exclusions.length,
		patternOverrides:    decisions.patternOverrides.length,
	};

	// ── Bundle hash ──────────────────────────────────────────────────────────
	// Canonicalise: sort entries by id, JSON-stringify, hash
	const canonicalEntriesJson = JSON.stringify(
		[...auditEntries].sort((a, b) => a.id.localeCompare(b.id)),
	);
	const bundleHash = _fnv1a(canonicalEntriesJson);

	// ── Assemble ─────────────────────────────────────────────────────────────
	const sessionId = kb.isActive ? kb.kb.sessionId : 'unknown';

	return {
		meta: {
			schemaVersion:      BUNDLE_SCHEMA_VERSION,
			sessionId,
			exportedAt:         Date.now(),
			exportedBy,
			totalUnits:         kb.getAllUnits().length,
			totalAuditEntries:  auditEntries.length,
		},
		auditEntries,
		unitSummaries,
		decisionSummary,
		integrity: {
			bundleHash,
			chainValid:       chainResult.valid,
			firstBrokenIndex: chainResult.firstBrokenIndex,
		},
	};
}

function _buildUnitSummary(u: IKnowledgeUnit): IAuditBundleUnitSummary {
	const eq: IEquivalenceResult | undefined = u.equivalenceResult;
	return {
		unitId:        u.id,
		unitName:      u.name,
		sourceLang:    u.sourceLang,
		riskLevel:     u.riskLevel,
		domain:        u.domain,
		status:        u.status,
		approvalCount: (u.approvals as IApprovalRecord[]).length,
		equivalence:   eq ? {
			testedAt:      eq.testedAt,
			testCaseCount: eq.testCaseCount,
			passCount:     eq.passCount,
			failCount:     eq.failCount,
			overridden:    eq.overridden,
		} : undefined,
		createdAt:     u.createdAt,
		updatedAt:     u.updatedAt,
	};
}


// ─── Serialisation ────────────────────────────────────────────────────────────

/** Serialise a bundle to an indented JSON string (safe to write to disk). */
export function formatAuditBundleAsJson(bundle: IAuditBundle): string {
	return JSON.stringify(bundle, null, 2);
}


// ─── Verification ─────────────────────────────────────────────────────────────

/**
 * Verify that a bundle has not been tampered with since export.
 *
 * Checks:
 * 1. `integrity.bundleHash` matches the recomputed hash of `auditEntries`.
 * 2. `integrity.chainValid` flag — informational (reflects state at export time).
 */
export function verifyAuditBundleIntegrity(bundle: IAuditBundle): { valid: boolean; message: string } {
	const canonical = JSON.stringify(
		[...bundle.auditEntries].sort((a, b) => a.id.localeCompare(b.id)),
	);
	const recomputed = _fnv1a(canonical);

	if (recomputed !== bundle.integrity.bundleHash) {
		return {
			valid: false,
			message: `Bundle hash mismatch — expected ${bundle.integrity.bundleHash}, got ${recomputed}. Entries may have been modified.`,
		};
	}

	if (!bundle.integrity.chainValid) {
		return {
			valid: false,
			message: `Audit chain broken at entry index ${bundle.integrity.firstBrokenIndex ?? '?'}. The KB audit log was not intact at export time.`,
		};
	}

	return { valid: true, message: 'Bundle integrity verified.' };
}
