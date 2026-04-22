/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';

import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { AgentManagerPart } from './agentManagerPart.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import './agentStoreService.js';            // Register agent store (replaces agentRegistryService)
import './workflowAgentService.js';         // Register workflow engine
import './agenticModeService.js';           // Register agentic mode (status bar + detach)
import '../../neuralInverseUserProfile/browser/neuralInverseUserProfile.contribution.js'; // Register Profile UI
import './fim/neuralInverseFIMService.js';
import './context/input/astContextService.js';
import './context/graph/dependencyGraph.js';
import '../../powerMode/browser/powerMode.contribution.js'; // Register Power Mode service



const AGENT_MANAGER_WINDOW_TYPE = 'agentManager';
const AGENT_MANAGER_STORAGE_KEY = 'neuralInverse.agentManager.state';

export class AgentManagerContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IAuxiliaryWindowService private readonly auxiliaryWindowService: IAuxiliaryWindowService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
		this.restoreWindow();
	}

	private restoreWindow(): void {
		const stateRaw = this.storageService.get(AGENT_MANAGER_STORAGE_KEY, StorageScope.WORKSPACE);
		if (stateRaw) {
			try {
				const state = JSON.parse(stateRaw);
				if (state.isOpen) {
					this.openAgentManagerWindow(state.bounds);
				}
			} catch (e) {
				console.error('Failed to restore Agent Manager window state', e);
			}
		}
	}

	async openAgentManagerWindow(bounds?: any): Promise<void> {
		let window = this.auxiliaryWindowService.getWindowByType(AGENT_MANAGER_WINDOW_TYPE);

		if (window) {
			window.window.focus();
			return;
		}

		window = await this.auxiliaryWindowService.open({
			type: AGENT_MANAGER_WINDOW_TYPE,
			bounds: bounds,
			mode: undefined, // Normal
			nativeTitlebar: false,
			disableFullscreen: false,
		});

		const part = this.instantiationService.createInstance(AgentManagerPart);
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

registerAction2(class OpenAgentManagerAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.openAgentManager',
			title: localize2('neuralInverse.openAgentManager', 'Neural Inverse: Open Agent Manager'),
			f1: true,
			keybinding: {
				weight: 200, // KeybindingWeight.WorkbenchContrib
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyA,
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const instantiationService = accessor.get(IInstantiationService);
		// We can access the contribution if it's registered, but simpler to just use the logic in the contribution
		// OR, better yet, just execute logic here, but we want to share the logic with restore.
		// Let's instantiate a helper or just move logic to a service?
		// For now, let's just duplicate or use a static helper?
		// Actually, since the Contribution is a singleton (effectively), we can't easily access it.
		// BUT, we can just resolve the services and run the logic.
		const auxWindowService = accessor.get(IAuxiliaryWindowService);
		const hostService = accessor.get(IHostService);

		let window = auxWindowService.getWindowByType(AGENT_MANAGER_WINDOW_TYPE);
		if (window && !window.window.closed) {
			hostService.focus(window.window, { force: true });
			return;
		}

		// Use the same logic as restore, but valid bounds might be missing, so undefined is fine
		// To avoid code duplication, we could put this in a service, but for now let's keep it inline.
		// Copy-paste logic from restoreWindow for now.

		const win = await auxWindowService.open({
			type: AGENT_MANAGER_WINDOW_TYPE,
			// bounds: undefined, // let it center
			nativeTitlebar: false,
		});

		const part = instantiationService.createInstance(AgentManagerPart);
		part.create(win.container);
		const dimension = win.window.document.body.getBoundingClientRect();
		part.layout(dimension.width, dimension.height, 0, 0);

		const store = new DisposableStore();
		store.add(part);
		store.add(win.onDidLayout(d => part.layout(d.width, d.height, 0, 0)));
		store.add(win.onUnload(() => store.dispose()));
	}
});

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(AgentManagerContribution, LifecyclePhase.Restored);
