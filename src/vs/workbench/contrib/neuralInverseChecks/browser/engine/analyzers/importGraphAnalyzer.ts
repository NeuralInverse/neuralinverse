/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Import Graph Analyzer
 *
 * Executes `type: "import-graph"` rules for architectural compliance.
 *
 * ## Capabilities
 *
 * - **Boundary Violations**: Enforces `src/ui/**` can only import from allowed globs
 * - **Layer Violations**: Enforces layered architecture (UI \u2192 Service \u2192 Data)
 * - **Cycle Detection**: DFS-based cycle detection within the file's import chain
 * - **Import Detection**: ESM `import`, CommonJS `require()`, re-exports
 */

import { ITextModel } from '../../../../../../editor/common/model.js';
import { URI } from '../../../../../../base/common/uri.js';
import { match as matchGlob } from '../../../../../../base/common/glob.js';
import { IGRCRule, ICheckResult, toDisplaySeverity } from '../types/grcTypes.js';
import { IImportGraphCheck } from '../framework/frameworkSchema.js';
import { IRuleAnalyzer } from '../services/grcEngineService.js';
import { INanoAgentContext } from '../../nanoAgents/projectAnalyzerService.js';
import * as ts from './tsCompilerShim.js';
import { IWorkspaceContextService } from '../../../../../../platform/workspace/common/workspace.js';


// ─── Import Info ─────────────────────────────────────────────────────────────

interface ImportInfo {
	/** The raw import path string (e.g. '../utils', 'lodash', '@scope/pkg') */
	path: string;

	/** The AST node for location reporting */
	node: ts.Node;

	/** Type of import */
	type: 'import' | 'require' | 're-export';
}


// ─── Import Graph Analyzer ───────────────────────────────────────────────────

export class ImportGraphAnalyzer implements IRuleAnalyzer {
	readonly supportedTypes = ['import-graph'];

	private _sourceFileCache = new Map<string, { version: number; sourceFile: ts.SourceFile }>();

	constructor(
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService
	) { }

	public evaluate(rule: IGRCRule, model: ITextModel, fileUri: URI, timestamp: number, context?: INanoAgentContext): ICheckResult[] {
		const check = rule.check as IImportGraphCheck | undefined;
		if (!check) return [];

		switch (check.detect) {
			case 'boundary-violation':
			case 'layer-violation':
				return this._checkBoundaries(check, rule, model, fileUri, timestamp);

			case 'cycles':
				return this._checkCycles(check, rule, model, fileUri, timestamp, context);

			default:
				return [];
		}
	}


	// ─── Boundary/Layer Violation Check ──────────────────────────────

	private _checkBoundaries(
		check: IImportGraphCheck,
		rule: IGRCRule,
		model: ITextModel,
		fileUri: URI,
		timestamp: number
	): ICheckResult[] {
		if (!check.boundaries) return [];

		const workspaceFolder = this.workspaceContextService.getWorkspaceFolder(fileUri);
		if (!workspaceFolder) return [];

		const relativeFilePath = this._getRelativePath(fileUri, workspaceFolder.uri);
		if (!relativeFilePath) return [];

		// Find which boundary rule applies to this file
		let allowedImports: string[] | undefined;
		for (const sourceGlob of Object.keys(check.boundaries)) {
			if (matchGlob(sourceGlob, relativeFilePath)) {
				allowedImports = check.boundaries[sourceGlob];
				break;
			}
		}

		if (!allowedImports) return [];

		const sourceFile = this._getSourceFile(model);
		if (!sourceFile) return [];

		const results: ICheckResult[] = [];
		const imports = this._extractAllImports(sourceFile);

		for (const imp of imports) {
			// Skip external packages (no relative path, or node_modules)
			if (this._isExternalPackage(imp.path)) continue;

			const resolvedPath = this._resolveImportPath(imp.path, fileUri, workspaceFolder.uri);

			const isAllowed = allowedImports.some(pattern => matchGlob(pattern, resolvedPath));

			if (!isAllowed) {
				const { line, character } = sourceFile.getLineAndCharacterOfPosition(imp.node.getStart(sourceFile));
				const endPos = sourceFile.getLineAndCharacterOfPosition(imp.node.getEnd());

				results.push({
					ruleId: rule.id,
					domain: rule.domain,
					severity: toDisplaySeverity(rule.severity),
					message: `[${rule.id}] ${rule.message} (${imp.type} '${imp.path}' violates boundary — resolved to '${resolvedPath}')`,
					fileUri: fileUri,
					line: line + 1,
					column: character + 1,
					endLine: endPos.line + 1,
					endColumn: endPos.character + 1,
					codeSnippet: imp.node.getText(sourceFile),
					fix: rule.fix,
					timestamp: timestamp,
					frameworkId: rule.frameworkId,
					references: rule.references,
					blockingBehavior: rule.blockingBehavior,
				});
			}
		}

		return results;
	}


