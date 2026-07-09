/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Inc. All rights reserved.
 *
 *  Licensed under the Business Source License 1.1 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at https://mariadb.com/bsl11
 *
 *  Change Date: 2029-07-14
 *  Change License: GNU Affero General Public License v3.0
 *
 *  Use of this software in production requires a commercial license from Neural Inverse Inc.
 *  Contact (code): github@neuralinverse.com | Contact (sales): sales@neuralinverse.com
 *--------------------------------------------------------------------------------------------*/


import { ITextModel } from '../../../../../../editor/common/model.js';
import { DocumentSymbol, SymbolKind } from '../../../../../../editor/common/languages.js';

export class MetricsCollector {
	public async collect(model: ITextModel, symbols?: DocumentSymbol[]): Promise<any> {
		const lineCount = model.getLineCount();
		const textSize = model.getValueLength();

		let symbolCount = 0;
		let classes = 0;
		let functions = 0;

		// Calculate Nesting Depth
		let maxDepth = 0;
		for (let i = 1; i <= lineCount; i++) {
			const line = model.getLineContent(i);
			if (line.trim().length === 0) continue;
			const indentation = line.match(/^\s*/)?.[0].length || 0;
			// Assume 4 spaces or 1 tab = 1 depth level
			const depth = Math.ceil(indentation / 2); // lenient check
			if (depth > maxDepth) maxDepth = depth;
		}

		// Calculate Parameters (Heuristic: count commas in function signature)
		let totalParams = 0;
		let functionCountForParams = 0;

		if (symbols) {
			const countSymbols = (items: DocumentSymbol[]) => {
				for (const item of items) {
					symbolCount++;
					if (item.kind === SymbolKind.Class) classes++;
					if (item.kind === SymbolKind.Function || item.kind === SymbolKind.Method) {
						functions++;

						// Parameter Heuristic
						try {
							const range = item.range; // or selectionRange
							const startLine = range.startLineNumber;
							const lineContent = model.getLineContent(startLine);
							// Extract (...) content
							const match = lineContent.match(/\(([^)]*)\)/);
							if (match) {
								const params = match[1].split(',').filter(p => p.trim().length > 0);
								totalParams += params.length;
								functionCountForParams++;
							}
						} catch (e) { /* ignore */ }
					}

					if (item.children) {
						countSymbols(item.children as DocumentSymbol[]);
					}
				}
			};
			countSymbols(symbols);
		}

		return {
			lineCount,
			textSize,
			symbolCount,
			classes,
			functions,
			maxDepth,
			avgParams: functionCountForParams > 0 ? (totalParams / functionCountForParams).toFixed(1) : 0,
			languageId: model.getLanguageId()
		};
	}
}
