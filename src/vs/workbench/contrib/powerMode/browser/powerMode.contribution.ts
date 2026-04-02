/*---------------------------------------------------------------------------------------------
 *  Original: MIT License - Copyright (c) SST (opencode)
 *  Modified: Neural Inverse Corporation
 *--------------------------------------------------------------------------------------------*/

/**
 * Power Mode contribution — registers the Power Mode service and commands.
 *
 * Three opening modes (all Cmd+Alt+P cycles, or via Command Palette):
 *   - "Neural Inverse: Open Power Mode"           Cmd+Alt+P  → floating window (no tab bar)
 *   - "Neural Inverse: Open Power Mode in Tab"               → editor tab in active window
 */

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IEnterprisePolicyService } from '../../void/common/enterprisePolicyService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IAccessibilitySignalService, AccessibilitySignal } from '../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import { IPowerModeService } from './powerModeService.js';
import { PowerModeTerminalHost } from './powerModeTerminalHost.js';
import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { IWebviewService } from '../../webview/browser/webview.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { openPowerModeFloating, openPowerModeInTab } from './powerModeWebviewTerminal.js';

// Side-effect imports: register DI singletons
import './powerBusService.js';
import './powerModeService.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const POWER_MODE_STORAGE_KEY = 'neuralInverse.powerMode.v3.state';

// ─── Policy guard helper ──────────────────────────────────────────────────────

function _isPolicyBlocked(policyService: IEnterprisePolicyService): boolean {
	return policyService.policy?.powerModePolicy?.enabled === false;
}

function _notifyBlocked(accessor: ServicesAccessor): void {
	accessor.get(INotificationService).notify({
		severity: Severity.Warning,
		message: 'Power Mode is disabled by your organization\'s policy.',
	});
	accessor.get(IAccessibilitySignalService).playSignal(AccessibilitySignal.neuralInversePolicyBlocked, { userGesture: true });
}

// ─── Contribution (restore on reload) ────────────────────────────────────────

export class PowerModeContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IPowerModeService private readonly powerModeService: IPowerModeService,
		@IEnterprisePolicyService private readonly enterprisePolicyService: IEnterprisePolicyService,
		@IAuxiliaryWindowService private readonly auxiliaryWindowService: IAuxiliaryWindowService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@IWebviewWorkbenchService private readonly webviewWorkbenchService: IWebviewWorkbenchService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super();
		this._restoreOnReload();

		this._register(this.enterprisePolicyService.onDidChangePolicy(() => {
			if (_isPolicyBlocked(this.enterprisePolicyService)) {
				this.storageService.store(POWER_MODE_STORAGE_KEY, JSON.stringify({ isOpen: false }), StorageScope.WORKSPACE, 1);
			}
		}));
	}

	private _restoreOnReload(): void {
		if (_isPolicyBlocked(this.enterprisePolicyService)) { return; }
		const raw = this.storageService.get(POWER_MODE_STORAGE_KEY, StorageScope.WORKSPACE);
		if (!raw) { return; }
		try {
			const state = JSON.parse(raw);
			if (state.isOpen) {
				// Restore in the same mode it was last opened in
				if (state.mode === 'tab') {
					this._openInTab(false);
				} else {
					this._openFloating();
				}
			}
		} catch { /* stale */ }
	}

	async _openFloating(): Promise<void> {
		const result = await openPowerModeFloating(this.auxiliaryWindowService, this.webviewService, this.environmentService);
		const host = this._register(new PowerModeTerminalHost(this.powerModeService));
		host.mountWithTransport(result.terminal);
		this.storageService.store(POWER_MODE_STORAGE_KEY, JSON.stringify({ isOpen: true, mode: 'floating' }), StorageScope.WORKSPACE, 1);
		// No dispose hook — aux window manages its own lifetime
	}

	async _openInTab(floatingWindow: boolean): Promise<void> {
		const result = await openPowerModeInTab(this.webviewWorkbenchService, this.environmentService, this.editorGroupsService, floatingWindow);
		const host = this._register(new PowerModeTerminalHost(this.powerModeService));
		host.mountWithTransport(result.terminal);
		this.storageService.store(POWER_MODE_STORAGE_KEY, JSON.stringify({ isOpen: true, mode: floatingWindow ? 'floating-tab' : 'tab' }), StorageScope.WORKSPACE, 1);
		result.webviewInput.onWillDispose(() => {
			host.dispose();
			this.storageService.store(POWER_MODE_STORAGE_KEY, JSON.stringify({ isOpen: false }), StorageScope.WORKSPACE, 1);
		});
	}
}

// ─── Command: Open Power Mode (floating window, no tab bar) ──────────────────

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
		if (_isPolicyBlocked(accessor.get(IEnterprisePolicyService))) { _notifyBlocked(accessor); return; }
		const auxiliaryWindowService = accessor.get(IAuxiliaryWindowService);
		const webviewService = accessor.get(IWebviewService);
		const environmentService = accessor.get(IEnvironmentService);
		const powerModeService = accessor.get(IPowerModeService);

		const result = await openPowerModeFloating(auxiliaryWindowService, webviewService, environmentService);
		const host = new PowerModeTerminalHost(powerModeService);
		host.mountWithTransport(result.terminal);
	}
});

// ─── Command: Open Power Mode in Tab ─────────────────────────────────────────

registerAction2(class OpenPowerModeInTabAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.openPowerModeInTab',
			title: localize2('neuralInverse.openPowerModeInTab', 'Neural Inverse: Open Power Mode in Tab'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		if (_isPolicyBlocked(accessor.get(IEnterprisePolicyService))) { _notifyBlocked(accessor); return; }
		const webviewWorkbenchService = accessor.get(IWebviewWorkbenchService);
		const environmentService = accessor.get(IEnvironmentService);
		const editorGroupsService = accessor.get(IEditorGroupsService);
		const powerModeService = accessor.get(IPowerModeService);

		const result = await openPowerModeInTab(webviewWorkbenchService, environmentService, editorGroupsService, false);
		const host = new PowerModeTerminalHost(powerModeService);
		host.mountWithTransport(result.terminal);
		result.webviewInput.onWillDispose(() => host.dispose());
	}
});

// ─── Register contribution ────────────────────────────────────────────────────

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(PowerModeContribution, LifecyclePhase.Restored);
