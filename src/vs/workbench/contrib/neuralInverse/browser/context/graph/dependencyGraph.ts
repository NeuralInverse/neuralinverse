/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse. All rights reserved.
 *  Dependency Graph Service — extracts imports/exports using TreeSitter AST parsing.
 *  Falls back to regex when TreeSitter is unavailable for a language.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../../../platform/instantiation/common/instantiation.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { registerSingleton, InstantiationType } from '../../../../../../platform/instantiation/common/extensions.js';
import { ITreeSitterParserService } from '../../../../../../editor/common/services/treeSitterParserService.js';

export const IDependencyGraphService = createDecorator<IDependencyGraphService>('neuralInverseDependencyGraphService');

export interface IDependencyNode {
	name: string;
	kind: 'named' | 'default' | 'namespace' | 'require' | 'dynamic';
	source: string;
}

export interface IDependencyGraphService {
	readonly _serviceBrand: undefined;
	getAllowedCalls(model: ITextModel): Promise<string[]>;
	getImports(model: ITextModel): Promise<IDependencyNode[]>;
	getExports(model: ITextModel): Promise<string[]>;
}

export class DependencyGraphService extends Disposable implements IDependencyGraphService {
	_serviceBrand: undefined;

	constructor(
		@ITreeSitterParserService private readonly _treeSitter: ITreeSitterParserService,
	) {
		super();
	}

	async getAllowedCalls(model: ITextModel): Promise<string[]> {
		const imports = await this.getImports(model);
		const names = new Set(imports.map(i => i.name));
		// Standard builtins
		names.add('console');
		names.add('Math');
		names.add('JSON');
		names.add('Promise');
		return Array.from(names);
	}

	async getImports(model: ITextModel): Promise<IDependencyNode[]> {
		const languageId = model.getLanguageId();
		const content = model.getValue();

		// Try TreeSitter first
		const tree = await this._treeSitter.getTree(content, languageId);
		if (tree) {
			return this._extractImportsFromTree(tree, languageId);
		}

		// Fallback to regex
		return this._extractImportsRegex(content, languageId);
	}

	async getExports(model: ITextModel): Promise<string[]> {
		const languageId = model.getLanguageId();
		const content = model.getValue();

		const tree = await this._treeSitter.getTree(content, languageId);
		if (tree) {
			return this._extractExportsFromTree(tree, languageId);
		}

		return this._extractExportsRegex(content);
	}

	// ─── TreeSitter AST extraction ──────────────────────────────────────────

