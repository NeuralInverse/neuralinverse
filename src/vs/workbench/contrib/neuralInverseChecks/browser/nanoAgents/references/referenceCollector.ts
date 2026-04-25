/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Reference Collector
 *
 * For each exported symbol in a file, queries VS Code's referenceProvider to
 * find how many times it is used across the workspace.
 *
 * High reference counts mean a symbol is widely depended on \u2014 a GRC violation
 * in it has higher blast radius. Layer 2 AI uses this to calibrate severity.
 *
 * Also detects whether a symbol is ONLY used internally (low cross-file risk)
 * vs exported and called from many places (high cross-file risk).
 */

import { ILanguageFeaturesService } from '../../../../../../editor/common/services/languageFeatures.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { DocumentSymbol, SymbolKind } from '../../../../../../editor/common/languages.js';
import { Position } from '../../../../../../editor/common/core/position.js';

export interface ISymbolReferenceInfo {
	name: string;
	line: number;
	referenceCount: number;
	crossFileCount: number;
}

const EXPORTED_KINDS = new Set([
	SymbolKind.Function, SymbolKind.Method, SymbolKind.Class, SymbolKind.Interface,
	SymbolKind.Constructor, SymbolKind.Constant,
]);

export class ReferenceCollector {
	constructor(private readonly languageFeaturesService: ILanguageFeaturesService) { }

	public async collect(model: ITextModel, symbols: DocumentSymbol[]): Promise<ISymbolReferenceInfo[]> {
		const providers = this.languageFeaturesService.referenceProvider.ordered(model);
		if (providers.length === 0) return [];

		const provider = providers[0];
		const results: ISymbolReferenceInfo[] = [];

		const flat = this._flatten(symbols).filter(s => EXPORTED_KINDS.has(s.kind));
		// Cap at 15 symbols \u2014 reference queries can be slow on large workspaces
		const targets = flat.slice(0, 15);

		await Promise.all(targets.map(async (sym) => {
			try {
				const pos = new Position(sym.selectionRange.startLineNumber, sym.selectionRange.startColumn);
				const refs = await provider.provideReferences(
					model, pos,
					{ includeDeclaration: false },
					CancellationToken.None
				);
				if (!refs) return;

				const fileUri = model.uri.toString();
				const crossFile = refs.filter(r => r.uri.toString() !== fileUri).length;

				results.push({
					name: sym.name,
					line: sym.selectionRange.startLineNumber,
					referenceCount: refs.length,
					crossFileCount: crossFile,
				});
			} catch {
				// reference provider unavailable or timed out \u2014 skip
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
