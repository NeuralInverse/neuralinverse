/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Cross-Project Pairer
 *
 * Matches source project units to target project units to identify partially
 * migrated code. This answers the key question: "Which target unit corresponds
 * to which source unit, and how confident are we?"
 *
 * ## Matching Strategy
 *
 * Pairings are scored 0\u20131 using a cascade of match strategies, highest
 * confidence first. The first strategy that exceeds its threshold wins:
 *
 * | Strategy              | Threshold | Description                                                  |
 * |-----------------------|-----------|--------------------------------------------------------------|
 * | exact-name            | 1.00      | Identical unit names (after normalisation)                    |
 * | normalized-name       | 0.85      | Names match after case fold + separator removal              |
 * | token-overlap         | 0.60\u20130.80 | Jaccard similarity on camelCase / snake_case tokens \u2265 0.60   |
 * | file-path-structure   | 0.40\u20130.65 | Matching path segments (e.g. /service/Account \u2192 AccountSvc)  |
 * | complexity-match      | 0.25\u20130.45 | Same CC ± 15%, same LOC ± 20%, same param count              |
 * | heuristic             | 0.15\u20130.35 | Language-specific naming convention mapping                   |
 *
 * Only the highest-confidence match per source unit is returned.
 * Confidence < 0.20 pairings are suppressed.
 *
 * ## COBOL \u2192 Java / TypeScript Name Mapping
 *
 * COBOL paragraphs like `CALC-INTEREST-RATE` are mapped to camelCase candidates
 * `calcInterestRate`, `calculateInterestRate`, `calcInterest` via:
 *  1. Remove `PROGRAM-ID$` prefix
 *  2. Strip common COBOL suffixes: -RTN, -PROC, -PARA, -SUB
 *  3. Convert `HYPHEN-CASE` \u2192 `camelCase`
 *
 * ## Duplicate Resolution
 *
 * If multiple source units match the same target unit, only the highest-scoring
 * pairing is kept for each target unit (no two sources can claim the same target).
 */

import { ICrossProjectPairing, IProjectScanResult, IMigrationUnit, PairingMatchReason } from './discoveryTypes.js';

// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Compute cross-project pairings between all source and target scan results.
 * Returns a flat list of the best-confidence pairings.
 */
export function pairProjects(
	sources: IProjectScanResult[],
	targets: IProjectScanResult[],
): ICrossProjectPairing[] {
	const all: ICrossProjectPairing[] = [];

	for (const src of sources) {
		for (const tgt of targets) {
			const pairs = pairProjectPair(src, tgt);
			all.push(...pairs);
		}
	}

	return all;
}

/**
 * Pair units from a single source project with a single target project.
 *
 * Cardinality model:
 *  - Each SOURCE unit maps to at most ONE target (best match wins).
 *  - Multiple source units MAY map to the same target \u2014 this is correct for
 *    micro\u2192mono migrations where many JS functions belong to one Java class.
 *
 * The old `claimed` map deduped by targetUnitId (one source per target).
 * That silently dropped every JS function after the first that matched a
 * given Java class, so only 1 of 10 functions got marked as committed.
 */
export function pairProjectPair(
	source: IProjectScanResult,
	target: IProjectScanResult,
): ICrossProjectPairing[] {
	const pairings: ICrossProjectPairing[] = [];

	// Build target lookup structures
	const targetIndex = buildTargetIndex(target.units);

	// Track which SOURCE units have already been matched \u2014 each source gets
	// at most one target (the best one). Multiple sources CAN share a target.
	const sourceClaimed = new Set<string>();

	for (const srcUnit of source.units) {
		if (sourceClaimed.has(srcUnit.id)) { continue; }
		const match = findBestMatch(srcUnit, source, targetIndex, target);
		if (!match || match.confidenceScore < 0.20) { continue; }

		pairings.push(match);
		sourceClaimed.add(srcUnit.id);
	}

	return pairings;
}


// \u2500\u2500\u2500 Index Building \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface ITargetIndex {
	byExact:      Map<string, IMigrationUnit>;    // exact name \u2192 unit
	byNorm:       Map<string, IMigrationUnit[]>;  // normalised name \u2192 ALL units sharing that key
	byTokenSet:   Map<string, IMigrationUnit[]>;  // each token \u2192 units containing it
	byPathSeg:    Map<string, IMigrationUnit[]>;  // path segment \u2192 units
	units:        IMigrationUnit[];
}

