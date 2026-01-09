/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWebviewWorkbenchService } from '../../webviewPanel/browser/webviewWorkbenchService.js';
import { WebviewMessageReceivedEvent } from '../../webview/browser/webview.js';
import { INeuralInverseAuthService } from '../../../services/neuralInverseAuth/common/neuralInverseAuth.js';
import { INeuralInverseUserProfileService, IUserProfile } from '../common/neuralInverseUserProfile.js';
import './neuralInverseUserProfileService.js'; // Register Service

class OpenProfileAction extends Action2 {
	static readonly ID = 'neuralInverse.openProfile';
	static readonly TITLE = 'Neural Inverse: Open Profile';

	constructor() {
		super({
			id: OpenProfileAction.ID,
			title: { value: OpenProfileAction.TITLE, original: OpenProfileAction.TITLE },
			f1: true,
			category: { value: 'Neural Inverse', original: 'Neural Inverse' }
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const webviewWorkbenchService = accessor.get(IWebviewWorkbenchService);
		const authService = accessor.get(INeuralInverseAuthService);
		const userProfileService = accessor.get(INeuralInverseUserProfileService);

		const input = webviewWorkbenchService.openWebview(
			{
				providedViewType: 'neuralInverse.profile',
				title: 'Neural Inverse Profile',
				options: {
				},
				contentOptions: {
					allowScripts: true,
				},
				extension: undefined
			},
			'neuralInverse.profile',
			'Neural Inverse Profile',
			{ preserveFocus: false }
		);

		// Initial Render
		this.updateContent(input.webview, authService, userProfileService);

		// Handle messages from webview
		input.webview.onMessage((e: WebviewMessageReceivedEvent) => {
			const message = e.message;
			if (message.command === 'logout') {
				authService.logout();
			}
			if (message.command === 'login') {
				authService.login();
			}
			if (message.command === 'updateProfile') {
				userProfileService.updateUserProfile(message.data);
			}
		});

		// Listen for auth changes
		const authDisposable = authService.onDidChangeAuthStatus(() => {
			this.updateContent(input.webview, authService, userProfileService);
		});

		// Listen for profile changes
		const profileDisposable = userProfileService.onDidChangeUserProfile(() => {
			this.updateContent(input.webview, authService, userProfileService);
		});

		// Clean up listener when webview is closed
		input.webview.onDidDispose(() => {
			authDisposable.dispose();
			profileDisposable.dispose();
		});
	}

	private async updateContent(webview: any, authService: INeuralInverseAuthService, userProfileService: INeuralInverseUserProfileService): Promise<void> {
		const isAuthenticated = await authService.isAuthenticated();
		let profile: IUserProfile | undefined;

		if (isAuthenticated) {
			profile = await userProfileService.getUserProfile();
		}

		webview.setHtml(this.getHtmlContent(isAuthenticated, profile));
	}

	private getHtmlContent(isAuthenticated: boolean, profile?: IUserProfile): string {
		const styles = `
			body {
				font-family: var(--vscode-font-family);
				font-size: var(--vscode-font-size);
				color: var(--vscode-foreground);
				background-color: var(--vscode-editor-background);
				padding: 20px;
				margin: 0;
			}

			.form-container {
				max-width: 600px;
				margin: 0 auto;
			}

			h1 {
				font-size: 1.5em;
				font-weight: 500;
				margin-bottom: 20px;
				border-bottom: 1px solid var(--vscode-settings-headerBorder);
				padding-bottom: 10px;
			}

			.form-group {
				margin-bottom: 15px;
			}

			label {
				display: block;
				margin-bottom: 5px;
				font-weight: 600;
			}

			input[type="text"], input[type="email"] {
				width: 100%;
				padding: 6px;
				box-sizing: border-box;
				background-color: var(--vscode-input-background);
				color: var(--vscode-input-foreground);
				border: 1px solid var(--vscode-input-border);
				border-radius: 2px;
			}

			input:focus {
				outline: 1px solid var(--vscode-focusBorder);
				border-color: var(--vscode-focusBorder);
			}

			.button-group {
				margin-top: 25px;
				display: flex;
				gap: 10px;
			}

			button {
				background-color: var(--vscode-button-background);
				color: var(--vscode-button-foreground);
				border: none;
				padding: 6px 14px;
				cursor: pointer;
				border-radius: 2px;
			}

			button:hover {
				background-color: var(--vscode-button-hoverBackground);
			}

			button.secondary {
				background-color: var(--vscode-button-secondaryBackground);
				color: var(--vscode-button-secondaryForeground);
			}
			button.secondary:hover {
				background-color: var(--vscode-button-secondaryHoverBackground);
			}
		`;

		const script = `
			const vscode = acquireVsCodeApi();

			const inputs = document.querySelectorAll('input');
			inputs.forEach(input => {
				input.addEventListener('change', (e) => {
					const field = e.target.id;
					const value = e.target.value;
					vscode.postMessage({
						command: 'updateProfile',
						data: { [field]: value }
					});
				});
			});

			function login() {
				vscode.postMessage({ command: 'login' });
			}
			function logout() {
				vscode.postMessage({ command: 'logout' });
			}
		`;

		let content = '';

		if (isAuthenticated) {
			const safeProfile = profile || {} as any;
			content = `
				<div class="form-container">
					<h1>User Profile</h1>

					<div class="form-group">
						<label for="nickname">Display Name (Nickname)</label>
						<input type="text" id="nickname" value="${safeProfile.nickname || ''}" placeholder="Enter a display name">
					</div>

					<div class="form-group">
						<label for="name">Full Name</label>
						<input type="text" id="name" value="${safeProfile.name || ''}" disabled title="Managed by Identity Provider">
					</div>

					<div class="form-group">
						<label for="email">Email</label>
						<input type="email" id="email" value="${safeProfile.email || ''}" disabled title="Managed by Identity Provider">
					</div>

					<div class="button-group">
						<button class="secondary" onclick="logout()">Sign Out</button>
					</div>
				</div>
			`;
		} else {
			content = `
				<div class="form-container">
					<h1>User Profile</h1>
					<p>You are not currently signed in.</p>
					<div class="button-group">
						<button onclick="login()">Sign In to Neural Inverse</button>
					</div>
				</div>
			`;
		}

		const csp = `<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;">`;

		return `
			<!DOCTYPE html>
			<html lang="en">
			<head>
				${csp}
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<style>${styles}</style>
			</head>
			<body>
				${content}
				<script>${script}</script>
			</body>
			</html>
		`;
	}
}

registerAction2(OpenProfileAction);
