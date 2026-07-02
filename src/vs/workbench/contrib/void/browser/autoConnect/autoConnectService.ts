/*--------------------------------------------------------------------------------------
 *  Copyright 2026 Neural Inverse Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IVoidSettingsService } from '../../common/voidSettingsService.js';
import { ProviderName, SettingName, displayInfoOfProviderName } from '../../common/voidSettingsTypes.js';
import { IDetectedCredential, AUTO_CONNECT_STORAGE_KEY } from './autoConnectTypes.js';
import { detectAllCredentials } from './envVarDetector.js';
import { IExternalCommandExecutor } from '../externalCommandExecutor.js';
import { isWindows } from '../../../../../base/common/platform.js';


export interface IAutoConnectService {
	readonly _serviceBrand: undefined;
	detectCredentials(): Promise<IDetectedCredential[]>;
	applyCredentials(credentials: IDetectedCredential[]): Promise<void>;
	applyOne(credential: IDetectedCredential): Promise<void>;
	dismissProvider(providerName: ProviderName): void;
	setNeverAskAgain(): void;
	readonly detectedCredentials: IDetectedCredential[];
	readonly onDidDetectCredentials: Event<IDetectedCredential[]>;
}

export const IAutoConnectService = createDecorator<IAutoConnectService>('autoConnectService');

interface PersistedState {
	appliedProviders: string[];
	dismissedProviders: string[];
	neverAskAgain: boolean;
}

export class AutoConnectService extends Disposable implements IAutoConnectService {
	readonly _serviceBrand: undefined;

	private _detectedCredentials: IDetectedCredential[] = [];
	private _appliedProviders = new Set<ProviderName>();
	private _dismissedProviders = new Set<ProviderName>();
	private _neverAskAgain = false;

	private readonly _onDidDetectCredentials = this._register(new Emitter<IDetectedCredential[]>());
	readonly onDidDetectCredentials: Event<IDetectedCredential[]> = this._onDidDetectCredentials.event;

	get detectedCredentials(): IDetectedCredential[] {
		return this._detectedCredentials;
	}

	constructor(
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@IStorageService private readonly _storageService: IStorageService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IFileService private readonly _fileService: IFileService,
		@IExternalCommandExecutor private readonly _commandExecutor: IExternalCommandExecutor,
	) {
		super();
		this._loadPersistedState();
		this._runDetection();
	}

	private _loadPersistedState(): void {
		const raw = this._storageService.get(AUTO_CONNECT_STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) return;
		try {
			const state: PersistedState = JSON.parse(raw);
			this._appliedProviders = new Set(state.appliedProviders as ProviderName[]);
			this._dismissedProviders = new Set(state.dismissedProviders as ProviderName[]);
			this._neverAskAgain = state.neverAskAgain ?? false;
		} catch {
			// corrupted state, start fresh
		}
	}

	private _persistState(): void {
		const state: PersistedState = {
			appliedProviders: [...this._appliedProviders],
			dismissedProviders: [...this._dismissedProviders],
			neverAskAgain: this._neverAskAgain,
		};
		this._storageService.store(AUTO_CONNECT_STORAGE_KEY, JSON.stringify(state), StorageScope.APPLICATION, StorageTarget.USER);
	}

	private _runDetection(): void {
		if (this._neverAskAgain) return;

		Promise.all([
			this._resolveGhToken(),
			this._resolveAzToken(),
			this._resolveAzEndpoint(),
		]).then(([ghToken, azToken, azEndpoint]) => {
			return detectAllCredentials(this._fileService, ghToken, azToken, azEndpoint, this._commandExecutor.execute.bind(this._commandExecutor));
		}).then(all => {
			console.log('[autoConnect] _runDetection: raw credential count:', all.length, all.map(c => `${c.providerName}/${c.source}`).join(', ') || '(none)');
			const newCredentials = all.filter(c =>
				!this._appliedProviders.has(c.providerName) &&
				!this._dismissedProviders.has(c.providerName)
			);
			console.log('[autoConnect] _runDetection: after applied/dismissed filter:', newCredentials.length, 'applied:', [...this._appliedProviders].join(',') || '(none)', 'dismissed:', [...this._dismissedProviders].join(',') || '(none)');

			if (newCredentials.length === 0) return;

			this._detectedCredentials = newCredentials;
			this._onDidDetectCredentials.fire(newCredentials);
			this._showNotification(newCredentials);
		});
	}

	private _showNotification(credentials: IDetectedCredential[]): void {
		const names = credentials.map(c => displayInfoOfProviderName(c.providerName).title);
		const message = names.length === 1
			? `Detected credentials for ${names[0]}. Auto-configure?`
			: `Detected credentials for ${names.join(', ')}. Auto-configure?`;

		this._notificationService.prompt(
			Severity.Info,
			message,
			[
				{
					label: 'Auto-configure',
					run: () => { this.applyCredentials(credentials); }
				},
				{
					label: 'Dismiss',
					run: () => {
						for (const c of credentials) {
							this._dismissedProviders.add(c.providerName);
						}
						this._persistState();
					}
				},
				{
					label: "Don't ask again",
					run: () => { this.setNeverAskAgain(); }
				},
			],
		);
	}

	async detectCredentials(): Promise<IDetectedCredential[]> {
		const [ghToken, azToken, azEndpoint] = await Promise.all([
			this._resolveGhToken(),
			this._resolveAzToken(),
			this._resolveAzEndpoint(),
		]);
		const all = await detectAllCredentials(this._fileService, ghToken, azToken, azEndpoint, this._commandExecutor.execute.bind(this._commandExecutor));
		console.log('[autoConnect] detectCredentials: total:', all.length, all.map(c => `${c.providerName}/${c.source}`).join(', ') || '(none)');
		this._detectedCredentials = all;
		this._onDidDetectCredentials.fire(all);
		return all;
	}

	private async _resolveGhToken(): Promise<string | undefined> {
		// On Windows the terminal executor inherits a Git Bash environment whose
		// PATH does not include "C:\Program Files\GitHub CLI". Invoke gh.exe by
		// its known full path via PowerShell, bypassing PATH entirely.
		// Standard MSI installer puts gh.exe in "C:\Program Files\GitHub CLI\".
		const command = isWindows
			? `powershell.exe -NoProfile -Command "& 'C:\\Program Files\\GitHub CLI\\gh.exe' auth token"`
			: 'gh auth token';
		try {
			const output = await this._commandExecutor.execute('gh-token', command, 8000, 1024);
			// Parse line-by-line: terminal output can include shell integration
			// markers, prompt echoes, or blank lines alongside the token.
			const token = output
				.split(/\r?\n/)
				.map(l => l.trim())
				.find(l => l.startsWith('gh') && !l.includes(' '));
			console.log('[autoConnect] _resolveGhToken: success:', !!token, 'token length:', token?.length ?? 0);
			return token || undefined;
		} catch (err) {
			console.log('[autoConnect] _resolveGhToken: failed:', String(err));
		}
		return undefined;
	}

	private async _resolveAzToken(): Promise<string | undefined> {
		// Shell out to `az account get-access-token` to obtain a Cognitive Services bearer token.
		// Gracefully returns undefined if az is not installed, not logged in, or the command fails.
		const command = isWindows
			? `powershell.exe -NoProfile -Command "az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken --output tsv"`
			: 'az account get-access-token --resource https://cognitiveservices.azure.com --query accessToken --output tsv';
		try {
			const output = await this._commandExecutor.execute('az-token', command, 10000, 4096);
			const token = output.trim().split(/\r?\n/).map(l => l.trim()).find(l => l.length > 10 && !l.toLowerCase().startsWith('error') && !l.toLowerCase().startsWith('warning'));
			console.log('[autoConnect] _resolveAzToken: success:', !!token, 'length:', token?.length ?? 0);
			return token || undefined;
		} catch (err) {
			console.log('[autoConnect] _resolveAzToken: failed (az not installed or not logged in):', String(err));
			return undefined;
		}
	}

	private async _resolveAzEndpoint(): Promise<string | undefined> {
		// Shell out to `az cognitiveservices account list` (JSON) and extract the first
		// Azure OpenAI (kind == "OpenAI") endpoint. Returns undefined if none found or
		// if the command fails for any reason — this is detection-only, no resources are created.
		const command = isWindows
			? `powershell.exe -NoProfile -Command "az cognitiveservices account list --output json"`
			: 'az cognitiveservices account list --output json';
		try {
			const output = await this._commandExecutor.execute('az-endpoint', command, 15000, 65536);
			const trimmed = output.trim();
			if (!trimmed || trimmed.startsWith('ERROR') || trimmed.startsWith('WARNING')) return undefined;
			const accounts: any[] = JSON.parse(trimmed);
			if (!Array.isArray(accounts)) return undefined;
			// Prefer kind == "OpenAI"; fall back to first account with an endpoint
			const openAiAccount = accounts.find(a => a.kind === 'OpenAI' && a.properties?.endpoint)
				?? accounts.find(a => a.properties?.endpoint);
			const endpoint: string | undefined = openAiAccount?.properties?.endpoint;
			console.log('[autoConnect] _resolveAzEndpoint: found:', endpoint || '(none)');
			return endpoint && endpoint.startsWith('https://') ? endpoint : undefined;
		} catch (err) {
			console.log('[autoConnect] _resolveAzEndpoint: failed (no subscription, no resources, or parse error):', String(err));
			return undefined;
		}
	}

	async applyCredentials(credentials: IDetectedCredential[]): Promise<void> {
		for (const credential of credentials) {
			await this.applyOne(credential);
		}
	}

	async applyOne(credential: IDetectedCredential): Promise<void> {
		const { providerName, settings } = credential;

		for (const [key, value] of Object.entries(settings)) {
			await this._settingsService.setSettingOfProvider(
				providerName,
				key as SettingName,
				value as any,
			);
		}

		this._appliedProviders.add(providerName);
		this._persistState();
	}

	dismissProvider(providerName: ProviderName): void {
		this._dismissedProviders.add(providerName);
		this._persistState();
	}

	setNeverAskAgain(): void {
		this._neverAskAgain = true;
		this._persistState();
	}
}

registerSingleton(IAutoConnectService, AutoConnectService, InstantiationType.Eager);