function buildTargetIndex(units: IMigrationUnit[]): ITargetIndex {
	const byExact    = new Map<string, IMigrationUnit>();
	const byNorm     = new Map<string, IMigrationUnit[]>();
	const byTokenSet = new Map<string, IMigrationUnit[]>();
	const byPathSeg  = new Map<string, IMigrationUnit[]>();

	for (const unit of units) {
		const name = unit.unitName;
		byExact.set(name, unit);

		// Store ALL units that share a normalised key \u2014 last-writer-wins was silently
		// dropping every unit after the first with the same normalised name.
		const norm     = normaliseName(name);
		const normList = byNorm.get(norm) ?? [];
		normList.push(unit);
		byNorm.set(norm, normList);

		for (const token of tokenise(name)) {
			const list = byTokenSet.get(token) ?? [];
			list.push(unit);
			byTokenSet.set(token, list);
		}

		for (const seg of pathSegments(unit.legacyFilePath)) {
			const list = byPathSeg.get(seg) ?? [];
			list.push(unit);
			byPathSeg.set(seg, list);
		}
	}

	return { byExact, byNorm, byTokenSet, byPathSeg, units };
}


// \u2500\u2500\u2500 Matching \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function findBestMatch(
	srcUnit: IMigrationUnit,
	source: IProjectScanResult,
	index: ITargetIndex,
	target: IProjectScanResult,
): ICrossProjectPairing | null {
	const srcName = srcUnit.unitName;

	// \u2500\u2500 1. Exact name \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const exact = index.byExact.get(srcName);
	if (exact) {
		return makePairing(source, target, srcUnit, exact, 1.0, 'exact-name');
	}

	// \u2500\u2500 2. COBOL \u2192 camelCase/PascalCase candidates \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (source.dominantLanguage === 'cobol') {
		for (const candidate of cobolToCandidates(srcName)) {
			const e2 = index.byExact.get(candidate);
			if (e2) { return makePairing(source, target, srcUnit, e2, 0.90, 'normalized-name'); }
			const normList = index.byNorm.get(normaliseName(candidate)) ?? [];
			if (normList.length === 1) {
				return makePairing(source, target, srcUnit, normList[0], 0.90, 'normalized-name');
			}
			if (normList.length > 1) {
				const best = _pickBestByTokenOverlap(candidate, normList, srcUnit.id);
				if (best) { return makePairing(source, target, srcUnit, best.unit, 0.85, 'normalized-name'); }
			}
		}
	}

	// \u2500\u2500 2b. JS/TS function \u2192 Java class candidates \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	// JS microservices decompose to function-level units (createOrder, getOrder)
	// while Java monoliths decompose to class-level (OrderService). Strip CRUD
	// verb prefixes to expose the domain noun, then try exact + norm lookup.
	if (source.dominantLanguage === 'javascript' || source.dominantLanguage === 'typescript') {
		for (const candidate of jsToCandidates(srcName)) {
			const e3 = index.byExact.get(candidate);
			if (e3) { return makePairing(source, target, srcUnit, e3, 0.80, 'normalized-name'); }
			const normList3 = index.byNorm.get(normaliseName(candidate)) ?? [];
			if (normList3.length === 1) {
				return makePairing(source, target, srcUnit, normList3[0], 0.75, 'normalized-name');
			}
			if (normList3.length > 1) {
				const best = _pickBestByTokenOverlap(candidate, normList3, srcUnit.id);
				if (best) { return makePairing(source, target, srcUnit, best.unit, 0.70, 'normalized-name'); }
			}
		}
	}

	// \u2500\u2500 3. Normalised name \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const normSrc    = normaliseName(srcName);
	const normedList = (index.byNorm.get(normSrc) ?? []).filter(u => u.id !== srcUnit.id);
	if (normedList.length === 1) {
		return makePairing(source, target, srcUnit, normedList[0], 0.85, 'normalized-name');
	}
	if (normedList.length > 1) {
		// Multiple targets share the same normalised key \u2014 break ties by token overlap
		const best = _pickBestByTokenOverlap(srcName, normedList, srcUnit.id);
		if (best) {
			const conf = Math.min(0.85, 0.65 + best.score * 0.20);
			return makePairing(source, target, srcUnit, best.unit, conf, 'normalized-name');
		}
	}

	// \u2500\u2500 4. Token overlap \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const srcTokens = new Set(tokenise(srcName));
	// Collect candidate units via token index
	const candidates = new Map<string, { unit: IMigrationUnit; sharedTokens: number }>();
	for (const tok of srcTokens) {
		for (const tgtUnit of (index.byTokenSet.get(tok) ?? [])) {
			const entry = candidates.get(tgtUnit.id) ?? { unit: tgtUnit, sharedTokens: 0 };
			entry.sharedTokens++;
			candidates.set(tgtUnit.id, entry);
		}
	}

	// Threshold: 0.45 instead of 0.60 \u2014 after the $-prefix fix COBOL paragraph
	// tokens are meaningful (e.g. ['open','account']) and a 0.60 Jaccard floor
	// was too strict for 2\u20133 token names with partial overlap.
	const TOKEN_JACCARD_THRESHOLD = 0.45;
	let bestToken: { unit: IMigrationUnit; score: number } | null = null;
	for (const { unit, sharedTokens } of candidates.values()) {
		const tgtTokens = new Set(tokenise(unit.unitName));
		const jaccard = sharedTokens / (srcTokens.size + tgtTokens.size - sharedTokens);
		if (jaccard >= TOKEN_JACCARD_THRESHOLD && (!bestToken || jaccard > bestToken.score)) {
			bestToken = { unit, score: jaccard };
		}
	}
	if (bestToken) {
		return makePairing(source, target, srcUnit, bestToken.unit, 0.45 + bestToken.score * 0.20, 'token-overlap');
	}

	// \u2500\u2500 5. File path structure \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	const srcSegs = new Set(pathSegments(srcUnit.legacyFilePath));
	let bestPath: { unit: IMigrationUnit; score: number } | null = null;
	for (const seg of srcSegs) {
		for (const tgtUnit of (index.byPathSeg.get(seg) ?? [])) {
			const tgtSegs = new Set(pathSegments(tgtUnit.legacyFilePath));
			const union = new Set([...srcSegs, ...tgtSegs]);
			const inter = [...srcSegs].filter(s => tgtSegs.has(s)).length;
			const jaccard = inter / union.size;
			if (jaccard >= 0.40 && (!bestPath || jaccard > bestPath.score)) {
				bestPath = { unit: tgtUnit, score: jaccard };
			}
		}
	}
	if (bestPath) {
		return makePairing(source, target, srcUnit, bestPath.unit, 0.40 + bestPath.score * 0.25, 'file-path-structure');
	}

	// \u2500\u2500 6. Complexity match \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
	if (srcUnit.legacyFingerprint) {
		const complexityMatch = findComplexityMatch(srcUnit, index.units);
		if (complexityMatch) {
			return makePairing(source, target, srcUnit, complexityMatch, 0.30, 'complexity-match');
		}
	}

	return null;
}

