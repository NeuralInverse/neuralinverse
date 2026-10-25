/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Conditional Evaluator
 *
 * Safe expression evaluator for workflow branch conditions.
 * Uses a hand-rolled recursive descent parser — NO eval(), NO Function().
 *
 * ## Expression Language
 *
 * Property access:   $.key  $.nested.key  $.arr[0]
 * Comparison:        $.status === "done"   $.score > 0.8   $.count !== 0
 * Operators:         ===  !==  >  <  >=  <=
 * Helpers:           contains($.text, "LGTM")   length($.items) > 0
 *                    startsWith($.msg, "PASS")   endsWith($.file, ".ts")
 * Booleans:          expr && expr   expr || expr   !expr
 * Grouping:          (expr && expr) || expr
 *
 * The step output is parsed as JSON. If parsing fails, it is wrapped as
 * { "output": "<raw text>" } so $.output is always available.
 */

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Evaluate a mapping expression against a step's output string.
 * Returns the raw evaluated value (string, number, boolean, object, etc.).
 * Throws on syntax errors.
 */
export function evaluateExpression(output: string, expression: string): unknown {
	let data: Record<string, unknown>;
	try {
		const parsed = JSON.parse(output);
		data = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
			? parsed as Record<string, unknown>
			: { output: parsed };
	} catch {
		data = { output };
	}

	const tokens = _tokenize(expression);
	const parser = new _Parser(tokens, data);
	const result = parser.parseExpr();
	if (parser.pos < tokens.length) {
		throw new Error(`Unexpected token "${tokens[parser.pos].value}" at position ${parser.pos}`);
	}
	return result;
}

/**
 * Evaluate a condition expression against a step's output string.
 * Returns true/false. Throws on syntax errors.
 */
