/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # Inlay Hint Collector
 *
 * Collects VS Code's inlay hints for a file — the inline type annotations the
 * editor renders (e.g. `: string`, `param:`, `\u2192 Promise<void>`).
 *
 * These are the TypeScript language server's inferred types for:
 * - Variable declarations without explicit type annotations
 * - Function return types
 * - Parameter types at call sites
 *
 * For GRC purposes this reveals IMPLICIT `any` types and missing annotations
 * that frameworks like MISRA-TS or "no-implicit-any" enforce.
 *
 * Used by Layer 1 (new `hasInlayTypeHint` constraint) and Layer 2 (injected
 * into AI prompt as concrete type evidence).
 */

import { ILanguageFeaturesService } from '../../../../../../editor/common/services/languageFeatures.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Range } from '../../../../../../editor/common/core/range.js';

export interface IInlayHintEntry {
	line: number;
	column: number;
	label: string;
	kind: 'type' | 'parameter' | 'other';
}

export class InlayHintCollector {
	constructor(private readonly languageFeaturesService: ILanguageFeaturesService) { }

	public async collect(model: ITextModel): Promise<IInlayHintEntry[]> {
		const providers = this.languageFeaturesService.inlayHintsProvider.ordered(model);
		if (providers.length === 0) return [];

		const provider = providers[0];

		try {
			const lineCount = model.getLineCount();
			// Scan the whole file but cap at 500 lines to avoid expensive calls on giant files
			const endLine = Math.min(lineCount, 500);
			const range = new Range(1, 1, endLine, model.getLineMaxColumn(endLine));

			const hintList = await provider.provideInlayHints(model, range, CancellationToken.None);
			if (!hintList?.hints?.length) {
				hintList?.dispose();
				return [];
			}

			const mapped = hintList.hints
				.slice(0, 100)
				.map(h => {
					const label = Array.isArray(h.label)
						? h.label.map(p => p.label).join('')
						: h.label;
					// InlayHintKind: Type=1, Parameter=2
					const kind = h.kind === 1 ? 'type' : h.kind === 2 ? 'parameter' : 'other';
					return { line: h.position.lineNumber, column: h.position.column, label, kind } as IInlayHintEntry;
				})
				.filter(h => h.label.trim().length > 0 && h.label.length < 80);

			hintList.dispose();
			return mapped;
		} catch {
			return [];
		}
	}
}
