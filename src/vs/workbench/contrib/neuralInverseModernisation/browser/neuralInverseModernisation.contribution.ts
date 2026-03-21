/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Neural Inverse Corporation. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * # NeuralInverse Modernisation — Contribution
 *
 * Opens a dedicated auxiliary window (like Power Mode) on Cmd+Alt+M.
 * No sidebar — the ModernisationPart IS the console.
 *
 * Commands:
 *  neuralInverse.openModernisation                  Cmd+Alt+M  — open / focus Modernisation console
 *  neuralInverse.openModernisationSourceWindows               — open all source folders in new VS Code windows
 *  neuralInverse.openModernisationTargetWindows               — open all target folders in new VS Code windows
 *  neuralInverse.openModernisationLegacyWindow                — alias → openModernisationSourceWindows
 *  neuralInverse.openModernisationModernWindow                — alias → openModernisationTargetWindows
 *  neuralInverse.endModernisationSession                      — end session (clears state)
 */

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IAuxiliaryWindowService } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { URI } from '../../../../base/common/uri.js';
import { ModernisationPart } from './ui/modernisationPart.js';
import { ModernisationStatusContribution } from './statusbar/modernisationStatus.contribution.js';
import { IModernisationSessionService } from './modernisationSessionService.js';

// Register DI singletons (side-effect imports)
import './modernisationSessionService.js';
import './knowledgeBase/index.js';
import './engine/fingerprint/index.js';
import './stage3-migration/fingerprintComparisonService.js';
import './engine/discovery/discoveryService.js';
import './engine/migrationPlannerService.js';
import './engine/resolution/index.js';
// Register discovery + modernisation tools with the Void internal tool service
import './voidDiscoveryToolsContrib.js';

const MODERNISATION_WINDOW_TYPE = 'neuralInverseModernisation';
const MODERNISATION_STATE_KEY   = 'neuralInverseModernisation.windowState';

// ─── Window helper ────────────────────────────────────────────────────────────

async function openModernisationWindow(
	auxWindowService: IAuxiliaryWindowService,
	hostService: IHostService,
	storageService: IStorageService,
	instantiationService: IInstantiationService,
): Promise<void> {
	const existing = auxWindowService.getWindowByType(MODERNISATION_WINDOW_TYPE);
	if (existing && !existing.window.closed) {
		hostService.focus(existing.window, { force: true });
		return;
	}

	const win = await auxWindowService.open({ type: MODERNISATION_WINDOW_TYPE, nativeTitlebar: false });
	const part = instantiationService.createInstance(ModernisationPart);
	part.create(win.container);

	const dim = win.window.document.body.getBoundingClientRect();
	part.layout(dim.width, dim.height, 0, 0);

	const store = new DisposableStore();
	store.add(part);
	store.add(win.onDidLayout(d => part.layout(d.width, d.height, 0, 0)));
	store.add(win.onUnload(() => {
		storageService.store(MODERNISATION_STATE_KEY, JSON.stringify({ isOpen: false }), StorageScope.WORKSPACE, 1);
		store.dispose();
	}));

	storageService.store(MODERNISATION_STATE_KEY, JSON.stringify({ isOpen: true }), StorageScope.WORKSPACE, 1);
	win.layout();
}

// ─── Contribution (restore window on reload) ─────────────────────────────────

class ModernisationContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IAuxiliaryWindowService private readonly auxiliaryWindowService: IAuxiliaryWindowService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._restoreWindow();
	}

	private _restoreWindow(): void {
		const raw = this.storageService.get(MODERNISATION_STATE_KEY, StorageScope.WORKSPACE);
		if (!raw) { return; }
		try {
			if (!JSON.parse(raw).isOpen) { return; }
		} catch { return; }

		this.auxiliaryWindowService.open({ type: MODERNISATION_WINDOW_TYPE, nativeTitlebar: false }).then(win => {
			const part = this.instantiationService.createInstance(ModernisationPart);
			part.create(win.container);
			const store = new DisposableStore();
			store.add(part);
			store.add(win.onDidLayout(d => part.layout(d.width, d.height, 0, 0)));
			store.add(win.onUnload(() => {
				this.storageService.store(MODERNISATION_STATE_KEY, JSON.stringify({ isOpen: false }), StorageScope.WORKSPACE, 1);
				store.dispose();
			}));
			win.layout();
		});
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(ModernisationContribution, LifecyclePhase.Restored);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(ModernisationStatusContribution, LifecyclePhase.Restored);

// ─── Commands ────────────────────────────────────────────────────────────────

/** Cmd+Alt+M — open / focus the Modernisation console window */
registerAction2(class OpenModernisationAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.openModernisation',
			title: localize2('neuralInverse.openModernisation', 'Neural Inverse: Open Modernisation Mode'),
			f1: true,
			keybinding: {
				weight: 200,
				primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyM,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await openModernisationWindow(
			accessor.get(IAuxiliaryWindowService),
			accessor.get(IHostService),
			accessor.get(IStorageService),
			accessor.get(IInstantiationService),
		);
	}
});

/** Open all source project folders in new VS Code windows */
registerAction2(class OpenSourceWindowsAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.openModernisationSourceWindows',
			title: localize2('neuralInverse.openModernisationSourceWindows', 'Neural Inverse: Open Source Project Window(s)'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, specificUri?: string): Promise<void> {
		const session = accessor.get(IModernisationSessionService).session;
		const host = accessor.get(IHostService);
		const uris = specificUri
			? [specificUri]
			: session.sources.map(s => s.folderUri);
		for (const u of uris) {
			await host.openWindow([{ folderUri: URI.parse(u) }], { forceNewWindow: true });
		}
	}
});

/** Open all target project folders in new VS Code windows */
registerAction2(class OpenTargetWindowsAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.openModernisationTargetWindows',
			title: localize2('neuralInverse.openModernisationTargetWindows', 'Neural Inverse: Open Target Project Window(s)'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, specificUri?: string): Promise<void> {
		const session = accessor.get(IModernisationSessionService).session;
		const host = accessor.get(IHostService);
		const uris = specificUri
			? [specificUri]
			: session.targets.map(t => t.folderUri);
		for (const u of uris) {
			await host.openWindow([{ folderUri: URI.parse(u) }], { forceNewWindow: true });
		}
	}
});

// Keep legacy command IDs as aliases for backwards compat
registerAction2(class OpenLegacyWindowAliasAction extends Action2 {
	constructor() {
		super({ id: 'neuralInverse.openModernisationLegacyWindow', title: localize2('neuralInverse.openModernisationLegacyWindow', 'Neural Inverse: Open Legacy Project Window'), f1: false });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('neuralInverse.openModernisationSourceWindows');
	}
});

registerAction2(class OpenModernWindowAliasAction extends Action2 {
	constructor() {
		super({ id: 'neuralInverse.openModernisationModernWindow', title: localize2('neuralInverse.openModernisationModernWindow', 'Neural Inverse: Open Modern Project Window'), f1: false });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('neuralInverse.openModernisationTargetWindows');
	}
});

/** End the session — clears all state, hides statusbar item */
registerAction2(class EndModernisationSessionAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.endModernisationSession',
			title: localize2('neuralInverse.endModernisationSession', 'Neural Inverse: End Modernisation Session'),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		accessor.get(IModernisationSessionService).endSession();
	}
});
