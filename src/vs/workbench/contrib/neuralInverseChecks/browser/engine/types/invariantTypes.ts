/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Types for the universal formal verification (invariant checking) system.
 *
 * Invariants are defined in `.inverse/invariants.json` and enforced by the
 * InvariantAnalyzer via three stacked analysis backends:
 *
 *   Layer 1 — Pattern backend   (all languages, regex-based, universal)
 *   Layer 2 — AST backend       (TypeScript / JavaScript, precise static analysis)
 *   Layer 3 — AI backend        (any language, contractReasonService, complex logic)
 */

// ─── Scope ───────────────────────────────────────────────────────────────────

/**
 * All supported invariant scopes.
 *
 * Universal scopes (work on any language via the pattern + AI backends):
 * - `value`           — variable/field satisfies an expression at every assignment point
 * - `precondition`    — expression must hold before calling any of `targetCalls`
 * - `postcondition`   — expression must hold after calling any of `targetCalls`
 * - `class-invariant` — expression holds after every public method on a tracked class/struct
 * - `resource-pair`   — every acquire call has a matching release call in the same scope
 * - `state-machine`   — only the transitions listed in `validTransitions` are permitted
 * - `temporal`        — `precedesCall` must appear before any of `targetCalls` in the same scope
 * - `loop-invariant`  — expression holds at every loop iteration entry
 *
 * Backward-compatible aliases (accepted and mapped to new scopes internally):
 * - `always`          \u2192 `value`
 * - `before-call`     \u2192 `precondition`
 * - `after-call`      \u2192 `postcondition`
 */
export type InvariantScope =
	| 'value'
	| 'precondition'
	| 'postcondition'
	| 'class-invariant'
	| 'resource-pair'
	| 'state-machine'
	| 'temporal'
	| 'loop-invariant'
	// Backward-compat aliases
	| 'always'
	| 'before-call'
	| 'after-call';

// ─── Definition ──────────────────────────────────────────────────────────────

/**
 * A single invariant definition.
 */
export interface IInvariantDefinition {
	/** Unique identifier, e.g. "INV-001" */
	id: string;

	/** Human-readable name, e.g. "Non-negative balance" */
	name: string;

	/**
	 * The invariant expression.
	 *
	 * Supported forms:
	 * - Simple:       `balance >= 0`
	 * - Compound:     `balance >= 0 && balance <= maxBalance`
	 * - Property:     `this.balance >= 0`,  `account.balance >= 0`
	 * - Relational:   `start <= end`
	 * - Null check:   `ptr != null`,  `handle != nullptr`,  `obj != None`
	 *
	 * For `resource-pair` and `state-machine` scopes this field is optional —
	 * those scopes use `acquirePattern`/`releasePattern` or
	 * `stateVariable`/`validTransitions` instead.
	 */
	expression: string;

	/** When and how this invariant is checked */
	scope: InvariantScope;

	/** Violation severity: "error", "warning", or "info" */
	severity: string;

	/** Whether this invariant is active (defaults to true) */
	enabled?: boolean;

	/** GRC domain (defaults to "formal-verification") */
	domain?: string;

	// ─── Scope-specific fields ────────────────────────────────────────────────

	/**
	 * Variables / property paths to track.
	 * Used by: `value`, `loop-invariant`
	 *
	 * If omitted the variable name from `expression` is used.
	 * e.g. `["balance"]`, `["this.balance", "account.balance"]`
	 */
	variables?: string[];

	/**
	 * Target function/method names.
	 * Used by: `precondition`, `postcondition`, `temporal`
	 *
	 * e.g. `["accessResource", "write"]`
	 */
	targetCalls?: string[];

	/**
	 * Class or struct name(s) whose public methods are watched.
	 * Used by: `class-invariant`
	 *
	 * e.g. `"AccountService"`,  `["Stack", "Queue"]`
	 * If omitted ALL classes in the file are watched.
	 */
	trackedClass?: string | string[];

	/**
	 * Regex matching the resource acquisition call.
	 * Used by: `resource-pair`
	 *
	 * e.g. `"\\bfopen\\s*\\("`,  `"\\bmutex_lock\\s*\\("`,  `"\\bnew\\b"`
	 */
	acquirePattern?: string;

