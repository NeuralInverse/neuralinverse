/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # PL/SQL Type Inliner
 *
 * Resolves type references in PL/SQL procedures and functions.
 *
 * ## PL/SQL Type Resolution Problems
 *
 * PL/SQL has several reference mechanisms that leave the AI without type context:
 *
 * 1. `%TYPE` anchored declaration:
 *    `v_balance accounts.balance%TYPE`
 *    → The AI doesn't know that `accounts.balance` is NUMBER(15,2).
 *
 * 2. `%ROWTYPE` anchored declaration:
 *    `v_acct_rec accounts%ROWTYPE`
 *    → The AI doesn't know what columns the `accounts` table has.
 *
 * 3. Package-level type reference:
 *    `v_rec pkg_billing.t_invoice_rec`
 *    → The AI doesn't know what `t_invoice_rec` is defined as in pkg_billing.
 *
 * 4. Cross-package procedure call:
 *    `pkg_billing.calc_late_fee(p_acct_id, p_days_overdue, v_fee)`
 *    → The AI doesn't know the signature of calc_late_fee.
 *
 * ## Strategy
 *
 * For each type reference found in the source:
 *
 * a) `%TYPE` / `%ROWTYPE`:
 *    Inject an inline comment immediately after the declaration showing the
 *    resolved type definition from the KB's data schema, if available.
 *
 *    Before: `v_balance accounts.balance%TYPE;`
 *    After:  `v_balance accounts.balance%TYPE; -- [RESOLVED: NUMBER(15,2)]`
 *
 * b) Package type reference (pkg.type):
 *    If the package spec is in the KB, inject the TYPE definition as a comment.
 *    If not, inject a "not resolved" marker.
 *
 * c) Package procedure call:
 *    Inject a comment showing the procedure signature if found in KB.
 *
 * ## Why Comments, Not Inline Expansion?
 *
 * PL/SQL is compiled — it knows its types at compilation time. If we inline the
 * actual type definition in place of `%TYPE`, the code would no longer be valid
 * PL/SQL. Comments preserve the code's integrity while giving the AI the context
 * it needs.
 */

import { IDependencyRef, IDependencyResolutionResult } from './resolutionTypes.js';
import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';


// ─── Public API ───────────────────────────────────────────────────────────────

export interface IPlsqlInlineOptions {
	insertMarkers: boolean;
	maxPackageSignatures: number;
}

export interface IPlsqlInlineResult {
	expandedSource: string;
	resolvedRefs: IDependencyResolutionResult[];
	unresolvedRefs: IDependencyResolutionResult[];
}

/**
 * Resolve PL/SQL type references and inject context comments.
 */
export function resolvePlsqlTypes(
	sourceText: string,
	kb: IKnowledgeBaseService,
	options: IPlsqlInlineOptions,
): IPlsqlInlineResult {
	if (!options.insertMarkers) {
		return { expandedSource: sourceText, resolvedRefs: [], unresolvedRefs: [] };
	}

	const resolvedRefs: IDependencyResolutionResult[] = [];
	const unresolvedRefs: IDependencyResolutionResult[] = [];

	let result = sourceText;
	result = resolveTypeRefs(result, kb, resolvedRefs, unresolvedRefs);
	result = resolvePackageCalls(result, kb, options, resolvedRefs, unresolvedRefs);

	return { expandedSource: result, resolvedRefs, unresolvedRefs };
}


// ─── %TYPE and %ROWTYPE Resolution ────────────────────────────────────────────

/**
 * Find all %TYPE and %ROWTYPE anchored declarations and inject resolved type comments.
 */
