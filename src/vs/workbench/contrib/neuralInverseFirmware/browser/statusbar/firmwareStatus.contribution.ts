/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * FirmwareStatusContribution
 *
 * Shows a persistent statusbar item when a firmware session is active:
 *
 *   \u26A1 STM32F4 · MISRA \u2713 · 3 datasheets
 *
 * Clickable \u2014 focuses the Firmware Environment aux window.
 * Hidden when no session is active.
 */

import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntryAccessor } from '../../../../services/statusbar/browser/statusbar.js';
import { IFirmwareSessionService, } from '../firmwareSessionService.js';
import { IFirmwareSessionData } from '../../common/firmwareTypes.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../../common/contributions.js';
import { LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';

export class FirmwareStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.firmwareStatus';

	private readonly _entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@IStatusbarService private readonly _statusbar: IStatusbarService,
		@IFirmwareSessionService sessionService: IFirmwareSessionService,
	) {
		super();

		this._render(sessionService.session);
		this._register(sessionService.onDidChangeSession(s => this._render(s)));
	}

	private _render(session: IFirmwareSessionData): void {
		if (!session.isActive || !session.mcuConfig) {
			this._entry.value = undefined;
			return;
		}

		const cfg = session.mcuConfig;
		const parts: string[] = [cfg.family];

		// Compliance badge
		if (session.complianceFrameworks.length > 0) {
			const fw = session.complianceFrameworks[0].replace('misra-c-', 'MISRA ').replace('cert-c', 'CERT-C');
			parts.push(`${fw} \u2713`);
		}

		// Datasheet count
		if (session.datasheets.length > 0) {
			parts.push(`${session.datasheets.length} datasheet${session.datasheets.length > 1 ? 's' : ''}`);
		}

		// Peripheral count
		if (session.registerMaps.length > 0) {
			parts.push(`${session.registerMaps.length} peripherals`);
		}

		const text = `$(zap) ${parts.join(' · ')}`;
		const tooltip = [
			'NeuralInverse Firmware Environment',
			`MCU: ${cfg.manufacturer} ${cfg.family} ${cfg.variant}`,
			`Core: ${cfg.core}  |  Clock: ${cfg.clockMHz} MHz`,
			`Flash: ${(cfg.flashSize / 1024).toFixed(0)} KB  |  RAM: ${(cfg.ramSize / 1024).toFixed(0)} KB`,
			session.boardName ? `Board: ${session.boardName}` : '',
			session.rtos ? `RTOS: ${session.rtos}` : '',
			`Compliance: ${session.complianceFrameworks.join(', ') || 'none'}`,
			'',
			'Click to open Firmware Environment',
		].filter(Boolean).join('\n');

		this._entry.value = this._statusbar.addEntry({
			name:      'NeuralInverse Firmware',
			text,
			ariaLabel: `Firmware session active: ${cfg.family} ${cfg.variant}`,
			tooltip,
			command:   'neuralInverse.focusFirmware',
			kind:      'prominent',
		}, 'neuralInverse.firmwareStatus', StatusbarAlignment.LEFT, 997);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(FirmwareStatusContribution, LifecyclePhase.Restored);
