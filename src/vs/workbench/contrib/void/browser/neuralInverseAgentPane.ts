/*--------------------------------------------------------------------------------------
 *  Copyright (c) NeuralInverse. All rights reserved.
 *  Agent Pane \u2014 Bottom panel for the NI Agent execution dashboard.
 *--------------------------------------------------------------------------------------*/

import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	Extensions as ViewContainerExtensions, IViewContainersRegistry,
	ViewContainerLocation, IViewsRegistry, Extensions as ViewExtensions,
	IViewDescriptorService,
} from '../../../common/views.js';

import * as nls from '../../../../nls.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';

import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { Orientation } from '../../../../base/browser/ui/sash/sash.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';

import { mountAgentManager } from './react/out/agent-manager-tsx/index.js';
import { INeuralInverseAgentService } from './neuralInverseAgentService.js';


// ======================== ViewPane ========================

class NeuralInverseAgentViewPane extends ViewPane {

	constructor(
		options: IViewPaneOptions,
		@IInstantiationService instantiationService: IInstantiationService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IThemeService themeService: IThemeService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IOpenerService openerService: IOpenerService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
		@INeuralInverseAgentService private readonly _agentService: INeuralInverseAgentService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService)

		this._register(this._agentService.onDidChangeAgentState(() => this._updateTitle()))
		this._updateTitle()
	}

	private _updateTitle() {
		const task = this._agentService.activeTask
		if (task) {
			const status = task.status.charAt(0).toUpperCase() + task.status.slice(1).replace('_', ' ')
			this.updateTitle(`NI Agent \u2014 ${status}`)
		} else {
			this.updateTitle('NI Agent')
		}
	}

	protected override renderBody(parent: HTMLElement): void {
		super.renderBody(parent)
		parent.style.userSelect = 'text'

		this.instantiationService.invokeFunction(accessor => {
			const disposeFn: (() => void) | undefined = mountAgentManager(parent, accessor)?.dispose
			this._register(toDisposable(() => disposeFn?.()))
		})
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width)
		this.element.style.height = `${height}px`
		this.element.style.width = `${width}px`
	}
}


// ======================== Registration ========================

export const NI_AGENT_VIEW_CONTAINER_ID = 'workbench.view.niAgent'
export const NI_AGENT_VIEW_ID = NI_AGENT_VIEW_CONTAINER_ID

// Register view container in the bottom Panel area
const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewContainerExtensions.ViewContainersRegistry)
const container = viewContainerRegistry.registerViewContainer({
	id: NI_AGENT_VIEW_CONTAINER_ID,
	title: nls.localize2('niAgentContainer', 'NI Agent'),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [NI_AGENT_VIEW_CONTAINER_ID, {
		mergeViewWithContainerWhenSingleView: true,
		orientation: Orientation.HORIZONTAL,
	}]),
	hideIfEmpty: false,
	order: 10,
	rejectAddedViews: true,
}, ViewContainerLocation.Panel, { doNotRegisterOpenCommand: false, isDefault: false })

// Register the view inside the container
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry)
viewsRegistry.registerViews([{
	id: NI_AGENT_VIEW_ID,
	hideByDefault: false,
	name: nls.localize2('niAgentView', 'NI Agent'),
	ctorDescriptor: new SyncDescriptor(NeuralInverseAgentViewPane),
	canToggleVisibility: true,
	canMoveView: true,
	weight: 40,
	order: 1,
}], container)
