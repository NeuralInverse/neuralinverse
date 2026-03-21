/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Source drift detection.
 *
 * After an initial scan we record a baseline (content hash + mtime + size) for
 * every source file. When a translation agent later requests context for a unit,
 * we compare the current disk state to the baseline. If drift is detected we
 * emit an ISourceDriftAlert — the unit status is moved back to 'pending' and the
 * human reviewer is notified via a pending decision.
 */

import {
	ISourceFileVersion,
	ISourceDriftAlert,
	IKnowledgeUnit,
} from '../../../common/knowledgeBaseTypes.js';
import { makeId } from './helpers.js';

// ─── Store ────────────────────────────────────────────────────────────────────

export interface IDriftStore {
	/** Baseline file versions recorded at scan time */
	sourceVersions: Map<string, ISourceFileVersion>; // filePath → version
	/** Active drift alerts (keyed by alertId) */
	driftAlerts:    Map<string, ISourceDriftAlert>;  // alertId → alert
}

export function createDriftStore(): IDriftStore {
	return {
		sourceVersions: new Map(),
		driftAlerts:    new Map(),
	};
}

// ─── Record baseline ──────────────────────────────────────────────────────────

export function recordSourceVersion(
	store: IDriftStore,
	filePath: string,
	contentHash: string,
	mtime: number,
	size: number,
): void {
	const version: ISourceFileVersion = {
		filePath,
		contentHash,
		mtime,
		size,
		recordedAt: Date.now(),
	};
	store.sourceVersions.set(filePath, version);
}

export function getSourceVersion(
	store: IDriftStore,
	filePath: string,
): ISourceFileVersion | undefined {
	return store.sourceVersions.get(filePath);
}

// ─── Drift check ──────────────────────────────────────────────────────────────

/**
 * Compare the current disk state of filePath against the recorded baseline.
 * Returns an ISourceDriftAlert if drift is detected (and stores it), or
 * undefined if the file is unchanged.
 */
export function checkSourceDrift(
	store: IDriftStore,
	filePath: string,
	currentHash: string,
	currentMtime: number,
): ISourceDriftAlert | undefined {
	const baseline = store.sourceVersions.get(filePath);
	if (!baseline) { return undefined; } // No baseline — can't detect drift

	if (baseline.contentHash === currentHash) { return undefined; } // Unchanged

	// Drift detected — check if we already have an active alert for this file
	for (const alert of store.driftAlerts.values()) {
		if (alert.filePath === filePath && !alert.acknowledgedAt) {
			// Existing unacknowledged alert — update with latest hash
			const updated: ISourceDriftAlert = {
				...alert,
				currentHash,
				currentMtime,
				detectedAt: alert.detectedAt, // preserve original detection time
			};
			store.driftAlerts.set(alert.id, updated);
			return updated;
		}
	}

	const alert: ISourceDriftAlert = {
		id:             makeId('da'),
		filePath,
		baselineHash:   baseline.contentHash,
		currentHash,
		baselineMtime:  baseline.mtime,
		currentMtime,
		detectedAt:     Date.now(),
		acknowledgedAt: undefined,
		acknowledgedBy: undefined,
	};
	store.driftAlerts.set(alert.id, alert);
	return alert;
}

/**
 * Batch drift check for all tracked files.
 * @param currentFiles  Array of {path, hash, mtime} reflecting current disk state.
 */
export function checkAllSourceDrift(
	store: IDriftStore,
	currentFiles: Array<{ path: string; hash: string; mtime: number }>,
): ISourceDriftAlert[] {
	const alerts: ISourceDriftAlert[] = [];
	for (const f of currentFiles) {
		const alert = checkSourceDrift(store, f.path, f.hash, f.mtime);
		if (alert) { alerts.push(alert); }
	}
	return alerts;
}

// ─── Acknowledgement ──────────────────────────────────────────────────────────

export function acknowledgeDriftAlert(
	store: IDriftStore,
	alertId: string,
	actor?: string,
): void {
	const alert = store.driftAlerts.get(alertId);
	if (!alert) { return; }
	store.driftAlerts.set(alertId, {
		...alert,
		acknowledgedAt: Date.now(),
		acknowledgedBy: actor,
	});
	// Update baseline so the same change doesn't re-trigger
	if (store.sourceVersions.has(alert.filePath)) {
		const existing = store.sourceVersions.get(alert.filePath)!;
		store.sourceVersions.set(alert.filePath, {
			...existing,
			contentHash: alert.currentHash,
			mtime:       alert.currentMtime,
			recordedAt:  Date.now(),
		});
	}
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function getDriftAlerts(
	store: IDriftStore,
	unacknowledgedOnly = false,
): ISourceDriftAlert[] {
	const all = Array.from(store.driftAlerts.values());
	return unacknowledgedOnly ? all.filter(a => !a.acknowledgedAt) : all;
}

/**
 * Return all units whose source file has an active (unacknowledged) drift alert.
 */
export function getUnitsAffectedByDrift(
	store: IDriftStore,
	units: Map<string, IKnowledgeUnit>,
): IKnowledgeUnit[] {
	const driftedPaths = new Set<string>();
	for (const alert of store.driftAlerts.values()) {
		if (!alert.acknowledgedAt) {
			driftedPaths.add(alert.filePath);
		}
	}
	if (driftedPaths.size === 0) { return []; }

	const result: IKnowledgeUnit[] = [];
	for (const unit of units.values()) {
		if (driftedPaths.has(unit.sourceFile)) {
			result.push(unit);
		}
	}
	return result;
}