/**
 * Given a source name and a list of candidate target units that share the same
 * normalised key, pick the one with the highest token-overlap Jaccard score.
 * Returns null if the list is empty.
 */
function _pickBestByTokenOverlap(
	srcName: string,
	candidates: IMigrationUnit[],
	excludeId?: string,
): { unit: IMigrationUnit; score: number } | null {
	const srcToks = new Set(tokenise(srcName));
	let best: { unit: IMigrationUnit; score: number } | null = null;
	for (const unit of candidates) {
		if (unit.id === excludeId) { continue; }
		const tgtToks = new Set(tokenise(unit.unitName));
		const shared  = [...srcToks].filter(t => tgtToks.has(t)).length;
		const total   = srcToks.size + tgtToks.size - shared;
		const jaccard = total > 0 ? shared / total : 0;
		if (!best || jaccard > best.score) { best = { unit, score: jaccard }; }
	}
	return best;
}

function findComplexityMatch(srcUnit: IMigrationUnit, targets: IMigrationUnit[]): IMigrationUnit | null {
	// We don't have CC here directly, so use regulated fields count as a proxy
	const srcFields = srcUnit.legacyFingerprint?.regulatedFields.length ?? 0;

	// Zero regulated fields provides no meaningful complexity signal \u2014 every
	// unit with 0 fields would match every other, causing massive false positives.
	if (srcFields === 0) { return null; }

	let best: IMigrationUnit | null = null;
	let bestDiff = Infinity;

	for (const tgt of targets) {
		const tgtFields = tgt.legacyFingerprint?.regulatedFields.length ?? 0;
		if (tgtFields === 0) { continue; }  // same guard on target side
		const diff = Math.abs(tgtFields - srcFields);
		if (diff < bestDiff && diff <= 2) {
			bestDiff = diff;
			best = tgt;
		}
	}
	return best;
}


