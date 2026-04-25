/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Call Graph Extractor
 *
 * Builds an intra-project call graph from raw call expressions collected during
 * unit decomposition. Works for every language the discovery engine supports —
 * from COBOL PERFORM chains to Java method dispatch to Python function calls.
 *
 * ## Algorithm
 *
 * 1. Collect all (unitId \u2192 rawCallExpression[]) entries from decomposed units.
 * 2. Build two lookup indexes over all known units:
 *    - `byExactName`  \u2192 `unitId`  (e.g. `CALC-INTEREST` \u2192 `prog::CALC-INTEREST`)
 *    - `byNormName`   \u2192 `unitId`  (snake_case / lowerCamelCase normalised)
 * 3. For each raw call expression, strip language noise and attempt resolution.
 * 4. Emit `ICallGraphEdge` with `resolved = true` if the callee was found in the
 *    same project; `resolved = false` for unresolved (external / dynamic) calls.
 *
 * ## Language Coverage
 *
 * | Language       | Call Pattern                                           |
 * |----------------|--------------------------------------------------------|
 * | COBOL          | PERFORM <para>, PERFORM <para> THRU <para>             |
 * | PL/I           | CALL <entry>, CALL <var>                               |
 * | RPG            | CALLP <proc>, CALL <ext>                               |
 * | JCL            | EXEC PGM=<name>, EXEC PROC=<name>                      |
 * | Java/Kotlin    | obj.method(), new Foo(), ClassName.staticMethod()      |
 * | Scala          | obj.method(), apply(), companion object calls          |
 * | C#             | obj.Method(), new Class(), Invoke()                    |
 * | Python         | func(), obj.method(), super().__init__()               |
 * | TypeScript/JS  | func(), obj.method(), new Cls(), require()             |
 * | Go             | pkg.Func(), method receiver calls                      |
 * | Rust           | func(), Struct::method(), trait.method()               |
 * | PHP            | func(), $obj->method(), ClassName::staticMethod()      |
 * | Ruby           | method_name, obj.method, Module.method                 |
 * | Swift          | func(), obj.method(), Type.staticMethod()              |
 * | Dart           | func(), obj.method(), Class.namedConstructor()         |
 * | Groovy         | method(), obj.method(), new Class()                    |
 * | PL/SQL         | CALL proc, proc_name(...), EXECUTE IMMEDIATE           |
 * | VB.NET         | Sub/Function calls, Module.Method()                    |
 */

import { ICallGraphEdge, IDecomposedUnit } from './discoveryTypes.js';

// ─── Public API ───────────────────────────────────────────────────────────────

export interface IRawCallEntry {
	fromUnitId: string;
	callExpression: string;
	lang: string;
	lineNumber?: number;
}

/**
 * Build an intra-project call graph from raw call entries.
 *
 * @param rawCalls    Flat list of (unitId, callExpression, lang) tuples
 * @param allUnitIds  All unit IDs in the project (for resolution)
 * @param unitNames   Map from unitId \u2192 unitName (for resolution)
 */
export function buildCallGraph(
	rawCalls: IRawCallEntry[],
	allUnitIds: string[],
	unitNames: Map<string, string>,
): ICallGraphEdge[] {
	// Build lookup maps
	const byExact   = new Map<string, string>();  // normalised name \u2192 unitId
	const byNorm    = new Map<string, string>();  // further normalised \u2192 unitId

	for (const id of allUnitIds) {
		const name = unitNames.get(id) ?? '';
		byExact.set(name.toUpperCase(), id);
		byNorm.set(normalise(name), id);
	}

	const edges: ICallGraphEdge[] = [];
	const seen = new Set<string>();

	for (const entry of rawCalls) {
		const calls = extractCallTargets(entry.callExpression, entry.lang);
		for (const call of calls) {
			const edgeKey = `${entry.fromUnitId}\u2192${call.target}`;
			if (seen.has(edgeKey)) { continue; }
			seen.add(edgeKey);

			// Attempt resolution
			const resolved = resolveCall(call.target, byExact, byNorm);
			if (resolved === entry.fromUnitId) { continue; }  // self-call, skip

			edges.push({
				fromId:         entry.fromUnitId,
				toId:           resolved ?? '',
				callExpression: call.raw,
				callType:       call.callType,
				lineNumber:     entry.lineNumber ?? 0,
				resolved:       !!resolved,
			});
		}
	}

	return edges;
}

