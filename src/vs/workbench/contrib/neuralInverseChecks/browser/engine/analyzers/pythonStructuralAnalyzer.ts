/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Python Structural Analyzer
 *
 * Handles `type: "ast"` and `type: "dataflow"` rules for Python files.
 *
 * Uses a line-state machine parser (NOT a full Python parser) to cover
 * the most important security and compliance patterns:
 *
 * ## AST Mode
 * - Parses Python scopes (functions, classes, methods) by indentation tracking
 * - Evaluates constraint expressions (isAsync, !hasTryCatch, paramCount, etc.)
 * - Detects callee matches and property access patterns
 *
 * ## DataFlow Mode
 * - Tracks tainted variables from configurable sources (request.args, input(), etc.)
 * - Propagates taint through assignments
 * - Flags taint reaching configurable sinks (cursor.execute, os.system, eval, etc.)
 * - Respects sanitizer functions to eliminate false positives
 *
 * ## Language guard
 * - Only fires on `.py` and `.pyw` files
 * - Registered with `supportedLanguages = ['python']`
 */

import { ITextModel } from '../../../../../../editor/common/model.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IGRCRule, ICheckResult, toDisplaySeverity } from '../types/grcTypes.js';
import { IRuleAnalyzer } from '../services/grcEngineService.js';
import { INanoAgentContext } from '../../nanoAgents/projectAnalyzerService.js';
import { IAstCheck, IDataFlowCheck } from '../framework/frameworkSchema.js';


// ─── Python Scope ────────────────────────────────────────────────────────────

interface IPythonScope {
	type: 'function' | 'method' | 'class' | 'module';
	name: string;
	startLine: number; // 1-based
	endLine: number;   // 1-based
	isAsync: boolean;
	decorators: string[];
	params: string[];
	indentLevel: number;
	bodyLines: string[];
}


// ─── Taint State ─────────────────────────────────────────────────────────────

interface ITaintState {
	/** Variables currently holding tainted data */
	taintedVars: Set<string>;
	/** Taint propagation trace for reporting */
	trace: Array<{ line: number; label: string }>;
}


// ─── Default Sources / Sinks / Sanitizers ────────────────────────────────────

const PYTHON_DEFAULT_SOURCES: string[] = [
	'request.args', 'request.form', 'request.json', 'request.data',
	'request.get_json()', 'request.values', 'request.cookies',
	'flask.request', 'django.http.request',
	'input(', 'sys.stdin', 'os.environ', 'os.getenv(',
];

const PYTHON_DEFAULT_SINKS: string[] = [
	'cursor.execute(', 'db.execute(', 'session.execute(', 'connection.execute(',
	'os.system(', 'subprocess.call(', 'subprocess.run(', 'subprocess.Popen(',
	'subprocess.check_output(',
	'eval(', 'exec(', 'compile(',
	'open(', 'render_template(', 'redirect(',
];

const PYTHON_DEFAULT_SANITIZERS: string[] = [
	'escape(', 'bleach.clean(', 'html.escape(', 're.escape(', 'validate(',
	'sanitize(', 'clean(', 'strip(', 'quote(',
];


// ─── Implementation ──────────────────────────────────────────────────────────

export class PythonStructuralAnalyzer implements IRuleAnalyzer {

	readonly supportedTypes: string[] = ['ast', 'dataflow'];

	/**
	 * Only handle Python files — the engine checks this before dispatching.
	 */
	readonly supportedLanguages: string[] = ['python'];


	// ─── IRuleAnalyzer.evaluate (open text model) ──────────────────────

	evaluate(
		rule: IGRCRule,
		model: ITextModel,
		fileUri: URI,
		timestamp: number,
		_context?: INanoAgentContext
	): ICheckResult[] {
		const content = model.getValue();
		const langId = model.getLanguageId();
		return this.evaluateContent(rule, content, fileUri, langId, timestamp);
	}


	// ─── IRuleAnalyzer.evaluateContent (background scanning) ──────────

	evaluateContent(
		rule: IGRCRule,
		content: string,
		fileUri: URI,
		_languageId: string,
		timestamp: number
	): ICheckResult[] {
		try {
			const ruleType = rule.type ?? 'ast';

			if (ruleType === 'ast') {
				return this._evaluateAstRule(rule, content, fileUri, timestamp);
			}
			if (ruleType === 'dataflow') {
				return this._evaluateDataFlowRule(rule, content, fileUri, timestamp);
			}
			return [];
		} catch (e) {
			console.error(`[PythonAnalyzer] Error evaluating rule ${rule.id} on ${fileUri.path.split('/').pop()}:`, e);
			return [];
		}
	}


	// ─── AST Rule Evaluation ──────────────────────────────────────────

