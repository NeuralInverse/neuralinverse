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
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';

import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { IAuxiliaryWindow, IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { EnclaveManagerPart } from './parts/enclaveManagerPart.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';


const ENCLAVE_MANAGER_STORAGE_KEY = 'neuralInverseEnclave.state';

let _enclaveWindow: IAuxiliaryWindow | undefined;

async function openEnclaveWindow(
	auxWindowService: IAuxiliaryWindowService,
	hostService: IHostService,
	storageService: IStorageService,
	instantiationService: IInstantiationService,
): Promise<void> {
	if (_enclaveWindow && !_enclaveWindow.window.closed) {
		hostService.focus(_enclaveWindow.window);
		return;
	}

	const win = await auxWindowService.open({ nativeTitlebar: false });
	_enclaveWindow = win;
	const part = instantiationService.createInstance(EnclaveManagerPart);
	part.create(win.container);

	const store = new DisposableStore();
	store.add(part);
	store.add(win.onDidLayout(d => part.layout(d.width, d.height, 0, 0)));
	store.add(win.onUnload(() => {
		_enclaveWindow = undefined;
		storageService.store(ENCLAVE_MANAGER_STORAGE_KEY, JSON.stringify({ isOpen: false }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		store.dispose();
	}));

	storageService.store(ENCLAVE_MANAGER_STORAGE_KEY, JSON.stringify({ isOpen: true }), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	win.layout();
}

export class EnclaveManagerContribution extends Disposable implements IWorkbenchContribution {

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
		const stateRaw = this.storageService.get(ENCLAVE_MANAGER_STORAGE_KEY, StorageScope.WORKSPACE);
		if (stateRaw) {
			try {
				const state = JSON.parse(stateRaw);
				if (state.isOpen) {
					openEnclaveWindow(this.auxiliaryWindowService, this.hostService, this.storageService, this.instantiationService);
				}
			} catch { /* */ }
		}
	}
}

registerAction2(class OpenEnclaveManagerAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.openEnclaveManager',
			title: localize2('neuralInverse.openEnclaveManager', 'Neural Inverse: Open Enclave Manager'),
			f1: true,
			keybinding: {
				weight: 200,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyE,
			}
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		openEnclaveWindow(
			accessor.get(IAuxiliaryWindowService),
			accessor.get(IHostService),
			accessor.get(IStorageService),
			accessor.get(IInstantiationService),
		);
	}
});

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(EnclaveManagerContribution, LifecyclePhase.Restored);

// Register Status Bar Item
import { EnclaveStatusContribution } from './statusbar/enclaveStatus.contribution.js';
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(EnclaveStatusContribution, LifecyclePhase.Restored);

// Environment service (OSS — mode persistence only)
import '../../neuralInverseEnclave/common/services/environment/enclaveEnvironmentService.js';

// Action Log — tracks every IDE action
import '../common/services/actionLog/enclaveActionLogStorageService.js';
import './services/actionLog/enclaveActionLogService.js';

