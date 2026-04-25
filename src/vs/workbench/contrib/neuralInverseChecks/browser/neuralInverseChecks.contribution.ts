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
// inverseAccessService MUST be first \u2014 it registers the terminal-based chmod executor
// used by every other service that writes to the write-locked .inverse directory.
import './engine/services/inverseAccessService.js';
import './engine/framework/frameworkRegistry.js'; // Must load before grcEngineService
import './engine/framework/frameworkBriefService.js'; // Generates compliance briefs at framework import time
import './engine/framework/frameworkRuleIndexService.js'; // Keyword rule index for context-aware rule retrieval
import './voidGRCToolsContrib.js';                       // Registers GRC tools with VoidInternalToolService
import './nanoAgents/projectAnalyzerService.js'; // Must load before grcEngineService
import './engine/services/grcEngineService.js';
import './engine/services/auditTrailService.js';
import './engine/services/contractReasonService.js'; // Register Contract Reason Service
import './engine/services/codebaseContextService.js'; // Register Codebase Context Service
import './engine/services/violationFeedbackService.js'; // Register Violation Feedback Service (false positive persistence)
import './engine/services/complianceReportService.js'; // Register Compliance Report Service
import './engine/services/externalCommandExecutor.js'; // External tool command execution (terminal redirect)
import './engine/services/externalResultCache.js';     // Content-hash cache for external tool results
import './engine/services/externalToolService.js';     // External tool orchestration (CodeQL, Semgrep, Polyspace, ...)
import './engine/services/externalFeedbackService.js'; // Feeds external tool results back into Layer 1 (brief) + Layer 2 (index)
import './engine/services/simulatorService.js';        // Runtime simulation (QEMU, Renode, GDB sim, Spike, custom)
import './engine/services/formalVerificationService.js'; // Formal verification (CBMC, Frama-C, GNATprove, Dafny, TLA+, ...)
import './checksAgent/checksAgentService.js';          // GRC specialist AI (Checks Agent TUI)
import './dependencyTracker/dependencyTrackerService.js'; // Universal dependency tracker + enforcer
import './extensionTracker/extensionTrackerService.js';   // Extension tracker + enforcer
import './projectConfigSyncService.js';                // Sync GRC frameworks + extension policy from web console
import { IChecksSocketService } from './checksSocket/checksSocketService.js'; // Enterprise checks-socket integration
import { IFrameworkBriefService } from './engine/framework/frameworkBriefService.js';
import { IFrameworkRuleIndexService } from './engine/framework/frameworkRuleIndexService.js';
import { IExternalFeedbackService } from './engine/services/externalFeedbackService.js';
import { ISimulatorService } from './engine/services/simulatorService.js';
import { IFormalVerificationService } from './engine/services/formalVerificationService.js';
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

// Bootstrap ChecksSocketService \u2014 without this contribution, the singleton never gets instantiated
// because nothing injects @IChecksSocketService directly.
class ChecksSocketContribution extends Disposable implements IWorkbenchContribution {
	constructor(@IChecksSocketService _checksSocketService: IChecksSocketService) {
		super();
	}
}
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(ChecksSocketContribution, LifecyclePhase.Restored);

// Bootstrap FrameworkBriefService \u2014 Eager singleton, but needs a DI consumer to actually instantiate.
class FrameworkBriefContribution extends Disposable implements IWorkbenchContribution {
	constructor(@IFrameworkBriefService _frameworkBriefService: IFrameworkBriefService) {
		super();
	}
}
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(FrameworkBriefContribution, LifecyclePhase.Restored);

// Bootstrap FrameworkRuleIndexService \u2014 Eager singleton, needs DI consumer to instantiate.
class FrameworkRuleIndexContribution extends Disposable implements IWorkbenchContribution {
	constructor(@IFrameworkRuleIndexService _frameworkRuleIndexService: IFrameworkRuleIndexService) {
		super();
	}
}
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(FrameworkRuleIndexContribution, LifecyclePhase.Restored);

// Bootstrap ExternalFeedbackService \u2014 routes external tool results to Layer 1 + Layer 2.
class ExternalFeedbackContribution extends Disposable implements IWorkbenchContribution {
	constructor(@IExternalFeedbackService _externalFeedbackService: IExternalFeedbackService) {
		super();
	}
}
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(ExternalFeedbackContribution, LifecyclePhase.Restored);

