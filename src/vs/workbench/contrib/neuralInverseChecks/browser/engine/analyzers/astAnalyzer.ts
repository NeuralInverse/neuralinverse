/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # AST Analyzer
 *
 * Executes `type: "ast"` rules using TypeScript's compiler API to walk
 * the syntax tree and detect structural patterns.
 *
 * ## Capabilities
 *
 * - **Alias resolution**: Tracks `const e = eval; e(...)` as calling `eval`
 * - **Structural constraints**: isAsync, hasTryCatch, hasReturnType, etc.
 * - **Nano agent constraints**: hasNetwork, hasCrypto, complexity > N, etc.
 * - **Function-body analysis**: throwsError, hasAwait, hasReturn, callsFunction(name)
 * - **Composite constraints**: Supports `&&`, `||`, `!` operators
 *
 * ## Registration
 *
 * ```typescript
 * engineService.registerAnalyzer(astAnalyzer);
 * ```
 */

import { ITextModel } from '../../../../../../editor/common/model.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IGRCRule, ICheckResult, toDisplaySeverity } from '../types/grcTypes.js';
import { IAstCheck } from '../framework/frameworkSchema.js';
import { IRuleAnalyzer } from '../services/grcEngineService.js';
import { INanoAgentContext } from '../../nanoAgents/projectAnalyzerService.js';
import * as ts from './tsCompilerShim.js';


// ─── AST Analyzer ────────────────────────────────────────────────────────────

export class AstAnalyzer implements IRuleAnalyzer {
	readonly supportedTypes = ['ast'];

	/** Cached source file per model version to avoid re-parsing */
	private _sourceFileCache = new Map<string, { version: number; sourceFile: ts.SourceFile }>();

	/** Cached alias maps per model version */
	private _aliasCache = new Map<string, { version: number; aliases: Map<string, string> }>();

	/** Runtime reverse map from SyntaxKind number → name string */
	private readonly _syntaxKindNames: Map<number, string> = new Map([
		[ts.SyntaxKind.FunctionDeclaration, 'FunctionDeclaration'],
		[ts.SyntaxKind.MethodDeclaration, 'MethodDeclaration'],
		[ts.SyntaxKind.ArrowFunction, 'ArrowFunction'],
		[ts.SyntaxKind.ClassDeclaration, 'ClassDeclaration'],
		[ts.SyntaxKind.VariableDeclaration, 'VariableDeclaration'],
		[ts.SyntaxKind.ImportDeclaration, 'ImportDeclaration'],
		[ts.SyntaxKind.ExportDeclaration, 'ExportDeclaration'],
		[ts.SyntaxKind.CallExpression, 'CallExpression'],
		[ts.SyntaxKind.NewExpression, 'NewExpression'],
		[ts.SyntaxKind.PropertyAccessExpression, 'PropertyAccessExpression'],
		[ts.SyntaxKind.ElementAccessExpression, 'ElementAccessExpression'],
		[ts.SyntaxKind.BinaryExpression, 'BinaryExpression'],
		[ts.SyntaxKind.ConditionalExpression, 'ConditionalExpression'],
		[ts.SyntaxKind.TemplateExpression, 'TemplateExpression'],
		[ts.SyntaxKind.TaggedTemplateExpression, 'TaggedTemplateExpression'],
		[ts.SyntaxKind.AwaitExpression, 'AwaitExpression'],
		[ts.SyntaxKind.SpreadElement, 'SpreadElement'],
		[ts.SyntaxKind.Identifier, 'Identifier'],
		[ts.SyntaxKind.StringLiteral, 'StringLiteral'],
		[ts.SyntaxKind.TryStatement, 'TryStatement'],
		[ts.SyntaxKind.IfStatement, 'IfStatement'],
		[ts.SyntaxKind.ForStatement, 'ForStatement'],
		[ts.SyntaxKind.WhileStatement, 'WhileStatement'],
		[ts.SyntaxKind.ReturnStatement, 'ReturnStatement'],
		[ts.SyntaxKind.ThrowStatement, 'ThrowStatement'],
		[ts.SyntaxKind.SwitchStatement, 'SwitchStatement'],
		[ts.SyntaxKind.Block, 'Block'],
	]);


