/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0.
 *--------------------------------------------------------------------------------------------*/

/**
 * PowerModePart — dedicated auxiliary window for Power Mode.
 *
 * Hosts the PowerModeTerminalHost (xterm.js ANSI terminal UI).
 */

import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { Part } from '../../../browser/part.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IPowerModeService } from './powerModeService.js';
import { PowerModeTerminalHost } from './powerModeTerminalHost.js';

export class PowerModePart extends Part {

	static readonly ID = 'workbench.parts.powerMode';

	minimumWidth: number = 400;
	maximumWidth: number = Infinity;
	minimumHeight: number = 300;
	maximumHeight: number = Infinity;

	private _terminalHost: PowerModeTerminalHost | undefined;
	private readonly _disposables = new DisposableStore();

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IPowerModeService private readonly powerModeService: IPowerModeService,
	) {
		super(PowerModePart.ID, { hasTitle: false }, themeService, storageService, layoutService);
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		const terminalContainer = document.createElement('div');
		terminalContainer.style.cssText = 'width:100%;height:100%;overflow:hidden;position:relative;background:#0d1117;';
		parent.appendChild(terminalContainer);

		this._terminalHost = this._disposables.add(
			new PowerModeTerminalHost(this.powerModeService)
		);
		this._terminalHost.createTerminal(terminalContainer);

		return parent;
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);
		this._terminalHost?.layout(width, height);
	}

	override toJSON(): object {
		return { id: PowerModePart.ID };
	}

	override dispose(): void {
		this._disposables.dispose();
		super.dispose();
	}
}
