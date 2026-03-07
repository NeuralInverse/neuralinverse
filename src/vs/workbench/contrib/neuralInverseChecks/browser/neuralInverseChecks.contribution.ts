/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';

import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, ViewContainerLocation, IViewsRegistry } from '../../../common/views.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { ChecksViewPane } from './checksViewPane.js';
import { IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ChecksManagerPart } from './checksManagerPart.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import './context/autocomplete/policy/policyService.js';

// GRC Engine Services (side-effect imports to register singletons)
// inverseAccessService MUST be first — it registers the terminal-based chmod executor
// used by every other service that writes to the write-locked .inverse directory.
import './engine/services/inverseAccessService.js';
import './engine/framework/frameworkRegistry.js'; // Must load before grcEngineService
import './nanoAgents/projectAnalyzerService.js'; // Must load before grcEngineService
import './engine/services/grcEngineService.js';
import './engine/services/auditTrailService.js';
import './engine/services/contractReasonService.js'; // Register Contract Reason Service
import './engine/services/complianceReportService.js'; // Register Compliance Report Service
import './engine/services/externalCommandExecutor.js'; // External tool command execution (terminal redirect)
import './engine/services/externalResultCache.js';     // Content-hash cache for external tool results
import './engine/services/externalToolService.js';     // External tool orchestration (CodeQL, Semgrep, Polyspace, ...)
import { GRCDiagnosticsContribution } from './diagnostics/grcDiagnosticsContribution.js';
import { GRCAnalyzerRegistration } from './engine/analyzers/analyzerRegistration.js';
import { BreakingChangeDetector } from './engine/services/breakingChangeDetector.js';


const CHECKS_MANAGER_WINDOW_TYPE = 'checksManager';
const CHECKS_MANAGER_STORAGE_KEY = 'neuralInverseChecks.state';

// Register Breaking Change Detector BEFORE GRCGatekeeper so its save participant
// runs first and violations are visible to the gatekeeper's blocking logic.
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(BreakingChangeDetector, LifecyclePhase.Restored);

// register GRC Gatekeeper
import { GRCGatekeeper } from './gatekeeper/grcGatekeeper.js';
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(GRCGatekeeper, LifecyclePhase.Restored);

export class ChecksManagerContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IAuxiliaryWindowService private readonly auxiliaryWindowService: IAuxiliaryWindowService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
		this.restoreWindow();
	}

	private restoreWindow(): void {
		const stateRaw = this.storageService.get(CHECKS_MANAGER_STORAGE_KEY, StorageScope.WORKSPACE);
		if (stateRaw) {
			try {
				const state = JSON.parse(stateRaw);
				if (state.isOpen) {
					this.openChecksManagerWindow(state.bounds);
				}
			} catch (e) {
				console.error('Failed to restore Checks Manager window state', e);
			}
		}
	}

	async openChecksManagerWindow(bounds?: any): Promise<void> {
		let window = this.auxiliaryWindowService.getWindowByType(CHECKS_MANAGER_WINDOW_TYPE);

		if (window) {
			window.window.focus();
			return;
		}

		window = await this.auxiliaryWindowService.open({
			type: CHECKS_MANAGER_WINDOW_TYPE,
			bounds: bounds,
			mode: undefined, // Normal
			nativeTitlebar: false,
			disableFullscreen: false,
		});

		const part = this.instantiationService.createInstance(ChecksManagerPart);
		part.create(window.container);

		// Initial layout
		const dimension = window.window.document.body.getBoundingClientRect();
		part.layout(dimension.width, dimension.height, 0, 0);

		const disposables = new DisposableStore();
		disposables.add(part);

		disposables.add(window.onDidLayout(dimension => {
			part.layout(dimension.width, dimension.height, 0, 0);
		}));

		disposables.add(window.onUnload(() => {
			disposables.dispose();
		}));
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
		const instantiationService = accessor.get(IInstantiationService);
		const auxWindowService = accessor.get(IAuxiliaryWindowService);
		const hostService = accessor.get(IHostService);

		let window = auxWindowService.getWindowByType(CHECKS_MANAGER_WINDOW_TYPE);
		if (window && !window.window.closed) {
			hostService.focus(window.window, { force: true });
			return;
		}

		const win = await auxWindowService.open({
			type: CHECKS_MANAGER_WINDOW_TYPE,
			nativeTitlebar: false,
		});

		const part = instantiationService.createInstance(ChecksManagerPart);
		part.create(win.container);
		const dimension = win.window.document.body.getBoundingClientRect();
		part.layout(dimension.width, dimension.height, 0, 0);

		const store = new DisposableStore();
		store.add(part);
		store.add(win.onDidLayout(d => part.layout(d.width, d.height, 0, 0)));
		store.add(win.onUnload(() => store.dispose()));
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