	// ─── Main Evaluate ───────────────────────────────────────────────

	public evaluate(rule: IGRCRule, model: ITextModel, fileUri: URI, timestamp: number, context?: INanoAgentContext): ICheckResult[] {
		const check = rule.check as IAstCheck | undefined;
		if (!check?.match?.nodeType) {
			return [];
		}

		const sourceFile = this._getSourceFile(model);
		if (!sourceFile) {
			return [];
		}

		// Build alias map for this file
		const aliasMap = this._getAliasMap(model, sourceFile);

		const results: ICheckResult[] = [];
		const targetNodeTypes = check.match.nodeType.split('|').map(t => t.trim());

		// Walk the AST
		this._walkAst(sourceFile, (node) => {
			const nodeKindName = this._syntaxKindNames.get(node.kind) || '';

			// Check if this node type matches the rule
			if (!targetNodeTypes.some(t => nodeKindName === t || nodeKindName.includes(t))) {
				return;
			}

			// For CallExpression: check callee name (with alias resolution)
			if (check.match.callee && ts.isCallExpression(node)) {
				const calleeName = this._getCalleeName(node, aliasMap);
				if (!calleeName || !check.match.callee.includes(calleeName)) {
					return;
				}
			}

			// Evaluate constraint (with nano agent context)
			if (check.match.constraint) {
				if (!this._evaluateConstraint(check.match.constraint, node, sourceFile, aliasMap, context)) {
					return;
				}
			}

			// Node matches — create a violation
			const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
			const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

			results.push({
				ruleId: rule.id,
				domain: rule.domain,
				severity: toDisplaySeverity(rule.severity),
				message: `[${rule.id}] ${rule.message}`,
				fileUri: fileUri,
				line: line + 1,
				column: character + 1,
				endLine: endPos.line + 1,
				endColumn: endPos.character + 1,
				codeSnippet: node.getText(sourceFile).substring(0, 100),
				fix: rule.fix,
				timestamp: timestamp,
				frameworkId: rule.frameworkId,
				references: rule.references,
				blockingBehavior: rule.blockingBehavior,
			});
		});

		return results;
	}


	// ─── Alias Resolution ────────────────────────────────────────────

	/**
	 * Build a map of variable aliases in the file.
	 * Detects patterns like:
	 * - `const e = eval` → { "e" → "eval" }
	 * - `const run = Function` → { "run" → "Function" }
	 * - `const exec = require('child_process').exec` → { "exec" → "child_process.exec" }
	 * - `const { exec } = require('child_process')` → { "exec" → "exec" }
	 */
	private _getAliasMap(model: ITextModel, sourceFile: ts.SourceFile): Map<string, string> {
		const key = model.uri.toString();
		const version = model.getVersionId();
		const cached = this._aliasCache.get(key);

		if (cached && cached.version === version) {
			return cached.aliases;
		}

		const aliases = new Map<string, string>();

		this._walkAst(sourceFile, (node) => {
			if (!ts.isVariableDeclaration(node)) return;

			// Pattern: const e = eval
			if (ts.isIdentifier(node.name) && node.initializer) {
				if (ts.isIdentifier(node.initializer)) {
					aliases.set(node.name.text, node.initializer.text);
				}
				// Pattern: const exec = require('child_process').exec
				else if (ts.isPropertyAccessExpression(node.initializer)) {
					const propAccess = node.initializer;
					if (ts.isCallExpression(propAccess.expression)) {
						const call = propAccess.expression;
						if (ts.isIdentifier(call.expression) && call.expression.text === 'require') {
							if (call.arguments.length > 0 && ts.isStringLiteral(call.arguments[0] as ts.Node)) {
								const moduleName = (call.arguments[0] as ts.StringLiteral).text;
								aliases.set(node.name.text, `${moduleName}.${propAccess.name.text}`);
							}
						}
					}
					// Pattern: const write = document.write
					else if (ts.isIdentifier(propAccess.expression)) {
						aliases.set(node.name.text, `${propAccess.expression.text}.${propAccess.name.text}`);
					}
				}
			}
		});

		this._aliasCache.set(key, { version, aliases });

		// Evict old entries
		if (this._aliasCache.size > 20) {
			const firstKey = this._aliasCache.keys().next().value;
			if (firstKey) this._aliasCache.delete(firstKey);
		}

		return aliases;
	}