// Bootstrap SimulatorService \u2014 runtime simulation for embedded/firmware GRC enforcement.
class SimulatorServiceContribution extends Disposable implements IWorkbenchContribution {
	constructor(@ISimulatorService _simulatorService: ISimulatorService) {
		super();
	}
}
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(SimulatorServiceContribution, LifecyclePhase.Restored);

// Bootstrap FormalVerificationService \u2014 FV tool sessions (CBMC, Frama-C, GNATprove, Dafny, ...).
class FormalVerificationServiceContribution extends Disposable implements IWorkbenchContribution {
	constructor(@IFormalVerificationService _fvService: IFormalVerificationService) {
		super();
	}
}
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(FormalVerificationServiceContribution, LifecyclePhase.Restored);

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

		const disposables = new DisposableStore();
		disposables.add(part);

		disposables.add(window.onDidLayout(dimension => {
			part.layout(dimension.width, dimension.height, 0, 0);
		}));

		disposables.add(window.onUnload(() => {
			disposables.dispose();
		}));

		// Trigger initial layout via window.layout() which uses getClientArea with
		// DEFAULT_AUX_WINDOW_DIMENSIONS fallback \u2014 avoids 0x0 from getBoundingClientRect()
		// on a not-yet-painted window (which would leave the webview permanently invisible).
		window.layout();
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

		const store = new DisposableStore();
		store.add(part);
		store.add(win.onDidLayout(d => part.layout(d.width, d.height, 0, 0)));
		store.add(win.onUnload(() => store.dispose()));

		// Trigger initial layout via win.layout() \u2014 avoids 0x0 from getBoundingClientRect()
		// on a not-yet-painted window, which would leave the webview permanently invisible.
		win.layout();
	}
});

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(ChecksManagerContribution, LifecyclePhase.Restored);

// \u2500\u2500 Add Selection to Checks \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Triggered from VoidSelectionHelper ("Add to Checks" option in code-selection widget).
// Opens the Checks Manager window and prefills the Checks Agent with the selected text.
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { IChecksAgentService } from './checksAgent/checksAgentService.js';

export const NEURAL_INVERSE_ADD_TO_CHECKS_ACTION_ID = 'neuralInverse.addSelectionToChecks';

registerAction2(class AddSelectionToChecksAction extends Action2 {
	constructor() {
		super({
			id: NEURAL_INVERSE_ADD_TO_CHECKS_ACTION_ID,
			title: localize2('neuralInverse.addSelectionToChecks', 'Neural Inverse: Add Selection to Checks'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const codeEditorService = accessor.get(ICodeEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		const auxWindowService = accessor.get(IAuxiliaryWindowService);
		const hostService = accessor.get(IHostService);
		const checksAgentService = accessor.get(IChecksAgentService);

		// Get selected text from active editor
		const editor = codeEditorService.getActiveCodeEditor();
		const selection = editor?.getSelection();
		const model = editor?.getModel();
		const selectedText = (selection && model && !selection.isEmpty())
			? model.getValueInRange(selection)
			: '';
		const fileName = model?.uri.path.split('/').pop() ?? '';
		const startLine = selection?.startLineNumber ?? 0;

		const question = selectedText
			? `Review this code from ${fileName}:${startLine} for GRC violations:\n\`\`\`\n${selectedText.slice(0, 2000)}\n\`\`\``
			: 'Review the active file for GRC violations.';

		// Open or focus Checks Manager
		let win = auxWindowService.getWindowByType(CHECKS_MANAGER_WINDOW_TYPE);
		if (win && !win.window.closed) {
			hostService.focus(win.window, { force: true });
		} else {
			win = await auxWindowService.open({ type: CHECKS_MANAGER_WINDOW_TYPE, nativeTitlebar: false });
			const part = instantiationService.createInstance(ChecksManagerPart);
			part.create(win.container);
			const store = new DisposableStore();
			store.add(part);
			store.add(win.onDidLayout(d => part.layout(d.width, d.height, 0, 0)));
			store.add(win.onUnload(() => store.dispose()));
			win.layout();
		}

		// Small delay to let window render, then prefill
		setTimeout(() => checksAgentService.prefill(question), 400);
	}
});

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
