/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntryAccessor } from '../../../../services/statusbar/browser/statusbar.js';
import { IEnclaveEnvironmentService, EnclaveMode } from '../services/enclaveEnvironmentService.js';
import { ExtensionHostExtensions, IExtensionService } from '../../../../services/extensions/common/extensions.js';
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
		let text = '', tooltip = '';

		switch (mode) {
			case 'draft':
				text = '$(beaker) Draft';
				tooltip = 'Enclave Mode: Draft (No Blocking, Full AI Access)';
				break;
			case 'dev':
				text = '$(tools) Dev';
				tooltip = 'Enclave Mode: Dev (Blocks Critical Security Risks)';
				break;
			case 'prod':
				text = '$(shield) Prod';
				tooltip = 'Enclave Mode: Prod (Zero Trust, Strict Blocking)';
				break;
		}

		this._entry.value = this.statusbarService.addEntry({
			name: 'Neural Inverse Enclave Mode',
			text: text,
			ariaLabel: tooltip,
			tooltip: tooltip,
			command: 'neuralInverse.setEnclaveMode',
			kind: 'standard',
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
				label: '$(beaker) Draft Mode',
				description: 'Chaos Sandbox',
				detail: 'No blocking. AI unrestricted. For rapid prototyping.',
				id: 'draft'
			},
			{
				label: '$(tools) Dev Mode',
				description: 'Standard Workflow',
				detail: 'Blocks critical security risks. Standard tooling.',
				id: 'dev'
			},
			{
				label: '$(shield) Prod Mode',
				description: 'Zero Trust',
				detail: 'Strict blocking on all errors. AI restricted.',
				id: 'prod'
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