	// ─── AST Parsing ─────────────────────────────────────────────────

	private _getSourceFile(model: ITextModel): ts.SourceFile | undefined {
		const key = model.uri.toString();
		const version = model.getVersionId();
		const cached = this._sourceFileCache.get(key);

		if (cached && cached.version === version) {
			return cached.sourceFile;
		}

		try {
			const content = model.getValue();
			const fileName = model.uri.path;
			const isJsx = fileName.endsWith('.tsx') || fileName.endsWith('.jsx');

			const sourceFile = ts.createSourceFile(
				fileName,
				content,
				ts.ScriptTarget.Latest,
				/* setParentNodes */ true,
				isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
			);

			this._sourceFileCache.set(key, { version, sourceFile });

			if (this._sourceFileCache.size > 20) {
				const firstKey = this._sourceFileCache.keys().next().value;
				if (firstKey) this._sourceFileCache.delete(firstKey);
			}

			return sourceFile;
		} catch (e) {
			console.error('[AstAnalyzer] Failed to parse source file:', e);
			return undefined;
		}
	}


	// ─── AST Walking ─────────────────────────────────────────────────

	private _walkAst(node: ts.Node, visitor: (node: ts.Node) => void): void {
		visitor(node);
		ts.forEachChild(node, (child: ts.Node) => this._walkAst(child, visitor));
	}


	// ─── Callee Name Extraction (with alias resolution) ──────────────

	/**
	 * Extracts the callee name from a CallExpression.
	 * Resolves aliases: if `const e = eval`, then `e()` → "eval".
	 *
	 * Handles:
	 * - Simple call: `eval(...)` → "eval"
	 * - Aliased call: `e(...)` → "eval" (if e = eval)
	 * - Method call: `document.write(...)` → "document.write"
	 * - Chained method: `obj.method(...)` → "obj.method"
	 */
	private _getCalleeName(node: ts.CallExpression, aliases: Map<string, string>): string | undefined {
		const expr = node.expression;

		if (ts.isIdentifier(expr)) {
			const name = expr.text;
			// Resolve through alias chain (up to 3 levels)
			return aliases.get(name) || aliases.get(aliases.get(name) || '') || name;
		}

		if (ts.isPropertyAccessExpression(expr)) {
			const obj = ts.isIdentifier(expr.expression)
				? expr.expression.text
				: undefined;
			if (obj) {
				const fullName = `${obj}.${expr.name.text}`;
				// Check if the object itself is aliased
				const resolvedObj = aliases.get(obj) || obj;
				return resolvedObj === obj ? fullName : `${resolvedObj}.${expr.name.text}`;
			}
			return expr.name.text;
		}

		if (ts.isNewExpression(node as any)) {
			const newExpr = node as any as ts.NewExpression;
			if (ts.isIdentifier(newExpr.expression)) {
				const name = newExpr.expression.text;
				return aliases.get(name) || name;
			}
		}

		return undefined;
	}


	// ─── Constraint Evaluation ───────────────────────────────────────

