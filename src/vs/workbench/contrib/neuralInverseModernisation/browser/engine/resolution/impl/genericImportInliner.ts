/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Generic Import Inliner
 *
 * Fallback dependency context injector for modern languages that do not support
 * flat-file text expansion (TypeScript, Python, Go, Rust, C#, VB, Kotlin, Scala, etc.).
 *
 * ## The Context Problem
 *
 * Unlike COBOL copybooks (where the imported text literally replaces the COPY statement),
 * modern languages use module systems where importing a symbol does NOT include its source.
 * The compiler resolves the reference at link/compile time \u2014 the AI sees only the identifier,
 * not its definition.
 *
 * Example (TypeScript):
 * ```ts
 * import { CustomerService } from './services/CustomerService';
 * //                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^
 * //  The AI knows the name "CustomerService" but not its method signatures,
 * //  business rules, or risk level \u2014 unless those details are injected.
 * ```
 *
 * ## Strategy
 *
 * For each import statement found:
 *
 * a) Exact module match in KB \u2192 inject a structured context comment with:
 *    - Status (pending/ready/translated)
 *    - Risk level
 *    - Business purpose (from business rules)
 *    - Public interface (from `targetInterface.signatures`, or extracted from sourceText)
 *    - Domain membership
 *
 * b) No match in KB \u2192 inject a lightweight comment noting the import is external
 *    or not yet scanned.
 *
 * ## Why Comments, Not Expansion?
 *
 * Inlining class bodies inline would produce invalid code in every modern language.
 * Comment injection preserves syntactic validity while giving the AI the semantic
 * context it needs to understand what an imported symbol does.
 *
 * ## Languages Supported
 *
 * - TypeScript / JavaScript (`import`, `require`, `export * from`)
 * - Python (`import`, `from \u2026 import`)
 * - Go (`import "pkg"`, block imports)
 * - Rust (`use module::item`, `extern crate`)
 * - C# (`using Namespace.Name`)
 * - Visual Basic (`Imports Namespace.Name`)
 * - Kotlin (`import package.ClassName`)
 * - Scala (`import package.ClassName`)
 */

import { IDependencyRef, IDependencyResolutionResult } from './resolutionTypes.js';
import { IKnowledgeBaseService } from '../../../knowledgeBase/service.js';


// \u2500\u2500\u2500 Public API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface IGenericInlineOptions {
	insertMarkers: boolean;
	maxMethodsPerImport: number;
	/** Whether to include "NOT IN KB" comments for unresolved imports */
	includeUnresolvedComments: boolean;
}

export interface IGenericInlineResult {
	expandedSource: string;
	resolvedRefs: IDependencyResolutionResult[];
	unresolvedRefs: IDependencyResolutionResult[];
}


/**
 * Inject KB context comments for import statements in modern language source files.
 */
