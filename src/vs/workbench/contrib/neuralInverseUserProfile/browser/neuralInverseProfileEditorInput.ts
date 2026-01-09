/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

export class NeuralInverseProfileEditorInput extends EditorInput {
	static readonly ID: string = 'workbench.input.neuralInverseProfile';

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override get typeId(): string {
		return NeuralInverseProfileEditorInput.ID;
	}

	readonly resource: URI = URI.from({
		scheme: 'neural-inverse',
		path: 'profile'
	});

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof NeuralInverseProfileEditorInput;
	}

	override getName(): string {
		return localize('neuralInverseProfileEditorInputName', "Neural Inverse Profile");
	}

	override getIcon(): ThemeIcon {
		return Codicon.account;
	}
}
