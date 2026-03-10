/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import * as nls from '../../../../nls.js';
import { EditorExtensions, DEFAULT_EDITOR_ASSOCIATION } from '../../../common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { URI } from '../../../../base/common/uri.js';

import { mountNeuralInverseArtifact } from './react/out/neural-inverse-artifact-tsx/index.js'
import { Codicon } from '../../../../base/common/codicons.js';

import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';

export class NeuralInverseArtifactInput extends EditorInput {

	static readonly ID: string = 'workbench.input.neuralinverse.artifact';

	constructor(public readonly resource: URI) {
		super();
	}

	override get typeId(): string {
		return NeuralInverseArtifactInput.ID;
	}

	override getName(): string {
		return nls.localize('neuralInverseArtifactInputsName', "Artifact: {0}", this.resource.path.split('/').pop());
	}

	override getIcon() {
		return Codicon.fileCode;
	}
}

export class NeuralInverseArtifactPane extends EditorPane {
	static readonly ID = 'workbench.editor.neuralinverse.artifactPane';

	private artifactContainer: HTMLElement | undefined;
	private reactDisposeFn: (() => void) | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super(NeuralInverseArtifactPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		parent.style.height = '100%';
		parent.style.width = '100%';

		this.artifactContainer = document.createElement('div');
		this.artifactContainer.style.height = '100%';
		this.artifactContainer.style.width = '100%';

		parent.appendChild(this.artifactContainer);
	}

	override async setInput(input: NeuralInverseArtifactInput, options: import('../../../../platform/editor/common/editor.js').IEditorOptions | undefined, context: import('../../../common/editor.js').IEditorOpenContext, token: import('../../../../base/common/cancellation.js').CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		// Clean up existing mount if it exists
		if (this.reactDisposeFn) {
			this.reactDisposeFn();
			this.reactDisposeFn = undefined;
		}

		if (this.artifactContainer) {
			// Mount React into the content using the newly assigned input
			this.instantiationService.invokeFunction(accessor => {
				const uri = input.resource;
				console.log("[NeuralInverse] setInput received URI:", uri?.toString(), "Full Input:", input);
				this.reactDisposeFn = mountNeuralInverseArtifact(this.artifactContainer!, accessor, { uri })?.dispose;
			});
		}
	}

	override clearInput(): void {
		super.clearInput();

		if (this.reactDisposeFn) {
			this.reactDisposeFn();
			this.reactDisposeFn = undefined;
		}
	}

	layout(dimension: Dimension): void {
		// No specific layout handling needed for React wrapper
	}

	override get minimumWidth() { return 400 }
}

// Register Artifact pane
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(NeuralInverseArtifactPane, NeuralInverseArtifactPane.ID, nls.localize('NeuralInverseArtifactPane', "NeuralInverse Artifact Pane")),
	[new SyncDescriptor(NeuralInverseArtifactInput)]
);

class NeuralInverseArtifactEditorContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.neuralinverse.artifact.editor';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		editorResolverService.registerEditor(
			'**/.neural-inverse*/artifacts/**/*.md',
			{
				id: NeuralInverseArtifactInput.ID,
				label: nls.localize('neuralInverseArtifact.displayName', "NeuralInverse Artifact Viewer"),
				detail: DEFAULT_EDITOR_ASSOCIATION.providerDisplayName,
				priority: RegisteredEditorPriority.exclusive,
			},
			{
				singlePerResource: true,
				canSupportResource: resource => resource.path.match(/\.neural-inverse(?:-dev)?\/artifacts\/.*\.md$/) !== null
			},
			{
				createEditorInput: ({ resource }) => {
					return { editor: instantiationService.createInstance(NeuralInverseArtifactInput, resource) };
				}
			}
		);
	}
}

registerWorkbenchContribution2(NeuralInverseArtifactEditorContribution.ID, NeuralInverseArtifactEditorContribution, WorkbenchPhase.BlockStartup);