/**
 * Extract raw call expressions from decomposed units.
 * Returns a flat list ready to pass to `buildCallGraph`.
 */
export function extractRawCallEntries(
	units: IDecomposedUnit[],
	unitIdMap: Map<string, string>,  // name \u2192 id (as assigned during decomp)
	lang: string,
): IRawCallEntry[] {
	const entries: IRawCallEntry[] = [];
	for (const unit of units) {
		const uid = unitIdMap.get(unit.name) ?? unit.name;
		for (const call of (unit.rawCalls ?? [])) {
			entries.push({ fromUnitId: uid, callExpression: call, lang });
		}
	}
	return entries;
}


// ─── Call Target Extraction ───────────────────────────────────────────────────

interface ICallTarget {
	target: string;
	raw: string;
	callType: ICallGraphEdge['callType'];
}

/**
 * Parse a raw call expression into one or more call targets.
 * Returns the normalised callee name(s) and call type.
 */
function extractCallTargets(expr: string, lang: string): ICallTarget[] {
	const results: ICallTarget[] = [];

	// ── COBOL ──────────────────────────────────────────────────────────────────
	if (lang === 'cobol') {
		// PERFORM PARA-NAME
		// PERFORM PARA-NAME THRU PARA-NAME-EXIT
		let m = /\bPERFORM\s+([\w-]+)(?:\s+THRU\s+([\w-]+))?/i.exec(expr);
		if (m) {
			results.push({ target: m[1].toUpperCase(), raw: expr, callType: 'perform' });
			if (m[2]) { results.push({ target: m[2].toUpperCase(), raw: expr, callType: 'perform' }); }
			return results;
		}
		// EXEC CICS LINK PROGRAM(...)
		m = /EXEC\s+CICS\s+LINK\s+PROGRAM\s*\(\s*['"]?([\w-]+)['"]?\s*\)/i.exec(expr);
		if (m) {
			results.push({ target: m[1].toUpperCase(), raw: expr, callType: 'exec-cics' });
			return results;
		}
		// EXEC CICS XCTL PROGRAM(...)
		m = /EXEC\s+CICS\s+XCTL\s+PROGRAM\s*\(\s*['"]?([\w-]+)['"]?\s*\)/i.exec(expr);
		if (m) {
			results.push({ target: m[1].toUpperCase(), raw: expr, callType: 'exec-cics' });
			return results;
		}
		// CALL 'PROGRAM-NAME'
		m = /\bCALL\s+['"]?([\w-]+)['"]?/i.exec(expr);
		if (m) {
			results.push({ target: m[1].toUpperCase(), raw: expr, callType: 'direct' });
			return results;
		}
	}

	// ── PL/I ───────────────────────────────────────────────────────────────────
	if (lang === 'pl1') {
		const m = /\bCALL\s+([\w.]+)/i.exec(expr);
		if (m) {
			results.push({ target: m[1], raw: expr, callType: 'direct' });
			return results;
		}
	}

	// ── RPG ────────────────────────────────────────────────────────────────────
	if (lang === 'rpg') {
		// CALLP proc(...)
		let m = /\bCALLP?\s+([\w]+)/i.exec(expr);
		if (m) {
			results.push({ target: m[1].toUpperCase(), raw: expr, callType: 'direct' });
			return results;
		}
		// CALL 'PROGRAM'
		m = /\bCALL\s+['"]?([\w]+)['"]?/i.exec(expr);
		if (m) {
			results.push({ target: m[1].toUpperCase(), raw: expr, callType: 'direct' });
			return results;
		}
	}

	// ── JCL ────────────────────────────────────────────────────────────────────
	if (lang === 'jcl') {
		// // STEP01 EXEC PGM=MYPROG
		let m = /EXEC\s+PGM\s*=\s*([\w]+)/i.exec(expr);
		if (m) {
			results.push({ target: m[1].toUpperCase(), raw: expr, callType: 'direct' });
			return results;
		}
		// // STEP02 EXEC MYPROC
		m = /EXEC\s+([\w]+)/i.exec(expr);
		if (m && m[1].toUpperCase() !== 'PGM') {
			results.push({ target: m[1].toUpperCase(), raw: expr, callType: 'direct' });
			return results;
		}
	}

	// ── PL/SQL ─────────────────────────────────────────────────────────────────
	if (lang === 'plsql' || lang === 'sql') {
		// CALL proc_name(...)
		let m = /\bCALL\s+([\w.]+)\s*\(/i.exec(expr);
		if (m) {
			results.push({ target: m[1], raw: expr, callType: 'direct' });
			return results;
		}
		// Direct procedure call: proc_name(...)
		m = /^([\w.]+)\s*\(/m.exec(expr.trim());
		if (m && !SQL_KEYWORDS.has(m[1].toUpperCase())) {
			results.push({ target: m[1], raw: expr, callType: 'direct' });
			return results;
		}
		// EXECUTE IMMEDIATE (dynamic)
		if (/EXECUTE\s+IMMEDIATE/i.test(expr)) {
			results.push({ target: '__dynamic__', raw: expr, callType: 'dynamic' });
			return results;
		}
	}

	// ── VB.NET / VBScript ──────────────────────────────────────────────────────
	if (lang === 'vb' || lang === 'vbnet') {
		// Call MethodName(...) or just MethodName(...)
		let m = /\bCall\s+([\w.]+)\s*\(/i.exec(expr);
		if (m) {
			results.push({ target: m[1], raw: expr, callType: 'direct' });
			return results;
		}
		// Sub / Function call without Call keyword
		m = /\b(Me|MyBase|Module\.\w+)\.([\w]+)\s*\(/i.exec(expr);
		if (m) {
			results.push({ target: m[2], raw: expr, callType: 'virtual' });
			return results;
		}
	}

	// ── Haskell ────────────────────────────────────────────────────────────────
	if (lang === 'haskell') {
		// function application: funcName arg1 arg2 (no parens required)
		const m = /^([\w']+)(?:\s|$)/.exec(expr.trim());
		if (m && !HASKELL_KEYWORDS.has(m[1])) {
			results.push({ target: m[1], raw: expr, callType: 'direct' });
			return results;
		}
	}

	// ── Erlang / Elixir ────────────────────────────────────────────────────────
	if (lang === 'erlang') {
		// Module:function(...)
		const m = /([\w@]+):([\w@]+)\s*\(/i.exec(expr);
		if (m) {
			results.push({ target: `${m[1]}:${m[2]}`, raw: expr, callType: 'direct' });
			return results;
		}
	}
	if (lang === 'elixir') {
		// Module.function(...) or function(...)
		let m = /([\w.]+)\.([\w?!]+)\s*\(/i.exec(expr);
		if (m) {
			results.push({ target: `${m[1]}.${m[2]}`, raw: expr, callType: 'direct' });
			return results;
		}
		m = /^([\w?!]+)\s*\(/m.exec(expr.trim());
		if (m && !ELIXIR_KEYWORDS.has(m[1])) {
			results.push({ target: m[1], raw: expr, callType: 'direct' });
			return results;
		}
	}

	// ── PHP ────────────────────────────────────────────────────────────────────
	if (lang === 'php') {
		// $obj->method(...)  or  ClassName::method(...)  or  func(...)
		let m = /\$\w+->([\w]+)\s*\(/i.exec(expr);
		if (m) { results.push({ target: m[1], raw: expr, callType: 'virtual' }); }
		m = /([\w\\]+)::([\w]+)\s*\(/i.exec(expr);
		if (m) { results.push({ target: m[2], raw: expr, callType: 'direct' }); }
		if (results.length === 0) {
			m = /^([\w\\]+)\s*\(/m.exec(expr.trim());
			if (m && !PHP_KEYWORDS.has(m[1].toLowerCase())) {
				results.push({ target: m[1], raw: expr, callType: 'direct' });
			}
		}
		return results;
	}

	// ── Ruby ───────────────────────────────────────────────────────────────────
	if (lang === 'ruby') {
		// obj.method  or  Module::method  or  method
		let m = /\.([\w?!]+)\s*[\(\s]/.exec(expr);
		if (m) { results.push({ target: m[1], raw: expr, callType: 'virtual' }); }
		m = /::([\w?!]+)\s*[\(\s]/.exec(expr);
		if (m) { results.push({ target: m[1], raw: expr, callType: 'direct' }); }
		if (results.length === 0) {
			m = /^([\w?!]+)\s*[\(\s\n]/.exec(expr.trim());
			if (m && !RUBY_KEYWORDS.has(m[1])) {
				results.push({ target: m[1], raw: expr, callType: 'direct' });
			}
		}
		return results;
	}

	// ── Swift ──────────────────────────────────────────────────────────────────
	if (lang === 'swift') {
		let m = /\.([\w]+)\s*\(/i.exec(expr);
		if (m) { results.push({ target: m[1], raw: expr, callType: 'virtual' }); }
		if (results.length === 0) {
			m = /^([\w]+)\s*\(/m.exec(expr.trim());
			if (m && !SWIFT_KEYWORDS.has(m[1])) {
				results.push({ target: m[1], raw: expr, callType: 'direct' });
			}
		}
		return results;
	}

	// ── Dart ───────────────────────────────────────────────────────────────────
	if (lang === 'dart') {
		let m = /\.([\w]+)\s*\(/i.exec(expr);
		if (m) { results.push({ target: m[1], raw: expr, callType: 'virtual' }); }
		if (results.length === 0) {
			m = /^([\w]+)\s*\(/m.exec(expr.trim());
			if (m && !DART_KEYWORDS.has(m[1])) {
				results.push({ target: m[1], raw: expr, callType: 'direct' });
			}
		}
		return results;
	}

	// ── Groovy ─────────────────────────────────────────────────────────────────
	if (lang === 'groovy') {
		let m = /\.([\w]+)\s*\(/i.exec(expr);
		if (m) { results.push({ target: m[1], raw: expr, callType: 'virtual' }); }
		if (results.length === 0) {
			m = /^([\w]+)\s*\(/m.exec(expr.trim());
			if (m && !GROOVY_KEYWORDS.has(m[1])) {
				results.push({ target: m[1], raw: expr, callType: 'direct' });
			}
		}
		return results;
	}

	// ── Lua ────────────────────────────────────────────────────────────────────
	if (lang === 'lua') {
		let m = /:([\w]+)\s*\(/i.exec(expr);   // method syntax obj:method()
		if (m) { results.push({ target: m[1], raw: expr, callType: 'virtual' }); }
		m = /\.([\w]+)\s*\(/i.exec(expr);
		if (m) { results.push({ target: m[1], raw: expr, callType: 'direct' }); }
		if (results.length === 0) {
			m = /^([\w]+)\s*\(/m.exec(expr.trim());
			if (m && !LUA_KEYWORDS.has(m[1])) {
				results.push({ target: m[1], raw: expr, callType: 'direct' });
			}
		}
		return results;
	}

	// ── Perl ───────────────────────────────────────────────────────────────────
	if (lang === 'perl') {
		let m = /->([\w]+)\s*\(/i.exec(expr);
		if (m) { results.push({ target: m[1], raw: expr, callType: 'virtual' }); }
		m = /([\w:]+)::([\w]+)\s*\(/i.exec(expr);
		if (m) { results.push({ target: m[2], raw: expr, callType: 'direct' }); }
		if (results.length === 0) {
			m = /^([\w]+)\s*\(/m.exec(expr.trim());
			if (m && !PERL_KEYWORDS.has(m[1])) {
				results.push({ target: m[1], raw: expr, callType: 'direct' });
			}
		}
		return results;
	}

	// ── C / C++ ────────────────────────────────────────────────────────────────
	if (lang === 'c' || lang === 'cpp') {
		// ptr->method(...)  or  obj.method(...)  or  func(...)
		let m = /(?:->|\.)(\w+)\s*\(/i.exec(expr);
		if (m) { results.push({ target: m[1], raw: expr, callType: 'virtual' }); }
		if (results.length === 0) {
			// ClassName::method(...)
			m = /(\w+)::([\w~]+)\s*\(/i.exec(expr);
			if (m) { results.push({ target: m[2], raw: expr, callType: 'direct' }); }
		}
		if (results.length === 0) {
			m = /^(\w+)\s*\(/m.exec(expr.trim());
			if (m && !C_KEYWORDS.has(m[1])) {
				results.push({ target: m[1], raw: expr, callType: 'direct' });
			}
		}
		return results;
	}

	// ── Go ─────────────────────────────────────────────────────────────────────
	if (lang === 'go') {
		// pkg.Func(...)  or  obj.Method(...)
		let m = /\.([\w]+)\s*\(/i.exec(expr);
		if (m) { results.push({ target: m[1], raw: expr, callType: 'direct' }); }
		if (results.length === 0) {
			m = /^([\w]+)\s*\(/m.exec(expr.trim());
			if (m && !GO_KEYWORDS.has(m[1])) {
				results.push({ target: m[1], raw: expr, callType: 'direct' });
			}
		}
		return results;
	}

	// ── Rust ───────────────────────────────────────────────────────────────────
	if (lang === 'rust') {
		// Type::method(...)  or  obj.method(...)
		let m = /::([\w]+)\s*\(/i.exec(expr);
		if (m) { results.push({ target: m[1], raw: expr, callType: 'direct' }); }
		m = /\.([\w]+)\s*\(/i.exec(expr);
		if (m) { results.push({ target: m[1], raw: expr, callType: 'virtual' }); }
		if (results.length === 0) {
			m = /^([\w]+)\s*\(/m.exec(expr.trim());
			if (m && !RUST_KEYWORDS.has(m[1])) {
				results.push({ target: m[1], raw: expr, callType: 'direct' });
			}
		}
		return results;
	}

	// ── Python ─────────────────────────────────────────────────────────────────
	if (lang === 'python') {
		// obj.method(...)  or  func(...)
		let m = /\.([\w]+)\s*\(/i.exec(expr);
		if (m) { results.push({ target: m[1], raw: expr, callType: 'virtual' }); }
		if (results.length === 0) {
			m = /^([\w]+)\s*\(/m.exec(expr.trim());
			if (m && !PYTHON_KEYWORDS.has(m[1])) {
				results.push({ target: m[1], raw: expr, callType: 'direct' });
			}
		}
		return results;
	}

	// ── Java / Kotlin / Scala / C# / TypeScript / JavaScript (default OO) ─────
	{
		// Chained: obj.method(...)  or  Class.staticMethod(...)
		let m = /\.([\w]+)\s*\(/ig;
		let hit: RegExpExecArray | null;
		while ((hit = m.exec(expr)) !== null) {
			results.push({ target: hit[1], raw: expr, callType: 'virtual' });
		}
		if (results.length === 0) {
			// Direct: func(...)  or  new Class(...)
			const nm = /^(?:new\s+)?([\w$]+)\s*\(/m.exec(expr.trim());
			if (nm) { results.push({ target: nm[1], raw: expr, callType: nm[0].startsWith('new') ? 'direct' : 'direct' }); }
		}
		return results;
	}
}


// ─── Resolution ───────────────────────────────────────────────────────────────

function resolveCall(
	target: string,
	byExact: Map<string, string>,
	byNorm: Map<string, string>,
): string | undefined {
	if (!target || target === '__dynamic__') { return undefined; }
	return byExact.get(target.toUpperCase()) ?? byNorm.get(normalise(target));
}

function normalise(name: string): string {
	// CamelCase \u2192 lower, hyphens/underscores stripped
	return name
		.replace(/([A-Z])/g, '_$1')
		.toLowerCase()
		.replace(/[-_\s.]+/g, '');
}


// ─── Keyword Sets (exclude from direct-call extraction) ───────────────────────

const SQL_KEYWORDS = new Set([
	'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'GRANT',
	'BEGIN', 'END', 'DECLARE', 'IF', 'LOOP', 'WHILE', 'FOR', 'CASE', 'WHEN',
	'FETCH', 'OPEN', 'CLOSE', 'COMMIT', 'ROLLBACK', 'EXCEPTION', 'RAISE',
]);

const GO_KEYWORDS = new Set([
	'func', 'if', 'else', 'for', 'range', 'switch', 'select', 'case', 'default',
	'return', 'break', 'continue', 'goto', 'fallthrough', 'defer', 'go', 'chan',
	'make', 'new', 'len', 'cap', 'append', 'copy', 'close', 'delete', 'panic',
	'recover', 'print', 'println',
]);

const RUST_KEYWORDS = new Set([
	'fn', 'let', 'mut', 'if', 'else', 'for', 'while', 'loop', 'match', 'return',
	'break', 'continue', 'struct', 'enum', 'impl', 'trait', 'pub', 'mod', 'use',
	'as', 'in', 'where', 'type', 'const', 'static', 'unsafe', 'async', 'await',
	'move', 'ref', 'box', 'dyn', 'super', 'self', 'Self', 'crate', 'extern',
	'Some', 'None', 'Ok', 'Err', 'vec', 'println', 'eprintln', 'format',
	'assert', 'panic', 'unimplemented', 'todo', 'unreachable',
]);

const PYTHON_KEYWORDS = new Set([
	'if', 'elif', 'else', 'for', 'while', 'with', 'try', 'except', 'finally',
	'raise', 'return', 'yield', 'from', 'import', 'as', 'pass', 'break',
	'continue', 'class', 'def', 'lambda', 'global', 'nonlocal', 'del',
	'assert', 'not', 'and', 'or', 'in', 'is', 'print', 'range', 'len',
	'list', 'dict', 'set', 'tuple', 'str', 'int', 'float', 'bool', 'type',
	'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr', 'delattr',
	'super', 'object', 'None', 'True', 'False',
]);

const C_KEYWORDS = new Set([
	'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break',
	'continue', 'return', 'goto', 'sizeof', 'typedef', 'struct', 'union', 'enum',
	'void', 'int', 'char', 'short', 'long', 'float', 'double', 'unsigned', 'signed',
	'const', 'static', 'extern', 'register', 'volatile', 'restrict', 'auto',
	'new', 'delete', 'class', 'public', 'private', 'protected', 'virtual',
	'override', 'final', 'template', 'typename', 'namespace', 'using', 'throw',
	'try', 'catch', 'nullptr', 'true', 'false',
]);

const PHP_KEYWORDS = new Set([
	'if', 'else', 'elseif', 'for', 'foreach', 'while', 'do', 'switch', 'case',
	'default', 'break', 'continue', 'return', 'function', 'class', 'interface',
	'abstract', 'extends', 'implements', 'new', 'static', 'public', 'private',
	'protected', 'echo', 'print', 'die', 'exit', 'require', 'require_once',
	'include', 'include_once', 'isset', 'empty', 'unset', 'list', 'array',
	'null', 'true', 'false', 'throw', 'try', 'catch', 'finally', 'match',
]);

const RUBY_KEYWORDS = new Set([
	'if', 'elsif', 'else', 'unless', 'for', 'while', 'until', 'do', 'end',
	'begin', 'rescue', 'ensure', 'retry', 'return', 'yield', 'raise', 'fail',
	'class', 'module', 'def', 'alias', 'undef', 'defined', 'self', 'super',
	'nil', 'true', 'false', 'and', 'or', 'not', 'in', 'then', 'case', 'when',
	'require', 'require_relative', 'include', 'extend', 'prepend', 'puts',
	'print', 'p', 'pp', 'gets', 'rand', 'exit', 'abort', 'loop', 'lambda',
	'proc', 'block_given', 'new', 'freeze', 'dup', 'clone',
]);

const SWIFT_KEYWORDS = new Set([
	'if', 'else', 'guard', 'for', 'while', 'repeat', 'switch', 'case', 'default',
	'break', 'continue', 'return', 'throw', 'try', 'catch', 'do', 'defer',
	'class', 'struct', 'enum', 'protocol', 'extension', 'func', 'init', 'deinit',
	'var', 'let', 'self', 'super', 'static', 'override', 'final', 'required',
	'lazy', 'weak', 'unowned', 'private', 'fileprivate', 'internal', 'public',
	'open', 'nil', 'true', 'false', 'in', 'where', 'as', 'is', 'typealias',
	'associatedtype', 'import', 'print', 'fatalError', 'precondition', 'assert',
]);

const DART_KEYWORDS = new Set([
	'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break',
	'continue', 'return', 'throw', 'try', 'catch', 'finally', 'rethrow',
	'class', 'abstract', 'interface', 'extends', 'implements', 'mixin', 'with',
	'new', 'const', 'final', 'var', 'dynamic', 'void', 'null', 'true', 'false',
	'this', 'super', 'static', 'factory', 'external', 'get', 'set', 'operator',
	'async', 'await', 'sync', 'yield', 'import', 'export', 'library', 'part',
	'show', 'hide', 'deferred', 'is', 'as', 'in', 'assert', 'print',
]);

const GROOVY_KEYWORDS = new Set([
	'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break',
	'continue', 'return', 'throw', 'try', 'catch', 'finally', 'class', 'interface',
	'extends', 'implements', 'new', 'static', 'def', 'void', 'null', 'true',
	'false', 'this', 'super', 'import', 'package', 'assert', 'println', 'print',
]);

const LUA_KEYWORDS = new Set([
	'if', 'then', 'else', 'elseif', 'end', 'for', 'while', 'repeat', 'until',
	'do', 'return', 'break', 'function', 'local', 'not', 'and', 'or', 'in',
	'nil', 'true', 'false', 'goto', 'print', 'tostring', 'tonumber', 'type',
	'pairs', 'ipairs', 'next', 'pcall', 'xpcall', 'error', 'assert', 'require',
	'load', 'loadfile', 'dofile', 'select', 'rawget', 'rawset', 'setmetatable',
	'getmetatable', 'rawequal', 'rawlen', 'unpack', 'table', 'string', 'math',
	'io', 'os', 'coroutine',
]);

const PERL_KEYWORDS = new Set([
	'if', 'elsif', 'else', 'unless', 'for', 'foreach', 'while', 'until', 'do',
	'given', 'when', 'default', 'next', 'last', 'redo', 'return', 'die', 'warn',
	'sub', 'my', 'our', 'local', 'use', 'require', 'package', 'BEGIN', 'END',
	'print', 'say', 'chomp', 'chop', 'push', 'pop', 'shift', 'unshift', 'splice',
	'keys', 'values', 'each', 'exists', 'delete', 'defined', 'undef',
]);

const HASKELL_KEYWORDS = new Set([
	'if', 'then', 'else', 'case', 'of', 'do', 'let', 'in', 'where', 'module',
	'import', 'data', 'type', 'newtype', 'class', 'instance', 'deriving',
	'infixl', 'infixr', 'infix', 'default', 'return', 'not', 'and', 'or',
	'fmap', 'pure', 'when', 'unless', 'forM', 'mapM', 'sequence', 'show',
	'read', 'print', 'putStr', 'putStrLn', 'getLine', 'error', 'undefined',
]);

const ELIXIR_KEYWORDS = new Set([
	'if', 'unless', 'cond', 'case', 'for', 'with', 'receive', 'try', 'rescue',
	'catch', 'after', 'raise', 'reraise', 'throw', 'exit', 'do', 'end', 'fn',
	'def', 'defp', 'defmodule', 'defstruct', 'defprotocol', 'defimpl',
	'defmacro', 'defmacrop', 'use', 'import', 'require', 'alias', 'quote',
	'unquote', 'super', 'nil', 'true', 'false', 'when', 'and', 'or', 'not',
	'in', 'is_nil', 'IO', 'Enum', 'List', 'Map', 'String', 'Kernel',
]);
