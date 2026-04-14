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
import { EnclaveManagerPart } from './parts/enclaveManagerPart.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';


const ENCLAVE_MANAGER_WINDOW_TYPE = 'enclaveManager';
const ENCLAVE_MANAGER_STORAGE_KEY = 'neuralInverseEnclave.state';

export class EnclaveManagerContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IAuxiliaryWindowService private readonly auxiliaryWindowService: IAuxiliaryWindowService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
		this.restoreWindow();
	}

	private restoreWindow(): void {
		const stateRaw = this.storageService.get(ENCLAVE_MANAGER_STORAGE_KEY, StorageScope.WORKSPACE);
		if (stateRaw) {
			try {
				const state = JSON.parse(stateRaw);
				if (state.isOpen) {
					this.openEnclaveManagerWindow(state.bounds);
				}
			} catch (e) {
				console.error('Failed to restore Enclave Manager window state', e);
			}
		}
	}

	async openEnclaveManagerWindow(bounds?: any): Promise<void> {
		let window = this.auxiliaryWindowService.getWindowByType(ENCLAVE_MANAGER_WINDOW_TYPE);

		if (window) {
			window.window.focus();
			return;
		}

		window = await this.auxiliaryWindowService.open({
			type: ENCLAVE_MANAGER_WINDOW_TYPE,
			bounds: bounds,
			mode: undefined, // Normal
			nativeTitlebar: false,
			disableFullscreen: false,
		});

		const part = this.instantiationService.createInstance(EnclaveManagerPart);
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
		const instantiationService = accessor.get(IInstantiationService);
		const auxWindowService = accessor.get(IAuxiliaryWindowService);
		const hostService = accessor.get(IHostService);

		let window = auxWindowService.getWindowByType(ENCLAVE_MANAGER_WINDOW_TYPE);
		if (window && !window.window.closed) {
			hostService.focus(window.window, { force: true });
			return;
		}

		const win = await auxWindowService.open({
			type: ENCLAVE_MANAGER_WINDOW_TYPE,
			nativeTitlebar: false,
		});

		const part = instantiationService.createInstance(EnclaveManagerPart);
		part.create(win.container);
		const dimension = win.window.document.body.getBoundingClientRect();
		part.layout(dimension.width, dimension.height, 0, 0);

		const store = new DisposableStore();
		store.add(part);
		store.add(win.onDidLayout(d => part.layout(d.width, d.height, 0, 0)));
		store.add(win.onUnload(() => store.dispose()));
	}
});

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(EnclaveManagerContribution, LifecyclePhase.Restored);

// Register Status Bar Item
import { EnclaveStatusContribution } from './statusbar/enclaveStatus.contribution.js';
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(EnclaveStatusContribution, LifecyclePhase.Restored);

// ─── Enclave Core Services (load order matters — dependencies first) ───────

// Layer 0: Environment (no dependencies)
import '../../neuralInverseEnclave/common/services/environment/enclaveEnvironmentService.js';

// Layer 1: Cryptographic Foundation (depends on: environment)
import '../../neuralInverseEnclave/common/services/crypto/enclaveCryptoService.js';

// Layer 2: Session Lifecycle (depends on: crypto, environment, lifecycle)
import '../../neuralInverseEnclave/common/services/session/enclaveSessionService.js';

// Layer 3: Audit Trail (depends on: crypto, session, environment)
import '../../neuralInverseEnclave/common/services/audit/enclaveAuditTrailService.js';

// Layer 3: Provenance Watermarking (depends on: environment)
import '../../neuralInverseEnclave/common/services/audit/enclaveProvenanceService.js';

// Layer 3: Context Firewall (depends on: environment)
import '../../neuralInverseEnclave/common/services/firewall/enclaveFirewallService.js';

// Layer 3: Execution Sandbox (depends on: environment)
import '../../neuralInverseEnclave/common/services/sandbox/enclaveSandboxService.js';

// Layer 3: File Integrity Tracker (depends on: crypto, session) — Phase 2
import '../../neuralInverseEnclave/common/services/integrity/enclaveFileIntegrityService.js';

// Layer 3: Commit Proof Service (depends on: crypto, session, integrity, audit) — Phase 2
import '../../neuralInverseEnclave/common/services/commit/enclaveCommitService.js';

// Layer 3: Toolchain Verification (depends on: crypto, session, audit, environment) — Phase 3
import '../../neuralInverseEnclave/common/services/toolchain/enclaveToolchainService.js';

// Layer 3: SBOM Generation (depends on: crypto, session, audit) — Phase 3
import '../../neuralInverseEnclave/common/services/sbom/enclaveSBOMService.js';

// Layer 3: Build Reproducibility (depends on: crypto, session, audit, toolchain) — Phase 3
import '../../neuralInverseEnclave/common/services/build/enclaveBuildService.js';

// Layer 4: Analysis Proof (depends on: crypto, session, audit, file service) — Phase 4
import '../../neuralInverseEnclave/common/services/analysis/enclaveAnalysisProofService.js';

// Layer 4: Test Execution Proof (depends on: crypto, session, audit, file service) — Phase 4
import '../../neuralInverseEnclave/common/services/test/enclaveTestProofService.js';

// Layer 4: Review & Approval Gate (depends on: crypto, session, audit, environment) — Phase 4
import '../../neuralInverseEnclave/common/services/review/enclaveReviewService.js';

// Layer 5: Secret Vault (depends on: crypto, session, audit, environment) — Phase 5
import '../../neuralInverseEnclave/common/services/vault/enclaveVaultService.js';

// Layer 6: Hardware TEE Attestation (depends on: crypto, session, audit, environment) — Phase 6
import '../../neuralInverseEnclave/common/services/attestation/enclaveAttestationService.js';

// Layer 4: Gatekeeper — unified enforcement point (depends on: firewall, sandbox, audit trail)
import '../../neuralInverseEnclave/common/services/gatekeeper/enclaveGatekeeperService.js';

// ─── Action Log — full IDE event bus tracker (Eager) ────────────────────────
import '../common/services/actionLog/enclaveActionLogStorageService.js'; // Storage layer (must load before ActionLogService)
import './services/actionLog/enclaveActionLogService.js';                // Core action tracker (Eager — hooks all event buses on startup)