	private _extractImportsFromTree(tree: any, languageId: string): IDependencyNode[] {
		const results: IDependencyNode[] = [];
		const root = tree.rootNode;

		if (this._isJSLike(languageId)) {
			this._walkNode(root, (node: any) => {
				// import_statement: import { a, b } from 'module'
				if (node.type === 'import_statement') {
					const source = this._findChildText(node, 'string') || '';
					const cleanSource = source.replace(/['"]/g, '');

					// import_clause → named_imports
					const namedImports = this._findDescendantsOfType(node, 'import_specifier');
					for (const spec of namedImports) {
						const name = spec.childForFieldName?.('name')?.text || spec.namedChildren?.[0]?.text || spec.text;
						if (name) results.push({ name: name.trim(), kind: 'named', source: cleanSource });
					}

					// namespace import: import * as X
					const nsImport = this._findDescendantOfType(node, 'namespace_import');
					if (nsImport) {
						const ident = this._findDescendantOfType(nsImport, 'identifier');
						if (ident) results.push({ name: ident.text, kind: 'namespace', source: cleanSource });
					}

					// default import
					const importClause = this._findDescendantOfType(node, 'import_clause');
					if (importClause) {
						const firstChild = importClause.namedChildren?.[0];
						if (firstChild?.type === 'identifier') {
							results.push({ name: firstChild.text, kind: 'default', source: cleanSource });
						}
					}
				}

				// require calls: const x = require('module')
				if (node.type === 'call_expression') {
					const callee = node.childForFieldName?.('function') || node.namedChildren?.[0];
					if (callee?.text === 'require') {
						const args = this._findDescendantOfType(node, 'string');
						const source = args?.text?.replace(/['"]/g, '') || '';
						// Walk up to find variable name
						const parent = node.parent;
						if (parent?.type === 'variable_declarator') {
							const nameNode = parent.childForFieldName?.('name') || parent.namedChildren?.[0];
							if (nameNode) {
								results.push({ name: nameNode.text, kind: 'require', source });
							}
						}
					}
				}

				// dynamic import: import('module')
				if (node.type === 'call_expression') {
					const callee = node.namedChildren?.[0];
					if (callee?.type === 'import') {
						const args = this._findDescendantOfType(node, 'string');
						const source = args?.text?.replace(/['"]/g, '') || '';
						results.push({ name: `dynamic:${source}`, kind: 'dynamic', source });
					}
				}
			});
		} else if (languageId === 'python') {
			this._walkNode(root, (node: any) => {
				if (node.type === 'import_from_statement') {
					const module = this._findDescendantOfType(node, 'dotted_name');
					const source = module?.text || '';
					const names = this._findDescendantsOfType(node, 'aliased_import')
						.concat(this._findDescendantsOfType(node, 'dotted_name').slice(1));
					for (const n of names) {
						const alias = n.type === 'aliased_import'
							? (n.childForFieldName?.('alias')?.text || n.namedChildren?.[1]?.text || n.namedChildren?.[0]?.text)
							: n.text;
						if (alias && alias !== source) results.push({ name: alias, kind: 'named', source });
					}
				}
				if (node.type === 'import_statement') {
					const names = this._findDescendantsOfType(node, 'dotted_name');
					for (const n of names) {
						results.push({ name: n.text.split('.').pop() || n.text, kind: 'default', source: n.text });
					}
				}
			});
		}

		return results;
	}

	private _extractExportsFromTree(tree: any, languageId: string): string[] {
		const results: string[] = [];
		const root = tree.rootNode;

		if (this._isJSLike(languageId)) {
			this._walkNode(root, (node: any) => {
				if (node.type === 'export_statement') {
					// export const/let/var/function/class
					const decl = node.namedChildren?.find((c: any) =>
						c.type === 'lexical_declaration' || c.type === 'function_declaration' ||
						c.type === 'class_declaration' || c.type === 'variable_declaration'
					);
					if (decl) {
						const name = decl.childForFieldName?.('name')?.text || decl.namedChildren?.[0]?.text;
						if (name) results.push(name);
					}

					// export { a, b }
					const exportClause = this._findDescendantOfType(node, 'export_clause');
					if (exportClause) {
						const specs = this._findDescendantsOfType(exportClause, 'export_specifier');
						for (const spec of specs) {
							const name = spec.childForFieldName?.('name')?.text || spec.namedChildren?.[0]?.text;
							if (name) results.push(name);
						}
					}

					// export default
					if (node.text.includes('export default')) {
						results.push('default');
					}
				}
			});
		}

		return results;
	}

	// ─── Regex fallback ─────────────────────────────────────────────────────

	private _extractImportsRegex(content: string, _languageId: string): IDependencyNode[] {
		const results: IDependencyNode[] = [];

		// Named imports: import { A, B } from 'module'
		const namedRe = /import\s*{([^}]+)}\s*from\s*['"]([^'"]+)['"]/g;
		let m;
		while ((m = namedRe.exec(content)) !== null) {
			const names = m[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean);
			for (const name of names) results.push({ name, kind: 'named', source: m[2] });
		}

		// Namespace: import * as X from 'module'
		const nsRe = /import\s*\*\s*as\s+(\w+)\s*from\s*['"]([^'"]+)['"]/g;
		while ((m = nsRe.exec(content)) !== null) {
			results.push({ name: m[1], kind: 'namespace', source: m[2] });
		}

		// Default: import X from 'module'
		const defaultRe = /import\s+(\w+)\s*from\s*['"]([^'"]+)['"]/g;
		while ((m = defaultRe.exec(content)) !== null) {
			if (m[1] !== 'type') results.push({ name: m[1], kind: 'default', source: m[2] });
		}

		// require: const X = require('module')
		const requireRe = /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
		while ((m = requireRe.exec(content)) !== null) {
			results.push({ name: m[1], kind: 'require', source: m[2] });
		}

		return results;
	}

	private _extractExportsRegex(content: string): string[] {
		const results: string[] = [];

		const exportDeclRe = /export\s+(?:const|let|var|function|class)\s+(\w+)/g;
		let m;
		while ((m = exportDeclRe.exec(content)) !== null) results.push(m[1]);

		const exportNamedRe = /export\s*{([^}]+)}/g;
		while ((m = exportNamedRe.exec(content)) !== null) {
			m[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean).forEach(n => results.push(n));
		}

		if (/export\s+default/.test(content)) results.push('default');

		return results;
	}

	// ─── AST Helpers ────────────────────────────────────────────────────────

	private _isJSLike(languageId: string): boolean {
		return ['javascript', 'typescript', 'javascriptreact', 'typescriptreact', 'tsx', 'jsx'].includes(languageId);
	}

	private _walkNode(node: any, visitor: (node: any) => void): void {
		visitor(node);
		const children = node.namedChildren || node.children || [];
		for (const child of children) {
			this._walkNode(child, visitor);
		}
	}

	private _findDescendantOfType(node: any, type: string): any | undefined {
		if (node.type === type) return node;
		const children = node.namedChildren || node.children || [];
		for (const child of children) {
			const found = this._findDescendantOfType(child, type);
			if (found) return found;
		}
		return undefined;
	}

	private _findDescendantsOfType(node: any, type: string): any[] {
		const results: any[] = [];
		this._walkNode(node, (n: any) => {
			if (n.type === type) results.push(n);
		});
		return results;
	}

	private _findChildText(node: any, type: string): string | undefined {
		const child = this._findDescendantOfType(node, type);
		return child?.text;
	}
}

registerSingleton(IDependencyGraphService, DependencyGraphService, InstantiationType.Eager);
