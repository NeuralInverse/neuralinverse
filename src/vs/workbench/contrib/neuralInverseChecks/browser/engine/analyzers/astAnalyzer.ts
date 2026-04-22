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
import { IMarkerService, MarkerSeverity } from '../../../../../../platform/markers/common/markers.js';
import { SymbolKind } from '../../../../../../editor/common/languages.js';
import * as ts from './tsCompilerShim.js';
import type { TypeChecker } from './tsCompilerShim.js';


// ─── AST Analyzer ────────────────────────────────────────────────────────────

export class AstAnalyzer implements IRuleAnalyzer {
	readonly supportedTypes = ['ast'];

	/** Injected by analyzerRegistration — optional, gracefully absent if unavailable */
	markerService: IMarkerService | undefined;

	/** Cached source file per model version to avoid re-parsing */
	private _sourceFileCache = new Map<string, { version: number; sourceFile: ts.SourceFile }>();

	/** Cached alias maps per model version */
	private _aliasCache = new Map<string, { version: number; aliases: Map<string, string> }>();

	/** Cached TypeChecker per model version (null = unavailable) */
	private _checkerCache = new Map<string, { version: number; checker: TypeChecker | null }>();

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

		// Get TypeChecker for type-aware constraints (may be null if unavailable)
		const checker = this._getTypeChecker(model);

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

