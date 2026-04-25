/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # API Compatibility Analyzer
 *
 * Evaluates each public API entry point discovered in the source project to
 * determine whether a compatible counterpart exists in the target project and
 * what backward-compatibility risk the migration carries.
 *
 * ## Compatibility Risk Classification
 *
 * | Risk   | Conditions                                                               |
 * |--------|--------------------------------------------------------------------------|
 * | high   | No target equivalent AND (CICS tx / external REST / gRPC service)        |
 * | high   | Target equivalent exists but signature appears changed                    |
 * | medium | No target equivalent AND (internal stored proc / batch / MQ listener)    |
 * | medium | Target equivalent exists, path/method matches but input/output types differ|
 * | low    | Target equivalent exists with matching path, method, and types            |
 * | low    | WebSocket / internal event handler without external callers               |
 *
 * ## Signature Change Detection
 *
 * Two entry points are considered "signature changed" when:
 *  - REST: HTTP method or path differs (after normalising trailing slashes)
 *  - gRPC: RPC method name differs
 *  - CICS: TRANSID / PROGRAM name differs
 *  - Batch: Scheduled class or cron expression differs
 *  - Stored Proc: Procedure name differs
 *
 * ## Source \u2192 Target Matching
 *
 * For each source-side API endpoint, the analyzer:
 *  1. Checks the cross-project pairing map for the unit ID
 *  2. If paired, finds the corresponding endpoint in the target project
 *  3. Compares signatures to detect changes
 *  4. Generates an IAPICompatibilityGate with the full assessment
 */

import {
	IAPIEndpoint,
	ICrossProjectPairing,
	IProjectScanResult,
} from '../discovery/discoveryTypes.js';
import { IAPICompatibilityGate } from './planningTypes.js';


// ─── Risk by endpoint kind ─────────────────────────────────────────────────────

/** Base compatibility risk for each endpoint kind when no target equivalent is found. */
const BASE_RISK_NO_TARGET: Record<string, 'low' | 'medium' | 'high'> = {
	'rest-get':            'high',
	'rest-post':           'high',
	'rest-put':            'high',
	'rest-patch':          'high',
	'rest-delete':         'high',
	'rest-generic':        'high',
	'soap-operation':      'high',
	'grpc-method':         'high',
	'cics-transaction':    'high',
	'cics-link':           'high',
	'jcl-exec-pgm':        'medium',
	'jcl-proc':            'medium',
	'mq-listener':         'medium',
	'batch-entry':         'medium',
	'stored-proc-public':  'medium',
	'event-handler':       'medium',
	'graphql-resolver':    'high',
	'websocket-handler':   'low',
};


// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyze all source-side API endpoints and produce IAPICompatibilityGate
 * assessments, one per endpoint.
 *
 * @param sourceProject  Source project scan result (has apiEndpoints + units)
 * @param targetProjects All target project scan results
 * @param pairings       Cross-project pairings from the discovery result
 */
