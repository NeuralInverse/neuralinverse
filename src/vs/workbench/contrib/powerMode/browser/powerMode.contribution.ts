/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

/**
 * Power Mode contribution — registers the Power Mode service and dedicated window.
 *
 * Registers:
 * - PowerModeService / PowerBusService as DI singletons
 * - PowerModeContribution (restores window across reloads)
 * - "Open Power Mode" command  Ctrl+Alt+P
 */

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { PowerModePart } from './powerModePart.js';
import { IEnterprisePolicyService } from '../../void/common/enterprisePolicyService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IAccessibilitySignalService, AccessibilitySignal } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';

// Side-effect imports: register DI singletons
import './powerBusService.js';
import './powerModeService.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const POWER_MODE_WINDOW_TYPE = 'powerMode';
const POWER_MODE_STORAGE_KEY = 'neuralInverse.powerMode.state';

// ─── Contribution (restore window on reload) ─────────────────────────────────

export class PowerModeContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IAuxiliaryWindowService private readonly auxiliaryWindowService: IAuxiliaryWindowService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEnterprisePolicyService private readonly enterprisePolicyService: IEnterprisePolicyService,
	) {
		super();
		this._restoreWindow();

		// React to live policy changes — close the window immediately if admin disables Power Mode
		this._register(this.enterprisePolicyService.onDidChangePolicy(() => {
			if (this._isPolicyBlocked()) {
				const existing = this.auxiliaryWindowService.getWindowByType(POWER_MODE_WINDOW_TYPE);
				if (existing && !existing.window.closed) {
					existing.window.close();
				}
				// Clear persisted open state so it doesn't reopen on next reload
				this.storageService.store(
					POWER_MODE_STORAGE_KEY,
					JSON.stringify({ isOpen: false }),
					StorageScope.WORKSPACE,
					1,
				);
			}
		}));
	}

	private _isPolicyBlocked(): boolean {
		return this.enterprisePolicyService.policy?.powerModePolicy?.enabled === false;
	}

	private _restoreWindow(): void {
		if (this._isPolicyBlocked()) return;

		const raw = this.storageService.get(POWER_MODE_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) return;
		try {
			const state = JSON.parse(raw);
			if (state.isOpen) {
				this.openWindow(state.bounds);
			}
		} catch {
			// stale storage — ignore
		}
	}

	async openWindow(bounds?: any): Promise<void> {
		if (this._isPolicyBlocked()) return;

		const existing = this.auxiliaryWindowService.getWindowByType(POWER_MODE_WINDOW_TYPE);
		if (existing) {
			existing.window.focus();
			return;
		}

		const win = await this.auxiliaryWindowService.open({
			type: POWER_MODE_WINDOW_TYPE,
			bounds,
			nativeTitlebar: false,
			disableFullscreen: false,
		});

		const part = this.instantiationService.createInstance(PowerModePart);
		part.create(win.container);

		const dim = win.window.document.body.getBoundingClientRect();
		part.layout(dim.width, dim.height, 0, 0);

		const store = new DisposableStore();
		store.add(part);
		store.add(win.onDidLayout(d => part.layout(d.width, d.height, 0, 0)));
		store.add(win.onUnload(() => {
			this.storageService.store(
				POWER_MODE_STORAGE_KEY,
				JSON.stringify({ isOpen: false }),
				StorageScope.WORKSPACE,
				1, // StorageTarget.MACHINE
			);
			store.dispose();
		}));

		this.storageService.store(
			POWER_MODE_STORAGE_KEY,
			JSON.stringify({ isOpen: true, bounds }),
			StorageScope.WORKSPACE,
			1,
		);
	}
}

// ─── Command ─────────────────────────────────────────────────────────────────

registerAction2(class OpenPowerModeAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.openPowerMode',
			title: localize2('neuralInverse.openPowerMode', 'Neural Inverse: Open Power Mode'),
			f1: true,
			keybinding: {
				weight: 200,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyP,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const policyService = accessor.get(IEnterprisePolicyService);
		if (policyService.policy?.powerModePolicy?.enabled === false) {
			const notificationService = accessor.get(INotificationService);
			const signalService = accessor.get(IAccessibilitySignalService);
			signalService.playSignal(AccessibilitySignal.neuralInversePolicyBlocked, { userGesture: true });
			notificationService.notify({
				severity: Severity.Warning,
				message: 'Power Mode is disabled by your organization\'s policy.',
			});
			return;
		}

		const auxWindowService = accessor.get(IAuxiliaryWindowService);
		const hostService = accessor.get(IHostService);
		const instantiationService = accessor.get(IInstantiationService);

		const existing = auxWindowService.getWindowByType(POWER_MODE_WINDOW_TYPE);
		if (existing && !existing.window.closed) {
			hostService.focus(existing.window, { force: true });
			return;
		}

		const win = await auxWindowService.open({
			type: POWER_MODE_WINDOW_TYPE,
			nativeTitlebar: false,
		});

		const part = instantiationService.createInstance(PowerModePart);
		part.create(win.container);
		const dim = win.window.document.body.getBoundingClientRect();
		part.layout(dim.width, dim.height, 0, 0);

		const store = new DisposableStore();
		store.add(part);
		store.add(win.onDidLayout(d => part.layout(d.width, d.height, 0, 0)));
		store.add(win.onUnload(() => store.dispose()));
	}
});

// ─── Register contribution ────────────────────────────────────────────────────

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(PowerModeContribution, LifecyclePhase.Restored);