export function evaluateCondition(output: string, condition: string): boolean {
	let data: Record<string, unknown>;
	try {
		const parsed = JSON.parse(output);
		data = (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
			? parsed as Record<string, unknown>
			: { output: parsed };
	} catch {
		data = { output };
	}

	const tokens = _tokenize(condition);
	const parser = new _Parser(tokens, data);
	const result = parser.parseExpr();
	if (parser.pos < tokens.length) {
		throw new Error(`Unexpected token "${tokens[parser.pos].value}" at position ${parser.pos}`);
	}
	return _isTruthy(result);
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

type TokenKind =
	| 'dollar-path'  // $.key.subkey[0]
	| 'string'       // "hello" or 'hello'
	| 'number'       // 42, 3.14
	| 'bool'         // true, false
	| 'null'         // null
	| 'ident'        // contains, length, startsWith, endsWith
	| 'op'           // === !== > < >= <=
	| 'and'          // &&
	| 'or'           // ||
	| 'not'          // !
	| 'lparen'       // (
	| 'rparen'       // )
	| 'comma';       // ,

interface IToken { kind: TokenKind; value: string }

function _tokenize(expr: string): IToken[] {
	const tokens: IToken[] = [];
	let i = 0;

	while (i < expr.length) {
		// Skip whitespace
		if (/\s/.test(expr[i])) { i++; continue; }

		// Dollar-path: $.something[0].nested
		if (expr[i] === '$') {
			let j = i + 1;
			while (j < expr.length && /[\w.\[\]0-9]/.test(expr[j])) j++;
			tokens.push({ kind: 'dollar-path', value: expr.slice(i, j) });
			i = j;
			continue;
		}

		// String literal
		if (expr[i] === '"' || expr[i] === "'") {
			const quote = expr[i];
			let j = i + 1;
			let s = '';
			while (j < expr.length && expr[j] !== quote) {
				if (expr[j] === '\\' && j + 1 < expr.length) { s += expr[j + 1]; j += 2; }
				else { s += expr[j]; j++; }
			}
			tokens.push({ kind: 'string', value: s });
			i = j + 1;
			continue;
		}

		// Number
		if (/[0-9\-]/.test(expr[i]) && (expr[i] !== '-' || /[0-9]/.test(expr[i + 1] ?? ''))) {
			let j = i;
			if (expr[j] === '-') j++;
			while (j < expr.length && /[0-9.]/.test(expr[j])) j++;
			tokens.push({ kind: 'number', value: expr.slice(i, j) });
			i = j;
			continue;
		}

		// Three-char operators (must be checked before two-char)
		if (i + 2 < expr.length) {
			const three = expr.slice(i, i + 3);
			if (three === '===') { tokens.push({ kind: 'op', value: '===' }); i += 3; continue; }
			if (three === '!==') { tokens.push({ kind: 'op', value: '!==' }); i += 3; continue; }
		}

		// Two-char operators
		if (i + 1 < expr.length) {
			const two = expr.slice(i, i + 2);
			if (two === '>=') { tokens.push({ kind: 'op', value: '>=' }); i += 2; continue; }
			if (two === '<=') { tokens.push({ kind: 'op', value: '<=' }); i += 2; continue; }
			if (two === '&&') { tokens.push({ kind: 'and', value: '&&' }); i += 2; continue; }
			if (two === '||') { tokens.push({ kind: 'or', value: '||' }); i += 2; continue; }
		}

		// Single-char operators
		if (expr[i] === '>') { tokens.push({ kind: 'op', value: '>' }); i++; continue; }
		if (expr[i] === '<') { tokens.push({ kind: 'op', value: '<' }); i++; continue; }
		if (expr[i] === '!') { tokens.push({ kind: 'not', value: '!' }); i++; continue; }
		if (expr[i] === '(') { tokens.push({ kind: 'lparen', value: '(' }); i++; continue; }
		if (expr[i] === ')') { tokens.push({ kind: 'rparen', value: ')' }); i++; continue; }
		if (expr[i] === ',') { tokens.push({ kind: 'comma', value: ',' }); i++; continue; }

		// Identifier / keyword
		if (/[a-zA-Z_]/.test(expr[i])) {
			let j = i;
			while (j < expr.length && /[\w]/.test(expr[j])) j++;
			const word = expr.slice(i, j);
			if (word === 'true' || word === 'false') tokens.push({ kind: 'bool', value: word });
			else if (word === 'null') tokens.push({ kind: 'null', value: 'null' });
			else tokens.push({ kind: 'ident', value: word });
			i = j;
			continue;
		}

		throw new Error(`Unexpected character "${expr[i]}" at position ${i}`);
	}

	return tokens;
}

// ─── Recursive Descent Parser ─────────────────────────────────────────────────

class _Parser {
	pos = 0;
	constructor(private readonly tokens: IToken[], private readonly data: Record<string, unknown>) {}

	// expr = comparison (('&&'|'||') comparison)*
	parseExpr(): unknown {
		let left = this._parseComparison();
		while (this.pos < this.tokens.length) {
			const tok = this.tokens[this.pos];
			if (tok.kind === 'and') {
				this.pos++;
				const right = this._parseComparison();
				left = _isTruthy(left) && _isTruthy(right);
			} else if (tok.kind === 'or') {
				this.pos++;
				const right = this._parseComparison();
				left = _isTruthy(left) || _isTruthy(right);
			} else {
				break;
			}
		}
		return left;
	}

	private _parseComparison(): unknown {
		const left = this._parseUnary();
		if (this.pos >= this.tokens.length) return left;

		const tok = this.tokens[this.pos];
		if (tok.kind === 'op') {
			this.pos++;
			const right = this._parseUnary();
			return _compare(left, tok.value, right);
		}
		return left;
	}

	private _parseUnary(): unknown {
		if (this.pos < this.tokens.length && this.tokens[this.pos].kind === 'not') {
			this.pos++;
			return !_isTruthy(this._parsePrimary());
		}
		return this._parsePrimary();
	}

	private _parsePrimary(): unknown {
		const tok = this.tokens[this.pos];

		if (!tok) throw new Error('Unexpected end of expression');

		// Grouped expression
		if (tok.kind === 'lparen') {
			this.pos++;
			const val = this.parseExpr();
			if (this.tokens[this.pos]?.kind !== 'rparen') throw new Error('Expected closing ")"');
			this.pos++;
			return val;
		}

		// Literals
		if (tok.kind === 'string') { this.pos++; return tok.value; }
		if (tok.kind === 'number') { this.pos++; return parseFloat(tok.value); }
		if (tok.kind === 'bool') { this.pos++; return tok.value === 'true'; }
		if (tok.kind === 'null') { this.pos++; return null; }

		// Dollar-path access
		if (tok.kind === 'dollar-path') {
			this.pos++;
			return _resolvePath(this.data, tok.value);
		}

		// Helper functions: contains(), length(), startsWith(), endsWith()
		if (tok.kind === 'ident') {
			const name = tok.value;
			if (['contains', 'length', 'startsWith', 'endsWith'].includes(name)) {
				this.pos++;
				if (this.tokens[this.pos]?.kind !== 'lparen') throw new Error(`Expected "(" after ${name}`);
				this.pos++;
				const args: unknown[] = [this.parseExpr()];
				while (this.tokens[this.pos]?.kind === 'comma') {
					this.pos++;
					args.push(this.parseExpr());
				}
				if (this.tokens[this.pos]?.kind !== 'rparen') throw new Error(`Expected ")" after ${name} args`);
				this.pos++;
				return _callHelper(name, args);
			}
			throw new Error(`Unknown function "${name}"`);
		}

		throw new Error(`Unexpected token "${tok.value}" (${tok.kind})`);
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _isTruthy(val: unknown): boolean {
	if (val === null || val === undefined || val === false || val === 0 || val === '') return false;
	if (Array.isArray(val) && val.length === 0) return false;
	return true;
}

function _compare(left: unknown, op: string, right: unknown): boolean {
	switch (op) {
		case '===': return left === right;
		case '!==': return left !== right;
		case '>':   return (left as number) > (right as number);
		case '<':   return (left as number) < (right as number);
		case '>=':  return (left as number) >= (right as number);
		case '<=':  return (left as number) <= (right as number);
		default: throw new Error(`Unknown operator "${op}"`);
	}
}

function _callHelper(name: string, args: unknown[]): unknown {
	switch (name) {
		case 'contains': {
			const [haystack, needle] = args;
			if (typeof haystack === 'string' && typeof needle === 'string') return haystack.includes(needle);
			if (Array.isArray(haystack)) return haystack.includes(needle);
			return false;
		}
		case 'length': {
			const [val] = args;
			if (typeof val === 'string' || Array.isArray(val)) return val.length;
			if (typeof val === 'object' && val !== null) return Object.keys(val).length;
			return 0;
		}
		case 'startsWith': {
			const [str, prefix] = args;
			return typeof str === 'string' && typeof prefix === 'string' && str.startsWith(prefix);
		}
		case 'endsWith': {
			const [str, suffix] = args;
			return typeof str === 'string' && typeof suffix === 'string' && str.endsWith(suffix);
		}
		default: return undefined;
	}
}

/** Resolve a dollar-path like $.key.nested[0] against an object. */
function _resolvePath(data: Record<string, unknown>, path: string): unknown {
	// path starts with '$', strip it
	const parts = path.slice(1); // remove '$'
	if (!parts) return data;

	let current: unknown = data;
	// Split on '.' but handle array brackets
	const segments = parts.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);

	for (const seg of segments) {
		if (current === null || current === undefined) return undefined;
		if (typeof current === 'object') {
			current = (current as Record<string, unknown>)[seg];
		} else {
			return undefined;
		}
	}
	return current;
}