			// Evaluate constraint (with nano agent context + TypeChecker)
			if (check.match.constraint) {
				if (!this._evaluateConstraint(check.match.constraint, node, sourceFile, aliasMap, fileUri, context, checker)) {
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


	// ─── TypeChecker Access ───────────────────────────────────────────

	/**
	 * Get a TypeChecker for the model's current version.
	 * Returns null if the TS compiler doesn't support createProgram (e.g. older version).
	 * Results are cached per model version to avoid re-creating the program.
	 */
	private _getTypeChecker(model: ITextModel): TypeChecker | null {
		const key = model.uri.toString();
		const version = model.getVersionId();
		const cached = this._checkerCache.get(key);

		if (cached && cached.version === version) {
			return cached.checker;
		}

		const program = ts.createSingleFileProgram(model.uri.path, model.getValue());
		const checker = program?.typeChecker ?? null;

		this._checkerCache.set(key, { version, checker });

		if (this._checkerCache.size > 10) {
			const firstKey = this._checkerCache.keys().next().value;
			if (firstKey) this._checkerCache.delete(firstKey);
		}

		return checker;
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
		fileUri: URI,
		context?: INanoAgentContext,
		checker?: TypeChecker | null
	): boolean {
		// Handle AND
		if (constraint.includes('&&')) {
			const parts = constraint.split('&&').map(s => s.trim());
			return parts.every(part => this._evaluateConstraint(part, node, sourceFile, aliases, fileUri, context, checker));
		}

		// Handle OR
		if (constraint.includes('||')) {
			const parts = constraint.split('||').map(s => s.trim());
			return parts.some(part => this._evaluateConstraint(part, node, sourceFile, aliases, fileUri, context, checker));
		}

		// Handle NOT
		if (constraint.startsWith('!')) {
			return !this._evaluateConstraint(constraint.substring(1).trim(), node, sourceFile, aliases, fileUri, context, checker);
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

			// ─── Type-safety constraints (pure-AST, no TypeChecker needed) ──
			case 'hasNonNullAssertion':
				// Detects `expr!` — unsafe non-null assertion operator
				return this._containsNodeKind(node, ts.SyntaxKind.NonNullExpression);

			case 'hasTypeAssertion':
				// Detects `expr as Type` or `<Type>expr` — explicit type assertions
				return this._containsNodeKind(node, ts.SyntaxKind.AsExpression)
					|| this._containsNodeKind(node, ts.SyntaxKind.TypeAssertionExpression);

			case 'hasUnsafeAssertion':
				// Detects `expr as any` — type erasure via any assertion
				return this._hasUnsafeAssertion(node, sourceFile);

			case 'hasUntypedParameter':
				// Detects function parameters without explicit type annotations
				return this._hasUntypedParameter(node);

			// ─── TypeChecker-enhanced constraints (require createProgram) ──
			case 'returnTypeIsAny':
				// Detects functions that return `any` (inferred or explicit)
				return checker ? this._returnTypeIsAny(node, checker) : false;

			case 'paramTypeIsAny':
				// Detects functions where TypeChecker resolves a param type to `any`
				return checker ? this._paramTypeIsAny(node, checker) : false;

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

			// ─── Type signature constraints (hoverProvider) ──────────────
			case 'hasImplicitAnySignature':
				// True if any function's hover signature contains ': any' — TS inferred any
				return (context?.typeSignatures ?? []).some(s => s.signature.includes(': any'));

			case 'hasUntypedReturn':
				// True if any function's signature has no return type annotation (no ' => ' or ': ')
				return (context?.typeSignatures ?? []).some(s =>
					(s.kind === 'function' || s.kind === 'method') && !s.signature.includes('):')
				);

			// ─── Reference count constraints (referenceProvider) ─────────
			case 'isHighImpactSymbol':
				// True if any symbol in this file has >5 cross-file references — high blast radius
				return (context?.referenceInfo ?? []).some(r => r.crossFileCount > 5);

			case 'isWidelyExported':
				// True if any symbol has >20 total references
				return (context?.referenceInfo ?? []).some(r => r.referenceCount > 20);

			// ─── Inlay hint constraints (inlayHintsProvider) ─────────────
			case 'hasImplicitAnyHint':
				// True if VS Code's inlay hints show `: any` anywhere in the file
				return (context?.inlayHints ?? []).some(h => h.kind === 'type' && h.label.includes('any'));

			// ─── Definition map constraints (definitionProvider) ─────────
			case 'usesExternalCrypto':
				// True if an import resolves to node:crypto or a crypto node_module
				return (context?.definitionMap ?? []).some(d => d.isExternal && d.resolvedUri.includes('crypto'));

			case 'usesExternalAuth':
				// True if an import resolves to an external auth library
				return (context?.definitionMap ?? []).some(d =>
					d.isExternal && /\b(passport|jwt|bcrypt|auth0|oauth|keycloak)\b/i.test(d.name + d.resolvedUri)
				);

			// ─── LSP marker constraints (VS Code TS compiler diagnostics) ──
			case 'hasTypeError':
				// True if the TS language server reported any error-level diagnostic for this file.
				// More accurate than in-process tsCompilerShim for cross-file type errors.
				return this._fileHasTypeError(fileUri, MarkerSeverity.Error);

			case 'hasTypeWarning':
				return this._fileHasTypeError(fileUri, MarkerSeverity.Warning);

			// ─── LSP symbol constraints (DocumentSymbol[] from nano agent context) ──
			case 'hasExportedClass':
				return this._lspSymbolsContainKind(context, SymbolKind.Class);

			case 'hasExportedFunction':
				return this._lspSymbolsContainKind(context, SymbolKind.Function);

			case 'hasInterface':
				return this._lspSymbolsContainKind(context, SymbolKind.Interface);

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

				// ── hasSymbol(name) — LSP-backed: true if a top-level symbol with this name exists ──
				const hasSymbolMatch = constraint.match(/^hasSymbol\((\w+)\)$/);
				if (hasSymbolMatch) {
					return this._lspHasSymbolName(context, hasSymbolMatch[1]);
				}

				// ── symbolKind(name, kind) — LSP-backed: true if named symbol has given kind ──
				const symbolKindMatch = constraint.match(/^symbolKind\((\w+),\s*(\w+)\)$/);
				if (symbolKindMatch) {
					return this._lspSymbolHasKind(context, symbolKindMatch[1], symbolKindMatch[2]);
				}

				// ── Numeric comparisons ──
				return this._evaluateNumericConstraint(constraint, node, context);
			}
		}
	}


	/**
	 * Detect `expr as any` (unsafe type assertion that erases the type).
	 * Also detects `<any>expr` (pre-ES6 style).
	 */
	private _hasUnsafeAssertion(node: ts.Node, sourceFile: ts.SourceFile): boolean {
		let found = false;
		const walk = (n: ts.Node) => {
			if (found) return;
			// `expr as any`
			if (ts.isAsExpression(n)) {
				const typeText = (n as ts.AsExpression).type.getText(sourceFile).trim();
				if (typeText === 'any' || typeText === 'unknown') {
					found = true;
					return;
				}
			}
			// `<any>expr`
			if (ts.isTypeAssertion(n)) {
				const typeText = (n as ts.TypeAssertion).type.getText(sourceFile).trim();
				if (typeText === 'any' || typeText === 'unknown') {
					found = true;
					return;
				}
			}
			ts.forEachChild(n, walk);
		};
		ts.forEachChild(node, walk);
		return found;
	}

	/**
	 * Detect function parameters without explicit type annotations.
	 * `function foo(x)` — x has no type, TypeScript infers `any`.
	 */
	private _hasUntypedParameter(node: ts.Node): boolean {
		if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
			return node.parameters.some((p: ts.Node) => (p as any).type === undefined);
		}
		return false;
	}

