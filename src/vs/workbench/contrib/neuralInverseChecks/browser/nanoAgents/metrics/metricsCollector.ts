
import { ITextModel } from '../../../../../../editor/common/model.js';
import { DocumentSymbol } from '../../../../../../editor/common/languages.js';

export class MetricsCollector {
	public async collect(model: ITextModel, symbols?: DocumentSymbol[]): Promise<any> {
		const lineCount = model.getLineCount();
		const textSize = model.getValueLength();

		let symbolCount = 0;
		if (symbols) {
			const countSymbols = (items: DocumentSymbol[]) => {
				for (const item of items) {
					symbolCount++;
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
			languageId: model.getLanguageId()
		};
	}
}