export function resolveGenericImports(
	sourceText: string,
	language: string,
	kb: IKnowledgeBaseService,
	options: IGenericInlineOptions,
): IGenericInlineResult {
	if (!options.insertMarkers) {
		return { expandedSource: sourceText, resolvedRefs: [], unresolvedRefs: [] };
	}

	const resolvedRefs: IDependencyResolutionResult[] = [];
	const unresolvedRefs: IDependencyResolutionResult[] = [];

	const imports = extractImportStatements(sourceText, language);
	if (imports.length === 0) {
		return { expandedSource: sourceText, resolvedRefs, unresolvedRefs };
	}

	const commentStyle = getCommentStyle(language);
	const contextLines: string[] = [
		`${commentStyle.line} \u2550\u2550 NEURAL INVERSE \u2014 IMPORT CONTEXT \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`,
		`${commentStyle.line} Imported symbols resolved from Knowledge Base:`,
		`${commentStyle.line}`,
	];

	const seen = new Set<string>();

	for (const imp of imports) {
		// Deduplicate by canonical symbol name
		if (seen.has(imp.canonicalName)) {
			continue;
		}
		seen.add(imp.canonicalName);

		// Try several matching strategies: exact name, partial name, ends-with
		const unit = kb.getAllUnits().find(u =>
			u.name === imp.canonicalName ||
			u.name.endsWith(`.${imp.canonicalName}`) ||
			u.name.endsWith(`/${imp.canonicalName}`) ||
			u.name.includes(imp.canonicalName),
		);

		const depRef: IDependencyRef = {
			rawRef: imp.rawStatement,
			canonicalName: imp.canonicalName,
			line: imp.line,
			depType: 'generic-import',
		};

		if (!unit) {
			if (options.includeUnresolvedComments) {
				contextLines.push(`${commentStyle.line} import ${imp.canonicalName}`);
				contextLines.push(`${commentStyle.line}   [NOT IN KNOWLEDGE BASE \u2014 external library or not yet scanned]`);
				contextLines.push(`${commentStyle.line}`);
			}
			unresolvedRefs.push({
				ref: depRef,
				resolved: false,
				inlinedContent: '',
				failureReason: `${imp.canonicalName} not found in knowledge base`,
				isExternal: isLikelyExternalLibrary(imp.modulePath),
			});
			continue;
		}

		contextLines.push(`${commentStyle.line} import ${imp.canonicalName} (from ${unit.name})`);
		contextLines.push(`${commentStyle.line}   Status:  ${unit.status.toUpperCase()} | Risk: ${unit.riskLevel.toUpperCase()}`);

		if (unit.domain) {
			contextLines.push(`${commentStyle.line}   Domain:  ${unit.domain}`);
		}

		if (unit.businessRules.length > 0) {
			contextLines.push(`${commentStyle.line}   Purpose: ${unit.businessRules[0].description}`);
		}

		// Prefer modern interface signatures over source-extracted ones
		if (unit.targetInterface && unit.targetInterface.signatures.length > 0) {
			const sigLimit = options.maxMethodsPerImport;
			const sigs = unit.targetInterface.signatures.slice(0, sigLimit);
			contextLines.push(`${commentStyle.line}   Interface (${unit.targetInterface.targetLanguage}):`);
			for (const sig of sigs) {
				contextLines.push(`${commentStyle.line}     ${sig}`);
			}
			if (unit.targetInterface.signatures.length > sigLimit) {
				contextLines.push(`${commentStyle.line}     \u2026 (${unit.targetInterface.signatures.length - sigLimit} more)`);
			}
		} else {
			// Extract public methods from source text as fallback
			const sigs = extractPublicSignatures(unit.sourceText, unit.sourceLang, options.maxMethodsPerImport);
			if (sigs.length > 0) {
				contextLines.push(`${commentStyle.line}   Source signatures (${unit.sourceLang}):`);
				for (const sig of sigs) {
					contextLines.push(`${commentStyle.line}     ${sig}`);
				}
			}
		}

		contextLines.push(`${commentStyle.line}`);

		resolvedRefs.push({
			ref: depRef,
			resolved: true,
			inlinedContent: '',
			resolvedUnitId: unit.id,
		});
	}

	if (resolvedRefs.length === 0 && (!options.includeUnresolvedComments || unresolvedRefs.every(r => r.isExternal))) {
		// Nothing interesting to inject \u2014 all imports are external libraries
		return { expandedSource: sourceText, resolvedRefs, unresolvedRefs };
	}

	contextLines.push(`${commentStyle.line} \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550`);
	contextLines.push('');

	const header = contextLines.join('\n');
	return {
		expandedSource: header + sourceText,
		resolvedRefs,
		unresolvedRefs,
	};
}


// \u2500\u2500\u2500 Import Statement Parsers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface IImportStatement {
	/** The full raw text of the import line */
	rawStatement: string;
	/** The module/package path being imported */
	modulePath: string;
	/** The canonical symbol name (class, module, or namespace) */
	canonicalName: string;
	/** 1-based line number */
	line: number;
}

/**
 * Dispatch to the correct language-specific import parser.
 */
function extractImportStatements(text: string, language: string): IImportStatement[] {
	const lang = language.toLowerCase();

	if (lang === 'typescript' || lang === 'javascript' || lang === 'tsx' || lang === 'jsx') {
		return extractTypeScriptImports(text);
	}
	if (lang === 'python' || lang === 'python3') {
		return extractPythonImports(text);
	}
	if (lang === 'go' || lang === 'golang') {
		return extractGoImports(text);
	}
	if (lang === 'rust') {
		return extractRustImports(text);
	}
	if (lang === 'csharp' || lang === 'c#' || lang === 'cs') {
		return extractCSharpImports(text);
	}
	if (lang === 'vb' || lang === 'vbnet' || lang === 'vb.net' || lang === 'visualbasic') {
		return extractVBImports(text);
	}
	if (lang === 'kotlin' || lang === 'scala') {
		return extractJvmImports(text);
	}

	// Fallback: attempt TypeScript-style import parsing
	return extractTypeScriptImports(text);
}