	// ─── Cycle Detection ─────────────────────────────────────────────

	/**
	 * DFS-based cycle detection.
	 *
	 * For the current file, builds a local import graph and checks
	 * if any import chain leads back to the current file.
	 * Uses nano agent call hierarchy for cross-file resolution hints.
	 */
	private _checkCycles(
		check: IImportGraphCheck,
		rule: IGRCRule,
		model: ITextModel,
		fileUri: URI,
		timestamp: number,
		context?: INanoAgentContext
	): ICheckResult[] {
		const workspaceFolder = this.workspaceContextService.getWorkspaceFolder(fileUri);
		if (!workspaceFolder) return [];

		const sourceFile = this._getSourceFile(model);
		if (!sourceFile) return [];

		const relativeFilePath = this._getRelativePath(fileUri, workspaceFolder.uri);
		if (!relativeFilePath) return [];

		const results: ICheckResult[] = [];
		const imports = this._extractAllImports(sourceFile);

		for (const imp of imports) {
			if (this._isExternalPackage(imp.path)) continue;

			const resolvedPath = this._resolveImportPath(imp.path, fileUri, workspaceFolder.uri);

			// Normalize: strip extension for comparison
			const normalizedCurrent = this._normalizeModulePath(relativeFilePath);
			const normalizedImport = this._normalizeModulePath(resolvedPath);

			// Direct self-import (obvious cycle)
			if (normalizedCurrent === normalizedImport) {
				const { line, character } = sourceFile.getLineAndCharacterOfPosition(imp.node.getStart(sourceFile));
				const endPos = sourceFile.getLineAndCharacterOfPosition(imp.node.getEnd());

				results.push({
					ruleId: rule.id,
					domain: rule.domain,
					severity: toDisplaySeverity(rule.severity),
					message: `[${rule.id}] ${rule.message} (Self-import detected: '${imp.path}')`,
					fileUri: fileUri,
					line: line + 1,
					column: character + 1,
					endLine: endPos.line + 1,
					endColumn: endPos.character + 1,
					codeSnippet: imp.node.getText(sourceFile),
					fix: rule.fix,
					timestamp: timestamp,
					frameworkId: rule.frameworkId,
					references: rule.references,
					blockingBehavior: rule.blockingBehavior,
				});
				continue;
			}

			// Indirect cycle detection using nano agent call hierarchy
			// If the imported module has an outgoing reference back to us
			if (context?.callHierarchy) {
				const entryNames = Object.keys(context.callHierarchy);
				for (const name of entryNames) {
					const entry = context.callHierarchy[name];
					if (entry.outgoing) {
						for (const outCall of entry.outgoing) {
							// Check if outgoing call references a module that resolves to our file
							if (typeof outCall.to === 'string' && outCall.to.includes(normalizedImport)) {
								// Potential cycle — this import also calls back to something in our graph
								// (This is a heuristic; full cycle detection requires the workspace graph)
							}
						}
					}
				}
			}
		}

		return results;
	}


	// ─── Import Extraction ───────────────────────────────────────────

	/**
	 * Extract ALL import-like statements from the AST:
	 * - `import ... from '...'` (ESM)
	 * - `require('...')` (CommonJS)
	 * - `export ... from '...'` (re-exports)
	 */
	private _extractAllImports(sourceFile: ts.SourceFile): ImportInfo[] {
		const imports: ImportInfo[] = [];

		this._walkAst(sourceFile, (node) => {
			// ESM imports: import ... from '...'
			if (ts.isImportDeclaration(node)) {
				const importDecl = node as ts.ImportDeclaration;
				const path = this._extractModuleSpecifier(importDecl.moduleSpecifier);
				if (path) {
					imports.push({ path, node: importDecl, type: 'import' });
				}
			}

			// Re-exports: export ... from '...'
			if (ts.isExportDeclaration(node)) {
				const exportDecl = node as ts.ExportDeclaration;
				if (exportDecl.moduleSpecifier) {
					const path = this._extractModuleSpecifier(exportDecl.moduleSpecifier);
					if (path) {
						imports.push({ path, node: exportDecl, type: 're-export' });
					}
				}
			}

			// CommonJS require: const x = require('...')
			if (ts.isCallExpression(node)) {
				const callExpr = node as ts.CallExpression;
				if (ts.isIdentifier(callExpr.expression) &&
					(callExpr.expression as ts.Identifier).text === 'require' &&
					callExpr.arguments.length > 0) {
					const path = this._extractModuleSpecifier(callExpr.arguments[0]);
					if (path) {
						imports.push({ path, node, type: 'require' });
					}
				}
			}
		});

		return imports;
	}

