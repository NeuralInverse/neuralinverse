/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Hover Collector
 *
 * Collects type signatures for every function/method/variable symbol in a file
 * by querying VS Code's hoverProvider (the same data shown in editor tooltips).
 *
 * For TypeScript/JavaScript this returns the full inferred type signature:
 *   `function processPayment(amount: number, currency: Currency): Promise<PaymentResult>`
 *
 * This is injected into the AI prompt so Layer 2 knows exact types — no guessing from raw code.
 */

import { ILanguageFeaturesService } from '../../../../../../editor/common/services/languageFeatures.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { DocumentSymbol, SymbolKind } from '../../../../../../editor/common/languages.js';
import { Position } from '../../../../../../editor/common/core/position.js';

export interface IHoverSignature {
	name: string;
	kind: string;
	signature: string;
	line: number;
}

const KIND_NAMES: Partial<Record<SymbolKind, string>> = {
	[SymbolKind.Function]: 'function',
	[SymbolKind.Method]: 'method',
	[SymbolKind.Constructor]: 'constructor',
	[SymbolKind.Variable]: 'variable',
	[SymbolKind.Constant]: 'constant',
	[SymbolKind.Property]: 'property',
	[SymbolKind.Field]: 'field',
	[SymbolKind.Class]: 'class',
	[SymbolKind.Interface]: 'interface',
};

const QUERY_KINDS = new Set([
	SymbolKind.Function, SymbolKind.Method, SymbolKind.Constructor,
	SymbolKind.Variable, SymbolKind.Constant, SymbolKind.Property,
]);

export class HoverCollector {
	constructor(private readonly languageFeaturesService: ILanguageFeaturesService) { }

	public async collect(model: ITextModel, symbols: DocumentSymbol[]): Promise<IHoverSignature[]> {
		const providers = this.languageFeaturesService.hoverProvider.ordered(model);
		if (providers.length === 0) return [];

		const provider = providers[0];
		const results: IHoverSignature[] = [];

		const flat = this._flatten(symbols);
		// Cap at 30 symbols to avoid making too many async calls
		const targets = flat.filter(s => QUERY_KINDS.has(s.kind)).slice(0, 30);

		await Promise.all(targets.map(async (sym) => {
			try {
				const pos = new Position(sym.selectionRange.startLineNumber, sym.selectionRange.startColumn);
				const hover = await provider.provideHover(model, pos, CancellationToken.None);
				if (!hover?.contents?.length) return;

				// Extract first code-block content from markdown (the type signature)
				const raw = hover.contents.map(c => typeof c === 'string' ? c : c.value).join('\n');
				// Pull out ```ts ... ``` or the first non-empty line
				const codeMatch = raw.match(/```(?:typescript|javascript|ts|js)?\n?([\s\S]*?)```/);
				const signature = codeMatch
					? codeMatch[1].trim().split('\n')[0] // first line of code block
					: raw.replace(/\*\*/g, '').split('\n').find(l => l.trim().length > 0)?.trim() ?? '';

				if (signature.length > 0 && signature.length < 300) {
					results.push({
						name: sym.name,
						kind: KIND_NAMES[sym.kind] ?? 'symbol',
						signature,
						line: sym.selectionRange.startLineNumber,
					});
				}
			} catch {
				// hover unavailable for this symbol — skip silently
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