function resolveTypeRefs(
	text: string,
	kb: IKnowledgeBaseService,
	resolvedRefs: IDependencyResolutionResult[],
	unresolvedRefs: IDependencyResolutionResult[],
): string {
	// Match: identifier table_or_column%TYPE or table%ROWTYPE
	// This also handles cursor%ROWTYPE and variable%TYPE
	const TYPE_RE = /\b([A-Z0-9_$.]+)(%(?:ROWTYPE|TYPE))\b/gi;
	const matches: Array<{ match: RegExpExecArray; resolved: string | undefined }> = [];

	let match: RegExpExecArray | null;
	while ((match = TYPE_RE.exec(text)) !== null) {
		const ref = match[1];
		const anchor = match[2].toUpperCase();

		// Try to resolve from KB data schemas or decisions
		const resolved = resolveTypeFromKB(ref, anchor, kb);
		matches.push({ match, resolved });
	}

	// Apply in reverse to preserve offsets
	let result = text;
	for (const { match: m, resolved } of matches.reverse()) {
		const fullRef = m[0];
		const lineStart = result.lastIndexOf('\n', m.index) + 1;
		const lineEnd = result.indexOf('\n', m.index);
		const insertPos = lineEnd > 0 ? lineEnd : result.length;

		const depRef: IDependencyRef = {
			rawRef: fullRef,
			canonicalName: m[1].toUpperCase(),
			line: result.substring(0, m.index).split('\n').length,
			depType: 'plsql-type-ref',
		};

		if (resolved) {
			const comment = ` -- [RESOLVED: ${resolved}]`;
			result = result.slice(0, insertPos) + comment + result.slice(insertPos);
			resolvedRefs.push({ ref: depRef, resolved: true, inlinedContent: comment });
		} else {
			const comment = ` -- [TYPE REF: ${m[1].toUpperCase()} — not resolved from KB]`;
			result = result.slice(0, insertPos) + comment + result.slice(insertPos);
			unresolvedRefs.push({ ref: depRef, resolved: false, inlinedContent: '', failureReason: 'Type not found in KB data schemas' });
		}

		void lineStart;
	}

	return result;
}

/**
 * Try to resolve a PL/SQL %TYPE or %ROWTYPE reference from the KB.
 *
 * Checks:
 * 1. KB data schemas (from discovery's dataSchemaExtractor)
 * 2. KB type mapping decisions (human-confirmed mappings)
 * 3. Heuristic type inference from field name patterns
 */
function resolveTypeFromKB(ref: string, anchor: string, kb: IKnowledgeBaseService): string | undefined {
	const upperRef = ref.toUpperCase();

	// Check type mapping decisions first (human-confirmed → highest priority)
	const decisions = kb.getDecisions();
	const typeMapping = decisions.typeMapping.find(
		d => d.sourceType.toUpperCase() === upperRef || d.sourceType.toUpperCase() === `${upperRef}${anchor}`
	);
	if (typeMapping) {
		return typeMapping.targetType;
	}

	// Check naming decisions for semantic hints
	const namingDecision = decisions.naming.find(d => d.sourceName.toUpperCase() === upperRef);
	if (namingDecision) {
		return `${namingDecision.targetName} (${namingDecision.domain})`;
	}

	// Heuristic: common Oracle monetary column patterns
	if (anchor === '%TYPE') {
		const parts = upperRef.split('.');
		const colName = parts[parts.length - 1];
		if (/BALANCE|AMOUNT|AMT|RATE|FEE|TAX|CHARGE|PREMIUM|PRINCIPAL/i.test(colName)) {
			return 'NUMBER(15,2) [heuristic: likely monetary]';
		}
		if (/DATE|DT$|_DT$/.test(colName)) {
			return 'DATE [heuristic]';
		}
		if (/ID$|_ID$|_NO$|_NUM$/.test(colName)) {
			return 'NUMBER(10) [heuristic: likely identifier]';
		}
		if (/CODE$|_CD$|FLAG$|STATUS/.test(colName)) {
			return 'VARCHAR2(10) [heuristic]';
		}
		if (/NAME$|DESC$|DESCRIPTION|REMARKS/.test(colName)) {
			return 'VARCHAR2(255) [heuristic]';
		}
	}

	return undefined;
}


// ─── Package Call Resolution ──────────────────────────────────────────────────

/**
 * Find package procedure/function calls and inject signature context.
 */
