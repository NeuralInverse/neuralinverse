/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { INeuralInverseAuthService } from '../common/neuralInverseAuth.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IURLHandler, IURLService } from '../../../../platform/url/common/url.js';
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { OS, OperatingSystem } from '../../../../base/common/platform.js';

import { AGENT_API_URL } from '../../../contrib/void/common/neuralInverseConfig.js';

const CLIENT_ID = 'pONurKdBbWsHvQ3aMnmlUzYgjYafVPQq';
const DOMAIN = 'auth.neuralinverse.com';
const REDIRECT_URI = 'neuralinverse://neural-inverse/callback';
const TOKEN_KEY = 'neural_inverse_auth_token';

// ARCH-001: All IDE→backend calls go through the central config URL.
const API_BASE_URL = AGENT_API_URL;


export class NeuralInverseAuthService extends Disposable implements INeuralInverseAuthService, IURLHandler {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeAuthStatus = this._register(new Emitter<boolean>());
	readonly onDidChangeAuthStatus = this._onDidChangeAuthStatus.event;

	private _isAuthenticated = false;
	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@ILogService private readonly logService: ILogService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IURLService urlService: IURLService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
		@IProductService private readonly productService: IProductService
	) {
		super();
		this._register(urlService.registerHandler(this));
		this.initialize();
	}

	async handleURL(uri: URI): Promise<boolean> {
		// Log the URI for debugging (in case of further issues)
		console.log('NeuralInverseAuth: handleURL called', uri.toString());
		console.log('NeuralInverseAuth: scheme', uri.scheme);
		console.log('NeuralInverseAuth: authority', uri.authority);
		console.log('NeuralInverseAuth: path', uri.path);

		// Check for matching authority/path
		// "neuralinverse://neural-inverse/callback" -> authority="neural-inverse", path="/callback"
		if ((uri.authority === 'neural-inverse' && uri.path === '/callback') ||
			uri.path === '/neural-inverse/callback' // Fallback for some URI parsers
		) {
			console.log('NeuralInverseAuth: URL matched! Handling callback...');
			await this.handleCallback(uri);
			return true;
		}
		return false;
	}

	private _syncInterval: any;

	private async initialize(): Promise<void> {
		const token = await this.secretStorageService.get(TOKEN_KEY);
		if (token) {
			this._isAuthenticated = true;
			this._onDidChangeAuthStatus.fire(true);
			this.startPeriodicSync();
		}
	}

	private startPeriodicSync(): void {
		// Sync immediately
		this.syncWithWebConsole();

		// Clear existing if any
		if (this._syncInterval) {
			clearInterval(this._syncInterval);
		}

		// Sync every 30 seconds to check for blocks/revocations
		this._syncInterval = setInterval(() => {
			if (this._isAuthenticated) {
				this.syncWithWebConsole();
			} else {
				clearInterval(this._syncInterval);
			}
		}, 30000);
	}



	async isAuthenticated(): Promise<boolean> {
		if (this._isAuthenticated) return true;
		const token = await this.secretStorageService.get(TOKEN_KEY);
		return !!token;
	}

	async getToken(): Promise<string | undefined> {
		return this.secretStorageService.get(TOKEN_KEY);
	}



	async login(): Promise<void> {
		const verifier = this.generateCodeVerifier();
		const challenge = await this.generateCodeChallenge(verifier);

		// Store verifier for the callback
		this.storageService.store('neural_inverse_verifier', verifier, StorageScope.APPLICATION, StorageTarget.MACHINE);

		const authUrl = `https://${DOMAIN}/authorize?` +
			`response_type=code` +
			`&client_id=${CLIENT_ID}` +
			`&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
			`&code_challenge=${challenge}` +
			`&code_challenge_method=S256` +
			`&audience=${encodeURIComponent('https://neuralinverse.us.auth0.com/api/v2/')}` +
			`&scope=${encodeURIComponent('openid profile email')}`;

		await this.openerService.open(URI.parse(authUrl));
	}

	async handleCallback(uri: URI): Promise<void> {
		const query = new URLSearchParams(uri.query);

		// Debug logging to see what Auth0 returned
		console.log('NeuralInverseAuth: Callback query params:', uri.query);

		const error = query.get('error');
		const errorDescription = query.get('error_description');

		if (error) {
			this.logService.error(`NeuralInverseAuth: Auth0 Error: ${error} - ${errorDescription}`);
			return;
		}

		const code = query.get('code');
		if (!code) {
			this.logService.error('NeuralInverseAuth: No code in callback. Query: ' + uri.query);
			return;
		}

		const verifier = this.storageService.get('neural_inverse_verifier', StorageScope.APPLICATION);
		if (!verifier) {
			this.logService.error('NeuralInverseAuth: No verifier found');
			return;
		}

		try {
			const body = new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: CLIENT_ID,
				code_verifier: verifier,
				code: code,
				redirect_uri: REDIRECT_URI
			});

			const response = await this.nativeHostService.request(
				`https://${DOMAIN}/oauth/token`,
				{
					type: 'POST',
					headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
					data: body.toString()
				}
			);

			if (response.statusCode >= 400) {
				throw new Error(`Auth failed: ${response.statusCode}`);
			}

			const data = JSON.parse(response.body);
			if (!data) {
				throw new Error('Auth failed: No data received');
			}
			const accessToken = data.access_token;

			if (accessToken) {
				await this.secretStorageService.set(TOKEN_KEY, accessToken);
				this._isAuthenticated = true;



				this._onDidChangeAuthStatus.fire(true);
				this.syncWithWebConsole();

				// Clear verifier
				this.storageService.remove('neural_inverse_verifier', StorageScope.APPLICATION);
			}
		} catch (e) {
			this.logService.error('NeuralInverseAuth: Token exchange failed', e);
			throw e;
		}
	}

	async logout(): Promise<void> {
		// Sync as inactive before deleting token
		await this.syncWithWebConsole(false);

		await this.secretStorageService.delete(TOKEN_KEY);
		this._isAuthenticated = false;

		this._onDidChangeAuthStatus.fire(false);

		// Optional: Open logout URL
		const logoutUrl = `https://${DOMAIN}/v2/logout?client_id=${CLIENT_ID}&returnTo=${encodeURIComponent('https://neuralinverse.com')}`;
		await this.openerService.open(URI.parse(logoutUrl));
	}

	// PKCE Helpers

	private generateCodeVerifier(): string {
		const array = new Uint8Array(32);
		crypto.getRandomValues(array);
		return this.base64UrlEncode(array);
	}

	private async generateCodeChallenge(verifier: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(verifier);
		const hash = await crypto.subtle.digest('SHA-256', data);
		return this.base64UrlEncode(new Uint8Array(hash));
	}

	private base64UrlEncode(array: Uint8Array): string {
		let str = '';
		for (let i = 0; i < array.length; i++) {
			str += String.fromCharCode(array[i]);
		}
		return btoa(str)
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	}

	async getUserProfile(): Promise<any | undefined> {
		const token = await this.getToken();
		if (!token) return undefined;

		try {
			// In a real implementation, you might want to use a fetch polyfill or the nativeHostService if available
			// For this VS Code environment, we can use the native fetch if Node environment supports it,
			// or use the request service. Assuming standard fetch is available in this context (recent Electron/Node)
			// or using nativeHostService.request which seems to be a custom wrapper.

			const response = await this.nativeHostService.request(
				`${API_BASE_URL}/ide/profile`,
				{
					type: 'GET',
					headers: {
						'Authorization': `Bearer ${token}`,
						'Content-Type': 'application/json'
					}
				}
			);

			if (response.statusCode >= 400) {
				this.logService.error(`NeuralInverseAuth: Failed to get profile: ${response.statusCode}`);
				return undefined;
			}

			return JSON.parse(response.body);
		} catch (e) {
			this.logService.error('NeuralInverseAuth: Error fetching profile', e);
			return undefined;
		}
	}

	private getMachineId(): string {
		const MACHINE_ID_KEY = 'neural_inverse_machine_id';
		let machineId = this.storageService.get(MACHINE_ID_KEY, StorageScope.APPLICATION);
		if (!machineId) {
			machineId = 'dev-machine-id-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
			this.storageService.store(MACHINE_ID_KEY, machineId, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		return machineId;
	}

	async syncWithWebConsole(isActive: boolean = true): Promise<void> {
		this.logService.info('NeuralInverseAuth: syncWithWebConsole logic started, active=' + isActive);
		const token = await this.getToken();
		if (!token) {
			this.logService.info('NeuralInverseAuth: Aborting sync - No access token');
			return;
		}

		try {
			// Gather device info
			const machineId = this.getMachineId();

			let osLabel = 'Unknown';
			if (OS === OperatingSystem.Macintosh) osLabel = 'macOS';
			else if (OS === OperatingSystem.Windows) osLabel = 'Windows';
			else if (OS === OperatingSystem.Linux) osLabel = 'Linux';

			const deviceInfo = {
				machineId: machineId,
				deviceName: `${this.productService.nameShort} on ${osLabel}`,
				version: this.productService.version,
				os: osLabel,
				lastActive: new Date().toISOString(),
				isActive: isActive
			};

			this.logService.info('NeuralInverseAuth: Sending sync request to ' + `${API_BASE_URL}/ide/register`);

			const response = await this.nativeHostService.request(
				`${API_BASE_URL}/ide/register`,
				{
					type: 'POST',
					headers: {
						'Authorization': `Bearer ${token}`,
						'Content-Type': 'application/json'
					},
					data: JSON.stringify(deviceInfo)
				}
			);

			this.logService.info(`NeuralInverseAuth: Sync response status ${response.statusCode}`);


			if (response.statusCode === 403) {
				this.logService.warn(`NeuralInverseAuth: Device Revoked/Blocked (403). Logging out.`);
				this.logout();
			} else if (response.statusCode >= 400) {
				this.logService.error(`NeuralInverseAuth: Failed to sync: ${response.statusCode}`);
				this.logService.error(`NeuralInverseAuth: Response body: ${response.body}`);
			} else {
				this.logService.info('NeuralInverseAuth: Synced with Web Console successfully');
			}

		} catch (e) {
			this.logService.error('NeuralInverseAuth: Error syncing', e);
		}
	}
}

// Registration handled by neuralInverseAuth.contribution.ts (Eager)