	private _evaluateAstRule(
		rule: IGRCRule,
		content: string,
		fileUri: URI,
		timestamp: number
	): ICheckResult[] {
		const check = rule.check as IAstCheck | undefined;
		if (!check || check.type !== 'ast') return [];

		const lines = content.split('\n');
		const scopes = this._parseScopes(lines);
		const results: ICheckResult[] = [];
		const fileName = fileUri.path.split('/').pop() ?? '';

		// File-level feature flags (computed once per file)
		const fileFeatures = this._computeFileFeatures(content, lines);

		for (const scope of scopes) {
			// Match nodeType
			if (!this._matchesNodeType(check.match.nodeType, scope)) continue;

			// Match callee if specified
			if (check.match.callee && check.match.callee.length > 0) {
				const calleMatched = check.match.callee.some(callee =>
					scope.bodyLines.some(bl => this._lineCallsCallee(bl, callee))
				);
				if (!calleMatched) continue;
			}

			// Evaluate constraint if specified
			if (check.match.constraint) {
				const satisfied = this._evaluateConstraint(
					check.match.constraint, scope, fileFeatures, fileName
				);
				if (!satisfied) continue;
			}

			// Violation found — build result
			const violationLine = scope.startLine;
			const offendingLineText = (lines[violationLine - 1] ?? '').trim().slice(0, 120);

			results.push({
				ruleId: rule.id,
				domain: rule.domain,
				severity: toDisplaySeverity(rule.severity),
				message: rule.message,
				fileUri,
				line: violationLine,
				column: 1,
				endLine: violationLine,
				endColumn: offendingLineText.length + 1,
				codeSnippet: offendingLineText,
				fix: rule.fix,
				timestamp,
				frameworkId: rule.frameworkId,
				references: rule.references,
				blockingBehavior: rule.blockingBehavior,
				checkSource: 'static',
			});
		}

		return results;
	}


	// ─── DataFlow Rule Evaluation ─────────────────────────────────────

	private _evaluateDataFlowRule(
		rule: IGRCRule,
		content: string,
		fileUri: URI,
		timestamp: number
	): ICheckResult[] {
		const check = rule.check as IDataFlowCheck | undefined;
		if (!check || check.type !== 'dataflow') return [];

		const lines = content.split('\n');
		const results: ICheckResult[] = [];

		const sources = check.taint.sources.length > 0 ? check.taint.sources : PYTHON_DEFAULT_SOURCES;
		const sinks = check.taint.sinks.length > 0 ? check.taint.sinks : PYTHON_DEFAULT_SINKS;
		const sanitizers = (check.taint.sanitizers && check.taint.sanitizers.length > 0)
			? check.taint.sanitizers
			: PYTHON_DEFAULT_SANITIZERS;

		// Taint state: variable name → taint origin label
		const taintState: ITaintState = {
			taintedVars: new Set<string>(),
			trace: [],
		};

		for (let i = 0; i < lines.length; i++) {
			const lineNum = i + 1;
			const line = lines[i];
			const trimmed = line.trim();

			// Skip blank lines and pure comments
			if (!trimmed || trimmed.startsWith('#')) continue;

			// Check if line is sanitized (any sanitizer call present)
			const isSanitized = sanitizers.some(san => line.includes(san));

			// ── Source detection ──
			for (const src of sources) {
				if (line.includes(src)) {
					// Try to extract the variable receiving tainted data
					const assignMatch = trimmed.match(/^(\w+)\s*=\s*/);
					if (assignMatch) {
						const varName = assignMatch[1];
						taintState.taintedVars.add(varName);
						taintState.trace.push({ line: lineNum, label: `tainted: ${varName} ← ${src}` });
					} else {
						// No assignment — mark a sentinel for inline taint
						taintState.taintedVars.add('__inline__');
						taintState.trace.push({ line: lineNum, label: `tainted source: ${src.trim()}` });
					}
				}
			}

			// ── Taint propagation through assignments ──
			const propagationMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
			if (propagationMatch) {
				const lhs = propagationMatch[1];
				const rhs = propagationMatch[2];
				// Check if any tainted var appears on the right-hand side
				const rhsTainted = [...taintState.taintedVars].some(tv =>
					tv !== '__inline__' && rhs.includes(tv)
				);
				if (rhsTainted && !isSanitized) {
					taintState.taintedVars.add(lhs);
					taintState.trace.push({ line: lineNum, label: `propagated: ${lhs} ← tainted expr` });
				}
			}

			// ── Sink detection ──
			for (const sink of sinks) {
				if (!line.includes(sink)) continue;
				if (isSanitized) continue;

				// Check if any tainted variable reaches the sink
				const hasTaintedArg = [...taintState.taintedVars].some(tv => {
					if (tv === '__inline__') return true;
					// Match the variable as a token (not a substring of another word)
					return new RegExp(`\\b${tv}\\b`).test(line);
				});

				if (hasTaintedArg) {
					const offendingLine = trimmed.slice(0, 120);
					// Find column of the sink call
					const sinkIdx = line.indexOf(sink.replace('(', ''));
					const col = sinkIdx >= 0 ? sinkIdx + 1 : 1;

					// Build trace info for this violation
					const violationTrace = [...taintState.trace, {
						line: lineNum,
						label: `reaches sink: ${sink.trim()}`,
					}];

					results.push({
						ruleId: rule.id,
						domain: rule.domain,
						severity: toDisplaySeverity(rule.severity),
						message: rule.message,
						fileUri,
						line: lineNum,
						column: col,
						endLine: lineNum,
						endColumn: col + (sink.length - 1),
						codeSnippet: offendingLine,
						fix: rule.fix,
						timestamp,
						frameworkId: rule.frameworkId,
						references: rule.references,
						blockingBehavior: rule.blockingBehavior,
						checkSource: 'static',
						traceInfo: violationTrace,
					});

					// Avoid duplicate violations for the same line
					break;
				}
			}
		}

		return results;
	}


