/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Dependency Extractor
 *
 * Two responsibilities:
 *
 * 1. **Raw import collection** (`extractRawImports`):
 *    Extracts all import/COPY/require/use statements from a source file,
 *    language by language. Called per-file during the scan phase.
 *
 * 2. **Graph resolution** (`buildDependencyGraph`):
 *    Resolves raw import strings to `IMigrationUnit.id` values within the
 *    same project. Produces `IDependencyEdge[]` with a `resolved` flag so
 *    the planner can distinguish internal vs. external dependencies.
 *
 * ## Why resolution matters
 *
 * A COBOL `COPY WS-COMMONS` might resolve to the unit
 * `proj123::src/WS-COMMONS.cpy::WS-COMMONS` — giving the planner a directed
 * dependency edge it can use to order migration units (dependencies first).
 * Unresolved edges (external libraries) are still recorded for the planner's
 * compliance notes.
 */

import { IDependencyEdge } from './discoveryTypes.js';
import { IMigrationUnit } from '../../../common/modernisationTypes.js';


// ─── Raw Import Extraction ────────────────────────────────────────────────────

/**
 * Extract all import statements from `content` for the given `lang`.
 * Returns an array of raw import strings (e.g. `"COPY WS-COMMONS"`,
 * `"./utils"`, `"com.example.Foo"`).
 */
export function extractRawImports(content: string, lang: string): string[] {
	switch (lang) {
		case 'cobol':      return extractCobolImports(content);
		case 'java':       return extractJavaImports(content);
		case 'kotlin':     return extractKotlinImports(content);
		case 'scala':      return extractScalaImports(content);
		case 'csharp':     return extractCSharpImports(content);
		case 'python':     return extractPythonImports(content);
		case 'typescript':
		case 'javascript': return extractTypeScriptImports(content);
		case 'go':         return extractGoImports(content);
		case 'rust':       return extractRustImports(content);
		case 'plsql':      return extractPLSQLImports(content);
		case 'php':        return extractPHPImports(content);
		case 'ruby':       return extractRubyImports(content);
		case 'swift':      return extractSwiftImports(content);
		case 'dart':       return extractDartImports(content);
		case 'vb':         return extractVBImports(content);
		case 'fsharp':     return extractFSharpImports(content);
		case 'groovy':     return extractGroovyImports(content);
		// ── Market vertical languages ─────────────────────────────────────
		case 'c':
		case 'cpp':
		case 'embedded-c':
		case 'embedded-cpp': return extractCImports(content);
		case 'assembler':    return extractAssemblerImports(content);
		case 'iec61131':     return extractIEC61131Imports(content);
		case 'autosar':      return extractAutosarImports(content);
		case 'can-dbc':      return extractCanDbcImports(content);
		case 'ttcn3':        return extractTTCN3Imports(content);
		default:           return [];
	}
}

// ─── Per-language extractors ─────────────────────────────────────────────────

function extractCobolImports(content: string): string[] {
	const results: string[] = [];
	// Fixed-format: COPY statement anywhere in the code (can span multiple lines)
	for (const m of content.matchAll(/\bCOPY\s+([A-Z0-9-]+)\s*(?:OF\s+[A-Z0-9-]+)?/gi)) {
		results.push(`COPY ${m[1].toUpperCase()}`);
	}
	// CALL to external programs
	for (const m of content.matchAll(/\bCALL\s+['"]([A-Z0-9-]+)['"]/gi)) {
		results.push(`CALL ${m[1].toUpperCase()}`);
	}
	return [...new Set(results)];
}

function extractJavaImports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm)) {
		results.push(m[1]);
	}
	return results;
}

function extractKotlinImports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*import\s+([\w.]+(?:\.\*|\.\{[^}]+\})?)/gm)) {
		results.push(m[1]);
	}
	return results;
}

function extractScalaImports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*import\s+([\w.]+(?:\.(?:_|\{[^}]+\}))?)/gm)) {
		results.push(m[1]);
	}
	return results;
}

function extractCSharpImports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm)) {
		results.push(m[1]);
	}
	return results;
}

