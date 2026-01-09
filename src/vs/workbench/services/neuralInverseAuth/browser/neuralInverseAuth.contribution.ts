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
import { NEURAL_INVERSE_LOGO } from './neuralInverseLogo.js';


// --- Actions for Command Palette ---



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
		@ICommandService private readonly commandService: ICommandService) {
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

		// Overlay Styles: White Theme
		overlay.style.backgroundColor = '#ffffff';
		overlay.style.color = '#000000'; // Dark text for contrast if needed
		// ... existing zIndex, display, etc. ...
		overlay.style.zIndex = '2147483647';
		overlay.style.display = 'flex';
		overlay.style.flexDirection = 'column';
		overlay.style.alignItems = 'center';
		overlay.style.justifyContent = 'center';
		overlay.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';


		// Inject keyframe styles (Premium Intro Animation)
		const style = document.createElement('style');
		style.textContent = `
			@keyframes premiumScaleIn {
				0% {
					transform: scale(0.9) translateY(10px);
					opacity: 0;
					filter: blur(10px);
				}
				100% {
					transform: scale(1) translateY(0);
					opacity: 1;
					filter: blur(0);
				}
			}
			@keyframes slideUpFade {
				0% {
					transform: translateY(20px);
					opacity: 0;
				}
				100% {
					transform: translateY(0);
					opacity: 1;
				}
			}
			@keyframes pulse {
				0% { transform: scale(1); }
				50% { transform: scale(1.02); }
				100% { transform: scale(1); }
			}

			.ni-intro-logo {
				opacity: 0;
				animation: premiumScaleIn 1.2s cubic-bezier(0.16, 1, 0.3, 1) forwards;
			}

			/* Optional: Add subtle pulse after intro */
			/* .ni-intro-logo { animation: premiumScaleIn 1.2s ..., pulse 3s infinite 2s; } */

			.ni-btn {
				opacity: 0;
				animation: slideUpFade 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
				animation-delay: 0.5s;
			}
			.ni-btn:hover {
				background-color: #358DF6 !important;
				transform: translateY(-1px);
				box-shadow: 0 4px 12px rgba(53, 141, 246, 0.4);
			}
			.ni-btn:active {
				transform: translateY(0);
			}
		`;
		document.head.appendChild(style);

		const devToolsListener = (e: KeyboardEvent) => {
			if ((e.metaKey && e.altKey && e.code === 'KeyI') || e.code === 'F12') {
				this.commandService.executeCommand('workbench.action.toggleDevTools');
			}
		};
		window.addEventListener('keydown', devToolsListener);


		// Main Container (Column: Logo | Button)
		const mainContainer = document.createElement('div');
		mainContainer.style.display = 'flex';
		mainContainer.style.flexDirection = 'column';
		mainContainer.style.alignItems = 'center';
		mainContainer.style.justifyContent = 'center';
		mainContainer.style.gap = '40px';
		mainContainer.classList.add('ni-intro-logo'); // Animate the container/logo

		// Unified Logo Image
		const logo = document.createElement('img');
		logo.src = NEURAL_INVERSE_LOGO;
		logo.style.width = '300px'; // Wider to accommodate text in SVG
		logo.style.height = 'auto'; // Maintain aspect ratio
		logo.style.objectFit = 'contain';

		const loginBtn = document.createElement('button');
		loginBtn.textContent = 'Login with Neural Inverse';
		loginBtn.classList.add('ni-btn');

		// Button Base Styles
		loginBtn.style.display = 'flex';
		loginBtn.style.alignItems = 'center';
		loginBtn.style.justifyContent = 'center';
		loginBtn.style.padding = '14px 40px';
		loginBtn.style.fontSize = '1.1em';
		loginBtn.style.fontWeight = '600';
		loginBtn.style.cursor = 'pointer';
		loginBtn.style.backgroundColor = '#358DF6';
		loginBtn.style.color = 'white';
		loginBtn.style.border = 'none';
		loginBtn.style.borderRadius = '8px';
		loginBtn.style.transition = 'all 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease';
		loginBtn.style.boxShadow = '0 4px 14px rgba(0,0,0,0.1)'; // Lighter shadow for light theme
		loginBtn.style.minWidth = '220px';

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

		// Assemble
		mainContainer.appendChild(logo);
		mainContainer.appendChild(loginBtn);

		overlay.appendChild(mainContainer);

		// Append to body to ensure it covers everything
		document.body.appendChild(overlay);
	}
}

// Register Actions
registerAction2(LogoutAction);

// Register Contributions
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(NeuralInverseUrlHandler, LifecyclePhase.Restored);

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(NeuralInverseAuthContribution, LifecyclePhase.Restored);

// --- Profile Editor Registration Removed (Moved to UserProfile module)

// Helper interface for Service Accessor if we were to expose the contribution, but strictly not needed for this logic.