	// ─── Python Scope Parser ──────────────────────────────────────────

	/**
	 * Parse Python scopes (functions and classes) from source lines.
	 * Uses indentation tracking instead of a full AST parser.
	 */
	private _parseScopes(lines: string[]): IPythonScope[] {
		const scopes: IPythonScope[] = [];
		const pendingDecorators: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trim();

			// Collect decorators
			if (trimmed.startsWith('@')) {
				pendingDecorators.push(trimmed);
				continue;
			}

			// Detect function/class definitions
			const isAsync = /^async\s+def\s+/.test(trimmed);
			const funcMatch = trimmed.match(/^(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
			const classMatch = trimmed.match(/^class\s+(\w+)/);

			if (!funcMatch && !classMatch) {
				// Clear decorators if next non-empty, non-decorator line is not a def/class
				if (trimmed && !trimmed.startsWith('#')) {
					pendingDecorators.length = 0;
				}
				continue;
			}

			const indentLevel = this._getIndentLevel(line);
			const name = funcMatch ? funcMatch[1] : classMatch![1];
			const params = funcMatch ? this._parseParams(funcMatch[2]) : [];
			const scopeType: IPythonScope['type'] = classMatch
				? 'class'
				: (indentLevel > 0 ? 'method' : 'function');

			// Find end of scope by indentation
			const startLine = i + 1; // 1-based
			let endLine = i + 1;
			for (let j = i + 1; j < lines.length; j++) {
				const nextLine = lines[j];
				const nextTrimmed = nextLine.trim();
				if (!nextTrimmed || nextTrimmed.startsWith('#')) {
					endLine = j + 1;
					continue;
				}
				const nextIndent = this._getIndentLevel(nextLine);
				if (nextIndent <= indentLevel) {
					endLine = j; // 1-based, exclusive → last body line is j (0-indexed j-1 → 1-based j)
					break;
				}
				endLine = j + 1;
			}

			// Collect body lines (excluding the def line itself)
			const bodyLines = lines
				.slice(i + 1, endLine)
				.map(l => l.trim())
				.filter(l => l && !l.startsWith('#'));

			scopes.push({
				type: scopeType,
				name,
				startLine,
				endLine,
				isAsync,
				decorators: [...pendingDecorators],
				params,
				indentLevel,
				bodyLines,
			});

			pendingDecorators.length = 0;
		}

		return scopes;
	}


	// ─── NodeType Matching ────────────────────────────────────────────

	private _matchesNodeType(nodeType: string, scope: IPythonScope): boolean {
		if (!nodeType) return false;
		const types = nodeType.split('|').map(t => t.trim().toLowerCase());

		return types.some(t => {
			switch (t) {
				case 'functiondeclaration':
				case 'arrowfunction':
				case 'functionexpression':
					return scope.type === 'function' || scope.type === 'method';
				case 'classdeclaration':
				case 'classexpression':
					return scope.type === 'class';
				case 'methoddefinition':
					return scope.type === 'method';
				case 'callexpression':
					// For call expressions, we match against all scopes
					// (actual call-site matching is in callee check)
					return true;
				default:
					// Fuzzy: check if the type name contains 'function' or 'class'
					if (t.includes('function')) return scope.type === 'function' || scope.type === 'method';
					if (t.includes('class')) return scope.type === 'class';
					return true;
			}
		});
	}


	// ─── Constraint Evaluation ────────────────────────────────────────

	/**
	 * Evaluate a constraint expression against a Python scope.
	 *
	 * Returns true if the constraint IS satisfied (i.e. the pattern matches).
	 * The engine treats a matched scope as a violation, so `true` = violation.
	 */
	private _evaluateConstraint(
		constraint: string,
		scope: IPythonScope,
		fileFeatures: IFileFeatures,
		fileName: string
	): boolean {
		try {
			// Evaluate compound constraint with && / ||
			// Handle || first (lowest precedence)
			if (constraint.includes('||')) {
				const parts = constraint.split('||').map(p => p.trim());
				return parts.some(p => this._evaluateConstraint(p, scope, fileFeatures, fileName));
			}
			if (constraint.includes('&&')) {
				const parts = constraint.split('&&').map(p => p.trim());
				return parts.every(p => this._evaluateConstraint(p, scope, fileFeatures, fileName));
			}

			// Negation
			if (constraint.startsWith('!')) {
				return !this._evaluateConstraint(constraint.slice(1).trim(), scope, fileFeatures, fileName);
			}

			// Predicates
			const c = constraint.trim();

			if (c === 'isAsync') return scope.isAsync;

			if (c === 'hasTryCatch') return scope.bodyLines.some(l => l.startsWith('try:') || l === 'try:');

			if (c === 'hasReturn') return scope.bodyLines.some(l => /\breturn\s/.test(l) || l === 'return');

			if (c === 'hasNetwork') return fileFeatures.hasNetwork;
			if (c === 'hasCrypto') return fileFeatures.hasCrypto;
			if (c === 'hasDatabase') return fileFeatures.hasDatabase;
			if (c === 'isTestFile') return fileFeatures.isTestFile;

			// paramCount > N
			const paramMatch = c.match(/^paramCount\s*([><=!]+)\s*(\d+)$/);
			if (paramMatch) {
				const op = paramMatch[1];
				const val = parseInt(paramMatch[2], 10);
				const count = scope.params.length;
				switch (op) {
					case '>': return count > val;
					case '>=': return count >= val;
					case '<': return count < val;
					case '<=': return count <= val;
					case '==': case '===': return count === val;
					case '!=': case '!==': return count !== val;
				}
			}

			// callsFunction(name)
			const callsMatch = c.match(/^callsFunction\((['"]?)(\w+)\1\)$/);
			if (callsMatch) {
				const fnName = callsMatch[2];
				return scope.bodyLines.some(l => this._lineCallsCallee(l, fnName));
			}

			// accessesProperty(name)
			const propMatch = c.match(/^accessesProperty\((['"]?)(\w+)\1\)$/);
			if (propMatch) {
				const propName = propMatch[2];
				return scope.bodyLines.some(l => l.includes(`.${propName}`));
			}

			// Unknown constraint — default to false (do not flag)
			return false;
		} catch {
			return false;
		}
	}


	// ─── File Features ────────────────────────────────────────────────

	private _computeFileFeatures(content: string, lines: string[]): IFileFeatures {
		const lower = content.toLowerCase();
		const fileName = '';

		const importLines = lines.filter(l => l.trim().startsWith('import ') || l.trim().startsWith('from '));
		const importContent = importLines.join('\n').toLowerCase();

		return {
			hasNetwork: /\b(requests|urllib|httpx|aiohttp|socket|http\.client)\b/.test(importContent),
			hasCrypto: /\b(hashlib|hmac|cryptography|nacl|pynacl|Crypto)\b/.test(importContent),
			hasDatabase: /\b(sqlite3|psycopg2|psycopg|pymongo|sqlalchemy|pymysql|aiomysql|aiopg)\b/.test(importContent),
			isTestFile: /test_/.test(fileName) || /_test/.test(fileName) ||
				/\bimport\s+pytest\b|\bimport\s+unittest\b/.test(lower),
		};
	}


	// ─── Callee Detection ─────────────────────────────────────────────

	private _lineCallsCallee(line: string, callee: string): boolean {
		try {
			// Match callee( as a call site (not as a variable or substring)
			const pattern = new RegExp(`(?:^|[\\s,=(!])${this._escapeRegex(callee)}\\s*\\(`);
			return pattern.test(line);
		} catch {
			return line.includes(`${callee}(`);
		}
	}


	// ─── Helpers ─────────────────────────────────────────────────────

	private _getIndentLevel(line: string): number {
		let count = 0;
		for (const ch of line) {
			if (ch === ' ') count++;
			else if (ch === '\t') count += 4;
			else break;
		}
		return count;
	}

	private _parseParams(paramStr: string): string[] {
		if (!paramStr.trim()) return [];
		return paramStr
			.split(',')
			.map(p => p.trim().split(':')[0].trim().split('=')[0].trim()) // strip type hints + defaults
			.filter(p => p && p !== '*' && p !== '**' && !p.startsWith('*'))
			.filter(p => p !== 'self' && p !== 'cls');
	}

	private _escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
}


// ─── File Features Interface ─────────────────────────────────────────────────

interface IFileFeatures {
	hasNetwork: boolean;
	hasCrypto: boolean;
	hasDatabase: boolean;
	isTestFile: boolean;
}