// \u2500\u2500\u2500 TypeScript / JavaScript \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractTypeScriptImports(text: string): IImportStatement[] {
	const results: IImportStatement[] = [];
	const lines = text.split('\n');

	// Named imports:   import { Foo, Bar } from 'module'
	// Default import:  import Foo from 'module'
	// Namespace import: import * as Foo from 'module'
	// Side-effect:     import 'module'
	// Require:         const Foo = require('module')
	// Export re-export: export { Foo } from 'module'
	const IMPORT_RE = /^\s*(?:import|export)\s+(?:(?:type\s+)?(?:[\w*{},\s$]+)\s+from\s+)?['"]([^'"]+)['"]/;
	const REQUIRE_RE = /(?:const|let|var)\s+([\w$]+)\s*=\s*require\(['"]([^'"]+)['"]\)/;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		const m = IMPORT_RE.exec(line);
		if (m) {
			const modulePath = m[1];
			// Extract the symbol names \u2014 grab everything between 'import' and 'from'
			const symbolMatch = line.match(/import\s+(?:type\s+)?({[^}]+}|\*\s+as\s+\w+|\w+)/);
			let canonical = deriveCanonicalName(modulePath);
			if (symbolMatch) {
				const sym = symbolMatch[1].replace(/[{}\s*]/g, '').split(',')[0].split('as').pop()?.trim();
				if (sym && sym.length > 0 && !isGenericKeyword(sym)) {
					canonical = sym;
				}
			}
			if (!isNoiseImport(modulePath)) {
				results.push({ rawStatement: line.trim(), modulePath, canonicalName: canonical, line: i + 1 });
			}
			continue;
		}

		const r = REQUIRE_RE.exec(line);
		if (r) {
			const varName = r[1];
			const modulePath = r[2];
			if (!isNoiseImport(modulePath)) {
				results.push({ rawStatement: line.trim(), modulePath, canonicalName: varName, line: i + 1 });
			}
		}
	}

	return results;
}


// \u2500\u2500\u2500 Python \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractPythonImports(text: string): IImportStatement[] {
	const results: IImportStatement[] = [];
	const lines = text.split('\n');

	// from module import Foo, Bar
	const FROM_RE = /^\s*from\s+([\w.]+)\s+import\s+(.+)/;
	// import module
	const IMPORT_RE = /^\s*import\s+([\w.,\s]+)/;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (!line || line.startsWith('#')) {
			continue;
		}

		const fromM = FROM_RE.exec(line);
		if (fromM) {
			const modulePath = fromM[1];
			const symbols = fromM[2].split(',').map(s => s.split(' as ').pop()!.trim()).filter(s => s && s !== '*');
			for (const sym of symbols) {
				if (sym && !isStandardPythonModule(modulePath)) {
					results.push({ rawStatement: line, modulePath, canonicalName: sym, line: i + 1 });
				}
			}
			continue;
		}

		const importM = IMPORT_RE.exec(line);
		if (importM) {
			const parts = importM[1].split(',').map(s => s.trim());
			for (const part of parts) {
				const canonical = part.split(' as ').pop()!.trim();
				if (canonical && !isStandardPythonModule(canonical)) {
					results.push({ rawStatement: line, modulePath: canonical, canonicalName: canonical, line: i + 1 });
				}
			}
		}
	}

	return results;
}


