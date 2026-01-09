
import { ILanguageFeaturesService } from '../../../../../../editor/common/services/languageFeatures.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { DocumentSymbol } from '../../../../../../editor/common/languages.js';
import { CallHierarchyProviderRegistry, IncomingCall, OutgoingCall } from '../../../../callHierarchy/common/callHierarchy.js';
import { Position } from '../../../../../../editor/common/core/position.js';

export class CallHierarchyCollector {
	constructor(private readonly languageFeaturesService: ILanguageFeaturesService) { }

	public async collect(model: ITextModel): Promise<any | undefined> {
		const providers = CallHierarchyProviderRegistry.ordered(model);
		if (providers.length === 0) return undefined;

		const provider = providers[0];

		// Use document symbols to find entry points for hierarchy
		const symbolProviders = this.languageFeaturesService.documentSymbolProvider.ordered(model);
		if (symbolProviders.length === 0) return undefined;

		let symbols: DocumentSymbol[] | undefined;
		try {
			symbols = await symbolProviders[0].provideDocumentSymbols(model, CancellationToken.None) as DocumentSymbol[];
		} catch (e) { return undefined; }

		if (!symbols) return undefined;

		const hierarchyData: any = {};

		const explore = async (items: DocumentSymbol[]) => {
			for (const item of items) {
				try {
					const position = new Position(item.selectionRange.startLineNumber, item.selectionRange.startColumn);
					const session = await provider.prepareCallHierarchy(model, position, CancellationToken.None);

					if (session) {
						const root = session.roots[0];
						if (root) {
							const incoming = await provider.provideIncomingCalls(root, CancellationToken.None);
							const outgoing = await provider.provideOutgoingCalls(root, CancellationToken.None);

							hierarchyData[item.name] = {
								incoming: incoming?.map((c: IncomingCall) => ({ from: c.from.name, range: c.from.range })),
								outgoing: outgoing?.map((c: OutgoingCall) => ({ to: c.to.name, range: c.to.range }))
							};
						}
						session.dispose();
					}
				} catch (e) {
					// ignore errors for specific symbols
				}

				if (item.children) {
					await explore(item.children as DocumentSymbol[]);
				}
			}
		};

		if (symbols.length > 0) {
			// Ensure we are working with DocumentSymbol[]
			// (provideDocumentSymbols can return SymbolInformation[], but typically DocumentSymbol[] for hierarchy sources)
			// The casting in the try block handles the assumption, and we check children.
			if ((symbols[0] as any).children) {
				await explore(symbols);
			}
		}

		return Object.keys(hierarchyData).length > 0 ? hierarchyData : undefined;
	}
}
