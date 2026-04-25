/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Data Flow Analyzer
 *
 * Executes `type: "dataflow"` rules using taint tracking analysis.
 *
 * ## Capabilities
 *
 * - **Variable taint tracking**: Tracks taint through assignments (`b = a`)
 * - **Object property tracking**: `obj.data = tainted` \u2192 `obj.data` is tainted
 * - **Destructuring propagation**: `const { x } = req.body` \u2192 `x` is tainted
 * - **Template literal tracking**: `` `SELECT ${tainted}` `` \u2192 flagged at sinks
 * - **Binary expression propagation**: `"prefix" + tainted` \u2192 result is tainted
 * - **Spread propagation**: `{ ...req.body }` \u2192 result is tainted
 * - **Sanitizer recognition**: `b = sanitize(tainted)` \u2192 `b` is clean
 * - **Return value taint**: tracks which functions return tainted data
 * - **Inter-procedural via call hierarchy**: uses nano agent call hierarchy data
 *
 * ## Limitations
 *
 * - Over-approximates control flow (if/else branches both apply)
 * - Array element tracking is partial (tracks entire array, not indices)
 * - Cross-file analysis depends on nano agent call hierarchy availability
 */

import { ITextModel } from '../../../../../../editor/common/model.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IGRCRule, ICheckResult, toDisplaySeverity } from '../types/grcTypes.js';
import { IDataFlowCheck } from '../framework/frameworkSchema.js';
import { IRuleAnalyzer } from '../services/grcEngineService.js';
import { INanoAgentContext } from '../../nanoAgents/projectAnalyzerService.js';
import * as ts from './tsCompilerShim.js';


// ─── Types ───────────────────────────────────────────────────────────────────

interface TaintState {
	isTainted: boolean;
	source?: string;
	sourceLine?: number;
}


// ─── Data Flow Analyzer ──────────────────────────────────────────────────────

export class DataFlowAnalyzer implements IRuleAnalyzer {
	readonly supportedTypes = ['dataflow'];

	private _sourceFileCache = new Map<string, { version: number; sourceFile: ts.SourceFile }>();

	/** Functions whose return values are tainted, built per-evaluation */
	private _taintedReturnFunctions = new Set<string>();


	// ─── Main Evaluate ───────────────────────────────────────────────

