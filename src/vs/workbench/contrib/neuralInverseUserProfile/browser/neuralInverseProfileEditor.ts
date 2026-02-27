/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append, Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { NeuralInverseProfileEditorInput } from './neuralInverseProfileEditorInput.js';
import { INeuralInverseAuthService } from '../../../services/neuralInverseAuth/common/neuralInverseAuth.js';
import { INeuralInverseUserProfileService } from '../common/neuralInverseUserProfile.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { NEURAL_INVERSE_LOGO } from '../../../services/neuralInverseAuth/browser/neuralInverseLogo.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { SettingsEditor2 } from '../../preferences/browser/settingsEditor2.js';
import { SettingsEditor2Input } from '../../../services/preferences/common/preferencesEditorInput.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';

export class NeuralInverseProfileEditor extends EditorPane {
	static readonly ID: string = 'workbench.editor.neuralInverseProfile';

	private rootElement!: HTMLElement;
	private tabBarContainer!: HTMLElement;
	private profileContainer!: HTMLElement;
	private settingsContainer!: HTMLElement;

	private settingsEditor: SettingsEditor2 | undefined;
	private settingsEditorInput: SettingsEditor2Input | undefined;

	private currentTab: 'profile' | 'settings' = 'profile';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@INeuralInverseAuthService private readonly authService: INeuralInverseAuthService,
		@INeuralInverseUserProfileService private readonly userProfileService: INeuralInverseUserProfileService,

		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IOpenerService private readonly openerService: IOpenerService
	) {
		super(NeuralInverseProfileEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.rootElement = append(parent, $('.neural-inverse-profile-editor'));
		this.rootElement.style.height = '100%';
		this.rootElement.style.width = '100%';
		this.rootElement.style.display = 'flex';
		this.rootElement.style.flexDirection = 'column';
		this.rootElement.style.backgroundColor = 'var(--vscode-editor-background)';
		this.rootElement.style.color = 'var(--vscode-editor-foreground)';

		// Tab Bar Container
		this.tabBarContainer = append(this.rootElement, $('.tab-bar-container'));
		// Reset padding/margin here to depend on renderTabBar
		this.tabBarContainer.style.flexShrink = '0';

		// Content Containers
		const contentWrapper = append(this.rootElement, $('.content-wrapper'));
		contentWrapper.style.flexGrow = '1';
		contentWrapper.style.position = 'relative';
		contentWrapper.style.overflow = 'hidden';
		contentWrapper.style.display = 'flex';
		contentWrapper.style.flexDirection = 'column';

		// Profile Container
		this.profileContainer = append(contentWrapper, $('.profile-container'));
		this.profileContainer.style.height = '100%';
		this.profileContainer.style.width = '100%';
		this.profileContainer.style.padding = '20px 40px';
		this.profileContainer.style.display = 'flex';
		this.profileContainer.style.flexDirection = 'column';
		this.profileContainer.style.gap = '20px';
		this.profileContainer.style.overflowY = 'auto';

		// Settings Container
		this.settingsContainer = append(contentWrapper, $('.settings-container'));
		this.settingsContainer.style.height = '100%';
		this.settingsContainer.style.width = '100%';
		this.settingsContainer.style.display = 'none'; // Initially hidden

		this.renderTabBar();
		this.render();

		this._register(this.authService.onDidChangeAuthStatus(() => this.render()));
		this._register(this.userProfileService.onDidChangeUserProfile(() => this.render()));
	}

	private async render(): Promise<void> {
		const isAuth = await this.authService.isAuthenticated();

		if (isAuth) {
			this.tabBarContainer.style.display = 'block';

			if (this.currentTab === 'profile') {
				this.profileContainer.style.display = 'flex';
				this.settingsContainer.style.display = 'none';
				if (this.settingsEditor) {
					this.settingsEditor.setVisible(false);
				}
				await this.renderProfileView();
			} else {
				this.profileContainer.style.display = 'none';
				this.settingsContainer.style.display = 'block';
				await this.renderSettingsView();
				if (this.settingsEditor) {
					this.settingsEditor.setVisible(true);
				}
			}
		} else {
			this.tabBarContainer.style.display = 'none';
			this.profileContainer.style.display = 'flex';
			this.settingsContainer.style.display = 'none';
			this.renderUnauthenticatedView();
		}

		this.renderTabBar(); // Re-render tab bar to update active state
	}

	private renderTabBar() {
		this.tabBarContainer.innerHTML = ''; // Clear existing
		this.tabBarContainer.style.display = 'flex'; // Use flex directly
		this.tabBarContainer.style.gap = '0';
		this.tabBarContainer.style.borderBottom = '1px solid var(--vscode-panel-border)';
		this.tabBarContainer.style.marginBottom = '20px';
		this.tabBarContainer.style.backgroundColor = 'var(--vscode-editor-group-header-tabs-background)'; // Standard tab background
		this.tabBarContainer.style.width = '100%';
		this.tabBarContainer.style.height = '35px'; // Explicit height
		this.tabBarContainer.style.alignItems = 'center';
		this.tabBarContainer.style.padding = '0'; // Reset padding

		const createTab = (id: 'profile' | 'settings', label: string) => {
			const tab = document.createElement('div');
			tab.textContent = label;
			tab.style.cursor = 'pointer';
			tab.style.padding = '0 20px';
			tab.style.height = '100%'; // Full height
			tab.style.display = 'flex';
			tab.style.alignItems = 'center';
			tab.style.fontSize = '12px';
			tab.style.textTransform = 'uppercase';
			tab.style.fontWeight = this.currentTab === id ? '600' : '400';
			tab.style.borderTop = this.currentTab === id ? '2px solid var(--vscode-panelTitle-activeBorder)' : '2px solid transparent'; // Top border like standard tabs
			tab.style.borderBottom = 'none';
			tab.style.color = this.currentTab === id ? 'var(--vscode-editor-foreground)' : 'var(--vscode-descriptionForeground)'; // Safe foreground colors
			tab.style.backgroundColor = this.currentTab === id ? 'var(--vscode-editor-background)' : 'transparent';

			tab.onclick = () => {
				if (this.currentTab !== id) {
					this.currentTab = id;
					this.render();
				}
			};
			return tab;
		};

		this.tabBarContainer.appendChild(createTab('profile', 'User Profile'));
		this.tabBarContainer.appendChild(createTab('settings', 'Settings'));
	}

	private async renderProfileView() {
		this.profileContainer.innerHTML = ''; // Start fresh for profile view
		this.profileContainer.style.maxWidth = '600px';
		this.profileContainer.style.alignSelf = 'center';
		this.profileContainer.style.alignItems = 'center';

		// Trigger Sync
		this.authService.syncWithWebConsole().catch(e => console.error('Sync failed', e));

		// Logo
		const logo = document.createElement('img');
		logo.src = NEURAL_INVERSE_LOGO;
		logo.style.width = '100px';
		logo.style.marginBottom = '10px';
		logo.style.alignSelf = 'center';
		this.profileContainer.appendChild(logo);

		const profile = await this.userProfileService.getUserProfile();
		await this.authService.getUserProfile();


		const title = document.createElement('h1');
		title.textContent = `Welcome back, ${profile?.given_name || profile?.name || 'User'}!`;
		title.style.fontSize = '24px';
		title.style.fontWeight = '600';
		title.style.alignSelf = 'center';
		this.profileContainer.appendChild(title);


		// Manage Account Button
		const manageContainer = document.createElement('div');
		manageContainer.style.marginBottom = '20px';
		manageContainer.style.alignSelf = 'center';
		const manageButton = new Button(manageContainer, { ...defaultButtonStyles, secondary: true });
		manageButton.label = 'Manage in Web Console';
		manageButton.onDidClick(async () => {
			await this.openerService.open(URI.parse('http://localhost:3000/platform/settings'));
		});
		this.profileContainer.appendChild(manageContainer);


		const formContainer = document.createElement('div');
		formContainer.style.width = '100%';
		formContainer.style.maxWidth = '400px';
		formContainer.style.display = 'flex';
		formContainer.style.flexDirection = 'column';
		formContainer.style.gap = '15px';
		formContainer.style.alignSelf = 'center';
		this.profileContainer.appendChild(formContainer);

		// Helper to create input fields
		const createInputField = (label: string, value: string, placeholder: string, onChange: (val: string) => void) => {
			const wrapper = document.createElement('div');
			const labelEl = document.createElement('div');
			labelEl.textContent = label;
			labelEl.style.fontWeight = '600';
			labelEl.style.marginBottom = '5px';
			wrapper.appendChild(labelEl);

			const inputBox = new InputBox(wrapper, this.contextViewService, {
				placeholder: placeholder,
				inputBoxStyles: defaultInputBoxStyles
			});
			inputBox.value = value;
			this._register(inputBox.onDidChange(onChange));

			formContainer.appendChild(wrapper);
			return inputBox;
		};

		// Display Name (Nickname)
		createInputField('Display Name (Nickname)', profile?.nickname || '', 'Enter nickname', async (val) => {
			await this.userProfileService.updateUserProfile({ nickname: val });
		});

		// Full Name
		createInputField('Full Name', profile?.name || '', 'Enter full name', async (val) => {
			await this.userProfileService.updateUserProfile({ name: val });
		});

		// Email
		createInputField('Email', profile?.email || '', 'Enter email', async (val) => {
			await this.userProfileService.updateUserProfile({ email: val });
		});

		const logoutContainer = document.createElement('div');
		logoutContainer.style.marginTop = '30px';
		logoutContainer.style.alignSelf = 'center';

		const logoutButton = new Button(logoutContainer, { ...defaultButtonStyles, secondary: true });
		logoutButton.label = 'Log Out';
		logoutButton.onDidClick(async () => {
			await this.authService.logout();
		});

		this.profileContainer.appendChild(logoutContainer);
	}

	private async renderSettingsView() {
		if (this.settingsEditor) {
			return; // Already initialized
		}

		// Instantiate Settings Editor
		this.settingsEditor = this._register(this.instantiationService.createInstance(SettingsEditor2, this.group));
		this.settingsEditor.create(this.settingsContainer);

		this.settingsEditorInput = this._register(this.instantiationService.createInstance(SettingsEditor2Input));

		await this.settingsEditor.setInput(this.settingsEditorInput, undefined, undefined as any, new CancellationTokenSource().token);

		// Visibility will be handled by the render loop or setVisible override
		// SettingsEditor2 implementation checks isVisible() in layout.

		// Force initial layout
		const dim = this.getDimension();
		if (dim) {
			this.settingsEditor.layout(dim);
		}
	}

	private renderUnauthenticatedView() {
		this.profileContainer.innerHTML = ''; // Start fresh
		this.profileContainer.style.alignItems = 'center';

		// Logo
		const logo = document.createElement('img');
		logo.src = NEURAL_INVERSE_LOGO;
		logo.style.width = '150px';
		logo.style.marginBottom = '20px';
		this.profileContainer.appendChild(logo);

		const title = document.createElement('h1');
		title.textContent = 'Sign in to Neural Inverse';
		title.style.fontSize = '24px';
		title.style.fontWeight = '600';
		this.profileContainer.appendChild(title);

		const loginContainer = document.createElement('div');
		loginContainer.style.marginTop = '20px';

		const loginButton = new Button(loginContainer, defaultButtonStyles);
		loginButton.label = 'Login';
		loginButton.onDidClick(async () => {
			await this.authService.login();
		});

		this.profileContainer.appendChild(loginContainer);
	}

	override layout(dimension: import("../../../../base/browser/dom.js").Dimension): void {
		if (this.settingsEditor && this.currentTab === 'settings') {
			this.settingsEditor.layout(dimension);
		}
	}

	private getDimension(): Dimension | undefined {
		if (!this.rootElement) return undefined;
		return new Dimension(this.rootElement.clientWidth, this.rootElement.clientHeight);
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (this.settingsEditor && this.currentTab === 'settings') {
			this.settingsEditor.setVisible(visible);
		}
	}

	override setInput(input: NeuralInverseProfileEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		return super.setInput(input, options, context, token);
	}
}