// \u2500\u2500\u2500 Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function makePairing(
	source: IProjectScanResult,
	target: IProjectScanResult,
	srcUnit: IMigrationUnit,
	tgtUnit: IMigrationUnit,
	confidenceScore: number,
	matchReason: PairingMatchReason,
): ICrossProjectPairing {
	return {
		sourceProjectId:  source.projectId,
		targetProjectId:  target.projectId,
		sourceUnitId:     srcUnit.id,
		targetUnitId:     tgtUnit.id,
		confidenceScore:  Math.min(1, Math.round(confidenceScore * 100) / 100),
		matchReason,
		targetHasFingerprint: !!tgtUnit.legacyFingerprint,
	};
}

/** Normalise a name: lowercase, strip separators, remove common suffixes. */
function normaliseName(name: string): string {
	return name
		// COBOL units are named "PROGRAM$PARAGRAPH" \u2014 strip the program-name prefix
		// so the paragraph name (the useful semantic part) drives matching.
		// Previous pattern was /\$[^$]*$/ which stripped from the LAST $ to the end,
		// i.e. it kept the program prefix and discarded the paragraph name \u2014 wrong.
		.replace(/^[^$]*\$/, '')
		.replace(/[-_$.]|([A-Z])/g, (_, u) => u ? `_${u.toLowerCase()}` : '') // camelCase \u2192 snake
		.toLowerCase()
		.replace(/[_\s]+/g, '')                         // strip separators
		.replace(/(service|handler|controller|processor|manager|helper|util|utils|impl|bean|repository|repo|dao|svc|cmp|component|bo|entity|mapper|converter)$/i, '');
}

/** Tokenise a name into meaningful words. */
function tokenise(name: string): string[] {
	// Split on camelCase, PascalCase, snake_case, COBOL-CASE, $ (unit ID separator).
	// Strip the PROGRAM-NAME$ prefix for COBOL units so tokens come from the
	// paragraph name, not from the (less useful) program name.
	return name
		.replace(/^[^$]*\$/, '')  // strip COBOL program-name prefix (was /\$[^$]*$/ \u2014 wrong direction)
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.split(/[-_$.\s]+/)
		.map(t => t.toLowerCase())
		.filter(t => t.length >= 2 && !STOP_WORDS.has(t));
}

/** Extract meaningful path segments from a file URI.
 *
 * Handles:
 * - Standard path segments: /src/services/OrderService.java \u2192 ['orderservice']
 * - JS dot-notation filenames: order.service.js \u2192 ['order'] (service is a stop)
 * - camelCase/PascalCase splitting: OrderService \u2192 ['order', 'service'] \u2192 ['order']
 *
 * This ensures `order.service.js` and `OrderService.java` share the segment
 * `'order'` for file-path-structure matching in cross-language migrations.
 */
function pathSegments(filePath: string): string[] {
	return filePath
		.replace(/\\/g, '/')
		.split('/')
		.filter(s => s.length > 0)
		// Strip the last file extension (e.g. '.java', '.js', '.ts')
		.map(s => s.replace(/\.[^.]+$/, ''))
		// Split by remaining dots (e.g. 'order.service' \u2192 ['order', 'service'])
		.flatMap(s => s.split('.'))
		// Split camelCase/PascalCase (e.g. 'OrderService' \u2192 ['Order', 'Service'])
		.flatMap(s => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(' '))
		.map(s => s.toLowerCase())
		.filter(s => s.length >= 2 && !PATH_STOP_SEGMENTS.has(s));
}

/** Convert a COBOL name to likely target-language name candidates. */
function cobolToCandidates(cobolName: string): string[] {
	// Strip leading program-id prefix: PROG$PARA-NAME \u2192 PARA-NAME
	const stripped = cobolName.includes('$') ? cobolName.split('$').slice(1).join('$') : cobolName;
	// Remove common COBOL suffixes
	const withoutSuffix = stripped.replace(/-(?:RTN|ROUTINE|PROC|PARA|SUB|SECT|SECTION|PROCESS|PROCESSING|CALC|CALCULATE)$/i, '');

	const toCamel = (s: string): string =>
		s.toLowerCase().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
	const toPascal = (s: string): string => {
		const c = toCamel(s);
		return c.charAt(0).toUpperCase() + c.slice(1);
	};

	const candidates = [
		toCamel(stripped),
		toPascal(stripped),
		toCamel(withoutSuffix),
		toPascal(withoutSuffix),
	];

	// Also try with 'calculate' prefix expansion
	const expanded = withoutSuffix.replace(/^CALC-/, 'CALCULATE-');
	if (expanded !== withoutSuffix) {
		candidates.push(toCamel(expanded), toPascal(expanded));
	}

	return [...new Set(candidates)];
}