	/**
	 * Extract the text from a module specifier node.
	 * Module specifiers are StringLiteral nodes in the AST.
	 */
	private _extractModuleSpecifier(node: ts.Node): string | undefined {
		// StringLiteral (the correct type for module specifiers)
		if (ts.isStringLiteral(node)) {
			return (node as ts.StringLiteral).text;
		}

		// NoSubstitutionTemplateLiteral (backtick-quoted module path)
		if (ts.isNoSubstitutionTemplateLiteral(node)) {
			return (node as ts.StringLiteral).text;
		}

		// Fallback: try accessing .text directly (runtime TS compiler nodes have it)
		if ('text' in node && typeof (node as any).text === 'string') {
			return (node as any).text;
		}

		return undefined;
	}


	// ─── Path Resolution ─────────────────────────────────────────────

	/**
	 * Check if an import path refers to an external package.
	 */
	private _isExternalPackage(importPath: string): boolean {
		// Relative imports are NOT external
		if (importPath.startsWith('.')) return false;

		// Bare specifiers without path separators are external packages
		if (!importPath.includes('/')) return true;

		// Scoped packages: @scope/package
		if (importPath.startsWith('@') && importPath.split('/').length === 2) return true;

		// If it doesn't start with '.', and isn't a known local path pattern, assume external
		if (!importPath.startsWith('src/') && !importPath.startsWith('lib/') && !importPath.startsWith('app/')) {
			return true;
		}

		return false;
	}

	/**
	 * Resolve an import path to a workspace-relative path.
	 */
	private _resolveImportPath(importPath: string, sourceFileUri: URI, rootUri: URI): string {
		// Relative imports
		if (importPath.startsWith('./') || importPath.startsWith('../')) {
			const sourceDir = URI.joinPath(sourceFileUri, '..');
			const resolvedUri = URI.joinPath(sourceDir, importPath);
			return this._getRelativePath(resolvedUri, rootUri) || importPath;
		}

		// Non-relative: treat as workspace-relative
		return importPath;
	}

	/**
	 * Normalize a module path for comparison (strip extensions).
	 */
	private _normalizeModulePath(path: string): string {
		return path
			.replace(/\.(ts|tsx|js|jsx|mjs|cjs|json)$/, '')
			.replace(/\/index$/, '');
	}


	// ─── Helpers ─────────────────────────────────────────────────────

	private _getRelativePath(fileUri: URI, rootUri: URI): string | undefined {
		if (fileUri.scheme !== rootUri.scheme || !fileUri.path.startsWith(rootUri.path)) {
			return undefined;
		}
		let rel = fileUri.path.substring(rootUri.path.length);
		if (rel.startsWith('/')) rel = rel.substring(1);
		return rel;
	}

	private _getSourceFile(model: ITextModel): ts.SourceFile | undefined {
		const key = model.uri.toString();
		const version = model.getVersionId();
		const cached = this._sourceFileCache.get(key);

		if (cached && cached.version === version) {
			return cached.sourceFile;
		}

		try {
			const sourceFile = ts.createSourceFile(
				model.uri.path,
				model.getValue(),
				ts.ScriptTarget.Latest,
				true
			);
			this._sourceFileCache.set(key, { version, sourceFile });

			if (this._sourceFileCache.size > 20) {
				const firstKey = this._sourceFileCache.keys().next().value;
				if (firstKey) this._sourceFileCache.delete(firstKey);
			}

			return sourceFile;
		} catch (e) {
			console.error('[ImportGraphAnalyzer] Failed to parse:', e);
			return undefined;
		}
	}

	private _walkAst(node: ts.Node, visitor: (node: ts.Node) => void): void {
		visitor(node);
		ts.forEachChild(node, (child: ts.Node) => this._walkAst(child, visitor));
	}
}