	/**
	 * Evaluates a constraint expression against an AST node.
	 *
	 * ## AST-level constraints (per-node):
	 * isAsync, hasTryCatch, hasReturnType, throwsError, hasReturn,
	 * hasAwait, callsFunction(name), accessesProperty(name), paramCount > N
	 *
	 * ## Nano agent constraints (per-file, from context):
	 * hasNetwork, hasCrypto, hasAuth, hasDatabase, hasFileSystem,
	 * hasEnv, isTestFile, hasClasses, hasInterfaces,
	 * complexity > N, symbolCount > N, lineCount > N
	 *
	 * ## Operators: &&, ||, !
	 */
	private _evaluateConstraint(
		constraint: string,
		node: ts.Node,
		sourceFile: ts.SourceFile,
		aliases: Map<string, string>,
		context?: INanoAgentContext
	): boolean {
		// Handle AND
		if (constraint.includes('&&')) {
			const parts = constraint.split('&&').map(s => s.trim());
			return parts.every(part => this._evaluateConstraint(part, node, sourceFile, aliases, context));
		}

		// Handle OR
		if (constraint.includes('||')) {
			const parts = constraint.split('||').map(s => s.trim());
			return parts.some(part => this._evaluateConstraint(part, node, sourceFile, aliases, context));
		}

		// Handle NOT
		if (constraint.startsWith('!')) {
			return !this._evaluateConstraint(constraint.substring(1).trim(), node, sourceFile, aliases, context);
		}

		// ─── AST-level constraints (node-based) ─────────────────────
		switch (constraint) {
			case 'isAsync':
				return this._isAsyncFunction(node);

			case 'hasTryCatch':
				return this._hasTryCatch(node);

			case 'hasReturnType':
				return this._hasReturnType(node);

			case 'throwsError':
				return this._containsNodeKind(node, ts.SyntaxKind.ThrowStatement);

			case 'hasReturn':
				return this._containsNodeKind(node, ts.SyntaxKind.ReturnStatement);

			case 'hasAwait':
				return this._containsNodeKind(node, ts.SyntaxKind.AwaitExpression);

			case 'hasYield':
				return this._containsNodeKind(node, ts.SyntaxKind.YieldExpression);

			// ─── Nano agent context constraints (file-level) ─────────
			case 'hasNetwork':
				return context?.capabilities?.hasNetwork ?? false;

			case 'hasCrypto':
				return context?.capabilities?.hasCrypto ?? false;

			case 'hasAuth':
				return context?.capabilities?.hasAuth ?? false;

			case 'hasDatabase':
				return context?.capabilities?.hasDatabase ?? false;

			case 'hasFileSystem':
				return context?.capabilities?.hasFileSystem ?? false;

			case 'hasEnv':
				return context?.capabilities?.hasEnv ?? false;

			case 'isTestFile':
				return context?.capabilities?.isTestFile ?? false;

			case 'hasAsync':
				return context?.capabilities?.hasAsync ?? false;

			case 'hasClasses':
				return context?.capabilities?.hasClasses ?? false;

			case 'hasInterfaces':
				return context?.capabilities?.hasInterfaces ?? false;

			default: {
				// ── callsFunction(name) ──
				const callsMatch = constraint.match(/^callsFunction\((\w+(?:\.\w+)*)\)$/);
				if (callsMatch) {
					return this._bodyCallsFunction(node, callsMatch[1], aliases);
				}

				// ── accessesProperty(name) ──
				const propMatch = constraint.match(/^accessesProperty\((\w+(?:\.\w+)*)\)$/);
				if (propMatch) {
					return this._bodyAccessesProperty(node, propMatch[1]);
				}

				// ── Numeric comparisons ──
				return this._evaluateNumericConstraint(constraint, node, context);
			}
		}
	}