	/**
	 * Regex matching the resource release call.
	 * Used by: `resource-pair`
	 *
	 * e.g. `"\\bfclose\\s*\\("`,  `"\\bmutex_unlock\\s*\\("`,  `"\\bdelete\\b"`
	 */
	releasePattern?: string;

	/**
	 * Variable / property path that holds the current state.
	 * Used by: `state-machine`
	 *
	 * e.g. `"state"`,  `"this.connectionState"`,  `"module_state"`
	 */
	stateVariable?: string;

	/**
	 * Permitted state-to-state transitions.
	 * Used by: `state-machine`
	 *
	 * Any assignment to `stateVariable` that produces a `to` value not
	 * present in this list is a violation.
	 * e.g. `[{from:"INIT",to:"RUNNING"},{from:"RUNNING",to:"STOPPED"}]`
	 */
	validTransitions?: Array<{ from: string; to: string }>;

	/**
	 * The call that must appear BEFORE any of `targetCalls` in the same scope.
	 * Used by: `temporal`
	 *
	 * e.g. `precedesCall: "authenticate"` + `targetCalls: ["accessResource"]`
	 * means `authenticate()` must be called before `accessResource()`.
	 */
	precedesCall?: string;

	/**
	 * Analysis backend preference.
	 * - `auto`    (default) — run all applicable layers and merge results
	 * - `pattern` — pattern layer only  (fast, universal, shallow)
	 * - `ast`     — AST layer only      (TS/JS, precise, no AI cost)
	 * - `ai`      — AI layer only       (any language, handles complex logic)
	 */
	backend?: 'auto' | 'pattern' | 'ast' | 'ai';
}

// ─── Config file shape ───────────────────────────────────────────────────────

/** Shape of `.inverse/invariants.json`. */
export interface IInvariantConfig {
	version: string;
	invariants: IInvariantDefinition[];
}

/** Default invariant config for new workspaces. */
export const DEFAULT_INVARIANT_CONFIG: IInvariantConfig = {
	version: '1.0',
	invariants: []
};

// ─── Expression Parsing ───────────────────────────────────────────────────────

/**
 * A single parsed expression atom.
 *
 * The left side supports property paths (e.g. `this.balance`, `account.balance`).
 * The right side supports literals and variable references for relational checks.
 */
export interface IParsedExpression {
	type: 'atom';
	/** Variable name or property path, e.g. "balance", "this.balance" */
	variable: string;
	operator: '>=' | '<=' | '==' | '!=' | '>' | '<';
	/** Literal value, or a variable/path name when valueIsVariable is true */
	value: string | number | boolean;
	/** True when the right side is a variable/path (relational check), not a literal */
	valueIsVariable?: boolean;
}

/**
 * A compound expression joined by a logical operator.
 */
export interface ICompoundExpression {
	type: 'compound';
	operator: '&&' | '||';
	left: ExpressionNode;
	right: ExpressionNode;
}

/** Either a simple atom or a compound expression tree node */
export type ExpressionNode = IParsedExpression | ICompoundExpression;

/**
 * Parse a single atom expression.
 * Left side may be a variable or property path (`word.word.word`).
 * Right side may be a literal or another variable/path.
 */
