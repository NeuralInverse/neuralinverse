/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HoverProvider, Hover } from '../../../../../../editor/common/languages.js';
import { ITextModel } from '../../../../../../editor/common/model.js';
import { Position } from '../../../../../../editor/common/core/position.js';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { IMarkdownString } from '../../../../../../base/common/htmlContent.js';
import { IFirmwareLSPBridge } from './firmwareLSPBridge.js';
import { IWorkbenchContribution } from '../../../../../common/contributions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { ILanguageFeaturesService } from '../../../../../../editor/common/services/languageFeatures.js';

/**
 * # Firmware SVD Hover Provider
 *
 * Plugs into Monaco's Hover capability. When a user hovers over a word (e.g., `ADC1`, `CR1`),
 * this checks with our FirmwareLSPBridge (which holds SVD session data).
 * 
 * If the word maps to a hardware register or peripheral, it returns an immersive
 * markdown tooltip containing the SVD specification for that register natively.
 */
export class FirmwareHoverContribution extends Disposable implements IWorkbenchContribution {
	constructor(
		@ILanguageFeaturesService languageFeaturesService: ILanguageFeaturesService,
		@IFirmwareLSPBridge firmwareLSPBridge: IFirmwareLSPBridge
	) {
		super();
		this._register(languageFeaturesService.hoverProvider.register(['c', 'cpp'], new FirmwareHoverProvider(firmwareLSPBridge)));
	}
}

class FirmwareHoverProvider implements HoverProvider {
	constructor(private readonly _firmwareLSPBridge: IFirmwareLSPBridge) { }

	public provideHover(model: ITextModel, position: Position, token: CancellationToken): Promise<Hover | null> {
		const wordInfo = model.getWordAtPosition(position);
		if (!wordInfo) {
			return Promise.resolve(null);
		}

		// Use the LSP Bridge to look up the word in the active SVD session
		const hoverInfo = this._firmwareLSPBridge.getRegisterHoverInfo(wordInfo.word);
		if (!hoverInfo) {
			return Promise.resolve(null);
		}

		const range = {
			startLineNumber: position.lineNumber,
			startColumn: wordInfo.startColumn,
			endLineNumber: position.lineNumber,
			endColumn: wordInfo.endColumn
		};

		const contents: IMarkdownString[] = [{
			value: hoverInfo.markdown,
			isTrusted: true, // Allow theme icons and Markdown rendering
			supportThemeIcons: true
		}];

		return Promise.resolve({ contents, range });
	}
}