function extractPythonImports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*import\s+([\w.]+)/gm)) {
		results.push(m[1]);
	}
	for (const m of content.matchAll(/^\s*from\s+([\w.]+)\s+import/gm)) {
		results.push(m[1]);
	}
	return [...new Set(results)];
}

function extractTypeScriptImports(content: string): string[] {
	const results: string[] = [];
	// import ... from '...'
	for (const m of content.matchAll(/(?:^|\s)import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/gm)) {
		results.push(m[1]);
	}
	// require('...')
	for (const m of content.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
		results.push(m[1]);
	}
	// dynamic import('...')
	for (const m of content.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gm)) {
		results.push(m[1]);
	}
	return [...new Set(results)];
}

function extractGoImports(content: string): string[] {
	const results: string[] = [];
	// Multi-line import block
	const blockMatch = content.match(/import\s*\(([\s\S]*?)\)/);
	if (blockMatch) {
		for (const m of blockMatch[1].matchAll(/"([\w./:-]+)"/g)) {
			results.push(m[1]);
		}
	}
	// Single-line import
	for (const m of content.matchAll(/^import\s+"([\w./:-]+)"/gm)) {
		results.push(m[1]);
	}
	return [...new Set(results)];
}

function extractRustImports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*use\s+([\w:{}*,\s]+)\s*;/gm)) {
		// Normalise multi-imports like "use std::{collections::HashMap, io::Write}"
		const raw = m[1].replace(/[{}\s]/g, '');
		for (const part of raw.split(',')) {
			const root = part.split('::')[0];
			if (root) { results.push(part); }
		}
	}
	// extern crate
	for (const m of content.matchAll(/^\s*extern\s+crate\s+(\w+)\s*;/gm)) {
		results.push(m[1]);
	}
	return [...new Set(results)];
}

function extractPLSQLImports(content: string): string[] {
	const results: string[] = [];
	// Calls to other packages/procedures
	for (const m of content.matchAll(/\b(\w+)\s*\.\s*(\w+)\s*\(/g)) {
		results.push(`${m[1]}.${m[2]}`);
	}
	return [...new Set(results)];
}

function extractPHPImports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*use\s+([\w\\]+)/gm)) { results.push(m[1]); }
	for (const m of content.matchAll(/(?:require|include)(?:_once)?\s*['"]([^'"]+)['"]/gm)) { results.push(m[1]); }
	return [...new Set(results)];
}

function extractRubyImports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm)) {
		results.push(m[1]);
	}
	return results;
}

function extractSwiftImports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*import\s+(\w+)/gm)) { results.push(m[1]); }
	return results;
}

function extractDartImports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) { results.push(m[1]); }
	return results;
}

function extractVBImports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*Imports\s+([\w.]+)/gm)) { results.push(m[1]); }
	return results;
}

function extractFSharpImports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*open\s+([\w.]+)/gm)) { results.push(m[1]); }
	return results;
}

function extractGroovyImports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*/gm)) {
		results.push(m[1]);
	}
	return results;
}


// ─── Market Vertical Languages ───────────────────────────────────────────────

function extractCImports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*#\s*include\s*["<]([^">\s]+)[">/]/gm)) {
		results.push(m[1]);
	}
	return results;
}

function extractAssemblerImports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*(?:#include|\.include)\s+["<]?([\w./\\]+)[">/]?/gim)) {
		results.push(m[1]);
	}
	return results;
}

function extractIEC61131Imports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*(?:USES|FROM)\s+([\w.]+)/gim)) {
		results.push(m[1]);
	}
	return results;
}

function extractAutosarImports(content: string): string[] {
	// ARXML references other ARXML packages via SHORT-NAME paths or DEST attributes
	const results: string[] = [];
	for (const m of content.matchAll(/<BASE-REF\s+DEST="[^"]*">([^<]+)<\/BASE-REF>/g)) {
		results.push(m[1].split('/').pop() ?? m[1]);
	}
	for (const m of content.matchAll(/<CATEGORY>([^<]+)<\/CATEGORY>/g)) {
		results.push(m[1]);
	}
	return [...new Set(results)];
}

