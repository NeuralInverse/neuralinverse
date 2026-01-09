/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { INeuralInverseAuthService } from '../common/neuralInverseAuth.js';
import { NeuralInverseAuthService } from './neuralInverseAuthService.js';

registerSingleton(INeuralInverseAuthService, NeuralInverseAuthService, InstantiationType.Eager);

import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { NeuralInverseUrlHandler } from './neuralInverseUrlHandler.js';
import { LifecyclePhase, ILifecycleService } from '../../../services/lifecycle/common/lifecycle.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

// --- Actions for Command Palette ---

class ShowAuthStatusAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.showAuthStatus',
			title: { value: 'Neural Inverse: Show Auth Status', original: 'Neural Inverse: Show Auth Status' },
			f1: true, // Show in Command Palette
			category: { value: 'Neural Inverse', original: 'Neural Inverse' }
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const authService = accessor.get(INeuralInverseAuthService);
		const notificationService = accessor.get(INotificationService);

		const isAuth = await authService.isAuthenticated();
		const token = await authService.getToken();
		console.log('NeuralInverseAuth: Manual Check ->', isAuth, token ? 'Token exists' : 'No token');

		if (isAuth) {
			notificationService.info('Neural Inverse: Authenticated');
		} else {
			notificationService.warn('Neural Inverse: Not Authenticated');
		}
	}
}

class LogoutAction extends Action2 {
	constructor() {
		super({
			id: 'neuralInverse.logout',
			title: { value: 'Neural Inverse: Logout', original: 'Neural Inverse: Logout' },
			f1: true,
			category: { value: 'Neural Inverse', original: 'Neural Inverse' }
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const authService = accessor.get(INeuralInverseAuthService);
		const notificationService = accessor.get(INotificationService);

		await authService.logout();
		notificationService.info('Neural Inverse: Logged out');
	}
}

// --- Workbench Contribution ---

// Define an interface for the contribution if we want to access it via service lookup, but for now standard class.
// We'll keep the logic self-contained.

export class NeuralInverseAuthContribution extends Disposable implements IWorkbenchContribution {

	// Static instance to help with testing/access if extremely necessary, but avoided for cleaner pattern.

	constructor(
		@INeuralInverseAuthService private readonly authService: INeuralInverseAuthService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService
	) {
		super();
		console.log('NeuralInverseAuthContribution: Initialized');
		this.lifecycleService.when(LifecyclePhase.Restored).then(() => this.checkAuth());

		// Listen to auth status changes to show/hide overlay automatically?
		// The original logic only showed overlay on start.
		// If we want logout to show overlay, we should listen.
		this._register(this.authService.onDidChangeAuthStatus(isAuthenticated => {
			if (!isAuthenticated) {
				this.showLoginOverlay();
			}
		}));
	}

	private async checkAuth(): Promise<void> {
		const isAuth = await this.authService.isAuthenticated();
		console.log('NeuralInverseAuth: checkAuth ->', isAuth);
		if (!isAuth) {
			this.showLoginOverlay();
		}
	}

	private showLoginOverlay(): void {
		// Prevent duplicate overlays
		if (document.getElementById('neural-inverse-login-overlay')) {
			return;
		}

		const overlay = document.createElement('div');
		overlay.id = 'neural-inverse-login-overlay';
		overlay.style.position = 'fixed';
		overlay.style.top = '0';
		overlay.style.left = '0';
		overlay.style.width = '100vw';
		overlay.style.height = '100vh';
		overlay.style.backgroundColor = '#1e1e1e';
		overlay.style.color = '#ffffff';
		overlay.style.zIndex = '2147483647'; // Max z-index
		overlay.style.display = 'flex';
		overlay.style.flexDirection = 'column';
		overlay.style.alignItems = 'center';
		overlay.style.justifyContent = 'center';

		const devToolsListener = (e: KeyboardEvent) => {
			if ((e.metaKey && e.altKey && e.code === 'KeyI') || e.code === 'F12') {
				this.commandService.executeCommand('workbench.action.toggleDevTools');
			}
		};
		window.addEventListener('keydown', devToolsListener);

		const title = document.createElement('h1');
		title.textContent = 'Neural Inverse';
		title.style.marginBottom = '20px';
		title.style.fontSize = '2.5em';
		title.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
		title.style.fontWeight = '300';
		title.style.color = '#ffffff';

		const loginBtn = document.createElement('button');
		loginBtn.textContent = 'Log in with Neural Inverse';
		loginBtn.style.padding = '12px 24px';
		loginBtn.style.fontSize = '1.2em';
		loginBtn.style.cursor = 'pointer';
		loginBtn.style.backgroundColor = '#007acc';
		loginBtn.style.color = 'white';
		loginBtn.style.border = 'none';
		loginBtn.style.borderRadius = '5px';
		loginBtn.style.marginTop = '20px';

		loginBtn.onclick = async () => {
			try {
				loginBtn.textContent = 'Logging in...';
				await this.authService.login();
			} catch (e) {
				console.error('NeuralInverseAuth: Login error', e);
				loginBtn.textContent = 'Login Failed. Retry?';
			}
		};

		const authListener = this.authService.onDidChangeAuthStatus((isAuthenticated) => {
			if (isAuthenticated) {
				cleanup();
			}
		});

		const poll = setInterval(async () => {
			if (await this.authService.isAuthenticated()) {
				cleanup();
			}
		}, 1000);

		function cleanup() {
			clearInterval(poll);
			window.removeEventListener('keydown', devToolsListener);
			authListener.dispose();
			if (overlay.parentNode) {
				overlay.parentNode.removeChild(overlay);
			}
		}

		overlay.appendChild(title);
		overlay.appendChild(loginBtn);

		// Append to body to ensure it covers everything
		document.body.appendChild(overlay);
	}
}

// Register Actions
registerAction2(ShowAuthStatusAction);
registerAction2(LogoutAction);

// Register Contributions
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(NeuralInverseUrlHandler, LifecyclePhase.Restored);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(NeuralInverseAuthContribution, LifecyclePhase.Restored);

// Helper interface for Service Accessor if we were to expose the contribution, but strictly not needed for this logic.
const INeuralInverseAuthContribution = 'INeuralInverseAuthContribution'; // Placeholder