// \u2500\u2500\u2500 Go \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractGoImports(text: string): IImportStatement[] {
	const results: IImportStatement[] = [];
	const lines = text.split('\n');

	// Single import:  import "package/path"
	// Block import:   import (
	//                     "pkg/a"
	//                     alias "pkg/b"
	//                 )
	let inBlock = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		if (line === 'import (') {
			inBlock = true;
			continue;
		}
		if (inBlock && line === ')') {
			inBlock = false;
			continue;
		}

		if (inBlock) {
			const m = line.match(/^(?:(\w+)\s+)?["']([^"']+)["']/);
			if (m) {
				const alias = m[1];
				const pkgPath = m[2];
				if (!isStandardGoPackage(pkgPath)) {
					const canonical = alias ?? pkgPath.split('/').pop() ?? pkgPath;
					results.push({ rawStatement: line, modulePath: pkgPath, canonicalName: canonical, line: i + 1 });
				}
			}
			continue;
		}

		// Single-line import
		const m = line.match(/^import\s+(?:(\w+)\s+)?["']([^"']+)["']/);
		if (m) {
			const alias = m[1];
			const pkgPath = m[2];
			if (!isStandardGoPackage(pkgPath)) {
				const canonical = alias ?? pkgPath.split('/').pop() ?? pkgPath;
				results.push({ rawStatement: line, modulePath: pkgPath, canonicalName: canonical, line: i + 1 });
			}
		}
	}

	return results;
}


// \u2500\u2500\u2500 Rust \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractRustImports(text: string): IImportStatement[] {
	const results: IImportStatement[] = [];
	const lines = text.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// use std::... \u2014 skip standard library
		if (line.startsWith('use std::') || line.startsWith('use core::')) {
			continue;
		}

		// use crate::module::Type  or  use external_crate::Type
		const m = line.match(/^use\s+([\w:]+(?:::\{[^}]+\})?)\s*;/);
		if (m) {
			const path = m[1];
			// Extract the last segment as the canonical name
			const segments = path.replace(/[{}]/g, '').split('::');
			const canonical = segments[segments.length - 1].trim();
			if (canonical && canonical !== 'self' && !isGenericKeyword(canonical)) {
				results.push({ rawStatement: line, modulePath: path, canonicalName: canonical, line: i + 1 });
			}
		}

		// extern crate foo;
		const extM = line.match(/^extern\s+crate\s+(\w+)/);
		if (extM) {
			results.push({ rawStatement: line, modulePath: extM[1], canonicalName: extM[1], line: i + 1 });
		}
	}

	return results;
}


// \u2500\u2500\u2500 C# \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractCSharpImports(text: string): IImportStatement[] {
	const results: IImportStatement[] = [];
	const lines = text.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// using System.Collections.Generic;
		// using alias = Namespace.Type;
		const m = line.match(/^using\s+(?:[\w]+\s*=\s*)?([\w.]+)\s*;/);
		if (m) {
			const ns = m[1];
			if (!isStandardCSharpNamespace(ns)) {
				const canonical = ns.split('.').pop() ?? ns;
				results.push({ rawStatement: line, modulePath: ns, canonicalName: canonical, line: i + 1 });
			}
		}
	}

	return results;
}


// \u2500\u2500\u2500 Visual Basic \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractVBImports(text: string): IImportStatement[] {
	const results: IImportStatement[] = [];
	const lines = text.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// Imports Namespace.Name
		// Imports Alias = Namespace.Name
		const m = line.match(/^Imports\s+(?:\w+\s*=\s*)?([\w.]+)/i);
		if (m) {
			const ns = m[1];
			if (!isStandardVBNamespace(ns)) {
				const canonical = ns.split('.').pop() ?? ns;
				results.push({ rawStatement: line, modulePath: ns, canonicalName: canonical, line: i + 1 });
			}
		}
	}

	return results;
}


// \u2500\u2500\u2500 Kotlin / Scala \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function extractJvmImports(text: string): IImportStatement[] {
	const results: IImportStatement[] = [];
	const lines = text.split('\n');

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();

		// import com.example.ClassName
		// import com.example.ClassName as Alias
		const m = line.match(/^import\s+([\w.]+)(?:\s+as\s+(\w+))?/);
		if (m) {
			const fqn = m[1];
			const alias = m[2];
			if (!isStandardJvmPackage(fqn)) {
				const canonical = alias ?? fqn.split('.').pop() ?? fqn;
				results.push({ rawStatement: line, modulePath: fqn, canonicalName: canonical, line: i + 1 });
			}
		}
	}

	return results;
}


// \u2500\u2500\u2500 Public Method Signature Extraction (Fallback) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Heuristic extraction of public method/function signatures from source text.
 * Used when a KB unit has no `targetInterface` yet.
 */
