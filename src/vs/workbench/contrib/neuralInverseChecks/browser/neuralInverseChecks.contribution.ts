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

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';

import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, ViewContainerLocation, IViewsRegistry } from '../../../common/views.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { ChecksViewPane } from './checksViewPane.js';
import { IAuxiliaryWindow, IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ChecksManagerPart } from './checksManagerPart.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import './context/autocomplete/policy/policyService.js';

// Infrastructure services (always available in OSS)
import './engine/services/inverseAccessService.js';
import './engine/services/externalCommandExecutor.js';
import './engine/services/externalResultCache.js';
import { IChecksSocketService } from './checksSocket/checksSocketService.js';
import { GRCDiagnosticsContribution } from './diagnostics/grcDiagnosticsContribution.js';
import { GRCAnalyzerRegistration } from './engine/analyzers/analyzerRegistration.js';


const CHECKS_MANAGER_STORAGE_KEY = 'neuralInverseChecks.state';

let _checksWindow: IAuxiliaryWindow | undefined;

async function openChecksWindow(
	auxWindowService: IAuxiliaryWindowService,
	hostService: IHostService,
	storageService: IStorageService,
	instantiationService: IInstantiationService,
): Promise<void> {
	if (_checksWindow && !_checksWindow.window.closed) {
		hostService.focus(_checksWindow.window);
		return;
	}

	const win = await auxWindowService.open({ nativeTitlebar: false });
	_checksWindow = win;
	const part = instantiationService.createInstance(ChecksManagerPart);
	part.create(win.container);

	const store = new DisposableStore();
	store.add(part);
	store.add(win.onDidLayout(d => part.layout(d.width, d.height, 0, 0)));
	store.add(win.onUnload(() => {
		_checksWindow = undefined;
		storageService.store(CHECKS_MANAGER_STORAGE_KEY, JSON.stringify({ isOpen: false }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		store.dispose();
	}));

	storageService.store(CHECKS_MANAGER_STORAGE_KEY, JSON.stringify({ isOpen: true }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	win.layout();
}

// Bootstrap ChecksSocketService — without this contribution, the singleton never gets instantiated
// because nothing injects @IChecksSocketService directly.
class ChecksSocketContribution extends Disposable implements IWorkbenchContribution {
	constructor(@IChecksSocketService _checksSocketService: IChecksSocketService) {
		super();
	}
}
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(ChecksSocketContribution, LifecyclePhase.Restored);

export class ChecksManagerContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IAuxiliaryWindowService private readonly auxiliaryWindowService: IAuxiliaryWindowService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IHostService private readonly hostService: IHostService,
	) {
		super();
		this._restoreWindow();
	}

	private _restoreWindow(): void {
		const stateRaw = this.storageService.get(CHECKS_MANAGER_STORAGE_KEY, StorageScope.WORKSPACE);
		if (stateRaw) {
			try {
				const state = JSON.parse(stateRaw);
				if (state.isOpen) {
					openChecksWindow(this.auxiliaryWindowService, this.hostService, this.storageService, this.instantiationService);
				}
			} catch { /* */ }
		}
	}
}

registerAction2(class OpenChecksManagerAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.openChecksManager',
			title: localize2('neuralInverse.openChecksManager', 'Neural Inverse: Open Checks Manager'),
			f1: true,
			keybinding: {
				weight: 200,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyC,
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		openChecksWindow(
			accessor.get(IAuxiliaryWindowService),
			accessor.get(IHostService),
			accessor.get(IStorageService),
			accessor.get(IInstantiationService),
		);
	}
});

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(ChecksManagerContribution, LifecyclePhase.Restored);

// Register Checks Panel
const VIEW_CONTAINER_ID = 'workbench.view.checks';
const VIEW_CONTAINER = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: VIEW_CONTAINER_ID,
	title: localize2('checks.panel.title', "Checks"),
	icon: Codicon.shield,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: VIEW_CONTAINER_ID,
	hideIfEmpty: false,
	order: 10,
}, ViewContainerLocation.Panel);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: ChecksViewPane.ID,
	name: localize2('checks.pane.title', "Checks"),
	ctorDescriptor: new SyncDescriptor(ChecksViewPane),
	canToggleVisibility: true,
	workspace: true,
	canMoveView: true,
	containerIcon: { id: 'codicon/shield' }
}], VIEW_CONTAINER);

// Register GRC Diagnostics (real-time editor squiggly underlines)
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(GRCDiagnosticsContribution, LifecyclePhase.Restored);

// Register Core Analyzers (AST, External)
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(GRCAnalyzerRegistration, LifecyclePhase.Restored);