function extractCanDbcImports(content: string): string[] {
	// DBC files reference other nodes (ECU names) and signal groups
	const results: string[] = [];
	for (const m of content.matchAll(/^BU_:(.+)/gm)) {
		for (const node of m[1].trim().split(/\s+/)) {
			if (node) { results.push(node); }
		}
	}
	return results;
}

function extractTTCN3Imports(content: string): string[] {
	const results: string[] = [];
	for (const m of content.matchAll(/^\s*import\s+from\s+(\w+)\s+/gm)) {
		results.push(m[1]);
	}
	return results;
}


// ─── Dependency Graph Resolution ─────────────────────────────────────────────

/**
 * Resolve raw import strings to `IDependencyEdge[]` for a project.
 *
 * Strategy:
 *  1. Build lookup tables: unitName → id, fileBasename (no ext) → id.
 *  2. For each raw edge, extract the terminal name (leaf of dotted path, last segment of '/'-path, COPY name).
 *  3. Look up in the tables; mark `resolved: true` if found.
 *
 * @param units    All `IMigrationUnit`s within the project
 * @param rawEdges Emitted by the unit decomposer / file processor
 */
export function buildDependencyGraph(
	units: IMigrationUnit[],
	rawEdges: Array<{ fromUnitId: string; rawImport: string }>,
): IDependencyEdge[] {
	const edges: IDependencyEdge[] = [];

	// Build lookup maps
	const byName = new Map<string, string>(); // lower unitName → id
	const byBase = new Map<string, string>(); // lower basename (no ext) → id

	for (const unit of units) {
		byName.set(unit.unitName.toLowerCase(), unit.id);
		const base = unit.legacyFilePath.replace(/\\/g, '/').split('/').pop()?.replace(/\.[^.]+$/, '').toLowerCase();
		if (base) { byBase.set(base, unit.id); }
	}

	for (const { fromUnitId, rawImport } of rawEdges) {
		const imported = parseImportLeaf(rawImport);
		if (!imported) { continue; }

		const norm = imported.toLowerCase().replace(/['"]/g, '');
		// Try: exact name match → basename match → basename without extension
		const resolvedId =
			byName.get(norm) ??
			byBase.get(norm) ??
			byBase.get(norm.replace(/\.[^.]+$/, '')) ??
			byName.get(norm.split('/').pop() ?? norm) ??
			byBase.get(norm.split('/').pop() ?? norm);

		if (!edges.some(e => e.fromId === fromUnitId && e.toId === (resolvedId ?? imported))) {
			edges.push({
				fromId:          fromUnitId,
				toId:            resolvedId ?? imported,
				importStatement: rawImport,
				resolved:        !!resolvedId,
			});
		}
	}

	return edges;
}

/**
 * Extract the terminal (leaf) name from a raw import string.
 *
 * Examples:
 *  `COPY WS-COMMONS`         → `WS-COMMONS`
 *  `import ./utils/foo`      → `foo`
 *  `com.example.service.Foo` → `Foo`
 *  `std::collections::HashMap` → `HashMap`
 */
function parseImportLeaf(rawImport: string): string | undefined {
	if (!rawImport.trim()) { return undefined; }

	// COBOL COPY
	const copyM = /^COPY\s+([A-Z0-9-]+)/i.exec(rawImport);
	if (copyM) { return copyM[1]; }

	// COBOL CALL
	const callM = /^CALL\s+['"]?([A-Z0-9-]+)['"]?/i.exec(rawImport);
	if (callM) { return callM[1]; }

	const trimmed = rawImport.trim().replace(/['"]/g, '');

	// Path-like: `./foo/bar`, `../bar/baz`, `@scope/pkg/file`
	if (trimmed.includes('/')) {
		return trimmed.split('/').filter(Boolean).pop();
	}
	// Dotted: `com.example.Foo`, `std.collections`
	if (trimmed.includes('.')) {
		return trimmed.split('.').pop();
	}
	// Colon-separated (Rust, Swift)
	if (trimmed.includes('::')) {
		return trimmed.split('::').pop();
	}

	return trimmed;
}