function extractPublicSignatures(sourceText: string, language: string, maxSigs: number): string[] {
	const sigs: string[] = [];
	const lang = language.toLowerCase();

	if (lang === 'typescript' || lang === 'javascript' || lang === 'tsx' || lang === 'jsx') {
		const RE = /(?:export\s+)?(?:public\s+)?(?:async\s+)?function\s+([\w$]+)\s*\(([^)]*)\)/g;
		let m: RegExpExecArray | null;
		while ((m = RE.exec(sourceText)) !== null) {
			sigs.push(`${m[1]}(${m[2].trim()})`);
			if (sigs.length >= maxSigs) { break; }
		}
	} else if (lang === 'python' || lang === 'python3') {
		const RE = /^def\s+([\w_]+)\s*\(([^)]*)\)/gm;
		let m: RegExpExecArray | null;
		while ((m = RE.exec(sourceText)) !== null) {
			if (!m[1].startsWith('_')) {
				sigs.push(`def ${m[1]}(${m[2].trim()})`);
				if (sigs.length >= maxSigs) { break; }
			}
		}
	} else if (lang === 'java' || lang === 'kotlin' || lang === 'scala') {
		const RE = /public\s+(?:static\s+)?(?:\w+\s+)?([\w$]+)\s*\(([^)]*)\)/g;
		let m: RegExpExecArray | null;
		while ((m = RE.exec(sourceText)) !== null) {
			const name = m[1];
			if (!['class', 'interface', 'enum'].includes(name)) {
				sigs.push(`${name}(${m[2].trim()})`);
				if (sigs.length >= maxSigs) { break; }
			}
		}
	} else if (lang === 'go' || lang === 'golang') {
		const RE = /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?([\w]+)\s*\(([^)]*)\)/gm;
		let m: RegExpExecArray | null;
		while ((m = RE.exec(sourceText)) !== null) {
			if (m[1][0] === m[1][0].toUpperCase()) {
				// Exported Go functions start with uppercase
				sigs.push(`func ${m[1]}(${m[2].trim()})`);
				if (sigs.length >= maxSigs) { break; }
			}
		}
	}

	return sigs;
}


// \u2500\u2500\u2500 Comment Style \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

interface ICommentStyle {
	line: string;
}

function getCommentStyle(language: string): ICommentStyle {
	const lang = language.toLowerCase();
	if (lang === 'python' || lang === 'python3') {
		return { line: '#' };
	}
	if (lang === 'vb' || lang === 'vbnet' || lang === 'vb.net' || lang === 'visualbasic') {
		return { line: "'" };
	}
	// TypeScript, JavaScript, Go, Rust, C#, Kotlin, Scala, Java: C-style
	return { line: '//' };
}


// \u2500\u2500\u2500 Canonical Name Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Derive a canonical symbol name from a module path.
 * e.g. './services/CustomerService' \u2192 'CustomerService'
 *      'lodash' \u2192 'lodash'
 *      '@company/billing-utils' \u2192 'billing-utils'
 */
function deriveCanonicalName(modulePath: string): string {
	// Take the last path segment, strip file extensions and prefix @
	const segment = modulePath.split('/').pop() ?? modulePath;
	return segment.replace(/\.(js|ts|jsx|tsx|mjs|cjs)$/, '');
}


// \u2500\u2500\u2500 Filter Helpers \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

/**
 * Whether a module path is likely an external/third-party library that won't
 * be in the project's KB (e.g. 'react', '@angular/core', 'lodash').
 */
function isLikelyExternalLibrary(modulePath: string): boolean {
	// Relative paths are project-internal
	if (modulePath.startsWith('.')) {
		return false;
	}
	// Node built-ins
	const nodeBuiltins = new Set([
		'fs', 'path', 'os', 'http', 'https', 'url', 'crypto', 'stream', 'util', 'events',
		'buffer', 'child_process', 'cluster', 'dns', 'net', 'readline', 'tls', 'zlib',
		'assert', 'console', 'module', 'process', 'timers', 'querystring', 'string_decoder',
	]);
	if (nodeBuiltins.has(modulePath)) {
		return true;
	}
	return true; // Non-relative, non-built-in paths are typically npm/PyPI/Go module packages
}