export function parseInvariantExpression(expression: string): IParsedExpression | undefined {
	const match = expression.trim().match(/^([\w.]+)\s*(>=|<=|==|!=|>|<)\s*(.+)$/);
	if (!match) {
		return undefined;
	}

	const [, variable, operator, rawValue] = match;
	const trimmedValue = rawValue.trim();

	let value: string | number | boolean;
	let valueIsVariable = false;

	if (trimmedValue === 'true') {
		value = true;
	} else if (trimmedValue === 'false') {
		value = false;
	} else if (['null', 'undefined', 'nullptr', 'NULL', 'None', 'nil'].includes(trimmedValue)) {
		value = trimmedValue;
	} else if (!isNaN(Number(trimmedValue))) {
		value = Number(trimmedValue);
	} else if (/^[\w.]+$/.test(trimmedValue)) {
		// Right side is a variable / property path — relational check
		value = trimmedValue;
		valueIsVariable = true;
	} else {
		// String literal (strip surrounding quotes)
		value = trimmedValue.replace(/^['"]|['"]$/g, '');
	}

	return {
		type: 'atom',
		variable,
		operator: operator as IParsedExpression['operator'],
		value,
		valueIsVariable: valueIsVariable || undefined,
	};
}

/**
 * Split an expression string on a logical operator (`&&` or `||`) at the
 * top level (not inside parentheses). Returns [left, right] or undefined.
 */
function _splitOnLogical(expr: string, op: '&&' | '||'): [string, string] | undefined {
	let depth = 0;
	for (let i = 0; i <= expr.length - op.length; i++) {
		const ch = expr[i];
		if (ch === '(') { depth++; continue; }
		if (ch === ')') { depth--; continue; }
		if (depth === 0 && expr.slice(i, i + op.length) === op) {
			const next = expr[i + op.length];
			if (next === '=' || next === op[0]) { continue; } // skip &&=, ||=, |||, &&&
			return [expr.slice(0, i).trim(), expr.slice(i + op.length).trim()];
		}
	}
	return undefined;
}

/**
 * Parse a compound invariant expression into an expression tree.
 *
 * Handles:
 * - Simple atom:       `balance >= 0`
 * - AND compound:      `balance >= 0 && balance <= 100`
 * - OR compound:       `mode == READ || mode == WRITE`
 * - Nested parens:     `(a >= 0 && a <= 10) || a == -1`
 * - Property path:     `this.balance >= 0`
 * - Relational:        `start <= end`
 * - Null/ptr check:    `ptr != null`,  `handle != nullptr`,  `obj != None`
 */
export function parseExpression(expression: string): ExpressionNode | undefined {
	const expr = expression.trim();
	if (!expr) { return undefined; }

	// Strip balanced outer parentheses
	if (expr.startsWith('(') && expr.endsWith(')')) {
		let depth = 0;
		let fullyWrapped = true;
		for (let i = 0; i < expr.length - 1; i++) {
			if (expr[i] === '(') { depth++; }
			else if (expr[i] === ')') { depth--; }
			if (depth === 0) { fullyWrapped = false; break; }
		}
		if (fullyWrapped) {
			const inner = parseExpression(expr.slice(1, -1));
			if (inner) { return inner; }
		}
	}

	// || has lower precedence — try it first
	const orSplit = _splitOnLogical(expr, '||');
	if (orSplit) {
		const left = parseExpression(orSplit[0]);
		const right = parseExpression(orSplit[1]);
		if (left && right) { return { type: 'compound', operator: '||', left, right }; }
	}

	const andSplit = _splitOnLogical(expr, '&&');
	if (andSplit) {
		const left = parseExpression(andSplit[0]);
		const right = parseExpression(andSplit[1]);
		if (left && right) { return { type: 'compound', operator: '&&', left, right }; }
	}

	return parseInvariantExpression(expr);
}

/**
 * Collect all variable / property-path names referenced in an expression tree.
 */
export function collectVariables(node: ExpressionNode): string[] {
	if (node.type === 'atom') {
		const vars = [node.variable];
		if (node.valueIsVariable && typeof node.value === 'string') { vars.push(node.value); }
		return vars;
	}
	return [...collectVariables(node.left), ...collectVariables(node.right)];
}

/**
 * Check whether a literal value violates a simple atom.
 * Returns true if violated, false if satisfied, undefined if indeterminate.
 */
export function atomViolates(
	atom: IParsedExpression,
	actual: number | string | boolean | null
): boolean | undefined {
	if (atom.valueIsVariable) { return undefined; }
	const exp = atom.value;
	switch (atom.operator) {
		case '>=': return typeof actual === 'number' && typeof exp === 'number' ? actual < exp : undefined;
		case '<=': return typeof actual === 'number' && typeof exp === 'number' ? actual > exp : undefined;
		case '>':  return typeof actual === 'number' && typeof exp === 'number' ? actual <= exp : undefined;
		case '<':  return typeof actual === 'number' && typeof exp === 'number' ? actual >= exp : undefined;
		case '==': return actual !== exp && String(actual) !== String(exp);
		case '!=': return actual === exp || String(actual) === String(exp);
		default:   return undefined;
	}
}

/**
 * Normalise legacy scope aliases to their canonical equivalents:
 * `always` \u2192 `value`,  `before-call` \u2192 `precondition`,  `after-call` \u2192 `postcondition`
 */
export function normaliseScope(scope: InvariantScope): InvariantScope {
	switch (scope) {
		case 'always':      return 'value';
		case 'before-call': return 'precondition';
		case 'after-call':  return 'postcondition';
		default:            return scope;
	}
}
