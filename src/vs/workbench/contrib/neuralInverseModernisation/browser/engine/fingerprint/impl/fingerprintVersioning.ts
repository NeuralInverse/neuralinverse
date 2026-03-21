/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Fingerprint Versioning
 *
 * Manages the schema version for compliance fingerprints.
 *
 * ## Version Lifecycle
 *
 * FINGERPRINT_SCHEMA_VERSION is the single source of truth for the extraction schema.
 * It must be incremented whenever:
 *   - New field patterns are added to legacyPatternRegistry.ts
 *   - New invariant types are introduced
 *   - The LLM prompt structure changes significantly
 *   - New languages gain Layer 1 support
 *
 * When the version bumps, all stored fingerprints with an older version are considered
 * stale and are re-queued for extraction at low priority during the next session startup.
 *
 * ## Migration Guarantee
 *
 * Version migration NEVER blocks startup. Re-extraction happens as background work
 * via the FingerprintScheduler. Units with stale fingerprints remain usable — they
 * just have `schemaVersion < FINGERPRINT_SCHEMA_VERSION`, which is visible in the UI
 * as "fingerprint refresh pending".
 */

import { IModernisationKnowledgeBase } from '../../../../common/knowledgeBaseTypes.js';


// ─── Current Version ──────────────────────────────────────────────────────────

/**
 * Current fingerprint schema version.
 *
 * Increment this when extraction logic changes in a way that would produce
 * different fingerprint content for the same source code.
 *
 * History:
 *   1 — Initial schema: COBOL Layer 1 only
 *   2 — Added PL/SQL, RPG, NATURAL Layer 1 patterns
 *   3 — Added Java EE, Python, VB6 Layer 1 patterns
 *   4 — Added semanticRules, complianceDomains (Layer 2)
 *   5 — Added additionalInvariants from LLM (Layer 2 enrichment)
 *   6 — Added contentHash + schemaVersion fields to IComplianceFingerprint
 *   7 — Expanded COBOL paragraph patterns (EOD, MONTH-END, YEAR-END)
 */
export const FINGERPRINT_SCHEMA_VERSION = 7;


// ─── Stale Detection ─────────────────────────────────────────────────────────

/**
 * Returns true if the given fingerprint was produced with an older schema version
 * and should be re-extracted.
 *
 * A fingerprint with no schemaVersion field is always considered stale (it predates
 * versioning and was produced before this system was in place).
 */
export function isFingerprintStale(schemaVersion: number | undefined): boolean {
	if (schemaVersion === undefined || schemaVersion === null) {
		return true;
	}
	return schemaVersion < FINGERPRINT_SCHEMA_VERSION;
}


// ─── Schema Migration Scan ────────────────────────────────────────────────────

/**
 * Result of a schema migration scan.
 */
export interface ISchemaMigrationResult {
	/** Unit IDs that have stale fingerprints requiring re-extraction */
	staleUnitIds: string[];
	/** Unit IDs that have up-to-date fingerprints */
	currentUnitIds: string[];
	/** Unit IDs with no fingerprint at all */
	unfingerprintedUnitIds: string[];
	/** Total units scanned */
	totalUnitsScanned: number;
}

/**
 * Scan the knowledge base for units with stale or missing fingerprints.
 *
 * This is called at service startup. Results are passed to the FingerprintScheduler
 * to queue stale units for background re-extraction.
 *
 * This function does NOT trigger re-extraction — it only identifies what needs it.
 * The caller (FingerprintServiceImpl) passes the staleUnitIds to the scheduler.
 */
export function scanForStaleFingerprints(kb: IModernisationKnowledgeBase): ISchemaMigrationResult {
	const staleUnitIds: string[] = [];
	const currentUnitIds: string[] = [];
	const unfingerprintedUnitIds: string[] = [];

	for (const [unitId, unit] of kb.units) {
		if (!unit.fingerprint) {
			unfingerprintedUnitIds.push(unitId);
			continue;
		}

		if (isFingerprintStale(unit.fingerprint.schemaVersion)) {
			staleUnitIds.push(unitId);
		} else {
			currentUnitIds.push(unitId);
		}
	}

	return {
		staleUnitIds,
		currentUnitIds,
		unfingerprintedUnitIds,
		totalUnitsScanned: kb.units.size,
	};
}


// ─── Version Stamping ─────────────────────────────────────────────────────────

/**
 * Returns the current schema version.
 * Used by the fingerprint assembler to stamp new fingerprints.
 */
export function getCurrentSchemaVersion(): number {
	return FINGERPRINT_SCHEMA_VERSION;
}