	/**
	 * Use TypeChecker to determine if a function's return type resolves to `any`.
	 * Requires `createSingleFileProgram()` to have succeeded.
	 */
	private _returnTypeIsAny(node: ts.Node, checker: TypeChecker): boolean {
		if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node) && !ts.isArrowFunction(node)) {
			return false;
		}
		try {
			const type = checker.getTypeAtLocation(node);
			const sigs = checker.getSignaturesOfType(type, 0 /* Call */);
			if (sigs.length === 0) return false;
			const returnType = checker.getReturnTypeOfSignature(sigs[0]);
			return checker.typeToString(returnType) === 'any';
		} catch {
			return false;
		}
	}

	/**
	 * Use TypeChecker to determine if any parameter type resolves to `any`.
	 * Catches cases where TypeScript infers `any` without explicit annotation.
	 */
	private _paramTypeIsAny(node: ts.Node, checker: TypeChecker): boolean {
		if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node) && !ts.isArrowFunction(node)) {
			return false;
		}
		try {
			for (const param of node.parameters) {
				const type = checker.getTypeAtLocation(param as ts.Node);
				if (checker.typeToString(type) === 'any') {
					return true;
				}
			}
		} catch {
			// TypeChecker unavailable for this node
		}
		return false;
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
			case 'lspSymbolCount':
				// LSP symbol count from DocumentSymbol[] — more accurate than nano agent's regex-based symbolCount
				actual = this._countLspSymbols(context);
				break;
			case 'maxCrossFileRefs':
				// Max cross-file reference count across all symbols in this file
				actual = Math.max(0, ...(context?.referenceInfo ?? []).map(r => r.crossFileCount));
				break;
			case 'maxTotalRefs':
				// Max total reference count across all symbols
				actual = Math.max(0, ...(context?.referenceInfo ?? []).map(r => r.referenceCount));
				break;
			case 'implicitAnyCount':
				// Number of inlay hints showing `: any`
				actual = (context?.inlayHints ?? []).filter(h => h.kind === 'type' && h.label.includes('any')).length;
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


	// ─── LSP / Marker Constraint Helpers ────────────────────────────

	/**
	 * Check if IMarkerService has any marker of the given severity for this file URI.
	 * Catches TS compiler errors that in-process single-file tsCompilerShim misses
	 * (cross-file type mismatches, missing imports, etc.).
	 */
	private _fileHasTypeError(fileUri: URI, severity: MarkerSeverity): boolean {
		if (!this.markerService) return false;
		const markers = this.markerService.read({ resource: fileUri });
		return markers.some(m => m.severity === severity && m.owner === 'typescript');
	}

	/**
	 * Flatten LSP DocumentSymbol[] tree from nano agent context.
	 * Returns an empty array when symbols are unavailable.
	 */
	private _flattenLspSymbols(context: INanoAgentContext | undefined): Array<{ name: string; kind: number }> {
		if (!context?.symbols || !Array.isArray(context.symbols)) return [];
		const flat: Array<{ name: string; kind: number }> = [];
		const walk = (items: any[]) => {
			for (const s of items) {
				if (s?.name !== undefined && s?.kind !== undefined) {
					flat.push({ name: s.name, kind: s.kind as number });
				}
				if (Array.isArray(s?.children)) walk(s.children);
			}
		};
		walk(context.symbols);
		return flat;
	}

	private _countLspSymbols(context: INanoAgentContext | undefined): number {
		return this._flattenLspSymbols(context).length;
	}

	private _lspSymbolsContainKind(context: INanoAgentContext | undefined, kind: SymbolKind): boolean {
		return this._flattenLspSymbols(context).some(s => s.kind === kind);
	}

	private _lspHasSymbolName(context: INanoAgentContext | undefined, name: string): boolean {
		return this._flattenLspSymbols(context).some(s => s.name === name);
	}

	private _lspSymbolHasKind(context: INanoAgentContext | undefined, name: string, kindName: string): boolean {
		const kindMap: Record<string, number> = {
			Function: SymbolKind.Function, Method: SymbolKind.Method, Class: SymbolKind.Class,
			Interface: SymbolKind.Interface, Variable: SymbolKind.Variable, Constant: SymbolKind.Constant,
			Constructor: SymbolKind.Constructor, Field: SymbolKind.Field, Property: SymbolKind.Property,
			Enum: SymbolKind.Enum, EnumMember: SymbolKind.EnumMember, Module: SymbolKind.Module,
			Namespace: SymbolKind.Namespace, Struct: SymbolKind.Struct,
		};
		const kind = kindMap[kindName];
		if (kind === undefined) return false;
		return this._flattenLspSymbols(context).some(s => s.name === name && s.kind === kind);
	}
}