function isNoiseImport(modulePath: string): boolean {
	// Skip CSS, image, and font imports
	return /\.(css|scss|sass|less|png|jpg|jpeg|gif|svg|ttf|woff|woff2|eot|ico|json)$/.test(modulePath);
}

function isGenericKeyword(sym: string): boolean {
	return ['default', 'type', 'interface', 'class', 'function', 'const', 'let', 'var'].includes(sym);
}


// \u2500\u2500\u2500 Standard Library Filters \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const STANDARD_PYTHON_MODULES = new Set([
	'os', 'sys', 'io', 're', 'json', 'datetime', 'collections', 'itertools', 'functools',
	'math', 'random', 'pathlib', 'typing', 'abc', 'contextlib', 'copy', 'enum',
	'logging', 'unittest', 'dataclasses', 'hashlib', 'hmac', 'base64', 'uuid',
	'threading', 'multiprocessing', 'asyncio', 'inspect', 'traceback', 'warnings',
	'string', 'textwrap', 'struct', 'pickle', 'shelve', 'csv', 'xml', 'html',
	'http', 'urllib', 'socket', 'ssl', 'email', 'smtplib', 'ftplib', 'time',
	'calendar', 'heapq', 'bisect', 'queue', 'weakref', 'gc', 'platform', 'shutil',
	'glob', 'fnmatch', 'tempfile', 'subprocess', 'signal', 'ctypes', 'decimal',
	'fractions', 'statistics', 'secrets', 'ast', 'dis', 'builtins', 'operator',
]);

function isStandardPythonModule(modulePath: string): boolean {
	const root = modulePath.split('.')[0];
	return STANDARD_PYTHON_MODULES.has(root);
}

const STANDARD_GO_PACKAGES = new Set([
	'fmt', 'os', 'io', 'bufio', 'net', 'net/http', 'net/url', 'encoding/json', 'encoding/xml',
	'strings', 'strconv', 'bytes', 'sort', 'math', 'math/rand', 'time', 'sync', 'sync/atomic',
	'context', 'errors', 'log', 'path', 'path/filepath', 'runtime', 'reflect', 'regexp',
	'unicode', 'testing', 'flag', 'crypto', 'crypto/sha256', 'crypto/tls', 'crypto/md5',
	'database/sql', 'html', 'html/template', 'text/template', 'archive/zip', 'compress/gzip',
]);

function isStandardGoPackage(pkgPath: string): boolean {
	return STANDARD_GO_PACKAGES.has(pkgPath) || !pkgPath.includes('.');
}

const STANDARD_CSHARP_NAMESPACES = new Set([
	'System', 'System.Collections', 'System.Collections.Generic', 'System.Linq', 'System.Text',
	'System.IO', 'System.Threading', 'System.Threading.Tasks', 'System.Net', 'System.Net.Http',
	'System.Reflection', 'System.Diagnostics', 'System.Runtime', 'System.Security',
	'System.Xml', 'System.Xml.Linq', 'System.Data', 'System.Web', 'System.Windows',
	'Microsoft.Extensions', 'Microsoft.AspNetCore', 'Microsoft.EntityFrameworkCore',
]);

function isStandardCSharpNamespace(ns: string): boolean {
	for (const standard of STANDARD_CSHARP_NAMESPACES) {
		if (ns === standard || ns.startsWith(standard + '.')) {
			return true;
		}
	}
	return false;
}

const STANDARD_VB_NAMESPACES = new Set([
	'System', 'System.Collections', 'System.IO', 'System.Text', 'System.Threading',
	'Microsoft.VisualBasic', 'System.Windows.Forms', 'System.Drawing', 'System.Data',
]);

function isStandardVBNamespace(ns: string): boolean {
	for (const standard of STANDARD_VB_NAMESPACES) {
		if (ns === standard || ns.startsWith(standard + '.')) {
			return true;
		}
	}
	return false;
}

function isStandardJvmPackage(fqn: string): boolean {
	return fqn.startsWith('java.') ||
		fqn.startsWith('javax.') ||
		fqn.startsWith('kotlin.') ||
		fqn.startsWith('scala.') ||
		fqn.startsWith('android.') ||
		fqn.startsWith('sun.') ||
		fqn.startsWith('com.sun.');
}