export function analyzeAPICompatibility(
	sourceProject:  IProjectScanResult,
	targetProjects: IProjectScanResult[],
	pairings:       ICrossProjectPairing[],
): IAPICompatibilityGate[] {
	const gates: IAPICompatibilityGate[] = [];

	if (sourceProject.apiEndpoints.length === 0) { return gates; }

	// Build pairing lookup: sourceUnitId \u2192 best-confidence pairing
	const pairingBySrc = new Map<string, ICrossProjectPairing>();
	for (const p of pairings) {
		if (p.sourceProjectId !== sourceProject.projectId) { continue; }
		const existing = pairingBySrc.get(p.sourceUnitId);
		if (!existing || p.confidenceScore > existing.confidenceScore) {
			pairingBySrc.set(p.sourceUnitId, p);
		}
	}

	// Build target endpoint index: targetUnitId \u2192 IAPIEndpoint[]
	const targetEndpointsByUnit = new Map<string, IAPIEndpoint[]>();
	for (const tgt of targetProjects) {
		for (const ep of tgt.apiEndpoints) {
			if (!targetEndpointsByUnit.has(ep.unitId)) { targetEndpointsByUnit.set(ep.unitId, []); }
			targetEndpointsByUnit.get(ep.unitId)!.push(ep);
		}
	}

	// Build target unit name lookup: targetUnitId \u2192 unitName
	const targetUnitNames = new Map<string, string>();
	for (const tgt of targetProjects) {
		for (const u of tgt.units) { targetUnitNames.set(u.id, u.unitName); }
	}

	for (const srcEndpoint of sourceProject.apiEndpoints) {
		const pairing        = pairingBySrc.get(srcEndpoint.unitId);
		const targetUnitId   = pairing?.targetUnitId;
		const targetEndpoints = targetUnitId ? (targetEndpointsByUnit.get(targetUnitId) ?? []) : [];

		// Find the best-matching target endpoint
		const targetEndpoint = findBestTargetEndpoint(srcEndpoint, targetEndpoints);

		const hasTargetEquivalent = !!targetEndpoint;
		const signatureChanged    = hasTargetEquivalent
			? detectSignatureChange(srcEndpoint, targetEndpoint!)
			: false;

		const compatibilityRisk = computeCompatibilityRisk(
			srcEndpoint, hasTargetEquivalent, signatureChanged, pairing?.confidenceScore ?? 0,
		);

		const notes = buildCompatibilityNotes(
			srcEndpoint, targetEndpoint, hasTargetEquivalent, signatureChanged, compatibilityRisk, pairing,
		);

		gates.push({
			unitId:              srcEndpoint.unitId,
			endpointKind:        srcEndpoint.kind,
			path:                srcEndpoint.path,
			httpMethod:          srcEndpoint.httpMethod,
			operationName:       srcEndpoint.operationName,
			txCode:              srcEndpoint.txCode,
			targetUnitId:        targetUnitId,
			hasTargetEquivalent,
			compatibilityRisk,
			signatureChanged,
			notes,
		});
	}

	return gates;
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find the target endpoint that best matches the source endpoint.
 * Matching priority: same kind + same path/operation > same kind > any endpoint.
 */
function findBestTargetEndpoint(
	src: IAPIEndpoint,
	targets: IAPIEndpoint[],
): IAPIEndpoint | undefined {
	if (targets.length === 0) { return undefined; }

	// 1. Exact kind + path/operation match
	const exactMatch = targets.find(t => {
		if (t.kind !== src.kind) { return false; }
		if (src.path && t.path)            { return normPath(src.path) === normPath(t.path); }
		if (src.operationName && t.operationName) { return src.operationName === t.operationName; }
		if (src.txCode && t.txCode)        { return src.txCode === t.txCode; }
		return false;
	});
	if (exactMatch) { return exactMatch; }

	// 2. Same kind
	const kindMatch = targets.find(t => t.kind === src.kind);
	if (kindMatch) { return kindMatch; }

	// 3. Any endpoint in the target unit
	return targets[0];
}

/** Detect whether the API signature has changed between source and target. */
function detectSignatureChange(src: IAPIEndpoint, tgt: IAPIEndpoint): boolean {
	// HTTP method mismatch
	if (src.httpMethod && tgt.httpMethod && src.httpMethod !== tgt.httpMethod) { return true; }
	// Path mismatch (REST)
	if (src.path && tgt.path && normPath(src.path) !== normPath(tgt.path)) { return true; }
	// gRPC / SOAP / stored proc: operation name mismatch
	if (src.operationName && tgt.operationName && src.operationName !== tgt.operationName) { return true; }
	// CICS: transaction code mismatch
	if (src.txCode && tgt.txCode && src.txCode !== tgt.txCode) { return true; }
	// Input / output type mismatch (both must be present to compare)
	if (src.inputType && tgt.inputType && src.inputType !== tgt.inputType) { return true; }
	if (src.outputType && tgt.outputType && src.outputType !== tgt.outputType) { return true; }
	return false;
}

function computeCompatibilityRisk(
	src: IAPIEndpoint,
	hasTarget: boolean,
	signatureChanged: boolean,
	pairingConfidence: number,
): 'low' | 'medium' | 'high' {
	if (!hasTarget) {
		return (BASE_RISK_NO_TARGET[src.kind] ?? 'medium');
	}
	if (signatureChanged) { return 'high'; }
	// Target exists but pairing confidence is low
	if (pairingConfidence < 0.50) { return 'medium'; }
	return 'low';
}

function buildCompatibilityNotes(
	src: IAPIEndpoint,
	tgt: IAPIEndpoint | undefined,
	hasTarget: boolean,
	signatureChanged: boolean,
	risk: 'low' | 'medium' | 'high',
	pairing: ICrossProjectPairing | undefined,
): string {
	const lines: string[] = [];

	const endpointDesc = describeEndpoint(src);

	if (!hasTarget) {
		lines.push(
			`No target-side equivalent found for ${endpointDesc}. ` +
			`This endpoint must be re-implemented in the target project before cutover.`
		);
		if (risk === 'high') {
			lines.push(
				`HIGH RISK: This is a public-facing endpoint — any omission will cause ` +
				`service disruption or client contract breakage.`
			);
		}
	} else if (signatureChanged) {
		lines.push(
			`Target equivalent found (pairing confidence: ${Math.round((pairing?.confidenceScore ?? 0) * 100)}%) ` +
			`but API signature appears changed.`
		);
		if (src.httpMethod && tgt?.httpMethod && src.httpMethod !== tgt.httpMethod) {
			lines.push(`HTTP method changed: ${src.httpMethod} \u2192 ${tgt.httpMethod}.`);
		}
		if (src.path && tgt?.path && normPath(src.path) !== normPath(tgt.path)) {
			lines.push(`Path changed: "${src.path}" \u2192 "${tgt.path}".`);
		}
		if (src.operationName && tgt?.operationName && src.operationName !== tgt.operationName) {
			lines.push(`Operation name changed: "${src.operationName}" \u2192 "${tgt.operationName}".`);
		}
		lines.push(`Ensure all callers are updated or provide a backward-compatible adapter.`);
	} else {
		lines.push(
			`Target equivalent found (pairing confidence: ${Math.round((pairing?.confidenceScore ?? 0) * 100)}%). ` +
			`API signatures appear compatible.`
		);
		if (risk === 'medium') {
			lines.push(`Validate with integration tests before cutover.`);
		}
	}

	return lines.join(' ');
}

function describeEndpoint(ep: IAPIEndpoint): string {
	if (ep.httpMethod && ep.path) { return `${ep.httpMethod} ${ep.path}`; }
	if (ep.operationName)         { return `${ep.kind} "${ep.operationName}"`; }
	if (ep.txCode)                { return `CICS TRANSID "${ep.txCode}"`; }
	return `${ep.kind} endpoint (line ${ep.lineNumber})`;
}

function normPath(path: string): string {
	return path.trim().replace(/\/+$/, '').toLowerCase();
}
