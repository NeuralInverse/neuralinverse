/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ModernisationWorkflowViewPane \u2014 ORPHANED
 *
 * This sidebar ViewPane has been superseded by ModernisationPart (aux window).
 * Kept as a stub to satisfy TypeScript compilation.
 * NOT registered in any contribution or view container.
 */

import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ViewPane, IViewPaneOptions } from '../../../../browser/parts/views/viewPane.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IViewDescriptorService } from '../../../../common/views.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IModernisationSessionService } from '../modernisationSessionService.js';

export class ModernisationWorkflowViewPane extends ViewPane {

	static readonly ID = 'workbench.view.modernisation.workflow';

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IModernisationSessionService private readonly _sessionService: IModernisationSessionService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this._sessionService.onDidChangeSession(() => this._refresh()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._refresh();
	}

	private _refresh(): void {
		// Orphaned \u2014 no-op. Use ModernisationPart (Cmd+Alt+M) instead.
	}

	override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}
}