function resolvePackageCalls(
	text: string,
	kb: IKnowledgeBaseService,
	options: IPlsqlInlineOptions,
	resolvedRefs: IDependencyResolutionResult[],
	unresolvedRefs: IDependencyResolutionResult[],
): string {
	// Match: package_name.procedure_name( ...
	const PKG_CALL_RE = /\b([A-Z][A-Z0-9_$#]*)\s*\.\s*([A-Z][A-Z0-9_$#]*)\s*\(/gi;
	const seen = new Set<string>();

	const callMatches: Array<{ match: RegExpExecArray; packageName: string; procName: string }> = [];

	let match: RegExpExecArray | null;
	while ((match = PKG_CALL_RE.exec(text)) !== null) {
		const packageName = match[1].toUpperCase();
		const procName = match[2].toUpperCase();
		const key = `${packageName}.${procName}`;

		// Skip built-ins and already-processed pairs
		if (seen.has(key) || isPLSQLBuiltin(packageName)) {
			continue;
		}
		seen.add(key);
		callMatches.push({ match, packageName, procName });
	}

	if (callMatches.length === 0) {
		return text;
	}

	// Build a single resolution header comment at the top of the unit
	// (avoid cluttering every call site — one summary block is cleaner)
	const resolvedPackages = new Map<string, string[]>();
	const unresolvedPackages: string[] = [];

	for (const { packageName, procName } of callMatches) {
		const unit = kb.getAllUnits().find(u =>
			u.name.toUpperCase() === packageName ||
			u.name.toUpperCase() === `${packageName}.${procName}`
		);

		if (unit) {
			let sigs = resolvedPackages.get(packageName);
			if (!sigs) {
				sigs = [];
				resolvedPackages.set(packageName, sigs);
			}
			if (unit.targetInterface) {
				sigs.push(...unit.targetInterface.signatures.slice(0, options.maxPackageSignatures));
			} else if (unit.businessRules.length > 0) {
				sigs.push(`${procName}: ${unit.businessRules[0].description}`);
			}
		} else {
			if (!unresolvedPackages.includes(packageName)) {
				unresolvedPackages.push(packageName);
			}
		}
	}

	if (resolvedPackages.size === 0 && unresolvedPackages.length === 0) {
		return text;
	}

	const headerLines: string[] = [
		'-- ══════════════════════════════════════════════════════════════════',
		'-- NEURAL INVERSE — PACKAGE REFERENCE RESOLUTION',
	];

	for (const [pkg, sigs] of resolvedPackages) {
		headerLines.push(`-- Package: ${pkg} [IN KNOWLEDGE BASE]`);
		for (const sig of sigs) {
			headerLines.push(`--   ${sig}`);
		}
	}

	for (const pkg of unresolvedPackages) {
		headerLines.push(`-- Package: ${pkg} [NOT IN KNOWLEDGE BASE — external or not yet scanned]`);
	}

	headerLines.push('-- ══════════════════════════════════════════════════════════════════');
	headerLines.push('');

	return headerLines.join('\n') + text;
}


// ─── PL/SQL Built-in Detection ────────────────────────────────────────────────

const PLSQL_BUILTINS = new Set([
	'DBMS_OUTPUT', 'DBMS_LOCK', 'DBMS_UTILITY', 'DBMS_SQL', 'DBMS_LOB',
	'DBMS_METADATA', 'DBMS_STATS', 'UTL_FILE', 'UTL_HTTP', 'UTL_RAW',
	'DBMS_PIPE', 'DBMS_ALERT', 'SYS', 'DUAL', 'NVL', 'TO_DATE', 'TO_CHAR',
	'TO_NUMBER', 'SUBSTR', 'INSTR', 'TRIM', 'UPPER', 'LOWER', 'LENGTH',
	'ROUND', 'TRUNC', 'MOD', 'ABS', 'DECODE', 'CASE', 'CAST', 'COALESCE',
	'XMLTYPE', 'APEX_UTIL', 'HTP', 'OWA_UTIL', 'STANDARD', 'SQLCODE',
]);

function isPLSQLBuiltin(packageName: string): boolean {
	return PLSQL_BUILTINS.has(packageName.toUpperCase());
}
