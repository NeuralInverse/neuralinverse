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

import { ILanguageFeaturesService } from '../../../../../../editor/common/services/languageFeatures.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { DocumentSymbol } from '../../../../../../editor/common/languages.js';

export class ASTCollector {
	constructor(private readonly languageFeaturesService: ILanguageFeaturesService) { }

	public async collect(model: ITextModel): Promise<DocumentSymbol[] | undefined> {
		// Currently approximates AST using DocumentSymbols.
		// Future expansion: Implement TreeSitter or true AST parsing here.
		const providers = this.languageFeaturesService.documentSymbolProvider.ordered(model);
		if (providers.length === 0) return undefined;

		try {
			return (await providers[0].provideDocumentSymbols(model, CancellationToken.None)) ?? undefined;
		} catch (e) {
			return undefined;
		}
	}
}