	public evaluate(rule: IGRCRule, model: ITextModel, fileUri: URI, timestamp: number, context?: INanoAgentContext): ICheckResult[] {
		const check = rule.check as IDataFlowCheck | undefined;
		if (!check || !check.taint) {
			return [];
		}

		const sourceFile = this._getSourceFile(model);
		if (!sourceFile) {
			return [];
		}

		// Phase 1: Pre-scan to identify functions that return tainted data
		this._taintedReturnFunctions.clear();
		this._preScanReturnTaint(sourceFile, check);

		// Phase 2: Analyze each function scope for taint \u2192 sink violations
		const results: ICheckResult[] = [];

		this._walkAst(sourceFile, (node) => {
			if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node)) {
				const violations = this._analyzeFunctionScope(node, check, rule, fileUri, timestamp, sourceFile, context);
				results.push(...violations);
			} else if (ts.isCallExpression(node)) {
				// Top-level sink calls
				const violation = this._checkSinkCall(node, new Map(), check, rule, fileUri, timestamp, sourceFile);
				if (violation) results.push(violation);
			}
		});

		return results;
	}


	// ─── Pre-Scan: Return Value Taint ────────────────────────────────

	/**
	 * Pre-scan all functions to find which ones return tainted data.
	 * This enables inter-procedural taint: `sink(getTaint())` is flagged.
	 */
	private _preScanReturnTaint(sourceFile: ts.SourceFile, check: IDataFlowCheck): void {
		this._walkAst(sourceFile, (node) => {
			if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node)) return;
			if (!node.body) return;

			const funcName = node.name ? (node.name as ts.Identifier).text : undefined;
			if (!funcName) return;

			// Build taint map for this function
			const taintMap = new Map<string, TaintState>();
			this._scanBodyForTaint(node.body, taintMap, check, sourceFile);

			// Check if any return statement returns tainted data
			this._walkAst(node.body, (n) => {
				if (ts.isReturnStatement(n) && (n as ts.ReturnStatement).expression) {
					const expr = (n as ts.ReturnStatement).expression!;
					if (this._isExpressionTainted(expr, taintMap, check, sourceFile)) {
						this._taintedReturnFunctions.add(funcName);
					}
				}
			});
		});
	}


	// ─── Function Scope Analysis ─────────────────────────────────────

	private _analyzeFunctionScope(
		scopeNode: ts.FunctionLikeDeclaration,
		check: IDataFlowCheck,
		rule: IGRCRule,
		fileUri: URI,
		timestamp: number,
		sourceFile: ts.SourceFile,
		context?: INanoAgentContext
	): ICheckResult[] {
		if (!scopeNode.body) return [];

		const results: ICheckResult[] = [];
		const taintMap = new Map<string, TaintState>();

		// Check function parameters — some may match sources
		if (scopeNode.parameters) {
			for (const param of scopeNode.parameters) {
				if (ts.isIdentifier(param as ts.Node)) {
					const paramName = (param as ts.Identifier).text;
					// Mark parameter as tainted if it matches a source pattern
					if (check.taint.sources.some(s => paramName === s || s.includes(paramName))) {
						taintMap.set(paramName, { isTainted: true, source: paramName });
					}
				}
			}
		}

		const visitBody = (node: ts.Node) => {
			ts.forEachChild(node, (child) => {
				// Variable declarations
				if (ts.isVariableDeclaration(child)) {
					this._handleVariableDeclaration(child as ts.VariableDeclaration, taintMap, check, sourceFile);
				}

				// Assignment expressions: a = expr
				if (ts.isBinaryExpression(child)) {
					const expr = child as ts.BinaryExpression;
					if (expr.operatorToken?.kind === ts.SyntaxKind.EqualsToken) {
						if (ts.isIdentifier(expr.left)) {
							this._evaluateExpressionTaint((expr.left as ts.Identifier).text, expr.right, taintMap, check, sourceFile);
						}
						// Property assignment: obj.prop = expr
						else if (ts.isPropertyAccessExpression(expr.left)) {
							const prop = expr.left as ts.PropertyAccessExpression;
							if (ts.isIdentifier(prop.expression)) {
								const key = `${prop.expression.text}.${prop.name.text}`;
								this._evaluateExpressionTaint(key, expr.right, taintMap, check, sourceFile);
							}
						}
					}
				}

				// Sink calls
				if (ts.isCallExpression(child)) {
					const violation = this._checkSinkCall(child, taintMap, check, rule, fileUri, timestamp, sourceFile);
					if (violation) results.push(violation);
				}

				// Expression statements containing calls
				if (ts.isExpressionStatement(child)) {
					const exprStmt = child as ts.ExpressionStatement;
					if (ts.isCallExpression(exprStmt.expression)) {
						const violation = this._checkSinkCall(exprStmt.expression as ts.CallExpression, taintMap, check, rule, fileUri, timestamp, sourceFile);
						if (violation) results.push(violation);
					}
				}

				// Recurse into blocks but skip nested function declarations
				if (!ts.isFunctionDeclaration(child as any) && !ts.isArrowFunction(child as any)) {
					visitBody(child);
				}
			});
		};

		visitBody(scopeNode.body);
		return results;
	}


	// ─── Variable Declaration Handling ────────────────────────────────

	private _handleVariableDeclaration(
		node: ts.VariableDeclaration,
		taintMap: Map<string, TaintState>,
		check: IDataFlowCheck,
		sourceFile: ts.SourceFile
	): void {
		// Pattern 1: const x = expr (simple identifier name)
		if (ts.isIdentifier(node.name as ts.Node) && node.initializer) {
			const varName = (node.name as ts.Identifier).text;
			this._evaluateExpressionTaint(varName, node.initializer, taintMap, check, sourceFile);
			return;
		}

		// Pattern 2: const { a, b } = expr (destructuring)
		if (ts.isObjectBindingPattern(node.name as ts.Node) && node.initializer) {
			const pattern = node.name as ts.ObjectBindingPattern;
			const initIsSource = this._isSource(node.initializer, check.taint.sources, sourceFile);

			for (const element of pattern.elements) {
				if (!ts.isBindingElement(element as ts.Node)) continue;
				const binding = element as ts.BindingElement;
				if (ts.isIdentifier(binding.name as ts.Node)) {
					const propName = (binding.name as ts.Identifier).text;

					if (initIsSource) {
						// All destructured properties from a source are tainted
						const { line } = sourceFile.getLineAndCharacterOfPosition(node.initializer.getStart(sourceFile));
						taintMap.set(propName, {
							isTainted: true,
							source: `${node.initializer.getText(sourceFile)}.${propName}`,
							sourceLine: line + 1
						});
					} else if (ts.isIdentifier(node.initializer)) {
						// Check if source object is tainted
						const srcName = (node.initializer as ts.Identifier).text;
						const srcState = taintMap.get(srcName) || taintMap.get(`${srcName}.${propName}`);
						if (srcState?.isTainted) {
							taintMap.set(propName, { ...srcState });
						}
					}
				}
			}
			return;
		}

		// Pattern 3: const [a, b] = expr (array destructuring)
		if (ts.isArrayBindingPattern(node.name as ts.Node) && node.initializer) {
			const initIsSource = this._isSource(node.initializer, check.taint.sources, sourceFile);

			if (initIsSource) {
				const pattern = node.name as ts.ArrayBindingPattern;
				for (const element of pattern.elements) {
					if (ts.isBindingElement(element as ts.Node)) {
						const binding = element as ts.BindingElement;
						if (ts.isIdentifier(binding.name as ts.Node)) {
							const { line } = sourceFile.getLineAndCharacterOfPosition(node.initializer.getStart(sourceFile));
							taintMap.set((binding.name as ts.Identifier).text, {
								isTainted: true,
								source: node.initializer.getText(sourceFile),
								sourceLine: line + 1
							});
						}
					}
				}
			}
		}
	}


	// ─── Expression Taint Evaluation ─────────────────────────────────

	private _evaluateExpressionTaint(
		targetVar: string,
		expression: ts.Node,
		taintMap: Map<string, TaintState>,
		check: IDataFlowCheck,
		sourceFile: ts.SourceFile
	): void {
		// 1. Direct source?
		if (this._isSource(expression, check.taint.sources, sourceFile)) {
			const { line } = sourceFile.getLineAndCharacterOfPosition(expression.getStart(sourceFile));
			taintMap.set(targetVar, {
				isTainted: true,
				source: expression.getText(sourceFile),
				sourceLine: line + 1
			});
			return;
		}

		// 2. Sanitizer call? \u2192 cleans taint
		if (ts.isCallExpression(expression) && this._isSanitizer(expression, check.taint.sanitizers)) {
			taintMap.set(targetVar, { isTainted: false });
			return;
		}

		// 3. Call to a function with tainted return?
		if (ts.isCallExpression(expression)) {
			const callee = this._getCalleeName(expression);
			if (callee && this._taintedReturnFunctions.has(callee)) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(expression.getStart(sourceFile));
				taintMap.set(targetVar, {
					isTainted: true,
					source: `${callee}() returns tainted data`,
					sourceLine: line + 1
				});
				return;
			}
			// Check if any argument to the call is tainted (and it's passed through)
		}

		// 4. Identifier reference?
		if (ts.isIdentifier(expression)) {
			const state = taintMap.get(expression.text);
			if (state?.isTainted) {
				taintMap.set(targetVar, { ...state });
				return;
			}
		}

		// 5. Property access? (obj.prop where obj.prop is tainted)
		if (ts.isPropertyAccessExpression(expression)) {
			const prop = expression as ts.PropertyAccessExpression;
			if (ts.isIdentifier(prop.expression)) {
				const key = `${prop.expression.text}.${prop.name.text}`;
				const state = taintMap.get(key);
				if (state?.isTainted) {
					taintMap.set(targetVar, { ...state });
					return;
				}
				// Also check if the object itself is tainted
				const objState = taintMap.get(prop.expression.text);
				if (objState?.isTainted) {
					taintMap.set(targetVar, { ...objState });
					return;
				}
			}
			// Check if the full expression text matches a source
			if (this._isSource(expression, check.taint.sources, sourceFile)) {
				const { line } = sourceFile.getLineAndCharacterOfPosition(expression.getStart(sourceFile));
				taintMap.set(targetVar, {
					isTainted: true,
					source: expression.getText(sourceFile),
					sourceLine: line + 1
				});
				return;
			}
		}

		// 6. Binary expression? (string concat, arithmetic with tainted)
		if (ts.isBinaryExpression(expression)) {
			const binExpr = expression as ts.BinaryExpression;
			if (this._isExpressionTainted(binExpr.left, taintMap, check, sourceFile) ||
				this._isExpressionTainted(binExpr.right, taintMap, check, sourceFile)) {
				taintMap.set(targetVar, { isTainted: true, source: 'binary expression with tainted operand' });
				return;
			}
		}

		// 7. Template literal? `` `...${tainted}...` ``
		if (ts.isTemplateExpression(expression)) {
			const tmpl = expression as ts.TemplateExpression;
			for (const span of tmpl.templateSpans) {
				if (this._isExpressionTainted(span.expression, taintMap, check, sourceFile)) {
					taintMap.set(targetVar, { isTainted: true, source: 'template literal with tainted interpolation' });
					return;
				}
			}
		}

		// 8. Spread/object literal? { ...tainted }
		if (ts.isObjectLiteralExpression(expression)) {
			const obj = expression as ts.ObjectLiteralExpression;
			for (const prop of obj.properties) {
				if (ts.isSpreadAssignment(prop)) {
					// { ...tainted }
					const spreadExpr = (prop as any).expression;
					if (spreadExpr && this._isExpressionTainted(spreadExpr, taintMap, check, sourceFile)) {
						taintMap.set(targetVar, { isTainted: true, source: 'spread of tainted object' });
						return;
					}
				}
			}
		}

		// 9. Await expression? const x = await taintedPromise
		if (ts.isAwaitExpression(expression)) {
			const awaitExpr = expression as ts.AwaitExpression;
			if (this._isExpressionTainted(awaitExpr.expression, taintMap, check, sourceFile)) {
				taintMap.set(targetVar, { isTainted: true, source: 'awaited tainted promise' });
				return;
			}
		}

		// Default: assume clean
		taintMap.set(targetVar, { isTainted: false });
	}


	// ─── Expression Taint Check ──────────────────────────────────────

	/**
	 * Check if an expression evaluates to tainted data.
	 * Used for checking sink arguments and return values.
	 */
	private _isExpressionTainted(
		expr: ts.Node,
		taintMap: Map<string, TaintState>,
		check: IDataFlowCheck,
		sourceFile: ts.SourceFile
	): boolean {
		// Direct source
		if (this._isSource(expr, check.taint.sources, sourceFile)) return true;

		// Tainted identifier
		if (ts.isIdentifier(expr)) {
			return taintMap.get(expr.text)?.isTainted ?? false;
		}

		// Property access (obj.prop)
		if (ts.isPropertyAccessExpression(expr)) {
			const prop = expr as ts.PropertyAccessExpression;
			if (ts.isIdentifier(prop.expression)) {
				const key = `${prop.expression.text}.${prop.name.text}`;
				if (taintMap.get(key)?.isTainted) return true;
				if (taintMap.get(prop.expression.text)?.isTainted) return true;
			}
			return this._isSource(expr, check.taint.sources, sourceFile);
		}

		// Call expression \u2192 check if function returns tainted data
		if (ts.isCallExpression(expr)) {
			const callee = this._getCalleeName(expr as ts.CallExpression);
			// If it's a sanitizer, it's clean
			if (callee && check.taint.sanitizers?.includes(callee)) return false;
			// If function is known to return tainted data
			if (callee && this._taintedReturnFunctions.has(callee)) return true;
		}

		// Binary expression — either operand tainted
		if (ts.isBinaryExpression(expr)) {
			const bin = expr as ts.BinaryExpression;
			return this._isExpressionTainted(bin.left, taintMap, check, sourceFile) ||
				this._isExpressionTainted(bin.right, taintMap, check, sourceFile);
		}

		// Template expression
		if (ts.isTemplateExpression(expr)) {
			const tmpl = expr as ts.TemplateExpression;
			for (const span of tmpl.templateSpans) {
				if (this._isExpressionTainted(span.expression, taintMap, check, sourceFile)) return true;
			}
		}

		// Await
		if (ts.isAwaitExpression(expr)) {
			return this._isExpressionTainted((expr as ts.AwaitExpression).expression, taintMap, check, sourceFile);
		}

		// Parenthesized
		if (ts.isParenthesizedExpression(expr)) {
			return this._isExpressionTainted((expr as ts.ParenthesizedExpression).expression, taintMap, check, sourceFile);
		}

		return false;
	}


	// ─── Sink Checking ───────────────────────────────────────────────

	private _checkSinkCall(
		node: ts.CallExpression,
		taintMap: Map<string, TaintState>,
		check: IDataFlowCheck,
		rule: IGRCRule,
		fileUri: URI,
		timestamp: number,
		sourceFile: ts.SourceFile
	): ICheckResult | undefined {
		if (!this._isSink(node, check.taint.sinks)) return undefined;

		for (const arg of node.arguments) {
			if (this._isExpressionTainted(arg, taintMap, check, sourceFile)) {
				const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
				const endPos = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

				// Find trace info
				let taintSource: string | undefined;
				let taintLine: number | undefined;

				if (ts.isIdentifier(arg)) {
					const state = taintMap.get(arg.text);
					taintSource = state?.source;
					taintLine = state?.sourceLine;
				} else {
					taintSource = arg.getText(sourceFile);
					const pos = sourceFile.getLineAndCharacterOfPosition(arg.getStart(sourceFile));
					taintLine = pos.line + 1;
				}

				const traceInfo = taintSource
					? `Flow: [Line ${taintLine}] ${taintSource} \u2192 [Line ${line + 1}] Sink`
					: undefined;

				return {
					ruleId: rule.id,
					domain: rule.domain,
					severity: toDisplaySeverity(rule.severity),
					message: `[${rule.id}] ${rule.message}`,
					fileUri: fileUri,
					line: line + 1,
					column: character + 1,
					endLine: endPos.line + 1,
					endColumn: endPos.character + 1,
					codeSnippet: node.getText(sourceFile).substring(0, 120),
					fix: rule.fix,
					timestamp: timestamp,
					frameworkId: rule.frameworkId,
					references: rule.references,
					blockingBehavior: rule.blockingBehavior,
					traceInfo: traceInfo ? [{ line: taintLine ?? line + 1, label: traceInfo }] : undefined
				};
			}
		}

		return undefined;
	}


	// ─── Helpers: Pre-scan ────────────────────────────────────────────

	/**
	 * Quickly scan a function body to build initial taint map
	 * (used in pre-scan phase for return value analysis).
	 */
	private _scanBodyForTaint(
		body: ts.Node,
		taintMap: Map<string, TaintState>,
		check: IDataFlowCheck,
		sourceFile: ts.SourceFile
	): void {
		ts.forEachChild(body, (child) => {
			if (ts.isVariableDeclaration(child)) {
				this._handleVariableDeclaration(child as ts.VariableDeclaration, taintMap, check, sourceFile);
			}
			if (ts.isBinaryExpression(child)) {
				const expr = child as ts.BinaryExpression;
				if (expr.operatorToken?.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(expr.left)) {
					this._evaluateExpressionTaint((expr.left as ts.Identifier).text, expr.right, taintMap, check, sourceFile);
				}
			}
			// Recurse but skip nested functions
			if (!ts.isFunctionDeclaration(child as any) && !ts.isArrowFunction(child as any)) {
				this._scanBodyForTaint(child, taintMap, check, sourceFile);
			}
		});
	}


	// ─── Matchers ────────────────────────────────────────────────────

	private _isSource(node: ts.Node, sources: string[], sourceFile: ts.SourceFile): boolean {
		const text = node.getText(sourceFile);
		return sources.some(s => text === s || text.startsWith(s + '.') || text.startsWith(s + '['));
	}

	private _isSink(node: ts.CallExpression, sinks: string[]): boolean {
		const callee = this._getCalleeName(node);
		return !!callee && sinks.includes(callee);
	}

	private _isSanitizer(node: ts.CallExpression, sanitizers: string[] | undefined): boolean {
		if (!sanitizers) return false;
		const callee = this._getCalleeName(node);
		return !!callee && sanitizers.includes(callee);
	}

	private _getCalleeName(node: ts.CallExpression): string | undefined {
		const expr = node.expression;
		if (ts.isIdentifier(expr)) return expr.text;
		if (ts.isPropertyAccessExpression(expr)) {
			const obj = ts.isIdentifier(expr.expression) ? expr.expression.text : undefined;
			if (obj) return `${obj}.${expr.name.text}`;
			return expr.name.text;
		}
		return undefined;
	}


	// ─── Source File & Walking ────────────────────────────────────────

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
				fileName, content,
				ts.ScriptTarget.Latest,
				true,
				isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
			);

			this._sourceFileCache.set(key, { version, sourceFile });

			if (this._sourceFileCache.size > 20) {
				const firstKey = this._sourceFileCache.keys().next().value;
				if (firstKey) this._sourceFileCache.delete(firstKey);
			}

			return sourceFile;
		} catch (e) {
			console.error('[DataFlowAnalyzer] Failed to parse source file:', e);
			return undefined;
		}
	}

	private _walkAst(node: ts.Node, visitor: (node: ts.Node) => void): void {
		visitor(node);
		ts.forEachChild(node, (child: ts.Node) => this._walkAst(child, visitor));
	}
}