	/**
	 * Evaluates numeric comparison constraints:
	 * paramCount > N, complexity > N, symbolCount > N, lineCount > N, functions > N
	 */
	private _evaluateNumericConstraint(constraint: string, node: ts.Node, context?: INanoAgentContext): boolean {
		const match = constraint.match(/^(\w+)\s*(>|<|>=|<=|==)\s*(\d+)$/);
		if (!match) {
			console.warn(`[AstAnalyzer] Unknown constraint: "${constraint}"`);
			return false;
		}

		const [, metric, op, valueStr] = match;
		const threshold = parseInt(valueStr);

		let actual: number | undefined;

		switch (metric) {
			case 'paramCount':
				actual = this._getParamCount(node);
				break;
			case 'complexity':
				actual = context?.metrics?.maxDepth;
				break;
			case 'symbolCount':
				actual = context?.metrics?.symbolCount;
				break;
			case 'lineCount':
				actual = context?.metrics?.lineCount;
				break;
			case 'functions':
				actual = context?.metrics?.functions;
				break;
			case 'classes':
				actual = context?.metrics?.classes;
				break;
			case 'avgParams':
				actual = context?.metrics?.avgParams;
				break;
			default:
				console.warn(`[AstAnalyzer] Unknown metric: "${metric}"`);
				return false;
		}

		if (actual === undefined) return false;

		switch (op) {
			case '>': return actual > threshold;
			case '<': return actual < threshold;
			case '>=': return actual >= threshold;
			case '<=': return actual <= threshold;
			case '==': return actual === threshold;
			default: return false;
		}
	}


	// ─── Constraint Helpers ──────────────────────────────────────────

	private _isAsyncFunction(node: ts.Node): boolean {
		if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
			return node.modifiers?.some((m: ts.Modifier) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
		}
		return false;
	}

	private _hasTryCatch(node: ts.Node): boolean {
		return this._containsNodeKindInBody(node, ts.SyntaxKind.TryStatement);
	}

	private _hasReturnType(node: ts.Node): boolean {
		if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
			return node.type !== undefined;
		}
		return false;
	}

	private _getParamCount(node: ts.Node): number {
		if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
			return node.parameters.length;
		}
		return 0;
	}

	/**
	 * Check if a node kind exists anywhere inside a node (recursive).
	 */
	private _containsNodeKind(node: ts.Node, kind: number): boolean {
		let found = false;
		const walk = (n: ts.Node) => {
			if (found) return;
			if (n.kind === kind) { found = true; return; }
			ts.forEachChild(n, walk);
		};
		ts.forEachChild(node, walk);
		return found;
	}

	/**
	 * Check if a node kind exists inside the body of a function-like node.
	 */
	private _containsNodeKindInBody(node: ts.Node, kind: number): boolean {
		if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
			if (node.body) {
				return this._containsNodeKind(node.body, kind);
			}
		}
		return false;
	}

	/**
	 * Check if function body calls a specific function (with alias resolution).
	 * Supports both simple names ("eval") and dotted names ("console.log").
	 */
	private _bodyCallsFunction(node: ts.Node, targetName: string, aliases: Map<string, string>): boolean {
		const body = this._getFunctionBody(node);
		if (!body) return false;

		let found = false;
		const walk = (n: ts.Node) => {
			if (found) return;
			if (ts.isCallExpression(n)) {
				const calleeName = this._getCalleeName(n, aliases);
				if (calleeName === targetName) {
					found = true;
					return;
				}
			}
			ts.forEachChild(n, walk);
		};
		walk(body);
		return found;
	}

	/**
	 * Check if function body accesses a specific property.
	 * Matches `obj.prop` access patterns.
	 */
	private _bodyAccessesProperty(node: ts.Node, targetName: string): boolean {
		const body = this._getFunctionBody(node);
		if (!body) return false;

		let found = false;
		const walk = (n: ts.Node) => {
			if (found) return;
			if (ts.isPropertyAccessExpression(n)) {
				const obj = ts.isIdentifier(n.expression) ? n.expression.text : '';
				const full = obj ? `${obj}.${n.name.text}` : n.name.text;
				if (full === targetName || n.name.text === targetName) {
					found = true;
					return;
				}
			}
			ts.forEachChild(n, walk);
		};
		walk(body);
		return found;
	}

	/**
	 * Get the body of a function-like node.
	 */
	private _getFunctionBody(node: ts.Node): ts.Node | undefined {
		if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
			return node.body;
		}
		return undefined;
	}
}
