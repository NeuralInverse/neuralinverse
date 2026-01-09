
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
