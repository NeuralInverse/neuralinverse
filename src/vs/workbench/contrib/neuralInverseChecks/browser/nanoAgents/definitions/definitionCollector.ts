/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Definition Collector
 *
 * For each import in a file, resolves where it actually comes from using
 * VS Code's definitionProvider (go-to-definition).
 *
 * This tells the GRC engine:
 * - Which imports come from node_modules (external, potentially untrusted)
 * - Which come from other workspace files (internal, GRC-auditable)
 * - Which are re-exports or barrel files (need cross-file tracing)
 *
 * Used by Layer 2 AI: knowing `crypto.createHash` resolves to `node:crypto`
 * vs a custom wrapper changes how the AI evaluates crypto-related GRC rules.
 */

import { ILanguageFeaturesService } from '../../../../../../editor/common/services/languageFeatures.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { DocumentSymbol, SymbolKind, Location, LocationLink } from '../../../../../../editor/common/languages.js';
import { Position } from '../../../../../../editor/common/core/position.js';
import { URI } from '../../../../../../base/common/uri.js';

export interface IDefinitionEntry {
	name: string;
	line: number;
	resolvedUri: string;
	isExternal: boolean;
	isWorkspace: boolean;
}

export class DefinitionCollector {
	constructor(private readonly languageFeaturesService: ILanguageFeaturesService) { }

	public async collect(model: ITextModel, symbols: DocumentSymbol[]): Promise<IDefinitionEntry[]> {
		const providers = this.languageFeaturesService.definitionProvider.ordered(model);
		if (providers.length === 0) return [];

		const provider = providers[0];
		const results: IDefinitionEntry[] = [];
		const fileUri = model.uri.toString();
		// Derive workspace root by finding '/src/' boundary; fall back to scheme+authority
		const srcIdx = fileUri.lastIndexOf('/src/');
		const workspacePrefix = srcIdx !== -1 ? fileUri.substring(0, srcIdx) : model.uri.scheme + '://' + model.uri.authority;

		// Only query Module/Namespace/Package symbols \u2014 these map to imports
		const IMPORT_KINDS = new Set([SymbolKind.Module, SymbolKind.Namespace, SymbolKind.Package]);
		const flat = this._flatten(symbols).filter(s => IMPORT_KINDS.has(s.kind)).slice(0, 20);

		await Promise.all(flat.map(async (sym) => {
			try {
				const pos = new Position(sym.selectionRange.startLineNumber, sym.selectionRange.startColumn);
				const defs = await provider.provideDefinition(model, pos, CancellationToken.None);
				if (!defs) return;

				// Definition = Location | Location[] | LocationLink[]
				// Both Location and LocationLink have a `.uri` field.
				let resolvedUri: URI | undefined;
				if (Array.isArray(defs)) {
					const first = defs[0] as Location | LocationLink | undefined;
					resolvedUri = first?.uri;
				} else {
					// Single Location
					resolvedUri = (defs as Location).uri;
				}
				if (!resolvedUri) return;

				const uriStr = resolvedUri.toString();
				const isExternal = uriStr.includes('node_modules') || uriStr.includes('/@types/') || resolvedUri.scheme === 'node';
				const isWorkspace = !isExternal && uriStr.startsWith(workspacePrefix);

				results.push({
					name: sym.name,
					line: sym.selectionRange.startLineNumber,
					resolvedUri: uriStr.replace(workspacePrefix, ''),
					isExternal,
					isWorkspace,
				});
			} catch {
				// definition unavailable \u2014 skip silently
			}
		}));

		return results;
	}

	private _flatten(symbols: DocumentSymbol[]): DocumentSymbol[] {
		const out: DocumentSymbol[] = [];
		const walk = (items: DocumentSymbol[]) => {
			for (const s of items) {
				out.push(s);
				if (s.children) walk(s.children as DocumentSymbol[]);
			}
		};
		walk(symbols);
		return out;
	}
}