/**
 * Convert a JS/TS function name to likely Java class name candidates.
 *
 * JS microservices use function-level units: `createOrder`, `getOrderById`,
 * `updateOrderStatus`. Java monoliths use class-level units: `OrderService`.
 * Strip CRUD verb prefixes to expose the domain noun, then produce both
 * camelCase and PascalCase variants so step 2b can match against the target index.
 *
 * Examples:
 *   createOrder     \u2192 ['Order', 'OrderService', 'OrderManager']  (exact candidates)
 *   getOrderById    \u2192 ['Order', 'OrderService']
 *   updateUserStatus \u2192 ['UserStatus', 'UserStatusService', 'User']
 */
function jsToCandidates(funcName: string): string[] {
	// Split camelCase into tokens: 'createOrderItem' \u2192 ['create', 'Order', 'Item']
	const parts = funcName
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.split(/\s+/);

	// Strip leading CRUD / query verbs
	const withoutVerb = JS_CRUD_VERBS.has(parts[0]?.toLowerCase()) ? parts.slice(1) : parts;
	if (withoutVerb.length === 0) { return []; }

	// Also strip trailing prepositions: 'getOrderById' \u2192 ['Order'] (strip 'By', 'Id')
	const trimmedEnd = withoutVerb.filter(p => !JS_TRAILING_WORDS.has(p.toLowerCase()));
	if (trimmedEnd.length === 0) { return []; }

	const toPascal = (toks: string[]): string =>
		toks.map(t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()).join('');
	const toCamel  = (toks: string[]): string => {
		const p = toPascal(toks);
		return p.charAt(0).toLowerCase() + p.slice(1);
	};

	const domainPascal = toPascal(trimmedEnd);
	const domainCamel  = toCamel(trimmedEnd);

	return [...new Set([
		domainPascal,
		domainCamel,
		`${domainPascal}Service`,
		`${domainPascal}Manager`,
		`${domainPascal}Handler`,
		`${domainPascal}Controller`,
		`${domainPascal}Repository`,
	])];
}

const JS_CRUD_VERBS = new Set([
	'create', 'add', 'insert', 'save', 'post',
	'get', 'find', 'fetch', 'load', 'read', 'list', 'query', 'search', 'retrieve',
	'update', 'edit', 'patch', 'modify', 'change', 'set',
	'delete', 'remove', 'destroy', 'purge', 'clear',
	'process', 'handle', 'execute', 'run', 'perform', 'invoke', 'call',
	'build', 'parse', 'format', 'transform', 'convert', 'map', 'resolve',
	'send', 'publish', 'emit', 'dispatch', 'notify',
	'validate', 'check', 'verify', 'assert', 'ensure',
]);

const JS_TRAILING_WORDS = new Set([
	'by', 'with', 'for', 'from', 'to', 'in',
	'id', 'ids', 'key', 'keys', 'name', 'names', 'type', 'types',
	'all', 'list', 'many', 'one', 'single',
]);

// \u2500\u2500\u2500 Stop Word Sets \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const STOP_WORDS = new Set([
	'the', 'and', 'or', 'in', 'of', 'to', 'is', 'it', 'for', 'at', 'by',
	'an', 'do', 'be', 'on', 'up', 'as', 'if', 'no', 'so', 'we', 'us',
	'get', 'set', 'run', 'new', 'add', 'use', 'put', 'end', 'out',
]);

const PATH_STOP_SEGMENTS = new Set([
	'src', 'main', 'java', 'kotlin', 'scala', 'python', 'resources',
	'com', 'org', 'net', 'io', 'app', 'api', 'lib', 'util', 'utils',
	'test', 'tests', 'spec', 'specs', 'browser', 'server', 'client',
	'service', 'services', 'controller', 'controllers', 'model', 'models',
	'view', 'views', 'handler', 'handlers', 'repository', 'repositories',
	'module', 'modules', 'component', 'components', 'domain', 'domains',
	'infrastructure', 'application', 'presentation', 'interfaces',
]);
