/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntryAccessor } from '../../../../services/statusbar/browser/statusbar.js';
import { IEnclaveEnvironmentService, EnclaveMode } from '../../common/services/environment/enclaveEnvironmentService.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';

export class EnclaveStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.enclaveStatus';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IEnclaveEnvironmentService private readonly enclaveEnv: IEnclaveEnvironmentService,
	) {
		super();
		this._updateStatus(this.enclaveEnv.mode);
		this._register(this.enclaveEnv.onDidChangeMode(mode => this._updateStatus(mode)));
	}

	private _updateStatus(mode: EnclaveMode): void {
		let text = '', tooltip = '', kind: any = 'standard';

		switch (mode) {
			case 'open':
				text = '$(unlock) Open';
				tooltip = 'Enclave Mode: Open (No Blocking, Full AI Access)';
				break;
			case 'standard':
				text = '$(shield) Standard Security';
				tooltip = 'Enclave Mode: Standard Security (Blocks Critical Security Risks)';
				break;
			case 'locked_down':
				text = '$(lock) Locked Down';
				tooltip = 'Enclave Mode: Locked Down (Zero Trust, Strict Blocking)';
				kind = 'prominent';
				break;
		}

		this._entry.value = this.statusbarService.addEntry({
			name: 'Neural Inverse Enclave Mode',
			text: text,
			ariaLabel: tooltip,
			tooltip: tooltip,
			command: 'neuralInverse.setEnclaveMode',
			kind: kind,
		}, 'neuralInverse.enclaveStatus', StatusbarAlignment.RIGHT, 100);
	}
}

// Register Action to Change Mode
registerAction2(class SetEnclaveModeAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.setEnclaveMode',
			title: localize2('neuralInverse.setEnclaveMode', 'Neural Inverse: Set Enclave Mode'),
			f1: true
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const enclaveEnv = accessor.get(IEnclaveEnvironmentService);

		const items: IQuickPickItem[] = [
			{
				label: '$(unlock) Open',
				description: 'Unrestricted Access',
				detail: 'No blocking. AI unrestricted. For rapid prototyping.',
				id: 'open'
			},
			{
				label: '$(shield) Standard Security',
				description: 'Guided Workflow',
				detail: 'Blocks critical security risks. Standard tooling.',
				id: 'standard'
			},
			{
				label: '$(lock) Locked Down',
				description: 'Strict Compliance',
				detail: 'Strict blocking on all errors. AI restricted.',
				id: 'locked_down'
			}
		];

		const activeMode = enclaveEnv.mode;
		const activeItem = items.find(i => i.id === activeMode);

		const picked = await quickInputService.pick(items, {
			placeHolder: 'Select Neural Inverse Enclave Mode',
			activeItem: activeItem
		});

		if (picked && picked.id) {
			enclaveEnv.setMode(picked.id as EnclaveMode);
		}
	}
});
